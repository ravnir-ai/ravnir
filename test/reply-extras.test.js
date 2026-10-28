import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../server/index.js";

process.env.RAVNIR_AI_MEMORY = "off";

// A reply with both a question card and a skill suggestion put two stacks in the same grid cell
// under the bubble, so the skill card was drawn over the question (seen on the iPhone, 2026-10-28).

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a reply's question and skill cards stack instead of overlapping", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-reply-extras-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return (await response.json().catch(() => ({})));
  };
  await call("POST", "/api/setup/done", { skipped: true });
  const bot = (await call("POST", "/api/bots", { name: "Content", job: "Writes posts.", main: true })).bot;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/api\/bots\/[^/]+\/(browser|desktop)(\/|$|\?)/, (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.route(`**/api/bots/${bot.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const detail = await response.json();
    detail.conversation = [{
      id: "m1", role: "assistant", at: new Date().toISOString(), turnId: "t1",
      content: "Both routines keep the draft-only rule.",
      asks: [{ id: "a1", status: "open", question: "Which launch links should I watch?", need: "The post links on each account." }],
      suggestions: [{ id: "s1", kind: "skill", status: "accepted", title: "Add the Content calendar skill", why: "My weekly routine needs a sourced plan.", change: { skill: "content-calendar" } }],
      sources: [{ path: "Changelog.md", date: "2026-10-26" }],
    }];
    await route.fulfill({ response, json: detail });
  });
  await page.goto(`${base}/?bot=${bot.id}`);
  const ask = page.locator(".chat-row .ask-card").first();
  const sugg = page.locator(".chat-row .sugg-card").first();
  await sugg.waitFor();
  const a = await ask.boundingBox();
  const s = await sugg.boundingBox();
  assert.ok(a && s, "both cards are drawn");
  assert.ok(s.y >= a.y + a.height - 1 || a.y >= s.y + s.height - 1, `cards overlap: ask ${JSON.stringify(a)} skill ${JSON.stringify(s)}`);
  assert.deepEqual(errors, []);
});
