import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { botHome } from "./state.js";

export const MAX_STEPS = 12;
export const DEFAULT_STEPS = 5;

// The desktop side of desktop_task (server/drive.js runs the loop): capture the screen,
// read it with OCR, and offer the labelled targets, keys and scrolls as numbered actions.
// This works for native apps as well as the browser; the browser has a richer DOM path
// (computer_task).
export async function desktopDriver({ bot, desktop, home, goal = "", text = "" }) {
  const session = await desktop.ensure(bot, home);
  if (!session) throw new Error("The desktop is not available on this server.");
  const outputDir = path.join(botHome(home, bot), "computer");
  await fsp.mkdir(outputDir, { recursive: true });
  await prune(outputDir);
  return {
    kind: "desktop",
    label: "Desktop",
    async observe(step) {
      const png = await desktop.screenshot(bot, { force: true });
      const shot = await save(outputDir, png, step, "before", bot.id);
      const boxes = await readScreen(png);
      const screen = boxes.map((box) => box.text).join("\n");
      return {
        url: "desktop",
        title: "Desktop",
        shot,
        where: "",
        summary: short(screen, 1500),
        state: { screen: "desktop", step: step + 1, text: screen.slice(0, 5000) },
        actions: buildActions(boxes, text, goal),
        empty: "I could not read anything actionable on the desktop.",
      };
    },
    async perform(action) {
      await execute(desktop, bot, action);
      await new Promise((resolve) => setTimeout(resolve, 700));
    },
    async after(step, before) {
      const png = await desktop.screenshot(bot, { force: true }).catch(() => null);
      return { url: "desktop", title: "Desktop", shot: png ? await save(outputDir, png, step, "after", bot.id) : before.shot };
    },
  };
}

function buildActions(boxes, text, goal) {
  const actions = [];
  const ranked = rankBoxes(boxes, goal);
  const boxLimit = text ? 13 : 14;
  for (const box of ranked.slice(0, boxLimit)) {
    actions.push({
      kind: "click",
      x: box.x,
      y: box.y,
      label: `Click "${short(box.text, 90)}"`,
    });
  }
  if (text) actions.push({ kind: "type", text, label: `Type "${short(text, 80)}"` });
  actions.push(
    { kind: "key", key: "Enter", label: "Press Enter" },
    { kind: "key", key: "Tab", label: "Press Tab" },
    { kind: "key", key: "Escape", label: "Press Escape" },
    { kind: "key", key: "Page_Down", label: "Press Page Down" },
    { kind: "key", key: "Page_Up", label: "Press Page Up" },
    { kind: "scroll", dy: 800, label: "Scroll down" },
    { kind: "scroll", dy: -800, label: "Scroll up" },
    { kind: "done", label: "DONE: the goal is already complete" },
    { kind: "stop", label: "STOP: I cannot make progress from this screen" },
  );
  return actions.slice(0, 24);
}

async function execute(desktop, bot, action) {
  if (action.kind === "click") return desktop.click(bot, action.x, action.y);
  if (action.kind === "type") return desktop.type(bot, action.text);
  if (action.kind === "key") return desktop.key(bot, action.key);
  if (action.kind === "scroll") return desktop.scroll(bot, action.dy);
}

async function readScreen(png) {
  const file = path.join("/tmp", `ravnir-ocr-${crypto.randomUUID()}.png`);
  await fsp.writeFile(file, png);
  try {
    const tsv = await tesseract(file);
    return parseTsv(tsv).slice(0, 40);
  } finally {
    await fsp.unlink(file).catch(() => {});
  }
}

function tesseract(file) {
  return new Promise((resolve, reject) => {
    execFile("tesseract", [file, "stdout", "-l", "eng+spa", "--psm", "11", "tsv"], { timeout: 20_000, maxBuffer: 8_000_000 }, (error, stdout) => {
      if (error) {
        reject(new Error(`Tesseract failed: ${error.message.split("\n")[0]}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseTsv(tsv) {
  const lines = new Map();
  const rows = String(tsv || "").split("\n");
  for (const row of rows.slice(1)) {
    const cols = row.split("\t");
    if (cols.length < 12) continue;
    if (cols[0] !== "5") continue;
    const text = cols.slice(11).join(" ").trim();
    if (!text) continue;
    const key = `${cols[2]}:${cols[3]}:${cols[4]}`;
    const line = lines.get(key) || { left: Infinity, top: Infinity, right: 0, bottom: 0, words: [] };
    const left = Number(cols[6]) || 0;
    const top = Number(cols[7]) || 0;
    const width = Number(cols[8]) || 0;
    const height = Number(cols[9]) || 0;
    line.left = Math.min(line.left, left);
    line.top = Math.min(line.top, top);
    line.right = Math.max(line.right, left + width);
    line.bottom = Math.max(line.bottom, top + height);
    line.words.push(text);
    lines.set(key, line);
  }
  return [...lines.values()]
    .map((line) => ({
      text: line.words.join(" ").replace(/\s+/g, " ").trim(),
      x: Math.round((line.left + line.right) / 2),
      y: Math.round((line.top + line.bottom) / 2),
      width: line.right - line.left,
      height: line.bottom - line.top,
    }))
    .filter((box) => box.text.length >= 2 && box.width >= 8 && box.height >= 6)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

async function save(dir, png, step, phase, botId) {
  const name = `desktop-${String(step + 1).padStart(2, "0")}-${phase}-${crypto.randomBytes(4).toString("hex")}.png`;
  await fsp.writeFile(path.join(dir, name), png);
  return `/api/bots/${botId}/computer/${name}`;
}

async function prune(dir, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".png")) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs < cutoff) await fsp.unlink(file);
    } catch {
      // Best effort.
    }
  }
}

function rankBoxes(boxes, goal) {
  const words = new Set((String(goal || "").toLowerCase().match(/[a-z0-9áéíóúñü]+/gi) || []).filter((word) => word.length > 2));
  const phrase = String(goal || "").toLowerCase();
  return boxes
    .map((box, index) => {
      const text = box.text.toLowerCase();
      let score = 0;
      for (const word of words) if (text.includes(word)) score += 2;
      if (text && phrase.includes(text)) score += 4;
      return { ...box, score, index };
    })
    .sort((a, b) => (b.score - a.score) || (a.y - b.y) || (a.index - b.index));
}

function short(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
