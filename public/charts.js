// Ravnir charts: a JSON spec in, a clean inline SVG chart out. Used by ```chart code blocks in
// chat and by saved chart artifacts. Plain browser script, no dependencies. normalize() and
// format() run without a DOM; render() needs one. Styles: public/charts.css.
(() => {
  const TYPES = ["bar", "hbar", "stacked", "line", "area", "pie", "donut"];
  const TYPE_NAMES = {
    bar: "Bar chart", hbar: "Horizontal bar chart", stacked: "Stacked bar chart",
    line: "Line chart", area: "Area chart", pie: "Pie chart", donut: "Donut chart",
  };
  const MAX_LABELS = 200;
  const MAX_SERIES = 8;
  const MAX_SLICES = 8;
  const MAX_LABEL = 120;
  const MAX_NAME = 60;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const NO_VALUE = "no value";
  const FALLBACK_WIDTH = 600;
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 720;
  const HEIGHT = 240;
  const ROW_H = 26;
  const CHAR_W = 6.4; // rough advance of 11px system text, used only to reserve room for labels
  const PREFIX_UNITS = ["$", "€", "£"];
  const DOT_MAX = 40; // above this many points, lines carry no dots
  const ROT_DEG = 35;
  const RADIUS = 4;

  class SpecError extends Error {}
  const bad = (message) => { throw new SpecError(message); };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const textW = (s) => String(s).length * CHAR_W;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const roundTo = (x) => Number(x.toPrecision(12));

  function optText(value, name, max) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") bad(`${name} must be text.`);
    const t = value.trim();
    if (t.length > max) bad(`${name} must be ${max} characters or fewer.`);
    return t || undefined;
  }

  // Validates a spec (object or JSON string) and returns a clean copy. Throws SpecError only.
  function build(input) {
    let raw = input;
    if (typeof input === "string") {
      try { raw = JSON.parse(input); } catch (_) { bad("The chart is not valid JSON."); }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("The chart must be a JSON object.");
    if (raw.type === undefined) bad(`The chart type is missing. Use one of: ${TYPES.join(", ")}.`);
    if (!TYPES.includes(raw.type)) bad(`Unknown chart type "${String(raw.type)}". Use one of: ${TYPES.join(", ")}.`);
    const radial = raw.type === "pie" || raw.type === "donut";

    if (!Array.isArray(raw.labels) || raw.labels.length === 0) bad("labels must be a list with 1 to 200 entries.");
    if (raw.labels.length > MAX_LABELS) bad(`labels can hold at most ${MAX_LABELS} entries.`);
    const labels = raw.labels.map((label, i) => {
      if (typeof label !== "string" || !label.trim()) bad(`Label ${i + 1} must be text.`);
      if (label.trim().length > MAX_LABEL) bad(`Label ${i + 1} must be ${MAX_LABEL} characters or fewer.`);
      return label.trim();
    });
    if (radial && labels.length > MAX_SLICES) bad(`A ${raw.type} chart can show at most ${MAX_SLICES} slices.`);

    if (!Array.isArray(raw.series) || raw.series.length === 0) bad("series must list 1 to 8 series.");
    if (raw.series.length > MAX_SERIES) bad(`A chart can have at most ${MAX_SERIES} series.`);
    // Pie and donut draw only the first series.
    const source = radial ? raw.series.slice(0, 1) : raw.series;
    const series = source.map((s, i) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) bad(`Series ${i + 1} must be an object with a name and data.`);
      const name = optText(s.name, `Series ${i + 1} name`, MAX_NAME);
      if (!name) bad(`Series ${i + 1} needs a name.`);
      if (!Array.isArray(s.data)) bad(`Series "${name}" needs a data list.`);
      if (s.data.length !== labels.length) {
        bad(`Series "${name}" has ${s.data.length} values but there are ${labels.length} labels.`);
      }
      const data = s.data.map((v, j) => {
        if (v === null) return null;
        if (!isNum(v)) bad(`Series "${name}" value ${j + 1} must be a number or null.`);
        if ((radial || raw.type === "stacked") && v < 0) {
          bad(`${radial ? "Pie and donut" : "Stacked"} values must be zero or more.`);
        }
        return v;
      });
      return { name, data };
    });
    if (radial && series[0].data.reduce((sum, v) => sum + (v || 0), 0) <= 0) {
      bad("A pie or donut needs at least one value above zero.");
    }

    const spec = { type: raw.type, labels, series };
    spec.title = optText(raw.title, "title", 120);
    spec.subtitle = optText(raw.subtitle, "subtitle", 160);
    spec.note = optText(raw.note, "note", 300);
    spec.unit = optText(raw.unit, "unit", 8);
    if (raw.decimals !== undefined && raw.decimals !== null) {
      if (!Number.isInteger(raw.decimals) || raw.decimals < 0 || raw.decimals > 4) {
        bad("decimals must be a whole number from 0 to 4.");
      }
      spec.decimals = raw.decimals;
    }
    for (const key of ["yMin", "yMax"]) {
      if (raw[key] === undefined || raw[key] === null) continue;
      if (!isNum(raw[key])) bad(`${key} must be a number.`);
      spec[key] = raw[key];
    }
    if (spec.yMin !== undefined && spec.yMax !== undefined && spec.yMin >= spec.yMax) {
      bad("yMin must be lower than yMax.");
    }
    return spec;
  }

  function normalize(input) {
    try {
      return { ok: true, spec: build(input) };
    } catch (err) {
      if (err instanceof SpecError) return { ok: false, error: err.message };
      return { ok: false, error: "The chart could not be read." };
    }
  }

  // Digits after the point for auto formatting. Compact values (k, M, B) keep one digit under 10.
  function autoDigits(x, compact) {
    if (compact) return x < 10 ? 1 : 0;
    if (x >= 100) return 0;
    if (x >= 10) return 1;
    if (x >= 1) return 2;
    if (x >= 0.01) return 3;
    return 4;
  }

  // Compact number text with the unit applied. "$" "€" "£" are prefixes, "%" a suffix with no
  // space, any other unit a suffix with a space. Respects spec.decimals when given.
  function format(value, spec = {}) {
    if (!isNum(value)) return NO_VALUE;
    const unit = spec.unit || "";
    const abs = Math.abs(value);
    let div = 1;
    let suffix = "";
    if (abs >= 1e9) { div = 1e9; suffix = "B"; }
    else if (abs >= 1e6) { div = 1e6; suffix = "M"; }
    else if (abs >= 1e3) { div = 1e3; suffix = "k"; }
    const scaled = abs / div;
    const body = Number.isInteger(spec.decimals)
      ? scaled.toFixed(spec.decimals)
      : String(Number(scaled.toFixed(autoDigits(scaled, suffix !== ""))));
    const sign = value < 0 && Number(body) !== 0 ? "-" : "";
    const num = `${sign}${body}${suffix}`;
    if (!unit) return num;
    if (PREFIX_UNITS.includes(unit)) return `${sign}${unit}${body}${suffix}`;
    if (unit === "%") return `${num}%`;
    return `${num} ${unit}`;
  }

  function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range));
    const f = range / 10 ** exp;
    let nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * 10 ** exp;
  }

  // Domain and round tick values for a value axis (about four intervals).
  function niceScale(values, { includeZero, yMin, yMax }) {
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 1;
    if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (yMin !== undefined) lo = yMin;
    if (yMax !== undefined) hi = yMax;
    if (lo === hi) {
      if (lo === 0) hi = 1;
      else {
        const pad = Math.abs(lo) * 0.1;
        if (yMin === undefined) lo -= pad;
        if (yMax === undefined) hi += pad;
      }
    }
    const step = niceNum((hi - lo) / 4, true);
    if (yMin === undefined) lo = Math.floor(lo / step) * step;
    if (yMax === undefined) hi = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let k = Math.ceil(lo / step - 1e-9); k <= Math.floor(hi / step + 1e-9); k++) {
      ticks.push(roundTo(k * step));
    }
    return { lo, hi, ticks };
  }

  // ---- SVG helpers (DOM only, called from render)

  function svgEl(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  function html(name, className, text, parent) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function svgText(svg, x, y, text, attrs) {
    const node = svgEl("text", { x, y, ...attrs }, svg);
    node.textContent = text;
    return node;
  }

  // Bar with a rounded data end (top or right) and a square baseline end.
  function barPathV(x, w, y0, y1, r) {
    const rr = Math.max(0, Math.min(r, w / 2, Math.abs(y1 - y0)));
    if (y1 <= y0) {
      return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
    }
    return `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`;
  }

  function barPathH(x0, y, x1, h, r) {
    const rr = Math.max(0, Math.min(r, Math.abs(x1 - x0), h / 2));
    if (x1 >= x0) {
      return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
    }
    return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
  }

  // Pointer position in viewBox units. The SVG renders at its viewBox width, so one scale fits both axes.
  function localPoint(svg, e, W) {
    const r = svg.getBoundingClientRect();
    if (!r.width) return null;
    const k = W / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  // Dims every mark except the hovered index.
  function dim(svg, idx) {
    svg.querySelectorAll("[data-i]").forEach((el) => {
      el.style.opacity = idx == null || el.getAttribute("data-i") === String(idx) ? "" : "0.5";
    });
  }

  // Category bars, lines and areas. Returns { height, indexAt, highlight }.
  function drawCartesian(spec, W, svg) {
    const { labels, series } = spec;
    const n = labels.length;
    const H = HEIGHT;
    const stacked = spec.type === "stacked";
    const lineish = spec.type === "line" || spec.type === "area";

    const values = [];
    if (stacked) {
      for (let i = 0; i < n; i++) {
        let pos = 0;
        let neg = 0;
        for (const s of series) {
          const v = s.data[i];
          if (v === null) continue;
          if (v >= 0) pos += v; else neg += v;
        }
        values.push(pos, neg);
      }
    } else {
      for (const s of series) for (const v of s.data) if (v !== null) values.push(v);
    }
    const scale = niceScale(values, {
      includeZero: !lineish || spec.type === "area",
      yMin: spec.yMin,
      yMax: spec.yMax,
    });
    const maxTickW = Math.max(...scale.ticks.map((t) => textW(format(t, spec))));
    const maxLabelW = Math.max(...labels.map(textW));
    const plotL = Math.max(40, Math.ceil(maxTickW) + 14);
    const plotR = W - 12;
    const plotT = 14;
    const slot = (plotR - plotL) / n;

    let mode = "flat";
    let every = 1;
    if (maxLabelW + 6 > slot) {
      if (n <= 12 && slot >= 12) mode = "rotate";
      else { mode = "thin"; every = Math.ceil((maxLabelW + 8) / slot); }
    }
    let bottom = 26;
    if (mode === "rotate") {
      bottom = Math.ceil(maxLabelW * Math.sin((ROT_DEG * Math.PI) / 180)) + 16;
      if (bottom > 110) { mode = "thin"; every = Math.ceil((maxLabelW + 8) / slot); bottom = 26; }
    }
    const plotB = H - bottom;
    const yOf = (v) => plotB - ((v - scale.lo) / (scale.hi - scale.lo)) * (plotB - plotT);
    const xOf = (i) => plotL + (i + 0.5) * slot;
    const base = yOf(clamp(0, scale.lo, scale.hi));

    for (const t of scale.ticks) {
      const y = yOf(t);
      svgEl("line", { class: t === 0 ? "tb-baseline" : "tb-grid", x1: plotL, x2: plotR, y1: y, y2: y }, svg);
      svgText(svg, plotL - 8, y + 4, format(t, spec), { "text-anchor": "end" });
    }

    for (let i = 0; i < n; i++) {
      if (mode === "thin" && i % every !== 0) continue;
      if (mode === "rotate") {
        const x = xOf(i);
        svgText(svg, x, plotB + 12, labels[i], {
          "text-anchor": "end", transform: `rotate(-${ROT_DEG} ${x} ${plotB + 12})`,
        });
      } else {
        svgText(svg, xOf(i), plotB + 17, labels[i], { "text-anchor": "middle" });
      }
    }

    if (stacked) {
      const groupW = Math.min(slot * 0.76, 56);
      for (let i = 0; i < n; i++) {
        let topIdx = -1;
        series.forEach((s, j) => { if (s.data[i] !== null && s.data[i] > 0) topIdx = j; });
        let cum = 0;
        series.forEach((s, j) => {
          const v = s.data[i];
          if (v === null || v === 0) return;
          const y0 = yOf(cum);
          const y1 = yOf(cum + v);
          cum += v;
          svgEl("path", {
            class: "tb-mark", "data-s": j + 1, "data-i": i,
            d: barPathV(xOf(i) - groupW / 2, groupW, y0, y1, j === topIdx ? RADIUS : 0),
          }, svg);
        });
      }
    } else if (spec.type === "bar") {
      const groupW = Math.min(slot * 0.76, 36 * series.length);
      const barW = groupW / series.length;
      for (let i = 0; i < n; i++) {
        series.forEach((s, j) => {
          const v = s.data[i];
          if (v === null) return;
          svgEl("path", {
            class: "tb-mark", "data-s": j + 1, "data-i": i,
            d: barPathV(xOf(i) - groupW / 2 + j * barW, barW, base, yOf(v), RADIUS),
          }, svg);
        });
      }
    } else {
      // line and area: segments break at null, areas fill down to the zero baseline.
      series.forEach((s, j) => {
        const pts = s.data.map((v, i) => (v === null ? null : [xOf(i), yOf(v)]));
        const segs = [];
        let cur = [];
        pts.forEach((p, i) => {
          if (p) cur.push([i, p]);
          else if (cur.length) { segs.push(cur); cur = []; }
        });
        if (cur.length) segs.push(cur);
        if (spec.type === "area") {
          for (const seg of segs) {
            const first = seg[0][1][0];
            const last = seg[seg.length - 1][1][0];
            const line = seg.map(([, p]) => `L${p[0]},${p[1]}`).join("");
            svgEl("path", {
              class: "tb-area", "data-s": j + 1,
              d: `M${first},${base}${line}L${last},${base}Z`,
            }, svg);
          }
        }
        for (const seg of segs) {
          const d = seg.map(([, p], k) => `${k === 0 ? "M" : "L"}${p[0]},${p[1]}`).join("");
          svgEl("path", { class: "tb-line", "data-s": j + 1, d }, svg);
        }
        if (n <= DOT_MAX) {
          pts.forEach((p, i) => {
            if (p) svgEl("circle", { class: "tb-dot", "data-s": j + 1, "data-i": i, cx: p[0], cy: p[1], r: 4 }, svg);
          });
        }
      });
    }

    const cross = lineish
      ? svgEl("line", { class: "tb-cross", x1: 0, x2: 0, y1: plotT, y2: plotB, visibility: "hidden" }, svg)
      : null;

    return {
      height: H,
      indexAt: (e) => {
        const p = localPoint(svg, e, W);
        if (!p || p.x < plotL || p.x > plotR) return null;
        return clamp(Math.floor((p.x - plotL) / slot), 0, n - 1);
      },
      highlight: (idx) => {
        dim(svg, idx);
        if (!cross) return;
        if (idx == null) { cross.setAttribute("visibility", "hidden"); return; }
        cross.setAttribute("x1", xOf(idx));
        cross.setAttribute("x2", xOf(idx));
        cross.setAttribute("visibility", "visible");
      },
    };
  }

  // Horizontal bars for rankings and long labels. One row per label; grows with the label count.
  function drawHorizontal(spec, W, svg) {
    const { labels, series } = spec;
    const n = labels.length;
    const multi = series.length > 1;
    const top = 6;
    const bottomPad = 24;
    const H = top + n * ROW_H + bottomPad;
    const plotB = H - bottomPad;

    const values = [];
    for (const s of series) for (const v of s.data) if (v !== null) values.push(v);
    const scale = niceScale(values, { includeZero: true, yMin: spec.yMin, yMax: spec.yMax });
    const labelBox = Math.min(W * 0.4, Math.max(...labels.map(textW)) + 4);
    const plotL = Math.ceil(labelBox) + 14;
    const valueRoom = multi ? 8 : Math.max(0, ...values.map((v) => textW(format(v, spec)))) + 14;
    const plotR = Math.max(plotL + 40, W - 10 - valueRoom);
    const xOf = (v) => plotL + ((v - scale.lo) / (scale.hi - scale.lo)) * (plotR - plotL);
    const x0 = xOf(clamp(0, scale.lo, scale.hi));

    for (const t of scale.ticks) {
      const x = xOf(t);
      svgEl("line", { class: t === 0 ? "tb-baseline" : "tb-grid", x1: x, x2: x, y1: top, y2: plotB }, svg);
      svgText(svg, x, H - 7, format(t, spec), { "text-anchor": "middle" });
    }

    const maxChars = Math.max(4, Math.floor((labelBox - 6) / CHAR_W));
    const thick = Math.min(14, (ROW_H - 8) / series.length);
    labels.forEach((label, i) => {
      const rowY = top + i * ROW_H;
      const shown = label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
      svgText(svg, plotL - 8, rowY + ROW_H / 2 + 4, shown, { "text-anchor": "end", class: "tb-rowlabel" });
      series.forEach((s, j) => {
        const v = s.data[i];
        if (v === null) return;
        const y = rowY + (ROW_H - thick * series.length) / 2 + j * thick;
        svgEl("path", {
          class: "tb-mark", "data-s": j + 1, "data-i": i,
          d: barPathH(x0, y, xOf(v), thick, RADIUS),
        }, svg);
        if (!multi) {
          const vx = xOf(v) + (v >= 0 ? 6 : -6);
          svgText(svg, vx, y + thick / 2 + 4, format(v, spec), {
            "text-anchor": v >= 0 ? "start" : "end", class: "tb-value",
          });
        }
      });
    });

    return {
      height: H,
      indexAt: (e) => {
        const p = localPoint(svg, e, W);
        if (!p || p.y < top) return null;
        const i = Math.floor((p.y - top) / ROW_H);
        return i >= 0 && i < n ? i : null;
      },
      highlight: (idx) => dim(svg, idx),
    };
  }

  // Pie and donut, first series only. Slices are colored by label order.
  function drawRadial(spec, W, svg) {
    const H = HEIGHT;
    const data = spec.series[0].data;
    const total = data.reduce((sum, v) => sum + (v || 0), 0);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 8;
    const donut = spec.type === "donut";
    const inner = donut ? R * 0.6 : 0;
    const at = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    let angle = -Math.PI / 2;

    data.forEach((v, i) => {
      if (!v) return;
      const span = (v / total) * 2 * Math.PI;
      const parts = Math.ceil(span / Math.PI - 1e-9); // each arc at most a half turn
      for (let k = 0; k < parts; k++) {
        const a = angle + (span * k) / parts;
        const b = angle + (span * (k + 1)) / parts;
        const [x1, y1] = at(R, a);
        const [x2, y2] = at(R, b);
        let d;
        if (donut) {
          const [x3, y3] = at(inner, b);
          const [x4, y4] = at(inner, a);
          d = `M${x1},${y1}A${R},${R} 0 0 1 ${x2},${y2}L${x3},${y3}A${inner},${inner} 0 0 0 ${x4},${y4}Z`;
        } else {
          d = `M${cx},${cy}L${x1},${y1}A${R},${R} 0 0 1 ${x2},${y2}Z`;
        }
        svgEl("path", { class: "tb-mark", "data-s": i + 1, "data-i": i, d }, svg);
      }
      angle += span;
    });

    if (donut) {
      svgText(svg, cx, cy - 2, "Total", { "text-anchor": "middle", class: "tb-center-label" });
      svgText(svg, cx, cy + 18, format(total, spec), { "text-anchor": "middle", class: "tb-center-value" });
    }

    return {
      height: H,
      indexAt: (e) => {
        const v = e.target && e.target.getAttribute ? e.target.getAttribute("data-i") : null;
        return v === null ? null : Number(v);
      },
      highlight: (idx) => dim(svg, idx),
    };
  }

  function describe(spec) {
    const radial = spec.type === "pie" || spec.type === "donut";
    const head = `${TYPE_NAMES[spec.type]}${spec.title ? `: ${spec.title}` : ""}.`;
    const pairs = (values) => {
      const n = spec.labels.length;
      if (n <= 12) return spec.labels.map((l, i) => `${l} ${format(values[i], spec)}`).join(", ");
      let hi = -1;
      let lo = -1;
      values.forEach((v, i) => {
        if (v === null) return;
        if (hi < 0 || v > values[hi]) hi = i;
        if (lo < 0 || v < values[lo]) lo = i;
      });
      if (hi < 0) return `${n} values, none set`;
      return `highest ${spec.labels[hi]} ${format(values[hi], spec)}, lowest ${spec.labels[lo]} ${format(values[lo], spec)}, ${n} values`;
    };
    if (radial) return `${head} ${pairs(spec.series[0].data)}.`;
    return `${head} ${spec.series.map((s) => `${s.name}: ${pairs(s.data)}`).join(". ")}.`;
  }

  // Chat renders replies off-screen first, so a chart often cannot measure itself yet. It starts at the
  // last real width seen (charts in one thread share a width) and redraws once it is on the page.
  let knownWidth = 0;
  function measure(container) {
    const w = container.clientWidth || (container.getBoundingClientRect ? container.getBoundingClientRect().width : 0);
    return w > 0 ? w : knownWidth || FALLBACK_WIDTH;
  }

  function buildLegend(spec, figure) {
    const radial = spec.type === "pie" || spec.type === "donut";
    const list = html("ul", "tb-legend", undefined, figure);
    const total = radial ? spec.series[0].data.reduce((sum, v) => sum + (v || 0), 0) : 0;
    if (radial) {
      spec.labels.forEach((label, i) => {
        const v = spec.series[0].data[i];
        const li = html("li", undefined, undefined, list);
        const sw = html("span", "tb-swatch", undefined, li);
        sw.setAttribute("data-s", String(i + 1));
        html("span", "tb-legend-name", label, li);
        const share = v && total ? ` (${Math.round((v / total) * 1000) / 10}%)` : "";
        html("span", "tb-legend-val", `${format(v, spec)}${share}`, li);
      });
    } else {
      spec.series.forEach((s, j) => {
        const li = html("li", undefined, undefined, list);
        const sw = html("span", "tb-swatch", undefined, li);
        sw.setAttribute("data-s", String(j + 1));
        html("span", "tb-legend-name", s.name, li);
      });
    }
  }

  function buildData(spec, figure) {
    const radial = spec.type === "pie" || spec.type === "donut";
    const details = html("details", "tb-data", undefined, figure);
    html("summary", undefined, "View data", details);
    const wrap = html("div", "tb-table-wrap", undefined, details);
    const table = html("table", undefined, undefined, wrap);
    const headRow = html("tr", undefined, undefined, html("thead", undefined, undefined, table));
    html("th", undefined, radial ? "Slice" : "", headRow);
    if (radial) html("th", undefined, "Value", headRow);
    else spec.series.forEach((s) => html("th", undefined, s.name, headRow));
    const body = html("tbody", undefined, undefined, table);
    spec.labels.forEach((label, i) => {
      const tr = html("tr", undefined, undefined, body);
      html("th", undefined, label, tr).setAttribute("scope", "row");
      const values = radial ? [spec.series[0].data[i]] : spec.series.map((s) => s.data[i]);
      values.forEach((v) => html("td", undefined, format(v, spec), tr));
    });
  }

  function fillTip(tip, spec, idx) {
    const radial = spec.type === "pie" || spec.type === "donut";
    tip.textContent = "";
    html("div", "tb-tip-head", spec.labels[idx], tip);
    if (radial) {
      const v = spec.series[0].data[idx];
      const total = spec.series[0].data.reduce((sum, x) => sum + (x || 0), 0);
      const row = html("div", "tb-tip-row", undefined, tip);
      html("span", "tb-swatch", undefined, row).setAttribute("data-s", String(idx + 1));
      html("span", "tb-tip-name", "Value", row);
      const share = v && total ? ` (${Math.round((v / total) * 1000) / 10}%)` : "";
      html("span", "tb-tip-val", `${format(v, spec)}${share}`, row);
      return;
    }
    spec.series.forEach((s, j) => {
      const row = html("div", "tb-tip-row", undefined, tip);
      html("span", "tb-swatch", undefined, row).setAttribute("data-s", String(j + 1));
      html("span", "tb-tip-name", s.name, row);
      html("span", "tb-tip-val", format(s.data[idx], spec), row);
    });
  }

  function placeTip(figure, svg, tip, e) {
    const f = figure.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    const x = e.clientX - f.left;
    const w = tip.offsetWidth;
    let left = x + 14;
    if (left + w > f.width) left = x - w - 14;
    tip.style.left = `${clamp(left, 0, Math.max(0, f.width - w))}px`;
    tip.style.top = `${s.top - f.top + 4}px`;
  }

  // Only one tooltip is open at a time; a tap or click anywhere outside it closes it.
  let openHide = null;
  let outsideListening = false;

  function wireHover(figure, svg, tip, api, spec) {
    let current = null;
    const hide = () => {
      if (openHide && openHide.hide === hide) openHide = null;
      current = null;
      tip.hidden = true;
      api.highlight(null);
    };
    hide.figure = figure;
    const move = (e) => {
      const idx = api.indexAt(e);
      if (idx === null || idx === undefined) {
        if (current !== null) hide();
        return;
      }
      if (idx !== current) {
        current = idx;
        api.highlight(idx);
        fillTip(tip, spec, idx);
      }
      tip.hidden = false;
      placeTip(figure, svg, tip, e);
      openHide = { hide, figure };
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); });
    if (!outsideListening && typeof document !== "undefined") {
      outsideListening = true;
      document.addEventListener("pointerdown", (e) => {
        if (openHide && !openHide.figure.contains(e.target)) openHide.hide();
      });
    }
  }

  function render(container, input) {
    const result = normalize(input);
    if (!result.ok) return false;
    if (typeof document === "undefined" || !container || typeof container.appendChild !== "function") return false;
    const spec = result.spec;
    const radial = spec.type === "pie" || spec.type === "donut";
    const W = clamp(Math.round(measure(container)), MIN_WIDTH, MAX_WIDTH);

    const figure = html("figure", "tb-chart");
    figure.dataset.type = spec.type;
    if (spec.title) html("figcaption", "tb-title", spec.title, figure);
    if (spec.subtitle) html("p", "tb-subtitle", spec.subtitle, figure);

    const plot = html("div", "tb-plot", undefined, figure);
    if (radial || spec.series.length > 1) buildLegend(spec, figure);
    if (spec.note) html("p", "tb-note", spec.note, figure);
    buildData(spec, figure);

    const tip = html("div", "tb-tip", undefined, figure);
    tip.hidden = true;
    tip.setAttribute("aria-hidden", "true");

    let drawn = 0;
    const draw = (width) => {
      drawn = width;
      const svg = svgEl("svg", {
        viewBox: `0 0 ${width} ${HEIGHT}`, role: "img", "aria-label": describe(spec), focusable: "false",
      });
      let api;
      if (spec.type === "hbar") api = drawHorizontal(spec, width, svg);
      else if (radial) api = drawRadial(spec, width, svg);
      else api = drawCartesian(spec, width, svg);
      svg.setAttribute("viewBox", `0 0 ${width} ${api.height}`);
      plot.replaceChildren(svg);
      tip.hidden = true;
      wireHover(figure, svg, tip, api, spec);
    };
    draw(W);
    container.appendChild(figure);

    if (typeof ResizeObserver === "function") {
      let timer = 0;
      const observer = new ResizeObserver((entries) => {
        const width = Math.round(entries[0]?.contentRect?.width || 0);
        if (!width) return;
        knownWidth = width;
        const next = clamp(width, MIN_WIDTH, MAX_WIDTH);
        if (Math.abs(next - drawn) / drawn < 0.06) return;
        clearTimeout(timer);
        timer = setTimeout(() => draw(next), drawn === W ? 0 : 120);
      });
      observer.observe(plot);
    }
    return true;
  }

  const api = { types: TYPES.slice(), normalize, format, render };
  if (typeof window !== "undefined") window.RavnirCharts = api;
  globalThis.RavnirCharts = api;
  (globalThis.RavnirBlocks ||= {}).chart = (code, container) => api.render(container, code);
})();
