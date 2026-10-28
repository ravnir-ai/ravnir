import { normalizeLimits, normalizePolicy } from "./policy.js";
import { publicSpec } from "./spec.js";
import { modelLogo } from "./providerLogos.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nextCron, scheduleFields } from "./jobs.js";
import { BUILDER_INSTRUCTIONS, DEFAULT_INSTRUCTIONS, SCOUT_INSTRUCTIONS } from "./prompts.js";
// The browser's avatar module is the single source for looks, so client and server agree.
import "../public/avatar.js";
import { normalizeOwner } from "./owner.js";
import { normalizeBrowserNetwork } from "./netRoute.js";
import { LAYOUT_CHOICES } from "./vault/layout.js";

const Avatars = globalThis.RavnirAvatar;

// The avatar picker's palette: soft, vivid and deep rows. The first five are the original colors.
export const COLORS = [...Avatars.COLORS];

const STATE_VERSION = 1;

export function newId() {
  return crypto.randomUUID();
}

export const BOX_MODES = ["host", "container"];

// Where a bot's commands, desktop and browser run: on this server as the Ravnir
// user ("host"), or in the bot's own container ("container", see server/box.js).
export function normalizeBox(input) {
  return { mode: BOX_MODES.includes(input?.mode) ? input.mode : "host" };
}

export function ensureGroups(state) {
  state.groups ||= [];
  const seen = new Set();
  state.groups = state.groups
    .filter((group) => group && typeof group.name === "string")
    .map((group) => ({
      id: group.id || crypto.randomUUID(),
      name: String(group.name).replace(/\s+/g, " ").trim().slice(0, 40),
      createdAt: group.createdAt || Date.now(),
    }))
    .filter((group) => {
      if (!group.name || seen.has(group.name.toLowerCase())) return false;
      seen.add(group.name.toLowerCase());
      return true;
    })
    .slice(0, 50);
  for (const bot of state.bots || []) {
    const name = String(bot.group || "Personal").replace(/\s+/g, " ").trim().slice(0, 40) || "Personal";
    if (!seen.has(name.toLowerCase())) {
      state.groups.push({ id: crypto.randomUUID(), name, createdAt: Date.now() });
      seen.add(name.toLowerCase());
    }
  }
  if (!seen.has("personal")) state.groups.push({ id: crypto.randomUUID(), name: "Personal", createdAt: Date.now() });
  return state.groups;
}

export function botHome(home, bot) {
  return path.join(home, "bots", bot.id);
}

export function workspacePath(home, bot) {
  return path.join(botHome(home, bot), "workspace");
}

export function browserProfilePath(home, bot) {
  return path.join(botHome(home, bot), "browser-profile");
}

