import test from "node:test";
import assert from "node:assert/strict";
import { citedSources } from "../server/vault/context.js";

const SOURCES = [
  { path: "Rules.md", date: "2026-10-20", hash: "r1" },
  { path: "Agents/Scout.md", date: "2026-10-21", hash: "a1" },
  { path: "Projects/Launch.md", date: "2026-10-24", hash: "p1" },
  { path: "Projects/Pricing.md", date: "2026-10-22", hash: "p2" },
];

test("a reply that names a note by path gets that note, with its date and version", () => {
  const cited = citedSources(SOURCES, "Launch is Friday (Projects/Launch.md, 24 Oct).");
  assert.deepEqual(cited, [{ path: "Projects/Launch.md", date: "2026-10-24", hash: "p1" }]);
});

test("file names and wiki links count, notes that were only loaded do not", () => {
  assert.deepEqual(citedSources(SOURCES, "See launch.md for the date.").map((s) => s.path), ["Projects/Launch.md"]);
  assert.deepEqual(citedSources(SOURCES, "Per [[Pricing]], the plan stays.").map((s) => s.path), ["Projects/Pricing.md"]);
  assert.deepEqual(citedSources(SOURCES, "The launch is Friday."), []);
});

test("no reply or no sources gives nothing", () => {
  assert.deepEqual(citedSources(SOURCES, ""), []);
  assert.deepEqual(citedSources(null, "Projects/Launch.md"), []);
});
