import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secretLookingName } from "./appConfig.js";
import { McpConnection, isPluginConnector } from "./mcp.js";
import {
  AuthError,
  authorizeUrl,
  discoverAuthorization,
  exchangeCode,
  pkcePair,
  PendingFlows,
  refreshTokens,
  registerClient,
  revokeToken,
} from "./pluginAuth.js";
import { matchesPattern, normalizePolicy, withAllowRule } from "./policy.js";
import { redactSecrets } from "./redact.js";
import { botHome } from "./state.js";

// Plugins: ready-made MCP servers (Gmail, GitHub, Notion, ...) that the user connects once
// and then gives to the agents they choose. The catalog is public/plugins/catalog.json.
//
// A connection belongs to the account: state.plugins[id] holds who connected it and which
// agents may use it. Every secret (tokens, client secrets, pasted keys) is in the encrypted
// vault under `plugin:<id>` and never in state.json, the API, events, a prompt or opencode.json.
// Giving a plugin to an agent adds a managed connector to that agent (managed: "plugin:<id>").

export class PluginError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expected = true;
  }
}

const EXPIRY_MARGIN_MS = 60_000;
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const CONTAINER_TIMEOUT_MS = 240_000;
const GIT_HOSTS = { github: "https://github.com" };
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_SCRIPT = /^bin\/[a-z0-9-]+\.mjs$/;
const LOCAL_TIMEOUT_MS = 60_000;
const SOON_SSE = "This service uses an older connection type that Ravnir does not support yet.";

// Entries kept in code. They are merged over the generated catalog by id.
// Google is "coming soon": every self-hosted Google MCP server we checked keeps its own sign-in
// (a credentials file or its own OAuth page) and cannot take the token Ravnir obtains from the
// environment, and Google's own hosted servers are in developer preview. The OAuth settings below
// are what the card will use once a server is picked.
const GOOGLE_SOON = "Coming soon. Ravnir needs a Google server that accepts its own sign-in, and none is ready yet.";
const GOOGLE_AUTH = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revocationUrl: "https://oauth2.googleapis.com/revoke",
  authParams: { access_type: "offline", prompt: "consent" },
};
function google(id, name, description, scope) {
  return {
    id,
    name,
    description,
    category: "productivity",
    tags: ["google"],
    icon: `icons/${id}.svg`,
    homepage: "https://workspace.google.com",
    featured: false,
    kind: "container",
    auth: "oauth-manual",
    comingSoon: id === "google-gmail" ? "Coming soon. Until then, use the Gmail plugin, which signs in with an app password." : GOOGLE_SOON,
    oauth: { ...GOOGLE_AUTH, scopes: [scope] },
  };
}
// Plugins Ravnir ships itself: a stdio MCP server in bin/, run with this Node.
const GMAIL = {
  id: "gmail",
  name: "Gmail",
  description: "Search, read, draft and send email from your Gmail. Sending waits for your approval unless you allow it.",
  category: "communication",
  tags: ["email", "google"],
  icon: "icons/gmail.svg",
  homepage: "https://mail.google.com",
  featured: true,
  kind: "local",
  script: "bin/gmail-mcp.mjs",
  auth: "secrets",
  tokenHelp: "Uses a Google app password, never your normal password. Turn on 2-Step Verification in your Google account, then create an app password at https://myaccount.google.com/apppasswords and paste its 16 letters here.",
  secrets: [{ key: "GMAIL_APP_PASSWORD", name: "App password", description: "The 16 letters Google shows once at myaccount.google.com/apppasswords.", example: "abcd efgh ijkl mnop" }],
  env: [{ key: "GMAIL_ADDRESS", description: "The Gmail address the app password belongs to.", required: true }],
  // Another mail server for everyone on this Ravnir, or a closed port in tests.
  serverEnv: ["GMAIL_IMAP_HOST", "GMAIL_IMAP_PORT", "GMAIL_SMTP_HOST", "GMAIL_SMTP_PORT"],
};

// Catalog entries replaced by Ravnir's own plugin (the registry's Gmail runs a personal Docker Hub image).
export const DROPPED = new Set(["gmail-mcp"]);

export const CURATED = [
  GMAIL,
  google("google-gmail", "Gmail (Google sign-in)", "Read, search and draft email in your Google account.", "https://www.googleapis.com/auth/gmail.modify"),
  google("google-drive", "Google Drive", "Find, read and organize files in your Google Drive.", "https://www.googleapis.com/auth/drive"),
  google("google-calendar", "Google Calendar", "See your schedule, find free time and manage events.", "https://www.googleapis.com/auth/calendar"),
  google("google-docs", "Google Docs", "Read and write Google Docs.", "https://www.googleapis.com/auth/documents"),
  google("google-sheets", "Google Sheets", "Read and write Google Sheets.", "https://www.googleapis.com/auth/spreadsheets"),
];

// ---- Catalog ---------------------------------------------------------------------------------

const AUTH_KINDS = new Set(["oauth-dcr", "oauth-cimd", "oauth-manual", "token", "open", "unreachable", "secrets", "none"]);

