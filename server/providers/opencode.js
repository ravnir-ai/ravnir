import { RAVNIR_TOOL_TIMEOUT_MS } from "../mcp.js";

const flavorCache = new Map();
const modelCache = new Map();

// What the model reads when the user refuses one of its calls. A refusal with a message lets OpenCode's
// loop go on (a bare "reject" ends it), so the agent finishes with what it has instead of stopping on
// the line it wrote before the call.
export const REJECT_FEEDBACK = "Not approved. Do not run this call again or a variant of it. Finish the task with tools and commands that need no approval (files on this server you can read directly), and end with the result for the user, saying plainly what you could not check and why.";

export function clearFlavorCache() {
  flavorCache.clear();
}

export function splitModel(model) {
  const value = String(model || "");
  const slash = value.indexOf("/");
  if (slash <= 0) return { providerID: "", modelID: value };
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

export function extractModels(json) {
  const models = [];
  const seen = new Set();
  const connected = new Set(Array.isArray(json?.connected) ? json.connected : []);
  const push = (providerID, modelID, label, info = null) => {
    if (!modelID) return;
    const id = providerID ? `${providerID}/${modelID}` : modelID;
    if (seen.has(id)) return;
    seen.add(id);
    models.push({
      id,
      label: label || id,
      providerID: providerID || "",
      modelID,
      connected: connected.size ? connected.has(providerID) : true,
      images: seesImages(info),
    });
  };

  const providers = []
    .concat(json?.all || [])
    .concat(json?.providers || [])
    .concat(Array.isArray(json) ? json : []);
  for (const provider of providers) {
    if (!provider || typeof provider !== "object" || !provider.models) continue;
    const providerID = provider.id || provider.providerID || "";
    const name = provider.name || providerID;
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        const modelID = model.modelID || model.id;
        push(providerID, modelID, `${name} / ${model.name || modelID}`, model);
      }
    } else {
      for (const [key, model] of Object.entries(provider.models)) {
        const modelID = model?.modelID || model?.id || key;
        push(providerID, modelID, `${name} / ${model?.name || modelID}`, model);
      }
    }
  }

  const rows = Array.isArray(json?.data) ? json.data : [];
  for (const model of rows) {
    if (!model || typeof model !== "object") continue;
    if (model.modelID || model.providerID) {
      push(model.providerID || "", model.modelID || model.id, `${model.providerID || "model"} / ${model.name || model.modelID || model.id}`, model);
    }
  }
  return models;
}

// Whether a model takes images, from the shapes OpenCode has used: capabilities.input.image, then
// models.dev's modalities and attachment. Undefined when the listing does not say.
function seesImages(model) {
  if (!model || typeof model !== "object") return undefined;
  const input = model.capabilities?.input;
  if (input && typeof input.image === "boolean") return input.image;
  if (Array.isArray(model.modalities?.input)) return model.modalities.input.includes("image");
  if (typeof model.attachment === "boolean") return model.attachment;
  return undefined;
}

export function extractAgents(json) {
  const rows = Array.isArray(json) ? json : json?.data || json?.agents || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((agent) => agent && (agent.id || agent.name) && !agent.hidden)
    .map((agent) => ({
      id: agent.id || agent.name,
      name: agent.name || agent.id,
      description: agent.description || "",
      system: typeof agent.system === "string" ? agent.system : "",
      mode: agent.mode || "",
    }));
}

export function normalizeDiffs(json) {
  const rows = Array.isArray(json) ? json : json?.data || json?.diffs || json?.files || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const patch = row.patch || row.diff || "";
    return {
      path: row.file || row.path || row.filename || "unknown",
      patch,
      additions: numberOrCount(row.additions, patch, "+"),
      deletions: numberOrCount(row.deletions, patch, "-"),
      status: row.status || "modified",
    };
  }).filter((row) => row.patch);
}

export function userCount(json) {
  return messageList(json).filter((message) => roleOf(message) === "user").length;
}

export function lastUserIndex(json) {
  const list = messageList(json);
  let lastUser = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (roleOf(list[i]) === "user") lastUser = i;
  }
  return lastUser;
}

