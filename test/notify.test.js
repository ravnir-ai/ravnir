import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { createAuth, parseCookies } from "../server/auth.js";
import { NotificationCenter, inQuietHours, plainText } from "../server/notifications.js";
import { ProposalStore, proactiveToolDefinitions } from "../server/proposals.js";
import { PushService, pushSubject } from "../server/push.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-notify-"));
}

function fakeSubscription(name = "a") {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://push.example.test/send/${name}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
  };
}

function setup({ bots = {}, settings = {}, subscribers = 1, now } = {}) {
  const home = tempHome();
  const sent = [];
  const push = new PushService({ home, sender: async (subscription, body, options) => { sent.push({ subscription, payload: JSON.parse(body), options }); } });
  for (let i = 0; i < subscribers; i += 1) push.subscribe(fakeSubscription(`dev${i}`), { label: `Device ${i}` });
  const state = { settings: { enabled: true, quietStart: "23:00", quietEnd: "08:00", ...settings } };
  const center = new NotificationCenter({
    home,
    push,
    getSettings: () => state.settings,
    getBot: (id) => bots[id] || { id, name: id },
    now,
  });
  return { home, push, center, sent, state };
}

const at = (hour, minute = 0) => new Date(2026, 9, 23, hour, minute).getTime();
const ping = (center, kind, extra = {}) => center.notify({ botId: "b1", botName: "Scout", kind, title: "Done", body: "All good", ...extra });

test("push service keeps VAPID keys and subscriptions private, never lists keys", async () => {
  const home = tempHome();
  const push = new PushService({ home, sender: async () => {} });
  const key = push.publicKey();
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(new PushService({ home }).publicKey(), key);
  const { id } = push.subscribe(fakeSubscription(), { label: "iPhone", userAgent: "Safari" });
  assert.equal(push.subscribe(fakeSubscription(), { label: "iPhone again" }).id, id);
  const devices = push.list();
  assert.equal(devices.length, 1);
  assert.deepEqual(Object.keys(devices[0]).sort(), ["createdAt", "failures", "id", "label", "lastError", "lastOkAt", "userAgent"]);
  assert.equal(devices[0].label, "iPhone again");
  assert.throws(() => push.subscribe({ endpoint: "http://insecure.test", keys: { p256dh: "a", auth: "b" } }), /not valid/);
  assert.throws(() => push.subscribe({ endpoint: "https://x.test" }), /not valid/);
  for (const name of ["vapid.json", "subscriptions.json"]) {
    assert.equal(fs.statSync(path.join(home, "push", name)).mode & 0o777, 0o600);
  }
  assert.equal(new PushService({ home }).list().length, 1);
  assert.equal(push.unsubscribe(fakeSubscription().endpoint), true);
  assert.equal(push.unsubscribe(fakeSubscription().endpoint), false);
  assert.equal(push.list().length, 0);
});

test("push send builds real web-push requests, maps urgency, and drops 404 and 410 subscriptions", async () => {
  const home = tempHome();
  const calls = [];
  const gone = new Map([["https://push.example.test/send/gone", 410], ["https://push.example.test/send/missing", 404], ["https://push.example.test/send/flaky", 503]]);
  const push = new PushService({
    home,
    sender: async (subscription, body, options) => {
      const request = webpush.generateRequestDetails(subscription, body, options);
      calls.push({ headers: request.headers, options });
      const status = gone.get(subscription.endpoint);
      if (status) throw Object.assign(new Error("push failed"), { statusCode: status });
    },
  });
  for (const name of ["ok", "gone", "missing", "flaky"]) push.subscribe(fakeSubscription(name), { label: name });
  const result = await push.send({ title: "Hi" }, { priority: "urgent", ttl: 60 });
  assert.deepEqual(result, { sent: 1, failed: 1, removed: 2 });
  assert.deepEqual(push.list().map((item) => [item.label, item.failures]).sort(), [["flaky", 1], ["ok", 0]]);
  assert.equal(push.list().find((item) => item.label === "ok").lastOkAt > 0, true);
  assert.ok(calls.every((call) => call.headers.Urgency === "high" && call.headers.TTL === 60 && /^vapid /.test(call.headers.Authorization)));
  const normal = await push.send({ title: "Hi" }, { priority: "low" });
  assert.equal(normal.sent, 1);
  assert.equal(calls.at(-1).headers.Urgency, "low");
  assert.deepEqual(await new PushService({ home: tempHome() }).send({ title: "none" }), { sent: 0, failed: 0, removed: 0 });
});

