import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { modelLogo, providerLogo } from "../server/providerLogos.js";
import { publicBotSummary } from "../server/state.js";

const index = JSON.parse(fs.readFileSync(new URL("../public/plugins/providers/index.json", import.meta.url), "utf8"));

test("provider logos come only from the downloaded index", () => {
  assert.ok(index.includes("openai"));
  assert.equal(providerLogo("openai"), "/plugins/providers/openai.svg");
  assert.equal(providerLogo("no-such-provider"), "");
  assert.equal(providerLogo("../../server/index"), "");
  for (const id of index) {
    assert.match(id, /^[a-z0-9][a-z0-9._-]*$/);
    const svg = fs.readFileSync(new URL(`../public/plugins/providers/${id}.svg`, import.meta.url), "utf8");
    assert.match(svg, /^<svg[\s>]/);
    assert.doesNotMatch(svg, /<script|<foreignObject|javascript:|\son[a-z]+\s*=|<image|href\s*=\s*["'](?!#)/i);
  }
});

test("an agent's model carries its provider logo", () => {
  assert.equal(modelLogo({ provider: "opencode", model: "openai/gpt-6-astra" }), "/plugins/providers/openai.svg");
  assert.equal(modelLogo({ provider: "openai", model: "openai/gpt-6-astra" }), "");
  assert.equal(modelLogo({ provider: "opencode", model: "plain-model" }), "");
  const summary = publicBotSummary({ id: "a", name: "A", model: { provider: "opencode", model: "xai/grok-5", baseUrl: "http://127.0.0.1:4096" }, stats: {}, jobs: [] });
  assert.equal(summary.model.logo, "/plugins/providers/xai.svg");
});
