import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findSecret } from "./vault/secrets.js";

// Finish the job without nagging (docs/launch-plan.md, P0.6).
//
// An agent asks the user through ask_user, never by guessing in prose. The server keeps every question
// in asks.json and:
//   - refuses a question this agent already asked and the user has not answered yet;
//   - hands back the answer when this agent asked it before (other agents learn facts about the owner from
//     the vault, which the agent writes after it judged the reply really answers);
//   - sends the agent back to look first when its saved logins, plugins, connectors, memory or the vault
//     may already hold what it needs;
//   - counts failed attempts per target in each turn, refuses an unchanged retry of a call that just
//     failed, and tells the agent to stop and ask after three different attempts.
// The user's next message in that agent's thread answers its open questions.

const KEEP = 500;
// An unanswered question stops blocking a repeat after a week: the work has moved on.
const OPEN_DAYS = 7;
const ABOUT = ["access", "owner", "detail", "decision"];
// Plain retries of a call that just failed are refused unless the failure looked temporary, and then once.
const TRANSIENT = /\b(timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|temporar|try again|rate.?limit|429|50[234])\b/i;
// After this many failed attempts on one target the agent is told to stop and ask; after twice that, calls
// on the target are refused for the rest of the turn.
export const ATTEMPTS_BEFORE_ASKING = 3;
const HARD_STOP = ATTEMPTS_BEFORE_ASKING * 2;

const STOP = new Set(("a an and are as at be but by can could do does for from have how i if in into is it its me my "
  + "need needs no not of on or our please should so that the their them then there these this to us use was we what "
  + "when where which who why will with would you your yours "
  + "el la los las un una unos unas y o de del al en para por con sin que como cual cuál es son mi mis tu tus su sus "
  + "me te se lo le les nos este esta esto ese esa eso hay").split(" "));

// Ways to say "login", so "GitHub sign-in" and "GitHub login" are the same need.
const LOGIN = /\b(?:sign|log)[\s-]?(?:in|on)\b|\bcredentials?\b|\binicio de sesion\b|\biniciar sesion\b/g;

export function words(text) {
  return [...new Set(String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(LOGIN, "login")
    .split(/[^a-z0-9@.]+/).map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word.length > 1 && !STOP.has(word)))];
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  return a.filter((word) => set.has(word)).length / Math.min(a.length, b.length);
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  const shared = a.filter((word) => set.has(word)).length;
  return shared / (a.length + b.length - shared);
}

// Two questions are the same when they need the same thing, or are mostly the same words.
export function sameAsk(a, b) {
  const needA = words(a.need);
  const needB = words(b.need);
  if (needA.length && needB.length && overlap(needA, needB) >= 0.75) return true;
  return jaccard(words(a.question), words(b.question)) >= 0.5;
}

const oneLine = (text, max) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);

function dayOf(at) {
  return new Date(at).toISOString().slice(0, 10);
}

export class AskBook {
  constructor({ home, now = Date.now }) {
    this.file = path.join(home, "asks.json");
    this.now = now;
    this.records = this.#load();
  }

