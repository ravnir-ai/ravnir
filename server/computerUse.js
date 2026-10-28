import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { botHome } from "./state.js";

export const MAX_STEPS = 20;
export const DEFAULT_STEPS = 8;
const STEP_PAUSE_MS = 450;
// Jev scores at most 24 options; the keys, scrolls, DONE and STOP take 7 of them.
const MAX_OPTIONS = 24;
const FIXED_ACTIONS = 7;
const MAX_EXTRA = 40;

// The browser side of computer_task (server/drive.js runs the loop). It observes the
// page through the DOM (no OCR, no screenshots sent to a model) and offers the visible
// buttons, links, clickable cards, fields and keys as numbered actions.
export async function browserDriver({ bot, browser, home, goal = "", text = "" }) {
  const session = await browser.ensure(bot);
  const outputDir = path.join(botHome(home, bot), "computer");
  await fs.mkdir(outputDir, { recursive: true });
  await prune(outputDir);
  return {
    kind: "browser",
    label: "Computer",
    hint: "Use browser_read and browser_click with the exact text, or another approach.",
    async observe(step, context = {}) {
      const page = await session.read();
      const found = await survey(session, page);
      const frame = await capture(session, outputDir, step);
      // A ticked box keeps its value ("on"), so its checked state and a dropdown's
      // selected option count too.
      const values = (page.fields || []).map((field) => `${field.value ?? ""}|${field.checked ?? ""}|${field.selected ?? ""}`).join("\u0001");
      return {
        page,
        url: page.url,
        title: page.title,
        shot: frame.url,
        where: `${page.title || "(untitled)"} at ${page.url}`,
        summary: short(page.text, 1500),
        state: { url: page.url, title: page.title, page: String(page.text || "").slice(0, 4000), step: step + 1 },
        // Scrolling an inner panel or typing into a field changes neither the text nor the actions.
        fingerprint: `${found.scroll}|${values}|${crypto.createHash("sha1").update(String(page.text || "")).digest("hex")}`,
        actions: buildActions({ ...page, buttons: found.clickables }, text, context.goal || goal),
        empty: "There is nothing left to click or type on this page.",
      };
    },
    async perform(action) {
      await execute(session, action);
      await session.pause(STEP_PAUSE_MS);
    },
    async after(step, before, action) {
      const page = await session.read().catch(() => before.page);
      const frame = await capture(session, outputDir, step, "after");
      const note = /^https?:\/\//i.test(action.href || "") && page.url !== before.url ? `Computer opened ${page.url}` : "";
      return { url: page.url, title: page.title, shot: frame.url, note };
    },
  };
}

// The clickable things on the page: the reader's buttons and links, plus cards and divs
// that only a click handler, a role or a pointer cursor marks as clickable. When there
// are more than fit, the ones that match the goal come first, then the ones on screen
// and outside navigation (rank), then page order.
export function buildActions(page, text, goal = "") {
  const fields = [];
  if (text) {
    for (const field of (page.fields || []).slice(0, 4)) {
      const name = field.label || field.placeholder || field.name || field.tag || "field";
      fields.push({
        kind: "fill",
        selector: field.selector,
        text,
        label: `Type "${short(text, 80)}" into ${short(name, 60)}`,
      });
    }
  }
  const slots = MAX_OPTIONS - FIXED_ACTIONS - fields.length;
  let clickables = (page.buttons || []).filter((button) => button.text || button.href);
  if (clickables.length > slots) {
    const words = goalWords(goal);
    const hits = (button) => {
      const haystack = plain(`${button.text || ""} ${button.context || ""} ${button.href || ""}`);
      return words.filter((word) => haystack.includes(word)).length;
    };
    clickables = clickables
      .map((button, order) => ({ button, order, hits: hits(button), rank: Number(button.rank) || 0 }))
      .sort((a, b) => b.hits - a.hits || b.rank - a.rank || a.order - b.order)
      .slice(0, slots)
      .map((row) => row.button);
  }
  const actions = clickables.map((button) => ({
    kind: "click",
    selector: button.selector,
    href: button.href,
    label: `Click "${short(button.text || button.href)}"${button.context ? ` in "${short(button.context, 60)}"` : ""}${button.href ? ` (${short(button.href, 80)})` : ""}`,
  }));
  actions.push(
    ...fields,
    { kind: "key", key: "Enter", label: "Press Enter" },
    { kind: "key", key: "Tab", label: "Press Tab" },
    { kind: "key", key: "Escape", label: "Press Escape" },
    { kind: "scroll", dy: 800, label: "Scroll down" },
    { kind: "scroll", dy: -800, label: "Scroll up" },
    { kind: "done", label: "DONE: the goal is already complete" },
    { kind: "stop", label: "STOP: I cannot make progress from this page" },
  );
  return actions;
}

