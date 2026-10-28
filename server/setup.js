// The first-run wizard's API (public/welcome.js): what is set up, the starter agents, running
// OpenCode, linking the notes vault to a remote, and the pairing code that puts a phone in.
import { STARTERS, starterList } from "./starters.js";
import { checkRemote, deployKey, linkRemote } from "./vault/local.js";
import { LANGUAGES, ownerOf } from "./owner.js";
import { normalizeDefaults } from "./state.js";

const httpError = (message, status) => Object.assign(new Error(message), { status });
// OpenCode's free models work with no account, and the list rotates. The wizard offers the one whose
// provider is kindest with your data, from what OpenCode's Zen docs say (opencode.ai/docs/zen, read
// 2026-10-25). Nemotron's are trial only and logged, so they are never offered; an unknown free model
// is offered last, pointing at the docs.
const FREE_POLICIES = [
  [/^opencode\/(glm-5\.3-flash-free|deepseek-v4\.1-flash-free|longcat-[\w.-]*free)$/, "This one's provider keeps no data and does not train on it, per OpenCode's docs."],
  [/^opencode\/beam-free$/, "This one's provider does not train on your data and keeps it 30 days for safety, per OpenCode's docs."],
  [/^opencode\/(big-pickle|mimo-[\w.-]*free|flint-[\w.-]*free)$/, "While it is free, your prompts may be used to improve the model, per OpenCode's docs."],
];
const NEVER_OFFERED = /^opencode\/nemotron/;

export function pickFreeModel(models) {
  const free = models.filter((item) => item.via === "opencode" && item.provider === "opencode" && item.cost === null && !NEVER_OFFERED.test(item.id));
  for (const [pattern, note] of FREE_POLICIES) {
    const found = free.find((item) => pattern.test(item.id));
    if (found) return { via: "opencode", model: found.id, name: found.name, note, private: note === FREE_POLICIES[0][1] };
  }
  const other = free.find((item) => /free/i.test(item.id));
  return other ? { via: "opencode", model: other.id, name: other.name, note: "OpenCode's docs say what this free model's provider does with your prompts.", private: false } : null;
}

