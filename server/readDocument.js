import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// read_document turns a PDF, Word, Excel or PowerPoint file in the agent's workspace (an upload, a
// download, something it made) into text the model can use: headings, lists and tables kept, sheets
// as tables with formulas, slides with their notes and chart data. It runs on the server, so it works
// for every provider and needs nothing in the agent's shell. Long files come back in parts.

const FILE_LIMIT = 30 * 1024 * 1024;
const UNZIPPED_LIMIT = 300 * 1024 * 1024; // all parts together, so a zip bomb is refused before parsing
const PART_LIMIT = 60 * 1024 * 1024;
const DEFAULT_CHARS = 40_000;
const MAX_CHARS = 120_000;
const TEXT_TYPES = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".log", ".yaml", ".yml"]);
const OLD_FORMATS = { ".doc": "docx", ".xls": "xlsx", ".ppt": "pptx" };

export function readDocumentToolDefinitions() {
  return [{
    name: "read_document",
    description: "Read a PDF, Word (docx), Excel (xlsx) or PowerPoint (pptx) file in your workspace, such as one the user attached: text with headings, lists and tables, every sheet with values and formulas, slides with notes and chart data. Long files come back in parts and the reply says how to get the next one. It needs no approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file inside your workspace, like uploads/2026-10-27/budget.xlsx." },
        sheet: { type: "string", description: "Excel: the sheet to read. Default: every sheet, in order." },
        from_row: { type: "integer", description: "Excel: first row to show, for the next part of a long sheet." },
        pages: { type: "string", description: "PDF pages or PowerPoint slides, like \"3\" or \"5-12\"." },
        start: { type: "integer", description: "Word: character to start from, for the next part of a long document." },
        max_chars: { type: "integer", description: `How much text to return, ${DEFAULT_CHARS} by default, at most ${MAX_CHARS}.` },
      },
      required: ["path"],
      additionalProperties: false,
    },
  }];
}

export async function callReadDocument(args, { workspace }) {
  const file = insideWorkspace(workspace, args.path);
  const stat = fs.statSync(file.full);
  if (!stat.isFile()) throw new Error(`${file.relative} is a folder, not a file.`);
  if (stat.size > FILE_LIMIT) throw new Error(`${file.relative} is over 30 MB.`);
  const budget = Math.min(MAX_CHARS, Math.max(2000, Number(args.max_chars) || DEFAULT_CHARS));
  const ext = path.extname(file.full).toLowerCase();
  const data = fs.readFileSync(file.full);
  const head = data.subarray(0, 5).toString("latin1");
  let result;
  if (OLD_FORMATS[ext]) {
    throw new Error(`${file.relative} is in the old ${ext} format, which this tool does not read. Ask the user to save it as .${OLD_FORMATS[ext]} (File, Save As) and send it again.`);
  } else if (head.startsWith("%PDF")) {
    result = await readPdf(data, { pages: args.pages, budget });
  } else if (head.startsWith("PK")) {
    const zip = await openZip(data);
    if (zip.file("xl/workbook.xml")) result = await readXlsx(data, { sheet: args.sheet, fromRow: args.from_row, budget });
    else if (zip.file("word/document.xml")) result = await readDocx(zip, { start: args.start, budget });
    else if (zip.file("ppt/presentation.xml")) result = await readPptx(zip, { pages: args.pages, budget });
    else throw new Error(`${file.relative} is a zip file but not a Word, Excel or PowerPoint document.`);
  } else if (TEXT_TYPES.has(ext)) {
    result = cut(data.toString("utf8"), Number(args.start) || 0, budget, "text");
  } else {
    throw new Error(`${file.relative} is not a PDF, Word, Excel or PowerPoint file. Use read_file for plain text.`);
  }
  return { text: `${file.relative}: ${result.summary}\n\n${result.text}`.trim(), activity: `Reading ${path.basename(file.relative)}` };
}

