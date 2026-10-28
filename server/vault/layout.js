import fs from "node:fs";
import path from "node:path";

// Where the vault writer puts things. Agents/, Projects/, Rules.md and Decisions-Log.md are the
// same in every layout; the daily log, the owner's profile and their headings follow a preset.
// "es" is the layout of the first vault this ran on, kept byte for byte.

export const AGENTS = "Agents";
export const PROJECTS = "Projects";
export const RULES = "Rules.md";
export const DECISIONS = "Decisions-Log.md";
export const LAYOUT_CHOICES = ["auto", "en", "es"];

const STATUS = {
  en: ["<!-- ravnir:status start (Ravnir updates this every day; do not edit by hand) -->", "<!-- ravnir:status end -->"],
  es: ["<!-- ravnir:estado inicio (Ravnir lo actualiza cada día; no editar a mano) -->", "<!-- ravnir:estado fin -->"],
};

// Blocks written before the rename carry these markers; writing replaces them in place.
const LEGACY_STATUS = [
  ["<!-- truebot:status start (TrueBot updates this every day; do not edit by hand) -->", "<!-- truebot:status end -->"],
  ["<!-- truebot:estado inicio (TrueBot lo actualiza cada día; no editar a mano) -->", "<!-- truebot:estado fin -->"],
];

export const STATUS_MARKERS = [...Object.values(STATUS), ...LEGACY_STATUS];
// The profile note's name until the owner sets theirs.
export const FALLBACK_PROFILE = "Owner.md";
export const KEY_LABELS = ["key", "clave"];

export const LAYOUTS = {
  en: {
    id: "en",
    log: "Log",
    logTitle: (date) => `# Log ${date}`,
    decisionLine: (date, text, who) => `- ${date}: ${text} (${who})`,
    decisionsBefore: "",
    people: "People",
    headings: { preference: "## Preferences", fact: "## Facts", contact: "## Contacts", routine: "## Routines", goal: "## Goals", other: "## Other" },
    history: "## History",
    key: "key",
    statusHeading: "## Current status",
    status: STATUS.en,
  },
  es: {
    id: "es",
    log: "Registro",
    logTitle: (date) => `# Registro ${date}`,
    decisionLine: (date, text, who) => `- ${date} — ${text} (${who})`,
    decisionsBefore: "## Imported from",
    people: "Perfil",
    headings: { preference: "## Preferencias", fact: "## Hechos", contact: "## Contactos", routine: "## Rutinas", goal: "## Objetivos", other: "## Otros" },
    history: "## Histórico",
    key: "clave",
    statusHeading: "## Estado actual",
    status: STATUS.es,
  },
};

function isDir(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

// An existing vault keeps the layout it already has; an empty one follows the owner's language.
export function detectLayout(dir, language = "") {
  if (isDir(path.join(dir, LAYOUTS.es.log)) || isDir(path.join(dir, LAYOUTS.es.people))) return "es";
  if (isDir(path.join(dir, LAYOUTS.en.log)) || isDir(path.join(dir, LAYOUTS.en.people))) return "en";
  return language === "es" ? "es" : "en";
}

export function resolveLayout(choice, dir, language = "") {
  return LAYOUTS[choice === "en" || choice === "es" ? choice : detectLayout(dir, language)];
}

// The owner's profile note. A vault that already has exactly one keeps writing to it.
export function profileNote(layout, dir, name = "") {
  const folder = path.join(dir, layout.people);
  let existing = [];
  try {
    existing = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch {
    // No profile folder yet.
  }
  const base = String(name || "").replace(/[\\/:*?"<>|.]/g, "").trim().replace(/\s+/g, "-");
  const file = base ? `${base}.md` : FALLBACK_PROFILE;
  // Its name ends up in every prompt, so only a plain one is used as is. The fallback note
  // gives way once the owner has a name; the writer moves its facts over.
  const only = existing.length === 1 ? existing[0].name : "";
  if (only && /^[\p{L}\p{N}][\p{L}\p{N} _'()-]{0,80}\.md$/u.test(only) && !(only === FALLBACK_PROFILE && file !== FALLBACK_PROFILE)) return `${layout.people}/${only}`;
  return `${layout.people}/${file}`;
}

export function profileHead(layout, name = "") {
  return `# ${name || "Owner"}\n\nDurable facts about ${name || "the owner"} that agents learned. When two facts share a key, the newest wins.\n\n${layout.history}\n`;
}
