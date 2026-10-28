export const CODING_TOOLS = [
  tool("list_dir", "List files and folders inside the workspace.", {
    path: { type: "string", description: "Directory relative to the workspace. Use . for the root." },
  }, ["path"]),
  tool("read_file", "Read a text file inside the workspace.", {
    path: { type: "string" },
    offset: { type: "integer", description: "1-based starting line." },
    limit: { type: "integer", description: "How many lines to return. Maximum 400." },
  }, ["path"]),
  tool("search", "Search text inside workspace files.", {
    query: { type: "string" },
    path: { type: "string", description: "Directory relative to the workspace. Omit or use . to search the whole workspace." },
  }, ["query"]),
  tool("write_file", "Create or replace a text file inside the workspace.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  tool("edit_file", "Replace one exact snippet in a text file. old must match once.", {
    path: { type: "string" },
    old: { type: "string", description: "Exact existing text, including newlines." },
    replacement: { type: "string" },
  }, ["path", "old", "replacement"]),
];

function tool(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

export function createAccumulator() {
  return { content: "", toolCalls: [] };
}

export function pushChunk(acc, chunk) {
  if (chunk?.usage) acc.usage = chunk.usage;
  const choice = chunk?.choices?.[0];
  if (!choice) return acc;
  const delta = choice.delta || {};
  if (typeof delta.content === "string") acc.content += delta.content;
  if (typeof delta.refusal === "string") acc.content += delta.refusal;
  if (Array.isArray(delta.tool_calls)) mergeToolCalls(acc, delta.tool_calls, false);
  if (choice.message) {
    if (typeof choice.message.content === "string") acc.content += choice.message.content;
    if (Array.isArray(choice.message.tool_calls)) mergeToolCalls(acc, choice.message.tool_calls, true);
  }
  return acc;
}

export function finalize(acc) {
  return {
    content: acc.content,
    usage: usageOf(acc.usage),
    toolCalls: acc.toolCalls.filter(Boolean).map((call, index) => ({
      id: call.id || `call_${index + 1}`,
      name: call.name,
      arguments: parseArguments(call.arguments),
    })),
  };
}

// OpenAI-style usage. Cost is only known when the server reports it (OpenRouter does).
function usageOf(raw) {
  if (!raw) return null;
  const cached = Number(raw.prompt_tokens_details?.cached_tokens) || 0;
  return {
    input: Math.max(0, (Number(raw.prompt_tokens) || 0) - cached),
    output: Number(raw.completion_tokens) || 0,
    reasoning: 0,
    cacheRead: cached,
    cacheWrite: 0,
    cost: Number(raw.cost) || 0,
  };
}

// `options` adds request fields (max_tokens, stream: false) and `headers` adds
// request headers, for one-off calls such as the quick plan.
export async function complete({ bot, messages, tools, signal, onDelta, options = {}, headers: extraHeaders = {} }) {
  const cfg = configOf(bot);
  if (!cfg.baseUrl) throw new Error("Set the API base URL for this bot.");
  if (!cfg.model) throw new Error("Choose a model for this bot.");
  const url = endpoint(cfg.baseUrl, "chat/completions");
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    ...options,
  };
  if (tools?.length) body.tools = tools;
  const headers = { "content-type": "application/json", accept: "text/event-stream, application/json", ...extraHeaders };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Stopped.");
    throw new Error(`Could not reach ${cfg.baseUrl}. ${error.message}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(apiError(response.status, text));
  }

  const type = response.headers.get("content-type") || "";
  const acc = createAccumulator();
  if (type.includes("application/json") && !type.includes("text/event-stream")) {
    pushChunk(acc, await response.json());
    if (acc.content) onDelta?.(acc.content);
    return finalize(acc);
  }
  await consumeSSE(response, (chunk) => {
    const before = acc.content;
    pushChunk(acc, chunk);
    if (acc.content.length > before.length) onDelta?.(acc.content.slice(before.length));
  }, signal);
  return finalize(acc);
}

export async function listModels(bot) {
  if (!bot.baseUrl) throw new Error("Set the API base URL in Setup.");
  const headers = { accept: "application/json" };
  if (bot.apiKey) headers.authorization = `Bearer ${bot.apiKey}`;
  let response;
  try {
    response = await fetch(endpoint(bot.baseUrl, "models"), { headers });
  } catch (error) {
    throw new Error(`Could not reach ${bot.baseUrl}. ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(apiError(response.status, text));
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The model list was not JSON.");
  }
  const rows = json.data || json.models || [];
  return rows.map((model) => {
    const id = model.id || model.name;
    return { id, label: model.name || id, providerID: "", modelID: id };
  }).filter((model) => model.id);
}

export function configOf(bot) {
  if (bot?.model && typeof bot.model === "object") {
    return { baseUrl: bot.model.baseUrl || "", apiKey: bot.model.apiKey || "", model: bot.model.model || "" };
  }
  return { baseUrl: bot?.baseUrl || "", apiKey: bot?.apiKey || "", model: typeof bot?.model === "string" ? bot.model : "" };
}

export function endpoint(baseUrl, leaf) {
  const base = String(baseUrl).replace(/\/+$/, "");
  if (base.endsWith("/v1")) return `${base}/${leaf}`;
  return `${base}/v1/${leaf}`;
}

async function consumeSSE(response, onChunk, signal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new Error("Stopped.");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      takeBlock(block, onChunk);
      split = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) takeBlock(buffer, onChunk);
}

function takeBlock(block, onChunk) {
  const lines = block.split("\n").filter((line) => line.startsWith("data:"));
  for (const line of lines) {
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      onChunk(JSON.parse(data));
    } catch {
      // Ignore a non-JSON keepalive.
    }
  }
}

function mergeToolCalls(acc, calls, replaceArguments) {
  for (const call of calls) {
    const index = Number.isInteger(call.index) ? call.index : acc.toolCalls.length;
    const current = acc.toolCalls[index] || { id: "", name: "", arguments: "" };
    if (call.id) current.id = call.id;
    const fn = call.function || {};
    if (fn.name) current.name = replaceArguments ? fn.name : current.name + fn.name;
    if (typeof fn.arguments === "string") {
      current.arguments = replaceArguments ? fn.arguments : current.arguments + fn.arguments;
    }
    acc.toolCalls[index] = current;
  }
}

function parseArguments(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { _raw: raw, _error: "Tool arguments were not valid JSON." };
  }
}

function apiError(status, text) {
  let message = text.slice(0, 400);
  try {
    const json = JSON.parse(text);
    message = json.error?.message || json.message || message;
  } catch {
    // Keep the raw slice.
  }
  return `The API returned ${status}: ${message}`;
}