export function ensureBotHome(home, bot) {
  for (const dir of [botHome(home, bot), workspacePath(home, bot), browserProfilePath(home, bot), path.join(botHome(home, bot), "downloads")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const readme = path.join(workspacePath(home, bot), "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `# ${bot.name}'s workspace\n\nThis folder belongs to ${bot.name}. Files here are visible in the bot's computer and every edit is recorded as a diff.\n`);
  }
}

export function createBot(input = {}) {
  const now = Date.now();
  const name = cleanName(input.name) || "New bot";
  const id = newId();
  return {
    id,
    name,
    job: cleanLine(input.job) || "A persistent teammate on this server.",
    group: cleanLine(input.group) || "Personal",
    color: COLORS.includes(input.color) ? input.color : COLORS[0],
    avatar: input.avatar && typeof input.avatar === "object"
      ? normalizeAvatar(input.avatar, id)
      : suggestAvatar({ name, job: input.job, seed: id }),
    status: "on",
    pinned: Boolean(input.pinned),
    pinnedOrder: Number.isFinite(Number(input.pinnedOrder)) ? Number(input.pinnedOrder) : 0,
    main: Boolean(input.main),
    createdAt: now,
    updatedAt: now,
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : DEFAULT_INSTRUCTIONS,
    memory: [],
    model: normalizeModel(input.model || {}),
    remote: {},
    connectors: [],
    jobs: [],
    vault: [],
    policy: normalizePolicy(input.policy),
    limits: normalizeLimits(input.limits),
    notify: normalizeNotifyLevel(input.notify),
    skills: normalizeSkills(input.skills),
    stats: { turns: 0, lastActiveAt: 0, lastError: "" },
  };
}

export function defaultBots(model = {}) {
  const shared = { provider: "opencode", baseUrl: "http://127.0.0.1:4096", model: "", agent: "", username: "opencode", ...model };
  return [
    createBot({
      name: "Scout",
      job: "Reads the web, answers questions, and keeps notes for later.",
      color: COLORS[0],
      prompt: SCOUT_INSTRUCTIONS,
      model: { ...shared, agent: "" },
    }),
    createBot({
      name: "Builder",
      job: "Writes and changes code in its own workspace. Every edit is a visible diff.",
      color: COLORS[1],
      prompt: BUILDER_INSTRUCTIONS,
      model: { ...shared, agent: "build" },
    }),
  ];
}

export function loadState({ home, secrets, projectRoot }) {
  const file = path.join(home, "state.json");
  fs.mkdirSync(home, { recursive: true });
  let state;
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    // A fresh install starts empty and opens the first-run wizard (public/welcome.js), which
    // creates the starter agents. Installs from before the wizard never have settings.setup.
    state = migrateLegacy({ home, secrets, projectRoot }) || {
      version: STATE_VERSION,
      server: { name: "Ravnir", createdAt: Date.now() },
      bots: [],
      settings: { setup: { needed: true } },
    };
  }
  state.version = STATE_VERSION;
  state.server ||= { name: "Ravnir", createdAt: Date.now() };
  if (state.server.name === "TrueBot") state.server.name = "Ravnir";
  state.bots ||= [];
  state.groups ||= [];
  // Account-level plugin connections (server/plugins.js). Secrets live in the vault, never here.
  state.plugins = state.plugins && typeof state.plugins === "object" && !Array.isArray(state.plugins) ? state.plugins : {};
  state.settings = normalizeSettings(state.settings);
  for (const bot of state.bots) normalizeBot(bot, home, secrets);
  ensureGroups(state);
  saveState(home, state);
  return state;
}

export function saveState(home, state) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function touchBot(bot) {
  bot.updatedAt = Date.now();
}

export function readConversation(home, bot) {
  return readJson(path.join(botHome(home, bot), "conversation.json"), []);
}

const CONVERSATION_KEEP = 400;

// Messages that fall off the end of the thread are archived first, in the same
// line format compaction uses, so search_history and read_history still find them.
export function writeConversation(home, bot, messages) {
  const overflow = messages.length > CONVERSATION_KEEP ? messages.slice(0, messages.length - CONVERSATION_KEEP) : [];
  if (overflow.length) archiveMessages(home, bot, overflow);
  writeJson(path.join(botHome(home, bot), "conversation.json"), messages.slice(-CONVERSATION_KEEP));
}

// Adds to what is on disk now. A turn that ran while a compaction finished must
// not write its older copy of the thread back over the summary.
export function appendConversation(home, bot, messages) {
  const next = [...readConversation(home, bot), ...messages];
  writeConversation(home, bot, next);
  return next.slice(-CONVERSATION_KEEP);
}

function archiveMessages(home, bot, messages) {
  const file = path.join(botHome(home, bot), "conversation-archive.ndjson");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const archivedAt = Date.now();
  fs.appendFileSync(file, messages.map((message) => JSON.stringify({ archivedAt, ...message, id: message.id || newId() })).join("\n") + "\n");
}

export function readDiffs(home, bot) {
  return readJson(path.join(botHome(home, bot), "diffs.json"), []);
}

export function writeDiffs(home, bot, diffs) {
  writeJson(path.join(botHome(home, bot), "diffs.json"), diffs.slice(-200));
}

export function publicBot(bot, { home, appUrl = "" } = {}) {
  return {
    id: bot.id,
    name: bot.name,
    job: bot.job,
    group: bot.group || "Personal",
    color: bot.color,
    avatar: normalizeAvatar(bot.avatar, bot.id),
    status: normalizeBotStatus(bot.status),
    pinned: Boolean(bot.pinned),
    pinnedOrder: Number(bot.pinnedOrder) || 0,
    main: Boolean(bot.main),
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    prompt: bot.prompt,
    memory: bot.memory,
    model: {
      provider: bot.model.provider,
      baseUrl: bot.model.baseUrl,
      username: bot.model.username,
      model: bot.model.model,
      agent: bot.model.agent,
      apiKeySet: Boolean(bot.model.apiKeySet),
      logo: modelLogo(bot.model),
      fallbacks: (bot.model.fallbacks || []).map((item) => ({ provider: item.provider, model: item.model, ...(item.connection ? { connection: item.connection } : {}), logo: modelLogo(item) })),
    },
    connectors: bot.connectors.map(publicConnector),
    jobs: bot.jobs.map(publicJob),
    vault: bot.vault.map(({ id, site, username, label, createdAt, lastUsedAt, source, externalId }) => ({ id, site, username, label, createdAt, lastUsedAt, source: source || "ravnir", externalId: externalId || "" })),
    policy: normalizePolicy(bot.policy),
    limits: normalizeLimits(bot.limits),
    notify: normalizeNotifyLevel(bot.notify),
    vaultNote: normalizeVaultNote(bot.vaultNote),
    vaultProjects: normalizeVaultProjects(bot.vaultProjects),
    skills: normalizeSkills(bot.skills),
    box: normalizeBox(bot.box),
    browser: normalizeBrowserNetwork(bot.browser),
    spec: publicSpec(bot.spec),
    stats: bot.stats,
    workspace: home ? workspacePath(home, bot) : "",
    appUrl,
  };
}

export function publicGroup(group, bots = []) {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    count: bots.filter((bot) => (bot.group || "Personal") === group.name).length,
  };
}

