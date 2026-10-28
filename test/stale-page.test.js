import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../server/index.js";

process.env.RAVNIR_AI_MEMORY = "off";

// On 2026-10-28 the Mac home-screen app showed "connecting…" with no agents: it ran a page from
// before the Skills page next to the new app.js, which threw binding the missing Skills button
// before it ever asked the server for anything.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startApp(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-stale-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A browser socket left open would keep close() waiting, so the wait is bounded.
  t.after(() => new Promise((resolve) => {
    const done = () => {
      // A browser the page made the server start may still be closing and writing its profile.
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // The temporary folder is left for the system to clean.
      }
      resolve();
    };
    const timer = setTimeout(done, 3000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      done();
    });
    server.closeAllConnections?.();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, pathname, body) => fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then((response) => response.json());
  return { base, call };
}

test("pages are never cached, and scripts answer 304 to their own tag", async (t) => {
  const { base } = await startApp(t);
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const script = await fetch(`${base}/app.js`);
  const tag = script.headers.get("etag");
  assert.match(tag, /^"[\w-]{22}"$/);
  assert.equal(script.headers.get("cache-control"), "no-cache");
  const again = await fetch(`${base}/app.js`, { headers: { "if-none-match": tag } });
  assert.equal(again.status, 304);
  const changed = await fetch(`${base}/app.js`, { headers: { "if-none-match": '"something-else"' } });
  assert.equal(changed.status, 200);
});

test("an out-of-date page next to a new app.js loads a fresh copy and connects", async (t) => {
  // The browser closes before the server: an open page keeps a connection the server waits on.
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { base, call } = await startApp(t);
  await call("POST", "/api/setup/done", { skipped: true });
  await call("POST", "/api/bots", { name: "Chief of Staff", job: "Coordinates the team." });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let served = 0;
  // The first load gets the page as it was before the Skills page: no Skills button or view.
  await page.route(`${base}/`, async (route) => {
    served += 1;
    const response = await route.fetch();
    const html = (await response.text())
      .replace(/<button id="skills-nav"[\s\S]*?<\/button>/, "")
      .replace(/<section id="skills-view"[\s\S]*?<\/section>/, "");
    await route.fulfill({ response, body: html });
  });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => !/connecting/.test(document.getElementById("server-url")?.textContent || ""), null, { timeout: 15_000 });
  assert.ok(served >= 1);
  assert.match(page.url(), /fresh=|\/$/);
  assert.equal(await page.locator("#skills-nav").count(), 1, "the fresh copy has the Skills button");
  assert.equal(await page.locator("#bot-count").textContent(), "1");
  assert.deepEqual(errors, []);
});

test("the current page is complete, so it never reloads itself", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { base, call } = await startApp(t);
  await call("POST", "/api/setup/done", { skipped: true });
  const page = await browser.newPage();
  const loads = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) loads.push(frame.url());
  });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => !/connecting/.test(document.getElementById("server-url")?.textContent || ""), null, { timeout: 15_000 });
  await page.waitForTimeout(500);
  assert.equal(loads.filter((url) => url.includes("fresh=")).length, 0, loads.join(" "));
});
