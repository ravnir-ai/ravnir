import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommand, collectOutput } from "./computer.js";
import { DESKTOP, xKey } from "./desktop.js";
import { botHome, browserProfilePath, normalizeBox, workspacePath } from "./state.js";

// A bot's own computer: one rootless container per bot (Podman on the hub,
// Docker on a Mac for development). Root inside, apt works, services keep
// running between turns. The design is in docs/own-computer.md.
//
// Off unless RAVNIR_BOX is "podman" or "docker", and then only for bots whose
// `box.mode` is "container". Every other bot keeps running on the host.

const BOX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "box");
const RUNTIMES = new Set(["podman", "docker"]);
const CDP_PORT = 9222;
const BOOT_MS = 15_000;
const BROWSER_BOOT_MS = 20_000;
const BUILD_MS = 45 * 60_000;

// User-level installs and dotfiles copied from the old host box home on the first
// start. Caches are left behind; they rebuild themselves.
export const MIGRATE_ENTRIES = [".local", ".npm-global", ".cargo", "go", ".bun", ".config", ".gitconfig", ".bashrc", ".profile", ".ssh"];

export function boxSettings(env = process.env) {
  const runtime = String(env.RAVNIR_BOX || "").trim().toLowerCase();
  return {
    runtime: RUNTIMES.has(runtime) ? runtime : "",
    image: env.RAVNIR_BOX_IMAGE || "ravnir-box:3",
    memory: env.RAVNIR_BOX_MEMORY || "2g",
    cpus: env.RAVNIR_BOX_CPUS || "2",
    pids: env.RAVNIR_BOX_PIDS || "2048",
    network: env.RAVNIR_BOX_NETWORK || "",
  };
}

