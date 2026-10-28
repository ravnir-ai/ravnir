import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compileExcludes, mask, parseBinaries, parseDeny, scanRoot, scanText } from "../scripts/check-public.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/check-public.mjs");

// Every sample private string is assembled at runtime so this file passes its own scanner.
const ip = ["45", "33", "32", "156"].join(".");
const home = ["", "Users", "marta"].join("/");
const linuxHome = ["", "home", "marta"].join("/");
const email = ["marta", "acme-corp.io"].join("@");
const tsHost = ["box", "mytailnet", "ts", "net"].join(".");
const keyHeader = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
const ghToken = ["ghp", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4"].join("_");
const patToken = ["github", "pat", "11ABCDEFG0123456789abcdefgh"].join("_");
const skToken = ["sk", "abcdefghijklmnopqrstuvwx"].join("-");
const slackToken = ["xox", "b-1234567890-abcdefghij"].join("");
const awsKey = ["AKI", "AABCDEFGHIJKLMNOP"].join("");
// The allow marker is assembled at runtime so this file does not carry one by accident.
const M = ["check-public", "allow"].join(": ");
const sha = (data) => createHash("sha256").update(data).digest("hex");

function rules(text, deny = null) {
  return scanText(text, deny).map((f) => f.rule);
}

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-check-public-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

function cli(args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("each generic rule catches its sample", () => {
  assert.deepEqual(rules(`host ${ip} open`), ["ipv4"]);
  assert.deepEqual(rules(`ssh ${tsHost}`), ["tailscale-host"]);
  assert.deepEqual(rules(`cd ${home}/Projects`), ["home-path"]);
  assert.deepEqual(rules(`cd ${linuxHome}/work`), ["home-path"]);
  assert.deepEqual(rules(`mail ${email}`), ["email"]);
  assert.deepEqual(rules(`      "deprecated": "Old version, contact ${email}",`), [], "npm deprecation notices in the lockfile");
  assert.deepEqual(rules(`      "note": "Old version, contact ${email}",`), ["email"]);
  assert.deepEqual(rules(keyHeader), ["private-key"]);
  for (const token of [ghToken, patToken, skToken, slackToken, awsKey]) {
    assert.deepEqual(rules(`key=${token}`), ["token"], token.slice(0, 4));
  }
});

test("placeholders and reserved values are allowed", () => {
  const ok = [
    "127.0.0.1 0.0.0.0 10.1.2.3 172.16.0.9 172.31.255.1 192.168.1.20 169.254.1.1 100.64.1.2 100.127.0.1",
    "192.0.2.7 198.51.100.7 203.0.113.7",
    "tailscale at hub.ts.net and ravnir.example.ts.net",
    "/Users/Shared/x /Users/you/x /home/user/x /home/runner/work /home/ubuntu /home/ravnir /home/node /Users/ada/a",
    "me@example.com a@example.org b@example.net c@users.noreply.github.com d@ravnir.local e@ravnir.dev f@localhost",
    "g@team.example h@northwind.test git@github.com:me/notes.git",
    "see https://user:secret@example.com/path and https://x-access-token:abc@github.com/o/r",
    "a short sk-token or sk-abc, ghp_short, xoxb-your-bot-token, AKIA123"
  ];
  for (const line of ok) assert.deepEqual(scanText(line), [], line);
});

test("version strings are not IP addresses", () => {
  for (const line of [
    "OpenCode 1.18.35", "remotion 4.0.534.1", "Chrome/124.0.0.0 Safari/537.36", "v1.2.3.4", "1.2.3.4.5",
    "node@22.23.4", "numbers 999.1.1.1 and 256.256.256.256"
  ]) {
    assert.deepEqual(scanText(line), [], line);
  }
  assert.deepEqual(rules(`reach ${ip}.`), ["ipv4"], "a trailing sentence period still counts");
});

test("a marker exempts only the rules it names", () => {
  assert.deepEqual(scanText(`${email} ${ip} # ${M} email,ipv4`), []);
  assert.deepEqual(rules(`${email} ${ip} # ${M} email`), ["ipv4"]);
  assert.deepEqual(rules(`${ghToken} ${email} // ${M} token`), ["email"]);
  assert.deepEqual(rules(`${email}\n${email} // ${M} email`), ["email"]);
  assert.deepEqual(rules(`${keyHeader} ${M} private-key (fake key)`), []);
});

test("a marker naming no rule or an unknown rule is a finding and exempts nothing", () => {
  assert.deepEqual(rules(`${email} # ${M}`).sort(), ["bad-allow", "email"]);
  assert.deepEqual(rules(`${email} # ${M} (because)`).sort(), ["bad-allow", "email"]);
  assert.deepEqual(rules(`${email} # ${M} emails`).sort(), ["bad-allow", "email"]);
  assert.deepEqual(rules(`${email} # ${M} email,nonsense`).sort(), ["bad-allow", "email"]);
  assert.deepEqual(rules(`x # ${M} deny`), ["bad-allow"]);
});

test("deny terms cannot be exempted by a marker", () => {
  const deny = parseDeny("acmewidgets\n");
  const re = new RegExp("acmewidgets", "gi");
  assert.deepEqual(rules(`acmewidgets # ${M} token`, re), ["deny"]);
  assert.deepEqual(rules(`acmewidgets # ${M} deny`, re).sort(), ["bad-allow", "deny"]);
  assert.deepEqual(rules(`acmewidgets # ${M}`, re).sort(), ["bad-allow", "deny"]);
  assert.deepEqual(deny, ["acmewidgets"]);
});

test("findings mask the middle of the match", () => {
  const [f] = scanText(`token ${ghToken}`);
  assert.equal(f.excerpt, mask(ghToken));
  assert.ok(!f.excerpt.includes(ghToken.slice(6, -4)));
  assert.equal(f.line, 1);
  assert.equal(mask("abc"), "a***");
});

test("deny terms match whole words, case-insensitively, including odd characters", () => {
  const deny = parseDeny([
    "# comment line", "", "acmewidgets", "fox hollow", "ops-box.internal", "ci-bot@", ip
  ].join("\n"));
  assert.deepEqual(deny, ["acmewidgets", "fox hollow", "ops-box.internal", "ci-bot@", ip]);
  const dir = fixture({
    "export/deny.txt": "acmewidgets\nfox hollow\nops-box.internal\nci-bot@\n",
    "a.md": "Built by AcmeWidgets in Fox   Hollow, on ops-box.internal, mail ci-bot@example.com",
    "b.md": "acmewidgetsfoo and fooacmewidgets are different words, so are ops-box.internalx and fox hollowing"
  });
  try {
    const { findings } = scanRoot(dir, { deny });
    const byFile = findings.filter((f) => f.path === "a.md");
    assert.equal(byFile.length, 4);
    assert.ok(byFile.every((f) => f.rule === "deny"));
    assert.equal(findings.filter((f) => f.path === "b.md").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exclude rules match exact paths, directories and globs", () => {
  const excluded = compileExcludes([
    "# comment", "CLAUDE.md", "video/", "docs/soak-*.md", "local/", "tmp/*.log", "dir/**/secret.txt"
  ].join("\n"));
  for (const p of ["CLAUDE.md", "video/a/b.mp4", "video", "docs/soak-2026-10-25.md", "local/x.js", "tmp/run.log", "dir/a/b/secret.txt"]) {
    assert.ok(excluded(p), p);
  }
  for (const p of ["docs/CLAUDE.md", "videos/a.mp4", "docs/soak.md", "docs/soak-x/y.txt.bak", "tmp/a/run.log", "locally.js", "dir/secret.txt"]) {
    assert.ok(!excluded(p), p);
  }
});

test("command line: exit codes, exclude and deny files, binary and node_modules skipped", () => {
  const dir = fixture({
    "README.md": "nothing private here\n",
    "src/leak.js": `const mail = "${email}";\n`,
    "node_modules/pkg/index.js": `${email}\n`,
    "skipped/leak.txt": `${ip}\n`,
    "export/exclude.txt": "skipped/\nexport/\n",
    "export/deny.txt": "acmewidgets\n",
    "notes.md": "Thanks, AcmeWidgets.\n"
  });
  fs.writeFileSync(path.join(dir, "blob.dat"), Buffer.concat([Buffer.from(`${email}\n`), Buffer.from([0, 1, 2])]));
  fs.writeFileSync(path.join(dir, "pic.png"), `${email}\n`);
  try {
    const r = cli(["--root", dir]);
    assert.equal(r.status, 1);
    const lines = r.out.trim().split("\n").sort();
    assert.equal(lines.length, 2, r.out);
    assert.match(lines[0], /^notes\.md:1: deny: /);
    assert.match(lines[1], /^src\/leak\.js:1: email: /);
    assert.ok(!r.out.includes(email));

    const json = cli(["--root", dir, "--json"]);
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.count, 2);
    assert.deepEqual(parsed.findings.map((f) => f.path).sort(), ["notes.md", "src/leak.js"]);

    fs.rmSync(path.join(dir, "src"), { recursive: true });
    fs.rmSync(path.join(dir, "notes.md"));
    const clean = cli(["--root", dir]);
    assert.equal(clean.status, 0, clean.out + clean.err);
    assert.match(clean.out, /clean/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("command line: usage errors exit 2", () => {
  assert.equal(cli(["--nope"]).status, 2);
  assert.equal(cli(["--root"]).status, 2);
  assert.equal(cli(["--root", path.join(os.tmpdir(), "ravnir-does-not-exist-xyz")]).status, 2);
});

test("in a git repository the file set is tracked plus untracked files that are not ignored", () => {
  const dir = fixture({
    ".gitignore": "ignored.txt\n",
    "tracked.txt": "fine\n",
    "untracked.txt": `${email}\n`,
    "ignored.txt": `${email}\n`
  });
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "tracked.txt", ".gitignore");
    const r = cli(["--root", dir]);
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.trim().split("\n").map((l) => l.split(":")[0]), ["untracked.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("text files of any size are scanned", () => {
  const dir = fixture({ "ok.txt": "fine\n" });
  try {
    const filler = "x".repeat(1023) + "\n";
    fs.writeFileSync(path.join(dir, "big.log"), filler.repeat(6 * 1024) + `${email}\n`);
    assert.ok(fs.statSync(path.join(dir, "big.log")).size > 5 * 1024 * 1024);
    const { findings } = scanRoot(dir, { useGit: false });
    assert.deepEqual(findings.map((f) => `${f.path}:${f.line}:${f.rule}`), [`big.log:${6 * 1024 + 1}:email`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("binary manifest: listed passes, unlisted and changed fail, no manifest means unchecked", () => {
  const good = Buffer.from([0, 1, 2, 3]);
  const dir = fixture({ "readme.md": "hi\n" });
  fs.writeFileSync(path.join(dir, "good.png"), good);
  fs.writeFileSync(path.join(dir, "new.png"), Buffer.from([9, 9]));
  fs.writeFileSync(path.join(dir, "edited.dat"), Buffer.from([5, 0, 5]));
  try {
    const none = scanRoot(dir, { useGit: false, binaries: null });
    assert.deepEqual(none.findings, []);
    assert.equal(none.binaries.length, 3);

    const manifest = parseBinaries([
      "# reviewed", `${sha(good)}  good.png`, `${sha("something else")} *edited.dat`
    ].join("\n"));
    const { findings } = scanRoot(dir, { useGit: false, binaries: manifest });
    assert.deepEqual(findings.map((f) => `${f.path} ${f.rule} ${f.excerpt}`).sort(), [
      "edited.dat binary-changed 3 bytes", "new.png binary-unreviewed 2 bytes"
    ]);
    assert.throws(() => parseBinaries("not a hash  file.png"), /sha256sum format/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("command line: manifest present checks binaries; --list-binaries and --accept-binaries", () => {
  const png = Buffer.from([137, 80, 78, 71, 0, 1]);
  const dir = fixture({ "readme.md": "hi\n", "export/binaries.txt": "# my header\n" });
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets/logo.png"), png);
  fs.writeFileSync(path.join(dir, "a.db"), Buffer.from([1, 2, 3]));
  try {
    const bad = cli(["--root", dir]);
    assert.equal(bad.status, 1);
    assert.match(bad.out, /^a\.db: binary-unreviewed: 3 bytes$/m);
    assert.match(bad.out, /^assets\/logo\.png: binary-unreviewed: 6 bytes$/m);

    const listed = cli(["--root", dir, "--list-binaries"]);
    assert.equal(listed.status, 0);
    assert.ok(listed.out.includes(`assets/logo.png\t6 bytes\t${sha(png)}`));
    assert.ok(!fs.readFileSync(path.join(dir, "export/binaries.txt"), "utf8").includes(sha(png)), "list does not write");

    const accepted = cli(["--root", dir, "--accept-binaries"]);
    assert.equal(accepted.status, 0, accepted.err);
    assert.match(accepted.err, /WARNING/);
    const file = fs.readFileSync(path.join(dir, "export/binaries.txt"), "utf8");
    assert.equal(file, `# my header\n${sha(Buffer.from([1, 2, 3]))}  a.db\n${sha(png)}  assets/logo.png\n`);
    assert.equal(cli(["--root", dir]).status, 0);

    fs.writeFileSync(path.join(dir, "assets/logo.png"), Buffer.from([0, 0, 7]));
    const changed = cli(["--root", dir]);
    assert.equal(changed.status, 1);
    assert.match(changed.out, /assets\/logo\.png: binary-changed/);
    assert.equal(cli(["--root", dir, "--accept-binaries"]).status, 0);
    const updated = fs.readFileSync(path.join(dir, "export/binaries.txt"), "utf8");
    assert.ok(updated.includes(`${sha(Buffer.from([0, 0, 7]))}  assets/logo.png`));
    assert.ok(!updated.includes(sha(png)));
    assert.equal(cli(["--root", dir]).status, 0);
    assert.equal(cli(["--root", dir, "--list-binaries", "--accept-binaries"]).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without export/binaries.txt binaries are not checked", () => {
  const dir = fixture({ "readme.md": "hi\n" });
  fs.writeFileSync(path.join(dir, "x.png"), Buffer.from([1, 0]));
  try {
    assert.equal(cli(["--root", dir]).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink in the kept file set is a finding, in a plain folder and in git", () => {
  const dir = fixture({ "real.txt": "fine\n", "export/exclude.txt": "skipped/\n" });
  fs.mkdirSync(path.join(dir, "skipped"));
  fs.symlinkSync("real.txt", path.join(dir, "link.txt"));
  fs.symlinkSync("real.txt", path.join(dir, "skipped/link.txt"));
  try {
    const r = cli(["--root", dir]);
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.trim().split("\n"), ["link.txt: symlink: symbolic link"]);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
    assert.match(cli(["--root", dir]).out, /^link\.txt: symlink:/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
