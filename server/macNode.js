import crypto from "node:crypto";
import { ownerPossessive } from "./owner.js";

// The user's Mac as a second computer for every bot. Bots live on the hub; a
// small runner on the Mac (bin/mac-node.mjs) dials out to the hub over the
// tailnet and keeps one WebSocket open. The hub sends it one operation at a
// time per call (run, read, write, list) and the runner answers. Nothing listens
// on the Mac. When the Mac goes away mid-task, the bots that were using it tell
// the user, and they hear again when it is back.

export const MAC_PATH = "/api/mac/connect";
const HELLO_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const DEAD_MS = 45_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
// A runner that says it acknowledges calls (features: ["ack"]) answers "ack" as soon as one arrives.
// No ack this soon means the socket is gone (the Mac slept or lost the network) even if the
// heartbeat has not noticed yet, so the bot hears it in seconds instead of waiting.
const ACK_MS = 10_000;
const RECENT_MS = 15 * 60_000; // a bot that used the Mac this recently counts as working on it

export const MAC_TOOLS = ["mac_status", "mac_run", "mac_read_file", "mac_write_file", "mac_list"];

export class MacNode {
  // owner returns { name } so messages can say whose Mac it is.
  constructor({ token = "", notifications = null, now = () => Date.now(), owner = () => ({}), ackMs = ACK_MS } = {}) {
    this.token = String(token || "");
    this.ackMs = ackMs;
    this.owner = owner;
    this.notifications = notifications;
    this.now = now;
    this.socket = null;
    this.info = null; // { host, home, user, roots }
    this.since = 0;
    this.lastSeen = 0;
    this.pending = new Map(); // call id -> { resolve, reject, timer, botId }
    this.work = new Map(); // bot id -> { name, cwd, at }
    this.interrupted = new Map(); // bot id -> { name, cwd } waiting for the Mac to come back
    this.heartbeat = null;
  }

  get configured() {
    return Boolean(this.token);
  }

  get online() {
    return Boolean(this.socket && this.info);
  }

