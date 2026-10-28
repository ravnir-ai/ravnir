#!/usr/bin/env node
// Builds a clean public copy of this repository: no history, no private files.
//
// Usage: node scripts/export-public.mjs --out DIR [--ref REF | --worktree] [--message MSG]
//
//   --out DIR       Target folder. A new or empty folder gets a fresh git repository with
//                   one commit. An existing git clone (clean tree) gets its content replaced
//                   and a commit only when something changed.
//   --ref REF       Export the files of this commit (default HEAD).
//   --worktree      Export tracked and untracked-not-ignored files from the working tree
//                   instead, to test before committing.
//   --message MSG   Commit message (default "Ravnir <version from package.json>").
//   --source DIR    Repository to export (default: the one this script belongs to).
//
// The tree is built in a temporary folder and scanned with scripts/check-public.mjs using
// export/deny.txt. Every binary file in it must be listed with its hash in the source's
// export/binaries.txt, and symlinks are refused. On any finding nothing is written to --out
// and nothing is committed. Updating an existing clone stages the new tree next to it first;
// if the replacement fails the clone is restored to its last commit. This script never pushes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileExcludes, formatFinding, parseBinaries, parseDeny, scanRoot } from "./check-public.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = "Usage: node scripts/export-public.mjs --out DIR [--ref REF | --worktree] [--message MSG]";

class UsageError extends Error {}

