import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractModels } from "./providers/opencode.js";

const exec = promisify(execFile);
const COMMON = ["http://127.0.0.1:4096", "http://127.0.0.1:4099", "http://127.0.0.1:11434", "http://127.0.0.1:1234", "http://127.0.0.1:8080", "http://127.0.0.1:8000"];

export async function discoverServers() {
  const candidates = new Map();
  const add = (baseUrl, source) => {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    if (!candidates.has(normalized)) candidates.set(normalized, { baseUrl: normalized, source });
  };

  for (const url of COMMON) add(url, "common port");
  for (const url of String(process.env.RAVNIR_MODEL_URLS || "").split(",")) {
    if (url.trim()) add(url.trim(), "RAVNIR_MODEL_URLS");
  }
  for (const url of await openCodeProcesses()) add(url, "running opencode");
  for (const url of await lmStudioProcesses()) add(url, "LM Studio");
  for (const url of await tailscalePeers()) add(url, "Tailscale peer");

  const probes = await Promise.all([...candidates.values()].map((candidate) => probe(candidate)));
  const servers = probes.filter(Boolean);
  servers.sort((a, b) => score(b) - score(a));
  return { servers: servers.slice(0, 10), scannedAt: Date.now() };
}

async function openCodeProcesses() {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await exec("ps", ["-axo", "command="], { maxBuffer: 2_000_000 });
    const urls = [];
    for (const line of stdout.split("\n")) {
      if (!/opencode\s+serve\b/.test(line)) continue;
      if (/desktop/i.test(line)) continue;
      const port = flag(line, "port") || flag(line, "p") || "4096";
      const host = flag(line, "hostname") || flag(line, "host") || "127.0.0.1";
      const usable = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
      urls.push(`http://${usable}:${port}`);
    }
    return urls;
  } catch {
    return [];
  }
}

async function lmStudioProcesses() {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await exec("ps", ["-axo", "command="], { maxBuffer: 2_000_000 });
    if (/lm\s*studio|LM Studio/i.test(stdout)) return ["http://127.0.0.1:1234"];
  } catch {
    // Ignore process inspection failures.
  }
  return [];
}

function flag(line, name) {
  const long = line.match(new RegExp(`--${name}[ =]([^\\s]+)`));
  if (long) return long[1].replace(/^["']|["']$/g, "");
  if (name.length === 1) {
    const short = line.match(new RegExp(`(?:^|\\s)-${name}\\s+([^\\s]+)`));
    if (short) return short[1];
  }
  return "";
}

async function probe({ baseUrl, source }) {
  const result = await getJson(`${baseUrl}/global/health`, 1200);
  if (result.status === 401) {
    return {
      kind: "opencode",
      name: "OpenCode (password required)",
      baseUrl,
      source,
      authRequired: true,
      models: [],
      note: "This server asks for a password. Enter it in the bot model settings.",
    };
  }
  if (result.ok && result.json && (result.json.healthy || result.json.version)) {
    const provider = await getJson(`${baseUrl}/provider`, 2500);
    let models = [];
    if (provider.ok) {
      const all = extractModels(provider.json);
      const connected = all.filter((model) => model.connected !== false);
      models = connected.length ? connected : all;
    }
    if (!models.length) {
      const v2 = await getJson(`${baseUrl}/api/model`, 1500);
      if (v2.ok) models = extractModels(v2.json);
    }
    return {
      kind: "opencode",
      name: `OpenCode ${result.json.version || ""}`.trim(),
      baseUrl,
      source,
      authRequired: false,
      models,
      note: models.length ? `${models.length} models` : "Running, but no models were listed.",
    };
  }

  const openai = await getJson(`${baseUrl}/v1/models`, 1200);
  if (openai.ok) {
    const rows = Array.isArray(openai.json?.data) ? openai.json.data : Array.isArray(openai.json?.models) ? openai.json.models : [];
    const models = rows.map((model) => ({
      id: model.id || model.name,
      label: model.name || model.id,
    })).filter((model) => model.id);
    return {
      kind: "openai",
      name: openai.json?.name || "OpenAI-compatible API",
      baseUrl: `${baseUrl}/v1`,
      source,
      authRequired: false,
      models,
      note: models.length ? `${models.length} models` : "Reachable. Model list is empty.",
    };
  }

  const ollama = await getJson(`${baseUrl}/api/tags`, 1000);
  if (ollama.ok && Array.isArray(ollama.json?.models)) {
    return {
      kind: "openai",
      name: "Ollama",
      baseUrl: `${baseUrl}/v1`,
      source,
      authRequired: false,
      models: ollama.json.models.map((model) => ({ id: model.name, label: model.name })),
      note: `${ollama.json.models.length} local models`,
    };
  }
  return null;
}

async function getJson(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const type = response.headers.get("content-type") || "";
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, json: null };
    if (!response.ok || !type.includes("json")) return { ok: false, status: response.status, json: null };
    return { ok: true, status: response.status, json: await response.json() };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

function score(server) {
  let value = 0;
  if (server.source === "running opencode") value += 50;
  if (server.kind === "opencode") value += 20;
  if (server.models?.length) value += 10;
  if (server.baseUrl.includes("127.0.0.1")) value += 5;
  if (server.authRequired) value -= 30;
  return value;
}


async function tailscalePeers() {
  if (process.env.RAVNIR_TAILSCALE_SCAN !== "1") return [];
  try {
    const { stdout } = await exec("tailscale", ["status", "--json"], { timeout: 2500, maxBuffer: 4_000_000 });
    const status = JSON.parse(stdout);
    const peers = Object.values(status.Peer || {}).filter((peer) => peer.Online !== false);
    const urls = [];
    for (const peer of peers.slice(0, 8)) {
      const ip = peer.TailscaleIPs?.find((value) => !String(value).includes(":"));
      if (!ip) continue;
      urls.push(`http://${ip}:4096`, `http://${ip}:4196`);
    }
    return urls;
  } catch {
    return [];
  }
}
