/* Mermaid diagrams for fenced ```mermaid blocks and artifacts.
   Registers RavnirBlocks.mermaid(code, container) and window.RavnirDiagrams.render(container, code).
   /vendor/mermaid.js is loaded on first use. */
(function () {
  "use strict";

  const SRC = "/vendor/mermaid.js";
  const cache = new Map(); // code -> sanitised SVG markup
  let loading = null;
  let counter = 0;

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SRC;
      s.async = true;
      s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error("mermaid missing")));
      s.onerror = () => reject(new Error("mermaid failed to load"));
      document.head.append(s);
    });
    loading.catch(() => { loading = null; });
    return loading;
  }

  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  let initTheme = null;
  function init(m) {
    const theme = isDark() ? "dark" : "neutral";
    if (initTheme === theme) return;
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "var(--sans)" });
    initTheme = theme;
  }

  function svgFrom(markup) {
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
    return document.importNode(svg, true);
  }

  function fail(figure, code) {
    figure.classList.remove("diagram-loading");
    figure.classList.add("diagram-error");
    figure.replaceChildren();
    const pre = document.createElement("pre");
    const c = document.createElement("code");
    c.textContent = code;
    pre.append(c);
    const note = document.createElement("div");
    note.className = "diagram-note";
    note.textContent = "Could not draw this diagram.";
    figure.append(pre, note);
  }

  function show(figure, markup, code) {
    const svg = svgFrom(markup);
    if (!svg) { fail(figure, code); return; }
    svg.removeAttribute("height");
    svg.style.maxWidth = "100%";
    svg.style.height = "auto";
    figure.classList.remove("diagram-loading", "diagram-error");
    figure.replaceChildren(svg);
  }

  function render(container, code) {
    const text = String(code == null ? "" : code);
    const figure = document.createElement("figure");
    figure.className = "diagram diagram-loading";
    figure.style.margin = "8px 0";
    figure.style.overflowX = "auto";
    figure.style.textAlign = "center";
    figure.dataset.theme = isDark() ? "dark" : "light";
    container.append(figure);
    const key = `${figure.dataset.theme}\n${text}`;

    if (cache.has(key)) { show(figure, cache.get(key), text); return true; }

    const hint = document.createElement("div");
    hint.className = "diagram-note";
    hint.textContent = "Drawing diagram…";
    figure.append(hint);

    loadMermaid().then(async (m) => {
      init(m);
      const id = `tb-mermaid-${++counter}`;
      try {
        const out = await m.render(id, text);
        const markup = out && out.svg ? out.svg : "";
        cache.set(key, markup);
        show(figure, markup, text);
      } catch (_) {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        fail(figure, text);
      }
    }).catch(() => fail(figure, text));
    return true;
  }

  (globalThis.RavnirBlocks ||= {}).mermaid = (code, container) => render(container, code);
  window.RavnirDiagrams = { render };
})();