test("notification levels decide what pushes", async () => {
  const bots = { all: { id: "all", name: "A", notify: "all" }, imp: { id: "imp", name: "I" }, off: { id: "off", name: "O", notify: "off" } };
  const { center, sent } = setup({ bots, now: () => at(12) });
  const kinds = ["turn", "routine", "reminder", "proposal", "message", "failure", "approval"];
  const outcome = {};
  for (const botId of ["all", "imp", "off"]) {
    outcome[botId] = {};
    for (const kind of kinds) {
      const record = await center.notify({ botId, botName: bots[botId].name, kind, title: kind, body: "x" });
      outcome[botId][kind] = record.pushed ? "pushed" : record.suppressed;
    }
  }
  assert.deepEqual(outcome.all, Object.fromEntries(kinds.map((kind) => [kind, "pushed"])));
  assert.deepEqual(outcome.imp, Object.fromEntries(kinds.map((kind) => [kind, "pushed"])));
  assert.deepEqual(outcome.off, { ...Object.fromEntries(kinds.map((kind) => [kind, "bot-off"])), approval: "pushed" });
  assert.equal(sent.length, 7 + 7 + 1);
});

test("quiet hours, wrapping midnight, block everything except approvals and urgent", async () => {
  const clock = { time: at(23, 30) };
  const { center, sent, state } = setup({ now: () => clock.time });
  assert.equal((await ping(center, "routine")).suppressed, "quiet");
  assert.equal((await ping(center, "failure", { priority: "high" })).suppressed, "quiet");
  assert.equal((await ping(center, "message", { priority: "urgent" })).pushed, true);
  assert.equal((await ping(center, "approval", { priority: "high" })).pushed, true);
  clock.time = at(3);
  assert.equal((await ping(center, "reminder")).suppressed, "quiet");
  clock.time = at(7, 59);
  assert.equal((await ping(center, "reminder")).suppressed, "quiet");
  clock.time = at(8);
  assert.equal((await ping(center, "reminder")).pushed, true);
  clock.time = at(22, 59);
  assert.equal((await ping(center, "reminder")).pushed, true);
  state.settings = { enabled: true, quietStart: "13:00", quietEnd: "15:30" };
  clock.time = at(14);
  assert.equal((await ping(center, "reminder")).suppressed, "quiet");
  clock.time = at(15, 30);
  assert.equal((await ping(center, "reminder")).pushed, true);
  assert.equal(sent.length, 5);
  assert.equal(inQuietHours({ quietStart: "09:00", quietEnd: "09:00" }, at(9)), false);
  assert.equal(inQuietHours({ quietStart: "nope", quietEnd: "08:00" }, at(3)), false);
});

test("global switch off pushes only approvals, and no subscribers suppresses with a reason", async () => {
  const off = setup({ settings: { enabled: false }, now: () => at(12) });
  assert.equal((await ping(off.center, "failure", { priority: "urgent" })).suppressed, "disabled");
  assert.equal((await ping(off.center, "approval")).pushed, true);
  assert.equal(off.sent.length, 1);

  const empty = setup({ subscribers: 0, now: () => at(12) });
  assert.equal((await ping(empty.center, "message")).suppressed, "no-subscribers");
  assert.equal((await ping(empty.center, "approval")).suppressed, "no-subscribers");
  assert.equal(empty.center.list({}).length, 2);
});

test("the VAPID subject is one Apple accepts: never localhost", async () => {
  assert.equal(pushSubject("mailto:ravnir@localhost"), "https://ravnir.dev");
  assert.equal(pushSubject("https://127.0.0.1:3847"), "https://ravnir.dev");
  assert.equal(pushSubject("http://example.com"), "https://ravnir.dev");
  assert.equal(pushSubject(""), "https://ravnir.dev");
  assert.equal(pushSubject("mailto:me@example.com"), "mailto:me@example.com");
  assert.equal(pushSubject("https://bots.example.com"), "https://bots.example.com");
  let options = null;
  const push = new PushService({ home: tempHome(), sender: async (subscription, body, sent) => { options = sent; } });
  push.subscribe(fakeSubscription(), {});
  await push.send({ title: "hi" });
  assert.equal(options.vapidDetails.subject, "https://ravnir.dev");
});

