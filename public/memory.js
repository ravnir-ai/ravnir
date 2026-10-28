// The Memory page: what the agents wrote into the shared vault, who and why, with undo; the notes
// themselves; and backup and restore. Loaded after app.js, so state, els, el, api, toast, ask,
// timeAgo, selectBot, paintCreature and renderMarkdown are global.
// The server side is /api/memory* (server/vault/history.js) and /api/backup/* (server/backup.js).

(() => {
  "use strict";

  const PAGE = 50;
  const mem = {
    data: null,
    error: "",
    tab: "changes",
    agent: "",
    note: "",
    items: [],
    more: false,
    loading: false,
    logRequest: 0,
    logError: null,
    notes: null,
    notesError: "",
    notesQuery: "",
    dialog: null,
    busy: "",
    restoring: false,
  };

  const button = (className, text, onClick) => {
    const node = el("button", className, text);
    node.type = "button";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  };

  // ---- Data ----------------------------------------------------------------------------------------

  async function loadSummary() {
    try {
      mem.data = await api("/api/memory");
      mem.error = "";
    } catch (error) {
      mem.error = error.message;
    }
  }

  async function loadLog({ append = false } = {}) {
    if ((append && mem.loading) || !mem.data?.available || !mem.data.history) return;
    const request = ++mem.logRequest;
    mem.logError = null;
    mem.loading = true;
    renderTimelineOnly();
    try {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (mem.agent) query.set("agent", mem.agent);
      if (mem.note) query.set("note", mem.note);
      if (append && mem.items.length) query.set("before", mem.items[mem.items.length - 1].hash);
      const page = await api(`/api/memory/log?${query}`);
      if (request !== mem.logRequest) return;
      mem.items = append ? [...mem.items, ...page.items] : page.items;
      mem.more = Boolean(page.more);
    } catch (error) {
      if (request === mem.logRequest) mem.logError = { message: error.message, append };
    } finally {
      if (request === mem.logRequest) {
        mem.loading = false;
        renderTimelineOnly();
      }
    }
  }

  async function refresh() {
    await loadSummary();
    mem.items = [];
    mem.notes = null;
    mem.notesError = "";
    render();
    await loadLog();
  }

  async function open(target = "") {
    render();
    await loadSummary();
    mem.items = [];
    mem.more = false;
    render();
    await loadLog();
    if (target === "backup") document.getElementById("mem-backup")?.scrollIntoView({ block: "start", behavior: "smooth" });
    else if (/^[0-9a-f]{7,40}$/i.test(target)) openCommit(target);
  }

  // ---- Page ----------------------------------------------------------------------------------------

  function section(title, hint = "", id = "") {
    const node = el("section", "mem-section");
    if (id) node.id = id;
    node.append(el("h2", "mem-title", title));
    if (hint) node.append(el("p", "hint", hint));
    return node;
  }

  function render() {
    const body = els["memory-body"];
    const scroll = body.scrollTop;
    const parts = [];
    const data = mem.data;
    if (!data) {
      parts.push(el("p", "hint", mem.error || "Loading…"));
    } else if (!data.available) {
      const empty = el("div", "mem-empty");
      empty.append(el("strong", "", "No shared vault on this server yet."), el("p", "hint", "The vault is a folder of notes, kept in git, that every agent can read and write. Once it is set up, everything they save shows here and you can undo any of it."));
      parts.push(empty);
    } else {
      if (data.proposals?.length) parts.push(proposalsBlock(data.proposals));
      parts.push(tabs());
      if (mem.tab === "changes") parts.push(changesBlock());
      else parts.push(notesBlock());
      parts.push(obsidianBlock());
    }
    parts.push(backupBlock());
    body.replaceChildren(...parts);
    body.scrollTop = scroll;
    if (data?.available && mem.tab === "notes" && !mem.notes) loadNotes();
  }

  function tabs() {
    const bar = el("div", "mem-tabs");
    bar.setAttribute("role", "tablist");
    for (const [id, label] of [["changes", "Changes"], ["notes", "Notes"]]) {
      const tab = button(`mem-tab${mem.tab === id ? " on" : ""}`, label, () => {
        mem.tab = id;
        render();
      });
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(mem.tab === id));
      bar.append(tab);
    }
    const stats = [];
    if (mem.data?.notes) stats.push(`${mem.data.notes} notes`);
    if (mem.data?.writes === false) stats.push("read only");
    if (stats.length) bar.append(el("span", "mem-stats", stats.join(" · ")));
    return bar;
  }

  // ---- Waiting for you -------------------------------------------------------------------------------

  function proposalsBlock(list) {
    const wrap = section("Waiting for you", "An agent wants to change a shared note. Nothing is written until you approve.");
    wrap.classList.add("mem-waiting");
    for (const proposal of list) {
      const card = el("div", "mem-proposal");
      const head = el("div", "mem-proposal-head");
      const bot = state.bots.find((item) => item.id === proposal.botId);
      head.append(face(bot, proposal.botName), el("strong", "", proposal.botName || bot?.name || "An agent"), el("span", "mem-proposal-note", proposal.change?.note || ""));
      card.append(head);
      if (proposal.change?.section) card.append(el("p", "mem-proposal-section", `Section: ${proposal.change.section}`));
      if (proposal.why) card.append(el("p", "mem-proposal-why", proposal.why));
      if (proposal.change?.text) card.append(el("pre", "mem-code", proposal.change.text));
      const actions = el("div", "mem-actions");
      const approve = button("primary", "Approve", () => decide(proposal, "accept", approve, reject));
      const reject = button("ghost danger-text", "Reject", () => decide(proposal, "dismiss", approve, reject));
      actions.append(approve, reject);
      card.append(actions);
      wrap.append(card);
    }
    return wrap;
  }

  async function decide(proposal, decision, ...buttons) {
    for (const item of buttons) item.disabled = true;
    try {
      await api(`/api/proposals/${encodeURIComponent(proposal.id)}`, { method: "POST", body: { decision } });
      toast(decision === "accept" ? "Approved. The change is in the vault." : "Rejected.");
    } catch (error) {
      toast(error.message, "error");
    }
    await refresh();
    refreshBots?.();
    loadToday?.();
  }

  // ---- Changes ---------------------------------------------------------------------------------------

  function face(bot, name) {
    const node = el("span", "avatar xs");
    if (bot) paintCreature(node, bot);
    else clearAvatar(node, initials(name));
    return node;
  }

  function changesBlock() {
    const wrap = section("Changes", mem.data.history ? "" : "Change history is not available for this vault.");
    if (!mem.data.history) return wrap;
    const bar = el("div", "mem-filters");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Filter by agent");
    select.append(new Option("All agents", ""));
    for (const author of mem.data.authors || []) select.append(new Option(`${author.name} (${author.commits})`, author.name));
    select.value = mem.agent;
    select.addEventListener("change", () => {
      mem.agent = select.value;
      loadLog();
    });
    const note = document.createElement("input");
    note.type = "text";
    note.enterKeyHint = "search";
    note.placeholder = "Filter by note path";
    note.setAttribute("aria-label", "Filter by note");
    note.value = mem.note;
    note.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      mem.note = note.value.trim();
      loadLog();
    });
    note.addEventListener("change", () => {
      mem.note = note.value.trim();
      loadLog();
    });
    bar.append(select, note);
    wrap.append(bar);
    const list = el("div", "mem-timeline");
    list.id = "mem-timeline";
    wrap.append(list);
    fillTimeline(list);
    return wrap;
  }

  function renderTimelineOnly() {
    const list = document.getElementById("mem-timeline");
    if (list) fillTimeline(list);
  }

  function fillTimeline(list) {
    list.replaceChildren();
    // Which entries a later entry undid, so both ends can say so.
    const undone = new Map();
    for (const item of mem.items) {
      if (!item.reverts) continue;
      for (const other of mem.items) if (other.hash.startsWith(item.reverts) || item.reverts.startsWith(other.hash)) undone.set(other.hash, item);
    }
    if (!mem.items.length && !mem.loading && !mem.logError) {
      list.append(el("p", "hint", mem.agent || mem.note ? "Nothing matches those filters." : "Nothing has been saved yet. When an agent remembers something, it shows here."));
    }
    for (const item of mem.items) list.append(entry(item, undone.get(item.hash)));
    if (mem.loading) list.append(el("p", "hint", "Loading…"));
    else if (mem.logError) {
      const error = mem.logError;
      list.append(el("p", "hint", error.message), button("ghost", "Retry", () => loadLog({ append: error.append })));
    } else if (mem.more) list.append(button("ghost mem-more", "Load more", () => loadLog({ append: true })));
  }

  function entry(item, undoneBy) {
    const bot = state.bots.find((candidate) => candidate.id === item.botId || candidate.name === item.author);
    const row = el("div", `mem-entry${undoneBy ? " undone" : ""}`);
    row.append(face(bot, item.author));
    const main = el("div", "mem-entry-main");
    const open = button("mem-entry-open", "", () => openCommit(item.hash));
    const top = el("span", "mem-entry-top");
    const when = el("span", "mem-entry-time", timeAgo(Date.parse(item.at)));
    when.title = stampLabel(Date.parse(item.at));
    top.append(el("strong", "", item.author), when);
    open.append(top, el("span", "mem-entry-summary", item.summary || item.subject));
    main.append(open);
    const marks = [];
    if (item.reverts) marks.push(["Undid " + item.reverts.slice(0, 7), "pill warn"]);
    if (undoneBy) marks.push([`Undone by ${undoneBy.author}`, "pill warn"]);
    if (item.proposalId) marks.push(["Approved", "pill ok"]);
    if (item.merge) marks.push(["Merge", "pill"]);
    if (marks.length || item.files?.length) {
      const chips = el("div", "mem-chips");
      for (const [text, cls] of marks) chips.append(el("span", cls, text));
      for (const file of (item.files || []).slice(0, 3)) chips.append(fileChip(file));
      if ((item.files || []).length > 3) chips.append(el("span", "mem-more-files", `+${item.files.length - 3}`));
      main.append(chips);
    }
    row.append(main);
    return row;
  }

  // A file name sets the note filter, so you can follow one note's history.
  function fileChip(file) {
    const chip = button("mem-chip", file, () => {
      mem.note = file;
      render();
      loadLog();
    });
    chip.title = `Show only changes to ${file}`;
    return chip;
  }

  // ---- One change ------------------------------------------------------------------------------------

  function ensureDialog() {
    if (mem.dialog) return mem.dialog;
    const dialog = document.createElement("dialog");
    dialog.className = "dialog wide mem-dialog";
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
    mem.dialog = dialog;
    return dialog;
  }

  function sheet(kicker, title, content, foot = null) {
    const dialog = ensureDialog();
    const card = el("div", "dialog-card");
    const head = el("header", "dialog-head");
    const titles = el("div", "mem-sheet-titles");
    titles.append(el("p", "kicker", kicker), el("h2", "", title));
    const close = button("icon-btn", "×", () => dialog.close());
    close.setAttribute("aria-label", "Close");
    head.append(titles, close);
    const bodyNode = el("div", "dialog-body mem-sheet-body");
    bodyNode.append(...content);
    card.append(head, bodyNode);
    if (foot) card.append(foot);
    dialog.replaceChildren(card);
    if (!dialog.open) dialog.showModal();
  }

  async function openCommit(hash) {
    sheet("Change", "Loading…", [el("p", "hint", "Loading…")]);
    let item;
    try {
      item = await api(`/api/memory/commits/${encodeURIComponent(hash)}`);
    } catch (error) {
      mem.dialog.close();
      toast(error.message, "error");
      return;
    }
    const content = [];
    const meta = el("p", "mem-detail-meta");
    meta.append(`${item.author} · ${stampLabel(Date.parse(item.at))} · `, el("code", "", item.short));
    content.push(meta);
    if (item.revertedBy) content.push(el("p", "plug-note", `This change was undone by ${item.revertedBy}.`));
    if (item.reverts) content.push(el("p", "hint", `Undoes ${item.reverts.slice(0, 7)}.`));
    if (item.turn?.prompt) {
      const quote = el("p", "mem-prompt");
      quote.append(el("span", "mem-prompt-label", "Asked: "), plainText(item.turn.prompt).slice(0, 240));
      content.push(quote);
    }
    // The Ravnir-Turn and similar trailers are for the code, not for people.
    const note = String(item.body || "").split("\n").filter((line) => !/^Ravnir-[\w-]+:/.test(line)).join("\n").trim();
    if (note) content.push(el("p", "mem-body", note));
    if (item.files?.length) {
      const chips = el("div", "mem-chips");
      for (const file of item.files) chips.append(fileChip(file));
      content.push(chips);
    }
    content.push(diffView(item.diff || "", item.truncated));
    const foot = el("footer", "dialog-foot mem-foot");
    const links = el("div", "mem-foot-links");
    const turnBot = state.bots.find((bot) => bot.id === (item.turn?.botId || item.botId));
    if (item.turnId && turnBot) links.append(button("ghost", "From this turn", () => goToTurn(turnBot.id, item.turnId)));
    if (item.obsidian) {
      const link = el("a", "ghost mem-link", "Open in Obsidian");
      link.href = item.obsidian;
      link.rel = "noopener";
      links.append(link);
    }
    foot.append(links);
    if (item.canRevert) {
      const revert = button("danger", "Revert", () => revertCommit(item, revert));
      foot.append(revert);
    }
    sheet(item.author, item.summary || item.subject, content, foot);
  }

  function diffView(text, truncated) {
    const box = el("div", "mem-diff");
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "What changed");
    if (!text.trim()) {
      box.append(el("p", "hint", "No file changes."));
      return box;
    }
    for (const line of text.split("\n")) {
      if (/^(index |similarity |rename |new file mode|deleted file mode|old mode|new mode)/.test(line)) continue;
      let kind = "ctx";
      if (/^diff --git|^(\+\+\+|---) /.test(line)) kind = "file";
      else if (line.startsWith("@@")) kind = "hunk";
      else if (line.startsWith("+")) kind = "add";
      else if (line.startsWith("-")) kind = "del";
      box.append(el("div", `mem-line ${kind}`, line || " "));
    }
    if (truncated) box.append(el("p", "hint", "The change is longer than this. The rest is not shown."));
    return box;
  }

  async function goToTurn(botId, turnId) {
    mem.dialog?.close();
    await selectBot(botId);
    // The thread draws after the detail loads; look for the reply a few times.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const row = els.messages?.querySelector(`[data-turn="${CSS.escape(turnId)}"]`);
      if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        // The thread redraws on every poll, so mark the reply again until the highlight has played.
        const until = Date.now() + 2000;
        const mark = () => {
          els.messages?.querySelector(`[data-turn="${CSS.escape(turnId)}"]`)?.classList.add("turn-flash");
          if (Date.now() < until) setTimeout(mark, 200);
          else els.messages?.querySelector(".turn-flash")?.classList.remove("turn-flash");
        };
        mark();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function revertCommit(item, control) {
    const yes = await ask({
      kicker: "Memory",
      title: "Undo this change?",
      message: `This adds a new change that puts back what ${item.files?.length === 1 ? item.files[0] : "the notes"} said before. Nothing is erased from the history.`,
      confirm: "Undo change",
      danger: true,
    });
    if (!yes) return;
    control.disabled = true;
    try {
      await api(`/api/memory/commits/${encodeURIComponent(item.hash)}/revert`, { method: "POST", body: {} });
      mem.dialog?.close();
      toast("Undone. The vault is back to how it was.");
      await refresh();
    } catch (error) {
      control.disabled = false;
      toast(error.message, "error");
    }
  }

  // ---- Notes -----------------------------------------------------------------------------------------

  async function loadNotes() {
    mem.notesError = "";
    try {
      const result = await api("/api/memory/notes");
      mem.notes = result.items || [];
    } catch (error) {
      mem.notes = [];
      mem.notesError = error.message;
    }
    if (mem.tab === "notes") render();
  }

  function notesBlock() {
    const wrap = section("Notes");
    const search = document.createElement("input");
    search.type = "text";
    search.enterKeyHint = "search";
    search.placeholder = "Search notes by title or path";
    search.setAttribute("aria-label", "Search notes");
    search.value = mem.notesQuery;
    const list = el("div", "mem-notes");
    const draw = () => {
      list.replaceChildren();
      if (mem.notesError) {
        list.append(el("p", "hint", mem.notesError), button("ghost", "Retry", () => loadNotes()));
        return;
      }
      if (!mem.notes) {
        list.append(el("p", "hint", "Loading…"));
        return;
      }
      const needle = mem.notesQuery.trim().toLowerCase();
      const items = mem.notes.filter((note) => !needle || note.path.toLowerCase().includes(needle) || String(note.title || "").toLowerCase().includes(needle));
      if (!items.length) list.append(el("p", "hint", needle ? "No note matches." : "The vault has no notes yet."));
      const groups = new Map();
      for (const note of items) {
        const folder = note.path.includes("/") ? note.path.split("/")[0] : "Top level";
        if (!groups.has(folder)) groups.set(folder, []);
        groups.get(folder).push(note);
      }
      for (const [folder, notes] of groups) {
        const details = document.createElement("details");
        details.className = "mem-group";
        details.open = Boolean(needle) || groups.size === 1;
        details.append(el("summary", "", `${folder} (${notes.length})`));
        for (const note of notes) {
          const row = button("mem-note", "", () => openNote(note.path));
          row.append(el("span", "mem-note-title", note.title || note.path), el("span", "mem-note-path", note.path));
          details.append(row);
        }
        list.append(details);
      }
    };
    search.addEventListener("input", () => {
      mem.notesQuery = search.value;
      draw();
    });
    wrap.append(search, list);
    draw();
    return wrap;
  }

  async function openNote(path) {
    sheet("Note", path, [el("p", "hint", "Loading…")]);
    let note;
    try {
      note = await api(`/api/memory/note?path=${encodeURIComponent(path)}`);
    } catch (error) {
      mem.dialog.close();
      toast(error.message, "error");
      return;
    }
    const content = [];
    if (note.date) content.push(el("p", "mem-detail-meta", `Updated ${shortDate(Date.parse(note.date) || note.date, { year: true })}`));
    const text = el("div", "mem-note-body msg-body");
    renderMarkdown(text, note.body || "");
    content.push(text);
    const chipsFor = (label, paths, clickable) => {
      if (!paths?.length) return;
      const row = el("div", "mem-chips mem-links");
      row.append(el("span", "mem-links-label", label));
      for (const target of paths) {
        if (clickable) row.append(button("mem-chip", target, () => openNote(target)));
        else row.append(el("span", "mem-chip missing", target));
      }
      content.push(row);
    };
    chipsFor("Links to", note.links, true);
    chipsFor("Linked from", note.backlinks, true);
    chipsFor("Missing notes", note.unresolved, false);
    const foot = el("footer", "dialog-foot mem-foot");
    const links = el("div", "mem-foot-links");
    links.append(button("ghost", "Show its changes", () => {
      mem.dialog.close();
      mem.tab = "changes";
      mem.note = note.path;
      render();
      loadLog();
    }));
    if (note.obsidian) {
      const link = el("a", "ghost mem-link", "Open in Obsidian");
      link.href = note.obsidian;
      link.rel = "noopener";
      links.append(link);
    }
    foot.append(links);
    sheet("Note", note.title || note.path, content, foot);
  }

  function obsidianBlock() {
    const wrap = section("Obsidian", "If you read this vault in Obsidian, give its name as Obsidian shows it so notes open there.");
    const row = el("div", "mem-row");
    const input = document.createElement("input");
    input.placeholder = "Obsidian vault name";
    input.setAttribute("aria-label", "Obsidian vault name");
    input.maxLength = 120;
    input.value = mem.data?.obsidian || "";
    const save = button("ghost", "Save", async () => {
      save.disabled = true;
      try {
        const result = await api("/api/memory/obsidian", { method: "PUT", body: { name: input.value.trim() } });
        if (mem.data) mem.data.obsidian = result.obsidian;
        toast("Saved.");
      } catch (error) {
        toast(error.message, "error");
      }
      save.disabled = false;
    });
    row.append(input, save);
    wrap.append(row);
    return wrap;
  }

  // ---- Backup ----------------------------------------------------------------------------------------

  // fetch without api(): the answer is a file, and the restore body is raw bytes.
  async function rawRequest(path, options) {
    let response;
    try {
      response = await fetch(path, options);
    } catch {
      throw new Error("Cannot reach the server.");
    }
    if (response.status === 401) {
      signedOut();
      throw new Error("You are signed out.");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || response.statusText);
    }
    return response;
  }

  function backupBlock() {
    const wrap = section("Backup", "Save the agents, their settings, the vault and (with a passphrase) saved passwords and keys to one file.", "mem-backup");
    wrap.classList.add("mem-backup");

    const pass = document.createElement("input");
    pass.type = "password";
    pass.autocomplete = "new-password";
    pass.placeholder = "Passphrase (optional)";
    pass.setAttribute("aria-label", "Backup passphrase");
    const hint = el("p", "hint", "Leave empty to export without saved passwords and keys. At least 10 characters.");
    const spaces = el("label", "mem-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    spaces.append(box, " Include agents' workspaces (can be large)");
    const out = button("primary", "Export", async () => {
      if (pass.value && pass.value.length < 10) {
        toast("Use at least 10 characters, or leave the passphrase empty.", "error");
        return;
      }
      out.disabled = true;
      out.textContent = "Exporting…";
      try {
        const response = await rawRequest("/api/backup/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase: pass.value, workspaces: box.checked }),
        });
        const info = (() => {
          try {
            return JSON.parse(response.headers.get("x-ravnir-backup") || "{}");
          } catch {
            return {};
          }
        })();
        const name = /filename="?([^";]+)"?/i.exec(response.headers.get("content-disposition") || "")?.[1] || "ravnir-backup.tar.gz";
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        const agents = info.bots ?? 0;
        toast(`Saved a backup of ${agents} agent${agents === 1 ? "" : "s"}${info.vault && info.vault !== "none" ? ", the vault" : ""}${info.secrets && info.secrets !== "omitted" ? " and secrets" : ""}.`);
        pass.value = "";
      } catch (error) {
        toast(error.message, "error");
      }
      out.disabled = false;
      out.textContent = "Export";
    });
    const exportRow = el("div", "mem-form");
    exportRow.append(pass, hint, spaces, out);
    wrap.append(el("h3", "mem-sub", "Export"), exportRow);

    // Only a fresh install can take a restore; the server refuses otherwise.
    if (!state.bots.length) wrap.append(restoreBlock());
    return wrap;
  }

  function restoreBlock() {
    const form = el("div", "mem-form");
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".gz,.tgz,application/gzip";
    file.setAttribute("aria-label", "Backup file");
    const pass = document.createElement("input");
    pass.type = "password";
    pass.autocomplete = "off";
    pass.placeholder = "Passphrase (if the backup has one)";
    pass.setAttribute("aria-label", "Restore passphrase");
    const status = el("p", "hint");
    status.setAttribute("role", "status");
    const go = button("primary", "Restore", async () => {
      const chosen = file.files?.[0];
      if (!chosen) {
        toast("Choose a backup file first.", "error");
        return;
      }
      go.disabled = true;
      status.textContent = "Restoring…";
      try {
        const response = await rawRequest("/api/backup/restore", {
          method: "POST",
          headers: { "content-type": "application/gzip", "x-ravnir-passphrase": encodeURIComponent(pass.value) },
          body: chosen,
        });
        const result = await response.json();
        if (result.restart === "now") {
          status.textContent = "Restored. Restarting…";
          waitForServer();
        } else {
          const count = result.bots ?? 0;
          status.textContent = `Restored ${count} agent${count === 1 ? "" : "s"}. Restart Ravnir to finish.`;
          go.disabled = false;
        }
      } catch (error) {
        status.textContent = error.message;
        go.disabled = false;
      }
    });
    form.append(file, pass, go, status);
    const wrap = el("div", "mem-restore");
    wrap.append(el("h3", "mem-sub", "Restore"), el("p", "hint", "Restore a backup into this fresh install. It brings back the agents, the vault and, with the right passphrase, the saved secrets."), form);
    return wrap;
  }

  // The server exits to restart itself; wait until it answers again, then load the restored state.
  function waitForServer() {
    setTimeout(async function poll() {
      try {
        const response = await fetch("/api/state", { cache: "no-store" });
        if (response.ok) {
          location.reload();
          return;
        }
      } catch {
        // still restarting
      }
      setTimeout(poll, 2000);
    }, 3000);
  }

  window.RavnirMemory = { open, refresh, openCommit, openNote };
})();
