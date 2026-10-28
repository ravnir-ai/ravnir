import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Vault } from "../server/vault/index.js";
import { ensureClone, pull } from "../server/vault/sync.js";
import { loadEmbedder } from "../server/vault/embed.js";

const FILES = {
  "Home.md": "# Home\n\nWelcome. See [[Rules]], [[Agents/Chief-of-Staff]] and [[LP]].\n",
  "Rules.md": "---\ntitle: Rules\n---\n# Rules\n\nAlways answer in the language of the user. Never invent numbers.\n",
  "Agents/Chief-of-Staff.md":
    "# Chief of Staff\n\nCoordinates the team. Watches [[Launch]] and [[Acme|the clipping business]].\n\n## Routines\n\nMorning report every day.\n",
  "Agents/ECHO.md": "# ECHO\n\nResearch assistant for hard questions.\n",
  "Projects/Launch.md":
    "---\naliases: [Launch Pad, LP]\n---\n# Launch\n\nShort-form video account growth.\n\n## Estado actual\n\nLa cuenta tiene 12400 seguidores y crece 3% por semana. Campaña de octubre en marcha.\n\n## Historial\n\nLanzamiento en marzo.\n",
  "Projects/Acme.md": "# Acme\n\nClipping business. Plan de campana de verano.\n",
  "Projects/Alpha.md": "# Alpha\n\nThe followers count rose this week.\n",
  "Decisions/2026-10-20-x.md": "# Decision X\n\nWe decided to pause ads. Context in [[Launch#Estado actual]] and [[Missing Note]].\n",
  "assets/pic.png": "not markdown",
  "notes.txt": "plain text with cuenta",
  ".obsidian/app.md": "hidden cuenta secreto",
};

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-${name}-`));
}

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

async function open(files = FILES, options = {}) {
  const dir = tmp("vault");
  write(dir, files);
  const vault = new Vault({ dir, watch: false, pullMs: 0, ...options });
  await vault.open();
  return { dir, vault };
}

function git(dir, args, env = {}) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

test("indexes only markdown outside dot folders and ranks the title match first", async () => {
  const { vault } = await open();
  try {
    const status = vault.status();
    assert.equal(status.available, true);
    assert.equal(status.notes, 8);
    const hits = await vault.search("¿Cómo va la cuenta de Launch?");
    assert.equal(hits[0].path, "Projects/Launch.md");
    assert.ok(!hits.some((h) => h.path.startsWith(".obsidian") || h.path.endsWith(".txt")));
    assert.ok(hits[0].snippet.length <= 400);
    assert.deepEqual(await vault.search("la de el que"), []);
  } finally {
    vault.close();
  }
});

test("folds accents both ways and matches prefixes", async () => {
  const { vault } = await open();
  try {
    for (const q of ["campaña", "campana"]) {
      const paths = (await vault.search(q)).map((h) => h.path);
      assert.ok(paths.includes("Projects/Launch.md"), q);
      assert.ok(paths.includes("Projects/Acme.md"), q);
    }
    const prefix = await vault.search("seguid");
    assert.equal(prefix[0].path, "Projects/Launch.md");
  } finally {
    vault.close();
  }
});

test("resolves label, heading and alias links, keeps unresolved ones, lists backlinks", async () => {
  const { vault } = await open();
  try {
    const chief = vault.links("Agents/Chief-of-Staff.md");
    assert.deepEqual(chief.links, ["Projects/Launch.md", "Projects/Acme.md"]);
    const decision = vault.links("Decisions/2026-10-20-x.md");
    assert.deepEqual(decision.links, ["Projects/Launch.md"]);
    assert.deepEqual(decision.unresolved, ["Missing Note"]);
    assert.ok(vault.links("Home.md").links.includes("Projects/Launch.md"), "alias LP");
    const hot = vault.links("Projects/Launch.md");
    assert.ok(hot.backlinks.includes("Agents/Chief-of-Staff.md"));
    assert.ok(hot.backlinks.includes("Decisions/2026-10-20-x.md"));
    assert.equal(vault.read("[[Launch]]").path, "Projects/Launch.md");
    assert.equal(vault.resolve("Projects/Launch"), "Projects/Launch.md");
    assert.equal(vault.resolve("launch pad"), "Projects/Launch.md");
    assert.equal(vault.resolve("nothing-here"), null);
    assert.match(vault.section("Launch", /^estado actual$/i), /12400 seguidores/);
    assert.equal(vault.section("Launch", /^nope$/), "");
  } finally {
    vault.close();
  }
});

test("adds linked notes to search results", async () => {
  const { vault } = await open();
  try {
    const hits = await vault.search("coordinates team");
    assert.equal(hits[0].path, "Agents/Chief-of-Staff.md");
    const linked = hits.filter((h) => h.via === "link").map((h) => h.path);
    assert.ok(linked.includes("Projects/Launch.md"));
    assert.ok(hits.find((h) => h.via === "link").score < hits[0].score);
  } finally {
    vault.close();
  }
});

test("rejects traversal, absolute paths and symlinks that leave the vault", async () => {
  const outside = tmp("outside");
  fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n\ntop secret cuenta\n");
  const { dir, vault } = await open();
  try {
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "evil.md"));
    fs.symlinkSync(outside, path.join(dir, "linked"));
    await vault.reindex();
    for (const name of ["../etc/passwd", "/etc/passwd", "evil", "evil.md", "linked/secret.md", "..", path.join(outside, "secret.md")]) {
      assert.equal(vault.resolve(name), null, name);
      assert.equal(vault.read(name), null, name);
    }
    assert.ok(!(await vault.search("secret")).some((h) => h.path.includes("evil") || h.path.includes("linked")));
  } finally {
    vault.close();
  }
});

test("reindex only touches changed files and the watcher reports changes", async () => {
  const changes = [];
  const { dir, vault } = await open(FILES, { watch: true, onChange: (r) => changes.push(r) });
  try {
    assert.deepEqual(await vault.reindex(), { changed: 0, removed: 0 });
    fs.appendFileSync(path.join(dir, "Projects/Acme.md"), "\nNueva zanahoria morada.\n");
    assert.deepEqual(await vault.reindex(), { changed: 1, removed: 0 });
    assert.equal((await vault.search("zanahoria"))[0].path, "Projects/Acme.md");
    fs.rmSync(path.join(dir, "Projects/Alpha.md"));
    assert.deepEqual(await vault.reindex(), { changed: 0, removed: 1 });
    assert.ok(!(await vault.search("followers")).some((h) => h.path === "Projects/Alpha.md"));
    assert.equal(vault.resolve("Alpha"), null);

    changes.length = 0;
    fs.writeFileSync(path.join(dir, "Projects/Watched.md"), "# Watched\n\nPalabra rarisima ornitorrinco.\n");
    const deadline = Date.now() + 5000;
    while (!changes.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(changes.length, "onChange fired within 5s");
    assert.equal((await vault.search("ornitorrinco"))[0].path, "Projects/Watched.md");
  } finally {
    vault.close();
  }
});

test("finds the note for a bot by name, suffix, override and projects", async () => {
  const { vault } = await open();
  try {
    assert.equal(vault.noteForBot({ name: "Chief of Staff" }), "Agents/Chief-of-Staff.md");
    assert.equal(vault.noteForBot({ name: "Echo" }), "Agents/ECHO.md");
    assert.equal(vault.noteForBot({ name: "Whatever", vaultNote: "Projects/Acme" }), "Projects/Acme.md");
    assert.equal(vault.noteForBot({ name: "Unknown" }), null);
    assert.deepEqual(vault.projectsForBot({ name: "Chief of Staff" }, "Agents/Chief-of-Staff.md"), ["Projects/Launch.md", "Projects/Acme.md"]);
    assert.deepEqual(vault.projectsForBot({ name: "X", vaultProjects: ["Alpha", "Launch"] }), ["Projects/Alpha.md", "Projects/Launch.md"]);
    assert.deepEqual(vault.projectsForBot({ name: "Launch" }), ["Projects/Launch.md"]);
  } finally {
    vault.close();
  }
});

test("builds bot context with rules, projects, sources and trimming order", async () => {
  const { vault } = await open();
  try {
    const hot = await vault.contextForBot({ name: "Launch" }, "cuenta seguidores");
    const chief = await vault.contextForBot({ name: "Chief of Staff" }, "cuenta seguidores");
    for (const ctx of [hot, chief]) {
      assert.match(ctx.text, /Rules\.md \(updated \d{4}-\d\d-\d\d\):/);
      assert.match(ctx.text, /Never invent numbers/);
      assert.match(ctx.text, /### Projects\/Launch\.md \(updated \d{4}-\d\d-\d\d\)/);
      assert.match(ctx.text, /12400 seguidores/);
    }
    assert.match(hot.text, /You have no note in Agents\/ yet\./);
    assert.match(chief.text, /Your note Agents\/Chief-of-Staff\.md/);
    const hash = (ctx) => ctx.sources.find((s) => s.path === "Projects/Launch.md").hash;
    assert.equal(hash(hot), hash(chief));
    assert.match(hash(hot), /^[0-9a-f]{40}$/);
    assert.ok(chief.sources.every((s) => s.path && s.date && s.hash));

    const full = await vault.contextForBot({ name: "Launch" }, "campana", { maxChars: 100000 });
    assert.match(full.text, /Relevant notes for this message:/);
    assert.match(full.text, /Other project notes: /);
    const a = await vault.contextForBot({ name: "Launch" }, "campana", { maxChars: full.text.length - 1 });
    assert.ok(a.text.length < full.text.length);
    assert.match(a.text, /Other project notes/);
    assert.match(a.text, /Your projects/);
    const noRelevant = full.text.slice(0, full.text.indexOf("Relevant notes for this message:")).trimEnd();
    const b = await vault.contextForBot({ name: "Launch" }, "campana", { maxChars: noRelevant.length - 1 });
    assert.doesNotMatch(b.text, /Relevant notes/);
    assert.match(b.text, /Your projects/);
    const tiny = await vault.contextForBot({ name: "Launch" }, "campana", { maxChars: 220 });
    assert.ok(tiny.text.length <= 220);
    assert.match(tiny.text, /Rules\.md/);
    assert.doesNotMatch(tiny.text, /Your projects|Relevant notes|Other project/);
    assert.deepEqual(tiny.sources.map((s) => s.path), ["Rules.md"]);
  } finally {
    vault.close();
  }
});

test("dates come from git commits, with mtime outside git", async () => {
  const dir = tmp("git");
  write(dir, { "A.md": "# A\n\nfirst\n", "B.md": "# B\n\nsecond\n" });
  const when = "2025-03-04T10:00:00Z";
  const env = { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  git(dir, ["init", "-q"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"], env);
  const vault = new Vault({ dir, watch: false, pullMs: 0 });
  try {
    await vault.open();
    assert.equal(new Date(vault.read("A").date).getTime(), Date.parse(when));
    assert.match(vault.status().head, /^[0-9a-f]{40}$/);
    const later = "2025-06-01T08:30:00Z";
    fs.writeFileSync(path.join(dir, "B.md"), "# B\n\nsecond changed\n");
    git(dir, ["commit", "-q", "-am", "edit"], { GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later });
    await vault.reindex();
    assert.equal(new Date(vault.read("B").date).getTime(), Date.parse(later));
    assert.equal(new Date(vault.read("A").date).getTime(), Date.parse(when));
  } finally {
    vault.close();
  }
  const plain = await open({ "C.md": "# C\n\nplain\n" });
  try {
    assert.ok(Math.abs(Date.parse(plain.vault.read("C").date) - Date.now()) < 60000);
  } finally {
    plain.vault.close();
  }
});

test("clones a remote, pulls fast-forwards and reindexes", async () => {
  const root = tmp("sync");
  const remote = path.join(root, "remote.git");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "main"]);
  write(seed, { "Projects/One.md": "# One\n\nPrimera nota.\n" });
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "one"]);
  git(seed, ["push", "-q", remote, "main"]);

  const dir = path.join(root, "vault");
  const vault = new Vault({ dir, remote, watch: false, pullMs: 0 });
  try {
    await vault.open();
    assert.equal(vault.available, true);
    assert.equal(vault.status().notes, 1);
    assert.deepEqual(await vault.pull(), { updated: false, error: null });

    write(seed, { "Projects/Two.md": "# Two\n\nSegunda nota sobre axolotes.\n" });
    git(seed, ["add", "."]);
    git(seed, ["commit", "-q", "-m", "two"]);
    git(seed, ["push", "-q", remote, "main"]);

    const result = await vault.pull();
    assert.equal(result.updated, true);
    assert.equal(result.error, null);
    assert.equal((await vault.search("axolotes"))[0].path, "Projects/Two.md");
    assert.ok(vault.status().lastPullAt);

    assert.deepEqual(await ensureClone({ remote, dir }), { cloned: false, error: null });
    const bad = await pull({ dir: path.join(root, "missing") });
    assert.equal(bad.updated, false);
    assert.ok(bad.error);
  } finally {
    vault.close();
  }
});

test("a missing folder reports unavailable and the loader degrades without the package", async () => {
  const vault = new Vault({ dir: path.join(tmp("none"), "nope"), watch: false, pullMs: 0 });
  await vault.open();
  assert.equal(vault.available, false);
  assert.equal(vault.status().lastError, "vault folder not found");
  assert.deepEqual(await vault.search("anything"), []);
  vault.close();
  const missing = await loadEmbedder({ dir: "" });
  assert.equal(missing.embedder, null);
  assert.ok(missing.reason);
  assert.equal((await loadEmbedder({ dir: tmp("noembed") })).embedder, null);
});

test("hybrid search finds notes that only match semantically", async () => {
  const embedder = {
    dim: 3,
    calls: [],
    async embed(texts, kind) {
      this.calls.push({ n: texts.length, kind });
      return texts.map((t) => {
        const s = t.toLowerCase();
        return Float32Array.from([/cuenta|followers/.test(s) ? 1 : 0, /campana|campaña/.test(s) ? 1 : 0, 0.001]);
      });
    },
  };
  const { vault } = await open(FILES, { embedder });
  try {
    assert.equal(vault.status().embed, true);
    assert.ok(embedder.calls.some((c) => c.kind === "passage" && c.n <= 16));
    const hits = await vault.search("cuenta");
    assert.ok(embedder.calls.some((c) => c.kind === "query"));
    const alpha = hits.find((h) => h.path === "Projects/Alpha.md");
    assert.ok(alpha, "Alpha found through vectors");
    assert.ok(["vector", "hybrid"].includes(alpha.via));
    const hot = hits.find((h) => h.path === "Projects/Launch.md");
    assert.equal(hot.via, "hybrid");
  } finally {
    vault.close();
  }
});
