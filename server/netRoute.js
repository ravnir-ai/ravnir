import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Where an agent's browser opens sites from. Datacenter networks get refused by
// many sites behind Cloudflare, Akamai, Imperva and friends, even with a real
// headful browser. Each agent's browser on this server goes through a tiny local
// SOCKS5 proxy (one per agent, loopback only) that decides per connection:
// straight from this server, or through the user's Mac (server/macTunnel.js).
//
// Routes, per agent (bot.browser.route):
//   auto   from this server; a site that answers with a block page moves to the
//          shared list of sites opened from the Mac (when a Mac is linked)
//   mac    every site through the Mac
//   proxy  a proxy the owner set (HTTP, HTTPS or SOCKS5), stored as a secret
//   direct always from this server

export const ROUTES = ["auto", "mac", "proxy", "direct"];

export function normalizeBrowserNetwork(input) {
  const route = ROUTES.includes(input?.route) ? input.route : "auto";
  return { route };
}

// Two-label public suffixes common enough to matter, so cinelux.com.es is not "com.es".
const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "com.br", "net.br", "org.br",
  "com.es", "org.es", "nom.es", "gob.es", "edu.es", "com.mx", "org.mx", "gob.mx", "com.ar", "com.co", "com.pe",
  "com.pt", "co.jp", "ne.jp", "co.nz", "co.za", "com.tr", "co.in", "co.kr", "com.cn", "com.hk", "com.sg", "co.il",
]);

export function siteOf(host) {
  const name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!name || net.isIP(name)) return name;
  const labels = name.split(".");
  if (labels.length <= 2) return name;
  const lastTwo = labels.slice(-2).join(".");
  return SECOND_LEVEL.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function hostMatches(host, site) {
  const name = String(host || "").toLowerCase().replace(/\.$/, "");
  return name === site || name.endsWith(`.${site}`);
}

// A page that a bot-protection service put in front of the site, from the main
// response's status and headers plus the page's title and first text. Returns
// { by, kind } where kind is "block" (refused outright, usually the network) or
// "challenge" (a check a real browser may pass), or null for a normal page.
export function detectBlock({ status = 0, headers = {}, title = "", text = "" } = {}) {
  const head = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value || "").toLowerCase()]));
  const sample = `${title}\n${String(text || "").slice(0, 1500)}`.toLowerCase();
  const refused = status === 403 || status === 429 || status === 503 || status === 401;
  const cloudflare = head.server?.includes("cloudflare") || "cf-ray" in head;
  if (cloudflare) {
    if (head["cf-mitigated"] === "challenge") return { by: "Cloudflare", kind: "challenge" };
    if (/you have been blocked|attention required|error 1020|error code: 1020|access denied|error 1006|error 1005/.test(sample) && refused) return { by: "Cloudflare", kind: "block" };
    if (/just a moment|performing security verification|checking your browser|verify you are human/.test(sample)) return { by: "Cloudflare", kind: "challenge" };
  }
  if ((head.server || "").includes("akamaighost") || /errors\.edgesuite\.net|reference #\d+\.[0-9a-f]+/.test(sample)) {
    if (refused && /access denied|you don't have permission/.test(sample)) return { by: "Akamai", kind: "block" };
  }
  if ("x-iinfo" in head || /incapsula incident|request unsuccessful\. incapsula/.test(sample)) {
    if (refused || /incapsula incident/.test(sample)) return { by: "Imperva", kind: "block" };
  }
  if (("x-datadome" in head || "x-dd-b" in head || /captcha-delivery\.com/.test(sample)) && refused) return { by: "DataDome", kind: "challenge" };
  if (/px-captcha|press (&|and) hold/.test(sample) && refused) return { by: "HUMAN", kind: "challenge" };
  if (refused && /request blocked\.|the request could not be satisfied/.test(sample) && /cloudfront/.test(sample + JSON.stringify(head))) return { by: "CloudFront", kind: "block" };
  return null;
}

// The shared list of sites that refuse this server's network and open from the
// Mac instead. Shared because the block is about the server, not the agent.
export class HomeSites {
  constructor(home) {
    this.file = home ? path.join(home, "home-sites.json") : "";
    this.sites = new Map(); // site -> { site, by, agent, addedAt, lastUsedAt }
    this.#load();
  }

