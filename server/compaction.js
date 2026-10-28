import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { memoryRead, memoryWrite } from "./aiMemory.js";
import { complete } from "./providers/openai.js";
import { runOpenCodeTurn } from "./providers/opencode.js";
import { redactSecrets } from "./redact.js";
import { botHome, readConversation, writeConversation } from "./state.js";

export const COMPACT_THRESHOLD_CHARS = 60_000;
export const COMPACT_KEEP_MESSAGES = 14;
export const SUMMARY_MAX_CHARS = 16_000;
export const VERBATIM_BUDGET = 12_000;
export const FALLBACK_VERBATIM_BUDGET = 8_000;
export const MAX_DURABLE_FACTS = 12;
export const SUMMARY_FOOTER = "Earlier messages are archived. Use search_history and read_history to get exact wording.";

const COMPACT_TIMEOUT_MS = 120_000;
const FACT_FLUSH_MS = 25_000;
const TRANSCRIPT_MAX_CHARS = 140_000;
const KEPT_TITLE = "Identifiers (kept by code)";
const VERBATIM_TITLE = "Recent user messages (verbatim)";
const ASSISTANT_TITLE = "Last assistant replies";
const FACTS_TITLE = "Durable facts";
const FALLBACK_NOTE = "Older conversation, compressed without a model (the summarizer was unavailable).";
const KEPT_MAX_CHARS = 5_000;
const KEPT_CAPS = { file: 60, url: 40, command: 20, id: 40, handle: 20, ticket: 30 };
const KEPT_ORDER = ["file", "url", "command", "id", "handle", "ticket"];

const COMPACT_SYSTEM = `You maintain the rolling memory of a long conversation between a user and a persistent bot. The bot reads your brief instead of the old messages, so anything you leave out is lost to it. Write plain, concrete English.

Reply in markdown with exactly these headings, in this order:
### Goal and context
### User preferences and constraints
### Decisions
### Done
### Pending and open questions
### Current state
### Identifiers (paths, URLs, ids, names)
### Lookup hints (keywords to search old history)
### Durable facts

Rules:
- If a previous summary is given, update it. Carry unchanged items forward word for word. Change only what the new messages change: move finished items to Done, close answered questions, correct anything that turned out wrong. Never drop an identifier.
- Do not copy the sections titled "${KEPT_TITLE}", "${VERBATIM_TITLE}" or "${ASSISTANT_TITLE}"; code maintains them. If the previous summary's recent messages are given separately in <previous_recent>, those old quotes are about to be replaced: fold any fact, decision or open question that appears only there into your own sections, but do not quote them.
- Never invent anything. Use only the previous summary and the new messages.
- Keep exact file paths, URLs, commands, ids, names, numbers, dates, deadlines, and error messages. Record what failed and why.
- Tool outputs were archived. A line like "tool name: output archived (id ...)" means the output exists but is not shown. Do not guess what it said.
- If the brief grows past about 1,500 words, shorten the oldest Done items to one line each. Never drop identifiers or open questions.
- Lookup hints: 5 to 15 keywords or short phrases someone could search to find the exact wording of old messages.
- ${FACTS_TITLE}: at most ${MAX_DURABLE_FACTS} one-line facts from the new messages worth keeping forever (decisions, preferences, procedures, gotchas), each written as "- fact: ...", "- decision: ...", "- rule: ..." or "- gotcha: ...". Write "- none" if there are none.
- Skip greetings and repetition. Output only the brief.`;

export function conversationSize(conversation) {
  let size = 0;
  for (const message of conversation || []) {
    if (message.kind === "ack") continue;
    size += String(message.content || "").length + 240;
    if (Array.isArray(message.toolCalls)) size += JSON.stringify(message.toolCalls).length;
  }
  return size;
}

export function shouldCompact(conversation, threshold = COMPACT_THRESHOLD_CHARS) {
  return (conversation || []).length > 24 && conversationSize(conversation) > threshold;
}

export function safeKeepIndex(messages, keep) {
  let start = Math.max(0, messages.length - keep);
  if (messages[start]?.role === "tool") {
    while (start > 0 && messages[start].role !== "assistant") start -= 1;
  }
  while (start < messages.length && messages[start].role === "tool") start += 1;
  return start;
}

