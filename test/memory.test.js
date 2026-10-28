import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { createApp } from "../server/index.js";
import { Vault } from "../server/vault/index.js";
import { VaultWriter } from "../server/vault/writer.js";
import { vaultCommit, vaultCommitsForTurn, vaultLatestCommit, vaultLog } from "../server/vault/history.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function vaultRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-memory-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", remote]);
  execFileSync("git", ["clone", "-q", remote, seed]);
  fs.writeFileSync(path.join(seed, "Rules.md"), "# Rules\n1. Be brief.\n");
  fs.writeFileSync(path.join(seed, "Decisions-Log.md"), "# Decisions Log\n\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "HEAD:master");
  const dir = path.join(root, "vault");
  execFileSync("git", ["clone", "-q", remote, dir]);
  return { dir, remote };
}

async function api(base, method, pathname, body, { ok = true } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (ok) assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return ok ? data : { status: response.status, ...data };
}

async function waitFor(check, { tries = 150, delay = 100 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting.");
}

async function say(base, id, text) {
  const { turnId } = await api(base, "POST", `/api/bots/${id}/messages`, { text });
  const events = await waitFor(async () => {
    const list = (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events;
    return list.some((event) => event.type === "turn.end" && event.turnId === turnId) ? list : null;
  });
  const { conversation } = await api(base, "GET", `/api/bots/${id}`);
  return { turnId, reply: conversation.filter((message) => message.role === "assistant" && message.kind !== "ack").at(-1), events: events.filter((event) => event.turnId === turnId || !event.turnId) };
}

async function withServer(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const mock = await startMock();
  const server = createApp({ home: fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-memory-home-")), projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, mock });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a fact one agent saves is in the next agent's prompt; the Memory log links the commit to its turn; Revert undoes it", async () => {
  const { dir } = vaultRepo();
  await withServer({ RAVNIR_VAULT_DIR: dir, RAVNIR_VAULT_WRITE: "on", RAVNIR_VAULT_SYNC_MS: "600000" }, async ({ base, mock }) => {
    await waitFor(async () => (await api(base, "GET", "/api/state")).vault?.writer?.available);
    await api(base, "PUT", "/api/settings", { owner: { name: "Alex", language: "en" } });
    const model = { provider: "openai", baseUrl: mock.url, model: "mock-model" };
    const scout = (await api(base, "POST", "/api/bots", { name: "Scout", job: "Research.", model })).bot;
    const forge = (await api(base, "POST", "/api/bots", { name: "Forge", job: "Builds things.", model })).bot;

    const learned = await say(base, scout.id, 'call tool remember {"fact":"Alex wants every report as three bullet points","type":"preference","key":"report-style"}');
    assert.match(learned.reply.content, /People\/Alex\.md/);

    // Forge's very next turn, on an unrelated message, already has the fact in its prompt.
    const next = await say(base, forge.id, "hello");
    const meta = next.events.find((event) => event.type === "meta");
    assert.match(meta.livePrompt, /About the user, People\/Alex\.md/);
    assert.match(meta.livePrompt, /Alex wants every report as three bullet points/);
    assert.ok(meta.vaultSources.some((source) => source.path === "People/Alex.md"));

    // The Memory log: newest first, by agent, with the turn that wrote it.
    const memory = await api(base, "GET", "/api/memory");
    assert.equal(memory.writes, true);
    assert.ok(memory.authors.some((author) => author.name === "Scout"));
    const log = await api(base, "GET", "/api/memory/log?agent=Scout");
    const entry = log.items[0];
    assert.equal(entry.author, "Scout");
    assert.equal(entry.botId, scout.id);
    assert.equal(entry.turnId, learned.turnId);
    assert.equal(entry.turn.botId, scout.id);
    assert.deepEqual(entry.files, ["People/Alex.md"]);
    assert.equal(entry.summary, "Remembered something about you");
    assert.match(entry.obsidian, /^obsidian:\/\/open\?vault=vault&file=People%2FAlex$/);
    assert.equal((await api(base, "GET", "/api/memory/log?agent=Forge")).items.length, 0);
    assert.equal((await api(base, "GET", "/api/memory/log?note=Rules.md")).items.length, 1);
    const turn = await api(base, "GET", `/api/turns/${learned.turnId}`);
    assert.equal(turn.botName, "Scout");

    const detail = await api(base, "GET", `/api/memory/commits/${entry.short}`);
    assert.match(detail.diff, /\+- Alex wants every report as three bullet points/);
    assert.equal(detail.canRevert, true);

    // Revert: one call, a new commit by the owner, shown in the log, and the fact is gone for everyone.
    const reverted = await api(base, "POST", `/api/memory/commits/${entry.hash}/revert`, {});
    assert.ok(reverted.commit);
    assert.equal(git(dir, "log", "-1", "--format=%an"), "Alex");
    assert.match(git(dir, "log", "-1", "--format=%B"), new RegExp(`Ravnir-Revert: ${entry.hash}`));
    const after = (await api(base, "GET", "/api/memory/log")).items[0];
    assert.equal(after.author, "Alex");
    assert.equal(after.reverts, entry.hash);
    // The commit created the note, so undoing it removes the note.
    assert.equal(fs.existsSync(path.join(dir, "People/Alex.md")), false);
    const later = await say(base, forge.id, "hello again");
    assert.doesNotMatch(later.events.find((event) => event.type === "meta").livePrompt, /three bullet points/);
    // Twice is refused, and the detail says so.
    const twice = await api(base, "POST", `/api/memory/commits/${entry.hash}/revert`, {}, { ok: false });
    assert.equal(twice.status, 409);
    assert.match(twice.error, /Already reverted/);
    assert.equal((await api(base, "GET", `/api/memory/commits/${entry.hash}`)).canRevert, false);

    // Notes with backlinks, and the Obsidian vault name the owner can change.
    const note = await api(base, "GET", `/api/memory/note?path=${encodeURIComponent("Rules.md")}`);
    assert.match(note.body, /Be brief/);
    assert.equal((await api(base, "PUT", "/api/memory/obsidian", { name: "Wiki" })).obsidian, "Wiki");
    assert.match((await api(base, "GET", `/api/memory/note?path=Rules.md`)).obsidian, /vault=Wiki&file=Rules$/);
    assert.equal((await api(base, "GET", "/api/memory/note?path=../etc/passwd", undefined, { ok: false })).status, 400);
  });
});

test("revert refuses a commit a later change built on and leaves the vault clean", async () => {
  const { dir } = vaultRepo();
  const vault = new Vault({ dir, watch: false, pullMs: 0 });
  await vault.open();
  let turn = "turn-1";
  const writer = new VaultWriter({ vault, dir, syncMs: 0, owner: () => ({ name: "Alex" }), layout: "en", turnOf: () => turn });
  const bot = { id: "b1", name: "Scout" };
  try {
    const first = await writer.appendOwnNote(bot, "Uses the staging server for tests.");
    assert.ok(first.commit);
    turn = "turn-2";
    // A hand edit of the same line, committed on top.
    const note = path.join(dir, "Agents/Scout.md");
    fs.writeFileSync(note, fs.readFileSync(note, "utf8").replace("staging server", "staging box"));
    git(dir, "commit", "-qam", "hand edit");
    const log = await vaultLog(dir, { agent: "Scout" });
    assert.equal(log.items[0].turnId, "turn-1");
    const refused = await writer.revert(log.items[0].hash, { name: "Alex" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /later change edited the same lines/);
    assert.equal(git(dir, "status", "--porcelain"), "");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "hand edit");
    // A dirty tree is never mixed into a revert.
    fs.appendFileSync(path.join(dir, "Rules.md"), "2. Draft rule.\n");
    const dirty = await writer.revert((await vaultLog(dir)).items[0].hash, { name: "Alex" });
    assert.match(dirty.error, /not committed yet/);
    assert.match(fs.readFileSync(path.join(dir, "Rules.md"), "utf8"), /Draft rule/);
    // The root commit and unknown hashes are refused.
    const root = git(dir, "rev-list", "--max-parents=0", "HEAD");
    git(dir, "checkout", "-q", "--", "Rules.md");
    assert.match((await writer.revert(root, {})).error, /first commit/);
    assert.match((await writer.revert("deadbeefdeadbeef", {})).error, /not in the vault/);
    assert.equal(await vaultCommit(dir, "zzz"), null);
  } finally {
    vault.close();
  }
});

test("a turn's commits and a note's latest commit can be found for the proof", async () => {
  const { dir } = vaultRepo();
  const vault = new Vault({ dir, watch: false, pullMs: 0 });
  await vault.open();
  const writer = new VaultWriter({ vault, dir, syncMs: 0, owner: () => ({ name: "Alex" }), layout: "en", turnOf: () => "turn-proof" });
  const bot = { id: "b1", name: "Scout" };
  try {
    const written = await writer.appendOwnNote(bot, "The proof lives in the vault.");
    assert.ok(written.commit);
    const commits = await vaultCommitsForTurn(dir, "turn-proof");
    assert.equal(commits.length, 1);
    assert.equal(commits[0].short, written.commit);
    assert.ok(commits[0].files.includes("Agents/Scout.md"));
    assert.equal((await vaultCommitsForTurn(dir, "another-turn")).length, 0);
    const latest = await vaultLatestCommit(dir, "Agents/Scout.md");
    assert.equal(latest.short, written.commit);
    assert.equal(await vaultLatestCommit(dir, "../Rules.md"), null);
  } finally {
    writer.stop();
    vault.close();
  }
});

test("history filters treat note paths literally, including git pathspec characters", async () => {
  const { dir } = vaultRepo();
  const note = ":(exclude)Rules.md";
  fs.writeFileSync(path.join(dir, note), "# A literal note\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "literal note");
  const wanted = git(dir, "rev-parse", "HEAD");
  fs.appendFileSync(path.join(dir, "Decisions-Log.md"), "Another change.\n");
  git(dir, "commit", "-qam", "unrelated note");
  const log = await vaultLog(dir, { note });
  assert.deepEqual(log.items.map((item) => item.hash), [wanted]);
});

test("commit details and reverts work when a file has the same name as the commit hash", async () => {
  const { dir } = vaultRepo();
  fs.appendFileSync(path.join(dir, "Rules.md"), "2. Check facts.\n");
  git(dir, "commit", "-qam", "new rule");
  const hash = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, hash), "A file, not a revision.\n");
  const commit = await vaultCommit(dir, hash);
  assert.equal(commit?.hash, hash);
  assert.match(commit.diff, /Check facts/);
  const vault = new Vault({ dir, watch: false, pullMs: 0 });
  await vault.open();
  const writer = new VaultWriter({ vault, dir, syncMs: 0 });
  try {
    const reverted = await writer.revert(hash, { name: "Alex" });
    assert.equal(reverted.ok, true, reverted.error);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "Rules.md"), "utf8"), /Check facts/);
  } finally {
    writer.stop();
    vault.close();
  }
});

test("history returns actual Unicode note paths for note filters and Obsidian links", async () => {
  const { dir } = vaultRepo();
  const note = "José.md";
  fs.writeFileSync(path.join(dir, note), "# José\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "Unicode note");
  const hash = git(dir, "rev-parse", "HEAD");
  assert.deepEqual((await vaultLog(dir)).items[0].files, [note]);
  assert.deepEqual((await vaultCommit(dir, hash)).files, [note]);
  const vault = new Vault({ dir, watch: false, pullMs: 0 });
  await vault.open();
  const writer = new VaultWriter({ vault, dir, syncMs: 0 });
  try {
    assert.deepEqual((await writer.revert(hash, { name: "Alex" })).files, [note]);
  } finally {
    writer.stop();
    vault.close();
  }
});
