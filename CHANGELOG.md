# Changelog

All notable changes to Ravnir are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-28

First public release, public beta.

### Added

- Persistent agents, each with a name, job, group, model, custom instructions, a continuing thread, a workspace and downloads. Closing the tab does not stop a turn.
- Models and providers through OpenCode or any OpenAI-compatible API, including local servers such as LM Studio and vLLM, with one model picker and provider sign-in in Settings.
- Browser and computer use: Playwright browser tools, step-by-step computer use, a Linux desktop per agent, and a live view you can take over to sign in yourself. Jev is an optional speed-up.
- Open sites from your Mac: a site that refuses the server's network (Cloudflare, Akamai, Imperva and similar) opens from a linked Mac for every agent, or an agent opens everything from the Mac or through a proxy you set. Agents get a plain note when a site stays blocked instead of guessing other addresses.
- An optional container computer per agent (rootless Podman or Docker) with resource limits, plus an interactive terminal.
- Shared memory in a git vault of Markdown notes, with agent-authored commits, proposals you approve, a secret check on writes, and source chips in replies.
- A Memory page with timeline, diffs, backlinks, Obsidian links and revert as a new commit.
- Approvals and permissions: per-agent rules for commands, files and saved logins, an approval inbox, and encrypted saved logins whose passwords never enter the model.
- Cost on every reply, a usage ledger, and daily and monthly caps with a warning at 80 percent.
- Documents: agents make PDF reports, Word documents, Excel workbooks and PowerPoint decks, with charts, and hand them over as file cards. Four built-in skills teach the formats and what a good one looks like. They also read the PDF, Word, Excel and PowerPoint files you attach, sheets with formulas and slides with notes included.
- Routines and one-time reminders with plain-language scheduling, failure alerts in Home, stuck-turn alerts, and quiet runs when there is nothing new.
- `ask_user` questions, repeat blocking and retry tracking so agents try again before asking, with tappable choice cards.
- Plugins and MCP connectors (stdio and HTTP), including a built-in Gmail plugin and OAuth sign-in for remote servers.
- An installable phone web app with device pairing, push notifications, approvals and questions.
- Voice mode with browser speech, a compatible speech server, or optional ElevenLabs.
- Agent-to-agent messaging, broadcasts to groups, @mentions, and agent creation by agents.
- Team routing: `ask_team` sends a question to the teammates whose job, skills and plugins fit best, one at a time, until one answers; a teammate that cannot help passes. A chat reply that gives up without asking the team is asked once to check with a teammate first.
- A Skills shop with 30 curated skills (licenses and pinned sources shown) you give each agent, and agents that search the shop and the plugin catalog and ask for what they need with a card you approve.
- Saved artifacts (documents, code, charts, diagrams, HTML) with a viewer and version history.
- An install script for Linux (Tailscale, your own domain with HTTPS, or this computer only) and a `doctor` check.
- Backup export and restore from the Memory page, with saved secrets included only under a passphrase.
- An evaluation suite of 18 tasks and a model report card with recorded results, failures and costs.

### Known limits

- Pre-alpha. The 24-hour routine reliability test is not finished, and the installer has not yet been validated on a small amd64 VPS.
- Designed for one owner with many agents. Native mobile apps, multiple owners and single sign-on are not implemented.
- Agents in host mode share the permissions of the server account. Per-agent container computers are optional.
- Push support depends on the browser and device.
- Opening sites from the Mac needs the Mac online, and does not apply to agents with their own container computer yet. A "Verify you are human" check still needs you once, through Take control.
- The secret check recognizes common patterns only, and git history keeps earlier versions of notes. Do not put credentials in notes.
- Revert cannot undo every change, including changes that conflict with later edits.
- The backup archive as a whole is not encrypted. Restore is for an installation with no agents, and does not bring back browser profiles, browser sign-ins, installed tools, app sign-in sessions or push registrations.
- Model results in the report card are single runs per model and task, not a promise of future behavior.
