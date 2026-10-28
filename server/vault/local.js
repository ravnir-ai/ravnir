import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { childEnv } from "../childEnv.js";

// The vault a fresh install starts with: a git repo under the data folder with two starter
// notes, so agents can remember from the first turn. Linking a remote later (the first-run
// wizard) switches this same folder to the remote's branch; whatever was written locally
// stays on a branch of its own, never thrown away.

const run = promisify(execFile);
const RAVNIR = { name: "Ravnir", email: "ravnir@ravnir.local" };
const GIT_TIMEOUT_MS = 60_000;
// Published by GitHub (api.github.com/meta), checked 2026-10-25. Other hosts are trusted on first use.
const GITHUB_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

const STARTER = {
  "Home.md": `# Ravnir vault

Shared memory for the agents on this server, kept in git. Open this folder in Obsidian to read and edit it.

- Rules.md: rules every agent follows, read before every turn.
- Agents/: one note per agent, written by that agent.
- Projects/: one note per project. Agents propose changes to these and you approve them.
- Decisions-Log.md: decisions, newest last.

The daily log and the note about you appear once agents start writing.
`,
  "Rules.md": `# Rules

Every agent reads this note before each turn. Keep it short. Agents can propose changes; you approve them in Home.

- Save lasting facts about the owner with remember, not only in chat.
- Never write passwords, API keys or tokens into the vault.
`,
  "Decisions-Log.md": `# Decisions log

`,
};

const errorText = (error) => String(error?.stderr || error?.message || error || "failed").trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);

function gitEnv(sshCommand = "") {
  const env = childEnv({ SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GIT_TERMINAL_PROMPT: "0", GIT_COMMITTER_NAME: RAVNIR.name, GIT_COMMITTER_EMAIL: RAVNIR.email, GIT_AUTHOR_NAME: RAVNIR.name, GIT_AUTHOR_EMAIL: RAVNIR.email });
  if (sshCommand) env.GIT_SSH_COMMAND = sshCommand;
  return env;
}

const git = async (dir, args, { sshCommand = "", timeout = GIT_TIMEOUT_MS } = {}) => (await run("git", ["-C", dir, ...args], { env: gitEnv(sshCommand), timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;

// Creates the starter vault when the folder has no repo yet. Synchronous: it runs once, at startup.
export function ensureLocalVault(dir) {
  if (fs.existsSync(path.join(dir, ".git"))) return { created: false };
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(STARTER)) {
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, text);
  }
  const env = gitEnv();
  const opts = { env, stdio: "ignore", timeout: 30_000 };
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], opts);
  execFileSync("git", ["-C", dir, "add", "-A"], opts);
  execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", "Ravnir: start the vault"], opts);
  return { created: true };
}

export function currentBranch(dir) {
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) return "";
    return execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"], { env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

// The key this server uses for the vault remote. Made on first use; the public half is what the
// owner adds as a deploy key with write access.
export function deployKey(home, { create = true } = {}) {
  const folder = path.join(home, "vault-ssh");
  const key = path.join(folder, "id_ed25519");
  const knownHosts = path.join(folder, "known_hosts");
  if (!fs.existsSync(key)) {
    if (!create) return null;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `ravnir@${os.hostname().split(".")[0] || "server"}`, "-f", key], { stdio: "ignore", timeout: 30_000 });
  }
  if (!fs.existsSync(knownHosts)) fs.writeFileSync(knownHosts, `${GITHUB_HOST_KEY}\n`, { mode: 0o600 });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    publicKey: fs.readFileSync(`${key}.pub`, "utf8").trim(),
    sshCommand: `ssh -i ${quote(key)} -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=${quote(knownHosts)} -o StrictHostKeyChecking=accept-new`,
  };
}

// ssh (git@host:owner/repo.git or ssh://) or https without a password in it. file:// only for tests.
export function checkRemote(value, { allowFile = process.env.RAVNIR_VAULT_ALLOW_FILE === "1" } = {}) {
  const url = String(value || "").trim();
  if (!url || url.length > 300 || /\s/.test(url)) return { error: "Paste the repository's address, for example git@github.com:you/notes.git." };
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url)) return { url, ssh: true };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "That is not a git address. Use the SSH one, for example git@github.com:you/notes.git." };
  }
  if (parsed.protocol === "file:" && allowFile) return { url, ssh: false };
  if (!["ssh:", "https:"].includes(parsed.protocol)) return { error: "Use an SSH or https address." };
  if (parsed.password || (parsed.protocol === "https:" && parsed.username)) return { error: "Do not put a password or token in the address. Use the SSH address and the key below." };
  return { url, ssh: parsed.protocol === "ssh:" };
}

// Points the vault folder at a remote. An empty remote gets the local notes; otherwise the
// folder switches to the remote's default branch and the local history is kept on a branch.
export async function linkRemote({ dir, url, sshCommand = "", now = Date.now }) {
  let listing;
  try {
    listing = await git(dir, ["ls-remote", "--symref", "--", url, "HEAD"], { sshCommand, timeout: 45_000 });
  } catch (error) {
    const text = errorText(error);
    if (/permission denied|publickey|access denied|not found|could not read|repository .* not found/i.test(text)) {
      return { ok: false, error: `The server could not open that repository. Add the key below as a deploy key with write access, then try again. (${text})` };
    }
    return { ok: false, error: `Could not reach the repository: ${text}` };
  }
  const head = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(listing)?.[1] || "";
  const remotes = (await git(dir, ["remote"])).split("\n").map((line) => line.trim());
  await git(dir, ["remote", remotes.includes("origin") ? "set-url" : "add", "origin", url]);
  const status = (await git(dir, ["status", "--porcelain"])).trim();
  if (status) {
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", "Ravnir: save local notes before linking"]);
  }
  const local = currentBranch(dir) || "main";
  if (!head && !listing.trim()) {
    // A new, empty repository: it starts with what this server has.
    try {
      await git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${local}`], { sshCommand });
    } catch (error) {
      return { ok: false, error: `The repository is empty but the server could not write to it. Give the key write access. (${errorText(error)})` };
    }
    await git(dir, ["fetch", "--quiet", "origin", local], { sshCommand });
    await git(dir, ["branch", "--quiet", "--set-upstream-to", `origin/${local}`]).catch(() => {});
    return { ok: true, branch: local, saved: null, pushed: true };
  }
  const branch = head || "main";
  await git(dir, ["fetch", "--quiet", "origin", branch], { sshCommand });
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  let saved = `ravnir/local-${stamp}`;
  for (let n = 2; await git(dir, ["rev-parse", "--verify", "-q", `refs/heads/${saved}`]).then(() => true, () => false); n += 1) saved = `ravnir/local-${stamp}-${n}`;
  await git(dir, ["branch", saved]);
  await git(dir, ["checkout", "-q", "-f", "-B", branch, `origin/${branch}`]);
  await git(dir, ["branch", "--quiet", "--set-upstream-to", `origin/${branch}`]).catch(() => {});
  if (local !== branch) await git(dir, ["branch", "-q", "-D", local]).catch(() => {});
  return { ok: true, branch, saved, pushed: false };
}
