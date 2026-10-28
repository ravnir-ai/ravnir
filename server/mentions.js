// Parse @mentions out of a chat message.
//
// Names come from the roster, so they can contain spaces and punctuation.
// The parser matches the longest name first, ignores an @ inside a word
// (email addresses) and unknown handles, dedupes repeated mentions, and never
// returns the bot that already owns the thread.

const WORD = /[\p{L}\p{N}_]/u;

export function parseMentions(text, bots = [], selfId = "") {
  const source = String(text || "");
  if (!source.includes("@")) return [];
  const candidates = bots
    .filter((bot) => bot && bot.id && bot.id !== selfId && String(bot.name || "").trim())
    .map((bot) => ({ bot, name: String(bot.name).trim() }))
    .sort((a, b) => b.name.length - a.name.length);

  const found = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "@") continue;
    const before = index > 0 ? source[index - 1] : "";
    if (before && WORD.test(before)) continue;
    for (const candidate of candidates) {
      const end = index + 1 + candidate.name.length;
      const slice = source.slice(index + 1, end);
      if (slice.toLowerCase() !== candidate.name.toLowerCase()) continue;
      const after = source[end] || "";
      if (after && WORD.test(after)) continue;
      found.push({ index, botId: candidate.bot.id, name: candidate.bot.name });
      index = end - 1;
      break;
    }
  }

  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  return found
    .filter((item) => {
      if (seen.has(item.botId)) return false;
      seen.add(item.botId);
      return true;
    })
    .map((item) => ({ botId: item.botId, name: item.name }));
}
