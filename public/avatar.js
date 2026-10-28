// Ravnir avatars: ravens and living pseudo-3D objects drawn as inline SVG. No dependencies on app.js.
// Why they look and move the way they do: docs/avatars.md. The server imports this file too
// (server/state.js), so it must run without a DOM.
(() => {
  // Raven first: it is the default body. The objects stay as options.
  const SHAPES = [
    ["raven", "Raven"], ["orb", "Orb"], ["egg", "Egg"], ["capsule", "Capsule"], ["cube", "Cube"], ["screen", "Screen"],
    ["can", "Can"], ["dome", "Dome"], ["gem", "Gem"], ["ring", "Ring"],
  ];
  const MATERIALS = [["matte", "Matte"], ["gloss", "Satin"], ["glass", "Frosted glass"], ["metal", "Brushed metal"], ["pearl", "Ceramic"]];
  const FACES = [["visor", "Visor"], ["surface", "Inlaid"], ["none", "No face"]];
  const EYES = [
    ["dot", "Dot"], ["pill", "Pill"], ["ring", "Ring"], ["pixel", "Pixel"],
    ["arc", "Smiley"], ["line", "Calm"], ["spark", "Spark"], ["cyclops", "Lens"],
  ];
  const MOUTHS = [["none", "None"], ["smile", "Smile"], ["grin", "Grin"], ["flat", "Flat"], ["o", "Oh"]];
  const EXTRAS = [
    ["none", "None"], ["antenna", "Antenna"], ["orbit", "Moon"], ["halo", "Halo"],
    ["sprout", "Sprout"], ["crown", "Crown"], ["headset", "Headset"], ["glasses", "Glasses"],
  ];
  // Saved accessory keys are kept, but a raven wears natural feather treatments.
  const RAVEN_PLUMAGE = [
    ["none", "Smooth"], ["antenna", "Crest"], ["orbit", "Scapular"], ["halo", "Collar"],
    ["sprout", "Tuft"], ["crown", "Swept"], ["headset", "Mantle"], ["glasses", "Brow"],
  ];
  const RAVEN_COLORS = ["#647585", "#697c70", "#81758c", "#97846c", "#899397", "#597b7b", "#966f61", "#2c3150"];
  const RAVEN_MATERIALS = [["matte", "Matte"], ["gloss", "Satin"], ["glass", "Soft"], ["metal", "Graphite"], ["pearl", "Iridescent"]];
  const RAVEN_EYES = [
    ["dot", "Natural"], ["pill", "Alert"], ["ring", "Ringed"], ["pixel", "Sharp"],
    ["arc", "Soft"], ["line", "Narrow"], ["spark", "Bright"], ["cyclops", "Pale"],
  ];
  const PERSONALITIES = [
    ["calm", "Calm", "Slow breath, steady gaze, unhurried blinks."],
    ["cheerful", "Cheerful", "Bouncy. Hops when you come close."],
    ["curious", "Curious", "Looks around a lot and tilts toward you."],
    ["focused", "Focused", "Barely moves. Eyes on the work."],
    ["shy", "Shy", "Looks away and blushes when you get close."],
  ];
  const MARKS = [
    ["initials", "Initials"], ["terminal", "Terminal"], ["code", "Code"], ["chart", "Chart"], ["shield", "Shield"],
    ["spark", "Spark"], ["compass", "Compass"], ["bolt", "Bolt"], ["book", "Book"], ["globe", "Globe"], ["chat", "Chat"],
  ];
  // Curated identity colors first, with the earlier palette available below.
  const COLORS = [
    "#4f78a7", "#448c78", "#8368a8", "#be897c", "#ba934e", "#b56548", "#b3a17b", "#718087",
    "#a8c9e8", "#b9cab2", "#e7c8ca", "#cbc3e6", "#e6e0d2", "#8e8e93",
    "#5b8def", "#3fbfa0", "#f0b43c", "#ef7c5b", "#e46aa6", "#9a7bf0",
    "#2f5d8c", "#3e5a4c", "#6f6885", "#a4553f", "#c08a2e", "#2c2c2e",
  ];
  const GLOWS = ["#8be9ff", "#b6ffcf", "#ffe08a", "#ffb0c8", "#cdb8ff", "#ffffff", "#ff8a5c"];
  const FALLBACK = COLORS[0];
  const LEGACY_SHAPES = { blob: "orb", bean: "capsule", cloud: "orb", drop: "gem", pebble: "cube" };
  const DEFAULT_EYES = ["dot", "pill", "ring", "pixel", "arc"];
  const MOODS = ["working", "waiting", "sleeping", "happy", "speaking"];
  const GLYPHS = {
    terminal: "M4.5 6.5l5.5 5.5-5.5 5.5M12.5 18h7",
    code: "M8 7.5L3.5 12 8 16.5M16 7.5l4.5 4.5-4.5 4.5M13.6 5l-3.2 14",
    chart: "M4 20h16M6.5 16.5v-4M11 16.5V7.5M15.5 16.5v-6M20 16.5V4.5",
    shield: "M12 3l7.5 3v5.4c0 4.6-3.1 8.1-7.5 9.6-4.4-1.5-7.5-5-7.5-9.6V6z",
    spark: "M12 3.5c.8 4.8 3.7 7.7 8.5 8.5-4.8.8-7.7 3.7-8.5 8.5-.8-4.8-3.7-7.7-8.5-8.5 4.8-.8 7.7-3.7 8.5-8.5z",
    compass: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z",
    bolt: "M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6z",
    book: "M12 6.5C10 5 7.6 4.5 4 4.5v13c3.6 0 6 .5 8 2 2-1.5 4.4-2 8-2v-13c-3.6 0-6 .5-8 2zM12 6.5v13",
    globe: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z",
    chat: "M5.5 4.5h13a2.5 2.5 0 0 1 2.5 2.5v7.5a2.5 2.5 0 0 1-2.5 2.5h-7l-4.5 3.5V17H5.5A2.5 2.5 0 0 1 3 14.5V7a2.5 2.5 0 0 1 2.5-2.5z",
  };
  // How each personality breathes, blinks and looks around (milliseconds).
  const PERSONA = {
    calm: { breath: 6, amp: ".014", blink: [3200, 7000], glance: [3500, 8000], radius: 0.5, gain: 0.8 },
    cheerful: { breath: 3.4, amp: ".03", blink: [2000, 4800], glance: [2200, 5000], radius: 0.8, gain: 1 },
    curious: { breath: 4.6, amp: ".02", blink: [2200, 5200], glance: [1300, 3600], radius: 1, gain: 1.15 },
    focused: { breath: 7.5, amp: ".008", blink: [4000, 9000], glance: [5000, 11000], radius: 0.35, gain: 0.65 },
    shy: { breath: 5, amp: ".018", blink: [1800, 4600], glance: [2600, 6000], radius: 0.7, gain: 0.75 },
  };
  // Show the entire library before variants. Existing preset names stay usable.
  const PRESETS = [
    ["Midnight", { shape: "raven", material: "matte", color: "#647585", face: "surface", eyes: "dot", personality: "calm" }],
    ["Comet", { shape: "orb", material: "glass", color: "#8368a8", face: "visor", eyes: "pill", glow: "#c8bbdf", extra: "orbit", personality: "curious" }],
    ["Owl", { shape: "egg", material: "pearl", color: "#b3a17b", face: "surface", eyes: "ring", extra: "glasses", personality: "shy" }],
    ["Sprig", { shape: "capsule", material: "matte", color: "#448c78", face: "surface", eyes: "arc", extra: "sprout", personality: "cheerful" }],
    ["Cobalt", { shape: "cube", material: "gloss", color: "#4f78a7", face: "surface", eyes: "line", personality: "focused" }],
    ["Pixel", { shape: "screen", material: "metal", color: "#4f78a7", face: "visor", eyes: "pixel", glow: "#b7d5df", extra: "antenna", personality: "focused" }],
    ["Tin", { shape: "can", material: "metal", color: "#718087", face: "visor", eyes: "line", extra: "headset", personality: "focused" }],
    ["Mochi", { shape: "dome", material: "pearl", color: "#be897c", face: "surface", eyes: "dot", personality: "calm" }],
    ["Regal", { shape: "gem", material: "metal", color: "#ba934e", face: "visor", eyes: "spark", glow: "#e3d1a4", extra: "crown", personality: "calm" }],
    ["Donut", { shape: "ring", material: "gloss", color: "#b56548", face: "surface", eyes: "dot", personality: "cheerful" }],
    ["Scholar", { shape: "raven", material: "matte", color: "#81758c", face: "surface", eyes: "ring", extra: "glasses", personality: "curious" }],
    ["Patina", { shape: "raven", material: "pearl", color: "#597b7b", face: "surface", extra: "orbit", personality: "focused" }],
    ["Umber", { shape: "raven", material: "matte", color: "#97846c", face: "surface", extra: "crown", personality: "calm" }],
    ["Sentinel", { shape: "raven", material: "metal", color: "#966f61", face: "visor", eyes: "line", mark: "shield", extra: "glasses", personality: "focused" }],
    ["Quill", { shape: "raven", material: "pearl", color: "#899397", face: "surface", eyes: "ring", extra: "halo", personality: "curious" }],
    ["Ember", { shape: "raven", material: "gloss", color: "#97846c", face: "surface", eyes: "spark", glow: "#d79d57", extra: "antenna", personality: "cheerful" }],
  ];
  const ROLES = [
    [/financ|money|budget|account|invoice|gasto|finanz|contab|tesor/i, { shape: "cube", material: "gloss", color: "#ba934e", face: "surface", eyes: "line", extra: "glasses", personality: "focused" }],
    [/engineer|develop|coder|coding|software|devops|programa|ingenier/i, { shape: "screen", material: "metal", color: "#4f78a7", face: "visor", eyes: "pixel", extra: "antenna", personality: "focused" }],
    [/research|investig|radar|scout|analy|insight|estudi/i, { shape: "orb", material: "glass", color: "#8368a8", face: "surface", eyes: "ring", extra: "glasses", personality: "curious" }],
    [/growth|market|viral|tiktok|social|content|brand|crec/i, { shape: "capsule", material: "matte", color: "#448c78", face: "surface", eyes: "arc", extra: "sprout", personality: "cheerful" }],
    [/comms|communic|support|email|inbox|outreach|comunic|prensa/i, { shape: "dome", material: "pearl", color: "#be897c", face: "surface", eyes: "pill", extra: "headset", personality: "cheerful" }],
    [/audit|secur|complian|risk|legal|guard|segur/i, { shape: "gem", material: "metal", color: "#718087", face: "visor", eyes: "line", personality: "focused" }],
    [/chief|ceo|jefe|boss|director|manager|\blead\b/i, { shape: "raven", material: "matte", color: "#647585", face: "surface", eyes: "dot", extra: "crown", personality: "calm" }],
    [/assist|\bpa\b|personal|calendar|agenda|secretar|errand/i, { shape: "egg", material: "pearl", color: "#b3a17b", face: "surface", eyes: "dot", extra: "halo", personality: "calm" }],
    [/\bjob|career|hunt|recruit|empleo|trabajo/i, { shape: "ring", material: "gloss", color: "#b56548", face: "surface", eyes: "spark", personality: "curious" }],
    [/genius|idea|brainstorm|creativ|invent|think/i, { shape: "can", material: "metal", color: "#8b6e83", face: "visor", eyes: "ring", extra: "antenna", personality: "curious" }],
    [/coach|mentor|teach|tutor|health|fitness|habit/i, { shape: "capsule", material: "matte", color: "#448c78", face: "surface", eyes: "arc", extra: "sprout", personality: "cheerful" }],
  ];
  const MINOR = new Set(["of", "the", "and", "for", "to", "a", "an", "de", "del", "la", "el", "los", "las", "y"]);
  const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, 'Helvetica Neue', Arial, sans-serif";
  const keys = (list) => list.map(([value]) => value);
  const f = (value) => +Number(value).toFixed(2);
  let uid = 0;

  function hash(value) {
    let result = 2166136261;
    const text = String(value || "ravnir");
    for (let index = 0; index < text.length; index += 1) {
      result ^= text.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  }

  function validColor(value) {
    const text = String(value || "").trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(text) ? text : "";
  }

  function slider(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(Math.max(-1, Math.min(1, number)) * 100) / 100 : 0;
  }

  // A look: { shape, material, color, face, eyes, glow, mouth, extra, cheeks, personality, eyeSize, eyeGap, faceY, mark }.
  // Missing parts come from the seed, so every agent has a stable look before anyone customizes it.
  function normalize(input, { seed = "", color = "" } = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const base = String(seed || "ravnir");
    const choose = (list, value, fallback) => (keys(list).includes(value) ? value : fallback);
    const shape = keys(SHAPES).includes(source.shape) ? source.shape : LEGACY_SHAPES[source.shape] || "raven";
    return {
      shape,
      material: choose(MATERIALS, source.material, shape === "raven" ? "matte" : "gloss"),
      color: validColor(source.color) || validColor(color),
      face: choose(FACES, source.face, shape === "raven" || hash(`${base}:face`) % 2 ? "surface" : "visor"),
      eyes: choose(EYES, source.eyes, shape === "raven" ? "dot" : DEFAULT_EYES[hash(`${base}:eyes`) % DEFAULT_EYES.length]),
      glow: validColor(source.glow),
      mouth: choose(MOUTHS, source.mouth, "none"),
      extra: choose(EXTRAS, source.extra, "none"),
      cheeks: source.cheeks === true,
      personality: choose(PERSONALITIES, source.personality, shape === "raven" ? "calm" : keys(PERSONALITIES)[hash(`${base}:mood`) % PERSONALITIES.length]),
      eyeSize: slider(source.eyeSize),
      eyeGap: slider(source.eyeGap),
      faceY: slider(source.faceY),
      mark: choose(MARKS, source.mark, "initials"),
    };
  }

  function role({ job = "", name = "" } = {}) {
    return ROLES.find(([pattern]) => pattern.test(name)) || ROLES.find(([pattern]) => pattern.test(`${name} ${job}`));
  }

  function suggest({ job = "", name = "", seed = "" } = {}) {
    const hit = role({ job, name });
    return normalize(hit ? hit[1] : {}, { seed: seed || name });
  }

  const matches = (who) => Boolean(role(who));

  function preset(name) {
    const hit = PRESETS.find(([label]) => label === name);
    return hit ? normalize(hit[1], { seed: name }) : null;
  }

  function random() {
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const shape = Math.random() < 0.5 ? "raven" : pick(keys(SHAPES));
    if (shape === "raven") return normalize({
      shape, material: pick(["matte", "matte", "pearl"]), color: pick(RAVEN_COLORS),
      extra: pick(keys(RAVEN_PLUMAGE)), personality: pick(keys(PERSONALITIES)),
    });
    const face = shape === "screen" || (shape !== "raven" && Math.random() < 0.55) ? "visor" : "surface";
    return normalize({
      shape,
      material: pick(["gloss", "gloss", "matte", "pearl", "glass", "metal"]),
      color: pick(COLORS),
      face,
      eyes: pick(["dot", "dot", "pill", "pill", "ring", "pixel", "arc", "line", "spark", "cyclops"]),
      glow: face === "visor" && Math.random() < 0.5 ? pick(GLOWS) : "",
      mouth: face === "surface" ? pick(["none", "smile", "smile", "grin", "o"]) : pick(["none", "none", "none", "smile"]),
      extra: Math.random() < 0.55 ? pick(keys(EXTRAS).slice(1)) : "none",
      cheeks: face === "surface" && Math.random() < 0.4,
      personality: pick(keys(PERSONALITIES)),
      eyeSize: Math.random() * 0.8 - 0.3,
      eyeGap: Math.random() * 0.8 - 0.4,
    }, { seed: String(Math.random()) });
  }

  function initials(name) {
    const words = String(name || "")
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    const major = words.filter((word) => !MINOR.has(word.toLowerCase()));
    const list = major.length ? major : words;
    if (!list.length) return "";
    const first = (word) => Array.from(word)[0] || "";
    if (list.length === 1) {
      const word = list[0];
      const acronym = word.length <= 3 && word === word.toUpperCase() && /\p{L}/u.test(word);
      return (acronym ? Array.from(word).slice(0, 2).join("") : first(word)).toUpperCase();
    }
    return (first(list[0]) + first(list[list.length - 1])).toUpperCase();
  }

  function rgb(color) {
    const value = parseInt(color.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function toHex(channels) {
    return `#${channels.map((part) => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, "0")).join("")}`;
  }

  function toHsl([red, green, blue]) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;
    if (max === min) return [0, 0, light];
    const delta = max - min;
    const sat = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue /= 6;
    return [hue, sat, light];
  }

  function fromHsl(hue, sat, light) {
    const clamp = (value) => Math.max(0, Math.min(1, value));
    const h = ((hue % 1) + 1) % 1;
    const s = clamp(sat);
    const l = clamp(light);
    if (!s) return toHex([l * 255, l * 255, l * 255]);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (offset) => {
      let t = h + offset;
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return toHex([channel(1 / 3) * 255, channel(0) * 255, channel(-1 / 3) * 255]);
  }

  function luminance(color) {
    const linear = (part) => {
      const unit = part / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgb(color);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  }

  // The light ramp of one color for one material: hi and hot are the lit side, deep the shadow.
  function tones(color, material) {
    const [hue, sat, light] = toHsl(rgb(color));
    const chroma = Math.max(sat * (1 - Math.abs(2 * light - 1)), material === "pearl" ? 0.12 : 0);
    const at = (l, factor, h = hue) => {
      const room = 1 - Math.abs(2 * l - 1);
      return fromHsl(h, room > 0.001 ? Math.min(1, (chroma * factor) / room) : 0, l);
    };
    const lift = (amount) => light + (1 - light) * amount;
    let ramp;
    if (material === "metal") {
      ramp = { hi: at(lift(0.55), 0.55), hot: at(lift(0.38), 0.7), lite: at(lift(0.22), 0.85), base: color, mid: at(light * 0.82, 1), shade: at(light * 0.62, 1.1), deep: at(light * 0.42, 1.2) };
    } else if (material === "pearl") {
      ramp = { hi: at(lift(0.48), 0.75, hue + 0.02), hot: at(lift(0.3), 0.9, hue + 0.015), lite: at(lift(0.18), 1, hue + 0.01), base: color, mid: at(light * 0.9, 1.05), shade: at(light * 0.76, 1.1), deep: at(light * 0.62, 1.15) };
    } else {
      const hi = at(lift(0.48), 0.72);
      ramp = { hi, hot: material === "matte" ? at(lift(0.24), 0.9) : at(lift(0.34), 0.85), lite: at(lift(0.18), 0.95), base: color, mid: at(light * 0.86, 1.3), shade: at(light * 0.74, 1.2), deep: at(light * 0.55, 1.35) };
    }
    const lum = luminance(color);
    return {
      ...ramp,
      glow: at(Math.min(0.62, Math.max(light, 0.52)), 2.4),
      dark: lum < 0.32,
      night: lum < 0.16,
      ink: fromHsl(hue, Math.min(sat, 0.45), 0.12),
      led: sat < 0.14 ? "#8be9ff" : fromHsl(hue, 0.92, 0.74),
    };
  }

  const stops = (list) => list.map(([offset, color, opacity = 1]) => `<stop offset="${offset}" stop-color="${color}"${opacity === 1 ? "" : ` stop-opacity="${opacity}"`}/>`).join("");
  const radial = (id, attrs, list) => `<radialGradient id="${id}" ${attrs}>${stops(list)}</radialGradient>`;
  const linear = (id, attrs, list) => `<linearGradient id="${id}" ${attrs}>${stops(list)}</linearGradient>`;
  const poly = (points) => points.map((point) => point.join(" ")).join(" ");
  const oval = ([cx, cy, rx, ry, rot = 0], attrs) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : ""} ${attrs}/>`;

  const MATERIAL = {
    matte: { soft: 0.14, sharp: 0, rim: 0.24, edge: 0.1, body: 1 },
    gloss: { soft: 0.22, sharp: 0.2, rim: 0.34, edge: 0.14, body: 1 },
    glass: { soft: 0.1, sharp: 0.08, rim: 0.28, edge: 0.2, body: 0.86 },
    metal: { soft: 0.2, sharp: 0.28, rim: 0.45, edge: 0.2, body: 1 },
    pearl: { soft: 0.18, sharp: 0.08, rim: 0.3, edge: 0.14, body: 1 },
  };

  function shared(id, t, glow) {
    return radial(`${id}-sp`, 'cx=".5" cy=".5" r=".5"', [[0, "#ffffff", 1], [0.42, "#ffffff", 0.75], [1, "#ffffff", 0]])
      + radial(`${id}-so`, 'cx=".5" cy=".5" r=".5"', [[0, "#ffffff", 0.75], [1, "#ffffff", 0]])
      + radial(`${id}-ca`, 'cx=".5" cy=".5" r=".5"', [[0, t.hi, 0.28], [0.5, t.hi, 0.12], [1, t.hi, 0]])
      + linear(`${id}-vz`, 'x1="0" y1="0" x2="0" y2="1"', [[0, "#2b303c"], [0.55, "#11141b"], [1, "#07080c"]])
      + linear(`${id}-vr`, 'x1="0" y1="0" x2="0" y2="1"', [[0, "#ffffff", 0.22], [1, "#ffffff", 0]])
      + radial(`${id}-gl`, 'cx=".5" cy=".5" r=".5"', [[0, glow, 0.55], [0.45, glow, 0.22], [1, glow, 0]]);
  }

  // Where the face, the mark and the accessories sit on each body (viewBox units).
  //   face: centre, scale k and an optional plane transform; top: crown of the head;
  //   sides: [left, right, y] for a headset; center: middle of the object for an orbit.

  // Round bodies (orb, egg, dome) share one lighting model.
  function rounded(t, id, m, glass, d, spot) {
    const defs = radial(`${id}-b`, 'cx=".42" cy=".36" r=".7" fx=".34" fy=".27"', [[0, t.hot], [0.28, t.lite], [0.62, t.base], [0.9, t.shade], [1, t.deep]])
      + radial(`${id}-r`, 'cx=".33" cy=".28" r=".78"', [[0, t.deep, 0], [0.62, t.deep, 0], [0.84, t.deep, glass ? 0.1 : 0.22], [0.95, t.lite, m.rim * 0.7], [1, t.hi, m.rim]])
      + radial(`${id}-f`, 'cx=".5" cy=".5" r=".5"', [[0, t.deep, 0], [0.62, t.deep, 0], [0.9, t.shade, 0.2], [1, t.deep, 0.35]]);
    const shape = `<path d="${d}"`;
    let body = `${shape} fill="url(#${id}-b)" fill-opacity="${m.body}"/>`;
    if (glass) body += `${shape} fill="url(#${id}-f)"/>${oval(spot.caustic, `fill="url(#${id}-ca)"`)}`;
    body += `${shape} fill="url(#${id}-r)"/>`;
    if (glass) body += `${shape} fill="none" stroke="${t.deep}" stroke-opacity=".35" stroke-width=".8"/>`;
    let spec = oval(spot.soft, `fill="url(#${id}-so)" opacity="${m.soft}"`);
    if (m.sharp) spec += oval(spot.sharp, `fill="url(#${id}-sp)" opacity="${m.sharp}"`);
    if (glass) spec += oval(spot.glint, `fill="url(#${id}-sp)" opacity=".12"`);
    return { defs, body, clip: `<path d="${d}"/>`, spec };
  }

  function orb(t, id, m, glass) {
    const part = rounded(t, id, m, glass, "M10 46a40 40 0 1 0 80 0a40 40 0 1 0-80 0Z", {
      caustic: [54, 70, 23, 11], soft: [37, 30, 21, 14, -35], sharp: [35, 26.5, 9, 5.4, -35], glint: [66, 65, 4.5, 2.6, -35],
    });
    if (glass) part.body += '<circle cx="50" cy="46" r="39.2" fill="none" stroke="#ffffff" stroke-opacity=".25" stroke-width=".8"/>';
    return {
      ...part,
      mark: { x: 50, y: 48.5, glyph: 34, one: 38, two: 31 },
      face: { x: 50, y: 45, k: 1 },
      top: [50, 6], sides: [10, 90, 46], center: [50, 46],
      shadow: [22, 83, 56, 11],
    };
  }

  function egg(t, id, m, glass) {
    return {
      ...rounded(t, id, m, glass, "M50 6C68 6 80 35 80 57C80 76 67 88 50 88C33 88 20 76 20 57C20 35 32 6 50 6Z", {
        caustic: [54, 75, 18, 8], soft: [38, 28, 13, 19, -22], sharp: [36, 23, 5, 8.5, -22], glint: [64, 70, 3.5, 2.2, -30],
      }),
      mark: { x: 50, y: 54, glyph: 30, one: 34, two: 27 },
      face: { x: 50, y: 47, k: 0.95 },
      top: [50, 6], sides: [20.5, 79.5, 48], center: [50, 48],
      shadow: [24, 85, 52, 10],
    };
  }

  function dome(t, id, m, glass) {
    return {
      ...rounded(t, id, m, glass, "M10 72C10 41 27 18 50 18C73 18 90 41 90 72V82H10Z", {
        caustic: [55, 76, 24, 5], soft: [33, 34, 20, 10, -26], sharp: [30, 30, 9, 3.6, -26], glint: [72, 74, 4, 1.6],
      }),
      mark: { x: 50, y: 56, glyph: 30, one: 32, two: 26 },
      face: { x: 50, y: 52, k: 1 },
      top: [50, 16], sides: [11, 89, 58], center: [50, 52],
      shadow: [10, 80, 80, 12],
    };
  }

  function cube(t, id, m, glass) {
    const A = [44, 13];
    const B = [14, 27];
    const C = [55, 41];
    const D = [85, 27];
    const h = 40;
    const down = ([x, y]) => [x, y + h];
    const top = [A, B, C, D];
    const left = [B, C, down(C), down(B)];
    const right = [C, D, down(D), down(C)];
    const defs = linear(`${id}-t`, 'x1="0" y1="0" x2="1" y2="1"', [[0, t.hot], [0.6, t.lite], [1, t.lite]])
      + linear(`${id}-l`, 'x1="0" y1="0" x2=".35" y2="1"', [[0, t.lite], [0.55, t.base], [1, t.mid]])
      + linear(`${id}-r`, 'x1="0" y1="0" x2=".4" y2="1"', [[0, t.shade], [1, t.deep]]);
    const face = (points, fill) => `<polygon points="${poly(points)}" fill="url(#${id}-${fill})" fill-opacity="${m.body}" stroke="url(#${id}-${fill})" stroke-opacity="${m.body}" stroke-width="1.2" stroke-linejoin="round"/>`;
    const line = (from, to, color, opacity, width) => `<path d="M${from.join(" ")}L${to.join(" ")}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`;
    let body = face(left, "l") + face(right, "r") + face(top, "t");
    if (glass) {
      const back = down(A);
      body += `<ellipse cx="36" cy="70" rx="16" ry="6" transform="rotate(19 36 70)" fill="url(#${id}-ca)" opacity=".75"/>`;
      body += line(A, back, "#ffffff", 0.3, 0.8) + line(back, down(B), "#ffffff", 0.3, 0.8) + line(back, down(D), "#ffffff", 0.3, 0.8);
      body += `<polygon points="${poly([A, D, down(D), down(C), down(B), B])}" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width=".8" stroke-linejoin="round"/>`;
    }
    body += line(B, C, "#ffffff", m.rim * 0.9, 1.5) + line(C, D, "#ffffff", m.rim * 0.6, 1.3) + line(C, down(C), "#ffffff", m.rim * 0.35, 1.1);
    body += line(D, down(D), t.lite, m.rim * 0.7, 1.2);
    let spec = `<ellipse cx="38" cy="25" rx="15" ry="7" transform="rotate(-12 38 25)" fill="url(#${id}-so)" opacity="${m.soft + 0.15}"/>`;
    if (m.sharp) {
      spec += `<ellipse cx="31" cy="27" rx="6.5" ry="3" transform="rotate(-24 31 27)" fill="url(#${id}-sp)" opacity="${m.sharp * 0.9}"/>`;
      spec += `<polygon points="19,35 25,37 25,66 19,64" fill="url(#${id}-so)" opacity="${m.sharp * 0.42}"/>`;
    }
    const clip = `<polygon points="${poly([[44, 10.5], [87.5, 26], [87.5, 68], [55, 83.5], [11.5, 68], [11.5, 26]])}"/>`;
    const plane = "matrix(.92 .314 0 1 0 0)";
    return {
      defs,
      body,
      clip,
      spec,
      mark: { x: 34.5, y: 54, transform: plane, glyph: 27, one: 29, two: 23 },
      face: { x: 34.5, y: 53, k: 0.72, transform: plane },
      top: [49.5, 27], peak: [46, 13], sides: [14, 85, 47], center: [50, 47],
      shadow: [13, 70, 74, 15],
    };
  }

  function capsule(t, id, m, glass) {
    const frame = 'transform="translate(50 47)"';
    const defs = linear(`${id}-a`, 'gradientUnits="userSpaceOnUse" x1="-23" y1="0" x2="23" y2="0"', [[0, t.lite], [0.16, t.hot], [0.42, t.lite], [0.68, t.base], [0.88, t.shade], [1, t.deep]])
      + linear(`${id}-e`, 'gradientUnits="userSpaceOnUse" x1="0" y1="-41" x2="0" y2="41"', [[0, "#ffffff", 0.2], [0.24, "#ffffff", 0], [0.76, t.deep, 0], [1, t.deep, 0.32]])
      + linear(`${id}-r`, 'gradientUnits="userSpaceOnUse" x1="11" y1="0" x2="23" y2="0"', [[0, t.lite, 0], [0.62, t.lite, 0], [1, t.hi, m.rim]])
      + linear(`${id}-f`, 'gradientUnits="userSpaceOnUse" x1="-23" y1="0" x2="23" y2="0"', [[0, t.deep, 0.55], [0.18, t.deep, 0], [0.82, t.deep, 0], [1, t.deep, 0.65]])
      + linear(`${id}-s`, 'gradientUnits="userSpaceOnUse" x1="0" y1="-31" x2="0" y2="15"', [[0, "#ffffff", 0], [0.18, "#ffffff", 0.95], [0.62, "#ffffff", 0.55], [1, "#ffffff", 0]]);
    const pill = '<rect x="-23" y="-41" width="46" height="82" rx="23"';
    let body = `<g ${frame}>${pill} fill="url(#${id}-a)" fill-opacity="${m.body}"/>`;
    if (glass) body += `${pill} fill="url(#${id}-f)"/><ellipse cx="5" cy="27" rx="13" ry="9" fill="url(#${id}-ca)"/>`;
    body += `${pill} fill="url(#${id}-e)"/>${pill} fill="url(#${id}-r)"/>`;
    if (glass) body += `${pill} fill="none" stroke="${t.deep}" stroke-opacity=".35" stroke-width=".8"/><rect x="-22.2" y="-40.2" width="44.4" height="80.4" rx="22.2" fill="none" stroke="#ffffff" stroke-opacity=".55" stroke-width=".8"/>`;
    body += "</g>";
    let spec = `<g ${frame}><rect x="-20" y="-35" width="17" height="60" rx="8.5" fill="url(#${id}-so)" opacity="${m.soft}"/>`;
    if (m.sharp) spec += `<rect x="-16" y="-31" width="6" height="46" rx="3" fill="url(#${id}-s)" opacity="${m.sharp}"/>`;
    if (glass) spec += '<rect x="11" y="6" width="3" height="18" rx="1.5" fill="#ffffff" opacity=".4"/>';
    spec += "</g>";
    return {
      defs,
      body,
      clip: `<rect x="-23" y="-41" width="46" height="82" rx="23" ${frame}/>`,
      spec,
      mark: { x: 50, y: 48, glyph: 26, one: 28, two: 22 },
      face: { x: 50, y: 41, k: 0.8 },
      top: [50, 6], sides: [27, 73, 38], center: [50, 47],
      shadow: [24, 84, 52, 10],
    };
  }

  function screen(t, id, m) {
    const defs = linear(id + "-sb", 'x1="0" y1="0" x2=".4" y2="1"', [[0, t.lite], [.6, t.base], [1, t.shade]])
      + linear(id + "-ss", 'x1="0" y1="0" x2=".15" y2="1"', [[0, "#28333c"], [1, "#121b23"]])
      + linear(id + "-sg", 'x1="0" y1="0" x2="1" y2="1"', [[0, "#c3d2db", .1], [.55, "#c3d2db", .015], [1, "#c3d2db", 0]])
      + linear(id + "-sn", 'x1="0" y1="0" x2="1" y2="0"', [[0, t.shade], [.5, t.base], [1, t.mid]]);
    const box = 'x="10" y="13" width="80" height="61" rx="7"';
    const body = '<path d="M46 72H54L56 83H44Z" fill="url(#' + id + '-sn)"/>'
      + '<rect x="34" y="82" width="32" height="4" rx="1.4" fill="' + t.mid + '"/>'
      + '<path d="M36 82.6H64" stroke="' + t.hi + '" stroke-opacity=".3" stroke-width=".7"/>'
      + '<rect ' + box + ' fill="url(#' + id + '-sb)" fill-opacity="' + m.body + '"/>'
      + '<rect x="10.5" y="13.5" width="79" height="60" rx="6.5" fill="none" stroke="' + t.hi + '" stroke-opacity=".36" stroke-width=".8"/>'
      + '<rect x="15" y="18" width="70" height="49" rx="3.5" fill="url(#' + id + '-ss)"/>'
      + '<rect x="15" y="18" width="70" height="49" rx="3.5" fill="url(#' + id + '-sg)"/>'
      + '<circle cx="77" cy="70" r=".8" fill="' + t.hi + '" opacity=".6"/>';
    return {
      defs, body, clip: '<rect ' + box + '/>', spec: '',
      mark: { x: 50, y: 43, glyph: 23, one: 25, two: 20, lit: true },
      face: { x: 50, y: 43, k: 1, screen: true },
      top: [50, 13], sides: [10, 90, 41], center: [50, 46], shadow: [24, 84, 52, 8],
    };
  }

  function can(t, id, m, glass) {
    const defs = linear(`${id}-cs`, 'x1="0" y1="0" x2="1" y2="0"', [[0, t.shade], [0.12, t.lite], [0.3, t.hot], [0.48, t.lite], [0.72, t.base], [0.9, t.shade], [1, t.deep]])
      + linear(`${id}-ct`, 'x1="0" y1="0" x2="1" y2="1"', [[0, t.hot], [1, t.lite]])
      + linear(`${id}-cv`, 'x1="0" y1="0" x2="0" y2="1"', [[0, "#ffffff", 0], [0.78, t.deep, 0], [1, t.deep, 0.35]]);
    const outline = "M22 20A28 8.5 0 0 1 78 20V76A28 8.5 0 0 1 22 76Z";
    let body = `<path d="${outline}" fill="url(#${id}-cs)" fill-opacity="${m.body}"/><path d="${outline}" fill="url(#${id}-cv)"/>`;
    if (glass) body += `<ellipse cx="54" cy="72" rx="16" ry="5" fill="url(#${id}-ca)"/>`;
    body += `<ellipse cx="50" cy="20" rx="28" ry="8.5" fill="url(#${id}-ct)" fill-opacity="${m.body}"/>`
      + `<ellipse cx="50" cy="20" rx="27.4" ry="8" fill="none" stroke="${t.hi}" stroke-opacity="${m.rim}" stroke-width="1"/>`
      + `<ellipse cx="50" cy="20.6" rx="21" ry="5.6" fill="none" stroke="${t.mid}" stroke-opacity=".55" stroke-width="1.1"/>`
      + `<path d="M22.4 70A28 8.5 0 0 0 77.6 70" fill="none" stroke="${t.deep}" stroke-opacity=".22" stroke-width="1"/>`;
    if (glass) body += `<path d="${outline}" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width=".8"/>`;
    let spec = `<rect x="27" y="25" width="10" height="50" rx="5" fill="url(#${id}-so)" opacity="${m.soft}"/>`;
    if (m.sharp) spec += `<rect x="30" y="28" width="3" height="38" rx="1.5" fill="#ffffff" opacity="${m.sharp * 0.6}"/>`;
    spec += `<ellipse cx="40" cy="17" rx="11" ry="3" fill="url(#${id}-so)" opacity="${m.soft + 0.1}"/>`;
    return {
      defs,
      body,
      clip: `<path d="${outline}"/>`,
      spec,
      mark: { x: 50, y: 52, glyph: 26, one: 28, two: 22 },
      face: { x: 50, y: 50, k: 0.88 },
      top: [50, 17], sides: [22, 78, 46], center: [50, 48],
      shadow: [20, 82, 60, 11],
    };
  }

  function gem(t, id, m, glass) {
    const t0 = [29, 12];
    const t1 = [71, 12];
    const g = [[9, 32], [30, 32], [50, 32], [70, 32], [91, 32]];
    const tip = [50, 84];
    const flat = m === MATERIAL.matte;
    const ramp = flat
      ? { hi: [t.lite, t.lite], lite: [t.lite, t.base], base: [t.base, t.mid], shade: [t.mid, t.shade], deep: [t.shade, t.deep] }
      : { hi: [t.hot, t.lite], lite: [t.lite, t.base], base: [t.base, t.shade], shade: [t.shade, t.deep], deep: [t.deep, t.deep] };
    const defs = Object.entries(ramp).map(([name, [from, to]]) => linear(`${id}-${name}`, 'x1="0" y1="0" x2=".3" y2="1"', [[0, from], [1, to]])).join("");
    const facets = [
      [[g[0], t0, g[1]], "lite"],
      [[t0, g[2], g[1]], "hi"],
      [[t0, t1, g[2]], "lite"],
      [[t1, g[3], g[2]], "base"],
      [[t1, g[4], g[3]], "shade"],
      [[g[0], g[1], tip], "base"],
      [[g[1], g[2], tip], "lite"],
      [[g[2], g[3], tip], "shade"],
      [[g[3], g[4], tip], "deep"],
    ];
    const outline = [g[0], t0, t1, g[4], tip];
    let body = `<polygon points="${poly(outline)}" fill="${t.mid}" fill-opacity="${m.body}" stroke="${t.mid}" stroke-opacity="${m.body}" stroke-width="1" stroke-linejoin="round"/>`;
    body += facets.map(([points, fill]) => `<polygon points="${poly(points)}" fill="url(#${id}-${fill})" fill-opacity="${m.body}" stroke="#ffffff" stroke-opacity="${m.edge}" stroke-width=".7" stroke-linejoin="round"/>`).join("");
    if (glass) {
      body += `<path d="M${t0.join(" ")}L${tip.join(" ")}M${t1.join(" ")}L${tip.join(" ")}" stroke="#ffffff" stroke-opacity=".28" stroke-width=".7" fill="none"/>`;
      body += `<ellipse cx="52" cy="64" rx="11" ry="8" fill="url(#${id}-ca)"/>`;
    }
    body += `<polygon points="${poly(outline)}" fill="none" stroke="${glass ? "#ffffff" : t.deep}" stroke-opacity="${glass ? 0.5 : 0.22}" stroke-width=".9" stroke-linejoin="round"/>`;
    body += `<path d="M${g[3].join(" ")}L${g[4].join(" ")}L${tip.join(" ")}" stroke="${t.lite}" stroke-opacity="${m.rim * 0.8}" stroke-width="1.1" stroke-linejoin="round" fill="none"/>`;
    let spec = `<ellipse cx="34" cy="22" rx="16" ry="9" transform="rotate(-20 34 22)" fill="url(#${id}-so)" opacity="${m.soft}"/>`;
    if (m.sharp) {
      spec += `<ellipse cx="35" cy="21" rx="6" ry="2.6" transform="rotate(-38 35 21)" fill="url(#${id}-sp)" opacity="${m.sharp}"/>`;
      spec += `<path d="M31 12.6H58" stroke="#ffffff" stroke-opacity="${m.sharp * 0.7}" stroke-width="1.2" stroke-linecap="round"/>`;
      spec += `<ellipse cx="36" cy="44" rx="3" ry="6" transform="rotate(-38 36 44)" fill="url(#${id}-sp)" opacity="${m.sharp * 0.45}"/>`;
    }
    return {
      defs,
      body,
      clip: `<polygon points="${poly(outline)}"/>`,
      spec,
      mark: { x: 50, y: 49, glyph: 22, one: 23, two: 18 },
      face: { x: 50, y: 45, k: 0.68 },
      top: [50, 12], sides: [9, 91, 32], center: [50, 46],
      shadow: [30, 80, 40, 9],
    };
  }

  function ring(t, id, m, glass) {
    const cx = 50;
    const cy = 47;
    const rx = 31;
    const ry = 25;
    const tube = 20;
    const outer = [rx + tube / 2, ry + tube / 2];
    const inner = [rx - tube / 2, ry - tube / 2];
    const squash = outer[1] / outer[0];
    const arc = (radiusX, radiusY, from, to) => {
      const point = (deg) => {
        const angle = (deg * Math.PI) / 180;
        return `${(cx + radiusX * Math.cos(angle)).toFixed(2)} ${(cy + radiusY * Math.sin(angle)).toFixed(2)}`;
      };
      return `M${point(from)}A${radiusX} ${radiusY} 0 0 1 ${point(to)}`;
    };
    const defs = radial(`${id}-t`, `gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${outer[0]}" gradientTransform="matrix(1 0 0 ${squash.toFixed(4)} 0 ${(cy * (1 - squash)).toFixed(3)})"`,
      [[0.2, t.shade], [0.4, t.base], [0.58, t.lite], [0.69, t.hot], [0.8, t.lite], [0.92, t.base], [1, t.shade]])
      + linear(`${id}-d`, 'x1=".1" y1="0" x2=".9" y2="1"', [[0, "#ffffff", 0.3], [0.42, "#ffffff", 0], [0.58, t.deep, 0], [1, t.deep, 0.55]])
      + linear(`${id}-s`, 'gradientUnits="userSpaceOnUse" x1="14" y1="44" x2="46" y2="13"', [[0, "#ffffff", 0], [0.5, "#ffffff", 1], [1, "#ffffff", 0]]);
    const band = (stroke, opacity = 1) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${tube}"/>`;
    let body = band(`url(#${id}-t)`, m.body) + band(`url(#${id}-d)`);
    body += `<path d="${arc(inner[0] + 1.8, inner[1] + 1.8, 180, 360)}" fill="none" stroke="${t.deep}" stroke-opacity="${glass ? 0.25 : 0.45}" stroke-width="3.4"/>`;
    body += `<path d="${arc(inner[0] + 1.5, inner[1] + 1.5, 15, 165)}" fill="none" stroke="${t.hi}" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>`;
    body += `<path d="${arc(outer[0] - 1.1, outer[1] - 1.1, 10, 85)}" fill="none" stroke="${t.lite}" stroke-opacity="${m.rim}" stroke-width="1.5" stroke-linecap="round"/>`;
    if (glass) {
      body += `<ellipse cx="${cx}" cy="${cy}" rx="${outer[0]}" ry="${outer[1]}" fill="none" stroke="${t.deep}" stroke-opacity=".3" stroke-width=".8"/>`;
      body += `<ellipse cx="${cx}" cy="${cy}" rx="${outer[0] - 0.4}" ry="${outer[1] - 0.4}" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width=".8"/>`;
      body += `<ellipse cx="${cx}" cy="${cy}" rx="${inner[0] + 0.4}" ry="${inner[1] + 0.4}" fill="none" stroke="#ffffff" stroke-opacity=".45" stroke-width=".8"/>`;
      body += `<ellipse cx="60" cy="${cy + ry + 6}" rx="10" ry="3.5" fill="url(#${id}-ca)"/>`;
    }
    let spec = `<path d="${arc(rx + 3, ry + 3, 192, 262)}" fill="none" stroke="#ffffff" stroke-opacity="${m.soft * 0.5}" stroke-width="10" stroke-linecap="round"/>`;
    if (m.sharp) spec += `<path d="${arc(rx + 4.5, ry + 4.5, 198, 256)}" fill="none" stroke="url(#${id}-s)" stroke-width="3.4" stroke-linecap="round" opacity="${m.sharp}"/>`;
    const ellipse = ([radiusX, radiusY]) => `M${cx - radiusX} ${cy}a${radiusX} ${radiusY} 0 1 0 ${radiusX * 2} 0a${radiusX} ${radiusY} 0 1 0 ${-radiusX * 2} 0z`;
    return {
      defs,
      body,
      clip: `<path fill-rule="evenodd" clip-rule="evenodd" d="${ellipse(outer)}${ellipse(inner)}"/>`,
      spec,
      mark: { x: 50, y: cy + ry - 0.5, glyph: 18, one: 19, two: 16 },
      face: { x: 50, y: cy + ry, k: 0.5 },
      top: [50, 13], sides: [6.5, 93.5, 47], center: [50, 47],
      shadow: [12, 70, 76, 17],
    };
  }

  // Color is a feather sheen, never a pastel body. Old saved colors remain useful.
  function ravenTones(color, material) {
    const mix = (base, amount) => toHex(rgb(base).map((channel, index) => channel * (1 - amount) + rgb(color)[index] * amount));
    const t = tones(mix("#171d25", 0.13), "matte");
    return { ...t, base: mix("#1b222b", 0.12), lite: mix("#4a5763", 0.24),
      mid: mix("#2a343e", 0.18), shade: mix("#151c24", 0.08), deep: "#10161d",
      hi: mix("#788995", 0.3), accent: mix("#697c86", 0.55),
      sheen: { matte: .42, gloss: .58, glass: .3, metal: .5, pearl: .72 }[material] };
  }

  // A perched adult raven in profile: small skull, long neck, folded primaries, wedge tail.
  // Feather silhouettes use the existing accessory keys, so saved looks need no migration.
  function ravenBody(t, id, m, glass, look) {
    const outline = "M46 31C45 40 34 43 27 53C20 63 19 72 24 77C33 86 52 85 63 76C73 68 73 56 70 46L70 31Z";
    const defs = linear(id + "-rv", 'x1=".12" y1="0" x2=".84" y2="1"', [[0, t.lite], [.28, t.mid], [.65, t.base], [1, t.deep]])
      + linear(id + "-wg", 'x1="0" y1="0" x2=".8" y2="1"', [[0, t.lite], [.3, t.mid], [1, t.deep]])
      + linear(id + "-hd", 'x1=".15" y1="0" x2=".85" y2="1"', [[0, t.lite], [.4, t.mid], [1, t.base]])
      + linear(id + "-bk", 'x1="0" y1="0" x2="0" y2="1"', [[0, "#58636d"], [.45, "#323d47"], [1, "#1a222b"]])
      + linear(id + "-ir", 'x1="0" y1="0" x2="1" y2="1"', [[0, t.accent, 0], [.35, t.accent, t.sheen], [.7, "#667d84", .12], [1, t.accent, 0]]);
    const tail = '<g class="tb-rv-tail"><path d="M29 67L7 91L18 90L14 94L27 89L25 94L43 78Z" fill="' + t.deep + '"/>'
      + '<path d="M34 74L16 90M37 76L25 89" fill="none" stroke="' + t.mid + '" stroke-width="1"/></g>';
    const feet = '<g class="tb-rv-feet" fill="none" stroke="#68747c" stroke-width="1.4" stroke-linecap="round"><path d="M43 80L41 89L35 91M41 89L46 91M55 79L56 88L51 91M56 88L62 90"/></g>';
    const farWing = '<g class="tb-rv-wing tb-rv-flight-far"><path d="M58 44C68 28 81 16 96 8C95 20 90 28 85 32L92 28C89 39 81 44 75 46L81 44C77 53 69 56 61 52Z" fill="url(#' + id + '-wg)" stroke="' + t.hi + '" stroke-opacity=".22" stroke-width=".7"/>'
      + '<path d="M64 44Q76 27 91 16L76 43Z" fill="url(#' + id + '-ir)"/>'
      + '<path d="M85 27L69 46M83 35L69 49" fill="none" stroke="' + t.hi + '" stroke-opacity=".2" stroke-width=".8"/></g>';
    const nearWing = '<g class="tb-rv-wing tb-rv-flight-near"><path d="M39 47C28 36 17 23 4 9C4 21 8 29 13 34L7 29C8 39 16 48 22 51L14 47C18 56 27 62 36 59L45 52Z" fill="url(#' + id + '-wg)" stroke="' + t.hi + '" stroke-opacity=".28" stroke-width=".7"/>'
      + '<path d="M35 46Q24 29 9 16Q16 37 31 53Z" fill="url(#' + id + '-ir)"/>'
      + '<path d="M12 28L29 51M16 35L31 54M21 43L33 55" fill="none" stroke="' + t.hi + '" stroke-opacity=".24" stroke-width=".8" stroke-linecap="round"/></g>';
    const wing = '<g class="tb-rv-feathers tb-rv-fold"><path d="M42 44C30 48 23 61 22 76L28 78L25 82C41 80 54 69 59 52C54 46 48 43 42 44Z" fill="url(#' + id + '-wg)"/>'
      + '<path d="M42 47C33 52 28 64 27 74C40 69 48 60 52 50Z" fill="url(#' + id + '-ir)"/>'
      + '<g fill="none" stroke="' + t.hi + '" stroke-opacity=".19" stroke-width=".75" stroke-linecap="round"><path d="M35 53C32 60 30 69 27 75M41 51C38 61 34 70 30 76M47 51C44 61 38 71 33 76M52 53C48 65 42 72 37 77"/></g>'
      + '<path d="M33 52Q42 43 52 49M31 57Q39 48 49 52M29 63Q37 54 46 57" fill="none" stroke="' + t.accent + '" stroke-opacity=".26" stroke-width="1" stroke-linecap="round"/></g>';
    const plumage = {
      none: '',
      antenna: '<path d="M48 18L44 9L54 14L50 7L61 13" fill="' + t.mid + '"/>',
      orbit: '<path d="M38 47Q50 43 58 53L51 56Q47 48 38 50Z" fill="' + t.accent + '" opacity=".42"/>',
      halo: '<path d="M46 38Q56 45 70 40L70 43Q55 49 44 41Z" fill="' + t.accent + '" opacity=".45"/>',
      sprout: '<path d="M47 20L41 15L51 16L45 12L56 15" fill="' + t.mid + '"/>',
      crown: '<path d="M53 14L40 10L45 17L37 15L44 22L42 24L54 21Z" fill="' + t.mid + '"/>',
      headset: '<path d="M39 45Q31 47 27 57L35 53L31 60L41 54L37 62L48 54Z" fill="' + t.accent + '" opacity=".32"/>',
      glasses: '<path d="M55 23Q61 19 69 23" fill="none" stroke="' + t.accent + '" stroke-width="1.8" stroke-linecap="round"/>',
    };
    const headPlumage = ["antenna", "sprout", "crown", "glasses"].includes(look.extra);
    const treatment = plumage[look.extra] || '';
    return {
      defs,
      body: tail + farWing + feet + '<path d="' + outline + '" fill="url(#' + id + '-rv)" stroke="' + t.hi + '" stroke-opacity=".22" stroke-width=".7"/>'
        + '<path d="M67 43C71 58 67 70 58 76" fill="none" stroke="' + t.hi + '" stroke-opacity=".24" stroke-width=".8"/>'
        + wing + nearWing + (!headPlumage ? treatment : ''),
      head: '<path d="M45 31C42 24 46 15 54 13C62 10 71 14 75 21L76 28L71 35L70 43L65 40L64 44L59 40L57 43L52 38L48 40L49 34Z" fill="url(#' + id + '-hd)" stroke="' + t.hi + '" stroke-opacity=".22" stroke-width=".7"/>'
        + '<path d="M49 20Q58 12 68 18M47 29Q48 35 56 38M51 31L58 37M56 30L63 36" fill="none" stroke="' + t.hi + '" stroke-opacity=".16" stroke-width=".75" stroke-linecap="round"/>'
        + (headPlumage ? treatment : ''),
      over: '<g class="tb-rv-bill"><path class="tb-rv-jaw" d="M70 29L92 32Q83 36 73 34Z" fill="#252f39"/>'
        + '<path d="M69 23C78 22 88 26 94 32L91 33L71 30L67 27Z" fill="url(#' + id + '-bk)"/>'
        + '<path d="M73 25Q83 25 90 30" fill="none" stroke="#91a0aa" stroke-opacity=".38" stroke-width=".6"/>'
        + '<path d="M71 30L91 32" fill="none" stroke="#111820" stroke-width=".8"/>'
        + '<ellipse cx="75" cy="26" rx="1.1" ry=".55" fill="#162029"/></g>',
      clip: '<path d="' + outline + '"/>', spec: '',
      mark: { x: 52, y: 64, glyph: 14, one: 16, two: 12 },
      face: { x: 63.5, y: 24.5, k: 1, beak: true },
      top: [57, 13], sides: [44, 74, 27], center: [48, 52], shadow: [27, 88, 42, 7],
    };
  }

  function ravenFace(look, part, glow) {
    const radius = 2.25 * (1 + .2 * look.eyeSize);
    const [wide, tall, pupil] = {
      dot: [1, 1, .65], pill: [.9, 1.15, .62], ring: [1.16, 1.02, .43], pixel: [1.04, .9, .58],
      arc: [1, .72, .62], line: [1.05, .48, .7], spark: [1.1, 1.05, .55], cyclops: [1.05, 1.05, .58],
    }[look.eyes];
    const iris = look.glow || (look.eyes === "cyclops" ? "#bac3c3" : glow);
    return '<g class="tb-av-face" transform="translate(' + part.face.x + ' ' + (part.face.y + look.faceY) + ')">'
      + '<g class="tb-rv-eye"><g class="tb-av-blink"><g class="tb-av-open" transform="scale(' + wide + ' ' + tall + ')">'
      + '<circle r="' + f(radius + 1.1) + '" fill="#141c25"/>'
      + '<circle r="' + f(radius) + '" fill="' + iris + '" opacity=".85"/>'
      + '<circle cx=".3" cy=".1" r="' + f(radius * pupil) + '" fill="#0b1118"/>'
      + '<circle cx="-.65" cy="-.8" r=".48" fill="#f6f2e5" opacity=".88"/>'
      + (look.eyes === "spark" ? '<circle cx=".7" cy=".8" r=".3" fill="#f6f2e5" opacity=".65"/>' : '')
      + '</g><path class="tb-av-shut" d="M-2.5 0Q0 1.2 2.5 0" fill="none" stroke="#88959e" stroke-width=".9" stroke-linecap="round"/>'
      + '</g></g></g>';
  }

  const BUILDERS = { raven: ravenBody, orb, egg, capsule, cube, screen, can, dome, gem, ring };

  function eyeShape(style, r) {
    switch (style) {
      case "pill": return `<rect x="${f(-r * 0.5)}" y="${f(-r * 1.2)}" width="${f(r)}" height="${f(r * 2.4)}" rx="${f(r * 0.5)}"/>`;
      case "ring": return `<circle r="${f(r * 0.8)}" fill="none" stroke="currentColor" stroke-width="${f(r * 0.44)}"/>`;
      case "pixel": return `<rect x="${f(-r * 0.8)}" y="${f(-r * 0.8)}" width="${f(r * 1.6)}" height="${f(r * 1.6)}" rx="${f(r * 0.3)}"/>`;
      case "arc": return `<path d="M${f(-r)} ${f(r * 0.4)}Q0 ${f(-r * 1.3)} ${f(r)} ${f(r * 0.4)}" fill="none" stroke="currentColor" stroke-width="${f(r * 0.56)}" stroke-linecap="round"/>`;
      case "line": return `<rect x="${f(-r * 1.05)}" y="${f(-r * 0.3)}" width="${f(r * 2.1)}" height="${f(r * 0.6)}" rx="${f(r * 0.3)}"/>`;
      case "spark": {
        const a = r * 1.25;
        const b = r * 0.3;
        return `<path d="M0 ${f(-a)}Q${f(b)} ${f(-b)} ${f(a)} 0Q${f(b)} ${f(b)} 0 ${f(a)}Q${f(-b)} ${f(b)} ${f(-a)} 0Q${f(-b)} ${f(-b)} 0 ${f(-a)}Z"/>`;
      }
      default: return `<ellipse rx="${f(r * 0.8)}" ry="${f(r)}"/>`;
    }
  }

  // The face lives in its own small coordinate system centred on the body's face spot.
  // Eyes move further than the face plate when the gaze shifts, which reads as depth.
  function faceMarkup(look, t, part, id, glow) {
    if (look.shape === "raven") return ravenFace(look, part, glow);
    const spot = part.face;
    const screenFace = Boolean(spot.screen);
    const visor = screenFace || look.face === "visor";
    const lit = visor || t.night;
    const ink = lit ? glow : t.ink;
    const cyclops = look.eyes === "cyclops";
    const r = 3.7 * (1 + 0.24 * look.eyeSize);
    const size = cyclops ? r * 1.6 : r;
    const gap = cyclops ? 0 : 8.8 * (1 + 0.22 * look.eyeGap);
    const dy = 4.5 * look.faceY;
    const hasMouth = look.mouth !== "none" && !spot.beak;
    const tall = cyclops ? 1 : Math.max({ pill: 1.2, spark: 1.25 }[look.eyes] || 1, 0.9);
    const wide = { line: 1.05, spark: 1.25, arc: 1.1 }[look.eyes] || 1;
    let plate = "";
    if (visor && !screenFace) {
      const w = (cyclops ? 2 * size : 2 * gap + 2 * r * wide) + 15;
      const top = dy - size * tall - 6;
      const h = size * tall * 2 + 12 + (hasMouth ? 6 : 0);
      const rx = Math.min(h / 2, 12);
      const box = `x="${f(-w / 2)}" y="${f(top)}" width="${f(w)}" height="${f(h)}" rx="${f(rx)}"`;
      plate = `<rect ${box} fill="none" stroke="${t.deep}" stroke-opacity=".28" stroke-width="2.4"/>`
        + `<rect class="tb-av-plate" ${box} fill="url(#${id}-vz)"${look.material === "glass" ? ' fill-opacity=".86"' : ""}/>`
        + `<rect x="${f(-w / 2 + 2)}" y="${f(top + 1.4)}" width="${f(w - 4)}" height="${f(h * 0.42)}" rx="${f(Math.max(rx - 1.6, 1))}" fill="url(#${id}-vr)"/>`
        + `<rect ${box} fill="none" stroke="#ffffff" stroke-opacity=".16" stroke-width=".7"/>`;
    }
    const catchable = !lit && ["dot", "pill", "pixel", "spark"].includes(look.eyes);
    const eye = (x, radius) => {
      const happy = `<path class="tb-av-happy" d="M${f(-radius)} ${f(radius * 0.35)}Q0 ${f(-radius * 1.2)} ${f(radius)} ${f(radius * 0.35)}" fill="none" stroke="currentColor" stroke-width="${f(Math.max(radius * 0.5, 2))}" stroke-linecap="round"/>`;
      const shut = `<path class="tb-av-shut" d="M${f(-radius)} ${f(-radius * 0.1)}Q0 ${f(radius * 0.9)} ${f(radius)} ${f(-radius * 0.1)}" fill="none" stroke="currentColor" stroke-width="${f(Math.max(radius * 0.42, 1.8))}" stroke-linecap="round"/>`;
      let open = lit ? `<circle r="${f(radius * 1.65)}" fill="url(#${id}-gl)"/>` : "";
      if (cyclops) {
        open += `<circle r="${f(radius)}" fill="${lit ? "#0b0e14" : t.ink}"/>`
          + `<circle r="${f(radius * 0.7)}" fill="none" stroke="${glow}" stroke-width="${f(radius * 0.17)}" opacity=".95"/>`
          + `<circle r="${f(radius * 0.32)}" fill="${glow}"/>`;
      } else {
        open += eyeShape(look.eyes, radius);
        if (lit) open += `<g color="#ffffff" fill="#ffffff" opacity=".35" transform="scale(.5)">${eyeShape(look.eyes, radius)}</g>`;
      }
      if (catchable || cyclops) {
        open += `<g class="tb-av-catch"><ellipse cx="${f(-radius * 0.3)}" cy="${f(-radius * 0.38)}" rx="${f(radius * 0.3)}" ry="${f(radius * 0.24)}" fill="#ffffff" opacity=".6"/>`
          + `<circle cx="${f(radius * 0.3)}" cy="${f(radius * 0.32)}" r="${f(radius * 0.12)}" fill="#ffffff" opacity=".6"/></g>`;
      }
      return `<g transform="translate(${f(x)} ${f(dy)})"><g class="tb-av-lid"><g class="tb-av-blink"><g class="tb-av-open">${open}</g>${happy}${shut}</g></g></g>`;
    };
    const eyes = cyclops ? eye(0, size) : eye(-gap, r) + eye(gap, r);

    let glasses = "";
    if (look.extra === "glasses") {
      const lens = size * 1.72;
      const frame = t.night ? "#e9edf3" : "#23272e";
      const one = (x) => `<circle cx="${f(x)}" cy="${f(dy)}" r="${f(lens)}" fill="#ffffff" fill-opacity=".12" stroke="${frame}" stroke-width="1.5"/>`
        + `<path d="M${f(x - lens * 0.5)} ${f(dy - lens * 0.35)}l${f(lens * 0.55)} ${f(-lens * 0.3)}" stroke="#ffffff" stroke-opacity=".55" stroke-width="1" stroke-linecap="round"/>`;
      glasses = cyclops
        ? one(0)
        : one(-gap) + one(gap) + `<path d="M${f(-gap + lens)} ${f(dy - 1)}Q0 ${f(dy - 3.5)} ${f(gap - lens)} ${f(dy - 1)}" fill="none" stroke="${frame}" stroke-width="1.4" stroke-linecap="round"/>`;
      glasses = `<g class="tb-av-glasses">${glasses}</g>`;
    }

    let mouth = "";
    const my = dy + size * tall + 4.2;
    const s = r / 5.4;
    if (hasMouth) {
      const stroke = `fill="none" stroke="currentColor" stroke-width="${f(1.7 * s)}" stroke-linecap="round" stroke-linejoin="round"`;
      const grin = `<path d="M${f(-4.6 * s)} ${f(-0.6 * s)}H${f(4.6 * s)}Q${f(4.6 * s)} ${f(5 * s)} 0 ${f(5 * s)}Q${f(-4.6 * s)} ${f(5 * s)} ${f(-4.6 * s)} ${f(-0.6 * s)}Z"/>`;
      const shapes = {
        smile: `<path d="M${f(-4 * s)} 0Q0 ${f(3.8 * s)} ${f(4 * s)} 0" ${stroke}/>`,
        grin,
        flat: `<path d="M${f(-3.4 * s)} ${f(0.6 * s)}H${f(3.4 * s)}" ${stroke}/>`,
        o: `<ellipse cy="${f(s)}" rx="${f(1.9 * s)}" ry="${f(2.3 * s)}"/>`,
      };
      mouth = `<g transform="translate(0 ${f(my)})"><g class="tb-av-m-base">${shapes[look.mouth]}</g><g class="tb-av-m-happy">${grin}</g><g class="tb-av-m-o">${shapes.o}</g></g>`;
    }
    // Speaking: a mouth that opens with the voice (speak()). Visors without a mouth pulse their eyes instead;
    // a raven opens its beak (the jaw in ravenBody).
    const talk = !spot.beak && (hasMouth || !visor) ? `<g transform="translate(0 ${f(my)})"><g class="tb-av-m-talk"><ellipse class="tb-av-talk" cy="${f(1.6 * s)}" rx="${f(2.8 * s)}" ry="${f(2.6 * s)}"/></g></g>` : "";

    const cheekX = cyclops ? size + 3.5 : gap + r * 0.55;
    const cheekY = dy + (cyclops ? size * 0.75 : r * 1.3);
    const cheek = (x) => `<ellipse cx="${f(x)}" cy="${f(cheekY)}" rx="${f(r * 0.85)}" ry="${f(r * 0.46)}"/>`;
    const cheeks = `<g class="tb-av-cheeks${look.cheeks ? "" : " off"}" fill="${lit ? "#bd8d96" : "#a16e7b"}" opacity="${lit ? 0.28 : 0.2}">${cheek(-cheekX)}${cheek(cheekX)}</g>`;

    const k = spot.k;
    const place = `translate(${spot.x} ${spot.y})${spot.transform ? ` ${spot.transform}` : ""} scale(${f(k)})`;
    return `<g class="tb-av-face" transform="${place}"><g class="tb-av-facebox">${plate}${cheeks}`
      + `<g class="tb-av-look2" color="${ink}" fill="currentColor">${mouth}${talk}${glasses}</g>`
      + `<g class="tb-av-look" color="${ink}" fill="currentColor">${eyes}</g></g></g>`;
  }

  // Every look sits a little below full size so any accessory stays inside the tile.
  // One fit for all, so two agents with the same body are the same size with or without one.
  const FIT = "translate(50 94) scale(.88) translate(-50 -94)";
  function extraMarkup(look, t, part, id, glow, still) {
    const out = { back: "", front: "", defs: "" };
    const [x, y] = part.top;
    const gold = () => linear(`${id}-au`, 'x1="0" y1="0" x2="0" y2="1"', [[0, "#d5c398"], [0.45, "#b69a60"], [1, "#85693b"]]);
    switch (look.extra) {
      case "antenna":
        out.front = `<g class="tb-av-antenna" style="transform-origin:${x}px ${y}px">`
          + `<path d="M${x} ${y + 1.5}Q${x + 0.5} ${y - 6} ${x + 3} ${y - 11.5}" fill="none" stroke="${t.deep}" stroke-width="1.9" stroke-linecap="round"/>`
          + `<circle class="tb-av-bulb" cx="${x + 3.2}" cy="${y - 13.5}" r="4" fill="url(#${id}-gl)"/>`
          + `<circle cx="${x + 3.2}" cy="${y - 13.5}" r="2.3" fill="${glow}"/><circle cx="${x + 2.1}" cy="${y - 14.6}" r=".6" fill="#ffffff" opacity=".65"/></g>`;
        break;
      case "sprout":
        out.defs = linear(`${id}-lf`, 'x1="0" y1="0" x2="1" y2="1"', [[0, "#85a789"], [1, "#426955"]]);
        out.front = `<g class="tb-av-sprout" style="transform-origin:${x}px ${y}px">`
          + `<path d="M${x} ${y + 1.5}C${x} ${y - 3} ${x + 1} ${y - 6.5} ${x + 0.5} ${y - 9.5}" fill="none" stroke="#4f8f4a" stroke-width="1.8" stroke-linecap="round"/>`
          + `<path d="M${x + 0.5} ${y - 8.5}C${x - 4} ${y - 15.5} ${x - 12} ${y - 14} ${x - 13} ${y - 10}C${x - 9} ${y - 6} ${x - 3} ${y - 6} ${x + 0.5} ${y - 8.5}Z" fill="url(#${id}-lf)"/>`
          + `<path d="M${x + 0.5} ${y - 9.5}C${x + 3} ${y - 17} ${x + 10} ${y - 18} ${x + 12.5} ${y - 15}C${x + 10.5} ${y - 10} ${x + 4} ${y - 9} ${x + 0.5} ${y - 9.5}Z" fill="url(#${id}-lf)"/>`
          + `<path d="M${x + 0.5} ${y - 9}Q${x - 6} ${y - 11.5} ${x - 11} ${y - 10.6}" fill="none" stroke="#ffffff" stroke-opacity=".45" stroke-width=".7"/></g>`;
        break;
      case "halo": {
        out.defs = gold();
        const [hx, hy] = part.peak || part.top;
        const ring = `cx="${hx}" cy="${hy - 8}" rx="15" ry="4.3" fill="none"`;
        out.front = `<g class="tb-av-halo-ring"><ellipse ${ring} stroke="#b69a60" stroke-opacity=".1" stroke-width="3"/>`
          + `<ellipse ${ring} stroke="url(#${id}-au)" stroke-width="1.7"/>`
          + `<ellipse ${ring} stroke="#ece2cb" stroke-opacity=".5" stroke-width=".55" stroke-dasharray="9 30"/></g>`;
        break;
      }
      case "crown": {
        out.defs = gold();
        const d = 'M' + (x - 11) + ' ' + (y + 2) + 'L' + (x - 12) + ' ' + (y - 8) + 'L' + (x - 5) + ' ' + (y - 3) + 'L' + x + ' ' + (y - 11) + 'L' + (x + 5) + ' ' + (y - 3) + 'L' + (x + 12) + ' ' + (y - 8) + 'L' + (x + 11) + ' ' + (y + 2) + 'Z';
        out.front = '<g class="tb-av-crown"><path d="' + d + '" fill="url(#' + id + '-au)" stroke="#80673f" stroke-width=".65" stroke-linejoin="round"/>'
          + '<path d="M' + (x - 10) + ' ' + y + 'H' + (x + 10) + '" stroke="#e5d7b5" stroke-opacity=".4" stroke-width=".7"/></g>';
        break;
      }
      case "headset": {
        const [left, right, sy] = part.sides;
        const mic = [part.face.x - 7 * part.face.k, part.face.y + 11 * part.face.k];
        const band = `M${left - 1.5} ${sy}C${left - 1.5} ${y - 13} ${right + 1.5} ${y - 13} ${right + 1.5} ${sy}`;
        out.back = `<path d="${band}" fill="none" stroke="#2b2e35" stroke-width="2.4" stroke-linecap="round"/><path d="${band}" fill="none" stroke="#666c78" stroke-width=".9" stroke-linecap="round" transform="translate(0 -.9)"/>`;
        const cup = (cx) => `<rect x="${cx - 3.4}" y="${sy - 7}" width="6.8" height="14" rx="2.4" fill="#2b2e35"/><rect x="${cx - 1.4}" y="${sy - 5.8}" width="2.8" height="11.6" rx="1.4" fill="${glow}" opacity=".9"/>`;
        out.front = `<g class="tb-av-headset">${cup(left - 1)}${cup(right + 1)}`
          + `<path d="M${left - 1} ${sy + 7}Q${left + 2} ${mic[1] + 4} ${f(mic[0])} ${f(mic[1])}" fill="none" stroke="#2b2e35" stroke-width="1.6" stroke-linecap="round"/>`
          + `<circle cx="${f(mic[0])}" cy="${f(mic[1])}" r="2.3" fill="#2b2e35"/><circle class="tb-av-mic" cx="${f(mic[0])}" cy="${f(mic[1])}" r="1" fill="#ff6b6b"/></g>`;
        break;
      }
      case "orbit": {
        const [cx, cy] = part.center;
        const rx = Math.min(47, (part.sides[1] - part.sides[0]) / 2 + 13);
        const ry = 10;
        const d = `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`;
        out.defs = `<clipPath id="${id}-ob"><rect x="${cx - 60}" y="${cy - 40}" width="120" height="40"/></clipPath>`
          + `<clipPath id="${id}-of"><rect x="${cx - 60}" y="${cy}" width="120" height="40"/></clipPath>`
          + radial(`${id}-mo`, 'cx=".35" cy=".3" r=".7"', [[0, "#cdd8dc"], [0.45, glow], [1, t.deep]]);
        const moon = still
          ? `<circle cx="${f(cx + rx * 0.6)}" cy="${f(cy + ry * 0.8)}" r="3.2" fill="url(#${id}-mo)"/>`
          : `<circle r="3.2" fill="url(#${id}-mo)"><animateMotion dur="9s" repeatCount="indefinite" path="${d}"/></circle>`;
        const half = (clip, opacity) => `<g transform="rotate(-14 ${cx} ${cy})"><g clip-path="url(#${id}-${clip})"><path d="${d}" fill="none" stroke="${t.deep}" stroke-opacity="${opacity}" stroke-width="1.1"/>${moon}</g></g>`;
        out.back = half("ob", 0.22);
        out.front = half("of", 0.45);
        break;
      }
      default:
        break;
    }
    return out;
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  }

  function markMarkup(look, name, part, t, glow) {
    const spot = part.mark;
    let content = "";
    let paint = "fill";
    if (look.mark === "initials") {
      const text = initials(name);
      if (!text) return "";
      const size = Array.from(text).length > 1 ? spot.two : spot.one;
      content = `<text x="0" y="${(size * 0.35).toFixed(2)}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="600" letter-spacing="${Array.from(text).length > 1 ? -0.4 : 0}">${escapeText(text)}</text>`;
    } else if (GLYPHS[look.mark]) {
      const scale = spot.glyph / 24;
      content = `<path transform="translate(${-spot.glyph / 2} ${-spot.glyph / 2}) scale(${scale.toFixed(4)})" d="${GLYPHS[look.mark]}" fill="none" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`;
      paint = "stroke";
    }
    if (!content) return "";
    const place = `translate(${spot.x} ${spot.y})${spot.transform ? ` ${spot.transform}` : ""}`;
    if (spot.lit) return `<g class="tb-av-mark" transform="${place}"><g ${paint}="${glow}" opacity=".95">${content}</g></g>`;
    const glass = look.material === "glass";
    const light = !t.dark && !glass;
    const ink = glass ? "#ffffff" : light ? t.deep : t.hi;
    const inkOpacity = glass ? 0.94 : light ? 0.76 : 0.9;
    const edge = glass ? t.deep : light ? "#ffffff" : "#000000";
    const edgeOpacity = glass ? 0.6 : light ? 0.7 : 0.32;
    const offset = light || glass ? ".55 .75" : "-.45 -.6";
    return `<g class="tb-av-mark" transform="${place}">`
      + `<g transform="translate(${offset})" ${paint}="${edge}" opacity="${edgeOpacity}">${content}</g>`
      + `<g ${paint}="${ink}" opacity="${inkOpacity}">${content}</g></g>`;
  }

  function markup(input, options = {}) {
    const look = normalize(input, options);
    const color = look.color || validColor(options.color) || FALLBACK;
    const isRaven = look.shape === "raven";
    const t = isRaven ? ravenTones(color, look.material) : tones(color, look.material);
    const id = `tbav${(uid += 1).toString(36)}`;
    const glass = look.material === "glass";
    const m = MATERIAL[look.material];
    const part = BUILDERS[look.shape](t, id, m, glass, options.extras === false ? { ...look, extra: "none" } : look);
    // Dark ravens look out with the logo's amber eye unless an eye light was picked.
    const glow = look.glow || (isRaven ? "#ffb547" : t.led);
    const showFace = look.face !== "none" && options.face !== false;
    const face = showFace ? faceMarkup(look, t, part, id, glow) : "";
    const showMark = (!showFace || (isRaven && look.face === "visor")) && options.mark !== false && !(options.size && options.size < 24);
    const mark = showMark ? markMarkup(look, options.name, part, t, glow) : "";
    const still = motionLevel !== "full" || reduced.matches;
    const extra = isRaven || options.extras === false ? { back: "", front: "", defs: "" } : extraMarkup(look, t, part, id, glow, still);
    const [left, top, width, height] = part.shadow;
    const shade = glass ? `${t.shade}66` : t.dark ? "rgba(0,0,0,.42)" : "rgba(20,24,36,.3)";
    return `<span class="tb-av-glow" style="--av-glow:${t.glow}"></span>`
      + `<span class="tb-av-shadow" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;--av-shade:${shade}"></span>`
      + `<span class="tb-av-float"><span class="tb-av-hop"><svg class="tb-av-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">`
      + `<defs>${shared(id, t, glow)}${part.defs}${extra.defs}<clipPath id="${id}-c">${part.clip}</clipPath></defs>`
      + (!isRaven && look.material === "metal" ? linear(`${id}-mt`, 'gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="0" y2="92"', [[0, "#ffffff", 0.12], [0.46, "#ffffff", 0], [0.5, t.deep, 0.42], [0.6, t.deep, 0.08], [0.8, "#ffffff", 0.06], [1, "#ffffff", 0.2]]) : "")
      + `<g transform="${isRaven ? "translate(50 96) scale(.94) translate(-50 -96)" : FIT}"><g class="tb-av-obj">${extra.back}${part.body}`
      + (!isRaven && look.material === "metal" ? `<g clip-path="url(#${id}-c)"><rect width="100" height="100" fill="url(#${id}-mt)"/></g>` : "")
      + `${mark}${isRaven ? `<g class="tb-rv-head">${part.head}${face}${part.over}</g>` : face + (part.over || "")}`
      + `<g clip-path="url(#${id}-c)"><g class="tb-av-spec">${part.spec}</g></g>${extra.front}</g></g>`
      + "</svg></span></span><span class=\"tb-av-bubble\" aria-hidden=\"true\"></span>";
  }

  // ---- Life: blinks, glances, gaze, moods and reactions ------------------------------------

  const reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const live = typeof document === "undefined" ? [] : document.getElementsByClassName("tb-avatar");
  const lives = new WeakMap();
  const rendered = new WeakMap();
  const reactions = new Map();
  const pointer = { x: 0, y: 0, active: false, at: 0 };
  let attention = null;
  let motionLevel = "full";
  let frame = 0;
  let watching = false;
  if (typeof document !== "undefined") {
    try {
      const saved = localStorage.getItem("ravnir.avatarMotion");
      if (["full", "subtle", "off"].includes(saved)) motionLevel = saved;
    } catch {
      // Storage blocked: full motion.
    }
    document.documentElement.dataset.avMotion = motionLevel;
  }

  const rand = ([low, high]) => low + Math.random() * (high - low);
  const between = (low, high) => low + Math.random() * (high - low);
  const clamp = (value) => Math.max(-1, Math.min(1, value));

  function lifeOf(node, now) {
    let life = lives.get(node);
    if (!life) {
      life = { blinkAt: now + between(400, 4200), glanceAt: now + between(600, 3600), gx: 0, gy: 0, near: false, read: 0 };
      lives.set(node, life);
    }
    return life;
  }

  function express(node) {
    const sleeping = node.dataset.mood === "sleeping";
    const look = sleeping ? "sleeping" : node.dataset.react || node.dataset.mood || "idle";
    if (node.dataset.x !== look) node.dataset.x = look;
  }

  function setState(node, state) {
    if (!node?.classList?.contains("tb-avatar")) return;
    const mood = MOODS.includes(state) ? state : "";
    if (mood === "sleeping") {
      clearTimeout(node.__tbRavenTap);
      node.classList.remove("is-raven-tap");
    }
    node.classList.toggle("is-working", mood === "working");
    if (mood) node.dataset.mood = mood;
    else delete node.dataset.mood;
    const description = { working: "Working", waiting: "Needs your attention", sleeping: "Paused", happy: "Done", speaking: "Speaking" }[mood];
    if (description) node.setAttribute("aria-description", description);
    else node.removeAttribute("aria-description");
    express(node);
  }

  function applyReaction(node, kind, ms) {
    clearTimeout(node.__tbReact);
    node.dataset.react = kind;
    express(node);
    node.__tbReact = setTimeout(() => {
      delete node.dataset.react;
      express(node);
    }, ms);
  }

  // A short expression on every avatar of one agent (by id) or on one node. Avatars drawn
  // while it lasts pick it up too, so a thread that re-renders keeps the smile.
  function react(target, kind = "happy", ms = 2200) {
    if (!target || typeof document === "undefined") return;
    if (typeof target === "string") {
      reactions.set(target, { kind, until: Date.now() + ms });
      const safe = target.replace(/["\\]/g, "\\$&");
      for (const node of document.querySelectorAll(`.tb-avatar[data-bot="${safe}"]`)) applyReaction(node, kind, ms);
      return;
    }
    if (target.classList?.contains("tb-avatar")) applyReaction(target, kind, ms);
  }

  // While an agent talks, its mouth (or a visor's eyes) follows the loudness of the voice, 0 to 1.
  // With motion off the mouth stays half open, so it still reads as talking without moving.
  function speak(target, level = 0) {
    if (!target || typeof document === "undefined") return;
    const amount = Math.max(0, Math.min(1, Number(level) || 0));
    const value = (motionLevel === "off" || reduced.matches ? (amount > 0.05 ? 0.4 : 0) : amount).toFixed(3);
    const nodes = typeof target === "string" ? document.querySelectorAll(`.tb-avatar[data-bot="${target.replace(/["\\]/g, "\\$&")}"]`) : [target];
    for (const node of nodes) node?.style?.setProperty("--av-talk", value);
  }

  // Look at something for a moment: an element (the composer while you type) or a point.
  function attend(target, ms = 1600) {
    attention = target ? { target, until: performance.now() + ms } : null;
    schedule();
  }

  function attentionPoint() {
    const target = attention?.target;
    if (!target) return null;
    if (typeof target.getBoundingClientRect === "function") {
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return Number.isFinite(target.x) && Number.isFinite(target.y) ? target : null;
  }

  function blink(node, twice) {
    node.classList.add("is-blink");
    setTimeout(() => {
      node.classList.remove("is-blink");
      if (twice) setTimeout(() => blink(node, false), 110);
    }, 170);
  }

  function notice(node) {
    if (motionLevel !== "full" || reduced.matches) return;
    node.classList.add("is-notice");
    clearTimeout(node.__tbNotice);
    node.__tbNotice = setTimeout(() => node.classList.remove("is-notice"), 700);
  }

  function pet(node) {
    if (motionLevel === "off" || reduced.matches || node.dataset.mood === "sleeping") return;
    if (node.dataset.shape === "raven") {
      if (node.dataset.mood === "sleeping") return;
      node.classList.remove("is-raven-tap");
      void node.offsetWidth;
      node.classList.add("is-raven-tap");
      clearTimeout(node.__tbRavenTap);
      node.__tbRavenTap = setTimeout(() => node.classList.remove("is-raven-tap"), 1100);
      return;
    }
    node.classList.remove("is-squish");
    void node.offsetWidth;
    node.classList.add("is-squish");
    clearTimeout(node.__tbSquish);
    node.__tbSquish = setTimeout(() => node.classList.remove("is-squish"), 460);
    if (node.dataset.mood === "sleeping") return;
    applyReaction(node, "happy", 1500);
    if (node.getBoundingClientRect().width < 56) return;
    const heart = document.createElement("span");
    heart.className = "tb-av-heart";
    heart.style.left = `${38 + Math.random() * 24}%`;
    heart.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1z" fill="#ff5a7a"/></svg>';
    node.append(heart);
    setTimeout(() => heart.remove(), 1000);
  }

  function glanceFor(persona, mood, life, kind) {
    if (motionLevel !== "full" || reduced.matches) return [0, 0];
    if (mood === "working") {
      life.read = (life.read + 1) % 4;
      return [[-0.55, -0.15, 0.25, 0.6][life.read], 0.42];
    }
    if (mood === "waiting" || mood === "speaking") return [between(-0.12, 0.12), -0.05];
    if (Math.random() < 0.35) return [0, 0];
    if (kind === "focused") return [between(-0.3, 0.3), between(0.3, 0.55)];
    if (kind === "shy") return [between(-0.8, 0.8), between(0.25, 0.6)];
    const angle = Math.random() * Math.PI * 2;
    const reach = persona.radius * (0.5 + Math.random() * 0.5);
    return [Math.cos(angle) * reach, Math.sin(angle) * reach * 0.7];
  }

  function tick() {
    if (document.hidden || !live.length) return;
    const now = performance.now();
    for (const node of live) {
      const life = lifeOf(node, now);
      const kind = node.dataset.personality;
      const persona = PERSONA[kind] || PERSONA.calm;
      const mood = node.dataset.x;
      if (motionLevel !== "off" && !reduced.matches && mood !== "sleeping" && now >= life.blinkAt) {
        blink(node, Math.random() < 0.14);
        life.blinkAt = now + rand(persona.blink) * (mood === "working" ? 1.5 : 1);
      }
      if (now >= life.glanceAt) {
        [life.gx, life.gy] = glanceFor(persona, mood, life, kind);
        life.glanceAt = now + (mood === "working" ? between(700, 1500) : rand(persona.glance));
      }
    }
    schedule();
  }

  function schedule() {
    if (frame || typeof requestAnimationFrame !== "function") return;
    frame = requestAnimationFrame(update);
  }

  function setVar(node, name, value) {
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  }

  // Eyes and head follow, in order: what you are typing into, your pointer (while it moves),
  // then the avatar's own glances. Working avatars read; sleeping ones stay put.
  function update() {
    frame = 0;
    const nodes = Array.from(live);
    if (!nodes.length) return;
    const now = performance.now();
    const height = window.innerHeight;
    const width = window.innerWidth;
    if (attention && attention.until <= now) attention = null;
    const focus = attention ? attentionPoint() : null;
    const tracking = pointer.active && now - pointer.at < 4000;
    const rects = nodes.map((node) => node.getBoundingClientRect());
    nodes.forEach((node, index) => {
      const rect = rects[index];
      if (!rect.width || rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) return;
      const life = lifeOf(node, now);
      const kind = node.dataset.personality;
      const persona = PERSONA[kind] || PERSONA.calm;
      const mood = node.dataset.x;
      let x = life.gx;
      let y = life.gy;
      let near = false;
      if (motionLevel === "off" || reduced.matches) {
        x = 0;
        y = 0;
      } else if (mood === "sleeping") {
        x = 0;
        y = 0.25;
      } else if (mood !== "working" && (focus || tracking)) {
        const target = focus || pointer;
        const dx = target.x - (rect.left + rect.width / 2);
        const dy = target.y - (rect.top + rect.height / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.max(120, rect.width * 2.5);
        const strength = distance < reach ? distance / reach : Math.sqrt(reach / distance);
        x = (dx / distance) * strength * persona.gain;
        y = (dy / distance) * strength * persona.gain;
        near = !focus && distance < Math.max(rect.width * 0.85, 44);
        if (near && kind === "shy") {
          x = -x * 0.9 - Math.sign(dx || 1) * 0.4;
          y = 0.5;
        }
      }
      if (near !== life.near) {
        life.near = near;
        if (near) notice(node);
      }
      node.classList.toggle("is-bashful", near && kind === "shy");
      setVar(node, "--av-x", clamp(x).toFixed(3));
      setVar(node, "--av-y", clamp(y).toFixed(3));
    });
  }

  function watch() {
    if (watching || typeof window === "undefined") return;
    watching = true;
    const leave = () => {
      pointer.active = false;
      schedule();
    };
    window.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;
      pointer.at = performance.now();
      schedule();
    }, { passive: true });
    document.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const node = event.target?.closest?.(".tb-avatar");
      if (node) pet(node);
    }, { passive: true, capture: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    reduced.addEventListener?.("change", refreshMotion);
    setInterval(tick, 180);
  }

  function render(node, input, options = {}) {
    if (!node) return null;
    const look = normalize(input, options);
    rendered.set(node, { look, options: { ...options } });
    const key = JSON.stringify([look, options.name || "", options.color || "", options.mark !== false, options.face !== false, options.extras !== false, motionLevel, reduced.matches]);
    const fresh = node.__tbKey !== key;
    if (fresh) {
      node.innerHTML = markup(look, options);
      node.__tbKey = key;
    }
    // Animations restart when a node is drawn or put back into the page, so their phase comes
    // from the wall clock: an avatar redrawn on a poll keeps floating and breathing where it was.
    if (fresh || !node.isConnected) {
      const offset = hash(options.seed || options.name);
      const persona = PERSONA[look.personality];
      node.style.setProperty("--av-delay", `${-(((Date.now() + offset) % 7000) / 1000).toFixed(2)}s`);
      node.style.setProperty("--av-breath", `${persona.breath}s`);
      node.style.setProperty("--av-bdelay", `${-(((Date.now() + offset) % (persona.breath * 1000)) / 1000).toFixed(2)}s`);
      node.style.setProperty("--av-amp", persona.amp);
    }
    node.classList.add("tb-avatar");
    node.dataset.shape = look.shape;
    node.dataset.material = look.material;
    node.dataset.personality = look.personality;
    node.dataset.face = look.shape === "raven" && look.face !== "none" ? "surface" : look.face === "visor" || look.shape === "screen" ? "visor" : look.face;
    if (options.bot) node.dataset.bot = options.bot;
    else delete node.dataset.bot;
    setState(node, options.state);
    const pending = options.bot && reactions.get(options.bot);
    if (pending && pending.until > Date.now() && node.dataset.react !== pending.kind) applyReaction(node, pending.kind, pending.until - Date.now());
    if (options.name !== undefined) {
      node.setAttribute("role", "img");
      node.setAttribute("aria-label", options.label || `${options.name || "Agent"} avatar`);
    }
    watch();
    schedule();
    return look;
  }

  function clear(node) {
    if (!node) return;
    node.classList.remove("tb-avatar", "is-working", "is-blink", "is-notice", "is-bashful", "is-squish", "is-raven-tap");
    clearTimeout(node.__tbRavenTap);
    rendered.delete(node);
    for (const name of ["shape", "material", "personality", "face", "bot", "mood", "react", "x"]) delete node.dataset[name];
    for (const name of ["--av-delay", "--av-x", "--av-y", "--av-breath", "--av-bdelay", "--av-amp", "--av-talk"]) node.style.removeProperty(name);
    node.removeAttribute("role");
    node.removeAttribute("aria-label");
    node.removeAttribute("aria-description");
    node.__tbKey = "";
    node.replaceChildren();
  }

  function glyph(mark) {
    if (!GLYPHS[mark]) return "";
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${GLYPHS[mark]}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function refreshMotion() {
    for (const node of Array.from(live)) {
      const previous = rendered.get(node);
      if (previous) render(node, previous.look, { ...previous.options, state: node.dataset.mood || "" });
    }
    schedule();
  }

  function setMotion(level) {
    motionLevel = ["full", "subtle", "off"].includes(level) ? level : "full";
    try {
      localStorage.setItem("ravnir.avatarMotion", motionLevel);
    } catch {
      // Storage blocked: the choice lasts until reload.
    }
    if (typeof document !== "undefined") document.documentElement.dataset.avMotion = motionLevel;
    refreshMotion();
  }

  const CSS = `
.tb-avatar { position: relative; container-type: inline-size; background: transparent !important; box-shadow: none !important; overflow: visible !important; --av-x: 0; --av-y: 0; -webkit-tap-highlight-color: transparent; }
.tb-avatar > span { position: absolute; pointer-events: none; }
.tb-av-glow { inset: -16%; border-radius: 50%; background: radial-gradient(closest-side, var(--av-glow), transparent); opacity: 0; transition: opacity .5s ease; }
.tb-avatar.is-working .tb-av-glow { animation: tb-av-breathe 2.8s ease-in-out infinite; }
.tb-avatar[data-x="waiting"] .tb-av-glow { background: radial-gradient(closest-side, #ffb340, transparent); animation: tb-av-breathe 2.2s ease-in-out infinite; }
.tb-av-shadow { border-radius: 50%; background: radial-gradient(closest-side, var(--av-shade), transparent); translate: calc(var(--av-x) * -5%) 0; transition: translate .6s cubic-bezier(.2, .7, .2, 1); animation: tb-av-shadow 7s ease-in-out infinite; animation-delay: var(--av-delay, 0s); }
.tb-av-float { inset: 0; animation: tb-av-float 7s ease-in-out infinite; animation-delay: var(--av-delay, 0s); }
.tb-av-hop { inset: 0; transform-origin: 50% 88%; transition: rotate .8s cubic-bezier(.2, .7, .2, 1); }
.tb-avatar[data-personality="curious"]:not([data-x="sleeping"]) .tb-av-hop { rotate: calc(var(--av-x) * 7deg); }
.tb-av-svg { display: block; width: 100%; height: 100%; overflow: visible; transform: perspective(320cqw) rotateY(calc(var(--av-x) * 10deg)) rotateX(calc(var(--av-y) * -10deg)); transition: transform .7s cubic-bezier(.2, .7, .2, 1); }
.tb-av-obj { transform-origin: 50px 90px; animation: tb-av-breath var(--av-breath, 5s) ease-in-out infinite; animation-delay: var(--av-bdelay, 0s); }
.tb-av-spec { transform: translate(calc(var(--av-x) * 9px), calc(var(--av-y) * 9px)); transition: transform .6s cubic-bezier(.2, .7, .2, 1); }
.tb-av-facebox { transform: translate(calc(var(--av-x) * 2px), calc(var(--av-y) * 1.5px)); transition: transform .55s cubic-bezier(.2, .7, .2, 1), opacity .4s; }
.tb-av-look { transform: translate(calc(var(--av-x) * 3.6px), calc(var(--av-y) * 2.8px)); transition: transform .14s cubic-bezier(.25, .8, .3, 1); }
.tb-av-look2 { transform: translate(calc(var(--av-x) * 1.6px), calc(var(--av-y) * 1.2px)); transition: transform .3s cubic-bezier(.2, .7, .2, 1); }
.tb-av-catch { transform: translate(calc(var(--av-x) * -1px), calc(var(--av-y) * -.8px)); transition: transform .14s ease; }
.tb-av-lid, .tb-av-blink { transform-box: fill-box; transform-origin: center; }
.tb-av-lid { transition: transform .26s cubic-bezier(.3, 1.5, .5, 1); }
.tb-avatar[data-x="working"] .tb-av-lid { transform: scaleY(.68); }
.tb-avatar[data-x="waiting"] .tb-av-lid, .tb-avatar.is-notice .tb-av-lid { transform: scale(1.15); }
.tb-avatar.is-blink .tb-av-blink { animation: tb-av-blink .17s ease-in-out; }
.tb-av-happy, .tb-av-shut, .tb-av-m-happy, .tb-av-m-o { display: none; }
.tb-avatar[data-x="happy"] .tb-av-open, .tb-avatar[data-x="sleeping"] .tb-av-open { display: none; }
.tb-avatar[data-x="happy"] .tb-av-happy, .tb-avatar[data-x="sleeping"] .tb-av-shut { display: inline; }
.tb-avatar[data-x="happy"] .tb-av-m-base, .tb-avatar[data-x="waiting"] .tb-av-m-base, .tb-avatar.is-notice:not([data-x="happy"]) .tb-av-m-base { display: none; }
.tb-avatar[data-x="happy"] .tb-av-m-happy, .tb-avatar[data-x="waiting"] .tb-av-m-o, .tb-avatar.is-notice:not([data-x="happy"]) .tb-av-m-o { display: inline; }
.tb-av-m-talk { display: none; }
.tb-avatar[data-x="speaking"] .tb-av-m-talk { display: inline; }
.tb-avatar[data-x="speaking"] :is(.tb-av-m-base, .tb-av-m-o, .tb-av-m-happy) { display: none; }
.tb-av-talk { transform-box: fill-box; transform-origin: 50% 25%; transform: scale(calc(.7 + var(--av-talk, 0) * .45), calc(.16 + var(--av-talk, 0) * 1.05)); transition: transform .07s linear; }
.tb-avatar[data-x="speaking"][data-face="visor"] .tb-av-open { transform-box: fill-box; transform-origin: center; transform: scaleY(calc(.7 + var(--av-talk, 0) * .55)); transition: transform .07s linear; }
.tb-avatar[data-x="speaking"] .tb-av-glow { opacity: calc(.15 + var(--av-talk, 0) * .55); }
.tb-avatar[data-x="speaking"] .tb-av-hop { transform: scale(calc(1 + var(--av-talk, 0) * .012), calc(1 + var(--av-talk, 0) * .028)); transition: transform .07s linear; }
.tb-av-cheeks { transition: opacity .4s ease; }
.tb-av-cheeks.off { opacity: 0; }
.tb-avatar.is-bashful .tb-av-cheeks, .tb-avatar[data-x="happy"] .tb-av-cheeks { opacity: .75; }
.tb-avatar[data-x="sleeping"] .tb-av-obj { animation-duration: 8s; }
.tb-avatar[data-x="sleeping"] .tb-av-facebox { opacity: .8; }
.tb-avatar[data-x="happy"] .tb-av-hop { animation: tb-av-hop .62s cubic-bezier(.3, .7, .4, 1) 2; }
.tb-avatar[data-x="waiting"] .tb-av-hop { animation: tb-av-nudge 2.8s ease-in-out infinite; }
.tb-avatar.is-notice[data-personality="cheerful"]:not([data-x="happy"]) .tb-av-hop { animation: tb-av-hop .6s cubic-bezier(.3, .7, .4, 1); }
.tb-avatar.is-squish .tb-av-hop { animation: tb-av-squish .45s cubic-bezier(.3, 1.4, .5, 1); }
.tb-av-antenna { animation: tb-av-sway 3.6s ease-in-out infinite; animation-delay: var(--av-bdelay, 0s); }
.tb-av-sprout { animation: tb-av-sway 4.8s ease-in-out infinite; animation-delay: var(--av-bdelay, 0s); }
.tb-av-bulb { transition: opacity .3s; }
.tb-avatar.is-working .tb-av-bulb, .tb-avatar[data-x="waiting"] .tb-av-bulb { animation: tb-av-pulse .9s ease-in-out infinite; }
.tb-avatar[data-x="sleeping"] .tb-av-bulb { opacity: .15; }
.tb-av-mic { opacity: .25; }
.tb-avatar.is-working .tb-av-mic { animation: tb-av-pulse .7s ease-in-out infinite; }
.tb-av-halo-ring { animation: tb-av-bob 3.4s ease-in-out infinite; }
.tb-av-glint { transform-box: fill-box; transform-origin: center; animation: tb-av-glint 4.2s ease-in-out infinite; }
.tb-av-bubble { display: none; right: -10%; top: -12%; width: min(42%, 46px); aspect-ratio: 1; border-radius: 50%; place-items: center; font: 800 min(26cqw, 28px)/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #fff; z-index: 2; }
.tb-avatar[data-x="waiting"] > .tb-av-bubble { display: grid; background: #ff9f0a; box-shadow: 0 0 0 2px var(--surface, #fff), 0 2px 6px rgba(0, 0, 0, .18); animation: tb-av-pop 2.8s ease-in-out infinite; }
.tb-avatar[data-x="waiting"] > .tb-av-bubble::after { content: "!"; }
.tb-avatar[data-x="sleeping"] > .tb-av-bubble { display: block; width: auto; aspect-ratio: auto; right: -4%; top: -8%; color: var(--faint, #8e8e93); font-size: min(24cqw, 30px); font-weight: 700; }
.tb-avatar[data-x="sleeping"] > .tb-av-bubble::after { content: "z"; display: inline-block; animation: tb-av-z 3.2s ease-in-out infinite; }
.tb-av-heart { top: 0; width: 30%; translate: -50% 0; animation: tb-av-heart 1s ease-out forwards; z-index: 3; }
.tb-av-heart svg { display: block; width: 100%; height: auto; }
@keyframes tb-av-float { 0%, 100% { transform: translateY(1%); } 50% { transform: translateY(-2.6%); } }
@keyframes tb-av-shadow { 0%, 100% { scale: 1; opacity: 1; } 50% { scale: .88; opacity: .75; } }
@keyframes tb-av-breathe { 0%, 100% { opacity: .3; transform: scale(.9); } 50% { opacity: .95; transform: scale(1.06); } }
@keyframes tb-av-breath { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(calc(1 - var(--av-amp, .014)), calc(1 + var(--av-amp, .014))); } }
@keyframes tb-av-blink { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(.06); } }
@keyframes tb-av-hop { 0% { transform: none; } 18% { transform: scale(1.07, .9); } 48% { transform: translateY(-13%) scale(.95, 1.06); } 78% { transform: scale(1.04, .95); } 100% { transform: none; } }
@keyframes tb-av-nudge { 0%, 60%, 100% { transform: none; } 68% { transform: translateY(-7%) scale(.97, 1.03); } 76% { transform: none; } 82% { transform: translateY(-3%); } 88% { transform: none; } }
@keyframes tb-av-squish { 0% { transform: none; } 30% { transform: scale(1.14, .84); } 62% { transform: scale(.95, 1.06); } 100% { transform: none; } }
@keyframes tb-av-sway { 0%, 100% { transform: rotate(-7deg); } 50% { transform: rotate(7deg); } }
@keyframes tb-av-pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
@keyframes tb-av-bob { 0%, 100% { transform: translateY(-1.2px); } 50% { transform: translateY(1.4px); } }
@keyframes tb-av-glint { 0%, 70%, 100% { transform: scale(0); opacity: 0; } 80% { transform: scale(1); opacity: 1; } 90% { transform: scale(.2); opacity: 0; } }
@keyframes tb-av-pop { 0%, 60%, 100% { transform: scale(1); } 68% { transform: scale(1.18); } 76% { transform: scale(1); } }
@keyframes tb-av-z { 0% { opacity: 0; transform: translate(0, 30%) scale(.6); } 30% { opacity: 1; } 100% { opacity: 0; transform: translate(40%, -60%) scale(1.1); } }
@keyframes tb-av-heart { 0% { opacity: 0; transform: translateY(10%) scale(.4); } 25% { opacity: 1; transform: translateY(-30%) scale(1.1); } 100% { opacity: 0; transform: translateY(-140%) scale(.9); } }
/* Adult proportions, expressive behavior. Flight follows the real mood, not transient reactions. */
.tb-avatar[data-shape="raven"] { --rv-beat: 2.8s; --rv-lift: -4px; }
.tb-avatar[data-shape="raven"][data-personality="cheerful"] { --rv-beat: 1.9s; --rv-lift: -8px; }
.tb-avatar[data-shape="raven"][data-personality="curious"] { --rv-beat: 2.3s; --rv-lift: -6px; }
.tb-avatar[data-shape="raven"][data-personality="focused"] { --rv-beat: 3.6s; --rv-lift: -2px; }
.tb-avatar[data-shape="raven"][data-personality="shy"] { --rv-beat: 3.1s; --rv-lift: -3px; }
.tb-avatar[data-shape="raven"] :is(.tb-av-glow, .tb-av-heart) { display: none; }
.tb-avatar[data-shape="raven"] :is(.tb-av-float, .tb-av-shadow, .tb-av-hop) { animation: none; transform: none; rotate: none; }
.tb-avatar[data-shape="raven"] .tb-av-hop { animation: none !important; transform: none !important; rotate: none !important; }
.tb-avatar[data-shape="raven"] .tb-av-shadow { opacity: .4; translate: none; }
.tb-avatar[data-shape="raven"] .tb-av-svg { transform: none; }
.tb-avatar[data-shape="raven"] .tb-av-obj { animation: tb-rv-breath 9s ease-in-out infinite; }
.tb-rv-head { transform-origin: 57px 39px; transform: rotate(calc(var(--av-x) * 2deg)); transition: transform .9s cubic-bezier(.2, .7, .2, 1); }
.tb-rv-jaw { transform-origin: 71px 30px; transition: transform .07s linear; }
.tb-avatar[data-shape="raven"][data-x="working"] .tb-rv-head { animation: tb-rv-observe 9s ease-in-out infinite; }
.tb-avatar[data-shape="raven"][data-x="waiting"] .tb-rv-head { transform: rotate(-4deg); }
.tb-avatar[data-shape="raven"][data-x="happy"] .tb-rv-head { transform: rotate(-2deg); }
.tb-avatar[data-shape="raven"][data-x="happy"] .tb-av-open { display: inline; }
.tb-avatar[data-shape="raven"][data-x="sleeping"] .tb-rv-head { transform: rotate(7deg); }
.tb-avatar[data-shape="raven"][data-x="sleeping"] .tb-av-svg { opacity: .72; }
.tb-avatar[data-shape="raven"][data-x="speaking"] .tb-rv-jaw { transform: rotate(calc(var(--av-talk, 0) * 12deg)); }
.tb-avatar[data-shape="raven"] > .tb-av-bubble { display: none; width: clamp(3px, 9cqw, 7px); height: clamp(3px, 9cqw, 7px); aspect-ratio: 1; right: 3%; top: 21%; border-radius: 50%; box-shadow: 0 0 0 1.5px var(--surface, #fff); animation: none; }
.tb-avatar[data-shape="raven"][data-mood] > .tb-av-bubble { display: block; }
.tb-avatar[data-shape="raven"][data-x="working"] > .tb-av-bubble { background: #718c7a; animation: tb-rv-signal 3.8s ease-in-out infinite; }
.tb-avatar[data-shape="raven"][data-x="waiting"] > .tb-av-bubble { background: #b68b4e; animation: tb-rv-signal 2.8s ease-in-out infinite; }
.tb-avatar[data-shape="raven"][data-x="happy"] > .tb-av-bubble { background: #4f7b65; }
.tb-avatar[data-shape="raven"][data-x="sleeping"] > .tb-av-bubble { background: #7c8791; }
.tb-avatar[data-shape="raven"][data-x="speaking"] > .tb-av-bubble { background: #7189a5; }
.tb-avatar[data-shape="raven"] > .tb-av-bubble::after { content: none; animation: none; }
.tb-rv-wing { opacity: 0; transform-box: view-box; transition: transform .55s cubic-bezier(.2, .7, .2, 1), opacity .35s ease; }
.tb-rv-flight-near { transform-origin: 38px 49px; transform: rotate(34deg) scale(.22, .16); }
.tb-rv-flight-far { transform-origin: 61px 44px; transform: rotate(-30deg) scale(.22, .16); }
.tb-rv-fold { transition: opacity .35s ease; }
.tb-avatar[data-shape="raven"][data-mood="working"] .tb-rv-wing { opacity: 1; transform: none; }
.tb-avatar[data-shape="raven"][data-mood="working"] .tb-rv-flight-near { animation: tb-rv-wing-near var(--rv-beat) ease-in-out infinite; animation-delay: var(--av-bdelay, 0s); }
.tb-avatar[data-shape="raven"][data-mood="working"] .tb-rv-flight-far { animation: tb-rv-wing-far var(--rv-beat) ease-in-out infinite; animation-delay: var(--av-bdelay, 0s); }
.tb-avatar[data-shape="raven"][data-mood="working"] :is(.tb-rv-fold, .tb-rv-feet) { opacity: 0; }
.tb-avatar[data-shape="raven"][data-mood="working"] .tb-av-svg { scale: .86; }
.tb-avatar[data-shape="raven"][data-mood="working"] .tb-av-float { transform-origin: 50% 65%; animation: tb-rv-flight 5s ease-in-out infinite; animation-delay: var(--av-delay, 0s); }
.tb-avatar[data-shape="raven"][data-mood="working"] .tb-av-shadow { scale: .65; opacity: .2; }
.tb-avatar[data-shape="raven"][data-x="happy"]:not([data-mood="working"]):not([data-mood="sleeping"]) .tb-av-float { transform-origin: 50% 65%; animation: tb-rv-return .9s ease-out both; }
.tb-avatar[data-shape="raven"].is-raven-tap .tb-rv-head { transform: rotate(-6deg); }
:root[data-av-motion="full"] .tb-avatar[data-shape="raven"].is-raven-tap .tb-av-obj { animation: tb-rv-ack .85s ease-in-out; }
:root[data-av-motion="full"] .tb-avatar[data-shape="raven"].is-raven-tap:not([data-mood="working"]) .tb-rv-wing { opacity: 1; transform: none; }
:root[data-av-motion="full"] .tb-avatar[data-shape="raven"].is-raven-tap:not([data-mood="working"]) .tb-rv-flight-near { animation: tb-rv-greet .85s ease-in-out; }
:root[data-av-motion="full"] .tb-avatar[data-shape="raven"].is-raven-tap:not([data-mood="working"]) .tb-rv-fold { opacity: .15; }
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
  :root[data-av-motion="full"] .tb-avatar[data-shape="raven"]:hover:not([data-mood="working"]):not([data-mood="sleeping"]) .tb-rv-wing { opacity: 1; transform: none; }
  :root[data-av-motion="full"] .tb-avatar[data-shape="raven"]:hover:not([data-mood="working"]):not([data-mood="sleeping"]) .tb-rv-fold { opacity: .15; }
  :root[data-av-motion="full"] .tb-avatar[data-shape="raven"]:hover:not([data-mood="working"]):not([data-mood="sleeping"]) .tb-rv-head { transform: rotate(-5deg); }
  :root[data-av-motion="full"] .tb-avatar[data-shape="raven"][data-personality="curious"]:hover:not([data-mood="working"]):not([data-mood="sleeping"]) .tb-rv-head { transform: rotate(-9deg); }
  :root[data-av-motion="full"] .tb-avatar[data-shape="raven"][data-personality="shy"]:hover:not([data-mood="working"]):not([data-mood="sleeping"]) .tb-rv-wing { transform: scaleY(.6); }
}
@keyframes tb-rv-flight { 0%, 100% { transform: translateY(-4%) rotate(14deg); } 50% { transform: translateY(-8%) rotate(18deg); } }
@keyframes tb-rv-wing-near { 0%, 100% { transform: rotate(-9deg) scaleY(.85); } 50% { transform: rotate(12deg) scaleY(1.05); } }
@keyframes tb-rv-wing-far { 0%, 100% { transform: rotate(8deg) scaleY(.85); } 50% { transform: rotate(-10deg) scaleY(1.05); } }
@keyframes tb-rv-ack { 0%, 100% { transform: none; } 35% { transform: translateY(var(--rv-lift)) rotate(-3deg); } 70% { transform: translateY(-1px) rotate(2deg); } }
@keyframes tb-rv-greet { 0%, 100% { transform: rotate(8deg); } 30% { transform: rotate(-12deg); } 60% { transform: rotate(7deg); } }
@keyframes tb-rv-return { 0% { transform: translateY(-9%) rotate(12deg); } 65% { transform: translateY(1%) rotate(-2deg); } 100% { transform: none; } }
@keyframes tb-rv-breath { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.002, 1.004); } }
@keyframes tb-rv-observe { 0%, 65%, 100% { transform: rotate(2deg); } 75%, 85% { transform: rotate(4deg); } }
@keyframes tb-rv-signal { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@container (max-width: 47.98px) { .tb-av-facebox { scale: 1.14; } }
@container (max-width: 39.98px) { .tb-avatar[data-x="sleeping"] > .tb-av-bubble { display: none; } }
@container (max-width: 25.98px) { .tb-av-bubble { display: none !important; } }
@container (max-width: 23.98px) { .tb-av-mark { display: none; } }
:root[data-av-motion="subtle"] :is(.tb-av-float, .tb-av-shadow, .tb-av-hop, .tb-av-antenna, .tb-av-sprout, .tb-av-halo-ring, .tb-rv-head) { animation: none !important; }
:root[data-av-motion="subtle"] .tb-avatar[data-shape="raven"] :is(.tb-av-obj, .tb-av-bubble, .tb-rv-wing) { animation: none !important; }
:root[data-av-motion="subtle"] .tb-avatar[data-shape="raven"] :is(.tb-rv-wing, .tb-rv-fold) { transition: none; }
:root[data-av-motion="off"] .tb-avatar *,
:root[data-av-motion="off"] .tb-avatar *::before,
:root[data-av-motion="off"] .tb-avatar *::after { animation: none !important; transition: none !important; }
:root[data-av-motion="off"] .tb-avatar .tb-av-hop { transform: none !important; rotate: none !important; }
:root[data-av-motion="off"] .tb-avatar[data-x="speaking"] .tb-av-glow { opacity: .2 !important; }
:root[data-av-motion="off"] .tb-avatar :is(.tb-av-svg, .tb-av-spec, .tb-av-facebox, .tb-av-look, .tb-av-look2, .tb-av-catch, .tb-rv-head) { transform: none !important; }
:root[data-av-motion="off"] .tb-avatar[data-shape="raven"] .tb-rv-jaw { transform: none !important; }
:root[data-av-motion="off"] .tb-avatar .tb-av-talk { transform: scale(.9, .55) !important; }
:root[data-av-motion="off"] .tb-avatar[data-face="visor"] .tb-av-open { transform: none !important; }
@media (prefers-reduced-motion: reduce) {
  .tb-avatar *, .tb-avatar *::before, .tb-avatar *::after { animation: none !important; transition: none !important; }
  .tb-avatar :is(.tb-av-hop, .tb-av-svg, .tb-av-spec, .tb-av-shadow, .tb-av-facebox, .tb-av-look, .tb-av-look2, .tb-av-catch) { transform: none !important; translate: none !important; rotate: none !important; }
  .tb-avatar[data-shape="raven"] :is(.tb-rv-head, .tb-rv-jaw) { transform: none !important; transition: none; }
  .tb-avatar[data-shape="raven"] :is(.tb-rv-wing, .tb-rv-fold) { transition: none !important; }
  .tb-avatar .tb-av-talk { transform: scale(.9, .55) !important; transition: none; }
  .tb-avatar[data-face="visor"] .tb-av-open { transform: none !important; transition: none; }
  .tb-avatar[data-x="speaking"] .tb-av-glow { opacity: .2 !important; }
  .tb-avatar.is-working .tb-av-glow { animation: none; opacity: .7; }
  .tb-av-svg, .tb-av-spec, .tb-av-shadow, .tb-av-facebox { transform: none; translate: none; transition: none; }
}`;

  if (typeof document !== "undefined" && !document.getElementById("tb-avatar-style")) {
    const style = document.createElement("style");
    style.id = "tb-avatar-style";
    style.textContent = CSS;
    document.head.append(style);
  }

  const api = {
    SHAPES, MATERIALS, FACES, EYES, MOUTHS, EXTRAS, RAVEN_PLUMAGE, RAVEN_COLORS, RAVEN_MATERIALS, RAVEN_EYES, PERSONALITIES, MARKS, COLORS, GLOWS, PRESETS, LEGACY_SHAPES,
    normalize, suggest, matches, preset, random, initials, markup, render, setState, react, speak, attend, clear, glyph, setMotion,
    motion: () => motionLevel, refresh: schedule,
  };
  if (typeof window !== "undefined") window.RavnirAvatar = api;
  if (typeof globalThis !== "undefined") globalThis.RavnirAvatar = api;
})();
