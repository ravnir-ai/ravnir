import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { memoryRead, memoryWrite, searchMemory } from "./aiMemory.js";
import { ARTIFACT_TOOLS, artifactToolDefinitions, callArtifactTool } from "./artifacts.js";
import { callVaultTool, selectMemoryTools, vaultToolDefinitions, vaultWriteToolDefinitions } from "./vault/tools.js";
import { callCollaborationTool, collaborationToolDefinitions, resolveBot } from "./collaboration.js";
import { browserDriver, DEFAULT_STEPS as BROWSER_STEPS, MAX_STEPS as BROWSER_MAX } from "./computerUse.js";
import { chooseNext, chooserFor } from "./chooser.js";
import { driveTask, nextStep, startSteps } from "./drive.js";
import { desktopToolsAvailable, ocrAvailable } from "./desktop.js";
import { desktopDriver, DEFAULT_STEPS as DESKTOP_STEPS, MAX_STEPS as DESKTOP_MAX } from "./desktopUse.js";
import { chooseWithJev } from "./jev.js";
import { createJob, describeSchedule, formatRunTime, updateJob } from "./jobs.js";
import { askUserToTakeOver, handedOverReply, TAKEOVER_TOOL } from "./live.js";
import { ASK_TOOL, askUser } from "./asks.js";
import { proactiveToolDefinitions } from "./proposals.js";
import { findPlugins, findSkills, recommendToolDefinitions, suggestPlugin, suggestSkill } from "./recommend.js";
import { callDocumentTool, documentToolDefinitions } from "./documents.js";
import { callReadDocument, readDocumentToolDefinitions } from "./readDocument.js";
import { attachedTo, readSkill } from "./skills.js";
import { fetchPageWithFallback, searchMarket, topActions, webResearch, webSearch } from "./web.js";
import { resolveInside, writeFile, listDir } from "./workspace.js";
import { ownerOf, ownerPossessive } from "./owner.js";

const MAX_OUTPUT = 200_000;
// Tools that drive the agent's one browser tab. web_search and web_research use a
// scratch tab instead, and web_fetch takes the lock itself only when it needs the page.
const PAGE_TOOLS = new Set([
  "browser_open", "browser_read", "browser_click", "browser_type", "browser_key",
  "browser_smart_click", "browser_saved_login", "computer_task", "computer_step",
]);
const SAFE_ENV = ["PATH", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "TZ", "USER"];

export async function listTree(root, relative = "", depth = 0) {
  const { abs, rel } = await resolveInside(root, relative || ".");
  if (depth > 5) return [];
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const childPath = rel === "." ? entry.name : path.posix.join(rel.split(path.sep).join("/"), entry.name);
    let size = 0;
    try {
      if (entry.isFile()) size = (await fs.stat(path.join(abs, entry.name))).size;
    } catch {
      // Ignore a racing delete.
    }
    out.push({
      name: entry.name,
      path: childPath,
      type: entry.isDirectory() ? "dir" : "file",
      size,
      depth,
    });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return out.slice(0, 500);
}

export async function readWorkspaceFile(root, relative) {
  const { abs, rel } = await resolveInside(root, relative);
  const data = await fs.readFile(abs);
  if (data.includes(0)) throw new Error("That file looks binary.");
  if (data.length > 500_000) throw new Error("That file is too large to open here.");
  return { path: rel, content: data.toString("utf8") };
}

export async function writeWorkspaceFile(root, relative, content) {
  return writeFile(root, relative, String(content ?? ""));
}

export async function runCommand(root, command, { timeout = 90_000, home = root, cwd = root, env: extraEnv = {} } = {}) {
  checkCommand(command);
  const env = commandEnv(root, { home, cwd, env: extraEnv });
  const shell = process.env.SHELL || "/bin/sh";
  const child = spawn(shell, ["-lc", command], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collectOutput(child, timeout);
}

// A bot with its own computer runs the command there, as root; any other bot
// runs it on this server, in its workspace, with its persistent home.
// `env` is extra variables for this command only (a plugin's login, see plugins.js).
export function runBotCommand(bot, command, { workspace, browser, timeout, env = {} } = {}) {
  if (browser?.box?.uses(bot)) return browser.box.exec(bot, command, { timeout, env });
  return runCommand(workspace, command, {
    home: path.dirname(workspace),
    env: { ...(browser?.desktopEnv(bot) || {}), ...env },
    ...(timeout ? { timeout } : {}),
  });
}

export function checkCommand(command) {
  if (typeof command !== "string" || !command.trim()) throw new Error("Enter a command.");
  if (command.length > 20_000) throw new Error("That command is too long.");
}

// The environment of a command on the host: the bot's persistent home, its
// user-level tool folders on PATH, and nothing else from the server's env.
export function commandEnv(root, { home = root, cwd = root, env: extraEnv = {} } = {}) {
  const env = {};
  for (const key of SAFE_ENV) if (process.env[key]) env[key] = process.env[key];
  const bin = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".bun", "bin"),
  ];
  env.HOME = home;
  env.RAVNIR_WORKSPACE = root;
  env.RAVNIR_BOX_HOME = home;
  // The names from before the rename, for scripts agents already wrote.
  env.TRUEBOT_WORKSPACE = root;
  env.TRUEBOT_BOX_HOME = home;
  env.PWD = cwd;
  env.PATH = [...bin, process.env.PATH || "/usr/local/bin:/usr/bin:/bin"].join(path.delimiter);
  env.NPM_CONFIG_PREFIX = path.join(home, ".npm-global");
  env.PIP_USER = "1";
  env.UV_TOOL_BIN_DIR = path.join(home, ".local", "bin");
  env.UV_TOOL_DIR = path.join(home, ".local", "share", "uv", "tools");
  env.CARGO_HOME = path.join(home, ".cargo");
  env.GOPATH = path.join(home, "go");
  env.BUN_INSTALL = path.join(home, ".bun");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (typeof value === "string" && value) env[key] = value;
  }
  for (const dir of bin) fs.mkdir(dir, { recursive: true }).catch(() => {});
  return env;
}

