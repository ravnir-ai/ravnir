import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VaultIndex, stripFrontmatter } from "./indexer.js";
import { search } from "./search.js";
import { contextForBot, staticContextForBot } from "./context.js";
import { ensureClone, pull } from "./sync.js";

// Read-only view over an Obsidian vault kept in git. It never writes to the
// vault folder; the only git it runs is clone, pull --ff-only and log.

const READ_MAX = 40000;
const DEBOUNCE_MS = 1500;
const FALLBACK_SCAN_MS = 30000;
const RESCAN_MS = 5 * 60 * 1000;
const MAX_PROJECTS = 4;

const norm = (text) => String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const errorText = (error) => String(error?.message || error || "failed").slice(0, 300);

export class Vault {
  #index;
  #embedder;
  #available = false;
  #closed = false;
  #chain = Promise.resolve();
  #timers = new Set();
  #watcher = null;
  #debounce = null;
  #lastIndexAt = null;
  #lastPullAt = null;
  #pullError = "";
  #indexError = "";
  #live = new Map();

  constructor({ dir, dbPath = ":memory:", remote = "", sshCommand = "", pullMs = 120000, watch = true, embedder = null, onChange = null } = {}) {
    this.dir = path.resolve(dir || ".");
    this.remote = remote;
    this.sshCommand = sshCommand;
    this.pullMs = pullMs;
    this.watch = watch;
    this.onChange = onChange;
    this.#embedder = embedder;
    this.#index = new VaultIndex(dbPath);
  }

  get available() {
    return this.#available;
  }

  setEmbedder(embedder) {
    this.#embedder = embedder || null;
  }

