import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAuth, listenAllowed, SESSION_COOKIE } from "../server/auth.js";
import { createApp } from "../server/index.js";
import { ManagedOpenCode } from "../server/opencodeManaged.js";
import { SecretStore } from "../server/secrets.js";
import { loadState, saveState } from "../server/state.js";
import { checkRemote } from "../server/vault/local.js";
import { pickFreeModel } from "../server/setup.js";
import { scrub } from "../server/doctor.js";
import { startMock } from "../scripts/mock-openai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";
// The tests never ask OpenCode Zen which models it serves (test/models.test.js covers that with a stand-in).
process.env.RAVNIR_ZEN_MODELS_URL = "off";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-${name}-`));

async function start(options = {}, { home = tmp("setup") } = {}) {
  const server = createApp({ home, projectRoot, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  return { home, base, stop, server };
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

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function withEnv(values, fn) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

// A stand-in for `opencode serve`: Basic auth with OPENCODE_SERVER_PASSWORD, one free model, and a
// record of the environment it was started with.
function fakeOpenCode(dir) {
  const file = path.join(dir, "opencode");
  fs.writeFileSync(file, `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
fs.writeFileSync(${JSON.stringify(path.join(dir, "env.json"))}, JSON.stringify({ keys: Object.keys(process.env), xdg: process.env.XDG_DATA_HOME, pid: process.pid }));
const expected = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
http.createServer((req, res) => {
  if (req.headers.authorization !== expected) { res.writeHead(401); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.startsWith("/provider/auth")) { res.end("{}"); return; }
  if (req.url.startsWith("/provider")) {
    res.end(JSON.stringify({ all: [{ id: "opencode", name: "OpenCode Zen", models: { "glm-5.3-flash-free": { id: "glm-5.3-flash-free", name: "GLM-5.3 Flash Free", cost: { input: 0, output: 0 } } } }], connected: ["opencode"] }));
    return;
  }
  res.end("{}");
}).listen(port, args[args.indexOf("--hostname") + 1]);
`, { mode: 0o755 });
  return file;
}

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a fresh install starts with no agents and needs setup; an older install never sees the wizard", async () => {
  const fresh = await start();
  try {
    const { data } = await call(fresh.base, "GET", "/api/state");
    assert.equal(data.bots.length, 0);
    assert.equal(data.server.setupNeeded, true);
    const done = await call(fresh.base, "POST", "/api/setup/done", { skipped: true });
    assert.equal(done.status, 200);
    assert.equal((await call(fresh.base, "GET", "/api/state")).data.server.setupNeeded, false);
  } finally {
    await fresh.stop();
  }
  const home = tmp("legacy");
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ version: 1, server: { name: "Ravnir" }, bots: [], settings: {} }));
  assert.deepEqual(loadState({ home, secrets: null, projectRoot: home }).settings.setup, { done: true, at: 0 });
});

test("Ravnir listens past loopback only with sign-in on", async () => {
  assert.equal(listenAllowed("127.0.0.1", {}), true);
  assert.equal(listenAllowed("::1", {}), true);
  assert.equal(listenAllowed("localhost", {}), true);
  assert.equal(listenAllowed("0.0.0.0", {}), false);
  assert.equal(listenAllowed("192.168.1.4", { RAVNIR_USER: "me" }), false);
  assert.equal(listenAllowed("0.0.0.0", { RAVNIR_USER: "me", RAVNIR_PASSWORD: "pw" }), true);
  const home = tmp("bind");
  const child = spawn(process.execPath, [path.join(projectRoot, "server", "index.js")], {
    env: { PATH: process.env.PATH, HOME: home, RAVNIR_HOME: home, RAVNIR_HOST: "0.0.0.0", RAVNIR_PORT: String(await freePort()), RAVNIR_AI_MEMORY: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /will not listen on 0\.0\.0\.0 without sign-in/);
});

test("a pairing code signs in one device once, then never again", async () => {
  let clock = 1_000_000;
  const auth = createAuth({ user: "me", password: "pw", now: () => clock });
  const first = auth.createPairCode();
  assert.match(first.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(auth.loginWithCode(first.code.toLowerCase())?.setCookie.startsWith(`${SESSION_COOKIE}=`), "case and the dash do not matter");
  assert.equal(auth.loginWithCode(first.code), null, "used once");
  const late = auth.createPairCode();
  clock += 16 * 60 * 1000;
  assert.equal(auth.loginWithCode(late.code), null, "expired after 15 minutes");
  const guessed = auth.createPairCode();
  for (let i = 0; i < 20; i += 1) auth.loginWithCode("AAAA-AAAA");
  assert.equal(auth.loginWithCode(guessed.code), null, "too many wrong codes void the open ones");
  const revoked = auth.createPairCode();
  auth.revokeAll();
  assert.equal(auth.loginWithCode(revoked.code), null, "sign out everywhere voids codes too");
  assert.equal(createAuth({}).createPairCode(), null, "no codes with sign-in off");

  await withEnv({ RAVNIR_USER: "me", RAVNIR_PASSWORD: "pw-123" }, async () => {
    const app = await start();
    try {
      assert.equal((await call(app.base, "POST", "/api/pair", {})).status, 401, "making a code needs sign-in");
      const basic = { authorization: `Basic ${Buffer.from("me:pw-123").toString("base64")}` };
      const made = await call(app.base, "POST", "/api/pair", {}, basic);
      assert.equal(made.status, 200);
      assert.equal(made.data.url, "", "no public address, so no link to show");
      const wrong = await call(app.base, "POST", "/api/login", { code: "ZZZZ-ZZZZ" });
      assert.equal(wrong.status, 401);
      const right = await call(app.base, "POST", "/api/login", { code: made.data.code });
      assert.equal(right.status, 200);
      const cookie = right.headers.get("set-cookie").split(";")[0];
      assert.equal((await call(app.base, "GET", "/api/state", undefined, { cookie })).status, 200);
    } finally {
      await app.stop();
    }
  });
});

test("starter agents are made with the chosen model, the main one, and the engineer's read-only commands", async () => {
  const mock = await startMock();
  const app = await start();
  try {
    const server = await call(app.base, "POST", "/api/models/servers", { name: "Mock", baseUrl: mock.url });
    assert.equal(server.status, 201, JSON.stringify(server.data));
    const via = `server:${server.data.server.id}`;
    const setup = await call(app.base, "GET", "/api/setup");
    assert.deepEqual(setup.data.starters.map((item) => item.id), ["chief", "researcher", "engineer", "inbox"]);
    assert.equal(setup.data.models.count, 2);
    assert.equal(setup.data.models.free, null, "no OpenCode, so no free model");
    assert.equal((await call(app.base, "POST", "/api/setup/starters", { ids: [] })).status, 400);
    assert.equal((await call(app.base, "POST", "/api/setup/starters", { ids: ["nope"] })).status, 400);
    assert.equal((await call(app.base, "POST", "/api/setup/starters", { ids: ["chief"], model: { via: "opencode", model: "x" } })).status, 409, "OpenCode is not connected");
    const made = await call(app.base, "POST", "/api/setup/starters", { ids: ["chief", "engineer"], model: { via, model: "mock-model" } });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.deepEqual(made.data.created.map((item) => item.name), ["Chief of Staff", "Engineer"]);
    const again = await call(app.base, "POST", "/api/setup/starters", { ids: ["chief", "researcher"], model: { via, model: "mock-model" } });
    assert.deepEqual(again.data.created.map((item) => item.name), ["Researcher"], "an agent that exists is not made twice");
    const state = (await call(app.base, "GET", "/api/state")).data;
    const chief = state.bots.find((bot) => bot.name === "Chief of Staff");
    assert.equal(chief.main, true);
    assert.equal(state.bots.filter((bot) => bot.main).length, 1);
    const engineer = (await call(app.base, "GET", `/api/bots/${state.bots.find((bot) => bot.name === "Engineer").id}`)).data.bot;
    assert.equal(engineer.model.baseUrl, mock.url);
    assert.equal(engineer.model.model, "mock-model");
    assert.ok(engineer.policy.allow.includes("git status"));
    assert.equal(engineer.policy.allow.some((rule) => rule.includes("*")), false, "no wildcard can reach files outside the workspace");
    assert.equal(engineer.policy.shell, "ask", "everything else still asks");
    const settings = (await call(app.base, "GET", "/api/settings")).data;
    assert.equal(settings.defaults.via, via);
    assert.equal(settings.defaults.model, "mock-model");
  } finally {
    await app.stop();
    await mock.close();
  }
});

test("RAVNIR_VAULT=local starts a vault in git that agents can write to before it has a remote, then links to one", async () => {
  await withEnv({ RAVNIR_VAULT: "local", RAVNIR_VAULT_ALLOW_FILE: "1", RAVNIR_VAULT_DIR: undefined, RAVNIR_VAULT_WRITE: undefined }, async () => {
    const app = await start();
    const dir = path.join(app.home, "vault");
    try {
      const state = await until(async () => {
        const data = (await call(app.base, "GET", "/api/state")).data;
        return data.vault.notes >= 3 && data;
      });
      assert.equal(state.vault.writer.available, true);
      assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.startsWith(".")).sort(), ["Decisions-Log.md", "Home.md", "Rules.md"]);
      const writer = app.server.services.engine.vaultWriter;
      const synced = await writer.sync();
      assert.equal(synced.ok, true, JSON.stringify(synced));
      assert.equal(synced.local, true);
      await writer.appendOwnNote({ id: "b1", name: "Scout" }, "Likes short answers.");
      assert.match(execFileSync("git", ["-C", dir, "log", "--format=%an %s"], { encoding: "utf8" }), /Scout: note Agents\/Scout\.md/);

      assert.equal(checkRemote("https://user:token@github.com/me/notes.git").error.includes("password"), true);
      assert.equal(checkRemote("git@github.com:me/notes.git").ssh, true);
      assert.ok(checkRemote("ftp://x").error);

      // An existing repository with notes of its own: the folder follows it, local work is kept.
      const bare = path.join(tmp("remote"), "notes.git");
      const seed = tmp("seed");
      execFileSync("git", ["init", "-q", "--bare", "-b", "trunk", bare]);
      execFileSync("git", ["-C", seed, "init", "-q", "-b", "trunk"]);
      fs.writeFileSync(path.join(seed, "Rules.md"), "# Rules\n\n- From the remote.\n");
      execFileSync("git", ["-C", seed, "add", "-A"]);
      execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"]);
      execFileSync("git", ["-C", seed, "push", "-q", bare, "trunk"]);
      const key = await call(app.base, "POST", "/api/setup/vault/key", {});
      assert.match(key.data.publicKey, /^ssh-ed25519 /);
      const linked = await call(app.base, "POST", "/api/setup/vault", { url: `file://${bare}` });
      assert.equal(linked.status, 200, JSON.stringify(linked.data));
      assert.equal(linked.data.vault.branch, "trunk");
      assert.match(linked.data.saved, /^ravnir\/local-/);
      assert.equal(fs.readFileSync(path.join(dir, "Rules.md"), "utf8"), "# Rules\n\n- From the remote.\n");
      assert.match(execFileSync("git", ["-C", dir, "log", "--format=%s", linked.data.saved], { encoding: "utf8" }), /Scout: note/, "the local note stays on its branch");
      // Writes now land on the remote.
      await writer.appendOwnNote({ id: "b2", name: "Builder" }, "Runs the tests first.");
      const after = await writer.sync();
      assert.equal(after.ok, true, JSON.stringify(after));
      assert.match(execFileSync("git", ["--git-dir", bare, "log", "--format=%s", "trunk"], { encoding: "utf8" }), /Builder: note/);
    } finally {
      await app.stop();
    }
    // The link survives a restart.
    const again = await start({}, { home: app.home });
    try {
      assert.equal((await call(again.base, "GET", "/api/setup")).data.vault.branch, "trunk");
      assert.equal(again.server.services.engine.vaultWriter.branch, "trunk");
    } finally {
      await again.stop();
    }
  });
});

