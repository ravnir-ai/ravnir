import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { extractModels, promptBody } from "../server/providers/opencode.js";
import { attachmentNote, findUpload, safeName, typeOf, withAttachments } from "../server/uploads.js";
import { startMock } from "../scripts/mock-openai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("upload names stay inside the uploads folder and keep their extension", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Users\\me\\photo 1.png"), "photo 1.png");
  assert.equal(safeName(".env"), "env");
  assert.equal(safeName("a<b>c?.txt"), "abc.txt");
  assert.equal(safeName(""), "file");
  assert.equal(safeName(`${"x".repeat(200)}.jpeg`).length, 120);
  assert.ok(safeName(`${"x".repeat(200)}.jpeg`).endsWith(".jpeg"));
  assert.equal(typeOf("Photo.JPG"), "image/jpeg");
  assert.equal(typeOf("notes", "text/plain; charset=utf-8"), "text/plain");
  assert.equal(typeOf("blob", "not a type"), "application/octet-stream");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-uploads-"));
  fs.mkdirSync(path.join(workspace, "uploads", "2026-10-25"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "uploads", "2026-10-25", "a.txt"), "hi");
  fs.writeFileSync(path.join(workspace, "secret.txt"), "no");
  assert.equal(findUpload(workspace, "2026-10-25/a.txt").path, "uploads/2026-10-25/a.txt");
  for (const id of ["2026-10-25/../../secret.txt", "../secret.txt", "2026-10-25", "2026-10-25/a.txt/x", "today/a.txt", "2026-10-25/missing.txt"]) {
    assert.equal(findUpload(workspace, id), null, id);
  }
  const note = attachmentNote([{ path: "uploads/2026-10-25/a.txt", type: "text/plain", size: 2048 }]);
  assert.match(note, /attached a file, saved in your workspace/);
  assert.match(note, /uploads\/2026-10-25\/a\.txt \(text\/plain, 2 KB\)/);
  assert.equal(withAttachments("hello", []), "hello");
  assert.match(withAttachments("", [{ path: "uploads/x.png", type: "image/png", size: 10 }]), /^\[The user attached/);
});

test("OpenCode gets photos as file parts, and the model list says which models take images", () => {
  const body = promptBody({ text: "Look", files: [{ type: "image/png", name: "a.png", url: "data:image/png;base64,AA==" }], systemPrompt: "Be brief", model: { providerID: "p", modelID: "m" } });
  assert.deepEqual(body.parts, [{ type: "text", text: "Look" }, { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AA==" }]);
  assert.deepEqual(body.model, { providerID: "p", modelID: "m" });
  const models = extractModels({
    all: [{
      id: "p",
      models: {
        seer: { id: "seer", capabilities: { input: { image: true } } },
        blind: { id: "blind", capabilities: { input: { image: false } } },
        old: { id: "old", modalities: { input: ["text"] } },
        plain: { id: "plain" },
      },
    }],
  });
  const images = Object.fromEntries(models.map((model) => [model.id, model.images]));
  assert.deepEqual(images, { "p/seer": true, "p/blind": false, "p/old": false, "p/plain": undefined });
});

test("files attached in the composer reach the workspace, the thread and the model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-uploads-app-"));
  const mock = await startMock();
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  const upload = async (id, name, type, bytes) => {
    const response = await fetch(`${base}/api/bots/${id}/uploads`, { method: "POST", headers: { "content-type": type, "x-file-name": encodeURIComponent(name) }, body: bytes });
    return { status: response.status, data: await response.json() };
  };
  const reply = async (id, count) => {
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      detail = (await call("GET", `/api/bots/${id}`)).data;
      const replies = detail.conversation.filter((message) => message.role === "assistant" && message.kind !== "intro" && message.kind !== "ack");
      if (!detail.runtime?.busy && replies.length >= count) return { detail, text: replies.at(-1).content };
    }
    throw new Error("no reply");
  };
  try {
    const { data: created } = await call("POST", "/api/bots", { name: "Looker", job: "Looks at things.", model: { provider: "openai", baseUrl: mock.url, model: "mock-model" } });
    const id = created.bot.id;

    const photo = await upload(id, "My photo.png", "image/png", PNG);
    assert.equal(photo.status, 201);
    assert.equal(photo.data.path, `uploads/${photo.data.id}`);
    assert.equal(photo.data.type, "image/png");
    const sheet = await upload(id, "../numbers.csv", "text/csv", Buffer.from("a,b\n1,2\n"));
    assert.equal(sheet.data.name, "numbers.csv");
    const again = await upload(id, "numbers.csv", "text/csv", Buffer.from("c\n"));
    assert.equal(again.data.name, "numbers-2.csv");
    assert.equal((await upload(id, "empty.txt", "text/plain", Buffer.alloc(0))).status, 400);
    const workspace = path.join(home, "bots", id, "workspace");
    assert.equal(fs.readFileSync(path.join(workspace, sheet.data.path), "utf8"), "a,b\n1,2\n");

    const served = await fetch(`${base}${photo.data.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.match(served.headers.get("content-security-policy"), /^sandbox/);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
    const download = await fetch(`${base}${sheet.data.url}`);
    assert.equal(download.headers.get("content-type"), "application/octet-stream");
    assert.match(download.headers.get("content-disposition"), /^attachment/);
    assert.equal((await fetch(`${base}/api/bots/${id}/uploads/2026-01-01/nothing.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/bots/${id}/uploads/..%2F..%2Fstate.json/x`)).status, 404);

    // A photo with no text is a message; the model sees the image and the paths.
    const sent = await call("POST", `/api/bots/${id}/messages`, { text: "", attachments: [photo.data.id, sheet.data.id] });
    assert.equal(sent.status, 202);
    const first = await reply(id, 1);
    assert.match(first.text, /\[image\]/);
    assert.match(first.text, new RegExp(`uploads/${photo.data.id.replace(".", "\\.")}`));
    assert.match(first.text, /numbers\.csv \(text\/csv/);
    const mine = first.detail.conversation.find((message) => message.role === "user" && message.attachments);
    assert.deepEqual(mine.attachments.map((item) => item.name), ["My photo.png", "numbers.csv"]);
    assert.equal(mine.content, "");
    assert.equal(JSON.stringify(mine).includes(home), false, "no absolute paths in the thread");

    // A model that refuses images still answers, from the text and the paths.
    await call("POST", `/api/bots/${id}/messages`, { text: "Describe this, blind model", attachments: [photo.data.id] });
    const second = await reply(id, 2);
    assert.doesNotMatch(second.text, /\[image\]/);
    assert.match(second.text, /cannot look at images/);

    assert.equal((await call("POST", `/api/bots/${id}/messages`, { text: "", attachments: [] })).status, 400);
    assert.equal((await call("POST", `/api/bots/${id}/messages`, { text: "x", attachments: ["2026-01-01/gone.png"] })).status, 400);
    assert.equal((await call("POST", `/api/bots/${id}/messages`, { text: "x", attachments: Array.from({ length: 11 }, () => photo.data.id) })).status, 400);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await mock.close();
  }
});
