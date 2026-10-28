// The global Settings page: you, this device, notifications, new agents, connections, security, server and tools.
// Loaded after app.js, so state, els, el, api, toast, ask, readStored, writeStored and the open* helpers are global.

(() => {
  const SECTIONS = [
    ["you", "You"],
    ["appearance", "Appearance"],
    ["notifications", "Notifications"],
    ["agents", "New agents"],
    ["models", "Models"],
    ["connections", "Connections"],
    ["security", "Security"],
    ["server", "Server"],
    ["tools", "Tools"],
  ];
  const THEMES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
  const MOTIONS = [["full", "Full"], ["subtle", "Subtle"], ["off", "Off"]];
  const NOTIFY_OPTIONS = [["all", "All activity"], ["important", "Important only"], ["off", "Off"]];
  const LAYOUTS = [["auto", "Automatic"], ["en", "English folders"], ["es", "Spanish folders"]];

  const page = {
    built: false,
    full: null, // the last /api/state answer (vault, memory, jev, onepassword, box)
    config: null,
    mac: null,
    voice: null,
    onlySet: true,
    filter: "",
    refs: {},
  };

  // ---- This device: theme and avatar motion ------------------------------------

  function themeValue() {
    const saved = readStored("ravnir.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  }

  function motionValue() {
    const saved = readStored("ravnir.avatarMotion");
    return saved === "subtle" || saved === "off" ? saved : "full";
  }

  function darkNow(value = themeValue()) {
    return value === "dark" || (value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  // The browser bar on a phone follows the page.
  function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", darkNow() ? "#000000" : "#f5f5f7");
  }

  function applyTheme(value) {
    const next = value === "light" || value === "dark" ? value : "system";
    writeStored("ravnir.theme", next);
    document.documentElement.setAttribute("data-theme", next);
    syncThemeColor();
  }

  function applyMotion(value) {
    const next = value === "subtle" || value === "off" ? value : "full";
    writeStored("ravnir.avatarMotion", next);
    window.RavnirAvatar?.setMotion?.(next);
  }

  syncThemeColor();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", syncThemeColor);
  window.RavnirAvatar?.setMotion?.(motionValue());

  // ---- Small builders -----------------------------------------------------------

  function card(id, title, hint) {
    const node = el("section", "card-form set-card");
    node.id = `set-sec-${id}`;
    const head = el("div", "set-card-head");
    head.append(el("h2", "", title));
    if (hint) head.append(el("p", "hint", hint));
    node.append(head);
    return node;
  }

  function row(title, hint, control) {
    const node = el("div", "set-row");
    const copy = el("div", "set-row-copy");
    copy.append(el("strong", "", title));
    if (hint) copy.append(el("small", "", hint));
    node.append(copy);
    if (control) node.append(control);
    return node;
  }

  function segment(options, value, onPick, label) {
    const group = el("div", "seg");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const [key, text] of options) {
      const button = el("button", key === value ? "on" : "", text);
      button.type = "button";
      button.dataset.value = key;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(key === value));
      button.addEventListener("click", () => {
        for (const other of group.querySelectorAll("button")) {
          const on = other === button;
          other.classList.toggle("on", on);
          other.setAttribute("aria-checked", String(on));
        }
        onPick(key);
      });
      group.append(button);
    }
    return group;
  }

  function toggle(checked, onChange, label) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch";
    input.checked = checked;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => onChange(input.checked));
    return input;
  }

  function linkButton(text, onClick) {
    const button = el("button", "ghost small-btn", text);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function statusRow(title, hint, tone, label, action) {
    const control = el("div", "set-status");
    control.append(el("span", `pill ${tone}`, label));
    if (action) control.append(action);
    return row(title, hint, control);
  }

  function uptime(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)} min`;
  }

  // ---- Sections -----------------------------------------------------------------

  function appearanceCard() {
    const node = card("appearance", "Appearance", "These apply to this device only.");
    node.append(
      row("Theme", "System follows your device.", segment(THEMES, themeValue(), applyTheme, "Theme")),
      row("Agent animation", "How much the agents' faces move. Off is the calmest, and saves battery.", segment(MOTIONS, motionValue(), applyMotion, "Agent animation")),
    );
    page.refs.thinking = toggle(state.showThinking, (on) => setShowThinking(on), "Show tool details");
    page.refs.diffs = toggle(state.showDiffs, (on) => setShowDiffs(on), "Show diffs in the thread");
    page.refs.sound = toggle(state.sound, (on) => setSound(on), "Sound when an agent replies");
    node.append(
      row("Show tool details", "The steps an agent takes while it works, in the thread.", page.refs.thinking),
      row("Show diffs in the thread", "File changes appear under the reply that made them.", page.refs.diffs),
      row("Sound when an agent replies", "A soft pop. Only while this tab is open.", page.refs.sound),
    );
    return node;
  }

  // Keeps the three switches in step with the activity bar and the phone thread menu.
  window.syncSettingsPage = () => {
    if (!page.built) return;
    if (page.refs.thinking) page.refs.thinking.checked = state.showThinking;
    if (page.refs.diffs) page.refs.diffs.checked = state.showDiffs;
    if (page.refs.sound) page.refs.sound.checked = state.sound;
  };

  function notificationsCard() {
    const node = card("notifications", "Notifications", "Pings on your phone or computer when an agent needs you or has news. Approvals always come through.");
    const device = el("div", "");
    device.id = "settings-notify-device";
    node.append(device);

    const table = el("div", "set-agents");
    table.append(el("strong", "set-subhead", "What each agent may send"));
    if (!state.bots.length) table.append(el("p", "hint", "No agents yet."));
    for (const bot of state.bots) {
      const line = el("label", "set-agent");
      const face = el("span", "avatar");
      paintCreature(face, bot);
      const name = el("span", "set-agent-name", bot.name);
      if (bot.status === "off") name.append(el("small", "", "paused"));
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Notifications from ${bot.name}`);
      for (const [value, text] of [["all", "All"], ["important", "Important"], ["off", "Off"]]) select.append(new Option(text, value));
      select.value = bot.notify || "important";
      select.addEventListener("change", async () => {
        const previous = bot.notify || "important";
        select.disabled = true;
        try {
          await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { notify: select.value } });
          bot.notify = select.value;
          if (state.bot?.id === bot.id) state.bot.notify = select.value;
          toast(`${bot.name}: ${NOTIFY_OPTIONS.find(([value]) => value === select.value)[1].toLowerCase()}.`);
        } catch (error) {
          select.value = previous;
          toast(error.message, "error");
        } finally {
          select.disabled = false;
        }
      });
      line.append(face, name, select);
      table.append(line);
    }
    table.append(el("p", "hint", "Important covers replies you are not watching, messages, reminders, routines and failures."));
    node.append(table);
    return node;
  }

  // ---- You: the owner's name and language, and the vault layout ---------------------

  function ownerCard() {
    const owner = state.settingsOwner || {};
    const vault = state.settingsVault || {};
    const node = card("you", "You", "Agents use your name in their prompts and in the shared vault. Without one they say \"the user\".");
    const form = el("form", "set-form");
    const field = (label, control) => {
      const wrap = el("label", "", label);
      wrap.append(control);
      return wrap;
    };
    const name = document.createElement("input");
    name.value = owner.name || "";
    name.placeholder = "Your first name";
    name.maxLength = 60;
    name.autocomplete = "given-name";
    const language = document.createElement("select");
    language.append(new Option("Not set", ""), ...Object.entries(state.settingsLanguages || {}).map(([code, label]) => new Option(label, code)));
    language.value = owner.language || "";
    const layout = document.createElement("select");
    layout.append(...LAYOUTS.map(([value, text]) => new Option(text, value)));
    layout.value = vault.layout || "auto";
    const whereText = (info) => info.active
      ? `The vault uses ${info.active === "es" ? "Spanish" : "English"} folders now${info.profile ? `; facts about you go to ${info.profile}` : ""}. Automatic keeps the folders an existing vault has, and a new vault follows your language.`
      : "No shared vault on this server. The layout applies once one is set up.";
    const where = el("p", "hint", whereText(vault));
    const status = el("p", "hint set-note", "");
    const save = el("button", "primary", "Save");
    save.type = "submit";
    const actions = el("div", "row set-actions");
    actions.append(save);
    form.append(field("Name", name), field("Language you usually write in", language), field("Vault folders", layout), where, actions, status);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        const data = await api("/api/settings", {
          method: "PUT",
          body: { owner: { name: name.value.trim(), language: language.value }, vault: { layout: layout.value } },
        });
        state.settingsOwner = data.owner;
        state.settingsVault = data.vault;
        where.textContent = whereText(data.vault);
        status.textContent = "Saved. Agents use it from their next turn.";
        toast("Saved.");
      } catch (error) {
        status.textContent = error.message;
        toast(error.message, "error");
      } finally {
        save.disabled = false;
      }
    });
    node.append(form);
    return node;
  }

  function modelsCard() {
    const node = card("models", "Models", "Sign in to the providers you use. Agents then pick from their models.");
    window.RavnirModels?.renderPage(node);
    return node;
  }

  function defaultsCard() {
    const defaults = state.settingsDefaults || {};
    const node = card("agents", "New agents", "What a new agent starts with. You can change all of it when you create one.");
    const form = el("form", "set-form");
    const field = (label, control) => {
      const wrap = el("label", "", label);
      wrap.append(control);
      return wrap;
    };
    const input = (value, placeholder, name) => {
      const node = document.createElement("input");
      node.value = value || "";
      node.placeholder = placeholder;
      node.name = name;
      node.autocomplete = "off";
      node.spellcheck = false;
      return node;
    };

    const model = window.RavnirModels.picker({ value: { via: defaults.via, model: defaults.model }, placeholder: "Choose a model" });
    const modelField = el("div", "set-model-field");
    modelField.append(el("span", "set-model-label", "Model"), model);
    const group = input(defaults.group, "Personal", "group");
    const groups = document.createElement("datalist");
    groups.id = "set-group-list";
    for (const item of state.groups || []) groups.append(new Option(item.name));
    group.setAttribute("list", groups.id);
    const notify = document.createElement("select");
    notify.append(new Option("Important only (standard)", ""), ...NOTIFY_OPTIONS.map(([value, text]) => new Option(text, value)));
    notify.value = defaults.notify || "";

    const status = el("p", "hint set-note", "");
    const save = el("button", "primary", "Save");
    save.type = "submit";
    const actions = el("div", "row set-actions");
    actions.append(save);

    form.append(
      modelField,
      field("Group", group),
      groups,
      field("Notifications for new agents", notify),
      actions,
      status,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        const picked = model.value;
        const data = await api("/api/settings", {
          method: "PUT",
          body: { defaults: { via: picked.model ? picked.via : "", model: picked.model, group: group.value.trim(), notify: notify.value } },
        });
        state.settingsDefaults = data.defaults;
        status.textContent = "Saved. New agents start with these.";
        toast("Defaults saved.");
      } catch (error) {
        status.textContent = error.message;
        toast(error.message, "error");
      } finally {
        save.disabled = false;
      }
    });
    node.append(form);
    return node;
  }

  // "Find models" in the old discovery sheet used to fill the removed address fields; now it points at Models.
  window.applyDiscoveredDefault = () => {
    document.getElementById("set-sec-models")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  function connectionsCard() {
    const full = page.full || {};
    const node = card("connections", "Connections", "What this server is connected to. Change these where they are set up.");

    const op = full.onepassword;
    if (!page.full) node.append(row("1Password", "", el("span", "pill", "Checking…")));
    else if (!op?.installed) node.append(statusRow("1Password", "Saved logins that never reach the model.", "warn", "Not installed"));
    else if (op.signedIn) node.append(statusRow("1Password", "Agents can use a login you link to them. The password never reaches the model.", "ok", "Signed in", linkButton("Logins", openLogins)));
    else node.append(statusRow("1Password", "Paste a service account token in an agent's Logins tab.", "warn", "Not signed in", linkButton("Set up", openLogins)));

    const mac = page.mac;
    if (!mac) node.append(row("Your Mac", "", el("span", "pill", "Checking…")));
    else if (!mac.configured) node.append(statusRow("Your Mac", "Lets agents use your Mac while it is on. Not set up on this server.", "", "Off"));
    else if (mac.online) node.append(statusRow("Your Mac", mac.host ? `${mac.host} is connected.` : "The runner is connected.", "ok", "Online"));
    else node.append(statusRow("Your Mac", mac.lastSeen ? `Last seen ${timeAgo(mac.lastSeen)}.` : "The runner has not connected yet.", "warn", "Offline"));

    const vault = full.vault;
    if (vault) {
      if (!vault.available) node.append(statusRow("Notes vault", "Shared notes the agents read and write.", "", "Off"));
      else node.append(statusRow("Notes vault", `${vault.notes || 0} notes indexed${vault.lastError ? `. Last problem: ${vault.lastError}` : ""}.`, vault.lastError ? "warn" : "ok", vault.writer ? "Read and write" : "Read only"));
    }
    const memory = full.memory;
    if (memory) node.append(statusRow("Memory", memory.available ? `Shared memory in ${memory.workspace}/${memory.project}.` : "ai-memory is not installed on this server.", memory.available ? "ok" : "", memory.available ? "On" : "Off"));
    const jev = full.jev;
    if (jev) node.append(statusRow("Jev", "Fast decisions for the browser and computer tools.", jev.configured ? "ok" : "", jev.configured ? "On" : "Off"));
    const box = full.server?.box;
    if (box) node.append(statusRow("Own computers", box.enabled ? `Each agent can run in its own ${box.runtime || "container"}.` : "Every agent uses this server's computer.", box.enabled ? "ok" : "", box.enabled ? "On" : "Off"));

    voiceRows(node);
    node.append(row("Plugins", "Gmail, GitHub, Notion and more.", linkButton("Open Plugins", () => openPlugins())));
    return node;
  }

  // Voice mode: ElevenLabs when connected here (any Ravnir owner can paste their
  // own key), else a speech server from the env, else the browser.
  function voiceRows(node) {
    const voice = page.voice;
    const eleven = page.eleven;
    if (eleven?.connected) {
      node.append(statusRow("Voice", "ElevenLabs listens and speaks in voice mode.", "ok", "ElevenLabs", linkButton("Disconnect", async () => {
        if (!confirm("Disconnect ElevenLabs? Voice mode goes back to the browser or the speech server.")) return;
        try {
          page.eleven = await api("/api/voice/elevenlabs", { method: "DELETE" });
          page.voice = await api("/api/voice/config").catch(() => page.voice);
          window.RavnirVoice?.reload?.();
          toast("ElevenLabs disconnected.");
          build();
        } catch (error) {
          toast(error.message, "error");
        }
      })));
      if (eleven.voices?.length) {
        const select = document.createElement("select");
        select.setAttribute("aria-label", "ElevenLabs voice");
        for (const item of eleven.voices) select.append(new Option(item.accent ? `${item.name} (${item.accent})` : item.name, item.id));
        select.value = eleven.voice || "";
        select.addEventListener("change", async () => {
          try {
            page.eleven = await api("/api/voice/elevenlabs", { method: "PUT", body: { voice: select.value } });
            toast(`Voice: ${select.selectedOptions[0]?.textContent || "changed"}.`);
          } catch (error) {
            toast(error.message, "error");
          }
        });
        node.append(row("Voice for replies", "Every agent speaks with this voice, on every device.", select));
      }
      return;
    }
    if (voice) {
      const mode = voice.stt === "server" && voice.tts === "server" ? "Server" : voice.stt === "server" || voice.tts === "server" ? "Mixed" : "Browser";
      node.append(statusRow("Voice", mode === "Browser" ? "Your browser listens and speaks. No speech server is set." : `Listening: ${voice.stt === "server" ? "speech server" : "browser"}. Speaking: ${voice.tts === "server" ? "speech server" : "browser"}.`, mode === "Browser" ? "" : "ok", mode));
      if (voice.tts === "server" && voice.voices?.length) {
        const select = document.createElement("select");
        select.setAttribute("aria-label", "Voice");
        select.append(new Option(`Server default (${voice.voice || "default"})`, ""));
        for (const name of voice.voices) select.append(new Option(name, name));
        select.value = readStored("ravnir.voice") || "";
        select.addEventListener("change", () => {
          writeStored("ravnir.voice", select.value);
          toast(select.value ? `Voice: ${select.value}.` : "Voice: the server's default.");
        });
        node.append(row("Voice for replies", "The voice agents speak with, on this device.", select));
      }
    }
    const form = el("form", "set-status");
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = "ElevenLabs API key";
    input.setAttribute("aria-label", "ElevenLabs API key");
    const save = el("button", "ghost small-btn", "Connect");
    save.type = "submit";
    form.append(input, save);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      save.textContent = "Checking…";
      try {
        page.eleven = await api("/api/voice/elevenlabs", { method: "PUT", body: { apiKey: input.value } });
        page.voice = await api("/api/voice/config").catch(() => page.voice);
        window.RavnirVoice?.reload?.();
        toast("ElevenLabs connected. Voice mode now uses it.");
        build();
      } catch (error) {
        toast(error.message, "error");
        save.disabled = false;
        save.textContent = "Connect";
      }
    });
    node.append(row("ElevenLabs", "Natural voices and accurate listening in voice mode. Create a key at elevenlabs.io (Developers, API keys) with Text to Speech, Speech to Text and Voices (read). It is stored encrypted on this server.", form));
  }

  function openLogins() {
    const target = state.bots.find((bot) => bot.id === state.botId) || state.bots[0];
    if (!target) return toast("Create an agent first. Logins live in an agent's computer.", "error");
    selectBot(target.id).then(() => {
      openComputer();
      showPanel("logins");
    });
    return undefined;
  }

  // A one-time code that signs in a phone or another computer without the password.
  function addDeviceRow() {
    const control = el("div", "set-pair");
    const make = el("button", "ghost small-btn", "Show a code");
    make.type = "button";
    make.addEventListener("click", async () => {
      make.disabled = true;
      try {
        const made = await api("/api/pair", { method: "POST" });
        control.replaceChildren();
        const code = el("strong", "set-pair-code", made.code);
        control.append(code);
        // The https address this page was opened at reaches the server from a phone; the configured one may be internal.
        const link = location.protocol === "https:" ? `${location.origin}/login?pair=1` : made.url;
        if (link) {
          const qr = el("div", "set-pair-qr");
          qr.style.cssText = "width:132px;height:132px;background:#fff;border-radius:10px;padding:5px";
          control.append(qr);
          if (!window.qrcode) {
            await new Promise((resolve, reject) => {
              const script = document.createElement("script");
              script.src = "/vendor/qrcode.js";
              script.onload = resolve;
              script.onerror = () => reject(new Error("The QR code did not load."));
              document.head.append(script);
            });
          }
          const qrcode = window.qrcode(0, "M");
          qrcode.addData(link);
          qrcode.make();
          qr.innerHTML = qrcode.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); // library markup from an address
          qr.firstChild.style.cssText = "width:100%;height:100%;display:block";
        }
        control.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:8px";
        code.style.cssText = "font-family:var(--mono);font-size:18px;letter-spacing:0.05em";
        const again = el("button", "ghost small-btn", "New code");
        again.type = "button";
        again.addEventListener("click", () => { control.replaceChildren(make); control.removeAttribute("style"); make.disabled = false; make.click(); });
        control.append(again);
      } catch (error) {
        toast(error.message, "error");
        make.disabled = false;
      }
    });
    control.append(make);
    return row("Add a device", "A one-time code signs in a phone or another computer without the password. It works once, within 15 minutes.", control);
  }

  function securityCard() {
    const auth = Boolean(state.server?.auth);
    const node = card("security", "Security", auth ? "" : "Sign-in is off on this server. Anyone who can reach this address can use it.");
    if (!auth) return node;
    node.append(row("Signed in as", "This device stays signed in for 90 days.", el("strong", "set-user", state.server?.user || "you")));
    const out = el("button", "ghost", "Sign out");
    out.type = "button";
    out.addEventListener("click", () => signOut());
    node.append(row("Sign out of this device", "", out));
    const everywhere = el("button", "danger", "Sign out everywhere");
    everywhere.type = "button";
    everywhere.addEventListener("click", async () => {
      const yes = await ask({
        kicker: "Security",
        title: "Sign out everywhere?",
        message: "Every phone and computer signed in to Ravnir is signed out, including this one. You sign in again with your password. Scripts that use the password directly keep working.",
        confirm: "Sign out everywhere",
        danger: true,
      });
      if (!yes) return;
      try {
        await api("/api/sessions/revoke", { method: "POST" });
        location.href = "/login";
      } catch (error) {
        toast(error.message, "error");
      }
    });
    node.append(row("Sign out on every device", "Use this if a phone is lost.", everywhere));
    node.append(addDeviceRow());
    node.append(row("Backup", "Export your agents, notes and settings to one file.", linkButton("Open", () => openMemory("backup"))));
    return node;
  }

  function serverCard() {
    const node = card("server", "Server", "Read only. These are set in the server's environment, not here.");
    const server = state.server || {};
    const config = page.config;
    const facts = el("dl", "set-facts");
    const fact = (name, value) => facts.append(el("dt", "", name), el("dd", "", value || "unknown"));
    fact("Version", config?.version || server.version);
    fact("Address", (config?.url || server.url || "").replace(/^https?:\/\//, ""));
    fact("Uptime", uptime(config?.uptime ?? server.uptime));
    fact("Time zone", (config?.timeZone || server.timezone || "").replace(/_/g, " "));
    fact("Platform", server.platform);
    node.append(facts);

    const head = el("div", "set-env-head");
    head.append(el("strong", "set-subhead", "Configuration"));
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filter";
    search.className = "set-env-filter";
    search.setAttribute("aria-label", "Filter configuration");
    search.value = page.filter;
    const only = el("label", "set-env-only", "Only the ones in use ");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = page.onlySet;
    only.prepend(box);
    head.append(search, only);
    node.append(head);

    const list = el("div", "set-env");
    const draw = () => {
      list.replaceChildren();
      if (!config) {
        list.append(el("p", "hint", "Loading…"));
        return;
      }
      const needle = page.filter.trim().toLowerCase();
      const items = config.env.filter((item) => (!page.onlySet || item.set) && (!needle || item.name.toLowerCase().includes(needle)));
      if (!items.length) list.append(el("p", "hint", page.onlySet && !needle ? "Nothing is set. Every setting uses its default." : "Nothing matches."));
      for (const item of items) {
        const name = el("span", "set-env-name", item.name);
        const value = item.set
          ? item.value !== undefined && item.value !== ""
            ? el("span", "set-env-value", item.value)
            : el("span", "set-env-value hidden", item.value === "" ? "set, address hidden" : "set, value hidden")
          : el("span", "set-env-value unset", "not set");
        list.append(name, value);
      }
    };
    search.addEventListener("input", () => { page.filter = search.value; draw(); });
    box.addEventListener("change", () => { page.onlySet = box.checked; draw(); });
    draw();
    node.append(list);
    return node;
  }

  function toolsCard() {
    const node = card("tools", "Tools", "");
    const tool = (title, hint, label, onClick) => node.append(row(title, hint, linkButton(label, onClick)));
    tool("Backup and restore", "Save everything to one file, or bring a backup back into a fresh install.", "Open", () => openMemory("backup"));
    tool("First-run setup", "Set up your name, a model, starter agents and the phone again.", "Open", () => window.RavnirWelcome?.open());
    tool("Setup guide", "How to install and run Ravnir.", "Open", () => window.open("/setup", "_blank", "noopener"));
    tool("Import from Grok Bot", "Bring an agent over with its memory and routines.", "Import", () => openImport());
    tool("New group", "A sidebar group to keep agents together.", "Create", () => createNewGroup());
    tool("Find models", "Look for model servers on this network and use one for new agents.", "Find", () => openDiscover("defaults"));
    return node;
  }

  // ---- Page ---------------------------------------------------------------------

  function build() {
    const body = els["settings-body"];
    const scroll = body.scrollTop;
    body.replaceChildren();
    page.refs = {};

    const nav = el("nav", "set-nav");
    nav.setAttribute("aria-label", "Settings sections");
    for (const [id, label] of SECTIONS) {
      const chip = el("button", "set-chip", label);
      chip.type = "button";
      chip.addEventListener("click", () => document.getElementById(`set-sec-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
      nav.append(chip);
    }
    body.append(
      nav,
      ownerCard(),
      appearanceCard(),
      notificationsCard(),
      defaultsCard(),
      modelsCard(),
      connectionsCard(),
      securityCard(),
      serverCard(),
      toolsCard(),
    );
    page.built = true;
    body.scrollTop = scroll;
    window.refreshNotificationCard?.();
  }

  async function load() {
    const [full, config, mac, voice, eleven] = await Promise.all([
      api("/api/state").catch(() => null),
      api("/api/config").catch(() => null),
      api("/api/mac").catch(() => null),
      api("/api/voice/config").catch(() => null),
      api("/api/voice/elevenlabs").catch(() => null),
      loadDefaults(),
    ]);
    if (full) {
      page.full = full;
      state.server = full.server;
    }
    page.config = config;
    page.mac = mac || { configured: false };
    page.voice = voice;
    page.eleven = eleven;
    if (state.view === "settings") build();
  }

  window.openSettingsView = async (section = "") => {
    build();
    if (section) requestAnimationFrame(() => document.getElementById(`set-sec-${section}`)?.scrollIntoView({ block: "start" }));
    await load();
    if (section) requestAnimationFrame(() => document.getElementById(`set-sec-${section}`)?.scrollIntoView({ block: "start" }));
  };
})();