// summarizer({ bot, system, prompt, directory, signal, waitForDecision }) -> string
// memoryClient is { read, write } shaped like aiMemory.js; aiMemory is the detectAiMemory() info.
export async function compactConversation({
  bot,
  providerBot = bot,
  home,
  directory,
  emit,
  signal,
  waitForDecision,
  saveState,
  force = false,
  threshold = COMPACT_THRESHOLD_CHARS,
  keep = COMPACT_KEEP_MESSAGES,
  summarizer = defaultSummarizer,
  aiMemory = null,
  memoryClient = { read: memoryRead, write: memoryWrite },
  timeoutMs = COMPACT_TIMEOUT_MS,
}) {
  let conversation = readConversation(home, bot);
  if (!force && !shouldCompact(conversation, threshold)) {
    return { compacted: false, removed: 0, kept: conversation.length };
  }
  // Ids are assigned and saved before any await, so nothing can interleave.
  if (conversation.some((message) => !message.id)) {
    conversation = conversation.map((message) => (message.id ? message : { ...message, id: cryptoId() }));
    writeConversation(home, bot, conversation);
  }
  const start = safeKeepIndex(conversation, keep);
  if (start < 2) return { compacted: false, removed: 0, kept: conversation.length };
  const older = conversation.slice(0, start);
  const olderIds = new Set(older.map((message) => message.id));

  const previousIndex = lastSummaryIndex(older);
  const previous = previousIndex >= 0 ? older[previousIndex] : null;
  const newer = older.slice(previousIndex + 1).filter((message) => message.kind !== "ack" && message.kind !== "summary");
  if (!newer.length) return { compacted: false, removed: 0, kept: conversation.length };

  const previousBody = previous ? unwrapSummary(previous.content) : "";
  const previousRecent = previous ? recentSections(previous.content) : "";
  const built = collectBuilt(newer);
  const prompt = buildPrompt({ previousBody, previousRecent, transcript: buildTranscript(newer), built });

  let reply = "";
  try {
    reply = await runWithTimeout((innerSignal) => summarizer({
      bot: providerBot,
      system: COMPACT_SYSTEM,
      prompt,
      directory,
      signal: innerSignal,
      waitForDecision,
    }), timeoutMs, signal);
  } catch {
    reply = "";
  }
  const parsed = parseDurableFacts(cleanReply(reply));
  const usedModel = Boolean(parsed.body.trim());
  const body = usedModel ? parsed.body.trim() : fallbackBody(previousBody);

  // Pre-compaction memory flush: facts are saved before the old messages leave the thread.
  const facts = await flushDurableFacts({ bot, facts: parsed.facts, aiMemory, memoryClient }).catch(() => ({ saved: 0, local: 0, skipped: 0 }));

  const kept = auditIdentifiers(body, mergeCandidates(identifierCandidates(previousBody), builtCandidates(built)));
  const verbatim = verbatimEntries(newer, usedModel ? VERBATIM_BUDGET : FALLBACK_VERBATIM_BUDGET);
  const assistantTail = usedModel ? [] : lastAssistantTexts(newer, 3);
  const covers = (Number(previous?.covers) || 0) + newer.length;
  const content = redactSecrets(assembleSummary({ covers, body, kept, verbatim, assistantTail })).text;

  // Re-read right before writing so a message that arrived during the model call survives.
  const fresh = readConversation(home, bot);
  if (!fresh.some((message) => olderIds.has(message.id))) {
    return { compacted: false, removed: 0, kept: fresh.length };
  }
  const message = {
    id: cryptoId(),
    role: "assistant",
    kind: "summary",
    content,
    at: Date.now(),
    covers,
    fallback: !usedModel,
  };
  const remaining = fresh.filter((item) => !olderIds.has(item.id));
  archive(home, bot, older);
  writeConversation(home, bot, [message, ...remaining]);
  bot.compaction = {
    at: Date.now(),
    removed: older.length,
    kept: remaining.length,
    summaryChars: content.length,
    covers,
    facts: facts.saved + facts.local,
    fallback: !usedModel,
  };
  saveState?.();
  emit?.({ type: "compacted", removed: older.length, kept: remaining.length, summary: content.slice(0, 4_000), facts: facts.saved + facts.local });
  return { compacted: true, removed: older.length, kept: remaining.length, summary: content, facts };
}

