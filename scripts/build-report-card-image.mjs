import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "docs/model-report-card.md");
const logo = path.join(root, "public/logo.png");

const outIndex = process.argv.indexOf("--out");
const output = outIndex !== -1 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(root, "docs/media/report-card.png");

const escape = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function parse(source_text) {
  const lines = source_text.split(/\r?\n/);
  const dateMatch = source_text.match(/Run on (\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) throw new Error(`No "Run on YYYY-MM-DD" date found in ${source}.`);
  const date = dateMatch[1];

  const countMatch = source_text.match(/(\d+) tasks, each/);
  const taskCount = countMatch ? Number(countMatch[1]) : null;

  const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

  const start = lines.findIndex((line) => line.startsWith("| Model | Finished |"));
  if (start === -1) throw new Error(`No table with a "| Model | Finished |" header found in ${source}.`);

  const header = splitRow(lines[start]);
  const columns = ["Model", "Finished", "Asks per task (mean)", "Cost per task", "Median time"];
  const indexes = columns.map((name) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`Missing column "${name}" in ${source}.`);
    return index;
  });

  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    if (/^\|[\s\-|:]+\|$/.test(line.trim())) continue;
    const cells = splitRow(line);
    const row = indexes.map((index) => cells[index] ?? "");
    row[0] = row[0].replace(/^opencode-go\//, "");
    rows.push(row);
  }
  if (!rows.length) throw new Error(`The table in ${source} has no rows.`);
  return { date, taskCount, rows };
}

const { date, taskCount, rows } = parse(fs.readFileSync(source, "utf8"));
const logoData = `data:image/png;base64,${fs.readFileSync(logo).toString("base64")}`;
const subtitle = taskCount
  ? `${taskCount} real tasks, a fresh agent and browser for each, through OpenCode. Run on ${date}.`
  : `Real tasks, a fresh agent and browser for each, through OpenCode. Run on ${date}.`;

const body = rows.map(([model, finished, asks, cost, time]) => `<tr>
      <td class="model">${escape(model)}</td>
      <td class="finished">${escape(finished)}</td>
      <td class="num">${escape(asks)}</td>
      <td class="num">${escape(cost)}</td>
      <td class="num">${escape(time)}</td>
    </tr>`).join("\n    ");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;width:1600px;height:900px;background:#121722;color:#f5f4f0;font-family:-apple-system,"SF Pro Display","Helvetica Neue",Arial,sans-serif;padding:64px 72px;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:16px}
  header img{width:72px;height:72px;object-fit:contain;flex:none}
  header .brand{font-size:28px;font-weight:700;letter-spacing:-.5px}
  h1{font-size:64px;font-weight:700;letter-spacing:-2px;margin:26px 0 0}
  .rule{flex:none;width:44px;height:4px;background:#ffb547;border-radius:4px;margin:22px 0 24px}
  .subtitle{font-size:24px;color:#afb7c8;margin:0 0 34px}
  table{width:100%;border-collapse:collapse;font-size:30px}
  th{font-size:18px;text-transform:uppercase;letter-spacing:1px;color:#afb7c8;font-weight:600;text-align:left;padding:0 24px 18px 0;border-bottom:1px solid rgba(255,255,255,0.10)}
  th.num,td.num{text-align:right;padding-right:0}
  td{padding:0 24px 0 0;height:68px;border-bottom:1px solid rgba(255,255,255,0.10);vertical-align:middle}
  td.model{font-weight:600}
  td.finished{color:#ffb547}
  footer{margin-top:auto;font-size:18px;color:#afb7c8}
</style></head><body>
  <header><img src="${logoData}" alt="Ravnir logo"><span class="brand">Ravnir</span></header>
  <h1>Model report card</h1>
  <div class="rule"></div>
  <p class="subtitle">${escape(subtitle)}</p>
  <table>
    <thead><tr><th>Model</th><th>Finished</th><th class="num">Asks per task</th><th class="num">Cost per task</th><th class="num">Median time</th></tr></thead>
    <tbody>
    ${body}
    </tbody>
  </table>
  <footer>Each task ran once per model. Full table: docs/model-report-card.md</footer>
</body></html>`;

fs.mkdirSync(path.dirname(output), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.setContent(html);
  await page.locator("img").evaluate((image) => image.decode());
  await page.screenshot({ path: output, type: "png" });
  console.log(`Wrote ${path.relative(root, output)} (${rows.length} models, run ${date}).`);
} finally {
  await browser.close();
}