export function boxName(bot) {
  return `ravnir-box-${String(bot.id).toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
}

// Boxes made before the rename carry the old product name.
export function legacyBoxName(bot) {
  return boxName(bot).replace(/^ravnir-box-/, "truebot-box-");
}

export function boxHostname(bot) {
  const slug = String(bot.name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "box";
}

export function boxPaths(home, bot) {
  const dir = path.join(botHome(home, bot), "box");
  return {
    dir,
    root: path.join(dir, "root"),
    marker: path.join(dir, "root", ".ravnir", "migrated.json"),
    setup: path.join(dir, "root", ".ravnir", "setup.sh"),
  };
}

// The `run` arguments for a bot's box. The workspace is mounted at the same
// absolute path it has on the host, so OpenCode (which runs on the host) and
// the box agree on every path.
export function runArgs(bot, { home, settings = boxSettings(), timeZone = defaultTimeZone() }) {
  const workspace = workspacePath(home, bot);
  const paths = boxPaths(home, bot);
  return [
    "run", "-d",
    "--name", boxName(bot),
    "--hostname", boxHostname(bot),
    "--init",
    "--restart", "unless-stopped",
    "--memory", settings.memory,
    "--cpus", settings.cpus,
    "--pids-limit", settings.pids,
    "--shm-size", "1g",
    "--label", `ravnir.bot=${bot.id}`,
    "-e", `TZ=${timeZone}`,
    "-e", `RAVNIR_WORKSPACE=${workspace}`,
    "-e", `TRUEBOT_WORKSPACE=${workspace}`,
    "-v", `${workspace}:${workspace}`,
    "-v", `${paths.root}:/root`,
    "-v", `${browserProfilePath(home, bot)}:/root/.config/ravnir-browser`,
    "-w", workspace,
    ...(settings.network ? ["--network", settings.network] : []),
    settings.image,
  ];
}

// One command inside the box. `timeout` runs inside, because killing the exec
// client does not stop the command in the container.
export function execArgs(bot, command, { home, timeoutMs = 90_000, cwd = "", envNames = [] }) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    "exec", "-i",
    // Names only: the values travel in the client's environment, never in the process list.
    ...envNames.flatMap((name) => ["-e", name]),
    "-w", cwd || workspacePath(home, bot),
    boxName(bot),
    "timeout", "-k", "5", String(seconds),
    "bash", "-lc", command,
  ];
}

export function shellArgs(bot, { home, cols, rows, envNames = [] }) {
  return [
    "exec", "-i",
    "-e", "TERM=xterm-256color",
    "-e", "COLORTERM=truecolor",
    ...envNames.flatMap((name) => ["-e", name]),
    "-w", workspacePath(home, bot),
    boxName(bot),
    "python3", "-I", "/opt/ravnir/term-bridge.py", String(cols), String(rows), "--", "bash", "-l",
  ];
}

// Variable names pass through to `exec -e NAME`, so only plain names with a value are allowed.
function safeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string" && value) out[key] = value;
  return out;
}

export class BoxManager {
  constructor({ home, settings = boxSettings(), cli, playwrightVersion = installedPlaywright() }) {
    this.home = home;
    this.settings = settings;
    this.cli = cli || runCli(settings.runtime);
    this.playwrightVersion = playwrightVersion;
    this.known = new Map();
    this.checkedAt = new Map();
    this.errors = new Map();
    this.starting = new Map();
    this.gates = new Map();
    this.building = null;
  }

  get enabled() {
    return Boolean(this.settings.runtime);
  }

  uses(bot) {
    return this.enabled && normalizeBox(bot?.box).mode === "container";
  }

  async state(bot) {
    if (!this.enabled) return "off";
    const result = await this.cli(["inspect", "--format", "{{.State.Status}}", boxName(bot)], { timeout: 15_000 });
    const state = result.code === 0 ? String(result.stdout).trim() || "unknown" : "missing";
    this.known.set(bot.id, state);
    this.checkedAt.set(bot.id, Date.now());
    return state;
  }

  async status(bot) {
    const mode = normalizeBox(bot.box).mode;
    const base = {
      enabled: this.enabled,
      runtime: this.settings.runtime,
      image: this.settings.image,
      mode,
      name: boxName(bot),
      limits: { memory: this.settings.memory, cpus: this.settings.cpus, pids: this.settings.pids },
    };
    if (!this.enabled || mode !== "container") return { ...base, state: mode === "container" ? "off" : "host" };
    const state = this.starting.has(bot.id) ? "starting" : await this.state(bot);
    return { ...base, state, building: Boolean(this.building), error: this.errors.get(bot.id) || "" };
  }

  // Starts the bot's box, creating it (and the image) on first use.
  async ensure(bot) {
    if (!this.enabled) throw new Error("Own computers are off on this server. Set RAVNIR_BOX to podman or docker.");
    if (this.starting.has(bot.id)) return this.starting.get(bot.id);
    // Checked a moment ago: skip the inspect call on every command.
    if (this.known.get(bot.id) === "running" && Date.now() - (this.checkedAt.get(bot.id) || 0) < 5_000) return;
    const promise = this.#start(bot)
      .then(() => this.errors.delete(bot.id))
      .catch((error) => {
        this.errors.set(bot.id, error.message);
        throw error;
      })
      .finally(() => this.starting.delete(bot.id));
    this.starting.set(bot.id, promise);
    return promise;
  }

  async #start(bot) {
    const name = boxName(bot);
    const state = await this.state(bot);
    if (state === "running") return;
    if (state === "paused") await this.#must(["unpause", name]);
    else if (state !== "missing") await this.#must(["start", name], { timeout: 60_000 });
    else {
      await this.ensureImage();
      await this.#retireLegacy(bot);
      await this.prepare(bot);
      await this.#must(runArgs(bot, { home: this.home, settings: this.settings }), { timeout: 120_000 });
    }
    await this.#waitFor(() => this.#run(bot, ["xdpyinfo"], { timeout: 5_000 }).then((result) => result.code === 0), BOOT_MS, "The computer did not start its desktop.");
    this.known.set(bot.id, "running");
    this.checkedAt.set(bot.id, Date.now());
  }

  async ensureImage() {
    const found = await this.cli(["image", "inspect", this.settings.image], { timeout: 15_000 });
    if (found.code === 0) return;
    if (!this.building) {
      const log = path.join(this.home, "box-build.log");
      this.building = this.cli([
        "build", "-t", this.settings.image,
        "--build-arg", `PLAYWRIGHT_VERSION=${this.playwrightVersion}`,
        BOX_DIR,
      ], { timeout: BUILD_MS, log })
        .then((result) => {
          if (result.code !== 0) throw new Error(`Building the computer image failed. The log is in ${log}.`);
        })
        .finally(() => {
          this.building = null;
        });
    }
    return this.building;
  }

  // A box from before the rename (truebot-box-<id>) is replaced by a new one. Its /root, workspace
  // and browser profile are host bind mounts and carry over; anything else in its container layer
  // (apt installs, files outside /root) does not, so the old container is only stopped, never removed:
  // its files stay recoverable with "podman cp" until the computer is reset.
  async #retireLegacy(bot) {
    const name = legacyBoxName(bot);
    const found = await this.cli(["inspect", "--format", "{{.State.Status}}", name], { timeout: 15_000 });
    if (found.code !== 0) return;
    const stopped = await this.cli(["stop", "-t", "5", name], { timeout: 60_000 });
    if (stopped.code !== 0 && !/no such|not found|not running|already stopped/i.test(String(stopped.stderr))) {
      throw new Error(`Stopping the old computer failed: ${String(stopped.stderr).slice(0, 300)}`);
    }
  }

  // Folders on the host for the box, and a one-time copy of the old box home.
  async prepare(bot) {
    const paths = boxPaths(this.home, bot);
    // The bot's setup.sh, autostart.sh and migration marker lived in /root/.truebot before the rename.
    const legacy = path.join(paths.root, ".truebot");
    const current = path.dirname(paths.marker);
    if (fs.existsSync(legacy) && !fs.existsSync(current)) await fsp.rename(legacy, current);
    await fsp.mkdir(path.dirname(paths.marker), { recursive: true });
    await fsp.mkdir(workspacePath(this.home, bot), { recursive: true });
    await fsp.mkdir(browserProfilePath(this.home, bot), { recursive: true });
    if (!fs.existsSync(paths.setup)) {
      await fsp.writeFile(paths.setup, "#!/bin/bash\n# System packages this bot installed. Replayed when its computer is rebuilt.\nset -e\n", { mode: 0o755 });
    }
    if (fs.existsSync(paths.marker)) return [];
    const from = botHome(this.home, bot);
    const copied = [];
    for (const entry of MIGRATE_ENTRIES) {
      const source = path.join(from, entry);
      const target = path.join(paths.root, entry);
      if (!fs.existsSync(source) || fs.existsSync(target)) continue;
      await fsp.cp(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      copied.push(entry);
    }
    await fsp.writeFile(paths.marker, JSON.stringify({ at: new Date().toISOString(), copied }, null, 2));
    return copied;
  }

  async exec(bot, command, { timeout = 90_000, cwd = "", env = {} } = {}) {
    checkCommand(command);
    await this.ensure(bot);
    const extra = safeEnv(env);
    const child = spawn(this.settings.runtime, execArgs(bot, command, { home: this.home, timeoutMs: timeout, cwd, envNames: Object.keys(extra) }), {
      stdio: ["ignore", "pipe", "pipe"],
      ...(Object.keys(extra).length ? { env: { ...process.env, ...extra } } : {}),
    });
    // The timeout inside the box fires first; this one only catches a stuck client.
    return collectOutput(child, timeout + 15_000);
  }

  // An interactive shell for the terminal. The caller frames stdin (see box/term-bridge.py).
  async shell(bot, { cols, rows, env = {} }) {
    await this.ensure(bot);
    const extra = safeEnv(env);
    return spawn(this.settings.runtime, shellArgs(bot, { home: this.home, cols, rows, envNames: Object.keys(extra) }), {
      stdio: ["pipe", "pipe", "pipe"],
      ...(Object.keys(extra).length ? { env: { ...process.env, ...extra } } : {}),
    });
  }

  async screenshot(bot) {
    const result = await this.#run(bot, ["import", "-silent", "-window", "root", "png:-"], { timeout: 15_000, encoding: "buffer" });
    if (result.code !== 0 || !result.stdout?.length) throw new Error(`The desktop screenshot failed: ${String(result.stderr).slice(0, 200)}`);
    return result.stdout;
  }

  async xdotool(bot, args, { timeout = 15_000 } = {}) {
    const result = await this.#run(bot, ["xdotool", ...args], { timeout });
    if (result.code !== 0) throw new Error(`xdotool failed: ${String(result.stderr).slice(0, 200)}`);
  }

  // Live view (server/live.js) runs its own commands in the box: one command and
  // wait, one detached, and one with its stdio piped (the VNC bridge).
  async runIn(bot, command, options) {
    await this.ensure(bot);
    return this.#run(bot, command, options);
  }

  async execDetached(bot, command) {
    await this.ensure(bot);
    return this.#must(["exec", "-d", boxName(bot), ...command]);
  }

  spawnIn(bot, command) {
    return spawn(this.settings.runtime, ["exec", "-i", boxName(bot), ...command], { stdio: ["pipe", "pipe", "ignore"] });
  }

  // A DevTools WebSocket URL for Playwright's connectOverCDP. See BoxGate below.
  async browserEndpoint(bot) {
    await this.ensure(bot);
    let target = await this.#devtoolsPath(bot);
    if (!target) {
      // A browser that is running without DevTools is a plain one left behind (the
      // user signed in through the live view and the server restarted). A second
      // Chromium on the same profile would hand its request to it and exit.
      await this.#run(bot, ["pkill", "-TERM", "-x", "chrome"], { timeout: 5_000 });
      await this.#waitFor(async () => (await this.#run(bot, ["pgrep", "-x", "chrome"], { timeout: 5_000 })).code !== 0, 8_000, "").catch(() => {});
      await this.#run(bot, ["pkill", "-KILL", "-x", "chrome"], { timeout: 5_000 });
      await this.#must(["exec", "-d", boxName(bot), "/opt/ravnir/browser.sh"]);
      await this.#waitFor(async () => {
        target = await this.#devtoolsPath(bot);
        return Boolean(target);
      }, BROWSER_BOOT_MS, "The browser in this bot's computer did not start.");
    }
    let gate = this.gates.get(bot.id);
    if (!gate) {
      gate = new BoxGate({ connect: () => spawn(this.settings.runtime, ["exec", "-i", boxName(bot), "socat", "STDIO", `TCP:127.0.0.1:${CDP_PORT}`], { stdio: ["pipe", "pipe", "ignore"] }) });
      await gate.listen();
      this.gates.set(bot.id, gate);
    }
    gate.allow(target);
    return `ws://127.0.0.1:${gate.port}${target}`;
  }

  async #devtoolsPath(bot) {
    const result = await this.#run(bot, ["curl", "-s", "--max-time", "2", `http://127.0.0.1:${CDP_PORT}/json/version`], { timeout: 10_000 });
    if (result.code !== 0) return "";
    try {
      return new URL(JSON.parse(result.stdout).webSocketDebuggerUrl).pathname;
    } catch {
      return "";
    }
  }

  async stop(bot) {
    this.#closeGate(bot.id);
    this.known.set(bot.id, "exited");
    await this.#must(["stop", "-t", "5", boxName(bot)], { timeout: 60_000 });
  }

  // Throws the container layer away: apt installs and anything outside /root go.
  // /root, the workspace and the browser profile are bind mounts and stay.
  async reset(bot) {
    this.#closeGate(bot.id);
    this.known.set(bot.id, "missing");
    const result = await this.cli(["rm", "-f", boxName(bot)], { timeout: 60_000 });
    if (result.code !== 0 && !/no such|not found/i.test(String(result.stderr))) {
      throw new Error(`Removing the computer failed: ${String(result.stderr).slice(0, 300)}`);
    }
    // The stopped pre-rename container, kept until now so nothing in it was lost by the rename.
    await this.cli(["rm", "-f", legacyBoxName(bot)], { timeout: 60_000 });
  }

  closeGates() {
    for (const id of [...this.gates.keys()]) this.#closeGate(id);
  }

  #closeGate(botId) {
    this.gates.get(botId)?.close();
    this.gates.delete(botId);
  }

  #run(bot, command, options) {
    return this.cli(["exec", boxName(bot), ...command], options);
  }

  async #must(args, options) {
    const result = await this.cli(args, options);
    if (result.code !== 0) throw new Error(`${this.settings.runtime} ${args[0]} failed: ${String(result.stderr || result.stdout).trim().slice(0, 400)}`);
    return result;
  }

  async #waitFor(check, ms, message) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check().catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(message);
  }
}

