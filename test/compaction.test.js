import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SUMMARY_FOOTER,
  SUMMARY_MAX_CHARS,
  auditIdentifiers,
  buildTranscript,
  collectBuilt,
  compactConversation,
  extractIdentifiers,
  flushDurableFacts,
  parseDurableFacts,
  readArchive,
} from "../server/compaction.js";
import { callCollaborationTool, collaborationToolDefinitions } from "../server/collaboration.js";
import { readConversation, writeConversation } from "../server/state.js";

const KEPT = "### Identifiers (kept by code)";

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-compaction-"));
}

function makeBot(id = "bot-a", name = "Nova") {
  return { id, name, model: { provider: "openai" }, memory: [], remote: {} };
}

let clock = 1_790_000_000_000;
function msg(role, content, extra = {}) {
  clock += 60_000;
  return { id: `${role}-${clock}`, role, content, at: clock, ...extra };
}

// 4 recent messages are kept with keep: 4, so everything before them is the older span.
function seed(home, bot, older, recent = ["recent one", "recent two", "recent three", "recent four"]) {
  const tail = recent.map((text, index) => msg(index % 2 ? "assistant" : "user", text));
  writeConversation(home, bot, [...older, ...tail]);
  return tail;
}

function run(home, bot, summarizer, extra = {}) {
  return compactConversation({ bot, home, directory: home, force: true, keep: 4, summarizer, ...extra });
}

function recorder(reply = "### Goal and context\nKeep going.\n\n### Durable facts\n- none") {
  const calls = [];
  const summarizer = async (input) => {
    calls.push(input);
    return typeof reply === "function" ? reply(input) : reply;
  };
  return { calls, summarizer };
}

const OLD_STYLE = (covers, body) => `## Compacted context\n_Covers ${covers} earlier messages._\n\n${body}\n\n${SUMMARY_FOOTER}`;

test("old tool outputs are masked before the summarizer sees them", async () => {
  const home = makeHome();
  const bot = makeBot();
  const call = { id: "c1", name: "read_file", arguments: { path: "src/app/main.js" } };
  seed(home, bot, [
    msg("user", "please read the main file"),
    msg("assistant", "", { toolCalls: [call] }),
    msg("tool", "SECRET_TOOL_OUTPUT line one\nline two", { id: "tool-msg-1", name: "read_file", toolCallId: "c1" }),
    msg("assistant", "It exports main()."),
  ]);
  const { calls, summarizer } = recorder();
  const result = await run(home, bot, summarizer);
  assert.equal(result.compacted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt.includes("SECRET_TOOL_OUTPUT"), false);
  assert.match(calls[0].prompt, /tool read_file: output archived \(id tool-msg-1\)/);
  assert.match(calls[0].prompt, /assistant called read_file \{"path":"src\/app\/main\.js"\}/);
  const archived = readArchive(home, bot);
  assert.equal(archived.find((row) => row.id === "tool-msg-1").content.startsWith("SECRET_TOOL_OUTPUT"), true);
});

test("identifiers are extracted without mistaking URL parts, emails, or encodings", () => {
  const found = extractIdentifiers([
    "See /Users/ada/Projects/app/server/index.js and ./scripts/run.mjs, also src/app/page.tsx and package.json.",
    "Docs at https://example.com/docs/a/b.html?x=1. Mail ada@example.com or ping @grace.",
    "Commit 3f2a9c1e5b and id 0b1f6c2e-1111-4222-8333-444455556666, ticket ABC-123, UTF-8 and SHA-256 are not tickets.",
    "node.js and Next.js are products, not files.",
  ].join("\n"));
  assert.deepEqual(found.urls, ["https://example.com/docs/a/b.html?x=1"]);
  for (const expected of ["/Users/ada/Projects/app/server/index.js", "./scripts/run.mjs", "src/app/page.tsx", "package.json"]) {
    assert.equal(found.paths.includes(expected), true, expected);
  }
  assert.equal(found.paths.some((item) => /docs\/a|node\.js|next\.js/i.test(item)), false);
  assert.deepEqual(found.ids, ["0b1f6c2e-1111-4222-8333-444455556666", "3f2a9c1e5b"]);
  assert.deepEqual(found.handles, ["@grace"]);
  assert.deepEqual(found.tickets, ["ABC-123"]);
});

