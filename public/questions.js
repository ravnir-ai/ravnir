// Questions an agent left for the user (server/asks.js, the ask_user tool).
// Thread: a small card under the reply that carries `asks`. Home: an answer box inside "Needs you".
// Both read the same ask shape: { id, botId, botName, question, need, about, tried, status, at }.
(() => {
  "use strict";

  // Ids the user answered in this tab, so a card flips to Answered before the next poll lands.
  const answered = new Set();
  // What the user typed into a Home answer box, by question id: Home rebuilds when its data changes,
  // and the box comes back with the text (and the focus, through data-key).
  const drafts = new Map();

  function mark(ids) {
    for (const id of ids || []) answered.add(id);
  }

  // Waiting while no message from the user follows the reply that carries the question.
  function isOpen(ask, message, conversation) {
    if (answered.has(ask.id)) return false;
    if (ask.status && ask.status !== "open") return false;
    const list = conversation || [];
    const index = list.findIndex((item) => item.id === message?.id);
    if (index < 0) return true;
    return !list.slice(index + 1).some((item) => item.role === "user");
  }

  const AIM = { access: "Access", owner: "About you", detail: "A detail", decision: "A decision" };

  function lines(ask, className) {
    const box = document.createElement("div");
    box.className = className;
    const add = (label, text) => {
      if (!text) return;
      const line = document.createElement("p");
      const strong = document.createElement("span");
      strong.className = "ask-key";
      strong.textContent = `${label}: `;
      line.append(strong, document.createTextNode(text));
      box.append(line);
    };
    add("Needs", ask.need);
    add("Tried", ask.tried);
    return box;
  }

  // The card under an assistant reply. `compact` hides the question text when a choice card already shows it.
  function card(ask, { open = true, compact = false } = {}) {
    const node = document.createElement("div");
    node.className = `ask-card${open ? " open" : " answered"}${compact ? " compact" : ""}`;
    node.dataset.askId = ask.id;
    const head = document.createElement("div");
    head.className = "ask-head";
    const label = document.createElement("span");
    label.className = "ask-label";
    label.textContent = "Question";
    const state = document.createElement("span");
    state.className = "ask-state";
    state.textContent = open ? "Waiting for your answer" : "Answered";
    head.append(label, state);
    node.append(head);
    if (!compact) {
      const text = document.createElement("p");
      text.className = "ask-question";
      text.textContent = ask.question;
      node.append(text);
    }
    const detail = lines(ask, "ask-detail");
    if (detail.children.length) node.append(detail);
    return node;
  }

  // Single-line box that grows, plus Send. Posts the answer to the agent's thread, then calls onSent.
  function answerBox(ask, { onSent } = {}) {
    const form = document.createElement("form");
    form.className = "ask-answer";
    form.autocomplete = "off";
    const input = document.createElement("textarea");
    input.className = "ask-input";
    input.rows = 1;
    input.placeholder = "Your answer";
    input.setAttribute("aria-label", `Answer ${ask.botName || "the agent"}`);
    input.dataset.key = `ask-${ask.id}`;
    input.value = drafts.get(ask.id) || "";
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "primary ask-send";
    send.textContent = "Send";
    send.disabled = true;
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
      send.disabled = !input.value.trim();
    };
    input.addEventListener("input", () => {
      if (input.value) drafts.set(ask.id, input.value);
      else drafts.delete(ask.id);
      grow();
    });
    input.addEventListener("keydown", (event) => {
      const touch = window.matchMedia?.("(pointer: coarse)").matches;
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !touch) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    let busy = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      send.disabled = true;
      input.disabled = true;
      try {
        await api(`/api/bots/${ask.botId}/messages`, { method: "POST", body: { text, answers: [ask.id] } });
        mark([ask.id]);
        drafts.delete(ask.id);
        input.value = "";
        onSent?.();
      } catch (error) {
        toast(error?.message || "Could not send that", "error");
        input.disabled = false;
        grow();
      } finally {
        busy = false;
      }
    });
    form.append(input, send);
    if (input.value) requestAnimationFrame(grow);
    return form;
  }

  // A question inside Home's "Needs you": the agent's face, the question, what it needs, an answer box.
  function homeCard(ask, { bot = null, face = null, onOpen, onSent } = {}) {
    const node = document.createElement("div");
    node.className = "ask-card home-ask-card open";
    node.dataset.askId = ask.id;
    const head = document.createElement("div");
    head.className = "ask-head";
    if (face) head.append(face);
    const who = document.createElement("span");
    who.className = "ask-who";
    who.textContent = `${bot?.name || ask.botName || "An agent"} asks`;
    const when = document.createElement("span");
    when.className = "ask-when";
    when.textContent = typeof timeAgo === "function" ? timeAgo(ask.at) : "";
    head.append(who, when);
    const text = document.createElement("p");
    text.className = "ask-question";
    text.textContent = ask.question;
    node.append(head, text);
    const detail = lines(ask, "ask-detail");
    if (detail.children.length) node.append(detail);
    const foot = document.createElement("div");
    foot.className = "ask-foot";
    foot.append(answerBox(ask, { onSent }));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "ask-open";
    open.textContent = "Open thread";
    open.addEventListener("click", () => onOpen?.());
    foot.append(open);
    node.append(foot);
    return node;
  }

  window.RavnirQuestions = { card, homeCard, answerBox, isOpen, mark, about: AIM };
})();
