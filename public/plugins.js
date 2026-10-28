// The Plugins page: browse integrations, connect one in a tap or two, choose which agents get it.
// Loaded after app.js, so state, els, el, api, toast, timeAgo, paintCreature and copyText are global.
// The server side is server/plugins.js (API at /api/plugins, icons at /plugins/icons).

(() => {
  const PAGE = 60;
  // The generated catalog has many spellings of the same shelf. Fold them into a few.
  const SHELVES = [
    ["dev", "Developer tools", ["devops", "development", "developer-tools", "devtools", "code", "tools", "infrastructure", "documentation"]],
    ["productivity", "Productivity", ["productivity", "knowledge", "automation", "integration"]],
    ["data", "Data", ["database", "data-analytics", "analytics", "data-visualization", "monitoring"]],
    ["ai", "AI", ["ai", "ai-ml", "search"]],
    ["comms", "Communication", ["communication", "messaging", "support", "crm", "sales"]],
    ["money", "Money", ["finance", "fintech", "payments", "cost-management", "commerce", "ecommerce", "blockchain", "business"]],
    ["security", "Security", ["security"]],
    ["design", "Design and media", ["design", "media", "games", "web", "web-scraping", "news", "maps", "geospatial", "travel"]],
  ];
  const shelfOf = (category) => {
    const key = String(category || "").toLowerCase();
    return SHELVES.find((shelf) => shelf[2].includes(key))?.[0] || "other";
  };
  const SHELF_LABEL = { ...Object.fromEntries(SHELVES.map((shelf) => [shelf[0], shelf[1]])), other: "Other" };
  const TILES = ["#a8c9e8", "#b9cab2", "#e7c8ca", "#cbc3e6", "#e6e0d2", "#d9d2e9", "#cfe3df", "#ecd9c6"];

  const plug = {
    data: null,
    loading: false,
    error: "",
    query: "",
    shelf: "all",
    shown: PAGE,
    openId: "",
    busy: "",
    poll: null,
    pollUntil: 0,
    popup: null,
    popupFor: "",
    paste: {},
    seen: "",
    form: {},
    dialog: null,
  };
  state.plugins = plug;

  // ---- Data ------------------------------------------------------------------------------------------

  async function refresh({ quiet = false } = {}) {
    if (plug.loading) return;
    plug.loading = true;
    let text = "";
    try {
      const data = await api("/api/plugins");
      text = JSON.stringify(data);
      plug.data = data;
      plug.error = "";
    } catch (error) {
      plug.error = error.message;
      if (!quiet) toast(error.message, "error");
    } finally {
      plug.loading = false;
    }
    // The sign-in poll asks every few seconds; drawing the same page again made it flicker
    // and reset what was being typed in the dialog.
    const changed = !quiet || !text || text !== plug.seen;
    if (text) plug.seen = text;
    if (changed) {
      if (state.view === "plugins") renderPage();
      if (plug.openId) renderDialog();
    }
    managePolling();
  }

  const entry = (id) => plug.data?.plugins.find((item) => item.id === id) || null;

  // While a sign-in is open in another window (a phone opens Safari), look for the result.
  function managePolling() {
    const pending = plug.data?.plugins.some((item) => item.pending);
    if (!pending) {
      clearInterval(plug.poll);
      plug.poll = null;
      return;
    }
    if (plug.poll) return;
    plug.pollUntil = Date.now() + 10 * 60_000;
    plug.poll = setInterval(() => {
      if (Date.now() > plug.pollUntil) {
        clearInterval(plug.poll);
        plug.poll = null;
        return;
      }
      // The sign-in window was closed without finishing: drop it, so Connect works again.
      if (plug.popup?.closed && plug.popupFor && !plug.paste[plug.popupFor] && entry(plug.popupFor)?.pending) {
        const id = plug.popupFor;
        plug.popup = null;
        plug.popupFor = "";
        setTimeout(() => {
          if (entry(id)?.pending) cancelSignIn(id, { quiet: true });
        }, 2500);
      }
      refresh({ quiet: true });
    }, 2000);
  }

  async function cancelSignIn(id, { quiet = false } = {}) {
    try {
      await api(`/api/plugins/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
    } catch (error) {
      if (!quiet) toast(error.message, "error");
    }
    if (plug.popupFor === id) {
      plug.popup?.close?.();
      plug.popup = null;
      plug.popupFor = "";
    }
    await refresh();
    if (quiet) toast("The sign-in window was closed. Press Sign in to try again.");
  }

  function listenForSignIn() {
    const done = (message) => {
      if (message?.type !== "ravnir-plugin") return;
      refresh({ quiet: true }).then(() => {
        const item = entry(message.id);
        if (message.ok && item) toast(`${item.name} is connected.`);
      });
    };
    window.addEventListener("message", (event) => {
      if (event.origin === location.origin) done(event.data);
    });
    try {
      new BroadcastChannel("ravnir-plugins").addEventListener("message", (event) => done(event.data));
    } catch {
      // The poll covers browsers without it.
    }
  }

  // ---- Small pieces ------------------------------------------------------------------------------------

  function tile(item, size = "") {
    const box = el("span", `plug-icon${size ? ` ${size}` : ""}`);
    const letter = () => {
      box.replaceChildren(el("b", "", (item.name || "?").trim().charAt(0).toUpperCase()));
      let hash = 0;
      for (const char of item.id || item.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      box.style.background = TILES[hash % TILES.length];
    };
    if (item.icon) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = item.icon;
      img.addEventListener("error", letter, { once: true });
      box.append(img);
    } else {
      letter();
    }
    return box;
  }

  // What the card pill says: Connected, Reconnect, Connect, Needs setup, or why it is unavailable.
  function pill(item) {
    if (item.connected) return item.status === "connected" ? ["Connected", "ok"] : item.status === "expired" ? ["Reconnect", "warn"] : ["Check", "warn"];
    if (item.unreachable) return ["Unavailable", "dim"];
    if (item.comingSoon) return ["Soon", "dim"];
    if (item.pending) return ["Signing in", "warn"];
    if (["oauth-manual", "oauth-cimd", "token", "secrets"].includes(item.auth)) return ["Needs setup", "setup"];
    if (onServer(item) && (item.inputFields || []).some((field) => field.required)) return ["Needs setup", "setup"];
    return ["Connect", "go"];
  }

  const dimmed = (item) => Boolean(item.comingSoon || item.unreachable);
  // Containers and Ravnir's own plugins both run on this server and take keys in a form.
  const onServer = (item) => item.kind === "container" || item.kind === "local";

  function card(item, { compact = false } = {}) {
    const node = el("button", `plug-card${compact ? " compact" : ""}${dimmed(item) ? " dim" : ""}`);
    node.type = "button";
    node.dataset.id = item.id;
    const copy = el("span", "plug-copy");
    copy.append(el("span", "plug-name", item.name));
    copy.append(el("span", "plug-desc", dimmed(item) ? (item.unreachable ? "Not reachable right now" : "Coming soon") : item.description));
    const [label, tone] = pill(item);
    node.append(tile(item), copy, el("span", `plug-pill ${tone}`, label));
    node.addEventListener("click", () => openDetail(item.id));
    return node;
  }

  function visible() {
    const items = plug.data?.plugins || [];
    const words = plug.query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      if (plug.shelf === "connected" && !item.connected) return false;
      if (plug.shelf !== "all" && plug.shelf !== "connected" && shelfOf(item.category) !== plug.shelf) return false;
      if (!words.length) return true;
      const text = `${item.name} ${item.description} ${item.category} ${(item.tags || []).join(" ")}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  function order(items) {
    const rank = (item) => (item.connected ? 0 : dimmed(item) ? 2 : 1);
    return [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  // ---- The page --------------------------------------------------------------------------------------------

  function renderPage() {
    const body = $("plugins-body");
    if (!body) return;
    const data = plug.data;
    const keepSearch = document.activeElement?.id === "plug-search";
    body.replaceChildren();

    const search = el("div", "plug-search");
    search.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.2"></circle><path d="M12.5 12.5 17 17"></path></svg>';
    const input = document.createElement("input");
    input.id = "plug-search";
    input.type = "search";
    input.placeholder = "Search plugins";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = plug.query;
    input.setAttribute("aria-label", "Search plugins");
    input.addEventListener("input", () => {
      plug.query = input.value;
      plug.shown = PAGE;
      renderPage();
    });
    search.append(input);
    body.append(search);

    if (!data) {
      body.append(el("p", "hint", plug.error || "Loading plugins…"));
      return;
    }
    if (data.hint) body.append(el("p", "plug-note", data.hint));
    if (data.hiddenCount && !data.runtime.available) {
      body.append(el("p", "plug-note", `${data.hiddenCount} more plugins run in a container. Install Podman or Docker on this server to show them.`));
    }

    // Shelves: the ones that have plugins, biggest first.
    const counts = new Map();
    for (const item of data.plugins) counts.set(shelfOf(item.category), (counts.get(shelfOf(item.category)) || 0) + 1);
    const connected = data.plugins.filter((item) => item.connected).length;
    const chips = el("div", "plug-chips");
    chips.setAttribute("role", "tablist");
    const addChip = (id, label) => {
      const chip = el("button", `plug-chip${plug.shelf === id ? " on" : ""}`, label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        plug.shelf = id;
        plug.shown = PAGE;
        renderPage();
      });
      chips.append(chip);
    };
    addChip("all", "All");
    if (connected) addChip("connected", `Connected ${connected}`);
    const shelves = [...counts.entries()].sort((a, b) => (a[0] === "other") - (b[0] === "other") || b[1] - a[1]);
    for (const [id] of shelves) addChip(id, SHELF_LABEL[id] || id);
    body.append(chips);

    const items = visible();
    const browsing = !plug.query.trim() && plug.shelf === "all";
    if (browsing) {
      const popular = data.plugins.filter((item) => item.featured && !dimmed(item));
      if (popular.length) {
        const section = el("section", "plug-section");
        section.append(el("h2", "plug-title", "Popular"));
        const row = el("div", "plug-row");
        for (const item of popular) row.append(card(item, { compact: true }));
        section.append(row);
        body.append(section);
      }
    }

    const section = el("section", "plug-section");
    section.append(el("h2", "plug-title", browsing ? "All plugins" : items.length ? `${items.length} found` : "Nothing found"));
    if (!items.length) {
      section.append(el("p", "hint", plug.query ? `No plugin matches "${plug.query}".` : "Nothing here yet."));
    } else {
      const grid = el("div", "plug-grid");
      const sorted = order(items);
      for (const item of sorted.slice(0, plug.shown)) grid.append(card(item));
      section.append(grid);
      if (sorted.length > plug.shown) {
        const more = el("button", "ghost plug-more", `Show ${Math.min(PAGE, sorted.length - plug.shown)} more`);
        more.type = "button";
        more.addEventListener("click", () => {
          plug.shown += PAGE;
          renderPage();
        });
        section.append(more);
      }
    }
    body.append(section);
    if (keepSearch) {
      const field = $("plug-search");
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  window.openPluginsPage = async (id = "") => {
    renderPage();
    await refresh();
    if (id && entry(id)) openDetail(id);
  };

  // ---- The sheet for one plugin -------------------------------------------------------------------------------

  function ensureDialog() {
    if (plug.dialog) return plug.dialog;
    const dialog = document.createElement("dialog");
    dialog.className = "dialog plug-dialog";
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      plug.openId = "";
      plug.form = {};
    });
    document.body.append(dialog);
    plug.dialog = dialog;
    return dialog;
  }

  function openDetail(id) {
    const item = entry(id);
    if (!item) return;
    plug.openId = id;
    plug.form = {};
    const dialog = ensureDialog();
    renderDialog();
    if (!dialog.open) dialog.showModal();
  }

  function howItConnects(item) {
    if (item.comingSoon) return item.comingSoon;
    if (item.unreachable) return `${item.name} does not answer right now. It will show up here again when it does.`;
    switch (item.auth) {
      case "oauth-dcr": return plug.paste[item.id] || item.paste
        ? `You sign in with ${item.name} in a new window, then paste back the address it ends on.`
        : `You sign in with ${item.name} in a new window. Ravnir registers itself there, so there is nothing to copy.`;
      case "oauth-manual":
      case "oauth-cimd": return `Paste the client ID and secret from your ${item.name} developer settings, then sign in.`;
      case "token": return item.tokenHelp || `Paste an access token from your ${item.name} settings. It is stored encrypted on the server.`;
      case "open": return "No sign-in needed. This server is public.";
      // A container plugin falls through to the default line.
      case "secrets": if (item.kind === "local") return item.tokenHelp || "Runs inside Ravnir on this server. Keys are stored encrypted and never reach the model.";
      default: return `Runs in a container on this server${item.image ? ` (${item.image})` : ""}. Keys are stored encrypted and never reach the model.`;
    }
  }

  function field(label, input, hint = "") {
    const wrap = el("label", "plug-field");
    wrap.append(el("span", "", label), input);
    if (hint) wrap.append(el("small", "hint", hint));
    return wrap;
  }

  function textInput(key, { password = false, placeholder = "" } = {}) {
    const input = document.createElement("input");
    input.type = password ? "password" : "text";
    input.autocomplete = password ? "new-password" : "off";
    input.spellcheck = false;
    input.placeholder = placeholder;
    input.value = plug.form[key] || "";
    input.addEventListener("input", () => { plug.form[key] = input.value; });
    return input;
  }

  function linkified(text) {
    const p = el("p", "plug-how");
    let last = 0;
    for (const match of String(text).matchAll(/https?:\/\/[^\s)]+/g)) {
      p.append(document.createTextNode(text.slice(last, match.index)));
      const a = document.createElement("a");
      a.href = match[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[0].replace(/^https?:\/\//, "").replace(/[.,]$/, "");
      p.append(a);
      last = match.index + match[0].length;
    }
    p.append(document.createTextNode(text.slice(last)));
    return p;
  }

  function renderDialog() {
    const item = entry(plug.openId);
    const dialog = plug.dialog;
    if (!item || !dialog) return;
    const active = document.activeElement;
    const focusedKey = active?.closest?.("dialog") === dialog ? active.dataset?.key : "";
    const card = el("div", "dialog-card");
    const head = el("header", "dialog-head plug-head");
    const title = el("div", "plug-head-copy");
    title.append(tile(item, "lg"));
    const names = el("div", "");
    const kicker = `${SHELF_LABEL[shelfOf(item.category)] || "Plugin"} · ${onServer(item) ? "Runs on this server" : item.host || "Remote"}`;
    names.append(el("p", "kicker", kicker), el("h2", "", item.name));
    title.append(names);
    const close = el("button", "icon-btn", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => dialog.close());
    head.append(title, close);

    const body = el("div", "dialog-body plug-body");
    if (item.description) body.append(el("p", "plug-desc-full", item.description));
    if (item.homepage) {
      const link = document.createElement("a");
      link.href = item.homepage;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "plug-site";
      link.textContent = item.homepage.replace(/^https?:\/\//, "").replace(/\/$/, "");
      body.append(link);
    }

    const foot = el("footer", "dialog-foot plug-foot");
    const message = el("span", "error-text plug-error", plug.busyError || "");
    const actions = el("div", "row");
    foot.append(message, actions);

    if (item.connected) renderConnected(item, body, actions);
    else renderConnect(item, body, actions);
    card.append(head, body, foot);
    dialog.replaceChildren(card);
    if (focusedKey) dialog.querySelector(`[data-key="${focusedKey}"]`)?.focus();
  }

  function button(label, className, onClick) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function renderConnect(item, body, actions) {
    const how = el("div", "plug-block");
    how.append(el("p", "plug-block-title", "How it connects"));
    how.append(item.auth === "token" ? linkified(howItConnects(item)) : el("p", "plug-how", howItConnects(item)));
    body.append(how);

    const blocked = item.comingSoon || item.unreachable;
    if (!blocked) {
      const form = el("div", "plug-form");
      if (item.auth === "oauth-manual" || item.auth === "oauth-cimd") {
        const redirect = document.createElement("input");
        redirect.readOnly = true;
        // The address this browser is on: the sign-in comes back here (see redirectBase on the server).
        const redirectUri = `${location.origin}/plugins/oauth/callback`;
        redirect.value = redirectUri;
        redirect.className = "mono";
        const copyRow = el("div", "plug-copy-row");
        copyRow.append(redirect, button("Copy", "ghost", () => copyText(redirectUri, "Redirect address copied.")));
        const wrap = el("label", "plug-field");
        wrap.append(el("span", "", "Redirect address"), copyRow, el("small", "hint", `Add this exact address to your ${item.name} app first.`));
        form.append(wrap, field("Client ID", textInput("clientId")), field("Client secret", textInput("clientSecret", { password: true }), "Leave empty if the service gave you only an ID."));
        form.querySelectorAll("input").forEach((input, index) => { if (index) input.dataset.key = index === 1 ? "clientId" : "clientSecret"; });
      } else if (item.auth === "token") {
        const input = textInput("token", { password: true, placeholder: "Paste the token" });
        input.dataset.key = "token";
        form.append(field("Access token", input));
      } else if (onServer(item)) {
        for (const secret of item.secretFields) {
          const input = textInput(`secret:${secret.key}`, { password: true, placeholder: secret.example || "" });
          input.dataset.key = `secret:${secret.key}`;
          form.append(field(secret.label, input, secret.description));
        }
        for (const setting of item.inputFields) {
          const input = textInput(`env:${setting.key}`);
          input.dataset.key = `env:${setting.key}`;
          form.append(field(`${setting.label}${setting.required ? "" : " (optional)"}`, input, setting.description));
        }
      }
      if (form.children.length) body.append(form);
      if (item.needsRuntime) body.append(el("p", "plug-note", "This plugin needs Podman or Docker on the server."));
    }

    const label = item.pending ? "Sign in again" : item.auth.startsWith("oauth") ? "Sign in and connect" : "Connect";
    const connect = button(plug.busy === item.id ? "Connecting…" : label, "primary", () => connectNow(item));
    connect.disabled = Boolean(blocked || plug.busy === item.id || item.needsRuntime);
    if (blocked) connect.textContent = item.comingSoon ? "Coming soon" : "Not reachable";
    actions.append(button("Close", "ghost", () => plug.dialog.close()), connect);
    if (item.pending && (plug.paste[item.id] || item.paste)) body.append(pasteField(item));
    else if (item.pending) {
      body.append(el("p", "plug-note", "Waiting for you to finish signing in. If that window is gone, cancel or sign in again."));
    }
    if (item.pending) {
      actions.prepend(button("Cancel sign-in", "ghost", () => cancelSignIn(item.id)));
    }
  }

  function renderConnected(item, body, actions) {
    const status = el("div", "plug-block");
    const line = el("div", "plug-status");
    const [label, tone] = pill(item);
    line.append(el("span", `plug-pill ${tone}`, label));
    const who = [item.account, item.connectedAt ? `connected ${timeAgo(item.connectedAt)}` : ""].filter(Boolean).join(" · ");
    if (who) line.append(el("span", "plug-who", who));
    status.append(line);
    if (item.status !== "connected" && item.error) status.append(el("p", "error-text", item.error));
    if (item.status === "expired") status.append(button(plug.busy === item.id ? "Opening…" : "Reconnect", "primary", () => connectNow(item, { reconnect: true })));
    body.append(status);

    const agents = el("div", "plug-block");
    agents.append(el("p", "plug-block-title", "Agents that can use it"));
    agents.append(el("p", "hint", "Each one gets this plugin's tools on its next message. Anything that changes something asks you first, unless you allow it in the agent's settings."));
    const list = el("div", "plug-agents");
    const results = plug.agentStatus?.[item.id] || {};
    for (const bot of state.bots) {
      const row = el("label", "plug-agent");
      const face = el("span", "avatar");
      paintCreature(face, bot);
      const copy = el("span", "plug-agent-copy");
      copy.append(el("span", "plug-agent-name", bot.name));
      const info = results[bot.id];
      if (info?.error) copy.append(el("small", "error-text", info.error));
      else if (item.bots.includes(bot.id)) copy.append(el("small", "hint", info ? `${info.tools} tools` : item.toolCount ? `${item.toolCount} tools` : "Ready"));
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "plug-switch";
      toggle.checked = item.bots.includes(bot.id);
      toggle.disabled = plug.busy === item.id;
      toggle.setAttribute("aria-label", `${bot.name} can use ${item.name}`);
      toggle.addEventListener("change", () => {
        const next = new Set(item.bots);
        if (toggle.checked) next.add(bot.id);
        else next.delete(bot.id);
        setAgents(item, [...next]);
      });
      row.append(face, copy, toggle);
      list.append(row);
    }
    if (!state.bots.length) list.append(el("p", "hint", "Create an agent first."));
    agents.append(list);
    body.append(agents);

    const tools = plug.testResult?.[item.id] || null;
    if (tools || item.toolCount) {
      const block = el("div", "plug-block");
      const names = (tools?.tools || item.tools || []).map((tool) => tool.name);
      block.append(el("p", "plug-block-title", tools?.ok === false ? "Test failed" : `${names.length} tools`));
      if (tools?.ok === false) block.append(el("p", "error-text", tools.error || "The test failed."));
      else block.append(el("p", "plug-tools mono", names.slice(0, 40).join(", ") + (names.length > 40 ? ", …" : "")));
      body.append(block);
    }

    actions.append(
      button("Disconnect", "ghost danger-text", () => disconnectNow(item)),
      button(plug.busy === `${item.id}:test` ? "Testing…" : "Test", "ghost", () => testNow(item)),
      button("Done", "primary", () => plug.dialog.close()),
    );
  }

  // ---- Actions ----------------------------------------------------------------------------------------------------

  function setBusy(value, error = "") {
    plug.busy = value;
    plug.busyError = error;
    if (plug.openId) renderDialog();
  }

  async function connectNow(item, { reconnect = false } = {}) {
    const body = {};
    if (item.auth === "token") body.token = (plug.form.token || "").trim();
    if (item.auth === "oauth-manual" || item.auth === "oauth-cimd") {
      body.clientId = (plug.form.clientId || "").trim();
      body.clientSecret = (plug.form.clientSecret || "").trim();
    }
    if (onServer(item)) {
      body.secrets = {};
      body.env = {};
      for (const [key, value] of Object.entries(plug.form)) {
        if (key.startsWith("secret:")) body.secrets[key.slice(7)] = value.trim();
        else if (key.startsWith("env:")) body.env[key.slice(4)] = value.trim();
      }
    }
    const oauth = item.auth.startsWith("oauth");
    // A popup has to open inside the tap, so it opens empty now and goes to the service when the server answers.
    // Not for a service that returns to the user's own computer: that sign-in opens from a link (see pasteField).
    const popup = oauth && !item.paste ? window.open("about:blank", "ravnir-plugin-auth", "popup,width=520,height=760") : null;
    setBusy(item.id);
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(item.id)}/connect`, { method: "POST", body });
      if (result.authorizeUrl && result.paste) {
        // The app stays here with the paste box; the sign-in opens in the real browser, which has an
        // address bar to copy from (the home-screen app has none, and taking over its window lost the way back).
        popup?.close();
        plug.paste[item.id] = result.authorizeUrl;
        plug.busy = "";
        await refresh();
        return;
      }
      if (result.authorizeUrl) {
        delete plug.paste[item.id];
        if (popup && !popup.closed) {
          popup.location.href = result.authorizeUrl;
          plug.popup = popup;
          plug.popupFor = item.id;
        } else window.location.href = result.authorizeUrl;
        plug.busy = "";
        await refresh();
        toast(popup ? "Finish signing in in the new window." : "Opening the sign-in…");
        return;
      }
      setBusy("");
      await refresh({ quiet: true });
      const names = (result.connection?.bots || []).map((id) => state.bots.find((bot) => bot.id === id)?.name).filter(Boolean);
      toast(names.length ? `${item.name} is connected for ${names.join(", ")}.` : `${item.name} is connected. Choose which agents get it.`);
    } catch (error) {
      popup?.close();
      setBusy("", error.message);
    }
  }

  // Services that only return to the user's own computer (Vercel): the browser ends on a page that
  // does not load, and its address carries the sign-in.
  function pasteField(item) {
    const wrap = el("div", "plug-form");
    wrap.append(el("p", "plug-note", `${item.name} only sends the sign-in back to your own computer. Open the sign-in in your browser and approve. It ends on a page that cannot open: copy that page's address from the address bar and paste it here.`));
    const link = plug.paste[item.id];
    if (typeof link === "string" && link) {
      const open = document.createElement("a");
      open.className = "button primary plug-open-signin";
      open.href = link;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = `Open ${item.name} sign-in`;
      wrap.append(open);
    } else {
      wrap.append(el("p", "plug-note", "The sign-in link is gone (the page was reloaded). Press Sign in again for a new one."));
    }
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = "http://127.0.0.1:3847/plugins/oauth/callback?code=…";
    input.className = "mono";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = plug.form.pasteUrl || "";
    input.addEventListener("input", () => { plug.form.pasteUrl = input.value; });
    const finish = button("Finish", "primary", async () => {
      setBusy(item.id);
      try {
        await api(`/api/plugins/${encodeURIComponent(item.id)}/finish`, { method: "POST", body: { url: input.value } });
        delete plug.paste[item.id];
        plug.form.pasteUrl = "";
        plug.popup?.close?.();
        setBusy("");
        await refresh();
        toast(`${item.name} is connected. Choose which agents get it.`);
      } catch (error) {
        setBusy("", error.message);
        await refresh();
      }
    });
    const row = el("div", "plug-copy-row");
    row.append(input, finish);
    const label = el("label", "plug-field");
    label.append(el("span", "", "Address of the page that did not load"), row);
    wrap.append(label);
    return wrap;
  }

  async function setAgents(item, ids) {
    setBusy(item.id);
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(item.id)}/bots`, { method: "PUT", body: { bots: ids } });
      plug.agentStatus ||= {};
      plug.agentStatus[item.id] = Object.fromEntries(result.agents.map((agent) => [agent.id, agent]));
      setBusy("");
      await refresh({ quiet: true });
      if (typeof reloadBot === "function" && state.bot) reloadBot().catch(() => {});
      const failed = result.agents.find((agent) => agent.error);
      if (failed) toast(`${item.name}: ${failed.error}`, "error");
    } catch (error) {
      setBusy("", error.message);
      await refresh({ quiet: true });
    }
  }

  async function testNow(item) {
    setBusy(`${item.id}:test`);
    try {
      plug.testResult ||= {};
      plug.testResult[item.id] = await api(`/api/plugins/${encodeURIComponent(item.id)}/test`, { method: "POST", body: {} });
      setBusy("");
      await refresh({ quiet: true });
    } catch (error) {
      setBusy("", error.message);
    }
  }

  async function disconnectNow(item) {
    if (!window.confirm(`Disconnect ${item.name}? Every agent loses it and the saved sign-in is deleted.`)) return;
    setBusy(item.id);
    try {
      await api(`/api/plugins/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      toast(`${item.name} is disconnected.`);
      setBusy("");
      plug.dialog.close();
      await refresh({ quiet: true });
    } catch (error) {
      setBusy("", error.message);
    }
  }

  listenForSignIn();
})();
