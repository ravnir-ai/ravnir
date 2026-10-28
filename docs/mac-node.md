# Link your Mac

Agents usually run on a server. The Mac link lets them use your Mac as a second computer while it is online: run a command, read or write a file, list a folder. Nothing listens on the Mac. It dials out to your server and waits for calls.

## How it works

- `bin/mac-node.mjs` runs on the Mac with no dependencies (Node 22 or newer has WebSocket built in). Run it by hand, or keep it alive with a LaunchAgent.
- It connects to `wss://your-server.example.ts.net:8443/api/mac/connect` (use whatever address you reach Ravnir at) and says hello with a token. The server holds the same token in `RAVNIR_MAC_TOKEN`.
- The Mac reads its settings from `~/.config/ravnir-mac/config.json` (mode 600):

```json
{ "url": "wss://your-server.example.ts.net:8443/api/mac/connect", "token": "<the same value as RAVNIR_MAC_TOKEN>", "roots": ["~/Projects", "~/Documents/Notes"] }
```

  `roots` are the work folders. Without it the runner uses `~/Desktop/Projects`. Set `RAVNIR_MAC_CONFIG` to use another config path. A config left at `~/.config/truebot-mac/config.json` by an older version is still read when the new one does not exist.
- `server/macNode.js` keeps the one connection, a 15 second heartbeat (the link counts as dead after 45 seconds) and the calls in flight. `GET /api/mac` shows the status.
- Every agent gets `mac_status`, `mac_run`, `mac_read_file`, `mac_write_file` and `mac_list`. Agents that talk to Ravnir through its built-in MCP endpoint get them too. Everything else still runs on the server or in the agent's own box.
- The agent's prompt says where it lives and whether the Mac is online.

## Browse from your Mac

Many sites refuse whole datacenter networks, so a browser on a VPS gets "Sorry, you have been blocked" (Cloudflare) or "Access Denied" (Akamai) where the same browser at home loads fine. With the Mac linked, those sites open from the Mac.

- The runner keeps a second WebSocket, `/api/mac/tunnel`, only for browsing traffic (`server/macTunnel.js`). The hub asks for a connection to a host and port, and the bytes flow through it. The Mac resolves the name itself and refuses loopback, private, link-local and tailnet addresses and port 25, so a page cannot reach the Mac's own services or the home network.
- Each agent's browser on the server goes through a small SOCKS5 proxy on the server's loopback (`server/netRoute.js`) that picks, per connection, the server or the Mac.
- An agent chooses where it opens sites from in its Screen tab:
  - **This server, or your Mac when a site blocks it** (the default). When a page is a bot-protection block (`detectBlock`), the site goes on a shared list (`home-sites.json` in the data folder) and the page opens again from the Mac. Every agent then opens that site from the Mac while it is online. While an agent's page is on such a site, all of that browser's connections go through the Mac, because a bot check loads pieces from other hosts. Remove a site from the list with its × in the Screen tab.
  - **Your Mac, for every site.** When the Mac is offline, pages fail with a plain message.
  - **A proxy.** An HTTP, HTTPS or SOCKS5 address (a password only with HTTP or HTTPS), stored encrypted. Only the host is shown back.
  - **This server only.**
- When a site stays blocked, the agent's tool result starts with a note that says why and what to ask the user, so it stops trying other addresses on the same site.
- Some sites still show "Verify you are human" from the Mac's address. Ravnir does not try to pass those checks. The agent asks you to take over, you tick the box once on its screen, and it carries on.
- Take control's plain browser uses the same route. Agents with their own container computer always open sites from the server for now.

## Rules

The approval rules in `macDecision` (`server/policy.js`) decide each call:

- Reads and listings inside the work folders run without asking.
- Writes follow the agent's files rule (allow, ask or deny). Outside the work folders, the files rule applies to reads as well.
- Commands follow the agent's shell rule and allow list, like commands on the server.
- Keys, `.env` files, keychains, `~/.ssh`, `~/.config/op`, cookies, `sudo`, `security find-*` and `op read` always ask, whatever the rules say. The runner itself also refuses keychains, ssh private keys and its own config.

## When the Mac goes offline

Calls in flight fail with a plain message that the Mac went offline and that the agent can continue when it is back. Every agent that used the Mac in the last 15 minutes sends "your Mac went offline" to the Inbox and your phone. When the link returns, it sends "your Mac is back" with the same tag, so the second notice replaces the first. Agents that were not using the Mac are unaffected.

## Keep it running on macOS

Copy the runner somewhere stable and start it from a LaunchAgent (`~/Library/LaunchAgents/<label>.plist`) with `RunAtLoad` and `KeepAlive` set:

```
install -m 755 bin/mac-node.mjs ~/.local/share/ravnir-mac/mac-node.mjs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist     # plug the Mac in
launchctl bootout gui/$(id -u)/<label>                                    # unplug it
```

After changing the runner, copy it again, then run bootout and bootstrap.

## Tests

`test/mac.test.js` covers the rules, the offline notices and the real runner against a local server.
