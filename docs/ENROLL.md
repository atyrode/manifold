# Enrolling a machine (spoke)

Every machine you want terminals on runs one `manifold-agent` process that dials
OUT to the hub over WebSocket (`/ws/machine`). No inbound ports, no VPN: if the
box can reach `https://manifold.tyrode.dev`, it can serve shells.

## 1. Mint a machine token (once per machine)

From the hub box (bash/zsh). The owner key must never appear in a command's
argv — expanded arguments are world-readable in `/proc/<pid>/cmdline` while
the process runs — so the auth header goes to curl over stdin:

```sh
docker compose exec -T manifold sh -c \
  'printf "header = \"Authorization: Bearer %s\"\n" "$(cat /data/owner.key)"' |
curl --config - -X POST \
  -H "content-type: application/json" \
  -d '{"name":"<machine-name>"}' \
  https://manifold.tyrode.dev/api/machines
```

The response contains `machineToken` — **shown exactly once**; the server keeps
only its hash. Store it on the target machine:

```sh
install -m 600 /dev/null ~/.config/manifold/machine.token
# paste the token into that file (avoid putting it in shell history/argv)
```

## 2. Run the agent

The agent needs a checkout of this repo (`bun install` once) and three envs:

```sh
MANIFOLD_SERVER_URL=https://manifold.tyrode.dev \
MANIFOLD_MACHINE_TOKEN=$(cat ~/.config/manifold/machine.token) \
MANIFOLD_MACHINE_NAME=<machine-name> \
bun packages/agent/src/main.ts
```

`MANIFOLD_MACHINE_NAME` defaults to the hostname. A plain `https://<origin>` is
the whole server URL — the agent derives the WebSocket endpoint itself.

## 3. Keep it running across reboots

### systemd (Linux) — `~/.config/systemd/user/manifold-agent.service`

```ini
[Unit]
Description=manifold machine agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/manifold
Environment=MANIFOLD_SERVER_URL=https://manifold.tyrode.dev
Environment=MANIFOLD_MACHINE_NAME=%H
ExecStart=/bin/sh -c 'MANIFOLD_MACHINE_TOKEN=$(cat %h/.config/manifold/machine.token) exec bun packages/agent/src/main.ts'
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now manifold-agent
loginctl enable-linger $USER   # keep it running without an open session
```

### launchd (macOS) — `~/Library/LaunchAgents/dev.tyrode.manifold-agent.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.tyrode.manifold-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>MANIFOLD_MACHINE_TOKEN=$(cat "$HOME/.config/manifold/machine.token") exec bun packages/agent/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/manifold</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MANIFOLD_SERVER_URL</key><string>https://manifold.tyrode.dev</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```sh
launchctl load -w ~/Library/LaunchAgents/dev.tyrode.manifold-agent.plist
```

## 4. Acceptance checklist (per machine)

- Agent log shows `welcome` (its machineId) after connecting.
- `GET /api/machines` lists the machine `online: true`.
- The pad menu offers "New terminal on <name>"; a shell opens and typing
  round-trips; a second browser attaches to the same session.
- Other machines' terminals are unaffected.
- Flap test: kill the agent ~30s, sessions on it fail with `no_machine`;
  restart → machine back online, surviving PTYs re-adopted (`re-adoption` in
  hub logs).

## Notes

- Losing a token is fine: re-mint with the same `name` — the server rotates the
  token and revokes the old one.
- Terminals run as the agent's user on that machine. The agent is the only
  process with the token; the token authorizes the machine channel only (it is
  not a principal bearer).
