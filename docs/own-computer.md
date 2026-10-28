# Own computer per bot

## Goal

Every agent can get a real Linux computer of its own: root inside it, `apt install` anything, run services that keep running between turns, a desktop with a browser, and an interactive terminal in the Shell tab. You can use the same terminal with full access. The agent stays inside the approval rules it has today.

## Without a box

- Agents run as the same unprivileged user as the server. No root, no apt.
- `run_command` spawns a shell on the host with `HOME=data/bots/<id>`, so user-level installs (npm, pip, uv, cargo, bun) persist in that folder.
- One Xvfb desktop per agent (`server/desktop.js`), headful Playwright Chromium on it (`server/browser.js`), screenshots and input through ffmpeg and xdotool.
- The approval rules (`server/policy.js`) gate `run_command` and saved logins before anything runs. OpenCode's own bash tool follows the same rules through the `permission` block Ravnir writes to each agent's `opencode.json`.

Two problems besides the missing root:

1. Every agent shares the server's user. An agent allowed to run commands can read `data/state.json`, `data/secrets.enc`, `data/master.key` and every other agent's files. The approval rules are the only wall.
2. Every agent can reach every loopback service on the host.

## Options

| | Rootless Podman per bot | systemd-nspawn per bot | One shared VM | Rootful Docker or Incus |
| --- | --- | --- | --- | --- |
| Root inside | yes (mapped to an unprivileged host uid) | yes | yes | yes |
| Bot isolated from the server and other bots | yes, own user namespace, mounts and network | yes | from the host yes, from each other no (unless containers inside the VM) | yes |
| Root needed on the host | once, to install podman and add a subuid range | every start (`machinectl`), so the service user would need a sudo rule or setuid helper | once, but a VM to run and patch | always: the docker socket or `incus-admin` group is root-equivalent for the service user |
| Per-bot limits | cgroup v2 memory, CPU, pids | systemd slice limits | VM total only | yes |
| Disk | one shared image, one thin layer per bot | one full root filesystem per bot (about 500 MB each, no sharing) | one disk image | shared image |
| Start time | about 1 s | about 2 s | 20 to 40 s once, then containers | about 1 s |
| Idle RAM per bot | about 60 MB (Xvfb, openbox, tini) | similar plus systemd | 2 to 4 GB reserved for the VM | similar |
| Works on the Mac for development | yes (OrbStack Docker or Podman machine, same CLI) | no | partly | yes |
| Ops on the server | low: CLI plus Quadlet units | medium | high: a second machine to maintain | low, but a root daemon |

Decision: **rootless Podman, one container per bot.** It is the only option that gives root inside without making the service user root-equivalent on the host, isolates the agents from the server's data, and shares one image. systemd-nspawn would need a privileged helper on every start. A shared VM isolates the host but not the agents from each other, and costs gigabytes of fixed RAM. Rootful Docker and Incus would turn the service account into root on the host.

A per-bot microVM (Firecracker or Kata, possible because `/dev/kvm` exists) is the stronger option if a box ever needs to run untrusted code from strangers. It is not needed for your own agents and needs root for every start.

## Design

### Image

`box/Dockerfile`, tag `ravnir-box:3`:

- `ubuntu:24.04`, the same release as a typical server, so `pip --user` packages built for Python 3.12 and npm or cargo binaries copied from today's box homes keep working.
- `tini` as PID 1 (`--init`), so processes a bot leaves running are adopted and reaped.
- Desktop: Xvfb, openbox, xdotool, ImageMagick (screenshots), x11-utils, fonts with emoji.
- Browser: Playwright Chromium, pinned to the same Playwright version as the server (`--build-arg PLAYWRIGHT_VERSION`), so the DevTools protocol matches what the server's Playwright expects.
- Dev tools: Node 22 (official tarball, checksum verified), Python 3 with pip, venv and pipx, build-essential, git, curl, wget, jq, ripgrep, tmux, socat, ssh client, nano, unzip.
- `/opt/ravnir/term-bridge.py` (the terminal bridge) and `/opt/ravnir/box-start.sh` (starts Xvfb and openbox, then waits).

One image is shared by all boxes. A bot's own changes live in its container layer.

### One container per bot