async function defaultSummarizer({ bot, system, prompt, directory, signal, waitForDecision }) {
  if (bot.model.provider === "openai") {
    const result = await complete({
      bot,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      tools: [],
      signal,
      onDelta: () => {},
    });
    return String(result.content || "").trim();
  }
  const result = await runOpenCodeTurn({
    bot,
    directory,
    remote: bot.remote?.compact || {},
    title: "Ravnir context compaction",
    text: `${system}\n\n${prompt}`,
    systemPrompt: system,
    history: "",
    emit: () => {},
    signal,
    waitForDecision,
  });
  if (bot.remote) bot.remote.compact = result.remote;
  return String(result.text || "").trim();
}

// ---------------------------------------------------------------------------
// Prompt and transcript

export function buildPrompt({ previousBody, previousRecent = "", transcript, built }) {
  const parts = [];
  parts.push(previousBody
    ? `Previous summary:\n<previous_summary>\n${previousBody}\n</previous_summary>`
    : "Previous summary: none. This is the first compaction of this conversation.");
  if (previousRecent) {
    parts.push(`Recent messages the previous summary quoted (code-managed, about to be dropped; absorb what only lives here, do not copy):\n<previous_recent>\n${previousRecent}\n</previous_recent>`);
  }
  parts.push(`New messages since the previous summary:\n<new_messages>\n${transcript}\n</new_messages>`);
  const lists = [];
  if (built.files.length) lists.push(`Files: ${built.files.slice(-40).join(", ")}`);
  if (built.urls.length) lists.push(`URLs: ${built.urls.slice(-30).join(", ")}`);
  if (built.commands.length) lists.push(`Commands: ${built.commands.slice(-15).join(" | ")}`);
  if (lists.length) parts.push(`Extracted by code from these messages (keep the useful ones under Identifiers):\n${lists.join("\n")}`);
  return parts.join("\n\n");
}

// Old tool outputs never reach the summarizer; each becomes a pointer into the archive.
export function buildTranscript(messages) {
  const lines = [];
  for (const message of messages) {
    if (message.kind === "ack") continue;
    if (message.kind === "summary") {
      lines.push(`Earlier summary:\n${unwrapSummary(message.content)}`);
      continue;
    }
    if (message.role === "tool") {
      lines.push(`tool ${message.name || "call"}: output archived (id ${message.id})`);
      continue;
    }
    const source = message.fromBotName ? `${message.role} (from bot ${message.fromBotName})` : message.role;
    const content = String(message.content || "").trim();
    const limit = message.role === "user" ? 6_000 : 3_000;
    if (content) lines.push(`${source}: ${content.slice(0, limit)}${content.length > limit ? ` [cut, id ${message.id}]` : ""}`);
    for (const call of toolCallsOf(message)) lines.push(`assistant called ${call.name || "tool"} ${clipJson(call.arguments, 300)}`);
  }
  const text = lines.join("\n\n");
  const half = TRANSCRIPT_MAX_CHARS / 2;
  return text.length > TRANSCRIPT_MAX_CHARS ? `${text.slice(0, half)}\n\n[...middle omitted...]\n\n${text.slice(-half)}` : text;
}

function toolCallsOf(message) {
  return Array.isArray(message.toolCalls) ? message.toolCalls.filter((call) => call && typeof call === "object") : [];
}

function argsOf(call) {
  if (call.arguments && typeof call.arguments === "object") return call.arguments;
  if (typeof call.arguments === "string") {
    try {
      return JSON.parse(call.arguments);
    } catch {
      return {};
    }
  }
  return {};
}

function clipJson(value, max) {
  let text = "";
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    text = "{}";
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// ---------------------------------------------------------------------------
// Summary text helpers

function lastSummaryIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].kind === "summary") return index;
  }
  return -1;
}

// The previous summary goes to the model in full. Only the wrapper and the parts
// that code rebuilds from the new span (recent user messages, last replies) are removed.
export function unwrapSummary(content) {
  let text = stripWrapper(content);
  text = removeSection(text, VERBATIM_TITLE);
  text = removeSection(text, ASSISTANT_TITLE);
  text = text.replace(FALLBACK_NOTE, "");
  return text.trim();
}

