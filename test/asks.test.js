import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { AskBook, askUser, attemptNote, countAsks, endsWithQuestion, ownerFact, sameAsk, targetOf, TurnAttempts } from "../server/asks.js";
import { createApp } from "../server/index.js";
import { Ledger } from "../server/ledger.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-asks-"));
const bot = (id, name, extra = {}) => ({ id, name, job: "x", connectors: [], jobs: [], memory: [], vault: [], ...extra });

// A stand-in for the turn engine: one active turn per bot, events kept for the assertions.
function fakeEngine() {
  const events = [];
  const active = new Map();
  return {
    events,
    active,
    start: (botId, turnId = `turn-${active.size + 1}`) => active.set(botId, { turnId, attempts: new TurnAttempts() }),
    end: (botId) => active.delete(botId),
    emit: (target, event) => events.push({ botId: target.id, ...event }),
  };
}

test("two questions are the same when they need the same thing or share most words", () => {
  assert.equal(sameAsk({ need: "GitHub token", question: "Can you give me a token?" }, { need: "GitHub personal access token", question: "I need access to the repo." }), true);
  assert.equal(sameAsk({ need: "", question: "Which repository should I deploy to production?" }, { need: "", question: "Which repository should I deploy?" }), true);
  assert.equal(sameAsk({ need: "preferred airline", question: "Which airline?" }, { need: "home address", question: "Where do you live?" }), false);
  // Accents and case do not matter.
  assert.equal(sameAsk({ need: "dirección de envío", question: "" }, { need: "Direccion de envio", question: "" }), true);
});

test("a reply that ends asking counts as a question, a finished one does not", () => {
  assert.equal(endsWithQuestion("Done. I sent the invoice."), false);
  assert.equal(endsWithQuestion("I found two flights.\n\nWhich one do you want?"), true);
  assert.equal(endsWithQuestion("Want me to also book the hotel?**"), true);
  assert.equal(endsWithQuestion("Pick one:\n\n```choice\n{\"question\": \"Which?\", \"options\": [\"A\", \"B\"]}\n```"), true);
  assert.equal(endsWithQuestion("```js\nconst ok = a ? b : c?\n```\nAll tests pass."), false);
  assert.deepEqual(countAsks({ reply: "Which one?", refused: 2 }), { asks: 1, askDetail: { tool: 0, takeover: 0, text: 1, blocked: 0, bounced: 0, reused: 0, refused: 2 } });
  // ask_user already counted the question its reply repeats.
  assert.equal(countAsks({ asking: { asks: [{}], blocked: 1, bounced: 0, reused: 0 }, reply: "Which repo?" }).asks, 1);
  assert.equal(countAsks({ takeovers: 1, reply: "Can you sign in?" }).asks, 1);
  assert.equal(countAsks({ reply: "Done." }).asks, 0);
});

