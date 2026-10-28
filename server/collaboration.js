import crypto from "node:crypto";
import { formatSearch, formatWindow, readArchiveWindow, searchArchive } from "./compaction.js";
import { rank } from "./match.js";
import { discover } from "./skills.js";
import { createBot, ensureBotHome, ensureGroups, readConversation, writeConversation } from "./state.js";

export { ensureGroups };

export const MAX_BOTS = 60;
export const MAX_GROUP_NAME = 40;
export const MAX_BOT_MESSAGE = 8_000;
export const MAX_CHAIN = 5;
// How long message_bot with wait holds the caller's turn. Agents on big models take two to four
// minutes; a reply that takes longer still reaches the caller (TurnEngine.relayReply).
export const REPLY_WAIT_MS = 240_000;
// When the user is waiting in chat or voice, the caller waits less: its reply should not sit behind
// another agent's whole turn, and the late answer reaches it anyway. RAVNIR_REPLY_WAIT_CHAT_MS changes it.
export const REPLY_WAIT_CHAT_MS = 90_000;
// ask_team tries the best-placed teammates in turn until one answers; this many at most.
export const MAX_ASKED = 3;
// A teammate that cannot answer a routed question replies with this marker (stripped from its thread).
export const PASS = /^\s*\[\[\s*pass\s*\]\]/i;

function replyWaitMs(engine, botId) {
  const source = engine.currentSource?.(botId) || "";
  if (source !== "chat" && source !== "voice") return REPLY_WAIT_MS;
  return Number(process.env.RAVNIR_REPLY_WAIT_CHAT_MS) || REPLY_WAIT_CHAT_MS;
}

export function createGroup(state, name) {
  const clean = cleanGroup(name);
  if (!clean) throw new Error("A group name is required.");
  const existing = (state.groups || []).find((group) => group.name.toLowerCase() === clean.toLowerCase());
  if (existing) return { group: existing, created: false };
  const group = { id: crypto.randomUUID(), name: clean, createdAt: Date.now() };
  state.groups ||= [];
  state.groups.push(group);
  return { group, created: true };
}

export function renameGroup(state, id, name) {
  const group = (state.groups || []).find((item) => item.id === id);
  if (!group) throw new Error("Unknown group.");
  const clean = cleanGroup(name);
  if (!clean) throw new Error("A group name is required.");
  const clash = (state.groups || []).find((item) => item.id !== id && item.name.toLowerCase() === clean.toLowerCase());
  if (clash) throw new Error(`The group "${clash.name}" already exists.`);
  const previous = group.name;
  group.name = clean;
  for (const bot of state.bots) {
    if ((bot.group || "Personal") === previous) bot.group = clean;
  }
  return group;
}

export function deleteGroup(state, id) {
  const group = (state.groups || []).find((item) => item.id === id);
  if (!group) throw new Error("Unknown group.");
  const moved = state.bots.filter((bot) => (bot.group || "Personal") === group.name);
  for (const bot of moved) bot.group = "Personal";
  state.groups = state.groups.filter((item) => item.id !== id);
  return { moved: moved.length };
}

export function resolveBot(state, query, excludeId = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return null;
  const bots = state.bots.filter((bot) => bot.id !== excludeId);
  return bots.find((bot) => bot.id === query)
    || bots.find((bot) => bot.name.toLowerCase() === needle)
    || bots.find((bot) => bot.name.toLowerCase().startsWith(needle))
    || bots.find((bot) => `${bot.name} ${bot.job} ${bot.group}`.toLowerCase().includes(needle))
    || null;
}

