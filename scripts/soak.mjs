#!/usr/bin/env node
// The P0.9 soak: a real Ravnir server with its real scheduler, five agents with 15-minute routines
// against the scripted model, each routine opening a page in the agent's own browser that says
// whether that browser is still signed in. Runs for --hours (24 by default), then writes a report.
//   node scripts/soak.mjs [--hours 24] [--agents 5] [--cron "*/15 * * * *"] [--out docs/soak-YYYY-MM-DD.md]
// A short check: node scripts/soak.mjs --hours 0.1 --cron "* * * * *"

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-openai.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const HOURS = Number(arg("hours", 24));
const AGENTS = Number(arg("agents", 5));
const CRON = arg("cron", "*/15 * * * *");
const STUCK_MS = 10 * 60_000;
const startedAt = Date.now();
const out = path.resolve(root, arg("out", `docs/soak-${new Date(startedAt).toISOString().slice(0, 10)}.md`));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-soak-"));

// The page each routine opens: a sign-in that sets a cookie lasting 30 days, and a check page.
function startSite() {
  const site = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const who = /(?:^|;\s*)soak=([\w-]+)/.exec(req.headers.cookie || "")?.[1] || "";
    if (url.pathname === "/login") {
      const name = String(url.searchParams.get("as") || "").replace(/[^\w-]/g, "");
      res.writeHead(200, { "content-type": "text/html", "set-cookie": `soak=${name}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax` });
      res.end(`<html><title>Signed in</title><body>Signed in as ${name}.</body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><title>Check</title><body>${who ? `SOAK-SIGNED-IN as ${who}` : "SOAK-SIGNED-OUT"} at ${new Date().toISOString()}</body></html>`);
  });
  return new Promise((resolve) => site.listen(0, "127.0.0.1", () => resolve({ site, url: `http://127.0.0.1:${site.address().port}` })));
}

async function api(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitTurn(base, botId, turnId) {
  for (let tries = 0; tries < 600; tries += 1) {
    const { events } = await api(base, "GET", `/api/bots/${botId}/events?after=0`);
    if (events.some((event) => event.type === "turn.end" && event.turnId === turnId)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("A sign-in turn never ended.");
}

process.env.RAVNIR_AI_MEMORY = "off";
process.env.RAVNIR_HOME = home;
const { createApp } = await import("../server/index.js");
const mock = await startMock();
const { site, url: siteUrl } = await startSite();
const server = createApp({ home, projectRoot: root });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`Soak: ${AGENTS} agents, "${CRON}", ${HOURS} h, data in ${home}, report to ${out}`);

const bots = [];
for (let index = 0; index < AGENTS; index += 1) {
  const name = `Soak${index + 1}`;
  const bot = (await api(base, "POST", "/api/bots", { name, job: "Soak test agent.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } })).bot;
  // Sign each agent's browser in once; the routines then check the session survives every run.
  const { turnId } = await api(base, "POST", `/api/bots/${bot.id}/messages`, { text: `call tool browser_open {"url":"${siteUrl}/login?as=${name}"}` });
  await waitTurn(base, bot.id, turnId);
  const job = (await api(base, "POST", `/api/bots/${bot.id}/jobs`, { name: "Check", cron: CRON, prompt: `call tool browser_open {"url":"${siteUrl}/check"}`, notify: false })).job;
  bots.push({ id: bot.id, name, jobId: job.id });
}

const samples = [];
const stuckSeen = new Map();
const deadline = startedAt + HOURS * 3600_000;
let ticks = 0;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.max(1000, deadline - Date.now()))));
  ticks += 1;
  try {
    const { bots: list } = await api(base, "GET", "/api/state");
    for (const item of list) {
      if (item.busy && item.startedAt && Date.now() - item.startedAt > STUCK_MS && !stuckSeen.has(item.turnId)) stuckSeen.set(item.turnId, { bot: item.name, startedAt: item.startedAt });
    }
    samples.push({ at: Date.now(), rss: process.memoryUsage().rss, busy: list.filter((item) => item.busy).length });
    if (ticks % 30 === 0) console.log(`${new Date().toISOString()} ok, ${samples.at(-1).busy} busy, rss ${(samples.at(-1).rss / 1048576).toFixed(0)} MiB`);
  } catch (error) {
    samples.push({ at: Date.now(), error: error.message });
  }
}
// Let the last run finish.
await new Promise((resolve) => setTimeout(resolve, 90_000));

const rows = fs.readFileSync(path.join(home, "turns.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.source === "job");
const lines = [];
let pass = true;
const minutesPerRun = /^\*\/(\d+) /.exec(CRON)?.[1] ? Number(/^\*\/(\d+) /.exec(CRON)[1]) : CRON.startsWith("* ") ? 1 : 15;
const expected = Math.floor((HOURS * 60) / minutesPerRun);
const perAgent = [];
for (const bot of bots) {
  const mine = rows.filter((row) => row.botId === bot.id);
  const ok = mine.filter((row) => row.status === "ok");
  const signedIn = ok.filter((row) => /SOAK-SIGNED-IN as /.test(row.summary));
  const slowest = Math.max(0, ...mine.map((row) => row.durationMs || 0));
  // The first slot can fall before the agent was set up, and the last after the deadline.
  const enough = mine.length >= expected - 1;
  const clean = ok.length === mine.length && signedIn.length === ok.length;
  if (!enough || !clean) pass = false;
  perAgent.push(`| ${bot.name} | ${mine.length} | ${ok.length} | ${mine.length - ok.length} | ${signedIn.length} | ${slowest < 1000 ? `${slowest} ms` : `${(slowest / 1000).toFixed(1)} s`} |`);
}
const rss = samples.filter((item) => item.rss).map((item) => item.rss / 1048576);
const errors = samples.filter((item) => item.error);
if (stuckSeen.size || errors.length) pass = false;
lines.push(`# Soak test, ${new Date(startedAt).toISOString().slice(0, 10)}`, "");
lines.push(`Result: **${pass ? "pass" : "fail"}**.`, "");
lines.push(`${AGENTS} agents on the scripted model, one routine each on \`${CRON}\` (server time ${Intl.DateTimeFormat().resolvedOptions().timeZone}), from ${new Date(startedAt).toISOString()} to ${new Date(deadline).toISOString()} (${HOURS} h). Each run opens a page in the agent's own browser that says whether the browser is still signed in from the one sign-in at the start. Real scheduler, turn engine, ledger and Playwright Chromium; only the model is scripted. Script: \`scripts/soak.mjs\`.`, "");
lines.push(`Expected about ${expected} runs per agent.`, "");
lines.push("| Agent | Runs | OK | Failed | Still signed in | Slowest run |", "|---|---|---|---|---|---|", ...perAgent, "");
lines.push(`- Turns busy past ${STUCK_MS / 60_000} minutes: ${stuckSeen.size}${stuckSeen.size ? ` (${[...stuckSeen.values()].map((item) => item.bot).join(", ")})` : ""}.`);
lines.push(`- Server checks that failed: ${errors.length}.`);
if (rss.length) lines.push(`- Memory of the server process (it also holds the scripted model and the test page): ${Math.min(...rss).toFixed(0)} to ${Math.max(...rss).toFixed(0)} MiB, ${rss.at(-1).toFixed(0)} MiB at the end.`);
lines.push(`- Node ${process.version}, ${os.platform()} ${os.release()}, ${os.cpus().length} CPUs.`, "");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));

await new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections?.();
});
await server.services?.browser?.closeAll?.().catch?.(() => {});
await mock.close();
site.close();
process.exit(pass ? 0 : 1);