function insideWorkspace(workspace, requested) {
  const root = fs.realpathSync(workspace);
  const relative = String(requested || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relative) throw new Error("Give the path of a file in your workspace.");
  const target = path.isAbsolute(relative) ? relative : path.resolve(root, relative);
  let full;
  try {
    full = fs.realpathSync(target);
  } catch {
    throw new Error(`There is no file at ${relative} in your workspace.`);
  }
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("read_document only reads files inside your workspace.");
  return { full, relative: path.relative(root, full).split(path.sep).join("/") };
}

async function openZip(data) {
  const zip = await JSZip.loadAsync(data);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const size = entry._data?.uncompressedSize || 0;
    if (size > PART_LIMIT) throw new Error("A part of this file unpacks to over 60 MB; it is too large to read.");
    total += size;
  }
  if (total > UNZIPPED_LIMIT) throw new Error("This file unpacks to over 300 MB; it is too large to read.");
  return zip;
}

// Keeps whole lines under the budget and says where the next part starts.
function cut(text, start, budget, unit) {
  const from = Math.max(0, Math.min(start, text.length));
  if (text.length - from <= budget) return { text: text.slice(from), summary: from ? `characters ${from} to ${text.length} of ${text.length}` : `${text.length} characters` };
  let end = text.lastIndexOf("\n", from + budget);
  if (end <= from) end = from + budget;
  return {
    text: `${text.slice(from, end)}\n\n[Part shown: characters ${from} to ${end} of ${text.length}. Read on with {"start": ${end}}.]`,
    summary: `${unit}, ${text.length} characters, part from ${from}`,
  };
}

// "3", "5-12", "1,4-6" into sorted numbers within 1..count.
export function parseRange(spec, count) {
  if (!spec) return null;
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error(`pages must look like "3", "5-12" or "1,4-6", not "${spec}".`);
    const a = Number(match[1]);
    const b = match[2] ? Number(match[2]) : a;
    for (let n = Math.max(1, Math.min(a, b)); n <= Math.min(count, Math.max(a, b)); n += 1) out.add(n);
  }
  if (!out.size) throw new Error(`There is nothing in ${spec}; the file has ${count}.`);
  return [...out].sort((x, y) => x - y);
}

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

function cell(text) {
  return String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function table(rows) {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => [...row, ...Array(width - row.length).fill("")];
  const [first, ...rest] = rows.map(pad);
  return [`| ${first.map(cell).join(" | ")} |`, `|${" --- |".repeat(width)}`, ...rest.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

// --- PDF --------------------------------------------------------------------------------------------

async function readPdf(data, { pages, budget }) {
  const task = getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const wanted = parseRange(pages, doc.numPages) || Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const parts = [];
    let used = 0;
    let shown = 0;
    let bare = 0;
    for (const number of wanted) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => `${item.str || ""}${item.hasEOL ? "\n" : ""}`).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      // A page number footer is all a scanned page has; real text pages have more than that.
      if (text.replace(/[\s\d/]/g, "").length < 5) bare += 1;
      const block = `--- Page ${number} ---\n${text || "(no text on this page)"}`;
      if (used + block.length > budget && shown) {
        const next = wanted[wanted.indexOf(number)];
        parts.push(`[Shown up to page ${wanted[wanted.indexOf(number) - 1]}. Read on with {"pages": "${next}-${doc.numPages}"}.]`);
        break;
      }
      parts.push(block.length > budget ? `${block.slice(0, budget)}\n[Page ${number} is cut here; it is very long.]` : block);
      used += block.length;
      shown += 1;
    }
    const scanned = shown > 0 && bare > shown / 2;
    const summary = `PDF, ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}${pages ? `, pages ${pages}` : ""}`;
    const note = scanned ? "\n\n[Almost no text was found: this is probably a scan or a picture of text. To read it, convert the pages to images and run OCR (for example pdftoppm and tesseract with run_command), or ask the user for a text version.]" : "";
    return { summary, text: parts.join("\n\n") + note };
  } finally {
    await task.destroy();
  }
}

