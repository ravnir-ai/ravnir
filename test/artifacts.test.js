import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ArtifactStore, callArtifactTool, rawHeaders } from "../server/artifacts.js";
import { builtinToolDefinitions } from "../server/computer.js";
import { createApp } from "../server/index.js";
import { startMock } from "../scripts/mock-openai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

function store() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-artifacts-"));
  const bot = { id: "b1" };
  const workspace = path.join(home, "bots", "b1", "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return { home, bot, workspace, artifacts: new ArtifactStore(home) };
}

test("artifacts are versioned, validated and listed newest first", () => {
  const { bot, artifacts } = store();
  const doc = artifacts.create(bot, { title: "  Plan  ", kind: "markdown", content: "# Plan\n\n- one" });
  assert.match(doc.id, /^a_[0-9a-f]{12}$/);
  assert.equal(doc.title, "Plan");
  const v2 = artifacts.update(bot, doc.id, { content: "# Plan v2", note: "shorter" });
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.versions.map((item) => item.v), [1, 2]);
  assert.equal(fs.readFileSync(artifacts.read(bot, doc.id, 1).file, "utf8"), "# Plan\n\n- one");
  assert.equal(fs.readFileSync(artifacts.read(bot, doc.id).file, "utf8"), "# Plan v2");
  assert.equal(artifacts.read(bot, doc.id, 9).missing, true);

  assert.throws(() => artifacts.create(bot, { title: "x", kind: "exe", content: "x" }), /Unknown artifact kind/);
  assert.throws(() => artifacts.create(bot, { title: "x", kind: "markdown", content: "  " }), /empty/);
  assert.throws(() => artifacts.create(bot, { title: "x", kind: "chart", content: "{\"type\":\"bar\"}" }), /chart spec is not valid/);
  assert.throws(() => artifacts.create(bot, { title: "x", kind: "svg", content: "<html>" }), /<svg>/);
  assert.throws(() => artifacts.update(bot, "a_000000000000", { content: "x" }), /No artifact/);
  assert.equal(artifacts.read(bot, "../../etc/passwd"), null, "ids are checked before touching the disk");
  const chart = artifacts.create(bot, { title: "Spend", kind: "chart", content: JSON.stringify({ type: "bar", labels: ["a", "b"], series: [{ name: "s", data: [1, 2] }] }) });
  assert.deepEqual(artifacts.list(bot).map((item) => item.id).sort(), [doc.id, chart.id].sort());
});

test("share_file copies a workspace file and refuses anything outside it", () => {
  const { home, bot, workspace, artifacts } = store();
  fs.writeFileSync(path.join(workspace, "report.pdf"), "%PDF-1.4 fake");
  fs.writeFileSync(path.join(home, "secret.txt"), "nope");
  fs.symlinkSync(path.join(home, "secret.txt"), path.join(workspace, "link.txt"));
  const meta = artifacts.shareFile(bot, workspace, { path: "report.pdf" });
  assert.equal(meta.kind, "file");
  assert.equal(meta.mime, "application/pdf");
  fs.writeFileSync(path.join(workspace, "report.pdf"), "changed later");
  assert.equal(fs.readFileSync(artifacts.read(bot, meta.id).file, "utf8"), "%PDF-1.4 fake", "the user keeps what they were given");
  assert.throws(() => artifacts.shareFile(bot, workspace, { path: "../../../secret.txt" }), /inside your workspace/);
  assert.throws(() => artifacts.shareFile(bot, workspace, { path: "link.txt" }), /inside your workspace/);
  assert.throws(() => artifacts.shareFile(bot, workspace, { path: "missing.pdf" }), /no file/);
  assert.throws(() => artifacts.update(bot, meta.id, { content: "x" }), /cannot be edited/);
});

