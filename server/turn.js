import crypto from "node:crypto";
import { memoryBrief } from "./aiMemory.js";
import { compactConversation, shouldCompact } from "./compaction.js";
import { builtinToolsFor, callBuiltinTool } from "./computer.js";
import { artifactRef } from "./artifacts.js";
import { guardTool, normalizePolicy, suggestAlwaysRule, withAllowRule } from "./policy.js";
import { buildSystemPrompt, teammatesFor } from "./prompts.js";
import { localHostName, localProjects } from "./localProjects.js";
import { complete, CODING_TOOLS } from "./providers/openai.js";
import { runOpenCodeTurn } from "./providers/opencode.js";
import { addUsage, planNote as quickPlanNote, quickConfig, quickPlan } from "./quick.js";
import { readAppliedSpec } from "./spec.js";
import { indexForBot } from "./skills.js";
import { appendConversation, readConversation, readDiffs, workspacePath, writeDiffs } from "./state.js";
import { citedSources } from "./vault/context.js";
import { compareSnapshots, editFile, listDir, readFile, searchFiles, snapshotWorkspace, writeFile } from "./workspace.js";
import { languageNote, ownerOf } from "./owner.js";
import { chooserFor } from "./chooser.js";
import { latestReply, PASS } from "./collaboration.js";
import { modelImages, withAttachments } from "./uploads.js";
import { countAsks, ownerFact, publicAsk, TurnAttempts } from "./asks.js";
import { costOf } from "./ledger.js";
import { canFallBack, handoverNote, modelChain, noteFailure, noteSuccess, toolLine, usableChain } from "./fallback.js";

const NO_NEWS = /\[\[\s*no[\s_-]*news\s*\]\]/i;
const NO_NEWS_ALL = new RegExp(NO_NEWS.source, "gi");

// message_bot hands a late reply back to the asker as a new turn. After this many hand-backs in one
// exchange the reply only lands in the thread, so two agents cannot keep each other busy.
const MAX_RELAYS = 3;
const oneLine = (text, max) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);

const TOOL_OUTPUT_LIMIT = 12_000;
const MAX_ROUNDS = 24;
const MAX_CONTEXT_CHARS = 80_000;
// A turn that needs this many approvals is looping. Stop it instead of asking
// the user to click through a wall of prompts.
const APPROVAL_BUDGET = approvalBudget();

// How many times a turn that stopped on a progress line is asked to finish.
const CONTINUE_ROUNDS = 2;
const CONTINUE_NOTE = "(Ravnir: your last message said you would keep going, but your turn ended there. Continue now and finish the task. End with the result for the user, not a progress line. If you are truly blocked, say what blocks you.)";

