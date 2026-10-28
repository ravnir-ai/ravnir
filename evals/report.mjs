#!/usr/bin/env node
// Builds report.md from the result files of one run (evals/run.mjs writes them).
//   node evals/report.mjs evals/results/<run>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadResults(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))
    .filter((result) => Array.isArray(result.tasks));
}

export function renderReport(results) {
  if (!results.length) return "# Evals\n\nNo results yet.\n";
  const sorted = [...results].sort((a, b) => b.summary.finishRate - a.summary.finishRate || a.summary.asksMean - b.summary.asksMean || a.summary.costPerTask - b.summary.costPerTask);
  const taskIds = [...new Set(sorted.flatMap((result) => result.tasks.map((task) => task.task)))];
  const titles = Object.fromEntries(sorted.flatMap((result) => result.tasks.map((task) => [task.task, task])));
  const lines = [];
  lines.push("# Model report card", "");
  lines.push(`${taskIds.length} tasks, each on a fresh agent with its own browser, through OpenCode. The runner plays the user: it answers at most two questions per task. Asks counts every question a turn left for the user (ask_user, a browser hand-over, or a reply that ends asking). Two tasks expect one question each and fail without it; extra asks are the ones beyond that. A task counts as finished only when its check passes (the site's log, the workspace, the vault, the agent's jobs or the reply, and for answers read off a page, proof the agent opened it) and every turn ended cleanly. Repeat questions refused are ask_user calls turned away because the agent already asked; retries refused are tool calls turned away as unchanged repeats of a failure.`, "");
  lines.push("| Model | Finished | Asks per task (mean) | Asks (median) | Extra asks | Repeat questions refused | Retries refused | Cost per task | Median time |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of sorted) {
    const s = result.summary;
    lines.push(`| ${result.model} | ${s.finished}/${s.tasks} (${Math.round(s.finishRate * 100)}%) | ${s.asksMean.toFixed(2)} | ${s.asksMedian} | ${s.extraAsksMean.toFixed(2)} | ${s.blocked} | ${s.retriesRefused || 0} | ${money(s.costPerTask)} | ${s.medianSeconds} s |`);
  }
  lines.push("", "## By task", "");
  lines.push(`| Task | ${sorted.map((result) => result.model).join(" | ")} |`);
  lines.push(`| --- | ${sorted.map(() => "---").join(" | ")} |`);
  for (const id of taskIds) {
    const cells = sorted.map((result) => {
      const task = result.tasks.find((item) => item.task === id);
      if (!task) return "";
      return `${task.finished ? "pass" : "fail"}${task.asks ? `, ${task.asks} ask${task.asks === 1 ? "" : "s"}` : ""}`;
    });
    lines.push(`| ${titles[id].title}${titles[id].expectAsks ? " (expects 1 ask)" : ""} | ${cells.join(" | ")} |`);
  }
  lines.push("", "## Why tasks failed", "");
  let any = false;
  for (const result of sorted) {
    for (const task of result.tasks.filter((item) => !item.finished)) {
      any = true;
      lines.push(`- ${result.model}, ${task.task}: ${oneLine(task.why)}${task.errors?.length ? ` (error: ${oneLine(task.errors[0])})` : ""}`);
    }
  }
  if (!any) lines.push("- None.");
  lines.push("", `Costs are what OpenCode reported for each turn, plus any model calls Ravnir's tools made. Generated from ${results.length} result file${results.length === 1 ? "" : "s"}.`, "");
  return lines.join("\n");
}

export function writeReport(dir) {
  const text = renderReport(loadResults(dir));
  fs.writeFileSync(path.join(dir, "report.md"), text);
  return text;
}

const money = (value) => `$${(value || 0).toFixed(value < 0.01 ? 4 : 3)}`;
// Reasons are published, so local file paths become a placeholder.
const oneLine = (text) => String(text || "").replace(/\/(?:var|private|tmp|Users|home)\/\S+/g, "<temp file>").replace(/\s+/g, " ").trim().slice(0, 200);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node evals/report.mjs evals/results/<run>");
    process.exit(2);
  }
  process.stdout.write(writeReport(path.resolve(dir)));
}
