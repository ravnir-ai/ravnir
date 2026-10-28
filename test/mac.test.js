import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { MAC_PATH, MacNode, insideMacRoots, sensitiveMacCommand, sensitiveMacPath } from "../server/macNode.js";
import { macDecision } from "../server/policy.js";
import { macSection } from "../server/prompts.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 1;
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  say(message) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

function fakeNotifications() {
  const sent = [];
  return { sent, notify: async (item) => (sent.push(item), item) };
}

const bot = { id: "b1", name: "Lead Engineer" };

test("the Mac runner must say hello with the right token", () => {
  const mac = new MacNode({ token: "secret" });
  const bad = new FakeSocket();
  mac.attach(bad);
  bad.say({ type: "hello", token: "wrong" });
  assert.equal(mac.online, false);
  const good = new FakeSocket();
  mac.attach(good);
  good.say({ type: "hello", token: "secret", host: "MacBook", home: "/Users/i", roots: ["~/Desktop/Projects"] });
  assert.equal(mac.online, true);
  assert.equal(mac.status().host, "MacBook");
  assert.equal(good.sent[0].type, "welcome");
  mac.close();
});

test("a call is answered by the runner, and fails plainly when the Mac is offline", async () => {
  const mac = new MacNode({ token: "t" });
  await assert.rejects(mac.call(bot, "run", { command: "ls" }), /offline/);
  const ws = new FakeSocket();
  mac.attach(ws);
  ws.say({ type: "hello", token: "t", home: "/Users/i" });
  const pending = mac.call(bot, "run", { command: "ls" });
  const call = ws.sent.find((item) => item.type === "call");
  assert.equal(call.op, "run");
  ws.say({ type: "result", id: call.id, data: { output: "a\n", code: 0 } });
  assert.deepEqual(await pending, { output: "a\n", code: 0 });
  mac.close();
});

