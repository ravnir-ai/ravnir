import fs from "node:fs";
import path from "node:path";

// Jev (TypeSafe System One) is a fast decision model: it scores judgments from
// 0 to 4 instead of writing prose. Ravnir uses it for quick choices, above all
// for computer use, where a page has many possible next clicks.
//
// The key stays on the server. Every call is logged to data/jev-usage.ndjson
// with input tokens and cost; output tokens are free.

const ENDPOINT = process.env.RAVNIR_TYPESAFE_ENDPOINT || process.env.SYSTEMONE_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.RAVNIR_TYPESAFE_MODEL || process.env.SYSTEMONE_MODEL || "jev-1.13.0";
export const USD_PER_M_INPUT = 0.042;

let usageFile = "";
let keyCache;

export function jevConfigured() {
  return Boolean(apiKey());
}

function apiKey() {
  if (keyCache !== undefined) return keyCache;
  keyCache = String(process.env.RAVNIR_TYPESAFE_KEY || process.env.TYPESAFE_API_KEY || "").trim();
  return keyCache;
}

export function setJevHome(home) {
  usageFile = path.join(home, "jev-usage.ndjson");
}

export function jevStatus() {
  return {
    configured: jevConfigured(),
    model: MODEL,
    endpoint: ENDPOINT,
    pricePerMInput: USD_PER_M_INPUT,
  };
}

export async function askJev(state, questions, { tag = "ravnir", timeoutMs = 12_000 } = {}) {
  const key = apiKey();
  if (!key) throw new Error("Jev is not configured. Set TYPESAFE_API_KEY on the server.");
  if (!state || typeof state !== "object") throw new Error("Jev needs a state object.");
  const entries = Object.entries(questions || {});
  if (!entries.length) throw new Error("Jev needs at least one question.");
  if (entries.length > 24) throw new Error("Jev supports at most 24 questions per call.");
  const body = JSON.stringify({ model: MODEL, state, questions });
  if (body.length > 180_000) throw new Error("That Jev request is too large.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    });
  } catch (error) {
    throw new Error(error.name === "AbortError" ? "Jev timed out." : `Jev could not be reached: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Jev answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const data = await response.json();
  const tokens = Number(data?.usage?.input_tokens) || 0;
  logUsage(tag, entries.length, tokens);
  return { answers: data.answers || {}, tokens, cost: tokens / 1e6 * USD_PER_M_INPUT, model: data.model || MODEL };
}

// Rank options for one goal. Each option becomes a 0-4 score.
export async function chooseWithJev({ goal, state = {}, options, tag = "choose" }) {
  const choices = (Array.isArray(options) ? options : [])
    .map((option) => String(option || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 24);
  if (choices.length < 2) throw new Error("Jev needs at least two options to choose from.");
  const questions = {};
  choices.forEach((choice, index) => {
    questions[`c${index}`] = {
      type: "score",
      instructions: `Goal: ${String(goal || "").slice(0, 1200)}. Given the state, how well does this option advance the goal right now? option: ${choice}`,
      criteria: [
        "0: wrong, harmful, or does not advance the goal",
        "1: weak or unlikely to help",
        "2: plausible but indirect",
        "3: good next step",
        "4: clearly the best next step",
      ],
    };
  });
  const result = await askJev({ goal: String(goal || ""), ...state }, questions, { tag });
  const ranked = choices
    .map((choice, index) => ({ choice, score: round(result.answers[`c${index}`]?.score ?? 0) }))
    .sort((a, b) => b.score - a.score);
  return { ...result, ranked, best: ranked[0] };
}

function logUsage(tag, questions, tokens) {
  if (!usageFile) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    tag: String(tag || "ravnir").slice(0, 80),
    questions,
    inputTokens: tokens,
    model: MODEL,
    paid: true,
  });
  try {
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    fs.appendFileSync(usageFile, `${line}\n`);
  } catch {
    // Usage logging is best effort; a decision must not fail because of it.
  }
}

export function jevSpend() {
  if (!usageFile || !fs.existsSync(usageFile)) return { calls: 0, tokens: 0, cost: 0 };
  let calls = 0;
  let tokens = 0;
  for (const line of fs.readFileSync(usageFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      calls += 1;
      tokens += Number(row.inputTokens) || 0;
    } catch {
      // Ignore a torn line.
    }
  }
  return { calls, tokens, cost: tokens / 1e6 * USD_PER_M_INPUT };
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
