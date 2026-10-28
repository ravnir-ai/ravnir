import { stripFrontmatter } from "./indexer.js";

// Builds the block of vault knowledge a bot sees at the start of a turn.

const RULES_MAX = 2000;
const AGENT_MAX = 1500;
const PROFILE_MAX = 1500;
const PROJECT_MAX = 700;
const PROJECT_LIVE_MAX = 1400;
const LIVE_HIT_MAX = 900;
const STATUS_HEADING = /^(estado actual|current status|status)$/i;

const day = (date) => String(date || "").slice(0, 10);
const cap = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function firstParagraph(body) {
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    while (lines.length && /^#{1,6}\s/.test(lines[0])) lines.shift();
    const text = lines.join("\n").trim();
    if (text) return text;
  }
  return "";
}

function projectText(vault, note) {
  const live = vault.live(note.path);
  const section = live || vault.section(note.path, STATUS_HEADING);
  const paragraph = firstParagraph(stripFrontmatter(note.body));
  const text = [section, paragraph && !section.includes(paragraph) ? paragraph : ""].filter(Boolean).join("\n\n");
  return cap(text, live ? PROJECT_LIVE_MAX : PROJECT_MAX);
}

function render(s) {
  const parts = [];
  if (s.rules) parts.push(`Rules.md (updated ${day(s.rules.date)}):\n${s.rules.text}`);
  if (s.profile) parts.push(`About the user, ${s.profile.path} (updated ${day(s.profile.date)}; every agent sees this, so a fact one agent saved with remember is known to all):\n${s.profile.text}`);
  if (s.agent) parts.push(`Your note ${s.agent.path} (updated ${day(s.agent.date)}):\n${s.agent.text}`);
  else if (!s.agentTrimmed) parts.push("You have no note in Agents/ yet.");
  if (s.projects.length) {
    parts.push(`Your projects:\n${s.projects.map((p) => `### ${p.path} (updated ${day(p.date)})\n${p.text}`).join("\n\n")}`);
  }
  if (s.others.length) parts.push(`Other project notes: ${s.others.join(", ")}`);
  if (s.relevant.length) {
    const lines = s.relevant.map((r) => {
      const line = `- ${r.path}${r.heading ? ` > ${r.heading}` : ""} (updated ${day(r.date)}): ${r.snippet}`;
      return r.live ? `${line}\n${cap(r.live, LIVE_HIT_MAX).replace(/^/gm, "  ")}` : line;
    });
    parts.push(`Relevant notes for this message:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

// Everything a bot always gets, before the per-message search.
function prepare(vault, bot, profilePath = "") {
  const byPath = new Map(vault.notes().map((n) => [n.path, n]));
  const state = { rules: null, profile: null, agent: null, agentTrimmed: false, projects: [], others: [], relevant: [] };
  const injected = new Set();

  const rules = byPath.has("Rules.md") ? vault.read("Rules.md") : null;
  if (rules) {
    state.rules = { path: rules.path, date: rules.date, hash: rules.hash, text: cap(stripFrontmatter(rules.body).trim(), RULES_MAX) };
    injected.add(rules.path);
  }

  // The owner's profile note, where remember writes: shared by every agent on every turn.
  const profile = profilePath && byPath.has(profilePath) ? vault.read(profilePath) : null;
  if (profile) {
    state.profile = { path: profile.path, date: profile.date, hash: profile.hash, text: cap(stripFrontmatter(profile.body).split(/^## (?:Histórico|History)\s*$/m)[0].trim(), PROFILE_MAX) };
    injected.add(profile.path);
  }

  const agentPath = vault.noteForBot(bot);
  const agent = agentPath ? vault.read(agentPath) : null;
  if (agent) {
    state.agent = { path: agent.path, date: agent.date, hash: agent.hash, text: cap(stripFrontmatter(agent.body).trim(), AGENT_MAX) };
    injected.add(agent.path);
  }

  for (const projectPath of vault.projectsForBot(bot, agentPath)) {
    const note = vault.read(projectPath);
    if (!note || injected.has(note.path)) continue;
    state.projects.push({ path: note.path, date: note.date, hash: note.hash, text: projectText(vault, note) });
    injected.add(note.path);
  }

  state.others = vault.notes("Projects/").filter((n) => !injected.has(n.path)).map((n) => n.title);
  return { state, injected, byPath };
}

function finish({ state, injected, byPath }, hits, maxChars, vault) {
  if (hits.length) {
    const seen = new Set();
    for (const hit of hits) {
      if (injected.has(hit.path) || seen.has(hit.path) || state.relevant.length >= 5) continue;
      seen.add(hit.path);
      const live = vault.live(hit.path);
      const hash = live ? vault.read(hit.path)?.hash : byPath.get(hit.path)?.hash;
      state.relevant.push({ ...hit, hash: hash || "", live });
    }
  }

  let text = render(state);
  while (text.length > maxChars) {
    if (state.relevant.length) state.relevant.pop();
    else if (state.others.length) state.others.pop();
    else if (state.projects.length) state.projects.pop();
    else if (state.agent) {
      state.agent = null;
      state.agentTrimmed = true;
    } else break;
    text = render(state);
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);

  const sources = [state.rules, state.profile, state.agent, ...state.projects, ...state.relevant]
    .filter(Boolean)
    .map((item) => ({ path: item.path, date: item.date, hash: item.hash }));
  return { text, sources };
}

// What the Mind tab shows: the fixed part, without per-message hits.
export function staticContextForBot(vault, bot, { maxChars = 6000, profile = "" } = {}) {
  return finish(prepare(vault, bot, profile), [], maxChars, vault);
}

export async function contextForBot(vault, bot, query, { maxChars = 6000, profile = "" } = {}) {
  const prepared = prepare(vault, bot, profile);
  const hits = String(query || "").trim() ? await vault.search(query, { limit: 5 + prepared.injected.size }) : [];
  const result = finish(prepared, hits, maxChars, vault);
  return { ...result, turnNote: turnNote(vault, result.sources) };
}

// Live figures ride along with the user's message too: models trust the latest turn more than the
// system prompt, and an earlier answer in the thread must not win over fresher data.
function turnNote(vault, sources) {
  const blocks = sources
    .map((source) => ({ path: source.path, text: vault.live(source.path) }))
    .filter((item) => item.text)
    .map((item) => `${item.path}\n${cap(item.text, 1400)}`);
  if (!blocks.length) return "";
  return `[Vault data attached to this message by Ravnir. It is newer than anything said earlier in this thread; prefer it and cite it.]\n${blocks.join("\n\n")}`;
}

// The vault notes a reply names, with the version this turn was given, so the thread can show
// where an answer came from. A note counts when the reply mentions its path, its file name or a
// [[wiki link]] to it; notes loaded for the turn but not cited are left out.
export function citedSources(sources, text) {
  const reply = String(text || "");
  if (!reply || !Array.isArray(sources)) return [];
  const lower = reply.toLowerCase();
  const seen = new Set();
  const cited = [];
  for (const source of sources) {
    const path = String(source?.path || "");
    if (!path || seen.has(path)) continue;
    const file = path.split("/").pop();
    const title = file.replace(/\.md$/i, "");
    const named = lower.includes(path.toLowerCase())
      || lower.includes(file.toLowerCase())
      || lower.includes(`[[${title.toLowerCase()}]]`)
      || lower.includes(`[[${path.replace(/\.md$/i, "").toLowerCase()}]]`);
    if (!named) continue;
    seen.add(path);
    cited.push({ path, date: source.date || "", hash: source.hash || "" });
  }
  return cited.slice(0, 4);
}
