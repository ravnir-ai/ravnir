// The capability card: an agent's measured score in eight areas, drawn as an octagon, with the tasks
// behind every number. Lives in the agent's Setup, Card tab. Loaded after app.js, so state, el, $,
// api, toast, normalizeLook and normalizeColor are global. The server side is server/cards.js and
// the tasks are evals/axes.mjs.

(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const card = { botId: "", data: null, loading: false, poll: null, open: {}, runs: 1 };

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  }

  function accent(bot) {
    return normalizeLook(bot?.avatar, bot?.color).color || normalizeColor(bot?.color);
  }

  const when = (at) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const money = (value) => (value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(value >= 0.1 ? 2 : 3)}`);

  // The octagon: one spoke per area, rings at 25, 50, 75 and 100, this card filled and the previous
  // one dashed, so a change after a new skill or model shows at a glance.
  function octagon(axes, previous, color) {
    const size = 300;
    const mid = size / 2;
    const radius = 104;
    const point = (index, value) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / axes.length;
      const r = (radius * Math.max(0, Math.min(100, value ?? 0))) / 100;
      return [mid + r * Math.cos(angle), mid + r * Math.sin(angle)];
    };
    const root = svg("svg", { viewBox: `0 0 ${size} ${size}`, class: "card-octagon", role: "img" });
    root.setAttribute("aria-label", axes.map((axis) => `${axis.label} ${axis.score ?? "not run"}`).join(", "));
    for (const ring of [25, 50, 75, 100]) {
      root.append(svg("polygon", { points: axes.map((_, index) => point(index, ring).join(",")).join(" "), class: ring === 100 ? "card-ring outer" : "card-ring" }));
    }
    axes.forEach((_, index) => {
      const [x, y] = point(index, 100);
      root.append(svg("line", { x1: mid, y1: mid, x2: x, y2: y, class: "card-spoke" }));
    });
    if (previous) {
      root.append(svg("polygon", { points: axes.map((axis, index) => point(index, previous.find((item) => item.id === axis.id)?.score ?? 0).join(",")).join(" "), class: "card-shape previous" }));
    }
    const shape = svg("polygon", { points: axes.map((axis, index) => point(index, axis.score ?? 0).join(",")).join(" "), class: "card-shape" });
    shape.style.setProperty("--card-color", color);
    root.append(shape);
    axes.forEach((axis, index) => {
      const [x, y] = point(index, axis.score ?? 0);
      const dot = svg("circle", { cx: x, cy: y, r: 3.2, class: "card-dot" });
      dot.style.setProperty("--card-color", color);
      root.append(dot);
      const [lx, ly] = point(index, 128);
      const anchor = Math.abs(lx - mid) < 8 ? "middle" : lx > mid ? "start" : "end";
      const label = svg("text", { x: lx, y: ly - 5, "text-anchor": anchor, class: "card-label" });
      label.textContent = axis.label;
      const score = svg("text", { x: lx, y: ly + 10, "text-anchor": anchor, class: "card-score" });
      score.textContent = axis.score === null ? "–" : String(axis.score);
      root.append(label, score);
    });
    return root;
  }

  function sameList(a = [], b = []) {
    return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  }

  function runBox(bot, data) {
    const box = el("div", "plug-block card-run");
    const running = data.running;
    if (running && running.mine) {
      box.append(el("p", "plug-block-title", "Running the card"));
      const bar = el("div", "card-progress");
      const fill = el("span", "");
      fill.style.width = `${running.total ? Math.round((running.done / running.total) * 100) : 0}%`;
      bar.append(fill);
      box.append(bar);
      box.append(el("p", "hint", `${running.done} of ${running.total || "?"} tasks done, ${running.finished} passed so far.${running.last ? ` Last: ${running.last.task} ${running.last.finished ? "passed" : "failed"}.` : ""}`));
      const stop = el("button", "ghost", "Stop");
      stop.type = "button";
      stop.addEventListener("click", async () => {
        try {
          await api(`/api/bots/${bot.id}/card/stop`, { method: "POST", body: {} });
          toast("Stopped. Nothing was saved from this run.");
        } catch (error) {
          toast(error.message, "error");
        }
        load(bot);
      });
      box.append(stop);
      return box;
    }
    const estimate = data.estimate;
    const tasks = estimate.tasks * card.runs;
    box.append(el("p", "plug-block-title", data.latest ? "Run it again" : "Measure this agent"));
    box.append(el("p", "hint", `${tasks} real tasks, each on a sealed copy of ${bot.name} with its model, job, instructions and skills. Its memory, logins, plugins and threads are not used or touched. About ${money(estimate.typical * card.runs)}, at most ${money(estimate.ceiling * card.runs)} (from ${estimate.basis}), and roughly ${Math.round(tasks * 0.6)} to ${Math.round(tasks * 1.4)} minutes.`));
    const row = el("div", "card-run-row");
    const runs = el("div", "seg two card-runs");
    for (const [value, label] of [[1, "Once"], [3, "3 times"]]) {
      const option = el("button", card.runs === value ? "on" : "", label);
      option.type = "button";
      option.title = value === 3 ? "Steadier score, three times the cost" : "One pass over every task";
      option.addEventListener("click", () => {
        card.runs = value;
        render(bot);
      });
      runs.append(option);
    }
    const start = el("button", "primary", "Run the card");
    start.type = "button";
    start.disabled = Boolean(running);
    start.addEventListener("click", async () => {
      start.disabled = true;
      try {
        await api(`/api/bots/${bot.id}/card`, { method: "POST", body: { runs: card.runs } });
        toast("Started. You can leave this page; it tells you when the card is ready.");
      } catch (error) {
        toast(error.message, "error");
      }
      load(bot);
    });
    row.append(runs, start);
    box.append(row);
    if (running && !running.mine) box.append(el("p", "hint", `${running.botName}'s card is running. One runs at a time.`));
    if (data.lastError) box.append(el("p", "error-text", `The last run did not finish: ${data.lastError.error}`));
    return box;
  }

  function axisRow(axis) {
    const row = el("div", "card-axis");
    const head = el("button", "card-axis-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(Boolean(card.open[axis.id])));
    const name = el("span", "card-axis-name");
    name.append(el("strong", "", axis.label), el("small", "", axis.hint));
    const bar = el("span", "card-bar");
    const fill = el("span", "");
    fill.style.width = `${axis.score ?? 0}%`;
    bar.append(fill);
    head.append(name, bar, el("span", "card-axis-score", axis.score === null ? "–" : `${axis.score}`), el("span", "card-axis-count", `${axis.finished}/${axis.total}`));
    head.addEventListener("click", () => {
      card.open[axis.id] = !card.open[axis.id];
      const bot = state.bot;
      if (bot) render(bot);
    });
    row.append(head);
    if (card.open[axis.id]) {
      const list = el("ul", "card-tasks");
      for (const task of axis.tasks) {
        const item = el("li", task.noAnswer ? "skip" : task.finished ? "ok" : "fail");
        item.append(el("span", "card-mark", task.noAnswer ? "–" : task.finished ? "✓" : "✗"), el("span", "card-task-title", task.title));
        item.append(el("small", "", `${task.why}${task.cost ? ` · ${money(task.cost)}` : ""}`));
        list.append(item);
      }
      row.append(list);
    }
    return row;
  }

  function render(bot) {
    const body = $("card-body");
    if (!body || !bot || card.botId !== bot.id) return;
    body.replaceChildren();
    const data = card.data;
    if (!data) {
      body.append(el("p", "hint", card.loading ? "Loading…" : "The card could not be loaded."));
      return;
    }
    const latest = data.latest;
    if (latest) {
      const top = el("div", "card-top");
      const overall = el("div", "card-overall");
      overall.style.setProperty("--card-color", accent(bot));
      overall.append(el("strong", "", latest.overall === null ? "–" : String(latest.overall)), el("span", "", "overall"));
      const meta = el("div", "card-meta");
      meta.append(
        el("strong", "", bot.name),
        el("span", "", `${latest.model || "model"} · ${latest.skills.length ? `${latest.skills.length} skills` : "no extra skills"}`),
        el("span", "", `${when(latest.startedAt)} · ${latest.tasks} tasks${latest.runs > 1 ? ` (${latest.runs} runs)` : ""} · ${money(latest.cost || 0)}`),
      );
      top.append(overall, meta);
      body.append(top);
      const previous = data.history[1]?.axes || null;
      const figure = el("div", "card-figure");
      figure.append(octagon(latest.axes, previous, accent(bot)));
      if (previous) figure.append(el("p", "hint card-legend", `Dashed: the card from ${when(data.history[1].startedAt)} (overall ${data.history[1].overall ?? "–"}).`));
      body.append(figure);
      if (latest.stoppedEarly || latest.unanswered) {
        const missed = latest.unanswered ? `${latest.unanswered} ${latest.unanswered === 1 ? "task" : "tasks"} got no answer from the model and ${latest.unanswered === 1 ? "is" : "are"} not counted.` : "";
        body.append(el("p", "plug-note", [latest.stoppedEarly, missed].filter(Boolean).join(" ") + " Areas without a number were not measured; run the card again when the model answers."));
      }
      if (!sameList(latest.skills, data.skills) || latest.model !== data.model) {
        body.append(el("p", "plug-note", "The skills or the model changed since this card, so these numbers are for the old setup. Run it again to see whether the change helped."));
      }
      const axes = el("div", "card-axes");
      for (const axis of latest.axes) axes.append(axisRow(axis));
      body.append(axes);
    } else {
      const empty = el("div", "card-empty");
      empty.append(el("p", "plug-desc-full", `No card yet. The card measures what ${bot.name} can actually do in eight areas: research, writing, documents, data, code, the web, memory and judgment. Each number is the share of real tasks it finished, so adding a skill only moves it once a run proves the skill helped.`));
      body.append(empty);
    }
    body.append(runBox(bot, data));
    if (data.history.length > 1) {
      const past = el("div", "plug-block");
      past.append(el("p", "plug-block-title", "Earlier cards"));
      for (const item of data.history.slice(1, 8)) {
        past.append(el("p", "card-history", `${when(item.startedAt)} · overall ${item.overall ?? "–"} · ${item.model} · ${item.skills.length} skills · ${money(item.cost || 0)}`));
      }
      body.append(past);
    }
  }

  async function load(bot) {
    if (!bot) return;
    if (card.botId !== bot.id) {
      card.botId = bot.id;
      card.data = null;
      card.open = {};
    }
    card.loading = true;
    try {
      card.data = await api(`/api/bots/${bot.id}/card`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      card.loading = false;
    }
    render(bot);
    // While its card runs, follow it; stop when the tab or the agent changes.
    clearInterval(card.poll);
    card.poll = null;
    if (card.data?.running?.mine) {
      card.poll = setInterval(() => {
        if (state.view !== "bot" || state.panel !== "card" || state.bot?.id !== bot.id) {
          clearInterval(card.poll);
          card.poll = null;
          return;
        }
        load(bot);
      }, 4000);
    }
  }

  window.RavnirCard = {
    renderPanel(bot) {
      render(bot);
      load(bot);
    },
  };
})();
