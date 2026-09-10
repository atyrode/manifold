# Self-hosting manifold

Choose the deployment profile, not a hosting provider:

- **Full native Linux:** the NixOS module below runs the hub, an independently supervised
  terminal/native owner and a replaceable transport on one node. Execution-only remote nodes
  use the same owner and authority protocol, with explicit enrolled IDs.
- **Container hub:** Compose serves the web app and canonical store. Set
  `MANIFOLD_SPAWN_AGENT=0` for a hub-only deployment and enroll native execution nodes.
  The existing default also serves disposable in-container terminals, not governed native
  execution. Container privileges, tmpfs alone and detached children are not native
  enforcement or survival across container replacement.

## Full native Linux (NixOS)

`nixosModules.native` is the supported declarative Linux profile. It is not tied to any
cloud, hostname or product plugin. It requires Linux x64/arm64, unified cgroup v2 with
`cpu`, `memory`, `pids`, user namespaces, and systemd 254 or newer. The pinned flake packages
embed Bun >= 1.4.2 and the web bundle; no source checkout is consulted by a running unit.
The server package also carries that pinned Bun interpreter for installed hardened plugin
children; it never re-executes a compiled hub as a plugin.
The owner also needs a bubblewrap build with FD-backed bind, block, info and seccomp support.
Startup checks its advertised switches; actual namespace, cgroup migration, `memory.peak`,
`pids.peak`, `memory.swap.max` and `cgroup.kill` enforcement still require disposable-owner
verification on the target kernel. Missing facilities refuse jobs, never launch a fallback.
The Bun ZIP digests are pinned from the official
[1.4.2 release metadata](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.2);
the older locked nixpkgs Bun is not used. Vendored dependency trees are pinned for all
four package targets and were reproduced with that Bun's explicit `--os`/`--cpu`
optional-dependency selectors; the Linux x64 control matches its native installed tree.
This establishes dependency bytes, not execution of another target's compiled binary.
Build and exercise each target's actual package before deploying it.

### Declare one node

Add a pinned Manifold input to the flake that already owns your NixOS configuration:

```nix
inputs.manifold.url = "github:atyrode/manifold/<exact-revision-or-release-tag>";
```

Include `inputs.manifold.nixosModules.native` in that host's `modules` list, then declare:

```nix
services.manifold = {
  enable = true;
  hub.enable = true;
  hub.publicUrl = "https://manifold.example.com";
  execution = {
    enable = true;
    machineName = "local";
    artifactOrigins = [ "https://artifacts.example.com" ];
  };
};
```

Replace the example origin with the actual reviewed HTTPS artifact host(s), including any
allowed redirect destinations. No plugin, tool, artifact, resource consent or provider
credential is implicitly installed. The empty `runtimeTools` default supports self-contained
artifacts; operations declaring tools require reviewed closures as described below.
Keep the flake lock committed. Provision a persistent disk for `/var/lib`; configure TLS
on your own reverse proxy forwarding to `127.0.0.1:7777` (including WebSocket upgrades).
The module does not open firewall ports or install a hosting provider's ingress.

For a **new, disposable node**, build and activate through your ordinary NixOS configuration:

```sh
sudo nixos-rebuild switch --flake /etc/nixos#<host>
systemctl status manifold-server manifold-owner manifold-transport
curl -fsS https://manifold.example.com/healthz
```

These are setup commands, not authorization to migrate occupied owners. For existing nodes,
follow the maintenance hold below before changing the execution declaration.

The hub's private environment enables `MANIFOLD_SPAWN_AGENT=1`,
`MANIFOLD_LOCAL_AGENT_SUPERVISION=external` and
`MANIFOLD_LOCAL_JOB_OWNER_TEMPLATE=/var/lib/manifold/owner-template.json`.
Here `SPAWN_AGENT=1` enables **bootstrap**, not child process creation: the hub authenticates
the retained enrollment or creates a new local identity, derives the current public admission
key, validates the reviewed template and atomically publishes owner configuration under the
boot lock. It records that authenticated canonical local ID for default instance-service
placement. It starts no children; no source-tree `bun` invocation is hidden in the package.
The owner waits up to 60 seconds for initial local configuration. Failed preparation is
visible, not a request to guess another machine.

The same module can be hub-only (`execution.enable = false`). In that case it creates no
local machine. `hub.serviceOwnerMachineId = "<enrolled-id>"` selects an explicitly configured
remote service owner, including when local execution is enabled. Absence selects the canonical
local identity only when provisioned. Offline, revoked or unready placement refuses; machine
names, arrival order, provider labels and other machines are never fallback choices.

### Independent lifetimes and storage

