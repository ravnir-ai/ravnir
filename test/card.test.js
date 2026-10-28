import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { startMock } from "../scripts/mock-openai.js";
import { AXES, scoreCard } from "../evals/axes.mjs";
import { cardTaskList } from "../evals/card.mjs";
import { ALL_TASKS, runModel } from "../evals/run.mjs";
import { createApp } from "../server/index.js";

test("every area of the card has tasks, and every task id is unique across the evals", () => {
  assert.equal(new Set(ALL_TASKS.map((task) => task.id)).size, ALL_TASKS.length, "two tasks share an id");
  const list = cardTaskList();
  for (const axis of AXES) {
    const mine = list.filter((task) => task.axis === axis.id);
    assert.ok(mine.length >= 3, `${axis.id} has ${mine.length} tasks`);
  }
  for (const task of list) {
    assert.equal(typeof task.check, "function", task.id);
    assert.equal(typeof task.prompt, "function", task.id);
  }
});

test("a card scores each area as the share of its tasks finished, and the overall as their mean", () => {
  const tasks = [
    { id: "a1", axis: "research" }, { id: "a2", axis: "research" },
    { id: "c1", axis: "code" }, { id: "c2", axis: "code" }, { id: "c3", axis: "code" }, { id: "c4", axis: "code" },
  ];
  const rows = [
    { task: "a1", finished: true, cost: 0.01, tokens: 100 },
    { task: "a2", finished: false, cost: 0.02, tokens: 50 },
    { task: "c1", finished: true }, { task: "c2", finished: true }, { task: "c3", finished: true }, { task: "c4", finished: false },
    // A second run of a1 counts too: three runs give a steadier score.
    { task: "a1", finished: true, cost: 0.01 },
  ];
  const card = scoreCard(rows, tasks);
  const by = Object.fromEntries(card.axes.map((axis) => [axis.id, axis]));
  assert.equal(by.research.score, 67);
  assert.equal(by.research.total, 3);
  assert.equal(by.code.score, 75);
  assert.equal(by.writing.score, null, "an area with no tasks is not scored, not zero");
  assert.equal(card.overall, 71);
  assert.equal(card.unanswered, 0);
  // A task the model never answered is not a failure of the agent: it is left out, not scored zero.
  const quiet = scoreCard([...rows, { task: "w1", finished: false, noAnswer: true, why: "timed out" }], [...tasks, { id: "w1", axis: "writing" }]);
  const writing = quiet.axes.find((axis) => axis.id === "writing");
  assert.equal(writing.score, null);
  assert.equal(writing.unanswered, 1);
  assert.match(writing.tasks[0].why, /did not answer/);
  assert.equal(quiet.overall, 71);
  assert.equal(quiet.unanswered, 1);
  assert.equal(card.cost, 0.04);
  assert.equal(card.tokens, 150);
});

test("the runner copies an agent's job, instructions and skills onto every task's agent", async () => {
  const mock = await startMock();
  try {
    const seen = [];
    const result = await runModel({
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
      tasks: [{
        id: "setup-copy",
        title: "Setup copy",
        tags: ["memory"],
        prompt: () => "hello",
        check: async (ctx) => {
          const bot = await ctx.bot();
          return { ok: bot.name === "Ledger" && bot.job === "Keeps the books." && bot.skills.includes("humanizer") && /Answer in one line/.test(bot.prompt), why: `${bot.name}, ${bot.skills.join(",")}` };
        },
      }],
      concurrency: 1,
      log: () => {},
      agent: { name: "Ledger", job: "Keeps the books.", prompt: "Answer in one line.", skills: ["humanizer"] },
      onRow: (row) => seen.push(row.task),
    });
    assert.equal(result.tasks[0].finished, true, result.tasks[0].why);
    assert.deepEqual(seen, ["setup-copy"]);
  } finally {
    await mock.close();
  }
});

