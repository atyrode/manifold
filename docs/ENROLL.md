# Enrolling a machine (spoke)

Every machine you want terminals on runs one `manifold-agent` process that dials
OUT to the hub over WebSocket (`/ws/machine`). No inbound ports, no VPN: if the
box can reach `https://manifold.tyrode.dev`, it can serve shells.

**Production runs the packaged binary, never repository source.** A mutable
checkout under a long-running agent is how the 2026-08-27 outage happened: the
checkout advanced past the deployed hub's protocol and the restarted agent was
rejected on every redial. Source-checkout invocations are development-only and
labeled as such below.

## 0. Build the immutable agent binary

The repo is a Nix flake exposing both programs as compiled, self-contained
binaries (Bun runtime + bundled sources — no checkout, no `bun install` on the
node):

```sh
nix build github:atyrode/manifold/<pinned-rev-or-tag>#manifold-agent
./result/bin/manifold-agent   # env-configured; see below
```

Pin a release tag or an exact revision — the wrapper bakes that revision into
`MANIFOLD_BUILD`, and the agent names it (plus its protocol version) in its
`starting` log line, so what is deployed is always observable without secrets.

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
  https://manifold.tyrode.dev/api/actions/core.machines.enroll
```

Enrolment is an ACTION, so the answer is always HTTP 200 carrying an outcome
envelope: `{"ok":true,"result":{...}}` on success, or
`{"ok":false,"denial":{"rule":"...","message":"..."}}` when the door refuses.
Read `.result`, and never trust the status code alone.

`result.machineToken` is the raw secret — **shown exactly once**; the server
keeps only its hash. Store it on the target machine:

```sh
install -m 600 /dev/null ~/.config/manifold/machine.token
# paste the token into that file (avoid putting it in shell history/argv)
```

Enrollment is **idempotent**: re-invoking with an existing `name` returns the
machine row without minting — the token a running agent holds stays valid, and
re-run provisioning flows are safe. To recover a _lost_ token, rotate
explicitly:

```sh
-d '{"name":"<machine-name>","rotateToken":true}'
```

Rotation revokes the old token immediately (a live agent using it is fenced
with close code 4403) and returns the replacement exactly once.

## 2. Run the agent

Three envs; the token comes from the 0600 file so it never appears in a unit
file or a process environment listing:

```sh
MANIFOLD_SERVER_URL=https://manifold.tyrode.dev \
MANIFOLD_MACHINE_TOKEN_FILE=$HOME/.config/manifold/machine.token \
MANIFOLD_MACHINE_NAME=<machine-name> \
/path/to/manifold-agent
```

Exactly one of `MANIFOLD_MACHINE_TOKEN` and `MANIFOLD_MACHINE_TOKEN_FILE` must
be set. `MANIFOLD_MACHINE_NAME` defaults to the hostname. A plain
`https://<origin>` is the whole server URL — the agent derives the WebSocket
endpoint itself.

**Development only** — running from a checkout (`bun install` once):

```sh
MANIFOLD_SERVER_URL=http://localhost:7777 \
MANIFOLD_MACHINE_TOKEN_FILE=$HOME/.config/manifold/machine.token \
bun packages/agent/src/main.ts
```

Never point a checkout-run agent at a production hub: any branch switch, pull,
or protocol commit mutates the executable underneath the process.

## 3. Keep it running across reboots

`ExecStart` points at the immutable store path (or a profile symlink you update
deliberately). No `WorkingDirectory` into a repository.

### systemd (Linux) — `~/.config/systemd/user/manifold-agent.service`

```ini
[Unit]
Description=manifold machine agent
After=network-online.target
Wants=network-online.target

[Service]
Environment=MANIFOLD_SERVER_URL=https://manifold.tyrode.dev
Environment=MANIFOLD_MACHINE_NAME=%H
Environment=MANIFOLD_MACHINE_TOKEN_FILE=%h/.config/manifold/machine.token
ExecStart=/nix/store/<...>-manifold-agent/bin/manifold-agent
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
    <string>/nix/store/<...>-manifold-agent/bin/manifold-agent</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MANIFOLD_SERVER_URL</key><string>https://manifold.tyrode.dev</string>
    <key>MANIFOLD_MACHINE_TOKEN_FILE</key>
    <string>/Users/YOU/.config/manifold/machine.token</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```sh
launchctl load -w ~/Library/LaunchAgents/dev.tyrode.manifold-agent.plist
```

## 4. Upgrades and rollout discipline

- **An agent restart kills every PTY it owns** (CONTRACTS.md §machine channel).
  Upgrades are operator-timed or idle-gated — never automatic on deploy, and
  never triggered from inside a manifold terminal on that same machine.
- **Hub first, spokes at leisure.** Version acceptance is the
  `MACHINE_PROTOCOL_COMPAT_VERSIONS` set, so a newer hub keeps accepting older
  agents. The reverse is rejected loudly (close 4409, `machine_version_rejected`
  in hub logs naming both versions). For a protocol bump that resets the compat
  set, upgrade hub and all spokes together; never advance only one side.
- **Downstream pins follow `main`.** A release is a tag that `bun run release` cuts
  from `main`, the release line; a tag that is not an ancestor of `main` is not a
  release whatever it is called. v0.5.0 (2026-08-30) is the one such tag - published
  as a pre-release from a `dev` commit and never deployed. Pin refreshers (the dotfiles
  cron) resolve "latest" through GitHub, which excludes pre-releases, and hold any
  candidate whose protocol is newer than the deployed hub (`atyrode/dotfiles#454`).
- **Verify before removing the old agent.** Start the new binary and confirm
  `welcome` in its log (and `online: true` from `core.machines.list`) before
  decommissioning whatever ran previously with the same token.

## 5. Acceptance checklist (per machine)

- Agent log shows `starting` with the expected `build`, then `welcome` (its
  machineId) after connecting.
- `core.machines.list` reports the machine `online: true`.
- Expanding **Machines** in the sidebar shows a terminal `+` action beside the
  enrolled machine; selecting it opens a shell, typing round-trips, and a second
  browser attaches to the same session.
- Other machines' terminals are unaffected.
- Flap test: kill the agent ~30s, sessions on it fail with `no_machine`;
  restart → machine back online, surviving PTYs re-adopted (`re-adoption` in
  hub logs).

## Notes

- Losing a token is recoverable: re-POST the same `name` with
  `"rotateToken": true` — the old token is revoked, the replacement shown once.
- Terminals run as the agent's user on that machine. The agent is the only
  process with the token; the token authorizes the machine channel only (it is
  not a principal bearer).
