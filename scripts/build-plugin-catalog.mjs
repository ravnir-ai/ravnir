#!/usr/bin/env node
// Build public/plugins/catalog.json from the Docker MCP registry plus a
// curated extras list. Icons are downloaded once into public/plugins/icons.
//
//   node scripts/build-plugin-catalog.mjs [--refresh-icons]
//
// The registry is cloned into a temp directory. YAML is parsed with PyYAML
// when available, otherwise with Ruby's yaml/json stdlib. No npm packages.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY_REPO = "https://github.com/docker/mcp-registry";
const ICONS_DIR = join(ROOT, "public", "plugins", "icons");
const CATALOG_FILE = join(ROOT, "public", "plugins", "catalog.json");
const EXTRAS_FILE = join(ROOT, "scripts", "plugin-extras.json");
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CONCURRENCY = 6;
const ICON_TIMEOUT_MS = 20_000;
const ICON_CONCURRENCY = 8;
const MAX_ICON_BYTES = 300 * 1024;
const USER_AGENT = "ravnir-plugin-catalog/1.0";
const SIMPLE_ICONS_VERSION = "15";
const SIMPLE_ICONS_BASE = `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}`;
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "Ravnir catalog probe", version: "1.0.0" },
  },
});
const ICON_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "ico", "webp"];
const EXT_BY_TYPE = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/ico": "ico",
  "image/webp": "webp",
};

const refreshIcons = process.argv.includes("--refresh-icons");

function log(message) {
  process.stderr.write(`${message}\n`);
}

function errorText(error) {
  const value = error?.cause?.code || error?.code || error?.name || error?.message || error;
  return String(value).slice(0, 200);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function detectYamlRoute() {
  try {
    execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" });
    return "python3";
  } catch {
    // fall through to Ruby
  }
  try {
    execFileSync("ruby", ["-ryaml", "-rjson", "-e", "exit 0"], { stdio: "ignore" });
    return "ruby";
  } catch {
    return "";
  }
}

function readRegistry(dir) {
  const route = detectYamlRoute();
  if (!route) {
    throw new Error("No YAML parser available: install PyYAML for python3 or use ruby with yaml/json.");
  }
  const python = [
    "import sys, os, json, glob, yaml",
    "base = sys.argv[1]",
    "out = {}",
    "for path in sorted(glob.glob(os.path.join(base, 'servers', '*', 'server.yaml'))):",
    "    key = os.path.basename(os.path.dirname(path))",
    "    with open(path, encoding='utf-8') as handle:",
    "        out[key] = yaml.safe_load(handle)",
    "json.dump(out, sys.stdout)",
  ].join("\n");
  const ruby = [
    "require 'yaml'",
    "require 'json'",
    "base = ARGV[0]",
    "out = {}",
    "Dir.glob(File.join(base, 'servers', '*', 'server.yaml')).sort.each do |path|",
    "  out[File.basename(File.dirname(path))] = YAML.load_file(path)",
    "end",
    "STDOUT.write(JSON.generate(out))",
  ].join("\n");
  log(`yaml parser: ${route}`);
  const raw =
    route === "python3"
      ? execFileSync("python3", ["-c", python, dir], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })
      : execFileSync("ruby", ["-ryaml", "-rjson", "-e", ruby, dir], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(raw);
}

function remoteHost(url) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function looksLikePathParameter(key, description) {
  const name = String(key).toLowerCase();
  if (name.includes("profile")) return false;
  if (/(^|_)(path|paths|dir|dirs|directory|directories|file|files|volume|volumes|mount|mounts)(_|$)/.test(name)) {
    return true;
  }
  if (/path|directory|folder|volume|mount/i.test(name)) return true;
  return /\b(path|directory|folder|volume|mount)\b/i.test(String(description || ""));
}

function hasPathParameters(entry) {
  const properties = entry?.config?.parameters?.properties;
  if (!properties || typeof properties !== "object") return false;
  return Object.entries(properties).some(([key, value]) => looksLikePathParameter(key, value?.description));
}

function registrySecrets(entry) {
  const secrets = entry?.config?.secrets;
  if (!Array.isArray(secrets)) return [];
  return secrets.map((secret) => ({
    key: secret.env || secret.name || "",
    name: secret.name || secret.env || "",
    description: secret.description || "",
    example: secret.example || "",
  }));
}

function registryEnv(entry) {
  const env = entry?.config?.env;
  const rows = Array.isArray(env)
    ? env.map((item) => ({
        key: item.name || "",
        value: item.value ?? "",
        description: item.description || "",
      }))
    : [];
  const parameters = entry?.config?.parameters;
  const properties = parameters?.properties;
  if (properties && typeof properties === "object") {
    const required = Array.isArray(parameters.required) ? parameters.required : [];
    for (const [key, value] of Object.entries(properties)) {
      rows.push({
        key,
        description: value?.description || "",
        required: required.includes(key),
      });
    }
  }
  return rows;
}

function registryPlugin(entry, id) {
  const remoteUrl = entry?.remote?.url || "";
  const remote = entry?.type === "remote" && remoteUrl
    ? {
        url: remoteUrl,
        transport: entry.remote.transport_type === "sse" ? "sse" : "streamable-http",
      }
    : null;
  const secrets = registrySecrets(entry);
  return {
    id,
    name: entry?.about?.title || entry?.name || id,
    description: entry?.about?.description || "",
    category: entry?.meta?.category || "other",
    tags: uniqueStrings(Array.isArray(entry?.meta?.tags) ? entry.meta.tags : []),
    icon: "",
    homepage: entry?.source?.project || "",
    featured: false,
    kind: entry?.type === "remote" ? "remote" : "container",
    remote,
    auth: entry?.type === "remote" ? "open" : secrets.length ? "secrets" : "none",
    tokenHeader: "",
    tokenHelp: "",
    image: entry?.image || "",
    secrets,
    env: registryEnv(entry),
    shellEnv: [],
    requiresVolumes: Boolean(entry?.run?.volumes?.length || hasPathParameters(entry)),
    probe: null,
  };
}

function extrasPlugin(extra) {
  return {
    id: extra.id,
    name: extra.name,
    description: extra.description || "",
    category: extra.category || "other",
    tags: [extra.category || "other"],
    icon: "",
    homepage: extra.homepage || "",
    featured: true,
    kind: "remote",
    remote: {
      url: extra.remote.url,
      transport: extra.remote.transport === "sse" ? "sse" : "streamable-http",
    },
    auth: extra.auth || "open",
    tokenHeader: extra.tokenHeader || "",
    tokenHelp: extra.tokenHelp || "",
    image: "",
    secrets: [],
    env: [],
    shellEnv: Array.isArray(extra.shellEnv) ? extra.shellEnv : [],
    requiresVolumes: false,
    probe: null,
  };
}

async function fetchJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return null;
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function resourceMetadataFromChallenge(challenge) {
  const quoted = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge);
  if (quoted) return quoted[1];
  const bare = /resource_metadata\s*=\s*([^\s,]+)/i.exec(challenge);
  return bare ? bare[1] : "";
}

