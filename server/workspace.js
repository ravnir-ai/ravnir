import fs from "node:fs/promises";
import path from "node:path";
import { unifiedDiff } from "./diff.js";

const SKIP = new Set(["node_modules", ".git", "dist", ".next"]);
const MAX_WALK_FILES = 400;
const MAX_FILE_BYTES = 500_000;
const MAX_WRITE_CHARS = 200_000;

export async function resolveInside(root, userPath = ".") {
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("Set a workspace in Setup before using coding tools.");
  }
  if (typeof userPath !== "string" || userPath.includes("\0")) {
    throw new Error("Path is invalid.");
  }
  const base = await realpathExisting(path.resolve(root));
  const stat = await fs.stat(base);
  if (!stat.isDirectory()) throw new Error("Workspace is not a directory.");

  const requested = path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(base, userPath);
  assertInside(base, requested);

  const parent = requested === base ? requested : path.dirname(requested);
  const existingParent = await nearestExisting(parent);
  const realParent = await fs.realpath(existingParent);
  assertInside(base, realParent);

  try {
    const real = await fs.realpath(requested);
    assertInside(base, real);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const rel = path.relative(base, requested);
  return { base, abs: requested, rel: rel || "." };
}

export async function listDir(root, userPath = ".") {
  const { abs, rel } = await resolveInside(root, userPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const rows = entries
    .filter((entry) => !SKIP.has(entry.name))
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${path.posix.join(rel === "." ? "" : rel, entry.name)}`.trim())
    .sort((a, b) => {
      const aDir = a.startsWith("dir ");
      const bDir = b.startsWith("dir ");
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
  if (!rows.length) return `${rel} is empty.`;
  return rows.join("\n");
}

export async function readFile(root, userPath, offset = 1, limit = 200) {
  const { abs, rel } = await resolveInside(root, userPath);
  const data = await fs.readFile(abs);
  if (data.includes(0)) throw new Error("File looks binary.");
  const text = data.toString("utf8");
  const lines = text.split("\n");
  const start = Math.max(1, Number(offset) || 1);
  const count = Math.min(400, Math.max(1, Number(limit) || 200));
  const slice = lines.slice(start - 1, start - 1 + count);
  const header = `${rel} lines ${start}-${start - 1 + slice.length} of ${lines.length}`;
  return `${header}\n${slice.join("\n")}`;
}

export async function searchFiles(root, query, userPath = ".") {
  if (typeof query !== "string" || !query.trim()) throw new Error("Search query is empty.");
  const needle = query.toLowerCase();
  const { abs, rel, base } = await resolveInside(root, userPath);
  const hits = [];
  let seen = 0;
  await walk(abs, rel, base, async (fileRel, fileAbs) => {
    if (hits.length >= 40) return;
    seen += 1;
    if (seen > MAX_WALK_FILES) return;
    const stat = await fs.stat(fileAbs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
    const data = await fs.readFile(fileAbs);
    if (data.includes(0)) return;
    const lines = data.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      hits.push(`${fileRel}:${i + 1}: ${lines[i].slice(0, 240)}`);
      if (hits.length >= 40) return;
    }
  });
  return hits.length ? hits.join("\n") : "No matches.";
}

export async function writeFile(root, userPath, content) {
  if (typeof content !== "string") throw new Error("write_file content must be a string.");
  if (content.length > MAX_WRITE_CHARS) throw new Error("Refusing to write a file larger than 200000 characters.");
  if (content.includes("\0")) throw new Error("Refusing to write binary content.");
  const { abs, rel } = await resolveInside(root, userPath);
  let before = "";
  try {
    const existing = await fs.readFile(abs);
    if (existing.includes(0)) throw new Error("Refusing to overwrite a binary file.");
    before = existing.toString("utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const diff = unifiedDiff(rel, before, content);
  if (diff.status === "unchanged") return { output: `${rel} is unchanged.`, diff: null };
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { output: `Wrote ${rel}.`, diff };
}

export async function editFile(root, userPath, oldText, replacement) {
  if (typeof oldText !== "string" || !oldText) throw new Error("edit_file needs the exact old text.");
  if (typeof replacement !== "string") throw new Error("edit_file replacement must be a string.");
  const { abs, rel } = await resolveInside(root, userPath);
  const existing = await fs.readFile(abs);
  if (existing.includes(0)) throw new Error("Refusing to edit a binary file.");
  const before = existing.toString("utf8");
  const found = indexesOf(before, oldText);
  if (found.length === 0) throw new Error("Old text was not found. Read the file and copy a longer unique snippet.");
  if (found.length > 1) throw new Error(`Old text matched ${found.length} times. Include more surrounding lines.`);
  const after = before.slice(0, found[0]) + replacement + before.slice(found[0] + oldText.length);
  const diff = unifiedDiff(rel, before, after);
  if (diff.status === "unchanged") return { output: `${rel} is unchanged.`, diff: null };
  await fs.writeFile(abs, after);
  return { output: `Edited ${rel}.`, diff };
}

function indexesOf(haystack, needle) {
  const found = [];
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    found.push(index);
    from = index + needle.length;
  }
  return found;
}

async function walk(abs, rel, base, visit) {
  let entries = [];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const childAbs = path.join(abs, entry.name);
    const childRel = rel === "." ? entry.name : path.posix.join(rel.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) await walk(childAbs, childRel, base, visit);
    else if (entry.isFile()) await visit(childRel, childAbs);
  }
}

function assertInside(base, target) {
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Path is outside the workspace.");
  }
}

async function realpathExisting(target) {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Workspace does not exist.");
    throw error;
  }
}

async function nearestExisting(target) {
  let current = target;
  for (;;) {
    try {
      await fs.stat(current);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Path is outside the workspace.");
      current = parent;
    }
  }
}

const SNAPSHOT_TOTAL = 12_000_000;
const SNAPSHOT_FILE = 300_000;

export async function snapshotWorkspace(root) {
  const base = await fs.realpath(path.resolve(root));
  const files = new Map();
  let total = 0;
  await walk(base, ".", base, async (rel, abs) => {
    if (total > SNAPSHOT_TOTAL) return;
    if (rel === "opencode.json" || rel.endsWith("/opencode.json")) return;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > SNAPSHOT_FILE) return;
      const data = await fs.readFile(abs);
      if (data.includes(0)) return;
      total += data.length;
      files.set(rel, data.toString("utf8"));
    } catch {
      // Ignore a file that disappeared while walking.
    }
  });
  return files;
}

export function compareSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const diffs = [];
  for (const rel of [...paths].sort()) {
    const oldText = before.has(rel) ? before.get(rel) : "";
    const newText = after.has(rel) ? after.get(rel) : "";
    if (oldText === newText) continue;
    const diff = unifiedDiff(rel, oldText, newText);
    if (diff.patch) diffs.push(diff);
  }
  return diffs;
}
