import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { conversationSize, safeKeepIndex, shouldCompact } from "../server/compaction.js";
import { createGroup, deleteGroup, renameGroup } from "../server/collaboration.js";
import { namedDiff, unifiedDiff } from "../server/diff.js";
import { createJob, describeCron, nextCron, validateCron } from "../server/jobs.js";
import { McpConnection } from "../server/mcp.js";
import { buildSystemPrompt } from "../server/prompts.js";
import { createAccumulator, endpoint, finalize, pushChunk } from "../server/providers/openai.js";
import { assistantsAfterLastUser, extractAgents, extractModels, isSessionIdle, normalizeDiffs, sessionLooksStale, textAfterLastUser, toolParts } from "../server/providers/opencode.js";
import { SecretStore } from "../server/secrets.js";
import { createBot, ensureGroups, loadState, normalizeAvatar, publicBot, suggestAvatar } from "../server/state.js";
import { compareSnapshots, editFile, resolveInside, snapshotWorkspace, writeFile } from "../server/workspace.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("unified diff shows an edit and a new file", () => {
  const edited = unifiedDiff("note.txt", "one\ntwo\n", "one\nthree\n");
  assert.match(edited.patch, /--- a\/note\.txt/);
  assert.match(edited.patch, /-two/);
  assert.match(edited.patch, /\+three/);
  assert.equal(edited.status, "modified");

  const created = unifiedDiff("hello.txt", "", "hello\n");
  assert.equal(created.status, "added");
  assert.match(created.patch, /\+hello/);
  assert.equal(unifiedDiff("same.txt", "a\n", "a\n").patch, "");
  assert.match(namedDiff("Scout", "Builder", "one", "two"), /--- Scout/);
  assert.match(namedDiff("Scout", "Builder", "one", "two"), /\+\+\+ Builder/);
});

test("live prompt carries name, job, memory, and computer", () => {
  const bot = createBot({ name: "Researcher", job: "Reads primary sources.", group: "Lab" });
  assert.equal(bot.group, "Lab");
  assert.equal(bot.prompt.includes("Scout"), false);
  bot.memory.push({ id: "m1", text: "The launch is on Friday." });
  bot.vault.push({ id: "v1", site: "example.com", username: "ada" });
  const prompt = buildSystemPrompt(bot, {
    workspace: "/tmp/work",
    appUrl: "http://127.0.0.1:3847",
    connectors: [{ name: "GitHub", enabled: true, status: "connected", tools: [{}, {}] }],
    jobs: [{ name: "Morning brief", cron: "0 8 * * *", prompt: "Brief me", enabled: true }],
    logins: bot.vault,
    browserAvailable: true,
  });
  assert.match(prompt, /You are Researcher/);
  assert.match(prompt, /Reads primary sources/);
  assert.match(prompt, /The launch is on Friday/);
  assert.match(prompt, /example\.com as ada/);
  assert.match(prompt, /GitHub: 2 tools connected/);
  assert.match(prompt, /Morning brief \(Every day at 08:00\)/);
  assert.match(prompt, /\/tmp\/work/);
  assert.match(prompt, /Your teammates/);
  assert.match(prompt, /Your groups/);
  const view = publicBot(bot, { home: "/tmp/ravnir-home" });
  assert.equal(view.group, "Lab");
  assert.equal("apiKey" in view.model, false);
});

test("bot avatars keep a chosen look, migrate old ones, and normalize unknown parts", () => {
  const chosen = {
    shape: "gem", material: "glass", color: "#3e5a4c", face: "visor", eyes: "pill", glow: "#ffe08a", mouth: "smile",
    extra: "crown", cheeks: true, personality: "shy", eyeSize: 0.4, eyeGap: -0.2, faceY: 0.1, mark: "terminal",
  };
  const bot = createBot({ name: "Moss", avatar: chosen });
  assert.deepEqual(bot.avatar, chosen);
  assert.deepEqual(publicBot(bot, { home: "/tmp/ravnir-home" }).avatar, chosen);
  const legacy = { blob: "orb", bean: "capsule", cloud: "orb", drop: "gem", pebble: "cube" };
  for (const [old, shape] of Object.entries(legacy)) {
    const look = normalizeAvatar({ shape: old, eyes: "sleepy", mouth: "cat", extra: "bow" }, "moss", "#B9CAB2");
    assert.equal(look.shape, shape);
    assert.equal(look.color, "#b9cab2");
    assert.match(look.eyes, /^(dot|pill|ring|pixel|arc)$/);
    assert.equal(look.mouth, "none");
    assert.equal(look.extra, "none");
  }
  const fallback = normalizeAvatar({ shape: "dragon", material: "lava", color: "red", mark: "skull", eyeSize: 9, faceY: "x" }, "moss");
  assert.equal(fallback.shape, "raven", "ravens are the default body");
  assert.equal(fallback.face, "surface");
  assert.equal(fallback.material, "matte");
  assert.equal(fallback.color, "");
  assert.equal(fallback.mark, "initials");
  assert.equal(fallback.eyeSize, 1);
  assert.equal(fallback.faceY, 0);
  assert.deepEqual(normalizeAvatar(null, "moss"), normalizeAvatar(undefined, "moss"));
  assert.deepEqual(normalizeAvatar(null, "moss"), normalizeAvatar({}, "moss"));
});

