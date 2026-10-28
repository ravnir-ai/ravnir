import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { BrowserSession } from "../server/browser.js";
import { MAC_PATH } from "../server/macNode.js";
import { MacTunnel, TUNNEL_PATH } from "../server/macTunnel.js";
import { BrowserNetwork, HomeSites, RouteProxy, detectBlock, parseProxyUrl, siteOf } from "../server/netRoute.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-net-${name}-`));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CLOUDFLARE_BLOCK = {
  status: 403,
  headers: { server: "cloudflare", "cf-ray": "8d1-MAD" },
  title: "Attention Required! | Cloudflare",
  text: "Sorry, you have been blocked\nYou are unable to access cinelux.es",
};

test("block pages are told apart from normal pages", () => {
  assert.deepEqual(detectBlock(CLOUDFLARE_BLOCK), { by: "Cloudflare", kind: "block" });
  assert.deepEqual(detectBlock({ status: 403, headers: { server: "cloudflare", "cf-mitigated": "challenge" }, title: "Just a moment...", text: "" }), { by: "Cloudflare", kind: "challenge" });
  assert.deepEqual(detectBlock({ status: 403, headers: { server: "AkamaiGHost" }, title: "Access Denied", text: "You don't have permission to access this page. Reference #18.5c2b1702" }), { by: "Akamai", kind: "block" });
  assert.equal(detectBlock({ status: 200, headers: { server: "cloudflare", "cf-ray": "x" }, title: "Cartelera | Cinelux", text: "Compra ya tus entradas" }), null);
  // A plain 403 from a site's own app is not bot protection.
  assert.equal(detectBlock({ status: 403, headers: { server: "nginx" }, title: "Forbidden", text: "Access denied" }), null);
});

test("sites are grouped by their registrable domain", () => {
  assert.equal(siteOf("www.cinelux.es"), "cinelux.es");
  assert.equal(siteOf("compra.cinelux.es"), "cinelux.es");
  assert.equal(siteOf("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteOf("203.0.113.9"), "203.0.113.9");
  const home = tmp("sites");
  const sites = new HomeSites(home);
  sites.add("www.cinelux.es", { by: "Cloudflare", agent: "PA" });
  assert.ok(new HomeSites(home).has("api.cinelux.es"), "the list survives a restart");
  assert.equal(new HomeSites(home).has("cinelux.com"), false);
});

test("proxy addresses: credentials only where Chromium can use them", () => {
  assert.deepEqual(parseProxyUrl("http://ana:s3cr%40t@proxy.example.com:8080"), { server: "http://proxy.example.com:8080", username: "ana", password: "s3cr@t", host: "proxy.example.com:8080", scheme: "http" });
  assert.equal(parseProxyUrl("socks5://10.1.2.3:1080").server, "socks5://10.1.2.3:1080");
  assert.throws(() => parseProxyUrl("socks5://u:p@host:1080"), /SOCKS5/);
  assert.throws(() => parseProxyUrl("ftp://host"), /http, https or socks5/);
});

// A SOCKS5 CONNECT by hand, then one HTTP request through it.
async function getThroughSocks(port, host, targetPort, pathname = "/") {
  const socket = net.connect(port, "127.0.0.1");
  let buffer = Buffer.alloc(0);
  let ended = false;
  const waiters = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake();
  });
  socket.on("close", () => {
    ended = true;
    wake();
  });
  socket.on("error", () => {});
  const read = async (size) => {
    while (buffer.length < size && !ended) await new Promise((resolve) => waiters.push(resolve));
    const out = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return out;
  };
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual([...await read(2)], [5, 0]);
  const name = Buffer.from(host);
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(targetPort);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]));
  const answer = await read(10);
  if (answer[1] !== 0) {
    socket.destroy();
    return { code: answer[1] ?? -1 };
  }
  socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  while (!ended) await new Promise((resolve) => waiters.push(resolve));
  return { code: 0, body: buffer.toString("utf8") };
}

