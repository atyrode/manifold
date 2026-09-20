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
four package targets. Their input includes dependency manifests and declared workspace
executable targets, so Bun creates the same relative command links as a full-source install
without making unrelated source changes invalidate dependency vendoring.

Run `bun scripts/verify-nix-packaging.ts` on the target with Nix and Bun 1.4.2 available;
it needs no workspace dependency installation. The verifier builds and independently
rebuilds the fixed-output dependency tree, then builds both compiled packages. From a private
temporary directory with no inherited operator configuration, it exercises agent maintenance
help and a loopback-only disposable hub, checking health and the installed web assets.
CI runs this proof natively on Linux and macOS, each on x64 and arm64. A warm dependency
store path alone is not proof that the current recipe reproduces its pinned hash.

When dependency inputs change, derive any replacement hashes from fresh installs and retain
the independent rebuild check. Explicit `--os`/`--cpu` controls can measure another target's
dependency bytes, but cannot prove its compiled binary executes. Package smoke does not
enroll or activate a native owner, nor establish the target kernel's containment guarantees.

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

| Unit / path                                                 | Ownership                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifold-server.service`                                   | Hub HTTP/WebSockets, SQLite, instance authority and local configuration preparation                                                                                 |
| `manifold-owner.service`                                    | Retained terminal host plus native owner; no machine token or hub key in its environment                                                                            |
| `manifold-transport.service`                                | Replaceable outbound machine channel; reads only its enrolled machine token file                                                                                    |
| `/var/lib/manifold`                                         | Private 0700 hub/control storage; owner key, machine token, immutable `job-owner/config.json`, durable owner state/journal/artifacts/sealed outputs                 |
| `/var/lib/manifold-workload/{home,data,state,cache,config}` | Persistent declared workload anchors, separate from protected control storage                                                                                       |
| `/var/lib/manifold-output`                                  | Dedicated bounded tmpfs, the `runtime` anchor for named-output locations and for `job-inputs`, where bound inputs are extracted; temporary, not durable owner state |

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

The `runtime` anchor now also hosts **bound input extractions**, in an owner-private
`job-inputs` subdirectory the owner creates and protects: a job whose request binds another
job's sealed output gets that archive written out into a fresh 0700 directory there and
mounted read-only at `/inputs/<name>`, then removed when the job settles. It is the right
device for it — derived bytes, bounded by the kernel, gone at reboot — but it is the SAME
finite backing named outputs use, so size it for both: the concurrent jobs' `outputBytes`
plus their `inputBytes`, the latter defaulting to each operation's own `outputBytes`. The
module's 1 MiB default is a bound for stdio and small named outputs, not for handing a
corpus to a job; raise `execution.outputBytes` and `execution.outputInodes` before declaring
an operation that binds one. A full backing refuses the job with `input_storage_exhausted`
at preparation rather than starting it half-fed, and a machine that configures no `runtime`
anchor refuses `input_storage_unavailable`: extractions never land in owner state.
Because the owner protects `job-inputs`, a declared location that resolves into it fails with
`private_owner_source_overlap`; do not point a workload location at that name. Extractions
are derived, never durable — the owner deletes every one it finds at startup, because a tree
that outlived its generation belongs to a job that will never run again.

`execution.runtimeTools` maps the manifest's tool names to reviewed
`{ source, target, kind }` bindings. Choose explicit executable targets such as
`/runtime/bin/<tool>`, `/bin/sh` or `/usr/bin/git`; sources must be real files/directories,
not symlink aliases. Directory bindings cannot contain foreign mounts or protected data.
A dynamically linked executable without its loader cannot run in the empty sandbox.

For Nix-packaged tools, `execution.runtimeToolClosures` selects packages by the same alias
and adds their exact transitive store paths as read-only file or directory bindings at
Nix build time. Unsupported store-root object types are rejected rather than followed.
Read-only runtime handles accept hard-linked package files; private configuration,
credentials and writable output files retain their single-link requirement.
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

Use authenticated `engine.jobs.describe { machineId, pluginId }` with `machines:read`
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
Hub/transport protocol 30, terminal-host IPC 2 and native job-owner RPC 33 have separate
compatibility gates. A compatible transport keeps retained terminals and maintenance
reachable even when the owner's native RPC cannot admit jobs. An older owner's missing
IPC-2 execution declaration cannot be treated as permission to create an unconfined shell.

When a replacement owner connects, its predecessor's tiles remain in the hub as exited with
unknown exit code and show **Restart** instead of vanishing. A transport or IPC-seat disconnect
alone is not evidence of owner death: tiles remain live but unreachable until the same owner
reconnects or a replacement owner is admitted. The directory last observed on Linux is retained,
and Restart creates a new PTY in the same tile; it does not preserve the process, shell history
or running work. Failed restarts and nonzero or unknown exits keep their tiles; clean shell
exits still remove them. Legacy tiles without a recorded
launch recipe can be restored as a plain interactive shell only on a currently unconfined owner;
the UI names that fallback. Governed owners refuse such missing recipes. An older retained owner
without restart support remains usable but refuses Restart as `unsupported`; replace it only
through the existing maintenance procedure. Darwin currently reports cwd as unknown.

Tile retention changes no maintenance permission: drain still closes admission and kills
nothing, Restart refuses while drained, and shutdown still requires an atomic drained-and-empty
acknowledgement. A restartable tile is not evidence that replacing an occupied owner was safe.

Before activating a hub whose `JOB_OWNER_PROTOCOL_VERSION` changes, drain the machine and
resolve retained jobs while the incumbent hub can still command its owner. Atomically shut
down that empty owner, start the new owner while admission remains drained, activate the
compatible hub and transport, prove native readiness, then reopen. Do not activate the hub
first merely because the owner unit is protected from restart: that strands retained jobs
behind the new hub's execution fence. The bounded legacy-retirement bridge in the
[`/ws/machine` contract](CONTRACTS.md#ws-wsmachine--machine-channel-json-data-fields-base64)
exists only to empty an already-stranded exact pinned owner; it never makes that owner
eligible for execution or service readiness.

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
Supervisor-managed callers must also pass `--expected-pid "$MAIN_PID"` from the explicitly
selected owner unit. The optional constraint is checked against status on that same
connection before any shutdown request; a mismatch holds. Independent manual maintenance
may omit it, but an unbound acknowledgement cannot authorize stopping an arbitrary unit.

For the source-shipping Docker image, use the identical CLI **inside the owning container**;
the credential read stays inside Manifold:

```sh
docker exec "$CONTAINER_ID" bun packages/agent/src/main.ts --maintenance drain \
  --hub http://127.0.0.1:7777 --machine-id "$MACHINE_ID" --owner-key-file /data/owner.key
