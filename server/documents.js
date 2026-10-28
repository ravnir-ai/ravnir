import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { marked } from "marked";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer,
  PageBreak, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { findChromium } from "./browser.js";
import { childEnv } from "./childEnv.js";

// make_document turns what an agent wrote (Markdown, HTML or a JSON spec) into a real file in its
// workspace: PDF, Word, Excel or PowerPoint. The server does the rendering, so it works the same for
// every provider and for agents on their own computer (the workspace is mounted at the same path),
// and nothing has to be installed in the agent's shell. The skills in skills/documents/ teach the
// content formats and what a good file looks like.

export const FORMATS = ["pdf", "docx", "xlsx", "pptx"];
const CONTENT_LIMIT = 1_000_000;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const IMAGE_TYPES = { ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".gif": "gif" };
const PDF_HOST = "https://document.local/";

export function documentToolDefinitions() {
  return [{
    name: "make_document",
    description: "Make a PDF, Word (docx), Excel (xlsx) or PowerPoint (pptx) file in your workspace and share it with the user as a card. pdf and docx take Markdown (pdf also takes a full HTML page); xlsx and pptx take a JSON spec. Open the matching documents skill first for the format and what a good file looks like. It needs no approval.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: FORMATS },
        path: { type: "string", description: "Where to save it inside your workspace, like outputs/report.pdf. Defaults to outputs/<title>." },
        title: { type: "string" },
        content: { type: "string", description: "Markdown, HTML, or the JSON spec as a string." },
        options: { type: "object", description: "Format options from the skill, for example {\"landscape\": true}." },
        share: { type: "boolean", description: "Show it to the user as a card. Default true." },
      },
      required: ["format", "content"],
      additionalProperties: false,
    },
  }];
}

export async function callDocumentTool(args, { workspace, share }) {
  const format = String(args.format || "").toLowerCase().replace(/^\./, "");
  if (!FORMATS.includes(format)) throw new Error(`format must be one of ${FORMATS.join(", ")}.`);
  const content = String(args.content ?? "");
  if (!content.trim()) throw new Error("content is empty.");
  if (content.length > CONTENT_LIMIT) throw new Error("content is over 1 MB. Split it into several files.");
  const title = String(args.title || "").trim().slice(0, 200);
  const options = args.options && typeof args.options === "object" && !Array.isArray(args.options) ? args.options : {};
  const out = outputPath(workspace, args.path, title, format);
  const files = workspaceFiles(workspace);
  const result = await RENDERERS[format]({ content, title, options, files });
  fs.mkdirSync(path.dirname(out.full), { recursive: true });
  fs.writeFileSync(out.full, result.buffer);
  const size = formatSize(result.buffer.length);
  const lines = [`Saved ${out.relative} (${[result.summary, size].filter(Boolean).join(", ")}).`];
  if (result.warnings?.length) lines.push(...result.warnings.map((item) => `Note: ${item}`));
  let activity = `Made ${out.relative}`;
  if (args.share !== false && share) {
    const meta = share(out.relative, title || path.basename(out.relative));
    lines.push(`Shared it as "${meta.title}". The user sees it as a card under your reply, so do not paste the content into the chat; say in a sentence what it is and what to look at.`);
    activity = `Made and shared ${out.relative}`;
  } else {
    lines.push(`Share it with share_file {"path": "${out.relative}"} when it is ready.`);
  }
  return { text: lines.join("\n"), activity };
}

// --- paths ------------------------------------------------------------------------------------

function slug(text) {
  return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export function outputPath(workspace, requested, title, format) {
  const root = fs.realpathSync(workspace);
  let relative = String(requested || "").trim().replace(/\\/g, "/");
  if (!relative) relative = `outputs/${slug(title) || "document"}.${format}`;
  if (path.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error("Give a path inside your workspace, like outputs/report.pdf.");
  }
  if (!relative.toLowerCase().endsWith(`.${format}`)) relative = `${relative.replace(/\.[a-z0-9]{2,5}$/i, "")}.${format}`;
  const full = path.resolve(root, relative);
  // The nearest folder that exists must still be inside the workspace (no links out of it).
  let probe = path.dirname(full);
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("That path leaves your workspace.");
  if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) throw new Error("That path is a link; pick another name.");
  return { full, relative: path.relative(root, full).split(path.sep).join("/") };
}