test("failures add up per target: an unchanged retry is refused and the third failure says stop", () => {
  assert.equal(targetOf("browser_open", { url: "https://www.shop.test/orders?id=1" }), "site shop.test");
  assert.equal(targetOf("ravnir_run_command", { command: "git push origin main" }), "command git push");
  assert.equal(targetOf("github__create_issue", {}), "plugin github");
  // A rejected saved login is not worth retrying: the first note already says to ask.
  assert.match(attemptNote(targetOf("browser_saved_login", { site: "https://shop.test/login" }), 1), /saved login for shop\.test was rejected\. Retrying it will not help\. .*call ask_user \(about: access\)/);
  // A sign-in page that only asked for the email first is not a rejected login.
  assert.match(attemptNote(targetOf("browser_saved_login", { site: "https://shop.test/login" }), 1, "No password field on this page: it asks for the email first"), /first failed attempt/);
  const attempts = new TurnAttempts();
  assert.match(attempts.after("browser_open", { url: "https://shop.test/login" }, { error: true, text: "Error: 403 Forbidden" }), /first failed attempt on site shop\.test/);
  assert.match(attempts.before("browser_open", { url: "https://shop.test/login" }), /^Not run: you just made exactly this call and it failed \(403 Forbidden\)/);
  // Another call in between, or different input, runs.
  assert.equal(attempts.before("browser_open", { url: "https://shop.test/signin" }), "");
  assert.match(attempts.after("browser_open", { url: "https://shop.test/signin" }, { error: true, text: "Error: 403" }), /2 failed attempts on site shop\.test\. Try one more, different approach/);
  assert.match(attempts.after("web_fetch", { url: "https://shop.test/" }, { error: true, text: "Error: 403" }), /3 failed attempts on site shop\.test\. Stop retrying it\. .*ask_user/);
  assert.equal(attempts.failed(), 3);
  assert.match(attempts.summary(), /browser_open on shop\.test: 403 Forbidden/);
  // Six failures on one target: further calls on it are refused for the rest of the turn.
  for (const page of ["a", "b", "c"]) attempts.after("browser_open", { url: `https://shop.test/${page}` }, { error: true, text: "Error: 403" });
  assert.match(attempts.before("browser_open", { url: "https://shop.test/new" }), /^Not run: 6 attempts on site shop\.test failed in this turn\. Stop working on it\./);
  assert.equal(attempts.before("browser_open", { url: "https://other.test/" }), "");
  assert.equal(attempts.refused, 2);

  // A timeout may be retried once as it was.
  const flaky = new TurnAttempts();
  flaky.after("web_fetch", { url: "https://api.test/" }, { error: true, text: "Error: request timed out" });
  assert.equal(flaky.before("web_fetch", { url: "https://api.test/" }), "");
  flaky.after("web_fetch", { url: "https://api.test/" }, { error: true, text: "Error: request timed out" });
  assert.match(flaky.before("web_fetch", { url: "https://api.test/" }), /^Not run/);

  // A failing test run is refused only when nothing changed; it never counts toward stopping.
  const coding = new TurnAttempts();
  assert.equal(coding.after("run_command", { command: "npm test" }, { text: "$ npm test\n1 failing\n[exit 1]" }), "");
  assert.match(coding.before("run_command", { command: "npm test" }), /^Not run/);
  coding.after("write_file", { path: "a.js" }, { text: "Wrote a.js" });
  assert.equal(coding.before("run_command", { command: "npm test" }), "");
  assert.equal(coding.failed(), 0);

  // Looking is never refused.
  const looking = new TurnAttempts();
  looking.after("vault_search", { query: "x" }, { error: true, text: "Error: no index" });
  assert.equal(looking.before("vault_search", { query: "x" }), "");
});

test("OpenCode's own tool results count once each, and Ravnir's tools are counted where they run", () => {
  const attempts = new TurnAttempts();
  const event = { type: "tool", id: "t1", name: "webfetch", status: "error", input: { url: "https://x.test/a" }, output: "403" };
  attempts.observe(event);
  attempts.observe(event);
  attempts.observe({ type: "tool", id: "t2", name: "ravnir_browser_open", status: "error", input: { url: "https://x.test/" }, output: "403" });
  attempts.observe({ type: "tool", id: "t3", name: "bash", status: "running", input: { command: "ls" } });
  assert.equal(attempts.failed(), 1);
});

