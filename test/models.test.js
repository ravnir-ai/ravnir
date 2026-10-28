import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { createModels } from "../server/models.js";
import { SecretStore } from "../server/secrets.js";
import { pickFreeModel } from "../server/setup.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

// A stand-in for OpenCode's server API: providers, auth methods, auth writes and device sign-in.
async function fakeOpenCode(password = "oc-pass") {
  const calls = [];
  const auth = new Set(["openai"]);
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, url: req.url, body });
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    const json = (data) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/global/health") return json({ healthy: true });
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary" }]);
    if (url.pathname === "/provider") {
      return json({
        all: [
          { id: "openai", name: "OpenAI", source: "api", env: ["OPENAI_API_KEY"], models: {
            "gpt-5.4-mini": { id: "gpt-5.4-mini", name: "GPT-5.4 mini", cost: { input: 0.25, output: 2 }, limit: { context: 400000, output: 128000 }, capabilities: { reasoning: true } },
            "gpt-old": { id: "gpt-old", name: "Old", status: "deprecated" },
          } },
          { id: "groq", name: "Groq", source: "custom", env: ["GROQ_API_KEY"], models: { "llama": { id: "llama", name: "Llama" } } },
          { id: "zzz", name: "Zed Provider", source: "custom", env: [], models: {} },
        ],
        connected: [...auth],
        default: {},
      });
    }
    if (url.pathname === "/provider/auth") {
      return json({ openai: [{ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { type: "oauth", label: "ChatGPT Pro/Plus (headless)" }, { type: "api", label: "Manually enter API Key" }] });
    }
    const authMatch = url.pathname.match(/^\/auth\/([^/]+)$/);
    if (authMatch && req.method === "PUT") {
      auth.add(authMatch[1]);
      return json(true);
    }
    if (authMatch && req.method === "DELETE") {
      auth.delete(authMatch[1]);
      return json(true);
    }
    if (url.pathname === "/provider/openai/oauth/authorize") return json({ url: "https://auth.example/device", method: "auto", instructions: "Enter code: ABCD-1234" });
    if (url.pathname === "/provider/openai/oauth/callback") return json(true);
    if (url.pathname === "/instance/dispose" || url.pathname.startsWith("/mcp/")) return json(true);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, auth, close: () => new Promise((resolve) => server.close(resolve)) };
}

