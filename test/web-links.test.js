import assert from "node:assert/strict";
import test from "node:test";
import { extractLinks, isThin, renderResponse, topActions } from "../server/web.js";

// Agents copied prices from a listing but could only link the listing, and guessed a
// museum's hours address (it 404'd) because page reads dropped every link.
test("a page read lists its links with their addresses, content links first", () => {
  const body = `<html><head><title>Planes hoy en Madrid</title></head><body>
    <nav><a href="/es/madrid">Madrid</a> <a href="/es/barcelona">Barcelona</a></nav>
    <main>
      <h1>Qué hacer hoy</h1>
      <a href="/m/274138">Museo Banksy Madrid <span>Desde 14,00&nbsp;€</span></a>
      <a href="#top">Top</a>
      <a href="mailto:a@b.c">mail us</a>
      <a href="javascript:void(0)">nothing here</a>
      <a href="https://feverup.com/es/madrid/when/today#filters">Filters</a>
      <a href="/m/274138">Museo Banksy Madrid again</a>
    </main>
  </body></html>`;
  const page = renderResponse({ status: 200, contentType: "text/html", url: "https://feverup.com/es/madrid/when/today", body });
  assert.match(page.text, /Links on this page:\n- Museo Banksy Madrid Desde 14,00 €: https:\/\/feverup\.com\/m\/274138\n- Madrid: https:\/\/feverup\.com\/es\/madrid\n- Barcelona/);
  assert.doesNotMatch(page.text.split("Links on this page:")[1], /#top|mailto|javascript|Filters|again/);
  assert.equal(page.blocked, false);

  const museum = `<header><a href="/">Inicio</a></header><main><p>Visita</p><a class="btn" href="/visita/horarios-tarifas">Ver horarios
    y tarifas</a></main>`;
  assert.deepEqual(extractLinks(museum, "https://www.museoreinasofia.es/")[0], { text: "Ver horarios y tarifas", url: "https://www.museoreinasofia.es/visita/horarios-tarifas" });
  assert.equal(extractLinks(museum, "https://www.museoreinasofia.es/", 1).length, 1);

  // A block page and JSON stay as they were.
  const blocked = renderResponse({ status: 403, contentType: "text/html", url: "https://x.example/", body: `<title>Access denied</title><a href="/help">Get help here</a>` });
  assert.doesNotMatch(blocked.text, /Links on this page/);
  const json = renderResponse({ status: 200, contentType: "application/json", url: "https://x.example/a", body: `{"a":1}` });
  assert.equal(json.text, `{\n  "a": 1\n}`);
});

test("a page that is little more than its title counts as thin, links or not", () => {
  assert.equal(isThin({ status: 200, title: "BambooHR", text: "BambooHR" }), true);
  assert.equal(isThin({ status: 200, title: "x", text: "a".repeat(300) }), false);
  assert.equal(isThin({ status: 404, title: "Not found", text: "Not found" }), false);
  assert.equal(isThin({ status: 200, title: "", text: "{}", json: true }), false);
  const shell = renderResponse({
    status: 200,
    contentType: "text/html",
    url: "https://jobs.example/careers/177",
    body: `<title>Careers</title><div id="app"></div><footer><a href="/privacy">Privacy policy</a> <a href="/terms">Terms of use</a></footer>`,
  });
  assert.match(shell.text, /Links on this page/);
  assert.equal(isThin(shell), true);
});

test("past the limit, buttons in view and in the content are listed before the site's menus", () => {
  const buttons = [
    ...Array.from({ length: 5 }, (_, i) => ({ i, text: `Menu ${i}`, rank: 2 })),
    { i: 5, text: "Campaign card", rank: 3 },
    { i: 6, text: "Footer", rank: 0 },
  ];
  assert.deepEqual(topActions(buttons, 3).map((button) => button.i), [0, 1, 5]);
  assert.equal(topActions(buttons, 10).length, 7);
});