export function publicBotSummary(bot) {
  return {
    id: bot.id,
    name: bot.name,
    job: bot.job,
    group: bot.group || "Personal",
    color: bot.color,
    avatar: normalizeAvatar(bot.avatar, bot.id),
    status: normalizeBotStatus(bot.status),
    notify: normalizeNotifyLevel(bot.notify),
    pinned: Boolean(bot.pinned),
    pinnedOrder: Number(bot.pinnedOrder) || 0,
    main: Boolean(bot.main),
    updatedAt: bot.updatedAt,
    model: {
      provider: bot.model.provider,
      model: bot.model.model,
      configured: Boolean(bot.model.baseUrl && bot.model.model),
      logo: modelLogo(bot.model),
    },
    unread: false,
    busy: false,
    activity: "",
    lastActiveAt: bot.stats.lastActiveAt || 0,
    specStatus: bot.spec?.path ? bot.spec.status || "current" : "",
    nextJobAt: bot.jobs.filter((job) => job.enabled).map((job) => job.nextRunAt).filter(Boolean).sort()[0] || 0,
  };
}

export function publicConnector(connector) {
  return {
    id: connector.id,
    name: connector.name,
    transport: connector.transport,
    command: connector.command || "",
    args: connector.args || [],
    url: connector.url || "",
    enabled: connector.enabled !== false,
    status: connector.status || "new",
    error: connector.error || "",
    tools: connector.tools || [],
    envKeys: connector.envKeys || [],
    headerKeys: connector.headerKeys || [],
    checkedAt: connector.checkedAt || 0,
    // "plugin:<id>" for a plugin's connector: the MCP panel sends the user to the Plugins page instead of editing it.
    managed: typeof connector.managed === "string" ? connector.managed : connector.managed ? "ai-memory" : "",
  };
}

export function publicJob(job) {
  return {
    id: job.id,
    name: job.name,
    cron: job.cron || "",
    prompt: job.prompt,
    enabled: job.enabled !== false,
    createdAt: job.createdAt,
    lastRunAt: job.lastRunAt || 0,
    nextRunAt: job.nextRunAt || 0,
    lastStatus: job.lastStatus || "",
    lastSummary: job.lastSummary || "",
    runs: (job.runs || []).slice(-12),
    ...scheduleFields(job),
  };
}

export const NOTIFY_LEVELS = ["all", "important", "off"];

// "on" or "off" (paused). A paused agent still answers you; routines and messages from other agents are refused.
export function normalizeBotStatus(value) {
  return value === "off" ? "off" : "on";
}

export function normalizeNotifyLevel(value) {
  return NOTIFY_LEVELS.includes(value) ? value : "important";
}

// The skills an agent may open, by folder name. Lowercase and dashes, because that is the folder
// on disk; a name that does not fit is dropped rather than repaired into something surprising.
export function normalizeSkills(input) {
  const out = [];
  for (const value of Array.isArray(input) ? input : []) {
    const name = String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || out.includes(name)) continue;
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

// Which vault notes a bot reads as its own. Empty means "find it by name".
export function normalizeVaultNote(value) {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

export function normalizeVaultProjects(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.filter((item) => typeof item === "string").map((item) => item.trim().slice(0, 200)).filter(Boolean))].slice(0, 8);
}

