import { attachedTo, discover, skillRoom } from "./skills.js";
import { rank } from "./match.js";

// An agent can look through the Skills shop and the plugin catalog and ask the user for what it is
// missing ("I should have the SEO audit skill", "plug me into Vercel"). Each ask is a proposal
// (server/proposals.js) of kind "skill" or "plugin": the user sees a card under the reply and in
// Home, and nothing changes until they press Add. A dismissed ask stays quiet for a month.

export const DISMISS_DAYS = 30;
const DAY = 86_400_000;
const OPEN_PER_BOT = 5;

export function recommendToolDefinitions() {
  return [
    {
      name: "find_skills",
      description: "Search the Skills shop on this server: tested procedures you can be given (writing, research, finance, engineering, design and more). Each match says whether you already have it. Write the query in English, the catalog is in English. An empty query lists the whole shop. It needs no approval.",
      parameters: objectSchema({
        query: { type: "string", description: "What the procedure is for, for example: spreadsheet model, SEO audit, code review." },
        limit: { type: "number", description: "Maximum results, 1-20. Defaults to 8." },
      }, []),
    },
    {
      name: "suggest_skill",
      description: "Ask the user to give you a skill from the Skills shop. They get a card with Add skill and Dismiss, under your reply and in Home. Once added, it is in your skill list from your next message. Use it when a skill clearly fits what the user needs from you; one suggestion per turn.",
      parameters: objectSchema({
        name: { type: "string", description: "The skill's name from find_skills." },
        why: { type: "string", maxLength: 300, description: "What it would let you do for the user, tied to what they asked. One or two plain sentences." },
      }, ["name", "why"]),
    },
    {
      name: "find_plugins",
      description: "Search the plugin catalog: apps and services the user can connect on the Plugins page (GitHub, Gmail, Notion, Stripe, Vercel and hundreds more). Each match says whether it is connected on this server, whether you have it, and which teammates have it. It needs no approval.",
      parameters: objectSchema({
        query: { type: "string", description: "The app, service or job, for example: vercel, calendar, invoices, issue tracker." },
        limit: { type: "number", description: "Maximum results, 1-20. Defaults to 8." },
      }, ["query"]),
    },
    {
      name: "suggest_plugin",
      description: "Ask the user to plug you into a plugin from the catalog. They get a card under your reply and in Home: Plug in when it is already connected on this server, Connect when it is not (you get it as soon as they sign in). Use it when a task needs that app; one suggestion per turn. If a teammate already has it, ask the teammate instead.",
      parameters: objectSchema({
        id: { type: "string", description: "The plugin id from find_plugins." },
        why: { type: "string", maxLength: 300, description: "What you would do with it for the user. One or two plain sentences." },
      }, ["id", "why"]),
    },
  ];
}

export const RECOMMEND_TOOLS = new Set(recommendToolDefinitions().map((tool) => tool.name));

// ---- Skills ----

function whenToUse(body) {
  const match = /##\s*When to Use\s*\n([\s\S]*?)(?:\n##\s|$)/i.exec(String(body || ""));
  return match ? match[1].slice(0, 800) : "";
}

const skillFields = (entry) => [
  [`${entry.name.replace(/-/g, " ")} ${entry.title}`, 4],
  [entry.description, 3],
  [entry.category, 2],
  [whenToUse(entry.body), 1],
];

