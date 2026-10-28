// The read tools every bot gets over the shared vault. Shared by the built-in tool loop,
// the per-bot MCP endpoint and bin/vault-mcp.mjs, so all of them answer the same way.

import path from "node:path";
import { noteSlug } from "./slug.js";

const objectSchema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });

export function vaultToolDefinitions() {
  return [
    {
      name: "vault_search",
      description: "Search the shared vault, the notes every bot reads: projects, agents, rules, decisions, the daily log. Returns matching passages with the note path and date.",
      parameters: objectSchema({
        query: { type: "string" },
        limit: { type: "number", description: "Maximum hits, 1-20. Defaults to 8." },
      }, ["query"]),
    },
    {
      name: "vault_read",
      description: "Read one whole vault note with its date and its links. Accepts a path such as Projects/Website.md or a note name such as Website.",
      parameters: objectSchema({ note: { type: "string" } }, ["note"]),
    },
    {
      name: "vault_links",
      description: "List the notes a vault note links to and the notes that link to it.",
      parameters: objectSchema({ note: { type: "string" } }, ["note"]),
    },
  ];
}

export function vaultWriteToolDefinitions() {
  return [
    {
      name: "vault_append",
      description: "Add one line to your own note in the shared vault (Agents/<your name>.md, under Learned). Use it for lessons about your own job. It cannot write anywhere else. Secrets are refused.",
      parameters: objectSchema({ text: { type: "string", maxLength: 2000 } }, ["text"]),
    },
    {
      name: "log_decision",
      description: "Add one line to the shared decision log (Decisions-Log.md) with today's date and your name. Use it when a decision was made that other bots or the user should find later. Secrets are refused.",
      parameters: objectSchema({ text: { type: "string", maxLength: 500 } }, ["text"]),
    },
    {
      name: "log_activity",
      description: "Add one line to today's activity log in the shared vault (one note per day): what you did and how it went. Secrets are refused.",
      parameters: objectSchema({
        action: { type: "string", maxLength: 200, description: "What was done, in a few words." },
        status: { type: "string", maxLength: 200, description: "For example ok, failed, skipped." },
        link: { type: "string", maxLength: 200, description: "Optional link to a result." },
        who: { type: "string", maxLength: 200, description: "Optional. Defaults to your name." },
      }, ["action", "status"]),
    },
    {
      name: "remember",
      description: "Save a durable fact about the user to their profile note in the shared vault, seen by every bot. When two facts share a key, the newest wins and the old one moves to the history. Secrets are refused.",
      parameters: objectSchema({
        fact: { type: "string", maxLength: 300 },
        type: { type: "string", enum: ["preference", "fact", "contact", "routine", "goal", "other"] },
        key: { type: "string", maxLength: 40, description: "Optional short id such as timezone or favourite-editor (lowercase letters, digits, hyphens)." },
      }, ["fact"]),
    },
    {
      name: "propose_change",
      description: "Ask the user to approve a change to Rules.md or a note in Projects/. Nothing is written until they approve. Give the note, the text, why, and optionally a section heading to replace (otherwise the text is appended). Secrets are refused.",
      parameters: objectSchema({
        note: { type: "string", description: "Rules, or a project name or path such as Projects/Website.md." },
        text: { type: "string", maxLength: 4000 },
        why: { type: "string", maxLength: 400 },
        section: { type: "string", maxLength: 100 },
      }, ["note", "text", "why"]),
    },
  ];
}

const HIDDEN = new Set([...vaultToolDefinitions(), ...vaultWriteToolDefinitions()].map((tool) => tool.name).filter((name) => name !== "remember"));
const WRITE_NAMES = new Set(vaultWriteToolDefinitions().map((tool) => tool.name));

export function selectMemoryTools(defs, { vaultOn, writeOn }) {
  let out = defs.filter((tool) => !HIDDEN.has(tool.name));
  if (vaultOn) {
    out = out.filter((tool) => !tool.name.startsWith("memory_"));
    if (writeOn) out = out.filter((tool) => tool.name !== "remember");
    out.push(...vaultToolDefinitions(), ...(writeOn ? vaultWriteToolDefinitions() : []));
  }
  const seen = new Set();
  return out.filter((tool) => !seen.has(tool.name) && seen.add(tool.name));
}