export function collaborationToolDefinitions() {
  return [
    {
      name: "list_bots",
      description: "List the bots on this server, their groups, jobs, whether they are busy, and how many routines each has. Marks the main bot. Use this before messaging or organising teammates.",
      parameters: objectSchema({ group: { type: "string", description: "Only bots in this group." } }, []),
    },
    {
      name: "message_bot",
      description: "Send a message to another bot on this server. The other bot runs a full turn in its own thread with its own tools. Set wait to true when you need the reply: you get it in this turn, or, when the other bot takes longer (about a minute and a half when the user is waiting in chat, four minutes otherwise), as a new message in your thread with a turn to act on it.",
      parameters: objectSchema({
        bot: { type: "string", description: "Bot name or id." },
        text: { type: "string", description: "The message. Include every detail the other bot needs; it cannot see your thread." },
        wait: { type: "boolean", description: "Wait for the other bot's reply instead of only confirming delivery." },
      }, ["bot", "text"]),
    },
    {
      name: "ask_team",
      description: "Ask the team a question you cannot answer yourself, or a task you cannot do with your own tools and access. Ravnir picks the teammates whose job, skills and plugins fit best and asks them one at a time; a teammate that cannot help passes and the next one is asked. You get the first real answer and who gave it. Use it before telling the user you do not know or cannot. Name a bot only when you already know who should answer.",
      parameters: objectSchema({
        question: { type: "string", description: "The question or task, with every detail a teammate needs; they cannot see your thread." },
        context: { type: "string", description: "Optional: what you already know or tried, so nobody repeats it." },
        bot: { type: "string", description: "Optional: the teammate to ask first, by name. Others are asked if it passes." },
      }, ["question"]),
    },
    {
      name: "broadcast",
      description: "Send the same message to every bot in a group, or to every bot on the server. Delivery is asynchronous.",
      parameters: objectSchema({
        text: { type: "string" },
        group: { type: "string", description: "Limit to this group. Omit to message every bot except yourself." },
      }, ["text"]),
    },
    {
      name: "create_bot",
      description: "Create a new persistent bot on this server. It gets its own workspace, browser, and conversation. Use it when a job needs a dedicated teammate.",
      parameters: objectSchema({
        name: { type: "string" },
        job: { type: "string", description: "One sentence describing what the bot is for." },
        group: { type: "string", description: "Existing or new group name." },
        instructions: { type: "string", description: "Optional standing instructions for the new bot." },
        model: { type: "string", description: "Optional model id. Defaults to your own model." },
      }, ["name", "job"]),
    },
    {
      name: "update_bot",
      description: "Change another bot's name, job, group, or standing instructions. You cannot delete a bot.",
      parameters: objectSchema({
        bot: { type: "string" },
        name: { type: "string" },
        job: { type: "string" },
        group: { type: "string" },
        instructions: { type: "string" },
      }, ["bot"]),
    },
    {
      name: "list_groups",
      description: "List groups and how many bots are in each.",
      parameters: objectSchema({}, []),
    },
    {
      name: "create_group",
      description: "Create a group for organising bots. Groups are just names; bots can be moved into them with update_bot.",
      parameters: objectSchema({ name: { type: "string" } }, ["name"]),
    },
    {
      name: "compact_conversation",
      description: "Compact your own long conversation into a summary. The full history is archived. Use it when the thread has grown very long.",
      parameters: objectSchema({}, []),
    },
    {
      name: "search_history",
      description: "Search your own archived conversation history: everything compaction removed from your thread, tool outputs included. Every word in the query must match (case-insensitive). Returns message ids with a short snippet, newest first. Use read_history to get the exact wording.",
      parameters: objectSchema({
        query: { type: "string", description: "Words to find. All of them must appear in the message." },
        limit: { type: "number", description: "Maximum results, 1-20. Defaults to 10." },
      }, ["query"]),
    },
    {
      name: "read_history",
      description: "Read one archived message by id, plus up to 5 messages before and after it. Get ids from search_history or from your compacted summary.",
      parameters: objectSchema({
        id: { type: "string", description: "Message id from search_history or the summary." },
        before: { type: "number", description: "Earlier messages to include, 0-5. Defaults to 2." },
        after: { type: "number", description: "Later messages to include, 0-5. Defaults to 2." },
      }, ["id"]),
    },
  ];
}

