import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ApprovalCenter } from "../server/approvals.js";
import { createApp } from "../server/index.js";
import { Ledger, startOfDay } from "../server/ledger.js";
import { matchesPattern, normalizePolicy, openCodePermission, serverList, shellDecision } from "../server/policy.js";
import { applySpec, checkSpec, dismissSpec, linkSpec, readAppliedSpec, specNeedsAttention, specView } from "../server/spec.js";
import { usageAfterLastUser } from "../server/providers/opencode.js";
import { createBot } from "../server/state.js";
import { startMock } from "../scripts/mock-openai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

test("shell rules allow listed commands and block chaining", () => {
  const gate = "ssh -i ~/.ssh/key deploy@host";
  const policy = normalizePolicy({ shell: "ask", allow: [`${gate} informe`, `${gate} nota < *`] });
  assert.equal(shellDecision(policy, `${gate} informe`), "allow");
  assert.equal(shellDecision(policy, `${gate} nota < nota.json`), "allow");
  assert.equal(shellDecision(policy, `${gate} informe; rm -rf ~`), "ask");
  assert.equal(shellDecision(policy, `${gate} informe && cat ~/.ssh/id_rsa`), "ask");
  assert.equal(shellDecision(policy, `${gate} informe > ~/.zshrc`), "ask");
  assert.equal(shellDecision(policy, `${gate} nota < ~/.ssh/id_rsa`), "ask");
  assert.equal(shellDecision(policy, "ls"), "ask");
  assert.equal(shellDecision({ shell: "deny", allow: ["ls"] }, "ls"), "allow");
  assert.equal(shellDecision({ shell: "deny" }, "pwd"), "deny");
  assert.equal(shellDecision({ shell: "allow" }, "anything; at all"), "allow");
  assert.equal(matchesPattern("gh pr view *", "gh pr view 12 -R a/b"), true);
  assert.equal(matchesPattern("gh pr view *", "gh pr merge 12"), false);
  assert.deepEqual(normalizePolicy(undefined), { shell: "ask", allow: [], files: "ask", logins: "ask", plugins: "ask" });
  const permission = openCodePermission(policy);
  assert.equal(permission.bash["*"], "ask");
  assert.equal(permission.bash[`${gate} informe`], "allow");
  assert.equal(permission.external_directory, "ask");
});

test("reaching another machine asks even for a trusted bot", () => {
  const trusted = normalizePolicy({ shell: "allow", allow: ["ssh stage uptime"] });
  assert.equal(shellDecision(trusted, "npm test"), "allow");
  assert.equal(shellDecision(trusted, "ssh stage 'sudo reboot'"), "ask");
  assert.equal(shellDecision(trusted, "cd /tmp && scp a.txt stage:/tmp"), "ask");
  assert.equal(shellDecision(trusted, "/usr/bin/ssh hub ls"), "ask");
  assert.equal(shellDecision(trusted, "rsync -a out/ build:/srv/out"), "ask");
  assert.equal(shellDecision(trusted, "ssh stage uptime"), "allow");
  assert.equal(shellDecision(trusted, "ssh stage uptime; ssh stage reboot"), "ask");
  assert.equal(shellDecision(trusted, "echo sshd is fine"), "allow");
  const permission = openCodePermission(trusted);
  assert.equal(permission.bash["*"], "allow");
  assert.equal(permission.bash["ssh *"], "ask");
  assert.equal(permission.bash["ssh stage uptime"], "allow");
  assert.deepEqual(Object.keys(permission.bash).slice(-1), ["ssh stage uptime"]);
  assert.equal(openCodePermission({ shell: "ask" }).bash, "ask");
  assert.equal(openCodePermission({ shell: "deny" }).bash, "deny");
  assert.deepEqual(serverList("hub=This machine as ubuntu; stage=The stage VPS;bad name=x"), [
    { name: "hub", about: "This machine as ubuntu" },
    { name: "stage", about: "The stage VPS" },
  ]);
});

test("approvals resolve, expire, cancel, and survive a reload as expired", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-approvals-"));
  const changes = [];
  const center = new ApprovalCenter({ home, timeoutMs: 60_000, onChange: (record) => changes.push(record.status) });
  const bot = { id: "b1", name: "Scout" };
  const first = center.request({ bot, title: "Run a terminal command", detail: "ls" });
  assert.equal(center.pending().length, 1);
  assert.equal(center.decide(center.pending()[0].id, "once"), true);
  assert.equal(await first, "once");
  assert.equal(center.decide("nope", "once"), false);

  const trust = center.request({ bot, title: "Run a terminal command", detail: "npm test" });
  assert.equal(center.decide(center.pending()[0].id, "trust"), true);
  assert.equal(await trust, "trust");

  const short = new ApprovalCenter({ home, timeoutMs: 30 });
  assert.equal(await short.request({ bot, title: "Expires" }), "reject");
  assert.equal(short.records.at(-1).status, "expired");

  const controller = new AbortController();
  const cancelled = center.request({ bot, title: "Cancelled", signal: controller.signal });
  controller.abort();
  assert.equal(await cancelled, "reject");

  center.request({ bot, title: "Left pending" });
  const reloaded = new ApprovalCenter({ home });
  assert.equal(reloaded.pending().length, 0);
  assert.equal(reloaded.records.find((item) => item.title === "Left pending").status, "expired");
  assert.deepEqual(changes.slice(0, 2), ["pending", "approved"]);
});

