import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { childEnv } from "./childEnv.js";

const run = promisify(execFile);
const cache = new Map();

export const MEMORY_WORKSPACE = process.env.RAVNIR_MEMORY_WORKSPACE || "ravnir";
export const MEMORY_PROJECT = process.env.RAVNIR_MEMORY_PROJECT || "ravnir";

export function detectAiMemory() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.RAVNIR_AI_MEMORY_BIN,
    path.join(home, ".local", "bin", "ai-memory"),
    "/opt/homebrew/bin/ai-memory",
    "/usr/local/bin/ai-memory",
    "/usr/bin/ai-memory",
  ].filter(Boolean);
  const bin = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || "";
  const dataDir = process.env.AI_MEMORY_DATA_DIR
    || (process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "ai-memory")
      : path.join(home, ".local", "share", "ai-memory"));
  const serverUrl = (process.env.AI_MEMORY_SERVER_URL || "http://127.0.0.1:49374").replace(/\/+$/, "");
  return {
    available: Boolean(bin),
    bin,
    dataDir,
    tokenPath: path.join(dataDir, "auth-tokens", "default"),
    serverUrl,
    mcpUrl: `${serverUrl}/mcp`,
  };
}

// Where ai-memory keeps its store and token, for the CLI and the per-bot MCP bridge.
export function aiMemoryEnv(info) {
  return { AI_MEMORY_DATA_DIR: info.dataDir, AI_MEMORY_SERVER_URL: info.serverUrl };
}

export function memoryMarker() {
  return `# Ravnir shared memory. Every bot on this server reads and writes this scope.\nworkspace = "${MEMORY_WORKSPACE}"\nproject = "${MEMORY_PROJECT}"\n\n[briefing]\ninject_on_session_start = "true"\nmax_chars = 4000\n`;
}

export function ensureMemoryMarker(workspace) {
  const file = path.join(workspace, ".ai-memory.toml");
  const text = memoryMarker();
  try {
    const current = fs.readFileSync(file, "utf8");
    if (current === text) return false;
  } catch {
    // Create it below.
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

export function aiMemoryConnector(info) {
  if (!info.available) return null;
  return {
    name: "ai-memory",
    transport: "stdio",
    command: info.bin,
    args: ["mcp-bridge", "--no-session-id", "--server-url", info.mcpUrl],
    enabled: true,
    status: "new",
    error: "",
    tools: [],
    checkedAt: 0,
    envKeys: [],
    headerKeys: [],
    configKey: "ai_memory",
    managed: "ai-memory",
  };
}

export async function searchMemory(info, query, { limit = 8, timeout = 5_000 } = {}) {
  if (!info?.available) return "";
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  try {
    const { stdout } = await run(info.bin, [
      "search", text,
      "--workspace", MEMORY_WORKSPACE,
      "--project", MEMORY_PROJECT,
      "--json",
      "--limit", String(limit),
    ], {
      timeout,
      maxBuffer: 2_000_000,
      env: childEnv(aiMemoryEnv(info)),
    });
    return formatHits(stdout, limit);
  } catch {
    return "";
  }
}

export async function memoryBrief(info, query, { limit = 5, timeout = 4_000 } = {}) {
  if (!info?.available) return "";
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const key = `${text.slice(0, 180).toLowerCase()}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await searchMemory(info, text, { limit, timeout });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

export async function memoryWrite(info, { path = "", title = "", body = "", kind = "fact" } = {}) {
  if (!info?.available) throw new Error("ai-memory is not installed on this server.");
  const text = String(body || "").trim();
  if (!text) throw new Error("Memory body is empty.");
  const safePath = normalizePagePath(path, title || text);
  const args = [
    "write-page",
    "--workspace", MEMORY_WORKSPACE,
    "--project", MEMORY_PROJECT,
    "--path", safePath,
    "--body", text.slice(0, 60_000),
    "--kind", ["fact", "rule", "decision", "gotcha"].includes(kind) ? kind : "fact",
  ];
  if (title.trim()) args.push("--title", title.trim().slice(0, 120));
  try {
    const { stdout, stderr } = await run(info.bin, args, {
      timeout: 10_000,
      maxBuffer: 2_000_000,
      env: childEnv(aiMemoryEnv(info)),
    });
    const line = String(stdout || stderr || "").trim().split("\n").filter(Boolean).at(-1) || "Memory written.";
    return { text: line, path: safePath };
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message || "ai-memory write failed.");
  }
}

export async function memoryRead(info, pagePath) {
  if (!info?.available) throw new Error("ai-memory is not installed on this server.");
  const safePath = String(pagePath || "").trim();
  if (!safePath) throw new Error("A page path is required.");
  try {
    const { stdout } = await run(info.bin, [
      "read-page",
      "--workspace", MEMORY_WORKSPACE,
      "--project", MEMORY_PROJECT,
      "--path", safePath,
    ], {
      timeout: 5_000,
      maxBuffer: 2_000_000,
      env: childEnv(aiMemoryEnv(info)),
    });
    return String(stdout || "").slice(0, 20_000);
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message || "ai-memory read failed.");
  }
}

function normalizePagePath(pagePath, fallbackTitle) {
  let value = String(pagePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!value) {
    const slug = String(fallbackTitle || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "note";
    value = `notes/${slug}-${Date.now()}.md`;
  }
  if (value.includes("..")) throw new Error("Memory paths cannot contain ..");
  if (!value.endsWith(".md")) value = `${value}.md`;
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Memory paths may only use letters, numbers, dots, dashes, underscores, and slashes.");
  return value.slice(0, 240);
}

function formatHits(stdout, limit) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return "";
  }
  const hits = data.hits || data.results || (Array.isArray(data) ? data : []);
  if (!Array.isArray(hits) || !hits.length) return "";
  return hits.slice(0, limit).map((hit) => {
    const title = hit.title || hit.path || hit.page || "Memory page";
    const body = hit.snippet || hit.excerpt || hit.summary || hit.content || hit.body || "";
    const clean = String(body).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 320);
    return clean ? `- ${title}: ${clean}` : `- ${title}`;
  }).join("\n");
}

export function memoryStatus(info) {
  return {
    available: Boolean(info?.available),
    serverUrl: info?.serverUrl || "",
    workspace: MEMORY_WORKSPACE,
    project: MEMORY_PROJECT,
  };
}
