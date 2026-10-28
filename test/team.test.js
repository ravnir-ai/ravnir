import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callCollaborationTool, rankTeam } from "../server/collaboration.js";
import { rank, words } from "../server/match.js";
import { createApp } from "../server/index.js";
import { buildSystemPrompt } from "../server/prompts.js";
import { writeConversation } from "../server/state.js";
import { soundsStuck } from "../server/turn.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";
process.env.RAVNIR_QUICK = "off";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-team-"));
const bot = (id, name, extra = {}) => ({ id, name, job: "x", group: "Personal", status: "on", connectors: [], jobs: [], memory: [], vault: [], skills: [], ...extra });

test("words drop filler in English and Spanish and fold short plurals and accents", () => {
  assert.deepEqual(words("What are the open pull requests on GitHub?"), ["open", "pull", "request", "github"]);
  assert.deepEqual(words("¿Cuántas campañas tiene la cuenta?"), ["cuanta", "campana", "tiene", "cuenta"]);
  const rows = rank("spreadsheet model", [
    { name: "a", text: "Draft a deck" },
    { name: "b", text: "Build spreadsheets and a three statement model" },
  ], (item) => [[item.text, 1]]);
  assert.deepEqual(rows.map((row) => row.item.name), ["b"]);
});

test("the teammate whose plugin or job names the topic ranks above one that only mentions it", () => {
  const me = bot("me", "PA", { job: "Personal assistant" });
  const engineer = bot("eng", "Lead Engineer", { job: "Code, repositories, pull requests and deploys" });
  const finance = bot("fin", "Head of Finance", { job: "Budgets and invoices", prompt: "Sometimes the user mentions GitHub billing." });
  const paused = bot("off", "Old Engineer", { job: "Code and pull requests", status: "off" });
  const plugins = { promptInfo: (item) => (item.id === "eng" ? [{ id: "github", name: "GitHub" }] : []) };
  const ranked = rankTeam({ bots: [me, engineer, finance, paused] }, me, "Which pull requests are open on GitHub?", { plugins });
  assert.deepEqual(ranked.map((row) => row.bot.id), ["eng", "fin"]);
});

test("ask_team asks the best-placed teammate, moves on when it passes, and says who answered", async () => {
  const home = tmp();
  const me = bot("me", "PA", { job: "Personal assistant" });
  const engineer = bot("eng", "Lead Engineer", { job: "Code, pull requests and deploys" });
  const finance = bot("fin", "Head of Finance", { job: "Budgets, invoices and the bank" });
  const state = { bots: [me, engineer, finance], groups: [] };
  const sent = [];
  const engine = {
    enqueue: (target, input) => {
      sent.push({ target: target.id, input });
      const at = Date.now() + 5;
      // Finance passes; the engineer answers.
      writeConversation(home, target, [{ id: `r-${target.id}`, role: "assistant", at, ...(target.id === "fin" ? { content: "Not my area.", passed: true } : { content: "Two pull requests are open: #41 and #42." }) }]);
      return { promise: Promise.resolve() };
    },
    relayReply: () => assert.fail("no relay expected"),
    status: () => ({ busy: false }),
  };
  const ctx = { bot: me, state, home, engine, chain: [], waitMs: 30_000, save() {} };
  const result = await callCollaborationTool("ask_team", { question: "How much did the invoice for pull requests cost?", bot: "Head of Finance" }, ctx);
  assert.deepEqual(sent.map((item) => item.target), ["fin", "eng"]);
  assert.match(sent[0].input.text, /reply with only \[\[pass\]\]/);
  assert.equal(sent[0].input.routed, true);
  assert.deepEqual(sent[0].input.chain, ["me"]);
  assert.match(sent[1].input.text, /Already passed: Head of Finance\./);
  assert.match(result.text, /^Answer from Lead Engineer \(Code, pull requests and deploys\):\nTwo pull requests are open/);
  assert.match(result.text, /Asked first, passed: Head of Finance, Not my area\./);
});

test("ask_team gives a question nobody's job names to the main bot, and refuses a chain two agents deep", async () => {
  const home = tmp();
  const me = bot("me", "Researcher", { job: "Web research" });
  const chief = bot("chief", "Chief of Staff", { job: "Keeps the team moving", main: true });
  const state = { bots: [me, chief], groups: [] };
  const sent = [];
  const engine = {
    enqueue: (target, input) => {
      sent.push(target.id);
      writeConversation(home, target, [{ id: "r", role: "assistant", content: "The dentist appointment is on Thursday.", at: Date.now() + 5 }]);
      return { promise: Promise.resolve() };
    },
    status: () => ({ busy: false }),
  };
  const ctx = { bot: me, state, home, engine, chain: [], waitMs: 30_000, save() {} };
  const result = await callCollaborationTool("ask_team", { question: "When is the dentist appointment?" }, ctx);
  assert.deepEqual(sent, ["chief"]);
  assert.match(result.text, /^Answer from Chief of Staff/);
  await assert.rejects(callCollaborationTool("ask_team", { question: "When?" }, { ...ctx, chain: ["a", "b"] }), /already went through two agents/);
});

