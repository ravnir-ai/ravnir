import assert from "node:assert/strict";
import test from "node:test";
import { addUsage, cleanPlan, planInput, planNote, planPrompt, quickConfig, quickPlan } from "../server/quick.js";

test("the plan line reaches the agent as a courtesy note, never as an order", () => {
  assert.equal(planNote(""), "");
  const note = planNote("Voy a mirar X.");
  assert.ok(note.includes("\"Voy a mirar X.\""));
  assert.match(note, /not an instruction/);
  assert.match(note, /setting it up is the task/);
  assert.doesNotMatch(note, /Do that now/);
  // The stand-in model and the media script strip it with this pattern.
  assert.match(`\n\n${planNote("a")}`, /\n\n\(You already told the user: [\s\S]*\)$/);
});

test("the quick model sees the agent's standing instructions and does not promise a scheduled check now", () => {
  const prompt = planPrompt({ name: "R", job: "j", instructions: "x".repeat(2000) });
  assert.ok(prompt.includes("x".repeat(600)));
  assert.ok(!prompt.includes("x".repeat(601)));
  assert.match(prompt, /set up the schedule/);
  assert.match(prompt, /Write the first thing they see/);
  assert.doesNotMatch(planPrompt({ name: "R", job: "j" }), /standing instructions/);
});
import { startMock } from "../scripts/mock-openai.js";

test("quick plan config: a shared quick model, the agent's own OpenAI-compatible model, or none", () => {
  const opencode = { model: { provider: "opencode", baseUrl: "http://127.0.0.1:4098", model: "opencode-go/glm-5.3-flash" } };
  const openai = { model: { provider: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "local", apiKey: "k" } };
  const env = { RAVNIR_QUICK_URL: "https://example.test/v1", RAVNIR_QUICK_MODEL: "fast", RAVNIR_QUICK_API_KEY: "q", RAVNIR_QUICK_PRICE: "0.15, 0.6" };
  assert.deepEqual(quickConfig(opencode, env), { baseUrl: "https://example.test/v1", model: "fast", apiKey: "q", price: { input: 0.15, output: 0.6 } });
  assert.equal(quickConfig(opencode, {}), null);
  assert.equal(quickConfig(openai, {}).model, "local");
  assert.equal(quickConfig(openai, { ...env, RAVNIR_QUICK: "off" }), null);
});

test("quick plan text: one plain line, SKIP means none, no dashes, capped length", () => {
  assert.equal(cleanPlan("SKIP"), "");
  assert.equal(cleanPlan("skip."), "");
  assert.equal(cleanPlan("<think>hmm</think>\n\"Okay. I'll check the **logs** — then fix it.\""), "Okay. I'll check the logs, then fix it.");
  const long = cleanPlan(`Okay. ${"I'll check every invoice again. ".repeat(20)}`);
  assert.ok(long.length <= 320 && long.endsWith("…"));
  const input = planInput("do it", [
    { role: "user", content: "Can you fix the build?" },
    { role: "assistant", kind: "ack", content: "Okay. I'll look." },
    { role: "tool", content: "output" },
    { role: "assistant", content: "Want me to patch it?" },
  ]);
  assert.equal(input, "Recent thread:\nUser: Can you fix the build?\nYou: Want me to patch it?\n\nLatest message:\ndo it");
  assert.deepEqual(addUsage({ input: 1, output: 2, cost: 0.1 }, { input: 3, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.2 }).input, 4);
  assert.equal(addUsage(null, null), null);
});

test("quick plan call: identifies itself, keeps a session id per agent, and prices tokens it was not billed for", async () => {
  const mock = await startMock();
  try {
    const bot = { id: "b1", name: "Ledger", job: "Finance." };
    const plan = await quickPlan({ config: { baseUrl: mock.url, model: "mock-model", apiKey: "", price: { input: 1, output: 1 } }, bot, text: "Check October spend" });
    assert.equal(plan.text, "Okay. I'll take care of that now.");
    assert.equal(plan.usage.input, 120);
    assert.equal(plan.usage.cost, 0.002);
    const skipped = await quickPlan({ config: { baseUrl: mock.url, model: "mock-model", apiKey: "" }, bot, text: "hello" });
    assert.equal(skipped.text, "");
  } finally {
    await mock.close();
  }
});