export function defaultNotifySettings() {
  return { enabled: true, quietStart: "23:00", quietEnd: "08:00" };
}

// Quiet hours are HH:MM. Anything unreadable falls back to the default window.
export function normalizeNotifySettings(input) {
  const base = defaultNotifySettings();
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const clock = (value, fallback) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return fallback;
    return `${match[1].padStart(2, "0")}:${match[2]}`;
  };
  return {
    enabled: source.enabled !== false,
    quietStart: clock(source.quietStart, base.quietStart),
    quietEnd: clock(source.quietEnd, base.quietEnd),
  };
}

// Defaults for new agents (Settings, "New agents"). Never holds a secret: no API key or password lives here.
export const DEFAULT_PROVIDERS = ["opencode", "openai"];

export function normalizeDefaults(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const text = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
  let baseUrl = text(source.baseUrl, 300);
  if (baseUrl && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) baseUrl = "";
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      // Credentials in a URL are secrets; keep the address only.
      if (parsed.username || parsed.password) baseUrl = "";
    } catch {
      baseUrl = "";
    }
  }
  return {
    provider: DEFAULT_PROVIDERS.includes(source.provider) ? source.provider : "",
    baseUrl,
    username: text(source.username, 80),
    model: text(source.model, 200),
    // A picker choice: "opencode" (this server's OpenCode) or "server:<id>" (Settings, Models).
    via: /^(opencode|server:[A-Za-z0-9-]{1,40})$/.test(source.via || "") ? source.via : "",
    group: text(source.group, 40),
    notify: NOTIFY_LEVELS.includes(source.notify) ? source.notify : "",
  };
}

export function normalizeSettings(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    ...source,
    notify: normalizeNotifySettings(source.notify),
    defaults: normalizeDefaults(source.defaults),
    owner: normalizeOwner(source.owner),
    vault: { layout: LAYOUT_CHOICES.includes(source.vault?.layout) ? source.vault.layout : "auto" },
    setup: normalizeSetup(source.setup),
  };
}

// First run: { needed: true } on a fresh install until the wizard is finished or skipped.
function normalizeSetup(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (source.done) return { done: true, at: Number(source.at) || 0 };
  return source.needed ? { needed: true } : { done: true, at: 0 };
}

export function normalizeModel(model) {
  return {
    provider: model.provider === "openai" ? "openai" : "opencode",
    baseUrl: cleanLine(model.baseUrl) || "http://127.0.0.1:4096",
    username: cleanLine(model.username) || "opencode",
    model: cleanLine(model.model) || "",
    agent: cleanLine(model.agent) || "",
    // "server:<id>" when the model comes from an OpenAI-compatible server added in Settings, Models.
    ...(/^server:[A-Za-z0-9-]{1,40}$/.test(model.connection || "") ? { connection: model.connection } : {}),
    // Backup models the turn moves to when this one fails at the provider (server/fallback.js).
    ...(Array.isArray(model.fallbacks) && model.fallbacks.length
      ? { fallbacks: model.fallbacks.filter((item) => item && cleanLine(item.model)).slice(0, 3).map((item) => normalizeModel({ ...item, fallbacks: [] })) }
      : {}),
  };
}

