import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Things a bot noticed and wants to do but was not asked to. The user gets a
// card with Do it and Dismiss; nothing runs until a proposal is accepted.

const KEEP = 300;
const STATUS_FOR = { accept: "accepted", dismiss: "dismissed" };

export class ProposalStore {
  constructor({ home }) {
    this.file = path.join(home, "proposals.json");
    this.records = this.#load();
  }

  create({ botId, botName = "", title, why = "", prompt, kind = "task", change = null, turnId = "" }) {
    const cleanTitle = String(title || "").trim().slice(0, 80);
    const cleanPrompt = String(prompt || "").trim().slice(0, 4000);
    if (!cleanTitle || !cleanPrompt) throw new Error("A proposal needs a title and a prompt.");
    const record = {
      id: crypto.randomUUID(),
      botId: String(botId || ""),
      botName: String(botName || ""),
      title: cleanTitle,
      why: String(why || "").trim().slice(0, 400),
      prompt: cleanPrompt,
      kind: String(kind || "task"),
      change: change && typeof change === "object" && !Array.isArray(change) ? change : null,
      ...(turnId ? { turnId: String(turnId).slice(0, 80) } : {}),
      status: "open",
      createdAt: Date.now(),
      decidedAt: 0,
    };
    this.records = [...this.records, record].slice(-KEEP);
    this.#save();
    return record;
  }

  list({ status } = {}) {
    return this.records.filter((item) => !status || item.status === status).reverse();
  }

  get(id) {
    return this.records.find((item) => item.id === id) || null;
  }

  // Returns null for an unknown id, a bad decision, or a proposal that was
  // already decided, so a double tap can never start the work twice.
  decide(id, decision) {
    const record = this.get(id);
    const status = STATUS_FOR[decision];
    if (!record || !status || record.status !== "open") return null;
    record.status = status;
    record.decidedAt = Date.now();
    this.#save();
    return record;
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

export function proactiveToolDefinitions() {
  return [
    {
      name: "notify_user",
      description: "Send a push notification to the user's phone and computer. Use it for things they must know now: a finished long task, a problem that needs them, a reminder you were asked to deliver. Never for small talk.",
      parameters: objectSchema({
        title: { type: "string", maxLength: 80, description: "Short headline, shown in bold." },
        body: { type: "string", maxLength: 400, description: "One or two plain sentences with the detail. No markdown." },
        priority: { type: "string", enum: ["normal", "high", "urgent"], description: "Use urgent only when it cannot wait, since it also goes through quiet hours." },
      }, ["title", "body"]),
    },
    {
      name: "propose_task",
      description: "Suggest something useful you noticed but were not asked to do. The user gets a card with Do it and Dismiss. Do it sends `prompt` back to you as an approved task. Do not start the work before it is accepted.",
      parameters: objectSchema({
        title: { type: "string", maxLength: 80, description: "What you want to do, in a few words." },
        why: { type: "string", maxLength: 400, description: "Why it is worth doing, in plain words." },
        prompt: { type: "string", maxLength: 4000, description: "The full task as you would want to receive it later, with every detail you will need." },
      }, ["title", "why", "prompt"]),
    },
  ];
}

function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}
