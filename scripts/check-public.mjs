#!/usr/bin/env node
// Scans a checkout for private data before it is published: public IP addresses,
// Tailscale host names, personal home paths, email addresses, key material, token
// shapes, and every term listed in export/deny.txt. Exit 0 when clean, 1 when
// something was found, 2 on usage errors.
//
// Usage: node scripts/check-public.mjs [--root DIR] [--json] [--list-binaries | --accept-binaries]
//
// An allow marker on a line exempts only the generic rules it names (the words
// "check-public", a colon, "allow", then rule names separated by commas, for example
// "token" or "token,private-key"). A marker that names no rule or an unknown rule is
// itself a finding ("bad-allow"), and deny-list terms can never be exempted.
//
// Binary files (known extensions, a NUL byte in the first 8 KB, or over 256 MB) are not
// read as text. When export/binaries.txt exists, every kept binary must be listed there in
// sha256sum format ("<64 hex>  <path>") after a human looked at it; --list-binaries shows
// the ones that are not, and --accept-binaries writes them into the manifest. Symlinks in
// the kept file set are findings.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembled at runtime so this file does not contain a marker of its own.
export const ALLOW_MARKER = ["check-public", "allow"].join(": ");
const MARKER_RE = new RegExp(`${ALLOW_MARKER}(?:[ \\t]+([a-z0-9-]+(?:,[a-z0-9-]+)*))?`);
const MAX_TEXT_BYTES = 256 * 1024 * 1024;
export const BINARIES_FILE = "export/binaries.txt";
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".icns", ".pdf",
  ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tgz", ".br", ".7z", ".xz", ".bz2", ".wasm", ".sqlite", ".db", ".jar", ".class", ".pyc"
]);

const ALLOWED_EMAIL_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "users.noreply.github.com",
  "ravnir.local", "ravnir.dev", "localhost"
]);
// Reserved or non-routable top-level domains (RFC 2606 and 6761), plus systemd unit names such as user@1000.service.
const ALLOWED_EMAIL_TLDS = new Set(["example", "test", "local", "invalid", "localhost", "service"]);
const ALLOWED_HOME_NAMES = new Set([
  "shared", "you", "user", "username", "name", "runner", "ubuntu", "ravnir", "node", "ada", "alex", "me", "i", "azureuser"
]);
// Tailnet labels that are placeholders. A host with only two labels (host.ts.net) has no tailnet name at all.
const ALLOWED_TAILNETS = new Set(["example", "tailnet", "your-tailnet", "yourtailnet", "tailnet-name"]);

// ---- path matching (shared with the exporter) ------------------------------

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i++; } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// Gitignore-like rules anchored at the repository root: exact paths, directory
// prefixes ending in "/", and "*" globs. Returns (relPath) => boolean.
export function compileExcludes(text = "") {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.endsWith("/")) {
      const dir = line.slice(0, -1).replace(/^\/+/, "");
      rules.push((p) => p === dir || p.startsWith(`${dir}/`));
    } else if (/[*?]/.test(line)) {
      const re = globToRegExp(line.replace(/^\/+/, ""));
      rules.push((p) => {
        if (re.test(p)) return true;
        // A glob that names a directory also covers what is inside it.
        const parts = p.split("/");
        for (let n = 1; n < parts.length; n++) if (re.test(parts.slice(0, n).join("/"))) return true;
        return false;
      });
    } else {
      const exact = line.replace(/^\/+/, "");
      rules.push((p) => p === exact || p.startsWith(`${exact}/`));
    }
  }
  return (rel) => {
    const p = rel.split(path.sep).join("/");
    return rules.some((rule) => rule(p));
  };
}

// ---- file set --------------------------------------------------------------

function isRepoRoot(root) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    return fs.realpathSync(top) === fs.realpathSync(root);
  } catch { return false; }
}

function walk(root, dir = "", out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(rel);
  }
  return out;
}

// Tracked plus untracked-not-ignored files inside a git checkout, otherwise every file.
export function listFiles(root, { useGit = true } = {}) {
  let files;
  if (useGit && isRepoRoot(root)) {
    const raw = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root, maxBuffer: 256 * 1024 * 1024
    }).toString("utf8");
    files = [...new Set(raw.split("\0").filter(Boolean))];
    files = files.filter((f) => {
      try {
        const st = fs.lstatSync(path.join(root, f));
        return st.isFile() || st.isSymbolicLink();
      } catch { return false; }
    });
  } else {
    files = walk(root);
  }
  return files
    .filter((f) => !f.split("/").some((part) => SKIP_DIRS.has(part)))
    .sort();
}

function sha256File(abs) {
  const hash = createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

// { kind: "symlink" } | { kind: "binary", size } | { kind: "text", text }
function inspectFile(abs) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return { kind: "symlink" };
  if (BINARY_EXT.has(path.extname(abs).toLowerCase()) || st.size > MAX_TEXT_BYTES) return { kind: "binary", size: st.size };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return { kind: "binary", size: st.size };
  return { kind: "text", text: buf.toString("utf8") };
}