function git(cwd, args, { env, input } = {}) {
  return execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function parseArgs(argv) {
  const opts = { ref: null, worktree: false, out: null, message: null, source: path.resolve(HERE, "..") };
  const need = (i, name) => {
    if (argv[i + 1] === undefined) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") opts.out = path.resolve(need(i++, arg));
    else if (arg === "--ref") opts.ref = need(i++, arg);
    else if (arg === "--worktree") opts.worktree = true;
    else if (arg === "--message") opts.message = need(i++, arg);
    else if (arg === "--source") opts.source = path.resolve(need(i++, arg));
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new UsageError(`unknown argument ${arg}`);
  }
  if (opts.help) return opts;
  if (!opts.out) throw new UsageError("--out is required");
  if (opts.worktree && opts.ref) throw new UsageError("--ref and --worktree cannot be combined");
  if (!opts.worktree && !opts.ref) opts.ref = "HEAD";
  return opts;
}

function realpathOfExistingPart(p) {
  let cur = p;
  const rest = [];
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sourceRoot(source) {
  let top;
  try {
    top = git(source, ["rev-parse", "--show-toplevel"]).toString().trim();
  } catch {
    throw new UsageError(`${source} is not a git repository`);
  }
  return fs.realpathSync(top);
}

function readRef(root, ref, file) {
  try { return git(root, ["show", `${ref}:${file}`]).toString("utf8"); } catch { return null; }
}

function copyEntry(from, to) {
  const st = fs.lstatSync(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (st.isSymbolicLink()) {
    fs.rmSync(to, { force: true });
    fs.symlinkSync(fs.readlinkSync(from), to);
  } else {
    fs.copyFileSync(from, to);
    fs.chmodSync(to, st.mode & 0o777);
  }
}

function copyTree(fromDir, toDir) {
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copyTree(from, to); }
    else copyEntry(from, to);
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

// Builds the tree into `stage`. Returns { exported, excluded, deny }.
function buildTree(root, opts, stage) {
  let listed;
  let excludeText;
  let denyText;
  let binariesText;
  if (opts.worktree) {
    const raw = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]).toString("utf8");
    listed = [...new Set(raw.split("\0").filter(Boolean))].filter((f) => {
      try { const st = fs.lstatSync(path.join(root, f)); return st.isFile() || st.isSymbolicLink(); } catch { return false; }
    });
    excludeText = fs.existsSync(path.join(root, "export/exclude.txt")) ? fs.readFileSync(path.join(root, "export/exclude.txt"), "utf8") : null;
    denyText = fs.existsSync(path.join(root, "export/deny.txt")) ? fs.readFileSync(path.join(root, "export/deny.txt"), "utf8") : null;
    binariesText = fs.existsSync(path.join(root, "export/binaries.txt")) ? fs.readFileSync(path.join(root, "export/binaries.txt"), "utf8") : null;
  } else {
    try { git(root, ["rev-parse", "--verify", "--quiet", `${opts.ref}^{commit}`]); }
    catch { throw new UsageError(`unknown ref ${opts.ref}`); }
    const raw = git(root, ["ls-tree", "-r", "-z", opts.ref]).toString("utf8");
    listed = raw.split("\0").filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        return { mode: entry.slice(0, 6), file: entry.slice(tab + 1) };
      })
      .filter((e) => e.mode !== "160000")
      .map((e) => e.file);
    excludeText = readRef(root, opts.ref, "export/exclude.txt");
    denyText = readRef(root, opts.ref, "export/deny.txt");
    binariesText = readRef(root, opts.ref, "export/binaries.txt");
  }
  if (excludeText === null) throw new UsageError("export/exclude.txt not found in the source");
  if (denyText === null) throw new UsageError("export/deny.txt not found in the source");
  const deny = parseDeny(denyText);
  let binaries;
  try { binaries = parseBinaries(binariesText || ""); } catch (err) { throw new UsageError(err.message); }
  // An overlay binary is reviewed under its source path; accept it under its public path too.
  for (const [p, hash] of [...binaries]) {
    if (p.startsWith("export/overlay/") && !binaries.has(p.slice("export/overlay/".length))) binaries.set(p.slice("export/overlay/".length), hash);
  }
  const isExcluded = compileExcludes(excludeText);
  const kept = listed.filter((f) => !isExcluded(f));

  if (opts.worktree) {
    for (const f of kept) copyEntry(path.join(root, f), path.join(stage, f));
  } else if (kept.length) {
    const tar = path.join(path.dirname(stage), `${path.basename(stage)}.tar`);
    git(root, ["archive", "--format=tar", "-o", tar, opts.ref, "--", ...kept], { env: { GIT_LITERAL_PATHSPECS: "1" } });
    execFileSync("tar", ["-xf", tar, "-C", stage], { stdio: "pipe" });
    fs.rmSync(tar, { force: true });
  }

  // Overlay files replace whatever the export has at the same path.
  if (opts.worktree) {
    const overlay = path.join(root, "export/overlay");
    if (fs.existsSync(overlay)) copyTree(overlay, stage);
  } else {
    const hasOverlay = git(root, ["ls-tree", "-r", "--name-only", opts.ref, "--", "export/overlay"]).toString().trim();
    if (hasOverlay) {
      const tmp = `${stage}-overlay`;
      fs.mkdirSync(tmp, { recursive: true });
      const tar = `${stage}-overlay.tar`;
      git(root, ["archive", "--format=tar", "-o", tar, opts.ref, "export/overlay"]);
      execFileSync("tar", ["-xf", tar, "-C", tmp], { stdio: "pipe" });
      copyTree(path.join(tmp, "export/overlay"), stage);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(tar, { force: true });
    }
  }

  // The public .gitignore must keep local-only work out of future commits.
  const ignorePath = path.join(stage, ".gitignore");
  const current = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  if (!current.split(/\r?\n/).some((l) => l.trim() === "local/" || l.trim() === "/local/")) {
    fs.writeFileSync(ignorePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}local/\n`);
  }

  return { exported: countFiles(stage), excluded: listed.length - kept.length, deny, binaries };
}

function gitIdentity(root) {
  const read = (key) => {
    try { return git(root, ["config", key]).toString().trim(); } catch { return ""; }
  };
  const name = read("user.name");
  const email = read("user.email");
  if (!name || !email) throw new UsageError("the source repository has no git user.name and user.email configured");
  return {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email
  };
}

function isGitRepoRoot(dir) {
  try {
    const top = git(dir, ["rev-parse", "--show-toplevel"]).toString().trim();
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch { return false; }
}

function commitTree(out, message, identity, exported, excluded) {
  git(out, ["add", "-A"]);
  const dirty = git(out, ["status", "--porcelain"]).toString().trim();
  if (!dirty) {
    const head = git(out, ["rev-parse", "HEAD"], { env: identity }).toString().trim();
    console.log(`exported ${exported} files, excluded ${excluded}; no changes since ${head.slice(0, 12)}, no commit made`);
    return 0;
  }
  git(out, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message], { env: identity });
  const hash = git(out, ["rev-parse", "HEAD"]).toString().trim();
  console.log(`exported ${exported} files, excluded ${excluded}; commit ${hash} in ${out}`);
  return 0;
}

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  const root = sourceRoot(opts.source);

  const outReal = realpathOfExistingPart(opts.out);
  if (isInside(outReal, root)) throw new UsageError("--out must be outside the source repository");

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-export-"));
  const stageTree = path.join(stage, "tree");
  fs.mkdirSync(stageTree);
  try {
    // Fail on the destination before doing any work.
    const outExists = fs.existsSync(opts.out);
    let mode = "new";
    if (outExists) {
      if (!fs.statSync(opts.out).isDirectory()) throw new UsageError(`${opts.out} is not a directory`);
      const entries = fs.readdirSync(opts.out);
      if (entries.length) {
        if (!isGitRepoRoot(opts.out)) throw new UsageError(`${opts.out} is not empty and is not a git repository root`);
        if (git(opts.out, ["status", "--porcelain"]).toString().trim()) {
          throw new UsageError(`${opts.out} has uncommitted changes; commit or discard them first`);
        }
        mode = "update";
      }
    }
    const identity = gitIdentity(root);

    const { exported, excluded, deny, binaries } = buildTree(root, opts, stageTree);

    const { findings } = scanRoot(stageTree, { deny, useGit: false, binaries });
    if (findings.length) {
      for (const f of findings) console.log(formatFinding(f));
      console.error(`export-public: ${findings.length} finding${findings.length === 1 ? "" : "s"} (the tree would have ${exported} files, with ${excluded} excluded); nothing was written to ${opts.out} and nothing was committed`);
      return 1;
    }

    let version = "0.0.0";
    try { version = JSON.parse(fs.readFileSync(path.join(stageTree, "package.json"), "utf8")).version || version; } catch { /* keep default */ }
    const message = opts.message || `Ravnir ${version}`;

    fs.mkdirSync(opts.out, { recursive: true });
    if (mode === "new") {
      git(opts.out, ["init", "-q", "-b", "main"]);
      copyTree(stageTree, opts.out);
      return commitTree(opts.out, message, identity, exported, excluded);
    }

    // Stage the complete tree next to the clone, then replace the clone's content. The clone
    // was verified clean, so git can put it back if anything fails once deletion has started.
    const sibling = fs.mkdtempSync(path.join(path.dirname(opts.out), `.${path.basename(opts.out)}-ravnir-stage-`));
    try {
      copyTree(stageTree, sibling);
      try {
        const tracked = git(opts.out, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
        for (const file of tracked) {
          fs.rmSync(path.join(opts.out, file), { force: true });
          for (let dir = path.dirname(file); dir && dir !== "."; dir = path.dirname(dir)) {
            try { fs.rmdirSync(path.join(opts.out, dir)); } catch { break; }
          }
        }
        copyTree(sibling, opts.out);
        return commitTree(opts.out, message, identity, exported, excluded);
      } catch (err) {
        let restored = true;
        try {
          git(opts.out, ["reset", "-q"]);
          git(opts.out, ["checkout", "--", "."]);
          git(opts.out, ["clean", "-fd"]);
        } catch { restored = false; }
        console.error(`export-public: updating ${opts.out} failed (${String(err?.message || err).split("\n")[0]}); ${restored ? "the clone was restored to its last commit" : "restoring the clone ALSO failed, run git status there before doing anything else"}`);
        return 1;
      }
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`export-public: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const detail = err?.stderr ? `${err.message}\n${err.stderr.toString()}` : err?.stack || String(err);
    console.error(`export-public: ${detail}`);
    process.exitCode = 2;
  }
}
