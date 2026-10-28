import "./env.js";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApprovalCenter } from "./approvals.js";
import { createAuth, listenAllowed } from "./auth.js";
import { envConfig } from "./appConfig.js";
import { applyImport, exportPrompt, parseExport, planImport } from "./importer.js";
import { Ledger, shiftDays, startOfDay } from "./ledger.js";
import { NotificationCenter } from "./notifications.js";
import { StatusFeeds } from "./status/index.js";
import { Vault } from "./vault/index.js";
import { VaultWriter } from "./vault/writer.js";
import { loadEmbedder } from "./vault/embed.js";
import { currentBranch, deployKey, ensureLocalVault } from "./vault/local.js";
import { guardTool, normalizeLimits, normalizePolicy, openCodePermission } from "./policy.js";
import { ProposalStore } from "./proposals.js";
import { decorateSuggestion, pluginBlocker, settleSuggestions } from "./recommend.js";
import { AskBook, publicAsk } from "./asks.js";
import { PushService } from "./push.js";
import { applySpec, checkSpec, dismissSpec, linkSpec, readAppliedSpec, specNeedsAttention, specView, unlinkSpec } from "./spec.js";
import { aiMemoryConnector, aiMemoryEnv, detectAiMemory, ensureMemoryMarker, memoryStatus } from "./aiMemory.js";
import { BoxManager, DesktopRouter } from "./box.js";
import { BrowserManager } from "./browser.js";
import { createGroup, deleteGroup, deliverMention, renameGroup } from "./collaboration.js";
import { archivePath } from "./compaction.js";
import { DesktopManager } from "./desktop.js";
import { builtinToolsFor, callBuiltinTool, commandEnv, listTree, readWorkspaceFile, runBotCommand, writeWorkspaceFile } from "./computer.js";
import { namedDiff } from "./diff.js";
import { discoverServers } from "./discovery.js";
import { createModels, sameUrl } from "./models.js";
import { backupEntry, MAX_FALLBACKS } from "./fallback.js";
import { ManagedOpenCode } from "./opencodeManaged.js";
import { createSetup } from "./setup.js";
import { formatReport, runDoctor } from "./doctor.js";
import { ArtifactStore, rawHeaders } from "./artifacts.js";
import { EventLog } from "./events.js";
import { consumeOneShot, createJob, describeSchedule, nextCron, previewSchedule, Scheduler, updateJob } from "./jobs.js";
import { handleBuiltinMcp } from "./mcpBuiltin.js";
import { parseMentions } from "./mentions.js";
import { isPluginConnector, McpManager, openCodeMcpConfig } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import { OnePassword } from "./onepassword.js";
import { jevSpend, jevStatus, setJevHome } from "./jev.js";
import { LiveManager, novncFile } from "./live.js";
import { buildSystemPrompt, teammatesFor } from "./prompts.js";
import { localHostName, localProjects } from "./localProjects.js";
import { describeSkill, discover as discoverSkills, indexForBot, skillRoom } from "./skills.js";
import { CardManager } from "./cards.js";
import { listAgents as openCodeAgents, listModels as openCodeModels, reloadInstance } from "./providers/opencode.js";
import { listModels as openAIModels } from "./providers/openai.js";
import { SecretStore } from "./secrets.js";
import { audioFileName, baseType, readAudio, speak, transcribe, voiceConfig } from "./voice.js";
import { ElevenLabs } from "./elevenlabs.js";
import { voiceReply } from "./voiceReply.js";
import { quickConfig } from "./quick.js";
import { TerminalManager, upgradeAllowed } from "./terminal.js";
import {
  appendConversation,
  botHome,
  createBot,
  ensureBotHome,
  ensureGroups,
  loadState,
  NOTIFY_LEVELS,
  normalizeAvatar,
  normalizeBotStatus,
  normalizeBox,
  normalizeDefaults,
  normalizeNotifySettings,
  normalizeVaultNote,
  normalizeVaultProjects,
  publicBot,
  publicBotSummary,
  publicConnector,
  publicGroup,
  publicJob,
  normalizeSkills,
  readConversation,
  readDiffs,
  saveState,
  touchBot,
  workspacePath,
  writeConversation,
  writeDiffs,
} from "./state.js";
import { TurnEngine } from "./turn.js";
import { writeFile as writeWorkspaceDiff } from "./workspace.js";
import { WebSocketServer } from "ws";
import { MAC_PATH, MacNode } from "./macNode.js";
import { MacTunnel, TUNNEL_PATH } from "./macTunnel.js";
import { BrowserNetwork, HomeSites, normalizeBrowserNetwork, parseProxyUrl, siteOf } from "./netRoute.js";
import { LANGUAGES, normalizeOwner, ownerLabel, ownerOf, ownerPossessive } from "./owner.js";
import { LAYOUT_CHOICES, profileNote, resolveLayout } from "./vault/layout.js";
import { BackupError, checkPassphrase, exportArchive, restoreArchive, supervised } from "./backup.js";
import { hasHistory, validNotePath, vaultAuthors, vaultCommit, vaultLog } from "./vault/history.js";
import { buildProof } from "./proof.js";
import { chooserFor } from "./chooser.js";
import { MAX_ATTACHMENTS, findUpload, publicAttachment, saveUpload, serveUpload } from "./uploads.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();
const VERSION = "1.0.0";
// The app polls every 1.4 s while open; this much silence means the window is closed or in the background.
const WATCH_MS = 6_000;
// Reachable without signing in: icons and the manifest for home-screen installs, the
// service worker, the sign-in page and its endpoints. The bots' MCP endpoint has its
// own bearer token and is matched separately.
const PUBLIC_PATHS = new Set(["/manifest.webmanifest", "/logo.png", "/favicon.png", "/icon-192.png", "/icon-512.png", "/og.jpg", "/sw.js", "/login", "/api/login", "/api/logout"]);
const MCP_PATH = /^\/api\/bots\/[^/]+\/mcp$/;
const TERMINAL_PATH = /^\/api\/bots\/([^/]+)\/terminal\/ws$/;
// The live view (Take control): VNC bytes over a WebSocket, for noVNC. server/live.js.
const LIVE_PATH = /^\/api\/bots\/([^/]+)\/live$/;
const TERM_BRIDGE = path.join(root, "box", "term-bridge.py");
// The terminal's browser side, served from node_modules (no bundler, no CDN).
const VENDOR = new Map([
  ["/vendor/xterm.js", ["@xterm/xterm/lib/xterm.js", "text/javascript; charset=utf-8"]],
  ["/vendor/xterm.css", ["@xterm/xterm/css/xterm.css", "text/css; charset=utf-8"]],
  ["/vendor/addon-fit.js", ["@xterm/addon-fit/lib/addon-fit.js", "text/javascript; charset=utf-8"]],
  // Diagrams in chat (```mermaid), loaded only when a reply has one.
  ["/vendor/mermaid.js", ["mermaid/dist/mermaid.min.js", "text/javascript; charset=utf-8"]],
  // The phone step of the first-run wizard draws its QR code with this (classic script, global qrcode).
  // PDFs drawn inside the app (public/pdfview.js), loaded only when one is opened.
  ["/vendor/pdf.mjs", ["pdfjs-dist/build/pdf.min.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/pdf.worker.mjs", ["pdfjs-dist/build/pdf.worker.min.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/qrcode.js", ["qrcode-generator/dist/qrcode.js", "text/javascript; charset=utf-8"]],
]);
const STATIC_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
const FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/avatar.js", ["avatar.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/setup", ["setup.html", "text/html; charset=utf-8"]],
  ["/setup.html", ["setup.html", "text/html; charset=utf-8"]],
  ["/logo.png", ["logo.png", "image/png"]],
  ["/favicon.png", ["favicon.png", "image/png"]],
  ["/icon-192.png", ["icon-192.png", "image/png"]],
  ["/icon-512.png", ["icon-512.png", "image/png"]],
  ["/og.jpg", ["og.jpg", "image/jpeg"]],
]);

// Where the shared notes vault lives and how it syncs. RAVNIR_VAULT_DIR points at an existing clone
// (the hub); RAVNIR_VAULT=local keeps one under the data folder, made on first start, which the
// first-run wizard can later link to a remote (settings.vaultRemote, with this server's own key).
function vaultConfig(home, state, env = process.env) {
  const local = env.RAVNIR_VAULT === "local";
  const dir = env.RAVNIR_VAULT_DIR || (local ? path.join(home, "vault") : "");
  if (!dir) return null;
  const linked = local && !env.RAVNIR_VAULT_REMOTE ? state.settings?.vaultRemote : null;
  return {
    dir,
    local,
    remote: env.RAVNIR_VAULT_REMOTE || "",
    sshCommand: env.RAVNIR_VAULT_SSH || (linked?.key ? deployKey(home, { create: false })?.sshCommand || "" : ""),
    write: env.RAVNIR_VAULT_WRITE === "on" || local,
    branch: env.RAVNIR_VAULT_BRANCH || linked?.branch || (local ? currentBranch(dir) || "main" : "master"),
  };
}

// The shared notes vault: an Obsidian folder kept in git. Off unless configured (vaultConfig above).
function openVault(config) {
  if (!config) return null;
  if (config.local) ensureLocalVault(config.dir);
  const vault = new Vault({
    dir: config.dir,
    remote: config.remote,
    sshCommand: config.sshCommand,
    pullMs: config.write ? 0 : Number(process.env.RAVNIR_VAULT_PULL_MS ?? 120_000),
  });
  vault.opened = loadEmbedder()
    .then(({ embedder, reason }) => {
      if (embedder) vault.setEmbedder(embedder);
      else if (process.env.RAVNIR_VAULT_EMBED_DIR) console.warn(`Vault embeddings off: ${reason}`);
      return vault.open();
    })
    .catch((error) => console.error(`Vault failed to open: ${error.message}`));
  return vault;
}

