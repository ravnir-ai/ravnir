import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Everything a bot wants the user to know lands here first, then the push rules
// decide whether it also reaches the phone and the Mac. The record is kept
// either way so the Inbox can show what was suppressed and why.

const KEEP = 500;
const BODY_MAX = 240;
const TITLE_MAX = 120;
const KINDS = new Set(["turn", "routine", "reminder", "approval", "proposal", "message", "failure"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const LEVELS = new Set(["all", "important", "off"]);
const IMPORTANT = new Set(["turn", "approval", "proposal", "message", "failure", "reminder", "routine", "question"]);

// "Researcher is back" for titles that start with a verb (the Inbox reads them the same way), else "Name: title".
const VERB_TITLE = /^(wants|needs|is|has|asked|finished|failed)\b/i;
function pushTitle(record) {
  if (!record.botName) return record.title;
  return VERB_TITLE.test(record.title) ? `${record.botName} ${record.title}` : `${record.botName}: ${record.title}`;
}

export class NotificationCenter {
  constructor({ home, push, getSettings = () => ({}), getBot = () => null, now = () => Date.now() } = {}) {
    this.file = path.join(home, "notifications.json");
    this.push = push;
    this.getSettings = getSettings;
    this.getBot = getBot;
    this.now = now;
    this.records = this.#load();
  }

  async notify({ botId = "", botName = "", kind = "message", title = "", body = "", url = "/", priority = "normal", tag = "" } = {}) {
    const at = Number(this.now());
    const record = {
      id: crypto.randomUUID(),
      at,
      botId: String(botId || ""),
      botName: String(botName || this.getBot(botId)?.name || ""),
      kind: KINDS.has(kind) ? kind : "message",
      title: plainText(title, TITLE_MAX),
      body: plainText(body, BODY_MAX),
      url: safeUrl(url),
      priority: PRIORITIES.has(priority) ? priority : "normal",
      tag: String(tag || "").slice(0, 120),
      read: false,
      pushed: false,
      suppressed: this.#suppression({ botId, kind: KINDS.has(kind) ? kind : "message", priority: PRIORITIES.has(priority) ? priority : "normal", at }),
    };
    this.records = [...this.records, record].slice(-KEEP);
    this.#save();
    if (record.suppressed) return record;
    try {
      const result = await this.push.send({
        id: record.id,
        title: pushTitle(record),
        body: record.body,
        url: record.url,
        tag: record.tag,
        kind: record.kind,
        botId: record.botId,
      }, { priority: record.priority });
      record.pushed = result.sent > 0;
      if (!record.pushed) record.suppressed = result.failed ? "send-failed" : "no-subscribers";
    } catch {
      record.suppressed = "send-failed";
    }
    this.#save();
    return record;
  }

  list({ limit = 100 } = {}) {
    return this.records.slice(-Math.max(1, Number(limit) || 100)).reverse();
  }

  unreadCount() {
    return this.records.filter((item) => !item.read).length;
  }

  markRead(ids) {
    const all = ids === "all";
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    let changed = 0;
    for (const record of this.records) {
      if (!record.read && (all || wanted.has(record.id))) {
        record.read = true;
        changed += 1;
      }
    }
    if (changed) this.#save();
    return changed;
  }

  #suppression({ botId, kind, priority, at }) {
    const noSubscribers = !this.push?.list?.().length;
    if (kind === "approval") return noSubscribers ? "no-subscribers" : "";
    const settings = this.getSettings() || {};
    if (settings.enabled === false) return "disabled";
    const level = this.getBot(botId)?.notify;
    const mode = LEVELS.has(level) ? level : "important";
    if (mode === "off") return "bot-off";
    if (mode === "important" && !IMPORTANT.has(kind)) return "not-important";
    if (priority !== "urgent" && inQuietHours(settings, at)) return "quiet";
    return noSubscribers ? "no-subscribers" : "";
  }

  #load() {
    try {
      const records = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(records) ? records.slice(-KEEP) : [];
    } catch {
      return [];
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.records, null, 1), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, this.file);
  }
}

export function inQuietHours({ quietStart = "23:00", quietEnd = "08:00" } = {}, at = Date.now()) {
  const start = minutesOf(quietStart);
  const end = minutesOf(quietEnd);
  if (start === null || end === null || start === end) return false;
  const date = new Date(at);
  const minute = date.getHours() * 60 + date.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function plainText(value, max = BODY_MAX) {
  let text = String(value ?? "")
    .replace(/\r/g, "")
    .replace(/^\s*(```|~~~)[^\n]*$/gm, "")
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1$2")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

function minutesOf(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

function safeUrl(value) {
  const url = String(value || "/");
  return /^\/(?![/\\])/.test(url) ? url.slice(0, 500) : "/";
}
