import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorTerms,
  duckDuckGoRegion,
  onTarget,
  parseDuckDuckGo,
  relevantResults,
  searchInBrowser,
  searchMarket,
  searchTerms,
  webResearch,
  webSearch,
} from "../server/web.js";

// Rows like the ones the replayed searches got back (Bing matching one word of a
// long query, or localizing to the server's network).
const fiatRows = [
  { title: "FIAT PUNTO : actus, essais, avis, fiabilité", url: "https://www.largus.fr/Fiat_Punto.html", snippet: "Tout sur la Fiat Punto" },
  { title: "Fiat Punto — Wikipédia", url: "https://fr.wikipedia.org/wiki/Fiat_Punto", snippet: "La Fiat Punto est une automobile" },
  { title: "Punto - Jeu de Cartes", url: "https://www.example.fr/punto", snippet: "Un jeu de cartes" },
];
const kayak = [{ title: "Hôtels : Comparaison | KAYAK", url: "https://www.kayak.fr/hotels", snippet: "Trouvez l'hôtel idéal" }];
const drancy = [
  { title: "Météo Drancy - Prévisions Météo-France", url: "https://meteofrance.com/previsions-meteo-france/drancy/93700", snippet: "Weather forecast Drancy today" },
  { title: "Drancy, Île-de-France Weather Forecast | weather.com", url: "https://weather.com/weather/today/l/drancy", snippet: "Today's weather forecast for Drancy" },
  { title: "Drancy 10 Day Weather Forecast", url: "https://weather.com/en-GB/weather/tenday/l/drancy", snippet: "10 day weather forecast Drancy" },
];
const madrid = [
  { title: "El tiempo en Madrid hoy | weather.com", url: "https://weather.com/es-ES/tiempo/hoy/l/Madrid", snippet: "Previsión del tiempo para Madrid" },
  { title: "Madrid, Spain weather forecast", url: "https://www.example.org/madrid-forecast", snippet: "Weather today in Madrid" },
];

test("searchTerms reads the query's words, sites and phrases without operators or common words", () => {
  const read = searchTerms('site:www.puntomx.es "Reservar mesa" Punto MX formulario de reserva -tripadvisor');
  assert.deepEqual(read.sites, ["puntomx.es"]);
  assert.ok(read.terms.includes("punto") && read.terms.includes("mx"));
  assert.ok(!read.terms.includes("site") && !read.terms.includes("de") && !read.terms.includes("tripadvisor"));
  assert.deepEqual(read.phrases, [["reservar", "mesa"]]);
  // Dates say when, not what.
  assert.deepEqual(searchTerms("Cinelux Aurora domingo 1 noviembre 2026").terms, ["cinelux", "aurora"]);
});

test("relevantResults drops pages about one word of the query and keeps pages about the query", () => {
  const cinelux = { title: "Cinelux LUXE Aurora | Cartelera", url: "https://www.cinelux.es/Cines/aurora/", snippet: "en Villanueva (Madrid)" };
  const eurostar = { title: "Can I choose my seat? - Eurostar Help Centre", url: "https://help.eurostar.com/faq", snippet: "If you are travelling in Eurostar Plus" };
  assert.deepEqual(relevantResults("Cartelera Aurora Villanueva horarios 1 noviembre 2026", [eurostar, cinelux]), [cinelux]);
  assert.deepEqual(relevantResults("Punto MX Madrid reservas online CoverManager booking", fiatRows), []);

  const rocketship = { title: "Remote Revenue Operations Manager Jobs in Spain", url: "https://www.remoterocketship.com/country/spain/jobs/revenue-operations/", snippet: "" };
  const october = { title: "October - Wikipedia", url: "https://en.wikipedia.org/wiki/October", snippet: "October is commonly associated with the season of autumn" };
  const madridWiki = { title: "Madrid — Wikipédia", url: "https://fr.wikipedia.org/wiki/Madrid", snippet: "Le plus célèbre club sportif de la ville de Madrid" };
  assert.deepEqual(relevantResults("October 2026 Revenue Operations Manager jobs Madrid Spain commercial strategy hiring", [october, madridWiki, rocketship]), [rocketship]);

  const primo = { title: "primo, prima | Diccionario de la lengua española", url: "https://dle.rae.es/primo", snippet: "Dicho de una persona" };
  assert.deepEqual(relevantResults("Primo Restaurante Taquería Madrid reservar carta precio dirección", [primo]), []);

  // A quoted phrase in full is enough.
  const mansion = { title: "Golden Harbor clipping campaign", url: "https://whop.com/x", snippet: "" };
  const wikis = [
    { title: "Wikipedia, l'enciclopedia libera", url: "https://it.wikipedia.org/", snippet: "" },
    { title: "Wikipédia, l'encyclopédie libre", url: "https://fr.wikipedia.org/", snippet: "" },
  ];
  assert.deepEqual(relevantResults('"Golden Harbor" campaign clipping Whop', [...wikis, mansion]), [mansion]);

  // A site: query keeps only rows on that site.
  const clipping = { title: "Clipping", url: "https://www.clipping.io/", snippet: "clipping campaigns" };
  const github = { title: "GitHub Terms of Service", url: "https://docs.github.com/terms", snippet: "GitHub reserves the right to reserve" };
  const own = { title: "Reservar", url: "https://www.puntomx.es/reservar/", snippet: "" };
  assert.deepEqual(relevantResults("site:rewards-demo.example clipping campaigns", [clipping]), []);
  assert.deepEqual(relevantResults('site:puntomx.es "Reservar" Punto MX formulario reserva widget', [github, own]), [own]);

  // A query of only common words or numbers is never judged.
  assert.equal(relevantResults("+34 600 000 000", kayak).length, 1);
});