function stripWrapper(content) {
  let text = String(content || "");
  text = text.replace(/\n*_?(?:The \d+ earlier messages are archived in conversation-archive\.ndjson\.|Earlier messages are archived\. Use search_history and read_history to get exact wording\.)_?\s*$/i, "");
  return text.replace(/^\s*## Compacted context[^\n]*\n(?:_Covers [^\n]*_\n)?/i, "");
}

function sectionPattern(title) {
  return new RegExp(`^#{1,6}[ \\t]*${escapeRegex(title)}[^\\n]*\\n?[\\s\\S]*?(?=^#{1,6}[ \\t]|(?![\\s\\S]))`, "gim");
}

function removeSection(text, title) {
  return text.replace(sectionPattern(title), "");
}

// The code-built quotes of the previous summary, kept apart so the summarizer can
// absorb them before the next compaction replaces them.
function recentSections(content) {
  const text = stripWrapper(content);
  return [VERBATIM_TITLE, ASSISTANT_TITLE]
    .flatMap((title) => text.match(sectionPattern(title)) || [])
    .map((section) => section.trim())
    .join("\n\n")
    .slice(0, 18_000);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanReply(reply) {
  let text = String(reply || "");
  text = text.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/^\s*## Compacted context[^\n]*\n(?:_Covers [^\n]*_\n)?/i, "");
  text = removeSection(text, KEPT_TITLE);
  text = removeSection(text, VERBATIM_TITLE);
  text = removeSection(text, ASSISTANT_TITLE);
  return text.trim();
}

function fallbackBody(previousBody) {
  return previousBody ? `${FALLBACK_NOTE}\n\n${previousBody}` : `${FALLBACK_NOTE}\n\nNo earlier summary exists. Use the sections below, then search_history for details.`;
}

function verbatimEntries(messages, budget) {
  const entries = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || message.kind === "ack" || message.kind === "intro" || message.kind === "summary") continue;
    const text = String(message.content || "").trim();
    if (!text) continue;
    const label = `(id ${message.id} | ${shortDate(message.at)}${message.fromBotName ? ` | from ${message.fromBotName}` : ""})`;
    const room = budget - used - label.length - 8;
    if (room < 200) break;
    const cut = text.length > room;
    const quoted = `${cut ? text.slice(0, room) : text}${cut ? "\n[cut, use read_history for the rest]" : ""}`.split("\n").map((line) => `> ${line}`).join("\n");
    const entry = `${label}\n${quoted}`;
    entries.unshift(entry);
    used += entry.length + 2;
    if (used >= budget) break;
  }
  return entries;
}

function lastAssistantTexts(messages, count) {
  const out = [];
  for (let index = messages.length - 1; index >= 0 && out.length < count; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.kind === "ack" || message.kind === "intro") continue;
    const text = String(message.content || "").trim();
    if (!text) continue;
    out.unshift(`(id ${message.id} | ${shortDate(message.at)})\n${text.slice(0, 1_500).split("\n").map((line) => `> ${line}`).join("\n")}`);
  }
  return out;
}

// Protected: body and identifiers. Trimmed first: the transcript-derived parts.
function assembleSummary({ covers, body, kept, verbatim, assistantTail }) {
  const head = `## Compacted context\n_Covers ${covers} earlier message${covers === 1 ? "" : "s"}._\n\n`;
  const foot = `\n\n${SUMMARY_FOOTER}`;
  const room = SUMMARY_MAX_CHARS - head.length - foot.length;
  const keptFull = renderKept(kept, KEPT_MAX_CHARS);
  let bodyText = body.trim();
  const bodyMax = room - Math.min(keptFull.length + 2, 2_000);
  if (bodyText.length > bodyMax) {
    const cut = bodyText.slice(0, Math.max(0, bodyMax - 24));
    const newline = cut.lastIndexOf("\n");
    bodyText = `${cut.slice(0, newline >= cut.length - 400 ? newline : cut.length)}\n[...trimmed to fit]`;
  }
  const keptText = renderKept(kept, Math.min(KEPT_MAX_CHARS, room - bodyText.length - 2));
  const sections = [bodyText];
  if (keptText) sections.push(keptText);
  let left = room - sections.join("\n\n").length;
  const verbatimText = fitEntries(VERBATIM_TITLE, verbatim, Math.min(VERBATIM_BUDGET, left - 2));
  if (verbatimText) {
    sections.push(verbatimText);
    left -= verbatimText.length + 2;
  }
  const tailText = fitEntries(ASSISTANT_TITLE, assistantTail, Math.min(4_800, left - 2));
  if (tailText) sections.push(tailText);
  return `${head}${sections.join("\n\n")}${foot}`;
}

