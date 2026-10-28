// Home dashboard. app.js calls window.RavnirHome.render(body, data) on every poll.
// The hero (greeting, summary, quick-ask) is built once and updated in place so the
// input keeps its text, focus and caret. Agent faces live in a pool so they keep blinking.
(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const ASK_KEY = "ravnir.home.ask";
  const METRIC_KEY = "ravnir.home.metric";
  const PHONE_AGENTS = 6;
  const METRICS = [
    { id: "cost", label: "Cost" },
    { id: "tokens", label: "Tokens" },
    { id: "turns", label: "Turns" },
  ];

  const ui = {
    root: null,
    hero: null,
    kicker: null,
    title: null,
    summary: null,
    form: null,
    input: null,
    pick: null,
    pickFace: null,
    menu: null,
    send: null,
    rest: null,
    askId: readStored(ASK_KEY),
    menuOpen: false,
    sending: false,
    metric: METRICS.some((m) => m.id === readStored(METRIC_KEY)) ? readStored(METRIC_KEY) : "cost",
    showAll: false,
    allAgents: false,
    spendOpen: null, // null = default (open on desktop, closed on phone)
    answeredOpen: false,
    quietOpen: false,
    faces: new Map(),
    askFace: null,
    restSig: "",
    restMinute: 0,
    chart: null, // { sig, node }
  };

  const svg = (name, attrs = {}) => {
    const node = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  function button(className, text, onClick, label = "") {
    const node = el("button", className, text);
    node.type = "button";
    if (label) node.setAttribute("aria-label", label);
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  function startOfDay(at) {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // "08:00", "Tomorrow 08:00", "Mon 08:00"
  function whenLabel(at, { bare = false } = {}) {
    const days = Math.round((startOfDay(at) - startOfDay(Date.now())) / 86_400_000);
    const time = clockTime(at);
    if (days <= 0) return bare ? time : `Today ${time}`;
    if (days === 1) return `Tomorrow ${time}`;
    return `${new Date(at).toLocaleDateString(LOCALE, { weekday: "short" })} ${time}`;
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return "Good morning";
    if (hour >= 12 && hour < 19) return "Good afternoon";
    return "Good evening";
  }

  function liveBot(botId) {
    return state.bots.find((bot) => bot.id === botId);
  }

  // Pending approvals from the selected agent's detail and from the Home feed (every agent).
  function pendingApprovals() {
    const own = (state.approvals || []).filter((item) => !item.status || item.status === "pending");
    return [...own, ...(last?.approvals?.pending || [])];
  }

  // One face node per agent id, re-appended on every render so its blinking carries on.
  function face(bot, className) {
    let node = ui.faces.get(bot.id);
    if (!node) {
      node = el("span", "avatar home-face");
      ui.faces.set(bot.id, node);
    }
    node.className = `avatar home-face ${className || ""}`.trim();
    paintCreature(node, bot);
    return node;
  }

  function mini(bot) {
    const node = el("span", "avatar xs");
    paintCreature(node, bot);
    return node;
  }

  // ---------- hero ----------

  function summaryText(data) {
    const waiting = data.approvals.pending.length + data.specs.length + (data.proposals || []).length + (data.questions || []).length + (data.failures || []).length + (data.stuck || []).length;
    const worked = (data.bots || []).filter((bot) => bot.turns > 0).length;
    const spent = data.totals.cost > 0 ? ` and spent ${money(data.totals.cost)}` : "";
    const parts = [];
    if (!data.isToday) {
      if (!data.totals.turns) return "No agent ran that day.";
      parts.push(`${plural(worked, "agent")} ran ${turnCount(data.totals.turns)}${spent}.`);
      if (data.totals.errors) parts.push(`${plural(data.totals.errors, "turn")} failed.`);
      return parts.join(" ");
    }
    if (waiting) parts.push(waiting === 1 ? "1 thing waits for you." : `${waiting} things wait for you.`);
    // An agent paused on an approval counts as waiting, not as working.
    const waitingIds = new Set([...pendingApprovals(), ...(data.questions || [])].map((item) => item.botId));
    const busy = state.bots.filter((bot) => bot.busy && !waitingIds.has(bot.id)).length;
    if (busy) parts.push(busy === 1 ? "1 agent is working right now." : `${busy} agents are working right now.`);
    if (worked) parts.push(`${plural(worked, "agent")} worked today${spent}.`);
    else if (!busy) parts.push("No agent has run yet today.");
    const next = (data.soon || [])[0];
    if (next) {
      const days = Math.round((startOfDay(next.at) - startOfDay(Date.now())) / 86_400_000);
      const when = days <= 0 ? `at ${clockTime(next.at)}` : days === 1 ? `at ${clockTime(next.at)} tomorrow` : `on ${new Date(next.at).toLocaleDateString(LOCALE, { weekday: "short" })} at ${clockTime(next.at)}`;
      parts.push(`Next up: ${next.jobName} ${when}.`);
    }
    return parts.join(" ");
  }

  function askTarget() {
    const bots = state.bots;
    return bots.find((bot) => bot.id === ui.askId) || bots.find((bot) => bot.main) || bots[0] || null;
  }

  function buildHero() {
    ui.hero = el("section", "home-hero");
    ui.kicker = el("p", "home-kicker");
    ui.title = el("h2", "home-title");
    ui.summary = el("p", "home-summary");
    ui.hero.append(ui.title, ui.summary);

    ui.form = el("form", "home-ask");
    ui.form.autocomplete = "off";
    ui.pick = button("home-ask-pick", "", () => toggleMenu(), "Choose which agent to ask");
    ui.pick.setAttribute("aria-haspopup", "true");
    ui.pick.setAttribute("aria-expanded", "false");
    ui.pickFace = el("span", "home-ask-face");
    ui.pick.append(ui.pickFace);
    ui.input = el("input", "home-ask-input");
    ui.input.type = "text";
    ui.input.enterKeyHint = "send";
    ui.input.setAttribute("aria-label", "Ask an agent");
    ui.send = button("home-ask-send", "", null, "Send");
    ui.send.type = "submit";
    ui.send.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
    ui.menu = el("div", "home-ask-menu");
    ui.menu.hidden = true;
    ui.menu.setAttribute("role", "menu");
    ui.form.append(ui.pick, ui.input, ui.send, ui.menu);
    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitAsk();
    });
    ui.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
    ui.input.addEventListener("input", syncSend);
    document.addEventListener("click", (event) => {
      if (ui.menuOpen && !ui.form.contains(event.target)) closeMenu();
    });
    ui.hero.append(ui.form);
  }

  function syncSend() {
    ui.send.classList.toggle("ready", Boolean(ui.input.value.trim()) && !ui.sending);
  }

  function toggleMenu() {
    if (ui.menuOpen) closeMenu();
    else openMenu();
  }

  function closeMenu() {
    ui.menuOpen = false;
    ui.menu.hidden = true;
    ui.pick.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    ui.menuOpen = true;
    ui.menu.hidden = false;
    ui.pick.setAttribute("aria-expanded", "true");
    fillMenu();
  }

  function fillMenu() {
    const target = askTarget();
    ui.menu.replaceChildren(el("p", "home-ask-menu-title", "Ask"));
    for (const bot of state.bots) {
      const item = button(`home-ask-option${target && bot.id === target.id ? " active" : ""}`, "", () => {
        ui.askId = bot.id;
        writeStored(ASK_KEY, bot.id);
        closeMenu();
        syncAsk();
        ui.input.focus();
      });
      item.setAttribute("role", "menuitem");
      item.append(mini(bot), el("span", "home-ask-option-name", bot.name));
      ui.menu.append(item);
    }
  }

  function syncAsk() {
    const target = askTarget();
    const disabled = !target;
    ui.input.disabled = disabled;
    ui.pick.disabled = disabled;
    ui.input.placeholder = target ? `Ask ${target.name} anything…` : "Create an agent to start asking";
    if (target) {
      // One face node, repainted in place, so it keeps blinking across polls.
      if (!ui.askFace) ui.askFace = el("span", "avatar home-ask-avatar");
      paintCreature(ui.askFace, target);
      if (ui.pickFace.firstChild !== ui.askFace) ui.pickFace.replaceChildren(ui.askFace);
      ui.pick.setAttribute("aria-label", `Asking ${target.name}. Choose another agent`);
    } else {
      ui.pickFace.replaceChildren();
    }
    syncSend();
  }

  async function submitAsk() {
    const text = ui.input.value.trim();
    const target = askTarget();
    if (!text || !target || ui.sending) return;
    ui.sending = true;
    syncSend();
    try {
      await selectBot(target.id);
      els["composer-input"].value = text;
      await sendMessage();
      ui.input.value = "";
    } catch (error) {
      toast(error?.message || "Could not send that", "error");
    } finally {
      ui.sending = false;
      syncSend();
    }
  }

  // ---------- sections ----------

  function section(title, hint, extra) {
    const wrap = el("section", "home-section");
    const head = el("div", "home-section-head");
    head.append(el("h3", "home-section-title", title));
    if (hint) head.append(el("span", "home-section-hint", hint));
    if (extra) head.append(extra);
    wrap.append(head);
    return wrap;
  }

  function collapsible(title, hint, open, onToggle, content) {
    const wrap = el("section", `home-section home-collapse${open ? " open" : ""}`);
    const head = button("home-collapse-head", "", () => {
      onToggle(!open);
      renderAgain();
    });
    head.setAttribute("aria-expanded", String(open));
    head.append(el("span", "home-section-title", title));
    if (hint) head.append(el("span", "home-section-hint", hint));
    head.append(el("span", "home-chevron"));
    wrap.append(head);
    if (open) {
      const inner = el("div", "home-collapse-body");
      inner.append(content());
      wrap.append(inner);
    }
    return wrap;
  }

  // After an answer goes out, Home and the badges re-read what still waits.
  function refreshAfterAnswer() {
    ui.restSig = "";
    if (typeof loadToday === "function") loadToday();
    if (typeof refreshBots === "function") refreshBots();
  }

  // A routine that failed, and a turn that has run a long time with no end in sight (server/index.js /api/today).
  function needCard(kind, botId, botName, title, detail, when) {
    const bot = liveBot(botId);
    const node = el("div", `today-card home-need ${kind}`);
    const head = el("div", "today-card-head");
    head.append(bot ? mini(bot) : el("span", "avatar xs"), el("span", "ask-who", botName || bot?.name || "An agent"), el("span", "ask-when", when));
    node.append(head, el("p", "today-card-title", title));
    if (detail) node.append(el("p", "home-need-detail", detail));
    return node;
  }

  function failureCard(failure) {
    const node = needCard("failed", failure.botId, failure.botName, `${failure.jobName || "A routine"} failed`, failure.error || "", timeAgo(failure.at));
    const actions = el("div", "row approval-actions");
    actions.append(
      button("primary", "Open", async () => {
        await selectBot(failure.botId);
        showPanel("jobs");
        els.shell.classList.add("computer-open");
      }),
      button("ghost", "Dismiss", async (event) => {
        event.currentTarget.disabled = true;
        try {
          await api(`/api/bots/${encodeURIComponent(failure.botId)}/jobs/${encodeURIComponent(failure.jobId)}/dismiss`, { method: "POST", body: {} });
        } catch (error) {
          toast(error.message, "error");
        }
        refreshAfterAnswer();
      }),
    );
    node.append(actions);
    return node;
  }

  function stuckCard(run) {
    const name = run.botName || liveBot(run.botId)?.name || "An agent";
    const minutes = Math.max(1, Math.round((Date.now() - run.startedAt) / 60_000));
    const detail = `Running for ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}${run.activity ? `, last step: ${run.activity}` : ""}.`;
    const node = needCard("stuck", run.botId, name, `${name} seems stuck`, detail, run.jobName || "");
    const actions = el("div", "row approval-actions");
    actions.append(button("primary", "Open", () => selectBot(run.botId)));
    node.append(actions);
    return node;
  }

  function needsBlock(data) {
    const pending = data.approvals.pending;
    const specs = data.specs || [];
    const proposals = data.proposals || [];
    const questions = data.questions || [];
    const failures = data.failures || [];
    const stuck = data.stuck || [];
    const count = pending.length + specs.length + proposals.length + questions.length + failures.length + stuck.length;
    if (!count) return null;
    const wrap = el("section", "home-needs");
    const head = el("div", "home-section-head");
    head.append(el("h3", "home-section-title", "Needs you"), el("span", "home-count", String(count)));
    wrap.append(head);
    const stack = el("div", "home-needs-stack");
    for (const request of pending) stack.append(approvalCard(request));
    for (const failure of failures) stack.append(failureCard(failure));
    for (const run of stuck) stack.append(stuckCard(run));
    for (const ask of questions) {
      const bot = liveBot(ask.botId);
      const node = window.RavnirQuestions?.homeCard(ask, {
        bot,
        face: bot ? mini(bot) : null,
        onOpen: () => selectBot(ask.botId),
        onSent: () => refreshAfterAnswer(),
      });
      if (node) stack.append(node);
    }
    if (specs.length) stack.append(specsSection(specs));
    const suggestions = window.suggestionsSection ? window.suggestionsSection(proposals) : null;
    if (suggestions && proposals.length) stack.append(suggestions);
    wrap.append(stack);
    return wrap;
  }

  // ---------- agent tiles ----------

  function agentRank(bot, waiting) {
    if (waiting.has(bot.id)) return 0;
    if (bot.status === "off") return 3;
    if (bot.busy) return 1;
    return 2;
  }

  function tile(bot, row, waiting) {
    const rank = agentRank(bot, waiting);
    const kind = ["waiting", "working", "idle", "paused"][rank];
    const node = el("div", `home-tile ${kind}`);
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.dataset.key = `tile:${bot.id}`;
    const open = () => selectBot(bot.id);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    const text = el("div", "home-tile-text");
    const nameLine = el("div", "home-tile-name");
    nameLine.append(el("span", "home-tile-title", bot.name));
    if (bot.unread) {
      const dot = el("span", "home-unread");
      dot.title = "Unread";
      nameLine.append(dot);
    }
    const status = el("div", "home-tile-status");
    status.append(el("span", "home-dot"));
    let line = "";
    if (kind === "waiting") line = pendingApprovals().some((item) => item.botId === bot.id) ? "Needs your approval" : "Has a question for you";
    else if (kind === "working") line = bot.activity || "Working";
    else if (kind === "paused") line = "Paused";
    else line = `Idle · ${bot.lastActiveAt ? `active ${timeAgo(bot.lastActiveAt)}` : "no runs yet"}`;
    status.append(el("span", "home-tile-line", line));
    text.append(nameLine, status);
    if (kind === "idle" && bot.nextJobAt) {
      text.append(el("div", "home-tile-next", `Next: ${whenLabel(bot.nextJobAt, { bare: true })}`));
    }
    node.append(face(bot, "home-tile-face"), text);
    const turns = row?.turns || 0;
    if (turns) {
      const spend = el("span", "home-tile-spend");
      spend.append(el("b", "", money(row.cost)), el("span", "home-tile-turns", ` · ${turnCount(turns)}`));
      spend.title = `${money(row.cost)} and ${turnCount(turns)} today`;
      node.append(spend);
    }
    node.setAttribute("aria-label", `${bot.name}. ${line}`);
    return node;
  }

  function agentsBlock(data) {
    const waiting = new Set([...pendingApprovals(), ...(data.questions || [])].map((item) => item.botId));
    const rows = new Map((data.bots || []).map((row) => [row.botId, row]));
    const bots = [...state.bots].sort((a, b) => {
      const ra = agentRank(a, waiting);
      const rb = agentRank(b, waiting);
      if (ra !== rb) return ra - rb;
      return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
    });
    const wrap = section("Agents now");
    const grid = el("div", "home-tiles");
    // On a phone the first few (waiting and working sort first) are enough; the rest fold away.
    const fold = isPhone() && bots.length > PHONE_AGENTS && !ui.allAgents;
    for (const bot of fold ? bots.slice(0, PHONE_AGENTS) : bots) grid.append(tile(bot, rows.get(bot.id), waiting));
    wrap.append(grid);
    if (isPhone() && bots.length > PHONE_AGENTS) {
      wrap.append(button("home-link center", ui.allAgents ? "Show fewer" : `Show all (${bots.length})`, () => {
        ui.allAgents = !ui.allAgents;
        renderAgain();
      }));
    }
    return wrap;
  }

  // ---------- activity ----------

  function metricValue(entry, metric) {
    return Number(entry?.[metric]) || 0;
  }

  function metricText(value, metric) {
    if (metric === "cost") return money(value);
    if (metric === "tokens") return tokenLabel(value);
    return turnCount(value);
  }

  function buildChart(series, metric, shownDay) {
    const max = Math.max(0, ...series.map((entry) => metricValue(entry, metric)));
    const W = 280;
    const H = 84;
    const gap = 5;
    const barW = (W - gap * (series.length - 1)) / series.length;
    const wrap = el("div", "home-chart");
    const top = el("div", "home-chart-top");
    top.append(el("span", "home-chart-max", max ? `Max ${metricText(max, metric)}` : "No activity yet"));
    wrap.append(top);
    const stage = el("div", "home-chart-stage");
    const canvas = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "home-chart-svg", role: "img", "aria-label": `Last ${series.length} days, ${metric}` });
    const tip = el("div", "home-chart-tip");
    tip.hidden = true;
    let pinned = -1;
    const show = (index) => {
      const entry = series[index];
      const date = new Date(entry.day).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });
      tip.textContent = `${date} · ${money(entry.cost)} · ${turnCount(entry.turns)}`;
      tip.hidden = false;
      const center = ((index + 0.5) * (barW + gap) - gap / 2) / W;
      tip.style.left = `${Math.min(86, Math.max(14, center * 100))}%`;
    };
    series.forEach((entry, index) => {
      const x = index * (barW + gap);
      const value = metricValue(entry, metric);
      const height = max ? Math.max(value ? 3 : 0, (value / max) * (H - 6)) : 0;
      const isShown = entry.day === shownDay;
      if (!value) {
        canvas.append(svg("rect", { x, y: H - 2, width: barW, height: 2, rx: 1, class: "home-bar stub" }));
      } else {
        canvas.append(svg("rect", { x, y: H - height, width: barW, height, rx: 2, class: `home-bar${isShown ? " shown" : ""}` }));
      }
      const hit = svg("rect", { x: x - gap / 2, y: 0, width: barW + gap, height: H, class: "home-bar-hit" });
      hit.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "touch") show(index);
      });
      hit.addEventListener("pointerleave", (event) => {
        if (event.pointerType !== "touch" && pinned < 0) tip.hidden = true;
      });
      hit.addEventListener("click", () => {
        pinned = pinned === index ? -1 : index;
        if (pinned < 0) tip.hidden = true;
        else show(index);
      });
      canvas.append(hit);
    });
    stage.append(canvas, tip);
    wrap.append(stage);
    const axis = el("div", "home-chart-axis");
    const first = new Date(series[0].day).toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
    axis.append(el("span", "", first), el("span", "", series[series.length - 1].day === startOfDay(Date.now()) ? "Today" : new Date(series[series.length - 1].day).toLocaleDateString(LOCALE, { day: "numeric", month: "short" })));
    wrap.append(axis);
    return wrap;
  }

  function hoursStrip(data) {
    const hours = data.hours || [];
    const peak = Math.max(1, ...hours.map((h) => h.turns));
    const wrap = el("div", "home-hours");
    wrap.append(el("p", "home-hours-title", "By hour"));
    const strip = el("div", "home-hours-strip");
    hours.forEach((h, index) => {
      const cell = el("span", "home-hour");
      if (h.turns) {
        const mix = Math.round(22 + (h.turns / peak) * 68);
        cell.style.background = `color-mix(in srgb, ${h.errors ? "var(--red)" : "var(--accent)"} ${mix}%, transparent)`;
      }
      cell.title = `${String(index).padStart(2, "0")}:00 · ${turnCount(h.turns)}${h.cost ? ` · ${money(h.cost)}` : ""}${h.errors ? ` · ${plural(h.errors, "error")}` : ""}`;
      strip.append(cell);
    });
    if (data.isToday) {
      const now = new Date();
      const marker = el("span", "home-now");
      marker.style.left = `${((now.getHours() + now.getMinutes() / 60) / 24) * 100}%`;
      marker.title = "Now";
      strip.append(marker);
    }
    wrap.append(strip);
    const labels = el("div", "home-hours-labels");
    for (const h of [0, 6, 12, 18]) {
      const label = el("span", "", String(h));
      label.style.left = `${(h / 24) * 100}%`;
      labels.append(label);
    }
    wrap.append(labels);
    return wrap;
  }

  function activityCard(data) {
    const card = el("section", "home-card home-activity");
    const head = el("div", "home-activity-head");
    const nums = el("div", "home-nums");
    const num = (label, value, bad) => {
      const box = el("div", `home-num${bad ? " bad" : ""}`);
      box.append(el("b", "", value), el("span", "", label));
      return box;
    };
    nums.append(num("Turns", String(data.totals.turns)), num("Cost", money(data.totals.cost)), num("Tokens", exactNumber(data.totals.tokens)), num("Asks", String(data.totals.asks || 0)));
    if (data.totals.errors > 0) nums.append(num("Errors", String(data.totals.errors), true));
    const seg = el("div", "home-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Chart metric");
    for (const m of METRICS) {
      const b = button(`home-seg-btn${ui.metric === m.id ? " on" : ""}`, m.label, () => {
        ui.metric = m.id;
        writeStored(METRIC_KEY, m.id);
        renderAgain();
      });
      b.setAttribute("aria-pressed", String(ui.metric === m.id));
      seg.append(b);
    }
    head.append(nums, seg);
    card.append(head);
    const series = data.series || [];
    if (series.length) {
      const sig = JSON.stringify([ui.metric, data.day, series]);
      if (!ui.chart || ui.chart.sig !== sig) ui.chart = { sig, node: buildChart(series, ui.metric, data.day) };
      card.append(ui.chart.node);
    }
    card.append(hoursStrip(data));
    return card;
  }

  // ---------- coming up ----------

  function comingUp(data) {
    const wrap = section("Coming up");
    const upcoming = data.upcoming || [];
    const soon = data.soon || [];
    const list = el("div", "home-timeline");
    const row = (item, label) => {
      const line = el("div", "home-up");
      const bot = liveBot(item.botId);
      line.append(el("span", "home-up-time", label));
      const who = el("span", "home-up-who");
      if (bot) who.append(mini(bot));
      line.append(who, el("span", "home-up-job", item.jobName), el("span", "home-up-schedule", item.schedule || ""));
      return line;
    };
    if (upcoming.length) {
      for (const item of upcoming) list.append(row(item, clockTime(item.at)));
      wrap.append(list);
      return wrap;
    }
    if (soon.length) {
      list.append(el("p", "home-quiet", "Nothing else today."));
      for (const item of soon) list.append(row(item, whenLabel(item.at)));
      wrap.append(list);
      return wrap;
    }
    const quiet = el("div", "home-quiet-row");
    quiet.append(el("span", "home-quiet", "No routines coming up."), button("home-link", "Plan a routine", () => openSchedules()));
    wrap.append(quiet);
    return wrap;
  }

  // ---------- what happened ----------

  function happened(data) {
    const all = data.timeline || [];
    // Routine runs with nothing to report fold into one line instead of a card each.
    const rows = all.filter((row) => !row.quiet);
    const quiet = all.filter((row) => row.quiet);
    const wrap = section("What they brought back", rows.length ? `${rows.length}` : "");
    if (!rows.length && !quiet.length) {
      wrap.append(el("p", "home-quiet", data.isToday ? "No agent has run yet today." : "No agent ran that day."));
      return wrap;
    }
    const list = el("div", "home-feed");
    const shown = ui.showAll ? rows : rows.slice(0, 8);
    for (const row of shown) list.append(turnCard(row));
    wrap.append(list);
    if (rows.length > 8) {
      wrap.append(button("home-link center", ui.showAll ? "Show fewer" : `Show all (${rows.length})`, () => {
        ui.showAll = !ui.showAll;
        renderAgain();
      }));
    }
    if (quiet.length) {
      const fold = el("div", "home-quiet-fold");
      fold.append(button("home-link", `${plural(quiet.length, "quiet routine run")}${ui.quietOpen ? "" : ", no news"}`, () => {
        ui.quietOpen = !ui.quietOpen;
        renderAgain();
      }));
      if (ui.quietOpen) {
        for (const row of quiet) {
          const bot = liveBot(row.botId);
          fold.append(el("p", "home-quiet-row", `${clockTime(row.at)} · ${bot?.name || row.botName || "Agent"} · ${row.jobName || "Routine"}`));
        }
      }
      wrap.append(fold);
    }
    return wrap;
  }

  // ---------- spend ----------

  function spendDetails(data) {
    const open = ui.spendOpen === null ? !isPhone() : ui.spendOpen;
    return collapsible("Spend details", money(data.totals.cost), open, (next) => (ui.spendOpen = next), () => {
      const body = el("div", "home-spend");
      const rows = (data.bots || []).filter((row) => row.turns > 0 || row.limits?.dailyCost || row.limits?.dailyTokens);
      if (rows.length) {
        const list = el("div", "home-spend-list");
        for (const row of rows) {
          const line = el("div", "home-spend-row");
          const head = el("div", "home-spend-head");
          head.append(botBadge(row.botId, row.name), el("b", "home-spend-money", money(row.cost)), el("span", "home-spend-meta", `${tokenLabel(row.tokens)} · ${turnCount(row.turns)}`));
          line.append(head);
          const cap = capBar(row, row.limits || {});
          if (cap) line.append(cap);
          list.append(line);
        }
        body.append(el("p", "home-sub", "By agent"), list);
      } else {
        body.append(el("p", "home-quiet", "No spend recorded for this day."));
      }
      if ((data.models || []).length) body.append(el("p", "home-sub", "By model"), modelTable(data.models));
      return body;
    });
  }

  function answered(data) {
    const decided = data.approvals.decided || [];
    if (!decided.length) return null;
    return collapsible("Answered", String(decided.length), ui.answeredOpen, (next) => (ui.answeredOpen = next), () => {
      const section = answeredSection(decided);
      // answeredSection brings its own heading; the collapsible already has one.
      section.querySelector(".today-section-title")?.remove();
      return section;
    });
  }

  // ---------- footer ----------

  function footer(data) {
    const bots = data.bots || [];
    const enabled = bots.reduce((sum, bot) => sum + (bot.enabledJobs || 0), 0);
    const paused = bots.reduce((sum, bot) => sum + (bot.pausedJobs || 0), 0);
    const browser = bots.some((bot) => bot.browserReady);
    const teams = (state.groups || []).length;
    const wrap = el("div", "home-footer");
    const main = state.bots.find((bot) => bot.main) || state.bots[0];
    const chip = (text, onClick) => wrap.append(button("home-chip", text, onClick));
    chip(plural(state.bots.length, "agent"), () => main && selectBot(main.id));
    chip(plural(teams, "team"), () => createNewGroup());
    chip(`${plural(enabled, "routine")} on${paused ? ` · ${paused} paused` : ""}`, () => openSchedules());
    chip(browser ? "Browser ready" : "No browser", () => openBrowserCard());
    chip("Plugins", () => openPlugins());
    return wrap;
  }

  function emptyState(bots, data) {
    const wrap = el("section", "home-empty");
    wrap.append(
      el("h3", "home-empty-title", "No agents yet"),
      el("p", "home-empty-text", "An agent is a persistent assistant that lives on this server. It remembers, uses a browser and a shell, and can run routines on its own."),
    );
    wrap.append(button("primary home-empty-btn", "Create your first agent", () => openNewBot()));
    return wrap;
  }

  // ---------- render ----------

  let last = null;
  let lastBody = null;

  function renderAgain() {
    if (lastBody) render(lastBody, last);
  }

  function ensureRoot(body) {
    if (!ui.root) {
      ui.root = el("div", "home");
      buildHero();
      ui.rest = el("div", "home-rest");
      ui.root.append(ui.hero, ui.rest);
    }
    if (body.firstElementChild !== ui.root || body.children.length !== 1) body.replaceChildren(ui.root);
    body.classList.add("home-body");
  }

  // Everything the body below the hero depends on, besides the clock.
  function restSignature(data) {
    const bots = (state.bots || []).map((bot) => [bot.id, bot.name, bot.busy, bot.activity, bot.status, bot.unread, bot.lastActiveAt, bot.nextJobAt, bot.main, bot.color, bot.avatar]);
    const today = state.today || {};
    return JSON.stringify([
      data, bots, pendingApprovals().map((item) => item.id), (state.groups || []).length,
      ui.metric, ui.showAll, ui.quietOpen, ui.allAgents, ui.spendOpen, ui.answeredOpen, isPhone(),
      [...(today.open || [])], [...(today.openSpecs || [])], [...(today.specViews?.keys?.() || [])],
    ]);
  }

  function render(body, data) {
    lastBody = body;
    last = data;
    ensureRoot(body);
    const activeKey = document.activeElement?.dataset?.key || "";
    if (!data) {
      ui.title.textContent = greeting();
      ui.summary.textContent = "Loading…";
      ui.form.hidden = true;
      ui.rest.replaceChildren(el("div", "home-skeleton"), el("div", "home-skeleton short"));
      ui.restSig = "";
      return;
    }
    const bots = state.bots || [];
    ui.title.textContent = data.isToday ? greeting() : "Looking back";
    ui.summary.textContent = summaryText(data);
    ui.form.hidden = !data.isToday;
    if (data.isToday) syncAsk();

    // Polls usually bring nothing new: keep the body (and focus, inner scroll, open diffs) when
    // nothing it shows changed. Relative times ("2 min ago") refresh once a minute, unless the
    // user is working inside the page right then.
    const sig = restSignature(data);
    const minute = Math.floor(Date.now() / 60_000);
    const focusInside = ui.rest.contains(document.activeElement);
    if (sig === ui.restSig && (minute === ui.restMinute || focusInside)) return;
    ui.restSig = sig;
    ui.restMinute = minute;

    const parts = [];
    const needs = needsBlock(data);
    if (needs) parts.push(needs);
    if (!bots.length) {
      parts.push(emptyState(bots, data));
    } else {
      if (data.isToday) parts.push(agentsBlock(data));
      parts.push(activityCard(data));
      if (data.isToday) parts.push(comingUp(data));
      parts.push(happened(data), spendDetails(data));
      const done = answered(data);
      if (done) parts.push(done);
    }
    // The checklist reads the feed's per-agent rows (ready, browserReady, jobCount, turnsTotal).
    const checklist = setupChecklist(data.bots || [], data);
    if (checklist && !checklist.classList.contains("complete")) {
      const setup = el("section", "home-section home-setup");
      setup.append(checklist);
      parts.push(setup);
    }
    if (bots.length) parts.push(footer(data));
    ui.rest.replaceChildren(...parts);

    if (activeKey) ui.rest.querySelector(`[data-key="${CSS.escape(activeKey)}"]`)?.focus({ preventScroll: true });
  }

  window.RavnirHome = { render };
})();