docker exec "$CONTAINER_ID" bun packages/agent/src/main.ts --maintenance shutdown \
  --socket "$TERMINAL_HOST_SOCKET" --terminal-host-id "$TERMINAL_HOST_ID"
```

For retiring an old external spoke of a retained preview hub, use the source-managed
[`infra/previews/retire-spoke.sh` operation](../infra/previews/README.md#retire-an-old-development-spoke-before-native-activation).
Its documented invocation requires the public container, machine, terminal-host identity,
terminal-host unit, transport unit, separately reviewed immutable transport package, socket
and private runtime-directory references.
It bundles only the reviewed maintenance CLI and streams the public code into the owning
container, including when that container predates the command. The key read remains at
`/data/owner.key` inside that container; no deployed executable or credential is replaced.
It closes admission, refuses busy/unknown work, stops only the independent non-owning
transport before the PID-bound atomic shutdown, and restores that transport on refused
proof without reopening admission. Both supervisors' propagation and stop hooks are checked;
owned, metadata-verified runtime drop-ins non-disruptively inhibit restarts across acknowledgement
and are restored afterward. Only positive acknowledgement permits disabling the old
supervisors. The helper never stops the owner by unit name: it awaits its own exit and refuses
an unexpected generation. Actual inactive/dead, PID-zero, disabled state must be proved.
It never invokes Nix or activates/deploys anything. A native startup guard must independently
refuse active, enabled/restartable or unobservable old user supervisors; activation must not
automatically stop or mask them.

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

### HTTP response hardening

Direct Bun responses include `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin`; preview callback/finalize documents keep
the stricter `no-referrer` policy. The Caddy examples supply these only when the upstream
omits them, so proxying does not weaken the callback policy.
Custom proxies should likewise forward upstream values or add defaults only when absent:
unconditional addition or replacement can duplicate headers or weaken `no-referrer`.

`infra/Caddyfile.example` and `infra/compose.Caddyfile` add
`Strict-Transport-Security: max-age=86400` only on HTTPS requests to a non-localhost vhost.
The policy is **one day, this host only**: no `includeSubDomains`, no `preload`. Plain HTTP,
`localhost`, `*.localhost`, `127.0.0.1` and `::1` do not acquire HSTS from these examples.
Bun does not emit HSTS or trust `X-Forwarded-Proto` to decide it; a custom TLS proxy owns
the corresponding policy.

HSTS takes effect after a browser receives it over HTTPS and protects subsequent visits while
cached. It does not secure an initial cleartext visit; preload would be a separate commitment,
not an implied part of this configuration. A URL fragment is never sent in the HTTP request,
so this is transport hardening, not remediation for a passive cleartext-fragment disclosure.
Changing an example does not change an already-running proxy: inspect the actual HTTPS origin
after deliberately applying its configuration.

The shell's frame denial is not a restrictive script/connect policy. Trusted in-realm plugins
and foreign lenses remain supported; hardened Workers still retain ambient networking.
[Browser response policy](CONTRACTS.md#browser-response-policy) and
[ADR 0048](decisions/0048-compartment-scoped-csp.md) distinguish shipped headers from the
unshipped confinement design.

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

Before an upgrade that migrates data on an ephemeral `/data` volume, or whose migrated database
cannot be opened by the previous release, capture an authenticated recovery checkpoint while the
current hub still owns the data and administrative file mutations such as plugin installation and
key rotation are paused. Stream the reviewed helper from the release checkout so this also works
when the incumbent predates the helper:

```sh
docker compose exec -T manifold bun - capture before-vX.Y.Z < scripts/full-state-recovery.ts
```

This mode requires the four replica variables below and a pinned `MANIFOLD_OWNER_KEY`. It makes
consistent SQLite copies, includes every other regular `/data` file except process handles and
database sidecars, encrypts and authenticates the result with a purpose-bound key derived from
the owner key, and writes it once under `manifold-full-state/<id>.mfr` in the same dedicated
object store. It refuses links, devices, an existing object, changing non-database files, a bad
database, more than 10,000 files or a complete encrypted object larger than 256 MiB. Stdout is
the non-secret receipt: checkpoint id, source build, object name, encrypted-object SHA-256 and
size. Retain it outside the container. Before promotion, run `verify ID SHA256` with the same
incumbent environment: it downloads and authenticates that exact object, checks its source build
against `MANIFOLD_BUILD`, extracts into a private temporary directory, checks every SQLite file,
and removes the temporary plaintext on success or failure. Rehearse the forward migration and
full recovery-image boot separately; neither the tar command nor helper verification proves the
provider switch.

Before starting that migration, set an operator-controlled retention period covering the entire
rollback window for the encrypted `manifold-full-state/<id>.mfr` object, not just its receipt.
Protect that object with provider versioning or immutable retention and deletion protection,
administered separately from the hub's ordinary storage credential. Check that lifecycle rules
cannot expire it during that window; Litestream's database-history retention is not checkpoint
retention. Keep the receipt outside the disposable volume and retain the exact previous release
image by immutable digest. Do not proceed without a verified, retained checkpoint and a rehearsed
recovery path. After the window closes, pruning those artifacts is an explicit operator action.

The owner key must remain outside the checkpoint's object store and available to recovery. A
lost or rotated key cannot authenticate an older checkpoint. Treat the encrypted object as
sensitive despite that protection.

## Replicate the database (optional)

The image ships [Litestream](https://litestream.io) and runs it only when you ask. Four
variables in `.env`, all required together, point it at an S3-compatible store:

```sh
MANIFOLD_REPLICA_BUCKET=<bucket>
MANIFOLD_REPLICA_ENDPOINT=https://<s3 endpoint host>
LITESTREAM_ACCESS_KEY_ID=<key id>
LITESTREAM_SECRET_ACCESS_KEY=<secret>
```

Treat the replica as a sensitive, authority-bearing backup, not as ordinary application data.
`manifold.db` includes principals, grants and other authorization state, token and share hashes,
installed-plugin state, and raw outbound `dials.secret` bearers when this hub connects to another
instance. A storage administrator who can read the replica can recover those dial bearers; one
who can replace it can replace authority and installed-plugin state on the next restore. When no
local database exists, missing, unreadable, corrupt, or failed replica history refuses startup
rather than creating replacement history.

Use a dedicated bucket for each hub; the shipped config fixes the object path to `manifold.db`.
If you maintain a custom Litestream config with a prefix, isolate that prefix to one hub instead.
Give its credential only the object-list/read/write/delete permissions Litestream requires at that
location; do not reuse a fleet-wide or general object-storage credential, and keep the secret with
the hub's other deployment secrets. Its ordinary object deletes support Litestream's configured
retention, but it should not be able to delete protected versions, bypass retention, or change
bucket versioning, lifecycle, lock, or access policy. Put those administrative controls under a
separate identity. Enable provider-appropriate versioning or immutable retention, deletion
protection and recovery retention, then rehearse a restore. Transport security and encryption at
rest are properties you must configure and verify with the chosen provider or endpoint:
S3-compatible means API-compatible, not encrypted.

With the four variables set, the entrypoint runs one fail-closed preparation gate before either
Litestream replication or the server may start:

- An existing `${MANIFOLD_DATA_DIR:-/data}/manifold.db` must pass a read-only SQLite integrity
  check and have a positive schema version supported by this image. A zero-byte, foreign, corrupt,
  or newer-schema file is not a fresh database: startup refuses and leaves it in place.
- A missing main file with any `manifold.db-wal`, `manifold.db-shm`, or `manifold.db-journal`
  sidecar is also unusable local evidence. Startup refuses and preserves those files; it never
  publishes restored or initialized history beside them.
- With no local database, the gate gives `litestream restore` five minutes to restore the configured
  replica into a private staging directory on the same data filesystem. A usable restored database
  is published without replacing another file. A restore error or timeout always refuses startup.
- A successful restore that produces no database means the configured replica is empty. It refuses
  by default. Only a valid one-time first-initialization acknowledgement consumed by this same
  attempt permits the gate to initialize a new database.
- On every refusal, neither `litestream replicate` nor the server starts. Preparation removes only
  the private staging directory owned by that attempt; it does not delete or rewrite local data or
  replica objects.

The acknowledgement is deliberately separate from recovery. For an actually new hub, while the
`manifold` service is stopped and before its first `docker compose up`, inspect the configured
bucket or prefix and confirm that it is the intended, empty replica. Then use the normal Compose
service image, volume, and environment to record one attempt:

```sh
docker compose run --rm --no-deps --entrypoint bun manifold \
  scripts/replica-bootstrap.ts acknowledge
