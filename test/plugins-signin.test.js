import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startOAuthMcp } from "../scripts/mock-oauth-mcp.js";
import { createApp } from "../server/index.js";

process.env.RAVNIR_AI_MEMORY = "off";

// On 2026-10-28 a Vercel sign-in that never came back left Plugins on "Signing in": Cancel only
// reloaded the list, Connect stayed disabled for ten minutes, and the page redrew itself every
// 1.5 seconds while it waited, which made it flicker.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(projectRoot, "test", "fixtures", "plugin-catalog.json");
const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-${name}-`));

test("a sign-in that never comes back can be cancelled, retried, and does not make the page flicker", async (t) => {
  const mock = await startOAuthMcp();
  t.after(() => mock.close());
  const catalog = path.join(tempDir("catalog"), "catalog.json");
  fs.writeFileSync(catalog, fs.readFileSync(fixture, "utf8").split("__MOCK__").join(mock.url).split("__OPEN__").join("http://127.0.0.1:1"));
  const server = createApp({ home: tempDir("signin"), projectRoot, pluginCatalog: catalog, pluginRuntime: { name: "", bin: "" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/setup/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skipped: true }) });
  const pending = async () => (await (await fetch(`${base}/api/plugins`)).json()).plugins.find((item) => item.id === "mockoauth").pending;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  // The service's sign-in page never answers, like a sign-in the user abandoned.
  await context.route(`${mock.url}/**`, (route) => (new URL(route.request().url()).pathname.includes("authorize") ? route.abort() : route.continue()));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => typeof window.openPluginsPage === "function");
  await page.evaluate(() => document.getElementById("plugins-nav").click());
  await page.locator(".plug-card", { hasText: "Mock Notes" }).first().click();
  await page.waitForSelector(".plug-dialog[open]");

  const signIn = () => page.locator(".plug-dialog button.primary").click();
  const popupOpened = page.waitForEvent("popup");
  const started = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/plugins/mockoauth/connect");
  await signIn();
  const popup = await popupOpened;
  await started;
  await page.waitForSelector(".plug-dialog button:has-text('Cancel sign-in')");
  // Starting the sign-in redraws once more after its request (on a slow machine, after the button
  // already shows); the quiet window below begins after that list refresh.
  await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/plugins");
  await page.waitForTimeout(300);
  assert.equal(await pending(), true);
  assert.equal(await page.locator(".plug-dialog button.primary").textContent(), "Sign in again");
  assert.equal(await page.locator(".plug-dialog button.primary").isDisabled(), false, "a stuck sign-in never blocks the next one");

  // While it waits, the list is polled but nothing is drawn again.
  const redraws = await page.evaluate(async () => {
    let count = 0;
    const watch = new MutationObserver(() => { count += 1; });
    for (const node of [document.getElementById("plugins-body"), document.querySelector(".plug-dialog")]) watch.observe(node, { childList: true, subtree: true });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    watch.disconnect();
    return count;
  });
  assert.equal(redraws, 0, `the page redrew ${redraws} times while nothing changed`);

  await page.locator(".plug-dialog button:has-text('Cancel sign-in')").click();
  await page.waitForFunction(() => !document.querySelector(".plug-dialog button.primary")?.textContent.includes("again"));
  assert.equal(await pending(), false, "Cancel ends the sign-in on the server");
  assert.equal(popup.isClosed(), true);

  // Closing the sign-in window ends it too.
  const secondOpened = page.waitForEvent("popup");
  await signIn();
  const second = await secondOpened;
  await page.waitForSelector(".plug-dialog button:has-text('Cancel sign-in')");
  await second.close();
  const deadline = Date.now() + 12_000;
  while ((await pending()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await pending(), false, "a closed sign-in window cancels the sign-in");
  assert.deepEqual(errors, []);
});

test("a service that only returns to the user's own computer is finished by pasting the address", async (t) => {
  // Vercel accepts only 127.0.0.1 or localhost as the return address, so the sign-in window ends on a page that does not load.
  const mock = await startOAuthMcp({ loopbackOnly: true });
  t.after(() => mock.close());
  const catalog = path.join(tempDir("catalog"), "catalog.json");
  fs.writeFileSync(catalog, fs.readFileSync(fixture, "utf8").split("__MOCK__").join(mock.url).split("__OPEN__").join("http://127.0.0.1:1"));
  const server = createApp({ home: tempDir("paste"), projectRoot, pluginCatalog: catalog, pluginRuntime: { name: "", bin: "" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  // The app as the phone sees it, on another address than the sign-in's 127.0.0.1:3847.
  const base = `http://ravnir.localhost:${server.address().port}`;
  await fetch(`${base}/api/setup/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skipped: true }) });

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  let landed = "";
  // Copy the address the sign-in window ends on, as the user would from its address bar.
  context.on("request", (request) => {
    if (request.url().startsWith("http://127.0.0.1:3847/")) landed = request.url();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => typeof window.openPluginsPage === "function");
  await page.evaluate(() => document.getElementById("plugins-nav").click());
  await page.locator(".plug-card", { hasText: "Mock Notes" }).first().click();
  await page.waitForSelector(".plug-dialog[open]");
  await page.locator(".plug-dialog button.primary").click();
  // The app stays on the paste box; the sign-in opens from a link in the real browser.
  await page.waitForSelector(".plug-dialog input[type=url]");
  assert.equal(context.pages().length, 1, "no window takes over the app");
  const tabOpened = context.waitForEvent("page");
  await page.locator(".plug-dialog a.plug-open-signin").click();
  const tab = await tabOpened;
  const deadline = Date.now() + 10_000;
  while (!landed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(landed, /code=/, "the mock service sent the browser back with a code");
  await tab.close();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(await page.locator(".plug-dialog input[type=url]").count(), 1, "closing that tab after copying does not cancel");

  await page.fill(".plug-dialog input[type=url]", landed);
  await page.locator(".plug-dialog button", { hasText: "Finish" }).click();
  await page.waitForFunction(async () => {
    const data = await (await fetch("/api/plugins")).json();
    return data.plugins.find((item) => item.id === "mockoauth").connected;
  }, null, { timeout: 10_000 });

  // The next time, the app knows and asks the server for the right address straight away.
  const known = await page.evaluate(async () => (await (await fetch("/api/plugins")).json()).plugins.find((item) => item.id === "mockoauth").paste);
  assert.equal(known, true);
  assert.deepEqual(errors, []);
});
