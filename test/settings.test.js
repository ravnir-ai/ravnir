import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAuth, SESSION_COOKIE } from "../server/auth.js";
import { configValueVisible, envConfig } from "../server/appConfig.js";
import { callCollaborationTool, deliverMention } from "../server/collaboration.js";
import { createApp } from "../server/index.js";
import { Ledger } from "../server/ledger.js";
import { normalizeDefaults } from "../server/state.js";
import { TurnEngine } from "../server/turn.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

async function start(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-settings-"));
  const server = createApp({ home, projectRoot, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  return { home, base, stop };
}

async function call(base, method, pathname, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, headers: response.headers };
}

test("defaults for new agents are validated, trimmed and kept without secrets", async () => {
  const { base, stop, home } = await start();
  try {
    const first = await call(base, "GET", "/api/settings");
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.defaults, { provider: "", baseUrl: "", username: "", model: "", via: "", group: "", notify: "" });
    assert.ok(first.data.timeZone);

    const saved = await call(base, "PUT", "/api/settings", {
      defaults: { provider: "openai", baseUrl: "  http://127.0.0.1:1234/v1  ", model: " local/model ", group: "Work", notify: "all" },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.defaults.provider, "openai");
    assert.equal(saved.data.defaults.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(saved.data.defaults.model, "local/model");
    assert.equal(saved.data.defaults.notify, "all");
    // A partial update keeps the rest.
    const partial = await call(base, "PUT", "/api/settings", { defaults: { group: "Acme" } });
    assert.equal(partial.data.defaults.provider, "openai");
    assert.equal(partial.data.defaults.group, "Acme");

    assert.equal((await call(base, "PUT", "/api/settings", { defaults: { provider: "banana" } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { defaults: { baseUrl: "ftp://x" } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { defaults: { baseUrl: "http://user:pw@host:1/" } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { defaults: { model: 12 } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { defaults: { group: "x".repeat(41) } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { defaults: { notify: "loud" } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", {})).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { defaults: { via: "server:../x" } })).status, 400);
    const picked = await call(base, "PUT", "/api/settings", { defaults: { via: "opencode", model: "openai/gpt-5.4-mini" } });
    assert.equal(picked.data.defaults.via, "opencode");
    assert.equal(picked.data.defaults.model, "openai/gpt-5.4-mini");

    // It survives a restart of the state file and never carries a key.
    const file = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    assert.equal(file.settings.defaults.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(JSON.stringify(file.settings.defaults).includes("pw"), false);
    assert.deepEqual(Object.keys(normalizeDefaults({ apiKey: "sk-secret", password: "x", model: "m" })).sort(), ["baseUrl", "group", "model", "notify", "provider", "username", "via"]);
  } finally {
    await stop();
  }
});

test("the owner's name, language and vault layout are settings, checked before anything is saved", async () => {
  const { base, stop, home } = await start();
  try {
    const first = await call(base, "GET", "/api/settings");
    assert.deepEqual(first.data.owner, { name: "", language: "" });
    assert.equal(first.data.languages.es, "Spanish");
    assert.equal(first.data.vault.layout, "auto");
    assert.equal(first.data.vault.active, null);

    const saved = await call(base, "PUT", "/api/settings", { owner: { name: "  Alex \n Rivera ", language: "pt" }, vault: { layout: "es" } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.owner, { name: "Alex Rivera", language: "pt" });
    assert.equal(saved.data.vault.layout, "es");
    // A partial owner update keeps the other field.
    assert.deepEqual((await call(base, "PUT", "/api/settings", { owner: { language: "" } })).data.owner, { name: "Alex Rivera", language: "" });

    assert.equal((await call(base, "PUT", "/api/settings", { owner: { language: "klingon" } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { owner: { name: "x".repeat(61) } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { owner: "Alex" })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", { vault: { layout: "fr" } })).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", null)).status, 400);
    assert.equal((await call(base, "PUT", "/api/settings", ["owner"])).status, 400);
    // One bad part refuses the whole request.
    assert.equal((await call(base, "PUT", "/api/settings", { owner: { name: "Bea" }, defaults: { provider: "banana" } })).status, 400);
    const file = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    assert.deepEqual(file.settings.owner, { name: "Alex Rivera", language: "" });
    assert.deepEqual(file.settings.vault, { layout: "es" });

    // The live prompt says who the agents work for; with no name it never invents one.
    const bot = (await call(base, "POST", "/api/bots", { name: "Scout", job: "Reads the web." })).data.bot;
    assert.match((await call(base, "GET", `/api/bots/${bot.id}`)).data.livePrompt, /You work for Alex Rivera, who owns this server\./);
    await call(base, "PUT", "/api/settings", { owner: { name: "" } });
    const plain = (await call(base, "GET", `/api/bots/${bot.id}`)).data.livePrompt;
    assert.doesNotMatch(plain, /You work for/);
    assert.match(plain, /The user's Mac: not linked/);
  } finally {
    await stop();
  }
});

test("the config route lists names and never leaks a secret value", async () => {
  process.env.RAVNIR_FOO_TOKEN = "super-secret-token-value";
  process.env.RAVNIR_BAR_PASSWORD = "hunter2-hunter2";
  process.env.RAVNIR_BOX_MEMORY = "3g";
  process.env.RAVNIR_QUICK_URL = "https://user:p4ss@quick.example.com/v1?key=abc";
  process.env.RAVNIR_TTS_URL = "https://tts.example.com/v1?apikey=zzz";
  const { base, stop } = await start();
  try {
    const { status, data } = await call(base, "GET", "/api/config");
    assert.equal(status, 200);
    const text = JSON.stringify(data);
    for (const secret of ["super-secret-token-value", "hunter2-hunter2", "p4ss", "apikey=zzz", "key=abc"]) {
      assert.equal(text.includes(secret), false, `${secret} must not appear`);
    }
    const byName = new Map(data.env.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("RAVNIR_FOO_TOKEN").set, true);
    assert.equal("value" in byName.get("RAVNIR_FOO_TOKEN"), false);
    assert.equal("value" in byName.get("RAVNIR_BAR_PASSWORD"), false);
    assert.equal(byName.get("RAVNIR_BOX_MEMORY").value, "3g");
    // A URL shows its address only, and nothing at all when it carries credentials.
    assert.equal(byName.get("RAVNIR_QUICK_URL").set, true);
    assert.equal(byName.get("RAVNIR_QUICK_URL").value, "");
    assert.equal(byName.get("RAVNIR_TTS_URL").value, "https://tts.example.com/v1");
    // Referenced in the server code but not set here.
    assert.equal(byName.get("RAVNIR_STT_URL")?.set, false);
    assert.ok(data.env.length > 20);
    assert.ok(data.timeZone && data.version && data.url);
  } finally {
    delete process.env.RAVNIR_FOO_TOKEN;
    delete process.env.RAVNIR_BAR_PASSWORD;
    delete process.env.RAVNIR_BOX_MEMORY;
    delete process.env.RAVNIR_QUICK_URL;
    delete process.env.RAVNIR_TTS_URL;
    await stop();
  }
});

test("only plain settings show a value", () => {
  assert.equal(configValueVisible("RAVNIR_PORT"), true);
  assert.equal(configValueVisible("RAVNIR_USER"), false);
  assert.equal(configValueVisible("RAVNIR_PASSWORD"), false);
  assert.equal(configValueVisible("RAVNIR_QUICK_API_KEY"), false);
  assert.equal(configValueVisible("RAVNIR_MAC_TOKEN"), false);
  assert.equal(configValueVisible("RAVNIR_SECRET"), false);
  assert.equal(configValueVisible("RAVNIR_UNKNOWN_THING"), false);
  const list = envConfig({ serverDir: path.join(projectRoot, "server"), env: { RAVNIR_PORT: "3993", RAVNIR_SECRET: "x" } });
  assert.equal(list.find((entry) => entry.name === "RAVNIR_PORT").value, "3993");
  assert.equal("value" in list.find((entry) => entry.name === "RAVNIR_SECRET"), false);
});

test("sign out everywhere ends every cookie session and Basic keeps working", async () => {
  process.env.RAVNIR_USER = "owner";
  process.env.RAVNIR_PASSWORD = "test-password";
  const { base, stop, home } = await start();
  const basic = { authorization: `Basic ${Buffer.from("owner:test-password").toString("base64")}` };
  try {
    const login = async () => {
      const response = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "test-password" }) });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const phone = await login();
    const laptop = await login();
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: phone } })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: laptop } })).status, 200);
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie: phone } })).json();
    assert.equal(state.server.user, "owner");

    const revoked = await fetch(`${base}/api/sessions/revoke`, { method: "POST", headers: { cookie: phone } });
    assert.equal(revoked.status, 200);
    assert.match(revoked.headers.get("set-cookie") || "", /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: phone } })).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: laptop } })).status, 401);
    // curl and scripts keep working, and a new sign-in works.
    assert.equal((await fetch(`${base}/api/state`, { headers: basic })).status, 200);
    const again = await login();
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: again } })).status, 200);
    // The revoke survives a restart: the old cookie stays dead.
    const file = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8"));
    assert.equal(file._epoch, 1);
  } finally {
    delete process.env.RAVNIR_USER;
    delete process.env.RAVNIR_PASSWORD;
    await stop();
  }
});