function fitEntries(title, entries, max) {
  if (!entries.length || max < 400) return "";
  const heading = `### ${title}\n\n`;
  const picked = [];
  let used = heading.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = entries[index].length + 2;
    if (used + size > max) break;
    picked.unshift(entries[index]);
    used += size;
  }
  if (!picked.length) {
    const newest = entries[entries.length - 1];
    return `${heading}${newest.slice(0, Math.max(0, max - heading.length - 40))}\n> [cut, use read_history for the rest]`;
  }
  return `${heading}${picked.join("\n\n")}`;
}

function renderKept(items, maxChars) {
  if (!items.length || maxChars < 100) return "";
  const lines = [`### ${KEPT_TITLE}`];
  let used = lines[0].length;
  for (const item of items) {
    const line = `- ${item.kind}: ${item.value}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function shortDate(at) {
  const time = Number(at);
  if (!time) return "undated";
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

// ---------------------------------------------------------------------------
// Identifiers

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}\\]+/gi;
const PATH_HOME_OR_ABS_RE = /(?<![\w./:@~-])(?:~(?:\/[\w.@+-]+)+|(?:\/[\w.@+-]+){2,})\/?/g;
const PATH_DOT_RE = /(?<![\w./:@~-])\.{1,2}\/[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
const PATH_REL_RE = /(?<![\w./:@~-])(?:\.{1,2}\/)?(?:[\w@+-][\w.@+-]*\/)+[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
const PATH_BARE_RE = /(?<![\w./:@~-])[\w@+-][\w.@+-]*\.(?:mjs|cjs|jsx|tsx|json|ndjson|plist|toml|ya?ml|html|css|env|lock|conf|cfg|ini|log|csv|sql|txt|md|js|ts|py|sh|go|rs|rb|php|java|swift)\b(?![\w/])/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi;
const HANDLE_RE = /(?<![\w@./-])@[A-Za-z][\w-]{1,38}(?![\w-]*\/)/g;
const TICKET_RE = /(?<![\w-])[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const NOT_A_PATH = /^(?:node|next|nuxt|nest|vue|react|express|three|d3|chart|ember|backbone|alpine|deno|bun)\.js$/i;
const NOT_A_TICKET = /^(?:UTF|SHA|AES|ISO|TLS|SSL|MD|IPV|WPA|CRC)-\d/;

export function extractIdentifiers(input) {
  let text = String(input || "");
  const out = { urls: [], paths: [], ids: [], handles: [], tickets: [] };
  const take = (re, target, clean = (value) => value, ok = () => true) => {
    text = text.replace(re, (match) => {
      const value = clean(match);
      if (value && ok(value) && !out[target].includes(value)) out[target].push(value);
      return " ";
    });
  };
  take(URL_RE, "urls", (value) => value.replace(/[.,;:!?]+$/, ""));
  for (const re of [PATH_HOME_OR_ABS_RE, PATH_DOT_RE, PATH_REL_RE, PATH_BARE_RE]) {
    take(re, "paths", (value) => value.replace(/[.,;:]+$/, ""), (value) => value.length <= 300 && !NOT_A_PATH.test(value));
  }
  take(UUID_RE, "ids");
  take(HEX_RE, "ids");
  take(HANDLE_RE, "handles");
  take(TICKET_RE, "tickets", (value) => value, (value) => !NOT_A_TICKET.test(value));
  return out;
}

const FILE_KEYS = new Set(["path", "file", "filepath", "file_path", "filename", "paths", "files"]);
const URL_KEYS = new Set(["url", "urls", "href", "link"]);
const COMMAND_TOOLS = new Set(["run_command", "bash", "shell", "exec", "terminal"]);

// Lists built by code from tool call arguments and message text, newest last.
export function collectBuilt(messages) {
  const files = new Set();
  const urls = new Set();
  const commands = new Set();
  const ids = new Set();
  const handles = new Set();
  const tickets = new Set();
  const touch = (set, value) => {
    set.delete(value);
    set.add(value);
  };
  const scan = (text, withUrls = true) => {
    const found = extractIdentifiers(text);
    if (withUrls) for (const url of found.urls) touch(urls, url);
    for (const id of found.ids) touch(ids, id);
    for (const handle of found.handles) touch(handles, handle);
    for (const ticket of found.tickets) touch(tickets, ticket);
  };
  for (const message of messages) {
    if (message.role === "tool" || message.kind === "ack") continue;
    if (typeof message.content === "string" && message.content) scan(message.content);
    for (const call of toolCallsOf(message)) {
      const args = argsOf(call);
      walkStrings(args, (key, value) => {
        const name = key.toLowerCase();
        if (FILE_KEYS.has(name) && validFile(value)) touch(files, value.trim());
        if (URL_KEYS.has(name) && validUrl(value)) touch(urls, value.trim());
        if (!FILE_KEYS.has(name) && !URL_KEYS.has(name) && name !== "command" && name !== "cmd" && value.length <= 1_000) scan(value);
      });
      if (COMMAND_TOOLS.has(String(call.name || "").toLowerCase())) {
        const command = String(args.command ?? args.cmd ?? "").replace(/\s+/g, " ").trim();
        if (command) {
          touch(commands, command.slice(0, 300));
          scan(command, true);
        }
      }
    }
  }
  return {
    files: [...files],
    urls: [...urls],
    commands: [...commands],
    ids: [...ids],
    handles: [...handles],
    tickets: [...tickets],
  };
}

function walkStrings(value, visit, key = "", depth = 0) {
  if (depth > 3 || value == null) return;
  if (typeof value === "string") {
    visit(key, value);
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walkStrings(item, visit, key, depth + 1);
  } else if (typeof value === "object") {
    for (const [name, item] of Object.entries(value)) walkStrings(item, visit, name, depth + 1);
  }
}

function validFile(value) {
  const text = value.trim();
  return Boolean(text) && text !== "." && text !== "./" && text.length <= 300 && !/[\n\r]/.test(text);
}

function validUrl(value) {
  const text = value.trim();
  return Boolean(text) && text.length <= 500 && !/\s/.test(text);
}

function builtCandidates(built) {
  return {
    file: built.files,
    url: built.urls,
    command: built.commands,
    id: built.ids,
    handle: built.handles,
    ticket: built.tickets,
  };
}

function identifierCandidates(previousBody) {
  const found = extractIdentifiers(previousBody);
  const commands = [];
  for (const match of String(previousBody || "").matchAll(/^- command: (.+)$/gm)) commands.push(match[1].trim());
  return { file: found.paths, url: found.urls, command: commands, id: found.ids, handle: found.handles, ticket: found.tickets };
}

function mergeCandidates(...sets) {
  const out = {};
  for (const kind of KEPT_ORDER) {
    const seen = new Set();
    // Later sets are newer; the last occurrence of a value wins its position.
    const all = sets.flatMap((set) => set[kind] || []);
    const ordered = [];
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (!seen.has(all[index])) {
        seen.add(all[index]);
        ordered.unshift(all[index]);
      }
    }
    out[kind] = ordered;
  }
  return out;
}

// Identifiers found in the previous summary or code-built lists but absent from
// the model's summary. Per-kind caps keep the newest.
export function auditIdentifiers(summaryText, candidates) {
  const haystack = String(summaryText || "").toLowerCase();
  const items = [];
  for (const kind of KEPT_ORDER) {
    const missing = (candidates[kind] || [])
      .filter((value) => value && !haystack.includes(value.toLowerCase()))
      .slice(-KEPT_CAPS[kind]);
    for (const value of missing) items.push({ kind, value: value.slice(0, 400) });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Durable facts

const FACT_KINDS = { fact: "fact", decision: "decision", rule: "rule", gotcha: "gotcha", preference: "rule", procedure: "rule", constraint: "rule" };

export function parseDurableFacts(reply) {
  const text = String(reply || "");
  const heading = new RegExp(`^(?:#{1,6}[ \\t]*)?\\**${FACTS_TITLE}\\**[ \\t]*:?[ \\t]*$`, "im");
  const match = heading.exec(text);
  if (!match) return { body: text.trim(), facts: [] };
  const after = text.slice(match.index + match[0].length);
  const next = /^#{1,6}[ \t]/m.exec(after);
  const section = next ? after.slice(0, next.index) : after;
  const rest = next ? after.slice(next.index) : "";
  const facts = [];
  const seen = new Set();
  for (const raw of section.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim();
    if (!line) continue;
    const labelled = /^\[?(fact|decision|rule|gotcha|preference|procedure|constraint)\]?\s*[:\-]\s*(.+)$/i.exec(line);
    const kind = labelled ? FACT_KINDS[labelled[1].toLowerCase()] : "fact";
    const fact = (labelled ? labelled[2] : line).replace(/\s+/g, " ").trim().slice(0, 300);
    if (fact.length < 8 || /^(none|n\/a|nothing|no new facts?)\.?$/i.test(fact)) continue;
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ kind, text: fact });
    if (facts.length >= MAX_DURABLE_FACTS) break;
  }
  return { body: `${text.slice(0, match.index)}${rest}`.trim(), facts };
}

