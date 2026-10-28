import test from "node:test";
import assert from "node:assert/strict";
import "../public/avatar.js";

const A = globalThis.RavnirAvatar;

test("painted faces get a talking mouth, with or without a resting mouth", () => {
  const smiling = A.markup({ shape: "dome", face: "surface", eyes: "dot", mouth: "smile" }, { seed: "Sage" });
  const plain = A.markup({ shape: "cube", face: "surface", eyes: "dot", mouth: "none" }, { seed: "Ledger" });
  for (const html of [smiling, plain]) {
    assert.match(html, /class="tb-av-m-talk"/);
    assert.match(html, /class="tb-av-talk"/);
  }
});

test("a visor without a mouth talks with its eyes, not a painted mouth", () => {
  const visor = A.markup({ shape: "gem", face: "visor", eyes: "pill", mouth: "none" }, { seed: "Nova" });
  assert.doesNotMatch(visor, /tb-av-m-talk/);
  assert.match(visor, /class="tb-av-open"/);
});

test("speaking is a mood and speak() is part of the API", () => {
  assert.equal(typeof A.speak, "function");
  // No DOM on the server: speak() and setState() must not throw.
  assert.doesNotThrow(() => A.speak(null, 0.5));
  assert.doesNotThrow(() => A.setState(null, "speaking"));
});
