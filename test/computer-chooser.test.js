import assert from "node:assert/strict";
import test from "node:test";

// No Jev key in these tests: the point is what happens without one.
delete process.env.TYPESAFE_API_KEY;
delete process.env.RAVNIR_TYPESAFE_KEY;
delete process.env.RAVNIR_QUICK_URL;
delete process.env.RAVNIR_QUICK_MODEL;

const { chooseNext, chooserFor, parsePick } = await import("../server/chooser.js");
const { driveTask, nextStep, startSteps, stepRun } = await import("../server/drive.js");
const { builtinToolsFor } = await import("../server/computer.js");
const { handleBuiltinMcp } = await import("../server/mcpBuiltin.js");
const { buildSystemPrompt } = await import("../server/prompts.js");
const { startMock } = await import("../scripts/mock-openai.js");

const openCodeBot = { id: "oc", name: "Scout", vault: [], model: { provider: "opencode", baseUrl: "http://127.0.0.1:4096", model: "opencode-go/glm-5.3-flash" } };
const openAIBot = (url) => ({ id: "oa", name: "Builder", vault: [], model: { provider: "openai", baseUrl: url, model: "mock-model", apiKey: "" } });

// A browser stand-in: each page has its own actions, and performing one moves to the next page.
function fakeDriver(pages) {
  let at = 0;
  const done = [];
  const page = () => pages[Math.min(at, pages.length - 1)];
  return {
    kind: "browser",
    label: "Computer",
    done,
    async observe(step) {
      const current = page();
      return {
        url: current.url,
        title: current.title,
        shot: `/shot/${step}`,
        where: `${current.title} at ${current.url}`,
        summary: current.text,
        state: { url: current.url, title: current.title, page: current.text, step: step + 1 },
        actions: [
          ...current.actions,
          { kind: "done", label: "DONE: the goal is already complete" },
          { kind: "stop", label: "STOP: I cannot make progress from this page" },
        ],
        empty: "There is nothing left to click or type on this page.",
      };
    },
    async perform(action) {
      if (action.fail) throw new Error("the button is gone");
      done.push(action.label);
      at += 1;
    },
    async after(step) {
      return { url: page().url, title: page().title, shot: `/after/${step}` };
    },
  };
}

const pages = [
  { url: "https://shop.test/", title: "Shop", text: "Welcome", actions: [{ kind: "click", label: 'Click "About"' }, { kind: "click", label: 'Click "Next"' }] },
  { url: "https://shop.test/cart", title: "Cart", text: "One item", actions: [{ kind: "click", label: 'Click "Next"' }] },
  { url: "https://shop.test/done", title: "Thanks", text: "Order placed", actions: [{ kind: "click", label: 'Click "Home"' }] },
];

test("the chooser's answer is read from JSON, after reasoning, or from a bare number", () => {
  assert.deepEqual(parsePick('<think>hmm 9</think>{"pick": 2, "score": 3.5}', 4), { index: 1, score: 3.5 });
  assert.deepEqual(parsePick("3", 4), { index: 2, score: 3 });
  assert.equal(parsePick('{"pick": 9}', 4).index, -1);
  assert.equal(parsePick("no idea", 4).index, -1);
});

test("without Jev, a server with a fast model picks steps with it, and one without hands them to the agent", () => {
  assert.equal(chooserFor(openCodeBot).mode, "agent");
  assert.equal(chooserFor(openAIBot("http://127.0.0.1:1/v1")).mode, "model");
  const quick = chooserFor(openCodeBot, { RAVNIR_QUICK_URL: "http://127.0.0.1:1/v1", RAVNIR_QUICK_MODEL: "fast" });
  assert.equal(quick.mode, "model");
  assert.equal(quick.config.model, "fast");
});

test("every agent keeps computer_task without a Jev key", async () => {
  const names = async (bot) => (await builtinToolsFor(bot, {})).map((tool) => tool.name);
  const agent = await names(openCodeBot);
  assert.ok(agent.includes("computer_task"));
  assert.ok(agent.includes("computer_step"));
  assert.ok(!agent.includes("browser_smart_click"));
  assert.ok(!agent.includes("jev_choose"));
  const model = await names(openAIBot("http://127.0.0.1:1/v1"));
  assert.ok(model.includes("computer_task"));
  assert.ok(model.includes("browser_smart_click"));
  assert.ok(!model.includes("computer_step"));
  assert.ok(!model.includes("jev_choose"));
});