// Collects stdout and stderr of a finished command, capped, with a kill on timeout.
export function collectOutput(child, timeout) {
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    const take = (chunk) => {
      if (output.length >= MAX_OUTPUT) return;
      const text = chunk.toString();
      output += text.slice(0, MAX_OUTPUT - output.length);
      if (text.length > MAX_OUTPUT - output.length) truncated = true;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      truncated = true;
      killTree(child);
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ output: `${output}${output ? "\n" : ""}${error.message}`, code: 1, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: output || "(no output)", code: code ?? 0, truncated });
    });
  });
}

function killTree(child) {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore.
    }
  }
}

export function builtinToolDefinitions() {
  return [
    ...collaborationToolDefinitions(),
    ...proactiveToolDefinitions(),
    ...recommendToolDefinitions(),
    ...artifactToolDefinitions(),
    ...documentToolDefinitions(),
    ...readDocumentToolDefinitions(),
    {
      name: "skill_view",
      description: "Open one of your skills before you start a task it covers. Returns the full procedure and lists the files the skill ships; add file to read one of them. Your skills are listed in your prompt. It needs no approval.",
      parameters: objectSchema({
        name: { type: "string", description: "The skill's name, exactly as the list shows it." },
        file: { type: "string", description: "Optional: a file the skill ships, such as references/notes.md or scripts/check.py." },
      }, ["name"]),
    },
    {
      name: "web_search",
      description: "Search the public web for a question. Returns titles, links, and snippets. Use this first for research, then web_fetch on the best links. It needs no approval. When the engines only return pages about something else, it says so instead of listing them.",
      parameters: objectSchema({
        query: { type: "string", description: "What to search for, in natural language." },
        limit: { type: "number", description: "Maximum results, 1-20. Defaults to 8." },
      }, ["query"]),
    },
    {
      name: "web_fetch",
      description: "Read a public web page as text. It fetches quickly and falls back to your browser when a site blocks the request. Use this instead of curl, wget, or writing scripts.",
      parameters: objectSchema({ url: { type: "string", description: "http or https URL" } }, ["url"]),
    },
    {
      name: "web_research",
      description: "One-call research: search the web, open the top results, and return their text with links. Use it for a quick sourced answer on a public topic.",
      parameters: objectSchema({
        query: { type: "string", description: "The question or lookup." },
        limit: { type: "number", description: "Pages to read, 1-5. Defaults to 3." },
      }, ["query"]),
    },
    {
      name: "browser_open",
      description: "Open a URL in your own browser. Returns the page title, visible text, and a short list of fields and buttons.",
      parameters: objectSchema({ url: { type: "string", description: "http or https URL" } }, ["url"]),
    },
    {
      name: "browser_read",
      description: "Read the page that is open in your browser: URL, title, visible text, fields, and buttons.",
      parameters: objectSchema({}, []),
    },
    {
      name: "browser_click",
      description: "Click on the open page. Use selector, visible text, or screenshot coordinates.",
      parameters: objectSchema({
        selector: { type: "string", description: "CSS selector" },
        text: { type: "string", description: "Visible text of a button or link" },
        x: { type: "number" },
        y: { type: "number" },
      }, []),
    },
    {
      name: "browser_type",
      description: "Type into the focused field or a field matched by CSS selector (browser_read lists each field with one). For a dropdown, text is the option to pick; for a checkbox, yes or no. Never type a password here.",
      parameters: objectSchema({
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing." },
      }, ["text"]),
    },
    {
      name: "browser_key",
      description: "Press a key in the browser: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.",
      parameters: objectSchema({ key: { type: "string" } }, ["key"]),
    },
    {
      name: "browser_smart_click",
      description: "Pick the best visible button or link for a goal with the server's fast chooser (Jev, or a fast model), then click it. Use this for quick computer use when the next step is obvious but there are many buttons.",
      parameters: objectSchema({
        goal: { type: "string", description: "What you are trying to do on this page." },
      }, ["goal"]),
    },
    {
      name: "computer_task",
      description: "Drive your browser toward a goal, step by step. It reads the page and picks the next click, key, or field: with Jev or a fast model when this server has one, otherwise it gives you a numbered list and you answer with computer_step. Every step is saved as a screenshot and shown to the user. Use it for multi-step web tasks; pass text when the task needs typing.",
      parameters: objectSchema({
        goal: { type: "string", description: "The concrete outcome on this page." },
        text: { type: "string", description: "Text to type when a field is chosen. Omit for click-only tasks." },
        max_steps: { type: "number", description: "1 to 20 steps. Defaults to 8." },
      }, ["goal"]),
    },
    {
      name: "desktop_task",
      description: "Drive the whole Linux desktop, step by step. It captures the screen, reads it with OCR and picks the next click or key: with Jev or a fast model when this server has one, otherwise it gives you a numbered list and you answer with computer_step. Use it for native apps, dialogs, installers, or any window that is not the browser. Pass text after focusing a field.",
      parameters: objectSchema({
        goal: { type: "string", description: "The concrete outcome on the desktop." },
        text: { type: "string", description: "Text to type into the focused field. Omit for click-only tasks." },
        max_steps: { type: "number", description: "1 to 12 steps. Defaults to 5." },
      }, ["goal"]),
    },
    {
      name: "computer_step",
      description: "Take the next step of the computer_task or desktop_task you started: give the number of the action from the list it showed you. It acts, saves a screenshot, and shows the next list. Pick DONE when the goal is complete and STOP when this screen cannot get there.",
      parameters: objectSchema({
        step: { type: "number", description: "The step number shown with the list you picked from." },
        action: { type: "number", description: "The number of the action to take, from that list." },
      }, ["step", "action"]),
    },
    TAKEOVER_TOOL,
    ASK_TOOL,
    {
      name: "jev_choose",
      description: "Ask Jev, a fast 0-4 decision model, to rank options for a goal. Returns scores and the best option. Use it for quick classification and next-step choices.",
      parameters: objectSchema({
        goal: { type: "string" },
        state: { type: "string", description: "Short context Jev should read. Plain text." },
        options: { type: "array", items: { type: "string" }, description: "2 to 24 options." },
      }, ["goal", "options"]),
    },
    {
      name: "browser_saved_login",
      description: "Sign in to a site with a saved login. The password is filled on the server and is never returned to you.",
      parameters: objectSchema({ site: { type: "string", description: "Site name, host, or URL from the saved logins list" } }, ["site"]),
    },
    {
      name: "list_saved_logins",
      description: "List saved logins. Returns site, username, and label only. It never returns passwords.",
      parameters: objectSchema({}, []),
    },
    {
      name: "remember",
      description: "Save a durable fact to your memory. Keep it short and factual.",
      parameters: objectSchema({ text: { type: "string" } }, ["text"]),
    },
    ...vaultToolDefinitions(),
    {
      name: "memory_search",
      description: "Search the shared ai-memory wiki for past decisions, facts, gotchas, and handoffs. Use it before answering questions about earlier work.",
      parameters: objectSchema({
        query: { type: "string" },
        limit: { type: "number", description: "Maximum hits, 1-20. Defaults to 8." },
      }, ["query"]),
    },
    {
      name: "memory_write",
      description: "Write a durable page to the shared ai-memory wiki. Use it for decisions, gotchas, procedures, and facts that should survive this conversation.",
      parameters: objectSchema({
        path: { type: "string", description: "Optional wiki path such as decisions/launch-date.md." },
        title: { type: "string" },
        body: { type: "string", description: "Markdown body." },
        kind: { type: "string", description: "fact, rule, decision, or gotcha." },
      }, ["body"]),
    },
    {
      name: "memory_read",
      description: "Read the full body of one page from the shared ai-memory wiki.",
      parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    },
    {
      name: "list_jobs",
      description: "List scheduled jobs: yours by default, or another agent's or all of them with bot. Each row has the id, name, schedule in plain words, next run, whether it is enabled or paused, and who set it.",
      parameters: objectSchema({
        bot: { type: "string", description: "Optional: another agent's name or id, or all for every agent's jobs. Read-only for others: you can only change your own jobs with update_job and delete_job." },
      }, []),
    },
    {
      name: "create_job",
      description: "Schedule something for yourself. Create schedules yourself whenever the user asks for a reminder, a recurring check, or something later; never ask them for cron. Use `at` (ISO 8601 with a UTC offset, for example 2026-10-24T09:00:00+02:00) for a one-time run and a five-field cron expression for a repeating one; give exactly one of the two. The server time zone is in the system prompt. It runs on this server even when no browser is open, and its result reaches the user's phone. In `prompt`, say what to do or what to tell the user. Setting up the schedule is the task; do not run it now unless asked. If a job already does this (see list_jobs), update it instead.",
      parameters: objectSchema({
        name: { type: "string", description: "Short title, for example Stand-up reminder" },
        prompt: { type: "string", description: "What to do when the job runs. For a reminder, say what to tell the user." },
        at: { type: "string", description: "One-time run: ISO 8601 date and time with a UTC offset. Must be in the future and within 400 days." },
        cron: { type: "string", description: "Repeating run: five-field cron (minute hour day month weekday) in the server time zone. Example: 0 8 * * 1-5 for weekdays at 08:00." },
        notify: { type: "boolean", description: "Send the result to the user's phone. Defaults to true." },
      }, ["name", "prompt"]),
    },
    {
      name: "update_job",
      description: "Change one of your scheduled jobs: its name, instruction, schedule, or whether it is enabled. Give `at` or `cron` (not both) to reschedule; switching between one-time and repeating is fine. Setting a new schedule on a one-time job that already ran arms it again.",
      parameters: objectSchema({
        id: { type: "string", description: "Job id from list_jobs (the first characters are enough)." },
        name: { type: "string" },
        prompt: { type: "string" },
        at: { type: "string", description: "New one-time run: ISO 8601 with a UTC offset." },
        cron: { type: "string", description: "New repeating schedule: five-field cron." },
        enabled: { type: "boolean", description: "false pauses the job, true resumes it." },
      }, ["id"]),
    },
    {
      name: "delete_job",
      description: "Delete one of your scheduled jobs by id.",
      parameters: objectSchema({ id: { type: "string" } }, ["id"]),
    },
    {
      name: "run_command",
      description: "Run a shell command in your workspace on this server. Your home is persistent: npm, pip, uv, cargo, and bun installs go to your own home and stay available next turn.",
      parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    },
    {
      name: "box_info",
      description: "Show the tools, package managers, writable home, and disk space on your computer.",
      parameters: objectSchema({}, []),
    },
    {
      name: "list_files",
      description: "List files in your workspace.",
      parameters: objectSchema({ path: { type: "string" } }, []),
    },
    ...macToolDefinitions(),
  ];
}