  async open() {
    if (this.remote && !fs.existsSync(this.dir)) {
      const cloned = await ensureClone({ remote: this.remote, dir: this.dir, sshCommand: this.sshCommand });
      if (cloned.error) this.#pullError = cloned.error;
    }
    if (!fs.existsSync(this.dir)) {
      this.#available = false;
      this.#indexError = "vault folder not found";
      return;
    }
    this.#available = true;
    await this.reindex();
    if (this.#closed) return;
    if (this.watch) this.#startWatching();
    if (this.pullMs > 0 && (this.remote || fs.existsSync(path.join(this.dir, ".git")))) {
      this.#every(() => this.pull(), this.pullMs);
    }
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#debounce);
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.clear();
    try {
      this.#watcher?.close();
    } catch {
      // already closed
    }
    this.#watcher = null;
    this.#index.close();
  }

  status() {
    const counts = this.#closed ? { notes: 0, chunks: 0 } : this.#index.counts();
    return {
      available: this.#available,
      dir: this.dir,
      notes: counts.notes,
      chunks: counts.chunks,
      lastIndexAt: this.#lastIndexAt,
      lastPullAt: this.#lastPullAt,
      lastError: this.#pullError || this.#indexError || null,
      head: this.#index.head,
      embed: Boolean(this.#embedder),
    };
  }

  reindex() {
    const run = this.#chain.then(() => this.#reindex());
    this.#chain = run.catch(() => {});
    return run;
  }

  async #reindex() {
    const none = { changed: 0, removed: 0 };
    if (this.#closed || !this.#available) return none;
    let result;
    try {
      result = await this.#index.reindex(this.dir, { embedder: this.#embedder, isClosed: () => this.#closed });
      this.#indexError = "";
    } catch (error) {
      if (!this.#closed) this.#indexError = errorText(error);
      return none;
    }
    this.#lastIndexAt = new Date().toISOString();
    if ((result.changed || result.removed) && this.onChange) {
      try {
        this.onChange(result);
      } catch {
        // a listener must not break indexing
      }
    }
    return result;
  }

  async pull() {
    if (this.#closed || !fs.existsSync(path.join(this.dir, ".git"))) return { updated: false, error: null };
    const result = await pull({ dir: this.dir, sshCommand: this.sshCommand });
    this.#lastPullAt = new Date().toISOString();
    this.#pullError = result.error || "";
    if (result.updated) await this.reindex();
    return result;
  }

  #every(fn, ms) {
    const timer = setInterval(() => {
      if (!this.#closed) fn().catch(() => {});
    }, ms);
    timer.unref?.();
    this.#timers.add(timer);
  }

  #startWatching() {
    this.#every(() => this.reindex(), RESCAN_MS);
    try {
      this.#watcher = fs.watch(this.dir, { recursive: true }, (event, file) => {
        if (file && String(file).split(path.sep).some((part) => part.startsWith("."))) return;
        clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => this.reindex().catch(() => {}), DEBOUNCE_MS);
        this.#debounce.unref?.();
      });
      this.#watcher.on("error", () => {
        try {
          this.#watcher?.close();
        } catch {
          // ignore
        }
        this.#watcher = null;
        this.#every(() => this.reindex(), FALLBACK_SCAN_MS);
      });
    } catch {
      this.#every(() => this.reindex(), FALLBACK_SCAN_MS);
    }
  }

  resolve(name) {
    if (this.#closed) return null;
    const found = this.#index.resolveName(name);
    if (!found) return null;
    try {
      const root = fs.realpathSync(this.dir);
      const real = fs.realpathSync(path.join(this.dir, found));
      if (real !== root && !real.startsWith(root + path.sep)) return null;
    } catch {
      return null;
    }
    return found;
  }

  notes(prefix = "") {
    return this.#closed ? [] : this.#index.notes(prefix);
  }

  setLive(name, text) {
    const found = this.resolve(name);
    if (!found) return;
    const value = String(text || "").trim();
    if (value) this.#live.set(found, { text: value, at: Date.now() });
    else this.#live.delete(found);
  }

  clearLive(name) {
    const found = this.resolve(name);
    if (found) this.#live.delete(found);
  }

  live(name) {
    const found = this.resolve(name);
    return (found && this.#live.get(found)?.text) || "";
  }

  read(name) {
    const found = this.resolve(name);
    if (!found) return null;
    let raw;
    try {
      raw = fs.readFileSync(path.join(this.dir, found));
    } catch {
      return null;
    }
    const live = this.#live.get(found)?.text || "";
    const text = raw.toString("utf8");
    const meta = this.#index.note(found);
    const links = this.links(found);
    return {
      path: found,
      title: meta?.title || path.posix.basename(found, ".md"),
      date: meta?.date || null,
      hash: crypto.createHash("sha1").update(raw).update(live).digest("hex"),
      body: text.slice(0, READ_MAX) + (live ? `\n\n## Current status (live, from Ravnir)\n${live}\n` : ""),
      truncated: text.length > READ_MAX,
      links: links?.links || [],
      unresolved: links?.unresolved || [],
      backlinks: links?.backlinks || [],
    };
  }

  links(name) {
    const found = this.resolve(name);
    if (!found) return null;
    return {
      path: found,
      links: this.#index.outgoing(found),
      backlinks: this.#index.backlinks(found),
      unresolved: this.#index.unresolved(found),
    };
  }

  section(name, headingRegex) {
    const found = this.resolve(name);
    if (!found) return "";
    let raw;
    try {
      raw = fs.readFileSync(path.join(this.dir, found), "utf8");
    } catch {
      return "";
    }
    const re = headingRegex instanceof RegExp ? new RegExp(headingRegex.source, headingRegex.flags.replace("g", "")) : new RegExp(String(headingRegex), "i");
    const out = [];
    let level = 0;
    let fence = false;
    for (const line of stripFrontmatter(raw).split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const m = fence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) {
        if (level && m[1].length <= level) break;
        if (!level && re.test(m[2])) {
          level = m[1].length;
          continue;
        }
      }
      if (level) out.push(line);
    }
    return out.join("\n").trim();
  }

  async search(query, opts = {}) {
    if (this.#closed || !this.#available) return [];
    return search(this.#index, query, { ...opts, embedder: this.#embedder });
  }

  noteForBot(bot) {
    if (bot?.vaultNote) return this.resolve(bot.vaultNote);
    const name = norm(bot?.name);
    if (!name) return null;
    const agents = this.notes("Agents/").filter((n) => path.posix.dirname(n.path) === "Agents");
    const byName = (key) => agents.find((n) => norm(path.posix.basename(n.path, ".md")) === key)?.path || null;
    const exact = byName(name);
    if (exact) return exact;
    return name.endsWith("bot") && name.length > 3 ? byName(name.slice(0, -3)) : null;
  }

  projectsForBot(bot, agentPath = null) {
    const out = [];
    const add = (p) => {
      if (p && !out.includes(p)) out.push(p);
    };
    for (const name of Array.isArray(bot?.vaultProjects) ? bot.vaultProjects : []) add(this.resolve(name));
    if (agentPath) {
      for (const p of this.links(agentPath)?.links || []) if (p.startsWith("Projects/")) add(p);
    }
    const name = norm(bot?.name);
    if (name) add(this.notes("Projects/").find((n) => norm(path.posix.basename(n.path, ".md")) === name)?.path);
    return out.slice(0, MAX_PROJECTS);
  }

  contextForBot(bot, query, opts = {}) {
    return contextForBot(this, bot, query, opts);
  }

  staticContextForBot(bot, opts = {}) {
    return staticContextForBot(this, bot, opts);
  }
}