function factKey(fact) {
  return fact.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function factPath(fact) {
  const slug = factKey(fact).split(" ").slice(0, 6).join("-").slice(0, 40).replace(/-+$/, "") || "fact";
  const hash = crypto.createHash("sha1").update(factKey(fact)).digest("hex").slice(0, 8);
  return `facts/${slug}-${hash}.md`;
}

// Append-only and deduped: a fact keeps one page named by its content hash, and an
// existing page is never rewritten. Anything that cannot reach ai-memory goes to
// the bot's own memory. This never throws.
export async function flushDurableFacts({ bot, facts, aiMemory, memoryClient, now = Date.now(), budgetMs = FACT_FLUSH_MS }) {
  const result = { saved: 0, local: 0, skipped: 0 };
  if (!facts?.length) return result;
  const deadline = Date.now() + budgetMs;
  let remoteOk = Boolean(aiMemory?.available && memoryClient);
  const date = new Date(now).toISOString().slice(0, 10);
  for (const original of facts) {
    const fact = { ...original, text: redactSecrets(original.text).text };
    try {
      if (remoteOk && Date.now() < deadline) {
        const pagePath = factPath(fact.text);
        let existing = "";
        try {
          existing = await memoryClient.read(aiMemory, pagePath);
        } catch {
          existing = "";
        }
        if (String(existing || "").toLowerCase().includes(fact.text.slice(0, 60).toLowerCase())) {
          result.skipped += 1;
          continue;
        }
        try {
          await memoryClient.write(aiMemory, {
            path: pagePath,
            title: fact.text.slice(0, 100),
            body: `${fact.text}\n\n_Source: ${bot.name}, compaction on ${date}._`,
            kind: fact.kind,
          });
          result.saved += 1;
          continue;
        } catch {
          remoteOk = false;
        }
      }
      if (rememberLocally(bot, fact.text, now)) result.local += 1;
      else result.skipped += 1;
    } catch {
      // A failed flush must never fail compaction.
    }
  }
  return result;
}

function rememberLocally(bot, fact, now) {
  const text = fact.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!text) return false;
  bot.memory ||= [];
  if (bot.memory.some((item) => String(item.text || "").toLowerCase() === text.toLowerCase())) return false;
  bot.memory.push({ id: cryptoId(), text, at: now, source: "compaction" });
  bot.memory = bot.memory.slice(-80);
  return true;
}