test("the MCP endpoint lists the same filtered tools the built-in loop offers", async () => {
  const result = await handleBuiltinMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    bot: openCodeBot,
    token: "t",
    header: "Bearer t",
    ctx: { toolDefs: (bot) => builtinToolsFor(bot, {}) },
  });
  const listed = result.json.result.tools.map((tool) => tool.name);
  assert.ok(listed.includes("computer_step"));
  assert.ok(!listed.includes("jev_choose"));
});

test("with a fast model, computer_task runs on its own and its tokens are reported", async () => {
  const mock = await startMock();
  try {
    const bot = openAIBot(mock.url);
    const chooser = chooserFor(bot);
    const picked = await chooseNext(chooser, { goal: "Check out", state: {}, options: ['Click "About"', 'Click "Next"', "DONE: the goal is already complete"] });
    assert.equal(picked.best.index, 1);
    assert.equal(picked.best.score, 4);

    const driver = fakeDriver(pages);
    const events = [];
    const result = await driveTask({ driver, goal: "Place the order", maxSteps: 8, chooser, emit: (event) => events.push(event) });
    assert.deepEqual(driver.done, ['Click "Next"', 'Click "Next"']);
    assert.match(result.text, /^Done after 2 steps: DONE/);
    assert.match(result.text, /1\. Click "Next" \(4\/4\)\n2\. Click "Next" \(4\/4\)$/);
    // Three choices, each reported by the mock as 120 in, 30 out, $0.002.
    assert.equal(result.usage.input, 360);
    assert.equal(Math.round(result.usage.cost * 1000) / 1000, 0.006);
    assert.equal(events.filter((event) => event.type === "computer.step" && event.phase === "action").length, 2);
    assert.ok(events.every((event) => event.type !== "computer.step" || event.shot));
  } finally {
    await mock.close();
  }
});

test("without a server-side chooser, the agent steps through the task with computer_step", async () => {
  const bot = { id: "stepper" };
  const driver = fakeDriver(pages);
  const events = [];
  const emit = (event) => events.push(event);
  const driverFor = async (kind, options) => {
    assert.equal(kind, "browser");
    assert.equal(options.goal, "Place the order");
    return driver;
  };

  const first = await startSteps({ bot, driver, goal: "Place the order", maxSteps: 5, emit });
  assert.match(first.text, /Step 1 of up to 5\. Screen: Shop at https:\/\/shop\.test\/\n/);
  assert.match(first.text, /Answer with computer_step, this step number \(1\) and the number of the best one:\n1\. Click "About"\n2\. Click "Next"\n3\. DONE/);
  await assert.rejects(nextStep({ bot, pick: 9, step: 1, driverFor, emit }), /from 1 to 4/);

  const second = await nextStep({ bot, pick: 2, step: 1, driverFor, emit });
  assert.match(second.text, /^Did: Click "Next"\n\nGoal: Place the order\nStep 2 of up to 5\. Screen: Cart/);
  // A pick from the old list is refused, and nothing happens.
  const stale = await nextStep({ bot, pick: 1, step: 1, driverFor, emit });
  assert.match(stale.text, /^That list is out of date \(you picked from step 1\)\. Nothing was done\./);
  assert.deepEqual(driver.done, ['Click "Next"']);
  const third = await nextStep({ bot, pick: 1, step: 2, driverFor, emit });
  assert.match(third.text, /Screen: Thanks/);
  const end = await nextStep({ bot, pick: 2, step: 3, driverFor, emit });
  assert.match(end.text, /^Done after 2 steps: DONE[\s\S]*1\. Click "Next"\n2\. Click "Next"$/);
  assert.equal(stepRun(bot.id), null);
  await assert.rejects(nextStep({ bot, pick: 1, step: 4, driverFor, emit }), /no computer task in progress/);
  assert.equal(events.filter((event) => event.phase === "action").length, 2);
});

test("two step calls at once never act on the same list", async () => {
  const bot = { id: "twice" };
  const driver = fakeDriver(pages);
  const driverFor = async () => driver;
  await startSteps({ bot, driver, goal: "Place the order", maxSteps: 5 });
  const [a, b] = await Promise.all([
    nextStep({ bot, pick: 2, step: 1, driverFor }),
    nextStep({ bot, pick: 2, step: 1, driverFor }),
  ]);
  assert.match(a.text, /^Did: Click "Next"/);
  assert.match(b.text, /^That list is out of date/);
  assert.deepEqual(driver.done, ['Click "Next"']);
  // Starting again replaces the old task and says so.
  const again = await startSteps({ bot, driver: fakeDriver(pages), goal: "Look around", maxSteps: 2 });
  assert.match(again.text, /^Your earlier computer task was dropped; this one replaces it\./);
});

