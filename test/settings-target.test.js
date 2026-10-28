import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../server/index.js";

process.env.RAVNIR_AI_MEMORY = "off";

// On 2026-10-25 Lead Engineer was saved with Chief of Staff's name, job, look, rules and main star:
// a slow detail response for the agent the user had left switched the selection back under the open
// Settings dialog, and Save wrote that dialog's values to whichever agent was selected by then.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startApp(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-settings-target-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // close() first so the browser's polling cannot open new connections, then drop the open ones.
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  return { base, call };
}

test("renaming an agent to another agent's name is refused", async (t) => {
  const { call } = await startApp(t);
  const chief = (await call("POST", "/api/bots", { name: "Chief of Staff", job: "Coordinates." })).data.bot;
  const engineer = (await call("POST", "/api/bots", { name: "Lead Engineer", job: "Builds." })).data.bot;
  const clash = await call("PATCH", `/api/bots/${engineer.id}`, { name: "chief of staff" });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /already called/);
  assert.equal((await call("GET", `/api/bots/${engineer.id}`)).data.bot.name, "Lead Engineer");
  assert.equal((await call("PATCH", `/api/bots/${chief.id}`, { name: "Chief of Staff", job: "Still coordinates." })).status, 200, "keeping your own name is fine");
  assert.equal((await call("PATCH", `/api/bots/${engineer.id}`, { name: "Staff Engineer" })).status, 200);
});

test("a late response for the agent you left cannot make Settings save onto it", async (t) => {
  const { base, call } = await startApp(t);
  await call("POST", "/api/setup/done", { skipped: true });
  const chief = (await call("POST", "/api/bots", { name: "Chief of Staff", job: "Coordinates the team.", main: true })).data.bot;
  const engineer = (await call("POST", "/api/bots", { name: "Lead Engineer", job: "Builds and ships code.", pinned: true })).data.bot;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const patches = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && /\/api\/bots\/[^/]+$/.test(new URL(request.url()).pathname)) {
      patches.push({ id: new URL(request.url()).pathname.split("/").pop(), body: request.postDataJSON() });
    }
  });

  // The agents' own browsers and desktops are not part of this test; launching one would outlive the server.
  await page.route(/\/api\/bots\/[^/]+\/(browser|desktop)(\/|$|\?)/, (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto(base);
  await page.locator(`[data-bot-id="${chief.id}"]`).first().click();
  await page.waitForFunction((name) => document.querySelector("#bot-head")?.textContent.includes(name), "Chief of Staff");

  // Hold the engineer's next detail response until the user has moved on.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let holding = true;
  await page.route(`**/api/bots/${engineer.id}`, async (route) => {
    if (route.request().method() !== "GET" || !holding) return route.continue();
    holding = false;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.locator(`[data-bot-id="${engineer.id}"]`).first().click();
  await page.locator(`[data-bot-id="${chief.id}"]`).first().click();
  await page.waitForFunction((name) => document.querySelector("#bot-head")?.textContent.includes(name), "Chief of Staff");

  await page.evaluate(() => document.getElementById("open-settings").click());
  await page.locator("#settings-dialog[open]").waitFor();
  assert.equal(await page.locator("#set-name").inputValue(), "Chief of Staff");
  release();
  await page.waitForTimeout(300);
  await page.locator("#set-job").fill("Coordinates the team and the roadmap.");
  await page.locator("#settings-form button[type=submit]").click();
  await page.waitForFunction(() => !document.querySelector("#settings-dialog")?.open || document.getElementById("set-error")?.textContent);

  assert.equal(patches.length, 1);
  assert.equal(patches[0].id, chief.id, "Save goes to the agent the dialog was opened for");
  assert.equal(await page.locator("#set-error").textContent(), "");
  const after = (await call("GET", "/api/state")).data.bots;
  const byId = Object.fromEntries(after.map((bot) => [bot.id, bot]));
  assert.equal(byId[engineer.id].name, "Lead Engineer");
  assert.equal(byId[engineer.id].job, "Builds and ships code.");
  assert.equal(byId[engineer.id].main, false);
  assert.equal(byId[chief.id].job, "Coordinates the team and the roadmap.");
  assert.ok(await page.locator("#bot-head").innerText().then((text) => text.includes("Chief of Staff")), "the late response did not switch the selection back");
  assert.deepEqual(errors, []);
});
