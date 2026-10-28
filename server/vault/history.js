import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv } from "../childEnv.js";

// Read-only views over the vault's git history for the Memory page: the timeline of commits,
// one commit's diff, and the turn that wrote it (the Ravnir-Turn trailer the writer adds).

const run = promisify(execFile);
const TIMEOUT_MS = 20_000;
const DIFF_MAX = 200_000;
const HASH = /^[0-9a-f]{7,40}$/i;
export const TURN_TRAILER = "Ravnir-Turn";
export const PROPOSAL_TRAILER = "Ravnir-Proposal";
export const REVERT_TRAILER = "Ravnir-Revert";

const git = async (dir, args) => (await run("git", ["-C", dir, "--literal-pathspecs", ...args], { env: childEnv({ GIT_TERMINAL_PROMPT: "0" }), timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout;

export function hasHistory(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, ".git"));
}

export function validHash(value) {
  return HASH.test(String(value || ""));
}

// A note path from the UI: relative, inside the vault, a Markdown file.
export function validNotePath(value) {
  const text = String(value || "");
  return Boolean(text) && text.length < 400 && !path.isAbsolute(text) && !text.includes("\\") && !text.split("/").includes("..") && text.endsWith(".md");
}

const FIELDS = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%s", `%(trailers:key=${TURN_TRAILER},valueonly,separator=%x2C)`, `%(trailers:key=${PROPOSAL_TRAILER},valueonly,separator=%x2C)`, `%(trailers:key=${REVERT_TRAILER},valueonly,separator=%x2C)`];

function parseLog(text) {
  const out = [];
  for (const chunk of text.split("\x1e")) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split("\0");
    const [hash, short, parents, author, email, at, subject, turn, proposal, reverts] = head.split("\x1f");
    if (!hash) continue;
    // -z keeps paths literal (no git quoting); only the first path has a format separator.
    const files = rest.map((file, index) => index === 0 ? file.replace(/^\n/, "") : file).filter(Boolean);
    out.push({
      hash,
      short,
      merge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
      root: !parents.trim(),
      author,
      email,
      at,
      subject,
      summary: plainSummary(subject, author),
      turnId: turn.trim(),
      proposalId: proposal.trim(),
      reverts: reverts.trim(),
      files,
    });
  }
  return out;
}

// What the writer's subjects ("Scout: remember People/Alex.md") mean, in words.
const OPS = {
  note: "Added a lesson to its own note",
  remember: "Remembered something about you",
  decision: "Logged a decision",
  activity: "Logged what it did",
  status: "Updated the live status",
};

function plainSummary(subject, author) {
  const own = subject.startsWith(`${author}: `) ? subject.slice(author.length + 2) : subject;
  const op = /^(\w+) \S+\.md$/.exec(own)?.[1];
  if (OPS[op]) return OPS[op];
  if (/ \(approved by [^)]+\)$/.test(own)) return `Changed ${own.replace(/ \(approved by ([^)]+)\)$/, ", approved by $1")}`;
  return own;
}

// Newest first. agent filters by author name, note by path; before is a hash to page past.
export async function vaultLog(dir, { agent = "", note = "", limit = 50, before = "" } = {}) {
  if (!hasHistory(dir)) return { items: [], more: false };
  const count = Math.min(200, Math.max(1, Number(limit) || 50));
  const args = ["log", `--format=%x1e${FIELDS.join("%x1f")}`, "--name-only", "-z", "--no-color", `--max-count=${count + 1}`];
  if (agent) args.push(`--author=^${String(agent).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} <`, "--extended-regexp");
  if (before) {
    if (!validHash(before)) throw new Error("That is not a commit.");
    args.push(`${before}~1`);
  } else {
    args.push("HEAD");
  }
  if (note) {
    if (!validNotePath(note)) throw new Error("That is not a vault note.");
    args.push("--", note);
  } else args.push("--");
  let text = "";
  try {
    text = await git(dir, args);
  } catch (error) {
    // A first page of an empty repo, or paging past the root commit.
    if (/unknown revision|bad revision|does not have any commits/i.test(String(error.stderr || error.message))) return { items: [], more: false };
    throw error;
  }
  const items = parseLog(text);
  return { items: items.slice(0, count), more: items.length > count };
}

// The commits one turn wrote, matched by the trailer the writer adds.
export async function vaultCommitsForTurn(dir, turnId) {
  const wanted = String(turnId || "").trim();
  if (!hasHistory(dir) || !wanted) return [];
  const text = await git(dir, [
    "log",
    `--format=%x1e${FIELDS.join("%x1f")}`,
    "--name-only",
    "-z",
    "--no-color",
    "--fixed-strings",
    `--grep=${TURN_TRAILER}: ${wanted}`,
    "HEAD",
    "--",
  ]).catch(() => "");
  return parseLog(text);
}

// The newest commit that changed one note, for a source chip's "why".
export async function vaultLatestCommit(dir, notePath) {
  if (!hasHistory(dir) || !validNotePath(notePath)) return null;
  const text = await git(dir, [
    "log",
    "-1",
    `--format=%x1e${FIELDS.join("%x1f")}`,
    "--name-only",
    "-z",
    "--no-color",
    "HEAD",
    "--",
    notePath,
  ]).catch(() => "");
  const [commit] = parseLog(text);
  return commit || null;
}

// Who has written to the vault, for the filter.
export async function vaultAuthors(dir) {
  if (!hasHistory(dir)) return [];
  const text = await git(dir, ["shortlog", "-sne", "HEAD", "--"]).catch(() => "");
  return text.split("\n").map((line) => /^\s*(\d+)\s+(.+?)\s+<([^>]*)>\s*$/.exec(line)).filter(Boolean).map((m) => ({ name: m[2], email: m[3], commits: Number(m[1]) }));
}

export async function vaultCommit(dir, hash) {
  if (!hasHistory(dir) || !validHash(hash)) return null;
  let text;
  try {
    text = await git(dir, ["show", `--format=%x1e${FIELDS.join("%x1f")}`, "--name-only", "-z", "--no-color", hash, "--"]);
  } catch {
    return null;
  }
  const [commit] = parseLog(text);
  if (!commit) return null;
  let diff = await git(dir, ["show", "--format=", "--patch", "--no-color", "--no-ext-diff", "--find-renames", hash, "--"]).catch(() => "");
  const truncated = diff.length > DIFF_MAX;
  if (truncated) diff = `${diff.slice(0, DIFF_MAX)}\n…`;
  const body = (await git(dir, ["show", "-s", "--format=%b", hash, "--"]).catch(() => "")).trim();
  const head = (await git(dir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  const onBranch = await git(dir, ["merge-base", "--is-ancestor", commit.hash, "HEAD"]).then(() => true, () => false);
  // Already undone: a later commit names this one in its revert trailer.
  const undone = (await git(dir, ["log", "--format=%h", `--grep=^${REVERT_TRAILER}: ${commit.hash}`, "HEAD", "--"]).catch(() => "")).trim();
  return { ...commit, body, diff, truncated, head: head === commit.hash, onBranch, revertedBy: undone.split("\n")[0] || "" };
}