export function assistantsAfterLastUser(json) {
  const list = messageList(json);
  const lastUser = lastUserIndex(json);
  return list.slice(lastUser + 1).filter((message) => roleOf(message) === "assistant");
}

// A session is poisoned when OpenCode accepted a prompt and then went idle
// without ever completing an assistant message. This really happens when an
// upstream model request hangs: the assistant row stays unfinished and every
// later prompt is appended to the same dead session. Detect it before sending
// and start a clean session instead of waiting for the reply timeout.
export function sessionLooksStale(json, idle) {
  if (!idle) return false;
  const list = messageList(json);
  if (!list.length) return false;
  const last = list.at(-1);
  if (roleOf(last) === "user") return true;
  const assistant = [...list].reverse().find((message) => roleOf(message) === "assistant");
  return Boolean(assistant && !assistant.info?.time?.completed && !assistant.time?.completed);
}

export function textAfterLastUser(json) {
  const list = messageList(json);
  const lastUser = lastUserIndex(json);
  const chunks = [];
  for (const message of list.slice(lastUser + 1)) {
    if (roleOf(message) === "user") continue;
    const text = textOf(message);
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}

export function usageAfterLastUser(json) {
  const list = messageList(json);
  let lastUser = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (roleOf(list[i]) === "user") lastUser = i;
  }
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of list.slice(lastUser + 1)) {
    const info = message?.info || message || {};
    if (roleOf(message) !== "assistant") continue;
    const tokens = info.tokens || {};
    usage.input += Number(tokens.input) || 0;
    usage.output += Number(tokens.output) || 0;
    usage.reasoning += Number(tokens.reasoning) || 0;
    usage.cacheRead += Number(tokens.cache?.read) || 0;
    usage.cacheWrite += Number(tokens.cache?.write) || 0;
    usage.cost += Number(info.cost) || 0;
  }
  return usage;
}

export function isSessionIdle(json, sessionId) {
  if (!json || typeof json !== "object") return false;
  const data = json.data && !Array.isArray(json.data) ? json.data : json;
  if (sessionId && !Object.prototype.hasOwnProperty.call(data, sessionId)) {
    if (data.status === undefined) return true;
    const fallback = typeof data.status === "string" ? data.status : data.status?.type || data.status?.status;
    return fallback === "idle";
  }
  const entry = (sessionId && data[sessionId]) || data.status || null;
  const type = typeof entry === "string" ? entry : entry?.type || entry?.status;
  return type === "idle";
}

export function pendingPermissions(json, sessionId) {
  const rows = Array.isArray(json) ? json : json?.data || json?.permissions || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && (row.id || row.permissionID || row.requestID))
    .filter((row) => !sessionId || !row.sessionID || row.sessionID === sessionId)
    .filter((row) => !row.replied && !row.reply)
    .map((row) => ({
      id: row.id || row.permissionID || row.requestID,
      title: permissionTitle(row),
      detail: permissionDetail(row),
      kind: permissionKind(row),
      command: permissionCommand(row),
    }));
}

const PERMISSION_LABELS = {
  bash: "Run a terminal command",
  edit: "Edit a file",
  external_directory: "Use files outside its workspace",
  webfetch: "Fetch a web page",
};

// bash, edit, external_directory, webfetch, ...
function permissionKind(row) {
  return String((typeof row.permission === "string" ? row.permission : row.type) || "");
}

// The command a bash request wants to run, or its first pattern.
function permissionCommand(row) {
  const patterns = Array.isArray(row.patterns) ? row.patterns : [row.pattern];
  const text = [row.metadata?.command, ...patterns].find((part) => typeof part === "string" && part.trim());
  return text ? text.trim() : "";
}

function permissionTitle(row) {
  if (row.title) return row.title;
  const kind = permissionKind(row);
  return PERMISSION_LABELS[kind] || row.description || (kind ? `OpenCode wants to use ${kind}` : "OpenCode is waiting for permission");
}

