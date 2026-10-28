import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv } from "./childEnv.js";

// One archive with everything a fresh install needs to become this one: agents and their
// threads, the ledger, approvals and questions, the vault (as a git bundle, so its history
// comes along), and, only under a passphrase, the saved secrets. Restore unpacks it into a
// data folder that has no agents yet.

const run = promisify(execFile);
const FORMAT = 1;
const ROOT = "ravnir-backup";
const MIN_PASSPHRASE = 10;
// What the data folder holds at the top that belongs to the setup, not to this machine.
// Left out on purpose: master.key and secrets.enc (secrets travel re-encrypted), sessions.json
// (sign-ins), vapid.json and subscriptions.json (push is tied to the devices), jev-usage.ndjson.
const TOP_FILES = ["state.json", "turns.ndjson", "approvals.json", "asks.json", "proposals.json", "notifications.json", "status-feeds.json", "vault-status-day.json"];
// Per agent: the thread and what the agent made, not its browser profile or installed tools.
const BOT_FILES = ["conversation.json", "conversation-archive.ndjson", "diffs.json", "spec-applied.md", "events.ndjson"];
const BOT_DIRS = ["artifacts"];
// Files under the data folder that are secrets and only travel inside the encrypted part.
const SECRET_FILES = ["vault-ssh/id_ed25519", "vault-ssh/id_ed25519.pub", "vault-ssh/known_hosts"];
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export class BackupError extends Error {}
const fail = (message) => {
  throw new BackupError(message);
};

const git = (dir, args, opts = {}) => run("git", dir ? ["-C", dir, ...args] : args, { env: childEnv({ GIT_TERMINAL_PROMPT: "0" }), timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts });

function copyInto(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: false, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
  return true;
}

