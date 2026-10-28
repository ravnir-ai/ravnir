# Configuration

Ravnir reads environment settings on startup. The installer saves its choices outside the repository; a source checkout defaults to a `data/` directory and a loopback listener. Do not commit real environment files or print secret values in issue reports.

| Setting | Default | Purpose |
| --- | --- | --- |
| `RAVNIR_HOME` | `./data` | Agent state, conversations, credentials and browser profiles. |
| `RAVNIR_HOST` | `127.0.0.1` | Bind address. A non-loopback address requires sign-in. |
| `RAVNIR_PORT` | `3847` | HTTP port. |
| `RAVNIR_USER`, `RAVNIR_PASSWORD` | unset | Sign-in credentials. Configure both for remote access. |
| `RAVNIR_PUBLIC_URL` | derived | Address used to reach Ravnir, including in OpenCode MCP configuration. |
| `RAVNIR_SECRET` | unset | Vault passphrase instead of the generated `master.key`. |
| `RAVNIR_VAULT` | unset | `local` creates a shared git notes vault under the data directory. |
| `RAVNIR_VAULT_DIR` | unset | Path to an existing notes clone. |
| `RAVNIR_OPENCODE` | unset | `managed` starts an installed OpenCode executable with its own configuration and credentials. |
| `RAVNIR_OPENCODE_PORT` | `4097` | Port for the managed OpenCode process. |
| `RAVNIR_OPENCODE_URL` | unset | An existing OpenCode endpoint; a connection can also be saved in Settings, Models. |
| `RAVNIR_OPENCODE_PASSWORD` | unset | Password for that existing OpenCode endpoint. |
| `RAVNIR_OPENCODE_STALL_MS` | `120000` | How long an idle OpenCode session may go with no visible change before the turn starts a fresh session or moves to a backup model. |
| `RAVNIR_OPENCODE_BUSY_STALL_MS` | `300000` | The same limit for a session that reports itself busy. |
| `RAVNIR_OPENCODE_TOOL_STALL_MS` | `930000` | The same limit while a tool call is still running (the 15 minute tool timeout plus a margin). |
| `RAVNIR_REPLY_WAIT_CHAT_MS` | `90000` | How long `message_bot` with wait holds a turn the user is waiting on in chat or voice. Routines and agent to agent turns wait 240 s; a later reply still comes back as a new message. |
| `RAVNIR_MODEL_URLS` | unset | Extra discovery endpoints, comma-separated. |
| `RAVNIR_CHROMIUM` | detected | Explicit browser executable. |
| `RAVNIR_AI_MEMORY` | on | `off` disables automatic optional ai-memory connector provisioning. The shared vault works without it. |
| `RAVNIR_BOX` | off | `podman` or `docker` enables optional per-agent computers. |
| `RAVNIR_SEARCH_MARKET` | from the owner's language | Market for web searches, such as `es-ES` or `en-GB` (language, then country). Without it, the owner's language in Settings, You picks one (Spanish is `es-ES`); with neither, each search engine uses its worldwide default. |
| `RAVNIR_LOCAL_PROJECTS` | unset | Project folders on the Ravnir machine that agents should read directly, as `name=/path;name=/path` (a bare path uses its folder name). Agents running on the host see them in their prompt with a note to use their own terminal instead of ssh; agents on their own computer do not. Missing or unreadable folders are skipped, at most 12. |
| `TZ` | system timezone | Routine scheduling and daily reporting boundaries. |

Settings, Models manages connected model endpoints. Settings also holds owner preferences, default agent settings, device pairing and optional service connections. See [SECURITY.md](../SECURITY.md) for what those connections can access.

Older installations can keep their `TRUEBOT_*` names. `server/env.js` reads them as the corresponding `RAVNIR_*` name when the latter is not already set.

## Speech and fast decisions

Browser speech works without a separately configured speech server, subject to browser support. For a compatible speech endpoint, use `RAVNIR_STT_URL` and `RAVNIR_TTS_URL`, with the associated model, voice and API-key settings. ElevenLabs can be connected in Settings, Connections.

Computer use can choose actions with the agent's model, a configured quick model, or optional Jev. These services have their own billing; no fixed third-party price is promised here.

| Setting | Default | Purpose |
| --- | --- | --- |
| `RAVNIR_QUICK_URL`, `RAVNIR_QUICK_MODEL` | unset | An OpenAI-compatible endpoint and model for the short first reply that says what an agent is about to do, and for choosing computer-use actions. Without them, an agent on an OpenAI-compatible model uses its own model and an OpenCode agent skips the first reply. |
| `RAVNIR_QUICK_API_KEY` | unset | API key for that endpoint. |
| `RAVNIR_QUICK_PRICE` | unset | Its price as `input,output` in dollars per million tokens, so its tokens are costed in the ledger. |
| `RAVNIR_QUICK` | on | `off` turns the quick model off. |
| `RAVNIR_TYPESAFE_KEY` (or `TYPESAFE_API_KEY`) | unset | Turns on Jev, an optional speed-up for choosing browser and desktop actions. |
| `RAVNIR_TYPESAFE_ENDPOINT`, `RAVNIR_TYPESAFE_MODEL` | the service defaults | Override Jev's endpoint and model. |

## Desktop computer use

`desktop_task` (native apps on a Linux desktop) needs `Xvfb`, `xdotool`, `ffmpeg` and `tesseract` on the server. The server image from `install.sh` includes them; on a source install without them the tool is not offered, and browser computer use still works.

## 1Password

Saved logins work without 1Password. To fill logins from 1Password, install the `op` CLI on the server and paste a service account token in an agent's Logins panel; the token is stored encrypted, and passwords are read at fill time without entering the model. Environment alternatives:

| Setting | Purpose |
| --- | --- |
| `RAVNIR_OP_SERVICE_ACCOUNT_TOKEN` (or `OP_SERVICE_ACCOUNT_TOKEN`) | Service account token, instead of pasting it in Logins. |
| `RAVNIR_OP_BIN` | Path to the `op` executable when it is not on `PATH`. |
| `RAVNIR_OP_ACCOUNT` | Account to use when the CLI knows several. |

## Live status feeds

A project note can carry a live status block refreshed from your own data. Feeds are listed in `status-feeds.json` in the data directory (or the file named by `RAVNIR_STATUS_FEEDS`), one object per feed with at least `note` (the project note) and `type`. Each `type` is served by a collector module in `local/status/` (or the folder named by `RAVNIR_STATUS_DIR`) that exports `kind` (the type it serves) and `collect(feed, { now })`, which returns `{ ok: true, text }` or `{ ok: false, error }`. Ravnir ships no collectors; `local/` is ignored by git.

## Local checks

Run `npm run doctor` for a source installation or `./install.sh doctor` for an installer-managed deployment. Review diagnostic output before sharing it. Settings, Server exposes configuration metadata and only an allowlist of values; sensitive settings are not displayed there.