test("the real Mac runner carries connections and refuses the home network", async (t) => {
  const dir = tmp("runner");
  const tunnel = new MacTunnel({ token: "tok" });
  const hub = http.createServer();
  const sockets = new WebSocketServer({ noServer: true });
  hub.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname !== TUNNEL_PATH) return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => tunnel.attach(ws));
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const big = "x".repeat(3 * 1024 * 1024);
  const site = http.createServer((req, res) => {
    res.setHeader("connection", "close");
    res.end(req.url === "/big" ? big : `hello from home ${req.headers.host}`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ url: `ws://127.0.0.1:${hub.address().port}${MAC_PATH}`, token: "tok", roots: [dir] }));
  const runner = spawn(process.execPath, [path.join(ROOT, "bin/mac-node.mjs")], { env: { ...process.env, RAVNIR_MAC_CONFIG: config, RAVNIR_MAC_TUNNEL_TEST_LOOPBACK: "1" }, stdio: "ignore" });
  const proxy = new RouteProxy({ tunnel, decide: () => "mac" });
  await proxy.start();
  t.after(() => {
    runner.kill();
    proxy.close();
    tunnel.close();
    sockets.close();
    hub.close();
    site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !tunnel.online; i++) await wait(50);
  assert.equal(tunnel.online, true, "the runner opened the tunnel");

  const small = await getThroughSocks(proxy.port, "127.0.0.1", site.address().port);
  assert.equal(small.code, 0);
  assert.match(small.body, /hello from home 127\.0\.0\.1/);
  const large = await getThroughSocks(proxy.port, "127.0.0.1", site.address().port, "/big");
  assert.ok(large.body.endsWith(big), "a 3 MB page arrives whole");

  // The home network and the tailnet stay out of reach.
  const refused = await getThroughSocks(proxy.port, "192.168.1.1", 80);
  assert.notEqual(refused.code, 0);
  assert.match(proxy.lastFailure("192.168.1.1").error, /private or local/);
  const tailnet = await getThroughSocks(proxy.port, "100.101.102.103", 443);
  assert.notEqual(tailnet.code, 0);

  // Without the Mac the connection fails plainly instead of leaving from the server.
  runner.kill();
  for (let i = 0; i < 100 && tunnel.online; i++) await wait(50);
  const offline = await getThroughSocks(proxy.port, "127.0.0.1", site.address().port);
  assert.notEqual(offline.code, 0);
  assert.match(proxy.lastFailure("127.0.0.1").error, /offline/);
});

// The same test site answers like Cloudflare to the server and normally to the "Mac":
// a fake tunnel joins every Mac connection to the home copy of the site.
async function blockedSite() {
  const blocked = http.createServer((req, res) => {
    res.writeHead(403, { server: "cloudflare", "cf-ray": "8d1-MAD", "content-type": "text/html" });
    res.end("<title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1>");
  });
  const home = http.createServer((req, res) => {
    res.writeHead(200, { server: "cloudflare", "cf-ray": "8d2-MAD", "content-type": "text/html" });
    res.end("<title>Cartelera | Cines</title><p>Clayface 19:30, fila J libre</p>");
  });
  await new Promise((resolve) => blocked.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => home.listen(0, "127.0.0.1", resolve));
  const tunnel = {
    configured: true,
    online: true,
    used: 0,
    bridge(client, host, port) {
      this.used += 1;
      if (!this.online) return Promise.reject(new Error("The Mac is offline."));
      return new Promise((resolve, reject) => {
        const upstream = net.connect(home.address().port, "127.0.0.1", () => {
          client.pipe(upstream);
          upstream.pipe(client);
          resolve({ address: "127.0.0.1" });
        });
        upstream.on("error", reject);
        client.on("close", () => upstream.destroy());
      });
    },
  };
  return { blocked, home, tunnel, url: `http://127.0.0.1:${blocked.address().port}/cartelera` };
}

