const $ = (id) => document.getElementById(id);
const COLORS = ["#a8c9e8", "#b9cab2", "#e7c8ca", "#cbc3e6", "#e6e0d2", "#6f6885", "#3e5a4c", "#8e8e93"];
const LEGACY_COLORS = {
  "#e6a15c": "#e7c8ca",
  "#7fc3a0": "#b9cab2",
  "#96b4e8": "#a8c9e8",
  "#d99ab5": "#e7c8ca",
  "#c9c46f": "#e6e0d2",
  "#b49bdd": "#cbc3e6",
};
const PANELS = ["screen", "desktop", "saved", "files", "shell", "logins", "jobs", "mind", "diffs", "mcp", "skills", "card", "usage"];
// The top tabs are groups; each panel lives in one. A group remembers the panel it showed last.
const PANEL_GROUP = {
  screen: "computer", desktop: "computer",
  saved: "files", files: "files", diffs: "files",
  shell: "shell", jobs: "routines",
  mind: "setup", logins: "setup", mcp: "setup", skills: "setup", card: "setup", usage: "setup",
};
function normalizeColor(color) {
  const key = String(color || "").toLowerCase();
  if (LEGACY_COLORS[key]) return LEGACY_COLORS[key];
  if (/^#[0-9a-f]{6}$/i.test(key) || /^#[0-9a-f]{3}$/i.test(key)) return key;
  return COLORS[0];
}

function normalizeLook(input, color = "") {
  return window.RavnirAvatar?.normalize(input, { color: color ? normalizeColor(color) : "" }) || {};
}

// What an agent's face shows: it needs you, it is working, or it is paused.
function creatureMood(bot) {
  if (!bot?.id) return "";
  if (state.approvals?.some((item) => item.botId === bot.id && (!item.status || item.status === "pending"))) return "waiting";
  if (state.today?.data?.isToday && state.today.data.approvals?.pending?.some((item) => item.botId === bot.id)) return "waiting";
  if (state.today?.data?.questions?.some((item) => item.botId === bot.id)) return "waiting";
  if (bot.busy) return "working";
  if ((bot.status && bot.status !== "on") || bot.model?.configured === false) return "sleeping";
  return "";
}

function paintCreature(node, bot) {
  if (!node) return;
  if (!window.RavnirAvatar) return clearAvatar(node, initials(bot?.name || "Agent"));
  node.classList.remove("empty");
  node.style.background = "";
  node.style.color = "";
  RavnirAvatar.render(node, bot?.avatar, {
    name: bot?.name || "Agent",
    seed: bot?.id || bot?.name,
    color: normalizeColor(bot?.color),
    state: creatureMood(bot),
    bot: bot?.id,
  });
}

function clearAvatar(node, letter = "") {
  if (!node) return;
  window.RavnirAvatar?.clear(node);
  node.textContent = letter;
  node.style.background = "";
  node.style.color = "";
}

const state = {
  server: null,
  bots: [],
  botId: readStored("ravnir.bot"),
  bot: null,
  conversation: [],
  diffs: [],
  memory: [],
  memoryInfo: null,
  groups: [],
  jobs: [],
  connectors: [],
  vault: [],
  livePrompt: "",
  runtime: { busy: false, activity: "", partial: "", startedAt: 0, source: "" },
  jump: { seen: "", fresh: false },
  badge: -1,
  browser: null,
  cursor: 0,
  turnItems: [],
  // The agent's web searches and page reads, which run without its browser (public/app.js renderResearch).
  research: { live: false, steps: [] },
  turnDiffs: [],
  pendingUsers: [],
  error: "",
  panel: "screen",
  sending: false,
  polling: false,
  refreshTick: 0,
  files: { path: "", entries: [], open: null },
  terminal: "",
  screenshotBusy: false,
  screenshotUrl: "",
  desktopBusy: false,
  desktopScreenshotUrl: "",
  zoom: 1,
  search: "",
  dragBotId: "",
  newColor: COLORS[0],
  setColor: COLORS[0],
  newLook: normalizeLook(),
  setLook: normalizeLook(),
  modelLoads: { nb: 0, set: 0 },
  discoverTarget: "new",
  clock: 0,
  view: ["today", "inbox", "plugins", "memory", "settings"].includes(readStored("ravnir.view")) ? readStored("ravnir.view") : "bot",
  today: { day: "", data: null, loading: false, open: new Set(), openSpecs: new Set(), specViews: new Map() },
  inbox: { approvals: 0, specs: 0, proposals: 0, unread: 0, today: null },
  usage: null,
  approvals: [],
  permission: null,
  permissionExpanded: false,
  railSignature: "",
  spec: { view: null, showApplied: false },
  showThinking: readStored("ravnir.showThinking") !== "0",
  showDiffs: readStored("ravnir.showDiffs") !== "0",
  // Off unless turned on in Settings (a new key, so the old default of on does not carry over).
  sound: readStored("ravnir.replySound") === "1",
  openTools: new Set(),
  seenRows: { botId: "", keys: new Set() },
  onepassword: { status: null, items: [], loading: false },
  permAllow: [],
};

// One unsent message per agent, kept on this device so switching agents (or a reload) loses nothing.
const drafts = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("ravnir.drafts") || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
})();
let draftTimer = 0;

function flushDrafts() {
  clearTimeout(draftTimer);
  const ids = Object.keys(drafts);
  for (const id of ids.slice(0, Math.max(0, ids.length - 60))) delete drafts[id];
  writeStored("ravnir.drafts", JSON.stringify(drafts));
}

function rememberDraft(botId = state.botId) {
  if (!botId) return;
  const text = els["composer-input"].value;
  if (text.trim()) drafts[botId] = text.slice(0, 20_000);
  else delete drafts[botId];
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDrafts, 400);
}

function restoreDraft(botId) {
  els["composer-input"].value = drafts[botId] || "";
  autoGrow();
}

function forgetDraft(botId) {
  delete drafts[botId];
  flushDrafts();
}

window.addEventListener("pagehide", () => {
  rememberDraft();
  flushDrafts();
});

const els = {};
for (const id of [
  "shell", "bot-list", "bot-count", "server-url", "server-pulse", "new-bot", "net-bar", "composer-hint", "jump-latest", "jump-label",
  "bot-search", "rail-search", "pin-row", "main-hero", "mobile-back", "profile-avatar", "profile-job", "profile-label",
  "thread-avatar", "thread-name", "thread-job", "online-chip", "main-chip", "model-chip", "open-settings",
  "toggle-computer", "rail-toggle", "activity-bar", "activity-text", "activity-time", "activity-stop",
  "toggle-thinking", "toggle-diffs",
  "messages", "permission-bar", "permission-title", "empty-thread", "empty-create", "composer",
  "composer-input", "mention-menu", "send-btn", "stop-btn", "computer", "computer-name", "computer-caption",
  "computer-dot", "computer-refresh", "computer-close", "computer-tabs", "diff-count", "files-count",
  "url-form", "url-input", "screen", "screen-empty", "screen-open", "screen-open-input", "sub-tabs", "screen-zoom", "type-input", "type-secret",
  "type-send", "key-enter", "key-tab", "desktop-screen", "desktop-empty", "desktop-boot", "desktop-type", "desktop-type-send", "desktop-key-enter", "desktop-key-tab", "desktop-refresh", "file-path", "files-refresh", "file-list", "file-editor",
  "file-editor-name", "file-cancel", "file-save", "file-content", "file-status", "shell-cwd",
  "shell-clear", "shell-output", "shell-form", "shell-input", "login-list", "login-form",
  "login-site", "login-username", "login-password", "login-label", "job-list", "job-form",
  "onepassword-card", "onepassword-state", "onepassword-hint", "onepassword-search", "onepassword-load", "onepassword-list",
  "onepassword-token-form", "onepassword-token", "onepassword-connect", "onepassword-forget",
  "job-name", "job-prompt", "live-prompt", "copy-prompt", "instructions",
  "instructions-status", "save-instructions", "compare-bot", "compare-load", "prompt-diff",
  "memory-list", "memory-status", "memory-form", "memory-input", "reset-session", "compact-now", "diff-list", "diffs-refresh", "connector-list",
  "connector-form", "connector-name", "connector-transport", "connector-command", "connector-args",
  "connector-url", "connector-env", "connector-headers", "new-bot-dialog", "new-bot-form",
  "nb-name", "nb-group", "nb-job", "nb-prompt", "nb-discover", "nb-provider", "nb-base",
  "nb-user-field", "nb-user", "nb-key-field", "nb-key", "nb-model", "nb-model-custom", "nb-load-models",
  "nb-studio", "nb-model-pick", "nb-advanced", "set-model-pick", "set-advanced", "set-backups", "set-backup-add",
  "nb-agent-field", "nb-agent", "nb-status", "nb-error", "settings-dialog", "settings-form",
  "settings-title", "set-name", "set-group", "set-job", "set-provider", "set-base",
  "set-user-field", "set-user", "set-key-field", "set-key", "set-model", "set-model-custom",
  "set-studio",
  "set-agent-field", "set-agent", "set-load-models", "set-status", "set-error", "delete-bot",
  "set-pin", "set-main", "set-paused", "clear-chat",
  "ask-dialog", "ask-form", "ask-kicker", "ask-title", "ask-message", "ask-field", "ask-label", "ask-input", "ask-error", "ask-ok",
  "switcher", "switcher-input", "switcher-list",
  "discover-dialog", "discover-status", "discover-list", "toast",
  "today-nav", "today-badge", "today-spend", "today-toggle", "today-badge-mobile", "today-view", "today-kicker",
  "today-title", "today-prev", "today-now", "today-next", "today-body", "thread", "permission-detail", "permission-expand",
  "usage-body", "spec-state", "spec-hint", "spec-form", "spec-path", "spec-linked", "spec-meta", "spec-diff-wrap",
  "spec-diff", "spec-apply", "spec-dismiss", "spec-view", "spec-unlink", "spec-applied",
  "set-cap-cost", "set-cap-tokens", "set-cap-month-cost", "set-cap-month-tokens", "set-notify", "perm-chips", "perm-add", "perm-add-btn",
  "inbox-nav", "inbox-badge", "inbox-view", "inbox-body", "inbox-mark-all", "inbox-device", "inbox-suggestions", "inbox-list",
  "import-view", "import-body", "permission-rule", "plugins-nav", "plugins-view", "browse-plugins", "skills-nav", "skills-view", "browse-skills", "memory-nav", "memory-view", "memory-body", "settings-nav", "settings-view", "settings-body",
  "tabbar", "scrim", "sheet", "sheet-list", "sheet-title", "sheet-foot", "head-computer", "bot-head", "thread-head", "tab-home-badge", "tab-inbox-badge", "tabs-wrap",
]) els[id] = $(id);

// A page from an older version next to this script lacks some of these elements, and binding them
// threw before the app ever reached the server ("connecting…" for good). Load a fresh copy once.
function pageIsCurrent() {
  const missing = Object.keys(els).filter((id) => id !== "shell" && id !== "thread" && !els[id]);
  if (!missing.length) return true;
  console.warn(`Page is out of date (missing ${missing.slice(0, 5).join(", ")}); loading a fresh copy.`);
  let tried = "";
  try {
    tried = sessionStorage.getItem("ravnir.freshLoad") || "";
    sessionStorage.setItem("ravnir.freshLoad", String(Date.now()));
  } catch {
    // Without storage, try once per page load.
  }
  if (tried && Date.now() - Number(tried) < 60_000) return true;
  const url = new URL(location.href);
  url.searchParams.set("fresh", Date.now().toString(36));
  location.replace(url.toString());
  return false;
}

function safeStart() {
  if (!pageIsCurrent()) return;
  try {
    bind();
  } catch (error) {
    // A missing control should cost that control, not the whole app.
    console.error("Some controls did not start:", error);
  }
  try {
    syncComposerHint();
    bindSwitcher();
  } catch (error) {
    console.error(error);
  }
  init();
}

// The feature scripts (schedule.js, notifications.js) load after this file, so start once they have.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", safeStart);
else safeStart();

function bind() {
  els["new-bot"].addEventListener("click", openNewBot);
  els["compact-now"].addEventListener("click", compactNow);
  els["reset-session"].addEventListener("click", resetSession);
  els["rail-search"].addEventListener("click", () => {
    els["bot-search"].hidden = !els["bot-search"].hidden;
    if (!els["bot-search"].hidden) els["bot-search"].focus();
    else { state.search = ""; els["bot-search"].value = ""; renderRail(); }
  });
  els["bot-search"].addEventListener("input", () => {
    state.search = els["bot-search"].value.trim().toLowerCase();
    renderRail();
  });
  els["pin-row"].addEventListener("click", () => els.shell.classList.remove("rail-open"));
  els["empty-create"].addEventListener("click", openNewBot);
  els["open-settings"].addEventListener("click", openSettings);
  els["model-chip"].addEventListener("click", openSettings);
  els["toggle-computer"].addEventListener("click", () => {
    if (els.shell.classList.contains("computer-open")) closeComputer();
    else openComputer();
  });
  els["head-computer"].addEventListener("click", openComputer);
  // The name at the top is the way into settings and more, on the phone and on a computer.
  els["bot-head"].addEventListener("click", () => openThreadMenu(els["bot-head"]));
  // The glass header floats over the thread; the thread starts below it.
  if (window.ResizeObserver) {
    new ResizeObserver(() => els.thread.style.setProperty("--head-h", `${els["thread-head"].offsetHeight}px`)).observe(els["thread-head"]);
  }
  els["tabbar"].addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) goTab(button.dataset.tab);
  });
  els["scrim"].addEventListener("click", closeComputer);
  els["sheet"].addEventListener("click", (event) => {
    if (event.target.closest("[data-sheet-close]")) closeSheet();
  });
  document.addEventListener("keydown", handleShortcut);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (els["sheet"].classList.contains("show")) closeSheet();
    else if (els.shell.classList.contains("computer-open")) closeComputer();
  });
  els["computer-tabs"].addEventListener("scroll", updateTabFade, { passive: true });
  window.addEventListener("resize", updateTabFade);
  watchSheetDrag();
  window.matchMedia("(max-width: 760px)").addEventListener("change", () => {
    state.railSignature = "";
    closeSheet();
    renderRail();
    syncTabbar();
  });
  els["rail-toggle"].addEventListener("click", () => {
    if (isPhone()) openHome();
    else els.shell.classList.toggle("rail-open");
  });
  els["mobile-back"].addEventListener("click", () => goTab(state.returnTab || "agents"));
  els["permission-expand"].addEventListener("click", () => {
    state.permissionExpanded = !state.permissionExpanded;
    syncPermissionBar();
  });
  els["computer-close"].addEventListener("click", closeComputer);
  els["computer-refresh"].addEventListener("click", refreshScreen);

  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });
  els["composer-input"].addEventListener("keydown", (event) => {
    if (handleMentionKey(event)) return;
    // On a phone the keyboard's return key is a new line; the send button sends.
    if (event.key === "Enter" && !event.shiftKey && !isTouchDevice()) {
      event.preventDefault();
      sendMessage();
    }
  });
  els["composer-input"].addEventListener("input", () => {
    autoGrow();
    updateMentionMenu();
    rememberDraft();
    window.RavnirAvatar?.attend(els["composer-input"], 1500);
  });
  els["composer-input"].addEventListener("click", updateMentionMenu);
  els["composer-input"].addEventListener("keyup", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    updateMentionMenu();
  });
  els["composer-input"].addEventListener("blur", () => setTimeout(closeMentionMenu, 120));
  els["stop-btn"].addEventListener("click", stopTurn);
  els["activity-stop"].addEventListener("click", stopTurn);
  els["toggle-thinking"].addEventListener("click", () => setShowThinking(!state.showThinking));
  els["toggle-diffs"].addEventListener("click", () => setShowDiffs(!state.showDiffs));
  els.messages.addEventListener("scroll", () => syncJump(), { passive: true });
  els["jump-latest"].addEventListener("click", () => {
    state.jump.fresh = false;
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
  });

  els["computer-tabs"].addEventListener("click", (event) => {
    const button = event.target.closest("button[data-group]");
    if (button) showGroup(button.dataset.group);
  });
  els["sub-tabs"].addEventListener("click", (event) => {
    const button = event.target.closest("button[data-panel]");
    if (button) showPanel(button.dataset.panel);
  });

  els["url-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    browserAction("navigate", { url: els["url-input"].value });
  });
  document.querySelectorAll("[data-browser]").forEach((button) => {
    button.addEventListener("click", () => browserAction(button.dataset.browser));
  });
  els["screen-zoom"].addEventListener("click", () => {
    const steps = [1, 1.6, 2.4];
    state.zoom = steps[(steps.indexOf(state.zoom) + 1) % steps.length];
    els["screen-zoom"].textContent = `${state.zoom}×`;
    els.screen.style.width = state.zoom === 1 ? "100%" : `${state.zoom * 100}%`;
    els.screen.style.maxWidth = state.zoom === 1 ? "" : "none";
  });
  els.screen.addEventListener("click", (event) => {
    if (!state.bot) return;
    const rect = els.screen.getBoundingClientRect();
    const width = state.browser?.viewport?.width || 1440;
    const height = state.browser?.viewport?.height || 900;
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    browserAction("click", { x, y });
  });
  els["screen-open"].addEventListener("submit", (event) => {
    event.preventDefault();
    const url = els["screen-open-input"].value.trim();
    if (!url) return els["screen-open-input"].focus();
    els["url-input"].value = url;
    els["screen-open-input"].value = "";
    toast("Opening…");
    browserAction("navigate", { url });
  });
  els["type-send"].addEventListener("click", sendTyped);
  els["desktop-boot"].addEventListener("click", async () => {
    try {
      await desktopAction("start");
      setTimeout(refreshDesktop, 500);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  els["desktop-refresh"].addEventListener("click", () => refreshDesktop());
  els["desktop-screen"].addEventListener("click", (event) => {
    if (!state.bot) return;
    const rect = els["desktop-screen"].getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 1440;
    const y = ((event.clientY - rect.top) / rect.height) * 900;
    desktopAction("click", { x, y });
  });
  els["desktop-type-send"].addEventListener("click", sendDesktopTyped);
  els["desktop-type"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendDesktopTyped();
    }
  });
  els["desktop-key-enter"].addEventListener("click", () => desktopAction("key", { key: "Enter" }));
  els["desktop-key-tab"].addEventListener("click", () => desktopAction("key", { key: "Tab" }));
  els["type-input"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendTyped();
    }
  });
  els["type-secret"].addEventListener("click", () => {
    const secret = els["type-input"].type !== "password";
    els["type-input"].type = secret ? "password" : "text";
    els["type-secret"].classList.toggle("on", secret);
    els["type-input"].placeholder = secret ? "Type a password without showing it" : "Click a field, then type here";
    els["type-input"].focus();
  });
  els["key-enter"].addEventListener("click", () => browserAction("key", { key: "Enter" }));
  els["key-tab"].addEventListener("click", () => browserAction("key", { key: "Tab" }));

  els["files-refresh"].addEventListener("click", () => loadFiles(state.files.path));
  els["file-cancel"].addEventListener("click", closeFile);
  els["file-save"].addEventListener("click", saveFile);

  els["shell-clear"].addEventListener("click", () => setTerminal("Ready. Commands run on this server, in this agent's workspace."));
  els["shell-form"].addEventListener("submit", runShell);

  els["login-form"].addEventListener("submit", saveLogin);
  els["onepassword-load"].addEventListener("click", () => loadOnePassword(els["onepassword-search"].value.trim()));
  els["onepassword-token-form"].addEventListener("submit", connectOnePassword);
  els["onepassword-forget"].addEventListener("click", forgetOnePassword);
  els["onepassword-search"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadOnePassword(els["onepassword-search"].value.trim());
    }
  });

  els["diffs-refresh"].addEventListener("click", () => loadDiffs());
  els["save-instructions"].addEventListener("click", saveInstructions);
  els["copy-prompt"].addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els["live-prompt"].textContent || "");
      toast("Prompt copied.");
    } catch {
      toast("Could not copy the prompt.", "error");
    }
  });
  els["compare-load"].addEventListener("click", loadPromptDiff);
  els["memory-form"].addEventListener("submit", addMemory);

  els["connector-form"].addEventListener("submit", createConnector);
  els["connector-transport"].addEventListener("change", syncConnectorFields);

  els["new-bot-form"].addEventListener("submit", createBot);
  els["nb-discover"].addEventListener("click", () => openDiscover("new"));
  els["nb-provider"].addEventListener("change", () => {
    syncNewBotFields();
    loadModelsInto("nb", { auto: true });
  });
  els["nb-base"].addEventListener("change", () => loadModelsInto("nb", { auto: true }));
  els["nb-model"].addEventListener("change", () => syncModelCustom("nb"));
  els["nb-load-models"].addEventListener("click", () => loadModelsInto("nb"));
  els["nb-name"].addEventListener("input", () => refreshLookName("nb"));
  els["set-name"].addEventListener("input", () => refreshLookName("set"));
  for (const id of ["nb-name", "nb-job"]) els[id].addEventListener("change", matchNewLook);
  els["settings-form"].addEventListener("submit", saveSettings);
  els["set-provider"].addEventListener("change", () => {
    syncSettingsFields();
    loadModelsInto("set", { auto: true });
  });
  els["set-base"].addEventListener("change", () => loadModelsInto("set", { auto: true }));
  els["set-model"].addEventListener("change", () => syncModelCustom("set"));
  els["set-load-models"].addEventListener("click", () => loadModelsInto("set"));
  els["delete-bot"].addEventListener("click", deleteBot);
  els["clear-chat"].addEventListener("click", clearChat);

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  els["permission-bar"].addEventListener("click", (event) => {
    if (event.target.closest("[data-takeover]")) {
      openTakeover(state.approvals[0], state.bot?.id, state.bot?.name);
      return;
    }
    const decision = event.target.dataset.decision;
    if (!decision) return;
    if (decision === "trust" && !confirmTrust(state.bot?.name)) return;
    answerPermission(decision);
  });
  for (const group of ["shell", "files", "logins", "plugins"]) {
    $(`perm-${group}`).addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (button) setSegment(`perm-${group}`, button.dataset.value);
    });
  }
  els["perm-add-btn"].addEventListener("click", addPermissionRule);
  els["set-backup-add"].addEventListener("click", () => addBackupRow()?.querySelector(".mp-trigger")?.click());
  els["perm-add"].addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addPermissionRule();
  });

  els["today-nav"].addEventListener("click", () => openToday());
  els["today-toggle"].addEventListener("click", () => openToday());
  els["inbox-nav"].addEventListener("click", () => openInbox());
  els["plugins-nav"].addEventListener("click", () => openPlugins());
  els["browse-plugins"].addEventListener("click", () => openPlugins());
  els["skills-nav"].addEventListener("click", () => openSkills());
  els["browse-skills"].addEventListener("click", () => openSkills());
  els["memory-nav"].addEventListener("click", () => openMemory());
  els["settings-nav"].addEventListener("click", () => openSettingsPage());
  els["today-prev"].addEventListener("click", () => openToday(shiftDay(state.today.day, -1)));
  els["today-next"].addEventListener("click", () => openToday(shiftDay(state.today.day, 1)));
  els["today-now"].addEventListener("click", () => openToday(""));
  els["spec-form"].addEventListener("submit", linkSpec);
  els["spec-apply"].addEventListener("click", applySpec);
  els["spec-dismiss"].addEventListener("click", dismissSpec);
  els["spec-unlink"].addEventListener("click", unlinkSpec);
  els["spec-view"].addEventListener("click", () => {
    state.spec.showApplied = !state.spec.showApplied;
    renderSpec();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
  setInterval(updateClock, 1000);
  setInterval(() => poll(), 1400);
  setInterval(() => {
    state.refreshTick += 1;
    if (state.refreshTick % 4 === 0) refreshBots();
    if (state.view === "today" && state.refreshTick % 4 === 2 && !document.hidden) loadToday();
    if (state.view === "bot" && state.panel === "screen") refreshScreen();
    if (state.view === "bot" && state.panel === "desktop" && state.refreshTick % 2 === 0) refreshDesktop();
  }, 1400);
}

// The first answer from the server, tried until it comes. A home-screen app opened right after the
// computer wakes often fires before the network (Tailscale) is back, and one failed try used to leave
// the app on "connecting…" with no agents until it was reopened.
async function firstState() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await refreshState();
      return;
    } catch (error) {
      if (state.signingOut) throw error;
      if (attempt === 0) renderAll();
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** attempt)));
    }
  }
}

async function init() {
  try {
    await firstState();
    if (state.server?.setupNeeded) window.RavnirWelcome?.open();
    loadDefaults();
    refreshOnePassword().catch(() => {});
    const exists = state.bots.some((bot) => bot.id === state.botId);
    if (!exists) state.botId = state.bots[0]?.id || "";
    if (isPhone()) {
      openHome();
      renderAll();
      if (!state.bots.length && state.inbox.approvals) openToday();
      consumeDeepLink();
      return;
    }
    const view = state.view;
    if (state.botId) await selectBot(state.botId, { silent: true });
    else renderAll();
    if (view === "today" || (!state.bots.length && state.inbox.approvals)) openToday();
    else if (view === "inbox") openInbox();
    else if (view === "plugins") openPlugins();
    else if (view === "skills") openSkills();
    else if (view === "memory") openMemory();
    else if (view === "settings") openSettingsPage();
    consumeDeepLink();
  } catch (error) {
    toast(error.message, "error");
    renderAll();
  }
}