test("the MCP endpoint refuses a built-in tool it does not list for this agent", async () => {
  let ran = false;
  const result = await handleBuiltinMcp({
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_choose", arguments: { goal: "x", options: ["a", "b"] } } },
    bot: openCodeBot,
    token: "t",
    header: "Bearer t",
    ctx: { toolDefs: (bot) => builtinToolsFor(bot, {}), callBuiltin: async () => { ran = true; return { text: "ran" }; } },
  });
  assert.equal(result.json.result.isError, true);
  assert.match(result.json.result.content[0].text, /jev_choose is not available to this agent right now/);
  assert.equal(ran, false);
});

test("a step whose target vanished shows the screen as it is now", async () => {
  const bot = { id: "vanish" };
  const driver = fakeDriver([{ url: "https://x.test/", title: "X", text: "", actions: [{ kind: "click", label: 'Click "Gone"', fail: true }] }]);
  await startSteps({ bot, driver, goal: "Go", maxSteps: 3 });
  const again = await nextStep({ bot, pick: 1, step: 1, driverFor: async () => driver });
  assert.match(again.text, /^That action failed \(the button is gone\)\. This is the screen now\./);
  assert.ok(stepRun(bot.id));
});

test("the prompt explains the step mode only when the agent has to pick", () => {
  const agent = buildSystemPrompt({ name: "Scout", job: "x", memory: [], jobs: [], vault: [] }, { chooser: "agent" });
  assert.match(agent, /Answer with computer_step, giving that step number and the number of the best action/);
  assert.doesNotMatch(agent, /Jev/);
  const jev = buildSystemPrompt({ name: "Scout", job: "x", memory: [], jobs: [], vault: [] }, { chooser: "jev" });
  assert.match(jev, /asks Jev, a fast decision model, for the next action/);
});

// A screen that never changes, whatever is pressed.
function stuckDriver(actions, extra = {}) {
  const done = [];
  return {
    kind: "browser",
    label: "Computer",
    done,
    async observe(step) {
      return {
        url: "https://app.test/campaigns",
        title: "Campaigns",
        shot: `/shot/${step}`,
        where: "Campaigns at https://app.test/campaigns",
        state: { url: "https://app.test/campaigns", title: "Campaigns", page: "Campaigns", step: step + 1 },
        fingerprint: extra.fingerprint ? extra.fingerprint(done.length) : "",
        actions: [...actions, { kind: "done", label: "DONE: the goal is already complete" }, { kind: "stop", label: "STOP: I cannot make progress from this page" }],
        empty: "",
      };
    },
    async perform(action) {
      done.push(action.label);
    },
    async after(step) {
      return { url: "https://app.test/campaigns", title: "Campaigns", shot: `/after/${step}` };
    },
  };
}

test("computer_task tells the chooser what it already did, so a reached goal ends the task", async () => {
  const mock = await startMock();
  try {
    const driver = fakeDriver(pages);
    const result = await driveTask({ driver, goal: "open the about page", maxSteps: 4, chooser: chooserFor(openAIBot(mock.url)) });
    assert.match(result.text, /^Done after 1 step: DONE/);
    assert.deepEqual(driver.done, ['Click "About"']);
  } finally {
    await mock.close();
  }
});

