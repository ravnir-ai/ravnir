#!/usr/bin/env node
// Runs the evals suite (evals/tasks.mjs) on one or more models and writes what happened.
//
//   node evals/run.mjs --models opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash
//   node evals/run.mjs --models opencode-go/glm-5.3-flash --tasks order-status,fix-test --concurrency 2
//
// Every task runs alone: its own Ravnir server in a throwaway data folder (a local notes vault seeded
// with evals/tasks.mjs VAULT_NOTES, owner "Alex", English layout), its own Northwind demo site and one
// agent, so no task can lean on another task's agent, login or page visits. Models run through an
// OpenCode the runner starts with an empty config (the machine's OpenCode logins, none of its global
// MCP servers or instructions); --opencode URL uses a running one instead (password from
// RAVNIR_EVAL_OPENCODE_PASSWORD). The runner plays the user: it approves what the agent asks to run,
// rejects a browser hand-over, and answers at most two questions per task.
// Results: evals/results/<run>/<model>.json and report.md (node evals/report.mjs <run dir> rebuilds it).

import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tasks as SUITE_TASKS, VAULT_NOTES } from "./tasks.mjs";
import { tasks as researchTasks } from "./capability/research.mjs";
import { tasks as judgmentTasks } from "./capability/judgment.mjs";
import { tasks as writingTasks } from "./capability/writing.mjs";
import { tasks as dataTasks } from "./capability/data.mjs";
import { tasks as codeTasks } from "./capability/code.mjs";

// The report card suite plus the capability card's own tasks (evals/axes.mjs), so --tasks reaches both.
export const ALL_TASKS = [...SUITE_TASKS, ...researchTasks, ...judgmentTasks, ...writingTasks, ...dataTasks, ...codeTasks];
import { startSite } from "./site.mjs";
import { writeReport } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_ANSWER = "I don't have more details than that. Use your best judgment and finish it.";
const MAX_ANSWERS = 2;

export async function runSuite({ models, taskIds = [], opencode = "", opencodePassword = "", concurrency = 3, merge = false, turnTimeoutMs = 8 * 60_000, out = path.join(HERE, "results", stamp()), tasks = SUITE_TASKS, log = console.log, keepHome = false } = {}) {
  // Named tasks come from everything; with no names, the report card suite runs.
  const chosen = taskIds.length ? ALL_TASKS.filter((task) => taskIds.includes(task.id)) : tasks;
  if (!chosen.length) throw new Error(`No tasks match ${taskIds.join(", ")}.`);
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const own = !opencode && models.some((model) => model.provider === "opencode") ? await startOpenCode() : null;
  try {
    for (const model of models) {
      log(`\n${label(model)}: ${chosen.length} tasks`);
      let result = await runModel({ model, tasks: chosen, opencode: own?.url || opencode, opencodePassword, concurrency, turnTimeoutMs, log, keepHome });
      const file = path.join(out, `${fileName(label(model))}.json`);
      // --merge reruns some tasks and keeps the model's other results from the same folder.
      if (merge && fs.existsSync(file)) {
        const before = JSON.parse(fs.readFileSync(file, "utf8"));
        const rerun = new Set(result.tasks.map((row) => row.task));
        const rows = [...before.tasks.filter((row) => !rerun.has(row.task)), ...result.tasks];
        rows.sort((a, b) => tasks.findIndex((task) => task.id === a.task) - tasks.findIndex((task) => task.id === b.task));
        result = { ...before, tasks: rows, summary: summarize(rows), rerun: [...(before.rerun || []), { at: result.startedAt, tasks: [...rerun] }] };
      }
      fs.writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
      results.push(result);
    }
  } finally {
    own?.stop();
  }
  writeReport(out);
  log(`\nResults in ${path.relative(process.cwd(), out) || out}`);
  return { out, results };
}

