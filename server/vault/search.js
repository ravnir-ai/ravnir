import { fromBlob } from "./indexer.js";

// Hybrid search: FTS5 (bm25) always, vectors when an embedder is configured,
// then a small link expansion so neighbours of the best notes come along.

const STOPWORDS = new Set(
  (
    "como cual cuales que quien donde cuando cuanto cuanta por para con sin sobre entre los las del una uno unos unas " +
    "este esta esto estos estas ese esa eso mas muy pero porque tambien hay son fue ser esta estan tiene tengo " +
    "va la el de en es al se lo le su sus mi mis tu me te nos " +
    "the how is what who where when which why are was were be been this that these those with from for and but not " +
    "you your our their his her its has have had do does did can could will would should about into than then there"
  ).split(/\s+/),
);
const FTS_LIMIT = 40;
const VEC_LIMIT = 40;
const RRF_K = 60;
const TITLE_BOOST = 2;
const LINK_FACTOR = 0.35;
const SNIPPET_MAX = 400;
const PER_NOTE = 2;

function fold(text) {
  let out = "";
  for (const ch of String(text)) {
    const plain = ch.normalize("NFD").replace(/\p{M}/gu, "");
    out += plain.length === ch.length ? plain.toLowerCase() : ch.toLowerCase();
  }
  return out;
}

function words(text) {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function tokenize(query) {
  const tokens = words(query).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

export function makeSnippet(text, tokens) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  const folded = fold(flat);
  let at = -1;
  for (const token of tokens) {
    const i = folded.indexOf(token);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - 100, flat.length - SNIPPET_MAX));
  return flat.slice(start, start + SNIPPET_MAX).trim();
}

function cosine(a, b) {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : -1;
}

export async function search(index, query, { limit = 8, embedder = null } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const db = index.db;
  const match = tokens.map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(" OR ");
  let ftsRows = [];
  try {
    ftsRows = db
      .prepare(
        `SELECT c.id AS id, bm25(chunks_fts, 0, 8.0, 3.0, 1.0) AS r
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? ORDER BY r LIMIT ${FTS_LIMIT}`,
      )
      .all(match);
  } catch {
    ftsRows = [];
  }

  let vecIds = [];
  if (embedder) {
    try {
      const [q] = await embedder.embed([query], "query");
      const scored = db
        .prepare("SELECT chunk_id, vec FROM vectors")
        .all()
        .map((row) => ({ id: row.chunk_id, sim: cosine(q, fromBlob(row.vec)) }))
        .filter((row) => row.sim > 0)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, VEC_LIMIT);
      vecIds = scored.map((row) => row.id);
    } catch {
      vecIds = [];
    }
  }

  const scores = new Map();
  const entry = (id) => {
    if (!scores.has(id)) scores.set(id, { id, score: 0, text: false, vector: false });
    return scores.get(id);
  };
  ftsRows.forEach((row, rank) => {
    const e = entry(row.id);
    e.text = true;
    e.score += embedder ? 1 / (RRF_K + rank + 1) : -row.r;
  });
  vecIds.forEach((id, rank) => {
    const e = entry(id);
    e.vector = true;
    e.score += 1 / (RRF_K + rank + 1);
  });
  if (!scores.size) return [];

  const ids = [...scores.keys()];
  const info = db
    .prepare(
      `SELECT c.id AS id, c.path AS path, c.heading AS heading, c.text AS text, n.title AS title, n.date AS date
       FROM chunks c JOIN notes n ON n.path = c.path WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);

  const titleTokens = new Map();
  const hasTitleToken = (row) => {
    if (!titleTokens.has(row.path)) {
      const base = row.path.split("/").pop().replace(/\.md$/i, "");
      titleTokens.set(row.path, new Set([...words(row.title), ...words(base)]));
    }
    const set = titleTokens.get(row.path);
    return tokens.some((t) => set.has(t));
  };

  const ranked = info
    .map((row) => {
      const e = scores.get(row.id);
      const boost = hasTitleToken(row) ? TITLE_BOOST : 1;
      return {
        path: row.path,
        title: row.title,
        heading: row.heading,
        snippet: makeSnippet(row.text, tokens),
        date: row.date,
        score: e.score * boost,
        via: e.text && e.vector ? "hybrid" : e.vector ? "vector" : "text",
      };
    })
    .sort((a, b) => b.score - a.score);

  const perNote = new Map();
  const direct = [];
  for (const row of ranked) {
    const n = perNote.get(row.path) || 0;
    if (n >= PER_NOTE) continue;
    perNote.set(row.path, n + 1);
    direct.push(row);
  }
  const top = direct.slice(0, limit);
  const present = new Set(top.map((r) => r.path));

  const added = new Map();
  const parents = [];
  for (const row of top) if (!parents.some((p) => p.path === row.path) && parents.length < 3) parents.push(row);
  const first = db.prepare(
    `SELECT c.heading AS heading, c.text AS text, n.title AS title, n.date AS date
     FROM chunks c JOIN notes n ON n.path = c.path WHERE c.path = ?
     ORDER BY (length(trim(c.text)) = 0), c.ord LIMIT 1`,
  );
  for (const parent of parents) {
    for (const path of [...index.outgoing(parent.path), ...index.backlinks(parent.path)]) {
      if (present.has(path)) continue;
      const score = parent.score * LINK_FACTOR;
      if ((added.get(path)?.score ?? -1) >= score) continue;
      const row = first.get(path);
      if (!row) continue;
      added.set(path, {
        path,
        title: row.title,
        heading: row.heading,
        snippet: makeSnippet(row.text, tokens),
        date: row.date,
        score,
        via: "link",
      });
    }
  }
  return [...top, ...added.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
