// First-run wizard: name and language, a model, starter agents, the notes repository, the phone.
// window.RavnirWelcome = { open, close }. Uses api, el, refreshState, selectBot, openImport,
// openSettingsPage and state from app.js, and window.RavnirModels from models.js.
// The server side is server/setup.js.

(() => {
  const FIRST_MESSAGE = "What can you do for me here? Keep it short.";
  // The middle sentence comes from the server: what this free model's provider does with prompts.
  const freeNote = (free) => `Free models from OpenCode. ${free.note || ""} They can be slow or rate limited, and you can connect your own provider any time.`.replace(/\s+/g, " ");
  const OWN_PROVIDERS = [
    ["openai", "ChatGPT Plus or Pro"],
    ["github-copilot", "GitHub Copilot"],
    ["anthropic", "Anthropic"],
    ["google", "Google"],
    ["openrouter", "OpenRouter"],
    ["deepseek", "DeepSeek"],
    ["xai", "xAI"],
  ];
  const TITLES = {
    you: ["Welcome to Ravnir", "Agents that remember, on your own server. Two quick questions first."],
    model: ["Connect a model", "Agents need a model to think with. You can change it later, per agent."],
    agents: ["Pick your first agents", "Start with a few. You can add, change or remove agents any time."],
    notes: ["Your notes", "Agents share memory in a git vault you can open in Obsidian. It already works on this server."],
    phone: ["Put Ravnir on your phone", "Open it from the home screen like an app and get a ping when an agent needs you."],
  };

  let w = null; // the open wizard

  const button = (text, className, onClick) => {
    const node = el("button", className, text);
    node.type = "button";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  };

  const field = (label, control, hint) => {
    const wrap = el("label", "wz-field");
    wrap.append(el("span", "wz-label", label), control);
    if (hint) wrap.append(el("small", "", hint));
    return wrap;
  };

  const copyBox = (text, label = "Copy") => {
    const box = el("div", "wz-copy");
    box.append(el("code", "", text));
    const copy = button(label, "ghost small-btn", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(box.querySelector("code"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        copy.textContent = "Selected";
      }
      setTimeout(() => { copy.textContent = label; }, 1800);
    });
    box.append(copy);
    return box;
  };

  // ---- Data -------------------------------------------------------------------------

  async function loadSetup() {
    w.setup = await api("/api/setup");
    const steps = ["you", "model", "agents"];
    if (w.setup.vault) steps.push("notes");
    steps.push("phone");
    w.steps = steps;
  }

  async function loadCatalog() {
    w.catalog = await api("/api/models/catalog?fresh=1").catch(() => w.catalog || null);
  }

  function loadDiscover() {
    if (w.discoverStarted) return;
    w.discoverStarted = true;
    api("/api/discover")
      .then((data) => { w.found = Array.isArray(data.servers) ? data.servers : []; })
      .catch(() => { w.found = []; })
      .finally(() => { if (w && current() === "model") draw(); });
  }

  // After a provider sheet closes or OpenCode starts: refetch what step 2 shows.
  async function refreshModels() {
    if (!w) return;
    try {
      await Promise.all([loadSetup(), loadCatalog(), window.RavnirModels?.refresh()]);
    } catch (error) {
      w.error = error.message;
    }
    if (w && current() === "model") draw();
  }

  const current = () => w.steps[w.index];

  function defaultModelValue() {
    const models = w.setup?.models || {};
    if (models.defaultModel) return { via: models.defaultVia || "opencode", model: models.defaultModel };
    if (models.free) return { via: models.free.via, model: models.free.model };
    return null;
  }

  // ---- Frame ------------------------------------------------------------------------

  function build() {
    const dialog = document.createElement("dialog");
    dialog.className = "dialog wz";
    dialog.setAttribute("aria-labelledby", "wz-title");
    // Escape does not close the wizard; Skip setup does.
    dialog.addEventListener("cancel", (event) => event.preventDefault());

    const card = el("div", "dialog-card wz-card");
    const top = el("header", "wz-top");
    const progress = el("div", "wz-progress");
    const skip = button("Skip setup", "wz-skip", () => skipAll());
    top.append(progress, skip);

    const head = el("div", "wz-head");
    const title = el("h2", "", "");
    title.id = "wz-title";
    const lead = el("p", "wz-lead", "");
    head.append(title, lead);

    const body = el("div", "wz-body");
    const error = el("p", "wz-error", "");
    error.setAttribute("role", "alert");
    error.hidden = true;

    const foot = el("footer", "wz-foot");
    const back = button("Back", "ghost", () => go(-1));
    const next = button("Next", "primary", () => advance());
    const side = el("div", "wz-foot-side");
    foot.append(back, side, next);

    card.append(top, head, body, error, foot);
    dialog.append(card);
    document.body.append(dialog);
    Object.assign(w, { dialog, progress, title, lead, body, errorNode: error, back, next, side, skip });
  }

  function setError(message) {
    w.error = message || "";
    w.errorNode.textContent = w.error;
    w.errorNode.hidden = !w.error;
  }

  function setBusy(busy, label) {
    w.busy = busy;
    w.next.disabled = busy;
    w.back.disabled = busy;
    if (label !== undefined) w.next.textContent = label;
  }

  function draw() {
    if (!w) return;
    clearInterval(w.timer);
    const step = current();
    const [title, lead] = TITLES[step];
    w.title.textContent = title;
    w.lead.textContent = lead;
    w.progress.replaceChildren();
    const dots = el("span", "wz-dots");
    dots.setAttribute("aria-hidden", "true");
    w.steps.forEach((_, index) => dots.append(el("i", index === w.index ? "on" : index < w.index ? "done" : "")));
    w.progress.append(dots, el("span", "wz-count", `Step ${w.index + 1} of ${w.steps.length}`));
    w.back.hidden = w.index === 0;
    const last = w.index === w.steps.length - 1;
    w.next.textContent = last ? "Finish" : step === "notes" && !w.vaultLinked ? "Skip for now" : "Next";
    w.next.disabled = false;
    w.side.replaceChildren();
    const scroll = w.body.scrollTop;
    w.body.replaceChildren();
    ({ you: drawYou, model: drawModel, agents: drawAgents, notes: drawNotes, phone: drawPhone })[step]();
    if (w.stayScroll) w.body.scrollTop = scroll;
    w.stayScroll = false;
    setError(w.error && w.errorStep === step ? w.error : "");
  }

  function fail(error) {
    w.errorStep = current();
    setError(error?.message || String(error));
  }

  function go(delta) {
    if (w.busy) return;
    w.index = Math.min(w.steps.length - 1, Math.max(0, w.index + delta));
    w.error = "";
    draw();
    w.body.scrollTop = 0;
    const first = w.body.querySelector("input, select");
    if (first && !window.matchMedia("(max-width: 760px)").matches) first.focus({ preventScroll: true });
  }

  async function advance() {
    if (w.busy) return;
    setError("");
    const step = current();
    try {
      if (step === "you") await saveYou();
      else if (step === "model") await checkModel();
      else if (step === "agents") await saveAgents();
      else if (step === "phone") return await finish();
    } catch (error) {
      fail(error);
      setBusy(false);
      return;
    }
    setBusy(false);
    go(1);
  }

  // ---- 1. You -----------------------------------------------------------------------

  function guessLanguage() {
    const codes = Object.keys(w.setup.languages || {});
    const wanted = String(navigator.language || "").toLowerCase().split("-")[0];
    return codes.includes(wanted) ? wanted : "";
  }

  function drawYou() {
    const owner = w.setup.owner || {};
    if (w.name === undefined) w.name = owner.name || "";
    if (w.language === undefined) w.language = owner.language || guessLanguage();
    const name = document.createElement("input");
    name.value = w.name;
    name.placeholder = "Your first name";
    name.maxLength = 60;
    name.autocomplete = "given-name";
    name.addEventListener("input", () => { w.name = name.value; });
    name.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); advance(); } });
    const language = document.createElement("select");
    language.append(new Option("Not set", ""), ...Object.entries(w.setup.languages || {}).map(([code, label]) => new Option(label, code)));
    language.value = w.language;
    language.addEventListener("change", () => { w.language = language.value; });
    const form = el("div", "wz-stack");
    form.append(
      field("What should agents call you?", name, "Optional. Without a name they say \"the user\"."),
      field("The language you usually write in", language, "Agents answer in it and write your notes in it."),
    );
    w.body.append(form);
  }

  async function saveYou() {
    setBusy(true);
    const data = await api("/api/settings", { method: "PUT", body: { owner: { name: String(w.name || "").trim(), language: w.language || "" } } });
    state.settingsOwner = data.owner || state.settingsOwner;
  }

  // ---- 2. A model -------------------------------------------------------------------

  function ensurePicker() {
    if (w.picker) return;
    const start = defaultModelValue();
    w.picker = window.RavnirModels.picker({ value: start || undefined, onChange: () => { w.skipModel = false; if (current() === "model") syncFree(); } });
  }

  function syncFree() {
    const free = w.setup.models?.free;
    const card = w.body.querySelector(".wz-free");
    if (!card || !free) return;
    const picked = w.picker.value.model === free.model;
    card.classList.toggle("picked", picked);
    const use = card.querySelector("button");
    use.textContent = picked ? "Selected" : "Use this model";
    use.disabled = picked;
  }

  function drawModel() {
    if (!window.RavnirModels) {
      w.body.append(el("p", "wz-note", "The model picker did not load. Reload the page and try again."));
      return;
    }
    ensurePicker();
    loadDiscover();
    const { opencode, models } = w.setup;
    // OpenCode may have started after the picker was made (Let Ravnir run OpenCode): offer its free model.
    if (!w.picker.value?.model && !w.skipModel && models.free) w.picker.value = { via: models.free.via, model: models.free.model };
    const stack = el("div", "wz-stack");

    if (opencode.connected && models.free) {
      const card = el("div", "wz-free");
      const copy = el("div", "wz-free-copy");
      copy.append(el("strong", "", "Start free, no account"), el("span", "wz-free-name", models.free.name), el("small", "", freeNote(models.free)));
      card.append(copy, button("Use this model", "primary", () => { w.picker.value = { via: models.free.via, model: models.free.model }; w.skipModel = false; syncFree(); }));
      stack.append(card);
    } else if (!opencode.connected && opencode.canManage) {
      const card = el("div", "wz-free");
      const copy = el("div", "wz-free-copy");
      copy.append(el("strong", "", "Let Ravnir run OpenCode"), el("small", "", "OpenCode is installed on this computer. Ravnir can start it and use its free models, or the providers you sign in to."));
      const go = button("Start OpenCode", "primary", async () => {
        go.disabled = true;
        go.textContent = "Starting, this can take a minute…";
        setError("");
        try {
          await api("/api/setup/opencode", { method: "POST" });
          await refreshModels();
        } catch (error) {
          fail(error);
          go.disabled = false;
          go.textContent = "Try again";
        }
      });
      card.append(copy, go);
      stack.append(card);
    } else if (!opencode.connected) {
      const card = el("div", "wz-free plain");
      const copy = el("div", "wz-free-copy");
      copy.append(el("strong", "", "OpenCode is not available on this server"), el("small", "", opencode.managed?.error || "Ravnir uses OpenCode to reach hosted models. You can connect an OpenCode server, or use a model on your own machine below."));
      card.append(copy, button("Connect an OpenCode server", "ghost", () => toSettings("models")));
      stack.append(card);
    }

    if (opencode.connected) {
      const section = el("section", "wz-section");
      section.append(el("h3", "", "Or use your own"));
      const tiles = el("div", "wz-tiles");
      const providers = w.catalog?.providers || [];
      for (const [id, label] of OWN_PROVIDERS) {
        const provider = providers.find((item) => item.id === id);
        if (!provider) continue;
        const tile = el("button", "wz-tile");
        tile.type = "button";
        tile.append(window.RavnirModels.providerMark(provider, "mdl-mark"), el("span", "wz-tile-name", label));
        if (provider.connected) tile.append(el("span", "wz-ok", "Connected"));
        tile.addEventListener("click", () => openConnect(id));
        tiles.append(tile);
      }
      section.append(tiles, button("More providers", "wz-link", () => toSettings("models")));
      stack.append(section);
    }

    const local = el("section", "wz-section");
    local.append(el("h3", "", "A model on your own machine"));
    const known = new Set((w.catalog?.servers || []).map((item) => String(item.baseUrl || "").replace(/\/+$/, "")));
    const found = (w.found || []).filter((item) => item.kind === "openai" && !known.has(String(item.baseUrl).replace(/\/+$/, "")));
    if (!w.found) local.append(el("p", "wz-note", "Looking for Ollama or LM Studio…"));
    else if (!found.length) local.append(el("p", "wz-note", "Nothing found. Start Ollama or LM Studio on this computer and it shows up here."));
    for (const server of found) {
      const line = el("div", "wz-line");
      const copy = el("div", "wz-line-copy");
      copy.append(el("strong", "", server.name || server.baseUrl), el("small", "", `${server.baseUrl}${server.models?.length ? `, ${server.models.length} models` : ""}`));
      const use = button("Use", "ghost small-btn", async () => {
        use.disabled = true;
        use.textContent = "Adding…";
        try {
          const added = await api("/api/models/servers", { method: "POST", body: { name: server.name || "", baseUrl: server.baseUrl, apiKey: "" } });
          const list = await window.RavnirModels.refresh();
          await loadSetup();
          await loadCatalog();
          const via = `server:${added.server.id}`;
          const hit = (list.list?.models || []).find((item) => item.via === via);
          if (hit) { w.picker.value = { via, model: hit.id }; w.skipModel = false; }
          draw();
        } catch (error) {
          fail(error);
          use.disabled = false;
          use.textContent = "Use";
        }
      });
      line.append(copy, use);
      local.append(line);
    }
    stack.append(local);

    const pick = el("section", "wz-section");
    pick.append(el("h3", "", "Model for your agents"), w.picker);
    const skip = button("Skip for now", "wz-link", () => { w.skipModel = true; setError(""); go(1); });
    pick.append(skip);
    stack.append(pick);
    w.body.append(stack);
    syncFree();
  }

  // Opens a provider sheet and reloads this step when it closes.
  function openConnect(providerId) {
    const onClose = (event) => {
      if (!event.target.classList?.contains("models-dialog")) return;
      document.removeEventListener("close", onClose, true);
      refreshModels();
    };
    document.addEventListener("close", onClose, true);
    window.RavnirModels.connect(providerId);
  }

  function toSettings(section) {
    close();
    openSettingsPage(section);
  }

  async function checkModel() {
    if (w.skipModel) return;
    if (!w.picker?.value.model) throw new Error("Pick a model, or choose Skip for now.");
  }

  // ---- 3. Agents --------------------------------------------------------------------

  function drawAgents() {
    const starters = w.setup.starters || [];
    if (!w.pick) w.pick = new Set(starters.filter((item) => item.selected && !item.exists).map((item) => item.id));
    const list = el("div", "wz-stack");
    for (const item of starters) {
      const row = el("label", `wz-starter${item.exists ? " exists" : ""}`);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = item.exists || w.pick.has(item.id);
      box.disabled = item.exists;
      box.addEventListener("change", () => { box.checked ? w.pick.add(item.id) : w.pick.delete(item.id); });
      const copy = el("span", "wz-starter-copy");
      copy.append(el("strong", "", item.name), el("small", "", item.job));
      if (item.exists) copy.append(el("small", "wz-hint", "Already here"));
      else if (item.needs) copy.append(el("small", "wz-hint", `Needs ${item.needs}`));
      row.append(box, copy);
      list.append(row);
    }
    const imp = el("p", "wz-note");
    imp.append("Leaving Grok Bot? ", button("Import your agents instead", "wz-link", () => { close(); openImport(); }));
    list.append(imp);
    w.body.append(list);
  }

  async function saveAgents() {
    const ids = [...(w.pick || [])].filter((id) => !(w.setup.starters || []).find((item) => item.id === id && item.exists));
    if (!ids.length) {
      if (w.setup.agents > 0) return;
      throw new Error("Pick at least one agent, or skip setup.");
    }
    setBusy(true, "Creating…");
    const body = { ids };
    if (!w.skipModel && w.picker?.value.model) body.model = w.picker.value;
    const result = await api("/api/setup/starters", { method: "POST", body });
    w.created = [...(w.created || []), ...result.created];
    await refreshState();
    await loadSetup();
    w.pick = new Set([...w.pick].filter((id) => !w.setup.starters.find((item) => item.id === id && item.exists)));
  }

  // ---- 4. Notes ---------------------------------------------------------------------

  function drawNotes() {
    const vault = w.setup.vault;
    const stack = el("div", "wz-stack");
    const status = vault.remote
      ? `Linked to ${vault.remote}${vault.branch ? ` on branch ${vault.branch}` : ""}.`
      : vault.available
        ? `${vault.notes} ${vault.notes === 1 ? "note" : "notes"} on this server so far. Nothing leaves it unless you link a repository.`
        : "The vault is not ready yet.";
    stack.append(el("p", "wz-note strong", status));
    if (vault.lastError) stack.append(el("p", "wz-note warn", vault.lastError));
    if (w.vaultSaved) stack.append(el("p", "wz-note", `Notes written here before linking are kept on branch ${w.vaultSaved}.`));
    if (vault.canLink) {
      const section = el("section", "wz-section");
      section.append(el("h3", "", "Link a repository (optional)"));
      section.append(el("p", "wz-note", "A private git repository keeps your notes backed up and lets you open them in Obsidian on your computer."));
      const url = document.createElement("input");
      url.placeholder = "git@github.com:you/notes.git";
      url.value = w.vaultUrl || "";
      url.autocomplete = "off";
      url.spellcheck = false;
      url.addEventListener("input", () => { w.vaultUrl = url.value; });
      section.append(field("Repository address", url, "The SSH address is the safest choice."));
      const keyBox = el("div", "wz-keybox");
      keyBox.hidden = !w.publicKey;
      const fillKey = () => {
        keyBox.replaceChildren(
          el("p", "wz-note", "On GitHub: your repository, Settings, Deploy keys, Add deploy key. Paste this key and tick Allow write access."),
          copyBox(w.publicKey || "", "Copy key"),
        );
        keyBox.hidden = false;
      };
      if (w.publicKey) fillKey();
      const actions = el("div", "wz-actions");
      const show = button("Show this server's key", "ghost", async () => {
        show.disabled = true;
        try {
          w.publicKey = (await api("/api/setup/vault/key", { method: "POST" })).publicKey;
          fillKey();
        } catch (error) {
          fail(error);
        }
        show.disabled = false;
      });
      const link = button(vault.remote ? "Link again" : "Link", "primary", async () => {
        setError("");
        if (!String(w.vaultUrl || "").trim()) { fail(new Error("Enter the repository address first.")); return; }
        link.disabled = true;
        link.textContent = "Linking…";
        try {
          const result = await api("/api/setup/vault", { method: "POST", body: { url: String(w.vaultUrl).trim() } });
          w.setup.vault = result.vault || w.setup.vault;
          w.vaultLinked = Boolean(result.vault?.remote);
          w.vaultSaved = result.saved || "";
          w.stayScroll = true;
          draw();
        } catch (error) {
          fail(error);
          link.disabled = false;
          link.textContent = vault.remote ? "Link again" : "Link";
        }
      });
      actions.append(show, link);
      section.append(actions, keyBox);
      stack.append(section);
    } else {
      stack.append(el("p", "wz-note", "This vault was set up by hand, so it stays as it is. Nothing more to do here."));
    }
    w.body.append(stack);
    if (w.vaultLinked) w.next.textContent = "Next";
  }

  // ---- 5. Phone ---------------------------------------------------------------------

  let qrPromise = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve();
    qrPromise ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/qrcode.js";
      script.onload = () => resolve();
      script.onerror = () => { qrPromise = null; reject(new Error("The QR code library did not load.")); };
      document.head.append(script);
    });
    return qrPromise;
  }

  function qrSvg(text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  function drawPhone() {
    const { access, signIn } = w.setup;
    // The https address in the browser bar works on the phone too; the configured one may be internal.
    const base = location.protocol === "https:" ? location.origin : String(access.publicUrl || "").replace(/\/+$/, "");
    const https = /^https:/i.test(base);
    const stack = el("div", "wz-stack");
    if (!https) {
      stack.append(
        el("p", "wz-note strong", "Right now Ravnir can only be reached from this computer."),
        el("p", "wz-note", "A phone needs a private address with HTTPS. Tailscale is the easiest: it gives this server an address only your devices can open. To set it up, run this on the server, then open Setup again from Settings, Tools."),
        copyBox("./install.sh --access tailscale", "Copy"),
        el("p", "wz-note", "You can also put the server behind your own domain. The setup guide explains both."),
      );
      w.body.append(stack);
      return;
    }
    const pairing = signIn;
    const card = el("div", "wz-phone");
    const qr = el("div", "wz-qr");
    qr.setAttribute("role", "img");
    qr.setAttribute("aria-label", "QR code to open Ravnir on your phone");
    qr.append(el("span", "wz-qr-wait", "Making your code…"));
    const side = el("div", "wz-phone-side");
    const code = el("div", "wz-code", "");
    const expires = el("small", "wz-expires", "");
    if (pairing) side.append(el("span", "wz-label", "Pairing code"), code, expires);
    else side.append(el("span", "wz-label", "Address"), el("code", "wz-address", base));
    const fresh = button("New code", "ghost small-btn", () => make());
    if (pairing) side.append(fresh);
    card.append(qr, side);

    const steps = el("ol", "wz-steps");
    if (access.mode === "tailscale") steps.append(el("li", "", "Install Tailscale on the phone and sign in with the same account as this server."));
    steps.append(
      el("li", "", "Scan the QR code with the Camera app and open the link in Safari."),
      el("li", "", "Tap Share, then Add to Home Screen. Open Ravnir from its new icon."),
      pairing ? el("li", "", "Tap Use a pairing code and type the code above. It works once and lasts 15 minutes.") : el("li", "", "Sign in the way you do on this computer."),
    );
    stack.append(card, steps);
    w.body.append(stack);

    async function make() {
      fresh.disabled = true;
      clearInterval(w.timer);
      try {
        let target = base;
        let expiresAt = 0;
        if (pairing) {
          const made = await api("/api/pair", { method: "POST" });
          code.textContent = made.code;
          expiresAt = made.expiresAt;
          target = `${base}/login?pair=1`;
        }
        await loadQr();
        if (!w || current() !== "phone") return;
        qr.innerHTML = qrSvg(target); // markup made by the QR library from an address, not from user text
        if (expiresAt) {
          const tick = () => {
            const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
            expires.textContent = left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "This code expired. Make a new one.";
            expires.classList.toggle("warn", !left);
          };
          tick();
          w.timer = setInterval(tick, 1000);
        }
        setError("");
      } catch (error) {
        if (w) fail(error);
        qr.replaceChildren(el("span", "wz-qr-wait", "No code"));
      }
      fresh.disabled = false;
    }
    make();
  }

  // ---- Done -------------------------------------------------------------------------

  async function finish() {
    setBusy(true, "Finishing…");
    try {
      await api("/api/setup/done", { method: "POST", body: {} });
      await refreshState();
    } catch (error) {
      fail(error);
      setBusy(false, "Finish");
      return;
    }
    const bots = state.bots || [];
    const main = bots.find((bot) => bot.main) || bots[0];
    close();
    if (!main) return;
    await selectBot(main.id);
    const input = els["composer-input"];
    if (input && !input.value.trim()) {
      input.value = FIRST_MESSAGE;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input?.focus();
  }

  async function skipAll() {
    if (w.busy) return;
    w.skip.disabled = true;
    try {
      await api("/api/setup/done", { method: "POST", body: { skipped: true } });
      await refreshState();
    } catch (error) {
      fail(error);
      w.skip.disabled = false;
      return;
    }
    close();
    renderAll?.();
  }

  // ---- Public -----------------------------------------------------------------------

  async function open() {
    if (w) return;
    w = { index: 0, steps: ["you", "model", "agents", "phone"], error: "", errorStep: "", busy: false };
    const mine = w;
    try {
      build();
      w.dialog.showModal();
      w.body.append(el("p", "wz-note", "Loading…"));
      await loadSetup();
      await loadCatalog();
      draw();
      const first = w.body.querySelector("input");
      if (first && !window.matchMedia("(max-width: 760px)").matches) first.focus({ preventScroll: true });
    } catch (error) {
      if (w === mine && w.body) {
        w.body.replaceChildren(el("p", "wz-note warn", error.message));
        w.body.append(button("Try again", "ghost", () => { close(); open(); }));
      }
    }
  }

  function close() {
    if (!w) return;
    clearInterval(w.timer);
    w.dialog.close();
    w.dialog.remove();
    w = null;
  }

  window.RavnirWelcome = { open, close };
})();