// `agent` copies an agent's own setup (name, job, instructions, skills) onto every task's agent, which
// is how the capability card measures one agent rather than a bare model. `onRow` hears each result.
export async function runModel({ model, tasks, opencode, opencodePassword = "", concurrency = 3, turnTimeoutMs = 8 * 60_000, log = console.log, keepHome = false, agent = null, onRow = null, shouldStop = null }) {
  const template = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-evals-vault-"));
  seedVault(path.join(template, "vault"));
  const restore = setEnv({
    RAVNIR_VAULT: "local",
    RAVNIR_AI_MEMORY: "off",
    RAVNIR_QUICK: "off",
    RAVNIR_OPENCODE_URL: model.provider === "opencode" ? opencode : undefined,
    RAVNIR_OPENCODE_PASSWORD: model.provider === "opencode" ? opencodePassword || undefined : undefined,
    RAVNIR_OPENCODE: undefined,
    RAVNIR_VAULT_DIR: undefined,
    RAVNIR_PUBLIC_URL: undefined,
    RAVNIR_USER: undefined,
    RAVNIR_PASSWORD: undefined,
    RAVNIR_STATUS_FEEDS: undefined,
  });
  const { createApp } = await import("../server/index.js");
  const startedAt = Date.now();
  const rows = [];
  const homes = [];
  try {
    const queue = [...tasks];
    const worker = async () => {
      while (queue.length && !shouldStop?.()) {
        const task = queue.shift();
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-evals-"));
        homes.push(home);
        fs.cpSync(path.join(template, "vault"), path.join(home, "vault"), { recursive: true });
        const row = await isolated({ createApp, home }, (base, site) => runTask({ task, model, base, home, site, turnTimeoutMs, agent }))
          .catch((error) => ({ task: task.id, title: task.title, tags: task.tags, expectAsks: task.expectAsks || 0, finished: false, why: `runner error: ${error.message}`, error: error.message, asks: 0, cost: 0, tokens: 0, turns: 0, durationMs: 0 }));
        rows.push(row);
        onRow?.(row);
        log(`  ${row.finished ? "pass" : "FAIL"} ${task.id.padEnd(18)} asks ${row.asks} cost $${(row.cost || 0).toFixed(4)} ${Math.round((row.durationMs || 0) / 1000)}s  ${row.why}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  } finally {
    restore();
    if (!keepHome) for (const dir of [template, ...homes]) fs.rmSync(dir, { recursive: true, force: true });
  }
  rows.sort((a, b) => tasks.findIndex((task) => task.id === a.task) - tasks.findIndex((task) => task.id === b.task));
  return { model: label(model), provider: model.provider, startedAt, durationMs: Date.now() - startedAt, homes: keepHome ? homes : [], tasks: rows, summary: summarize(rows) };
}

// One task's world: a Ravnir server on its own data folder and its own demo site, closed afterwards.
async function isolated({ createApp, home }, run) {
  const server = createApp({ home, projectRoot: ROOT });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const site = await startSite();
  try {
    await api(base, "PUT", "/api/settings", { owner: { name: "Alex", language: "en" }, vault: { layout: "en" } });
    await waitFor(async () => (await api(base, "GET", "/api/state")).vault?.writer?.available, { tries: 300 });
    return await run(base, site);
  } finally {
    await site.close().catch(() => {});
    server.closeAllConnections?.();
    await closeApp(server);
  }
}

// An OpenCode server for the run: the machine's OpenCode logins and data, but an empty config folder,
// so the user's own MCP servers, plugins and instructions stay out of the agents' way.
export async function startOpenCode() {
  const bin = [process.env.RAVNIR_EVAL_OPENCODE_BIN, path.join(os.homedir(), ".opencode/bin/opencode"), "opencode"].find((item) => item && (item === "opencode" || fs.existsSync(item)));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-evals-opencode-"));
  const port = await freePort();
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, XDG_CONFIG_HOME: config, OPENCODE_SERVER_PASSWORD: "" },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = () => {
    child.kill("SIGTERM");
    fs.rmSync(config, { recursive: true, force: true });
  };
  try {
    await waitFor(async () => (await fetch(`${url}/provider`)).ok, { tries: 120, delay: 500 });
  } catch {
    stop();
    throw new Error(`OpenCode did not start on ${url} (${bin}).`);
  }
  return { url, stop };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function runTask({ task, model, base, home, site, turnTimeoutMs, agent: setup = null }) {
  const started = Date.now();
  const modelBody = model.provider === "opencode"
    ? { via: "opencode", model: model.model }
    : { provider: "openai", baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey || "" };
  const agent = (await api(base, "POST", "/api/bots", setup
    ? { name: setup.name || `Eval ${task.id}`, job: setup.job || "", prompt: setup.prompt || "", skills: setup.skills || [], model: modelBody }
    : { name: `Eval ${task.id}`, job: "Personal assistant for Alex: errands on the web, accounts, files, small code fixes, reminders and notes.", model: modelBody })).bot;
  // The runner is the user: terminal, files and saved logins run without asking, as a trusting owner would set them.
  await api(base, "PATCH", `/api/bots/${agent.id}`, { policy: { shell: "allow", files: "allow", logins: "allow", plugins: "allow" } });
  const { workspacePath, readConversation, writeConversation } = await import("../server/state.js");
  const botRef = { id: agent.id };
  const workspace = workspacePath(home, botRef);
  const ticketsFile = path.join(home, `tickets-${task.id}.json`);
  const ctx = {
    site: site.url,
    siteLog: () => site.log(),
    workspace,
    ticketsFile,
    ticketsServer: path.join(HERE, "tickets-mcp.mjs"),
    now: started,
    replies: [],
    reply: "",
    asks: 0,
    addLogin: (entry) => api(base, "POST", `/api/bots/${agent.id}/vault`, entry),
    addConnector: (def) => api(base, "POST", `/api/bots/${agent.id}/connectors`, def),
    writeWorkspace: (rel, text) => {
      const file = path.join(workspace, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    readWorkspace: (rel) => {
      try {
        return fs.readFileSync(path.join(workspace, rel), "utf8");
      } catch {
        return "";
      }
    },
    readVault: (rel) => {
      try {
        return fs.readFileSync(path.join(home, "vault", rel), "utf8");
      } catch {
        return "";
      }
    },
    seedThread: (messages) => writeConversation(home, botRef, [...readConversation(home, botRef), ...messages.map((message, index) => ({ id: `seed-${index}`, at: started - 60_000 + index, source: "chat", ...message }))]),
    bot: async () => (await api(base, "GET", `/api/bots/${agent.id}`)).bot || (await api(base, "GET", `/api/bots/${agent.id}`)),
    run: (command, rel = ".") => new Promise((resolve) => {
      execFile("/bin/sh", ["-c", command], { cwd: path.join(workspace, rel), timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}${stderr}` }));
    }),
  };
  if (task.setup) await task.setup(ctx);

  let text = await task.prompt(ctx);
  let answered = 0;
  let approvals = 0;
  let handovers = 0;
  let timedOut = false;
  for (;;) {
    const sentAt = Date.now();
    const { turnId } = await api(base, "POST", `/api/bots/${agent.id}/messages`, { text });
    const ended = await waitTurn(base, agent.id, turnId, turnTimeoutMs, async (request) => {
      if (request.kind === "takeover") {
        handovers += 1;
        return "reject";
      }
      approvals += 1;
      return "once";
    });
    if (!ended) {
      timedOut = true;
      await api(base, "POST", `/api/bots/${agent.id}/stop`, {}).catch(() => {});
      await waitTurn(base, agent.id, turnId, 30_000, async () => "reject").catch(() => {});
    }
    const conversation = readConversation(home, botRef);
    // This turn's own reply: not the plan, not the agent's intro, nothing from before the turn.
    const reply = conversation.filter((message) => message.role === "assistant" && message.kind !== "ack" && message.kind !== "intro" && message.content && message.at >= sentAt).at(-1);
    if (reply?.content) ctx.replies.push(reply.content);
    const row = readLedger(home).find((item) => item.id === turnId);
    if (timedOut || !row || row.status !== "ok" || !(row.asks > 0) || answered >= MAX_ANSWERS) break;
    text = task.answers?.[answered] || DEFAULT_ANSWER;
    answered += 1;
  }
  ctx.reply = ctx.replies.at(-1) || "";
  const ledger = readLedger(home).filter((item) => item.botId === agent.id);
  const usage = ledger.reduce((sum, item) => ({
    cost: sum.cost + (Number(item.usage?.cost) || 0),
    tokens: sum.tokens + ["input", "output", "reasoning", "cacheWrite"].reduce((total, key) => total + (Number(item.usage?.[key]) || 0), 0),
    cacheRead: sum.cacheRead + (Number(item.usage?.cacheRead) || 0),
  }), { cost: 0, tokens: 0, cacheRead: 0 });
  const detail = (key) => ledger.reduce((sum, item) => sum + (Number(item.askDetail?.[key]) || 0), 0);
  ctx.asks = ledger.reduce((sum, item) => sum + (Number(item.asks) || 0), 0);
  let verdict;
  try {
    verdict = await task.check(ctx);
  } catch (error) {
    verdict = { ok: false, why: `check failed: ${error.message}` };
  }
  // A task finishes only with turns that ended cleanly and, when it needs the user, after asking.
  const failedTurns = ledger.filter((item) => item.status !== "ok");
  const missingAsk = ctx.asks < (task.expectAsks || 0);
  const why = timedOut
    ? `timed out; ${verdict.why}`
    : failedTurns.length ? `a turn ended ${failedTurns[0].status}: ${String(failedTurns[0].error || "").slice(0, 120)}; ${verdict.why}`
    : missingAsk ? `never asked the user; ${verdict.why}`
    : verdict.why;
  return {
    task: task.id,
    title: task.title,
    tags: task.tags || [],
    expectAsks: task.expectAsks || 0,
    finished: Boolean(verdict.ok) && !timedOut && !failedTurns.length && !missingAsk,
    why,
    asks: ctx.asks,
    extraAsks: Math.max(0, ctx.asks - (task.expectAsks || 0)),
    askedInText: detail("text"),
    blocked: detail("blocked"),
    retriesRefused: detail("refused"),
    lookFirst: detail("bounced"),
    reused: detail("reused"),
    answered,
    approvals,
    handovers,
    turns: ledger.length,
    errors: ledger.filter((item) => item.status === "error").map((item) => item.error).slice(0, 3),
    // Not one token came back: the provider stopped answering, which says nothing about the agent.
    noAnswer: !verdict.ok && usage.tokens === 0 && usage.cacheRead === 0 && (timedOut || failedTurns.length > 0),
    cost: round(usage.cost),
    tokens: usage.tokens,
    cacheRead: usage.cacheRead,
    durationMs: Date.now() - started,
    reply: ctx.reply.slice(0, 600),
  };
}