function firstAuthorizationServer(json) {
  if (!json) return "";
  const list = Array.isArray(json.authorization_servers)
    ? json.authorization_servers
    : json.authorization_server
      ? [json.authorization_server]
      : [];
  return typeof list[0] === "string" ? list[0] : "";
}

function authorizationServerCandidates(serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    return [];
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  const segments = [".well-known/oauth-authorization-server", ".well-known/openid-configuration"];
  const candidates = [];
  for (const segment of segments) {
    candidates.push(path ? `${url.origin}/${segment}/${path}` : `${url.origin}/${segment}`);
  }
  if (path) candidates.push(`${url.origin}/.well-known/openid-configuration`);
  return [...new Set(candidates)];
}

async function probeRemote(url) {
  const probe = {
    checkedAt: new Date().toISOString(),
    status: 0,
    resourceMetadata: "",
    authorizationServer: "",
    registration: false,
    cimd: false,
    error: "",
  };
  let status = 0;
  let challenge = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": USER_AGENT,
      },
      body: INITIALIZE_BODY,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    status = response.status;
    challenge = response.headers.get("www-authenticate") || "";
    if (response.body) await response.body.cancel().catch(() => {});
  } catch (error) {
    probe.error = errorText(error);
    return probe;
  }
  probe.status = status;
  if (status >= 200 && status < 300) return probe;
  if (status !== 401) {
    probe.error = `HTTP ${status}`;
    return probe;
  }

  const target = new URL(url);
  let metadataUrl = "";
  const fromChallenge = resourceMetadataFromChallenge(challenge);
  if (fromChallenge) {
    try {
      metadataUrl = new URL(fromChallenge, url).toString();
    } catch {
      metadataUrl = "";
    }
  }
  if (!metadataUrl) {
    const base = `${target.origin}/.well-known/oauth-protected-resource`;
    const path = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
    const candidates = path ? [`${base}${path}`, base] : [base];
    for (const candidate of candidates) {
      const json = await fetchJson(candidate);
      if (json && (json.authorization_servers || json.authorization_server || json.resource)) {
        metadataUrl = candidate;
        probe.resourceMetadata = candidate;
        probe.authorizationServer = firstAuthorizationServer(json);
        break;
      }
    }
  } else {
    probe.resourceMetadata = metadataUrl;
    const json = await fetchJson(metadataUrl);
    probe.authorizationServer = firstAuthorizationServer(json);
  }

  if (!probe.authorizationServer) return probe;
  for (const candidate of authorizationServerCandidates(probe.authorizationServer)) {
    const json = await fetchJson(candidate);
    if (!json) continue;
    probe.registration = Boolean(json.registration_endpoint);
    probe.cimd = json.client_id_metadata_document_supported === true;
    break;
  }
  return probe;
}