test("push failures are recorded, not thrown", async () => {
  const home = tempHome();
  const logged = [];
  const push = new PushService({
    home,
    log: (line) => logged.push(line),
    sender: async () => { throw Object.assign(new Error("Received unexpected response code"), { statusCode: 403, body: '{"reason":"BadJwtToken"}' }); },
  });
  push.subscribe(fakeSubscription(), { label: "iPhone" });
  const center = new NotificationCenter({ home, push, getSettings: () => ({ enabled: true }), getBot: () => ({ name: "Scout" }), now: () => at(12) });
  const record = await ping(center, "message");
  assert.equal(record.pushed, false);
  assert.equal(record.suppressed, "send-failed");
  assert.equal(push.list()[0].lastError, "403 BadJwtToken");
  assert.deepEqual(logged, ["Push to iPhone failed: 403 BadJwtToken"]);
});

test("push payload carries the bot name, plain text body capped at 240 characters, and a safe url", async () => {
  const { center, sent } = setup({ now: () => at(12) });
  const long = `## Report\n\n**Done** with [the deploy](https://example.com/x) and \`npm test\`.\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n- *first* item\n- ${"word ".repeat(80)}`;
  const record = await center.notify({ botId: "b1", botName: "Scout", kind: "routine", title: "Morning **check**", body: long, url: "//evil.example", tag: "t1", priority: "high" });
  assert.equal(record.url, "/");
  assert.ok(record.body.length <= 240);
  assert.ok(record.body.startsWith("Report Done with the deploy and npm test. const a = 1; first item word"));
  assert.doesNotMatch(record.body, /[#*`\[\]]/);
  assert.deepEqual(Object.keys(record).sort(), ["at", "body", "botId", "botName", "id", "kind", "priority", "pushed", "read", "suppressed", "tag", "title", "url"]);
  assert.equal(record.pushed, true);
  assert.deepEqual(sent[0].payload, { id: record.id, title: "Scout: Morning check", body: record.body, url: "/", tag: "t1", kind: "routine", botId: "b1" });
  assert.equal(sent[0].options.urgency, "high");
  const ok = await center.notify({ botId: "b1", botName: "Scout", kind: "message", title: "x", url: "/?view=today" });
  assert.equal(ok.url, "/?view=today");
  assert.equal(plainText("snake_case_name and _soft_ and 2 * 3 * 4"), "snake_case_name and soft and 2 * 3 * 4");
});

test("notifications list newest first, count unread, mark read, and survive a reload", async () => {
  const clock = { time: at(12) };
  const { home, push, center, state } = setup({ now: () => (clock.time += 1000) });
  const first = await ping(center, "message", { title: "one" });
  const second = await ping(center, "message", { title: "two" });
  const third = await ping(center, "message", { title: "three" });
  assert.deepEqual(center.list({ limit: 2 }).map((item) => item.title), ["three", "two"]);
  assert.equal(center.unreadCount(), 3);
  assert.equal(center.markRead([first.id, "unknown"]), 1);
  assert.equal(center.unreadCount(), 2);
  const reloaded = new NotificationCenter({ home, push, getSettings: () => state.settings, getBot: () => null });
  assert.equal(reloaded.unreadCount(), 2);
  assert.equal(reloaded.list().length, 3);
  reloaded.markRead("all");
  assert.equal(reloaded.unreadCount(), 0);
  assert.equal(new NotificationCenter({ home, push }).unreadCount(), 0);
  assert.ok(second.id && third.id);
  for (let i = 0; i < 510; i += 1) await center.notify({ botId: "b1", kind: "turn", title: `n${i}` });
  assert.equal(center.list({ limit: 1000 }).length, 500);
});

test("proposals are created, listed newest first, and decided once", () => {
  const home = tempHome();
  const store = new ProposalStore({ home });
  assert.throws(() => store.create({ botId: "b1", title: "", prompt: "x" }), /title and a prompt/);
  const first = store.create({ botId: "b1", botName: "Scout", title: "Clean the downloads folder", why: "It has 3 GB of old files.", prompt: "Delete files older than 90 days." });
  const second = store.create({ botId: "b2", botName: "PA", title: "x".repeat(200), prompt: "y".repeat(5000) });
  assert.equal(first.status, "open");
  assert.equal(second.title.length, 80);
  assert.equal(second.prompt.length, 4000);
  assert.deepEqual(store.list({ status: "open" }).map((item) => item.id), [second.id, first.id]);
  assert.equal(store.decide("missing", "accept"), null);
  assert.equal(store.decide(first.id, "maybe"), null);
  assert.equal(store.decide(first.id, "accept").status, "accepted");
  assert.equal(store.decide(first.id, "dismiss"), null);
  assert.equal(store.decide(second.id, "dismiss").status, "dismissed");
  assert.equal(store.list({ status: "open" }).length, 0);
  assert.equal(store.list({ status: "accepted" })[0].id, first.id);
  assert.equal(new ProposalStore({ home }).get(second.id).status, "dismissed");
  assert.equal(new ProposalStore({ home }).list().length, 2);
});

test("proactive tools use the same schema shape as the collaboration tools", () => {
  const tools = proactiveToolDefinitions();
  assert.deepEqual(tools.map((tool) => tool.name), ["notify_user", "propose_task"]);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "name", "parameters"]);
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
  }
  const [notify, propose] = tools;
  assert.deepEqual(notify.parameters.required, ["title", "body"]);
  assert.equal(notify.parameters.properties.title.maxLength, 80);
  assert.equal(notify.parameters.properties.body.maxLength, 400);
  assert.deepEqual(notify.parameters.properties.priority.enum, ["normal", "high", "urgent"]);
  assert.deepEqual(propose.parameters.required, ["title", "why", "prompt"]);
  assert.equal(propose.parameters.properties.prompt.maxLength, 4000);
});

