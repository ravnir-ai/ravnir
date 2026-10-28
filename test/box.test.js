import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { admits, boxHostname, boxName, legacyBoxName, BoxGate, BoxManager, boxSettings, DesktopRouter, execArgs, MIGRATE_ENTRIES, runArgs } from "../server/box.js";
import { openCodePermission } from "../server/policy.js";
import { buildSystemPrompt } from "../server/prompts.js";
import { botHome, workspacePath } from "../server/state.js";
import { frame, INPUT } from "../server/terminal.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";
// Opt-in: RAVNIR_TEST_BOX=docker (or podman) runs a real box. npm test leaves it off.
const REAL = ["docker", "podman"].includes(process.env.RAVNIR_TEST_BOX) ? process.env.RAVNIR_TEST_BOX : "";

const bot = (extra = {}) => ({ id: "4f1c2d3e-aaaa-bbbb-cccc-0123456789ab", name: "Lead Engineer", box: { mode: "container" }, ...extra });

test("own computers are off unless RAVNIR_BOX names a runtime", () => {
  assert.equal(boxSettings({}).runtime, "");
  assert.equal(boxSettings({ RAVNIR_BOX: "off" }).runtime, "");
  assert.equal(boxSettings({ RAVNIR_BOX: "lxc" }).runtime, "");
  assert.equal(boxSettings({ RAVNIR_BOX: "Podman" }).runtime, "podman");
  assert.equal(boxSettings({ RAVNIR_BOX: "docker" }).runtime, "docker");
  const settings = boxSettings({ RAVNIR_BOX: "podman", RAVNIR_BOX_MEMORY: "3g", RAVNIR_BOX_NETWORK: "none" });
  assert.equal(settings.memory, "3g");
  assert.equal(settings.network, "none");
  assert.equal(settings.image, "ravnir-box:3");

  const off = new BoxManager({ home: os.tmpdir(), settings: boxSettings({}), cli: async () => ({ code: 0 }) });
  const on = new BoxManager({ home: os.tmpdir(), settings: boxSettings({ RAVNIR_BOX: "docker" }), cli: async () => ({ code: 0 }) });
  assert.equal(off.uses(bot()), false);
  assert.equal(on.uses(bot()), true);
  assert.equal(on.uses(bot({ box: { mode: "host" } })), false);
  assert.equal(on.uses(bot({ box: undefined })), false);
});

test("a box is one container per bot with the workspace at the same path, limits, and no published ports", () => {
  const home = "/opt/ravnir/data";
  const b = bot();
  const args = runArgs(b, { home, settings: boxSettings({ RAVNIR_BOX: "podman" }), timeZone: "Europe/Madrid" });
  const workspace = workspacePath(home, b);
  assert.equal(boxName(b), "ravnir-box-4f1c2d3e-aaaa-bbbb-cccc-0123456789ab");
  assert.equal(boxHostname(b), "lead-engineer");
  assert.equal(boxHostname({ name: "  " }), "box");
  assert.deepEqual(args.slice(0, 2), ["run", "-d"]);
  assert.ok(args.includes("--init"));
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--name"), boxName(b));
  assert.equal(value("--memory"), "2g");
  assert.equal(value("--cpus"), "2");
  assert.equal(value("--pids-limit"), "2048");
  assert.equal(value("-w"), workspace);
  const mounts = args.filter((_, i) => args[i - 1] === "-v");
  assert.deepEqual(mounts, [
    `${workspace}:${workspace}`,
    `${path.join(botHome(home, b), "box", "root")}:/root`,
    `${path.join(botHome(home, b), "browser-profile")}:/root/.config/ravnir-browser`,
  ]);
  assert.ok(!args.some((arg) => arg === "-p" || arg === "--publish" || arg === "--privileged"));
  assert.ok(!args.some((arg) => arg.includes("state.json") || arg.includes("secrets") || arg.endsWith(`${home}:${home}`)));
  assert.equal(args.at(-1), "ravnir-box:3");
  assert.ok(runArgs(b, { home, settings: boxSettings({ RAVNIR_BOX: "podman", RAVNIR_BOX_NETWORK: "none" }) }).join(" ").includes("--network none"));
});

