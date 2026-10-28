import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { findChromium, HANDED_OVER_MESSAGE, normalizeUrl, VIEWPORT } from "./browser.js";
import { botHome, browserProfilePath } from "./state.js";

// "Take control": the user sees and drives a bot's real screen from the Mac or
// the phone, and can sign in to a site that blocks the agent's automated browser.
//
// The screen is the bot's X display (its Xvfb on the host, or :1 inside its own
// computer), shared with x11vnc and shown with noVNC. This file holds the
// pieces on the server side:
//   - LiveManager: the VNC bridge for the WebSocket at /api/bots/:id/live, and
//     the "Sign in yourself" hand-over (the agent's browser closes, a plain
//     Chromium with no automation opens on the same profile, and the agent's
//     browser comes back on the page the user ended on).
//   - the ask_user_to_take_over tool, which turns a block into an approval.
//
// The live view belongs to the signed-in user. Bots never get it, and the
// per-bot MCP token does not open it.

export class LiveError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "LiveError";
    this.status = status;
  }
}

export const NEEDS_NEW_IMAGE = "Live view needs the new box image. Use Reset in the Shell tab to rebuild this computer on it, then try again.";

const VNC_PORT_IN_BOX = 5900;
const BOX_PROFILE = "/root/.config/ravnir-browser";
// x11vnc stops this long after the last viewer leaves.
const VNC_IDLE_MS = 120_000;
// A browser the user took and never handed back returns to the agent after this long with nobody watching.
const HANDBACK_IDLE_MS = 30 * 60_000;
const WEBKIT_EPOCH_MS = 11_644_473_600_000;
// The window class (a regex for xdotool) of the browser's own windows.
const BROWSER_WINDOW_CLASS = "Google-chrome|Chromium|chromium-browser";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Browser and computer tools that must not touch the browser while the user has it.
export const HANDOVER_GUARDED_TOOLS = new Set([
  "browser_open", "browser_read", "browser_click", "browser_type", "browser_key",
  "browser_smart_click", "browser_saved_login", "computer_task", "desktop_task", "computer_step",
]);

// The reply of a guarded tool while the user is signing in, or null when the tool may go ahead.
export function handedOverReply(name, { browser, bot } = {}) {
  if (!HANDOVER_GUARDED_TOOLS.has(name) || !bot || !browser?.isHeld?.(bot.id)) return null;
  return { text: HANDED_OVER_MESSAGE, activity: "Waiting for the user to hand the browser back" };
}

export function x11vncArgs({ display, auth = "", port, log = "" }) {
  return [
    "-display", display,
    ...(auth ? ["-auth", auth] : []),
    "-localhost",
    "-rfbport", String(port),
    "-shared",
    "-forever",
    "-nopw",
    "-noxdamage",
    "-quiet",
    ...(log ? ["-o", log] : []),
  ];
}

// The browser the user signs in with. Same profile as the agent's, but none of the
// automation: no DevTools port, no automation flags, no user agent or fingerprint changes.
// `extra` carries the agent's network route (a --proxy-server flag) so Cloudflare sees the same address.
export function plainChromiumArgs({ profile, url, sandbox = true, inBox = false, extra = [] }) {
  return [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    // The agent's browser was just closed, so Chromium would offer to restore pages over the sign-in page.
    "--hide-crash-restore-bubble",
    "--window-position=0,0",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "--start-maximized",
    ...(sandbox ? [] : ["--no-sandbox"]),
    ...(inBox ? ["--disable-dev-shm-usage"] : []),
    ...extra,
    url || "about:blank",
  ];
}

