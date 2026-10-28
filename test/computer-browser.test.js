import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserManager } from "../server/browser.js";
import { browserDriver, scroll } from "../server/computerUse.js";

// computer_task in a real browser: a page whose campaigns are clickable cards (no button
// or link), behind a sidebar of 30 links, and a page that scrolls an inner panel.
const nav = Array.from({ length: 30 }, (_, index) => `<a href="#c${index}">Chat ${index}</a>`).join("");
const cards = ["Ana Demo - Casa Norte (Inversiones Inmobiliarias)", "Diego Ejemplo", "Northwind Coffee"]
  .map((name, index) => `<div class="card" style="cursor:pointer;padding:12px;margin:8px;border:1px solid #ccc" onclick="location.href='/campaign/${index + 1}'"><h3>${name}</h3><p>0.80 per 1000 views</p><span>Ver más</span></div>`)
  .join("");
const offers = ["Spring sale", "Summer sale"].map((name) => `<section><h3>${name}</h3><button>See details</button></section>`).join("");
const pages = {
  "/": `<!doctype html><title>Campaigns</title><body><nav style="display:flex;flex-direction:column">${nav}</nav><main>${cards}</main></body>`,
  "/offers": `<!doctype html><title>Offers</title><body>${offers}</body>`,
  "/campaign/1": "<!doctype html><title>Campaign</title><body><h1>Requisitos: TikTok</h1></body>",
  "/terms": `<!doctype html><title>Terms</title><body><label><input type="checkbox" id="agree"> I agree</label><select id="plan"><option>Free</option><option>Pro</option></select></body>`,
  "/panel": `<!doctype html><title>Panel</title><style>html,body{margin:0;height:100%;overflow:hidden}#panel{height:100%;overflow-y:auto}#panel div{height:300vh}</style><body><div id="panel"><div>Long list</div></div></body>`,
};

function startSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = pages[new URL(req.url, "http://x").pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body || "not found");
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }));
  });
}

async function withBrowser(t, fn) {
  const site = await startSite();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-computer-browser-"));
  const browser = new BrowserManager({ home });
  const bot = { id: "computer-browser", name: "Computer browser" };
  try {
    let session;
    try {
      session = await browser.ensure(bot);
    } catch (error) {
      t.skip(`no browser here: ${error.message}`);
      return;
    }
    await fn({ site, home, browser, bot, session });
  } finally {
    await browser.closeAll().catch(() => {});
    await site.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("computer_task offers clickable cards behind a long sidebar, names repeated buttons, and clicks a card", async (t) => {
  await withBrowser(t, async ({ site, home, browser, bot, session }) => {
    await session.navigate(site.url);
    const driver = await browserDriver({ bot, browser, home });
    const seen = await driver.observe(0, { goal: "abrir la campaña Ana Demo - Casa Norte" });
    const labels = seen.actions.map((action) => action.label);
    assert.ok(labels.length <= 24, `${labels.length} actions`);
    const card = seen.actions.find((action) => action.label.includes("Ana Demo"));
    assert.ok(card, labels.join("\n"));
    assert.ok(labels.indexOf(card.label) < 3, labels.join("\n"));

    await driver.perform(card);
    assert.match(session.page.url(), /\/campaign\/1$/);
    // The marks from earlier reads do not pile up.
    await driver.observe(1, {});
    await driver.observe(2, {});
    assert.equal(await session.evaluate(`document.querySelectorAll('[data-ravnir-click="0"]').length`), 0);

    // Two "See details" buttons, each named by its section.
    await session.navigate(`${site.url}/offers`);
    const offered = (await driver.observe(3, {})).actions.map((action) => action.label);
    assert.deepEqual(offered.slice(0, 2), ['Click "See details" in "Spring sale"', 'Click "See details" in "Summer sale"']);
  });
});

test("computer_task scrolls the inner panel of a page that does not scroll itself", async (t) => {
  await withBrowser(t, async ({ site, home, browser, bot, session }) => {
    await session.navigate(`${site.url}/panel`);
    const driver = await browserDriver({ bot, browser, home });
    const before = await driver.observe(0, {});
    await scroll(session, 800);
    assert.ok(await session.evaluate("document.getElementById('panel').scrollTop") > 0);
    // The scroll counts as a change of screen, though the text and actions are the same.
    const after = await driver.observe(1, {});
    assert.equal(after.state.page, before.state.page);
    assert.notEqual(after.fingerprint, before.fingerprint);
    // Back up through the scroll action itself.
    await driver.perform(before.actions.find((action) => action.label === "Scroll up"));
    assert.equal(await session.evaluate("document.getElementById('panel').scrollTop"), 0);
  });
});

test("computer_task sees a ticked box or a new dropdown choice as a change of screen", async (t) => {
  await withBrowser(t, async ({ site, home, browser, bot, session }) => {
    await session.navigate(`${site.url}/terms`);
    const driver = await browserDriver({ bot, browser, home });
    const before = await driver.observe(0, {});
    // A checkbox keeps its value ("on") when ticked; only its checked state moves.
    await session.evaluate("document.getElementById('agree').checked = true");
    const ticked = await driver.observe(1, {});
    assert.equal(ticked.state.page, before.state.page);
    assert.notEqual(ticked.fingerprint, before.fingerprint);
    await session.evaluate("document.getElementById('plan').selectedIndex = 1");
    const chosen = await driver.observe(2, {});
    assert.notEqual(chosen.fingerprint, ticked.fingerprint);
  });
});