export async function callCollaborationTool(name, args, ctx) {
  const { bot, state, engine } = ctx;
  if (name === "list_bots") {
    const group = cleanGroup(args.group);
    const bots = state.bots.filter((item) => !group || (item.group || "Personal").toLowerCase() === group.toLowerCase());
    if (!bots.length) return { text: group ? `No bots in ${group}.` : "No bots." };
    // The header says the list is complete, so names found in notes or scripts are not taken for agents.
    const count = `${bots.length} agent${bots.length === 1 ? "" : "s"}`;
    const header = group ? `${count} in ${group}.` : `${count} on this server. This is the whole roster; names found elsewhere (notes, scripts) are not agents.`;
    const rows = bots.map((item) => {
      const runtime = engine.status(item.id);
      const tag = [item.id === bot.id ? "you" : "", item.main ? "main" : ""].filter(Boolean).join(", ");
      const live = (item.jobs || []).filter((job) => !job.done);
      const on = live.filter((job) => job.enabled).length;
      return `- ${item.name}${tag ? ` (${tag})` : ""} | ${item.group || "Personal"} | ${runtime.busy ? "working" : isPaused(item) ? "paused" : "on"} | ${item.job} | routines: ${on} on, ${live.length - on} paused`;
    });
    return { text: [header, ...rows].join("\n") };
  }
  if (name === "message_bot") {
    const target = resolveBot(state, args.bot, bot.id);
    if (!target) throw new Error(`No other bot matches "${args.bot}". Use list_bots to see the roster.`);
    const text = cleanText(args.text, MAX_BOT_MESSAGE);
    if (!text) throw new Error("The message is empty.");
    if (isPaused(target)) throw new Error(pausedNote(target));
    const chain = Array.isArray(ctx.chain) ? ctx.chain : [];
    if (chain.includes(target.id)) throw new Error("That would create a messaging loop between bots. Reply to the current message instead.");
    if (chain.length >= MAX_CHAIN) throw new Error("This bot-to-bot chain is too deep.");
    const startedAt = Date.now();
    const { promise } = engine.enqueue(target, {
      text,
      source: "bot",
      fromBotId: bot.id,
      fromBotName: bot.name,
      chain: [...chain, bot.id],
    });
    promise.catch(() => {});
    if (args.wait !== true || chain.length >= 2) {
      return { text: `Delivered to ${target.name}. It will answer in its own thread.`, activity: `Messaging ${target.name}` };
    }
    const finished = await waitForTurn(promise, ctx.waitMs ?? replyWaitMs(engine, bot.id));
    if (finished) {
      const reply = latestReply(ctx.home, target, startedAt);
      return { text: reply ? `Reply from ${target.name}:\n${reply}` : `${target.name} finished without a written reply. Look at its thread if you need details.`, activity: `Waiting for ${target.name}` };
    }
    // Still working: the answer comes back on its own once it lands, so the caller does not ask twice.
    engine.relayReply?.(bot, target, { promise, startedAt, asked: text });
    return {
      text: `${target.name} is still working on it. Its reply will come to your thread as a new message, and you will get a turn to act on it. Do not ask ${target.name} again; tell the user it is in progress or carry on with something else.`,
      activity: `Waiting for ${target.name}`,
    };
  }
  if (name === "ask_team") return askTeam(args, ctx);
  if (name === "broadcast") {
    const group = cleanGroup(args.group);
    const text = cleanText(args.text, MAX_BOT_MESSAGE);
    if (!text) throw new Error("The message is empty.");
    const chain = Array.isArray(ctx.chain) ? ctx.chain : [];
    const everyone = state.bots.filter((item) => item.id !== bot.id && (!group || (item.group || "Personal").toLowerCase() === group.toLowerCase()));
    if (!everyone.length) throw new Error(group ? `No other bots in ${group}.` : "There are no other bots.");
    const paused = everyone.filter(isPaused);
    const targets = everyone.filter((item) => !isPaused(item));
    if (!targets.length) throw new Error(`${paused.map((item) => item.name).join(", ")} ${paused.length === 1 ? "is" : "are"} paused, so nobody got your message.`);
    for (const target of targets.slice(0, 25)) {
      if (chain.includes(target.id)) continue;
      engine.enqueue(target, {
        text,
        source: "bot",
        fromBotId: bot.id,
        fromBotName: bot.name,
        chain: [...chain, bot.id],
      }).promise.catch(() => {});
    }
    const skipped = paused.length ? ` Not sent to ${paused.map((item) => item.name).join(", ")} (paused).` : "";
    return { text: `Sent to ${targets.slice(0, 25).map((item) => item.name).join(", ")}.${skipped}`, activity: "Broadcasting to the team" };
  }
  if (name === "create_bot") {
    if (state.bots.length >= MAX_BOTS) throw new Error(`This server already has ${MAX_BOTS} bots.`);
    const newName = cleanText(args.name, 40);
    if (!newName) throw new Error("A bot name is required.");
    if (state.bots.some((item) => item.name.toLowerCase() === newName.toLowerCase())) throw new Error(`A bot named ${newName} already exists.`);
    const group = cleanGroup(args.group) || "Personal";
    createGroup(state, group);
    const model = { ...bot.model };
    if (typeof args.model === "string" && args.model.trim()) model.model = args.model.trim().slice(0, 300);
    const created = createBot({
      name: newName,
      job: cleanText(args.job, 300) || "A persistent teammate on this server.",
      group,
      color: bot.color,
      prompt: typeof args.instructions === "string" && args.instructions.trim() ? args.instructions.trim() : undefined,
      model,
    });
    const inheritedKey = ctx.secrets?.get(`bot:${bot.id}:apiKey`, "");
    if (inheritedKey) {
      ctx.secrets.set(`bot:${created.id}:apiKey`, inheritedKey);
      created.model.apiKeySet = true;
    }
    ensureBotHome(ctx.home, created);
    state.bots.push(created);
    const intro = {
      id: crypto.randomUUID(),
      role: "assistant",
      kind: "intro",
      content: `I'm ${created.name}. I'm on. ${created.job} ${bot.name} created me, and my computer is ready on this server.`,
      at: Date.now(),
    };
    writeConversation(ctx.home, created, [intro]);
    await ctx.provisionBot?.(created);
    ctx.save();
    return { text: `Created ${created.name} in ${group}. Its id is ${created.id}. It uses ${created.model.model || "the server default model"}.`, activity: `Creating ${created.name}` };
  }
  if (name === "update_bot") {
    const target = args.bot === "me" ? bot : resolveBot(state, args.bot, "");
    if (!target) throw new Error(`No bot matches "${args.bot}".`);
    const changes = [];
    if (typeof args.name === "string" && args.name.trim() && args.name.trim() !== target.name) {
      const nextName = cleanText(args.name, 40);
      if (state.bots.some((item) => item.id !== target.id && item.name.toLowerCase() === nextName.toLowerCase())) {
        throw new Error(`A bot named ${nextName} already exists.`);
      }
      changes.push(`name ${target.name} -> ${nextName}`);
      target.name = nextName;
    }
    if (typeof args.job === "string" && args.job.trim()) {
      target.job = cleanText(args.job, 300);
      changes.push("job");
    }
    if (typeof args.group === "string" && args.group.trim()) {
      const group = cleanGroup(args.group);
      createGroup(state, group);
      target.group = group;
      changes.push(`group ${group}`);
    }
    if (typeof args.instructions === "string" && args.instructions.trim()) {
      target.prompt = args.instructions.slice(0, 32_000);
      changes.push("instructions");
    }
    if (!changes.length) return { text: "Nothing changed." };
    target.updatedAt = Date.now();
    ctx.save();
    return { text: `Updated ${target.name}: ${changes.join(", ")}.` };
  }
  if (name === "list_groups") {
    ensureGroups(state);
    const rows = state.groups.map((group) => {
      const count = state.bots.filter((item) => (item.group || "Personal") === group.name).length;
      return `- ${group.name}: ${count} bot${count === 1 ? "" : "s"}`;
    });
    return { text: rows.join("\n") };
  }
  if (name === "create_group") {
    const result = createGroup(state, args.name);
    ctx.save();
    return { text: result.created ? `Created group ${result.group.name}.` : `Group ${result.group.name} already exists.` };
  }
  if (name === "compact_conversation") {
    if (!ctx.compact) throw new Error("Compaction is not available on this server.");
    const result = await ctx.compact(bot);
    return { text: result.compacted ? `Compacted ${result.removed} older messages into a summary. ${result.kept} messages kept.` : "The conversation is short enough; nothing was compacted." };
  }
  if (name === "search_history") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    return { text: formatSearch(searchArchive(ctx.home, bot, { query, limit: args.limit }), query), activity: "Searching old history" };
  }
  if (name === "read_history") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    return { text: formatWindow(readArchiveWindow(ctx.home, bot, { id, before: args.before, after: args.after }), id), activity: "Reading old history" };
  }
  throw new Error(`Unknown collaboration tool ${name}.`);
}

