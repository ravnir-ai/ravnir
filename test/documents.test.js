import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { ArtifactStore } from "../server/artifacts.js";
import { callBuiltinTool } from "../server/computer.js";
import { callDocumentTool, chartSpec, imageSize, numberFormat, outputPath } from "../server/documents.js";

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-docs-"));
  fs.copyFileSync(path.join(PROJECT, "public", "icon-192.png"), path.join(dir, "logo.png"));
  return dir;
}

const CHART = { type: "bar", title: "Revenue", unit: "€", labels: ["Jul", "Aug", "Sep"], series: [{ name: "2026", data: [12400, 9800, 14100] }] };

test("an Excel workbook keeps numbers as numbers, with formats, formulas and a totals row", async () => {
  const dir = workspace();
  const spec = {
    sheets: [{
      name: "Sales",
      columns: [
        { header: "Month", key: "month" },
        { header: "Date", key: "date", format: "date" },
        { header: "Units", key: "units", format: "integer" },
        { header: "Price (€)", key: "price", format: "currency:EUR" },
        { header: "Revenue (€)", key: "revenue", format: "currency:EUR" },
        { header: "Margin", key: "margin", format: "percent" },
      ],
      rows: [
        { month: "July", date: "2026-07-31", units: 310, price: 40, revenue: "=C2*D2", margin: 0.31 },
        { month: "August", date: "2026-08-31", units: 245, price: 40, revenue: "=C3*D3", margin: 0.28 },
      ],
      totals: { month: "Total", units: "sum", margin: "average" },
    }, { name: "Notes/Q3", rows: [["Source", "sales export"]] }],
  };
  const result = await callDocumentTool({ format: "xlsx", title: "Q3 sales", content: JSON.stringify(spec) }, { workspace: dir });
  assert.match(result.text, /Saved outputs\/q3-sales\.xlsx \(2 sheets, 3 rows/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path.join(dir, "outputs", "q3-sales.xlsx"));
  const ws = book.getWorksheet("Sales");
  assert.equal(ws.getCell("C2").value, 310);
  assert.equal(typeof ws.getCell("C2").value, "number");
  assert.ok(ws.getCell("B2").value instanceof Date);
  assert.equal(ws.getCell("D2").numFmt, numberFormat("currency:EUR"));
  assert.equal(ws.getCell("F2").numFmt, "0.0%");
  assert.equal(ws.getCell("E2").value.formula, "C2*D2");
  assert.equal(ws.getCell("A4").value, "Total");
  assert.equal(ws.getCell("C4").value.formula, "SUM(C2:C3)");
  assert.equal(ws.getCell("C4").value.result, 555, "totals carry a cached result for viewers that do not recalculate");
  assert.equal(ws.views[0].state, "frozen");
  assert.ok(book.getWorksheet("Notes Q3"), "characters Excel refuses in sheet names are replaced");
});

test("a deck has every slide, charts as pictures every app shows, and speaker notes", async () => {
  const dir = workspace();
  const deck = {
    slides: [
      { type: "title", title: "Q3", subtitle: "27 October 2026" },
      { type: "bullets", title: "Revenue beat plan", bullets: ["+12%", ["July record"]], notes: "Source: sales.xlsx" },
      { type: "chart", title: "September led", chart: { kind: "column", labels: CHART.labels, series: [{ name: "2026", values: [12.4, 9.8, 14.1] }] } },
      { type: "table", title: "Regions", columns: ["Region", "Q3"], rows: [["North", "€11.9k"]] },
      { type: "image", title: "Logo", image: "logo.png" },
    ],
  };
  const result = await callDocumentTool({ format: "pptx", path: "decks/q3", content: JSON.stringify(deck) }, { workspace: dir });
  assert.match(result.text, /Saved decks\/q3\.pptx \(5 slides/);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, "decks", "q3.pptx")));
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 5);
  assert.ok(!Object.keys(zip.files).some((name) => name.startsWith("ppt/charts/") && name.endsWith(".xml")), "no native chart unless asked");
  assert.match(await zip.file("ppt/slides/slide3.xml").async("string"), /<p:pic>/);
  assert.match(await zip.file("ppt/notesSlides/notesSlide2.xml").async("string"), /Source: sales\.xlsx/);
  assert.match(await zip.file("ppt/slides/slide2.xml").async("string"), /Revenue beat plan/);
});

test("a Word document has real headings, lists, tables, a chart and an image", async () => {
  const dir = workspace();
  const markdown = `# Proposal\n\nIntro with **bold**.\n\n## Plan\n\n- One\n  - Nested\n\n1. First\n\n| Item | Price |\n|---|---|\n| Setup | 1.200 € |\n\n> A quote.\n\n\`\`\`chart\n${JSON.stringify(CHART)}\n\`\`\`\n\n![Logo](logo.png)\n\n\\pagebreak\n\n## Annex\n`;
  const result = await callDocumentTool({ format: "docx", content: markdown, options: { author: "Ana" } }, { workspace: dir });
  assert.match(result.text, /Saved outputs\/document\.docx \(3 headings, 1 table/);
  assert.doesNotMatch(result.text, /Note:/);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, "outputs", "document.docx")));
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /<w:numPr>/);
  assert.match(xml, /w:type="page"/);
  assert.equal(Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !name.endsWith("/")).length, 2, "the chart and the logo");
});