test("a reply that gives up counts as stuck; an answer does not", () => {
  assert.equal(soundsStuck("No tengo acceso a GitHub, así que no puedo ver los PRs."), true);
  assert.equal(soundsStuck("I don't have access to the billing dashboard."), true);
  assert.equal(soundsStuck("No sé cuál es el saldo de la cuenta."), true);
  assert.equal(soundsStuck("Hay 2 PRs abiertos: #41 y #42."), false);
  assert.equal(soundsStuck("Done. The deploy finished at 10:42."), false);
  assert.equal(soundsStuck(`${"x ".repeat(700)} no puedo`), false);
});

test("the prompt lists teammates' skills and tells the agent to ask the team before saying no", () => {
  const me = bot("me", "PA");
  const prompt = buildSystemPrompt(me, { teammates: [{ ...bot("eng", "Lead Engineer", { job: "Code" }), pluginNames: ["GitHub"], skillNames: ["github", "systematic-debugging"] }] });
  assert.match(prompt, /- Lead Engineer \(Personal\): Code Has: GitHub\. Skills: github, systematic-debugging\./);
  assert.match(prompt, /Before you tell the user you do not know something or cannot do it, ask the team\. ask_team/);
  assert.match(prompt, /reply with only \[\[pass\]\]/);
  assert.match(prompt, /find_skills searches it/);
});

// A stand-in OpenCode whose replies come from `reply(index, text)`.
function startOpenCode(reply) {
  const sessions = new Map();
  const prompts = [];
  const user = (text) => ({ info: { role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text }] });
  const assistant = (text) => ({ info: { role: "assistant", time: { created: Date.now(), completed: Date.now() + 1 } }, parts: [{ type: "text", text }] });
  let next = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? "" : JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (url.pathname === "/global/health") return send({ healthy: true });
      if (url.pathname === "/provider") return send({ all: [] });
      if (url.pathname === "/session/status") return send({});
      if (url.pathname === "/permission") return send([]);
      if (url.pathname.endsWith("/diff")) return send([]);
      if (req.method === "POST" && url.pathname === "/session") {
        const id = `ses${(next += 1)}`;
        sessions.set(id, []);
        return send({ id });
      }
      const match = url.pathname.match(/^\/session\/([^/]+)\/(message|prompt_async)$/);
      if (match && sessions.has(match[1])) {
        const messages = sessions.get(match[1]);
        if (req.method === "GET") return send(messages);
        const body = JSON.parse(raw || "{}");
        const text = (body.parts || []).map((part) => part.text || "").join("\n");
        prompts.push(text);
        messages.push(user(text), assistant(reply(prompts.length, text)));
        return match[2] === "prompt_async" ? send({}, 204) : send(messages.at(-1));
      }
      send({}, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, prompts, url: `http://127.0.0.1:${server.address().port}` })));
}

async function startApp() {
  const app = createApp({ home: tmp(), projectRoot });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  const waitEnd = async (botId, turnId) => {
    for (let i = 0; i < 150; i += 1) {
      const { events } = await api("GET", `/api/bots/${botId}/events?after=0`);
      const end = events.find((event) => event.type === "turn.end" && (!turnId || event.turnId === turnId));
      if (end) return end;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("turn did not end");
  };
  return { app, api, waitEnd };
}

test("a chat reply that gives up is asked once to check with the team; with no team call the first answer stands alone", async () => {
  // The agent gives up both times: it never calls ask_team.
  const opencode = await startOpenCode(() => "No tengo acceso a GitHub, no puedo ver los PRs.");
  const { app, api, waitEnd } = await startApp();
  try {
    const model = { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "" };
    const { bot: pa } = await api("POST", "/api/bots", { name: "PA", job: "Assistant", model });
    await api("POST", "/api/bots", { name: "Lead Engineer", job: "Code and GitHub", model });
    const { turnId } = await api("POST", `/api/bots/${pa.id}/messages`, { text: "¿Qué PRs hay abiertos?" });
    const end = await waitEnd(pa.id, turnId);
    assert.equal(opencode.prompts.length, 2);
    assert.match(opencode.prompts[1], /check whether a teammate can: call ask_team/);
    const replies = end.messages.filter((message) => message.role === "assistant");
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /no puedo ver los PRs/);
  } finally {
    app.close();
    opencode.server.close();
  }
});

test("a teammate that passes on a routed question keeps the marker out of its thread", async () => {
  const opencode = await startOpenCode(() => "[[pass]] Not my area; Lead Engineer has GitHub.");
  const { app, api, waitEnd } = await startApp();
  try {
    const model = { provider: "opencode", baseUrl: opencode.url, apiKey: "pw", model: "" };
    const { bot: finance } = await api("POST", "/api/bots", { name: "Head of Finance", job: "Money", model });
    const { bot: pa } = await api("POST", "/api/bots", { name: "PA", job: "Assistant", model });
    const engine = app.services.engine;
    const target = app.services.state.bots.find((item) => item.id === finance.id);
    const { promise } = engine.enqueue(target, { text: "Which PRs are open?", source: "bot", fromBotId: pa.id, fromBotName: "PA", chain: [pa.id], routed: true });
    await promise;
    await waitEnd(finance.id);
    const detail = await api("GET", `/api/bots/${finance.id}`);
    const reply = detail.conversation.filter((message) => message.role === "assistant").at(-1);
    assert.equal(reply.passed, true);
    assert.equal(reply.content, "Not my area; Lead Engineer has GitHub.");
    // A bot-to-bot turn is never nudged to ask the team.
    assert.equal(opencode.prompts.length, 1);
  } finally {
    app.close();
    opencode.server.close();
  }
});