// What a teammate brings to a question: its job and instructions, the skills and plugins it holds,
// the projects it follows. Weighted so a plugin or a job that names the topic wins over a passing
// mention in long instructions.
export function rankTeam(state, bot, question, { plugins = null, exclude = [] } = {}) {
  const skills = new Map(discover().filter((entry) => !entry.default).map((entry) => [entry.name, entry]));
  const others = state.bots.filter((item) => item.id !== bot.id && !isPaused(item) && !exclude.includes(item.id));
  const fields = (item) => {
    const held = (item.skills || []).map((name) => skills.get(name)).filter(Boolean);
    const pluginInfo = plugins?.promptInfo(item) || [];
    return [
      [item.job, 4],
      [pluginInfo.map((plugin) => `${plugin.name} ${plugin.id}`).join(" "), 4],
      [item.name, 3],
      [held.map((entry) => `${entry.name.replace(/-/g, " ")} ${entry.description}`).join(" "), 2],
      [(item.vaultProjects || []).join(" "), 2],
      [item.group, 1],
      [String(item.prompt || "").slice(0, 2_000), 1],
    ];
  };
  return rank(question, others, fields, { limit: others.length }).map((row) => ({ bot: row.item, score: row.score }));
}

function routedText(asker, question, context, passed) {
  return [
    `${asker.name} asked the team this, and Ravnir picked you because your job, skills or plugins fit it best.`,
    "",
    `Question: ${question}`,
    context ? `\nWhat ${asker.name} already knows or tried: ${context}` : "",
    passed.length ? `\nAlready passed: ${passed.map((item) => item.name).join(", ")}.` : "",
    "",
    `Answer with what your own tools, notes, plugins and access can find, and say where it came from. If this is not something you can answer or do, reply with only [[pass]] and one short line on why (name a teammate who might know, if one comes to mind). Do not ask the user; ${asker.name} handles that.`,
  ].filter((line, index, all) => line || all[index - 1]).join("\n");
}

