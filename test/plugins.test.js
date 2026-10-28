import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../scripts/mock-openai.js";
import { startOAuthMcp } from "../scripts/mock-oauth-mcp.js";
import { createApp } from "../server/index.js";
import { AuthError, parseChallenge } from "../server/pluginAuth.js";
import {
  builtinToolName,
  containerArgs,
  containerEnv,
  CURATED,
  isReadOnlyTool,
  loadCatalog,
  normalizeEntry,
  pluginDecision,
  tokenHeaderFor,
} from "../server/plugins.js";
import { normalizePolicy } from "../server/policy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(projectRoot, "test", "fixtures", "plugin-catalog.json");
process.env.RAVNIR_AI_MEMORY = "off";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ravnir-${name}-`));

// The fixture points at placeholders; each test aims them at its own mock servers.
function catalogFile(replacements) {
  let text = fs.readFileSync(fixture, "utf8");
  for (const [key, value] of Object.entries(replacements)) text = text.split(key).join(value);
  const file = path.join(tempDir("catalog"), "catalog.json");
  fs.writeFileSync(file, text);
  return file;
}

async function boot({ mock, open, runtime = { name: "", bin: "" }, home = tempDir("plugins"), env = {} } = {}) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const server = createApp({
    home,
    projectRoot,
    pluginCatalog: catalogFile({ __MOCK__: mock?.url || "http://127.0.0.1:1", __OPEN__: open?.url || "http://127.0.0.1:1" }),
    pluginRuntime: runtime,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return {
    server,
    home,
    base: `http://127.0.0.1:${server.address().port}`,
    services: server.services,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

async function api(app, method, pathname, body, { allow = [] } = {}) {
  const response = await fetch(`${app.base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!allow.includes(response.status)) assert.equal(response.ok, true, `${method} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
  return { status: response.status, data };
}

async function createBot(app, name = "Dev", model = {}) {
  const { data } = await api(app, "POST", "/api/bots", {
    name,
    job: "Works with plugins.",
    model: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "mock-model", ...model },
  });
  return data.bot.id;
}

// Press Connect, follow the service's redirect, and land on the real callback route.
async function signIn(app, id, body = {}) {
  const started = await api(app, "POST", `/api/plugins/${id}/connect`, body);
  assert.ok(started.data.authorizeUrl, JSON.stringify(started.data));
  const authorize = await fetch(started.data.authorizeUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const callbackUrl = authorize.headers.get("location");
  const page = await fetch(callbackUrl);
  return { authorizeUrl: started.data.authorizeUrl, callbackUrl, status: page.status, html: await page.text() };
}

async function plugin(app, id) {
  const { data } = await api(app, "GET", "/api/plugins");
  return data.plugins.find((item) => item.id === id);
}

// A call to the bot's own built-in MCP endpoint, the way OpenCode makes it.
async function builtin(app, botId, method, params = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(app.home, "bots", botId, "workspace", "opencode.json"), "utf8"));
  const { headers } = config.mcp.ravnir;
  const response = await fetch(`${app.base}/api/bots/${botId}/mcp`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

const callTool = (app, botId, name, args = {}) => builtin(app, botId, "tools/call", { name, arguments: args });

async function waitFor(check, { tries = 80, delay = 50 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await sleep(delay);
  }
  throw new Error("Timed out waiting.");
}

// ---- Units -------------------------------------------------------------------------------------

test("catalog: entries kept in code merge over the file, a missing file explains itself", () => {
  const merged = loadCatalog({
    file: fixture,
    extras: [{ id: "mockoauth", name: "Renamed", featured: false }, { id: "extra", name: "Extra", kind: "remote", remote: { url: "https://x.example/mcp" }, auth: "open" }],
  });
  assert.equal(merged.plugins.length, 7);
  const renamed = merged.plugins.find((item) => item.id === "mockoauth");
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.featured, false);
  assert.equal(renamed.remote.url, "__MOCK__/mcp", "fields the extra does not set stay from the file");
  assert.equal(merged.plugins.find((item) => item.id === "extra").auth, "open");
  assert.equal(merged.hint, "");

  const missing = loadCatalog({ file: path.join(tempDir("none"), "catalog.json") });
  assert.match(missing.hint, /not been generated/);
  assert.deepEqual(missing.plugins.map((item) => item.id), CURATED.map((item) => item.id), "only the entries in code remain");
  assert.equal(missing.plugins.filter((item) => item.id.startsWith("google-")).every((item) => item.comingSoon), true);
  assert.equal(missing.plugins.find((item) => item.id === "gmail").comingSoon, "", "Ravnir's own Gmail works without the catalog file");
});

test("catalog entries are normalized and unsafe ones dropped", () => {
  assert.equal(normalizeEntry({ id: "../evil", kind: "container", image: "x" }), null);
  assert.equal(normalizeEntry({ id: "noremote", kind: "remote" }), null);
  const sse = normalizeEntry({ id: "old", kind: "remote", remote: { url: "https://x.example/sse", transport: "sse" }, auth: "open" });
  assert.match(sse.comingSoon, /older connection type/);
  const box = normalizeEntry({ id: "b", kind: "container", image: "i", secrets: [{ key: "bad key" }, { key: "OK_KEY" }], shellEnv: ["GH_TOKEN", "no way"] });
  assert.deepEqual(box.secrets.map((item) => item.key), ["OK_KEY"]);
  assert.deepEqual(box.shellEnv, ["GH_TOKEN"]);
});