export function findSkills(bot, args = {}, { root } = {}) {
  const found = discover(root);
  const shop = found.filter((entry) => !entry.default);
  const has = new Set(attachedTo(bot, { root }).map((entry) => entry.name));
  const limit = clampLimit(args.limit, shop.length || 1);
  const query = String(args.query || "").trim();
  const rows = query
    ? rank(query, shop, skillFields, { limit }).map((row) => row.item)
    : shop.slice(0, Math.max(limit, Math.min(40, shop.length)));
  const line = (entry) => `- ${entry.name} (${entry.category || "general"}): ${entry.description || entry.title}${has.has(entry.name) ? " [you have it]" : ""}`;
  const room = skillRoom(found);
  const used = (bot.skills || []).filter((name) => found.some((entry) => entry.name === name && !entry.default)).length;
  const roomLine = used >= room
    ? `You hold ${used} skills, the most an agent can. To suggest a new one, say in your reply which of yours it would replace.`
    : `You can hold ${room - used} more.`;
  if (!rows.length) {
    const shelves = [...new Set(shop.map((entry) => entry.category).filter(Boolean))].join(", ");
    return { text: `No skill in the shop matches "${query}". Shelves: ${shelves || "none"}. Try other words, or an empty query to list the whole shop.`, activity: "Looking through the Skills shop" };
  }
  const head = query ? `${rows.length} skill${rows.length === 1 ? "" : "s"} match "${query}":` : `The Skills shop has ${shop.length} skills:`;
  return {
    text: `${head}\n${rows.map(line).join("\n")}\n${roomLine} Ask for one with suggest_skill when it fits what the user needs.`,
    activity: "Looking through the Skills shop",
  };
}

export async function suggestSkill(args, ctx, { root } = {}) {
  const { bot, proposals } = ctx;
  if (!proposals) throw new Error("Suggestions are not available on this server.");
  const name = String(args.name || "").trim().toLowerCase();
  const found = discover(root);
  const entry = found.find((item) => item.name === name);
  if (!entry) {
    const close = rank(name.replace(/-/g, " "), found.filter((item) => !item.default), skillFields, { limit: 3 }).map((row) => row.item.name);
    throw new Error(`There is no skill called ${name || "(none)"}.${close.length ? ` Closest: ${close.join(", ")}.` : ""} Use find_skills to see the names.`);
  }
  if (entry.default || (bot.skills || []).includes(entry.name)) {
    return { text: `You already have ${entry.name}. Open it with skill_view.` };
  }
  const known = new Set(found.map((item) => item.name));
  const used = (bot.skills || []).filter((item) => known.has(item)).length;
  if (used >= skillRoom(found)) {
    throw new Error(`You already hold ${used} skills, the most an agent can. Tell the user in your reply which of your skills ${entry.name} should replace; they can swap it in your Setup, Skills tab.`);
  }
  const guard = checkRepeat(ctx, "skill", entry.name);
  if (guard) return guard;
  const record = proposals.create({
    botId: bot.id,
    botName: bot.name,
    kind: "skill",
    title: `Add the ${entry.title} skill`,
    why: cleanWhy(args.why),
    prompt: entry.description || entry.title,
    change: { skill: entry.name },
    turnId: turnOf(ctx),
  });
  return delivered(ctx, record, `Suggested. The user sees a card to add ${entry.name}; it is yours from your next message once they do. Mention it in one line in your reply, then carry on with what you can do without it.`);
}

// ---- Plugins ----

const pluginFields = (entry) => [
  [`${entry.id.replace(/[-_.]/g, " ")} ${entry.name}`, 4],
  [entry.tags.join(" "), 2],
  [entry.category, 2],
  [entry.description, 1],
];

// Why a plugin cannot be connected on this server right now, or "" when it can.
export function pluginBlocker(plugins, entry) {
  if (plugins.connections[entry.id]) return "";
  if (entry.comingSoon) return "not available yet";
  if (entry.auth === "unreachable") return "its service does not answer right now";
  if (entry.requiresVolumes) return "needs folders on the server, not supported";
  if (entry.kind === "container" && !plugins.runtime().bin) return "needs a container runtime this server does not have";
  return "";
}