// Reads images the document refers to, only from inside the workspace and only real PNG, JPEG or GIF.
function workspaceFiles(workspace) {
  const root = fs.realpathSync(workspace);
  return {
    image(ref) {
      const name = String(ref || "").trim().replace(/^\.\//, "");
      if (!name || /^[a-z]+:/i.test(name) || path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
        throw new Error(`Image ${ref}: give a path inside your workspace, like charts/sales.png (web addresses are not fetched).`);
      }
      const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
      if (!type) throw new Error(`Image ${ref}: use a PNG, JPEG or GIF.`);
      let real;
      try {
        real = fs.realpathSync(path.resolve(root, name));
      } catch {
        throw new Error(`Image ${ref}: there is no such file in your workspace.`);
      }
      if (!real.startsWith(root + path.sep)) throw new Error(`Image ${ref} is outside your workspace.`);
      if (fs.statSync(real).size > IMAGE_LIMIT) throw new Error(`Image ${ref} is over 10 MB.`);
      const data = fs.readFileSync(real);
      const size = imageSize(data, type);
      if (!size) throw new Error(`Image ${ref} is not a readable ${type.toUpperCase()}.`);
      return { data, type, ...size };
    },
  };
}

// Width and height from the file header, so no image parser runs on agent-supplied files.
export function imageSize(data, type) {
  if (type === "png" && data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (type === "gif" && data.length > 10 && data.toString("ascii", 0, 3) === "GIF") {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (type === "jpg" && data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) { at += 1; continue; }
      const marker = data[at + 1];
      const length = data.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseJson(content, what) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`content must be the ${what} JSON spec: ${error.message}. Open the matching documents skill for the format.`);
  }
}

function color(value, fallback) {
  const hex = String(value || "").trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : fallback;
}

// --- PDF ----------------------------------------------------------------------------------------

const PDF_STYLE = `
@page { margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1d1d1f; margin: 0; }
h1, h2, h3, h4 { line-height: 1.2; margin: 1.4em 0 0.5em; break-after: avoid; color: #111; }
h1 { font-size: 22pt; margin-top: 0; letter-spacing: -0.01em; }
h2 { font-size: 15pt; padding-bottom: 4px; border-bottom: 1px solid #e3e3e8; }
h3 { font-size: 12pt; }
p, ul, ol, table, blockquote, pre { margin: 0 0 0.8em; }
a { color: var(--accent); text-decoration: none; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.15em 0; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; break-inside: auto; }
tr { break-inside: avoid; }
th { text-align: left; background: #f2f2f5; font-weight: 600; }
th, td { padding: 5px 8px; border-bottom: 1px solid #e3e3e8; vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
blockquote { border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; color: #555; }
code { font-family: "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace; font-size: 9pt; background: #f2f2f5; padding: 1px 4px; border-radius: 3px; }
pre { background: #f6f6f8; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #e3e3e8; margin: 1.4em 0; }
.pagebreak { break-after: page; }
.doc-title { font-size: 26pt; font-weight: 700; margin: 0 0 4px; }
.doc-subtitle { color: #6e6e73; margin: 0 0 18px; }
`;

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

// ```chart blocks use the same JSON spec as charts in chat (public/charts.js).
function chartBlocks(markdown) {
  const specs = [];
  const text = String(markdown).replace(/^```chart[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm, (_, json) => {
    specs.push(json);
    return `<!-- ravnir-chart ${specs.length - 1} -->`;
  });
  return { text, specs };
}

export function markdownToHtml(markdown, { title = "", options = {}, charts = [] } = {}) {
  const accent = `#${color(options.accent, "2F5DA8")}`;
  const source = String(markdown).replace(/^[ \t]*(\\pagebreak|<!--\s*pagebreak\s*-->)[ \t]*$/gim, '<div class="pagebreak"></div>');
  let body = marked.parse(source, { gfm: true, async: false });
  // Right-align table cells that hold a number, so columns of figures line up.
  body = body.replace(/<td>(\s*[-+(]?[$€£]?\s?[\d.,]+%?\)?\s*[$€£%]?\s*)<\/td>/g, '<td class="num">$1</td>');
  body = body.replace(/<!-- ravnir-chart (\d+) -->/g, (_, i) => {
    const chart = charts[Number(i)];
    return chart?.html ? `<div class="chart">${chart.html}</div>` : `<p class="chart-error">Chart ${Number(i) + 1}: ${escapeHtml(chart?.error || "not drawn")}</p>`;
  });
  const head = options.cover !== false && title && !/^\s*#\s/.test(markdown)
    ? `<p class="doc-title">${escapeHtml(title)}</p>${options.subtitle ? `<p class="doc-subtitle">${escapeHtml(options.subtitle)}</p>` : ""}`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${PDF_HOST}"><title>${escapeHtml(title || "Document")}</title>
<style>:root { --accent: ${accent}; }${PDF_STYLE}${charts.length ? chartStyle() : ""}</style></head><body>${head}${body}</body></html>`;
}

async function launch() {
  const executable = findChromium();
  const args = ["--no-first-run", "--disable-dev-shm-usage"];
  if (process.env.RAVNIR_CHROMIUM_NO_SANDBOX === "1") args.push("--no-sandbox");
  return chromium.launch({ ...(executable ? { executablePath: executable } : {}), headless: true, args, env: childEnv(), timeout: 30_000 });
}

const PUBLIC_DIR = new URL("../public/", import.meta.url);
let chartAssets = null;
function chartStyle() {
  chartAssets ||= { css: fs.readFileSync(new URL("charts.css", PUBLIC_DIR), "utf8"), js: fs.readFileSync(new URL("charts.js", PUBLIC_DIR), "utf8") };
  // Print colors: light theme only, no hover tip, no "show data" table.
  return `${chartAssets.css.replace(/@media \(prefers-color-scheme: dark\)[\s\S]*?\n}\n/, "")}
:root { --text: #1d1d1f; --muted: #6e6e73; --faint: #8e8e93; --surface: #ffffff; --line: #e3e3e8; }
.tb-chart .tb-data, .tb-chart .tb-tip { display: none !important; }
.tb-chart, .tb-chart * { animation: none !important; transition: none !important; }
.tb-chart { padding: 4px 6px 4px 18px; background: #fff; }
.tb-chart svg { overflow: visible; }
.chart { margin: 0.6em 0 1.2em; break-inside: avoid; }
.chart-error { color: #b42318; font-size: 9pt; }`;
}

// Draws each chart spec with the chat's own renderer in a page with no network, and returns the
// static figure (for PDF, vector) and a PNG of it (for Word and PowerPoint).
export async function renderCharts(specs, { browser, width = 680, scale = 2, png = true } = {}) {
  if (!specs.length) return [];
  chartStyle();
  const own = !browser;
  browser ||= await launch();
  try {
    const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: width + 40, height: 800 } });
    await context.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${chartStyle()}
body { margin: 0; padding: 20px; background: #fff; font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; }
#slot { width: ${width}px; }</style></head><body><div id="slot"></div></body></html>`);
    await page.addScriptTag({ content: chartAssets.js });
    const out = [];
    for (const spec of specs) {
      const drawn = await page.evaluate((input) => {
        const slot = document.getElementById("slot");
        slot.replaceChildren();
        const check = window.RavnirCharts.normalize(input);
        if (!check.ok) return { error: check.error };
        window.RavnirCharts.render(slot, input);
        const figure = slot.querySelector(".tb-chart");
        figure.querySelectorAll(".tb-data, .tb-tip").forEach((node) => node.remove());
        return { html: figure.outerHTML };
      }, typeof spec === "string" ? spec : JSON.stringify(spec));
      if (drawn.error) { out.push({ error: drawn.error }); continue; }
      if (png) {
        const box = await page.locator("#slot .tb-chart").boundingBox();
        drawn.png = await page.locator("#slot .tb-chart").screenshot({ type: "png", omitBackground: false });
        drawn.width = Math.round(box.width);
        drawn.height = Math.round(box.height);
      }
      out.push(drawn);
    }
    await context.close();
    return out;
  } finally {
    if (own) await browser.close().catch(() => {});
  }
}

async function renderPdf({ content, title, options, files }) {
  const browser = await launch();
  const warnings = [];
  try {
    let html = content;
    if (!/^\s*(<!doctype|<html)/i.test(content)) {
      const { text, specs } = chartBlocks(content);
      const charts = await renderCharts(specs, { browser, png: false });
      charts.forEach((chart, i) => chart.error && warnings.push(`Chart ${i + 1}: ${chart.error}`));
      html = markdownToHtml(text, { title, options, charts });
    }
    // No scripts and no network: the page can only load workspace images, through PDF_HOST.
    const context = await browser.newContext({ javaScriptEnabled: false, offline: false });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:")) return route.continue();
      if (url.startsWith(PDF_HOST)) {
        try {
          const image = files.image(decodeURIComponent(url.slice(PDF_HOST.length).split(/[?#]/)[0]));
          return route.fulfill({ status: 200, contentType: `image/${image.type === "jpg" ? "jpeg" : image.type}`, body: image.data });
        } catch (error) {
          warnings.push(error.message);
          return route.abort();
        }
      }
      if (!/^https?:/.test(url)) return route.abort();
      warnings.push(`Not loaded (no web access while rendering): ${url.slice(0, 120)}`);
      return route.abort();
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const footer = options.pageNumbers === false ? "<span></span>"
      : '<div style="width:100%;font-size:8px;color:#888;padding:0 16mm;text-align:right;font-family:Helvetica,Arial,sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';
    const buffer = await page.pdf({
      format: /^letter$/i.test(options.pageSize) ? "Letter" : "A4",
      landscape: Boolean(options.landscape),
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: footer,
    });
    const pages = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    return { buffer, summary: `${pages} page${pages === 1 ? "" : "s"}`, warnings: [...new Set(warnings)] };
  } finally {
    await browser.close().catch(() => {});
  }
}

// --- Word -----------------------------------------------------------------------------------------

function inlineRuns(tokens = [], style = {}, ctx) {
  const out = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong": out.push(...inlineRuns(token.tokens, { ...style, bold: true }, ctx)); break;
      case "em": out.push(...inlineRuns(token.tokens, { ...style, italics: true }, ctx)); break;
      case "del": out.push(...inlineRuns(token.tokens, { ...style, strike: true }, ctx)); break;
      case "codespan": out.push(new TextRun({ ...style, text: decode(token.text), font: "Consolas", shading: { type: ShadingType.CLEAR, fill: "F2F2F5" } })); break;
      case "br": out.push(new TextRun({ break: 1 })); break;
      case "link": out.push(new ExternalHyperlink({ link: token.href, children: inlineRuns(token.tokens, { ...style, color: ctx.accent, underline: {} }, ctx) })); break;
      case "image": out.push(imageRun(token.href, ctx, token.text)); break;
      case "text": case "escape": case "html":
        if (token.tokens?.length) out.push(...inlineRuns(token.tokens, style, ctx));
        else if (!/^\s*<!--/.test(token.text)) out.push(new TextRun({ ...style, text: decode(token.text) }));
        break;
      default: if (token.text) out.push(new TextRun({ ...style, text: decode(token.text) }));
    }
  }
  return out;
}

function decode(text) {
  return String(text || "").replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[name]));
}

function imageRun(ref, ctx, alt = "") {
  try {
    const image = ctx.files.image(ref);
    const maxWidth = 600; // points of usable page width at 96 dpi, about 16 cm
    const scale = Math.min(1, maxWidth / image.width);
    return new ImageRun({ type: image.type, data: image.data, transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) }, altText: { name: alt || "image", description: alt, title: alt } });
  } catch (error) {
    ctx.warnings.push(error.message);
    return new TextRun({ text: `[${alt || "image"}]`, italics: true, color: "888888" });
  }
}

