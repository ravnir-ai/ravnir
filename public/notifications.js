// Inbox, suggestions from agents, and push notifications for this device.
// Loaded after app.js, so state, els, el, api, toast, timeAgo, botBadge, todaySection and routeTo are global.

(() => {
  const KINDS = {
    turn: ["Finished", '<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 14 12H9.5L6.5 15v-3H6a1.5 1.5 0 0 1-1.5-1.5Z"/>'],
    routine: ["Routine", '<circle cx="10" cy="10" r="6"/><path d="M10 6.6V10l2.4 1.4"/>'],
    reminder: ["Reminder", '<path d="M5.4 13.6h9.2l-1.2-1.8V9a3.4 3.4 0 0 0-6.8 0v2.8Z"/><path d="M8.6 15.8a1.5 1.5 0 0 0 2.8 0"/>'],
    approval: ["Needs approval", '<path d="M10 3.6 15.4 5.6v3.9c0 3.1-2.1 5.3-5.4 6.9-3.3-1.6-5.4-3.8-5.4-6.9V5.6Z"/><path d="M10 7.6v2.8"/><path d="M10 12.5v.1"/>'],
    proposal: ["Suggestion", '<path d="M10 3.6a4.4 4.4 0 0 0-2.5 8c.4.3.6.7.6 1.2v.6h3.8v-.6c0-.5.2-.9.6-1.2a4.4 4.4 0 0 0-2.5-8Z"/><path d="M8.4 16h3.2"/>'],
    message: ["Message", '<rect x="3.6" y="5" width="12.8" height="10" rx="2"/><path d="m4.2 6.6 5.8 4.2 5.8-4.2"/>'],
    failure: ["Failed", '<path d="M10 3.9 16.8 15.6H3.2Z"/><path d="M10 8.6v3"/><path d="M10 13.4v.1"/>'],
  };
  const VERB_TITLE = /^(wants|needs|is|has|asked|finished|failed)\b/i;

  const notices = {
    items: [],
    unread: 0,
    proposals: [],
    devices: [],
    settings: { enabled: true, quietStart: "23:00", quietEnd: "08:00" },
    loading: false,
    signature: "",
    saved: "",
  };
  const device = { subscribed: false, id: "", busy: false };
  state.notices = notices;

  // ---- Service worker and push ------------------------------------------------

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  }

  function deviceLabel() {
    const agent = navigator.userAgent;
    if (/iPhone/.test(agent)) return "iPhone";
    if (/iPad/.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
    if (/Android/.test(agent)) return "Android";
    const system = /Macintosh|Mac OS X/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
    const browser = /Firefox\//.test(agent) ? "Firefox" : /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "";
    if (system && browser) return `${system} (${browser})`;
    return system || browser || "This browser";
  }

  function keyBytes(key) {
    const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
    return Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  }

  // The server names a device by the first 16 hex characters of the SHA-256 of its endpoint.
  async function endpointId(endpoint) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
    } catch {
      return "";
    }
  }

  async function localSubscription() {
    if (!pushSupported()) return null;
    const registration = await navigator.serviceWorker.getRegistration();
    return registration ? registration.pushManager.getSubscription() : null;
  }

  async function syncDevice() {
    const subscription = Notification.permission === "granted" ? await localSubscription().catch(() => null) : null;
    device.subscribed = Boolean(subscription);
    device.id = subscription ? await endpointId(subscription.endpoint) : "";
    return subscription;
  }

  async function enablePush() {
    if (device.busy) return;
    device.busy = true;
    renderDevice();
    try {
      // The permission prompt has to start from this tap.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast(permission === "denied" ? "Notifications are blocked for this site." : "Notifications stay off until you allow them.", "error");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const { key } = await api("/api/push/key");
      const subscription = (await registration.pushManager.getSubscription())
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      await api("/api/push/subscribe", { method: "POST", body: { subscription: subscription.toJSON(), label: deviceLabel() } });
      toast("Notifications are on for this device.");
    } catch (error) {
      toast(error.message || "Could not turn on notifications.", "error");
    } finally {
      device.busy = false;
      await syncDevice();
      await refreshDevices();
    }
  }

  async function removeDevice(entry) {
    try {
      let endpoint = "";
      if (entry.id === device.id) {
        const subscription = await localSubscription();
        endpoint = subscription?.endpoint || "";
        await subscription?.unsubscribe().catch(() => {});
      }
      const result = await api("/api/push/unsubscribe", { method: "POST", body: { endpoint, id: entry.id } });
      if (result.ok === false) toast("That device could not be removed from here. Turn notifications off on that device.", "error");
      else toast(`${entry.label || "That device"} will not get notifications.`);
    } catch (error) {
      toast(error.message, "error");
    }
    await syncDevice();
    await refreshDevices();
  }

  async function sendTest(button) {
    button.disabled = true;
    try {
      const result = await api("/api/push/test", { method: "POST" });
      if (!result.devices) toast("No device is signed up yet. Turn on notifications first.", "error");
      else if (result.sent > 0) toast("Test sent. It should arrive in a moment.");
      else toast("The test did not reach a device. Try removing it and turning notifications on again.", "error");
    } catch (error) {
      toast(error.message, "error");
    }
    button.disabled = false;
    await refreshDevices();
  }

  async function refreshDevices() {
    try {
      const [devices, settings] = await Promise.all([api("/api/push/devices"), api("/api/notify-settings")]);
      notices.devices = devices.devices || [];
      notices.settings = { ...notices.settings, ...settings };
    } catch {
      // Keep what we had; the next open tries again.
    }
    renderDevice();
  }

  async function saveSettings(patch) {
    Object.assign(notices.settings, patch);
    try {
      notices.settings = { ...notices.settings, ...(await api("/api/notify-settings", { method: "PUT", body: notices.settings })) };
      notices.saved = "Saved.";
    } catch (error) {
      toast(error.message, "error");
      await refreshDevices();
      return;
    }
    renderDevice();
    setTimeout(() => {
      notices.saved = "";
      const note = document.getElementById("notify-saved");
      if (note) note.textContent = "";
    }, 2200);
  }

  // ---- Data ------------------------------------------------------------------

  async function refreshNotifications() {
    if (notices.loading) return;
    notices.loading = true;
    try {
      const [list, open] = await Promise.all([api("/api/notifications"), api("/api/proposals?status=open")]);
      notices.items = list.items || [];
      notices.unread = list.unread || 0;
      notices.proposals = open.items || [];
      setBadge(notices.unread);
      if (state.view === "inbox") {
        renderSuggestions();
        renderList();
      }
    } catch {
      // A brief network failure should not clear the page.
    } finally {
      notices.loading = false;
    }
  }

  function setBadge(count) {
    for (const id of ["inbox-badge", "tab-inbox-badge"]) {
      els[id].hidden = !count;
      els[id].textContent = count > 99 ? "99+" : String(count);
    }
  }

  // Called from applyInbox on every state refresh: /api/state already carries the counts.
  window.noticeBadge = (inbox) => {
    setBadge(inbox.unread || 0);
    const signature = `${inbox.unread || 0}:${inbox.proposals || 0}`;
    if (signature === notices.signature) return;
    notices.signature = signature;
    if (state.view === "inbox") refreshNotifications();
  };

  // More > Notification settings, and the link in the Inbox: Settings, scrolled to Notifications.
  window.openNotificationSettings = () => openSettingsPage("notifications");

  // Settings calls this when it opens, so the device list and quiet hours are fresh.
  window.refreshNotificationCard = async () => {
    renderDevice();
    await Promise.all([syncDevice(), refreshDevices()]);
    renderDevice();
  };

  window.openInboxPage = async () => {
    renderDevice();
    renderSuggestions();
    renderList();
    await Promise.all([syncDevice(), refreshNotifications(), refreshDevices()]);
    renderDevice();
  };

  async function markRead(ids) {
    const wanted = ids === "all" ? notices.items.filter((item) => !item.read) : notices.items.filter((item) => ids.includes(item.id) && !item.read);
    if (!wanted.length) return;
    for (const item of wanted) item.read = true;
    notices.unread = Math.max(0, notices.unread - wanted.length);
    setBadge(notices.unread);
    renderList();
    try {
      const result = await api("/api/notifications/read", { method: "POST", body: { ids } });
      if (typeof result.unread === "number") setBadge(result.unread);
    } catch (error) {
      toast(error.message, "error");
      refreshNotifications();
    }
  }

  async function decideProposal(proposal, decision, card) {
    const buttons = card.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await api(`/api/proposals/${encodeURIComponent(proposal.id)}`, { method: "POST", body: { decision } });
      toast(decision === "accept" ? `${proposal.botName || "The agent"} is on it.` : "Dismissed.");
    } catch (error) {
      // A second tap, or an answer from another device, finds it already answered.
      if (!/already/i.test(error.message)) {
        toast(error.message, "error");
        buttons.forEach((button) => { button.disabled = false; });
        return;
      }
      toast("That suggestion was already answered.");
    }
    notices.proposals = notices.proposals.filter((item) => item.id !== proposal.id);
    if (state.today.data) state.today.data.proposals = (state.today.data.proposals || []).filter((item) => item.id !== proposal.id);
    renderSuggestions();
    if (state.view === "today") renderToday();
    refreshNotifications();
    refreshState().catch(() => {});
  }

  // ---- Suggestions -----------------------------------------------------------

  function proposalCard(proposal) {
    if ((proposal.kind === "skill" || proposal.kind === "plugin") && window.RavnirSuggestions) {
      return RavnirSuggestions.card(proposal, { makeBadge: () => botBadge(proposal.botId, proposal.botName) });
    }
    const card = el("div", "today-card proposal-card");
    const head = el("div", "today-card-head");
    head.append(botBadge(proposal.botId, proposal.botName), el("span", "today-row-meta", `suggested ${timeAgo(proposal.createdAt)}`));
    card.append(head, el("p", "today-card-title", proposal.title));
    if (proposal.why) card.append(el("p", "proposal-why", proposal.why));
    if (proposal.prompt) {
      const details = document.createElement("details");
      details.className = "proposal-task";
      details.append(el("summary", "", "What it will do"), el("p", "", proposal.prompt));
      card.append(details);
    }
    const actions = el("div", "row approval-actions");
    const accept = el("button", "primary", "Do it");
    accept.type = "button";
    accept.addEventListener("click", () => decideProposal(proposal, "accept", card));
    const dismiss = el("button", "ghost", "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => decideProposal(proposal, "dismiss", card));
    actions.append(accept, dismiss);
    card.append(actions);
    return card;
  }

  // A skill or plugin card was answered (public/suggestions.js): drop it from Home and the Inbox.
  window.onSuggestionDecided = (id) => {
    notices.proposals = notices.proposals.filter((item) => item.id !== id);
    if (state.today.data) state.today.data.proposals = (state.today.data.proposals || []).filter((item) => item.id !== id);
    refreshNotifications();
    refreshState().catch(() => {});
    if (state.botId) reloadBot().catch(() => {});
  };

  window.suggestionsSection = (proposals) => {
    const section = todaySection("Suggestions", "Things your agents noticed, or skills and plugins they asked for. Nothing changes until you say so.");
    for (const proposal of proposals) section.append(proposalCard(proposal));
    return section;
  };

  function renderSuggestions() {
    const host = els["inbox-suggestions"];
    host.replaceChildren();
    if (notices.proposals.length) host.append(window.suggestionsSection(notices.proposals));
  }

  // ---- Notification list -----------------------------------------------------

  function noticeTime(at, today) {
    const time = clockTime(at);
    if (today) return time;
    const date = new Date(at);
    const yesterday = new Date(Date.now() - 86_400_000);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
    return `${shortDate(at)} ${time}`;
  }

  function kindIcon(kind) {
    const icon = el("span", `notice-kind kind-${KINDS[kind] ? kind : "message"}`);
    icon.innerHTML = `<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(KINDS[kind] || KINDS.message)[1]}</svg>`;
    return icon;
  }

  function noticeRow(item, today) {
    const row = el("button", `notice${item.read ? "" : " unread"}`);
    row.type = "button";
    const avatar = el("span", "notice-avatar");
    const face = el("span", "avatar");
    const bot = state.bots.find((entry) => entry.id === item.botId);
    if (bot) paintCreature(face, bot);
    else clearAvatar(face, initials(item.botName || "Ravnir"));
    avatar.append(face, kindIcon(item.kind));

    const copy = el("span", "notice-copy");
    const top = el("span", "notice-top");
    const verb = VERB_TITLE.test(item.title);
    const label = (KINDS[item.kind] || KINDS.message)[0];
    top.append(el("span", "notice-label", verb || !item.botName ? label : `${item.botName} · ${label}`), el("span", "notice-time", noticeTime(item.at, today)));
    copy.append(top, el("span", "notice-title", verb && item.botName ? `${item.botName} ${item.title}` : item.title));
    if (item.body) copy.append(el("span", "notice-body", item.body));

    row.append(el("i", "notice-dot"), avatar, copy);
    row.addEventListener("click", () => {
      markRead([item.id]);
      if (item.url) routeTo(item.url);
    });
    return row;
  }

  function renderList() {
    const host = els["inbox-list"];
    host.replaceChildren();
    els["inbox-mark-all"].disabled = !notices.unread;
    // A suggestion that is still open already has its card above.
    const open = new Set(notices.proposals.map((proposal) => `proposal-${proposal.id}`));
    const items = notices.items.filter((item) => !(item.kind === "proposal" && open.has(item.tag)));
    if (!items.length) {
      if (notices.proposals.length) return;
      const empty = el("div", "inbox-empty");
      empty.append(
        el("strong", "", "Nothing here yet"),
        el("p", "hint", "When an agent finishes a long task, needs your approval, or has an idea, it shows up here and on your phone."),
      );
      host.append(empty);
      return;
    }
    const todayKey = new Date().toDateString();
    const groups = [
      ["Today", items.filter((item) => new Date(item.at).toDateString() === todayKey), true],
      ["Earlier", items.filter((item) => new Date(item.at).toDateString() !== todayKey), false],
    ];
    for (const [title, list, isToday] of groups) {
      if (!list.length) continue;
      const section = todaySection(title, "");
      const rows = el("div", "notice-list");
      for (const item of list) rows.append(noticeRow(item, isToday));
      section.append(rows);
      host.append(section);
    }
  }

  // ---- This device -----------------------------------------------------------

  function deviceMode() {
    if (device.subscribed) return "on";
    if (isIOS() && !isStandalone()) return "ios";
    if (!window.isSecureContext || !pushSupported()) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    return "off";
  }

  // The device card shows in two places: a short one in the Inbox, and the full one
  // (with quiet hours, devices and the test button) in Settings > Notifications.
  function renderDevice() {
    renderDeviceInto(els["inbox-device"], false);
    const host = document.getElementById("settings-notify-device");
    if (host) renderDeviceInto(host, true);
  }

  function renderDeviceInto(host, full) {
    if (!host) return;
    host.replaceChildren();
    const mode = deviceMode();
    const card = el("div", "card-form device-card");
    const row = el("div", "device-row");
    const copy = el("div", "device-copy");
    const title = el("strong", "", "Notifications on this device");
    if (mode === "on") title.append(el("span", "pill ok", "On"));
    const sub = {
      on: "You will get a ping when an agent needs you or has news.",
      off: "Get a ping on this device when an agent needs you or finishes something.",
      denied: "Blocked for this site. Allow notifications in your browser or phone settings, then reload this page.",
      unsupported: window.isSecureContext ? "This browser cannot receive push notifications." : "Push notifications need a secure address (https).",
      ios: "On iPhone and iPad, notifications work from the Home Screen app. Add Ravnir first.",
    }[mode];
    copy.append(title, el("span", "device-sub", sub));
    const actions = el("div", "row device-actions");
    if (mode === "off") {
      const turnOn = el("button", "primary", device.busy ? "Turning on…" : "Turn on");
      turnOn.type = "button";
      turnOn.disabled = device.busy;
      turnOn.addEventListener("click", enablePush);
      actions.append(turnOn);
    }
    if (!full) {
      const settings = el("button", "ghost", "Notification settings");
      settings.type = "button";
      settings.addEventListener("click", () => openSettingsPage("notifications"));
      actions.append(settings);
    }
    row.append(copy, actions);
    card.append(row);

    if (mode === "ios") {
      const steps = el("ol", "device-steps");
      for (const text of [
        "Tap the Share button in Safari.",
        "Choose Add to Home Screen.",
        "Open Ravnir from your Home Screen.",
        "Come back to Inbox and turn on notifications.",
      ]) steps.append(el("li", "", text));
      card.append(steps);
    }
    if (full) card.append(settingsCard());
    host.append(card);
  }

  function settingsCard() {
    const wrap = el("div", "notify-settings");

    const enabled = el("label", "notify-toggle");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = notices.settings.enabled !== false;
    box.addEventListener("change", () => saveSettings({ enabled: box.checked }));
    const text = el("span", "");
    text.append(el("strong", "", "Send notifications to my devices"), el("small", "", "Turn this off to pause everything except approvals."));
    enabled.append(box, text);

    const quiet = el("div", "notify-quiet");
    quiet.append(el("strong", "", "Quiet hours"));
    const times = el("div", "row");
    for (const [key, label] of [["quietStart", "From"], ["quietEnd", "Until"]]) {
      const field = el("label", "", label);
      const input = document.createElement("input");
      input.type = "time";
      input.value = notices.settings[key] || "";
      input.addEventListener("change", () => input.value && saveSettings({ [key]: input.value }));
      field.append(input);
      times.append(field);
    }
    const zone = (state.server?.timezone || "").replace(/_/g, " ");
    quiet.append(times, el("small", "hint", `During quiet hours only approvals and urgent messages come through.${zone ? ` Times use the server's time zone (${zone}).` : ""}`));

    const devices = el("div", "notify-devices");
    devices.append(el("strong", "", "Devices"));
    if (!notices.devices.length) devices.append(el("p", "hint", "No device is signed up yet. Turn on notifications on your phone or this computer."));
    for (const entry of notices.devices) devices.append(deviceRow(entry));

    const foot = el("div", "row notify-foot");
    const test = el("button", "ghost", "Send a test");
    test.type = "button";
    test.disabled = !notices.devices.length;
    test.addEventListener("click", () => sendTest(test));
    const saved = el("span", "hint", notices.saved);
    saved.id = "notify-saved";
    foot.append(test, saved);

    wrap.append(enabled, quiet, devices, foot);
    return wrap;
  }

  function deviceRow(entry) {
    const row = el("div", "device-item");
    const copy = el("div", "device-item-copy");
    const name = el("strong", "", entry.label || "Unknown device");
    if (entry.id === device.id) name.append(el("span", "pill routine", "This device"));
    const added = entry.createdAt ? shortDate(entry.createdAt) : "";
    const last = entry.lastOkAt ? `last ping ${timeAgo(entry.lastOkAt)}` : "no ping yet";
    copy.append(name, el("small", "", `${added ? `Added ${added} · ` : ""}${last}${entry.failures ? ` · ${entry.failures} failed${entry.lastError ? ` (${entry.lastError})` : ""}` : ""}`));
    const remove = el("button", "ghost danger-text", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => removeDevice(entry));
    row.append(copy, remove);
    return row;
  }

  // ---- Wiring ----------------------------------------------------------------

  els["inbox-mark-all"].addEventListener("click", () => markRead("all"));

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then(() => syncDevice()).then(async (subscription) => {
      // Keep the server's copy of this device fresh without asking again.
      if (subscription) await api("/api/push/subscribe", { method: "POST", body: { subscription: subscription.toJSON(), label: deviceLabel() } });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "open") routeTo(event.data.url);
    });
  }
})();
