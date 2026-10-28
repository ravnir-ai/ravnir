import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { canFallBack, clearPauses, handoverNote, modelChain, noteFailure, noteSuccess, toolLine, usableChain } from "../server/fallback.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";
process.env.RAVNIR_QUICK = "off";

test("only provider failures move to a backup model", () => {
  assert.equal(canFallBack(new Error("OpenCode: Service Unavailable")), true);
  assert.equal(canFallBack(new Error("OpenCode timed out before it replied.")), true);
  assert.equal(canFallBack(new Error("OpenCode stalled before it replied.")), true);
  assert.equal(canFallBack(new Error("The API returned 503: overloaded")), true);
  assert.equal(canFallBack(new Error("The API returned 429: rate limit")), true);
  assert.equal(canFallBack(new Error('OpenCode does not offer the model "x/y". Choose one from the model list.')), true);
  assert.equal(canFallBack(new Error("This operation was aborted")), true);
  assert.equal(canFallBack(new Error("Stopped.")), false);
  assert.equal(canFallBack(Object.assign(new Error("Daily cap reached."), { capped: true })), false);
  assert.equal(canFallBack(new Error("Stopped after 24 tool rounds.")), false);
  assert.equal(canFallBack(new Error("Set the API base URL for this bot.")), false);
});

test("the chain is the agent's model, then its backups without repeats, at most three", () => {
  const primary = { provider: "opencode", baseUrl: "http://oc", model: "a/1", fallbacks: [
    { provider: "opencode", baseUrl: "http://oc", model: "a/1" },
    { provider: "opencode", baseUrl: "http://oc", model: "b/2" },
    { provider: "opencode", baseUrl: "http://oc", model: "b/2" },
    { provider: "opencode", baseUrl: "http://oc", model: "c/3" },
    { provider: "opencode", baseUrl: "http://oc", model: "d/4" },
    { provider: "opencode", baseUrl: "http://oc", model: "e/5" },
  ] };
  assert.deepEqual(modelChain(primary).map((item) => item.model), ["a/1", "b/2", "c/3", "d/4"]);
  assert.match(handoverNote("a/1", "OpenCode: 503", ["send_email {\"to\":\"x\"}"]), /send_email.*\n.*Do not repeat/s);
});

