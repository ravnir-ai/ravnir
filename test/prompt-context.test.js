import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callCollaborationTool } from "../server/collaboration.js";
import { callBuiltinTool } from "../server/computer.js";
import { createJob } from "../server/jobs.js";
import { createApp } from "../server/index.js";
import { localProjects } from "../server/localProjects.js";
import { languageNote, messageLanguage } from "../server/owner.js";
import { buildSystemPrompt, teammatesFor } from "../server/prompts.js";
import { createBot } from "../server/state.js";
import { buildResolver } from "../server/vault/indexer.js";
import { callVaultTool } from "../server/vault/tools.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIXED = "Good morning. Can you check cinema times for Cartelera, Riverside? Es el cine Luna. Uh, I don't know, like sometime this Sunday afternoon.";

test("a mostly English message with a few Spanish words is English, and the other way round", () => {
  assert.equal(messageLanguage(MIXED), "en");
  assert.equal(messageLanguage("Mira cine luna horarios este domingo por la tarde"), "es");
  assert.equal(messageLanguage("Hola, ¿qué tal? ¿Me podés decir cómo va, eh, mi repo de Tienda? Tienda, sí."), "es");
  assert.equal(messageLanguage("ok"), "");
  assert.equal(languageNote(MIXED), "(Reply in English: this message is mostly English, even if your standing instructions name another language.)");
  assert.match(languageNote("mira los horarios del cine"), /^\(Reply in Spanish:/);
  assert.equal(languageNote("ok"), "(Reply in the language this message is mostly written in.)");
  assert.equal(languageNote(""), "");
});

test("the language rule outranks a language named in the standing instructions", () => {
  const prompt = buildSystemPrompt({ name: "PA", job: "x", policy: {}, prompt: "Respondes en español, breve." }, { owner: { name: "Alex", language: "es" } });
  assert.match(prompt, /Alex usually writes in Spanish\./);
  // The rule itself is said once, in How to answer, after the standing instructions.
  assert.equal(prompt.split("mostly written in").length, 2);
  assert.ok(prompt.indexOf("Reply in the language the user's latest message is mostly written in") > prompt.indexOf("Respondes en español"));
  // Without an owner language the rule is still there.
  assert.match(buildSystemPrompt({ name: "PA", job: "x", policy: {} }, {}), /Reply in the language the user's latest message/);
});

test("a plugin line names the account and the last check, and access questions get a live check", () => {
  const plugins = [{ id: "github", name: "GitHub", account: "octocat", status: "connected", shellEnv: ["GH_TOKEN", "GITHUB_TOKEN"] }];
  const prompt = buildSystemPrompt({ id: "b", name: "Lead", job: "x", policy: {} }, { plugins });
  assert.match(prompt, /- GitHub \(signed in as octocat\)\. Your GitHub login is in the shell: use run_command for gh and git push\. To see which account it is, run gh api user --jq \.login\./);
  assert.match(prompt, /When the user asks whether you have access to something/);
  const failing = buildSystemPrompt({ id: "b", name: "Lead", job: "x", policy: {} }, { plugins: [{ id: "notion", name: "Notion", status: "error", shellEnv: [] }] });
  assert.match(failing, /- Notion \(last check: error\)/);
  assert.equal(failing.includes("signed in as"), false);
});

test("the prompt asks for concrete answers, real capabilities, current sites and an offer to apply proposals", () => {
  const prompt = buildSystemPrompt({ name: "X", job: "j", memory: [], jobs: [], vault: [], policy: { shell: "ask", allow: [], files: "ask", logins: "ask" } }, {});
  assert.match(prompt, /Brief means no filler, not fewer facts/);
  assert.match(prompt, /When the user asks what you can do, answer from this prompt/);
  assert.match(prompt, /exactly what you will apply when the user says yes/);
  assert.match(prompt, /lapsed domain someone else bought/);
  assert.match(prompt, /confirm it is still open/);
});

test("saved logins come with the instruction to sign in and read the live page", () => {
  const prompt = buildSystemPrompt({ name: "Researcher", policy: {} }, { logins: [{ site: "https://app.example.com", username: "x" }] });
  assert.match(prompt, /- https:\/\/app\.example\.com as x\nWhen the user asks about something on one of these sites/);
  assert.match(prompt, /sign in with browser_saved_login/);
  assert.match(prompt, /Web search does not see pages behind a login/);
  const none = buildSystemPrompt({ name: "R", policy: {} }, { logins: [] });
  assert.match(none, /Your saved logins\n- None saved\.\n/);
  assert.equal(/sign in with browser_saved_login/.test(none), false);
});

test("teammates show the main bot and the plugins each one has", () => {
  const state = { bots: [{ id: "a", name: "Coordinator" }, { id: "b", name: "Engineer", job: "Everything technical", group: "Work" }, { id: "c", name: "Boss", main: true, group: "Work", job: "coordinates" }] };
  const plugins = { promptInfo: (bot) => (bot.id === "b" ? [{ id: "github", name: "GitHub" }] : []) };
  const teammates = teammatesFor(state, { id: "a" }, plugins);
  assert.deepEqual(teammates.map((item) => [item.name, item.pluginNames]), [["Engineer", ["GitHub"]], ["Boss", []]]);
  const prompt = buildSystemPrompt({ name: "Coordinator", policy: {} }, { teammates });
  assert.match(prompt, /- Engineer \(Work\): Everything technical Has: GitHub\./);
  assert.match(prompt, /- Boss \(main bot\) \(Work\): coordinates\n/);
  assert.match(prompt, /a teammate above has it/);
});

test("list_bots marks the main bot, says the roster is complete and counts routines", async () => {
  const daily = createJob({ name: "Daily", prompt: "check", cron: "0 9 * * *" });
  const old = { ...createJob({ name: "Old", prompt: "x", cron: "0 8 * * *" }), enabled: false };
  const state = {
    bots: [
      { id: "a", name: "Boss", main: true, group: "Work", job: "coordinates", jobs: [daily, old] },
      { id: "b", name: "Helper", group: "Side", job: "helps", jobs: [] },
    ],
  };
  const engine = { status: () => ({ busy: false }) };
  const asHelper = (await callCollaborationTool("list_bots", {}, { bot: { id: "b" }, state, engine })).text;
  assert.match(asHelper, /^2 agents on this server\. This is the whole roster/);
  assert.match(asHelper, /- Boss \(main\) \| Work \| on \| coordinates \| routines: 1 on, 1 paused/);
  assert.match(asHelper, /- Helper \(you\) \| Side \| on \| helps \| routines: 0 on, 0 paused/);
  const asBoss = (await callCollaborationTool("list_bots", {}, { bot: { id: "a" }, state, engine })).text;
  assert.match(asBoss, /- Boss \(you, main\) \|/);
  const grouped = (await callCollaborationTool("list_bots", { group: "Work" }, { bot: { id: "a" }, state, engine })).text;
  assert.match(grouped, /^1 agent in Work\.\n/);
});

test("list_jobs shows another agent's routines or all of them, read-only", async () => {
  const own = createBot({ name: "Boss", job: "coordinates" });
  own.jobs = [createJob({ name: "Daily check", prompt: "check", cron: "0 9 * * *" }), { ...createJob({ name: "Old", prompt: "x", cron: "@daily" }), enabled: false }];
  const other = createBot({ name: "Scout", job: "scouts" });
  other.jobs = [{ ...createJob({ name: "Weekly scout", prompt: "look", cron: "0 10 * * 1", createdBy: "bot" }), enabled: false }];
  const idle = createBot({ name: "Idle", job: "nothing" });
  const state = { bots: [own, other, idle] };
  const ctx = { bot: own, state, browser: null, save() {} };
  const all = (await callBuiltinTool("list_jobs", { bot: "all" }, ctx)).text;
  assert.match(all, /## Boss \(you\)\n/);
  assert.match(all, /## Scout\n- \S+ \| Weekly scout \|.*\| paused \| set by the agent/);
  assert.match(all, /No jobs: Idle/);
  const one = (await callBuiltinTool("list_jobs", { bot: "scout" }, ctx)).text;
  assert.match(one, /Weekly scout/);
  assert.equal(one.includes("Daily check"), false);
  assert.match((await callBuiltinTool("list_jobs", { bot: "nobody here" }, ctx)).text, /No agent matches "nobody here"\. Use list_bots\./);
  // Without bot it is the agent's own list, as before.
  const mine = (await callBuiltinTool("list_jobs", {}, ctx)).text;
  assert.match(mine, /Daily check/);
  assert.equal(mine.includes("Weekly scout"), false);
});

test("scheduling lists paused jobs, says setting up is the task, and warns about a job at the same time", async () => {
  const bot = createBot({ name: "Researcher", job: "research" });
  bot.jobs = [{ ...createJob({ name: "Morning radar", prompt: "Hidden instruction", cron: "0 9 * * *" }), enabled: false }];
  const prompt = buildSystemPrompt(bot, { jobs: bot.jobs });
  assert.match(prompt, /- Morning radar \(Every day at 09:00, paused\)/);
  assert.equal(prompt.includes("Hidden instruction"), false);
  assert.match(prompt, /Setting up the schedule is the whole task/);
  assert.match(prompt, /bot: "all" shows every agent's/);
  const result = await callBuiltinTool("create_job", { name: "Daily radar", prompt: "check", cron: "0 9 * * *" }, { bot, state: { bots: [bot] }, browser: null, save() {} });
  assert.match(result.text, /Note: you already have "Morning radar" \(\w{8}, paused\) at the same time/);
  const other = await callBuiltinTool("create_job", { name: "Evening", prompt: "check", cron: "0 21 * * *" }, { bot, state: { bots: [bot] }, browser: null, save() {} });
  assert.equal(other.text.includes("already have"), false);
});

test("local project folders come from config, and host agents are told to read them directly", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-local-projects-"));
  try {
    fs.mkdirSync(path.join(tmp, "shop", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "blog"));
    fs.writeFileSync(path.join(tmp, "file.txt"), "x");
    const shop = path.join(tmp, "shop");
    assert.deepEqual(localProjects({ env: {} }), []);
    assert.deepEqual(localProjects({ env: { RAVNIR_LOCAL_PROJECTS: "off" } }), []);
    assert.deepEqual(
      localProjects({ env: { RAVNIR_LOCAL_PROJECTS: `x=/does/not/exist; s=${shop}; ${path.join(tmp, "blog")}; f=${path.join(tmp, "file.txt")}; rel=shop` } }),
      [{ name: "s", path: shop }, { name: "blog", path: path.join(tmp, "blog") }],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const context = { localProjects: [{ name: "shop", path: "/srv/shop" }], hostName: "box-1" };
  const prompt = buildSystemPrompt({ name: "Lead", policy: {} }, context);
  assert.match(prompt, /This machine is box-1\. Project folders on it: shop \(\/srv\/shop\)\. Read them right here with run_command, no ssh/);
  assert.match(prompt, /git -C <path> log/);
  assert.equal(buildSystemPrompt({ name: "Lead", policy: {} }, { ...context, ownComputer: true }).includes("Project folders on it"), false);
  assert.equal(buildSystemPrompt({ name: "Lead", policy: {} }, {}).includes("Project folders on it"), false);

  const before = process.env.RAVNIR_SERVERS;
  process.env.RAVNIR_SERVERS = "box=This machine";
  try {
    assert.match(buildSystemPrompt({ name: "Lead", policy: {} }, context), /Files on this one, including the project folders above, you read with your own terminal\./);
    assert.equal(buildSystemPrompt({ name: "Lead", policy: {} }, {}).includes("you read with your own terminal"), false);
  } finally {
    if (before === undefined) delete process.env.RAVNIR_SERVERS;
    else process.env.RAVNIR_SERVERS = before;
  }
});

test("vault notes resolve with spaces for hyphens, and a miss names close notes", async () => {
  const resolve = buildResolver([{ path: "Agents/Head-of-Internal-Comms.md" }, { path: "Agents/PA.md" }, { path: "Projects/Café_Plan.md" }]);
  assert.equal(resolve("Agents/Head of Internal Comms.md"), "Agents/Head-of-Internal-Comms.md");
  assert.equal(resolve("head of internal comms"), "Agents/Head-of-Internal-Comms.md");
  assert.equal(resolve("Projects/Cafe Plan"), "Projects/Café_Plan.md");
  assert.equal(resolve("Agents/Nobody.md"), null);

  const rows = [{ path: "Agents/Lead-Eng.md" }, { path: "Agents/PA.md" }, { path: "Projects/Lead.md" }];
  const vault = { available: true, read: () => null, links: () => null, notes: (prefix = "") => rows.filter((row) => row.path.startsWith(prefix)) };
  const read = await callVaultTool("vault_read", { note: "Agents/Lead Engineer.md" }, { vault });
  assert.equal(read.text, 'No vault note matches "Agents/Lead Engineer.md". Close names: Agents/Lead-Eng.md. Use vault_search to find it.');
  const links = await callVaultTool("vault_links", { note: "Agents/Xyz.md" }, { vault });
  assert.equal(links.text, 'No vault note matches "Agents/Xyz.md". Close names: Agents/Lead-Eng.md, Agents/PA.md. Use vault_search to find it.');
  const bare = await callVaultTool("vault_read", { note: "nothing" }, { vault: { available: true, read: () => null } });
  assert.equal(bare.text, 'No vault note matches "nothing". Use vault_search to find it.');
});

// A stand-in OpenAI-compatible model that records every request and answers with one line.
function startRecordingModel() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end("{}");
      }
      requests.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test("the user's message reaches the model with a note naming its language, and the thread keeps only the user's text", async () => {
  process.env.RAVNIR_AI_MEMORY = "off";
  process.env.RAVNIR_QUICK = "off";
  const model = await startRecordingModel();
  const app = createApp({ home: fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-lang-")), projectRoot });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  try {
    const { bot } = await api("POST", "/api/bots", { name: "PA", job: "Assistant", prompt: "Respondes en español, breve.", model: { provider: "openai", baseUrl: model.url, model: "m" } });
    const { turnId } = await api("POST", `/api/bots/${bot.id}/messages`, { text: MIXED });
    let end;
    for (let i = 0; i < 150 && !end; i += 1) {
      const { events } = await api("GET", `/api/bots/${bot.id}/events?after=0`);
      end = events.find((event) => event.type === "turn.end" && event.turnId === turnId);
      if (!end) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(end, "turn ended");
    const last = model.requests.at(-1).messages.filter((message) => message.role === "user").at(-1);
    assert.equal(last.content, `${MIXED}\n\n(Reply in English: this message is mostly English, even if your standing instructions name another language.)`);
    const { conversation } = await api("GET", `/api/bots/${bot.id}`);
    const stored = conversation.find((message) => message.role === "user");
    assert.equal(stored.content, MIXED);
  } finally {
    app.close();
    model.server.close();
  }
});
