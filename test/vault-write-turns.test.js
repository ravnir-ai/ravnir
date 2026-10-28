import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { createApp } from "../server/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function vaultRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-vault-write-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", remote]);
  execFileSync("git", ["clone", "-q", remote, seed]);
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
  };
  put("Rules.md", "# Rules\n1. Never store secrets here.\n");
  put("Decisions-Log.md", "# Decisions Log\n\n- 2026-10-20 — first decision\n");
  put("Projects/Launch.md", "# Launch\nTikTok clips account.\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "HEAD:master");
  const dir = path.join(root, "vault");
  execFileSync("git", ["clone", "-q", remote, dir]);
  return { dir, remote };
}

async function api(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
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

// Sends one message and returns the bot's reply text once the turn has ended.
async function say(base, id, text) {
  const { turnId } = await api(base, "POST", `/api/bots/${id}/messages`, { text });
  await waitFor(async () => (await api(base, "GET", `/api/bots/${id}/events?after=0`)).events.some((event) => event.type === "turn.end" && event.turnId === turnId));
  const { conversation } = await api(base, "GET", `/api/bots/${id}`);
  return conversation.filter((message) => message.role === "assistant" && message.kind !== "ack").at(-1).content;
}

test("a bot writes to the vault under its own name, and a Rules.md change waits for approval", async () => {
  const { dir } = vaultRepo();
  Object.assign(process.env, { RAVNIR_VAULT_DIR: dir, RAVNIR_VAULT_WRITE: "on", RAVNIR_VAULT_SYNC_MS: "600000" });
  const mock = await startMock();
  const server = createApp({ home: fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-vault-write-home-")), projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitFor(async () => (await api(base, "GET", "/api/state")).vault?.writer?.available);
    // The owner set in Settings: a new vault in Spanish gets the Spanish folders and the owner's profile note.
    const settings = await api(base, "PUT", "/api/settings", { owner: { name: "Alex", language: "es" } });
    assert.deepEqual(settings.owner, { name: "Alex", language: "es" });
    assert.equal(settings.vault.active, "es");
    assert.equal(settings.vault.profile, "Perfil/Alex.md");
    const hot = (await api(base, "POST", "/api/bots", { name: "Launch", job: "Runs the TikTok account.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } })).bot;
    const livePrompt = (await api(base, "GET", `/api/bots/${hot.id}`)).livePrompt;
    assert.match(livePrompt, /You can write to the vault/);
    assert.match(livePrompt, /You work for Alex, who owns this server\. Alex usually writes in Spanish\./);
    assert.match(livePrompt, /today's note in Registro\/ .*remember saves a durable fact about the user to Perfil\/Alex\.md/);

    assert.match(await say(base, hot.id, 'call tool log_activity {"action":"daily check","status":"ok"}'), /Saved to Registro\/\d{4}-\d{2}-\d{2}\.md/);
    assert.equal(git(dir, "log", "-1", "--format=%an|%cn"), "Launch|Ravnir");

    assert.match(await say(base, hot.id, 'call tool remember {"fact":"Prefiere respuestas cortas","type":"preference","key":"estilo"}'), /Perfil\/Alex\.md/);
    assert.match(fs.readFileSync(path.join(dir, "Perfil/Alex.md"), "utf8"), /## Preferencias\n- Prefiere respuestas cortas \(clave: estilo, \d{4}-\d{2}-\d{2}, Launch\)/);

    const commits = git(dir, "rev-list", "--count", "HEAD");
    assert.match(await say(base, hot.id, 'call tool vault_append {"text":"token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'), /Refused/); // check-public: allow token (fake secret for a test)
    assert.equal(git(dir, "rev-list", "--count", "HEAD"), commits);

    assert.match(await say(base, hot.id, 'call tool propose_change {"note":"Rules.md","text":"2. Cite the note and its date.","why":"So answers match."}'), /approval/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "Rules.md"), "utf8"), /Cite the note/);
    const proposal = (await api(base, "GET", "/api/proposals?status=open")).items.find((item) => item.kind === "vault");
    assert.ok(proposal);
    const decided = await api(base, "POST", `/api/proposals/${proposal.id}`, { decision: "accept" });
    assert.ok(decided.commit);
    assert.match(fs.readFileSync(path.join(dir, "Rules.md"), "utf8"), /2\. Cite the note and its date\./);
    assert.match(git(dir, "log", "-1", "--format=%an|%s"), /^Launch\|Launch: Rules\.md \(approved by Alex\)$/);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
    for (const key of ["RAVNIR_VAULT_DIR", "RAVNIR_VAULT_WRITE", "RAVNIR_VAULT_SYNC_MS"]) delete process.env[key];
  }
});