// Common words that say nothing about which button to press.
const FILLER = new Set(["abrir", "click", "como", "desde", "esta", "este", "from", "have", "into", "luego", "open", "page", "para", "pulsa", "that", "then", "there", "this", "with", "your"]);

function goalWords(goal) {
  return [...new Set(plain(goal).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !FILLER.has(word)))];
}

function plain(value) {
  return String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// One pass over the page after the reader numbered its buttons: finds the clickable
// cards it missed (tagged data-ravnir-click), says where each clickable sits (on screen,
// inside navigation, page order), names the card a repeated "See more" belongs to, and
// notes the scroll positions so a scroll that moved something counts as progress.
async function survey(session, page) {
  const buttons = page.buttons || [];
  let found = null;
  try {
    found = await session.evaluate(`(${surveyPage.toString()})(${buttons.length}, ${MAX_EXTRA})`);
  } catch {
    found = null;
  }
  if (!found) return { clickables: buttons, scroll: "" };
  const known = buttons.map((button) => ({ ...button, ...(found.known[button.i] || {}) }));
  const clickables = [...known, ...found.extra].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
  return { clickables, scroll: found.scroll };
}

// Runs inside the page, so it must not use anything from this module.
function surveyPage(count, maxExtra) {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
  };
  const words = (el) => String(el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const place = (el) => {
    const rect = el.getBoundingClientRect();
    const inView = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    const main = !el.closest("nav,aside,header,footer,[role=navigation],[role=banner],[role=complementary],[role=contentinfo]");
    return { inView, main, rank: (inView ? 2 : 0) + (main ? 1 : 0) };
  };
  for (const el of document.querySelectorAll("[data-ravnir-click]")) el.removeAttribute("data-ravnir-click");

  // What the reader numbered on this read. The first element with a number is the one a click on it hits.
  const known = new Map();
  for (const el of document.querySelectorAll("[data-ravnir-action]")) {
    const index = Number(el.getAttribute("data-ravnir-action"));
    if (Number.isInteger(index) && index < count && !known.has(index)) known.set(index, el);
  }
  const knownEls = [...known.values()];
  const overlaps = (el, list) => list.some((other) => other === el || other.contains(el) || el.contains(other));
  const buttonish = "button,a,[role=button],[role=link],summary,label";
  const fits = (el) => {
    const text = words(el);
    return text.length >= 1 && text.length <= 300 && visible(el);
  };

  // Elements a click handler, a role or a tab stop marks as clickable, then the outermost
  // element under a pointer cursor (a card), when the reader has neither.
  const picked = [];
  const explicit = "[role=link],[role=tab],[role=menuitem],[role=option],summary,[onclick],[tabindex]:not([tabindex='-1'])";
  for (const el of document.querySelectorAll(explicit)) {
    if (!fits(el) || overlaps(el, knownEls)) continue;
    if (el.parentElement?.closest(buttonish)) continue;
    picked.push(el);
  }
  const all = document.body ? [...document.body.querySelectorAll("*")].slice(0, 5000) : [];
  for (const el of all) {
    if (getComputedStyle(el).cursor !== "pointer") continue;
    if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue;
    if (el.closest(buttonish) || !fits(el)) continue;
    if (overlaps(el, knownEls) || overlaps(el, picked)) continue;
    picked.push(el);
  }
  // A clickable inside another one is the same target.
  let extra = picked.filter((el) => !picked.some((other) => other !== el && other.contains(el)));
  if (extra.length > maxExtra) {
    const first = new Map(extra.map((el, index) => [el, index]));
    extra = extra
      .map((el) => ({ el, rank: place(el).rank }))
      .sort((a, b) => b.rank - a.rank || first.get(a.el) - first.get(b.el))
      .slice(0, maxExtra)
      .map((row) => row.el);
  }

  // Page order for both lists, so the merged list reads top to bottom.
  const everyone = [...knownEls, ...extra].sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const order = new Map(everyone.map((el, index) => [el, index]));

  // A link whose text repeats on the page ("See more" on every card) is named by its card.
  const seen = new Map();
  for (const el of everyone) seen.set(words(el).toLowerCase(), (seen.get(words(el).toLowerCase()) || 0) + 1);
  const context = (el) => {
    const own = words(el);
    if ((seen.get(own.toLowerCase()) || 0) < 2) return "";
    for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 6; node = node.parentElement, depth += 1) {
      const text = words(node);
      if (text.length <= own.length) continue;
      if (text.length > 300) return "";
      const heading = node.querySelector("h1,h2,h3,h4,h5,h6,strong,b");
      return (heading ? words(heading) : text.replace(own, "").trim()).slice(0, 100);
    }
    return "";
  };

  const knownOut = {};
  for (const [index, el] of known) knownOut[index] = { ...place(el), order: order.get(el), context: context(el) };
  const extraOut = extra.map((el, index) => {
    el.setAttribute("data-ravnir-click", String(index));
    return {
      selector: `[data-ravnir-click="${index}"]`,
      tag: el.tagName.toLowerCase(),
      text: words(el).slice(0, 300),
      href: "",
      ...place(el),
      order: order.get(el),
      context: context(el),
    };
  });

  // Scroll positions of the page and of every panel that scrolls on its own.
  const panels = [];
  for (const el of all) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) panels.push(Math.round(el.scrollTop));
    if (panels.length >= 20) break;
  }
  return { known: knownOut, extra: extraOut, scroll: [Math.round(scrollX), Math.round(scrollY), ...panels].join(",") };
}

