#!/usr/bin/env node
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
    newline = buffer.indexOf("\n");
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "Ravnir mock", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [{
        name: "echo",
        description: "Echo text back. Useful for checking that MCP is connected.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      }, {
        name: "read_env",
        description: "Report which of the named environment variables this server can see.",
        inputSchema: {
          type: "object",
          properties: { names: { type: "array", items: { type: "string" } } },
          required: ["names"],
        },
      }],
    });
    return;
  }
  if (message.method === "tools/call" && message.params?.name === "read_env") {
    const names = message.params?.arguments?.names || [];
    const seen = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
    respond(message.id, { content: [{ type: "text", text: JSON.stringify(seen) }] });
    return;
  }
  if (message.method === "tools/call") {
    const text = message.params?.arguments?.text || "";
    respond(message.id, {
      content: [{ type: "text", text: `echo: ${text}` }],
    });
    return;
  }
  respondError(message.id, -32601, `Unknown method ${message.method}`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
