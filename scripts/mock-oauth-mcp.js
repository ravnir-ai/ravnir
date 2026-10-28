import crypto from "node:crypto";
import http from "node:http";

// A stand-in for a real plugin service, for tests: one HTTP server that is both
//   - an MCP server (streamable HTTP at /mcp) that needs a bearer token, with a read tool
//     (list_items) and a write tool (create_item), and
//   - its own OAuth authorization server (RFC 9728 and 8414 metadata, dynamic client
//     registration, /authorize that sends the browser straight back with a code, /token with
//     PKCE and refresh tokens, /revoke).
//
//   const mock = await startOAuthMcp({ accessTtlMs: 3_600_000 });
//   mock.url            base URL, e.g. http://127.0.0.1:41234
//   mock.mcpUrl         the MCP endpoint
//   mock.calls          every tools/call the MCP endpoint served
//   mock.tokenRequests  every /token request body
//   mock.issued         every access and refresh token handed out (for leak checks)
//   open: true          no sign-in needed at all (a public MCP server)
//   staticToken         a fixed bearer token is accepted too (a pasted API token)
//   mock.expireAccess() every access token stops working (the next call gets a 401)
//   mock.breakRefresh() refresh tokens are refused with invalid_grant

export function startOAuthMcp({ accessTtlMs = 3_600_000, staticToken = "", open = false, loopbackOnly = false } = {}) {
  const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
  const clients = new Map();
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const mock = {
    url: "",
    mcpUrl: "",
    calls: [],
    tokenRequests: [],
    registrations: [],
    authorizeRequests: [],
    revoked: [],
    issued: [],
    items: [{ id: 1, name: "first item" }],
    sessions: new Set(),
    refreshBroken: false,
    expireAccess() {
      access.clear();
    },
    breakRefresh() {
      mock.refreshBroken = true;
    },
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, mock.url || "http://127.0.0.1");
    const base = mock.url;
    const json = (status, body, headers = {}) => {
      const data = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { "content-type": "application/json", "content-length": data.length, ...headers });
      res.end(data);
    };
    try {
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["items"] });
        return;
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          revocation_endpoint: `${base}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/register") {
        const body = JSON.parse(await readText(req));
        // Like Vercel: only a return address on the user's own computer.
        if (loopbackOnly && !(body.redirect_uris || []).every((uri) => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri))) {
          json(400, { error: "invalid_redirect_uri", error_description: "The provided redirect URIs are not approved for use by this authorization server." });
          return;
        }
        const clientId = `client-${crypto.randomUUID()}`;
        clients.set(clientId, { redirectUris: body.redirect_uris || [], secret: "" });
        mock.registrations.push(body);
        json(201, { client_id: clientId, redirect_uris: body.redirect_uris, token_endpoint_auth_method: body.token_endpoint_auth_method || "none" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/authorize") {
        const q = url.searchParams;
        mock.authorizeRequests.push(Object.fromEntries(q));
        const client = clients.get(q.get("client_id")) || manualClient(q.get("client_id"));
        const ok = client
          && q.get("response_type") === "code"
          && q.get("code_challenge_method") === "S256"
          && q.get("code_challenge")
          && (client.redirectUris.length === 0 || client.redirectUris.includes(q.get("redirect_uri")));
        if (!ok) {
          json(400, { error: "invalid_request" });
          return;
        }
        const code = b64(crypto.randomBytes(18));
        codes.set(code, { clientId: q.get("client_id"), redirectUri: q.get("redirect_uri"), challenge: q.get("code_challenge"), resource: q.get("resource") || "" });
        const back = new URL(q.get("redirect_uri"));
        back.searchParams.set("code", code);
        if (q.get("state")) back.searchParams.set("state", q.get("state"));
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        const form = new URLSearchParams(await readText(req));
        mock.tokenRequests.push(Object.fromEntries(form));
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          const entry = codes.get(form.get("code"));
          codes.delete(form.get("code"));
          const verifierHash = b64(crypto.createHash("sha256").update(form.get("code_verifier") || "").digest());
          if (!entry || entry.challenge !== verifierHash || entry.redirectUri !== form.get("redirect_uri") || form.get("client_id") !== entry.clientId) {
            json(400, { error: "invalid_grant" });
            return;
          }
          json(200, issue(entry.clientId));
          return;
        }
        if (grant === "refresh_token") {
          const entry = refresh.get(form.get("refresh_token"));
          if (!entry || mock.refreshBroken) {
            json(400, { error: "invalid_grant", error_description: "The refresh token is no longer valid." });
            return;
          }
          // Refresh tokens rotate: the old one stops working.
          refresh.delete(form.get("refresh_token"));
          json(200, issue(entry.clientId));
          return;
        }
        json(400, { error: "unsupported_grant_type" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/revoke") {
        const form = new URLSearchParams(await readText(req));
        mock.revoked.push(form.get("token"));
        access.delete(form.get("token"));
        refresh.delete(form.get("token"));
        json(200, {});
        return;
      }
      if (url.pathname === "/mcp") {
        await mcp(req, res, json);
        return;
      }
      json(404, { error: "not found" });
    } catch (error) {
      json(500, { error: error.message });
    }
  });

  // A client whose ID was typed in by hand (the "manual" flow) is accepted with any redirect URI.
  function manualClient(clientId) {
    return clientId && clientId.startsWith("manual-") ? { redirectUris: [], secret: "manual-secret" } : null;
  }

  function issue(clientId) {
    const accessToken = `at-${b64(crypto.randomBytes(18))}`;
    const refreshToken = `rt-${b64(crypto.randomBytes(18))}`;
    access.set(accessToken, { clientId, expiresAt: Date.now() + accessTtlMs });
    refresh.set(refreshToken, { clientId });
    mock.issued.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.round(accessTtlMs / 1000)),
      refresh_token: refreshToken,
      scope: "items",
      workspace_name: "Mock Workspace",
    };
  }

  function authorized(req) {
    if (open) return true;
    const header = String(req.headers.authorization || "");
    const token = header.replace(/^Bearer\s+/i, "");
    if (staticToken && token === staticToken) return true;
    const entry = access.get(token);
    return Boolean(entry && entry.expiresAt > Date.now());
  }

  async function mcp(req, res, json) {
    if (req.method !== "POST") {
      json(405, { error: "method not allowed" });
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${mock.url}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const message = JSON.parse(await readText(req));
    const reply = (result) => json(200, { jsonrpc: "2.0", id: message.id, result }, { "mcp-session-id": "mock-session" });
    if (message.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === "initialize") {
      reply({ protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-oauth-mcp", version: "1.0.0" } });
      return;
    }
    if (message.method === "tools/list") {
      reply({
        tools: [
          {
            name: "list_items",
            description: "List the items.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: "create_item",
            description: "Create an item.",
            inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          },
        ],
      });
      return;
    }
    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params || {};
      mock.calls.push({ tool: name, args, token: String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") });
      if (name === "list_items") {
        reply({ content: [{ type: "text", text: JSON.stringify(mock.items) }] });
        return;
      }
      if (name === "create_item") {
        const item = { id: mock.items.length + 1, name: String(args.name || "") };
        mock.items.push(item);
        reply({ content: [{ type: "text", text: `created ${item.id}: ${item.name}` }] });
        return;
      }
      json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown tool ${name}` } });
      return;
    }
    json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      mock.url = `http://127.0.0.1:${server.address().port}`;
      mock.mcpUrl = `${mock.url}/mcp`;
      resolve(mock);
    });
  });
}

function readText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
