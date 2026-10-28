// Word matching for the small searches agents run on this server: the Skills shop, the plugin
// catalog and the roster. No index and no model: a few hundred entries score in well under a
// millisecond, and the same words always give the same order, so the tests can pin it.

// Words that carry no topic in English or Spanish. The rest of a query is what it is about.
const STOP = new Set(`
a an and are as at be but by can could do does for from get give has have help how i if in into is it its
me my need needs of on or our please so some than that the their them then there these this those to up
us use using want was we what when where which who why will with would you your yours
al algo como con de del el en es esa ese eso esta este esto hay la las lo los me mi mis necesito para pero
por que quiero se si sin sobre su sus te tu tus un una uno unos y ya
`.split(/\s+/).filter(Boolean));

// Lowercase words without accents, short plurals folded ("reports" and "report" match).
export function words(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

// A query word hits a field word when they are the same, or when one is a long prefix of the other
// ("spreadsheet" and "spreadsheets", "deploy" and "deployment").
function hits(query, field) {
  if (field.has(query)) return true;
  if (query.length < 5) return false;
  for (const word of field) {
    if (word.length >= 5 && (word.startsWith(query) || query.startsWith(word))) return true;
  }
  return false;
}

// Score fields against a query. fields: [[text, weight], ...]. Each query word counts once, at the
// weight of the best field it hits, so a long description cannot outscore a name that matches.
export function score(query, fields) {
  const wanted = [...new Set(words(query))];
  if (!wanted.length) return 0;
  const sets = fields.map(([text, weight]) => [new Set(words(text)), weight]);
  let total = 0;
  for (const word of wanted) {
    let best = 0;
    for (const [set, weight] of sets) if (weight > best && hits(word, set)) best = weight;
    total += best;
  }
  return total;
}

// The entries that match, best first, keeping the catalog order on ties.
export function rank(query, items, fieldsOf, { limit = 8, min = 1 } = {}) {
  return items
    .map((item, index) => ({ item, index, score: score(query, fieldsOf(item)) }))
    .filter((row) => row.score >= min)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);
}