test("new and pre-face agents get a look that matches their job", () => {
  assert.equal(suggestAvatar({ name: "Lead Engineer" }).shape, "screen");
  assert.equal(suggestAvatar({ name: "Lead Engineer" }).extra, "antenna");
  assert.equal(suggestAvatar({ name: "Head of Finance" }).extra, "glasses");
  assert.equal(suggestAvatar({ name: "Scout", job: "Researches the market" }).extra, "glasses");
  assert.equal(suggestAvatar({ name: "Chief of Staff" }).extra, "crown");
  const made = createBot({ name: "Lead Engineer", job: "Ships code" });
  assert.equal(made.avatar.shape, "screen");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-avatar-"));
  const old = { ...createBot({ name: "Head of Finance", color: "#2f5d8c" }), avatar: { shape: "ring", material: "glass", color: "", mark: "chart" } };
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ version: 1, bots: [old] }));
  const loaded = loadState({ home, secrets: new SecretStore(home) }).bots.find((item) => item.id === old.id);
  assert.equal(loaded.avatar.shape, "ring");
  assert.equal(loaded.avatar.material, "glass");
  assert.equal(loaded.avatar.color, "");
  assert.equal(loaded.avatar.mark, "chart");
  assert.equal(loaded.avatar.extra, "glasses");
  assert.equal(loaded.avatar.personality, "focused");
});

test("client avatar module matches the server and renders every part", () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(new URL("../public/avatar.js", import.meta.url), "utf8"), context);
  const avatars = context.RavnirAvatar;
  for (const input of [null, { shape: "pebble", eyes: "round" }, { shape: "ring", material: "matte", color: "#2F5D8C", mark: "bolt", eyes: "spark", extra: "orbit" }]) {
    assert.deepEqual({ ...avatars.normalize(input, { seed: "moss", color: "#a8c9e8" }) }, normalizeAvatar(input, "moss", "#a8c9e8"));
  }
  assert.equal(avatars.initials("Chief of Staff"), "CS");
  assert.equal(avatars.initials("LaunchPad"), "LP");
  assert.equal(avatars.initials("PA"), "PA");
  assert.equal(avatars.initials("Scout"), "S");
  const ids = new Set();
  const check = (svg) => {
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
    const id = svg.match(/id="(tbav[0-9a-z]+)-/)[1];
    assert.equal(ids.has(id), false);
    ids.add(id);
  };
  for (const [shape] of avatars.SHAPES) {
    for (const [material] of avatars.MATERIALS) {
      for (const [face] of avatars.FACES) {
        const svg = avatars.markup({ shape, material, face, color: "#cbc3e6" }, { name: "Lead Engineer" });
        check(svg);
        assert.equal(/class="tb-av-mark"/.test(svg), face === "none" || (shape === "raven" && face === "visor"));
        assert.equal(/class="tb-av-face"/.test(svg), face !== "none");
      }
    }
    for (const [extra] of avatars.EXTRAS) check(avatars.markup({ shape, extra, eyes: "cyclops", mouth: "grin", cheeks: true }, { name: "Moss" }));
  }
  for (const [eyes] of avatars.EYES) {
    for (const [mouth] of avatars.MOUTHS) check(avatars.markup({ shape: "orb", eyes, mouth, face: "surface", eyeSize: 1, eyeGap: -1, faceY: 1 }, { name: "Moss" }));
  }
  for (const [name] of avatars.PRESETS) assert.ok(avatars.preset(name));
  assert.doesNotMatch(avatars.markup({ shape: "orb", face: "none" }, { name: "Moss", size: 20 }), /tb-av-mark/);
});

