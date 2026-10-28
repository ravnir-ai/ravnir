// Models: sign in to providers, pick a model. Loaded before settings.js; uses api, el, ask and toast from app.js.
// window.RavnirModels = { renderPage, picker, refresh, connect, providerMark }

(() => {
  const CACHE_MS = 60_000;
  const store = {
    list: null,
    listAt: 0,
    listPromise: null,
    catalog: null,
    catalogAt: 0,
    catalogPromise: null,
    discover: null,
    discoverPromise: null,
    pages: new Set(),
    pickers: new Set(),
  };

  // ---- Data -----------------------------------------------------------------------

  function getList(force = false) {
    if (!force && store.list && Date.now() - store.listAt < CACHE_MS) return Promise.resolve(store.list);
    if (store.listPromise) return store.listPromise;
    store.listPromise = api("/api/models/list")
      .then((data) => {
        store.list = { models: Array.isArray(data.models) ? data.models : [], defaultModel: data.defaultModel || "" };
        store.listAt = Date.now();
        return store.list;
      })
      .finally(() => { store.listPromise = null; });
    return store.listPromise;
  }

  function getCatalog(force = false) {
    if (!force && store.catalog && Date.now() - store.catalogAt < CACHE_MS) return Promise.resolve(store.catalog);
    if (store.catalogPromise) return store.catalogPromise;
    store.catalogPromise = api("/api/models/catalog")
      .then((data) => {
        store.catalog = {
          opencode: data.opencode || { connected: false, baseUrl: "", source: "none", error: "" },
          providers: Array.isArray(data.providers) ? data.providers : [],
          servers: Array.isArray(data.servers) ? data.servers : [],
        };
        store.catalogAt = Date.now();
        return store.catalog;
      })
      .finally(() => { store.catalogPromise = null; });
    return store.catalogPromise;
  }

  function getDiscover() {
    if (store.discover) return Promise.resolve(store.discover);
    store.discoverPromise ||= api("/api/discover")
      .then((data) => { store.discover = Array.isArray(data.servers) ? data.servers : []; return store.discover; })
      .catch(() => { store.discover = []; return store.discover; });
    return store.discoverPromise;
  }

  // Refetches both lists, then tells every open page and picker.
  async function refresh() {
    const [list, catalog] = await Promise.allSettled([getList(true), getCatalog(true)]);
    notify();
    return { list: list.value || store.list, catalog: catalog.value || store.catalog };
  }

  function notify() {
    for (const page of [...store.pages]) {
      if (!page.host.isConnected) store.pages.delete(page);
      else page.draw();
    }
    for (const item of [...store.pickers]) {
      if (!item.root.isConnected) store.pickers.delete(item);
      else item.sync();
    }
  }

  // ---- Small helpers --------------------------------------------------------------

  function button(text, className, onClick) {
    const node = el("button", className, text);
    node.type = "button";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  function count(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function compact(n) {
    if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  function money(n) {
    const value = Number(n) || 0;
    return `$${+value.toFixed(value < 1 ? 3 : 2)}`;
  }

  function priceText(cost) {
    if (!cost || (!cost.input && !cost.output)) return "";
    return `${money(cost.input)} in, ${money(cost.output)} out per 1M`;
  }

  function matches(text, query) {
    const hay = String(text).toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => hay.includes(part));
  }

  // A provider's logo (models.dev, monochrome) painted as a mask so it takes the text colour in both
  // themes; the first letter when there is no logo. Servers added by hand get a logo by name.
  function logoFor(item = {}) {
    if (item.logo) return item.logo;
    const text = `${item.name || ""} ${item.baseUrl || ""}`.toLowerCase();
    if (/lm ?studio|:1234\b/.test(text)) return "/plugins/providers/lmstudio.svg";
    if (/ollama|:11434\b/.test(text)) return "/plugins/providers/ollama-cloud.svg";
    return "";
  }

  function providerMark(provider = {}, className = "mdl-mark") {
    const mark = el("span", className);
    const logo = logoFor(provider);
    if (logo) {
      const glyph = el("i", "mdl-logo");
      glyph.style.setProperty("--logo", `url("${logo}")`);
      glyph.setAttribute("aria-hidden", "true");
      mark.append(glyph);
    } else {
      mark.append(el("b", "", (provider.name || provider.id || "?").trim().charAt(0).toUpperCase()));
    }
    return mark;
  }

  function openDialogs() {
    return [...document.querySelectorAll("dialog[open]")];
  }

  function mobile() {
    return window.matchMedia("(max-width: 719px)").matches;
  }

  function modelsOf(provider) {
    return Number(provider?.models) || 0;
  }

  // ---- The connect sheet ----------------------------------------------------------

  const sheet = { dialog: null, token: 0 };

  function ensureSheet() {
    if (sheet.dialog) return sheet.dialog;
    const dialog = document.createElement("dialog");
    dialog.className = "dialog models-dialog";
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => { sheet.token += 1; }); // stops any sign-in we are waiting on
    document.body.append(dialog);
    sheet.dialog = dialog;
    return dialog;
  }

  function usableMethods(provider) {
    const all = provider.methods?.length ? provider.methods : [{ index: 0, type: "api", label: "API key", prompts: [], remote: true }];
    const usable = all.filter((method) => method.remote !== false);
    return usable.length ? { methods: usable, blocked: false } : { methods: all.slice(0, 1), blocked: true };
  }

  function promptVisible(prompt, answers) {
    const when = prompt.when;
    if (!when || !when.key) return true;
    const have = answers[when.key];
    return when.op === "neq" ? have !== when.value : have === when.value;
  }

  const CODE_PATTERNS = [/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/, /code:\s*([A-Z0-9][A-Z0-9-]{3,})/i];
  function findCode(text) {
    for (const pattern of CODE_PATTERNS) {
      const hit = String(text || "").match(pattern);
      if (hit) return hit[1] || hit[0];
    }
    return "";
  }

  async function copyText(text, trigger) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* nothing */ }
      area.remove();
      toast(ok ? "Copied." : "Could not copy. Select the text and copy it.", ok ? "" : "error");
    }
    trigger?.blur();
  }

  function openConnect(providerId) {
    const dialog = ensureSheet();
    sheet.token += 1;
    const token = sheet.token;
    const alive = () => sheet.token === token && dialog.open;

    const flow = {
      provider: null,
      method: 0,
      answers: {},
      phase: "form", // form, working, waiting, code, done
      error: "",
      info: null, // { url, mode, instructions, code }
      done: "",
    };

    const find = () => store.catalog?.providers.find((item) => item.id === providerId);

    const start = async () => {
      if (!store.catalog) {
        try { await getCatalog(); } catch (error) { toast(error.message, "error"); return; }
      }
      flow.provider = find();
      if (!flow.provider) { toast("That provider is not in the list.", "error"); return; }
      const { methods } = usableMethods(flow.provider);
      flow.method = methods[0].index;
      resetAnswers();
      draw();
      if (!dialog.open) dialog.showModal();
    };

    const currentMethod = () => {
      const { methods } = usableMethods(flow.provider);
      return methods.find((method) => method.index === flow.method) || methods[0];
    };

    function resetAnswers() {
      flow.answers = {};
      for (const prompt of currentMethod().prompts || []) {
        if (prompt.type === "select" && prompt.options?.length) flow.answers[prompt.key] = prompt.options[0].value;
      }
    }

    const succeed = async (provider) => {
      const fresh = provider && typeof provider === "object" ? provider : null;
      flow.phase = "done";
      flow.error = "";
      flow.done = "Connected.";
      draw();
      await refresh().catch(() => {});
      if (!alive()) return;
      const known = store.catalog?.providers.find((item) => item.id === providerId);
      const total = modelsOf(known) || modelsOf(fresh);
      flow.done = total ? `Connected. ${count(total, "model")}.` : "Connected.";
      draw();
    };

    const connectKey = async (key) => {
      flow.phase = "working";
      flow.error = "";
      draw();
      try {
        const data = await api(`/api/models/providers/${encodeURIComponent(providerId)}/key`, { method: "POST", body: { key, inputs: { ...flow.answers } } });
        if (!alive()) return;
        await succeed(data.provider);
      } catch (error) {
        if (!alive()) return;
        flow.phase = "form";
        flow.error = error.message;
        draw();
      }
    };

    const awaitFinish = async (code) => {
      try {
        const data = await api(`/api/models/providers/${encodeURIComponent(providerId)}/oauth/finish`, { method: "POST", body: { method: flow.method, code: code || undefined } });
        if (!alive()) return;
        await succeed(data.provider);
      } catch (error) {
        if (!alive()) return;
        flow.phase = flow.info?.mode === "code" ? "code" : "failed";
        flow.error = error.message;
        draw();
      }
    };

    const connectOauth = async () => {
      flow.phase = "working";
      flow.error = "";
      draw();
      try {
        const data = await api(`/api/models/providers/${encodeURIComponent(providerId)}/oauth/start`, { method: "POST", body: { method: flow.method, inputs: { ...flow.answers } } });
        if (!alive()) return;
        flow.info = { url: data.url || "", mode: data.mode === "code" ? "code" : "auto", instructions: data.instructions || "", code: findCode(data.instructions) };
        if (flow.info.mode === "auto") {
          flow.phase = "waiting";
          draw();
          awaitFinish();
        } else {
          flow.phase = "code";
          draw();
        }
      } catch (error) {
        if (!alive()) return;
        flow.phase = "form";
        flow.error = error.message;
        draw();
      }
    };

    function draw() {
      const provider = flow.provider;
      if (!provider) return;
      const { methods, blocked } = usableMethods(provider);
      const method = currentMethod();
      const card = el("div", "dialog-card");

      const head = el("header", "dialog-head");
      const titles = el("div", "");
      titles.className = "mdl-sheet-title";
      const words = el("div", "");
      words.append(el("p", "kicker", "Models"), el("h2", "", `Connect ${provider.name}`));
      titles.append(providerMark(provider, "mdl-mark large"), words);
      const close = el("button", "icon-btn", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", () => dialog.close());
      head.append(titles, close);

      const body = el("div", "dialog-body mdl-body");
      const foot = el("footer", "dialog-foot mdl-foot");
      const message = el("span", "error-text mdl-error", flow.error);
      const actions = el("div", "row");
      foot.append(message, actions);

      if (flow.phase === "done") {
        const ok = el("div", "mdl-done");
        ok.append(el("span", "mdl-tick", "✓"), el("strong", "", flow.done));
        body.append(ok, el("p", "hint", `You can now pick ${provider.name} models for any agent.`));
        actions.append(button("Done", "primary", () => dialog.close()));
      } else if (flow.phase === "waiting" || flow.phase === "code" || flow.phase === "failed") {
        renderSignIn(body, actions, method);
      } else {
        renderForm(body, actions, methods, blocked, method);
      }

      card.append(head, body, foot);
      const active = document.activeElement;
      const focusKey = active?.closest?.("dialog") === dialog ? active.dataset?.key : "";
      const caret = focusKey && "selectionStart" in active ? active.selectionStart : null;
      dialog.replaceChildren(card);
      if (focusKey) {
        const again = dialog.querySelector(`[data-key="${focusKey}"]`);
        if (again) {
          again.focus();
          if (caret !== null) try { again.setSelectionRange(caret, caret); } catch { /* not a text field */ }
        }
      }
    }

    function renderForm(body, actions, methods, blocked, method) {
      const busy = flow.phase === "working";
      if (methods.length > 1) {
        body.append(el("p", "mdl-label", "How do you want to connect?"));
        const choices = el("div", "mdl-choices");
        for (const item of methods) {
          const choice = button("", `mdl-choice${item.index === flow.method ? " on" : ""}`, () => {
            flow.method = item.index;
            flow.error = "";
            resetAnswers();
            draw();
          });
          choice.append(el("strong", "", item.label), el("small", "", item.type === "oauth" ? "Sign in with your account" : "Paste an API key"));
          choice.disabled = busy;
          choices.append(choice);
        }
        body.append(choices);
      } else if (methods.length === 1 && methods[0].label) {
        body.append(el("p", "mdl-label", methods[0].label));
      }

      if (blocked) {
        body.append(el("p", "plug-note", "Only works on the computer running Ravnir."));
      }

      const promptBox = el("div", "mdl-prompts");
      const renderPrompts = () => {
        const focused = document.activeElement?.dataset?.key;
        promptBox.replaceChildren();
        for (const prompt of method.prompts || []) {
          if (!promptVisible(prompt, flow.answers)) continue;
          const wrap = el("label", "mdl-field");
          wrap.append(el("span", "", prompt.message || prompt.key));
          if (prompt.type === "select") {
            const select = document.createElement("select");
            select.dataset.key = prompt.key;
            for (const option of prompt.options || []) select.append(new Option(option.label, option.value));
            select.value = flow.answers[prompt.key] ?? "";
            select.disabled = busy || blocked;
            select.addEventListener("change", () => {
              flow.answers[prompt.key] = select.value;
              renderPrompts();
            });
            wrap.append(select);
            const hint = (prompt.options || []).find((option) => option.value === select.value)?.hint;
            if (hint) wrap.append(el("small", "", hint));
          } else {
            const input = document.createElement("input");
            input.type = "text";
            input.dataset.key = prompt.key;
            input.placeholder = prompt.placeholder || "";
            input.value = flow.answers[prompt.key] ?? "";
            input.autocomplete = "off";
            input.spellcheck = false;
            input.disabled = busy || blocked;
            const dependants = (method.prompts || []).some((other) => other.when?.key === prompt.key);
            input.addEventListener("input", () => {
              flow.answers[prompt.key] = input.value;
              if (dependants) renderPrompts();
            });
            wrap.append(input);
          }
          promptBox.append(wrap);
        }
        if (focused) promptBox.querySelector(`[data-key="${focused}"]`)?.focus();
      };
      renderPrompts();
      body.append(promptBox);

      if (method.type === "api") {
        const field = el("label", "mdl-field");
        field.append(el("span", "", "Paste your API key"));
        const key = document.createElement("input");
        key.type = "password";
        key.autocomplete = "off";
        key.spellcheck = false;
        key.placeholder = "Paste your API key";
        key.dataset.key = "__apikey";
        key.disabled = busy || blocked;
        field.append(key);
        body.append(field);
        if (flow.provider.keyUrl) {
          const link = document.createElement("a");
          link.href = flow.provider.keyUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "mdl-link";
          link.textContent = "Where do I get a key?";
          body.append(link);
        }
        body.append(el("p", "hint", "The key is stored on this server and never shown again."));
        const go = button(busy ? "Connecting…" : "Connect", "primary", () => {
          if (!key.value.trim()) { flow.error = "Paste your API key first."; draw(); return; }
          connectKey(key.value.trim());
        });
        go.disabled = busy || blocked;
        key.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); go.click(); } });
        actions.append(button("Cancel", "ghost", () => dialog.close()), go);
        if (!busy) setTimeout(() => { if (alive() && !dialog.querySelector("[data-key]:focus")) key.focus(); }, 30);
      } else {
        body.append(el("p", "hint", "You sign in on the provider's own site. Ravnir never sees your password."));
        const go = button(busy ? "Starting…" : "Continue", "primary", connectOauth);
        go.disabled = busy || blocked;
        actions.append(button("Cancel", "ghost", () => dialog.close()), go);
      }
    }

    function renderSignIn(body, actions, method) {
      const info = flow.info || {};
      const waiting = flow.phase === "waiting";
      if (info.code) {
        body.append(el("p", "mdl-label", "Your code"));
        const box = el("div", "mdl-code");
        box.append(el("code", "", info.code), button("Copy", "ghost small-btn", (event) => copyText(info.code, event.currentTarget)));
        body.append(box);
      }
      const rest = info.code ? String(info.instructions || "").replace(info.code, "").replace(/\s{2,}/g, " ").replace(/^\W+|\W+$/g, "") : info.instructions;
      if (rest && /\w/.test(rest) && rest.toLowerCase() !== "enter code") body.append(el("p", "mdl-instructions", rest));
      else if (!info.code && info.instructions) body.append(el("p", "mdl-instructions", info.instructions));

      if (info.url) {
        const open = document.createElement("a");
        open.href = info.url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.className = "mdl-open";
        open.textContent = "Open sign-in page";
        body.append(open);
      }

      if (waiting) {
        const status = el("div", "mdl-wait");
        status.append(el("span", "spinner"), el("span", "", "Waiting for you to finish signing in…"));
        body.append(status);
        actions.append(button("Cancel", "ghost", () => {
          sheet.token += 1; // the request may still be open on the server; we stop listening
          flow.phase = "form";
          flow.error = "";
          flow.info = null;
          draw();
        }));
      } else if (flow.phase === "code") {
        const field = el("label", "mdl-field");
        field.append(el("span", "", "Paste the code"));
        const code = document.createElement("input");
        code.type = "text";
        code.autocomplete = "off";
        code.spellcheck = false;
        code.placeholder = "Paste the code";
        code.dataset.key = "__code";
        field.append(code);
        body.append(field);
        const go = button("Finish", "primary", () => {
          if (!code.value.trim()) { flow.error = "Paste the code first."; draw(); return; }
          flow.error = "";
          awaitFinish(code.value.trim());
        });
        code.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); go.click(); } });
        actions.append(button("Cancel", "ghost", () => dialog.close()), go);
        setTimeout(() => { if (alive()) code.focus(); }, 30);
      } else {
        actions.append(button("Cancel", "ghost", () => dialog.close()), button("Try again", "primary", () => {
          flow.phase = "form";
          flow.info = null;
          draw();
        }));
      }
    }

    start();
  }

  // ---- The Models page ------------------------------------------------------------

  function renderPage(host) {
    const root = el("div", "mdl-page");
    host.append(root);
    const view = { query: "", showAll: false, error: "", loading: !store.catalog, editOpencode: false, serverForm: false, busy: new Set() };
    const page = { host, draw };
    store.pages.add(page);

    function section(title, hint) {
      const wrap = el("div", "mdl-section");
      const head = el("div", "mdl-section-head");
      head.append(el("strong", "", title));
      wrap.append(head);
      if (hint) wrap.append(el("p", "hint", hint));
      return wrap;
    }

    function opencodeCard(catalog) {
      const oc = catalog.opencode;
      const wrap = el("div", "mdl-oc");
      const connected = catalog.providers.filter((provider) => provider.connected);
      const models = connected.reduce((sum, provider) => sum + modelsOf(provider), 0);
      const top = el("div", "mdl-oc-top");
      const copy = el("div", "mdl-oc-copy");
      copy.append(el("strong", "", "OpenCode on this server"));
      if (oc.connected) {
        copy.append(el("span", "mdl-ok", `Connected · ${count(models, "model")} from ${count(connected.length, "provider")}`));
        if (oc.baseUrl) copy.append(el("small", "mdl-mono", oc.baseUrl));
      } else {
        copy.append(el("span", "mdl-warn", "Not connected"));
        if (oc.error) copy.append(el("small", "error-text", oc.error));
      }
      top.append(copy);
      if (oc.connected && !view.editOpencode) top.append(button("Change", "ghost small-btn", () => { view.editOpencode = true; draw(); }));
      wrap.append(top);
      if (!oc.connected || view.editOpencode) wrap.append(opencodeForm(oc));
      return wrap;
    }

    function opencodeForm(oc) {
      const form = el("form", "mdl-form");
      const addr = document.createElement("input");
      addr.type = "text";
      addr.placeholder = "http://127.0.0.1:4096";
      addr.value = view.ocAddr ?? oc.baseUrl ?? "";
      addr.autocomplete = "off";
      addr.spellcheck = false;
      addr.addEventListener("input", () => { view.ocAddr = addr.value; });
      const user = document.createElement("input");
      user.type = "text";
      user.placeholder = "opencode";
      user.value = view.ocUser ?? "opencode";
      user.autocomplete = "off";
      user.addEventListener("input", () => { view.ocUser = user.value; });
      const pass = document.createElement("input");
      pass.type = "password";
      pass.placeholder = "Server password, if it has one";
      pass.autocomplete = "off";
      const fields = el("div", "mdl-fields");
      const f1 = el("label", "mdl-field");
      f1.append(el("span", "", "Server address"), addr);
      const f2 = el("label", "mdl-field");
      f2.append(el("span", "", "Username"), user);
      const f3 = el("label", "mdl-field");
      f3.append(el("span", "", "Password"), pass);
      fields.append(f1, f2, f3);
      const go = el("button", "primary", "Connect");
      go.type = "submit";
      const actions = el("div", "row");
      actions.append(go);
      if (oc.connected) actions.append(button("Cancel", "ghost", () => { view.editOpencode = false; draw(); }));
      const status = el("span", "error-text", "");
      actions.append(status);
      form.append(fields, actions);
      if (!view.ocAddr && !oc.baseUrl) {
        getDiscover().then((servers) => {
          const first = servers.find((server) => server.kind === "opencode");
          if (first && !addr.value && addr.isConnected) { addr.value = first.baseUrl; view.ocAddr = first.baseUrl; }
        });
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        go.disabled = true;
        go.textContent = "Connecting…";
        status.textContent = "";
        try {
          await api("/api/models/opencode", { method: "POST", body: { baseUrl: addr.value.trim(), username: user.value.trim(), password: pass.value } });
          view.editOpencode = false;
          view.ocAddr = undefined;
          toast("OpenCode connected.");
          await refresh();
        } catch (error) {
          status.textContent = error.message;
          go.disabled = false;
          go.textContent = "Connect";
        }
      });
      return form;
    }

    function connectedRows(catalog) {
      const wrap = section("Your providers");
      const list = catalog.providers.filter((provider) => provider.connected);
      if (!list.length) {
        wrap.append(el("p", "hint", "None yet. Connect one below and its models show up when you create an agent."));
        return wrap;
      }
      const box = el("div", "mdl-list");
      for (const provider of list) {
        const line = el("div", "mdl-line");
        const copy = el("div", "mdl-line-copy");
        copy.append(el("strong", "", provider.name), el("small", "", count(modelsOf(provider), "model")));
        const out = button("Sign out", "ghost small-btn", async () => {
          const yes = await ask({ kicker: "Models", title: `Sign out of ${provider.name}?`, message: `Agents using ${provider.name} models will stop working until you connect it again.`, confirm: "Sign out", danger: true });
          if (!yes) return;
          out.disabled = true;
          try {
            await api(`/api/models/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
            toast(`Signed out of ${provider.name}.`);
            await refresh();
          } catch (error) {
            toast(error.message, "error");
            out.disabled = false;
          }
        });
        line.append(providerMark(provider), copy, out);
        box.append(line);
      }
      wrap.append(box);
      return wrap;
    }

    function addRows(catalog) {
      const wrap = section("Add a provider", "Sign in with a subscription you already pay for, or paste an API key.");
      const search = el("div", "plug-search mdl-search");
      const input = document.createElement("input");
      input.type = "search";
      input.placeholder = "Search providers";
      input.value = view.query;
      input.setAttribute("aria-label", "Search providers");
      input.autocomplete = "off";
      search.append(input);
      wrap.append(search);

      const results = el("div", "mdl-results");
      wrap.append(results);

      const providers = catalog.providers;
      const paint = () => {
        results.replaceChildren();
        const query = view.query.trim();
        if (query) {
          const found = providers.filter((provider) => matches(`${provider.name} ${provider.id}`, query));
          if (!found.length) results.append(el("p", "hint", "Nothing matches. Try another name."));
          else results.append(rowList(found));
          return;
        }
        const popular = providers.filter((provider) => provider.popular && !provider.connected);
        if (popular.length) {
          const grid = el("div", "mdl-tiles");
          for (const provider of popular) {
            const tile = button("", "mdl-tile", () => openConnect(provider.id));
            const copy = el("span", "mdl-tile-copy");
            copy.append(el("strong", "", provider.name), el("small", "", provider.methods?.some((method) => method.type === "oauth" && method.remote !== false) ? "Sign in or key" : "API key"));
            tile.append(providerMark(provider), copy);
            grid.append(tile);
          }
          results.append(grid);
        }
        const toggle = button(view.showAll ? "Hide all providers" : `All providers (${providers.length})`, "link-btn mdl-all", () => {
          view.showAll = !view.showAll;
          paint();
        });
        results.append(toggle);
        if (view.showAll) results.append(rowList(providers));
      };

      const rowList = (items) => {
        const box = el("div", "mdl-list mdl-scroll");
        for (const provider of items) {
          const line = el("div", "mdl-line");
          const copy = el("div", "mdl-line-copy");
          copy.append(el("strong", "", provider.name), el("small", "mdl-mono", provider.id));
          line.append(providerMark(provider), copy);
          if (provider.connected) line.append(el("span", "plug-pill ok", "Connected"));
          line.append(button(provider.connected ? "Reconnect" : "Connect", "ghost small-btn", () => openConnect(provider.id)));
          box.append(line);
        }
        return box;
      };

      input.addEventListener("input", () => { view.query = input.value; paint(); });
      paint();
      return wrap;
    }

    function serverRows(catalog) {
      const wrap = section("Other servers", "A model server on your own network or computer, such as LM Studio, Ollama or vLLM.");
      if (catalog.servers.length) {
        const box = el("div", "mdl-list");
        for (const server of catalog.servers) {
          const line = el("div", "mdl-line");
          const copy = el("div", "mdl-line-copy");
          const second = server.connected === false ? (server.error || "Not reachable") : count(Number(server.models) || 0, "model");
          copy.append(el("strong", "", server.name), el("small", server.connected === false ? "error-text" : "", second), el("small", "mdl-mono", server.baseUrl));
          const remove = button("Remove", "ghost small-btn", async () => {
            const yes = await ask({ kicker: "Models", title: `Remove ${server.name}?`, message: "Agents using this server will stop working until you add it again.", confirm: "Remove", danger: true });
            if (!yes) return;
            remove.disabled = true;
            try {
              await api(`/api/models/servers/${encodeURIComponent(server.id)}`, { method: "DELETE" });
              toast(`${server.name} removed.`);
              await refresh();
            } catch (error) {
              toast(error.message, "error");
              remove.disabled = false;
            }
          });
          line.append(providerMark(server), copy, remove);
          box.append(line);
        }
        wrap.append(box);
      }
      if (!view.serverForm) {
        wrap.append(button("Add server", "ghost mdl-add", () => { view.serverForm = true; draw(); }));
      } else {
        wrap.append(serverForm(catalog));
      }
      return wrap;
    }

    function serverForm(catalog) {
      const form = el("form", "mdl-form mdl-server-form");
      const mk = (label, type, placeholder, value = "") => {
        const wrap = el("label", "mdl-field");
        const input = document.createElement("input");
        input.type = type;
        input.placeholder = placeholder;
        input.value = value;
        input.autocomplete = "off";
        input.spellcheck = false;
        wrap.append(el("span", "", label), input);
        return { wrap, input };
      };
      const name = mk("Name", "text", "LM Studio");
      const addr = mk("Address", "text", "http://127.0.0.1:1234/v1");
      const key = mk("API key (optional)", "password", "Leave empty if it has none");
      const chips = el("div", "mdl-chips");
      form.append(chips, name.wrap, addr.wrap, key.wrap);
      const taken = new Set(catalog.servers.map((server) => server.baseUrl));
      getDiscover().then((servers) => {
        for (const server of servers.filter((item) => item.kind === "openai" && !taken.has(item.baseUrl))) {
          const chip = button(server.name || server.baseUrl, "plug-chip", () => {
            name.input.value = server.name || "";
            addr.input.value = server.baseUrl || "";
          });
          chip.title = server.baseUrl;
          chips.append(chip);
        }
        chips.hidden = !chips.children.length;
      });
      chips.hidden = true;
      const go = el("button", "primary", "Add server");
      go.type = "submit";
      const status = el("span", "error-text", "");
      const actions = el("div", "row");
      actions.append(go, button("Cancel", "ghost", () => { view.serverForm = false; draw(); }), status);
      form.append(actions);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!addr.input.value.trim()) { status.textContent = "Add the server address."; return; }
        go.disabled = true;
        go.textContent = "Testing…";
        status.textContent = "";
        try {
          const data = await api("/api/models/servers", { method: "POST", body: { name: name.input.value.trim(), baseUrl: addr.input.value.trim(), apiKey: key.input.value } });
          view.serverForm = false;
          toast(`${data.server?.name || "Server"} added.`);
          await refresh();
        } catch (error) {
          status.textContent = error.message;
          go.disabled = false;
          go.textContent = "Add server";
        }
      });
      return form;
    }

    function draw() {
      if (!root.isConnected) return;
      const scroll = document.getElementById("settings-body")?.scrollTop;
      const focusedSearch = document.activeElement?.closest?.(".mdl-search") ? document.activeElement : null;
      const caret = focusedSearch ? focusedSearch.selectionStart : null;
      root.replaceChildren();
      if (!store.catalog) {
        root.append(el("p", "hint", view.error || (view.loading ? "Loading providers…" : "No providers yet.")));
        if (view.error) root.append(button("Try again", "ghost small-btn", load));
        return;
      }
      const catalog = store.catalog;
      root.append(opencodeCard(catalog), connectedRows(catalog), addRows(catalog), serverRows(catalog));
      if (focusedSearch) {
        const again = root.querySelector(".mdl-search input");
        again?.focus();
        if (caret !== null) try { again.setSelectionRange(caret, caret); } catch { /* search fields may refuse */ } // eslint-disable-line
      }
      const body = document.getElementById("settings-body");
      if (body && scroll !== undefined) body.scrollTop = scroll;
    }

    async function load() {
      view.error = "";
      view.loading = true;
      draw();
      try {
        await getCatalog(true);
      } catch (error) {
        view.error = error.message;
      }
      view.loading = false;
      draw();
    }

    draw();
    load();
    return root;
  }

  // ---- The picker -----------------------------------------------------------------

  function picker({ value, onChange, placeholder = "Choose a model" } = {}) {
    let current = value && value.model ? { via: value.via || "opencode", model: value.model } : { via: "opencode", model: "" };
    const root = el("div", "mp");
    const trigger = el("button", "mp-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const label = el("span", "mp-label");
    const caret = el("span", "mp-caret", "▾");
    trigger.append(label, caret);
    root.append(trigger);

    const findModel = (list) => (list?.models || []).find((item) => item.id === current.model && (!current.via || item.via === current.via))
      || (list?.models || []).find((item) => item.id === current.model);

    const sync = () => {
      label.replaceChildren();
      if (!current.model) {
        label.append(el("span", "mp-empty", placeholder));
        return;
      }
      const hit = findModel(store.list);
      if (hit) {
        label.append(providerMark({ ...hit, name: hit.providerName || hit.provider }, "mdl-mark tiny"), el("span", "mp-name", hit.name || hit.id), el("span", "mp-prov", ` · ${hit.providerName || hit.provider || ""}`));
      } else {
        label.append(el("span", "mp-name", current.model));
        if (store.list) label.append(el("span", "mp-prov", " (not in the list)"));
      }
    };
    sync();
    store.pickers.add({ root, sync });
    if (!store.list) getList().then(sync).catch(() => {});

    // ---- The popover (desktop) or bottom sheet (phone)
    let pop = null;
    let scrim = null;
    let active = 0;
    let shown = [];
    let cancelHandler = null;
    let host = null;

    const setValue = (next) => {
      current = next && next.model ? { via: next.via || "opencode", model: next.model } : { via: "opencode", model: "" };
      sync();
    };

    const close = (refocus = true, escaped = false) => {
      if (!pop) return;
      pop.remove();
      scrim?.remove();
      pop = null;
      scrim = null;
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", outside, true);
      // Escape reaches the dialog's cancel event right after our keydown, so keep guarding for a moment.
      if (cancelHandler && host?.tagName === "DIALOG" && !escaped) host.removeEventListener("cancel", cancelHandler);
      else if (cancelHandler && host?.tagName === "DIALOG") {
        const guard = cancelHandler;
        const owner = host;
        // Some browsers close the dialog anyway; if that happens right now, open it again.
        const reopen = () => { if (!owner.open) owner.showModal(); };
        owner.addEventListener("close", reopen);
        setTimeout(() => {
          owner.removeEventListener("cancel", guard);
          owner.removeEventListener("close", reopen);
        }, 250);
      }
      cancelHandler = null;
      trigger.setAttribute("aria-expanded", "false");
      if (refocus) trigger.focus({ preventScroll: true });
    };

    const outside = (event) => {
      if (pop && !pop.contains(event.target) && !trigger.contains(event.target)) close(false);
    };

    const onScroll = (event) => { if (pop && !pop.contains(event.target) && !mobile()) place(); };

    function place() {
      if (!pop || mobile()) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(rect.width, 340);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const useAbove = below < 260 && above > below;
      const room = Math.max(200, Math.min(420, useAbove ? above : below));
      pop.style.left = `${left}px`;
      pop.style.width = `${width}px`;
      pop.style.maxHeight = `${room}px`;
      if (useAbove) { pop.style.top = ""; pop.style.bottom = `${window.innerHeight - rect.top + 6}px`; } else { pop.style.bottom = ""; pop.style.top = `${rect.bottom + 6}px`; }
    }

    function choose(model) {
      current = { via: model.via, model: model.id };
      sync();
      close();
      onChange?.({ ...current });
    }

    function open() {
      if (pop) { close(); return; }
      host = trigger.closest("dialog") || document.body;
      const phone = mobile();
      if (phone) {
        scrim = el("div", "mp-scrim");
        scrim.addEventListener("click", () => close());
        host.append(scrim);
      }
      pop = el("div", `mp-pop${phone ? " mp-sheet" : ""}`);
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", "Choose a model");
      if (phone) pop.append(el("div", "mp-grab"));
      const search = document.createElement("input");
      search.type = "search";
      search.className = "mp-search";
      search.placeholder = "Search models";
      search.autocomplete = "off";
      search.spellcheck = false;
      search.setAttribute("aria-label", "Search models");
      const list = el("div", "mp-list");
      list.setAttribute("role", "listbox");
      const foot = el("div", "mp-foot");
      const more = button("Connect another provider", "link-btn", () => {
        const dialog = trigger.closest("dialog");
        close(false);
        dialog?.close();
        if (typeof window.openSettingsPage === "function") window.openSettingsPage("models");
        else window.openSettingsView?.("models");
      });
      foot.append(more);
      pop.append(search, list, foot);
      host.append(pop);
      trigger.setAttribute("aria-expanded", "true");
      place();
      window.addEventListener("resize", place);
      document.addEventListener("scroll", onScroll, true);
      document.addEventListener("pointerdown", outside, true);
      if (host.tagName === "DIALOG") {
        cancelHandler = (event) => { event.preventDefault(); if (pop) close(true, true); };
        host.addEventListener("cancel", cancelHandler);
      }

      const paint = (all) => {
        const query = search.value.trim();
        const models = (all || []).filter((item) => !query || matches(`${item.name} ${item.id} ${item.providerName} ${item.provider}`, query));
        shown = models.slice(0, 400);
        list.replaceChildren();
        if (!all || !all.length) {
          const empty = el("div", "mp-none");
          empty.append(el("p", "", store.list ? "No models yet." : "Loading models…"));
          list.append(empty);
          return;
        }
        if (!shown.length) {
          list.append(el("div", "mp-none", "No model matches."));
          return;
        }
        const selectedAt = shown.findIndex((item) => item.id === current.model && item.via === current.via);
        if (active >= shown.length || active < 0) active = Math.max(0, selectedAt);
        let lastGroup = null;
        shown.forEach((model, index) => {
          const group = model.providerName || model.provider || "Other";
          if (group !== lastGroup) {
            const heading = el("div", "mp-group");
            heading.append(providerMark({ ...model, name: group }, "mdl-mark tiny"), el("span", "", group));
            list.append(heading);
            lastGroup = group;
          }
          const row = el("div", `mp-row${index === active ? " active" : ""}${model.id === current.model && model.via === current.via ? " chosen" : ""}`);
          row.setAttribute("role", "option");
          row.dataset.index = String(index);
          const top = el("div", "mp-row-top");
          top.append(el("strong", "", model.name || model.id));
          if (model.reasoning) top.append(el("span", "mp-tag", "reasoning"));
          const meta = [];
          if (model.context) meta.push(`${compact(model.context)} context`);
          const price = priceText(model.cost);
          if (price) meta.push(price);
          row.append(top, el("span", "mp-id", model.id));
          if (meta.length) row.append(el("small", "mp-meta", meta.join(" · ")));
          row.addEventListener("click", () => choose(model));
          row.addEventListener("pointermove", () => { if (active !== index) setActive(index, false); });
          list.append(row);
        });
      };

      const setActive = (index, scroll = true) => {
        active = index;
        for (const row of list.querySelectorAll(".mp-row")) row.classList.toggle("active", Number(row.dataset.index) === active);
        if (scroll) list.querySelector(`.mp-row[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
      };

      let all = store.list?.models || null;
      active = 0;
      paint(all);
      getList().then((data) => { all = data.models; if (pop) paint(all); }).catch(() => { if (pop) { list.replaceChildren(el("div", "mp-none", "Could not load the models.")); } });
      search.addEventListener("input", () => { active = 0; paint(all); });
      search.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); if (shown.length) setActive((active + 1) % shown.length); } else if (event.key === "ArrowUp") { event.preventDefault(); if (shown.length) setActive((active - 1 + shown.length) % shown.length); } else if (event.key === "Enter") { event.preventDefault(); if (shown[active]) choose(shown[active]); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true, true); }
      });
      pop.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true, true); } });
      if (!phone) setTimeout(() => search.focus(), 0);
    }

    trigger.addEventListener("click", open);

    Object.defineProperty(root, "value", {
      get: () => ({ ...current }),
      set: (next) => setValue(next),
    });
    return root;
  }

  function connect(providerId) {
    if (!providerId) return;
    openConnect(providerId);
  }

  window.RavnirModels = { renderPage, picker, refresh, connect, providerMark };
})();
