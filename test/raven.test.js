import assert from "node:assert/strict";
import test from "node:test";
import "../public/avatar.js";

const A = globalThis.RavnirAvatar;

test("the raven stays available as the fallback and chief while roles use distinct bodies", () => {
  assert.deepEqual(A.SHAPES[0], ["raven", "Raven"]);
  assert.equal(A.normalize({}, { seed: "anyone" }).shape, "raven");
  assert.equal(A.normalize({}, { seed: "anyone" }).material, "matte");
  assert.equal(A.normalize({}, { seed: "anyone" }).eyes, "dot");
  assert.equal(A.normalize({ shape: "orb" }, { seed: "x" }).shape, "orb", "objects stay available");
  for (const [name, shape, extra] of [["Chief of Staff", "raven", "crown"], ["Researcher", "orb", "glasses"], ["Engineer", "screen", "antenna"], ["Inbox", "dome", "headset"]]) {
    const look = A.suggest({ name });
    assert.equal(look.shape, shape, name);
    assert.equal(look.extra, extra, name);
    assert.ok(["surface", "visor"].includes(look.face), name);
  }
  assert.ok(A.PRESETS.some(([, look]) => look.shape === "raven"));
});

test("saved raven looks render a natural eye and plumage instead of costume props", () => {
  const dark = A.markup({ shape: "raven", color: "#2c3150", face: "surface", eyes: "dot", mouth: "grin" }, { name: "Chief" });
  assert.match(dark, /tb-rv-jaw/);
  assert.match(dark, /tb-rv-bill/);
  assert.doesNotMatch(dark, /tb-av-m-base/, "no painted mouth under the beak");
  assert.doesNotMatch(dark, /tb-av-talk/, "the beak does the talking");
  assert.match(dark, /#ffb547/i);
  assert.match(dark, /tb-rv-eye/);
  assert.match(dark, /tb-rv-head/);
  assert.match(dark, /tb-rv-feathers/);
  assert.match(dark, /tb-rv-flight-near/);
  assert.match(dark, /tb-rv-flight-far/);
  assert.doesNotMatch(dark, /tb-rv-up|tb-rv-far|tb-rv-note|tb-rv-tuck|tb-rv-taps/);
  const light = A.markup({ shape: "raven", color: "#e7c8ca", face: "surface", eyes: "dot" }, { name: "PA" });
  assert.match(light, /#ffb547/i, "even a saved pastel raven has a natural amber iris");
  const lit = A.markup({ shape: "raven", color: "#2c3150", glow: "#8be9ff" }, { name: "Chief" });
  assert.doesNotMatch(lit, /#ffb547/i, "a chosen eye light wins");
  assert.deepEqual(A.RAVEN_PLUMAGE.map(([key]) => key), A.EXTRAS.map(([key]) => key));
  for (const [extra] of A.RAVEN_PLUMAGE) {
    const html = A.markup({ shape: "raven", extra, eyes: "spark", cheeks: true }, { name: "R" });
    assert.match(html, /<svg/);
    assert.doesNotMatch(html, /tb-av-crown|tb-av-glasses|tb-av-headset|tb-av-antenna|tb-av-cheeks|tb-av-sprout|tb-av-halo-ring|animateMotion/);
  }
});

test("raven eye styles and insignia create individual looks without changing the saved schema", () => {
  assert.deepEqual(A.RAVEN_EYES.map(([key]) => key), A.EYES.map(([key]) => key));
  const eyes = new Set(A.RAVEN_EYES.map(([eyes]) => A.markup({ shape: "raven", eyes }, { name: "Raven" }).match(/<g class="tb-rv-eye">([\s\S]*?)<\/g><\/g><\/g>/)?.[1]));
  assert.equal(eyes.size, 8);
  const marked = A.markup({ shape: "raven", face: "visor", mark: "compass" }, { name: "Raven" });
  assert.match(marked, /tb-rv-eye/);
  assert.match(marked, /tb-av-mark/);
  assert.doesNotMatch(A.markup({ shape: "raven", face: "visor" }, { name: "Raven", mark: false }), /tb-av-mark/);
});