test("an epoch bump invalidates a session even if its entry is still on disk", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-epoch-"));
  const auth = createAuth({ user: "u", password: "p", home });
  const { setCookie } = auth.login("u", "p", { secure: false });
  const cookie = setCookie.split(";")[0];
  const req = { headers: { cookie } };
  assert.equal(auth.check(req), true);
  assert.equal(auth.revokeAll({ secure: false }).setCookie.includes(`${SESSION_COOKIE}=;`), true);
  assert.equal(auth.check(req), false);
  const reloaded = createAuth({ user: "u", password: "p", home });
  assert.equal(reloaded.epoch, 1);
  assert.equal(reloaded.check(req), false);
});

test("a paused agent skips routines (recorded as skipped) and refuses other agents", async () => {
  const { base, stop, home } = await start();
  try {
    const one = (await call(base, "POST", "/api/bots", { name: "Sleeper", job: "Naps." })).data.bot;
    const two = (await call(base, "POST", "/api/bots", { name: "Caller", job: "Calls." })).data.bot;
    // Someone awake to receive the broadcast below.
    await call(base, "POST", "/api/bots", { name: "Listener", job: "Listens." });
    const made = await call(base, "POST", `/api/bots/${one.id}/jobs`, { name: "Morning", prompt: "Say hi", cron: "0 8 * * *" });
    assert.equal(made.status, 201);

    assert.equal((await call(base, "PATCH", `/api/bots/${one.id}`, { status: "maybe" })).status, 400);
    const paused = await call(base, "PATCH", `/api/bots/${one.id}`, { status: "off" });
    assert.equal(paused.data.bot.status, "off");
    const list = await call(base, "GET", "/api/state");
    assert.equal(list.data.bots.find((bot) => bot.id === one.id).status, "off");

    // The scheduler path: engine.runJob on a paused agent.
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    const stored = state.bots.find((bot) => bot.id === one.id);
    assert.equal(stored.status, "off");
    const ledger = new Ledger({ home });
    const engine = new TurnEngine({
      home,
      state,
      saveState: () => {},
      secrets: { get: () => "" },
      eventLog: { append() {} },
      browser: {},
      mcp: {},
      ledger,
      approvals: {},
    });
    await engine.runJob(stored, stored.jobs[0]);
    const row = ledger.rows.at(-1);
    assert.equal(row.status, "skipped");
    assert.equal(row.summary, "Paused");
    assert.equal(row.botId, one.id);
    assert.equal(row.source, "job");
    assert.equal(stored.jobs[0].lastStatus, "skipped");
    assert.equal(engine.active.size, 0);

    // The same through the live server: a manual "Run now" is the user's own call and still runs.
    // Other agents are refused, with a clear result for the sender.
    const sender = state.bots.find((bot) => bot.id === two.id);
    const enqueued = [];
    const ctx = { bot: sender, state, home, engine: { enqueue: (...args) => { enqueued.push(args); return { promise: Promise.resolve() }; }, status: () => ({ busy: false }) }, save() {}, chain: [sender.id] };
    await assert.rejects(callCollaborationTool("message_bot", { bot: "Sleeper", text: "hello" }, ctx), /Sleeper is paused/);
    // A broadcast skips the paused one and says so; a group of only paused agents is refused.
    const sent = await callCollaborationTool("broadcast", { text: "hello" }, { ...ctx });
    assert.match(sent.text, /Not sent to Sleeper \(paused\)/);
    assert.equal(enqueued.some(([target]) => target.id === stored.id), false);
    assert.ok(enqueued.length >= 1);
    enqueued.length = 0;
    state.groups.push({ id: "g-quiet", name: "Quiet", createdAt: 1 });
    stored.group = "Quiet";
    await assert.rejects(callCollaborationTool("broadcast", { text: "hello", group: "Quiet" }, { ...ctx }), /paused/);
    stored.group = "Personal";
    const mention = await deliverMention({ bot: sender, engine: ctx.engine, home }, stored, "hi");
    assert.match(mention, /Sleeper is paused/);
    assert.equal(enqueued.length, 0);
    const roster = await callCollaborationTool("list_bots", {}, ctx);
    assert.match(roster.text, /Sleeper .*paused/);

    // Back on: messages go through again.
    stored.status = "on";
    const delivered = await callCollaborationTool("message_bot", { bot: "Sleeper", text: "hello" }, ctx);
    assert.match(delivered.text, /Delivered to Sleeper/);
    assert.equal(enqueued.length, 1);
  } finally {
    await stop();
  }
});

test("a paused agent still answers its user", async () => {
  const { base, stop } = await start();
  try {
    const bot = (await call(base, "POST", "/api/bots", { name: "Quiet", job: "Rests." })).data.bot;
    await call(base, "PATCH", `/api/bots/${bot.id}`, { status: "off" });
    const sent = await call(base, "POST", `/api/bots/${bot.id}/messages`, { text: "are you there?" });
    assert.equal(sent.status, 202);
    await call(base, "PATCH", `/api/bots/${bot.id}`, { status: "on" });
    assert.equal((await call(base, "GET", `/api/bots/${bot.id}`)).data.bot.status, "on");
  } finally {
    await stop();
  }
});
