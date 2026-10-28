import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { createApp } from "../server/index.js";
import { billingOf, costOf } from "../server/ledger.js";
import { normalizeLimits } from "../server/policy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

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

async function turn(base, id, text) {
  const { turnId } = await api(base, "POST", `/api/bots/${id}/messages`, { text });
  await waitFor(async () => (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events.some((event) => event.type === "turn.end" && event.turnId === turnId));
  return turnId;
}

test("every reply carries its turn's cost, and the day's total per agent equals the ledger sum", async () => {
  const mock = await startMock();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-cost-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const model = { provider: "openai", baseUrl: mock.url, model: "mock-model" };
    // The mock costs $0.002 a call; a plain message is a plan call plus the reply, a tool message one more.
    const bot = (await api(base, "POST", "/api/bots", { name: "Ledger", job: "Counts.", model, limits: { dailyCost: 0.02 } })).bot;
    const other = (await api(base, "POST", "/api/bots", { name: "Other", job: "Also counts.", model })).bot;
    const ids = [];
    ids.push(await turn(base, bot.id, "check the totals"));
    ids.push(await turn(base, bot.id, 'call tool list_jobs {}'));
    ids.push(await turn(base, bot.id, "hello"));
    await turn(base, other.id, "check the other totals");

    const { conversation, usage } = await api(base, "GET", `/api/bots/${bot.id}`);
    const replies = conversation.filter((message) => message.cost);
    assert.deepEqual(replies.map((message) => message.turnId), ids);
    for (const reply of replies) {
      assert.ok(reply.cost.cost > 0);
      assert.ok(reply.cost.tokens > 0);
      assert.equal(reply.cost.billing, "metered");
      assert.equal(reply.cost.model, "mock-model");
    }
    // A tool turn made one more model call than a plain one.
    assert.ok(replies[1].cost.cost > replies[2].cost.cost);
    const rows = fs.readFileSync(path.join(home, "turns.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.botId === bot.id);
    const sum = (list, pick) => Math.round(list.reduce((total, item) => total + pick(item), 0) * 1e6) / 1e6;
    assert.equal(sum(replies, (item) => item.cost.cost), sum(rows, (row) => row.usage.cost));
    assert.equal(sum(replies, (item) => item.cost.cost), usage.today.cost);
    assert.equal(replies.reduce((total, item) => total + item.cost.tokens, 0), usage.today.tokens);
    for (const reply of replies) assert.deepEqual(reply.cost.usage, rows.find((row) => row.id === reply.turnId).usage);
    assert.equal(usage.month.cost, usage.today.cost);
    assert.equal((await api(base, "GET", `/api/turns/${ids[0]}`)).usage.cost, replies[0].cost.cost);

    // Past 80 percent of the cap: one push. At the cap: a high one, then the next turn stops with a note in the thread.
    while ((await api(base, "GET", `/api/bots/${bot.id}`)).usage.today.cost < 0.016) await turn(base, bot.id, "one more");
    const near = (await api(base, "GET", "/api/notifications")).items.filter((item) => item.botId === bot.id && /cap/.test(item.title));
    assert.equal(near.length, 1);
    assert.match(near[0].body, /of its \$0\.02 daily cap/);
    while ((await api(base, "GET", `/api/bots/${bot.id}`)).usage.today.cost < 0.02) await turn(base, bot.id, "one more");
    const all = (await api(base, "GET", "/api/notifications")).items.filter((item) => item.botId === bot.id && /cap/.test(item.title));
    assert.equal(all.length, 1, "one warning per day, even past the cap");
    await turn(base, bot.id, "past the cap");
    const capped = (await api(base, "GET", `/api/bots/${bot.id}`)).conversation.at(-1);
    assert.equal(capped.notice, "cap");
    assert.equal(capped.kind, "ack");
    assert.match(capped.content, /reached its daily cap of \$0\.02 .* wait until tomorrow\./);
    const last = fs.readFileSync(path.join(home, "turns.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(last.status, "capped");

    // A monthly cap stops turns the same way and says when it resets.
    await api(base, "PATCH", `/api/bots/${other.id}`, { limits: { monthlyCost: 0.001 } });
    await turn(base, other.id, "anything");
    assert.match((await api(base, "GET", `/api/bots/${other.id}`)).conversation.at(-1).content, /monthly cap of \$0\.0010 .* next month\./);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
  }
});

test("billing labels come from what the provider reported, never a guessed quota", () => {
  assert.equal(billingOf({ model: "gpt-x", usage: { cost: 0.01, input: 10 } }), "metered");
  assert.equal(billingOf({ model: "opencode/glm-5.3-flash-free", usage: { input: 900 } }), "free");
  assert.equal(billingOf({ model: "openai/gpt-6-luna", usage: { input: 900, output: 20 } }), "plan");
  assert.equal(billingOf({ model: "x", usage: null }), "none");
  const cost = costOf({ turnId: "t", usage: { input: 100, output: 20, reasoning: 5, cost: 0.0012345671 }, model: "m", provider: "openai" });
  assert.equal(cost.tokens, 125);
  assert.equal(cost.cost, 0.001235);
  assert.deepEqual(normalizeLimits({ monthlyCost: "2.5", monthlyTokens: 1e6, dailyCost: -1 }), { dailyCost: 0, dailyTokens: 0, monthlyCost: 2.5, monthlyTokens: 1000000 });
});