async function askTeam(args, ctx) {
  const { bot, state, engine } = ctx;
  const question = typeof args.question === "string" ? args.question.trim().slice(0, MAX_BOT_MESSAGE) : "";
  if (!question) throw new Error("Write the question for the team.");
  const context = cleanText(args.context, 2_000);
  const chain = Array.isArray(ctx.chain) ? ctx.chain : [];
  if (chain.length >= 2) throw new Error("This question already went through two agents. Answer with what you have, or ask the user with ask_user.");
  const ranked = rankTeam(state, bot, `${question} ${context}`, { plugins: ctx.plugins, exclude: chain }).map((row) => row.bot);
  let order = ranked;
  if (args.bot) {
    const first = resolveBot(state, args.bot, bot.id);
    if (!first) throw new Error(`No other bot matches "${args.bot}". Use list_bots to see the roster.`);
    if (isPaused(first)) throw new Error(pausedNote(first));
    if (chain.includes(first.id)) throw new Error("That would create a messaging loop between bots. Reply to the current message instead.");
    order = [first, ...ranked.filter((item) => item.id !== first.id)];
  }
  if (!order.length) {
    // Nothing on the roster names the topic: the main bot coordinates, so it gets the question.
    const main = state.bots.find((item) => item.main && item.id !== bot.id && !isPaused(item) && !chain.includes(item.id));
    if (main) order = [main];
  }
  if (!order.length) {
    const roster = state.bots.filter((item) => item.id !== bot.id).map((item) => `- ${item.name}${isPaused(item) ? " (paused)" : ""}: ${item.job}`).join("\n");
    return { text: roster ? `No teammate's job, skills or plugins match this, and there is no main bot to route it. The team:\n${roster}\nIf one of them fits, ask it with message_bot; otherwise ask the user with ask_user.` : "You have no teammates on this server. Ask the user with ask_user if you need them." };
  }
  const deadline = Date.now() + (ctx.waitMs ?? replyWaitMs(engine, bot.id));
  const passed = [];
  for (const target of order.slice(0, MAX_ASKED)) {
    const left = deadline - Date.now();
    if (left < 5_000) break;
    const startedAt = Date.now();
    const { promise } = engine.enqueue(target, {
      text: routedText(bot, question, context, passed),
      source: "bot",
      fromBotId: bot.id,
      fromBotName: bot.name,
      chain: [...chain, bot.id],
      routed: true,
    });
    promise.catch(() => {});
    if (!(await waitForTurn(promise, left))) {
      engine.relayReply?.(bot, target, { promise, startedAt, asked: question });
      const before = passed.length ? ` ${passed.map((item) => `${item.name} passed (${item.why})`).join("; ")}.` : "";
      return {
        text: `${target.name} is working on it.${before} Its answer will come to your thread as a new message, and you will get a turn to act on it. Do not ask again; tell the user who is looking into it.`,
        activity: `Asking ${target.name}`,
      };
    }
    const reply = latestReplyMessage(ctx.home, target, startedAt);
    if (!reply) {
      passed.push({ name: target.name, why: "finished without a written answer" });
      continue;
    }
    if (reply.passed || PASS.test(reply.content)) {
      passed.push({ name: target.name, why: passReason(reply.content) });
      continue;
    }
    const before = passed.length ? `\n\n(Asked first, passed: ${passed.map((item) => `${item.name}, ${item.why}`).join("; ")}.)` : "";
    return {
      text: `Answer from ${target.name} (${target.job}):\n${String(reply.content).slice(0, 4_000)}${before}\n\nGive the user this answer in your own words and say it came from ${target.name}.`,
      activity: `Asked ${target.name}`,
    };
  }
  const tried = passed.map((item) => `${item.name} (${item.why})`).join("; ");
  const rest = order.slice(MAX_ASKED).map((item) => item.name);
  return {
    text: `Nobody on the team could answer.${tried ? ` Passed: ${tried}.` : ""}${rest.length ? ` Not asked: ${rest.join(", ")}.` : ""} Tell the user plainly what you could not find out. If only they can answer it, ask them once with ask_user.`,
    activity: "Asked the team",
  };
}