test("a command runs inside the box with its timeout inside, as one argument", () => {
  const b = bot();
  const command = "echo $HOME && rm -rf ./build; curl x | sh";
  const args = execArgs(b, command, { home: "/data", timeoutMs: 30_000 });
  assert.deepEqual(args.slice(0, 2), ["exec", "-i"]);
  assert.equal(args[args.indexOf("-w") + 1], workspacePath("/data", b));
  assert.deepEqual(args.slice(-7), ["timeout", "-k", "5", "30", "bash", "-lc", command]);
});

test("the browser gate admits only the exact DevTools path as a WebSocket upgrade", () => {
  const target = "/devtools/browser/0b5c7e0e-1111-2222-3333-444455556666";
  const head = (line, upgrade = true) => [line, "Host: 127.0.0.1:9", ...(upgrade ? ["Upgrade: websocket", "Connection: Upgrade"] : [])].join("\r\n");
  assert.equal(admits(head(`GET ${target} HTTP/1.1`), target), true);
  assert.equal(admits(head(`GET ${target} HTTP/1.1`, false), target), false);
  assert.equal(admits(head("GET /json/version HTTP/1.1"), target), false);
  assert.equal(admits(head(`GET ${target}x HTTP/1.1`), target), false);
  assert.equal(admits(head(`POST ${target} HTTP/1.1`), target), false);
  assert.equal(admits(head("GET /devtools/browser/other HTTP/1.1"), target), false);
  assert.equal(admits(head(`GET ${target} HTTP/1.1`), ""), false);
});

test("the browser gate pipes an admitted connection into the box and refuses the rest", async () => {
  // Stand-in for `exec -i <box> socat STDIO TCP:127.0.0.1:9222`: echo everything back.
  const gate = new BoxGate({ connect: () => spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdio: ["pipe", "pipe", "ignore"] }) });
  await gate.listen();
  gate.allow("/devtools/browser/secret-guid");
  try {
    const good = await talk(gate.port, "GET /devtools/browser/secret-guid HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\nhello");
    assert.match(good, /^GET \/devtools\/browser\/secret-guid/);
    assert.match(good, /hello$/);
    const bad = await talk(gate.port, "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert.match(bad, /^HTTP\/1\.1 403/);
  } finally {
    gate.close();
  }
});

