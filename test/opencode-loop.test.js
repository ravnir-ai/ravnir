import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { clearPauses } from "../server/fallback.js";
import { REJECT_FEEDBACK, runOpenCodeTurn } from "../server/providers/opencode.js";
import { planNote } from "../server/quick.js";
import { startMock } from "../scripts/mock-openai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";
process.env.RAVNIR_QUICK = "off";

// A stand-in OpenCode. `status` is "scoped" (busy sessions are listed only to a request that names their
// directory, as OpenCode does) or "empty" (always {}, like the wrong instance or an older build).
// `onPrompt(session, { text, model })` sets up what the model does; it mutates the session over time.
function startOpenCode({ status = "scoped", onPrompt, onReply = () => {}, permissions = () => [] } = {}) {
  const sessions = new Map();
  const prompts = [];
  const replies = [];
  const statusReads = [];
  let next = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (body, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(code === 204 ? "" : JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const directory = url.searchParams.get("directory") || req.headers["x-opencode-directory"] || "";
      if (url.pathname === "/global/health") return send({ healthy: true });
      if (url.pathname === "/provider") return send({ all: [] });
      if (url.pathname === "/session/status") {
        statusReads.push(directory);
        if (status === "empty") return send({});
        return send(Object.fromEntries([...sessions].filter(([, item]) => item.busy && item.directory === directory).map(([id]) => [id, { type: "busy" }])));
      }
      if (url.pathname === "/permission") return send(permissions(sessions));
      const reply = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (reply) {
        const body = JSON.parse(raw || "{}");
        replies.push({ id: reply[1], body });
        // onReply returns false for a request OpenCode no longer holds; it answers 404 then.
        if (onReply(reply[1], body, sessions) === false) return send({ name: "NotFoundError", data: { requestID: reply[1] } }, 404);
        return send(true);
      }
      if (url.pathname.endsWith("/diff")) return send([]);
      const abort = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (abort) {
        const session = sessions.get(abort[1]);
        if (session) Object.assign(session, { aborted: true, busy: false });
        return send(true);
      }
      if (req.method === "POST" && url.pathname === "/session") {
        const id = `ses${++next}`;
        sessions.set(id, { id, n: next, directory, messages: [], busy: false, aborted: false });
        return send({ id });
      }
      const match = url.pathname.match(/^\/session\/([^/]+)\/(message|prompt_async)$/);
      if (match && sessions.has(match[1])) {
        const session = sessions.get(match[1]);
        if (req.method === "GET") return send(session.messages);
        const body = JSON.parse(raw || "{}");
        const text = (body.parts || []).map((part) => part.text || "").join("\n");
        const model = body.model ? `${body.model.providerID}/${body.model.modelID}` : "";
        prompts.push({ session: session.id, model, text });
        session.messages.push({ info: { role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text }] });
        onPrompt(session, { text, model });
        return send({}, 204);
      }
      send({}, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    prompts,
    replies,
    statusReads,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

const assistant = (parts) => ({ info: { role: "assistant", time: { created: Date.now() } }, parts });
const later = (session, ms, change) => setTimeout(() => { if (!session.aborted) change(); }, ms);
const finish = (message, text) => {
  message.parts.push({ type: "text", text });
  message.info.time.completed = Date.now();
};

async function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function turn(opencode, extra = {}) {
  const events = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-oc-loop-"));
  const run = runOpenCodeTurn({
    bot: { name: "t", model: { provider: "opencode", baseUrl: opencode.url, username: "opencode", apiKey: "", model: "" } },
    directory,
    remote: {},
    title: "t",
    text: "¿Qué tiempo hace en Madrid?",
    systemPrompt: "You are t.",
    history: "",
    emit: (event) => events.push(event),
    waitForDecision: async () => "reject",
    ...extra,
  });
  return { run, events, directory };
}

const stoppedResponding = (events) => events.some((event) => event.type === "status" && /stopped responding/.test(event.message || ""));

// A long tool: the session is busy and its tool runs for 2.5 s, well past the 0.8 s stall limit.
function slowTool(session) {
  session.busy = true;
  const message = assistant([{ type: "tool", callID: `w${session.n}`, tool: "ravnir_web_research", state: { status: "running", input: { query: "tiempo Madrid" } } }]);
  session.messages.push(message);
  later(session, 2500, () => {
    Object.assign(message.parts[0].state, { status: "completed", output: "ok" });
    finish(message, "Soleado, 24 grados.");
    session.busy = false;
  });
}

test("a tool that runs past the stall limit is not killed when OpenCode reports the session busy", async () => {
  const opencode = await startOpenCode({ status: "scoped", onPrompt: slowTool });
  try {
    await withEnv({ RAVNIR_OPENCODE_STALL_MS: "800", RAVNIR_OPENCODE_START_MS: "60000" }, async () => {
      const { run, events, directory } = await turn(opencode);
      const result = await run;
      assert.equal(result.text, "Soleado, 24 grados.");
      assert.equal(stoppedResponding(events), false);
      assert.equal(opencode.prompts.length, 1);
      // The status read names the agent's directory, so it reaches the instance that runs the session.
      assert.ok(opencode.statusReads.includes(directory));
    });
  } finally {
    await opencode.close();
  }
});

test("a running tool is not a stall even when the status comes back empty", async () => {
  const opencode = await startOpenCode({ status: "empty", onPrompt: slowTool });
  try {
    await withEnv({ RAVNIR_OPENCODE_STALL_MS: "800", RAVNIR_OPENCODE_START_MS: "60000" }, async () => {
      const { run, events } = await turn(opencode);
      assert.equal((await run).text, "Soleado, 24 grados.");
      assert.equal(stoppedResponding(events), false);
      assert.equal(opencode.prompts.length, 1);
    });
  } finally {
    await opencode.close();
  }
});

test("a model that keeps reasoning is making progress, not stalled", async () => {
  const opencode = await startOpenCode({
    status: "empty",
    onPrompt: (session) => {
      const message = assistant([{ type: "reasoning", text: "" }]);
      session.messages.push(message);
      for (let i = 1; i <= 7; i += 1) later(session, i * 300, () => { message.parts[0].text += "x".repeat(50); });
      later(session, 2300, () => finish(message, "Pensado y hecho."));
    },
  });
  try {
    await withEnv({ RAVNIR_OPENCODE_STALL_MS: "800", RAVNIR_OPENCODE_START_MS: "60000" }, async () => {
      const { run, events } = await turn(opencode);
      assert.equal((await run).text, "Pensado y hecho.");
      assert.equal(stoppedResponding(events), false);
    });
  } finally {
    await opencode.close();
  }
});

test("a session that stays busy with no change at all still fails over", async () => {
  const opencode = await startOpenCode({ status: "scoped", onPrompt: (session) => { session.busy = true; } });
  try {
    await withEnv({ RAVNIR_OPENCODE_STALL_MS: "800", RAVNIR_OPENCODE_BUSY_STALL_MS: "1500", RAVNIR_OPENCODE_START_MS: "60000" }, async () => {
      const { run, events } = await turn(opencode);
      await assert.rejects(run, (error) => /OpenCode stalled before it replied/.test(error.message) && error.resetRemote === true);
      assert.equal(stoppedResponding(events), true);
      assert.equal(opencode.prompts.length, 2);
    });
  } finally {
    await opencode.close();
  }
});

test("a refused permission is answered with feedback, so the agent finishes instead of stopping", async () => {
  const opencode = await startOpenCode({
    status: "empty",
    onPrompt: (session) => {
      session.pending = true;
      session.reply = assistant([
        { type: "text", text: "Voy a consultar el servidor." },
        { type: "tool", callID: "b1", tool: "bash", state: { status: "pending", input: { command: "ssh hub 'ls /opt'" } } },
      ]);
      session.messages.push(session.reply);
    },
    permissions: (sessions) => [...sessions.values()].filter((item) => item.pending).map((item) => ({ id: "per1", sessionID: item.id, permission: "bash", patterns: ["ssh hub 'ls /opt'"], metadata: { command: "ssh hub 'ls /opt'" } })),
    onReply: (id, body, sessions) => {
      for (const session of sessions.values()) {
        if (!session.pending) continue;
        session.pending = false;
        const message = session.reply;
        Object.assign(message.parts[1].state, { status: "error", error: "rejected" });
        // OpenCode keeps the loop going only when the refusal carries a message; a bare reject ends it.
        if (body.message) finish(message, "\nHecho sin ssh.");
        else message.info.time.completed = Date.now();
      }
    },
  });
  try {
    await withEnv({ RAVNIR_OPENCODE_STALL_MS: "5000", RAVNIR_OPENCODE_START_MS: "60000" }, async () => {
      const asked = [];
      const { run } = await turn(opencode, { waitForDecision: async (id, signal, meta) => { asked.push(meta); return "reject"; } });
      const result = await run;
      assert.equal(asked.length, 1);
      assert.equal(asked[0].command, "ssh hub 'ls /opt'");
      assert.deepEqual(opencode.replies.map((item) => item.body), [{ reply: "reject", message: REJECT_FEEDBACK }]);
      assert.match(REJECT_FEEDBACK, /Not approved\. Do not run this call again/);
      assert.match(result.text, /Hecho sin ssh\.$/);
    });
  } finally {
    await opencode.close();
  }
});

test("refusing one of two parallel requests asks the user once and never answers the one OpenCode already refused", async () => {
  const calls = [
    { id: "per1", callID: "b1", command: "ssh hub 'ls /opt'" },
    { id: "per2", callID: "b2", command: "ssh backup 'uptime'" },
  ];
  const opencode = await startOpenCode({
    status: "empty",
    onPrompt: (session) => {
      session.pending = new Set(calls.map((call) => call.id));
      session.reply = assistant([
        { type: "text", text: "Voy a consultar los dos servidores." },
        ...calls.map((call) => ({ type: "tool", callID: call.callID, tool: "bash", state: { status: "pending", input: { command: call.command } } })),
      ]);
      session.messages.push(session.reply);
    },
    permissions: (sessions) => [...sessions.values()].flatMap((session) => calls
      .filter((call) => session.pending?.has(call.id))
      .map((call) => ({ id: call.id, sessionID: session.id, permission: "bash", patterns: [call.command], metadata: { command: call.command } }))),
    // Like OpenCode 1.18: a refusal settles the chosen request with its feedback and every other pending
    // request of the session with a bare refusal; a request no longer pending is not found.
    onReply: (id, body, sessions) => {
      const session = [...sessions.values()].find((item) => item.pending?.has(id));
      if (!session) return false;
      session.pending.clear();
      for (const part of session.reply.parts.slice(1)) Object.assign(part.state, { status: "error", error: "rejected" });
      finish(session.reply, "\nHecho sin ssh.");
      return true;
    },
  });
  try {
    await withEnv({ RAVNIR_OPENCODE_STALL_MS: "5000", RAVNIR_OPENCODE_START_MS: "60000" }, async () => {
      const asked = [];
      const { run } = await turn(opencode, { waitForDecision: async (id, signal, meta) => { asked.push(meta); return "reject"; } });
      const result = await run;
      assert.deepEqual(asked.map((item) => item.command), ["ssh hub 'ls /opt'"]);
      assert.deepEqual(opencode.replies, [{ id: "per1", body: { reply: "reject", message: REJECT_FEEDBACK } }]);
      assert.match(result.text, /Hecho sin ssh\.$/);
    });
  } finally {
    await opencode.close();
  }
});

test("an answer to a request OpenCode settled a moment earlier does not fail the turn", async () => {
  const opencode = await startOpenCode({
    status: "empty",
    onPrompt: (session) => {
      session.pending = true;
      session.reply = assistant([
        { type: "text", text: "Voy a mirar." },
        { type: "tool", callID: "b1", tool: "bash", state: { status: "pending", input: { command: "ls /srv" } } },
      ]);
      session.messages.push(session.reply);
    },
    permissions: (sessions) => [...sessions.values()].filter((item) => item.pending).map((item) => ({ id: "per1", sessionID: item.id, permission: "bash", patterns: ["ls /srv"], metadata: { command: "ls /srv" } })),
    // Still listed when Ravnir checks, gone when its answer lands.
    onReply: (id, body, sessions) => {
      for (const session of sessions.values()) {
        if (!session.pending) continue;
        session.pending = false;
        Object.assign(session.reply.parts[1].state, { status: "completed", output: "app" });
        finish(session.reply, "\nHay una carpeta: app.");
      }
      return false;
    },
  });
  try {
    await withEnv({ RAVNIR_OPENCODE_STALL_MS: "5000", RAVNIR_OPENCODE_START_MS: "60000" }, async () => {
      const { run } = await turn(opencode, { waitForDecision: async () => "once" });
      const result = await run;
      assert.equal(opencode.replies.length, 1);
      assert.match(result.text, /Hay una carpeta: app\.$/);
    });
  } finally {
    await opencode.close();
  }
});

async function withApp(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-oc-loop-app-"));
  const app = createApp({ home, projectRoot });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.ok(response.status < 400, JSON.stringify(data));
    return data;
  };
  const waitEnd = async (botId, turnId) => {
    for (let i = 0; i < 400; i += 1) {
      const { events } = await api("GET", `/api/bots/${botId}/events?after=0`);
      const end = events.find((event) => event.type === "turn.end" && event.turnId === turnId);
      if (end) return { end, events };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("turn did not end");
  };
  try {
    await run({ api, waitEnd, home });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return "";
}

test("a fresh session and a backup model both hear about a tool that was still running when a session was dropped", async () => {
  clearPauses();
  const opencode = await startOpenCode({
    status: "empty",
    onPrompt: (session, { model }) => {
      if (model === "stuck/model") {
        // It asks a teammate and waits; the session is dropped before the answer comes back.
        session.messages.push(assistant([{ type: "tool", callID: `m${session.n}`, tool: "ravnir_message_bot", state: { status: "running", input: { bot: "Head of Finance", wait: true } } }]));
      } else {
        const message = assistant([]);
        finish(message, "Hecho con el modelo de respaldo.");
        session.messages.push(message);
      }
    },
  });
  try {
    await withEnv({ RAVNIR_OPENCODE_TOOL_STALL_MS: "600", RAVNIR_OPENCODE_START_MS: "60000" }, () => withApp(async ({ api, waitEnd }) => {
      const model = { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "stuck/model", fallbacks: [{ provider: "opencode", baseUrl: opencode.url, model: "steady/model" }] };
      const { bot } = await api("POST", "/api/bots", { name: "Chief", job: "Coordinator", model });
      const { turnId } = await api("POST", `/api/bots/${bot.id}/messages`, { text: "¿Cuánto hemos ingresado este mes?" });
      const { end } = await waitEnd(bot.id, turnId);
      assert.equal(end.error || "", "");
      assert.deepEqual(opencode.prompts.map((item) => item.model), ["stuck/model", "stuck/model", "steady/model"]);
      assert.doesNotMatch(opencode.prompts[0].text, /Ravnir:/);
      const retry = opencode.prompts[1].text;
      assert.match(retry, /your previous attempt at this task stopped partway/);
      assert.match(retry, /ravnir_message_bot .*Head of Finance.*may still be running/);
      const handover = opencode.prompts[2].text;
      assert.match(handover, /stuck\/model, failed partway/);
      assert.match(handover, /ravnir_message_bot .*Head of Finance.*may still be running/);
      const reply = end.messages.find((message) => message.role === "assistant" && !message.kind);
      assert.equal(reply.content, "Hecho con el modelo de respaldo.");
    }));
  } finally {
    clearPauses();
    await opencode.close();
  }
});

test("the agent hears the quick plan line as a courtesy, not an order, and OpenCode's question tool is off", async () => {
  const mock = await startMock();
  const opencode = await startOpenCode({
    status: "empty",
    onPrompt: (session) => {
      const message = assistant([]);
      finish(message, "Listo.");
      session.messages.push(message);
    },
  });
  try {
    await withEnv({ RAVNIR_QUICK: undefined, RAVNIR_QUICK_URL: mock.url, RAVNIR_QUICK_MODEL: "mock-model", RAVNIR_OPENCODE_START_MS: "60000" }, () => withApp(async ({ api, waitEnd, home }) => {
      const { bot } = await api("POST", "/api/bots", { name: "Researcher", job: "Research", model: { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "steady/model" } });
      const { turnId } = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Mira cada día a las 9 las ofertas nuevas" });
      const { end } = await waitEnd(bot.id, turnId);
      assert.equal(end.error || "", "");
      const sent = opencode.prompts[0].text;
      assert.ok(sent.endsWith(planNote("Okay. I'll take care of that now.")), sent);
      assert.match(sent, /It is not an instruction/);
      assert.doesNotMatch(sent, /Do that now/);
      const config = JSON.parse(fs.readFileSync(findFile(home, "opencode.json"), "utf8"));
      assert.equal(config.permission.question, "deny");
      assert.equal(config.experimental.continue_loop_on_deny, true, "a refusal must not end the loop");
    }));
  } finally {
    await opencode.close();
    await mock.close();
  }
});