test("the ledger totals usage per bot and per day", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-ledger-"));
  const ledger = new Ledger({ home });
  ledger.record({ botId: "a", status: "ok", usage: { input: 100, output: 50, cacheRead: 1000, cost: 0.01 } });
  ledger.record({ botId: "a", status: "error", usage: { input: 10, output: 0, cost: 0.002 } });
  ledger.record({ botId: "b", status: "ok", usage: null });
  const spent = ledger.spentToday("a");
  assert.equal(spent.turns, 2);
  assert.equal(spent.errors, 1);
  assert.equal(spent.tokens, 160);
  assert.equal(spent.cost, 0.012);
  assert.equal(new Ledger({ home }).rows.length, 3);
  const days = ledger.daily("a", 3);
  assert.equal(days.length, 3);
  assert.equal(days.at(-1).day, startOfDay());
  assert.equal(days.at(-1).turns, 2);

  const opencode = usageAfterLastUser([
    { info: { role: "user" } },
    { info: { role: "assistant", cost: 0.001, tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 9, write: 3 } } } },
    { info: { role: "assistant", cost: 0.002, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } },
  ]);
  assert.deepEqual(opencode, { input: 6, output: 3, reasoning: 1, cacheRead: 9, cacheWrite: 3, cost: 0.003 });
});

test("a linked spec runs on the approved copy until changes are applied", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-spec-"));
  const file = path.join(home, "spec.md");
  fs.writeFileSync(file, "# Spec\nRule one.\n");
  const bot = createBot({ name: "Follower" });
  linkSpec(home, bot, file);
  assert.equal(bot.spec.status, "current");
  assert.equal(readAppliedSpec(home, bot), "# Spec\nRule one.\n");

  fs.writeFileSync(file, "# Spec\nRule one.\nRule two.\n");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(checkSpec(bot), true);
  assert.equal(bot.spec.status, "changed");
  assert.equal(readAppliedSpec(home, bot), "# Spec\nRule one.\n");
  assert.match(specView(home, bot).diff, /\+Rule two\./);
  assert.equal(specNeedsAttention(bot.spec), true);

  dismissSpec(bot);
  assert.equal(specNeedsAttention(bot.spec), false);
  assert.equal(specView(home, bot).spec.status, "changed");

  applySpec(home, bot);
  assert.equal(bot.spec.status, "current");
  assert.equal(specNeedsAttention(bot.spec), false);
  assert.match(readAppliedSpec(home, bot), /Rule two/);

  fs.rmSync(file);
  assert.equal(checkSpec(bot), true);
  assert.equal(bot.spec.status, "missing");
  assert.throws(() => linkSpec(home, bot, "relative.md"), /absolute path/);
});

