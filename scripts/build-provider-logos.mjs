#!/usr/bin/env node
// Download the logo of every model provider listed by models.dev into
// public/plugins/providers/<id>.svg, then write index.json (the ids that made
// it) and LICENSE (the models.dev MIT notice) next to them.
//
//   node scripts/build-provider-logos.mjs
//
// Providers come from https://models.dev/api.json, logos from
// https://models.dev/logos/<id>.svg. models.dev answers 200 with a generic
// fallback icon for ids without a logo, so that icon is fetched first and any
// identical body is skipped as "no logo". Every SVG is checked before it is
// written; anything with script, foreignObject, entity or external references
// is skipped as "unsafe". No npm packages.

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "public", "plugins", "providers");
const API_URL = "https://models.dev/api.json";
const LOGO_BASE = "https://models.dev/logos/";
const FALLBACK_URL = `${LOGO_BASE}__ravnir_missing__.svg`;
const LICENSE_URL = "https://raw.githubusercontent.com/sst/models.dev/dev/LICENSE";
const USER_AGENT = "ravnir-logo-builder/1.0";
const CONCURRENCY = 8;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 65_536;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const XML_DECLARATION = /^\s*<\?xml[^>]*\?>/i;
const UNSAFE_PATTERNS = [
  /<script/i,
  /<foreignObject/i,
  /javascript:/i,
  /\son[a-z]+\s*=/i,
  /<!ENTITY/i,
  /<!DOCTYPE/i,
  /<image/i,
  /<iframe/i,
  /@import/i,
  /href\s*=\s*["'](?!#)/i,
  /url\(\s*["']?(?!#)/i,
];

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

// `limit` stops reading a body past that many bytes (logos), so a huge answer is never buffered.
async function request(url, retry = false, limit = Infinity) {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      if (retry && response.status >= 500) return request(url, false, limit);
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel().catch(() => {});
      return { ok: true, status: response.status, buffer: Buffer.alloc(limit + 1) };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      chunks.push(chunk);
      if (size > limit) break;
    }
    const buffer = Buffer.concat(chunks);
    return { ok: true, status: response.status, buffer };
  } catch (error) {
    if (retry) return request(url, false, limit);
    return { ok: false, status: 0, error: errorText(error) };
  }
}

async function requestText(url) {
  const result = await request(url);
  if (!result.ok) throw new Error(`${url}: ${result.error}`);
  return result.buffer.toString("utf8");
}

function cleanSvg(text) {
  return text.replace(XML_DECLARATION, "").trim();
}

function unsafeReason(body) {
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(body)) return pattern.source;
  }
  if (!body.startsWith("<svg")) return "not an svg";
  return "";
}

async function loadProviderIds() {
  const json = JSON.parse(await requestText(API_URL));
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`${API_URL}: expected an object keyed by provider id`);
  }
  return Object.keys(json).filter((id) => ID_PATTERN.test(id));
}

async function loadFallback() {
  return cleanSvg(await requestText(FALLBACK_URL));
}

async function downloadLogo(id, fallback) {
  const result = await request(`${LOGO_BASE}${id}.svg`, true, MAX_BYTES);
  if (!result.ok) return { id, status: "failed", detail: result.error };
  if (result.buffer.length > MAX_BYTES) return { id, status: "unsafe", detail: "too large" };
  const body = cleanSvg(result.buffer.toString("utf8"));
  if (body === fallback) return { id, status: "missing" };
  const reason = unsafeReason(body);
  if (reason) return { id, status: "unsafe", detail: reason };
  await writeFile(join(OUT_DIR, `${id}.svg`), `${body}\n`);
  return { id, status: "written" };
}

async function pruneStaleSvgs(keep) {
  const files = await readdir(OUT_DIR).catch(() => []);
  let removed = 0;
  for (const name of files) {
    if (!name.toLowerCase().endsWith(".svg")) continue;
    if (keep.has(name.slice(0, -4))) continue;
    await unlink(join(OUT_DIR, name)).catch(() => {});
    removed += 1;
  }
  return removed;
}

async function main() {
  const started = Date.now();
  log(`providers: ${API_URL}`);
  const ids = await loadProviderIds();
  if (!ids.length) throw new Error(`${API_URL}: no provider ids matched`);
  log(`providers: ${ids.length} ids`);

  log("fallback icon probe");
  const fallback = await loadFallback();
  if (!fallback.startsWith("<svg")) throw new Error(`${FALLBACK_URL}: not an svg`);

  log("license");
  const license = await requestText(LICENSE_URL);
  if (!license.trim()) throw new Error(`${LICENSE_URL}: empty body`);

  await mkdir(OUT_DIR, { recursive: true });

  const written = [];
  const missing = [];
  const unsafe = [];
  const failed = [];
  let done = 0;
  await mapLimit(ids, CONCURRENCY, async (id) => {
    const result = await downloadLogo(id, fallback);
    if (result.status === "written") written.push(id);
    else if (result.status === "missing") missing.push(id);
    else if (result.status === "unsafe") {
      unsafe.push(id);
      log(`unsafe: ${id} (${result.detail})`);
    } else {
      failed.push(id);
      log(`failed: ${id} (${result.detail})`);
    }
    done += 1;
    if (done % 50 === 0) log(`logos: ${done}/${ids.length}`);
  });

  written.sort();
  await writeFile(join(OUT_DIR, "index.json"), `${JSON.stringify(written)}\n`);
  await writeFile(
    join(OUT_DIR, "LICENSE"),
    "Provider logos in this folder come from models.dev (https://models.dev), used under the MIT License below.\n\n" +
      `${license.trimEnd()}\n`,
  );
  const removed = await pruneStaleSvgs(new Set(written));

  const summarize = (label, list) => `${label} ${list.length}${list.length ? ` (${list.sort().join(", ")})` : ""}`;
  log(`pruned ${removed} stale svg`);
  log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  process.stdout.write(`written ${written.length}; no logo ${missing.length}; ${summarize("unsafe", unsafe)}; ${summarize("failed", failed)}\n`);
}

main().catch((error) => {
  log(`stopped: ${error?.stack || error}`);
  process.exitCode = 1;
});