  // Open questions past their week are closed as expired, so they stop blocking.
  #expire() {
    const cutoff = this.now() - OPEN_DAYS * 86_400_000;
    let changed = false;
    for (const record of this.records) {
      if (record.status === "open" && record.at < cutoff) {
        record.status = "expired";
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  list({ status = "", botId = "" } = {}) {
    this.#expire();
    return this.records.filter((item) => (!status || item.status === status) && (!botId || item.botId === botId));
  }

  open(botId = "") {
    return this.list({ status: "open", botId });
  }

  // What this agent asked before that matches this question, newest first. Answers stay with the agent
  // that asked: a reply in its thread is not shared as a fact until the agent saves it to the vault.
  previous(bot, ask) {
    this.#expire();
    return [...this.records].reverse().find((item) => item.botId === bot.id && !["expired", "dismissed"].includes(item.status) && sameAsk(item, ask)) || null;
  }

  // The agent says the reply it got did not answer this: the old record stops counting.
  dismiss(record) {
    record.status = "dismissed";
    this.#save();
  }

  create({ bot, turnId = "", question, need, about, tried = "", runnerTried = "" }) {
    const record = {
      id: crypto.randomUUID(),
      botId: bot.id,
      botName: bot.name,
      turnId,
      question: hideSecret(question),
      need: hideSecret(need),
      about,
      tried: hideSecret(tried),
      runnerTried: hideSecret(runnerTried),
      status: "open",
      at: this.now(),
      answer: "",
      answeredAt: 0,
    };
    this.records.push(record);
    this.records = this.records.slice(-KEEP);
    this.#save();
    return record;
  }

  // The user's next message in the agent's thread answers what it asked; from Home, the user answers
  // one question by its id. The reply to a question about access (a login, a key) is never kept, and
  // neither is anything that looks like a secret: the agent has it in its thread.
  answer(botId, text, turnId = "", ids = null) {
    const open = this.open(botId).filter((record) => !ids || ids.includes(record.id));
    if (!open.length) return [];
    const body = String(text || "").trim().slice(0, 1000);
    const secret = Boolean(findSecret(body));
    for (const record of open) {
      const keep = !secret && record.about !== "access";
      record.status = "answered";
      record.answer = keep ? body : "";
      record.secret = keep ? undefined : true;
      record.answeredAt = this.now();
      record.answerTurnId = turnId;
    }
    this.#save();
    return open;
  }

  // Clear chat starts the thread over: what it asked is no longer waiting.
  closeFor(botId) {
    let changed = false;
    for (const record of this.records) {
      if (record.botId === botId && record.status === "open") {
        record.status = "expired";
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  // The agent was deleted: its questions go too.
  forget(botId) {
    const before = this.records.length;
    this.records = this.records.filter((item) => item.botId !== botId);
    if (this.records.length !== before) this.#save();
  }

  #load() {
    try {
      const records = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(records) ? records.slice(-KEEP) : [];
    } catch {
      return [];
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.records, null, 1), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}

// ---- Attempts in one turn ---------------------------------------------------------------

// What a call is aimed at, so failures on the same site, login, command or plugin add up.
export function targetOf(name, args = {}) {
  const host = (value) => {
    try {
      return new URL(String(value)).host.replace(/^www\./, "");
    } catch {
      return String(value || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
    }
  };
  const bare = String(name || "").replace(/^(ravnir|truebot)_/, "");
  if (/^(browser_open|web_fetch)$/.test(bare) && args.url) return `site ${host(args.url)}`;
  if (bare === "browser_saved_login" || bare === "browser_login") return `login ${host(args.site || args.url)}`;
  if (bare === "run_command" || bare === "mac_run" || bare === "bash") {
    const parts = String(args.command || "").trim().split(/\s+/).filter((part) => !/^(sudo|env|[A-Z_]+=\S*)$/.test(part));
    const head = parts[0] || "";
    const sub = parts[1] && /^[a-z][a-z-]*$/.test(parts[1]) && /^(git|gh|npm|npx|pnpm|yarn|docker|podman|ssh|op|uv|pip|cargo|kubectl)$/.test(head) ? ` ${parts[1]}` : "";
    return `command ${head}${sub}`;
  }
  if (bare.includes("__")) return `plugin ${bare.split("__")[0]}`;
  if (bare.startsWith("mcp_")) return `connector ${bare.split("__")[0].slice(4) || bare}`;
  return `tool ${bare}`;
}

function signature(name, args) {
  const bare = String(name || "").replace(/^(ravnir|truebot)_/, "");
  return `${bare}\u0000${JSON.stringify(sorted(args || {}))}`;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}

// A command that ran but exited non-zero failed too, for the plain-retry rule only: fixing code and
// running the tests again is normal work, not a reason to stop and ask.
function exitFailure(name, text) {
  const bare = String(name || "").replace(/^(ravnir|truebot)_/, "");
  if (!/^(run_command|mac_run)$/.test(bare)) return false;
  const code = /\[exit (-?\d+)\]\s*$/.exec(String(text || ""));
  return Boolean(code && code[1] !== "0");
}

// Tools that only ask or look are never refused and never count.
const QUIET = new Set(["ask_user", "ask_user_to_take_over", "list_saved_logins", "list_jobs", "list_files", "box_info", "vault_search", "vault_read", "vault_links", "memory_search", "memory_read", "search_history", "read_history", "list_artifacts", "read_artifact", "computer_step", "mac_status", "list_groups"]);

export class TurnAttempts {
  constructor() {
    this.last = null;
    this.failures = new Map();
    this.log = [];
    this.seen = new Set();
    // Calls refused in this turn: unchanged retries and calls on a target that failed too often.
    this.refused = 0;
  }

  // Before a call: refuse an unchanged repeat of the call that just failed.
  before(name, args) {
    const bare = String(name || "").replace(/^(ravnir|truebot)_/, "");
    if (QUIET.has(bare)) return "";
    const target = targetOf(name, args);
    const failures = this.failures.get(target) || 0;
    if (failures >= HARD_STOP) {
      this.refused += 1;
      return `Not run: ${failures} attempts on ${target} failed in this turn. Stop working on it. Call ask_user with what you tried, or finish the rest and say what you could not do.`;
    }
    const last = this.last;
    if (!last || !last.failed || last.sig !== signature(name, args)) return "";
    if (last.transient && !last.retried) {
      last.retried = true;
      return "";
    }
    this.refused += 1;
    const count = this.failures.get(last.target) || 0;
    return `Not run: you just made exactly this call and it failed (${last.reason}). Running it again unchanged will fail the same way. Change the approach: another tool, another page or command, a saved login, or different input.${count ? ` (${count} failed ${count === 1 ? "attempt" : "attempts"} on ${last.target} so far.)` : ""}`;
  }

  // After a call: record it, and return a note to add to the tool's output when it failed.
  after(name, args, { error = false, text = "" } = {}) {
    const bare = String(name || "").replace(/^(ravnir|truebot)_/, "");
    if (QUIET.has(bare)) return "";
    const sig = signature(name, args);
    const retried = Boolean(this.last?.sig === sig && this.last.retried);
    const soft = !error && exitFailure(name, text);
    const failed = Boolean(error) || soft;
    const target = targetOf(name, args);
    const reason = oneLine(String(text || "").replace(/^Error:\s*/, "").split("\n").filter(Boolean).find((line) => !line.startsWith("$ ")) || "it failed", 160);
    this.last = { sig, target, failed, transient: TRANSIENT.test(String(text || "")), retried, reason };
    if (!error) return "";
    const count = (this.failures.get(target) || 0) + 1;
    this.failures.set(target, count);
    this.log.push(`${bare} on ${target.replace(/^\w+ /, "")}: ${reason}`);
    return attemptNote(target, count, reason);
  }

  // OpenCode's own tools (bash, edit, webfetch) run outside Ravnir; their results still count.
  observe(event) {
    if (event?.type !== "tool" || !["completed", "error"].includes(event.status)) return;
    const name = String(event.name || "");
    if (/^(ravnir|truebot)_/.test(name)) return;
    const key = `${event.id || ""}:${event.status}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.after(name, event.input || {}, { error: event.status === "error", text: event.output || "" });
  }

  failed() {
    return [...this.failures.values()].reduce((sum, value) => sum + value, 0);
  }

  // What the runner saw fail in this turn, for the question's "tried" line.
  summary() {
    return this.log.slice(-6).join("; ");
  }
}

export function attemptNote(target, count, reason = "") {
  // A rejected saved login does not fix itself: retrying it only locks the account. A page that
  // only had no password field (yet) is not a rejected login, so it gets the normal note.
  if (count === 1 && target.startsWith("login ") && !/no password field|asks for the email first/i.test(reason)) return `\n\n[Ravnir: the saved login for ${target.slice(6)} was rejected. Retrying it will not help. Use another saved login if one fits; otherwise call ask_user (about: access) so the user can fix the login.]`;
  if (count === 1) return `\n\n[Ravnir: first failed attempt on ${target}. Try a different approach before asking the user.]`;
  if (count < ATTEMPTS_BEFORE_ASKING) return `\n\n[Ravnir: ${count} failed attempts on ${target}. Try one more, different approach (another tool or page, a saved login, the vault) before asking.]`;
  return `\n\n[Ravnir: ${count} failed attempts on ${target}. Stop retrying it. If you cannot finish another way, call ask_user with what you tried.]`;
}

// ---- Look before asking ------------------------------------------------------------------

const GENERIC_HOST = new Set(["www", "com", "org", "net", "app", "dev", "login", "accounts", "auth"]);

// What the agent already has that might answer the question: saved logins (1Password links included),
// plugins, connectors, its own memory and the vault.
export async function lookFirst(bot, ask, { vault = null, plugins = null } = {}) {
  const needWords = words(`${ask.need} ${ask.question}`);
  if (!needWords.length) return [];
  const enough = (candidate) => {
    const shared = needWords.filter((word) => candidate.includes(word)).length;
    return shared >= Math.min(2, words(ask.need).length || 1);
  };
  const out = [];
  for (const entry of bot.vault || []) {
    // A site matches by its name without the dots: "github.com" is "github" too.
    const site = String(entry.site || "").toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
    const text = [...words(`${entry.site} ${entry.label || ""} ${entry.username || ""}`), ...site.split(/[.:-]/).filter((part) => part.length > 2 && !GENERIC_HOST.has(part))];
    if (needWords.some((word) => text.includes(word) || (word.includes(".") && site.includes(word)))) {
      out.push(`Saved login: ${entry.site}${entry.username ? ` as ${entry.username}` : ""}${entry.source === "1password" ? " (1Password)" : ""}. Use browser_saved_login.`);
    }
  }
  for (const plugin of plugins?.promptInfo?.(bot) || []) {
    if (needWords.some((word) => words(`${plugin.id} ${plugin.name}`).includes(word))) out.push(`Plugin: ${plugin.name}. Its tools are in your tool list.`);
  }
  for (const connector of bot.connectors || []) {
    if (connector.enabled && needWords.some((word) => words(connector.name).includes(word))) out.push(`Connector: ${connector.name}.`);
  }
  for (const item of bot.memory || []) {
    if (enough(words(item.text))) out.push(`Your memory: ${oneLine(item.text, 200)}`);
  }
  if (vault?.available) {
    const hits = await vault.search(`${ask.need} ${ask.question}`, { limit: 5 }).catch(() => []);
    for (const hit of hits) {
      if (!enough(words(`${hit.title || ""} ${hit.heading || ""} ${hit.text || ""}`))) continue;
      out.push(`Vault: ${hit.path}${hit.heading ? ` (${hit.heading})` : ""}: ${oneLine(hit.text, 220)}`);
      if (out.filter((line) => line.startsWith("Vault:")).length >= 3) break;
    }
  }
  return out.slice(0, 8);
}

// ---- The tool -----------------------------------------------------------------------------

export const ASK_TOOL = {
  name: "ask_user",
  description: "Ask the user one question when you cannot finish without them. First look: your saved logins, plugins, connectors, memory and the vault. Try at least two different approaches for anything that failed. Then call this once, with what you tried. It refuses a question you already asked and the user has not answered, and returns the answer when the question was answered before. When it says the question is sent, end your turn: your reply is the question.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, in one or two sentences, in the user's language." },
      need: { type: "string", description: "What you need from the user as a short noun phrase, for example \"GitHub token for the deploy repo\" or \"preferred airline\"." },
      about: { type: "string", enum: ABOUT, description: "access: a login, key or permission. owner: a fact about the user (a preference, an address, a name). detail: a missing detail of this task. decision: a choice that is the user's to make." },
      tried: { type: "string", description: "What you already checked and tried, in one or two sentences." },
      again: { type: "boolean", description: "Set only when ask_user gave you an earlier reply that does not answer this question." },
    },
    required: ["question", "need", "about"],
    additionalProperties: false,
  },
};

export async function askUser(args, ctx) {
  const { bot, asks, engine, vault, plugins } = ctx;
  if (!asks) return { text: "Questions are not tracked on this server. Ask in your reply, once, and say what you tried." };
  const ask = {
    question: oneLine(args.question, 600),
    need: oneLine(args.need, 120),
    about: ABOUT.includes(args.about) ? args.about : "detail",
    tried: oneLine(args.tried, 600),
  };
  if (!ask.question) throw new Error("ask_user needs a question.");
  if (!ask.need) ask.need = ask.question.slice(0, 120);
  const active = engine?.active?.get(bot.id) || null;
  const turn = active ? (active.asking ||= { asks: [], looked: new Set(), blocked: 0, bounced: 0, reused: 0 }) : null;

  // Asked already in this turn.
  if (turn?.asks.some((item) => sameAsk(item, ask))) {
    return { text: "You already asked this in this turn. End your turn now: your reply is the question." };
  }
  let before = asks.previous(bot, ask);
  // The agent read the earlier reply and it did not answer the question: that record stops counting.
  if (before?.status === "answered" && args.again === true) {
    asks.dismiss(before);
    before = null;
  }
  if (before?.status === "answered") {
    if (turn) turn.reused += 1;
    if (before.secret || !before.answer) {
      return { text: `You asked this on ${dayOf(before.at)} and the user replied in your thread (the reply is not kept here because it was about access or looked like a secret). Use what they said there, or the saved login, instead of asking again.` };
    }
    return { text: `You asked this on ${dayOf(before.at)} ("${oneLine(before.question, 200)}") and the user replied: "${before.answer}". Use that answer and continue. Only if that reply does not answer this question, call ask_user again with again: true.` };
  }
  if (before?.status === "open") {
    if (turn) turn.blocked += 1;
    return { text: `Not sent: you already asked this on ${dayOf(before.at)} ("${oneLine(before.question, 200)}") and the user has not answered yet. Do not ask again. Do everything you can without it, then end your reply with a short status: what you tried, where you are stuck, and that you are still waiting for ${before.need}.` };
  }

  // Look before asking: once per need in a turn, unless it is the user's decision.
  const key = words(ask.need).join(" ") || ask.question;
  if (ask.about !== "decision" && !(turn?.looked.has(key))) {
    turn?.looked.add(key);
    const found = await lookFirst(bot, ask, { vault, plugins });
    if (found.length) {
      if (turn) turn.bounced += 1;
      return { text: `Not sent yet. You may already have this:\n${found.map((line) => `- ${line}`).join("\n")}\nTry these first. If none of them works, call ask_user again and say in tried what you checked.` };
    }
  }

  const runnerTried = active?.attempts?.summary() || "";
  const record = asks.create({ bot, turnId: active?.turnId || "", ...ask, runnerTried });
  turn?.asks.push(record);
  engine?.emit?.(bot, { type: "ask", ask: publicAsk(record), ...(active ? { turnId: active.turnId } : {}) });
  return {
    text: "Question sent. End your turn now: your reply is this question in a sentence or two, plus one short line on what you tried if it helps. A choice block is fine when there are clear options. The user's next message is the answer.",
    activity: "Asking the user",
  };
}

// What the thread, Home and the API show of a question.
export function publicAsk(record) {
  return {
    id: record.id,
    botId: record.botId,
    botName: record.botName,
    question: record.question,
    need: record.need,
    about: record.about,
    tried: [record.tried, record.runnerTried].filter(Boolean).join(" Ravnir saw: "),
    status: record.status,
    at: record.at,
    ...(record.status === "answered" ? { answeredAt: record.answeredAt } : {}),
  };
}

// A reply that ends by asking the user something counts as a question, even without ask_user:
// a last line that ends with a question mark, or a choice card.
export function endsWithQuestion(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/```choice\b[\s\S]*```\s*$/.test(value)) return true;
  const last = value.replace(/```[\s\S]*?```/g, "").trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) || "";
  return /[?？]["'”»)*_]*$/.test(last);
}

// The questions one turn put to the user, for its ledger row.
export function countAsks({ asking = null, takeovers = 0, reply = "", refused = 0 } = {}) {
  const tool = asking?.asks?.length || 0;
  const text = tool || takeovers ? 0 : endsWithQuestion(reply) ? 1 : 0;
  return {
    asks: tool + takeovers + text,
    // blocked: repeat questions refused; bounced: sent to look first; reused: earlier answers given back;
    // refused: tool calls refused as unchanged retries or on a target that failed too often.
    askDetail: { tool, takeover: takeovers, text, blocked: asking?.blocked || 0, bounced: asking?.bounced || 0, reused: asking?.reused || 0, refused },
  };
}

// Text that looks like a secret is not kept or shown.
function hideSecret(text) {
  return text && findSecret(text) ? "[hidden: looked like a secret]" : text;
}

// A fact about the owner that the user gave as an answer, as one line for the vault profile.
export function ownerFact(record) {
  const need = oneLine(record.need, 80).replace(/[.:;,\s]+$/, "");
  const answer = oneLine(record.answer, 200);
  if (!need || !answer) return null;
  const key = words(need).join("-").replace(/[^a-z0-9-]/g, "").slice(0, 40).replace(/-+$/, "");
  return { fact: `${need.charAt(0).toUpperCase()}${need.slice(1)}: ${answer}`, key: /^[a-z0-9-]{1,40}$/.test(key) ? key : "" };
}