async function refreshState() {
  const data = await api("/api/state");
  state.server = data.server;
  state.bots = data.bots;
  state.groups = data.groups || state.groups || [];
  applyInbox(data.inbox);
  els["server-url"].textContent = data.server.url.replace(/^https?:\/\//, "");
  els["server-pulse"].classList.remove("bad");
  renderRail();
}

async function refreshBots() {
  if (!state.bot && state.view !== "today" && !isPhone()) return;
  try {
    const data = await api("/api/state");
    state.bots = data.bots;
    state.groups = data.groups || state.groups || [];
    state.server = data.server;
    applyInbox(data.inbox);
    renderRail();
    const active = data.bots.find((bot) => bot.id === state.botId);
    if (!active && state.bot) {
      state.botId = data.bots[0]?.id || "";
      if (state.botId) await selectBot(state.botId);
      else {
        state.bot = null;
        renderAll();
      }
    }
  } catch {
    // Keep the current view when the server is briefly unreachable.
  }
}

async function selectBot(id, { silent = false } = {}) {
  if (!id) return;
  if (!silent) localStorage.setItem("ravnir.bot", id);
  else localStorage.setItem("ravnir.bot", id);
  // Whatever is typed stays with the agent it was typed for.
  if (state.botId && state.botId !== id) rememberDraft(state.botId);
  const switching = state.botId !== id || !els["composer-input"].value;
  state.botId = id;
  if (switching) restoreDraft(id);
  const from = currentTab();
  if (from && from !== "thread") state.returnTab = from === "more" ? "agents" : from;
  setView("bot");
  state.permissionExpanded = false;
  openMobileView();
  state.cursor = 0;
  state.spec = { view: null, showApplied: false };
  state.turnItems = [];
  state.research = { live: false, steps: [] };
  state.pendingUsers = [];
  state.error = "";
  state.terminal = "";
  state.files = { path: "", entries: [], open: null };
  if (state.screenshotUrl) URL.revokeObjectURL(state.screenshotUrl);
  state.screenshotUrl = "";
  els.screen.removeAttribute("src");
  const summary = state.bots.find((bot) => bot.id === id);
  if (summary && state.bot?.id !== id) previewBot(summary);
  try {
    const detail = await api(`/api/bots/${id}`);
    applyDetail(detail, { resetCursor: true });
    renderAll();
    loadFiles("");
    if (state.panel === "screen") refreshScreen();
    if (state.panel === "mind") loadSpec();
    if (state.runtime.busy) poll();
  } catch (error) {
    toast(error.message, "error");
  }
}

function applyDetail(detail, { resetCursor = false } = {}) {
  // A slow response for an agent the user already left must not switch the selection back to it.
  if (state.botId && detail?.bot?.id !== state.botId) return false;
  state.bot = detail.bot;
  state.conversation = detail.conversation || [];
  state.diffs = detail.diffs || [];
  state.memory = detail.bot.memory || [];
  state.memoryInfo = detail.memory || state.memoryInfo;
  state.groups = detail.groups || state.groups || [];
  state.jobs = detail.bot.jobs || [];
  state.connectors = detail.bot.connectors || [];
  state.vault = detail.bot.vault || [];
  state.livePrompt = detail.livePrompt || "";
  state.runtime = detail.runtime || { busy: false, activity: "", partial: "" };
  state.browser = detail.browser || null;
  state.network = detail.network || null;
  state.desktop = detail.desktop || null;
  syncSubTabs();
  state.usage = detail.usage || null;
  state.approvals = detail.approvals || [];
  state.suggestions = detail.suggestions || [];
  syncPermissionBar();
  if (resetCursor) {
    state.cursor = detail.lastSeq || 0;
    state.turnItems = detail.runtime?.partial
      ? [{ type: "assistant", text: detail.runtime.partial }]
      : [];
  }
  state.botId = detail.bot.id;
  localStorage.setItem("ravnir.bot", state.botId);
  els["composer-input"].placeholder = isPhone() ? `Message ${detail.bot.name}` : `Message ${detail.bot.name}… (@ to tag another agent)`;
}

async function poll() {
  if (!state.bot || state.polling || document.hidden) return;
  state.polling = true;
  try {
    const data = await api(`/api/bots/${state.bot.id}/events?after=${state.cursor}${document.hasFocus() ? "&watching=1" : ""}`);
    state.cursor = data.cursor ?? state.cursor;
    let ended = false;
    let stopped = false;
    for (const event of data.events || []) {
      const outcome = handleEvent(event);
      if (outcome === "end") ended = true;
      if (outcome === "stopped") stopped = true;
    }
    if (data.runtime) {
      state.runtime = data.runtime;
      if (state.runtime.busy && state.runtime.partial && !state.turnItems.some((item) => item.type === "assistant")) {
        state.turnItems.unshift({ type: "assistant", text: state.runtime.partial });
      }
    }
    if (ended || stopped) {
      await reloadBot();
      if (stopped) toast("Stopped.");
    }
    renderThreadState();
    renderResearch();
    scheduleRender();
  } catch {
    // A brief network failure should not clear the screen.
  } finally {
    state.polling = false;
  }
}

function handleEvent(event) {
  if (!state.bot || event.botId !== state.bot.id) return "";
  // Voice mode follows its own turns (quick plan and reply) from here.
  window.RavnirVoice?.onEvent(event);
  if (event.type === "turn.start") {
    state.pendingUsers.shift();
    if (event.message && !state.conversation.some((message) => message.id === event.message.id)) {
      state.conversation.push(event.message);
    }
    state.turnItems = [];
    state.turnDiffs = [];
    state.research = { live: true, steps: [] };
    state.error = "";
    state.runtime.busy = true;
    state.runtime.startedAt = event.at || Date.now();
    state.runtime.activity = event.source === "job" ? `Scheduled job: ${event.jobName}` : "Thinking";
    return "";
  }
  if (event.type === "ack") {
    if (event.message && !state.conversation.some((message) => message.id === event.message.id)) {
      state.conversation.push(event.message);
    }
    state.runtime.busy = true;
    return "";
  }
  if (event.type === "stream.delta") {
    const last = state.turnItems.at(-1);
    if (last?.type === "assistant") last.text += event.text || "";
    else state.turnItems.push({ type: "assistant", text: event.text || "" });
    return "";
  }
  if (event.type === "stream.replace") {
    const last = state.turnItems.at(-1);
    if (last?.type === "assistant") last.text = event.text || "";
    else state.turnItems.push({ type: "assistant", text: event.text || "" });
    return "";
  }
  if (event.type === "tool") {
    const existing = state.turnItems.find((item) => item.type === "tool" && item.id === event.id);
    const item = {
      type: "tool",
      id: event.id,
      name: event.name,
      status: event.status,
      input: event.input,
      output: event.output,
    };
    if (existing) Object.assign(existing, item);
    else state.turnItems.push(item);
    noteResearch(item);
    return "";
  }
  if (event.type === "computer.step") {
    const item = {
      type: "computer",
      runId: event.runId || "",
      step: event.step,
      phase: event.phase,
      action: event.action || "",
      score: event.score,
      url: event.url || "",
      title: event.title || "",
      shot: event.shot || "",
    };
    const existing = state.turnItems.find((entry) => entry.type === "computer" && entry.runId === item.runId && entry.step === item.step && entry.phase === item.phase);
    if (existing) Object.assign(existing, item);
    else state.turnItems.push(item);
    if (item.action) state.runtime.activity = `Computer: ${item.action}`;
    return "";
  }
  if (event.type === "status") {
    state.runtime.activity = event.message || state.runtime.activity;
    return "";
  }
  if (event.type === "artifact" && event.artifact?.id) {
    window.RavnirArtifacts?.invalidate?.(state.bot.id, event.artifact.id);
    if (state.panel === "saved") renderSaved();
    const existing = state.turnItems.find((item) => item.type === "artifact" && item.artifact.id === event.artifact.id);
    if (existing) existing.artifact = event.artifact;
    else if (state.runtime.busy) state.turnItems.push({ type: "artifact", artifact: event.artifact });
    return "";
  }
  if (event.type === "meta") {
    if (event.model) state.runtime.model = event.model;
    if (event.provider) state.runtime.provider = event.provider;
    return "";
  }
  if (event.type === "diff") {
    if (!state.diffs.some((diff) => diff.patch === event.patch && diff.path === event.path)) {
      state.diffs.push({ ...event, id: event.id || event.seq });
      renderDiffs();
    }
    if (!state.turnDiffs.some((diff) => diff.path === event.path && diff.patch === event.patch)) {
      state.turnDiffs.push({ ...event, id: event.id || event.seq });
    }
    return "";
  }
  if (event.type === "permission") {
    if (!state.approvals.some((item) => item.id === event.requestID)) {
      if (!state.approvals.length) state.permissionExpanded = false;
      state.approvals.push({ id: event.requestID, title: event.title, detail: event.detail || "", kind: event.kind || "", rule: event.rule || "", onceOnly: Boolean(event.onceOnly), data: event.data || null, expiresAt: event.expiresAt || 0 });
    }
    syncPermissionBar();
    return "";
  }
  if (event.type === "permission.resolved") {
    state.approvals = state.approvals.filter((item) => item.id !== event.requestID);
    syncPermissionBar();
    return "";
  }
  if (event.type === "spec") {
    if (state.panel === "mind") loadSpec();
    return "";
  }
  if (event.type === "ask" || event.type === "asks.answered") {
    if (event.type === "asks.answered") window.RavnirQuestions?.mark(event.ids);
    // Home, the badge and the faces read the open questions; thread cards redraw from the next render.
    loadToday();
    refreshBots();
    scheduleRender();
    return "";
  }
  if (event.type === "activity") {
    if (event.actor === "user") state.runtime.activity = event.message;
    return "";
  }
  if (event.type === "error") {
    state.error = event.message || "The turn failed.";
    return "";
  }
  if (event.type === "turn.stopped") {
    state.runtime.busy = false;
    return "stopped";
  }
  if (event.type === "voice.message") {
    if (event.message && !state.conversation.some((message) => message.id === event.message.id)) state.conversation.push(event.message);
    return "";
  }
  if (event.type === "mention.reply") {
    if (event.message && !state.conversation.some((message) => message.id === event.message.id)) {
      state.conversation.push(event.message);
      replySound();
      window.RavnirAvatar?.react(event.message.botId || state.bot?.id, "happy");
    }
    return "";
  }
  if (event.type === "turn.end") {
    if (event.messages?.some((message) => message.role === "assistant" && message.content)) {
      replySound();
      window.RavnirAvatar?.react(state.bot?.id, "happy");
    }
    state.runtime.busy = false;
    state.turnItems = [];
    state.research.live = false;
    return "end";
  }
  if (event.type === "idle") {
    state.runtime.busy = false;
    state.runtime.activity = "";
    return "";
  }
  return "";
}

async function reloadBot() {
  if (!state.bot) return;
  try {
    const detail = await api(`/api/bots/${state.botId}`);
    applyDetail(detail, { resetCursor: false });
    renderAll();
    if (state.panel === "screen") refreshScreen();
  } catch {
    // The next poll will try again.
  }
}

function renderAll() {
  renderRail();
  renderHeader();
  renderThreadState();
  renderMessages();
  renderComputer();
  window.RavnirNetwork?.render(state.bot, state.network);
  renderMind();
  renderDiffs();
  renderJobsWithSpend();
  renderLogins();
  renderConnectors();
  renderCompareOptions();
  renderFiles();
  renderShell();
  renderUsage();
  renderView();
}

function railOrder(bots) {
  return [...bots].sort((a, b) => {
    if (Boolean(a.main) !== Boolean(b.main)) return a.main ? -1 : 1;
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return (Number(a.pinnedOrder) || 0) - (Number(b.pinnedOrder) || 0);
    return 0;
  });
}

function renderRail() {
  const phone = isPhone();
  const ordered = railOrder(state.bots);
  const hero = ordered[0] || null;
  const signature = JSON.stringify([
    phone,
    state.search,
    state.botId,
    state.view,
    hero?.id,
    state.bots.map((bot) => [bot.id, bot.name, bot.job, bot.group, JSON.stringify(bot.avatar || null), bot.color, bot.busy, bot.busy ? bot.activity : "", bot.pinned, bot.pinnedOrder, bot.main, bot.status, bot.model?.configured, creatureMood(bot)]),
    (state.groups || []).map((group) => group.name),
  ]);
  if (signature === state.railSignature && els["bot-list"].childElementCount) return;
  state.railSignature = signature;
  const scrollTop = els["bot-list"].scrollTop;
  els["bot-count"].textContent = String(state.bots.length);
  els["bot-list"].replaceChildren();
  els["pin-row"].replaceChildren();
  renderMainHero(hero);
  const candidates = phone && hero ? state.bots.filter((bot) => bot.id !== hero.id) : state.bots;
  const visible = candidates.filter((bot) => {
    if (!state.search) return true;
    return `${bot.name} ${bot.job} ${bot.group}`.toLowerCase().includes(state.search);
  });
  const pinned = ordered.filter((bot) => bot.pinned || bot.main);
  const top = pinned.length ? pinned : ordered.slice(0, 4);
  for (const bot of top) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pin-bot${bot.main ? " main" : ""}`;
    button.draggable = Boolean(bot.pinned);
    button.dataset.botId = bot.id;
    const avatar = document.createElement("span");
    avatar.className = "avatar lg";
    paintCreature(avatar, bot);
    const label = document.createElement("span");
    label.className = "pin-name";
    label.textContent = bot.name;
    button.append(avatar, label);
    if (bot.main) {
      button.append(mainStar("pin-star"));
    }
    button.addEventListener("click", (event) => {
      if (event.target.closest(".pin-toggle")) return;
      selectBot(bot.id);
      els.shell.classList.remove("rail-open");
    });
    if (bot.pinned) {
      button.addEventListener("dragstart", (event) => {
        state.dragBotId = bot.id;
        event.dataTransfer?.setData("text/plain", bot.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      button.addEventListener("dragend", () => {
        state.dragBotId = "";
        els["pin-row"].querySelectorAll(".pin-bot").forEach((node) => node.classList.remove("drag-over"));
      });
      button.addEventListener("dragover", (event) => {
        if (!state.dragBotId || state.dragBotId === bot.id) return;
        event.preventDefault();
        button.classList.add("drag-over");
      });
      button.addEventListener("dragleave", () => button.classList.remove("drag-over"));
      button.addEventListener("drop", async (event) => {
        event.preventDefault();
        button.classList.remove("drag-over");
        await reorderPinned(state.dragBotId, bot.id);
      });
    }
    els["pin-row"].append(button);
  }
  if (!state.bots.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.style.padding = "8px 9px";
    hint.textContent = "No agents yet. Create one to give it a name, a job, and a computer.";
    els["bot-list"].append(hint);
    els["bot-list"].scrollTop = scrollTop;
    return;
  }
  if (!visible.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.style.padding = "8px 9px";
    // On the phone the main agent sits in its own card, so with one agent the list is empty without a search.
    hint.textContent = state.search ? "No agents match that search." : "More agents you create show up here.";
    els["bot-list"].append(hint);
    els["bot-list"].scrollTop = scrollTop;
    return;
  }
  const groups = new Map();
  for (const group of state.groups || []) groups.set(group.name, []);
  if (!groups.size) groups.set("Personal", []);
  for (const bot of visible) {
    const group = bot.group || "Personal";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(bot);
  }
  for (const [group, bots] of groups) {
    if (state.search && !bots.length) continue;
    const heading = document.createElement("div");
    heading.className = "group-head";
    heading.append(el("span", "group-label", bots.length ? `${group} · ${bots.length}` : group));
    const groupInfo = (state.groups || []).find((item) => item.name === group);
    if (groupInfo && !state.search) {
      const menu = el("button", "group-menu", "⋯");
      menu.type = "button";
      menu.title = `Options for ${group}`;
      menu.setAttribute("aria-label", `Options for the group ${group}`);
      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        openGroupMenu(groupInfo, bots.length);
      });
      heading.append(menu);
    }
    els["bot-list"].append(heading);
    for (const bot of railOrder(bots)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `bot-card${bot.id === state.botId && state.view === "bot" ? " active" : ""}${bot.main ? " main-bot" : ""}`;
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      paintCreature(avatar, bot);
      const main = document.createElement("span");
      main.className = "bot-card-main";
      const name = document.createElement("span");
      name.className = "bot-card-name";
      name.textContent = bot.name;
      if (bot.main) {
        name.append(mainStar("main-mark"));
      }
      const job = document.createElement("span");
      job.className = "bot-card-job";
      job.textContent = bot.busy ? bot.activity || "working" : bot.job;
      main.append(name, job);
      const actions = document.createElement("span");
      actions.className = "bot-card-actions";
      const status = document.createElement("span");
      status.className = `bot-state${bot.busy ? " busy" : ""}${bot.status !== "on" ? " off" : ""}`;
      status.innerHTML = "<i></i>";
      status.title = bot.busy ? bot.activity || "working" : bot.status === "off" ? "paused" : bot.model?.configured ? "model ready" : "needs a model";
      actions.append(status);
      // A filled pin marks a pinned agent; an outline pin shows on hover to pin one.
      const pinToggle = document.createElement("span");
      pinToggle.className = `pin-toggle${bot.pinned ? " on" : ""}`;
      pinToggle.innerHTML = PIN_ICON;
      pinToggle.title = bot.pinned ? "Pinned. Click to unpin" : "Pin to the top";
      pinToggle.addEventListener("click", async (event) => {
        event.stopPropagation();
        await setPinned(bot, !bot.pinned);
      });
      actions.append(pinToggle);
      button.append(avatar, main, actions);
      button.addEventListener("click", () => selectBot(bot.id));
      els["bot-list"].append(button);
    }
  }
  els["bot-list"].scrollTop = scrollTop;
}

function renderMainHero(bot) {
  const host = els["main-hero"];
  host.replaceChildren();
  if (!bot) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "main-hero-card";
  const avatar = document.createElement("span");
  avatar.className = "avatar xl";
  paintCreature(avatar, bot);
  const copy = document.createElement("span");
  copy.className = "main-hero-copy";
  const kicker = document.createElement("span");
  kicker.className = "main-hero-kicker";
  kicker.textContent = bot.main ? "Main agent" : "Your first agent";
  const name = document.createElement("strong");
  name.className = "main-hero-name";
  name.textContent = bot.name;
  const job = document.createElement("span");
  job.className = "main-hero-job";
  job.textContent = bot.busy ? bot.activity || "Working" : bot.job;
  copy.append(kicker, name, job);
  const go = document.createElement("span");
  go.className = "main-hero-go";
  go.textContent = "›";
  button.append(avatar, copy, go);
  button.addEventListener("click", () => selectBot(bot.id));
  host.append(button);
}

async function setBotPaused(bot, paused) {
  try {
    await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { status: paused ? "off" : "on" } });
    await refreshState();
    if (state.bot?.id === bot.id) await reloadBot();
    toast(paused ? `${bot.name} is paused. It still answers you.` : `${bot.name} is back on.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

// Cmd or Ctrl+K opens the agent switcher; "/" jumps to the message box.
function handleShortcut(event) {
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === "k") {
    event.preventDefault();
    if (els["switcher"].open) els["switcher"].close();
    else openSwitcher();
    return;
  }
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  if (typing || document.querySelector("dialog[open]") || state.view !== "bot" || els.composer.hidden || !state.bot) return;
  event.preventDefault();
  els["composer-input"].focus();
}

const switcher = { index: 0, items: [] };

function openSwitcher() {
  if (!state.bots.length || document.querySelector("dialog[open]")) return;
  els["switcher-input"].value = "";
  switcher.index = 0;
  renderSwitcher();
  els["switcher"].showModal();
  els["switcher-input"].focus();
}

function renderSwitcher() {
  const query = els["switcher-input"].value.trim().toLowerCase();
  const matches = railOrder(state.bots).filter((bot) => !query || `${bot.name} ${bot.job} ${bot.group}`.toLowerCase().includes(query));
  // Names that start with the query come first.
  matches.sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)));
  switcher.items = matches;
  switcher.index = Math.min(switcher.index, Math.max(0, matches.length - 1));
  const list = els["switcher-list"];
  list.replaceChildren();
  if (!matches.length) {
    list.append(el("p", "hint switcher-empty", "No agent matches that."));
    els["switcher-input"].removeAttribute("aria-activedescendant");
    return;
  }
  matches.forEach((bot, index) => {
    const row = el("button", `switcher-row${index === switcher.index ? " on" : ""}`);
    row.type = "button";
    row.id = `switcher-row-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === switcher.index));
    const face = el("span", "avatar");
    paintCreature(face, bot);
    const copy = el("span", "switcher-copy");
    copy.append(el("span", "switcher-name", bot.name), el("small", "", bot.status === "off" ? `Paused · ${bot.group || "Personal"}` : `${bot.group || "Personal"} · ${bot.job}`));
    row.append(face, copy);
    if (bot.id === state.botId && state.view === "bot") row.append(el("span", "switcher-here", "Open"));
    row.addEventListener("click", () => chooseSwitcher(bot));
    row.addEventListener("mousemove", () => {
      if (switcher.index === index) return;
      switcher.index = index;
      markSwitcher();
    });
    list.append(row);
  });
  els["switcher-input"].setAttribute("aria-activedescendant", `switcher-row-${switcher.index}`);
}

function markSwitcher() {
  [...els["switcher-list"].children].forEach((row, index) => {
    row.classList.toggle("on", index === switcher.index);
    row.setAttribute("aria-selected", String(index === switcher.index));
  });
  els["switcher-input"].setAttribute("aria-activedescendant", `switcher-row-${switcher.index}`);
  els["switcher-list"].children[switcher.index]?.scrollIntoView({ block: "nearest" });
}

function chooseSwitcher(bot) {
  els["switcher"].close();
  if (bot) selectBot(bot.id);
}

function bindSwitcher() {
  els["switcher-input"].addEventListener("input", () => {
    switcher.index = 0;
    renderSwitcher();
  });
  els["switcher-input"].addEventListener("keydown", (event) => {
    const count = switcher.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!count) return;
      switcher.index = (switcher.index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      markSwitcher();
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseSwitcher(switcher.items[switcher.index]);
    }
  });
}

async function setPinned(bot, pinned) {
  try {
    await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { pinned } });
    await refreshState();
    renderRail();
    toast(pinned ? `${bot.name} pinned.` : `${bot.name} unpinned.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function reorderPinned(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const ordered = railOrder(state.bots).filter((bot) => bot.pinned);
  const from = ordered.findIndex((bot) => bot.id === fromId);
  const to = ordered.findIndex((bot) => bot.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  state.bots = state.bots.map((bot) => {
    const index = ordered.findIndex((item) => item.id === bot.id);
    return index >= 0 ? { ...bot, pinnedOrder: index + 1 } : bot;
  });
  renderRail();
  try {
    await api("/api/pins", { method: "POST", body: { ids: ordered.map((bot) => bot.id) } });
    await refreshState();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderHeader() {
  const bot = state.bot;
  if (bot) paintCreature(els["thread-avatar"], { ...bot, busy: bot.busy || state.runtime.busy });
  else clearAvatar(els["thread-avatar"]);
  els["thread-avatar"].classList.toggle("empty", !bot);
  els["thread-name"].textContent = bot ? bot.name : "Ravnir";
  els["thread-job"].textContent = bot ? bot.job : "Pick an agent on the left, or make one.";
  if (bot) paintCreature(els["profile-avatar"], bot);
  else clearAvatar(els["profile-avatar"], "T");
  els["profile-avatar"].classList.toggle("empty", !bot);
  els["profile-job"].textContent = bot ? bot.job : "A teammate on this server";
  els["profile-label"].textContent = bot ? bot.group || "Personal" : "Personal";
  els["online-chip"].hidden = !bot;
  syncStatusChip();
  els["main-chip"].hidden = !bot?.main;
  renderModelChip(bot);
  els["computer-name"].textContent = bot ? bot.name : "Your agent";
  els["computer-caption"].textContent = state.browser?.url && state.browser.url !== "about:blank"
    ? shortUrl(state.browser.url)
    : bot ? "Ready" : "Not started";
  els["computer-dot"].classList.toggle("bad", Boolean(state.browser && !state.browser.available));
  els["empty-thread"].hidden = Boolean(bot);
  els.composer.hidden = !bot;
  window.RavnirVoice?.sync(bot);
  window.RavnirAttach?.switchBot(bot?.id || "");
}

// The provider's logo and the short model name; the full id on hover. Opens the agent's settings.
function renderModelChip(bot) {
  const chip = els["model-chip"];
  chip.replaceChildren();
  chip.title = bot?.model?.model ? `${bot.model.model}. Change the model in the agent's settings.` : "";
  if (!bot) {
    chip.textContent = "No agent";
    return;
  }
  if (!bot.model.model) {
    chip.textContent = "Choose a model";
    return;
  }
  if (bot.model.logo && window.RavnirModels?.providerMark) chip.append(window.RavnirModels.providerMark({ logo: bot.model.logo }, "mdl-mark tiny"));
  else chip.append(el("span", "chip-prefix", bot.model.provider === "opencode" ? "OpenCode · " : "API · "));
  chip.append(shortModel(bot.model.model));
}

// Green when on, amber while it works, grey when off.
function syncStatusChip() {
  const bot = state.bot;
  const busy = Boolean(bot && (bot.busy || state.runtime.busy));
  const off = Boolean(bot && bot.status && bot.status !== "on");
  const chip = els["online-chip"];
  chip.classList.toggle("busy", busy);
  chip.classList.toggle("off", off && !busy);
  const label = busy ? "working" : off ? "paused" : "on";
  chip.querySelector(".online-text").textContent = label;
  chip.title = label.charAt(0).toUpperCase() + label.slice(1);
  // Under the name, like a messaging app: typing while it works. The phone has
  // no room for the job, so it says whether the agent is there instead.
  const line = els["thread-job"];
  if (!bot) return;
  const waiting = busy && state.approvals.length > 0;
  line.textContent = waiting ? "waiting for you" : busy ? "typing…" : isPhone() ? (off ? "paused" : "online") : bot.job;
  line.classList.toggle("typing-now", busy);
}

function renderThreadState() {
  syncStatusChip();
  const busy = Boolean(state.runtime.busy);
  const waiting = state.approvals.length > 0;
  window.RavnirAvatar?.setState(els["thread-avatar"], creatureMood({ ...state.bot, busy }));
  els["activity-bar"].hidden = !busy;
  els["stop-btn"].hidden = !busy;
  els["activity-text"].textContent = waiting
    ? "Waiting for your approval"
    : state.showThinking ? state.runtime.activity || "Working" : "Working";
  if (busy) {
    const started = state.runtime.startedAt || Date.now();
    els["activity-time"].textContent = `${Math.max(1, Math.round((Date.now() - started) / 1000))}s`;
  }
  syncThreadToggles();
}

function setShowThinking(on) {
  state.showThinking = Boolean(on);
  writeStored("ravnir.showThinking", state.showThinking ? "1" : "0");
  syncThreadToggles();
  renderMessages();
}

function setShowDiffs(on) {
  state.showDiffs = Boolean(on);
  writeStored("ravnir.showDiffs", state.showDiffs ? "1" : "0");
  syncThreadToggles();
  renderMessages();
}

function syncThreadToggles() {
  window.syncSettingsPage?.();
  els["toggle-thinking"].classList.toggle("on", state.showThinking);
  els["toggle-diffs"].classList.toggle("on", state.showDiffs);
  els["toggle-thinking"].setAttribute("aria-pressed", state.showThinking ? "true" : "false");
  els["toggle-diffs"].setAttribute("aria-pressed", state.showDiffs ? "true" : "false");
}

// A soft two-note pop when an agent replies (not for its quick plan line), only if
// turned on in Settings. Made with Web Audio so there is no
// file to load. Browsers only allow sound after a tap or key press, so the audio
// is unlocked on the first one.
const audio = { context: null };
function unlockAudio() {
  try {
    audio.context ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.context.state === "suspended") audio.context.resume();
  } catch {
    // No Web Audio: replies stay silent.
  }
}
document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("keydown", unlockAudio);

function replySound() {
  const context = audio.context;
  if (!state.sound || !context || context.state !== "running" || document.hidden) return;
  const now = Date.now();
  if (now - (audio.lastAt || 0) < 1200) return;
  audio.lastAt = now;
  const start = context.currentTime + 0.01;
  for (const [offset, frequency] of [[0, 784], [0.085, 1175]]) {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.09, start + offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
    tone.connect(gain).connect(context.destination);
    tone.start(start + offset);
    tone.stop(start + offset + 0.18);
  }
}

function setSound(on) {
  state.sound = Boolean(on);
  writeStored("ravnir.replySound", state.sound ? "1" : "0");
  window.syncSettingsPage?.();
  if (state.sound) {
    unlockAudio();
    audio.lastAt = 0;
    replySound();
  }
}

// While the agent works it types, like a person: a bubble with three dots.
function renderWorking() {
  const bubble = el("div", "msg assistant typing-bubble");
  const dots = el("span", "working-dots");
  dots.innerHTML = "<i></i><i></i><i></i>";
  bubble.append(dots);
  const note = state.approvals.length
    ? "Waiting for your approval"
    : state.showThinking && state.runtime.activity && state.runtime.activity !== "Thinking" ? state.runtime.activity : "";
  return chatRow("them", bubble, { speaker: state.bot, key: "typing", meta: note });
}

// Faces in the thread survive its redraws (every poll), so their eyes, blinks and moods carry on.
const facePool = new Map();
function threadFace(className, key) {
  const kept = key && facePool.get(key);
  if (kept) facePool.delete(key);
  const node = kept || el("span", className);
  if (key) node.dataset.faceKey = key;
  return node;
}

// One line of the thread. The agent's face sits beside its bubbles; a run of
// bubbles from the same sender shows the face and the time once, at the end.
function chatRow(side, bubble, { speaker = null, name = "", at = 0, key = "", meta = "", copy = "" } = {}) {
  const row = el("div", `chat-row ${side}`);
  row.dataset.speaker = side === "me" ? "me" : speaker?.id || name || "agent";
  if (at) row.dataset.at = String(at);
  if (key) row.dataset.key = key;
  if (side === "them") {
    const face = threadFace("avatar chat-face", key && `row:${key}`);
    if (speaker) paintCreature(face, speaker);
    else clearAvatar(face, initials(name || "Agent"));
    row.append(face);
    const other = Boolean(speaker && speaker.id !== state.bot?.id);
    if (other) row.style.setProperty("--bot-tint", botTint(speaker));
    if (name || other) row.append(el("span", "chat-name", name || speaker.name));
  }
  const text = String(copy || "").trim();
  // On a computer the button appears beside the bubble on hover; on a phone it sits in the line under it.
  if (text) bubble.append(copyButton(text, "hover"));
  row.append(bubble);
  const note = meta || (at ? clockTime(at) : "");
  if (note) {
    const line = el("span", "chat-meta", note);
    if (text) line.append(copyButton(text, "line"));
    row.append(line);
  }
  return row;
}

const COPY_ICON = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2"></rect><path d="M4 12.5V5a1.5 1.5 0 0 1 1.5-1.5H12"></path></svg>';
const TICK_ICON = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 10.5 3.6 3.6 7.4-8"></path></svg>';

function copyButton(text, where) {
  const button = el("button", `copy-btn ${where}`);
  button.type = "button";
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy this message");
  button.innerHTML = COPY_ICON;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await copyText(text, "Copied.");
    button.innerHTML = TICK_ICON;
    button.classList.add("done");
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove("done");
    }, 1400);
  });
  return button;
}

