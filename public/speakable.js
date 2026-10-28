// Turns an agent's reply into words for the ear: no markdown, no code, no
// raw links, capped in length, and split into sentence-sized pieces so the
// first audio starts quickly. Plain ES module with no DOM or Node APIs, so the
// browser and the tests share it.

export const SPEECH_LIMIT = 1200;
export const CUT_NOTE = "The rest is in the chat.";
export const CODE_NOTE = "I put the code in the chat.";
const LINK_NOTE = "the link in the chat";
const IMAGE_NOTE = "the image in the chat";
// A path with at least one folder and a file extension (People/Alex.md, ./src/app.js), or a bare note
// name (Alex.md). Bare names with other extensions stay, so "Node.js" is still said as it is.
const NAME = "[\\p{L}\\p{N}_-][\\p{L}\\p{N}_.-]*";
const FILE_PATH = `(?:~\\/|\\.{1,2}\\/|\\/)?(?:${NAME}\\/)+${NAME}\\.\\p{L}[\\p{L}\\p{N}]{0,4}|${NAME}\\.(?:md|markdown)`;

// How a path is said: its file name, and a note's name without ".md" or dashes.
function fileWords(found) {
  const name = found.split("/").pop();
  return /\.(?:md|markdown)$/i.test(name) ? name.replace(/\.(?:md|markdown)$/i, "").replace(/[-_]+/g, " ").trim() : name;
}

const SPANISH_WORDS = new Set([
  "el", "la", "los", "las", "de", "del", "que", "y", "en", "un", "una", "es", "por", "para", "con", "pero",
  "lo", "como", "mis", "tus", "tu", "yo", "puedo", "hay", "muy", "si", "su", "al", "más", "mas", "esto",
  "eso", "ya", "son", "están", "estoy", "hola", "gracias", "vale", "quiero", "puedes", "necesito", "tengo",
]);
const ENGLISH_WORDS = new Set([
  "the", "and", "is", "are", "to", "of", "in", "it", "you", "that", "for", "with", "this", "be", "on", "have",
  "what", "i", "i'm", "it's", "can", "will", "would", "your", "my", "please", "thanks", "not", "do", "does",
]);

// Markdown to plain sentences.
export function speakableText(markdown, { limit = SPEECH_LIMIT } = {}) {
  let text = String(markdown || "").replace(/\r\n?/g, "\n");
  // Fenced code, closed or still open at the end of the reply, becomes one note.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, `\n${CODE_NOTE}\n`);
  text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, `\n${CODE_NOTE}\n`);
  text = text.replace(/<\/?[a-z][^>\n]*>/gi, " ");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt.trim() ? alt.trim() : IMAGE_NOTE));
  // Links keep their text; bare addresses become a short note.
  text = text.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))+\)/g, "$1");
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>)\]]+/gi, LINK_NOTE);
  // File paths read badly aloud ("people slash Alex M D"). A citation in brackets that starts with one
  // goes; a path in the sentence is said as its file name, and a note without its ".md".
  text = text.replace(new RegExp(`\\s*\\(\\s*\`?(?:${FILE_PATH})\`?(?![\\p{L}\\p{N}/])[^()\\n]*\\)`, "gu"), "");
  text = text.replace(new RegExp(`\`?(${FILE_PATH})\`?(?![\\p{L}\\p{N}/])`, "gu"), (_, found) => fileWords(found));

  const lines = text.split("\n").map(cleanLine).filter(Boolean);
  const spoken = lines.map(endWithStop).join(" ").replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").replace(/\.{2,}(?!\.)/g, ".").trim();
  return capForSpeech(spoken, limit);
}

