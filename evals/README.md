# Evals

Real tasks, run end to end on a fresh Ravnir server, to see whether an agent finishes the job without nagging the user, and what it costs. The results feed the model report card.

## What runs

`tasks.mjs` holds 18 tasks of the "set up X and do Y" kind:

- Web and browser: read an order date and add up invoices behind a saved login, fill forms (one with three steps), find a price two clicks deep, read a page that only renders with JavaScript, answer from a JSON API.
- Files and code: turn JSON into a CSV, fix a failing test.
- Schedules: a weekly reminder and a one-time reminder.
- Memory: answer from a project note, save a preference, use the owner's address, email and company from the vault, use something said earlier in the thread.
- Connectors: close a ticket through an MCP server the agent was given.
- Escalation: a saved login with a wrong password, and a detail nobody has. These two expect one question each; every other task expects none.

They run against `site.mjs` (a fake company website, Northwind, with sign-in, forms and a log of what happened), `tickets-mcp.mjs` (a ticket tracker over MCP), a notes vault seeded with an owner profile and a project note, and a small code project.

## How a run works

Every task runs alone: its own Ravnir server in a throwaway data folder with a local vault, the owner set to Alex (English), its own copy of the demo site and one agent with its own browser. No task can lean on another task's agent, login or page visits. The runner plays the user:

- it approves terminal commands and file changes the agent asks for, as an owner who trusts the agent would set it up,
- it declines a browser hand-over,
- it answers at most two questions per task, with the task's own answer or "use your best judgment".

Each task is scored on:

- finished: the task's check passed (it reads the site's log, the workspace, the vault, the agent's jobs or the final reply),
- asks: every question a turn left for the user (ask_user, a browser hand-over, or a reply that ends asking), from the turn ledger,
- extra asks: asks beyond what the task expects,
- repeats refused and look-first prompts, from ask_user,
- cost and tokens as OpenCode reported them, and wall time.

## Run it

Models run through OpenCode. By default the runner starts its own `opencode serve` with an empty config folder: it uses this machine's OpenCode logins, but none of your global MCP servers, plugins or instructions, so they neither help nor confuse the agents. `--opencode URL` uses a running server instead (`RAVNIR_EVAL_OPENCODE_PASSWORD` when it needs one). Chromium for Playwright must be installed (`npx playwright install chromium`).

```bash
node evals/run.mjs --list
node evals/run.mjs --models opencode-go/deepseek-v4.1-flash
node evals/run.mjs --models opencode-go/glm-5.3-flash,opencode-go/qwen3.8-flash --concurrency 3
node evals/run.mjs --models opencode-go/deepseek-v4.1-flash --tasks order-status,fix-test --keep
node evals/run.mjs --models opencode-go/glm-5.3-flash --tasks wrong-password --out evals/results/<run> --merge
node evals/report.mjs evals/results/<run>
```

Results go to `evals/results/<run>/<model>.json` with `report.md` next to them. `--keep` leaves each task's data folder in place for a look at the threads and tool calls. `--merge` reruns the named tasks and keeps the model's other results in that folder.

`test/evals.test.js` runs the runner itself on the scripted test model, so the plumbing stays covered by `npm test` without spending anything.

## Capability card

The same runner measures one agent rather than one model: `evals/axes.mjs` groups 32 tasks into eight
areas (research, writing, documents, data, code, web, memory, judgment), 16 of them from this suite and
16 from `capability/<area>.mjs`. `card.mjs` gives every task's agent the measured agent's name, job,
instructions and skills, then scores each area as the share of its tasks finished. The app runs it from
an agent's Setup, Card tab; by hand:

```bash
node evals/card.mjs --list
node evals/card.mjs --config card.json --out result.json --concurrency 3
```

`card.json` is `{ name, job, prompt, skills, model: { provider: "opencode", model } }`; the password for
a running OpenCode or an API goes in `RAVNIR_EVAL_OPENCODE_PASSWORD` or `RAVNIR_EVAL_API_KEY`.
