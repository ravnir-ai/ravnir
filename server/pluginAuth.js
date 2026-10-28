import crypto from "node:crypto";

// The OAuth client side of MCP authorization (the 2025 spec): find the
// authorization server from the MCP server's own metadata, register Ravnir as a
// client when the server allows it, sign in with PKCE, and keep the tokens fresh.
//
//   RFC 9728  protected resource metadata (where the MCP server says who signs you in)
//   RFC 8414  authorization server metadata (also the OpenID configuration)
//   RFC 7591  dynamic client registration
//   RFC 7636  PKCE (S256)
//   RFC 8707  resource indicators (the token is for this MCP server only)
//
// Nothing here stores anything. plugins.js keeps the results in the encrypted vault.

const CLIENT_NAME = "Ravnir";
const FETCH_MS = 15_000;
export const FLOW_MS = 10 * 60_000;

export class AuthError extends Error {
  constructor(message, { status = 400, expired = false } = {}) {
    super(message);
    this.status = status;
    // The refresh token no longer works: the user has to sign in again.
    this.expired = expired;
  }
}

export function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function pkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function isLoopback(url) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
}

// Authorization endpoints carry codes and tokens, so they must be https. Loopback may use http (local testing).
function secureUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new AuthError(`The ${label} is not a URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new AuthError(`The ${label} must use https.`);
  }
  return url.toString();
}

async function getJson(url, fetchImpl, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: options.method || "GET",
      headers: { accept: "application/json", ...(options.headers || {}) },
      body: options.body,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (error) {
    throw new AuthError(`Could not reach ${new URL(url).host}: ${error.cause?.code || error.message}`, { status: 502 });
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text, headers: response.headers };
}

// Parses `Bearer resource_metadata="https://...", scope="a b"` from a WWW-Authenticate header.
export function parseChallenge(header) {
  const out = {};
  const text = String(header || "");
  for (const match of text.matchAll(/([a-z_]+)=(?:"([^"]*)"|([^\s,]+))/gi)) out[match[1].toLowerCase()] = match[2] ?? match[3];
  return out;
}

// What the MCP server says about its sign-in. A 401 on an unauthenticated request
// names the metadata; servers that do not still publish well-known documents.
async function probeResource(resourceUrl, fetchImpl) {
  const found = { resourceMetadataUrl: "", scope: "" };
  try {
    const response = await fetchImpl(resourceUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "1.0.0" } } }),
      signal: AbortSignal.timeout(FETCH_MS),
    });
    await response.arrayBuffer().catch(() => {});
    const challenge = parseChallenge(response.headers.get("www-authenticate"));
    found.resourceMetadataUrl = challenge.resource_metadata || "";
    found.scope = challenge.scope || "";
  } catch {
    // The well-known documents below may still answer.
  }
  return found;
}

function wellKnown(origin, name, pathname) {
  const suffix = pathname && pathname !== "/" ? pathname.replace(/\/+$/, "") : "";
  return `${origin}/.well-known/${name}${suffix}`;
}

export async function discoverAuthorization(resourceUrl, { fetchImpl = fetch, overrides = null } = {}) {
  const resource = new URL(resourceUrl);
  const origin = resource.origin;
  const result = {
    resource: resource.toString(),
    issuer: "",
    authorizationEndpoint: "",
    tokenEndpoint: "",
    registrationEndpoint: "",
    revocationEndpoint: "",
    methods: [],
    scope: "",
    authParams: {},
  };
  // Catalog entries (and the Google card) can name the endpoints outright.
  if (overrides?.authorizationUrl && overrides?.tokenUrl) {
    result.authorizationEndpoint = secureUrl(overrides.authorizationUrl, "authorization URL");
    result.tokenEndpoint = secureUrl(overrides.tokenUrl, "token URL");
    result.registrationEndpoint = overrides.registrationUrl ? secureUrl(overrides.registrationUrl, "registration URL") : "";
    result.revocationEndpoint = overrides.revocationUrl ? secureUrl(overrides.revocationUrl, "revocation URL") : "";
    result.issuer = new URL(result.tokenEndpoint).origin;
    result.scope = Array.isArray(overrides.scopes) ? overrides.scopes.join(" ") : String(overrides.scopes || "");
    result.authParams = overrides.authParams && typeof overrides.authParams === "object" ? { ...overrides.authParams } : {};
    return result;
  }

  const probe = await probeResource(resource.toString(), fetchImpl);
  result.scope = probe.scope;

  // 1. Protected resource metadata.
  const prmUrls = [
    probe.resourceMetadataUrl,
    wellKnown(origin, "oauth-protected-resource", resource.pathname),
    wellKnown(origin, "oauth-protected-resource", ""),
  ].filter(Boolean);
  let prm = null;
  for (const url of [...new Set(prmUrls)]) {
    const reply = await getJson(url, fetchImpl).catch(() => null);
    if (reply?.ok && reply.json && typeof reply.json === "object") {
      prm = reply.json;
      break;
    }
  }
  if (prm?.resource && typeof prm.resource === "string") result.resource = prm.resource;
  if (!result.scope && Array.isArray(prm?.scopes_supported) && prm.scopes_supported.length) result.scope = prm.scopes_supported.join(" ");
  const issuer = Array.isArray(prm?.authorization_servers) && prm.authorization_servers[0] ? String(prm.authorization_servers[0]) : origin;
  result.issuer = issuer;

  // 2. Authorization server metadata: RFC 8414 first, then OpenID Connect discovery.
  const as = new URL(issuer);
  const metaUrls = [
    wellKnown(as.origin, "oauth-authorization-server", as.pathname),
    wellKnown(as.origin, "openid-configuration", as.pathname),
    `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  ];
  let meta = null;
  for (const url of [...new Set(metaUrls)]) {
    const reply = await getJson(url, fetchImpl).catch(() => null);
    if (reply?.ok && reply.json?.authorization_endpoint && reply.json?.token_endpoint) {
      meta = reply.json;
      break;
    }
  }
  if (meta) {
    result.authorizationEndpoint = secureUrl(meta.authorization_endpoint, "authorization URL");
    result.tokenEndpoint = secureUrl(meta.token_endpoint, "token URL");
    result.registrationEndpoint = meta.registration_endpoint ? secureUrl(meta.registration_endpoint, "registration URL") : "";
    result.revocationEndpoint = meta.revocation_endpoint ? secureUrl(meta.revocation_endpoint, "revocation URL") : "";
    result.methods = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported.map(String) : [];
    if (typeof meta.issuer === "string") result.issuer = meta.issuer;
  } else if (!prm) {
    // The 2025-03-26 spec: a server with no metadata uses these paths on its own origin.
    result.authorizationEndpoint = secureUrl(`${origin}/authorize`, "authorization URL");
    result.tokenEndpoint = secureUrl(`${origin}/token`, "token URL");
    result.registrationEndpoint = secureUrl(`${origin}/register`, "registration URL");
  } else {
    throw new AuthError("This service did not publish how to sign in to it.");
  }
  return result;
}

