import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { childEnv } from "../server/childEnv.js";
import { createApp } from "../server/index.js";
import { createBot } from "../server/state.js";
import { CONNECTOR_LAUNCHER, McpConnection, openCodeMcpConfig } from "../server/mcp.js";
import { normalizeEntry, pluginEnv } from "../server/plugins.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

// Talks newline-delimited JSON-RPC to a process the way OpenCode talks to a stdio connector.
function rpcClient(child) {
  const waiting = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const exited = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
  else child.once("exit", (code, signal) => resolve({ code, signal }));
});

test("a stdio MCP connector sees its own variables, not the server's secrets", async () => {
  const saved = { RAVNIR_PASSWORD: process.env.RAVNIR_PASSWORD, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
  process.env.RAVNIR_PASSWORD = "server-password";
  process.env.TYPESAFE_API_KEY = "server-key";
  const client = new McpConnection({
    connector: { id: "mock", name: "Mock", transport: "stdio", command: process.execPath, args: [path.join(root, "scripts", "mock-mcp.js")] },
    secret: { env: { CONNECTOR_TOKEN: "connector-token" } },
    cwd: root,
  });
  try {
    await client.connect();
    const result = await client.callTool("read_env", { names: ["RAVNIR_PASSWORD", "TYPESAFE_API_KEY", "CONNECTOR_TOKEN", "PATH", "HOME"] });
    const seen = JSON.parse(result.text);
    assert.equal(seen.RAVNIR_PASSWORD, null);
    assert.equal(seen.TYPESAFE_API_KEY, null);
    assert.equal(seen.CONNECTOR_TOKEN, "connector-token");
    assert.equal(seen.PATH, process.env.PATH);
    assert.equal(seen.HOME, process.env.HOME);
  } finally {
    client.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("childEnv keeps the pass-through names and the caller's own, nothing else", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/ravnir",
    TZ: "Europe/Madrid",
    XDG_RUNTIME_DIR: "/run/user/993",
    PLAYWRIGHT_BROWSERS_PATH: "/opt/ravnir/.playwright",
    RAVNIR_PASSWORD: "secret",
    RAVNIR_MAC_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  };
  assert.deepEqual(childEnv({ DISPLAY: ":91", PORT: 8080, SKIPPED: undefined }, source), {
    PATH: "/usr/bin",
    HOME: "/home/ravnir",
    TZ: "Europe/Madrid",
    XDG_RUNTIME_DIR: "/run/user/993",
    PLAYWRIGHT_BROWSERS_PATH: "/opt/ravnir/.playwright",
    DISPLAY: ":91",
    PORT: "8080",
  });
});

test("only Ravnir's own plugins read settings from the server, never a secret-looking one", () => {
  const local = normalizeEntry({ id: "mail", kind: "local", script: "bin/gmail-mcp.mjs", serverEnv: ["MAIL_HOST", "RAVNIR_PASSWORD", "TYPESAFE_API_KEY"] });
  assert.deepEqual(local.serverEnv, ["MAIL_HOST"]);
  assert.deepEqual(normalizeEntry({ id: "box", kind: "container", image: "example/box", serverEnv: ["MAIL_HOST"] }).serverEnv, []);
  assert.deepEqual(pluginEnv(local, { inputs: {}, secrets: {} }, { MAIL_HOST: "mail.test", RAVNIR_PASSWORD: "secret" }), { MAIL_HOST: "mail.test" });
});

test("a connector OpenCode starts from opencode.json sees its own variables, not OpenCode's password", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-child-env-"));
  const server = createApp({ home, projectRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.ok, true, `${pathname}: ${response.status}`);
    return response.json();
  };
  let child = null;
  try {
    const { bot } = await post("/api/bots", { name: "Env", job: "Checks its environment.", model: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "mock-model" } });
    await post(`/api/bots/${bot.id}/connectors`, {
      name: "Mock tools",
      transport: "stdio",
      command: process.execPath,
      args: [path.join(root, "scripts", "mock-mcp.js")],
      env: { CONNECTOR_TOKEN: "connector-token" },
    });
    const config = JSON.parse(fs.readFileSync(path.join(home, "bots", bot.id, "workspace", "opencode.json"), "utf8"));
    const entry = Object.values(config.mcp).find((item) => item.type === "local");
    assert.deepEqual(entry.command.slice(0, 5), [process.execPath, CONNECTOR_LAUNCHER, "--keep", "CONNECTOR_TOKEN", "--"]);
    assert.deepEqual(entry.environment, { CONNECTOR_TOKEN: "connector-token" });
    // Every user can read a command line in /proc, so the value is only in `environment`.
    assert.equal(entry.command.join(" ").includes("connector-token"), false);
    assert.equal(config.mcp.ravnir.type, "remote", "the built-in endpoint stays as it was");

    // OpenCode starts it with its own environment plus `environment`.
    child = spawn(entry.command[0], entry.command.slice(1), {
      cwd: path.join(home, "bots", bot.id, "workspace"),
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: "opencode-password", RAVNIR_PASSWORD: "server-password", ...entry.environment },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const call = rpcClient(child);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const reply = await call("tools/call", { name: "read_env", arguments: { names: ["OPENCODE_SERVER_PASSWORD", "RAVNIR_PASSWORD", "CONNECTOR_TOKEN", "PATH", "HOME"] } });
    const seen = JSON.parse(reply.result.content[0].text);
    assert.equal(seen.OPENCODE_SERVER_PASSWORD, null);
    assert.equal(seen.RAVNIR_PASSWORD, null);
    assert.equal(seen.CONNECTOR_TOKEN, "connector-token");
    assert.equal(seen.PATH, process.env.PATH);
    assert.equal(seen.HOME, process.env.HOME);
    // OpenCode ends a connector by closing its input; the launcher exits with it.
    child.stdin.end();
    assert.deepEqual(await exited(child), { code: 0, signal: null });
  } finally {
    child?.kill("SIGKILL");
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
});

test("a skipped connector's old entry is removed from opencode.json, so OpenCode cannot start it directly", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-child-env-"));
  const old = createBot({ name: "Old", job: "Made before the launcher.", model: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "mock-model" } });
  old.connectors.push({ id: "m", name: "ai-memory", managed: "ai-memory", configKey: "ai_memory", enabled: true, transport: "stdio", command: "/usr/bin/true", args: [], skipOpenCode: true });
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ version: 1, bots: [old] }));
  const workspace = path.join(home, "bots", old.id, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ mcp: { ai_memory: { type: "local", command: ["/usr/bin/true"] }, mine: { type: "remote", url: "https://mcp.example/mcp" }, truebot: { type: "remote", url: "http://127.0.0.1:3847/api/bots/x/mcp" } } }));
  const server = createApp({ home, projectRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/bots/${old.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: { shell: "ask" } }) });
    assert.equal(response.ok, true);
    const config = JSON.parse(fs.readFileSync(path.join(workspace, "opencode.json"), "utf8"));
    assert.equal(config.mcp.ai_memory, undefined);
    assert.equal(config.mcp.mine.url, "https://mcp.example/mcp", "entries the user added stay");
    assert.equal(config.mcp.ravnir.type, "remote");
    assert.equal(config.mcp.truebot, undefined, "the endpoint's name from before the rename is gone");
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
});

