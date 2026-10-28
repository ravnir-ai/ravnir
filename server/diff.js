// Line diff used for code edits and for the assistant/coding prompt comparison.

const MAX_LCS_LINES = 400;
const CONTEXT = 3;

export function unifiedDiff(filePath, before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffOps(a, b);
  const additions = ops.filter(([op]) => op === "+").length;
  const deletions = ops.filter(([op]) => op === "-").length;
  const changed = additions + deletions > 0;
  let status = "modified";
  if (!changed) status = "unchanged";
  else if (!before) status = "added";
  else if (!after) status = "deleted";

  return {
    path: filePath,
    patch: changed ? formatUnified(filePath, ops) : "",
    additions,
    deletions,
    status,
  };
}

export function promptDiff(assistant, coding) {
  return namedDiff("assistant", "coding", assistant, coding);
}

export function namedDiff(aLabel, bLabel, a, b) {
  const diff = unifiedDiff("prompt", a ?? "", b ?? "");
  if (!diff.patch) return `${aLabel} and ${bLabel} use the same live prompt.`;
  return diff.patch
    .replace("--- a/prompt", `--- ${aLabel}`)
    .replace("+++ b/prompt", `+++ ${bLabel}`);
}

function splitLines(value) {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffOps(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  const mid = aMid.length <= MAX_LCS_LINES && bMid.length <= MAX_LCS_LINES
    ? lcsOps(aMid, bMid)
    : replaceOps(aMid, bMid);

  return [
    ...a.slice(0, prefix).map((line) => [" ", line]),
    ...mid,
    ...a.slice(a.length - suffix).map((line) => [" ", line]),
  ];
}

function replaceOps(a, b) {
  return [...a.map((line) => ["-", line]), ...b.map((line) => ["+", line])];
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["-", a[i]]);
      i += 1;
    } else {
      ops.push(["+", b[j]]);
      j += 1;
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

function formatUnified(filePath, ops) {
  const groups = hunkRanges(ops);
  const body = groups.map(([from, to]) => {
    const header = hunkHeader(ops, from, to);
    const lines = ops.slice(from, to).map(([op, line]) => `${op}${line}`);
    return [header, ...lines].join("\n");
  });
  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...body].join("\n");
}

function hunkRanges(ops) {
  const changes = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i][0] !== " ") changes.push(i);
  }
  if (!changes.length) return [];
  const groups = [];
  let start = changes[0];
  let end = changes[0];
  for (const index of changes.slice(1)) {
    if (index - end <= CONTEXT * 2) end = index;
    else {
      groups.push([start, end]);
      start = index;
      end = index;
    }
  }
  groups.push([start, end]);
  return groups.map(([startIndex, endIndex]) => [
    Math.max(0, startIndex - CONTEXT),
    Math.min(ops.length, endIndex + CONTEXT + 1),
  ]);
}

function hunkHeader(ops, from, to) {
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < from; i += 1) {
    if (ops[i][0] !== "+") oldLine += 1;
    if (ops[i][0] !== "-") newLine += 1;
  }
  let oldCount = 0;
  let newCount = 0;
  for (let i = from; i < to; i += 1) {
    if (ops[i][0] !== "+") oldCount += 1;
    if (ops[i][0] !== "-") newCount += 1;
  }
  const oldStart = oldCount === 0 ? 0 : oldLine;
  const newStart = newCount === 0 ? 0 : newLine;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}
