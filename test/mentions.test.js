import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/index.js";
import { Ledger } from "../server/ledger.js";
import { parseMentions } from "../server/mentions.js";
import { startMock } from "../scripts/mock-openai.js";

process.env.RAVNIR_AI_MEMORY = "off";

const ROSTER = [
  { id: "a", name: "Nova" },
  { id: "b", name: "Chief of Staff" },
  { id: "c", name: "Nova Bot" },
];

test("@mentions resolve names with spaces, dedupe, and ignore self and unknown handles", () => {
  assert.deepEqual(parseMentions("@Chief of Staff check this", ROSTER, "a"), [{ botId: "b", name: "Chief of Staff" }]);
  assert.deepEqual(parseMentions("@nova and @Nova again", ROSTER, "b"), [{ botId: "a", name: "Nova" }]);
  assert.deepEqual(parseMentions("@Nova Bot deploy", ROSTER, "b"), [{ botId: "c", name: "Nova Bot" }]);
  assert.deepEqual(parseMentions("@Nobody hello", ROSTER, "a"), []);
  assert.deepEqual(parseMentions("@Nova hello", ROSTER, "a"), []);
  assert.deepEqual(parseMentions("write to ada@Nova.example", ROSTER, "b"), []);
  assert.deepEqual(parseMentions("@Novax is not Nova", ROSTER, "b"), []);
  assert.deepEqual(parseMentions("@Chief of Staff and @Nova", ROSTER, "").map((item) => item.botId), ["b", "a"]);
});

test("the ledger groups spend and tokens by model", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-models-"));
  const ledger = new Ledger({ home });
  ledger.record({ botId: "a", status: "ok", provider: "openai", model: "gpt-x", usage: { input: 100, output: 40, cost: 0.02 } });
  ledger.record({ botId: "b", status: "ok", provider: "openai", model: "gpt-x", usage: { input: 50, output: 10, cost: 0.01 } });
  ledger.record({ botId: "a", status: "ok", provider: "opencode", model: "glm", usage: { input: 10, output: 5, cost: 0 } });
  const byModel = ledger.byModel(ledger.rows);
  const gpt = byModel.find((row) => row.model === "gpt-x");
  assert.equal(gpt.turns, 2);
  assert.equal(gpt.tokens, 200);
  assert.equal(gpt.cost, 0.03);
  assert.equal(byModel.find((row) => row.model === "glm").tokens, 15);
});

test("a mentioned bot answers into the same thread with its own label", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-mentions-"));
  const mock = await startMock();
  const app = await start(home);
  try {
    const nova = await request(app.base, "POST", "/api/bots", {
      name: "Nova",
      job: "Coordinates.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const chief = await request(app.base, "POST", "/api/bots", {
      name: "Chief of Staff",
      job: "Answers when tagged.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });

    const before = nova.lastSeq || 0;
    const sent = await request(app.base, "POST", `/api/bots/${nova.bot.id}/messages`, {
      text: "@Chief of Staff what is the status?",
    });
    assert.deepEqual(sent.mentions, [{ botId: chief.bot.id, name: "Chief of Staff" }]);
    const events = await waitForMention(app.base, nova.bot.id, before, 300);
    const mention = events.find((event) => event.type === "mention.reply");
    assert.ok(mention, "the mention reply should arrive as an event");
    assert.equal(mention.message.fromBotId, chief.bot.id);
    assert.equal(mention.message.fromBotName, "Chief of Staff");
    assert.match(mention.message.content, /Mock reply:/);

    const detail = await request(app.base, "GET", `/api/bots/${nova.bot.id}`);
    const thread = detail.conversation.filter((message) => message.kind === "mention");
    assert.equal(thread.length, 1);
    assert.equal(thread[0].fromBotName, "Chief of Staff");
    assert.equal(detail.conversation.find((message) => message.role === "user").mentions.length, 1);

    const chiefDetail = await request(app.base, "GET", `/api/bots/${chief.bot.id}`);
    assert.match(chiefDetail.conversation.map((message) => message.content).join("\n"), /You were mentioned in Nova's thread/);

    const self = await request(app.base, "POST", `/api/bots/${nova.bot.id}/messages`, { text: "@Nova keep going" });
    assert.deepEqual(self.mentions, []);
    const unknown = await request(app.base, "POST", `/api/bots/${nova.bot.id}/messages`, { text: "@Nobody hello" });
    assert.deepEqual(unknown.mentions, []);
  } finally {
    await close(app.server);
    await mock.close();
  }
});

async function start(home) {
  const server = createApp({ home, projectRoot: path.resolve(import.meta.dirname, "..") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForMention(base, id, after, timeoutMs) {
  let cursor = after;
  const collected = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const data = await request(base, "GET", `/api/bots/${id}/events?after=${cursor}`);
    cursor = data.cursor;
    collected.push(...data.events);
    if (data.events.some((event) => event.type === "mention.reply")) return collected;
  }
  return collected;
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