  #load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const row of data.sites || []) {
        const site = siteOf(row.site);
        if (site) this.sites.set(site, { site, by: String(row.by || ""), agent: String(row.agent || ""), addedAt: Number(row.addedAt) || Date.now(), lastUsedAt: Number(row.lastUsedAt) || 0 });
      }
    } catch {
      // No list yet.
    }
  }

  #save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ sites: this.list() }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() {
    return [...this.sites.values()].sort((a, b) => a.site.localeCompare(b.site));
  }

  find(host) {
    for (const row of this.sites.values()) if (hostMatches(host, row.site)) return row;
    return null;
  }

  has(host) {
    return Boolean(this.find(host));
  }

  add(host, { by = "", agent = "" } = {}) {
    const site = siteOf(host);
    if (!site) return null;
    const row = this.sites.get(site) || { site, by, agent, addedAt: Date.now(), lastUsedAt: 0 };
    row.by = by || row.by;
    row.lastUsedAt = Date.now();
    this.sites.set(site, row);
    this.#save();
    return row;
  }

  remove(site) {
    const removed = this.sites.delete(siteOf(site));
    if (removed) this.#save();
    return removed;
  }
}

// One loopback SOCKS5 proxy for one agent's browser. `decide(host)` says "mac"
// or "direct" for each new connection; `tunnel` carries the Mac ones.
export class RouteProxy {
  constructor({ decide, tunnel }) {
    this.decide = decide;
    this.tunnel = tunnel;
    this.server = null;
    this.port = 0;
    this.direct = new Set(); // { socket, host } still open straight from this server
    this.failures = []; // recent connections that could not open: { host, via, error, at }
  }

  async start() {
    if (this.server) return this.port;
    this.server = net.createServer((client) => this.#accept(client));
    this.server.on("error", () => {});
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    return this.port;
  }

  get url() {
    return this.port ? `socks5://127.0.0.1:${this.port}` : "";
  }

  // Ends the connections to a site that went straight out, so the browser opens
  // new ones (through the Mac) instead of reusing a blocked keep-alive socket.
  // An empty site ends every direct connection.
  dropDirect(site) {
    for (const entry of this.direct) {
      if (!site || hostMatches(entry.host, site)) {
        entry.socket.destroy();
        this.direct.delete(entry);
      }
    }
  }

  lastFailure(host) {
    const now = Date.now();
    return this.failures.filter((row) => now - row.at < 60_000 && hostMatches(row.host, siteOf(host))).at(-1) || null;
  }

  #fail(host, via, error) {
    this.failures.push({ host, via, error: String(error?.message || error || ""), at: Date.now() });
    if (this.failures.length > 50) this.failures.splice(0, this.failures.length - 50);
  }

  #accept(client) {
    client.on("error", () => client.destroy());
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methods = buffer[1];
        if (buffer[0] !== 5) return client.destroy();
        if (buffer.length < 2 + methods) return;
        const offered = buffer.subarray(2, 2 + methods);
        buffer = buffer.subarray(2 + methods);
        if (!offered.includes(0)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (stage === "request") {
        const request = parseRequest(buffer);
        if (request === null) return;
        client.off("data", onData);
        stage = "done";
        if (request.error || request.command !== 1) {
          client.end(reply(7));
          return;
        }
        const rest = buffer.subarray(request.length);
        this.#open(client, request.host, request.port, rest);
      }
    };
    client.on("data", onData);
  }

  async #open(client, host, port, rest) {
    client.pause();
    let via = "direct";
    try {
      via = this.decide(host) || "direct";
    } catch (error) {
      this.#fail(host, "refused", error);
      client.end(reply(2));
      return;
    }
    if (via === "mac") {
      try {
        await this.tunnel.bridge(client, host, port);
        client.write(reply(0));
        if (rest.length) client.unshift(rest);
        client.resume();
      } catch (error) {
        this.#fail(host, "mac", error);
        if (!client.destroyed) client.end(reply(/offline/i.test(error.message) ? 3 : 4));
      }
      return;
    }
    const upstream = net.connect({ host, port });
    const entry = { socket: upstream, host };
    this.direct.add(entry);
    let connected = false;
    upstream.once("connect", () => {
      connected = true;
      client.write(reply(0));
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    const done = () => {
      this.direct.delete(entry);
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", (error) => {
      if (connected) return done();
      this.#fail(host, "direct", error);
      this.direct.delete(entry);
      if (!client.destroyed) client.end(reply(5));
    });
    upstream.on("close", () => {
      if (connected) done();
    });
    client.on("close", done);
  }

  close() {
    for (const entry of this.direct) entry.socket.destroy();
    this.direct.clear();
    this.server?.close();
    this.server = null;
    this.port = 0;
  }
}

