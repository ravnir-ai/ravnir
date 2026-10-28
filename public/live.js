// Take control: a full-window live view of a bot's real screen, from the Mac or the
// iPhone home-screen app. noVNC draws the screen; the server (server/live.js) bridges
// it to the bot's X display. "Sign in yourself" hands the user a plain browser with
// no automation, for sites that block the agent's browser at sign-in.
// Loaded after app.js, so state, api and toast are global.

(() => {
  const SPECIAL = {
    Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
    Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
    PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  };
  const ICON = {
    keyboard: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="15" height="10" rx="2"/><path d="M5.5 8.2h.1M8.5 8.2h.1M11.5 8.2h.1M14.5 8.2h.1M6 11.8h8"/></svg>',
    paste: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="4" width="11" height="13" rx="2"/><path d="M7.5 4V3.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M7.5 9h5M7.5 12h5"/></svg>',
  };

  const live = {
    open: false,
    botId: "",
    botName: "",
    mode: "watch",
    url: "",
    rfb: null,
    RFB: null,
    retries: 0,
    retryTimer: 0,
    closing: false,
    busy: false,
    keyboard: false,
    token: 0,
  };
  const touch = window.matchMedia("(pointer: coarse)").matches;
  let ui = null;

  function build() {
    const sheet = document.createElement("div");
    sheet.id = "live-sheet";
    sheet.className = "live-sheet";
    sheet.hidden = true;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Live view");
    sheet.innerHTML = `
      <header class="live-head">
        <div class="live-title">
          <strong id="live-name"></strong>
          <span id="live-status" class="live-status" aria-live="polite"></span>
        </div>
        <button id="live-retry" type="button" class="live-pill" hidden>Reconnect</button>
        <button id="live-close" type="button" class="live-pill" aria-label="Close the live view">Close</button>
      </header>
      <div id="live-banner" class="live-banner" hidden></div>
      <div class="live-stage">
        <div id="live-screen" class="live-screen"></div>
        <div id="live-error" class="live-error" hidden>
          <p id="live-error-text"></p>
          <button id="live-error-retry" type="button" class="live-btn">Try again</button>
        </div>
        <div id="live-result" class="live-result" hidden>
          <div class="live-result-card">
            <strong>The agent has its browser back</strong>
            <p class="hint">This is what it sees now. You are still signed in there.</p>
            <img id="live-result-img" alt="The agent's browser after you handed it back" />
            <button id="live-result-close" type="button" class="live-btn live-primary">Close</button>
          </div>
        </div>
      </div>
      <div id="live-keys" class="live-keys" hidden>
        <button type="button" data-key="Escape">Esc</button>
        <button type="button" data-key="Tab">Tab</button>
        <button type="button" data-key="Enter">Enter</button>
        <button type="button" data-key="ArrowLeft" aria-label="Left arrow">&#8592;</button>
        <button type="button" data-key="ArrowUp" aria-label="Up arrow">&#8593;</button>
        <button type="button" data-key="ArrowDown" aria-label="Down arrow">&#8595;</button>
        <button type="button" data-key="ArrowRight" aria-label="Right arrow">&#8594;</button>
      </div>
      <footer class="live-bar">
        <button id="live-signin" type="button" class="live-btn live-grow">Sign in yourself</button>
        <button id="live-done" type="button" class="live-btn live-primary live-grow" hidden>Done, hand it back</button>
        <button id="live-keyboard" type="button" class="live-btn live-icon" aria-label="Keyboard" title="Keyboard">${ICON.keyboard}<span>Keyboard</span></button>
        <button id="live-paste" type="button" class="live-btn live-icon" aria-label="Paste text" title="Type the text on your clipboard into the screen">${ICON.paste}<span>Paste</span></button>
      </footer>
      <textarea id="live-sink" class="live-sink" rows="1" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="enter" aria-label="Type into the screen"></textarea>`;
    document.body.append(sheet);
    const get = (id) => sheet.querySelector(`#${id}`);
    const refs = {
      sheet,
      name: get("live-name"),
      status: get("live-status"),
      retry: get("live-retry"),
      close: get("live-close"),
      banner: get("live-banner"),
      screen: get("live-screen"),
      error: get("live-error"),
      errorText: get("live-error-text"),
      errorRetry: get("live-error-retry"),
      result: get("live-result"),
      resultImg: get("live-result-img"),
      resultClose: get("live-result-close"),
      keys: get("live-keys"),
      signin: get("live-signin"),
      done: get("live-done"),
      keyboard: get("live-keyboard"),
      paste: get("live-paste"),
      sink: get("live-sink"),
    };
    refs.close.addEventListener("click", close);
    refs.resultClose.addEventListener("click", close);
    refs.retry.addEventListener("click", () => begin());
    refs.errorRetry.addEventListener("click", () => begin());
    refs.signin.addEventListener("click", () => switchToSignIn());
    refs.done.addEventListener("click", () => handBack());
    refs.keyboard.addEventListener("click", toggleKeyboard);
    refs.paste.addEventListener("click", paste);
    refs.keys.addEventListener("click", (event) => {
      const key = event.target.closest("button[data-key]")?.dataset.key;
      if (key) tapKey(SPECIAL[key]);
    });
    refs.sink.addEventListener("input", (event) => {
      if (event.inputType === "deleteContentBackward") tapKey(SPECIAL.Backspace);
      else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") tapKey(SPECIAL.Enter);
      else if (event.data) typeText(event.data);
      else if (refs.sink.value) typeText(refs.sink.value);
      refs.sink.value = "";
    });
    refs.sink.addEventListener("keydown", (event) => {
      const symbol = SPECIAL[event.key];
      if (!symbol || event.isComposing) return;
      event.preventDefault();
      tapKey(symbol);
    });
    refs.sink.addEventListener("blur", () => {
      live.keyboard = false;
      refs.keyboard.classList.remove("on");
      refs.keys.hidden = true;
    });
    // The iOS keyboard shrinks the visual viewport, not the layout one: follow it.
    window.visualViewport?.addEventListener("resize", layout);
    window.visualViewport?.addEventListener("scroll", layout);
    return refs;
  }

  function layout() {
    if (!ui || ui.sheet.hidden) return;
    const viewport = window.visualViewport;
    ui.sheet.style.setProperty("--live-h", viewport ? `${Math.round(viewport.height)}px` : "100dvh");
    ui.sheet.style.setProperty("--live-top", viewport ? `${Math.round(viewport.offsetTop)}px` : "0px");
  }

  function setStatus(text, tone = "") {
    ui.status.textContent = text;
    ui.status.dataset.tone = tone;
  }

  // Buttons and the banner follow the mode.
  function render() {
    const signin = live.mode === "signin";
    ui.name.textContent = live.botName || "Agent";
    ui.signin.hidden = signin;
    ui.done.hidden = !signin;
    ui.done.disabled = live.busy;
    ui.signin.disabled = live.busy;
    ui.banner.hidden = !signin;
    if (signin) {
      ui.banner.replaceChildren();
      const lead = document.createElement("strong");
      lead.textContent = "You have the browser. ";
      ui.banner.append(lead, "Sign in here as you normally would, then press Done. This is a plain browser with no automation, and the agent waits until you hand it back.");
    }
  }

  function showError(message) {
    teardown();
    ui.error.hidden = false;
    ui.errorText.textContent = message;
    setStatus("Not connected", "bad");
    ui.retry.hidden = true;
  }

  async function open(options = {}) {
    if (!ui) ui = build();
    if (live.open) close({ quiet: true });
    if (!options.botId) return;
    Object.assign(live, {
      open: true,
      botId: options.botId,
      botName: options.botName || "",
      mode: options.mode === "signin" ? "signin" : "watch",
      url: options.url || "",
      retries: 0,
      closing: false,
      busy: false,
      keyboard: false,
    });
    ui.sheet.hidden = false;
    document.body.classList.add("live-on");
    ui.error.hidden = true;
    ui.result.hidden = true;
    ui.keys.hidden = true;
    render();
    layout();
    await begin();
  }

  // Gets the computer and its screen ready, connects, and (for Sign in yourself) hands the browser over.
  async function begin() {
    const token = ++live.token;
    clearTimeout(live.retryTimer);
    ui.error.hidden = true;
    ui.retry.hidden = true;
    setStatus(`Starting ${live.botName || "its"} computer…`, "wait");
    let info;
    try {
      info = await api(`/api/bots/${live.botId}/live/status`);
      if (!info.available) {
        showError(info.reason || "Live view is not available here.");
        return;
      }
      // Already handed over (another device, or a card opened again): it is the sign-in screen.
      if (info.handedOver) live.mode = "signin";
      render();
      await api(`/api/bots/${live.botId}/live/start`, { method: "POST", body: { browser: live.mode !== "signin" } });
    } catch (error) {
      if (token === live.token) showError(error.message);
      return;
    }
    if (token !== live.token || !live.open) return;
    await connect();
    if (token !== live.token || !live.open) return;
    if (live.mode === "signin" && !info.handedOver) await takeOver();
  }

  async function connect() {
    teardown();
    setStatus("Connecting…", "wait");
    try {
      live.RFB ||= (await import("/vendor/novnc/core/rfb.js")).default;
    } catch (error) {
      showError(`The live view could not load. ${error.message}`);
      return;
    }
    if (!live.open) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const rfb = new live.RFB(ui.screen, `${scheme}://${location.host}/api/bots/${encodeURIComponent(live.botId)}/live`, { shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.focusOnClick = true;
    rfb.background = "#0b0b0c";
    rfb.addEventListener("connect", () => {
      live.retries = 0;
      ui.retry.hidden = true;
      setStatus(connectedText(), "ok");
      if (!touch) rfb.focus();
    });
    rfb.addEventListener("disconnect", (event) => {
      if (live.rfb !== rfb) return;
      live.rfb = null;
      if (live.closing) return;
      if (live.retries < 3) {
        live.retries += 1;
        setStatus("Connection lost. Reconnecting…", "wait");
        live.retryTimer = setTimeout(() => {
          if (live.open && !live.closing) connect();
        }, 1200 * live.retries);
        return;
      }
      setStatus(event.detail?.clean ? "Disconnected" : "Connection lost", "bad");
      ui.retry.hidden = false;
    });
    rfb.addEventListener("securityfailure", () => {
      setStatus("The screen refused the connection", "bad");
      ui.retry.hidden = false;
    });
    live.rfb = rfb;
  }

  function connectedText() {
    if (live.mode === "signin") return "You have the browser";
    return touch ? "Live. Tap to click, drag to move, two fingers to scroll." : "Live. Click and type as if it were your screen.";
  }

  function teardown() {
    const rfb = live.rfb;
    live.rfb = null;
    if (!rfb) return;
    try {
      rfb.disconnect();
    } catch {
      // Already closed.
    }
  }

  // "Sign in yourself" from the live view: the agent's browser closes and a plain one opens.
  async function switchToSignIn() {
    if (live.busy) return;
    live.mode = "signin";
    live.url = "";
    render();
    await takeOver();
  }

  async function takeOver() {
    live.busy = true;
    render();
    setStatus("Opening a plain browser…", "wait");
    try {
      await api(`/api/bots/${live.botId}/live/takeover`, { method: "POST", body: { url: live.url } });
      setStatus(connectedText(), "ok");
    } catch (error) {
      live.mode = "watch";
      toast(error.message, "error");
      setStatus(live.rfb ? connectedText() : "Not connected", live.rfb ? "ok" : "bad");
    } finally {
      live.busy = false;
      render();
    }
    if (live.rfb && !touch) live.rfb.focus();
  }

  async function handBack() {
    if (live.busy) return;
    live.busy = true;
    render();
    setStatus("Handing the browser back…", "wait");
    try {
      await api(`/api/bots/${live.botId}/live/handback`, { method: "POST", body: {} });
    } catch (error) {
      live.busy = false;
      render();
      setStatus("Could not hand it back", "bad");
      toast(error.message, "error");
      return;
    }
    live.mode = "watch";
    live.busy = false;
    render();
    setStatus("Handed back", "ok");
    await showResult();
    if (typeof refreshBots === "function") refreshBots();
    if (typeof loadToday === "function" && state.view === "today") loadToday();
  }

  // What the agent sees now that it has its browser again.
  async function showResult() {
    ui.result.hidden = false;
    ui.resultImg.removeAttribute("src");
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(live.botId)}/browser/screenshot?t=${Date.now()}`);
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (ui.resultImg.dataset.url) URL.revokeObjectURL(ui.resultImg.dataset.url);
      ui.resultImg.dataset.url = URL.createObjectURL(blob);
      ui.resultImg.src = ui.resultImg.dataset.url;
    } catch {
      ui.resultImg.hidden = true;
    }
  }

  function close({ quiet = false } = {}) {
    if (!ui || !live.open) return;
    live.closing = true;
    live.open = false;
    live.token += 1;
    clearTimeout(live.retryTimer);
    teardown();
    ui.sink.blur();
    ui.sheet.hidden = true;
    ui.resultImg.hidden = false;
    document.body.classList.remove("live-on");
    if (!quiet && live.mode === "signin") toast("The agent is still waiting for you. Open Take control again and press Done when you finish.");
  }

  // ---- Typing -------------------------------------------------------------------

  function toggleKeyboard() {
    if (!live.rfb) return;
    if (live.keyboard) {
      ui.sink.blur();
      return;
    }
    live.keyboard = true;
    ui.keyboard.classList.add("on");
    ui.keys.hidden = false;
    // Focus from this tap, or iOS keeps the keyboard closed.
    ui.sink.focus({ preventScroll: true });
  }

  function tapKey(symbol) {
    if (!live.rfb || !symbol) return;
    live.rfb.sendKey(symbol, null, true);
    live.rfb.sendKey(symbol, null, false);
  }

  async function typeText(text) {
    if (!live.rfb) return;
    let count = 0;
    for (const char of String(text)) {
      if (!live.rfb) return;
      if (char === "\n" || char === "\r") {
        if (char === "\n") tapKey(SPECIAL.Enter);
        continue;
      }
      if (char === "\t") {
        tapKey(SPECIAL.Tab);
        continue;
      }
      const code = char.codePointAt(0);
      tapKey(code < 0x100 ? code : 0x01000000 + code);
      count += 1;
      if (count % 30 === 0) await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  async function paste() {
    if (!live.rfb) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt("Paste the text to type into the screen:") || "";
    }
    if (!text) {
      toast("Nothing to paste. Copy some text first.");
      return;
    }
    await typeText(text);
    toast("Typed it into the screen.");
  }

  // ---- Entry points ---------------------------------------------------------------

  function openForCurrent(mode) {
    if (!state.bot) return;
    open({ botId: state.bot.id, botName: state.bot.name, mode });
  }

  document.getElementById("screen-live")?.addEventListener("click", () => openForCurrent("watch"));
  document.getElementById("desktop-live")?.addEventListener("click", () => openForCurrent("watch"));

  window.RavnirLive = { open, close };
})();
