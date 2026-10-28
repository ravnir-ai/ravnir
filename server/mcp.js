import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./childEnv.js";

const PROTOCOL = "2024-11-05";
const REQUEST_TIMEOUT = 30_000;
// OpenCode starts a bot's stdio connectors itself, with its own environment. This launcher gives them
// the one Ravnir gives its own (childEnv) plus the connector's variables, named on its command line.
export const CONNECTOR_LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "connector-env.mjs");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class McpConnection {
  // secretProvider({ force }) gives fresh headers for every request (OAuth plugins). force is set after a 401.
  constructor({ connector, secret = {}, cwd, secretProvider = null }) {
    this.connector = connector;
    this.secret = secret || {};
    this.secretProvider = secretProvider;
    // A container plugin may need minutes to pull its image on the first start.
    this.timeoutMs = Number(connector.timeoutMs) > 0 ? Number(connector.timeoutMs) : REQUEST_TIMEOUT;
    this.cwd = cwd;
    this.child = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = "";
    this.stderr = "";
    this.buffer = "";
    this.httpMode = connector.transport === "http";
    this.closed = false;
  }

  // A stdio server that crashed or was killed (exit code or signal) cannot answer any more.
  get alive() {
    if (this.closed) return false;
    if (this.httpMode) return true;
    return Boolean(this.child) && !this.spawnError && this.child.exitCode === null && this.child.signalCode === null;
  }

  async connect() {
    if (this.httpMode) {
      await this.#httpRequest("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "Ravnir", version: "1.0.0" },
      });
      await this.#httpNotify("notifications/initialized", {});
    } else {
      await this.#start();
      await this.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "Ravnir", version: "1.0.0" },
      });
      this.notify("notifications/initialized", {});
    }
    const tools = await this.request("tools/list", {});
    return Array.isArray(tools?.tools) ? tools.tools : [];
  }

  async #start() {
    const connector = this.connector;
    if (!connector.command) throw new Error("MCP server command is missing.");
    // A connector is often third-party code (an npx package, a container), so it gets a minimal
    // environment plus its own configured variables, never the server's keys and passwords.
    const env = childEnv(this.secret.env);
    this.child = spawn(connector.command, connector.args || [], {
      cwd: this.cwd || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000);
    });
    this.child.on("error", (error) => {
      // A command that cannot start (no such program, no permission) must fail the connect, not hang it.
      this.spawnError = error;
      this.#failAll(error);
    });
    this.child.on("exit", (code) => {
      if (this.closed) return;
      this.#failAll(new Error(`MCP server exited${code === null ? "" : ` with code ${code}`}. ${this.stderr.slice(-500)}`));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    while (this.buffer) {
      if (this.buffer.startsWith("Content-Length:")) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = this.buffer.slice(0, end);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.slice(end + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = end + 4;
        if (this.buffer.length < start + length) return;
        const body = this.buffer.slice(start, start + length);
        this.buffer = this.buffer.slice(start + length);
        this.#handle(body);
        continue;
      }
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.#handle(line);
    }
  }

  #handle(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || "MCP request failed."));
      else resolve(message.result || {});
    }
  }

  request(method, params) {
    if (this.httpMode) return this.#httpRequest(method, params);
    if (this.spawnError) return Promise.reject(new Error(`Could not start the MCP server: ${this.spawnError.message}`));
    if (!this.alive) {
      return Promise.reject(new Error(`MCP server is not running. ${this.stderr.slice(-400)}`));
    }
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${message}\n`);
    });
  }

  notify(method, params) {
    if (this.httpMode) return this.#httpNotify(method, params);
    if (!this.alive) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params || {} })}\n`);
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args || {} });
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((part) => {
      if (!part) return "";
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text || "";
      if (part.type === "resource") return part.resource?.text || `[resource ${part.resource?.uri || ""}]`;
      return `[${part.type || "content"}]`;
    }).filter(Boolean).join("\n");
    if (result?.isError) return { error: true, text: text || "The MCP tool returned an error." };
    return { error: false, text: text || "The MCP tool returned no text." };
  }

  async #httpHeaders(force = false) {
    if (this.secretProvider) this.secret = (await this.secretProvider({ force })) || {};
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.secret.headers || {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  async #httpRequest(method, params) {
    const connector = this.connector;
    if (!connector.url) throw new Error("MCP server URL is missing.");
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params: params || {} });
    const send = async (force) => fetch(connector.url, {
      method: "POST",
      headers: await this.#httpHeaders(force),
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let response = await send(false);
    if (response.status === 401 && this.secretProvider) {
      // The token may have been revoked or expired early: refresh once and send the same request again.
      await response.arrayBuffer().catch(() => {});
      response = await send(true);
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const type = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`MCP server returned ${response.status}: ${text.slice(0, 300)}`);
      error.httpStatus = response.status;
      throw error;
    }
    if (!text) return {};
    if (type.includes("text/event-stream")) {
      for (const block of text.split(/\n\n/)) {
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data);
          if (message.error) throw new Error(message.error.message || "MCP request failed.");
          if (message.result) return message.result;
        } catch (error) {
          if (error.message === "MCP request failed.") throw error;
        }
      }
      throw new Error("The MCP server sent an event stream without a result.");
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      throw new Error("The MCP server did not return JSON.");
    }
    if (message.error) throw new Error(message.error.message || "MCP request failed.");
    return message.result || {};
  }

  async #httpNotify(method, params) {
    const connector = this.connector;
    const headers = await this.#httpHeaders().catch(() => null);
    if (!headers) return;
    await fetch(connector.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  #failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.#failAll(new Error("MCP connection closed."));
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    this.child = null;
    this.ws = null;
  }
}

