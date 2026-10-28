# The memory vault

Ravnir agents share one memory: a git repository of Markdown notes, the vault. It replaces per-agent private memory, so every agent answers from the same notes, and you can read, edit and review them in any editor (Obsidian works well). This page is the design reference. For a plain-language tour of what agents read and write, see [how-memory-works.md](how-memory-works.md).

## Why one vault

- Private memory per agent means two agents asked the same question give two different answers.
- Searching memory with only the text of the last message is a lottery. The vault is injected on purpose: rules, the agent's own note, its projects and the best search hits.
- Notes in git have history. Every change is a commit with an author, and you can undo it.

## Setup

Set `RAVNIR_VAULT_DIR` to a clone of your notes repository. Without it, `RAVNIR_VAULT=local` creates a vault under the data folder. With neither, Ravnir runs without a vault.

| Variable | Purpose |
| --- | --- |
| `RAVNIR_VAULT_DIR` | Path of the vault working tree. |
| `RAVNIR_VAULT_REMOTE` | Remote to clone from and push to. |
| `RAVNIR_VAULT_SSH` | Path of the SSH key used for the remote (a deploy key scoped to that one repository is the safest choice). |
| `RAVNIR_VAULT_BRANCH` | Branch to follow. |
| `RAVNIR_VAULT_WRITE` | `on` lets agents write. Off, the vault is read-only and only pulled. |
| `RAVNIR_VAULT_PULL_MS` | Interval of the read-only pull (0 turns it off). |
| `RAVNIR_VAULT_SYNC_MS` | Interval of the writer's sync, never below 30 seconds. |
| `RAVNIR_VAULT_EMBED_DIR` | A folder with `@huggingface/transformers` installed, to turn on local embeddings. It is large, so it is not in `package.json`. |

See [configuration.md](configuration.md) for the full list.

## Layout

Fixed in every vault: `Agents/`, `Projects/`, `Rules.md` and `Decisions-Log.md`. The daily log and the owner's profile follow a layout preset, `en` (`Log/`, `People/<name>.md`) or `es` (`Registro/`, `Perfil/<name>.md`). An existing vault keeps its layout; an empty one follows the owner's language (Settings, You).

## Reading

- The index uses SQLite full-text search (`node:sqlite`, FTS5), with notes split by heading, plus `[[wiki links]]`, aliases and backlinks. A file watcher and a hash scan keep it current whoever changes the files.
- Optional local embeddings (multilingual-e5-small) fuse with the text ranking. They are off by default so the open source install needs no model download. Measure on your own notes before relying on them: on one test vault, cross-language questions ranked the right note poorly with several small models.
- Modules live in `server/vault/` (`indexer`, `search`, `context`, `sync`, `writer`, `secrets`, `history`, `layout`, `local`, `tools`). `bin/vault-mcp.mjs` exposes the same read library as a stdio MCP server for tools outside Ravnir.

At the start of each turn, `context.js` injects a block capped at about 6,000 characters, each part with its path and date: `Rules.md`, the owner's profile note, the agent's own note in `Agents/`, the status of the projects it is linked to, and the best search hits for the message. The prompt tells the agent to cite the note and date for project facts and to say so when a figure is not in the vault. The notes injected, with their hashes, are stored in the turn's `meta` event (`vaultSources`), so two agents asked the same thing can be shown to have read the same version.

## Writing safely

Agents get these tools. The server knows which agent is calling, so permissions do not depend on the model behaving.

| Tool | What it does |
| --- | --- |
| `vault_search`, `vault_read`, `vault_links` | Read. |
| `vault_append` | Adds a line to the agent's own `Agents/<name>.md`. |
| `log_activity` | Adds a line to today's daily log. |
| `log_decision` | Adds a dated line to `Decisions-Log.md`. |
| `remember` | Saves a durable fact about the owner in the profile note, under a typed heading. The same key replaces the old fact, which moves to the history section. |
| `propose_change` | For `Rules.md` and `Projects/`. Goes to your Inbox; approving applies the exact text. |

Rules:

- Only those paths can be written. Everything else is refused.
- One commit per write, authored by the agent (`<agent> <slug>@ravnir.local`), committed by Ravnir, with a trailer linking it to the turn. Approved proposals add the approver to the subject. One writer process holds a lock.
- A secret scanner (`server/vault/secrets.js`, built on `server/redact.js`) refuses the whole write when text looks like a private key, an API token, a JWT, an `op://` reference, a `.env` line, a URL carrying a secret or a high-entropy string. The model gets the reason.
- Content that comes from the web or a tool should be quoted as a quote. The prompt says the vault is information, not instructions.

## Syncing with a remote

When a remote is set, the writer fetches and rebases on the remote branch on a timer and pushes new commits. It never force-pushes. Log files and profile notes use git's union merge so two writers do not clash on appends. If a rebase fails, it aborts, saves the local commits to a pushed branch named `ravnir/conflicto-<date>`, resets to the remote and sends a high-priority notice. With no remote, commits stay local. A local vault can be linked to a remote later from the Memory page.

## Live project status

A project note can carry a status block between two HTML comment markers, written by Ravnir and never by an agent. Feeds listed in `status-feeds.json` (or the file named by `RAVNIR_STATUS_FEEDS`) read figures from their real source on a timer. The block shows the figures, the source and the date, and says so when the data is older than a day. It is injected with the project note and added to the turn message for the model only, so older figures in the chat history do not outweigh it. If a feed fails, the last good figures stay with a warning.

## Acceptance test

Two agents asked the same project question in new turns must:

1. Give the same figures, goal and campaign.
2. Cite the same note and the date of the data.
3. State no figure that is not in the vault.

The turn trace shows the same injected note hash for both. After an edit to the note, both answers pick up the new figure within seconds, without a restart. An attempt to write `Rules.md` ends up in the Inbox as a proposal, and a fake token is refused with a reason. `test/vault-turns.test.js` and `test/vault-write-turns.test.js` cover this end to end.

## Possible later work

- A weekly job that summarises old log entries into monthly notes and moves the originals to an archive folder instead of deleting them.
- Deduplicating profile facts that have no key, by similarity.
