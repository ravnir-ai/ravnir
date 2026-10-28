import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";

export class SecretStore {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, "secrets.enc");
    this.keyFile = path.join(home, "master.key");
    this.key = this.#loadKey();
    this.data = this.#load();
  }

  #loadKey() {
    if (process.env.RAVNIR_SECRET) {
      return crypto.scryptSync(process.env.RAVNIR_SECRET, "truebot-vault-v1", 32);
    }
    fs.mkdirSync(this.home, { recursive: true });
    try {
      const raw = fs.readFileSync(this.keyFile);
      if (raw.length === 32) return raw;
      try {
        const decoded = Buffer.from(raw.toString("utf8").trim(), "base64");
        if (decoded.length === 32) return decoded;
      } catch {
        // Fall through to a clear error.
      }
      throw new Error(`The vault key at ${this.keyFile} is not 32 bytes.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const key = crypto.randomBytes(32);
      fs.writeFileSync(this.keyFile, key, { mode: 0o600 });
      try {
        fs.chmodSync(this.keyFile, 0o600);
      } catch {
        // chmod is not available on every platform.
      }
      return key;
    }
  }

  #load() {
    if (!fs.existsSync(this.file)) return {};
    try {
      const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const data = Buffer.from(envelope.data, "base64");
      const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
      decipher.setAuthTag(tag);
      const clear = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(clear.toString("utf8"));
    } catch (error) {
      throw new Error(`Could not unlock ${this.file}. ${error.message}`);
    }
  }

  get(key, fallback = null) {
    return Object.hasOwn(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  delete(key) {
    if (!Object.hasOwn(this.data, key)) return;
    delete this.data[key];
    this.save();
  }

  save() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const clear = Buffer.from(JSON.stringify(this.data));
    const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
    const envelope = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    };
    fs.mkdirSync(this.home, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Ignore on platforms without chmod.
    }
  }
}