test("policy: read-only tools never ask, rules and the plugins switch decide the rest", () => {
  assert.equal(isReadOnlyTool({ name: "list_items" }), true);
  assert.equal(isReadOnlyTool({ name: "getUser" }), true);
  assert.equal(isReadOnlyTool({ name: "search" }), true);
  assert.equal(isReadOnlyTool({ name: "create_item" }), false);
  assert.equal(isReadOnlyTool({ name: "settings_get" }), false);
  assert.equal(isReadOnlyTool({ name: "delete_thing", annotations: { readOnlyHint: true } }), true);
  assert.equal(isReadOnlyTool({ name: "get_and_wipe", annotations: { readOnlyHint: false } }), false, "a server that says it writes is believed over the name");
  assert.equal(normalizePolicy({}).plugins, "ask");
  assert.equal(normalizePolicy({ plugins: "deny" }).plugins, "ask");
  assert.equal(pluginDecision({}, "mockoauth", "create_item"), "ask");
  assert.equal(pluginDecision({ plugins: "allow" }, "mockoauth", "create_item"), "allow");
  assert.equal(pluginDecision({ allow: ["plugin:mockoauth:create_item"] }, "mockoauth", "create_item"), "allow");
  assert.equal(pluginDecision({ allow: ["plugin:mockoauth:create_item"] }, "mockoauth", "delete_item"), "ask");
  assert.equal(pluginDecision({ allow: ["plugin:mockoauth:*"] }, "mockoauth", "delete_item"), "allow");
  assert.equal(pluginDecision({ allow: ["git status *"] }, "mockoauth", "create_item"), "ask");
});

test("helpers: token headers, tool names, container environment and arguments, challenges", () => {
  assert.deepEqual(tokenHeaderFor({ tokenHeader: "Authorization: Bearer" }, "abc"), { Authorization: "Bearer abc" });
  assert.deepEqual(tokenHeaderFor({ tokenHeader: "X-API-Key" }, "abc"), { "X-API-Key": "abc" });
  assert.deepEqual(tokenHeaderFor({ tokenHeader: "" }, "abc"), { Authorization: "Bearer abc" });
  assert.equal(builtinToolName("github", "create issue!"), "github__create_issue_");
  const long = builtinToolName("github", "x".repeat(100));
  assert.equal(long.length <= 64, true);
  assert.notEqual(long, builtinToolName("github", `${"x".repeat(99)}y`), "truncated names stay unique");

  const entry = normalizeEntry(JSON.parse(fs.readFileSync(fixture, "utf8")).plugins.find((item) => item.id === "boxplug"));
  assert.deepEqual(containerArgs(entry), ["run", "-i", "--rm", "--pull=missing", "--memory", "512m", "-e", "BOX_API_KEY", "-e", "BOX_REGION", "-e", "BOX_MODE", "example/boxplug"]);
  assert.deepEqual(containerEnv(entry, { secrets: { BOX_API_KEY: "k" }, inputs: { region: "eu" } }), { BOX_REGION: "eu", BOX_MODE: "fast", BOX_API_KEY: "k" });
  assert.deepEqual(containerEnv(entry, { secrets: { BOX_API_KEY: "k" }, inputs: {} }), { BOX_MODE: "fast", BOX_API_KEY: "k" }, "an empty input leaves its variable out");

  assert.deepEqual(parseChallenge('Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="a b"'), {
    realm: "x",
    resource_metadata: "https://a.example/.well-known/oauth-protected-resource",
    scope: "a b",
  });
  assert.equal(new AuthError("x", { expired: true }).expired, true);
});

// ---- The catalog through the API -------------------------------------------------------------

