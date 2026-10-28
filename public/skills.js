// The Skills page: browse the skills this server ships, read one, and choose which agents get it.
// Also the Skills tab in an agent's Setup, which lists what that agent can open.
// Loaded after app.js, so state, el, $, api, toast, paintCreature and openSkills are global.
// The server side is server/skills.js (API at /api/skills).

(() => {
  // Shelves follow the folders under skills/. Unknown folders still show, under their own name.
  const SHELVES = [
    ["documents", "Documents", "#cfe0f2", '<path d="M6 3h5.5L15 6.5V17H6Z"/><path d="M11 3v4h4M8.5 11h4M8.5 14h4"/>'],
    ["writing", "Writing", "#ecd9c6", '<path d="M4 16l1-3.6L13.2 4.2a1.5 1.5 0 0 1 2.1 0l.5.5a1.5 1.5 0 0 1 0 2.1L7.6 15Z"/><path d="M11.8 5.6l2.6 2.6"/>'],
    ["research", "Research", "#cbc3e6", '<circle cx="8.8" cy="8.8" r="5"/><path d="M12.6 12.6 16.5 16.5"/>'],
    ["productivity", "Productivity", "#cfe3df", '<rect x="3.5" y="4" width="13" height="12.5" rx="2"/><path d="M7 9.5l2 2 4-4M3.5 7h13" /><path d="M7 2.8v2.4M13 2.8v2.4"/>'],
    ["finance", "Finance", "#d9e8c9", '<path d="M3.5 16.5h13"/><path d="M5.5 13.5v-3M9 13.5V7M12.5 13.5V9.5M16 13.5V4.5"/>'],
    ["software-development", "Engineering", "#e6e0d2", '<path d="M7 6 3 10l4 4M13 6l4 4-4 4M11 4.5 9 15.5"/>'],
    ["design", "Design", "#e7c8ca", '<circle cx="10" cy="10" r="6.5"/><circle cx="7.5" cy="8" r="1"/><circle cx="11.5" cy="7" r="1"/><circle cx="13" cy="10.5" r="1"/>'],
    ["web", "Web", "#d6e4ee", '<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2 2 2.8 4.2 2.8 6.5S12 14.5 10 16.5c-2-2-2.8-4.2-2.8-6.5S8 5.5 10 3.5Z"/>'],
    ["security", "Security", "#d9d2e9", '<path d="M10 3 4.5 5v4.5c0 3.4 2.3 6.1 5.5 7.5 3.2-1.4 5.5-4.1 5.5-7.5V5Z"/><path d="M7.6 10l1.7 1.7 3.2-3.4"/>'],
  ];
  const SHELF = Object.fromEntries(SHELVES.map(([key, label, color, icon]) => [key, { label, color, icon }]));
  const shelfLabel = (category) => SHELF[category]?.label || (category ? category.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Other");

  const sk = {
    data: null,
    loading: false,
    query: "",
    shelf: "all",
    openName: "",
    busy: "",
    dialog: null,
    reading: false,
    bodies: {},
  };
  state.skills = sk;

  // ---- Data ------------------------------------------------------------------------------------------------

  async function refresh({ quiet = false } = {}) {
    if (sk.loading) return;
    sk.loading = true;
    try {
      sk.data = await api("/api/skills");
    } catch (error) {
      if (!quiet) toast(error.message, "error");
    } finally {
      sk.loading = false;
    }
    redraw();
  }

  function redraw() {
    if (state.view === "skills") renderPage();
    if (sk.openName && sk.dialog?.open) renderDialog();
    if (state.view === "bot" && state.panel === "skills") renderPanel(state.bot);
  }

  const entry = (name) => sk.data?.skills.find((item) => item.name === name) || null;
  const room = () => sk.data?.room ?? 0;
  // The skills an agent holds besides the built-in ones. Names the server no longer ships do not count.
  const heldBy = (botId) => (sk.data?.skills || []).filter((item) => !item.default && item.agents.includes(botId));

  async function setAgents(item, ids) {
    sk.busy = item.name;
    renderDialog();
    try {
      const result = await api(`/api/skills/${encodeURIComponent(item.name)}/agents`, { method: "PUT", body: { agents: ids } });
      item.agents = result.agents;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      sk.busy = "";
    }
    await refresh({ quiet: true });
  }

  // ---- Small pieces ------------------------------------------------------------------------------------------

  function tile(item, size = "") {
    const shelf = SHELF[item.category];
    const box = el("span", `plug-icon skill-icon${size ? ` ${size}` : ""}`);
    box.style.background = shelf?.color || "var(--icon-tile)";
    box.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shelf?.icon || SHELVES[0][3]}</svg>`;
    return box;
  }

  function pill(item) {
    if (item.default) return ["Built in", "ok"];
    if (item.agents.length) return [item.agents.length === 1 ? "1 agent" : `${item.agents.length} agents`, "ok"];
    return ["Add", "go"];
  }

  function card(item) {
    const node = el("button", "plug-card");
    node.type = "button";
    node.dataset.skill = item.name;
    const copy = el("span", "plug-copy");
    copy.append(el("span", "plug-name", item.title), el("span", "plug-desc", item.description));
    const [label, tone] = pill(item);
    node.append(tile(item), copy, el("span", `plug-pill ${tone}`, label));
    node.addEventListener("click", () => openDetail(item.name));
    return node;
  }

  function matches(item) {
    if (sk.shelf === "added" && !(item.default || item.agents.length)) return false;
    if (sk.shelf !== "all" && sk.shelf !== "added" && item.category !== sk.shelf) return false;
    const words = sk.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = `${item.title} ${item.name} ${item.description} ${shelfLabel(item.category)} ${item.author}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }

  // "NousResearch/hermes-agent at ee7e0f5" from a GitHub link pinned to a commit.
  function sourceLabel(url) {
    const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:tree|blob)\/([0-9a-f]{7})/.exec(url || "");
    return match ? `${match[1]} at ${match[2]}` : url;
  }

  function link(href, text, className = "") {
    const node = document.createElement("a");
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  // ---- The page ------------------------------------------------------------------------------------------------

  function renderPage() {
    const body = $("skills-body");
    if (!body) return;
    const keepSearch = document.activeElement?.id === "skill-search";
    body.replaceChildren();

    const search = el("div", "plug-search");
    search.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.2"></circle><path d="M12.5 12.5 17 17"></path></svg>';
    const input = document.createElement("input");
    input.id = "skill-search";
    input.type = "search";
    input.placeholder = "Search skills";
    input.autocomplete = "off";
    input.value = sk.query;
    input.addEventListener("input", () => {
      sk.query = input.value;
      renderPage();
    });
    search.append(input);
    body.append(search);

    if (!sk.data) {
      body.append(el("p", "hint", sk.loading ? "Loading skills…" : "Skills could not be loaded."));
      return;
    }

    const items = sk.data.skills;
    const intro = el("p", "hint skill-intro");
    intro.textContent = `A skill is a written procedure an agent opens when a task matches, so it costs nothing until it is used. Every skill here ships with Ravnir and shows its license and where it came from. Each agent can hold ${room()} on top of the built-in ones.`;
    body.append(intro);

    const chips = el("div", "plug-chips");
    const shelves = [...new Set(items.map((item) => item.category))].sort((a, b) => {
      const order = (key) => {
        const at = SHELVES.findIndex((shelf) => shelf[0] === key);
        return at < 0 ? 99 : at;
      };
      return order(a) - order(b);
    });
    const options = [["all", "All"], ["added", "On an agent"], ...shelves.map((key) => [key, shelfLabel(key)])];
    for (const [key, label] of options) {
      const chip = el("button", `plug-chip${sk.shelf === key ? " on" : ""}`, label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        sk.shelf = key;
        renderPage();
      });
      chips.append(chip);
    }
    body.append(chips);

    const found = items.filter(matches);
    const browsing = sk.shelf === "all" && !sk.query.trim();
    if (!found.length) {
      body.append(el("p", "hint", sk.query ? `No skill matches "${sk.query}".` : "No agent has one of these yet."));
    } else if (browsing) {
      for (const key of shelves) {
        const group = found.filter((item) => item.category === key);
        if (!group.length) continue;
        const section = el("section", "plug-section");
        section.append(el("h2", "plug-title", shelfLabel(key)));
        const grid = el("div", "plug-grid");
        for (const item of group) grid.append(card(item));
        section.append(grid);
        body.append(section);
      }
    } else {
      const section = el("section", "plug-section");
      section.append(el("h2", "plug-title", found.length === 1 ? "1 skill" : `${found.length} skills`));
      const grid = el("div", "plug-grid");
      for (const item of found) grid.append(card(item));
      section.append(grid);
      body.append(section);
    }

    if (keepSearch) {
      const field = $("skill-search");
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  // ---- The sheet for one skill -------------------------------------------------------------------------------------

  function ensureDialog() {
    if (sk.dialog) return sk.dialog;
    const dialog = document.createElement("dialog");
    dialog.className = "dialog plug-dialog skill-dialog";
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      sk.openName = "";
      sk.reading = false;
    });
    document.body.append(dialog);
    sk.dialog = dialog;
    return dialog;
  }

  function openDetail(name) {
    if (!entry(name)) return;
    sk.openName = name;
    sk.reading = false;
    const dialog = ensureDialog();
    renderDialog();
    if (!dialog.open) dialog.showModal();
  }

  function detailRow(label, value) {
    const row = el("div", "skill-fact");
    row.append(el("span", "skill-fact-label", label));
    const cell = el("span", "skill-fact-value");
    if (value instanceof Node) cell.append(value);
    else cell.textContent = value;
    row.append(cell);
    return row;
  }

  function renderDialog() {
    const item = entry(sk.openName);
    const dialog = sk.dialog;
    if (!item || !dialog) return;
    const scroll = dialog.querySelector(".dialog-body")?.scrollTop || 0;
    const card = el("div", "dialog-card");
    const head = el("header", "dialog-head plug-head");
    const title = el("div", "plug-head-copy");
    title.append(tile(item, "lg"));
    const names = el("div", "");
    names.append(el("p", "kicker", `${shelfLabel(item.category)} skill`), el("h2", "", item.title));
    title.append(names);
    const close = el("button", "icon-btn", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => dialog.close());
    head.append(title, close);

    const body = el("div", "dialog-body plug-body");
    body.append(el("p", "plug-desc-full", item.description));

    const facts = el("div", "plug-block skill-facts");
    facts.append(detailRow("Source", item.source ? link(item.source, sourceLabel(item.source)) : "Written for Ravnir"));
    facts.append(detailRow("License", item.license || "Not stated"));
    if (item.author) facts.append(detailRow("Author", item.author));
    if (item.version) facts.append(detailRow("Version", item.version));
    if (item.requires?.length) facts.append(detailRow("Needs", item.requires.join(", ")));
    facts.append(detailRow("When opened", `About ${item.tokens.toLocaleString()} tokens, only on the turn that uses it`));
    facts.append(detailRow("Files", item.files.length ? `${item.files.length} extra ${item.files.length === 1 ? "file" : "files"}, read only when needed` : "Just the procedure"));
    if (item.scripts) facts.append(detailRow("Scripts", "Includes scripts the agent may run in its own shell"));
    body.append(facts);

    const agents = el("div", "plug-block");
    agents.append(el("p", "plug-block-title", "Agents that have it"));
    if (item.default) {
      agents.append(el("p", "hint", "Built in. Every agent has this skill, so there is nothing to add."));
    } else {
      agents.append(el("p", "hint", `An agent sees the skill's name from its next message and opens it when a task matches. Each agent holds up to ${room()} skills besides the built-in ones.`));
      const list = el("div", "plug-agents");
      for (const bot of state.bots) {
        const row = el("label", "plug-agent");
        const face = el("span", "avatar");
        paintCreature(face, bot);
        const copy = el("span", "plug-agent-copy");
        copy.append(el("span", "plug-agent-name", bot.name));
        const has = item.agents.includes(bot.id);
        const used = heldBy(bot.id).length;
        const full = !has && used >= room();
        copy.append(el("small", "hint", full ? `Full: ${used} of ${room()} skills` : `${used} of ${room()} skills`));
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "plug-switch";
        toggle.checked = has;
        toggle.disabled = sk.busy === item.name || full;
        toggle.setAttribute("aria-label", `${bot.name} has ${item.title}`);
        toggle.addEventListener("change", () => {
          const next = new Set(item.agents);
          if (toggle.checked) next.add(bot.id);
          else next.delete(bot.id);
          setAgents(item, [...next]);
        });
        row.append(face, copy, toggle);
        list.append(row);
      }
      if (!state.bots.length) list.append(el("p", "hint", "Create an agent first."));
      agents.append(list);
    }
    body.append(agents);

    const read = el("div", "plug-block");
    const toggleRead = el("button", "ghost skill-read-toggle", sk.reading ? "Hide the skill" : "Read the skill");
    toggleRead.type = "button";
    toggleRead.setAttribute("aria-expanded", String(sk.reading));
    toggleRead.addEventListener("click", () => readNow(item));
    read.append(toggleRead);
    if (sk.reading) {
      const text = sk.bodies[item.name];
      const page = el("div", "skill-text");
      if (text === undefined) page.append(el("p", "hint", "Loading…"));
      else if (window.RavnirMarkdown) window.RavnirMarkdown.render(page, unwrap(text));
      else page.textContent = text;
      read.append(page);
    }
    body.append(read);

    const foot = el("footer", "dialog-foot plug-foot");
    const done = el("button", "primary", "Done");
    done.type = "button";
    done.addEventListener("click", () => dialog.close());
    foot.append(done);
    card.append(head, body, foot);
    dialog.replaceChildren(card);
    dialog.querySelector(".dialog-body").scrollTop = scroll;
  }

  // SKILL.md files wrap prose at about 100 columns; the chat renderer keeps every newline, so join
  // the wrapped lines of a paragraph or list item back together. Code, tables and headings stay.
  function unwrap(text) {
    const out = [];
    let fenced = false;
    const starts = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```|~~~)/;
    for (const line of String(text || "").split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const last = out[out.length - 1];
      const joinable = !fenced && line.trim() && !starts.test(line) && last !== undefined && last.trim()
        && !/^\s*(```|~~~|\||#{1,6}\s)/.test(last) && !/^\s*(```|~~~)/.test(line);
      if (joinable) out[out.length - 1] = `${last.replace(/\s+$/, "")} ${line.trim()}`;
      else out.push(line);
    }
    return out.join("\n");
  }

  async function readNow(item) {
    sk.reading = !sk.reading;
    renderDialog();
    if (!sk.reading || sk.bodies[item.name] !== undefined) return;
    try {
      const result = await api(`/api/skills/${encodeURIComponent(item.name)}`);
      sk.bodies[item.name] = result.body;
    } catch (error) {
      sk.reading = false;
      toast(error.message, "error");
    }
    if (sk.openName === item.name) renderDialog();
  }

  // ---- The agent's Skills tab ---------------------------------------------------------------------------------------

  function panelRow(item, bot) {
    const row = el("div", "skill-row");
    const open = el("button", "skill-row-main");
    open.type = "button";
    open.append(tile(item));
    const copy = el("span", "plug-copy");
    copy.append(el("span", "plug-name", item.title), el("span", "plug-desc", item.description));
    open.append(copy);
    open.addEventListener("click", () => openSkills(item.name));
    row.append(open);
    if (item.default) {
      row.append(el("span", "plug-pill ok", "Built in"));
    } else {
      const remove = el("button", "ghost", "Remove");
      remove.type = "button";
      remove.disabled = sk.busy === item.name;
      remove.addEventListener("click", async () => {
        await setAgents(item, item.agents.filter((id) => id !== bot.id));
        toast(`${bot.name} no longer has ${item.title}.`);
      });
      row.append(remove);
    }
    return row;
  }

  function renderPanel(bot) {
    const list = $("skill-list");
    if (!list || !bot) return;
    if (!sk.data) {
      list.replaceChildren(el("p", "hint", "Loading skills…"));
      if (!sk.loading) refresh({ quiet: true });
      return;
    }
    list.replaceChildren();
    const added = heldBy(bot.id);
    const builtIn = sk.data.skills.filter((item) => item.default);
    list.append(el("p", "plug-title", `Added · ${added.length} of ${room()}`));
    if (added.length) for (const item of added) list.append(panelRow(item, bot));
    else list.append(el("p", "hint", "None yet. Browse skills to teach this agent research, writing, finance, engineering and more."));
    if (builtIn.length) {
      list.append(el("p", "plug-title", "Built in for every agent"));
      for (const item of builtIn) list.append(panelRow(item, bot));
    }
  }

  window.RavnirSkills = {
    async open(name = "") {
      renderPage();
      await refresh();
      if (name && entry(name)) openDetail(name);
    },
    renderPanel(bot) {
      renderPanel(bot);
      refresh({ quiet: true });
    },
  };
})();
