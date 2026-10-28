import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMock } from "../scripts/mock-openai.js";
import { BrowserManager } from "../server/browser.js";
import { renderReport } from "../evals/report.mjs";
import { runSuite, summarize } from "../evals/run.mjs";
import { startSite } from "../evals/site.mjs";
import { tasks } from "../evals/tasks.mjs";

test("the demo site keeps a session, serves the account behind it and logs what happened", async () => {
  const site = await startSite();
  try {
    const wrong = await fetch(`${site.url}/login`, { method: "POST", body: new URLSearchParams({ email: "ops@northwind.test", password: "nope" }), redirect: "manual" });
    assert.equal(wrong.status, 401);
    const login = await fetch(`${site.url}/login`, { method: "POST", body: new URLSearchParams({ email: "alex@northwind.test", password: "correct-horse-7" }), redirect: "manual" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(await (await fetch(`${site.url}/account`, { headers: { cookie } })).text(), /N-1043[\s\S]*2026-11-12/);
    assert.match(await (await fetch(`${site.url}/account/invoices.csv`, { headers: { cookie } })).text(), /INV-303,2026-10-15,240\.00/);
    assert.doesNotMatch(await (await fetch(`${site.url}/js-only`)).text(), /NW-7731/);
    assert.deepEqual(site.log().filter((event) => event.type === "login").map((event) => event.ok), [false, true]);
    assert.ok(site.log().some((event) => event.type === "request" && event.path === "/js-only"));
    site.reset();
    assert.equal(site.log().length, 0);
  } finally {
    await site.close();
  }
});

// Found by the evals: on the site's home page, a saved login that points at /login used to fail with
// "No password field on this page" instead of opening the sign-in page.
test("a saved login goes to its sign-in page when the page open on that site has no form", async (t) => {
  const site = await startSite();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-evals-browser-"));
  const browser = new BrowserManager({ home });
  const bot = { id: "login-test", name: "Login test" };
  try {
    let session;
    try {
      session = await browser.ensure(bot);
    } catch (error) {
      t.skip(`no browser here: ${error.message}`);
      return;
    }
    await session.navigate(site.url);
    const result = await session.login({ site: `${site.url}/login`, username: "alex@northwind.test", password: "correct-horse-7" });
    assert.match(result.status.url, /\/account$/);
    assert.deepEqual(site.log().filter((event) => event.type === "login").map((event) => event.ok), [true]);
  } finally {
    await browser.closeAll().catch(() => {});
    await site.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Also found by the evals: browser_type on a dropdown failed ("not an <input>"), so agents left the default.
test("browser_type picks a dropdown option by its text and ticks a checkbox; the reader lists options and selectors", async (t) => {
  const site = await startSite();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-evals-browser-"));
  const browser = new BrowserManager({ home });
  try {
    let session;
    try {
      session = await browser.ensure({ id: "select-test", name: "Select test" });
    } catch (error) {
      t.skip(`no browser here: ${error.message}`);
      return;
    }
    await session.navigate(`${site.url}/contact`);
    const topic = (await session.read()).fields.find((field) => field.tag === "select");
    assert.deepEqual([topic.css, topic.fieldLabel, topic.options, topic.selected], ["#topic", "Topic", ["Billing", "Support", "Sales"], "Billing"]);
    await session.typeSelector("#topic", "sales");
    assert.equal((await session.read()).fields.find((field) => field.tag === "select").selected, "Sales");
    await assert.rejects(session.typeSelector("#topic", "Refunds"), /No option "Refunds" in that dropdown\. Options: Billing, Support, Sales\./);

    await session.navigate(`${site.url}/wizard/1`);
    await session.typeSelector("#fullname", "Alex Rivera");
    await session.clickSelector("button");
    await session.typeSelector("#company", "Ravnir Labs");
    await session.typeSelector("#role", "Founder");
    await session.clickSelector("button");
    const consent = (await session.read()).fields.find((field) => field.type === "checkbox");
    assert.equal(consent.checked, false);
    await session.typeSelector(consent.css, "yes");
    await session.clickSelector("button");
    assert.deepEqual(site.log().filter((event) => event.type === "wizard").map((event) => [event.fullname, event.company, event.role]), [["Alex Rivera", "Ravnir Labs", "Founder"]]);
  } finally {
    await browser.closeAll().catch(() => {});
    await site.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("every task has an id, a prompt and a check, and ids are unique", () => {
  assert.ok(tasks.length >= 15);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  for (const task of tasks) {
    assert.equal(typeof task.prompt, "function", task.id);
    assert.equal(typeof task.check, "function", task.id);
    assert.ok(task.title && Array.isArray(task.tags), task.id);
  }
});

test("the runner plays the user on a scripted model: it answers a question, counts asks and cost, and writes a report", async () => {
  const mock = await startMock();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-evals-test-"));
  const own = [
    {
      id: "schedule",
      title: "Schedule a job",
      tags: ["schedule"],
      expectAsks: 0,
      prompt: () => 'call tool create_job {"name":"Invoice","prompt":"Send the invoice.","cron":"0 9 * * 1"}',
      check: async (ctx) => ({ ok: (await ctx.bot()).jobs.some((job) => job.cron === "0 9 * * 1"), why: "job made" }),
    },
    {
      id: "question",
      title: "Ask once",
      tags: ["escalation"],
      expectAsks: 1,
      setup: (ctx) => ctx.writeWorkspace("notes/a.txt", "x"),
      prompt: () => 'call tool ask_user {"question":"Which repo should I deploy?","need":"deploy repository","about":"detail"}',
      answers: ["ravnir-demo"],
      check: (ctx) => ({ ok: ctx.reply === 'Thanks. That answers "Which repo should I deploy?".' && ctx.readWorkspace("notes/a.txt") === "x", why: ctx.reply }),
    },
  ];
  try {
    const { results } = await runSuite({ models: [{ provider: "openai", baseUrl: mock.url, model: "mock-model" }], tasks: own, out, concurrency: 2, log: () => {} });
    const [result] = results;
    const byId = Object.fromEntries(result.tasks.map((row) => [row.task, row]));
    assert.equal(byId.schedule.finished, true, byId.schedule.why);
    assert.equal(byId.schedule.asks, 0);
    assert.equal(byId.question.finished, true, byId.question.why);
    assert.equal(byId.question.asks, 1);
    assert.equal(byId.question.answered, 1);
    assert.equal(byId.question.extraAsks, 0);
    assert.equal(byId.question.turns, 2);
    assert.equal(result.summary.finished, 2);
    assert.equal(result.summary.asksMean, 0.5);
    const report = fs.readFileSync(path.join(out, "report.md"), "utf8");
    assert.match(report, /\| mock-model \| 2\/2 \(100%\) \| 0\.50 \| 0\.5 \| 0\.00 \| 0 \| 0 \|/);
    assert.doesNotMatch(report, /[–—]/);
  } finally {
    await mock.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("the summary uses mean and median asks and counts timeouts", () => {
  const summary = summarize([
    { finished: true, asks: 0, extraAsks: 0, cost: 0.01, durationMs: 10_000 },
    { finished: false, asks: 2, extraAsks: 1, cost: 0.03, durationMs: 30_000, why: "timed out; x" },
    { finished: true, asks: 0, extraAsks: 0, cost: 0.02, durationMs: 20_000 },
  ]);
  assert.deepEqual([summary.finished, summary.asksMean, summary.asksMedian, summary.extraAsksMean, summary.timeouts, summary.medianSeconds], [2, 0.67, 0, 0.33, 1, 20]);
  assert.match(renderReport([]), /No results yet/);
});
