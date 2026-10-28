#!/usr/bin/env node
// The Mac side of the Mac link (server/macNode.js). It dials out to the Ravnir
// hub over the tailnet, says hello with its token, and runs what the hub asks:
// a shell command, a file read or write, or a folder listing, as the Mac user.
// A second socket carries agent browsers' connections to sites that refuse the
// hub's network (see connectTunnel below). Nothing listens on the Mac. The hub applies each bot's approval rules before
// a call reaches this runner. No dependencies: Node 22+ has WebSocket built in.
//
// Config: ~/.config/ravnir-mac/config.json
//   { "url": "wss://your-server.example.ts.net:8443/api/mac/connect", "token": "...", "roots": ["~/Projects"] }

import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
// Macs linked while the project was called TrueBot keep their config where it was.
const NEW_CONFIG = path.join(HOME, ".config/ravnir-mac/config.json");
const LEGACY_CONFIG = path.join(HOME, ".config/truebot-mac/config.json");
const CONFIG = process.env.RAVNIR_MAC_CONFIG || process.env.TRUEBOT_MAC_CONFIG
  || (existsSync(NEW_CONFIG) || !existsSync(LEGACY_CONFIG) ? NEW_CONFIG : LEGACY_CONFIG);
// Commands run in a login shell so the user's PATH and tools load: zsh on a Mac, else the user's shell.
const LOGIN_SHELL = existsSync("/bin/zsh") ? "/bin/zsh" : (process.env.SHELL?.startsWith("/") && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh");
const MAX_OUTPUT = 200_000;
const MAX_READ = 512_000;
const MAX_ENTRIES = 500;
// Never served, even if the hub asks.
const REFUSED = [/\/Library\/Keychains(\/|$)/, /\/\.ssh\/id_[^/]*$/, /\/\.config\/(ravnir|truebot)-mac(\/|$)/];

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const roots = (config.roots?.length ? config.roots : ["~/Desktop/Projects"]).map(String);
let delay = 2_000;

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function expand(file, fallback = "~/Desktop/Projects") {
  let text = String(file || "").trim() || fallback;
  if (text === "~") text = HOME;
  else if (text.startsWith("~/")) text = path.join(HOME, text.slice(2));
  return path.resolve(HOME, text);
}

function refuse(full) {
  if (REFUSED.some((rule) => rule.test(full))) throw new Error("The Mac runner does not serve that path.");
}

function connect() {
  const ws = new WebSocket(config.url);
  let alive = 0;
  ws.addEventListener("open", () => {
    // "ack": every call is acknowledged on arrival, so the hub can tell a dead link from a slow command.
    ws.send(JSON.stringify({ type: "hello", token: config.token, host: os.hostname().replace(/\.local$/, ""), home: HOME, user: os.userInfo().username, roots, features: ["ack"] }));
  });
  ws.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === "welcome") {
      delay = 2_000;
      log("connected to", config.url);
      clearInterval(alive);
      alive = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })), 20_000);
      return;
    }
    if (message.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (message.type !== "call") return;
    ws.send(JSON.stringify({ type: "ack", id: message.id }));
    let reply;
    try {
      reply = { type: "result", id: message.id, data: await handle(message.op, message.args || {}) };
    } catch (error) {
      reply = { type: "result", id: message.id, error: error.message || String(error) };
    }
    if (ws.readyState === 1) ws.send(JSON.stringify(reply));
  });
  ws.addEventListener("close", (event) => {
    clearInterval(alive);
    log("disconnected", event.code, event.reason || "");
    if (event.code === 4003) log("the hub rejected the token; check", CONFIG);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  });
  ws.addEventListener("error", () => {});
}

async function handle(op, args) {
  if (op === "run") return run(String(args.command || ""), expand(args.cwd), Number(args.timeout) || 300_000);
  if (op === "read") {
    const full = expand(args.path, "");
    refuse(full);
    const buffer = await fs.readFile(full);
    if (buffer.subarray(0, 8000).includes(0)) throw new Error(`${full} looks like a binary file.`);
    return { path: full, content: buffer.subarray(0, MAX_READ).toString("utf8"), truncated: buffer.length > MAX_READ };
  }
  if (op === "write") {
    const full = expand(args.path, "");
    refuse(full);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const content = String(args.content ?? "");
    await fs.writeFile(full, content);
    return { path: full, bytes: Buffer.byteLength(content) };
  }
  if (op === "list") {
    const full = expand(args.path);
    refuse(full);
    const entries = await fs.readdir(full, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return {
      path: full,
      entries: entries.slice(0, MAX_ENTRIES).map((item) => ({ name: item.name, type: item.isDirectory() ? "dir" : "file" })),
      truncated: entries.length > MAX_ENTRIES,
    };
  }
  throw new Error(`Unknown operation ${op}.`);
}

function run(command, cwd, timeout) {
  if (!command.trim()) throw new Error("Empty command.");
  return new Promise((resolve, reject) => {
    fs.stat(cwd).then((stat) => {
      if (!stat.isDirectory()) return reject(new Error(`${cwd} is not a folder.`));
      const child = spawn(LOGIN_SHELL, ["-lc", command], { cwd, env: { ...process.env, HOME }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let truncated = false;
      const take = (chunk) => {
        if (output.length >= MAX_OUTPUT) {
          truncated = true;
          return;
        }
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT);
          truncated = true;
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => {
        output += `\n[stopped after ${Math.round(timeout / 1000)} s]`;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3_000);
      }, timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ output, code: code ?? signal, truncated });
      });
    }, () => reject(new Error(`${cwd} does not exist on the Mac.`)));
  });
}