// The user's Mac, reached through the runner on it (server/macNode.js). These run on the Mac, not on this server.
export function macToolDefinitions() {
  return [
    {
      name: "mac_status",
      description: "Say whether the user's Mac is online and which folders on it you can work in.",
      parameters: objectSchema({}, []),
    },
    {
      name: "mac_run",
      description: "Run a shell command on the user's Mac (zsh, as their user). cwd defaults to ~/Desktop/Projects; ~ works. Use it for their real projects, git, tests and files on the Mac. Fails plainly when the Mac is offline.",
      parameters: objectSchema({ command: { type: "string" }, cwd: { type: "string" } }, ["command"]),
    },
    {
      name: "mac_read_file",
      description: "Read a text file on the user's Mac. Paths may start with ~.",
      parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    },
    {
      name: "mac_write_file",
      description: "Write a whole text file on the user's Mac (creates folders). Read it first when changing an existing file.",
      parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    },
    {
      name: "mac_list",
      description: "List a folder on the user's Mac. Defaults to ~/Desktop/Projects.",
      parameters: objectSchema({ path: { type: "string" } }, []),
    },
  ];
}

export async function callBuiltinTool(name, args, ctx) {
  const { bot, home, browser, secrets, save, runJob } = ctx;
  // While the user has the browser (Sign in yourself), no tool touches it.
  const held = handedOverReply(name, { browser, bot });
  if (held) return held;
  // One tool on the agent's page at a time: a model may call several at once.
  if (PAGE_TOOLS.has(name) && browser?.exclusive && !ctx.pageLocked) {
    return browser.exclusive(bot.id, () => callBuiltinTool(name, args, { ...ctx, pageLocked: true }));
  }
  if (name === TAKEOVER_TOOL.name) return askUserToTakeOver(args, ctx);
  if (name === ASK_TOOL.name) return askUser(args, ctx);
  if (name === "skill_view") {
    const opened = readSkill(args.name, { bot, file: args.file, provider: bot.model?.provider });
    return { text: opened.text, activity: `Reading the skill: ${opened.name}${opened.file ? ` (${opened.file})` : ""}` };
  }
  if (vaultToolNames().has(name) && (name !== "remember" || ctx.vaultWriter?.available)) {
    return callVaultTool(name, args, { vault: ctx.vault, writer: ctx.vaultWriter, bot });
  }
  if (name === "web_search") {
    const result = await webSearch(String(args.query || ""), { limit: Number(args.limit) || 8, browser, bot, market: searchMarket(ownerOf(ctx.state)) });
    return { text: result.text, activity: `Searching the web: ${args.query}` };
  }
  if (name === "web_fetch") {
    const page = await fetchPageWithFallback(String(args.url || ""), { browser, bot });
    const header = [
      `URL: ${page.url}`,
      page.title ? `Title: ${page.title}` : "",
      page.via === "browser" && !page.blocked ? "Read with the browser because the site blocked a direct request." : "",
      page.blocked && page.via !== "browser" ? "The site blocked a direct read. Try opening it with browser_open." : "",
      "",
    ].filter(Boolean).join("\n");
    return { text: `${header}\n${page.text}`, activity: `Reading ${page.title || page.url}` };
  }
  if (name === "web_research") {
    const result = await webResearch(String(args.query || ""), { limit: Math.min(5, Math.max(1, Number(args.limit) || 3)), browser, bot, market: searchMarket(ownerOf(ctx.state)) });
    return { text: result.text, activity: `Researching: ${args.query}` };
  }
  if (name === "browser_open") {
    const session = await browser.ensure(bot);
    const status = await session.navigate(String(args.url || ""));
    const page = await session.read();
    return { text: formatPage(status, page), activity: `Browsing ${status.title || status.url}` };
  }
  if (name === "browser_read") {
    const session = await browser.ensure(bot);
    const page = await session.read();
    return { text: formatPage(page, page), activity: page.title ? `Reading ${page.title}` : "Reading the page" };
  }
  if (name === "browser_click") {
    const session = await browser.ensure(bot);
    let note = "";
    if (args.selector) await session.clickSelector(String(args.selector));
    else if (args.text) {
      const point = await session.evaluate(findClickTarget(String(args.text)));
      if (!point) throw new Error(`No button or link matching "${args.text}".`);
      if (point.hidden) {
        // Only a copy in a closed menu matches: clicking it would hit nothing, so open where it points.
        await session.navigate(point.href);
        note = "The matching link was hidden (a closed menu); opened its address instead.";
      } else {
        const before = session.status().url;
        await session.click(point.x, point.y);
        const after = session.status().url;
        // Something on top (a cookie banner, an overlay) took the click, so the link never got it.
        // A link the page handles with a script, or a download, is never opened by hand: that
        // could skip the page's own check or do the action twice.
        if (point.covered && point.href && after === before && point.href.split("#")[0] !== before.split("#")[0]) {
          if (point.scripted) {
            note = `Something on top of the link took the click and the page did not change. The link points to ${point.href}; close what covers it, or open that address with browser_open if that is safe.`;
          } else {
            await session.navigate(point.href);
            note = "Something on top of the link took the click; opened its address instead.";
          }
        }
      }
    } else if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
      await session.click(Number(args.x), Number(args.y));
    } else {
      throw new Error("browser_click needs selector, text, or x and y.");
    }
    const page = await session.read();
    return { text: `${note ? `Clicked. ${note}` : "Clicked."}\n${formatPage(page, page)}`, activity: "Clicking in the browser" };
  }
  if (name === "browser_type") {
    const session = await browser.ensure(bot);
    if (args.selector) await session.typeSelector(String(args.selector), String(args.text ?? ""));
    else await session.typeText(String(args.text ?? ""));
    if (args.submit) await session.key("Enter");
    return { text: "Typed.", activity: "Typing in the browser" };
  }
  if (name === "browser_key") {
    const session = await browser.ensure(bot);
    await session.key(String(args.key || "Enter"));
    return { text: `Pressed ${args.key || "Enter"}.`, activity: "Pressing a key" };
  }
  if (name === "browser_smart_click") {
    const session = await browser.ensure(bot);
    const page = await session.read();
    const actions = topActions((page.buttons || []).filter((button) => button.text && button.selector), 24);
    if (!actions.length) throw new Error("There are no buttons or links to choose from on this page.");
    if (actions.length === 1) {
      await session.clickSelector(actions[0].selector);
      const after = await session.read();
      return { text: `Only one action: clicked "${actions[0].text}".\n${formatPage(after, after)}`, activity: `Clicking ${actions[0].text}` };
    }
    const options = actions.map((button) => `${button.text}${button.href ? ` -> ${button.href}` : ""}`);
    const chooser = chooserFor(bot);
    if (chooser.mode === "agent") throw new Error("This server has no fast chooser. Read the page with browser_read and click with browser_click.");
    const picked = await chooseNext(chooser, {
      goal: String(args.goal || "Move forward on this page."),
      state: {
        url: page.url,
        title: page.title,
        page: String(page.text || "").slice(0, 3000),
      },
      options,
      tag: "browser",
      signal: ctx.engine?.active?.get(bot.id)?.abort?.signal,
    });
    const action = actions[picked.best.index];
    if (!action) throw new Error("The chooser picked an action that is no longer on the page.");
    await session.clickSelector(action.selector);
    const after = await session.read();
    const by = chooser.mode === "jev" ? "Jev" : "The model";
    return {
      text: `${by} picked "${picked.best.choice}" (${picked.best.score}/4).\n${formatPage(after, after)}\n\nRanked:\n${picked.ranked.slice(0, 5).map((row) => `- ${row.score}/4 ${row.choice}`).join("\n")}`,
      activity: `Choosing with ${chooser.mode === "jev" ? "Jev" : "a fast model"}: ${action.text}`,
      usage: picked.usage,
    };
  }
  if (name === "computer_task" || name === "desktop_task") {
    const kind = name === "computer_task" ? "browser" : "desktop";
    const goal = String(args.goal || "").replace(/\s+/g, " ").trim();
    if (!goal) throw new Error(`${name} needs a goal.`);
    const [fallback, max] = kind === "browser" ? [BROWSER_STEPS, BROWSER_MAX] : [DESKTOP_STEPS, DESKTOP_MAX];
    const maxSteps = Math.min(max, Math.max(1, Number(args.max_steps) || fallback));
    const driver = await computerDriver(kind, bot, ctx, { goal, text: String(args.text || "") });
    const chooser = chooserFor(bot);
    const emit = (event) => ctx.emit?.(event);
    const where = kind === "browser" ? "the browser" : "the desktop";
    if (chooser.mode === "agent") {
      const result = await startSteps({ bot, driver, goal, text: String(args.text || ""), maxSteps, emit });
      return { text: result.text, activity: `Looking at ${where}` };
    }
    const result = await driveTask({ driver, goal, maxSteps, chooser, signal: ctx.engine?.active?.get(bot.id)?.abort?.signal, emit });
    return { text: result.text, activity: `Driving ${where}${chooser.mode === "jev" ? " with Jev" : ""}`, usage: result.usage };
  }
  if (name === "computer_step") {
    const result = await nextStep({
      bot,
      pick: args.action,
      step: args.step,
      driverFor: (kind, options) => computerDriver(kind, bot, ctx, options),
      emit: (event) => ctx.emit?.(event),
    });
    return { text: result.text, activity: "Taking the next step" };
  }
  if (name === "jev_choose") {
    const options = Array.isArray(args.options) ? args.options : [];
    const result = await chooseWithJev({
      goal: String(args.goal || ""),
      state: { context: String(args.state || "").slice(0, 12_000) },
      options,
      tag: "tool",
    });
    return {
      text: `Best: ${result.best.choice} (${result.best.score}/4)\n${result.ranked.map((row) => `- ${row.score}/4 ${row.choice}`).join("\n")}\nJev input tokens: ${result.tokens} ($${result.cost.toFixed(6)})`,
      activity: "Asking Jev to decide",
    };
  }
  if (name === "browser_saved_login") {
    const entry = findLogin(bot, String(args.site || ""));
    if (!entry) throw new Error(`No saved login matches "${args.site}". Ask the user to save it on this computer.`);
    const password = ctx.passwordFor ? await ctx.passwordFor(bot, entry) : secrets.get(`vault:${bot.id}:${entry.id}`);
    if (!password) throw new Error("That saved login has no password on this server.");
    const session = await browser.ensure(bot);
    const result = await session.login({ ...entry, password });
    if (result.alreadySignedIn) {
      return {
        text: `Already signed in to ${entry.site}: it opened ${result.status.title || "the site"} at ${result.status.url} with no sign-in form. Nothing was typed.`,
        activity: `Checking ${entry.site}`,
      };
    }
    entry.lastUsedAt = Date.now();
    save();
    return { text: `Signed in to ${entry.site} as ${entry.username || "the saved user"}. ${result.status.url}`, activity: `Signing in to ${entry.site}` };
  }
  if (name === "list_saved_logins") {
    const rows = bot.vault.map((entry) => `- ${entry.site}${entry.username ? ` as ${entry.username}` : ""}${entry.label ? ` (${entry.label})` : ""}${entry.source === "1password" ? " [1Password]" : ""}`);
    return { text: rows.length ? rows.join("\n") : "No saved logins." };
  }
  if (name === "remember") {
    const text = String(args.text || "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (!text) throw new Error("Memory text is empty.");
    if (!bot.memory.some((item) => item.text.toLowerCase() === text.toLowerCase())) {
      bot.memory.push({ id: crypto.randomUUID(), text, at: Date.now(), source: "bot" });
      bot.memory = bot.memory.slice(-80);
      save();
    }
    return { text: `Remembered: ${text}`, activity: "Saving a note" };
  }
  if (name === "list_jobs") {
    const which = String(args.bot || "").trim();
    if (!which) {
      const rows = bot.jobs.map((job) => jobRow(job, true));
      return { text: rows.length ? rows.join("\n") : "No scheduled jobs." };
    }
    // Other agents' routines, read-only, so a coordinator can see the whole schedule before it plans.
    const bots = ctx.state?.bots || [bot];
    if (which.toLowerCase() === "all") {
      const blocks = bots.filter((item) => item.jobs?.length).map((item) => {
        const own = item.id === bot.id;
        return [`## ${item.name}${own ? " (you)" : ""}`, ...item.jobs.map((job) => jobRow(job, own))].join("\n");
      });
      const none = bots.filter((item) => !item.jobs?.length).map((item) => item.name);
      return { text: [...blocks, none.length ? `No jobs: ${none.join(", ")}` : ""].filter(Boolean).join("\n\n") || "No scheduled jobs." };
    }
    const target = resolveBot({ bots }, which);
    if (!target) return { text: `No agent matches "${which}". Use list_bots.` };
    const own = target.id === bot.id;
    const rows = (target.jobs || []).map((job) => jobRow(job, own));
    return { text: rows.length ? `${target.name}${own ? " (you)" : ""}\n${rows.join("\n")}` : `${target.name} has no scheduled jobs.` };
  }
  if (name === "create_job") {
    const job = createJob({ name: args.name, prompt: args.prompt, cron: args.cron, at: args.at, notify: args.notify, createdBy: "bot" });
    bot.jobs.push(job);
    save();
    // A second job at the same time is usually a duplicate of a paused one the agent forgot.
    const twins = bot.jobs.filter((item) => item !== job && !item.done && ((job.cron && item.cron === job.cron) || (job.at && item.at === job.at)));
    const twinNote = twins.length
      ? `\nNote: you already have ${twins.map((item) => `"${item.name}" (${item.id.slice(0, 8)}, ${item.enabled ? "enabled" : "paused"})`).join(", ")} at the same time. If it does the same thing, delete one with delete_job.`
      : "";
    return { text: `Scheduled "${job.name}": ${describeSchedule(job)}. ${nextRunSentence(job)}${twinNote}`, activity: `Scheduling ${job.name}` };
  }
  if (name === "update_job") {
    const job = findJob(bot, args.id);
    updateJob(job, { name: args.name, prompt: args.prompt, cron: args.cron, at: args.at, enabled: args.enabled });
    save();
    const tail = job.done ? "It already ran." : job.enabled ? nextRunSentence(job) : "It is paused.";
    return { text: `Updated "${job.name}": ${describeSchedule(job)}. ${tail}`, activity: `Updating ${job.name}` };
  }
  if (name === "delete_job") {
    const job = findJob(bot, args.id);
    bot.jobs.splice(bot.jobs.indexOf(job), 1);
    save();
    return { text: `Deleted job "${job.name}".` };
  }
  if (name === "run_command") {
    const result = await runBotCommand(bot, String(args.command || ""), { workspace: ctx.workspace, browser: ctx.browser, env: ctx.plugins?.shellEnvFor(bot) });
    // The output goes to the model: a plugin token echoed by the command is masked.
    const output = ctx.plugins ? ctx.plugins.maskShellSecrets(bot, result.output) : result.output;
    return { text: `$ ${args.command}\n${output}${result.truncated ? "\n[truncated]" : ""}\n[exit ${result.code}]`, activity: "Running a command" };
  }
  if (name.startsWith("mac_")) return callMacTool(name, args, ctx);
  if (name === "box_info") {
    const script = [
      "echo user=$(id -un)",
      "echo home=$HOME",
      "echo workspace=$RAVNIR_WORKSPACE",
      "(. /etc/os-release 2>/dev/null && echo \"os=$PRETTY_NAME\")",
      "uname -srm",
      "command -v apt-get || true",
      "node --version 2>/dev/null && npm --version 2>/dev/null",
      "python3 --version 2>/dev/null",
      "command -v uv || true",
      "command -v cargo || true",
      "command -v bun || true",
      "command -v git || true",
      "command -v gh || true",
      "command -v ffmpeg || true",
      "command -v tesseract || true",
      "df -h \"$HOME\" | tail -1",
    ].join("; ");
    const result = await runBotCommand(bot, script, { workspace: ctx.workspace, browser: ctx.browser });
    return { text: result.output, activity: "Checking the computer" };
  }
  if (name === "memory_search") {
    const text = await searchMemory(ctx.aiMemory, String(args.query || ""), { limit: Math.min(20, Math.max(1, Number(args.limit) || 8)) });
    return { text: text || "No memory hits.", activity: "Searching shared memory" };
  }
  if (name === "memory_write") {
    const result = await memoryWrite(ctx.aiMemory, {
      path: String(args.path || ""),
      title: String(args.title || ""),
      body: String(args.body || ""),
      kind: String(args.kind || "fact"),
    });
    return { text: `Wrote ${result.path}. ${result.text}`, activity: "Writing shared memory" };
  }
  if (name === "memory_read") {
    return { text: await memoryRead(ctx.aiMemory, String(args.path || "")), activity: "Reading shared memory" };
  }
  if (name === "list_files") {
    return { text: await listDir(ctx.workspace, String(args.path || ".")) };
  }
  if (ARTIFACT_TOOLS.has(name)) {
    const engine = ctx.engine;
    if (!engine?.artifacts) return { text: "Artifacts are not available on this server." };
    return callArtifactTool(name, args, {
      store: engine.artifacts,
      bot,
      workspace: ctx.workspace,
      turnId: engine.active?.get(bot.id)?.turnId || "",
      onSaved: (meta) => engine.noteArtifact(bot, meta),
    });
  }
  if (name === "read_document") return callReadDocument(args, { workspace: ctx.workspace });
  if (name === "make_document") {
    const engine = ctx.engine;
    const turnId = engine?.active?.get(bot.id)?.turnId || "";
    const share = engine?.artifacts
      ? (relative, title) => {
        const meta = engine.artifacts.shareFile(bot, ctx.workspace, { path: relative, title, turnId });
        engine.noteArtifact(bot, meta);
        return meta;
      }
      : null;
    return callDocumentTool(args, { workspace: ctx.workspace, share });
  }
  if (name === "notify_user") return notifyUser(args, ctx);
  if (name === "propose_task") return proposeTask(args, ctx);
  if (name === "find_skills") return findSkills(bot, args);
  if (name === "suggest_skill") return suggestSkill(args, ctx);
  if (name === "find_plugins") return findPlugins(bot, args, ctx);
  if (name === "suggest_plugin") return suggestPlugin(args, ctx);
  if (collaborationToolDefinitions().some((tool) => tool.name === name)) {
    return callCollaborationTool(name, args, ctx);
  }
  throw new Error(`Unknown tool ${name}.`);
}