function parseRequest(buffer) {
  if (buffer.length < 5) return null;
  if (buffer[0] !== 5) return { error: true, length: buffer.length };
  const command = buffer[1];
  const type = buffer[3];
  let host = "";
  let offset = 4;
  if (type === 1) {
    if (buffer.length < offset + 4 + 2) return null;
    host = [...buffer.subarray(offset, offset + 4)].join(".");
    offset += 4;
  } else if (type === 3) {
    const size = buffer[offset];
    if (buffer.length < offset + 1 + size + 2) return null;
    host = buffer.subarray(offset + 1, offset + 1 + size).toString("utf8");
    offset += 1 + size;
  } else if (type === 4) {
    if (buffer.length < offset + 16 + 2) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(offset + i).toString(16));
    host = parts.join(":");
    offset += 16;
  } else {
    return { error: true, length: buffer.length };
  }
  const port = buffer.readUInt16BE(offset);
  return { command, host, port, length: offset + 2 };
}

function reply(code) {
  return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
}

// A proxy address the owner typed: http, https or socks5, with an optional user
// and password (not for socks5, which Chromium cannot sign in to).
export function parseProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a proxy address, like http://user:password@host:port.");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error("That is not a valid proxy address.");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!["http", "https", "socks5"].includes(scheme)) throw new Error("Use an http, https or socks5 proxy.");
  if (!url.hostname) throw new Error("The proxy address needs a host.");
  const username = decodeURIComponent(url.username || "");
  const password = decodeURIComponent(url.password || "");
  if (scheme === "socks5" && (username || password)) throw new Error("Chromium cannot sign in to a SOCKS5 proxy. Use an HTTP proxy for a proxy with a password.");
  const port = url.port || (scheme === "http" ? "80" : scheme === "https" ? "443" : "1080");
  return { server: `${scheme}://${url.hostname}:${port}`, username, password, host: `${url.hostname}:${port}`, scheme };
}

export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// What the browsers need from the routes: the launch option for each agent, the
// per-agent proxies, moving a blocked site to the Mac, and plain words for the
// agent when a site stays out of reach.
export class BrowserNetwork {
  // `bypass` is Chromium's proxy bypass list; tests pass "<-loopback>" so local test sites go through the proxy too.
  constructor({ tunnel = null, homeSites = null, routeOf = () => "auto", customProxy = () => null, macName = () => "the user's Mac", bypass = "" } = {}) {
    this.tunnel = tunnel;
    this.bypass = bypass;
    this.homeSites = homeSites || new HomeSites("");
    this.routeOf = (bot) => normalizeBrowserNetwork({ route: routeOf(bot) }).route;
    this.customProxy = customProxy;
    this.macName = macName;
    this.proxies = new Map(); // bot id -> RouteProxy
    // The site each agent's page is on. While that is a site opened from the Mac, every
    // connection of that browser goes through the Mac too: a bot check loads pieces from
    // other hosts (challenges.cloudflare.com), and a check solved from two addresses fails.
    this.pages = new Map(); // bot id -> host
  }

  // Called by the browser when its main frame starts loading a page.
  setPage(bot, url) {
    let host = "";
    try {
      host = new URL(String(url)).hostname.toLowerCase();
    } catch {
      host = "";
    }
    this.pages.set(bot.id, host);
  }

  get macLinked() {
    return Boolean(this.tunnel?.configured);
  }

  get macOnline() {
    return Boolean(this.tunnel?.online);
  }

  // How this agent's browser reaches sites right now, for the Screen tab.
  describe(bot) {
    const route = this.routeOf(bot);
    const custom = route === "proxy" ? this.customProxy(bot) : null;
    return {
      route,
      macLinked: this.macLinked,
      macOnline: this.macOnline,
      proxyHost: custom?.host || "",
      homeSites: this.homeSites.list().map(({ site, by, addedAt, lastUsedAt }) => ({ site, by, addedAt, lastUsedAt })),
    };
  }

  // Playwright's `proxy` launch option for the agent, or null to connect directly.
  async launchProxy(bot) {
    const route = this.routeOf(bot);
    if (route === "direct") return null;
    if (route === "proxy") {
      const custom = this.customProxy(bot);
      if (!custom) return null;
      return { server: custom.server, ...(custom.username ? { username: custom.username, password: custom.password } : {}) };
    }
    if (!this.macLinked) return null;
    const proxy = await this.#proxyFor(bot);
    return { server: proxy.url, ...(this.bypass ? { bypass: this.bypass } : {}) };
  }

  // The same route for a plain Chromium (Take control), as a command line flag.
  // A proxy password cannot go on the command line; Chromium asks for it.
  plainArgs(bot) {
    const route = this.routeOf(bot);
    if (route === "proxy") {
      const custom = this.customProxy(bot);
      return custom ? [`--proxy-server=${custom.server}`] : [];
    }
    const proxy = this.proxies.get(bot.id);
    return route !== "direct" && proxy?.port ? [`--proxy-server=${proxy.url}`] : [];
  }