// Browsing through this Mac (server/macTunnel.js). Many sites refuse the
// hub's datacenter network, so an agent's browser can open them from here: the
// hub asks for a TCP connection to host:port and the bytes flow over a second
// WebSocket. Names are resolved here, and loopback, private and tailnet
// addresses are refused, so pages cannot reach this Mac's own services or the
// home network.
const TUNNEL_URL = config.tunnelUrl || String(config.url).replace(/\/api\/mac\/connect(?=$|[?#])/, "/api/mac/tunnel");
const FRAME = { OPEN: 1, OPENED: 2, DATA: 3, END: 4, ERROR: 5, PAUSE: 6, RESUME: 7 };
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
// For the test suite only: lets the tunnel reach this machine's loopback (never the home network).
const TEST_LOOPBACK = process.env.RAVNIR_MAC_TUNNEL_TEST_LOOPBACK === "1";
let tunnelDelay = 2_000;

function frame(type, id, payload = null) {
  const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const out = Buffer.allocUnsafe(5 + body.length);
  out[0] = type;
  out.writeUInt32BE(id >>> 0, 1);
  body.copy(out, 5);
  return out;
}

function privateAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const value = address.toLowerCase();
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff")) return true;
  if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
  return false;
}

function connectTunnel() {
  if (TUNNEL_URL === config.url) return;
  const ws = new WebSocket(TUNNEL_URL);
  ws.binaryType = "arraybuffer";
  const streams = new Map(); // id -> net.Socket
  const send = (data) => {
    if (ws.readyState === 1) ws.send(data);
  };
  ws.addEventListener("open", () => send(JSON.stringify({ type: "hello", token: config.token })));
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (event.data.includes("welcome")) {
        tunnelDelay = 2_000;
        log("browsing tunnel connected");
      }
      return;
    }
    const data = Buffer.from(event.data);
    if (data.length < 5) return;
    const type = data[0];
    const id = data.readUInt32BE(1);
    const payload = data.subarray(5);
    const socket = streams.get(id);
    if (type === FRAME.OPEN) return openStream(id, payload);
    if (!socket) return;
    if (type === FRAME.DATA) {
      if (socket.write(payload) === false) send(frame(FRAME.PAUSE, id));
    } else if (type === FRAME.END) {
      streams.delete(id);
      socket.end();
      setTimeout(() => socket.destroy(), 5_000).unref();
    } else if (type === FRAME.PAUSE) socket.pause();
    else if (type === FRAME.RESUME) socket.resume();
  });
  ws.addEventListener("close", (event) => {
    for (const socket of streams.values()) socket.destroy();
    streams.clear();
    if (event.code === 4003) log("the hub rejected the token for the browsing tunnel");
    setTimeout(connectTunnel, tunnelDelay);
    tunnelDelay = Math.min(tunnelDelay * 2, 60_000);
  });
  ws.addEventListener("error", () => {});

  async function openStream(id, payload) {
    let host = "";
    let port = 0;
    try {
      ({ host, port } = JSON.parse(String(payload)));
      host = String(host || "").replace(/^\[|\]$/g, "");
      port = Number(port);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad address");
      if (port === 25) throw new Error("Mail ports are not opened from the Mac.");
      const found = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
      const loopback = (address) => TEST_LOOPBACK && (address === "127.0.0.1" || address === "::1");
      const usable = found.filter((row) => loopback(row.address) || !privateAddress(row.address)).sort((a, b) => a.family - b.family);
      if (!usable.length) throw new Error(`${host} is a private or local address; the Mac does not open those.`);
      const socket = net.connect({ host: usable[0].address, port });
      streams.set(id, socket);
      let connected = false;
      socket.once("connect", () => {
        connected = true;
        send(frame(FRAME.OPENED, id, { address: usable[0].address }));
      });
      socket.on("data", (chunk) => {
        send(frame(FRAME.DATA, id, chunk));
        if (ws.bufferedAmount > HIGH_WATER && !socket.isPaused()) {
          socket.pause();
          const wait = setInterval(() => {
            if (ws.readyState !== 1 || ws.bufferedAmount < LOW_WATER) {
              clearInterval(wait);
              if (!socket.destroyed) socket.resume();
            }
          }, 25);
        }
      });
      socket.on("drain", () => send(frame(FRAME.RESUME, id)));
      socket.on("error", (error) => {
        if (streams.get(id) !== socket) return;
        streams.delete(id);
        send(connected ? frame(FRAME.END, id) : frame(FRAME.ERROR, id, `The Mac could not reach ${host}:${port} (${error.code || error.message}).`));
      });
      socket.on("close", () => {
        if (streams.get(id) !== socket) return;
        streams.delete(id);
        send(frame(FRAME.END, id));
      });
    } catch (error) {
      send(frame(FRAME.ERROR, id, error.code === "ENOTFOUND" ? `${host} does not exist (the Mac could not find it).` : String(error.message || error)));
    }
  }
}

log("Ravnir Mac node starting, roots:", roots.join(", "));
connect();
connectTunnel();