| Unit / path                                                 | Ownership                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifold-server.service`                                   | Hub HTTP/WebSockets, SQLite, instance authority and local configuration preparation                                                                 |
| `manifold-owner.service`                                    | Retained terminal host plus native owner; no machine token or hub key in its environment                                                            |
| `manifold-transport.service`                                | Replaceable outbound machine channel; reads only its enrolled machine token file                                                                    |
| `/var/lib/manifold`                                         | Private 0700 hub/control storage; owner key, machine token, immutable `job-owner/config.json`, durable owner state/journal/artifacts/sealed outputs |
| `/var/lib/manifold-workload/{home,data,state,cache,config}` | Persistent declared workload anchors, separate from protected control storage                                                                       |
| `/var/lib/manifold-output`                                  | Dedicated bounded tmpfs, the `runtime` anchor for named-output locations; temporary, not durable owner state                                        |

The owner has **no** `PartOf`, `BindsTo` or `Requires` relationship to the hub or transport.
Detaching a child would leave it inside the hub cgroup; the module instead starts the owner
in its own `system.slice/manifold-owner.service` cgroup. `DelegateSubgroup=supervisor` keeps
owner/startup processes out of the delegated root. Its separate empty `jobs` subtree enables
`+cpu +memory +pids`; the runtime builds per-job enforcing ancestors above writable nested
workload subgroups. Do not put the owner in the `jobs` subtree, substitute a user-session
cgroup or grant unrestricted cgroup writes to a workload.

All control files are 0600, with private parents. Templates and generated configuration are
immutable while retained: changes refuse rather than rewrite, restart or replace the owner.
First publication stages and fsyncs a complete private file, then atomically renames it without
replacing an incumbent and fsyncs its parent. Concurrent native installation compares the winning
configuration; an interrupted write cannot expose a partial config or supervision marker.
`/var/lib/manifold` is excluded from workload sources, including recursive ancestor mounts;
add other existing credential/control directories with `execution.protectedDirectories`.
Do not make protected control storage an anchor or copy desktop/tool credentials into the
service account. Native owners refuse runtime-free shells and programs, including when their
job channel is unavailable; ordinary terminal creation requires an explicitly unconfined owner.
The hub, owner and transport remain trusted processes under the `manifold` OS account:
neither these exclusions nor cgroups isolate a compromised daemon from same-UID control state.
Give this account only the host authority you intend to grant; use separate execution nodes
when the hub must not hold the node's OS authority.

Named output backing is **not just a tmpfs directory**. The runtime counts the total capacity
of each distinct backing device once, requires positive byte/inode bounds, and reserves its
whole capacity before stdout/stderr. The module's defaults are 1 MiB and 4096 inodes
(`execution.outputBytes`, `execution.outputInodes`). A job using this filesystem needs an
`outputBytes` limit greater than its full capacity if it also emits stdio, and enough aggregate
budget for canonical archive headers. Multiple jobs share this finite backing; space
exhaustion is a real refusal/failure, not a per-job quota or an implicit remount.
The sum across all named-output devices must be within the job limit and at most 10,000 inodes.
Configure output locations relative to `anchor: "runtime"`: resolving a descendant mount
through `home`/`data` would correctly fail with `mount_escape`.

The output tmpfs is deliberately not inside `job-owner/state`: the runtime's held child
directories refuse mount crossings. The owner seals bounded output into its **disk-backed**
private output store only after all writers are closed. That preserves acknowledged outputs
across owner restart, but it is not an aggregate disk quota or an automatic retention policy.
Size/monitor the persistent filesystem, use explicit governed release/purge, and back up the
hub and owner control state as secrets. Named-output scratch disappears at reboot; retained
sealed outputs, job identities and workload data do not. Never treat tmpfs as a durable receipt.

`execution.runtimeTools` maps the manifest's tool names to reviewed
`{ source, target, kind }` bindings. Choose explicit executable targets such as
`/runtime/bin/<tool>`, `/bin/sh` or `/usr/bin/git`; sources must be real files/directories,
not symlink aliases. Directory bindings cannot contain foreign mounts or protected data.
A dynamically linked executable without its loader cannot run in the empty sandbox.

For Nix-packaged tools, `execution.runtimeToolClosures` selects packages by the same alias
and adds their exact transitive store paths as read-only file or directory bindings at
Nix build time. Unsupported store-root object types are rejected rather than followed.
These bindings merge with that alias's explicit `runtimeTools` entrypoints, for both
local and remote nodes; shared sources are retained once so separate aliases compose:

```nix
services.manifold.execution = {
  runtimeTools.shellGit = [
    { source = "${pkgs.bash}/bin/bash"; target = "/bin/sh"; kind = "file"; }
    { source = "${pkgs.gitMinimal}/bin/git"; target = "/usr/bin/git"; kind = "file"; }
  ];
  runtimeToolClosures.shellGit = [ pkgs.bash pkgs.gitMinimal ];
};
```

An operation must declare the `shellGit` runtime tool to receive those bindings. The
package selection exposes each selected package's complete closure, not only its `bin`
directory, but never the whole host store or unrelated installed packages. It does not
populate PATH or choose entrypoints automatically. The empty default adds no bindings;
explicit bindings still work without this option. Do not bind all of `/`, `/usr` or
`/nix/store`, discover a host PATH, or assume installing a host package makes it available
to jobs. Runtime binding and closure changes alter retained owner configuration: use
drained maintenance and the atomic owner shutdown below before activating them, never
overwrite an occupied owner's configuration in place.

`execution.serviceCredentials` maps a service policy's `credentialRef` to a private runtime
file and reviewed allowed origins, on both local and execution-only nodes:

```nix
services.manifold.execution.serviceCredentials.service-api = {
  source = "/var/lib/manifold-credentials/service-api";
  origins = [ "https://api.example.com" ];
};
```

Use a **quoted path string**, not a Nix path literal or `builtins.readFile`: only the
reference, path and origins belong in Nix, never credential bytes. Provision the source
before starting the owner: a nonempty, single-link regular file (at most 16 KiB), 0600 and
owned by `manifold`, without symlinks in its path. Its parent must be owned by root or
`manifold` and not group/world-writable; a 0700 `manifold`-owned credential directory is
the simplest choice. The module adds these parent roots to `protectedDirectories`.
Origins must be canonical HTTPS origins; HTTP is allowed only for explicit `127.0.0.1`
or `[::1]` loopback origins. This declares a credential source, not resource consent or
permission to invoke a service. Owner configuration and source references are retained;
change them only through drained owner maintenance, not an in-place config overwrite.

### Explicit remote execution

Run the same module on each execution-only node with `hub.enable = false` and
`execution.enable = true`. Before activation, use the existing
`core.machines.enroll { name }` action with authorized `machines:mint` authority on the hub.
For a new enrollment, retain the successful outcome's `machineToken` in a 0600 file
owned by `manifold`, inside a private directory on that node. If a tool already retains
the enrolled credential there, use the existing-source mode below instead of copying or
changing its custody. Enrollment's name idempotence is provisioning, never service
placement. Do not rotate an incumbent token to make installation succeed.

Use authenticated `engine.jobs.describe { machineId, pluginId }` with `machines:run`
authority for the public `admissionPublicKey`; this works independently of job readiness.
The selected plugin ID is the plugin whose native installation you intend to administer.
Only that **public** SPKI key and enrolled ID enter the reviewed node configuration:

```nix
services.manifold = {
  enable = true;
  hub.enable = false;
  execution = {
    enable = true;
    machineName = "execution-a";
    serverUrl = "https://manifold.example.com";
    machineId = "<machine.id from successful enrollment>";
    admissionPublicKey = builtins.readFile ./hub-admission-public.pem;
    tokenFile = "/var/lib/manifold/machine.token";
    artifactOrigins = [ "https://artifacts.example.com" ];
  };
};
```

The token file contents are never a Nix expression or store object. If creating the account
before first activation, use your normal secret-provisioning mechanism; do not start the
transport until the declared private file exists. Nodes dial outbound to the hub; no
inbound native-owner port is exposed. Never ship `owner.key`, the hub database or its signing
key to an execution node. The machine token is not a tool/provider token or a principal
credential. Installation and revision/resource consent remain the existing `engine.jobs`
administration actions; enrollment alone grants neither.

#### Existing enrollment credential custody

Instead of `tokenFile`, declare the exact source already retained by the enrollment
tool. This example names a private source beneath an explicitly excluded, traversable
directory; it is not an instruction to copy a token to a new location:

```nix
services.manifold.execution = {
  tokenCredentialFile = "/etc/manifold-enrollment/private/machine.token";
  protectedDirectories = [ "/etc/manifold-enrollment" ];
};
```

Use a quoted absolute path string, never a Nix path literal or `builtins.readFile`.
The source must be a regular file with mode 0400 or 0600. Neither it nor any ancestor
may be owned by `manifold` or writable by group/others, including ACL write masks.
Symlinks, traversal components and systemd specifiers are refused. These checks also
cover access granted by unit-only supplementary groups; they do not infer custody
from the account's NSS groups.

The owner holds exclusion descriptors before serving work. The source's parent must
therefore be traversable by `manifold`, or lie below an explicitly declared traversable
`protectedDirectories` ancestor. Private descendants and the token itself need not
be readable by that account. The source boundary and `/run/credentials` are excluded
from workload bindings.

An independent root prerequisite validates custody before systemd loads the credential.
The transport consumes the resulting private, read-only systemd credential through
`CREDENTIALS_DIRECTORY`; the module does not copy, chmod, chown or rotate the original,
and creates no additional persistent token. Failed validation refuses the transport,
not the retained owner. `tokenCredentialFile` and `tokenFile` are mutually exclusive,
with no fallback between them; default local bootstrap is unchanged.

Changing a source reference or its exclusion boundary changes retained owner
configuration. Use the positive-drain/shutdown maintenance below, not an in-place
configuration rewrite or a blind owner restart.

### Maintenance and disposable-owner acceptance

Routine hub restart (`systemctl restart manifold-server`) and transport replacement
(`systemctl restart manifold-transport`) leave the owner cgroup intact. Owner definitions
have `restartIfChanged=false`, `stopIfChanged=false`, `Restart=on-failure` and
`RefuseManualStop=true`: a rebuild does not opt into killing retained work, and a successful
atomic maintenance shutdown stays stopped. Old immutable store paths must remain rooted
until the retained owner exits; do not garbage-collect its old system generation mid-session.
Changing a unit definition does not mean the retained owner is running that new version.
Hub/transport protocol 30 is independent of native owner RPC 2. A compatible retained owner
keeps its work through a transport upgrade; its missing IPC-2 execution declaration cannot
be treated as permission to create an unconfined shell.

The supported command is `manifold-agent --maintenance`; it does not run the transport,
acquire its seat, discover machines or credential files, retire terminals, cancel jobs,
send signals, stop a supervisor, or automatically retry/reopen. Run `manifold-agent
--maintenance --help` for its argument contract. Before changing owner configuration,
output backing, identity, package or supervisor, explicitly bind maintenance to the reviewed
machine and owner process:

```sh
manifold-agent --maintenance drain \
  --hub http://127.0.0.1:7777 --machine-id "$MACHINE_ID" \
  --owner-key-file /var/lib/manifold/owner.key

