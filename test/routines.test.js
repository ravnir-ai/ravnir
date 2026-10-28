// The clock changes are Madrid's, whatever the machine running the tests says.
process.env.TZ = "Europe/Madrid";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { createApp } from "../server/index.js";
import { nextCron, Scheduler } from "../server/jobs.js";
import { TurnEngine } from "../server/turn.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const madrid = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short", hour12: false }).format(ms) + (new Date(ms).getTimezoneOffset() === -120 ? " CEST" : " CET");
const runs = (cron, fromIso, count) => {
  const out = [];
  let at = Date.parse(fromIso);
  for (let index = 0; index < count; index += 1) {
    at = nextCron(cron, at + 30_000);
    out.push(madrid(at));
  }
  return out;
};

test("a 02:30 routine runs once when the clock goes back (2026-10-25) and right after the jump when it goes forward", () => {
  assert.deepEqual(runs("30 2 * * *", "2026-10-24T22:00:00Z", 3), ["25/10/2026, 02:30 CEST", "26/10/2026, 02:30 CET", "27/10/2026, 02:30 CET"]);
  // Starting from inside the repeated hour does not hand back a time already past.
  const second = Date.parse("2026-10-25T01:31:00Z");
  assert.ok(nextCron("30 2 * * *", second) > second);
  assert.deepEqual(runs("30 2 * * *", "2026-03-28T22:00:00Z", 2), ["29/03/2026, 03:00 CEST", "30/03/2026, 02:30 CEST"]);
  // 02:00 sharp is in the gap too; 03:15 is not.
  assert.deepEqual(runs("0 2 * * 0", "2026-03-28T22:00:00Z", 1), ["29/03/2026, 03:00 CEST"]);
  assert.deepEqual(runs("15 3 * * *", "2026-03-28T22:00:00Z", 1), ["29/03/2026, 03:15 CEST"]);
  // A job that runs every 30 minutes keeps running through both 02:00 hours: elapsed time, not wall time.
  assert.deepEqual(runs("*/30 * * * *", "2026-10-24T23:50:00Z", 4), ["25/10/2026, 02:00 CEST", "25/10/2026, 02:30 CEST", "25/10/2026, 02:00 CET", "25/10/2026, 02:30 CET"]);
  // A fixed-hour job outside the changed hour is untouched.
  assert.deepEqual(runs("0 9 * * 1-5", "2026-10-23T08:00:00Z", 2), ["26/10/2026, 09:00 CET", "27/10/2026, 09:00 CET"]);
});

test("the scheduler reports a routine that could not start", async () => {
  const job = { id: "j1", name: "Morning check", cron: "* * * * *", enabled: true, nextRunAt: Date.now() - 1000, runs: [] };
  const bot = { id: "b1", name: "Scout", jobs: [job] };
  const seen = [];
  const scheduler = new Scheduler({ getState: () => ({ bots: [bot] }), save: () => {}, runJob: () => Promise.reject(new Error("no model")), onError: (who, what, error) => seen.push([who.id, what.id, error.message]) });
  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, [["b1", "j1", "no model"]]);
  assert.equal(job.lastStatus, "error");
});

test("a turn running past its time and not waiting on an approval counts as stuck", () => {
  const now = Date.now();
  const active = new Map([
    ["a", { turnId: "t1", startedAt: now - 40 * 60_000 }],
    ["b", { turnId: "t2", startedAt: now - 40 * 60_000 }],
    ["c", { turnId: "t3", startedAt: now - 60_000 }],
  ]);
  const stuck = TurnEngine.prototype.stuckTurns.call({ active }, 30 * 60_000, { pendingFor: (id) => (id === "b" ? [{}] : []) });
  assert.deepEqual(stuck.map((item) => item.botId), ["a"]);
});

async function api(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(check, { tries = 150, delay = 100 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting.");
}

test("a routine with no news is logged with no push and no card; a failed one waits in Needs you until dismissed", async () => {
  const mock = await startMock();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-routines-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bot = (await api(base, "POST", "/api/bots", { name: "Scout", job: "Watches.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } })).bot;
    assert.match((await api(base, "GET", `/api/bots/${bot.id}`)).livePrompt, /\[\[no news\]\] on its own line/);
    const quiet = (await api(base, "POST", `/api/bots/${bot.id}/jobs`, { name: "Inbox sweep", cron: "0 8 * * *", prompt: "Checked, nothing changed. [[no news]]" })).job;
    const loud = (await api(base, "POST", `/api/bots/${bot.id}/jobs`, { name: "Digest", cron: "0 9 * * *", prompt: "Send the digest." })).job;
    const done = async (jobId) => waitFor(async () => (await api(base, "GET", `/api/bots/${bot.id}`)).bot.jobs.find((job) => job.id === jobId).runs.length > 0);
    await api(base, "POST", `/api/bots/${bot.id}/jobs/${quiet.id}/run`, {});
    await done(quiet.id);
    await api(base, "POST", `/api/bots/${bot.id}/jobs/${loud.id}/run`, {});
    await done(loud.id);

    const notes = (await api(base, "GET", "/api/notifications")).items.filter((item) => item.botId === bot.id);
    assert.deepEqual(notes.map((item) => item.title), ["Digest"]);
    const rows = fs.readFileSync(path.join(home, "turns.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sweep = rows.find((row) => row.jobName === "Inbox sweep");
    assert.equal(sweep.status, "ok");
    assert.equal(sweep.quiet, true);
    const detail = await api(base, "GET", `/api/bots/${bot.id}`);
    const reply = detail.conversation.find((message) => message.quiet);
    assert.equal(reply.content, "Mock reply: Checked, nothing changed.");
    const sweepJob = detail.bot.jobs.find((job) => job.id === quiet.id);
    assert.equal(sweepJob.runs.at(-1).quiet, true);
    // Cost per routine, from the ledger.
    assert.equal(sweepJob.spend.turns, 1);
    assert.ok(sweepJob.spend.cost > 0);
    assert.equal(sweepJob.runs.at(-1).spent.cost, sweepJob.spend.cost);

    // A routine whose model is down fails: a high push, and Home lists it until dismissed.
    await api(base, "PATCH", `/api/bots/${bot.id}`, { model: { provider: "openai", baseUrl: "http://127.0.0.1:9", model: "mock-model" } });
    await api(base, "POST", `/api/bots/${bot.id}/jobs/${loud.id}/run`, {});
    await waitFor(async () => (await api(base, "GET", `/api/bots/${bot.id}`)).bot.jobs.find((job) => job.id === loud.id).lastStatus === "error");
    const failed = (await api(base, "GET", "/api/notifications")).items.find((item) => item.title === "Digest failed");
    assert.equal(failed.priority, "high");
    const today = await api(base, "GET", "/api/today");
    assert.deepEqual(today.failures.map((item) => item.jobName), ["Digest"]);
    assert.equal((await api(base, "GET", "/api/state")).inbox.failures, 1);
    await api(base, "POST", `/api/bots/${bot.id}/jobs/${loud.id}/dismiss`, {});
    assert.equal((await api(base, "GET", "/api/today")).failures.length, 0);
    assert.deepEqual((await api(base, "GET", "/api/today")).stuck, []);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
  }
});