// The agent's colour tints its bubbles. Dark colours are lifted first so the
// text on them stays as easy to read as on the pastel ones.
function botTint(bot) {
  let hex = (normalizeLook(bot?.avatar, bot?.color).color || normalizeColor(bot?.color)).slice(1);
  if (hex.length === 3) hex = [...hex].map((digit) => digit + digit).join("");
  const value = parseInt(hex, 16);
  const rgb = [value >> 16, (value >> 8) & 255, value & 255];
  const light = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const lift = Math.max(0, 0.72 - light) * 0.9;
  return `#${rgb.map((channel) => Math.round(channel + (255 - channel) * lift).toString(16).padStart(2, "0")).join("")}`;
}

// Consecutive bubbles from one sender within a few minutes read as one run.
function groupRuns(host) {
  const rows = [...host.children];
  rows.forEach((row, index) => {
    const next = rows[index + 1];
    if (!row.classList.contains("chat-row")) return;
    const joined = Boolean(next?.classList.contains("chat-row"))
      && next.dataset.speaker === row.dataset.speaker
      && (!row.dataset.at || !next.dataset.at || Number(next.dataset.at) - Number(row.dataset.at) < 3 * 60_000);
    row.classList.toggle("cont", joined);
  });
}

// The thread re-renders on every poll, so only bubbles it has never shown pop in.
function markFresh(host) {
  const seen = state.seenRows;
  const first = seen.botId !== state.bot.id;
  if (first) {
    seen.botId = state.bot.id;
    seen.keys = new Set();
  }
  for (const row of host.querySelectorAll(":scope > .chat-row[data-key]")) {
    const keys = row.dataset.key.split("\n");
    const known = keys.some((key) => seen.keys.has(key));
    for (const key of keys) seen.keys.add(key);
    if (!first && !known) row.classList.add("enter");
  }
  if (!state.runtime.busy) {
    seen.keys.delete("typing");
    seen.keys.delete("live");
  }
}

// Show who you tapped right away; the thread fills in when it loads.
function previewBot(bot) {
  paintCreature(els["thread-avatar"], bot);
  els["thread-name"].textContent = bot.name;
  els["thread-job"].textContent = isPhone() ? "" : bot.job;
  els["thread-job"].classList.remove("typing-now");
  els["main-chip"].hidden = !bot.main;
  els["empty-thread"].hidden = true;
  els.composer.hidden = false;
  els.messages.replaceChildren(contactCard(bot));
}

function contactCard(bot = state.bot) {
  const card = el("div", "contact-card");
  const face = threadFace("avatar contact-face", bot?.id && `contact:${bot.id}`);
  paintCreature(face, bot);
  card.append(face, el("strong", "contact-name", bot.name));
  if (bot.job) card.append(el("span", "contact-job", bot.job));
  card.append(el("span", "contact-meta", `${bot.group || "Personal"} · on this server`));
  return card;
}

// A choice card (public/choices.js) is answered by the first user message after it, or by one
// still sending. Only replies that hold a choice block are looked up.
let choiceAnswers = new Map();
function answersAfterChoices() {
  const answers = new Map();
  let open = [];
  for (const message of state.conversation) {
    if (message.role === "user") {
      for (const id of open) answers.set(id, message.content || "");
      open = [];
    } else if (message.role === "assistant" && message.id && /```choice\b/.test(message.content || "")) {
      open.push(message.id);
    }
  }
  if (open.length && state.pendingUsers.length) {
    for (const id of open) answers.set(id, state.pendingUsers[0].text || "");
  }
  return answers;
}

function renderMessages() {
  const host = els.messages;
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 120;
  facePool.clear();
  for (const node of host.querySelectorAll("[data-face-key]")) facePool.set(node.dataset.faceKey, node);
  host.replaceChildren();
  if (!state.bot) {
    return;
  }
  host.style.setProperty("--bot-tint", botTint(state.bot));
  host.append(contactCard());
  let rendered = 0;
  let lastAt = 0;
  // A time label at the top, after a pause, and when the day changes, like Messages.
  const stamp = (message) => {
    if (!message.at) return;
    const gap = message.at - lastAt;
    if (!lastAt || gap > 30 * 60_000 || new Date(message.at).toDateString() !== new Date(lastAt).toDateString()) {
      host.append(el("div", "day-label", stampLabel(message.at)));
    }
    lastAt = message.at;
  };
  // A tool result carries no arguments, so read them back from the call that asked for it.
  const callArgs = new Map();
  for (const message of state.conversation) {
    for (const call of message.toolCalls || []) if (call?.id) callArgs.set(call.id, call.arguments || {});
  }
  choiceAnswers = answersAfterChoices();
  for (const message of state.conversation) {
    if (message.role === "tool") {
      if (!state.showThinking) continue;
      stamp(message);
      host.append(renderToolMessage(message, callArgs.get(message.toolCallId)));
      rendered += 1;
      continue;
    }
    if (message.role === "assistant" && !message.content && message.toolCalls?.length) continue;
    stamp(message);
    host.append(renderMessage(message));
    rendered += 1;
  }
  for (const { text: pendingText, files } of state.pendingUsers) {
    const pending = el("article", "msg user pending");
    addAttachments(pending, files);
    if (pendingText) {
      const body = el("div", "msg-body");
      renderMarkdown(body, pendingText);
      pending.append(body);
    }
    host.append(chatRow("me", pending, { key: userKey(pendingText, files), meta: "Sending…" }));
    rendered += 1;
  }
  for (const item of state.turnItems) {
    if (item.type === "assistant") {
      // The typing bubble covers the wait before the first word.
      if (!item.text) continue;
      const article = el("article", "msg assistant live");
      const body = el("div", "msg-body");
      const { rich } = renderMarkdown(body, item.text, { streaming: true, context: { live: true } });
      article.append(body);
      const row = chatRow("them", article, { speaker: state.bot, key: `live\nt:${item.text.trim()}` });
      if (rich) row.classList.add("wide");
      host.append(row);
      rendered += 1;
    } else if (item.type === "artifact") {
      const row = artifactCards([item.artifact]);
      row.classList.add("live");
      host.append(row);
      rendered += 1;
    } else if (item.type === "tool") {
      if (!state.showThinking) continue;
      host.append(renderToolItem(item));
      rendered += 1;
    } else if (item.type === "computer") {
      host.append(renderComputerItem(item));
      rendered += 1;
    }
  }
  if (state.showDiffs && state.turnDiffs.length) {
    for (const diff of state.turnDiffs) {
      const card = document.createElement("article");
      card.className = "diff-card thread-diff";
      const head = document.createElement("div");
      head.className = "diff-head";
      const path = document.createElement("span");
      path.className = "diff-path";
      path.textContent = diff.path;
      const stats = document.createElement("span");
      stats.className = "diff-stats";
      stats.textContent = `+${diff.additions || 0} −${diff.deletions || 0}`;
      head.append(path, stats);
      card.append(head, buildPatch(diff.patch));
      host.append(card);
      rendered += 1;
    }
  }
  if (state.runtime.busy) {
    host.append(renderWorking());
    rendered += 1;
  }
  if (state.error) {
    const error = document.createElement("div");
    error.className = "msg-error";
    error.textContent = state.error;
    host.append(error);
    rendered += 1;
  }
  if (!rendered) {
    host.append(renderIntro());
    const suggestions = document.createElement("div");
    suggestions.className = "suggestions";
    for (const text of ["What are you working on?", "Open example.com and tell me what you see.", "Create a file called notes.md in your workspace."]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = text;
      button.addEventListener("click", () => {
        els["composer-input"].value = text;
        els["composer-input"].focus();
        autoGrow();
      });
      suggestions.append(button);
    }
    host.append(suggestions);
  }
  groupRuns(host);
  markFresh(host);
  if (nearBottom || state.conversation.length < 4) host.scrollTop = host.scrollHeight;
  // Something new landed while the user reads further up: offer a way back down.
  const seen = `${state.bot.id}:${state.conversation.length}`;
  const arrived = state.jump.seen.startsWith(`${state.bot.id}:`) && state.jump.seen !== seen;
  state.jump.seen = seen;
  syncJump(arrived && !nearBottom);
}

// The "↓ Latest" button above the composer, shown when the thread is scrolled away from the end.
function syncJump(arrived = false) {
  const host = els.messages;
  const away = Boolean(state.bot) && host.scrollHeight - host.scrollTop - host.clientHeight > 240;
  if (!away) state.jump.fresh = false;
  else if (arrived) state.jump.fresh = true;
  els["jump-latest"].hidden = !away;
  els["jump-latest"].classList.toggle("fresh", state.jump.fresh);
  // Sit above the approval card when one is open over the composer.
  const bar = els["permission-bar"];
  els["jump-latest"].style.top = away && !bar.hidden ? `${bar.offsetTop - els.composer.offsetTop - 42}px` : "";
  els["jump-label"].textContent = state.jump.fresh ? "New reply" : "Latest";
}

function renderIntro() {
  const article = el("article", "msg assistant");
  const body = el("div", "msg-body");
  renderMarkdown(body, `Hi, I'm ${state.bot.name}. ${state.bot.job}\n\nMy computer is on this server, so I keep working when your browser is closed.`);
  article.append(body);
  return chatRow("them", article, { speaker: state.bot, key: "intro" });
}

// The same key for a message while it sends and once it lands, so the bubble does not pop in twice.
function userKey(text, files = []) {
  return `u:${String(text || "").trim()}${files?.length ? `|${files.map((file) => file.id).join(",")}` : ""}`;
}

// Photos and files under a user's bubble (public/attach.js draws them).
function addAttachments(article, files) {
  if (!files?.length || !window.RavnirAttach) return;
  article.classList.add("has-files");
  article.append(window.RavnirAttach.block(files, state.bot?.id || ""));
}

// True when nearly every word of the reply is already in the question card
// (its question, what it needs and what was tried), so the bubble adds nothing.
function repeatsQuestion(content, asks) {
  const words = (text) => String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[\p{L}\p{N}]{3,}/gu) || [];
  const reply = words(content);
  if (reply.length < 4) return false;
  const card = new Set(asks.flatMap((ask) => [...words(ask.question), ...words(ask.need), ...words(ask.tried)]));
  const covered = reply.filter((word) => card.has(word)).length;
  return covered / reply.length >= 0.8;
}

function renderMessage(message) {
  const article = document.createElement("article");
  if (message.role === "user") {
    // Routines and tasks handed over from voice mode read as a quiet line, not as the user's bubble.
    if (message.source === "job" || message.source === "voice") {
      const line = document.createElement("div");
      line.className = "system-line";
      const pill = document.createElement("span");
      pill.className = "routine-pill";
      pill.textContent = message.source === "voice" ? "Passed to the agent" : `Routine · ${message.jobName || "scheduled job"}`;
      const prompt = document.createElement("span");
      prompt.className = "routine-prompt";
      prompt.textContent = message.display || message.content || "";
      line.append(pill, prompt);
      return line;
    }
    article.className = "msg user";
    const body = document.createElement("div");
    body.className = "msg-body";
    if (message.source === "proposal") {
      article.classList.add("from-proposal");
      article.append(el("span", "msg-source", "Approved suggestion"));
      renderMarkdown(body, String(message.content || "").replace(/^Approved suggestion:\s*/i, ""));
    } else renderMarkdown(body, message.content || "");
    addAttachments(article, message.attachments);
    if (message.content || !message.attachments?.length) article.append(body);
    const row = chatRow("me", article, { at: message.at, key: userKey(message.content, message.attachments), copy: message.content });
    if (message.mentions?.length) row.insertBefore(mentionChips(message.mentions), row.querySelector(".chat-meta"));
    if (message.via === "voice") row.querySelector(".chat-meta")?.prepend(viaVoiceMark());
    return row;
  }
  article.className = `msg assistant${message.kind === "ack" ? " ack" : ""}${message.notice === "cap" ? " cap-notice" : ""}${message.quiet ? " quiet" : ""}`;
  if (message.notice === "cap") article.append(el("span", "cap-notice-label", "Spending cap"));
  if (message.quiet) article.append(el("span", "quiet-label", "No news"));
  const body = document.createElement("div");
  body.className = "msg-body";
  const { rich } = renderMarkdown(body, message.content || "", {
    context: { key: `choice:${message.id}`, answer: choiceAnswers.get(message.id) },
  });
  article.append(body);
  const key = `m:${message.id}\nt:${String(message.content || "").trim()}`;
  let row;
  if (message.kind === "mention") {
    const speaker = state.bots.find((bot) => bot.id === message.fromBotId);
    const name = `${speaker?.name || message.fromBotName || "A teammate"} · tagged reply`;
    row = chatRow("them", article, { speaker: speaker || null, name, at: message.at, key, copy: message.content });
  } else {
    row = chatRow("them", article, { speaker: state.bot, at: message.at, key, copy: message.content });
  }
  if (rich) row.classList.add("wide");
  if (message.turnId) row.dataset.turn = message.turnId;
  if (message.artifacts?.length) row.insertBefore(artifactCards(message.artifacts), row.querySelector(".chat-meta"));
  if (message.asks?.length && window.RavnirQuestions) {
    const choice = /```choice/.test(message.content || "");
    // The card already says it: a reply that only repeats the question stays out of the way.
    if (!choice && repeatsQuestion(message.content, message.asks)) article.classList.add("repeats-ask");
    const cards = el("div", "ask-stack");
    for (const ask of message.asks) {
      cards.append(RavnirQuestions.card(ask, { open: RavnirQuestions.isOpen(ask, message, state.conversation), compact: choice }));
    }
    const holder = row.querySelector(".art-row");
    if (holder) holder.append(cards);
    else row.insertBefore(cards, row.querySelector(".chat-meta"));
  }
  if (message.suggestions?.length && window.RavnirSuggestions) {
    const cards = el("div", "sugg-stack");
    for (const suggestion of message.suggestions) {
      // The live copy says whether it is still open and whether its plugin is connected.
      const live = (state.suggestions || []).find((item) => item.id === suggestion.id);
      cards.append(RavnirSuggestions.card(live || { ...suggestion, status: suggestion.status || "accepted" }));
    }
    // One grid cell holds the extras: a second stack in it would draw on top of the first.
    const holder = row.querySelector(".art-row") || row.querySelector(":scope > .ask-stack");
    if (holder) holder.append(cards);
    else row.insertBefore(cards, row.querySelector(".chat-meta"));
  }
  if (message.sources?.length) {
    const chips = sourceChips(message.sources);
    const extra = row.querySelector(".art-row") || row.querySelector(".ask-stack") || row.querySelector(".sugg-stack");
    if (extra) extra.append(chips);
    else row.insertBefore(chips, row.querySelector(".chat-meta"));
  }
  const proof = message.turnId || message.cost ? proofLine(message) : null;
  if (proof) row.insertBefore(proof, row.querySelector(".chat-meta"));
  return row;
}

// What is behind a reply, and what it cost. The open ones are remembered because the thread
// redraws on every poll.
const openProofs = new Set();
const proofCache = new Map();

function costText(cost) {
  const tokens = Number(cost.tokens) || 0;
  const billing = cost.billing || "none";
  if (billing === "metered") return `${money(cost.cost)} · ${tokenLabel(tokens)}`;
  if (billing === "free") return `Free model · ${tokenLabel(tokens)}`;
  if (billing === "plan") return `${tokenLabel(tokens)} · no price reported`;
  if (tokens) return tokenLabel(tokens);
  return "";
}

function costDetail(cost) {
  const detail = el("dl", "cost-detail");
  const usage = cost.usage || {};
  for (const [name, value] of [["Input", usage.input], ["Output", usage.output], ["Reasoning", usage.reasoning], ["Cache read", usage.cacheRead], ["Cache write", usage.cacheWrite]]) {
    if (value) detail.append(el("dt", "", name), el("dd", "", exactNumber(value)));
  }
  if (cost.model) detail.append(el("dt", "", "Model"), el("dd", "", shortModel(cost.model)));
  return detail;
}

// What is behind a reply: the notes it cited, the tools it ran, the files it changed, the
// approvals it asked for, and what it cost. The counts show immediately; the detail is fetched
// once per turn from /api/turns/:id/proof, so the thread poll stays small.
function proofLine(message) {
  const cost = message.cost || null;
  const turnId = cost?.turnId || message.turnId || "";
  const sourceCount = Array.isArray(message.sources) ? message.sources.length : 0;
  const key = turnId || `proof:${sourceCount}:${cost?.tokens || 0}:${cost?.cost || 0}`;
  const wrap = el("div", "cost-wrap proof-wrap");
  const line = el("button", "cost-line proof-line");
  line.type = "button";
  const panel = el("div", "proof-panel");
  panel.hidden = !openProofs.has(key);
  line.setAttribute("aria-expanded", String(!panel.hidden));

  const label = (proof) => {
    const parts = [];
    const sources = proof?.sources?.length || sourceCount;
    if (sources) parts.push(`${sources} source${sources === 1 ? "" : "s"}`);
    if (proof?.actions?.length) parts.push(`${proof.actions.length} action${proof.actions.length === 1 ? "" : "s"}`);
    if (proof?.approvals?.length) parts.push(`${proof.approvals.length} approval${proof.approvals.length === 1 ? "" : "s"}`);
    if (proof?.diffs?.length) parts.push(`${proof.diffs.length} file${proof.diffs.length === 1 ? "" : "s"} changed`);
    const spend = cost ? costText(cost) : "";
    if (spend) parts.push(spend);
    return parts.length ? `Proof · ${parts.join(" · ")}` : "Proof";
  };
  line.textContent = label(proofCache.get(key)?.data || null);

  let loading = false;
  const load = async () => {
    if (loading) return;
    if (!turnId) {
      panel.replaceChildren();
      if (cost) {
        const section = el("div", "proof-section");
        section.append(el("p", "proof-title", "Cost"), el("p", "proof-cost", costText(cost)), costDetail(cost));
        panel.append(section);
      } else {
        panel.append(el("p", "hint", "No proof was recorded for this reply."));
      }
      return;
    }
    loading = true;
    const cached = proofCache.get(key);
    if (cached?.data) {
      drawProof(panel, cached.data, { cost, sources: message.sources });
      line.textContent = label(cached.data);
      return;
    }
    if (cached?.error) {
      panel.replaceChildren(el("p", "hint", cached.error));
      return;
    }
    panel.replaceChildren(el("p", "hint", "Loading the proof…"));
    try {
      const proof = await api(`/api/turns/${encodeURIComponent(turnId)}/proof`);
      proofCache.set(key, { data: proof });
      line.textContent = label(proof);
      drawProof(panel, proof, { cost, sources: message.sources });
    } catch (error) {
      proofCache.set(key, { error: error.message });
      panel.replaceChildren(el("p", "hint", error.message));
    } finally {
      loading = false;
    }
  };

  line.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    line.setAttribute("aria-expanded", String(!panel.hidden));
    if (panel.hidden) {
      openProofs.delete(key);
      return;
    }
    openProofs.add(key);
    load();
  });
  if (!panel.hidden) load();
  wrap.append(line, panel);
  return wrap;
}

function drawProof(panel, proof, { cost = null } = {}) {
  panel.replaceChildren();
  const turn = proof.turn || {};
  const spend = cost || {
    turnId: turn.id,
    usage: turn.usage || {},
    tokens: turn.tokens || 0,
    cost: turn.cost || 0,
    model: turn.model || "",
    provider: turn.provider || "",
    billing: turn.billing || "none",
  };
  const spendText = costText(spend);
  if (spendText) {
    const section = el("div", "proof-section");
    section.append(el("p", "proof-title", "Cost"), el("p", "proof-cost", spendText), costDetail(spend));
    panel.append(section);
  }
  if (proof.sources?.length) {
    const section = el("div", "proof-section");
    section.append(el("p", "proof-title", `Sources (${proof.sources.length})`));
    const list = el("div", "proof-list");
    for (const source of proof.sources) {
      const row = el("div", "proof-row");
      const open = el("button", "proof-link", source.path);
      open.type = "button";
      open.title = "Open this note";
      open.addEventListener("click", () => window.RavnirMemory?.openNote?.(source.path));
      row.append(open);
      if (source.date) row.append(el("span", "proof-muted", shortDate(Date.parse(source.date) || source.date)));
      if (source.commit) {
        const commit = el("button", "proof-link", source.commit.short || String(source.commit.hash || "").slice(0, 7));
        commit.type = "button";
        commit.title = source.commit.subject || "The last change to this note";
        commit.addEventListener("click", () => window.RavnirMemory?.openCommit?.(source.commit.hash));
        row.append(el("span", "proof-muted", "last changed by"), commit);
        if (source.commit.turnId) {
          const from = el("button", "proof-link", "the turn");
          from.type = "button";
          const author = state.bots.find((bot) => bot.name === source.commit.author);
          from.addEventListener("click", () => jumpToTurn(source.commit.turnId, author?.id || state.bot?.id));
          row.append(from);
        }
      } else if (source.hash) {
        row.append(el("span", "proof-muted", `version ${String(source.hash).slice(0, 7)}`));
      }
      list.append(row);
    }
    section.append(list);
    panel.append(section);
  }
  if (proof.actions?.length) {
    const section = el("div", "proof-section");
    section.append(el("p", "proof-title", `Actions (${proof.actions.length})`));
    for (const action of proof.actions) {
      const item = el("details", "proof-action");
      const summary = el("summary", "proof-action-line");
      const { verb, arg } = toolSummary(action);
      summary.append(el("span", `proof-action-status${action.status === "error" ? " bad" : ""}`, action.status === "error" ? "Failed" : action.status === "running" ? "Working" : "Done"));
      summary.append(el("span", "proof-action-name", `${verb}${arg ? ` ${arg}` : ""}`));
      item.append(summary);
      if (action.input && Object.keys(action.input).length) item.append(el("pre", "proof-pre", JSON.stringify(action.input, null, 2).slice(0, 1600)));
      if (action.output) item.append(el("pre", "proof-pre", action.output));
      section.append(item);
    }
    panel.append(section);
  }
  if (proof.diffs?.length) {
    const section = el("div", "proof-section");
    section.append(el("p", "proof-title", `Files changed (${proof.diffs.length})`));
    for (const diff of proof.diffs) {
      const item = el("details", "proof-action");
      const summary = el("summary", "proof-action-line");
      summary.append(el("span", "proof-action-name", diff.path));
      summary.append(el("span", "proof-muted", `+${diff.additions || 0} −${diff.deletions || 0}`));
      item.append(summary);
      if (diff.patch) item.append(el("pre", "proof-pre", diff.patch));
      section.append(item);
    }
    panel.append(section);
  }
  if (proof.approvals?.length) {
    const section = el("div", "proof-section");
    section.append(el("p", "proof-title", `Approvals (${proof.approvals.length})`));
    for (const approval of proof.approvals) {
      const row = el("div", "proof-row");
      row.append(el("span", "proof-approval-title", approval.title || "Approval"));
      const stateText = approval.status === "approved" ? "Allowed" : approval.status === "rejected" ? "Denied" : approval.status || "";
      if (stateText) row.append(el("span", "proof-muted", stateText));
      if (approval.decidedAt) row.append(el("span", "proof-muted", shortDate(approval.decidedAt)));
      section.append(row);
      if (approval.detail) section.append(el("pre", "proof-pre", approval.detail));
    }
    panel.append(section);
  }
  if (proof.steps?.length) {
    const section = el("div", "proof-section");
    section.append(el("p", "proof-title", `Screen steps (${proof.steps.length})`));
    for (const step of proof.steps) {
      const row = el("div", "proof-row");
      row.append(el("span", "proof-step", `Step ${step.step || "?"}`));
      if (step.action) row.append(el("span", "proof-muted", step.action));
      if (step.shot) {
        const link = el("a", "proof-link", "Screenshot");
        link.href = step.shot;
        link.target = "_blank";
        link.rel = "noopener";
        row.append(link);
      }
      section.append(row);
    }
    panel.append(section);
  }
  if (!panel.childElementCount) panel.append(el("p", "hint", "No proof was recorded for this turn."));
}

async function jumpToTurn(turnId, botId = state.bot?.id) {
  if (!turnId) return;
  if (botId && botId !== state.bot?.id) await selectBot(botId);
  const find = () => els.messages?.querySelector(`[data-turn="${CSS.escape(turnId)}"]`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = find();
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("turn-flash");
      setTimeout(() => find()?.classList.remove("turn-flash"), 1800);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// "From your notes": the vault notes a reply cites, with the date and version the agent read
// (server/vault/context.js citedSources). Two agents answering from one note show the same chip.
function sourceChips(sources) {
  const row = el("div", "source-row");
  row.append(el("span", "source-row-label", "From your notes"));
  for (const source of sources) {
    const chip = el("button", "source-chip");
    chip.type = "button";
    chip.append(el("span", "source-path", source.path));
    const at = Date.parse(source.date) || Number(source.date) || 0;
    if (at) chip.append(el("span", "source-date", shortDate(at)));
    chip.title = `Open ${source.path}${source.hash ? `, version ${String(source.hash).slice(0, 7)}` : ""}`;
    chip.addEventListener("click", () => window.RavnirMemory?.openNote?.(source.path));
    row.append(chip);
  }
  return row;
}

// The Saved tab: every artifact this agent made, newest first (public/artifacts.js draws the grid).
function renderSaved() {
  const host = $("saved-body");
  if (!state.bot || !host) return;
  const gallery = window.RavnirArtifacts?.gallery?.(state.bot.id);
  host.replaceChildren(gallery || el("p", "hint", "Saved work is not available in this browser."));
}

// Work saved as artifacts (server/artifacts.js) shows as cards under the reply; public/artifacts.js draws them.
function artifactCards(refs) {
  const box = el("div", "art-row");
  for (const ref of refs) {
    const card = window.RavnirArtifacts?.card?.(ref, { botId: state.bot.id });
    if (card) box.append(card);
    else {
      const plain = el("button", "ghost", ref.title || "Artifact");
      plain.type = "button";
      plain.addEventListener("click", () => window.open(`/api/bots/${state.bot.id}/artifacts/${ref.id}/raw`, "_blank", "noopener"));
      box.append(plain);
    }
  }
  return box;
}

// A small mic in front of the time on messages that were spoken, not typed.
function viaVoiceMark() {
  const mark = el("span", "via-mark");
  mark.innerHTML = '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="7.5" y="2.5" width="5" height="9" rx="2.5"></rect><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"></path></svg>';
  mark.title = "Sent by voice";
  mark.setAttribute("aria-label", "Sent by voice");
  return mark;
}

function mentionChips(mentions) {
  const row = document.createElement("div");
  row.className = "mention-row";
  row.append(el("span", "mention-row-label", "Tagged"));
  for (const mention of mentions) {
    const bot = state.bots.find((item) => item.id === mention.botId);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mention-chip";
    const avatar = el("span", "avatar xs");
    if (bot) paintCreature(avatar, bot);
    else clearAvatar(avatar, initials(mention.name));
    chip.append(avatar, el("span", "", bot?.name || mention.name));
    if (bot) chip.addEventListener("click", () => selectBot(bot.id));
    else chip.disabled = true;
    row.append(chip);
  }
  return row;
}

function renderToolMessage(message, input) {
  return renderToolItem({
    type: "tool",
    id: message.id,
    name: message.name || "tool",
    status: "completed",
    input,
    output: message.content || "",
  });
}

// What a tool did, in plain words, so a card reads without being opened.
const TOOL_ALIASES = {
  bash: "run_command", shell: "run_command", websearch: "web_search", webfetch: "web_fetch",
  read: "read_file", write: "write_file", edit: "edit_file", glob: "find_files", grep: "search_files",
  list: "list_files", ls: "list_files", task: "subtask", todowrite: "todo", todoread: "todo",
  apply_patch: "patch", patch: "patch",
};
const TOOL_WORDS = {
  run_command: { done: "Ran", doing: "Running", keys: ["command", "cmd"], bare: "Ran a command", code: true },
  web_search: { done: "Searched the web for", doing: "Searching the web for", keys: ["query", "q"], bare: "Searched the web" },
  web_fetch: { done: "Opened", doing: "Opening", keys: ["url"], kind: "url", bare: "Opened a page", code: true },
  web_research: { done: "Researched", doing: "Researching", keys: ["query", "topic"], bare: "Researched a question" },
  browser_open: { done: "Opened", doing: "Opening", keys: ["url"], kind: "url", bare: "Opened a page", code: true },
  browser_read: { done: "Read the page", doing: "Reading the page", keys: [] },
  browser_click: { done: "Clicked", doing: "Clicking", keys: ["text", "selector"], bare: "Clicked on the page", code: true },
  browser_type: { done: "Typed into", doing: "Typing into", keys: ["selector"], bare: "Typed on the page", code: true },
  browser_key: { done: "Pressed", doing: "Pressing", keys: ["key"], bare: "Pressed a key", code: true },
  browser_smart_click: { done: "Picked a click for", doing: "Picking a click for", keys: ["goal", "intent", "query"], bare: "Picked a click" },
  computer_task: { done: "Used the browser to", doing: "Using the browser to", keys: ["goal"], bare: "Used the browser" },
  desktop_task: { done: "Used the desktop to", doing: "Using the desktop to", keys: ["goal"], bare: "Used the desktop" },
  computer_step: { done: "Took the next step", doing: "Taking the next step", keys: [], bare: "Took the next step" },
  jev_choose: { done: "Asked Jev to choose", doing: "Asking Jev to choose", keys: ["question", "prompt", "goal"] },
  browser_saved_login: { done: "Signed in to", doing: "Signing in to", keys: ["site", "url"], kind: "url", bare: "Used a saved login", code: true },
  list_saved_logins: { done: "Listed saved logins", doing: "Listing saved logins", keys: [] },
  remember: { done: "Remembered", doing: "Remembering", keys: ["fact", "text", "content"], bare: "Remembered something" },
  memory_search: { done: "Searched memory for", doing: "Searching memory for", keys: ["query"], bare: "Searched memory" },
  memory_write: { done: "Saved to memory", doing: "Saving to memory", keys: ["title", "content", "text"] },
  memory_store: { done: "Saved to memory", doing: "Saving to memory", keys: ["title", "content", "text"] },
  memory_recall: { done: "Searched memory for", doing: "Searching memory for", keys: ["query"], bare: "Searched memory" },
  memory_read: { done: "Read memory", doing: "Reading memory", keys: ["title", "path", "id"] },
  list_jobs: { done: "Listed scheduled jobs", doing: "Listing scheduled jobs", keys: [] },
  create_job: { done: "Created job", doing: "Creating job", keys: ["name"], bare: "Created a job" },
  update_job: { done: "Updated job", doing: "Updating job", keys: ["name", "id"], bare: "Updated a job" },
  delete_job: { done: "Deleted job", doing: "Deleting job", keys: ["name", "id"], bare: "Deleted a job" },
  box_info: { done: "Checked the toolchain", doing: "Checking the toolchain", keys: [] },
  list_files: { done: "Listed", doing: "Listing", keys: ["path", "dir"], empty: "the workspace", code: true },
  read_file: { done: "Read", doing: "Reading", keys: ["filePath", "path", "file"], kind: "path", bare: "Read a file", code: true },
  write_file: { done: "Wrote", doing: "Writing", keys: ["filePath", "path", "file"], kind: "path", bare: "Wrote a file", code: true },
  edit_file: { done: "Edited", doing: "Editing", keys: ["filePath", "path", "file"], kind: "path", bare: "Edited a file", code: true },
  find_files: { done: "Looked for files matching", doing: "Looking for files matching", keys: ["pattern"], bare: "Looked for files", code: true },
  search_files: { done: "Searched files for", doing: "Searching files for", keys: ["pattern", "query"], bare: "Searched files", code: true },
  subtask: { done: "Ran a subtask", doing: "Running a subtask", keys: ["description", "prompt"] },
  todo: { done: "Updated the to-do list", doing: "Updating the to-do list", keys: [] },
  patch: { done: "Applied a patch", doing: "Applying a patch", keys: [] },
  list_bots: { done: "Looked at the team", doing: "Looking at the team", keys: [] },
  message_bot: { done: "Messaged", doing: "Messaging", keys: ["bot", "name", "to"], bare: "Messaged a teammate" },
  broadcast: { done: "Broadcast to", doing: "Broadcasting to", keys: ["group"], bare: "Broadcast to the team" },
  create_bot: { done: "Created agent", doing: "Creating agent", keys: ["name"], bare: "Created an agent" },
  update_bot: { done: "Updated agent", doing: "Updating agent", keys: ["name", "bot"], bare: "Updated an agent" },
  list_groups: { done: "Listed groups", doing: "Listing groups", keys: [] },
  create_group: { done: "Created group", doing: "Creating group", keys: ["name"], bare: "Created a group" },
  compact_conversation: { done: "Compacted the thread", doing: "Compacting the thread", keys: [] },
  search_history: { done: "Searched the thread for", doing: "Searching the thread for", keys: ["query"], bare: "Searched the thread" },
  read_history: { done: "Read earlier messages", doing: "Reading earlier messages", keys: [] },
  notify_user: { done: "Notified you", doing: "Notifying you", keys: ["title"] },
  propose_task: { done: "Suggested", doing: "Suggesting", keys: ["title"], bare: "Made a suggestion" },
};

function toolKey(name) {
  const key = String(name || "tool").toLowerCase().replace(/[\s.-]+/g, "_").replace(/^(ravnir|truebot|ai_memory)_/, "");
  return TOOL_ALIASES[key] || key;
}

function oneLine(value, max = 90) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolTarget(value, kind) {
  const text = String(value ?? "").trim();
  if (kind === "url") return oneLine(text.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, ""), 60);
  if (kind === "path") return oneLine(text.split("/").filter(Boolean).slice(-2).join("/"), 60);
  return oneLine(text);
}

function toolSummary(item) {
  const input = item.input && typeof item.input === "object" ? item.input : {};
  const running = item.status === "running" || item.status === "pending";
  const words = TOOL_WORDS[toolKey(item.name)];
  if (!words) {
    // Another server's tool: say what it is, and show its first text argument.
    const label = oneLine(toolKey(item.name).replace(/_+/g, " "), 40);
    const first = Object.values(input).find((value) => typeof value === "string" && value.trim());
    return { verb: `${running ? "Using" : "Used"} ${label}`, arg: first ? oneLine(first, 70) : "", code: false };
  }
  const verb = running ? words.doing : words.done;
  let arg = "";
  for (const key of words.keys) {
    if (typeof input[key] === "string" && input[key].trim()) {
      arg = toolTarget(input[key], words.kind);
      break;
    }
  }
  if (!arg && words.keys.includes("selector") && Number.isFinite(input.x) && Number.isFinite(input.y)) arg = `${Math.round(input.x)}, ${Math.round(input.y)}`;
  if (!arg && words.empty) arg = words.empty;
  if (!arg && words.bare && !running) return { verb: words.bare, arg: "" };
  return { verb, arg, code: Boolean(words.code) };
}

const CHEVRON = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7.5 4.5 5.5 5.5-5.5 5.5"/></svg>';

function renderToolItem(item) {
  const details = document.createElement("details");
  const running = item.status === "running" || item.status === "pending";
  details.className = `tool-card${running ? " running" : ""}${item.status === "error" ? " failed" : ""}`;
  // The thread re-renders on every event; remember which cards the user opened.
  if (running || state.openTools.has(item.id)) details.open = true;
  details.addEventListener("toggle", () => {
    if (running) return;
    if (details.open) state.openTools.add(item.id);
    else state.openTools.delete(item.id);
  });
  const summary = document.createElement("summary");
  const { verb, arg, code } = toolSummary(item);
  summary.title = `${verb}${arg ? ` ${arg}` : ""} (${item.name || "tool"})`;
  const dot = document.createElement("span");
  dot.className = `tool-dot${item.status === "error" ? " error" : running ? " running" : ""}`;
  const label = el("span", "tool-label");
  label.append(el("span", "tool-verb", verb));
  if (arg) label.append(" ", el("span", `tool-arg${code ? " code" : ""}`, arg));
  summary.append(dot, label);
  if (item.status === "error") summary.append(el("span", "tool-status bad", "Failed"));
  else if (running) summary.append(el("span", "tool-status", "Working"));
  const chevron = el("span", "tool-chevron");
  chevron.innerHTML = CHEVRON;
  summary.append(chevron);
  details.append(summary);
  const output = document.createElement("pre");
  const input = item.input && Object.keys(item.input).length
    ? `${JSON.stringify(item.input, null, 2).slice(0, 1400)}\n\n`
    : "";
  output.textContent = `${input}${item.output || (running ? "Working…" : "")}`.trim();
  if (output.textContent) details.append(output);
  return details;
}

function renderComputerItem(item) {
  const card = document.createElement("article");
  card.className = "computer-card";
  const head = document.createElement("div");
  head.className = "computer-card-head";
  const label = document.createElement("span");
  label.className = "computer-card-label";
  label.textContent = item.phase === "action" ? `Step ${item.step}${item.score !== undefined ? ` · ${item.score}/4` : ""}` : `Looking at the page · step ${item.step}`;
  const where = document.createElement("span");
  where.className = "computer-card-where";
  where.textContent = shortUrl(item.url || "");
  head.append(label, where);
  card.append(head);
  if (item.action) {
    const action = document.createElement("p");
    action.className = "computer-card-action";
    action.textContent = item.action;
    card.append(action);
  }
  if (item.shot) {
    const image = document.createElement("img");
    image.className = "computer-card-shot";
    image.src = item.shot;
    image.alt = item.title || "Agent computer frame";
    image.loading = "lazy";
    card.append(image);
  }
  return card;
}

function renderComputer() {
  renderResearch();
  const bot = state.bot;
  const available = state.browser?.available !== false;
  const empty = els["screen-empty"];
  const main = $("screen-empty-main");
  const alt = $("screen-empty-alt");
  setScreenEmpty(!(state.screenshotUrl && state.browser?.url && state.browser.url !== "about:blank"));
  // The address box stays in place; a message replaces them only when there is no bot or no browser.
  main.hidden = !bot || !available;
  alt.hidden = bot && available;
  alt.replaceChildren();
  if (!bot) {
    alt.append(el("p", "", "Make an agent and its computer will appear here."));
    return;
  }
  if (!available) {
    alt.append(
      el("p", "", "Playwright's Chromium is not installed on this server."),
      el("code", "", "npx playwright install chromium"),
      el("p", "", "Run that once, then reload this page."),
    );
    els.screen.style.visibility = "hidden";
    return;
  }
  els.screen.style.visibility = "";
  if (state.browser?.url && state.browser.url !== "about:blank") {
    setScreenEmpty(false);
    if (document.activeElement !== els["url-input"]) els["url-input"].value = state.browser.url;
  }
  els["computer-caption"].textContent = state.browser?.url && state.browser.url !== "about:blank" ? shortUrl(state.browser.url) : "Ready";
  els["computer-dot"].classList.toggle("bad", !available);
  els["shell-cwd"].textContent = state.bot?.workspace || "workspace";
}

async function desktopAction(action, body = {}) {
  if (!state.bot) return;
  try {
    const result = await api(`/api/bots/${state.bot.id}/desktop`, { method: "POST", body: { action, ...body } });
    if (action === "start" && result && result.available !== undefined) {
      state.desktop = result;
    }
    setTimeout(refreshDesktop, 220);
    return result;
  } catch (error) {
    toast(error.message, "error");
    throw error;
  }
}

async function sendDesktopTyped() {
  const text = els["desktop-type"].value;
  if (!text) return;
  els["desktop-type"].value = "";
  await desktopAction("type", { text });
}

// The live view (public/live.js) is the screen now. A screenshot poll behind it would
// bring the agent's page to the front and take the keyboard focus away from the user.
function liveViewOpen() {
  return document.body.classList.contains("live-on");
}

async function refreshDesktop() {
  if (!state.bot || state.desktopBusy || state.panel !== "desktop" || document.hidden || liveViewOpen()) return;
  state.desktopBusy = true;
  try {
    const response = await fetch(`/api/bots/${state.bot.id}/desktop/screenshot?t=${Date.now()}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "The desktop is not ready.");
    }
    const blob = await response.blob();
    if (state.desktopScreenshotUrl) URL.revokeObjectURL(state.desktopScreenshotUrl);
    state.desktopScreenshotUrl = URL.createObjectURL(blob);
    els["desktop-screen"].src = state.desktopScreenshotUrl;
    els["desktop-empty"].hidden = true;
  } catch (error) {
    els["desktop-empty"].hidden = false;
    const p = els["desktop-empty"].querySelector("p");
    if (p) p.textContent = error.message;
  } finally {
    state.desktopBusy = false;
  }
}

