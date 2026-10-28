// The fast half of a voice exchange. The user's words go to the small quick
// model with a short context, its reply streams back sentence by sentence, and
// anything that needs real work is handed to the agent as a normal turn. The
// agent then answers through the usual event stream, and the client reads that
// answer aloud.
import crypto from "node:crypto";
import { detectLanguage } from "../public/speakable.js";
import { addUsage } from "./quick.js";
import { appendConversation, readConversation } from "./state.js";

export const START_TIMEOUT_MS = 8_000;
const TOTAL_TIMEOUT_MS = 60_000;
// The quick model may think before it speaks, and those tokens count against the limit.
const MAX_TOKENS = 700;
const MARKER = "[[DELEGATE:";
const VOICE_NOTE = "The user is on a voice call and your final reply will be read aloud. Do the work, then end with a short plain-language summary in the user's language: no markdown, no lists, no links.";
const CAPPED = {
  en: "I have reached my daily limit, so I cannot take that on today.",
  es: "He llegado a mi límite diario, así que hoy no puedo encargarme de eso.",
};

function snip(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function voicePrompt(bot, { now = new Date() } = {}) {
  const memory = [];
  let used = 0;
  for (const item of bot.memory || []) {
    const line = `- ${snip(item.text, 300)}`;
    if (used + line.length > 1000) break;
    memory.push(line);
    used += line.length;
  }
  return [
    `You are ${bot.name}${bot.job ? `, ${bot.job}` : ""}. You are talking with the user by voice, live, like a phone call. Your words are read aloud.`,
    "Answer in the language the user spoke. Use one to three short spoken sentences. No markdown, no lists, no URLs, no emoji, no stage directions. Sound like a capable colleague, not a script.",
    "Answer directly when the context below is enough: small talk, simple questions, what you know about yourself or the recent conversation.",
    `If answering needs tools, files, the web, commands, checking live data, or anything that is not in the context, do not guess. Give a short natural spoken acknowledgement of what you will do, then end with ${MARKER} the task, written so it stands on its own, in the user's words]]. The marker is never spoken, and it must be the last thing you write. Without it, nothing gets done.`,
    "Never invent facts, numbers, results or names. If you are unsure, say so briefly or delegate.",
    bot.prompt ? `Your standing instructions (shortened):\n${String(bot.prompt).slice(0, 1500)}` : "",
    memory.length ? `What you remember:\n${memory.join("\n")}` : "",
    `Current local time on the server: ${now.toString()}.`,
  ].filter(Boolean).join("\n\n");
}

export function voiceMessages(bot, thread, text, options) {
  const history = thread
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.kind !== "ack" && message.kind !== "intro" && String(message.content || "").trim())
    .slice(-12)
    .map((message) => ({ role: message.role, content: snip(message.content, 400) }));
  return [{ role: "system", content: voicePrompt(bot, options) }, ...history, { role: "user", content: text }];
}

// Splits streamed text into what is safe to speak and the delegated task, even
// when the marker arrives in pieces.
export class MarkerFilter {
  constructor() {
    this.full = "";
    this.sent = 0;
  }

  // Text newly safe to show after adding a piece.
  push(piece) {
    this.full += piece;
    const at = this.full.indexOf(MARKER);
    let end = at >= 0 ? at : this.full.length;
    if (at < 0) {
      // Hold back a tail that could still turn into the marker.
      for (let keep = Math.min(MARKER.length - 1, this.full.length); keep > 0; keep -= 1) {
        if (MARKER.startsWith(this.full.slice(this.full.length - keep))) {
          end = this.full.length - keep;
          break;
        }
      }
    }
    if (end <= this.sent) return "";
    const out = this.full.slice(this.sent, end);
    this.sent = end;
    return out;
  }

  finish() {
    const at = this.full.indexOf(MARKER);
    const spoken = (at >= 0 ? this.full.slice(0, at) : this.full).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    let task = "";
    if (at >= 0) task = this.full.slice(at + MARKER.length).replace(/\]\].*$/s, "").trim();
    // Text held back at the very end (a lone "[" or "[[") was not a marker after all.
    const tail = at < 0 ? this.full.slice(this.sent) : "";
    return { spoken, task, tail };
  }
}

