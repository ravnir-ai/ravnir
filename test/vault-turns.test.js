import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { builtinToolsFor } from "../server/computer.js";
import { createApp } from "../server/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

function writeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-vault-turns-"));
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  put("Rules.md", "# Rules\nNever store secrets in the vault.\n");
  put("Agents/Chief-of-Staff.md", "# Chief of Staff\nRoutes work across the team. Watches [[Launch]].\n");
  put("Projects/Launch.md", "# Launch\nTikTok clips account, campaign launch-twitch. Goal: 10k followers by 2027-04-01.\n\n## Estado actual\nFollowers: 1234. Posts: 56. Data from 2026-10-22.\n");
  put("Projects/Acme.md", "# Acme\nClipping business.\n");
  return dir;
}

async function api(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(check, { tries = 100, delay = 100 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting.");
}

// Sends one message and returns the meta event of that turn: the live prompt and the vault notes it was given.
async function ask(base, id, text) {
  const { turnId } = await api(base, "POST", `/api/bots/${id}/messages`, { text });
  return waitFor(async () => {
    const { events } = await api(base, "GET", `/api/bots/${id}/events?after=0`);
    return events.some((event) => event.type === "turn.end" && event.turnId === turnId)
      && events.filter((event) => event.type === "meta").at(-1);
  });
}

const hashOf = (meta, note) => meta.vaultSources.find((source) => source.path === note)?.hash;

test("two agents asked about Launch get the same vault note at the same version", async () => {
  const dir = writeVault();
  process.env.RAVNIR_VAULT_DIR = dir;
  process.env.RAVNIR_VAULT_PULL_MS = "0";
  const mock = await startMock();
  const server = createApp({ home: fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-vault-home-")), projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitFor(async () => (await api(base, "GET", "/api/state")).vault?.notes === 4);
    const model = { provider: "openai", baseUrl: mock.url, model: "mock-model" };
    const hot = (await api(base, "POST", "/api/bots", { name: "Launch", job: "Runs the TikTok account.", model })).bot;
    const chief = (await api(base, "POST", "/api/bots", { name: "Chief of Staff", job: "Coordinates the team.", model })).bot;

    const fromHot = await ask(base, hot.id, "¿Cómo va la cuenta?");
    const fromChief = await ask(base, chief.id, "¿Cómo va la cuenta de Launch?");
    for (const meta of [fromHot, fromChief]) {
      assert.match(meta.livePrompt, /Followers: 1234\. Posts: 56\. Data from 2026-10-22\./);
      assert.match(meta.livePrompt, /### Projects\/Launch\.md \(updated \d{4}-\d{2}-\d{2}\)/);
      assert.match(meta.livePrompt, /Never store secrets in the vault\./);
      assert.match(meta.livePrompt, /cite the note and its date/);
      assert.doesNotMatch(meta.livePrompt, /ai-memory brain/);
    }
    assert.ok(hashOf(fromHot, "Projects/Launch.md"));
    assert.equal(hashOf(fromHot, "Projects/Launch.md"), hashOf(fromChief, "Projects/Launch.md"));
    assert.ok(hashOf(fromChief, "Agents/Chief-of-Staff.md"));
    assert.match(fromHot.livePrompt, /You have no note in Agents\/ yet\./);

    // The Mind tab shows the fixed part of the same block.
    const detail = await api(base, "GET", `/api/bots/${chief.id}`);
    assert.match(detail.livePrompt, /Followers: 1234/);

    // An edit reaches the next turn without a restart.
    const before = hashOf(fromChief, "Projects/Launch.md");
    fs.writeFileSync(path.join(dir, "Projects/Launch.md"), "# Launch\nTikTok clips account.\n\n## Estado actual\nFollowers: 1300. Posts: 60. Data from 2026-10-23.\n");
    await waitFor(async () => (await api(base, "GET", `/api/bots/${chief.id}`)).livePrompt.includes("Followers: 1300"), { tries: 80 });
    const after = await ask(base, chief.id, "¿Y ahora?");
    assert.match(after.livePrompt, /Followers: 1300/);
    assert.notEqual(hashOf(after, "Projects/Launch.md"), before);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
    delete process.env.RAVNIR_VAULT_DIR;
    delete process.env.RAVNIR_VAULT_PULL_MS;
  }
});

test("with the vault on, the vault tools replace the ai-memory tools", async () => {
  const bot = { vault: [] };
  const on = (await builtinToolsFor(bot, { vault: { available: true } })).map((tool) => tool.name);
  const off = (await builtinToolsFor(bot, {})).map((tool) => tool.name);
  assert.ok(on.includes("vault_search") && on.includes("vault_read") && on.includes("vault_links"));
  assert.ok(!on.some((name) => name.startsWith("memory_")));
  assert.ok(off.includes("memory_search"));
  assert.ok(!off.some((name) => name.startsWith("vault_")));
});

test("the per-bot MCP endpoint lists the same memory tools as the built-in loop", async () => {
  const { handleBuiltinMcp } = await import("../server/mcpBuiltin.js");
  const list = async (vaultOn) => (await handleBuiltinMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    bot: {},
    token: "t",
    header: "Bearer t",
    ctx: { vaultOn, callBuiltin: async () => ({ text: "" }) },
  })).json.result.tools.map((tool) => tool.name);
  const on = await list(true);
  const off = await list(false);
  assert.ok(on.includes("vault_search") && !on.some((name) => name.startsWith("memory_")));
  assert.ok(off.includes("memory_search") && !off.some((name) => name.startsWith("vault_")));
});

test("a status feed puts live status figures in the project block every bot gets", async () => {
  const dir = writeVault();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-vault-home-"));
  // Collectors are local modules (RAVNIR_STATUS_DIR, by default local/status); this one is made up for the test.
  const collectors = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-status-collectors-"));
  fs.writeFileSync(path.join(collectors, "demo.js"), [
    'export const kind = "demo";',
    "export function collect(feed) {",
    '  return { ok: true, text: `Live data from demo (read-only):\\n- TikTok followers: ${feed.followers.toLocaleString("en-US")}` };',
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(home, "status-feeds.json"), JSON.stringify([{ note: "Projects/Launch.md", type: "demo", followers: 4321 }]));
  process.env.RAVNIR_STATUS_DIR = collectors;
  process.env.RAVNIR_VAULT_DIR = dir;
  process.env.RAVNIR_VAULT_PULL_MS = "0";
  const mock = await startMock();
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitFor(async () => (await api(base, "GET", "/api/state")).vault?.feeds?.[0]?.ok);
    const hot = (await api(base, "POST", "/api/bots", { name: "Launch", job: "Runs the TikTok account.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } })).bot;
    const { livePrompt } = await api(base, "GET", `/api/bots/${hot.id}`);
    assert.match(livePrompt, /Live data from demo \(read-only\)/);
    assert.match(livePrompt, /TikTok followers: 4,321/);
    assert.doesNotMatch(livePrompt, /Followers: 1234/);

    // The model gets the live figures with the message itself; the thread keeps only what the user typed.
    await ask(base, hot.id, "¿Cómo va la cuenta?");
    const { conversation } = await api(base, "GET", `/api/bots/${hot.id}`);
    const reply = conversation.filter((message) => message.role === "assistant" && message.kind !== "ack").at(-1).content;
    assert.match(reply, /Vault data attached to this message by Ravnir/);
    assert.match(reply, /TikTok followers: 4,321/);
    assert.equal(conversation.filter((message) => message.role === "user").at(-1).content, "¿Cómo va la cuenta?");
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
    delete process.env.RAVNIR_VAULT_DIR;
    delete process.env.RAVNIR_VAULT_PULL_MS;
    delete process.env.RAVNIR_STATUS_DIR;
  }
});
