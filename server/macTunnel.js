import crypto from "node:crypto";

// Browsing through the user's Mac. Many sites (Cloudflare, Akamai and others)
// refuse whole datacenter networks, so an agent's browser on a VPS gets "you have
// been blocked" where the same browser at home loads fine. The Mac runner
// (bin/mac-node.mjs) keeps a second WebSocket open just for this: the hub asks it
// to open a TCP connection to host:port, and the bytes flow through the socket.
// The Mac resolves the name itself and refuses loopback, private and tailnet
// addresses, so a page in the agent's browser cannot reach the Mac's own services
// or its home network. The control socket (server/macNode.js) stays free for
// commands while pages load.

export const TUNNEL_PATH = "/api/mac/tunnel";

// Frames are binary: one type byte, a 4 byte stream id, then the payload.
export const FRAME = { OPEN: 1, OPENED: 2, DATA: 3, END: 4, ERROR: 5, PAUSE: 6, RESUME: 7 };
const HELLO_MS = 5_000;
const PING_MS = 15_000;
const DEAD_MS = 45_000;
const OPEN_TIMEOUT_MS = 20_000;
// Stop reading a stream while this much waits to go out on the socket.
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

export function frame(type, id, payload = null) {
  const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const out = Buffer.allocUnsafe(5 + body.length);
  out[0] = type;
  out.writeUInt32BE(id >>> 0, 1);
  body.copy(out, 5);
  return out;
}

export function parseFrame(raw) {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (data.length < 5) return null;
  return { type: data[0], id: data.readUInt32BE(1), payload: data.subarray(5) };
}

export class MacTunnel {
  constructor({ token = "", now = () => Date.now() } = {}) {
    this.token = String(token || "");
    this.now = now;
    this.socket = null;
    this.since = 0;
    this.streams = new Map(); // id -> { client, opened, resolve, reject, timer }
    this.nextId = 1;
    this.pinger = null;
    this.lastPong = 0;
    this.listeners = new Set();
  }

  get configured() {
    return Boolean(this.token);
  }

  get online() {
    return Boolean(this.socket);
  }

  status() {
    return { online: this.online, since: this.online ? this.since : 0, streams: this.streams.size };
  }

