// Capability card tasks for the `code` area (evals/axes.mjs). Same shape as evals/tasks.mjs.
// The existing `fix-test` task (one wrong operator) is the fourth code task; these three go further:
//   code-duration    implement two functions from a written spec (JavaScript, node --test)
//   code-pagination  find real logic bugs in a small Python module (python3 -m unittest)
//   code-crash-log   read a stack trace whose cause is one file away from the symptom (Node)
// Every check runs the project's own tests, proves the test files are byte for byte what setup wrote,
// and then runs extra cases the agent never saw, so special-casing the visible tests cannot pass.

const pass = (ok, why) => ({ ok: Boolean(ok), why });

// Files that must stay exactly as written: deleting or weakening a test fails the task.
function untouched(ctx, files) {
  for (const [rel, text] of Object.entries(files)) {
    if (ctx.readWorkspace(rel) !== text) return rel;
  }
  return "";
}

// Runs a throwaway script the agent never saw, then removes it. Returns { code, output }.
async function hidden(ctx, dir, name, source, command) {
  ctx.writeWorkspace(`${dir}/${name}`, source);
  const result = await ctx.run(`${command} ${name}`, dir);
  await ctx.run(`rm -f ${name}`, dir);
  return result;
}

// The few lines of a test run that say what went wrong (falls back to the last lines).
function tail(output) {
  const lines = String(output).split("\n").map((line) => line.trim()).filter(Boolean);
  const key = lines.filter((line) => /^(not ok|FAIL:|ERROR:|Traceback|AssertionError|\w*Error:|# fail)/.test(line) || /^(message|error|actual|expected):/.test(line));
  return (key.length ? key.slice(0, 3) : lines.slice(-3)).join(" | ").slice(0, 200);
}

// ---------------------------------------------------------------------------------------------
// 1. Implement from a written spec.

const DURATION = {
  "duration/package.json": `{ "name": "duration", "type": "module", "scripts": { "test": "node --test" } }\n`,
  "duration/README.md": `# duration

Two helpers for the scheduler, in duration.js (ES module). The tests are in duration.test.js.

## parseDuration(text) -> number of whole seconds

- The text is one or more parts, each a number followed by a unit: "1h 30m", "1h30m", "90 s", "2 days 3 hours".
- Spaces between a number and its unit, and between parts, are optional. Leading and trailing spaces are ignored.
- Units, any capitals: w, week, weeks | d, day, days | h, hr, hrs, hour, hours | m, min, mins, minute, minutes | s, sec, secs, second, seconds.
- One week is 7 days.
- Numbers may have decimals: "1.5h" is 5400. Round the total to the nearest whole second, halves up ("0.5s" is 1).
- Parts add up in any order. A unit may not appear twice, and the spellings of one unit count as the same unit ("1h 2h" and "1h 2 hours" are both invalid), but "1h 60m" is fine and is 7200.
- Anything else throws an Error whose message starts with "Invalid duration": not a string, empty or only spaces, a number with no unit ("90"), a unit with no number ("h"), an unknown unit ("5x"), a negative number ("-5m"), leftover text ("1h foo").

## formatDuration(seconds) -> string

- seconds must be a whole number of 0 or more, otherwise throw an Error whose message starts with "Invalid duration" (1.5, -1 and "5" are all invalid).
- Write the parts from largest to smallest using d, h, m and s, separated by one space, leaving out parts that are zero: 90061 is "1d 1h 1m 1s", 3600 is "1h", 5400 is "1h 30m".
- 0 is "0s". Weeks are never used: 604800 is "7d".
`,
  "duration/duration.js": `export function parseDuration(text) {
  throw new Error("not implemented");
}

export function formatDuration(seconds) {
  throw new Error("not implemented");
}
`,
  "duration/duration.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, parseDuration } from "./duration.js";

test("parses simple parts", () => {
  assert.equal(parseDuration("90s"), 90);
  assert.equal(parseDuration("2 days 3 hours"), 2 * 86400 + 3 * 3600);
  assert.equal(parseDuration("1h 30m"), 5400);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("1w"), 604800);
});

test("units are case insensitive and spaces are optional", () => {
  assert.equal(parseDuration("  15 MIN "), 900);
  assert.equal(parseDuration("1 Hour5 minutes"), 3900);
});

test("decimals and rounding", () => {
  assert.equal(parseDuration("1.5h"), 5400);
  assert.equal(parseDuration("0.5s"), 1);
  assert.equal(parseDuration("0.4s"), 0);
});

test("parts can come in any order and 60m is fine", () => {
  assert.equal(parseDuration("30s 1m"), 90);
  assert.equal(parseDuration("1h 60m"), 7200);
});

test("invalid input throws", () => {
  for (const bad of ["", "   ", "90", "h", "5x", "-5m", "1h foo", "1h 2h", null, undefined, 90]) {
    assert.throws(() => parseDuration(bad), /^Error: Invalid duration/, String(bad));
  }
});

test("formats from largest to smallest and skips zero parts", () => {
  assert.equal(formatDuration(90061), "1d 1h 1m 1s");
  assert.equal(formatDuration(3600), "1h");
  assert.equal(formatDuration(5400), "1h 30m");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(604800), "7d");
});

test("format rejects anything but a whole number of 0 or more", () => {
  for (const bad of [1.5, -1, "5", NaN, null]) {
    assert.throws(() => formatDuration(bad), /^Error: Invalid duration/, String(bad));
  }
});
`,
};

const DURATION_HIDDEN = `import assert from "node:assert/strict";
import { formatDuration, parseDuration } from "./duration.js";

const good = { "3 hrs 20 mins": 12000, "2W": 1209600, "1d1h1m1s": 90061, "1.1h": 3960, "  45 SEC ": 45, "1 week 1 day": 691200, "2.5 minutes": 150, "0.5s 1m": 61, "10 secs": 10, "1HR": 3600, "1m 1s 1h": 3661 };
for (const [text, seconds] of Object.entries(good)) assert.equal(parseDuration(text), seconds, "parse " + JSON.stringify(text));
for (const bad of ["1d 1 day", "1m 2 mins", "1.5", "1h,30m", "1h 30", "5 weeks ago", "1 h h", "--1h", "1e3s", "h 1"]) {
  assert.throws(() => parseDuration(bad), (error) => error instanceof Error && error.message.startsWith("Invalid duration"), "parse should reject " + JSON.stringify(bad));
}
const formatted = { 59: "59s", 60: "1m", 86399: "23h 59m 59s", 86400: "1d", 3661: "1h 1m 1s", 1209600: "14d", 172800: "2d", 90000: "1d 1h" };
for (const [seconds, text] of Object.entries(formatted)) assert.equal(formatDuration(Number(seconds)), text, "format " + seconds);
for (const bad of [Infinity, undefined, "", [], 0.1]) {
  assert.throws(() => formatDuration(bad), (error) => error instanceof Error && error.message.startsWith("Invalid duration"), "format should reject " + String(bad));
}
for (let n = 0; n < 5000; n += 37) assert.equal(parseDuration(formatDuration(n * 13)), n * 13, "round trip " + n * 13);
console.log("hidden duration cases ok");
`;

// ---------------------------------------------------------------------------------------------
// 2. Fix real logic bugs in a small Python module (standard library only).

const PAGINATION = {
  "pagination/paginate.py": `"""Page through a list of rows for the admin list. Pages start at 1."""
from math import ceil  # noqa: F401


def page_count(total, per_page):
    """How many pages \`total\` rows need. An empty list still has one page."""
    if per_page <= 0:
        raise ValueError("per_page must be positive")
    return total // per_page


def page_bounds(page, per_page, total):
    """Index range (start, end) of the rows on \`page\`; end is exclusive and never past \`total\`."""
    start = page * per_page
    end = min(start + per_page, total)
    return start, end


def get_page(items, page, per_page):
    """The rows on \`page\`. A page below 1 or past the last page is a ValueError."""
    if page < 1 or page > page_count(len(items), per_page):
        raise ValueError("page out of range")
    start, end = page_bounds(page, per_page, len(items))
    return items[start:end]


def describe(page, per_page, total):
    """The caption under the table: 'Showing 11-20 of 25', or 'No results'."""
    if total == 0:
        return "No results"
    start, end = page_bounds(page, per_page, total)
    return f"Showing {start + 1}-{end} of {total}"
`,
  "pagination/test_paginate.py": `import unittest

from paginate import describe, get_page, page_bounds, page_count


class PageCount(unittest.TestCase):
    def test_exact_and_partial_pages(self):
        self.assertEqual(page_count(20, 10), 2)
        self.assertEqual(page_count(25, 10), 3)
        self.assertEqual(page_count(1, 10), 1)

    def test_empty_list_has_one_page(self):
        self.assertEqual(page_count(0, 10), 1)

    def test_bad_page_size(self):
        with self.assertRaises(ValueError):
            page_count(10, 0)


class GetPage(unittest.TestCase):
    def setUp(self):
        self.rows = list(range(1, 26))

    def test_first_page(self):
        self.assertEqual(get_page(self.rows, 1, 10), list(range(1, 11)))

    def test_last_partial_page(self):
        self.assertEqual(get_page(self.rows, 3, 10), [21, 22, 23, 24, 25])

    def test_out_of_range(self):
        for page in (0, -1, 4):
            with self.assertRaises(ValueError):
                get_page(self.rows, page, 10)

    def test_empty_list_first_page(self):
        self.assertEqual(get_page([], 1, 10), [])


class Describe(unittest.TestCase):
    def test_middle_and_last(self):
        self.assertEqual(describe(2, 10, 25), "Showing 11-20 of 25")
        self.assertEqual(describe(3, 10, 25), "Showing 21-25 of 25")

    def test_single_short_page(self):
        self.assertEqual(describe(1, 10, 4), "Showing 1-4 of 4")

    def test_no_results(self):
        self.assertEqual(describe(1, 10, 0), "No results")


class Bounds(unittest.TestCase):
    def test_bounds(self):
        self.assertEqual(page_bounds(1, 10, 25), (0, 10))
        self.assertEqual(page_bounds(3, 10, 25), (20, 25))


if __name__ == "__main__":
    unittest.main()
`,
};

const PAGINATION_HIDDEN = `import unittest

from paginate import describe, get_page, page_bounds, page_count


class Hidden(unittest.TestCase):
    def test_counts(self):
        for total, size, pages in [(21, 10, 3), (30, 10, 3), (31, 10, 4), (9, 3, 3), (10, 3, 4), (7, 100, 1), (0, 5, 1), (1, 1, 1)]:
            self.assertEqual(page_count(total, size), pages, (total, size))
        with self.assertRaises(ValueError):
            page_count(5, -2)

    def test_pages(self):
        rows = [chr(97 + i) for i in range(23)]
        self.assertEqual(get_page(rows, 1, 5), rows[0:5])
        self.assertEqual(get_page(rows, 4, 5), rows[15:20])
        self.assertEqual(get_page(rows, 5, 5), rows[20:23])
        self.assertEqual(get_page(rows, 1, 100), rows)
        for page in (0, 6, 99, -3):
            with self.assertRaises(ValueError):
                get_page(rows, page, 5)
        self.assertEqual(get_page(["only"], 1, 1), ["only"])

    def test_captions(self):
        self.assertEqual(describe(1, 5, 23), "Showing 1-5 of 23")
        self.assertEqual(describe(5, 5, 23), "Showing 21-23 of 23")
        self.assertEqual(describe(2, 3, 6), "Showing 4-6 of 6")
        self.assertEqual(describe(1, 1, 1), "Showing 1-1 of 1")
        self.assertEqual(describe(7, 7, 0), "No results")

    def test_bounds(self):
        self.assertEqual(page_bounds(2, 4, 100), (4, 8))
        self.assertEqual(page_bounds(4, 4, 15), (12, 15))


if __name__ == "__main__":
    unittest.main()
`;

// ---------------------------------------------------------------------------------------------
// 3. Read a log with a stack trace and fix the cause, which is not where the error points.

const ORDERS = {
  "orders/package.json": `{ "name": "orders", "type": "module", "scripts": { "test": "node --test" } }\n`,
  "orders/src/pricing.js": `// Coupons we honour. The rate is the share taken off the order total.
const COUPONS = { SAVE10: 0.1, HALF: 0.5 };

// Price of an order after its coupon (if any), rounded to cents.
export function applyDiscount(total, coupon) {
  if (!coupon) return total;
  const rate = COUPONS[String(coupon).toUpperCase()];
  if (rate !== undefined) {
    return Math.round(total * (1 - rate) * 100) / 100;
  }
}
`,
  "orders/src/format.js": `// Money as shown in the report.
export function formatMoney(amount) {
  return "EUR " + amount.toFixed(2);
}
`,
  "orders/src/report.js": `import { formatMoney } from "./format.js";
import { applyDiscount } from "./pricing.js";

function renderLine(order) {
  const price = applyDiscount(order.total, order.coupon);
  return order.id + "  " + order.item.padEnd(14) + formatMoney(price);
}

// One line per order, then the grand total.
export function buildReport(orders) {
  const lines = orders.map(renderLine);
  const grand = orders.reduce((sum, order) => sum + applyDiscount(order.total, order.coupon), 0);
  lines.push("TOTAL         " + formatMoney(grand));
  return lines.join("\\n");
}
`,
  "orders/run-report.js": `import fs from "node:fs";
import { buildReport } from "./src/report.js";

const file = process.argv[2] || "data/orders.json";
const orders = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(buildReport(orders));
`,
  "orders/data/orders.json": JSON.stringify([
    { id: "A-1001", item: "Standing desk", total: 200, coupon: "SAVE10" },
    { id: "A-1002", item: "Monitor arm", total: 45.5, coupon: null },
    { id: "A-1003", item: "Desk lamp", total: 30, coupon: "SPRING5" },
    { id: "A-1004", item: "Footrest", total: 20, coupon: "half" },
  ], null, 2) + "\n",
  "orders/logs/nightly.log": `[2026-10-27 02:00:01] nightly report started, reading data/orders.json
[2026-10-27 02:00:01] 4 orders loaded
[2026-10-27 02:00:01] pricing A-1001 total=200 coupon=SAVE10
[2026-10-27 02:00:01] pricing A-1002 total=45.5 coupon=none
[2026-10-27 02:00:01] pricing A-1003 total=30 coupon=SPRING5
[2026-10-27 02:00:01] ERROR nightly report failed
TypeError: Cannot read properties of undefined (reading 'toFixed')
    at formatMoney (file:///srv/orders/src/format.js:3:25)
    at renderLine (file:///srv/orders/src/report.js:7:55)
    at Array.map (<anonymous>)
    at buildReport (file:///srv/orders/src/report.js:12:28)
    at file:///srv/orders/run-report.js:6:13
    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)
[2026-10-27 02:00:01] exit code 1, no report written
[2026-10-27 02:00:02] the finance team did not get the 02:00 report
`,
  "orders/test/pricing.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { applyDiscount } from "../src/pricing.js";

test("known coupons take their share off", () => {
  assert.equal(applyDiscount(200, "SAVE10"), 180);
  assert.equal(applyDiscount(25, "HALF"), 12.5);
});

test("coupon names ignore case", () => {
  assert.equal(applyDiscount(200, "save10"), 180);
});

test("no coupon, no change", () => {
  assert.equal(applyDiscount(45.5, null), 45.5);
  assert.equal(applyDiscount(45.5, ""), 45.5);
});

test("an unknown coupon changes nothing", () => {
  assert.equal(applyDiscount(30, "SPRING5"), 30);
});
`,
  "orders/test/report.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "../src/report.js";

test("report with a coupon, no coupon and an unknown coupon", () => {
  const report = buildReport([
    { id: "T-1", item: "Chair", total: 100, coupon: "SAVE10" },
    { id: "T-2", item: "Mat", total: 10.5, coupon: null },
    { id: "T-3", item: "Lamp", total: 30, coupon: "NOPE" },
  ]);
  assert.equal(report.split("\\n").length, 4);
  assert.match(report, /T-1 +Chair +EUR 90\\.00/);
  assert.match(report, /T-2 +Mat +EUR 10\\.50/);
  assert.match(report, /T-3 +Lamp +EUR 30\\.00/);
  assert.match(report, /TOTAL +EUR 130\\.50/);
});
`,
};

const ORDERS_TESTS = ["orders/test/pricing.test.js", "orders/test/report.test.js"];
const only = (project, rels) => Object.fromEntries(rels.map((rel) => [rel, project[rel]]));

export const tasks = [
  {
    id: "code-duration",
    title: "Implement two functions from a written spec",
    tags: ["code", "spec"],
    expectAsks: 0,
    setup: (ctx) => {
      for (const [rel, text] of Object.entries(DURATION)) ctx.writeWorkspace(rel, text);
    },
    prompt: () => "I need two small helpers for our scheduler. The duration folder in your workspace has a README that says exactly how parseDuration and formatDuration should behave, and the tests are already written. Implement them in duration.js and make `node --test` pass. Don't touch the tests.",
    check: async (ctx) => {
      const changed = untouched(ctx, only(DURATION, ["duration/duration.test.js", "duration/README.md", "duration/package.json"]));
      if (changed) return pass(false, `${changed} was changed`);
      const visible = await ctx.run("node --test", "duration");
      if (visible.code !== 0) return pass(false, `node --test exits ${visible.code}: ${tail(visible.output)}`);
      const extra = await hidden(ctx, "duration", ".check-hidden.mjs", DURATION_HIDDEN, "node");
      return pass(extra.code === 0, extra.code === 0 ? "tests pass and the extra spec cases pass" : `tests pass but an extra spec case fails: ${tail(extra.output)}`);
    },
  },
  {
    id: "code-pagination",
    title: "Fix logic bugs in a Python module",
    tags: ["code", "python"],
    expectAsks: 0,
    setup: (ctx) => {
      for (const [rel, text] of Object.entries(PAGINATION)) ctx.writeWorkspace(rel, text);
    },
    prompt: () => "Our admin list is showing the wrong rows: page 1 skips the first items, and the last page of a long list says it doesn't exist. The code is in the pagination folder of your workspace (pages start at 1) and the tests there say what's expected. Please fix it so `python3 -m unittest` passes.",
    check: async (ctx) => {
      const changed = untouched(ctx, only(PAGINATION, ["pagination/test_paginate.py"]));
      if (changed) return pass(false, `${changed} was changed`);
      const visible = await ctx.run("python3 -m unittest", "pagination");
      if (visible.code !== 0) return pass(false, `python3 -m unittest exits ${visible.code}: ${tail(visible.output)}`);
      const extra = await hidden(ctx, "pagination", ".check_hidden.py", PAGINATION_HIDDEN, "python3");
      return pass(extra.code === 0, extra.code === 0 ? "unittest passes and the extra page cases pass" : `unittest passes but an extra case fails: ${tail(extra.output)}`);
    },
  },
  {
    id: "code-crash-log",
    title: "Fix the cause of a crash from its log",
    tags: ["code", "debugging"],
    expectAsks: 0,
    setup: (ctx) => {
      for (const [rel, text] of Object.entries(ORDERS)) ctx.writeWorkspace(rel, text);
    },
    prompt: () => "Last night's order report crashed and finance didn't get it. The log is orders/logs/nightly.log in your workspace. Find out why it happened and fix it properly, then run the tests and the report job (`node run-report.js` in the orders folder) to make sure it works.",
    check: async (ctx) => {
      const changed = untouched(ctx, only(ORDERS, [...ORDERS_TESTS, "orders/data/orders.json", "orders/run-report.js", "orders/package.json"]));
      if (changed) return pass(false, `${changed} was changed`);
      const tests = await ctx.run("node --test", "orders");
      if (tests.code !== 0) return pass(false, `node --test exits ${tests.code}: ${tail(tests.output)}`);
      // The real job on the real data: the unknown coupon is charged full price, the others as before.
      const job = await ctx.run("node run-report.js", "orders");
      const lines = job.output.trim().split("\n");
      const ok = job.code === 0
        && lines.length === 5
        && /A-1001 +Standing desk +EUR 180\.00/.test(job.output)
        && /A-1002 +Monitor arm +EUR 45\.50/.test(job.output)
        && /A-1003 +Desk lamp +EUR 30\.00/.test(job.output)
        && /A-1004 +Footrest +EUR 10\.00/.test(job.output)
        && /TOTAL +EUR 265\.50/.test(job.output);
      return pass(ok, ok ? "tests pass and the nightly job prints all four orders and 265.50" : `tests pass but the job is wrong (exit ${job.code}): ${tail(job.output)}`);
    },
  },
];
