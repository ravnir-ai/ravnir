import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

async function pageFor(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent('<style>.avatar { display:block; width:96px; height:96px; }</style><span id="bird" class="avatar"></span><span id="object" class="avatar"></span>');
  await page.addScriptTag({ path: new URL("../public/avatar.js", import.meta.url).pathname });
  await page.evaluate(() => {
    RavnirAvatar.render(document.getElementById("bird"), { shape: "raven", extra: "crown", color: "#f0b43c" }, { name: "Chief" });
    RavnirAvatar.render(document.getElementById("object"), { shape: "orb", extra: "crown" }, { name: "Object" });
  });
  return page;
}

test("raven statuses stay legible with motion off", async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const bird = document.getElementById("bird");
    RavnirAvatar.setMotion("off");
    return ["working", "waiting", "happy", "sleeping", "speaking"].map((mood) => {
      RavnirAvatar.setState(bird, mood);
      return {
        mood,
        status: getComputedStyle(bird.querySelector(".tb-av-bubble")).display,
        color: getComputedStyle(bird.querySelector(".tb-av-bubble")).backgroundColor,
        animationCount: bird.getAnimations({ subtree: true }).length,
        eye: getComputedStyle(bird.querySelector(".tb-rv-eye .tb-av-open")).display,
      };
    });
  });
  assert.ok(result.every((entry) => entry.status !== "none"));
  assert.equal(new Set(result.map((entry) => entry.color)).size, 5, "each state has a distinct indicator");
  assert.ok(result.every((entry) => entry.animationCount === 0));
  assert.equal(result.find((entry) => entry.mood === "sleeping").eye, "none");
  assert.notEqual(result.find((entry) => entry.mood === "happy").eye, "none", "done birds keep a natural eye");
  const offJaw = await page.locator("#bird").evaluate((node) => {
    const transforms = [];
    for (const level of [0, 1, 0]) {
      RavnirAvatar.speak(node, level);
      transforms.push(getComputedStyle(node.querySelector(".tb-rv-jaw")).transform);
    }
    return transforms;
  });
  assert.equal(new Set(offJaw).size, 1, "motion off also keeps the speaking beak still");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    RavnirAvatar.setMotion("full");
    RavnirAvatar.setState(document.getElementById("bird"), "working");
  });
  assert.equal(await page.locator("#bird").evaluate((node) => node.getAnimations({ subtree: true }).length), 0);
  assert.equal(await page.locator("#bird").evaluate((node) => {
    node.classList.add("is-blink");
    return getComputedStyle(node.querySelector(".tb-av-blink")).animationName;
  }), "none", "a randomly scheduled blink must also honor reduced motion");
});

test("curious and cheerful ravens keep the whole body still when they notice the pointer", async (t) => {
  const page = await pageFor(t);
  const poses = await page.locator("#bird").evaluate((node) => ["curious", "cheerful"].map((personality) => {
    RavnirAvatar.render(node, { shape: "raven", personality }, { name: "Chief" });
    node.style.setProperty("--av-x", "1");
    node.classList.add("is-notice");
    const pose = getComputedStyle(node.querySelector(".tb-av-hop"));
    return { rotation: pose.rotate, animation: pose.animationName };
  }));
  for (const pose of poses) {
    assert.ok(pose.rotation === "none" || pose.rotation === "0deg");
    assert.equal(pose.animation, "none");
  }
});

test("reduced motion suppresses raven blinks even when a blink is scheduled", async (t) => {
  const page = await pageFor(t);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#bird").evaluate((node) => {
    node.classList.add("is-blink");
    return getComputedStyle(node.querySelector(".tb-av-blink")).animationName;
  }), "none");
});

test("pausing a raven overrides completion reactions, including reactions received while paused", async (t) => {
  const page = await pageFor(t);
  const moods = await page.locator("#bird").evaluate((node) => {
    node.dataset.bot = "chief";
    RavnirAvatar.react("chief", "happy");
    RavnirAvatar.setState(node, "sleeping");
    const before = node.dataset.x;
    RavnirAvatar.react("chief", "happy");
    return [before, node.dataset.x];
  });
  assert.deepEqual(moods, ["sleeping", "sleeping"]);
  assert.equal(await page.locator("#bird .tb-av-open").evaluate((node) => getComputedStyle(node).display), "none");
});

test("ravens acknowledge taps without squashing or hearts while object reactions remain", async (t) => {
  const page = await pageFor(t);
  await page.locator("#bird").dispatchEvent("pointerdown", { button: 0 });
  assert.equal(await page.locator("#bird.is-squish, #bird .tb-av-heart").count(), 0);
  await page.locator("#object").dispatchEvent("pointerdown", { button: 0 });
  assert.equal(await page.locator("#object .tb-av-heart").count(), 1);
  assert.equal(await page.locator("#bird .tb-av-crown").count(), 0);
  assert.equal(await page.locator("#object .tb-av-crown").count(), 1);
});

