/* Ravnir artifacts: thread cards, the full viewer and the gallery.
   window.RavnirArtifacts = { card, open, gallery, invalidate }
   Uses RavnirMarkdown, RavnirCharts, RavnirDiagrams and RavnirHighlight when present. */
(function () {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  const HTML_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals allow-downloads";
  const KIND_WORDS = { html: "Page", markdown: "Document", csv: "Table", chart: "Chart", mermaid: "Diagram", svg: "Image", code: "Code", file: "File" };
  const TOGGLE_KINDS = new Set(["html", "markdown", "svg", "mermaid", "chart", "csv"]);
  const CSV_ROW_CAP = 2000;

  const cards = new Map(); // `${botId}:${id}:${version}` -> element
  const details = new Map(); // same key -> promise of { artifact, version, content }

  /* ---------- small helpers ---------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const ICONS = {
    html: [["rect", { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }], ["path", { d: "M3 9h18" }], ["path", { d: "M9.5 13.5 8 15l1.5 1.5M14.5 13.5 16 15l-1.5 1.5" }]],
    markdown: [["path", { d: "M7 3.5h7.5L19 8v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5z" }], ["path", { d: "M9 12h6M9 15.5h6M9 8.5h3" }]],
    csv: [["rect", { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }], ["path", { d: "M3.5 10h17M3.5 15h17M9.5 4.5v15" }]],
    chart: [["path", { d: "M4 20h16" }], ["rect", { x: 5.5, y: 12, width: 3, height: 6, rx: 0.8 }], ["rect", { x: 10.5, y: 7, width: 3, height: 11, rx: 0.8 }], ["rect", { x: 15.5, y: 10, width: 3, height: 8, rx: 0.8 }]],
    mermaid: [["rect", { x: 9, y: 3.5, width: 6, height: 4.5, rx: 1.2 }], ["rect", { x: 3.5, y: 15.5, width: 6, height: 4.5, rx: 1.2 }], ["rect", { x: 14.5, y: 15.5, width: 6, height: 4.5, rx: 1.2 }], ["path", { d: "M12 8v3.5M6.5 15.5v-4h11v4" }]],
    svg: [["rect", { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }], ["circle", { cx: 9, cy: 10, r: 1.5 }], ["path", { d: "m4 17 5-4.5 3.5 3L15.5 13 20 17" }]],
    code: [["path", { d: "m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 5l-3 14" }]],
    file: [["path", { d: "M7 3.5h6.5L19 9v10.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" }], ["path", { d: "M13.5 3.5V9H19" }]],
    download: [["path", { d: "M12 4v11M7.5 11 12 15.5 16.5 11M5 19.5h14" }]],
  };

  function icon(name, size) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", String(size || 18));
    s.setAttribute("height", String(size || 18));
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.6");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ICONS[name] || ICONS.file) {
      const n = document.createElementNS(SVGNS, tag);
      for (const k in attrs) n.setAttribute(k, String(attrs[k]));
      s.append(n);
    }
    return s;
  }

  const enc = encodeURIComponent;
  function base(botId, id) { return `/api/bots/${enc(botId)}/artifacts/${enc(id)}`; }
  // In the home-screen app a download link opens a separate Safari that has no sign-in,
  // so Download becomes the share sheet with the file (Save to Files, Books, Mail).
  function sharing() {
    return !!(window.RavnirPdf && RavnirPdf.standalone() && navigator.canShare);
  }
  function shareInstead(link, target) {
    link.addEventListener("click", (e) => {
      if (!sharing()) return;
      e.preventDefault();
      const [url, name, type] = target();
      RavnirPdf.share(url, name, type).catch((error) => window.RavnirHost?.toast?.(error.message || "Could not share the file.", "error"));
    });
  }
  const EXT = { html: "html", markdown: "md", csv: "csv", chart: "json", mermaid: "mmd", svg: "svg", code: "txt" };
  function downloadName(meta) {
    const name = String(meta?.title || "file").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
    return EXT[meta?.kind] ? `${name}.${EXT[meta.kind]}` : name;
  }

  function rawUrl(botId, id, v, download) {
    return `${base(botId, id)}/raw?v=${enc(v)}${download ? "&download=1" : ""}`;
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.status === 401) throw new Error("Your session ended. Sign in again.");
    if (!res.ok) throw new Error(`Could not load this (${res.status}).`);
    return res.json();
  }

  function fetchDetail(botId, id, v) {
    const key = `${botId}:${id}:${v}`;
    let p = details.get(key);
    if (!p) {
      p = getJson(`${base(botId, id)}?v=${enc(v)}`);
      details.set(key, p);
      p.catch(() => { if (details.get(key) === p) details.delete(key); });
    }
    return p;
  }

  function fmtSize(n) {
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function ago(ms) {
    if (!ms) return "";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
    return fmtDay(ms);
  }

  function fmtDay(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function fmtStamp(ms) {
    const d = new Date(ms);
    return `${fmtDay(ms)} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }

  function kindWord(m) {
    if (m.kind === "code") return m.language ? String(m.language) : "Code";
    if (m.kind === "file") return m.filename || "File";
    return KIND_WORDS[m.kind] || "File";
  }

  function subline(m) {
    if (m.kind === "file") {
      const parts = [m.filename || "File"];
      if (m.size != null) parts.push(fmtSize(m.size));
      return parts.filter(Boolean).join(" · ");
    }
    const parts = [kindWord(m)];
    if (m.version != null) parts.push(`v${m.version}`);
    const t = ago(m.updatedAt || m.createdAt);
    if (t) parts.push(t);
    return parts.join(" · ");
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", q = false, i = 0;
    const s = String(text || "").replace(/^﻿/, "");
    while (i < s.length) {
      const c = s[i];
      if (q) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
  }

  function numeric(s) {
    const t = String(s).trim().replace(/[,$€£%\s]/g, "");
    if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
    return Number(t);
  }

  function csvTable(rows, opts) {
    const wrap = el("div", "md-table-wrap");
    const table = el("table", "md-table");
    const thead = el("thead");
    const tbody = el("tbody");
    const head = rows[0] || [];
    const body = rows.slice(1);
    const hr = el("tr");
    const ths = [];
    head.forEach((h, ci) => {
      const th = el("th", opts && opts.sortable ? "art-sortable" : "", h);
      if (opts && opts.sortable) {
        th.tabIndex = 0;
        th.setAttribute("role", "columnheader");
        th.dataset.col = String(ci);
        th.append(el("span", "art-sort-mark"));
      }
      ths.push(th);
      hr.append(th);
    });
    thead.append(hr);
    table.append(thead, tbody);
    wrap.append(table);
    function paint(list) {
      const frag = document.createDocumentFragment();
      for (const r of list) {
        const tr = el("tr");
        for (let ci = 0; ci < head.length; ci++) tr.append(el("td", "", r[ci] == null ? "" : r[ci]));
        frag.append(tr);
      }
      tbody.replaceChildren(frag);
    }
    paint(opts && opts.limit ? body.slice(0, opts.limit) : body);
    return { wrap, ths, body, head, paint };
  }

  function setCode(codeEl, text, lang) {
    codeEl.textContent = "";
    let frag = null;
    try { frag = globalThis.RavnirHighlight?.render?.(text, lang || ""); } catch (_) { frag = null; }
    if (frag) codeEl.append(frag); else codeEl.textContent = text;
  }

  function codeBlock(text, lang) {
    const pre = el("pre", "art-code");
    const code = el("code");
    setCode(code, text, lang);
    pre.append(code);
    return pre;
  }

  /* ---------- previews (card) ---------- */

  function renderChartInto(box, content) {
    let ok = false;
    try { ok = !!globalThis.RavnirCharts?.render?.(box, content); } catch (_) { ok = false; }
    if (!ok) { box.textContent = ""; box.append(codeBlock(String(content || ""), "json")); }
  }

  function renderMermaidInto(box, content) {
    let ok = false;
    try { ok = !!globalThis.RavnirDiagrams?.render?.(box, content); } catch (_) { ok = false; }
    if (!ok) box.append(codeBlock(String(content || ""), ""));
  }

  function renderMarkdownInto(box, content) {
    const md = globalThis.RavnirMarkdown;
    if (md?.render) {
      try { md.render(box, content); return; } catch (_) { box.textContent = ""; }
    }
    box.append(el("div", "art-plain", content));
  }

  function drawPreview(box, meta, content, botId) {
    const v = meta.version;
    if (meta.kind === "chart") renderChartInto(box, content);
    else if (meta.kind === "csv") {
      const rows = parseCsv(content);
      if (rows.length) box.append(csvTable(rows, { limit: 8 }).wrap);
    } else if (meta.kind === "svg") {
      const img = el("img", "art-img");
      img.alt = meta.title || "";
      img.loading = "lazy";
      img.src = rawUrl(botId, meta.id, v);
      box.append(img);
    } else if (meta.kind === "mermaid") renderMermaidInto(box, content);
    else if (meta.kind === "markdown") renderMarkdownInto(box, String(content || "").slice(0, 1500));
  }

  const PREVIEW_KINDS = new Set(["chart", "csv", "svg", "mermaid", "markdown"]);

  /* ---------- card ---------- */

  function buildCard(ref, botId, fresh) {
    const meta = Object.assign({}, ref);
    const root = el("div", "art-card");
    root.dataset.kind = meta.kind || "file";
    const head = el("div", "art-head");
    const tile = el("span", "art-tile");
    tile.append(icon(meta.kind));
    const text = el("div", "art-text");
    const title = el("div", "art-title", meta.title || "Untitled");
    title.title = meta.title || "";
    const sub = el("div", "art-sub", subline(meta));
    text.append(title, sub);
    const actions = el("div", "art-actions");
    const openBtn = el("button", "ghost art-open", "Open");
    openBtn.type = "button";
    openBtn.addEventListener("click", () => open(botId, meta.id, { version: meta.version }));
    const dl = el("a", "ghost art-dl");
    dl.href = rawUrl(botId, meta.id, meta.version, true);
    dl.setAttribute("download", meta.filename || "");
    dl.title = "Download";
    dl.setAttribute("aria-label", "Download");
    dl.append(icon("download", 15));
    shareInstead(dl, () => [rawUrl(botId, meta.id, meta.version), meta.filename || downloadName(meta), meta.mime]);
    actions.append(openBtn, dl);
    head.append(tile, text, actions);
    root.append(head);

    let previewBox = null;
    const wantsPreview = PREVIEW_KINDS.has(meta.kind) || (meta.kind === "file" && /^image\//.test(meta.mime || ""));
    if (wantsPreview) {
      previewBox = el("div", "art-preview");
      previewBox.tabIndex = 0;
      previewBox.setAttribute("role", "button");
      previewBox.setAttribute("aria-label", `Open ${meta.title || "artifact"}`);
      const inner = el("div", "art-preview-inner");
      previewBox.append(inner);
      previewBox.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        open(botId, meta.id, { version: meta.version });
      });
      previewBox.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(botId, meta.id, { version: meta.version }); }
      });
      root.append(previewBox);
      if (meta.kind === "file") {
        const img = el("img", "art-img");
        img.alt = meta.title || "";
        img.loading = "lazy";
        img.src = rawUrl(botId, meta.id, meta.version);
        inner.append(img);
      }
    }

    const needsDetail = wantsPreview && meta.kind !== "file" ? true : !(meta.updatedAt || meta.createdAt) || (meta.kind === "file" && meta.size == null);
    if (needsDetail) {
      fetchDetail(botId, meta.id, meta.version).then((d) => {
        if (d && d.artifact) {
          Object.assign(meta, d.artifact, { version: meta.version });
          sub.textContent = subline(meta);
          title.textContent = meta.title || "Untitled";
          root.dataset.kind = meta.kind;
        }
        if (meta.kind === "file" && !previewBox && /^image\//.test(meta.mime || "")) {
          const box = el("div", "art-preview");
          const inner = el("div", "art-preview-inner");
          const img = el("img", "art-img");
          img.alt = meta.title || "";
          img.src = rawUrl(botId, meta.id, meta.version);
          inner.append(img);
          box.append(inner);
          box.addEventListener("click", () => open(botId, meta.id, { version: meta.version }));
          root.append(box);
        }
        if (previewBox && meta.kind !== "file") {
          const inner = previewBox.firstChild;
          if (d && d.content != null) drawPreview(inner, meta, d.content, botId);
          else if (meta.kind === "svg") drawPreview(inner, meta, "", botId);
          else previewBox.remove();
        }
      }).catch(() => {
        if (previewBox && meta.kind !== "file") previewBox.remove();
      });
    }
    return root;
  }

  function card(ref, opts) {
    const botId = opts && opts.botId;
    if (!ref || !ref.id) return el("div", "art-card");
    if (opts && opts.fresh) return buildCard(ref, botId, true);
    const key = `${botId}:${ref.id}:${ref.version}`;
    let node = cards.get(key);
    if (!node) {
      node = buildCard(ref, botId, false);
      cards.set(key, node);
    }
    return node;
  }

  function invalidate(botId, artifactId) {
    const prefix = `${botId}:${artifactId}:`;
    for (const k of [...cards.keys()]) if (k.startsWith(prefix)) cards.delete(k);
    for (const k of [...details.keys()]) if (k.startsWith(prefix)) details.delete(k);
  }

  /* ---------- gallery ---------- */

  function gallery(botId) {
    const root = el("div", "art-gallery");
    const status = el("div", "art-empty", "Loading…");
    root.append(status);
    getJson(`/api/bots/${enc(botId)}/artifacts`).then((data) => {
      const list = (data && data.artifacts) || [];
      root.textContent = "";
      if (!list.length) {
        root.append(el("div", "art-empty", "Nothing saved yet. Ask the agent for a report, a table or a page."));
        return;
      }
      for (const m of list) root.append(card(m, { botId, fresh: true }));
    }).catch((err) => {
      status.textContent = err && err.message ? err.message : "Could not load artifacts.";
    });
    return root;
  }

  /* ---------- viewer ---------- */

  function open(botId, artifactId, options) {
    const startVersion = options && options.version;
    const dialog = el("dialog", "art-viewer");
    const shell = el("div", "art-viewer-card");

    const bar = el("div", "art-bar");
    const titleWrap = el("div", "art-bar-title");
    const titleEl = el("div", "art-bar-name", "Loading…");
    const kindEl = el("div", "art-bar-kind");
    titleWrap.append(titleEl, kindEl);

    const controls = el("div", "art-controls");
    const versionSel = el("select", "art-version");
    versionSel.setAttribute("aria-label", "Version");
    versionSel.hidden = true;

    const seg = el("div", "art-seg");
    const btnPreview = el("button", "on", "Preview");
    const btnSource = el("button", "", "Source");
    btnPreview.type = btnSource.type = "button";
    seg.append(btnPreview, btnSource);
    seg.hidden = true;

    const copyBtn = el("button", "ghost", "Copy source");
    const dlBtn = el("a", "ghost art-btn-link", "Download");
    const tabBtn = el("a", "ghost art-btn-link", "Open in new tab");
    const closeBtn = el("button", "ghost art-close", "Close");
    copyBtn.type = closeBtn.type = "button";
    dlBtn.target = "_self";
    tabBtn.target = "_blank";
    tabBtn.rel = "noopener noreferrer";
    tabBtn.hidden = true;
    copyBtn.hidden = true;
    dlBtn.hidden = true;
    controls.append(versionSel, seg, copyBtn, dlBtn, tabBtn, closeBtn);
    bar.append(titleWrap, controls);

    const body = el("div", "art-body");
    body.append(el("div", "art-status", "Loading…"));
    shell.append(bar, body);
    dialog.append(shell);

    const state = { meta: null, version: null, content: null, mode: "preview", loaded: false, token: 0 };

    function closeViewer() {
      stopPdf();
      if (dialog.open) dialog.close();
      dialog.remove();
    }
    closeBtn.addEventListener("click", closeViewer);
    dialog.addEventListener("close", () => { stopPdf(); dialog.remove(); });
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); closeViewer(); });
    dialog.addEventListener("click", (e) => { if (e.target === dialog) closeViewer(); });
    dialog.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeViewer(); } });

    function setMode(mode) {
      state.mode = mode;
      btnPreview.classList.toggle("on", mode === "preview");
      btnSource.classList.toggle("on", mode === "source");
      renderBody();
    }
    btnPreview.addEventListener("click", () => setMode("preview"));
    btnSource.addEventListener("click", () => setMode("source"));

    copyBtn.addEventListener("click", async () => {
      let text = state.content;
      try {
        if (text == null) {
          const res = await fetch(rawUrl(botId, artifactId, state.version), { credentials: "same-origin" });
          text = await res.text();
        }
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied";
      } catch (_) {
        copyBtn.textContent = "Could not copy";
      }
      setTimeout(() => { copyBtn.textContent = "Copy source"; }, 1600);
    });

    shareInstead(dlBtn, () => [rawUrl(botId, artifactId, state.version), state.meta?.filename || downloadName(state.meta), state.meta?.mime]);
    versionSel.addEventListener("change", () => load(Number(versionSel.value)));

    function status(msg, cls) {
      body.replaceChildren(el("div", cls || "art-status", msg));
    }

    let stopPdf = () => {};
    function renderBody() {
      const m = state.meta;
      if (!m) return;
      const v = state.version;
      const content = state.content;
      const kind = m.kind;
      const showSource = state.mode === "source" && TOGGLE_KINDS.has(kind);
      stopPdf();
      stopPdf = () => {};
      body.replaceChildren();
      body.className = "art-body";

      if (kind === "html" && !showSource) {
        const f = document.createElement("iframe");
        f.className = "art-frame";
        f.setAttribute("sandbox", HTML_SANDBOX);
        f.setAttribute("referrerpolicy", "no-referrer");
        f.title = m.title || "Page";
        f.src = rawUrl(botId, artifactId, v);
        body.classList.add("art-body-frame");
        body.append(f);
        return;
      }
      if (kind === "file") {
        const mime = m.mime || "";
        const url = rawUrl(botId, artifactId, v);
        if (/^image\//.test(mime)) {
          const img = el("img", "art-img-full");
          img.alt = m.title || "";
          img.src = url;
          body.classList.add("art-body-center");
          body.append(img);
        } else if (window.RavnirPdf && RavnirPdf.isPdf(mime, m.filename)) {
          stopPdf = RavnirPdf.render(body, url);
        } else {
          const box = el("div", "art-file");
          box.append(el("div", "art-file-name", m.filename || m.title || "File"));
          box.append(el("div", "art-file-meta", [mime, fmtSize(m.size)].filter(Boolean).join(" · ")));
          body.classList.add("art-body-center");
          body.append(box);
        }
        return;
      }
      if (kind === "svg" && !showSource) {
        const img = el("img", "art-img-full");
        img.alt = m.title || "";
        img.src = rawUrl(botId, artifactId, v);
        body.classList.add("art-body-center", "art-svg-stage");
        body.append(img);
        return;
      }
      if (content == null) {
        const box = el("div", "art-file");
        box.append(el("div", "art-file-name", "Too large to show here"));
        box.append(el("div", "art-file-meta", `${fmtSize(m.size)}. Download it to read it.`));
        body.classList.add("art-body-center");
        body.append(box);
        return;
      }
      if (showSource || kind === "code") {
        const lang = kind === "code" ? m.language : kind === "markdown" ? "markdown" : kind === "html" ? "html" : kind === "svg" ? "xml" : kind === "chart" ? "json" : kind === "csv" ? "" : "";
        body.classList.add("art-body-pad");
        body.append(codeBlock(content, lang));
        return;
      }
      if (kind === "markdown") {
        const doc = el("div", "art-doc md");
        renderMarkdownInto(doc, content);
        body.classList.add("art-body-pad");
        body.append(doc);
        return;
      }
      if (kind === "chart") {
        const box = el("div", "art-chart");
        renderChartInto(box, content);
        body.classList.add("art-body-pad");
        body.append(box);
        return;
      }
      if (kind === "mermaid") {
        const box = el("div", "art-diagram");
        renderMermaidInto(box, content);
        body.classList.add("art-body-pad");
        body.append(box);
        return;
      }
      if (kind === "csv") {
        body.append(csvViewer(content));
        return;
      }
      body.classList.add("art-body-pad");
      body.append(codeBlock(content, ""));
    }

    function csvViewer(content) {
      const rows = parseCsv(content);
      const wrap = el("div", "art-csv");
      if (!rows.length) { wrap.append(el("div", "art-status", "This table is empty.")); return wrap; }
      const tools = el("div", "art-csv-tools");
      const filter = el("input", "art-filter");
      filter.type = "search";
      filter.placeholder = "Filter rows";
      filter.setAttribute("aria-label", "Filter rows");
      const count = el("div", "art-count");
      tools.append(filter, count);
      const t = csvTable(rows, { sortable: true });
      const scroller = el("div", "art-csv-scroll");
      scroller.append(t.wrap);
      wrap.append(tools, scroller);
      let sortCol = -1, sortDir = 1;
      function view() {
        const q = filter.value.trim().toLowerCase();
        let list = t.body;
        if (q) list = list.filter((r) => r.some((c) => String(c).toLowerCase().includes(q)));
        if (sortCol >= 0) {
          const col = sortCol, dir = sortDir;
          list = list.slice().sort((a, b) => {
            const x = a[col] == null ? "" : a[col], y = b[col] == null ? "" : b[col];
            if (x === "" && y === "") return 0;
            if (x === "") return 1;
            if (y === "") return -1;
            const nx = numeric(x), ny = numeric(y);
            if (nx != null && ny != null) return (nx - ny) * dir;
            return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * dir;
          });
        }
        const shown = Math.min(list.length, CSV_ROW_CAP);
        t.paint(list.slice(0, CSV_ROW_CAP));
        const total = t.body.length;
        count.textContent = list.length === total
          ? `${total} ${total === 1 ? "row" : "rows"}${list.length > shown ? `, showing ${shown}` : ""}`
          : `${list.length} of ${total} rows${list.length > shown ? `, showing ${shown}` : ""}`;
        t.ths.forEach((th, i) => {
          th.setAttribute("aria-sort", i === sortCol ? (sortDir === 1 ? "ascending" : "descending") : "none");
          const mark = th.querySelector(".art-sort-mark");
          if (mark) mark.textContent = i === sortCol ? (sortDir === 1 ? " ▲" : " ▼") : "";
        });
      }
      function sortBy(i) {
        if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
        view();
      }
      t.ths.forEach((th, i) => {
        th.addEventListener("click", () => sortBy(i));
        th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(i); } });
      });
      filter.addEventListener("input", view);
      view();
      return wrap;
    }

    function applyMeta() {
      const m = state.meta;
      titleEl.textContent = m.title || "Untitled";
      kindEl.textContent = [kindWord(m), `v${state.version}`].join(" · ");
      seg.hidden = !TOGGLE_KINDS.has(m.kind);
      copyBtn.hidden = m.kind === "file";
      dlBtn.hidden = false;
      dlBtn.href = rawUrl(botId, artifactId, state.version, true);
      dlBtn.setAttribute("download", m.filename || "");
      dlBtn.textContent = sharing() ? "Share" : "Download";
      const canTab = (m.kind === "html" || m.kind === "file") && !sharing();
      tabBtn.hidden = !canTab;
      if (canTab) tabBtn.href = rawUrl(botId, artifactId, state.version);
      const vs = (m.versions || []).slice().sort((a, b) => b.v - a.v);
      versionSel.replaceChildren();
      for (const x of vs) {
        const o = el("option", "", `v${x.v}${x.at ? ` · ${fmtStamp(x.at)}` : ""}`);
        o.value = String(x.v);
        versionSel.append(o);
      }
      versionSel.value = String(state.version);
      versionSel.hidden = vs.length < 2;
    }

    async function load(v) {
      const token = ++state.token;
      status("Loading…");
      try {
        const q = v != null ? `?v=${enc(v)}` : "";
        const d = await getJson(`${base(botId, artifactId)}${q}`);
        if (token !== state.token) return;
        state.meta = d.artifact;
        state.version = d.version != null ? d.version : d.artifact.version;
        state.content = d.content;
        state.loaded = true;
        applyMeta();
        if (!TOGGLE_KINDS.has(state.meta.kind)) state.mode = "preview";
        renderBody();
      } catch (err) {
        if (token !== state.token) return;
        status(err && err.message ? err.message : "Could not load this artifact.", "art-status art-error");
      }
    }

    document.body.append(dialog);
    try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
    load(startVersion);
    return dialog;
  }

  window.RavnirArtifacts = { card, open, gallery, invalidate };
})();
