// OpenCode run by Ravnir itself: one `opencode serve` on loopback with a password only Ravnir
// knows, its config and provider logins kept under <home>/opencode, restarted if it dies. The
// server image turns it on (RAVNIR_OPENCODE=managed); a plain `npm start` can turn it on from
// the first-run wizard when the opencode binary is installed. Nobody ever sees the password.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { childEnv } from "./childEnv.js";
import { openCodeRequest } from "./providers/opencode.js";

const SECRET = "server:opencode-managed";
const DEFAULT_PORT = 4097;
const READY_MS = 90_000;
const CHECK_MS = 30_000;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const LOG_LINES = 40;
// Written once; the owner can edit it afterwards. No update checks and no public share links.
const GLOBAL_CONFIG = { $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled" };

export class ManagedOpenCode {
  #child = null;
  #stopping = false;
  #restarts = 0;
  #timer = null;
  #monitor = null;
  #ready = false;
  #startedAt = 0;
  #error = "";
  #log = [];
  #starting = null;

  // wanted() says whether it should run now (env or the saved setting); bin overrides the lookup.
  constructor({ home, secrets, wanted = () => false, env = process.env, bin = "", spawnImpl = spawn } = {}) {
    this.home = home;
    this.secrets = secrets;
    this.wanted = wanted;
    this.env = env;
    this.binOverride = bin;
    this.spawn = spawnImpl;
    this.port = Number(env.RAVNIR_OPENCODE_PORT) || DEFAULT_PORT;
    this.dir = path.join(home, "opencode");
  }

  get enabled() {
    return Boolean(this.wanted());
  }

  bin() {
    return this.binOverride || this.env.RAVNIR_OPENCODE_BIN || which("opencode", this.env.PATH);
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  password() {
    let value = this.secrets.get(SECRET, "");
    if (!value) {
      value = crypto.randomBytes(24).toString("base64url");
      this.secrets.set(SECRET, value);
    }
    return value;
  }

  // What models.js uses as the server's OpenCode while this is on. The address is fixed, so
  // agents keep a working baseUrl across restarts.
  connection() {
    if (!this.enabled) return null;
    return { baseUrl: this.baseUrl, username: "opencode", apiKey: this.password(), source: "managed" };
  }

  status() {
    return {
      enabled: this.enabled,
      installed: Boolean(this.bin()),
      running: this.#ready,
      baseUrl: this.enabled ? this.baseUrl : "",
      pid: this.#child?.pid || null,
      startedAt: this.#startedAt || null,
      restarts: this.#restarts,
      error: this.#error || null,
      log: [...this.#log],
    };
  }

  // Starts it if it should run and is not running. Resolves once it answers, or with the error.
  start() {
    if (!this.enabled) return Promise.resolve(this.status());
    if (this.#starting) return this.#starting;
    this.#stopping = false;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    if (!this.#monitor) {
      this.#monitor = setInterval(() => this.#check().catch(() => {}), CHECK_MS);
      this.#monitor.unref?.();
    }
    return this.#starting;
  }

  async #start() {
    const own = await this.#probe();
    if (this.#stopping) return this.status();
    if (own === "ours") {
      // Left over from an earlier run of this server (same password), so it is used as it is.
      this.#ready = true;
      this.#error = "";
      return this.status();
    }
    if (own === "other") {
      this.#ready = false;
      this.#error = `Port ${this.port} is used by another program. Set RAVNIR_OPENCODE_PORT to a free port.`;
      return this.status();
    }
    const bin = this.bin();
    if (!bin) {
      this.#ready = false;
      this.#error = "OpenCode is not installed on this server. Install it with: npm install -g opencode-ai";
      return this.status();
    }
    this.#prepare();
    // stop() may have run while the port was probed; then nothing is started.
    if (this.#stopping) return this.status();
    this.#spawn(bin);
    const ok = await this.#waitReady();
    if (!ok && !this.#error) this.#error = "OpenCode did not answer in time.";
    return this.status();
  }

  #prepare() {
    for (const sub of ["config/opencode", "data", "state", "cache", "home"]) fs.mkdirSync(path.join(this.dir, sub), { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, "config", "opencode", "opencode.json");
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify(GLOBAL_CONFIG, null, 2)}\n`);
  }

  #spawn(bin) {
    const env = childEnv({
      OPENCODE_SERVER_PASSWORD: this.password(),
      HOME: path.join(this.dir, "home"),
      XDG_CONFIG_HOME: path.join(this.dir, "config"),
      XDG_DATA_HOME: path.join(this.dir, "data"),
      XDG_STATE_HOME: path.join(this.dir, "state"),
      XDG_CACHE_HOME: path.join(this.dir, "cache"),
    }, this.env);
    this.#ready = false;
    this.#error = "";
    let child;
    try {
      child = this.spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)], { cwd: this.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.#error = `OpenCode did not start: ${error.message}`;
      return;
    }
    this.#child = child;
    this.#startedAt = Date.now();
    const keep = (chunk) => {
      for (const line of String(chunk).split("\n")) {
        const text = line.trim();
        if (!text) continue;
        // Never keep anything that looks like the password, even if OpenCode prints it.
        this.#log.push(text.replaceAll(this.password(), "[hidden]").slice(0, 300));
      }
      if (this.#log.length > LOG_LINES) this.#log.splice(0, this.#log.length - LOG_LINES);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (error) => {
      this.#error = `OpenCode did not start: ${error.message}`;
    });
    child.on("exit", (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#ready = false;
      if (this.#stopping || !this.enabled) return;
      this.#error = `OpenCode stopped (${signal || `exit ${code}`}). Restarting.`;
      const wait = BACKOFF_MS[Math.min(this.#restarts, BACKOFF_MS.length - 1)];
      this.#restarts += 1;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.start().catch(() => {}), wait);
      this.#timer.unref?.();
    });
  }

  async #waitReady() {
    const until = Date.now() + READY_MS;
    while (Date.now() < until) {
      if (!this.#child || this.#stopping) return false;
      if ((await this.#probe()) === "ours") {
        this.#ready = true;
        this.#error = "";
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  // "ours" (answers to our password and refuses another), "other" (something else holds the port,
  // including an OpenCode with no password) or "none".
  async #probe() {
    const ask = (apiKey) => openCodeRequest({ baseUrl: this.baseUrl, username: "opencode", apiKey }, "GET", "/provider", { timeoutMs: 3_000 }).catch(() => null);
    const result = await ask(this.password());
    if (!result?.ok) return result?.status ? "other" : "none";
    const wrong = await ask(`not-${this.password()}`);
    return wrong?.status === 401 ? "ours" : "other";
  }

  async #check() {
    if (!this.enabled) {
      if (this.#child) await this.stop();
      return;
    }
    if (this.#starting || this.#child && !this.#ready) return;
    const seen = await this.#probe();
    if (seen === "ours") {
      this.#ready = true;
      return;
    }
    this.#ready = false;
    if (!this.#child) await this.start();
  }

  async stop() {
    this.#stopping = true;
    clearTimeout(this.#timer);
    clearInterval(this.#monitor);
    this.#monitor = null;
    // A start in progress sees #stopping and ends before spawning (or right after, when it already had).
    await this.#starting?.catch(() => {});
    this.#ready = false;
    const child = this.#child;
    this.#child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

function which(name, PATH = "") {
  for (const dir of String(PATH).split(path.delimiter)) {
    if (!dir) continue;
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