test("anchorTerms finds the query's names and onTarget spots results for another place", () => {
  assert.deepEqual(anchorTerms("weather today Madrid Spain October 27 2026 forecast"), ["Madrid", "Spain"]);
  assert.deepEqual(anchorTerms("Madrid weather today"), ["Madrid"]);
  assert.deepEqual(anchorTerms("tiempo Madrid hoy 27 octubre 2026 previsión AEMET"), ["Madrid", "AEMET"]);
  assert.deepEqual(anchorTerms("best pizza near me"), []);
  assert.equal(onTarget("weather today Madrid Spain October 27 2026 forecast", drancy), false);
  assert.equal(onTarget("weather today Madrid Spain October 27 2026 forecast", madrid), true);
  assert.equal(onTarget("best pizza near me", drancy), true);
});

test("parseDuckDuckGo reads results, unwraps their links, skips ads and refuses a bot check", () => {
  const html = `
    <div class="result results_links results_links_deep result--ad">
      <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Sponsored</a>
      <a class="result__snippet" href="https://duckduckgo.com/y.js?x">An advert</a>
    </div>
    <div class="result results_links results_links_deep web-result ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fconmuchagula.com%2Fcierra-punto-mx%2F&amp;rut=abc">Cierra <b>Punto</b> <b>MX</b> - Con Mucha Gula</a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">El restaurante <b>Punto MX</b> de Madrid cierra sus puertas</a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result ">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.cinelux.es/Cines/aurora/">Cinelux LUXE Aurora | Cartelera y compra de entradas</a></h2>
      <a class="result__snippet" href="https://www.cinelux.es/Cines/aurora/">Cartelera de Cinelux Aurora en Villanueva</a>
    </div>`;
  const rows = parseDuckDuckGo(html, 10);
  assert.deepEqual(rows, [
    { title: "Cierra Punto MX - Con Mucha Gula", url: "https://conmuchagula.com/cierra-punto-mx/", snippet: "El restaurante Punto MX de Madrid cierra sus puertas" },
    { title: "Cinelux LUXE Aurora | Cartelera y compra de entradas", url: "https://www.cinelux.es/Cines/aurora/", snippet: "Cartelera de Cinelux Aurora en Villanueva" },
  ]);
  assert.equal(parseDuckDuckGo(html, 1).length, 1);
  assert.throws(() => parseDuckDuckGo('<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html"></form>', 10), /bot check/);
});

