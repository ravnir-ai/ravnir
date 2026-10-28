import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/export-public.mjs");

// Sample private strings are assembled at runtime so this file passes the repository scanner.
const privateTerm = ["acme", "widgets"].join("");
const privateMail = ["marta", "acme-corp.io"].join("@");

const tmpDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-export-test-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
}

function write(root, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

// A source repository with history, private files, an overlay and a deny list.
function makeSource(extra = {}) {
  const root = tmp("src");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test Author");
  git(root, "config", "user.email", "author@example.com");
  write(root, {
    "package.json": JSON.stringify({ name: "demo", version: "1.2.3" }),
    "README.md": "Original readme.\n",
    "CLAUDE.md": "private instructions\n",
    "AGENTS.md": "private guide\n",
    "server/app.js": "export const ok = true;\n",
    "video/clip.txt": "big private recording\n",
    "docs/soak-2026.md": "soak report\n",
    ".gitignore": "node_modules/\n",
    "export/exclude.txt": "# private\nCLAUDE.md\nAGENTS.md\nexport/\nvideo/\ndocs/soak-*.md\n",
    "export/deny.txt": `# never leaves the repo\n${privateTerm}\n`,
    "export/overlay/AGENTS.md": "Public guide.\n",
    "export/overlay/README.md": "Overlay readme wins.\n",
    ...extra
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  write(root, { "server/second.js": "export const two = 2;\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "second");
  return root;
}

function run(source, args) {
  const r = spawnSync(process.execPath, [script, "--source", source, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function files(root, dir = "") {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git") return [];
    const rel = dir ? `${dir}/${e.name}` : e.name;
    return e.isDirectory() ? files(root, rel) : [rel];
  }).sort();
}

test("a fresh export drops private files, applies the overlay and starts one commit", () => {
  const source = makeSource();
  const out = path.join(tmp("out"), "public");
  const r = run(source, ["--out", out]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.deepEqual(files(out), [".gitignore", "AGENTS.md", "README.md", "package.json", "server/app.js", "server/second.js"]);
  assert.equal(fs.readFileSync(path.join(out, "AGENTS.md"), "utf8"), "Public guide.\n");
  assert.equal(fs.readFileSync(path.join(out, "README.md"), "utf8"), "Overlay readme wins.\n");
  assert.ok(fs.readFileSync(path.join(out, ".gitignore"), "utf8").split("\n").includes("local/"));
  assert.ok(fs.readFileSync(path.join(out, ".gitignore"), "utf8").includes("node_modules/"));
  assert.equal(git(out, "rev-list", "--count", "HEAD"), "1");
  assert.equal(git(out, "log", "-1", "--format=%an <%ae>|%cn|%s"), "Test Author <author@example.com>|Test Author|Ravnir 1.2.3");
  assert.equal(git(out, "branch", "--show-current"), "main");
  assert.match(r.out, /exported 6 files, excluded 8/);
  assert.ok(r.out.includes(git(out, "rev-parse", "HEAD")));
});

test("a custom message is used and --ref exports that commit, not the latest", () => {
  const source = makeSource();
  const out = path.join(tmp("out"), "public");
  const r = run(source, ["--out", out, "--ref", "HEAD~1", "--message", "Import at first commit"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.ok(!fs.existsSync(path.join(out, "server/second.js")));
  assert.equal(git(out, "log", "-1", "--format=%s"), "Import at first commit");
});

test("--worktree exports uncommitted files and skips ignored ones", () => {
  const source = makeSource();
  write(source, { "server/new.js": "export const fresh = 1;\n", "node_modules/pkg/index.js": "x\n" });
  fs.rmSync(path.join(source, "server/second.js"));
  const out = path.join(tmp("out"), "public");
  const r = run(source, ["--out", out, "--worktree"]);
  assert.equal(r.status, 0, r.out + r.err);
  const list = files(out);
  assert.ok(list.includes("server/new.js"));
  assert.ok(!list.includes("server/second.js"), "a file deleted from the working tree is not exported");
  assert.ok(!list.some((f) => f.startsWith("node_modules/")));
  assert.ok(!list.includes("CLAUDE.md"));
  assert.equal(fs.readFileSync(path.join(out, "AGENTS.md"), "utf8"), "Public guide.\n");
  assert.equal(git(out, "rev-list", "--count", "HEAD"), "1");
});

test("a deny term in a kept file fails the export with no commit and nothing written", () => {
  const source = makeSource();
  write(source, { "docs/about.md": `Built by ${privateTerm.toUpperCase()}.\n` });
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "leak");
  const out = path.join(tmp("out"), "public");
  const r = run(source, ["--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.out, /^docs\/about\.md:1: deny: /m);
  assert.ok(!r.out.includes(privateTerm));
  assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0);
});

test("a generic finding (email) also stops the export, and excluded files are not scanned", () => {
  const source = makeSource({ "CLAUDE.md": `${privateTerm} ${privateMail}\n`, "video/note.txt": `${privateTerm}\n` });
  const ok = run(source, ["--out", path.join(tmp("out"), "ok")]);
  assert.equal(ok.status, 0, ok.out + ok.err);
  write(source, { "server/mail.js": `const to = "${privateMail}";\n` });
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "mail");
  const bad = run(source, ["--out", path.join(tmp("out"), "bad")]);
  assert.equal(bad.status, 1);
  assert.match(bad.out, /server\/mail\.js:1: email: /);
});

test("re-exporting into an existing clone adds a commit only when the content changed", () => {
  const source = makeSource();
  const out = path.join(tmp("out"), "public");
  assert.equal(run(source, ["--out", out]).status, 0);
  const first = git(out, "rev-parse", "HEAD");

  const same = run(source, ["--out", out]);
  assert.equal(same.status, 0, same.out + same.err);
  assert.match(same.out, /no commit made/);
  assert.equal(git(out, "rev-parse", "HEAD"), first);
  assert.equal(git(out, "rev-list", "--count", "HEAD"), "1");

  write(source, { "server/third.js": "export const three = 3;\n" });
  fs.rmSync(path.join(source, "server/second.js"));
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "third");
  const next = run(source, ["--out", out, "--message", "Ravnir 1.2.4"]);
  assert.equal(next.status, 0, next.out + next.err);
  assert.equal(git(out, "rev-list", "--count", "HEAD"), "2");
  assert.equal(git(out, "log", "-1", "--format=%s"), "Ravnir 1.2.4");
  assert.ok(fs.existsSync(path.join(out, "server/third.js")));
  assert.ok(!fs.existsSync(path.join(out, "server/second.js")), "files removed from the source disappear from the clone");
  assert.equal(git(out, "status", "--porcelain"), "");
});

test("refusals: output inside the source, dirty clone, non-empty plain folder, bad arguments", () => {
  const source = makeSource();
  assert.equal(run(source, ["--out", path.join(source, "public-copy")]).status, 2);
  assert.equal(run(source, []).status, 2);
  assert.equal(run(source, ["--out", path.join(tmp("out"), "x"), "--ref", "nope-ref"]).status, 2);
  assert.equal(run(source, ["--out", path.join(tmp("out"), "x"), "--worktree", "--ref", "HEAD"]).status, 2);

  const plain = tmp("plain");
  write(plain, { "keep.txt": "mine\n" });
  assert.equal(run(source, ["--out", plain]).status, 2);
  assert.equal(fs.readFileSync(path.join(plain, "keep.txt"), "utf8"), "mine\n");

  const out = path.join(tmp("out"), "public");
  assert.equal(run(source, ["--out", out]).status, 0);
  write(out, { "stray.txt": "uncommitted\n" });
  const dirty = run(source, ["--out", out]);
  assert.equal(dirty.status, 2);
  assert.match(dirty.err, /uncommitted changes/);
  assert.ok(fs.existsSync(path.join(out, "stray.txt")));
});

const sha = (data) => createHash("sha256").update(data).digest("hex");

test("binaries must be in the source manifest with a matching hash", () => {
  const png = Buffer.from([137, 80, 78, 71, 0, 1]);
  const source = makeSource();
  fs.mkdirSync(path.join(source, "public"));
  fs.writeFileSync(path.join(source, "public/logo.png"), png);
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "logo");

  const unlisted = run(source, ["--out", path.join(tmp("out"), "a")]);
  assert.equal(unlisted.status, 1);
  assert.match(unlisted.out, /^public\/logo\.png: binary-unreviewed: 6 bytes$/m);

  write(source, { "export/binaries.txt": `${sha("other")}  public/logo.png\n` });
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "wrong hash");
  const changed = run(source, ["--out", path.join(tmp("out"), "b")]);
  assert.equal(changed.status, 1);
  assert.match(changed.out, /^public\/logo\.png: binary-changed: 6 bytes$/m);

  write(source, { "export/binaries.txt": `${sha(png)}  public/logo.png\n` });
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "reviewed");
  const out = path.join(tmp("out"), "c");
  const ok = run(source, ["--out", out]);
  assert.equal(ok.status, 0, ok.out + ok.err);
  assert.ok(fs.readFileSync(path.join(out, "public/logo.png")).equals(png));
  assert.ok(!fs.existsSync(path.join(out, "export")));

  // The same rules apply to the working tree.
  fs.writeFileSync(path.join(source, "public/logo.png"), Buffer.from([1, 1, 0]));
  const wt = run(source, ["--out", path.join(tmp("out"), "d"), "--worktree"]);
  assert.equal(wt.status, 1);
  assert.match(wt.out, /binary-changed/);
});

test("a symlink in the kept tree blocks the export", () => {
  const source = makeSource();
  fs.symlinkSync("app.js", path.join(source, "server/alias.js"));
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "link");
  const out = path.join(tmp("out"), "public");
  const r = run(source, ["--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.out, /^server\/alias\.js: symlink: symbolic link$/m);
  assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0);
  const wt = run(source, ["--out", path.join(tmp("out"), "wt"), "--worktree"]);
  assert.equal(wt.status, 1);
  assert.match(wt.out, /symlink/);
});

test("a failing copy into an existing clone leaves it at its previous commit and clean", { skip: process.getuid?.() === 0 }, () => {
  const source = makeSource();
  const out = path.join(tmp("out"), "public");
  assert.equal(run(source, ["--out", out]).status, 0);
  const before = git(out, "rev-parse", "HEAD");
  write(source, { "server/third.js": "export const three = 3;\n", "README.md": "Changed readme.\n" });
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "third");

  const locked = path.join(out, "server");
  fs.chmodSync(locked, 0o555);
  try {
    const r = run(source, ["--out", out]);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.err, /restored to its last commit/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  assert.equal(git(out, "rev-parse", "HEAD"), before);
  assert.equal(git(out, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(out, "README.md"), "utf8"), "Overlay readme wins.\n");
  assert.ok(!fs.existsSync(path.join(out, "server/third.js")));
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((n) => n.includes("-ravnir-stage-")), [], "no staging folder is left behind");

  const retry = run(source, ["--out", out]);
  assert.equal(retry.status, 0, retry.out + retry.err);
  assert.equal(git(out, "rev-list", "--count", "HEAD"), "2");
});
