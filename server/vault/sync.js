import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv } from "../childEnv.js";

// Read-only git: clone once, then fast-forward pulls. Never commits, pushes,
// resets, stashes or cleans, so a bad remote cannot damage local notes.

const run = promisify(execFile);
const PULL_TIMEOUT_MS = 60000;
const CLONE_TIMEOUT_MS = 120000;

function gitEnv(sshCommand) {
  const env = childEnv({ SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GIT_TERMINAL_PROMPT: "0" });
  if (sshCommand) env.GIT_SSH_COMMAND = sshCommand;
  return env;
}

function message(error) {
  const text = String(error?.stderr || error?.message || error || "").trim();
  return text.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || "git failed";
}

async function head(dir, sshCommand) {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"], { env: gitEnv(sshCommand), timeout: 15000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function ensureClone({ remote = "", dir, sshCommand = "" } = {}) {
  if (!remote || !dir || fs.existsSync(dir)) return { cloned: false, error: null };
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await run("git", ["clone", "--depth", "50", "--", remote, dir], { env: gitEnv(sshCommand), timeout: CLONE_TIMEOUT_MS });
    return { cloned: true, error: null };
  } catch (error) {
    return { cloned: false, error: message(error) };
  }
}

export async function pull({ dir, sshCommand = "" } = {}) {
  const before = await head(dir, sshCommand);
  try {
    await run("git", ["-C", dir, "pull", "--ff-only", "--quiet"], { env: gitEnv(sshCommand), timeout: PULL_TIMEOUT_MS });
  } catch (error) {
    return { updated: false, error: message(error) };
  }
  const after = await head(dir, sshCommand);
  return { updated: before !== after, error: null };
}