test("OpenCode's config wraps only stdio connectors and names their variables, never their values", () => {
  const bot = {
    connectors: [
      { id: "a", name: "Plain", configKey: "plain", enabled: true, transport: "stdio", command: "npx", args: ["-y", "some-mcp"] },
      { id: "b", name: "Keyed", configKey: "keyed", enabled: true, transport: "stdio", command: "/usr/bin/tool", args: [] },
      { id: "c", name: "Remote", configKey: "remote", enabled: true, transport: "http", url: "https://mcp.example/mcp" },
      { id: "d", name: "Plugin", configKey: "plugin", enabled: true, transport: "stdio", command: "node", skipOpenCode: true },
    ],
  };
  const env = { b: { API_TOKEN: "secret-value", PORT: 8080, "BAD NAME": "x", EMPTY: null } };
  const { mcp } = openCodeMcpConfig(bot, "http://127.0.0.1:3847/api/bots/x/mcp", "token", { envFor: (connector) => env[connector.id] });
  assert.deepEqual(mcp.plain, { type: "local", command: [process.execPath, CONNECTOR_LAUNCHER, "--", "npx", "-y", "some-mcp"], enabled: true });
  assert.deepEqual(mcp.keyed.command, [process.execPath, CONNECTOR_LAUNCHER, "--keep", "API_TOKEN", "--keep", "PORT", "--", "/usr/bin/tool"]);
  assert.deepEqual(mcp.keyed.environment, { API_TOKEN: "secret-value", PORT: "8080" });
  assert.deepEqual(mcp.remote, { type: "remote", url: "https://mcp.example/mcp", enabled: true });
  assert.equal(mcp.plugin, undefined);
  assert.deepEqual(mcp.ravnir, { type: "remote", url: "http://127.0.0.1:3847/api/bots/x/mcp", enabled: true, headers: { authorization: "Bearer token" }, timeout: 15 * 60_000 });
});

test("the connector launcher passes on stop signals and the connector's exit code", async () => {
  const launch = (script) => spawn(process.execPath, [CONNECTOR_LAUNCHER, "--", process.execPath, "-e", script], { stdio: ["pipe", "pipe", "pipe"] });

  const failing = launch("process.exit(3)");
  assert.deepEqual(await exited(failing), { code: 3, signal: null });

  const running = launch("console.log(process.pid); setInterval(() => {}, 1000)");
  running.stdout.setEncoding("utf8");
  const pid = Number(await new Promise((resolve) => running.stdout.once("data", resolve)));
  running.kill("SIGTERM");
  assert.deepEqual(await exited(running), { code: null, signal: "SIGTERM" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the connector stopped with the launcher");

  const usage = spawn(process.execPath, [CONNECTOR_LAUNCHER, "--keep", "NOT A NAME", "--", "true"], { stdio: ["ignore", "ignore", "pipe"] });
  assert.equal((await exited(usage)).code, 2);
});
