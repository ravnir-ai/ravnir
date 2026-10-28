// Files the owner attaches to a message. They are saved in the agent's workspace under
// uploads/<day>/<name>, so the agent's own tools (shell, files, OpenCode) can open them, and
// served back to the thread. Photos also reach the model as images when they are small enough.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
// Larger photos stay on disk only: a data URL this size is already about 11 MB of JSON.
const MODEL_IMAGE_BYTES = 8 * 1024 * 1024;
const MODEL_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", html: "text/html", xml: "application/xml", zip: "application/zip", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime",
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function uploadsDir(workspace) {
  return path.join(workspace, "uploads");
}

// A file name that is safe on disk and still recognizable: no folders, no control or reserved
// characters, no leading dot, at most 120 characters with its extension kept.
export function safeName(input) {
  const base = path.basename(String(input || "").replace(/\\/g, "/"));
  let name = base.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!name) name = "file";
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 16);
    name = `${name.slice(0, 120 - ext.length).trim()}${ext}`;
  }
  return name;
}

export function typeOf(name, given = "") {
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  if (TYPES[ext]) return TYPES[ext];
  const type = String(given).split(";")[0].trim().toLowerCase();
  return /^[a-z]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream";
}

export function isImage(type) {
  return MODEL_IMAGES.has(type);
}

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let index = 2; fs.existsSync(path.join(dir, candidate)); index += 1) candidate = `${stem}-${index}${ext}`;
  return candidate;
}

function record(workspace, day, name) {
  const abs = path.join(uploadsDir(workspace), day, name);
  const stat = fs.statSync(abs);
  return { id: `${day}/${name}`, name, path: `uploads/${day}/${name}`, type: typeOf(name), size: stat.size, abs };
}

const httpError = (message, status) => Object.assign(new Error(message), { status });

// Streams a request body to uploads/<today>/<name>. Over the limit, nothing is kept.
export async function saveUpload({ workspace, req, name }) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw httpError(`Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, 413);
  const day = today();
  const dir = path.join(uploadsDir(workspace), day);
  fs.mkdirSync(dir, { recursive: true });
  const finalName = freeName(dir, safeName(name));
  const temp = path.join(dir, `.upload-${crypto.randomUUID()}`);
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) done(httpError(`Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, 413));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, fs.createWriteStream(temp, { flags: "wx" }));
    if (!size) throw httpError("The file is empty.", 400);
    fs.renameSync(temp, path.join(dir, finalName));
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return record(workspace, day, finalName);
}

// An attachment id ("2026-10-25/photo.png") back to its file, only inside this workspace's uploads.
export function findUpload(workspace, id) {
  const [day, name, extra] = String(id || "").split("/");
  if (extra !== undefined || !DAY.test(day || "") || !name || name !== safeName(name)) return null;
  const abs = path.join(uploadsDir(workspace), day, name);
  if (!abs.startsWith(uploadsDir(workspace) + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return record(workspace, day, name);
}

// What the thread keeps: no absolute paths.
export function publicAttachment(item) {
  return { id: item.id, name: item.name, path: item.path, type: item.type, size: item.size };
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// The line the model reads with the message, so it knows the files exist and where.
const DOCUMENT_FILE = /\.(pdf|docx|xlsx|xlsm|pptx)$/i;

export function attachmentNote(list = []) {
  if (!list.length) return "";
  const lines = list.map((item) => `- ${item.path} (${item.type}, ${sizeLabel(item.size)})`);
  return `[The user attached ${list.length === 1 ? "a file" : `${list.length} files`}, saved in your workspace:\n${lines.join("\n")}\nOpen them with your file tools when you need them${list.some((item) => DOCUMENT_FILE.test(item.path)) ? "; read PDF, Word, Excel and PowerPoint files with the read_document tool" : ""}.]`;
}

export function withAttachments(text, list = []) {
  const note = attachmentNote(list);
  if (!note) return text;
  return text ? `${text}\n\n${note}` : note;
}

// Photos the model can look at, as data URLs. Read from disk at send time.
export function modelImages(workspace, list = []) {
  const out = [];
  for (const item of list) {
    if (!isImage(item.type) || item.size > MODEL_IMAGE_BYTES) continue;
    const found = findUpload(workspace, item.id);
    if (!found) continue;
    out.push({ name: found.name, type: found.type, url: `data:${found.type};base64,${fs.readFileSync(found.abs).toString("base64")}` });
  }
  return out;
}

// Serves an upload back to the browser. Photos show inline; everything else downloads, and every
// response is sandboxed so a crafted file cannot run in the app's origin.
export function serveUpload(res, item) {
  const inline = isImage(item.type);
  const ascii = item.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.writeHead(200, {
    "content-type": inline ? item.type : "application/octet-stream",
    "content-length": item.size,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=3600",
  });
  fs.createReadStream(item.abs).pipe(res);
}
