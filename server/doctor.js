// `doctor`: what a fresh install needs, checked from inside the running server (GET /api/doctor,
// Settings > Server) or from bin/doctor.mjs. The report is meant to be pasted into an issue, so it
// names no host, address, person or path under a home folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { childEnv } from "./childEnv.js";
import { findChromium } from "./browser.js";

const GB = 1024 ** 3;

const check = (id, title, status, detail, fix = "") => ({ id, title, status, detail, ...(fix ? { fix } : {}) });

// Error text from OpenCode, git or Chromium can carry an address, a path or an email; the report is
// for pasting into an issue, so those become placeholders.
export function scrub(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()]+/gi, "[address]")
    .replace(/\b[\w.-]+@[\w.-]+:[\w./~-]+/g, "[address]")
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "[email]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip]")
    .replace(/(^|[\s'"(=:])(\/(?:home|Users|root|opt|data|var|etc|tmp|private|srv|mnt|run|app)\/[^\s'"():,]*)/g, "$1[path]")
    .slice(0, 400);
}

export function which(name, PATH = process.env.PATH || "") {
  for (const dir of String(PATH).split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return path.join(dir, name);
    } catch {
      // keep looking
    }
  }
  return "";
}

export function nodeCheck(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  return major >= 22
    ? check("node", "Node.js", "ok", `Node ${version}`)
    : check("node", "Node.js", "fail", `Node ${version}; Ravnir needs 22 or newer.`, "Install Node 22 or use the server image (install.sh).");
}

export function diskCheck(home) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
  } catch {
    return check("data", "Data folder", "fail", "The data folder is not writable.", "Give the user that runs Ravnir write access to RAVNIR_HOME.");
  }
  let free = null;
  try {
    const stats = fs.statfsSync(home);
    free = stats.bavail * stats.bsize;
  } catch {
    // statfs is missing on some systems; writable is enough then.
  }
  if (free === null) return check("data", "Data folder", "ok", "Writable.");
  const text = `Writable, ${(free / GB).toFixed(1)} GB free.`;
  if (free < 0.5 * GB) return check("data", "Data folder", "fail", text, "Free some disk space: agents' browsers and workspaces need room.");
  if (free < 2 * GB) return check("data", "Data folder", "warn", text, "Less than 2 GB free. Browsers and downloads fill it fast.");
  return check("data", "Data folder", "ok", text);
}

export function signInCheck({ host, signIn, publicUrl }) {
  const loopback = /^(127\.|localhost$|::1$|\[::1\]$)/.test(String(host || "127.0.0.1"));
  if (signIn) return check("signin", "Sign-in", "ok", "On.");
  if (!loopback || publicUrl) return check("signin", "Sign-in", "fail", "Off, but this server can be reached from other machines.", "Set RAVNIR_USER and RAVNIR_PASSWORD (install.sh does this).");
  return check("signin", "Sign-in", "ok", "Off; this server only listens on this computer.");
}

