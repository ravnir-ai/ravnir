import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { readArchive } from "../server/compaction.js";
import { callBuiltinTool } from "../server/computer.js";
import { createApp } from "../server/index.js";
import { applyImport, parseExport, planImport } from "../server/importer.js";
import { buildSystemPrompt } from "../server/prompts.js";
import { SecretStore } from "../server/secrets.js";
import { createBot, readConversation, writeConversation } from "../server/state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-wave2-"));

async function start(options = {}) {
  const home = options.home || tempHome();
  const sent = [];
  const pushSender = async (subscription, body, pushOptions) => {
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body), options: pushOptions });
  };
  const server = createApp({ home, projectRoot, pushSender, ...options.app });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, home, sent, base: `http://127.0.0.1:${server.address().port}` };
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function api(base, method, pathname, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function raw(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function waitFor(check, { tries = 150, delay = 100 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting.");
}

async function waitForTurn(base, id, after, turnId) {
  let cursor = after;
  const collected = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const data = await api(base, "GET", `/api/bots/${id}/events?after=${cursor}`);
    cursor = data.cursor;
    collected.push(...data.events);
    if (data.events.some((event) => event.type === "turn.end" && (!turnId || event.turnId === turnId))) return collected;
  }
  throw new Error("The turn did not finish.");
}

function newBot(base, mock, name, extra = {}) {
  return api(base, "POST", "/api/bots", {
    name,
    job: `${name} does test jobs.`,
    model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    ...extra,
  });
}

function subscribe(base, name = "phone") {
  return api(base, "POST", "/api/push/subscribe", {
    subscription: { endpoint: `https://push.example.test/send/${name}`, keys: { p256dh: "BPublicKeyForTests", auth: "authSecretForTests" } },
    label: name,
  });
}

// Quiet hours default to 23:00-08:00; make them empty so the test runs at any hour.
function noQuietHours(base) {
  return api(base, "PUT", "/api/notify-settings", { quietStart: "00:00", quietEnd: "00:00" });
}

function localDay(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const b64 = (text) => Buffer.from(text).toString("base64");

function requestWithHeaders(base, method, pathname, headers, body) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("auth: pages redirect to /login, the API answers 401 without a Basic dialog, and a login cookie works", async () => {
  process.env.RAVNIR_USER = "owner";
  process.env.RAVNIR_PASSWORD = "wave2-password";
  const { server, base } = await start();
  try {
    const page = await fetch(`${base}/?view=today`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login?next=%2F%3Fview%3Dtoday");
    assert.equal((await fetch(`${base}/app.js`, { redirect: "manual" })).status, 302);
    assert.equal((await fetch(`${base}/avatar.js`, { redirect: "manual" })).status, 302);

    const anon = await fetch(`${base}/api/state`);
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get("www-authenticate"), null);
    assert.equal((await anon.json()).error, "Authentication required.");
    const post = await fetch(`${base}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(post.status, 401);

    const wrongBasic = await fetch(`${base}/api/state`, { headers: { authorization: `Basic ${b64("owner:nope")}` } });
    assert.equal(wrongBasic.status, 401);
    assert.match(wrongBasic.headers.get("www-authenticate") || "", /^Basic/);
    const goodBasic = await fetch(`${base}/api/state`, { headers: { authorization: `Basic ${b64("owner:wave2-password")}` } });
    assert.equal(goodBasic.status, 200);
    assert.equal((await goodBasic.json()).server.auth, true);

    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get("content-type"), /javascript/);
    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 200);
    assert.match(login.headers.get("content-type"), /text\/html/);
    assert.match(await login.text(), /Sign in to Ravnir/);
    for (const publicPath of ["/manifest.webmanifest", "/logo.png"]) assert.equal((await fetch(`${base}${publicPath}`)).status, 200, publicPath);
    assert.notEqual((await fetch(`${base}/api/bots/none/mcp`, { method: "POST", body: "{}" })).status, 401);

    const bad = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "wrong" }) });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("www-authenticate"), null);
    assert.equal(bad.headers.get("set-cookie"), null);

    const good = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "wave2-password" }) });
    assert.equal(good.status, 200);
    const setCookie = good.headers.get("set-cookie");
    // Plain http to 127.0.0.1 is local testing, so no Secure flag here.
    assert.match(setCookie, /^tb_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=7776000$/);
    const cookie = { cookie: setCookie.split(";")[0] };
    assert.equal((await fetch(`${base}/api/state`, { headers: cookie })).status, 200);
    assert.equal((await fetch(`${base}/`, { headers: cookie })).status, 200);
    const avatar = await fetch(`${base}/avatar.js`, { headers: cookie });
    assert.equal(avatar.status, 200);
    assert.match(avatar.headers.get("content-type"), /javascript/);
    const signedIn = await fetch(`${base}/login?next=%2F%3Fview%3Dtoday`, { headers: cookie, redirect: "manual" });
    assert.equal(signedIn.status, 302);
    assert.equal(signedIn.headers.get("location"), "/?view=today");

    // Any other host, or https behind a proxy, keeps Secure on.
    const body = JSON.stringify({ username: "owner", password: "wave2-password" });
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    const remote = await requestWithHeaders(base, "POST", "/api/login", { ...headers, host: "ravnir.example.ts.net" }, body);
    assert.equal(remote.status, 200);
    assert.match(remote.headers["set-cookie"][0], /; HttpOnly; Secure; SameSite=Lax/);
    const proxied = await requestWithHeaders(base, "POST", "/api/login", { ...headers, "x-forwarded-proto": "https" }, body);
    assert.match(proxied.headers["set-cookie"][0], /; Secure;/);

    const out = await fetch(`${base}/api/logout`, { method: "POST", headers: cookie });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie"), /^tb_session=; .*Max-Age=0$/);
    assert.equal((await fetch(`${base}/api/state`, { headers: cookie })).status, 401);
  } finally {
    delete process.env.RAVNIR_USER;
    delete process.env.RAVNIR_PASSWORD;
    await close(server);
  }
});

test("Always allow saves the suggested rule, for built-in commands and for OpenCode requests", async () => {
  const mock = await startMock();
  const { server, home, base } = await start();
  try {
    const created = await newBot(base, mock, "Careful");
    const id = created.bot.id;
    const botRef = server.services.state.bots.find((bot) => bot.id === id);
    const opencodeJson = () => JSON.parse(fs.readFileSync(path.join(home, "bots", id, "workspace", "opencode.json"), "utf8"));

    let cursor = created.lastSeq || 0;
    const first = await api(base, "POST", `/api/bots/${id}/messages`, { text: "run command: ls -la" });
    const pending = await waitFor(async () => (await api(base, "GET", "/api/approvals")).pending[0]);
    assert.equal(pending.rule, "ls *");
    assert.equal(pending.detail, "ls -la");
    const today = await api(base, "GET", "/api/today");
    assert.equal(today.approvals.pending[0].rule, "ls *");
    const detail = await api(base, "GET", `/api/bots/${id}`);
    assert.equal(detail.approvals[0].rule, "ls *");
    const events = await api(base, "GET", `/api/bots/${id}/events?after=${cursor}`);
    assert.equal(events.events.find((event) => event.type === "permission").rule, "ls *");

    await api(base, "POST", `/api/approvals/${pending.id}`, { decision: "always" });
    await waitForTurn(base, id, cursor, first.turnId);
    assert.deepEqual((await api(base, "GET", `/api/bots/${id}`)).bot.policy.allow, ["ls *"]);
    assert.equal(opencodeJson().permission.bash["ls *"], "allow");

    // The saved rule covers the next command: no approval is asked.
    cursor = (await api(base, "GET", `/api/bots/${id}`)).lastSeq;
    const second = await api(base, "POST", `/api/bots/${id}/messages`, { text: "run command: ls -l /" });
    const later = await waitForTurn(base, id, cursor, second.turnId);
    assert.equal(later.some((event) => event.type === "permission"), false);

    // An OpenCode bash request does the same, and rewrites the opencode.json permission block.
    const engine = server.services.engine;
    const waiting = engine.waitForDecision(botRef, "perm-bash", undefined, {
      kind: "opencode",
      title: "Run a terminal command",
      detail: "git status -s",
      permission: "bash",
      command: "git status -s",
    });
    const bash = await waitFor(async () => (await api(base, "GET", "/api/approvals")).pending.find((item) => item.id === "perm-bash"));
    assert.equal(bash.rule, "git status *");
    await api(base, "POST", "/api/approvals/perm-bash", { decision: "always" });
    assert.equal(await waiting, "always");
    assert.deepEqual(botRef.policy.allow, ["ls *", "git status *"]);
    assert.equal(opencodeJson().permission.bash["git status *"], "allow");
    assert.equal(opencodeJson().permission.external_directory, "ask");

    // An edit or external-directory request opens files for this bot.
    const files = engine.waitForDecision(botRef, "perm-files", undefined, {
      kind: "opencode",
      title: "Use files outside its workspace",
      detail: "/srv/data/report.txt",
      permission: "external_directory",
    });
    await waitFor(async () => (await api(base, "GET", "/api/approvals")).pending.find((item) => item.id === "perm-files"));
    await api(base, "POST", "/api/approvals/perm-files", { decision: "always" });
    assert.equal(await files, "always");
    assert.equal(botRef.policy.files, "allow");
    assert.equal(opencodeJson().permission.external_directory, "allow");

    // Allow once changes nothing.
    const once = engine.waitForDecision(botRef, "perm-once", undefined, { kind: "opencode", title: "Run a terminal command", detail: "uptime", permission: "bash", command: "uptime" });
    await waitFor(async () => (await api(base, "GET", "/api/approvals")).pending.find((item) => item.id === "perm-once"));
    await api(base, "POST", "/api/approvals/perm-once", { decision: "once" });
    assert.equal(await once, "once");
    assert.equal(botRef.policy.allow.includes("uptime"), false);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("an approval always pushes, even for an agent with notifications off", async () => {
  const mock = await startMock();
  const { server, base, sent } = await start();
  try {
    const created = await newBot(base, mock, "Quiet one");
    const id = created.bot.id;
    await api(base, "PATCH", `/api/bots/${id}`, { notify: "off" });
    await subscribe(base);
    const message = await api(base, "POST", `/api/bots/${id}/messages`, { text: "run command: echo approve-me" });
    const pending = await waitFor(async () => (await api(base, "GET", "/api/approvals")).pending[0]);
    const push = await waitFor(() => sent.find((item) => item.payload.kind === "approval"));
    assert.equal(push.payload.title, "Quiet one wants to run a terminal command");
    assert.equal(push.payload.body, "echo approve-me");
    assert.equal(push.payload.url, "/?view=today");
    assert.equal(push.options.urgency, "high");
    assert.equal(sent.length, 1);

    await api(base, "POST", `/api/approvals/${pending.id}`, { decision: "once" });
    await waitForTurn(base, id, 0, message.turnId);
    // Deciding it clears the notice from the unread count.
    const inbox = await api(base, "GET", "/api/notifications");
    assert.equal(inbox.items.find((item) => item.kind === "approval").read, true);
    // The reply stays silent because this agent is off, but the Inbox keeps it until the thread is opened.
    await waitFor(async () => (await api(base, "GET", "/api/notifications")).items.find((item) => item.kind === "turn"));
    const reply = (await api(base, "GET", "/api/notifications")).items.find((item) => item.kind === "turn");
    assert.equal(reply.suppressed, "bot-off");
    assert.equal(sent.length, 1);
    await api(base, "GET", `/api/bots/${id}/events?after=0&watching=1`);
    assert.equal((await api(base, "GET", "/api/notifications")).unread, 0);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("accepting a suggestion enqueues one turn through the chat queue, and a second tap does nothing", async () => {
  const mock = await startMock();
  const { server, base } = await start();
  try {
    const created = await newBot(base, mock, "Scout");
    const id = created.bot.id;
    const { proposals } = server.services;
    const open = proposals.create({ botId: id, botName: "Scout", title: "Rotate the logs", why: "They are 2 GB.", prompt: "Rotate the logs in the workspace." });
    const dismissed = proposals.create({ botId: id, botName: "Scout", title: "Tidy notes", why: "Messy.", prompt: "Tidy the notes." });

    const list = await api(base, "GET", "/api/proposals?status=open");
    assert.equal(list.items.length, 2);
    const today = await api(base, "GET", "/api/today");
    assert.deepEqual(today.proposals.map((item) => item.title).sort(), ["Rotate the logs", "Tidy notes"]);
    const state = await api(base, "GET", "/api/state");
    assert.equal(state.inbox.proposals, 2);

    assert.equal((await raw(base, "POST", `/api/proposals/${open.id}`, { decision: "maybe" })).status, 400);
    assert.equal((await raw(base, "POST", "/api/proposals/nope", { decision: "accept" })).status, 404);

    const cursor = created.lastSeq || 0;
    const accepted = await api(base, "POST", `/api/proposals/${open.id}`, { decision: "accept" });
    assert.equal(accepted.proposal.status, "accepted");
    assert.ok(accepted.turnId);
    const again = await raw(base, "POST", `/api/proposals/${open.id}`, { decision: "accept" });
    assert.equal(again.status, 409);
    await waitForTurn(base, id, cursor, accepted.turnId);

    const conversation = (await api(base, "GET", `/api/bots/${id}`)).conversation;
    const approved = conversation.filter((message) => message.role === "user" && message.content.startsWith("Approved suggestion: Rotate the logs"));
    assert.equal(approved.length, 1);
    assert.equal(approved[0].content, "Approved suggestion: Rotate the logs\n\nRotate the logs in the workspace.");
    assert.equal(approved[0].source, "proposal");

    const dismissal = await api(base, "POST", `/api/proposals/${dismissed.id}`, { decision: "dismiss" });
    assert.equal(dismissal.proposal.status, "dismissed");
    assert.equal(dismissal.turnId, "");
    assert.equal((await api(base, "GET", "/api/proposals?status=open")).items.length, 0);
    assert.equal(conversation.some((message) => message.content?.includes("Tidy the notes.")), false);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("a finished job notifies: routine, reminder, failure; a watched chat turn stays quiet", async () => {
  const mock = await startMock();
  const { server, base, sent } = await start();
  try {
    await noQuietHours(base);
    await subscribe(base);
    const created = await newBot(base, mock, "Clerk");
    const id = created.bot.id;

    const routine = (await api(base, "POST", `/api/bots/${id}/jobs`, { name: "Morning check", prompt: "Say the deploy is fine.", cron: "0 8 * * 1-5" })).job;
    assert.equal(routine.createdBy, "user");
    assert.equal(routine.schedule, "Weekdays at 08:00");
    await api(base, "POST", `/api/bots/${id}/jobs/${routine.id}/run`);
    const push = await waitFor(() => sent.find((item) => item.payload.kind === "routine"));
    assert.equal(push.payload.title, "Clerk: Morning check");
    assert.match(push.payload.body, /Mock reply: Say the deploy is fine\./);
    assert.equal(push.payload.url, `/?bot=${id}`);
    assert.equal(push.payload.botId, id);

    const at = new Date(Date.now() + 3_600_000).toISOString();
    const once = (await api(base, "POST", `/api/bots/${id}/jobs`, { name: "Call the bank", prompt: "Tell the user to call the bank.", at })).job;
    assert.equal(once.cron, "");
    assert.match(once.schedule, /^Once on /);
    assert.equal(once.nextRunAt, Date.parse(at));
    await api(base, "POST", `/api/bots/${id}/jobs/${once.id}/run`);
    const reminder = await waitFor(() => sent.find((item) => item.payload.kind === "reminder"));
    assert.equal(reminder.payload.title, "Clerk: Call the bank");

    // A job with notify off does not buzz the phone.
    const muted = (await api(base, "POST", `/api/bots/${id}/jobs`, { name: "Muted", prompt: "Do it quietly.", cron: "0 9 * * *", notify: false })).job;
    await api(base, "POST", `/api/bots/${id}/jobs/${muted.id}/run`);
    await waitFor(async () => (await api(base, "GET", `/api/bots/${id}`)).bot.jobs.find((job) => job.id === muted.id).lastStatus === "ok");
    const count = sent.length;

    // A chat turn the user is watching in a focused window stays quiet.
    const viewer = setInterval(() => api(base, "GET", `/api/bots/${id}/events?after=0&watching=1`).catch(() => {}), 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const chat = await api(base, "POST", `/api/bots/${id}/messages`, { text: "hello there" });
    await waitForTurn(base, id, 0, chat.turnId);
    clearInterval(viewer);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sent.length, count);
    assert.equal(sent.some((item) => item.payload.kind === "turn"), false);

    // A job that fails pushes a high priority failure.
    const broken = await api(base, "POST", "/api/bots", { name: "Broken", job: "Cannot reach its model.", model: { provider: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "none" } });
    const failing = (await api(base, "POST", `/api/bots/${broken.bot.id}/jobs`, { name: "Nightly", prompt: "Anything.", cron: "0 3 * * *" })).job;
    await api(base, "POST", `/api/bots/${broken.bot.id}/jobs/${failing.id}/run`);
    const failure = await waitFor(() => sent.find((item) => item.payload.kind === "failure"));
    assert.equal(failure.payload.title, "Broken: Nightly failed");
    assert.equal(failure.options.urgency, "high");
    assert.ok(failure.payload.body.length > 0);

    const inbox = await api(base, "GET", "/api/notifications");
    assert.equal(inbox.unread >= 3, true);
    const kinds = new Set(inbox.items.map((item) => item.kind));
    assert.equal(kinds.has("routine") && kinds.has("reminder") && kinds.has("failure"), true);
    assert.equal(inbox.items.some((item) => item.title === "Muted"), false);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("a chat reply reaches the phone only when no focused window is watching", async () => {
  const mock = await startMock();
  const { server, base, sent } = await start({ app: { watchMs: 500 } });
  try {
    await noQuietHours(base);
    await subscribe(base);
    const created = await newBot(base, mock, "Talker");
    const id = created.bot.id;

    const viewer = setInterval(() => api(base, "GET", `/api/bots/${id}/events?after=0&watching=1`).catch(() => {}), 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const watched = await api(base, "POST", `/api/bots/${id}/messages`, { text: "first question" });
    await waitForTurn(base, id, 0, watched.turnId);
    clearInterval(viewer);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sent.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 600));
    const away = await api(base, "POST", `/api/bots/${id}/messages`, { text: "second question" });
    await waitForTurn(base, id, 0, away.turnId);
    const push = await waitFor(() => sent.find((item) => item.payload.kind === "turn"));
    assert.equal(push.payload.title, "Talker is back");
    assert.match(push.payload.body, /Mock reply: second question/);
    assert.equal(push.payload.url, `/?bot=${id}`);

    assert.equal((await raw(base, "PATCH", `/api/bots/${id}`, { notify: "loud" })).status, 400);
    await api(base, "PATCH", `/api/bots/${id}`, { notify: "off" });
    const muted = await api(base, "POST", `/api/bots/${id}/messages`, { text: "third question" });
    await waitForTurn(base, id, 0, muted.turnId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sent.filter((item) => item.payload.kind === "turn").length, 1);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("notify_user and propose_task work as tools, and the MCP endpoint lists every new tool", async () => {
  const mock = await startMock();
  const { server, home, base, sent } = await start();
  try {
    await noQuietHours(base);
    await subscribe(base);
    const created = await newBot(base, mock, "Watcher");
    const id = created.bot.id;
    const { notifications, proposals, state } = server.services;
    const bot = state.bots.find((item) => item.id === id);
    const ctx = { bot, notifications, proposals, home, save: () => {} };

    const notified = await callBuiltinTool("notify_user", { title: "Build finished", body: "All 40 tests pass.", priority: "high" }, ctx);
    assert.match(notified.text, /Sent to the user's phone/);
    const push = sent.find((item) => item.payload.kind === "message");
    assert.equal(push.payload.title, "Watcher: Build finished");
    assert.equal(push.payload.url, `/?bot=${id}`);
    assert.equal(push.options.urgency, "high");
    for (let i = 0; i < 5; i += 1) await callBuiltinTool("notify_user", { title: `Note ${i}`, body: "x" }, ctx);
    await assert.rejects(() => callBuiltinTool("notify_user", { title: "One too many", body: "x" }, ctx), /last hour/);

    const proposed = await callBuiltinTool("propose_task", { title: "Archive old logs", why: "They are large.", prompt: "Archive logs older than 30 days." }, ctx);
    assert.match(proposed.text, /Do not start the work/);
    const open = proposals.list({ status: "open" });
    assert.equal(open.length, 1);
    const card = sent.find((item) => item.payload.kind === "proposal");
    assert.equal(card.payload.url, "/?view=today");
    assert.equal(card.payload.title, "Watcher: Archive old logs");
    const repeat = await callBuiltinTool("propose_task", { title: "archive old logs", why: "Again.", prompt: "Again." }, ctx);
    assert.match(repeat.text, /already waiting/);
    assert.equal(proposals.list({ status: "open" }).length, 1);
    for (let i = 0; i < 4; i += 1) await callBuiltinTool("propose_task", { title: `Idea ${i}`, why: "w", prompt: "p" }, ctx);
    await assert.rejects(() => callBuiltinTool("propose_task", { title: "Sixth idea", why: "w", prompt: "p" }, ctx), /5 suggestions/);

    // The OpenCode bots reach the same tools through the per-bot MCP endpoint.
    const token = new SecretStore(home).get(`bot:${id}:mcpToken`, "");
    assert.ok(token);
    const listed = await fetch(`${base}/api/bots/${id}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    for (const name of ["update_job", "create_job", "list_jobs", "delete_job", "notify_user", "propose_task", "search_history", "read_history"]) {
      assert.equal(names.includes(name), true, `${name} is on the MCP endpoint`);
    }
    const called = await fetch(`${base}/api/bots/${id}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_jobs", arguments: {} } }),
    });
    assert.equal((await called.json()).result.content[0].text, "No scheduled jobs.");
    const unauthorized = await fetch(`${base}/api/bots/${id}/mcp`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("the system prompt asks for proactive behavior above the Now line, and names the history tools", () => {
  const bot = createBot({ name: "Prompted" });
  const prompt = buildSystemPrompt(bot, { jobs: [] });
  const proactive = prompt.indexOf("Being proactive");
  assert.ok(proactive > 0);
  assert.match(prompt, /propose_task/);
  assert.match(prompt, /notify_user/);
  assert.match(prompt, /Never start the work before they accept it/);
  assert.match(prompt, /search_history/);
  assert.match(prompt, /read_history/);
  const lines = prompt.trimEnd().split("\n");
  assert.match(lines.at(-1), /^Now: /);
  assert.equal(prompt.lastIndexOf("Now: ") > proactive, true);
  assert.equal(prompt.includes("—") || prompt.includes("–"), false);
});

test("schedule preview, one-time jobs, notify settings, push devices and the inbox routes", async () => {
  const mock = await startMock();
  const { server, base } = await start();
  try {
    const preview = await api(base, "POST", "/api/schedule/preview", { cron: "30 7 * * 1-5" });
    assert.equal(preview.text, "Weekdays at 07:30");
    assert.ok(preview.nextRunAt > Date.now());
    const at = Date.now() + 5 * 3_600_000;
    const onceText = await api(base, "POST", "/api/schedule/preview", { at: new Date(at).toISOString() });
    assert.match(onceText.text, /^Once on /);
    assert.equal(onceText.nextRunAt, at);
    for (const bad of [{ cron: "nope" }, { at: "2020-01-01T00:00:00Z" }, {}, { cron: "0 8 * * *", at }]) {
      const result = await raw(base, "POST", "/api/schedule/preview", bad);
      assert.equal(result.status, 400, JSON.stringify(bad));
      assert.ok(result.data.error);
    }

    const created = await newBot(base, mock, "Planner");
    const id = created.bot.id;
    assert.equal(created.bot.notify, "important");
    assert.equal((await raw(base, "POST", `/api/bots/${id}/jobs`, { name: "Bad", prompt: "x", cron: "nope" })).status, 400);
    const job = (await api(base, "POST", `/api/bots/${id}/jobs`, { name: "Dentist", prompt: "Remind me.", at, createdBy: "bot" })).job;
    assert.equal(job.createdBy, "user");
    assert.equal(job.at, at);
    assert.equal(job.nextRunAt, job.at);
    assert.equal(job.done, false);
    const state = await api(base, "GET", "/api/state");
    const row = state.bots.find((bot) => bot.id === id);
    assert.match(row.activity, /^Next job: Once on /);

    const today = await api(base, "GET", `/api/today?day=${localDay(job.at)}`);
    const upcoming = today.upcoming.find((item) => item.jobId === job.id);
    assert.equal(upcoming.at, job.at);
    assert.match(upcoming.schedule, /^Once on /);

    // It survives a restart as an armed one-time job.
    const { botId } = { botId: id };
    const stored = server.services.state.bots.find((bot) => bot.id === botId).jobs[0];
    assert.equal(stored.cron, "");

    const defaults = await api(base, "GET", "/api/notify-settings");
    assert.deepEqual(defaults, { enabled: true, quietStart: "23:00", quietEnd: "08:00" });
    assert.equal((await raw(base, "PUT", "/api/notify-settings", { quietStart: "25:99" })).status, 400);
    assert.equal((await raw(base, "PUT", "/api/notify-settings", { enabled: "yes" })).status, 400);
    const saved = await api(base, "PUT", "/api/notify-settings", { enabled: false, quietStart: "22:30", quietEnd: "7:15" });
    assert.deepEqual(saved, { enabled: false, quietStart: "22:30", quietEnd: "07:15" });
    assert.deepEqual(await api(base, "GET", "/api/notify-settings"), saved);

    const key = await api(base, "GET", "/api/push/key");
    assert.match(key.key, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal((await raw(base, "POST", "/api/push/subscribe", { subscription: { endpoint: "http://insecure.test", keys: { p256dh: "a", auth: "b" } } })).status, 400);
    assert.equal((await api(base, "POST", "/api/push/test", {})).ok, false);
    const { id: deviceId } = await subscribe(base, "laptop");
    const devices = await api(base, "GET", "/api/push/devices");
    assert.equal(devices.devices.length, 1);
    assert.equal(devices.devices[0].id, deviceId);
    assert.equal("keys" in devices.devices[0], false);
    const test = await api(base, "POST", "/api/push/test", {});
    assert.equal(test.ok, true);
    assert.equal(test.sent, 1);
    assert.equal((await api(base, "POST", "/api/push/unsubscribe", { endpoint: "https://push.example.test/send/laptop" })).ok, true);
    assert.equal((await api(base, "GET", "/api/push/devices")).devices.length, 0);

    const note = await server.services.notifications.notify({ botId: id, kind: "message", title: "Hello", body: "Plain body", url: `/?bot=${id}` });
    assert.equal((await api(base, "GET", "/api/notifications")).unread, 1);
    assert.equal((await api(base, "GET", "/api/state")).inbox.unread, 1);
    await api(base, "POST", "/api/notifications/read", { ids: [note.id] });
    assert.equal((await api(base, "GET", "/api/notifications")).unread, 0);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("static scripts are served the same way as app.js", async () => {
  const { server, base } = await start();
  try {
    for (const name of ["/app.js", "/avatar.js", "/sw.js"]) {
      const response = await fetch(`${base}${name}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get("content-type"), /^text\/javascript/);
    }
    assert.equal((await fetch(`${base}/no-such-file.js`)).status, 404);
    assert.equal((await fetch(`${base}/..%2Fserver%2Findex.js`)).status, 404);
    assert.equal((await fetch(`${base}/login.html`)).status, 404);
  } finally {
    await close(server);
  }
});

test("a turn that ends after a compaction appends to the thread on disk instead of overwriting it", async () => {
  const mock = await startMock();
  const { server, home, base } = await start();
  try {
    const created = await newBot(base, mock, "Racer");
    const id = created.bot.id;
    const bot = server.services.state.bots.find((item) => item.id === id);
    const old = Array.from({ length: 30 }, (_, index) => ({
      id: `old-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `old message ${index}`,
      at: 1000 + index,
    }));
    writeConversation(home, bot, old);

    const sent = await api(base, "POST", `/api/bots/${id}/messages`, { text: "run command: echo race-check" });
    const pending = await waitFor(async () => (await api(base, "GET", "/api/approvals")).pending[0]);

    // While the turn waits for the user, a compaction finishes: the thread is now a summary plus the tail.
    const disk = readConversation(home, bot);
    const tail = disk.slice(-2);
    assert.equal(tail[0].role, "user");
    writeConversation(home, bot, [{ id: "summary-1", role: "assistant", kind: "summary", content: "Everything old was summarized.", at: Date.now() }, ...tail]);

    await api(base, "POST", `/api/approvals/${pending.id}`, { decision: "once" });
    await waitForTurn(base, id, 0, sent.turnId);

    const after = readConversation(home, bot);
    assert.equal(after[0].id, "summary-1");
    assert.equal(after.some((message) => String(message.id).startsWith("old-")), false);
    assert.equal(after.filter((message) => message.id === tail[0].id).length, 1);
    assert.equal(after.filter((message) => message.role === "tool").length, 1);
    assert.equal(after.at(-1).role, "assistant");
    assert.match(after.at(-1).content, /race-check/);
    assert.equal(after.length, 6, "summary, user, ack, tool call, tool result, final reply");
  } finally {
    await close(server);
    await mock.close();
  }
});

test("messages pushed off the end of the thread are archived with the compaction line format", () => {
  const home = tempHome();
  const bot = createBot({ name: "Archivist" });
  fs.mkdirSync(path.join(home, "bots", bot.id), { recursive: true });
  const messages = Array.from({ length: 405 }, (_, index) => ({ id: `m-${index}`, role: index % 2 ? "assistant" : "user", content: `message number ${index}`, at: 1000 + index }));
  writeConversation(home, bot, messages);
  const kept = readConversation(home, bot);
  assert.equal(kept.length, 400);
  assert.equal(kept[0].id, "m-5");
  const archived = readArchive(home, bot);
  assert.deepEqual(archived.map((row) => row.id), ["m-0", "m-1", "m-2", "m-3", "m-4"]);
  assert.equal(archived[0].content, "message number 0");
  assert.equal(typeof archived[0].archivedAt, "number");
  // Writing the same 400 again archives nothing new.
  writeConversation(home, bot, kept);
  assert.equal(readArchive(home, bot).length, 5);
});

const EXPORT_ALPHA = {
  name: "Alpha",
  job: "Runs the morning brief.",
  instructions: "Be brief. Answer in Spanish.",
  memories: ["The user's flight is on Friday.", "The user prefers short answers.", "the user prefers short answers."],
  routines: [
    { name: "Morning brief", cron: "30 7 * * 1-5", schedule: "Weekdays at 7:30", prompt: "Summarize my calendar.", enabled: true },
    { name: "Broken schedule", cron: "every morning", schedule: "every morning", prompt: "Say hi.", enabled: true },
    { name: "No cron", schedule: "sometime", prompt: "Do a thing.", enabled: false },
  ],
  connectors: ["Gmail", "Calendar"],
  notes: "Uses the calendar daily.",
};
const EXPORT_BETA = { name: "Beta", job: "Watches prices.", instructions: "Check prices.", memories: [], routines: [{ name: "Price check", cron: "0 * * * *", prompt: "Check prices.", enabled: true }], connectors: [], notes: "" };

test("parseExport reads one object, arrays, fenced blocks in prose, trailing commas, and nothing else", () => {
  const single = parseExport(JSON.stringify(EXPORT_ALPHA));
  assert.equal(single.length, 1);
  assert.equal(single[0].name, "Alpha");
  assert.deepEqual(single[0].memories, ["The user's flight is on Friday.", "The user prefers short answers."]);
  assert.equal(single[0].routines.length, 3);
  assert.deepEqual(single[0].connectors, ["Gmail", "Calendar"]);

  assert.equal(parseExport(JSON.stringify([EXPORT_ALPHA, EXPORT_BETA])).length, 2);
  assert.equal(parseExport(JSON.stringify({ bots: [EXPORT_ALPHA, EXPORT_BETA] })).length, 2);

  const prose = `Sure, here is my export:\n\n\`\`\`json\n${JSON.stringify(EXPORT_ALPHA, null, 2)}\n\`\`\`\n\nAnd the second one:\n\n\`\`\`\n${JSON.stringify(EXPORT_BETA, null, 2)}\n\`\`\`\nHope that helps! [1] {not json}`;
  assert.deepEqual(parseExport(prose).map((item) => item.name), ["Alpha", "Beta"]);

  const trailing = '```json\n{ "name": "Gamma", "job": "x", "instructions": "y", "memories": ["a",], }\n```';
  assert.deepEqual(parseExport(trailing)[0].memories, ["a"]);

  const fenceInside = `Here:\n\`\`\`json\n${JSON.stringify({ name: "Delta", instructions: "Use fences like:\n```\ncode\n```\nand [brackets] {too}." })}\n\`\`\``;
  assert.match(parseExport(fenceInside)[0].instructions, /code/);

  // A routine on its own, or a reply with no export, is not a bot.
  assert.throws(() => parseExport(JSON.stringify({ name: "Morning", cron: "0 8 * * *", prompt: "x" })), /could not find/);
  assert.throws(() => parseExport("I cannot export that, sorry."), /could not find/);
  assert.throws(() => parseExport("   "), /Paste the export/);
});

test("import: preview, apply, update merge, identical instructions skipped, routines paused, bad cron warned", async () => {
  const mock = await startMock();
  const { server, base, home } = await start();
  try {
    const prompt = await api(base, "GET", "/api/import/prompt");
    assert.match(prompt.prompt, /ONE JSON code block/);
    assert.match(prompt.prompt, /Europe\/Madrid/);
    assert.match(prompt.prompt, /Never include passwords, tokens, API keys/);
    assert.equal(prompt.prompt.includes("—") || prompt.prompt.includes("–"), false);

    const main = await newBot(base, mock, "Chief");
    await api(base, "PATCH", `/api/bots/${main.bot.id}`, { main: true });
    // Alpha already exists with the very instructions the export carries.
    const alpha = await newBot(base, mock, "alpha", { prompt: "Be brief. Answer in Spanish." });
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify([EXPORT_ALPHA, EXPORT_BETA], null, 2)}\n\`\`\``;

    const botCount = server.services.state.bots.length;
    const preview = await api(base, "POST", "/api/import/preview", { text });
    assert.equal(preview.items.length, 2);
    const [pa, pb] = preview.items;
    assert.equal(pa.action, "update");
    assert.equal(pa.botId, alpha.bot.id);
    assert.equal(pa.instructions, true, "the connectors and notes block is still new");
    assert.equal(pa.instructionsAction, "append");
    assert.equal(pa.memories, 2);
    assert.equal(pa.routines, 1);
    assert.equal(pa.connectors, 2);
    assert.equal(pa.warnings.some((warning) => /Broken schedule/.test(warning)), true);
    assert.equal(pa.warnings.some((warning) => /No cron/.test(warning)), true);
    assert.equal(pb.action, "create");
    assert.equal(pb.botId, "");
    assert.equal(pb.instructionsAction, "set");
    assert.equal((await raw(base, "POST", "/api/import/preview", { text: "no json here" })).status, 400);
    // Preview changes nothing.
    assert.equal(server.services.state.bots.length, botCount);

    const applied = await api(base, "POST", "/api/import/apply", { text });
    assert.equal(applied.created, 1);
    assert.equal(applied.updated, 1);
    assert.equal(applied.memories, 2);
    assert.equal(applied.routines, 2);
    assert.equal(applied.warnings.some((warning) => /Broken schedule/.test(warning)), true);

    const state = server.services.state;
    const updated = state.bots.find((bot) => bot.id === alpha.bot.id);
    // Identical instructions are not duplicated; the notes and connectors are added, never installed.
    assert.equal(updated.prompt.split("Be brief. Answer in Spanish.").length, 2);
    assert.match(updated.prompt, /Notes from the Grok Bot export/);
    assert.match(updated.prompt, /Gmail, Calendar/);
    assert.match(updated.prompt, /Uses the calendar daily\./);
    assert.equal(updated.connectors.some((connector) => /gmail/i.test(connector.name)), false);
    assert.deepEqual(updated.memory.map((item) => item.text), ["The user's flight is on Friday.", "The user prefers short answers."]);
    assert.equal(updated.memory[0].source, "import");
    assert.equal(updated.jobs.length, 1);
    assert.equal(updated.jobs[0].name, "Morning brief");
    assert.equal(updated.jobs[0].enabled, false);
    assert.equal(updated.jobs[0].createdBy, "import");
    assert.equal(updated.jobs[0].cron, "30 7 * * 1-5");

    const beta = state.bots.find((bot) => bot.name === "Beta");
    assert.ok(beta);
    assert.equal(beta.prompt, "Check prices.");
    assert.equal(beta.job, "Watches prices.");
    assert.equal(beta.jobs[0].enabled, false);
    assert.equal(beta.model.model, "mock-model", "a new bot starts on the main bot's model");
    assert.equal(fs.existsSync(path.join(home, "bots", beta.id, "workspace")), true);
    assert.equal((await api(base, "GET", `/api/bots/${beta.id}`)).conversation[0].kind, "intro");

    // Running it again changes nothing.
    const again = await api(base, "POST", "/api/import/apply", { text });
    assert.equal(again.created, 0);
    assert.equal(again.memories, 0);
    assert.equal(again.routines, 0);
    assert.equal(state.bots.find((bot) => bot.id === alpha.bot.id).prompt, updated.prompt);
    assert.equal(state.bots.find((bot) => bot.id === alpha.bot.id).jobs.length, 1);

    // Different instructions are appended under a dated heading, with enableRoutines on.
    const changed = JSON.stringify({ ...EXPORT_BETA, instructions: "Check prices twice a day.", routines: [{ name: "Evening check", cron: "0 20 * * *", prompt: "Check again.", enabled: true }, { name: "Off one", cron: "0 21 * * *", prompt: "Skip.", enabled: false }] });
    const third = await api(base, "POST", "/api/import/apply", { text: changed, enableRoutines: true });
    assert.equal(third.created, 0);
    assert.equal(third.updated, 1);
    const merged = state.bots.find((bot) => bot.name === "Beta");
    assert.match(merged.prompt, /^Check prices\.\n\nImported from Grok Bot \(\d{4}-\d{2}-\d{2}\):\nCheck prices twice a day\.$/);
    const evening = merged.jobs.find((job) => job.name === "Evening check");
    assert.equal(evening.enabled, true);
    assert.equal(merged.jobs.find((job) => job.name === "Off one").enabled, false);
    assert.equal(merged.jobs.find((job) => job.name === "Price check").enabled, false);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("import plans and applies without a server: empty instructions are set, secrets are not imported", async () => {
  const state = { bots: [{ id: "b1", name: "Blank", prompt: "", memory: [], jobs: [] }] };
  const items = parseExport(JSON.stringify({
    name: "Blank",
    instructions: "Do the thing.",
    memories: ["The deploy key is sk-abcdefghijklmnopqrstuvwxyz123456", "Lunch is at 14:00."], // check-public: allow token (fake secret for a test)
    routines: [],
    connectors: [],
    notes: "",
  }));
  const plan = planImport(state, items);
  assert.equal(plan[0].instructionsAction, "set");
  assert.equal(plan[0].memories, 1);
  assert.equal(plan[0].warnings.some((warning) => /password or key/.test(warning)), true);
  const written = [];
  const result = await applyImport({
    state,
    items,
    aiMemory: { available: true },
    writeMemory: async (_info, page) => { written.push(page); },
  });
  assert.equal(state.bots[0].prompt, "Do the thing.");
  assert.equal(result.memories, 1);
  assert.equal(written.length, 1);
  assert.match(written[0].path, /^imports\/grok-bot\/blank-[0-9a-f]{10}\.md$/);
  assert.match(written[0].body, /Lunch is at 14:00\./);
  assert.deepEqual(state.bots[0].memory.map((item) => item.text), ["Lunch is at 14:00."], "the bot keeps its own copy of what ai-memory took");
  assert.equal(result.warnings.some((warning) => /password or key/.test(warning)), true);

  // When ai-memory fails, the memory falls back to the bot's own.
  const failing = { bots: [{ id: "b2", name: "Other", prompt: "x", memory: [], jobs: [] }] };
  const fallback = await applyImport({
    state: failing,
    items: parseExport(JSON.stringify({ name: "Other", memories: ["Fact one."] })),
    aiMemory: { available: true },
    writeMemory: async () => { throw new Error("down"); },
  });
  assert.equal(fallback.memories, 1);
  assert.equal(failing.bots[0].memory[0].text, "Fact one.");
});
