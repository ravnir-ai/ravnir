import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMock } from "../scripts/mock-openai.js";
import { ApprovalCenter } from "../server/approvals.js";
import { SUMMARY_FOOTER, compactConversation, flushDurableFacts } from "../server/compaction.js";
import { applyImport, parseExport, planImport } from "../server/importer.js";
import { createJob, Scheduler } from "../server/jobs.js";
import { NotificationCenter } from "../server/notifications.js";
import { createApp } from "../server/index.js";
import { ProposalStore } from "../server/proposals.js";
import { redactSecrets } from "../server/redact.js";
import { botHome, loadState, readConversation, writeConversation } from "../server/state.js";
import { TurnEngine } from "../server/turn.js";

process.env.RAVNIR_AI_MEMORY = "off";

const KEY = "sk-abcdefghijklmnopqrstuvwxyz123456"; // check-public: allow token (fake secret for a test)
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"; // check-public: allow token (fake secret for a test)

function tempHome(label = "review") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-${label}-`));
}

test("redactSecrets masks common key shapes and leaves ordinary prose alone", () => {
  const samples = [
    `use ${KEY} for it`,
    TOKEN,
    "xoxb-1234567890-abcdefghij", // check-public: allow token (fake secret for a test)
    "AKIAABCDEFGHIJKLMNOP", // check-public: allow token (fake secret for a test)
    "Authorization: Bearer abcdefghijklmnop1234.xyz",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabcd\n-----END OPENSSH PRIVATE KEY-----", // check-public: allow private-key (fake secret for a test)
    "password: hunter2hunter2hunter",
    '{"api_key": "abcdefghijklmnop"}',
    "secret = ZmFrZXNlY3JldGZha2U=",
  ];
  for (const sample of samples) {
    const { text, found } = redactSecrets(sample);
    assert.equal(found >= 1, true, sample);
    assert.match(text, /\[redacted\]/, sample);
  }
  const plain = "The key point: keep the token short. Lunch is at 14:00 and the password is stored in 1Password.";
  assert.deepEqual(redactSecrets(plain), { text: plain, found: 0 });
  assert.equal(redactSecrets(`one ${KEY} and two ${TOKEN}`).found, 2);
});

test("a replayed trust decision cannot change the policy once the approval is answered", async () => {
  const home = tempHome();
  const bot = { id: "b1", name: "Nova", policy: { shell: "ask", files: "ask", logins: "ask" } };
  const events = [];
  const engine = {
    approvals: new ApprovalCenter({ home }),
    state: { bots: [bot] },
    onPolicyChange: (changed) => events.push(changed.id),
  };
  const decide = (id, value) => TurnEngine.prototype.decide.call(engine, id, value);

  const waiting = engine.approvals.request({ id: "r1", bot, title: "Run ls" });
  assert.equal(decide("r1", "trust"), true);
  assert.equal(await waiting, "trust");
  assert.equal(bot.policy.shell, "allow");
  assert.deepEqual(events, ["b1"]);

  // Back to ask, then replay the same id: nothing is pending, so nothing changes.
  bot.policy = { shell: "ask", files: "ask", logins: "ask" };
  assert.equal(decide("r1", "trust"), false);
  assert.equal(decide("unknown-id", "trust"), false);
  assert.equal(bot.policy.shell, "ask");
  assert.deepEqual(events, ["b1"]);

  // A different decision on a pending request never touches the policy.
  const other = engine.approvals.request({ id: "r2", bot, title: "Run pwd" });
  assert.equal(decide("r2", "once"), true);
  assert.equal(await other, "once");
  assert.equal(bot.policy.shell, "ask");
});

test("import redacts secrets in instructions, notes and routine prompts, and says so", async () => {
  const state = { bots: [] };
  const items = parseExport(JSON.stringify({
    name: "Vault",
    job: "Keeps things.",
    instructions: `Deploy with ${KEY} when asked.`,
    memories: ["Lunch is at 14:00."],
    routines: [{ name: "Nightly", cron: "0 8 * * *", prompt: `Call the API with token: ${TOKEN}`, enabled: true }],
    connectors: [],
    notes: "password: hunter2hunter2hunter\nAlso keep calm.",
  }));
  assert.equal(items[0].redactions, 3);
  const everything = JSON.stringify(items);
  for (const secret of [KEY, TOKEN, "hunter2hunter2hunter"]) assert.equal(everything.includes(secret), false, secret);

  const plan = planImport(state, items);
  assert.equal(plan[0].warnings.some((warning) => /3 values.*replaced with \[redacted\]/.test(warning)), true);
  assert.equal(JSON.stringify(plan).includes(KEY), false);

  const created = [];
  const result = await applyImport({
    state,
    items,
    createBot: async (item) => {
      const bot = { id: "v1", name: item.name, prompt: "", memory: [], jobs: [] };
      state.bots.push(bot);
      created.push(bot);
      return bot;
    },
  });
  assert.equal(result.warnings.some((warning) => /replaced with \[redacted\]/.test(warning)), true);
  const stored = JSON.stringify(created[0]);
  for (const secret of [KEY, TOKEN, "hunter2hunter2hunter"]) assert.equal(stored.includes(secret), false, secret);
  assert.match(created[0].prompt, /Deploy with \[redacted\] when asked\./);
});

test("an imported memory that ai-memory took is also kept on the bot, deduped and within the cap", async () => {
  const bot = { id: "m1", name: "Memo", prompt: "x", memory: [{ id: "old", text: "Already here.", at: 1 }], jobs: [] };
  const state = { bots: [bot] };
  const items = parseExport(JSON.stringify({ name: "Memo", memories: ["Already here.", "Fresh fact one.", "Fresh fact two."] }));
  const written = [];
  const first = await applyImport({
    state,
    items,
    aiMemory: { available: true },
    writeMemory: async (_info, page) => { written.push(page.title); },
  });
  assert.equal(first.memories, 2);
  assert.deepEqual(written, ["Fresh fact one.", "Fresh fact two."]);
  assert.deepEqual(bot.memory.map((item) => item.text), ["Already here.", "Fresh fact one.", "Fresh fact two."]);

  // A second import adds nothing, remote or local.
  const second = await applyImport({
    state,
    items,
    aiMemory: { available: true },
    writeMemory: async () => { throw new Error("should not be called"); },
  });
  assert.equal(second.memories, 0);
  assert.equal(bot.memory.length, 3);

  // A full bot memory is not pushed out by an import that ai-memory already holds.
  bot.memory = Array.from({ length: 80 }, (_, index) => ({ id: `m${index}`, text: `Memory ${index}`, at: index }));
  await applyImport({
    state,
    items: parseExport(JSON.stringify({ name: "Memo", memories: ["Brand new fact."] })),
    aiMemory: { available: true },
    writeMemory: async () => {},
  });
  assert.equal(bot.memory.length, 80);
  assert.equal(bot.memory[0].text, "Memory 0");
});

test("durable facts and the summary are redacted before they are stored", async () => {
  const home = tempHome("redact-compaction");
  const bot = { id: "bot-r", name: "Nova", model: { provider: "openai" }, memory: [], remote: {} };
  const writes = [];
  const memoryClient = {
    read: async () => { throw new Error("404"); },
    write: async (_info, page) => { writes.push(page); return { path: page.path, text: "ok" }; },
  };

  const flushed = await flushDurableFacts({ bot, facts: [{ kind: "fact", text: `The deploy token is ${TOKEN} for prod.` }], aiMemory: { available: true }, memoryClient });
  assert.equal(flushed.saved, 1);
  assert.equal(JSON.stringify(writes).includes(TOKEN), false);
  assert.match(writes[0].body, /\[redacted\]/);
  const local = await flushDurableFacts({ bot, facts: [{ kind: "fact", text: `Local copy uses ${KEY} here.` }], aiMemory: null, memoryClient });
  assert.equal(local.local, 1);
  assert.equal(JSON.stringify(bot.memory).includes(KEY), false);

  let clock = 1_790_000_000_000;
  const msg = (role, content) => {
    clock += 60_000;
    return { id: `${role}-${clock}`, role, content, at: clock };
  };
  writeConversation(home, bot, [
    msg("user", `Please remember api key: ${KEY} for later`),
    msg("assistant", "Noted."),
    msg("user", "four"),
    msg("assistant", "five"),
    msg("user", "six"),
    msg("assistant", "seven"),
  ]);
  const reply = `### Goal and context\nStore the key ${KEY} safely.\n\n### Durable facts\n- fact: The prod token is ${TOKEN}.`;
  const result = await compactConversation({ bot, home, directory: home, force: true, keep: 4, summarizer: async () => reply, aiMemory: { available: true }, memoryClient });
  assert.equal(result.compacted, true);
  const summary = readConversation(home, bot)[0].content;
  assert.equal(summary.includes(KEY), false);
  assert.equal(summary.includes(TOKEN), false);
  assert.match(summary, /Store the key \[redacted\] safely\./);
  assert.equal(JSON.stringify(writes).includes(TOKEN), false);
});

