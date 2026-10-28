// Artifacts: work an agent delivers as a thing, not as a wall of text. A page or small app, a
// document, a table, a chart, a diagram, an SVG, a code file, or a file it made in its workspace.
// Each one is versioned under data/bots/<id>/artifacts/<artifact>/ and shows as a card in the chat.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "../public/charts.js";
import { botHome } from "./state.js";

const KINDS = {
  html: { ext: "html", mime: "text/html; charset=utf-8", word: "page" },
  markdown: { ext: "md", mime: "text/markdown; charset=utf-8", word: "document" },
  csv: { ext: "csv", mime: "text/csv; charset=utf-8", word: "table" },
  chart: { ext: "json", mime: "application/json; charset=utf-8", word: "chart" },
  mermaid: { ext: "mmd", mime: "text/plain; charset=utf-8", word: "diagram" },
  svg: { ext: "svg", mime: "image/svg+xml", word: "image" },
  code: { ext: "txt", mime: "text/plain; charset=utf-8", word: "code file" },
};
const TEXT_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 25 * 1024 * 1024;
const MAX_VERSIONS = 50;
const READ_LIMIT = 40_000;
const ID = /^a_[0-9a-f]{12}$/;

const FILE_TYPES = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
};
// Shown inline when opened; anything else downloads. HTML and SVG also get a sandbox (see rawHeaders).
const INLINE = /^(image\/(png|jpeg|gif|webp|svg\+xml)|application\/pdf|text\/(plain|csv|markdown|html)|application\/json|audio\/|video\/)/;

export class ArtifactStore {
  constructor(home) {
    this.home = home;
  }