// DevTools on port 9222 inside the box is never published: any account on the
// hub could drive the browser through it. Playwright connects to this gate on
// 127.0.0.1 instead. It admits only a WebSocket upgrade for the browser's own
// random DevTools path, which the server read through exec and never shares, and
// pipes each admitted connection into the box through `exec socat`.
export class BoxGate {
  constructor({ connect }) {
    this.connect = connect;
    this.target = "";
    this.port = 0;
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.#admit(socket));
  }

  allow(target) {
    this.target = target;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this);
      });
    });
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }

  #admit(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 16_384) socket.destroy();
        return;
      }
      socket.off("data", onData);
      socket.pause();
      socket.setTimeout(0);
      if (!admits(head.subarray(0, end).toString("latin1"), this.target)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const pipe = this.connect();
      const finish = () => {
        socket.destroy();
        pipe.stdin.destroy();
        pipe.kill();
      };
      pipe.on("error", finish);
      pipe.on("exit", () => socket.destroy());
      socket.on("close", finish);
      pipe.stdin.on("error", finish);
      pipe.stdin.write(head);
      socket.pipe(pipe.stdin);
      pipe.stdout.pipe(socket);
      socket.resume();
    };
    socket.on("data", onData);
  }
}

// GET <exact DevTools path> with an Upgrade: websocket header, nothing else.
export function admits(requestHead, target) {
  if (!target) return false;
  const [line, ...headers] = String(requestHead).split("\r\n");
  const [method, requested] = line.split(" ");
  if (method !== "GET" || typeof requested !== "string") return false;
  const given = Buffer.from(requested);
  const wanted = Buffer.from(target);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return false;
  return headers.some((header) => /^upgrade:\s*websocket\s*$/i.test(header));
}

