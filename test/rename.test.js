import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { adoptLegacyEnv } from "../server/env.js";
import { createApp } from "../server/index.js";
import { clearFlavorCache } from "../server/providers/opencode.js";
import { createBot } from "../server/state.js";

process.env.RAVNIR_AI_MEMORY = "off";

// The project was called TrueBot. Servers set up then keep working without edits.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("each TRUEBOT_* variable is copied to its RAVNIR_* name unless that is set", () => {
  const env = adoptLegacyEnv({ TRUEBOT_PORT: "4000", TRUEBOT_USER: "old", RAVNIR_USER: "new", PATH: "/bin" });
  assert.equal(env.RAVNIR_PORT, "4000");
  assert.equal(env.RAVNIR_USER, "new");
  assert.equal(env.TRUEBOT_PORT, "4000", "the old name stays for anything that still reads it");
  assert.equal(env.RAVNIR_PATH, undefined);
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("a server started with only the old variable names uses them", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-legacy-env-"));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, TRUEBOT_HOME: home, TRUEBOT_PORT: String(port), TRUEBOT_USER: "owner", TRUEBOT_PASSWORD: "correct horse", TRUEBOT_AI_MEMORY: "off" };
  const server = spawn(process.execPath, [path.join(ROOT, "server/index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server did not start")), 15_000);
      server.stdout.on("data", (chunk) => {
        if (String(chunk).includes(`Ravnir listening on http://127.0.0.1:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.on("exit", (code) => reject(new Error(`the server exited with ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/state`)).status, 401, "TRUEBOT_USER and TRUEBOT_PASSWORD turn sign-in on");
    const auth = `Basic ${Buffer.from("owner:correct horse").toString("base64")}`;
    assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: auth } })).status, 200);
    assert.ok(fs.existsSync(path.join(home, "state.json")), "TRUEBOT_HOME holds the data");
  } finally {
    server.kill("SIGINT");
    await new Promise((resolve) => server.once("exit", resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an OpenCode workspace from before the rename gets the new MCP entry and reloads its tools", async () => {
  // A stand-in OpenCode whose instance still has the old config: connecting "ravnir" fails until a dispose.
  const seen = [];
  let disposed = false;
  const opencode = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    if (req.url.startsWith("/instance/dispose")) disposed = true;
    const refused = req.url.startsWith("/mcp/ravnir/connect") && !disposed;
    res.writeHead(refused ? 400 : 200, { "content-type": "application/json" });
    res.end(req.url.startsWith("/global/health") ? JSON.stringify({ healthy: true }) : refused ? JSON.stringify({ error: "unknown server" }) : "true");
  });
  await new Promise((resolve) => opencode.listen(0, "127.0.0.1", resolve));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-legacy-mcp-"));
  const bot = createBot({ name: "Old", job: "Made before the rename.", model: { provider: "opencode", baseUrl: `http://127.0.0.1:${opencode.address().port}`, model: "opencode-go/glm-5.3-flash", apiKey: "pw" } });
  bot.managedMcpKeys = ["truebot"];
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ version: 1, bots: [bot] }));
  const workspace = path.join(home, "bots", bot.id, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ mcp: { truebot: { type: "remote", url: "http://127.0.0.1:3847/api/bots/x/mcp", enabled: true } } }));
  clearFlavorCache();
  const server = createApp({ home, projectRoot: ROOT });
  try {
    const config = JSON.parse(fs.readFileSync(path.join(workspace, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.mcp), ["ravnir"], "rewritten at startup, without ai-memory or a vault");
    for (let wait = 0; wait < 50 && !seen.filter((line) => line.startsWith("POST /mcp/ravnir/connect")).slice(1).length; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const calls = seen.filter((line) => line.startsWith("POST /mcp/ravnir/connect") || line.startsWith("POST /instance/dispose"));
    assert.deepEqual(calls, ["POST /mcp/ravnir/connect", "POST /instance/dispose", "POST /mcp/ravnir/connect"]);
  } finally {
    server.close();
    opencode.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an agent signed in to the demo before the rename stays signed in", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-demo-cookie-"));
  const server = createApp({ home, projectRoot: ROOT });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const token = Buffer.from(`demo:echo:${Date.now()}`).toString("base64url");
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/demo/account`, { headers: { cookie: `truebot_demo=${token}` } })).text();
    assert.match(page, /echo/);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