// Streams chat/completions. onDelta gets content only; reasoning fields are ignored.
export async function streamChat({ config, messages, signal, onDelta, bot, fetchImpl = fetch }) {
  const base = String(config.baseUrl).replace(/\/+$/, "");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  const headers = { "content-type": "application/json", accept: "text/event-stream", "user-agent": "ravnir/1.0", "x-opencode-session": `ravnir-voice-${bot.id}` };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ model: config.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: MAX_TOKENS, temperature: 0.4 }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The quick model answered ${response.status}.`);
  }
  let usage = null;
  let content = "";
  const handle = (data) => {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.usage) usage = chunk.usage;
    const piece = chunk.choices?.[0]?.delta?.content;
    if (typeof piece === "string" && piece) {
      content += piece;
      onDelta(piece);
    }
  };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") handle(data);
      }
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:") && rest.slice(5).trim() !== "[DONE]") handle(rest.slice(5).trim());
  return { content, usage };
}

function usageFrom(raw, price) {
  if (!raw) return null;
  const cached = Number(raw.prompt_tokens_details?.cached_tokens) || 0;
  const usage = {
    input: Math.max(0, (Number(raw.prompt_tokens) || 0) - cached),
    output: Number(raw.completion_tokens) || 0,
    reasoning: 0,
    cacheRead: cached,
    cacheWrite: 0,
    cost: Number(raw.cost) || 0,
  };
  if (!usage.cost && price) usage.cost = ((usage.input + usage.cacheRead) * price.input + usage.output * price.output) / 1e6;
  return usage;
}

// Runs one voice exchange. `write(obj)` sends an NDJSON line to the client.
// `quick` is the resolved quick config, or null. The user's message is stored
// as soon as the quick model starts answering (or the cap answers); on a
// fallback the normal turn stores it, so it is never stored twice.
export async function voiceReply({ bot, text, engine, home, quick, write, signal, startTimeoutMs = START_TIMEOUT_MS }) {
  const thread = readConversation(home, bot);
  const fallback = () => {
    const queued = engine.enqueue(bot, { text, source: "chat", via: "voice" });
    queued.promise.catch(() => {});
    write({ type: "done", text: "", delegated: false, fallback: true, turnId: queued.turnId });
  };
  if (!quick) return fallback();

  let userStored = false;
  const storeUser = () => {
    if (userStored) return;
    userStored = true;
    const message = { id: crypto.randomUUID(), role: "user", content: text, at: Date.now(), source: "voice", via: "voice" };
    appendConversation(home, bot, [message]);
    engine.emit(bot, { type: "voice.message", message });
  };
  const storeReply = (content) => {
    const message = { id: crypto.randomUUID(), role: "assistant", content, at: Date.now(), source: "voice", via: "voice" };
    appendConversation(home, bot, [message]);
    engine.emit(bot, { type: "voice.message", message });
  };

  const capped = engine.capReached(bot);
  if (capped) {
    const line = CAPPED[detectLanguage(text)];
    storeUser();
    write({ type: "delta", text: line });
    storeReply(line);
    write({ type: "done", text: line, delegated: false, capped: true });
    return undefined;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let gate = setTimeout(() => controller.abort(), startTimeoutMs);
  const whole = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  const filter = new MarkerFilter();
  let spokenAny = false;
  let result = null;
  let failure = null;
  try {
    result = await streamChat({
      config: quick,
      bot,
      messages: voiceMessages(bot, thread, text),
      signal: controller.signal,
      onDelta: (piece) => {
        // The wait is for the first words only.
        if (gate) {
          clearTimeout(gate);
          gate = null;
        }
        storeUser();
        const out = filter.push(piece);
        if (out) {
          spokenAny = true;
          write({ type: "delta", text: out });
        }
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(gate);
    clearTimeout(whole);
    signal?.removeEventListener("abort", onAbort);
  }

  const record = (status, error = "") => engine.ledger?.record({
    id: crypto.randomUUID(),
    at: Date.now(),
    startedAt,
    durationMs: Date.now() - startedAt,
    botId: bot.id,
    botName: bot.name,
    source: "voice",
    prompt: snip(text, 300),
    status,
    error,
    summary: status === "ok" ? snip(filter.finish().spoken, 300) : "",
    provider: "openai",
    model: quick.model,
    usage: addUsage(null, usageFrom(result?.usage, quick.price)),
  });

  const { spoken, task, tail } = filter.finish();
  if ((failure && !spokenAny) || (!spoken && !task)) {
    // Nothing reached the user: the full agent answers instead.
    record("error", failure?.message || "The quick model sent no text.");
    return fallback();
  }

  if (tail.trim()) write({ type: "delta", text: tail });
  storeUser();
  if (spoken) storeReply(spoken);
  record(failure ? "error" : "ok", failure?.message || "");

  let turnId = "";
  if (task) {
    const queued = engine.enqueue(bot, { text: `${task}\n\n(${VOICE_NOTE})`, display: task, source: "voice", noPlan: true });
    queued.promise.catch(() => {});
    turnId = queued.turnId;
  }
  write({ type: "done", text: spoken, delegated: Boolean(task), ...(turnId ? { turnId } : {}) });
  return undefined;
}