function text(value, max = 400) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  const kind = raw.kind === "container" || raw.kind === "local" ? raw.kind : "remote";
  if (kind === "local" && !LOCAL_SCRIPT.test(String(raw.script || ""))) return null;
  const remote = kind === "remote" && raw.remote?.url
    ? { url: String(raw.remote.url), transport: raw.remote.transport === "sse" ? "sse" : "streamable-http" }
    : null;
  if (kind === "remote" && !remote) return null;
  const auth = AUTH_KINDS.has(raw.auth) ? raw.auth : kind === "remote" ? "open" : "secrets";
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    id,
    name: text(raw.name, 80) || id,
    description: text(raw.description, 600),
    category: text(raw.category, 40).toLowerCase() || "other",
    tags: list(raw.tags).map((tag) => text(tag, 30)).filter(Boolean).slice(0, 8),
    icon: text(raw.icon, 200),
    homepage: text(raw.homepage, 300),
    featured: raw.featured === true,
    kind,
    remote,
    auth,
    tokenHeader: text(raw.tokenHeader, 80),
    tokenHelp: text(raw.tokenHelp, 600),
    image: text(raw.image, 200),
    script: kind === "local" ? String(raw.script) : "",
    secrets: list(raw.secrets).filter((item) => item && SAFE_ENV_KEY.test(String(item.key || ""))).map((item) => ({
      key: String(item.key),
      name: text(item.name, 100),
      description: text(item.description, 300),
      example: text(item.example, 120),
    })),
    env: list(raw.env).filter((item) => item && typeof item.key === "string" && item.key).map((item) => ({
      key: String(item.key).slice(0, 100),
      value: typeof item.value === "string" ? item.value : undefined,
      description: text(item.description, 300),
      required: item.required === true,
    })),
    shellEnv: list(raw.shellEnv).map(String).filter((key) => SAFE_ENV_KEY.test(key)).slice(0, 6),
    // Settings Ravnir's own scripts may read from the server's environment, by name. A plugin process
    // gets nothing else from there (childEnv.js), and never a name that looks like a secret.
    serverEnv: kind === "local" ? list(raw.serverEnv).map(String).filter((key) => SAFE_ENV_KEY.test(key) && !secretLookingName(key)).slice(0, 12) : [],
    requiresVolumes: raw.requiresVolumes === true,
    oauth: raw.oauth && typeof raw.oauth === "object" ? raw.oauth : null,
    comingSoon: text(raw.comingSoon, 300) || (remote?.transport === "sse" && auth !== "unreachable" ? SOON_SSE : ""),
  };
}

const catalogCache = new Map();

// The generated file plus the entries kept in code. A missing file is not an error: the page says so.
export function loadCatalog({ file, extras = CURATED } = {}) {
  let generated = { generatedAt: "", source: "", plugins: [] };
  let hint = "";
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
    const cached = catalogCache.get(file);
    if (cached?.mtime === mtime) generated = cached.value;
    else {
      generated = JSON.parse(fs.readFileSync(file, "utf8"));
      catalogCache.set(file, { mtime, value: generated });
    }
  } catch {
    hint = "The plugin catalog has not been generated yet (public/plugins/catalog.json is missing).";
  }
  const byId = new Map();
  for (const raw of Array.isArray(generated.plugins) ? generated.plugins : []) {
    const entry = DROPPED.has(raw?.id) ? null : normalizeEntry(raw);
    if (entry) byId.set(entry.id, entry);
  }
  for (const raw of extras || []) {
    const previous = byId.get(raw.id);
    const merged = normalizeEntry({ ...(previous || {}), ...raw, remote: raw.remote ?? previous?.remote });
    if (merged) byId.set(merged.id, merged);
  }
  return { generatedAt: generated.generatedAt || "", source: generated.source || "", plugins: [...byId.values()], hint };
}

// ---- Container runtime -----------------------------------------------------------------------

function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return path.join(dir, name);
    } catch {
      // Try the next folder.
    }
  }
  return "";
}

// RAVNIR_PLUGIN_RUNTIME, else the runtime of the bots' own computers, else whichever of podman and docker exists.
export function detectRuntime(env = process.env) {
  for (const wanted of [env.RAVNIR_PLUGIN_RUNTIME, env.RAVNIR_BOX]) {
    const name = String(wanted || "").trim().toLowerCase();
    if (name === "podman" || name === "docker") return { name, bin: onPath(name, env) ? name : "" };
  }
  for (const name of ["podman", "docker"]) if (onPath(name, env)) return { name, bin: name };
  return { name: "", bin: "" };
}

// ---- Container configuration -----------------------------------------------------------------

// The catalog lists user inputs as env entries without a value, and the variables that use them as
// entries whose value is a "{{plugin.input}}" template. Entries with a plain value are fixed.
function templateName(pluginId, token) {
  const name = token.trim();
  return name.startsWith(`${pluginId}.`) ? name.slice(pluginId.length + 1) : name.slice(name.lastIndexOf(".") + 1);
}

export function inputFields(entry) {
  return entry.env.filter((item) => item.value === undefined).map((item) => ({
    key: item.key,
    label: humanize(item.key),
    description: item.description,
    required: item.required,
  }));
}

export function secretFields(entry) {
  return entry.secrets.map((item) => ({
    key: item.key,
    label: humanize(item.name.slice(item.name.lastIndexOf(".") + 1) || item.key),
    description: item.description,
    example: item.example,
  }));
}

function humanize(key) {
  const words = String(key || "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

// Every variable name a container may receive, so the run command can pass them through by name.
function containerEnvKeys(entry) {
  const keys = new Set(entry.secrets.map((item) => item.key));
  const templated = new Set();
  for (const item of entry.env) {
    if (item.value === undefined) continue;
    if (SAFE_ENV_KEY.test(item.key)) keys.add(item.key);
    for (const match of item.value.matchAll(/\{\{([^}]+)\}\}/g)) templated.add(templateName(entry.id, match[1]));
  }
  for (const item of entry.env) if (item.value === undefined && !templated.has(item.key) && SAFE_ENV_KEY.test(item.key)) keys.add(item.key);
  return [...keys];
}

export function containerEnv(entry, data) {
  const inputs = data.inputs || {};
  const env = {};
  const templated = new Set();
  for (const item of entry.env) {
    if (item.value === undefined || !SAFE_ENV_KEY.test(item.key)) continue;
    let missing = false;
    const value = item.value.replace(/\{\{([^}]+)\}\}/g, (_, token) => {
      const name = templateName(entry.id, token);
      templated.add(name);
      const given = String(inputs[name] ?? "").trim();
      if (!given) missing = true;
      return given;
    });
    if (!missing && value) env[item.key] = value;
  }
  for (const item of entry.env) {
    if (item.value !== undefined || templated.has(item.key) || !SAFE_ENV_KEY.test(item.key)) continue;
    const given = String(inputs[item.key] ?? "").trim();
    if (given) env[item.key] = given;
  }
  for (const item of entry.secrets) {
    const given = String(data.secrets?.[item.key] ?? "");
    if (given) env[item.key] = given;
  }
  return env;
}