manifold-agent --maintenance shutdown \
  --socket /var/lib/manifold/terminal-host/host.sock \
  --terminal-host-id "$TERMINAL_HOST_ID"
```

Run drain/reopen where the named owner-key file already resides and is readable by the
authorized Manifold process. Key **values**, ambient key discovery and credential-bearing
URLs are not accepted; do not extract a key into an argument, environment variable, shell
substitution, host file or log. Shutdown needs no hub key: run it on the explicitly selected
execution host with access to that owner's private Unix socket. Bind `TERMINAL_HOST_ID` to
the reviewed owner's identity reported by successful drain, not to an automatically selected
replacement. Shutdown checks that identity and a supported maintenance protocol via status
on the same observer connection before making the atomic shutdown request. IPC 1 and IPC 2
share these maintenance frames; accepting an older owner's empty-shutdown acknowledgment
does not enable unconfined execution. Unknown protocols hold.

For the source-shipping Docker image, use the identical CLI **inside the owning container**;
the credential read stays inside Manifold:

```sh
docker exec "$CONTAINER_ID" bun packages/agent/src/main.ts --maintenance drain \
  --hub http://127.0.0.1:7777 --machine-id "$MACHINE_ID" --owner-key-file /data/owner.key
docker exec "$CONTAINER_ID" bun packages/agent/src/main.ts --maintenance shutdown \
  --socket "$TERMINAL_HOST_SOCKET" --terminal-host-id "$TERMINAL_HOST_ID"