// A reply that announces more work instead of delivering it: short, no question, and its last
// sentence says what the agent will do next ("Sigo con...", "Voy a abrir...", "Next I'll...").
export function soundsUnfinished(text) {
  const plain = String(text || "").trim();
  if (!plain || plain.length > 700 || plain.includes("?") || /```/.test(plain)) return false;
  const last = plain.split(/(?<=[.!])\s+|\n+/).map((part) => part.trim()).filter(Boolean).pop() || "";
  return /^(sigo|contin[uú]o|voy a|ahora (voy|abro|miro|reviso|paso)|paso a|a continuaci[oó]n|luego (abro|miro|reviso)|next,? i('| wi)ll|now i('| wi)ll|i('| wi)ll (now|next|continue|keep)|let me (now|next|continue)|continuing|moving on)\b/i.test(last)
    || /\b(sigo (con|ahora)|contin[uú]o (con|ahora)|i('| wi)ll continue|continuing now)\b[^.]*\.?$/i.test(last);
}

// A chat reply that gives up ("no puedo", "I don't have access") although the agent never asked the
// team. Ravnir asks it once to check with a teammate first; if it does not, its first answer stands.
const TEAM_TOOLS = new Set(["message_bot", "ask_team", "broadcast"]);
const TEAM_NOTE = "(Ravnir: your reply says you cannot do or answer this. Before you tell the user that, check whether a teammate can: call ask_team with the user's request and what you already tried, or message_bot the teammate in your prompt whose job, skills or plugins fit. Then answer the user with what you found and who it came from. If this needs something only the user has (a decision, a code, a login, their own opinion), or nobody on the team could do it either, reply exactly as before, without mentioning this note.)";

export function soundsStuck(text) {
  const plain = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (!plain || plain.length > 1_200) return false;
  return /\b(no puedo|no tengo (acceso|forma|manera|modo|permiso|herramientas?|informacion|datos|esa|ese|los|las)|no dispongo|no me es posible|no lo se|no se (como|que|si|cual|donde)|no estoy en condiciones|fuera de mi alcance|sin acceso a)\b/.test(plain)
    || /\b(i can'?t|i cannot|i can not|i'?m (not able|unable)|i am (not able|unable)|i (don'?t|do not) (have|know)|i have no (way|access|information)|outside (of )?my (scope|reach|access)|no access to)\b/.test(plain);
}

function approvalBudget() {
  const value = Number(process.env.RAVNIR_APPROVAL_BUDGET);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 6;
}

export class TurnEngine {
  constructor({ home, state, saveState, secrets, modelKey = null, artifacts = null, eventLog, browser, mcp, appUrl, onActivity, aiMemory, provisionBot, approvals, ledger, passwordFor, onPolicyChange, notifications = null, proposals = null, isWatching = () => false, vault = null, vaultWriter = null, plugins = null, live = null, mac = null, asks = null, profilePath = () => "" }) {
    this.home = home;
    // Every question an agent put to the user (server/asks.js): repeats are refused, answers are reused.
    this.asks = asks;
    // The owner's Mac as a second computer (server/macNode.js).
    this.mac = mac;
    // Take control (server/live.js): the hand-over of the browser to the user.
    this.live = live;
    this.state = state;
    this.saveState = saveState;
    this.secrets = secrets;
    // Saved deliverables (server/artifacts.js); the turn that made one shows it under its reply.
    this.artifacts = artifacts;
    // The credential for a bot's model calls: its own key, else its connection's (server/models.js).
    this.modelKey = modelKey || ((bot) => secrets.get(`bot:${bot.id}:apiKey`, ""));
    this.eventLog = eventLog;
    this.browser = browser;
    this.mcp = mcp;
    this.appUrl = appUrl;
    this.onActivity = onActivity;
    this.aiMemory = aiMemory;
    this.vault = vault;
    this.vaultWriter = vaultWriter;
    this.plugins = plugins;
    this.provisionBot = provisionBot;
    this.approvals = approvals;
    this.ledger = ledger;
    this.passwordFor = passwordFor;
    this.onPolicyChange = onPolicyChange;
    this.notifications = notifications;
    this.proposals = proposals;
    // Where the owner's profile note is, so its facts reach every agent (server/vault/context.js).
    this.profilePath = profilePath;
    // True while a focused app window is polling this bot, so the reply is already on screen.
    this.isWatching = isWatching;
    this.compacting = new Set();
    this.queues = new Map();
    this.active = new Map();
  }

  status(botId) {
    const active = this.active.get(botId);
    if (!active) return { busy: false, activity: "", partial: "", startedAt: 0, source: "" };
    return {
      busy: true,
      activity: active.activity,
      partial: active.partial,
      startedAt: active.startedAt,
      source: active.source,
      turnId: active.turnId,
    };
  }

  // Turns running past `ms` that are not waiting for an approval. Each one is reported once.
  stuckTurns(ms, { pendingFor = () => [] } = {}) {
    const now = Date.now();
    const out = [];
    for (const [botId, active] of this.active) {
      if (!active.startedAt || now - active.startedAt < ms) continue;
      if (pendingFor(botId).length) continue;
      out.push({ botId, active });
    }
    return out;
  }

  enqueue(bot, input) {
    const turnId = crypto.randomUUID();
    const job = () => this.execute(bot, input, turnId);
    const previous = this.queues.get(bot.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(job);
    this.queues.set(bot.id, next.catch(() => {}));
    return { turnId, promise: next };
  }

  runJob(bot, job) {
    // A paused agent does not wake for its routines. The skip is recorded so Home shows why nothing ran.
    if (bot.status === "off") {
      this.#finishJob(bot, job.id, "skipped", "Paused");
      this.ledger?.record({
        id: crypto.randomUUID(),
        at: Date.now(),
        startedAt: Date.now(),
        durationMs: 0,
        botId: bot.id,
        botName: bot.name,
        source: "job",
        jobId: job.id,
        jobName: job.name,
        prompt: String(job.prompt || "").slice(0, 300),
        status: "skipped",
        error: "",
        summary: "Paused",
        provider: bot.model?.provider || "",
        model: bot.model?.model || "",
        usage: null,
      });
      this.saveState();
      return Promise.resolve();
    }
    return this.enqueue(bot, {
      text: job.prompt,
      source: "job",
      jobId: job.id,
      jobName: job.name,
    }).promise;
  }

  stop(botId) {
    const active = this.active.get(botId);
    if (!active) return false;
    active.abort.abort();
    return true;
  }

  decide(requestId, value) {
    // Only a request that is still waiting can change the policy, so a replayed id does nothing.
    const record = value === "trust" && this.approvals.pending().find((item) => item.id === requestId);
    const accepted = this.approvals.decide(requestId, value);
    if (accepted && record) {
      const bot = this.state.bots.find((item) => item.id === record.botId);
      if (bot) {
        bot.policy = normalizePolicy({ ...bot.policy, shell: "allow", files: "allow", logins: "allow" });
        this.onPolicyChange?.(bot);
      }
    }
    return accepted;
  }

  // Everything that pauses for the user goes through the approval inbox.
  // OpenCode asks through here. "Always allow" on a bash request saves the rule to
  // Ravnir's policy too, so it outlives OpenCode's own session; on a file request
  // it opens files for this bot.
  async waitForDecision(bot, requestId, signal, meta = {}) {
    const opencode = meta.kind === "opencode";
    const bash = opencode && meta.permission === "bash";
    const rule = bash ? suggestAlwaysRule(meta.command || String(meta.detail || "").split("\n")[0]) : "";
    const decision = await this.requestApproval({ ...this.approvalMeta(bot.id), ...meta, rule, onceOnly: bash && !rule, id: requestId, bot, signal });
    if (decision === "always" && opencode) this.#rememberAlways(bot, meta.permission, rule);
    return decision;
  }

  #rememberAlways(bot, permission, rule) {
    if (permission === "bash") {
      if (!rule) return;
      bot.policy = withAllowRule(bot.policy, rule);
    } else if (permission === "edit" || permission === "external_directory") {
      bot.policy = normalizePolicy({ ...bot.policy, files: "allow" });
    } else {
      return;
    }
    this.onPolicyChange?.(bot);
  }

  requestApproval(options) {
    const active = options?.bot ? this.active.get(options.bot.id) : null;
    if (!active) return this.approvals.request(options);
    active.approvals = (active.approvals || 0) + 1;
    if (active.approvals > APPROVAL_BUDGET) {
      const error = new Error(`Stopped: this turn asked for ${active.approvals} approvals. Use the web and browser tools, or allow terminal commands for this bot in Settings.`);
      error.approvalBudget = true;
      throw error;
    }
    // Handing the browser to the user is a question to them too: it counts in the turn's asks.
    if (options.kind === "takeover") active.takeovers = (active.takeovers || 0) + 1;
    return this.approvals.request(options);
  }

  // The built-in tool guard goes through the same budget as OpenCode.
  approvalGate(bot) {
    return { request: (options) => this.requestApproval({ ...options, bot: options?.bot || bot }) };
  }

  approvalMeta(botId) {
    const active = this.active.get(botId);
    return { source: active?.source || "chat", turnId: active?.turnId || "" };
  }

  // The caps are checked before a turn starts. A turn already running finishes.
  capReached(bot) {
    const limits = bot.limits || {};
    if (!this.ledger || !(limits.dailyCost || limits.dailyTokens || limits.monthlyCost || limits.monthlyTokens)) return "";
    const day = limits.dailyCost || limits.dailyTokens ? this.ledger.spentToday(bot.id) : null;
    const month = limits.monthlyCost || limits.monthlyTokens ? this.ledger.spentThisMonth(bot.id) : null;
    if (limits.dailyCost && day.cost >= limits.dailyCost) return `${bot.name} reached its daily cap of ${dollars(limits.dailyCost)} (spent ${dollars(day.cost)} today).`;
    if (limits.dailyTokens && day.tokens >= limits.dailyTokens) return `${bot.name} reached its daily cap of ${limits.dailyTokens.toLocaleString("en-US")} tokens (used ${day.tokens.toLocaleString("en-US")} today).`;
    if (limits.monthlyCost && month.cost >= limits.monthlyCost) return `${bot.name} reached its monthly cap of ${dollars(limits.monthlyCost)} (spent ${dollars(month.cost)} this month).`;
    if (limits.monthlyTokens && month.tokens >= limits.monthlyTokens) return `${bot.name} reached its monthly cap of ${limits.monthlyTokens.toLocaleString("en-US")} tokens (used ${month.tokens.toLocaleString("en-US")} this month).`;
    return "";
  }

  // Once per period, a push when an agent passes 80 percent of a cap, before it stops.
  #warnNearCap(bot) {
    const limits = bot.limits || {};
    if (!this.ledger || !this.notifications) return;
    const now = new Date();
    const dayKey = now.toLocaleDateString("en-CA");
    const monthKey = dayKey.slice(0, 7);
    const checks = [];
    if (limits.dailyCost || limits.dailyTokens) {
      const day = this.ledger.spentToday(bot.id);
      if (limits.dailyCost) checks.push(["day", dayKey, day.cost / limits.dailyCost, `${dollars(day.cost)} of its ${dollars(limits.dailyCost)} daily cap`]);
      if (limits.dailyTokens) checks.push(["day", dayKey, day.tokens / limits.dailyTokens, `${day.tokens.toLocaleString("en-US")} of its ${limits.dailyTokens.toLocaleString("en-US")} daily tokens`]);
    }
    if (limits.monthlyCost || limits.monthlyTokens) {
      const month = this.ledger.spentThisMonth(bot.id);
      if (limits.monthlyCost) checks.push(["month", monthKey, month.cost / limits.monthlyCost, `${dollars(month.cost)} of its ${dollars(limits.monthlyCost)} monthly cap`]);
      if (limits.monthlyTokens) checks.push(["month", monthKey, month.tokens / limits.monthlyTokens, `${month.tokens.toLocaleString("en-US")} of its ${limits.monthlyTokens.toLocaleString("en-US")} monthly tokens`]);
    }
    bot.stats.capWarned ||= {};
    for (const [period, key, ratio, text] of checks.sort((a, b) => b[2] - a[2])) {
      if (ratio < 0.8 || bot.stats.capWarned[period] === key) continue;
      bot.stats.capWarned[period] = key;
      const reached = ratio >= 1;
      this.notifications.notify({ botId: bot.id, botName: bot.name, url: `/?bot=${bot.id}&panel=usage`, kind: "failure", priority: reached ? "high" : "normal", title: reached ? "reached a cap" : "is near a cap", body: `${bot.name} has used ${text}.${reached ? " New turns wait until the cap resets or you raise it." : ""}`, tag: `cap-${bot.id}-${period}` }).catch(() => {});
      this.saveState();
    }
  }

  // An artifact was saved or updated (from the built-in loop or the per-bot MCP endpoint).
  noteArtifact(bot, meta) {
    const active = this.active.get(bot.id);
    if (active) {
      active.artifacts ||= new Map();
      active.artifacts.set(meta.id, artifactRef(meta));
    }
    this.emit(bot, { type: "artifact", artifact: meta, ...(active ? { turnId: active.turnId } : {}) });
  }

  emit(bot, event) {
    const payload = {
      ...event,
      botId: bot.id,
      at: event.at || Date.now(),
    };
    this.eventLog.append(bot, payload);
  }

  async execute(bot, input, turnId) {
    const controller = new AbortController();
    const active = {
      turnId,
      startedAt: Date.now(),
      partial: "",
      activity: input.source === "job" ? `Scheduled job: ${input.jobName}` : "Thinking",
      source: input.source || "chat",
      jobId: input.jobId || "",
      jobName: input.jobName || "",
      chain: Array.isArray(input.chain) ? input.chain : [],
      relay: Number(input.relay) || 0,
      approvals: 0,
      abort: controller,
      // Model calls a tool makes on its own (the computer chooser), added to this turn's cost.
      toolUsage: null,
      // Failed calls per target in this turn, so the agent changes approach before it asks (server/asks.js).
      attempts: new TurnAttempts(),
      takeovers: 0,
      // What ask_user did in this turn: questions sent, repeats refused, looks suggested.
      asking: null,
    };
    this.active.set(bot.id, active);
    this.onActivity?.(bot);
    const emit = (event) => {
      if (event.type === "stream.delta") active.partial += event.text || "";
      if (event.type === "stream.replace") active.partial = event.text || "";
      if (event.type === "status") active.activity = event.message || active.activity;
      if (event.type === "tool") {
        if (event.status !== "running") active.toolCalls = (active.toolCalls || 0) + 1;
        // Every call this turn made, at its latest status: a call still running when a session is
        // dropped is listed too, so the next session or model does not run it again blindly.
        (active.toolsSeen ||= new Map()).set(event.id || `${event.name}:${JSON.stringify(event.input ?? {})}`, event);
        active.activity = event.status === "completed"
          ? `${event.name} finished`
          : event.status === "error" ? `${event.name} failed` : `Running ${event.name}`;
      }
      if (event.type === "diff") {
        active.activity = `Changed ${event.path || "a file"}`;
        this.#storeDiff(bot, { ...event, at: event.at || Date.now() });
      }
      // OpenCode's own tools run outside Ravnir; their failures still count toward the turn's attempts.
      if (event.type === "tool" && bot.model.provider === "opencode") active.attempts.observe(event);
      this.emit(bot, { ...event, turnId });
    };
    const toolLines = () => [...(active.toolsSeen?.values() || [])].map(toolLine);

    const fromBot = input.source === "bot" || input.source === "mention";
    const userText = fromBot && input.fromBotName
      ? input.source === "mention"
        ? `[You were mentioned in ${input.fromBotName}'s thread]\n\n${input.text}`
        : `[Message from ${input.fromBotName}, another bot on this server]\n\n${input.text}`
      : input.text;
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    const modelText = withAttachments(input.text, attachments);
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: userText,
      at: Date.now(),
      source: input.source || "chat",
      jobName: input.jobName || "",
      fromBotId: input.fromBotId || "",
      fromBotName: input.fromBotName || "",
      mentions: Array.isArray(input.mentions) ? input.mentions : [],
      // Only shown in the thread (a mic mark); toApi() sends just role and content to the model.
      ...(input.via === "voice" ? { via: "voice" } : {}),
      // What the thread shows when the model gets more than the user said (a task handed over from voice mode).
      ...(input.display ? { display: String(input.display).slice(0, 2000) } : {}),
      // Files saved in the workspace (server/uploads.js); the model reads a note with their paths.
      ...(attachments.length ? { attachments } : {}),
    };
    emit({
      type: "turn.start",
      message: userMessage,
      source: input.source || "chat",
      jobId: input.jobId || "",
      jobName: input.jobName || "",
      fromBotId: input.fromBotId || "",
      fromBotName: input.fromBotName || "",
    });

    let conversation = appendConversation(this.home, bot, [userMessage]);

    // The user's message answers the questions this agent left open. The ask book keeps the answer, so
    // no agent asks again; the agent saves a lasting fact about the owner itself (it can tell an answer
    // from "skip that").
    const answered = this.#takeAnswers(bot, input, turnId);

    const capped = this.capReached(bot);
    const apiKey = this.modelKey(bot);
    const providerBot = { ...bot, model: { ...bot.model, apiKey } };

    // While memory and context load, a small fast model writes the first reply:
    // what the agent is about to do, in a sentence or two. It is stored with the
    // thread as an ack, so it stays out of model history and compaction. The
    // agent's model is told the user saw it, as a courtesy line and never as an
    // order: the quick model knows nothing of the agent's notes or tools.
    // Routines and messages from other bots start working without one.
    const quick = !capped && !fromBot && !input.noPlan && input.source !== "job" ? quickConfig(providerBot) : null;
    const planning = (quick
      ? quickPlan({ config: quick, bot, text: modelText, history: conversation.slice(0, -1), signal: controller.signal })
      : Promise.resolve({ text: "", usage: null }))
      .catch(() => ({ text: "", usage: null }))
      .then((plan) => {
        if (plan.text && !controller.signal.aborted) {
          const ackMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            kind: "ack",
            content: plan.text,
            at: Date.now(),
            source: input.source || "chat",
          };
          appendConversation(this.home, bot, [ackMessage]);
          emit({ type: "ack", message: ackMessage });
        }
        return plan;
      });

    const workspace = workspacePath(this.home, bot);
    // The vault, when on, is the shared memory; otherwise fall back to the ai-memory brief.
    const notes = this.vault?.available ? await this.#vaultContext(bot, input.text) : null;
    const memory = notes ? "" : await memoryBrief(this.aiMemory, input.text).catch(() => "");
    const context = {
      workspace,
      appUrl: this.appUrl,
      connectors: bot.connectors,
      plugins: this.plugins?.promptInfo(bot) || [],
      jobs: bot.jobs,
      logins: bot.vault,
      browserAvailable: Boolean(this.browser.status(bot).available),
      ownComputer: Boolean(this.browser.box?.uses(bot)),
      // Project folders on this machine; a box cannot see them, so own-computer agents get none.
      localProjects: this.browser.box?.uses(bot) ? [] : localProjects(),
      hostName: localHostName(),
      mac: this.mac?.status() || null,
      owner: ownerOf(this.state),
      chooser: chooserFor(bot).mode,
      teammates: teammatesFor(this.state, bot, this.plugins),
      groups: this.state.groups || [],
      memoryBrief: memory,
      memoryAvailable: Boolean(this.aiMemory?.available),
      ...(notes ? { vaultContext: notes.text, vaultWrite: Boolean(this.vaultWriter?.available), vaultPaths: this.vaultWriter?.available ? this.vaultWriter.describe() : null } : {}),
      specText: readAppliedSpec(this.home, bot),
      skillsIndex: indexForBot(bot),
      provider: bot.model.provider,
    };
    const livePrompt = buildSystemPrompt(bot, context);
    emit({
      type: "meta",
      provider: bot.model.provider,
      model: bot.model.model || "server default",
      baseUrl: bot.model.baseUrl,
      livePrompt,
      // Which vault notes, at which version, this turn was given. Two bots answering alike share these hashes.
      ...(notes ? { vaultSources: notes.sources } : {}),
    });

    const plan = await planning;
    const planNote = quickPlanNote(plan.text);
    const facts = answered.map((item) => (item.about === "owner" && item.answer ? ownerFact(item) : null)).filter(Boolean);
    const answerNote = answered.length
      ? `(This message answers what you asked the user: ${answered.map((item) => `"${oneLine(item.question, 200)}"`).join(" and ")}. Continue the work with it.${facts.length ? ` If it gives a lasting fact about the user, save it with remember first (key: ${facts.map((fact) => fact.key).filter(Boolean).join(", ") || "a short key"}).` : ""})`
      : "";
    // The language of the user's own message, said next to it, so a language named in the agent's
    // standing instructions does not win. Routines and bot-to-bot turns get no note.
    const langNote = !fromBot && input.source !== "job" && input.text ? languageNote(input.text) : "";
    const turnNote = [langNote, notes?.turnNote, answerNote, planNote].filter(Boolean).join("\n\n");

    let newMessages = [];
    let beforeSnapshot = new Map();
    let usage = null;
    let outcome = { status: "ok", error: "" };
    // The model that answered, and the ones that failed before it.
    let usedModel = bot.model;
    const fallbacks = [];
    try {
      if (capped) {
        const error = new Error(`${capped} Raise the cap in the agent's Settings, or wait until ${/monthly/.test(capped) ? "next month" : "tomorrow"}.`);
        error.capped = true;
        throw error;
      }
      beforeSnapshot = await snapshotWorkspace(workspace).catch(() => new Map());
      // The agent's model first, then its backups when the provider fails (server/fallback.js).
      const { usable: chain, skipped } = usableChain(modelChain(bot.model));
      fallbacks.push(...skipped);
      if (skipped.length) emit({ type: "status", message: `Skipping ${skipped.map((item) => item.model).join(", ")}: failed recently.` });
      let runBot = providerBot;
      let handover = "";
      let lastText = turnNote ? `${modelText}\n\n${turnNote}` : modelText;
      for (let step = 0; ; step += 1) {
        usedModel = chain[step];
        runBot = usedModel === bot.model ? providerBot : { ...bot, model: { ...usedModel, apiKey: this.modelKey({ model: usedModel }) } };
        if (step === 0 && usedModel !== bot.model && (usedModel.provider !== bot.model.provider || usedModel.baseUrl !== bot.model.baseUrl)) bot.remote.opencode = {};
        try {
          if (usedModel.provider === "opencode") {
            const history = recentHistory(conversation.slice(0, -1));
            const ask = (text, files = []) => {
              lastText = text;
              return runOpenCodeTurn({
                bot: runBot,
                directory: workspace,
                remote: bot.remote.opencode || {},
                title: titleFrom(conversation),
                text: handover ? `${text}\n\n${handover}` : text,
                files,
                systemPrompt: livePrompt,
                history,
                emit,
                signal: controller.signal,
                waitForDecision: (requestId, signal, meta) => this.waitForDecision(bot, requestId, signal, meta),
                // A fresh session after a stall hears what the dropped one already ran.
                retryNote: (error) => {
                  const lines = toolLines();
                  return lines.length ? handoverNote(usedModel.model, error?.message || "its OpenCode session stopped responding", lines, { sameModel: true }) : "";
                },
              });
            };
            let result = await ask(lastText, newMessages.length ? [] : modelImages(workspace, attachments));
            handover = "";
            // Some models end a tool-heavy turn with a progress line ("Sigo con...") and stop.
            // Ravnir asks them to finish, a bounded number of times.
            for (let round = 0; ; round += 1) {
              bot.remote.opencode = result.remote;
              usage = addUsage(usage, result.usage || null);
              newMessages.push({
                id: crypto.randomUUID(),
                role: "assistant",
                content: result.text || "(No text reply.)",
                at: Date.now(),
                source: input.source || "chat",
              });
              if (round >= CONTINUE_ROUNDS || controller.signal.aborted || !active.toolCalls || active.asking || !soundsUnfinished(result.text)) break;
              emit({ type: "status", message: "Finishing the task" });
              result = await ask(CONTINUE_NOTE);
            }
            if (!controller.signal.aborted && !active.asking && !active.teamCalls && this.#canAskTeam(bot, input) && soundsStuck(result.text)) {
              emit({ type: "status", message: "Checking with the team" });
              const second = await ask(TEAM_NOTE);
              bot.remote.opencode = second.remote;
              usage = addUsage(usage, second.usage || null);
              // The second reply is kept only when the agent did ask the team; otherwise its first answer stands alone.
              if (active.teamCalls) {
                newMessages.push({
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: second.text || "(No text reply.)",
                  at: Date.now(),
                  source: input.source || "chat",
                });
              }
            }
          } else if (usedModel.provider === "openai") {
            const result = await this.#runOpenAI({
              bot: runBot,
              workspace,
              livePrompt,
              conversation,
              turnNote: [turnNote, handover].filter(Boolean).join("\n\n"),
              emit,
              signal: controller.signal,
              jobName: input.jobName,
            });
            newMessages = result.messages;
            usage = addUsage(usage, result.usage || null);
          } else {
            throw new Error("Unknown model provider.");
          }
          noteSuccess(usedModel);
          break;
        } catch (error) {
          if (!controller.signal.aborted) noteFailure(usedModel, error);
          if (controller.signal.aborted || !canFallBack(error) || step + 1 >= chain.length) throw error;
          const next = chain[step + 1];
          fallbacks.push({ model: usedModel.model, error: String(error.message || "").slice(0, 300) });
          if (usedModel.provider === "opencode" && (error.resetRemote || next.provider !== "opencode" || next.baseUrl !== usedModel.baseUrl)) bot.remote.opencode = {};
          handover = toolLines().length || newMessages.length ? handoverNote(usedModel.model, error.message, toolLines()) : "";
          emit({ type: "status", message: `${usedModel.model} failed. Switching to ${next.model}.` });
          emit({ type: "fallback", from: usedModel.model, to: next.model, error: String(error.message || "").slice(0, 300) });
        }
      }
      // The next turn starts on the agent's own model again, in a session that server knows.
      if (usedModel !== bot.model && usedModel.provider === "opencode" && usedModel.baseUrl !== bot.model.baseUrl) bot.remote.opencode = {};

      await this.#collectDiffs(bot, workspace, beforeSnapshot, emit);
      // Artifacts saved in this turn show as cards under the final reply.
      if (active.artifacts?.size) {
        const last = [...newMessages].reverse().find((message) => message.role === "assistant" && message.content);
        if (last) last.artifacts = [...active.artifacts.values()];
      }
      // The questions this turn sent show as a card under the reply.
      if (active.asking?.asks?.length) {
        const last = [...newMessages].reverse().find((message) => message.role === "assistant" && message.content);
        if (last) last.asks = active.asking.asks.map(publicAsk);
      }
      // Skills and plugins the agent asked for in this turn show as cards under the reply.
      if (active.suggestions?.length) {
        const last = [...newMessages].reverse().find((message) => message.role === "assistant" && message.content);
        if (last) last.suggestions = active.suggestions;
      }
      // A teammate that cannot answer a question routed by ask_team passes; the marker stays out of its thread.
      if (fromBot) {
        const last = [...newMessages].reverse().find((message) => message.role === "assistant" && message.content);
        if (last && PASS.test(last.content)) {
          last.content = last.content.replace(PASS, "").trim() || "Passed: not something I can answer.";
          last.passed = true;
        }
      }
      // Vault notes the reply cites show under it, with the date and version this turn read.
      if (notes?.sources?.length) {
        const last = [...newMessages].reverse().find((message) => message.role === "assistant" && message.content);
        const cited = last ? citedSources(notes.sources, last.content) : [];
        if (cited.length) last.sources = cited;
      }
      // A routine with nothing to report ends with [[no news]]: logged, but no push and no card.
      const quietReply = input.source === "job" ? [...newMessages].reverse().find((message) => message.role === "assistant" && message.content) : null;
      if (quietReply && NO_NEWS.test(quietReply.content)) {
        quietReply.content = quietReply.content.replace(NO_NEWS_ALL, "").trim() || "Nothing new.";
        quietReply.quiet = true;
        outcome.quiet = true;
      }
      // The reply carries its turn's cost, the same numbers the ledger row gets.
      active.finalUsage = addUsage(addUsage(usage, plan.usage), active.toolUsage);
      const reply = [...newMessages].reverse().find((message) => message.role === "assistant" && message.content);
      if (reply) {
        reply.turnId = turnId;
        if (usedModel !== bot.model) reply.fallback = { model: usedModel.model, failed: fallbacks.map((item) => item.model) };
        reply.cost = costOf({ turnId, usage: active.finalUsage, model: usedModel.model || "", provider: usedModel.provider });
      }
      // Append to the thread as it is on disk now: a compaction that finished during
      // this turn must not be undone by an older copy.
      appendConversation(this.home, bot, newMessages);
      bot.stats.turns = (bot.stats.turns || 0) + 1;
      bot.stats.lastActiveAt = Date.now();
      bot.stats.lastError = "";
      if (input.source === "job" && input.jobId) this.#finishJob(bot, input.jobId, "ok", summaryOf(newMessages), reply?.cost || costOf({ turnId, usage: active.finalUsage, model: usedModel.model || "", provider: usedModel.provider }), Boolean(outcome.quiet));
      this.#scheduleCompaction(bot);
      this.saveState();
      emit({
        type: "turn.end",
        messages: newMessages,
        turnId,
        stats: bot.stats,
      });
    } catch (error) {
      await this.#collectDiffs(bot, workspace, beforeSnapshot, emit).catch(() => {});
      const stopped = controller.signal.aborted || /Stopped\.?$/.test(error.message || "");
      if (!stopped && error.resetRemote && usedModel.provider === "opencode") {
        bot.remote.opencode = {};
      }
      outcome = { status: stopped ? "stopped" : error.capped ? "capped" : "error", error: stopped ? "" : error.message || "The turn failed." };
      bot.stats.lastError = stopped ? "" : error.message || "The turn failed.";
      if (input.source === "job" && input.jobId) {
        // What a failed run already spent still shows in its history, matching the ledger row.
        const spentSoFar = costOf({ turnId, usage: addUsage(addUsage(usage, plan.usage), active.toolUsage), model: usedModel.model || "", provider: usedModel.provider });
        this.#finishJob(bot, input.jobId, stopped ? "stopped" : error.capped ? "skipped" : "error", stopped ? "Stopped." : error.message, spentSoFar);
      }
      // Work saved before the turn failed or was stopped keeps its card in the thread.
      const kept = [];
      // A cap that stops a turn says so in the thread, kept out of the model's history like the plan line.
      if (error.capped) {
        kept.push({ id: crypto.randomUUID(), role: "assistant", kind: "ack", notice: "cap", content: error.message, at: Date.now(), source: input.source || "chat" });
      }
      if (active.artifacts?.size) {
        kept.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: stopped ? "Saved before you stopped me." : "Saved before this turn failed.",
          artifacts: [...active.artifacts.values()],
          at: Date.now(),
          source: input.source || "chat",
        });
      }
      if (kept.length) appendConversation(this.home, bot, kept);
      this.saveState();
      if (stopped) emit({ type: "turn.stopped", message: "Stopped." });
      else emit({ type: "error", message: error.message || "The turn failed." });
      emit({ type: "turn.end", messages: kept, turnId, error: stopped ? "" : error.message || "The turn failed." });
    } finally {
      this.ledger?.record({
        id: turnId,
        at: Date.now(),
        startedAt: active.startedAt,
        durationMs: Date.now() - active.startedAt,
        botId: bot.id,
        botName: bot.name,
        source: input.source || "chat",
        jobId: input.jobId || "",
        jobName: input.jobName || "",
        fromBotName: input.fromBotName || "",
        prompt: String(input.text || "").slice(0, 300),
        status: outcome.status,
        error: outcome.error,
        ...(outcome.quiet ? { quiet: true } : {}),
        summary: outcome.status === "ok" ? summaryOf(newMessages, 2000) : "",
        provider: usedModel.provider,
        model: usedModel.model || "",
        ...(fallbacks.length ? { fallbacks } : {}),
        // The quick plan's and the tools' own tokens count toward the turn, so every cent stays visible.
        usage: active.finalUsage || addUsage(addUsage(usage, plan.usage), active.toolUsage),
        // Questions this turn left for the user: ask_user, a browser hand-over, or a reply that ends asking.
        ...countAsks({ asking: active.asking, takeovers: active.takeovers, refused: active.attempts.refused, reply: outcome.status === "ok" ? lastReply(newMessages) : "" }),
      });
      this.#notifyEnd(bot, input, outcome, newMessages, active.asking?.asks || []);
      if (outcome.status === "ok") this.#warnNearCap(bot);
      active.partial = "";
      active.activity = "";
      this.active.delete(bot.id);
      this.onActivity?.(bot);
      emit({ type: "idle" });
    }
  }

  async #runOpenAI({ bot, workspace, livePrompt, conversation, turnNote = "", emit, signal, jobName }) {
    const history = trimHistory(conversation);
    const messages = [{ role: "system", content: livePrompt }, ...toApi(history)];
    // Attach this turn's live vault data to the user's message for the model only; the thread keeps the plain text.
    const last = messages.at(-1);
    if (turnNote && last?.role === "user" && typeof last.content === "string") messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${turnNote}` };
    // Photos attached to this message go to the model as images; older ones stay a note with a path.
    const images = modelImages(workspace, conversation.at(-1)?.role === "user" ? conversation.at(-1).attachments : []);
    const textOnly = messages.at(-1);
    if (images.length && textOnly?.role === "user") {
      messages[messages.length - 1] = { role: "user", content: [{ type: "text", text: textOnly.content }, ...images.map((image) => ({ type: "image_url", image_url: { url: image.url } }))] };
    }
    const builtins = await builtinToolsFor(bot, { browser: this.browser, vault: this.vault, vaultWriter: this.vaultWriter, plugins: this.plugins });
    const mcpTools = await this.mcp.toolsFor(bot);
    const tools = [
      ...CODING_TOOLS,
      ...builtins.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      ...mcpTools.map((tool) => ({
        type: "function",
        function: {
          name: tool.fullName,
          description: `${tool.description} (${tool.connectorName})`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      })),
    ];
    const added = [];
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const tally = (part) => {
      for (const key of Object.keys(usage)) usage[key] += Number(part?.[key]) || 0;
    };
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (signal.aborted) throw new Error("Stopped.");
      let streamed = "";
      const ask = () => complete({
        bot,
        messages,
        tools,
        signal,
        onDelta: (delta) => {
          streamed += delta;
          emit({ type: "stream.delta", text: delta });
        },
      });
      let result;
      try {
        result = await ask();
      } catch (error) {
        // A model that cannot see images refuses the whole request: send the text and the file paths only.
        if (signal.aborted || !messages.some((item) => Array.isArray(item.content))) throw error;
        for (const [index, item] of messages.entries()) {
          if (Array.isArray(item.content)) messages[index] = { role: item.role, content: `${item.content.find((part) => part.type === "text")?.text || ""}\n\n[This model cannot look at images; the photos are in the workspace at the paths above.]` };
        }
        streamed = "";
        result = await ask();
      }
      tally(result.usage);
      const assistant = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.content || "",
        toolCalls: result.toolCalls,
        at: Date.now(),
        source: jobName ? "job" : "chat",
      };
      messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls.length ? result.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })) : undefined,
      });
      if (!result.toolCalls.length) {
        added.push(assistant);
        emit({ type: "stream.replace", text: result.content || streamed });
        return { messages: added, usage };
      }
      added.push(assistant);
      for (const call of result.toolCalls) {
        if (signal.aborted) throw new Error("Stopped.");
        emit({ type: "tool", id: call.id, name: call.name, status: "running", input: call.arguments || {} });
        let outcome;
        try {
          outcome = await this.tracked(bot.id, call.name, call.arguments || {}, () => this.#executeTool(bot, workspace, call, emit));
        } catch (error) {
          if (error.approvalBudget) throw error;
          outcome = { text: `Error: ${error.message || "The tool failed."}`, error: true };
        }
        emit({
          type: "tool",
          id: call.id,
          name: call.name,
          status: outcome.error ? "error" : "completed",
          input: call.arguments || {},
          output: clip(outcome.text || ""),
        });
        const toolMessage = {
          id: crypto.randomUUID(),
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: clip(outcome.text || ""),
          at: Date.now(),
        };
        added.push(toolMessage);
        messages.push({ role: "tool", tool_call_id: call.id, content: clip(outcome.text || "") });
      }
    }
    throw new Error(`Stopped after ${MAX_ROUNDS} tool rounds.`);
  }

  async #executeTool(bot, workspace, call, emit) {
    const args = call.arguments || {};
    if (args._error) return { text: `Error: ${args._error}`, error: true };
    if (call.name === "list_dir") return { text: await listDir(workspace, args.path || ".") };
    if (call.name === "read_file") return { text: await readFile(workspace, args.path, args.offset, args.limit) };
    if (call.name === "search") return { text: await searchFiles(workspace, args.query, args.path || ".") };
    if (call.name === "write_file") {
      const result = await writeFile(workspace, args.path, String(args.content ?? ""));
      if (result.diff?.patch) this.#addDiff(bot, result.diff, emit);
      return { text: result.output };
    }
    if (call.name === "edit_file") {
      const result = await editFile(workspace, args.path, args.old, args.replacement);
      if (result.diff?.patch) this.#addDiff(bot, result.diff, emit);
      return { text: result.output };
    }
    if (call.name.startsWith("mcp_")) {
      return this.mcp.call(bot, call.name, args);
    }
    // The model call runs on a copy of the bot (it carries the API key). "Always
    // allow" must change the real bot's policy, not the copy's.
    const liveBot = this.state.bots.find((item) => item.id === bot.id) || bot;
    await guardTool(call.name, args, {
      bot: liveBot,
      approvals: this.approvalGate(bot),
      signal: this.active.get(bot.id)?.abort.signal,
      meta: this.approvalMeta(bot.id),
      onPolicyChange: (target) => this.onPolicyChange?.(target),
      mac: this.mac,
    });
    const result = await callBuiltinTool(call.name, args, {
      bot,
      home: this.home,
      browser: this.browser,
      secrets: this.secrets,
      workspace,
      state: this.state,
      engine: this,
      live: this.live,
      aiMemory: this.aiMemory,
      vault: this.vault,
      vaultWriter: this.vaultWriter,
      plugins: this.plugins,
      notifications: this.notifications,
      proposals: this.proposals,
      asks: this.asks,
      mac: this.mac,
      passwordFor: this.passwordFor,
      chain: this.currentChain(bot.id),
      provisionBot: this.provisionBot,
      compact: (target) => this.compact(target),
      emit,
      save: () => this.saveState(),
    });
    if (result.activity) emit({ type: "status", message: result.activity });
    if (result.usage) this.addToolUsage(bot.id, result.usage);
    return { text: result.text, error: false };
  }

  // Every tool call in a turn, from the built-in loop or the per-agent MCP endpoint, goes through here: an
  // unchanged retry of a call that just failed is refused, and a failure gets a note on what to do next.
  async tracked(botId, name, args, run) {
    const running = this.active.get(botId);
    if (running && TEAM_TOOLS.has(name)) running.teamCalls = (running.teamCalls || 0) + 1;
    const attempts = running?.attempts;
    if (!attempts) return run();
    const refusal = attempts.before(name, args);
    if (refusal) return { text: refusal, error: false };
    let result;
    try {
      result = await run();
    } catch (error) {
      if (error.approvalBudget || this.active.get(botId)?.abort.signal.aborted) throw error;
      const note = attempts.after(name, args, { error: true, text: error.message || "" });
      if (note) error.message = `${error.message || "The tool failed."}${note}`;
      throw error;
    }
    const note = attempts.after(name, args, { error: Boolean(result?.error), text: result?.text || "" });
    return note ? { ...result, text: `${result?.text || ""}${note}` } : result;
  }

  #takeAnswers(bot, input, turnId) {
    if (!this.asks || !["chat", "voice"].includes(input.source || "chat")) return [];
    const text = String(input.text || "").trim();
    if (!text) return [];
    // An answer sent from Home names its question; a message in the thread answers all that are open.
    const ids = Array.isArray(input.answers) && input.answers.length ? input.answers.map(String) : null;
    const answered = this.asks.answer(bot.id, text, turnId, ids);
    if (answered.length) this.emit(bot, { type: "asks.answered", ids: answered.map((item) => item.id), turnId });
    return answered;
  }

  // A tool that called a model itself reports its tokens here; they land in the running turn's ledger row.
  addToolUsage(botId, usage) {
    const active = this.active.get(botId);
    if (active && usage) active.toolUsage = addUsage(active.toolUsage, usage);
  }

  async #collectDiffs(bot, workspace, before, emit) {
    const after = await snapshotWorkspace(workspace);
    for (const diff of compareSnapshots(before, after)) this.#addDiff(bot, diff, emit);
  }

  #addDiff(bot, diff, emit) {
    const stored = { ...diff, at: Date.now(), id: diff.id || crypto.randomUUID() };
    this.#storeDiff(bot, stored);
    emit({ type: "diff", ...stored });
  }

  #storeDiff(bot, diff) {
    const diffs = readDiffs(this.home, bot);
    if (diffs.some((existing) => existing.path === diff.path && existing.patch === diff.patch)) return;
    diffs.push({ ...diff, id: diff.id || crypto.randomUUID(), at: diff.at || Date.now() });
    writeDiffs(this.home, bot, diffs);
  }

  currentChain(botId) {
    const active = this.active.get(botId);
    return active?.chain || [];
  }

  // What started the agent's running turn (chat, voice, job, bot...), or "" when it is idle.
  currentSource(botId) {
    return this.active.get(botId)?.source || "";
  }

  // The user is waiting on this reply and someone on the team could take the question.
  #canAskTeam(bot, input) {
    if (!["chat", "voice"].includes(input.source || "chat")) return false;
    return this.state.bots.some((item) => item.id !== bot.id && item.status !== "off");
  }

  // A skill or plugin the agent asked for in this turn shows as a card under its reply.
  noteSuggestion(bot, record) {
    const active = this.active.get(bot.id);
    if (!active || !record) return;
    (active.suggestions ||= []).push({ id: record.id, kind: record.kind, title: record.title, why: record.why, change: record.change, botId: bot.id, botName: bot.name, createdAt: record.createdAt });
  }

  // message_bot stopped waiting for target: when target's turn ends, its reply goes to sender as a
  // message with a turn to act on it (or, past MAX_RELAYS, only into sender's thread).
  relayReply(sender, target, { promise, startedAt, asked = "" }) {
    const relay = (this.active.get(sender.id)?.relay || 0) + 1;
    promise.catch(() => {}).then(() => {
      const current = this.state.bots.find((item) => item.id === sender.id);
      if (!current) return;
      const reply = latestReply(this.home, target, startedAt);
      const about = oneLine(asked, 140);
      const text = reply
        ? `Reply to your earlier message ("${about}"):\n\n${reply}`
        : `${target.name} finished your earlier request ("${about}") without a written reply. Look at its thread if you need details.`;
      if (relay > MAX_RELAYS || current.status === "off") {
        const message = { id: crypto.randomUUID(), role: "assistant", kind: "mention", content: text, at: Date.now(), source: "bot", fromBotId: target.id, fromBotName: target.name };
        appendConversation(this.home, current, [message]);
        this.emit(current, { type: "mention.reply", message });
        return;
      }
      this.enqueue(current, { text, source: "bot", fromBotId: target.id, fromBotName: target.name, chain: [], relay }).promise.catch(() => {});
    }).catch(() => {});
  }

  #scheduleCompaction(bot) {
    if (this.compacting.has(bot.id)) return;
    const conversation = readConversation(this.home, bot);
    if (!shouldCompact(conversation)) return;
    this.compact(bot).catch(() => {});
  }

  async compact(bot, { force = false } = {}) {
    if (this.compacting.has(bot.id)) return { compacted: false, removed: 0, kept: 0, busy: true };
    this.compacting.add(bot.id);
    try {
      const apiKey = this.modelKey(bot);
      const providerBot = { ...bot, model: { ...bot.model, apiKey } };
      const result = await compactConversation({
        bot,
        providerBot,
        home: this.home,
        directory: workspacePath(this.home, bot),
        signal: undefined,
        waitForDecision: (requestId, signal, meta) => this.waitForDecision(bot, requestId, signal, meta),
        saveState: this.saveState,
        aiMemory: this.aiMemory,
        force,
        emit: (event) => this.emit(bot, event),
      });
      return result;
    } finally {
      this.compacting.delete(bot.id);
    }
  }

  async #vaultContext(bot, text) {
    try {
      return await this.vault.contextForBot(bot, text, { profile: this.profilePath?.() || "" });
    } catch {
      return null;
    }
  }

  // Tells the user when work they did not watch is done. Never blocks the turn.
  #notifyEnd(bot, input, outcome, newMessages, asked = []) {
    if (!this.notifications) return;
    const source = input.source || "chat";
    const base = { botId: bot.id, botName: bot.name, url: `/?bot=${bot.id}` };
    let note = null;
    // A question waits for the user: it reaches them unless they are looking at this thread right now.
    if (asked.length && outcome.status === "ok" && (source !== "chat" && source !== "voice" || !this.isWatching(bot.id))) {
      note = { kind: "question", title: "has a question", body: asked.map((item) => item.question).join("\n").slice(0, 400), tag: `question-${bot.id}`, priority: "high" };
    } else if (source === "job") {
      const job = bot.jobs.find((item) => item.id === input.jobId);
      const once = Boolean(job && Number(job.at));
      const name = input.jobName || job?.name || "Scheduled job";
      if (outcome.status === "ok") {
        if ((job && job.notify === false) || outcome.quiet) return;
        note = { kind: once ? "reminder" : "routine", title: name, body: summaryOf(newMessages, 400), tag: `job-${input.jobId}` };
      } else if (outcome.status === "error" || (outcome.status === "capped" && once)) {
        note = { kind: "failure", title: `${name} failed`, body: outcome.error, priority: "high" };
      }
    } else if ((source === "chat" || source === "proposal" || source === "voice") && outcome.status === "ok" && !this.isWatching(bot.id)) {
      // Read as "<agent> is back", like the Inbox reads verb titles.
      note = { kind: "turn", title: "is back", body: summaryOf(newMessages, 400) };
    }
    if (note) this.notifications.notify({ ...base, ...note }).catch(() => {});
  }

  #finishJob(bot, jobId, status, summary, cost = null, quiet = false) {
    const job = bot.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.claimedAt = 0;
    job.lastStatus = status;
    job.lastSummary = String(summary || "").slice(0, 500);
    const spent = cost ? { turnId: cost.turnId, cost: cost.cost, tokens: cost.tokens, billing: cost.billing } : null;
    job.runs = [...(job.runs || []), { at: Date.now(), status, summary: job.lastSummary, ...(spent ? { spent } : {}), ...(quiet ? { quiet: true } : {}) }].slice(-12);
  }
}

function toApi(messages) {
  const out = [];
  for (const message of messages) {
    if (message.kind === "intro" || message.kind === "ack") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: withAttachments(message.content, message.attachments) });
    } else if (message.role === "assistant") {
      const item = { role: "assistant", content: message.content || null };
      if (message.toolCalls?.length) {
        item.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
        if (!item.content) item.content = null;
      }
      out.push(item);
    } else if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content || "" });
    }
  }
  return out;
}

function trimHistory(conversation) {
  let total = 0;
  const out = [];
  for (const message of [...conversation].reverse()) {
    if (message.kind === "ack") continue;
    const size = String(message.content || "").length + 200;
    if (out.length >= 80 || total + size > MAX_CONTEXT_CHARS) break;
    total += size;
    out.push(message);
  }
  return out.reverse();
}

function recentHistory(conversation) {
  return conversation.filter((message) => message.kind !== "intro" && message.kind !== "ack").slice(-12).map((message) => `${message.role === "user" ? "User" : "You"}: ${String(message.content || "").slice(0, 1200)}`).join("\n");
}

function titleFrom(conversation) {
  const first = conversation.find((message) => message.role === "user");
  return first ? titleCase(first.content) : "Ravnir";
}

function titleCase(value) {
  const line = String(value || "").trim().split("\n")[0] || "Thread";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

function lastReply(messages) {
  return [...messages].reverse().find((message) => message.role === "assistant" && message.content)?.content || "";
}

function summaryOf(messages, limit = 300) {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.content);
  return assistant ? assistant.content.slice(0, limit) : "Finished.";
}

function dollars(value) {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function clip(text) {
  const value = String(text ?? "");
  if (value.length <= TOOL_OUTPUT_LIMIT) return value;
  return `${value.slice(0, TOOL_OUTPUT_LIMIT)}\n…truncated`;
}