export async function builtinToolsFor(bot, ctx) {
  let defs = builtinToolDefinitions();
  // Jev's own tool needs Jev; smart click needs a server-side chooser; computer_step is how the agent picks without one.
  const chooser = chooserFor(bot).mode;
  if (chooser !== "jev") defs = defs.filter((tool) => tool.name !== "jev_choose");
  if (chooser === "agent") defs = defs.filter((tool) => tool.name !== "browser_smart_click");
  else defs = defs.filter((tool) => tool.name !== "computer_step");
  const boxDesktop = ctx.browser?.box?.uses(bot) && ocrAvailable();
  if (!desktopToolsAvailable() && !boxDesktop) defs = defs.filter((tool) => tool.name !== "desktop_task");
  if (!bot.vault.length) defs = defs.filter((tool) => tool.name !== "browser_saved_login");
  // Plugin search and suggestions need the Plugins page; a server without one keeps the skill tools.
  if (!ctx.plugins) defs = defs.filter((tool) => tool.name !== "find_plugins" && tool.name !== "suggest_plugin");
  // An agent with no skills attached has nothing to open.
  if (!attachedTo(bot).length) defs = defs.filter((tool) => tool.name !== "skill_view");
  // One shared memory: with the notes vault on, the ai-memory tools step aside.
  return selectMemoryTools(defs, { vaultOn: Boolean(ctx.vault?.available), writeOn: Boolean(ctx.vaultWriter?.available) });
}

