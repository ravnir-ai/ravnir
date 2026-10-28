// Common key and token shapes. Anything that matches is replaced before text is
// stored, so a pasted secret never lands in a prompt, a note, a routine or a memory.
const MASK = "[redacted]";
const KEYWORD = String.raw`(?:pass(?:word|wd)?|api[_ -]?key|(?:[a-z]+[_ -])?key|secret|token)`;
const PATTERNS = [
  /-----BEGIN [A-Z ]*(?:PRIVATE )?KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*KEY(?: BLOCK)?-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];
// "api key: abc..." or "token=abc...", and also JSON-style "password": "abc...".
const ASSIGNED = new RegExp(String.raw`(\b${KEYWORD}\b["']?\s*[:=]\s*["']?)([^\s"',;]{12,})`, "gi");

export function redactSecrets(input) {
  let text = String(input ?? "");
  let found = 0;
  const mask = () => {
    found += 1;
    return MASK;
  };
  for (const pattern of PATTERNS) text = text.replace(pattern, mask);
  text = text.replace(ASSIGNED, (match, lead, value) => {
    if (value === MASK) return match;
    found += 1;
    return `${lead}${MASK}`;
  });
  return { text, found };
}

export function hasSecret(input) {
  return redactSecrets(input).found > 0;
}
