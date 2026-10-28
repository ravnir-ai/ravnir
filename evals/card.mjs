#!/usr/bin/env node
// Runs one agent's capability card: every task in evals/axes.mjs, each on a sealed copy of the agent
// (its model, job, instructions and skills; none of its memory, logins, plugins or history), then
// scores the eight areas.
//
//   node evals/card.mjs --config card.json --out result.json [--runs 2] [--concurrency 2]
//
// card.json: { name, job, prompt, skills, model: { provider: "opencode", model, baseUrl } or
// { provider: "openai", model, baseUrl } }. The OpenCode or API password comes from the environment
// (RAVNIR_EVAL_OPENCODE_PASSWORD or RAVNIR_EVAL_API_KEY), never the file. Progress goes to stdout as
// one JSON object per line; the server (server/cards.js) reads it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AXES, cardTasks, scoreCard } from "./axes.mjs";
import { ALL_TASKS, runModel, startOpenCode } from "./run.mjs";
import { tasks as research } from "./capability/research.mjs";
import { tasks as judgment } from "./capability/judgment.mjs";
import { tasks as writing } from "./capability/writing.mjs";
import { tasks as data } from "./capability/data.mjs";
import { tasks as code } from "./capability/code.mjs";

export const CARD_VERSION = 1;

export function cardTaskList() {
  return cardTasks(ALL_TASKS, [...research, ...judgment, ...writing, ...data, ...code]);
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function runCard({ config, runs = 1, concurrency = 2, turnTimeoutMs = 8 * 60_000, onEvent = emit, only = [] }) {
  const all = cardTaskList();
  const list = only.length ? all.filter((task) => only.includes(task.id)) : all;
  const tasks = Array.from({ length: Math.max(1, runs) }, () => list).flat();
  const model = config.model?.provider === "openai"
    ? { provider: "openai", model: config.model.model, baseUrl: config.model.baseUrl, apiKey: process.env.RAVNIR_EVAL_API_KEY || "" }
    : { provider: "opencode", model: config.model?.model };
  const startedAt = Date.now();
  let done = 0;
  // Three tasks in a row with no answer at all: the model is down or out of quota, so stop paying
  // for browsers and report what was measured.
  let silent = 0;
  let gaveUp = false;
  // From the command line with no OpenCode address, start one like the report card runner does.
  const own = model.provider === "opencode" && !config.model?.baseUrl ? await startOpenCode() : null;
  onEvent({ type: "start", total: tasks.length, axes: AXES.map((axis) => axis.id) });
  let result;
  try {
    result = await runModel({
      model,
      tasks,
      opencode: model.provider === "openai" ? "" : own?.url || config.model?.baseUrl || "",
      opencodePassword: process.env.RAVNIR_EVAL_OPENCODE_PASSWORD || "",
      concurrency,
      turnTimeoutMs,
      agent: { name: config.name, job: config.job, prompt: config.prompt, skills: config.skills || [] },
      log: () => {},
      shouldStop: () => gaveUp,
      onRow: (row) => {
        done += 1;
        silent = row.noAnswer ? silent + 1 : 0;
        if (silent >= 3 && !gaveUp) {
          gaveUp = true;
          onEvent({ type: "stopping", reason: "The model stopped answering (three tasks in a row with no reply)." });
        }
        onEvent({ type: "task", done, total: tasks.length, task: row.task, axis: list.find((task) => task.id === row.task)?.axis || "", finished: row.finished, why: row.why, cost: row.cost });
      },
    });
  } finally {
    own?.stop();
  }
  const card = scoreCard(result.tasks, list);
  return {
    version: CARD_VERSION,
    startedAt,
    durationMs: Date.now() - startedAt,
    model: config.model?.model || "",
    provider: config.model?.provider || "",
    skills: config.skills || [],
    runs: Math.max(1, runs),
    tasks: tasks.length,
    ran: result.tasks.length,
    stoppedEarly: gaveUp ? "The model stopped answering (three tasks in a row with no reply), so the rest was not run." : "",
    ...card,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, fallback = "") => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] || "" : fallback;
  };
  try {
    if (args.includes("--list")) {
      for (const task of cardTaskList()) console.log(`${task.axis.padEnd(10)} ${task.id.padEnd(24)} ${task.title}`);
      process.exit(0);
    }
    const config = JSON.parse(fs.readFileSync(flag("--config"), "utf8"));
    const out = flag("--out");
    if (!out) throw new Error("Give --out <file>.");
    const card = await runCard({
      config,
      runs: Number(flag("--runs", "1")) || 1,
      concurrency: Number(flag("--concurrency", "2")) || 2,
      only: flag("--tasks").split(",").map((item) => item.trim()).filter(Boolean),
    });
    fs.writeFileSync(out, `${JSON.stringify(card, null, 1)}\n`);
    emit({ type: "end", overall: card.overall, cost: card.cost });
    process.exit(0);
  } catch (error) {
    emit({ type: "error", error: error.message });
    process.exit(1);
  }
}
