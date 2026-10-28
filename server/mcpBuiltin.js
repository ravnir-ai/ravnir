import { builtinToolDefinitions } from "./computer.js";
import { selectMemoryTools } from "./vault/tools.js";

export async function handleBuiltinMcp({ body, bot, ctx, token, header }) {
  const authorization = Array.isArray(header) ? header[0] : header || "";
  if (!token || !safeEqual(authorization, `Bearer ${token}`)) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  if (!body || body.jsonrpc !== "2.0") {
    return { status: 400, json: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } } };
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = body.params || {};
  if (!body.id && method === "notifications/initialized") return { status: 202, empty: true };
  if (method === "initialize") {
    return {
      status: 200,
      json: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Ravnir computer", version: "1.0.0" },
        },
      },
    };
  }
  if (method === "ping") return { status: 200, json: { jsonrpc: "2.0", id, result: {} } };
  if (method === "tools/list") {
    // The plugins this bot has, as <plugin>__<tool>. A plugin that is down just adds nothing.
    const plugin = ctx.pluginTools ? await ctx.pluginTools(bot).catch(() => []) : [];
    return {
      status: 200,
      json: {
        jsonrpc: "2.0",
        id,
        result: {
          // Same rule as the built-in loop: one shared memory, the vault or ai-memory, never both.
          tools: [
            ...(ctx.toolDefs ? await ctx.toolDefs(bot) : selectMemoryTools(builtinToolDefinitions(), { vaultOn: Boolean(ctx.vaultOn), writeOn: Boolean(ctx.writeOn) })).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters,
            })),
            ...plugin.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
          ],
        },
      },
    };
  }
  if (method === "tools/call") {
    try {
      const name = String(params.name || "");
      const plugin = ctx.pluginTools && name.includes("__") ? (await ctx.pluginTools(bot).catch(() => [])).find((tool) => tool.name === name) : null;
      // Only what tools/list offers this bot right now can run, even if OpenCode cached an older list.
      if (!plugin && ctx.toolDefs && !(await ctx.toolDefs(bot)).some((tool) => tool.name === name)) {
        throw new Error(`${name} is not available to this agent right now.`);
      }
      const result = plugin
        ? await ctx.callPlugin(bot, plugin, params.arguments || {})
        : await ctx.callBuiltin(bot, name, params.arguments || {});
      return {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result.text || "" }],
            isError: Boolean(result.error),
          },
        },
      };
    } catch (error) {
      return {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: error.message || "The tool failed." }],
            isError: true,
          },
        },
      };
    }
  }
  return {
    status: 200,
    json: { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } },
  };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
