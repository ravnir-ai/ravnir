import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../server/mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a stdio connector that crashed starts again on the next call", async () => {
  const manager = new McpManager({ secretFor: async () => ({}), cwdFor: () => os.tmpdir(), onChange: () => {} });
  const connector = { id: "crashy", name: "Crashy", enabled: true, transport: "stdio", command: process.execPath, args: [path.join(root, "scripts", "mock-mcp.js")] };
  const bot = { id: "bot-1", connectors: [connector] };
  try {
    const tools = await manager.toolsFor(bot);
    const echo = tools.find((tool) => tool.name === "echo").fullName;
    assert.deepEqual(await manager.call(bot, echo, { text: "one" }), { error: false, text: "echo: one" });

    const first = manager.connections.get(manager.key(bot, connector));
    first.child.kill("SIGKILL");
    await once(first.child, "exit");
    assert.equal(first.alive, false);

    assert.deepEqual(await manager.call(bot, echo, { text: "two" }), { error: false, text: "echo: two" });
    const second = manager.connections.get(manager.key(bot, connector));
    assert.notEqual(second, first);
    assert.equal(connector.status, "connected");
  } finally {
    await manager.closeAll();
  }
});