function classifyProbe(probe) {
  if (probe.status >= 200 && probe.status < 300) return "open";
  if (probe.status === 401) {
    if (probe.registration) return "oauth-dcr";
    if (probe.cimd) return "oauth-cimd";
    return "oauth-manual";
  }
  return "unreachable";
}

function applyFill(svg, hex) {
  return svg.replace(/<svg\b([^>]*)>/i, (match, attributes) => {
    if (/\sfill\s*=/i.test(attributes)) return match;
    return `<svg${attributes} fill="#${hex}">`;
  });
}

function looksLikeSvg(buffer) {
  return buffer.slice(0, 300).toString("utf8").toLowerCase().includes("<svg");
}

function extensionFromUrl(url) {
  try {
    const ext = extname(new URL(url).pathname).replace(/^\./, "").toLowerCase();
    return ICON_EXTENSIONS.includes(ext) ? ext : "";
  } catch {
    return "";
  }
}

async function loadSimpleIcons() {
  const candidates = ["data/simple-icons.json", "_data/simple-icons.json", "icons.json"];
  for (const candidate of candidates) {
    const json = await fetchJson(`${SIMPLE_ICONS_BASE}/${candidate}`, 30_000);
    if (Array.isArray(json) && json.length) {
      const colors = new Map();
      for (const icon of json) {
        if (icon?.slug && icon?.hex) colors.set(icon.slug, icon.hex);
      }
      log(`simple-icons: ${colors.size} slugs from ${candidate}`);
      return colors;
    }
  }
  log("simple-icons: data file not found, icons will be left unfilled");
  return new Map();
}