test("webSearch moves past an engine that answers with junk and says so when every engine does", async () => {
  const good = [{ title: "Cierra Punto MX - Con Mucha Gula", url: "https://conmuchagula.com/cierra-punto-mx/", snippet: "El restaurante Punto MX de Madrid cierra" }];
  const found = await webSearch("Punto MX Madrid cerrado", { providers: [{ name: "a", run: async () => fiatRows }, { name: "b", run: async () => good }] });
  assert.equal(found.provider, "b");
  assert.deepEqual(found.results, good);
  assert.match(found.text, /Cierra Punto MX/);

  const junk = await webSearch("Punto MX Madrid cerrado", { providers: [{ name: "a", run: async () => fiatRows }] });
  assert.deepEqual(junk.results, []);
  assert.match(junk.text, /^No results matched "Punto MX Madrid cerrado"\. The search engines returned unrelated pages \(for example "FIAT PUNTO/);
  assert.doesNotMatch(junk.text, /largus/);

  const site = await webSearch("site:rewards-demo.example clipping campaigns", { providers: [async () => [{ title: "Clipping", url: "https://www.clipping.io/", snippet: "clipping campaigns" }]] });
  assert.match(site.text, /https:\/\/rewards-demo\.example/);

  // An engine that fails and one that finds nothing: the plain answer, with the error.
  const none = await webSearch("Punto MX Madrid cerrado", { providers: [async () => { throw new Error("HTTP 429"); }, async () => []] });
  assert.equal(none.text, "No results. (HTTP 429)");

  // Junk is dropped even from the engine that also had good rows.
  const mixed = await webSearch("Cartelera Cines Aurora Villanueva Sunday 1 November 2026", {
    providers: [async () => kayak, async () => [...kayak, { title: "Cartelera Cinelux Aurora (Villanueva)", url: "https://example.org/aurora", snippet: "horarios" }]],
  });
  assert.deepEqual(mixed.results.map((row) => row.url), ["https://example.org/aurora"]);
});

test("webSearch prefers results for the place asked about and flags results for another place", async () => {
  const query = "weather today Madrid Spain October 27 2026 forecast";
  const right = await webSearch(query, { providers: [async () => drancy, async () => madrid] });
  assert.ok(right.results.every((row) => /madrid/i.test(`${row.title} ${row.url}`)));
  assert.equal(right.offTarget, undefined);

  const wrong = await webSearch(query, { providers: [async () => drancy] });
  assert.equal(wrong.offTarget, true);
  assert.match(wrong.text, /^Note: none of these results mention Madrid, Spain\./);

  // webResearch does not spend time reading pages about another place.
  const research = await webResearch(query, { providers: [async () => drancy] });
  assert.equal(research.offTarget, true);
  assert.deepEqual(research.pages, []);
});

test("searches run in the owner's market, and a set market wins", () => {
  assert.equal(searchMarket({ language: "es" }, {}), "es-ES");
  assert.equal(searchMarket({ language: "es" }, { RAVNIR_SEARCH_MARKET: "fr-FR" }), "fr-FR");
  assert.equal(searchMarket({ language: "es" }, { RAVNIR_SEARCH_MARKET: "nonsense" }), "es-ES");
  assert.equal(searchMarket({}, {}), "");
  assert.equal(duckDuckGoRegion("es-ES"), "es-es");
  assert.equal(duckDuckGoRegion("en-US"), "us-en");
  assert.equal(duckDuckGoRegion("en-GB"), "uk-en");
  assert.equal(duckDuckGoRegion(""), "wt-wt");
});

test("the browser search runs in a scratch tab and never moves the agent's page", async () => {
  const visited = [];
  const session = {
    navigate: async () => {
      throw new Error("the agent's page must not be used");
    },
    evaluate: async () => {
      throw new Error("the agent's page must not be used");
    },
    withScratchPage: async (fn) => fn({
      goto: async (url) => visited.push(url),
      waitForSelector: async () => {},
      evaluate: async () => [{ title: "Clipwave | Get paid to make clips", url: "https://clipwave.example/en", snippet: "clipping campaigns" }],
    }),
  };
  const browser = { ensure: async () => session, status: () => ({ available: true }) };
  const rows = await searchInBrowser(browser, { id: "b" }, "Clipwave clipping campaigns", 5, { market: "es-ES" });
  assert.deepEqual(rows.map((row) => row.url), ["https://clipwave.example/en"]);
  const url = new URL(visited[0]);
  assert.equal(url.hostname, "www.bing.com");
  assert.deepEqual([url.searchParams.get("q"), url.searchParams.get("mkt"), url.searchParams.get("cc")], ["Clipwave clipping campaigns", "es-ES", "ES"]);
});
