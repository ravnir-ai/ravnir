import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A skill is a folder holding SKILL.md (the Agent Skills layout: YAML frontmatter, then steps) and
// optionally references/, scripts/, templates/ and assets/. The agent gets one line per skill it can
// open; skill_view returns the body on demand. A hundred skills then cost a few hundred tokens, and
// the cost of a procedure is paid only on the turn that uses it.
//
// Names are canonical: a SKILL.md names this server's tools, and renderSkill rewrites them for the
// provider the agent runs on (OpenCode sees read/write/edit/grep and the ravnir_<tool> bridge).

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");
export const DESCRIPTION_LIMIT = 60;
export const INDEX_LIMIT = 14;
export const SUPPORT_DIRS = ["references", "scripts", "templates", "assets"];
const MAX_FILE = 200_000;
const MAX_LISTED_FILES = 40;

// The tools a SKILL.md may name. Anything else stays as written, so `python3` or `npm test` is not
// rewritten by accident. Keep this list in step with the tool definitions.
export const TOOLS = [
  "list_dir", "read_file", "write_file", "edit_file", "search", "list_files",
  "run_command", "box_info", "mac_run", "mac_read_file", "mac_write_file", "mac_list", "mac_status",
  "web_search", "web_fetch", "web_research",
  "browser_open", "browser_read", "browser_click", "browser_type", "browser_key",
  "browser_smart_click", "browser_saved_login", "list_saved_logins",
  "computer_task", "computer_step", "desktop_task", "jev_choose", "ask_user_to_take_over",
  "memory_read", "memory_search", "memory_write", "remember", "search_history", "read_history",
  "vault_search", "vault_read", "vault_links", "vault_append", "log_activity", "log_decision", "propose_change",
  "create_job", "list_jobs", "update_job", "delete_job",
  "create_artifact", "update_artifact", "share_file", "make_document", "read_document",
  "message_bot", "ask_team", "broadcast", "create_bot", "update_bot", "list_groups", "create_group",
  "ask_user", "notify_user", "propose_task", "skill_view",
  "find_skills", "suggest_skill", "find_plugins", "suggest_plugin",
];

// OpenCode brings its own file tools, and reaches the rest over the ravnir_ bridge.
const OPENCODE_FILE_TOOLS = { read_file: "read", write_file: "write", edit_file: "edit", search: "grep", list_dir: "ls" };

function unquote(value) {
  const text = String(value || "").trim();
  if (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

// Frontmatter is read as a flat YAML subset: top-level `key: value`, and `[a, b]` lists. Indented
// lines belong to a nested block (metadata:) and are skipped, which is all a SKILL.md needs.
export function parseSkill(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { meta: {}, body: source.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at < 1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const raw = line.slice(at + 1).trim();
    if (!key || !raw) continue;
    meta[key] = raw.startsWith("[") && raw.endsWith("]")
      ? raw.slice(1, -1).split(",").map(unquote).filter(Boolean)
      : unquote(raw);
  }
  return { meta, body: source.slice(match[0].length).trim() };
}

export function clipDescription(value, limit = DESCRIPTION_LIMIT) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "No description.";
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(1, limit - 3));
  const space = cut.lastIndexOf(" ");
  const head = (space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd();
  return `${head}...`;
}

function readEntry(file, dir, parts) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseSkill(raw);
  const name = String(meta.name || parts[parts.length - 1] || "").trim();
  if (!name) return null;
  const requires = Array.isArray(meta.requires) ? meta.requires : meta.requires ? [meta.requires] : [];
  return {
    name,
    title: String(meta.title || "") || titleOf(name),
    description: String(meta.description || ""),
    version: String(meta.version || ""),
    license: String(meta.license || ""),
    author: String(meta.author || ""),
    // Where the skill came from: a GitHub link pinned to a commit, or empty for one written here.
    source: String(meta.source || ""),
    requires: requires.map((item) => String(item).trim()).filter(Boolean),
    // A default skill is open to every agent, so a core ability (making a PDF) needs no setup.
    default: String(meta.default || "").toLowerCase() === "true",
    category: parts.length > 1 ? parts[0] : "",
    dir,
    file,
    body,
  };
}

function titleOf(name) {
  const words = String(name || "").split("-").filter(Boolean);
  if (!words.length) return "";
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(" ");
}