test("files, URLs, commands and ids are collected from tool calls by code", () => {
  const built = collectBuilt([
    msg("user", "Deploy to https://staging.example.com/app and watch job 7d9e1c4a2b."),
    msg("assistant", "On it, ticket OPS-42.", {
      toolCalls: [
        { id: "1", name: "read_file", arguments: { path: "server/a.js" } },
        { id: "2", name: "edit_file", arguments: { file: "server/b.js", filePath: "server/c.js" } },
        { id: "3", name: "browser_open", arguments: { url: "https://example.com/start" } },
        { id: "4", name: "run_command", arguments: { command: "npm   test\n  --silent" } },
        { id: "5", name: "write_file", arguments: { path: "notes.md", content: "https://ignored.example.com ".repeat(100) } },
      ],
    }),
    msg("tool", "output with https://tool-output.example.com and deadbeef99", { name: "browser_open" }),
  ]);
  assert.deepEqual(built.files, ["server/a.js", "server/b.js", "server/c.js", "notes.md"]);
  assert.deepEqual(built.commands, ["npm test --silent"]);
  assert.equal(built.urls.includes("https://staging.example.com/app"), true);
  assert.equal(built.urls.includes("https://example.com/start"), true);
  assert.equal(built.urls.some((url) => url.includes("tool-output") || url.includes("ignored")), false);
  assert.equal(built.ids.includes("7d9e1c4a2b"), true);
  assert.equal(built.ids.includes("deadbeef99"), false);
  assert.deepEqual(built.tickets, ["OPS-42"]);
});

test("an incremental summary gets the previous summary in full and only newer messages", async () => {
  const home = makeHome();
  const bot = makeBot();
  const longBody = `### Goal and context\n${"Detail line about the launch plan. ".repeat(280)}\nEND-OF-PREVIOUS-SUMMARY`;
  assert.ok(longBody.length > 9_000);
  const previous = msg("assistant", OLD_STYLE(40, longBody), { kind: "summary", covers: 40 });
  seed(home, bot, [
    previous,
    msg("user", "NEWER-USER-ASK about the staging database"),
    msg("assistant", "NEWER-BOT-ANSWER with the plan"),
  ]);
  const { calls, summarizer } = recorder();
  const result = await run(home, bot, summarizer);
  assert.equal(result.compacted, true);
  const prompt = calls[0].prompt;
  assert.ok(prompt.includes(longBody), "previous summary must be passed unabridged");
  assert.match(prompt, /<previous_summary>/);
  const transcript = prompt.slice(prompt.indexOf("<new_messages>"));
  assert.match(transcript, /NEWER-USER-ASK/);
  assert.equal(transcript.includes("END-OF-PREVIOUS-SUMMARY"), false);
  assert.equal(transcript.includes("Earlier summary"), false);
  assert.match(calls[0].system, /word for word/);
  for (const heading of ["Goal and context", "User preferences and constraints", "Decisions", "Done", "Pending and open questions", "Current state", "Identifiers (paths, URLs, ids, names)", "Lookup hints", "Durable facts"]) {
    assert.ok(calls[0].system.includes(heading), heading);
  }

  const conversation = readConversation(home, bot);
  assert.equal(conversation[0].kind, "summary");
  assert.equal(conversation[0].covers, 42);
  assert.match(conversation[0].content, /Covers 42 earlier messages/);
  assert.equal(conversation[0].content.endsWith(SUMMARY_FOOTER), true);
  assert.equal(conversation.length, 1 + 4);
  assert.equal(readArchive(home, bot).some((row) => row.id === previous.id), true);
});

