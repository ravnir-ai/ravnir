# Security

Ravnir is pre-alpha software for one owner running persistent agents. Only the current development version is maintained; no long-term security support window has been established.

## Reporting a vulnerability

Use the repository's private vulnerability reporting feature if it is available under Security, Advisories, Report a vulnerability. If that option is unavailable, contact the maintainer privately through the channel you used to obtain this checkout and ask for a private reporting channel. No dedicated security email or response-time commitment is currently published.

Include the affected revision, installation mode, reproduction steps with synthetic data, expected behavior and observed impact. Never post real credentials, conversation exports or an exploit against another person's installation in a public issue. Ordinary bugs can use the bug report template.

## Trust boundaries

- **One owner.** Signing into the app gives access to agent conversations, settings, files, terminals and live computers. Agent groups are organizational; they are not separate user accounts or security boundaries.
- **Real host access.** In host mode, commands run with the server account's filesystem and network permissions. Workspace file tools have path checks, but those checks do not sandbox arbitrary shell commands. Use a dedicated unprivileged account or container with only the access it needs.
- **Optional agent containers.** Per-agent computers can use Podman or Docker. Their isolation depends on runtime settings, mounts and network access. They do not protect against a compromised host or container runtime. Do not mount unrelated private files or a runtime socket into agent computers.
- **Approvals.** Shell, external files, saved logins and plugin write tools have approval policies. An allow rule grants that capability to the agent. Approvals reduce accidental actions; they do not make hostile web pages, model output or tools trustworthy.
- **External services.** Models receive prompts, conversation context and tool results needed for a task. Browsing reaches external websites. Plugins and connectors can send data to their services. Review the services you connect and their permissions.
- **Shared notes.** Agents deliberately share knowledge through the vault. Notes and git history are not a credential store. The secret scanner blocks recognizable patterns, not every possible sensitive value.

## Network and sign-in

The server defaults to `127.0.0.1:3847`. Listening on a non-loopback address requires both `RAVNIR_USER` and `RAVNIR_PASSWORD`. The installer configures sign-in and supports private Tailscale access or a domain behind HTTPS. Protect any reverse proxy and its forwarded headers; do not expose an unencrypted sign-in endpoint to the internet.

App sessions use random tokens, with token hashes stored on disk, and expire after 90 days. One-time pairing codes expire after 15 minutes. Revoke app sessions from Settings, Security when a device is lost. Basic authentication remains available to scripts; revoking app sessions does not change the configured Basic authentication password.

The terminal and live desktop use the app's authentication and origin checks. An agent's built-in MCP endpoint uses a separate bearer token, which does not authorize the owner's terminal or live view. Treat that token as a secret because it authorizes the tools exposed to that agent.

## Data and backups

The data directory contains private conversations, notes, downloaded files, artifacts, browser profiles and credentials. Keep it outside source control and restrict access to the account running Ravnir. Browser cookies and files are not covered by the encrypted secrets vault.

Saved credentials are encrypted at rest with AES-256-GCM. By default the key is `data/master.key`, mode `600`; `RAVNIR_SECRET` can supply the vault passphrase instead. Encryption does not protect credentials from someone who can run code as the server account and read both the key and the data. Losing the key or passphrase loses access to those credentials.

The saved-login tool fills a password on the server and returns sign-in status rather than the password. A trusted shell still has the server account's access. Connector environment variables and headers may also be materialized in an agent's local OpenCode configuration, which must remain private.

The export archive includes state, conversations, artifacts and vault history. Workspaces are optional. Saved secrets and the vault deploy key are included only with an export passphrase of at least 10 characters, using scrypt and AES-256-GCM. **The rest of the archive is not encrypted.** Protect the entire archive when storing or sending it.

Restore is restricted to an installation with no agents. Browser profiles, browser sign-ins, installed tools, app sessions and push registrations are excluded. Keep a separate protected backup of the full data directory and deployment configuration if you need to recover the entire machine. Never commit either backup or real configuration secrets.

## Before enabling access

Use HTTPS or a private tunnel, keep sign-in enabled for remote access, limit the server account's permissions, and review each agent's policies and connected tools. Keep the runtime, browser and dependencies updated. Review code and configuration changes before running them with your own accounts.
