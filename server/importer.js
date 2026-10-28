import crypto from "node:crypto";
import { memoryWrite as writeAiMemory } from "./aiMemory.js";
import { createJob } from "./jobs.js";
import { DEFAULT_INSTRUCTIONS } from "./prompts.js";
import { hasSecret, redactSecrets } from "./redact.js";

// Moving a bot over from Grok Bot, through the official app only. Ravnir shows a
// prompt, the user pastes it into each Grok bot, and the bot answers with one JSON
// block. This file reads that answer, plans what would change, and applies it.
// It never touches Grok Bot's own files or credentials.

const MAX_TEXT = 4_000_000;
const MAX_ITEMS = 60;
const MAX_MEMORIES = 200;
const MAX_ROUTINES = 40;
const MEMORY_ITEM_LIMIT = 600;
const PROMPT_LIMIT = 32_000;
const MEMORY_BUDGET_MS = 60_000;
const BOT_MEMORY_CAP = 80;

export const EXPORT_PROMPT = `I am moving you to a new server called Ravnir. Export everything about you as ONE JSON code block, with no text before or after it.

Use exactly this shape:

{
  "name": "your name",
  "job": "one sentence: what you are for",
  "instructions": "your standing instructions, copied word for word, not summarized",
  "memories": ["one durable fact per item, in plain words"],
  "routines": [
    {
      "name": "routine name",
      "cron": "five-field cron expression in the Europe/Madrid time zone, for example 0 8 * * 1-5",
      "schedule": "the same schedule in words",
      "prompt": "the routine's instruction, copied word for word",
      "enabled": true
    }
  ],
  "connectors": ["names of the connectors, tools or MCP servers you use"],
  "notes": "anything else worth keeping that does not fit above"
}

Rules:
- Copy instructions and routine prompts word for word.
- One fact per item in memories. Only real facts you hold. Do not invent any.
- Never include passwords, tokens, API keys or other secrets. If something needs a secret, name the secret, not its value.
- If a field has nothing in it, use an empty string or an empty list.
- Answer with the JSON code block and nothing else.`;

export function exportPrompt() {
  return EXPORT_PROMPT;
}

// ---------------------------------------------------------------------------
// Reading the answer

// Accepts one object, an array, or prose around one or more JSON blocks (fenced or not).
// Returns normalized items. Throws with a readable message when nothing usable is found.
export function parseExport(text) {
  const source = String(text ?? "");
  if (!source.trim()) throw new Error("Paste the export first.");
  if (source.length > MAX_TEXT) throw new Error("That text is too long to import.");
  const items = [];
  for (const value of jsonValues(source)) {
    for (const raw of flatten(value)) {
      const item = normalizeItem(raw);
      if (item) items.push(item);
    }
  }
  if (!items.length) {
    throw new Error("I could not find a Grok bot export in that text. Paste the JSON code block the bot answered with.");
  }
  return items.slice(0, MAX_ITEMS);
}

function* jsonValues(text) {
  const whole = text.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    const value = parseLenient(whole);
    if (value !== undefined) {
      yield value;
      return;
    }
  }
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== "{" && char !== "[") {
      index += 1;
      continue;
    }
    const end = matchingEnd(text, index);
    const value = end > index ? parseLenient(text.slice(index, end + 1)) : undefined;
    if (value !== undefined && value !== null && typeof value === "object") {
      yield value;
      index = end + 1;
    } else {
      index += 1;
    }
  }
}

