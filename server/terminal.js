import { StringDecoder } from "node:string_decoder";

// The interactive terminal in the Shell tab. One shell per bot, shared by every
// tab and device that has it open, so the phone and the laptop see the same
// session. A closed tab leaves the shell running for a while, with the recent
// output kept for the next viewer.
//
// This shell belongs to the signed-in user and has full access. Bots never get
// it: their commands go through run_command and the approval rules.
//
// The PTY lives in box/term-bridge.py, which reads framed input on stdin.

export const INPUT = 0;
export const RESIZE = 1;
const SCROLLBACK = 200_000;
const MAX_INPUT = 64 * 1024;

export function frame(kind, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export function terminalSize(cols, rows) {
  const clamp = (value, low, high, fallback) => {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
  };
  return { cols: clamp(cols, 20, 500, 100), rows: clamp(rows, 5, 300, 30) };
}

// A WebSocket upgrade carries the session cookie even from another site, so the
// request must come from this app's own pages. Browsers send Sec-Fetch-Site on
// WebSocket requests; older ones only send Origin. A client with neither is not
// a browser (curl, a script) and still needs the password.
export function upgradeAllowed(headers, { publicUrl = "" } = {}) {
  const site = headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  const origin = headers.origin;
  if (!origin) return true;
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = [headers.host, headers["x-forwarded-host"]].filter(Boolean).map(String);
  try {
    if (publicUrl) allowed.push(new URL(publicUrl).host);
  } catch {
    // Ignore a malformed public URL.
  }
  return allowed.includes(host);
}

export class TerminalManager {
  // spawnShell(bot, { cols, rows }) resolves to { child, label }: a child process
  // running term-bridge.py, and a line that says where the shell runs.
  constructor({ spawnShell, idleMs = defaultIdleMs(), onStart } = {}) {
    this.spawnShell = spawnShell;
    this.idleMs = idleMs;
    this.onStart = onStart;
    this.sessions = new Map();
  }

  async attach(bot, viewer, size = {}) {
    const { cols, rows } = terminalSize(size.cols, size.rows);
    let session = this.sessions.get(bot.id);
    if (!session) {
      session = { botId: bot.id, viewers: new Set(), output: "", label: "", cols, rows, child: null, idle: null, exited: false };
      session.ready = this.#start(bot, session);
      this.sessions.set(bot.id, session);
    }
    clearTimeout(session.idle);
    try {
      await session.ready;
    } catch (error) {
      if (this.sessions.get(bot.id) === session) this.sessions.delete(bot.id);
      throw error;
    }
    if (session.exited) throw new Error("The shell ended while it was starting.");
    // The tab may have closed while the shell (or the bot's computer) started.
    if (viewer.closed?.()) {
      this.#idleIfAlone(session);
      return session;
    }
    // Replay, then join: nothing arrives in between, so nothing shows twice.
    viewer.send({ t: "ready", label: session.label });
    if (session.output) viewer.send({ t: "out", d: session.output });
    session.viewers.add(viewer);
    if (cols !== session.cols || rows !== session.rows) this.resize(bot.id, cols, rows);
    return session;
  }

  async #start(bot, session) {
    const { child, label } = await this.spawnShell(bot, { cols: session.cols, rows: session.rows });
    session.child = child;
    session.label = label || "";
    const decoder = new StringDecoder("utf8");
    const take = (chunk) => {
      const text = decoder.write(chunk);
      if (!text) return;
      session.output = (session.output + text).slice(-SCROLLBACK);
      for (const viewer of session.viewers) viewer.send({ t: "out", d: text });
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.stdin.on("error", () => {});
    child.on("error", (error) => take(Buffer.from(`\r\n${error.message}\r\n`)));
    child.on("close", (code) => {
      session.exited = true;
      clearTimeout(session.idle);
      if (this.sessions.get(session.botId) === session) this.sessions.delete(session.botId);
      for (const viewer of session.viewers) viewer.send({ t: "exit", code: code ?? 0 });
    });
    this.onStart?.(bot, session);
  }

  input(botId, data) {
    const session = this.sessions.get(botId);
    if (!session?.child || session.exited || typeof data !== "string" || !data) return false;
    const bytes = Buffer.from(data, "utf8");
    if (bytes.length > MAX_INPUT) return false;
    session.child.stdin.write(frame(INPUT, bytes));
    return true;
  }

  resize(botId, cols, rows) {
    const session = this.sessions.get(botId);
    if (!session?.child || session.exited) return false;
    const size = terminalSize(cols, rows);
    session.cols = size.cols;
    session.rows = size.rows;
    session.child.stdin.write(frame(RESIZE, `${size.cols} ${size.rows}`));
    return true;
  }

  detach(botId, viewer) {
    const session = this.sessions.get(botId);
    if (!session) return;
    session.viewers.delete(viewer);
    this.#idleIfAlone(session);
  }

  #idleIfAlone(session) {
    if (session.viewers.size || session.exited) return;
    clearTimeout(session.idle);
    session.idle = setTimeout(() => this.close(session.botId), this.idleMs);
    session.idle.unref?.();
  }

  // Ends the shell: closing stdin hangs it up (term-bridge.py), a kill follows if it lingers.
  close(botId) {
    const session = this.sessions.get(botId);
    if (!session) return;
    this.sessions.delete(botId);
    clearTimeout(session.idle);
    const { child } = session;
    if (!child || session.exited) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  status(botId) {
    const session = this.sessions.get(botId);
    return { open: Boolean(session && !session.exited), viewers: session?.viewers.size || 0 };
  }
}

function defaultIdleMs() {
  const minutes = Number(process.env.RAVNIR_TERMINAL_IDLE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
}
