// The look studio: a compact card inside the agent dialogs and a full studio sheet on top.
// Uses window.RavnirAvatar (public/avatar.js). No dependencies on app.js.
(() => {
  const TABS = [["body", "Body"], ["face", "Face"], ["color", "Color"], ["extras", "Extras"], ["personality", "Personality"]];
  const MOODS = [["", "Idle"], ["working", "Working"], ["waiting", "Needs you"], ["happy", "Done"], ["sleeping", "Paused"], ["speaking", "Speaking"]];
  const SLIDERS = [["eyeSize", "Eye size"], ["eyeGap", "Eye spacing"], ["faceY", "Face height"]];
  const DICE = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3.5"/><circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="13" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none"/></svg>';
  const WAND = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 16 13 7M11.5 5.5l3 3M15 2.5v2M17.5 5h-2M16.5 9.5v1.6M8 3.4h1.6"/></svg>';
  const A = () => window.RavnirAvatar;
  const label = (list, value) => (list.find(([key]) => key === value) || [value, value])[1];

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function summary(look) {
    const avatars = A();
    const parts = [`${label(avatars.PERSONALITIES, look.personality)} ${label(avatars.SHAPES, look.shape).toLowerCase()}`];
    if (look.shape === "raven") {
      parts.push(`${label(avatars.RAVEN_PLUMAGE, look.extra).toLowerCase()} plumage`);
      return parts.join(", ");
    }
    parts.push(look.face === "none" ? "no face" : `${label(avatars.FACES, look.face).toLowerCase()} face`);
    if (look.extra !== "none") parts.push(label(avatars.EXTRAS, look.extra).toLowerCase());
    return parts.join(", ");
  }

  // ---- The card inside New agent and Agent settings --------------------------------------

  // options: { look(), name(), job(), seed, set(look) }
  function card(host, options) {
    host.classList.add("tbs-card");
    host.replaceChildren();
    const stage = el("button", "tbs-card-stage");
    stage.type = "button";
    stage.title = "Open the studio";
    stage.setAttribute("aria-label", "Open the look studio");
    const hero = el("span", "avatar tbs-card-avatar");
    stage.append(hero);
    const copy = el("div", "tbs-card-copy");
    const title = el("strong", "tbs-card-title", "Look");
    const sub = el("span", "tbs-card-sub");
    const actions = el("div", "tbs-card-actions");
    const customize = el("button", "ghost small-btn tbs-open", "Customize");
    customize.type = "button";
    const match = el("button", "ghost small-btn tbs-icon-btn");
    match.type = "button";
    match.innerHTML = `${WAND}<span>Match the job</span>`;
    const dice = el("button", "ghost small-btn tbs-icon-btn");
    dice.type = "button";
    dice.title = "Surprise me";
    dice.setAttribute("aria-label", "Surprise me");
    dice.innerHTML = DICE;
    actions.append(customize, match);
    const top = el("div", "tbs-card-top");
    top.append(title, dice);
    copy.append(top, sub, actions);
    const presets = el("div", "tbs-card-presets");
    presets.setAttribute("role", "group");
    presets.setAttribute("aria-label", "Start from");
    host.append(stage, copy, presets);

    const apply = (look) => {
      options.set(look);
      refresh();
    };
    const launch = () => open({
      look: options.look(),
      name: options.name(),
      job: options.job(),
      seed: options.seed,
      onDone: apply,
    });
    stage.addEventListener("click", launch);
    customize.addEventListener("click", launch);
    dice.addEventListener("click", () => apply(A().random()));
    match.addEventListener("click", () => apply(A().suggest({ name: options.name(), job: options.job(), seed: options.seed })));

    let presetsDrawn = false;
    function refresh() {
      const look = options.look();
      A().render(hero, look, { name: options.name(), seed: options.seed, state: "" });
      sub.textContent = summary(look);
      if (presetsDrawn) return;
      presetsDrawn = true;
      presets.replaceChildren(...A().PRESETS.map(([name, preset]) => {
        const button = el("button", "tbs-chip");
        button.type = "button";
        button.title = name;
        button.setAttribute("aria-label", `Start from ${name}`);
        const mini = el("span", "avatar tbs-chip-avatar");
        A().render(mini, preset, { name, seed: name, mark: false });
        button.append(mini);
        button.addEventListener("click", () => apply(A().preset(name)));
        return button;
      }));
    }
    refresh();
    return { refresh };
  }

  // ---- The full studio --------------------------------------------------------------------

  let ui = null;
  let session = null;

  function build() {
    const dialog = el("dialog", "dialog tbs-dialog");
    dialog.innerHTML = `
      <form method="dialog" class="dialog-card tbs">
        <header class="dialog-head tbs-head">
          <div><p class="kicker">Studio</p><h2 class="tbs-title">Look</h2></div>
          <div class="tbs-head-actions">
            <button type="button" class="ghost tbs-cancel">Cancel</button>
            <button type="button" class="primary tbs-done">Done</button>
          </div>
        </header>
        <div class="tbs-body">
          <section class="tbs-stage" aria-label="Preview">
            <div class="tbs-spot"><span class="avatar tbs-hero"></span></div>
            <p class="tbs-caption"><strong class="tbs-name"></strong><span class="tbs-summary"></span></p>
            <div class="tbs-moods" role="radiogroup" aria-label="Preview a mood"></div>
            <p class="tbs-hint">It follows your pointer and reacts when you tap it. Try a mood: that is how it tells you what it is doing.</p>
          </section>
          <section class="tbs-controls">
            <div class="tbs-presets" role="group" aria-label="Start from"></div>
            <div class="tbs-tabs" role="tablist" aria-label="Parts"></div>
            <div class="tbs-panel" role="tabpanel"></div>
            <footer class="tbs-tools">
              <button type="button" class="ghost small-btn tbs-undo">Undo</button>
              <button type="button" class="ghost small-btn tbs-reset">Reset</button>
              <span class="tbs-grow"></span>
              <button type="button" class="ghost small-btn tbs-icon-btn tbs-match">${WAND}<span>Match the job</span></button>
              <button type="button" class="ghost small-btn tbs-icon-btn tbs-dice">${DICE}<span>Surprise me</span></button>
            </footer>
          </section>
        </div>
      </form>`;
    document.body.append(dialog);
    const $ = (selector) => dialog.querySelector(selector);
    const parts = {
      dialog,
      hero: $(".tbs-hero"),
      name: $(".tbs-name"),
      summary: $(".tbs-summary"),
      moods: $(".tbs-moods"),
      presets: $(".tbs-presets"),
      tabs: $(".tbs-tabs"),
      panel: $(".tbs-panel"),
      undo: $(".tbs-undo"),
    };
    parts.moods.append(...MOODS.map(([mood, text]) => {
      const button = el("button", "tbs-mood", text);
      button.type = "button";
      button.dataset.mood = mood;
      button.setAttribute("role", "radio");
      button.addEventListener("click", () => {
        session.mood = mood;
        paint();
      });
      return button;
    }));
    parts.tabs.append(...TABS.map(([tab, text]) => {
      const button = el("button", "tbs-tab", text);
      button.type = "button";
      button.dataset.tab = tab;
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => {
        session.tab = tab;
        paint({ panel: true });
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        const index = TABS.findIndex(([key]) => key === session.tab);
        const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
        session.tab = next;
        paint({ panel: true });
        parts.tabs.querySelector(`[data-tab="${next}"]`)?.focus();
      });
      return button;
    }));
    $(".tbs-cancel").addEventListener("click", () => close(false));
    $(".tbs-done").addEventListener("click", () => close(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(false);
    });
    parts.undo.addEventListener("click", () => {
      const last = session.history.pop();
      if (last) setLook(last, { record: false });
    });
    $(".tbs-reset").addEventListener("click", () => change(session.initial));
    $(".tbs-match").addEventListener("click", () => change(A().suggest({ name: session.name, job: session.job, seed: session.seed })));
    $(".tbs-dice").addEventListener("click", () => change(A().random()));
    return parts;
  }

  function open({ look, name = "", job = "", seed = "", onDone } = {}) {
    if (!window.RavnirAvatar) return;
    ui ||= build();
    const start = A().normalize(look, { seed });
    session = { look: start, initial: start, history: [], name: name || "Agent", job, seed, tab: session?.tab || "body", mood: "", onDone };
    ui.name.textContent = session.name;
    ui.presets.replaceChildren(...A().PRESETS.map(([presetName, preset]) => {
      const button = el("button", "tbs-preset");
      button.type = "button";
      const mini = el("span", "avatar tbs-preset-avatar");
      A().render(mini, preset, { name: presetName, seed: presetName });
      mini.setAttribute("aria-hidden", "true");
      button.append(mini, el("span", "tbs-preset-name", presetName));
      button.addEventListener("click", () => change(A().preset(presetName)));
      return button;
    }));
    paint({ panel: true });
    if (!ui.dialog.open) ui.dialog.showModal();
  }

  function close(save) {
    if (!session) return;
    const { onDone, look } = session;
    ui.dialog.close();
    if (save && typeof onDone === "function") onDone(look);
  }

  function setLook(look, { record = true } = {}) {
    const next = A().normalize(look, { seed: session.seed });
    if (JSON.stringify(next) === JSON.stringify(session.look)) return;
    if (record) {
      session.history.push(session.look);
      if (session.history.length > 40) session.history.shift();
    }
    session.look = next;
    paint({ panel: true });
  }

  const change = (look) => setLook(look);
  const patch = (fields) => setLook({ ...session.look, ...fields });

  // The Speaking preview has no voice, so a made-up loudness moves the mouth or beak.
  let talking = 0;
  function preview() {
    clearInterval(talking);
    A().speak(ui.hero, 0);
    if (session?.mood !== "speaking") return;
    let step = 0;
    talking = setInterval(() => {
      if (!ui.dialog.open || session.mood !== "speaking") {
        clearInterval(talking);
        A().speak(ui.hero, 0);
        return;
      }
      step += 1;
      A().speak(ui.hero, step % 7 > 4 ? 0.05 : 0.35 + Math.random() * 0.6);
    }, 110);
  }

  function paint({ panel = false } = {}) {
    const look = session.look;
    A().render(ui.hero, look, { name: session.name, seed: session.seed, state: session.mood });
    preview();
    ui.summary.textContent = summary(look);
    ui.undo.disabled = !session.history.length;
    for (const button of ui.moods.children) button.setAttribute("aria-checked", String(button.dataset.mood === session.mood));
    for (const button of ui.tabs.children) {
      if (button.dataset.tab === "extras") button.textContent = look.shape === "raven" ? "Plumage" : "Extras";
      const on = button.dataset.tab === session.tab;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    if (panel) drawPanel();
    ui.dialog.querySelector(".tbs-hint").textContent = look.shape === "raven"
      ? "Hover to fan its wings. Tap to say hello. While working, it takes flight."
      : "It follows your pointer and reacts when you tap it. Try a mood: that is how it tells you what it is doing.";
  }

  function section(title, hint = "") {
    const box = el("div", "tbs-section");
    const head = el("p", "tbs-label", title);
    box.append(head);
    if (hint) box.append(el("p", "tbs-note", hint));
    return box;
  }

  function tiles(group, list, preview, { wide = false, extras = true } = {}) {
    const grid = el("div", `tbs-tiles${wide ? " wide" : ""}`);
    const look = session.look;
    grid.append(...list.map(([value, text, description]) => {
      const on = look[group] === value;
      const button = el("button", `tbs-tile${on ? " on" : ""}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(on));
      button.title = text;
      const mini = el("span", "avatar tbs-tile-avatar");
      A().render(mini, preview(value), { name: session.name, seed: `${session.seed}:${group}:${value}`, extras });
      mini.setAttribute("aria-hidden", "true");
      button.append(mini);
      if (wide) {
        const copy = el("span", "tbs-tile-copy");
        copy.append(el("strong", "", text), el("span", "", description || ""));
        button.append(copy);
      } else {
        button.append(el("span", "tbs-tile-name", text));
      }
      button.addEventListener("click", () => change(preview(value)));
      return button;
    }));
    return grid;
  }

  function swatches(field, colors, { auto = false } = {}) {
    const row = el("div", "tbs-swatches");
    const current = session.look[field];
    const add = (color, text) => {
      const button = el("button", `tbs-swatch${current === color ? " on" : ""}${color ? "" : " auto"}`);
      button.type = "button";
      button.title = text;
      button.setAttribute("aria-label", text);
      button.setAttribute("aria-pressed", String(current === color));
      if (color) button.style.setProperty("--swatch", color);
      else button.textContent = "A";
      button.addEventListener("click", () => patch({ [field]: color }));
      row.append(button);
    };
    if (auto) add("", "Automatic");
    for (const color of colors) add(color, color);
    const custom = el("label", `tbs-swatch custom${current && !colors.includes(current) ? " on" : ""}`);
    custom.title = "Any color";
    const input = el("input");
    input.type = "color";
    input.value = current || (field === "color" ? "#a8c9e8" : "#8be9ff");
    input.setAttribute("aria-label", "Pick any color");
    let before = null;
    input.addEventListener("input", () => {
      before ||= session.look;
      session.look = A().normalize({ ...session.look, [field]: input.value }, { seed: session.seed });
      paint();
    });
    input.addEventListener("change", () => {
      if (before) session.history.push(before);
      before = null;
      paint({ panel: true });
    });
    custom.append(input);
    if (current && !colors.includes(current)) custom.style.setProperty("--swatch", current);
    row.append(custom);
    return row;
  }

  function drawPanel() {
    const avatars = A();
    const look = session.look;
    const panel = ui.panel;
    const nodes = [];
    const raven = look.shape === "raven";
    const faceOn = look.face === "none" ? (raven ? "surface" : "visor") : look.face;
    if (session.tab === "body") {
      const shape = section("Shape", "Distinct silhouettes, individual colors and the same living personalities.");
      // A raven wears its face painted on; a visor plate on a beak looks wrong.
      shape.append(tiles("shape", avatars.SHAPES, (value) => ({ ...look, shape: value, ...(value === "raven" && look.shape !== "raven" && look.face === "visor" ? { face: "surface" } : {}) })));
      const material = section(raven ? "Feather finish" : "Material", raven ? "" : "Directional light, subtle reflections and a clear body color.");
      material.append(tiles("material", raven ? avatars.RAVEN_MATERIALS : avatars.MATERIALS, (value) => ({ ...look, material: value })));
      nodes.push(shape, material);
    } else if (session.tab === "face") {
      const face = section("Face", raven ? "A natural eye, a personal insignia, or both." : "A small inlaid face, a lit visor, or a personal mark. Keep the expression your own.");
      face.append(tiles("face", raven ? [["surface", "Natural"], ["visor", "Marked"], ["none", "Mark only"]] : avatars.FACES, (value) => ({ ...look, face: value }), { extras: false }));
      const eyes = section("Eyes");
      eyes.append(tiles("eyes", raven ? avatars.RAVEN_EYES : avatars.EYES, (value) => ({ ...look, face: faceOn, eyes: value }), { extras: false }));
      const insignia = raven ? section("Insignia", "Choose an emblem to wear with the natural eye, or on its own.") : null;
      if (insignia) insignia.append(tiles("mark", avatars.MARKS, (value) => ({ ...look, face: look.face === "none" ? "none" : "visor", mark: value })));
      const mouth = section("Mouth");
      mouth.append(tiles("mouth", avatars.MOUTHS, (value) => ({ ...look, face: faceOn, mouth: value }), { extras: false }));
      const tune = section("Fine tune");
      for (const [field, text] of raven ? [["eyeSize", "Eye size"], ["faceY", "Eye height"]] : SLIDERS) {
        const row = el("label", "tbs-slider");
        const input = el("input");
        input.type = "range";
        input.min = "-1";
        input.max = "1";
        input.step = "0.05";
        input.value = String(look[field]);
        let before = null;
        input.addEventListener("input", () => {
          before ||= session.look;
          session.look = avatars.normalize({ ...session.look, [field]: Number(input.value) }, { seed: session.seed });
          paint();
        });
        input.addEventListener("change", () => {
          if (before) {
            session.history.push(before);
            before = null;
          }
          paint({ panel: true });
        });
        input.addEventListener("dblclick", () => patch({ [field]: 0 }));
        row.append(el("span", "", text), input);
        tune.append(row);
      }
      const blush = el("label", "tbs-toggle");
      const box = el("input");
      box.type = "checkbox";
      box.checked = look.cheeks;
      box.addEventListener("change", () => patch({ cheeks: box.checked }));
      blush.append(el("span", "", "Blush"), box);
      if (!raven) tune.append(blush);
      tune.append(el("p", "tbs-note", "Double-click a slider to reset it."));
      nodes.push(...(raven ? [face, eyes, insignia, tune] : [face, eyes, mouth, tune]));
    } else if (session.tab === "color") {
      const body = section(raven ? "Feather sheen" : "Body", raven ? "A restrained tint over charcoal feathers." : "");
      body.append(swatches("color", raven ? avatars.RAVEN_COLORS : avatars.COLORS));
      const glow = section(raven ? "Iris" : "Eye light", raven ? "Automatic uses warm amber. The eye stays small and unlit." : "Shows on visor faces, screens and very dark bodies. Automatic picks a light from the body color.");
      glow.append(swatches("glow", avatars.GLOWS, { auto: true }));
      nodes.push(body, glow);
    } else if (session.tab === "extras") {
      const extra = section(raven ? "Plumage" : "Accessory", raven ? "Distinctive crests, brows and feather layers give each raven its identity." : "Small props say what an agent does at a glance: a headset for comms, glasses for numbers, a moon for research.");
      extra.append(tiles("extra", raven ? avatars.RAVEN_PLUMAGE : avatars.EXTRAS, (value) => ({ ...look, extra: value })));
      nodes.push(extra);
    } else {
      const soul = section("Personality", "Changes how it breathes, blinks and looks around. It does not change what the agent does.");
      const descriptions = { calm: "Slow wingbeats, a steady gaze and a measured greeting.", cheerful: "Quick wingbeats and a spirited flutter when tapped.", curious: "Fans its wings and leans toward you when you hover.", focused: "Long glides and a small, deliberate acknowledgment.", shy: "A reserved wing spread and a gaze that turns away." };
      const personalities = raven ? avatars.PERSONALITIES.map(([key, name]) => [key, name, descriptions[key]]) : avatars.PERSONALITIES;
      soul.append(tiles("personality", personalities, (value) => ({ ...look, personality: value }), { wide: true }));
      nodes.push(soul);
    }
    panel.replaceChildren(...nodes);
  }

  const CSS = `
.tbs-card { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; align-items: center; padding: 12px; border: 1px solid var(--line-soft); border-radius: var(--r-md, 14px); background: var(--surface-2); }
.tbs-card-stage { width: 92px; height: 92px; border: 0; border-radius: 18px; padding: 10px; background: radial-gradient(120% 100% at 50% 10%, var(--surface) 40%, var(--fill)); box-shadow: inset 0 0 0 .5px var(--line); cursor: pointer; }
.tbs-card-stage:hover { box-shadow: inset 0 0 0 1px var(--accent); }
.tbs-card-avatar { width: 72px; height: 72px; display: block; }
.tbs-card-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.tbs-card-title { font-size: 13px; }
.tbs-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tbs-card-top .small-btn { padding: 4px 6px; }
.tbs-card-sub { color: var(--muted); font-size: 12px; }
.tbs-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.tbs-card-actions .small-btn { padding: 5px 9px; font-size: 12px; }
.tbs-icon-btn { display: inline-flex; align-items: center; gap: 5px; }
.tbs-card-presets { grid-column: 1 / -1; display: flex; gap: 4px; overflow-x: auto; padding: 4px 2px 2px; scrollbar-width: none; }
.tbs-chip { flex: none; width: 40px; height: 40px; border: 0; border-radius: 12px; padding: 4px; background: transparent; }
.tbs-chip:hover, .tbs-chip:focus-visible { background: var(--fill); }
.tbs-chip-avatar { width: 32px; height: 32px; display: block; }
.tbs-dialog { width: min(980px, calc(100vw - 28px)); }
.tbs-head { align-items: center; }
.tbs-head-actions { display: flex; gap: 8px; }
.tbs-body { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; min-height: 0; overflow: hidden; flex: 1; }
.tbs-stage { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 22px 20px; background: radial-gradient(90% 70% at 50% 30%, var(--surface) 30%, var(--fill)); border-right: 1px solid var(--line-soft); }
.tbs-spot { position: relative; width: 100%; display: grid; place-items: center; padding: 18px 0 26px; }
.tbs-spot::after { content: ""; position: absolute; bottom: 10px; width: 62%; height: 18px; border-radius: 50%; background: radial-gradient(closest-side, rgba(0, 0, 0, .08), transparent); }
.tbs-hero { width: min(220px, 60vw); height: min(220px, 60vw); display: block; }
.tbs-caption { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; }
.tbs-name { font-size: 17px; letter-spacing: -.01em; }
.tbs-summary { color: var(--muted); font-size: 12.5px; }
.tbs-moods { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; padding: 3px; border-radius: 99px; background: var(--fill); }
.tbs-mood { border: 0; background: transparent; border-radius: 99px; padding: 5px 10px; font-size: 12px; color: var(--muted); }
.tbs-mood[aria-checked="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, .1); }
.tbs-hint { margin: 0; color: var(--faint); font-size: 11.5px; text-align: center; max-width: 280px; line-height: 1.45; }
.tbs-controls { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.tbs-presets { display: flex; gap: 6px; overflow-x: auto; padding: 14px 18px 6px; scrollbar-width: thin; }
.tbs-preset { flex: none; display: flex; flex-direction: column; align-items: center; gap: 3px; width: 64px; border: 0; background: transparent; border-radius: 12px; padding: 6px 2px; font-size: 11px; color: var(--muted); }
.tbs-preset:hover, .tbs-preset:focus-visible { background: var(--fill); color: var(--text); }
.tbs-preset-avatar { width: 42px; height: 42px; display: block; }
.tbs-tabs { display: flex; gap: 2px; margin: 6px 18px 0; padding: 3px; border-radius: 10px; background: var(--fill); overflow-x: auto; scrollbar-width: none; }
.tbs-tab { flex: 1 0 auto; border: 0; background: transparent; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.tbs-tab[aria-selected="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .1); }
.tbs-panel { flex: 1; overflow-y: auto; padding: 4px 18px 16px; min-height: 280px; max-height: min(56vh, 520px); }
.tbs-section { padding-top: 12px; }
.tbs-label { margin: 0 0 2px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.tbs-note { margin: 0 0 8px; font-size: 12px; color: var(--muted); line-height: 1.4; }
.tbs-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 6px; margin-top: 6px; }
.tbs-tiles.wide { grid-template-columns: 1fr; }
.tbs-tile { display: flex; flex-direction: column; align-items: center; gap: 4px; border: 1px solid transparent; background: var(--surface-2); border-radius: 14px; padding: 9px 4px 7px; color: var(--muted); font-size: 11.5px; transition: border-color .15s, background .15s; }
.tbs-tile:hover { background: var(--fill); color: var(--text); }
.tbs-tile.on { border-color: var(--accent); background: var(--surface); color: var(--text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
.tbs-tile-avatar { width: 50px; height: 50px; display: block; }
.tbs-tiles.wide .tbs-tile { flex-direction: row; justify-content: flex-start; gap: 14px; padding: 10px 14px; text-align: left; }
.tbs-tiles.wide .tbs-tile-avatar { width: 46px; height: 46px; flex: none; }
.tbs-tile-copy { display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; }
.tbs-tile-copy strong { color: var(--text); font-size: 13px; }
.tbs-swatches { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; max-width: 330px; }
.tbs-swatch { position: relative; width: 30px; height: 30px; border-radius: 50%; border: 0; padding: 0; background: var(--swatch, var(--fill)); box-shadow: inset 0 0 0 .5px rgba(0, 0, 0, .14); display: grid; place-items: center; font-size: 11px; font-weight: 700; color: var(--muted); cursor: pointer; }
.tbs-swatch.on { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
.tbs-swatch.custom:not(.on) { background: conic-gradient(#ff6b6b, #ffd93d, #6bcb77, #4d96ff, #b06bff, #ff6b6b); }
.tbs-swatch.custom input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; border: 0; padding: 0; }
.tbs-slider { display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: 10px; margin: 8px 0; font-size: 12.5px; color: var(--muted); }
.tbs-slider input { width: 100%; accent-color: var(--accent); }
.tbs-toggle { display: flex; justify-content: space-between; align-items: center; margin: 10px 0 6px; font-size: 12.5px; color: var(--muted); max-width: 320px; }
.tbs-tools { display: flex; align-items: center; gap: 6px; padding: 10px 18px; border-top: 1px solid var(--line-soft); background: var(--surface-2); flex-wrap: wrap; }
.tbs-grow { flex: 1; }
@media (max-width: 760px) {
  .tbs-dialog { width: 100vw; }
  .tbs-body { grid-template-columns: 1fr; grid-auto-rows: max-content; align-content: start; overflow-y: auto; scroll-padding: 280px 0 64px; }
  .tbs-stage { position: sticky; top: 0; z-index: 2; border-right: 0; border-bottom: 1px solid var(--line-soft); padding: 8px 16px 10px; gap: 6px; background: radial-gradient(90% 80% at 50% 30%, var(--surface) 35%, var(--fill)); }
  .tbs-spot { padding: 4px 0 12px; }
  .tbs-hero { width: 124px; height: 124px; }
  .tbs-summary { display: none; }
  .tbs-reset { display: none; }
  .tbs-hint { display: none; }
  .tbs-panel { flex: none; max-height: none; min-height: 0; overflow: visible; }
  .tbs-tiles { grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); }
  .tbs-tools { position: sticky; bottom: 0; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
}`;

  if (!document.getElementById("tbs-style")) {
    const style = document.createElement("style");
    style.id = "tbs-style";
    style.textContent = CSS;
    document.head.append(style);
  }

  window.RavnirStudio = { card, open };
})();
