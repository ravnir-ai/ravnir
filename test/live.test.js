import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findChromium } from "../server/browser.js";
import { discoverServers } from "../server/discovery.js";
import { createApp } from "../server/index.js";
import { startMock } from "../scripts/mock-openai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

test("a bot keeps its model, conversation, MCP tools, diffs, and jobs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-live-"));
  const mock = await startMock();
  let app = await start(home);
  try {
    const initial = await request(app.base, "GET", "/api/state");
    assert.equal(initial.bots.length, 0, "a fresh install has no agents until the first-run wizard makes them");

    const created = await request(app.base, "POST", "/api/bots", {
      name: "Tester",
      group: "QA",
      job: "Tests the product.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const id = created.bot.id;
    assert.equal(created.bot.group, "QA");

    const faced = await request(app.base, "PATCH", `/api/bots/${id}`, {
      avatar: { shape: "pebble", eyes: "sparkle", mouth: "grin", extra: "sprout" },
    });
    const look = faced.bot.avatar;
    assert.deepEqual([look.shape, look.material, look.color, look.mark, look.mouth, look.extra], ["cube", "gloss", "", "initials", "grin", "sprout"]);
    assert.match(look.eyes, /^(dot|pill|ring|pixel|arc)$/);

    const before = created.lastSeq || 0;
    const sent = await request(app.base, "POST", `/api/bots/${id}/messages`, { text: "Hello there" });
    const first = await waitForTurn(app.base, id, before, sent.turnId);
    assert.equal(first.some((event) => event.type === "error"), false);
    // Small talk gets no plan; the reply comes straight from the agent.
    assert.equal(first.some((event) => event.type === "ack"), false);
    let detail = await request(app.base, "GET", `/api/bots/${id}`);
    assert.match(detail.conversation.map((message) => message.content).join("\n"), /Mock reply: Hello there/);

    const connector = await request(app.base, "POST", `/api/bots/${id}/connectors`, {
      name: "Mock tools",
      transport: "stdio",
      command: process.execPath,
      args: [path.join(projectRoot, "scripts", "mock-mcp.js")],
    });
    assert.equal(connector.connector.status, "connected");
    assert.equal(connector.connector.tools[0].name, "echo");

    const cursor = detail.lastSeq || 0;
    const echoSent = await request(app.base, "POST", `/api/bots/${id}/messages`, { text: "Please echo this" });
    const echoEvents = await waitForTurn(app.base, id, cursor, echoSent.turnId);
    // Real work opens with a short plan from the quick model, stored as an ack.
    const ack = echoEvents.find((event) => event.type === "ack");
    assert.equal(ack?.message.content, "Okay. I'll take care of that now.");
    assert.ok(echoEvents.indexOf(ack) < echoEvents.findIndex((event) => event.type === "tool"));
    detail = await request(app.base, "GET", `/api/bots/${id}`);
    assert.equal(detail.conversation.some((message) => message.kind === "ack" && message.content === ack.message.content), true);
    assert.match(detail.conversation.map((message) => message.content).join("\n"), /The tool said: echo: from mcp/);

    const diffCursor = detail.lastSeq || 0;
    const diffSent = await request(app.base, "POST", `/api/bots/${id}/messages`, { text: "Create hello.txt" });
    const diffEvents = await waitForTurn(app.base, id, diffCursor, diffSent.turnId);
    assert.equal(diffEvents.some((event) => event.type === "diff" && event.path === "hello.txt"), true);
    assert.equal(fs.readFileSync(path.join(home, "bots", id, "workspace", "hello.txt"), "utf8"), "hello from ravnir\n");
    detail = await request(app.base, "GET", `/api/bots/${id}`);
    assert.equal(detail.diffs.some((diff) => diff.path === "hello.txt"), true);

    const job = await request(app.base, "POST", `/api/bots/${id}/jobs`, {
      name: "Heartbeat",
      cron: "*/5 * * * *",
      prompt: "Say tick",
    });
    assert.equal(job.job.nextRunAt > Date.now(), true);
    const jobCursor = detail.lastSeq || 0;
    const jobSent = await request(app.base, "POST", `/api/bots/${id}/jobs/${job.job.id}/run`, {});
    const jobEvents = await waitForTurn(app.base, id, jobCursor, jobSent.turnId);
    assert.equal(jobEvents.some((event) => event.type === "turn.start" && event.source === "job"), true);
    detail = await request(app.base, "GET", `/api/bots/${id}`);
    assert.equal(detail.bot.jobs[0].lastStatus, "ok");

    await close(app.server);
    await sleep(300);
    app = await start(home);
    let restored = await request(app.base, "GET", `/api/bots/${id}`);
    for (let attempt = 0; attempt < 30 && restored.bot.connectors[0].status !== "connected"; attempt += 1) {
      await sleep(100);
      restored = await request(app.base, "GET", `/api/bots/${id}`);
    }
    assert.equal(restored.bot.name, "Tester");
    assert.equal(restored.bot.group, "QA");
    assert.deepEqual(restored.bot.avatar, look);
    assert.equal(restored.conversation.some((message) => message.content === "Hello there"), true);
    assert.equal(restored.diffs.some((diff) => diff.path === "hello.txt"), true);
    assert.equal(restored.bot.jobs[0].name, "Heartbeat");
    assert.equal(restored.bot.connectors[0].status, "connected");
  } finally {
    await close(app.server);
    await mock.close();
  }
});

