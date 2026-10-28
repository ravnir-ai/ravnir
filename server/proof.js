import { billingOf, tokensOf } from "./ledger.js";
import { vaultCommitsForTurn, vaultLatestCommit } from "./vault/history.js";

// What a reply can show under itself: the notes it cited, the tools it used, the files it
// changed, the approvals it asked for, and the commits it wrote. Everything here already
// exists in the turn's events, the ledger and the vault history; this module only joins it.
const MAX_OUTPUT = 4000;
const MAX_PATCH = 6000;
const MAX_APPROVAL = 1200;
const MAX_EVENTS = 4000;

function clipped(value, max = MAX_OUTPUT) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function toolRows(events) {
  const byId = new Map();
  for (const event of events) {
    if (event.type !== "tool") continue;
    const id = String(event.id || `${event.name || "tool"}:${event.seq || 0}`);
    const previous = byId.get(id) || {};
    byId.set(id, {
      id,
      name: event.name || previous.name || "tool",
      status: event.status || previous.status || "completed",
      input: event.input ?? previous.input ?? null,
      output: clipped(event.output ?? previous.output ?? ""),
      at: event.at || previous.at || 0,
    });
  }
  return [...byId.values()];
}

function diffRows(events) {
  const byId = new Map();
  for (const event of events) {
    if (event.type !== "diff") continue;
    const id = String(event.id || `${event.path || ""}:${event.patch || ""}`);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      path: event.path || "",
      additions: Number(event.additions) || 0,
      deletions: Number(event.deletions) || 0,
      patch: clipped(event.patch || "", MAX_PATCH),
      at: event.at || 0,
    });
  }
  return [...byId.values()];
}

function stepRows(events) {
  return events
    .filter((event) => event.type === "computer.step" && event.shot)
    .map((event) => ({
      runId: event.runId || "",
      step: event.step || 0,
      phase: event.phase || "",
      action: event.action || "",
      url: event.url || "",
      title: event.title || "",
      shot: event.shot,
      at: event.at || 0,
    }))
    .slice(-20);
}

function approvalRows(records, turnId) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record.turnId === turnId)
    .map((record) => ({
      id: record.id,
      kind: record.kind || "action",
      title: record.title || "Approval",
      detail: clipped(record.detail || "", MAX_APPROVAL),
      status: record.status || "",
      decision: record.decision || "",
      rule: record.rule || "",
      createdAt: record.createdAt || 0,
      decidedAt: record.decidedAt || 0,
    }));
}

function commitRow(commit) {
  if (!commit) return null;
  return {
    hash: commit.hash,
    short: commit.short,
    subject: commit.subject,
    summary: commit.summary,
    author: commit.author,
    at: commit.at,
    turnId: commit.turnId || "",
    files: commit.files || [],
  };
}

export async function buildProof({ turnId, ledger, eventLog, approvals, vault, bot, sources = [] } = {}) {
  const row = ledger?.get?.(turnId);
  if (!row) return null;
  const events = eventLog?.read?.(bot, 0, MAX_EVENTS)?.events || [];
  const turnEvents = events.filter((event) => event.turnId === turnId);
  const meta = turnEvents.find((event) => event.type === "meta");
  const cited = Array.isArray(sources) && sources.length ? sources : meta?.vaultSources || [];
  const sourceRows = await Promise.all(
    cited.map(async (source) => {
      const commit = vault?.available ? await vaultLatestCommit(vault.dir, source.path) : null;
      return {
        path: source.path,
        date: source.date || "",
        hash: source.hash || "",
        commit: commitRow(commit),
      };
    }),
  );
  const commits = vault?.available ? (await vaultCommitsForTurn(vault.dir, turnId)).map(commitRow).filter(Boolean) : [];
  const usage = row.usage || {};
  const model = row.model || "";
  return {
    turn: {
      id: row.id,
      botId: row.botId,
      botName: row.botName,
      at: row.at,
      source: row.source,
      status: row.status,
      prompt: row.prompt || "",
      summary: row.summary || "",
      usage,
      tokens: tokensOf(usage),
      cost: Number(usage.cost) || 0,
      billing: billingOf({ model, usage }),
      model,
      provider: row.provider || "",
      jobName: row.jobName || "",
    },
    sources: sourceRows,
    actions: toolRows(turnEvents),
    diffs: diffRows(turnEvents),
    steps: stepRows(turnEvents),
    approvals: approvalRows(approvals?.records, turnId),
    commits,
  };
}
