import dns from "node:dns/promises";
import net from "node:net";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const TIMEOUT_MS = 25_000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 60_000;
const MAX_REDIRECTS = 5;
const MAX_LINKS = 60;
// A page with less text than this (besides its title) is probably drawn by JavaScript.
const THIN_CHARS = 200;
const BING_URL = "https://www.bing.com/search";
const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
const LINKS_HEADING = "\n\nLinks on this page:\n";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "metadata.google.internal"]);

// Words too common to tell a page about the query from one that is not.
const STOPWORDS = new Set([
  "a", "al", "an", "and", "ante", "are", "as", "at", "by", "con", "de", "del", "el", "en", "es", "for", "from", "how", "in", "is",
  "it", "la", "las", "lo", "los", "mi", "near", "me", "of", "on", "or", "para", "por", "que", "se", "su", "sus", "the", "to", "un",
  "una", "uno", "unos", "unas", "what", "when", "where", "which", "who", "with", "y", "o", "this", "that", "about", "into", "como",
  "sobre", "este", "esta", "hoy", "today", "tomorrow", "manana", "ayer", "yesterday", "www", "com", "http", "https", "le", "les",
  "des", "du", "et", "der", "die", "das", "und", "il", "di", "e", "do", "da", "os", "best", "mejor", "mejores",
]);

// Dates say when, not what: a page about the right thing rarely repeats them.
const DATE_WORDS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre", "octubre", "noviembre", "diciembre",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
]);

// Search engines in order. DuckDuckGo's HTML page answers automated searches with
// real results more often than Bing (which matches one word of a long query and
// localizes to the server's network) or Brave (which answers 429). Every engine's
// rows go through the same relevance check, so junk from one moves on to the next,
// and when every engine answers with junk the agent is told so instead of reading it.
// `providers` replaces the engines (tests): functions or { name, run(text, limit) }.
// Engines answer in about a second when they work. One that times out or says to slow
// down rests for a while, so the next searches skip it instead of waiting for it again
// (from the hub, DuckDuckGo stopped answering and every search waited 25 s for it).
const SEARCH_TIMEOUT_MS = 8_000;
const ENGINE_REST_MS = 10 * 60_000;
const resting = new Map();

function restsAfter(message) {
  return /timed out|HTTP (429|5\d\d)|slow down/i.test(message);
}

export async function webSearch(query, { limit = 8, browser, bot, market = "", providers } = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("A search query is required.");
  const wanted = Math.min(20, Math.max(1, limit));
  const sources = (providers || defaultProviders({ browser, bot, market })).map((source, index) => (
    typeof source === "function" ? { name: source.name || `search ${index + 1}`, run: source } : source
  ));
  const anchors = anchorTerms(text);
  let error = "";
  let sample = "";
  let fallback = null;
  for (const source of sources) {
    if (!providers && (resting.get(source.name) || 0) > Date.now()) continue;
    let rows;
    try {
      rows = await source.run(text, wanted, market);
    } catch (caught) {
      error = caught.message || String(caught);
      if (!providers && restsAfter(error)) resting.set(source.name, Date.now() + ENGINE_REST_MS);
      continue;
    }
    if (!Array.isArray(rows) || !rows.length) continue;
    const kept = relevantResults(text, rows).slice(0, wanted);
    if (!kept.length) {
      sample ||= String(rows[0].title || rows[0].url || "").replace(/\s+/g, " ").trim().slice(0, 120);
      continue;
    }
    if (onTarget(text, kept)) return { query: text, results: kept, provider: source.name, text: listResults(kept) };
    // The right words but not the place or name asked for: keep it in case no engine does better.
    const hits = anchorHits(anchors, kept);
    if (!fallback || hits > fallback.hits) fallback = { name: source.name, rows: kept, hits };
  }
  if (fallback) {
    const which = fallback.hits ? `only ${fallback.hits} of these results mention` : "none of these results mention";
    return {
      query: text,
      results: fallback.rows,
      provider: fallback.name,
      offTarget: true,
      text: `Note: ${which} ${anchors.join(", ")}. The search engines may have localized them to this server's location or matched only common words. Search again with the place or name spelled differently, or read a direct source with web_fetch.\n\n${listResults(fallback.rows)}`,
    };
  }
  if (sample) {
    const { sites } = searchTerms(text);
    const next = sites.length
      ? `Open the site directly with browser_open or web_fetch (https://${sites[0]}).`
      : "Try two or three distinctive words (a name and a place), or open a site that lists what you need with web_fetch or browser_open.";
    return {
      query: text,
      results: [],
      provider: "",
      text: `No results matched "${text}". The search engines returned unrelated pages (for example "${sample}"), so none are listed. ${next}`,
    };
  }
  return { query: text, results: [], provider: "", text: `No results.${error ? ` (${error})` : ""}` };
}

