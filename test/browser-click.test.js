import assert from "node:assert/strict";
import test from "node:test";
import { callBuiltinTool } from "../server/computer.js";
import { withBrowser } from "./fixtures/browser-site.js";

// Seen in a replay: browser_click "VER HORARIOS Y TARIFAS" said "Clicked." and showed the
// home page, because it picked a hidden copy in a closed menu and read before the next
// page arrived.
test("browser_click by text clicks the visible match and reads the page it opens", async (t) => {
  await withBrowser(t, {
    "/": `<title>Museo</title>
      <nav style="display:none"><a href="/wrong">Ver horarios y tarifas</a></nav>
      <p>Bienvenida</p>
      <a href="/horarios-tarifas" style="text-transform:uppercase">Ver horarios y tarifas</a>`,
    "/horarios-tarifas": { delay: 900, body: "<title>Horarios</title><p>Martes cerrado. Lunes 10:00-21:00</p>" },
    "/wrong": "<title>Wrong</title><p>wrong page</p>",
    "/menu": `<title>Menu</title><nav style="display:none"><a href="/horarios-tarifas">Horarios y tarifas</a></nav><p>Only a closed menu here.</p>`,
  }, async ({ base, ctx }) => {
    await callBuiltinTool("browser_open", { url: `${base}/` }, ctx);
    const clicked = await callBuiltinTool("browser_click", { text: "VER HORARIOS Y TARIFAS" }, ctx);
    assert.match(clicked.text, /Martes cerrado/);
    assert.match(clicked.text, /\/horarios-tarifas\n/);

    // Only a hidden copy: open where it points, and say so.
    await callBuiltinTool("browser_open", { url: `${base}/menu` }, ctx);
    const hidden = await callBuiltinTool("browser_click", { text: "horarios y tarifas" }, ctx);
    assert.match(hidden.text, /^Clicked\. The matching link was hidden/);
    assert.match(hidden.text, /Martes cerrado/);
  });
});

// A link whose click did nothing visible is only opened by hand when something covered
// it. A page that cancels or handles the click itself (a confirm, an add to cart) must
// not have its address fetched behind its back.
test("browser_click opens a link's address only when something covered the link", async (t) => {
  const hits = { remove: 0, add: 0 };
  const overlay = `<div style="position:fixed;inset:0;background:rgba(0,0,0,0.1);z-index:10">Accept cookies</div>`;
  await withBrowser(t, {
    "/covered": `<title>Covered</title>${overlay}<a href="/details">Details</a>`,
    "/details": "<title>Details</title><p>The details page.</p>",
    "/guarded": `<title>Posts</title><a href="/posts/5/delete" onclick="return false">Delete</a>
      <a href="/cart/add?id=5" onclick="document.title='Added';return false">Add to cart</a>`,
    "/covered-script": `<title>Covered script</title>${overlay}<a href="/cart/add?id=5" onclick="return false">Add to cart</a>`,
    get "/posts/5/delete"() {
      hits.remove += 1;
      return "<title>Deleted</title>";
    },
    get "/cart/add"() {
      hits.add += 1;
      return "<title>Added twice</title>";
    },
  }, async ({ base, ctx }) => {
    await callBuiltinTool("browser_open", { url: `${base}/covered` }, ctx);
    const covered = await callBuiltinTool("browser_click", { text: "Details" }, ctx);
    assert.match(covered.text, /^Clicked\. Something on top of the link took the click; opened its address instead\./);
    assert.match(covered.text, /The details page/);

    await callBuiltinTool("browser_open", { url: `${base}/guarded` }, ctx);
    const refused = await callBuiltinTool("browser_click", { text: "Delete" }, ctx);
    assert.match(refused.text, /^Clicked\.\n/);
    const added = await callBuiltinTool("browser_click", { text: "Add to cart" }, ctx);
    assert.match(added.text, /^Clicked\.\n/);
    assert.match(added.text, /Added/);

    // Covered, but the link runs its own script: say where it points, do not open it.
    await callBuiltinTool("browser_open", { url: `${base}/covered-script` }, ctx);
    const told = await callBuiltinTool("browser_click", { text: "Add to cart" }, ctx);
    assert.match(told.text, /The link points to .*\/cart\/add\?id=5; close what covers it/);
    assert.deepEqual(hits, { remove: 0, add: 0 });
  });
});