function vaultToolNames() {
  return new Set([...vaultToolDefinitions(), ...vaultWriteToolDefinitions()].map((tool) => tool.name));
}

export function findLogin(bot, site) {
  const needle = site.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return bot.vault.find((entry) => {
    const value = `${entry.site} ${entry.label || ""} ${entry.username || ""}`.toLowerCase();
    return value.includes(needle) || needle.includes(entry.site.toLowerCase());
  }) || null;
}

const NOTIFY_PER_HOUR = 6;
const OPEN_PROPOSALS_PER_BOT = 5;
const NOT_PUSHED = {
  "bot-off": "Saved in the Inbox only, because notifications are off for you.",
  quiet: "Saved in the Inbox. It was not pushed because it is quiet hours.",
  disabled: "Saved in the Inbox only, because notifications are switched off.",
  "no-subscribers": "Saved in the Inbox. No phone or computer has push turned on yet.",
  "send-failed": "Saved in the Inbox, but the push could not be delivered.",
  "not-important": "Saved in the Inbox only.",
};

// "Alex's" or "The user's", for the start of a sentence.
function macOwner(ctx) {
  const whose = ownerPossessive(ownerOf(ctx.state));
  return whose.charAt(0).toUpperCase() + whose.slice(1);
}

function computerDriver(kind, bot, ctx, { goal = "", text = "" } = {}) {
  if (kind === "browser") return browserDriver({ bot, browser: ctx.browser, home: ctx.home, text });
  const desktop = ctx.browser?.desktop;
  if (!desktop) throw new Error("The desktop is not available on this server.");
  return desktopDriver({ bot, desktop, home: ctx.home, goal, text });
}

