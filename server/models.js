// Model providers. Ravnir holds the connection to its own OpenCode server, so an agent only picks a
// model and nobody types OpenCode's internal password. The owner signs in to providers through
// OpenCode's own auth API (device code for subscriptions, or an API key for any of its providers),
// and can add OpenAI-compatible servers (LM Studio, Ollama, vLLM) directly.
import crypto from "node:crypto";
import { providerLogo } from "./providerLogos.js";
import { openCodeRequest } from "./providers/opencode.js";
import { listModels as openAIModels } from "./providers/openai.js";

const CATALOG_MS = 60_000;
const OAUTH_WAIT_MS = 10 * 60_000;
// OpenCode Zen publishes the models it serves (public, no key). See zenServed below.
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const ZEN_MS = 10 * 60_000;
const OPENCODE_SECRET = "server:opencode";
const serverSecret = (id) => `model-server:${id}:key`;

// Shown first under "Add a provider". Ids are OpenCode's (models.dev).
const POPULAR = [
  "opencode-go", "opencode", "openai", "anthropic", "google", "xai", "github-copilot", "deepseek",
  "openrouter", "moonshotai", "zai", "minimax", "mistral", "groq", "ollama-cloud", "togetherai",
  "fireworks-ai", "cerebras", "perplexity", "lmstudio",
];

// Where to create a key, for the providers people use most. Checked by hand; others show no link.
const KEY_URLS = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://platform.claude.com/settings/keys",
  google: "https://aistudio.google.com/apikey",
  xai: "https://console.x.ai",
  deepseek: "https://platform.deepseek.com/api_keys",
  openrouter: "https://openrouter.ai/settings/keys",
  groq: "https://console.groq.com/keys",
  mistral: "https://console.mistral.ai/api-keys",
  opencode: "https://opencode.ai/auth",
  "opencode-go": "https://opencode.ai/auth",
  togetherai: "https://api.together.ai/settings/api-keys",
  "ollama-cloud": "https://ollama.com/settings/keys",
};

