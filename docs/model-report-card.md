# Model report card

Run on 2026-10-25 with Ravnir at the P0.6 code (ask_user, repeat blocking, retry tracking), on a Mac, through OpenCode 1.18.35 with the OpenCode Go plan. Each task ran once per model, so a single pass or fail can flip between runs (GLM 5.3 Flash passed the wrong-password task in one run and failed it in the next). Costs are OpenCode Go's metered prices as OpenCode reported them; the six models together cost $0.72 for this card. How to rerun it: `evals/README.md`.

What the numbers say:

- Agents on inexpensive models finish nearly every task and rarely ask: 0.06 to 0.17 questions per task, median 0, against 0.11 for a model that asks exactly when it must.
- Every model asked for the seat count nobody had. No model asked the same thing twice.
- Extra questions: Qwen 3.8 Flash once and GPT-6 Luna twice, on tasks where the vault or a saved login already had what it needed (the address update and the invoice total).
- A saved login with a wrong password: four of six asked the user once; GPT-6 Luna and GLM 5.3 Flash reported the failure without asking.
- GLM 5.3 Flash lost two tasks to provider aborts and did not create the weekly reminder.

Not covered on this machine: handing the browser to the user (it needs a Linux desktop, so GPT-6 Luna's attempt was refused by the server), and 1Password.

18 tasks, each on a fresh agent with its own browser, through OpenCode. The runner plays the user: it answers at most two questions per task. Asks counts every question a turn left for the user (ask_user, a browser hand-over, or a reply that ends asking). Two tasks expect one question each and fail without it; extra asks are the ones beyond that. A task counts as finished only when its check passes (the site's log, the workspace, the vault, the agent's jobs or the reply, and for answers read off a page, proof the agent opened it) and every turn ended cleanly. Repeat questions refused are ask_user calls turned away because the agent already asked; retries refused are tool calls turned away as unchanged repeats of a failure.

| Model | Finished | Asks per task (mean) | Asks (median) | Extra asks | Repeat questions refused | Retries refused | Cost per task | Median time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opencode-go/mimo-v2.6-flash | 18/18 (100%) | 0.11 | 0 | 0.00 | 0 | 0 | $0.0048 | 28 s |
| opencode-go/deepseek-v4.1-flash | 18/18 (100%) | 0.11 | 0 | 0.00 | 0 | 0 | $0.0051 | 14 s |
| opencode-go/qwen3.8-flash | 18/18 (100%) | 0.17 | 0 | 0.06 | 0 | 0 | $0.010 | 20 s |
| opencode-go/claude-haiku-5-5 | 17/18 (94%) | 0.11 | 0 | 0.00 | 0 | 0 | $0.0070 | 11 s |
| opencode-go/gpt-6-luna | 17/18 (94%) | 0.17 | 0 | 0.11 | 0 | 0 | $0.0046 | 21 s |
| opencode-go/glm-5.3-flash | 14/18 (78%) | 0.06 | 0 | 0.00 | 0 | 0 | $0.0083 | 12 s |

## By task

| Task | opencode-go/mimo-v2.6-flash | opencode-go/deepseek-v4.1-flash | opencode-go/qwen3.8-flash | opencode-go/claude-haiku-5-5 | opencode-go/gpt-6-luna | opencode-go/glm-5.3-flash |
| --- | --- | --- | --- | --- | --- | --- |
| Read an order date behind a saved login | pass | pass | pass | pass | pass | pass |
| Download a CSV behind a login and add it up | pass | pass | pass | pass | pass, 1 ask | pass |
| Fill a form with a fact from the vault | pass | pass | pass, 1 ask | pass | pass, 1 ask | pass |
| Send a contact form with the owner's details | pass | pass | pass | pass | pass | pass |
| Walk a three-step form with facts from the vault | pass | pass | pass | pass | pass | pass |
| Find a number two clicks deep | pass | pass | pass | pass | pass | pass |
| Read a page that only renders with JavaScript | pass | pass | pass | pass | pass | pass |
| Answer from a JSON API | pass | pass | pass | pass | pass | pass |
| Turn JSON into a CSV file in the workspace | pass | pass | pass | pass | pass | pass |
| Fix a failing test | pass | pass | pass | pass | pass | pass |
| Schedule a repeating reminder | pass | pass | pass | pass | pass | fail |
| Schedule a one-time reminder | pass | pass | pass | pass | pass | fail |
| Use a connector the agent was given | pass | pass | pass | pass | pass | fail |
| Answer from a project note | pass | pass | pass | pass | pass | pass |
| Save a preference to the vault | pass | pass | pass | pass | pass | pass |
| Use something the user said earlier in the thread | pass | pass | pass | pass | pass | pass |
| Escalate once when the saved login is wrong (expects 1 ask) | pass, 1 ask | pass, 1 ask | pass, 1 ask | pass, 1 ask | fail | fail |
| Ask once for a detail nobody has (expects 1 ask) | pass, 1 ask | pass, 1 ask | pass, 1 ask | fail, 1 ask | pass, 1 ask | pass, 1 ask |

## Why tasks failed

- opencode-go/claude-haiku-5-5, missing-detail: sent: Hello Northwind sales team, I would like a quote for your cheapest plan for my team of 12 seats. Ple
- opencode-go/gpt-6-luna, wrong-password: never asked the user; 1 failed sign-ins, 0 asks
- opencode-go/glm-5.3-flash, weekly-reminder: no repeating job
- opencode-go/glm-5.3-flash, one-time-reminder: a turn ended error: OpenCode: Aborted; no one-time job (error: OpenCode: Aborted)
- opencode-go/glm-5.3-flash, close-ticket: a turn ended error: OpenCode: Aborted; check failed: ENOENT: no such file or directory, open '<temp file> (error: OpenCode: Aborted)
- opencode-go/glm-5.3-flash, wrong-password: never asked the user; 2 failed sign-ins, 0 asks

Costs are what OpenCode reported for each turn, plus any model calls Ravnir's tools made. Generated from 6 result files.