// pushSender and watchMs exist for tests: no real push service, no 6 s wait.
// pluginCatalog and pluginRuntime exist for tests: a small catalog file and a fake container runtime.
// liveDrivers exists for tests: no X server.
// opencodeBin exists for tests: a stand-in for the opencode binary the managed server runs.
export function createApp({ home = path.join(root, "data"), projectRoot = root, pushSender, watchMs = WATCH_MS, pluginCatalog, pluginRuntime, liveDrivers = null, opencodeBin = "", spawnCard = null } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const secrets = new SecretStore(home);
  const state = loadState({ home, secrets, projectRoot });
  // The OpenCode Ravnir runs itself: always in the server image (RAVNIR_OPENCODE=managed), or once the
  // owner turns it on in the first-run wizard. Connecting another OpenCode in Settings turns it off.
  const managedOpenCode = new ManagedOpenCode({
    home,
    secrets,
    bin: opencodeBin,
    wanted: () => process.env.RAVNIR_OPENCODE === "managed" || (state.settings?.opencode?.managed === true && !state.settings.opencode.baseUrl),
  });
  // Model providers (server/models.js): the server's OpenCode connection and the provider sign-ins.
  // After a sign-in, idle OpenCode agents reload so they see the new provider without a restart.
  const models = createModels({
    state,
    secrets,
    saveState: () => saveState(home, state),
    onAuthChange: () => reloadOpenCodeTools().catch(() => {}),
    managed: managedOpenCode,
  });
  managedOpenCode.start().catch(() => {});
  const detected = detectAiMemory();
  // RAVNIR_AI_MEMORY=off means off everywhere, so tests never write to the real store.
  const aiMemory = process.env.RAVNIR_AI_MEMORY === "off" ? { ...detected, available: false } : detected;
  const vaultSetup = vaultConfig(home, state);
  const vault = openVault(vaultSetup);
  // Live figures for project notes (data/status-feeds.json), read from their real sources, never from memory.
  const feeds = vault ? new StatusFeeds({ vault, feeds: StatusFeeds.load(process.env.RAVNIR_STATUS_FEEDS || path.join(home, "status-feeds.json")) }) : null;
  const auth = createAuth({ user: process.env.RAVNIR_USER, password: process.env.RAVNIR_PASSWORD, home });
  const push = new PushService({ home, sender: pushSender });
  const notifications = new NotificationCenter({
    home,
    push,
    getSettings: () => normalizeNotifySettings(state.settings?.notify),
    getBot: (id) => state.bots.find((item) => item.id === id) || null,
  });
  const proposals = new ProposalStore({ home });
  // Questions agents put to the user (ask_user), with their answers.
  const asks = new AskBook({ home });
  // The owner's Mac: the runner on it dials in with RAVNIR_MAC_TOKEN (bin/mac-node.mjs).
  const mac = new MacNode({ token: process.env.RAVNIR_MAC_TOKEN, notifications, owner: () => ownerOf(state) });
  // The Mac's second socket: agent browsers open sites that refuse this server's network from there.
  const macTunnel = new MacTunnel({ token: process.env.RAVNIR_MAC_TOKEN });
  // Vault writes (RAVNIR_VAULT_WRITE=on): per-bot commits, approvals for Rules.md and Projects/, rebase sync with GitHub.
  const writer = vault && vaultSetup.write
    ? new VaultWriter({
      vault,
      dir: vault.dir,
      sshCommand: vaultSetup.sshCommand,
      branch: vaultSetup.branch,
      syncMs: Number(process.env.RAVNIR_VAULT_SYNC_MS ?? 120_000),
      proposals,
      notify: (note) => notifications.notify({ url: "/?view=today", ...note }),
      // Settings: the owner's name for their profile note, and the folder layout ("auto" keeps what the vault has).
      layout: () => state.settings?.vault?.layout || "auto",
      owner: () => ownerOf(state),
      // Each agent commit names its turn, so the Memory page links back to it.
      turnOf: (bot) => engine.active.get(bot.id)?.turnId || "",
    })
    : null;
  vault?.opened.then(() => {
    feeds.start();
    writer?.start();
    reloadOpenCodeTools().catch(() => {});
  }).catch(() => {});
  // Once a day, the live figures are also written into the note itself, so Obsidian shows them.
  const statusDayFile = path.join(home, "vault-status-day.json");
  const statusTimer = writer ? setInterval(() => writeDailyStatus().catch(() => {}), 30 * 60_000) : null;
  statusTimer?.unref?.();
  // After a deploy the vault tools may differ from what OpenCode cached; idle OpenCode bots reload them.
  async function reloadOpenCodeBot(bot) {
    if (bot.model?.provider !== "opencode" || engine.status(bot.id).busy) return { ok: false, skipped: true };
    return reloadInstance({ ...bot, model: { ...bot.model, apiKey: models.keyFor(bot) } }, workspacePath(home, bot)).catch((error) => ({ ok: false, error: error.message }));
  }
  async function reloadOpenCodeTools(only = () => true) {
    let reloaded = 0;
    for (const bot of state.bots.filter((item) => item.model?.provider === "opencode" && only(item))) {
      const result = await reloadOpenCodeBot(bot);
      if (result.skipped) continue;
      if (!result.ok) console.warn(`OpenCode tools not reloaded for ${bot.name}: ${result.error}`);
      else reloaded += 1;
    }
    console.log(`OpenCode tools reloaded for ${reloaded} bots`);
  }
  function lastStatusDay() {
    try {
      return JSON.parse(fs.readFileSync(statusDayFile, "utf8")).day;
    } catch {
      return "";
    }
  }
  async function writeDailyStatus() {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.TZ || "Europe/Madrid" }).format(new Date());
    if (!writer?.available || new Date().getHours() < 9 || lastStatusDay() === today) return;
    for (const feed of feeds.status().filter((item) => item.ok)) {
      const text = vault.live(feed.note);
      if (text) await writer.writeStatus(feed.note, text);
    }
    fs.writeFileSync(statusDayFile, JSON.stringify({ day: today }));
  }
  // The owner's profile note, also on a read-only vault, so every agent sees what was remembered.
  function ownerProfilePath() {
    if (writer?.available) return writer.profilePath();
    if (!vault?.available) return "";
    const owner = ownerOf(state);
    return profileNote(resolveLayout(state.settings?.vault?.layout || "auto", vault.dir, owner.language), vault.dir, owner.name);
  }
  // Obsidian opens a note by vault name; the folder's name unless the owner set another in Memory.
  function obsidianName() {
    return String(state.settings?.obsidian || "").trim() || (vault?.available ? path.basename(vault.dir) : "");
  }
  function obsidianLink(notePath) {
    const name = obsidianName();
    return name ? `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(String(notePath).replace(/\.md$/, ""))}` : "";
  }
  // A log entry plus the agent that wrote it and the turn, when the commit names one.
  function memoryEntry(commit) {
    const bot = state.bots.find((item) => item.name === commit.author) || null;
    const turn = commit.turnId ? ledger.get(commit.turnId) : null;
    return {
      hash: commit.hash,
      short: commit.short,
      author: commit.author,
      at: commit.at,
      subject: commit.subject,
      summary: commit.summary,
      files: commit.files,
      merge: commit.merge,
      root: commit.root,
      botId: bot?.id || turn?.botId || "",
      turnId: commit.turnId,
      turn: turn ? { botId: turn.botId, at: turn.at, source: turn.source, prompt: turn.prompt } : null,
      proposalId: commit.proposalId,
      reverts: commit.reverts,
      obsidian: commit.files.length === 1 && commit.files[0].endsWith(".md") ? obsidianLink(commit.files[0]) : "",
    };
  }
  const notifiedApprovals = new Set();
  const eventLog = new EventLog({ home });
  // A bot with its own computer (RAVNIR_BOX, server/box.js) gets its shell,
  // desktop and browser in its container; every other bot keeps the host ones.
  const box = new BoxManager({ home });
  const desktop = new DesktopRouter({ host: new DesktopManager(), box });
  // Where each agent's browser opens sites from (server/netRoute.js): this server,
  // the Mac for sites that block it, the Mac for everything, or the owner's proxy.
  const network = new BrowserNetwork({
    tunnel: macTunnel,
    homeSites: new HomeSites(home),
    routeOf: (bot) => normalizeBrowserNetwork(bot.browser).route,
    customProxy: (bot) => {
      try {
        return parseProxyUrl(secrets.get(`bot:${bot.id}:browserProxy`, ""));
      } catch {
        return null;
      }
    },
    macName: () => `${ownerPossessive(ownerOf(state))} Mac`,
  });
  const browser = new BrowserManager({ home, desktop, box, network });
  const terminals = new TerminalManager({
    spawnShell: async (bot, size) => {
      // A plugin's login (GH_TOKEN for GitHub) is in the shell, so the user can run gh and git too.
      const login = plugins.shellEnvFor(bot);
      if (box.uses(bot)) return { child: await box.shell(bot, { ...size, env: login }), label: `Root shell on ${bot.name}'s own computer` };
      const workspace = workspacePath(home, bot);
      const env = { ...commandEnv(workspace, { home: botHome(home, bot), env: { ...desktop.envFor(bot), ...login } }), TERM: "xterm-256color", COLORTERM: "truecolor" };
      const shell = process.env.SHELL || (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
      const child = spawn("python3", ["-I", TERM_BRIDGE, String(size.cols), String(size.rows), "--", shell, "-l"], {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { child, label: `Shell on this server as ${os.userInfo().username}, in ${bot.name}'s workspace` };
    },
    onStart: (bot) => appendActivity(bot, "Opened the terminal"),
  });
  const elevenLabs = new ElevenLabs({ secrets });
  const onePassword = new OnePassword({ tokenProvider: () => secrets.get("server:onepasswordToken", "") });
  setJevHome(home);
  let appUrl = process.env.RAVNIR_PUBLIC_URL || "http://127.0.0.1:3847";
  // The port this server listens on, known once it does. The OpenCode Ravnir runs shares its
  // loopback, so its agents reach their MCP endpoint there even when appUrl is a public address.
  let listenPort = Number(process.env.RAVNIR_PORT) || 3847;
  const mcpBase = () => (models.opencode()?.source === "managed" ? `http://127.0.0.1:${listenPort}` : appUrl);
  // A plugin's credentials come from its account-level connection (server/plugins.js), always fresh.
  // A connector's own variables and headers. The managed ai-memory bridge no longer inherits the
  // server's environment (or OpenCode's), so it is told where the store is.
  const connectorOwnSecret = (bot, connector) => (connector.managed === "ai-memory"
    ? { env: aiMemoryEnv(aiMemory) }
    : secrets.get(`connector:${bot.id}:${connector.id}`, {}));
  const mcp = new McpManager({
    secretFor: (bot, connector, options) => (isPluginConnector(connector)
      ? plugins.secretForConnector(connector, options)
      : connectorOwnSecret(bot, connector)),
    cwdFor: (bot) => workspacePath(home, bot),
    onChange: () => saveState(home, state),
    guard: (bot, connector, tool, args) => plugins.guard(bot, connector, tool, args),
  });
  const plugins = new PluginManager({
    home,
    state,
    secrets,
    mcp,
    catalogFile: pluginCatalog || process.env.RAVNIR_PLUGIN_CATALOG || path.join(projectRoot, "public", "plugins", "catalog.json"),
    runtime: pluginRuntime,
    saveState: () => saveState(home, state),
    gateFor: (bot) => ({
      approvals: engine.approvalGate(bot),
      signal: engine.active.get(bot.id)?.abort.signal,
      meta: engine.approvalMeta(bot.id),
      onPolicyChange: (changed) => {
        saveState(home, state);
        syncOpenCodeConfig(changed);
      },
    }),
    syncBot: (bot) => syncOpenCodeConfig(bot),
    reloadBot: async (bot) => Boolean((await reloadOpenCodeBot(bot)).ok),
    notify: ({ id, name }) => notifications.notify({
      kind: "failure",
      title: `${name} needs you to sign in again`,
      body: "Open Plugins and press Reconnect.",
      url: "/?view=plugins",
      priority: "high",
      tag: `plugin-${id}`,
    }).catch(() => {}),
  });

  // Open suggestions, newest first. A skill or plugin suggestion closes on its own once the agent has
  // what it asked for, and carries what its card shows (the skill, the plugin and whether it is connected).
  const openProposals = () => {
    settleSuggestions({ proposals, state, plugins });
    return proposals.list({ status: "open" }).map((item) => decorateSuggestion(item, { plugins }));
  };
  const suggestionsFor = (bot) => {
    settleSuggestions({ proposals, state, plugins });
    const since = Date.now() - 30 * 86_400_000;
    return proposals.list({})
      .filter((item) => item.botId === bot.id && (item.kind === "skill" || item.kind === "plugin") && item.createdAt >= since)
      .map((item) => decorateSuggestion(item, { plugins }));
  };
  const ledger = new Ledger({ home });
  const cards = new CardManager({
    home,
    projectRoot,
    connectionFor: (bot) => ({ key: models.keyFor(bot) }),
    notify: (note) => notifications.notify(note),
    spawnCard,
  });
  const approvals = new ApprovalCenter({
    home,
    onChange: (record) => {
      const bot = state.bots.find((item) => item.id === record.botId);
      if (!bot) return;
      if (record.status === "pending") {
        eventLog.append(bot, { type: "permission", requestID: record.id, title: record.title, detail: record.detail, kind: record.kind, rule: record.rule || "", onceOnly: Boolean(record.onceOnly), data: record.data || null, expiresAt: record.expiresAt });
        notifyApproval(bot, record);
      } else {
        eventLog.append(bot, { type: "permission.resolved", requestID: record.id, status: record.status });
        settleApprovalNotice(record);
      }
    },
  });
  // Take control: the user's live view of a bot's screen and the "Sign in yourself" hand-over.
  const live = new LiveManager({ home, browser, desktop, box, approvals, drivers: liveDrivers });
  // Bot id -> last poll from a focused app window. A reply nobody is looking at goes to the phone.
  const watching = new Map();
  const artifacts = new ArtifactStore(home);
  const engine = new TurnEngine({
    home,
    state,
    profilePath: ownerProfilePath,
    modelKey: (bot) => models.keyFor(bot),
    artifacts,
    saveState: () => saveState(home, state),
    secrets,
    eventLog,
    browser,
    mcp,
    appUrl,
    aiMemory,
    provisionBot,
    approvals,
    ledger,
    passwordFor,
    notifications,
    proposals,
    isWatching: (botId) => Date.now() - (watching.get(botId) || 0) < watchMs,
    live,
    vault,
    vaultWriter: writer,
    plugins,
    mac,
    asks,
    onPolicyChange: (bot) => {
      saveState(home, state);
      syncOpenCodeConfig(bot);
    },
    onActivity: () => saveState(home, state),
  });
  // The first-run wizard (server/setup.js). RAVNIR_ACCESS and RAVNIR_PUBLIC_URL come from install.sh.
  const setup = createSetup({
    home,
    state,
    saveState: () => saveState(home, state),
    models,
    managedOpenCode,
    auth,
    vault,
    writer,
    vaultLocal: Boolean(vaultSetup?.local),
    addBot,
    publicUrl: () => process.env.RAVNIR_PUBLIC_URL || "",
    access: () => process.env.RAVNIR_ACCESS || "",
  });
  const scheduler = new Scheduler({
    getState: () => state,
    save: () => saveState(home, state),
    runJob: (bot, job) => engine.runJob(bot, job),
    onError: (bot, job, error) => notifications.notify({ botId: bot.id, botName: bot.name, url: `/?bot=${bot.id}&panel=jobs`, kind: "failure", priority: "high", title: `${job.name} failed`, body: error.message || "The routine could not start." }).catch(() => {}),
  });
  // A turn running far past its time (and not waiting on an approval) is reported once, in Home and by push.
  const STUCK_MS = Math.max(60_000, Number(process.env.RAVNIR_STUCK_MINUTES || 30) * 60_000);
  const stuckTimer = setInterval(() => {
    for (const { botId, active } of engine.stuckTurns(STUCK_MS, { pendingFor: (id) => approvals.pendingFor(id) })) {
      if (active.stuckNotified) continue;
      active.stuckNotified = true;
      const bot = state.bots.find((item) => item.id === botId);
      if (!bot) continue;
      const minutes = Math.round((Date.now() - active.startedAt) / 60_000);
      notifications.notify({ botId, botName: bot.name, url: `/?bot=${botId}`, kind: "failure", priority: "high", title: active.jobName ? `${active.jobName} is stuck` : "seems stuck", body: `Running for ${minutes} minutes${active.activity ? `, last step: ${active.activity}` : ""}. Open the thread to stop it or let it finish.`, tag: `stuck-${active.turnId}` }).catch(() => {});
    }
  }, 60_000);
  stuckTimer.unref?.();

  // Bots whose existing opencode.json a sync rewrote (an upgrade); read once, just below. One entry per bot at most.
  const rewrittenConfigs = new Set();
  for (const bot of state.bots) provisionBot(bot);
  // With a vault, every idle OpenCode bot reloads once the vault opens (above). Without one, only the
  // bots whose existing opencode.json this start rewrote do: OpenCode still holds their old tools.
  if (!vault && rewrittenConfigs.size) {
    const ids = new Set(rewrittenConfigs);
    setImmediate(() => reloadOpenCodeTools((bot) => ids.has(bot.id)).catch(() => {}));
  }
  rewrittenConfigs.clear();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      // With RAVNIR_USER and RAVNIR_PASSWORD set, every page needs a session cookie
      // (from /login) or a Basic header (curl, scripts). Pages send you to /login and
      // the API answers 401 JSON, so the browser never shows its own password dialog.
      if (!PUBLIC_PATHS.has(url.pathname) && !MCP_PATH.test(url.pathname) && !auth.check(req)) {
        deny(req, res, url);
        return;
      }
      if (req.method === "GET" && url.pathname === "/login") {
        if (auth.check(req)) redirect(res, safeNext(url.searchParams.get("next")));
        else serveFile(res, ["login.html", "text/html; charset=utf-8"], req);
        return;
      }
      if (req.method === "GET" && url.pathname === "/plugins/oauth/callback") {
        const page = await plugins.callback(url.searchParams);
        res.writeHead(page.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page.html);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/plugins/")) {
        servePluginAsset(res, url.pathname);
        return;
      }
      const asset = req.method === "GET" ? staticFile(url.pathname) : null;
      if (asset) {
        serveFile(res, asset, req);
        return;
      }
      if (req.method === "GET" && VENDOR.has(url.pathname)) {
        serveVendor(res, VENDOR.get(url.pathname), req);
        return;
      }
      const novnc = req.method === "GET" ? novncFile(url.pathname, root) : null;
      if (novnc) {
        serveVendor(res, novnc, req);
        return;
      }
      if (req.method === "GET" && url.pathname === "/demo/login") {
        serveDemoLogin(res, url);
        return;
      }
      if (req.method === "POST" && url.pathname === "/demo/login") {
        await handleDemoLogin(req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/demo/account") {
        serveDemoAccount(req, res);
        return;
      }
      if (url.pathname.startsWith("/api/") && !url.pathname.endsWith("/mcp")) {
        assertSameOrigin(req);
      }
      await route({ req, res, url });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error.status || 500;
      // A plugin service that refuses us is an expected failure, not a Ravnir bug.
      if (status >= 500 && !error.expected) console.error(error);
      send(res, status, { error: error.message || "Request failed." });
    }
  });

  // The Shell tab's terminal. Same sign-in as every page, plus a same-origin
  // check, because browsers attach the session cookie to cross-site WebSocket requests.
  // The live view (Take control) shares the checks: the user's own pages only, never a bot's MCP token.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const liveSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // The Mac runner signs in with its own token in the first message, not the user's cookie.
  const macSockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  // Browsing traffic from the Mac (server/macTunnel.js); data frames are small, large ones are a bug.
  const tunnelSockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === MAC_PATH) {
      if (!mac.configured || req.headers["sec-fetch-site"]) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      macSockets.handleUpgrade(req, socket, head, (ws) => mac.attach(ws));
      return;
    }
    if (url.pathname === TUNNEL_PATH) {
      if (!macTunnel.configured || req.headers["sec-fetch-site"]) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      tunnelSockets.handleUpgrade(req, socket, head, (ws) => macTunnel.attach(ws));
      return;
    }
    const liveMatch = LIVE_PATH.exec(url.pathname);
    const match = TERMINAL_PATH.exec(url.pathname) || liveMatch;
    const bot = match ? state.bots.find((item) => item.id === match[1]) : null;
    let status = 0;
    if (!match) status = 404;
    else if (!auth.check(req)) status = 401;
    else if (!upgradeAllowed(req.headers, { publicUrl: process.env.RAVNIR_PUBLIC_URL })) status = 403;
    else if (!bot) status = 404;
    if (status) {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (liveMatch) liveSockets.handleUpgrade(req, socket, head, (ws) => live.attach(ws, bot));
    else sockets.handleUpgrade(req, socket, head, (ws) => openTerminal(ws, bot, url));
  });

  function openTerminal(ws, bot, url) {
    let open = true;
    const viewer = {
      send: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
      closed: () => !open,
    };
    const ping = setInterval(() => ws.ping(), 25_000);
    ws.on("close", () => {
      open = false;
      clearInterval(ping);
      terminals.detach(bot.id, viewer);
    });
    ws.on("error", () => ws.terminate());
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message?.t === "in") terminals.input(bot.id, message.d);
      else if (message?.t === "resize") terminals.resize(bot.id, message.cols, message.rows);
    });
    if (box.uses(bot) && !terminals.status(bot.id).open) {
      viewer.send({ t: "status", message: `Starting ${bot.name}'s computer. The first start builds it and can take a few minutes.` });
    }
    terminals.attach(bot, viewer, { cols: url.searchParams.get("cols"), rows: url.searchParams.get("rows") }).catch((error) => {
      viewer.send({ t: "error", message: error.message });
      ws.close(1011, "The shell did not start.");
    });
  }

  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address === "object") listenPort = address.port;
    if (!process.env.RAVNIR_PUBLIC_URL && address && typeof address === "object") {
      appUrl = `http://127.0.0.1:${address.port}`;
      engine.appUrl = appUrl;
    }
    for (const bot of state.bots) {
      provisionBot(bot);
      for (const connector of bot.connectors) {
        if (connector.enabled && !connector.lazy) mcp.refresh(bot, connector).catch(() => {});
      }
    }
    scheduler.start();
    watchSpecs();
    specTimer = setInterval(watchSpecs, 20_000);
    specTimer.unref?.();
  });
  let specTimer = null;
  server.on("close", () => {
    scheduler.stop();
    cards.close();
    clearInterval(stuckTimer);
    feeds?.stop();
    writer?.stop();
    clearInterval(statusTimer);
    vault?.close();
    clearInterval(specTimer);
    terminals.closeAll();
    for (const client of sockets.clients) client.terminate();
    for (const client of liveSockets.clients) client.terminate();
    live.close().catch(() => {});
    box.closeGates();
    browser.closeAll().catch(() => {});
    macTunnel.close();
    mcp.closeAll().catch(() => {});
    managedOpenCode.stop().catch(() => {});
  });

  function todayFeed(dayParam) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? new Date(`${dayParam}T12:00:00`).getTime() : Date.now();
    const from = startOfDay(parsed);
    const to = shiftDays(from, 1);
    const now = Date.now();
    const rows = ledger.between(from, to);
    const upcoming = routinesBetween(Math.max(now, from), to, 48);
    // Turns and spend per hour of the shown day, for the Home activity strip.
    const hours = Array.from({ length: 24 }, () => ({ turns: 0, errors: 0, cost: 0 }));
    for (const row of rows) {
      const hour = hours[new Date(row.at).getHours()];
      hour.turns += 1;
      if (row.status === "error") hour.errors += 1;
      hour.cost += Number(row.usage?.cost) || 0;
    }
    return {
      day: from,
      isToday: from === startOfDay(now),
      totals: ledger.totals(rows),
      series: ledger.daily("", 14, from).map((day) => ({ day: day.day, turns: day.turns, errors: day.errors, asks: day.asks, tokens: day.tokens, cost: day.cost })),
      hours: hours.map((hour) => ({ ...hour, cost: Math.round(hour.cost * 1e6) / 1e6 })),
      // Each routine's next run from now on, past the end of today, so Home never says only "nothing left".
      soon: routinesBetween(now, shiftDays(startOfDay(now), 8), 1).slice(0, 8),
      models: ledger.byModel(rows),
      bots: state.bots.map((bot) => ({
        botId: bot.id,
        name: bot.name,
        color: bot.color,
        avatar: normalizeAvatar(bot.avatar, bot.id),
        limits: bot.limits,
        model: bot.model.model || "",
        provider: bot.model.provider || "",
        ready: Boolean(bot.model.baseUrl && bot.model.model),
        browserReady: Boolean(browser.status(bot).available),
        turnsTotal: Number(bot.stats?.turns) || 0,
        jobCount: bot.jobs.length,
        enabledJobs: bot.jobs.filter((job) => job.enabled).length,
        ...ledger.totals(rows.filter((row) => row.botId === bot.id)),
        pausedJobs: bot.jobs.filter((job) => !job.enabled).length,
      })),
      timeline: [...rows].reverse().slice(0, 300),
      approvals: {
        pending: approvals.pending(),
        decided: approvals.since(from).filter((item) => item.status !== "pending" && item.createdAt < to).reverse(),
      },
      upcoming,
      proposals: openProposals(),
      // Questions agents asked that the user has not answered yet, newest first.
      questions: asks.open().map(publicAsk).reverse(),
      // Routines whose last run failed, until the next good run or a dismiss.
      failures: routineFailures(),
      // Turns running past their time, not waiting on an approval.
      stuck: engine.stuckTurns(STUCK_MS, { pendingFor: (id) => approvals.pendingFor(id) }).map(({ botId, active }) => ({ botId, botName: state.bots.find((item) => item.id === botId)?.name || "", turnId: active.turnId, startedAt: active.startedAt, source: active.source, jobName: active.jobName || "", activity: active.activity || "" })),
      specs: state.bots
        .filter((bot) => specNeedsAttention(bot.spec))
        .map((bot) => ({ botId: bot.id, botName: bot.name, path: bot.spec.path, status: bot.spec.status, changedAt: bot.spec.changedAt || 0, dismissedAt: bot.spec.dismissedAt || 0, error: bot.spec.error || "" })),
    };
  }

  function routineFailures() {
    const out = [];
    for (const bot of state.bots) {
      for (const job of bot.jobs) {
        if (job.lastStatus !== "error" || !job.lastRunAt || Number(job.failureDismissedAt) >= Number(job.lastRunAt)) continue;
        const run = [...(job.runs || [])].reverse().find((item) => item.status === "error");
        out.push({ botId: bot.id, botName: bot.name, jobId: job.id, jobName: job.name, at: run?.at || job.lastRunAt, error: job.lastSummary || "" });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // Every enabled routine run in [start, end), at most `perJob` runs of each, soonest first.
  function routinesBetween(start, end, perJob) {
    const out = [];
    for (const bot of state.bots) {
      for (const job of bot.jobs) {
        if (!job.enabled) continue;
        const schedule = describeSchedule(job);
        // A one-time job has no cron: it is upcoming once, at its own time.
        if (job.at) {
          if (!job.done && job.at >= start && job.at < end) {
            out.push({ botId: bot.id, botName: bot.name, jobId: job.id, jobName: job.name, at: job.at, schedule });
          }
          continue;
        }
        let at = start - 1;
        for (let count = 0; count < perJob; count += 1) {
          let next = 0;
          try {
            next = nextCron(job.cron, at);
          } catch {
            break;
          }
          if (!next || next >= end) break;
          out.push({ botId: bot.id, botName: bot.name, jobId: job.id, jobName: job.name, at: next, schedule });
          at = next;
        }
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  function watchSpecs() {
    let changed = false;
    for (const bot of state.bots) {
      if (!checkSpec(bot)) continue;
      changed = true;
      eventLog.append(bot, { type: "spec", status: bot.spec.status, path: bot.spec.path });
    }
    if (changed) saveState(home, state);
  }

  function ensureMcpToken(bot) {
    const key = `bot:${bot.id}:mcpToken`;
    let token = secrets.get(key, "");
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      secrets.set(key, token);
    }
    return token;
  }

  function settingsPayload() {
    const layoutChoice = state.settings?.vault?.layout || "auto";
    return {
      defaults: normalizeDefaults(state.settings?.defaults),
      owner: ownerOf(state),
      languages: LANGUAGES,
      // "layout" is the choice; "active" is what the vault uses now (auto follows the folders it already has).
      vault: { layout: layoutChoice, active: writer?.available ? writer.layout().id : vault?.available ? resolveLayout(layoutChoice, vault.dir, ownerOf(state).language).id : null, writes: Boolean(writer?.available), profile: writer?.available ? writer.profilePath() : null },
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  function contextFor(bot, memoryBrief = "") {
    return {
      workspace: workspacePath(home, bot),
      appUrl,
      connectors: bot.connectors,
      plugins: plugins.promptInfo(bot),
      jobs: bot.jobs,
      logins: bot.vault,
      browserAvailable: Boolean(browser.status(bot).available),
      ownComputer: box.uses(bot),
      localProjects: box.uses(bot) ? [] : localProjects(),
      hostName: localHostName(),
      mac: mac.status(),
      owner: ownerOf(state),
      chooser: chooserFor(bot).mode,
      teammates: teammatesFor(state, bot, plugins),
      groups: state.groups,
      memoryBrief,
      memoryAvailable: Boolean(aiMemory.available),
      ...(vault?.available ? { vaultContext: vault.staticContextForBot(bot, { profile: ownerProfilePath() }).text, vaultWrite: Boolean(writer?.available), vaultPaths: writer?.available ? writer.describe() : null } : {}),
      specText: readAppliedSpec(home, bot),
      skillsIndex: indexForBot(bot),
      provider: bot.model.provider,
    };
  }

  // Backup models, in order, each picked like the main one ({ via, model }). An empty list clears them.
  function resolveFallbacks(list, primary) {
    if (!Array.isArray(list)) throw httpError("Backup models must be a list.", 400);
    if (list.length > MAX_FALLBACKS) throw httpError(`An agent can have up to ${MAX_FALLBACKS} backup models.`, 400);
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== "object" || !String(item.model || "").trim()) throw httpError("Each backup model needs a model id.", 400);
      const choice = models.resolveChoice(item);
      const entry = backupEntry(choice || normalizeIncomingModel(item, primary));
      if (entry.model === primary.model && entry.baseUrl === primary.baseUrl) continue;
      if (out.some((seen) => seen.model === entry.model && seen.baseUrl === entry.baseUrl)) continue;
      out.push(entry);
    }
    return out;
  }

  // New agent from the form, the API or the first-run wizard's starters.
  function addBot(body) {
    const bot = createBot(body);
    validateBotFields(body);
    ensureBotHome(home, bot);
    if (body.model) {
      const choice = models.resolveChoice(body.model);
      bot.model = choice ? normalizeIncomingModel(choice) : normalizeIncomingModel(body.model);
      if (body.model.apiKey) {
        secrets.set(`bot:${bot.id}:apiKey`, String(body.model.apiKey));
        bot.model.apiKeySet = true;
      }
      if (body.model.fallbacks !== undefined) bot.model.fallbacks = resolveFallbacks(body.model.fallbacks, bot.model);
    }
    state.bots.push(bot);
    ensureGroups(state);
    ensureMcpToken(bot);
    provisionBot(bot);
    const intro = {
      id: crypto.randomUUID(),
      role: "assistant",
      kind: "intro",
      content: `I'm ${bot.name}. I'm on. ${bot.job} My computer is ready on this server, and I keep working when your browser is closed.`,
      at: Date.now(),
    };
    writeConversation(home, bot, [intro]);
    saveState(home, state);
    syncOpenCodeConfig(bot);
    return bot;
  }

  function provisionBot(bot) {
    ensureMemoryMarker(workspacePath(home, bot));
    if (aiMemory.available && process.env.RAVNIR_AI_MEMORY !== "off") provisionMemory(bot);
    // Every start rewrites opencode.json, so a config from an older version (an MCP entry under its
    // old name, stale permissions) does not outlive an upgrade.
    ensureMcpToken(bot);
    syncOpenCodeConfig(bot);
    return bot;
  }

  function provisionMemory(bot) {
    let connector = bot.connectors.find((item) => item.managed === "ai-memory" || item.name === "ai-memory");
    const spec = aiMemoryConnector(aiMemory);
    if (!connector) {
      connector = { id: crypto.randomUUID(), ...spec };
      bot.connectors.push(connector);
    } else {
      connector.managed = "ai-memory";
      connector.command = spec.command;
      connector.args = spec.args;
      connector.enabled = true;
      connector.configKey ||= "ai_memory";
    }
    // OpenCode starts its own ai-memory only while the user's global OpenCode config has one. The flag
    // follows that config, so an agent made while it had one does not keep skipping after it is gone.
    connector.skipOpenCode = openCodeHasAiMemory();
  }

  function openCodeHasAiMemory() {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME || "", ".config", "opencode", "opencode.json"), "utf8"));
      return Boolean(config?.mcp?.["ai-memory"]);
    } catch {
      return false;
    }
  }

  async function passwordFor(bot, entry) {
    if (entry.source === "1password" && entry.externalId) {
      const login = await onePassword.readLogin(entry.externalId, entry.externalVault);
      return login.password;
    }
    return secrets.get(`vault:${bot.id}:${entry.id}`, "");
  }

  // What each routine cost over the last 30 days, from the ledger rows its runs left.
  function withJobSpend(payload) {
    const rows = ledger.between(shiftDays(startOfDay(), -29), Infinity, payload.id).filter((row) => row.source === "job" && row.jobId);
    return { ...payload, jobs: payload.jobs.map((job) => ({ ...job, spend: ledger.totals(rows.filter((row) => row.jobId === job.id)) })) };
  }

  // A skill an agent asked for, from its suggestion card. Same limit as the shop.
  function giveSkill(bot, name) {
    const found = discoverSkills();
    const entry = found.find((item) => item.name === name);
    if (!entry) throw httpError("That skill is no longer in the shop.", 409);
    if (entry.default || (bot.skills || []).includes(entry.name)) return { skill: entry.name };
    const known = new Set(found.map((item) => item.name));
    const used = (bot.skills || []).filter((item) => known.has(item)).length;
    if (used >= skillRoom(found)) throw httpError(`${bot.name} already has ${used} skills, the most an agent can hold. Remove one from it first.`, 409);
    bot.skills = normalizeSkills([...(bot.skills || []), entry.name]);
    appendActivity(bot, `Learned the ${entry.title} skill`);
    touchBot(bot);
    saveState(home, state);
    return { skill: entry.name };
  }

  // A plugin an agent asked for. Not connected yet: the agent is remembered and gets it the moment the
  // user signs in on the Plugins page (PluginManager gives remembered agents a new connection).
  async function givePlugin(bot, id) {
    const connection = plugins.connections[id];
    if (connection) {
      if (!connection.bots.includes(bot.id)) await plugins.setBots(id, [...connection.bots, bot.id]);
      return { plugin: id, connected: true };
    }
    const entry = plugins.catalog().plugins.find((item) => item.id === id);
    if (!entry) throw httpError("That plugin is no longer in the catalog.", 409);
    const blocker = pluginBlocker(plugins, entry);
    if (blocker) throw httpError(`${entry.name} cannot be connected on this server: ${blocker}.`, 409);
    state.pluginAgents ||= {};
    state.pluginAgents[id] = [...new Set([...(state.pluginAgents[id] || []), bot.id])];
    saveState(home, state);
    return { plugin: id, connected: false };
  }

  function detail(bot, memoryBrief = "") {
    return {
      bot: withJobSpend(publicBot(bot, { home, appUrl })),
      conversation: readConversation(home, bot),
      diffs: readDiffs(home, bot),
      livePrompt: buildSystemPrompt(bot, contextFor(bot, memoryBrief)),
      runtime: engine.status(bot.id),
      lastSeq: eventLog.lastSeq(bot),
      browser: browser.status(bot),
      network: box.uses(bot) ? { ...network.describe(bot), box: true } : network.describe(bot),
      desktop: desktop.status(bot),
      memory: memoryStatus(aiMemory),
      groups: ensureGroups(state).map((group) => publicGroup(group, state.bots)),
      compacting: engine.compacting.has(bot.id),
      approvals: approvals.pendingFor(bot.id),
      // This agent's skill and plugin asks from the last month, so the cards under its replies show live.
      suggestions: suggestionsFor(bot),
      usage: usageFor(bot.id, 14),
      computer: {
        workspace: workspacePath(home, bot),
        home: botHome(home, bot),
        platform: process.platform,
      },
    };
  }

  function syncOpenCodeConfig(bot) {
    const workspace = workspacePath(home, bot);
    fs.mkdirSync(workspace, { recursive: true });
    const token = ensureMcpToken(bot);
    for (const connector of bot.connectors) {
      if (!connector.configKey) connector.configKey = connectorKey(connector);
    }
    // OpenCode starts stdio connectors through bin/connector-env.mjs, so they get childEnv plus these, not OpenCode's environment.
    const generated = openCodeMcpConfig(bot, `${mcpBase()}/api/bots/${bot.id}/mcp`, token, {
      envFor: (connector) => connectorOwnSecret(bot, connector).env,
    });
    const file = path.join(workspace, "opencode.json");
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      existing = {};
    }
    const previous = Array.isArray(bot.managedMcpKeys) ? bot.managedMcpKeys : [];
    existing.$schema ||= "https://opencode.ai/config.json";
    existing.permission = openCodePermission(bot.policy, { ownComputer: box.uses(bot) });
    // A refused permission must not end the agent's turn: the model gets the refusal and finishes
    // without that action (OpenCode stops the loop on a refusal unless this is on).
    existing.experimental = { ...(existing.experimental || {}), continue_loop_on_deny: true };
    existing.mcp ||= {};
    for (const key of [...previous, "truebot"]) delete existing.mcp[key];
    // A connector OpenCode must not start must not linger from an older config either: such an entry
    // starts outside the launcher, with OpenCode's whole environment.
    for (const connector of bot.connectors) {
      if (connector.skipOpenCode && connector.configKey && connector.configKey !== "ravnir") delete existing.mcp[connector.configKey];
    }
    existing.mcp = { ...existing.mcp, ...generated.mcp };
    for (const connector of bot.connectors) {
      if (!connector.enabled || connector.skipOpenCode) continue;
      const secret = connectorOwnSecret(bot, connector);
      if (connector.transport === "http" && secret.headers) {
        existing.mcp[connector.configKey] = { ...existing.mcp[connector.configKey], headers: secret.headers };
      }
    }
    bot.managedMcpKeys = ["ravnir", ...bot.connectors.filter((connector) => connector.enabled && !connector.skipOpenCode).map((connector) => connector.configKey)];
    const text = JSON.stringify(existing, null, 2);
    let current = null;
    try {
      current = fs.readFileSync(file, "utf8");
      if (current === text) return;
    } catch {
      // Write it below.
    }
    fs.writeFileSync(file, text, { mode: 0o600 });
    if (current !== null) rewrittenConfigs.add(bot.id);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Ignore.
    }
  }

  function findBot(id) {
    const bot = state.bots.find((item) => item.id === id);
    if (!bot) throw httpError("Unknown bot.", 404);
    return bot;
  }

  function usageFor(botId, days = 14) {
    const from = shiftDays(startOfDay(), -(days - 1));
    return {
      today: ledger.spentToday(botId),
      month: ledger.spentThisMonth(botId),
      total: ledger.totals(ledger.between(from, Infinity, botId)),
      daily: ledger.daily(botId, days),
      models: ledger.byModel(ledger.between(from, Infinity, botId)),
    };
  }

  // The user tagged other agents with @Name. Let each one run its own turn on
  // the same prompt, then paste the reply into the originating thread with a
  // label. Collaboration queue and reply reading live in collaboration.js.
  async function routeMentions(bot, text, mentions) {
    for (const mention of mentions) {
      const target = state.bots.find((item) => item.id === mention.botId);
      if (!target || target.id === bot.id) continue;
      let reply = "";
      try {
        reply = await deliverMention({ bot, engine, home }, target, text);
      } catch {
        continue;
      }
      if (!reply) continue;
      const message = {
        id: crypto.randomUUID(),
        role: "assistant",
        kind: "mention",
        content: reply,
        at: Date.now(),
        source: "mention",
        fromBotId: target.id,
        fromBotName: target.name,
      };
      appendConversation(home, bot, [message]);
      engine.emit(bot, { type: "mention.reply", message });
    }
  }

  function appendActivity(bot, message, extra = {}) {
    eventLog.append(bot, { type: "activity", actor: "user", message, ...extra });
  }

  // The approval waits for the user, so it is the one thing that always pushes.
  function notifyApproval(bot, record) {
    if (notifiedApprovals.has(record.id)) return;
    notifiedApprovals.add(record.id);
    // "Dev wants to use GitHub: create_issue" already names the agent; the push title adds it.
    let title = String(record.title || "").trim();
    if (record.kind === "plugin" && title.startsWith(`${bot.name} `)) title = title.slice(bot.name.length + 1);
    const takeover = record.kind === "takeover";
    notifications.notify({
      botId: bot.id,
      botName: bot.name,
      kind: "approval",
      title: takeover ? "needs you to sign in" : !title || /^opencode\b/i.test(title) ? "needs your approval" : `wants to ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
      body: takeover ? String(record.data?.reason || title) : String(record.detail || "").split("\n")[0],
      url: "/?view=today",
      priority: "high",
      tag: `approval-${record.id}`,
    }).catch(() => {});
  }

  function settleApprovalNotice(record) {
    notifiedApprovals.delete(record.id);
    markNoticeRead(`approval-${record.id}`);
  }

  // Answered approvals and suggestions should not stay unread in the Inbox.
  function markNoticeRead(tag) {
    const ids = notifications.list({ limit: 500 }).filter((item) => item.tag === tag && !item.read).map((item) => item.id);
    if (ids.length) notifications.markRead(ids);
  }

  // A bot from a Grok Bot export starts on the main bot's model so it works at once.
  function createImportedBot(item) {
    const source = state.bots.find((bot) => bot.main) || state.bots.find((bot) => bot.model.baseUrl && bot.model.model) || state.bots[0];
    const bot = createBot({ name: item.name, job: item.job, color: source?.color, model: source ? { ...source.model } : {} });
    const key = source ? secrets.get(`bot:${source.id}:apiKey`, "") : "";
    if (key) {
      secrets.set(`bot:${bot.id}:apiKey`, key);
      bot.model.apiKeySet = true;
    }
    ensureBotHome(home, bot);
    state.bots.push(bot);
    ensureGroups(state);
    writeConversation(home, bot, [{
      id: crypto.randomUUID(),
      role: "assistant",
      kind: "intro",
      content: `I'm ${bot.name}. I was moved over from Grok Bot. ${bot.job} My computer is ready on this server.`,
      at: Date.now(),
    }]);
    ensureMcpToken(bot);
    provisionBot(bot);
    return bot;
  }

  async function route(ctx) {
    const { req, res, url } = ctx;
    const { method } = req;
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/health") {
      send(res, 200, {
        ok: true,
        url: appUrl,
        version: VERSION,
        platform: process.platform,
        browserAvailable: Boolean(browser.status(state.bots[0] || { id: "none" }).available),
        uptime: process.uptime(),
      });
      return;
    }
    if (method === "GET" && pathname === "/api/mac") {
      send(res, 200, { ...mac.status(), tunnel: macTunnel.status() });
      return;
    }
    // Sites that refuse this server's network and open from the Mac.
    if (method === "GET" && pathname === "/api/browser/home-sites") {
      send(res, 200, { sites: network.homeSites.list(), macLinked: network.macLinked, macOnline: network.macOnline });
      return;
    }
    if (method === "DELETE" && pathname.startsWith("/api/browser/home-sites/")) {
      const site = siteOf(decodeURIComponent(pathname.slice("/api/browser/home-sites/".length)));
      if (!network.homeSites.remove(site)) throw httpError("That site is not on the list.", 404);
      send(res, 200, { sites: network.homeSites.list() });
      return;
    }
    if (method === "GET" && pathname === "/api/skills") {
      const found = discoverSkills();
      send(res, 200, {
        room: skillRoom(found),
        skills: found.map((entry) => ({
          ...describeSkill(entry),
          // Default skills are open to every agent; the rest only to the agents given them.
          agents: entry.default ? state.bots.map((bot) => bot.id) : state.bots.filter((bot) => (bot.skills || []).includes(entry.name)).map((bot) => bot.id),
        })),
      });
      return;
    }
    const skillMatch = /^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})(\/agents)?$/.exec(pathname);
    if (skillMatch && ((method === "GET" && !skillMatch[2]) || (method === "PUT" && skillMatch[2]))) {
      const found = discoverSkills();
      const entry = found.find((item) => item.name === skillMatch[1]);
      if (!entry) throw httpError("There is no skill with that name.", 404);
      if (method === "GET") {
        send(res, 200, { ...describeSkill(entry), body: entry.body });
        return;
      }
      if (entry.default) throw httpError("Every agent already has this skill.", 409);
      const body = await readBody(req, 20_000);
      if (!Array.isArray(body.agents) || body.agents.some((id) => typeof id !== "string")) throw httpError("Send the list of agents that should have this skill.", 400);
      const wanted = new Set(body.agents);
      const unknown = [...wanted].filter((id) => !state.bots.some((bot) => bot.id === id));
      if (unknown.length) throw httpError("One of those agents no longer exists. Reload and try again.", 404);
      const room = skillRoom(found);
      const known = new Set(found.map((item) => item.name));
      // Check every agent first, so a full one leaves nothing half changed.
      for (const bot of state.bots) {
        if (!wanted.has(bot.id) || (bot.skills || []).includes(entry.name)) continue;
        const used = (bot.skills || []).filter((name) => known.has(name)).length;
        if (used >= room) throw httpError(`${bot.name} already has ${used} skills, the most an agent can hold. Remove one from it first.`, 409);
      }
      for (const bot of state.bots) {
        const has = (bot.skills || []).includes(entry.name);
        if (wanted.has(bot.id) === has) continue;
        bot.skills = wanted.has(bot.id) ? normalizeSkills([...(bot.skills || []), entry.name]) : (bot.skills || []).filter((name) => name !== entry.name);
        appendActivity(bot, wanted.has(bot.id) ? `Learned the ${entry.title} skill` : `Dropped the ${entry.title} skill`);
        touchBot(bot);
      }
      saveState(home, state);
      send(res, 200, { name: entry.name, agents: state.bots.filter((bot) => (bot.skills || []).includes(entry.name)).map((bot) => bot.id) });
      return;
    }
    if (method === "GET" && pathname === "/api/state") {
      send(res, 200, {
        server: {
          name: "Ravnir",
          url: appUrl,
          version: VERSION,
          platform: process.platform,
          home,
          workspaceRoot: path.join(home, "bots"),
          browserAvailable: Boolean(browser.status(state.bots[0] || { id: "none" }).available),
          desktopAvailable: desktop.status(state.bots[0] || { id: "none" }).available,
          box: { enabled: box.enabled, runtime: box.settings.runtime },
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          auth: auth.enabled,
          user: auth.enabled ? String(process.env.RAVNIR_USER || "") : "",
          uptime: Math.round(process.uptime()),
          // A fresh install opens the first-run wizard (public/welcome.js).
          setupNeeded: Boolean(state.settings?.setup?.needed),
        },
        bots: state.bots.map((bot) => ({
          ...publicBotSummary(bot),
          ...engine.status(bot.id),
          activity: engine.status(bot.id).activity || activityFor(bot),
        })),
        groups: ensureGroups(state).map((group) => publicGroup(group, state.bots)),
        memory: memoryStatus(aiMemory),
        vault: vault ? { ...vault.status(), feeds: feeds.status(), writer: writer ? writer.status() : null } : { available: false },
        onepassword: await onePassword.status(),
        jev: { ...jevStatus(), ...jevSpend() },
        inbox: {
          approvals: approvals.pending().length,
          specs: state.bots.filter((bot) => specNeedsAttention(bot.spec)).length,
          proposals: openProposals().length,
          questions: asks.open().length,
          failures: routineFailures().length,
          stuck: engine.stuckTurns(STUCK_MS, { pendingFor: (id) => approvals.pendingFor(id) }).length,
          unread: notifications.unreadCount(),
          today: ledger.totals(ledger.between(startOfDay())),
        },
      });
      return;
    }
    if (pathname === "/api/setup" || pathname.startsWith("/api/setup/") || pathname === "/api/pair") {
      const body = method === "GET" ? {} : await readBody(req, 20_000);
      const out = await setup.api({ method, pathname, body });
      send(res, out.status || 200, out.body);
      return;
    }
    if (method === "GET" && pathname === "/api/doctor") {
      const report = await runDoctor({
        home,
        version: VERSION,
        host: process.env.RAVNIR_HOST || "127.0.0.1",
        signIn: auth.enabled,
        publicUrl: process.env.RAVNIR_PUBLIC_URL || "",
        access: process.env.RAVNIR_ACCESS || "",
        container: process.env.RAVNIR_CONTAINER === "1",
        models,
        managedOpenCode,
        vault,
        writer,
        vaultRemote: Boolean(vaultSetup?.remote || state.settings?.vaultRemote),
        push,
        skipBrowser: url.searchParams.get("browser") === "0",
      });
      if (url.searchParams.get("format") === "text") {
        res.writeHead(report.ok ? 200 : 503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(`${formatReport(report)}\n`);
      } else send(res, 200, report);
      return;
    }
    if (method === "POST" && pathname === "/api/login") {
      const body = await readBody(req, 10_000);
      if (!auth.enabled) {
        send(res, 200, { ok: true, open: true });
        return;
      }
      // A pairing code from the first-run wizard or Settings signs in a phone without the password.
      const byCode = body.code !== undefined;
      const session = byCode
        ? auth.loginWithCode(String(body.code ?? ""), { secure: cookieSecure(req) })
        : auth.login(String(body.username ?? ""), String(body.password ?? ""), { secure: cookieSecure(req) });
      if (!session) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw httpError(byCode ? "That code is wrong or has expired. Make a new one on a signed-in screen." : "Wrong username or password.", 401);
      }
      send(res, 200, { ok: true }, { "set-cookie": session.setCookie });
      return;
    }
    if (method === "POST" && pathname === "/api/logout") {
      send(res, 200, { ok: true }, { "set-cookie": auth.logout(req, { secure: cookieSecure(req) }).setCookie });
      return;
    }

    if (method === "POST" && pathname === "/api/sessions/revoke") {
      if (!auth.enabled) throw httpError("Sign-in is off on this server, so there are no sessions to end.", 400);
      send(res, 200, { ok: true }, { "set-cookie": auth.revokeAll({ secure: cookieSecure(req) }).setCookie });
      return;
    }
    if (pathname === "/api/settings" && (method === "GET" || method === "PUT")) {
      if (method === "PUT") {
        const body = await readBody(req, 20_000);
        const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
        if (!isObject(body)) throw httpError("Send the settings as a JSON object.", 400);
        if (body.defaults === undefined && body.owner === undefined && body.vault === undefined) throw httpError("Nothing to save: send defaults, owner or vault.", 400);
        let next = { ...state.settings };
        if (body.owner !== undefined) {
          if (!isObject(body.owner)) throw httpError("Owner must be an object.", 400);
          const { name, language } = body.owner;
          if (name !== undefined && (typeof name !== "string" || name.length > 60)) throw httpError("Your name must be text, at most 60 characters.", 400);
          if (language !== undefined && language !== "" && !Object.hasOwn(LANGUAGES, language)) throw httpError(`Language must be one of ${Object.keys(LANGUAGES).join(", ")}.`, 400);
          next.owner = normalizeOwner({ ...next.owner, ...body.owner });
        }
        if (body.vault !== undefined) {
          if (!isObject(body.vault) || !LAYOUT_CHOICES.includes(body.vault.layout)) throw httpError(`Vault layout must be one of ${LAYOUT_CHOICES.join(", ")}.`, 400);
          next.vault = { layout: body.vault.layout };
        }
        if (body.defaults !== undefined) {
          const incoming = body.defaults;
          if (!isObject(incoming)) throw httpError("Defaults must be an object.", 400);
          const limits = { provider: 20, baseUrl: 300, username: 80, model: 200, via: 60, group: 40, notify: 20 };
          for (const [key, max] of Object.entries(limits)) {
            const value = incoming[key];
            if (value === undefined) continue;
            if (typeof value !== "string") throw httpError(`Default ${key} must be text.`, 400);
            if (value.length > max) throw httpError(`Default ${key} is too long.`, 400);
          }
          if (incoming.provider && !["opencode", "openai"].includes(incoming.provider)) throw httpError("Default provider must be opencode or openai.", 400);
          if (incoming.via && !/^(opencode|server:[A-Za-z0-9-]{1,40})$/.test(incoming.via)) throw httpError("Default model source is not valid.", 400);
          if (incoming.notify && !NOTIFY_LEVELS.includes(incoming.notify)) throw httpError("Default notifications must be all, important, or off.", 400);
          if (incoming.baseUrl) {
            let parsed;
            try {
              parsed = new URL(incoming.baseUrl.trim());
            } catch {
              throw httpError("Base URL is not a URL.", 400);
            }
            if (!["http:", "https:"].includes(parsed.protocol)) throw httpError("Base URL must be http or https.", 400);
            if (parsed.username || parsed.password) throw httpError("Do not put a password in the address. Passwords are set per agent.", 400);
          }
          next.defaults = normalizeDefaults({ ...next.defaults, ...incoming });
        }
        // Everything is checked before anything is saved.
        state.settings = next;
        saveState(home, state);
      }
      send(res, 200, settingsPayload());
      return;
    }
    if (method === "GET" && pathname === "/api/config") {
      send(res, 200, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        version: VERSION,
        url: appUrl,
        uptime: Math.round(process.uptime()),
        env: envConfig({ serverDir: path.join(root, "server") }),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/push/key") {
      send(res, 200, { key: push.publicKey() });
      return;
    }
    if (method === "POST" && pathname === "/api/push/subscribe") {
      const body = await readBody(req);
      try {
        const { id } = push.subscribe(body.subscription, { label: String(body.label || ""), userAgent: String(req.headers["user-agent"] || "") });
        send(res, 200, { id });
      } catch (error) {
        throw httpError(error.message, 400);
      }
      return;
    }
    if (method === "POST" && pathname === "/api/push/unsubscribe") {
      const body = await readBody(req);
      send(res, 200, { ok: push.unsubscribe(String(body.endpoint || ""), String(body.id || "")) });
      return;
    }
    if (method === "GET" && pathname === "/api/push/devices") {
      send(res, 200, { devices: push.list() });
      return;
    }
    if (method === "POST" && pathname === "/api/push/test") {
      const devices = push.list().length;
      const result = devices
        ? await push.send({ id: crypto.randomUUID(), title: "Ravnir: Test notification", body: "If you can read this, push works on this device.", url: "/", tag: "test", kind: "message", botId: "" }, { priority: "normal" })
        : { sent: 0, failed: 0, removed: 0 };
      send(res, 200, { ok: result.sent > 0, devices, ...result });
      return;
    }

    if (method === "GET" && pathname === "/api/notifications") {
      send(res, 200, { items: notifications.list({ limit: Math.min(500, Number(url.searchParams.get("limit")) || 100) }), unread: notifications.unreadCount() });
      return;
    }
    if (method === "POST" && pathname === "/api/notifications/read") {
      const body = await readBody(req);
      const ids = body.ids === "all" ? "all" : Array.isArray(body.ids) ? body.ids.map(String) : [];
      notifications.markRead(ids);
      send(res, 200, { ok: true, unread: notifications.unreadCount() });
      return;
    }
    if (pathname === "/api/notify-settings" && (method === "GET" || method === "PUT")) {
      if (method === "PUT") {
        const body = await readBody(req);
        for (const key of ["quietStart", "quietEnd"]) {
          if (body[key] !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(body[key]).trim())) {
            throw httpError("Use HH:MM for quiet hours, for example 23:00.", 400);
          }
        }
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw httpError("Enabled must be true or false.", 400);
        state.settings = { ...state.settings, notify: normalizeNotifySettings({ ...state.settings?.notify, ...body }) };
        saveState(home, state);
      }
      send(res, 200, normalizeNotifySettings(state.settings?.notify));
      return;
    }

    // The Memory page (P0.7): the vault's git log, one commit's diff, Revert, notes with backlinks.
    if (method === "GET" && pathname === "/api/memory") {
      const dir = vault?.available ? vault.dir : "";
      send(res, 200, {
        available: Boolean(vault?.available),
        writes: Boolean(writer?.available),
        history: hasHistory(dir),
        notes: vault?.available ? vault.status().notes : 0,
        obsidian: obsidianName(),
        owner: ownerLabel(ownerOf(state)),
        authors: await vaultAuthors(dir).catch(() => []),
        proposals: proposals.list({ status: "open" }).filter((item) => item.kind === "vault"),
        sync: writer ? writer.status() : null,
      });
      return;
    }
    if (method === "GET" && pathname === "/api/memory/log") {
      if (!vault?.available) throw httpError("The shared vault is not configured on this server.", 404);
      let page;
      try {
        page = await vaultLog(vault.dir, { agent: url.searchParams.get("agent") || "", note: url.searchParams.get("note") || "", before: url.searchParams.get("before") || "", limit: url.searchParams.get("limit") || 50 });
      } catch (error) {
        throw httpError(error.message, 400);
      }
      send(res, 200, { ...page, items: page.items.map(memoryEntry) });
      return;
    }
    const memoryCommit = pathname.match(/^\/api\/memory\/commits\/([0-9a-fA-F]{7,40})(\/revert)?$/);
    if (memoryCommit && method === "GET" && !memoryCommit[2]) {
      if (!vault?.available) throw httpError("The shared vault is not configured on this server.", 404);
      const found = await vaultCommit(vault.dir, memoryCommit[1]);
      if (!found) throw httpError("That commit is not in the vault.", 404);
      send(res, 200, { ...memoryEntry(found), body: found.body, diff: found.diff, truncated: found.truncated, onBranch: found.onBranch, revertedBy: found.revertedBy, canRevert: Boolean(writer?.available) && found.onBranch && !found.merge && !found.root && !found.revertedBy });
      return;
    }
    if (memoryCommit && method === "POST" && memoryCommit[2]) {
      if (!writer?.available) throw httpError("Vault writing is not enabled on this server.", 409);
      const body = await readBody(req);
      const result = await writer.revert(memoryCommit[1], { name: ownerLabel(ownerOf(state)), note: typeof body.note === "string" ? body.note : "" });
      if (!result.ok) throw httpError(result.error, 409);
      send(res, 200, result);
      return;
    }
    if (method === "GET" && pathname === "/api/memory/notes") {
      if (!vault?.available) throw httpError("The shared vault is not configured on this server.", 404);
      send(res, 200, { items: vault.notes(url.searchParams.get("prefix") || "").map((note) => ({ path: note.path, title: note.title, date: note.date })) });
      return;
    }
    if (method === "GET" && pathname === "/api/memory/note") {
      if (!vault?.available) throw httpError("The shared vault is not configured on this server.", 404);
      const wanted = url.searchParams.get("path") || "";
      if (!validNotePath(wanted)) throw httpError("That is not a vault note.", 400);
      const found = vault.read(wanted);
      if (!found || found.path !== wanted) throw httpError("No vault note at that path.", 404);
      send(res, 200, { ...found, obsidian: obsidianLink(found.path) });
      return;
    }
    if (method === "PUT" && pathname === "/api/memory/obsidian") {
      const body = await readBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length > 120 || /[\\/]/.test(name)) throw httpError("Give the vault's name as Obsidian shows it.", 400);
      state.settings = { ...state.settings, obsidian: name };
      saveState(home, state);
      send(res, 200, { obsidian: obsidianName() });
      return;
    }
    // Export everything to one archive; secrets only under a passphrase (server/backup.js).
    if (method === "POST" && pathname === "/api/backup/export") {
      const body = await readBody(req);
      const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
      const problem = checkPassphrase(passphrase);
      if (problem) throw httpError(problem, 400);
      // Holds the vault writer for the whole export, so the bundle and the state match.
      const build = () => {
        saveState(home, state);
        return exportArchive({ home, secrets, vaultDir: vault?.available ? vault.dir : vaultSetup?.dir || "", passphrase, workspaces: body.workspaces === true, version: APP_VERSION });
      };
      const archive = writer?.available ? await writer.exclusive(build) : await build();
      res.on("close", archive.cleanup);
      res.writeHead(200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="${archive.name}"`, "content-length": fs.statSync(archive.file).size, "cache-control": "no-store", "x-ravnir-backup": JSON.stringify({ bots: archive.manifest.bots.length, vault: archive.manifest.vault, secrets: archive.manifest.secrets }) });
      fs.createReadStream(archive.file).pipe(res);
      return;
    }
    // Restore into an install with no agents yet, then restart so every agent is set up again.
    if (method === "POST" && pathname === "/api/backup/restore") {
      if (state.bots.length) throw httpError("This install already has agents. Restore into a fresh install.", 409);
      const upload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-upload-")), "backup.tar.gz");
      try {
        await saveStream(req, upload, 2 * 1024 * 1024 * 1024);
        const passphrase = (() => {
          try {
            return decodeURIComponent(String(req.headers["x-ravnir-passphrase"] || ""));
          } catch {
            return "";
          }
        })();
        let result;
        try {
          result = await restoreArchive({ file: upload, home, passphrase, secrets, vaultDir: vaultSetup?.local ? vaultSetup.dir : vault?.available ? vault.dir : "" });
        } catch (error) {
          if (error instanceof BackupError) throw httpError(error.message, 400);
          throw error;
        }
        // The running server keeps the restored state, so nothing saves the old one over it.
        const restored = loadState({ home, secrets, projectRoot });
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, restored);
        saveState(home, state);
        const restart = supervised();
        send(res, 200, { ...result, restart: restart ? "now" : "manual" });
        if (restart) {
          setTimeout(() => {
            const done = () => process.exit(75);
            setTimeout(done, 6_000).unref();
            managedOpenCode.stop().then(done, done);
          }, 500).unref();
        }
      } finally {
        fs.rmSync(path.dirname(upload), { recursive: true, force: true });
      }
      return;
    }
    const turnRow = pathname.match(/^\/api\/turns\/([\w-]{1,80})$/);
    if (method === "GET" && turnRow) {
      const row = ledger.get(turnRow[1]);
      if (!row) throw httpError("No turn with that id in the last 45 days.", 404);
      send(res, 200, { id: row.id, botId: row.botId, botName: row.botName, at: row.at, source: row.source, status: row.status, prompt: row.prompt, summary: row.summary, usage: row.usage, model: row.model, provider: row.provider, jobName: row.jobName || "", ...(row.fallbacks ? { fallbacks: row.fallbacks } : {}), ...(row.asks !== undefined ? { asks: row.asks } : {}) });
      return;
    }
    // Everything one reply can show as proof: sources, tool actions, file changes, approvals,
    // screenshots and the vault commits it wrote. Read on demand so the thread stays small.
    const turnProof = pathname.match(/^\/api\/turns\/([\w-]{1,80})\/proof$/);
    if (method === "GET" && turnProof) {
      const row = ledger.get(turnProof[1]);
      if (!row) throw httpError("No turn with that id in the last 45 days.", 404);
      const bot = state.bots.find((item) => item.id === row.botId);
      if (!bot) throw httpError("That agent no longer exists.", 404);
      const conversation = readConversation(home, bot);
      const reply = [...conversation].reverse().find((message) => message.role === "assistant" && message.turnId === turnProof[1]);
      const proof = await buildProof({ turnId: turnProof[1], ledger, eventLog, approvals, vault, bot, sources: reply?.sources || [] });
      if (!proof) throw httpError("No proof for that turn.", 404);
      send(res, 200, proof);
      return;
    }

    if (method === "GET" && pathname === "/api/proposals") {
      const status = url.searchParams.get("status") || "";
      send(res, 200, { items: status === "open" ? openProposals() : proposals.list(status ? { status } : {}) });
      return;
    }
    const proposalMatch = pathname.match(/^\/api\/proposals\/([^/]+)$/);
    if (method === "POST" && proposalMatch) {
      const body = await readBody(req);
      const decision = String(body.decision || "");
      if (decision !== "accept" && decision !== "dismiss") throw httpError("Decision must be accept or dismiss.", 400);
      const found = proposals.get(proposalMatch[1]);
      if (!found) throw httpError("Unknown suggestion.", 404);
      if (found.status !== "open") throw httpError("That suggestion was already answered.", 409);
      const target = state.bots.find((item) => item.id === found.botId);
      if (found.kind === "vault" && decision === "accept") {
        if (!writer?.available) throw httpError("Vault writing is not enabled on this server.", 409);
        const applied = await writer.applyProposal(found);
        if (!applied.ok) throw httpError(applied.error, 409);
        const record = proposals.decide(found.id, decision);
        markNoticeRead(`proposal-${found.id}`);
        send(res, 200, { ok: true, proposal: record, commit: applied.commit, turnId: "" });
        return;
      }
      if (decision === "accept" && !target) throw httpError("That agent no longer exists.", 404);
      // An agent that asked for a skill or a plugin gets it; nothing runs.
      if ((found.kind === "skill" || found.kind === "plugin") && decision === "accept") {
        const given = found.kind === "skill" ? giveSkill(target, found.change?.skill) : await givePlugin(target, found.change?.plugin);
        const record = proposals.decide(found.id, decision) || proposals.get(found.id);
        markNoticeRead(`proposal-${found.id}`);
        send(res, 200, { ok: true, proposal: record, turnId: "", ...given });
        return;
      }
      const record = proposals.decide(found.id, decision);
      if (!record) throw httpError("That suggestion was already answered.", 409);
      markNoticeRead(`proposal-${record.id}`);
      let turnId = "";
      if (decision === "accept") {
        const queued = engine.enqueue(target, { text: `Approved suggestion: ${record.title}\n\n${record.prompt}`, source: "proposal" });
        queued.promise.catch(() => {});
        turnId = queued.turnId;
      }
      send(res, 200, { ok: true, proposal: record, turnId });
      return;
    }

    if (method === "GET" && pathname === "/api/import/prompt") {
      send(res, 200, { prompt: exportPrompt() });
      return;
    }
    if (method === "POST" && (pathname === "/api/import/preview" || pathname === "/api/import/apply")) {
      const body = await readBody(req, 4_500_000);
      let items;
      try {
        items = parseExport(body.text);
      } catch (error) {
        throw httpError(error.message, 400);
      }
      if (pathname === "/api/import/preview") {
        send(res, 200, { items: planImport(state, items) });
        return;
      }
      const result = await applyImport({
        state,
        items,
        enableRoutines: body.enableRoutines === true,
        createBot: createImportedBot,
        touch: touchBot,
        aiMemory,
      });
      ensureGroups(state);
      saveState(home, state);
      for (const imported of result.bots) {
        const target = state.bots.find((item) => item.id === imported.id);
        if (target) syncOpenCodeConfig(target);
      }
      send(res, 200, result);
      return;
    }
    if (method === "POST" && pathname === "/api/schedule/preview") {
      const body = await readBody(req);
      try {
        send(res, 200, previewSchedule({ cron: body.cron, at: body.at }));
      } catch (error) {
        throw httpError(error.message, 400);
      }
      return;
    }

    // Voice mode. ElevenLabs, once connected in Settings, listens and speaks.
    // Otherwise speech goes to the server only when RAVNIR_STT_URL / RAVNIR_TTS_URL
    // are set, and the browser does the rest.
    if (method === "GET" && pathname === "/api/voice/config") {
      if (elevenLabs.connected()) send(res, 200, { ...voiceConfig(), stt: "server", tts: "server", live: "elevenlabs", provider: "elevenlabs", voices: [], voice: "" });
      else send(res, 200, voiceConfig());
      return;
    }
    if (method === "GET" && pathname === "/api/voice/elevenlabs") {
      send(res, 200, await elevenLabs.status());
      return;
    }
    if (method === "PUT" && pathname === "/api/voice/elevenlabs") {
      const body = await readBody(req, 4000);
      if (body.apiKey !== undefined) {
        send(res, 200, await elevenLabs.connect(body.apiKey));
        return;
      }
      elevenLabs.setVoice(body.voice);
      send(res, 200, await elevenLabs.status());
      return;
    }
    if (method === "DELETE" && pathname === "/api/voice/elevenlabs") {
      elevenLabs.disconnect();
      send(res, 200, await elevenLabs.status());
      return;
    }
    if (method === "POST" && pathname === "/api/voice/realtime") {
      const body = await readBody(req, 1000);
      send(res, 200, await elevenLabs.realtimeUrl({ lang: body.lang }));
      return;
    }
    if (method === "POST" && pathname === "/api/voice/transcribe") {
      const audio = await readAudio(req);
      const type = req.headers["content-type"] || "";
      const lang = url.searchParams.get("lang") || "";
      if (elevenLabs.connected()) send(res, 200, await elevenLabs.transcribe({ audio, type: baseType(type) || "audio/webm", name: audioFileName(type), lang }));
      else send(res, 200, await transcribe({ audio, type, lang }));
      return;
    }
    if (method === "POST" && pathname === "/api/voice/speak") {
      const body = await readBody(req, 16_000);
      if (typeof body.text !== "string" || !body.text.trim()) throw httpError("Text is required.", 400);
      const audio = elevenLabs.connected()
        ? await elevenLabs.speak({ text: body.text, lang: body.lang })
        : await speak({ text: body.text, voice: body.voice, lang: body.lang });
      const type = audio.headers.get("content-type") || "";
      res.writeHead(200, { "content-type": /^audio\//.test(type) ? type : "audio/mpeg", "cache-control": "no-store" });
      await pipeline(Readable.fromWeb(audio.body), res).catch(() => res.destroy());
      return;
    }

    if (method === "GET" && pathname === "/api/onepassword") {
      send(res, 200, await onePassword.status({ fresh: url.searchParams.get("fresh") === "1" }));
      return;
    }
    if (method === "GET" && pathname === "/api/onepassword/items") {
      send(res, 200, { items: await onePassword.listLogins(url.searchParams.get("q") || "") });
      return;
    }
    if (method === "POST" && pathname === "/api/onepassword/token") {
      const body = await readBody(req);
      const token = String(body.token || "").trim();
      if (!token) throw httpError("Paste a 1Password service account token.", 400);
      if (token.length > 4000) throw httpError("That token is too long.", 400);
      secrets.set("server:onepasswordToken", token);
      onePassword.clearCache();
      send(res, 200, await onePassword.status({ fresh: true }));
      return;
    }
    if (method === "DELETE" && pathname === "/api/onepassword/token") {
      secrets.delete("server:onepasswordToken");
      onePassword.clearCache();
      send(res, 200, await onePassword.status({ fresh: false }));
      return;
    }
    if (method === "POST" && pathname === "/api/pins") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      let order = 1;
      for (const id of ids) {
        const target = state.bots.find((item) => item.id === id);
        if (!target) continue;
        target.pinned = true;
        target.pinnedOrder = order;
        order += 1;
      }
      saveState(home, state);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && pathname === "/api/groups") {
      send(res, 200, { groups: ensureGroups(state).map((group) => publicGroup(group, state.bots)) });
      return;
    }
    if (method === "POST" && pathname === "/api/groups") {
      const body = await readBody(req);
      const result = badRequest(() => createGroup(state, body.name));
      saveState(home, state);
      send(res, result.created ? 201 : 200, { group: publicGroup(result.group, state.bots), created: result.created });
      return;
    }
    const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const group = state.groups.find((item) => item.id === groupMatch[1]);
      if (!group) throw httpError("Unknown group.", 404);
      if (method === "PATCH") {
        const body = await readBody(req);
        badRequest(() => renameGroup(state, group.id, body.name));
        saveState(home, state);
        send(res, 200, { group: publicGroup(group, state.bots) });
        return;
      }
      if (method === "DELETE") {
        const result = badRequest(() => deleteGroup(state, group.id));
        saveState(home, state);
        send(res, 200, { ok: true, ...result });
        return;
      }
    }
    if (method === "GET" && pathname === "/api/discover") {
      const found = await discoverServers();
      const oc = models.opencode();
      // The server's own OpenCode is already connected: no password to ask for.
      for (const server of found.servers || []) {
        if (oc && server.kind === "opencode" && sameUrl(server.baseUrl, oc.baseUrl)) {
          server.authRequired = false;
          server.connected = true;
          server.name = "OpenCode on this server";
          server.note = "Connected. Agents use it without a password.";
        }
      }
      found.servers?.sort((a, b) => Number(Boolean(b.connected)) - Number(Boolean(a.connected)));
      send(res, 200, found);
      return;
    }
    // Settings, Models: this server's OpenCode, provider sign-in and OpenAI-compatible servers.
    if (pathname === "/api/models/catalog" && method === "GET") {
      send(res, 200, await models.catalog({ fresh: url.searchParams.get("fresh") === "1" }));
      return;
    }
    if (pathname === "/api/models/list" && method === "GET") {
      send(res, 200, await models.list());
      return;
    }
    if (pathname === "/api/models/opencode" && method === "POST") {
      const body = await readBody(req);
      send(res, 200, { opencode: await models.connectOpenCode(body) });
      return;
    }
    const providerMatch = pathname.match(/^\/api\/models\/providers\/([^/]+)(\/key|\/oauth\/start|\/oauth\/finish)?$/);
    if (providerMatch) {
      const id = decodeURIComponent(providerMatch[1]);
      const action = providerMatch[2] || "";
      if (method === "DELETE" && !action) {
        send(res, 200, await models.signOut(id));
        return;
      }
      if (method === "POST" && action) {
        const body = await readBody(req);
        if (action === "/key") send(res, 200, await models.setKey(id, body));
        else if (action === "/oauth/start") send(res, 200, await models.oauthStart(id, body));
        else {
          // Device-code sign-in: this request stays open until the person finishes on the provider's site.
          req.setTimeout?.(11 * 60_000);
          res.setTimeout?.(11 * 60_000);
          const gone = new AbortController();
          res.on("close", () => { if (!res.writableEnded) gone.abort(); });
          send(res, 200, await models.oauthFinish(id, body, { signal: gone.signal }));
        }
        return;
      }
    }
    if (pathname === "/api/models/servers" && method === "POST") {
      const body = await readBody(req);
      send(res, 201, await models.addServer(body));
      return;
    }
    const serverMatch = pathname.match(/^\/api\/models\/servers\/([A-Za-z0-9-]+)$/);
    if (serverMatch && method === "DELETE") {
      send(res, 200, models.removeServer(serverMatch[1]));
      return;
    }
    if (method === "POST" && pathname === "/api/models") {
      const body = await readBody(req);
      send(res, 200, await probeModels(body));
      return;
    }
    if (method === "POST" && pathname === "/api/bots") {
      const body = await readBody(req);
      send(res, 201, detail(addBot(body)));
      return;
    }

    if (method === "GET" && pathname === "/api/approvals") {
      send(res, 200, { pending: approvals.pending(), recent: approvals.since(shiftDays(startOfDay(), -7)).filter((item) => item.status !== "pending").reverse() });
      return;
    }
    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (method === "POST" && approvalMatch) {
      const body = await readBody(req);
      if (!engine.decide(approvalMatch[1], String(body.decision || "reject"))) throw httpError("That request was already answered or has expired.", 409);
      send(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/plugins" || pathname.startsWith("/api/plugins/")) {
      const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
      const out = await plugins.api({ method, pathname, body, req });
      send(res, out.status || 200, out.body);
      return;
    }
    if (method === "GET" && pathname === "/api/today") {
      send(res, 200, todayFeed(url.searchParams.get("day") || ""));
      return;
    }
    if (method === "GET" && pathname === "/api/usage") {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
      const from = shiftDays(startOfDay(), -(days - 1));
      send(res, 200, {
        days,
        total: ledger.totals(ledger.between(from)),
        models: ledger.byModel(ledger.between(from)),
        bots: state.bots.map((bot) => ({
          botId: bot.id,
          name: bot.name,
          limits: bot.limits,
          model: bot.model.model || "",
          provider: bot.model.provider || "",
          today: ledger.spentToday(bot.id),
          total: ledger.totals(ledger.between(from, Infinity, bot.id)),
          daily: ledger.daily(bot.id, days),
          models: ledger.byModel(ledger.between(from, Infinity, bot.id)),
        })),
      });
      return;
    }

    const botMatch = pathname.match(/^\/api\/bots\/([^/]+)(\/.*)?$/);
    if (!botMatch) throw httpError("Not found.", 404);
    const bot = findBot(botMatch[1]);
    const rest = botMatch[2] || "";

    if (method === "POST" && rest === "/mcp") {
      const token = secrets.get(`bot:${bot.id}:mcpToken`, "");
      const body = await readBody(req, 2_000_000);
      const result = await handleBuiltinMcp({
        body,
        bot,
        token,
        header: req.headers.authorization,
        ctx: {
          vaultOn: Boolean(vault?.available),
          writeOn: Boolean(writer?.available),
          // The same list the built-in loop offers this bot (Jev, chooser and desktop rules included).
          toolDefs: (targetBot) => builtinToolsFor(targetBot, { browser, vault, vaultWriter: writer, plugins }),
          pluginTools: (targetBot) => plugins.builtinTools(targetBot),
          // Calls go through the turn's attempt tracker (server/asks.js), like the built-in loop's.
          callPlugin: (targetBot, tool, args) => engine.tracked(targetBot.id, tool.name, args, async () => {
            try {
              return await plugins.callBuiltin(targetBot, tool, args);
            } catch (error) {
              if (error.approvalBudget) engine.stop(targetBot.id);
              throw error;
            }
          }),
          callBuiltin: (targetBot, name, args) => engine.tracked(targetBot.id, name, args, async () => {
            try {
              await guardTool(name, args, {
                bot: targetBot,
                approvals: engine.approvalGate(targetBot),
                signal: engine.active.get(targetBot.id)?.abort.signal,
                meta: engine.approvalMeta(targetBot.id),
                onPolicyChange: (changed) => {
                  saveState(home, state);
                  syncOpenCodeConfig(changed);
                },
                mac,
              });
            } catch (error) {
              if (error.approvalBudget) engine.stop(targetBot.id);
              throw error;
            }
            const result = await callBuiltinTool(name, args, {
              bot: targetBot,
              home,
              browser,
              secrets,
              workspace: workspacePath(home, targetBot),
              state,
              engine,
              live,
              aiMemory,
              vault,
              vaultWriter: writer,
              plugins,
              notifications,
              proposals,
              asks,
              mac,
              // The bots already in this exchange, so message_bot through OpenCode refuses loops too.
              chain: engine.currentChain(targetBot.id),
              provisionBot,
              passwordFor,
              compact: (target) => engine.compact(target),
              emit: (event) => eventLog.append(targetBot, { ...event, botId: targetBot.id, at: event.at || Date.now() }),
              save: () => saveState(home, state),
            });
            // A tool that called a model itself (the computer chooser) adds its tokens to the running turn.
            if (result.usage) engine.addToolUsage(targetBot.id, result.usage);
            return result;
          }),
        },
      });
      if (result.empty) {
        res.writeHead(result.status);
        res.end();
        return;
      }
      send(res, result.status, result.json);
      return;
    }

    if (method === "GET" && rest === "") {
      send(res, 200, detail(bot));
      return;
    }
    if (method === "PATCH" && rest === "") {
      const body = await readBody(req);
      validateBotFields(body);
      if (typeof body.name === "string") {
        // Same rule as the agents' update_bot tool: a rename may not take another agent's name.
        const nextName = body.name.replace(/\s+/g, " ").trim().slice(0, 40);
        if (nextName && state.bots.some((item) => item.id !== bot.id && item.name.toLowerCase() === nextName.toLowerCase())) {
          throw httpError(`Another agent is already called ${nextName}.`, 409);
        }
      }
      if (typeof body.name === "string") bot.name = body.name.replace(/\s+/g, " ").trim().slice(0, 40) || bot.name;
      if (typeof body.job === "string") bot.job = body.job.replace(/\s+/g, " ").trim().slice(0, 300) || bot.job;
      if (typeof body.group === "string") bot.group = body.group.replace(/\s+/g, " ").trim().slice(0, 40) || "Personal";
      if (typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)) bot.color = body.color;
      if (body.avatar && typeof body.avatar === "object" && !Array.isArray(body.avatar)) {
        bot.avatar = normalizeAvatar(body.avatar, bot.id);
      }
      if (typeof body.prompt === "string") {
        if (body.prompt.length > 32_000) throw httpError("Instructions are too long.", 400);
        bot.prompt = body.prompt;
      }
      if (body.model && typeof body.model === "object") {
        const previous = { ...bot.model };
        const choice = models.resolveChoice(body.model);
        bot.model = choice
          ? { ...bot.model, ...normalizeIncomingModel(choice) }
          : { ...bot.model, ...normalizeIncomingModel(body.model, bot.model) };
        if (choice && !choice.connection) delete bot.model.connection;
        // A picked model runs on the connection's credential; an old per-agent password would shadow it.
        if (choice) {
          secrets.delete(`bot:${bot.id}:apiKey`);
          bot.model.apiKeySet = false;
        }
        if (typeof body.model.apiKey === "string" && body.model.apiKey) {
          secrets.set(`bot:${bot.id}:apiKey`, body.model.apiKey);
          bot.model.apiKeySet = true;
        }
        if (body.model.clearApiKey === true) {
          secrets.delete(`bot:${bot.id}:apiKey`);
          bot.model.apiKeySet = false;
        }
        if (previous.provider !== bot.model.provider || previous.baseUrl !== bot.model.baseUrl) bot.remote = {};
        if (body.model.fallbacks !== undefined) bot.model.fallbacks = resolveFallbacks(body.model.fallbacks, bot.model);
      }
      if (body.policy && typeof body.policy === "object" && !Array.isArray(body.policy)) {
        bot.policy = normalizePolicy({ ...bot.policy, ...body.policy });
      }
      if (body.limits && typeof body.limits === "object" && !Array.isArray(body.limits)) {
        bot.limits = normalizeLimits({ ...bot.limits, ...body.limits });
      }
      if (body.notify !== undefined) {
        if (!NOTIFY_LEVELS.includes(body.notify)) throw httpError("Notifications must be all, important, or off.", 400);
        bot.notify = body.notify;
      }
      if (body.status !== undefined) {
        if (body.status !== "on" && body.status !== "off") throw httpError("Status must be on or off.", 400);
        const next = normalizeBotStatus(body.status);
        if (next !== normalizeBotStatus(bot.status)) {
          bot.status = next;
          appendActivity(bot, next === "off" ? "Paused. Routines and messages from other agents wait until it is back on." : "Back on");
        }
      }
      if (Array.isArray(body.skills)) {
        const found = discoverSkills();
        const extra = new Set(found.filter((entry) => !entry.default).map((entry) => entry.name));
        const next = normalizeSkills(body.skills);
        // More than this would push the default skills (documents) out of the agent's index.
        if (next.filter((name) => extra.has(name)).length > skillRoom(found)) throw httpError(`An agent can hold at most ${skillRoom(found)} skills besides the built-in ones.`, 400);
        bot.skills = next;
      }
      if (body.vaultNote !== undefined) bot.vaultNote = normalizeVaultNote(body.vaultNote);
      if (body.vaultProjects !== undefined) bot.vaultProjects = normalizeVaultProjects(body.vaultProjects);
      if (body.pinned !== undefined) {
        bot.pinned = Boolean(body.pinned);
        if (bot.pinned && !bot.pinnedOrder) {
          const highest = state.bots.reduce((max, item) => Math.max(max, Number(item.pinnedOrder) || 0), 0);
          bot.pinnedOrder = highest + 1;
        }
      }
      if (body.pinnedOrder !== undefined && Number.isFinite(Number(body.pinnedOrder))) {
        bot.pinnedOrder = Number(body.pinnedOrder);
      }
      if (body.main === true) {
        for (const item of state.bots) item.main = item.id === bot.id;
      } else if (body.main === false && bot.main) {
        bot.main = false;
      }
      if (body.browser !== undefined) {
        const next = normalizeBrowserNetwork(body.browser);
        const key = `bot:${bot.id}:browserProxy`;
        if (body.browser?.proxy !== undefined) {
          const raw = String(body.browser.proxy || "").trim();
          if (raw) {
            try {
              parseProxyUrl(raw);
            } catch (error) {
              throw httpError(error.message, 400);
            }
            secrets.set(key, raw);
          } else secrets.delete(key);
        }
        if (next.route === "proxy" && !secrets.get(key, "")) throw httpError("Enter the proxy address first.", 400);
        if (next.route !== normalizeBrowserNetwork(bot.browser).route || body.browser?.proxy !== undefined) {
          if (engine.status(bot.id).busy) throw httpError("Stop the running turn before changing where the browser opens sites from.", 409);
          // The route is part of how the browser starts, so it starts again on its next use.
          await live.reset(bot);
          await browser.close(bot.id);
          bot.browser = next;
          const words = { auto: "this server, and the Mac for sites that block it", mac: "the Mac", proxy: "its proxy", direct: "this server only" };
          appendActivity(bot, `Opens sites from ${words[next.route]}`);
        }
      }
      if (body.box !== undefined) {
        const next = normalizeBox(body.box);
        if (next.mode === "container" && !box.enabled) throw httpError("Own computers are off on this server. Set RAVNIR_BOX to podman or docker.", 409);
        if (next.mode !== normalizeBox(bot.box).mode) {
          if (engine.status(bot.id).busy) throw httpError("Stop the running turn before switching computers.", 409);
          // The browser profile moves with the bot, so the old browser must let go of it.
          await live.reset(bot);
          await browser.close(bot.id);
          await desktop.close(bot.id);
          terminals.close(bot.id);
          bot.box = next;
          appendActivity(bot, next.mode === "container" ? "Switched to its own computer" : "Switched to this server's computer");
        }
      }
      touchBot(bot);
      ensureGroups(state);
      saveState(home, state);
      syncOpenCodeConfig(bot);
      send(res, 200, detail(bot));
      return;
    }
    if (method === "DELETE" && rest === "") {
      if (engine.status(bot.id).busy) throw httpError("Stop the running turn before deleting this bot.", 409);
      await live.reset(bot);
      await browser.close(bot.id);
      await desktop.close(bot.id);
      terminals.close(bot.id);
      if (box.enabled) await box.reset(bot).catch(() => {});
      network.forget(bot.id);
      secrets.delete(`bot:${bot.id}:browserProxy`);
      await mcp.closeBot(bot);
      plugins.forgetBot(bot.id);
      asks.forget(bot.id);
      state.bots = state.bots.filter((item) => item.id !== bot.id);
      saveState(home, state);
      try {
        fs.rmSync(botHome(home, bot), { recursive: true, force: true });
      } catch {
        // The bot is gone from the app even if a file is locked.
      }
      send(res, 200, { ok: true });
      return;
    }
    if (rest === "/spec" || rest === "/spec/apply" || rest === "/spec/dismiss") {
      if (method === "GET" && rest === "/spec") {
        checkSpec(bot);
        send(res, 200, specView(home, bot));
        return;
      }
      try {
        if (method === "PUT" && rest === "/spec") linkSpec(home, bot, (await readBody(req)).path);
        else if (method === "POST" && rest === "/spec/apply") applySpec(home, bot);
        else if (method === "POST" && rest === "/spec/dismiss") dismissSpec(bot);
        else if (method === "DELETE" && rest === "/spec") unlinkSpec(home, bot);
        else throw httpError("Not found.", 404);
      } catch (error) {
        throw error.status ? error : httpError(error.message, 400);
      }
      touchBot(bot);
      saveState(home, state);
      eventLog.append(bot, { type: "spec", status: bot.spec?.status || "unlinked", path: bot.spec?.path || "" });
      send(res, 200, { view: specView(home, bot), detail: detail(bot) });
      return;
    }
    if (method === "POST" && rest === "/voice/reply") {
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw httpError("Text is required.", 400);
      if (text.length > 20_000) throw httpError("Message is too long.", 400);
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const quick = quickConfig({ ...bot, model: { ...bot.model, apiKey: models.keyFor(bot) } });
      try {
        await voiceReply({ bot, text, engine, home, quick, signal: abort.signal, startTimeoutMs: Number(process.env.RAVNIR_VOICE_START_MS) || undefined, write: (line) => { if (!res.writableEnded) res.write(`${JSON.stringify(line)}\n`); } });
      } catch (error) {
        if (!res.writableEnded) res.write(`${JSON.stringify({ type: "error", error: error.message || "Voice reply failed." })}\n`);
      }
      res.end();
      return;
    }
    if (method === "POST" && rest === "/uploads") {
      const name = (() => {
        try {
          return decodeURIComponent(String(req.headers["x-file-name"] || "file"));
        } catch {
          return "file";
        }
      })();
      const item = await saveUpload({ workspace: workspacePath(home, bot), req, name });
      send(res, 201, { ...publicAttachment(item), url: `/api/bots/${bot.id}/uploads/${item.id.split("/").map(encodeURIComponent).join("/")}` });
      return;
    }
    const uploadMatch = rest.match(/^\/uploads\/([^/]+)\/([^/]+)$/);
    if ((method === "GET" || method === "HEAD") && uploadMatch) {
      let id = "";
      try {
        id = `${decodeURIComponent(uploadMatch[1])}/${decodeURIComponent(uploadMatch[2])}`;
      } catch {
        throw httpError("Not found.", 404);
      }
      const item = findUpload(workspacePath(home, bot), id);
      if (!item) throw httpError("Not found.", 404);
      serveUpload(res, item);
      return;
    }
    if (method === "POST" && rest === "/messages") {
      const body = await readBody(req);
      if (typeof body.text !== "string") throw httpError("Message text is required.", 400);
      if (body.text.length > 100_000) throw httpError("Message is too long.", 400);
      const ids = Array.isArray(body.attachments) ? body.attachments : [];
      if (ids.length > MAX_ATTACHMENTS) throw httpError(`Up to ${MAX_ATTACHMENTS} files per message.`, 400);
      const attachments = ids.map((id) => {
        const item = findUpload(workspacePath(home, bot), id);
        if (!item) throw httpError("An attached file is missing. Attach it again.", 400);
        return publicAttachment(item);
      });
      const text = body.text.trim();
      if (!text && !attachments.length) throw httpError("Message text is required.", 400);
      const mentions = parseMentions(text, state.bots, bot.id);
      // A message spoken in voice mode is marked, so the thread can show it. The marker never reaches the model.
      // Home answers one question by its id (server/asks.js); a plain message answers all that are open.
      const answers = Array.isArray(body.answers) ? body.answers.filter((id) => typeof id === "string").slice(0, 10) : [];
      const result = engine.enqueue(bot, { text, attachments, source: "chat", mentions, via: body.via === "voice" ? "voice" : "", ...(answers.length ? { answers } : {}) });
      result.promise.catch(() => {});
      if (mentions.length) result.promise.then(() => routeMentions(bot, text, mentions)).catch(() => {});
      send(res, 202, { ok: true, turnId: result.turnId, mentions, runtime: engine.status(bot.id) });
      return;
    }
    if (method === "GET" && rest === "/events") {
      const after = Number(url.searchParams.get("after") || 0);
      if (url.searchParams.get("watching") === "1") {
        watching.set(bot.id, Date.now());
        // Looking at the thread is reading its replies.
        const seen = notifications.list({ limit: 500 }).filter((item) => item.botId === bot.id && item.kind === "turn" && !item.read).map((item) => item.id);
        if (seen.length) notifications.markRead(seen);
      }
      send(res, 200, { ...eventLog.read(bot, after), runtime: engine.status(bot.id) });
      return;
    }
    if (method === "POST" && rest === "/compact") {
      const result = await engine.compact(bot, { force: true });
      send(res, 200, { ok: true, ...result });
      return;
    }
    if (method === "POST" && rest === "/stop") {
      send(res, 200, { ok: engine.stop(bot.id) });
      return;
    }
    if (rest === "/card" || rest === "/card/stop") {
      if (method === "POST" && rest === "/card") {
        const body = await readBody(req, 10_000);
        cards.start(bot, { runs: body.runs });
      } else if (method === "POST" && rest === "/card/stop") {
        if (!cards.stop(bot.id)) throw httpError("No card is running for this agent.", 409);
      } else if (method !== "GET") throw httpError("Not found.", 404);
      const history = cards.list(bot.id);
      // The task list lives with the evals; loaded on first use so a plain start does not pay for it.
      const cardTaskCount = (await import("../evals/card.mjs")).cardTaskList().length;
      send(res, 200, {
        latest: history[0] || null,
        history: history.map((card) => ({ startedAt: card.startedAt, overall: card.overall, model: card.model, skills: card.skills, cost: card.cost, axes: card.axes.map((axis) => ({ id: axis.id, score: axis.score })) })),
        running: cards.status(bot.id),
        lastError: cards.lastError?.botId === bot.id ? cards.lastError : null,
        estimate: cards.estimate(bot, cardTaskCount, ledger.between(shiftDays(startOfDay(), -29), Infinity, bot.id)),
        skills: bot.skills || [],
        model: bot.model?.model || "",
      });
      return;
    }
    if (method === "POST" && rest === "/permission") {
      const body = await readBody(req);
      if (typeof body.requestID !== "string") throw httpError("requestID is required.", 400);
      const accepted = engine.decide(body.requestID, String(body.response || "reject"));
      if (!accepted) throw httpError("That permission request has expired.", 409);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "DELETE" && rest === "/conversation") {
      if (engine.status(bot.id).busy) throw httpError("Stop the running turn first.", 409);
      writeConversation(home, bot, []);
      asks.closeFor(bot.id);
      // The archive holds the same messages, so search_history could bring them back.
      fs.rmSync(archivePath(home, bot), { force: true });
      writeDiffs(home, bot, []);
      bot.remote = {};
      bot.stats.turns = 0;
      bot.stats.lastError = "";
      touchBot(bot);
      saveState(home, state);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && rest === "/memory") {
      const body = await readBody(req);
      const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 600);
      if (!text) throw httpError("Memory text is required.", 400);
      if (!bot.memory.some((item) => item.text.toLowerCase() === text.toLowerCase())) {
        bot.memory.push({ id: crypto.randomUUID(), text, at: Date.now(), source: "user" });
        bot.memory = bot.memory.slice(-80);
      }
      touchBot(bot);
      saveState(home, state);
      send(res, 200, { ok: true, memory: bot.memory });
      return;
    }
    const memoryMatch = rest.match(/^\/memory\/([^/]+)$/);
    if (method === "DELETE" && memoryMatch) {
      bot.memory = bot.memory.filter((item) => item.id !== memoryMatch[1]);
      touchBot(bot);
      saveState(home, state);
      send(res, 200, { ok: true, memory: bot.memory });
      return;
    }
    // Artifacts: GET /artifacts, /artifacts/:id (meta and text content), /artifacts/:id/raw (the bytes).
    const artifactMatch = rest.match(/^\/artifacts(?:\/([^/]+)(\/raw)?)?$/);
    if (method === "GET" && artifactMatch) {
      if (!artifactMatch[1]) {
        send(res, 200, { artifacts: artifacts.list(bot) });
        return;
      }
      const found = artifacts.read(bot, artifactMatch[1], url.searchParams.get("v") || undefined);
      if (!found) throw httpError("No such artifact.", 404);
      if (found.missing) throw httpError("That version is gone.", 404);
      if (artifactMatch[2]) {
        const headers = rawHeaders(found.meta, { download: url.searchParams.get("download") === "1", version: found.version });
        res.writeHead(200, { ...headers, "content-length": fs.statSync(found.file).size });
        fs.createReadStream(found.file).pipe(res);
        return;
      }
      const size = found.meta.versions.find((item) => item.v === found.version)?.size || 0;
      const content = found.meta.kind === "file" || size > 2 * 1024 * 1024 ? null : fs.readFileSync(found.file, "utf8");
      send(res, 200, { artifact: found.meta, version: found.version, content });
      return;
    }
    if (method === "GET" && rest === "/models") {
      send(res, 200, await probeModels({
        botId: bot.id,
        provider: bot.model.provider,
        baseUrl: bot.model.baseUrl,
        username: bot.model.username,
      }));
      return;
    }
    if (method === "GET" && rest === "/agents") {
      const models = await probeModels({
        botId: bot.id,
        provider: bot.model.provider,
        baseUrl: bot.model.baseUrl,
        username: bot.model.username,
      });
      send(res, 200, { agents: models.agents || [] });
      return;
    }
    if (method === "GET" && rest === "/prompt") {
      const againstId = url.searchParams.get("against");
      const other = againstId ? state.bots.find((item) => item.id === againstId) : null;
      const livePrompt = buildSystemPrompt(bot, contextFor(bot));
      const diff = other
        ? namedDiff(bot.name, other.name, livePrompt, buildSystemPrompt(other, contextFor(other)))
        : "";
      send(res, 200, { livePrompt, customPrompt: bot.prompt, against: other ? publicBot(other, { home, appUrl }) : null, diff });
      return;
    }
    if (method === "GET" && rest === "/prompt-diff") {
      const otherId = url.searchParams.get("against");
      const other = state.bots.find((item) => item.id === otherId);
      if (!other) throw httpError("Choose another bot to compare against.", 400);
      send(res, 200, {
        patch: namedDiff(bot.name, other.name, buildSystemPrompt(bot, contextFor(bot)), buildSystemPrompt(other, contextFor(other))),
      });
      return;
    }
    if (method === "GET" && rest === "/diffs") {
      send(res, 200, { diffs: readDiffs(home, bot) });
      return;
    }
    if (method === "GET" && rest === "/vault") {
      send(res, 200, { entries: bot.vault.map(publicVaultEntry) });
      return;
    }
    if (method === "POST" && rest === "/vault") {
      const body = await readBody(req);
      const site = String(body.site || "").trim().slice(0, 200);
      const username = String(body.username || "").trim().slice(0, 200);
      const password = String(body.password || "");
      const label = String(body.label || "").trim().slice(0, 100);
      if (!site) throw httpError("Site is required.", 400);
      if (!password) throw httpError("Password is required.", 400);
      const entry = { id: crypto.randomUUID(), site, username, label, createdAt: Date.now(), lastUsedAt: 0 };
      secrets.set(`vault:${bot.id}:${entry.id}`, password);
      bot.vault.push(entry);
      touchBot(bot);
      saveState(home, state);
      send(res, 201, { entry: publicVaultEntry(entry) });
      return;
    }
    if (method === "POST" && rest === "/vault/onepassword") {
      const body = await readBody(req);
      const itemId = String(body.itemId || "").trim();
      if (!itemId) throw httpError("Choose a 1Password item.", 400);
      const vaultId = String(body.vaultId || "").trim() || (await onePassword.listLogins("")).find((item) => item.id === itemId)?.vaultId || "";
      const login = await onePassword.readLogin(itemId, vaultId);
      const site = String(body.site || login.site || "").trim().slice(0, 200);
      if (!site) throw httpError("That 1Password item has no website.", 400);
      const entry = {
        id: crypto.randomUUID(),
        site,
        username: String(login.username || "").slice(0, 200),
        label: String(body.label || "").trim().slice(0, 100) || "1Password",
        source: "1password",
        externalId: itemId,
        externalVault: vaultId,
        createdAt: Date.now(),
        lastUsedAt: 0,
      };
      bot.vault.push(entry);
      touchBot(bot);
      saveState(home, state);
      send(res, 201, { entry: publicVaultEntry(entry) });
      return;
    }
    const vaultMatch = rest.match(/^\/vault\/([^/]+)(\/use)?$/);
    if (vaultMatch) {
      const entry = bot.vault.find((item) => item.id === vaultMatch[1]);
      if (!entry) throw httpError("Unknown saved login.", 404);
      if (method === "DELETE" && !vaultMatch[2]) {
        bot.vault = bot.vault.filter((item) => item.id !== entry.id);
        secrets.delete(`vault:${bot.id}:${entry.id}`);
        touchBot(bot);
        saveState(home, state);
        send(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && vaultMatch[2]) {
        const password = await passwordFor(bot, entry);
        if (!password) throw httpError("That login has no saved password.", 409);
        const session = await browser.ensure(bot);
        const result = await session.login({ ...entry, password });
        entry.lastUsedAt = Date.now();
        saveState(home, state);
        appendActivity(bot, `Signed in to ${entry.site}`);
        send(res, 200, { ok: true, browser: result.status });
        return;
      }
    }

    if (method === "GET" && rest === "/files") {
      const relative = url.searchParams.get("path") || "";
      send(res, 200, { path: relative, entries: await listTree(workspacePath(home, bot), relative) });
      return;
    }
    if (method === "GET" && rest === "/file") {
      const relative = url.searchParams.get("path");
      if (!relative) throw httpError("A path is required.", 400);
      send(res, 200, await readWorkspaceFile(workspacePath(home, bot), relative));
      return;
    }
    if (method === "PUT" && rest === "/file") {
      const body = await readBody(req, 1_500_000);
      const result = await writeWorkspaceDiff(workspacePath(home, bot), body.path, String(body.content ?? ""));
      if (result.diff?.patch) {
        const diffs = readDiffs(home, bot);
        diffs.push({ ...result.diff, id: crypto.randomUUID(), at: Date.now(), actor: "user" });
        writeDiffs(home, bot, diffs);
        eventLog.append(bot, { type: "diff", ...result.diff, id: crypto.randomUUID(), actor: "user" });
      }
      appendActivity(bot, `Edited ${body.path}`);
      send(res, 200, { ok: true, diff: result.diff });
      return;
    }
    if (method === "POST" && rest === "/terminal") {
      const body = await readBody(req);
      const result = await runBotCommand(bot, String(body.command || ""), { workspace: workspacePath(home, bot), browser, env: plugins.shellEnvFor(bot) });
      appendActivity(bot, `$ ${String(body.command || "").slice(0, 120)}`);
      send(res, 200, result);
      return;
    }

    if (method === "GET" && rest === "/box") {
      send(res, 200, { ...(await box.status(bot)), terminal: terminals.status(bot.id) });
      return;
    }
    if (method === "POST" && rest === "/box") {
      const body = await readBody(req);
      const action = String(body.action || "");
      if (!box.uses(bot)) throw httpError("This bot does not have its own computer.", 409);
      if (action === "start") {
        // The first start can build the image for minutes; the UI polls GET /box.
        box.ensure(bot).catch(() => {});
        send(res, 202, await box.status(bot));
        return;
      }
      if (action === "stop" || action === "reset") {
        if (action === "reset" && engine.status(bot.id).busy) throw httpError("Stop the running turn before resetting the computer.", 409);
        await live.reset(bot);
        await browser.close(bot.id);
        terminals.close(bot.id);
        if (action === "stop") await box.stop(bot);
        else await box.reset(bot);
        appendActivity(bot, action === "stop" ? "Stopped its computer" : "Reset its computer");
        send(res, 200, await box.status(bot));
        return;
      }
      throw httpError("Unknown computer action.", 400);
    }

    if (method === "GET" && rest === "/desktop") {
      send(res, 200, desktop.status(bot));
      return;
    }
    if (method === "GET" && rest === "/desktop/screenshot") {
      const info = desktop.status(bot);
      if (!info.available) throw httpError("Xvfb is not installed on this server.", 409);
      if (!info.running && browser.status(bot).running) await browser.close(bot.id);
      await browser.ensure(bot);
      const png = await desktop.screenshot(bot, { force: true });
      if (!png) throw httpError("The desktop is not running.", 409);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "no-store",
      });
      res.end(png);
      return;
    }
    if (method === "POST" && rest === "/desktop") {
      const body = await readBody(req);
      const action = String(body.action || "");
      if (action === "start") {
        if (!desktop.status(bot).running && browser.status(bot).running) await browser.close(bot.id);
        await browser.ensure(bot);
        send(res, 200, desktop.status(bot));
        return;
      }
      if (action === "click") {
        if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) throw httpError("Click needs x and y.", 400);
        await desktop.click(bot, Number(body.x), Number(body.y));
        send(res, 200, { ok: true });
        return;
      }
      if (action === "type") {
        await desktop.type(bot, String(body.text || ""));
        send(res, 200, { ok: true });
        return;
      }
      if (action === "key") {
        await desktop.key(bot, String(body.key || "Enter"));
        send(res, 200, { ok: true });
        return;
      }
      if (action === "scroll") {
        await desktop.scroll(bot, Number(body.dy) || 800);
        send(res, 200, { ok: true });
        return;
      }
      throw httpError("Unknown desktop action.", 400);
    }
    // Take control: the user's live view of this bot's screen. The stream itself is the WebSocket at /live.
    if (method === "GET" && rest === "/live/status") {
      send(res, 200, await live.status(bot));
      return;
    }
    if (method === "POST" && rest === "/live/start") {
      const body = await readBody(req);
      send(res, 200, await live.start(bot, { withBrowser: body.browser !== false }));
      return;
    }
    if (method === "POST" && rest === "/live/takeover") {
      const body = await readBody(req);
      let status;
      try {
        status = await live.takeOver(bot, { url: String(body.url || "") });
      } catch (error) {
        throw error.status ? error : httpError(error.message, 400);
      }
      appendActivity(bot, "Took over the browser to sign in");
      send(res, 200, status);
      return;
    }
    if (method === "POST" && rest === "/live/handback") {
      const status = await live.handBack(bot);
      appendActivity(bot, "Handed the browser back to the agent");
      send(res, 200, status);
      return;
    }
    if (method === "POST" && rest === "/opencode/reset") {
      bot.remote.opencode = {};
      touchBot(bot);
      saveState(home, state);
      send(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && rest.startsWith("/computer/")) {
      const name = rest.slice("/computer/".length);
      if (!name || path.basename(name) !== name) throw httpError("Unknown computer file.", 404);
      const file = path.join(botHome(home, bot), "computer", name);
      if (!fs.existsSync(file)) throw httpError("That computer frame has expired.", 404);
      const png = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "no-store",
      });
      res.end(png);
      return;
    }
    if (method === "GET" && rest === "/browser") {
      send(res, 200, browser.status(bot));
      return;
    }
    if (method === "GET" && rest === "/browser/screenshot") {
      const session = await browser.ensure(bot);
      const png = await session.screenshot();
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "no-store",
      });
      res.end(png);
      return;
    }
    if (method === "POST" && rest === "/browser") {
      const body = await readBody(req);
      const action = String(body.action || "");
      if (action === "start") {
        const session = await browser.ensure(bot);
        send(res, 200, session.status());
        return;
      }
      const session = await browser.ensure(bot);
      if (action === "navigate") {
        const status = await session.navigate(String(body.url || ""));
        appendActivity(bot, `Opened ${status.url}`);
        send(res, 200, status);
        return;
      }
      if (action === "back") return send(res, 200, await session.goBack());
      if (action === "forward") return send(res, 200, await session.goForward());
      if (action === "reload") return send(res, 200, await session.reload());
      if (action === "click") {
        if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
          send(res, 200, await session.click(Number(body.x), Number(body.y)));
        } else if (body.selector) {
          send(res, 200, await session.clickSelector(String(body.selector)));
        } else {
          throw httpError("Click needs x and y, or a selector.", 400);
        }
        return;
      }
      if (action === "type") {
        await session.typeText(String(body.text || ""));
        send(res, 200, session.status());
        return;
      }
      if (action === "key") {
        send(res, 200, await session.key(String(body.key || "Enter")));
        return;
      }
      if (action === "login") {
        const entry = bot.vault.find((item) => item.id === body.entryId);
        if (!entry) throw httpError("Unknown saved login.", 404);
        const password = await passwordFor(bot, entry);
        if (!password) throw httpError("That login has no saved password.", 409);
        const result = await session.login({ ...entry, password });
        entry.lastUsedAt = Date.now();
        saveState(home, state);
        appendActivity(bot, `Signed in to ${entry.site}`);
        send(res, 200, { ok: true, ...result });
        return;
      }
      if (action === "page") {
        send(res, 200, await session.read());
        return;
      }
      throw httpError("Unknown browser action.", 400);
    }

    if (method === "POST" && rest === "/jobs") {
      const body = await readBody(req);
      let job;
      try {
        job = createJob({ ...body, createdBy: "user" });
      } catch (error) {
        throw httpError(error.message, 400);
      }
      bot.jobs.push(job);
      touchBot(bot);
      saveState(home, state);
      send(res, 201, { job: publicJob(job) });
      return;
    }
    const jobMatch = rest.match(/^\/jobs\/([^/]+)(\/run|\/dismiss)?$/);
    if (jobMatch) {
      const job = bot.jobs.find((item) => item.id === jobMatch[1]);
      if (!job) throw httpError("Unknown job.", 404);
      // Clears a failed run from Home's Needs you; the next failure shows again.
      if (method === "POST" && jobMatch[2] === "/dismiss") {
        job.failureDismissedAt = Date.now();
        saveState(home, state);
        send(res, 200, { ok: true });
        return;
      }
      if (method === "PATCH" && !jobMatch[2]) {
        const body = await readBody(req);
        try {
          updateJob(job, body);
        } catch (error) {
          throw httpError(error.message, 400);
        }
        touchBot(bot);
        saveState(home, state);
        send(res, 200, { job: publicJob(job) });
        return;
      }
      if (method === "DELETE" && !jobMatch[2]) {
        bot.jobs = bot.jobs.filter((item) => item.id !== job.id);
        touchBot(bot);
        saveState(home, state);
        send(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && jobMatch[2] === "/run") {
        job.lastRunAt = Date.now();
        if (job.at) consumeOneShot(job, job.lastRunAt);
        touchBot(bot);
        saveState(home, state);
        const { turnId } = engine.enqueue(bot, {
          text: job.prompt,
          source: "job",
          jobId: job.id,
          jobName: job.name,
        });
        send(res, 202, { ok: true, turnId });
        return;
      }
    }

    if (method === "POST" && rest === "/connectors") {
      const body = await readBody(req);
      const connector = makeConnector(body);
      const secret = connectorSecret(body);
      if (secret) secrets.set(`connector:${bot.id}:${connector.id}`, secret);
      connector.envKeys = Object.keys(body.env || {});
      connector.headerKeys = Object.keys(body.headers || {});
      bot.connectors.push(connector);
      touchBot(bot);
      saveState(home, state);
      await mcp.refresh(bot, connector);
      syncOpenCodeConfig(bot);
      saveState(home, state);
      send(res, 201, { connector: publicConnector(connector) });
      return;
    }
    const connectorMatch = rest.match(/^\/connectors\/([^/]+)(\/test)?$/);
    if (connectorMatch) {
      const connector = bot.connectors.find((item) => item.id === connectorMatch[1]);
      if (!connector) throw httpError("Unknown connector.", 404);
      if (method === "PATCH" && !connectorMatch[2]) {
        const body = await readBody(req);
        applyConnector(connector, body);
        if (Object.hasOwn(body, "env") || Object.hasOwn(body, "headers")) {
          const secret = connectorSecret(body);
          if (secret) secrets.set(`connector:${bot.id}:${connector.id}`, secret);
          else secrets.delete(`connector:${bot.id}:${connector.id}`);
          connector.envKeys = Object.keys(body.env || {});
          connector.headerKeys = Object.keys(body.headers || {});
        }
        touchBot(bot);
        saveState(home, state);
        if (connector.enabled) await mcp.refresh(bot, connector);
        syncOpenCodeConfig(bot);
        saveState(home, state);
        send(res, 200, { connector: publicConnector(connector) });
        return;
      }
      if (method === "DELETE" && !connectorMatch[2]) {
        await mcp.close(bot, connector);
        if (isPluginConnector(connector)) plugins.connectorRemoved(bot, connector);
        bot.connectors = bot.connectors.filter((item) => item.id !== connector.id);
        secrets.delete(`connector:${bot.id}:${connector.id}`);
        touchBot(bot);
        saveState(home, state);
        syncOpenCodeConfig(bot);
        send(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && connectorMatch[2]) {
        await mcp.refresh(bot, connector);
        syncOpenCodeConfig(bot);
        saveState(home, state);
        send(res, 200, { connector: publicConnector(connector) });
        return;
      }
    }

    throw httpError("Not found.", 404);
  }

  async function probeModels(input) {
    const provider = input.provider === "openai" ? "openai" : "opencode";
    const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw httpError("Enter a base URL.", 400);
    let apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
    if (!apiKey && input.botId) apiKey = secrets.get(`bot:${input.botId}:apiKey`, "");
    // The server's own OpenCode (or a saved server) needs no password from the person.
    if (!apiKey) apiKey = models.keyForModel({ provider, baseUrl });
    if (provider === "openai") {
      try {
        const models = await openAIModels({ baseUrl, apiKey });
        return { provider, baseUrl, models, agents: [] };
      } catch (error) {
        throw httpError(error.message, 502);
      }
    }
    const bot = { model: { baseUrl, username: String(input.username || "opencode"), apiKey, model: "", agent: "" } };
    try {
      const [allModels, agents] = await Promise.all([
        openCodeModels(bot, input.botId ? workspacePath(home, findBot(input.botId)) : undefined),
        openCodeAgents(bot, input.botId ? workspacePath(home, findBot(input.botId)) : undefined),
      ]);
      const connected = allModels.filter((model) => model.connected !== false);
      return { provider, baseUrl, models: connected.length ? connected : allModels, agents };
    } catch (error) {
      throw httpError(error.message, 502);
    }
  }

  server.services = { auth, push, notifications, proposals, approvals, engine, state, plugins, secrets, managedOpenCode };
  return server;

  function activityFor(bot) {
    const job = bot.jobs.filter((item) => item.enabled && item.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
    if (job) return `Next job: ${describeSchedule(job)}`;
    if (bot.status === "on") return "On and waiting";
    return "";
  }
}

function normalizeIncomingModel(input, base = {}) {
  const next = {
    provider: input.provider === "openai" ? "openai" : input.provider === "opencode" ? "opencode" : base.provider || "opencode",
    baseUrl: String(input.baseUrl ?? base.baseUrl ?? "").trim().replace(/\/+$/, ""),
    username: String(input.username ?? base.username ?? "opencode").trim() || "opencode",
    model: String(input.model ?? base.model ?? "").trim(),
    agent: String(input.agent ?? base.agent ?? "").trim(),
    ...(/^server:[A-Za-z0-9-]{1,40}$/.test(input.connection || "") ? { connection: input.connection } : {}),
  };
  if (next.baseUrl) {
    let url;
    try {
      url = new URL(next.baseUrl);
    } catch {
      throw httpError("Base URL is not a URL.", 400);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw httpError("Base URL must be http or https.", 400);
    if (url.username || url.password) throw httpError("Do not put a password in the address. Use the password field.", 400);
  }
  if (next.model.length > 300) throw httpError("Model id is too long.", 400);
  if (next.agent.length > 100) throw httpError("Agent id is too long.", 400);
  return next;
}

// The group helpers throw plain errors for bad input; the API answers those with 400, not 500.
function badRequest(fn) {
  try {
    return fn();
  } catch (error) {
    throw error.status ? error : httpError(error.message, 400);
  }
}

function validateBotFields(body) {
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 40)) {
    throw httpError("Bot name must be 1-40 characters.", 400);
  }
  if (body.job !== undefined && (typeof body.job !== "string" || body.job.length > 300)) {
    throw httpError("Job must be at most 300 characters.", 400);
  }
  if (body.group !== undefined && (typeof body.group !== "string" || body.group.length > 40)) {
    throw httpError("Group must be at most 40 characters.", 400);
  }
  if (body.prompt !== undefined && (typeof body.prompt !== "string" || body.prompt.length > 32_000)) {
    throw httpError("Instructions must be at most 32000 characters.", 400);
  }
  if (body.skills !== undefined) {
    if (!Array.isArray(body.skills) || body.skills.length > 20) throw httpError("Skills must be a list of at most 20 names.", 400);
    if (body.skills.some((name) => typeof name !== "string" || name.length < 1 || name.length > 64)) throw httpError("Each skill is its name, 1-64 characters.", 400);
  }
  if (body.avatar !== undefined && (!body.avatar || typeof body.avatar !== "object" || Array.isArray(body.avatar))) {
    throw httpError("Avatar must be an object.", 400);
  }
}

function makeConnector(body) {
  const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw httpError("Connector name is required.", 400);
  const transport = body.transport === "http" ? "http" : "stdio";
  const id = crypto.randomUUID();
  const connector = {
    id,
    name,
    transport,
    command: transport === "stdio" ? String(body.command || "").trim() : "",
    args: Array.isArray(body.args) ? body.args.map((arg) => String(arg)).slice(0, 40) : [],
    url: transport === "http" ? String(body.url || "").trim() : "",
    enabled: body.enabled !== false,
    status: "new",
    error: "",
    tools: [],
    checkedAt: 0,
    envKeys: [],
    headerKeys: [],
    configKey: "",
  };
  if (transport === "stdio" && !connector.command) throw httpError("A command is required for a stdio MCP server.", 400);
  if (transport === "http") {
    let url;
    try {
      url = new URL(connector.url);
    } catch {
      throw httpError("Connector URL is not a URL.", 400);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw httpError("Connector URL must be http or https.", 400);
  }
  connector.configKey = connectorKey(connector);
  return connector;
}

function applyConnector(connector, body) {
  if (typeof body.name === "string") connector.name = body.name.trim().replace(/\s+/g, " ").slice(0, 60) || connector.name;
  if (typeof body.command === "string") connector.command = body.command.trim();
  if (Array.isArray(body.args)) connector.args = body.args.map((arg) => String(arg)).slice(0, 40);
  if (typeof body.url === "string") connector.url = body.url.trim();
  if (typeof body.enabled === "boolean") connector.enabled = body.enabled;
  if (connector.transport === "stdio" && !connector.command) throw httpError("A command is required.", 400);
  if (connector.transport === "http") {
    try {
      const url = new URL(connector.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      throw httpError("Connector URL must be http or https.", 400);
    }
  }
  if (!connector.configKey) connector.configKey = connectorKey(connector);
}

function connectorSecret(body) {
  const env = body.env && typeof body.env === "object"
    ? Object.fromEntries(Object.entries(body.env).map(([key, value]) => [String(key), String(value)]))
    : {};
  const headers = body.headers && typeof body.headers === "object"
    ? Object.fromEntries(Object.entries(body.headers).map(([key, value]) => [String(key), String(value)]))
    : {};
  if (!Object.keys(env).length && !Object.keys(headers).length) return null;
  return { env, headers };
}

function connectorKey(connector) {
  const slug = connector.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "mcp";
  return `tb_${slug}_${connector.id.slice(0, 4)}`;
}

function publicVaultEntry(entry) {
  return {
    id: entry.id,
    site: entry.site,
    username: entry.username,
    label: entry.label,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    source: entry.source || "ravnir",
    externalId: entry.externalId || "",
  };
}

function assertSameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    throw httpError("Cross-site request blocked.", 403);
  }
}

function deny(req, res, url) {
  const page = (req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/");
  if (page) {
    redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return;
  }
  // WWW-Authenticate only for a client that already tried Basic, so a browser never pops its own dialog.
  const basic = /^Basic\s/i.test(String(req.headers.authorization || ""));
  send(res, 401, { error: "Authentication required." }, basic ? { "www-authenticate": 'Basic realm="Ravnir"' } : {});
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store", "content-length": 0 });
  res.end();
}

// Only a path on this site. Anything else goes home.
function safeNext(value) {
  const next = String(value || "");
  const ok = /^\/(?![/\\])/.test(next) && !/[\u0000-\u001f\u007f]/.test(next) && !/^\/login(?:[?#/]|$)/.test(next);
  return ok ? next : "/";
}

// Secure cookies need https. Only plain http to localhost (local testing) may leave it off.
function cookieSecure(req) {
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const plain = !req.socket?.encrypted && forwarded !== "https";
  return !(local && plain);
}

function staticFile(pathname) {
  if (FILES.has(pathname)) return FILES.get(pathname);
  const match = /^\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/.exec(pathname);
  const type = match && STATIC_TYPES[path.extname(match[1]).toLowerCase()];
  if (!type || !fs.existsSync(path.join(root, "public", match[1]))) return null;
  return [match[1], type];
}

// Plugin icons: public/plugins/<folder>/<file>, images only, never outside that folder.
const PLUGIN_ASSETS = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".gif": "image/gif" };
function servePluginAsset(res, pathname) {
  let relative = "";
  try {
    relative = decodeURIComponent(pathname.slice("/plugins/".length));
  } catch {
    relative = "";
  }
  const base = path.join(root, "public", "plugins");
  const file = path.resolve(base, relative);
  const type = PLUGIN_ASSETS[path.extname(file).toLowerCase()];
  if (!relative || !type || !file.startsWith(`${base}${path.sep}`) || !fs.existsSync(file)) throw httpError("Not found.", 404);
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": type,
    "content-length": data.length,
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
    // An SVG opened on its own cannot run script.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  });
  res.end(data);
}

function serveVendor(res, [name, type], req) {
  sendAsset(req, res, fs.readFileSync(path.join(root, "node_modules", name)), type);
}

function serveFile(res, [name, type], req) {
  sendAsset(req, res, fs.readFileSync(path.join(root, "public", name)), type);
}

// Pages are never kept: a home-screen app that kept an old page and loaded a new app.js crashed on
// a button the old page lacked and sat on "connecting…". Scripts and styles carry a content tag, so
// the browser asks every time and gets a 304 when nothing changed.
function sendAsset(req, res, data, type) {
  if (type.startsWith("text/html")) {
    res.writeHead(200, { "content-type": type, "content-length": data.length, "cache-control": "no-store" });
    res.end(data);
    return;
  }
  const tag = `"${crypto.createHash("sha1").update(data).digest("base64url").slice(0, 22)}"`;
  if (req?.headers["if-none-match"] === tag) {
    res.writeHead(304, { etag: tag, "cache-control": "no-cache" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": data.length, "cache-control": "no-cache", etag: tag });
  res.end(data);
}

function send(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError("Body is too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError("Body must be JSON.", 400));
      }
    });
    req.on("error", reject);
  });
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function serveDemoLogin(res, url) {
  const error = url.searchParams.get("error") || "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo login · Ravnir</title>
  <link rel="icon" href="/favicon.png?v=companion-20261025" type="image/png" />
  <style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;background:#f5f5f7;color:#1d1d1f;display:grid;place-items:center;min-height:100vh;margin:0;-webkit-font-smoothing:antialiased;letter-spacing:-.006em}
  .card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:22px;padding:34px;width:min(400px,90vw);box-shadow:0 24px 70px rgba(0,0,0,.10),0 2px 8px rgba(0,0,0,.04)}
  .brand{display:flex;align-items:center;gap:9px;margin-bottom:24px;font-size:13px;font-weight:600;letter-spacing:-.02em;color:#1d1d1f;text-decoration:none}
  .brand img{width:26px;height:26px;border-radius:8px;display:block;box-shadow:0 0 0 .5px rgba(0,0,0,.08)}
  h1{font-size:24px;line-height:1.15;letter-spacing:-.032em;font-weight:600;margin:0 0 7px}
  p{color:#6e6e73;margin:0 0 22px;font-size:13.5px}
  label{display:block;font-size:12px;font-weight:500;color:#6e6e73;margin:14px 0 6px}
  input{width:100%;padding:10px 12px;border:1px solid rgba(0,0,0,.12);border-radius:10px;font:inherit;background:#fff;outline:none;transition:border-color .14s ease,box-shadow .14s ease}
  input:focus{border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.14)}
  button{margin-top:22px;width:100%;padding:11px;border:0;border-radius:10px;background:#1d1d1f;color:#fff;font:inherit;font-weight:500;cursor:pointer}
  button:hover{background:#3a3a3c}
  .err{background:#fff2f2;color:#d70015;padding:9px 11px;border-radius:9px;font-size:12.5px;border:1px solid rgba(215,0,21,.12)}
  </style></head>
  <body><form class="card" method="post" action="/demo/login">
  <a class="brand" href="/"><img src="/logo.png?v=companion-20261025" alt="" /><span>Ravnir</span></a>
  <h1>Sign in to Ravnir Demo</h1><p>This page exists so a bot can practise a real sign-in on its own computer.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  <label for="username">Username</label><input id="username" name="username" autocomplete="username" placeholder="ada" />
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="anything" />
  <button type="submit">Sign in</button></form></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(html);
}

async function handleDemoLogin(req, res) {
  const body = await readBodyText(req);
  const params = new URLSearchParams(body);
  const username = (params.get("username") || "").trim();
  if (!username) {
    res.writeHead(302, { location: "/demo/login?error=Enter%20a%20username" });
    res.end();
    return;
  }
  const token = Buffer.from(`demo:${username}:${Date.now()}`).toString("base64url");
  res.writeHead(302, {
    location: "/demo/account",
    "set-cookie": `ravnir_demo=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  });
  res.end();
}

