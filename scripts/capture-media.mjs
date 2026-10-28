#!/usr/bin/env node
// Captures the README screenshots and one GIF candidate from the real product, with demo data.
//
//   node scripts/capture-media.mjs [--out docs/media] [--only shots|gif]
//
// Everything runs on loopback and is stopped at the end: a scripted model (scripts/mock-openai.js
// behind a small front that gives plain messages written replies), and a Ravnir server with a fresh
// temp data folder, a local notes vault, ai-memory off and no sign-in. Nothing here touches a real
// server or real data. All content on screen is rendered by the product from the seeded state; the
// script only drives the public HTTP API and the page, it never edits the DOM.
//
// Needs Playwright's Chromium (npm ci) and ffmpeg on PATH or at /opt/homebrew/bin/ffmpeg for the GIF.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startMock } from "./mock-openai.js";
import { STARTERS } from "../server/starters.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const outDir = path.resolve(root, option("out", "docs/media"));
const only = option("only", "all");
const ffmpeg = fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-media-"));
const videoDir = option("video-dir", "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The scripted model. Plan prompts, tool results and "call tool NAME {json}" go to the mock as they
// are; plain messages get a written reply, and "remember that ..." makes the agent call the real
// remember tool. Usage is reported the way a metered provider does, at a made-up demo price.
// ---------------------------------------------------------------------------------------------
const PRICE = { input: 0.15, output: 0.6 }; // dollars per million tokens, for the demo model only

const REPLIES = [
  [/focus on this week/i, `Here is a simple way to split the week:

- **Monday:** write down the three outcomes that matter, and block the mornings for the first one.
- **Tuesday to Thursday:** one outcome a day, with the afternoons left for messages and meetings.
- **Friday:** review what moved, and carry the rest over on purpose.

If you tell me what is on your plate, I will turn this into a real plan and hand the research to the Researcher.`],
  [/git.*(notes app|hosted)|plain markdown/i, `Short answer: plain Markdown in git is easier to keep and move, a hosted notes app is easier to share.

| | Markdown in git | Hosted notes app |
|---|---|---|
| History | Every change is a commit | Depends on the plan |
| Moving out | Copy the folder | Export, if offered |
| Sharing | Needs a remote | Built in |
| Search | Your own tools | Built in |

Which one fits depends on whether you write alone or with other people.`],
  [/shell command|count.*lines/i, `This counts the lines in every Markdown file under the current folder:

\`\`\`bash
find . -name "*.md" -not -path "./node_modules/*" -print0 | xargs -0 wc -l
\`\`\`

The last line is the total. I have not run it here, so tell me if you want me to try it in the workspace.`],
  [/inbox|email|mail/i, `Gmail is not connected yet, so I cannot read your mail. Connect it from Plugins and I will sort what needs you today from what can wait.`],
  [/remember|prefer/i, `Done. Anything else you would like me to keep in mind?`],
  [/status|summary|where/i, `Everything is quiet. The routine runs tomorrow morning, and nothing is waiting on you.`],
];

async function startModel() {
  const mock = await startMock();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const raw = Buffer.concat(chunks);
    const url = req.url || "/";
    const forward = async () => {
      const upstream = await fetch(`${mock.url.replace(/\/v1$/, "")}${url}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : raw });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    };
    if (req.method !== "POST" || !url.endsWith("/chat/completions")) return forward();
    const body = JSON.parse(raw.toString("utf8"));
    const messages = body.messages || [];
    const last = messages.at(-1);
    const first = String(messages[0]?.content || "");
    if (first.includes("Write the first thing they see") || first.includes("You choose the next action")) return forward();
    const found = [...messages].reverse().find((message) => message.role === "user");
    const user = (typeof found?.content === "string" ? found.content : "").replace(/\n\n\(You already told the user: [\s\S]*\)$/, "");
    if (last?.role === "tool") {
      const name = String(last.tool_call_id || "").replace(/^call_tool_/, "");
      if (name === "remember") return reply(res, messages, "Saved to your profile note in the vault. I will use it from now on.");
      if (name === "log_activity") return reply(res, messages, "Logged in today's note.");
      return forward();
    }
    if (/^call tool /i.test(user)) return forward();
    // The server adds notes for the model in parentheses after the user's words (the reply language); they are not part of the fact.
    const remember = /^remember that (.+?)(?:\s*\n\s*\(|$)/is.exec(user.trim());
    const tool = (body.tools || []).find((item) => item.function?.name === "remember" && item.function.parameters?.properties?.fact);
    if (remember && tool) {
      writeStream(res, messages, [
        chunk({ tool_calls: [{ index: 0, id: "call_tool_remember", type: "function", function: { name: "remember", arguments: JSON.stringify({ fact: remember[1].trim().replace(/\.$/, ""), type: "preference", key: "answer-style" }) } }] }),
        chunk({}, "tool_calls"),
      ]);
      return;
    }
    const logTool = (body.tools || []).find((item) => item.function?.name === "log_activity");
    if (/^log what you just did/i.test(user.trim()) && logTool) {
      writeStream(res, messages, [
        chunk({ tool_calls: [{ index: 0, id: "call_tool_log_activity", type: "function", function: { name: "log_activity", arguments: JSON.stringify({ action: "Compared Markdown in git with a hosted notes app", status: "ok" }) } }] }),
        chunk({}, "tool_calls"),
      ]);
      return;
    }
    const written = REPLIES.find(([pattern]) => pattern.test(user));
    return written ? reply(res, messages, written[1]) : forward();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      await mock.close();
    },
  };
}

function chunk(delta, finish) {
  return { choices: [{ index: 0, delta, finish_reason: finish || null }] };
}

function reply(res, messages, text) {
  const words = text.match(/\S+\s*|\n+/g) || [text];
  writeStream(res, messages, [...words.map((word) => chunk({ content: word })), chunk({}, "stop")], text);
}

function writeStream(res, messages, events, text = "") {
  const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
  const completionTokens = Math.max(12, Math.ceil(text.length / 4));
  const cost = (promptTokens * PRICE.input + completionTokens * PRICE.output) / 1e6;
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, cost: Number(cost.toFixed(6)) } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------------------------------------------------------------------------------------
// The server under test, and the seed.
// ---------------------------------------------------------------------------------------------
async function startServer() {
  const port = await freePort();
  const home = path.join(work, "data");
  fs.mkdirSync(home, { recursive: true });
  const fakeHome = path.join(work, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  // A clean environment: nothing from the shell's RAVNIR_* or TRUEBOT_* settings, no real HOME.
  const env = {
    PATH: process.env.PATH,
    HOME: fakeHome,
    TZ: "Europe/Madrid",
    RAVNIR_HOME: home,
    RAVNIR_HOST: "127.0.0.1",
    RAVNIR_PORT: String(port),
    RAVNIR_VAULT: "local",
    RAVNIR_AI_MEMORY: "off",
    RAVNIR_BOX: "off",
    RAVNIR_QUICK: "off",
  };
  const child = spawn(process.execPath, [path.join(root, "server/index.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  const base = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 150; tries += 1) {
    if (child.exitCode !== null) throw new Error(`The server exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/api/setup`)).ok) return { base, child, home, logs: () => log };
    } catch {}
    await sleep(200);
  }
  child.kill("SIGINT");
  throw new Error(`The server did not start:\n${log}`);
}

async function api(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function say(base, bot, text) {
  const { turnId } = await api(base, "POST", `/api/bots/${bot.id}/messages`, { text });
  for (let tries = 0; tries < 300; tries += 1) {
    const { events } = await api(base, "GET", `/api/bots/${bot.id}/events?after=0`);
    if (events.some((event) => event.type === "turn.end" && event.turnId === turnId)) return turnId;
    await sleep(150);
  }
  throw new Error(`Turn did not finish for ${bot.name}: ${text}`);
}

async function seed(base, modelUrl) {
  await api(base, "PUT", "/api/settings", { owner: { name: "Alex", language: "en" } });
  await api(base, "POST", "/api/setup/done", {});
  const model = { provider: "openai", baseUrl: modelUrl, model: "demo-model" };
  const agents = {};
  for (const [order, starter] of STARTERS.entries()) {
    const created = await api(base, "POST", "/api/bots", {
      name: starter.name,
      job: starter.job,
      prompt: starter.prompt,
      main: Boolean(starter.main),
      pinned: starter.id !== "inbox",
      pinnedOrder: order,
      ...(starter.policy ? { policy: starter.policy } : {}),
      model,
    });
    agents[starter.id] = created.bot;
  }
  await say(base, agents.chief, "What should I focus on this week?");
  await say(base, agents.researcher, "Should I keep my notes as plain Markdown in git, or in a hosted notes app?");
  await say(base, agents.engineer, "What is a shell command that counts the lines in all my Markdown files?");
  await say(base, agents.inbox, "Check my email for anything that needs me today.");
  await say(base, agents.researcher, "Log what you just did in the vault.");
  await say(base, agents.chief, "Remember that I like short answers with the conclusion first.");
  await say(base, agents.chief, "Give me a status summary.");
  await api(base, "POST", `/api/bots/${agents.chief.id}/jobs`, { name: "Morning check-in", cron: "0 8 * * 1-5", prompt: "Give me a status summary." });
  return agents;
}

// ---------------------------------------------------------------------------------------------
// Pages.
// ---------------------------------------------------------------------------------------------
const NO_CARET = "* { caret-color: transparent !important; } *::selection { background: transparent; }";

async function settle(page, extra = 900) {
  await page.addStyleTag({ content: NO_CARET });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("#net-bar:not([hidden])"), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(extra);
}

async function open(page, base, query) {
  await page.goto(`${base}/${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Number(document.getElementById("bot-count")?.textContent) > 0, null, { timeout: 15000 });
}

async function shots(browser, base, agents) {
  const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
  const light = await browser.newContext({ ...desktop, colorScheme: "light" });
  const dark = await browser.newContext({ ...desktop, colorScheme: "dark" });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const save = (page, name) => page.screenshot({ path: path.join(outDir, name) });

  let page = await light.newPage();
  await open(page, base, "?view=today");
  await page.waitForSelector(".home, #today-view:not([hidden])", { timeout: 10000 });
  await settle(page, 1500);
  await save(page, "home.png");

  await open(page, base, `?bot=${agents.chief.id}`);
  await page.waitForSelector(".cost-line", { timeout: 10000 });
  await settle(page, 600);
  const lines = page.locator(".cost-line");
  const count = await lines.count();
  // The last reply, so the opened breakdown sits at the bottom of the thread: scrolled up, the
  // thread shows its Latest button over the text.
  const target = lines.nth(count - 1);
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.waitForTimeout(500);
  await page.locator(".proof-panel").last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await save(page, "thread-cost.png");

  await open(page, base, "?view=memory");
  await page.waitForSelector(".mem-entry", { timeout: 10000 });
  await settle(page, 600);
  await page.locator(".mem-entry-open").first().click();
  await page.waitForSelector("dialog[open] .mem-diff", { timeout: 10000 });
  await page.waitForTimeout(800);
  await save(page, "memory.png");
  await light.close();

  page = await dark.newPage();
  await open(page, base, "?view=today");
  await page.waitForSelector(".home, #today-view:not([hidden])", { timeout: 10000 });
  await settle(page, 1500);
  await save(page, "home-dark.png");
  await dark.close();

  page = await phone.newPage();
  await open(page, base, `?bot=${agents.chief.id}`);
  await page.waitForSelector(".chat-row", { timeout: 10000 });
  await settle(page, 1200);
  await save(page, "phone-thread.png");
  await phone.close();
}

async function gif(browser, base, agents) {
  const videos = videoDir ? path.resolve(videoDir) : path.join(work, "video");
  fs.mkdirSync(videos, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    recordVideo: { dir: videos, size: { width: 1440, height: 900 } },
  });
  const born = Date.now();
  const page = await context.newPage();
  await open(page, base, `?bot=${agents.chief.id}`);
  await page.waitForSelector(".chat-row", { timeout: 10000 });
  await settle(page, 800);
  const start = (Date.now() - born) / 1000;
  await page.waitForTimeout(800);
  const input = page.locator("#composer-input");
  await input.click();
  await page.keyboard.type("Remember that my week starts on Monday and I like plain-text summaries.", { delay: 40 });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".chat-row")].some((row) => /Saved to your profile note/.test(row.textContent || "")), null, { timeout: 30000 });
  await page.waitForTimeout(2600);
  await page.locator("#memory-nav").click();
  await page.waitForSelector(".mem-entry", { timeout: 10000 });
  await page.waitForTimeout(2200);
  await page.locator(".mem-entry-open").first().click();
  await page.waitForSelector("dialog[open] .mem-diff", { timeout: 10000 });
  await page.waitForTimeout(4000);
  const end = (Date.now() - born) / 1000;
  const video = page.video();
  await context.close();
  const webm = await video.path();
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "memory-demo.gif");
  const filter = "fps=13,scale=960:-1:flags=lanczos";
  const run = spawnSync(ffmpeg, [
    "-y", "-ss", start.toFixed(2), "-t", (end - start).toFixed(2), "-i", webm,
    "-filter_complex", `[0:v]${filter},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    "-loop", "0", out,
  ], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed:\n${run.stderr.slice(-1500)}`);
  return { out, seconds: end - start, webm };
}

// ---------------------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const model = await startModel();
  let server;
  let browser;
  try {
    server = await startServer();
    const agents = await seed(server.base, model.url);
    browser = await chromium.launch();
    if (only === "all" || only === "shots") await shots(browser, server.base, agents);
    if (only === "all" || only === "gif") {
      const made = await gif(browser, server.base, agents);
      console.log(`GIF: ${made.out} (${made.seconds.toFixed(1)} s of video)`);
    }
    console.log(`Wrote ${outDir}`);
  } finally {
    await browser?.close().catch(() => {});
    if (server?.child && server.child.exitCode === null) {
      server.child.kill("SIGINT");
      await Promise.race([new Promise((resolve) => server.child.once("exit", resolve)), sleep(8000)]);
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }
    await model.close().catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