test("risky commands wait in the inbox, caps stop turns, and Today shows it all", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-inbox-"));
  const mock = await startMock();
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await request(base, "POST", "/api/bots", {
      name: "Careful",
      job: "Runs commands only with approval.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const id = created.bot.id;
    assert.equal(created.bot.policy.shell, "ask");
    assert.match(created.livePrompt, /Terminal commands wait for the user's approval/);

    let cursor = created.lastSeq || 0;
    const sent = await request(base, "POST", `/api/bots/${id}/messages`, { text: "run command: echo approved-run" });
    const pending = await waitFor(async () => (await request(base, "GET", "/api/approvals")).pending[0]);
    assert.equal(pending.botId, id);
    assert.equal(pending.detail, "echo approved-run");
    const inbox = await request(base, "GET", "/api/state");
    assert.equal(inbox.inbox.approvals, 1);
    await request(base, "POST", `/api/approvals/${pending.id}`, { decision: "once" });
    let events = await waitForTurn(base, id, cursor, sent.turnId);
    assert.equal(events.some((event) => event.type === "permission" && event.requestID === pending.id), true);
    assert.equal(events.some((event) => event.type === "permission.resolved" && event.status === "approved"), true);
    let detail = await request(base, "GET", `/api/bots/${id}`);
    assert.match(detail.conversation.map((message) => message.content).join("\n"), /approved-run/);
    cursor = detail.lastSeq;

    const denied = await request(base, "POST", `/api/bots/${id}/messages`, { text: "run command: echo never-runs" });
    const second = await waitFor(async () => (await request(base, "GET", "/api/approvals")).pending[0]);
    await request(base, "POST", `/api/approvals/${second.id}`, { decision: "reject" });
    events = await waitForTurn(base, id, cursor, denied.turnId);
    detail = await request(base, "GET", `/api/bots/${id}`);
    const toolText = detail.conversation.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
    assert.match(toolText, /did not approve/);
    assert.doesNotMatch(toolText, /\nnever-runs/);

    await request(base, "PATCH", `/api/bots/${id}`, { policy: { allow: ["echo listed *"] } });
    cursor = (await request(base, "GET", `/api/bots/${id}`)).lastSeq;
    const listed = await request(base, "POST", `/api/bots/${id}/messages`, { text: "run command: echo listed ok" });
    events = await waitForTurn(base, id, cursor, listed.turnId);
    assert.equal(events.some((event) => event.type === "permission"), false);

    let today = await request(base, "GET", "/api/today");
    const mine = today.bots.find((bot) => bot.botId === id);
    assert.equal(mine.turns, 3);
    assert.equal(mine.tokens > 0, true);
    assert.equal(mine.cost > 0, true);
    assert.equal(today.approvals.decided.length, 2);
    assert.equal(today.timeline[0].botId, id);
    // The Home chart and hour strip add up to the day's totals.
    assert.equal(today.series.length, 14);
    assert.equal(today.series.at(-1).day, today.day);
    assert.equal(today.series.at(-1).turns, today.totals.turns);
    assert.equal(today.hours.length, 24);
    assert.equal(today.hours.reduce((sum, hour) => sum + hour.turns, 0), today.totals.turns);
    assert.ok(Array.isArray(today.soon));

    await request(base, "PATCH", `/api/bots/${id}`, { limits: { dailyCost: 0.001 } });
    cursor = (await request(base, "GET", `/api/bots/${id}`)).lastSeq;
    const capped = await request(base, "POST", `/api/bots/${id}/messages`, { text: "hello again" });
    events = await waitForTurn(base, id, cursor, capped.turnId);
    assert.equal(events.some((event) => event.type === "error" && /daily cap/.test(event.message)), true);
    today = await request(base, "GET", "/api/today");
    assert.equal(today.timeline[0].status, "capped");
    const usage = await request(base, "GET", "/api/usage?days=7");
    assert.equal(usage.bots.find((bot) => bot.botId === id).daily.length, 7);

    const specFile = path.join(home, "rules.md");
    fs.writeFileSync(specFile, "Always answer in Spanish.\n");
    const linked = await request(base, "PUT", `/api/bots/${id}/spec`, { path: specFile });
    assert.equal(linked.view.spec.status, "current");
    assert.match(linked.detail.livePrompt, /Always answer in Spanish\./);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
  }
});

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

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting.");
}

async function waitForTurn(base, id, after, turnId) {
  let cursor = after;
  const collected = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const data = await request(base, "GET", `/api/bots/${id}/events?after=${cursor}`);
    cursor = data.cursor;
    collected.push(...data.events);
    if (data.events.some((event) => event.type === "turn.end" && (!turnId || event.turnId === turnId))) return collected;
  }
  throw new Error("The turn did not finish.");
}

test("pins keep an order and one bot is the main bot", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-pins-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const one = await request(base, "POST", "/api/bots", { name: "Chief", job: "Runs the team." });
    const two = await request(base, "POST", "/api/bots", { name: "Fixer", job: "Fixes things." });
    await request(base, "PATCH", `/api/bots/${one.bot.id}`, { pinned: true, main: true });
    await request(base, "PATCH", `/api/bots/${two.bot.id}`, { pinned: true, main: true });
    let state = await request(base, "GET", "/api/state");
    const chief = state.bots.find((bot) => bot.id === one.bot.id);
    const fixer = state.bots.find((bot) => bot.id === two.bot.id);
    assert.equal(chief.main, false);
    assert.equal(fixer.main, true);
    assert.equal(fixer.pinned, true);

    await request(base, "POST", "/api/pins", { ids: [one.bot.id, two.bot.id] });
    state = await request(base, "GET", "/api/state");
    assert.equal(state.bots.find((bot) => bot.id === one.bot.id).pinnedOrder, 1);
    assert.equal(state.bots.find((bot) => bot.id === two.bot.id).pinnedOrder, 2);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
});

test("a password set on the server guards every page but icons and the MCP endpoint", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-auth-"));
  process.env.RAVNIR_USER = "owner";
  process.env.RAVNIR_PASSWORD = "test-password";
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Basic ${Buffer.from("owner:test-password").toString("base64")}` };
  try {
    // Pages send you to the sign-in page; the API answers 401 without a Basic dialog.
    const page = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login?next=%2F");
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/today`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
    assert.equal((await fetch(`${base}/api/bots/none/mcp`, { method: "POST", body: "{}" })).status === 401, false);
  } finally {
    delete process.env.RAVNIR_USER;
    delete process.env.RAVNIR_PASSWORD;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
});