function listParagraphs(token, level, ctx) {
  const out = [];
  const reference = token.ordered ? `numbers-${ctx.lists++}` : "bullets";
  if (token.ordered) ctx.numbering.push(reference);
  for (const item of token.items) {
    let first = true;
    for (const child of item.tokens) {
      if (child.type === "list") { out.push(...listParagraphs(child, Math.min(level + 1, 4), ctx)); continue; }
      const runs = child.type === "text" || child.type === "paragraph" ? inlineRuns(child.tokens || [{ type: "text", text: child.text }], {}, ctx) : inlineRuns([child], {}, ctx);
      if (item.task) runs.unshift(new TextRun({ text: item.checked ? "☑ " : "☐ " }));
      out.push(new Paragraph({ children: runs, ...(first ? { numbering: { reference, level } } : { indent: { left: 720 * (level + 1) } }), spacing: { after: 60 } }));
      first = false;
    }
  }
  return out;
}

function tableBlock(token, ctx) {
  const columns = token.header.length;
  const width = Math.floor(9000 / columns);
  const cell = (data, header, align) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, fill: "F2F2F5" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ alignment: align === "right" ? AlignmentType.RIGHT : align === "center" ? AlignmentType.CENTER : AlignmentType.LEFT, children: inlineRuns(data.tokens, header ? { bold: true } : {}, ctx) })],
  });
  const numeric = (text) => /^\s*[-+(]?[$€£]?\s?[\d.,]+%?\)?\s*[$€£%]?\s*$/.test(text);
  const align = token.header.map((_, i) => token.align[i] || (token.rows.length && token.rows.every((row) => numeric(row[i]?.text || "")) ? "right" : "left"));
  const border = { style: BorderStyle.SINGLE, size: 4, color: "E3E3E8" };
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: Array(columns).fill(width),
    borders: { top: border, bottom: border, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: border, insideVertical: { style: BorderStyle.NONE } },
    rows: [
      new TableRow({ tableHeader: true, children: token.header.map((data, i) => cell(data, true, align[i])) }),
      ...token.rows.map((row) => new TableRow({ children: row.map((data, i) => cell(data, false, align[i])) })),
    ],
  });
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function blocks(tokens, ctx) {
  const out = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": out.push(new Paragraph({ heading: HEADINGS[token.depth - 1], children: inlineRuns(token.tokens, {}, ctx) })); break;
      case "paragraph":
        out.push(new Paragraph({
          children: inlineRuns(token.tokens, ctx.quote ? { color: "555555" } : {}, ctx),
          spacing: { after: 140 },
          ...(ctx.quote ? { indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: ctx.accent, space: 10 } } } : {}),
        }));
        break;
      case "list": out.push(...listParagraphs(token, 0, ctx)); break;
      case "table": out.push(tableBlock(token, ctx), new Paragraph({ children: [] })); break;
      case "blockquote":
        ctx.quote = (ctx.quote || 0) + 1;
        out.push(...blocks(token.tokens, ctx));
        ctx.quote -= 1;
        break;
      case "code":
        for (const line of String(token.text).split("\n")) {
          out.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Consolas", size: 18 })], shading: { type: ShadingType.CLEAR, fill: "F6F6F8" }, spacing: { after: 0 } }));
        }
        out.push(new Paragraph({ children: [] }));
        break;
      case "hr": out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "E3E3E8", space: 4 } }, children: [] })); break;
      case "html": {
        const chart = /<!-- ravnir-chart (\d+) -->/.exec(token.text);
        if (chart) out.push(chartParagraph(ctx.charts[Number(chart[1])], Number(chart[1]), ctx));
        else if (/<!--\s*pagebreak\s*-->/i.test(token.text)) out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      }
      case "space": break;
      default: if (token.text) out.push(new Paragraph({ children: [new TextRun(decode(token.text))] }));
    }
  }
  return out;
}