const basic = (user, password) => ({ headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` } });
const withCookie = (setCookie) => ({ headers: { cookie: setCookie.split(";")[0] } });

test("auth logs in with a cookie, checks Basic as a fallback, and forgets on logout", () => {
  const home = tempHome();
  const auth = createAuth({ user: "owner", password: "correct horse", home });
  assert.equal(auth.enabled, true);
  assert.equal(auth.login("owner", "wrong"), null);
  assert.equal(auth.login("other", "correct horse"), null);
  assert.equal(auth.login("", ""), null);
  const login = auth.login("owner", "correct horse");
  assert.match(login.setCookie, /^tb_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=7776000$/);
  const req = withCookie(login.setCookie);
  assert.equal(auth.check(req), true);
  assert.equal(auth.check({ headers: { cookie: "tb_session=forged" } }), false);
  assert.equal(auth.check({ headers: {} }), false);
  assert.equal(auth.check(basic("owner", "correct horse")), true);
  assert.equal(auth.check(basic("owner", "wrong")), false);
  assert.equal(auth.check(basic("owner", "correct horse extra")), false);
  assert.equal(auth.check({ headers: { authorization: "Basic !!!" } }), false);
  assert.equal(auth.check({ headers: { authorization: "Bearer abc" } }), false);

  const file = path.join(home, "sessions.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const token = login.setCookie.split(";")[0].split("=")[1];
  const stored = fs.readFileSync(file, "utf8");
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(crypto.createHash("sha256").update(token).digest("hex")), true);
  assert.equal(createAuth({ user: "owner", password: "correct horse", home }).check(req), true);

  const out = auth.logout(req);
  assert.match(out.setCookie, /^tb_session=; .*Max-Age=0$/);
  assert.equal(auth.check(req), false);
  assert.equal(createAuth({ user: "owner", password: "correct horse", home }).check(req), false);
  assert.match(auth.logout({ headers: {} }).setCookie, /Max-Age=0/);
});

test("auth sessions expire after 90 days and a disabled auth lets everything through", () => {
  const home = tempHome();
  const clock = { time: Date.parse("2026-10-23T10:00:00Z") };
  const auth = createAuth({ user: "u", password: "p", home, now: () => clock.time });
  const req = withCookie(auth.login("u", "p").setCookie);
  clock.time += 89 * 86_400_000;
  assert.equal(auth.check(req), true);
  clock.time += 2 * 86_400_000;
  assert.equal(auth.check(req), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8")), {});
  const late = withCookie(auth.login("u", "p").setCookie);
  clock.time += 91 * 86_400_000;
  assert.equal(createAuth({ user: "u", password: "p", home, now: () => clock.time }).check(late), false);

  for (const options of [{ user: "", password: "p" }, { user: "u", password: "" }, {}]) {
    const open = createAuth({ ...options, home });
    assert.equal(open.enabled, false);
    assert.equal(open.check({ headers: {} }), true);
    assert.equal(open.login("u", "p"), null);
  }
  assert.deepEqual(parseCookies('a=1; tb_session="x%20y"; bad; b=%E0%A4%A'), { a: "1", tb_session: "x y", b: "%E0%A4%A" });
});

test("service worker shows pushes, guards renotify, and routes clicks", async () => {
  const listeners = {};
  const shown = [];
  const opened = [];
  const messages = [];
  const focused = [];
  const windows = [{ url: "https://hub.test/", focus: async () => focused.push(1), postMessage: (m) => messages.push(m) }];
  const self = {
    location: { origin: "https://hub.test" },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url) => opened.push(url) },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "public/sw.js"), "utf8"), { self, URL, Uint8Array, atob, fetch: async () => ({}) });
  assert.deepEqual(Object.keys(listeners).sort(), ["activate", "install", "notificationclick", "push", "pushsubscriptionchange"]);
  assert.equal(listeners.fetch, undefined);

  const run = async (type, event) => {
    let pending;
    listeners[type]({ ...event, waitUntil: (promise) => { pending = promise; } });
    await pending;
  };
  const payload = (data) => ({ data: { json: () => data, text: () => "plain" } });
  await run("push", payload({ title: "Scout: Approval", body: "Run ls", url: "/?view=today", tag: "a1", kind: "approval", id: "n1" }));
  await run("push", payload({ title: "PA: Done", body: "ok", kind: "approval" }));
  assert.equal(shown[0].title, "Scout: Approval");
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(shown[0].options), { body: "Run ls", icon: "/logo.png?v=companion-20261025", badge: "/logo.png?v=companion-20261025", tag: "a1", data: { url: "/?view=today", id: "n1" }, renotify: true });
  assert.equal(shown[1].options.renotify, false);
  assert.equal(shown[1].options.tag, undefined);

  let closed = 0;
  await run("notificationclick", { notification: { close: () => { closed += 1; }, data: { url: "/?view=today" } } });
  assert.equal(closed, 1);
  assert.equal(focused.length, 1);
  assert.deepEqual(plain(messages), [{ type: "open", url: "/?view=today" }]);
  windows.length = 0;
  await run("notificationclick", { notification: { close() {}, data: { url: "https://elsewhere.test/x" } } });
  await run("notificationclick", { notification: { close() {}, data: { url: "/a?b=1" } } });
  assert.deepEqual(opened, ["/", "/a?b=1"]);
});

test("login page keeps the required copy and only follows same-site next paths", () => {
  const html = fs.readFileSync(path.join(root, "public/login.html"), "utf8");
  for (const copy of ["Sign in to Ravnir", "Username", "Password", "Sign in", "That did not match. Try again."]) assert.ok(html.includes(copy), copy);
  assert.doesNotMatch(html, /[–—]/);
  assert.match(html, /\/api\/login/);
  const source = /function nextPath\(\) \{[\s\S]*?\n        \}/.exec(html)[0];
  const nextFor = (search) => vm.runInNewContext(`${source}; nextPath()`, { URLSearchParams, location: { search } });
  assert.equal(nextFor("?next=%2F%3Fview%3Dtoday"), "/?view=today");
  assert.equal(nextFor("?next=%2Fbots%2F1"), "/bots/1");
  for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "evil", "javascript:alert(1)", "/a\nb", "/login", "/login?next=%2F", ""]) {
    assert.equal(nextFor(`?next=${encodeURIComponent(bad)}`), "/", JSON.stringify(bad));
  }
  assert.equal(nextFor(""), "/");
});
