// A skill or plugin an agent asked for (server/recommend.js, suggest_skill and suggest_plugin).
// Thread: a card under the reply that made the ask. Home and Inbox: the same card inside Suggestions.
// Both read the proposal shape from /api/proposals, decorated with `skill` or `plugin` and live status.
(() => {
  "use strict";

  // What the user decided in this tab, so a card flips before the next poll lands.
  const decided = new Map();

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== "") item.textContent = text;
    return item;
  }

  function button(label, kind, onClick) {
    const item = node("button", kind, label);
    item.type = "button";
    item.addEventListener("click", onClick);
    return item;
  }

  function statusOf(suggestion) {
    return decided.get(suggestion.id) || suggestion.status || "open";
  }

  // A plugin given before it was connected waits for the user's sign-in.
  function waitingForSignIn(suggestion) {
    return suggestion.kind === "plugin" && statusOf(suggestion) === "accepted" && suggestion.plugin && !suggestion.plugin.connected && !suggestion.plugin.missing;
  }

  function stateLine(suggestion) {
    if (waitingForSignIn(suggestion)) return "Waiting for your sign-in";
    const status = statusOf(suggestion);
    if (status === "accepted") return suggestion.kind === "skill" ? "Added" : "Plugged in";
    if (status === "dismissed") return "Dismissed";
    return "Waiting for you";
  }

  // makeBadge: the agent's face and name, shown on Home where cards from every agent sit together.
  function card(suggestion, { makeBadge = null } = {}) {
    const status = statusOf(suggestion);
    const open = status === "open";
    const box = node("div", `sugg-card ${open || waitingForSignIn(suggestion) ? "open" : "done"}`);
    box.dataset.suggestionId = suggestion.id;
    const head = node("div", "sugg-head");
    if (makeBadge) head.append(makeBadge());
    head.append(node("span", "sugg-label", suggestion.kind === "skill" ? "Skill" : "Plugin"), node("span", "sugg-state", stateLine(suggestion)));
    box.append(head);

    const main = node("div", "sugg-main");
    const plugin = suggestion.plugin || null;
    if (plugin?.icon) {
      const icon = node("img", "sugg-icon");
      icon.src = plugin.icon;
      icon.alt = "";
      icon.loading = "lazy";
      main.append(icon);
    }
    const copy = node("div", "sugg-copy");
    copy.append(node("p", "sugg-title", suggestion.title));
    const what = suggestion.skill?.description || plugin?.description || "";
    if (what) copy.append(node("p", "sugg-what", what));
    main.append(copy);
    box.append(main);
    if (suggestion.why) box.append(node("p", "sugg-why", suggestion.why));

    const actions = node("div", "sugg-actions");
    if (open) {
      const missing = suggestion.skill?.missing || plugin?.missing;
      const blocked = plugin?.blocker;
      if (missing) actions.append(node("span", "sugg-note", suggestion.kind === "skill" ? "This skill is no longer in the shop." : "This plugin is no longer in the catalog."));
      else if (blocked) actions.append(node("span", "sugg-note", `Not possible on this server: ${blocked}.`));
      else {
        const label = suggestion.kind === "skill" ? "Add skill" : plugin?.connected ? "Plug in" : "Connect";
        actions.append(button(label, "primary", () => decide(suggestion, "accept", box, makeBadge)));
      }
      actions.append(button("Dismiss", "ghost", () => decide(suggestion, "dismiss", box, makeBadge)));
    } else if (waitingForSignIn(suggestion)) {
      actions.append(button(`Connect ${plugin.name}`, "primary", () => window.openPlugins?.(plugin.id)));
    }
    const more = suggestion.kind === "skill" && suggestion.change?.skill
      ? button("See in the shop", "link", () => window.openSkills?.(suggestion.change.skill))
      : suggestion.kind === "plugin" && suggestion.change?.plugin && open
        ? button("Details", "link", () => window.openPlugins?.(suggestion.change.plugin))
        : null;
    if (more) actions.append(more);
    if (actions.childElementCount) box.append(actions);
    return box;
  }

  async function decide(suggestion, decision, box, makeBadge) {
    const buttons = box.querySelectorAll("button");
    buttons.forEach((item) => { item.disabled = true; });
    const who = suggestion.botName || "The agent";
    let result = null;
    try {
      result = await window.api(`/api/proposals/${encodeURIComponent(suggestion.id)}`, { method: "POST", body: { decision } });
    } catch (error) {
      if (!/already/i.test(error.message)) {
        window.toast?.(error.message, "error");
        buttons.forEach((item) => { item.disabled = false; });
        return;
      }
      window.toast?.("That suggestion was already answered.");
    }
    decided.set(suggestion.id, decision === "accept" ? "accepted" : "dismissed");
    if (result && decision === "accept") {
      if (suggestion.kind === "skill") window.toast?.(`${who} has the ${suggestion.skill?.title || suggestion.change?.skill} skill now.`);
      else if (result.connected) window.toast?.(`${who} has ${suggestion.plugin?.name || "the plugin"} now.`);
      else {
        // Not connected yet: the sign-in is on the Plugins page, and the agent gets it right after.
        window.toast?.(`Sign in to ${suggestion.plugin?.name || "the plugin"}. ${who} gets it as soon as you do.`);
        window.openPlugins?.(suggestion.change?.plugin || "");
      }
    } else if (decision === "dismiss") {
      window.toast?.("Dismissed.");
    }
    box.replaceWith(card({ ...suggestion, status: decided.get(suggestion.id) }, { makeBadge }));
    window.onSuggestionDecided?.(suggestion.id);
  }

  window.RavnirSuggestions = { card, decided };
})();