test("GET /api/plugins merges the catalog with connection status and hides what cannot run", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const { data } = await api(app, "GET", "/api/plugins");
    const ids = data.plugins.map((item) => item.id);
    assert.deepEqual(ids.slice(0, 4), ["mockoauth", "manualoauth", "github", "openplug"]);
    assert.equal(ids.includes("boxplug"), false, "container plugins are hidden without a runtime");
    assert.equal(data.hiddenCount, 1);
    assert.deepEqual(data.runtime, { name: "", available: false });
    assert.equal(data.redirectUri, `${app.base}/plugins/oauth/callback`);
    const notes = data.plugins.find((item) => item.id === "mockoauth");
    assert.equal(notes.connected, false);
    assert.equal(notes.auth, "oauth-dcr");
    assert.equal(notes.icon, "/plugins/icons/mockoauth.svg");
    assert.equal(data.plugins.find((item) => item.id === "deadplug").unreachable, true);
    assert.match(data.plugins.find((item) => item.id === "google-gmail").comingSoon, /Coming soon/);
    assert.equal(JSON.stringify(data).includes("probe"), false, "probe data stays on the server");

    for (const id of ["deadplug", "google-gmail"]) {
      const refused = await api(app, "POST", `/api/plugins/${id}/connect`, {}, { allow: [409] });
      assert.equal(refused.status, 409);
    }
    const none = await api(app, "POST", "/api/plugins/nope/connect", {}, { allow: [404] });
    assert.equal(none.status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("a container runtime brings the container plugins in; volumes stay hidden", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock, runtime: { name: "podman", bin: "podman" } });
  try {
    const { data } = await api(app, "GET", "/api/plugins");
    const box = data.plugins.find((item) => item.id === "boxplug");
    assert.equal(box.kind, "container");
    assert.deepEqual(box.secretFields.map((item) => item.key), ["BOX_API_KEY"]);
    assert.equal(box.secretFields[0].label, "Api key");
    assert.deepEqual(box.inputFields, [{ key: "region", label: "Region", description: "Region to use", required: true }]);
    assert.equal(data.hiddenCount, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

// ---- OAuth with dynamic registration -----------------------------------------------------------

test("OAuth: discovery, registration, PKCE and resource are used end to end through the real callback", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const result = await signIn(app, "mockoauth");
    assert.equal(result.status, 200);
    assert.match(result.html, /Mock Notes is connected/);
    assert.match(result.html, /BroadcastChannel/);
    assert.match(result.html, /window\.opener/);

    const registration = mock.registrations[0];
    assert.equal(registration.client_name, "Ravnir");
    assert.deepEqual(registration.redirect_uris, [`${app.base}/plugins/oauth/callback`]);
    assert.equal(registration.token_endpoint_auth_method, "none");
    const authorize = mock.authorizeRequests[0];
    assert.equal(authorize.code_challenge_method, "S256");
    assert.equal(authorize.resource, mock.mcpUrl, "RFC 8707: the token is for this MCP server");
    assert.equal(authorize.scope, "items");
    assert.ok(authorize.state.length >= 24);
    const exchange = mock.tokenRequests[0];
    assert.equal(exchange.grant_type, "authorization_code");
    assert.ok(exchange.code_verifier.length >= 43);
    assert.equal(exchange.resource, mock.mcpUrl);

    const status = await plugin(app, "mockoauth");
    assert.equal(status.connected, true);
    assert.equal(status.status, "connected");
    assert.equal(status.account, "Mock Workspace");

    // The same state cannot be used twice, and an unknown one is refused.
    const replay = await fetch(result.callbackUrl);
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /expired or was already used/);
    const forged = await fetch(`${app.base}/plugins/oauth/callback?code=x&state=nope`);
    assert.equal(forged.status, 400);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("OAuth: a pending sign-in shows as pending, a cancelled one leaves nothing behind", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const started = await api(app, "POST", "/api/plugins/mockoauth/connect", {});
    assert.equal((await plugin(app, "mockoauth")).pending, true);
    const state = new URL(started.data.authorizeUrl).searchParams.get("state");
    const cancelled = await fetch(`${app.base}/plugins/oauth/callback?error=access_denied&state=${state}`);
    assert.equal(cancelled.status, 400);
    assert.match(await cancelled.text(), /cancelled/);
    const after = await plugin(app, "mockoauth");
    assert.equal(after.connected, false);
    assert.equal(after.pending, false);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("OAuth: the sign-in returns to the browser's own address, can be cancelled and started again", async () => {
  // On the hub RAVNIR_PUBLIC_URL is 127.0.0.1 (for OpenCode); Vercel sent the phone back there and the sign-in never finished.
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  const start = async (headers) => {
    const response = await fetch(`${app.base}/api/plugins/mockoauth/connect`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    assert.equal(response.ok, true);
    return new URL((await response.json()).authorizeUrl);
  };
  try {
    const fromApp = await start({ origin: "https://hub.example.ts.net:8443", "sec-fetch-site": "same-origin" });
    assert.equal(fromApp.searchParams.get("redirect_uri"), "https://hub.example.ts.net:8443/plugins/oauth/callback");
    const fromScript = await start({ origin: "https://elsewhere.example" });
    assert.equal(fromScript.searchParams.get("redirect_uri"), `${app.base}/plugins/oauth/callback`, "an Origin without same-origin is not trusted");

    // Starting again replaced the first attempt, so its state no longer finishes anything.
    const stale = await fetch(`${app.base}/plugins/oauth/callback?code=x&state=${fromApp.searchParams.get("state")}`);
    assert.equal(stale.status, 400);
    assert.equal((await plugin(app, "mockoauth")).pending, true);

    await api(app, "POST", "/api/plugins/mockoauth/cancel", {});
    assert.equal((await plugin(app, "mockoauth")).pending, false);
    const after = await fetch(`${app.base}/plugins/oauth/callback?code=x&state=${fromScript.searchParams.get("state")}`);
    assert.equal(after.status, 400, "a cancelled sign-in cannot finish");
  } finally {
    await app.close();
    await mock.close();
  }
});

test("OAuth: a service that only returns to the user's own computer finishes with the pasted address", async () => {
  // Vercel refuses any return address but 127.0.0.1 or localhost, so from a server the browser lands on a dead page.
  const mock = await startOAuthMcp({ loopbackOnly: true });
  const app = await boot({ mock });
  try {
    const response = await fetch(`${app.base}/api/plugins/mockoauth/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hub.example.ts.net:8443", "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    const started = await response.json();
    assert.equal(started.paste, true, JSON.stringify(started));
    assert.equal(new URL(started.authorizeUrl).searchParams.get("redirect_uri"), "http://127.0.0.1:3847/plugins/oauth/callback");
    const authorize = await fetch(started.authorizeUrl, { redirect: "manual" });
    const landed = authorize.headers.get("location");
    assert.match(landed, /^http:\/\/127\.0\.0\.1:3847\/plugins\/oauth\/callback\?/);

    const junk = await api(app, "POST", "/api/plugins/mockoauth/finish", { url: "not an address" }, { allow: [400] });
    assert.equal(junk.status, 400);
    const finished = await api(app, "POST", "/api/plugins/mockoauth/finish", { url: landed });
    assert.equal(finished.data.ok, true);
    const item = await plugin(app, "mockoauth");
    assert.equal(item.connected, true);
    assert.equal(item.pending, false);
    const again = await api(app, "POST", "/api/plugins/mockoauth/finish", { url: landed }, { allow: [400] });
    assert.equal(again.status, 400, "the same address cannot be used twice");
  } finally {
    await app.close();
    await mock.close();
  }
});

test("OAuth: the callback needs the sign-in when the server has a password", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock, env: { RAVNIR_USER: "owner", RAVNIR_PASSWORD: "pw-for-tests" } });
  try {
    const basic = { authorization: `Basic ${Buffer.from("owner:pw-for-tests").toString("base64")}` };
    const started = await (await fetch(`${app.base}/api/plugins/mockoauth/connect`, { method: "POST", headers: { ...basic, "content-type": "application/json" }, body: "{}" })).json();
    const authorize = await fetch(started.authorizeUrl, { redirect: "manual" });
    const callbackUrl = authorize.headers.get("location");
    const anonymous = await fetch(callbackUrl, { redirect: "manual" });
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get("location"), /^\/login\?next=/);
    const signedIn = await fetch(callbackUrl, { headers: basic });
    assert.equal(signedIn.status, 200);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("OAuth: manual clients need an ID, then use it (and the secret) for the token", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const missing = await api(app, "POST", "/api/plugins/manualoauth/connect", {}, { allow: [400] });
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /client ID/);

    const result = await signIn(app, "manualoauth", { clientId: "manual-abc", clientSecret: "shh-secret-value" });
    assert.equal(result.status, 200);
    assert.equal(mock.registrations.length, 0, "no registration for a manual client");
    assert.equal(mock.authorizeRequests[0].client_id, "manual-abc");
    assert.equal(mock.tokenRequests[0].client_id, "manual-abc");
    assert.equal(mock.tokenRequests[0].client_secret, "shh-secret-value");
    assert.equal((await plugin(app, "manualoauth")).connected, true);
    assert.equal(JSON.stringify((await api(app, "GET", "/api/plugins")).data).includes("shh-secret-value"), false);
  } finally {
    await app.close();
    await mock.close();
  }
});

// ---- Giving a plugin to agents -----------------------------------------------------------------

test("assigning creates a managed connector, OpenCode sees the tools through the built-in endpoint, removing takes them away", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const botId = await createBot(app);
    const refused = await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [botId] }, { allow: [409] });
    assert.equal(refused.status, 409, "connect first");
    await signIn(app, "mockoauth");

    const set = await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [botId, "not-a-bot"] });
    assert.deepEqual(set.data.agents, [{ id: botId, status: "connected", error: "", tools: 2 }]);
    const { data: detail } = await api(app, "GET", `/api/bots/${botId}`);
    const connector = detail.bot.connectors.find((item) => item.managed === "plugin:mockoauth");
    assert.equal(connector.transport, "http");
    assert.equal(connector.url, mock.mcpUrl);
    assert.equal(connector.status, "connected");
    assert.deepEqual(connector.tools.map((tool) => tool.name), ["list_items", "create_item"]);
    assert.deepEqual((await plugin(app, "mockoauth")).bots, [botId]);
    assert.deepEqual((await plugin(app, "mockoauth")).tools, [{ name: "list_items", readOnly: true }, { name: "create_item", readOnly: false }]);
    // The prompt names the account the plugin is signed in as.
    assert.match((await api(app, "GET", `/api/bots/${botId}/prompt`)).data.livePrompt, /\(signed in as Mock Workspace\)/);

    const raw = app.services.state.bots.find((bot) => bot.id === botId).connectors.find((item) => item.managed === "plugin:mockoauth");
    assert.equal(raw.skipOpenCode, true);
    const config = JSON.parse(fs.readFileSync(path.join(app.home, "bots", botId, "workspace", "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.mcp), ["ravnir"], "OpenCode gets the plugin only through Ravnir's own endpoint");

    const listed = await builtin(app, botId, "tools/list");
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("mockoauth__list_items"));
    assert.ok(names.includes("mockoauth__create_item"));
    assert.ok(names.includes("run_command"), "the built-in tools are still there");
    const read = await callTool(app, botId, "mockoauth__list_items");
    assert.equal(read.isError, false);
    assert.match(read.content[0].text, /first item/);
    assert.equal(mock.calls.at(-1).tool, "list_items");
    assert.ok(mock.issued.includes(mock.calls.at(-1).token), "the call carried the token Ravnir got from the service");

    const none = await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [] });
    assert.deepEqual(none.data.agents, []);
    const after = await builtin(app, botId, "tools/list");
    assert.equal(after.tools.some((tool) => tool.name.startsWith("mockoauth__")), false);
    const gone = (await api(app, "GET", `/api/bots/${botId}`)).data.bot.connectors;
    assert.equal(gone.some((item) => item.managed === "plugin:mockoauth"), false);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("removing the connector in the MCP panel, or deleting the agent, updates the plugin", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const first = await createBot(app, "One");
    const second = await createBot(app, "Two");
    await signIn(app, "mockoauth");
    await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [first, second] });
    const connector = (await api(app, "GET", `/api/bots/${first}`)).data.bot.connectors.find((item) => item.managed === "plugin:mockoauth");
    await api(app, "DELETE", `/api/bots/${first}/connectors/${connector.id}`);
    assert.deepEqual((await plugin(app, "mockoauth")).bots, [second]);
    await api(app, "DELETE", `/api/bots/${second}`);
    assert.deepEqual((await plugin(app, "mockoauth")).bots, []);
  } finally {
    await app.close();
    await mock.close();
  }
});

// ---- Tokens that expire ------------------------------------------------------------------------

test("an access token that is about to expire is refreshed before the call", async () => {
  // 30 s of life is inside the one-minute margin, so every call renews first.
  const mock = await startOAuthMcp({ accessTtlMs: 30_000 });
  const app = await boot({ mock });
  try {
    const botId = await createBot(app);
    await signIn(app, "mockoauth");
    await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [botId] });
    const refreshes = () => mock.tokenRequests.filter((item) => item.grant_type === "refresh_token").length;
    const before = refreshes();
    assert.ok(before >= 1, "connecting already renewed once");
    const result = await callTool(app, botId, "mockoauth__list_items");
    assert.equal(result.isError, false);
    assert.ok(refreshes() > before);
    assert.equal(mock.tokenRequests.filter((item) => item.grant_type === "refresh_token").every((item) => item.resource === mock.mcpUrl), true);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("a 401 refreshes once and goes on; a dead refresh token marks the plugin expired until reconnected", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const botId = await createBot(app);
    await signIn(app, "mockoauth");
    await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [botId] });
    assert.equal(mock.tokenRequests.filter((item) => item.grant_type === "refresh_token").length, 0, "a fresh token is not renewed");

    mock.expireAccess();
    const worked = await callTool(app, botId, "mockoauth__list_items");
    assert.equal(worked.isError, false, JSON.stringify(worked));
    assert.equal(mock.tokenRequests.filter((item) => item.grant_type === "refresh_token").length, 1);

    mock.expireAccess();
    mock.breakRefresh();
    const failed = await callTool(app, botId, "mockoauth__list_items");
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /sign in again/i);
    const expired = await plugin(app, "mockoauth");
    assert.equal(expired.status, "expired");
    assert.match(expired.error, /Reconnect/);
    const before = mock.tokenRequests.length;
    await callTool(app, botId, "mockoauth__list_items");
    assert.equal(mock.tokenRequests.length, before, "no more requests to the service while it is expired");
    const prompt = (await api(app, "GET", `/api/bots/${botId}/prompt`)).data.livePrompt;
    assert.equal(prompt.includes("Your plugins"), false, "an expired plugin is not offered to the agent");

    mock.refreshBroken = false;
    await signIn(app, "mockoauth");
    assert.equal((await plugin(app, "mockoauth")).status, "connected");
    assert.deepEqual((await plugin(app, "mockoauth")).bots, [botId], "a reconnect keeps the agents");
    const again = await callTool(app, botId, "mockoauth__list_items");
    assert.equal(again.isError, false, JSON.stringify(again));
  } finally {
    await app.close();
    await mock.close();
  }
});

// ---- Approvals -----------------------------------------------------------------------------------

test("a tool that changes something asks first; reading never does; Always allow saves a visible rule", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const botId = await createBot(app, "Dev");
    await signIn(app, "mockoauth");
    await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [botId] });

    const read = await callTool(app, botId, "mockoauth__list_items");
    assert.equal(read.isError, false);
    assert.equal((await api(app, "GET", "/api/approvals")).data.pending.length, 0);

    // Allow once.
    let pendingCall = callTool(app, botId, "mockoauth__create_item", { name: "alpha" });
    let request = await waitFor(async () => (await api(app, "GET", "/api/approvals")).data.pending[0]);
    assert.equal(request.kind, "plugin");
    assert.equal(request.title, "Dev wants to use Mock Notes: create_item");
    assert.match(request.detail, /"name": "alpha"/);
    assert.equal(request.rule, "plugin:mockoauth:create_item");
    assert.equal(mock.calls.some((call) => call.tool === "create_item"), false, "nothing happened yet");
    await api(app, "POST", `/api/approvals/${request.id}`, { decision: "once" });
    let result = await pendingCall;
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /created 2: alpha/);

    // Deny.
    pendingCall = callTool(app, botId, "mockoauth__create_item", { name: "beta" });
    request = await waitFor(async () => (await api(app, "GET", "/api/approvals")).data.pending[0]);
    await api(app, "POST", `/api/approvals/${request.id}`, { decision: "reject" });
    result = await pendingCall;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /did not approve/);
    assert.equal(mock.items.some((item) => item.name === "beta"), false);

    // Always allow.
    pendingCall = callTool(app, botId, "mockoauth__create_item", { name: "gamma" });
    request = await waitFor(async () => (await api(app, "GET", "/api/approvals")).data.pending[0]);
    await api(app, "POST", `/api/approvals/${request.id}`, { decision: "always" });
    assert.equal((await pendingCall).isError, false);
    const bot = (await api(app, "GET", `/api/bots/${botId}`)).data.bot;
    assert.deepEqual(bot.policy.allow, ["plugin:mockoauth:create_item"]);
    const quiet = await callTool(app, botId, "mockoauth__create_item", { name: "delta" });
    assert.equal(quiet.isError, false);
    assert.equal((await api(app, "GET", "/api/approvals")).data.pending.length, 0, "the saved rule answers for the user");

    // The agent-wide switch.
    await api(app, "PATCH", `/api/bots/${botId}`, { policy: { allow: [], plugins: "allow" } });
    assert.equal((await callTool(app, botId, "mockoauth__create_item", { name: "epsilon" })).isError, false);
    assert.equal((await api(app, "GET", "/api/approvals")).data.pending.length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("the model loop uses plugin tools too: reads run, writes wait for the user", async () => {
  const mock = await startOAuthMcp();
  const model = await startMock();
  const app = await boot({ mock });
  try {
    const botId = await createBot(app, "Loop", { baseUrl: model.url });
    await signIn(app, "mockoauth");
    await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [botId] });
    const connector = (await api(app, "GET", `/api/bots/${botId}`)).data.bot.connectors.find((item) => item.managed === "plugin:mockoauth");
    const prefix = `mcp_${connector.id.slice(0, 6)}`;

    const events = async (after) => (await api(app, "GET", `/api/bots/${botId}/events?after=${after}`)).data;
    const run = async (text) => {
      const cursor = (await api(app, "GET", `/api/bots/${botId}/events?after=0`)).data.cursor;
      const sent = await api(app, "POST", `/api/bots/${botId}/messages`, { text });
      return { cursor, turnId: sent.data.turnId };
    };
    const finished = async ({ cursor, turnId }) => {
      let seen = cursor;
      const all = [];
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await sleep(100);
        const data = await events(seen);
        seen = data.cursor;
        all.push(...data.events);
        if (all.some((event) => event.type === "turn.end" && event.turnId === turnId)) return all;
      }
      throw new Error("The turn did not finish.");
    };

    const readTurn = await finished(await run(`call tool ${prefix}_list_items {}`));
    assert.equal(readTurn.some((event) => event.type === "permission"), false);
    assert.match(JSON.stringify(readTurn), /first item/);

    const writeStart = await run(`call tool ${prefix}_create_item {"name":"from the loop"}`);
    const request = await waitFor(async () => (await api(app, "GET", "/api/approvals")).data.pending[0]);
    assert.equal(request.title, "Loop wants to use Mock Notes: create_item");
    assert.equal(mock.items.some((item) => item.name === "from the loop"), false);
    await api(app, "POST", `/api/approvals/${request.id}`, { decision: "once" });
    const writeTurn = await finished(writeStart);
    assert.equal(writeTurn.some((event) => event.type === "error"), false, JSON.stringify(writeTurn.filter((event) => event.type === "error")));
    assert.equal(mock.items.some((item) => item.name === "from the loop"), true);
  } finally {
    await app.close();
    await model.close();
    await mock.close();
  }
});

// ---- Pasted tokens, open servers, shell login ------------------------------------------------------

test("token plugins check the token first; the login reaches the shell, git and the prompt, and stays out of the model's output", async () => {
  const mock = await startOAuthMcp({ staticToken: "pasted-token-12345" });
  const app = await boot({ mock });
  try {
    const botId = await createBot(app);
    const empty = await api(app, "POST", "/api/plugins/github/connect", {}, { allow: [400] });
    assert.equal(empty.status, 400);
    const wrong = await api(app, "POST", "/api/plugins/github/connect", { token: "not-the-token" }, { allow: [502] });
    assert.equal(wrong.status, 502);
    assert.match(wrong.data.error, /Could not connect to GitHub/);
    assert.equal((await plugin(app, "github")).connected, false, "a token that does not work is not saved");

    const ok = await api(app, "POST", "/api/plugins/github/connect", { token: "pasted-token-12345" });
    assert.equal(ok.data.connection.connected, true);
    await api(app, "PUT", "/api/plugins/github/bots", { bots: [botId] });
    const read = await callTool(app, botId, "github__list_items");
    assert.equal(read.isError, false);
    assert.equal(mock.calls.at(-1).token, "pasted-token-12345");

    // The shell: GH_TOKEN is set, the output is masked, git is told to ask gh.
    await api(app, "PATCH", `/api/bots/${botId}`, { policy: { shell: "allow" } });
    const set = await callTool(app, botId, "run_command", { command: "test \"$GH_TOKEN\" = pasted-token-12345 && test \"$GITHUB_TOKEN\" = pasted-token-12345 && echo both-set" });
    assert.match(set.content[0].text, /both-set/);
    const echoed = await callTool(app, botId, "run_command", { command: "echo $GH_TOKEN" });
    assert.equal(echoed.content[0].text.includes("pasted-token-12345"), false);
    assert.match(echoed.content[0].text, /\[redacted\]/);
    const gitconfig = fs.readFileSync(path.join(app.home, "bots", botId, ".gitconfig"), "utf8");
    assert.match(gitconfig, /\[credential "https:\/\/github.com"\]\n\thelper = !gh auth git-credential/);
    assert.equal(gitconfig.includes("pasted-token-12345"), false);

    const prompt = (await api(app, "GET", `/api/bots/${botId}/prompt`)).data.livePrompt;
    assert.match(prompt, /Your plugins/);
    assert.match(prompt, /Your GitHub login is in the shell: use run_command for gh and git push\./);
    assert.match(prompt, /gh api user --jq \.login/);

    const tested = await api(app, "POST", "/api/plugins/github/test", {});
    assert.equal(tested.data.ok, true);
    assert.deepEqual(tested.data.tools.map((tool) => tool.name), ["list_items", "create_item"]);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("open plugins connect without a sign-in", async () => {
  const open = await startOAuthMcp({ open: true });
  const app = await boot({ open });
  try {
    const connected = await api(app, "POST", "/api/plugins/openplug/connect", {});
    assert.equal(connected.data.connection.status, "connected");
    const botId = await createBot(app);
    const set = await api(app, "PUT", "/api/plugins/openplug/bots", { bots: [botId] });
    assert.equal(set.data.agents[0].tools, 2);
    assert.equal(open.calls.length, 0);
  } finally {
    await app.close();
    await open.close();
  }
});

test("disconnecting and connecting again gives the plugin back to the same agents", async () => {
  const open = await startOAuthMcp({ open: true });
  const app = await boot({ open });
  try {
    await api(app, "POST", "/api/plugins/openplug/connect", {});
    const botId = await createBot(app);
    await api(app, "PUT", "/api/plugins/openplug/bots", { bots: [botId] });
    await api(app, "DELETE", "/api/plugins/openplug");
    assert.equal((await builtin(app, botId, "tools/list")).tools.some((tool) => tool.name.startsWith("openplug__")), false);

    const again = await api(app, "POST", "/api/plugins/openplug/connect", {});
    assert.deepEqual(again.data.connection.bots, [botId]);
    const listed = await builtin(app, botId, "tools/list");
    assert.ok(listed.tools.some((tool) => tool.name.startsWith("openplug__")));
    assert.equal(app.services.state.pluginAgents?.openplug, undefined);
  } finally {
    await app.close();
    await open.close();
  }
});

// ---- Containers ----------------------------------------------------------------------------------

test("container plugins: the form becomes environment variables for the run command, secrets stay in the vault", async () => {
  const dir = tempDir("runtime");
  const bin = path.join(dir, "docker");
  // Stands in for docker: speaks MCP on stdio and reports the variables it was given.
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    else if (message.method === "tools/list") reply({ tools: [{ name: "get_env", description: "Report the environment.", inputSchema: { type: "object", properties: {} } }] });
    else if (message.method === "tools/call") reply({ content: [{ type: "text", text: "key=" + process.env.BOX_API_KEY + " region=" + process.env.BOX_REGION + " mode=" + process.env.BOX_MODE + " args=" + args.join(" ") }] });
  }
});
`, { mode: 0o755 });
  const app = await boot({ runtime: { name: "docker", bin } });
  try {
    const botId = await createBot(app);
    const noKey = await api(app, "POST", "/api/plugins/boxplug/connect", { env: { region: "eu" } }, { allow: [400] });
    assert.equal(noKey.status, 400);
    assert.match(noKey.data.error, /Api key is required/);
    const noRegion = await api(app, "POST", "/api/plugins/boxplug/connect", { secrets: { BOX_API_KEY: "box-secret-777" } }, { allow: [400] });
    assert.match(noRegion.data.error, /Region is required/);

    await api(app, "POST", "/api/plugins/boxplug/connect", { secrets: { BOX_API_KEY: "box-secret-777" }, env: { region: "eu" } });
    const set = await api(app, "PUT", "/api/plugins/boxplug/bots", { bots: [botId] });
    assert.equal(set.data.agents[0].status, "new", "a container starts on first use");
    const connector = app.services.state.bots.find((bot) => bot.id === botId).connectors.find((item) => item.managed === "plugin:boxplug");
    assert.equal(connector.command, bin);
    assert.deepEqual(connector.args.slice(0, 6), ["run", "-i", "--rm", "--pull=missing", "--memory", "512m"]);
    assert.equal(connector.args.at(-1), "example/boxplug");
    assert.equal(connector.args.includes("box-secret-777"), false, "values never go on the command line");

    const listed = await builtin(app, botId, "tools/list");
    assert.ok(listed.tools.some((tool) => tool.name === "boxplug__get_env"));
    const result = await callTool(app, botId, "boxplug__get_env");
    assert.match(result.content[0].text, /key=box-secret-777 region=eu mode=fast args=run -i --rm/);
    assert.equal(result.content[0].text.includes("-e BOX_API_KEY"), true);

    const tested = await api(app, "POST", "/api/plugins/boxplug/test", {});
    assert.equal(tested.data.ok, true);

    const leaks = JSON.stringify([
      (await api(app, "GET", "/api/state")).data,
      (await api(app, "GET", "/api/plugins")).data,
      (await api(app, "GET", `/api/bots/${botId}`)).data,
      fs.readFileSync(path.join(app.home, "state.json"), "utf8"),
      fs.readFileSync(path.join(app.home, "bots", botId, "workspace", "opencode.json"), "utf8"),
    ]);
    assert.equal(leaks.includes("box-secret-777"), false);
  } finally {
    await app.close();
  }
});

// ---- Disconnect and secrets --------------------------------------------------------------------------

test("disconnect revokes the sign-in, removes the connectors and deletes the secrets", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const botId = await createBot(app);
    await signIn(app, "mockoauth");
    await api(app, "PUT", "/api/plugins/mockoauth/bots", { bots: [botId] });
    assert.ok(app.services.secrets.get("plugin:mockoauth"));
    const refreshToken = mock.issued.find((token) => token.startsWith("rt-"));

    const removed = await api(app, "DELETE", "/api/plugins/mockoauth");
    assert.equal(removed.data.revoked, true);
    assert.deepEqual(mock.revoked, [refreshToken]);
    assert.equal(app.services.secrets.get("plugin:mockoauth", null), null);
    assert.deepEqual(app.services.state.plugins, {});
    const bot = (await api(app, "GET", `/api/bots/${botId}`)).data.bot;
    assert.equal(bot.connectors.some((item) => item.managed === "plugin:mockoauth"), false);
    const listed = await builtin(app, botId, "tools/list");
    assert.equal(listed.tools.some((tool) => tool.name.startsWith("mockoauth__")), false);
    assert.equal((await plugin(app, "mockoauth")).connected, false);
    const again = await api(app, "DELETE", "/api/plugins/mockoauth", undefined, { allow: [404] });
    assert.equal(again.status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("secrets never appear in state, the API, events, the thread, approvals or opencode.json", async () => {
  const mock = await startOAuthMcp();
  const app = await boot({ mock });
  try {
    const botId = await createBot(app);
    await signIn(app, "manualoauth", { clientId: "manual-leakcheck", clientSecret: "client-secret-leak-check" });
    await api(app, "PUT", "/api/plugins/manualoauth/bots", { bots: [botId] });
    mock.expireAccess();
    await callTool(app, botId, "manualoauth__list_items");
    const pending = callTool(app, botId, "manualoauth__create_item", { name: "leak check" });
    const request = await waitFor(async () => (await api(app, "GET", "/api/approvals")).data.pending[0]);
    await api(app, "POST", `/api/approvals/${request.id}`, { decision: "once" });
    await pending;

    const secrets = [...mock.issued, "client-secret-leak-check"];
    assert.ok(secrets.length >= 4, "the service issued tokens");
    const read = (file) => fs.readFileSync(path.join(app.home, file), "utf8");
    const botDir = path.join("bots", botId);
    const haystacks = {
      state: JSON.stringify((await api(app, "GET", "/api/state")).data),
      plugins: JSON.stringify((await api(app, "GET", "/api/plugins")).data),
      bot: JSON.stringify((await api(app, "GET", `/api/bots/${botId}`)).data),
      approvals: JSON.stringify((await api(app, "GET", "/api/approvals")).data),
      events: JSON.stringify((await api(app, "GET", `/api/bots/${botId}/events?after=0`)).data),
      stateFile: read("state.json"),
      approvalsFile: read("approvals.json"),
      opencode: read(path.join(botDir, "workspace", "opencode.json")),
      conversation: fs.existsSync(path.join(app.home, botDir, "conversation.json")) ? read(path.join(botDir, "conversation.json")) : "",
    };
    for (const [name, text] of Object.entries(haystacks)) {
      for (const secret of secrets) assert.equal(text.includes(secret), false, `${name} contains a secret`);
    }
    // The vault file is encrypted on disk.
    const vaultFile = read("secrets.enc");
    for (const secret of secrets) assert.equal(vaultFile.includes(secret), false);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("Gmail is Ravnir's own plugin: it checks the login on connect and replaces the registry image", async () => {
  const catalog = loadCatalog({ file: catalogFile({}), extras: CURATED });
  assert.equal(catalog.plugins.some((item) => item.id === "gmail-mcp"), false);
  const gmail = catalog.plugins.find((item) => item.id === "gmail");
  assert.equal(gmail.kind, "local");
  assert.equal(gmail.script, "bin/gmail-mcp.mjs");
  assert.equal(normalizeEntry({ id: "x", kind: "local", script: "../server/index.js" }), null, "local plugins run only scripts in bin/");

  // Nothing listens on port 1, so the server reports the network, and nothing is saved.
  const app = await boot({ env: { GMAIL_IMAP_HOST: "127.0.0.1", GMAIL_IMAP_PORT: "1" } });
  const saved = { host: process.env.GMAIL_IMAP_HOST, port: process.env.GMAIL_IMAP_PORT };
  process.env.GMAIL_IMAP_HOST = "127.0.0.1";
  process.env.GMAIL_IMAP_PORT = "1";
  try {
    const { data } = await api(app, "GET", "/api/plugins");
    const card = data.plugins.find((item) => item.id === "gmail");
    assert.equal(card.featured, true);
    assert.deepEqual(card.secretFields.map((field) => field.key), ["GMAIL_APP_PASSWORD"]);
    assert.deepEqual(card.inputFields.map((field) => field.key), ["GMAIL_ADDRESS"]);
    const missing = await api(app, "POST", "/api/plugins/gmail/connect", { env: { GMAIL_ADDRESS: "me@example.com" } }, { allow: [400] });
    assert.equal(missing.status, 400);
    const down = await api(app, "POST", "/api/plugins/gmail/connect", { env: { GMAIL_ADDRESS: "me@example.com" }, secrets: { GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" } }, { allow: [400] });
    assert.equal(down.status, 400);
    assert.match(down.data.error, /Could not reach Gmail/);
    assert.equal(JSON.stringify(down.data).includes("abcd efgh"), false);
    const after = await api(app, "GET", "/api/plugins");
    assert.equal(after.data.plugins.find((item) => item.id === "gmail").connected, false);
  } finally {
    for (const [key, value] of [["GMAIL_IMAP_HOST", saved.host], ["GMAIL_IMAP_PORT", saved.port]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
  }
});