```
podman run -d --name ravnir-box-<bot id> --hostname <bot name> --init \
  --memory 2g --cpus 2 --pids-limit 2048 --shm-size 1g \
  --label ravnir.bot=<bot id> \
  -v <data>/bots/<id>/workspace:<same absolute path> \
  -v <data>/bots/<id>/box/root:/root \
  -v <data>/bots/<id>/browser-profile:/root/.config/ravnir-browser \
  -w <workspace> ravnir-box:3
```

- Root inside the box is uid 0 in its own user namespace. On the host it is the service user or a subuid, so it has no power over the server.
- The workspace is mounted at the **same absolute path** it has on the host. OpenCode runs on the host and edits files by host path; inside the box the same path works, so tool output, diffs and file links agree.
- The box sees its workspace, its own `/root` and its browser profile. It does not see `data/state.json`, `secrets.enc`, `master.key`, other bots, its settings folder or other accounts' files.

### What persists

| Layer | What lives there | Survives |
| --- | --- | --- |
| Container layer | `apt install`, `/etc`, `/usr/local`, services, anything outside the mounts | stop and start, server restarts, reboots. Lost on Reset or an image upgrade |
| `/root` (bind mount) | dotfiles, `~/.local`, npm globals, pip user packages, ssh config, tmux sessions' files | everything, including Reset |
| Workspace (bind mount) | the bot's files, diffs, `opencode.json` | everything |
| Browser profile (bind mount) | cookies and signed-in sessions | everything |
| `/root/.ravnir/setup.sh` | a recipe the bot appends to when it installs system packages | replayed after an image upgrade or Reset |

Before an image upgrade Ravnir can `podman commit` the old box to `ravnir-box-<id>:backup` so nothing is lost if the recipe is incomplete.

### Lifecycle

If Ravnir runs as a systemd service with `KillMode=control-group`, anything left in its cgroup dies on every restart. Rootless Podman avoids that on its own: with linger on, the service user's manager runs, Podman uses its systemd cgroup manager, and conmon and the container land in scopes under `user@<uid>.service`, not in the Ravnir service. Restarting Ravnir leaves the boxes running.

After a reboot a box is stopped until its next use, when Ravnir starts it again (the container layer and everything installed in it are still there). Services a bot wants back right away go in `/root/.ravnir/autostart.sh`. If boxes should come back by themselves at boot, the next step is a **Quadlet unit per box under the service user's manager** (`~/.config/containers/systemd/ravnir-box-<id>.container`), or enabling the user's `podman-restart.service`.

Boxes start on first use (a command, the terminal, the browser or the desktop). They keep running between turns so services stay up. An optional idle stop (`RAVNIR_BOX_IDLE_HOURS`) can stop boxes nobody used for a day; files stay.

### How Ravnir reaches the box

| Path | Today | With a box |
| --- | --- | --- |
| `run_command`, `box_info` | `spawn(shell, ["-lc", cmd])` on the host | `podman exec -i -w <workspace> <box> timeout -k 5 <s> bash -lc <cmd>`. The timeout runs inside the box because killing the exec client does not kill the command |
| Shell tab | one-shot `POST /terminal` | interactive xterm.js over a WebSocket; see below |
| Desktop | host Xvfb, ffmpeg, xdotool | Xvfb `:1` inside the box. Screenshot is `import -window root png:-` through exec; clicks and keys are `xdotool` through exec. 100 to 200 ms per call |
| Browser | Playwright `launchPersistentContext` on the host | Chromium inside the box on `:1`, DevTools on the box's own loopback port 9222. Playwright `connectOverCDP` through a gate (below) |
| `desktop_task` OCR | Tesseract on the host | unchanged: the screenshot comes from the box, OCR stays on the host |

**The browser gate.** Port 9222 is never published, because any account on the server could then drive the bot's browser. The server reads the browser's random DevTools path (`/devtools/browser/<guid>`) through exec, listens on `127.0.0.1` on a random port, accepts only a WebSocket upgrade for that exact path, and pipes each accepted connection through `podman exec -i <box> socat STDIO TCP:127.0.0.1:9222`. The guid never leaves the server process, so knowing the port is not enough. On the hub this can later become a unix socket in `data/bots/<id>/box/run/` (directory mode 700, socat listening inside the box), which saves one exec per connection.