function harness({ bots = [], env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-models-"));
  const secrets = new SecretStore(home);
  const state = { bots, settings: {} };
  let saves = 0;
  const models = createModels({ state, secrets, saveState: () => { saves += 1; }, env });
  return { home, secrets, state, models, saves: () => saves };
}

test("the server's OpenCode is adopted from the agents that already reach it", async () => {
  const bots = [
    { id: "a", model: { provider: "opencode", baseUrl: "http://127.0.0.1:4098", username: "opencode" } },
    { id: "b", model: { provider: "opencode", baseUrl: "http://127.0.0.1:4098/", username: "opencode" } },
    { id: "c", model: { provider: "opencode", baseUrl: "http://127.0.0.1:4096", username: "opencode" } },
  ];
  const h = harness({ bots });
  h.secrets.set("bot:a:apiKey", "right");
  h.secrets.set("bot:b:apiKey", "right");
  h.secrets.set("bot:c:apiKey", "other");
  const oc = h.models.opencode();
  assert.equal(oc.baseUrl, "http://127.0.0.1:4098");
  assert.equal(oc.apiKey, "right");
  assert.equal(oc.source, "adopted");
  assert.equal(h.state.settings.opencode.source, "adopted");
  assert.equal(JSON.stringify(h.state.settings).includes("right"), false, "the password stays in the vault");
  // A new agent on the same server needs no password of its own.
  assert.equal(h.models.keyFor({ id: "new", model: { provider: "opencode", baseUrl: "http://localhost:4098" } }), "right");
  // An agent with its own key keeps it.
  assert.equal(h.models.keyFor(bots[2]), "other");
  // An OpenAI-compatible agent never gets the OpenCode password.
  assert.equal(h.models.keyFor({ id: "x", model: { provider: "openai", baseUrl: "http://127.0.0.1:4098" } }), "");
});

test("environment settings win over saved and adopted ones", () => {
  const h = harness({ env: { RAVNIR_OPENCODE_URL: "http://127.0.0.1:4555/", OPENCODE_SERVER_PASSWORD: "from-env" } });
  const oc = h.models.opencode();
  assert.deepEqual([oc.baseUrl, oc.apiKey, oc.source], ["http://127.0.0.1:4555", "from-env", "env"]);
  const choice = h.models.resolveChoice({ via: "opencode", model: "openai/gpt-5.4-mini" });
  assert.deepEqual(choice, { provider: "opencode", baseUrl: "http://127.0.0.1:4555", username: "opencode", model: "openai/gpt-5.4-mini", agent: "build", connection: "" });
  assert.equal(h.models.resolveChoice({ model: "x" }), null);
  assert.throws(() => h.models.resolveChoice({ via: "server:nope", model: "x" }), /no longer connected/);
});

test("catalog, list, key and device sign-in go through OpenCode's auth API", async () => {
  const oc = await fakeOpenCode();
  const h = harness({ env: { RAVNIR_OPENCODE_URL: oc.url, RAVNIR_OPENCODE_PASSWORD: "oc-pass" } });
  try {
    const catalog = await h.models.catalog();
    assert.equal(catalog.opencode.connected, true);
    assert.deepEqual(catalog.providers.map((p) => p.id), ["openai", "groq", "zzz"], "connected first, then popular, then the rest");
    const openai = catalog.providers[0];
    assert.equal(openai.keyUrl, "https://platform.openai.com/api-keys");
    assert.deepEqual(openai.methods.map((m) => [m.index, m.type, m.remote]), [[0, "oauth", false], [1, "oauth", true], [2, "api", true]]);
    assert.deepEqual(catalog.providers[1].methods.map((m) => m.type), ["api"], "a provider without auth methods takes a key");

    const list = await h.models.list();
    assert.deepEqual(list.models.map((m) => m.id), ["openai/gpt-5.4-mini"], "only connected providers, no deprecated models");
    assert.deepEqual(list.models[0].cost, { input: 0.25, output: 2 });
    assert.equal(list.models[0].context, 400000);

    const keyed = await h.models.setKey("groq", { key: " gsk_test ", inputs: { accountId: "abc", bad: 5 } });
    assert.equal(keyed.provider.connected, true);
    const put = oc.calls.find((c) => c.method === "PUT");
    assert.equal(put.url, "/auth/groq");
    assert.deepEqual(put.body, { type: "api", key: "gsk_test", metadata: { accountId: "abc" } });
    await assert.rejects(h.models.setKey("groq", { key: "" }), /Paste the API key/);
    await assert.rejects(h.models.setKey("../etc", { key: "x" }), /Unknown provider/);

    const start = await h.models.oauthStart("openai", { method: 1 });
    assert.deepEqual(start, { url: "https://auth.example/device", mode: "auto", instructions: "Enter code: ABCD-1234" });
    const finish = await h.models.oauthFinish("openai", { method: 1 });
    assert.equal(finish.ok, true);
    assert.deepEqual(oc.calls.find((c) => c.url.startsWith("/provider/openai/oauth/callback")).body, { method: 1 });

    await h.models.signOut("groq");
    assert.equal(oc.auth.has("groq"), false);
  } finally {
    await oc.close();
  }
});

test("a wrong OpenCode password gets a plain answer, a right one is saved in the vault", async () => {
  const oc = await fakeOpenCode("good");
  const h = harness();
  try {
    await assert.rejects(h.models.connectOpenCode({ baseUrl: oc.url, password: "bad" }), /password is wrong/);
    const saved = await h.models.connectOpenCode({ baseUrl: `${oc.url}/`, password: "good" });
    assert.equal(saved.connected, true);
    assert.equal(h.state.settings.opencode.baseUrl, oc.url);
    assert.equal(JSON.stringify(h.state.settings).includes("good"), false);
    assert.equal(h.models.keyFor({ id: "n", model: { provider: "opencode", baseUrl: oc.url } }), "good");
  } finally {
    await oc.close();
  }
});

test("an OpenAI-compatible server is tested, saved, and its key reaches only its agents", async () => {
  const api = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer lm-key") return res.writeHead(401).end("{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen-coder" }] }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${api.address().port}/v1`;
  const h = harness();
  try {
    await assert.rejects(h.models.addServer({ name: "LM", baseUrl: url, apiKey: "wrong" }));
    const { server } = await h.models.addServer({ name: "LM Studio", baseUrl: url, apiKey: "lm-key" });
    assert.equal(server.models, 1);
    assert.equal(server.keySet, true);
    const choice = h.models.resolveChoice({ via: `server:${server.id}`, model: "qwen-coder" });
    assert.equal(choice.provider, "openai");
    assert.equal(h.models.keyFor({ id: "z", model: choice }), "lm-key");
    const list = await h.models.list();
    assert.deepEqual(list.models.map((m) => [m.id, m.via]), [["qwen-coder", `server:${server.id}`]]);
    h.models.removeServer(server.id);
    assert.equal(h.models.keyFor({ id: "z", model: choice }), "");
  } finally {
    await new Promise((resolve) => api.close(resolve));
  }
});

test("a new agent made from a picked model needs no password and runs on the server's OpenCode", async () => {
  const oc = await fakeOpenCode("srv");
  process.env.RAVNIR_OPENCODE_URL = oc.url;
  process.env.RAVNIR_OPENCODE_PASSWORD = "srv";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-models-app-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  try {
    const created = await call("POST", "/api/bots", { name: "Picker", job: "Test", model: { via: "opencode", model: "openai/gpt-5.4-mini" } });
    assert.equal(created.status, 201);
    assert.equal(created.data.bot.model.baseUrl, oc.url);
    assert.equal(created.data.bot.model.model, "openai/gpt-5.4-mini");
    // The old form's probe works with no password typed, because the server knows it.
    const probe = await call("POST", "/api/models", { provider: "opencode", baseUrl: oc.url });
    assert.equal(probe.status, 200);
    assert.ok(probe.data.models.some((m) => m.id === "openai/gpt-5.4-mini"));
    const catalog = await call("GET", "/api/models/catalog");
    assert.equal(catalog.data.opencode.source, "env");
    const list = await call("GET", "/api/models/list");
    assert.equal(list.data.models.length, 1);
    assert.equal(JSON.stringify(catalog.data).includes("srv"), false, "the password never reaches the browser");
  } finally {
    delete process.env.RAVNIR_OPENCODE_URL;
    delete process.env.RAVNIR_OPENCODE_PASSWORD;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await oc.close();
  }
});

test("adoption takes the password most agents share, and addresses never carry a password", async () => {
  const bots = ["a", "b", "c"].map((id) => ({ id, model: { provider: "opencode", baseUrl: "http://127.0.0.1:4098", username: "opencode" } }));
  const h = harness({ bots });
  h.secrets.set("bot:a:apiKey", "stale");
  h.secrets.set("bot:b:apiKey", "current");
  h.secrets.set("bot:c:apiKey", "current");
  assert.equal(h.models.opencode().apiKey, "current");
  await assert.rejects(h.models.connectOpenCode({ baseUrl: "http://user:secret@127.0.0.1:1/", password: "x" }), /Do not put a password in the address/);
  await assert.rejects(h.models.addServer({ name: "x", baseUrl: "http://user:secret@127.0.0.1:1/v1" }), /Do not put a password in the address/);
  await assert.rejects(h.models.addServer({ name: "x", baseUrl: "ftp://127.0.0.1/" }), /Enter the server address/);
});

test("a sign-in the browser gives up on stops waiting on OpenCode too", async () => {
  let aborted = false;
  const slow = http.createServer((req, res) => {
    if (req.url.startsWith("/provider/openai/oauth/callback")) {
      req.on("close", () => { aborted = true; });
      return; // never answers, like a person who never finishes signing in
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const h = harness({ env: { RAVNIR_OPENCODE_URL: `http://127.0.0.1:${slow.address().port}`, RAVNIR_OPENCODE_PASSWORD: "x" } });
  try {
    const gone = new AbortController();
    const waiting = h.models.oauthFinish("openai", { method: 1 }, { signal: gone.signal }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    gone.abort();
    const error = await waiting;
    assert.ok(error instanceof Error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(aborted, true);
  } finally {
    slow.closeAllConnections?.();
    await new Promise((resolve) => slow.close(resolve));
  }
});

// OpenCode's catalog still listed a free Zen model the service had retired (2026-10-26: LongCat 2.5 Preview),
// the setup wizard offered it first, and a new user's first message failed with "has been deprecated".
test("OpenCode Zen models that Zen no longer serves are left out, and the catalog stands when Zen does not answer", async () => {
  const catalog = {
    all: [
      { id: "opencode", name: "OpenCode Zen", models: {
        "longcat-2.5-preview-free": { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", cost: { input: 0, output: 0 } },
        "mimo-v2.6-flash-free": { id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", cost: { input: 0, output: 0 } },
      } },
      { id: "openai", name: "OpenAI", models: { "gpt-5.4-mini": { id: "gpt-5.4-mini", name: "GPT-5.4 mini", cost: { input: 0.25, output: 2 } } } },
    ],
    connected: ["opencode", "openai"],
  };
  const json = (res, data) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const oc = http.createServer((req, res) => (req.url.startsWith("/provider/auth") ? json(res, {}) : req.url.startsWith("/provider") ? json(res, catalog) : json(res, {})));
  let zenCalls = 0;
  const zen = http.createServer((req, res) => {
    zenCalls += 1;
    json(res, { object: "list", data: [{ id: "mimo-v2.6-flash-free", object: "model" }, { id: "big-pickle", object: "model" }] });
  });
  await Promise.all([oc, zen].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const ocUrl = `http://127.0.0.1:${oc.address().port}`;
  const closedPort = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  try {
    const live = harness({ env: { RAVNIR_OPENCODE_URL: ocUrl, RAVNIR_OPENCODE_PASSWORD: "x", RAVNIR_ZEN_MODELS_URL: `http://127.0.0.1:${zen.address().port}/v1/models` } });
    const listed = (await live.models.list()).models.map((m) => m.id);
    assert.deepEqual(listed.sort(), ["openai/gpt-5.4-mini", "opencode/mimo-v2.6-flash-free"], "the retired Zen model is gone; other providers are untouched");
    assert.equal(pickFreeModel((await live.models.list()).models).model, "opencode/mimo-v2.6-flash-free", "the wizard offers a model Zen serves");
    assert.equal(zenCalls, 1, "Zen's list is asked once and kept");

    // Zen does not answer: nothing is hidden, so an offline server still lists its catalog.
    const offline = harness({ env: { RAVNIR_OPENCODE_URL: ocUrl, RAVNIR_OPENCODE_PASSWORD: "x", RAVNIR_ZEN_MODELS_URL: `http://127.0.0.1:${closedPort}/v1/models` } });
    const all = (await offline.models.list()).models.map((m) => m.id);
    assert.ok(all.includes("opencode/longcat-2.5-preview-free"));
    assert.equal(all.length, 3);

    // "off" skips the check.
    const off = harness({ env: { RAVNIR_OPENCODE_URL: ocUrl, RAVNIR_OPENCODE_PASSWORD: "x", RAVNIR_ZEN_MODELS_URL: "off" } });
    assert.equal((await off.models.list()).models.length, 3);
    assert.equal(zenCalls, 1);
  } finally {
    await Promise.all([oc, zen].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
