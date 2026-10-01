# Enrolling a machine (spoke)

Start with an existing OS account on Linux or Darwin. Its retained
`manifold-agent --terminal-host` serves ordinary shells; a separately supervised
`manifold-agent` transport dials OUT to the hub over WebSocket (`/ws/machine`).
No inbound owner port, custom plugin, Agent profile or governed runtime is needed.
Use the [systemd units](#systemd-linux-terminal-only), [launchd setup](#launchd-macos--librarylaunchagentsdevtyrodemanifold-agentplist)
or the optional [NixOS shell role](SELF-HOST.md#normal-account-shells-nixos).

**Enrollment authorizes use of the account running the owner.** Shells have that account's
normal OS authority, home, groups and configured shell, not a newly granted OS-root identity.
Choose the account deliberately; an already privileged account retains its privileges.
Each enrolled account/role has an exact independent machine ID, private socket and owner
lifetime. A display name or host grouping never changes which account executes a command.
Enrollment alone does not install or start it.

Optional governed Linux execution belongs under its own protected account and reviewed
native facilities; see [SELF-HOST.md §Full native Linux](SELF-HOST.md#full-native-linux-nixos).
The ordinary units below are not a substitute for that profile. Disposable in-container
development shells are not shells on the physical host.

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

## 1. Mint a machine token (once per account endpoint)

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
keeps only its hash. Hand it to the chosen account's credential custodian through the
supported enrollment flow, never through logs, URLs, generated commands or shell history.
Choose a distinct enrollment name for each account/role. An existing name returns
`Already enrolled` without a new token; recovery is separately confirmed rotation.

For a new private handoff file on the target account:

```sh
umask 077
mkdir -p ~/.config/manifold
test ! -e ~/.config/manifold/machine.token &&
  install -m 600 /dev/null ~/.config/manifold/machine.token
# paste the token into that file using the owning tool's supported flow
```

The immediate parent must be mode 0700 and owned by this account; the file must be
regular, non-symlink, mode 0600 and owned by the same account. If an existing directory
or credential has different custody, stop and resolve it with its owner rather than
repairing or replacing tool-owned state. Provisioning never acquires or rotates the token.

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
WorkingDirectory=%h
Environment=HOME=%h
Environment=SHELL=/absolute/path/to/the/accounts/configured-login-shell
Environment=MANIFOLD_TERMINAL_HOST_SOCKET=%h/.local/state/manifold/terminal-host/host.sock
ExecStart=/nix/store/<...>-manifold-agent/bin/manifold-agent --terminal-host
Restart=on-failure
RestartSec=3
OOMPolicy=continue
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

Replace the `SHELL` example with the account's configured shell executable. Preserve the
account's normal PATH, including security wrappers where configured and user/system
profiles; do not import governed workload mounts or privilege restrictions into this owner.

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
`OOMPolicy=continue` keeps a kernel OOM kill of one process started from a terminal from
stopping the host and ending every terminal with it; systemd's default is `stop`.

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
`--terminal-host`, and `MANIFOLD_TERMINAL_HOST_SOCKET`, `HOME` and the account's configured
`SHELL` executable in its environment. Set its `WorkingDirectory` to the account's actual
home and preserve that account's user/system PATH; launchd does not expand shell variables
in these fields. Do not give the owner the transport token or a hub key.
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
  from `main` after its release PR passes required checks and rebase-merges. The script verifies
  the merged tree before tagging; a tag that is not an ancestor of `main` is not a release
  whatever it is called. v0.5.0 (2026-08-30) is the one such tag - published
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
- In a mounted canvas or composition, an online, nonrevoked, nondraining endpoint with
  positive `terminalExecution: "unconfined"` offers terminal `+`; selecting its exact account
  opens an ordinary shell, typing round-trips, and a second browser attaches to the same session.
- A governed or unknown declaration is not permission for an ordinary shell. Wait for the
  retained owner's positive declaration; enrollment and transport connection alone are insufficient.
- Other machines' terminals are unaffected.
- Flap test on a disposable node: interrupt the transport, not the host; the machine becomes
  unavailable. Restart transport → retained PTYs re-adopt with owner identity unchanged.
  Keep the mounted terminal focused with selected output: focus, selection and existing
  output survive, and fresh typed input produces output after each replacement.

## Group enrolled accounts for display

A host view groups exact enrolled machine IDs under an operator-supplied host name and
account labels. It is display metadata, not a machine, grant target or OS-account assertion.
Accounts keep separate credentials, owner lifetimes, execution modes and maintenance states.
Identical names do not group endpoints automatically.

In **Machines**, administrators can create/edit a host grouping and label its existing
account enrollments. Expand a group for each account's independent status and withdrawal/
forget controls. A single-account `+` uses that exact enrollment; a multi-account `+`
requires an explicit choice and never substitutes another account when it is unavailable.
The host's online rollup is not shell permission. Unknown/governed declarations, paused
admission, revoked credentials, offline transports and missing placement context explain
why a new shell cannot start. If grouping cannot be read, individual enrollments remain
available; an unreadable machine inventory is not an empty fleet.

`core.machines.listHostViews {}` returns `{ revision, hosts }` to the same
`containers:read` audience as the fleet inventory. To create or edit metadata, call
`core.machines.setHostView { expectedRevision, host: { id, name, members } }`, where each
member is `{ machineId, accountLabel }` and a new view ID is a client-generated UUID.
The setter requires `machines:mint` and the existing `containers:read` inventory permission;
new or relabelled members must resolve by exact ID. Names and labels are trimmed,
nonempty and at most 64 characters.

Use the returned revision for the next edit. A stale revision or concurrent edit refuses as
`host_views_changed`; reload and deliberately review the next edit rather than retrying it
automatically. Each account belongs to at most one view. The registry allows at most
128 views, 64 members per view and 64 KiB of UTF-8 storage; excess capacity is refused,
never truncated.

Revocation, going offline and forgetting remain per-account operations. Forgotten IDs stay
as missing display metadata until explicitly removed; a reused name never rebinds them.
`core.machines.removeHostView { expectedRevision, hostId }` requires `machines:mint` and
removes only metadata, not accounts, credentials or terminals.

## Enroll from core Machines

A viewer with live workspace `machines:mint` can open **Enroll shell account**, enter an
explicit distinct name and dispatch the existing enrollment door. An existing name is
**Already enrolled**, not implicit credential rotation. The one-time credential is a
selectable, immutable field for manual copying to its private authorized token custodian;
it is never inserted into setup commands, URLs, grouping metadata or persisted UI state.
**Hide credential**, unmount, client replacement and actual administration loss remove it.
Temporary disconnected/unknown authority hides the reveal without claiming revocation.

The setup panel links the Linux, Darwin and NixOS instructions above. Enrollment does not
create an OS account, install/start its owner or establish ordinary-shell authority. Provision
the selected existing account and wait for the shared fleet inventory's positive declaration.

## Delegate ordinary shell automation

An ordinary terminal's inherited lifecycle credential can inspect and control its existing
terminal; it does not authorize creating or restarting a remote shell. `manifold doctor`
reports remote shell launch as `not_probed` and never creates a terminal to test authority.
`manifold ssh` and `manifold exec` with lifecycle-only authority refuse as
`shell_spawn_not_delegated`. Keep the original terminal binding private; do not replace it
with an owner key, borrow another credential or register an Agent merely to run a command.

A human with live `tokens:mint` and the requested working authority can open **Sessions →
Delegate shell automation**. Choose the exact enrolled ordinary-account endpoint ID, a
finite expiry, and either:

- **One existing composition:** the working scope is that composition subtree. This supports
  its terminal tiles, not an independent terminal home created through a canvas.
- **Workspace compositions and canvas homes:** the working scope is the workspace subtree,
  with no composition ceiling. A later initial composition is a launch target, not a claim
  that its ID represents workspace-wide authority.

Both selections grant `containers:read`, `containers:write`, `scenes:write`,
`terminals:spawn` and `terminals:write` only at the chosen placement scope, and separately
grant `machines:shell` at the exact selected machine node. Endpoint display names and host
groupings confer no authority. Governed execution continues to require its separate native
operation/resource consent; this form does not substitute an ordinary shell for it.

The credential appears once in a selectable read-only field. Provision it through the
automation launcher's own supported credential flow; no token-bearing command or URL is
generated. Hiding it, unmounting, replacing the client or losing live issuance authority
retires the reveal. Modern external automation uses the compatible SDK and V2
`core.access.mintTokenV2` contract, not a flattened V1 cap/target product.

This is a creation/restart boundary, not blanket machine isolation: placement-scoped
`terminals:write` can still control an existing terminal on another account within that
scope. Processes retain the selected OS account's normal filesystem authority. Credential
withdrawal fences future access and tracked cleanup; it cannot undo prior filesystem effects.

## Notes

- Losing a token is recoverable: re-POST the same `name` with
  `"rotateToken": true` — the old token is revoked, the replacement shown once.
- Terminals run as the selected owner account on that machine. Only the transport is given the
  token reference; an ordinary shell still has that account's filesystem authority, including
  access to its own private files. The token authorizes the machine channel only, not principal
  actions. Use separate accounts/governed custody when broader credentials must stay inaccessible.

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
