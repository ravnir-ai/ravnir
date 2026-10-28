import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { builtinToolsFor, callBuiltinTool } from "../server/computer.js";
import { createApp } from "../server/index.js";
import { ProposalStore } from "../server/proposals.js";
import { findPlugins, findSkills, settleSuggestions } from "../server/recommend.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";
process.env.RAVNIR_QUICK = "off";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-recommend-"));
const bot = (id, name, extra = {}) => ({ id, name, job: "x", group: "Personal", status: "on", connectors: [], jobs: [], memory: [], vault: [], skills: [], ...extra });

// A plugin manager with the parts the suggestion tools read.
function fakePlugins(connections = {}) {
  const plugins = [
    { id: "vercel", name: "Vercel", description: "Deploy projects and read build logs.", category: "devops", tags: ["deploy", "hosting"], featured: true, kind: "remote", auth: "oauth-dcr" },
    { id: "github", name: "GitHub", description: "Repositories, issues and pull requests.", category: "devops", tags: ["code"], featured: true, kind: "remote", auth: "token" },
    { id: "slow-sse", name: "Slowcast", description: "Deploy notes over SSE.", category: "devops", tags: [], kind: "remote", auth: "open", comingSoon: "Soon" },
  ];
  return { catalog: () => ({ plugins }), connections, runtime: () => ({ bin: "" }), promptInfo: () => [] };
}

test("find_skills finds a shop skill by what it is for and marks the ones the agent has", () => {
  const me = bot("me", "Researcher", { skills: ["grounded-citations"] });
  const found = findSkills(me, { query: "seo audit for a web page" });
  assert.match(found.text, /^\d+ skills? match "seo audit for a web page":\n- seo-audit \(research\)/);
  assert.match(findSkills(me, { query: "citations" }).text, /- grounded-citations \(research\): .*\[you have it\]/);
  assert.match(findSkills(me, { query: "" }).text, /^The Skills shop has \d+ skills:/);
  // Default skills are every agent's already; the shop does not offer them.
  assert.doesNotMatch(findSkills(me, { query: "" }).text, /- pdf-report /);
});

test("find_plugins says what is connected, what the agent has and who else has it", () => {
  const me = bot("me", "PA");
  const engineer = bot("eng", "Lead Engineer");
  const plugins = fakePlugins({ github: { id: "github", bots: ["eng"] } });
  const text = findPlugins(me, { query: "deploy" }, { plugins, state: { bots: [me, engineer] } }).text;
  assert.match(text, /- vercel \| Vercel: Deploy projects and read build logs\. \| not connected yet/);
  assert.match(text, /- slow-sse \| Slowcast: .* \| not available yet/);
  const git = findPlugins(me, { query: "pull requests" }, { plugins, state: { bots: [me, engineer] } }).text;
  assert.match(git, /- github \| GitHub: .* \| connected, you do not have it; teammates with it: Lead Engineer/);
});

test("suggest_skill makes one card per turn, never twice, and stays quiet a month after a dismiss", async () => {
  const home = tmp();
  const me = bot("me", "Researcher");
  const proposals = new ProposalStore({ home });
  const sent = [];
  const engine = { active: new Map([["me", { turnId: "t1" }]]), noteSuggestion: (b, record) => sent.push(record) };
  const ctx = { bot: me, state: { bots: [me] }, home, engine, proposals, notifications: { notify: async () => ({}) } };
  const first = await callBuiltinTool("suggest_skill", { name: "seo-audit", why: "You asked for a ranking check on the shop pages." }, ctx);
  assert.match(first.text, /^Suggested\./);
  const [record] = proposals.list({ status: "open" });
  assert.equal(record.kind, "skill");
  assert.deepEqual(record.change, { skill: "seo-audit" });
  assert.equal(record.turnId, "t1");
  assert.equal(sent.length, 1);
  assert.match((await callBuiltinTool("suggest_skill", { name: "seo-audit", why: "again" }, ctx)).text, /already waiting/);
  assert.match((await callBuiltinTool("suggest_skill", { name: "arxiv", why: "papers" }, ctx)).text, /One per turn/);

  proposals.decide(record.id, "dismiss");
  engine.active.set("me", { turnId: "t2" });
  assert.match((await callBuiltinTool("suggest_skill", { name: "seo-audit", why: "please" }, ctx)).text, /dismissed this suggestion on .* Do not suggest it again before/);
  await assert.rejects(callBuiltinTool("suggest_skill", { name: "seo-audits", why: "x" }, ctx), /There is no skill called seo-audits\. Closest: seo-audit/);
  assert.match((await callBuiltinTool("suggest_skill", { name: "pdf-report", why: "x" }, ctx)).text, /You already have pdf-report/);
});