test("full motion spreads wings on hover, flies while working and acknowledges taps without interrupting flight", async (t) => {
  const page = await pageFor(t);
  assert.equal(await page.locator("#bird .tb-rv-flight-near").count(), 1);
  await page.locator("#bird").hover();
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("#bird .tb-rv-flight-near")).opacity) > .8);
  await page.mouse.move(350, 500);
  await page.evaluate(() => RavnirAvatar.setState(document.getElementById("bird"), "working"));
  await page.locator("#bird").dispatchEvent("pointerdown", { button: 0 });
  const flying = await page.locator("#bird").evaluate((node) => ({
    mood: node.dataset.mood,
    tap: node.classList.contains("is-raven-tap"),
    feet: getComputedStyle(node.querySelector(".tb-rv-feet")).opacity,
    animations: node.getAnimations({ subtree: true }).map((animation) => animation.animationName),
  }));
  assert.equal(flying.mood, "working");
  assert.equal(flying.tap, true);
  assert.equal(flying.feet, "0");
  for (const name of ["tb-rv-flight", "tb-rv-wing-near", "tb-rv-ack"]) assert.ok(flying.animations.includes(name), name);
  await page.evaluate(() => RavnirAvatar.setState(document.getElementById("bird"), "happy"));
  const landing = await page.locator("#bird").evaluate((node) => node.getAnimations({ subtree: true }).map((animation) => animation.animationName));
  assert.ok(landing.includes("tb-rv-return"));
  assert.ok(!landing.includes("tb-rv-flight"));
});

test("subtle, off and reduced motion suppress flight and hover animation, and paused birds stay asleep", async (t) => {
  const page = await pageFor(t);
  assert.equal(await page.locator("#bird .tb-rv-flight-near").count(), 1);
  for (const motion of ["subtle", "off"]) {
    await page.evaluate((level) => {
      RavnirAvatar.setMotion(level);
      RavnirAvatar.setState(document.getElementById("bird"), "working");
    }, motion);
    await page.locator("#bird").hover();
    assert.equal(await page.locator("#bird").evaluate((node) => node.getAnimations({ subtree: true }).length), 0, motion);
    assert.equal(await page.locator("#bird .tb-rv-flight-near").evaluate((node) => getComputedStyle(node).opacity), "1", "working still has a flight pose");
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => RavnirAvatar.setMotion("full"));
  await page.locator("#bird").dispatchEvent("pointerdown", { button: 0 });
  assert.equal(await page.locator("#bird").evaluate((node) => node.getAnimations({ subtree: true }).length), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => RavnirAvatar.setState(document.getElementById("bird"), "sleeping"));
  await page.locator("#bird").hover();
  await page.locator("#bird").dispatchEvent("pointerdown", { button: 0 });
  assert.equal(await page.locator("#bird").getAttribute("data-x"), "sleeping");
  assert.equal(await page.locator("#bird.is-raven-tap").count(), 0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#bird .tb-rv-flight-near")).opacity === "0");
  assert.equal(await page.locator("#bird .tb-rv-flight-near").evaluate((node) => getComputedStyle(node).opacity), "0");
});

test("the studio saves distinct eyes together with a personal insignia", async (t) => {
  const page = await pageFor(t);
  await page.addStyleTag({ path: new URL("../public/app.css", import.meta.url).pathname });
  await page.addScriptTag({ path: new URL("../public/studio.js", import.meta.url).pathname });
  await page.evaluate(() => RavnirStudio.open({ look: { shape: "raven" }, name: "Chief", seed: "chief", onDone: (look) => { window.savedLook = look; } }));
  await page.getByRole("tab", { name: "Face", exact: true }).click();
  await page.getByRole("button", { name: "Narrow", exact: true }).click({ timeout: 2000 });
  await page.getByRole("button", { name: "Compass", exact: true }).click();
  assert.equal(await page.locator(".tbs-hero .tb-rv-eye").count(), 1);
  assert.equal(await page.locator(".tbs-hero .tb-av-mark").count(), 1);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const saved = await page.evaluate(() => window.savedLook);
  assert.equal(saved.eyes, "line");
  assert.equal(saved.mark, "compass");
  assert.equal(saved.face, "visor");
  await page.evaluate(() => RavnirStudio.open({ look: window.savedLook, name: "Chief", seed: "chief", onDone: (look) => { window.savedLook = look; } }));
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("button", { name: "Raven", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal((await page.evaluate(() => window.savedLook)).face, "visor", "reselecting Raven preserves the marked appearance");
});

test("the phone studio describes raven plumage and keeps object accessories available", async (t) => {
  const page = await pageFor(t);
  await page.addStyleTag({ path: new URL("../public/app.css", import.meta.url).pathname });
  await page.addScriptTag({ path: new URL("../public/studio.js", import.meta.url).pathname });
  await page.evaluate(() => RavnirStudio.open({ look: { shape: "raven", extra: "crown" }, name: "Chief", seed: "chief" }));
  await page.getByRole("tab", { name: "Plumage", exact: true }).click();
  await page.getByRole("button", { name: "Swept", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Swept", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".tbs-hero .tb-av-crown").count(), 0);
  const bounds = await page.locator(".tbs-dialog").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.getByRole("tab", { name: "Face", exact: true }).click();
  assert.equal(await page.getByText("Eye spacing", { exact: true }).count(), 0, "a profile has one visible eye");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("button", { name: "Orb", exact: true }).click();
  await page.getByRole("tab", { name: "Extras", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Crown", exact: true }).count(), 1);
});
