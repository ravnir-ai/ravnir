// Capability card tasks for the research area (evals/axes.mjs). Same shape as evals/tasks.mjs.
// Each check needs the right answer AND proof the pages it comes from were opened, so a lucky guess fails.

const has = (text, ...needles) => needles.every((needle) => (needle instanceof RegExp ? needle.test(text) : String(text).toLowerCase().includes(String(needle).toLowerCase())));
const pass = (ok, why) => ({ ok: Boolean(ok), why });
// The agent opened this page itself (the site logs every request).
const visited = (ctx, path) => ctx.siteLog().some((event) => event.type === "request" && event.path === path);
const missing = (ctx, ...paths) => paths.filter((path) => !visited(ctx, path));

export const tasks = [
  {
    id: "cheapest-supplier",
    title: "Pick the cheapest supplier that meets the rules",
    tags: ["research", "web"],
    expectAsks: 0,
    prompt: (ctx) => `I need 40 office chairs for the new office. They have to arrive within 5 working days and come with at least a 3-year warranty. Of the suppliers listed at ${ctx.site}/suppliers, which one is cheapest for me, and what would the 40 chairs cost?`,
    check: (ctx) => {
      const unread = missing(ctx, "/suppliers/alder", "/suppliers/birchline", "/suppliers/cedarwood");
      if (unread.length) return pass(false, `never opened ${unread.join(", ")}`);
      const right = has(ctx.reply, "birchline") && has(ctx.reply, /113[.,]4\b|4[.,\s]?536\b/);
      return pass(right, right ? "names Birchline at 113.40 each (4,536 total)" : "reply lacks Birchline with the discounted price 113.40 or the total 4,536");
    },
  },
  {
    id: "docs-two-deep",
    title: "Find a limit two links deep and name the page",
    tags: ["research", "web"],
    expectAsks: 0,
    prompt: (ctx) => `What is the largest single file I can send through the Northwind API upload endpoint, and which page of their docs says so? Their knowledge base is at ${ctx.site}/kb.`,
    check: (ctx) => {
      if (!visited(ctx, "/kb/api/uploads")) return pass(false, "never opened /kb/api/uploads");
      const right = has(ctx.reply, /\b48\s*(MB|megabytes?|MiB)/i) && has(ctx.reply, /uploading files|kb\/api\/uploads/i);
      return pass(right, right ? "reply gives 48 MB and the Uploading files page" : "reply lacks 48 MB or the page it came from");
    },
  },
  {
    id: "newer-source-wins",
    title: "Two pages disagree, use the newer one and its date",
    tags: ["research", "web"],
    expectAsks: 0,
    prompt: (ctx) => `What is the current rate limit on the Northwind API, and when did it last change? Their docs are at ${ctx.site}/kb.`,
    check: (ctx) => {
      if (!visited(ctx, "/changelog")) return pass(false, "never opened /changelog");
      const date = /2026-09-14|14(th)?\s+(of\s+)?sep(t|tember)?\.?(,?\s*2026)?|sep(t|tember)?\.?\s+14(th)?|\b14\/0?9\/2026|\b0?9\/14\/2026/i;
      const right = has(ctx.reply, /\b240\b/) && date.test(ctx.reply);
      return pass(right, right ? "reply gives 240 requests per minute, changed 14 Sep 2026" : "reply lacks 240 per minute or the 14 Sep 2026 date");
    },
  },
  {
    id: "report-figures",
    title: "Pull three exact figures out of a long report",
    tags: ["research", "web"],
    expectAsks: 0,
    prompt: (ctx) => `From Northwind's Q3 2026 operations report (${ctx.site}/reports/2026-q3) I need three numbers: the on-time delivery rate, the return rate for monitor arms, and the median first response time of support.`,
    check: (ctx) => {
      if (!visited(ctx, "/reports/2026-q3")) return pass(false, "never opened /reports/2026-q3");
      const onTime = /94[.,]7/.test(ctx.reply);
      const returns = /3[.,]8\s*%/.test(ctx.reply) || /3[.,]8\s*percent/i.test(ctx.reply);
      const median = /3\s*h(ours?|rs?)?\.?,?\s*(and\s*)?12\s*(min|m\b)|\b3:12\b|\b192\s*min/i.test(ctx.reply);
      const ok = onTime && returns && median;
      return pass(ok, ok ? "94.7%, 3.8% and 3 h 12 min all present" : `missing ${[!onTime && "94.7% on time", !returns && "3.8% monitor arm returns", !median && "3 h 12 min median"].filter(Boolean).join(", ")}`);
    },
  },
];