function permissionDetail(row) {
  const meta = row.metadata || {};
  const parts = [meta.command, meta.filepath || meta.filePath, meta.url, ...(Array.isArray(row.patterns) ? row.patterns : [row.pattern])];
  return [...new Set(parts.filter((part) => typeof part === "string" && part.trim()))].join("\n");
}

// Tool calls of assistant messages. With afterUsers, only those after that many user messages plus the
// turn's own: the session keeps every earlier turn, and listing them again would replay old tool cards
// into the new turn. Counting users, not taking the last one, keeps a turn's tool calls even if OpenCode
// adds a user message of its own later in the turn.
export function toolParts(json, { afterUsers = -1 } = {}) {
  const all = messageList(json);
  let list = all;
  if (afterUsers >= 0) {
    let users = 0;
    const start = all.findIndex((message) => roleOf(message) === "user" && ++users > afterUsers);
    list = start === -1 ? [] : all.slice(start + 1);
  }
  const tools = [];
  for (const message of list) {
    if (roleOf(message) !== "assistant") continue;
    for (const part of message.parts || []) {
      if (part?.type !== "tool") continue;
      tools.push({
        id: part.callID || part.id || part.tool,
        name: part.tool || "tool",
        status: part.state?.status || "unknown",
        input: part.state?.input || {},
        // A failed tool keeps its reason in state.error; without it the thread and the model only see "error".
        output: part.state?.output || part.state?.metadata?.output || (part.state?.status === "error" ? String(part.state?.error || "").slice(0, 4000) : "") || part.state?.title || "",
        error: part.state?.status === "error",
      });
    }
  }
  return tools;
}

export async function listModels(bot, directory) {
  const flavor = await detect(bot, directory);
  const path = flavor === "v2" ? "/api/model" : "/provider";
  const result = await request(bot, "GET", path, { directory: flavor === "v2" ? directory : undefined, flavor });
  if (!result.ok) throw new Error(result.error);
  return extractModels(result.json);
}

export async function listAgents(bot, directory) {
  const flavor = await detect(bot, directory);
  const path = flavor === "v2" ? "/api/agent" : "/agent";
  const result = await request(bot, "GET", path, { directory: flavor === "v2" ? directory : undefined, flavor });
  if (!result.ok) throw new Error(result.error);
  return extractAgents(result.json);
}

// OpenCode lists a workspace's MCP tools once and keeps them. Disposing the instance makes it reload
// its config and tool lists on the next request, so a bot sees tools Ravnir added since then.
export async function reloadInstance(bot, directory, { mcp = "ravnir" } = {}) {
  const flavor = await detect(bot, directory);
  if (flavor === "v2") return { ok: false, error: "This OpenCode build has no instance reload." };
  // Reconnecting the Ravnir MCP server refreshes its tool list; disposing reloads the rest of the config.
  await request(bot, "POST", `/mcp/${encodeURIComponent(mcp)}/disconnect`, { directory, flavor });
  let connected = await request(bot, "POST", `/mcp/${encodeURIComponent(mcp)}/connect`, { directory, flavor });
  const disposed = await request(bot, "POST", "/instance/dispose", { directory, flavor });
  // An instance loaded before the entry existed (it was renamed from "truebot") learns it on reload.
  if (!connected.ok && disposed.ok) connected = await request(bot, "POST", `/mcp/${encodeURIComponent(mcp)}/connect`, { directory, flavor });
  return { ok: connected.ok && disposed.ok, error: connected.error || disposed.error || "" };
}

