import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createApp } from "../server/index.js";
import { frame, INPUT, RESIZE, TerminalManager, terminalSize, upgradeAllowed } from "../server/terminal.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(projectRoot, "box", "term-bridge.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
process.env.RAVNIR_AI_MEMORY = "off";

test("frames carry a type byte and a big-endian length", () => {
  assert.deepEqual([...frame(INPUT, "ls\r")], [0, 0, 0, 0, 3, 0x6c, 0x73, 0x0d]);
  const resize = frame(RESIZE, "120 40");
  assert.equal(resize[0], 1);
  assert.equal(resize.readUInt32BE(1), 6);
  assert.equal(resize.subarray(5).toString(), "120 40");
  assert.equal(frame(INPUT, "é").readUInt32BE(1), 2);
});

test("terminal sizes are clamped and default when missing", () => {
  assert.deepEqual(terminalSize(), { cols: 100, rows: 30 });
  assert.deepEqual(terminalSize("80", "24"), { cols: 80, rows: 24 });
  assert.deepEqual(terminalSize(1, 1), { cols: 20, rows: 5 });
  assert.deepEqual(terminalSize(9999, 9999), { cols: 500, rows: 300 });
  assert.deepEqual(terminalSize("nope", null), { cols: 100, rows: 30 });
});

test("a terminal upgrade must come from the app's own pages", () => {
  assert.equal(upgradeAllowed({ host: "a:1", "sec-fetch-site": "same-origin", origin: "http://a:1" }), true);
  assert.equal(upgradeAllowed({ host: "a:1", "sec-fetch-site": "cross-site", origin: "http://a:1" }), false);
  assert.equal(upgradeAllowed({ host: "a:1", "sec-fetch-site": "same-site", origin: "http://b.a:1" }), false);
  // Older browsers send only Origin.
  assert.equal(upgradeAllowed({ host: "a:1", origin: "http://a:1" }), true);
  assert.equal(upgradeAllowed({ host: "a:1", origin: "https://evil.example" }), false);
  assert.equal(upgradeAllowed({ host: "a:1", origin: "not a url" }), false);
  // Behind tailscale serve or another proxy.
  assert.equal(upgradeAllowed({ host: "127.0.0.1:3847", "x-forwarded-host": "hub.ts.net:8443", origin: "https://hub.ts.net:8443" }), true);
  assert.equal(upgradeAllowed({ host: "127.0.0.1:3847", origin: "https://hub.ts.net:8443" }, { publicUrl: "https://hub.ts.net:8443" }), true);
  // Not a browser: no Origin, no fetch metadata. Still needs the password upstream.
  assert.equal(upgradeAllowed({ host: "a:1" }), true);
});