// Opens and closes a real Chromium, as the agents' browsers do.
export async function browserCheck() {
  const executable = findChromium();
  if (!executable) return check("browser", "Browser", "fail", "No Chromium found.", "Run: npx playwright install --with-deps chromium");
  const started = Date.now();
  let browser = null;
  try {
    const args = ["--no-first-run", "--disable-dev-shm-usage"];
    if (process.env.RAVNIR_CHROMIUM_NO_SANDBOX === "1") args.push("--no-sandbox");
    browser = await chromium.launch({ executablePath: executable, headless: true, args, env: childEnv(), timeout: 30_000 });
    const page = await browser.newPage();
    await page.setContent("<title>ok</title>");
    const title = await page.title();
    if (title !== "ok") throw new Error("the page did not load");
    return check("browser", "Browser", "ok", `Chromium starts in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  } catch (error) {
    const text = String(error.message || error).split("\n")[0].slice(0, 200);
    const sandbox = /sandbox|namespace/i.test(text) ? " If it mentions the sandbox, set RAVNIR_CHROMIUM_NO_SANDBOX=1 inside a container." : "";
    return check("browser", "Browser", "fail", `Chromium did not start: ${text}`, `Run: npx playwright install --with-deps chromium.${sandbox}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function desktopCheck(PATH = process.env.PATH || "") {
  if (process.platform !== "linux") return check("desktop", "Desktop", "ok", "Not Linux: browsers run headless, and the Desktop tab and live view are off.");
  const tools = ["Xvfb", "xdotool", "ffmpeg", "tesseract", "openbox", "x11vnc"];
  const missing = tools.filter((tool) => !which(tool, PATH));
  if (!missing.length) return check("desktop", "Desktop", "ok", "Xvfb, xdotool, ffmpeg, Tesseract, openbox and x11vnc are installed.");
  const core = missing.filter((tool) => ["Xvfb", "xdotool", "ffmpeg", "tesseract"].includes(tool));
  return check("desktop", "Desktop", core.length ? "warn" : "ok", `Missing: ${missing.join(", ")}.`, "sudo apt install xvfb xdotool ffmpeg tesseract-ocr openbox x11vnc (the server image has them).");
}

// The whole report. ctx holds what only the running server knows.
export async function runDoctor(ctx) {
  const checks = [nodeCheck(), diskCheck(ctx.home), signInCheck(ctx)];
  const [browser, catalog, list] = await Promise.all([
    ctx.skipBrowser ? null : browserCheck(),
    ctx.models.catalog().catch((error) => ({ error: error.message })),
    ctx.models.list().catch(() => ({ models: [] })),
  ]);
  if (browser) checks.push(browser);
  checks.push(desktopCheck());

  const managed = ctx.managedOpenCode.status();
  const oc = catalog?.opencode || {};
  if (oc.connected) {
    checks.push(check("opencode", "OpenCode", "ok", `${oc.managed ? "Run by Ravnir" : "Connected"}, ${oc.providers} provider${oc.providers === 1 ? "" : "s"} signed in.`));
  } else if (managed.enabled && !managed.error && Date.now() - (managed.startedAt || Date.now()) < 120_000) {
    checks.push(check("opencode", "OpenCode", "warn", "Ravnir is starting it.", "Run doctor again in a minute."));
  } else if (managed.enabled) {
    checks.push(check("opencode", "OpenCode", "fail", managed.error || "Ravnir is starting it.", managed.installed ? "Wait a minute and run doctor again; if it stays down, see the log in Settings > Server." : "npm install -g opencode-ai (the server image has it)."));
  } else if (oc.source && oc.source !== "none") {
    checks.push(check("opencode", "OpenCode", "fail", `Does not answer: ${oc.error || "no reply"}`, "Check the address and password in Settings > Models."));
  } else {
    const servers = (catalog?.servers || []).filter((server) => server.connected).length;
    checks.push(check("opencode", "OpenCode", servers ? "ok" : "warn", servers ? `Not used; ${servers} OpenAI-compatible server${servers === 1 ? "" : "s"} connected.` : "Not connected.", servers ? "" : "Settings > Models, or start Ravnir with RAVNIR_OPENCODE=managed."));
  }

  const count = list?.models?.length || 0;
  const starting = checks.at(-1).id === "opencode" && checks.at(-1).status === "warn" && checks.at(-1).detail === "Ravnir is starting it.";
  if (!count && starting) checks.push(check("model", "Models", "warn", "Waiting for OpenCode to start.", "Run doctor again in a minute."));
  else checks.push(count
    ? check("model", "Models", "ok", `${count} model${count === 1 ? "" : "s"} ready to use.`)
    : check("model", "Models", "fail", "No model is connected yet.", "Settings > Models: sign in to a provider, paste a key, or add Ollama or LM Studio."));

  const vault = ctx.vault?.status?.();
  const writer = ctx.writer?.status?.();
  if (!vault) {
    checks.push(check("vault", "Notes vault", "warn", "Off: agents remember only in their own memory.", "Start Ravnir with RAVNIR_VAULT=local (the server image does)."));
  } else if (!vault.available) {
    checks.push(check("vault", "Notes vault", "fail", vault.lastError || "The vault folder is missing.", "Check RAVNIR_VAULT_DIR."));
  } else {
    let writable = true;
    try {
      fs.accessSync(vault.dir, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    const remote = ctx.vaultRemote ? "synced with its git remote" : "local git repo, no remote";
    if (writer && !writable) checks.push(check("vault", "Notes vault", "fail", "The vault folder is not writable.", "Give the user that runs Ravnir write access to it."));
    else if (writer?.lastError) checks.push(check("vault", "Notes vault", "warn", `${vault.notes} notes, ${remote}. Last sync failed: ${writer.lastError}`, "Check the deploy key has write access."));
    else checks.push(check("vault", "Notes vault", "ok", `${vault.notes} notes, ${writer ? remote : "read only"}.`));
  }

  let pushReady = false;
  try {
    pushReady = Boolean(ctx.push.publicKey());
  } catch {
    pushReady = false;
  }
  const https = /^https:\/\//i.test(ctx.publicUrl || "");
  if (!pushReady) checks.push(check("push", "Phone notifications", "fail", "Push keys could not be made.", "Check the data folder is writable."));
  else if (!https) checks.push(check("push", "Phone notifications", "warn", "Push keys are ready, but no https address is set, and phones need one to install the app and get notifications.", "Rerun install.sh and pick Tailscale or your own domain. Behind your own https proxy, open Ravnir at that address; setup and Add a device use it."));
  else checks.push(check("push", "Phone notifications", "ok", `Push keys ready, https address (${ctx.access || "custom"}).`));

  checks.push(check("system", "System", "ok", `${os.platform()} ${os.arch()}, ${os.cpus().length} CPU, ${(os.totalmem() / GB).toFixed(1)} GB RAM${ctx.container ? ", in a container" : ""}.`));
  const ok = !checks.some((item) => item.status === "fail");
  const clean = checks.map((item) => ({ ...item, detail: scrub(item.detail), ...(item.fix ? { fix: scrub(item.fix) } : {}) }));
  return { ok, version: ctx.version, at: new Date().toISOString(), checks: clean };
}

export function formatReport(report) {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const lines = [`Ravnir doctor${report.version ? ` ${report.version}` : ""} (${report.at})`];
  for (const item of report.checks) {
    lines.push(`[${mark[item.status] || item.status}] ${item.title}: ${item.detail}`);
    if (item.fix && item.status !== "ok") lines.push(`       fix: ${item.fix}`);
  }
  lines.push(report.ok ? "All required checks passed." : "Some required checks failed.");
  return lines.join("\n");
}
