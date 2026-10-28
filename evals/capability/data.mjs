// Capability card, area "data" (evals/axes.mjs). Same shape as evals/tasks.mjs.
// Numbers are not round and live only in the input files, so a guess cannot pass. Expected values are
// computed here from the same data the agent gets.

import { dateIn } from "./writing.mjs";

const pass = (ok, why) => ({ ok: Boolean(ok), why });

// A number in the reply, in the usual written forms: 12,345.67 / 12345.67 / 12.345,67 / 12 345,67.
function hasAmount(text, cents) {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  const digits = String(whole);
  const variants = new Set();
  for (const group of ["", ",", ".", " ", " ", " "]) {
    const int = group ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, group) : digits;
    for (const decimal of [".", ","]) {
      if (decimal !== group) variants.add(`${int}${decimal}${frac}`);
    }
  }
  const escaped = [...variants].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\d])(?:${escaped.join("|")})(?![\\d])`).test(String(text));
}

// A percent or small decimal with the given one-decimal text (e.g. "7.3"), not part of a longer number.
function hasDecimal(text, value, places = 1) {
  const [a, b] = value.toFixed(places).split(".");
  return new RegExp(`(?<![\\d.,])${a}[.,]${b}(?![\\d])`).test(String(text));
}

// A small CSV reader (quotes, commas inside quotes).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = String(text).replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

// --- 1. Month over month growth from an orders export ------------------------------------------

// Deterministic orders for August to October 2026: paid, refunded (negative) and void rows, then the
// export tool's own TOTAL line. Net revenue = paid minus refunds, void ignored, TOTAL line ignored.
function buildOrders() {
  let seed = 90417;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const regions = ["EMEA", "AMER", "APAC"];
  const channels = ["web", "partner", "phone"];
  const rows = [];
  for (const [month, count] of [[8, 19], [9, 23], [10, 26]]) {
    for (let i = 0; i < count; i += 1) {
      const day = 1 + Math.floor(next() * 28);
      const roll = next();
      const status = roll < 0.74 ? "paid" : roll < 0.88 ? "refunded" : "void";
      const cents = 14000 + Math.floor(next() * 190000);
      rows.push({ date: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, region: regions[Math.floor(next() * 3)], channel: channels[Math.floor(next() * 3)], status, cents: status === "refunded" ? -Math.floor(cents * 0.6) : cents });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const net = (month) => rows.filter((row) => row.date.startsWith(`2026-${month}`) && row.status !== "void").reduce((sum, row) => sum + row.cents, 0);
  const gross = (month) => rows.filter((row) => row.date.startsWith(`2026-${month}`)).reduce((sum, row) => sum + row.cents, 0);
  const money = (cents) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
  const csv = ["date,region,channel,status,amount_eur", ...rows.map((row) => `${row.date},${row.region},${row.channel},${row.status},${money(row.cents)}`), `TOTAL,,,,${money(rows.reduce((sum, row) => sum + row.cents, 0))}`].join("\n") + "\n";
  const sep = net("09");
  const oct = net("10");
  return { csv, sep, oct, growth: ((oct - sep) / sep) * 100, wrong: { withVoid: ((gross("10") - gross("09")) / gross("09")) * 100, paidOnly: (() => {
    const paid = (m) => rows.filter((row) => row.date.startsWith(`2026-${m}`) && row.status === "paid").reduce((sum, row) => sum + row.cents, 0);
    return ((paid("10") - paid("09")) / paid("09")) * 100;
  })() } };
}
export const ORDERS = buildOrders();

const growth = {
  id: "mom-growth",
  title: "Month over month revenue growth from an orders export",
  tags: ["data", "files"],
  expectAsks: 0,
  setup: (ctx) => ctx.writeWorkspace("data/orders-aug-oct.csv", ORDERS.csv),
  prompt: () => "data/orders-aug-oct.csv in your workspace is the orders export from our shop. Net revenue is what was paid minus what was refunded, and void orders don't count. How much did net revenue grow from September to October? Give me both months' net revenue to the cent and the growth in percent with one decimal.",
  check: (ctx) => {
    const reply = ctx.reply;
    if (!hasAmount(reply, ORDERS.sep)) return pass(false, `September net ${ORDERS.sep / 100} missing`);
    if (!hasAmount(reply, ORDERS.oct)) return pass(false, `October net ${ORDERS.oct / 100} missing`);
    if (!hasDecimal(reply, ORDERS.growth)) return pass(false, `growth ${ORDERS.growth.toFixed(1)}% missing`);
    return pass(true, `reply gives ${ORDERS.sep / 100}, ${ORDERS.oct / 100} and ${ORDERS.growth.toFixed(1)}%`);
  },
};

// --- 2. Unit economics: contribution margin and payback ----------------------------------------

const PLAN_NOTES = `# Pricing and costs, Q4 planning