async function callWriteTool(name, args, writer, bot) {
  if (!writer?.available || !bot) return { text: "Vault writing is not enabled on this server." };
  let result;
  if (name === "vault_append") result = await writer.appendOwnNote(bot, args.text);
  else if (name === "log_decision") result = await writer.logDecision(bot, args.text);
  else if (name === "log_activity") result = await writer.logActivity(bot, { who: args.who, action: args.action, status: args.status, link: args.link });
  else if (name === "remember") result = await writer.remember(bot, { fact: args.fact, type: args.type || "fact", key: args.key || "" });
  else result = await writer.proposeChange(bot, { note: args.note, text: args.text, why: args.why, section: args.section });
  if (!result.ok) return { text: result.error, error: true };
  if (name === "propose_change") return { text: `Sent to ${writer.describe?.().owner || "the user"} for approval (proposal ${result.proposalId}).`, activity: "Proposing a vault change" };
  if (result.unchanged) return { text: `Already in ${result.path}; nothing changed.`, activity: `Checking ${result.path}` };
  return { text: `Saved to ${result.path} (commit ${result.commit}). It reaches GitHub within a couple of minutes.`, activity: `Writing ${result.path}` };
}

export async function callVaultTool(name, args, { vault, writer = null, bot = null } = {}) {
  if (WRITE_NAMES.has(name)) return callWriteTool(name, args || {}, writer, bot);
  if (!vault?.available) return { text: "The shared vault is not configured on this server." };
  const note = String(args.note || "");
  if (name === "vault_search") {
    const hits = await vault.search(String(args.query || ""), { limit: Math.min(20, Math.max(1, Number(args.limit) || 8)) });
    const text = hits.map((hit) => `- ${hit.path}${hit.heading ? ` > ${hit.heading}` : ""} (updated ${dayOf(hit.date)}): ${hit.snippet}`).join("\n");
    return { text: text || "No vault notes match. Try other words, or the words a note in another language would use.", activity: "Searching the vault" };
  }
  if (name === "vault_read") {
    const found = vault.read(note);
    if (!found) return { text: missText(vault, note) };
    const links = found.links.length ? `\n\nLinks to: ${found.links.join(", ")}` : "";
    const backlinks = found.backlinks.length ? `\nLinked from: ${found.backlinks.join(", ")}` : "";
    return { text: `${found.path} (updated ${dayOf(found.date)})${found.truncated ? ", truncated" : ""}\n\n${found.body}${links}${backlinks}`, activity: `Reading ${found.path}` };
  }
  if (name === "vault_links") {
    const found = vault.links(note);
    if (!found) return { text: missText(vault, note) };
    return {
      text: [found.path, `Links to: ${found.links.join(", ") || "nothing"}`, `Linked from: ${found.backlinks.join(", ") || "nothing"}`, found.unresolved.length ? `Missing notes: ${found.unresolved.join(", ")}` : ""].filter(Boolean).join("\n"),
      activity: "Following vault links",
    };
  }
  return { text: `Unknown vault tool ${name}.`, error: true };
}

// A miss names the closest notes, so the agent does not spend searches guessing the spelling.
function missText(vault, note) {
  const close = closeNotes(vault, note);
  return `No vault note matches "${note}".${close.length ? ` Close names: ${close.join(", ")}.` : ""} Use vault_search to find it.`;
}

export function closeNotes(vault, note) {
  const text = String(note || "");
  const folder = text.includes("/") ? text.slice(0, text.lastIndexOf("/") + 1) : "";
  const asked = noteSlug(path.posix.basename(text)).split("-").filter((token) => token.length >= 3);
  let candidates = [];
  try {
    candidates = (vault.notes?.(folder) || []).map((row) => row.path);
    if (!candidates.length && folder) candidates = (vault.notes?.("") || []).map((row) => row.path);
  } catch {
    return [];
  }
  const scored = candidates
    .map((item) => {
      const slug = noteSlug(path.posix.basename(item));
      return { path: item, score: asked.filter((token) => slug.includes(token)).length };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 5)
    .map((row) => row.path);
  if (scored.length || !folder) return scored;
  return candidates.filter((item) => item.startsWith(folder)).slice(0, 12);
}

function dayOf(date) {
  return String(date || "").slice(0, 10) || "unknown date";
}