function normalizeBot(bot, home, secrets) {
  bot.id ||= newId();
  bot.name = cleanName(bot.name) || "Bot";
  bot.job = cleanLine(bot.job) || "A persistent teammate on this server.";
  bot.group = cleanLine(bot.group) || "Personal";
  bot.color ||= COLORS[0];
  bot.avatar = migrateAvatar(bot);
  bot.status = normalizeBotStatus(bot.status);
  bot.pinned = Boolean(bot.pinned);
  bot.pinnedOrder = Number.isFinite(Number(bot.pinnedOrder)) ? Number(bot.pinnedOrder) : 0;
  bot.main = Boolean(bot.main);
  bot.createdAt ||= Date.now();
  bot.updatedAt ||= bot.createdAt;
  bot.prompt ||= SCOUT_INSTRUCTIONS;
  bot.memory ||= [];
  bot.memory = bot.memory.slice(-80);
  bot.model = normalizeModel(bot.model || {});
  bot.remote ||= {};
  bot.connectors ||= [];
  bot.jobs ||= [];
  bot.vault ||= [];
  bot.policy = normalizePolicy(bot.policy);
  bot.limits = normalizeLimits(bot.limits);
  bot.notify = normalizeNotifyLevel(bot.notify);
  bot.skills = normalizeSkills(bot.skills);
  bot.vaultNote = normalizeVaultNote(bot.vaultNote);
  bot.vaultProjects = normalizeVaultProjects(bot.vaultProjects);
  bot.stats ||= { turns: 0, lastActiveAt: 0, lastError: "" };
  for (const job of bot.jobs) {
    job.id ||= newId();
    job.enabled = job.enabled !== false;
    job.runs ||= [];
    if (Number(job.at)) {
      // A one-time job runs at its time while it is armed, never again after.
      // One still claimed at boot never finished its run (a crash), so it is armed again.
      if (job.claimedAt) {
        job.enabled = true;
        job.done = false;
        job.claimedAt = 0;
      }
      job.cron = "";
      job.nextRunAt = job.enabled && !job.done ? Number(job.at) : 0;
    } else if (!job.nextRunAt) {
      try {
        job.nextRunAt = nextCron(job.cron) || 0;
      } catch {
        job.nextRunAt = 0;
      }
    }
  }
  if (secrets) {
    const key = secrets.get(`bot:${bot.id}:apiKey`, "");
    bot.model.apiKeySet = Boolean(key);
  }
  ensureBotHome(home, bot);
}

function migrateLegacy({ home, secrets, projectRoot }) {
  const legacyFile = path.join(home, "config.json");
  if (!fs.existsSync(legacyFile)) return null;
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    const old = legacy.bots || {};
    const shared = {
      provider: "opencode",
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      model: "",
      agent: "",
    };
    const bots = defaultBots(shared);
    const assignments = [
      ["Scout", old.assistant],
      ["Builder", old.coding],
    ];
    for (const [name, source] of assignments) {
      const bot = bots.find((item) => item.name === name);
      if (!source || !bot) continue;
      bot.model = normalizeModel({
        provider: source.provider,
        baseUrl: source.baseUrl || shared.baseUrl,
        username: source.username || "opencode",
        model: source.model || "",
        agent: source.agent || "",
      });
      if (source.apiKey) secrets.set(`bot:${bot.id}:apiKey`, source.apiKey);
      bot.model.apiKeySet = Boolean(source.apiKey);
    }
    const homeDir = legacy.workspace;
    if (homeDir && fs.existsSync(homeDir) && projectRoot && path.resolve(homeDir) !== path.resolve(path.join(projectRoot, "workspace"))) {
      // Keep the old location visible as a note in the bot's workspace rather than guessing a copy.
      const builder = bots.find((item) => item.name === "Builder");
      ensureBotHome(home, builder);
      fs.writeFileSync(path.join(workspacePath(home, builder), "MIGRATED-WORKSPACE.txt"), `The previous harness used this workspace:\n${homeDir}\n\nCopy anything you need into this folder. Ravnir gives each bot its own computer.\n`);
    }
    return { version: STATE_VERSION, server: { name: "Ravnir", createdAt: Date.now() }, bots };
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function cleanLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

function cleanName(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 40) : "";
}

// Avatar: a living object, see public/avatar.js and docs/avatars.md. Unknown parts fall back to
// a look derived from the seed. color "" means the bot's own color; pass it as `color` to store it.
export function normalizeAvatar(input, seed = "", color = "") {
  return Avatars.normalize(input, { seed: String(seed || ""), color });
}

// A first look that says what the agent does ("Match the job" in the studio).
export function suggestAvatar({ name = "", job = "", seed = "" } = {}) {
  return Avatars.suggest({ name: String(name || ""), job: String(job || ""), seed: String(seed || name || "") });
}

// Avatars from before faces keep their body, material, color and mark, and get a face,
// accessory and personality that match the agent's job.
function migrateAvatar(bot) {
  const old = bot.avatar && typeof bot.avatar === "object" && !Array.isArray(bot.avatar) ? bot.avatar : null;
  if (old?.face) return normalizeAvatar(old, bot.id);
  const look = suggestAvatar({ name: bot.name, job: bot.job, seed: bot.id });
  if (!old) return look;
  const kept = Object.fromEntries(["shape", "mark"].filter((key) => old[key]).map((key) => [key, old[key]]));
  const material = old.material === "glass" || old.material === "matte" ? old.material : look.material;
  return normalizeAvatar({ ...look, ...kept, material, color: old.color || "" }, bot.id);
}