async function downloadSimpleIcon(slug, id, colors) {
  try {
    const response = await fetch(`${SIMPLE_ICONS_BASE}/icons/${slug}.svg`, {
      headers: { accept: "image/svg+xml", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return "";
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) return "";
    let svg = buffer.toString("utf8");
    const hex = colors.get(slug);
    if (hex) svg = applyFill(svg, hex);
    await writeFile(join(ICONS_DIR, `${id}.svg`), svg);
    return `icons/${id}.svg`;
  } catch {
    return "";
  }
}

async function downloadRemoteIcon(url, id) {
  try {
    const response = await fetch(url, {
      headers: { accept: "image/*,*/*;q=0.8", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return "";
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_ICON_BYTES) {
      if (response.body) await response.body.cancel().catch(() => {});
      return "";
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) return "";
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    let ext = EXT_BY_TYPE[contentType] || extensionFromUrl(url) || "png";
    if (ext === "png" && looksLikeSvg(buffer)) ext = "svg";
    await writeFile(join(ICONS_DIR, `${id}.${ext}`), buffer);
    if (buffer.length > SHRINK_OVER_BYTES && RASTER_EXTENSIONS.includes(ext)) shrinkIcon(join(ICONS_DIR, `${id}.${ext}`));
    return `icons/${id}.${ext}`;
  } catch {
    return "";
  }
}

// Registry icons are sometimes full-size artwork. Cards show them at 40 px, so
// anything big is cut to 128 px with sips (macOS) or ImageMagick (Linux).
const SHRINK_OVER_BYTES = 24 * 1024;
const RASTER_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

function shrinkIcon(file) {
  for (const [command, args] of [["sips", ["-Z", "128", file]], ["convert", [file, "-resize", "128x128>", file]]]) {
    try {
      execFileSync(command, args, { stdio: "ignore", timeout: 15_000 });
      return;
    } catch {}
  }
}

async function buildIcons(plugins, extrasById, registryIcons) {
  await mkdir(ICONS_DIR, { recursive: true });
  const files = await readdir(ICONS_DIR).catch(() => []);
  const existing = new Map();
  for (const name of files.sort()) {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const id = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase();
    if (!ICON_EXTENSIONS.includes(ext)) continue;
    if (!existing.has(id)) existing.set(id, name);
  }
  const colors = await loadSimpleIcons();
  let done = 0;
  await mapLimit(plugins, ICON_CONCURRENCY, async (plugin) => {
    if (!refreshIcons && existing.has(plugin.id)) {
      plugin.icon = `icons/${existing.get(plugin.id)}`;
    } else {
      let icon = "";
      const extra = extrasById.get(plugin.id);
      if (extra?.simpleIcon) {
        icon = await downloadSimpleIcon(extra.simpleIcon, plugin.id, colors);
        if (!icon) log(`icon fallback: ${plugin.id} (simple-icons/${extra.simpleIcon} unavailable)`);
      }
      if (!icon) {
        const source = registryIcons.get(plugin.id);
        if (source) icon = await downloadRemoteIcon(source, plugin.id);
      }
      plugin.icon = icon;
      if (!icon) log(`icon missing: ${plugin.id}`);
    }
    done += 1;
    if (done % 25 === 0) log(`icons: ${done}/${plugins.length}`);
  });
  return plugins.filter((plugin) => !plugin.icon).length;
}

function probeLine(plugin) {
  const probe = plugin.probe || {};
  return [
    `${plugin.id}: status=${probe.status || 0}`,
    `auth=${plugin.auth}`,
    `registration=${Boolean(probe.registration)}`,
    `cimd=${Boolean(probe.cimd)}`,
    `resource=${probe.resourceMetadata || "-"}`,
    `as=${probe.authorizationServer || "-"}`,
    probe.error ? `error=${probe.error}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function main() {
  const started = Date.now();
  const temp = await mkdtemp(join(tmpdir(), "ravnir-plugin-catalog-"));
  try {
    log(`cloning ${REGISTRY_REPO}`);
    execFileSync("git", ["clone", "--depth", "1", REGISTRY_REPO, temp], { stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).trim();
    log(`registry commit ${commit}`);

    const registry = readRegistry(temp);
    const extras = JSON.parse(await readFile(EXTRAS_FILE, "utf8"));
    const extrasById = new Map(extras.map((extra) => [extra.id, extra]));
    const extrasHosts = new Set(extras.map((extra) => remoteHost(extra.remote?.url)).filter(Boolean));
    const registryIcons = new Map();
    for (const [dir, entry] of Object.entries(registry)) {
      registryIcons.set(entry?.name || dir, entry?.about?.icon || "");
    }

    const registryPlugins = [];
    for (const [dir, entry] of Object.entries(registry)) {
      if (!entry || (entry.type !== "remote" && entry.type !== "server")) continue;
      const id = entry.name || dir;
      if (extrasById.has(id)) continue;
      if (entry.type === "remote" && extrasHosts.has(remoteHost(entry.remote?.url))) continue;
      registryPlugins.push(registryPlugin(entry, id));
    }
    registryPlugins.sort((a, b) => a.name.localeCompare(b.name, "en"));
    const plugins = [...extras.map(extrasPlugin), ...registryPlugins];

    const remotePlugins = plugins.filter((plugin) => plugin.kind === "remote" && plugin.remote?.url);
    log(`probing ${remotePlugins.length} remote servers`);
    let probed = 0;
    await mapLimit(remotePlugins, PROBE_CONCURRENCY, async (plugin) => {
      const probe = await probeRemote(plugin.remote.url);
      plugin.probe = probe;
      if (!extrasById.get(plugin.id)?.auth) plugin.auth = classifyProbe(probe);
      probed += 1;
      if (probed % 10 === 0) log(`probed: ${probed}/${remotePlugins.length}`);
    });

    log(`icons for ${plugins.length} plugins`);
    const missingIcons = await buildIcons(plugins, extrasById, registryIcons);

    const catalog = {
      generatedAt: new Date().toISOString(),
      source: `docker/mcp-registry@${commit}`,
      plugins,
    };
    await mkdir(join(ROOT, "public", "plugins"), { recursive: true });
    await writeFile(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`);

    const remoteCount = plugins.filter((plugin) => plugin.kind === "remote").length;
    log(
      `wrote ${plugins.length} plugins (${remoteCount} remote, ${plugins.length - remoteCount} container), ` +
        `${missingIcons} without icon in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    log("featured probes:");
    for (const plugin of plugins.filter((entry) => entry.featured)) log(`  ${probeLine(plugin)}`);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  log(`failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
