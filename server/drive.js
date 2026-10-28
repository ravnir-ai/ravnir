import crypto from "node:crypto";
import { chooseNext } from "./chooser.js";
import { addUsage } from "./quick.js";

// One loop for computer_task (the browser) and desktop_task (the X desktop). A driver
// observes the screen and performs actions; every step is saved as a screenshot and
// emitted to the thread. With a server-side chooser (Jev or a fast model) the loop runs
// on its own. Without one, the agent picks: it gets the numbered actions and answers
// with computer_step, one step per call.

const runs = new Map(); // bot id -> the task the agent is stepping through
const locks = new Map(); // bot id -> the step in progress, so two calls never act at once
const RUN_TTL_MS = 30 * 60_000;

function locked(botId, fn) {
  const next = (locks.get(botId) || Promise.resolve()).then(fn, fn);
  const settled = next.catch(() => {});
  locks.set(botId, settled);
  settled.then(() => {
    if (locks.get(botId) === settled) locks.delete(botId);
  });
  return next;
}

export async function driveTask({ driver, goal, maxSteps, chooser, signal, emit = () => {} }) {
  const runId = crypto.randomUUID();
  const log = [];
  // What each step did and where it landed, so the chooser can see the goal was already reached.
  const history = [];
  let usage = null;
  let seen = null;
  let start = null;
  let before = null; // the screen before the last action
  let lastKind = ""; // what kind of action that was
  let stall = 0; // key presses and scrolls in a row that changed nothing on the screen
  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) throw new Error("Stopped.");
    seen = await observe(driver, runId, step, emit, goal);
    start ||= seen;
    const sig = signature(seen);
    // Only a key press or a scroll is judged by the screen. A click or a fill can work
    // without showing it (a download, a new tab, a save, a toggle), so it never counts
    // as a stall and the chooser gets to pick DONE after it.
    if (before !== null) stall = sig === before && (lastKind === "key" || lastKind === "scroll") ? stall + 1 : 0;
    if (stall >= 2) {
      const hint = driver.hint ? ` ${driver.hint}` : "";
      return finish(`Stopped after ${count(log.length)}: the last 2 actions changed nothing on the screen.${moved(history, start) || (seen.where ? ` The screen is ${seen.where}.` : "")}${hint}`, log, usage);
    }
    if (!seen.actions.length) return finish(seen.empty, log, usage);
    const options = seen.actions.map((action) => action.label);
    const state = {
      ...seen.state,
      start: start.where,
      done_so_far: history.length
        ? history.map((row, index) => `${index + 1}. ${row.label} -> now on ${row.title || "(untitled)"} at ${row.url}`).join("\n")
        : "nothing yet",
    };
    const picked = await chooseNext(chooser, { goal, state, options, tag: driver.kind === "browser" ? "computer" : "desktop", signal });
    usage = addUsage(usage, picked.usage);
    const action = seen.actions[picked.best.index] || seen.actions[0];
    const end = ending(action, step);
    if (end) return finish(end, log, usage);
    const row = await act(driver, runId, step, action, picked.best.score, seen, emit);
    log.push(row);
    history.push({ label: action.label, url: row.url, title: row.title });
    before = sig;
    lastKind = action.kind;
  }
  // The last observation is from before the last action; where that action landed is newer.
  const last = history.at(-1);
  const where = seen?.where && last?.url ? `${last.title || "(untitled)"} at ${last.url}` : seen?.where;
  return finish(`Reached the step limit (${maxSteps})${where ? ` on ${where}` : ""}.${moved(history, start)}`, log, usage);
}

// Two screens with the same signature look the same to the chooser: same place, same
// actions, same text (and, when the driver reports one, the same scroll and field values).
function signature(seen) {
  const text = String(seen.state?.page ?? seen.state?.text ?? "");
  const parts = [seen.url, seen.actions.map((action) => action.label).join("\n"), text, seen.fingerprint || ""];
  return crypto.createHash("sha1").update(parts.join("\n\u0000")).digest("hex");
}

// The newest step that took the task somewhere new, so a run that ends badly still says
// where it got to.
function moved(history, start) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const previous = index ? history[index - 1].url : start?.url;
    const row = history[index];
    if (row.url && row.url !== previous) return ` The last action that changed the page was ${row.label}, which opened ${row.title || "(untitled)"} at ${row.url}.`;
  }
  return "";
}

function count(steps) {
  return `${steps} step${steps === 1 ? "" : "s"}`;
}