// Waits for the turn to end, deciding approvals for this agent as they come.
async function waitTurn(base, botId, turnId, timeoutMs, decide) {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  while (Date.now() < deadline) {
    const { events = [] } = await api(base, "GET", `/api/bots/${botId}/events?after=${after}`);
    for (const event of events) after = Math.max(after, Number(event.seq || event.cursor || 0));
    if (events.some((event) => event.type === "turn.end" && event.turnId === turnId)) return true;
    const { pending = [] } = await api(base, "GET", "/api/approvals");
    for (const request of pending.filter((item) => item.botId === botId)) {
      await api(base, "POST", `/api/approvals/${request.id}`, { decision: await decide(request) }).catch(() => {});
    }
    await sleep(1000);
  }
  return false;
}

export function summarize(rows) {
  const done = rows.filter((row) => row.finished).length;
  const asks = rows.map((row) => row.asks || 0);
  const extra = rows.map((row) => row.extraAsks || 0);
  return {
    tasks: rows.length,
    finished: done,
    finishRate: rows.length ? round(done / rows.length, 3) : 0,
    asksMean: round(mean(asks), 2),
    asksMedian: median(asks),
    extraAsksMean: round(mean(extra), 2),
    blocked: rows.reduce((sum, row) => sum + (row.blocked || 0), 0),
    retriesRefused: rows.reduce((sum, row) => sum + (row.retriesRefused || 0), 0),
    missedAsks: rows.filter((row) => /^never asked/.test(row.why || "")).length,
    cost: round(rows.reduce((sum, row) => sum + (row.cost || 0), 0)),
    costPerTask: rows.length ? round(rows.reduce((sum, row) => sum + (row.cost || 0), 0) / rows.length) : 0,
    medianSeconds: Math.round(median(rows.map((row) => row.durationMs || 0)) / 1000),
    timeouts: rows.filter((row) => /^timed out/.test(row.why || "")).length,
  };
}

