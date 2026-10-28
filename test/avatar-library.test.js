import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import "../public/avatar.js";

const A = globalThis.RavnirAvatar;

test("job suggestions span the existing library and the first presets expose every body", () => {
  const roles = [
    ["Chief of Staff", "raven"], ["Engineer", "screen"], ["Head of Finance", "cube"],
    ["Researcher", "orb"], ["Growth Coach", "capsule"], ["Inbox", "dome"],
    ["Auditor", "gem"], ["PA", "egg"], ["Job Hunter", "ring"], ["Genius Bot", "can"],
  ];
  for (const [name, shape] of roles) {
    const look = A.suggest({ name, seed: "stable" });
    assert.equal(look.shape, shape, name);
    assert.deepEqual(A.suggest({ name, seed: "stable" }), look);
    assert.equal(A.normalize(look).color, look.color);
  }
  assert.deepEqual(new Set(A.PRESETS.slice(0, 10).map(([, look]) => look.shape)), new Set(A.SHAPES.map(([key]) => key)));
});

test("changing motion refreshes SVG orbit without losing the current mood or identity", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<style>.avatar{display:block;width:96px;height:96px}</style><span class="avatar" id="agent"></span>');
  await page.addScriptTag({ path: new URL("../public/avatar.js", import.meta.url).pathname });
  await page.evaluate(() => {
    RavnirAvatar.render(document.getElementById("agent"), { shape: "orb", color: "#ad724c", extra: "orbit", face: "surface" }, { name: "Orbit", bot: "orbit" });
    RavnirAvatar.setState(document.getElementById("agent"), "waiting");
  });
  assert.equal(await page.locator("#agent animateMotion").count(), 2);
  await page.evaluate(() => RavnirAvatar.setMotion("off"));
  assert.equal(await page.locator("#agent animateMotion").count(), 0);
  assert.equal(await page.locator("#agent").getAttribute("data-mood"), "waiting");
  assert.equal(await page.locator("#agent").getAttribute("data-bot"), "orbit");
  assert.equal(await page.locator("#agent").getAttribute("aria-label"), "Orbit avatar");
  await page.evaluate(() => RavnirAvatar.setMotion("full"));
  assert.equal(await page.locator("#agent animateMotion").count(), 2);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => !document.querySelector("#agent animateMotion"));
  assert.equal(await page.locator("#agent").getAttribute("data-mood"), "waiting");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => document.querySelectorAll("#agent animateMotion").length === 2);
});

test("motion off and reduced motion keep every speaking object still, including its body and glow", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="agents"></div>');
  await page.addScriptTag({ path: new URL("../public/avatar.js", import.meta.url).pathname });
  await page.evaluate(() => {
    for (const [shape] of RavnirAvatar.SHAPES.filter(([key]) => key !== "raven")) {
      const node = document.createElement("span");
      node.style.cssText = "display:block;width:96px;height:96px";
      document.getElementById("agents").append(node);
      RavnirAvatar.render(node, { shape, face: "surface", mouth: "none" }, { name: shape, state: "speaking" });
    }
    RavnirAvatar.setMotion("off");
  });
  const faceTransforms = () => page.locator(".tb-avatar").evaluateAll((nodes) => nodes.map((node) => {
    const face = node.querySelector(".tb-av-talk") || node.querySelector(".tb-av-open");
    RavnirAvatar.speak(node, 0);
    const appearance = () => JSON.stringify([
      getComputedStyle(face).transform,
      getComputedStyle(node.querySelector(".tb-av-hop")).transform,
      getComputedStyle(node.querySelector(".tb-av-glow")).opacity,
    ]);
    const before = appearance();
    RavnirAvatar.speak(node, 1);
    return [before, appearance()];
  }));
  for (const [before, after] of await faceTransforms()) assert.equal(before, after);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => RavnirAvatar.setMotion("full"));
  for (const [before, after] of await faceTransforms()) assert.equal(before, after);
});

test("reduced motion stops every object status, accessory and animated status symbol", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.setContent('<div id="agents"></div>');
  await page.addScriptTag({ path: new URL("../public/avatar.js", import.meta.url).pathname });
  await page.evaluate(() => {
    const A = RavnirAvatar;
    const shapes = A.SHAPES.filter(([key]) => key !== "raven");
    let index = 0;
    for (const state of ["working", "waiting", "happy", "sleeping", "speaking"]) {
      for (const [extra] of A.EXTRAS) {
        const node = document.createElement("span");
        node.style.cssText = "display:inline-block;width:48px;height:48px";
        document.getElementById("agents").append(node);
        const shape = shapes[index++ % shapes.length][0];
        A.render(node, { shape, extra, face: "surface" }, { name: `${shape} ${extra} ${state}`, state });
      }
    }
  });
  const moving = () => page.locator(".tb-avatar").evaluateAll((nodes) => nodes.flatMap((node) => node.getAnimations({ subtree: true }).map((animation) => `${node.getAttribute("aria-label")}: ${animation.animationName}`)));
  assert.deepEqual(await moving(), []);
  assert.equal(await page.locator("animateMotion").count(), 0);
  await page.evaluate(() => RavnirAvatar.setMotion("off"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.deepEqual(await moving(), []);
});
