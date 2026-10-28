import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createVaultMcp } from "../bin/vault-mcp.mjs";

const fakeVault = {
  available: true,
  search: () => [{ path: "Projects/Launch.md", heading: "Estado actual", date: "2026-10-21T10:00:00Z", snippet: "1,234 followers", score: 1, via: "text" }],
  read: (n) => (n === "Launch" ? { path: "Projects/Launch.md", title: "Launch", date: "2026-10-21T10:00:00Z", hash: "x", body: "# Launch", truncated: false, links: [], unresolved: [], backlinks: ["Agents/Chief-of-Staff.md"] } : null),
  links: () => null,
};

function connect(vault) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buf = "";
  const lines = [];
  output.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const { closed } = createVaultMcp({ vault, input, output });
  return { input, closed, lines };
}

const send = (input, messages) => {
  for (const message of messages) input.write(JSON.stringify(message) + "\n");
  input.end();
};

test("initialize echoes protocolVersion and serverInfo", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }]);
  await closed;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.protocolVersion, "2025-03-26");
  assert.equal(lines[0].result.serverInfo.name, "ravnir-vault");
  assert.equal(lines[0].result.serverInfo.version, "1.0.0");
  assert.deepEqual(lines[0].result.capabilities, { tools: { listChanged: false } });
});

test("tools/list returns exactly the three vault tools with inputSchema", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  await closed;
  assert.deepEqual(lines[0].result.tools.map((tool) => tool.name), ["vault_search", "vault_read", "vault_links"]);
  for (const tool of lines[0].result.tools) {
    assert.ok(tool.description, `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties, `${tool.name} has a schema`);
  }
});

test("vault_search returns the hit path and date", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_search", arguments: { query: "launch" } } }]);
  await closed;
  const result = lines[0].result;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Projects\/Launch\.md/);
  assert.match(result.content[0].text, /2026-10-21/);
});

test("vault_read of a known note shows its backlinks", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_read", arguments: { note: "Launch" } } }]);
  await closed;
  const result = lines[0].result;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Linked from: Agents\/Chief-of-Staff\.md/);
});

test("vault_read of an unknown note is not an error", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_read", arguments: { note: "Nope" } } }]);
  await closed;
  const result = lines[0].result;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /No vault note matches/);
});

test("an unknown tool reports isError true", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } }]);
  await closed;
  const result = lines[0].result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown vault tool nope\./);
});

test("a notification produces no output line", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]);
  await closed;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 2);
  assert.deepEqual(lines[0].result, {});
});

test("malformed JSON returns -32700 with a null id", async () => {
  const { input, closed, lines } = connect(fakeVault);
  input.write("not json\n");
  input.end();
  await closed;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, null);
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[0].error.message, "Parse error");
});

test("an unknown method returns -32601", async () => {
  const { input, closed, lines } = connect(fakeVault);
  send(input, [{ jsonrpc: "2.0", id: 3, method: "resources/list" }]);
  await closed;
  assert.equal(lines[0].id, 3);
  assert.equal(lines[0].error.code, -32601);
  assert.equal(lines[0].error.message, "Method not found");
});

test("an unavailable vault reports it is not configured", async () => {
  const { input, closed, lines } = connect({ ...fakeVault, available: false });
  send(input, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_search", arguments: { query: "x" } } }]);
  await closed;
  const result = lines[0].result;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /not configured/);
});

test("ending input resolves closed", async () => {
  const { input, closed } = connect(fakeVault);
  let resolved = false;
  closed.then(() => {
    resolved = true;
  });
  send(input, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  await closed;
  assert.equal(resolved, true);
});