docker compose up -d manifold
```

`acknowledge` contacts and modifies no replica and starts no hub. It requires the four settings and
refuses an existing local database, orphan SQLite journals, or pending acknowledgement. Its mode-0600
record expires after 15 minutes and binds by digest to the Litestream configuration, its referenced
environment inputs, and replica credentials, including custom-prefix configurations. The next
preparation attempt consumes it before trying the restore,
whether that attempt restores history, finds the replica empty, times out, or fails. Thus an
acknowledgement cannot survive one failed attempt and silently authorize a later empty boot; issue
the command again only after inspecting and correcting the same intended replica. There is no
persistent environment switch for first initialization.

An expired, malformed, or configuration-mismatched record remains a refusal, even if local history
is otherwise valid. With the service stopped, explicitly discard the pending record before making
a fresh initialization decision:

```sh
docker compose run --rm --no-deps --entrypoint bun manifold \
  scripts/replica-bootstrap.ts discard
```

`discard` removes only the acknowledgement, requires no replica configuration or credentials, and
does not authorize initialization or contact the replica. Inspect the intended target again before
following the first-initialization steps. Changes to configuration or credentials require a fresh
acknowledgement; do not edit or retain the old record to bypass the refusal.

Do not use initialization to recover a hub, to work around unavailable or missing history, or to
replace a replica. Invalid local data remains evidence: stop the service, preserve or snapshot the
volume, and inspect a consistent copy before any deliberate quarantine or repair. Quarantine
`manifold.db` and its `-wal`, `-shm`, and `-journal` sidecars together; never move only the main file
and leave journals at the live pathname. Inspect and repair access to the intended replica rather
than clearing it. Quarantining local data is a recovery operation and does not authorize new replica
history. The authenticated full-state checkpoint procedure in [Backup](#backup) remains the separate
recovery path for the rest of `/data`.

Once preparation succeeds, the entrypoint runs the server under `litestream replicate`, shipping
every WAL segment as it lands, with a fresh snapshot every hour and 72 hours of retention
(`infra/litestream.yml`). Without the replica variables the entrypoint remains exactly
`bun packages/server/src/main.ts`.

One writer per replica. Never run two instances against one bucket path — the second
one restores over the first one's history — which also means "zero-downtime" deploys
that overlap old and new instances are off the table for a replicated hub.

Take a consistent copy at any time (this is the same command that would rebuild the
store on a new host):

```sh
docker compose exec manifold litestream restore -config /app/infra/litestream.yml -o /tmp/copy.db /data/manifold.db
```

With replication on **and** `MANIFOLD_OWNER_KEY` pinned in `.env`, the container can rebuild its
database on an ephemeral disk. The replica is `manifold.db` only: it does not contain `owner.key`,
the preview-identity signing key, the agent token, installed plugin bundle files, per-plugin
`plugins/<id>/data.db` databases, or adjacent `manifold.db.pre-vN.bak` migration snapshots.
Replacing that ephemeral volume loses its local migration snapshots. Restoring the current
database from Litestream does not restore those snapshots or undo a migration: a database-only
replica is not a complete migration rollback facility. Follow [Backup](#backup) before the
migration to retain a full-state checkpoint independently of the disposable volume. That
checkpoint recovers the pre-upgrade state, not writes made afterward. Preserve omitted files
separately as applicable; a replica-only rebuild also cannot recover plugin-owned rows.

Replica restore assumes the bucket or prefix is trusted for integrity. Protect the replica
credential and storage write path as access to the hub's persisted authority, use one writer per
replica, and restrict administrative write access accordingly. If your requirements include
restoring from storage writable by an untrusted party, add an authenticity check whose
verification secret lives outside that store; Manifold does not provide that mechanism.

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
Repository deployment starts only after successful **full** CI for its exact source revision.
Integrated development requires a full `main` push or manual-dispatch result at that SHA. Release publication starts from
an exact successful full-`main` predecessor; because the release process writes the tagged release
commit, promotion separately requires a full `main` push or manual-dispatch result for that exact
tagged revision. A numbered PR preview instead may use a full manual dispatch at that exact branch
head, and that proof authorizes only that branch's preview: it is never integrated-`main`, release
or production evidence. Fast pull-request `gate` success and artifacts from another tree do not
cross these boundaries.

Both `deploy-dev.yml` and `deploy-hub.yml` also require the `installed-bundles` job before
the switch. Development builds the candidate image for that exact revision; production pulls
the provenance-verified immutable release image instead of rebuilding application source.
The gate invokes the running target's root-only `engine.plugins.exportInstalled` door, then
boots that candidate against copies of the returned bundles and safe install rows in temporary
data directories.
The export travels through private stdin rather than a host bind mount, so differing
runner/candidate identities require neither shared file ownership nor broader file permissions.
It checks original enablement and a second disposable all-enabled copy so a disabled module
cannot hide a load failure. No production data volume, network, installer credential or owner
key is mounted into the candidate. Any held, missing, unverified or load-failed bundle refuses
deployment by plugin id with the candidate's minimum SDK contract.

Container health is only the switch's transport check, not a successful deployment. Both
workflows snapshot the running target immediately before switching and require the separate
**`verify-live`** job afterwards. The safe, one-day Actions artifact contains build identity,
machine/plugin identifiers, installation revisions and enablement, and instance-service state;
it contains no bundles, authored source, environment, credentials or policy bodies. A missing
credential, inventory door or unambiguous previous build refuses the switch.

Using the same root credentials as `installed-bundles`, ordinary live verification has one
**five-minute deadline**, including requests and retries. It checks the expected `/healthz` build, requires
every previously ready native installation to retain its revision and enablement and become
ready again, and requires every previously enabled instance service to remain enabled and reach
`ready`. Every installed plugin must also stay present and keep its enablement. A plugin that
declares a read-capability door accepting an empty object must answer it with valid results;
discovery never invents resource identifiers or calls a write. A plugin whose reads all take
arguments is verified by its roster row instead, and refused when that row is held or carries a
failed lifecycle. Disabled installed plugins are not silently excluded from this check.

The first unresolved divergence is named in the failing job and step summary. A failed development
switch or verification uses the existing compare-and-swap
`dev-rollback <candidate> <previous>` receiver operation; a failed explicit backward move uses
the receiver's forward operation to restore its newer incumbent.

Production promotion additionally requires the exact full-state checkpoint receipt captured from
the incumbent. After matching the receipt's source build to the serving build in the live
snapshot, the workflow admits that incumbent through the same release-provenance policy as
the candidate and retains its full `ghcr.io/<repository>@sha256:<digest>` reference. Missing
incumbent evidence blocks the switch. On failure it builds the reviewed
`infra/recovery.Dockerfile` from the promoted release while taking the application itself
from that verified previous release image, never by resolving a mutable image tag. Before
the previous application starts, the recovery entrypoint downloads the named encrypted object,
checks its receipt SHA-256, authenticates and decrypts it with the pinned owner key, validates
every path and file digest, restores only into empty `/data`, and runs full SQLite integrity
checks. Later SQLite writes use a checkpoint-specific Litestream prefix rather than the forward
deployment's migrated history. That live replica retains the existing object-store integrity trust
described above; it is not covered by the checkpoint's authentication. Ordinary live verification
then checks the recovered previous
build against the unchanged pre-switch snapshot. The workflow remains failed even when recovery
succeeds; failed recovery stays visible rather than claiming that the previous release is serving.

Recovery settings remain active after a successful rollback so a provider restart repeats the
authenticated file restore and resumes each database from that recovery prefix. Do not install
plugins, rotate file-backed keys or otherwise mutate non-SQLite `/data` files while this emergency
image is active: those files intentionally remain pinned to the checkpoint. Ordinary promotion
refuses any active recovery setting: the serving recovery replica must first be reconciled through
separately reviewed maintenance, not silently replaced by the failed candidate's original replica.
There is no automatic recovery-to-forward handoff. Do not clear those settings to bypass the hold.
The ordinary entrypoint also refuses nonempty recovery settings rather than silently ignoring
them. Neither path restarts a native execution owner.

A previous binary can refuse a database already migrated to a newer schema. At that boundary,
code-only rollback is not a recovery path: the authenticated full-state receipt and immutable
previous release image are mandatory. The bootstrap flag neither restores database state nor
bypasses schema-version admission.

Live snapshots use format 2 and record the source protocol. A pre-native hub, such as
v0.14.0 on protocol 25, has no governed native inventory: that capability first appeared
in protocol 27. Its schema-compatible HTTP metadata is inspected using the existing
root-only `core.access.listGrants` read to prove authority; the grant response is discarded,
not captured. Native inventory is considered absent only below that protocol boundary
and without contradictory native declarations. Missing or partial modern native APIs,
inconsistent protocol metadata, and protocols newer than the verifier supports are fatal.
This does not change the SDK's exact-version runtime negotiation. Enrolled-machine and
installed-plugin continuity remains required, including ordinary rollback; a snapshot
from a native-capable hub cannot be verified against a pre-native target. Capture with the
current verifier before switching, then retain that same snapshot rather than replacing
its baseline after the upgrade. A pre-native snapshot cannot prove preservation of native
installations that the old hub did not support.

Plugin snapshots record configured enablement, not the effective `enabled` value that becomes
false under a compatibility hold. The root-only `engine.plugins.listInstalled {}` read returns
only installed plugin identities, artifact hashes and configured enablement; the verifier
matches those identities and hashes to the roster before trusting the intent. It does not
fetch bundle bytes for that check. On an older target without this door, held rows and
unavailable disabled rows are refused rather than treated as an operator's disablement.
Only the explicit maintenance exception below permits held effective state with unchanged
configured intent.

An enabled native installation's revision and enablement are durable intent: a hub restart
or data-only record rewrite is not a new deployment. Enabled instance services on proved
owners are re-admitted after restart without an operator call, including when their previous
job finished while the hub was absent. A compatibility hold can make a plugin unavailable
without silently changing its durable native enablement; lifting that hold reuses the
installation's existing revision.

Configure root-authorized credentials as `DEV_INSTALLED_BUNDLES_TOKEN` and
`HUB_INSTALLED_BUNDLES_TOKEN` in repository secrets, scoped operationally to their respective
target origins (`DEV_DEPLOY_URL` and `MANIFOLD_HUB_ORIGIN`). Both gates reuse these credentials.
The export door returns no
credential lineage or source URL credentials. Missing credentials and a target returning
`unknown_action` for `engine.plugins.exportInstalled` fail closed by default, never mean an
empty installed set.

For a target predating the export door, both workflows accept an explicit
`workflow_dispatch` input **`bootstrap_gate=true`**, defaulting to **false**. This is the
one-time bootstrap for the upgrade that introduces the door: only an authenticated export
invocation returning the structured `unknown_action` refusal permits the installed-bundles
job to pass without checking inventory. It emits an Actions `::warning::` naming the target
and reason, records both in the step summary, and writes `bootstrap_required=true` to
`GITHUB_OUTPUT`. An ordinary successful candidate writes `bootstrap_required=false`; a
failed gate emits no success output. HTTP errors (including a generic 404), authentication
failures, other refusals and candidate failures still fail closed. When the door exists,
the raw flag has no effect: the ordinary candidate gate and ordinary live verification run.

Only the installed-bundles job's proven `bootstrap_required=true` output enables
`VERIFY_LIVE_BOOTSTRAP_GATE=true` on the forward candidate's live-verification step. This
one-deployment maintenance check may defer installed plugins held specifically for
`repack_required`, and an unchanged configured native instance service that is `unavailable`
with reason `plugin_held` directly attributable to such a plugin. The service must retain
its machine/plugin identity and its owner must remain online and connected, not draining
or revoked. A previously ready native installation may also defer readiness only when its
revision and enablement are unchanged, its owner is connected and online, neither draining
nor revoked, no purge is requested, and its nonempty operation descriptions all report
`plugin_held` for the same repack-held plugin. Missing operation descriptions cannot support
that exception. These refusals take precedence over resource checks, so they do not prove
that the underlying resources are healthy. Other holds and reported failures are not
deferred. Build and snapshot identity, installed plugins and their configured enablement,
native installation identity, revisions and enablement remain strict. The verifier names every held plugin, deferred
installation and deferred service rather than claiming full health.

The candidate step publishes `maintenance_required=true` while any repack hold remains,
otherwise `false`, and the `verify-live` job exposes that result. A successful maintenance
run permits this one hub deployment to remain installed, but dispatches neither a
preview-owner pin nor a production fleet pin and does not claim ordinary verification.
An absent maintenance result also blocks pinning. The pre-switch snapshot, exact-build
check, five-minute deadline and automatic rollback remain required. Automatic recovery
always verifies the previous revision without the maintenance flag; explicit development
rollback also uses ordinary live verification.

For production, `bun run promote vX.Y.Z --bootstrap-gate --recovery-receipt PATH` reads the
non-secret JSON receipt from the incumbent's full-state capture, then dispatches `deploy-hub.yml`
with the published `tag`, `bootstrap_gate=true`, and the exact checkpoint id, source build and
encrypted-object SHA-256. For development, dispatch `deploy-dev.yml` from `main` with
`operation=deploy`, the full `target_sha`, a non-secret reason, acknowledged
`compatibility_reviewed`, and `bootstrap_gate=true`. The forward operation uses the existing
monotone receiver; it does not require `expected_current_sha`. Direction is independent of
the bootstrap flag: `operation=rollback` remains the default and retains its compare-and-swap
guard. Exact-revision full CI, deployment ordering and environment approval remain required.
Automatic development deployments never opt into bootstrap.

Use the exception only for that first upgrade, then leave it false. A bootstrap receipt is
not a successful installed-bundle check. Install the repacked plugins named by the new hub's
held roster, preserving native installation intent, then run ordinary live verification
against the retained pre-switch snapshot and the deployed expected build with
`VERIFY_LIVE_BOOTSTRAP_GATE` unset. Only a successful ordinary check, including the previously
deferred product reads, native installations and service readiness, ends maintenance. That check does not
rewrite the original workflow receipt or resume its skipped pin steps: perform the
separately authorized pin follow-through after ordinary verification, or let a subsequent
ordinary deployment verify and dispatch its pin. Neither repacking nor owner replacement
is automatic; occupied terminal owners still require the drained maintenance procedure.

Self-hosted automation can run the same `scripts/installed-bundles.ts IMAGE` with
`INSTALLED_BUNDLES_ORIGIN` and `INSTALLED_BUNDLES_TOKEN` supplied through its secret environment.
Its equivalent explicit opt-in is `INSTALLED_BUNDLES_BOOTSTRAP_GATE=true`; when
`GITHUB_STEP_SUMMARY` names a file, the same bootstrap receipt is appended there.
The live equivalent is `scripts/verify-live.ts snapshot PATH` before the switch, then
`scripts/verify-live.ts verify PATH EXPECTED_BUILD` afterwards, with `VERIFY_LIVE_ORIGIN`
and `VERIFY_LIVE_TOKEN` supplied through the environment. Forward only the installed gate's
actual `bootstrap_required=true` output as `VERIFY_LIVE_BOOTSTRAP_GATE=true` for that
candidate, never the input flag alone or a rollback. Successful live verification writes
`maintenance_required=true` or `false` to `GITHUB_OUTPUT`; gate pinning and health claims on
an explicit `false`. Replacement automation owns its rollback operation when verification
exits nonzero, and must use ordinary verification for the restored revision.

**Release.** `bun run release -- <major|minor|patch|x.y.z>` publishes versioned artifacts from an
exact `main` revision with successful full `main` CI — an immutable GitHub Release, the fleet
binaries, and the image stamped `version = build = <x.y.z>`, `channel = release` — and deploys
nothing. The image's full `ghcr.io/<repository>@sha256:<digest>` reference is attached as
`release-image.txt`; the mutable registry tag is a convenience, not promotion authority.
Native GitHub/Sigstore artifact attestations bind the fleet binaries and image-reference file,
and a separate image attestation binds the OCI digest, to the exact repository, release tag,
source SHA and `.github/workflows/release.yml` signer at that SHA on GitHub-hosted runners.

The script pushes `release/vX.Y.Z`, opens a `release: vX.Y.Z` PR with its changelog and protocol
status, and enables rebase auto-merge. The repository must allow auto-merge and rebase merges;
required `agent-policy` and `gate` checks still apply, with no bypass. Release PRs from the
release committer (`atyrode`) are exempt only from issue lifecycle checks. After merge, the
script verifies that `origin/main` has the release tree, updates local main, then tags that
merged SHA and pushes only the tag to start `release.yml`. A closed PR, a 30-minute merge timeout
or a different main tree stops publication without a tag; interrupted-merge recovery is documented
in the script header. `bun run release --dry-run` remains read-only from any branch.

The shared `scripts/release-provenance.ts` policy requires the tag to identify a dedicated,
single-parent release commit on `main`, with the canonical version/changelog/consumed-fragment
delta only. Its parent needs successful latest full `main` CI; the single-commit merged
`release/vX.Y.Z` PR must have the same tree, successful PR CI and its required checks.
Promotion additionally requires successful latest full `main` CI for the exact tagged commit,
not merely its parent or a later unrelated revision. CI evidence includes the successful
`gate` job in the current run attempt. Artifact admission cryptographically verifies the
native attestation bundles, including signer identity and source digest; filenames, a release
title, an image label, or a locally authored provenance JSON are not substitutes.

**Strict future-release cutover.** Both candidate and rollback releases must be published,
non-prerelease, immutable releases with all required native attestations and source/CI
evidence. Existing legacy releases are not grandfathered, even for rollback. Enabling
immutability does not retrofit old releases or manufacture missing attestations. An incumbent
without that evidence blocks ordinary promotion before the switch, even if its checkpoint is
valid and the candidate is admitted. Moving such an installation onto the new release path
requires separately reviewed and authorized migration/recovery planning; neither the bootstrap
flag nor a manually supplied digest bypasses this hold.

**Protection and actor boundary.** Read-only observation on 2026-09-20 found immutable
releases enabled; `main` required `gate` and `agent-policy` from the GitHub Actions app with
strict status checking, no force pushes or deletion, administrator enforcement, and linear
history through a ruleset. There was no required PR review and no tag ruleset. These are
observations, not settings changed by this implementation or promises about future settings.
The release operator preflight reads the immutable-release setting using administrator-read
access. That REST read is unavailable to ordinary `GITHUB_TOKEN`; publication instead verifies
the resulting release's `immutable` flag without adding an administration grant.

[GitHub release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
locks assets and the associated tag at publication, not while the release is a draft.
Until then an actor with tag/release write authority can race admission or publication.
Repeated tag/source checks and post-publication verification detect mismatches, but do not
make the API check and publish operations atomic or prevent a bad release from being published
and then refused. Operators must control tag and release writers during publication; no tag
ruleset is assumed here. Immutable assets plus digest selection prevent later tag substitution
from silently selecting different application bytes, not deletion or loss of registry access.

This policy trusts GitHub's API, Actions/OIDC and attestation trust roots, the admitted build
workflow, trusted `main` admission code, and the operators controlling repository/provider
credentials and the production Environment. Attestations identify the producing workflow;
they do not prove its code harmless or its output reproducible. Source guards are not a
security boundary against actors who can rewrite trusted workflows, alter protections,
bypass administration, or directly deploy using provider credentials. Required CI with no
required review is not an independent human approval guarantee. Keep those authorities
controlled and configure production Environment restrictions/approval for the intended actors;
this change neither provisions nor verifies those protections.

**Promote.** `bun run promote vX.Y.Z --recovery-receipt PATH` puts one admitted immutable
release on the operator's production instance only after successful full CI for the resolved
tag commit. The receipt is the JSON line emitted by the incumbent's authenticated full-state
capture; promotion refuses an absent or malformed checkpoint identity, source build or
encrypted-object SHA-256. The command invokes the shared promotion policy, dispatches
`.github/workflows/deploy-hub.yml` from `main`, and watches it to completion.
The workflow refuses non-`main` dispatches and uses trusted tooling pinned to the dispatch's
`main` SHA, not policy supplied by the candidate tag. It independently invokes the same
promotion policy, with only source/release/PR/check/status/Actions read permissions and no
write, OIDC or administration grant. It retains the candidate's verified SHA and immutable
image reference, requires ordinary-image and recovery scaffolding in that release, matches
the receipt's source build to the live snapshot, verifies the incumbent through the same
policy, refuses active recovery settings, and requires one instance with zero-downtime
deployment disabled.

The read-only installed-bundle candidate gate and the actual production switch consume the
same verified image reference. `infra/release.Dockerfile` is only `ARG`/`FROM`, with no default
image or application build; the candidate tag supplies this reviewed wrapper, not a new
application build. `MANIFOLD_RELEASE_IMAGE` selects its base by digest, and `CC_DOCKERFILE`
selects the wrapper. The deployment provider
[forwards application environment as Docker build arguments](https://www.clever.cloud/developers/doc/deploy/applications/docker/#build-time-variables);
[Docker permits a global ARG in FROM](https://docs.docker.com/reference/dockerfile/#understand-how-arg-and-from-interact).
Recovery uses the same mechanism with `MANIFOLD_RECOVERY_BASE_IMAGE`, retaining the full
verified incumbent reference. The ordinary switch and recovery explicitly rebuild the wrapper
even for the same source commit, so a prior provider build cannot ignore changed image settings.
This is source-level integration based on the provider contract, not evidence that a live
deployment or recovery rehearsal has occurred.

Checkpoint authentication, freshness, restore rehearsal and continued object/key availability
are operator-owned preflight evidence; CI has neither the owner key nor object-store credentials
and does not establish those facts from receipt syntax. Successful promotion ends with the
fleet-pin reminder.
Production is the GitHub Environment `production`; its deployment
history is the ledger of what production ran, and protection rules attach there. Promotion is
never a side effect of a release or of a different green `main` revision.

**Fleet pin after promotion.** Once `verify-live` proves the promoted build and ordinary live
state with `maintenance_required=false`, `deploy-hub.yml` dispatches `update-pins.yml` in
atyrode/dotfiles so the spokes follow the hub in that order
(invariant 10) instead of racing it on the pin cron. The step runs only when the repository
secret `DOTFILES_DISPATCH_TOKEN` exists; absent or expired, it is skipped and the dotfiles cron
with its `/healthz` hold remains the floor, so promotion itself never fails on it. The token is
a fine-grained PAT named `manifold-cicd` on the operator's account, scoped to the single
repository atyrode/dotfiles with Actions: read and write and nothing else; the current one
**expires 2026-12-05**. Renewal: mint the same-shaped token at
`github.com/settings/personal-access-tokens`, then on an operator device
`gh secret set DOTFILES_DISPATCH_TOKEN --repo atyrode/manifold < <file>` and shred the file —
the value never enters argv, a log or a chat. A pin intentionally skipped for
`maintenance_required=true` needs the plugin continuation above, not token renewal.
Otherwise, an agent that sees the "Dispatch the fleet pin" step skipped or failing on a
promotion run, or that reads this paragraph within a month of the expiry date, tells the
operator to renew; the date above is updated in the same commit as the
renewal.

**Development** is the operator's second instance. Every green `main` normally deploys
forward through `.github/workflows/deploy-dev.yml`; retrying the revision already running
is allowed. The workflow verifies the exact full SHA against the latest eligible
same-commit CI run from this repository's `main` (push or dispatch), including its unique
successful `gate` job. It does not success-filter the query: a newer failed, cancelled, queued
or running proof cannot be hidden by an older success. It then hands the request to the host
over a forced-command SSH key and requires `verify-live` to prove both the build derived by
the one `scripts/build-identity.ts` implementation and native/product parity. Failed or skipped
live verification cannot produce a green deployment or dispatch an owner pin, including on the
automatic path. The SSH-bearing deployment steps execute
trusted default-branch code; for an older target it passes the explicit revision to that trusted
identity helper rather than checking out or executing the target's script.

A backward development move is a separate `workflow_dispatch` from `main` with
`operation=rollback` (the default). Supply `target_sha` and `expected_current_sha` as full
lowercase 40-character SHAs, a non-secret single-line reason, and explicitly acknowledge
`compatibility_reviewed`. The expected SHA is
a compare-and-swap bound: except for a same-target safe retry, the host requires it to equal
the actual incumbent and requires the target to be a strict ancestor. The acknowledgement
means the operator reviewed application and retained-data compatibility. It does **not**
restore a database or other shared data, pin the instance at that revision, suppress the next
green forward deployment, promote production, update a fleet, or authorize native-owner
restart.

The host enforces this ordering for both new and older workflow callers under its existing
deployment lock, before build or live mutation. Newly retained images carry an application
provenance marker and their full Git revision as OCI metadata. Legacy images without the marker
are accepted only when their clean canonical `MANIFOLD_BUILD` uniquely resolves to the retained
repository; inherited base-image OCI revisions are not application evidence. Missing, dirty, divergent or
ambiguous provenance holds the deployment. Updating the stable forced-command receiver from
reviewed source, serialized with the deployment lock, is a separate host-tool rollout and must
precede use of the rollback workflow; the tooling checkout remains stable rather than moving to
the target revision. This needs no SSH key/configuration or Nix change and is not an application
deployment.

Development is the GitHub Environment `development`, inert unless the repository variables
`DEV_DEPLOY_HOST`, `DEV_DEPLOY_USER` and `DEV_DEPLOY_URL` and the secret
`DEV_DEPLOY_SSH_KEY` exist, and it names no host or provider: the receiver is
`infra/previews/receiver.sh`. Shared development uses the ordinary application image with
`MANIFOLD_DEV_SPAWN_AGENT=0` and a required explicit
`MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID`. It retains the existing dev-hub Compose project,
networks, loopback port and named `/data` volume; replacement affects only the hub after
build/configuration validation, without terminal retirement/resume, recursive data ownership
changes or spoke rebuild/restart. The native execution-only profile remains separately declared
and supervised. Numbered previews retain their explicitly disposable development-image lifecycle.

After successful ordinary development `verify-live` with `maintenance_required=false`,
`deploy-dev.yml` dispatches dotfiles'
`update-preview-owner.yml` with `target=preview-owner` and `revision=<deployed SHA>`, using
`DOTFILES_DISPATCH_TOKEN`. The receiver updates only the preview-owner pin and must no-op
when that exact revision is already pinned; the operator's next apply or scheduled fleet
apply then carries the owner. The generic production `update-pins.yml` currently accepts
no target/revision inputs, so this is a deliberately separate receiver contract tracked by
[dotfiles #687](https://github.com/atyrode/dotfiles/issues/687). Until that receiver lands,
dispatch will report the missing workflow rather than accidentally bump production pins.
This pin follow-through is convenience, not survival: accepted additive-behind owner RPCs
continue serving while waiting for their normal apply.

**Previews** are an optional development tier: `preview.<domain>` shows integrated `main`,
`<N>.<domain>` serves PR N's last explicitly deployed SHA, and non-numeric `<name>.<domain>`
serves a live worktree on the preview host with hot reload. Numbered previews are on demand:
opening a PR or pushing does not provision or update one. First start full proof for the exact
head with `gh workflow run ci.yml --ref <PR-branch>` and wait for its successful completion; this
is not an ordinary PR-readiness requirement. Then dispatch the trusted default-branch
`.github/workflows/deploy-preview.yml` with `pr=N` and `action=deploy`. Request both again after a
push to update it. `action=stop` releases resources sooner, and closing the PR still tears it down
automatically. The exact CLI commands, run-watching steps and inspection/reporting guidance are in
`infra/previews/README.md` §Request, inspect and stop a PR preview.
With `MANIFOLD_PREVIEW_DOMAIN=<domain>` on production, integrated and numbered previews use the
production browser identity handoff (ADR 0027): public URLs carry no secret, production
credentials never enter preview code, and production capability restrictions are preserved.
Optional numbered-preview seeding accepts a full `/data` backup as sensitive input but projects
only folders, containers and scene documents into a vacuumed database. It copies no owner key,
principal, credential, grant, dial, signing key, plugin state or adjacent file; each preview
generates fresh local authority. `PREVIEW_DOMAIN` names the domain; setup, the exact seed allowlist,
live mode and the operator-only pre-authenticated fallback command are documented in
`infra/previews/README.md`. A self-hoster may skip this tier entirely.
Each numbered preview owns an independently named `pr-N` execution node aligned to its deployed
revision; integrated development keeps its separate server-only `dev-hub` and independently
supervised owner. Redeploying the same healthy SHA verifies node admission and disposable terminal
I/O without replacing it. A different revision or removal drains admission and proceeds only after
the node acknowledges no retained terminals. Otherwise the operation reports HOLD, reopens
admission and leaves the existing preview and work intact. Successful replacement requires that
exact node to reconnect and pass real terminal creation, output and cleanup; the machine roster
shows the latest admission refusal with a code-specific remedy when it cannot.

**A self-hoster replaces the `deploy-*.yml` files.** They are the operator's deployments,
gated on repository variables so a fork never runs them (ADR 0022). Yours consume the same
releases: `docker compose pull` a tag, or build a commit and stamp it as above. Preserve the same
boundary in replacement automation: record successful full proof for the exact revision and
pass the installed-bundle candidate gate before deploying it, then verify live parity and
automatically restore the previous revision on failure. Whatever you run, `/healthz` tells you what it is —
`curl -fsS https://<your-domain>/healthz` answers
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
