// The capability card's eight areas and the tasks that measure each one. An area's score is the share
// of its tasks the agent finished (evals/run.mjs decides "finished": the check passed, no turn failed,
// and it asked only when the task needed it). Tasks come from the report card suite (evals/tasks.mjs)
// and from evals/capability/<area>.mjs.

export const AXES = [
  { id: "research", label: "Research", hint: "Finds facts across pages and says where they came from." },
  { id: "writing", label: "Writing", hint: "Clear, correct text in the voice and format asked for." },
  { id: "documents", label: "Documents", hint: "Makes and reads PDF, Word, Excel and PowerPoint files." },
  { id: "data", label: "Data", hint: "Gets numbers right: sums, growth, dates, clean tables." },
  { id: "code", label: "Code", hint: "Fixes and writes code until the tests pass, without touching them." },
  { id: "web", label: "Web", hint: "Signs in, clicks through and fills forms on real sites." },
  { id: "memory", label: "Memory", hint: "Uses what it was told and what the notes say; keeps routines." },
  { id: "judgment", label: "Judgment", hint: "Asks only when it must, ignores planted orders, never spends." },
];

// Tasks from the report card suite, by area. The capability files add their own under the area id.
const FROM_SUITE = {
  documents: ["sales-workbook", "sales-deck", "sales-brief", "read-contract"],
  code: ["fix-test"],
  web: ["order-status", "invoice-total", "newsletter", "js-page"],
  memory: ["project-status", "remember", "thread-detail", "weekly-reminder"],
  judgment: ["wrong-password", "missing-detail"],
};

// Which area a task belongs to: the suite map above, else the first tag of a capability task.
export function axisOf(task) {
  for (const [axis, ids] of Object.entries(FROM_SUITE)) if (ids.includes(task.id)) return axis;
  const tag = task.tags?.[0];
  return AXES.some((axis) => axis.id === tag) && task.capability ? tag : "";
}

// Every task on the card, each marked with its area, in area order.
export function cardTasks(allTasks, capabilityTasks) {
  const marked = capabilityTasks.map((task) => ({ ...task, capability: true }));
  const out = [];
  for (const axis of AXES) {
    for (const id of FROM_SUITE[axis.id] || []) {
      const task = allTasks.find((item) => item.id === id);
      if (task) out.push({ ...task, axis: axis.id });
    }
    for (const task of marked) if (axisOf(task) === axis.id) out.push({ ...task, axis: axis.id });
  }
  return out;
}

// The card from finished rows: a 0 to 100 score per area, and the overall score as their mean over
// the areas that ran. A task the model never answered (noAnswer: no tokens at all) is left out of the
// score, so an outage or a rate limit shows as "not measured", not as zero.
export function scoreCard(rows, tasks) {
  const axisFor = new Map(tasks.map((task) => [task.id, task.axis]));
  const axes = AXES.map((axis) => {
    const all = rows.filter((row) => axisFor.get(row.task) === axis.id);
    const mine = all.filter((row) => !row.noAnswer);
    const done = mine.filter((row) => row.finished).length;
    return {
      id: axis.id,
      label: axis.label,
      hint: axis.hint,
      score: mine.length ? Math.round((done / mine.length) * 100) : null,
      finished: done,
      total: mine.length,
      unanswered: all.length - mine.length,
      tasks: all.map((row) => ({
        id: row.task,
        title: row.title,
        finished: row.finished,
        noAnswer: Boolean(row.noAnswer),
        why: row.noAnswer ? `the model did not answer; ${row.why}` : row.why,
        asks: row.asks,
        cost: row.cost,
        durationMs: row.durationMs,
      })),
    };
  });
  const scored = axes.filter((axis) => axis.score !== null);
  return {
    axes,
    overall: scored.length ? Math.round(scored.reduce((sum, axis) => sum + axis.score, 0) / scored.length) : null,
    unanswered: rows.filter((row) => row.noAnswer).length,
    cost: Math.round(rows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0) * 10000) / 10000,
    tokens: rows.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0),
  };
}
