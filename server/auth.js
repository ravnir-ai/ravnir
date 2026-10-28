import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Cookie sessions on top of the existing user and password. An installed
// iPhone app cannot rely on HTTP Basic, and push needs the installed app.
// Only sha256 hashes of session tokens are stored, so sessions.json is useless
// on its own. Basic stays valid for scripts and curl.

export const SESSION_COOKIE = "tb_session";
export const SESSION_SECONDS = 90 * 24 * 60 * 60;
const MAX_SESSIONS = 200;
// Pairing codes put a phone in without typing the password: shown on a signed-in screen, good for
// one sign-in within 15 minutes, kept only in memory. Too many wrong codes void every open one.
export const PAIR_SECONDS = 15 * 60;
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIR_LENGTH = 8;
const MAX_PAIRS = 5;
const PAIR_FAILURES = 20;

// Loopback is the only address Ravnir listens on with sign-in off.
export function listenAllowed(host, env = process.env) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = value === "localhost" || value === "::1" || /^127(\.\d{1,3}){3}$/.test(value);
  return loopback || Boolean(env.RAVNIR_USER && env.RAVNIR_PASSWORD);
}

export function createAuth({ user = "", password = "", home, now = () => Date.now() } = {}) {
  const enabled = Boolean(user) && Boolean(password);
  const file = home ? path.join(home, "sessions.json") : "";
  // Bumped by revokeAll(): a session from an earlier epoch is never valid again, even if its entry survived.
  let epoch = 0;
  let sessions = load();
  let pairs = new Map(); // sha256 of the code -> expiresAt
  let pairFailures = 0;

  function load() {
    if (!file) return {};
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
      epoch = Number.isInteger(saved._epoch) && saved._epoch >= 0 ? saved._epoch : 0;
      const { _epoch, ...map } = saved;
      return prune(map);
    } catch {
      return {};
    }
  }

  function prune(map) {
    const live = Object.entries(map).filter(([, session]) => Number(session?.expiresAt) > now());
    live.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    return Object.fromEntries(live.slice(-MAX_SESSIONS));
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(epoch ? { _epoch: epoch, ...sessions } : sessions), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  }

  function sessionKey(req) {
    const token = parseCookies(req?.headers?.cookie)[SESSION_COOKIE];
    return token ? digest(token).toString("hex") : "";
  }

  function validSession(req) {
    const key = sessionKey(req);
    const session = key ? sessions[key] : null;
    if (!session || (session.epoch ?? 0) !== epoch) return false;
    if (session.expiresAt > now()) return true;
    delete sessions[key];
    save();
    return false;
  }

  function validBasic(req) {
    const match = /^Basic\s+(\S+)\s*$/i.exec(String(req?.headers?.authorization || ""));
    if (!match) return false;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split < 0) return false;
    return credentialsMatch(decoded.slice(0, split), decoded.slice(split + 1));
  }

  function newSession(secure) {
    const token = crypto.randomBytes(32).toString("base64url");
    sessions = prune(sessions);
    sessions[digest(token).toString("hex")] = { createdAt: now(), expiresAt: now() + SESSION_SECONDS * 1000, epoch };
    save();
    return { setCookie: cookie(token, SESSION_SECONDS, secure) };
  }

  function livePairs() {
    for (const [key, expiresAt] of pairs) if (expiresAt <= now()) pairs.delete(key);
    return pairs;
  }

  function credentialsMatch(givenUser, givenPassword) {
    const userOk = safeEqual(givenUser, user);
    const passwordOk = safeEqual(givenPassword, password);
    return userOk && passwordOk;
  }

  return {
    enabled,

    // With no user or password configured the server is open, as before.
    check(req) {
      if (!enabled) return true;
      return validSession(req) || validBasic(req);
    },

    // secure: false only for local testing over plain http (the caller decides).
    login(username, pass, { secure = true } = {}) {
      if (!enabled || !credentialsMatch(String(username ?? ""), String(pass ?? ""))) return null;
      return newSession(secure);
    },

    // A code for one more device. Shown as ABCD-EFGH; the oldest open code gives way past five.
    createPairCode() {
      if (!enabled) return null;
      const code = Array.from({ length: PAIR_LENGTH }, () => PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)]).join("");
      const live = livePairs();
      while (live.size >= MAX_PAIRS) live.delete(live.keys().next().value);
      const expiresAt = now() + PAIR_SECONDS * 1000;
      live.set(digest(code).toString("hex"), expiresAt);
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
    },

    loginWithCode(given, { secure = true } = {}) {
      if (!enabled) return null;
      const code = String(given ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const key = digest(code).toString("hex");
      const live = livePairs();
      if (code.length !== PAIR_LENGTH || !live.has(key)) {
        pairFailures += 1;
        if (pairFailures >= PAIR_FAILURES) {
          pairs = new Map();
          pairFailures = 0;
        }
        return null;
      }
      live.delete(key);
      return newSession(secure);
    },

    // Sign out everywhere: every cookie issued so far stops working. Basic auth (curl, scripts) is unaffected.
    revokeAll({ secure = true } = {}) {
      epoch += 1;
      sessions = {};
      pairs = new Map();
      save();
      return { setCookie: cookie("", 0, secure) };
    },

    get epoch() {
      return epoch;
    },

    logout(req, { secure = true } = {}) {
      const key = sessionKey(req);
      if (key && sessions[key]) {
        delete sessions[key];
        save();
      }
      return { setCookie: cookie("", 0, secure) };
    },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const split = part.indexOf("=");
    if (split < 0) continue;
    const name = part.slice(0, split).trim();
    if (!name || name in out) continue;
    let value = part.slice(split + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function cookie(value, maxAge, secure = true) {
  return `${SESSION_COOKIE}=${value}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}