async function execute(session, action) {
  if (action.kind === "click") {
    await session.clickSelector(action.selector);
    return;
  }
  if (action.kind === "fill") {
    await session.typeSelector(action.selector, action.text);
    return;
  }
  if (action.kind === "key") {
    await session.key(action.key);
    return;
  }
  if (action.kind === "scroll") await scroll(session, Number(action.dy) || 0);
}

// Many apps keep the page still and scroll an inner panel, where window.scrollBy does
// nothing. Pick what can move (the page, else the largest panel that scrolls), turn the
// mouse wheel over it like a person would, and scroll it directly if the wheel did not.
export async function scroll(session, dy) {
  const target = await session.evaluate(`(${scrollTarget.toString()})(${Number(dy) || 0})`);
  if (!target) return;
  const mouse = session.page?.mouse;
  if (mouse) {
    await mouse.move(target.x, target.y);
    await mouse.wheel(0, dy);
    await session.pause(300);
  }
  await session.evaluate(`(${scrollRest.toString()})(${Number(dy) || 0}, ${target.before})`);
}

// Runs inside the page: marks what to scroll and says where to put the mouse.
function scrollTarget(dy) {
  for (const el of document.querySelectorAll("[data-ravnir-scroll]")) el.removeAttribute("data-ravnir-scroll");
  const canMove = (top, height, size) => (dy > 0 ? top + height < size - 1 : top > 0);
  const locked = (el) => Boolean(el) && /hidden|clip/.test(getComputedStyle(el).overflowY);
  const root = document.scrollingElement || document.documentElement;
  if (!locked(document.documentElement) && !locked(document.body) && canMove(scrollY, innerHeight, root.scrollHeight)) {
    return { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2), before: Math.round(scrollY) };
  }
  let best = null;
  let bestArea = 0;
  for (const el of document.body ? [...document.body.querySelectorAll("*")].slice(0, 5000) : []) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (!/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) continue;
    if (!canMove(el.scrollTop, el.clientHeight, el.scrollHeight)) continue;
    const rect = el.getBoundingClientRect();
    const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
    if (width <= 0 || height <= 0 || width * height <= bestArea) continue;
    best = el;
    bestArea = width * height;
  }
  if (!best) return null;
  best.setAttribute("data-ravnir-scroll", "1");
  const rect = best.getBoundingClientRect();
  const x = (Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2;
  const y = (Math.max(rect.top, 0) + Math.min(rect.bottom, innerHeight)) / 2;
  return { x: Math.round(x), y: Math.round(y), before: Math.round(best.scrollTop) };
}

// Runs inside the page: scrolls the marked panel (or the page) when the wheel left it where it was.
function scrollRest(dy, before) {
  const el = document.querySelector("[data-ravnir-scroll]");
  if (el) {
    if (Math.round(el.scrollTop) === before) el.scrollBy(0, dy);
    el.removeAttribute("data-ravnir-scroll");
    return;
  }
  if (Math.round(scrollY) === before) scrollBy(0, dy);
}

async function capture(session, dir, step, phase = "before") {
  const png = await session.screenshot({ force: true });
  const name = `step-${String(step + 1).padStart(2, "0")}-${phase}-${crypto.randomBytes(4).toString("hex")}.png`;
  await fs.writeFile(path.join(dir, name), png);
  return { name, url: `/api/bots/${session.bot.id}/computer/${name}` };
}

async function prune(dir, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".png")) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) await fs.unlink(file);
    } catch {
      // Best effort.
    }
  }
}

function short(value, limit = 100) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