function sealSecrets(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
  return { kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function openSecrets(envelope, passphrase) {
  try {
    const key = crypto.scryptSync(passphrase, Buffer.from(envelope.salt, "base64"), 32, { N: envelope.N, r: envelope.r, p: envelope.p, maxmem: SCRYPT.maxmem });
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    fail("That passphrase does not open the secrets in this backup.");
  }
}

export function checkPassphrase(passphrase) {
  if (!passphrase) return "";
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) return `Use a passphrase of at least ${MIN_PASSPHRASE} characters, or leave it empty to export without secrets.`;
  return "";
}

// Writes the archive (a .tar.gz) and returns its path; the caller removes it after sending.
export async function exportArchive({ home, secrets = null, vaultDir = "", passphrase = "", workspaces = false, version = "", now = Date.now } = {}) {
  const problem = checkPassphrase(passphrase);
  if (problem) fail(problem);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-export-"));
  const root = path.join(scratch, ROOT);
  try {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    for (const file of TOP_FILES) copyInto(path.join(home, file), path.join(root, "data", file));
    const state = readJson(path.join(home, "state.json")) || { bots: [] };
    const bots = Array.isArray(state.bots) ? state.bots : [];
    for (const bot of bots) {
      if (!/^[\w-]{1,80}$/.test(String(bot.id || ""))) continue;
      const from = path.join(home, "bots", bot.id);
      const to = path.join(root, "data", "bots", bot.id);
      for (const file of BOT_FILES) copyInto(path.join(from, file), path.join(to, file));
      for (const dir of BOT_DIRS) copyInto(path.join(from, dir), path.join(to, dir));
      if (workspaces) copyInto(path.join(from, "workspace"), path.join(to, "workspace"));
    }
    let vault = null;
    if (vaultDir && fs.existsSync(path.join(vaultDir, ".git"))) {
      await git(vaultDir, ["bundle", "create", path.join(root, "vault.bundle"), "--all"]);
      vault = "bundle";
    } else if (vaultDir && fs.existsSync(vaultDir)) {
      copyInto(vaultDir, path.join(root, "vault"));
      vault = "files";
    }
    let sealed = "omitted";
    if (passphrase && secrets) {
      const files = {};
      for (const rel of SECRET_FILES) {
        const file = path.join(home, rel);
        if (fs.existsSync(file)) files[rel] = fs.readFileSync(file).toString("base64");
      }
      fs.writeFileSync(path.join(root, "secrets.sealed.json"), JSON.stringify(sealSecrets({ secrets: secrets.data || {}, files }, passphrase)));
      sealed = "passphrase";
    }
    const manifest = { format: FORMAT, app: "ravnir", version, createdAt: new Date(now()).toISOString(), bots: bots.map((bot) => ({ id: bot.id, name: bot.name })), vault, secrets: sealed, workspaces: Boolean(workspaces) };
    fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const stamp = new Date(now()).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    const out = path.join(scratch, `ravnir-backup-${stamp}.tar.gz`);
    await run("tar", ["-czf", out, "-C", scratch, ROOT], { timeout: 300_000 });
    fs.rmSync(root, { recursive: true, force: true });
    return { file: out, name: path.basename(out), manifest, cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

// Unpacks an archive into `home`. Refuses a data folder that already has agents unless force.
// secrets is the live SecretStore of the new install: restored secrets are saved under its key.
// vaultDir is where this install keeps its vault; it is only filled when it is the local vault
// under the data folder and still holds nothing but the starter notes.
export async function restoreArchive({ file, home, passphrase = "", secrets = null, vaultDir = "", force = false, now = Date.now } = {}) {
  if (!file || !fs.existsSync(file)) fail("No backup file.");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-restore-"));
  try {
    // List first: every entry must sit under ravnir-backup/ with no .. and no absolute path.
    const { stdout } = await run("tar", ["-tzf", file], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }).catch(() => fail("That is not a Ravnir backup (not a .tar.gz)."));
    const entries = stdout.split("\n").filter(Boolean);
    if (!entries.length || entries.some((entry) => path.isAbsolute(entry) || entry.split("/").includes("..") || !(entry === `${ROOT}/` || entry === ROOT || entry.startsWith(`${ROOT}/`)))) fail("That is not a Ravnir backup.");
    await run("tar", ["-xzf", file, "-C", scratch, "--no-same-owner", "--no-same-permissions"], { timeout: 300_000 });
    const root = path.join(scratch, ROOT);
    // Links in the archive could point outside the data folder once copied.
    assertNoLinks(root);
    const manifest = readJson(path.join(root, "manifest.json"));
    if (!manifest || manifest.app !== "ravnir" || manifest.format !== FORMAT) fail("That is not a Ravnir backup this version can read.");
    const data = path.join(root, "data");
    const restoredState = readJson(path.join(data, "state.json"));
    // loadState uses these ids as directory names after restore, so validate them before copying.
    if (!Array.isArray(restoredState?.bots) || restoredState.bots.some((bot) => typeof bot?.id !== "string" || !/^[\w-]{1,80}$/.test(bot.id))) fail("That backup has invalid agent data.");
    const current = readJson(path.join(home, "state.json"));
    if (!force && Array.isArray(current?.bots) && current.bots.length) fail("This install already has agents. Restore into a fresh install.");
    let sealed = null;
    if (manifest.secrets === "passphrase") {
      if (!passphrase) fail("This backup has secrets. Enter the passphrase it was exported with.");
      sealed = openSecrets(readJson(path.join(root, "secrets.sealed.json")) || {}, passphrase);
    }
    // Validate the bundle's objects before replacing state or moving aside the starter vault.
    let preparedVault = "";
    if (manifest.vault === "bundle" && vaultDir && path.resolve(vaultDir) === path.resolve(home, "vault")) {
      preparedVault = path.join(scratch, "checked-vault.git");
      await git("", ["clone", "--quiet", "--mirror", path.join(root, "vault.bundle"), preparedVault]).catch(() => fail("The vault in this backup is damaged or incomplete."));
    }
    fs.mkdirSync(home, { recursive: true });
    for (const name of TOP_FILES) {
      const from = path.join(data, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, safeTarget(home, name));
    }
    const restoredBots = [];
    if (fs.existsSync(path.join(data, "bots"))) {
      for (const id of fs.readdirSync(path.join(data, "bots"))) {
        if (!/^[\w-]{1,80}$/.test(id)) continue;
        copyInto(path.join(data, "bots", id), safeTarget(home, path.join("bots", id)));
        restoredBots.push(id);
      }
    }
    if (sealed) {
      for (const [rel, b64] of Object.entries(sealed.files || {})) {
        if (!SECRET_FILES.includes(rel)) continue;
        const target = safeTarget(home, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, Buffer.from(b64, "base64"), { mode: 0o600 });
      }
      if (secrets) {
        secrets.data = { ...(secrets.data || {}), ...(sealed.secrets || {}) };
        secrets.save();
      }
    }
    const vault = await restoreVault({ root, manifest, vaultDir, home, now, preparedVault });
    return { ok: true, manifest, bots: restoredBots.length, secrets: Boolean(sealed), vault };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function restoreVault({ root, manifest, vaultDir, home, now, preparedVault = "" }) {
  if (!manifest.vault) return "none in the backup";
  const local = vaultDir && path.resolve(vaultDir) === path.resolve(home, "vault");
  if (!local) return vaultDir ? "kept: this install reads its vault from elsewhere" : "kept in the backup: this install has no vault";
  safeTarget(home, "vault");
  if (fs.existsSync(vaultDir)) {
    const count = await git(vaultDir, ["rev-list", "--count", "HEAD"]).then(({ stdout }) => Number(stdout.trim()), () => 0);
    if (count > 1) return "kept: this install's vault already has notes";
    const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
    fs.renameSync(vaultDir, `${vaultDir}.before-restore-${stamp}`);
  }
  if (manifest.vault === "bundle") {
    const bundle = preparedVault || path.join(root, "vault.bundle");
    await git("", ["clone", "--quiet", bundle, vaultDir]);
    await git(vaultDir, ["remote", "remove", "origin"]).catch(() => {});
    // The settings say which remote this vault followed; the restored deploy key reaches it.
    const remote = readJson(path.join(home, "state.json"))?.settings?.vaultRemote?.url;
    if (remote) await git(vaultDir, ["remote", "add", "origin", remote]).catch(() => {});
    return "restored with its history";
  }
  copyInto(path.join(root, "vault"), vaultDir);
  return "restored";
}

function assertNoLinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail("That backup contains links, which Ravnir does not restore.");
    if (entry.isDirectory()) assertNoLinks(full);
  }
}

// Every existing part of the path from home to the target must be a real folder or file, so a
// link planted in the data folder cannot send a restored file somewhere else.
function safeTarget(home, rel) {
  const target = path.join(home, rel);
  let current = home;
  for (const part of path.relative(home, target).split(path.sep)) {
    if (!part || part === "..") fail("That backup has a path Ravnir does not restore.");
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`Ravnir will not restore over a link (${rel}).`);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      break;
    }
  }
  if (fs.existsSync(home) && fs.lstatSync(home).isSymbolicLink()) fail("The data folder is a link; restore into a real folder.");
  return target;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Under systemd, Podman or Docker something restarts the server after it exits.
export function supervised(env = process.env) {
  return Boolean(env.INVOCATION_ID || env.container || env.RAVNIR_SUPERVISED === "1" || fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"));
}
