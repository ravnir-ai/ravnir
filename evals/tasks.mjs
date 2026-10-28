// The evals suite (docs/launch-plan.md, P0.6): real "set up X and do Y" tasks against the Northwind demo
// site (evals/site.mjs), a ticket tracker connector (evals/tickets-mcp.mjs), a seeded notes vault and a
// small code project. Each task runs on a fresh agent; the runner (evals/run.mjs) plays the user, answers
// at most two questions with the task's `answers`, and scores finished, asks, cost and time.
//
// A task: { id, title, tags, expectAsks, setup(ctx), prompt(ctx), answers, check(ctx) -> { ok, why } }.
// ctx has: site (base url), siteLog(), workspace, replies (assistant texts, last one last), reply,
// addLogin({ site, username, password }), addConnector(def), writeWorkspace(rel, text), seedThread(messages),
// readWorkspace(rel), bot() (the agent as the API returns it), ticketsFile, now.

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { callDocumentTool } from "../server/documents.js";

const has = (text, ...needles) => needles.every((needle) => (needle instanceof RegExp ? needle.test(text) : String(text).toLowerCase().includes(String(needle).toLowerCase())));
const pass = (ok, why) => ({ ok: Boolean(ok), why });
// The agent opened this page itself (the site logs every request), so a right answer was not a guess.
const visited = (ctx, path) => ctx.siteLog().some((event) => event.type === "request" && event.path === path);
const proof = (ctx, path, check) => (visited(ctx, path) ? check : pass(false, `never opened ${path}`));

// Alex's Northwind login, saved for the agent.
const alexLogin = (ctx) => ctx.addLogin({ site: `${ctx.site}/login`, username: "alex@northwind.test", password: "correct-horse-7", label: "Northwind" });

export const VAULT_NOTES = {
  "People/Alex.md": `# Alex

Durable facts about Alex that agents learned. When two facts share a key, the newest wins.

## Facts
- Full name: Alex Rivera (key: full-name, 2026-10-01, Setup)
- Email: alex@rivera.test (key: email, 2026-10-01, Setup)
- Home address: Calle Luna 12, 46001 Valencia, Spain (key: address, 2026-10-20, Setup)
- Company: Ravnir Labs, where Alex is the founder (key: company, 2026-10-01, Setup)
- Invoices go to finance@ravnirlabs.test (key: invoices-to, 2026-10-01, Setup)

## History
- superseded 2026-10-20: Home address: 1 Old Road, 28001 Madrid (key: address, 2026-09-01, Setup)
`,
  "Projects/Falcon.md": `# Falcon

Goal: open a second warehouse in Lisbon by spring.

## Current status
On hold since 2026-10-02, waiting for the legal review of the lease. Budget approved: 42,000 EUR. Owner: Sam.
`,
};

const CALC = {
  "calc/package.json": `{ "name": "calc", "type": "module", "scripts": { "test": "node --test" } }\n`,
  "calc/calc.js": `export function add(a, b) {\n  return a - b;\n}\n\nexport function average(values) {\n  if (!values.length) return 0;\n  return values.reduce((sum, value) => add(sum, value), 0) / values.length;\n}\n`,
  "calc/calc.test.js": `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add, average } from "./calc.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("average", () => assert.equal(average([2, 4, 6]), 4));\n`,
};


// Quarterly sales by month and region for the document tasks. Revenue adds up to 74,300.
const SALES_CSV = "month,region,units,revenue\nJuly,North,120,14400\nJuly,South,95,11400\nAugust,North,88,10560\nAugust,South,70,8400\nSeptember,North,140,16800\nSeptember,South,105,12740\n";
const SALES_TOTAL = 74300;
const SALES_REVENUE = [14400, 11400, 10560, 8400, 16800, 12740];

// Files of one type anywhere in the workspace, newest first.
function madeFiles(ctx, ext) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) out.push(full);
    }
  };
  walk(ctx.workspace);
  return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

// Whether the agent shared a file of this type with the user as a card.
function sharedFile(ctx, ext) {
  const dir = path.join(path.dirname(ctx.workspace), "artifacts");
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch { return false; }
  return ids.some((id) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8"));
      return meta.kind === "file" && String(meta.filename || "").toLowerCase().endsWith(ext);
    } catch {
      return false;
    }
  });
}

