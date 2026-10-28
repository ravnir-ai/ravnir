import test from "node:test";
import assert from "node:assert/strict";
import "../public/choices.js";
import { buildSystemPrompt } from "../server/prompts.js";

const { normalize, chosen, answerFor, SpecError } = globalThis.RavnirChoices;

test("choice spec: strings and objects, multiple and other", () => {
  const spec = normalize('{"question":"Which cuisines?","options":["Spanish",{"label":"Japanese","detail":"Sushi, ramen"}],"multiple":true,"other":true}');
  assert.equal(spec.question, "Which cuisines?");
  assert.deepEqual(spec.options, [{ label: "Spanish", detail: "" }, { label: "Japanese", detail: "Sushi, ramen" }]);
  assert.equal(spec.multiple, true);
  assert.equal(spec.other, true);
  assert.equal(normalize({ question: "Q", options: ["a", "b"] }).multiple, false);
});

test("choice spec: bad blocks are refused so they show as code", () => {
  for (const bad of ["not json", "[]", '{"options":["a","b"]}', '{"question":"Q","options":["a"]}', '{"question":"Q","options":["a","A"]}',
    JSON.stringify({ question: "Q", options: Array.from({ length: 13 }, (_, i) => `o${i}`) })]) {
    assert.throws(() => normalize(bad), SpecError, bad);
  }
});

test("choice answers: one label, several labels, free text", () => {
  const { options } = normalize({ question: "Q", options: ["Spanish", "Japanese", "Italian", "Salt, pepper"] });
  assert.deepEqual([...chosen("japanese", options)], ["Japanese"]);
  assert.deepEqual([...chosen("Spanish, Italian", options)], ["Spanish", "Italian"]);
  assert.deepEqual([...chosen("Salt, pepper", options)], ["Salt, pepper"]);
  assert.equal(chosen("none of these", options).size, 0);
  assert.equal(answerFor(new Set(["Italian", "Spanish"]), options), "Spanish, Italian");
});

test("the prompt tells agents about choice blocks", () => {
  const prompt = buildSystemPrompt({ id: "x", name: "Nova", job: "Helper", instructions: "" }, {});
  assert.match(prompt, /language choice/);
});
