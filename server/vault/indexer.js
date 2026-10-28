import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { noteSlug } from "./slug.js";

// Parses a folder of Markdown into notes, chunks and links inside SQLite.
// Read-only toward the vault: it only ever reads files and runs git log.

const run = promisify(execFile);
const CHUNK_MAX = 1200;
const EMBED_BATCH = 16;
const EMBED_TEXT_MAX = 1500;
const SKIP_DIRS = new Set(["node_modules", "bin"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, title TEXT, aliases TEXT, hash TEXT, mtime INTEGER, date TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT, ord INTEGER, heading TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path UNINDEXED, title, heading, text, tokenize="unicode61 remove_diacritics 2");
CREATE TABLE IF NOT EXISTS links(src TEXT, dst TEXT, raw TEXT);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE TABLE IF NOT EXISTS vectors(chunk_id INTEGER PRIMARY KEY, vec BLOB);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

export function stripFrontmatter(raw) {
  return splitFrontmatter(raw).body;
}

function unquote(value) {
  return String(value || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

function splitFrontmatter(raw) {
  const text = String(raw || "");
  const match = text.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { data: {}, body: text };
  const data = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "title") data.title = unquote(value);
    if (key === "aliases" || key === "alias") {
      const list = [];
      if (value.startsWith("[")) {
        for (const part of value.replace(/^\[|\]$/g, "").split(",")) if (unquote(part)) list.push(unquote(part));
      } else if (value) {
        list.push(unquote(value));
      } else {
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) list.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      }
      data.aliases = [...(data.aliases || []), ...list];
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function splitLong(text) {
  if (text.length <= CHUNK_MAX) return [text];
  const parts = [];
  let current = "";
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (let para of text.split(/\n\s*\n/)) {
    while (para.length > CHUNK_MAX) {
      let cut = para.lastIndexOf(" ", CHUNK_MAX);
      if (cut < CHUNK_MAX / 2) cut = CHUNK_MAX;
      push();
      parts.push(para.slice(0, cut).trim());
      para = para.slice(cut);
    }
    if (current && current.length + para.length + 2 > CHUNK_MAX) push();
    current = current ? `${current}\n\n${para}` : para;
  }
  push();
  return parts;
}

export function chunkBody(body) {
  const sections = [{ heading: "", lines: [] }];
  let fence = false;
  for (const line of String(body).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (m) sections.push({ heading: m[2], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  const chunks = [];
  sections.forEach((section, index) => {
    const text = section.lines.join("\n").trim();
    if (index > 0 && !text) return;
    for (const piece of text ? splitLong(text) : [""]) chunks.push({ ord: chunks.length, heading: section.heading, text: piece });
  });
  return chunks;
}

export function extractLinks(body, rel) {
  const found = new Set();
  for (const m of body.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[2].split("|")[0].split("#")[0].trim();
    if (!target) continue;
    if (m[1] && !/\.md$/i.test(target) && /\.[A-Za-z0-9]{1,5}$/.test(target)) continue;
    found.add(target);
  }
  for (const m of body.matchAll(/\[[^\]\n]*\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)/gi)) {
    let target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // keep the raw text
    }
    const joined = target.startsWith("/") ? target.slice(1) : path.posix.join(path.posix.dirname(rel), target);
    const normal = path.posix.normalize(joined);
    if (normal.startsWith("..")) continue;
    found.add(normal);
  }
  return [...found];
}

export function parseNote(raw, rel) {
  const { data, body } = splitFrontmatter(raw);
  const base = path.posix.basename(rel, ".md");
  const heading = body.match(/^# +(.+?)\s*#*\s*$/m);
  return {
    path: rel,
    title: (data.title || (heading && heading[1]) || base).trim(),
    aliases: data.aliases || [],
    chunks: chunkBody(body),
    links: extractLinks(body, rel),
  };
}

export function buildResolver(rows) {
  const paths = rows.map((row) => row.path);
  const exact = new Set(paths);
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const byBase = new Map();
  const byAlias = new Map();
  const bySlug = new Map();
  const bySlugBase = new Map();
  const shortest = (list) => [...list].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  for (const row of rows) {
    const base = path.posix.basename(row.path, ".md").toLowerCase();
    byBase.set(base, [...(byBase.get(base) || []), row.path]);
    const slug = noteSlug(row.path);
    bySlug.set(slug, [...(bySlug.get(slug) || []), row.path]);
    const slugBase = noteSlug(path.posix.basename(row.path));
    bySlugBase.set(slugBase, [...(bySlugBase.get(slugBase) || []), row.path]);
    for (const alias of row.aliases || []) {
      const key = String(alias).trim().toLowerCase();
      if (key) byAlias.set(key, [...(byAlias.get(key) || []), row.path]);
    }
  }
  return (name) => {
    let s = String(name ?? "").trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0].split("#")[0].trim();
    if (!s || s.includes("\0") || s.includes("\\") || s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
    s = s.replace(/^(\.\/)+/, "");
    if (s.split("/").includes("..")) return null;
    const key = s.replace(/\.md$/i, "");
    if (exact.has(s)) return s;
    if (exact.has(`${key}.md`)) return `${key}.md`;
    const ci = lower.get(`${key}.md`.toLowerCase());
    if (ci) return ci;
    const lowKey = key.toLowerCase();
    if (key.includes("/")) {
      const hits = paths.filter((p) => p.toLowerCase().endsWith(`/${lowKey}.md`));
      if (hits.length) return shortest(hits);
    }
    const base = lowKey.split("/").pop();
    if (byBase.has(base)) return shortest(byBase.get(base));
    if (byAlias.has(lowKey)) return shortest(byAlias.get(lowKey));
    const slug = noteSlug(key);
    if (bySlug.has(slug)) return shortest(bySlug.get(slug));
    const slugBase = noteSlug(base);
    if (bySlugBase.has(slugBase)) return shortest(bySlugBase.get(slugBase));
    return null;
  };
}

export function walk(dir) {
  const files = [];
  const visit = (abs, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(abs, entry.name), childRel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        try {
          const stat = fs.statSync(path.join(abs, entry.name));
          files.push({ rel: childRel, abs: path.join(abs, entry.name), mtime: Math.floor(stat.mtimeMs), size: stat.size });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  visit(dir, "");
  return files;
}

async function gitHead(dir) {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 15000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function gitDates(dir) {
  const map = new Map();
  try {
    const { stdout } = await run(
      "git",
      ["-C", dir, "-c", "core.quotepath=false", "log", "--name-only", "--relative", "--format=%x00%cI"],
      { timeout: 120000, maxBuffer: 256 * 1024 * 1024 },
    );
    for (const segment of stdout.split("\0")) {
      const lines = segment.split("\n");
      const date = lines[0].trim();
      if (!date) continue;
      for (const file of lines.slice(1)) if (file && !map.has(file)) map.set(file, date);
    }
  } catch {
    // dates fall back to file mtime
  }
  return map;
}

function toBlob(vector) {
  const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function fromBlob(blob) {
  return new Float32Array(new Uint8Array(blob).buffer);
}

export class VaultIndex {
  #dateHead = "";
  #dateMap = new Map();
  #resolver = null;

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.head = "";
  }

  close() {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  meta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  #setMeta(key, value) {
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, String(value));
  }

  counts() {
    return {
      notes: this.db.prepare("SELECT count(*) AS n FROM notes").get().n,
      chunks: this.db.prepare("SELECT count(*) AS n FROM chunks").get().n,
    };
  }

  notes(prefix = "") {
    const rows = this.db.prepare("SELECT path, title, aliases, hash, date FROM notes ORDER BY path").all();
    return rows
      .filter((row) => row.path.startsWith(prefix))
      .map((row) => ({ ...row, aliases: JSON.parse(row.aliases || "[]") }));
  }

  note(notePath) {
    return this.db.prepare("SELECT path, title, hash, date FROM notes WHERE path = ?").get(notePath) || null;
  }

  resolveName(name) {
    if (!this.#resolver) this.#resolver = buildResolver(this.notes());
    return this.#resolver(name);
  }

  outgoing(notePath) {
    return this.db.prepare("SELECT dst FROM links WHERE src = ? AND dst IS NOT NULL AND dst <> src GROUP BY dst ORDER BY min(rowid)").all(notePath).map((r) => r.dst);
  }

  backlinks(notePath) {
    return this.db.prepare("SELECT DISTINCT src FROM links WHERE dst = ? AND src <> dst ORDER BY src").all(notePath).map((r) => r.src);
  }

  unresolved(notePath) {
    return this.db.prepare("SELECT DISTINCT raw FROM links WHERE src = ? AND dst IS NULL ORDER BY raw").all(notePath).map((r) => r.raw);
  }

  async reindex(dir, { embedder = null, isClosed = () => false } = {}) {
    const files = walk(dir);
    const head = await gitHead(dir);
    let refresh = false;
    if (head !== this.#dateHead) {
      this.#dateMap = head ? await gitDates(dir) : new Map();
      this.#dateHead = head;
      refresh = true;
    }
    if (isClosed()) return { changed: 0, removed: 0 };
    this.head = head;

    const existing = new Map(this.db.prepare("SELECT path, hash FROM notes").all().map((r) => [r.path, r.hash]));
    const seen = new Set();
    const changed = [];
    const unchanged = [];
    for (const file of files) {
      let buffer;
      try {
        buffer = fs.readFileSync(file.abs);
      } catch {
        continue;
      }
      seen.add(file.rel);
      const hash = crypto.createHash("sha1").update(buffer).digest("hex");
      if (existing.get(file.rel) === hash) unchanged.push(file);
      else changed.push({ file, hash, parsed: parseNote(buffer.toString("utf8"), file.rel) });
    }
    const removed = [...existing.keys()].filter((p) => !seen.has(p));
    const dateOf = (file) => this.#dateMap.get(file.rel) || new Date(file.mtime).toISOString();

    this.db.exec("BEGIN");
    try {
      for (const p of removed) this.#deleteNote(p);
      for (const { file, hash, parsed } of changed) {
        this.#deleteNote(parsed.path);
        this.#insertNote(parsed, { hash, mtime: file.mtime, size: file.size, date: dateOf(file) });
      }
      if (refresh) {
        const update = this.db.prepare("UPDATE notes SET date = ? WHERE path = ?");
        for (const file of unchanged) update.run(dateOf(file), file.rel);
      }
      if (changed.length || removed.length) {
        this.#resolver = null;
        this.#relink();
      }
      this.#setMeta("lastIndexAt", new Date().toISOString());
      this.#setMeta("head", head);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // nothing to roll back
      }
      throw error;
    }
    if (embedder && !isClosed()) await this.#embedPending(embedder, isClosed);
    return { changed: changed.length, removed: removed.length };
  }

  #deleteNote(notePath) {
    const ids = "SELECT id FROM chunks WHERE path = ?";
    this.db.prepare(`DELETE FROM vectors WHERE chunk_id IN (${ids})`).run(notePath);
    this.db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (${ids})`).run(notePath);
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(notePath);
    this.db.prepare("DELETE FROM links WHERE src = ?").run(notePath);
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(notePath);
  }

  #insertNote(note, { hash, mtime, size, date }) {
    this.db
      .prepare("INSERT INTO notes(path, title, aliases, hash, mtime, date, size) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(note.path, note.title, JSON.stringify(note.aliases), hash, mtime, date, size);
    const insertChunk = this.db.prepare("INSERT INTO chunks(path, ord, heading, text) VALUES (?, ?, ?, ?)");
    const insertFts = this.db.prepare("INSERT INTO chunks_fts(rowid, path, title, heading, text) VALUES (?, ?, ?, ?, ?)");
    for (const chunk of note.chunks) {
      const id = Number(insertChunk.run(note.path, chunk.ord, chunk.heading, chunk.text).lastInsertRowid);
      insertFts.run(id, note.path, note.title, chunk.heading, chunk.text);
    }
    const insertLink = this.db.prepare("INSERT INTO links(src, dst, raw) VALUES (?, NULL, ?)");
    for (const raw of note.links) insertLink.run(note.path, raw);
  }

  #relink() {
    const resolve = this.resolveName.bind(this);
    const update = this.db.prepare("UPDATE links SET dst = ? WHERE rowid = ?");
    for (const row of this.db.prepare("SELECT rowid AS id, dst, raw FROM links").all()) {
      const dst = resolve(row.raw);
      if (dst !== row.dst) update.run(dst, row.id);
    }
  }

  async #embedPending(embedder, isClosed) {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.heading AS heading, c.text AS text, n.title AS title
         FROM chunks c JOIN notes n ON n.path = c.path
         LEFT JOIN vectors v ON v.chunk_id = c.id
         WHERE v.chunk_id IS NULL AND length(trim(c.text)) > 0`,
      )
      .all();
    const insert = this.db.prepare("INSERT OR REPLACE INTO vectors(chunk_id, vec) VALUES (?, ?)");
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH);
      const texts = batch.map((r) => [r.title, r.heading, r.text].filter(Boolean).join("\n").slice(0, EMBED_TEXT_MAX));
      const vectors = await embedder.embed(texts, "passage");
      if (isClosed()) return;
      this.db.exec("BEGIN");
      try {
        batch.forEach((row, j) => insert.run(row.id, toBlob(vectors[j])));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}
