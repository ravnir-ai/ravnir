import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright";

const memorySource = fs.readFileSync(new URL("../public/memory.js", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

async function pageFor(t, apiSource) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.setContent('<div id="memory-body"></div><div id="job-list"></div>');
  await page.addScriptTag({ content: `
    const state = { bots: [], jobs: [] };
    const els = { "memory-body": document.getElementById("memory-body"), "job-list": document.getElementById("job-list") };
    ${appSource.slice(appSource.indexOf("function el(tag,"), appSource.indexOf("\nfunction note(text)"))}
    const toast = () => {};
    const timeAgo = () => "just now";
    const stampLabel = () => "today";
    const clearAvatar = (node, text) => { node.textContent = text; };
    const initials = (name) => name.slice(0, 1);
    const summary = { available: true, history: true, notes: 1, authors: [{name: "Scout", commits: 1}] };
    const entry = (author) => ({ hash: "abcdef1", author, at: "2026-10-25T12:00:00Z", summary: author + " saved a note", files: [] });
    ${apiSource}
  ` });
  await page.addScriptTag({ content: memorySource });
  return page;
}

test("a failed Notes request shows an error and can be retried without claiming the vault is empty", async (t) => {
  const page = await pageFor(t, `
    let failed = false;
    async function api(url) {
      if (url === "/api/memory") return summary;
      if (url.startsWith("/api/memory/log?")) return { items: [] };
      if (!failed) { failed = true; throw new Error("Could not load notes."); }
      return { items: [{ path: "Rules.md", title: "Rules" }] };
    }
  `);
  await page.evaluate(() => window.RavnirMemory.open());
  await page.getByRole("tab", { name: "Notes" }).click();
  await page.waitForFunction(() => !document.querySelector(".mem-notes")?.textContent.includes("Loading"));
  assert.match(await page.locator(".mem-notes").innerText(), /Could not load notes/);
  assert.doesNotMatch(await page.locator(".mem-notes").innerText(), /has no notes/);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator(".mem-note-title", { hasText: "Rules" }).waitFor();
});

test("a failed history request shows an error and retry instead of an empty vault", async (t) => {
  const page = await pageFor(t, `
    let failed = false;
    async function api(url) {
      if (url === "/api/memory") return summary;
      if (!failed) { failed = true; throw new Error("Could not load history."); }
      return { items: [entry("Scout")] };
    }
  `);
  await page.evaluate(() => window.RavnirMemory.open());
  assert.match(await page.locator("#mem-timeline").innerText(), /Could not load history/);
  assert.doesNotMatch(await page.locator("#mem-timeline").innerText(), /Nothing has been saved/);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Scout saved a note", { exact: true }).waitFor();
});

test("changing a Memory filter while the first page loads cannot display the stale page", async (t) => {
  const page = await pageFor(t, `
    let resolveFirst;
    async function api(url) {
      if (url === "/api/memory") return summary;
      if (url.includes("agent=Scout")) return { items: [entry("Scout")] };
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    window.finishFirst = () => resolveFirst({ items: [entry("Other")] });
  `);
  await page.evaluate(() => { window.opening = window.RavnirMemory.open(); });
  await page.getByRole("combobox", { name: "Filter by agent" }).selectOption("Scout");
  await page.evaluate(async () => { window.finishFirst(); await window.opening; });
  assert.match(await page.locator("#mem-timeline").innerText(), /Scout saved a note/);
  assert.doesNotMatch(await page.locator("#mem-timeline").innerText(), /Other/);
});

test("routine run history stays open when polling redraws the job cards", async (t) => {
  const page = await pageFor(t, "const api = async () => summary;");
  await page.addScriptTag({ content: `
    state.jobs = [{ id: "job-1", runs: [{ at: 1, status: "ok", summary: "Checked" }] }];
    const plainText = (text) => text;
    function renderJobs() {
      const card = el("div", "item");
      card.dataset.jobId = "job-1";
      els["job-list"].replaceChildren(card);
    }
    ${appSource.slice(appSource.indexOf("function renderJobsWithSpend()"), appSource.indexOf("\nfunction turnCard("))}
    renderJobsWithSpend();
  ` });
  await page.getByText("Run history (1)").click();
  assert.equal(await page.locator(".job-runs").evaluate((node) => node.open), true);
  await page.evaluate(() => renderJobsWithSpend());
  assert.equal(await page.locator(".job-runs").evaluate((node) => node.open), true);
});

test("long git author names wrap inside a phone's Memory timeline", async (t) => {
  const page = await pageFor(t, `
    async function api(url) {
      if (url === "/api/memory") return summary;
      return { items: [entry("A".repeat(100))] };
    }
  `);
  await page.addStyleTag({ path: new URL("../public/app.css", import.meta.url).pathname });
  await page.addStyleTag({ path: new URL("../public/memory.css", import.meta.url).pathname });
  await page.evaluate(() => {
    els["memory-body"].className = "today-body memory-body";
    return window.RavnirMemory.open();
  });
  const right = await page.locator(".mem-entry-top strong").evaluate((node) => node.getBoundingClientRect().right);
  assert.ok(right <= 375, `Author extends past the phone: ${right}px`);
});