  #dir(bot, id = "") {
    return path.join(botHome(this.home, bot), "artifacts", id);
  }

  #meta(bot, id) {
    if (!ID.test(String(id || ""))) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.#dir(bot, id), "meta.json"), "utf8"));
    } catch {
      return null;
    }
  }

  #save(bot, meta) {
    fs.writeFileSync(path.join(this.#dir(bot, meta.id), "meta.json"), JSON.stringify(meta, null, 2));
  }

  list(bot) {
    let names = [];
    try {
      names = fs.readdirSync(this.#dir(bot));
    } catch {
      return [];
    }
    return names.map((id) => this.#meta(bot, id)).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(bot, id) {
    return this.#meta(bot, id);
  }

  create(bot, { title, kind, content, language = "", note = "", turnId = "" }) {
    const spec = KINDS[kind];
    if (!spec) throw new Error(`Unknown artifact kind "${kind}". Use one of: ${Object.keys(KINDS).join(", ")}.`);
    const body = checkContent(kind, content);
    const now = Date.now();
    const meta = {
      id: `a_${crypto.randomBytes(6).toString("hex")}`,
      title: cleanTitle(title) || `Untitled ${spec.word}`,
      kind,
      language: kind === "code" ? cleanLanguage(language) : "",
      mime: spec.mime,
      filename: "",
      size: Buffer.byteLength(body),
      version: 1,
      versions: [{ v: 1, at: now, size: Buffer.byteLength(body), note: cleanNote(note), turnId }],
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.#dir(bot, meta.id), { recursive: true });
    fs.writeFileSync(this.#file(bot, meta, 1), body);
    this.#save(bot, meta);
    return meta;
  }

  update(bot, id, { content, title, note = "", turnId = "" }) {
    const meta = this.#meta(bot, id);
    if (!meta) throw new Error(`No artifact with id ${id}. Use list_artifacts to see yours.`);
    if (meta.kind === "file") throw new Error("Shared files cannot be edited. Share the new file with share_file.");
    const body = checkContent(meta.kind, content);
    const now = Date.now();
    const v = meta.version + 1;
    fs.writeFileSync(this.#file(bot, meta, v), body);
    meta.version = v;
    meta.size = Buffer.byteLength(body);
    meta.updatedAt = now;
    if (cleanTitle(title)) meta.title = cleanTitle(title);
    meta.versions.push({ v, at: now, size: meta.size, note: cleanNote(note), turnId });
    while (meta.versions.length > MAX_VERSIONS) {
      const old = meta.versions.shift();
      fs.rmSync(this.#file(bot, meta, old.v), { force: true });
    }
    this.#save(bot, meta);
    return meta;
  }

  // A file the agent made in its workspace (a PDF, an image, a spreadsheet), copied so later edits
  // to the workspace do not change what the user was given.
  shareFile(bot, workspace, { path: relative, title = "", note = "", turnId = "" }) {
    const root = fs.realpathSync(workspace);
    const target = path.resolve(root, String(relative || ""));
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      throw new Error(`There is no file at ${relative} in your workspace.`);
    }
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error("share_file only shares files inside your workspace.");
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error(`${relative} is not a file.`);
    if (stat.size > FILE_LIMIT) throw new Error("That file is over 25 MB.");
    const filename = path.basename(real).replace(/[^\w .()+-]/g, "_").slice(0, 120) || "file";
    const mime = FILE_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream";
    const now = Date.now();
    const meta = {
      id: `a_${crypto.randomBytes(6).toString("hex")}`,
      title: cleanTitle(title) || filename,
      kind: "file",
      language: "",
      mime,
      filename,
      size: stat.size,
      version: 1,
      versions: [{ v: 1, at: now, size: stat.size, note: cleanNote(note), turnId }],
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.#dir(bot, meta.id), { recursive: true });
    fs.copyFileSync(real, this.#file(bot, meta, 1));
    this.#save(bot, meta);
    return meta;
  }

  read(bot, id, version) {
    const meta = this.#meta(bot, id);
    if (!meta) return null;
    const v = version ? Number(version) : meta.version;
    if (!meta.versions.some((item) => item.v === v)) return { meta, version: v, missing: true };
    const file = this.#file(bot, meta, v);
    if (!fs.existsSync(file)) return { meta, version: v, missing: true };
    return { meta, version: v, file };
  }

  #file(bot, meta, v) {
    const ext = meta.kind === "file" ? path.extname(meta.filename).slice(1).replace(/[^\w]/g, "") || "bin" : KINDS[meta.kind].ext;
    return path.join(this.#dir(bot, meta.id), `v${v}.${ext}`);
  }
}

// What the thread keeps on a message: enough to draw the card.
export function artifactRef(meta) {
  return {
    id: meta.id, title: meta.title, kind: meta.kind, version: meta.version, updatedAt: meta.updatedAt, size: meta.size,
    ...(meta.language ? { language: meta.language } : {}),
    ...(meta.kind === "file" ? { mime: meta.mime, filename: meta.filename } : {}),
  };
}

// Headers for the raw bytes. An HTML page or SVG runs in an opaque origin (CSP sandbox without
// allow-same-origin), so it cannot read the app's cookies or call its API; the API also refuses
// cross-site requests (assertSameOrigin).
export function rawHeaders(meta, { download = false, version } = {}) {
  const headers = {
    "content-type": meta.mime || "application/octet-stream",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
    "referrer-policy": "no-referrer",
  };
  const name = meta.kind === "file" ? meta.filename : `${slug(meta.title)}${version && version !== meta.version ? `-v${version}` : ""}.${KINDS[meta.kind].ext}`;
  if (download || !INLINE.test(headers["content-type"])) {
    headers["content-disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
  } else {
    headers["content-disposition"] = `inline; filename="${name.replace(/"/g, "")}"`;
  }
  if (/^(text\/html|image\/svg\+xml)/.test(headers["content-type"])) {
    headers["content-security-policy"] = meta.kind === "svg" || meta.mime.startsWith("image/svg")
      ? "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
      : "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads";
  }
  return headers;
}

export function artifactToolDefinitions() {
  return [
    {
      name: "create_artifact",
      description: "Save a deliverable the user can open, keep and download, shown as a card in the chat. Use it for anything longer than a screen or meant to be kept or shared: a report or document (kind markdown), a web page, dashboard or small app (kind html, one self-contained file; scripts and styles inline or from https CDNs), a dataset or long table (kind csv), a chart (kind chart, the same JSON spec as a ```chart block), a diagram (kind mermaid), an SVG image (kind svg), or a code file (kind code with language). Returns the artifact id; change it later with update_artifact instead of creating a new one.",
      parameters: objectSchema({
        title: { type: "string", description: "Short title the user sees, for example \"October spend by agent\"." },
        kind: { type: "string", enum: Object.keys(KINDS) },
        content: { type: "string", description: "The full content." },
        language: { type: "string", description: "For kind code: the language, for example python." },
      }, ["title", "kind", "content"]),
    },
    {
      name: "update_artifact",
      description: "Save a new version of one of your artifacts with the full new content. The user can still open earlier versions.",
      parameters: objectSchema({
        id: { type: "string" },
        content: { type: "string", description: "The full new content, not a diff." },
        title: { type: "string" },
        note: { type: "string", description: "What changed, in a few words." },
      }, ["id", "content"]),
    },
    {
      name: "list_artifacts",
      description: "List the artifacts you have saved, newest first, with ids, kinds and versions.",
      parameters: objectSchema({}, []),
    },
    {
      name: "read_artifact",
      description: "Read the content of one of your artifacts, the latest version or an earlier one.",
      parameters: objectSchema({ id: { type: "string" }, version: { type: "number" } }, ["id"]),
    },
    {
      name: "share_file",
      description: "Give the user a file you made in your workspace (a PDF, an image, a spreadsheet, an audio clip) as a card in the chat they can open or download. Pass the path relative to your workspace.",
      parameters: objectSchema({
        path: { type: "string" },
        title: { type: "string" },
      }, ["path"]),
    },
  ];
}

export const ARTIFACT_TOOLS = new Set(artifactToolDefinitions().map((tool) => tool.name));

export function callArtifactTool(name, args, { store, bot, workspace, turnId = "", onSaved = () => {} }) {
  if (name === "list_artifacts") {
    const items = store.list(bot).slice(0, 50);
    if (!items.length) return { text: "You have no artifacts yet." };
    return { text: items.map((m) => `- ${m.id} · ${m.kind} · v${m.version} · ${m.title}`).join("\n"), activity: "Listing artifacts" };
  }
  if (name === "read_artifact") {
    const found = store.read(bot, String(args.id || ""), args.version);
    if (!found) return { text: `No artifact with id ${args.id}.` };
    if (found.missing) return { text: `${found.meta.title} has no version ${found.version}. Latest is v${found.meta.version}.` };
    if (found.meta.kind === "file") return { text: `${found.meta.title} is a shared file (${found.meta.filename}, ${found.meta.size} bytes); its content is not text.` };
    const text = fs.readFileSync(found.file, "utf8");
    const cut = text.length > READ_LIMIT;
    return { text: `${found.meta.title} (${found.meta.kind}, v${found.version} of ${found.meta.version})${cut ? `, first ${READ_LIMIT} characters` : ""}\n\n${cut ? text.slice(0, READ_LIMIT) : text}`, activity: `Reading ${found.meta.title}` };
  }
  let meta;
  if (name === "create_artifact") {
    meta = store.create(bot, { title: args.title, kind: String(args.kind || ""), content: args.content, language: args.language, turnId });
  } else if (name === "update_artifact") {
    meta = store.update(bot, String(args.id || ""), { content: args.content, title: args.title, note: args.note, turnId });
  } else if (name === "share_file") {
    meta = store.shareFile(bot, workspace, { path: args.path, title: args.title, turnId });
  } else {
    throw new Error(`Unknown tool ${name}.`);
  }
  onSaved(meta);
  const verb = name === "update_artifact" ? `Saved version ${meta.version} of` : name === "share_file" ? "Shared" : "Saved";
  return {
    text: `${verb} "${meta.title}" (id ${meta.id}, ${meta.kind}). The user sees it as a card under your reply, so do not paste its content into the chat; say in a sentence what it is and what to look at.`,
    activity: `${verb} ${meta.title}`,
  };
}

function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}

function checkContent(kind, content) {
  const body = typeof content === "string" ? content : "";
  if (!body.trim()) throw new Error("The artifact content is empty.");
  if (Buffer.byteLength(body) > TEXT_LIMIT) throw new Error("The artifact is over 2 MB. Make it smaller or save it as a file and use share_file.");
  if (kind === "chart") {
    const checked = globalThis.RavnirCharts?.normalize(body);
    if (checked && !checked.ok) throw new Error(`The chart spec is not valid: ${checked.error}`);
  }
  if (kind === "svg" && !/<svg[\s>]/i.test(body)) throw new Error("An svg artifact must contain an <svg> element.");
  return body;
}

function cleanTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function cleanNote(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function cleanLanguage(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+#-]/g, "").slice(0, 30);
}

function slug(value) {
  return String(value || "artifact").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "artifact";
}