// A stand-in for evals/card.mjs: prints progress, writes the result, exits.
function fakeCard({ exit = 0, overall = 62 } = {}) {
  const calls = [];
  const spawnCard = (args, env) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null));
    };
    calls.push({ args, env, child });
    const out = args[args.indexOf("--out") + 1];
    child.finish = () => {
      child.stdout.write('{"type":"start","total":2}\nsome warning from a server\n');
      child.stdout.write('{"type":"task","done":1,"total":2,"task":"fix-test","axis":"code","finished":true,"why":"tests pass"}\n');
      if (exit === 0) {
        const axes = AXES.map((axis) => ({ id: axis.id, label: axis.label, hint: axis.hint, score: axis.id === "code" ? 100 : null, finished: axis.id === "code" ? 1 : 0, total: axis.id === "code" ? 1 : 0, tasks: [] }));
        fs.writeFileSync(out, JSON.stringify({ version: 1, startedAt: Date.now(), durationMs: 5, model: "mock-model", provider: "openai", skills: ["humanizer"], runs: 1, tasks: 2, axes, overall, cost: 0.03, tokens: 10 }));
      }
      setImmediate(() => child.emit("close", exit));
    };
    return child;
  };
  return { spawnCard, calls };
}

async function call(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

test("a card runs as one child at a time, gets no server secrets, and is kept when it finishes", async () => {
  process.env.RAVNIR_AI_MEMORY = "off";
  const before = process.env.RAVNIR_MAC_TOKEN;
  process.env.RAVNIR_MAC_TOKEN = "secret-mac-token";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-card-"));
  const fake = fakeCard();
  const server = createApp({ home, spawnCard: fake.spawnCard });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const one = (await call(base, "POST", "/api/bots", { name: "Ledger", job: "Keeps the books.", model: { provider: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "mock-model", apiKey: "k-123" } })).data.bot;
    const two = (await call(base, "POST", "/api/bots", { name: "Scout", model: { provider: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "mock-model" } })).data.bot;

    const empty = await call(base, "GET", `/api/bots/${one.id}/card`);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.latest, null);
    assert.ok(empty.data.estimate.tasks >= 24);
    assert.ok(empty.data.estimate.ceiling >= empty.data.estimate.typical);

    const started = await call(base, "POST", `/api/bots/${one.id}/card`, { runs: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.running.mine, true);
    const [{ env, args, child }] = fake.calls;
    assert.equal(env.RAVNIR_MAC_TOKEN, undefined, "the run never sees the Mac token");
    assert.equal(env.RAVNIR_EVAL_API_KEY, "k-123", "the agent's own key goes by environment");
    const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
    assert.equal(config.name, "Ledger");
    assert.equal(JSON.stringify(config).includes("k-123"), false, "the key is not in the config file");

    const busy = await call(base, "POST", `/api/bots/${two.id}/card`, {});
    assert.equal(busy.status, 409, "one card at a time");
    assert.match(busy.data.error, /Ledger/);

    child.finish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = await call(base, "GET", `/api/bots/${one.id}/card`);
    assert.equal(done.data.running, null);
    assert.equal(done.data.latest.overall, 62);
    assert.equal(done.data.history.length, 1);
    assert.equal(done.data.latest.axes.find((axis) => axis.id === "code").score, 100);
    assert.equal(fs.existsSync(path.dirname(args[args.indexOf("--out") + 1])), false, "the run's folder is cleaned up");

    await call(base, "POST", `/api/bots/${two.id}/card`, {});
    const stopped = await call(base, "POST", `/api/bots/${two.id}/card/stop`, {});
    assert.equal(stopped.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await call(base, "GET", `/api/bots/${two.id}/card`);
    assert.equal(after.data.latest, null, "a stopped run keeps nothing");
    assert.equal(after.data.lastError, null, "and is not reported as a failure");
    assert.equal((await call(base, "POST", `/api/bots/${two.id}/card/stop`, {})).status, 409);
  } finally {
    if (before === undefined) delete process.env.RAVNIR_MAC_TOKEN;
    else process.env.RAVNIR_MAC_TOKEN = before;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a card stops after three tasks the model never answered, and scores nothing it did not measure", async () => {
  const { runCard } = await import("../evals/card.mjs");
  const events = [];
  const card = await runCard({
    config: { name: "Quiet", job: "Answers nothing.", prompt: "", skills: [], model: { provider: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "gone" } },
    only: ["mom-growth", "unit-economics", "business-days", "spanish-note", "plain-rewrite"],
    concurrency: 1,
    turnTimeoutMs: 20_000,
    onEvent: (event) => events.push(event),
  });
  assert.equal(card.ran, 3, "the last two tasks never started");
  assert.match(card.stoppedEarly, /stopped answering/);
  assert.equal(card.unanswered, 3);
  assert.equal(card.overall, null);
  assert.ok(events.some((event) => event.type === "stopping"));
});