test("a runner that acknowledges calls: a dead link fails in seconds, a live one waits for the result", async () => {
  const mac = new MacNode({ token: "t", ackMs: 60 });
  const dead = new FakeSocket();
  mac.attach(dead);
  dead.say({ type: "hello", token: "t", home: "/Users/i", features: ["ack"] });
  const started = Date.now();
  await assert.rejects(mac.call(bot, "run", { command: "echo ok" }), /did not pick up the command within 0 s, so its connection is probably gone/);
  assert.ok(Date.now() - started < 2_000, "no waiting for the heartbeat");
  assert.equal(mac.online, false, "the silent socket is dropped so the runner dials again");

  const live = new FakeSocket();
  mac.attach(live);
  live.say({ type: "hello", token: "t", home: "/Users/i", features: ["ack"] });
  const pending = mac.call(bot, "run", { command: "sleep 1; echo ok" });
  const call = live.sent.find((item) => item.type === "call");
  live.say({ type: "ack", id: call.id });
  await new Promise((resolve) => setTimeout(resolve, 150));
  live.say({ type: "result", id: call.id, data: { output: "ok\n", code: 0 } });
  assert.deepEqual(await pending, { output: "ok\n", code: 0 }, "a slow command is fine once it was picked up");
  // An older runner without "ack" is never cut short.
  const old = new FakeSocket();
  mac.attach(old);
  old.say({ type: "hello", token: "t", home: "/Users/i" });
  const slow = mac.call(bot, "run", { command: "ls" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const oldCall = old.sent.find((item) => item.type === "call");
  old.say({ type: "result", id: oldCall.id, data: { output: "a\n", code: 0 } });
  assert.deepEqual(await slow, { output: "a\n", code: 0 });
  mac.close();
});

test("when the Mac drops mid-task the bot's call fails and the user hears, then hears it is back", async () => {
  const notifications = fakeNotifications();
  const mac = new MacNode({ token: "t", notifications });
  const ws = new FakeSocket();
  mac.attach(ws);
  ws.say({ type: "hello", token: "t", home: "/Users/i" });
  const pending = mac.call(bot, "run", { command: "npm test" }, { cwd: "~/Desktop/Projects/Ravnir" });
  ws.close();
  await assert.rejects(pending, /went offline/);
  assert.equal(mac.online, false);
  assert.equal(notifications.sent.length, 1);
  assert.match(notifications.sent[0].title, /Lead Engineer: your Mac went offline/);
  assert.match(notifications.sent[0].body, /Ravnir/);
  const again = new FakeSocket();
  mac.attach(again);
  again.say({ type: "hello", token: "t", home: "/Users/i" });
  assert.equal(notifications.sent.length, 2);
  assert.match(notifications.sent[1].title, /your Mac is back/);
  mac.close();
});

test("bots that did not use the Mac recently are not told it went offline", () => {
  let clock = 1_000_000;
  const notifications = fakeNotifications();
  const mac = new MacNode({ token: "t", notifications, now: () => clock });
  const ws = new FakeSocket();
  mac.attach(ws);
  ws.say({ type: "hello", token: "t" });
  mac.work.set("old", { name: "PA", cwd: "", at: clock });
  clock += 60 * 60_000;
  ws.close();
  assert.equal(notifications.sent.length, 0);
  mac.close();
});

test("Mac rules: reads in the work folders run, writes follow the files rule, secrets always ask", () => {
  const where = { home: "/Users/i", roots: ["~/Desktop/Projects"] };
  const careful = { shell: "ask", files: "ask" };
  const trusted = { shell: "allow", files: "allow" };
  assert.equal(macDecision(careful, "mac_read_file", { path: "~/Desktop/Projects/a/README.md" }, where), "allow");
  assert.equal(macDecision(careful, "mac_list", {}, where), "allow");
  assert.equal(macDecision(careful, "mac_write_file", { path: "~/Desktop/Projects/a/x.js" }, where), "ask");
  assert.equal(macDecision(trusted, "mac_write_file", { path: "~/Desktop/Projects/a/x.js" }, where), "allow");
  assert.equal(macDecision(careful, "mac_read_file", { path: "~/Documents/tax.pdf" }, where), "ask");
  assert.equal(macDecision(trusted, "mac_read_file", { path: "~/Desktop/Projects/acme/.env" }, where), "ask");
  assert.equal(macDecision(trusted, "mac_read_file", { path: "~/.ssh/config" }, where), "ask");
  assert.equal(macDecision(careful, "mac_run", { command: "git status" }, where), "ask");
  assert.equal(macDecision(trusted, "mac_run", { command: "git status" }, where), "allow");
  assert.equal(macDecision(trusted, "mac_run", { command: "cat .env" }, where), "ask");
  assert.equal(macDecision(trusted, "mac_run", { command: "security find-generic-password -s x" }, where), "ask");
  assert.equal(macDecision({ shell: "deny" }, "mac_run", { command: "ls" }, where), "deny");
  assert.equal(macDecision(careful, "mac_status", {}, where), "allow");
  assert.equal(insideMacRoots("~/Desktop/Projects/../.ssh/id", where), false);
  assert.ok(sensitiveMacPath("/Users/i/Library/Keychains/login.keychain-db"));
  assert.ok(sensitiveMacCommand("sudo rm -rf /tmp/x"));
});

test("the prompt tells every bot where it lives and whether the Mac is reachable", () => {
  assert.match(macSection(null), /not linked/);
  assert.match(macSection({ configured: true, online: false }), /offline right now/);
  const online = macSection({ configured: true, online: true, host: "MacBook", roots: ["~/Desktop/Projects"] });
  assert.match(online, /online now/);
  assert.match(online, /you live on this server and can also work on that Mac/);
  // With a name the prompt says whose Mac it is; without one it never guesses.
  assert.match(macSection({ configured: true, online: true, host: "MacBook", roots: [] }, { name: "Alex" }), /^- Alex's Mac \(MacBook\): online now/);
  assert.match(macSection(null, {}), /^- The user's Mac: not linked/);
});

test("the real runner connects, runs a command, reads, writes and lists", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-mac-"));
  const mac = new MacNode({ token: "tok" });
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://x").pathname !== MAC_PATH) return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => mac.attach(ws));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(tmp, "config.json");
  fs.writeFileSync(config, JSON.stringify({ url: `ws://127.0.0.1:${server.address().port}${MAC_PATH}`, token: "tok", roots: [tmp] }));
  const runner = spawn(process.execPath, [path.join(ROOT, "bin/mac-node.mjs")], { env: { ...process.env, RAVNIR_MAC_CONFIG: config }, stdio: "ignore" });
  t.after(() => {
    runner.kill();
    mac.close();
    sockets.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !mac.online; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mac.online, true);
  const ran = await mac.call(bot, "run", { command: "echo hi && pwd", cwd: tmp });
  assert.equal(ran.code, 0);
  assert.match(ran.output, /hi/);
  const file = path.join(tmp, "sub/note.txt");
  await mac.call(bot, "write", { path: file, content: "hola" });
  assert.equal((await mac.call(bot, "read", { path: file })).content, "hola");
  const listed = await mac.call(bot, "list", { path: tmp });
  assert.ok(listed.entries.some((item) => item.name === "sub" && item.type === "dir"));
  await assert.rejects(mac.call(bot, "read", { path: path.join(tmp, "missing") }), /ENOENT/);
});