```

If the retained container predates this CLI, build the reviewed source into a public Bun
bundle and stream that code into the same container. This changes no deployed files and
does not move the credential out of its existing custody:

```sh
bun build --target bun packages/agent/src/main.ts --outfile /tmp/manifold-maintenance.js
docker exec -i "$CONTAINER_ID" bun - --maintenance drain \
  --hub http://127.0.0.1:7777 --machine-id "$MACHINE_ID" \
  --owner-key-file /data/owner.key < /tmp/manifold-maintenance.js
```

These are explicit existing container/socket references, not discovery or a private preview
retirement helper. They do not authorize container replacement or activation.

Each successful command exits 0 and prints one JSON line. Drain/reopen report
`{ok:true,command,machineId,terminalHostId,draining,terminalIds}`; drain proves the admission
latch, **not idle or shutdown**, even when `terminalIds` is empty. Let retained jobs/services
finish or explicitly resolve them through their governed doors, and explicitly resolve
retained terminal entries. Only shutdown's matching
`{ok:true,command:"shutdown",terminalHostId}` acknowledgement proves the owner accepted the
atomic drained-and-empty check. A preceding status report cannot substitute for that check.

Failures exit 1 with one stderr JSON line containing `ok:false`, `hold:true`, a stable
`reason`, and the valid command when known; typed refusal IDs/rules/status may be included,
but no raw owner frames, exception text or remote denial messages are printed. `not_draining`,
`terminals_retained` and `jobs_retained` are **HOLD**, as are identity/protocol mismatch,
disconnect, invalid response and the bounded 30-second timeout. Disconnect is not a shutdown
acknowledgement. A failed drain may already have persisted the admission latch: keep the
current owner and workload intact, do not infer a rollback, and do not automatically retry,
reopen, signal, force restart or replace a container. Do not remove the profile or change
its mount while retained work exists.

After acknowledged shutdown, retain journals/workload storage, explicitly retire only the
old reviewed `owner-template.json` / `job-owner/config.json` and supervision marker if that
configuration is actually changing, then activate and `systemctl start manifold-owner`.
Reopen explicitly only after owner proof/readiness:

```sh
manifold-agent --maintenance reopen \
  --hub http://127.0.0.1:7777 --machine-id "$MACHINE_ID" \
  --owner-key-file /var/lib/manifold/owner.key
```

For container-local reopen, use the same `docker exec` invocation as drain with `reopen`
instead. A lost enrollment token or conflicting machine name refuses native bootstrap;
recover through the supported enrollment authority flow, never implicit rotation. No live
detached-to-systemd adoption is implemented. Delivering this source is not activation
authorization or evidence that a live cutover has occurred.

Before preview activation Main/integration must exercise this profile on **disposable**
Linux owners: build/evaluate the pinned module and both binaries; prove actual namespace,
FD mount and controller support; execute a hash-pinned operation with declared closures and
bounded outputs; test over-capacity, inode, protected-source and cgroup-migration refusals;
retain a terminal and service across hub-unit and transport-unit restarts; compare owner
PID/generation and prove no replay; verify multi-node explicit ID routing and offline refusal;
attempt configuration/supervision drift and prove the incumbent remains untouched; drain
and atomically shut down before owner restart; confirm output/journal recovery on disk and
honest loss of unsealed tmpfs scratch. A successful build or online terminal transport alone
does not prove native readiness. This profile's source is not a claim of runtime verification.

The flake's disposable NixOS acceptance check is configured to boot the declared services
and execute a hash-pinned worker with its declared static runtime. Its assertions cover
control-state exclusion, private control-file modes, and exit status/sealed output surviving
hub/transport restarts and positively drained owner replacement. It uses the packaged
`manifold-agent --maintenance` entry point for drain, explicit reopen and atomic shutdown,
including a live retained-job `jobs_retained` HOLD with unchanged owner PID, closed admission
and a still-running workload. The worker must then finish normally with its expected result;
an empty process listing is not substituted for that evidence. It also attempts changed
configuration activation and requires the incumbent PID and private configuration to remain
unchanged on refusal. These describe the acceptance assertions, not a claim they have run
for the current revision.

A second node exercises systemd credential delivery from root-owned private custody.
It verifies source bytes and metadata survive normal transport replacement, the delivered
credential is private and read-only, and in-flight work retains its owner. It also refuses
a source parent writable through an owner unit's supplementary group and an unsafe
source-file mode, then proves transport recovery without replacing the owner.

Run both packaged scenarios:

```sh
nix build .#checks.x86_64-linux.native-profile
```

Use the corresponding `aarch64-linux` check on that target. QEMU can use CPU emulation on
builders without nested virtualization. This lifecycle check complements, rather than
replaces, the workload, escape-boundary and occupied-owner acceptance above.

## Container profile

## Prerequisites

- Docker with the compose v2 plugin (`docker compose version`).
- A DNS A record for your domain pointing at the box (ports 80 and 443 reachable).
  For a local smoke run, `MANIFOLD_DOMAIN=localhost` works without DNS — Caddy then
  serves a certificate from its internal CA (self-signed).

## Install

```sh
git clone https://github.com/atyrode/manifold && cd manifold
cp .env.example .env        # set MANIFOLD_DOMAIN=<your domain>
docker compose up -d --build
```

Or run a published image — no bun, no build — by naming a release tag in `.env`
(`MANIFOLD_IMAGE=ghcr.io/atyrode/manifold:<tag>`, tags at
<https://github.com/atyrode/manifold/releases>; the published image is x86_64, and an
arm64 host builds the same image with the first form):

```sh
docker compose pull && docker compose up -d
```

There is no `latest` tag on purpose: a deploy names a version, so "what is running"
is always a version you can read in `/healthz` (`version`, `build`, `channel`; §Environments)
and find in the changelog.

Either way, print the bootstrap URL and open it in a browser:

```sh
docker compose exec manifold sh -c 'echo "$MANIFOLD_PUBLIC_URL/#key=$(cat /data/owner.key)"'
```

The `#key=` fragment is the owner bootstrap: it never leaves the browser (fragments
are not sent in requests) and the app moves it to localStorage and scrubs the URL
immediately.