export function createSetup({ home, state, saveState, models, managedOpenCode, auth, vault, writer, vaultLocal, addBot, publicUrl, access }) {
  function vaultInfo() {
    if (!vault) return null;
    const status = vault.status();
    const linked = state.settings?.vaultRemote || null;
    return {
      available: status.available,
      notes: status.notes,
      writable: Boolean(writer?.available),
      // Only the vault this server made can be linked here; one set up by hand stays as it is.
      canLink: Boolean(vaultLocal && writer),
      remote: linked?.url || null,
      branch: linked?.branch || null,
      lastError: writer?.status().lastError || null,
    };
  }

  async function modelsInfo() {
    const list = await models.list().catch(() => ({ models: [] }));
    const defaults = state.settings?.defaults || {};
    const free = pickFreeModel(list.models);
    // Signed-in providers other than OpenCode's own free tier.
    const paid = list.models.filter((item) => !(item.provider === "opencode" && item.cost === null)).length;
    return {
      count: list.models.length,
      others: paid,
      defaultModel: defaults.model || "",
      defaultVia: defaults.via || "",
      free,
    };
  }

  async function status() {
    const catalog = await models.catalog().catch(() => null);
    const managed = managedOpenCode.status();
    const oc = catalog?.opencode || { connected: false, source: "none" };
    return {
      needed: Boolean(state.settings?.setup?.needed),
      owner: ownerOf(state),
      languages: LANGUAGES,
      opencode: {
        connected: Boolean(oc.connected),
        source: oc.source,
        managed: { enabled: managed.enabled, installed: managed.installed, running: managed.running, error: managed.error },
        // A plain `npm start` with OpenCode installed can let Ravnir run it.
        canManage: !managed.enabled && managed.installed && oc.source === "none",
      },
      models: await modelsInfo(),
      starters: starterList().map((item) => ({ ...item, exists: state.bots.some((bot) => bot.name === STARTERS.find((s) => s.id === item.id).name) })),
      agents: state.bots.length,
      vault: vaultInfo(),
      access: { mode: access(), publicUrl: publicUrl() },
      signIn: auth.enabled,
    };
  }

  async function startOpenCode() {
    const current = models.opencode();
    if (current && current.source !== "managed") throw httpError("This server already uses another OpenCode. Change it in Settings, Models.", 409);
    if (!managedOpenCode.enabled) {
      state.settings = { ...state.settings, opencode: { managed: true } };
      saveState();
    }
    const result = await managedOpenCode.start();
    if (!result.running) throw httpError(result.error || "OpenCode did not start.", 502);
    return { opencode: (await models.catalog({ fresh: true })).opencode };
  }

  async function createStarters(body) {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string").slice(0, STARTERS.length) : [];
    if (!ids.length) throw httpError("Pick at least one agent, or skip this step.", 400);
    const unknown = ids.find((id) => !STARTERS.some((item) => item.id === id));
    if (unknown) throw httpError(`No starter agent called ${unknown}.`, 400);
    let model = null;
    if (body.model !== undefined && body.model !== null) {
      const via = String(body.model?.via || "");
      const id = String(body.model?.model || "").trim();
      if (!via || !id || id.length > 200 || !/^(opencode|server:[A-Za-z0-9-]{1,40})$/.test(via)) throw httpError("Pick a model from the list.", 400);
      model = { via, model: id };
      models.resolveChoice(model); // throws when that source is not connected
      state.settings = { ...state.settings, defaults: normalizeDefaults({ ...state.settings.defaults, via, model: id }) };
    }
    const created = [];
    const hasMain = state.bots.some((bot) => bot.main);
    for (const starter of STARTERS.filter((item) => ids.includes(item.id))) {
      if (state.bots.some((bot) => bot.name === starter.name)) continue;
      const bot = addBot({
        name: starter.name,
        job: starter.job,
        group: starter.group,
        prompt: starter.prompt,
        main: Boolean(starter.main) && !hasMain,
        pinned: Boolean(starter.pinned),
        pinnedOrder: created.length,
        ...(starter.policy ? { policy: starter.policy } : {}),
        ...(model ? { model } : {}),
      });
      created.push({ id: bot.id, name: bot.name });
    }
    saveState();
    return { created, agents: state.bots.length };
  }

  function key() {
    if (!vaultInfo()?.canLink) throw httpError("This server's vault cannot be linked from here.", 409);
    return { publicKey: deployKey(home).publicKey };
  }

  async function link(body) {
    if (!vaultInfo()?.canLink) throw httpError("This server's vault cannot be linked from here.", 409);
    const remote = checkRemote(body.url);
    if (remote.error) throw httpError(remote.error, 400);
    const ssh = remote.ssh ? deployKey(home) : null;
    const sshCommand = ssh?.sshCommand || "";
    // Agents' writes and syncs wait in the writer's queue while the folder changes branch.
    const result = await writer.exclusive(async () => {
      const out = await linkRemote({ dir: vault.dir, url: remote.url, sshCommand });
      if (out.ok) {
        writer.branch = out.branch;
        writer.sshCommand = sshCommand;
        vault.sshCommand = sshCommand;
      }
      return out;
    });
    if (!result.ok) throw httpError(result.error, 400);
    state.settings = { ...state.settings, vaultRemote: { url: remote.url, branch: result.branch, key: Boolean(ssh), linkedAt: Date.now() } };
    saveState();
    await vault.reindex();
    const synced = await writer.sync().catch((error) => ({ ok: false, error: error.message }));
    return { vault: vaultInfo(), saved: result.saved, pushed: result.pushed, sync: synced };
  }

  function pair() {
    if (!auth.enabled) throw httpError("Sign-in is off on this server, so a phone needs no code. It can only reach this server through the address you set up.", 400);
    const made = auth.createPairCode();
    const base = publicUrl();
    return { code: made.code, expiresAt: made.expiresAt, url: base ? `${base.replace(/\/+$/, "")}/login?pair=1` : "" };
  }

  function finish(body) {
    state.settings = { ...state.settings, setup: { done: true, at: Date.now(), ...(body?.skipped ? { skipped: true } : {}) } };
    saveState();
    return { ok: true };
  }

  // Same shape as plugins.api: { status, body }.
  async function api({ method, pathname, body = {} }) {
    if (method === "GET" && pathname === "/api/setup") return { body: await status() };
    if (method === "POST" && pathname === "/api/setup/opencode") return { body: await startOpenCode() };
    if (method === "POST" && pathname === "/api/setup/starters") return { status: 201, body: await createStarters(body) };
    if (method === "POST" && pathname === "/api/setup/vault/key") return { body: key() };
    if (method === "POST" && pathname === "/api/setup/vault") return { body: await link(body) };
    if (method === "POST" && pathname === "/api/setup/done") return { body: finish(body) };
    if (method === "POST" && pathname === "/api/pair") return { body: pair() };
    throw httpError("Not found.", 404);
  }

  return { api, status };
}