// ---- binary manifest -------------------------------------------------------

// sha256sum format: "<64 hex>  <path>" (a "*" before the path is accepted), # comments.
export function parseBinaries(text = "") {
  const map = new Map();
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`binaries manifest line ${i + 1} is not in sha256sum format`);
    map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

// ---- rules -----------------------------------------------------------------

export function parseDeny(text = "") {
  const terms = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    terms.push(line);
  }
  return terms;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function denyRegExp(terms) {
  if (!terms.length) return null;
  const parts = terms.map((term) => {
    const lead = /^\w/.test(term) ? "(?<![A-Za-z0-9_])" : "";
    const tail = /\w$/.test(term) ? "(?![A-Za-z0-9_])" : "";
    return `${lead}${escapeRe(term).replace(/\s+/g, "\\s+")}${tail}`;
  });
  return new RegExp(parts.join("|"), "gi");
}

function publicIpv4(match) {
  const o = match.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 127 || a === 10 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function allowedEmail(email, before) {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  // user:token@host inside a URL is not an address.
  if (/\/\/[^\s/@]*:$/.test(before) || /\/\/$/.test(before)) return true;
  if (local === "git" && domain === "github.com") return true;
  if (ALLOWED_EMAIL_DOMAINS.has(domain)) return true;
  const labels = domain.split(".");
  if (ALLOWED_EMAIL_TLDS.has(labels[labels.length - 1])) return true;
  return labels.slice(-2).join(".") === "example.com" || domain.endsWith(".example.com");
}

const RULES = [
  {
    rule: "ipv4",
    re: /(?<![\w])(?<!\w\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d|\.\d)/g,
    // "Chrome/124.0.0.0" style product versions are not addresses.
    flag: (m, line) => publicIpv4(m[0]) && !/[A-Za-z]\/$/.test(line.slice(0, m.index))
  },
  {
    rule: "tailscale-host",
    re: /(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)+ts\.net(?![A-Za-z0-9-])/gi,
    flag: (m) => {
      const labels = m[0].toLowerCase().split(".");
      if (labels.length < 4) return false; // host.ts.net, no tailnet name
      return !ALLOWED_TAILNETS.has(labels[labels.length - 3]);
    }
  },
  {
    rule: "home-path",
    re: /(?<![A-Za-z0-9_])\/(?:Users|home)\/([A-Za-z0-9_.-]+)/g,
    flag: (m) => !/^\.*$/.test(m[1]) && !ALLOWED_HOME_NAMES.has(m[1].toLowerCase())
  },
  {
    rule: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    // npm copies a package's own deprecation notice into the lockfile; its contact address is the
    // maintainer's published one, not ours.
    flag: (m, line) => !/^\s*"deprecated": "/.test(line) && !allowedEmail(m[0], line.slice(0, m.index))
  },
  { rule: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  {
    rule: "token",
    re: new RegExp([
      "(?<![A-Za-z0-9])(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}",
      "(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}",
      "(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}",
      "(?<![A-Za-z0-9])xox[bpas]-[0-9][A-Za-z0-9-]{9,}",
      "(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])"
    ].join("|"), "g")
  }
];

export function mask(text) {
  const s = String(text);
  if (s.length <= 6) return `${s.slice(0, 1)}***`;
  if (s.length <= 12) return `${s.slice(0, 2)}***${s.slice(-1)}`;
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

// Scan one text; returns [{ line, rule, excerpt }].
export function scanText(text, denyRe = null, { skipRules = [] } = {}) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const known = new Set(RULES.map((r) => r.rule));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let exempt = [];
    const marker = line.includes(ALLOW_MARKER) ? MARKER_RE.exec(line) : null;
    if (marker) {
      const names = marker[1] ? marker[1].split(",") : [];
      if (!names.length || names.some((n) => !known.has(n))) {
        findings.push({ line: i + 1, rule: "bad-allow", excerpt: marker[0].trim() });
      } else {
        exempt = names;
      }
    }
    for (const def of RULES) {
      if (skipRules.includes(def.rule) || exempt.includes(def.rule)) continue;
      def.re.lastIndex = 0;
      for (const m of line.matchAll(def.re)) {
        if (def.flag && !def.flag(m, line)) continue;
        findings.push({ line: i + 1, rule: def.rule, excerpt: mask(m[0]) });
      }
    }
    if (denyRe) {
      denyRe.lastIndex = 0;
      for (const m of line.matchAll(denyRe)) findings.push({ line: i + 1, rule: "deny", excerpt: mask(m[0]) });
    }
  }
  return findings;
}

// Scan a directory. Options: { exclude: (rel) => bool, deny: string[], useGit: boolean,
// binaries: Map(path -> sha256) | null }. With a manifest every kept binary must be listed
// with a matching hash; with null binaries are not checked. `binaries` in the result lists
// every kept binary with its hash and status (ok, unreviewed, changed) against the manifest.
export function scanRoot(root, { exclude = () => false, deny = [], useGit = true, binaries = null } = {}) {
  const denyRe = denyRegExp(deny);
  const findings = [];
  const found = [];
  let scanned = 0;
  for (const rel of listFiles(root, { useGit })) {
    if (exclude(rel)) continue;
    const abs = path.join(root, rel);
    const info = inspectFile(abs);
    if (info.kind === "symlink") {
      findings.push({ path: rel, rule: "symlink", excerpt: "symbolic link" });
      continue;
    }
    if (info.kind === "binary") {
      const sha256 = sha256File(abs);
      const listed = binaries ? binaries.get(rel) : undefined;
      const status = listed === undefined ? "unreviewed" : listed === sha256 ? "ok" : "changed";
      found.push({ path: rel, size: info.size, sha256, status });
      if (binaries && status !== "ok") findings.push({ path: rel, rule: `binary-${status}`, excerpt: `${info.size} bytes` });
      continue;
    }
    scanned++;
    // Path coordinates in SVG files look like dotted numbers.
    const skipRules = rel.toLowerCase().endsWith(".svg") ? ["ipv4"] : [];
    for (const f of scanText(info.text, denyRe, { skipRules })) findings.push({ path: rel, ...f });
  }
  return { scanned, findings, binaries: found };
}

export function loadPolicy(root) {
  const read = (name) => {
    try { return fs.readFileSync(path.join(root, "export", name), "utf8"); } catch { return null; }
  };
  const excludeText = read("exclude.txt");
  const denyText = read("deny.txt");
  const binariesText = read("binaries.txt");
  return {
    exclude: excludeText === null ? () => false : compileExcludes(excludeText),
    deny: denyText === null ? [] : parseDeny(denyText),
    binaries: binariesText === null ? null : parseBinaries(binariesText)
  };
}

export function formatFinding(f) {
  return f.line === undefined
    ? `${f.path}: ${f.rule}: ${f.excerpt}`
    : `${f.path}:${f.line}: ${f.rule}: ${f.excerpt}`;
}

// Writes or updates entries in export/binaries.txt: comments and existing lines stay,
// entries are sorted by path.
function acceptBinaries(root, entries) {
  const file = path.join(root, BINARIES_FILE);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* new manifest */ }
  const header = [];
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) { header.push(raw); continue; }
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`${BINARIES_FILE} has a line that is not in sha256sum format: ${line.slice(0, 40)}`);
    map.set(m[2], m[1].toLowerCase());
  }
  if (!header.length) header.push("# Binary files allowed into the public export, in sha256sum format.", "# Add an entry only after looking at the file itself.");
  for (const e of entries) map.set(e.path, e.sha256);
  const lines = [...map.keys()].sort().map((p) => `${map.get(p)}  ${p}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[...header, ...lines].join("\n")}\n`);
}

