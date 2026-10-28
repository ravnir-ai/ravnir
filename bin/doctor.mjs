#!/usr/bin/env node
// `npm run doctor` (or `./install.sh doctor`, which runs this inside the container). Asks the
// running server for its checks (GET /api/doctor) and prints a report you can paste into an issue.
// When nothing answers, it says so and runs the checks that need no server. Exit code 1 on a failure.
//   node bin/doctor.mjs [--json] [--no-browser]
import "../server/env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserCheck, desktopCheck, diskCheck, formatReport, nodeCheck, which } from "../server/doctor.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const port = Number(process.env.RAVNIR_PORT) || 3847;
const home = process.env.RAVNIR_HOME || path.join(root, "data");

const headers = {};
if (process.env.RAVNIR_USER && process.env.RAVNIR_PASSWORD) {
  headers.authorization = `Basic ${Buffer.from(`${process.env.RAVNIR_USER}:${process.env.RAVNIR_PASSWORD}`).toString("base64")}`;
}

async function fromServer() {
  const query = args.has("--no-browser") ? "?browser=0" : "";
  const response = await fetch(`http://127.0.0.1:${port}/api/doctor${query}`, { headers, signal: AbortSignal.timeout(90_000) });
  if (response.status === 401) throw Object.assign(new Error("The server asked for sign-in. Run this where RAVNIR_USER and RAVNIR_PASSWORD are set."), { auth: true });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return response.json();
}

async function offline(reason) {
  const checks = [
    { id: "server", title: "Server", status: "fail", detail: reason, fix: "Start it: npm start, or ./install.sh" },
    nodeCheck(),
    diskCheck(home),
  ];
  if (!args.has("--no-browser")) checks.push(await browserCheck());
  checks.push(desktopCheck());
  const opencode = process.env.RAVNIR_OPENCODE_BIN || which("opencode");
  checks.push(opencode
    ? { id: "opencode", title: "OpenCode", status: "ok", detail: "Installed." }
    : { id: "opencode", title: "OpenCode", status: "warn", detail: "Not installed here.", fix: "npm install -g opencode-ai, or connect another OpenCode in Settings > Models." });
  return { ok: false, version: "", at: new Date().toISOString(), checks };
}

let report;
try {
  report = await fromServer();
} catch (error) {
  if (error.auth) {
    console.error(error.message);
    process.exit(1);
  }
  report = await offline(`Nothing answers on 127.0.0.1:${port} (${error.cause?.code || error.message}).`);
}
console.log(args.has("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.ok ? 0 : 1);