  // Called with true or false when the tunnel comes or goes.
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(ws) {
    let ready = false;
    const helloTimer = setTimeout(() => {
      if (!ready) ws.close(4001, "hello required");
    }, HELLO_MS);
    ws.on("message", (raw, isBinary) => {
      if (!ready) {
        let hello = null;
        try {
          hello = isBinary ? null : JSON.parse(String(raw));
        } catch {
          hello = null;
        }
        clearTimeout(helloTimer);
        if (hello?.type !== "hello" || !this.configured || !safeEqual(String(hello.token || ""), this.token)) {
          ws.close(4003, "bad token");
          return;
        }
        ready = true;
        this.#connect(ws);
        return;
      }
      if (isBinary && this.socket === ws) this.#receive(raw);
    });
    ws.on("pong", () => {
      this.lastPong = this.now();
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.socket === ws) this.#disconnect();
    });
    ws.on("error", () => ws.terminate?.());
  }

  #connect(ws) {
    if (this.socket && this.socket !== ws) {
      const old = this.socket;
      this.#disconnect();
      try {
        old.close(4000, "replaced");
      } catch {
        // Already closed.
      }
    }
    this.socket = ws;
    this.since = this.now();
    this.lastPong = this.since;
    clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (this.socket !== ws) return;
      if (this.now() - this.lastPong > DEAD_MS) {
        try {
          ws.terminate();
        } catch {
          // Gone.
        }
        this.#disconnect();
        return;
      }
      try {
        ws.ping();
      } catch {
        // The close handler cleans up.
      }
    }, PING_MS);
    this.pinger.unref?.();
    ws.send(JSON.stringify({ type: "welcome" }));
    for (const listener of this.listeners) listener(true);
  }

  #disconnect() {
    this.socket = null;
    clearInterval(this.pinger);
    for (const [id, stream] of this.streams) this.#end(id, stream, "The Mac went offline.");
    for (const listener of this.listeners) listener(false);
  }

  // Opens host:port from the Mac and joins it to `client` (a net.Socket).
  // Resolves with { address } once the Mac has connected; rejects if it cannot.
  bridge(client, host, port) {
    if (!this.socket) return Promise.reject(new Error("The Mac is offline."));
    const id = this.nextId;
    this.nextId = this.nextId >= 0xfffffff0 ? 1 : this.nextId + 1;
    return new Promise((resolve, reject) => {
      const stream = { client, opened: false, resolve, reject, paused: false };
      stream.timer = setTimeout(() => this.#end(id, stream, "The Mac did not open the connection in time."), OPEN_TIMEOUT_MS);
      this.streams.set(id, stream);
      client.on("data", (chunk) => {
        if (!stream.opened || !this.socket) return;
        this.#send(frame(FRAME.DATA, id, chunk));
        this.#throttle(client);
      });
      client.on("end", () => this.#close(id, stream));
      client.on("close", () => this.#close(id, stream));
      client.on("error", () => this.#close(id, stream));
      client.on("drain", () => this.#send(frame(FRAME.RESUME, id)));
      client.pause();
      this.#send(frame(FRAME.OPEN, id, { host: String(host), port: Number(port) }));
    });
  }

  #throttle(client) {
    const ws = this.socket;
    if (!ws || ws.bufferedAmount < HIGH_WATER || client.isPaused?.()) return;
    client.pause();
    const wait = setInterval(() => {
      if (this.socket !== ws || ws.bufferedAmount < LOW_WATER) {
        clearInterval(wait);
        if (!client.destroyed) client.resume();
      }
    }, 25);
    wait.unref?.();
  }

  #receive(raw) {
    const message = parseFrame(raw);
    if (!message) return;
    const stream = this.streams.get(message.id);
    if (!stream) return;
    if (message.type === FRAME.OPENED) {
      stream.opened = true;
      clearTimeout(stream.timer);
      let info = {};
      try {
        info = JSON.parse(String(message.payload || "{}"));
      } catch {
        info = {};
      }
      stream.resolve({ address: String(info.address || "") });
      stream.client.resume();
      return;
    }
    if (message.type === FRAME.DATA) {
      if (!stream.client.destroyed && stream.client.write(message.payload) === false) this.#send(frame(FRAME.PAUSE, message.id));
      return;
    }
    if (message.type === FRAME.PAUSE) return stream.client.pause();
    if (message.type === FRAME.RESUME) return stream.opened && stream.client.resume();
    if (message.type === FRAME.END) return this.#end(message.id, stream, "", { tell: false });
    if (message.type === FRAME.ERROR) return this.#end(message.id, stream, String(message.payload || "The Mac could not connect."), { tell: false });
  }

  #close(id, stream) {
    this.#end(id, stream, "", { tell: true });
  }

  #end(id, stream, reason = "", { tell = true } = {}) {
    if (this.streams.get(id) !== stream) return;
    this.streams.delete(id);
    clearTimeout(stream.timer);
    if (tell) this.#send(frame(FRAME.END, id));
    if (!stream.opened) stream.reject(new Error(reason || "The connection closed before it opened."));
    if (!stream.client.destroyed) {
      if (stream.opened) stream.client.end();
      else stream.client.destroy();
    }
  }

  #send(data) {
    const ws = this.socket;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(data, { binary: true });
    } catch {
      // The close handler cleans up.
    }
  }

  close() {
    const ws = this.socket;
    this.#disconnect();
    try {
      ws?.close(1001, "server stopping");
    } catch {
      // Gone.
    }
  }
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right) && a.length === b.length;
}
