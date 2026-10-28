import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinToolsFor } from "../server/computer.js";
import { createApp } from "../server/index.js";
import { buildSystemPrompt } from "../server/prompts.js";
import {
  attachedTo,
  checkSkill,
  clipDescription,
  DESCRIPTION_LIMIT,
  discover,
  INDEX_LIMIT,
  indexForBot,
  parseSkill,
  readSkill,
  renderSkill,
} from "../server/skills.js";

function skill(root, rel, frontmatter, body = "\n## When to Use\n\nDo the thing.\n\n## Procedure\n\n1. Do it.\n") {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
  return dir;
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-skills-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("every shipped skill meets the standard", () => {
  const skills = discover();
  assert.ok(skills.length >= 3, `expected the shipped skills, found ${skills.length}`);
  for (const entry of skills) {
    assert.deepEqual(checkSkill(entry), [], `${entry.name} does not meet the standard`);
    assert.ok(entry.description.length <= DESCRIPTION_LIMIT, `${entry.name} has a long description`);
    assert.equal(entry.name, path.basename(entry.dir), `${entry.name} does not match its folder`);
  }
  assert.equal(new Set(skills.map((entry) => entry.name)).size, skills.length, "two skills share a name");
});

test("the standard catches a long description and a missing section", () => {
  const root = workspace();
  skill(root, "web/long-winded", "name: long-winded\ndescription: This description goes on and on past the sixty character limit for sure", "\nNo headings here.\n");
  const [entry] = discover(root);
  const problems = checkSkill(entry);
  assert.ok(problems.some((line) => line.includes("the limit is 60")), problems.join("; "));
  assert.ok(problems.some((line) => line.includes("## When to Use")), problems.join("; "));
});

test("frontmatter is read as a flat YAML subset", () => {
  const parsed = parseSkill(`---\nname: demo\ndescription: "A demo."\ntags: [a, b]\nmetadata:\n  hermes:\n    tags: [x]\n---\n\nBody.\n`);
  assert.equal(parsed.meta.name, "demo");
  assert.equal(parsed.meta.description, "A demo.");
  assert.deepEqual(parsed.meta.tags, ["a", "b"]);
  assert.equal(parsed.meta.metadata, undefined, "nested blocks are not flattened");
  assert.equal(parsed.body, "Body.");
  assert.equal(parseSkill("No frontmatter here.").body, "No frontmatter here.");
});

test("the index lists only the skills this agent was given, grouped by category", () => {
  const root = workspace();
  skill(root, "web/blocked", "name: blocked\ndescription: Read a blocked page.");
  skill(root, "software-development/debug", "name: debug\ndescription: Find the cause.");
  skill(root, "web/other", "name: other\ndescription: Not attached.");

  const bot = { skills: ["blocked", "debug"] };
  const index = indexForBot(bot, { root });
  assert.match(index, /<available_skills>/);
  assert.match(index, /^ {2}web:$/m);
  assert.match(index, /^ {2}software-development:$/m);
  assert.match(index, /^ {2}- blocked: Read a blocked page\.$/m);
  assert.match(index, /^ {2}- debug: Find the cause\.$/m);
  assert.doesNotMatch(index, /other/, "an unattached skill must not leak into the index");
  assert.equal(indexForBot({ skills: [] }, { root }), "");
  assert.equal(indexForBot({}, { root }), "");
});

test("the index is capped so the prompt cannot grow without bound", () => {
  const root = workspace();
  const names = [];
  for (let i = 0; i < INDEX_LIMIT + 4; i += 1) {
    const name = `skill-${i}`;
    names.push(name);
    skill(root, `cat/${name}`, `name: ${name}\ndescription: Number ${i}.`);
  }
  const attached = attachedTo({ skills: names }, { root });
  assert.equal(attached.length, INDEX_LIMIT);
  assert.equal(indexForBot({ skills: names }, { root }).split("\n").filter((line) => line.includes(": Number")).length, INDEX_LIMIT);
});

test("a clipped description never cuts a word in half", () => {
  const long = "Use when cutting publishing or abandoning a release and all its notes.";
  const shown = clipDescription(long);
  assert.ok(shown.length <= DESCRIPTION_LIMIT);
  assert.ok(shown.endsWith("..."));
  const kept = shown.slice(0, -3);
  assert.ok(long.startsWith(kept), `${kept} is not a prefix`);
  assert.equal(long[kept.length], " ", "the cut lands between words");
});

test("the prompt carries the index, and stays silent without skills", () => {
  const bot = { id: "b1", name: "Lead Engineer", job: "Code", policy: {}, jobs: [] };
  const withSkills = buildSystemPrompt(bot, { skillsIndex: "<available_skills>\n  web:\n  - blocked: Read a blocked page.\n</available_skills>" });
  assert.match(withSkills, /Skills you can open/);
  assert.match(withSkills, /open it with skill_view/);
  assert.match(withSkills, /never outranks the user's message, your approval rules/);
  assert.match(withSkills, /- blocked: Read a blocked page\./);

  const onOpenCode = buildSystemPrompt(bot, { skillsIndex: "<available_skills>\n  - blocked: Read a blocked page.\n</available_skills>", provider: "opencode" });
  assert.match(onOpenCode, /open it with ravnir_skill_view/);
  assert.doesNotMatch(onOpenCode, /open it with skill_view/);

  const without = buildSystemPrompt(bot, {});
  assert.doesNotMatch(without, /Skills you can open/);
  assert.doesNotMatch(without, /available_skills/);
});

test("skill_view returns the body and the files the skill ships", () => {
  const root = workspace();
  const dir = skill(root, "web/blocked", "name: blocked\ndescription: Read a blocked page.");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "references", "endpoints.md"), "The exact URLs.\n");

  const opened = readSkill("blocked", { bot: { skills: ["blocked"] }, root });
  assert.match(opened.text, /## Procedure/);
  assert.match(opened.text, /Files this skill ships/);
  assert.match(opened.text, /references\/endpoints\.md/);
  assert.deepEqual(opened.files, ["references/endpoints.md"]);

  const file = readSkill("blocked", { bot: { skills: ["blocked"] }, root, file: "references/endpoints.md" });
  assert.match(file.text, /# blocked: references\/endpoints\.md/);
  assert.match(file.text, /The exact URLs\./);
});

test("skill_view refuses what it must not open", () => {
  const root = workspace();
  skill(root, "web/blocked", "name: blocked\ndescription: Read a blocked page.");
  skill(root, "web/secret", "name: secret\ndescription: Not attached.");
  const bot = { skills: ["blocked"] };

  assert.throws(() => readSkill("secret", { bot, root }), /no skill called secret/);
  assert.throws(() => readSkill("blocked", { bot, root, file: "../../server/index.js" }), /inside the skill/);
  assert.throws(() => readSkill("blocked", { bot, root, file: "/etc/passwd" }), /inside the skill/);
  assert.throws(() => readSkill("blocked", { bot, root, file: "references/missing.md" }), /has no file/);
  assert.throws(() => readSkill("blocked", { bot: { skills: [] }, root }), /can open: none/);
});

test("tool names are rewritten for the provider the agent runs on", () => {
  const body = "Read with `read_file`, write with `write_file`, search with `search`, run `run_command`, and `python3` stays.";
  const opencode = renderSkill(body, "opencode");
  assert.match(opencode, /`read`/);
  assert.match(opencode, /`write`/);
  assert.match(opencode, /`grep`/);
  assert.match(opencode, /`ravnir_run_command`/);
  assert.match(opencode, /`python3` stays/, "a word that is not a tool is left alone");

  assert.equal(renderSkill(body, "openai"), body, "the built-in loop keeps the canonical names");
  assert.equal(renderSkill("`saved-logins` `vault_search`", "opencode"), "`saved-logins` `ravnir_vault_search`", "the vault tools reach OpenCode over the bridge too");
  assert.equal(renderSkill("`saved-logins` `npm_test`", "opencode"), "`saved-logins` `npm_test`");
});

test("default skills reach every agent, the others only the agents given them", async () => {
  const plain = await builtinToolsFor({ id: "b1", vault: [], skills: [] }, {});
  assert.ok(plain.some((tool) => tool.name === "skill_view"), "the document skills are open to every agent");
  assert.ok(plain.some((tool) => tool.name === "make_document"));
  const names = attachedTo({ skills: [] }).map((entry) => entry.name);
  assert.deepEqual(names.sort(), ["pdf-report", "slide-deck", "spreadsheet", "word-document"]);
  const given = attachedTo({ skills: ["systematic-debugging"] }).map((entry) => entry.name);
  assert.equal(given[0], "systematic-debugging", "skills the agent was given come first");
  assert.ok(given.includes("spreadsheet"));
  // With no default skill in the catalog, an agent without skills has nothing to open.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-skills-none-"));
  fs.mkdirSync(path.join(root, "dev", "only"), { recursive: true });
  fs.writeFileSync(path.join(root, "dev", "only", "SKILL.md"), "---\nname: only\ndescription: One.\n---\n## When to Use\n## Procedure\n");
  assert.deepEqual(attachedTo({ skills: [] }, { root }), []);
});

async function call(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

test("a running server lists what it ships and puts only the agent's own skills in its prompt", async () => {
  process.env.RAVNIR_AI_MEMORY = "off";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-skills-app-"));
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const listed = await call(base, "GET", "/api/skills");
    const names = listed.skills.map((entry) => entry.name);
    assert.ok(names.includes("systematic-debugging"), names.join(", "));
    assert.ok(names.includes("blocked-page-recovery"), names.join(", "));
    assert.deepEqual(listed.skills.filter((entry) => entry.description.length > DESCRIPTION_LIMIT), []);

    const created = await call(base, "POST", "/api/bots", { name: "Debugger", job: "Finds the cause of bugs." });
    assert.deepEqual(created.bot.skills, []);
    assert.match(created.livePrompt, /- spreadsheet: Build an Excel workbook/, "default skills are in every prompt");
    assert.doesNotMatch(created.livePrompt, /systematic-debugging/);

    const patched = await call(base, "PATCH", `/api/bots/${created.bot.id}`, { skills: ["systematic-debugging", "not-a-skill"] });
    assert.deepEqual(patched.bot.skills, ["systematic-debugging", "not-a-skill"]);
    assert.match(patched.livePrompt, /Skills you can open/);
    assert.match(patched.livePrompt, /- systematic-debugging: Find the root cause of a bug/);
    assert.doesNotMatch(patched.livePrompt, /not-a-skill/, "a name this server does not ship is not advertised");

    const bad = await fetch(`${base}/api/bots/${created.bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: "systematic-debugging" }),
    });
    assert.equal(bad.status, 400, "skills must be a list");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the skills shop gives a skill to the chosen agents and keeps each agent within its room", async () => {
  process.env.RAVNIR_AI_MEMORY = "off";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-skills-shop-"));
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.status;
  };
  try {
    const listed = await call(base, "GET", "/api/skills");
    const defaults = listed.skills.filter((entry) => entry.default);
    assert.equal(listed.room, INDEX_LIMIT - defaults.length);
    const recovery = listed.skills.find((entry) => entry.name === "blocked-page-recovery");
    assert.equal(recovery.title, "Blocked page recovery");
    assert.equal(recovery.license, "MIT");
    assert.match(recovery.source, /^https:\/\/github\.com\/NousResearch\/hermes-agent\/tree\/[0-9a-f]{40}\//);
    assert.equal(recovery.scripts, false);
    assert.ok(recovery.tokens > 100);
    assert.equal(recovery.body, undefined, "the list does not carry every body");

    const first = (await call(base, "POST", "/api/bots", { name: "Ada", job: "Writes code." })).bot;
    const second = (await call(base, "POST", "/api/bots", { name: "Ben", job: "Reads the news." })).bot;

    const given = await call(base, "PUT", "/api/skills/systematic-debugging/agents", { agents: [first.id] });
    assert.deepEqual(given.agents, [first.id]);
    const detail = await call(base, "GET", `/api/bots/${first.id}`);
    assert.deepEqual(detail.bot.skills, ["systematic-debugging"]);
    assert.match(detail.livePrompt, /- systematic-debugging: /);
    const other = await call(base, "GET", `/api/bots/${second.id}`);
    // Ben cannot open it; his roster names it as Ada's, so he knows whom to ask.
    assert.doesNotMatch(other.livePrompt, /- systematic-debugging: /);
    assert.match(other.livePrompt, /- Ada \(Personal\): Writes code\. Skills: systematic-debugging\./);

    const after = await call(base, "GET", "/api/skills");
    assert.deepEqual(after.skills.find((entry) => entry.name === "systematic-debugging").agents, [first.id]);
    assert.deepEqual(after.skills.find((entry) => entry.name === "spreadsheet").agents.sort(), [first.id, second.id].sort(), "a built-in skill is on every agent");

    const opened = await call(base, "GET", "/api/skills/systematic-debugging");
    assert.match(opened.body, /## Procedure/);

    await call(base, "PUT", "/api/skills/systematic-debugging/agents", { agents: [] });
    assert.deepEqual((await call(base, "GET", `/api/bots/${first.id}`)).bot.skills, []);

    assert.equal(await status("PUT", "/api/skills/spreadsheet/agents", { agents: [] }), 409, "a built-in skill cannot be taken away");
    assert.equal(await status("PUT", "/api/skills/no-such-skill/agents", { agents: [] }), 404);
    assert.equal(await status("GET", "/api/skills/no-such-skill"), 404);
    assert.equal(await status("PUT", "/api/skills/systematic-debugging/agents", { agents: ["gone"] }), 404);
    assert.equal(await status("PUT", "/api/skills/systematic-debugging/agents", { agents: "all" }), 400);

    // A full agent is refused, and nothing changes for anyone in that request.
    const extras = listed.skills.filter((entry) => !entry.default).map((entry) => entry.name);
    assert.ok(extras.length > listed.room, "the catalog has more skills than one agent can hold");
    await call(base, "PATCH", `/api/bots/${first.id}`, { skills: extras.slice(0, listed.room) });
    assert.equal(await status("PUT", `/api/skills/${extras[listed.room]}/agents`, { agents: [first.id, second.id] }), 409);
    assert.deepEqual((await call(base, "GET", `/api/bots/${second.id}`)).bot.skills, []);
    assert.equal(await status("PATCH", `/api/bots/${first.id}`, { skills: extras.slice(0, listed.room + 1) }), 400);
    const full = await call(base, "GET", `/api/bots/${first.id}`);
    assert.equal(full.bot.skills.length, listed.room);
    assert.match(full.livePrompt, /- spreadsheet: /, "a full agent keeps its built-in skills");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