test("groups normalize, rename, and move bots", () => {
  const state = { bots: [createBot({ name: "One", group: "Work" }), createBot({ name: "Two", group: "Personal" })] };
  ensureGroups(state);
  assert.equal(state.groups.some((group) => group.name === "Work"), true);
  assert.equal(state.groups.some((group) => group.name === "Personal"), true);
  const created = createGroup(state, "Research");
  assert.equal(created.created, true);
  createGroup(state, "research");
  assert.equal(state.groups.filter((group) => group.name.toLowerCase() === "research").length, 1);
  renameGroup(state, created.group.id, "Lab");
  assert.equal(created.group.name, "Lab");
  state.bots[0].group = "Lab";
  const removed = deleteGroup(state, created.group.id);
  assert.equal(removed.moved, 1);
  assert.equal(state.bots[0].group, "Personal");
});

test("compaction helpers keep whole tool exchanges", () => {
  const messages = [{ role: "user", content: "x".repeat(1_000) }];
  for (let index = 0; index < 30; index += 1) messages.push({ role: "assistant", content: "reply", at: index });
  assert.equal(shouldCompact(messages, 1_000), true);
  assert.equal(conversationSize(messages) > 1_000, true);
  const withTools = [
    { role: "user", content: "start" },
    { role: "assistant", content: "", toolCalls: [{ name: "echo" }] },
    { role: "tool", content: "result" },
    { role: "assistant", content: "done" },
  ];
  assert.equal(safeKeepIndex(withTools, 2), 1);
  assert.equal(safeKeepIndex([{ role: "tool", content: "orphan" }], 1), 1);
});

test("workspace paths cannot escape and snapshots find edits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-ws-"));
  assert.equal((await resolveInside(dir, ".")).rel, ".");
  await assert.rejects(() => resolveInside(dir, "../outside.txt"), /outside the workspace/);
  const written = await writeFile(dir, "hello.txt", "hello\n");
  assert.equal(written.diff.status, "added");
  const edited = await editFile(dir, "hello.txt", "hello", "hi");
  assert.match(edited.diff.patch, /-hello/);
  assert.match(edited.diff.patch, /\+hi/);
  await assert.rejects(() => editFile(dir, "hello.txt", "missing", "x"), /not found/);
  const before = await snapshotWorkspace(dir);
  fs.writeFileSync(path.join(dir, "hello.txt"), "hi again\n");
  fs.writeFileSync(path.join(dir, "later.txt"), "new\n");
  const after = await snapshotWorkspace(dir);
  const diffs = compareSnapshots(before, after);
  assert.equal(diffs.some((diff) => diff.path === "hello.txt"), true);
  assert.equal(diffs.some((diff) => diff.path === "later.txt"), true);
});

test("the vault encrypts secrets at rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-vault-"));
  const store = new SecretStore(dir);
  store.set("vault:bot:entry", "correct horse battery staple");
  const raw = fs.readFileSync(path.join(dir, "secrets.enc"), "utf8");
  assert.equal(raw.includes("correct horse battery staple"), false);
  const second = new SecretStore(dir);
  assert.equal(second.get("vault:bot:entry"), "correct horse battery staple");
  assert.equal(second.get("missing", "fallback"), "fallback");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "master.key")).mode & 0o777, 0o600);
  }
});

test("openai stream chunks become tool calls", () => {
  const acc = createAccumulator();
  pushChunk(acc, {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: "{\"path\":" } }],
      },
    }],
  });
  pushChunk(acc, {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }],
      },
    }],
  });
  const done = finalize(acc);
  assert.equal(done.toolCalls[0].name, "write_file");
  assert.deepEqual(done.toolCalls[0].arguments, { path: "a.txt" });
  assert.equal(endpoint("http://127.0.0.1:11434/v1", "models"), "http://127.0.0.1:11434/v1/models");
  assert.equal(endpoint("http://127.0.0.1:11434", "models"), "http://127.0.0.1:11434/v1/models");
});