// --- Excel ------------------------------------------------------------------------------------------

function excelValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().replace(/T00:00:00\.000Z$/, "").replace(/\.000Z$/, "Z");
  if (typeof value !== "object") return String(value);
  if ("formula" in value || "sharedFormula" in value) {
    const result = excelValue(value.result);
    return `${result}${result ? " " : ""}(=${value.formula || value.sharedFormula})`;
  }
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return String(value.text?.richText ? value.text.richText.map((part) => part.text).join("") : value.text);
  if ("error" in value) return String(value.error);
  return String(value);
}

async function readXlsx(data, { sheet, fromRow, budget }) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(data);
  const sheets = book.worksheets.filter((ws) => ws.state !== "veryHidden");
  const overview = sheets.map((ws) => `${ws.name} (${ws.actualRowCount} rows, ${ws.actualColumnCount} columns${ws.state === "hidden" ? ", hidden" : ""})`);
  let targets = sheets;
  if (sheet) {
    const found = sheets.find((ws) => ws.name.toLowerCase() === String(sheet).toLowerCase());
    if (!found) throw new Error(`There is no sheet "${sheet}". The sheets are: ${sheets.map((ws) => ws.name).join(", ")}.`);
    targets = [found];
  }
  const parts = [];
  let used = 0;
  for (const ws of targets) {
    const start = Math.max(1, Number(fromRow) || 1);
    const rows = [];
    let next = 0;
    let size = 0;
    ws.eachRow({ includeEmpty: false }, (row, number) => {
      if (number < start || next) return;
      const values = [String(number)];
      for (let col = 1; col <= ws.actualColumnCount || col <= row.cellCount; col += 1) values.push(excelValue(row.getCell(col).value));
      const line = values.join(" | ").length + 4;
      if (used + size + line > budget && rows.length) { next = number; return; }
      rows.push(values);
      size += line;
    });
    const letters = ["#", ...Array.from({ length: Math.max(0, ...rows.map((row) => row.length - 1)) }, (_, i) => ws.getColumn(i + 1).letter)];
    const merged = Object.keys(ws._merges || {}).length;
    let block = `## Sheet ${ws.name}\n${rows.length ? table([letters, ...rows]) : "(empty)"}`;
    if (merged) block += `\n(${merged} merged cell range${merged === 1 ? "" : "s"}; a merged value shows in its first cell.)`;
    if (next) block += `\n\n[Rows from ${next} are not shown. Read on with {"sheet": "${ws.name}", "from_row": ${next}}.]`;
    parts.push(block);
    used += size;
    if (used >= budget) {
      const rest = targets.slice(targets.indexOf(ws) + 1);
      if (rest.length) parts.push(`[Sheets not shown: ${rest.map((item) => item.name).join(", ")}. Read one with {"sheet": "${rest[0].name}"}.]`);
      break;
    }
  }
  return {
    summary: `Excel, ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}: ${overview.join("; ")}. Row numbers are the first column; a formula shows as value (=formula).`,
    text: parts.join("\n\n"),
  };
}

// --- Word -------------------------------------------------------------------------------------------

async function headingStyles(zip) {
  const levels = new Map();
  const xml = await zip.file("word/styles.xml")?.async("string");
  if (!xml) return levels;
  for (const match of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = /<w:name w:val="([^"]+)"/.exec(match[2])?.[1] || "";
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(match[2])?.[1];
    const level = /^(heading|título|titulo|überschrift|titre)\s*(\d)$/i.exec(name)?.[2] || (outline !== undefined ? Number(outline) + 1 : 0);
    if (/^title$|^título$/i.test(name)) levels.set(match[1], 1);
    else if (level) levels.set(match[1], Math.min(6, Number(level)));
  }
  return levels;
}

