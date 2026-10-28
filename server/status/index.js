import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keeps the "live status" block of vault project notes filled from real data.
// Collectors are optional modules in <project>/local/status/*.js (or RAVNIR_STATUS_DIR) that export a
// string `kind` and a function `collect(feed, { now })`. A feed's `type` picks the collector with the same kind.

const MIN_MINUTES = 5;
const LOCAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "local", "status");
const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const errorText = (error) => String(error?.message || error || "failed").slice(0, 200);

export class StatusFeeds {
  #vault;
  #feeds;
  #now;
  #collectors;
  #localDir;
  #loaded = null;
  #timers = new Set();
  #good = new Map();
  #state = new Map();

  constructor({ vault, feeds = [], now = Date.now, collectors = {}, localDir = process.env.RAVNIR_STATUS_DIR || LOCAL_DIR } = {}) {
    this.#vault = vault;
    this.#feeds = Array.isArray(feeds) ? feeds.filter((f) => f?.note && f?.type) : [];
    this.#now = now;
    this.#collectors = collectors;
    this.#localDir = localDir;
  }

  // Collectors from the local folder, loaded once; the ones passed to the constructor win.
  #collectorsReady() {
    this.#loaded ||= (async () => {
      const found = {};
      let names = [];
      try {
        names = fs.readdirSync(this.#localDir).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js")).sort();
      } catch {}
      for (const name of names) {
        try {
          const mod = await import(pathToFileURL(path.join(this.#localDir, name)).href);
          if (typeof mod.kind === "string" && typeof mod.collect === "function") found[mod.kind] = mod.collect;
        } catch {}
      }
      return { ...found, ...this.#collectors };
    })();
    return this.#loaded;
  }

  static load(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async refresh(note) {
    const feeds = note ? this.#feeds.filter((f) => f.note === note) : this.#feeds;
    for (const feed of feeds) await this.#run(feed);
    return this.status();
  }

  async #run(feed) {
    const at = this.#now();
    let result;
    try {
      const collect = (await this.#collectorsReady())[feed.type];
      result = collect ? await collect(feed, { now: at }) : { ok: false, error: `unknown feed type ${feed.type}` };
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    const iso = new Date(at).toISOString();
    if (result?.ok) {
      this.#good.set(feed.note, { text: result.text, at });
      this.#vault.setLive(feed.note, result.text);
      this.#state.set(feed.note, { ok: true, at: iso, error: null });
      return;
    }
    const error = result?.error || "failed";
    const previous = this.#good.get(feed.note);
    const block = previous
      ? `${previous.text}\n- Warning: the last refresh failed at ${stamp(at)}: ${error}. These figures are from ${stamp(previous.at)}.`
      : `Live data from ${feed.type} unavailable (${stamp(at)}): ${error}. Do not quote figures from memory.`;
    this.#vault.setLive(feed.note, block);
    this.#state.set(feed.note, { ok: false, at: iso, error });
  }

  start() {
    this.stop();
    for (const feed of this.#feeds) {
      const minutes = Math.max(MIN_MINUTES, Number(feed.everyMinutes) || 30);
      this.#run(feed).catch(() => {});
      const timer = setInterval(() => this.#run(feed).catch(() => {}), minutes * 60000);
      timer.unref?.();
      this.#timers.add(timer);
    }
  }

  stop() {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.clear();
  }

  status() {
    return this.#feeds.map((f) => ({ note: f.note, type: f.type, ...(this.#state.get(f.note) || { ok: null, at: null, error: null }) }));
  }
}