test("term-bridge.py runs a shell on a PTY, resizes in band, and returns the exit code", { skip: !hasPython && "python3 is not installed" }, async () => {
  const child = spawn("python3", ["-I", BRIDGE, "80", "24", "--", "/bin/sh"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.stdin.write(frame(INPUT, "echo bridge-$((40+2))\r"));
  await until(() => output.includes("bridge-42"));
  child.stdin.write(frame(RESIZE, "120 40"));
  child.stdin.write(frame(INPUT, "stty size\r"));
  await until(() => output.includes("40 120"));
  child.stdin.write(frame(INPUT, "exit 3\r"));
  assert.equal(await closed, 3);
});

test("term-bridge.py hangs up a child before its process group is ready", { skip: !hasPython && "python3 is not installed" }, () => {
  const script = `
import importlib.util
import subprocess
import sys

spec = importlib.util.spec_from_file_location("bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

def no_group(pid, sig):
    raise ProcessLookupError()

bridge.os.killpg = no_group
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
try:
    bridge.hang_up(child.pid)
    assert child.poll() is not None, "the child is still alive without a process group"
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
`;
  const result = spawnSync("python3", ["-I", "-B", "-c", script, BRIDGE], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("term-bridge.py hangs up the shell when its input closes", { skip: !hasPython && "python3 is not installed" }, async (t) => {
  const child = spawn("python3", ["-I", BRIDGE, "80", "24", "--", "/bin/sh"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.stdin.end();
  const code = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
  assert.notEqual(code, "timeout");
});

test("one shell per bot: shared by viewers, replayed on reattach, closed when idle", { skip: !hasPython && "python3 is not installed" }, async () => {
  let spawned = 0;
  const manager = new TerminalManager({
    idleMs: 300,
    spawnShell: async (_bot, { cols, rows }) => {
      spawned += 1;
      const child = spawn("python3", ["-I", BRIDGE, String(cols), String(rows), "--", "/bin/sh"], { stdio: ["pipe", "pipe", "pipe"] });
      return { child, label: "test shell" };
    },
  });
  const bot = { id: "bot-1", name: "Tester" };
  const a = viewer();
  const b = viewer();
  await manager.attach(bot, a, { cols: 80, rows: 24 });
  await manager.attach(bot, b, { cols: 80, rows: 24 });
  assert.equal(spawned, 1);
  assert.equal(a.messages[0].t, "ready");
  assert.equal(a.messages[0].label, "test shell");
  assert.equal(manager.input(bot.id, "echo shared-$((2+3))\r"), true);
  await until(() => a.text().includes("shared-5") && b.text().includes("shared-5"));

  manager.detach(bot.id, a);
  manager.detach(bot.id, b);
  const c = viewer();
  await manager.attach(bot, c, { cols: 80, rows: 24 });
  assert.equal(spawned, 1, "reattaching inside the idle window keeps the same shell");
  assert.match(c.text(), /shared-5/, "the new viewer gets the recent output");

  manager.detach(bot.id, c);
  await until(() => !manager.status(bot.id).open, 3000);
  assert.equal(manager.input(bot.id, "echo gone\r"), false);

  const d = viewer();
  await manager.attach(bot, d, { cols: 80, rows: 24 });
  assert.equal(spawned, 2, "a new shell after the idle close");
  manager.input(bot.id, "exit 7\r");
  await until(() => d.messages.some((message) => message.t === "exit"));
  assert.equal(d.messages.find((message) => message.t === "exit").code, 7);
  manager.closeAll();
});

test("a viewer that left while the shell started is not kept", async () => {
  let release;
  const manager = new TerminalManager({
    idleMs: 50,
    spawnShell: () => new Promise((resolve) => {
      release = () => {
        const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
        resolve({ child, label: "" });
      };
    }),
  });
  let open = true;
  const gone = { messages: [], send(message) { this.messages.push(message); }, closed: () => !open };
  const attached = manager.attach({ id: "b", name: "B" }, gone, {});
  await until(() => typeof release === "function");
  open = false;
  release();
  await attached;
  assert.equal(gone.messages.length, 0);
  await until(() => !manager.status("b").open, 2000);
});

test("the Shell tab terminal over WebSocket: password, same origin, and a live shell", { skip: !hasPython && "python3 is not installed" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-term-"));
  process.env.RAVNIR_USER = "owner";
  process.env.RAVNIR_PASSWORD = "test-password";
  const server = createApp({ home, projectRoot });
  delete process.env.RAVNIR_USER;
  delete process.env.RAVNIR_PASSWORD;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const basic = `Basic ${Buffer.from("owner:test-password").toString("base64")}`;
  try {
    await fetch(`${base}/api/bots`, { method: "POST", headers: { authorization: basic, "content-type": "application/json" }, body: JSON.stringify({ name: "Scout", job: "Reads the web." }) });
    const listed = await fetch(`${base}/api/state`, { headers: { authorization: basic } }).then((response) => response.json());
    const bot = listed.bots[0];
    const wsUrl = `ws://127.0.0.1:${port}/api/bots/${bot.id}/terminal/ws?cols=90&rows=20`;

    assert.equal(await refusal(wsUrl, {}), 401, "no password, no terminal");
    assert.equal(await refusal(wsUrl, { authorization: basic, origin: "https://evil.example" }), 403, "another site cannot open it with the user's credentials");
    assert.equal(await refusal(`ws://127.0.0.1:${port}/api/bots/nope/terminal/ws`, { authorization: basic }), 404);

    const vendor = await fetch(`${base}/vendor/xterm.js`, { headers: { authorization: basic } });
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/vendor/xterm.js`, { redirect: "manual" })).status, 302, "signed out goes to the sign-in page");

    const socket = new WebSocket(wsUrl, { headers: { authorization: basic, origin: base } });
    const messages = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await until(() => messages.some((message) => message.t === "ready"));
    assert.match(messages.find((message) => message.t === "ready").label, /workspace/);
    socket.send(JSON.stringify({ t: "in", d: "echo ws-$((40+2)); pwd\r" }));
    const text = () => messages.filter((message) => message.t === "out").map((message) => message.d).join("");
    await until(() => text().includes("ws-42"));
    assert.match(text(), new RegExp(`bots/${bot.id}/workspace`));
    socket.close();

    const detail = await fetch(`${base}/api/bots/${bot.id}`, { headers: { authorization: basic } }).then((response) => response.json());
    assert.deepEqual(detail.bot.box, { mode: "host" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function viewer() {
  const messages = [];
  return {
    messages,
    send(message) { messages.push(message); },
    closed: () => false,
    text: () => messages.filter((message) => message.t === "out").map((message) => message.d).join(""),
  };
}

function refusal(url, headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.on("open", () => {
      resolve("open");
      socket.terminate();
    });
    socket.on("error", () => {});
  });
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail("timed out waiting");
}
