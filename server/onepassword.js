import { execFile } from "node:child_process";
import fs from "node:fs";
import { childEnv } from "./childEnv.js";

// Read-only bridge to the 1Password CLI. Ravnir never stores a 1Password item's
// password and never sends it to a model: the server fills it into the bot's own
// browser. A service account token is enough; no desktop app is needed.

const OK = new Set(["/opt/homebrew/bin/op", "/usr/local/bin/op", "/usr/bin/op"]);
const CACHE_MS = 30_000;

let statusCache = { at: 0, value: null };
let itemsCache = { at: 0, query: "", value: null };

export class OnePassword {
  constructor({ tokenProvider } = {}) {
    this.bin = "";
    this.tokenProvider = tokenProvider;
  }

  serviceToken() {
    return String(this.tokenProvider?.() || process.env.RAVNIR_OP_SERVICE_ACCOUNT_TOKEN || process.env.OP_SERVICE_ACCOUNT_TOKEN || "").trim();
  }

  clearCache() {
    statusCache = { at: 0, value: null };
    itemsCache = { at: 0, query: "", value: null };
  }

  executable() {
    if (this.bin) return this.bin;
    const explicit = process.env.RAVNIR_OP_BIN;
    if (explicit && exists(explicit)) {
      this.bin = explicit;
      return this.bin;
    }
    for (const candidate of OK) {
      if (exists(candidate)) {
        this.bin = candidate;
        return this.bin;
      }
    }
    for (const dir of String(process.env.PATH || "").split(":")) {
      const candidate = `${dir}/op`;
      if (exists(candidate)) {
        this.bin = candidate;
        return this.bin;
      }
    }
    return "";
  }

  async status({ fresh = false } = {}) {
    if (!fresh && statusCache.value && Date.now() - statusCache.at < CACHE_MS) return statusCache.value;
    const bin = this.executable();
    if (!bin) {
      const value = {
        installed: false,
        signedIn: false,
        version: "",
        message: "1Password CLI is not installed on this server.",
      };
      statusCache = { at: Date.now(), value };
      return value;
    }
    const version = await run(bin, ["--version"], 4_000, this.serviceToken()).then((result) => result.stdout.trim()).catch(() => "");
    const who = await run(bin, ["whoami", "--format=json"], 8_000, this.serviceToken()).catch((error) => ({ error }));
    let signedIn = false;
    let account = "";
    let message = "";
    if (who.error) {
      message = cleanError(who.error);
    } else {
      try {
        const data = JSON.parse(who.stdout || "{}");
        signedIn = Boolean(data.url || data.user_type || data.account_uuid);
        account = data.url || "";
      } catch {
        signedIn = false;
        message = "1Password CLI is installed but not signed in.";
      }
    }
    const value = {
      installed: true,
      signedIn,
      version,
      account,
      tokenSet: Boolean(this.serviceToken()),
      message: signedIn
        ? ""
        : this.serviceToken()
          ? message || "That 1Password token did not connect."
          : "1Password CLI is not signed in. Paste a service account token below.",
    };
    statusCache = { at: Date.now(), value };
    return value;
  }

  async listLogins(query = "") {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle && itemsCache.value && Date.now() - itemsCache.at < CACHE_MS && itemsCache.query === "") return itemsCache.value;
    const bin = this.executable();
    if (!bin) throw new Error("1Password CLI is not installed on this server.");
    let result;
    try {
      result = await run(bin, ["item", "list", "--categories", "Login", "--format=json"], 20_000, this.serviceToken());
    } catch (error) {
      // A signed-out CLI is a setup step, not a server failure.
      const plain = new Error(/not signed in|sign in|authoriz|session expired|no accounts configured/i.test(String(error?.message || error))
        ? "1Password is not signed in. Paste a service account token in Logins."
        : cleanError(error));
      plain.status = 409;
      throw plain;
    }
    let rows;
    try {
      rows = JSON.parse(result.stdout || "[]");
    } catch {
      throw new Error("1Password returned something unexpected.");
    }
    const items = (Array.isArray(rows) ? rows : [])
      .map((item) => ({
        id: String(item.id || ""),
        title: String(item.title || "Untitled login"),
        vault: String(item.vault?.name || ""),
        vaultId: String(item.vault?.id || ""),
        url: firstUrl(item),
        username: String(item.additional_information || ""),
      }))
      .filter((item) => item.id)
      .filter((item) => !needle || `${item.title} ${item.vault} ${item.url} ${item.username}`.toLowerCase().includes(needle))
      .slice(0, 100);
    if (!needle) itemsCache = { at: Date.now(), query: "", value: items };
    return items;
  }

  // Returns username, password and URL for the server's browser only.
  // A service account must name the vault, so it is looked up from the list when not given.
  async readLogin(itemId, vaultId = "") {
    const id = String(itemId || "").trim();
    if (!id) throw new Error("Choose a 1Password item.");
    const bin = this.executable();
    if (!bin) throw new Error("1Password CLI is not installed on this server.");
    const vault = String(vaultId || "").trim() || (await this.listLogins("")).find((item) => item.id === id)?.vaultId || "";
    const args = ["item", "get", id, "--format=json"];
    if (vault) args.push("--vault", vault);
    const result = await run(bin, args, 20_000, this.serviceToken());
    let item;
    try {
      item = JSON.parse(result.stdout || "{}");
    } catch {
      throw new Error("1Password returned something unexpected.");
    }
    const fields = Array.isArray(item.fields) ? item.fields : [];
    const field = (purpose, ids) => fields.find((entry) => entry.purpose === purpose)
      || fields.find((entry) => ids.includes(String(entry.id || "").toLowerCase()))
      || fields.find((entry) => ids.includes(String(entry.label || "").toLowerCase()));
    const username = String(field("USERNAME", ["username", "user", "login"])?.value ?? "");
    const password = String(field("PASSWORD", ["password", "pass"])?.value ?? "");
    const site = firstUrl(item);
    if (!password) throw new Error("That 1Password item has no password field.");
    return { username, password, site };
  }
}

function run(bin, args, timeout, token = "") {
  // The CLI's own OP_ settings, never the rest of the server's environment.
  const env = childEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OP_"))));
  if (token) env.OP_SERVICE_ACCOUNT_TOKEN = token;
  if (process.env.RAVNIR_OP_ACCOUNT) env.OP_ACCOUNT = process.env.RAVNIR_OP_ACCOUNT;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, env, maxBuffer: 4_000_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || "1Password CLI failed.").trim();
        reject(new Error(redact(message)));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function firstUrl(item) {
  if (Array.isArray(item?.urls) && item.urls[0]?.href) return String(item.urls[0].href);
  const fields = Array.isArray(item?.fields) ? item.fields : [];
  const url = fields.find((entry) => entry.purpose === "URL" || ["url", "website"].includes(String(entry.id || "").toLowerCase()));
  return String(url?.value || "");
}

function cleanError(error) {
  const text = String(error?.message || error || "1Password is not available.").split("\n").find((line) => line.trim()) || "1Password is not available.";
  return redact(text.replace(/\[ERROR\]\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*/, "").trim()).slice(0, 300);
}

function redact(text) {
  return String(text).replace(/ops_[A-Za-z0-9_-]+/g, "ops_…").replace(/Bearer\s+\S+/gi, "Bearer …");
}

function exists(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
