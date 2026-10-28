import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { clearFlavorCache, reloadInstance } from "../server/providers/opencode.js";

test("reloadInstance disposes only the bot's OpenCode workspace, with its credentials", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url.startsWith("/global/health") ? JSON.stringify({ healthy: true }) : "true");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    clearFlavorCache();
    const bot = { model: { provider: "opencode", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "pw" } };
    const result = await reloadInstance(bot, "/data/bots/hot/workspace");
    assert.equal(result.ok, true);
    assert.ok(seen.some((item) => item.method === "POST" && item.url.startsWith("/mcp/ravnir/connect")));
    const dispose = seen.find((item) => item.url.startsWith("/instance/dispose"));
    assert.equal(dispose.method, "POST");
    assert.equal(new URL(dispose.url, "http://x").searchParams.get("directory"), "/data/bots/hot/workspace");
    assert.equal(dispose.auth, `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  } finally {
    server.close();
  }
});
