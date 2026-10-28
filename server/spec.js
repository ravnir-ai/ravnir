import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { namedDiff } from "./diff.js";
import { botHome } from "./state.js";

// A bot can follow a spec file. The bot runs on the approved copy, never on the
// live file, so an edit to the file only reaches the bot after someone applies it.

const MAX_SPEC = 64_000;

export function resolveSpecPath(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Give the path of the spec file.");
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) throw new Error("Use an absolute path, or one that starts with ~/.");
  return path.normalize(expanded);
}

export function readSpecFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`No file at ${file}.`);
  }
  if (!stat.isFile()) throw new Error(`${file} is not a file.`);
  if (stat.size > MAX_SPEC) throw new Error(`The spec is ${Math.round(stat.size / 1000)} KB. The limit is ${MAX_SPEC / 1000} KB.`);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("\u0000")) throw new Error("That file is not text.");
  return { text, mtimeMs: stat.mtimeMs, size: stat.size, hash: hashOf(text) };
}

function appliedFile(home, bot) {
  return path.join(botHome(home, bot), "spec-applied.md");
}

export function readAppliedSpec(home, bot) {
  if (!bot.spec?.path) return "";
  try {
    return fs.readFileSync(appliedFile(home, bot), "utf8");
  } catch {
    return "";
  }
}

export function linkSpec(home, bot, input) {
  const file = resolveSpecPath(input);
  const current = readSpecFile(file);
  bot.spec = { path: file, appliedAt: 0, hash: "", status: "current" };
  return applySpec(home, bot, current);
}

export function applySpec(home, bot, current = null) {
  if (!bot.spec?.path) throw new Error("This bot has no spec file.");
  const latest = current || readSpecFile(bot.spec.path);
  fs.mkdirSync(botHome(home, bot), { recursive: true });
  fs.writeFileSync(appliedFile(home, bot), latest.text);
  bot.spec = {
    ...bot.spec,
    hash: latest.hash,
    currentHash: latest.hash,
    mtimeMs: latest.mtimeMs,
    appliedAt: Date.now(),
    checkedAt: Date.now(),
    status: "current",
    error: "",
    dismissedHash: "",
    dismissedAt: 0,
  };
  return bot.spec;
}

// Dismiss the current version without applying it. Today stops asking about it
// until the file changes again; Mind still shows the diff.
export function dismissSpec(bot) {
  if (!bot.spec?.path) throw new Error("This bot has no spec file.");
  if (!bot.spec.currentHash) checkSpec(bot);
  bot.spec.dismissedHash = bot.spec.status === "missing" ? "missing" : bot.spec.currentHash || "";
  bot.spec.dismissedAt = Date.now();
  return bot.spec;
}

export function specNeedsAttention(spec) {
  if (!spec?.path) return false;
  if (spec.status === "missing") return spec.dismissedHash !== "missing";
  if (spec.status !== "changed") return false;
  return !spec.dismissedHash || spec.dismissedHash !== spec.currentHash;
}

export function unlinkSpec(home, bot) {
  try {
    fs.rmSync(appliedFile(home, bot), { force: true });
  } catch {
    // Already gone.
  }
  delete bot.spec;
}

// Cheap check: only hash when the file's mtime or size moved. Returns true when the status changed.
export function checkSpec(bot) {
  if (!bot.spec?.path) return false;
  const before = bot.spec.status;
  let stat;
  try {
    stat = fs.statSync(bot.spec.path);
  } catch {
    bot.spec.status = "missing";
    bot.spec.error = `No file at ${bot.spec.path}.`;
    bot.spec.checkedAt = Date.now();
    return before !== "missing";
  }
  if (stat.mtimeMs === bot.spec.mtimeMs && bot.spec.status !== "missing") return false;
  try {
    const current = readSpecFile(bot.spec.path);
    bot.spec.currentHash = current.hash;
    bot.spec.mtimeMs = current.mtimeMs;
    bot.spec.status = current.hash === bot.spec.hash ? "current" : "changed";
    bot.spec.error = "";
    if (bot.spec.status === "current") {
      bot.spec.dismissedHash = "";
      bot.spec.dismissedAt = 0;
    } else if (bot.spec.status === "changed" && before !== "changed") {
      bot.spec.changedAt = Date.now();
    }
  } catch (error) {
    bot.spec.status = "missing";
    bot.spec.error = error.message;
  }
  bot.spec.checkedAt = Date.now();
  return before !== bot.spec.status;
}

export function specView(home, bot) {
  if (!bot.spec?.path) return { spec: null, diff: "" };
  const applied = readAppliedSpec(home, bot);
  let diff = "";
  if (bot.spec.status === "changed") {
    try {
      diff = namedDiff("applied", "file now", applied, readSpecFile(bot.spec.path).text);
    } catch (error) {
      diff = error.message;
    }
  }
  return { spec: publicSpec(bot.spec), applied, diff };
}

export function publicSpec(spec) {
  if (!spec?.path) return null;
  return {
    path: spec.path,
    status: spec.status || "current",
    appliedAt: spec.appliedAt || 0,
    changedAt: spec.changedAt || 0,
    checkedAt: spec.checkedAt || 0,
    dismissedAt: spec.dismissedAt || 0,
    needsAttention: specNeedsAttention(spec),
    error: spec.error || "",
  };
}

function hashOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}
