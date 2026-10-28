import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";

// Web Push for the installed app on the phone and the Mac. VAPID keys and
// subscriptions live under data/push, mode 600. The sender is injectable so
// tests never touch a real push service.

const URGENCY = { low: "low", normal: "normal", high: "high", urgent: "high" };
const MAX_DEVICES = 25;
// Apple's push service refuses a VAPID subject on localhost (403 BadJwtToken) while
// Google accepts it, so a bad subject silently breaks only iPhones and Safari.
const DEFAULT_SUBJECT = "https://ravnir.dev";

export class PushService {
  constructor({ home, subject = process.env.RAVNIR_PUSH_SUBJECT, sender, log = (line) => console.warn(line) } = {}) {
    this.dir = path.join(home, "push");
    this.vapidFile = path.join(this.dir, "vapid.json");
    this.subsFile = path.join(this.dir, "subscriptions.json");
    this.subject = pushSubject(subject);
    this.log = log;
    this.sender = sender || ((subscription, body, options) => webpush.sendNotification(subscription, body, options));
    this.vapid = null;
    this.subs = this.#loadSubs();
  }

  publicKey() {
    return this.#keys().publicKey;
  }

  subscribe(subscription, { label = "", userAgent = "" } = {}) {
    const endpoint = String(subscription?.endpoint || "");
    const p256dh = String(subscription?.keys?.p256dh || "");
    const auth = String(subscription?.keys?.auth || "");
    if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) throw new Error("That push subscription is not valid.");
    const id = idFor(endpoint);
    const existing = this.subs.find((item) => item.id === id);
    const record = {
      id,
      endpoint,
      keys: { p256dh, auth },
      label: String(label || existing?.label || "").slice(0, 80),
      userAgent: String(userAgent || existing?.userAgent || "").slice(0, 300),
      createdAt: existing?.createdAt || Date.now(),
      lastOkAt: existing?.lastOkAt || 0,
      failures: 0,
    };
    this.subs = [...this.subs.filter((item) => item.id !== id), record].slice(-MAX_DEVICES);
    this.#saveSubs();
    return { id };
  }

  unsubscribe(endpoint, id = "") {
    const before = this.subs.length;
    this.subs = this.subs.filter((item) => item.endpoint !== String(endpoint || "") && (!id || item.id !== String(id)));
    if (this.subs.length === before) return false;
    this.#saveSubs();
    return true;
  }

  list() {
    return this.subs.map(({ id, label, userAgent, createdAt, lastOkAt, failures, lastError = "" }) => ({ id, label, userAgent, createdAt, lastOkAt, failures, lastError }));
  }

  async send(payload, { priority = "normal", ttl = 86_400 } = {}) {
    const result = { sent: 0, failed: 0, removed: 0 };
    const targets = [...this.subs];
    if (!targets.length) return result;
    const { publicKey, privateKey } = this.#keys();
    const body = JSON.stringify(payload ?? {});
    const options = {
      TTL: ttl,
      urgency: URGENCY[priority] || "normal",
      timeout: 15_000,
      vapidDetails: { subject: this.subject, publicKey, privateKey },
    };
    const dead = new Set();
    await Promise.all(targets.map(async (sub) => {
      try {
        await this.sender({ endpoint: sub.endpoint, keys: sub.keys }, body, options);
        sub.lastOkAt = Date.now();
        sub.failures = 0;
        sub.lastError = "";
        result.sent += 1;
      } catch (error) {
        const status = Number(error?.statusCode || error?.status || 0);
        if (status === 404 || status === 410) {
          dead.add(sub.id);
          result.removed += 1;
        } else {
          sub.failures += 1;
          sub.lastError = pushError(error, status);
          result.failed += 1;
          this.log(`Push to ${sub.label || sub.id} failed: ${sub.lastError}`);
        }
      }
    }));
    if (dead.size) this.subs = this.subs.filter((item) => !dead.has(item.id));
    this.#saveSubs();
    return result;
  }

  #keys() {
    if (this.vapid) return this.vapid;
    try {
      const saved = JSON.parse(fs.readFileSync(this.vapidFile, "utf8"));
      if (saved?.publicKey && saved?.privateKey) return (this.vapid = saved);
    } catch {
      // first use, or an unreadable file: make new keys
    }
    this.vapid = webpush.generateVAPIDKeys();
    writePrivate(this.vapidFile, this.vapid);
    return this.vapid;
  }

  #loadSubs() {
    try {
      const list = JSON.parse(fs.readFileSync(this.subsFile, "utf8"));
      return Array.isArray(list) ? list.filter((item) => item?.endpoint && item?.keys) : [];
    } catch {
      return [];
    }
  }

  #saveSubs() {
    writePrivate(this.subsFile, this.subs);
  }
}

// A mailto: or https: contact the push services accept: never localhost or a bare address.
export function pushSubject(value) {
  const text = String(value || "").trim();
  try {
    const url = new URL(text);
    const host = url.protocol === "mailto:" ? url.pathname.split("@")[1] || "" : url.hostname;
    const local = !host.includes(".") || /^(localhost|127\.|10\.|192\.168\.)|\.(local|localhost|internal|test)$/i.test(host);
    if ((url.protocol === "mailto:" || url.protocol === "https:") && !local) return text;
  } catch {
    // not a URL: use the default
  }
  return DEFAULT_SUBJECT;
}

// "403 BadJwtToken" from Apple's JSON body, else the status and a short message.
function pushError(error, status) {
  let reason = "";
  try { reason = JSON.parse(error?.body || "{}").reason || ""; } catch { reason = String(error?.body || "").slice(0, 80); }
  return [status || "", reason || String(error?.message || "unreachable").slice(0, 80)].filter(Boolean).join(" ");
}

function idFor(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