export function isPluginConnector(connector) {
  return String(connector?.managed || "").startsWith("plugin:");
}

export class McpManager {
  // secretFor(bot, connector, { force }) may be async. guard(bot, connector, tool, args) runs before a
  // plugin tool and throws when the call may not go ahead (see plugins.js).
  constructor({ secretFor, cwdFor, onChange, guard = null }) {
    this.secretFor = secretFor;
    this.cwdFor = cwdFor;
    this.onChange = onChange;
    this.guard = guard;
    this.connections = new Map();
    this.registry = new Map();
    this.closed = false;
  }

  key(bot, connector) {
    return `${bot.id}:${connector.id}`;
  }

  async refresh(bot, connector) {
    if (this.closed) return connector;
    await this.close(bot, connector);
    connector.status = "connecting";
    connector.error = "";
    this.onChange?.();
    try {
      const secret = await this.secretFor(bot, connector, { force: false });
      // A plugin's token can change between requests, so HTTP connections ask for it every time.
      const secretProvider = isPluginConnector(connector) && connector.transport === "http"
        ? (options) => this.secretFor(bot, connector, options)
        : null;
      const connection = new McpConnection({ connector, secret, cwd: this.cwdFor(bot), secretProvider });
      const tools = await connection.connect();
      if (this.closed) {
        connection.close();
        return connector;
      }
      this.connections.set(this.key(bot, connector), connection);
      connector.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
      }));
      connector.status = "connected";
      connector.checkedAt = Date.now();
      connector.error = "";
    } catch (error) {
      connector.status = "error";
      connector.error = error.message || "Could not connect.";
      connector.checkedAt = Date.now();
      connector.tools = [];
    }
    this.onChange?.();
    return connector;
  }

  async ensure(bot, connector) {
    if (this.closed || !connector.enabled) return null;
    const existing = this.connections.get(this.key(bot, connector));
    if (existing?.alive) return existing;
    // A server that crashed since the last call starts again instead of failing every call after.
    await this.refresh(bot, connector);
    return this.connections.get(this.key(bot, connector)) || null;
  }

  async toolsFor(bot, { only = null } = {}) {
    const tools = [];
    for (const connector of bot.connectors || []) {
      if (!connector.enabled || (only && !only(connector))) continue;
      const connection = await this.ensure(bot, connector);
      if (!connection) continue;
      for (const tool of connector.tools || []) {
        const fullName = `mcp_${connector.id.slice(0, 6)}_${String(tool.name).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48)}`;
        tools.push({
          fullName,
          connectorId: connector.id,
          connectorName: connector.name,
          name: tool.name,
          description: tool.description || `${tool.name} from ${connector.name}`,
          inputSchema: tool.inputSchema || { type: "object", properties: {} },
        });
        this.registry.set(`${bot.id}:${fullName}`, { connector, tool });
      }
    }
    return tools;
  }

  async call(bot, fullName, args) {
    let entry = this.registry.get(`${bot.id}:${fullName}`);
    if (!entry) {
      await this.toolsFor(bot);
      entry = this.registry.get(`${bot.id}:${fullName}`);
    }
    if (!entry) return { error: true, text: `Unknown MCP tool ${fullName}.` };
    if (this.guard && isPluginConnector(entry.connector)) {
      try {
        await this.guard(bot, entry.connector, entry.tool, args || {});
      } catch (error) {
        // A turn that asked for too many approvals stops; anything else is the model's answer.
        if (error.approvalBudget) throw error;
        return { error: true, text: error.message || "That action was not approved." };
      }
    }
    const attempt = async () => {
      const connection = await this.ensure(bot, entry.connector);
      if (!connection) return { error: true, text: `${entry.connector.name} is not connected.${entry.connector.error ? ` ${entry.connector.error}` : ""}` };
      return connection.callTool(entry.tool.name, args);
    };
    try {
      return await attempt();
    } catch (error) {
      // A plugin's session can end (token rotated, server restarted): connect again once with fresh credentials.
      if (isPluginConnector(entry.connector) && (error.httpStatus === 401 || error.httpStatus === 404)) {
        try {
          await this.refresh(bot, entry.connector);
          return await attempt();
        } catch (again) {
          return { error: true, text: again.message || "The MCP tool failed." };
        }
      }
      return { error: true, text: error.message || "The MCP tool failed." };
    }
  }

  async close(bot, connector) {
    const key = this.key(bot, connector);
    const connection = this.connections.get(key);
    if (connection) connection.close();
    this.connections.delete(key);
    // The tools of a connector that is closed for good must not stay callable.
    for (const [name, entry] of this.registry) if (entry.connector === connector && name.startsWith(`${bot.id}:`)) this.registry.delete(name);
  }

  async closeBot(bot) {
    for (const connector of bot.connectors || []) await this.close(bot, connector);
    for (const key of this.registry.keys()) {
      if (key.startsWith(`${bot.id}:`)) this.registry.delete(key);
    }
  }

  async closeAll() {
    this.closed = true;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.registry.clear();
  }
}