test("the identifier audit appends only what the model dropped", async () => {
  const home = makeHome();
  const bot = makeBot();
  const uuid = "0b1f6c2e-1111-4222-8333-444455556666";
  const previousBody = [
    "### Goal and context",
    "Ship the hub. Files: server/old-file.js and https://example.com/docs, ticket ABC-123, owner @ada, job " + uuid + ".",
    "",
    KEPT,
    "- command: make deploy",
    "- file: scripts/kept-before.sh",
  ].join("\n");
  seed(home, bot, [
    msg("assistant", OLD_STYLE(10, previousBody), { kind: "summary", covers: 10 }),
    msg("user", "continue"),
    msg("assistant", "continuing", { toolCalls: [{ id: "x", name: "read_file", arguments: { path: "server/new-file.js" } }] }),
  ]);
  const { summarizer } = recorder("### Goal and context\nStill shipping. Ticket ABC-123 is open.\n\n### Durable facts\n- none");
  await run(home, bot, summarizer);
  const content = readConversation(home, bot)[0].content;
  const kept = content.slice(content.indexOf(KEPT));
  assert.ok(kept.startsWith(KEPT));
  for (const line of [
    "- file: server/old-file.js",
    "- file: scripts/kept-before.sh",
    "- file: server/new-file.js",
    "- url: https://example.com/docs",
    "- command: make deploy",
    `- id: ${uuid}`,
    "- handle: @ada",
  ]) {
    assert.ok(kept.includes(line), line);
  }
  assert.equal(kept.includes("ABC-123"), false, "an identifier the model kept is not repeated");
  assert.equal(content.match(/### Identifiers \(kept by code\)/g).length, 1);

  const capped = auditIdentifiers("", { file: Array.from({ length: 200 }, (_, index) => `dir/file-${index}.js`) });
  assert.equal(capped.length, 60);
  assert.equal(capped.at(-1).value, "dir/file-199.js", "the newest items survive the cap");
});

test("a model copy of the code-managed section does not duplicate it", async () => {
  const home = makeHome();
  const bot = makeBot();
  seed(home, bot, [msg("user", "one"), msg("assistant", "two", { toolCalls: [{ id: "x", name: "read_file", arguments: { path: "lib/two.js" } }] })]);
  const reply = `### Goal and context\nGo.\n\n${KEPT}\n- file: made-up/by-model.js\n\n### Durable facts\n- none`;
  await run(home, bot, async () => reply);
  const content = readConversation(home, bot)[0].content;
  assert.equal(content.includes("made-up/by-model.js"), false);
  assert.equal(content.match(/### Identifiers \(kept by code\)/g).length, 1);
  assert.match(content, /- file: lib\/two\.js/);
});

test("durable facts are parsed, capped and deduped", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `- decision: Distinct decision number ${index} about the rollout`);
  const parsed = parseDurableFacts([
    "### Goal and context",
    "Body stays.",
    "",
    "### Durable facts",
    "- fact: The server runs on a small VPS.",
    "* Fact: the server runs on a small vps!!",
    "1. gotcha: Never copy data/ from the laptop.",
    "- preference: Alex wants short answers.",
    "- none",
    ...lines,
    "",
    "### Trailing section",
    "Kept too.",
  ].join("\n"));
  assert.match(parsed.body, /Body stays\./);
  assert.match(parsed.body, /Trailing section/);
  assert.equal(parsed.body.includes("Durable facts"), false);
  assert.equal(parsed.facts.length, 12);
  assert.deepEqual(parsed.facts.slice(0, 3).map((fact) => fact.kind), ["fact", "gotcha", "rule"]);
  assert.equal(parsed.facts.filter((fact) => /server runs on a small vps/i.test(fact.text)).length, 1);
  assert.deepEqual(parseDurableFacts("No section here.").facts, []);
  assert.equal(parseDurableFacts("A\n\n**Durable facts**\n- fact: Bold headings work too.").facts.length, 1);
});

test("durable facts go to ai-memory once, then to local memory when it fails", async () => {
  const pages = new Map();
  const writes = [];
  const client = {
    read: async (_info, pagePath) => {
      if (!pages.has(pagePath)) throw new Error("404");
      return pages.get(pagePath);
    },
    write: async (_info, page) => {
      writes.push(page);
      pages.set(page.path, page.body);
      return { path: page.path, text: "ok" };
    },
  };
  const bot = makeBot();
  const facts = [{ kind: "decision", text: "Launch on Friday after the demo." }, { kind: "gotcha", text: "The staging DB resets nightly." }];
  const first = await flushDurableFacts({ bot, facts, aiMemory: { available: true }, memoryClient: client });
  assert.deepEqual(first, { saved: 2, local: 0, skipped: 0 });
  assert.match(writes[0].path, /^facts\/launch-on-friday-after-the-demo-[0-9a-f]{8}\.md$/);
  assert.equal(writes[0].kind, "decision");
  const second = await flushDurableFacts({ bot, facts, aiMemory: { available: true }, memoryClient: client });
  assert.deepEqual(second, { saved: 0, local: 0, skipped: 2 });
  assert.equal(writes.length, 2);
  assert.equal(bot.memory.length, 0);

  const failing = { read: async () => { throw new Error("down"); }, write: async () => { throw new Error("down"); } };
  const third = await flushDurableFacts({ bot, facts, aiMemory: { available: true }, memoryClient: failing });
  assert.deepEqual(third, { saved: 0, local: 2, skipped: 0 });
  assert.equal(bot.memory.length, 2);
  assert.equal(bot.memory[0].source, "compaction");
  const again = await flushDurableFacts({ bot, facts, aiMemory: null, memoryClient: client });
  assert.deepEqual(again, { saved: 0, local: 0, skipped: 2 });
  assert.equal(bot.memory.length, 2);
});

test("compaction writes the model's durable facts and strips them from the summary", async () => {
  const home = makeHome();
  const bot = makeBot();
  seed(home, bot, [msg("user", "decide"), msg("assistant", "decided")]);
  const writes = [];
  const memoryClient = { read: async () => { throw new Error("404"); }, write: async (_i, page) => { writes.push(page); return { path: page.path, text: "ok" }; } };
  const reply = "### Goal and context\nPick a date.\n\n### Durable facts\n- decision: We launch on 14 November.\n- decision: We launch on 14 November.\n- rule: Never deploy on Fridays.";
  const result = await run(home, bot, async () => reply, { aiMemory: { available: true }, memoryClient });
  assert.equal(result.facts.saved, 2);
  assert.equal(writes.length, 2);
  const content = readConversation(home, bot)[0].content;
  assert.equal(content.includes("Durable facts"), false);
  assert.equal(content.includes("Never deploy on Fridays"), false);
  assert.equal(bot.compaction.facts, 2);

  const brokenHome = makeHome();
  const lonely = makeBot("bot-b", "Orbit");
  seed(brokenHome, lonely, [msg("user", "decide"), msg("assistant", "decided")]);
  const broken = await run(brokenHome, lonely, async () => reply, {
    aiMemory: { available: true },
    memoryClient: { read: async () => { throw new Error("x"); }, write: async () => { throw new Error("ai-memory is down"); } },
  });
  assert.equal(broken.compacted, true, "a memory failure never fails compaction");
  assert.equal(lonely.memory.length, 2);
});

test("the fallback keeps user words, the last three replies, and code-built lists", async () => {
  const home = makeHome();
  const bot = makeBot();
  const previousBody = "### Goal and context\nPREVIOUS-GOAL carried in full.";
  const call = (id, name, args) => ({ id, name, arguments: args });
  seed(home, bot, [
    msg("assistant", OLD_STYLE(5, previousBody), { kind: "summary", covers: 5 }),
    msg("user", "FIRST-USER-WORDS: use https://example.com/spec"),
    msg("assistant", "ASSISTANT-ONE", { toolCalls: [call("a", "read_file", { path: "docs/spec.md" })] }),
    msg("user", "SECOND-USER-WORDS: run the build"),
    msg("assistant", "ASSISTANT-TWO", { toolCalls: [call("b", "run_command", { command: "npm run build" })] }),
    msg("assistant", "ASSISTANT-THREE"),
    msg("assistant", "ASSISTANT-FOUR"),
  ]);
  const result = await run(home, bot, async () => { throw new Error("model down"); });
  assert.equal(result.compacted, true);
  const stored = readConversation(home, bot)[0];
  assert.equal(stored.fallback, true);
  const content = stored.content;
  assert.match(content, /compressed without a model/);
  assert.match(content, /PREVIOUS-GOAL carried in full\./);
  assert.match(content, /FIRST-USER-WORDS: use https:\/\/example\.com\/spec/);
  assert.match(content, /SECOND-USER-WORDS: run the build/);
  assert.equal(content.includes("ASSISTANT-ONE"), false);
  for (const text of ["ASSISTANT-TWO", "ASSISTANT-THREE", "ASSISTANT-FOUR"]) assert.ok(content.includes(text), text);
  assert.match(content, /- file: docs\/spec\.md/);
  assert.match(content, /- url: https:\/\/example\.com\/spec/);
  assert.match(content, /- command: npm run build/);
  assert.equal(content.endsWith(SUMMARY_FOOTER), true);

  // A second fallback does not nest the first one.
  const more = [msg("user", "THIRD-USER-WORDS"), msg("assistant", "later reply")];
  writeConversation(home, bot, [...readConversation(home, bot), ...more, msg("user", "tail a"), msg("assistant", "tail b"), msg("user", "tail c"), msg("assistant", "tail d")]);
  await run(home, bot, async () => "");
  const again = readConversation(home, bot)[0].content;
  assert.equal(again.match(/compressed without a model/g).length, 1);
  assert.match(again, /PREVIOUS-GOAL carried in full\./);
  assert.match(again, /- command: npm run build/);
});

test("a summarizer that never answers times out into the fallback", async () => {
  const home = makeHome();
  const bot = makeBot();
  seed(home, bot, [msg("user", "NEVER-ANSWERED question"), msg("assistant", "reply")]);
  let aborted = false;
  const summarizer = ({ signal }) => new Promise(() => signal.addEventListener("abort", () => { aborted = true; }));
  const result = await run(home, bot, summarizer, { timeoutMs: 40 });
  assert.equal(result.compacted, true);
  assert.equal(aborted, true);
  assert.match(readConversation(home, bot)[0].content, /NEVER-ANSWERED question/);
});

test("the summary stays near 16,000 characters and trims the transcript parts first", async () => {
  const home = makeHome();
  const bot = makeBot();
  const previousBody = `### Goal and context\n${"Earlier fact. ".repeat(1_000)}\nKEEP-THIS-TAIL-FACT`;
  const files = Array.from({ length: 40 }, (_, index) => `src/module-${index}/file.js`);
  seed(home, bot, [
    msg("assistant", OLD_STYLE(80, previousBody), { kind: "summary", covers: 80 }),
    msg("user", `HUGE-USER-MESSAGE ${"words ".repeat(5_000)}`),
    msg("assistant", "", { toolCalls: files.map((file, index) => ({ id: `f${index}`, name: "read_file", arguments: { path: file } })) }),
  ]);
  const reply = `### Goal and context\n${previousBody.replace("### Goal and context\n", "")}\n\n### Durable facts\n- none`;
  await run(home, bot, async () => reply);
  const content = readConversation(home, bot)[0].content;
  assert.ok(content.length <= SUMMARY_MAX_CHARS, `${content.length} chars`);
  assert.ok(content.includes("KEEP-THIS-TAIL-FACT"), "the carried summary is protected");
  assert.ok(content.includes("- file: src/module-39/file.js"), "identifiers are protected");
  assert.ok(content.includes("HUGE-USER-MESSAGE"), "the newest user words are trimmed, not dropped");
  assert.equal(content.endsWith(SUMMARY_FOOTER), true);
});

test("a message that arrives during summarization survives the compaction", async () => {
  const home = makeHome();
  const bot = makeBot();
  seed(home, bot, [msg("user", "old question"), msg("assistant", "old answer")]);
  const late = msg("user", "LATE-ARRIVAL while the model was thinking");
  const summarizer = async () => {
    writeConversation(home, bot, [...readConversation(home, bot), late]);
    return "### Goal and context\nDone.";
  };
  const result = await run(home, bot, summarizer);
  assert.equal(result.compacted, true);
  const conversation = readConversation(home, bot);
  assert.equal(conversation[0].kind, "summary");
  assert.equal(conversation.at(-1).content, late.content);
  assert.equal(conversation.filter((message) => message.content === "old question").length, 0);
  assert.equal(result.kept, 5);
});

test("every archived message has an id, even in threads that predate ids", async () => {
  const home = makeHome();
  const bot = makeBot();
  writeConversation(home, bot, [
    { role: "user", content: "legacy one", at: 1 },
    { role: "assistant", content: "legacy two", at: 2 },
    { role: "user", content: "legacy three", at: 3 },
    { role: "assistant", content: "legacy four", at: 4 },
    { role: "user", content: "legacy five", at: 5 },
    { role: "assistant", content: "legacy six", at: 6 },
  ]);
  await run(home, bot, recorder().summarizer);
  const archived = readArchive(home, bot);
  assert.equal(archived.length, 2);
  assert.equal(archived.every((row) => typeof row.id === "string" && row.id.length > 8), true);
  assert.equal(readConversation(home, bot).every((message) => message.id), true);
  const lines = fs.readFileSync(path.join(home, "bots", bot.id, "conversation-archive.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.every((line) => line.id && line.role && "content" in line && line.at), true);
});

test("search_history and read_history only see the calling bot's archive", async () => {
  const home = makeHome();
  const bot = makeBot("bot-a", "Nova");
  const other = makeBot("bot-b", "Orbit");
  const filler = Array.from({ length: 8 }, (_, index) => msg(index % 2 ? "assistant" : "user", `filler message ${index}`));
  seed(home, bot, [
    msg("user", "Remember the Zephyr migration plan uses port 4555"),
    msg("assistant", "", { toolCalls: [{ id: "k1", name: "run_command", arguments: { command: "ssh deploy@zephyr.example.com uptime" } }] }),
    msg("tool", `uptime result for the Zephyr box: ${"load ".repeat(100)}load average 0.42`, { id: "tool-zephyr", name: "run_command", toolCallId: "k1" }),
    msg("assistant", "The Zephyr box looks healthy."),
    ...filler,
  ]);
  seed(home, other, [msg("user", "Orbit only: the secret Zephyr word is banana"), ...filler.map((item) => ({ ...item, id: `${item.id}-o` }))]);
  await run(home, bot, recorder().summarizer);
  await run(home, other, recorder().summarizer);

  const ctx = { bot, home };
  const found = await callCollaborationTool("search_history", { query: "ZEPHYR port" }, ctx);
  assert.match(found.text, /1 archived message match/);
  assert.match(found.text, /Remember the Zephyr migration plan uses port 4555/);
  assert.equal(found.text.includes("banana"), false);

  const all = await callCollaborationTool("search_history", { query: "zephyr" }, ctx);
  assert.match(all.text, /4 archived messages match/);
  const order = [...all.text.matchAll(/^- id (\S+)/gm)].map((match) => match[1]);
  assert.equal(order[0].startsWith("assistant-"), true, "newest first");
  assert.equal(order.includes("tool-zephyr"), true, "tool outputs are searchable");
  const snippet = all.text.split("\n").find((line) => line.includes("tool-zephyr"));
  assert.ok(snippet.split("|").at(-1).trim().length <= 306);

  const none = await callCollaborationTool("search_history", { query: "zephyr banana" }, ctx);
  assert.match(none.text, /No archived messages match/);
  await assert.rejects(() => callCollaborationTool("search_history", { query: "  " }, ctx), /query is required/);

  const limited = await callCollaborationTool("search_history", { query: "filler", limit: 2 }, ctx);
  assert.match(limited.text, /Showing the newest 2 of /);

  const window = await callCollaborationTool("read_history", { id: "tool-zephyr", before: 1, after: 1 }, ctx);
  assert.match(window.text, />> id tool-zephyr/);
  assert.match(window.text, /tool call: run_command \{"command":"ssh deploy@zephyr\.example\.com uptime"\}/);
  assert.match(window.text, /The Zephyr box looks healthy\./);
  assert.equal(window.text.includes("Remember the Zephyr migration"), false);
  const wide = await callCollaborationTool("read_history", { id: "tool-zephyr", before: 99, after: 99 }, ctx);
  assert.match(wide.text, /Remember the Zephyr migration/);
  assert.equal((wide.text.match(/^ {3}id |^>> id /gm) || []).length <= 11, true);
  const prefixed = await callCollaborationTool("read_history", { id: "tool-zeph" }, ctx);
  assert.match(prefixed.text, />> id tool-zephyr/);
  const missing = await callCollaborationTool("read_history", { id: "no-such-id" }, ctx);
  assert.match(missing.text, /No archived message has the id no-such-id/);
  const foreign = await callCollaborationTool("read_history", { id: "tool-zephyr" }, { bot: other, home });
  assert.match(foreign.text, /No archived message has the id/);

  const names = collaborationToolDefinitions().map((tool) => tool.name);
  assert.equal(names.includes("search_history") && names.includes("read_history") && names.includes("compact_conversation"), true);
});

test("read_history caps long content at 4000 characters", async () => {
  const home = makeHome();
  const bot = makeBot();
  seed(home, bot, [
    msg("user", `BIG ${"x".repeat(9_000)}`, { id: "big-one" }),
    msg("assistant", "ok"),
  ]);
  await run(home, bot, recorder().summarizer);
  const result = await callCollaborationTool("read_history", { id: "big-one", before: 0, after: 0 }, { bot, home });
  assert.match(result.text, /\[cut: \d+ more characters\]/);
  assert.ok(result.text.length < 4_600);
});

test("the transcript masks tools and never exceeds the size guard", () => {
  const messages = [msg("user", "hello"), msg("tool", "x".repeat(50_000), { id: "t9", name: "web_fetch" })];
  for (let index = 0; index < 120; index += 1) messages.push(msg("user", "y".repeat(2_500)));
  const text = buildTranscript(messages);
  assert.match(text, /tool web_fetch: output archived \(id t9\)/);
  assert.equal(text.includes("x".repeat(100)), false);
  assert.ok(text.length < 141_000);
  assert.match(text, /\[\.\.\.middle omitted\.\.\.\]/);
});
