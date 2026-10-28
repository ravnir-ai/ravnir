# Ravnir: guide for contributors and their coding agents

Ravnir is an open-source server for persistent AI agents. Each agent has a job, a model, a continuing thread, its own workspace and browser, scheduled routines, approval rules and encrypted saved logins. All agents share one memory: a git repository of Markdown notes that you can read, review and revert. You use it from a computer or from a phone, through an installable web app. Ravnir is pre-alpha, written for one owner with many agents.

Start with [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [docs/configuration.md](docs/configuration.md). This file is the short version for people and agents who change the code.

## Layout

- `server/`: HTTP routes, turns, models, approvals, ledger, scheduling, browser and desktop tools, persistence. `server/index.js` is the entry point.
- `server/vault/`: Markdown indexing, context for turns, git writes, proposals, history and revert.
- `public/`: the web app. Plain JavaScript modules and CSS, served as they are.
- `bin/`: command line helpers (`doctor`, `backup`, the Gmail and vault MCP servers, the connector launcher).
- `box/`: the image and scripts for the optional per-agent container computer.
- `evals/`: isolated tasks that run real models. They can cost money; read `evals/README.md` first.
- `test/`: Node's built-in test runner, mock services and Playwright browser tests.
- `scripts/`: build helpers, mock servers and the public-export checks.
- `docs/`: configuration, roadmap, model report card and design notes.
- `Dockerfile`, `compose.yaml`, `install.sh`: the Linux installer and server image.

## Where to look

- Turns and tool calls: `server/turn.js`, `server/index.js`, `server/mcpBuiltin.js`.
- Approval rules and command checks: `server/policy.js`, `server/approvals.js`.
- Cost, caps and the usage ledger: `server/ledger.js`.
- Browser, desktop and computer use: `server/browser.js`, `server/computer.js`, `server/drive.js`, `server/desktop.js`.
- Per-agent containers and the terminal: `server/box.js`, `server/terminal.js`, `box/`.
- Shared memory: `server/vault/` (`writer.js` for commits, `history.js` for the timeline and revert).
- Routines: `server/jobs.js`. Questions to the owner: `server/asks.js`.
- Teamwork and asking for tools: `server/collaboration.js` (`message_bot`, `ask_team`), `server/recommend.js` (skill and plugin suggestions), `server/skills.js`, `server/plugins.js`.
- Backup and restore: `server/backup.js`. Installation checks: `server/doctor.js` and `install.sh`.
- The web app: `public/app.js` and the modules next to it (`memory.js`, `home.js`, `settings.js`, `studio.js`).

## Run it

Node.js 22 or newer, git, and Python 3 (for the interactive terminal).

```bash
npm ci
npx playwright install chromium
RAVNIR_VAULT=local npm start
```

The app listens on `127.0.0.1:3847`. Use a throwaway data directory while developing, for example `RAVNIR_HOME=./data/dev`, and never point tests at a real installation. Set `RAVNIR_AI_MEMORY=off` when you do not run the optional ai-memory connector.

## Test it

```bash
npm test
```

CI runs the terminal suite on its own, because a PTY test can hang in a shared process. Reproduce that split with:

```bash
node --test --test-timeout=180000 $(ls test/*.test.js | grep -v terminal)
node --test --test-timeout=120000 test/terminal.test.js
```

Run the focused file while you work, for example `node --test test/cost.test.js`. Install Chromium first: some browser tests skip without it, and a green run that skipped them is incomplete evidence. Real container tests are opt-in (`RAVNIR_TEST_BOX=podman` or `docker`). Live-model evals are opt-in too.

Before you open a pull request, `npm run check:public` must pass. It scans the checkout for private data: public IP addresses, personal home paths, email addresses, tailnet host names, key material and token shapes. Use synthetic values in code, tests and docs (`example.com`, `/Users/you`, documentation IP ranges). A line that must contain a match on purpose can carry a marker that names the rules it exempts, for example `check-public: allow email` or `check-public: allow token,private-key`. A marker that names no rule is itself a finding, and the private deny list cannot be exempted. Binary files must be reviewed by a maintainer and listed in `export/binaries.txt` of the private repository before they can ship.

## Conventions

- ES modules, no build step, no frontend framework. Match the surrounding style: 2-space indent, double quotes.
- Tests use `node:test` and `node:assert`. UI behavior is tested with Playwright against a real server started on a free loopback port with a temporary `RAVNIR_HOME`. A behavior change needs a regression test that fails without the fix.
- Security rules are enforced on the server, never only in the UI. Approval policies, path checks, origin checks and the sign-in requirement for non-loopback listeners live in `server/`.
- Secrets never enter model context. Saved passwords are filled by the server; provider keys and connector credentials live in the encrypted vault (`server/secrets.js`). Do not change the key derivation salt, because every saved secret would become unreadable.
- Child processes that run code or content Ravnir does not control get a minimal environment from `server/childEnv.js`. Do not pass `process.env` through.
- Settings are `RAVNIR_*` environment variables. Older `TRUEBOT_*` names are still read by `server/env.js`; do not rename stored data without a migration.
- No telemetry, no phoning home. Keep new dependencies justified.
- Keep the UI accessible: keyboard reachable controls, mobile layouts at phone width, visible errors.

## Writing style

User-facing text (UI strings, docs, README, error messages) is plain and specific. Never use em dashes or en dashes; use commas, periods or parentheses. Avoid "X / Y" slash pairs in prose. Do not invent numbers, results or names, and state exactly what a test run did and did not verify.

## Do not

- Commit data directories, browser profiles, recordings, backups, `.env` files or evaluation results that contain private material.
- Add real hostnames, addresses, accounts or personal names anywhere in the repository.
- Decompile another product, copy its prompts or assets, or read its credentials.
- Push, publish or deploy on behalf of the owner without being asked.