function defaultProviders({ browser, bot, market }) {
  return [
    { name: "duckduckgo", run: (text, limit) => searchDuckDuckGo(text, limit, market) },
    // In a scratch tab of the agent's browser, never the page the agent is on.
    browser && bot ? { name: "bing (browser)", run: (text, limit) => searchInBrowser(browser, bot, text, limit, { market }) } : null,
    { name: "bing", run: (text, limit) => searchBing(text, limit, market) },
    { name: "brave", run: (text, limit) => searchBrave(text, limit) },
  ].filter(Boolean);
}

function listResults(rows) {
  return rows.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet || ""}`.trim()).join("\n\n");
}

// The market searches run in: RAVNIR_SEARCH_MARKET (such as es-ES), else the
// owner's language, else none (each engine's worldwide default).
export function searchMarket(owner, env = process.env) {
  const set = String(env?.RAVNIR_SEARCH_MARKET || "").trim();
  if (/^[a-z]{2}-[A-Z]{2}$/.test(set)) return set;
  const byLanguage = { es: "es-ES", en: "en-US", pt: "pt-PT", fr: "fr-FR", de: "de-DE", it: "it-IT" };
  return byLanguage[owner?.language] || "";
}

function marketParts(market) {
  const match = /^([a-z]{2})-([A-Z]{2})$/.exec(String(market || ""));
  return match ? { language: match[1], country: match[2] } : null;
}

// DuckDuckGo's region code: es-ES is es-es, en-US is us-en, en-GB is uk-en.
export function duckDuckGoRegion(market) {
  const parts = marketParts(market);
  if (!parts) return "wt-wt";
  return `${parts.country === "GB" ? "uk" : parts.country.toLowerCase()}-${parts.language}`;
}

function bingParams(url, market) {
  const parts = marketParts(market);
  if (!parts) {
    url.searchParams.set("setlang", "en");
    return url;
  }
  url.searchParams.set("mkt", market);
  url.searchParams.set("setlang", parts.language);
  url.searchParams.set("cc", parts.country);
  return url;
}

function fold(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function words(value) {
  return fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// What a result must be about: the query's distinctive words, the sites it named
// with site:, and its quoted phrases.
export function searchTerms(query) {
  const raw = String(query || "");
  const sites = [];
  for (const match of raw.matchAll(/(?:^|\s)site:(\S+)/gi)) {
    const host = match[1].toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
    if (host && !sites.includes(host)) sites.push(host);
  }
  const phrases = [...raw.matchAll(/"([^"]+)"/g)].map((match) => words(match[1])).filter((list) => list.length > 1);
  const cleaned = raw
    .replace(/(?:^|\s)(site|inurl|filetype|ext|related|cache):\S+/gi, " ")
    .replace(/\bintitle:/gi, " ")
    .replace(/(^|\s)-\S+/g, " ")
    .replace(/\b(OR|AND)\b/g, " ");
  const tokens = [...new Set(words(cleaned).filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !STOPWORDS.has(token)))];
  const undated = tokens.filter((token) => !DATE_WORDS.has(token));
  return { terms: undated.length ? undated : tokens, sites, phrases };
}

// A long word may appear inside a longer one (museo, museos); a short one must stand alone (mx).
function mentions(found, term) {
  return term.length >= 4 ? found.hay.includes(term) : found.tokens.has(term);
}

function haystack(row) {
  const hay = fold(`${row.title || ""} ${row.snippet || ""} ${row.url || ""}`);
  return { hay, tokens: new Set(hay.split(/[^\p{L}\p{N}]+/u)) };
}

function hostIn(url, sites) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return sites.some((site) => host === site || host.endsWith(`.${site}`));
  } catch {
    return false;
  }
}

// The rows that are about the query. A site: query keeps only rows on that site.
// Otherwise a row needs a quoted phrase in full or two of the query's distinctive
// words (one when the query has only one). Search engines fill a long query they
// cannot match with pages about any one of its words; those are dropped.
export function relevantResults(query, rows) {
  const { terms, sites, phrases } = searchTerms(query);
  const list = Array.isArray(rows) ? rows : [];
  if (sites.length) return list.filter((row) => hostIn(row.url, sites));
  if (!terms.length && !phrases.length) return list;
  const need = Math.min(2, terms.length);
  return list.filter((row) => {
    const found = haystack(row);
    if (phrases.some((phrase) => phrase.every((term) => mentions(found, term)))) return true;
    return need > 0 && terms.filter((term) => mentions(found, term)).length >= need;
  });
}

// The query's names: capitalized words and acronyms (Madrid, AEMET, MX), not dates.
// The first word is left out when there are others, since it may be capitalized
// only because it starts the query.
export function anchorTerms(query) {
  const raw = String(query || "").replace(/(?:^|\s)(site|inurl|filetype|ext|related|cache):\S+/gi, " ").replace(/(^|\s)-\S+/g, " ");
  const tokens = raw.match(/[\p{L}][\p{L}\p{M}\p{N}'-]*/gu) || [];
  const named = [];
  tokens.forEach((token, index) => {
    const folded = fold(token);
    if (DATE_WORDS.has(folded) || STOPWORDS.has(folded)) return;
    const acronym = token.length >= 2 && token === token.toUpperCase() && /\p{Lu}/u.test(token);
    if (acronym || (token.length >= 3 && /^\p{Lu}/u.test(token))) named.push({ token, index });
  });
  const kept = named.length > 1 && named[0].index === 0 ? named.slice(1) : named;
  const seen = new Set();
  return kept.map((item) => item.token).filter((token) => {
    const key = fold(token);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function anchorHits(anchors, rows) {
  const folded = anchors.map(fold);
  return rows.filter((row) => {
    const found = haystack(row);
    return folded.some((anchor) => mentions(found, anchor));
  }).length;
}

// Whether a set of results is about the place or name the query asks for. A
// weather search for Madrid that comes back with Drancy (where the server is) has
// the right words and the wrong place.
export function onTarget(query, rows) {
  const anchors = anchorTerms(query);
  if (!anchors.length || !rows.length) return true;
  return anchorHits(anchors, rows) >= Math.min(2, rows.length);
}

async function searchDuckDuckGo(text, limit, market = "") {
  const parts = marketParts(market);
  const response = await request(new URL(DUCKDUCKGO_URL), {
    method: "POST",
    body: new URLSearchParams({ q: text, kl: duckDuckGoRegion(market) }).toString(),
    contentType: "application/x-www-form-urlencoded",
    accept: "text/html",
    timeoutMs: SEARCH_TIMEOUT_MS,
    language: parts ? `${market},${parts.language};q=0.9` : undefined,
  });
  // 202 is DuckDuckGo asking to slow down, with no results.
  if (response.status === 202) throw new Error("DuckDuckGo asked to slow down.");
  if (response.status >= 400) throw new Error(`DuckDuckGo search failed with HTTP ${response.status}.`);
  return parseDuckDuckGo(response.body, limit);
}

export function parseDuckDuckGo(html, limit = 10) {
  const source = String(html || "");
  if (/anomaly-modal|id="challenge-form"|anomaly\.js/.test(source)) throw new Error("DuckDuckGo asked for a bot check.");
  // Each result is a <div class="result ...">; ads also carry result--ad.
  const starts = [...source.matchAll(/<div\b[^>]*\bclass="([^"]*)"/gi)].filter((match) => /(^|\s)result(--ad)?(\s|$)/.test(match[1]));
  const blocks = starts.length
    ? starts.map((match, index) => ({ ad: /(^|\s)result--ad(\s|$)/.test(match[1]), html: source.slice(match.index, starts[index + 1]?.index ?? source.length) }))
    : [{ ad: false, html: source }];
  const results = [];
  for (const block of blocks) {
    if (block.ad) continue;
    for (const link of block.html.matchAll(/<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (results.length >= limit) return results;
      const url = duckDuckGoTarget(/\bhref="([^"]+)"/i.exec(link[1])?.[1] || "");
      if (!url || results.some((row) => row.url === url)) continue;
      const rest = block.html.slice(link.index + link[0].length).split(/class="[^"]*\bresult__a\b/)[0];
      const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(rest);
      results.push({
        title: htmlToText(link[2]).replace(/\s+/g, " ").trim() || url,
        url,
        snippet: snippet ? htmlToText(snippet[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "",
      });
    }
  }
  return results;
}

// DuckDuckGo wraps each result in a redirect (//duckduckgo.com/l/?uddg=<address>); ads stay on duckduckgo.com.
function duckDuckGoTarget(href) {
  let value = decodeEntities(href).trim();
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    let url = new URL(value, "https://duckduckgo.com");
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith("/l/")) {
      const target = url.searchParams.get("uddg");
      if (!target) return "";
      url = new URL(target);
    }
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return "";
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

// Bing in a scratch tab of the agent's browser: it opens, reads the results and
// closes, so the page the agent is working on never moves. `base` is for tests.
export async function searchInBrowser(browser, bot, text, limit, { market = "", base = BING_URL } = {}) {
  const session = await browser.ensure(bot);
  const url = bingParams(new URL(base), market);
  url.searchParams.set("q", text);
  const rows = await session.withScratchPage(async (page) => {
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector("li.b_algo", { timeout: 4_000 }).catch(() => {});
    return page.evaluate((max) => {
      const out = [];
      for (const item of document.querySelectorAll("li.b_algo")) {
        const link = item.querySelector("h2 a");
        if (!link) continue;
        const snippet = (item.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, p")?.innerText || "")
          .replace(/\s+/g, " ").trim().slice(0, 300);
        out.push({ title: link.innerText.trim(), url: link.href, snippet });
        if (out.length >= max) break;
      }
      return out;
    }, limit);
  });
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ ...row, url: decodeBingUrl(row.url) || row.url }))
    .filter((row) => /^https?:\/\//i.test(row.url));
}

async function searchBrave(text, limit) {
  const url = new URL("https://search.brave.com/search");
  url.searchParams.set("q", text);
  url.searchParams.set("source", "web");
  const response = await request(url, { accept: "text/html", timeoutMs: SEARCH_TIMEOUT_MS });
  if (response.status >= 400) throw new Error(`Brave search failed with HTTP ${response.status}.`);
  return parseBrave(response.body, limit);
}

async function searchBing(text, limit, market = "") {
  const url = bingParams(new URL(BING_URL), market);
  url.searchParams.set("q", text);
  url.searchParams.set("count", String(limit));
  const response = await request(url, { accept: "text/html", timeoutMs: SEARCH_TIMEOUT_MS });
  if (response.status >= 400) throw new Error(`Search failed with HTTP ${response.status}.`);
  return parseBing(response.body, limit);
}

export async function webFetch(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const target = normalizeHttpUrl(url);
  const response = await request(target, { timeoutMs });
  const rendered = renderResponse(response);
  return rendered;
}

export async function webResearch(query, { limit = 3, browser, bot, market = "", providers } = {}) {
  const wanted = Math.max(limit, 5);
  const options = { limit: wanted, browser, bot, market, providers };
  const search = await webSearch(query, options);
  let results = search.results;
  let offTarget = Boolean(search.offTarget);
  const simplified = simplifyQuery(query);
  if (simplified && simplified !== query) {
    const second = await webSearch(simplified, options).catch(() => null);
    if (second?.results?.length) {
      if (offTarget && !second.offTarget) {
        results = second.results;
        offTarget = false;
      } else if (offTarget === Boolean(second.offTarget)) {
        const seen = new Set(results.map((row) => row.url));
        results = [...results, ...second.results.filter((row) => !seen.has(row.url))];
      }
    }
  }
  if (!results.length) return { query, results: [], text: search.text, pages: [] };
  // Results about another place or thing: reading them would only cost time.
  if (offTarget) return { query, results, pages: [], offTarget: true, text: search.text };
  const pages = [];
  await Promise.all(results.slice(0, limit + 5).map(async (row) => {
    try {
      const page = await webFetch(row.url, { timeoutMs: 15_000 });
      pages.push({ ...row, page });
    } catch (error) {
      pages.push({ ...row, error: error.message || "Could not open the page." });
    }
  }));
  pages.sort((a, b) => results.findIndex((row) => row.url === a.url) - results.findIndex((row) => row.url === b.url));
  const readable = pages.filter((row) => !row.error && !row.page?.blocked && !isThin(row.page));
  const shown = (readable.length ? readable : pages).slice(0, Math.max(limit, readable.length ? limit : Math.min(pages.length, 5)));
  const blocks = shown.map((row, index) => {
    if (row.error) return `${index + 1}. ${row.title}\n${row.url}\nCould not open: ${row.error}`;
    return `${index + 1}. ${row.page.title || row.title}\n${row.page.url}\n${row.page.text.slice(0, 5000)}`;
  });
  return {
    query,
    results,
    pages,
    text: `Search results for "${query}":\n\n${listResults(results)}\n\nPages read:\n\n${blocks.join("\n\n---\n\n")}`,
  };
}

function simplifyQuery(query) {
  return String(query || "")
    .replace(/\b(hoy|mañana|manana|domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|tarde|noche|esta|este|semana)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A page's own text, without the list of its links.
function pageText(page) {
  return String(page?.text || "").split(LINKS_HEADING)[0];
}

// A page that came back as little more than its title: usually an app that draws
// itself with JavaScript, so a plain request never sees its content.
export function isThin(page) {
  if (!page || page.binary || page.json) return false;
  if (Number(page.status || 200) >= 400) return false;
  return pageText(page).replace(page.title || "", "").trim().length < THIN_CHARS;
}

// `fetchPage` is for tests.
export async function fetchPageWithFallback(url, { browser, bot, fetchPage = webFetch } = {}) {
  let page;
  try {
    page = await fetchPage(url);
    if (!page.blocked && !isThin(page)) return page;
  } catch (error) {
    if (/private|valid URL|http or https/i.test(error.message || "")) throw error;
    page = { url: normalizeHttpUrl(url), status: 0, title: "", text: "", blocked: true, error: error.message };
  }
  if (!browser || !bot) return page;
  // The user has the browser (server/live.js): read what a plain request got.
  if (browser.isHeld?.(bot.id)) return page;
  const status = browser.status(bot);
  if (!status.available) return page;
  if (page.blocked) {
    // A blocked page needs the agent's own page: its profile, its cookies and the route
    // through the Mac. So it waits its turn with the browser tools (server/computer.js).
    const viaBrowser = async () => {
      const session = await browser.ensure(bot);
      const navigated = await session.navigate(String(page.url), { quiet: true });
      const read = await session.read();
      return {
        url: navigated.url || String(page.url),
        status: 200,
        title: read.title || navigated.title || page.title,
        text: formatBrowserPage(navigated, read),
        // Still a block page after the browser (and the Mac, when it could) tried.
        blocked: Boolean(read.notice) && !/^Opened /.test(read.notice),
        via: "browser",
      };
    };
    return browser.exclusive ? browser.exclusive(bot.id, viaBrowser) : viaBrowser();
  }
  // A thin page: the browser runs its JavaScript in a scratch tab, so the page the
  // agent is working on (a half-filled form) stays as it was. Keep whichever read has more to say.
  try {
    const session = await browser.ensure(bot);
    const read = await session.withScratchPage((tab) => renderInTab(tab, String(page.url)));
    const before = pageText(page).replace(page.title || "", "").trim().length;
    if (read.body.trim().length <= before) return page;
    return {
      url: read.url || String(page.url),
      status: 200,
      title: read.title || page.title,
      text: clip(read.body) + (read.links.length ? `${LINKS_HEADING}${read.links.map((link) => `- ${link.text}: ${link.url}`).join("\n")}` : ""),
      blocked: false,
      via: "browser",
    };
  } catch {
    return page;
  }
}

// Opens a page in a tab and reads its text and links once its scripts have loaded.
async function renderInTab(tab, url) {
  await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await tab.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  return tab.evaluate((max) => {
    const here = location.href.split("#")[0];
    const links = [];
    const seen = new Set();
    for (const link of document.querySelectorAll("a[href]")) {
      if (links.length >= max) break;
      const text = (link.innerText || "").replace(/\s+/g, " ").trim();
      const href = typeof link.href === "string" ? link.href : "";
      if (text.length < 3 || text.length > 140 || !/^https?:/.test(href) || href.split("#")[0] === here || seen.has(href)) continue;
      seen.add(href);
      links.push({ text, url: href });
    }
    return { url: location.href, title: document.title, body: document.body?.innerText || "", links };
  }, MAX_LINKS);
}

export function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a URL.");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http or https address.");
  return url;
}

// A POST body goes with the first request only; a redirect is followed with a plain GET.
async function request(url, { timeoutMs = TIMEOUT_MS, accept = ACCEPT, method = "GET", body, contentType, language } = {}) {
  let current = normalizeHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicHost(current);
      const first = hop === 0 && method !== "GET";
      const response = await fetch(current, {
        method: first ? method : "GET",
        body: first ? body : undefined,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept,
          "accept-language": language || "en-GB,en;q=0.9,es;q=0.8",
          ...(first && contentType ? { "content-type": contentType } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return { ...(await readBody(response)), url: current.href };
        current = new URL(location, current);
        continue;
      }
      return { ...(await readBody(response)), url: current.href, status: response.status };
    }
    throw new Error("Too many redirects.");
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(response) {
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (!/text|html|xml|json|javascript|csv/.test(type) && type) {
    return { status: response.status, contentType: type, title: "", text: `(${type} content, not shown)`, binary: true };
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, contentType: type, title: "", text: "" };
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const body = decodeBody(bytes, type);
  return { status: response.status, contentType: type, body };
}

function decodeBody(bytes, contentType) {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1] || "";
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString("latin1"))?.[1] || "";
  const charset = (declared || meta || "").toLowerCase();
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Fall through to the heuristic.
    }
  }
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    return utf8;
  }
}

export function renderResponse(response) {
  const raw = String(response.body || "");
  const contentType = response.contentType || "";
  if (response.binary) {
    return { url: response.url, status: response.status, title: "", text: response.text, blocked: false, binary: true };
  }
  if (/json/.test(contentType)) {
    let pretty = raw;
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // Keep the raw body.
    }
    return { url: response.url, status: response.status, title: "", text: clip(pretty), blocked: false, json: true };
  }
  const title = matchTitle(raw);
  const text = htmlToText(raw);
  const blocked = isBlockedPage(response.status, title, text);
  if (blocked) return { url: response.url, status: response.status, title, text: clip(text, 2000), blocked };
  // The page's links, so the agent can open or cite an item instead of guessing its address.
  const links = extractLinks(raw, response.url);
  return {
    url: response.url,
    status: response.status,
    title,
    text: clip(text) + (links.length ? `${LINKS_HEADING}${links.map((link) => `- ${link.text}: ${link.url}`).join("\n")}` : ""),
    blocked,
  };
}

// Links with readable text, resolved against the page's address. Links in the
// page's content come before those in its navigation, header and footer.
export function extractLinks(html, baseUrl, max = MAX_LINKS) {
  const source = String(html || "").replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ");
  const content = source.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  let here = "";
  try {
    here = new URL(baseUrl).href.split("#")[0];
  } catch {
    // No base: only absolute links resolve.
  }
  const out = [];
  const seen = new Set();
  for (const part of [content, source]) {
    for (const match of part.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      if (out.length >= max) return out;
      const text = htmlToText(match[2]).replace(/\s+/g, " ").trim();
      if (text.length < 3 || text.length > 140) continue;
      const href = decodeEntities(match[1]).trim();
      if (/^(mailto|javascript|tel|data):/i.test(href) || href.startsWith("#")) continue;
      let url;
      try {
        url = new URL(href, here || undefined);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (url.href.split("#")[0] === here) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      out.push({ text, url: url.href });
    }
  }
  return out;
}

export function htmlToText(html) {
  let source = String(html || "");
  source = source.replace(/<!--[\s\S]*?-->/g, " ");
  source = source.replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, " ");
  source = source.replace(/<(br|hr)\s*\/?>/gi, "\n");
  source = source.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt)>/gi, "\n");
  source = source.replace(/<h([1-6])\b[^>]*>/gi, "\n\n");
  source = source.replace(/<li\b[^>]*>/gi, "\n- ");
  source = source.replace(/<[^>]+>/g, " ");
  source = decodeEntities(source);
  source = source.replace(/\r/g, "");
  source = source.replace(/[ \t\f\v]+/g, " ");
  source = source.replace(/ *\n */g, "\n");
  source = source.replace(/\n{3,}/g, "\n\n");
  return source.trim();
}

function matchTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

function isBlockedPage(status, title, text) {
  if (status === 403 || status === 429 || status === 503) return true;
  const sample = `${title}\n${text.slice(0, 800)}`.toLowerCase();
  return /just a moment|attention required|access denied|verify you are human|checking your browser|enable javascript and cookies|captcha|unusual traffic|bot protection/.test(sample);
}

function parseBrave(html, limit) {
  const source = String(html || "");
  const results = [];
  const blocks = source.split(/<div class="snippet[^"]*"[^>]*data-type="web"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const link = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i);
    if (!link) continue;
    const titleMatch = block.match(/<div class="title[^"]*"[^>]*title="([^"]*)"/i);
    const bodyMatch = block.match(/<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";
    const snippet = bodyMatch ? htmlToText(bodyMatch[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const url = decodeEntities(link[1]);
    if (!/^https?:\/\//i.test(url) || results.some((row) => row.url === url)) continue;
    results.push({ title: title || url, url, snippet });
  }
  return results;
}

function parseBing(html, limit) {
  const source = String(html || "");
  const results = [];
  const blocks = source.split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeBingUrl(decodeEntities(link[1]));
    if (!url) continue;
    const title = htmlToText(link[2]).replace(/\s+/g, " ").trim();
    const caption = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = caption ? htmlToText(caption[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (!results.some((row) => row.url === url)) results.push({ title, url, snippet });
  }
  return results;
}

function decodeBingUrl(value) {
  try {
    const url = new URL(value);
    const wrapped = url.searchParams.get("u");
    if (wrapped && wrapped.startsWith("a1")) {
      const decoded = Buffer.from(wrapped.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      return /^https?:\/\//i.test(decoded) ? decoded : "";
    }
    return /^https?:\/\//i.test(value) ? value : "";
  } catch {
    return "";
  }
}

async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("That address is private.");
  }
  const address = net.isIP(host) ? host : (await dns.lookup(host, { verbatim: true })).address;
  if (isPrivateAddress(address)) throw new Error("That address is private.");
}

export function isPrivateAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  const value = address.toLowerCase();
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  return false;
}

// The buttons and links worth listing when a page has more than `max`: those in
// view and in the page's content first (server/browser.js read() ranks them),
// then shown in page order.
export function topActions(buttons, max) {
  const list = Array.isArray(buttons) ? buttons : [];
  if (list.length <= max) return list;
  return list
    .map((button, order) => ({ button, order }))
    .sort((a, b) => (Number(b.button.rank) || 0) - (Number(a.button.rank) || 0) || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map((item) => item.button);
}

function formatBrowserPage(status, page) {
  const fields = (page.fields || []).slice(0, 20).map((field) => `[${field.tag || "field"}${field.name ? ` ${field.name}` : ""}] ${field.label || field.placeholder || ""}`.trim());
  const buttons = topActions((page.buttons || []).filter((button) => button.text), 40)
    .map((button) => `- ${button.text}${/^https?:/i.test(button.href || "") ? ` -> ${button.href}` : ""}`);
  const parts = [
    page.notice ? `Note: ${page.notice}\n` : "",
    `URL: ${status.url || page.url || ""}`,
    page.title ? `Title: ${page.title}` : "",
    "",
    clip(String(page.text || "")),
  ];
  if (fields.length) parts.push("", "Fields:", ...fields);
  if (buttons.length) parts.push("", "Buttons and links:", ...buttons);
  return parts.filter((line) => line !== "").join("\n");
}

function decodeEntities(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
    Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
    ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", iquest: "¿", iexcl: "¡",
    ordf: "ª", ordm: "º", hellip: "...", mdash: "-", ndash: "-", rsquo: "'", lsquo: "'",
    rdquo: "\"", ldquo: "\"", middot: "·", bull: "•", euro: "€", pound: "£", deg: "°",
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[body] ?? whole;
  });
}

function clip(value, limit = MAX_TEXT) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} characters]` : text;
}