Notes pulled together by Sam. Numbers are per customer unless said otherwise.

## Price
Plan price is 49 EUR a month. (It was 45 EUR until 31 August, old customers were moved over.)
Monthly churn is running at 4.5%.

## Costs of serving a customer
- Payment processor takes 2.9% of each charge plus 0.30 EUR per charge. One charge a month.
- Hosting is 6.35 EUR per active customer per month.
- Support: about 1 ticket per 8 customers per month, and a ticket costs us 16.80 EUR.

## Acquisition
Q3 marketing spend was 41,830 EUR and brought in 197 new paying customers.
CAC is that spend divided by the new customers, nothing else added.

## Definitions
Contribution margin per customer per month = price minus payment fees, hosting and support.
Payback months = CAC divided by contribution margin per month.
`;
const PRICE = 49;
const CONTRIBUTION = PRICE - (PRICE * 0.029 + 0.3) - 6.35 - 16.8 / 8;
const CAC = 41830 / 197;
const PAYBACK = CAC / CONTRIBUTION;

const unitEconomics = {
  id: "unit-economics",
  title: "Contribution margin and payback months from planning notes",
  tags: ["data", "files"],
  expectAsks: 0,
  setup: (ctx) => ctx.writeWorkspace("finance/q4-plan.md", PLAN_NOTES),
  prompt: () => "Sam left the numbers for our pricing review in finance/q4-plan.md. Work out for me the contribution margin per customer per month, in euros to the cent, and how many months it takes to pay back the cost of acquiring a customer, to one decimal. Use the definitions in the file.",
  check: (ctx) => {
    const reply = ctx.reply;
    const cents = Math.round(CONTRIBUTION * 100);
    if (!hasAmount(reply, cents)) return pass(false, `contribution margin ${(cents / 100).toFixed(2)} missing`);
    if (!hasDecimal(reply, PAYBACK)) return pass(false, `payback ${PAYBACK.toFixed(1)} months missing`);
    return pass(true, `reply gives ${(cents / 100).toFixed(2)} per month and ${PAYBACK.toFixed(1)} months`);
  },
};

// --- 3. Clean a messy customer list and count unique customers per country ---------------------

const COUNTRY_CODES = "code,country\nES,Spain\nDE,Germany\nFR,France\nGB,United Kingdom\nIT,Italy\nPT,Portugal\n";
// [name, email, country code, number of extra messy rows]
const PEOPLE = [
  ["Ana Ruiz", "ana.ruiz@mail.test", "ES", 2], ["Pablo Gil", "pgil@mail.test", "ES", 0], ["Marta Soler", "marta.soler@mail.test", "ES", 1],
  ["Jorge Vidal", "jvidal@mail.test", "ES", 0], ["Elena Pons", "elena.pons@mail.test", "ES", 1], ["Hugo Marin", "hugo.marin@mail.test", "ES", 0],
  ["Carla Nieto", "carla.n@mail.test", "ES", 0], ["Iker Vega", "iker.vega@mail.test", "ES", 0],
  ["Lena Fischer", "lena.fischer@mail.test", "DE", 1], ["Jonas Weber", "j.weber@mail.test", "DE", 0], ["Mia Hoffmann", "mia.h@mail.test", "DE", 2],
  ["Paul Richter", "paul.richter@mail.test", "DE", 0], ["Nina Koch", "nina.koch@mail.test", "DE", 0],
  ["Camille Roux", "camille.roux@mail.test", "FR", 1], ["Louis Petit", "louis.petit@mail.test", "FR", 0], ["Chloe Faure", "chloe.faure@mail.test", "FR", 1],
  ["Remy Blanc", "remy.blanc@mail.test", "FR", 0],
  ["Oliver Hughes", "oliver.hughes@mail.test", "GB", 1], ["Amelia Clarke", "amelia.c@mail.test", "GB", 0], ["Harry Bell", "harry.bell@mail.test", "GB", 2],
  ["Isla Reid", "isla.reid@mail.test", "GB", 0], ["Jack Ward", "jack.ward@mail.test", "GB", 0], ["Ruby Cole", "ruby.cole@mail.test", "GB", 0],
  ["Giulia Conti", "giulia.conti@mail.test", "IT", 1], ["Marco Rossi", "marco.rossi@mail.test", "IT", 0],
  ["Rui Costa", "rui.costa@mail.test", "PT", 1], ["Ines Duarte", "ines.duarte@mail.test", "PT", 0], ["Tiago Lopes", "tiago.l@mail.test", "PT", 0],
];
const COUNTRY_NAME = { ES: "Spain", DE: "Germany", FR: "France", GB: "United Kingdom", IT: "Italy", PT: "Portugal" };
// How a country shows up in the sheet: the code, the name, shouting, a trailing space, a local spelling.
const COUNTRY_FORMS = {
  ES: ["ES", "Spain", "spain", "SPAIN ", "es"], DE: ["DE", "Germany", "germany ", "GERMANY", "de"], FR: ["FR", "France", "france", "FRANCE ", "fr"],
  GB: ["GB", "United Kingdom", "UK", "U.K.", "gb "], IT: ["IT", "Italy", "italy ", "ITALY", "it"], PT: ["PT", "Portugal", "portugal", "PORTUGAL ", "pt"],
};

function buildCustomers() {
  const lines = ["name,email,country,signup"];
  let n = 0;
  const q = (value) => (value.includes(",") ? `"${value}"` : value);
  const form = (code, k) => COUNTRY_FORMS[code][k % COUNTRY_FORMS[code].length];
  const rows = [];
  PEOPLE.forEach(([name, email, code, extras], index) => {
    rows.push([name, email, form(code, index), `2026-0${1 + (index % 9)}-1${index % 9}`]);
    for (let e = 0; e < extras; e += 1) {
      n += 1;
      const messy = [email.toUpperCase().replace("@MAIL.TEST", "@mail.test"), ` ${email} `, email.replace(/^(\w)/, (c) => c.toUpperCase())][e % 3];
      const messyName = e % 2 ? name.toLowerCase() : name.split(" ").reverse().join(", ");
      rows.push([messyName, messy, form(code, index + e + 2), `2026-1${e % 2}-0${1 + (n % 8)}`]);
    }
  });
  // Shuffle by a fixed stride so duplicates are not next to each other.
  const order = rows.map((_, i) => (i * 11) % rows.length);
  const seen = new Set();
  const shuffled = (new Set(order).size === rows.length ? order : rows.map((_, i) => i)).map((i) => rows[i]).filter((row) => { const k = row.join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
  for (const row of shuffled) lines.push(row.map((cell) => q(cell)).join(","));
  const expected = {};
  for (const [, , code] of PEOPLE) expected[COUNTRY_NAME[code]] = (expected[COUNTRY_NAME[code]] || 0) + 1;
  return { csv: `${lines.join("\n")}\n`, expected, messyRows: shuffled.length };
}
export const CUSTOMERS = buildCustomers();

const customers = {
  id: "clean-customers",
  title: "Clean a messy customer export and count unique customers per country",
  tags: ["data", "files"],
  expectAsks: 0,
  setup: (ctx) => {
    ctx.writeWorkspace("data/customers-export.csv", CUSTOMERS.csv);
    ctx.writeWorkspace("data/country-codes.csv", COUNTRY_CODES);
  },
  prompt: () => "data/customers-export.csv is the customer list from our old CRM, and it is a mess: the same person is in there more than once with different capitalisation and spacing, and countries are written every which way (UK means United Kingdom). Count the unique customers per country, a customer being one email address, and write it to customers-by-country.csv with the columns country and customers. Use the country names from data/country-codes.csv.",
  check: (ctx) => {
    const text = ctx.readWorkspace("customers-by-country.csv");
    if (!text.trim()) return pass(false, "no customers-by-country.csv");
    const rows = parseCsv(text);
    const head = rows[0].map((cell) => cell.trim().toLowerCase());
    const ci = head.indexOf("country");
    const ni = head.findIndex((cell) => /^(customers|unique_customers|count)$/.test(cell));
    if (ci < 0 || ni < 0) return pass(false, `header is "${rows[0].join(",")}"`);
    const got = {};
    for (const row of rows.slice(1)) got[(row[ci] || "").trim()] = Number((row[ni] || "").trim());
    const want = CUSTOMERS.expected;
    const wrong = Object.keys(want).filter((country) => got[country] !== want[country]).map((country) => `${country} ${got[country] ?? "missing"} (want ${want[country]})`);
    const extra = Object.keys(got).filter((country) => !(country in want));
    if (wrong.length) return pass(false, wrong.slice(0, 3).join("; "));
    if (extra.length) return pass(false, `extra rows: ${extra.slice(0, 3).join(", ")}`);
    return pass(true, `6 countries, ${Object.values(want).reduce((a, b) => a + b, 0)} unique customers, all counts match`);
  },
};

// --- 4. Business days with holidays -------------------------------------------------------------

const CONTRACT = `SERVICE AGREEMENT, Northwind Supply and Harbor Retail

