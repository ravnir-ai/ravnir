import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { callBuiltinTool } from "../server/computer.js";
import { callDocumentTool } from "../server/documents.js";
import { callReadDocument, parseRange } from "../server/readDocument.js";
import { attachmentNote } from "../server/uploads.js";

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-read-"));
  fs.copyFileSync(path.join(PROJECT, "public", "icon-192.png"), path.join(dir, "logo.png"));
  return dir;
}

const read = (dir, args) => callReadDocument(args, { workspace: dir });

test("an Excel workbook reads back with row numbers, values, formulas and paging", async () => {
  const dir = workspace();
  const rows = Array.from({ length: 60 }, (_, i) => ({ item: `Item ${i + 1}`, amount: (i + 1) * 10, when: "2026-10-01" }));
  const spec = { sheets: [
    { name: "Data", columns: [{ header: "Item", key: "item" }, { header: "Amount", key: "amount", format: "integer" }, { header: "When", key: "when", format: "date" }], rows, totals: { item: "Total", amount: "sum" } },
    { name: "Notes", rows: [["Source", "export"]] },
  ] };
  await callDocumentTool({ format: "xlsx", path: "book.xlsx", content: JSON.stringify(spec) }, { workspace: dir });

  const all = await read(dir, { path: "book.xlsx" });
  assert.match(all.text, /Excel, 2 sheets: Data \(62 rows, 3 columns\); Notes \(2 rows, 2 columns\)/);
  assert.match(all.text, /\| 2 \| Item 1 \| 10 \| 2026-10-01 \|/);
  assert.match(all.text, /\| 62 \| Total \| 18300 \(=SUM\(B2:B61\)\) \|/);
  assert.match(all.text, /## Sheet Notes/);

  const part = await read(dir, { path: "book.xlsx", sheet: "data", max_chars: 2000 });
  const next = Number(/"from_row": (\d+)/.exec(part.text)?.[1]);
  assert.ok(next > 2 && next < 62, part.text.slice(-200));
  const rest = await read(dir, { path: "book.xlsx", sheet: "Data", from_row: next });
  assert.match(rest.text, new RegExp(`\\| ${next} \\| Item ${next - 1} \\|`));
  assert.doesNotMatch(rest.text, /\| 2 \| Item 1 \|/);
  await assert.rejects(read(dir, { path: "book.xlsx", sheet: "Nope" }), /The sheets are: Data, Notes/);
});

test("a Word document reads back with headings, numbered and bulleted lists, and tables", async () => {
  const dir = workspace();
  const markdown = "# Contract\n\n## Parties\n\nBetween **Acme** and Northwind.\n\n1. First duty\n2. Second duty\n   - a detail\n\n| Item | Price |\n|---|---|\n| Setup | 1.200 € |\n\n\\pagebreak\n\n## Signatures\n";
  await callDocumentTool({ format: "docx", path: "contract.docx", content: markdown }, { workspace: dir });
  const result = await read(dir, { path: "contract.docx" });
  assert.match(result.text, /Word, 3 headings, 1 table/);
  assert.match(result.text, /# Contract\n\n## Parties\n\nBetween Acme and Northwind\./);
  assert.match(result.text, /1\. First duty\n2\. Second duty\n {2}- a detail/);
  assert.match(result.text, /\| Setup \| 1\.200 € \|/);
  assert.match(result.text, /---\n\n## Signatures/);
  const tail = await read(dir, { path: "contract.docx", start: result.text.indexOf("Signatures") });
  assert.match(tail.summary || tail.text, /part from|characters/);
});

test("a deck reads back slide by slide with notes, tables and the chart's numbers", async () => {
  const dir = workspace();
  const deck = { slides: [
    { type: "title", title: "Q3", subtitle: "Review" },
    { type: "bullets", title: "Revenue beat plan", bullets: ["Up 12%", ["July record"]], notes: "Source: sales.xlsx" },
    { type: "chart", title: "By month", chart: { type: "bar", unit: "€", labels: ["Jul", "Aug"], series: [{ name: "2026", data: [12400, 9800] }] } },
    { type: "table", title: "Regions", columns: ["Region", "Q3"], rows: [["North", "11.9k"]] },
  ] };
  await callDocumentTool({ format: "pptx", path: "deck.pptx", content: JSON.stringify(deck) }, { workspace: dir });
  const result = await read(dir, { path: "deck.pptx" });
  assert.match(result.text, /PowerPoint, 4 slides/);
  assert.match(result.text, /--- Slide 2 ---\nRevenue beat plan\nUp 12%\n {2}July record\nNotes: Source: sales\.xlsx/);
  assert.match(result.text, /\[picture: By month \(€\)\. Jul: 12400; Aug: 9800\]/);
  assert.match(result.text, /\| North \| 11\.9k \|/);
  assert.doesNotMatch(result.text, /^\d+$/m, "slide number boxes are left out");
  const two = await read(dir, { path: "deck.pptx", pages: "2" });
  assert.match(two.text, /Slide 2/);
  assert.doesNotMatch(two.text, /Slide 3/);
});

test("a PDF reads page by page, and a scan is flagged instead of returning nothing", async () => {
  const dir = workspace();
  await callDocumentTool({ format: "pdf", path: "brief.pdf", content: "# Brief\n\nTotal revenue was 74,300.\n\n\\pagebreak\n\n## Second page\n\nSeptember led." }, { workspace: dir });
  const result = await read(dir, { path: "brief.pdf" });
  assert.match(result.text, /PDF, 2 pages/);
  assert.match(result.text, /--- Page 1 ---\n[\s\S]*Total revenue was 74,300\./);
  assert.match(result.text, /--- Page 2 ---\n[\s\S]*September led\./);
  assert.doesNotMatch(result.text, /probably a scan/, "short pages of real text are not a scan");
  await callDocumentTool({ format: "pdf", path: "note.pdf", content: "Total 74.300." }, { workspace: dir });
  assert.doesNotMatch((await read(dir, { path: "note.pdf" })).text, /probably a scan/);
  const second = await read(dir, { path: "brief.pdf", pages: "2" });
  assert.doesNotMatch(second.text, /74,300/);

  await callDocumentTool({ format: "pdf", path: "scan.pdf", content: '<!doctype html><html><body><img src="logo.png" style="width:100%"></body></html>' }, { workspace: dir });
  const scan = await read(dir, { path: "scan.pdf" });
  assert.match(scan.text, /probably a scan/);
});

test("reading stays inside the workspace and refuses what it cannot read", async () => {
  const dir = workspace();
  fs.writeFileSync(path.join(os.tmpdir(), "ravnir-outside.pdf"), "%PDF-1.4");
  await assert.rejects(read(dir, { path: "../ravnir-outside.pdf" }), /only reads files inside your workspace/);
  await assert.rejects(read(dir, { path: "/etc/hosts" }), /only reads files inside your workspace/);
  await assert.rejects(read(dir, { path: "missing.docx" }), /no file at missing\.docx/);
  fs.writeFileSync(path.join(dir, "old.xls"), "binary");
  await assert.rejects(read(dir, { path: "old.xls" }), /save it as \.xlsx/);
  fs.writeFileSync(path.join(dir, "photo.bin"), "x");
  await assert.rejects(read(dir, { path: "photo.bin" }), /not a PDF, Word, Excel or PowerPoint/);

  const bomb = new JSZip();
  bomb.file("word/document.xml", "0".repeat(61 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, "bomb.docx"), await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  await assert.rejects(read(dir, { path: "bomb.docx" }), /too large to read/);
  assert.throws(() => parseRange("x", 3), /pages must look like/);
  assert.deepEqual(parseRange("2-9,1", 4), [1, 2, 3, 4]);
});

test("agents get the tool, and an attached document points them to it", async () => {
  const dir = workspace();
  await callDocumentTool({ format: "xlsx", path: "uploads/2026-10-27/budget.xlsx", content: JSON.stringify([{ a: 1 }]) }, { workspace: dir });
  const bot = { id: "reader", name: "Reader", vault: [], skills: [] };
  const result = await callBuiltinTool("read_document", { path: "uploads/2026-10-27/budget.xlsx" }, { bot, workspace: dir });
  assert.match(result.text, /Excel, 1 sheet/);
  assert.match(attachmentNote([{ path: "uploads/2026-10-27/budget.xlsx", type: "application/octet-stream", size: 7000 }]), /read_document/);
  assert.doesNotMatch(attachmentNote([{ path: "uploads/2026-10-27/photo.png", type: "image/png", size: 7000 }]), /read_document/);
});