test("the next compaction gives the summarizer the previous quotes without nesting them", async () => {
  const home = tempHome("recent-sections");
  const bot = { id: "bot-q", name: "Nova", model: { provider: "openai" }, memory: [], remote: {} };
  let clock = 1_790_000_000_000;
  const msg = (role, content, extra = {}) => {
    clock += 60_000;
    return { id: `${role}-${clock}`, role, content, at: clock, ...extra };
  };
  const previous = msg("assistant", [
    "## Compacted context",
    "_Covers 6 earlier messages._",
    "",
    "### Goal and context",
    "Ship the beta.",
    "",
    "### Recent user messages (verbatim)",
    "",
    "(id u1 | 2026-10-01 10:00Z)",
    "> ONLY-IN-QUOTES the staging box is called Orion",
    "",
    "### Last assistant replies",
    "",
    "(id a1 | 2026-10-01 10:01Z)",
    "> ONLY-IN-REPLY the rollback script lives in ops",
    "",
    SUMMARY_FOOTER,
  ].join("\n"), { kind: "summary", covers: 6 });
  writeConversation(home, bot, [
    previous,
    msg("user", "NEWER-ASK about billing"),
    msg("assistant", "NEWER-ANSWER"),
    msg("user", "r1"),
    msg("assistant", "r2"),
    msg("user", "r3"),
    msg("assistant", "r4"),
  ]);
  const prompts = [];
  const result = await compactConversation({
    bot,
    home,
    directory: home,
    force: true,
    keep: 4,
    summarizer: async ({ prompt }) => {
      prompts.push(prompt);
      return "### Goal and context\nShip the beta.\n\n### Durable facts\n- none";
    },
  });
  assert.equal(result.compacted, true);
  const prompt = prompts[0];
  const summaryPart = prompt.slice(prompt.indexOf("<previous_summary>"), prompt.indexOf("</previous_summary>"));
  const recentPart = prompt.slice(prompt.indexOf("<previous_recent>"), prompt.indexOf("</previous_recent>"));
  assert.match(recentPart, /ONLY-IN-QUOTES the staging box is called Orion/);
  assert.match(recentPart, /ONLY-IN-REPLY the rollback script lives in ops/);
  assert.equal(recentPart.includes("Earlier messages are archived"), false);
  assert.equal(summaryPart.includes("ONLY-IN-QUOTES"), false);
  assert.equal(summaryPart.includes("Recent user messages"), false);
  assert.match(prompt, /NEWER-ASK about billing/);

  const content = readConversation(home, bot)[0].content;
  assert.equal(content.includes("ONLY-IN-QUOTES"), false, "old quotes are not nested into the new summary");
  assert.equal(content.match(/### Recent user messages \(verbatim\)/g).length, 1);
});

test("deleting a conversation also deletes its archive, and a one-time job is consumed by Run now", async () => {
  const home = tempHome("delete-run");
  const mock = await startMock();
  const server = createApp({ home, projectRoot: path.resolve(import.meta.dirname, "..") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await request(base, "POST", "/api/bots", {
      name: "Cleaner",
      job: "Tidies.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const botId = created.bot.id;
    const archive = path.join(botHome(home, { id: botId }), "conversation-archive.ndjson");
    fs.writeFileSync(archive, `${JSON.stringify({ id: "x1", role: "user", content: "deleted words", at: 1 })}\n`);
    await request(base, "DELETE", `/api/bots/${botId}/conversation`);
    assert.equal(fs.existsSync(archive), false);

    const once = await request(base, "POST", `/api/bots/${botId}/jobs`, { name: "Ping", prompt: "Say hi", at: Date.now() + 3_600_000 });
    assert.equal(once.job.enabled, true);
    assert.ok(once.job.nextRunAt > 0);
    await request(base, "POST", `/api/bots/${botId}/jobs/${once.job.id}/run`);
    const detail = await request(base, "GET", `/api/bots/${botId}`);
    const consumed = detail.bot.jobs.find((job) => job.id === once.job.id);
    assert.equal(consumed.enabled, false);
    assert.equal(consumed.done, true);
    assert.equal(consumed.nextRunAt, 0);

    const repeating = await request(base, "POST", `/api/bots/${botId}/jobs`, { name: "Daily", prompt: "Say hi", cron: "0 8 * * *" });
    await request(base, "POST", `/api/bots/${botId}/jobs/${repeating.job.id}/run`);
    const again = await request(base, "GET", `/api/bots/${botId}`);
    const daily = again.bot.jobs.find((job) => job.id === repeating.job.id);
    assert.equal(daily.enabled, true);
    assert.ok(daily.nextRunAt > 0);

    // Home lists each routine's next run once, past the end of today.
    const today = await request(base, "GET", "/api/today");
    const soon = today.soon.filter((item) => item.jobId === repeating.job.id);
    assert.equal(soon.length, 1);
    assert.equal(soon[0].at, daily.nextRunAt);
    assert.equal(soon[0].jobName, "Daily");
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
  }
});

test("a one-time job claimed but never finished is armed again at boot", async () => {
  const job = createJob({ name: "Remind", prompt: "Ping me", at: Date.now() - 5_000 });
  const bot = { id: "b1", jobs: [job] };
  let release;
  const scheduler = new Scheduler({
    getState: () => ({ bots: [bot] }),
    save: () => {},
    runJob: () => new Promise((resolve) => { release = resolve; }),
  });
  await scheduler.tick();
  assert.equal(job.done, true);
  assert.ok(job.claimedAt > 0, "the claim is recorded until the run finishes");
  release();

  // The server dies here. On the next boot the claim is still there, so the job is armed again.
  const home = tempHome("rearm");
  const saved = { version: 1, server: { name: "Ravnir", createdAt: 1 }, bots: [{ id: "b1", name: "Nova", jobs: [{ ...job }] }], groups: [] };
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(saved));
  const state = loadState({ home, secrets: null, projectRoot: home });
  const revived = state.bots[0].jobs[0];
  assert.equal(revived.enabled, true);
  assert.equal(revived.done, false);
  assert.equal(revived.claimedAt, 0);
  assert.equal(revived.nextRunAt, job.at);

  // A job whose run finished (claimedAt cleared) stays done.
  const finishedHome = tempHome("finished");
  const finished = { ...job, claimedAt: 0 };
  fs.writeFileSync(path.join(finishedHome, "state.json"), JSON.stringify({ ...saved, bots: [{ id: "b1", name: "Nova", jobs: [finished] }] }));
  const after = loadState({ home: finishedHome, secrets: null, projectRoot: finishedHome }).bots[0].jobs[0];
  assert.equal(after.done, true);
  assert.equal(after.enabled, false);
  assert.equal(after.nextRunAt, 0);
});

test("proposals and notifications are written with mode 600", async () => {
  const home = tempHome("modes");
  const proposals = new ProposalStore({ home });
  proposals.create({ botId: "b1", botName: "Nova", title: "Tidy up", prompt: "Tidy the workspace." });
  const center = new NotificationCenter({ home, push: { send: async () => ({ sent: 0, failed: 0, removed: 0 }) } });
  await center.notify({ botId: "b1", botName: "Nova", kind: "turn", title: "Done" });
  for (const file of ["proposals.json", "notifications.json"]) {
    const mode = fs.statSync(path.join(home, file)).mode & 0o777;
    assert.equal(mode, 0o600, `${file} is ${mode.toString(8)}`);
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
