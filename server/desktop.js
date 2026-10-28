import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { childEnv } from "./childEnv.js";
import { botHome } from "./state.js";

export const DESKTOP = { width: 1440, height: 900, depth: 24 };

// One Xvfb desktop per bot, started on demand. The browser runs headful on it,
// and the bot can open any GUI app in the same display. The user can watch and
// click the real desktop from the UI. On a host without Xvfb the browser falls
// back to headless and nothing else changes.
export class DesktopManager {
  constructor({ width = DESKTOP.width, height = DESKTOP.height, depth = DESKTOP.depth } = {}) {
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.sessions = new Map();
    this.starting = new Map();
  }

  status(bot) {
    const session = this.sessions.get(bot.id);
    return {
      running: Boolean(session?.alive),
      display: session?.display || "",
      available: process.platform === "linux" && Boolean(which("Xvfb")),
      width: this.width,
      height: this.height,
    };
  }

  async ensure(bot, home) {
    if (process.platform !== "linux") return null;
    if (!which("Xvfb")) return null;
    const existing = this.sessions.get(bot.id);
    if (existing?.alive) return existing;
    if (this.starting.has(bot.id)) return this.starting.get(bot.id);
    const promise = this.#start(bot, home);
    this.starting.set(bot.id, promise);
    try {
      const session = await promise;
      if (session) this.sessions.set(bot.id, session);
      return session;
    } finally {
      this.starting.delete(bot.id);
    }
  }

  async #start(bot, home) {
    const dir = path.join(botHome(home, bot), "desktop");
    await fsp.mkdir(dir, { recursive: true });
    const authFile = path.join(dir, "Xauthority");
    fs.rmSync(authFile, { force: true });
    const cookie = crypto.randomBytes(16).toString("hex");
    const xvfbBin = which("Xvfb");
    const xdoBin = which("xdotool");
    const ffmpegBin = which("ffmpeg");
    if (!xvfbBin || !xdoBin || !ffmpegBin) return null;
    const logPath = path.join(dir, "xvfb.log");
    const logFd = fs.openSync(logPath, "a");

    for (let n = 90; n < 100; n += 1) {
      const display = `:${n}`;
      try {
        await run("xauth", ["-f", authFile, "add", display, ".", cookie], { timeout: 5000 });
      } catch {
        return null;
      }
      const xvfb = spawn(xvfbBin, [
        display,
        "-auth", authFile,
        "-screen", "0", `${this.width}x${this.height}x${this.depth}`,
        "-nolisten", "tcp",
        "-noreset",
      ], { stdio: ["ignore", logFd, logFd], detached: true });
      xvfb.unref();
      let spawnError = "";
      xvfb.on("error", (error) => { spawnError = error.message; });
      // Openbox, the browser, x11vnc and any app opened from the desktop inherit this.
      const env = childEnv({ DISPLAY: display, XAUTHORITY: authFile });
      const ready = await waitForDisplay(xdoBin, env, 2500);
      if (!ready || spawnError || xvfb.exitCode !== null) {
        try { process.kill(-xvfb.pid, "SIGKILL"); } catch { /* ignore */ }
        try { xvfb.kill("SIGKILL"); } catch { /* ignore */ }
        continue;
      }
      let openbox = null;
      if (which("openbox")) {
        openbox = spawn("openbox", ["--sm-disable"], { env, stdio: "ignore", detached: true });
        openbox.unref();
      }
      return {
        display,
        xauthority: authFile,
        env,
        xvfb,
        openbox,
        alive: true,
        lastShot: null,
        lastShotAt: 0,
      };
    }
    return null;
  }

  async screenshot(bot, { force = false } = {}) {
    const session = this.sessions.get(bot.id);
    if (!session?.alive) return null;
    const now = Date.now();
    if (!force && session.lastShot && now - session.lastShotAt < 500) return session.lastShot;
    const file = path.join(path.dirname(session.xauthority), `screen-${Date.now()}.png`);
    await run(which("ffmpeg") || "ffmpeg", [
      "-loglevel", "error",
      "-f", "x11grab",
      "-video_size", `${this.width}x${this.height}`,
      "-i", session.display,
      "-frames:v", "1",
      "-y", file,
    ], { env: session.env, timeout: 10_000 });
    const png = await fsp.readFile(file);
    await fsp.unlink(file).catch(() => {});
    session.lastShot = png;
    session.lastShotAt = Date.now();
    return png;
  }

  async click(bot, x, y) {
    const session = this.require(bot);
    await run(which("xdotool") || "xdotool", ["mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1"], { env: session.env });
  }

  async type(bot, text) {
    const session = this.require(bot);
    await run(which("xdotool") || "xdotool", ["type", "--delay", "18", "--clearmodifiers", String(text)], { env: session.env, timeout: 30_000 });
  }

  async key(bot, name) {
    const session = this.require(bot);
    await run(which("xdotool") || "xdotool", ["key", xKey(name)], { env: session.env });
  }

  async scroll(bot, dy) {
    const session = this.require(bot);
    const button = Number(dy) < 0 ? "4" : "5";
    const repeats = Math.max(1, Math.min(12, Math.round(Math.abs(Number(dy) || 800) / 120)));
    const xdo = which("xdotool") || "xdotool";
    await run(xdo, ["mousemove", String(Math.round(this.width / 2)), String(Math.round(this.height / 2))], { env: session.env });
    for (let i = 0; i < repeats; i += 1) await run(xdo, ["click", button], { env: session.env });
  }

  require(bot) {
    const session = this.sessions.get(bot.id);
    if (!session?.alive) throw new Error("The desktop is not running for this bot.");
    return session;
  }

  displayFor(bot) {
    const session = this.sessions.get(bot.id);
    return session?.display || "";
  }

  envFor(bot) {
    const session = this.sessions.get(bot.id);
    return session ? { DISPLAY: session.display, XAUTHORITY: session.xauthority } : {};
  }

  async close(botId) {
    const session = this.sessions.get(botId);
    if (!session) return;
    this.sessions.delete(botId);
    session.alive = false;
    for (const child of [session.openbox, session.xvfb]) {
      if (!child?.pid) continue;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}

export function desktopToolsAvailable() {
  return Boolean(which("Xvfb") && which("xdotool") && which("ffmpeg") && which("tesseract"));
}

// A bot with its own computer brings its own X server; only the OCR runs here.
export function ocrAvailable() {
  return Boolean(which("tesseract"));
}

function which(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // keep looking
    }
  }
  return "";
}

function waitForDisplay(xdoBin, env, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        await run(xdoBin, ["getdisplaygeometry"], { env, timeout: 1000 });
        return resolve(true);
      } catch {
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 150);
      }
    };
    tick();
  });
}

function run(file, args, { env, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: env || process.env, timeout, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr ? `: ${String(stderr).slice(0, 300)}` : ""}`;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export function xKey(name) {
  const map = {
    Enter: "Return",
    Return: "Return",
    Tab: "Tab",
    Escape: "Escape",
    Esc: "Escape",
    Backspace: "BackSpace",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Space: "space",
  };
  return map[name] || String(name || "Return");
}