  async #proxyFor(bot) {
    let proxy = this.proxies.get(bot.id);
    if (!proxy) {
      proxy = new RouteProxy({ tunnel: this.tunnel, decide: (host) => this.#decide(bot, host) });
      this.proxies.set(bot.id, proxy);
    }
    await proxy.start();
    return proxy;
  }

  // `bot` is the live object from state, so a changed route counts at once.
  #decide(bot, host) {
    const route = this.routeOf(bot);
    if (route === "mac") return "mac";
    if (route === "auto" && this.macOnline) {
      const row = this.homeSites.find(host) || this.homeSites.find(this.pages.get(bot.id) || "");
      if (row) {
        row.lastUsedAt = Date.now();
        return "mac";
      }
    }
    return "direct";
  }

  // Whether the page should be retried from the Mac after a block.
  canMoveHome(bot, host) {
    return this.routeOf(bot) === "auto" && this.macLinked && this.macOnline && this.proxies.has(bot.id) && !this.homeSites.has(host);
  }

  moveHome(bot, host, block) {
    const row = this.homeSites.add(host, { by: block?.by || "", agent: bot.name });
    // This browser's page is on the site now: none of its open connections may be reused.
    this.proxies.get(bot.id)?.dropDirect("");
    for (const proxy of this.proxies.values()) proxy.dropDirect(row.site);
    return row.site;
  }

  viaMac(bot, host) {
    const route = this.routeOf(bot);
    return this.macOnline && (route === "mac" || (route === "auto" && (this.homeSites.has(host) || this.homeSites.has(this.pages.get(bot.id) || ""))));
  }

  openedNote(bot, host, block) {
    const site = siteOf(host);
    return `Opened ${site} from ${this.macName()}: ${site} refuses this server's network (${block?.by || "bot protection"}). Every agent now opens ${site} from there while the Mac is online.`;
  }

  // Plain words for the agent when a site stays blocked.
  explain(bot, host, block) {
    const site = siteOf(host);
    const route = this.routeOf(bot);
    const mac = this.macName();
    const by = block?.by || "Its bot protection";
    if (block?.kind === "challenge" && this.viaMac(bot, host)) {
      return `${site} asks to verify a human (${by} check). The page is open from ${mac}, so the user can pass it: call ask_user_to_take_over with this page and carry on once they hand it back. Do not try to pass the check yourself.`;
    }
    const lead = block?.kind === "challenge"
      ? `${site} shows a bot check (${by}) that did not clear from this server's network.`
      : `${site} refuses this server's network: ${by} blocks datacenter addresses, so the page is a block page, not the site.`;
    const tail = "Other addresses or pages on the same site get the same block, so do not try them.";
    let next;
    if (route === "direct") next = "This agent is set to open sites only from the server. The user can change that in the agent's Screen tab (Open sites from). Ask with ask_user.";
    else if (route === "proxy") next = "This agent opens sites through the proxy the user set, and the site blocks that too. Ask the user with ask_user.";
    else if (this.viaMac(bot, host)) next = `It was opened from ${mac} and is still blocked there. Ask the user with ask_user to open it themselves.`;
    else if (this.macLinked && !this.macOnline) next = `Ravnir opens blocked sites from ${mac}, but the Mac is offline. Ask the user with ask_user to wake it, then open the page again.`;
    else next = "The user can link a Mac (Settings, Connections) or set a proxy for this agent in its Screen tab, and then this site opens. Ask with ask_user.";
    return `${lead} ${tail} ${next}`;
  }

  // A navigation that failed inside the proxy, in plain words, or "" to keep the browser's error.
  connectError(bot, host) {
    const failure = this.proxies.get(bot.id)?.lastFailure(host);
    if (!failure) return "";
    if (failure.via === "mac") {
      if (/offline/i.test(failure.error)) return `${this.macName()} is offline, and this agent opens ${siteOf(host)} from there. Ask the user with ask_user to wake the Mac, then try again.`;
      return failure.error;
    }
    if (/ENOTFOUND|EAI_AGAIN/.test(failure.error)) return `net::ERR_NAME_NOT_RESOLVED: ${host} does not exist.`;
    if (/ECONNREFUSED/.test(failure.error)) return `net::ERR_CONNECTION_REFUSED: ${host} refused the connection.`;
    if (/ETIMEDOUT/.test(failure.error)) return `net::ERR_CONNECTION_TIMED_OUT: ${host} did not answer.`;
    return "";
  }

  forget(botId) {
    this.proxies.get(botId)?.close();
    this.proxies.delete(botId);
    this.pages.delete(botId);
  }

  closeAll() {
    for (const proxy of this.proxies.values()) proxy.close();
    this.proxies.clear();
  }
}