function pluginStatus(plugins, state, bot, entry) {
  const connection = plugins.connections[entry.id];
  const blocker = pluginBlocker(plugins, entry);
  const holders = (connection?.bots || [])
    .filter((id) => id !== bot.id)
    .map((id) => state.bots.find((item) => item.id === id)?.name)
    .filter(Boolean);
  const parts = [
    connection ? (connection.bots.includes(bot.id) ? "connected, you have it" : "connected, you do not have it") : blocker || "not connected yet",
  ];
  if (holders.length) parts.push(`teammates with it: ${holders.join(", ")}`);
  return parts.join("; ");
}

export function findPlugins(bot, args, { plugins, state }) {
  if (!plugins) throw new Error("Plugins are not available on this server.");
  const query = String(args.query || "").trim();
  if (!query) throw new Error("Say what to look for: an app, a service or a job.");
  const entries = plugins.catalog().plugins;
  const limit = clampLimit(args.limit, 20);
  // Connected and featured plugins come first on a tie: the user already uses them, or they are known to work.
  const ordered = [
    ...entries.filter((entry) => plugins.connections[entry.id]),
    ...entries.filter((entry) => !plugins.connections[entry.id] && entry.featured),
    ...entries.filter((entry) => !plugins.connections[entry.id] && !entry.featured),
  ];
  const rows = rank(query, ordered, pluginFields, { limit }).map((row) => row.item);
  if (!rows.length) return { text: `No plugin in the catalog matches "${query}". Try the app's name or other words.`, activity: "Looking through plugins" };
  const line = (entry) => `- ${entry.id} | ${entry.name}: ${clip(entry.description, 140)} | ${pluginStatus(plugins, state, bot, entry)}`;
  return {
    text: `${rows.length} plugin${rows.length === 1 ? "" : "s"} match "${query}":\n${rows.map(line).join("\n")}\nIf a teammate has the one you need, ask them with ask_team or message_bot. Otherwise ask the user for it with suggest_plugin.`,
    activity: "Looking through plugins",
  };
}

export async function suggestPlugin(args, ctx) {
  const { bot, proposals, plugins, state } = ctx;
  if (!proposals || !plugins) throw new Error("Suggestions are not available on this server.");
  const id = String(args.id || "").trim();
  const entries = plugins.catalog().plugins;
  const entry = entries.find((item) => item.id === id) || entries.find((item) => item.id.toLowerCase() === id.toLowerCase() || item.name.toLowerCase() === id.toLowerCase());
  if (!entry) {
    const close = rank(id, entries, pluginFields, { limit: 3 }).map((row) => row.item.id);
    throw new Error(`There is no plugin with the id ${id || "(none)"}.${close.length ? ` Closest: ${close.join(", ")}.` : ""} Use find_plugins to see the ids.`);
  }
  const connection = plugins.connections[entry.id];
  if (connection?.bots.includes(bot.id)) return { text: `You already have ${entry.name}. Its tools are in your tool list.` };
  const blocker = pluginBlocker(plugins, entry);
  if (blocker) throw new Error(`${entry.name} cannot be connected on this server: ${blocker}.`);
  const guard = checkRepeat(ctx, "plugin", entry.id);
  if (guard) return guard;
  const record = proposals.create({
    botId: bot.id,
    botName: bot.name,
    kind: "plugin",
    title: connection ? `Plug in ${entry.name}` : `Connect ${entry.name}`,
    why: cleanWhy(args.why),
    prompt: entry.description || entry.name,
    change: { plugin: entry.id },
    turnId: turnOf(ctx),
  });
  const how = connection
    ? `${entry.name} is already connected on this server, so one tap gives it to you.`
    : `${entry.name} is not connected yet: the user signs in once on the Plugins page and you get it.`;
  return delivered(ctx, record, `Suggested. ${how} Mention it in one line in your reply, then carry on with what you can do without it.`);
}

// ---- Shared ----