test("linking to an empty repository gives it this server's notes", async () => {
  await withEnv({ RAVNIR_VAULT: "local", RAVNIR_VAULT_ALLOW_FILE: "1", RAVNIR_VAULT_DIR: undefined }, async () => {
    const app = await start();
    try {
      await until(async () => (await call(app.base, "GET", "/api/state")).data.vault.notes >= 3);
      const bare = path.join(tmp("empty"), "notes.git");
      execFileSync("git", ["init", "-q", "--bare", bare]);
      const linked = await call(app.base, "POST", "/api/setup/vault", { url: `file://${bare}` });
      assert.equal(linked.status, 200, JSON.stringify(linked.data));
      assert.equal(linked.data.pushed, true);
      assert.equal(linked.data.vault.branch, "main");
      assert.match(execFileSync("git", ["--git-dir", bare, "log", "--format=%s", "main"], { encoding: "utf8" }), /start the vault/);
    } finally {
      await app.stop();
    }
  });
});

test("the OpenCode Ravnir runs gets a password nobody sees, a clean environment, a loopback MCP address and a restart", async () => {
  const bin = fakeOpenCode(tmp("ocbin"));
  const port = await freePort();
  await withEnv({ RAVNIR_OPENCODE: "managed", RAVNIR_OPENCODE_PORT: String(port), RAVNIR_PUBLIC_URL: "https://ravnir.example.ts.net", RAVNIR_PASSWORD: "server-secret", RAVNIR_USER: "me" }, async () => {
    const basic = { authorization: `Basic ${Buffer.from("me:server-secret").toString("base64")}` };
    const app = await start({ opencodeBin: bin });
    const record = path.join(path.dirname(bin), "env.json");
    try {
      const setup = await until(async () => {
        const data = (await call(app.base, "GET", "/api/setup", undefined, basic)).data;
        return data.opencode?.connected && data;
      });
      assert.equal(setup.opencode.source, "managed");
      assert.equal(setup.models.free.model, "opencode/glm-5.3-flash-free");
      assert.equal(setup.models.free.private, true);
      const seen = JSON.parse(fs.readFileSync(record, "utf8"));
      assert.equal(seen.keys.includes("RAVNIR_PASSWORD"), false, "the server's secrets stay out of OpenCode");
      assert.equal(seen.xdg, path.join(app.home, "opencode", "data"));
      const catalog = (await call(app.base, "GET", "/api/models/catalog", undefined, basic)).data;
      assert.equal(JSON.stringify(catalog).includes(app.server.services.secrets.get("server:opencode-managed")), false, "the password is never sent");

      // A starter on the free model, and its OpenCode config points at this server's loopback.
      const made = await call(app.base, "POST", "/api/setup/starters", { ids: ["researcher"], model: { via: setup.models.free.via, model: setup.models.free.model } }, basic);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      const bot = app.server.services.state.bots[0];
      assert.equal(bot.model.baseUrl, `http://127.0.0.1:${port}`);
      const config = JSON.parse(fs.readFileSync(path.join(app.home, "bots", bot.id, "workspace", "opencode.json"), "utf8"));
      assert.equal(config.mcp.ravnir.url, `${new URL(app.base).origin}/api/bots/${bot.id}/mcp`);

      // It comes back after a crash.
      process.kill(seen.pid, "SIGKILL");
      await until(() => {
        const next = JSON.parse(fs.readFileSync(record, "utf8"));
        return next.pid !== seen.pid;
      }, 15_000);
      await until(async () => app.server.services.managedOpenCode.status().running, 15_000);
      assert.ok(app.server.services.managedOpenCode.status().restarts >= 1);

      // RAVNIR_OPENCODE=managed wins over Settings, so connecting another OpenCode says so instead of pretending.
      const other = await call(app.base, "POST", "/api/models/opencode", { baseUrl: "http://127.0.0.1:1", password: "x" }, basic);
      assert.equal(other.status, 409);
      assert.match(other.data.error, /RAVNIR_OPENCODE=managed/);

      const doctor = (await call(app.base, "GET", "/api/doctor?browser=0", undefined, basic)).data;
      const byId = Object.fromEntries(doctor.checks.map((item) => [item.id, item]));
      assert.equal(byId.opencode.status, "ok");
      assert.equal(byId.model.status, "ok");
      assert.equal(byId.signin.status, "ok");
      assert.equal(JSON.stringify(doctor).includes("ravnir.example.ts.net"), false, "the report names no host");
      assert.equal(JSON.stringify(doctor).includes(app.home), false, "or folder");
    } finally {
      await app.stop();
      await app.server.services.managedOpenCode.stop();
    }
    const last = JSON.parse(fs.readFileSync(record, "utf8"));
    await until(() => {
      try {
        process.kill(last.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 8_000);
  });
});

test("doctor in text form is a report you can paste, with a failing exit status when a check fails", async () => {
  const app = await start();
  try {
    const response = await fetch(`${app.base}/api/doctor?browser=0&format=text`);
    const text = await response.text();
    assert.equal(response.status, 503, "no model connected is a failure");
    assert.match(text, /^Ravnir doctor 1\.0\.0 \(/);
    assert.match(text, /\[FAIL\] Models: No model is connected yet\./);
    assert.match(text, /fix: Settings > Models/);
    assert.equal(text.includes(app.home), false);
  } finally {
    await app.stop();
  }
  // A home that ran an older Ravnir keeps its agents, and saving state round-trips the setup flag.
  const home = tmp("roundtrip");
  const state = loadState({ home, secrets: null, projectRoot: home });
  state.settings.setup = { done: true, at: 5 };
  saveState(home, state);
  assert.deepEqual(loadState({ home, secrets: null, projectRoot: home }).settings.setup, { done: true, at: 5 });
});

test("the free model offered first is the one whose provider keeps the least, and Nemotron is never offered", () => {
  const free = (id) => ({ id: `opencode/${id}`, name: id, provider: "opencode", via: "opencode", cost: null });
  const paid = { id: "opencode/gpt-6", name: "GPT", provider: "opencode", via: "opencode", cost: { input: 1, output: 2 } };
  assert.equal(pickFreeModel([free("big-pickle"), free("deepseek-v4.1-flash-free"), paid]).model, "opencode/deepseek-v4.1-flash-free");
  assert.equal(pickFreeModel([free("big-pickle"), free("deepseek-v4.1-flash-free")]).private, true);
  assert.equal(pickFreeModel([free("mimo-v2.6-flash-free"), free("beam-free")]).model, "opencode/beam-free");
  assert.match(pickFreeModel([free("mimo-v2.6-flash-free")]).note, /may be used to improve the model/);
  assert.equal(pickFreeModel([free("nemotron-3-ultra-free"), paid]), null);
  assert.match(pickFreeModel([free("nemotron-3-ultra-free"), free("orbit-9-free")]).note, /OpenCode's docs say/);
  assert.equal(pickFreeModel([{ ...free("glm-5.3-flash-free"), via: "server:x" }]), null, "only through this server's OpenCode");
});

test("doctor reports carry no address, path or email from error text", () => {
  const text = scrub("OpenCode does not answer at http://100.64.1.2:4096 (fatal: could not read git@github.com:me/notes.git from /home/alex/.config/x; mail alex@example.com; 10.0.0.5:22)");
  assert.equal(/100\.64|github\.com|\/home\/alex|alex@example|10\.0\.0\.5/.test(text), false, text);
  assert.match(text, /\[address\].*\[path\].*\[email\].*\[ip\]/);
  assert.equal(scrub("Node 22.23.4"), "Node 22.23.4", "version numbers stay");
  assert.equal(scrub("Writable, 81.4 GB free."), "Writable, 81.4 GB free.");
});

test("stopping the OpenCode Ravnir runs while it starts leaves nothing running", async () => {
  const dir = tmp("ocstop");
  const bin = fakeOpenCode(dir);
  const home = tmp("ocstop-home");
  const managed = new ManagedOpenCode({ home, secrets: new SecretStore(home), wanted: () => true, bin, env: { ...process.env, RAVNIR_OPENCODE_PORT: String(await freePort()) } });
  const starting = managed.start();
  await managed.stop();
  await starting;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(fs.existsSync(path.join(dir, "env.json")), false, "no OpenCode was started after stop()");
  assert.equal(managed.status().running, false);
  assert.equal(managed.status().pid, null);
});

test("an OpenCode on the managed port that takes any password is someone else's, never adopted", async () => {
  const port = await freePort();
  const http = await import("node:http");
  const open = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ all: [], connected: [] }));
  });
  await new Promise((resolve) => open.listen(port, "127.0.0.1", resolve));
  const home = tmp("ocopen");
  const managed = new ManagedOpenCode({ home, secrets: new SecretStore(home), wanted: () => true, bin: "/nonexistent/opencode", env: { ...process.env, RAVNIR_OPENCODE_PORT: String(port) } });
  try {
    const status = await managed.start();
    assert.equal(status.running, false);
    assert.match(status.error, new RegExp(`Port ${port} is used by another program`));
  } finally {
    await managed.stop();
    await new Promise((resolve) => open.close(resolve));
  }
});