test("raw HTML and SVG run sandboxed; unknown files download", () => {
  const html = rawHeaders({ kind: "html", mime: "text/html; charset=utf-8", title: "Dash board", version: 1 });
  assert.match(html["content-security-policy"], /^sandbox allow-scripts/);
  assert.doesNotMatch(html["content-security-policy"], /allow-same-origin/);
  assert.equal(html["x-content-type-options"], "nosniff");
  assert.match(html["content-disposition"], /^inline; filename="dash-board\.html"/);
  const svg = rawHeaders({ kind: "svg", mime: "image/svg+xml", title: "Logo", version: 1 });
  assert.match(svg["content-security-policy"], /^sandbox; default-src 'none'/);
  const file = rawHeaders({ kind: "file", mime: "application/octet-stream", filename: "x.bin", title: "x", version: 1 });
  assert.match(file["content-disposition"], /^attachment/);
  const shared = rawHeaders({ kind: "file", mime: "text/html; charset=utf-8", filename: "page.html", title: "p", version: 1 });
  assert.match(shared["content-security-policy"], /^sandbox/, "an HTML file shared from the workspace is sandboxed too");
  assert.match(rawHeaders({ kind: "markdown", mime: "text/markdown; charset=utf-8", title: "Plan", version: 2 }, { download: true, version: 1 })["content-disposition"], /attachment; filename="plan-v1\.md"/);
});

test("the artifact tools are offered to every agent and report back in plain words", () => {
  const names = builtinToolDefinitions().map((tool) => tool.name);
  for (const name of ["create_artifact", "update_artifact", "list_artifacts", "read_artifact", "share_file"]) assert.ok(names.includes(name), name);
  const { bot, workspace, artifacts } = store();
  const saved = [];
  const created = callArtifactTool("create_artifact", { title: "Table", kind: "csv", content: "a,b\n1,2" }, { store: artifacts, bot, workspace, onSaved: (meta) => saved.push(meta) });
  assert.match(created.text, /Saved "Table" \(id a_/);
  assert.equal(saved.length, 1);
  const read = callArtifactTool("read_artifact", { id: saved[0].id }, { store: artifacts, bot, workspace });
  assert.match(read.text, /a,b\n1,2/);
  assert.match(callArtifactTool("list_artifacts", {}, { store: artifacts, bot, workspace }).text, /csv · v1 · Table/);
});

test("an artifact made during a turn shows as a card on the reply and is served over the API", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-artifacts-app-"));
  const mock = await startMock();
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})) };
  };
  try {
    const { data: created } = await call("POST", "/api/bots", { name: "Maker", job: "Makes things.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } });
    const id = created.bot.id;
    const page = "<!doctype html><title>Hi</title><script>document.title='ran'</script><p>Hello</p>";
    await call("POST", `/api/bots/${id}/messages`, { text: `call tool create_artifact ${JSON.stringify({ title: "Hello page", kind: "html", content: page })}` });
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      detail = (await call("GET", `/api/bots/${id}`)).data;
      if (!detail.runtime?.busy && detail.conversation.some((message) => message.artifacts)) break;
    }
    const reply = detail.conversation.find((message) => message.artifacts);
    assert.ok(reply, "the reply carries the artifact");
    assert.equal(reply.artifacts[0].title, "Hello page");
    assert.equal(reply.artifacts[0].kind, "html");

    const list = await call("GET", `/api/bots/${id}/artifacts`);
    assert.equal(list.data.artifacts.length, 1);
    const artifactId = list.data.artifacts[0].id;
    const one = await call("GET", `/api/bots/${id}/artifacts/${artifactId}`);
    assert.equal(one.data.content, page);
    const raw = await fetch(`${base}/api/bots/${id}/artifacts/${artifactId}/raw`);
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get("content-security-policy"), /^sandbox allow-scripts/);
    assert.equal(await raw.text(), page);
    // A sandboxed page is cross-site to the app, so the API refuses it.
    const blocked = await fetch(`${base}/api/state`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(blocked.status, 403);
    assert.equal((await call("GET", `/api/bots/${id}/artifacts/a_000000000000`)).status, 404);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
  }
});