test("a handover lists calls that never came back, and a retry on the same model says so", () => {
  assert.match(toolLine({ name: "message_bot", input: { bot: "Head of Finance" }, status: "running" }), /^message_bot .*Head of Finance.*may still be running/);
  assert.match(toolLine({ name: "web_search", input: { q: "x" }, status: "pending" }), /no result came back/);
  assert.doesNotMatch(toolLine({ name: "web_search", input: { q: "x" }, status: "completed" }), /\(/);
  assert.match(toolLine({ name: "web_search", input: {}, status: "error" }), /\(failed\)$/);
  const same = handoverNote("m", "OpenCode stalled before it replied.", ["message_bot {} (started, no result came back: it may still be running or may already have taken effect)"], { sameModel: true });
  assert.match(same, /^\(Ravnir: your previous attempt at this task stopped partway \(OpenCode stalled before it replied\.\) and this is a fresh session\./);
  assert.doesNotMatch(same, /taking over/);
  assert.match(same, /Do not repeat an action/);
});

test("a model whose sign-in expired or plan ran out is skipped for a while, then tried again", () => {
  clearPauses();
  const a = { provider: "opencode", baseUrl: "http://oc", model: "openai/sol" };
  const b = { provider: "opencode", baseUrl: "http://oc", model: "go/luna" };
  const t0 = 1_000_000;
  noteFailure(a, new Error("OpenCode: Service Unavailable"), t0);
  assert.deepEqual(usableChain([a, b], t0).usable, [a, b]);
  noteFailure(a, new Error('OpenCode: token refresh failed (400): {"error":"invalid_grant"}'), t0);
  const { usable, skipped } = usableChain([a, b], t0 + 60_000);
  assert.deepEqual(usable, [b]);
  assert.equal(skipped[0].model, "openai/sol");
  assert.equal(skipped[0].skipped, true);
  assert.deepEqual(usableChain([a, b], t0 + 7 * 60 * 60_000).usable, [a, b]);
  noteFailure(b, new Error("The API returned 429: usage limit reached"), t0);
  assert.deepEqual(usableChain([a, b], t0 + 60_000).usable, [a, b], "all paused: try them all");
  noteSuccess(a);
  assert.deepEqual(usableChain([a, b], t0 + 60_000).usable, [a]);
  clearPauses();
});

// A stand-in OpenCode where the model "flaky/model" fails at the provider and "steady/model" answers.
// With `toolFirst`, the flaky model runs a tool before it fails.
function startOpenCode({ toolFirst = false, failure = "Service Unavailable" } = {}) {
  const sessions = new Map();
  const prompts = [];
  let next = 0;
  const now = () => Date.now();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? "" : JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (url.pathname === "/global/health") return send({ healthy: true });
      if (url.pathname === "/provider") return send({ all: [] });
      if (url.pathname === "/session/status") return send({});
      if (url.pathname === "/permission") return send([]);
      if (url.pathname.endsWith("/diff")) return send([]);
      if (url.pathname.endsWith("/abort")) return send(true);
      if (req.method === "POST" && url.pathname === "/session") {
        const id = `ses${++next}`;
        sessions.set(id, []);
        return send({ id });
      }
      const match = url.pathname.match(/^\/session\/([^/]+)\/(message|prompt_async)$/);
      if (match && sessions.has(match[1])) {
        const messages = sessions.get(match[1]);
        if (req.method === "GET") return send(messages);
        const body = JSON.parse(raw || "{}");
        const text = (body.parts || []).map((part) => part.text || "").join("\n");
        const model = `${body.model?.providerID}/${body.model?.modelID}`;
        prompts.push({ model, text });
        messages.push({ info: { role: "user", time: { created: now() } }, parts: [{ type: "text", text }] });
        if (model === "flaky/model") {
          const parts = toolFirst ? [{ type: "tool", callID: "t1", tool: "send_email", state: { status: "completed", input: { to: "ana@example.com" }, output: "sent" } }] : [];
          messages.push({ info: { role: "assistant", error: { name: "APIError", data: { message: failure } }, time: { created: now(), completed: now() + 1 } }, parts });
        } else {
          messages.push({ info: { role: "assistant", time: { created: now(), completed: now() + 1 } }, parts: [{ type: "text", text: "Hecho con el modelo de respaldo." }] });
        }
        return match[2] === "prompt_async" ? send({}, 204) : send(messages.at(-1));
      }
      send({}, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, prompts, url: `http://127.0.0.1:${server.address().port}` })));
}