The boot log line `manifold ready url=…` deliberately omits the key: `docker logs`
output is a persisted stream, and the owner key must never enter logs (the command
above reads it from the data volume instead; it goes only to your terminal).

## Security posture

One secret is root. `<data>/owner.key` (64 hex, mode 600) is compared with a
constant-time equality in `AuthService.authenticate` (`packages/server/src/auth.ts`);
whoever presents it gets `caps: ["*"]`, no container scope, and root on every door
in every container. The fragment keeps it off the wire — it is never sent in a
request, and the app moves it to localStorage and scrubs the URL — but that narrows
the network path, not the human one.

What the owner key does **not** protect against:

- Anyone who obtains the string is you: browser history, a screenshared address
  bar, a synced browser profile, a URL pasted into a chat log, a backup archive.
- There is no second factor.
- There is no way to tell two humans holding the same key apart — both are the one
  `owner` principal, in presence and in the trace ledger alike.
- It never expires and no grant row revokes it. That is deliberate: it is the
  break-glass credential, and one that can lock you out is not break-glass.

What is protected:

- Every door is closed to an unauthenticated caller. There is no anonymous read.
- Delegated authority is real and revocable. Per-principal bearer tokens minted
  through `core.access.mint` carry a capability subset and an optional container
  scope; `core.access.revoke` kills them and severs their live sockets at once.
- Ordinary credentials expire. Human browser credentials have a **14-day** lifetime and
  ordinary agent/automation credentials **one hour**. Expired credentials are refused as
  `expired` over HTTP and session sockets; automation must obtain fresh authorized credentials
  for longer work and revoke its test credentials when finished. The recovery owner key and
  machine enrollment (`docs/ENROLL.md`) remain non-expiring; internally generated terminal
  credentials are revoked when their terminal exits or is removed.
- On upgrade through schema 24, existing unbounded ordinary credentials receive a one-time
  grace period from migration: fourteen days for humans, one hour for agents. The database is
  backed up first; restarts do not extend grace. Finite credentials, machine credentials and
  principals bound to running managed terminals retain their existing lifetimes. See
  `docs/CONTRACTS.md` §Identity for the exact policy before upgrading persistent automation.

If your deployment needs real authentication — named humans, SSO, an audit trail
of who opened the door — put an authenticating proxy in front: Cloudflare Access,
Tailscale, an OIDC-terminating proxy. It costs manifold no runtime dependency and
works today with no code (mechanics in the section below). Be exact about what it
buys: it authenticates the EDGE. Behind it manifold still sees one owner and still
cannot distinguish two humans holding the same key.

The reasoning is recorded in `docs/decisions/0019-identity-posture.md`.

## Already running a reverse proxy on this box?

Skip the bundled caddy: publish manifold on loopback and keep your existing proxy
as the TLS front (Caddy v2 forwards WebSocket upgrades natively):

```sh
docker compose -f compose.yaml -f infra/compose.hostproxy.yaml up -d --build manifold
```

Make the override sticky so every plain `docker compose` command (yours, an
agent's, a cron job's) uses it — one line in `.env`:

```sh
COMPOSE_FILE=compose.yaml:infra/compose.hostproxy.yaml
```

Without this, a plain `docker compose up -d` recreates the container with no
published port (the base file publishes nothing by design) and the proxy 502s.
The override also fences the bundled caddy behind a profile so it can never
contend for 80/443 in this mode. Note the scope: `.env` is per-checkout — an
explicit `-f` invocation or another working directory still bypasses it.

Point your proxy's vhost at `127.0.0.1:7777` (Caddy block:
`infra/Caddyfile.example`). `MANIFOLD_DOMAIN` in `.env` must still be
the public domain — it feeds `MANIFOLD_PUBLIC_URL`.

## Where data lives

Everything durable is in the `manifold-data` named volume, mounted at `/data`:

- `manifold.db` — SQLite store (scenes, principals, hashed tokens, session lifecycle).
- `owner.key` (mode 600) — the root bootstrap secret, generated on first boot unless
  `MANIFOLD_OWNER_KEY` pins it.
- `preview-identity.key` (mode 600) — the Ed25519 private key that signs short-lived preview
  identity assertions. It must remain private to this instance.
- `agent.token` / `agent.lock` — machine credential and local boot lock.
- `agent.pid` / `terminal-host.pid` — independent transport and terminal-host process handles.
- `terminal-host/host.sock` — private NDJSON Unix socket (0600, directory 0700), not a
  terminal checkpoint. Both processes use this path as `MANIFOLD_TERMINAL_HOST_SOCKET`;
  both modes require it. The server starts the host before the transport and reuses each
  verified pidfile independently across server-process restarts.