function passReason(content) {
  const text = String(content || "").replace(PASS, "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : "no reason given";
}

// A user @mentioned another bot in a thread. Reuse the same queue and reply
// reader as message_bot, but label the source as a mention so both bots know
// why they were pulled in.
export async function deliverMention(ctx, target, text, timeout = 150_000) {
  const chain = Array.isArray(ctx.chain) ? ctx.chain : [];
  if (!target || target.id === ctx.bot.id || chain.includes(target.id)) return "";
  if (isPaused(target)) return pausedNote(target);
  const startedAt = Date.now();
  const { promise } = ctx.engine.enqueue(target, {
    text,
    source: "mention",
    fromBotId: ctx.bot.id,
    fromBotName: ctx.bot.name,
    chain: [...chain, ctx.bot.id],
  });
  promise.catch(() => {});
  return (await waitForTurn(promise, timeout)) ? latestReply(ctx.home, target, startedAt) : "";
}

// True when the turn ended (however it ended) within timeout.
async function waitForTurn(promise, timeout) {
  let timer;
  const finished = await Promise.race([
    promise.then(() => true).catch(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeout);
    }),
  ]);
  clearTimeout(timer);
  return finished;
}

// What the target wrote in its thread since startedAt.
export function latestReply(home, target, startedAt) {
  const reply = latestReplyMessage(home, target, startedAt);
  return reply ? String(reply.content).slice(0, 4_000) : "";
}

export function latestReplyMessage(home, target, startedAt) {
  const conversation = readConversation(home, target);
  return [...conversation].reverse().find((message) => message.role === "assistant" && message.content && message.kind !== "ack" && (message.at || 0) >= startedAt) || null;
}

// A paused agent still answers its user, but nothing else wakes it: no routines, no messages from other agents.
function isPaused(bot) {
  return bot?.status === "off";
}

function pausedNote(bot) {
  return `${bot.name} is paused, so it did not get the message. The user can turn it back on in its settings.`;
}

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanGroup(value) {
  return cleanText(value, MAX_GROUP_NAME);
}

function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}

