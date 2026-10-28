import { hasSecret } from "../redact.js";

// Text that goes into the shared vault is synced to GitHub, so anything that looks like a
// secret is refused instead of masked. Returns a short reason, or "" when the text is clean.
// Links are what bots log most (posts, commits, clips), so public URLs are not judged by
// randomness; only URLs known to carry a secret are refused.

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const ENV_LINE = /^\s*(export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*\S{8,}/m;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
const URLS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"'`]+/gi;
const SECRET_URLS = [
  /hooks\.slack\.com\/services\//i,
  /discord(?:app)?\.com\/api\/webhooks\//i,
  /api\.telegram\.org\/bot\d+:/i,
  /[?&#](?:key|api[_-]?key|token|access[_-]?token|auth|sig|signature|secret|password|pwd)=/i,
];
const TELEGRAM_TOKEN = /\b\d{8,10}:[A-Za-z0-9_-]{30,}/;
// "the API key is AbC123...", "token xyz...": a long code right after the word. Word edges use
// Unicode letters because \b treats "ñ" as a non-letter.
const NEAR_WORD = /(?<![\p{L}\p{N}])(?:api[ _-]?key|keys?|tokens?|secrets?|passwords?|passwd|contraseñas?|claves?|pin)(?![\p{L}\p{N}])[^\n]{0,30}?([A-Za-z0-9_+=-]{16,})/giu;
// Passwords are often short: "contraseña del panel: Verano2026", "the password is hunter22".
const PASSWORD = /(?<![\p{L}\p{N}])(?:passwords?|passwd|contraseñas?|pin)(?![\p{L}\p{N}])[^\n:=]{0,25}(?:[:=]|\s(?:es|is)\s)\s*\S{6,}/iu;
const RUN = /[A-Za-z0-9+_=-]{32,}/g;
const ENTROPY_BITS = 4.2;

function entropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const mixed = (run) => /[A-Za-z]/.test(run) && /\d/.test(run);

export function findSecret(text) {
  const value = String(text ?? "");
  if (hasSecret(value)) return "looks like a key, token or password";
  if (JWT.test(value)) return "looks like a JWT";
  if (value.includes("op://")) return "looks like a 1Password reference";
  if (ENV_LINE.test(value)) return "looks like a .env line";
  if (URL_PASSWORD.test(value)) return "looks like a URL with a password";
  const urls = value.match(URLS) || [];
  if (urls.some((url) => SECRET_URLS.some((pattern) => pattern.test(url)))) return "looks like a link that carries a secret";
  if (TELEGRAM_TOKEN.test(value)) return "looks like a bot token";
  const prose = value.replace(URLS, " ");
  if (PASSWORD.test(prose)) return "looks like a password";
  for (const match of prose.matchAll(NEAR_WORD)) {
    if (mixed(match[1])) return "looks like a key next to the word key, token or password";
  }
  for (const run of prose.match(RUN) || []) {
    if (mixed(run) && entropy(run) >= ENTROPY_BITS) return "looks like a random token";
  }
  return "";
}