test("a PDF from Markdown draws charts and loads workspace images, and nothing from the web", async () => {
  const dir = workspace();
  const markdown = `# Brief\n\nText.\n\n\`\`\`chart\n${JSON.stringify(CHART)}\n\`\`\`\n\n![Logo](logo.png)\n\n![Remote](https://example.com/x.png)\n\n\\pagebreak\n\n## Next\n`;
  const result = await callDocumentTool({ format: "pdf", content: markdown }, { workspace: dir });
  assert.match(result.text, /\(2 pages,/);
  assert.match(result.text, /Note: Not loaded \(no web access while rendering\): https:\/\/example\.com\/x\.png/);
  const pdf = fs.readFileSync(path.join(dir, "outputs", "document.pdf"));
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");

  const html = `<!doctype html><html><head><style>@page { size: A5; }</style></head><body><h1>Invoice</h1><img src="logo.png"><img src="https://example.com/track.gif"><script>document.body.innerHTML = "ran"</script></body></html>`;
  const page = await callDocumentTool({ format: "pdf", path: "invoice.pdf", content: html }, { workspace: dir });
  assert.match(page.text, /Saved invoice\.pdf \(1 page,/);
  assert.match(page.text, /Not loaded \(no web access while rendering\): https:\/\/example\.com\/track\.gif/);
});

test("a bad chart is reported instead of failing the whole document", async () => {
  const dir = workspace();
  const result = await callDocumentTool({ format: "pdf", content: "# T\n\n```chart\n{\"type\":\"bar\",\"labels\":[\"a\"],\"series\":[{\"name\":\"x\",\"data\":[1,2]}]}\n```\n" }, { workspace: dir });
  assert.match(result.text, /Note: Chart 1: Series "x" has 2 values but there are 1 labels/);
});

test("files stay inside the workspace", async () => {
  const dir = workspace();
  assert.throws(() => outputPath(dir, "../escape.pdf", "", "pdf"), /inside your workspace/);
  assert.throws(() => outputPath(dir, "/etc/x.pdf", "", "pdf"), /inside your workspace/);
  fs.symlinkSync(os.tmpdir(), path.join(dir, "out"));
  assert.throws(() => outputPath(dir, "out/x.pdf", "", "pdf"), /leaves your workspace/);
  assert.equal(outputPath(dir, "reports/q3", "", "pdf").relative, "reports/q3.pdf");
  assert.equal(outputPath(dir, "reports/q3.docx", "", "pdf").relative, "reports/q3.pdf", "the extension follows the format");
  fs.writeFileSync(path.join(os.tmpdir(), "ravnir-outside.png"), fs.readFileSync(path.join(dir, "logo.png")));
  const deck = { slides: [{ type: "image", image: "../ravnir-outside.png" }] };
  const result = await callDocumentTool({ format: "pptx", content: JSON.stringify(deck) }, { workspace: dir });
  assert.match(result.text, /Note: Slide 1: Image \.\.\/ravnir-outside\.png: give a path inside your workspace/);
  await assert.rejects(callDocumentTool({ format: "xlsx", content: "not json" }, { workspace: dir }), /JSON spec/);
  await assert.rejects(callDocumentTool({ format: "odt", content: "x" }, { workspace: dir }), /format must be one of/);
});

test("make_document shares the file as a card under the reply", async () => {
  const dir = workspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-docs-home-"));
  const noted = [];
  const engine = { artifacts: new ArtifactStore(home), active: new Map(), noteArtifact: (bot, meta) => noted.push(meta) };
  const bot = { id: "doc-bot", name: "Docs", vault: [], skills: [] };
  const result = await callBuiltinTool("make_document", { format: "xlsx", title: "Leads", content: JSON.stringify([{ name: "Acme", size: 40 }]) }, { bot, workspace: dir, engine });
  assert.match(result.text, /Shared it as "Leads"/);
  assert.equal(noted.length, 1);
  assert.equal(noted[0].kind, "file");
  assert.equal(noted[0].filename, "leads.xlsx");
});

test("helpers read image sizes from headers and accept the chart names models reach for", () => {
  const png = fs.readFileSync(path.join(PROJECT, "public", "icon-192.png"));
  assert.deepEqual(imageSize(png, "png"), { width: 192, height: 192 });
  assert.equal(imageSize(Buffer.from("not an image"), "png"), null);
  assert.deepEqual(chartSpec({ kind: "doughnut", labels: [1, 2], series: [{ name: "a", values: ["3", 4] }] }), { type: "donut", labels: ["1", "2"], series: [{ name: "a", data: [3, 4] }] });
  assert.equal(chartSpec({ kind: "bar", horizontal: true, labels: [], series: [] }).type, "hbar");
});