async function callMacTool(name, args, ctx) {
  const { bot, mac } = ctx;
  if (!mac) throw new Error("The Mac link is not available on this server.");
  if (name === "mac_status") {
    const status = mac.status();
    if (!status.configured) return { text: "The Mac link is not set up on this server." };
    const whose = macOwner(ctx);
    if (!status.online) return { text: `${whose} Mac is offline right now (closed, asleep or off the network).` };
    return { text: `${whose} Mac (${status.host}) is online. Home ${status.home}. Work folders: ${status.roots.join(", ") || "none reported"}.`, activity: "Checking the Mac" };
  }
  if (name === "mac_run") {
    const command = String(args.command || "");
    const cwd = String(args.cwd || "").trim() || "~/Desktop/Projects";
    const data = await mac.call(bot, "run", { command, cwd }, { timeout: 5 * 60_000, cwd });
    const raw = String(data.output || "");
    const output = ctx.plugins ? ctx.plugins.maskShellSecrets(bot, raw) : raw;
    return { text: `[Mac] ${cwd} $ ${command}\n${output}${data.truncated ? "\n[truncated]" : ""}\n[exit ${data.code}]`, activity: "Running a command on the Mac" };
  }
  if (name === "mac_read_file") {
    const file = String(args.path || "");
    const data = await mac.call(bot, "read", { path: file }, { timeout: 60_000, cwd: parentOf(file) });
    return { text: `${data.content || ""}${data.truncated ? "\n[truncated]" : ""}`, activity: `Reading ${file} on the Mac` };
  }
  if (name === "mac_write_file") {
    const file = String(args.path || "");
    const data = await mac.call(bot, "write", { path: file, content: String(args.content ?? "") }, { timeout: 60_000, cwd: parentOf(file) });
    return { text: `Wrote ${data.path || file} on the Mac (${data.bytes} bytes).`, activity: `Writing ${file} on the Mac` };
  }
  if (name === "mac_list") {
    const folder = String(args.path || "").trim() || "~/Desktop/Projects";
    const data = await mac.call(bot, "list", { path: folder }, { timeout: 60_000, cwd: folder });
    const lines = (data.entries || []).map((item) => `${item.type === "dir" ? "d" : "-"} ${item.name}${item.type === "dir" ? "/" : ""}`);
    return { text: `${data.path || folder}\n${lines.join("\n") || "(empty)"}${data.truncated ? "\n[truncated]" : ""}`, activity: "Listing a folder on the Mac" };
  }
  throw new Error(`Unknown tool ${name}.`);
}

