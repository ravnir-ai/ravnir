// Backup models: when an agent's model fails at the provider (an outage, a rate limit, a
// model it no longer serves, a reply that never comes), the turn moves to the next model
// in the agent's chain instead of failing. Stops, caps and the agent's own mistakes never
// fall back: another model would not fix them.

export const MAX_FALLBACKS = 3;

const PROVIDER_FAILURE = [
  /^OpenCode: /,
  /^OpenCode reported /,
  /^OpenCode (timed out|stalled) before it replied/,
  /^OpenCode did not respond/,
  /does not offer the model/,
  /^The API returned (40[0-4]|408|409|425|429|5\d\d)\b/,
  /^Could not reach /,
  /operation was aborted/i,
  /fetch failed/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/,
];

export function canFallBack(error) {
  if (!error || error.capped) return false;
  const message = String(error.message || "");
  if (!message || /Stopped\.?$/.test(message)) return false;
  return PROVIDER_FAILURE.some((pattern) => pattern.test(message));
}

// A model whose sign-in expired or whose plan ran out fails the same way on every turn.
// It is skipped for a while (in memory, so a restart tries it again) and the chain starts
// at the next one. A model that answers is cleared.
const AUTH_FAILURE = /\b40[13]\b|invalid_grant|refresh (token )?failed|unauthori[sz]ed|not (logged|signed) in|authenticat|subscription|api key/i;
const LIMIT_FAILURE = /\b429\b|rate.?limit|usage limit|quota|exceeded|insufficient/i;
const AUTH_PAUSE_MS = 6 * 60 * 60_000;
const LIMIT_PAUSE_MS = 30 * 60_000;
const paused = new Map();

function keyOf(model = {}) {
  return `${model.provider || "opencode"}|${String(model.baseUrl || "")}|${model.model || ""}`;
}

export function noteFailure(model, error, now = Date.now()) {
  const message = String(error?.message || error || "");
  const ms = AUTH_FAILURE.test(message) ? AUTH_PAUSE_MS : LIMIT_FAILURE.test(message) ? LIMIT_PAUSE_MS : 0;
  if (ms) paused.set(keyOf(model), { until: now + ms, error: message.slice(0, 300) });
}

export function noteSuccess(model) {
  paused.delete(keyOf(model));
}

// The chain without the models paused right now, and the ones it skipped. When every model
// is paused, the whole chain is tried: a stale pause must not leave the agent with nothing.
export function usableChain(chain, now = Date.now()) {
  const skipped = [];
  const usable = chain.filter((model) => {
    const pause = paused.get(keyOf(model));
    if (!pause || pause.until <= now) return true;
    skipped.push({ model: model.model, error: `Skipped: failed recently. ${pause.error}`.slice(0, 300), skipped: true });
    return false;
  });
  return usable.length ? { usable, skipped } : { usable: chain, skipped: [] };
}

export function clearPauses() {
  paused.clear();
}

// The models a turn may use, in order: the agent's own, then its backups (no repeats).
export function modelChain(model = {}) {
  const chain = [model];
  for (const item of Array.isArray(model.fallbacks) ? model.fallbacks : []) {
    if (!item?.model || chain.some((seen) => sameModel(seen, item))) continue;
    chain.push(item);
    if (chain.length > MAX_FALLBACKS) break;
  }
  return chain;
}

function sameModel(a, b) {
  return a.model === b.model && (a.provider || "opencode") === (b.provider || "opencode") && String(a.baseUrl || "") === String(b.baseUrl || "");
}

// A backup entry keeps only the fields a provider needs; it never carries its own backups.
export function backupEntry(model = {}) {
  return {
    provider: model.provider === "openai" ? "openai" : "opencode",
    baseUrl: String(model.baseUrl || "").replace(/\/+$/, ""),
    username: String(model.username || "opencode"),
    model: String(model.model || ""),
    agent: String(model.agent || ""),
    ...(model.connection ? { connection: model.connection } : {}),
  };
}

// What the next model is told when the previous one failed partway through the task. With sameModel,
// the same model starts again in a fresh session after its last one stopped responding.
export function handoverNote(failedModel, reason, toolLog = [], { sameModel = false } = {}) {
  const done = toolLog.slice(-20).map((line) => `- ${line}`).join("\n");
  return [
    sameModel
      ? `(Ravnir: your previous attempt at this task stopped partway (${oneLine(reason, 200)}) and this is a fresh session.`
      : `(Ravnir: the previous model, ${failedModel}, failed partway through this task: ${oneLine(reason, 200)}. You are taking over.`,
    done ? `It already ran these tools, so their effects may already be real:\n${done}\nDo not repeat an action that changes something (a message sent, a file written, a purchase, a post) without checking first whether it already happened.` : "",
    "Finish the task and end with the result for the user.)",
  ].filter(Boolean).join("\n");
}

export function toolLine(event = {}) {
  const input = event.input && typeof event.input === "object" ? JSON.stringify(event.input) : String(event.input || "");
  // A call still running when the session was dropped has no result, but may have done its work.
  const state = event.status === "error"
    ? " (failed)"
    : event.status === "running" || event.status === "pending"
      ? " (started, no result came back: it may still be running or may already have taken effect)"
      : "";
  return `${event.name || "tool"} ${oneLine(input, 160)}${state}`;
}

function oneLine(text, max) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