test("opencode payloads normalize models, agents, diffs, and tools", () => {
  const models = extractModels({
    all: [{ id: "anthropic", name: "Anthropic", models: { "claude": { id: "claude", name: "Claude" } } }],
  });
  assert.equal(models[0].id, "anthropic/claude");
  const v2 = extractModels({ data: [{ providerID: "openai", modelID: "gpt", name: "GPT" }] });
  assert.equal(v2[0].id, "openai/gpt");
  const filtered = extractModels({
    connected: ["anthropic"],
    all: [
      { id: "anthropic", name: "Anthropic", models: { claude: { name: "Claude" } } },
      { id: "other", name: "Other", models: { small: { name: "Small" } } },
    ],
  });
  assert.equal(filtered.find((model) => model.id === "anthropic/claude").connected, true);
  assert.equal(filtered.find((model) => model.id === "other/small").connected, false);
  const agents = extractAgents({ data: [{ id: "build", name: "Build", system: "edit carefully", hidden: false, mode: "primary" }] });
  assert.equal(agents[0].system, "edit carefully");
  const diffs = normalizeDiffs({ data: [{ file: "a.js", patch: "@@\n+line\n", additions: 1, deletions: 0, status: "modified" }] });
  assert.equal(diffs[0].path, "a.js");
  const transcript = textAfterLastUser([
    { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
  ]);
  assert.equal(transcript, "hello");
  assert.equal(isSessionIdle({}, "ses_1"), true);
  assert.equal(isSessionIdle({ ses_1: { type: "busy" } }, "ses_1"), false);
  assert.equal(isSessionIdle({ ses_1: { type: "idle" } }, "ses_1"), true);
  const poisoned = [
    { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "assistant", time: { created: 1 } }, parts: [] },
    { info: { role: "user" }, parts: [{ type: "text", text: "again" }] },
  ];
  assert.equal(assistantsAfterLastUser(poisoned).length, 0);
  assert.equal(sessionLooksStale(poisoned, true), true);
  assert.equal(sessionLooksStale(poisoned, false), false);
  assert.equal(sessionLooksStale([
    { info: { role: "user" } },
    { info: { role: "assistant", time: { completed: 2 } } },
  ], true), false);
  const tools = toolParts([{
    info: { role: "assistant" },
    parts: [{ type: "tool", callID: "call_1", tool: "bash", state: { status: "completed", input: { command: "pwd" }, output: "/tmp" } }],
  }]);
  assert.equal(tools[0].name, "bash");
  assert.equal(tools[0].output, "/tmp");
  const failed = toolParts([{
    info: { role: "assistant" },
    parts: [{ type: "tool", callID: "call_2", tool: "ravnir_gmail__search_email", state: { status: "error", input: {}, error: "MCP server is not running." } }],
  }]);
  assert.equal(failed[0].error, true);
  assert.equal(failed[0].output, "MCP server is not running.");
});

test("cron expressions schedule and reject bad input", () => {
  assert.equal(validateCron("*/15 * * * *"), "*/15 * * * *");
  assert.match(describeCron("*/15 * * * *"), /15 minutes/);
  const from = new Date(2026, 9, 21, 10, 7, 0).getTime();
  const next = new Date(nextCron("*/15 * * * *", from));
  assert.equal(next.getHours(), 10);
  assert.equal(next.getMinutes(), 15);
  const weekday = new Date(nextCron("0 8 * * 1-5", new Date(2026, 9, 21, 9, 0, 0).getTime()));
  assert.equal(weekday.getHours(), 8);
  assert.equal(weekday.getDate(), 22);
  assert.throws(() => validateCron("not a cron"), /five-field/);
  assert.throws(() => validateCron("61 * * * *"), /outside/);
  const job = createJob({ name: "Check", cron: "@hourly", prompt: "Do it" });
  assert.equal(job.nextRunAt > Date.now(), true);
});

test("MCP stdio client lists and calls a tool", async () => {
  const connector = {
    id: "mock",
    name: "Mock",
    transport: "stdio",
    command: process.execPath,
    args: [path.join(root, "scripts", "mock-mcp.js")],
  };
  const client = new McpConnection({ connector, cwd: root });
  try {
    const tools = await client.connect();
    assert.equal(tools[0].name, "echo");
    const result = await client.callTool("echo", { text: "hello" });
    assert.equal(result.text, "echo: hello");
  } finally {
    client.close();
  }
});

test("web helpers read pages as text and refuse private addresses", async () => {
  const { htmlToText, isPrivateAddress, normalizeHttpUrl } = await import("../server/web.js");
  const text = htmlToText("<html><head><title>Hi &amp; bye</title><script>alert(1)</script></head><body><h1>Hello</h1><p>World &ntilde;</p></body></html>");
  assert.match(text, /Hello/);
  assert.match(text, /World ñ/);
  assert.doesNotMatch(text, /alert/);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("192.168.1.4"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false); // check-public: allow ipv4 (a well-known public resolver)
  assert.equal(normalizeHttpUrl("example.com").href, "https://example.com/");
  assert.throws(() => normalizeHttpUrl("file:///etc/passwd"), /http or https/);
});