// The newest page the browser visited after `sinceMs`, read from the profile's
// History database once the browser has exited (the plain browser has no DevTools
// port to ask). Returns "" when there is none.
export async function lastVisitedUrl(profile, sinceMs) {
  const source = path.join(profile, "Default", "History");
  const copy = path.join(os.tmpdir(), `ravnir-history-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const suffixes = ["", "-journal", "-wal"];
  try {
    await fsp.copyFile(source, copy);
    // A browser that was killed can leave a journal behind; SQLite needs it next to the copy.
    for (const suffix of suffixes.slice(1)) await fsp.copyFile(`${source}${suffix}`, `${copy}${suffix}`).catch(() => {});
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(copy);
    try {
      const since = (Math.max(0, sinceMs) + WEBKIT_EPOCH_MS) * 1000;
      const row = db.prepare("SELECT url FROM urls WHERE last_visit_time >= ? AND (url LIKE 'http://%' OR url LIKE 'https://%') ORDER BY last_visit_time DESC LIMIT 1").get(since);
      return row?.url ? String(row.url) : "";
    } finally {
      db.close();
    }
  } catch {
    return "";
  } finally {
    for (const suffix of suffixes) await fsp.rm(`${copy}${suffix}`, { force: true }).catch(() => {});
  }
}

export class LiveManager {
  // `drivers` exist for tests: { host, box } with the same methods as HostDriver.
  constructor({ home, browser, desktop, box = null, approvals = null, drivers = null, idleMs = VNC_IDLE_MS, handbackMs = HANDBACK_IDLE_MS }) {
    this.home = home;
    this.browser = browser;
    this.approvals = approvals;
    this.idleMs = idleMs;
    this.handbackMs = handbackMs;
    this.drivers = drivers || {
      host: new HostDriver({ home, desktop, browser }),
      box: new BoxDriver({ home, box }),
    };
    this.box = box;
    this.states = new Map();
    this.locks = new Map();
    this.preparing = new Map();
  }

  driver(bot) {
    return this.box?.uses(bot) ? this.drivers.box : this.drivers.host;
  }

  isHandedOver(botId) {
    return this.browser.isHeld(botId);
  }

  async available(bot) {
    return this.driver(bot).available(bot);
  }

  // The address the agent's browser is on (or was last on), for a takeover that names none.
  currentUrl(bot) {
    const held = this.browser.held.get(bot.id);
    const open = this.browser.sessions.get(bot.id)?.url;
    if (held?.url) return held.url;
    if (open && /^https?:/i.test(open)) return open;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(botHome(this.home, bot), "browser.json"), "utf8"));
      if (/^https?:/i.test(saved.url)) return saved.url;
    } catch {
      // No saved page yet.
    }
    return "";
  }

  async status(bot) {
    const driver = this.driver(bot);
    const found = await driver.available(bot);
    const held = this.browser.held.get(bot.id);
    const session = this.browser.sessions.get(bot.id);
    return {
      available: Boolean(found.ok),
      reason: found.ok ? "" : found.reason || "Live view is not available here.",
      runtime: driver.kind,
      handedOver: Boolean(held),
      url: held?.url || session?.url || "",
      title: session?.title || "",
      since: held?.startedAt || 0,
      viewers: this.#state(bot).viewers,
    };
  }

  // Gets the screen ready for a viewer. `withBrowser` also makes sure the agent's
  // browser is open, so there is something on the screen.
  async start(bot, { withBrowser = true } = {}) {
    const found = await this.driver(bot).available(bot);
    if (!found.ok) throw new LiveError(found.reason);
    if (withBrowser && !this.browser.isHeld(bot.id)) await this.browser.ensure(bot).catch(() => {});
    await this.#prepare(bot);
    return this.status(bot);
  }

  #prepare(bot) {
    let pending = this.preparing.get(bot.id);
    if (!pending) {
      pending = this.driver(bot).ensureVnc(bot).finally(() => this.preparing.delete(bot.id));
      this.preparing.set(bot.id, pending);
    }
    return pending;
  }

  // One viewer on the VNC stream. `ws` carries RFB bytes in binary frames and
  // nothing else, which is what noVNC speaks.
  async attach(ws, bot) {
    const driver = this.driver(bot);
    let open = true;
    let connection = null;
    let joined = false;
    const leave = () => {
      if (!open) return;
      open = false;
      connection?.close();
      if (joined) this.#leave(bot);
    };
    ws.on("close", leave);
    ws.on("error", () => ws.terminate());
    this.#join(bot);
    joined = true;
    try {
      await this.#prepare(bot);
      if (!open) return;
      connection = await driver.connect(bot);
    } catch (error) {
      if (ws.readyState === ws.OPEN) ws.close(1011, shortReason(error.message));
      leave();
      return;
    }
    if (!open) {
      connection.close();
      return;
    }
    let paused = false;
    connection.output.on("data", (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk, { binary: true });
      // The browser reads slower than the screen changes: pause the source until it catches up.
      if (ws.bufferedAmount > 2_000_000 && !paused) {
        paused = true;
        connection.output.pause();
        const timer = setInterval(() => {
          if (ws.readyState === ws.OPEN && ws.bufferedAmount > 500_000) return;
          clearInterval(timer);
          paused = false;
          connection.output.resume();
        }, 40);
      }
    });
    connection.onClose(() => {
      if (ws.readyState === ws.OPEN) ws.close(1000, "The screen ended.");
      leave();
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (!connection.input.destroyed && bytes.length) connection.input.write(bytes);
    });
  }

  #state(bot) {
    let state = this.states.get(bot.id);
    if (!state) {
      state = { viewers: 0, idle: null, watchdog: null };
      this.states.set(bot.id, state);
    }
    return state;
  }

  #join(bot) {
    const state = this.#state(bot);
    state.viewers += 1;
    clearTimeout(state.idle);
    clearTimeout(state.watchdog);
  }

  #leave(bot) {
    const state = this.#state(bot);
    state.viewers = Math.max(0, state.viewers - 1);
    if (state.viewers) return;
    clearTimeout(state.idle);
    state.idle = setTimeout(() => this.driver(bot).stopVnc(bot).catch(() => {}), this.idleMs);
    state.idle.unref?.();
    // The user walked away with the agent's browser in their hands: give it back after a while.
    if (this.browser.isHeld(bot.id)) {
      clearTimeout(state.watchdog);
      state.watchdog = setTimeout(() => this.handBack(bot).catch(() => {}), this.handbackMs);
      state.watchdog.unref?.();
    }
  }

  // "Sign in yourself": the agent's browser closes and the user gets a plain one.
  takeOver(bot, { url = "" } = {}) {
    return this.#locked(bot, async () => {
      if (this.browser.isHeld(bot.id)) return this.status(bot);
      const driver = this.driver(bot);
      const found = await driver.available(bot);
      if (!found.ok) throw new LiveError(found.reason);
      const target = url ? normalizeUrl(url) : this.currentUrl(bot);
      // Held first: from here no tool can open the browser that is about to go away.
      this.browser.hold(bot.id, { url: target, startedAt: Date.now() });
      try {
        await this.browser.close(bot.id);
        await driver.startPlain(bot, target || "about:blank");
      } catch (error) {
        this.browser.release(bot.id);
        // Put the agent's browser back, so the screen the user is watching is not left empty.
        await this.browser.ensure(bot).catch(() => {});
        throw error instanceof LiveError ? error : new LiveError(`Could not open a plain browser. ${String(error.message || error).split("\n")[0]}`, 500);
      }
      const state = this.#state(bot);
      if (!state.viewers) {
        clearTimeout(state.watchdog);
        state.watchdog = setTimeout(() => this.handBack(bot).catch(() => {}), this.handbackMs);
        state.watchdog.unref?.();
      }
      return this.status(bot);
    });
  }

  // "Done, hand it back": the plain browser closes, the agent's comes back on the
  // page the user ended on, and any takeover the agent is waiting on is answered.
  handBack(bot) {
    return this.#locked(bot, async () => {
      const held = this.browser.held.get(bot.id);
      try {
        if (held) {
          clearTimeout(this.#state(bot).watchdog);
          let url = held.url;
          try {
            url = (await this.driver(bot).stopPlain(bot, { since: held.startedAt, fallback: held.url })) || held.url;
          } catch {
            // Fall back to the page the user started on.
          }
          // Still held while the agent's browser comes back, so no tool gets in before the page does.
          const session = await this.browser.ensure(bot, { force: true });
          if (url && url !== "about:blank") await session.navigate(url, { quiet: true }).catch(() => {});
        }
      } finally {
        this.browser.release(bot.id);
        if (this.approvals) {
          for (const request of this.approvals.pendingFor(bot.id).filter((item) => item.kind === "takeover")) {
            this.approvals.decide(request.id, "once");
          }
        }
      }
      return this.status(bot);
    });
  }

  // The bot is changing computers, stopping or being deleted: let go of the hold and
  // the shared screen without relaunching anything.
  async reset(bot) {
    const held = this.browser.held.get(bot.id);
    clearTimeout(this.#state(bot).watchdog);
    this.browser.release(bot.id);
    const driver = this.driver(bot);
    if (held) await driver.stopPlain(bot, { since: held.startedAt }).catch(() => {});
    await driver.stopVnc(bot).catch(() => {});
  }

  // Takeovers and hand-backs of one bot never overlap.
  #locked(bot, work) {
    const previous = this.locks.get(bot.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(bot.id, next.catch(() => {}));
    return next;
  }

  async close() {
    for (const [id, state] of this.states) {
      clearTimeout(state.idle);
      clearTimeout(state.watchdog);
      this.states.delete(id);
    }
    await Promise.all(Object.values(this.drivers).map((driver) => driver.shutdown?.().catch(() => {})));
  }
}

// ---- On the server itself (Linux with Xvfb) ----------------------------------

export class HostDriver {
  constructor({ home, desktop, browser = null, which = whichOnPath, chromium = findChromium }) {
    this.kind = "host";
    this.home = home;
    this.desktop = desktop;
    this.browser = browser;
    this.which = which;
    this.chromium = chromium;
    // Chromium's own sandbox needs user namespaces, which Ubuntu 23.10+ blocks for
    // unprivileged programs (AppArmor). Learned from the first launch: null until then.
    this.sandbox = process.env.RAVNIR_CHROMIUM_NO_SANDBOX === "1" ? false : null;
    this.vnc = new Map();
    this.plain = new Map();
  }

  async available(bot) {
    if (process.platform !== "linux") return { ok: false, reason: "Live view needs a Linux server with a desktop (Xvfb). This server has none; switch the bot to its own computer to use it." };
    if (!this.desktop.status(bot).available) return { ok: false, reason: "This server has no desktop (Xvfb is not installed), so there is no screen to share." };
    if (!this.which("x11vnc")) return { ok: false, reason: "x11vnc is not installed on this server. Install it with: sudo apt install x11vnc" };
    return { ok: true };
  }

  async #display(bot) {
    const session = await this.desktop.ensure(bot, this.home);
    if (!session) throw new LiveError("The desktop could not start.");
    return session;
  }

  async ensureVnc(bot) {
    const session = await this.#display(bot);
    const running = this.vnc.get(bot.id);
    if (running && running.child.exitCode === null && !running.child.killed) return;
    const port = await freePort();
    let errors = "";
    const child = spawn(this.which("x11vnc"), x11vncArgs({ display: session.display, auth: session.xauthority, port }), {
      env: session.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { errors = `${errors}${chunk}`.slice(-400); });
    child.on("exit", () => {
      if (this.vnc.get(bot.id)?.child === child) this.vnc.delete(bot.id);
    });
    this.vnc.set(bot.id, { child, port });
    try {
      await waitForPort(port, 10_000, () => child.exitCode === null);
    } catch {
      child.kill("SIGKILL");
      this.vnc.delete(bot.id);
      throw new LiveError(`x11vnc did not start.${errors ? ` ${errors.trim().split("\n").pop()}` : ""}`);
    }
  }

  connect(bot) {
    const running = this.vnc.get(bot.id);
    if (!running) throw new LiveError("The screen is not shared right now.");
    const socket = net.connect(running.port, "127.0.0.1");
    socket.setNoDelay(true);
    return {
      input: socket,
      output: socket,
      close: () => socket.destroy(),
      onClose: (callback) => socket.on("close", callback),
    };
  }

  async stopVnc(bot) {
    const running = this.vnc.get(bot.id);
    this.vnc.delete(bot.id);
    running?.child.kill("SIGTERM");
  }

  async startPlain(bot, url) {
    const session = await this.#display(bot);
    const profile = browserProfilePath(this.home, bot);
    await waitForProfileFree(profile, 15_000);
    const executable = this.chromium();
    if (!executable) throw new LiveError("Chromium is not installed on this server.");
    const extra = this.browser?.network?.plainArgs(bot) || [];
    if (this.sandbox !== false && await this.#launchPlain(bot, executable, session, plainChromiumArgs({ profile, url, extra }))) {
      this.sandbox = true;
      return;
    }
    if (this.sandbox === true) throw new LiveError("The plain browser closed as soon as it opened.");
    // No usable sandbox here (the agent's own browser runs without one too): open it the same way.
    this.sandbox = false;
    await waitForProfileFree(profile, 5_000);
    if (!await this.#launchPlain(bot, executable, session, plainChromiumArgs({ profile, url, sandbox: false, extra }))) {
      throw new LiveError("The plain browser closed as soon as it opened.");
    }
  }

  // True when the browser is still running after a moment; a Chromium that dies at
  // once (no sandbox, no display, a bad flag) is reported, not left as a blank screen.
  async #launchPlain(bot, executable, session, args) {
    const child = spawn(executable, args, { env: session.env, detached: true, stdio: "ignore" });
    child.unref();
    const exited = new Promise((resolve) => {
      child.once("exit", () => resolve("exit"));
      child.once("error", () => resolve("exit"));
    });
    this.plain.set(bot.id, { child, exited });
    child.on("exit", () => {
      if (this.plain.get(bot.id)?.child === child) this.plain.delete(bot.id);
    });
    const early = await Promise.race([exited, sleep(1500).then(() => "")]);
    return !early;
  }

  // Closes the plain browser and returns the page it ended on.
  async stopPlain(bot, { since = 0, fallback = "" } = {}) {
    const profile = browserProfilePath(this.home, bot);
    const running = this.plain.get(bot.id);
    this.plain.delete(bot.id);
    if (running && running.child.exitCode === null) {
      // Closing the window is Chromium's own way to quit: it saves cookies and history, which a signal does not.
      const session = await this.#display(bot).catch(() => null);
      const xdotool = this.which("xdotool");
      let done = "";
      for (let attempt = 0; attempt < 4 && !done && session && xdotool; attempt += 1) {
        const found = await execQuiet(xdotool, ["search", "--onlyvisible", "--class", BROWSER_WINDOW_CLASS], { env: session.env });
        const id = found.split("\n").find(Boolean);
        if (!id) break;
        await execQuiet(xdotool, ["windowactivate", id, "key", "alt+F4"], { env: session.env });
        done = await Promise.race([running.exited, sleep(3_000).then(() => "")]);
      }
      if (!done) {
        running.child.kill("SIGTERM");
        done = await Promise.race([running.exited, sleep(8_000).then(() => "")]);
      }
      if (!done) {
        try { process.kill(-running.child.pid, "SIGKILL"); } catch { running.child.kill("SIGKILL"); }
        await sleep(500);
      }
    }
    await waitForProfileFree(profile, 10_000);
    return (await lastVisitedUrl(profile, since)) || fallback;
  }

  async shutdown() {
    for (const [id, running] of this.plain) {
      running.child.kill("SIGTERM");
      this.plain.delete(id);
    }
    for (const [id, running] of this.vnc) {
      running.child.kill("SIGTERM");
      this.vnc.delete(id);
    }
  }
}

// ---- In the bot's own computer (docker or podman) ------------------------------

export class BoxDriver {
  constructor({ home, box }) {
    this.kind = "box";
    this.home = home;
    this.box = box;
  }

  async available() {
    if (!this.box?.enabled) return { ok: false, reason: "Own computers are off on this server. Set RAVNIR_BOX to podman or docker." };
    return { ok: true };
  }

  async ensureVnc(bot) {
    await this.box.ensure(bot);
    const found = await this.box.runIn(bot, ["sh", "-c", "command -v x11vnc"], { timeout: 10_000 });
    if (found.code !== 0) throw new LiveError(NEEDS_NEW_IMAGE);
    const running = await this.box.runIn(bot, ["pgrep", "-x", "x11vnc"], { timeout: 10_000 });
    if (running.code !== 0) {
      await this.box.execDetached(bot, ["x11vnc", ...x11vncArgs({ display: ":1", port: VNC_PORT_IN_BOX, log: "/var/log/ravnir/x11vnc.log" })]);
    }
    const until = Date.now() + 10_000;
    for (;;) {
      const probe = await this.box.runIn(bot, ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${VNC_PORT_IN_BOX}`], { timeout: 5_000 });
      if (probe.code === 0) return;
      if (Date.now() > until) throw new LiveError("The live view did not start in the computer.");
      await sleep(250);
    }
  }

  // Nothing is published: the bridge is `exec socat` on the box's own loopback.
  connect(bot) {
    const child = this.box.spawnIn(bot, ["socat", "-", `TCP:127.0.0.1:${VNC_PORT_IN_BOX}`]);
    child.stdin.on("error", () => {});
    return {
      input: child.stdin,
      output: child.stdout,
      close: () => {
        child.stdin.destroy();
        child.kill();
      },
      onClose: (callback) => child.on("close", callback),
    };
  }

  async stopVnc(bot) {
    if (this.box.known.get(bot.id) !== "running") return;
    await this.box.runIn(bot, ["pkill", "-x", "x11vnc"], { timeout: 10_000 });
  }

  async #chromeGone(bot, ms) {
    const until = Date.now() + ms;
    for (;;) {
      if ((await this.box.runIn(bot, ["pgrep", "-x", "chrome"], { timeout: 10_000 })).code !== 0) return true;
      if (Date.now() >= until) return false;
      await sleep(250);
    }
  }

  // Quits the browser in the box. Closing its window comes first: that is Chromium's own
  // way to quit, and it saves cookies and history, which a signal does not (a cookie set
  // a few seconds before would be lost). A signal, then a kill, only if it will not close.
  async #stopChrome(bot) {
    if (await this.#chromeGone(bot, 0)) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const found = await this.box.runIn(bot, ["xdotool", "search", "--onlyvisible", "--class", BROWSER_WINDOW_CLASS], { timeout: 10_000 });
      const id = String(found.stdout || "").split("\n").find(Boolean);
      if (!id) break;
      await this.box.runIn(bot, ["xdotool", "windowactivate", id, "key", "alt+F4"], { timeout: 10_000 });
      if (await this.#chromeGone(bot, 3_000)) return;
    }
    await this.box.runIn(bot, ["pkill", "-TERM", "-x", "chrome"], { timeout: 10_000 });
    if (await this.#chromeGone(bot, 8_000)) return;
    await this.box.runIn(bot, ["pkill", "-KILL", "-x", "chrome"], { timeout: 10_000 });
    await sleep(400);
  }

  async startPlain(bot, url) {
    await this.#stopChrome(bot);
    const script = [
      `P=${BOX_PROFILE}`,
      'rm -f "$P"/Singleton*',
      "export DISPLAY=:1",
      // $P and $1 (the address) stay quoted shell variables; every other argument is a plain flag.
      `exec ravnir-chromium ${plainChromiumArgs({ profile: '"$P"', url: '"$1"', sandbox: false, inBox: true }).join(" ")} >>/var/log/ravnir/browser-plain.log 2>&1`,
    ].join("\n");
    await this.box.execDetached(bot, ["bash", "-c", script, "_", url]);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if ((await this.box.runIn(bot, ["pgrep", "-x", "chrome"], { timeout: 10_000 })).code === 0) return;
      await sleep(250);
    }
    throw new LiveError("The plain browser did not start in the computer.");
  }

  async stopPlain(bot, { since = 0, fallback = "" } = {}) {
    await this.#stopChrome(bot);
    await this.box.runIn(bot, ["bash", "-c", `rm -f ${BOX_PROFILE}/Singleton*`], { timeout: 10_000 });
    return (await lastVisitedUrl(browserProfilePath(this.home, bot), since)) || fallback;
  }
}