export async function runOpenCodeTurn({
  bot,
  directory,
  remote,
  title,
  text,
  files = [],
  systemPrompt,
  history,
  emit,
  signal,
  waitForDecision,
  // A note for the fresh session after one stopped responding (what the turn already ran), from the error.
  retryNote,
}) {
  const flavor = await detect(bot, directory);
  await assertModel(bot, flavor, directory);
  const model = splitModel(bot.model.model);
  let state = remote || {};
  if (!state.id || state.flavor !== flavor || state.directory !== directory) {
    state = await newRemote(bot, flavor, directory, title, bot.name);
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) {
      await abort(bot, flavor, state.id, directory).catch(() => {});
      throw new Error("Stopped.");
    }
    if (attempt > 0) {
      emit({ type: "status", message: "The previous OpenCode session stopped responding. Starting a fresh one." });
      await abort(bot, flavor, state.id, directory).catch(() => {});
      state = await newRemote(bot, flavor, directory, title, bot.name);
    }
    // The fresh session cannot see what the dropped one did, so it is told, or it runs the same tools again.
    const note = attempt > 0 ? String(retryNote?.(lastError) || "") : "";
    const turnText = note ? `${text}\n\n${note}` : text;

    await applySessionSettings(bot, flavor, state.id, directory, model);
    await replaceStaleSession({ bot, flavor, state, directory, title, emit });
    await applySessionSettings(bot, flavor, state.id, directory, model);

    const before = await readMessages(bot, flavor, state.id, directory);
    if (!before.ok) throw new Error(before.error);
    const beforeUsers = userCount(before.json);
    let outbound = turnText;
    let delivery = "system";
    if (flavor === "v2") {
      delivery = "preface";
      if (!state.promptAttached) {
        outbound = `${systemPrompt}\n\n---\n\n${history ? `Earlier in this thread:\n${history}\n\n---\n\n` : ""}${turnText}`;
        state.promptAttached = true;
      }
    } else if (history && beforeUsers === 0) {
      outbound = `${history}\n\n---\n\n${turnText}`;
    }

    emit({
      type: "status",
      message: delivery === "system"
        ? "OpenCode received the live system prompt with this turn."
        : "This OpenCode build has no per-turn system field. The prompt is attached to the first message.",
    });

    try {
      const sent = await sendPrompt(bot, flavor, state.id, directory, {
        text: outbound,
        files: takesImages(bot, flavor) ? files : [],
        systemPrompt,
        agent: bot.model.agent,
        model,
      });

      let reply = sent.immediateText || "";
      if (sent.immediateText) emit({ type: "stream.replace", text: sent.immediateText });
      else {
        reply = await pollTurn({
          bot,
          flavor,
          remoteId: state.id,
          directory,
          beforeUsers,
          emit,
          signal,
          waitForDecision,
        });
      }

      const diffs = await readDiffs(bot, flavor, state.id, directory);
      for (const diff of diffs) {
        emit({ type: "diff", ...diff, at: Date.now() });
      }

      const after = await readMessages(bot, flavor, state.id, directory).catch(() => null);
      const usage = after?.ok ? usageAfterLastUser(after.json) : null;
      return { text: reply, remote: state, usage };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) {
        await abort(bot, flavor, state.id, directory).catch(() => {});
        throw error;
      }
      if (!error.retryable || attempt === 1) {
        // Do not reuse a session that just hung: the next user turn would
        // inherit an unfinished assistant message and stall the same way.
        error.resetRemote = true;
        throw error;
      }
    }
  }
  throw lastError;
}

async function newRemote(bot, flavor, directory, title, name) {
  const created = await createRemote(bot, flavor, directory, title, name);
  return { id: created.id, flavor, directory, promptAttached: false };
}

async function applySessionSettings(bot, flavor, id, directory, model) {
  if (flavor !== "v2") return;
  if (model.modelID) {
    await must(bot, "POST", `/api/session/${id}/model`, {
      directory,
      flavor,
      body: { model: { id: model.modelID, providerID: model.providerID || undefined } },
    });
  }
  if (bot.model.agent) {
    await must(bot, "POST", `/api/session/${id}/agent`, {
      directory,
      flavor,
      body: { agent: bot.model.agent },
    });
  }
}

async function replaceStaleSession({ bot, flavor, state, directory, title, emit }) {
  const messages = await readMessages(bot, flavor, state.id, directory).catch(() => null);
  if (!messages?.ok) return;
  const status = await readStatus(bot, flavor, directory);
  const idle = status.ok ? isSessionIdle(status.json, state.id) : false;
  if (!sessionLooksStale(messages.json, idle)) return;
  emit({ type: "status", message: "The previous OpenCode turn never finished. The old session is being replaced." });
  await abort(bot, flavor, state.id, directory).catch(() => {});
  const next = await newRemote(bot, flavor, directory, title, bot.name);
  state.id = next.id;
  state.promptAttached = false;
}

