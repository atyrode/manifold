# Enrolling a machine (spoke)

Every terminal-serving machine runs a retained `manifold-agent --terminal-host` and a
separately supervised `manifold-agent` transport that dials OUT to the hub over WebSocket
(`/ws/machine`). No inbound owner port is needed. For full governed Linux execution,
use [SELF-HOST.md §Full native Linux](SELF-HOST.md#full-native-linux-nixos): its NixOS
module provisions native enforcement and supports local or explicitly enrolled remote owners.
The manual units below are **terminal-only**, not a substitute for that native profile.

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

Start the retained host first, then its replaceable transport. Both require the same private
socket (0600, parent directory 0700). Only the transport receives the machine token:

```sh
# In the independently supervised terminal-host lifetime:
MANIFOLD_TERMINAL_HOST_SOCKET=$HOME/.local/state/manifold/terminal-host/host.sock \
/path/to/manifold-agent --terminal-host

# In the separate transport lifetime:
MANIFOLD_TERMINAL_HOST_SOCKET=$HOME/.local/state/manifold/terminal-host/host.sock \
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
MANIFOLD_TERMINAL_HOST_SOCKET=$HOME/.local/state/manifold/terminal-host/host.sock \
MANIFOLD_MACHINE_TOKEN_FILE=$HOME/.config/manifold/machine.token \
bun packages/agent/src/main.ts
```

This development command is the transport only: independently run the same source entry
with `--terminal-host` and the identical socket path first. Never make a host a child of
the transport's service cgroup.

Never point a checkout-run agent at a production hub: any branch switch, pull,
or protocol commit mutates the executable underneath the process.

## 3. Keep it running across reboots

`ExecStart` points at the immutable store path (or a profile symlink you update
deliberately). No `WorkingDirectory` into a repository.

### systemd (Linux, terminal-only)

Create `~/.config/systemd/user/manifold-terminal-host.service`:

```ini
[Unit]
Description=manifold retained terminal host
RefuseManualStop=yes

[Service]
Environment=MANIFOLD_TERMINAL_HOST_SOCKET=%h/.local/state/manifold/terminal-host/host.sock
ExecStart=/nix/store/<...>-manifold-agent/bin/manifold-agent --terminal-host
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
```

Create the separate `~/.config/systemd/user/manifold-agent.service`:

```ini
[Unit]
Description=manifold machine agent
After=network-online.target
Wants=network-online.target
After=manifold-terminal-host.service

[Service]
Environment=MANIFOLD_SERVER_URL=https://manifold.tyrode.dev
Environment=MANIFOLD_TERMINAL_HOST_SOCKET=%h/.local/state/manifold/terminal-host/host.sock
Environment=MANIFOLD_MACHINE_NAME=%H
Environment=MANIFOLD_MACHINE_TOKEN_FILE=%h/.config/manifold/machine.token
ExecStart=/nix/store/<...>-manifold-agent/bin/manifold-agent
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now manifold-terminal-host manifold-agent
loginctl enable-linger "$USER"   # keep both running without an open session
```

Keep these unit lifetimes independent: no `PartOf`, `BindsTo` or `Requires` tying the host
to transport or hub. Replacing the transport preserves the retained host; a stop/restart
of the host is held behind drain and its private atomic `shutdown_request`, not a signal.
For native jobs, delegated cgroups, reviewed configuration and output backing are additionally
required; use the full-native profile rather than adding privileges to these terminal units.

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
    <key>MANIFOLD_TERMINAL_HOST_SOCKET</key>
    <string>/Users/YOU/.local/state/manifold/terminal-host/host.sock</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```sh
launchctl load -w ~/Library/LaunchAgents/dev.tyrode.manifold-agent.plist
```

This plist is the transport only. Create a second independently loaded plist for the host:
label `dev.tyrode.manifold-terminal-host`, the same immutable binary with argument
`--terminal-host`, and only `MANIFOLD_TERMINAL_HOST_SOCKET` in its environment.
Use `KeepAlive` with `SuccessfulExit=false` for the host so accepted maintenance shutdown
stays stopped. Load the host before the transport. macOS serves terminals, not Linux governed
jobs; never use transport replacement to unload or replace the host.

## 4. Upgrades and rollout discipline

- **Transport replacement preserves the retained host; host restart destroys its work.**
  Close admission, drain jobs/terminals and use the atomic maintenance shutdown before
  replacing an owner. Never perform owner maintenance from a terminal on that owner.
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
- **An incumbent transport seat wins.** Stop only the old transport, start its replacement,
  then confirm `welcome` and `online: true` without changing the retained host. Do not start
  competing owners or rotate tokens to displace an occupied seat. Full-native readiness also
  requires the owner proof and installation acknowledgement, not merely machine `online`.

## 5. Acceptance checklist (per machine)

- Agent log shows `starting` with the expected `build`, then `welcome` (its
  machineId) after connecting.
- `core.machines.list` reports the machine `online: true`.
- Expanding **Machines** in the sidebar shows a terminal `+` action beside the
  enrolled machine; selecting it opens a shell, typing round-trips, and a second
  browser attaches to the same session.
- Other machines' terminals are unaffected.
- Flap test on a disposable node: interrupt the transport, not the host; the machine becomes
  unavailable. Restart transport → retained PTYs re-adopt, with owner identity unchanged.

## Notes

- Losing a token is recoverable: re-POST the same `name` with
  `"rotateToken": true` — the old token is revoked, the replacement shown once.
- Terminals run as the agent's user on that machine. The agent is the only
  process with the token; the token authorizes the machine channel only (it is
  not a principal bearer).

## Decommission a machine

Delete its retained terminals through the ordinary terminal controls first. Clear any pending
maintenance drain with `core.machines.drain { machineId, draining: false }` while the agent
can still answer. Then dispatch `core.machines.revoke { machineId }` to withdraw its credential.
The row remains **Revoked** until you use its two-press **Forget** control or dispatch
`core.machines.forget { machineId }`; both administration doors require `machines:mint` and
an unscoped credential.

Forget removes the roster row and all its tokens, never silently revokes or kills anything.
It refuses with `not_revoked` for a live credential, `drain_pending` for latched admission,
or `terminals_retained` for any remaining terminal row (including exited terminals).
History and traces remain unchanged, with the old machine id unresolved. Re-enrolling the
same name after forgetting creates a new identity; it does not reconnect that history.
