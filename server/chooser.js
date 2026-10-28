import { chooseWithJev, jevConfigured } from "./jev.js";
import { complete } from "./providers/openai.js";
import { costOf, quickConfig } from "./quick.js";

// Who picks the next step in computer_task and desktop_task:
// - "jev": Jev scores every option in milliseconds (needs TYPESAFE_API_KEY).
// - "model": a fast OpenAI-compatible model picks one, the quick model or the agent's own.
// - "agent": nothing on the server can pick, so the agent gets the numbered list and answers with computer_step.
export function chooserFor(bot, env = process.env) {
  if (jevConfigured()) return { mode: "jev" };
  const config = quickConfig(bot, env);
  if (config) return { mode: "model", config };
  return { mode: "agent" };
}

const TIMEOUT_MS = 30_000;

export function choosePrompt() {
  return [
    "You choose the next action for an agent that is operating a computer.",
    "Read the goal and what is on the screen, then pick the single best next action from the numbered list.",
    "Pick DONE only when the screen shows the goal is complete, and STOP only when nothing on this screen can get closer to it.",
    "done_so_far lists the actions already taken and the page each one opened. If those already achieved the goal, pick DONE. Do not repeat a key or scroll that changed nothing.",
    'Reply with JSON only, no prose: {"pick": <action number>, "score": <0 to 4, where 4 means clearly the best next step>}',
  ].join("\n");
}

export function chooseInput({ goal, state = {}, options }) {
  const screen = Object.entries(state)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${String(value).slice(0, 4000)}`)
    .join("\n");
  return `Goal: ${String(goal || "").slice(0, 1200)}\n\nScreen:\n${screen}\n\nActions:\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}`;
}

// The number the model picked, as a 0-based index, or -1.
export function parsePick(text, count) {
  const clean = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  let pick = NaN;
  let score = NaN;
  const json = clean.match(/\{[^{}]*\}/);
  if (json) {
    try {
      const data = JSON.parse(json[0]);
      pick = Number(data.pick);
      score = Number(data.score);
    } catch {
      // Fall through to the first number.
    }
  }
  if (!Number.isInteger(pick)) pick = Number(clean.match(/\d+/)?.[0]);
  const index = Number.isInteger(pick) && pick >= 1 && pick <= count ? pick - 1 : -1;
  return { index, score: Number.isFinite(score) ? Math.min(4, Math.max(0, score)) : 3 };
}

export async function chooseWithModel({ config, goal, state, options, signal }) {
  const signals = [AbortSignal.timeout(TIMEOUT_MS), signal].filter(Boolean);
  const result = await complete({
    bot: { model: { provider: "openai", baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey } },
    messages: [
      { role: "system", content: choosePrompt() },
      { role: "user", content: chooseInput({ goal, state, options }) },
    ],
    tools: [],
    signal: AbortSignal.any(signals),
    // Some fast models reason before they answer, so leave room for it.
    options: { stream: false, max_tokens: 700, temperature: 0 },
    headers: { "user-agent": "ravnir/1.0" },
  });
  const { index, score } = parsePick(result.content, options.length);
  if (index === -1) throw new Error(`The model did not pick one of the ${options.length} actions.`);
  const usage = result.usage ? { ...result.usage } : null;
  if (usage && !usage.cost && config.price) usage.cost = costOf(usage, config.price);
  const best = { choice: options[index], score, index };
  return { best, ranked: [best], usage };
}

// One call for both: { best: { choice, score, index }, ranked, usage }.
export async function chooseNext(chooser, { goal, state = {}, options, tag = "choose", signal }) {
  if (chooser.mode === "jev") {
    const picked = await chooseWithJev({ goal, state, options, tag });
    return { best: { ...picked.best, index: options.indexOf(picked.best.choice) }, ranked: picked.ranked, usage: null };
  }
  if (chooser.mode === "model") return chooseWithModel({ config: chooser.config, goal, state, options, signal });
  throw new Error("No server-side chooser: the agent picks each step with computer_step.");
}