function cleanLine(line) {
  let out = line.trim();
  if (!out) return "";
  if (/^\|?[\s:|-]+\|?$/.test(out) && out.includes("-")) return ""; // table divider
  if (/^([-*_]\s*){3,}$/.test(out)) return ""; // horizontal rule
  out = out.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
  if (out.includes("|")) out = out.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).filter(Boolean).join(", ");
  out = out.replace(/`([^`\n]+)`/g, "$1");
  out = out.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/~~(.+?)~~/g, "$1");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, "$1$2").replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, "$1$2");
  return out.trim();
}

// A line that ends without punctuation still needs a pause before the next one.
function endWithStop(line) {
  if (/[.!?…]["'”’)»]*$/.test(line)) return line;
  if (/:$/.test(line)) return `${line.slice(0, -1)}.`;
  return `${line}.`;
}

// Cuts at the last full sentence that fits, and says so.
export function capForSpeech(text, limit = SPEECH_LIMIT) {
  if (text.length <= limit) return text;
  // Room for the cut note, one space, and a full stop if the cut lands mid-sentence.
  const room = limit - CUT_NOTE.length - 2;
  const head = text.slice(0, room);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("… "));
  const kept = (stop > room * 0.4 ? head.slice(0, stop + 1) : head.replace(/\s+\S*$/, "")).trim();
  const ended = /[.!?…]$/.test(kept) ? kept : `${kept.replace(/[,;:]$/, "")}.`;
  return `${ended} ${CUT_NOTE}`;
}

// Sentence-sized pieces for the speaker. Tiny sentences are joined to their
// neighbours (so each request is worth its round trip); very long ones are split at commas or words.
export function speechChunks(text, { min = 30, max = 240 } = {}) {
  const sentences = String(text || "").split(/(?<=[.!?…])\s+/).map((part) => part.trim()).filter(Boolean);
  const merged = [];
  for (const sentence of sentences) {
    if (merged.length && merged.at(-1).length < min) merged[merged.length - 1] += ` ${sentence}`;
    else merged.push(sentence);
  }
  return merged.flatMap((sentence) => (sentence.length <= max ? [sentence] : splitLong(sentence, max)));
}

function splitLong(sentence, max) {
  const parts = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (current && `${current} ${word}`.length > max) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// "es" when the text reads as Spanish (accents, ¿ ¡, common Spanish words), else "en".
export function detectLanguage(text) {
  const value = String(text || "");
  let spanish = (value.match(/[¿¡ñáéíóú]/gi) || []).length;
  let english = 0;
  for (const word of value.toLowerCase().match(/[a-záéíóúñü']+/g) || []) {
    if (SPANISH_WORDS.has(word)) spanish += 1;
    if (ENGLISH_WORDS.has(word)) english += 1;
  }
  return spanish > english ? "es" : "en";
}

// For a reply that is still streaming in: the complete sentences so far and the
// unfinished rest. A sentence counts as complete once its stop is followed by a
// space (so "3.5" never splits early); pieces shorter than `min` wait for the
// next sentence. With `final`, whatever is left comes out too.
export function takeSentences(buffer, { final = false, min = 8 } = {}) {
  const sentences = [];
  let rest = String(buffer || "");
  const boundary = /(?:[.!?…]+["'”’)»]*\s+|\n+)/g;
  for (;;) {
    boundary.lastIndex = 0;
    let cut = -1;
    for (let match = boundary.exec(rest); match; match = boundary.exec(rest)) {
      if (rest.slice(0, match.index + match[0].length).trim().length >= min) {
        cut = match.index + match[0].length;
        break;
      }
    }
    if (cut < 0) break;
    sentences.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (final && rest.trim()) {
    sentences.push(rest.trim());
    rest = "";
  }
  return { sentences, rest };
}

// How long to wait after the last new word before a spoken turn counts as finished.
// People pause mid-thought, so the base wait is generous, and a sentence that
// ends on a connector ("and", "pero", "porque") or a comma waits longer still.
const OPEN_ENDINGS = new Set([
  "and", "but", "or", "so", "because", "that", "the", "a", "to", "of", "with", "if", "then", "like", "um", "uh",
  "y", "e", "o", "u", "pero", "porque", "que", "de", "del", "el", "la", "los", "las", "un", "una", "con", "para",
  "por", "si", "entonces", "como", "en", "a", "al", "mi", "tu", "su", "es", "eh", "este", "pues", "osea", "o sea",
]);

export function turnWait(text, { base = 1600, open = 2800, short = 2200 } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return base;
  if (/[,;:]$/.test(trimmed)) return open;
  const last = trimmed.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).pop() || "";
  if (OPEN_ENDINGS.has(last)) return open;
  // A couple of words on their own is usually the start of a sentence, not all of it.
  if (trimmed.split(/\s+/).length <= 2 && !/[.?!]$/.test(trimmed)) return short;
  return base;
}