test("ask_user looks first, sends once, refuses a repeat, and gives back answers", async () => {
  const home = tmp();
  const asks = new AskBook({ home });
  const engine = fakeEngine();
  const scout = bot("s", "Scout", { vault: [{ id: "l1", site: "github.com", username: "alex" }] });
  const ctx = { bot: scout, asks, engine };
  engine.start("s");

  // A saved login matches: the agent is sent back to use it.
  const first = await askUser({ question: "Can you give me your GitHub login?", need: "GitHub login", about: "access" }, ctx);
  assert.match(first.text, /^Not sent yet\. You may already have this:\n- Saved login: github\.com as alex\. Use browser_saved_login\./);
  assert.equal(asks.open().length, 0);
  // Asking again in the same turn, after looking, goes through.
  const second = await askUser({ question: "The saved GitHub login is rejected. Can you sign in again?", need: "GitHub login", about: "access", tried: "Used the saved login twice." }, ctx);
  assert.match(second.text, /^Question sent\. End your turn now/);
  assert.equal(asks.open().length, 1);
  assert.equal(engine.events.at(-1).type, "ask");
  assert.match(engine.events.at(-1).ask.tried, /Used the saved login twice\./);
  // The same question again in this turn.
  assert.match((await askUser({ question: "GitHub login?", need: "GitHub login", about: "access" }, ctx)).text, /already asked this in this turn/);
  engine.end("s");

  // A routine wakes the agent before the user answered: the repeat is refused, with a status to give.
  engine.start("s", "routine-1");
  const repeat = await askUser({ question: "Could you sign in to GitHub for me?", need: "GitHub sign-in", about: "access" }, ctx);
  assert.match(repeat.text, /^Not sent: you already asked this on \d{4}-\d{2}-\d{2} .* has not answered yet\. Do not ask again\./);
  assert.equal(engine.active.get("s").asking.blocked, 1);
  assert.equal(asks.open().length, 1);
  engine.end("s");

  // The reply to an access question is not kept; asking again points the agent at its thread.
  assert.equal(asks.answer("s", "Signed in, try again.", "t9").length, 1);
  assert.equal(asks.list({ status: "answered" })[0].answer, "");
  engine.start("s");
  const reuse = await askUser({ question: "Can you log me into GitHub?", need: "GitHub login", about: "access" }, ctx);
  assert.match(reuse.text, /^You asked this on .* the user replied in your thread \(the reply is not kept here because it was about access/);
  assert.equal(engine.active.get("s").asking.reused, 1);
  engine.end("s");

  // Any other reply is given back; when it did not answer, the agent asks again with again: true.
  engine.start("s");
  await askUser({ question: "Which repo should I deploy?", need: "deploy repository", about: "detail" }, ctx);
  engine.end("s");
  asks.answer("s", "The deploy finished, thanks.");
  engine.start("s");
  assert.match((await askUser({ question: "Which repository do I deploy?", need: "deploy repository", about: "detail" }, ctx)).text, /the user replied: "The deploy finished, thanks\."\. Use that answer and continue\. Only if that reply does not answer this question, call ask_user again with again: true\./);
  assert.match((await askUser({ question: "Which repository do I deploy?", need: "deploy repository", about: "detail", again: true }, ctx)).text, /^Question sent/);
  assert.equal(asks.list({ status: "dismissed" }).length, 1);
  engine.end("s");

  // A decision is the user's to make: no look first.
  engine.start("s");
  assert.match((await askUser({ question: "Ship on Friday or Monday?", need: "release day", about: "decision" }, ctx)).text, /^Question sent/);
});

test("answers stay with the agent that asked; Home answers one question by id; secrets are not kept or shown", async () => {
  const home = tmp();
  const asks = new AskBook({ home });
  const engine = fakeEngine();
  const travel = bot("t", "Travel");
  const pa = bot("p", "PA");
  engine.start("t");
  await askUser({ question: "Which airline do you prefer?", need: "preferred airline", about: "owner" }, { bot: travel, asks, engine });
  await askUser({ question: "Which repo?", need: "deploy repository", about: "detail" }, { bot: travel, asks, engine });
  asks.answer("t", "Iberia");
  engine.start("p");
  // Another agent learns the owner's airline from the vault, once Travel saved it there, not from the ask book.
  const other = await askUser({ question: "What airline should I book?", need: "preferred airline", about: "owner" }, { bot: pa, asks, engine });
  assert.match(other.text, /^Question sent/);
  assert.equal(asks.list({ botId: "t", status: "answered" }).find((item) => item.need === "preferred airline").answer, "Iberia");

  // From Home, the reply answers only the question it names.
  const [first, second] = [asks.create({ bot: pa, question: "A?", need: "alpha", about: "detail" }), asks.create({ bot: pa, question: "B?", need: "beta", about: "detail" })];
  assert.deepEqual(asks.answer("p", "alpha is 1", "", [first.id]).map((item) => item.id), [first.id]);
  assert.equal(asks.list().find((item) => item.id === second.id).status, "open");

  // Something that looks like a secret in what the agent tried is hidden before it is kept or shown.
  const hidden = asks.create({ bot: pa, question: "Q?", need: "deploy key", about: "access", tried: "Used token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }); // check-public: allow token (fake secret for a test)
  assert.equal(hidden.tried, "[hidden: looked like a secret]");

  assert.deepEqual(ownerFact({ need: "preferred airline", answer: "Iberia" }), { fact: "Preferred airline: Iberia", key: "preferred-airline" });
  // A secret is never kept as an answer.
  engine.start("t");
  await askUser({ question: "API key?", need: "Stripe key", about: "access" }, { bot: travel, asks, engine });
  const [kept] = asks.answer("t", "sk_live_51HxAbCdEf12345GhIjK67890LmNoPq");
  assert.equal(kept.answer, "");
  assert.equal(kept.secret, true);
});

test("an open question stops blocking after a week, and Clear chat closes it", () => {
  let now = Date.UTC(2026, 9, 1);
  const asks = new AskBook({ home: tmp(), now: () => now });
  asks.create({ bot: bot("a", "A"), question: "Q?", need: "thing", about: "detail" });
  asks.create({ bot: bot("b", "B"), question: "Q?", need: "thing", about: "detail" });
  asks.closeFor("b");
  assert.deepEqual(asks.open().map((item) => item.botId), ["a"]);
  now += 8 * 86_400_000;
  assert.equal(asks.open().length, 0);
  assert.equal(asks.list({ status: "expired" }).length, 2);
  // Kept on disk across a restart.
  assert.equal(new AskBook({ home: path.dirname(asks.file), now: () => now }).list().length, 2);
});

test("the ledger adds up asks per day", () => {
  const ledger = new Ledger({ home: tmp() });
  ledger.record({ id: "1", botId: "a", status: "ok", asks: 1 });
  ledger.record({ id: "2", botId: "a", status: "ok", asks: 0 });
  ledger.record({ id: "3", botId: "a", status: "ok" });
  assert.equal(ledger.spentToday("a").asks, 1);
  assert.equal(ledger.daily("a", 2).at(-1).asks, 1);
});

async function api(base, method, pathname, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(check, { tries = 100, delay = 100 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting.");
}

async function say(base, id, text) {
  const { turnId } = await api(base, "POST", `/api/bots/${id}/messages`, { text });
  await waitFor(async () => (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events.some((event) => event.type === "turn.end" && event.turnId === turnId));
  const { conversation } = await api(base, "GET", `/api/bots/${id}`);
  return { turnId, reply: conversation.filter((message) => message.role === "assistant" && message.kind !== "ack").at(-1) };
}

test("end to end: a question shows in Home and the thread, counts in the ledger, and the next message answers it", async () => {
  const mock = await startMock();
  const server = createApp({ home: tmp(), projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const agent = (await api(base, "POST", "/api/bots", { name: "Deployer", job: "Deploys the website.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } })).bot;
    assert.match((await api(base, "GET", `/api/bots/${agent.id}`)).livePrompt, /When you need the user\n- Look before you ask\./);

    const asked = await say(base, agent.id, 'call tool ask_user {"question":"Which repo should I deploy?","need":"deploy repository","about":"detail","tried":"Looked in the workspace."}');
    assert.match(asked.reply.content, /Question sent/);
    assert.equal(asked.reply.asks.length, 1);
    assert.equal(asked.reply.asks[0].question, "Which repo should I deploy?");
    let today = await api(base, "GET", "/api/today");
    assert.equal(today.questions.length, 1);
    assert.equal(today.questions[0].botName, "Deployer");
    assert.equal(today.timeline.find((row) => row.id === asked.turnId).asks, 1);
    assert.equal(today.totals.asks, 1);
    assert.equal((await api(base, "GET", "/api/state")).inbox.questions, 1);

    // The next message answers it; the model is told so.
    const answer = await say(base, agent.id, "ravnir-demo");
    assert.equal(answer.reply.content, 'Thanks. That answers "Which repo should I deploy?".');
    today = await api(base, "GET", "/api/today");
    assert.equal(today.questions.length, 0);
    assert.equal(today.timeline.find((row) => row.id === answer.turnId).asks, 0);

    // Asking again gets the answer back instead of a new question.
    const again = await say(base, agent.id, 'call tool ask_user {"question":"Which repository do I deploy?","need":"deploy repository","about":"detail"}');
    assert.match(again.reply.content, /the user replied: "ravnir-demo"/);
    assert.equal(again.reply.asks, undefined);
    today = await api(base, "GET", "/api/today");
    assert.equal(today.timeline.find((row) => row.id === again.turnId).asks, 0);
    assert.equal(today.timeline.find((row) => row.id === again.turnId).askDetail.reused, 1);

    // A failed call gets a note on what to do next.
    const failed = await say(base, agent.id, 'call tool web_fetch {"url":"http://127.0.0.1:9/nothing"}');
    assert.match(failed.reply.content, /\[Ravnir: first failed attempt on site 127\.0\.0\.1:9\. Try a different approach before asking the user\.\]/);

    // OpenCode agents reach ask_user through their MCP endpoint.
    const token = (await api(base, "GET", `/api/bots/${agent.id}`)).mcpToken;
    if (token) {
      const listed = await api(base, "POST", `/api/bots/${agent.id}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${token}` });
      assert.ok(listed.result.tools.some((tool) => tool.name === "ask_user"));
    }

    // An answer about the owner: the agent is told to save the lasting fact itself, under a key.
    await say(base, agent.id, 'call tool ask_user {"question":"Which airline do you prefer?","need":"preferred airline","about":"owner"}');
    assert.equal((await say(base, agent.id, "Iberia")).reply.content, 'Thanks. That answers "Which airline do you prefer?". Saving it as preferred-airline.');

    // Clear chat closes what is still open.
    await say(base, agent.id, 'call tool ask_user {"question":"Friday or Monday?","need":"release day","about":"decision"}');
    assert.equal((await api(base, "GET", "/api/today")).questions.length, 1);
    await api(base, "DELETE", `/api/bots/${agent.id}/conversation`);
    assert.equal((await api(base, "GET", "/api/today")).questions.length, 0);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
  }
});
