import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../server/index.js";
import { ArtifactStore } from "../server/artifacts.js";

process.env.RAVNIR_AI_MEMORY = "off";

// On 2026-10-28 PDFs would not open on the iPhone: the viewer had no preview, and "Open in new tab"
// or Download in the home-screen app opened a separate Safari with no sign-in, which got a 401.
// Now pages are drawn in the app with pdf.js, and the home-screen app shares the file itself.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a PDF opens inside the app, and the home-screen app shares the file", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-pdf-view-"));
  const server = createApp({ home, projectRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body) => fetch(`${base}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  await post("/api/setup/done", { skipped: true });
  const bot = (await post("/api/bots", { name: "Scout", job: "Research." })).bot;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  // A real two-page PDF, shared as a file and attached as an upload.
  const maker = await browser.newPage();
  await maker.setContent("<h1>Page one</h1><div style='break-after: page'></div><h1>Page two</h1>");
  const pdf = await maker.pdf({ format: "A4" });
  const workspace = path.join(home, "bots", bot.id, "workspace");
  fs.mkdirSync(path.join(workspace, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "outputs", "report.pdf"), pdf);
  const artifact = new ArtifactStore(home).shareFile({ id: bot.id }, workspace, { path: "outputs/report.pdf", title: "Report" });
  const upload = await fetch(`${base}/api/bots/${bot.id}/uploads`, { method: "POST", headers: { "x-file-name": "cv.pdf", "content-type": "application/pdf" }, body: pdf }).then((r) => r.json());

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.RavnirArtifacts && window.RavnirPdf);

  await page.evaluate(([botId, id]) => window.RavnirArtifacts.open(botId, id, {}), [bot.id, artifact.id]);
  await page.waitForFunction(() => document.querySelectorAll(".art-viewer .pdf-page canvas").length === 2, null, { timeout: 15_000 });
  const size = await page.$eval(".art-viewer .pdf-page", (node) => node.getBoundingClientRect().height);
  assert.ok(size > 300, `a page keeps its full height (got ${size}px)`);
  await page.click(".art-viewer .art-close");

  await page.evaluate((url) => window.RavnirPdf.openFile(url, "cv.pdf"), upload.url);
  await page.waitForFunction(() => document.querySelectorAll(".art-viewer .pdf-page canvas").length === 2, null, { timeout: 15_000 });
  await page.click(".art-viewer .art-close");

  // The home-screen app: Download becomes Share with the file, and no new tab.
  const shared = await page.evaluate(async ([botId, id]) => {
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    const files = [];
    navigator.canShare = () => true;
    navigator.share = async (data) => { files.push(...data.files.map((file) => [file.name, file.type, file.size])); };
    window.RavnirArtifacts.open(botId, id, {});
    await new Promise((resolve) => setTimeout(resolve, 800));
    const buttons = [...document.querySelectorAll(".art-viewer .art-controls > *")].filter((node) => !node.hidden).map((node) => node.textContent);
    [...document.querySelectorAll(".art-viewer .art-controls a")].find((node) => node.textContent === "Share").click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { buttons, files };
  }, [bot.id, artifact.id]);
  assert.deepEqual(shared.buttons, ["Share", "Close"]);
  assert.deepEqual(shared.files, [["report.pdf", "application/pdf", pdf.length]]);
  assert.deepEqual(errors, []);
});