// RFC 7591. Public client first ("none"), because Ravnir has no way to keep a secret from the browser anyway.
export async function registerClient(discovery, redirectUri, { fetchImpl = fetch } = {}) {
  if (!discovery.registrationEndpoint) {
    throw new AuthError("This service does not let Ravnir register itself. Ask for a client ID and secret in its developer settings.");
  }
  const supported = discovery.methods;
  const method = !supported.length || supported.includes("none") ? "none" : supported.includes("client_secret_post") ? "client_secret_post" : supported[0];
  const reply = await getJson(discovery.registrationEndpoint, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
      application_type: "web",
    }),
  });
  if (!reply.ok || !reply.json?.client_id) {
    const detail = reply.json?.error_description || reply.json?.error || reply.text.slice(0, 160) || `status ${reply.status}`;
    throw new AuthError(`The service refused the registration: ${detail}`, { status: 502 });
  }
  return {
    clientId: String(reply.json.client_id),
    clientSecret: reply.json.client_secret ? String(reply.json.client_secret) : "",
    method: String(reply.json.token_endpoint_auth_method || method),
    redirectUri,
  };
}

export function authorizeUrl(discovery, client, { state, challenge, scope = "" }) {
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (discovery.resource) url.searchParams.set("resource", discovery.resource);
  const wanted = scope || discovery.scope;
  if (wanted) url.searchParams.set("scope", wanted);
  for (const [key, value] of Object.entries(discovery.authParams || {})) url.searchParams.set(key, String(value));
  return url.toString();
}

