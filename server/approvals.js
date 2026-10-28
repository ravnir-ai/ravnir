import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Every action that waits for the user lands here, whichever bot or tool asked.
// Pending requests live in memory with their resolver; the file keeps the record
// so the inbox survives a reload. A restart cannot resume a paused turn, so
// anything still pending at boot is marked expired.

const KEEP = 300;
const DECISIONS = new Set(["once", "always", "trust", "reject"]);

export class ApprovalCenter {
  constructor({ home, timeoutMs = defaultTimeout(), onChange } = {}) {
    this.file = path.join(home, "approvals.json");
    this.timeoutMs = timeoutMs;
    this.onChange = onChange;
    this.waiting = new Map();
    this.records = this.#load();
  }

  request({ id, bot, kind = "action", title, detail = "", rule = "", onceOnly = false, permission = "", source = "chat", turnId = "", data = null, signal, timeoutMs }) {
    const record = {
      id: id || crypto.randomUUID(),
      botId: bot.id,
      botName: bot.name,
      kind,
      title: String(title || "A bot is waiting for your approval").slice(0, 400),
      detail: String(detail || "").slice(0, 4000),
      rule: String(rule || "").slice(0, 300),
      onceOnly: Boolean(onceOnly),
      permission: String(permission || "").slice(0, 60),
      // Small structured extras for the card, for example the address of a takeover.
      data: data && typeof data === "object" ? JSON.parse(JSON.stringify(data)) : null,
      source,
      turnId,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + (timeoutMs || this.timeoutMs),
      decidedAt: 0,
    };
    this.records = [...this.records.filter((item) => item.id !== record.id), record];
    this.#save();
    this.onChange?.(record);
    return new Promise((resolve) => {
      const finish = (decision, status) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiting.delete(record.id);
        record.status = status;
        record.decision = decision;
        record.decidedAt = Date.now();
        this.#save();
        this.onChange?.(record);
        resolve(decision);
      };
      const onAbort = () => finish("reject", "cancelled");
      const timer = setTimeout(() => finish("reject", "expired"), record.expiresAt - Date.now());
      this.waiting.set(record.id, finish);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  decide(id, value) {
    const finish = this.waiting.get(id);
    if (!finish) return false;
    let decision = DECISIONS.has(value) ? value : "reject";
    if (decision === "always" && this.records.find((item) => item.id === id)?.onceOnly) decision = "once";
    finish(decision, decision === "reject" ? "rejected" : "approved");
    return true;
  }

  pending() {
    return this.records.filter((item) => item.status === "pending" && this.waiting.has(item.id));
  }

  pendingFor(botId) {
    return this.pending().filter((item) => item.botId === botId);
  }

  since(at) {
    return this.records.filter((item) => item.createdAt >= at || item.decidedAt >= at);
  }

  #load() {
    let records = [];
    try {
      records = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(records)) return [];
    for (const record of records) {
      if (record.status === "pending") {
        record.status = "expired";
        record.decidedAt = Date.now();
        record.detail = `${record.detail ? `${record.detail}\n\n` : ""}The server restarted before anyone answered.`;
      }
    }
    return records.slice(-KEEP);
  }

  #save() {
    this.records = this.records.slice(-KEEP);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.records, null, 1));
  }
}

function defaultTimeout() {
  const minutes = Number(process.env.RAVNIR_APPROVAL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}