function runText(xml) {
  return decodeXml(String(xml)
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_, text) => text ?? ""));
}

// numId and level to "bullet" or "decimal" (or another counting format), from word/numbering.xml.
async function listFormats(zip) {
  const xml = await zip.file("word/numbering.xml")?.async("string");
  const abstract = new Map();
  const formats = new Map();
  if (!xml) return formats;
  for (const match of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map();
    for (const lvl of match[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) levels.set(lvl[1], /<w:numFmt w:val="([^"]+)"/.exec(lvl[2])?.[1] || "bullet");
    abstract.set(match[1], levels);
  }
  for (const match of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"/g)) formats.set(match[1], abstract.get(match[2]) || new Map());
  return formats;
}

function paragraph(xml, ctx) {
  const text = runText(xml).trim();
  if (!text) return "";
  const style = /<w:pStyle w:val="([^"]+)"/.exec(xml)?.[1];
  const level = ctx.levels.get(style) || (/^(Heading|Ttulo|Titulo)(\d)$/i.exec(style || "")?.[2] ? Number(/(\d)$/.exec(style)[1]) : 0);
  if (level) return `${"#".repeat(level)} ${text}`;
  if (/<w:numPr>/.test(xml)) {
    const depth = /<w:ilvl w:val="(\d+)"/.exec(xml)?.[1] || "0";
    const numId = /<w:numId w:val="(\d+)"/.exec(xml)?.[1] || "";
    const format = ctx.lists.get(numId)?.get(depth) || "bullet";
    if (format === "bullet" || format === "none") return `${"  ".repeat(Number(depth))}- ${text}`;
    const key = `${numId}:${depth}`;
    ctx.counters.set(key, (ctx.counters.get(key) || 0) + 1);
    for (const other of ctx.counters.keys()) if (other.startsWith(`${numId}:`) && Number(other.split(":")[1]) > Number(depth)) ctx.counters.delete(other);
    return `${"  ".repeat(Number(depth))}${ctx.counters.get(key)}. ${text}`;
  }
  return text;
}

async function readDocx(zip, { start, budget }) {
  const xml = await zip.file("word/document.xml").async("string");
  const ctx = { levels: await headingStyles(zip), lists: await listFormats(zip), counters: new Map() };
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] || xml;
  const blocks = [];
  let tables = 0;
  for (const match of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:p>)/g)) {
    const part = match[0];
    if (part.startsWith("<w:tbl>")) {
      tables += 1;
      const rows = [...part.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((row) => [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => runText(tc[0]).trim()));
      if (rows.length) blocks.push(table(rows));
    } else {
      if (/<w:br w:type="page"\/>/.test(part)) blocks.push("---");
      const text = paragraph(part, ctx);
      // List items stay together, one per line.
      if (text && /^\s*(- |\d+\. )/.test(text) && /^\s*(- |\d+\. )/.test(blocks.at(-1)?.split("\n").at(-1) || "")) blocks[blocks.length - 1] += `\n${text}`;
      else if (text) blocks.push(text);
    }
  }
  const text = blocks.join("\n\n");
  const result = cut(text, Number(start) || 0, Math.max(budget, 2000), "Word");
  const headings = blocks.filter((block) => /^#{1,6} /.test(block)).length;
  return { summary: `Word, ${headings} heading${headings === 1 ? "" : "s"}, ${tables} table${tables === 1 ? "" : "s"}, ${result.summary}`, text: result.text };
}

// --- PowerPoint ---------------------------------------------------------------------------------------

function rels(xml) {
  const map = new Map();
  for (const match of String(xml || "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(match[0])?.[1];
    const target = /Target="([^"]+)"/.exec(match[0])?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

function resolveTarget(from, target) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
}

function drawingText(xml) {
  return [...String(xml).matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g)]
    .map((p) => {
      const text = decodeXml([...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\/>/g)].map((m) => m[1] ?? "\n").join("")).trim();
      const level = Number(/<a:pPr[^>]*lvl="(\d)"/.exec(p[0])?.[1] || 0);
      return text ? `${"  ".repeat(level)}${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function chartData(zip, file) {
  const xml = await zip.file(file)?.async("string");
  if (!xml) return "";
  const series = [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((ser) => {
    const name = decodeXml(/<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/.exec(ser[0])?.[1] || "series");
    const points = (tag) => [...(new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`).exec(ser[0])?.[1] || "").matchAll(/<c:pt idx="(\d+)">\s*<c:v>([\s\S]*?)<\/c:v>/g)].map((m) => decodeXml(m[2]));
    return { name, labels: points("cat"), values: points("val") };
  });
  if (!series.length) return "[chart]";
  const labels = series[0].labels;
  return `Chart data:\n${table([["", ...series.map((s) => s.name)], ...labels.map((label, i) => [label, ...series.map((s) => s.values[i] ?? "")])])}`;
}