function clientAuth(client, form, headers) {
  if (!client.clientId) return;
  if (client.method === "client_secret_basic" && client.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
    return;
  }
  form.set("client_id", client.clientId);
  if (client.clientSecret && client.method !== "none") form.set("client_secret", client.clientSecret);
}

async function tokenRequest(discovery, client, form, { fetchImpl, refresh = false }) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  clientAuth(client, form, headers);
  const reply = await getJson(discovery.tokenEndpoint, fetchImpl, { method: "POST", headers, body: form.toString() });
  if (!reply.ok || !reply.json?.access_token) {
    const code = reply.json?.error || "";
    const detail = reply.json?.error_description || code || reply.text.slice(0, 160) || `status ${reply.status}`;
    const dead = refresh && (code === "invalid_grant" || code === "invalid_token" || reply.status === 401);
    throw new AuthError(`The service did not give a token: ${detail}`, { status: dead ? 401 : 502, expired: dead });
  }
  return reply.json;
}

export async function exchangeCode(discovery, client, { code, verifier }, { fetchImpl = fetch } = {}) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirectUri,
    code_verifier: verifier,
  });
  if (discovery.resource) form.set("resource", discovery.resource);
  return tokens(await tokenRequest(discovery, client, form, { fetchImpl }));
}

export async function refreshTokens(discovery, client, refreshToken, { fetchImpl = fetch } = {}) {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (discovery.resource) form.set("resource", discovery.resource);
  const out = tokens(await tokenRequest(discovery, client, form, { fetchImpl, refresh: true }));
  // A server that does not rotate refresh tokens leaves the old one valid.
  if (!out.refreshToken) out.refreshToken = refreshToken;
  return out;
}

export async function revokeToken(discovery, client, token, { fetchImpl = fetch } = {}) {
  if (!discovery.revocationEndpoint || !token) return false;
  const form = new URLSearchParams({ token });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  clientAuth(client, form, headers);
  const reply = await getJson(discovery.revocationEndpoint, fetchImpl, { method: "POST", headers, body: form.toString() }).catch(() => null);
  return Boolean(reply?.ok);
}

function tokens(json) {
  const seconds = Number(json.expires_in);
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : "",
    // 0 means the service gave no lifetime: use the token until it is refused.
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : 0,
    scope: typeof json.scope === "string" ? json.scope : "",
    account: accountLabel(json),
  };
}

// Some services say whose account this is in the token response. Never a secret, only a label.
export function accountLabel(json) {
  const pick = (...values) => values.map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) || "";
  const direct = pick(
    json.workspace_name,
    json.team?.name,
    json.workspace?.name,
    json.organization?.name,
    json.organization_name,
    json.account_name,
    json.owner?.workspace_name,
    json.owner?.user?.person?.email,
    json.user?.email,
    json.email,
  );
  if (direct) return direct.slice(0, 120);
  const idToken = typeof json.id_token === "string" ? json.id_token.split(".")[1] : "";
  if (idToken) {
    try {
      const claims = JSON.parse(Buffer.from(idToken, "base64url").toString("utf8"));
      return pick(claims.email, claims.name).slice(0, 120);
    } catch {
      return "";
    }
  }
  return "";
}

// Flows that were started and not finished. In memory only: a restart cancels them, and the user presses Connect again.
export class PendingFlows {
  constructor({ ttlMs = FLOW_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.flows = new Map();
  }

  start(flow) {
    this.#prune();
    const state = base64url(crypto.randomBytes(24));
    this.flows.set(state, { ...flow, createdAt: this.now(), expiresAt: this.now() + this.ttlMs });
    return state;
  }

  take(state) {
    this.#prune();
    const flow = this.flows.get(String(state || ""));
    if (flow) this.flows.delete(String(state));
    return flow || null;
  }

  pendingIds() {
    this.#prune();
    return [...new Set([...this.flows.values()].map((flow) => flow.pluginId))];
  }

  cancel(pluginId) {
    for (const [state, flow] of this.flows) if (flow.pluginId === pluginId) this.flows.delete(state);
  }

  #prune() {
    const now = this.now();
    for (const [state, flow] of this.flows) if (flow.expiresAt <= now) this.flows.delete(state);
  }
}
