import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ApprovalCenter } from "../server/approvals.js";
import { BrowserManager, BrowserSession, HANDED_OVER_MESSAGE, HandedOverError } from "../server/browser.js";
import { builtinToolDefinitions, callBuiltinTool } from "../server/computer.js";
import { createApp } from "../server/index.js";
import {
  HANDOVER_GUARDED_TOOLS, LiveError, LiveManager, lastVisitedUrl, NEEDS_NEW_IMAGE, novncFile, plainChromiumArgs, x11vncArgs,
} from "../server/live.js";
import { handleBuiltinMcp } from "../server/mcpBuiltin.js";
import { buildSystemPrompt } from "../server/prompts.js";
import { SecretStore } from "../server/secrets.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

// No real Chromium: the agent's browser session is a stand-in with the same surface.
const real = {
  launch: BrowserSession.prototype.launch,
  navigate: BrowserSession.prototype.navigate,
  close: BrowserSession.prototype.close,
  refreshMeta: BrowserSession.prototype.refreshMeta,
};
test.before(() => {
  BrowserSession.prototype.launch = async function launch() {
    this.closed = false;
    this.context = {};
    this.page = { isClosed: () => false };
    this.launches = (this.launches || 0) + 1;
  };
  BrowserSession.prototype.navigate = async function navigate(url) {
    this.url = url;
    this.title = `Title of ${url}`;
    return this.status();
  };
  BrowserSession.prototype.refreshMeta = async function refreshMeta() {
    return this.status();
  };
  BrowserSession.prototype.close = async function close() {
    this.closed = true;
  };
});
test.after(() => Object.assign(BrowserSession.prototype, real));

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-${name}-`));
const bot = { id: "bot-live-1", name: "Echo", vault: [], policy: {} };

// A driver that records what it was asked and shares a pretend screen.
function fakeDriver(extra = {}) {
  const calls = [];
  const driver = {
    kind: "host",
    calls,
    available: async () => ({ ok: true }),
    ensureVnc: async () => { calls.push("ensureVnc"); },
    stopVnc: async () => { calls.push("stopVnc"); },
    startPlain: async (_bot, url) => { calls.push(`startPlain ${url}`); },
    stopPlain: async (_bot, options) => { calls.push(`stopPlain ${options.fallback}`); return driver.endedOn || ""; },
    // The pretend VNC server answers every message with "echo:" and the same bytes.
    connect: () => {
      const output = new PassThrough();
      const input = new Writable({
        write(chunk, _encoding, done) {
          output.write(Buffer.concat([Buffer.from("echo:"), chunk]));
          done();
        },
      });
      let onClose = () => {};
      driver.lastConnection = { closed: false };
      return {
        input,
        output,
        close: () => {
          driver.lastConnection.closed = true;
          input.destroy();
          output.destroy();
          onClose();
        },
        onClose: (callback) => { onClose = callback; },
      };
    },
    ...extra,
  };
  return driver;
}

function manager({ driver = fakeDriver(), approvals, timings = {} } = {}) {
  const home = tmp("live");
  const browser = new BrowserManager({ home });
  const live = new LiveManager({ home, browser, desktop: {}, approvals, drivers: { host: driver, box: driver }, ...timings });
  return { home, browser, live, driver };
}

function engineFor(approvals) {
  return { approvals, approvalMeta: () => ({ source: "chat", turnId: "turn-1" }), active: new Map() };
}

async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail("timed out waiting");
}

test("a plain browser carries the profile and nothing that marks it as automated", () => {
  const args = plainChromiumArgs({ profile: "/p/profile", url: "https://accounts.example.com/login" });
  assert.ok(args.includes("--user-data-dir=/p/profile"));
  assert.ok(args.includes("--no-first-run"));
  assert.equal(args.at(-1), "https://accounts.example.com/login");
  const joined = args.join(" ");
  assert.doesNotMatch(joined, /remote-debugging|enable-automation|headless|user-agent|webdriver|AutomationControlled|test-type|disable-blink/i);
  assert.ok(!args.includes("--no-sandbox"), "the sandbox stays on unless the server turned it off");
  assert.ok(plainChromiumArgs({ profile: "/p", url: "", sandbox: false }).includes("--no-sandbox"));
  assert.equal(plainChromiumArgs({ profile: "/p", url: "" }).at(-1), "about:blank");
});

test("x11vnc listens on loopback only, with no password because the WebSocket is the gate", () => {
  const args = x11vncArgs({ display: ":91", auth: "/d/Xauthority", port: 5911 });
  assert.deepEqual(args.slice(0, 4), ["-display", ":91", "-auth", "/d/Xauthority"]);
  for (const flag of ["-localhost", "-shared", "-forever", "-nopw", "-noxdamage", "-quiet"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("-rfbport") + 1], "5911");
  assert.ok(!args.includes("-auth") || args.includes("/d/Xauthority"));
  assert.ok(!x11vncArgs({ display: ":1", port: 5900 }).includes("-auth"), "no auth file inside a box");
});

test("noVNC files are served from the package and nowhere else", () => {
  assert.deepEqual(novncFile("/vendor/novnc/core/rfb.js", projectRoot)?.[1], "text/javascript; charset=utf-8");
  assert.ok(novncFile("/vendor/novnc/vendor/pako/lib/zlib/inflate.js", projectRoot));
  for (const bad of [
    "/vendor/novnc/core/../../package.json",
    "/vendor/novnc/core/../../../server/index.js",
    "/vendor/novnc/core/%2e%2e/%2e%2e/package.json",
    "/vendor/novnc/package.json",
    "/vendor/novnc/core/missing.js",
    "/vendor/novnc/core/rfb.css",
    "/vendor/novnc/docs/API.md",
  ]) assert.equal(novncFile(bad, projectRoot), null, bad);
});

test("the last page of a plain browser comes from its History after it quits", async () => {
  const profile = tmp("history");
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(profile, "Default", "History"));
  db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, last_visit_time INTEGER)");
  const webkit = (ms) => (ms + 11_644_473_600_000) * 1000;
  const startedAt = Date.now() - 60_000;
  const insert = db.prepare("INSERT INTO urls (url, last_visit_time) VALUES (?, ?)");
  insert.run("https://old.example.com/before", webkit(startedAt - 10_000));
  insert.run("https://accounts.example.com/login", webkit(startedAt + 5_000));
  insert.run("chrome://newtab/", webkit(startedAt + 30_000));
  insert.run("https://accounts.example.com/home", webkit(startedAt + 20_000));
  db.close();
  assert.equal(await lastVisitedUrl(profile, startedAt), "https://accounts.example.com/home");
  assert.equal(await lastVisitedUrl(profile, Date.now()), "", "nothing newer than the takeover");
  assert.equal(await lastVisitedUrl(path.join(profile, "nope"), 0), "");
});

test("while the user has the browser, nothing can open it and every browser tool says so", async () => {
  const { browser } = manager();
  browser.hold(bot.id, { url: "https://a.example" });
  await assert.rejects(browser.ensure(bot), (error) => error instanceof HandedOverError && error.message === HANDED_OVER_MESSAGE && error.status === 409);
  assert.equal(browser.status(bot).handedOver, true);
  let touched = 0;
  const watching = new Proxy(browser, { get: (target, key) => (key === "ensure" ? () => { touched += 1; return target.ensure(bot); } : Reflect.get(target, key)) });
  for (const name of HANDOVER_GUARDED_TOOLS) {
    const result = await callBuiltinTool(name, { url: "https://x.example", goal: "g", site: "s", key: "Enter", text: "t" }, { bot, browser: watching, home: tmp("tool"), secrets: {}, save() {} });
    assert.equal(result.text, HANDED_OVER_MESSAGE, name);
  }
  assert.equal(touched, 0, "the guard answers before any tool reaches the browser");
  for (const name of ["browser_open", "browser_read", "browser_click", "browser_type", "browser_key", "browser_smart_click", "browser_saved_login", "computer_task", "desktop_task"]) {
    assert.ok(HANDOVER_GUARDED_TOOLS.has(name), name);
  }
  browser.release(bot.id);
  const session = await browser.ensure(bot);
  assert.equal(session.alive(), true);
  await browser.close(bot.id);
});

test("the take over tool is offered to bots and to OpenCode, and the prompt says when to use it", async () => {
  const tool = builtinToolDefinitions().find((item) => item.name === "ask_user_to_take_over");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["reason"]);
  assert.ok(tool.parameters.properties.url);
  const listed = await handleBuiltinMcp({ body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, bot, ctx: {}, token: "t", header: "Bearer t" });
  assert.ok(listed.json.result.tools.some((item) => item.name === "ask_user_to_take_over"));
  const prompt = buildSystemPrompt({ name: "Echo", memory: [], policy: {} }, { workspace: "/w" });
  assert.match(prompt, /ask_user_to_take_over/);
  assert.match(prompt, /Never ask for a password in chat/);
  assert.doesNotMatch(prompt, /[\u2013\u2014]/, "no dashes in copy");
});

test("a sign-in takeover: the approval waits, the user takes the browser, Done resolves the tool", async () => {
  const home = tmp("round");
  const approvals = new ApprovalCenter({ home, timeoutMs: 20_000 });
  const driver = fakeDriver();
  const { browser, live } = manager({ driver, approvals });
  const engine = engineFor(approvals);
  const ctx = { bot, live, engine, browser, home, secrets: {}, save() {} };

  const result = callBuiltinTool("ask_user_to_take_over", { reason: "Google says this browser may not be secure.", url: "https://accounts.example.com/login" }, ctx);
  let settled = false;
  result.then(() => { settled = true; });
  await until(() => approvals.pendingFor(bot.id).length === 1);
  const [request] = approvals.pendingFor(bot.id);
  assert.equal(request.kind, "takeover");
  assert.equal(request.title, "Google says this browser may not be secure.");
  assert.equal(request.onceOnly, true);
  assert.deepEqual(request.data, { url: "https://accounts.example.com/login", reason: "Google says this browser may not be secure." });
  assert.match(request.detail, /Page: https:\/\/accounts\.example\.com\/login/);
  assert.equal(request.source, "chat");
  assert.equal(settled, false, "the tool waits for the user");

  // The user presses Take control on the card.
  const status = await live.takeOver(bot, { url: request.data.url });
  assert.equal(status.handedOver, true);
  assert.ok(driver.calls.includes("startPlain https://accounts.example.com/login"));
  assert.equal(browser.isHeld(bot.id), true);
  const blocked = await callBuiltinTool("browser_read", {}, ctx);
  assert.equal(blocked.text, HANDED_OVER_MESSAGE);
  assert.equal((await live.takeOver(bot, {})).handedOver, true, "pressing it twice changes nothing");
  assert.equal(driver.calls.filter((call) => call.startsWith("startPlain")).length, 1);
  assert.equal(settled, false);

  // They sign in, land on the account page and press Done.
  driver.endedOn = "https://accounts.example.com/account";
  const handed = await live.handBack(bot);
  assert.equal(handed.handedOver, false);
  assert.equal(browser.isHeld(bot.id), false);
  const done = await result;
  assert.equal(done.text, "The user finished. The browser is back at https://accounts.example.com/account (Title of https://accounts.example.com/account).");
  assert.equal(approvals.records.find((item) => item.id === request.id).status, "approved");
  // The agent has its browser again, on the page the user left.
  const session = await browser.ensure(bot);
  assert.equal(session.url, "https://accounts.example.com/account");
  assert.equal(session.alive(), true);
  await browser.close(bot.id);
});

test("declined, expired and cancelled takeovers say so, and give the browser back if the user still had it", async () => {
  const home = tmp("declined");
  const approvals = new ApprovalCenter({ home, timeoutMs: 400 });
  const driver = fakeDriver();
  const { browser, live } = manager({ driver, approvals });
  const engine = engineFor(approvals);
  const ctx = { bot, live, engine, browser, home, secrets: {}, save() {} };

  let pending = callBuiltinTool("ask_user_to_take_over", { reason: "CAPTCHA" }, ctx);
  await until(() => approvals.pendingFor(bot.id).length === 1);
  approvals.decide(approvals.pendingFor(bot.id)[0].id, "reject");
  assert.match((await pending).text, /declined to take over.*Do not retry/);

  pending = callBuiltinTool("ask_user_to_take_over", { reason: "CAPTCHA" }, ctx);
  await until(() => approvals.pendingFor(bot.id).length === 1);
  assert.match((await pending).text, /did not respond in time/);

  const controller = new AbortController();
  engine.active.set(bot.id, { abort: controller });
  pending = callBuiltinTool("ask_user_to_take_over", { reason: "Two-step check" }, ctx);
  await until(() => approvals.pendingFor(bot.id).length === 1);
  controller.abort();
  assert.match((await pending).text, /cancelled/);
  engine.active.delete(bot.id);

  // Declined while the user is mid sign-in: the agent is not left locked out.
  const long = new ApprovalCenter({ home: tmp("declined-2"), timeoutMs: 20_000 });
  const second = manager({ driver: fakeDriver(), approvals: long });
  const secondCtx = { bot, live: second.live, engine: engineFor(long), browser: second.browser, home, secrets: {}, save() {} };
  pending = callBuiltinTool("ask_user_to_take_over", { reason: "Verify it is you" }, secondCtx);
  await until(() => long.pendingFor(bot.id).length === 1);
  await second.live.takeOver(bot, { url: "https://x.example/login" });
  assert.equal(second.browser.isHeld(bot.id), true);
  long.decide(long.pendingFor(bot.id)[0].id, "reject");
  assert.match((await pending).text, /declined/);
  assert.equal(second.browser.isHeld(bot.id), false, "the browser went back to the agent");
});

test("a takeover is not offered where there is no screen to share, and not while the user already has it", async () => {
  const approvals = new ApprovalCenter({ home: tmp("na"), timeoutMs: 1000 });
  const driver = fakeDriver({ available: async () => ({ ok: false, reason: "This server has no desktop." }) });
  const { browser, live } = manager({ driver, approvals });
  const ctx = { bot, live, engine: engineFor(approvals), browser, home: tmp("na-home"), secrets: {}, save() {} };
  const result = await callBuiltinTool("ask_user_to_take_over", { reason: "Sign in" }, ctx);
  assert.match(result.text, /cannot take over this browser from here: This server has no desktop\./);
  assert.equal(approvals.records.length, 0, "no card for something the user cannot do");
  await assert.rejects(live.start(bot), (error) => error instanceof LiveError && /no desktop/.test(error.message));
  await assert.rejects(live.takeOver(bot, {}), LiveError);

  browser.hold(bot.id, {});
  const live2 = new LiveManager({ home: tmp("na2"), browser, desktop: {}, approvals, drivers: { host: fakeDriver(), box: fakeDriver() } });
  assert.equal((await callBuiltinTool("ask_user_to_take_over", { reason: "Again" }, { ...ctx, live: live2 })).text, HANDED_OVER_MESSAGE);
});

test("a browser the user walked away with returns to the agent, and the shared screen stops when nobody watches", async () => {
  const approvals = new ApprovalCenter({ home: tmp("idle"), timeoutMs: 20_000 });
  const driver = fakeDriver();
  const { browser, live } = manager({ driver, approvals, timings: { idleMs: 60, handbackMs: 120 } });
  await live.start(bot, { withBrowser: false });
  assert.equal(driver.calls.filter((call) => call === "ensureVnc").length, 1);
  const socket = fakeSocket();
  live.attach(socket, bot);
  await until(() => driver.lastConnection);
  assert.equal((await live.status(bot)).viewers, 1);
  await live.takeOver(bot, { url: "https://x.example/login" });
  socket.emit("close");
  await until(() => driver.calls.includes("stopVnc"));
  await until(() => !browser.isHeld(bot.id));
  assert.ok(driver.calls.some((call) => call.startsWith("stopPlain")));
  assert.equal(driver.lastConnection.closed, true);
});

test("a viewer who joins before the screen is ready is told why it failed", async () => {
  const driver = fakeDriver({ ensureVnc: async () => { throw new LiveError(NEEDS_NEW_IMAGE); } });
  const { live } = manager({ driver });
  const socket = fakeSocket();
  await live.attach(socket, bot);
  assert.equal(socket.closed.code, 1011);
  assert.match(socket.closed.reason, /Live view needs the new box image/);
  assert.ok(Buffer.byteLength(socket.closed.reason) <= 123, "a close reason is at most 123 bytes");
});

test("the live WebSocket needs the password, the app's own origin and a real bot, and a bot's MCP token is not enough", async () => {
  const home = tmp("ws");
  process.env.RAVNIR_USER = "owner";
  process.env.RAVNIR_PASSWORD = "live-password";
  const driver = fakeDriver();
  const server = createApp({ home, projectRoot, liveDrivers: { host: driver, box: driver } });
  delete process.env.RAVNIR_USER;
  delete process.env.RAVNIR_PASSWORD;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const basic = `Basic ${Buffer.from("owner:live-password").toString("base64")}`;
  const get = (pathname, headers = {}) => fetch(`${base}${pathname}`, { headers });
  const json = (pathname, method = "GET", body) => fetch(`${base}${pathname}`, {
    method,
    headers: { authorization: basic, "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  try {
    await json("/api/bots", "POST", { name: "Scout", job: "Reads the web." });
    const listed = await (await get("/api/state", { authorization: basic })).json();
    const target = listed.bots[0];
    const wsUrl = `ws://127.0.0.1:${port}/api/bots/${target.id}/live`;

    assert.equal(await refusal(wsUrl, {}), 401, "no password, no screen");
    assert.equal(await refusal(wsUrl, { authorization: "Basic " + Buffer.from("owner:wrong").toString("base64") }), 401);
    assert.equal(await refusal(wsUrl, { authorization: basic, origin: "https://evil.example" }), 403, "another site cannot use the user's credentials");
    assert.equal(await refusal(wsUrl, { authorization: basic, "sec-fetch-site": "cross-site" }), 403);
    assert.equal(await refusal(`ws://127.0.0.1:${port}/api/bots/nope/live`, { authorization: basic }), 404);
    // Saving the bot writes its OpenCode config, which creates the MCP token.
    assert.equal((await json(`/api/bots/${target.id}`, "PATCH", { job: target.job || "Test job" })).status, 200);
    const mcpToken = new SecretStore(home).get(`bot:${target.id}:mcpToken`, "");
    assert.ok(mcpToken.length > 16, "the bot has an MCP token");
    assert.equal(await refusal(wsUrl, { authorization: `Bearer ${mcpToken}` }), 401, "a bot's own MCP token does not open its screen");
    assert.equal((await fetch(`${base}/api/bots/${target.id}/live/status`, { headers: { authorization: `Bearer ${mcpToken}` } })).status, 401);

    // Signed in, same origin: the bytes go to the VNC server and back, as binary frames.
    const socket = new WebSocket(wsUrl, ["binary"], { headers: { authorization: basic, origin: base } });
    const received = [];
    socket.on("message", (data, isBinary) => received.push({ data: Buffer.from(data), isBinary }));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    assert.equal(socket.protocol, "binary", "noVNC asks for the binary subprotocol");
    socket.send(Buffer.from("RFB 003.008\n"));
    await until(() => received.length > 0);
    assert.equal(received[0].isBinary, true);
    assert.equal(received[0].data.toString(), "echo:RFB 003.008\n");
    socket.send("a text frame is ignored");
    socket.send(Buffer.from([1, 2, 3]));
    await until(() => received.length > 1);
    assert.deepEqual([...received[1].data.subarray(5)], [1, 2, 3]);
    socket.close();
    await until(() => driver.lastConnection.closed);

    // The JSON routes under the same sign-in.
    assert.equal((await fetch(`${base}/api/bots/${target.id}/live/status`, { redirect: "manual" })).status, 401);
    const status = await json(`/api/bots/${target.id}/live/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.available, true);
    assert.equal(status.body.handedOver, false);
    assert.equal((await json(`/api/bots/${target.id}/live/start`, "POST", { browser: false })).status, 200);
    const taken = await json(`/api/bots/${target.id}/live/takeover`, "POST", { url: "https://login.example.com/" });
    assert.equal(taken.status, 200);
    assert.equal(taken.body.handedOver, true);
    assert.ok(driver.calls.includes("startPlain https://login.example.com/"));
    assert.equal((await json(`/api/bots/${target.id}/live/takeover`, "POST", { url: "ftp://nope" })).status, 200, "already taken: unchanged");
    driver.endedOn = "https://login.example.com/home";
    const back = await json(`/api/bots/${target.id}/live/handback`, "POST", {});
    assert.equal(back.status, 200);
    assert.equal(back.body.handedOver, false);
    assert.equal((await json(`/api/bots/${target.id}/live/takeover`, "POST", { url: "ftp://nope" })).status, 400, "only web addresses");

    const vendor = await get("/vendor/novnc/core/rfb.js", { authorization: basic });
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/vendor/novnc/core/rfb.js`, { redirect: "manual" })).status, 302, "signed out goes to the sign-in page");
    assert.equal((await get("/live.js", { authorization: basic })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the screen is not shared when the server has no desktop, and the message says what to do", async () => {
  const home = tmp("none");
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const made = await fetch(`${base}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Scout", job: "Reads the web." }) });
    const id = (await made.json()).bot.id;
    const status = await (await fetch(`${base}/api/bots/${id}/live/status`)).json();
    if (process.platform !== "linux") {
      assert.equal(status.available, false);
      assert.match(status.reason, /own computer|Xvfb/);
      const start = await fetch(`${base}/api/bots/${id}/live/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(start.status, 409);
    }
    assert.equal(typeof status.runtime, "string");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function fakeSocket() {
  const handlers = {};
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    closed: null,
    on(event, handler) { handlers[event] = handler; return this; },
    emit(event, ...args) { handlers[event]?.(...args); },
    send() {},
    terminate() { this.readyState = 3; },
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = 3;
      handlers.close?.();
    },
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