// Every skill under root: <root>/<category>/<name>/SKILL.md, or <root>/<name>/SKILL.md for a skill
// that needs no category.
export function discover(root = SKILLS_DIR) {
  const out = [];
  const stack = [{ dir: root, parts: [] }];
  while (stack.length) {
    const { dir, parts } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (parts.length && entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const found = readEntry(path.join(dir, "SKILL.md"), dir, parts);
      if (found) out.push(found);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      stack.push({ dir: path.join(dir, entry.name), parts: [...parts, entry.name] });
    }
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

// The skills this agent may open, in the order it was given them, capped so the index stays small.
// Default skills come after the ones the agent was given and count towards the same cap.
export function attachedTo(bot, { root = SKILLS_DIR } = {}) {
  const wanted = Array.isArray(bot?.skills) ? bot.skills : [];
  const found = discover(root);
  const all = new Map(found.map((entry) => [entry.name, entry]));
  const out = [];
  for (const entry of [...wanted.map((name) => all.get(String(name))), ...found.filter((item) => item.default)]) {
    if (entry && !out.includes(entry)) out.push(entry);
    if (out.length >= INDEX_LIMIT) break;
  }
  return out;
}

// How many skills an agent can be given on top of the default ones, which every agent already has.
export function skillRoom(found = discover()) {
  return Math.max(0, INDEX_LIMIT - found.filter((entry) => entry.default).length);
}

// What the shop shows for a skill: everything but the body, plus what it ships and what opening it costs.
export function describeSkill(entry) {
  const files = supportFiles(entry.dir);
  return {
    name: entry.name,
    title: entry.title,
    description: entry.description,
    category: entry.category,
    version: entry.version,
    author: entry.author,
    license: entry.license,
    source: entry.source,
    requires: entry.requires,
    default: entry.default,
    files,
    scripts: files.some((file) => file.startsWith("scripts/")),
    // A rough count, about four characters a token, of what the agent pays on the turn it opens it.
    tokens: Math.ceil(entry.body.length / 4),
  };
}

export function indexForBot(bot, options = {}) {
  const entries = attachedTo(bot, options);
  if (!entries.length) return "";
  const lines = ["<available_skills>"];
  let category;
  for (const entry of entries) {
    if (entry.category !== category) {
      category = entry.category;
      if (category) lines.push(`  ${category}:`);
    }
    lines.push(`  - ${entry.name}: ${clipDescription(entry.description)}`);
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

// Rewrite the canonical tool names in a skill for the provider this agent runs on.
export function renderSkill(text, provider = "") {
  const body = String(text || "");
  if (provider !== "opencode") return body;
  return body.replace(/`([^`\n]{1,80})`/g, (whole, inner) => {
    const token = /^([a-z][a-z0-9_]*)/.exec(inner);
    if (!token || !TOOLS.includes(token[1])) return whole;
    const name = token[1];
    return `\`${OPENCODE_FILE_TOOLS[name] || `ravnir_${name}`}${inner.slice(name.length)}\``;
  });
}

function supportFiles(dir, depth = 0, prefix = "") {
  const out = [];
  for (const name of SUPPORT_DIRS) {
    const full = path.join(dir, name);
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = `${prefix}${name}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < 1) out.push(...supportFiles(path.join(full, entry.name), depth + 1, `${rel}/`));
        continue;
      }
      out.push(rel);
      if (out.length >= MAX_LISTED_FILES) return out;
    }
  }
  return out;
}

function insideFile(dir, file) {
  const requested = String(file || "").trim();
  if (!requested) return "";
  if (path.isAbsolute(requested) || /^[a-z]:/i.test(requested) || requested.split(/[\\/]/).includes("..")) {
    throw new Error("Give a path inside the skill, like references/notes.md.");
  }
  const base = fs.realpathSync(dir);
  const target = path.resolve(base, requested);
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw new Error(`This skill has no file ${requested}. Open the skill on its own to see the files it ships.`);
  }
  if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error("That file is outside the skill.");
  if (!fs.statSync(real).isFile()) throw new Error(`${requested} is a folder, not a file.`);
  if (fs.statSync(real).size > MAX_FILE) throw new Error(`${requested} is too large to open; read it with run_command instead.`);
  return real;
}

// Open a skill an agent may use. file reads one of the files the skill ships.
export function readSkill(name, { bot, root = SKILLS_DIR, file = "", provider = "" } = {}) {
  const entries = attachedTo(bot, { root });
  const entry = entries.find((item) => item.name === String(name || "").trim());
  if (!entry) {
    const known = entries.map((item) => item.name).join(", ") || "none";
    throw new Error(`This agent has no skill called ${name || "(none)"}. It can open: ${known}.`);
  }
  const files = supportFiles(entry.dir);
  const wanted = insideFile(entry.dir, file);
  if (wanted) {
    const text = fs.readFileSync(wanted, "utf8");
    const rel = path.relative(fs.realpathSync(entry.dir), wanted).split(path.sep).join("/");
    return { name: entry.name, file: rel, files, text: `# ${entry.name}: ${rel}\n\n${text.trim()}` };
  }
  const footer = files.length
    ? `\n\nFiles this skill ships. Open one with skill_view and the file path, for example {"name": "${entry.name}", "file": "${files[0]}"}:\n${files.map((item) => `- ${item}`).join("\n")}`
    : "";
  return { name: entry.name, file: "", files, text: renderSkill(entry.body, provider) + footer };
}

// The standard a SKILL.md has to meet. The test runs this over every shipped skill, so the index
// cannot quietly rot into long descriptions or lose its headings.
export function checkSkill(entry) {
  const problems = [];
  const description = String(entry.description || "");
  if (!description) {
    problems.push("description is missing");
  } else {
    if (description.length > DESCRIPTION_LIMIT) problems.push(`description is ${description.length} characters, the limit is ${DESCRIPTION_LIMIT}`);
    if (!/[.!?]$/.test(description)) problems.push("description must end with a period");
  }
  if (!String(entry.body || "").trim()) problems.push("the body is empty");
  for (const section of ["## When to Use", "## Procedure"]) {
    if (!String(entry.body || "").includes(section)) problems.push(`missing section ${section}`);
  }
  if (/\/Users\/[a-z]|\/home\/[a-z]/.test(String(entry.body || ""))) problems.push("the body contains a home directory path");
  if (!entry.license) problems.push("license is missing");
  if (entry.source && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(tree|blob)\/[0-9a-f]{40}\//.test(entry.source)) {
    problems.push("source must be a GitHub link pinned to a commit");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(entry.name || ""))) problems.push("name must be lowercase letters, digits and dashes");
  return problems;
}
