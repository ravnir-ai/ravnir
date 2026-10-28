// Jobs panel: a schedule picker in plain words, the job rows, and the job actions.
// Loaded after app.js, so state, els, el, api, toast, reloadBot and showPanel are global.
// Times are the server's: cron runs in the server time zone, so "Once" is read in it too.

(() => {
  const MODES = [
    ["once", "Once"],
    ["daily", "Every day"],
    ["weekdays", "Weekdays"],
    ["weekly", "Weekly"],
    ["monthly", "Monthly"],
    ["hours", "Every N hours"],
  ];
  const WEEK = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]];

  const picker = {
    mode: "weekdays",
    last: "weekdays",
    time: "08:00",
    days: new Set([1]),
    monthDay: 1,
    every: 2,
    minute: 0,
    at: "",
    cron: "",
    serial: 0,
    timer: 0,
    nodes: {},
  };

  // The job being edited, or null when the form creates a new one.
  let editing = null;

  els["job-form"].addEventListener("submit", saveJob);
  $("job-cancel").addEventListener("click", () => stopEditing());
  mountPicker();

  function mountPicker() {
    const host = $("schedule-picker");
    host.replaceChildren();
    host.append(el("p", "field-label", "When"));

    const modes = el("div", "sched-modes");
    modes.setAttribute("role", "radiogroup");
    modes.setAttribute("aria-label", "How often");
    modes.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (button) pickMode(button.dataset.mode);
    });
    for (const [value, label] of MODES) {
      const button = el("button", "sched-mode", label);
      button.type = "button";
      button.dataset.mode = value;
      button.setAttribute("role", "radio");
      modes.append(button);
    }

    const fields = el("div", "sched-fields");
    const advanced = document.createElement("details");
    advanced.className = "sched-advanced";
    advanced.append(el("summary", "", "Advanced"));
    const label = el("label", "", "Custom cron ");
    label.append(el("span", "muted", "minute hour day month weekday"));
    const cron = document.createElement("input");
    cron.id = "job-cron";
    cron.className = "mono";
    cron.placeholder = "Follows the schedule above";
    cron.spellcheck = false;
    cron.autocomplete = "off";
    cron.autocapitalize = "off";
    // The box mirrors the picker. Typing in it takes over (Custom); leaving it empty hands control back.
    cron.addEventListener("input", () => {
      picker.cron = cron.value.trim();
      picker.mode = "custom";
      syncPicker({ typing: true });
    });
    cron.addEventListener("change", () => {
      if (picker.cron) return;
      picker.mode = picker.last;
      syncPicker();
    });
    label.append(cron);
    advanced.append(label);

    const preview = el("p", "sched-preview");
    preview.setAttribute("aria-live", "polite");
    const zone = el("p", "hint sched-zone");

    host.append(modes, fields, advanced, preview, zone);
    Object.assign(picker.nodes, { modes, fields, advanced, cron, preview, zone });
    syncPicker();
  }

  function pickMode(mode) {
    picker.mode = mode;
    picker.last = mode;
    picker.cron = "";
    picker.nodes.cron.value = "";
    if (mode === "once" && !picker.at) picker.at = defaultOnce();
    syncPicker();
  }

  function syncPicker({ typing = false } = {}) {
    const { modes, fields, advanced } = picker.nodes;
    for (const button of modes.querySelectorAll("button")) {
      const on = button.dataset.mode === picker.mode;
      button.classList.toggle("on", on);
      button.setAttribute("aria-checked", String(on));
    }
    if (picker.mode === "custom") advanced.open = true;
    // The fields are rebuilt only when the mode changes, so typing never loses focus.
    if (fields.dataset.mode !== picker.mode) {
      fields.dataset.mode = picker.mode;
      fields.replaceChildren(...buildFields(picker.mode));
    }
    fields.hidden = picker.mode === "custom";
    if (!typing) syncCron();
    syncZone();
    queuePreview();
  }

  // The cron the picker describes right now, so the Advanced box never shows a stale value.
  function syncCron() {
    const { cron } = picker.nodes;
    if (picker.mode === "custom") cron.value = picker.cron;
    else cron.value = currentSchedule()?.cron || "";
  }

  function buildFields(mode) {
    if (mode === "once") {
      return [pickField("Date and time", pickInput("datetime-local", picker.at, (value) => { picker.at = value; }))];
    }
    if (mode === "daily" || mode === "weekdays") {
      return [pickField("At", pickInput("time", picker.time, (value) => { picker.time = value; }))];
    }
    if (mode === "weekly") {
      const days = el("div", "sched-days");
      for (const [label, value] of WEEK) {
        const chip = el("button", `sched-day${picker.days.has(value) ? " on" : ""}`, label);
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(picker.days.has(value)));
        chip.addEventListener("click", () => {
          if (picker.days.has(value)) picker.days.delete(value);
          else picker.days.add(value);
          chip.classList.toggle("on", picker.days.has(value));
          chip.setAttribute("aria-pressed", String(picker.days.has(value)));
          queuePreview();
        });
        days.append(chip);
      }
      return [days, pickField("At", pickInput("time", picker.time, (value) => { picker.time = value; }))];
    }
    if (mode === "monthly") {
      const day = pickInput("number", String(picker.monthDay), (value) => { picker.monthDay = Number(value); }, { min: 1, max: 31, inputmode: "numeric" });
      return [
        pickField("On day of the month", day),
        pickField("At", pickInput("time", picker.time, (value) => { picker.time = value; })),
      ];
    }
    if (mode === "hours") {
      const every = pickInput("number", String(picker.every), (value) => { picker.every = Number(value); }, { min: 1, max: 23, inputmode: "numeric" });
      const minute = pickInput("number", String(picker.minute), (value) => { picker.minute = Number(value); }, { min: 0, max: 59, inputmode: "numeric" });
      const row = el("div", "row");
      row.append(pickField("Hours between runs", every), pickField("At minute", minute));
      row.classList.add("sched-pair");
      return [row];
    }
    return [];
  }

  function pickField(label, control) {
    const wrap = el("label", "sched-field", label);
    wrap.append(control);
    return wrap;
  }

  function pickInput(type, value, onChange, attrs = {}) {
    const node = document.createElement("input");
    node.type = type;
    node.value = value;
    for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
    node.addEventListener("input", () => {
      onChange(node.value);
      queuePreview();
    });
    return node;
  }

  // The schedule the form describes, as the body the server expects, or null when it is incomplete.
  function currentSchedule() {
    const [hour, minute] = (picker.time || "").split(":").map(Number);
    const timed = Number.isInteger(hour) && Number.isInteger(minute);
    const count = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    switch (picker.mode) {
      case "custom":
        return picker.cron ? { cron: picker.cron } : null;
      case "once": {
        if (!picker.at) return null;
        const instant = zonedInstant(picker.at, state.server?.timezone);
        return Number.isFinite(instant) ? { at: new Date(instant).toISOString() } : null;
      }
      case "daily":
        return timed ? { cron: `${minute} ${hour} * * *` } : null;
      case "weekdays":
        return timed ? { cron: `${minute} ${hour} * * 1-5` } : null;
      case "weekly":
        return timed && picker.days.size ? { cron: `${minute} ${hour} * * ${[...picker.days].sort((a, b) => a - b).join(",")}` } : null;
      case "monthly":
        return timed && count(picker.monthDay, 1, 31) ? { cron: `${minute} ${hour} ${picker.monthDay} * *` } : null;
      case "hours":
        if (!count(picker.every, 1, 23) || !count(picker.minute, 0, 59)) return null;
        return { cron: picker.every === 1 ? `${picker.minute} * * * *` : `${picker.minute} */${picker.every} * * *` };
      default:
        return null;
    }
  }

  function queuePreview() {
    const { preview } = picker.nodes;
    if (preview && picker.mode !== "custom") syncCron();
    if (!preview || $("panel-jobs").hidden) return;
    clearTimeout(picker.timer);
    const when = currentSchedule();
    const serial = ++picker.serial;
    if (!when) {
      const hint = picker.mode === "weekly" && !picker.days.size ? "Pick at least one day." : "Fill in the time to see when this runs.";
      setPreview(hint, "idle");
      return;
    }
    picker.timer = setTimeout(async () => {
      try {
        const data = await api("/api/schedule/preview", { method: "POST", body: when });
        if (serial !== picker.serial) return;
        setPreview(when.at || !data.nextRunAt ? data.text : `${data.text} · next ${formatRun(data.nextRunAt)}`, "ok");
      } catch (error) {
        if (serial === picker.serial) setPreview(error.message, "error");
      }
    }, 220);
  }

  function setPreview(text, tone) {
    picker.nodes.preview.textContent = text;
    picker.nodes.preview.dataset.tone = tone;
  }

  // "Fri 24 Oct, 08:00" in the server's time zone, the way the server words it.
  function formatRun(ms) {
    if (!ms) return "";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: state.server?.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
  }

  function wallClock(ms, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  }

  // "2026-10-24T09:00" read as wall-clock time in `timeZone` -> the instant, in ms.
  function zonedInstant(value, timeZone) {
    const [date, time] = String(value).split("T");
    const [year, month, day] = (date || "").split("-").map(Number);
    const [hour, minute] = (time || "").split(":").map(Number);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    if (!Number.isFinite(wanted)) return NaN;
    let guess = wanted;
    for (let i = 0; i < 3; i += 1) guess = wanted - (wallClock(guess, timeZone) - guess);
    return guess;
  }

  function defaultOnce() {
    const now = new Date(wallClock(Date.now(), state.server?.timezone));
    now.setUTCDate(now.getUTCDate() + 1);
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T09:00`;
  }

  function renderJobs() {
    els["job-list"].replaceChildren();
    if (!state.bot) return;
    syncZone();
    queuePreview();
    if (!state.jobs.length) {
      els["job-list"].append(el("p", "hint", "No scheduled jobs. A job wakes this agent on its own, at the time you pick."));
      return;
    }
    // Switching agents (or a job that was deleted) ends an edit.
    if (editing && !state.jobs.some((job) => job.id === editing.id)) stopEditing({ keepText: false });
    for (const job of state.jobs) els["job-list"].append(jobRow(job));
  }

  // The picker's controls for a job that already exists. A cron the picker cannot draw opens as Custom.
  function loadPicker(job) {
    picker.cron = "";
    picker.nodes.cron.value = "";
    if (job.at) {
      picker.mode = "once";
      picker.last = "once";
      const clock = new Date(wallClock(job.at, state.server?.timezone));
      const pad = (value) => String(value).padStart(2, "0");
      picker.at = `${clock.getUTCFullYear()}-${pad(clock.getUTCMonth() + 1)}-${pad(clock.getUTCDate())}T${pad(clock.getUTCHours())}:${pad(clock.getUTCMinutes())}`;
    } else {
      const found = matchCron(String(job.cron || ""));
      picker.mode = found.mode;
      if (found.mode === "custom") picker.cron = job.cron;
      else picker.last = found.mode;
      Object.assign(picker, found.set);
    }
    picker.nodes.fields.dataset.mode = "";
    syncPicker();
  }

  // The inverse of currentSchedule(): which picker mode draws this cron, and with what values.
  function matchCron(cron) {
    const parts = cron.trim().split(/\s+/);
    if (parts.length === 5) {
      const [minute, hour, day, month, week] = parts;
      const whole = (value) => /^\d+$/.test(value);
      const time = whole(minute) && whole(hour) ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "";
      if (time && day === "*" && month === "*") {
        if (week === "*") return { mode: "daily", set: { time } };
        if (week === "1-5") return { mode: "weekdays", set: { time } };
        if (/^\d(,\d)*$/.test(week)) return { mode: "weekly", set: { time, days: new Set(week.split(",").map(Number)) } };
      }
      if (time && whole(day) && month === "*" && week === "*") return { mode: "monthly", set: { time, monthDay: Number(day) } };
      if (whole(minute) && day === "*" && month === "*" && week === "*") {
        if (hour === "*") return { mode: "hours", set: { every: 1, minute: Number(minute) } };
        const every = /^\*\/(\d+)$/.exec(hour);
        if (every) return { mode: "hours", set: { every: Number(every[1]), minute: Number(minute) } };
      }
    }
    return { mode: "custom", set: {} };
  }

  function startEditing(job) {
    editing = job;
    els["job-name"].value = job.name;
    els["job-prompt"].value = job.prompt;
    loadPicker(job);
    $("job-form-title").textContent = `Edit job: ${job.name}`;
    $("job-submit").textContent = "Save changes";
    $("job-cancel").hidden = false;
    els["job-form"].scrollIntoView({ block: "nearest", behavior: "smooth" });
    els["job-name"].focus();
  }

  function stopEditing({ keepText = true } = {}) {
    editing = null;
    $("job-form-title").textContent = "New job";
    $("job-submit").textContent = "Create job";
    $("job-cancel").hidden = true;
    if (!keepText) return;
    els["job-name"].value = "";
    els["job-prompt"].value = "";
  }

  function syncZone() {
    const { zone } = picker.nodes;
    const timeZone = state.server?.timezone;
    zone.textContent = timeZone ? `Times use the server's time zone (${timeZone.replace(/_/g, " ")}).` : "";
    zone.hidden = !timeZone;
  }

  function jobRow(job) {
    const item = el("div", "item");
    // app.js adds each job's spend and run history to its card by this id.
    item.dataset.jobId = job.id;
    const head = el("div", "item-head job-head");
    const copy = el("div", "job-copy");
    copy.append(el("div", "item-title", job.name));
    const next = job.done ? "" : job.enabled && job.nextRunAt ? ` · next ${formatRun(job.nextRunAt)}` : job.enabled ? "" : " · paused";

    const actions = el("div", "item-actions");
    actions.append(jobButton("Run now", () => runJob(job)));
    actions.append(jobButton("Edit", () => startEditing(job)));
    if (!job.done) actions.append(jobButton(job.enabled ? "Pause" : "Resume", () => toggleJob(job)));
    actions.append(jobButton("Delete", () => deleteJob(job)));
    head.append(copy, actions);
    item.append(head, el("div", "job-schedule", `${job.schedule || job.cron || "Custom schedule"}${next}`));

    const tags = el("div", "job-tags");
    if (job.createdBy === "bot") tags.append(el("span", "pill routine", `Set by ${state.bot.name}`));
    if (job.createdBy === "import") tags.append(el("span", "pill", "Imported"));
    if (job.done) tags.append(el("span", "pill ok", "Done"));
    else if (!job.enabled) tags.append(el("span", "pill warn", "Paused"));
    if (tags.childElementCount) item.append(tags);

    item.append(el("p", "item-note", job.lastStatus
      ? `Last run ${timeAgo(job.lastRunAt)} · ${job.lastStatus}${job.lastSummary ? ` · ${job.lastSummary}` : ""}`
      : job.prompt));

    const details = document.createElement("details");
    details.className = "job-details";
    details.append(el("summary", "", "Details"));
    details.append(el("p", "mono", job.at ? `one time, ${new Date(job.at).toISOString()}` : `cron ${job.cron}`));
    if (job.lastStatus) details.append(el("p", "hint", job.prompt));
    item.append(details);
    return item;
  }

  function jobButton(label, onClick) {
    const button = el("button", "ghost", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function jobName(prompt) {
    const text = prompt.replace(/\s+/g, " ").trim();
    if (text.length <= 40) return text;
    const cut = text.slice(0, 40);
    return cut.slice(0, Math.max(20, cut.lastIndexOf(" "))).trim();
  }

  async function saveJob(event) {
    event.preventDefault();
    if (!state.bot) return;
    const when = currentSchedule();
    if (!when) return toast("Pick when this should run.", "error");
    const prompt = els["job-prompt"].value.trim();
    if (!prompt) return toast("Write what the agent should do.", "error");
    const body = { name: els["job-name"].value.trim() || jobName(prompt), prompt, ...when };
    try {
      if (editing) {
        await api(`/api/bots/${state.bot.id}/jobs/${editing.id}`, { method: "PATCH", body });
        stopEditing();
        toast("Job updated.");
      } else {
        await api(`/api/bots/${state.bot.id}/jobs`, { method: "POST", body });
        els["job-name"].value = "";
        els["job-prompt"].value = "";
        toast("Job scheduled.");
      }
      await reloadBot();
      showPanel("jobs");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function toggleJob(job) {
    try {
      await api(`/api/bots/${state.bot.id}/jobs/${job.id}`, { method: "PATCH", body: { enabled: !job.enabled } });
      await reloadBot();
      showPanel("jobs");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function runJob(job) {
    try {
      await api(`/api/bots/${state.bot.id}/jobs/${job.id}/run`, { method: "POST" });
      toast(`Running “${job.name}”.`);
      state.panel = "screen";
      showPanel("screen");
      setTimeout(poll, 250);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function deleteJob(job) {
    if (!confirm(`Delete the job “${job.name}”?`)) return;
    try {
      await api(`/api/bots/${state.bot.id}/jobs/${job.id}`, { method: "DELETE" });
      await reloadBot();
      showPanel("jobs");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  window.renderJobs = renderJobs;
  window.formatRun = formatRun;
})();
