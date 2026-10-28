import fs from "node:fs";
import path from "node:path";
import { botHome } from "./state.js";

const MAX_EVENTS = 4000;

export class EventLog {
  constructor({ home }) {
    this.home = home;
    this.seqs = new Map();
  }

  file(bot) {
    return path.join(botHome(this.home, bot), "events.ndjson");
  }

  #seq(bot) {
    if (this.seqs.has(bot.id)) return this.seqs.get(bot.id);
    let seq = 0;
    try {
      const text = fs.readFileSync(this.file(bot), "utf8");
      const lines = text.trim().split("\n");
      const last = JSON.parse(lines.at(-1));
      seq = Number(last.seq) || 0;
    } catch {
      seq = 0;
    }
    this.seqs.set(bot.id, seq);
    return seq;
  }

  append(bot, event) {
    const seq = this.#seq(bot) + 1;
    this.seqs.set(bot.id, seq);
    const line = JSON.stringify({ seq, ...event, botId: bot.id, at: event.at || Date.now() });
    fs.mkdirSync(path.dirname(this.file(bot)), { recursive: true });
    fs.appendFileSync(this.file(bot), `${line}\n`);
    return { seq, ...event };
  }

  lastSeq(bot) {
    return this.#seq(bot);
  }

  read(bot, after = 0, limit = 400) {
    let text = "";
    try {
      text = fs.readFileSync(this.file(bot), "utf8");
    } catch {
      return { events: [], cursor: Number(after) || 0, lastSeq: this.#seq(bot) };
    }
    const events = [];
    let lastSeq = Number(after) || 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      lastSeq = Math.max(lastSeq, Number(event.seq) || 0);
      if (Number(event.seq) > Number(after)) {
        events.push(event);
        if (events.length >= limit) break;
      }
    }
    return { events, cursor: events.length ? events.at(-1).seq : Number(after) || 0, lastSeq };
  }

  prune(bot) {
    try {
      const file = this.file(bot);
      const text = fs.readFileSync(file, "utf8");
      const lines = text.trim().split("\n");
      if (lines.length <= MAX_EVENTS) return;
      fs.writeFileSync(file, `${lines.slice(-MAX_EVENTS).join("\n")}\n`);
    } catch {
      // Ignore.
    }
  }
}
