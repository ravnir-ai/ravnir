#!/usr/bin/env node
import "../server/env.js";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { callVaultTool, vaultToolDefinitions } from "../server/vault/tools.js";

const DEFINITIONS = vaultToolDefinitions();

export function createVaultMcp({ vault, input, output, name = "ravnir-vault", version = "1.0.0" }) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (message) => output.write(JSON.stringify(message) + "\n");
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  rl.on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, -32700, "Parse error");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(null, -32601, "Method not found");
      return;
    }
    const { id, method, params } = message;
    if (id === undefined) return;
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
      });
      return;
    }
    if (method === "ping") {
      reply(id, {});
      return;
    }
    if (method === "tools/list") {
      reply(id, { tools: DEFINITIONS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
      return;
    }
    if (method === "tools/call") {
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        const result = await callVaultTool(String(params?.name || ""), args, { vault });
        reply(id, { content: [{ type: "text", text: result.text || "" }], isError: Boolean(result.error) });
      } catch (error) {
        reply(id, { content: [{ type: "text", text: error?.message || "The tool failed." }], isError: true });
      }
      return;
    }
    fail(id, -32601, "Method not found");
  });

  const closed = new Promise((resolve) => rl.on("close", resolve));
  return { closed };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let dir = process.env.RAVNIR_VAULT_DIR;
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--dir");
  if (dirIndex !== -1 && args[dirIndex + 1]) dir = args[dirIndex + 1];
  if (!dir) {
    process.stderr.write("usage: bin/vault-mcp.mjs --dir <vault-directory> (or set RAVNIR_VAULT_DIR)\n");
    process.exit(2);
  }
  const { Vault } = await import("../server/vault/index.js");
  const vault = new Vault({ dir, dbPath: ":memory:", pullMs: 0, watch: true });
  await vault.open();
  const { closed } = createVaultMcp({ vault, input: process.stdin, output: process.stdout });
  await closed;
  vault.close();
  process.exit(0);
}