// The index of the bracket that closes the one at `start`, skipping string contents.
function matchingEnd(text, start) {
  const stack = [];
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

function parseLenient(candidate) {
  const clean = candidate.replace(/^﻿/, "");
  try {
    return JSON.parse(clean);
  } catch {
    // Models often leave a trailing comma. Try once without them.
  }
  try {
    return JSON.parse(clean.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== "object") return [];
  for (const key of ["bots", "agents"]) {
    if (Array.isArray(value[key])) return value[key].flatMap(flatten);
  }
  return [value];
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = line(raw.name, 40);
  // A routine or a stray object has a name too. A bot export carries at least one of these.
  const looksLikeBot = ["instructions", "job", "memories", "memory", "routines", "connectors", "notes"].some((key) => key in raw) && !("cron" in raw);
  if (!name || !looksLikeBot) return null;
  const tally = { count: 0 };
  const memories = [];
  for (const entry of asList(raw.memories ?? raw.memory)) {
    const text = line(typeof entry === "object" && entry ? entry.text ?? entry.fact ?? entry.content : entry, MEMORY_ITEM_LIMIT);
    if (text && !memories.some((have) => have.toLowerCase() === text.toLowerCase())) memories.push(text);
  }
  const routines = asList(raw.routines).map((routine) => normalizeRoutine(routine, tally)).filter(Boolean).slice(0, MAX_ROUTINES);
  const connectors = [];
  for (const entry of asList(raw.connectors)) {
    const text = line(typeof entry === "object" && entry ? entry.name : entry, 80);
    if (text && !connectors.includes(text)) connectors.push(text);
  }
  return {
    name,
    job: scrub(line(raw.job, 300), tally),
    instructions: scrub(text(raw.instructions ?? raw.prompt ?? raw.system_prompt, PROMPT_LIMIT), tally),
    memories: memories.slice(0, MAX_MEMORIES),
    routines,
    connectors: connectors.slice(0, 40),
    notes: scrub(text(raw.notes, 4_000), tally),
    redactions: tally.count,
  };
}

function normalizeRoutine(raw, tally) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const prompt = scrub(text(raw.prompt ?? raw.instruction ?? raw.instructions, 8_000), tally);
  const name = scrub(line(raw.name, 60), tally);
  if (!prompt && !name) return null;
  return {
    name: name || "Imported routine",
    cron: line(raw.cron, 120),
    schedule: line(raw.schedule, 200),
    prompt,
    enabled: raw.enabled !== false && raw.active !== false,
  };
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function line(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// Secret-looking text is replaced, never stored. The tally feeds the warning.
function scrub(value, tally) {
  const clean = redactSecrets(value);
  tally.count += clean.found;
  return clean.text;
}

function text(value, max) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}

// ---------------------------------------------------------------------------
// Planning

// One entry per bot in the export: what would be created or changed.
export function planImport(state, items, { now = Date.now() } = {}) {
  const date = isoDate(now);
  const seen = new Set();
  return items.map((item) => {
    const existing = findBot(state, item.name);
    const key = item.name.toLowerCase();
    const repeat = seen.has(key);
    seen.add(key);
    const warnings = [];
    if (repeat) warnings.push(`${item.name} appears more than once in the export. The later copy is merged into the first.`);
    if (!existing && !repeat && state.bots.length >= 60) warnings.push("This server already has 60 bots, so this one cannot be created.");
    const change = instructionChange(existing, item, date);
    if (change.warning) warnings.push(change.warning);
    const memories = item.memories.filter((memory) => !hasMemory(existing, memory) && !hasSecret(memory));
    const skippedSecrets = item.memories.filter(hasSecret).length;
    if (skippedSecrets) warnings.push(`${skippedSecrets} ${skippedSecrets === 1 ? "memory looks" : "memories look"} like a password or key and will not be imported.`);
    if (item.redactions) warnings.push(redactionWarning(item));
    const routines = item.routines.map((routine) => routineCheck(existing, routine));
    for (const routine of routines) {
      if (routine.warning) warnings.push(routine.warning);
    }
    if (item.connectors.length) warnings.push(`Connectors are not installed automatically. ${item.connectors.join(", ")} will be listed in the bot's notes so you can add them.`);
    return {
      name: item.name,
      action: existing || repeat ? "update" : "create",
      botId: existing ? existing.id : "",
      instructions: change.action === "set" || change.action === "append",
      instructionsAction: change.action,
      job: item.job,
      memories: memories.length,
      memoryList: memories,
      routines: routines.filter((routine) => routine.status === "new").length,
      routineList: routines.map(({ name, schedule, cron, prompt, enabled, status }) => ({ name, schedule, cron, prompt, enabled, status })),
      connectors: item.connectors.length,
      connectorList: item.connectors,
      notes: item.notes,
      warnings,
    };
  });
}

function redactionWarning(item) {
  return `${item.redactions} ${item.redactions === 1 ? "value" : "values"} in the instructions, notes or routines of ${item.name} looked like a password or key and ${item.redactions === 1 ? "was" : "were"} replaced with [redacted]. Check them before you apply.`;
}

function instructionChange(bot, item, date) {
  const imported = item.instructions;
  const extra = notesBlock(item, date);
  if (!imported && !extra) return { action: "none", text: "" };
  const current = bot ? String(bot.prompt || "") : "";
  let next = current;
  let action = "none";
  if (imported) {
    if (!current.trim()) {
      next = imported;
      action = "set";
    } else if (!sameText(current, imported)) {
      next = `${current.trimEnd()}\n\nImported from Grok Bot (${date}):\n${imported}`;
      action = "append";
    }
  }
  if (extra && !includesText(next, extra.body)) {
    next = `${next.trimEnd()}${next.trim() ? "\n\n" : ""}${extra.text}`;
    if (action === "none") action = "append";
  }
  if (next.length > PROMPT_LIMIT) {
    return { action: "none", text: current, warning: `The instructions for ${item.name} would pass ${PROMPT_LIMIT} characters, so they were left as they are.` };
  }
  return { action, text: next };
}

function notesBlock(item, date) {
  const parts = [];
  if (item.connectors.length) parts.push(`Connectors it used on Grok Bot (not installed here, add them under Connectors): ${item.connectors.join(", ")}.`);
  if (item.notes) parts.push(item.notes);
  if (!parts.length) return null;
  const body = parts.join("\n");
  return { body, text: `Notes from the Grok Bot export (${date}):\n${body}` };
}

function routineCheck(bot, routine) {
  const base = { ...routine, status: "new", warning: "" };
  if (!routine.prompt) return { ...base, status: "skipped", warning: `Routine "${routine.name}" has no instruction and was skipped.` };
  if (!routine.cron) {
    return { ...base, status: "skipped", warning: `Routine "${routine.name}" has no cron expression${routine.schedule ? ` (it said: ${routine.schedule})` : ""} and was skipped.` };
  }
  try {
    createJob({ name: routine.name, prompt: routine.prompt, cron: routine.cron, enabled: false, createdBy: "import" });
  } catch (error) {
    return { ...base, status: "skipped", warning: `Routine "${routine.name}" was skipped: ${error.message}` };
  }
  const duplicate = bot?.jobs?.some((job) => job.name.toLowerCase() === routine.name.toLowerCase() && sameText(job.prompt, routine.prompt));
  return duplicate ? { ...base, status: "exists" } : base;
}

// ---------------------------------------------------------------------------
// Applying

// createBot(item) returns the new bot, already stored in state with its home and
// token set up. The server owns that, so this file stays free of HTTP and secrets.
export async function applyImport({
  state,
  items,
  enableRoutines = false,
  createBot,
  touch = () => {},
  aiMemory = null,
  writeMemory = writeAiMemory,
  now = Date.now(),
}) {
  const date = isoDate(now);
  const result = { created: 0, updated: 0, memories: 0, routines: 0, warnings: [], bots: [] };
  const deadline = Date.now() + MEMORY_BUDGET_MS;
  let remote = Boolean(aiMemory?.available);
  for (const item of items) {
    let bot = findBot(state, item.name);
    let action = "update";
    if (!bot) {
      if (typeof createBot !== "function" || state.bots.length >= 60) {
        result.warnings.push(`${item.name} was not created${state.bots.length >= 60 ? " because this server already has 60 bots" : ""}.`);
        continue;
      }
      bot = await createBot(item);
      // A new bot starts empty, so the export's instructions are set, not appended to a default.
      bot.prompt = "";
      action = "create";
    }
    if (item.redactions) result.warnings.push(redactionWarning(item));
    const change = instructionChange(bot, item, date);
    if (change.warning) result.warnings.push(change.warning);
    if (change.action !== "none") bot.prompt = change.text;
    if (!String(bot.prompt || "").trim()) bot.prompt = DEFAULT_INSTRUCTIONS;
    if (action === "create") result.created += 1;
    else result.updated += 1;

    for (const memory of item.memories) {
      if (hasSecret(memory)) {
        result.warnings.push(`A memory for ${bot.name} looks like a password or key and was not imported.`);
        continue;
      }
      if (hasMemory(bot, memory)) continue;
      if (remote && Date.now() < deadline) {
        try {
          await writeMemory(aiMemory, {
            path: memoryPath(bot, memory),
            title: memory.slice(0, 100),
            body: `${memory}\n\n_Imported from Grok Bot (${bot.name}) on ${date}._`,
            kind: "fact",
          });
          // The bot keeps its own copy too, unless its memory is already full.
          if ((bot.memory?.length || 0) < BOT_MEMORY_CAP) rememberLocally(bot, memory, now);
          result.memories += 1;
          continue;
        } catch {
          remote = false;
        }
      }
      rememberLocally(bot, memory, now);
      result.memories += 1;
    }

    for (const routine of item.routines) {
      const check = routineCheck(bot, routine);
      if (check.status === "skipped") {
        result.warnings.push(check.warning);
        continue;
      }
      if (check.status === "exists") continue;
      bot.jobs ||= [];
      bot.jobs.push(createJob({
        name: routine.name,
        prompt: routine.prompt,
        cron: routine.cron,
        enabled: enableRoutines && routine.enabled,
        createdBy: "import",
      }));
      result.routines += 1;
    }
    touch(bot);
    result.bots.push({ id: bot.id, name: bot.name, action });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers

function findBot(state, name) {
  const wanted = String(name || "").trim().toLowerCase();
  return (state.bots || []).find((bot) => bot.name.toLowerCase() === wanted) || null;
}

function hasMemory(bot, memory) {
  const wanted = memory.toLowerCase();
  return Boolean(bot?.memory?.some((item) => String(item.text || "").toLowerCase() === wanted));
}

function rememberLocally(bot, memory, now) {
  bot.memory ||= [];
  bot.memory.push({ id: crypto.randomUUID(), text: memory.slice(0, MEMORY_ITEM_LIMIT), at: now, source: "import" });
  bot.memory = bot.memory.slice(-BOT_MEMORY_CAP);
}

function memoryPath(bot, memory) {
  const slug = bot.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "bot";
  const hash = crypto.createHash("sha1").update(memory.toLowerCase()).digest("hex").slice(0, 10);
  return `imports/grok-bot/${slug}-${hash}.md`;
}

function squash(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sameText(a, b) {
  return squash(a) === squash(b);
}

function includesText(haystack, needle) {
  return squash(haystack).includes(squash(needle));
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