function parentOf(file) {
  const text = String(file || "");
  return text.includes("/") ? text.slice(0, text.lastIndexOf("/")) : "";
}

async function notifyUser(args, ctx) {
  const { bot, notifications } = ctx;
  if (!notifications) throw new Error("Notifications are not available on this server.");
  const title = String(args.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const body = String(args.body || "").trim().slice(0, 400);
  if (!title) throw new Error("A notification needs a title.");
  const recent = notifications.list({ limit: 200 })
    .filter((item) => item.botId === bot.id && item.kind === "message" && item.at > Date.now() - 3_600_000).length;
  if (recent >= NOTIFY_PER_HOUR) {
    throw new Error(`You already sent ${recent} notifications in the last hour. Hold this one back, or put it in your reply instead.`);
  }
  const priority = ["normal", "high", "urgent"].includes(args.priority) ? args.priority : "normal";
  const record = await notifications.notify({ botId: bot.id, botName: bot.name, kind: "message", title, body, url: `/?bot=${bot.id}`, priority });
  const text = record.pushed ? "Sent to the user's phone and computer." : NOT_PUSHED[record.suppressed] || "Saved in the Inbox.";
  return { text, activity: "Notifying the user" };
}

async function proposeTask(args, ctx) {
  const { bot, notifications, proposals } = ctx;
  if (!proposals) throw new Error("Suggestions are not available on this server.");
  const title = String(args.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const prompt = String(args.prompt || "").trim().slice(0, 4000);
  if (!title || !prompt) throw new Error("A suggestion needs a title and a prompt.");
  const open = proposals.list({ status: "open" }).filter((item) => item.botId === bot.id);
  if (open.some((item) => item.title.toLowerCase() === title.toLowerCase())) {
    return { text: "That suggestion is already waiting for the user. Do not start the work until it is accepted." };
  }
  if (open.length >= OPEN_PROPOSALS_PER_BOT) {
    throw new Error(`You already have ${open.length} suggestions waiting. Let the user decide on those first.`);
  }
  const record = proposals.create({ botId: bot.id, botName: bot.name, title, why: String(args.why || ""), prompt });
  await notifications?.notify({
    botId: bot.id,
    botName: bot.name,
    kind: "proposal",
    title: record.title,
    body: record.why,
    url: "/?view=today",
    tag: `proposal-${record.id}`,
  });
  return { text: "Suggestion sent. The user will see a card with Do it and Dismiss. Do not start the work unless it comes back to you as an approved task.", activity: "Suggesting a task" };
}

function findJob(bot, ref) {
  const text = String(ref || "").trim();
  if (!text) throw new Error("Give the job id from list_jobs.");
  const lower = text.toLowerCase();
  const byId = bot.jobs.filter((job) => job.id === text || (text.length >= 4 && job.id.startsWith(lower)));
  const matches = byId.length ? byId : bot.jobs.filter((job) => job.name.toLowerCase() === lower);
  if (!matches.length) throw new Error("No job matches that id. Use list_jobs to see your jobs.");
  if (matches.length > 1) throw new Error("More than one job matches. Use a longer id from list_jobs.");
  return matches[0];
}

// One list_jobs row. Another agent's jobs say "the agent" where yours say "you".
function jobRow(job, own) {
  const next = job.nextRunAt && job.enabled ? formatRunTime(job.nextRunAt) : "none";
  const by = job.createdBy === "bot" ? (own ? "you" : "the agent") : "the user";
  const last = !own && job.lastRunAt ? ` | last run ${formatRunTime(job.lastRunAt)} ${job.lastStatus || ""}`.trimEnd() : "";
  return `- ${job.id.slice(0, 8)} | ${job.name} | ${describeSchedule(job)} | next ${next} | ${jobState(job)} | set by ${by}${last}`;
}

function jobState(job) {
  if (job.done) return "done";
  return job.enabled ? "enabled" : "paused";
}

function nextRunSentence(job) {
  return job.nextRunAt ? `Next run ${formatRunTime(job.nextRunAt)}.` : "No upcoming run found.";
}

export function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}

// The page script behind browser_click by text. It returns the center of the best
// visible match and whether something covers that point, { hidden, href } when only
// a hidden link matches (a copy in a closed menu), or null. Matches rank exact, then
// starts with, then contains; on a tie the shortest label wins. When no button or
// link matches (a clickable card or div), it takes the deepest visible element with
// the text and climbs to the nearest ancestor that looks clickable.
function findClickTarget(text) {
  return `(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const wanted = norm(${JSON.stringify(text)});
    if (!wanted) return null;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };
    const labelOf = (el) => norm(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "");
    const linkOf = (el) => {
      const link = el.closest("a");
      return link && typeof link.href === "string" && /^https?:/.test(link.href) ? link.href : "";
    };
    // A link with its own script or a download: opening its address is not the same as clicking it.
    const scriptedLink = (el) => {
      const link = el.closest("a");
      return Boolean(link && (link.hasAttribute("onclick") || link.hasAttribute("download") || el.hasAttribute("onclick")));
    };
    const center = (el) => {
      el.scrollIntoView({ block: "center" });
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      // What a click at that point reaches: the element itself, or something covering it.
      const hit = document.elementFromPoint(x, y);
      const covered = !hit || !(hit === el || el.contains(hit));
      return { x, y, href: linkOf(el), covered, scripted: scriptedLink(el) };
    };
    const nodes = [...document.querySelectorAll('a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],input[type="submit"],input[type="button"],summary,label')];
    const matches = nodes
      .map((el) => ({ el, label: labelOf(el) }))
      .filter((item) => item.label && item.label.includes(wanted))
      .map((item) => ({ ...item, score: item.label === wanted ? 0 : item.label.startsWith(wanted) ? 1 : 2 }))
      .sort((a, b) => a.score - b.score || a.label.length - b.label.length);
    const shown = matches.find((item) => visible(item.el));
    if (shown) return center(shown.el);
    const hidden = matches.find((item) => item.el.tagName === "A" && linkOf(item.el));
    if (hidden) return { hidden: true, href: linkOf(hidden.el) };
    const all = document.body ? [...document.body.querySelectorAll("*")].slice(0, 5000) : [];
    const holders = all.filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) && norm(el.innerText).includes(wanted) && visible(el));
    const deepest = holders.filter((el) => !holders.some((other) => other !== el && el.contains(other)));
    if (!deepest.length) return null;
    const best = deepest.find((el) => norm(el.innerText) === wanted) || deepest[0];
    const looksClickable = (el) => /^(A|BUTTON|SUMMARY|LABEL)$/.test(el.tagName)
      || /^(button|link|tab|menuitem|option)$/.test(el.getAttribute("role") || "")
      || el.hasAttribute("onclick")
      || (el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex")) >= 0)
      || getComputedStyle(el).cursor === "pointer";
    let target = best;
    for (let el = best, step = 0; el && el !== document.body && step <= 6; el = el.parentElement, step += 1) {
      if (looksClickable(el)) {
        target = el;
        break;
      }
    }
    return center(target);
  })()`;
}

function formatPage(status, page) {
  const fields = (page.fields || []).slice(0, 20)
    .map((field) => {
      const name = field.fieldLabel || field.label || field.placeholder || field.name || "";
      const value = field.options
        ? ` options: ${field.options.join(" | ")}; selected: ${field.selected || "none"}`
        : field.checked !== undefined ? ` ${field.checked ? "checked" : "not checked"}` : field.value ? ` = ${field.value}` : "";
      return `  [${field.i}] ${field.tag}${field.type && field.tag === "input" ? `[${field.type}]` : ""} ${name}${value}${field.css ? ` (selector ${field.css})` : ""}`;
    })
    .join("\n");
  const buttons = topActions(page.buttons || [], 40)
    .map((button) => `  [${button.i}] ${button.text || button.tag}${button.href ? ` -> ${button.href}` : ""}`)
    .join("\n");
  const notice = page.notice || status.notice || "";
  return [
    notice ? `Note: ${notice}\n` : "",
    `${status.title || page.title || "(untitled)"}`,
    status.url || page.url || "",
    "",
    (page.text || "").slice(0, 6000),
    fields ? `\nFields:\n${fields}` : "",
    buttons ? `\nButtons and links:\n${buttons}` : "",
  ].filter(Boolean).join("\n").slice(0, 12_000);
}
