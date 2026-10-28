import fs from "node:fs";
import path from "node:path";

// One line per finished turn: who ran, why, what it cost, and what came out.
// Usage totals, daily caps, and the Today feed all read from this file.

const SUMMARY_LIMIT = 2000;
const MEMORY_DAYS = 45;

export function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(total, part) {
  const out = { ...emptyUsage(), ...total };
  if (!part) return out;
  for (const key of Object.keys(emptyUsage())) {
    const value = Number(part[key]);
    if (Number.isFinite(value)) out[key] += value;
  }
  return out;
}

export function tokensOf(usage) {
  if (!usage) return 0;
  return (usage.input || 0) + (usage.output || 0) + (usage.reasoning || 0) + (usage.cacheWrite || 0);
}

export function startOfMonth(at = Date.now()) {
  const date = new Date(at);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// How a turn's model is paid for, from what the provider reported: a price (metered), a free
// model, or tokens with no price (a subscription plan, or a server that does not report one).
// Never a share of a quota: no provider reports that, so it would be a made-up number.
export function billingOf({ model = "", usage = null } = {}) {
  if ((Number(usage?.cost) || 0) > 0) return "metered";
  if (/(^|[-/:])free($|[-/:])/i.test(String(model))) return "free";
  return tokensOf(usage) > 0 ? "plan" : "none";
}

// The cost line under a reply: the same numbers the ledger row for that turn holds.
export function costOf({ turnId = "", usage = null, model = "", provider = "" } = {}) {
  const clean = addUsage(emptyUsage(), usage);
  return { turnId, usage: clean, tokens: tokensOf(clean), cost: round(clean.cost), model, provider, billing: billingOf({ model, usage: clean }) };
}

export function startOfDay(at = Date.now()) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export class Ledger {
  constructor({ home }) {
    this.file = path.join(home, "turns.ndjson");
    this.rows = this.#load();
  }

  record(row) {
    const entry = {
      ...row,
      summary: String(row.summary || "").slice(0, SUMMARY_LIMIT),
      usage: addUsage(emptyUsage(), row.usage),
      at: row.at || Date.now(),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    this.rows.push(entry);
    this.#trim();
    return entry;
  }

  get(id) {
    if (!id) return null;
    for (let index = this.rows.length - 1; index >= 0; index -= 1) if (this.rows[index].id === id) return this.rows[index];
    return null;
  }

  between(from, to = Infinity, botId = "") {
    return this.rows.filter((row) => row.at >= from && row.at < to && (!botId || row.botId === botId));
  }

  totals(rows) {
    let usage = emptyUsage();
    let errors = 0;
    // Questions the turns left for the user (server/asks.js); rows from before P0.6 have none.
    let asks = 0;
    for (const row of rows) {
      usage = addUsage(usage, row.usage);
      if (row.status === "error") errors += 1;
      asks += Number(row.asks) || 0;
    }
    return { turns: rows.length, errors, asks, usage, tokens: tokensOf(usage), cost: round(usage.cost) };
  }

  spentToday(botId, at = Date.now()) {
    return this.totals(this.between(startOfDay(at), Infinity, botId));
  }

  // Rows are kept for 45 days, so the whole calendar month is always here.
  spentThisMonth(botId, at = Date.now()) {
    return this.totals(this.between(startOfMonth(at), Infinity, botId));
  }

  // Spend and tokens grouped by the model that produced them.
  byModel(rows) {
    const groups = new Map();
    for (const row of rows) {
      const provider = String(row.provider || "");
      const model = String(row.model || "server default");
      const key = `${provider}\u0000${model}`;
      let group = groups.get(key);
      if (!group) {
        group = { provider, model, turns: 0, errors: 0, usage: emptyUsage() };
        groups.set(key, group);
      }
      group.turns += 1;
      if (row.status === "error") group.errors += 1;
      group.usage = addUsage(group.usage, row.usage);
    }
    return [...groups.values()]
      .map((group) => ({ ...group, tokens: tokensOf(group.usage), cost: round(group.usage.cost) }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model));
  }

  // Daily totals for the last `days` days, oldest first.
  daily(botId, days = 14, at = Date.now()) {
    const out = [];
    const today = startOfDay(at);
    for (let index = days - 1; index >= 0; index -= 1) {
      const from = shiftDays(today, -index);
      const to = shiftDays(from, 1);
      out.push({ day: from, ...this.totals(this.between(from, to, botId)) });
    }
    return out;
  }

  #load() {
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const cutoff = shiftDays(startOfDay(), -MEMORY_DAYS);
    const rows = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.at >= cutoff) rows.push(row);
      } catch {
        // Skip a torn line.
      }
    }
    return rows;
  }

  #trim() {
    const cutoff = shiftDays(startOfDay(), -MEMORY_DAYS);
    if (this.rows.length && this.rows[0].at < cutoff) this.rows = this.rows.filter((row) => row.at >= cutoff);
  }
}

// Calendar days, so a daylight-saving change does not shift midnight.
export function shiftDays(at, days) {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function round(value) {
  return Math.round((value || 0) * 1_000_000) / 1_000_000;
}