- `plugins/<id>/<sha256>.manifold-plugin.json` — the bundle an installed plugin was admitted
  from, beside `plugins/<id>/<sha256>/`, its extracted files (the child process runs
  `server.js` from there). The bundle is the artifact of record: every boot re-hashes it against
  the pin in `manifold.db` and re-extracts it, so an edited file beside it is overwritten, and a
  bundle that no longer matches is refused on the roster rather than loaded (ADR 0016, R8).
  Uninstalling deletes both; the plugin's stored data stays in `manifold.db` until it is purged.
- `plugin-uploads/` — the drop box: the only place `engine.plugins.install` accepts a bare path
  from (`MANIFOLD_PLUGIN_DEV_PATHS=1` lifts that to any path on the host, for development
  only). Create it yourself; copy a bundle in, then install it by path and hash.

Presence, cursor traffic, and terminal bytes are never persisted (by design).

## Backup

```sh
docker compose exec manifold tar cz -C / data > manifold-backup-$(date +%F).tgz
```

The archive contains the owner key and preview-identity signing key — store it like a secret.

## Replicate the database (optional)

The image ships [Litestream](https://litestream.io) and runs it only when you ask.
Four variables in `.env`, all required together, and any S3-compatible store works —
a bucket at a cloud object store, MinIO on another box, anything speaking the S3 API:

```sh
MANIFOLD_REPLICA_BUCKET=<bucket>
MANIFOLD_REPLICA_ENDPOINT=https://<s3 endpoint host>
LITESTREAM_ACCESS_KEY_ID=<key id>
LITESTREAM_SECRET_ACCESS_KEY=<secret>
```

With them set, the container's entrypoint (`infra/entrypoint.sh`) does two things and
nothing else: if `/data/manifold.db` is absent, it restores the newest replica before the
server starts; then it runs the server under `litestream replicate`, shipping every WAL
segment as it lands, with a fresh snapshot every hour and 72 hours of retention
(`infra/litestream.yml`). Without them the entrypoint is exactly
`bun packages/server/src/main.ts`.

One writer per replica. Never run two instances against one bucket path — the second
one restores over the first one's history — which also means "zero-downtime" deploys
that overlap old and new instances are off the table for a replicated hub.

Take a consistent copy at any time (this is the same command that would rebuild the
store on a new host):

```sh
docker compose exec manifold litestream restore -config /app/infra/litestream.yml -o /tmp/copy.db /data/manifold.db
```

With replication on AND `MANIFOLD_OWNER_KEY` pinned in `.env`, the container needs no
volume at all: a host with an ephemeral disk rebuilds `/data` from the replica on every
boot. Note what the replica is not: it holds `manifold.db` only, never `owner.key`, so a
pinned key is the one copy of that secret — keep it where you keep secrets.

## Rotating the owner key

Enrolled machines are unaffected. A machine token is an independent credential —
its own durable secret, hashed at rest, held by the spoke in its own 0600 file
(`docs/ENROLL.md`) — neither derived from the owner key nor referencing it. The
owner principal survives too: it is a durable row (`owner_principal_id`), so its
presence history, the grants naming it, and the containers it created all persist
across a rotation.

1. Replace the key. Which command depends on where it comes from — generate it
   inside the container either way, so it never enters shell history or an argv
   (`/proc/<pid>/cmdline` is world-readable).

   Generated-key deployment (the default — the key lives in the volume):

   ```sh
   docker compose exec manifold sh -c 'umask 077 && openssl rand -hex 32 > /data/owner.key'
   docker compose restart manifold
   ```

   Pinned deployment (`MANIFOLD_OWNER_KEY` set in `.env` — the pin wins and no
   `/data/owner.key` is written): print a fresh key, paste it into `.env` with an
   editor, then recreate the container.

   ```sh
   docker compose exec manifold openssl rand -hex 32
   docker compose up -d manifold
   ```

   The restart is not optional. `loadOwnerKey` (`packages/server/src/config.ts`)
   reads the key once at boot and never re-reads it.

2. Re-bootstrap your browsers. The old key in localStorage stops authenticating at
   the restart. Print the new URL the way `## Install` does — one of these, matching
   how you installed the key:

   ```sh
   # generated-key deployment
   docker compose exec manifold sh -c 'echo "$MANIFOLD_PUBLIC_URL/#key=$(cat /data/owner.key)"'
   # pinned deployment
   docker compose exec manifold sh -c 'echo "$MANIFOLD_PUBLIC_URL/#key=$MANIFOLD_OWNER_KEY"'
   ```

3. Deal with the tokens already minted. They are not derived from the owner key, so
   they keep working until they expire or are revoked. If you are rotating because
   the old key is believed leaked, that is not good enough — revoke them explicitly
   through the workspace's Sessions section (`core.access.revoke`), which severs their
   live sockets immediately.

4. Retire the old backups, or treat them as live secrets. Every archive from
   `## Backup` taken before the rotation contains the old `owner.key`.

## Install it as an app

The web client is installable as-is: the same server, the same bundle, no second build. Open
your instance in Chrome, Edge or any Chromium-based browser and use "Install app" (desktop) or
"Add to Home Screen" (mobile). The installed window loads the same bundle from the same origin.

Two things follow from installing, and both are deliberate:

- **Offline, it loads and tells you the truth.** The app shell is cached, so the window paints
  and shows a named `Offline` banner naming the instance it cannot reach. It is NOT offline
  editing: the server is authoritative for scene state, so nothing is queued, nothing is saved,
  and no door is answered from a cache.
- **A deploy is never sticky.** Every build gets its own cache generation, the document is
  revalidated on every load, and activating a new generation deletes the old ones. A window left
  open across an upgrade offers `Update ready · Reload`; if its bundle is too old to speak to the
  upgraded server it REFUSES with the reason and a reload button, instead of silently failing to
  reconnect. Nothing on the server needs doing for any of this — no cache headers to set, and no
  step in the upgrade above.

### Choose the browser identity at build time

The browser title and installed-app name are independent of the deployment hostname.
`VITE_MANIFOLD_SITE_TITLE` defaults to `manifold`; `VITE_MANIFOLD_ICON_BACKGROUND` accepts
a six-digit hex color (`#rrggbb`) for both app icons. Leave the color unset to retain the
production gradient. For a visibly distinct development deployment:

```sh
VITE_MANIFOLD_SITE_TITLE='dev - manifold' VITE_MANIFOLD_ICON_BACKGROUND='#c2410c' docker compose up -d --build
```

The same inputs work with `bun run dev:web` and `bun run build:web`. They can also be set in
the Compose project's `.env` before rebuilding. They are build inputs, not instance selection
or runtime server settings: changing a running container's environment or pulling an already
built published image does not rebrand its browser bundle. Defaults apply only when no shell,
Compose, or Vite dotenv configuration supplies the corresponding input.
A `development` build (§Environments) already marks itself: the sidebar's rev line begins with
`development ·`, and the tab title gains ` · development` when the title is left at its default —
a title you chose is left exactly as you chose it.

Generated manifest and icon URLs are content-addressed, and emitted filenames **and bytes**
participate in the service-worker cache generation. A branding-only rebuild therefore gets
new identity assets even when its source commit is unchanged; the ordinary update/reload flow
still applies. There is no provider-specific or hostname-specific branding path.

## Point one client at another instance

A client is a lens, not a part of the server it came from, so an installed app can look at a
different instance without a rebuild and without a second client:

```
https://<served-instance>/?instance=https://<other-instance>
```

The choice is remembered on that device (and only there), the banner says which instance is
being looked at, and `?instance=` with no value points it home again. Credentials are kept per
instance, so pointing a device elsewhere never disturbs the grant it holds here — each instance
still needs its own `#key=` bootstrap the first time. The API doors accept cross-origin requests
for exactly this reason; a bearer token remains the only authority on them.

## Upgrade

**Container replacement destroys in-container terminals.** The separate terminal host
survives a hub-process or transport restart, not destruction of the container/cgroup that
contains it. A persisted volume does not preserve PTYs. The commands below replace the
container; they are not an unattended terminal-preserving upgrade procedure.

Before replacing a container that serves terminals, dispatch
`core.machines.drain { machineId, draining: true }` (workspace `machines:mint` authority).
The hub persists closed admission before asking the terminal host to close its own admission.
Success reports `{ terminalHostId, draining, terminalIds }`; refusal or timeout is a HOLD,
never evidence of an idle host. Drain kills nothing. Let existing work finish; do not
replace the container while terminals remain. Even an empty live-id report is not the final
stop check: the host's private socket `shutdown_request` atomically requires draining and
zero retained terminals, including exited terminals awaiting acknowledgement. It refuses
`not_draining` or `terminals_retained`; there is no force option or signal fallback.
After successful maintenance and replacement, explicitly reopen with
`core.machines.drain { machineId, draining: false }`. See `CONTRACTS.md` for refusal and
cancellation semantics.

Released legacy agents combine transport and PTY ownership and cannot transfer running
terminals to the split host. A capable hub still accepts their wire protocol, but their
drain request is refused after closing hub admission. Keep their replacement held until
their actual terminal inventory is safely empty; neither SSH-session count nor a healthy
service/connected machine proves that. The protocol-24 split lifecycle described here is
the source contract, not a claim that a release or production migration has occurred.

Once the terminal-owning lifetime is safely stopped (or this container serves no terminals):

```sh
git pull && eval "$(bun scripts/build-identity.ts --env)" && docker compose up -d --build
```

(The `eval` stamps the image with this checkout's identity so `/healthz` names the commit you
built; without it the image still runs and says `development` at the packaged version.)

Or, running a published image, name the new tag in `.env` and pull it:

```sh
docker compose pull && docker compose up -d
```

SQLite schema migrations run automatically on boot (`packages/server/src/db.ts`
MIGRATIONS); the volume carries the data across image rebuilds.

## The hub is also a machine

The container auto-spawns a terminal host and a separate network transport enrolled as
`${MANIFOLD_MACHINE_NAME}` (default `hub`). Its shells run **inside the container** — the
toolset is whatever the image ships. For real shells on the host (or any other box), enroll
that box natively as a spoke per `docs/ENROLL.md`; do not mount the docker socket or host
paths into the hub container for this. `MANIFOLD_SPAWN_AGENT=0` in `.env` disables both
local processes on boot. Choose this before using the container for terminals when
unattended container replacement is required; changing it is not a migration of live shells.

Native transport-only updates can preserve terminals when supervision leaves the separate
terminal host untouched. Host upgrades, reboots and service-group teardown remain destructive
and must be held behind drain plus the atomic maintenance shutdown check. A host's SIGTERM
still kills its shells; restarting a service group is not a transport-only update.

## Environments

Three verbs, three separate decisions, one identity that tells you which one produced what you
are looking at.

**Build.** Every build — the server, the web bundle, a container — carries the same three-word
identity, derived once by `scripts/build-identity.ts` from `git describe --tags --match 'v*'`:

| field     | meaning                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | the last release tag reachable from the built commit, without its `v` (`0.6.2`)                                                                |
| `build`   | `version` when the commit IS that tag; `<version>+<distance>.g<sha7>` past it (`0.6.2+21.gb7a07fe`); `.dirty` appended for uncommitted changes |
| `channel` | `release` when `build` equals `version`, `development` otherwise                                                                               |

A container ships no `.git`, so it is told: the Dockerfile ARGs `MANIFOLD_VERSION`,
`MANIFOLD_BUILD` and `MANIFOLD_CHANNEL` become the runtime environment the server reads and the
bundle's compiled-in identity. `compose.yaml` forwards them, and
`eval "$(bun scripts/build-identity.ts --env)"` exports them from your checkout; left unset, the
image falls back to `packages/web/package.json`'s version as a `development` build, which is
the honest answer for an unstamped image. A development build also says so in the browser: the
sidebar's rev line reads `development · v<build>`, and the tab title gains ` · development`
unless you chose a `VITE_MANIFOLD_SITE_TITLE` of your own (§Choose the browser identity).

**Release.** `bun run release -- <major|minor|patch|x.y.z>` publishes versioned artifacts from a
green `main` — the GitHub Release, the fleet binaries, the `ghcr.io/atyrode/manifold:<tag>` image
stamped `version = build = <x.y.z>`, `channel = release` — and deploys nothing.

**Promote.** `bun run promote vX.Y.Z` puts one PUBLISHED release on the operator's production
instance: it refuses a tag that is not a published GitHub Release, dispatches
`.github/workflows/deploy-hub.yml` with that tag, watches the run to completion and ends with
the fleet-pin reminder. Production is the GitHub Environment `production`; its deployment
history is the ledger of what production ran, and protection rules attach there. Promotion is
never a side effect of a release or of a green `main`.

**Fleet pin after promotion.** Once the hub answers with the promoted build, `deploy-hub.yml`
dispatches `update-pins.yml` in atyrode/dotfiles so the spokes follow the hub in that order
(invariant 10) instead of racing it on the pin cron. The step runs only when the repository
secret `DOTFILES_DISPATCH_TOKEN` exists; absent or expired, it is skipped and the dotfiles cron
with its `/healthz` hold remains the floor, so promotion itself never fails on it. The token is
a fine-grained PAT named `manifold-cicd` on the operator's account, scoped to the single
repository atyrode/dotfiles with Actions: read and write and nothing else; the current one
**expires 2026-12-05**. Renewal: mint the same-shaped token at
`github.com/settings/personal-access-tokens`, then on an operator device
`gh secret set DOTFILES_DISPATCH_TOKEN --repo atyrode/manifold < <file>` and shred the file —
the value never enters argv, a log or a chat. An agent that sees the "Dispatch the fleet pin"
step skipped or failing on a promotion run, or that reads this paragraph within a month of the
expiry date, tells the operator to renew; the date above is updated in the same commit as the
renewal.

**Development** is the operator's second instance, and it runs every green `main`:
`.github/workflows/deploy-dev.yml` follows the CI workflow, hands the commit sha to the host over a
forced-command SSH key, derives the expected `build` from the same checkout with the same script,
and fails unless `/healthz` on the development URL answers exactly that. It is the GitHub
Environment `development`, inert unless the repository variables `DEV_DEPLOY_HOST`,
`DEV_DEPLOY_USER` and `DEV_DEPLOY_URL` and the secret `DEV_DEPLOY_SSH_KEY` exist, and it names no
host or provider: the receiver is `infra/previews/receiver.sh`.

**Previews** are an optional development tier: `preview.<domain>` shows integrated `main`,
`<N>.<domain>` serves PR N's last explicitly deployed SHA, and non-numeric `<name>.<domain>`
serves a live worktree on the preview host with hot reload. Numbered previews are on demand:
opening a PR or pushing does not provision or update one. Dispatch
`.github/workflows/deploy-preview.yml` from `main` with `pr=N` and `action=deploy` to deploy
an open same-repository PR's current head; request again after a push to update it.
`action=stop` releases resources sooner, and closing the PR still tears it down automatically.
The exact CLI commands, run-watching steps and inspection/reporting guidance are in
`infra/previews/README.md` §Request, inspect and stop a PR preview. With
`MANIFOLD_PREVIEW_DOMAIN=<domain>` on production, integrated and numbered previews use the
production browser identity handoff (ADR 0027): public URLs carry no secret, production
credentials never enter preview code, and production capability restrictions are preserved.
A fresh preview seeded from development still accepts the development owner key as break-glass.
`PREVIEW_DOMAIN` names the domain; setup, seeding, live mode and the operator-only
pre-authenticated fallback command are documented in `infra/previews/README.md`. A self-hoster may
skip this tier entirely.

**A self-hoster replaces the `deploy-*.yml` files.** They are the operator's deployments,
gated on repository variables so a fork never runs them (ADR 0022). Yours consume the same
releases: `docker compose pull` a tag, or build a commit and stamp it as above. Whatever you run,
`/healthz` tells you what it is — `curl -fsS https://<your-domain>/healthz` answers
`{ ok, version, build, channel, protocolVersion }`, and the sidebar's rev line prints the same
`build`, so the client you are looking at and the instance it looks at can be compared by eye.

Before installing a newer agent binary, its target hub must support that protocol version.
The operator's automated fleet pins hold newer-protocol candidates until production is ready;
publishing an artifact does not waive that ordering constraint.

## Verify a deployment

First ask what runs:

```sh
curl -fsS https://<your-domain>/healthz
# {"ok":true,"version":"0.6.2","build":"0.6.2","channel":"release","protocolVersion":22}
```

`build` is the tag you deployed (a release) or the commit past it (a development build:
`0.6.2+21.gb7a07fe`); `channel` says which; `protocolVersion` is what a client must speak.
Then, from any checkout of this repo:

```sh
bun scripts/verify-public.ts https://<your-domain>
```

This drives a real browser through drawing, canvas persistence, an embedded
terminal on the `hub` machine, two viewers on one session, and anonymous denial.