test("starting a box: build the image once, copy the old home once, run, wait for the desktop", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "truebot-box-"));
  const b = bot();
  const oldHome = botHome(home, b);
  fs.mkdirSync(path.join(oldHome, ".npm-global", "bin"), { recursive: true });
  fs.writeFileSync(path.join(oldHome, ".npm-global", "bin", "tool"), "#!/bin/sh\n");
  fs.mkdirSync(path.join(oldHome, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(oldHome, ".ssh", "config"), "Host x\n");
  fs.writeFileSync(path.join(oldHome, "conversation.json"), "[]");
  fs.mkdirSync(path.join(oldHome, ".cache", "pip"), { recursive: true });

  const calls = [];
  let created = false;
  let imageReady = false;
  const cli = async (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === "inspect") return created ? { code: 0, stdout: "running\n" } : { code: 1, stdout: "", stderr: "no such container" };
    if (verb === "image") return { code: imageReady ? 0 : 1, stdout: "", stderr: "" };
    if (verb === "build") {
      imageReady = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "run") {
      created = true;
      return { code: 0, stdout: "abc\n", stderr: "" };
    }
    if (verb === "exec") return { code: 0, stdout: "", stderr: "" };
    if (verb === "rm") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected ${verb}` };
  };
  const box = new BoxManager({ home, settings: boxSettings({ RAVNIR_BOX: "podman" }), cli, playwrightVersion: "1.64.1" });
  await Promise.all([box.ensure(b), box.ensure(b)]);
  const verbs = calls.map((args) => args[0]);
  assert.equal(verbs.filter((verb) => verb === "build").length, 1);
  assert.equal(verbs.filter((verb) => verb === "run").length, 1, "two callers at once start one box");
  assert.ok(calls.find((args) => args[0] === "build").includes("PLAYWRIGHT_VERSION=1.64.1"));
  assert.deepEqual(calls.find((args) => args[0] === "exec").slice(-1), ["xdpyinfo"]);
  assert.equal((await box.status(b)).state, "running");

  const root = path.join(oldHome, "box", "root");
  assert.ok(fs.existsSync(path.join(root, ".npm-global", "bin", "tool")));
  assert.ok(fs.existsSync(path.join(root, ".ssh", "config")));
  assert.ok(!fs.existsSync(path.join(root, "conversation.json")), "Ravnir's own files stay out of the box");
  assert.ok(!fs.existsSync(path.join(root, ".cache")), "caches are not copied");
  assert.ok(fs.existsSync(path.join(oldHome, ".npm-global", "bin", "tool")), "the old home is copied, not moved");
  const marker = JSON.parse(fs.readFileSync(path.join(root, ".ravnir", "migrated.json"), "utf8"));
  assert.deepEqual(marker.copied.sort(), [".npm-global", ".ssh"]);
  assert.ok(MIGRATE_ENTRIES.includes(".local"));
  assert.match(fs.readFileSync(path.join(root, ".ravnir", "setup.sh"), "utf8"), /^#!\/bin\/bash/);

  // A second prepare after the marker copies nothing, even if the old home changed.
  fs.writeFileSync(path.join(oldHome, ".gitconfig"), "[user]\n");
  assert.deepEqual(await box.prepare(b), []);

  await box.reset(b);
  assert.deepEqual(calls.slice(-2), [["rm", "-f", boxName(b)], ["rm", "-f", legacyBoxName(b)]]);
});

test("an old truebot-box container is stopped but kept, and the old .truebot folder is renamed before the new box starts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-box-legacy-"));
  const b = bot();
  const root = path.join(botHome(home, b), "box", "root");
  fs.mkdirSync(path.join(root, ".truebot"), { recursive: true });
  fs.writeFileSync(path.join(root, ".truebot", "setup.sh"), "#!/bin/bash\napt-get install -y jq\n");
  fs.writeFileSync(path.join(root, ".truebot", "migrated.json"), "{\"copied\":[]}");
  const old = legacyBoxName(b);
  assert.equal(old, "truebot-box-4f1c2d3e-aaaa-bbbb-cccc-0123456789ab");
  const calls = [];
  let created = false;
  let legacyStopped = false;
  const cli = async (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === "inspect") {
      if (args.at(-1) === old) return { code: 0, stdout: legacyStopped ? "exited\n" : "running\n" };
      return created ? { code: 0, stdout: "running\n" } : { code: 1, stdout: "", stderr: "no such container" };
    }
    if (verb === "image") return { code: 0, stdout: "" };
    if (verb === "stop" && args.at(-1) === old) {
      legacyStopped = true;
      return { code: 0, stdout: "" };
    }
    if (verb === "run") {
      assert.ok(legacyStopped, "the old container is stopped before the new one is created");
      assert.ok(fs.existsSync(path.join(root, ".ravnir", "setup.sh")), "the folder is renamed before the box starts");
      created = true;
      return { code: 0, stdout: "abc\n" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const box = new BoxManager({ home, settings: boxSettings({ RAVNIR_BOX: "podman" }), cli, playwrightVersion: "1.64.1" });
  await box.ensure(b);
  assert.deepEqual(calls.find((args) => args[0] === "stop"), ["stop", "-t", "5", old]);
  assert.ok(!calls.some((args) => args[0] === "rm" && args.at(-1) === old), "the old container is kept: its layer may hold files outside /root");
  await box.reset(b);
  assert.ok(calls.some((args) => args[0] === "rm" && args.at(-1) === old), "resetting the computer removes the old container too");
  assert.ok(!fs.existsSync(path.join(root, ".truebot")));
  assert.match(fs.readFileSync(path.join(root, ".ravnir", "setup.sh"), "utf8"), /apt-get install -y jq/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".ravnir", "migrated.json"), "utf8")).copied.length, 0, "the old marker carries over");
});

test("a failed start is reported in the status and the next call tries again", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "truebot-box-"));
  let fail = true;
  const cli = async ([verb]) => {
    if (verb === "inspect") return { code: 0, stdout: "exited\n" };
    if (verb === "start") return fail ? { code: 125, stdout: "", stderr: "cgroup: permission denied" } : { code: 0, stdout: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const box = new BoxManager({ home, settings: boxSettings({ RAVNIR_BOX: "podman" }), cli });
  await assert.rejects(box.ensure(bot()), /podman start failed: cgroup: permission denied/);
  assert.match((await box.status(bot())).error, /permission denied/);
  fail = false;
  await box.ensure(bot());
  assert.equal((await box.status(bot())).error, "");
});

test("the desktop router sends box bots to the box and the rest to the host desktop", async () => {
  const host = { width: 1440, height: 900, status: () => ({ host: true }), envFor: () => ({ DISPLAY: ":91" }), close: async (id) => { host.closed = id; }, closeAll: async () => {} };
  const box = new BoxManager({ home: os.tmpdir(), settings: boxSettings({ RAVNIR_BOX: "docker" }), cli: async () => ({ code: 0, stdout: "" }) });
  const router = new DesktopRouter({ host, box });
  assert.deepEqual(router.status(bot({ box: { mode: "host" } })), { host: true });
  assert.equal(router.status(bot()).box, true);
  assert.deepEqual(router.envFor(bot({ box: { mode: "host" } })), { DISPLAY: ":91" });
  assert.deepEqual(router.envFor(bot()), {});
  assert.equal(await router.screenshot(bot()), null, "no screenshot before the box runs");
  assert.throws(() => router.require(bot()), /not running/);
  await router.close("x");
  assert.equal(host.closed, "x");
});

test("OpenCode bash is off for a bot with its own computer, and the prompt says where it works", () => {
  const policy = { shell: "ask", allow: ["git status"] };
  assert.deepEqual(openCodePermission(policy).bash, { "*": "ask", "git status": "allow" });
  assert.equal(openCodePermission(policy, { ownComputer: true }).bash, "deny");
  assert.equal(openCodePermission({ shell: "allow" }, { ownComputer: true }).bash, "deny");

  const own = buildSystemPrompt({ name: "Lead", memory: [], policy }, { ownComputer: true, workspace: "/w" });
  const shared = buildSystemPrompt({ name: "Lead", memory: [], policy }, { workspace: "/w" });
  assert.match(own, /You are root on it/);
  assert.match(own, /run_command runs on your computer as root/);
  assert.match(own, /apt-get install -y/);
  assert.doesNotMatch(own, /Do not try to install system packages/);
  assert.match(shared, /as the Ravnir user/);
  assert.match(shared, /Do not try to install system packages/);
});

test("switching a bot to its own computer through the API", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "truebot-box-api-"));
  const { createApp } = await import("../server/index.js");
  const off = await start(createApp({ home, projectRoot }));
  try {
    await call(off.base, "POST", "/api/bots", { name: "Scout", job: "Reads the web." });
    const state = await call(off.base, "GET", "/api/state");
    assert.deepEqual(state.server.box, { enabled: false, runtime: "" });
    const id = state.bots[0].id;
    const refused = await fetch(`${off.base}/api/bots/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ box: { mode: "container" } }) });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /RAVNIR_BOX/);
    assert.equal((await call(off.base, "GET", `/api/bots/${id}/box`)).state, "host");
  } finally {
    await stop(off.server);
  }

  // A runtime name that is not installed: the switch works, nothing starts until used.
  process.env.RAVNIR_BOX = "podman";
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  const app = createApp({ home, projectRoot });
  process.env.PATH = savedPath;
  delete process.env.RAVNIR_BOX;
  const on = await start(app);
  try {
    const state = await call(on.base, "GET", "/api/state");
    assert.deepEqual(state.server.box, { enabled: true, runtime: "podman" });
    const id = state.bots[0].id;
    const patched = await call(on.base, "PATCH", `/api/bots/${id}`, { box: { mode: "container" } });
    assert.deepEqual(patched.bot.box, { mode: "container" });
    const config = JSON.parse(fs.readFileSync(path.join(workspacePath(home, { id }), "opencode.json"), "utf8"));
    assert.equal(config.permission.bash, "deny");
    const prompt = await call(on.base, "GET", `/api/bots/${id}/prompt`);
    assert.match(JSON.stringify(prompt), /You are root on it/);
    const back = await call(on.base, "PATCH", `/api/bots/${id}`, { box: { mode: "host" } });
    assert.deepEqual(back.bot.box, { mode: "host" });
    const restored = JSON.parse(fs.readFileSync(path.join(workspacePath(home, { id }), "opencode.json"), "utf8"));
    assert.notEqual(restored.permission.bash, "deny");
    const bad = await fetch(`${on.base}/api/bots/${id}/box`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) });
    assert.equal(bad.status, 409, "a host bot has no box to start");
  } finally {
    await stop(on.server);
  }
});