// managed is the OpenCode Ravnir runs itself (server/opencodeManaged.js); while it is on it is the connection.
export function createModels({ state, secrets, saveState, env = process.env, onAuthChange = () => {}, managed = null }) {
  let cache = null; // { at, providers, auth, error }
  let loading = null;

  // The server's own OpenCode: from the environment, the one Ravnir runs itself, saved in Settings,
  // or adopted once from the agents that already reach it (they all carry the same password).
  function opencode() {
    const url = clean(env.RAVNIR_OPENCODE_URL);
    if (url) {
      return {
        baseUrl: url,
        username: clean(env.RAVNIR_OPENCODE_USER) || "opencode",
        apiKey: env.RAVNIR_OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD || "",
        source: "env",
      };
    }
    const own = managed?.connection();
    if (own) return own;
    const saved = state.settings?.opencode;
    if (saved?.baseUrl) {
      return { baseUrl: saved.baseUrl, username: saved.username || "opencode", apiKey: secrets.get(OPENCODE_SECRET, ""), source: saved.source || "saved" };
    }
    const adopted = adopt();
    if (adopted) return adopted;
    return null;
  }

  function adopt() {
    // Count each (address, user, password) the agents use and take the most common one.
    const counts = new Map();
    for (const bot of state.bots || []) {
      if (bot.model?.provider !== "opencode" || !bot.model.baseUrl) continue;
      const key = secrets.get(`bot:${bot.id}:apiKey`, "");
      if (!key) continue;
      const baseUrl = clean(bot.model.baseUrl);
      const username = bot.model.username || "opencode";
      const id = JSON.stringify([baseUrl, username, key]);
      const entry = counts.get(id) || { baseUrl, username, key, n: 0 };
      entry.n += 1;
      counts.set(id, entry);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    if (!best) return null;
    state.settings = { ...state.settings, opencode: { baseUrl: best.baseUrl, username: best.username, source: "adopted" } };
    secrets.set(OPENCODE_SECRET, best.key);
    saveState();
    return { baseUrl: best.baseUrl, username: best.username, apiKey: best.key, source: "adopted" };
  }

  function servers() {
    return Array.isArray(state.settings?.modelServers) ? state.settings.modelServers : [];
  }

  // The credential a bot's model calls use: its own key when it has one, else the connection's.
  function keyFor(bot) {
    const own = bot?.id ? secrets.get(`bot:${bot.id}:apiKey`, "") : "";
    if (own) return own;
    return keyForModel(bot?.model);
  }

  function keyForModel(model = {}) {
    const connection = String(model.connection || "");
    if (connection.startsWith("server:")) return secrets.get(serverSecret(connection.slice(7)), "");
    if (model.provider !== "openai") {
      const oc = opencode();
      if (oc && sameUrl(oc.baseUrl, model.baseUrl)) return oc.apiKey;
    }
    const server = servers().find((item) => sameUrl(item.baseUrl, model.baseUrl));
    return server ? secrets.get(serverSecret(server.id), "") : "";
  }

  // The model fields a new or edited agent gets from a picker choice { via, model }.
  function resolveChoice(input = {}) {
    const via = String(input.via || "");
    const model = clean(input.model);
    if (via === "opencode") {
      const oc = opencode();
      if (!oc) throw httpError("OpenCode is not connected on this server yet. Connect it in Settings, Models.", 409);
      return { provider: "opencode", baseUrl: oc.baseUrl, username: oc.username, model, agent: clean(input.agent) || "build", connection: "" };
    }
    if (via.startsWith("server:")) {
      const server = servers().find((item) => item.id === via.slice(7));
      if (!server) throw httpError("That server is no longer connected.", 409);
      return { provider: "openai", baseUrl: server.baseUrl, username: "opencode", model, agent: "", connection: via };
    }
    return null;
  }

  async function call(method, pathname, options = {}) {
    const oc = opencode();
    if (!oc) throw httpError("OpenCode is not connected on this server yet.", 409);
    const result = await openCodeRequest(oc, method, pathname, options);
    if (!result.ok) {
      const status = result.status === 401 ? 502 : result.status && result.status < 500 ? 400 : 502;
      throw httpError(result.status === 401 ? "OpenCode rejected Ravnir's password. Reconnect it in Settings, Models." : result.error, status);
    }
    return result.json;
  }

  async function load({ fresh = false } = {}) {
    // A failed load is retried after a few seconds: OpenCode may just be starting.
    if (!fresh && cache && Date.now() - cache.at < (cache.error ? 5_000 : CATALOG_MS)) return cache;
    if (loading) return loading;
    loading = (async () => {
      try {
        const [providers, auth] = await Promise.all([call("GET", "/provider"), call("GET", "/provider/auth").catch(() => ({}))]);
        cache = { at: Date.now(), providers, auth: auth || {}, error: "" };
      } catch (error) {
        cache = { at: Date.now(), providers: null, auth: {}, error: error.message };
      }
      return cache;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  function providerEntries(data) {
    const all = Array.isArray(data.providers?.all) ? data.providers.all : [];
    const connected = new Set(data.providers?.connected || []);
    const rank = (p) => (connected.has(p.id) ? 0 : POPULAR.includes(p.id) ? 1 : 2);
    return all.map((p) => ({
      id: p.id,
      name: p.name || p.id,
      connected: connected.has(p.id),
      source: p.source || "",
      popular: POPULAR.includes(p.id),
      models: Object.keys(p.models || {}).length,
      methods: methodsFor(p.id, data.auth?.[p.id]),
      keyUrl: KEY_URLS[p.id] || null,
      logo: providerLogo(p.id),
      env: Array.isArray(p.env) ? p.env : [],
    })).sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 1 ? POPULAR.indexOf(a.id) - POPULAR.indexOf(b.id) : 0)
      || a.name.localeCompare(b.name));
  }

  async function catalog({ fresh = false } = {}) {
    const oc = opencode();
    const starting = oc?.source === "managed" && !managed.status().running;
    const data = !oc ? { providers: null, auth: {}, error: "" }
      : starting ? { providers: null, auth: {}, error: managed.status().error || "OpenCode is starting on this server." }
        : await load({ fresh });
    const providers = data.providers ? providerEntries(data) : [];
    const connectedCount = providers.filter((p) => p.connected).length;
    return {
      opencode: {
        connected: Boolean(oc && data.providers),
        baseUrl: oc?.baseUrl || "",
        source: oc?.source || "none",
        // Started by Ravnir: the owner never needs its address or password.
        managed: oc?.source === "managed",
        error: oc ? data.error : "",
        providers: connectedCount,
        models: providers.filter((p) => p.connected).reduce((sum, p) => sum + p.models, 0),
      },
      providers,
      servers: await Promise.all(servers().map(serverStatus)),
    };
  }

  async function serverStatus(server) {
    try {
      const models = await serverModels(server);
      return { ...publicServer(server), connected: true, error: "", models: models.length };
    } catch (error) {
      return { ...publicServer(server), connected: false, error: error.message, models: 0 };
    }
  }

  async function serverModels(server) {
    return openAIModels({ baseUrl: server.baseUrl, apiKey: secrets.get(serverSecret(server.id), "") });
  }

  // OpenCode's catalog of its own Zen models can lag behind the service: a model Zen has retired still
  // shows, and the first message to it fails ("has been deprecated"). Zen lists the models it serves, so
  // the ones it does not list are left out. Without an answer (offline, blocked) the catalog stands.
  // RAVNIR_ZEN_MODELS_URL points elsewhere, or "off" skips the check.
  let zen = null; // { at, ids: Set | null }
  async function zenServed() {
    const url = clean(env.RAVNIR_ZEN_MODELS_URL) || ZEN_MODELS_URL;
    if (/^(off|0|false|no)$/i.test(url)) return null;
    if (zen && Date.now() - zen.at < (zen.ids ? ZEN_MS : 60_000)) return zen.ids;
    let ids = null;
    try {
      const response = await fetch(url, { headers: { "user-agent": "ravnir/1.0" }, signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        const data = await response.json();
        const served = Array.isArray(data?.data) ? data.data.map((m) => String(m?.id || "")).filter(Boolean) : [];
        if (served.length) ids = new Set(served);
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      // Offline or blocked: use the catalog as it is.
    }
    zen = { at: Date.now(), ids };
    return ids;
  }

  // Every model an agent can use right now, from connected providers only.
  async function list() {
    const out = [];
    if (opencode()) {
      const data = await load();
      const all = Array.isArray(data.providers?.all) ? data.providers.all : [];
      const connected = new Set(data.providers?.connected || []);
      const served = connected.has("opencode") ? await zenServed() : null;
      for (const p of all) {
        if (!connected.has(p.id)) continue;
        for (const [key, m] of Object.entries(p.models || {})) {
          if (m?.status === "deprecated") continue;
          if (p.id === "opencode" && served && !served.has(m?.id || key)) continue;
          out.push({
            id: `${p.id}/${m?.id || key}`,
            name: m?.name || m?.id || key,
            provider: p.id,
            providerName: p.name || p.id,
            logo: providerLogo(p.id),
            via: "opencode",
            context: Number(m?.limit?.context) || 0,
            output: Number(m?.limit?.output) || 0,
            cost: m?.cost && (m.cost.input || m.cost.output) ? { input: Number(m.cost.input) || 0, output: Number(m.cost.output) || 0 } : null,
            reasoning: Boolean(m?.capabilities?.reasoning ?? m?.reasoning),
          });
        }
      }
    }
    for (const server of servers()) {
      const models = await serverModels(server).catch(() => []);
      for (const m of models) {
        out.push({ id: m.id, name: m.label || m.id, provider: server.id, providerName: server.name, via: `server:${server.id}`, context: 0, output: 0, cost: null, reasoning: false });
      }
    }
    return { models: out, defaultModel: state.settings?.defaults?.model || "" };
  }

  async function connectOpenCode({ baseUrl, username, password }) {
    if (env.RAVNIR_OPENCODE === "managed" && !clean(env.RAVNIR_OPENCODE_URL)) {
      throw httpError("This server runs its own OpenCode (RAVNIR_OPENCODE=managed). Remove that setting and restart to connect another one.", 409);
    }
    const url = checkAddress(baseUrl, "Enter the OpenCode address, for example http://127.0.0.1:4096.");
    const connection = { baseUrl: url, username: clean(username) || "opencode", apiKey: String(password || "") };
    const probe = await openCodeRequest(connection, "GET", "/provider", { timeoutMs: 15_000 });
    if (!probe.ok) {
      throw httpError(probe.status === 401 ? "OpenCode said the password is wrong." : probe.status ? probe.error : `OpenCode does not answer at ${url}.`, 400);
    }
    // Connecting another OpenCode replaces the one Ravnir runs, which stops at its next check.
    state.settings = { ...state.settings, opencode: { baseUrl: url, username: connection.username, source: "saved" } };
    if (connection.apiKey) secrets.set(OPENCODE_SECRET, connection.apiKey);
    else secrets.delete(OPENCODE_SECRET);
    saveState();
    cache = null;
    return (await catalog({ fresh: true })).opencode;
  }

  async function afterAuth(providerId) {
    cache = null;
    await onAuthChange(providerId);
    const fresh = await catalog({ fresh: true });
    return fresh.providers.find((p) => p.id === providerId) || null;
  }

  async function setKey(providerId, { key, inputs } = {}) {
    const id = providerIdOf(providerId);
    const value = String(key || "").trim();
    if (!value) throw httpError("Paste the API key.", 400);
    const metadata = stringMap(inputs);
    await call("PUT", `/auth/${encodeURIComponent(id)}`, { body: { type: "api", key: value, ...(Object.keys(metadata).length ? { metadata } : {}) } });
    return { ok: true, provider: await afterAuth(id) };
  }

  async function oauthStart(providerId, { method, inputs } = {}) {
    const id = providerIdOf(providerId);
    const index = Number(method);
    if (!Number.isInteger(index) || index < 0) throw httpError("Pick a sign-in method.", 400);
    const json = await call("POST", `/provider/${encodeURIComponent(id)}/oauth/authorize`, { body: { method: index, inputs: stringMap(inputs) }, timeoutMs: 30_000 });
    if (!json?.url) throw httpError("OpenCode did not return a sign-in page.", 502);
    // The browser opens this link, so only a real https page is passed on.
    if (!/^https:\/\/[^\s]+$/i.test(String(json.url))) throw httpError("This sign-in only works on the computer running Ravnir. Use an API key instead.", 400);
    return { url: String(json.url), mode: json.method === "code" ? "code" : "auto", instructions: String(json.instructions || "") };
  }

  async function oauthFinish(providerId, { method, code } = {}, { signal } = {}) {
    const id = providerIdOf(providerId);
    const index = Number(method);
    if (!Number.isInteger(index) || index < 0) throw httpError("Pick a sign-in method.", 400);
    const body = { method: index, ...(code ? { code: String(code).trim() } : {}) };
    const json = await call("POST", `/provider/${encodeURIComponent(id)}/oauth/callback`, { body, timeoutMs: OAUTH_WAIT_MS, signal });
    if (json === false) throw httpError("Sign-in did not finish. Try again.", 400);
    return { ok: true, provider: await afterAuth(id) };
  }

  async function signOut(providerId) {
    const id = providerIdOf(providerId);
    await call("DELETE", `/auth/${encodeURIComponent(id)}`);
    await afterAuth(id);
    return { ok: true };
  }

  async function addServer({ name, baseUrl, apiKey }) {
    const url = checkAddress(baseUrl, "Enter the server address, for example http://127.0.0.1:1234/v1.");
    let models;
    try {
      models = await openAIModels({ baseUrl: url, apiKey: String(apiKey || "") });
    } catch (error) {
      throw httpError(error.message, 400);
    }
    const server = { id: crypto.randomUUID().slice(0, 8), name: clean(name).slice(0, 60) || new URL(url).host, baseUrl: url };
    state.settings = { ...state.settings, modelServers: [...servers(), server] };
    if (apiKey) secrets.set(serverSecret(server.id), String(apiKey));
    saveState();
    return { server: { ...publicServer(server), connected: true, error: "", models: models.length } };
  }

  function removeServer(id) {
    const list = servers();
    if (!list.some((item) => item.id === id)) throw httpError("No such server.", 404);
    state.settings = { ...state.settings, modelServers: list.filter((item) => item.id !== id) };
    secrets.delete(serverSecret(id));
    saveState();
    return { ok: true };
  }

  function publicServer(server) {
    return { id: server.id, name: server.name, baseUrl: server.baseUrl, keySet: Boolean(secrets.get(serverSecret(server.id), "")) };
  }

  return { opencode, keyFor, keyForModel, resolveChoice, catalog, list, connectOpenCode, setKey, oauthStart, oauthFinish, signOut, addServer, removeServer };
}

// OpenCode's browser sign-in redirects to localhost on the machine running it, so it only works there.
function methodsFor(providerId, methods) {
  const list = Array.isArray(methods) && methods.length ? methods : [{ type: "api", label: "API key" }];
  return list.map((m, index) => ({
    index,
    type: m.type === "oauth" ? "oauth" : "api",
    label: String(m.label || (m.type === "oauth" ? "Sign in" : "API key")),
    prompts: Array.isArray(m.prompts) ? m.prompts : [],
    remote: !(m.type === "oauth" && /\bbrowser\b/i.test(String(m.label || "")) && !/headless|device/i.test(String(m.label || ""))),
  }));
}

// An http(s) address with no user or password in it (those belong in the password field and the vault).
function checkAddress(value, hint) {
  const url = clean(value);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw httpError(hint, 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw httpError(hint, 400);
  if (parsed.username || parsed.password) throw httpError("Do not put a password in the address. Use the password field.", 400);
  return url;
}

function providerIdOf(value) {
  const id = String(value || "");
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(id)) throw httpError("Unknown provider.", 400);
  return id;
}

function stringMap(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    if (/^[A-Za-z0-9_-]{1,60}$/.test(key) && typeof value === "string" && value.length <= 500) out[key] = value;
  }
  return out;
}

function clean(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function sameUrl(a, b) {
  const norm = (value) => clean(value).toLowerCase().replace("://localhost", "://127.0.0.1");
  return Boolean(a && b) && norm(a) === norm(b);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
