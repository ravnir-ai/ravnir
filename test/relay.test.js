import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callCollaborationTool } from "../server/collaboration.js";
import { openCodeMcpConfig, RAVNIR_TOOL_TIMEOUT_MS } from "../server/mcp.js";
import { readConversation, writeConversation } from "../server/state.js";
import { TurnEngine } from "../server/turn.js";

process.env.RAVNIR_AI_MEMORY = "off";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-relay-"));
const bot = (id, name, extra = {}) => ({ id, name, job: "x", group: "Personal", status: "on", connectors: [], jobs: [], memory: [], vault: [], ...extra });

function engineFor(home, state) {
  return new TurnEngine({ home, state, saveState: () => {}, secrets: { get: () => "" }, eventLog: { append() {} }, browser: {}, mcp: {}, ledger: { record() {}, rows: [] }, approvals: {} });
}

test("OpenCode waits up to 15 minutes for a Ravnir tool, not its one-minute default", () => {
  const config = openCodeMcpConfig(bot("a", "Chief"), "http://127.0.0.1:3847/api/bots/a/mcp", "token");
  assert.equal(config.mcp.ravnir.timeout, RAVNIR_TOOL_TIMEOUT_MS);
  assert.equal(RAVNIR_TOOL_TIMEOUT_MS, 15 * 60_000);
});

test("message_bot that outlasts the wait says so, and hands the reply back later instead of losing it", async () => {
  const home = tmp();
  const chief = bot("chief", "Chief of Staff");
  const engineer = bot("eng", "Lead Engineer");
  const state = { bots: [chief, engineer], groups: [] };
  let finish;
  const relayed = [];
  const engine = {
    enqueue: () => ({ promise: new Promise((resolve) => { finish = resolve; }) }),
    relayReply: (...args) => relayed.push(args),
    status: () => ({ busy: false }),
  };
  const ctx = { bot: chief, state, home, engine, chain: [], waitMs: 30, save() {} };
  const result = await callCollaborationTool("message_bot", { bot: "Lead Engineer", text: "Send five clips to the team channel.", wait: true }, ctx);
  assert.match(result.text, /still working on it\. Its reply will come to your thread/);
  assert.match(result.text, /Do not ask Lead Engineer again/);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0][0].id, "chief");
  assert.equal(relayed[0][1].id, "eng");
  assert.equal(relayed[0][2].asked, "Send five clips to the team channel.");
  finish();

  // A reply inside the wait comes back in the same call, as before.
  const quick = { ...engine, enqueue: () => ({ promise: Promise.resolve() }) };
  writeConversation(home, engineer, [{ id: "r1", role: "assistant", content: "Done: 3 clips pending.", at: Date.now() + 5 }]);
  const answered = await callCollaborationTool("message_bot", { bot: "Lead Engineer", text: "How many?", wait: true }, { ...ctx, engine: quick });
  assert.equal(answered.text, "Reply from Lead Engineer:\nDone: 3 clips pending.");
});

test("a late reply wakes the asker with it, and after three hand-backs it only lands in the thread", async () => {
  const home = tmp();
  const chief = bot("chief", "Chief of Staff");
  const engineer = bot("eng", "Lead Engineer");
  const state = { bots: [chief, engineer], groups: [] };
  const engine = engineFor(home, state);
  const queued = [];
  engine.enqueue = (target, input) => {
    queued.push({ target, input });
    return { promise: Promise.resolve() };
  };
  const startedAt = Date.now();
  writeConversation(home, engineer, [{ id: "r1", role: "assistant", content: "Sent five clips; 12 still pending.", at: startedAt + 10 }]);
  engine.relayReply(chief, engineer, { promise: Promise.resolve(), startedAt, asked: "Send five clips to the team channel." });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].target.id, "chief");
  assert.equal(queued[0].input.source, "bot");
  assert.equal(queued[0].input.fromBotName, "Lead Engineer");
  assert.equal(queued[0].input.relay, 1);
  assert.match(queued[0].input.text, /^Reply to your earlier message \("Send five clips to the team channel\."\):\n\nSent five clips; 12 still pending\.$/);

  // The fourth hand-back in one exchange does not start another turn.
  engine.active.set("chief", { relay: 3, chain: [] });
  engine.relayReply(chief, engineer, { promise: Promise.resolve(), startedAt, asked: "And the rest?" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  engine.active.delete("chief");
  assert.equal(queued.length, 1, "no new turn");
  const thread = readConversation(home, chief);
  assert.equal(thread.at(-1).kind, "mention");
  assert.equal(thread.at(-1).fromBotName, "Lead Engineer");
  assert.match(thread.at(-1).content, /Sent five clips/);

  // A paused asker is not woken either.
  chief.status = "off";
  engine.relayReply(chief, engineer, { promise: Promise.resolve(), startedAt, asked: "x" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(queued.length, 1);
});

test("while the user waits in chat, message_bot waits less, and a routine keeps the long wait", async () => {
  const home = tmp();
  const chief = bot("chief", "Chief of Staff");
  const finance = bot("fin", "Head of Finance");
  const state = { bots: [chief, finance], groups: [] };
  const relayed = [];
  // The other agent answers after 700 ms: past the chat wait, well inside a routine's.
  const engine = (source) => ({
    enqueue: () => ({ promise: new Promise((resolve) => setTimeout(resolve, 700)) }),
    relayReply: (...args) => relayed.push(args),
    status: () => ({ busy: false }),
    currentChain: () => [],
    currentSource: () => source,
  });
  const saved = process.env.RAVNIR_REPLY_WAIT_CHAT_MS;
  process.env.RAVNIR_REPLY_WAIT_CHAT_MS = "200";
  try {
    const started = Date.now();
    const result = await callCollaborationTool("message_bot", { bot: "Head of Finance", text: "¿Ingresos de octubre?", wait: true }, { bot: chief, state, home, engine: engine("chat"), chain: [], save() {} });
    assert.ok(Date.now() - started < 1000);
    assert.match(result.text, /still working on it/);
    assert.equal(relayed.length, 1);

    // A routine (or another bot) keeps the four-minute wait, so it gets the answer in the same call.
    const routine = await callCollaborationTool("message_bot", { bot: "Head of Finance", text: "Resumen semanal", wait: true }, { bot: chief, state, home, engine: engine("job"), chain: [], save() {} });
    assert.match(routine.text, /^Head of Finance finished/);
    assert.equal(relayed.length, 1);
  } finally {
    if (saved === undefined) delete process.env.RAVNIR_REPLY_WAIT_CHAT_MS;
    else process.env.RAVNIR_REPLY_WAIT_CHAT_MS = saved;
  }
});

test("the engine says what started an agent's running turn", () => {
  const engine = engineFor(tmp(), { bots: [], groups: [] });
  assert.equal(engine.currentSource("a"), "");
  engine.active.set("a", { source: "voice", chain: [] });
  assert.equal(engine.currentSource("a"), "voice");
});
