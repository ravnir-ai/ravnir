// Shell tab: a live terminal (xterm.js over a WebSocket) on the bot's computer,
// and the switch to the bot's own computer when the server has that turned on.
// Loaded after app.js, so state, els, api, toast and reloadBot are global.
// The shell is shared: every tab and device with the Shell open sees the same one.

(() => {
  const host = document.getElementById("term");
  const status = document.getElementById("term-state");
  const card = {
    root: document.getElementById("box-card"),
    title: document.getElementById("box-title"),
    detail: document.getElementById("box-detail"),
    reset: document.getElementById("box-reset"),
    swap: document.getElementById("box-switch"),
  };
  const KEYS = { esc: "\x1b", tab: "\t", "ctrl-c": "\x03", "ctrl-d": "\x04", up: "\x1b[A", down: "\x1b[B" };
  const BOX_STATES = {
    running: "Running.",
    starting: "Starting. The first start builds the computer and can take a few minutes.",
    exited: "Stopped. It starts again with the next command or terminal.",
    missing: "Created on first use.",
    created: "Created, not started yet.",
    paused: "Paused.",
  };

  const term = {
    loading: null,
    xterm: null,
    fit: null,
    socket: null,
    botId: "",
    open: false,
    ended: false,
    retries: 0,
    retryTimer: 0,
    fitTimer: 0,
    box: null,
    boxTimer: 0,
  };

  document.getElementById("term-reconnect").addEventListener("click", () => {
    term.retries = 0;
    if (state.bot) connect(state.bot.id);
  });
  document.getElementById("term-keys").addEventListener("click", (event) => {
    const key = event.target.closest("button")?.dataset.key;
    if (!key) return;
    send({ t: "in", d: KEYS[key] });
    term.xterm?.focus();
  });
  card.swap.addEventListener("click", switchComputer);
  card.reset.addEventListener("click", resetComputer);

  // Called by showPanel when the Shell tab opens.
  async function open(bot) {
    render(bot);
    if (!bot) return;
    term.open = true;
    try {
      await loadLibrary();
    } catch (error) {
      fallback(`${error.message} Use "Run one command" below.`);
      return;
    }
    mountXterm();
    fitSoon();
    if (term.botId !== bot.id || !term.socket) connect(bot.id);
  }

  // Called whenever the selected bot renders.
  function render(bot) {
    renderBox(bot);
    if (!bot) {
      disconnect();
      return;
    }
    if (term.botId && term.botId !== bot.id) {
      disconnect();
      term.xterm?.reset();
      if (term.open && state.panel === "shell") connect(bot.id);
    }
  }

  function loadLibrary() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    term.loading ||= Promise.all([loadScript("/vendor/xterm.js"), loadStyle("/vendor/xterm.css")])
      .then(() => loadScript("/vendor/addon-fit.js"))
      .then(() => {
        if (!window.Terminal || !window.FitAddon) throw new Error("The terminal could not load.");
      })
      .catch((error) => {
        term.loading = null;
        throw error;
      });
    return term.loading;
  }

  function mountXterm() {
    if (term.xterm) return;
    host.classList.remove("fallback");
    // The fit addon measures the parent's CSS width, padding included, so xterm
    // gets a padding-free parent of its own.
    const mount = document.createElement("div");
    mount.className = "term-mount";
    host.replaceChildren(mount);
    const xterm = new window.Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: { background: "#1d1d1f", foreground: "#f5f5f7", cursor: "#f5f5f7", selectionBackground: "#48484a" },
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open(mount);
    xterm.onData((data) => send({ t: "in", d: data }));
    xterm.onResize(({ cols, rows }) => send({ t: "resize", cols, rows }));
    new ResizeObserver(fitSoon).observe(host);
    term.xterm = xterm;
    term.fit = fit;
  }

  function fitSoon() {
    clearTimeout(term.fitTimer);
    term.fitTimer = setTimeout(() => {
      // A hidden panel has no size; fitting it would shrink the shell to nothing.
      if (!term.fit || !host.offsetWidth || !host.offsetHeight) return;
      try {
        term.fit.fit();
      } catch {
        // Ignore a fit during layout.
      }
    }, 60);
  }

  function connect(botId) {
    if (!term.xterm) return;
    disconnect();
    clearTimeout(term.retryTimer);
    term.botId = botId;
    term.ended = false;
    term.xterm.reset();
    fitSoon();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const query = `cols=${term.xterm.cols}&rows=${term.xterm.rows}`;
    const socket = new WebSocket(`${scheme}://${location.host}/api/bots/${encodeURIComponent(botId)}/terminal/ws?${query}`);
    term.socket = socket;
    setStatus("Connecting", "busy");
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      receive(message);
    };
    socket.onclose = () => {
      if (term.socket !== socket) return;
      term.socket = null;
      if (term.ended) return;
      setStatus("Offline");
      if (term.open && term.botId === botId && term.retries < 6) {
        const wait = Math.min(15_000, 1000 * 2 ** term.retries);
        term.retries += 1;
        term.retryTimer = setTimeout(() => {
          if (state.bot?.id === botId) connect(botId);
        }, wait);
      }
    };
  }

  function receive(message) {
    const xterm = term.xterm;
    if (message.t === "out") xterm.write(message.d);
    else if (message.t === "ready") {
      term.retries = 0;
      setStatus("Live", "live");
      status.title = message.label || "";
      if (message.label) xterm.write(`\x1b[2m${message.label}\x1b[0m\r\n`);
      if (state.bot?.box?.mode === "container") refreshBox();
    } else if (message.t === "status") {
      setStatus("Starting", "busy");
      xterm.write(`\x1b[2m${message.message}\x1b[0m\r\n`);
    } else if (message.t === "exit") {
      term.ended = true;
      setStatus("Ended");
      xterm.write(`\r\n\x1b[2mThe shell ended (exit ${message.code}). Press Reconnect for a new one.\x1b[0m\r\n`);
    } else if (message.t === "error") {
      term.ended = true;
      setStatus("Offline");
      xterm.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
    }
  }

  function send(message) {
    if (term.socket?.readyState === WebSocket.OPEN) term.socket.send(JSON.stringify(message));
  }

  function disconnect() {
    clearTimeout(term.retryTimer);
    const socket = term.socket;
    term.socket = null;
    if (socket) socket.close();
    setStatus("Offline");
  }

  function setStatus(text, kind = "") {
    status.textContent = text;
    status.className = `term-state${kind ? ` ${kind}` : ""}`;
  }

  function fallback(text) {
    host.classList.add("fallback");
    host.textContent = text;
    setStatus("Offline");
  }

  function renderBox(bot) {
    const enabled = Boolean(state.server?.box?.enabled);
    card.root.hidden = !enabled || !bot;
    clearTimeout(term.boxTimer);
    if (card.root.hidden) return;
    const own = bot.box?.mode === "container";
    card.title.textContent = own ? "Its own computer" : "This server";
    card.swap.textContent = own ? "Use this server" : "Use its own computer";
    card.reset.hidden = !own;
    if (!own) {
      card.detail.textContent = "Runs as the Ravnir user, without root.";
      return;
    }
    card.detail.textContent = describeBox(term.box?.name && term.botId === bot.id ? term.box : null);
    if (state.panel === "shell") refreshBox();
  }

  async function refreshBox() {
    const bot = state.bot;
    if (!bot || bot.box?.mode !== "container") return;
    clearTimeout(term.boxTimer);
    try {
      term.box = await api(`/api/bots/${bot.id}/box`);
    } catch (error) {
      card.detail.textContent = error.message;
      return;
    }
    if (state.bot?.id !== bot.id) return;
    card.detail.textContent = describeBox(term.box);
    if (term.box.state === "starting" && state.panel === "shell") term.boxTimer = setTimeout(refreshBox, 3000);
  }

  function describeBox(info) {
    if (!info) return "Ubuntu 24.04, root.";
    if (info.error) return `It did not start: ${info.error}`;
    const limits = info.limits ? ` ${info.limits.memory} memory, ${info.limits.cpus} CPUs.` : "";
    return `Ubuntu 24.04, root. ${BOX_STATES[info.state] || info.state}${info.state === "running" ? limits : ""}`;
  }

  async function switchComputer() {
    const bot = state.bot;
    if (!bot) return;
    const toBox = bot.box?.mode !== "container";
    const question = toBox
      ? `Give ${bot.name} its own Linux computer? Its commands, terminal, desktop and browser move into a container where it is root. Its files and signed-in sessions come along.`
      : `Move ${bot.name} back to this server? Its own computer stays on disk and can be used again later.`;
    if (!confirm(question)) return;
    card.swap.disabled = true;
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { box: { mode: toBox ? "container" : "host" } } });
      if (toBox) await api(`/api/bots/${bot.id}/box`, { method: "POST", body: { action: "start" } });
      term.box = null;
      disconnect();
      await reloadBot();
      if (term.open && state.bot?.id === bot.id) connect(bot.id);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      card.swap.disabled = false;
    }
  }

  async function resetComputer() {
    const bot = state.bot;
    if (!bot) return;
    if (!confirm(`Reset ${bot.name}'s computer? System packages it installed are removed. /root, the workspace and signed-in sessions stay.`)) return;
    card.reset.disabled = true;
    try {
      disconnect();
      term.box = await api(`/api/bots/${bot.id}/box`, { method: "POST", body: { action: "reset" } });
      card.detail.textContent = describeBox(term.box);
      if (term.open) connect(bot.id);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      card.reset.disabled = false;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error("The terminal could not load."));
      document.head.append(script);
    });
  }

  function loadStyle(href) {
    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error("The terminal could not load."));
      document.head.append(link);
    });
  }

  window.RavnirTerminal = { open, render };
})();