// The desktop of a bot with a box: the same calls as DesktopManager, carried
// out inside the box through exec.
export class BoxDesktop {
  constructor(box) {
    this.box = box;
    this.width = DESKTOP.width;
    this.height = DESKTOP.height;
    this.shots = new Map();
  }

  status(bot) {
    const state = this.box.known.get(bot.id) || "unknown";
    return { running: state === "running", display: ":1", available: true, width: this.width, height: this.height, box: true, state };
  }

  async ensure(bot) {
    await this.box.ensure(bot);
    return { display: ":1", env: {}, alive: true, box: true };
  }

  async screenshot(bot, { force = false } = {}) {
    if (this.box.known.get(bot.id) !== "running") return null;
    const cached = this.shots.get(bot.id);
    if (!force && cached && Date.now() - cached.at < 500) return cached.png;
    const png = await this.box.screenshot(bot);
    this.shots.set(bot.id, { png, at: Date.now() });
    return png;
  }

  async click(bot, x, y) {
    this.require(bot);
    await this.box.xdotool(bot, ["mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1"]);
  }

  async type(bot, text) {
    this.require(bot);
    await this.box.xdotool(bot, ["type", "--delay", "18", "--clearmodifiers", String(text)], { timeout: 30_000 });
  }

  async key(bot, name) {
    this.require(bot);
    await this.box.xdotool(bot, ["key", xKey(name)]);
  }