test("computer_task stops when two actions in a row change nothing, and says where it got to", async () => {
  const mock = await startMock();
  try {
    const chooser = chooserFor(openAIBot(mock.url));
    const driver = stuckDriver([{ kind: "key", key: "Tab", label: "Press Tab" }]);
    driver.hint = "Use browser_read and browser_click with the exact text, or another approach.";
    const result = await driveTask({ driver, goal: "keep tabbing", maxSteps: 8, chooser });
    assert.match(result.text, /^Stopped after 2 steps: the last 2 actions changed nothing on the screen\. The screen is Campaigns at https:\/\/app\.test\/campaigns\. Use browser_read/);
    assert.deepEqual(driver.done, ["Press Tab", "Press Tab"]);
    assert.equal(result.steps.length, 2);

    // A step that moves something (a panel that scrolled, a field that filled) is progress.
    const moving = stuckDriver([{ kind: "key", key: "Tab", label: "Press Tab" }], { fingerprint: (count) => `scroll ${count}` });
    const long = await driveTask({ driver: moving, goal: "keep tabbing", maxSteps: 5, chooser });
    assert.match(long.text, /^Reached the step limit \(5\) on Campaigns/);
    assert.equal(moving.done.length, 5);

    // A click can work without changing the screen (a download, a new tab, a save), so
    // clicks on a screen that stays the same never stop the task early.
    const clicks = stuckDriver([{ kind: "click", selector: "#next", label: 'Click "Next"' }]);
    const clicked = await driveTask({ driver: clicks, goal: "download the invoices", maxSteps: 4, chooser });
    assert.match(clicked.text, /^Reached the step limit \(4\) on Campaigns/);
    assert.equal(clicks.done.length, 4);

    // A click between two key presses starts the count again.
    let turn = 0;
    const mixed = stuckDriver([{ kind: "key", key: "Tab", label: "Press Tab" }]);
    const order = [{ kind: "key", key: "Tab", label: "Press Tab" }, { kind: "click", selector: "#next", label: 'Click "Next"' }];
    const observe = mixed.observe;
    mixed.observe = async (step) => {
      const seen = await observe(step);
      // "keep tabbing" presses Tab when offered and takes the first action otherwise:
      // offer the click instead of Tab on every other step.
      seen.actions = [order[turn++ % 2], ...seen.actions.slice(1)];
      return seen;
    };
    const alternating = await driveTask({ driver: mixed, goal: "keep tabbing", maxSteps: 5, chooser });
    assert.match(alternating.text, /^Reached the step limit \(5\)/);
    assert.equal(mixed.done.length, 5);

    // A run that reached a new page earlier says so when it runs out of steps.
    const wander = fakeDriver([
      { url: "https://shop.test/", title: "Shop", text: "Welcome", actions: [{ kind: "click", label: 'Click "Next"' }] },
      { url: "https://shop.test/a", title: "A", text: "a", actions: [{ kind: "click", label: 'Click "Next"' }] },
      { url: "https://shop.test/b", title: "B", text: "b", actions: [{ kind: "click", label: 'Click "Next"' }] },
    ]);
    const limit = await driveTask({ driver: wander, goal: "Place the order", maxSteps: 2, chooser });
    assert.match(limit.text, /^Reached the step limit \(2\) on B at https:\/\/shop\.test\/b\. The last action that changed the page was Click "Next", which opened B at https:\/\/shop\.test\/b\./);
  } finally {
    await mock.close();
  }
});

test("computer_task offers the buttons that match the goal when there are more than fit", async () => {
  const { buildActions } = await import("../server/computerUse.js");
  const nav = Array.from({ length: 30 }, (_, index) => ({ i: index, selector: `[data-ravnir-action="${index}"]`, text: `Chat ${index}`, href: `https://app.test/chats/${index}` }));
  const card = { i: 30, selector: '[data-ravnir-action="30"]', text: "Ver más", context: "Ana Demo - Casa Norte", href: "" };
  const actions = buildActions({ buttons: [...nav, card], fields: [] }, "", "abrir la campaña Ana Demo - Casa Norte");
  const labels = actions.map((action) => action.label);
  assert.ok(labels.slice(0, 3).some((label) => label.includes("Ana Demo")), labels.slice(0, 3).join(" | "));
  assert.equal(actions.length, 24);
  assert.deepEqual(labels.slice(-7, -2), ["Press Enter", "Press Tab", "Press Escape", "Scroll down", "Scroll up"]);

  // With no goal words, what is on screen and outside navigation comes first; short lists keep page order.
  const ranked = buildActions({ buttons: [...nav.map((button) => ({ ...button, rank: 0 })), { ...card, context: "", rank: 3 }], fields: [] }, "", "");
  assert.equal(ranked[0].label, 'Click "Ver más"');
  const few = buildActions({ buttons: [card, nav[0]], fields: [{ selector: "#q", label: "Search" }] }, "hello", "");
  assert.deepEqual(few.slice(0, 3).map((action) => action.label), ['Click "Ver más" in "Ana Demo - Casa Norte"', 'Click "Chat 0" (https://app.test/chats/0)', 'Type "hello" into Search']);
});
