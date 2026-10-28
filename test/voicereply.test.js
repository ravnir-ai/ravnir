import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { startMock } from "../scripts/mock-openai.js";
import { MarkerFilter, voiceMessages } from "../server/voiceReply.js";
import { takeSentences } from "../public/speakable.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const ENV = ["RAVNIR_QUICK", "RAVNIR_QUICK_URL", "RAVNIR_QUICK_MODEL", "RAVNIR_QUICK_API_KEY", "RAVNIR_QUICK_PRICE", "RAVNIR_VOICE_START_MS"];

function clearEnv() {
  for (const key of ENV) delete process.env[key];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// A stand-in for the quick model that streams like a real reasoning model: reasoning first, content in
// pieces, an SSE line split across two writes, and a usage chunk with no choices at the end.
function fakeQuick({ firstTokenMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ body, headers: req.headers });
    const last = String(body.messages.at(-1).content);
    if (/broken/.test(last)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { choices: [{ delta: { reasoning_content: "thinking about it" } }] });
    await wait(/slow/.test(last) ? 400 : firstTokenMs);
    let pieces = ["Hi there. ", "How can I ", "help you today?"];
    if (/delegate/.test(last)) pieces = ["Sure, I will check that. ", "[[DEL", "EGATE: look up the weather in Madrid]]"];
    for (const [index, piece] of pieces.entries()) {
      const line = `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
      if (index === 1) {
        // Split a data line between two reads.
        res.write(line.slice(0, 20));
        await wait(5);
        res.write(line.slice(20));
      } else {
        res.write(line);
      }
      await wait(5);
    }
    sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    sse(res, { choices: [], usage: { prompt_tokens: 200, completion_tokens: 30 } });
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function api(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

// Posts to the voice route and reads the NDJSON lines, noting when each arrived.
async function voiceCall(base, id, text) {
  const started = Date.now();
  const response = await fetch(`${base}/api/bots/${id}/voice/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  assert.equal(response.status, 200);
  const lines = [];
  let pending = "";
  const decoder = new TextDecoder();
  for await (const part of response.body) {
    pending += decoder.decode(part, { stream: true });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) lines.push({ ...JSON.parse(line), ms: Date.now() - started });
    }
  }
  return lines;
}

async function waitFor(check, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await wait(50);
  }
  throw new Error("Timed out waiting.");
}

async function setup(t, { quickOptions, env = {} } = {}) {
  clearEnv();
  const quick = await fakeQuick(quickOptions);
  const mock = await startMock();
  Object.assign(process.env, { RAVNIR_QUICK_URL: quick.url, RAVNIR_QUICK_MODEL: "fast-fake", RAVNIR_QUICK_PRICE: "1,2", ...env });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-voicereply-"));
  const server = createApp({ home, projectRoot });
  const base = await listen(server);
  t.after(async () => {
    clearEnv();
    await close(server);
    await close(quick.server);
    await mock.close();
  });
  const created = await api(base, "POST", "/api/bots", {
    name: "Voicey",
    job: "Answers by voice.",
    prompt: "Be brief and kind.",
    model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
  });
  return { base, home, quick, id: created.bot.id };
}

test("the marker filter never lets the DELEGATE marker out, even split across pieces", () => {
  const filter = new MarkerFilter();
  const out = ["Sure thing. [", "[DELE", "GATE: do the ", "thing]]"].map((piece) => filter.push(piece)).join("");
  assert.equal(out, "Sure thing. ");
  assert.deepEqual(filter.finish(), { spoken: "Sure thing.", task: "do the thing", tail: "" });

  const plain = new MarkerFilter();
  const spoken = ["It is [", "fine] really"].map((piece) => plain.push(piece)).join("") + plain.finish().tail;
  assert.equal(spoken, "It is [fine] really");

  const open = new MarkerFilter();
  open.push("On it. [[DELEGATE: read the file");
  assert.deepEqual(open.finish(), { spoken: "On it.", task: "read the file", tail: "" });
});

test("sentences are taken from a streaming reply as soon as they are complete", () => {
  assert.deepEqual(takeSentences("Hi there. How can I"), { sentences: ["Hi there."], rest: "How can I" });
  assert.deepEqual(takeSentences("Costs 3.5 euros"), { sentences: [], rest: "Costs 3.5 euros" });
  assert.deepEqual(takeSentences("Ok. Sure thing. And"), { sentences: ["Ok. Sure thing."], rest: "And" });
  assert.deepEqual(takeSentences("¿Quieres café? Sí", { final: true }), { sentences: ["¿Quieres café?", "Sí"], rest: "" });
});