export function startSteps({ bot, driver, goal, text = "", maxSteps, emit = () => {} }) {
  return locked(bot.id, async () => {
    const dropped = runs.has(bot.id) ? "Your earlier computer task was dropped; this one replaces it.\n\n" : "";
    runs.delete(bot.id);
    const runId = crypto.randomUUID();
    const seen = await observe(driver, runId, 0, emit, goal);
    if (!seen.actions.length) return finish(`${dropped}${seen.empty}`, [], null);
    runs.set(bot.id, { runId, kind: driver.kind, goal, text, step: 0, maxSteps, seen, log: [], at: Date.now() });
    return { text: `${dropped}${listText(goal, seen, 0, maxSteps)}` };
  });
}

// driverFor(kind, { goal, text }) rebuilds the driver the task started with. step is the
// number shown with the list the agent picked from; an out-of-date list is never acted on.
export function nextStep({ bot, pick, step, driverFor, emit = () => {} }) {
  return locked(bot.id, () => takeStep({ bot, pick, step, driverFor, emit }));
}

async function takeStep({ bot, pick, step, driverFor, emit }) {
  const run = runs.get(bot.id);
  if (!run || Date.now() - run.at > RUN_TTL_MS) {
    runs.delete(bot.id);
    throw new Error("There is no computer task in progress. Start one with computer_task or desktop_task.");
  }
  if (step !== undefined && Number(step) !== run.step + 1) {
    return { text: `That list is out of date (you picked from step ${step}). Nothing was done. This is the current one.\n\n${listText(run.goal, run.seen, run.step, run.maxSteps)}` };
  }
  const count = run.seen.actions.length;
  const number = Number(pick);
  if (!Number.isInteger(number) || number < 1 || number > count) throw new Error(`Pick an action number from 1 to ${count}.`);
  const action = run.seen.actions[number - 1];
  const end = ending(action, run.step);
  if (end) {
    runs.delete(bot.id);
    return finish(end, run.log, null);
  }
  const driver = await driverFor(run.kind, { goal: run.goal, text: run.text });
  try {
    run.log.push(await act(driver, run.runId, run.step, action, undefined, run.seen, emit));
  } catch (error) {
    // The screen changed under the list (the page moved on, a dialog closed): show what is there now.
    const seen = await observe(driver, run.runId, run.step, emit, run.goal);
    if (!seen.actions.length) {
      runs.delete(bot.id);
      return finish(seen.empty, run.log, null);
    }
    Object.assign(run, { seen, at: Date.now() });
    return { text: `That action failed (${error.message}). This is the screen now.\n\n${listText(run.goal, seen, run.step, run.maxSteps)}` };
  }
  run.step += 1;
  if (run.step >= run.maxSteps) {
    runs.delete(bot.id);
    return finish(`Reached the step limit (${run.maxSteps}).`, run.log, null);
  }
  const seen = await observe(driver, run.runId, run.step, emit, run.goal);
  if (!seen.actions.length) {
    runs.delete(bot.id);
    return finish(seen.empty, run.log, null);
  }
  Object.assign(run, { seen, at: Date.now() });
  return { text: `Did: ${action.label}\n\n${listText(run.goal, seen, run.step, run.maxSteps)}` };
}

export function stepRun(botId) {
  return runs.get(botId) || null;
}

async function observe(driver, runId, step, emit, goal = "") {
  const seen = await driver.observe(step, { goal });
  emit({ type: "computer.step", runId, step: step + 1, phase: "observe", url: seen.url, title: seen.title, shot: seen.shot });
  return seen;
}

async function act(driver, runId, step, action, score, before, emit) {
  emit({ type: "status", message: `${driver.label}: ${action.label}` });
  await driver.perform(action);
  const after = await driver.after(step, before, action);
  const row = { step: step + 1, action: action.label, ...(score !== undefined ? { score } : {}), url: after.url, title: after.title, shot: after.shot, at: Date.now() };
  emit({ type: "computer.step", ...row, runId, phase: "action" });
  if (after.note) emit({ type: "status", message: after.note });
  return row;
}

function ending(action, step) {
  if (action.kind === "done") return `Done after ${count(step)}: ${action.label}`;
  if (action.kind === "stop") return `Stopped after ${count(step)}: ${action.label}`;
  return "";
}

function listText(goal, seen, step, maxSteps) {
  const where = seen.where ? `Screen: ${seen.where}\n` : "";
  const summary = seen.summary ? `${seen.summary}\n\n` : "";
  const options = seen.actions.map((action, index) => `${index + 1}. ${action.label}`).join("\n");
  return `Goal: ${goal}\nStep ${step + 1} of up to ${maxSteps}. ${where}${summary}Next actions. Answer with computer_step, this step number (${step + 1}) and the number of the best one:\n${options}`;
}

function finish(text, log, usage) {
  const lines = log.map((row) => `${row.step}. ${row.action}${row.score !== undefined ? ` (${row.score}/4)` : ""}`);
  return { text: lines.length ? `${text}\n\n${lines.join("\n")}` : text, steps: log, usage };
}