  #whose() {
    const whose = ownerPossessive(this.owner?.() || {});
    return whose.charAt(0).toUpperCase() + whose.slice(1);
  }

  status() {
    return {
      configured: this.configured,
      online: this.online,
      since: this.online ? this.since : 0,
      lastSeen: this.lastSeen,
      host: this.info?.host || "",
      home: this.info?.home || "",
      roots: this.info?.roots || [],
    };
  }

  // A new socket from the runner. It must say hello with the token first.
  attach(ws) {
    let ready = false;
    const helloTimer = setTimeout(() => {
      if (!ready) ws.close(4001, "hello required");
    }, HELLO_MS);
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!ready) {
        if (message?.type !== "hello" || !this.configured || !safeEqual(String(message.token || ""), this.token)) {
          clearTimeout(helloTimer);
          ws.close(4003, "bad token");
          return;
        }
        ready = true;
        clearTimeout(helloTimer);
        this.#connect(ws, message);
        return;
      }
      this.lastSeen = this.now();
      if (message?.type === "ping") return send(ws, { type: "pong" });
      if (message?.type === "ack") this.#acked(message.id);
      if (message?.type === "result") this.#settle(message);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.socket === ws) this.#disconnect();
    });
    ws.on("error", () => ws.terminate?.());
  }

  #connect(ws, hello) {
    // A newer connection replaces an old one (the Mac woke up before the old socket timed out).
    if (this.socket && this.socket !== ws) {
      const old = this.socket;
      this.socket = null;
      this.#failPending("Your Mac reconnected; run that again.");
      try {
        old.close(4000, "replaced");
      } catch {
        // Already closed.
      }
    }
    this.socket = ws;
    this.info = {
      host: String(hello.host || "Mac").slice(0, 80),
      home: String(hello.home || "").slice(0, 200),
      user: String(hello.user || "").slice(0, 80),
      roots: Array.isArray(hello.roots) ? hello.roots.map(String).slice(0, 10) : [],
      ack: Array.isArray(hello.features) && hello.features.includes("ack"),
    };
    this.since = this.now();
    this.lastSeen = this.since;
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.socket !== ws) return;
      if (this.now() - this.lastSeen > DEAD_MS) {
        try {
          ws.terminate?.() ?? ws.close();
        } catch {
          // Gone.
        }
        this.#disconnect();
        return;
      }
      send(ws, { type: "ping" });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    send(ws, { type: "welcome" });
    this.#announceBack();
  }

  #disconnect() {
    if (!this.socket && !this.info) return;
    this.socket = null;
    this.info = null;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    const busy = new Set([...this.pending.values()].map((item) => item.botId));
    this.#failPending(`${this.#whose()} Mac went offline (closed, asleep or off the network). Stop the Mac part of this task, tell the user where you were, and continue when the Mac is back.`);
    const cutoff = this.now() - RECENT_MS;
    for (const [botId, work] of this.work) {
      if (!busy.has(botId) && work.at < cutoff) continue;
      this.interrupted.set(botId, work);
      this.notifications?.notify({
        botId,
        botName: work.name,
        kind: "message",
        title: `${work.name}: your Mac went offline`,
        body: `We were working on your Mac${work.cwd ? ` in ${work.cwd}` : ""}. I'll pick it up when the Mac is back.`,
        url: `/?bot=${botId}`,
        tag: `mac-offline-${botId}`,
      })?.catch?.(() => {});
    }
    this.work.clear();
  }

  #announceBack() {
    for (const [botId, work] of this.interrupted) {
      this.notifications?.notify({
        botId,
        botName: work.name,
        kind: "message",
        title: `${work.name}: your Mac is back`,
        body: `Open ${work.name} and say "continue" to pick up${work.cwd ? ` in ${work.cwd}` : ""}.`,
        url: `/?bot=${botId}`,
        tag: `mac-offline-${botId}`,
      })?.catch?.(() => {});
    }
    this.interrupted.clear();
  }

  #failPending(reason) {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      clearTimeout(item.ackTimer);
      item.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  #acked(id) {
    const item = this.pending.get(id);
    if (!item) return;
    clearTimeout(item.ackTimer);
    item.ackTimer = null;
  }

  #settle(message) {
    const item = this.pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    clearTimeout(item.ackTimer);
    this.pending.delete(message.id);
    if (message.error) item.reject(Object.assign(new Error(String(message.error)), { expected: true }));
    else item.resolve(message.data ?? {});
  }

  // Runs one operation on the Mac for a bot. Throws a plain message when the Mac is offline.
  call(bot, op, args = {}, { timeout = CALL_TIMEOUT_MS, cwd = "" } = {}) {
    if (!this.configured) return Promise.reject(new Error("The Mac link is not set up on this server."));
    if (!this.online) return Promise.reject(new Error(`${this.#whose()} Mac is offline right now (closed, asleep or off the network). Tell the user, and do the Mac part when it is back.`));
    const id = crypto.randomUUID();
    this.work.set(bot.id, { name: bot.name, cwd: cwd || this.work.get(bot.id)?.cwd || "", at: this.now() });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The Mac did not answer in time."));
      }, timeout + 5_000);
      const socket = this.socket;
      const sentAt = this.now();
      const ackTimer = this.info?.ack ? setTimeout(() => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${this.#whose()} Mac did not pick up the command within ${Math.round(this.ackMs / 1000)} s, so its connection is probably gone (asleep or off the network). Tell the user, and do the Mac part when it is back.`));
        // Nothing at all came from it since: the socket is dead, so drop it and let the runner dial again.
        if (this.socket === socket && this.lastSeen <= sentAt) {
          try {
            socket.terminate?.() ?? socket.close();
          } catch {
            // Gone.
          }
          this.#disconnect();
        }
      }, this.ackMs) : null;
      ackTimer?.unref?.();
      this.pending.set(id, { resolve, reject, timer, ackTimer, botId: bot.id });
      send(socket, { type: "call", id, op, args: { ...args, timeout } });
    });
  }

  close() {
    clearInterval(this.heartbeat);
    this.#failPending("The server is restarting.");
  }
}

// --- Rules ------------------------------------------------------------------

// Places on the Mac a bot never touches without asking, whatever its rules say.
const SENSITIVE = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/,
  /(^|\/)\.config\/op(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.env(\.[\w-]+)?$/,
  /(^|\/)Library\/(Cookies|Application Support\/[^/]+\/(Cookies|Login Data|Local State))/,
  /secrets?\.(json|enc|ya?ml)$/i,
];
const SENSITIVE_COMMAND = /(\bsecurity\s+(find|dump|export)|\bop\s+(read|item|signin)|\.ssh\/|Keychains|\.env\b|\bsudo\b|\brm\s+-[a-z]*r[a-z]*f?\s+(~|\/|\$HOME)\s*$|\bcurl\b[^|]*\|\s*(ba|z)?sh)/;

export function sensitiveMacPath(file) {
  const text = String(file || "");
  return SENSITIVE.some((rule) => rule.test(text));
}

export function sensitiveMacCommand(command) {
  return SENSITIVE_COMMAND.test(String(command || ""));
}

// Inside one of the Mac's work folders (the runner reports them, default ~/Desktop/Projects).
export function insideMacRoots(file, { home = "", roots = [] } = {}) {
  const full = expandHome(file, home);
  return roots.some((root) => {
    const base = expandHome(root, home).replace(/\/+$/, "");
    return base && (full === base || full.startsWith(`${base}/`)) && !full.split("/").includes("..");
  });
}

export function expandHome(file, home = "") {
  const text = String(file || "").trim();
  if (text === "~") return home;
  if (text.startsWith("~/")) return `${home}/${text.slice(2)}`;
  return text;
}

function send(ws, message) {
  try {
    if (ws && (ws.readyState === undefined || ws.readyState === 1)) ws.send(JSON.stringify(message));
  } catch {
    // The close handler cleans up.
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