// ---- The tool ------------------------------------------------------------------

export const TAKEOVER_TOOL = {
  name: "ask_user_to_take_over",
  description: "Ask the user to use your browser themselves, for example to sign in when a site blocks you (\"this browser may not be secure\", a bot check, a CAPTCHA, two-step verification). The user sees a card with a Take control button, signs in on your real screen, and presses Done. You wait until then. Give the reason and the address of the page. Never ask for a password in chat. Do not retry the blocked step yourself first.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "One sentence for the user: what you are blocked on and what they should do." },
      url: { type: "string", description: "http or https address of the page to start on. Defaults to the page your browser is on." },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

export async function askUserToTakeOver(args, ctx) {
  const { bot, live, engine, browser } = ctx;
  const approvals = engine?.approvals;
  if (!live || !approvals) return { text: "Taking over is not available on this server. Say in your reply which site you could not sign in to, and ask the user to sign in another way." };
  if (live.isHandedOver(bot.id)) return { text: HANDED_OVER_MESSAGE };
  const found = await live.available(bot);
  if (!found.ok) return { text: `The user cannot take over this browser from here: ${found.reason} Say in your reply which site you could not sign in to.` };

  const reason = String(args.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
  let url = "";
  if (args.url) {
    try {
      url = normalizeUrl(args.url);
    } catch {
      // Use the page the browser is on.
    }
  }
  url ||= live.currentUrl(bot);
  const id = crypto.randomUUID();
  const answer = await approvals.request({
    ...(engine.approvalMeta?.(bot.id) || {}),
    id,
    bot,
    kind: "takeover",
    title: reason ? reason.slice(0, 140) : `${bot.name} needs you to sign in`,
    detail: url ? `Page: ${url}` : "",
    onceOnly: true,
    data: { url, reason },
    signal: engine.active?.get(bot.id)?.abort?.signal,
  });
  const status = approvals.records.find((item) => item.id === id)?.status || "";
  // The user may still have the browser (they declined, it timed out, or the turn stopped while they signed in).
  if (live.isHandedOver(bot.id)) await live.handBack(bot).catch(() => {});
  if (answer === "reject") {
    if (status === "expired") return { text: "The user did not respond in time, so the sign-in did not happen. Do not retry. Tell them what you needed." };
    if (status === "cancelled") return { text: "The request was cancelled." };
    return { text: "The user declined to take over. Do not retry. Tell them what you could not do." };
  }
  const session = await browser.ensure(bot);
  await session.refreshMeta();
  return { text: `The user finished. The browser is back at ${session.url} (${session.title || "untitled"}).`, activity: "The user finished signing in" };
}

// ---- Static files for noVNC ------------------------------------------------------

// noVNC's ES modules, served from node_modules like the terminal's xterm.js.
export function novncFile(pathname, root) {
  const match = /^\/vendor\/novnc\/((?:core|vendor)\/[A-Za-z0-9_./-]+\.js)$/.exec(pathname);
  if (!match) return null;
  const base = path.resolve(root, "node_modules", "@novnc", "novnc");
  const file = path.resolve(base, match[1]);
  if (!file.startsWith(`${base}${path.sep}`) || !fs.existsSync(file)) return null;
  return [path.join("@novnc", "novnc", path.relative(base, file)), "text/javascript; charset=utf-8"];
}

// ---- Helpers ---------------------------------------------------------------------

function shortReason(message) {
  // A WebSocket close reason is at most 123 bytes.
  return Buffer.from(String(message || "The live view failed.")).subarray(0, 120).toString("utf8").replace(/�/g, "");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, ms, alive = () => true) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive()) throw new Error("exited");
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await sleep(120);
  }
  throw new Error("timeout");
}

// Chromium's profile lock is the symlink SingletonLock ("host-pid"). A lock whose
// process is gone is stale (a browser that was killed leaves one) and is removed at
// once; one whose process is alive past the timeout is an error.
async function waitForProfileFree(profile, ms) {
  const lock = path.join(profile, "SingletonLock");
  const until = Date.now() + ms;
  for (;;) {
    let owner = "";
    try {
      owner = await fsp.readlink(lock);
    } catch {
      return;
    }
    const split = owner.lastIndexOf("-");
    const pid = Number(owner.slice(split + 1));
    if (split > 0 && owner.slice(0, split) === os.hostname() && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) await fsp.rm(path.join(profile, name), { force: true });
      return;
    }
    if (Date.now() >= until) break;
    await sleep(200);
  }
  throw new LiveError("The browser did not let go of its profile in time.");
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// One short command; its stdout, or "" when it fails.
function execQuiet(file, args, { env, timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { env: env || process.env, timeout, encoding: "utf8" }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

function whichOnPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Keep looking.
    }
  }
  return "";
}
