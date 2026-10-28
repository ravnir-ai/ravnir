import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { createApp } from "../server/index.js";
import { SecretStore } from "../server/secrets.js";
import { restoreArchive } from "../server/backup.js";
import { ensureLocalVault } from "../server/vault/local.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

async function call(base, method, pathname, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? headers : Buffer.isBuffer(body) ? { "content-type": "application/gzip", ...headers } : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  return response;
}

async function api(base, method, pathname, body, headers) {
  const response = await call(base, method, pathname, body, headers);
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(check, { tries = 150, delay = 100 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting.");
}

async function start(home) {
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

test("export plus restore rebuilds agents, threads, memory and secrets on a clean install", async () => {
  const saved = { vault: process.env.RAVNIR_VAULT, supervised: process.env.RAVNIR_SUPERVISED, invocation: process.env.INVOCATION_ID };
  process.env.RAVNIR_VAULT = "local";
  delete process.env.INVOCATION_ID;
  const mock = await startMock();
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-backup-a-"));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-backup-b-"));
  let a = await start(homeA);
  let b = null;
  try {
    await waitFor(async () => (await api(a.base, "GET", "/api/state")).vault?.writer?.available);
    await api(a.base, "PUT", "/api/settings", { owner: { name: "Alex", language: "en" } });
    const bot = (await api(a.base, "POST", "/api/bots", { name: "Scout", job: "Research.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } })).bot;
    await api(a.base, "POST", `/api/bots/${bot.id}/vault`, { site: "https://example.com", username: "alex", password: "correct horse battery", label: "Example" });
    const { turnId } = await api(a.base, "POST", `/api/bots/${bot.id}/messages`, { text: 'call tool remember {"fact":"Alex lives in Lisbon","type":"fact","key":"city"}' });
    await waitFor(async () => (await api(a.base, "GET", `/api/bots/${bot.id}/events?after=0`)).events.some((event) => event.type === "turn.end" && event.turnId === turnId));

    // A short passphrase is refused; without one the archive leaves the secrets out.
    assert.equal((await call(a.base, "POST", "/api/backup/export", { passphrase: "short" })).status, 400);
    const plain = await call(a.base, "POST", "/api/backup/export", {});
    assert.equal(plain.status, 200);
    assert.equal(JSON.parse(plain.headers.get("x-ravnir-backup")).secrets, "omitted");
    await plain.arrayBuffer();
    const exported = await call(a.base, "POST", "/api/backup/export", { passphrase: "a long passphrase here" });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /ravnir-backup-\d{8}-\d{4}\.tar\.gz/);
    const archive = Buffer.from(await exported.arrayBuffer());
    const listing = execFileSync("tar", ["-tzf", "-"], { input: archive, encoding: "utf8" });
    assert.match(listing, /ravnir-backup\/vault\.bundle/);
    assert.match(listing, /ravnir-backup\/secrets\.sealed\.json/);
    assert.doesNotMatch(listing, /master\.key|secrets\.enc|sessions\.json/);
    // The sealed part does not hold the password in clear.
    assert.doesNotMatch(execFileSync("tar", ["-xzOf", "-", "ravnir-backup/secrets.sealed.json"], { input: archive, encoding: "utf8" }), /correct horse/);

    // An install with agents refuses a restore.
    assert.equal((await call(a.base, "POST", "/api/backup/restore", archive)).status, 409);
    await stop(a.server);
    a = null;

    // A clean install: a wrong passphrase is refused and changes nothing.
    b = await start(homeB);
    await waitFor(async () => (await api(b.base, "GET", "/api/state")).vault?.available);
    const wrong = await call(b.base, "POST", "/api/backup/restore", archive, { "x-ravnir-passphrase": "not the passphrase" });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /passphrase/);
    assert.equal((await api(b.base, "GET", "/api/state")).bots.length, 0);
    const restored = await api(b.base, "POST", "/api/backup/restore", archive, { "x-ravnir-passphrase": encodeURIComponent("a long passphrase here") });
    assert.equal(restored.bots, 1);
    assert.equal(restored.secrets, true);
    assert.equal(restored.vault, "restored with its history");
    assert.equal(restored.restart, "manual");
    assert.equal((await api(b.base, "GET", "/api/state")).bots.length, 1);
    await stop(b.server);

    // After the restart: the agent, its thread, its saved login and the vault with its history.
    b = await start(homeB);
    await waitFor(async () => (await api(b.base, "GET", "/api/state")).vault?.writer?.available);
    const detail = await api(b.base, "GET", `/api/bots/${bot.id}`);
    assert.equal(detail.bot.name, "Scout");
    assert.ok(detail.conversation.some((message) => /People\/Alex\.md/.test(message.content || "")));
    assert.equal(new SecretStore(homeB).get(`vault:${bot.id}:${detail.bot.vault[0].id}`), "correct horse battery");
    assert.match(fs.readFileSync(path.join(homeB, "vault", "People", "Alex.md"), "utf8"), /Alex lives in Lisbon/);
    const log = await api(b.base, "GET", "/api/memory/log?agent=Scout");
    assert.equal(log.items[0].turnId, turnId);
    assert.equal(fs.readdirSync(homeB).some((name) => name.startsWith("vault.before-restore-")), true);
  } finally {
    if (a) await stop(a.server);
    if (b) await stop(b.server);
    await mock.close();
    for (const [key, name] of [["vault", "RAVNIR_VAULT"], ["supervised", "RAVNIR_SUPERVISED"], ["invocation", "INVOCATION_ID"]]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});

test("restore rejects agent ids that escape the data folder before replacing any files", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-backup-invalid-"));
  try {
    const root = path.join(scratch, "ravnir-backup");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ app: "ravnir", format: 1, vault: null, secrets: "omitted" }));
    fs.writeFileSync(path.join(root, "data", "state.json"), JSON.stringify({ bots: [{ id: "../../escaped", name: "Invalid" }] }));
    const archive = path.join(scratch, "invalid.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", scratch, "ravnir-backup"]);
    const home = path.join(scratch, "home");
    fs.mkdirSync(home);
    const before = JSON.stringify({ bots: [], settings: { obsidian: "Keep me" } });
    fs.writeFileSync(path.join(home, "state.json"), before);
    await assert.rejects(restoreArchive({ file: archive, home }), /agent|backup/i);
    assert.equal(fs.readFileSync(path.join(home, "state.json"), "utf8"), before);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a corrupt vault bundle does not replace the fresh install's state or vault", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-backup-corrupt-"));
  try {
    const root = path.join(scratch, "ravnir-backup");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ app: "ravnir", format: 1, vault: "bundle", secrets: "omitted" }));
    fs.writeFileSync(path.join(root, "data", "state.json"), JSON.stringify({ bots: [{ id: "restored-agent", name: "Scout" }] }));
    fs.writeFileSync(path.join(root, "vault.bundle"), "corrupt bundle\n");
    const archive = path.join(scratch, "corrupt.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", scratch, "ravnir-backup"]);
    const home = path.join(scratch, "home");
    const vaultDir = path.join(home, "vault");
    ensureLocalVault(vaultDir);
    const before = JSON.stringify({ bots: [], settings: { obsidian: "Keep me" } });
    fs.writeFileSync(path.join(home, "state.json"), before);
    await assert.rejects(restoreArchive({ file: archive, home, vaultDir }));
    assert.equal(fs.readFileSync(path.join(home, "state.json"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(vaultDir, ".git")), true);
    assert.equal(fs.readdirSync(home).some((name) => name.startsWith("vault.before-restore-")), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