test("bots message each other, create teammates, groups hold, and compaction archives", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-team-"));
  const mock = await startMock();
  let app = await start(home);
  try {
    const receiver = await request(app.base, "POST", "/api/bots", {
      name: "Receiver",
      group: "Work",
      job: "Answers teammate messages.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const sender = await request(app.base, "POST", "/api/bots", {
      name: "Sender",
      group: "Work",
      job: "Coordinates the team.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });

    const madeGroup = await request(app.base, "POST", "/api/groups", { name: "Operations" });
    assert.equal(madeGroup.group.name, "Operations");
    const renamed = await request(app.base, "PATCH", `/api/groups/${madeGroup.group.id}`, { name: "Ops" });
    assert.equal(renamed.group.name, "Ops");
    await request(app.base, "PATCH", `/api/bots/${sender.bot.id}`, { group: "Ops" });
    let state = await request(app.base, "GET", "/api/state");
    assert.equal(state.groups.some((group) => group.name === "Ops" && group.count === 1), true);
    const removed = await request(app.base, "DELETE", `/api/groups/${madeGroup.group.id}`);
    assert.equal(removed.moved, 1);

    const before = sender.lastSeq || 0;
    const sent = await request(app.base, "POST", `/api/bots/${sender.bot.id}/messages`, { text: "message teammate" });
    const events = await waitForTurn(app.base, sender.bot.id, before, sent.turnId);
    assert.equal(events.some((event) => event.type === "error"), false);
    const senderDetail = await request(app.base, "GET", `/api/bots/${sender.bot.id}`);
    assert.match(senderDetail.conversation.map((message) => message.content).join("\n"), /Reply from Receiver/);
    const receiverDetail = await request(app.base, "GET", `/api/bots/${receiver.bot.id}`);
    assert.match(receiverDetail.conversation.map((message) => message.content).join("\n"), /ping from sender/);

    const createCursor = senderDetail.lastSeq || 0;
    const created = await request(app.base, "POST", `/api/bots/${sender.bot.id}/messages`, { text: "create teammate" });
    await waitForTurn(app.base, sender.bot.id, createCursor, created.turnId);
    state = await request(app.base, "GET", "/api/state");
    const scoutTwo = state.bots.find((bot) => bot.name === "Scout Two");
    assert.ok(scoutTwo, "create_bot should add the bot");
    assert.equal(scoutTwo.group, "QA");

    for (let index = 0; index < 20; index += 1) {
      const detail = await request(app.base, "GET", `/api/bots/${receiver.bot.id}`);
      const cursor = detail.lastSeq || 0;
      const message = await request(app.base, "POST", `/api/bots/${receiver.bot.id}/messages`, { text: `note ${index}` });
      await waitForTurn(app.base, receiver.bot.id, cursor, message.turnId);
    }
    const compacted = await request(app.base, "POST", `/api/bots/${receiver.bot.id}/compact`, {});
    assert.equal(compacted.compacted, true);
    assert.ok(compacted.removed > 0);
    const afterCompact = await request(app.base, "GET", `/api/bots/${receiver.bot.id}`);
    assert.equal(afterCompact.conversation[0].kind, "summary");
    assert.equal(fs.existsSync(path.join(home, "bots", receiver.bot.id, "conversation-archive.ndjson")), true);
  } finally {
    await close(app.server);
    await mock.close();
  }
});

test("the bot browser signs in, keeps a session, and stays after a restart", async (t) => {
  if (!findChromium()) {
    t.skip("Playwright Chromium is not installed.");
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-browser-"));
  let app = await start(home);
  try {
    const created = await request(app.base, "POST", "/api/bots", {
      name: "Browser test",
      job: "Uses a browser.",
      model: { provider: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "unused" },
    });
    const id = created.bot.id;
    const navigated = await request(app.base, "POST", `/api/bots/${id}/browser`, {
      action: "navigate",
      url: `${app.base}/demo/login`,
    });
    assert.equal(navigated.running, true);
    assert.match(navigated.title, /Demo login/);

    const screenshot = await fetch(`${app.base}/api/bots/${id}/browser/screenshot`);
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get("content-type"), "image/png");
    assert.ok((await screenshot.arrayBuffer()).byteLength > 1000);

    const saved = await request(app.base, "POST", `/api/bots/${id}/vault`, {
      site: `${app.base}/demo/login`,
      username: "ada",
      password: "correct horse battery staple",
      label: "Demo",
    });
    assert.equal(JSON.stringify(saved).includes("correct horse battery staple"), false);
    const used = await request(app.base, "POST", `/api/bots/${id}/vault/${saved.entry.id}/use`, {});
    assert.equal(used.ok, true);

    const page = await request(app.base, "POST", `/api/bots/${id}/browser`, { action: "page" });
    assert.match(page.text, /Signed in as ada/);

    await close(app.server);
    await sleep(1200);
    app = await start(home);
    await request(app.base, "POST", `/api/bots/${id}/browser`, {
      action: "navigate",
      url: `${app.base}/demo/account`,
    });
    const after = await request(app.base, "POST", `/api/bots/${id}/browser`, { action: "page" });
    assert.match(after.text, /Signed in as ada/);
  } finally {
    await close(app.server);
    await sleep(500);
  }
});

async function start(home) {
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForTurn(base, id, after, turnId) {
  let cursor = after;
  const collected = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await sleep(100);
    const data = await request(base, "GET", `/api/bots/${id}/events?after=${cursor}`);
    cursor = data.cursor;
    collected.push(...data.events);
    if (data.events.some((event) => event.type === "turn.end" && (!turnId || event.turnId === turnId))) {
      return collected;
    }
  }
  throw new Error("The turn did not finish.");
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("RAVNIR_MODEL_URLS servers show up in discovery", async () => {
  const mock = await startMock();
  const previous = process.env.RAVNIR_MODEL_URLS;
  process.env.RAVNIR_MODEL_URLS = mock.url.replace(/\/v1$/, "");
  try {
    const result = await discoverServers();
    const found = result.servers.find((server) => server.source === "RAVNIR_MODEL_URLS");
    assert.ok(found, JSON.stringify(result.servers.map((server) => server.source)));
    assert.equal(found.baseUrl, mock.url);
    assert.equal(found.models.some((model) => model.id === "mock-model"), true);
  } finally {
    if (previous === undefined) delete process.env.RAVNIR_MODEL_URLS;
    else process.env.RAVNIR_MODEL_URLS = previous;
    await mock.close();
  }
});
