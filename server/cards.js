import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "./childEnv.js";

// Capability cards: an agent's setup (model, job, instructions, skills) runs the tasks in
// evals/axes.mjs on sealed copies, and gets a measured score per area. The run is a child process
// (evals/card.mjs), one at a time on the whole server because it starts a browser per task and
// spends model tokens. Cards are kept in <home>/cards/<botId>/<startedAt>.json.

const KEEP = 20;
// What a card may cost per task when the agent has no history to go by, and the ceiling we quote.
const FALLBACK_TASK_COST = 0.01;
const CEILING_TASK_COST = 0.05;

export class CardManager {
  constructor({ home, projectRoot, connectionFor, notify = async () => {}, spawnCard = null, now = () => Date.now() }) {
    this.home = home;
    this.projectRoot = projectRoot;
    this.connectionFor = connectionFor;
    this.notify = notify;
    this.spawnCard = spawnCard;
    this.now = now;
    this.running = null;
  }

  dir(botId) {
    return path.join(this.home, "cards", String(botId).replace(/[^a-zA-Z0-9-]/g, ""));
  }

  list(botId) {
    let names = [];
    try {
      names = fs.readdirSync(this.dir(botId)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.dir(botId), name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  latest(botId) {
    return this.list(botId)[0] || null;
  }

  status(botId = "") {
    const run = this.running;
    if (!run) return null;
    const mine = !botId || run.botId === botId;
    return {
      botId: run.botId,
      botName: run.botName,
      mine,
      startedAt: run.startedAt,
      done: run.done,
      total: run.total,
      finished: run.finished,
      last: run.last,
    };
  }

  // A quote before a run: tasks times what this agent's turns have cost, with a ceiling.
  estimate(bot, tasks, turns = []) {
    const costs = turns.filter((row) => row.botId === bot.id && row.status === "ok").map((row) => Number(row.usage?.cost) || 0).slice(-60);
    const average = costs.length ? costs.reduce((sum, value) => sum + value, 0) / costs.length : FALLBACK_TASK_COST;
    const round = (value) => Math.round(value * 100) / 100;
    // A task is often more than one model call; 1.5 turns of this agent is the usual case.
    return {
      tasks,
      typical: round(tasks * average * 1.5),
      ceiling: round(tasks * Math.max(average * 4, CEILING_TASK_COST)),
      basis: costs.length ? `${costs.length} recent turns averaging $${average.toFixed(4)}` : "no turns yet",
    };
  }

  start(bot, { runs = 1, tasks = [] } = {}) {
    if (this.running) {
      const other = this.running.botName;
      throw Object.assign(new Error(`A card for ${other} is running. One runs at a time, because each task opens its own browser.`), { status: 409 });
    }
    if (!bot.model?.model) throw Object.assign(new Error("Pick a model for this agent first."), { status: 400 });
    const connection = this.connectionFor(bot);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-card-"));
    const config = {
      name: bot.name,
      job: bot.job,
      prompt: bot.prompt,
      skills: bot.skills || [],
      model: { provider: bot.model.provider === "openai" ? "openai" : "opencode", model: bot.model.model, baseUrl: bot.model.baseUrl || "" },
    };
    const configFile = path.join(work, "card.json");
    const outFile = path.join(work, "result.json");
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const args = [path.join(this.projectRoot, "evals", "card.mjs"), "--config", configFile, "--out", outFile, "--runs", String(Math.min(3, Math.max(1, Number(runs) || 1)))];
    if (tasks.length) args.push("--tasks", tasks.join(","));
    // Only what the run needs: no sign-in password, Mac token, vault or server list reach it.
    const env = childEnv({
      RAVNIR_EVAL_OPENCODE_PASSWORD: config.model.provider === "opencode" ? connection.key : undefined,
      RAVNIR_EVAL_API_KEY: config.model.provider === "openai" ? connection.key : undefined,
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      RAVNIR_TYPESAFE_KEY: process.env.RAVNIR_TYPESAFE_KEY,
      RAVNIR_TYPESAFE_ENDPOINT: process.env.RAVNIR_TYPESAFE_ENDPOINT,
      RAVNIR_TYPESAFE_MODEL: process.env.RAVNIR_TYPESAFE_MODEL,
      RAVNIR_ZEN_MODELS_URL: "off",
      RAVNIR_BOX: "off",
    });
    const child = this.spawnCard
      ? this.spawnCard(args, env)
      : spawn(process.execPath, args, { cwd: this.projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const run = {
      id: crypto.randomUUID(),
      botId: bot.id,
      botName: bot.name,
      startedAt: this.now(),
      done: 0,
      total: 0,
      finished: 0,
      last: null,
      child,
      work,
      outFile,
      error: "",
      stopped: false,
    };
    this.running = run;
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // the servers inside the run may print warnings
        }
        if (event.type === "start") run.total = event.total;
        if (event.type === "task") {
          run.done = event.done;
          run.total = event.total;
          if (event.finished) run.finished += 1;
          run.last = { task: event.task, axis: event.axis, finished: event.finished, why: event.why };
        }
        if (event.type === "error") run.error = event.error;
      }
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("close", (code) => this.#finish(run, code, stderr));
    return this.status(bot.id);
  }

  stop(botId) {
    const run = this.running;
    if (!run || run.botId !== botId) return false;
    run.stopped = true;
    run.child.kill("SIGTERM");
    return true;
  }

  #finish(run, code, stderr) {
    let card = null;
    try {
      card = JSON.parse(fs.readFileSync(run.outFile, "utf8"));
    } catch {
      card = null;
    }
    fs.rmSync(run.work, { recursive: true, force: true });
    if (this.running === run) this.running = null;
    if (card && code === 0) {
      const dir = this.dir(run.botId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${card.startedAt}.json`), `${JSON.stringify(card)}\n`);
      for (const old of this.list(run.botId).slice(KEEP)) fs.rmSync(path.join(dir, `${old.startedAt}.json`), { force: true });
      this.notify({
        botId: run.botId,
        botName: run.botName,
        kind: "message",
        title: `${run.botName}'s capability card is ready`,
        body: `Overall ${card.overall ?? "n/a"}. ${card.axes.filter((axis) => axis.score !== null).map((axis) => `${axis.label} ${axis.score}`).join(", ")}.`,
        url: `/?bot=${run.botId}&panel=card`,
      }).catch(() => {});
      return;
    }
    if (run.stopped) return;
    const why = run.error || String(stderr).trim().split("\n").at(-1) || `the run exited with code ${code}`;
    this.lastError = { botId: run.botId, at: this.now(), error: why };
    this.notify({ botId: run.botId, botName: run.botName, kind: "failure", title: `${run.botName}'s capability card did not finish`, body: why, url: `/?bot=${run.botId}&panel=card` }).catch(() => {});
  }

  close() {
    this.running?.child.kill("SIGTERM");
  }
}