async function assertModel(bot, flavor, directory) {
  if (!bot.model.model) return;
  const cacheKey = `${bot.model.baseUrl}|${flavor}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.until > Date.now()) {
    if (cached.models.length && !cached.models.includes(bot.model.model)) throw modelError(bot.model.model, cached.models);
    return;
  }
  const path = flavor === "v2" ? "/api/model" : "/provider";
  const result = await request(bot, "GET", path, { directory: flavor === "v2" ? directory : undefined, flavor });
  if (!result.ok) return;
  const listed = extractModels(result.json);
  const models = listed.map((model) => model.id);
  const images = Object.fromEntries(listed.map((model) => [model.id, model.images]));
  modelCache.set(cacheKey, { models, images, until: Date.now() + 60_000 });
  if (models.length && !models.includes(bot.model.model)) throw modelError(bot.model.model, models);
}

// False only when OpenCode says the model cannot take images; then photos stay a path in the text.
function takesImages(bot, flavor) {
  return modelCache.get(`${bot.model.baseUrl}|${flavor}`)?.images?.[bot.model.model] !== false;
}

function modelError(model, models) {
  const sample = models.slice(0, 4).join(", ");
  return new Error(`OpenCode does not offer the model "${model}". Choose one from the model list, for example ${sample}.`);
}

async function detect(bot, directory) {
  const key = `${bot.model.baseUrl}|${bot.model.username}|${bot.model.apiKey || ""}`;
  const cached = flavorCache.get(key);
  if (cached && cached.until > Date.now()) return cached.flavor;
  const health = await request(bot, "GET", "/global/health");
  if (health.ok) return remember(key, "classic");
  const models = await request(bot, "GET", "/api/model", { directory, flavor: "v2" });
  if (models.ok) return remember(key, "v2");
  const providers = await request(bot, "GET", "/provider");
  if (providers.ok) return remember(key, "classic");
  throw new Error(health.error || models.error || "OpenCode did not respond. Start it with `opencode serve` and check the base URL.");
}

function remember(key, flavor) {
  flavorCache.set(key, { flavor, until: Date.now() + 30_000 });
  return flavor;
}

async function createRemote(bot, flavor, directory, title, name) {
  const path = flavor === "v2" ? "/api/session" : "/session";
  const body = { title: `${title || "Ravnir"} · ${name}` };
  const result = await must(bot, "POST", path, { directory, flavor, body });
  const id = result.json?.id || result.json?.data?.id || result.json?.data?.sessionID;
  if (!id) throw new Error("OpenCode created a session without an id.");
  return { id };
}

export function promptBody({ text, files = [], systemPrompt, agent, model = {} }) {
  const body = {
    system: systemPrompt,
    parts: [{ type: "text", text }, ...files.map((file) => ({ type: "file", mime: file.type, filename: file.name, url: file.url }))],
  };
  if (agent) body.agent = agent;
  if (model.modelID) body.model = { providerID: model.providerID, modelID: model.modelID };
  return body;
}

// files: photos as data URLs (server/uploads.js modelImages). OpenCode passes them to models that
// read images; the newer /api prompt takes text only, and the message already names the file paths.
async function sendPrompt(bot, flavor, id, directory, { text, files = [], systemPrompt, agent, model }) {
  if (flavor === "v2") {
    await must(bot, "POST", `/api/session/${id}/prompt`, {
      directory,
      flavor,
      body: { text, resume: true },
    });
    return { async: true, immediateText: "" };
  }

  const body = promptBody({ text, files, systemPrompt, agent, model });

  const asyncResult = await request(bot, "POST", `/session/${id}/prompt_async`, { directory, flavor, body, timeoutMs: 30_000 });
  if (asyncResult.ok) return { async: true, immediateText: "" };
  if (asyncResult.status !== 404 && asyncResult.status !== 405) throw new Error(asyncResult.error);

  const sync = await must(bot, "POST", `/session/${id}/message`, { directory, flavor, body, timeoutMs: 10 * 60_000 });
  return { async: false, immediateText: textAfterLastUser(sync.json) || textOf(sync.json) };
}

async function pollTurn({ bot, flavor, remoteId, directory, beforeUsers, emit, signal, waitForDecision }) {
  const timeoutMs = Number(process.env.RAVNIR_OPENCODE_TIMEOUT_MS) || 30 * 60_000;
  // How long a turn may go with no change at all before it counts as stuck: an idle session, a busy one
  // (a model thinking without streaming, or a hung upstream request), and one with a tool still running
  // (bounded by the timeout Ravnir gives its own tools, plus a margin for OpenCode to report it).
  const stallMs = Number(process.env.RAVNIR_OPENCODE_STALL_MS) || 120_000;
  const busyStallMs = Number(process.env.RAVNIR_OPENCODE_BUSY_STALL_MS) || 300_000;
  const toolStallMs = Number(process.env.RAVNIR_OPENCODE_TOOL_STALL_MS) || RAVNIR_TOOL_TIMEOUT_MS + 30_000;
  const startMs = Number(process.env.RAVNIR_OPENCODE_START_MS) || 25_000;
  let last = "";
  let stable = 0;
  let sawBusy = false;
  let sawAssistant = false;
  let lastProgress = Date.now();
  let lastSignature = "";
  const asked = new Set();
  const seenTools = new Map();
  let started = Date.now();
  const fail = async (message) => {
    await abort(bot, flavor, remoteId, directory).catch(() => {});
    const error = new Error(message);
    error.retryable = true;
    throw error;
  };
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) {
      await abort(bot, flavor, remoteId, directory).catch(() => {});
      throw new Error("Stopped.");
    }
    await sleep(700, signal);
    const status = await readStatus(bot, flavor, directory);
    const messages = await readMessages(bot, flavor, remoteId, directory);
    if (!messages.ok) throw new Error(messages.error);
    const list = messageList(messages.json);
    const users = userCount(messages.json);
    const ready = users > beforeUsers;
    const statusKnown = Boolean(status.ok);
    const idle = statusKnown && isSessionIdle(status.json, remoteId);
    const freshAssistants = assistantsAfterLastUser(messages.json);
    if (freshAssistants.length) sawAssistant = true;

    const lastAssistant = freshAssistants.at(-1);
    const currentText = ready ? textAfterLastUser(messages.json) : "";
    const toolRows = toolParts(messages.json, { afterUsers: beforeUsers });
    const runningTools = toolRows.some((tool) => tool.status === "running" || tool.status === "pending");
    const signature = [
      list.length,
      freshAssistants.length,
      lastAssistant?.info?.time?.completed || 0,
      currentText.length,
      toolRows.map((tool) => `${tool.id}:${tool.status}:${String(tool.output || "").length}`).join("|"),
      // Reasoning and other parts grow too: a model thinking out loud is making progress.
      freshAssistants.map((message) => (message.parts || []).map((part) => `${part?.type}:${String(part?.text || "").length}`).join(",")).join("/"),
    ].join(":");
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgress = Date.now();
    }
    if (status.ok && !idle) sawBusy = true;

    // OpenCode accepted the prompt and then went idle without creating an
    // assistant message. Retry on a clean session instead of burning the full
    // reply timeout on a poisoned one.
    if (!sawAssistant && idle && Date.now() - started > startMs) {
      await fail(`OpenCode accepted the prompt but did not start ${bot.model.model || "a model"}.`);
    }
    // A turn that stopped changing is stuck: after two minutes when the session is idle, five when it
    // is busy, and only past the tool timeout while a tool is still running (another agent's reply, a
    // long research call).
    const stallLimit = runningTools ? toolStallMs : idle ? stallMs : busyStallMs;
    if (Date.now() - lastProgress > stallLimit) {
      await fail("OpenCode stalled before it replied.");
    }

    if (ready) {
      if (currentText !== last) {
        if (currentText.startsWith(last)) emit({ type: "stream.delta", text: currentText.slice(last.length) });
        else emit({ type: "stream.replace", text: currentText });
        last = currentText;
        stable = 0;
      } else if (currentText) {
        stable += 1;
      }
      for (const tool of toolRows) {
        const previous = seenTools.get(tool.id);
        if (previous && previous.status === tool.status && previous.output === tool.output) continue;
        seenTools.set(tool.id, tool);
        emit({ type: "tool", ...tool });
      }
      if (lastAssistant?.info?.error) {
        throw new Error(openCodeError(lastAssistant.info.error));
      }
      const completed = Boolean(lastAssistant?.info?.time?.completed);
      const finished = statusKnown ? idle : stable >= 2;
      if (completed && !runningTools && finished && (last || stable >= 1)) return last;
    }

    if (ready && sawAssistant && ((statusKnown && idle && sawBusy && stable >= 1) || (!statusKnown && stable >= 3))) return last;

    // The pending list is read again after every answer. A refusal makes OpenCode refuse every other
    // request of the session too, and an "always" answer can approve its siblings, so a request read
    // before the answer may be gone: asking the user about it would show a card for nothing.
    let permissions = await readPermissions(bot, flavor, remoteId, directory);
    for (;;) {
      const permission = permissions.find((item) => !asked.has(item.id));
      if (!permission) break;
      asked.add(permission.id);
      const waitStarted = Date.now();
      let decision;
      try {
        decision = await waitForDecision(permission.id, signal, {
          kind: "opencode",
          title: permission.title,
          detail: permission.detail || "",
          permission: permission.kind,
          command: permission.command,
        });
      } catch (error) {
        // The turn was stopped while the user was deciding. Do not leave the
        // session waiting on a permission nobody will answer.
        await abort(bot, flavor, remoteId, directory).catch(() => {});
        throw error;
      }
      // Time spent waiting on the user does not count against the reply timeout.
      started += Date.now() - waitStarted;
      lastProgress = Date.now();
      // The user may have taken minutes; OpenCode may have dropped the request meanwhile.
      const current = await readPermissions(bot, flavor, remoteId, directory, { orNull: true });
      if (!current || current.some((item) => item.id === permission.id)) {
        await replyPermission(bot, flavor, remoteId, directory, permission.id, decision);
        permissions = await readPermissions(bot, flavor, remoteId, directory);
      } else {
        permissions = current;
      }
      sawBusy = true;
      stable = 0;
    }
  }
  const error = new Error("OpenCode timed out before it replied.");
  error.retryable = true;
  try {
    await abort(bot, flavor, remoteId, directory);
  } catch {
    // Best effort.
  }
  throw error;
}

async function readMessages(bot, flavor, id, directory) {
  const path = flavor === "v2" ? `/api/session/${id}/message` : `/session/${id}/message`;
  return request(bot, "GET", path, { directory, flavor });
}

async function readDiffs(bot, flavor, id, directory) {
  const path = flavor === "v2" ? `/api/session/${id}/diff` : `/session/${id}/diff`;
  const result = await request(bot, "GET", path, { directory, flavor });
  if (!result.ok) return [];
  return normalizeDiffs(result.json);
}

// OpenCode keeps session status per instance, and the instance is the request's directory. Without it
// the answer comes from the server's own instance, where the agent's session never appears.
async function readStatus(bot, flavor, directory) {
  if (flavor === "v2") return { ok: false };
  return request(bot, "GET", "/session/status", { directory, flavor });
}

// `orNull`: a failed read gives null instead of an empty list, so a caller can tell "none pending" from
// "could not tell".
async function readPermissions(bot, flavor, id, directory, { orNull = false } = {}) {
  const result = await request(bot, "GET", "/permission", { directory, flavor });
  if (!result.ok) return orNull ? null : [];
  return pendingPermissions(result.json, id);
}

async function replyPermission(bot, flavor, id, directory, requestID, decision) {
  const allowed = decision === "trust" ? "always" : decision === "once" || decision === "always" || decision === "reject" ? decision : "reject";
  // Only the request answered here gets the feedback: OpenCode refuses the session's other pending
  // requests with a bare refusal, whatever order they are answered in.
  const result = await request(bot, "POST", `/permission/${requestID}/reply`, {
    directory,
    flavor,
    body: allowed === "reject" ? { reply: allowed, message: REJECT_FEEDBACK } : { reply: allowed },
  });
  if (result.ok) return;
  // OpenCode settled it between the last read and this answer (not found): nothing left to do.
  const still = await readPermissions(bot, flavor, id, directory, { orNull: true });
  if (!still || still.some((item) => item.id === requestID)) throw new Error(result.error);
}

async function abort(bot, flavor, id, directory) {
  const path = flavor === "v2" ? `/api/session/${id}/abort` : `/session/${id}/abort`;
  return request(bot, "POST", path, { directory, flavor, body: {}, timeoutMs: 5_000 });
}

async function must(bot, method, pathname, options) {
  const result = await request(bot, method, pathname, options);
  if (!result.ok) throw new Error(result.error);
  return result;
}

// For server/models.js: the same request with a connection ({ baseUrl, username, apiKey }) instead of a bot.
export function openCodeRequest(connection, method, pathname, options) {
  return request({ model: connection }, method, pathname, options);
}

async function request(bot, method, pathname, { directory, flavor, body, accept, timeoutMs = 20_000, signal } = {}) {
  if (!bot.model.baseUrl) throw new Error("Set the OpenCode base URL for this bot.");
  let url;
  try {
    url = new URL(pathname, `${bot.model.baseUrl}/`);
  } catch {
    throw new Error("OpenCode base URL is invalid.");
  }
  if (directory && flavor === "v2") {
    url.searchParams.set("directory", directory);
    url.searchParams.set("location[directory]", directory);
  } else if (directory && flavor !== "v2") {
    url.searchParams.set("directory", directory);
  }
  const headers = { accept: accept || "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (bot.model.apiKey) {
    headers.authorization = `Basic ${Buffer.from(`${bot.model.username || "opencode"}:${bot.model.apiKey}`).toString("base64")}`;
  }
  if (directory) headers["x-opencode-directory"] = directory;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A caller that gives up (the browser closed a sign-in) stops the request too.
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      status: 0,
      error: timedOut
        ? `OpenCode did not answer within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach OpenCode at ${bot.model.baseUrl}. ${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: errorText(json, text, response.status), json };
  }
  return { ok: true, status: response.status, json };
}

