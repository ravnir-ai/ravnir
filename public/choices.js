// Ravnir choice cards: an agent writes a ```choice block with a JSON spec and the thread shows a
// question with tappable options. One pick sends at once; with "multiple": true the user ticks any
// number and presses Send. The answer goes back as a normal message (labels joined by ", "), so a
// card is answered when a user message follows it. normalize() and chosen() run without a DOM;
// render() needs one. Styles: public/choices.css.
(() => {
  const MAX_QUESTION = 300;
  const MAX_LABEL = 120;
  const MAX_DETAIL = 200;
  const MIN_OPTIONS = 2;
  const MAX_OPTIONS = 12;
  const LETTERS = "ABCDEFGHIJKL";

  class SpecError extends Error {}
  const bad = (message) => { throw new SpecError(message); };

  function text(value, name, max, required) {
    if (value === undefined || value === null || value === "") {
      if (required) bad(`${name} is required.`);
      return "";
    }
    if (typeof value !== "string") bad(`${name} must be text.`);
    const t = value.replace(/\s+/g, " ").trim();
    if (required && !t) bad(`${name} is required.`);
    if (t.length > max) bad(`${name} must be ${max} characters or fewer.`);
    return t;
  }

  function normalize(input) {
    let spec = input;
    if (typeof spec === "string") {
      try { spec = JSON.parse(spec); } catch { bad("The choice block is not valid JSON."); }
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) bad("The choice block must be a JSON object.");
    const question = text(spec.question, "question", MAX_QUESTION, true);
    if (!Array.isArray(spec.options)) bad("options must be a list.");
    if (spec.options.length < MIN_OPTIONS || spec.options.length > MAX_OPTIONS) {
      bad(`Give between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.`);
    }
    const seen = new Set();
    const options = spec.options.map((item, i) => {
      const raw = typeof item === "string" ? { label: item } : item;
      if (!raw || typeof raw !== "object") bad(`Option ${i + 1} must be text or an object with a label.`);
      const label = text(raw.label, `Option ${i + 1} label`, MAX_LABEL, true);
      const key = label.toLowerCase();
      if (seen.has(key)) bad(`Option "${label}" appears twice.`);
      seen.add(key);
      return { label, detail: text(raw.detail ?? raw.description, `Option ${i + 1} detail`, MAX_DETAIL, false) };
    });
    return { question, options, multiple: spec.multiple === true, other: spec.other === true };
  }

  // Which labels an answer picked. An exact label wins; otherwise the answer is split on commas
  // and new lines, so "Spanish, Italian" picks both.
  function chosen(answer, options) {
    const value = String(answer ?? "").trim().toLowerCase();
    if (!value) return new Set();
    const labels = options.map((option) => option.label);
    const exact = labels.find((label) => label.toLowerCase() === value);
    if (exact) return new Set([exact]);
    const parts = new Set(value.split(/\s*(?:,|\n)\s*/).filter(Boolean));
    return new Set(labels.filter((label) => parts.has(label.toLowerCase())));
  }

  function answerFor(labels, options) {
    return options.map((option) => option.label).filter((label) => labels.has(label)).join(", ");
  }

  // Ticks in progress survive the thread's rebuild on every poll.
  const picks = new Map();

  function el(doc, tag, cls, content) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function check(doc) {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3.5 8.4l3 3 6-6.6");
    svg.append(path);
    return svg;
  }

  function render(container, code, context = {}) {
    let spec;
    try { spec = normalize(code); } catch (error) {
      if (error instanceof SpecError) return false;
      throw error;
    }
    const doc = container.ownerDocument || document;
    const host = globalThis.RavnirHost;
    const answered = context.answer !== undefined && context.answer !== null;
    const interactive = Boolean(context.key) && !answered && !context.live && !context.streaming && typeof host?.send === "function";
    const key = context.key || "";
    const selected = answered ? chosen(context.answer, spec.options) : (picks.get(key) || new Set());

    const card = el(doc, "div", "choice-card");
    if (answered) card.classList.add("answered");
    if (!interactive) card.classList.add("locked");
    card.append(el(doc, "div", "choice-question", spec.question));
    const hint = answered
      ? (selected.size ? "Answered" : "Answered in chat")
      : spec.multiple ? "Pick any that apply" : "Pick one";
    card.append(el(doc, "div", "choice-hint", hint));

    const list = el(doc, "div", "choice-list");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", spec.question);
    let send;
    const refresh = () => {
      if (!send) return;
      send.disabled = selected.size === 0;
      send.textContent = selected.size > 1 ? `Send ${selected.size}` : "Send";
    };

    spec.options.forEach((option, i) => {
      const button = el(doc, "button", "choice-option");
      button.type = "button";
      const on = selected.has(option.label);
      if (on) button.classList.add("on");
      if (answered && !on) button.classList.add("dim");
      if (spec.multiple || answered) button.setAttribute("aria-pressed", on ? "true" : "false");
      const mark = el(doc, "span", spec.multiple ? "choice-mark box" : "choice-mark");
      mark.append(el(doc, "span", "choice-letter", LETTERS[i]), check(doc));
      const words = el(doc, "span", "choice-words");
      words.append(el(doc, "span", "choice-label", option.label));
      if (option.detail) words.append(el(doc, "span", "choice-detail", option.detail));
      button.append(mark, words);
      if (!interactive) button.disabled = true;
      else if (spec.multiple) {
        button.addEventListener("click", () => {
          if (selected.has(option.label)) selected.delete(option.label);
          else selected.add(option.label);
          picks.set(key, selected);
          const now = selected.has(option.label);
          button.classList.toggle("on", now);
          button.setAttribute("aria-pressed", now ? "true" : "false");
          refresh();
        });
      } else {
        button.addEventListener("click", () => {
          card.classList.add("locked");
          button.classList.add("on");
          list.querySelectorAll("button").forEach((item) => { item.disabled = true; });
          host.send(option.label, "choice");
        });
      }
      list.append(button);
    });
    card.append(list);

    if (interactive && (spec.multiple || spec.other)) {
      const foot = el(doc, "div", "choice-foot");
      if (spec.other && typeof host.compose === "function") {
        const other = el(doc, "button", "choice-other", "Something else");
        other.type = "button";
        other.addEventListener("click", () => host.compose());
        foot.append(other);
      }
      if (spec.multiple) {
        send = el(doc, "button", "choice-send");
        send.type = "button";
        send.addEventListener("click", () => {
          if (!selected.size) return;
          const answer = answerFor(selected, spec.options);
          picks.delete(key);
          card.classList.add("locked");
          card.querySelectorAll("button").forEach((item) => { item.disabled = true; });
          host.send(answer, "choice");
        });
        foot.append(send);
        refresh();
      }
      card.append(foot);
    }
    container.append(card);
    return true;
  }

  const api = { normalize, chosen, answerFor, render, SpecError };
  globalThis.RavnirChoices = api;
  (globalThis.RavnirBlocks ||= {}).choice = (code, container, context) => render(container, code, context);
})();
