import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { startMock } from "../scripts/mock-openai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

test("a turn's proof joins its tools, file changes and cost", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-proof-"));
  const mock = await startMock();
  const app = await start(home);
  try {
    const created = await request(app.base, "POST", "/api/bots", {
      name: "Prover",
      group: "QA",
      job: "Shows what it did.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const id = created.bot.id;
    await request(app.base, "POST", `/api/bots/${id}/connectors`, {
      name: "Mock tools",
      transport: "stdio",
      command: process.execPath,
      args: [path.join(projectRoot, "scripts", "mock-mcp.js")],
    });

    const before = (await request(app.base, "GET", `/api/bots/${id}`)).lastSeq || 0;
    const sent = await request(app.base, "POST", `/api/bots/${id}/messages`, { text: "Please echo this" });
    await waitForTurn(app.base, id, before, sent.turnId);

    const proof = await request(app.base, "GET", `/api/turns/${sent.turnId}/proof`);
    assert.equal(proof.turn.id, sent.turnId);
    assert.equal(proof.turn.status, "ok");
    assert.ok(proof.turn.tokens > 0);
    assert.ok(proof.turn.cost > 0);
    assert.equal(Array.isArray(proof.sources), true);
    assert.ok(proof.actions.length >= 1);
    const echo = proof.actions.find((action) => /echo/.test(action.name));
    assert.ok(echo, "the tool call is in the proof");
    assert.equal(echo.status, "completed");
    assert.match(echo.output, /from mcp/);

    const diffBefore = (await request(app.base, "GET", `/api/bots/${id}`)).lastSeq || 0;
    const writing = await request(app.base, "POST", `/api/bots/${id}/messages`, { text: "Create hello.txt" });
    await waitForTurn(app.base, id, diffBefore, writing.turnId);
    const diffProof = await request(app.base, "GET", `/api/turns/${writing.turnId}/proof`);
    assert.equal(diffProof.diffs.some((diff) => diff.path === "hello.txt"), true);
    assert.ok(diffProof.diffs.find((diff) => diff.path === "hello.txt").patch.includes("hello from ravnir"));
  } finally {
    await close(app.server);
    await mock.close();
  }
});

test("a turn's proof includes the approval it asked for", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-proof-approval-"));
  const mock = await startMock();
  const app = await start(home);
  try {
    const created = await request(app.base, "POST", "/api/bots", {
      name: "Approver",
      group: "QA",
      job: "Runs commands.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const id = created.bot.id;
    const before = (await request(app.base, "GET", `/api/bots/${id}`)).lastSeq || 0;
    const sent = await request(app.base, "POST", `/api/bots/${id}/messages`, { text: "run command: echo approved-run" });
    const pending = await waitFor(async () => (await request(app.base, "GET", "/api/approvals")).pending[0]);
    await request(app.base, "POST", `/api/approvals/${pending.id}`, { decision: "once" });
    await waitForTurn(app.base, id, before, sent.turnId);

    const proof = await request(app.base, "GET", `/api/turns/${sent.turnId}/proof`);
    const approval = proof.approvals.find((item) => item.id === pending.id);
    assert.ok(approval, "the approval is in the proof");
    assert.equal(approval.status, "approved");
    assert.equal(approval.decision, "once");
  } finally {
    await close(app.server);
    await mock.close();
  }
});

async function start(home) {
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForTurn(base, id, after, turnId) {
  let cursor = after;
  const collected = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await sleep(100);
    const data = await request(base, "GET", `/api/bots/${id}/events?after=${cursor}`);
    cursor = data.cursor;
    collected.push(...data.events);
    if (data.events.some((event) => event.type === "turn.end" && (!turnId || event.turnId === turnId))) return collected;
  }
  throw new Error("The turn did not finish.");
}

async function waitFor(fn) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  return null;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
