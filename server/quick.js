// The first reply an agent sends: one or two short sentences on what it is about
// to do ("Okay. I'll look into October's spend."), written by a small fast model
// so it lands in a couple of seconds. The agent's own model then does the work;
// it hears what the user was told, as a courtesy line, not as its instructions.
import { complete } from "./providers/openai.js";

const TIMEOUT_MS = 8_000;
const MAX_CHARS = 320;

// RAVNIR_QUICK_URL + RAVNIR_QUICK_MODEL (+ RAVNIR_QUICK_API_KEY) name an
// OpenAI-compatible endpoint for every agent. Without them, an agent on an
// OpenAI-compatible server plans with its own model; an OpenCode agent skips
// the plan. RAVNIR_QUICK=off turns it off.
export function quickConfig(bot, env = process.env) {
  if (/^(off|0|false|no)$/i.test(String(env.RAVNIR_QUICK || ""))) return null;
  if (env.RAVNIR_QUICK_URL && env.RAVNIR_QUICK_MODEL) {
    return {
      baseUrl: env.RAVNIR_QUICK_URL,
      model: env.RAVNIR_QUICK_MODEL,
      apiKey: env.RAVNIR_QUICK_API_KEY || "",
      price: parsePrice(env.RAVNIR_QUICK_PRICE),
    };
  }
  if (bot?.model?.provider === "openai" && bot.model.baseUrl && bot.model.model) {
    return { baseUrl: bot.model.baseUrl, model: bot.model.model, apiKey: bot.model.apiKey || "", price: null };
  }
  return null;
}

// "0.15,0.6": dollars per million input and output tokens, for servers that do not report cost.
function parsePrice(value) {
  const [input, output] = String(value || "").split(",").map((part) => Number(part.trim()));
  return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null;
}

export function planPrompt(bot) {
  const instructions = String(bot.instructions || "").replace(/\s+/g, " ").trim().slice(0, 600);
  return [
    `You are ${bot.name}${bot.job ? `. Your job: ${bot.job}` : ""}. You are a teammate agent on the user's own server, with a computer, tools and memory.`,
    instructions ? `Your standing instructions (start): ${instructions}` : "",
    "You are about to start on the user's latest message. Write the first thing they see: one or two short sentences saying what you will do, like a quick plan.",
    "Say what you will find out or set up, in the user's terms. Do not name websites, data sources, comparisons or steps you are not sure of. If the user asks for something on a schedule, say you will set up the schedule, not that you will do the check now.",
    "Write in the language of the latest message, first person, plain words. No greeting, no questions, no markdown, no dashes, no results or numbers you do not have yet. Keep it under 35 words.",
    "If the message is small talk, thanks, or a question you would answer in one line, reply with exactly SKIP.",
  ].filter(Boolean).join("\n");
}

// What the agent's own model hears about the plan line the user already saw. The quick model guessed
// it from a few lines of thread, so it is never an order: the agent works from its own sources.
export function planNote(text) {
  const plan = String(text || "").trim();
  if (!plan) return "";
  return `(You already told the user: "${plan}" That line was written by a quick preview model that does not know your notes, spec, teammates or tools. It is not an instruction. Do what the user's message actually needs, starting from your own sources (spec, vault notes, teammates), and only what they asked for: if they asked you to schedule something, setting it up is the task. Do not repeat that line in your reply.)`;
}

export function planInput(text, history = []) {
  const lines = history
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.kind !== "ack" && message.kind !== "intro" && String(message.content || "").trim())
    .slice(-6)
    .map((message) => `${message.role === "user" ? "User" : "You"}: ${String(message.content).replace(/\s+/g, " ").slice(0, 400)}`);
  return `${lines.length ? `Recent thread:\n${lines.join("\n")}\n\n` : ""}Latest message:\n${text}`;
}

// The model's reply as one plain line, or "" when it chose to skip.
export function cleanPlan(text) {
  let out = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  out = out.replace(/^["“'«]+|["”'»]+$/g, "").trim();
  if (out.length < 4 || /^skip\b/i.test(out)) return "";
  out = out.replace(/\s*[—–]\s*/g, ", ");
  if (out.length > MAX_CHARS) out = `${out.slice(0, MAX_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  return out;
}

export async function quickPlan({ config, bot, text, history = [], signal, timeoutMs = TIMEOUT_MS }) {
  const signals = [AbortSignal.timeout(timeoutMs), signal].filter(Boolean);
  const result = await complete({
    bot: { model: { provider: "openai", baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey } },
    messages: [
      { role: "system", content: planPrompt(bot) },
      { role: "user", content: planInput(text, history) },
    ],
    tools: [],
    signal: AbortSignal.any(signals),
    options: { stream: false, max_tokens: 400, temperature: 0.3 },
    // Agent clients identify themselves and keep one session id per conversation.
    headers: { "user-agent": "ravnir/1.0", "x-opencode-session": `ravnir-${bot.id}` },
  });
  const usage = result.usage ? { ...result.usage } : null;
  if (usage && !usage.cost && config.price) usage.cost = costOf(usage, config.price);
  return { text: cleanPlan(result.content), usage, model: config.model };
}

// Dollars for a call to a server that reports tokens but not cost.
export function costOf(usage, price) {
  return ((usage.input + usage.cacheRead) * price.input + (usage.output + usage.reasoning) * price.output) / 1e6;
}

export function addUsage(base, extra) {
  if (!extra) return base;
  if (!base) return { ...extra };
  const out = { ...base };
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cost"]) out[key] = (Number(base[key]) || 0) + (Number(extra[key]) || 0);
  return out;
}
