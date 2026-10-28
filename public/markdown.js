// Ravnir chat markdown: a GitHub-flavoured renderer with no dependencies.
// parse(text) is pure (no DOM) and returns JSON block nodes; render(parent, text) builds DOM with
// createElement, createElementNS, createTextNode, textContent and setAttribute only. Message text is
// untrusted, so there is no innerHTML anywhere in this file and raw HTML is shown as text.
(() => {
  const PUNCT_ASCII = /[!-/:-@[-`{-~]/;
  const PUNCT = /[\p{P}\p{S}]/u;
  const SPACE = /\s/;

  // ---------------------------------------------------------------- URL safety

  const STRIP_CTRL = /[\x00-\x20\x7f-\x9f\xad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;

  // Returns the URL to use, or "" when it is not allowed as a link.
  function safeLink(url) {
    if (typeof url !== "string") return "";
    const u = url.trim();
    if (!u || u.length > 8000) return "";
    if (/[\u0000-\u001f\u007f-\u009f\s]/.test(u)) return "";
    const probe = u.replace(STRIP_CTRL, "").toLowerCase();
    const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
    if (scheme) return ["http", "https", "mailto"].includes(scheme[1]) && probe.length > scheme[0].length ? u : "";
    if (u.startsWith("#")) return u;
    if (u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/\\")) return u;
    return "";
  }

  // Images: https, same-origin /api/ paths, or small raster data URIs.
  function safeImage(url) {
    if (typeof url !== "string") return "";
    const u = url.trim();
    if (!u || u.length > 4_000_000) return "";
    if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(u)) return u;
    if (/[\u0000-\u001f\u007f-\u009f\s]/.test(u)) return "";
    const probe = u.replace(STRIP_CTRL, "").toLowerCase();
    if (/^https:\/\/[^/\\]/.test(probe)) return u;
    if (u.startsWith("/api/")) return u;
    return "";
  }

  // ---------------------------------------------------------------- inline parsing

  function countChar(s, c) {
    let n = 0;
    for (const x of s) if (x === c) n++;
    return n;
  }

  // Finds a backtick run of exactly `run` characters at or after `from`. Returns its index or -1.
  function findCodeClose(s, from, run) {
    let k = from;
    while (k < s.length) {
      if (s[k] !== "`") { k++; continue; }
      let e = k;
      while (e < s.length && s[e] === "`") e++;
      if (e - k === run) return k;
      k = e;
    }
    return -1;
  }

  function unescapeMd(s) {
    return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }

  // How far a link may run. Without a bound, text such as "[x](" repeated makes every "[" scan to the
  // end of the reply, which is quadratic and freezes the thread on a long hostile message.
  const LINK_TEXT_MAX = 1000;
  const LINK_TAIL_MAX = 2600;

  // Index of the "]" that closes the "[" at openIdx, or -1.
  function findBracketClose(s, openIdx) {
    let depth = 0;
    const limit = Math.min(s.length, openIdx + LINK_TEXT_MAX);
    for (let k = openIdx; k < limit; k++) {
      const c = s[k];
      if (c === "\\") { k++; continue; }
      if (c === "`") {
        let e = k;
        while (e < s.length && s[e] === "`") e++;
        const close = findCodeClose(s, e, e - k);
        if (close >= 0) k = close + (e - k) - 1; else k = e - 1;
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) return k; }
    }
    return -1;
  }

  // Parses `(url "title")` starting at the "(" at p.
  function parseLinkTail(s, p) {
    const n = Math.min(s.length, p + LINK_TAIL_MAX);
    if (s[p] !== "(") return null;
    let k = p + 1;
    while (k < n && SPACE.test(s[k])) k++;
    let href;
    if (s[k] === "<") {
      const end = s.indexOf(">", k);
      if (end < 0 || end >= n || s.slice(k, end).includes("\n")) return null;
      href = s.slice(k + 1, end);
      k = end + 1;
    } else {
      let depth = 0;
      const st = k;
      while (k < n) {
        const c = s[k];
        if (c === "\\" && k + 1 < n) { k += 2; continue; }
        if (SPACE.test(c)) break;
        if (c === "(") depth++;
        else if (c === ")") { if (depth === 0) break; depth--; }
        k++;
      }
      href = s.slice(st, k);
    }
    while (k < n && SPACE.test(s[k])) k++;
    let title = "";
    const q = s[k];
    if (q === '"' || q === "'" || q === "(") {
      const closer = q === "(" ? ")" : q;
      let e = k + 1;
      while (e < n && s[e] !== closer) { if (s[e] === "\\") e++; e++; }
      if (e >= n) return null;
      title = unescapeMd(s.slice(k + 1, e));
      k = e + 1;
      while (k < n && SPACE.test(s[k])) k++;
    }
    if (s[k] !== ")") return null;
    return { href: unescapeMd(href), title, end: k + 1 };
  }

  function trimBareUrl(u) {
    for (;;) {
      const last = u[u.length - 1];
      if (last && /[.,;:!?'"*_~]/.test(last)) { u = u.slice(0, -1); continue; }
      if (last === ")" && countChar(u, ")") > countChar(u, "(")) { u = u.slice(0, -1); continue; }
      if (last === "]" && countChar(u, "]") > countChar(u, "[")) { u = u.slice(0, -1); continue; }
      break;
    }
    return u;
  }

  function tokensToNodes(toks) {
    const out = [];
    const pushText = (v) => {
      if (!v) return;
      const prev = out[out.length - 1];
      if (prev && prev.t === "text") prev.v += v; else out.push({ t: "text", v });
    };
    for (const k of toks) {
      if (k.t === "text") pushText(k.v);
      else if (k.t === "delim") pushText(k.ch.repeat(k.n));
      else out.push(k.node);
    }
    return out;
  }

  function processEmphasis(toks) {
    let i = 0;
    while (i < toks.length) {
      const c = toks[i];
      if (c.t !== "delim" || !c.close || c.n === 0) { i++; continue; }
      let found = -1;
      for (let j = i - 1; j >= 0; j--) {
        const o = toks[j];
        if (o.t === "delim" && o.ch === c.ch && o.open && o.n > 0) {
          // "rule of three": a delimiter that can both open and close needs matching lengths
          if ((o.close || c.open) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
          found = j;
          break;
        }
      }
      if (found < 0) { i++; continue; }
      const o = toks[found];
      let use;
      if (c.ch === "~") {
        if (o.n < 2 || c.n < 2) { i++; continue; }
        use = 2;
      } else use = o.n >= 2 && c.n >= 2 ? 2 : 1;
      const inner = toks.slice(found + 1, i);
      const node = { t: c.ch === "~" ? "del" : use === 2 ? "strong" : "em", c: tokensToNodes(inner) };
      o.n -= use;
      c.n -= use;
      toks.splice(found + 1, i - found - 1, { t: "node", node });
      i = found + 2;
      if (c.n === 0) i++;
    }
  }

  function inlineParse(s, opts) {
    const noLink = !!(opts && opts.noLink);
    const toks = [];
    const n = s.length;
    let buf = "";
    let i = 0;
    const flush = () => { if (buf) { toks.push({ t: "text", v: buf }); buf = ""; } };
    const pushNode = (node) => { flush(); toks.push({ t: "node", node }); };
    while (i < n) {
      const ch = s[i];
      if (ch === "\\") {
        const nx = s[i + 1];
        if (nx === "\n") { pushNode({ t: "br" }); i += 2; continue; }
        if (nx && PUNCT_ASCII.test(nx)) { buf += nx; i += 2; continue; }
        buf += ch; i++; continue;
      }
      if (ch === "\n") {
        buf = buf.replace(/ +$/, "");
        pushNode({ t: "br" });
        i++;
        continue;
      }
      if (ch === "`") {
        let e = i;
        while (e < n && s[e] === "`") e++;
        const run = e - i;
        const close = run <= 2 ? findCodeClose(s, e, run) : -1;
        if (close >= 0) {
          let code = s.slice(e, close).replace(/\n/g, " ");
          if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
          pushNode({ t: "code", v: code });
          i = close + run;
        } else {
          buf += s.slice(i, e);
          i = e;
        }
        continue;
      }
      if (ch === "!" && s[i + 1] === "[") {
        const close = findBracketClose(s, i + 1);
        const tail = close > 0 ? parseLinkTail(s, close + 1) : null;
        if (tail) {
          pushNode({ t: "img", src: tail.href, alt: inlineText(inlineParse(s.slice(i + 2, close), { noLink: true })), title: tail.title });
          i = tail.end;
          continue;
        }
      }
      if (ch === "[" && !noLink) {
        const close = findBracketClose(s, i);
        const tail = close > 0 ? parseLinkTail(s, close + 1) : null;
        if (tail) {
          pushNode({ t: "link", href: tail.href, title: tail.title, c: inlineParse(s.slice(i + 1, close), { noLink: true }) });
          i = tail.end;
          continue;
        }
      }
      if (ch === "<" && !noLink) {
        const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i, i + 2000));
        if (m) {
          pushNode({ t: "link", href: m[1], title: "", c: [{ t: "text", v: m[1] }] });
          i += m[0].length;
          continue;
        }
      }
      if ((ch === "h" || ch === "H") && !noLink && !(i > 0 && /[A-Za-z0-9]/.test(s[i - 1]))) {
        const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i, i + 4000));
        if (m) {
          const url = trimBareUrl(m[0]);
          if (/^https?:\/\/[^\s/?#]+/i.test(url)) {
            pushNode({ t: "link", href: url, title: "", c: [{ t: "text", v: url }] });
            i += url.length;
            continue;
          }
        }
      }
      if (ch === "*" || ch === "_" || ch === "~") {
        let e = i;
        while (e < n && s[e] === ch) e++;
        const run = e - i;
        if (ch === "~" && run !== 2) { buf += s.slice(i, e); i = e; continue; }
        const prev = i > 0 ? s[i - 1] : " ";
        const next = e < n ? s[e] : " ";
        const prevWs = SPACE.test(prev), nextWs = SPACE.test(next);
        const prevP = PUNCT.test(prev), nextP = PUNCT.test(next);
        const left = !nextWs && (!nextP || prevWs || prevP);
        const right = !prevWs && (!prevP || nextWs || nextP);
        let open, close;
        if (ch === "_") { open = left && (!right || prevP); close = right && (!left || nextP); }
        else { open = left; close = right; }
        flush();
        toks.push({ t: "delim", ch, n: run, orig: run, open, close });
        i = e;
        continue;
      }
      buf += ch;
      i++;
    }
    flush();
    processEmphasis(toks);
    return tokensToNodes(toks);
  }

  function inlineText(nodes) {
    let out = "";
    for (const nd of nodes) {
      if (nd.t === "text" || nd.t === "code") out += nd.v;
      else if (nd.t === "br") out += " ";
      else if (nd.t === "img") out += nd.alt || "";
      else if (nd.c) out += inlineText(nd.c);
    }
    return out;
  }

  // ---------------------------------------------------------------- block parsing

  const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
  const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE_RE = /^ {0,3}>/;
  const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
  const DELIM_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i;

  const indentOf = (l) => /^ */.exec(l)[0].length;

  function fenceOf(line) {
    const m = FENCE_RE.exec(line);
    if (!m) return null;
    if (m[2][0] === "`" && m[3].includes("`")) return null;
    return { indent: m[1].length, mark: m[2], info: m[3].trim() };
  }

  function fenceCloses(line, open) {
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    return !!m && m[1][0] === open.mark[0] && m[1].length >= open.mark.length;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
      if (c === "`") {
        let e = i;
        while (e < s.length && s[e] === "`") e++;
        const run = e - i;
        const close = findCodeClose(s, e, run);
        if (close >= 0) {
          cur += s.slice(i, close + run).replace(/\\\|/g, "|");
          i = close + run - 1;
        } else {
          cur += s.slice(i, e);
          i = e - 1;
        }
        continue;
      }
      if (c === "|") { cells.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function tableAt(lines, i) {
    if (i + 1 >= lines.length) return false;
    const head = lines[i], delim = lines[i + 1];
    if (!head.includes("|") || !delim.includes("|") || !delim.includes("-")) return false;
    if (!DELIM_RE.test(delim)) return false;
    return splitRow(head).length === splitRow(delim).length;
  }

  function isBlockStart(line) {
    if (fenceOf(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true;
    const m = LIST_RE.exec(line);
    if (m && m[4].trim()) {
      if (/\d/.test(m[2])) return parseInt(m[2], 10) === 1;
      return true;
    }
    return false;
  }

  const NUM_RE = /^\(?[-+\u2212]?[$\u20ac\u00a3]?[-+\u2212]?(?:\d+|\d{1,3}(?:[,.]\d{3})+)(?:[.,]\d+)?\s?(?:%|[kKmMbB]|x)?\)?$/;
  const SKIP_CELL = /^(?:-|\u2014|\u2013|n\/a|na)$/i;

  function isNumericCell(raw) {
    const s = String(raw).trim().replace(/^[*`_]+|[*`_]+$/g, "");
    return NUM_RE.test(s);
  }

  // For columns without explicit alignment: true when at least 70% of the non-empty cells look numeric.
  function numericColumns(width, align, rows) {
    const out = [];
    for (let c = 0; c < width; c++) {
      if (align[c]) { out.push(false); continue; }
      let total = 0, num = 0;
      for (const r of rows) {
        const v = String(r[c] ?? "").trim();
        if (!v || SKIP_CELL.test(v)) continue;
        total++;
        if (isNumericCell(v)) num++;
      }
      out.push(total > 0 && num / total >= 0.7);
    }
    return out;
  }

  function makeTable(header, align, rows) {
    const width = header.length;
    const fixed = rows.map((r) => {
      const row = r.slice(0, width);
      while (row.length < width) row.push("");
      return row;
    });
    const al = [];
    for (let c = 0; c < width; c++) al.push(align[c] || null);
    return { t: "table", header, align: al, numeric: numericColumns(width, al, fixed), rows: fixed };
  }

  function parseList(lines, start) {
    const first = LIST_RE.exec(lines[start]);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const node = { t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
    const n = lines.length;
    let i = start;
    for (;;) {
      const m = LIST_RE.exec(lines[i]);
      const spaces = m[3].length;
      const rest = m[4];
      const contentCol = m[1].length + m[2].length + (!rest.trim() || spaces > 4 ? 1 : spaces);
      const itemLines = [rest];
      i++;
      let fence = fenceOf(rest);
      while (i < n) {
        const l = lines[i];
        if (fence) {
          const d = l.slice(Math.min(indentOf(l), contentCol));
          itemLines.push(d);
          if (fenceCloses(d, fence)) fence = null;
          i++;
          continue;
        }
        if (!l.trim()) {
          let k = i + 1;
          while (k < n && !lines[k].trim()) k++;
          if (k >= n) { i = k; break; }
          if (indentOf(lines[k]) > base) {
            for (; i < k; i++) itemLines.push("");
            continue;
          }
          break;
        }
        const ind = indentOf(l);
        if (ind > base) {
          const d = l.slice(Math.min(ind, contentCol));
          itemLines.push(d);
          fence = fenceOf(d);
          i++;
          continue;
        }
        if (LIST_RE.test(l) || HR_RE.test(l) || HEADING_RE.test(l) || fenceOf(l) || QUOTE_RE.test(l)) break;
        if (itemLines[itemLines.length - 1].trim()) { itemLines.push(l.trim()); i++; continue; }
        break;
      }
      let task = null;
      const tm = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(itemLines[0]);
      if (tm) { task = tm[1] !== " "; itemLines[0] = tm[2] || ""; }
      node.items.push({ task, children: parseBlocks(itemLines) });
      let k = i;
      while (k < n && !lines[k].trim()) k++;
      if (k < n) {
        const mm = LIST_RE.exec(lines[k]);
        if (mm && mm[1].length <= base && /\d/.test(mm[2]) === ordered && !HR_RE.test(lines[k])) { i = k; continue; }
      }
      break;
    }
    return { node, next: i };
  }

  function parseBlocks(lines) {
    const out = [];
    const n = lines.length;
    let i = 0;
    while (i < n) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const f = fenceOf(line);
      if (f) {
        const code = [];
        let closed = false;
        i++;
        while (i < n) {
          if (fenceCloses(lines[i], f)) { closed = true; i++; break; }
          const l = lines[i];
          code.push(f.indent ? l.slice(Math.min(f.indent, indentOf(l))) : l);
          i++;
        }
        out.push({ t: "code", lang: f.info.split(/\s+/)[0] || "", code: code.join("\n"), closed });
        continue;
      }

      const h = HEADING_RE.exec(line);
      if (h) {
        out.push({ t: "heading", level: h[1].length, text: (h[2] || "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim() });
        i++;
        continue;
      }

      if (HR_RE.test(line)) { out.push({ t: "hr" }); i++; continue; }

      if (QUOTE_RE.test(line)) {
        const inner = [];
        while (i < n) {
          const l = lines[i];
          if (QUOTE_RE.test(l)) { inner.push(l.replace(/^ {0,3}> ?/, "")); i++; continue; }
          if (l.trim() && inner.length && inner[inner.length - 1].trim() && !isBlockStart(l) && !tableAt(lines, i)) { inner.push(l); i++; continue; }
          break;
        }
        const co = CALLOUT_RE.exec(inner[0] || "");
        if (co) {
          if (co[2]) inner[0] = co[2]; else inner.shift();
          out.push({ t: "callout", kind: co[1].toLowerCase(), children: parseBlocks(inner) });
        } else out.push({ t: "quote", children: parseBlocks(inner) });
        continue;
      }

      if (LIST_RE.test(line)) {
        const r = parseList(lines, i);
        out.push(r.node);
        i = r.next;
        continue;
      }

      if (tableAt(lines, i)) {
        const header = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => {
          const l = c.startsWith(":"), r = c.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : null;
        });
        const rows = [];
        i += 2;
        while (i < n && lines[i].trim() && lines[i].includes("|") && !fenceOf(lines[i]) && !QUOTE_RE.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(makeTable(header, align, rows));
        continue;
      }

      const para = [line.trim()];
      i++;
      while (i < n) {
        const l = lines[i];
        if (!l.trim() || isBlockStart(l) || tableAt(lines, i)) break;
        para.push(l.trim());
        i++;
      }
      out.push({ t: "para", text: para.join("\n") });
    }
    return out;
  }

  // ---------------------------------------------------------------- parse cache

  const CACHE_MAX = 300;
  const cache = new Map();

  function parse(text) {
    const src = String(text ?? "").replace(/\r\n?/g, "\n");
    const cacheable = src.length <= 200_000;
    if (cacheable && cache.has(src)) {
      const hit = cache.get(src);
      cache.delete(src);
      cache.set(src, hit);
      return hit;
    }
    const blocks = parseBlocks(src.split("\n"));
    if (cacheable) {
      cache.set(src, blocks);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return blocks;
  }

  // ---------------------------------------------------------------- one-line preview

  function blockText(b) {
    switch (b.t) {
      case "heading": case "para": return inlineText(inlineParse(b.text));
      case "code": return b.code;
      case "quote": case "callout": return b.children.map(blockText).join(" ");
      case "list": return b.items.map((it) => it.children.map(blockText).join(" ")).join(" ");
      case "table": return [b.header, ...b.rows].map((r) => r.map((c) => inlineText(inlineParse(c))).join(" ")).join(" ");
      default: return "";
    }
  }

  function plain(text) {
    return parse(text).map(blockText).join(" ").replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------- DOM rendering

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.setAttribute("class", cls);
    if (text != null) e.textContent = text;
    return e;
  }

  function copyText(text, btn, idle) {
    const done = () => {
      btn.textContent = "Copied";
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => { btn.textContent = idle; }, 1200);
    };
    const fallback = () => {
      try {
        const doc = btn.ownerDocument;
        const ta = doc.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.setAttribute("style", "position:fixed;opacity:0;top:0;left:0");
        doc.body.appendChild(ta);
        ta.select();
        const ok = doc.execCommand("copy");
        ta.remove();
        if (ok) done();
      } catch { /* clipboard unavailable */ }
    };
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch { fallback(); }
  }

  function copyButton(doc, getText, idle = "Copy") {
    const btn = el(doc, "button", "md-copy", idle);
    btn.setAttribute("type", "button");
    btn.addEventListener("click", () => copyText(getText(), btn, idle));
    return btn;
  }

  const CALLOUT_ICONS = {
    note: ["M8 7.3v3.7", "M8 5.1h.01", "circle"],
    tip: ["M8 1.9a4.2 4.2 0 0 0-2.3 7.7c.4.3.6.8.6 1.2v.4h3.4v-.4c0-.4.2-.9.6-1.2A4.2 4.2 0 0 0 8 1.9z", "M6.5 13.1h3"],
    important: ["M2.5 3h11v7.5H9L6 13.2v-2.7H2.5z", "M8 5.3v2.4", "M8 9h.01"],
    warning: ["M8 2.3l6 10.6H2z", "M8 6.7v2.7", "M8 11.3h.01"],
    caution: ["M5.2 2h5.6L14 5.2v5.6L10.8 14H5.2L2 10.8V5.2z", "M8 5.4v3", "M8 10.9h.01"],
  };
  const CALLOUT_TITLES = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

  function calloutIcon(doc, kind) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    for (const [k, v] of [["viewBox", "0 0 16 16"], ["width", "16"], ["height", "16"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.4"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["class", "md-callout-icon"]]) svg.setAttribute(k, v);
    for (const d of CALLOUT_ICONS[kind]) {
      if (d === "circle") {
        const c = doc.createElementNS(SVG_NS, "circle");
        c.setAttribute("cx", "8"); c.setAttribute("cy", "8"); c.setAttribute("r", "6.2");
        svg.appendChild(c);
      } else {
        const p = doc.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        svg.appendChild(p);
      }
    }
    return svg;
  }

  function renderInlineNodes(doc, parent, nodes, ctx) {
    for (const nd of nodes) {
      switch (nd.t) {
        case "text": parent.appendChild(doc.createTextNode(nd.v)); break;
        case "br": parent.appendChild(doc.createElement("br")); break;
        case "code": parent.appendChild(el(doc, "code", null, nd.v)); break;
        case "strong": case "em": {
          const e = doc.createElement(nd.t);
          renderInlineNodes(doc, e, nd.c, ctx);
          parent.appendChild(e);
          break;
        }
        case "del": {
          const e = doc.createElement("del");
          renderInlineNodes(doc, e, nd.c, ctx);
          parent.appendChild(e);
          break;
        }
        case "link": {
          const href = safeLink(nd.href);
          if (!href) { renderInlineNodes(doc, parent, nd.c, ctx); break; }
          const a = doc.createElement("a");
          a.setAttribute("href", href);
          if (nd.title) a.setAttribute("title", nd.title);
          if (/^https?:/i.test(href)) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer");
          }
          renderInlineNodes(doc, a, nd.c.length ? nd.c : [{ t: "text", v: href }], { inLink: true });
          parent.appendChild(a);
          break;
        }
        case "img": {
          const src = safeImage(nd.src);
          if (!src) {
            const href = safeLink(nd.src);
            if (href) renderInlineNodes(doc, parent, [{ t: "link", href: nd.src, title: nd.title, c: [{ t: "text", v: nd.alt || nd.src }] }], ctx);
            else parent.appendChild(doc.createTextNode(nd.alt || ""));
            break;
          }
          const img = doc.createElement("img");
          img.setAttribute("class", "md-img");
          img.setAttribute("src", src);
          img.setAttribute("alt", nd.alt || "");
          if (nd.title) img.setAttribute("title", nd.title);
          img.setAttribute("loading", "lazy");
          img.setAttribute("decoding", "async");
          // Browsers refuse top-level navigation to data: URLs, so those are not wrapped in a link.
          if ((ctx && ctx.inLink) || src.startsWith("data:")) parent.appendChild(img);
          else {
            const a = el(doc, "a", "md-img-link");
            a.setAttribute("href", src);
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer");
            a.appendChild(img);
            parent.appendChild(a);
          }
          break;
        }
        default: break;
      }
    }
  }

  function renderInline(doc, parent, text) {
    renderInlineNodes(doc, parent, inlineParse(String(text)), null);
  }

  function renderCodeBlock(doc, parent, code, lang) {
    const fig = el(doc, "figure", "md-code");
    const head = el(doc, "div", "md-code-head");
    head.appendChild(el(doc, "span", "md-code-lang", lang ? lang.slice(0, 24) : "code"));
    head.appendChild(copyButton(doc, () => code));
    fig.appendChild(head);
    const pre = doc.createElement("pre");
    const codeEl = doc.createElement("code");
    const safeLang = (lang || "").replace(/[^\w+#.-]/g, "").slice(0, 24);
    if (safeLang) codeEl.setAttribute("class", `language-${safeLang}`);
    let done = false;
    const hl = globalThis.RavnirHighlight;
    if (hl && typeof hl.render === "function") {
      try {
        const frag = hl.render(code, lang);
        if (frag) { codeEl.appendChild(frag); done = true; }
      } catch { codeEl.textContent = ""; }
    }
    if (!done) codeEl.textContent = code;
    pre.appendChild(codeEl);
    fig.appendChild(pre);
    parent.appendChild(fig);
  }

  const TABLE_ROW_LIMIT = 30;
  const TABLE_ROW_SHOWN = 20;

  // header, rows: arrays of raw cell strings. align: explicit alignments. opts.literal: cells are plain text.
  function renderTable(doc, parent, header, align, numeric, rows, opts) {
    const literal = !!(opts && opts.literal);
    const box = el(doc, "div", "md-table-box");
    const bar = el(doc, "div", "md-table-bar");
    const tsv = () => [header, ...rows].map((r) => r.map((c) => (literal ? String(c) : inlineText(inlineParse(String(c)))).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
    bar.appendChild(copyButton(doc, tsv, "Copy table"));
    box.appendChild(bar);
    const wrap = el(doc, "div", "md-table-wrap");
    const table = el(doc, "table", "md-table");
    const cls = (c) => (align[c] ? `md-al-${align[c]}` : numeric[c] ? "md-al-right md-num" : "");
    const fill = (cell, c, raw) => {
      const k = cls(c);
      if (k) cell.setAttribute("class", k);
      if (literal) cell.textContent = String(raw);
      else renderInline(doc, cell, raw);
    };
    const thead = doc.createElement("thead");
    const hr = doc.createElement("tr");
    header.forEach((h, c) => { const th = doc.createElement("th"); th.setAttribute("scope", "col"); fill(th, c, h); hr.appendChild(th); });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = doc.createElement("tbody");
    const collapsed = rows.length > TABLE_ROW_LIMIT;
    const hidden = [];
    rows.forEach((r, ri) => {
      const tr = doc.createElement("tr");
      r.forEach((v, c) => { const td = doc.createElement("td"); fill(td, c, v); tr.appendChild(td); });
      if (collapsed && ri >= TABLE_ROW_SHOWN) { tr.setAttribute("hidden", ""); hidden.push(tr); }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
    if (collapsed) {
      const more = el(doc, "button", "md-more", `Show all ${rows.length} rows`);
      more.setAttribute("type", "button");
      more.addEventListener("click", () => {
        for (const tr of hidden) tr.removeAttribute("hidden");
        more.remove();
      });
      box.appendChild(more);
    }
    parent.appendChild(box);
  }

  function renderBlocks(doc, parent, blocks, state) {
    for (const b of blocks) renderBlock(doc, parent, b, state);
  }

  function renderBlock(doc, parent, b, state) {
    switch (b.t) {
      case "heading": {
        const h = el(doc, `h${b.level}`, `md-h${b.level}`);
        renderInline(doc, h, b.text);
        parent.appendChild(h);
        break;
      }
      case "para": {
        const p = doc.createElement("p");
        renderInline(doc, p, b.text);
        parent.appendChild(p);
        break;
      }
      case "hr": parent.appendChild(el(doc, "hr", "md-hr")); break;
      case "quote": {
        const q = el(doc, "blockquote", "md-quote");
        renderBlocks(doc, q, b.children, state);
        parent.appendChild(q);
        break;
      }
      case "callout": {
        const box = el(doc, "div", `md-callout md-callout-${b.kind}`);
        const title = el(doc, "div", "md-callout-title");
        title.appendChild(calloutIcon(doc, b.kind));
        title.appendChild(el(doc, "span", null, CALLOUT_TITLES[b.kind]));
        box.appendChild(title);
        const body = el(doc, "div", "md-callout-body");
        renderBlocks(doc, body, b.children, state);
        box.appendChild(body);
        parent.appendChild(box);
        break;
      }
      case "list": {
        const list = doc.createElement(b.ordered ? "ol" : "ul");
        list.setAttribute("class", "md-list");
        if (b.ordered && b.start !== 1) list.setAttribute("start", String(b.start));
        for (const it of b.items) {
          const li = doc.createElement("li");
          if (it.task !== null) {
            li.setAttribute("class", "md-task");
            const cb = doc.createElement("input");
            cb.setAttribute("type", "checkbox");
            cb.setAttribute("disabled", "");
            if (it.task) cb.setAttribute("checked", "");
            li.appendChild(cb);
          }
          let rest = it.children;
          if (rest.length && rest[0].t === "para") {
            renderInline(doc, li, rest[0].text);
            rest = rest.slice(1);
          }
          renderBlocks(doc, li, rest, state);
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
      case "table":
        renderTable(doc, parent, b.header, b.align, b.numeric, b.rows, null);
        state.rich = true;
        break;
      case "code": {
        const lang = b.lang.toLowerCase();
        const handlers = globalThis.RavnirBlocks;
        const handler = handlers && Object.prototype.hasOwnProperty.call(handlers, lang) ? handlers[lang] : null;
        if (typeof handler === "function" && b.closed) {
          const box = el(doc, "div", "md-block");
          parent.appendChild(box);
          let ok = false;
          const index = state.blocks++;
          const context = { ...state.context, streaming: state.streaming, key: state.context.key ? `${state.context.key}#${index}` : "" };
          try { ok = !!handler(b.code, box, context); } catch { ok = false; }
          if (ok) { state.rich = true; break; }
          box.remove();
        }
        renderCodeBlock(doc, parent, b.code, b.lang);
        state.rich = true;
        break;
      }
      default: break;
    }
  }

  // Past this size a reply is shown as plain text: formatting a huge message on every poll is not worth
  // freezing the thread for.
  const RENDER_MAX = 80_000;

  function render(parent, text, { streaming = false, context = {} } = {}) {
    const doc = parent.ownerDocument || globalThis.document;
    parent.classList.add("md");
    if (String(text || "").length > RENDER_MAX) {
      const pre = doc.createElement("div");
      pre.className = "md-plain";
      pre.textContent = String(text);
      parent.appendChild(pre);
      return { rich: false };
    }
    // context reaches block handlers: choice cards read key, answer and live from it.
    const state = { rich: false, streaming: !!streaming, context: context || {}, blocks: 0 };
    renderBlocks(doc, parent, parse(text), state);
    return { rich: state.rich };
  }

  // ---------------------------------------------------------------- csv and tsv blocks

  function parseDelimited(text, sep) {
    const rows = [];
    let row = [], cur = "", q = false, started = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
        continue;
      }
      if (c === '"' && cur === "" && !started) { q = true; started = true; continue; }
      if (c === sep) { row.push(cur); cur = ""; started = false; continue; }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur);
        rows.push(row);
        row = []; cur = ""; started = false;
        continue;
      }
      cur += c;
    }
    if (cur !== "" || row.length || started) { row.push(cur); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  }

  function delimitedHandler(sep) {
    return (code, container) => {
      const rows = parseDelimited(code, sep);
      if (!rows.length || rows.length > 5000) return false;
      const width = Math.min(200, Math.max(...rows.map((r) => r.length)));
      if (width < 1) return false;
      const pad = (r) => { const x = r.slice(0, width); while (x.length < width) x.push(""); return x; };
      const header = pad(rows[0]);
      const body = rows.slice(1).map(pad);
      const t = makeTable(header, [], body);
      renderTable(container.ownerDocument, container, header, t.align, t.numeric, t.rows, { literal: true });
      return true;
    };
  }

  const blocks = (globalThis.RavnirBlocks ||= {});
  if (!blocks.csv) blocks.csv = delimitedHandler(",");
  if (!blocks.tsv) blocks.tsv = delimitedHandler("\t");

  const api = { parse, render, plain, inline: inlineParse, inlineText, safeLink, safeImage, renderInline };
  if (typeof window !== "undefined") window.RavnirMarkdown = api;
  if (typeof globalThis !== "undefined") globalThis.RavnirMarkdown = api;
})();