test("suggest_plugin refuses one this server cannot connect, and settle closes an ask that came true", async () => {
  const home = tmp();
  const me = bot("me", "PA");
  const proposals = new ProposalStore({ home });
  const plugins = fakePlugins({});
  const state = { bots: [me] };
  const ctx = { bot: me, state, home, engine: { active: new Map([["me", { turnId: "t1" }]]) }, proposals, plugins };
  await assert.rejects(callBuiltinTool("suggest_plugin", { id: "slow-sse", why: "x" }, ctx), /cannot be connected on this server: not available yet/);
  const made = await callBuiltinTool("suggest_plugin", { id: "Vercel", why: "To read the failed build log." }, ctx);
  assert.match(made.text, /Vercel is not connected yet/);
  const [record] = proposals.list({ status: "open" });
  assert.equal(record.title, "Connect Vercel");
  assert.deepEqual(record.change, { plugin: "vercel" });

  plugins.connections.vercel = { id: "vercel", bots: ["me"] };
  settleSuggestions({ proposals, state, plugins });
  assert.equal(proposals.get(record.id).status, "accepted");
});

test("the plugin tools are offered only where there is a Plugins page", async () => {
  const me = bot("me", "PA");
  const without = (await builtinToolsFor(me, {})).map((tool) => tool.name);
  const withPlugins = (await builtinToolsFor(me, { plugins: fakePlugins() })).map((tool) => tool.name);
  for (const name of ["find_skills", "suggest_skill", "ask_team"]) assert.ok(without.includes(name), name);
  assert.ok(!without.includes("find_plugins") && !without.includes("suggest_plugin"));
  assert.ok(withPlugins.includes("find_plugins") && withPlugins.includes("suggest_plugin"));
});

test("Add on a skill card gives the skill; Connect on a plugin card gives the plugin right after sign-in", async () => {
  const app = createApp({ home: tmp(), projectRoot });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (method, pathname, body, expect = true) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (expect) assert.equal(response.ok, true, JSON.stringify(data));
    return { status: response.status, ...data };
  };
  try {
    const { bot: researcher } = await api("POST", "/api/bots", { name: "Researcher", job: "Research" });
    const { proposals, state } = app.services;
    const skill = proposals.create({ botId: researcher.id, botName: "Researcher", kind: "skill", title: "Add the SEO audit skill", why: "For the shop pages.", prompt: "Audit a page.", change: { skill: "seo-audit" } });
    const open = await api("GET", "/api/proposals?status=open");
    const card = open.items.find((item) => item.id === skill.id);
    assert.equal(card.skill.name, "seo-audit");
    assert.ok(card.skill.description);
    const added = await api("POST", `/api/proposals/${skill.id}`, { decision: "accept" });
    assert.equal(added.skill, "seo-audit");
    assert.equal(added.turnId, "");
    const detail = await api("GET", `/api/bots/${researcher.id}`);
    assert.ok(detail.bot.skills.includes("seo-audit"));
    assert.equal(detail.suggestions.find((item) => item.id === skill.id).status, "accepted");
    assert.match(detail.livePrompt, /seo-audit:/);

    // A plugin that is not connected yet: the agent is remembered for the sign-in.
    const plugin = proposals.create({ botId: researcher.id, botName: "Researcher", kind: "plugin", title: "Connect Vercel", why: "Build logs.", prompt: "Deploy.", change: { plugin: "vercel" } });
    const listed = (await api("GET", "/api/proposals?status=open")).items.find((item) => item.id === plugin.id);
    assert.equal(listed.plugin.connected, false);
    const given = await api("POST", `/api/proposals/${plugin.id}`, { decision: "accept" });
    assert.equal(given.connected, false);
    assert.deepEqual(state.pluginAgents.vercel, [researcher.id]);

    // A skill added from the shop closes the matching open ask on its own.
    const again = proposals.create({ botId: researcher.id, botName: "Researcher", kind: "skill", title: "Add the arXiv skill", why: "Papers.", prompt: "Papers.", change: { skill: "arxiv" } });
    await api("PUT", "/api/skills/arxiv/agents", { agents: [researcher.id] });
    const after = await api("GET", "/api/proposals?status=open");
    assert.ok(!after.items.some((item) => item.id === again.id));
    assert.equal(proposals.get(again.id).status, "accepted");
  } finally {
    app.close();
  }
});