async function readPptx(zip, { pages, budget }) {
  const presentation = await zip.file("ppt/presentation.xml").async("string");
  const presRels = rels(await zip.file("ppt/_rels/presentation.xml.rels")?.async("string"));
  const order = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => resolveTarget("ppt/presentation.xml", presRels.get(m[1]) || "")).filter((file) => zip.file(file));
  const wanted = parseRange(pages, order.length) || order.map((_, i) => i + 1);
  const parts = [];
  let used = 0;
  for (const number of wanted) {
    const file = order[number - 1];
    const xml = await zip.file(file).async("string");
    const slideRels = rels(await zip.file(file.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels"))?.async("string"));
    const lines = [];
    let title = "";
    for (const shape of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>|<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>|<p:pic>[\s\S]*?<\/p:pic>/g)) {
      const part = shape[0];
      if (part.startsWith("<p:pic>")) {
        const alt = decodeXml(/<p:cNvPr[^>]*descr="([^"]*)"/.exec(part)?.[1] || "");
        lines.push(`[picture${alt && !/^[\w.-]+\.(png|jpe?g|gif|svg|emf|wmf)$/i.test(alt) ? `: ${alt}` : ""}]`);
      } else if (part.startsWith("<p:graphicFrame>")) {
        if (/<a:tbl>/.test(part)) {
          lines.push(table([...part.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((row) => [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) => drawingText(tc[0]).replace(/\n/g, " ")))));
        } else {
          const rid = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(part)?.[1];
          lines.push(rid && slideRels.get(rid) ? await chartData(zip, resolveTarget(file, slideRels.get(rid))) : "[chart or diagram]");
        }
      } else {
        const text = drawingText(part);
        if (!text) continue;
        if (!title && /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(part)) title = text.replace(/\n/g, " ");
        else if (/<p:ph\b[^>]*type="sldNum"/.test(part) || text.trim() === String(number)) continue;
        else lines.push(text);
      }
    }
    const notesFile = [...slideRels.values()].find((target) => /notesSlide/.test(target));
    let notes = "";
    if (notesFile) {
      const notesXml = await zip.file(resolveTarget(file, notesFile))?.async("string");
      notes = [...(notesXml || "").matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].filter((sp) => /<p:ph\b[^>]*type="body"/.test(sp[0])).map((sp) => drawingText(sp[0])).join("\n").trim();
    }
    const block = [`--- Slide ${number}${title ? `: ${title}` : ""} ---`, ...lines, notes ? `Notes: ${notes}` : ""].filter(Boolean).join("\n");
    if (used + block.length > budget && parts.length) {
      parts.push(`[Shown up to slide ${number - 1}. Read on with {"pages": "${number}-${order.length}"}.]`);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return { summary: `PowerPoint, ${order.length} slide${order.length === 1 ? "" : "s"}${pages ? `, slides ${pages}` : ""}`, text: parts.join("\n\n") };
}