function seedVault(dir) {
  // The same starter vault a fresh install gets, plus the notes the tasks rely on.
  execFileSync(process.execPath, ["--input-type=module", "-e", `import { ensureLocalVault } from ${JSON.stringify(path.join(ROOT, "server/vault/local.js"))}; ensureLocalVault(${JSON.stringify(dir)});`]);
  for (const [rel, text] of Object.entries(VAULT_NOTES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=Setup", "-c", "user.email=setup@ravnir.local", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
  git("add", "-A");
  git("commit", "--no-verify", "-q", "-m", "Evals: seed notes");
}

function readLedger(home) {
  try {
    return fs.readFileSync(path.join(home, "turns.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function setEnv(values) {
  const before = {};
  for (const [key, value] of Object.entries(values)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function closeApp(server) {
  // createApp's server stops its browsers, timers and managed processes on close.
  await new Promise((resolve) => server.close(() => resolve()));
  await server.shutdown?.().catch?.(() => {});
}

async function api(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname}: ${data.error || response.status}`);
  return data;
}

async function waitFor(check, { tries = 100, delay = 100 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(delay);
  }
  throw new Error("Timed out waiting.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const round = (value, digits = 6) => Math.round((value || 0) * 10 ** digits) / 10 ** digits;
const label = (model) => model.label || model.model;
const fileName = (value) => value.replace(/[^a-z0-9.-]+/gi, "_");

function stamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function parseArgs(argv) {
  const options = { models: [], taskIds: [], concurrency: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[++index] || "";
    if (flag === "--models") options.models = value().split(",").map((item) => item.trim()).filter(Boolean).map((id) => ({ provider: "opencode", model: id }));
    else if (flag === "--tasks") options.taskIds = value().split(",").map((item) => item.trim()).filter(Boolean);
    else if (flag === "--opencode") options.opencode = value();
    else if (flag === "--concurrency") options.concurrency = Math.max(1, Number(value()) || 1);
    else if (flag === "--out") options.out = path.resolve(value());
    else if (flag === "--turn-timeout") options.turnTimeoutMs = Math.max(30, Number(value()) || 480) * 1000;
    else if (flag === "--keep") options.keepHome = true;
    else if (flag === "--merge") options.merge = true;
    else if (flag === "--list") options.list = true;
    else throw new Error(`Unknown flag ${flag}. Use --models, --tasks, --opencode, --concurrency, --out, --turn-timeout, --keep, --merge or --list.`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const task of ALL_TASKS) console.log(`${task.id.padEnd(18)} ${task.title} [${task.tags.join(", ")}]${task.expectAsks ? ` (expects ${task.expectAsks} ask)` : ""}`);
    process.exit(0);
  }
  if (!options.models.length) {
    console.error("Give at least one model: --models opencode-go/deepseek-v4.1-flash");
    process.exit(2);
  }
  runSuite({ ...options, opencodePassword: process.env.RAVNIR_EVAL_OPENCODE_PASSWORD || "" })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
}