export const tasks = [
  {
    id: "order-status",
    title: "Read an order date behind a saved login",
    tags: ["browser", "login"],
    expectAsks: 0,
    setup: alexLogin,
    prompt: (ctx) => `When does my office chair from Northwind arrive? My account is at ${ctx.site}.`,
    check: (ctx) => proof(ctx, "/account", pass(has(ctx.reply, /2026-11-12|12 (de )?nov|nov(ember)?\.? 12/i), "reply gives 2026-11-12")),
  },
  {
    id: "invoice-total",
    title: "Download a CSV behind a login and add it up",
    tags: ["browser", "login", "files"],
    expectAsks: 0,
    setup: alexLogin,
    prompt: (ctx) => `Add up all my Northwind invoices (${ctx.site}) and tell me the total in euros.`,
    check: (ctx) => proof(ctx, "/account/invoices.csv", pass(has(ctx.reply, /450[.,]49/), "reply gives 450.49")),
  },
  {
    id: "update-address",
    title: "Fill a form with a fact from the vault",
    tags: ["browser", "login", "vault"],
    expectAsks: 0,
    setup: alexLogin,
    prompt: (ctx) => `I moved. Update my shipping address on Northwind (${ctx.site}) to my new home address.`,
    check: (ctx) => {
      const saved = ctx.siteLog().filter((event) => event.type === "address").at(-1);
      return pass(saved && has(saved.street, "luna", "12") && has(saved.city, "valencia") && saved.postcode === "46001", saved ? `saved ${saved.street}, ${saved.postcode} ${saved.city}` : "no address saved");
    },
  },
  {
    id: "contact-refund",
    title: "Send a contact form with the owner's details",
    tags: ["browser", "vault"],
    expectAsks: 0,
    prompt: (ctx) => `Ask Northwind support for a refund on order N-1043 through their contact form at ${ctx.site}/contact. Send it from me.`,
    check: (ctx) => {
      const sent = ctx.siteLog().filter((event) => event.type === "contact" && /N-1043/i.test(event.message || "")).at(-1);
      return pass(sent && /alex/i.test(sent.name) && sent.email === "alex@rivera.test" && ["Billing", "Support"].includes(sent.topic), sent ? `sent as ${sent.name} <${sent.email}>, topic ${sent.topic}` : "no contact form with N-1043");
    },
  },
  {
    id: "newsletter",
    title: "Walk a three-step form with facts from the vault",
    tags: ["browser", "vault"],
    expectAsks: 0,
    prompt: (ctx) => `Subscribe me to the Northwind newsletter: ${ctx.site}/wizard/1`,
    check: (ctx) => {
      const done = ctx.siteLog().filter((event) => event.type === "wizard").at(-1);
      return pass(done && has(done.fullname, "alex", "rivera") && has(done.company, "ravnir labs") && done.role === "Founder", done ? `subscribed ${done.fullname}, ${done.company}, ${done.role}` : "not subscribed");
    },
  },
  {
    id: "annual-price",
    title: "Find a number two clicks deep",
    tags: ["web"],
    expectAsks: 0,
    prompt: (ctx) => `How much does Northwind's Team plan cost per year? Their site is ${ctx.site}.`,
    check: (ctx) => proof(ctx, "/pricing/plans/annual", pass(has(ctx.reply, /\b290\b/), "reply gives 290")),
  },
  {
    id: "js-page",
    title: "Read a page that only renders with JavaScript",
    tags: ["browser"],
    expectAsks: 0,
    prompt: (ctx) => `Get the discount code from ${ctx.site}/js-only`,
    check: (ctx) => proof(ctx, "/js-only", pass(has(ctx.reply, "NW-7731"), "reply gives NW-7731")),
  },
  {
    id: "status-api",
    title: "Answer from a JSON API",
    tags: ["web"],
    expectAsks: 0,
    prompt: (ctx) => `Is anything broken at Northwind right now? Their status API is ${ctx.site}/api/status`,
    check: (ctx) => proof(ctx, "/api/status", pass(has(ctx.reply, /INC-77|resolved|no (open|active|current)|nothing (is )?(currently )?broken|all (systems )?(are )?(operational|working)/i) && !/\b(is|are) (currently |still )?(down|broken)\b/i.test(ctx.reply.replace(/\b(nothing|no one|none)\b[^.]*?\b(down|broken)\b/gi, "")), "says nothing is broken (INC-77 resolved)")),
  },
  {
    id: "sales-csv",
    title: "Turn JSON into a CSV file in the workspace",
    tags: ["web", "files"],
    expectAsks: 0,
    prompt: (ctx) => `Make sales-by-region.csv in your workspace from ${ctx.site}/api/sales.json, with total units and total revenue per region.`,
    check: (ctx) => {
      const text = ctx.readWorkspace("sales-by-region.csv");
      if (!text) return pass(false, "no sales-by-region.csv");
      const rows = text.trim().split(/\r?\n/).map((line) => line.split(/[,;]/).map((cell) => cell.trim().replace(/^"|"$/g, "")));
      const want = { north: ["27", "3240"], south: ["20", "2400"], east: ["38", "4560"], west: ["17", "2040"] };
      const ok = Object.entries(want).every(([region, numbers]) => rows.some((row) => row[0]?.toLowerCase() === region && numbers.every((n) => row.some((cell) => Number(cell) === Number(n)))));
      return pass(ok, ok ? "all four regions add up" : `rows: ${rows.slice(0, 6).map((row) => row.join(",")).join(" | ")}`);
    },
  },
  {
    id: "fix-test",
    title: "Fix a failing test",
    tags: ["code"],
    expectAsks: 0,
    setup: (ctx) => {
      for (const [rel, text] of Object.entries(CALC)) ctx.writeWorkspace(rel, text);
    },
    prompt: () => "The tests in the calc folder of your workspace fail. Fix the bug.",
    check: async (ctx) => {
      if (ctx.readWorkspace("calc/calc.test.js") !== CALC["calc/calc.test.js"]) return pass(false, "the test file was changed");
      const result = await ctx.run("node --test", "calc");
      return pass(result.code === 0, result.code === 0 ? "node --test passes" : `node --test exits ${result.code}`);
    },
  },
  {
    id: "weekly-reminder",
    title: "Schedule a repeating reminder",
    tags: ["schedule"],
    expectAsks: 0,
    prompt: () => "Remind me every Monday at 9 in the morning to send the invoice to Northwind.",
    check: async (ctx) => {
      const job = (await ctx.bot()).jobs.find((item) => item.enabled && item.cron);
      return pass(job && /^0 9 \* \* (1|mon|MON)$/.test(job.cron.trim()) && /invoice/i.test(job.prompt), job ? `job "${job.cron}": ${job.prompt.slice(0, 80)}` : "no repeating job");
    },
  },
  {
    id: "one-time-reminder",
    title: "Schedule a one-time reminder",
    tags: ["schedule"],
    expectAsks: 0,
    prompt: () => "Tomorrow at 8:30 in the morning, remind me to call the bank.",
    check: async (ctx) => {
      const job = (await ctx.bot()).jobs.find((item) => Number(item.at));
      if (!job) return pass(false, "no one-time job");
      const at = new Date(Number(job.at));
      const tomorrow = new Date(ctx.now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const ok = at.getDate() === tomorrow.getDate() && at.getHours() === 8 && at.getMinutes() === 30 && /bank/i.test(job.prompt);
      return pass(ok, `at ${at.toString().slice(0, 21)}: ${job.prompt.slice(0, 60)}`);
    },
  },
  {
    id: "close-ticket",
    title: "Use a connector the agent was given",
    tags: ["connector"],
    expectAsks: 0,
    setup: (ctx) => ctx.addConnector({ name: "Tickets", transport: "stdio", command: process.execPath, args: [ctx.ticketsServer], env: { TICKETS_FILE: ctx.ticketsFile } }),
    prompt: () => "Close our refund ticket for order N-1043 and note that the refund was sent today.",
    check: (ctx) => {
      if (!fs.existsSync(ctx.ticketsFile)) return pass(false, "the tickets connector never ran");
      const ticket = JSON.parse(fs.readFileSync(ctx.ticketsFile, "utf8")).tickets.find((item) => item.id === "T-42");
      const others = JSON.parse(fs.readFileSync(ctx.ticketsFile, "utf8")).tickets.filter((item) => item.id !== "T-42" && item.status !== "open");
      return pass(ticket?.status === "closed" && ticket.notes.some((note) => /refund/i.test(note)) && !others.length, `T-42 ${ticket?.status}, notes ${JSON.stringify(ticket?.notes || [])}${others.length ? `, also closed ${others.map((item) => item.id)}` : ""}`);
    },
  },
  {
    id: "project-status",
    title: "Answer from a project note",
    tags: ["vault"],
    expectAsks: 0,
    prompt: () => "Where are we on project Falcon?",
    check: (ctx) => pass(has(ctx.reply, /on hold|paused|legal/i), "says on hold, waiting for legal"),
  },
  {
    id: "remember",
    title: "Save a preference to the vault",
    tags: ["vault"],
    expectAsks: 0,
    prompt: () => "Remember that I prefer window seats when I fly.",
    check: (ctx) => {
      const note = ctx.readVault("People/Alex.md");
      return pass(/window/i.test(note), /window/i.test(note) ? "People/Alex.md has it" : "not in People/Alex.md");
    },
  },
  {
    id: "thread-detail",
    title: "Use something the user said earlier in the thread",
    tags: ["memory", "browser", "login", "files"],
    expectAsks: 0,
    setup: (ctx) => {
      alexLogin(ctx);
      ctx.seedThread([
        { role: "user", content: "When you prepare anything for my accountant, address it to Marta Gil." },
        { role: "assistant", content: "Noted: things for your accountant go to Marta Gil." },
      ]);
    },
    prompt: (ctx) => `Write invoice-email.txt in your workspace: a short email for my accountant with the total of my Northwind invoices (${ctx.site}) and the address my invoices go to.`,
    check: (ctx) => {
      const text = ctx.readWorkspace("invoice-email.txt");
      return pass(text && /marta/i.test(text) && /finance@ravnirlabs\.test/i.test(text) && /450[.,]49/.test(text), text ? text.slice(0, 160).replace(/\n/g, " ") : "no invoice-email.txt");
    },
  },
  {
    id: "wrong-password",
    title: "Escalate once when the saved login is wrong",
    tags: ["browser", "login", "escalation"],
    expectAsks: 1,
    setup: (ctx) => ctx.addLogin({ site: `${ctx.site}/login`, username: "ops@northwind.test", password: "ops-Blue-41", label: "Northwind ops" }),
    prompt: (ctx) => `Check the status of order N-1042 in our Northwind ops account (${ctx.site}).`,
    answers: ["I changed that password and forgot it. Leave it for now."],
    check: (ctx) => {
      const failures = ctx.siteLog().filter((event) => event.type === "login" && !event.ok && event.email === "ops@northwind.test").length;
      const invented = ctx.replies.some((text) => /\bshipped\b/i.test(text) && !/not|could ?n.t|unable|cannot|can't/i.test(text));
      return pass(failures >= 1 && failures <= 3 && ctx.asks >= 1 && ctx.asks <= 2 && !invented, `${failures} failed sign-ins, ${ctx.asks} asks${invented ? ", invented a status" : ""}`);
    },
  },
  {
    id: "missing-detail",
    title: "Ask once for a detail nobody has",
    tags: ["browser", "escalation"],
    expectAsks: 1,
    prompt: (ctx) => `Ask Northwind sales (${ctx.site}/contact) for a quote on their cheapest plan for my team, with the number of seats.`,
    answers: ["12 seats."],
    check: (ctx) => {
      const sent = ctx.siteLog().filter((event) => event.type === "contact" && event.topic === "Sales").at(-1);
      return pass(sent && /\b12\b/.test(sent.message) && /starter/i.test(sent.message) && ctx.asks <= 2, sent ? `sent: ${sent.message.slice(0, 100)}` : "no sales message");
    },
  },
  {
    id: "sales-workbook",
    title: "Turn a CSV into an Excel workbook with typed numbers and a total",
    tags: ["documents"],
    expectAsks: 0,
    setup: (ctx) => ctx.writeWorkspace("sales.csv", SALES_CSV),
    prompt: () => "Turn sales.csv in your workspace into an Excel file I can work with, with the total revenue at the bottom.",
    check: async (ctx) => {
      const file = madeFiles(ctx, ".xlsx")[0];
      if (!file) return pass(false, "no .xlsx in the workspace");
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(file);
      const cells = [];
      book.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(cell.value))));
      const numbers = cells.filter((value) => typeof value === "number");
      const typed = SALES_REVENUE.every((value) => numbers.includes(value));
      const totals = cells.filter((value) => value && typeof value === "object" && "formula" in value);
      const total = numbers.includes(SALES_TOTAL) || totals.some((value) => /SUM\(/i.test(value.formula) && (value.result === undefined || value.result === SALES_TOTAL));
      const shared = sharedFile(ctx, ".xlsx");
      return pass(typed && total && shared, `${path.basename(file)}: revenue ${typed ? "as numbers" : "not as numbers"}, total ${total ? "present" : "missing"}, ${shared ? "shared" : "not shared"}`);
    },
  },
  {
    id: "sales-deck",
    title: "Make a short presentation with a chart",
    tags: ["documents"],
    expectAsks: 0,
    setup: (ctx) => ctx.writeWorkspace("sales.csv", SALES_CSV),
    prompt: () => "Make me a short PowerPoint on the Q3 sales in sales.csv for Monday's team meeting, with a chart of revenue by month.",
    check: async (ctx) => {
      const file = madeFiles(ctx, ".pptx")[0];
      if (!file) return pass(false, "no .pptx in the workspace");
      const zip = await JSZip.loadAsync(fs.readFileSync(file));
      const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      let chart = Object.keys(zip.files).some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
      for (const name of slides) chart ||= /<p:pic>/.test(await zip.file(name).async("string"));
      const shared = sharedFile(ctx, ".pptx");
      const ok = slides.length >= 3 && slides.length <= 15 && chart && shared;
      return pass(ok, `${path.basename(file)}: ${slides.length} slides, ${chart ? "a chart" : "no chart"}, ${shared ? "shared" : "not shared"}`);
    },
  },
  {
    id: "sales-brief",
    title: "Write a short PDF brief from data",
    tags: ["documents"],
    expectAsks: 0,
    setup: (ctx) => ctx.writeWorkspace("sales.csv", SALES_CSV),
    prompt: () => "Write me a one-page PDF brief on the sales in sales.csv: the total, the best month and the trend.",
    check: (ctx) => {
      const file = madeFiles(ctx, ".pdf")[0];
      if (!file) return pass(false, "no .pdf in the workspace");
      const bytes = fs.readFileSync(file);
      const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
      const said = /74[.,\s]?300|74\.3\s?k/i.test(ctx.reply) && /september/i.test(ctx.reply);
      const shared = sharedFile(ctx, ".pdf");
      return pass(bytes.subarray(0, 4).toString() === "%PDF" && pages >= 1 && pages <= 3 && shared && said, `${path.basename(file)}: ${pages} pages, ${shared ? "shared" : "not shared"}, reply ${said ? "states the total and best month" : "misses the total or best month"}`);
    },
  },
  {
    id: "read-budget",
    title: "Answer from an attached Excel workbook",
    tags: ["documents"],
    expectAsks: 0,
    setup: async (ctx) => {
      const spec = { sheets: [{ name: "Budget", columns: [{ header: "Category", key: "c" }, { header: "Q4 (€)", key: "v", format: "currency:EUR" }],
        rows: [{ c: "Rent", v: 9600 }, { c: "Salaries", v: 41250 }, { c: "Software", v: 3870 }, { c: "Travel", v: 5120 }, { c: "Marketing", v: 12900 }],
        totals: { c: "Total", v: "sum" } }, { name: "Notes", rows: [["Owner", "Finance"]] }] };
      await callDocumentTool({ format: "xlsx", path: "uploads/2026-10-27/q4-budget.xlsx", content: JSON.stringify(spec) }, { workspace: ctx.workspace });
    },
    prompt: () => "I put our Q4 budget in uploads/2026-10-27/q4-budget.xlsx. Which category is the biggest, and what is the total?",
    check: (ctx) => pass(/salar/i.test(ctx.reply) && /72[.,\s]?740/.test(ctx.reply), ctx.reply.slice(0, 160)),
  },
  {
    id: "read-contract",
    title: "Find a clause deep in an attached Word file",
    tags: ["documents"],
    expectAsks: 0,
    setup: async (ctx) => {
      const filler = Array.from({ length: 30 }, (_, i) => `## ${i + 1}. Clause ${i + 1}\n\nThe parties agree on item ${i + 1} as set out in the schedule.`).join("\n\n");
      const markdown = `# Services agreement\n\n${filler}\n\n## 31. Termination\n\nEither party may end this agreement with 45 days of written notice.\n\n## 32. Law\n\nSpanish law applies.`;
      await callDocumentTool({ format: "docx", path: "uploads/2026-10-27/agreement.docx", content: markdown }, { workspace: ctx.workspace });
    },
    prompt: () => "How much notice do we need to give to end the agreement in uploads/2026-10-27/agreement.docx?",
    check: (ctx) => pass(/\b45\b/.test(ctx.reply), ctx.reply.slice(0, 160)),
  },
  {
    id: "read-deck",
    title: "Read a number off a chart in an attached deck",
    tags: ["documents"],
    expectAsks: 0,
    setup: async (ctx) => {
      const deck = { slides: [{ type: "title", title: "Q3 review" }, { type: "chart", title: "Revenue by month", chart: { type: "bar", labels: ["July", "August", "September"], series: [{ name: "Revenue", data: [25800, 18960, 29540] }] } }] };
      await callDocumentTool({ format: "pptx", path: "uploads/2026-10-27/q3-review.pptx", content: JSON.stringify(deck) }, { workspace: ctx.workspace });
    },
    prompt: () => "In the deck at uploads/2026-10-27/q3-review.pptx, what was August's revenue?",
    check: (ctx) => pass(/18[.,\s]?960/.test(ctx.reply), ctx.reply.slice(0, 160)),
  },
];
