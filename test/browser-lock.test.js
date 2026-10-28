import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserManager, clearForeignLock } from "../server/browser.js";
import { browserProfilePath } from "../server/state.js";
import { callBuiltinTool } from "../server/computer.js";
import { searchInBrowser } from "../server/web.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("browser tools for one agent run one at a time, in the order they were called", async () => {
  const browser = new BrowserManager({ home: os.tmpdir() });
  const marks = [];
  const job = (name) => async () => {
    marks.push(`start ${name}`);
    await wait(30);
    marks.push(`end ${name}`);
    if (name === "a") throw new Error("a failed");
    return name;
  };
  const [first, second, other] = await Promise.allSettled([
    browser.exclusive("bot", job("a")),
    browser.exclusive("bot", job("b")),
    browser.exclusive("someone-else", async () => "free"),
  ]);
  assert.equal(first.reason.message, "a failed");
  assert.equal(second.value, "b");
  assert.equal(other.value, "free");
  // A failed call does not block the next, and another agent never waits.
  assert.deepEqual(marks, ["start a", "end a", "start b", "end b"]);
  assert.equal(browser.locks.size, 0);
});

// Seen in the replays: parallel browser_open calls cancelled each other
// (net::ERR_ABORTED), and a web_search moved the agent's page to Bing.
test("parallel browser_open calls each get their page, and a web search leaves the agent's page alone", async (t) => {
  const server = http.createServer((req, res) => {
    const send = (html) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    if (req.url === "/slow") return setTimeout(() => send("<title>Slow</title><p>slow page</p>"), 1500);
    if (req.url === "/fast") return send("<title>Fast</title><p>fast page</p>");
    if (req.url.startsWith("/search")) return send('<ol><li class="b_algo"><h2><a href="https://example.org/x">Revenue operations jobs Spain</a></h2><p>Revenue operations jobs in Spain</p></li></ol>');
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-browser-lock-"));
  const browser = new BrowserManager({ home });
  const bot = { id: "lock", name: "Lock", vault: [], jobs: [] };
  const ctx = { bot, home, browser, secrets: { get() {} }, save() {}, emit() {}, state: { bots: [bot] } };
  try {
    let session;
    try {
      session = await browser.ensure(bot);
    } catch (error) {
      t.skip(`no browser here: ${error.message}`);
      return;
    }
    const [slow, fast] = await Promise.all([
      callBuiltinTool("browser_open", { url: `${base}/slow` }, ctx),
      callBuiltinTool("browser_open", { url: `${base}/fast` }, ctx),
    ]);
    assert.match(slow.text, /^Slow\n.*\/slow\n[\s\S]*slow page/);
    assert.match(fast.text, /^Fast\n.*\/fast\n[\s\S]*fast page/);

    const rows = await searchInBrowser(browser, bot, "revenue operations jobs spain", 5, { base: `${base}/search` });
    assert.deepEqual(rows.map((row) => row.url), ["https://example.org/x"]);
    assert.match((await session.read()).url, /\/fast$/);
    assert.equal(session.context.pages().length, 1);
  } finally {
    await browser.closeAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a profile lock left by the agent's own computer does not stop the browser on the server", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-browser-foreign-"));
  const bot = { id: "moved", name: "Moved", vault: [], jobs: [] };
  const profile = browserProfilePath(home, bot);
  fs.mkdirSync(profile, { recursive: true });
  // What a box named after the agent leaves behind (seen on the hub: chief-of-staff-22).
  fs.symlinkSync("moved-agent-22", path.join(profile, "SingletonLock"));
  fs.symlinkSync("17657021880558720909", path.join(profile, "SingletonCookie"));
  fs.symlinkSync("/tmp/org.chromium.Chromium.gone/SingletonSocket", path.join(profile, "SingletonSocket"));
  const browser = new BrowserManager({ home });
  try {
    let session;
    try {
      session = await browser.ensure(bot);
    } catch (error) {
      if (/not installed/i.test(error.message)) {
        t.skip(`no browser here: ${error.message}`);
        return;
      }
      throw error;
    }
    assert.ok(session.alive());
    assert.match(fs.readlinkSync(path.join(profile, "SingletonLock")), new RegExp(`^${os.hostname()}-\\d+$`));
  } finally {
    await browser.closeAll().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("clearForeignLock keeps this host's lock and a profile with no lock", () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-lock-"));
  try {
    assert.equal(clearForeignLock(profile, "ubuntu"), false);
    fs.symlinkSync("ubuntu-401582", path.join(profile, "SingletonLock"));
    assert.equal(clearForeignLock(profile, "ubuntu"), false);
    assert.equal(fs.readlinkSync(path.join(profile, "SingletonLock")), "ubuntu-401582");
    assert.equal(clearForeignLock(profile, "other-host"), true);
    assert.equal(fs.existsSync(path.join(profile, "SingletonLock")), false);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