function chartParagraph(chart, index, ctx) {
  if (!chart?.png) {
    ctx.warnings.push(`Chart ${index + 1}: ${chart?.error || "not drawn"}`);
    return new Paragraph({ children: [new TextRun({ text: `[chart ${index + 1}]`, italics: true, color: "888888" })] });
  }
  const scale = Math.min(1, 600 / chart.width);
  return new Paragraph({
    spacing: { before: 120, after: 200 },
    children: [new ImageRun({ type: "png", data: chart.png, transformation: { width: Math.round(chart.width * scale), height: Math.round(chart.height * scale) }, altText: { name: `chart ${index + 1}`, description: "chart", title: "chart" } })],
  });
}

async function renderDocx({ content, title, options, files }) {
  const accent = color(options.accent, "2F5DA8");
  const { text, specs } = chartBlocks(content);
  const ctx = { files, accent, warnings: [], numbering: [], lists: 0, charts: await renderCharts(specs, { width: 640, scale: 2 }) };
  const source = String(text).replace(/^[ \t]*\\pagebreak[ \t]*$/gim, "<!-- pagebreak -->");
  const tokens = marked.lexer(source, { gfm: true });
  const children = [];
  if (title && !/^\s*#\s/.test(content) && options.cover !== false) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }));
    if (options.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: String(options.subtitle), color: "6E6E73" })], spacing: { after: 240 } }));
  }
  children.push(...blocks(tokens, ctx));
  const font = String(options.font || "Arial").slice(0, 40);
  const bulletLevels = ["•", "◦", "▪", "•", "◦"].map((text, level) => ({ level, format: LevelFormat.BULLET, text, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }));
  const numberLevels = ["%1.", "%2.", "%3.", "%4.", "%5."].map((text, level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER][level], text, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }));
  const doc = new Document({
    creator: String(options.author || "Ravnir"),
    title: title || "Document",
    styles: {
      default: { document: { run: { font, size: 22 }, paragraph: { spacing: { line: 276 } } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", run: { size: 48, bold: true, color: "111111" }, paragraph: { spacing: { after: 120 } } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { size: 32, bold: true, color: "111111" }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { size: 26, bold: true, color: accent }, paragraph: { spacing: { before: 280, after: 100 }, keepNext: true } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", run: { size: 23, bold: true, color: "333333" }, paragraph: { spacing: { before: 220, after: 80 }, keepNext: true } },
      ],
    },
    numbering: { config: [{ reference: "bullets", levels: bulletLevels }, ...ctx.numbering.map((reference) => ({ reference, levels: numberLevels }))] },
    sections: [{ properties: { page: { size: { orientation: options.landscape ? "landscape" : "portrait" } } }, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  const headings = tokens.filter((token) => token.type === "heading").length;
  const tables = tokens.filter((token) => token.type === "table").length;
  return { buffer, summary: `${headings} heading${headings === 1 ? "" : "s"}, ${tables} table${tables === 1 ? "" : "s"}`, warnings: ctx.warnings };
}

// --- Excel ----------------------------------------------------------------------------------------

const CURRENCY = { EUR: '#,##0.00 "€"', USD: '"$"#,##0.00', GBP: '"£"#,##0.00' };

export function numberFormat(format) {
  const value = String(format || "").trim();
  if (!value || value === "text") return undefined;
  if (value === "integer") return "#,##0";
  if (value === "number") return "#,##0.00";
  if (value === "percent") return "0.0%";
  if (value === "date") return "yyyy-mm-dd";
  if (value === "datetime") return "yyyy-mm-dd hh:mm";
  const currency = /^currency(?::([A-Z]{3}))?$/.exec(value);
  if (currency) return CURRENCY[currency[1] || "EUR"] || `#,##0.00 "${currency[1]}"`;
  return value; // a raw Excel number format, like 0.000
}

function cellValue(value, format) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.startsWith("=")) return { formula: value.slice(1) };
  if ((format === "date" || format === "datetime") && typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value);
  return value;
}

const TOTALS = { sum: "SUM", average: "AVERAGE", count: "COUNTA", min: "MIN", max: "MAX" };

async function renderXlsx({ content, title, options }) {
  const spec = parseJson(content, "spreadsheet");
  const sheets = Array.isArray(spec) ? [{ rows: spec }] : Array.isArray(spec.sheets) ? spec.sheets : [spec];
  if (!sheets.length) throw new Error("The spreadsheet spec has no sheets.");
  const accent = color(spec.accent || options.accent, "2F5DA8");
  const book = new ExcelJS.Workbook();
  book.creator = String(spec.author || options.author || "Ravnir");
  book.title = title;
  book.calcProperties = { fullCalcOnLoad: true };
  const used = new Set();
  let total = 0;
  for (const [index, sheet] of sheets.entries()) {
    let name = String(sheet.name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || `Sheet${index + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${index + 1}`;
    used.add(name.toLowerCase());
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    let columns = Array.isArray(sheet.columns) ? sheet.columns.map((col) => (typeof col === "string" ? { header: col } : col)) : [];
    if (!columns.length && rows[0] && !Array.isArray(rows[0])) columns = Object.keys(rows[0]).map((key) => ({ header: key, key }));
    if (!columns.length && Array.isArray(rows[0])) columns = rows[0].map((_, i) => ({ header: `Column ${i + 1}` }));
    columns = columns.map((col, i) => ({ ...col, key: String(col.key ?? col.header ?? `c${i}`) }));
    const ws = book.addWorksheet(name, { views: sheet.freeze === false ? [] : [{ state: "frozen", ySplit: 1 }] });
    ws.columns = columns.map((col) => ({ header: String(col.header ?? col.key), key: col.key, style: { numFmt: numberFormat(col.format) } }));
    for (const row of rows) {
      const values = Array.isArray(row) ? row : columns.map((col) => row?.[col.key]);
      ws.addRow(values.map((value, i) => cellValue(value, columns[i]?.format)));
    }
    total += rows.length;
    const last = rows.length + 1;
    if (sheet.totals && typeof sheet.totals === "object" && rows.length) {
      const values = columns.map((col, i) => {
        const kind = sheet.totals[col.key];
        if (TOTALS[kind]) {
          const letter = ws.getColumn(i + 1).letter;
          return { formula: `${TOTALS[kind]}(${letter}2:${letter}${last})`, result: totalOf(kind, rows, col, i) };
        }
        return typeof kind === "string" && !TOTALS[kind] ? kind : null;
      });
      if (!values[0]) values[0] = "Total";
      const row = ws.addRow(values);
      row.font = { bold: true };
      row.eachCell((cell) => { cell.border = { top: { style: "thin", color: { argb: "FF999999" } } }; });
    }
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${accent}` } }; });
    header.alignment = { vertical: "middle" };
    header.height = 20;
    columns.forEach((col, i) => {
      const column = ws.getColumn(i + 1);
      const longest = Math.max(String(col.header ?? col.key).length, ...rows.slice(0, 500).map((row) => String((Array.isArray(row) ? row[i] : row?.[col.key]) ?? "").length));
      column.width = Number(col.width) || Math.min(60, Math.max(10, longest + 3));
      if (col.wrap) column.alignment = { wrapText: true, vertical: "top" };
    });
    if (sheet.filter !== false && rows.length && columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: columns.length } };
  }
  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  return { buffer, summary: `${sheets.length} sheet${sheets.length === 1 ? "" : "s"}, ${total} row${total === 1 ? "" : "s"}` };
}

function totalOf(kind, rows, col, i) {
  const values = rows.map((row) => (Array.isArray(row) ? row[i] : row?.[col.key])).filter((value) => typeof value === "number");
  if (kind === "count") return rows.filter((row) => (Array.isArray(row) ? row[i] : row?.[col.key]) != null).length;
  if (!values.length) return 0;
  if (kind === "sum") return values.reduce((a, b) => a + b, 0);
  if (kind === "average") return values.reduce((a, b) => a + b, 0) / values.length;
  if (kind === "min") return Math.min(...values);
  if (kind === "max") return Math.max(...values);
  return undefined;
}

// --- PowerPoint -------------------------------------------------------------------------------------

// A chart placed as a picture keeps its numbers in the alt text, for screen readers and for an
// agent that reads the deck back with read_document.
export function chartAlt(chart, fallback = "") {
  const rows = chart.labels.map((label, i) => `${label}: ${chart.series.map((series) => `${chart.series.length > 1 ? `${series.name} ` : ""}${series.data[i] ?? "no value"}`).join(", ")}`);
  return `${chart.title || fallback || `${chart.type} chart`}${chart.unit ? ` (${chart.unit})` : ""}. ${rows.join("; ")}`.slice(0, 1000);
}

// The chat's chart spec, also accepting the names a model tends to reach for (kind, values, column).
export function chartSpec(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const type = { column: "bar", doughnut: "donut", horizontal: "hbar" }[raw.type || raw.kind] || raw.type || raw.kind || "bar";
  const series = (raw.series || []).map((item) => ({ name: String(item.name || "Series"), data: (item.data || item.values || []).map((value) => (value === null ? null : Number(value))) }));
  const out = { type: raw.horizontal && type === "bar" ? "hbar" : type, labels: (raw.labels || []).map(String), series };
  for (const key of ["title", "subtitle", "note", "unit", "decimals", "yMin", "yMax"]) if (raw[key] !== undefined) out[key] = raw[key];
  return out;
}
const W = 13.333;
const H = 7.5;

function bulletText(items, size, textColor, level = 0) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (Array.isArray(item)) { out.push(...bulletText(item, size - 2, textColor, level + 1)); continue; }
    out.push({ text: String(item), options: { bullet: level ? { indent: 18 } : true, indentLevel: level, fontSize: level ? size - 2 : size, color: textColor, breakLine: true, paraSpaceAfter: 6 } });
  }
  return out;
}

async function renderPptx({ content, title, options, files }) {
  const spec = parseJson(content, "slide deck");
  const slides = Array.isArray(spec) ? spec : spec.slides;
  if (!Array.isArray(slides) || !slides.length) throw new Error("The slide deck spec has no slides.");
  const theme = { ...(spec.theme || {}), ...(options.theme || {}) };
  const accent = color(theme.accent, "2F5DA8");
  const bg = color(theme.background, "FFFFFF");
  const ink = color(theme.text, "1D1D1F");
  const muted = color(theme.muted, "6E6E73");
  const font = String(theme.font || "Arial").slice(0, 40);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = title || String(spec.title || "Presentation");
  pptx.author = String(spec.author || options.author || "Ravnir");
  pptx.theme = { headFontFace: font, bodyFontFace: font };
  const warnings = [];
  // Charts are drawn first (one browser for the whole deck) and placed as pictures, which every app shows.
  const charts = new Map();
  const pending = slides.map((item, index) => ({ item, index })).filter(({ item }) => String(item.type) === "chart" && !item.chart?.native);
  const drawn = await renderCharts(pending.map(({ item }) => chartSpec(item.chart)), { width: 720, scale: 3 });
  pending.forEach(({ index }, i) => charts.set(index, drawn[i]));
  const heading = (slide, text) => slide.addText(String(text || ""), { x: 0.6, y: 0.4, w: W - 1.2, h: 0.9, fontSize: 28, bold: true, color: ink, fontFace: font, valign: "top" });
  slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: bg };
    const type = String(item.type || (item.bullets ? "bullets" : index === 0 ? "title" : "bullets"));
    if (type === "title" || type === "section") {
      slide.background = { color: type === "title" ? accent : bg };
      const onAccent = type === "title";
      slide.addText(String(item.title || title || ""), { x: 0.8, y: type === "title" ? 2.4 : 2.9, w: W - 1.6, h: 1.4, fontSize: type === "title" ? 44 : 36, bold: true, color: onAccent ? "FFFFFF" : ink, fontFace: font });
      if (item.subtitle) slide.addText(String(item.subtitle), { x: 0.8, y: type === "title" ? 3.8 : 4.2, w: W - 1.6, h: 0.8, fontSize: 20, color: onAccent ? "E8EEF8" : muted, fontFace: font });
      if (type === "section") slide.addShape(pptx.ShapeType.rect, { x: 0.8, y: 2.7, w: 1.2, h: 0.08, fill: { color: accent }, line: { color: accent } });
    } else if (type === "bullets") {
      heading(slide, item.title);
      slide.addText(bulletText(item.bullets, 20, ink), { x: 0.6, y: 1.5, w: W - 1.2, h: H - 2.3, valign: "top", fontFace: font });
    } else if (type === "two-column") {
      heading(slide, item.title);
      [["left", 0.6], ["right", W / 2 + 0.2]].forEach(([side, x]) => {
        const col = item[side] || {};
        const list = Array.isArray(col) ? col : col.bullets;
        let y = 1.5;
        if (col.heading) { slide.addText(String(col.heading), { x, y, w: W / 2 - 0.8, h: 0.5, fontSize: 18, bold: true, color: accent, fontFace: font }); y += 0.6; }
        slide.addText(bulletText(list, 18, ink), { x, y, w: W / 2 - 0.8, h: H - y - 0.8, valign: "top", fontFace: font });
      });
    } else if (type === "table") {
      heading(slide, item.title);
      const columns = (item.columns || []).map(String);
      const rows = (item.rows || []).map((row) => row.map((cell) => String(cell ?? "")));
      const numeric = columns.map((_, i) => rows.length > 0 && rows.every((row) => /^\s*[-+(]?[$€£]?\s?[\d.,]+\s?[%kKMB]?\)?\s*[$€£%]?\s*$/.test(row[i] || "")));
      const body = [
        columns.map((text, i) => ({ text, options: { bold: true, color: "FFFFFF", fill: { color: accent }, align: numeric[i] ? "right" : "left" } })),
        ...rows.map((row, r) => row.map((text, i) => ({ text, options: { align: numeric[i] ? "right" : "left", ...(r % 2 ? { fill: { color: "F6F6F8" } } : {}) } }))),
      ];
      if (rows.length > 12) warnings.push(`Slide ${index + 1}: ${rows.length} table rows is a lot for one slide; consider splitting it.`);
      slide.addTable(body, { x: 0.6, y: 1.5, w: W - 1.2, fontSize: rows.length > 8 ? 13 : 16, rowH: rows.length > 8 ? 0.36 : 0.5, valign: "middle", fontFace: font, color: ink, border: { type: "solid", pt: 0.5, color: "D2D2D7" }, autoPage: false });
    } else if (type === "chart") {
      heading(slide, item.title);
      const chart = chartSpec(item.chart);
      const box = { x: 0.6, y: 1.4, w: W - 1.2, h: H - 2.1 };
      if (item.chart?.native) {
        // Editable in PowerPoint and Google Slides; Keynote and Quick Look draw nothing.
        const kind = { bar: "bar", hbar: "bar", stacked: "bar", line: "line", area: "area", pie: "pie", donut: "doughnut" }[chart.type] || "bar";
        const data = chart.series.map((series) => ({ name: series.name, labels: chart.labels, values: series.data }));
        slide.addChart(pptx.ChartType[kind], data, { ...box, barDir: chart.type === "hbar" ? "bar" : "col", barGrouping: chart.type === "stacked" ? "stacked" : "clustered", showLegend: data.length > 1 || kind === "pie" || kind === "doughnut", legendPos: "b", chartColors: [accent, "EB6834", "1BAF7A", "EDA100", "E87BA4", "6250D6"] });
      } else {
        const drawn = charts.get(index);
        if (!drawn?.png) {
          warnings.push(`Slide ${index + 1}: ${drawn?.error || "the chart was not drawn"}`);
        } else {
          const scale = Math.min(box.w / drawn.width, box.h / drawn.height);
          const w = drawn.width * scale;
          const h = drawn.height * scale;
          slide.addImage({ data: `image/png;base64,${drawn.png.toString("base64")}`, x: (W - w) / 2, y: box.y, w, h, altText: chartAlt(chart, item.title) });
        }
      }
    } else if (type === "image") {
      if (item.title) heading(slide, item.title);
      try {
        const image = files.image(item.image);
        const top = item.title ? 1.5 : 0.5;
        const boxW = W - 1.2;
        const boxH = H - top - (item.caption ? 1.1 : 0.6);
        const scale = Math.min(boxW / image.width, boxH / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        slide.addImage({ data: `image/${image.type === "jpg" ? "jpeg" : image.type};base64,${image.data.toString("base64")}`, x: (W - w) / 2, y: top, w, h, altText: String(item.caption || item.title || "") });
        if (item.caption) slide.addText(String(item.caption), { x: 0.6, y: top + h + 0.15, w: W - 1.2, h: 0.5, fontSize: 14, color: muted, align: "center", fontFace: font });
      } catch (error) {
        warnings.push(`Slide ${index + 1}: ${error.message}`);
      }
    } else if (type === "stat") {
      heading(slide, item.title);
      const stats = (item.stats || []).slice(0, 4);
      const width = (W - 1.2) / Math.max(1, stats.length);
      stats.forEach((stat, i) => {
        slide.addText(String(stat.value ?? ""), { x: 0.6 + i * width, y: 2.4, w: width - 0.2, h: 1.4, fontSize: 54, bold: true, color: accent, align: "center", fontFace: font });
        slide.addText(String(stat.label ?? ""), { x: 0.6 + i * width, y: 3.9, w: width - 0.2, h: 1, fontSize: 16, color: muted, align: "center", valign: "top", fontFace: font });
      });
    } else if (type === "quote") {
      slide.addText(`“${String(item.quote || "")}”`, { x: 1.2, y: 2, w: W - 2.4, h: 2.6, fontSize: 32, italic: true, color: ink, fontFace: font, valign: "middle" });
      if (item.by) slide.addText(`${item.by}`, { x: 1.2, y: 4.8, w: W - 2.4, h: 0.6, fontSize: 18, color: muted, fontFace: font });
    } else {
      throw new Error(`Slide ${index + 1}: unknown type ${type}. Use title, section, bullets, two-column, table, chart, image, stat or quote.`);
    }
    if (index > 0 && spec.slideNumbers !== false) slide.addText(String(index + 1), { x: W - 1, y: H - 0.5, w: 0.6, h: 0.3, fontSize: 10, color: muted, align: "right", fontFace: font });
    if (item.notes) slide.addNotes(String(item.notes));
  });
  const buffer = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
  return { buffer, summary: `${slides.length} slide${slides.length === 1 ? "" : "s"}`, warnings };
}

const RENDERERS = { pdf: renderPdf, docx: renderDocx, xlsx: renderXlsx, pptx: renderPptx };