// envFor(connector) gives a stdio connector's own variables. Their values go in `environment` and
// only their names in the command, which every user on the machine can read in /proc/<pid>/cmdline.
// The longest a Ravnir tool call through OpenCode may take before OpenCode stops waiting.
export const RAVNIR_TOOL_TIMEOUT_MS = 15 * 60_000;

export function openCodeMcpConfig(bot, builtinUrl, token, { envFor = () => ({}) } = {}) {
  const mcp = {};
  if (builtinUrl && token) {
    mcp.ravnir = {
      type: "remote",
      url: builtinUrl,
      enabled: true,
      headers: { authorization: `Bearer ${token}` },
      // OpenCode gives up on an MCP call after this long (its own default is about a minute). Asking
      // another agent, a browser task or a slow command takes longer; each tool has its own limit.
      timeout: RAVNIR_TOOL_TIMEOUT_MS,
    };
  }
  for (const connector of bot.connectors || []) {
    // Plugins reach OpenCode through the built-in endpoint above, so their tokens stay in Ravnir.
    if (!connector.enabled || connector.skipOpenCode) continue;
    const name = connector.configKey || String(connector.name || connector.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (connector.transport === "http") {
      mcp[name] = {
        type: "remote",
        url: connector.url,
        enabled: true,
      };
    } else {
      const environment = Object.fromEntries(Object.entries(envFor(connector) || {})
        .filter(([key, value]) => ENV_NAME.test(key) && value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]));
      const keep = Object.keys(environment).flatMap((key) => ["--keep", key]);
      mcp[name] = {
        type: "local",
        command: [process.execPath, CONNECTOR_LAUNCHER, ...keep, "--", connector.command, ...(connector.args || [])],
        enabled: true,
        ...(keep.length ? { environment } : {}),
      };
    }
  }
  return { $schema: "https://opencode.ai/config.json", mcp };
}
