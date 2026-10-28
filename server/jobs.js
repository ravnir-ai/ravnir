import crypto from "node:crypto";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
const MACRO_TEXT = {
  "@hourly": "Every hour",
  "@daily": "Every day at midnight",
  "@midnight": "Every day at midnight",
  "@weekly": "Every Sunday at midnight",
  "@monthly": "The first of every month",
  "@yearly": "The first of January",
  "@annually": "The first of January",
};
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const CREATED_BY = ["user", "bot", "import"];
const AT_GRACE_MS = 60_000;
const AT_MAX_AHEAD_MS = 400 * 24 * 60 * 60 * 1000;
const AT_EXAMPLE = "2026-10-24T09:00:00+02:00";

export function validateCron(expression) {
  const parsed = parseCron(expression);
  if (!parsed) throw new Error("Cron expression is required.");
  return parsed.source;
}

export function parseCron(expression) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("Cron expression is required.");
  }
  let source = expression.trim().toLowerCase();
  if (MACROS[source]) source = MACROS[source];
  const parts = source.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Use a five-field cron expression: minute hour day month weekday.");
  }
  const [minute, hour, dom, month, dow] = parts;
  const parsed = {
    source,
    minute: field(minute, 0, 59, null, "minute"),
    hour: field(hour, 0, 23, null, "hour"),
    dom: field(dom, 1, 31, null, "day of month"),
    month: field(month, 1, 12, MONTHS, "month"),
    dow: field(dow, 0, 7, DAYS, "weekday"),
  };
  parsed.dow.values = new Set([...parsed.dow.values].map((value) => (value === 7 ? 0 : value)));
  return parsed;
}

// Walks absolute minutes, so the clock changes behave like cron: a job at a fixed hour runs once
// when the clock goes back (not in both 02:30s), and at the first minute after the gap when the
// clock jumps forward past its time. Setting local fields would resolve 02:30 in the repeated
// hour to the first one and hand back a time already past.
export function nextCron(expression, from = Date.now()) {
  const parsed = parseCron(expression);
  const fixedHour = !parsed.hour.wildcard;
  const start = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    const at = start + i * 60_000;
    const date = new Date(at);
    const before = new Date(at - 60_000);
    if (fixedHour && date.getTimezoneOffset() < before.getTimezoneOffset() && skippedMatch(parsed, before, date)) return at;
    if (!matches(parsed, date)) continue;
    // The second pass through a repeated hour: this wall time already happened an hour ago.
    if (fixedHour && repeatedWallTime(date)) continue;
    return at;
  }
  return null;
}

function wallParts(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());
}

function wallDate(ms) {
  const utc = new Date(ms);
  return { getMinutes: () => utc.getUTCMinutes(), getHours: () => utc.getUTCHours(), getMonth: () => utc.getUTCMonth(), getDate: () => utc.getUTCDate(), getDay: () => utc.getUTCDay() };
}

// The wall-clock minutes the forward jump left out (02:00 to 02:59 on the last Sunday of March in Madrid).
function skippedMatch(parsed, before, after) {
  for (let wall = wallParts(before) + 60_000; wall < wallParts(after); wall += 60_000) {
    if (matches(parsed, wallDate(wall))) return true;
  }
  return false;
}

// Some instant up to three hours back showed the same wall time, so this one repeats it.
function repeatedWallTime(date) {
  for (let back = 30; back <= 180; back += 30) {
    const earlier = new Date(date.getTime() - back * 60_000);
    if (wallParts(earlier) === wallParts(date)) return true;
  }
  return false;
}

