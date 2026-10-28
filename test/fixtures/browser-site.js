import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BrowserManager } from "../../server/browser.js";

// A real browser for one agent and a stand-in site on 127.0.0.1, for the browser
// tool tests. Each route is HTML, or { body, delay, status, headers }. Skips the
// test when Chromium cannot start here.
export async function withBrowser(t, routes, run) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url.split("?")[0]];
    if (!route) return res.writeHead(404, { "content-type": "text/html" }).end("<title>Not found</title>");
    const { delay = 0, status = 200, headers = {}, body = "" } = typeof route === "string" ? { body: route } : route;
    setTimeout(() => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    }, delay);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-browser-"));
  const browser = new BrowserManager({ home });
  const bot = { id: `b-${Math.random().toString(16).slice(2, 8)}`, name: "Tester", vault: [], jobs: [] };
  const ctx = { bot, home, browser, secrets: { get() {} }, save() {}, emit() {}, state: { bots: [bot] } };
  try {
    let session;
    try {
      session = await browser.ensure(bot);
    } catch (error) {
      t.skip(`no browser here: ${error.message}`);
      return;
    }
    await run({ base, browser, bot, ctx, session });
  } finally {
    await browser.closeAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}
