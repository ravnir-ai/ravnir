import fs from "node:fs";
import path from "node:path";

// Read-only view of Ravnir's environment configuration for Settings > Server.
// A name is listed when the server code references it or when it is set in the
// process. A value is shown only for names on the allowlist below, and never for
// a name that looks like a secret.

// Names whose values are plain addresses, numbers, flags or model ids.
const SHOWN = new Set([
  "RAVNIR_PORT", "RAVNIR_HOST", "RAVNIR_PUBLIC_URL", "RAVNIR_BOX", "RAVNIR_BOX_IMAGE", "RAVNIR_BOX_MEMORY",
  "RAVNIR_BOX_CPUS", "RAVNIR_BOX_PIDS", "RAVNIR_BOX_NETWORK", "RAVNIR_APPROVAL_MINUTES", "RAVNIR_APPROVAL_BUDGET",
  "RAVNIR_TERMINAL_IDLE_MINUTES", "RAVNIR_QUICK", "RAVNIR_QUICK_MODEL", "RAVNIR_QUICK_URL", "RAVNIR_QUICK_PRICE",
  "RAVNIR_VAULT_WRITE", "RAVNIR_VAULT_PULL_MS", "RAVNIR_VAULT_SYNC_MS", "RAVNIR_VAULT_BRANCH",
  "RAVNIR_PLUGIN_RUNTIME", "RAVNIR_TTS_URL", "RAVNIR_TTS_MODEL", "RAVNIR_TTS_VOICE", "RAVNIR_TTS_VOICE_ES",
  "RAVNIR_TTS_VOICES", "RAVNIR_STT_URL", "RAVNIR_STT_MODEL", "RAVNIR_AI_MEMORY", "RAVNIR_MEMORY_WORKSPACE",
  "RAVNIR_MEMORY_PROJECT", "RAVNIR_OPENCODE_TIMEOUT_MS", "RAVNIR_OPENCODE_STALL_MS", "RAVNIR_OPENCODE_START_MS",
  "RAVNIR_TAILSCALE_SCAN", "RAVNIR_JOBS", "RAVNIR_VOICE_START_MS",
]);

// A secret-looking name never returns a value, even if someone adds it to the list above.
const SECRET_NAME = /KEY|TOKEN|PASS|SECRET|USER|CREDENTIAL|AUTH|COOKIE|SESSION/i;

export function secretLookingName(name) {
  return SECRET_NAME.test(name);
}

export function configValueVisible(name) {
  return SHOWN.has(name) && !secretLookingName(name);
}

// A URL value shows its address only: no credentials, no query string, no fragment.
function safeValue(raw) {
  const value = String(raw ?? "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.slice(0, 200);
  try {
    const url = new URL(value);
    if (url.username || url.password) return "";
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 200);
  } catch {
    return "";
  }
}

let referenced = null;

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

export function referencedEnvNames(serverDir) {
  if (referenced) return referenced;
  const names = new Set();
  try {
    for (const file of listJsFiles(serverDir)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bRAVNIR_[A-Z0-9_]+\b/g)) names.add(match[0]);
    }
  } catch {
    // An unreadable source tree just means a shorter list.
  }
  referenced = [...names];
  return referenced;
}

export function envConfig({ serverDir, env = process.env } = {}) {
  const names = new Set(referencedEnvNames(serverDir));
  for (const name of Object.keys(env)) if (/^RAVNIR_[A-Z0-9_]+$/.test(name)) names.add(name);
  return [...names].sort().map((name) => {
    const set = env[name] !== undefined && env[name] !== "";
    const entry = { name, set };
    if (set && configValueVisible(name)) entry.value = safeValue(env[name]);
    return entry;
  });
}