// A sentence for a cron expression (24 h clock, server local time). Anything it
// cannot phrase with confidence comes back as "Custom schedule (<expr>)".
export function describeCron(expression) {
  const text = String(expression ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return MACRO_TEXT[text.toLowerCase()] || phraseCron(text) || `Custom schedule (${text})`;
}

export function describeSchedule(job) {
  const at = Number(job?.at) || 0;
  if (at) return `Once on ${formatDay(at)} at ${formatClock(at)}`;
  return describeCron(job?.cron);
}

// "Fri 24 Oct, 08:00", with the year only when it is not the current one.
export function formatRunTime(ms) {
  return `${formatDay(ms)}, ${formatClock(ms)}`;
}

// What the UI and the tools add on top of the stored job.
export function scheduleFields(job) {
  return {
    at: Number(job.at) || 0,
    createdBy: CREATED_BY.includes(job.createdBy) ? job.createdBy : "user",
    notify: job.notify !== false,
    done: Boolean(job.done),
    schedule: describeSchedule(job),
  };
}

export function previewSchedule({ cron, at } = {}) {
  const now = Date.now();
  const schedule = resolveSchedule({ cron, at }, now);
  return { text: describeSchedule(schedule), nextRunAt: firstRun(schedule, now) };
}

export function createJob(input) {
  const name = String(input.name || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Scheduled job";
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("A job needs an instruction.");
  if (prompt.length > 8000) throw new Error("Job instruction is too long.");
  const now = Date.now();
  const schedule = resolveSchedule(input, now);
  return {
    id: crypto.randomUUID(),
    name,
    cron: schedule.cron,
    at: schedule.at,
    prompt,
    enabled: input.enabled !== false,
    createdBy: CREATED_BY.includes(input.createdBy) ? input.createdBy : "user",
    notify: input.notify !== false,
    done: false,
    createdAt: now,
    lastRunAt: 0,
    nextRunAt: firstRun(schedule, now),
    lastStatus: "",
    lastSummary: "",
    runs: [],
  };
}

export function updateJob(job, patch = {}) {
  const now = Date.now();
  // A form that sends the whole job back must not trip over an `at` that did not change.
  if (hasAt(patch.at) && !hasCron(patch.cron) && Number(job.at) && sameInstant(patch.at, job.at)) {
    patch = { ...patch, at: 0 };
  }
  let name = job.name;
  if (typeof patch.name === "string") name = patch.name.replace(/\s+/g, " ").trim().slice(0, 60) || job.name;
  let prompt = job.prompt;
  if (typeof patch.prompt === "string") {
    if (!patch.prompt.trim()) throw new Error("A job needs an instruction.");
    prompt = patch.prompt.trim().slice(0, 8000);
  }
  let schedule = null;
  if (hasCron(patch.cron) || hasAt(patch.at)) schedule = resolveSchedule(patch, now);
  else if (typeof patch.cron === "string" && !job.at) throw new Error("Cron expression is required.");

  const wasEnabled = job.enabled !== false;
  const enabledPatch = typeof patch.enabled === "boolean" ? patch.enabled : null;
  let enabled = wasEnabled;
  let done = Boolean(job.done);
  const next = schedule || { cron: job.cron || "", at: Number(job.at) || 0 };
  if (schedule && done) {
    // A one-time job that already ran is armed again by giving it a new schedule.
    done = false;
    enabled = true;
  }
  if (enabledPatch !== null) enabled = enabledPatch;
  if (enabled && done) throw new Error("That one-time job already ran. Give it a new time to run it again.");
  if (enabledPatch === true && !wasEnabled && !schedule && next.at && next.at < now - AT_GRACE_MS) {
    throw new Error("The time for that one-time job has passed. Give it a new time.");
  }

  job.name = name;
  job.prompt = prompt;
  job.cron = next.cron;
  job.at = next.at;
  job.enabled = enabled;
  job.done = done;
  if (typeof patch.notify === "boolean") job.notify = patch.notify;
  if (schedule || enabledPatch === true) job.nextRunAt = firstRun(next, now);
  if (done) job.nextRunAt = 0;
  return job;
}

// A one-time job is consumed when it is claimed. claimedAt stays until the run
// finishes, so a crash in between lets the next boot arm it again (see state.js).
export function consumeOneShot(job, now) {
  job.enabled = false;
  job.done = true;
  job.nextRunAt = 0;
  job.claimedAt = now;
}

export class Scheduler {
  constructor({ getState, save, runJob, onError = () => {} }) {
    this.getState = getState;
    this.save = save;
    this.runJob = runJob;
    // A run that could not even start (the turn engine threw) reaches the user too.
    this.onError = onError;
    this.timer = null;
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    setTimeout(() => this.tick(), 2000).unref?.();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const state = this.getState();
      const now = Date.now();
      const due = [];
      for (const bot of state.bots) {
        for (const job of bot.jobs) {
          if (!job.enabled || !job.nextRunAt || job.nextRunAt > now) continue;
          if (job.at) {
            consumeOneShot(job, now);
          } else {
            job.nextRunAt = nextCron(job.cron, now + 30_000) || 0;
          }
          job.lastRunAt = now;
          due.push({ bot, job });
        }
      }
      if (!due.length) return;
      this.save();
      for (const { bot, job } of due) {
        Promise.resolve(this.runJob(bot, job)).catch((error) => {
          job.lastStatus = "error";
          job.lastSummary = error.message || "The job failed.";
          if (job.at) job.claimedAt = 0;
          else job.nextRunAt = nextCron(job.cron, Date.now() + 30_000) || 0;
          job.runs.push({ at: Date.now(), status: "error", summary: job.lastSummary });
          job.runs = job.runs.slice(-12);
          this.save();
          try {
            this.onError(bot, job, error);
          } catch {
            // a listener must not break the scheduler
          }
        });
      }
    } finally {
      this.ticking = false;
    }
  }
}

function hasCron(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasAt(value) {
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null && value !== 0;
}

// Exactly one of cron (repeats) or at (once). Returns { cron, at }, with the unused one empty.
function resolveSchedule({ cron, at }, now) {
  const wantsCron = hasCron(cron);
  const wantsAt = hasAt(at);
  if (wantsCron && wantsAt) throw new Error("Give either cron (repeats) or at (once), not both.");
  if (!wantsCron && !wantsAt) throw new Error("Give cron for a repeating schedule or at for a one-time run.");
  if (wantsAt) return { cron: "", at: parseAt(at, now) };
  return { cron: validateCron(cron), at: 0 };
}

function parseAt(value, now) {
  let ms = NaN;
  if (typeof value === "number") ms = value;
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "string") {
    const text = value.trim();
    if (/^\d{9,}$/.test(text)) ms = Number(text);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new Error(`Give the time of day too, for example ${AT_EXAMPLE}.`);
    } else ms = Date.parse(text);
  }
  if (!Number.isFinite(ms)) {
    throw new Error(`Could not read that time. Use ISO 8601 with a UTC offset, for example ${AT_EXAMPLE}, or epoch milliseconds.`);
  }
  if (ms < now - AT_GRACE_MS) {
    throw new Error(`That time is in the past. Pick a time in the future${ms < 1e11 ? " (epoch values are milliseconds)" : ""}.`);
  }
  if (ms > now + AT_MAX_AHEAD_MS) {
    throw new Error("That time is more than 400 days away. Pick a nearer time or use a repeating schedule.");
  }
  return Math.floor(ms);
}

