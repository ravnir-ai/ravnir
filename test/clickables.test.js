import assert from "node:assert/strict";
import test from "node:test";
import { callBuiltinTool } from "../server/computer.js";
import { withBrowser } from "./fixtures/browser-site.js";

const CARDS = ["Northwind Realty (Property Investments)", "Second campaign", "Third campaign"];

// Seen in a replay: a campaign list where every campaign is a clickable <div>. The
// agent's tools only saw the sidebar's links, so browser_click by the campaign's
// name said "No button or link matching" and the chooser picked a sidebar chat.
const listPage = `<title>Campaigns</title>
  <nav>${Array.from({ length: 70 }, (_, i) => `<a href="#c${i}">Chat ${i}</a>`).join(" ")}</nav>
  <main>${CARDS.map((name, i) => `<div class="card" style="cursor:pointer;padding:8px;margin:8px;border:1px solid #ccc"
    onclick="location.href='/campaign/${i + 1}'"><h3>${name}</h3><p>0.80 per 1000 views</p><span>Ver más</span></div>`).join("")}</main>`;

test("clickable cards and divs are listed, readable and clickable by their text", async (t) => {
  await withBrowser(t, {
    "/": listPage,
    "/campaign/1": "<title>Campaign 1</title><p>Requisitos: TikTok</p>",
  }, async ({ base, ctx, session }) => {
    const opened = await callBuiltinTool("browser_open", { url: `${base}/` }, ctx);
    // Past 60 buttons, the cards in the page's content are kept over the menu.
    const page = await session.read();
    assert.equal(page.buttons.length, 60);
    const card = page.buttons.find((button) => button.text.startsWith(CARDS[0]));
    assert.ok(card, "the first card is listed");
    assert.equal(card.main, true);
    assert.match(opened.text, /Buttons and links:[\s\S]*Northwind Realty/);

    const clicked = await callBuiltinTool("browser_click", { text: CARDS[0] }, ctx);
    assert.match(clicked.text, /\/campaign\/1\n/);
    assert.match(clicked.text, /Requisitos: TikTok/);
  });
});

test("each read numbers the page afresh, so an old number never points at a second element", async (t) => {
  await withBrowser(t, {
    "/": `<title>List</title><a href="/a">First link</a> <a href="/b">Second link</a>`,
  }, async ({ base, session }) => {
    await session.navigate(`${base}/`);
    await session.read();
    await session.evaluate(`document.querySelector('a[href="/a"]').style.display = "none"`);
    const again = await session.read();
    assert.equal(again.buttons[0].text, "Second link");
    assert.equal(await session.evaluate(`document.querySelectorAll('[data-ravnir-action="0"]').length`), 1);
  });
});