  async scroll(bot, dy) {
    this.require(bot);
    const button = Number(dy) < 0 ? "4" : "5";
    const repeats = Math.max(1, Math.min(12, Math.round(Math.abs(Number(dy) || 800) / 120)));
    await this.box.xdotool(bot, ["mousemove", String(Math.round(this.width / 2)), String(Math.round(this.height / 2)), "click", "--repeat", String(repeats), button]);
  }

  require(bot) {
    if (this.box.known.get(bot.id) !== "running") throw new Error("This bot's computer is not running.");
  }

  displayFor() {
    return ":1";
  }

  envFor() {
    return {};
  }

  async close() {}

  async closeAll() {}
}

// Hands each desktop call to the host Xvfb or to the bot's box.
export class DesktopRouter {
  constructor({ host, box }) {
    this.host = host;
    this.box = box;
    this.boxDesktop = new BoxDesktop(box);
    this.width = host.width;
    this.height = host.height;
  }

  pick(bot) {
    return this.box?.uses(bot) ? this.boxDesktop : this.host;
  }

  status(bot) { return this.pick(bot).status(bot); }
  ensure(bot, home) { return this.pick(bot).ensure(bot, home); }
  screenshot(bot, options) { return this.pick(bot).screenshot(bot, options); }
  click(bot, x, y) { return this.pick(bot).click(bot, x, y); }
  type(bot, text) { return this.pick(bot).type(bot, text); }
  key(bot, name) { return this.pick(bot).key(bot, name); }
  scroll(bot, dy) { return this.pick(bot).scroll(bot, dy); }
  require(bot) { return this.pick(bot).require(bot); }
  displayFor(bot) { return this.pick(bot).displayFor(bot); }
  envFor(bot) { return this.pick(bot).envFor(bot); }
  close(botId) { return this.host.close(botId); }
  closeAll() { return this.host.closeAll(); }
}

function runCli(runtime) {
  return (args, { timeout = 30_000, encoding = "utf8", log = "" } = {}) => new Promise((resolve) => {
    if (log) {
      const out = fs.createWriteStream(log, { flags: "a" });
      const child = spawn(runtime, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        out.end();
        resolve({ code: 1, stdout: "", stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        out.end();
        resolve({ code: code ?? 1, stdout: "", stderr: code ? `See ${log}.` : "" });
      });
      return;
    }
    execFile(runtime, args, { timeout, encoding, maxBuffer: 64_000_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: String(stderr || (error && !stdout ? error.message : "") || "") });
    });
  });
}

function installedPlaywright() {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "playwright", "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch {
    return "1.64.1";
  }
}

function defaultTimeZone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