Chromium runs with `--no-sandbox` inside the box. Its own sandbox needs nested user namespaces, which rootless containers do not grant by default. The box is the sandbox: a compromised renderer lands as root in the bot's user namespace, not on the hub.

### Resource limits

Per box: 2 GB memory (swap at the runtime's default), 2 CPUs, 2048 processes, 1 GB `/dev/shm` (Chromium needs it). All configurable (`RAVNIR_BOX_MEMORY`, `RAVNIR_BOX_CPUS`, `RAVNIR_BOX_PIDS`).

Budget, as an example for 14 agents on a 16 GB server: idle boxes about 60 MB each (under 1 GB together); a box with Chromium open 300 to 600 MB. If all 14 browsers were busy at once that is about 8 GB, inside the 12 GB or so that is free. The memory limit makes one runaway bot kill its own processes, not the hub.

Disk: rootless overlay on ext4 cannot enforce a per-container size (that needs XFS with project quotas). Ravnir measures each box's layer and mounts hourly (`podman ps --size`, `du`) and shows a warning in Today above 15 GB. A hard quota is possible later with a loop-mounted image per bot.

Cgroup delegation: the box limits need `cpu memory pids` delegated to the service user's slice. After enabling linger, check that `/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/cgroup.subtree_control` lists them.

### Networking

Rootless default network (slirp4netns on Podman 4.9; pasta when installed). Outbound internet works. Nothing is published inward.

The host's loopback services are **not** reachable from the box (slirp4netns runs with `allow_host_loopback=false` by default). That is stricter than today, where every bot can reach ai-memory, OpenCode and other accounts' loopback ports. This must be verified before rollout with `curl 10.0.2.2:49374` and `curl 127.0.0.1:4098` from inside a box (both should fail).

The box can still reach anything the server reaches on the network, including tailnet peers. Bots that should be offline get `--network none`. A bot's own dev server (for example on port 3000 inside its box) can be previewed later through `GET /api/bots/:id/port/3000/`, proxied with the same exec and socat path, never published.

### Approval rules

Nothing changes in `server/policy.js`. The rules run before anything executes; only the executor changes.

- `run_command` (OpenAI loop and the built-in MCP endpoint that OpenCode uses) still goes through `guardTool`, `shellDecision` and the approval inbox, then runs in the box instead of on the host.
- OpenCode's own `bash` tool runs wherever OpenCode runs, which is on the host. For a bot with a box, Ravnir writes `permission.bash: "deny"` into its `opencode.json`, and the prompt tells it to use `run_command`. Every command of that bot then goes through the same gate and runs in the box.
- OpenCode's file edits stay as they are: they touch the bot's workspace, which is the same folder inside the box. `external_directory` keeps meaning host paths outside the workspace.
- With a box, "Allow all" becomes a reasonable choice for many bots, because the blast radius is the box, its workspace, its browser profile and its network, not the server.

### Interactive terminal

- xterm.js in the Shell tab, over a WebSocket at `/api/bots/:id/terminal/ws`.
- Only the signed-in user: the upgrade needs the session cookie or Basic auth, and its `Origin` must match the `Host` (this blocks cross-site WebSocket hijacking, since browsers send cookies on cross-site WebSocket requests). The bots' MCP bearer token does not open it.
- Full access for the user. It is their computer: a root shell in the box, or a shell as the service user in the agent's workspace for a bot without one.
- The PTY is created by `box/term-bridge.py`, a small Python bridge (no native Node module to build on the server). It runs inside the box (`podman exec -i <box> python3 -I /opt/ravnir/term-bridge.py`) or on the host. Input is framed (one byte type, four bytes length) so resizes travel in band.
- One shell per bot, shared by every open tab or device. Closing the tab keeps it alive for 15 minutes (`RAVNIR_TERMINAL_IDLE_MINUTES`) with the last 200 KB of output replayed on reconnect, so the phone and the Mac see the same session.
- Bots never get the PTY. Their commands stay on `run_command`, gated as above. A bot can start a long job in a named tmux session (through `run_command`, so gated) and the user can `tmux attach -t <name>` from the terminal to watch or take over.

### Take control (live view)

The user can see and drive a bot's real screen live, from the Mac or the phone, and sign in to a site that blocks the agent's automated browser. Files: `server/live.js`, `public/live.js`, noVNC (`@novnc/novnc`, MPL-2.0) served from `/vendor/novnc/` like xterm.

- **Screen.** x11vnc shares the bot's X display, `-localhost -nopw -shared -forever -noxdamage`. Box bots: x11vnc runs inside the box on `:1` (port 5900 on the box's own loopback) and the server bridges one `exec -i <box> socat - TCP:127.0.0.1:5900` per viewer, so nothing is published. Host bots (Linux with Xvfb): x11vnc on a free port of `127.0.0.1`, with the bot's Xvfb and Xauthority. It stops 2 minutes after the last viewer leaves.
- **WebSocket** `/api/bots/:id/live`, binary frames, the RFB bytes and nothing else (what noVNC speaks). Same checks as the terminal: sign-in (cookie or Basic) and `upgradeAllowed` (same origin). A bot's MCP token does not open it, and no tool exposes it.
- **Sign in yourself.** `POST /api/bots/:id/live/takeover` marks the bot's browser handed over (`BrowserManager.hold`: `ensure` throws and every browser and computer tool answers "The user is using the browser right now. Wait for them to hand it back."), closes the agent's browser, and starts the same Chromium as a plain process on the same profile: no DevTools port, no automation flags, no user agent or fingerprint changes. `POST .../live/handback` closes its window (Alt+F4 through `xdotool`: Chromium's own way to quit, which saves cookies and history, where a signal exits at once and loses what it had not flushed yet; a signal and then a kill are the fallback if it will not close), reads the page it ended on from the profile's History database (there is no DevTools port to ask), relaunches the agent's browser on that page and clears the hold. Cookies travel through the profile. A cookie without an expiry (a session cookie) does not survive the browser restart, which is how Chromium works; sites that keep you signed in set one with an expiry. A browser the user walked away with returns to the agent after 30 minutes with nobody watching.
- **The agent can ask.** Tool `ask_user_to_take_over({ reason, url? })` creates an approval of kind `takeover` (it pushes to the phone and shows in Today and in the thread with Take control and Not now) and waits like any approval. Done, hand it back resolves it and the tool returns "The user finished. The browser is back at ...". Declined, expired and cancelled each say so. It is outside the per-turn approval budget.
- **Image.** x11vnc is in `ravnir-box:3`. A box created from an older image has no x11vnc: Live view says "Live view needs the new box image", and Reset (Shell tab) recreates the box on the new image. Reset keeps `/root`, the workspace and the browser profile.

### Migration of today's box homes

Per bot, opt in, reversible.

1. Stop the bot's host browser and host desktop (they hold the browser profile).
2. Copy, not move, the user-level install folders and dotfiles from `data/bots/<id>/` into `data/bots/<id>/box/root/`: `.local`, `.npm-global`, `.cargo`, `go`, `.bun`, `.config`, `.gitconfig`, `.bashrc`, `.profile`, `.ssh`. Caches are left behind (they rebuild). Ravnir's own files (`conversation*`, `events.ndjson`, `diffs.json`, `browser.json`, `desktop/`, `computer/`, `workspace/`, `browser-profile/`) are skipped.
3. Same distro and architecture, so npm globals, pip user packages (Python 3.12) and cargo binaries keep working. The PATH inside the box includes the same `~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `~/go/bin` and `~/.bun/bin`.
4. The browser profile is mounted, not copied, so signed-in sessions carry over. Chromium on Linux without a keyring uses the basic password store; the box passes `--password-store=basic` explicitly.
5. Keys an agent needs from the service user's account (for example an ssh key and its known_hosts line) are mounted read-only into that bot's `/root/.ssh/` through a per-bot mount list that only the user can edit. OpenSSH reads `~/.ssh` from the passwd home, which is `/root` in the box.
6. Rollback: switch the bot back to "This server". The host folders were never changed.

### Setting up rootless Podman on a server (root once)

The subordinate ID range must not overlap anyone else's in `/etc/subuid` and `/etc/subgid`. Pick a free range, here shown as `<start>-<end>`, with about 65,536 IDs. In the commands below `ravnir` stands for the user the Ravnir service runs as and `<uid>` for its numeric id. The installer (`install.sh`) does the equivalent for you.

```bash
sudo apt install podman uidmap slirp4netns passt
sudo usermod --add-subuids <start>-<end> --add-subgids <start>-<end> ravnir
sudo loginctl enable-linger ravnir
# drop-in for the service: [Service] Environment=XDG_RUNTIME_DIR=/run/user/<uid>
sudo systemctl daemon-reload
sudo -u ravnir XDG_RUNTIME_DIR=/run/user/<uid> podman info   # rootless works under AppArmor
sudo -u ravnir XDG_RUNTIME_DIR=/run/user/<uid> podman build -t ravnir-box:3 --build-arg PLAYWRIGHT_VERSION=<the server's Playwright version> /opt/ravnir/box
```

Then set `RAVNIR_BOX=podman` in the service's environment file, restart, switch one low-risk agent to its own computer, verify the loopback isolation and the limits, and let it run for a while before switching the rest. Every step is reversible: `apt remove podman`, `loginctl disable-linger ravnir`, delete the subuid lines.

## Implementation

Off by default. Nothing changes for any agent unless the flag is on and the agent is switched.

| Piece | File |
| --- | --- |
| Image | `box/Dockerfile`, `box/box-start.sh`, `box/browser.sh`, `box/term-bridge.py` |
| Box manager (create, start, exec, desktop, browser gate, migration, status, reset) | `server/box.js` |
| Desktop router (host Xvfb or box per bot) | `server/box.js` (`DesktopRouter`) |
| Browser over CDP for box bots | `server/browser.js` |
| `run_command`, `box_info`, Shell tab on the box | `server/computer.js`, `server/index.js` |
| Interactive terminal (sessions, WebSocket, auth, origin check) | `server/terminal.js`, `server/index.js` |
| xterm.js client | `public/terminal.js` |
| Live view, Sign in yourself, `ask_user_to_take_over` | `server/live.js`, `public/live.js`, `test/live-view.test.js` |
| OpenCode bash routed through `run_command` for box bots | `server/policy.js` (`openCodePermission`) |
| Tests | `test/box.test.js`, `test/terminal.test.js` |

Flags and settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RAVNIR_BOX` | `off` | `podman` or `docker` turns the feature on and picks the CLI |
| `RAVNIR_BOX_IMAGE` | `ravnir-box:3` | Image tag; built on first use when missing |
| `RAVNIR_BOX_MEMORY` | `2g` | Memory limit per box |
| `RAVNIR_BOX_CPUS` | `2` | CPU limit per box |
| `RAVNIR_BOX_PIDS` | `2048` | Process limit per box |
| `RAVNIR_BOX_NETWORK` | runtime default | For example `none` for an offline box |
| `RAVNIR_TERMINAL_IDLE_MINUTES` | `15` | How long a terminal lives after the last tab closes |

Per bot: `PATCH /api/bots/:id {"box": {"mode": "container"}}` (or `"host"`), `GET /api/bots/:id/box` for status, `POST /api/bots/:id/box {"action": "start" | "stop" | "reset"}`. The Shell tab shows which computer the bot runs on and has the switch when the flag is on.

Try it on the Mac with OrbStack:

```bash
RAVNIR_BOX=docker RAVNIR_HOME=/tmp/ravnir-box-demo RAVNIR_PORT=3990 npm start
```

Then open a bot, Shell, "Use its own computer". The first start builds the image (about 2 GB, several minutes).

## Risks and open questions

- AppArmor on Ubuntu 24.04 restricts unprivileged user namespaces. The shipped `podman` profile allows rootless Podman (check it on your server).
- Chromium in the box shows two bars at the top: the "Chrome for Testing" notice and a warning about `--no-sandbox`. Adding `--test-type` to `box/browser.sh` hides the second one.
- Exec latency for desktop screenshots and input (100 to 200 ms). Fine for the Desktop tab and `desktop_task`; a small agent inside the box with one long-lived exec stream would cut it if needed.
- Browser downloads land inside the box (the downloads folder is not mounted at the host path yet).
- The image is about 2 GB. One copy is shared by every box.
- The box can reach the network like the server can, including tailnet peers. `--network none` per bot, or an egress proxy, if that matters for a bot.
- A bot with "Allow all" can use its 2 CPUs for anything (mining, scans). The limits cap the damage; the ledger and Today make it visible.