// ---- command line ----------------------------------------------------------

const USAGE = "Usage: node scripts/check-public.mjs [--root DIR] [--json] [--list-binaries | --accept-binaries]";

function main(argv) {
  let root = process.cwd();
  let json = false;
  let list = false;
  let accept = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--list-binaries") list = true;
    else if (arg === "--accept-binaries") accept = true;
    else if (arg === "--root") {
      if (!argv[i + 1]) { console.error("check-public: --root needs a directory"); return 2; }
      root = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return 0;
    } else {
      console.error(`check-public: unknown argument ${arg}`);
      console.error(USAGE);
      return 2;
    }
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`check-public: ${root} is not a directory`);
    return 2;
  }
  if (list && accept) {
    console.error("check-public: --list-binaries and --accept-binaries cannot be combined");
    return 2;
  }
  let policy;
  try { policy = loadPolicy(root); } catch (err) {
    console.error(`check-public: ${err.message}`);
    return 2;
  }
  const result = scanRoot(root, policy);
  if (list || accept) {
    const pending = result.binaries.filter((b) => b.status !== "ok");
    for (const b of pending) console.log(`${b.path}\t${b.size} bytes\t${b.sha256}\t${b.status}`);
    if (accept) {
      if (pending.length) {
        try { acceptBinaries(root, pending); } catch (err) {
          console.error(`check-public: ${err.message}`);
          return 2;
        }
      }
      console.error(`check-public: WARNING wrote ${pending.length} entr${pending.length === 1 ? "y" : "ies"} to ${BINARIES_FILE}. Run --accept-binaries only after looking at each file listed above.`);
    } else {
      console.error(`check-public: ${pending.length} binar${pending.length === 1 ? "y" : "ies"} unlisted or changed (${result.binaries.length} kept binaries in total)`);
    }
    return 0;
  }
  const { scanned, findings } = result;
  if (json) {
    console.log(JSON.stringify({ root, scanned, count: findings.length, findings }, null, 2));
  } else if (findings.length) {
    for (const f of findings) console.log(formatFinding(f));
    console.error(`check-public: ${findings.length} finding${findings.length === 1 ? "" : "s"} in ${new Set(findings.map((f) => f.path)).size} files (${scanned} files scanned)`);
  } else {
    console.log(`check-public: clean (${scanned} files scanned)`);
  }
  return findings.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