// What a plugin process gets: the settings it reads from the server (serverEnv), then the user's inputs and secrets.
export function pluginEnv(entry, data, serverEnv = process.env) {
  const env = {};
  for (const key of entry.serverEnv || []) if (serverEnv[key]) env[key] = serverEnv[key];
  return { ...env, ...containerEnv(entry, data) };
}

export function containerArgs(entry) {
  const args = ["run", "-i", "--rm", "--pull=missing", "--memory", "512m"];
  for (const key of containerEnvKeys(entry)) args.push("-e", key);
  args.push(entry.image);
  return args;
}

// The header a pasted token travels in: "Authorization: Bearer" means `Authorization: Bearer <token>`.
export function tokenHeaderFor(entry, token) {
  const [name, scheme] = String(entry?.tokenHeader || "Authorization: Bearer").split(":").map((part) => part.trim());
  return { [name || "Authorization"]: [scheme ?? (name ? "" : "Bearer"), token].filter(Boolean).join(" ") };
}

// MCP tool names for OpenCode: <plugin>__<tool>, at most 64 characters of [A-Za-z0-9_-].
export function builtinToolName(pluginId, toolName) {
  const clean = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `${clean(pluginId)}__${clean(toolName)}`;
  if (name.length <= 64) return name;
  const hash = crypto.createHash("sha1").update(`${pluginId}\n${toolName}`).digest("hex").slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

// ---- Approvals --------------------------------------------------------------------------------

// "Always allow" saves the rule plugin:<id>:<tool> in the bot's allow list, next to its command rules.
// A shell command can never be "plugin:..." in a way that matters, so the two kinds do not mix up.
export function pluginRule(pluginId, tool) {
  return `plugin:${pluginId}:${tool}`;
}

export function pluginDecision(policy, pluginId, tool) {
  const rules = normalizePolicy(policy);
  if (rules.plugins === "allow") return "allow";
  const rule = pluginRule(pluginId, tool);
  return rules.allow.some((pattern) => pattern.startsWith("plugin:") && matchesPattern(pattern, rule)) ? "allow" : "ask";
}

// MCP tools say whether they only read. A server that does not say is judged by the tool's name.
const READ_NAME = /^(get|list|search|read|fetch|query|find|view|describe)(?:$|[^a-z])/;
export function isReadOnlyTool(tool) {
  const hint = tool?.annotations?.readOnlyHint;
  if (hint === true) return true;
  // A server that says a tool changes something is believed over its name.
  if (hint === false) return false;
  const name = String(tool?.name || "");
  return READ_NAME.test(name.charAt(0).toLowerCase() + name.slice(1));
}

function settle(promises) {
  return Promise.allSettled(promises);
}

// ---- Manager ---------------------------------------------------------------------------------

export class PluginManager {
  // gateFor(bot) -> { approvals, signal, meta, onPolicyChange } for approval requests.
  // syncBot(bot) rewrites the bot's opencode.json; reloadBot(bot) refreshes its OpenCode tool list when idle.
  constructor({ home, state, secrets, mcp, catalogFile, runtime = null, env = process.env, fetchImpl = fetch, saveState, gateFor, syncBot, reloadBot, notify }) {
    this.home = home;
    this.state = state;
    // Plugins whose service refused any return address but the user's own computer (Vercel).
    this.loopbackOnly = new Set();
    this.secrets = secrets;
    this.mcp = mcp;
    this.catalogFile = catalogFile;
    this.runtimeOverride = runtime;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.saveState = saveState;
    this.gateFor = gateFor;
    this.syncBot = syncBot || (() => {});
    this.reloadBot = reloadBot || (async () => false);
    this.notify = notify || (() => {});
    this.flows = new PendingFlows();
    this.refreshing = new Map();
    this.gitReady = new Set();
    this.state.plugins ||= {};
  }

  get connections() {
    this.state.plugins ||= {};
    return this.state.plugins;
  }

  // Looking for podman and docker walks PATH, so the answer is kept for half a minute.
  runtime() {
    if (this.runtimeOverride) return this.runtimeOverride;
    if (!this.runtimeSeen || Date.now() - this.runtimeSeen.at > 30_000) this.runtimeSeen = { at: Date.now(), value: detectRuntime(this.env) };
    return this.runtimeSeen.value;
  }

  catalog() {
    return loadCatalog({ file: this.catalogFile });
  }

  entry(id) {
    const entry = this.catalog().plugins.find((item) => item.id === id);
    if (!entry) throw new PluginError("Unknown plugin.", 404);
    return entry;
  }

  redirectBase(req) {
    // A sign-in started from the app comes back to the address that browser is on. RAVNIR_PUBLIC_URL
    // can be an internal one (on a server it may be 127.0.0.1 for OpenCode), which the phone cannot reach.
    // Sec-Fetch-Site same-origin means the browser itself set Origin to the app's own page.
    const origin = String(req?.headers?.origin || "");
    if (req?.headers?.["sec-fetch-site"] === "same-origin" && /^https?:\/\/[^/\s]+$/i.test(origin)) return origin;
    const configured = String(this.env.RAVNIR_PUBLIC_URL || "").trim();
    if (configured) return configured.replace(/\/+$/, "");
    const first = (value) => String(value || "").split(",")[0].trim();
    const proto = first(req?.headers?.["x-forwarded-proto"]) || (req?.socket?.encrypted ? "https" : "http");
    const host = first(req?.headers?.["x-forwarded-host"]) || req?.headers?.host || "127.0.0.1";
    return `${proto}://${host}`;
  }

  redirectUri(req) {
    return `${this.redirectBase(req)}/plugins/oauth/callback`;
  }

  // ---- What the page shows ----

  list(req) {
    const catalog = this.catalog();
    const runtime = this.runtime();
    const pending = new Set(this.flows.pendingIds());
    let hidden = 0;
    const seen = new Set();
    const plugins = [];
    for (const entry of catalog.plugins) {
      seen.add(entry.id);
      if (entry.requiresVolumes || (entry.kind === "container" && !runtime.bin && !entry.comingSoon)) {
        // Not shown, unless the user already connected it.
        if (!this.connections[entry.id]) {
          hidden += 1;
          continue;
        }
      }
      plugins.push(this.#publicEntry(entry, pending));
    }
    for (const connection of Object.values(this.connections)) {
      if (seen.has(connection.id)) continue;
      // Connected, then dropped from the catalog: still listed, so it can be disconnected.
      plugins.push({
        id: connection.id,
        name: connection.name || connection.id,
        description: "This plugin is no longer in the catalog.",
        category: "other",
        tags: [],
        icon: "",
        homepage: "",
        featured: false,
        kind: "remote",
        auth: "open",
        missing: true,
        ...this.#connectionView(connection.id, pending),
      });
    }
    return {
      plugins,
      runtime: { name: runtime.name, available: Boolean(runtime.bin) },
      hiddenCount: hidden,
      hint: catalog.hint,
      redirectUri: this.redirectUri(req),
      generatedAt: catalog.generatedAt,
      source: catalog.source,
    };
  }

  #connectionView(id, pending = new Set(this.flows.pendingIds())) {
    const connection = this.connections[id];
    const tools = Array.isArray(connection?.tools) ? connection.tools : [];
    return {
      connected: Boolean(connection),
      status: connection ? connection.status || "connected" : "",
      error: connection?.error || "",
      account: connection?.account || "",
      connectedAt: connection?.connectedAt || 0,
      bots: connection ? [...connection.bots] : [],
      tools,
      toolCount: tools.length,
      pending: pending.has(id),
    };
  }

  #publicEntry(entry, pending) {
    const runtime = this.runtime();
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      tags: entry.tags,
      icon: entry.icon ? `/plugins/${entry.icon.replace(/^\/+/, "")}` : "",
      homepage: entry.homepage,
      featured: entry.featured,
      kind: entry.kind,
      auth: entry.auth,
      transport: entry.remote?.transport || "stdio",
      host: hostOf(entry.remote?.url),
      image: entry.image,
      tokenHelp: entry.tokenHelp,
      secretFields: secretFields(entry),
      inputFields: inputFields(entry),
      shellEnv: entry.shellEnv,
      comingSoon: entry.comingSoon,
      unreachable: entry.auth === "unreachable",
      needsRuntime: entry.kind === "container" && !runtime.bin,
      paste: this.loopbackOnly.has(entry.id),
      ...this.#connectionView(entry.id, pending),
    };
  }

  // ---- Connect ----

  async connect(id, body = {}, { req } = {}) {
    const entry = this.entry(id);
    if (entry.comingSoon) throw new PluginError(entry.comingSoon, 409);
    if (entry.auth === "unreachable") throw new PluginError(`${entry.name} is not reachable right now.`, 409);
    if (entry.kind === "container" && !this.runtime().bin) throw new PluginError("This plugin needs Podman or Docker on the server.", 409);
    if (entry.requiresVolumes) throw new PluginError("This plugin needs a folder on the server, which Ravnir does not offer yet.", 409);

    if (entry.auth === "oauth-dcr" || entry.auth === "oauth-manual" || entry.auth === "oauth-cimd") {
      return await this.#startOAuth(entry, body, req);
    }
    if (entry.auth === "token") {
      const token = String(body.token || "").trim();
      if (!token) throw new PluginError("Paste the access token first.");
      if (token.length > 4000) throw new PluginError("That token is too long.");
      await this.#verifyRemote(entry, tokenHeaderFor(entry, token));
      return { connection: await this.#commit(entry, { kind: "token", token }) };
    }
    if (entry.auth === "open") {
      await this.#verifyRemote(entry, {});
      return { connection: await this.#commit(entry, { kind: "open" }) };
    }
    // Containers: collect the keys and settings. The image is pulled on first use (Test checks it).
    const secrets = {};
    for (const field of secretFields(entry)) {
      const value = String(body.secrets?.[field.key] ?? "").trim();
      if (!value) throw new PluginError(`${field.label} is required.`);
      if (value.length > 8000) throw new PluginError(`${field.label} is too long.`);
      secrets[field.key] = value;
    }
    const inputs = {};
    for (const field of inputFields(entry)) {
      const value = String(body.env?.[field.key] ?? "").trim();
      if (field.required && !value) throw new PluginError(`${field.label} is required.`);
      if (value) inputs[field.key] = value.slice(0, 2000);
    }
    // Ravnir's own servers check the login when they start, so a wrong password fails here, not later.
    if (entry.kind === "local") await this.#verifyLocal(entry, pluginEnv(entry, { secrets, inputs }, this.env));
    return { connection: await this.#commit(entry, { kind: "secrets", secrets, inputs }) };
  }

  async #startOAuth(entry, body, req) {
    if (!entry.remote && !entry.oauth?.authorizationUrl) throw new PluginError("This plugin cannot sign in with OAuth.", 409);
    const redirectUri = this.redirectUri(req);
    const resourceUrl = entry.remote?.url || entry.oauth.tokenUrl;
    let discovery;
    try {
      discovery = await discoverAuthorization(resourceUrl, { fetchImpl: this.fetchImpl, overrides: entry.oauth });
    } catch (error) {
      throw error instanceof AuthError ? new PluginError(error.message, error.status) : error;
    }
    let client;
    let paste = false;
    try {
      if (entry.auth === "oauth-dcr") {
        try {
          if (this.loopbackOnly.has(entry.id) && !isLoopback(redirectUri)) {
            client = await registerClient(discovery, LOOPBACK_CALLBACK, { fetchImpl: this.fetchImpl });
            paste = true;
          } else client = await registerClient(discovery, redirectUri, { fetchImpl: this.fetchImpl });
        } catch (error) {
          // Some services (Vercel) only accept a return address on the user's own computer. Then the
          // browser lands on a page that does not load, and the user pastes its address back here.
          if (!(error instanceof AuthError) || !/redirect/i.test(error.message) || isLoopback(redirectUri)) throw error;
          client = await registerClient(discovery, LOOPBACK_CALLBACK, { fetchImpl: this.fetchImpl });
          paste = true;
          this.loopbackOnly.add(entry.id);
        }
      } else {
        const clientId = String(body.clientId || "").trim();
        const clientSecret = String(body.clientSecret || "").trim();
        if (!clientId) throw new PluginError(`Paste the client ID from your ${entry.name} developer settings.`);
        client = { clientId, clientSecret, method: clientSecret ? "client_secret_post" : "none", redirectUri };
      }
    } catch (error) {
      throw error instanceof AuthError ? new PluginError(error.message, error.status) : error;
    }
    const { verifier, challenge } = pkcePair();
    // A new attempt replaces an unfinished one, so a closed or failed sign-in never blocks the next.
    this.flows.cancel(entry.id);
    const state = this.flows.start({ pluginId: entry.id, verifier, client, discovery });
    return { authorizeUrl: authorizeUrl(discovery, client, { state, challenge }), paste };
  }

  // GET /plugins/oauth/callback. Returns the small page the browser shows.
  async callback(query) {
    return callbackPage(await this.#finish(query));
  }

  // POST /api/plugins/:id/finish {url}: the address the browser landed on after a sign-in that
  // returns to the user's own computer (see LOOPBACK_CALLBACK).
  async finishFromUrl(id, value) {
    let url;
    try {
      url = new URL(String(value || "").trim());
    } catch {
      throw new PluginError("Paste the whole address from the page that did not load.");
    }
    if (!url.searchParams.get("state")) throw new PluginError("That address has no sign-in in it. Copy it from the page the sign-in opened last.");
    const result = await this.#finish(url.searchParams, id);
    if (!result.ok) throw new PluginError(result.message, 400);
    return { ok: true, connection: this.connections[result.id] || null };
  }

  async #finish(query, expectedId = "") {
    const flow = this.flows.take(query.get("state"));
    if (!flow) return { ok: false, message: "This sign-in link has expired or was already used. Go back to Ravnir and press Connect again." };
    const entry = this.catalog().plugins.find((item) => item.id === flow.pluginId);
    if (!entry || (expectedId && entry.id !== expectedId)) return { ok: false, message: "That plugin is no longer available." };
    const error = query.get("error");
    if (error) {
      const message = error === "access_denied" ? "Sign-in was cancelled." : `The service said: ${query.get("error_description") || error}`;
      return { ok: false, id: entry.id, name: entry.name, message };
    }
    const code = query.get("code");
    if (!code) return { ok: false, id: entry.id, name: entry.name, message: "The service did not send a sign-in code." };
    try {
      const token = await exchangeCode(flow.discovery, flow.client, { code, verifier: flow.verifier }, { fetchImpl: this.fetchImpl });
      await this.#commit(entry, {
        kind: "oauth",
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scope: token.scope,
        discovery: pickDiscovery(flow.discovery),
        client: flow.client,
      }, { account: token.account });
      return { ok: true, id: entry.id, name: entry.name, message: `${entry.name} is connected.` };
    } catch (failure) {
      return { ok: false, id: entry.id, name: entry.name, message: failure.message || "Could not finish signing in." };
    }
  }

  // Saves the secrets and the connection. A reconnect keeps the agents that already had the plugin,
  // also after a Disconnect.
  async #commit(entry, data, { account = "" } = {}) {
    this.secrets.set(secretKey(entry.id), data);
    const previous = this.connections[entry.id];
    this.connections[entry.id] = {
      id: entry.id,
      name: entry.name,
      connectedAt: Date.now(),
      account: account || (previous && data.kind === "oauth" ? previous.account : "") || "",
      bots: previous ? [...previous.bots] : [],
      status: "connected",
      error: "",
      tools: previous?.tools || [],
    };
    this.flows.cancel(entry.id);
    this.saveState();
    // Agents that already had it pick up the new credentials.
    for (const botId of this.connections[entry.id].bots) {
      const bot = this.state.bots.find((item) => item.id === botId);
      const connector = bot?.connectors.find((item) => item.managed === `plugin:${entry.id}`);
      if (connector) this.mcp.refresh(bot, connector).catch(() => {});
    }
    const remembered = previous ? [] : this.state.pluginAgents?.[entry.id] || [];
    if (this.state.pluginAgents?.[entry.id]) {
      delete this.state.pluginAgents[entry.id];
      this.saveState();
    }
    if (remembered.length) await this.setBots(entry.id, remembered).catch(() => {});
    return this.#connectionView(entry.id);
  }

  async #verifyLocal(entry, env) {
    const connector = this.#connectorFor(entry);
    const connection = new McpConnection({ connector: { ...connector, timeoutMs: 45_000 }, secret: { env }, cwd: this.home });
    try {
      await connection.connect();
    } catch (error) {
      throw new PluginError(String(error.message || error).replace(/^MCP server exited[^.]*\.\s*/, "").slice(0, 300) || `Could not start ${entry.name}.`, 400);
    } finally {
      connection.close();
    }
  }

  async #verifyRemote(entry, headers) {
    const connector = this.#connectorFor(entry);
    const connection = new McpConnection({ connector: { ...connector, timeoutMs: 20_000 }, secret: { headers }, cwd: this.home });
    try {
      await connection.connect();
    } catch (error) {
      throw new PluginError(`Could not connect to ${entry.name}: ${String(error.message || error).slice(0, 240)}`, 502);
    } finally {
      connection.close();
    }
  }

  // ---- Disconnect ----

  async disconnect(id) {
    const connection = this.connections[id];
    const data = this.secrets.get(secretKey(id), null);
    if (!connection && !data) throw new PluginError("That plugin is not connected.", 404);
    let revoked = false;
    if (data?.kind === "oauth") {
      // Best effort: tell the service to drop the tokens. Revoking the refresh token also ends the access token.
      revoked = await revokeToken(data.discovery, data.client, data.refreshToken || data.accessToken, { fetchImpl: this.fetchImpl }).catch(() => false);
    }
    const touched = [];
    for (const bot of this.state.bots) {
      const stale = bot.connectors.filter((connector) => connector.managed === `plugin:${id}`);
      if (!stale.length) continue;
      for (const connector of stale) await this.mcp.close(bot, connector);
      bot.connectors = bot.connectors.filter((connector) => connector.managed !== `plugin:${id}`);
      touched.push(bot);
    }
    this.secrets.delete(secretKey(id));
    // Connecting again gives the plugin back to the same agents, so a reconnect is not a silent unassign.
    if (connection?.bots?.length) {
      this.state.pluginAgents ||= {};
      this.state.pluginAgents[id] = [...connection.bots];
    }
    delete this.connections[id];
    this.flows.cancel(id);
    this.saveState();
    for (const bot of touched) {
      this.syncBot(bot);
      this.reloadBot(bot).catch(() => {});
    }
    return { ok: true, revoked };
  }

  // A connector was removed from the MCP panel: the agent no longer has the plugin.
  connectorRemoved(bot, connector) {
    const id = String(connector?.managed || "").slice("plugin:".length);
    const connection = this.connections[id];
    if (!connection) return;
    connection.bots = connection.bots.filter((botId) => botId !== bot.id);
    this.saveState();
  }

  forgetBot(botId) {
    let changed = false;
    for (const connection of Object.values(this.connections)) {
      if (!connection.bots.includes(botId)) continue;
      connection.bots = connection.bots.filter((item) => item !== botId);
      changed = true;
    }
    if (changed) this.saveState();
  }

  // ---- Agents ----

  async setBots(id, ids) {
    const connection = this.connections[id];
    if (!connection) throw new PluginError("Connect the plugin first.", 409);
    const entry = this.catalog().plugins.find((item) => item.id === id);
    if (!entry) throw new PluginError("That plugin is no longer in the catalog.", 409);
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((botId) => this.state.bots.some((bot) => bot.id === botId));
    const added = wanted.filter((botId) => !connection.bots.includes(botId));
    const removed = connection.bots.filter((botId) => !wanted.includes(botId));
    const changed = [];
    const fresh = [];
    for (const botId of removed) {
      const bot = this.state.bots.find((item) => item.id === botId);
      if (!bot) continue;
      for (const connector of bot.connectors.filter((item) => item.managed === `plugin:${id}`)) await this.mcp.close(bot, connector);
      bot.connectors = bot.connectors.filter((item) => item.managed !== `plugin:${id}`);
      changed.push(bot);
    }
    for (const botId of added) {
      const bot = this.state.bots.find((item) => item.id === botId);
      if (!bot || bot.connectors.some((item) => item.managed === `plugin:${id}`)) continue;
      const connector = this.#connectorFor(entry);
      bot.connectors.push(connector);
      fresh.push([bot, connector]);
      changed.push(bot);
      if (entry.shellEnv.length) this.#prepareShell(bot, entry);
    }
    connection.bots = wanted;
    this.saveState();
    // Remote servers connect now so the page can report errors; containers start on first use.
    await settle(fresh.filter(([, connector]) => !connector.lazy).map(([bot, connector]) => this.mcp.refresh(bot, connector)));
    for (const bot of changed) this.syncBot(bot);
    this.#rememberTools(id);
    this.saveState();
    // OpenCode lists a workspace's MCP tools once; reload it for bots that are not mid-turn.
    const reloaded = await Promise.all(changed.map((bot) => this.reloadBot(bot).catch(() => false)));
    return {
      ok: true,
      connection: this.#connectionView(id),
      agents: wanted.map((botId) => {
        const bot = this.state.bots.find((item) => item.id === botId);
        const connector = bot?.connectors.find((item) => item.managed === `plugin:${id}`);
        return { id: botId, status: connector?.status || "new", error: connector?.error || "", tools: connector?.tools?.length || 0 };
      }),
      reloaded: reloaded.filter(Boolean).length,
    };
  }

  #rememberTools(id) {
    const connection = this.connections[id];
    if (!connection) return;
    for (const botId of connection.bots) {
      const bot = this.state.bots.find((item) => item.id === botId);
      const connector = bot?.connectors.find((item) => item.managed === `plugin:${id}`);
      if (connector?.tools?.length) {
        connection.tools = connector.tools.map((tool) => ({ name: tool.name, readOnly: isReadOnlyTool(tool) }));
        return;
      }
    }
  }

  #connectorFor(entry) {
    const base = {
      id: crypto.randomUUID(),
      name: entry.name,
      enabled: true,
      status: "new",
      error: "",
      tools: [],
      checkedAt: 0,
      envKeys: [],
      headerKeys: [],
      configKey: `tb_plugin_${entry.id.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)}`,
      managed: `plugin:${entry.id}`,
      skipOpenCode: true,
    };
    if (entry.kind === "remote") return { ...base, transport: "http", url: entry.remote.url, command: "", args: [] };
    if (entry.kind === "local") return { ...base, transport: "stdio", url: "", command: process.execPath, args: [path.join(PROJECT_ROOT, entry.script)], lazy: true, timeoutMs: LOCAL_TIMEOUT_MS };
    return { ...base, transport: "stdio", url: "", command: this.runtime().bin || this.runtime().name || "docker", args: containerArgs(entry), lazy: true, timeoutMs: CONTAINER_TIMEOUT_MS };
  }

  // ---- Test ----

  async test(id) {
    const entry = this.entry(id);
    const connection = this.connections[id];
    if (!connection) throw new PluginError("Connect the plugin first.", 409);
    const connector = this.#connectorFor(entry);
    const link = new McpConnection({
      connector,
      secret: await this.secretForPlugin(id, { force: false }).catch((error) => {
        throw new PluginError(error.message, 409);
      }),
      cwd: this.home,
      secretProvider: entry.kind === "remote" ? (options) => this.secretForPlugin(id, options) : null,
    });
    try {
      const tools = await link.connect();
      connection.status = "connected";
      connection.error = "";
      connection.tools = tools.map((tool) => ({ name: tool.name, readOnly: isReadOnlyTool(tool) }));
      this.saveState();
      return { ok: true, tools: connection.tools };
    } catch (error) {
      const expired = this.connections[id]?.status === "expired";
      if (!expired) {
        connection.status = "error";
        connection.error = String(error.message || error).slice(0, 300);
        this.saveState();
      }
      return { ok: false, error: this.connections[id]?.error || connection.error, tools: [] };
    } finally {
      link.close();
    }
  }

  // ---- Credentials ----

  secretForConnector(connector, { force = false } = {}) {
    return this.secretForPlugin(String(connector.managed).slice("plugin:".length), { force });
  }

  async secretForPlugin(id, { force = false } = {}) {
    const connection = this.connections[id];
    const data = this.secrets.get(secretKey(id), null);
    if (!connection || !data) throw new PluginError("This plugin is not connected.", 409);
    const entry = this.catalog().plugins.find((item) => item.id === id);
    if (data.kind === "open") return {};
    if (data.kind === "token") return { headers: tokenHeaderFor(entry, data.token) };
    if (data.kind === "secrets") return entry ? { env: pluginEnv(entry, data, this.env) } : {};
    if (connection.status === "expired") {
      throw new PluginError(`${connection.name || id} needs you to sign in again. Open Plugins and press Reconnect.`, 401);
    }
    const stale = data.expiresAt && data.expiresAt - Date.now() < EXPIRY_MARGIN_MS;
    if (force || stale) {
      const fresh = await this.#refreshOAuth(id);
      return { headers: { authorization: `Bearer ${fresh.accessToken}` } };
    }
    return { headers: { authorization: `Bearer ${data.accessToken}` } };
  }

  #refreshOAuth(id) {
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const task = (async () => {
      const data = this.secrets.get(secretKey(id), null);
      const connection = this.connections[id];
      try {
        if (!data?.refreshToken) throw new AuthError("The service gave no way to renew the sign-in.", { expired: true });
        const token = await refreshTokens(data.discovery, data.client, data.refreshToken, { fetchImpl: this.fetchImpl });
        const next = { ...data, accessToken: token.accessToken, refreshToken: token.refreshToken || data.refreshToken, expiresAt: token.expiresAt };
        this.secrets.set(secretKey(id), next);
        if (connection && connection.status === "error") {
          connection.status = "connected";
          connection.error = "";
          this.saveState();
        }
        return next;
      } catch (error) {
        if (connection && error.expired) {
          connection.status = "expired";
          connection.error = "The sign-in ended. Reconnect to keep using it.";
          this.saveState();
          this.notify({ id, name: connection.name || id });
        }
        throw error instanceof AuthError && error.expired
          ? new PluginError(`${connection?.name || id} needs you to sign in again. Open Plugins and press Reconnect.`, 401)
          : error;
      } finally {
        this.refreshing.delete(id);
      }
    })();
    this.refreshing.set(id, task);
    return task;
  }

  // ---- Shell, git and prompt ----

  // Names and values a bot's terminal gets for the plugins it has (for example GH_TOKEN for GitHub).
  shellEnvFor(bot) {
    const env = {};
    for (const connection of Object.values(this.connections)) {
      if (!connection.bots.includes(bot.id) || connection.status === "expired") continue;
      const entry = this.catalog().plugins.find((item) => item.id === connection.id);
      if (!entry?.shellEnv.length) continue;
      const data = this.secrets.get(secretKey(connection.id), null);
      const token = data?.kind === "token" ? data.token : data?.kind === "oauth" ? data.accessToken : "";
      if (!token) continue;
      for (const name of entry.shellEnv) env[name] = token;
      this.#prepareShell(bot, entry);
    }
    return env;
  }

  // Command output goes back to the model, so the tokens in the shell are masked there.
  maskShellSecrets(bot, output) {
    let out = String(output ?? "");
    for (const value of Object.values(this.shellEnvFor(bot))) if (value && value.length >= 8) out = out.split(value).join("[redacted]");
    return out;
  }

  // git pushes with the same login: the helper reads GH_TOKEN, so no secret goes into a file.
  #prepareShell(bot, entry) {
    const host = GIT_HOSTS[entry.id];
    const key = `${bot.id}:${entry.id}`;
    if (!host || this.gitReady.has(key)) return;
    this.gitReady.add(key);
    const homes = [botHome(this.home, bot)];
    if (bot.box?.mode === "container") homes.push(path.join(botHome(this.home, bot), "box", "root"));
    for (const dir of homes) {
      try {
        const file = path.join(dir, ".gitconfig");
        const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        if (current.includes(`[credential "${host}"]`)) continue;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}[credential "${host}"]\n\thelper = !gh auth git-credential\n`);
      } catch {
        // A read-only home only means git asks for a password; the token still works for gh.
      }
    }
  }

  // The plugins a bot has, for its system prompt. The account and the last check let the agent
  // say who it is signed in as, and that the last check failed, instead of assuming it works.
  promptInfo(bot) {
    const out = [];
    for (const connection of Object.values(this.connections)) {
      if (!connection.bots.includes(bot.id) || connection.status === "expired") continue;
      const entry = this.catalog().plugins.find((item) => item.id === connection.id);
      out.push({ id: connection.id, name: connection.name || connection.id, shellEnv: entry?.shellEnv || [], account: connection.account || "", status: connection.status || "connected" });
    }
    return out;
  }

  // ---- Tools ----

  // Approval for a plugin tool that changes something. Read-only tools never ask.
  async guard(bot, connector, tool, args) {
    if (isReadOnlyTool(tool)) return;
    const id = String(connector.managed).slice("plugin:".length);
    const live = this.state.bots.find((item) => item.id === bot.id) || bot;
    if (pluginDecision(live.policy, id, tool.name) === "allow") return;
    const gate = this.gateFor(live);
    const name = this.connections[id]?.name || connector.name || id;
    const rule = pluginRule(id, tool.name);
    const answer = await gate.approvals.request({
      ...gate.meta,
      bot: live,
      kind: "plugin",
      title: `${live.name} wants to use ${name}: ${tool.name}`,
      detail: describeArgs(args),
      rule,
      signal: gate.signal,
    });
    if (answer === "reject") throw new Error("The user did not approve this action, or the request timed out.");
    if (answer === "always") {
      live.policy = withAllowRule(live.policy, rule);
      gate.onPolicyChange?.(live);
    }
  }

  // The bot's plugin tools as the built-in MCP endpoint lists them for OpenCode.
  async builtinTools(bot) {
    const tools = await this.mcp.toolsFor(bot, { only: isPluginConnector });
    return tools.map((tool) => {
      const connector = bot.connectors.find((item) => item.id === tool.connectorId);
      const pluginId = String(connector?.managed || "").slice("plugin:".length);
      return {
        name: builtinToolName(pluginId, tool.name),
        description: `${tool.description || tool.name} (${tool.connectorName})`,
        inputSchema: tool.inputSchema,
        fullName: tool.fullName,
      };
    });
  }

  async callBuiltin(bot, tool, args) {
    return this.mcp.call(bot, tool.fullName, args);
  }

  // ---- HTTP API ----

  async api({ method, pathname, body, req }) {
    if (method === "GET" && pathname === "/api/plugins") return { body: this.list(req) };
    const match = pathname.match(/^\/api\/plugins\/([^/]+)(?:\/(connect|cancel|finish|test|bots))?$/);
    if (!match) throw new PluginError("Not found.", 404);
    const id = decodeURIComponent(match[1]);
    if (method === "POST" && match[2] === "connect") return { body: await this.connect(id, body, { req }) };
    if (method === "POST" && match[2] === "finish") return { body: await this.finishFromUrl(id, body.url) };
    if (method === "POST" && match[2] === "cancel") {
      this.flows.cancel(id);
      return { body: { ok: true } };
    }
    if (method === "POST" && match[2] === "test") return { body: await this.test(id) };
    if (method === "PUT" && match[2] === "bots") return { body: await this.setBots(id, body.bots) };
    if (method === "DELETE" && !match[2]) return { body: await this.disconnect(id) };
    throw new PluginError("Not found.", 404);
  }
}

// Where a sign-in returns for services that only accept the user's own computer. Nothing needs to
// answer there: the user copies the address the browser shows.
const LOOPBACK_CALLBACK = "http://127.0.0.1:3847/plugins/oauth/callback";

function isLoopback(url) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function hostOf(url) {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

function secretKey(id) {
  return `plugin:${id}`;
}

function pickDiscovery(discovery) {
  return {
    resource: discovery.resource,
    issuer: discovery.issuer,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    revocationEndpoint: discovery.revocationEndpoint,
    registrationEndpoint: discovery.registrationEndpoint,
    methods: discovery.methods,
    scope: discovery.scope,
    authParams: discovery.authParams,
  };
}

function describeArgs(args) {
  let textValue = "";
  try {
    textValue = JSON.stringify(args ?? {}, null, 2);
  } catch {
    textValue = String(args);
  }
  return redactSecrets(textValue).text.slice(0, 3000);
}

// The page the browser lands on after the service sends the user back. It tells the window that
// opened it (postMessage and BroadcastChannel) and closes itself; on a phone it links back.
export function callbackPage({ ok, id = "", name = "", message }) {
  const payload = JSON.stringify({ type: "ravnir-plugin", id, ok }).replace(/</g, "\\u003c");
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "Connected" : "Not connected"} · Ravnir</title>
<link rel="icon" href="/logo.png?v=companion-20261025" type="image/png" />
<style>
:root{color-scheme:light}*{box-sizing:border-box}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;background:#f5f5f7;color:#1d1d1f;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;-webkit-font-smoothing:antialiased}
.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:22px;padding:30px 28px;width:min(400px,100%);box-shadow:0 24px 70px rgba(0,0,0,.10);text-align:center}
.mark{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px;font-size:22px;color:#fff;background:${ok ? "#34c759" : "#d70015"}}
h1{font-size:20px;letter-spacing:-.03em;margin:0 0 6px}p{color:#6e6e73;margin:0 0 18px;font-size:13.5px}
a.btn{display:inline-block;background:#1d1d1f;color:#fff;border-radius:10px;padding:10px 16px;text-decoration:none;font-weight:500;font-size:14px}
</style></head><body><div class="card"><div class="mark">${ok ? "&#10003;" : "!"}</div>
<h1>${ok ? escape(name ? `${name} is connected` : "Connected") : "Not connected"}</h1>
<p>${escape(message)} <span id="auto"></span></p>
<a class="btn" href="/?view=plugins">Back to Ravnir</a></div>
<script>
(function(){var m=${payload};
try{if(window.opener)window.opener.postMessage(m,location.origin)}catch(e){}
try{var c=new BroadcastChannel("ravnir-plugins");c.postMessage(m);c.close()}catch(e){}
if(${ok ? "true" : "false"}){document.getElementById("auto").textContent="This window closes by itself.";setTimeout(function(){window.close()},900)}
})();
</script></body></html>`;
  return { status: ok ? 200 : 400, html };
}
