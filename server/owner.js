// The person this server works for: a name and the language they usually write in.
// Prompts, the Mac tools and the vault use it. Without a name, everything says "the user".

export const LANGUAGES = { en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian" };

export function normalizeOwner(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const name = String(source.name ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const language = Object.hasOwn(LANGUAGES, source.language) ? source.language : "";
  return { name, language };
}

export function ownerOf(state) {
  return normalizeOwner(state?.settings?.owner);
}

// "Alex", or "the user" when no name is set.
export function ownerLabel(owner) {
  return owner?.name || "the user";
}

// "Alex's", or "the user's".
export function ownerPossessive(owner) {
  return owner?.name ? `${owner.name}'s` : "the user's";
}

export function ownerSection(owner) {
  if (!owner?.name && !owner?.language) return "";
  const who = owner.name ? `You work for ${owner.name}, who owns this server.` : "";
  const language = owner.language ? `${owner.name || "They"} usually write${owner.name ? "s" : ""} in ${LANGUAGES[owner.language]}.` : "";
  return [who, language].filter(Boolean).join(" ");
}

// Whether a message is mostly English or mostly Spanish, from common short words.
// "en", "es", or "" when it is too short or too mixed to tell. Words both share (me, no, a) do not count.
const EN_WORDS = new Set(["the", "and", "you", "your", "can", "could", "what", "whats", "what's", "how", "is", "are", "this", "that", "for", "with", "like", "know", "don't", "dont", "i", "i'm", "my", "please", "do", "does", "have", "has", "when", "where", "which", "it", "of", "to", "on", "at", "be", "we", "our", "good", "morning", "hi", "hey", "check", "find", "look", "tell"]);
const ES_WORDS = new Set(["el", "la", "los", "las", "de", "del", "que", "qué", "y", "en", "un", "una", "por", "para", "con", "es", "está", "esta", "este", "mira", "mirame", "puedes", "mi", "hola", "buenos", "buenas", "días", "como", "cómo", "hay", "hoy", "mañana", "tarde", "noche", "quiero", "busca", "dime", "tienes", "sí", "al", "lo", "se", "podés", "va"]);

export function messageLanguage(text) {
  const words = String(text || "").toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  let en = 0;
  let es = 0;
  for (const word of words) {
    if (EN_WORDS.has(word)) en += 1;
    if (ES_WORDS.has(word)) es += 1;
  }
  if (en >= 2 && en >= 2 * es) return "en";
  if (es >= 2 && es >= 2 * en) return "es";
  return "";
}

// A note for the model next to the user's message, so a language named in the agent's standing
// instructions does not win over the language the user actually wrote in.
export function languageNote(text) {
  if (!String(text || "").trim()) return "";
  const language = messageLanguage(text);
  if (!language) return "(Reply in the language this message is mostly written in.)";
  return `(Reply in ${LANGUAGES[language]}: this message is mostly ${LANGUAGES[language]}, even if your standing instructions name another language.)`;
}