Signed on 14 October 2026.

7. Delivery. Northwind shall deliver the first shipment within 20 business days of signature.
Counting starts on the day after signature. A business day is a day from Monday to Friday that
is not on the holiday list in clause 12. Delivery on the last business day is on time.

9. Payment. Harbor Retail pays within 30 calendar days of the invoice.

12. Holiday list (the warehouse is closed on these days):
- 2 November 2026 (company day)
- 7 November 2026 (local fair)
- 9 November 2026 (city holiday)
- 8 December 2026 (national holiday)
`;
function deliveryDeadline() {
  const holidays = new Set(["2026-11-02", "2026-11-07", "2026-11-09", "2026-12-08"]);
  const day = new Date(Date.UTC(2026, 9, 14));
  let counted = 0;
  while (counted < 20) {
    day.setUTCDate(day.getUTCDate() + 1);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(day.toISOString().slice(0, 10))) continue;
    counted += 1;
  }
  return { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), weekday: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][day.getUTCDay()] };
}
export const DEADLINE = deliveryDeadline();

const businessDays = {
  id: "business-days",
  title: "Delivery deadline in business days, minus holidays",
  tags: ["data", "files"],
  expectAsks: 0,
  setup: (ctx) => ctx.writeWorkspace("legal/service-agreement.txt", CONTRACT),
  prompt: () => "Per the service agreement in legal/service-agreement.txt, what is the last day Northwind can deliver the first shipment without breaching the contract? Give me the date and the weekday.",
  check: (ctx) => {
    const reply = ctx.reply;
    if (!dateIn(reply, DEADLINE.y, DEADLINE.m, DEADLINE.d)) return pass(false, `deadline ${DEADLINE.y}-${DEADLINE.m}-${DEADLINE.d} missing`);
    if (!new RegExp(DEADLINE.weekday, "i").test(reply)) return pass(false, `weekday ${DEADLINE.weekday} missing`);
    return pass(true, `reply gives ${DEADLINE.weekday} ${DEADLINE.d}/${DEADLINE.m}/${DEADLINE.y}`);
  },
};

export const tasks = [growth, unitEconomics, customers, businessDays];
