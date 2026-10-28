import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/charts.js";

const C = globalThis.RavnirCharts;

const bar = {
  type: "bar",
  title: "Spend by agent",
  labels: ["Mon", "Tue", "Wed"],
  series: [{ name: "Opus", data: [1.2, 3.4, 2] }],
  unit: "$",
  decimals: 2,
};

test("valid bar spec normalizes", () => {
  const r = C.normalize(bar);
  assert.equal(r.ok, true);
  assert.equal(r.spec.type, "bar");
  assert.deepEqual(r.spec.series[0].data, [1.2, 3.4, 2]);
  assert.equal(r.spec.decimals, 2);
});

test("JSON string input is accepted", () => {
  const r = C.normalize(JSON.stringify(bar));
  assert.equal(r.ok, true);
  assert.equal(r.spec.title, "Spend by agent");
});

test("invalid JSON is rejected with a plain message", () => {
  const r = C.normalize("{ type: bar");
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
});

test("unknown chart type is rejected", () => {
  const r = C.normalize({ ...bar, type: "radar" });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown chart type "radar"/);
});

test("more than eight series is rejected", () => {
  const series = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, data: [1, 2, 3] }));
  const r = C.normalize({ ...bar, series });
  assert.equal(r.ok, false);
  assert.match(r.error, /at most 8 series/);
});

test("data length mismatch is rejected", () => {
  const r = C.normalize({ ...bar, series: [{ name: "Opus", data: [1, 2] }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /2 values but there are 3 labels/);
});

test("non-finite and non-numeric values are rejected", () => {
  const nan = C.normalize({ ...bar, series: [{ name: "Opus", data: [1, NaN, 2] }] });
  assert.equal(nan.ok, false);
  assert.match(nan.error, /must be a number or null/);
  const inf = C.normalize({ ...bar, series: [{ name: "Opus", data: [1, Infinity, 2] }] });
  assert.equal(inf.ok, false);
  const text = C.normalize({ ...bar, series: [{ name: "Opus", data: ["3", 1, 2] }] });
  assert.equal(text.ok, false);
});

test("negative pie value is rejected", () => {
  const r = C.normalize({ type: "pie", labels: ["a", "b"], series: [{ name: "Share", data: [3, -1] }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /zero or more/);
});

test("pie needs a positive total and at most eight slices", () => {
  const zero = C.normalize({ type: "donut", labels: ["a", "b"], series: [{ name: "Share", data: [0, null] }] });
  assert.equal(zero.ok, false);
  const many = C.normalize({
    type: "pie",
    labels: Array.from({ length: 9 }, (_, i) => `s${i}`),
    series: [{ name: "Share", data: Array(9).fill(1) }],
  });
  assert.equal(many.ok, false);
  assert.match(many.error, /at most 8 slices/);
});

test("null gaps are accepted", () => {
  const r = C.normalize({ type: "line", labels: ["a", "b", "c"], series: [{ name: "x", data: [1, null, 3] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.series[0].data, [1, null, 3]);
});

test("labels and option bounds are enforced", () => {
  assert.equal(C.normalize({ ...bar, labels: [] }).ok, false);
  const big = Array.from({ length: 201 }, (_, i) => `l${i}`);
  assert.equal(C.normalize({ type: "line", labels: big, series: [{ name: "x", data: big.map(() => 1) }] }).ok, false);
  assert.equal(C.normalize({ ...bar, decimals: 5 }).ok, false);
  assert.equal(C.normalize({ ...bar, yMin: 10, yMax: 5 }).ok, false);
});

test("stacked rejects negatives, hbar accepts ranking data", () => {
  const stacked = C.normalize({ type: "stacked", labels: ["a"], series: [{ name: "x", data: [-1] }] });
  assert.equal(stacked.ok, false);
  const hbar = C.normalize({ type: "hbar", labels: ["a", "b"], series: [{ name: "x", data: [4, 9] }] });
  assert.equal(hbar.ok, true);
});

test("format applies compact suffixes, units and decimals", () => {
  assert.equal(C.format(1234, { unit: "$" }), "$1.2k");
  assert.equal(C.format(3400000), "3.4M");
  assert.equal(C.format(1100000000), "1.1B");
  assert.equal(C.format(0.5, { unit: "%" }), "0.5%");
  assert.equal(C.format(12.5, { unit: "%", decimals: 2 }), "12.50%");
  assert.equal(C.format(1.5, { unit: "ms" }), "1.5 ms");
  assert.equal(C.format(1200, { unit: "tokens" }), "1.2k tokens");
  assert.equal(C.format(1200, { decimals: 2 }), "1.20k");
  assert.equal(C.format(-2500, { unit: "$" }), "-$2.5k");
  assert.equal(C.format(3, { unit: "$", decimals: 2 }), "$3.00");
  assert.equal(C.format(0.0039, { unit: "$" }), "$0.0039");
  assert.equal(C.format(null, { unit: "$" }), "no value");
});

test("render returns false without a DOM and for invalid specs", () => {
  assert.equal(C.render({}, bar), false);
  assert.equal(C.render({}, { type: "nope" }), false);
});

test("the chart block handler is registered on globalThis.RavnirBlocks", () => {
  assert.equal(typeof globalThis.RavnirBlocks, "object");
  assert.equal(typeof globalThis.RavnirBlocks.chart, "function");
});