// ---------------------------------------------------------------------------
// Archive: write, search, read

export function archivePath(home, bot) {
  return path.join(botHome(home, bot), "conversation-archive.ndjson");
}

function archive(home, bot, messages) {
  if (!messages.length) return;
  const file = archivePath(home, bot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const archivedAt = Date.now();
  fs.appendFileSync(file, messages.map((message) => JSON.stringify({ archivedAt, ...message, id: message.id || cryptoId() })).join("\n") + "\n");
}

const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export function readArchive(home, bot, { maxBytes = ARCHIVE_MAX_BYTES } = {}) {
  const file = archivePath(home, bot);
  let text = "";
  try {
    const size = fs.statSync(file).size;
    if (size > maxBytes) {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, size - maxBytes);
        text = buffer.toString("utf8");
        text = text.slice(text.indexOf("\n") + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(file, "utf8");
    }
  } catch {
    return [];
  }
  const rows = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    row.id ||= `h-${crypto.createHash("sha1").update(`${row.at}|${row.role}|${row.content}`).digest("hex").slice(0, 12)}`;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

function searchableText(row) {
  const calls = toolCallsOf(row).map((call) => `${call.name || ""} ${clipJson(argsOf(call), 600)}`).join("\n");
  return [row.content, calls, row.name, row.fromBotName].filter(Boolean).join("\n").replace(/\s+/g, " ").trim();
}

function snippetAround(text, terms, size = 300) {
  const lower = text.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    hit = lower.indexOf(term);
    if (hit >= 0) break;
  }
  if (hit < 0) hit = 0;
  let begin = Math.max(0, hit - Math.floor(size / 3));
  const end = Math.min(text.length, begin + size);
  begin = Math.max(0, end - size);
  return `${begin > 0 ? "..." : ""}${text.slice(begin, end)}${end < text.length ? "..." : ""}`;
}

export function searchArchive(home, bot, { query, limit = 10 } = {}) {
  const terms = [...new Set(String(query || "").toLowerCase().replace(/["']/g, " ").split(/\s+/).filter(Boolean))];
  if (!terms.length) throw new Error("A search query is required.");
  const max = Math.min(20, Math.max(1, Math.floor(Number(limit)) || 10));
  const rows = readArchive(home, bot);
  const matches = [];
  let total = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === "ack" || row.kind === "summary") continue;
    const text = searchableText(row);
    const lower = text.toLowerCase();
    if (!terms.every((term) => lower.includes(term))) continue;
    total += 1;
    if (matches.length < max) {
      matches.push({
        id: row.id,
        at: row.at || row.archivedAt || 0,
        role: row.role === "tool" && row.name ? `tool ${row.name}` : row.role || "message",
        snippet: snippetAround(text, terms),
      });
    }
  }
  return { matches, total, searched: rows.length };
}

export function formatSearch(result, query) {
  if (!result.matches.length) {
    return result.searched ? `No archived messages match "${query}". Try fewer or different words.` : "There is no archived history yet.";
  }
  const lines = result.matches.map((match) => `- id ${match.id} | ${shortDate(match.at)} | ${match.role} | ${match.snippet}`);
  const more = result.total > result.matches.length ? `\nShowing the newest ${result.matches.length} of ${result.total} matches. Add words to narrow the search.` : "";
  return `${result.total} archived message${result.total === 1 ? "" : "s"} match "${query}" (newest first). Use read_history with an id for the exact wording.\n${lines.join("\n")}${more}`;
}

export function readArchiveWindow(home, bot, { id, before = 2, after = 2 } = {}) {
  const wanted = String(id || "").trim();
  if (!wanted) throw new Error("A message id is required.");
  const rows = readArchive(home, bot).filter((row) => row.kind !== "ack");
  let index = rows.findIndex((row) => row.id === wanted);
  if (index < 0 && wanted.length >= 6) {
    const prefixed = rows.filter((row) => String(row.id).startsWith(wanted));
    if (prefixed.length > 1) throw new Error(`The id prefix "${wanted}" matches ${prefixed.length} messages. Use a longer id.`);
    if (prefixed.length === 1) index = rows.indexOf(prefixed[0]);
  }
  if (index < 0) return { found: false, messages: [], target: -1 };
  const back = clampInt(before, 0, 5, 2);
  const forward = clampInt(after, 0, 5, 2);
  const from = Math.max(0, index - back);
  return { found: true, messages: rows.slice(from, index + forward + 1), target: index - from };
}

export function formatWindow(result, id) {
  if (!result.found) return `No archived message has the id ${id}. Use search_history to find ids.`;
  const blocks = result.messages.map((row, position) => {
    const content = String(row.content || "");
    const clipped = content.length > 4_000 ? `${content.slice(0, 4_000)}\n[cut: ${content.length - 4_000} more characters]` : content;
    const calls = toolCallsOf(row).map((call) => `tool call: ${call.name || "tool"} ${clipJson(argsOf(call), 600)}`).join("\n");
    const who = row.role === "tool" && row.name ? `tool ${row.name}` : row.role || "message";
    const from = row.fromBotName ? ` | from ${row.fromBotName}` : "";
    const marker = position === result.target ? ">> " : "   ";
    return `${marker}id ${row.id} | ${shortDate(row.at || row.archivedAt)} | ${who}${from}\n${[clipped, calls].filter(Boolean).join("\n") || "(empty)"}`;
  });
  return `Archived messages around the one you asked for (marked with >>):\n\n${blocks.join("\n\n---\n\n")}`;
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// ---------------------------------------------------------------------------
// Misc

// Aborts the inner signal on timeout or when the outer signal aborts.
function runWithTimeout(task, ms, outer) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  outer?.addEventListener?.("abort", onAbort, { once: true });
  let timer;
  const cleanup = () => {
    clearTimeout(timer);
    outer?.removeEventListener?.("abort", onAbort);
  };
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      cleanup();
      controller.abort();
      reject(new Error("Compaction timed out."));
    }, ms);
    Promise.resolve()
      .then(() => task(controller.signal))
      .then(resolve, reject)
      .finally(cleanup);
  });
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