function sameInstant(value, ms) {
  const parsed = typeof value === "string" && !/^\d+$/.test(value.trim()) ? Date.parse(value) : Number(value);
  return Math.floor(parsed) === ms;
}

function firstRun(schedule, now) {
  return schedule.at || nextCron(schedule.cron, now) || 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDay(ms) {
  const date = new Date(ms);
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${DAY_SHORT[date.getDay()]} ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}${year}`;
}

function formatClock(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sortedValues(set) {
  return [...set].sort((a, b) => a - b);
}

function joinAnd(items) {
  if (items.length < 2) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

// The N when values are 0, N, 2N, ... covering a whole cycle of `cycle`, else 0.
function stepOf(values, cycle) {
  if (values.length < 2) return 0;
  const step = values[1] - values[0];
  if (values[0] !== 0 || cycle % step !== 0 || values.length !== cycle / step) return 0;
  return values.every((value, i) => value === i * step) ? step : 0;
}

function weekdayPhrase(days) {
  if (days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  if (days.size === 2 && days.has(0) && days.has(6)) return "Weekends";
  if (days.size === 1) return `Every ${DAY_NAMES[[...days][0]]}`;
  return joinAnd(WEEK_ORDER.filter((day) => days.has(day)).map((day) => `${DAY_NAMES[day]}s`));
}

function phraseCron(text) {
  let parsed;
  try {
    parsed = parseCron(text);
  } catch {
    return "";
  }
  const [, hourRaw, , monthRaw] = parsed.source.split(" ");
  if (monthRaw !== "*") return "";
  const { dom, dow } = parsed;
  if (!dom.wildcard && !dow.wildcard) return "";
  const datesWild = dom.wildcard && dow.wildcard;
  const minutes = sortedValues(parsed.minute.values);
  const hours = sortedValues(parsed.hour.values);

  if (datesWild) {
    const hourStep = hourRaw.includes("/") ? stepOf(hours, 24) : 0;
    if (hourRaw === "*" || hourStep === 1) {
      const step = stepOf(minutes, 60);
      if (minutes.length > 1) return step === 1 ? "Every minute" : step ? `Every ${step} minutes` : "";
      return minutes[0] === 0 ? "Every hour" : `Every hour at :${pad(minutes[0])}`;
    }
    if (hourStep && minutes.length === 1) {
      return minutes[0] === 0 ? `Every ${hourStep} hours` : `Every ${hourStep} hours at :${pad(minutes[0])}`;
    }
  }
  if (hourRaw === "*" || hours.length * minutes.length > 6) return "";

  const times = [];
  for (const hour of hours) for (const minute of minutes) times.push(`${pad(hour)}:${pad(minute)}`);
  if (datesWild) return `Every day at ${joinAnd(times)}`;
  if (dom.wildcard) return `${weekdayPhrase(dow.values)} at ${joinAnd(times)}`;
  const monthDays = sortedValues(dom.values);
  if (monthDays.length > 4 || monthDays[monthDays.length - 1] > 28) return "";
  return `Monthly on the ${joinAnd(monthDays.map(ordinal))} at ${joinAnd(times)}`;
}

function matches(parsed, date) {
  if (!parsed.minute.values.has(date.getMinutes())) return false;
  if (!parsed.hour.values.has(date.getHours())) return false;
  if (!parsed.month.values.has(date.getMonth() + 1)) return false;
  const domMatch = parsed.dom.values.has(date.getDate());
  const dowMatch = parsed.dow.values.has(date.getDay());
  if (parsed.dom.wildcard && parsed.dow.wildcard) return true;
  if (!parsed.dom.wildcard && !parsed.dow.wildcard) return domMatch || dowMatch;
  return parsed.dom.wildcard ? dowMatch : domMatch;
}

function field(spec, min, max, names, label) {
  const wildcard = spec === "*";
  const values = new Set();
  for (const piece of spec.split(",")) {
    const { start, end, step } = pieceValues(piece, min, max, names, label);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (!values.size) throw new Error(`The ${label} field is empty.`);
  return { values, wildcard };
}

function pieceValues(piece, min, max, names, label) {
  let [range, stepText] = piece.split("/");
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step < 1) throw new Error(`The ${label} step is invalid.`);
  if (range === "*") return { start: min, end: max, step };
  if (range.includes("-")) {
    const [a, b] = range.split("-").map((value) => numberValue(value, min, max, names, label));
    if (a > b) throw new Error(`The ${label} range is backwards.`);
    return { start: a, end: b, step };
  }
  const value = numberValue(range, min, max, names, label);
  return { start: value, end: stepText === undefined ? value : max, step };
}

function numberValue(value, min, max, names, label) {
  let number;
  if (names && /^[a-z]+$/.test(value)) {
    number = names.indexOf(value);
    if (number < 0) throw new Error(`Unknown ${label} name "${value}".`);
    if (label === "month") number += 1;
  } else {
    number = Number(value);
  }
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`The ${label} value "${value}" is outside ${min}-${max}.`);
  }
  return number;
}