async function sessionFor(bot, network, t) {
  const dir = tmp("browser");
  const session = new BrowserSession({
    bot,
    home: dir,
    network,
    profile: path.join(dir, "profile"),
    stateFile: path.join(dir, "browser.json"),
    downloads: path.join(dir, "downloads"),
  });
  await session.launch();
  t.after(async () => {
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return session;
}

test("a site that blocks the server opens from the Mac, and stays there for every agent", async (t) => {
  const site = await blockedSite();
  const homeDir = tmp("home");
  const network = new BrowserNetwork({ tunnel: site.tunnel, homeSites: new HomeSites(homeDir), routeOf: (bot) => bot.browser?.route, macName: () => "Ana's Mac", bypass: "<-loopback>" });
  t.after(() => {
    network.closeAll();
    site.blocked.close();
    site.home.close();
  });
  const pa = { id: "pa", name: "PA", browser: { route: "auto" } };
  const session = await sessionFor(pa, network, t);
  await session.navigate(site.url);
  const page = await session.read();
  assert.match(page.text, /Clayface 19:30/, "the page came from the Mac");
  assert.match(page.notice, /^Opened 127\.0\.0\.1 from Ana's Mac/);
  assert.ok(network.homeSites.has("127.0.0.1"));

  // Another agent goes straight to the Mac for that site, with no block first.
  const researcher = { id: "re", name: "Researcher", browser: { route: "auto" } };
  const second = await sessionFor(researcher, network, t);
  const before = site.tunnel.used;
  await second.navigate(site.url);
  assert.match((await second.read()).text, /Clayface/);
  assert.ok(site.tunnel.used > before);
});

test("when a site stays blocked the agent hears why and what to ask", async (t) => {
  const site = await blockedSite();
  site.tunnel.online = false;
  const network = new BrowserNetwork({ tunnel: site.tunnel, homeSites: new HomeSites(""), routeOf: (bot) => bot.browser?.route, macName: () => "Ana's Mac", bypass: "<-loopback>" });
  t.after(() => {
    network.closeAll();
    site.blocked.close();
    site.home.close();
  });
  const offline = await sessionFor({ id: "a", name: "PA", browser: { route: "auto" } }, network, t);
  await offline.navigate(site.url);
  const read = await offline.read();
  assert.match(read.text, /you have been blocked/);
  assert.match(read.notice, /refuses this server's network: Cloudflare blocks datacenter addresses/);
  assert.match(read.notice, /Mac is offline. Ask the user with ask_user to wake it/);
  assert.match(read.notice, /do not try them/);

  const direct = await sessionFor({ id: "b", name: "Scout", browser: { route: "direct" } }, network, t);
  await direct.navigate(site.url);
  assert.match((await direct.read()).notice, /set to open sites only from the server/);

  // Everything through the Mac while it is offline: a plain error, not ERR_SOCKS.
  const always = await sessionFor({ id: "c", name: "Echo", browser: { route: "mac" } }, network, t);
  await assert.rejects(always.navigate(site.url), /Ana's Mac is offline/);
});

test("the agent's route and proxy are settings; the proxy password never comes back", async (t) => {
  process.env.RAVNIR_AI_MEMORY = "off";
  const { createApp } = await import("../server/index.js");
  const home = tmp("app");
  const server = createApp({ home, projectRoot: ROOT });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { data: created } = await call("POST", "/api/bots", { name: "Booker", job: "Books seats.", model: { provider: "openai", baseUrl: "http://127.0.0.1:9", model: "m" } });
  const id = created.bot.id;
  let detail = (await call("GET", `/api/bots/${id}`)).data;
  assert.equal(detail.bot.browser.route, "auto");
  assert.equal(detail.network.macLinked, false);

  assert.equal((await call("PATCH", `/api/bots/${id}`, { browser: { route: "proxy" } })).status, 400, "a proxy route needs an address");
  assert.equal((await call("PATCH", `/api/bots/${id}`, { browser: { route: "proxy", proxy: "socks5://u:p@h:1" } })).status, 400);
  const saved = await call("PATCH", `/api/bots/${id}`, { browser: { route: "proxy", proxy: "http://ana:hunter22@proxy.example.com:3128" } });
  assert.equal(saved.status, 200);
  detail = (await call("GET", `/api/bots/${id}`)).data;
  assert.equal(detail.bot.browser.route, "proxy");
  assert.equal(detail.network.proxyHost, "proxy.example.com:3128");
  assert.doesNotMatch(JSON.stringify(detail), /hunter22/);
  assert.equal((await call("GET", "/api/browser/home-sites")).data.sites.length, 0);
  assert.equal((await call("DELETE", "/api/browser/home-sites/cinelux.es")).status, 404);
});