test("a real box: root, apt, files shared with the host, services between commands, desktop, browser, terminal", { skip: !REAL && "set RAVNIR_TEST_BOX=docker or podman to run", timeout: 30 * 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-realbox-"));
  const b = { id: `test-${Date.now()}`, name: "Box Test", box: { mode: "container" } };
  fs.mkdirSync(workspacePath(home, b), { recursive: true });
  fs.mkdirSync(path.join(botHome(home, b), ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(botHome(home, b), ".local", "bin", "hello-old-home"), "#!/bin/sh\necho migrated\n", { mode: 0o755 });
  const box = new BoxManager({ home, settings: boxSettings({ RAVNIR_BOX: REAL }) });
  let browser = null;
  try {
    await box.ensure(b);
    let result = await box.exec(b, "id -u && whoami && . /etc/os-release && echo $VERSION_ID && pwd");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /^0\nroot\n24\.04\n/);
    assert.match(result.output, new RegExp(`${workspacePath(home, b)}$`, "m"));

    result = await box.exec(b, "hello-old-home");
    assert.equal(result.output.trim(), "migrated");

    result = await box.exec(b, "echo from-box > made-in-box.txt");
    assert.equal(fs.readFileSync(path.join(workspacePath(home, b), "made-in-box.txt"), "utf8"), "from-box\n");

    result = await box.exec(b, "DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq cowsay >/dev/null && /usr/games/cowsay moo", { timeout: 300_000 });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /moo/);

    await box.exec(b, "nohup python3 -m http.server 8765 >/tmp/srv.log 2>&1 &");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await box.exec(b, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/");
    assert.equal(result.output.trim(), "200", "a service started in one command is still up in the next");

    result = await box.exec(b, "sleep 30", { timeout: 2000 });
    assert.notEqual(result.code, 0, "the timeout inside the box stops a long command");

    const desktop = new DesktopRouter({ host: { width: 1440, height: 900 }, box });
    const png = await desktop.screenshot(b, { force: true });
    assert.equal(png.subarray(1, 4).toString(), "PNG");

    const endpoint = await box.browserEndpoint(b);
    assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    const refused = await talk(new URL(endpoint).port, "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert.match(refused, /^HTTP\/1\.1 403/);
    browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
    await page.goto("data:text/html,<title>inside the box</title><h1>hi</h1>");
    assert.equal(await page.title(), "inside the box");
    assert.match(await page.evaluate(() => navigator.userAgent), /Linux/);
    await browser.close();
    browser = null;

    const shell = await box.shell(b, { cols: 100, rows: 30 });
    let output = "";
    shell.stdout.on("data", (chunk) => { output += chunk; });
    shell.stdin.write(frame(INPUT, "echo term-$((6*7)) && whoami\r"));
    const end = Date.now() + 15_000;
    while (!/term-42[\s\S]*root/.test(output) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(output, /term-42[\s\S]*root/);
    shell.stdin.end();
    await new Promise((resolve) => shell.on("close", resolve));

    await box.reset(b);
    await box.ensure(b);
    result = await box.exec(b, "test -x /usr/games/cowsay && echo kept || echo gone; cat made-in-box.txt");
    assert.equal(result.output.trim(), "gone\nfrom-box", "reset drops system installs and keeps the workspace");
  } finally {
    await browser?.close().catch(() => {});
    await box.reset(b).catch(() => {});
    box.closeGates();
  }
});

function talk(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.endsWith("hello") || data.includes("\r\n\r\n")) socket.end();
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 3000);
  });
}

async function start(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function call(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}