function checkRepeat(ctx, kind, key) {
  const { bot, proposals } = ctx;
  const same = (item) => item.botId === bot.id && item.kind === kind && changeKey(item) === key;
  const mine = proposals.list({}).filter((item) => item.botId === bot.id);
  if (mine.some((item) => item.status === "open" && same(item))) return { text: "That suggestion is already waiting for the user. Do not suggest it again." };
  const dismissed = mine.find((item) => item.status === "dismissed" && same(item) && Date.now() - item.decidedAt < DISMISS_DAYS * DAY);
  if (dismissed) {
    const until = new Date(dismissed.decidedAt + DISMISS_DAYS * DAY).toISOString().slice(0, 10);
    return { text: `The user dismissed this suggestion on ${new Date(dismissed.decidedAt).toISOString().slice(0, 10)}. Do not suggest it again before ${until} unless they ask for it.` };
  }
  const turnId = turnOf(ctx);
  if (turnId && mine.some((item) => item.turnId === turnId && (item.kind === "skill" || item.kind === "plugin"))) {
    return { text: "You already made a suggestion in this turn. One per turn: keep the rest for later, when it matters." };
  }
  if (mine.filter((item) => item.status === "open").length >= OPEN_PER_BOT) {
    throw new Error(`You already have ${OPEN_PER_BOT} suggestions waiting. Let the user decide on those first.`);
  }
  return null;
}

async function delivered(ctx, record, text) {
  ctx.engine?.noteSuggestion?.(ctx.bot, record);
  await ctx.notifications?.notify({
    botId: ctx.bot.id,
    botName: ctx.bot.name,
    kind: "proposal",
    title: `${ctx.bot.name}: ${record.title}`,
    body: record.why,
    url: "/?view=today",
    tag: `proposal-${record.id}`,
  });
  return { text, activity: record.kind === "skill" ? "Suggesting a skill" : "Suggesting a plugin" };
}

export function changeKey(proposal) {
  if (proposal?.kind === "skill") return String(proposal.change?.skill || "");
  if (proposal?.kind === "plugin") return String(proposal.change?.plugin || "");
  return "";
}

// A suggestion is settled when what it asked for happened some other way (the skill added from the
// shop, the plugin given from the Plugins page), or its agent is gone.
export function settleSuggestions({ proposals, state, plugins }) {
  for (const item of proposals.list({ status: "open" })) {
    if (item.kind !== "skill" && item.kind !== "plugin") continue;
    const bot = state.bots.find((entry) => entry.id === item.botId);
    if (!bot) {
      proposals.decide(item.id, "dismiss");
      continue;
    }
    const done = item.kind === "skill"
      ? (bot.skills || []).includes(item.change?.skill)
      : Boolean(plugins?.connections[item.change?.plugin]?.bots.includes(bot.id));
    if (done) proposals.decide(item.id, "accept");
  }
}

// What a card needs to show for a skill or plugin suggestion, read live.
export function decorateSuggestion(proposal, { plugins, root } = {}) {
  if (proposal.kind === "skill") {
    const entry = discover(root).find((item) => item.name === proposal.change?.skill);
    return entry
      ? { ...proposal, skill: { name: entry.name, title: entry.title, description: entry.description, category: entry.category, license: entry.license } }
      : { ...proposal, skill: { name: proposal.change?.skill || "", missing: true } };
  }
  if (proposal.kind === "plugin" && plugins) {
    const entry = plugins.catalog().plugins.find((item) => item.id === proposal.change?.plugin);
    if (!entry) return { ...proposal, plugin: { id: proposal.change?.plugin || "", missing: true } };
    return {
      ...proposal,
      plugin: {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        icon: entry.icon ? `/plugins/${entry.icon.replace(/^\/+/, "")}` : "",
        connected: Boolean(plugins.connections[entry.id]),
        blocker: pluginBlocker(plugins, entry),
      },
    };
  }
  return proposal;
}

function turnOf(ctx) {
  return ctx.engine?.active?.get(ctx.bot.id)?.turnId || "";
}

function cleanWhy(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function clampLimit(value, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, 20, max) : Math.min(8, max);
}

function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}