test("the voice context is small: name, job, short thread without acks", () => {
  const bot = { name: "Nova", job: "Planner", prompt: "x".repeat(3000), memory: [{ text: "Likes tea" }] };
  const thread = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i} ${"y".repeat(600)}` }));
  thread.push({ role: "assistant", kind: "ack", content: "plan ack" });
  const messages = voiceMessages(bot, thread, "hello");
  assert.equal(messages.length, 14);
  assert.match(messages[0].content, /You are Nova, Planner/);
  assert.match(messages[0].content, /Likes tea/);
  assert.equal(messages[0].content.includes("x".repeat(1501)), false);
  assert.equal(messages.some((message) => message.content === "plan ack"), false);
  assert.ok(messages.slice(1, -1).every((message) => message.content.length <= 400));
  assert.equal(messages.at(-1).content, "hello");
});

test("voice reply streams deltas fast, stores both messages as voice, and records the call", async (t) => {
  const { base, home, quick, id } = await setup(t, { quickOptions: { firstTokenMs: 600 } });
  const lines = await voiceCall(base, id, "hello");
  const deltas = lines.filter((line) => line.type === "delta");
  assert.equal(deltas.map((line) => line.text).join(""), "Hi there. How can I help you today?");
  assert.ok(deltas[0].ms >= 550 && deltas[0].ms < 1500, `first delta at ${deltas[0].ms} ms`);
  const done = lines.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.delegated, false);
  assert.equal(done.text, "Hi there. How can I help you today?");
  console.log(`# voice reply: first delta ${deltas[0].ms} ms, done ${done.ms} ms (quick model first token 600 ms)`);

  // The request carries a big enough token budget, usage, the agent's name and the session header.
  const sent = quick.seen.at(-1);
  assert.ok(sent.body.max_tokens >= 700);
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  assert.match(sent.body.messages[0].content, /You are Voicey, Answers by voice/);
  assert.match(sent.body.messages[0].content, /Be brief and kind/);
  assert.equal(sent.headers["x-opencode-session"], `ravnir-voice-${id}`);

  const detail = await api(base, "GET", `/api/bots/${id}`);
  const thread = detail.conversation.filter((message) => message.kind !== "intro");
  const user = thread.find((message) => message.role === "user");
  const reply = thread.find((message) => message.role === "assistant");
  assert.equal(user.content, "hello");
  assert.equal(user.via, "voice");
  assert.equal(reply.content, "Hi there. How can I help you today?");
  assert.equal(reply.via, "voice");
  assert.notEqual(reply.kind, "ack");
  assert.equal(thread.length, 2);

  const rows = fs.readFileSync(path.join(home, "turns.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const row = rows.at(-1);
  assert.equal(row.source, "voice");
  assert.equal(row.botId, id);
  assert.equal(row.model, "fast-fake");
  assert.equal(row.usage.input, 200);
  assert.equal(row.usage.output, 30);
  assert.ok(Math.abs(row.usage.cost - (200 * 1 + 30 * 2) / 1e6) < 1e-12);

  // The events carry both messages, so an open thread shows them at once.
  const events = (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events.filter((event) => event.type === "voice.message");
  assert.equal(events.length, 2);
});

test("a delegated reply hides the marker, then runs a normal agent turn with no plan ack", async (t) => {
  const { base, id } = await setup(t);
  const lines = await voiceCall(base, id, "please delegate this");
  const spoken = lines.filter((line) => line.type === "delta").map((line) => line.text).join("");
  assert.equal(spoken.trim(), "Sure, I will check that.");
  assert.equal(JSON.stringify(lines).includes("DELEGATE"), false);
  const done = lines.at(-1);
  assert.equal(done.delegated, true);
  assert.ok(done.turnId);

  const end = await waitFor(async () => (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events.find((event) => event.type === "turn.end" && event.turnId === done.turnId));
  const events = (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events;
  const start = events.find((event) => event.type === "turn.start" && event.turnId === done.turnId);
  assert.equal(start.source, "voice");
  assert.match(start.message.content, /^look up the weather in Madrid/);
  assert.match(start.message.content, /voice call/);
  assert.equal(start.message.display, "look up the weather in Madrid", "the thread shows the task, not the voice-call note");
  assert.equal(events.some((event) => event.type === "ack"), false);
  assert.match(end.messages.map((message) => message.content).join(" "), /Mock reply/);

  const detail = await api(base, "GET", `/api/bots/${id}`);
  assert.equal(detail.conversation.some((message) => message.kind === "ack"), false);
  const voiceReplyMessage = detail.conversation.find((message) => message.via === "voice" && message.role === "assistant");
  assert.equal(voiceReplyMessage.content, "Sure, I will check that.");
});

test("voice reply falls back to the normal turn when there is no quick model, it fails, or it is too slow", async (t) => {
  const { base, id } = await setup(t, { env: { RAVNIR_VOICE_START_MS: "150" } });
  // Too slow: the first words come after 400 ms but the limit is 150 ms.
  const slow = await voiceCall(base, id, "slow please");
  assert.deepEqual(slow.map((line) => line.type), ["done"]);
  assert.equal(slow[0].fallback, true);
  assert.ok(slow[0].turnId);
  // Broken upstream.
  const broken = await voiceCall(base, id, "broken one");
  assert.equal(broken[0].fallback, true);
  // The fallback turns are ordinary turns that store the user message once, marked as voice.
  await waitFor(async () => (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events.filter((event) => event.type === "turn.end").length >= 2);
  const detail = await api(base, "GET", `/api/bots/${id}`);
  const users = detail.conversation.filter((message) => message.role === "user");
  assert.deepEqual(users.map((message) => message.content), ["slow please", "broken one"]);
  assert.ok(users.every((message) => message.via === "voice"));

  // No quick model at all.
  process.env.RAVNIR_QUICK = "off";
  const none = await voiceCall(base, id, "hello");
  assert.equal(none[0].fallback, true);
  assert.equal(none[0].type, "done");
});

test("voice reply respects the daily cap with a short spoken line", async (t) => {
  const { base, id } = await setup(t);
  await voiceCall(base, id, "hello");
  await api(base, "PATCH", `/api/bots/${id}`, { limits: { dailyTokens: 10 } });
  const lines = await voiceCall(base, id, "hello again");
  assert.deepEqual(lines.map((line) => line.type), ["delta", "done"]);
  assert.match(lines[0].text, /daily limit/);
  assert.equal(lines.at(-1).capped, true);
  assert.equal(lines.at(-1).delegated, false);
  const spanish = await voiceCall(base, id, "hola, ¿puedes ayudarme con el correo?");
  assert.match(spanish[0].text, /límite diario/);
});

test("voice reply needs text", async (t) => {
  const { base, id } = await setup(t);
  const response = await fetch(`${base}/api/bots/${id}/voice/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "  " }) });
  assert.equal(response.status, 400);
});