async function withApp(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-fallback-"));
  const app = createApp({ home, projectRoot });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const api = async (method, pathname, body) => {
    const { status, data } = await call(method, pathname, body);
    assert.ok(status < 400, JSON.stringify(data));
    return data;
  };
  const waitEnd = async (botId, turnId) => {
    for (let i = 0; i < 200; i += 1) {
      const { events } = await api("GET", `/api/bots/${botId}/events?after=0`);
      const end = events.find((event) => event.type === "turn.end" && event.turnId === turnId);
      if (end) return { end, events };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("turn did not end");
  };
  const ledger = () => {
    const file = [path.join(home, "turns.ndjson"), path.join(home, "data", "turns.ndjson")].find((item) => fs.existsSync(item));
    return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  };
  try {
    await run({ api, call, waitEnd, ledger });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

test("a provider failure moves the turn to the backup model and the ledger says so", async () => {
  const opencode = await startOpenCode();
  try {
    await withApp(async ({ api, waitEnd, ledger }) => {
      const model = { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "flaky/model", fallbacks: [{ provider: "opencode", baseUrl: opencode.url, model: "steady/model" }] };
      const { bot } = await api("POST", "/api/bots", { name: "PA", job: "Assistant", model });
      assert.deepEqual(bot.model.fallbacks.map((item) => item.model), ["steady/model"]);
      const { turnId } = await api("POST", `/api/bots/${bot.id}/messages`, { text: "mira los horarios del cine" });
      const { end, events } = await waitEnd(bot.id, turnId);
      assert.equal(end.error || "", "");
      const reply = end.messages.find((message) => message.role === "assistant" && !message.kind);
      assert.equal(reply.content, "Hecho con el modelo de respaldo.");
      assert.deepEqual(reply.fallback, { model: "steady/model", failed: ["flaky/model"] });
      assert.ok(events.some((event) => event.type === "fallback" && event.from === "flaky/model" && event.to === "steady/model"));
      assert.deepEqual(opencode.prompts.map((item) => item.model), ["flaky/model", "steady/model"]);
      // Nothing ran before the failure, so the backup gets the plain request.
      assert.doesNotMatch(opencode.prompts[1].text, /taking over/);
      const row = ledger().find((item) => item.id === turnId);
      assert.equal(row.status, "ok");
      assert.equal(row.model, "steady/model");
      assert.equal(row.fallbacks[0].model, "flaky/model");
      assert.match(row.fallbacks[0].error, /Service Unavailable/);
    });
  } finally {
    opencode.server.close();
  }
});

test("a backup that takes over mid-task is told which tools already ran", async () => {
  const opencode = await startOpenCode({ toolFirst: true });
  try {
    await withApp(async ({ api, waitEnd }) => {
      const model = { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "flaky/model", fallbacks: [{ provider: "opencode", baseUrl: opencode.url, model: "steady/model" }] };
      const { bot } = await api("POST", "/api/bots", { name: "Inbox", job: "Email", model });
      const { turnId } = await api("POST", `/api/bots/${bot.id}/messages`, { text: "contesta a Ana" });
      const { end } = await waitEnd(bot.id, turnId);
      assert.equal(end.error || "", "");
      const handover = opencode.prompts[1].text;
      assert.match(handover, /flaky\/model, failed partway/);
      assert.match(handover, /send_email .*ana@example\.com/);
      assert.match(handover, /Do not repeat an action/);
    });
  } finally {
    opencode.server.close();
  }
});

test("with no backups the provider failure still ends the turn with the error", async () => {
  const opencode = await startOpenCode();
  try {
    await withApp(async ({ api, waitEnd }) => {
      const { bot } = await api("POST", "/api/bots", { name: "Solo", job: "One model", model: { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "flaky/model" } });
      const { turnId } = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hola" });
      const { end } = await waitEnd(bot.id, turnId);
      assert.match(end.error, /Service Unavailable/);
      assert.equal(opencode.prompts.length, 1);
    });
  } finally {
    opencode.server.close();
  }
});

test("after a sign-in failure the next turn starts on the backup without trying the dead model", async () => {
  clearPauses();
  const opencode = await startOpenCode({ failure: "ChatGPT token refresh failed (400): invalid_grant" });
  try {
    await withApp(async ({ api, waitEnd, ledger }) => {
      const model = { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "flaky/model", fallbacks: [{ provider: "opencode", baseUrl: opencode.url, model: "steady/model" }] };
      const { bot } = await api("POST", "/api/bots", { name: "Chief", job: "Coordinator", model });
      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "uno" });
      await waitEnd(bot.id, first.turnId);
      const second = await api("POST", `/api/bots/${bot.id}/messages`, { text: "dos" });
      const { end } = await waitEnd(bot.id, second.turnId);
      assert.deepEqual(opencode.prompts.map((item) => item.model), ["flaky/model", "steady/model", "steady/model"]);
      const reply = end.messages.find((message) => message.role === "assistant" && !message.kind);
      assert.deepEqual(reply.fallback, { model: "steady/model", failed: ["flaky/model"] });
      const row = ledger().find((item) => item.id === second.turnId);
      assert.equal(row.fallbacks[0].skipped, true);
    });
  } finally {
    clearPauses();
    opencode.server.close();
  }
});

test("backup models are set, replaced and cleared through the agent API", async () => {
  await withApp(async ({ api, call }) => {
    const { bot } = await api("POST", "/api/bots", { name: "Lead", job: "Engineer", model: { provider: "opencode", baseUrl: "http://127.0.0.1:9", apiKey: "pw", model: "a/1" } });
    let saved = await api("PATCH", `/api/bots/${bot.id}`, { model: { fallbacks: [{ provider: "opencode", baseUrl: "http://127.0.0.1:9", model: "b/2" }, { provider: "opencode", baseUrl: "http://127.0.0.1:9", model: "a/1" }] } });
    assert.deepEqual(saved.bot.model.fallbacks.map((item) => item.model), ["b/2"]);
    assert.equal(saved.bot.model.model, "a/1");
    const tooMany = await call("PATCH", `/api/bots/${bot.id}`, { model: { fallbacks: [1, 2, 3, 4].map((n) => ({ model: `x/${n}` })) } });
    assert.equal(tooMany.status, 400);
    const notList = await call("PATCH", `/api/bots/${bot.id}`, { model: { fallbacks: "b/2" } });
    assert.equal(notList.status, 400);
    saved = await api("PATCH", `/api/bots/${bot.id}`, { model: { fallbacks: [] } });
    assert.deepEqual(saved.bot.model.fallbacks, []);
  });
});