function serveDemoAccount(req, res) {
  const cookie = req.headers.cookie || "";
  // truebot_demo is the same cookie from before the rename, still in agents' browser profiles.
  const token = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("ravnir_demo=") || item.startsWith("truebot_demo="));
  let user = "";
  if (token) {
    try {
      user = Buffer.from(token.split("=")[1], "base64url").toString("utf8").split(":")[1] || "";
    } catch {
      user = "";
    }
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo account · Ravnir</title>
  <link rel="icon" href="/favicon.png?v=companion-20261025" type="image/png" />
  <style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;background:#f5f5f7;color:#1d1d1f;display:grid;place-items:center;min-height:100vh;margin:0;-webkit-font-smoothing:antialiased;letter-spacing:-.006em}
  .card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:22px;padding:34px;width:min(430px,90vw);box-shadow:0 24px 70px rgba(0,0,0,.10),0 2px 8px rgba(0,0,0,.04);text-align:center}
  .brand{display:inline-flex;align-items:center;gap:9px;margin-bottom:24px;font-size:13px;font-weight:600;letter-spacing:-.02em;color:#1d1d1f;text-decoration:none}
  .brand img{width:26px;height:26px;border-radius:8px;display:block;box-shadow:0 0 0 .5px rgba(0,0,0,.08)}
  h1{font-size:24px;line-height:1.2;letter-spacing:-.032em;font-weight:600;margin:0 0 8px}
  p{color:#6e6e73;margin:0 0 12px;font-size:13.5px}
  a{color:#0071e3;text-decoration:none}
  </style></head>
  <body><div class="card"><a class="brand" href="/"><img src="/logo.png?v=companion-20261025" alt="" /><span>Ravnir</span></a>
  <h1>${user ? `Signed in as ${escapeHtml(user)}` : "Not signed in"}</h1>
  <p>${user ? "The cookie in this browser profile is the session. Close the tab, reopen the computer, and it is still here." : "Open /demo/login and sign in."}</p>
  <p><a href="/demo/login">Sign in again</a></p></div></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(html);
}

// Streams a request body to a file, refusing more than limit bytes.
function saveStream(req, file, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(file, { mode: 0o600 });
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        out.destroy();
        reject(httpError("That file is too large.", 413));
      }
    });
    req.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    req.pipe(out);
  });
}

function readBodyText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20_000) {
        reject(httpError("Body is too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  const host = process.env.RAVNIR_HOST || "127.0.0.1";
  const port = Number(process.env.RAVNIR_PORT || 3847);
  const home = process.env.RAVNIR_HOME || path.join(root, "data");
  // Agents here run a shell and a browser, so anything past loopback needs sign-in.
  if (!listenAllowed(host, process.env)) {
    console.error(`Ravnir will not listen on ${host} without sign-in. Set RAVNIR_USER and RAVNIR_PASSWORD, or keep RAVNIR_HOST=127.0.0.1.`);
    process.exit(1);
  }
  const server = createApp({ home, projectRoot: root });
  server.listen(port, host, () => {
    console.log(`Ravnir listening on http://${host}:${port}`);
  });
  // A stop (Ctrl-C, systemd, docker stop) ends the OpenCode this server runs before exiting.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      const done = () => process.exit(0);
      setTimeout(done, 6_000).unref();
      server.services.managedOpenCode.stop().then(done, done);
    });
  }
}