async function refreshScreen() {
  if (!state.bot || state.screenshotBusy || state.panel !== "screen" || document.hidden || liveViewOpen()) return;
  if (state.browser?.available === false) return;
  state.screenshotBusy = true;
  try {
    const response = await fetch(`/api/bots/${state.bot.id}/browser/screenshot?t=${Date.now()}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "The browser is not ready.");
    }
    const blob = await response.blob();
    if (state.screenshotUrl) URL.revokeObjectURL(state.screenshotUrl);
    state.screenshotUrl = URL.createObjectURL(blob);
    els.screen.src = state.screenshotUrl;
    setScreenEmpty(!(state.browser?.url && state.browser.url !== "about:blank"));
    if (!state.browser || !state.browser.running) state.browser = { ...(state.browser || {}), running: true, available: true };
    if (state.refreshTick % 3 === 0 || !state.browser?.url || state.browser.url === "about:blank") {
      const status = await api(`/api/bots/${state.bot.id}/browser`).catch(() => null);
      if (status) {
        state.browser = status;
        renderComputer();
      }
    }
  } catch (error) {
    // Say what went wrong in place of the address box; renderComputer puts it back.
    setScreenEmpty(true);
    $("screen-empty-main").hidden = true;
    const alt = $("screen-empty-alt");
    alt.hidden = false;
    alt.replaceChildren(el("p", "", error.message));
    if (error.message.includes("not installed")) alt.append(el("code", "", "npx playwright install chromium"));
    const retry = el("button", "ghost", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => {
      browserAction("start").then(() => setTimeout(refreshScreen, 400)).catch((failure) => toast(failure.message, "error"));
    });
    alt.append(retry);
  } finally {
    state.screenshotBusy = false;
  }
}

async function browserAction(action, body = {}) {
  if (!state.bot) return;
  try {
    const result = await api(`/api/bots/${state.bot.id}/browser`, { method: "POST", body: { action, ...body } });
    if (result && (result.url !== undefined || result.running !== undefined)) {
      state.browser = result;
      renderComputer();
    }
    setTimeout(refreshScreen, 250);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function sendTyped() {
  const text = els["type-input"].value;
  if (!text) return;
  els["type-input"].value = "";
  await browserAction("type", { text });
  if (els["type-input"].type === "password") {
    els["type-input"].type = "text";
    els["type-secret"].classList.remove("on");
    els["type-input"].placeholder = "Click a field, then type here";
  }
}

// Web searches and page reads go over plain HTTP (server/web.js), not through the browser
// on this screen, so the Browser view lists them as they happen and keeps the last turn's.
const RESEARCH_TOOLS = new Set(["web_search", "web_fetch", "web_research"]);

function noteResearch(item) {
  const kind = toolKey(item.name);
  if (!RESEARCH_TOOLS.has(kind)) return;
  const steps = state.research.steps;
  const existing = steps.find((step) => step.id === item.id);
  const step = { id: item.id, kind, status: item.status, input: item.input || {}, output: String(item.output || "") };
  if (existing) Object.assign(existing, step);
  else steps.push(step);
  if (steps.length > 30) steps.splice(0, steps.length - 30);
}

// web_search and web_research list results as "1. Title\n   https://…".
function researchLinks(output, max = 5) {
  const links = [];
  for (const match of output.matchAll(/^\s*\d+\.\s+(.+)\n\s+(https?:\/\/\S+)/gm)) {
    links.push({ title: match[1].trim(), url: match[2] });
    if (links.length >= max) break;
  }
  return links;
}

function researchLink(url, text) {
  const link = el("a", "research-link", text || shortUrl(url));
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.title = url;
  return link;
}

function renderResearch() {
  const host = $("research");
  const steps = state.research.steps;
  host.hidden = !steps.length;
  if (!steps.length) return host.replaceChildren();
  const live = state.research.live && state.runtime.busy;
  const head = el("div", "research-head");
  head.append(
    el("strong", "", live ? "Researching" : "Last research"),
    el("span", "hint", "Searches and page reads run on the server without this browser."),
  );
  const list = el("ol", "research-list");
  for (const step of steps) {
    const running = step.status === "running" || step.status === "pending";
    const row = el("li", `research-step${running ? " running" : ""}`);
    const line = el("div", "research-line");
    const query = step.input.query || step.input.q || "";
    if (step.kind === "web_fetch") {
      const url = step.input.url || "";
      line.append(el("span", "research-verb", running ? "Reading" : "Read"), url ? researchLink(url) : el("span", "", "a page"));
    } else {
      line.append(el("span", "research-verb", running ? "Searching" : "Searched"), el("span", "research-query", query ? `“${oneLine(query, 70)}”` : "the web"));
    }
    row.append(line);
    if (!running && step.kind !== "web_fetch") {
      const links = researchLinks(step.output);
      if (links.length) {
        const found = el("div", "research-found");
        for (const link of links) found.append(researchLink(link.url, oneLine(link.title, 60)));
        row.append(found);
      } else if (/^No results/i.test(step.output)) {
        row.append(el("p", "research-none", "No useful results."));
      }
    }
    list.append(row);
  }
  host.replaceChildren(head, list);
}

// A blank browser shows only the address box: no toolbar, no typing row, nothing to click.
function setScreenEmpty(empty) {
  els["screen-empty"].hidden = !empty;
  $("panel-screen").classList.toggle("is-empty", empty);
}

function panelShown(name) {
  return name !== "desktop" || Boolean(state.desktop?.available);
}

function showGroup(group) {
  const last = state.groupPanel?.[group];
  // The second row's order decides the default panel of a group.
  const first = [...els["sub-tabs"].querySelectorAll(`button[data-group="${group}"]`)]
    .map((button) => button.dataset.panel)
    .find(panelShown);
  showPanel(last && panelShown(last) ? last : first);
}

// The second row lists the open group's panels, and hides when the group has only one.
function syncSubTabs() {
  const group = PANEL_GROUP[state.panel] || "computer";
  let shown = 0;
  for (const button of els["sub-tabs"].querySelectorAll("button[data-panel]")) {
    const visible = button.dataset.group === group && panelShown(button.dataset.panel);
    button.hidden = !visible;
    button.classList.toggle("on", button.dataset.panel === state.panel);
    if (visible) shown += 1;
  }
  els["sub-tabs"].hidden = shown < 2;
  for (const button of els["computer-tabs"].querySelectorAll("button[data-group]")) {
    button.classList.toggle("on", button.dataset.group === group);
  }
}

function showPanel(name) {
  if (!PANELS.includes(name)) return;
  if (!panelShown(name)) name = "screen";
  state.panel = name;
  state.groupPanel = { ...(state.groupPanel || {}), [PANEL_GROUP[name]]: name };
  syncSubTabs();
  for (const panel of document.querySelectorAll(".computer-body .panel")) {
    panel.hidden = panel.dataset.panel !== name;
  }
  revealTab(name);
  if (name === "screen") refreshScreen();
  if (name === "desktop") refreshDesktop();
  if (name === "files") loadFiles(state.files.path);
  if (name === "mind") {
    renderMind();
    loadSpec();
  }
  if (name === "usage") renderUsage();
  if (name === "saved") renderSaved();
  if (name === "diffs") renderDiffs();
  if (name === "jobs") renderJobsWithSpend();
  if (name === "logins") {
    renderLogins();
    if (!state.onepassword.status) refreshOnePassword();
  }
  if (name === "mcp") renderConnectors();
  if (name === "skills") window.RavnirSkills?.renderPanel(state.bot);
  if (name === "card") window.RavnirCard?.renderPanel(state.bot);
  if (name === "shell") window.RavnirTerminal?.open(state.bot);
}

// Typed messages come from the composer. Voice mode passes its own text with
// via: "voice" and gets the turn back, so it can follow the reply.
async function sendMessage({ text: spoken = "", via = "" } = {}) {
  if (!state.bot) {
    openNewBot();
    return undefined;
  }
  const voice = Boolean(via);
  const text = voice ? String(spoken).trim() : els["composer-input"].value.trim();
  const attaching = !voice && Boolean(window.RavnirAttach?.has());
  if ((!text && !attaching) || state.sending) return undefined;
  closeMentionMenu();
  state.sending = true;
  els["send-btn"].disabled = true;
  // Files upload as soon as they are picked; a send waits for the last ones.
  const files = attaching ? await window.RavnirAttach.take() : { ids: [], list: [] };
  if (!files) {
    state.sending = false;
    els["send-btn"].disabled = false;
    return undefined;
  }
  if (!voice) {
    els["composer-input"].value = "";
    autoGrow();
    forgetDraft(state.bot.id);
    window.RavnirAttach?.clear();
  }
  state.pendingUsers.push({ text, files: files.list });
  state.error = "";
  state.runtime.busy = true;
  state.runtime.startedAt = Date.now();
  state.runtime.activity = "Thinking";
  renderThreadState();
  scheduleRender();
  try {
    const sent = await api(`/api/bots/${state.bot.id}/messages`, { method: "POST", body: { text, via, attachments: files.ids } });
    setTimeout(poll, 150);
    return sent;
  } catch (error) {
    state.pendingUsers.pop();
    state.runtime.busy = false;
    toast(error.message, "error");
    if (!voice) {
      els["composer-input"].value = text;
      autoGrow();
      rememberDraft(state.bot?.id);
    }
    return undefined;
  } finally {
    state.sending = false;
    els["send-btn"].disabled = false;
  }
}

// Voice mode (public/voice.js) sends and speaks through the same path as the composer.
window.RavnirHost = {
  bot: () => state.bot,
  send: (text, via) => sendMessage({ text, via }),
  compose: () => els["composer-input"].focus(),
  toast,
};

async function stopTurn() {
  if (!state.bot) return;
  try {
    await api(`/api/bots/${state.bot.id}/stop`, { method: "POST" });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function answerPermission(decision) {
  const request = state.approvals[0];
  if (!state.bot || !request) return;
  try {
    await api(`/api/approvals/${encodeURIComponent(request.id)}`, { method: "POST", body: { decision } });
  } catch (error) {
    toast(error.message, "error");
  }
  state.approvals = state.approvals.filter((item) => item.id !== request.id);
  state.permissionExpanded = false;
  syncPermissionBar();
  refreshBots();
}

function syncPermissionBar() {
  const request = state.approvals[0];
  els["permission-bar"].hidden = !request;
  if (!request) {
    state.permissionExpanded = false;
    syncJump();
    return;
  }
  const more = state.approvals.length > 1 ? ` (${state.approvals.length - 1} more waiting)` : "";
  els["permission-title"].textContent = `${request.title || "The agent is waiting for your approval."}${more}`;
  const detail = request.detail || "";
  els["permission-detail"].textContent = detail;
  els["permission-detail"].hidden = !detail;
  els["permission-detail"].classList.toggle("open", state.permissionExpanded);
  const long = detail.length > 180 || detail.split("\n").length > 3;
  els["permission-expand"].hidden = !long;
  els["permission-expand"].textContent = state.permissionExpanded ? "Hide the full command" : "Show the full command";
  // A takeover asks the user to sign in themselves: Take control or Not now, nothing else.
  const takeover = request.kind === "takeover";
  els["permission-bar"].querySelector("[data-takeover]").hidden = !takeover;
  for (const button of els["permission-bar"].querySelectorAll("[data-decision]")) {
    const decision = button.dataset.decision;
    button.hidden = takeover ? decision !== "reject" : decision === "always" && Boolean(request.onceOnly);
    if (decision === "reject") button.textContent = takeover ? "Not now" : "Deny";
  }
  const note = ruleNote(request, "");
  els["permission-rule"].hidden = !note;
  els["permission-rule"].replaceChildren(...(note ? note.childNodes : []));
  syncJump();
}

function autoGrow() {
  const input = els["composer-input"];
  input.style.height = "auto";
  input.style.height = `${Math.min(190, input.scrollHeight)}px`;
}

// @mentions in the composer. The menu matches roster names, and a selection
// inserts the full name (spaces included) so the server can route it.
const mentionMenu = { open: false, index: 0, items: [], start: 0, end: 0 };

function mentionContext() {
  const input = els["composer-input"];
  if (!input) return null;
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\n\r]/.test(query) || query.length > 40) return null;
  return { at, query, caret };
}

function updateMentionMenu() {
  if (!state.bot) return closeMentionMenu();
  const ctx = mentionContext();
  if (!ctx) return closeMentionMenu();
  const query = ctx.query.trim().toLowerCase();
  const items = state.bots
    .filter((bot) => bot.id !== state.bot.id)
    .filter((bot) => !query || String(bot.name || "").toLowerCase().includes(query))
    .sort((a, b) => {
      const left = String(a.name || "").toLowerCase();
      const right = String(b.name || "").toLowerCase();
      const leftStarts = left.startsWith(query);
      const rightStarts = right.startsWith(query);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.localeCompare(right);
    })
    .slice(0, 8);
  if (!items.length) return closeMentionMenu();
  mentionMenu.open = true;
  mentionMenu.items = items;
  mentionMenu.index = 0;
  mentionMenu.start = ctx.at;
  mentionMenu.end = ctx.caret;
  renderMentionMenu();
}

function renderMentionMenu() {
  const host = els["mention-menu"];
  if (!host) return;
  host.replaceChildren();
  host.hidden = !mentionMenu.open;
  if (!mentionMenu.open) return;
  host.append(el("p", "mention-head", "Tag an agent"));
  mentionMenu.items.forEach((bot, index) => {
    const button = el("button", `mention-item${index === mentionMenu.index ? " active" : ""}`);
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === mentionMenu.index ? "true" : "false");
    const avatar = el("span", "avatar xs");
    paintCreature(avatar, bot);
    const copy = el("span", "mention-copy");
    copy.append(el("span", "mention-name", bot.name));
    copy.append(el("span", "mention-job", bot.job || (bot.group || "Personal")));
    button.append(avatar, copy);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      chooseMention(bot);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      chooseMention(bot);
    });
    host.append(button);
  });
}

function chooseMention(bot) {
  const input = els["composer-input"];
  const value = input.value;
  const insert = `@${bot.name} `;
  input.value = `${value.slice(0, mentionMenu.start)}${insert}${value.slice(mentionMenu.end)}`;
  const caret = mentionMenu.start + insert.length;
  closeMentionMenu();
  input.focus();
  input.setSelectionRange(caret, caret);
  autoGrow();
}

function closeMentionMenu() {
  if (!mentionMenu.open) return;
  mentionMenu.open = false;
  mentionMenu.items = [];
  mentionMenu.index = 0;
  if (els["mention-menu"]) els["mention-menu"].hidden = true;
}

function handleMentionKey(event) {
  if (!mentionMenu.open) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const count = mentionMenu.items.length;
    mentionMenu.index = (mentionMenu.index + step + count) % count;
    renderMentionMenu();
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    chooseMention(mentionMenu.items[mentionMenu.index]);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMentionMenu();
    return true;
  }
  return false;
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderMessages();
    renderThreadState();
  });
}

function updateClock() {
  state.clock += 1;
  if (state.runtime.busy) {
    const started = state.runtime.startedAt || Date.now();
    els["activity-time"].textContent = `${Math.max(1, Math.round((Date.now() - started) / 1000))}s`;
  }
}

async function loadFiles(path) {
  if (!state.bot) return;
  try {
    const data = await api(`/api/bots/${state.bot.id}/files?path=${encodeURIComponent(path || "")}`);
    state.files.path = data.path || "";
    state.files.entries = data.entries || [];
    state.files.open = null;
    renderFiles();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderFiles() {
  els["file-path"].textContent = `/${state.files.path || ""}`;
  els["file-list"].replaceChildren();
  if (!state.bot) return;
  if (state.files.path) {
    const up = document.createElement("button");
    up.type = "button";
    up.className = "file-row";
    up.innerHTML = '<span class="file-icon">↑</span><span>Parent folder</span>';
    const parent = state.files.path.split("/").slice(0, -1).join("/");
    up.addEventListener("click", () => loadFiles(parent));
    els["file-list"].append(up);
  }
  for (const entry of state.files.entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-row";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = entry.type === "dir" ? "›" : "";
    const name = document.createElement("span");
    name.textContent = entry.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = entry.type === "dir" ? "dir" : formatBytes(entry.size);
    row.append(icon, name, size);
    row.addEventListener("click", () => {
      if (entry.type === "dir") loadFiles(entry.path);
      else openFile(entry.path);
    });
    els["file-list"].append(row);
  }
  if (!state.files.entries.length && !state.files.path) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "This workspace is empty.";
    els["file-list"].append(hint);
  }
  if (!state.files.open) els["file-editor"].hidden = true;
}

async function openFile(path) {
  if (!state.bot) return;
  try {
    const data = await api(`/api/bots/${state.bot.id}/file?path=${encodeURIComponent(path)}`);
    state.files.open = data;
    els["file-editor"].hidden = false;
    els["file-editor-name"].textContent = data.path;
    els["file-content"].value = data.content;
    els["file-status"].textContent = "";
    els["file-content"].focus();
  } catch (error) {
    toast(error.message, "error");
  }
}

function closeFile() {
  state.files.open = null;
  els["file-editor"].hidden = true;
}

async function saveFile() {
  if (!state.bot || !state.files.open) return;
  els["file-status"].textContent = "Saving…";
  try {
    const data = await api(`/api/bots/${state.bot.id}/file`, {
      method: "PUT",
      body: { path: state.files.open.path, content: els["file-content"].value },
    });
    state.files.open.content = els["file-content"].value;
    els["file-status"].textContent = data.diff?.patch ? `Saved · +${data.diff.additions} −${data.diff.deletions}` : "Saved";
    toast("File saved.");
    await loadBotDiffs();
    loadFiles(state.files.path);
  } catch (error) {
    els["file-status"].textContent = error.message;
    toast(error.message, "error");
  }
}

function setTerminal(text) {
  state.terminal = text;
  renderShell();
}

function renderShell() {
  els["shell-output"].textContent = state.terminal || "Ready. Commands run on this server, in this agent's workspace.";
  els["shell-cwd"].textContent = state.bot?.workspace || "workspace";
  window.RavnirTerminal?.render(state.bot);
}

async function runShell(event) {
  event.preventDefault();
  if (!state.bot) return;
  const command = els["shell-input"].value.trim();
  if (!command) return;
  els["shell-input"].value = "";
  const previous = state.terminal && !state.terminal.startsWith("Ready.") ? `${state.terminal}\n\n` : "";
  setTerminal(`${previous}$ ${command}\nrunning…`);
  try {
    const result = await api(`/api/bots/${state.bot.id}/terminal`, { method: "POST", body: { command } });
    setTerminal(`${previous}$ ${command}\n${result.output}${result.truncated ? "\n[truncated]" : ""}\n[exit ${result.code}]`);
    els["shell-output"].scrollTop = els["shell-output"].scrollHeight;
  } catch (error) {
    setTerminal(`${previous}$ ${command}\n${error.message}`);
  }
}

function renderLogins() {
  els["login-list"].replaceChildren();
  renderOnePassword();
  if (!state.bot) return;
  if (!state.vault.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No saved logins for this agent yet.";
    els["login-list"].append(hint);
    return;
  }
  for (const entry of state.vault) {
    const item = document.createElement("div");
    item.className = "item";
    const head = document.createElement("div");
    head.className = "item-head";
    const copy = document.createElement("div");
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = entry.site;
    const sub = document.createElement("div");
    sub.className = "item-sub";
    sub.textContent = `${entry.username || "no username"}${entry.label ? ` · ${entry.label}` : ""}${entry.source === "1password" ? " · 1Password" : ""}${entry.lastUsedAt ? ` · used ${timeAgo(entry.lastUsedAt)}` : ""}`;
    copy.append(title, sub);
    const actions = document.createElement("div");
    actions.className = "item-actions";
    const use = document.createElement("button");
    use.type = "button";
    use.className = "ghost";
    use.textContent = "Use";
    use.addEventListener("click", () => useLogin(entry));
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "ghost";
    forget.textContent = "Forget";
    forget.addEventListener("click", () => deleteLogin(entry));
    actions.append(use, forget);
    head.append(copy, actions);
    item.append(head);
    els["login-list"].append(item);
  }
}

async function loadOnePassword(query = "") {
  if (!state.onepassword.status?.signedIn) {
    toast(state.onepassword.status?.message || "1Password is not connected.", "error");
    return;
  }
  state.onepassword.loading = true;
  renderOnePassword();
  try {
    const data = await api(`/api/onepassword/items?q=${encodeURIComponent(query)}`);
    state.onepassword.items = data.items || [];
  } catch (error) {
    toast(error.message, "error");
    state.onepassword.items = [];
  } finally {
    state.onepassword.loading = false;
    renderOnePassword();
  }
}

async function connectOnePassword(event) {
  event.preventDefault();
  const token = els["onepassword-token"].value.trim();
  if (!token) return;
  els["onepassword-connect"].disabled = true;
  try {
    state.onepassword.status = await api("/api/onepassword/token", { method: "POST", body: { token } });
    els["onepassword-token"].value = "";
    toast(state.onepassword.status.signedIn ? "1Password connected." : state.onepassword.status.message || "The token did not connect.", state.onepassword.status.signedIn ? "" : "error");
    if (state.onepassword.status.signedIn) await loadOnePassword("");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    els["onepassword-connect"].disabled = false;
    renderOnePassword();
  }
}

async function forgetOnePassword() {
  try {
    state.onepassword.status = await api("/api/onepassword/token", { method: "DELETE" });
    state.onepassword.items = [];
    toast("1Password disconnected.");
  } catch (error) {
    toast(error.message, "error");
  }
  renderOnePassword();
}

async function refreshOnePassword({ fresh = false } = {}) {
  try {
    state.onepassword.status = await api(`/api/onepassword${fresh ? "?fresh=1" : ""}`);
  } catch {
    state.onepassword.status = { installed: false, signedIn: false, message: "1Password is not available." };
  }
  renderOnePassword();
}

function renderOnePassword() {
  const status = state.onepassword.status;
  const pill = els["onepassword-state"];
  const hint = els["onepassword-hint"];
  const list = els["onepassword-list"];
  els["onepassword-token-form"].hidden = true;
  els["onepassword-forget"].hidden = true;
  if (!status) {
    pill.textContent = "checking";
    pill.className = "pill";
    return;
  }
  if (!status.installed) {
    pill.textContent = "not installed";
    pill.className = "pill warn";
    hint.textContent = status.message || "Install the 1Password CLI on the server to read saved logins.";
    list.replaceChildren();
    return;
  }
  if (!status.signedIn) {
    pill.textContent = "sign in";
    pill.className = "pill warn";
    hint.textContent = status.message || "Paste a 1Password service account token to connect.";
    els["onepassword-token-form"].hidden = false;
    list.replaceChildren();
    return;
  }
  pill.textContent = "connected";
  pill.className = "pill ok";
  els["onepassword-forget"].hidden = false;
  hint.textContent = "Reads Login items on the server. The password stays here and is never sent to the model.";
  list.replaceChildren();
  if (state.onepassword.loading) {
    list.append(note("Searching 1Password…"));
    return;
  }
  if (!state.onepassword.items.length) {
    list.append(note("Search 1Password to add a login to this agent."));
    return;
  }
  for (const item of state.onepassword.items) {
    const row = document.createElement("div");
    row.className = "onepassword-item";
    const copy = document.createElement("div");
    copy.className = "copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const sub = document.createElement("small");
    sub.textContent = [item.vault, item.username, item.url].filter(Boolean).join(" · ");
    copy.append(title, sub);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ghost";
    add.textContent = "Add";
    add.addEventListener("click", () => linkOnePasswordItem(item, add));
    row.append(copy, add);
    list.append(row);
  }
}

async function linkOnePasswordItem(item, button) {
  if (!state.bot) return;
  button.disabled = true;
  try {
    await api(`/api/bots/${state.bot.id}/vault/onepassword`, {
      method: "POST",
      body: { itemId: item.id, site: item.url, label: item.vault },
    });
    toast(`${item.title} linked to ${state.bot.name}.`);
    await reloadBot();
    showPanel("logins");
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

async function saveLogin(event) {
  event.preventDefault();
  if (!state.bot) return;
  const site = els["login-site"].value.trim();
  const password = els["login-password"].value;
  if (!site || !password) {
    toast("Site and password are required.", "error");
    return;
  }
  try {
    await api(`/api/bots/${state.bot.id}/vault`, {
      method: "POST",
      body: {
        site,
        username: els["login-username"].value.trim(),
        password,
        label: els["login-label"].value.trim(),
      },
    });
    els["login-site"].value = "";
    els["login-username"].value = "";
    els["login-password"].value = "";
    els["login-label"].value = "";
    toast("Login encrypted and saved.");
    await reloadBot();
    showPanel("logins");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function useLogin(entry) {
  if (!state.bot) return;
  try {
    await api(`/api/bots/${state.bot.id}/vault/${entry.id}/use`, { method: "POST" });
    toast(`Signed in to ${entry.site}.`);
    showPanel("screen");
    setTimeout(refreshScreen, 600);
    await reloadBot();
    showPanel("screen");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteLogin(entry) {
  if (!state.bot) return;
  try {
    await api(`/api/bots/${state.bot.id}/vault/${entry.id}`, { method: "DELETE" });
    state.vault = state.vault.filter((item) => item.id !== entry.id);
    renderLogins();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderMind() {
  if (!state.bot) return;
  els["live-prompt"].textContent = state.livePrompt || "";
  // A fresh model session only means something for OpenCode agents.
  els["reset-session"].hidden = state.bot.model?.provider !== "opencode";
  els["memory-status"].textContent = state.memoryInfo?.available
    ? `Shared ai-memory at ${state.memoryInfo.serverUrl.replace(/^https?:\/\//, "")} · ${state.memoryInfo.workspace}/${state.memoryInfo.project}`
    : "ai-memory is not installed on this server. Run ai-memory setup on the host to enable it.";
  if (document.activeElement !== els.instructions) els.instructions.value = state.bot.prompt || "";
  els["memory-list"].replaceChildren();
  if (!state.memory.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Nothing saved yet. The agent can remember things with its remember tool.";
    els["memory-list"].append(hint);
  }
  for (const item of state.memory) {
    const row = document.createElement("div");
    row.className = "memory-item";
    const text = document.createElement("span");
    text.textContent = item.text;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.title = "Forget";
    del.addEventListener("click", () => deleteMemory(item));
    row.append(text, del);
    els["memory-list"].append(row);
  }
}

// A small question in the app's own dialog, instead of the browser's prompt and confirm.
// With input: true it resolves to the text (or null). Without, to true or false.
function ask({ kicker = "", title = "", message = "", label = "Name", value = "", placeholder = "", confirm: confirmLabel = "OK", danger = false, input = false, maxLength = 40 } = {}) {
  return new Promise((resolve) => {
    const dialog = els["ask-dialog"];
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(result);
    };
    els["ask-kicker"].textContent = kicker;
    els["ask-kicker"].hidden = !kicker;
    els["ask-title"].textContent = title;
    els["ask-message"].textContent = message;
    els["ask-message"].hidden = !message;
    els["ask-field"].hidden = !input;
    els["ask-label"].textContent = label;
    els["ask-input"].value = value;
    els["ask-input"].placeholder = placeholder;
    els["ask-input"].maxLength = maxLength;
    els["ask-error"].textContent = "";
    els["ask-ok"].textContent = confirmLabel;
    els["ask-ok"].className = danger ? "danger" : "primary";
    els["ask-form"].onsubmit = (event) => {
      event.preventDefault();
      if (!input) return finish(true);
      const text = els["ask-input"].value.replace(/\s+/g, " ").trim();
      if (!text) {
        els["ask-error"].textContent = `${label} is required.`;
        return undefined;
      }
      return finish(text);
    };
    for (const button of dialog.querySelectorAll("[data-ask-cancel]")) button.onclick = () => finish(input ? null : false);
    dialog.onclose = () => finish(input ? null : false);
    dialog.showModal();
    setTimeout(() => {
      if (input) {
        els["ask-input"].focus();
        els["ask-input"].select();
      } else els["ask-ok"].focus();
    }, 30);
  });
}

async function createNewGroup() {
  const name = await ask({ kicker: "Sidebar", title: "New group", label: "Group name", placeholder: "Work", confirm: "Create", input: true });
  if (!name) return;
  try {
    await api("/api/groups", { method: "POST", body: { name } });
    const data = await api("/api/state");
    state.groups = data.groups || [];
    renderRail();
    toast(`Group ${name} is ready.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function openGroupMenu(group, count) {
  const items = [{ icon: "edit", label: "Rename group", hint: `${count} agent${count === 1 ? "" : "s"} in it`, onSelect: () => renameGroupDialog(group) }];
  // Personal is the fallback group, so it always exists.
  if (group.name !== "Personal") items.push({ icon: "trash", label: "Delete group", hint: count ? `The ${count} agent${count === 1 ? "" : "s"} move to Personal` : "It is empty", danger: true, onSelect: () => deleteGroupDialog(group, count) });
  openSheet({ title: group.name, items });
}

async function renameGroupDialog(group) {
  const name = await ask({ kicker: "Group", title: "Rename group", label: "Group name", value: group.name, confirm: "Rename", input: true });
  if (!name || name === group.name) return;
  try {
    await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: "PATCH", body: { name } });
    await refreshState();
    if (state.bot) await reloadBot();
    toast(`Renamed to ${name}.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteGroupDialog(group, count) {
  const message = count
    ? `The ${count} agent${count === 1 ? "" : "s"} in "${group.name}" ${count === 1 ? "is" : "are"} not deleted. ${count === 1 ? "It moves" : "They move"} to the Personal group.`
    : `"${group.name}" has no agents. Nothing else changes.`;
  const yes = await ask({ kicker: "Group", title: `Delete the group ${group.name}?`, message, confirm: "Delete group", danger: true });
  if (!yes) return;
  try {
    await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
    await refreshState();
    if (state.bot) await reloadBot();
    toast(`Group ${group.name} deleted.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function resetSession() {
  if (!state.bot) return;
  const yes = await ask({
    kicker: "Model session",
    title: "Start a new model session?",
    message: "The agent's next reply starts from a fresh OpenCode session. Your chat, memory and files stay. It loses the model's own running context, so it may need a reminder of what it was doing.",
    confirm: "New session",
  });
  if (!yes) return;
  els["reset-session"].disabled = true;
  els["reset-session"].textContent = "Resetting…";
  try {
    await api(`/api/bots/${state.bot.id}/opencode/reset`, { method: "POST" });
    toast("A fresh OpenCode session will be used on the next message.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    els["reset-session"].disabled = false;
    els["reset-session"].textContent = "New model session";
  }
}

async function compactNow() {
  if (!state.bot) return;
  els["compact-now"].disabled = true;
  els["compact-now"].textContent = "Compacting…";
  try {
    const data = await api(`/api/bots/${state.bot.id}/compact`, { method: "POST" });
    toast(data.compacted ? `Compacted ${data.removed} older messages.` : "Nothing to compact yet.");
    await selectBot(state.bot.id, { silent: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    els["compact-now"].disabled = false;
    els["compact-now"].textContent = "Compact now";
  }
}

async function saveInstructions() {
  if (!state.bot) return;
  els["instructions-status"].textContent = "Saving…";
  try {
    const detail = await api(`/api/bots/${state.bot.id}`, { method: "PATCH", body: { prompt: els.instructions.value } });
    applyDetail(detail);
    els["instructions-status"].textContent = "Saved";
    toast("Instructions updated.");
    renderMind();
  } catch (error) {
    els["instructions-status"].textContent = error.message;
    toast(error.message, "error");
  }
}

async function addMemory(event) {
  event.preventDefault();
  if (!state.bot) return;
  const text = els["memory-input"].value.trim();
  if (!text) return;
  try {
    const data = await api(`/api/bots/${state.bot.id}/memory`, { method: "POST", body: { text } });
    state.memory = data.memory;
    state.bot.memory = data.memory;
    els["memory-input"].value = "";
    renderMind();
    const detail = await api(`/api/bots/${state.bot.id}`);
    state.livePrompt = detail.livePrompt;
    els["live-prompt"].textContent = detail.livePrompt;
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteMemory(item) {
  try {
    const data = await api(`/api/bots/${state.bot.id}/memory/${item.id}`, { method: "DELETE" });
    state.memory = data.memory;
    state.bot.memory = data.memory;
    renderMind();
    const detail = await api(`/api/bots/${state.bot.id}`);
    state.livePrompt = detail.livePrompt;
    els["live-prompt"].textContent = detail.livePrompt;
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderCompareOptions() {
  const current = els["compare-bot"].value;
  els["compare-bot"].replaceChildren();
  for (const bot of state.bots) {
    if (bot.id === state.botId) continue;
    const option = document.createElement("option");
    option.value = bot.id;
    option.textContent = bot.name;
    els["compare-bot"].append(option);
  }
  if (!els["compare-bot"].children.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Make another agent first";
    els["compare-bot"].append(option);
  } else if (current) {
    els["compare-bot"].value = current;
  }
}

async function loadPromptDiff() {
  if (!state.bot) return;
  const against = els["compare-bot"].value;
  if (!against) {
    toast("Make another agent to compare prompts.", "error");
    return;
  }
  try {
    const data = await api(`/api/bots/${state.bot.id}/prompt?against=${against}`);
    els["prompt-diff"].textContent = data.diff || "The live prompts are identical.";
    els["prompt-diff"].classList.remove("muted");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadDiffs() {
  if (!state.bot) return;
  try {
    const data = await api(`/api/bots/${state.bot.id}/diffs`);
    state.diffs = data.diffs || [];
    renderDiffs();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadBotDiffs() {
  await loadDiffs();
}

function renderDiffs() {
  els["diff-count"].textContent = state.diffs.length ? String(state.diffs.length) : "";
  els["files-count"].textContent = els["diff-count"].textContent;
  els["diff-list"].replaceChildren();
  if (!state.bot) return;
  if (!state.diffs.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No code changes yet. Ask the agent to edit a file, or edit one in Files.";
    els["diff-list"].append(hint);
    return;
  }
  for (const diff of [...state.diffs].reverse()) {
    const card = document.createElement("article");
    card.className = "diff-card";
    const head = document.createElement("div");
    head.className = "diff-head";
    const path = document.createElement("span");
    path.className = "diff-path";
    path.textContent = diff.path;
    const stats = document.createElement("span");
    stats.className = "diff-stats";
    stats.textContent = `+${diff.additions || 0} −${diff.deletions || 0}`;
    head.append(path, stats);
    card.append(head, buildPatch(diff.patch));
    els["diff-list"].append(card);
  }
}

function buildPatch(patch) {
  const pre = document.createElement("pre");
  pre.className = "patch";
  for (const line of String(patch || "").split("\n")) {
    const row = document.createElement("div");
    if (line.startsWith("@@")) row.className = "hunk";
    else if (line.startsWith("---") || line.startsWith("+++")) row.className = "file";
    else if (line.startsWith("+")) row.className = "add";
    else if (line.startsWith("-")) row.className = "del";
    row.textContent = line || " ";
    pre.append(row);
  }
  return pre;
}

function renderConnectors() {
  els["connector-list"].replaceChildren();
  if (!state.bot) return;
  if (!state.connectors.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No MCP servers yet. Add one and its tools appear to this agent.";
    els["connector-list"].append(hint);
    return;
  }
  for (const connector of state.connectors) {
    const item = document.createElement("div");
    item.className = "item";
    const head = document.createElement("div");
    head.className = "item-head";
    const copy = document.createElement("div");
    const title = document.createElement("div");
    title.className = "item-title";
    title.innerHTML = `<span class="status-dot ${connector.status}"></span>`;
    title.append(document.createTextNode(connector.name));
    const sub = document.createElement("div");
    sub.className = "item-sub";
    sub.textContent = `${String(connector.managed || "").startsWith("plugin:") ? "plugin" : connector.transport} · ${connector.status}${connector.tools?.length ? ` · ${connector.tools.length} tools` : ""}`;
    copy.append(title, sub);
    const actions = document.createElement("div");
    actions.className = "item-actions";
    const test = document.createElement("button");
    test.type = "button";
    test.className = "ghost";
    test.textContent = "Test";
    test.addEventListener("click", () => testConnector(connector));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ghost";
    toggle.textContent = connector.enabled ? "Disable" : "Enable";
    toggle.addEventListener("click", () => toggleConnector(connector));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "Remove";
    del.addEventListener("click", () => deleteConnector(connector));
    if (String(connector.managed || "").startsWith("plugin:")) {
      // Added from the Plugins page: it is managed there, with its account and agents.
      const manage = document.createElement("button");
      manage.type = "button";
      manage.className = "ghost";
      manage.textContent = "Manage";
      manage.addEventListener("click", () => openPlugins(connector.managed.slice(7)));
      actions.append(test, manage);
    } else {
      actions.append(test, toggle, del);
    }
    head.append(copy, actions);
    item.append(head);
    if (connector.error) {
      const note = document.createElement("p");
      note.className = "item-note error-text";
      note.textContent = connector.error;
      item.append(note);
    }
    if (connector.tools?.length) {
      const tools = document.createElement("p");
      tools.className = "item-note mono";
      tools.textContent = connector.tools.map((tool) => tool.name).join(", ");
      item.append(tools);
    }
    els["connector-list"].append(item);
  }
}

function syncConnectorFields() {
  const stdio = els["connector-transport"].value === "stdio";
  els["connector-form"].querySelectorAll(".stdio-field").forEach((label) => { label.hidden = !stdio; });
  els["connector-form"].querySelectorAll(".http-field").forEach((label) => { label.hidden = stdio; });
}

async function createConnector(event) {
  event.preventDefault();
  if (!state.bot) return;
  let env = {};
  let headers = {};
  try {
    if (els["connector-env"].value.trim()) env = JSON.parse(els["connector-env"].value);
    if (els["connector-headers"].value.trim()) headers = JSON.parse(els["connector-headers"].value);
  } catch {
    toast("Environment and headers must be JSON.", "error");
    return;
  }
  const args = els["connector-args"].value.split("\n").map((line) => line.trim()).filter(Boolean);
  try {
    await api(`/api/bots/${state.bot.id}/connectors`, {
      method: "POST",
      body: {
        name: els["connector-name"].value.trim(),
        transport: els["connector-transport"].value,
        command: els["connector-command"].value.trim(),
        args,
        url: els["connector-url"].value.trim(),
        env,
        headers,
      },
    });
    els["connector-name"].value = "";
    els["connector-command"].value = "";
    els["connector-args"].value = "";
    els["connector-url"].value = "";
    els["connector-env"].value = "";
    els["connector-headers"].value = "";
    toast("Connector added.");
    await reloadBot();
    showPanel("mcp");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function testConnector(connector) {
  try {
    await api(`/api/bots/${state.bot.id}/connectors/${connector.id}/test`, { method: "POST" });
    toast(`Tested ${connector.name}.`);
    await reloadBot();
    showPanel("mcp");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function toggleConnector(connector) {
  try {
    await api(`/api/bots/${state.bot.id}/connectors/${connector.id}`, {
      method: "PATCH",
      body: { enabled: !connector.enabled },
    });
    await reloadBot();
    showPanel("mcp");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteConnector(connector) {
  if (!confirm(`Remove the connector “${connector.name}”?`)) return;
  try {
    await api(`/api/bots/${state.bot.id}/connectors/${connector.id}`, { method: "DELETE" });
    await reloadBot();
    showPanel("mcp");
  } catch (error) {
    toast(error.message, "error");
  }
}

// Settings > New agents: the provider, address, model and group a new agent starts with.
async function loadDefaults() {
  try {
    const data = await api("/api/settings");
    state.settingsDefaults = data.defaults || {};
    state.settingsZone = data.timeZone || "";
    // Settings > You: the owner's name and language, and the vault layout.
    state.settingsOwner = data.owner || {};
    state.settingsVault = data.vault || {};
    state.settingsLanguages = data.languages || {};
  } catch {
    state.settingsDefaults ||= {};
  }
  return state.settingsDefaults;
}

function openNewBot() {
  const defaults = state.settingsDefaults || {};
  loadDefaults();
  state.newLook = normalizeLook(window.RavnirAvatar?.random());
  state.newColor = state.newLook.color || COLORS[0];
  state.newLookAuto = true;
  els["nb-name"].value = "";
  els["nb-group"].value = defaults.group || "Personal";
  els["nb-job"].value = "";
  els["nb-prompt"].value = "";
  els["nb-provider"].value = defaults.provider || "opencode";
  // No address is invented: with none saved, the first server Ravnir can find fills it in.
  els["nb-base"].value = defaults.baseUrl || "";
  els["nb-user"].value = defaults.username || "opencode";
  els["nb-key"].value = "";
  els["nb-model-custom"].value = "";
  els["nb-model-custom"].hidden = true;
  els["nb-agent"].value = "";
  els["nb-status"].textContent = "";
  els["nb-error"].textContent = "";
  els["nb-model"].replaceChildren(new Option("Loading models…", ""));
  renderLookControls("nb");
  syncNewBotFields();
  // The model comes from a picker over the connected providers; a raw server address is the fallback.
  const picker = modelPicker("nb");
  if (picker) picker.value = defaults.via && defaults.model ? { via: defaults.via, model: defaults.model } : { via: "opencode", model: "" };
  els["nb-advanced"].open = !picker;
  els["new-bot-dialog"].showModal();
  setTimeout(() => {
    els["nb-name"].focus();
    if (!els["nb-advanced"].open) return;
    if (els["nb-base"].value.trim()) loadModelsInto("nb", { auto: true, current: defaults.model || "" });
    else useFirstServer();
  }, 50);
}

// One picker per dialog (public/models.js), made the first time the dialog opens.
function modelPicker(which) {
  if (!window.RavnirModels?.picker) return null;
  state.modelPickers ||= {};
  if (!state.modelPickers[which]) {
    const picker = window.RavnirModels.picker({ placeholder: "Choose a model" });
    els[`${which}-model-pick`].replaceChildren(picker);
    state.modelPickers[which] = picker;
    // Opening "Use another server" loads that server's models the old way.
    els[`${which}-advanced`].addEventListener("toggle", () => {
      if (!els[`${which}-advanced`].open) return;
      if (which === "nb" && !els["nb-base"].value.trim()) useFirstServer();
      else loadModelsInto(which, { auto: true, current: which === "set" ? state.bot?.model.model : undefined });
    });
  }
  return state.modelPickers[which];
}

// Which picker choice a saved agent matches: an added server, this server's OpenCode, or neither.
async function pickerValueFor(bot) {
  if (bot.model.connection) return { via: bot.model.connection, model: bot.model.model };
  if (bot.model.provider !== "opencode") return null;
  try {
    if (!state.modelCatalog || Date.now() - state.modelCatalog.at > 60_000) {
      state.modelCatalog = { at: Date.now(), data: await api("/api/models/catalog") };
    }
    const server = state.modelCatalog.data.opencode?.baseUrl || "";
    const same = (a, b) => String(a || "").replace(/\/+$/, "").replace("://localhost", "://127.0.0.1") === String(b || "").replace(/\/+$/, "").replace("://localhost", "://127.0.0.1");
    return server && same(server, bot.model.baseUrl) ? { via: "opencode", model: bot.model.model } : null;
  } catch {
    return null;
  }
}

// A new agent with no saved address: ask the discovery for servers and take the first one.
async function useFirstServer() {
  els["nb-status"].textContent = "Looking for a model server…";
  try {
    const data = await api("/api/discover");
    if (!els["new-bot-dialog"].open || els["nb-base"].value.trim()) return;
    const server = data.servers?.[0];
    if (!server) {
      els["nb-status"].textContent = "No model server found. Type its address, or press Find servers.";
      populateModelSelect(els["nb-model"], [], "", { allowBlank: false });
      return;
    }
    state.discoverTarget = "new";
    applyDiscovered(server);
    const model = state.settingsDefaults?.model;
    if (model) els["nb-model"].value = model;
    if (server.authRequired) els["nb-status"].textContent = "Enter the server password, then refresh the model list.";
    else els["nb-status"].textContent = `Using ${server.name}. ${els["nb-status"].textContent}`;
  } catch (error) {
    els["nb-status"].textContent = error.message;
  }
}

function syncNewBotFields() {
  const opencode = els["nb-provider"].value === "opencode";
  els["nb-user-field"].hidden = !opencode;
  els["nb-key-field"].querySelector("span")?.remove();
  els["nb-agent-field"].hidden = !opencode;
  els["nb-key-field"].firstChild.textContent = opencode ? "Server password " : "API key ";
  if (!opencode && els["nb-agent"].value) els["nb-agent"].value = "";
}

function openSettings() {
  if (!state.bot) return;
  const bot = state.bot;
  // Save, Clear chat and Delete act on this agent even if the selection changes under the dialog.
  state.settingsBot = { id: bot.id, name: bot.name };
  state.setLook = normalizeLook(bot.avatar, bot.color);
  state.setColor = state.setLook.color || normalizeColor(bot.color);
  els["settings-title"].textContent = bot.name;
  els["set-name"].value = bot.name;
  els["set-group"].value = bot.group || "Personal";
  els["set-job"].value = bot.job;
  els["set-provider"].value = bot.model.provider;
  els["set-base"].value = bot.model.baseUrl;
  els["set-user"].value = bot.model.username;
  els["set-key"].value = "";
  els["set-model-custom"].value = "";
  els["set-model-custom"].hidden = true;
  els["set-agent"].value = bot.model.agent;
  const policy = bot.policy || {};
  state.permAllow = [...(policy.allow || [])];
  setSegment("perm-shell", policy.shell || "ask");
  setSegment("perm-files", policy.files || "ask");
  setSegment("perm-logins", policy.logins || "ask");
  setSegment("perm-plugins", policy.plugins || "ask");
  els["perm-add"].value = "";
  renderRuleChips();
  els["set-notify"].value = bot.notify || "important";
  els["set-cap-cost"].value = bot.limits?.dailyCost || 0;
  els["set-cap-tokens"].value = bot.limits?.dailyTokens || 0;
  els["set-cap-month-cost"].value = bot.limits?.monthlyCost || 0;
  els["set-cap-month-tokens"].value = bot.limits?.monthlyTokens || 0;
  els["set-pin"].checked = Boolean(bot.pinned);
  els["set-main"].checked = Boolean(bot.main);
  els["set-paused"].checked = bot.status === "off";
  els["set-status"].textContent = "";
  els["set-error"].textContent = "";
  els["set-model"].replaceChildren(new Option("Loading models…", ""));
  renderLookControls("set");
  syncSettingsFields();
  const picker = modelPicker("set");
  els["set-advanced"].open = false;
  if (picker) picker.value = { via: "opencode", model: "" };
  els["settings-dialog"].showModal();
  renderBackups(bot.model.fallbacks || []);
  // An agent on a connected provider edits its model with the picker; any other keeps the server fields.
  pickerValueFor(bot).then((value) => {
    if (state.bot?.id !== bot.id) return;
    if (picker && value) picker.value = value;
    else els["set-advanced"].open = true;
  });
}

// Backup models in Settings: one picker per row, in the order they are tried (server/fallback.js).
const MAX_BACKUPS = 3;
function renderBackups(list) {
  state.backupPickers = [];
  els["set-backups"].replaceChildren();
  for (const item of list) addBackupRow({ via: item.connection || (item.provider === "opencode" ? "opencode" : ""), model: item.model });
  syncBackupAdd();
}

function addBackupRow(value = null) {
  if (!window.RavnirModels?.picker || state.backupPickers.length >= MAX_BACKUPS) return null;
  const picker = window.RavnirModels.picker({ placeholder: "Choose a backup model" });
  if (value?.model) picker.value = value;
  const row = document.createElement("div");
  row.className = "backup-row";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Remove this backup model");
  remove.addEventListener("click", () => {
    state.backupPickers = state.backupPickers.filter((item) => item !== picker);
    row.remove();
    syncBackupAdd();
  });
  row.append(picker, remove);
  els["set-backups"].append(row);
  state.backupPickers.push(picker);
  syncBackupAdd();
  return picker;
}

function syncBackupAdd() {
  els["set-backup-add"].hidden = !window.RavnirModels?.picker || (state.backupPickers || []).length >= MAX_BACKUPS;
}

function backupValues() {
  return (state.backupPickers || []).map((picker) => picker.value).filter((value) => value?.model).map((value) => ({ via: value.via || "opencode", model: value.model }));
}

// Permissions in Settings: three-way choices and removable command rules.
function setSegment(id, value) {
  for (const button of $(id).querySelectorAll("button[data-value]")) {
    const on = button.dataset.value === value;
    button.classList.toggle("on", on);
    button.setAttribute("aria-checked", String(on));
  }
}

function segmentValue(id) {
  return $(id).querySelector("button.on")?.dataset.value || "ask";
}

function addPermissionRule() {
  const rule = els["perm-add"].value.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!rule) return;
  if (!state.permAllow.includes(rule)) state.permAllow.push(rule);
  els["perm-add"].value = "";
  renderRuleChips();
}

function renderRuleChips() {
  els["perm-chips"].replaceChildren();
  if (!state.permAllow.length) {
    els["perm-chips"].append(el("p", "hint", "No rules yet. Every command asks first."));
    return;
  }
  for (const rule of state.permAllow) {
    const chip = el("span", "rule-chip");
    const remove = el("button", "", "×");
    remove.type = "button";
    remove.title = "Remove this rule";
    remove.setAttribute("aria-label", `Remove the rule ${rule}`);
    remove.addEventListener("click", () => {
      state.permAllow = state.permAllow.filter((item) => item !== rule);
      renderRuleChips();
    });
    chip.append(el("code", "", rule), remove);
    els["perm-chips"].append(chip);
  }
}

function syncSettingsFields() {
  const opencode = els["set-provider"].value === "opencode";
  els["set-user-field"].hidden = !opencode;
  els["set-agent-field"].hidden = !opencode;
}

function lookFor(prefix) {
  return prefix === "nb" ? state.newLook : state.setLook;
}

function lookName(prefix) {
  return prefix === "nb" ? els["nb-name"].value.trim() || "New agent" : els["set-name"].value.trim() || state.bot?.name || "Agent";
}

function setLook(prefix, patch, { manual = true } = {}) {
  const look = normalizeLook({ ...lookFor(prefix), ...patch });
  if (prefix === "nb") {
    state.newLook = look;
    state.newColor = look.color || state.newColor;
    if (manual) state.newLookAuto = false;
  } else {
    state.setLook = look;
    state.setColor = look.color || state.setColor;
  }
  state.lookCards?.[prefix]?.refresh();
}

// The look card in New agent and Agent settings; the full studio opens from it (public/studio.js).
function renderLookControls(prefix) {
  if (!window.RavnirStudio) return;
  state.lookCards ||= {};
  state.lookCards[prefix] = RavnirStudio.card(els[`${prefix}-studio`], {
    look: () => lookFor(prefix),
    name: () => lookName(prefix),
    job: () => els[`${prefix}-job`].value,
    seed: prefix === "nb" ? "new-agent" : state.bot?.id || "agent",
    set: (look) => setLook(prefix, look),
  });
}

function refreshLookName(prefix) {
  state.lookCards?.[prefix]?.refresh();
}

// Until you touch the look, a new agent dresses for the job you describe.
function matchNewLook() {
  if (!state.newLookAuto || !window.RavnirAvatar) return;
  const name = els["nb-name"].value.trim();
  const job = els["nb-job"].value.trim();
  if (!name && !job) return;
  if (!RavnirAvatar.matches({ name, job })) return;
  setLook("nb", RavnirAvatar.suggest({ name, job, seed: "new-agent" }), { manual: false });
}

function modelValue(which) {
  const isNew = which === "nb";
  const select = isNew ? els["nb-model"] : els["set-model"];
  const custom = isNew ? els["nb-model-custom"] : els["set-model-custom"];
  return select.value === "__custom__" ? custom.value.trim() : select.value;
}

function syncModelCustom(which, { focus = true } = {}) {
  const isNew = which === "nb";
  const select = isNew ? els["nb-model"] : els["set-model"];
  const custom = isNew ? els["nb-model-custom"] : els["set-model-custom"];
  const visible = select.value === "__custom__";
  custom.hidden = !visible;
  if (visible && focus) custom.focus();
}

function selectableModels(models) {
  const connected = models.filter((model) => model.connected !== false);
  return connected.length ? connected : models;
}

function populateModelSelect(select, models, currentValue, { preferDefault = false, allowBlank = false } = {}) {
  select.replaceChildren();
  const visible = selectableModels(models);
  const groups = new Map();
  for (const model of visible) {
    const key = model.providerID || "models";
    if (!groups.has(key)) {
      const label = String(model.label || "").includes(" / ") ? String(model.label).split(" / ")[0] : key;
      groups.set(key, { label, items: [] });
    }
    groups.get(key).items.push(model);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    const priority = (key) => key === "opencode-go" ? 0 : key === "opencode" ? 1 : 2;
    return priority(a) - priority(b) || groups.get(a).label.localeCompare(groups.get(b).label);
  });
  for (const [key, group] of ordered) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label || key;
    for (const model of group.items) {
      const option = new Option(model.modelID || model.id, model.id);
      option.title = model.label || model.id;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
  if (allowBlank) select.prepend(new Option("Choose a model…", ""));
  select.append(new Option("Custom model id…", "__custom__"));
  const known = visible.some((model) => model.id === currentValue);
  if (currentValue && !known) {
    const option = new Option(`${currentValue} (not listed)`, currentValue);
    select.prepend(option);
  }
  if (currentValue) select.value = currentValue;
  else if (allowBlank) select.value = "";
  else if (preferDefault && visible.length) select.value = preferredModel(visible);
  else if (visible[0]) select.value = visible[0].id;
  else select.value = "__custom__";
}

function preferredModel(models) {
  for (const id of ["opencode-go/glm-5.3-flash", "opencode-go/gpt-6-luna", "opencode-go/kimi-k3"]) {
    if (models.some((model) => model.id === id)) return id;
  }
  return models[0]?.id || "";
}

async function createBot(event) {
  event.preventDefault();
  els["nb-error"].textContent = "";
  const name = els["nb-name"].value.trim();
  if (!name) {
    els["nb-error"].textContent = "Give the agent a name.";
    return;
  }
  const picked = !els["nb-advanced"].open && state.modelPickers?.nb ? state.modelPickers.nb.value : null;
  if (picked && !picked.model) {
    els["nb-error"].textContent = "Choose a model, or connect a provider in Settings, Models.";
    return;
  }
  const model = picked ? { via: picked.via, model: picked.model } : {
    provider: els["nb-provider"].value,
    baseUrl: els["nb-base"].value.trim(),
    username: els["nb-user"].value.trim(),
    model: modelValue("nb"),
    agent: els["nb-agent"].value.trim(),
  };
  if (!picked && els["nb-key"].value) model.apiKey = els["nb-key"].value;
  try {
    const detail = await api("/api/bots", {
      method: "POST",
      body: {
        name,
        group: els["nb-group"].value.trim(),
        job: els["nb-job"].value.trim(),
        prompt: els["nb-prompt"].value.trim(),
        color: state.newColor,
        avatar: state.newLook,
        model,
      },
    });
    els["new-bot-dialog"].close();
    await refreshState();
    await selectBot(detail.bot.id);
    toast(`${detail.bot.name} is on.`);
  } catch (error) {
    els["nb-error"].textContent = error.message;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const target = state.settingsBot;
  if (!target) return;
  els["set-error"].textContent = "";
  const picked = !els["set-advanced"].open && state.modelPickers?.set ? state.modelPickers.set.value : null;
  if (picked && !picked.model) {
    els["set-error"].textContent = "Choose a model.";
    return;
  }
  const model = picked ? { via: picked.via, model: picked.model, agent: els["set-agent"].value.trim() } : {
    provider: els["set-provider"].value,
    baseUrl: els["set-base"].value.trim(),
    username: els["set-user"].value.trim(),
    model: modelValue("set"),
    agent: els["set-agent"].value.trim(),
  };
  if (!picked && els["set-key"].value) model.apiKey = els["set-key"].value;
  model.fallbacks = backupValues();
  addPermissionRule();
  try {
    const detail = await api(`/api/bots/${target.id}`, {
      method: "PATCH",
      body: {
        name: els["set-name"].value.trim(),
        group: els["set-group"].value.trim(),
        job: els["set-job"].value.trim(),
        color: state.setColor,
        avatar: state.setLook,
        model,
        notify: els["set-notify"].value,
        policy: {
          shell: segmentValue("perm-shell"),
          allow: state.permAllow,
          files: segmentValue("perm-files"),
          logins: segmentValue("perm-logins"),
          plugins: segmentValue("perm-plugins"),
        },
        limits: {
          dailyCost: Number(els["set-cap-cost"].value) || 0,
          dailyTokens: Number(els["set-cap-tokens"].value) || 0,
          monthlyCost: Number(els["set-cap-month-cost"].value) || 0,
          monthlyTokens: Number(els["set-cap-month-tokens"].value) || 0,
        },
        pinned: els["set-pin"].checked,
        main: els["set-main"].checked,
        status: els["set-paused"].checked ? "off" : "on",
      },
    });
    applyDetail(detail);
    els["settings-dialog"].close();
    await refreshState();
    renderAll();
    toast("Agent settings saved.");
    if (state.panel === "mind") renderMind();
  } catch (error) {
    els["set-error"].textContent = error.message;
  }
}

async function clearChat() {
  const bot = state.settingsBot;
  if (!bot) return;
  const yes = await ask({
    kicker: "Danger zone",
    title: `Clear the chat with ${bot.name}?`,
    message: "This removes the whole conversation, including older messages the agent could search. Its memory, workspace, logins and jobs stay. This cannot be undone.",
    confirm: "Clear chat",
    danger: true,
  });
  if (!yes) return;
  try {
    await api(`/api/bots/${bot.id}/conversation`, { method: "DELETE" });
    els["settings-dialog"].close();
    forgetDraft(bot.id);
    await selectBot(bot.id);
    toast("Chat cleared.");
  } catch (error) {
    els["set-error"].textContent = error.message;
  }
}

async function deleteBot() {
  const target = state.settingsBot;
  if (!target) return;
  if (!confirm(`Delete ${target.name} and its workspace, browser profile, logins, and jobs?`)) return;
  try {
    await api(`/api/bots/${target.id}`, { method: "DELETE" });
    els["settings-dialog"].close();
    forgetDraft(target.id);
    if (state.botId === target.id) {
      state.bot = null;
      state.botId = "";
      localStorage.removeItem("ravnir.bot");
    }
    await refreshState();
    if (state.bots[0]) await selectBot(state.bots[0].id);
    else renderAll();
    toast("Agent deleted.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadModelsInto(which, { auto = false, current } = {}) {
  const loadId = (state.modelLoads[which] += 1);
  const isNew = which === "nb";
  const provider = isNew ? els["nb-provider"].value : els["set-provider"].value;
  const baseUrl = (isNew ? els["nb-base"] : els["set-base"]).value.trim();
  const username = (isNew ? els["nb-user"] : els["set-user"]).value.trim();
  const apiKey = (isNew ? els["nb-key"] : els["set-key"]).value;
  const status = isNew ? els["nb-status"] : els["set-status"];
  const select = isNew ? els["nb-model"] : els["set-model"];
  const button = isNew ? els["nb-load-models"] : els["set-load-models"];
  const selected = current !== undefined ? current : modelValue(which);
  if (!baseUrl) {
    status.textContent = "Enter the server address, then refresh the model list.";
    populateModelSelect(select, [], selected, { allowBlank: !isNew });
    syncModelCustom(which, { focus: false });
    return;
  }
  status.textContent = auto ? "Loading models from this server…" : "Loading…";
  button.disabled = true;
  try {
    const data = await api("/api/models", {
      method: "POST",
      body: {
        provider,
        baseUrl,
        username,
        apiKey,
        botId: isNew ? "" : state.bot?.id,
      },
    });
    if (loadId !== state.modelLoads[which]) return;
    const models = data.models || [];
    const visible = selectableModels(models);
    populateModelSelect(select, models, selected, { preferDefault: !selected && isNew, allowBlank: !isNew });
    syncModelCustom(which, { focus: false });
    status.textContent = visible.length
      ? `${visible.length} models${visible.length < models.length ? " from connected providers" : ""}${data.agents?.length ? ` · ${data.agents.length} agents` : ""}`
      : "No models returned. Choose Custom model id to type one.";
    if (isNew && provider === "opencode" && !els["nb-agent"].value) {
      const build = data.agents?.find((agent) => agent.id === "build");
      if (build) els["nb-agent"].value = "build";
    }
  } catch (error) {
    if (loadId !== state.modelLoads[which]) return;
    status.textContent = error.message;
    populateModelSelect(select, [], selected, { allowBlank: !isNew });
    syncModelCustom(which, { focus: false });
  } finally {
    if (loadId === state.modelLoads[which]) button.disabled = false;
  }
}

function openDiscover(target) {
  state.discoverTarget = target;
  els["discover-list"].replaceChildren();
  els["discover-status"].textContent = "Scanning this machine…";
  els["discover-dialog"].showModal();
  api("/api/discover").then((data) => {
    els["discover-status"].textContent = data.servers.length
      ? "Pick a server. Ravnir will reuse it."
      : "Nothing found. Start OpenCode or another OpenAI-compatible server, then try again.";
    renderDiscovered(data.servers);
  }).catch((error) => {
    els["discover-status"].textContent = error.message;
  });
}

function renderDiscovered(servers) {
  els["discover-list"].replaceChildren();
  for (const server of servers) {
    const item = document.createElement("div");
    item.className = "item";
    const head = document.createElement("div");
    head.className = "item-head";
    const copy = document.createElement("div");
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = server.name;
    const sub = document.createElement("div");
    sub.className = "item-sub";
    sub.textContent = `${server.kind} · ${server.baseUrl}${server.authRequired ? " · password required" : ""}`;
    copy.append(title, sub);
    const actions = document.createElement("div");
    actions.className = "item-actions";
    const use = document.createElement("button");
    use.type = "button";
    use.className = "ghost";
    use.textContent = "Use";
    use.addEventListener("click", () => applyDiscovered(server));
    actions.append(use);
    head.append(copy, actions);
    item.append(head);
    const note = document.createElement("p");
    note.className = "item-note";
    note.textContent = server.note || "";
    item.append(note);
    els["discover-list"].append(item);
  }
}

function applyDiscovered(server) {
  if (state.discoverTarget === "defaults") {
    window.applyDiscoveredDefault?.(server);
    els["discover-dialog"].close();
    return;
  }
  const isNew = state.discoverTarget === "new";
  const provider = isNew ? els["nb-provider"] : els["set-provider"];
  const base = isNew ? els["nb-base"] : els["set-base"];
  const user = isNew ? els["nb-user"] : els["set-user"];
  const key = isNew ? els["nb-key"] : els["set-key"];
  const select = isNew ? els["nb-model"] : els["set-model"];
  const status = isNew ? els["nb-status"] : els["set-status"];
  const current = modelValue(isNew ? "nb" : "set");
  provider.value = server.kind === "openai" ? "openai" : "opencode";
  base.value = server.baseUrl;
  if (server.kind === "opencode") user.value = "opencode";
  populateModelSelect(select, server.models || [], current, { preferDefault: !current && isNew, allowBlank: !isNew });
  syncModelCustom(isNew ? "nb" : "set", { focus: false });
  if (isNew) syncNewBotFields();
  else syncSettingsFields();
  status.textContent = server.authRequired
    ? "Enter the server password, then refresh the model list."
    : `${selectableModels(server.models || []).length} models found.`;
  els["discover-dialog"].close();
  if (server.authRequired) key.focus();
}

function renderSwatches(id, selected, onPick) {
  const host = $(id);
  host.replaceChildren();
  for (const color of window.RavnirAvatar?.COLORS || COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `swatch${color === selected ? " on" : ""}`;
    button.dataset.look = `color:${color}`;
    button.style.background = color;
    button.setAttribute("aria-label", color);
    button.addEventListener("click", () => {
      host.querySelectorAll(".swatch").forEach((item) => item.classList.remove("on"));
      button.classList.add("on");
      onPick(color);
    });
    host.append(button);
  }
}

// Replies render with public/markdown.js (tables, callouts, charts, diagrams). Returns { rich } so a
// reply with a table or chart gets a wider bubble. The small renderer below is the fallback.
function renderMarkdown(parent, text, options = {}) {
  if (window.RavnirMarkdown?.render) {
    try {
      return window.RavnirMarkdown.render(parent, text, options) || { rich: false };
    } catch {
      parent.replaceChildren();
    }
  }
  basicMarkdown(parent, text);
  return { rich: false };
}

function basicMarkdown(parent, text) {
  const source = String(text || "");
  const fence = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = fence.exec(source))) {
    addTextBlocks(parent, source.slice(last, match.index));
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = match[2].replace(/\n$/, "");
    if (match[1]) code.dataset.lang = match[1];
    pre.append(code);
    parent.append(pre);
    last = fence.lastIndex;
  }
  addTextBlocks(parent, source.slice(last));
}

function addTextBlocks(parent, text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) return;
  const chunks = normalized.split(/\n{2,}/);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    if (lines.length > 1 && lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const ul = document.createElement("ul");
      for (const line of lines) {
        const li = document.createElement("li");
        inline(li, line.replace(/^\s*[-*]\s+/, ""));
        ul.append(li);
      }
      parent.append(ul);
      continue;
    }
    if (lines.length > 1 && lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      const ol = document.createElement("ol");
      for (const line of lines) {
        const li = document.createElement("li");
        inline(li, line.replace(/^\s*\d+[.)]\s+/, ""));
        ol.append(li);
      }
      parent.append(ol);
      continue;
    }
    if (/^#{1,3}\s+/.test(lines[0]) && lines.length === 1) {
      const heading = document.createElement("h3");
      heading.style.fontSize = "15px";
      heading.style.margin = "4px 0 6px";
      inline(heading, lines[0].replace(/^#{1,3}\s+/, ""));
      parent.append(heading);
      continue;
    }
    const p = document.createElement("p");
    lines.forEach((line, index) => {
      if (index) p.append(document.createElement("br"));
      inline(p, line);
    });
    parent.append(p);
  }
}

// One-line preview of markdown: drops the markers renderMarkdown would turn into formatting.
function plainText(text) {
  if (window.RavnirMarkdown?.plain) return window.RavnirMarkdown.plain(text);
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<]+)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const link = document.createElement("a");
      link.href = linkMatch[2];
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = linkMatch[1];
      parent.append(link);
    } else {
      const link = document.createElement("a");
      link.href = token;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = token;
      parent.append(link);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    setOffline(true);
    throw new Error("Cannot reach the server. Reconnecting…");
  }
  // A proxy in front of a stopped server answers 502 to 504; the server itself never does.
  if ([502, 503, 504].includes(response.status)) setOffline(true);
  else setOffline(false);
  if (response.status === 401) {
    signedOut();
    throw new Error("You are signed out.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

// The session ended (expired, or signed out everywhere): back to the sign-in page, then back here.
function signedOut() {
  if (state.signingOut) return;
  state.signingOut = true;
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

// A slim bar at the top of the thread while the server cannot be reached; it clears on the next good answer.
function setOffline(offline) {
  if (state.offline === offline) return;
  state.offline = offline;
  els["net-bar"].hidden = !offline;
  els["server-pulse"].classList.toggle("bad", offline);
  if (!offline) els["net-bar"].textContent = "Reconnecting…";
}

function toast(message, kind = "") {
  if (!message) return;
  els.toast.textContent = message;
  els.toast.className = `toast${kind === "error" ? " error" : ""}`;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, 3800);
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return `${parts[0]?.[0] || "?"}${parts[1]?.[0] || ""}`.toUpperCase();
}

function shortModel(model) {
  const value = String(model || "");
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 40);
  } catch {
    return String(url || "").slice(0, 40);
  }
}

// The user is in Spain: 24-hour clock and day-first dates everywhere, whatever the phone's region says.
const LOCALE = "en-GB";
// A gold star marks the main agent everywhere it is named (pinned row, agent list, thread header).
const MAIN_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9z"/></svg>';
function mainStar(className) {
  const star = document.createElement("span");
  star.className = `main-star ${className}`;
  star.title = "Main agent";
  star.setAttribute("role", "img");
  star.setAttribute("aria-label", "Main agent");
  star.innerHTML = MAIN_STAR;
  return star;
}
const PIN_ICON ='<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 3.5h6l-1 6 3.2 3.2V15H6.8v-2.3L10 9.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 15v5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function clockTime(at) {
  return new Date(at).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function shortDate(at, { year = false, weekday = false } = {}) {
  return new Date(at).toLocaleDateString(LOCALE, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), ...(weekday ? { weekday: "short" } : {}) });
}

// "Today 14:32", "Yesterday 21:05", "Mon 14:32" within the week, "20 Oct 09:00" before that.
function stampLabel(at) {
  if (!at) return "Today";
  const date = new Date(at);
  const now = new Date();
  const time = clockTime(at);
  if (date.toDateString() === now.toDateString()) return `Today ${time}`;
  if (date.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return `Yesterday ${time}`;
  if (now.getTime() - at < 6 * 86_400_000) return `${date.toLocaleDateString(LOCALE, { weekday: "short" })} ${time}`;
  return `${shortDate(at, { year: date.getFullYear() !== now.getFullYear() })} ${time}`;
}

function timeAgo(timestamp) {
  if (!timestamp) return "never";
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatBytes(size) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readStored(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the view just will not be remembered.
  }
}

// Today: one place for what every bot did, what waits for you, and what runs next.

function isPhone() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function isTouchDevice() {
  return window.matchMedia("(hover: none)").matches;
}

// The composer hint says what the keys do here.
function syncComposerHint() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  els["composer-hint"].textContent = isTouchDevice()
    ? "Return for a new line · tap ↑ to send · @ to tag an agent"
    : `Enter to send · Shift+Enter for a new line · @ to tag an agent · ${mac ? "⌘K" : "Ctrl+K"} to switch agent`;
}

// On a phone the bot list is the Agents tab, like Grok Bot: the main bot on
// top, every other bot underneath. Home, Inbox and More sit on a bottom tab bar
// that hides inside an agent thread, where the back chevron takes over.
function openHome() {
  els.shell.classList.remove("mobile-thread", "rail-open");
  closeComputer();
  syncTabbar();
}

function openMobileView() {
  if (isPhone()) els.shell.classList.add("mobile-thread");
  els.shell.classList.remove("rail-open");
  syncTabbar();
}

function currentTab() {
  if (!isPhone()) return "";
  if (state.sheetKind === "more") return "more";
  if (!els.shell.classList.contains("mobile-thread")) return "agents";
  return { today: "home", inbox: "inbox", import: "more", plugins: "more", skills: "more", memory: "more", settings: "more", bot: "thread" }[state.view] || "agents";
}

function syncTabbar() {
  const tab = currentTab();
  els.shell.classList.toggle("tabbar-on", Boolean(tab) && tab !== "thread");
  for (const button of els["tabbar"].querySelectorAll("button[data-tab]")) {
    const on = button.dataset.tab === tab;
    button.classList.toggle("on", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function goTab(tab) {
  closeSheet();
  closeComputer();
  if (tab === "home") openToday();
  else if (tab === "inbox") openInbox();
  else if (tab === "more") openMoreMenu();
  else openHome();
}

function openComputer() {
  if (!state.bot) return;
  els.shell.classList.add("computer-open");
  showPanel(state.panel || "screen");
  requestAnimationFrame(() => revealTab(state.panel));
}

function closeComputer() {
  els.shell.classList.remove("computer-open");
  els.computer.style.transform = "";
  els.computer.style.transition = "";
}

// A bottom sheet of actions: the More tab and the thread menu on a phone.
const SHEET_ICONS = {
  import: '<path d="M10 3v9m0 0 3.2-3.2M10 12 6.8 8.8"/><path d="M4 13.5V16h12v-2.5"/>',
  memory: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12H5.5A1.5 1.5 0 0 0 4 16.5Z"/><path d="M4 16.5A1.5 1.5 0 0 0 5.5 18H16"/><path d="M8 7h5M8 10h3"/>',
  skills: '<path d="M9 3.2l1.5 4.1 4.1 1.5-4.1 1.5L9 14.4l-1.5-4.1-4.1-1.5 4.1-1.5Z"/><path d="M15 12.6l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6Z"/>',
  plugins: '<rect x="3" y="3" width="5.6" height="5.6" rx="1.5"/><rect x="11.4" y="3" width="5.6" height="5.6" rx="1.5"/><rect x="3" y="11.4" width="5.6" height="5.6" rx="1.5"/><path d="M14.2 11.6v5.2M11.6 14.2h5.2"/>',
  bell: '<path d="M5.4 13.6h9.2l-1.2-1.8V9a3.4 3.4 0 0 0-6.8 0v2.8Z"/><path d="M8.6 15.8a1.5 1.5 0 0 0 2.8 0"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12H5.5A1.5 1.5 0 0 0 4 16.5Z"/><path d="M4 16.5A1.5 1.5 0 0 0 5.5 18H16"/>',
  edit: '<path d="M4 16h3l8-8-3-3-8 8Z"/><path d="m10.6 6.4 3 3"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.6 9.5h6.8L14 6"/>',
  pause: '<path d="M7.5 5v10M12.5 5v10"/>',
  group: '<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.8H15a1.5 1.5 0 0 1 1.5 1.5V14A1.5 1.5 0 0 1 15 15.5H5A1.5 1.5 0 0 1 3.5 14Z"/><path d="M10 9v3.4M8.3 10.7h3.4"/>',
  search: '<circle cx="8.6" cy="8.6" r="5.2"/><path d="M12.5 12.5 17 17"/>',
  out: '<path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/><path d="M12 6.5 15.5 10 12 13.5M15.5 10H8"/>',
  screen: '<rect x="3" y="4" width="14" height="9.5" rx="1.8"/><path d="M7 16.5h6M10 13.5v3"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 3v1.8M10 15.2V17M3 10h1.8M15.2 10H17M5.1 5.1l1.3 1.3M13.6 13.6l1.3 1.3M14.9 5.1l-1.3 1.3M6.4 13.6l-1.3 1.3"/>',
  steps: '<path d="M4 6h12M4 10h8M4 14h10"/>',
  diff: '<rect x="3.5" y="3" width="13" height="14" rx="2.2"/><path d="M10 6.4v3.6M8.2 8.2h3.6M8.2 13.2h3.6"/>',
  sound: '<path d="M3.5 8h2.8L10 4.8v10.4L6.3 12H3.5Z"/><path d="M13 7.4a3.6 3.6 0 0 1 0 5.2M15.2 5.4a6.4 6.4 0 0 1 0 9.2"/>',
  voice: '<path d="M4 8.5v3M7.3 6v8M10.6 3.5v13M13.9 6.5v7M17 8.8v2.4"/>',
};

function sheetIcon(name) {
  const icon = el("span", "sheet-icon");
  icon.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHEET_ICONS[name] || ""}</svg>`;
  return icon;
}

// anchor: on a computer the sheet opens as a menu under that element instead of rising from the bottom.
function openSheet({ title = "", items = [], foot = "", kind = "", head = null, anchor = null }) {
  els["sheet-title"].textContent = title;
  els["sheet-title"].hidden = !title || Boolean(head);
  els["sheet-list"].replaceChildren();
  if (head) els["sheet-list"].append(head);
  const anchored = Boolean(anchor) && !isPhone();
  els["sheet"].classList.toggle("anchored", anchored);
  if (anchored) {
    const box = anchor.getBoundingClientRect();
    els["sheet"].style.setProperty("--sheet-x", `${Math.max(8, Math.min(box.left, window.innerWidth - 348))}px`);
    els["sheet"].style.setProperty("--sheet-y", `${box.bottom + 6}px`);
  }
  for (const item of items) {
    if (item.separator) {
      els["sheet-list"].append(el("div", "sheet-sep"));
      continue;
    }
    const row = el("button", `sheet-row${item.danger ? " danger" : ""}`);
    row.type = "button";
    row.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (item.checked !== undefined) row.setAttribute("aria-checked", String(item.checked));
    if (item.icon) row.append(sheetIcon(item.icon));
    const copy = el("span", "sheet-copy");
    copy.append(el("span", "sheet-label", item.label));
    if (item.hint) copy.append(el("small", "", item.hint));
    row.append(copy);
    if (item.checked !== undefined) row.append(el("span", `sheet-check${item.checked ? " on" : ""}`, item.checked ? "✓" : ""));
    row.addEventListener("click", () => {
      closeSheet();
      item.onSelect?.();
    });
    els["sheet-list"].append(row);
  }
  els["sheet-foot"].textContent = foot;
  els["sheet-foot"].hidden = !foot;
  state.sheetKind = kind;
  els["sheet"].classList.add("show");
  syncTabbar();
}

function closeSheet() {
  if (!els["sheet"].classList.contains("show")) return;
  els["sheet"].classList.remove("show");
  state.sheetKind = "";
  els["sheet"].querySelector(".sheet-panel").style.transform = "";
  syncTabbar();
}

function openMoreMenu() {
  const items = [
    { icon: "memory", label: "Memory", hint: "What your agents wrote down, and undo it", onSelect: () => openMemory() },
    { icon: "skills", label: "Skills", hint: "Teach agents research, writing, finance and more", onSelect: () => openSkills() },
    { icon: "plugins", label: "Plugins", hint: "Connect Gmail, GitHub, Notion and more", onSelect: () => openPlugins() },
    { icon: "gear", label: "Settings", hint: "Appearance, notifications, new agents, security", onSelect: () => openSettingsPage() },
    { icon: "import", label: "Import from Grok Bot", hint: "Bring an agent over with its memory and routines", onSelect: () => openImport() },
    { icon: "bell", label: "Notification settings", hint: "Pings, quiet hours and devices", onSelect: () => window.openNotificationSettings?.() },
    { icon: "book", label: "Setup guide", onSelect: () => window.open("/setup", "_blank", "noopener") },
    { icon: "group", label: "New group", onSelect: () => createNewGroup() },
    { icon: "search", label: "Find models", hint: "Look for model servers on this network", onSelect: () => openDiscover("new") },
  ];
  if (state.server?.auth) items.push({ separator: true }, { icon: "out", label: "Sign out", danger: true, onSelect: () => signOut() });
  openSheet({ title: "More", items, foot: state.server?.url ? state.server.url.replace(/^https?:\/\//, "") : "", kind: "more" });
}

function openThreadMenu(anchor = null) {
  if (!state.bot) return;
  const bot = state.bot;
  const model = bot.model?.model ? `${bot.model.provider === "opencode" ? "OpenCode" : "API"} · ${shortModel(bot.model.model)}` : "Choose a model";
  // Like a contact card: who this is, then what you can do with it.
  const head = el("div", "sheet-agent");
  const face = el("span", "avatar sheet-agent-face");
  paintCreature(face, bot);
  const copy = el("span", "sheet-agent-copy");
  copy.append(el("strong", "", bot.name), el("span", "", bot.job || ""));
  head.append(face, copy);
  const voice = !document.getElementById("voice-btn")?.hidden;
  openSheet({
    title: bot.name,
    head,
    anchor,
    items: [
      { icon: "gear", label: "Agent settings", hint: model, onSelect: openSettings },
      { icon: "screen", label: "Open the computer", hint: "Screen, files, shell, jobs and more", onSelect: openComputer },
      { icon: "skills", label: "Capability card", hint: "What it can do, measured on real tasks", onSelect: () => { openComputer(); showPanel("card"); } },
      ...(voice ? [{ icon: "voice", label: "Talk by voice", hint: "Hands free, it answers out loud", onSelect: () => window.RavnirVoice?.open() }] : []),
      { icon: "pause", label: "Pause this agent", hint: "Routines and other agents wait", checked: bot.status === "off", onSelect: () => setBotPaused(bot, bot.status !== "off") },
      { separator: true },
      { icon: "steps", label: "Show tool steps", checked: state.showThinking, onSelect: () => setShowThinking(!state.showThinking) },
      { icon: "diff", label: "Show diffs in the thread", checked: state.showDiffs, onSelect: () => setShowDiffs(!state.showDiffs) },
      { icon: "sound", label: "Sound on replies", checked: state.sound, onSelect: () => setSound(!state.sound) },
    ],
    kind: "thread",
  });
}

// Pull a sheet down to dismiss it.
function dragToClose(node, handle, close) {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  handle.addEventListener("touchstart", (event) => {
    if (!isPhone() || event.touches.length !== 1) return;
    dragging = true;
    dy = 0;
    startY = event.touches[0].clientY;
    node.style.transition = "none";
  }, { passive: true });
  handle.addEventListener("touchmove", (event) => {
    if (!dragging) return;
    dy = Math.max(0, event.touches[0].clientY - startY);
    node.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    node.style.transition = "";
    if (dy > 90) close();
    node.style.transform = "";
  };
  handle.addEventListener("touchend", end);
  handle.addEventListener("touchcancel", end);
}

function watchSheetDrag() {
  dragToClose(els.computer, els.computer.querySelector(".profile-head"), closeComputer);
  const panel = els["sheet"].querySelector(".sheet-panel");
  dragToClose(panel, panel.querySelector(".sheet-grab"), closeSheet);
}

// The panel tabs scroll sideways; the edge fades say there is more.
function updateTabFade() {
  const nav = els["computer-tabs"];
  const max = nav.scrollWidth - nav.clientWidth;
  els["tabs-wrap"].classList.toggle("fade-left", nav.scrollLeft > 4);
  els["tabs-wrap"].classList.toggle("fade-right", max > 4 && nav.scrollLeft < max - 4);
}

function revealTab(name) {
  const nav = els["computer-tabs"];
  const button = nav.querySelector(`button[data-group="${PANEL_GROUP[name]}"]`);
  if (!button || !nav.clientWidth) return updateTabFade();
  const left = button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2;
  nav.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  updateTabFade();
}

function setView(view) {
  const was = state.view;
  state.view = view;
  if (view !== "import") writeStored("ravnir.view", view);
  renderView();
  // The computer is hidden while a page view is open, which resets the tab strip's scroll.
  if (view === "bot" && was !== "bot") requestAnimationFrame(() => revealTab(state.panel));
}

// Home, Inbox and Import are full-width pages that replace the thread and hide the computer.
function renderView() {
  const page = state.view !== "bot";
  els.shell.classList.toggle("today-mode", page);
  els.thread.classList.toggle("today-mode", page);
  els["today-view"].hidden = state.view !== "today";
  els["inbox-view"].hidden = state.view !== "inbox";
  els["import-view"].hidden = state.view !== "import";
  els["plugins-view"].hidden = state.view !== "plugins";
  els["skills-view"].hidden = state.view !== "skills";
  els["skills-nav"].classList.toggle("active", state.view === "skills");
  els["memory-view"].hidden = state.view !== "memory";
  els["memory-nav"].classList.toggle("active", state.view === "memory");
  els["settings-view"].hidden = state.view !== "settings";
  els["plugins-nav"].classList.toggle("active", state.view === "plugins");
  els["settings-nav"].classList.toggle("active", state.view === "settings");
  els["today-nav"].classList.toggle("active", state.view === "today");
  els["inbox-nav"].classList.toggle("active", state.view === "inbox");
  if (page) {
    els["empty-thread"].hidden = true;
    els["permission-bar"].hidden = true;
  } else {
    els["empty-thread"].hidden = Boolean(state.bot);
    syncPermissionBar();
  }
  syncTabbar();
  renderRail();
}

// Notification links and /?view=inbox, /?view=today, /?bot=<id> open the matching page.
function routeTo(target) {
  let url;
  try {
    url = new URL(target, location.origin);
  } catch {
    return;
  }
  if (url.origin !== location.origin) return;
  const bot = url.searchParams.get("bot");
  const view = url.searchParams.get("view");
  const panel = url.searchParams.get("panel");
  if (bot && state.bots.some((item) => item.id === bot)) {
    selectBot(bot).then(() => {
      if (!PANELS.includes(panel)) return;
      openComputer();
      showPanel(panel);
    });
  }
  else if (view === "inbox") openInbox();
  else if (view === "today" || view === "home") openToday();
  else if (view === "import") openImport();
  else if (view === "plugins") openPlugins(url.searchParams.get("plugin") || "");
  else if (view === "skills") openSkills(url.searchParams.get("skill") || "");
  else if (view === "memory") openMemory(url.searchParams.get("commit") || url.searchParams.get("section") || "");
  else if (view === "settings") openSettingsPage(url.searchParams.get("section") || "");
}

function consumeDeepLink() {
  if (!location.search) return;
  routeTo(location.href);
  history.replaceState(null, "", location.pathname);
}

async function openInbox() {
  setView("inbox");
  state.permissionExpanded = false;
  els.shell.classList.remove("rail-open", "computer-open");
  openMobileView();
  await openInboxPage();
}

// The Plugins page (public/plugins.js). `id` opens that plugin's sheet.
async function openPlugins(id = "") {
  setView("plugins");
  els.shell.classList.remove("rail-open", "computer-open");
  closeComputer();
  openMobileView();
  await window.openPluginsPage?.(id);
}

// The Skills page (public/skills.js). `name` opens that skill's sheet.
async function openSkills(name = "") {
  setView("skills");
  els.shell.classList.remove("rail-open", "computer-open");
  closeComputer();
  openMobileView();
  await window.RavnirSkills?.open(name);
}

// The Memory page (public/memory.js). `target` is a commit to open, or "backup" to scroll to the backup section.
async function openMemory(target = "") {
  setView("memory");
  els.shell.classList.remove("rail-open", "computer-open");
  closeComputer();
  openMobileView();
  await window.RavnirMemory?.open(target);
}

// The global Settings page (public/settings.js). `section` scrolls to that card.
async function openSettingsPage(section = "") {
  setView("settings");
  state.permissionExpanded = false;
  els.shell.classList.remove("rail-open", "computer-open");
  closeComputer();
  openMobileView();
  await window.openSettingsView?.(section);
}

async function openImport() {
  setView("import");
  els.shell.classList.remove("rail-open", "computer-open");
  openMobileView();
  openImportPage();
}

async function signOut() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // Leave anyway: the login page shows whether the session is still valid.
  }
  location.href = "/login";
}

async function openToday(day = state.today.day) {
  state.today.day = day || "";
  setView("today");
  state.permissionExpanded = false;
  els.shell.classList.remove("rail-open", "computer-open");
  openMobileView();
  renderToday();
  await loadToday();
}

async function loadToday() {
  if (state.today.loading) return;
  state.today.loading = true;
  const day = state.today.day;
  try {
    const data = await api(`/api/today${day ? `?day=${day}` : ""}`);
    // The user may have stepped to another day while this one loaded; keep only the day on screen.
    if (day === state.today.day) {
      state.today.data = data;
      renderToday();
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.today.loading = false;
    if (day !== state.today.day) loadToday();
  }
}

function applyInbox(inbox) {
  if (!inbox) return;
  state.inbox = inbox;
  const waiting = (inbox.approvals || 0) + (inbox.specs || 0) + (inbox.proposals || 0) + (inbox.questions || 0) + (inbox.failures || 0) + (inbox.stuck || 0);
  for (const id of ["today-badge", "today-badge-mobile", "tab-home-badge"]) {
    els[id].hidden = !waiting;
    els[id].textContent = String(waiting);
  }
  // The count also shows in the browser tab and on the home-screen app icon.
  document.title = waiting ? `(${waiting}) Ravnir` : "Ravnir";
  if (waiting !== state.badge) {
    state.badge = waiting;
    const badge = waiting ? navigator.setAppBadge?.(waiting) : navigator.clearAppBadge?.();
    badge?.catch?.(() => {});
  }
  noticeBadge(inbox);
  const spent = inbox.today;
  els["today-spend"].textContent = spent?.turns ? money(spent.cost) : "";
  els["today-spend"].title = spent?.turns ? `${spent.turns} turns and ${tokenLabel(spent.tokens)} today` : "";
}

function shiftDay(day, delta) {
  const base = day ? new Date(`${day}T12:00:00`) : new Date();
  base.setDate(base.getDate() + delta);
  if (base.getTime() > Date.now()) return "";
  return isoDay(base);
}

function isoDay(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function renderToday() {
  const data = state.today.data;
  const body = els["today-body"];
  const shown = data ? new Date(data.day) : state.today.day ? new Date(`${state.today.day}T12:00:00`) : new Date();
  const isToday = data ? data.isToday : !state.today.day;
  els["today-kicker"].textContent = isToday ? "Home · Today" : "Home · Looking back";
  els["today-title"].textContent = shown.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
  els["today-next"].disabled = isToday;
  els["today-now"].hidden = isToday;
  const scroll = body.scrollTop;
  // public/home.js builds the page and keeps its own nodes across redraws.
  window.RavnirHome?.render(body, data);
  body.scrollTop = scroll;
}

// Spec files that changed since the approved copy, with Review, Apply and Dismiss.
function specsSection(specs) {
  const section = todaySection("Spec changes", "These agents still follow the copy you approved. Review the change before it reaches them.");
  for (const item of specs) {
    const card = el("div", "today-card");
    const head = el("div", "today-card-head");
    head.append(botBadge(item.botId, item.botName), el("span", `pill ${item.status === "missing" ? "bad" : "warn"}`, item.status === "missing" ? "file missing" : "changed"));
    const path = el("p", "mono small muted", item.path);
    const actions = el("div", "row approval-actions");
    const open = state.today.openSpecs.has(item.botId);
    const review = el("button", "primary", open ? "Hide diff" : "Review");
    review.type = "button";
    review.addEventListener("click", async () => {
      if (state.today.openSpecs.has(item.botId)) {
        state.today.openSpecs.delete(item.botId);
        renderToday();
        return;
      }
      state.today.openSpecs.add(item.botId);
      renderToday();
      try {
        const view = await api(`/api/bots/${item.botId}/spec`);
        state.today.specViews.set(item.botId, view);
        renderToday();
      } catch (error) {
        toast(error.message, "error");
        state.today.openSpecs.delete(item.botId);
        renderToday();
      }
    });
    const apply = el("button", "ghost", "Apply change");
    apply.type = "button";
    apply.disabled = item.status !== "changed";
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      try {
        await api(`/api/bots/${item.botId}/spec/apply`, { method: "POST" });
        toast("Spec applied. The agent follows the new copy from its next turn.");
        state.today.openSpecs.delete(item.botId);
        state.today.specViews.delete(item.botId);
        await Promise.all([loadToday(), refreshState()]);
      } catch (error) {
        toast(error.message, "error");
        apply.disabled = false;
      }
    });
    const dismiss = el("button", "ghost", "Dismiss");
    dismiss.type = "button";
    dismiss.title = "Stop asking about this version until the file changes again.";
    dismiss.addEventListener("click", async () => {
      dismiss.disabled = true;
      try {
        await api(`/api/bots/${item.botId}/spec/dismiss`, { method: "POST" });
        state.today.openSpecs.delete(item.botId);
        state.today.specViews.delete(item.botId);
        await Promise.all([loadToday(), refreshState()]);
      } catch (error) {
        toast(error.message, "error");
        dismiss.disabled = false;
      }
    });
    const mind = el("button", "ghost", "Open in Mind");
    mind.type = "button";
    mind.addEventListener("click", async () => {
      await selectBot(item.botId);
      showPanel("mind");
      els.shell.classList.add("computer-open");
    });
    actions.append(review, apply, dismiss, mind);
    card.append(head, path);
    if (item.error) card.append(el("p", "hint", item.error));
    if (state.today.openSpecs.has(item.botId)) {
      const view = state.today.specViews.get(item.botId);
      if (view?.diff) {
        const wrap = el("div", "today-spec-diff");
        wrap.append(buildPatch(view.diff));
        card.append(wrap);
      } else if (!view) {
        card.append(note("Loading the diff…"));
      } else {
        card.append(note("No text diff is available. The file may be missing."));
      }
    }
    card.append(actions);
    section.append(card);
  }
  return section;
}

// Approvals answered on the shown day.
function answeredSection(decided) {
  const section = todaySection("Answered", "");
  const list = el("div", "today-list");
  for (const item of decided.slice(0, 40)) {
    const row = el("div", "today-row");
    row.append(
      el("span", "today-time", clockTime(item.decidedAt || item.createdAt)),
      botBadge(item.botId, item.botName),
      el("span", "today-row-text", `${item.title}${item.detail ? `: ${item.detail.split("\n")[0]}` : ""}`),
      el("span", `pill ${item.status === "approved" ? "ok" : item.status === "rejected" ? "bad" : ""}`, item.status),
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

function approvalCard(request) {
  const card = el("div", "today-card approval-card");
  const head = el("div", "today-card-head");
  const left = Math.max(0, request.expiresAt - Date.now());
  head.append(
    botBadge(request.botId, request.botName),
    el("span", "today-row-meta", `${request.source === "job" ? "routine" : request.source === "bot" ? "asked by an agent" : "chat"} · asked ${timeAgo(request.createdAt)} · ${Math.ceil(left / 60000)} min left`),
  );
  card.append(head, el("p", "today-card-title", request.title));
  if (request.detail) card.append(el("pre", "approval-detail", request.detail));
  if (request.kind === "takeover") return takeoverCard(card, request);
  const actions = el("div", "row approval-actions");
  for (const [decision, label, kind] of [["once", "Allow once", "primary"], ["always", "Always allow", "ghost"], ["reject", "Deny", "ghost danger-text"]]) {
    if (decision === "always" && request.onceOnly) continue;
    const button = el("button", kind, label);
    button.type = "button";
    button.addEventListener("click", () => decideApproval(request.id, decision, button));
    actions.append(button);
  }
  const trust = el("button", "trust-link", "Trust this agent");
  trust.type = "button";
  trust.title = "Stop asking for terminal, file, and login approvals on this agent";
  trust.addEventListener("click", () => {
    if (confirmTrust(request.botName)) decideApproval(request.id, "trust", trust);
  });
  actions.append(trust);
  card.append(actions);
  const rule = ruleNote(request);
  if (rule) card.append(rule);
  return card;
}

// An agent asked the user to sign in on its screen (public/live.js, server/live.js).
function takeoverCard(card, request) {
  const actions = el("div", "row approval-actions");
  const take = el("button", "primary", "Take control");
  take.type = "button";
  take.addEventListener("click", () => openTakeover(request, request.botId, request.botName));
  const later = el("button", "ghost danger-text", "Not now");
  later.type = "button";
  later.addEventListener("click", () => decideApproval(request.id, "reject", later));
  actions.append(take, later);
  card.append(actions, el("p", "approval-rule", "Opens the agent's screen so you can sign in yourself. The agent waits until you press Done."));
  return card;
}

function openTakeover(request, botId, botName) {
  if (!request || !botId) return;
  if (!window.RavnirLive) {
    toast("The live view could not load. Reload the page and try again.", "error");
    return;
  }
  window.RavnirLive.open({ botId, botName, mode: "signin", url: request.data?.url || "" });
}

// "Always allow saves the rule `git status *`." under the approval buttons.
function ruleNote(request, className = "approval-rule") {
  if (request.kind === "takeover") return null;
  if (request.onceOnly) return el("p", className, "Chained commands always ask, so this one can only be allowed once.");
  if (!request.rule) return null;
  const line = el("p", className);
  line.append("Always allow saves the rule ", el("code", "", request.rule), ".");
  return line;
}

function confirmTrust(name) {
  return confirm(`Stop asking for terminal, file and login approvals for ${name || "this agent"}? You can change this in its settings.`);
}

async function decideApproval(id, decision, button) {
  button.disabled = true;
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: { decision } });
    toast(decision === "reject" ? "Denied." : "Approved.");
  } catch (error) {
    toast(error.message, "error");
  }
  state.approvals = state.approvals.filter((item) => item.id !== id);
  await Promise.all([loadToday(), refreshBots()]);
}

// schedule.js draws the job cards; this adds what each one cost over 30 days and per run
// (job.spend and job.runs[].spent come from the ledger). Cards come out in the order of state.jobs.
function renderJobsWithSpend() {
  const openRuns = new Set([...els["job-list"].querySelectorAll(".job-runs[open]")].map((node) => node.closest(".item")?.dataset.jobId));
  renderJobs();
  for (const job of state.jobs) {
    const card = els["job-list"].querySelector(`:scope > .item[data-job-id="${CSS.escape(job.id)}"]`);
    if (!card) continue;
    const spend = job.spend;
    if (spend?.turns) {
      const billed = spend.cost > 0 ? money(spend.cost) : "$0";
      card.querySelector(".job-schedule")?.after(el("p", "job-spend", `30 days: ${billed} over ${spend.turns} run${spend.turns === 1 ? "" : "s"}`));
    }
    const runs = (job.runs || []).slice().reverse();
    if (!runs.length) continue;
    const details = document.createElement("details");
    details.className = "job-details job-runs";
    details.open = openRuns.has(job.id);
    details.append(el("summary", "", `Run history (${runs.length})`));
    for (const run of runs) {
      const line = el("div", `job-run${run.quiet ? " quiet" : ""}`);
      const cost = run.quiet ? "No news" : run.spent ? (run.spent.billing === "free" ? "Free" : run.spent.billing === "metered" ? money(run.spent.cost) : tokenLabel(run.spent.tokens)) : "";
      line.append(
        el("span", "job-run-when", stampLabel(run.at)),
        el("span", `pill${run.status === "ok" ? " ok" : " bad"}`, run.status === "ok" ? "ok" : run.status || "failed"),
        el("span", "job-run-summary", plainText(run.summary || "").slice(0, 120)),
      );
      if (cost) line.append(el("span", "job-run-cost", run.quiet && run.spent?.cost ? `No news · ${money(run.spent.cost)}` : cost));
      details.append(line);
    }
    card.append(details);
  }
}

function turnCard(row) {
  const card = el("div", `today-card turn-card${row.status !== "ok" ? ` ${row.status}` : ""}`);
  const head = el("div", "today-card-head");
  const source = row.source === "job"
    ? row.jobName || "Routine"
    : row.source === "bot" ? `From ${row.fromBotName || "an agent"}`
      : row.source === "mention" ? `Tagged by ${row.fromBotName || "you"}` : "Chat";
  const label = el("span", `pill${row.source === "job" ? " routine" : ""}`, source);
  head.append(el("span", "today-time", clockTime(row.at)), botBadge(row.botId, row.botName), label);
  if (row.status !== "ok") head.append(el("span", `pill ${row.status === "error" ? "bad" : "warn"}`, row.status));
  const meta = [tokenLabel(tokensOfUsage(row.usage)), money(row.usage?.cost || 0), duration(row.durationMs)].join(" · ");
  head.append(el("span", "today-row-meta push", meta));
  card.append(head);
  const text = row.status === "ok" ? row.summary : row.error || row.summary;
  if (text) {
    const open = state.today.open.has(row.id);
    const summary = el("div", `turn-summary${open ? " open" : ""}`);
    if (open) renderMarkdown(summary, text);
    else summary.textContent = plainText(text).slice(0, 280);
    summary.addEventListener("click", () => {
      if (state.today.open.has(row.id)) state.today.open.delete(row.id);
      else state.today.open.add(row.id);
      renderToday();
    });
    card.append(summary);
  }
  return card;
}

function botBadge(botId, name) {
  const bot = state.bots.find((item) => item.id === botId);
  const button = el("button", "bot-badge");
  button.type = "button";
  const avatar = el("span", "avatar xs");
  if (bot) paintCreature(avatar, bot);
  else clearAvatar(avatar, initials(name));
  button.append(avatar, el("span", "", bot?.name || name || "Deleted agent"));
  if (bot) button.addEventListener("click", () => selectBot(bot.id));
  else button.disabled = true;
  return button;
}

function todaySection(title, hint) {
  const section = el("section", "today-section");
  section.append(el("h2", "today-section-title", title));
  if (hint) section.append(el("p", "hint", hint));
  return section;
}

function setupChecklist(bots, data) {
  const items = [
    { label: "A model is connected", done: bots.some((bot) => bot.ready), hint: "Open an agent and pick a model, or press Find models." },
    { label: "First agent created", done: bots.length > 0, hint: "Give it a name and a job." },
    { label: "Browser ready", done: bots.some((bot) => bot.browserReady), hint: "Run npx playwright install chromium on the server." },
    { label: "First schedule", done: bots.some((bot) => (bot.jobCount || 0) > 0), hint: "Ask an agent to remind you of something, or open Jobs and pick a time." },
    { label: "First run", done: bots.some((bot) => (bot.turnsTotal || 0) > 0) || data.totals.turns > 0, hint: "Send an agent a message." },
  ];
  const complete = items.every((item) => item.done);
  const card = el("div", `checklist${complete ? " complete" : ""}`);
  const head = el("div", "checklist-head");
  head.append(el("p", "form-title", "Setup checklist"));
  head.append(el("span", `pill ${complete ? "ok" : "warn"}`, complete ? "all set" : `${items.filter((item) => !item.done).length} to go`));
  card.append(head);
  if (complete) card.append(el("p", "hint", "A model, an agent, a browser, a schedule and a first run are all in place."));
  for (const item of items) {
    const row = el("div", `checklist-item${item.done ? " done" : ""}`);
    row.append(el("span", "checklist-mark", item.done ? "✓" : "○"));
    const copy = el("span", "checklist-copy");
    copy.append(el("span", "checklist-label", item.label));
    if (!item.done) copy.append(el("span", "checklist-hint", item.hint));
    row.append(copy);
    card.append(row);
  }
  return card;
}

function modelTable(models) {
  const list = el("div", "today-list usage-table");
  const head = el("div", "today-row usage-head");
  head.append(
    el("span", "usage-col name", "Model"),
    el("span", "usage-col num", "Turns"),
    el("span", "usage-col num", "Tokens"),
    el("span", "usage-col num", "Cost"),
  );
  list.append(head);
  for (const row of models) {
    const line = el("div", "today-row");
    const name = el("span", "usage-col name model");
    name.append(el("span", "usage-model-name", row.model));
    if (row.provider) name.append(el("span", "usage-provider", row.provider));
    line.append(
      name,
      el("span", "usage-col num", String(row.turns)),
      el("span", "usage-col num tokens", exactNumber(row.tokens)),
      el("span", "usage-col num money", money(row.cost)),
    );
    list.append(line);
  }
  return list;
}

async function openSchedules() {
  const bot = state.bots.find((item) => item.nextJobAt) || state.bots.find((item) => item.main) || state.bots[0];
  if (!bot) return openNewBot();
  await selectBot(bot.id);
  showPanel("jobs");
  els.shell.classList.add("computer-open");
}

async function openBrowserCard() {
  const bot = state.bots.find((item) => item.main) || state.bots[0];
  if (!bot) return openNewBot();
  await selectBot(bot.id);
  showPanel("screen");
  els.shell.classList.add("computer-open");
  refreshScreen().catch(() => {});
}

async function openSpend() {
  const bot = state.bots.find((item) => item.id === state.botId) || state.bots[0];
  if (!bot) return;
  await selectBot(bot.id);
  showPanel("usage");
  els.shell.classList.add("computer-open");
}

// `month` is the calendar month's spend; with it the bar shows whichever cap (daily or monthly) is closest to full.
function capBar(totals, limits, month = null) {
  const monthly = month && (limits?.monthlyCost || limits?.monthlyTokens);
  if (!limits?.dailyCost && !limits?.dailyTokens && !monthly) return null;
  const parts = [];
  if (limits.dailyCost) parts.push([totals.cost / limits.dailyCost, `${money(totals.cost)} of ${money(limits.dailyCost)}`, "Daily cap"]);
  if (limits.dailyTokens) parts.push([totals.tokens / limits.dailyTokens, `${tokenLabel(totals.tokens)} of ${tokenLabel(limits.dailyTokens)}`, "Daily cap"]);
  if (monthly && limits.monthlyCost) parts.push([month.cost / limits.monthlyCost, `${money(month.cost)} of ${money(limits.monthlyCost)}`, "Monthly cap"]);
  if (monthly && limits.monthlyTokens) parts.push([month.tokens / limits.monthlyTokens, `${tokenLabel(month.tokens)} of ${tokenLabel(limits.monthlyTokens)}`, "Monthly cap"]);
  if (!parts.length) return null;
  const [ratio, label, name] = parts.sort((a, b) => b[0] - a[0])[0];
  const wrap = el("div", "cap");
  const track = el("div", `cap-track${ratio >= 1 ? " full" : ratio >= 0.8 ? " near" : ""}`);
  const fill = el("span", "cap-fill");
  fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  track.append(fill);
  wrap.append(track, el("span", "cap-label", ratio >= 1 ? `${name} reached · ${label}` : `${name} · ${label}`));
  return wrap;
}

// Usage tab for the selected bot: dollars and tokens, today, per model, per day.
function renderUsage() {
  const host = els["usage-body"];
  host.replaceChildren();
  if (!state.bot) return;
  const usage = state.usage;
  if (!usage) {
    host.append(note("No usage recorded yet. Send this agent a message and its dollars and tokens show up here."));
    return;
  }
  const today = usage.today || { turns: 0, cost: 0, tokens: 0, usage: {} };
  const total = usage.total || today;
  const windowDays = (usage.daily || []).length || 14;

  const hero = el("div", "usage-hero");
  const main = el("div", "usage-hero-main");
  main.append(el("span", "usage-hero-label", "Spend today"), el("span", "usage-hero-value", money(today.cost)));
  main.append(el("span", "usage-hero-sub", `${exactNumber(today.tokens)} tokens · ${today.turns} turn${today.turns === 1 ? "" : "s"}`));
  const side = el("div", "usage-hero-side");
  side.append(el("span", "usage-hero-label", `Last ${windowDays} days`), el("strong", "usage-hero-side-value", money(total.cost)));
  side.append(el("span", "usage-hero-sub", `${exactNumber(total.tokens)} tokens · ${turnCount(total.turns)}`));
  hero.append(main, side);
  host.append(hero);

  // Questions the agent left for the user: fewer per turn means it finishes more on its own.
  const perTurn = total.turns ? (total.asks || 0) / total.turns : 0;
  const asksCard = el("div", "card-form");
  asksCard.append(el("p", "form-title", "Questions to you"));
  const asksGrid = el("div", "token-grid");
  for (const [label, value] of [["Asks today", String(today.asks || 0)], [`Asks, last ${windowDays} days`, String(total.asks || 0)], ["Asks per turn", perTurn.toFixed(1)]]) {
    const cell = el("div", "token-cell");
    cell.append(el("span", "token-value", value), el("span", "token-label", label));
    asksGrid.append(cell);
  }
  asksCard.append(asksGrid);
  host.append(asksCard);

  const tokens = today.usage || {};
  const breakdown = el("div", "card-form");
  breakdown.append(el("p", "form-title", "Today's tokens"));
  const grid = el("div", "token-grid");
  for (const [label, value] of [["Input", tokens.input], ["Output", tokens.output], ["Reasoning", tokens.reasoning], ["Cache read", tokens.cacheRead], ["Cache write", tokens.cacheWrite]]) {
    const cell = el("div", "token-cell");
    cell.append(el("span", "token-value", exactNumber(value || 0)), el("span", "token-label", label));
    grid.append(cell);
  }
  breakdown.append(grid);
  if (!today.cost) breakdown.append(el("p", "hint", "This model server reports no cost. Tokens still count against the daily cap."));
  host.append(breakdown);

  const cap = capBar(today, state.bot.limits, usage.month);
  const capRow = el("div", "card-form");
  if (cap) capRow.append(cap);
  else capRow.append(el("p", "hint", "No daily cap. Set one in Settings to stop runaway routines."));
  const edit = el("button", "ghost", "Edit cap");
  edit.type = "button";
  edit.addEventListener("click", openSettings);
  capRow.append(edit);
  host.append(capRow);

  const models = usage.models?.length
    ? usage.models
    : [{ provider: state.bot.model?.provider || "", model: state.bot.model?.model || "server default", turns: total.turns, tokens: total.tokens, cost: total.cost }];
  const modelCard = el("div", "card-form");
  modelCard.append(el("p", "form-title", `By model · last ${windowDays} days`));
  modelCard.append(modelTable(models));
  host.append(modelCard);

  const days = [...(usage.daily || [])].reverse();
  const dayCard = el("div", "card-form");
  dayCard.append(el("p", "form-title", "Recent days"));
  const list = el("div", "today-list usage-table");
  const head = el("div", "today-row usage-head");
  head.append(
    el("span", "usage-col name", "Day"),
    el("span", "usage-col num", "Turns"),
    el("span", "usage-col num asks", "Asks"),
    el("span", "usage-col num", "Tokens"),
    el("span", "usage-col num", "Cost"),
  );
  list.append(head);
  for (const day of days) {
    const line = el("div", "today-row");
    line.append(
      el("span", "usage-col name", shortDate(new Date(day.day).getTime())),
      el("span", "usage-col num", String(day.turns)),
      el("span", "usage-col num asks", String(day.asks || 0)),
      el("span", "usage-col num tokens", exactNumber(day.tokens)),
      el("span", "usage-col num money", money(day.cost)),
    );
    list.append(line);
  }
  dayCard.append(list);
  host.append(dayCard);
}

// Spec file linked to the selected bot.
async function loadSpec() {
  if (!state.bot) return;
  const botId = state.bot.id;
  try {
    const view = await api(`/api/bots/${botId}/spec`);
    if (state.bot?.id !== botId) return;
    state.spec.view = view;
  } catch {
    state.spec.view = null;
  }
  renderSpec();
}

function renderSpec() {
  const view = state.spec.view;
  const spec = view?.spec;
  els["spec-form"].hidden = Boolean(spec);
  els["spec-linked"].hidden = !spec;
  els["spec-state"].hidden = !spec;
  els["spec-hint"].hidden = Boolean(spec);
  if (!spec) return;
  const labels = { current: ["Up to date", "ok"], changed: ["Changed", "warn"], missing: ["File missing", "bad"] };
  const [label, tone] = labels[spec.status] || labels.current;
  els["spec-state"].textContent = label;
  els["spec-state"].className = `pill ${tone}`;
  els["spec-meta"].textContent = `${spec.path} · approved ${spec.appliedAt ? `${shortDate(spec.appliedAt, { year: true })} ${clockTime(spec.appliedAt)}` : "never"}${spec.error ? ` · ${spec.error}` : ""}`;
  els["spec-apply"].hidden = spec.status !== "changed";
  els["spec-dismiss"].hidden = spec.status !== "changed";
  els["spec-diff-wrap"].hidden = spec.status !== "changed" || !view.diff;
  els["spec-diff"].replaceChildren();
  if (spec.status === "changed" && view.diff) els["spec-diff"].append(buildPatch(view.diff));
  els["spec-applied"].hidden = !state.spec.showApplied;
  els["spec-applied"].textContent = view.applied || "";
  els["spec-view"].textContent = state.spec.showApplied ? "Hide approved copy" : "View approved copy";
}

async function linkSpec(event) {
  event.preventDefault();
  if (!state.bot) return;
  await specRequest("PUT", { path: els["spec-path"].value.trim() }, "Spec linked. The agent follows this copy now.");
}

async function applySpec() {
  await specRequest("POST", undefined, "Changes applied. The agent follows the new copy from its next turn.", "/apply");
}

async function dismissSpec() {
  await specRequest("POST", undefined, "Change dismissed. Ravnir stops asking until the file changes again.", "/dismiss");
}

async function unlinkSpec() {
  if (!confirm("Unlink this spec? The agent stops following it from its next turn.")) return;
  await specRequest("DELETE", undefined, "Spec unlinked.");
}

async function specRequest(method, body, message, suffix = "") {
  try {
    const data = await api(`/api/bots/${state.bot.id}/spec${suffix}`, { method, body });
    state.spec.view = data.view;
    applyDetail(data.detail);
    renderMind();
    renderSpec();
    refreshBots();
    toast(message);
  } catch (error) {
    toast(error.message, "error");
  }
}

// Import from Grok Bot: the official-app route. The user pastes an export prompt into a
// Grok bot, then pastes the answer here. Nothing is read from the Grok Bot app itself.
const importer = { prompt: "", text: "", preview: null, enableRoutines: false, busy: "", result: null, error: "", results: null };

async function openImportPage() {
  const body = els["import-body"];
  body.replaceChildren();
  importer.preview = null;
  importer.result = null;
  importer.error = "";
  importer.busy = "";

  const intro = el("p", "hint import-intro", "Bring an agent over from the official Grok Bot app. You export each one yourself, so Ravnir never reads Grok Bot's files. Passwords and API keys are not part of the export.");

  const first = el("div", "card-form import-step");
  first.append(el("p", "form-title", "1. Ask the Grok bot to export itself"));
  first.append(el("p", "hint", "Paste this prompt into a Grok bot's chat. It answers with one block of JSON. Do this once for each agent you want to bring over."));
  const prompt = el("pre", "prompt-box import-prompt", importer.prompt || "Loading the prompt…");
  const copy = el("button", "ghost", "Copy prompt");
  copy.type = "button";
  copy.disabled = !importer.prompt;
  copy.addEventListener("click", () => copyText(importer.prompt, "Prompt copied."));
  const copyRow = el("div", "row");
  copyRow.append(copy);
  first.append(prompt, copyRow);

  const second = el("div", "card-form import-step");
  second.append(el("p", "form-title", "2. Paste its answer"));
  const area = el("textarea", "mono import-text");
  area.rows = 9;
  area.spellcheck = false;
  area.placeholder = "Paste the JSON the Grok bot sent back. Several agents in one paste work too.";
  area.value = importer.text;
  area.setAttribute("aria-label", "The Grok bot's answer");
  area.addEventListener("input", () => {
    importer.text = area.value;
    if (importer.preview || importer.result || importer.error) {
      importer.preview = null;
      importer.result = null;
      importer.error = "";
      renderImportResults();
    }
  });
  const previewRow = el("div", "row");
  const preview = el("button", "primary", "Preview");
  preview.type = "button";
  preview.addEventListener("click", previewImport);
  previewRow.append(preview, el("span", "hint", "Nothing changes until you press Apply."));
  importer.results = el("div", "import-results stack");
  second.append(area, previewRow, importer.results);

  body.append(intro, first, second);
  renderImportResults();

  if (!importer.prompt) {
    try {
      importer.prompt = (await api("/api/import/prompt")).prompt || "";
      prompt.textContent = importer.prompt;
      copy.disabled = !importer.prompt;
    } catch (error) {
      prompt.textContent = error.message;
    }
  }
}

async function previewImport() {
  if (!importer.text.trim()) {
    importer.error = "Paste the Grok bot's answer first.";
    return renderImportResults();
  }
  importer.busy = "preview";
  importer.error = "";
  importer.result = null;
  renderImportResults();
  try {
    const data = await api("/api/import/preview", { method: "POST", body: { text: importer.text } });
    importer.preview = data.items || [];
    if (!importer.preview.length) importer.error = "That text has no agents in it.";
  } catch (error) {
    importer.preview = null;
    importer.error = error.message;
  }
  importer.busy = "";
  renderImportResults();
}

async function applyImport() {
  importer.busy = "apply";
  importer.error = "";
  renderImportResults();
  try {
    importer.result = await api("/api/import/apply", { method: "POST", body: { text: importer.text, enableRoutines: importer.enableRoutines } });
    importer.preview = null;
    importer.text = "";
    const area = els["import-body"].querySelector(".import-text");
    if (area) area.value = "";
    await refreshState();
    if (state.botId) reloadBot();
  } catch (error) {
    importer.error = error.message;
  }
  importer.busy = "";
  renderImportResults();
}

function renderImportResults() {
  const host = importer.results;
  if (!host) return;
  host.replaceChildren();
  if (importer.busy === "preview") host.append(el("p", "hint", "Reading the export…"));
  if (importer.error) host.append(el("p", "error-text", importer.error));
  if (importer.result) host.append(importSummary(importer.result));
  if (!importer.preview?.length) return;

  const table = el("div", "import-table");
  const head = el("div", "import-row import-head");
  for (const label of ["Agent", "Action", "Memories", "Routines", "Warnings"]) head.append(el("span", "import-cell", label));
  table.append(head);
  for (const item of importer.preview) {
    const row = el("div", "import-row");
    const name = el("span", "import-cell import-name");
    name.append(el("strong", "", item.name));
    const instructions = { set: "Instructions will be set", append: "Instructions will be added at the end", none: "Instructions stay as they are" }[item.instructionsAction];
    if (instructions) name.append(el("small", "", instructions));
    const action = el("span", "import-cell");
    action.dataset.label = "Action";
    action.append(el("span", `pill ${item.action === "create" ? "ok" : "routine"}`, item.action === "create" ? "Create" : "Update"));
    const memories = el("span", "import-cell num", String(item.memories || 0));
    memories.dataset.label = "Memories";
    const routines = el("span", "import-cell num", String(item.routines || 0));
    routines.dataset.label = "Routines";
    const warnings = el("span", "import-cell import-warnings");
    warnings.dataset.label = "Warnings";
    if (item.warnings?.length) for (const warning of item.warnings) warnings.append(el("small", "", warning));
    else warnings.append(el("small", "muted", "None"));
    row.append(name, action, memories, routines, warnings);
    table.append(row);
  }
  host.append(table);

  const toggle = el("label", "import-toggle");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = importer.enableRoutines;
  box.addEventListener("change", () => { importer.enableRoutines = box.checked; });
  toggle.append(box, el("span", "", "Turn routines on now"));
  host.append(toggle, el("p", "hint", "Pause the matching Grok Bot routines first so they do not run twice."));

  const apply = el("button", "primary", importer.busy === "apply" ? "Importing…" : "Apply import");
  apply.type = "button";
  apply.disabled = importer.busy === "apply";
  apply.addEventListener("click", applyImport);
  const row = el("div", "row");
  row.append(apply);
  host.append(row);
}

function importSummary(result) {
  const count = (value) => (Array.isArray(value) ? value.length : Number(value) || 0);
  const created = count(result.created);
  const updated = count(result.updated);
  const card = el("div", "import-done");
  const parts = [];
  if (created) parts.push(`created ${created} agent${created === 1 ? "" : "s"}`);
  if (updated) parts.push(`updated ${updated}`);
  const done = parts.length ? `${parts.join(", ")}` : "nothing new to add";
  const memories = count(result.memories);
  const routines = count(result.routines);
  card.append(el("strong", "", `Done: ${done}.`));
  card.append(el("p", "hint", `${memories} memor${memories === 1 ? "y" : "ies"} saved and ${routines} routine${routines === 1 ? "" : "s"} added${routines && !importer.enableRoutines ? ", paused until you turn them on in each agent's Jobs tab" : ""}.`));
  for (const warning of result.warnings || []) card.append(el("p", "hint warn-line", warning));
  return card;
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.("copy");
    area.remove();
    if (!ok) return toast("Could not copy. Select the text and copy it by hand.", "error");
  }
  toast(message);
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function note(text) {
  return el("p", "hint", text);
}

function turnCount(count) {
  return `${count} turn${count === 1 ? "" : "s"}`;
}

function money(value) {
  const amount = Number(value) || 0;
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function tokenLabel(value) {
  return `${compactNumber(value)} tokens`;
}

function exactNumber(value) {
  return (Number(value) || 0).toLocaleString("en-US");
}

function compactNumber(value) {
  const count = Number(value) || 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(count);
}

function tokensOfUsage(usage) {
  if (!usage) return 0;
  return (usage.input || 0) + (usage.output || 0) + (usage.reasoning || 0) + (usage.cacheWrite || 0);
}

function duration(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