function errorText(json, text, status) {
  const message = json?.message || json?.error || json?.data?.message || json?.raw;
  return `OpenCode returned ${status}${message ? `: ${message}` : ""}${text && !message ? `: ${text.slice(0, 240)}` : ""}`;
}

function openCodeError(error) {
  const direct = error?.data?.message || error?.message;
  if (direct) return `OpenCode: ${direct}`;
  const body = error?.data?.responseBody;
  if (body) {
    try {
      const parsed = JSON.parse(body);
      const message = parsed?.error?.message || parsed?.message;
      if (message) return `OpenCode: ${message}`;
    } catch {
      return `OpenCode: ${String(body).slice(0, 300)}`;
    }
  }
  return `OpenCode reported ${error?.name || "an error"}.`;
}

function messageList(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (json?.info || json?.parts) return [json];
  return [];
}

function roleOf(message) {
  return message?.info?.role || message?.role || "";
}

function textOf(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  const direct = message.content;
  if (typeof direct === "string" && roleOf(message) !== "user") return direct;
  const parts = message.parts || message.info?.parts || (Array.isArray(direct) ? direct : []);
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => {
    if (!part) return "";
    if (typeof part === "string") return part;
    if (part.type && part.type !== "text") return "";
    return part.text || part.content || "";
  }).filter(Boolean).join("");
}

function numberOrCount(value, patch, prefix) {
  if (Number.isInteger(value)) return value;
  return patch.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(prefix + prefix + prefix)).length;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Stopped."));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
