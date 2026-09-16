# Preview environments

| Address            | Runs                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `preview.<domain>` | Integrated `main` (existing dev stack on port 7912)                    |
| `<N>.<domain>`     | PR N's last explicitly deployed SHA in `manifold-pr-N`; machine `pr-N` |
| `<name>.<domain>`  | Live host worktree: Vite HMR and Bun watch                             |

Requirements: Bash, Bun, Docker Compose, Caddy, curl, jq, flock, Git and systemd
user services. Enable linger for the deployment user. Keep this tooling in a stable
checkout outside disposable preview checkouts. One hub uses approximately 140 MiB.
The registry (`name kind port` per line) and data live under `PREVIEW_HOME`, default
`$HOME/manifold-previews`. Only this user may write it; lifecycle operations serialize.
The router, live user units and daily gc timer are generated, enabled at boot, and survive logout.
Numbered previews are on demand: opening a PR or pushing never provisions or updates one.
An explicit deploy request is the decision; there is no docs-only deployment heuristic.
Integrated `main` still deploys automatically after green CI; production remains separate.

Numbered previews build with the title `pr-N - manifold` and a teal favicon (`#0f766e`),
distinct from production and the integrated preview. Both use the existing shell-identity
build inputs; the PR number comes from the deployment's `PREVIEW_MACHINE`.

## Development environment

Numbered disposable previews compose their application artifact with the standalone
portable development environment published by dotfiles. The one environment pin
is `infra/previews/environment-image.txt` in the stable tooling checkout; it must
be an immutable, anonymously pullable OCI digest. Updating it is a reviewed code
change, not a startup installation or a registry login on the preview host.

The environment provides the configured zsh, OMP, Code and the portable profile's
other tools. It does not provide provider credentials or a model service.
Shared integrated development instead uses the ordinary production-style application
image as a server-only hub. Its execution owner is the separately declared native profile;
there is no shared-preview container-shell fallback. Neither deployment path promotes production.

Numbered `up` treats the selected PR revision as source, not deployment authority. Stable tooling
derives identity with its own `scripts/build-identity.ts`, validates the three emitted values as
inert metadata, materializes an exact Git archive, and builds it with the stable checkout's root
`Dockerfile`. It then runs only the complete `compose.preview.yaml` topology from that stable
checkout. A PR's `compose.yaml`, `Dockerfile`, and `scripts/build-identity.ts` are never executed
or merged on the host; they cannot add services, privileged settings, bind mounts, or host-side
code. The deployment log receipts both stable substitutions. PR dependencies and source still run
inside the credential-free application build and resulting preview container, which is the
intended preview boundary.

`environment.sh` requires the selected Buildx builder's `docker` driver. It builds
`manifold-pr-pr-N:base`, then composes `manifold-pr-pr-N:local` with the environment as its base.
The application artifact must contain an executable `/app/infra/entrypoint.sh` and a nonempty
`engines.bun` requirement that the environment's Bun satisfies. Its `/app` is copied with UID/GID
1000 ownership; no Bun binary, libraries, home or Nix store are copied out of the application
image.

The current application requires Bun >= 1.4.2 for borrowed-descriptor ownership
([ADR 0032](../../docs/decisions/0032-bun-descriptor-ownership.md)). Updating a PR's application
Dockerfile does not update either stable build recipe or the independently pinned disposable
development runtime. Update the trusted Dockerfile and environment pin through the reviewed stable
tooling checkout instead. Before
deploying numbered previews, the dotfiles environment owner must publish an environment with corrected
Bun and its reviewed immutable digest must replace `environment-image.txt`; do not substitute
an unverified digest or copy Bun from the application layer. Until that dependency is met,
an older environment is refused before the existing service is stopped. Host-side source
builds and live worktrees also require the corrected Bun; changing source pins does not
upgrade installed tools or authorize a service restart.

For numbered previews, both builds and an offline activation/application-import probe
complete before the existing service is touched. The probe checks application ownership,
`omp`/`code` availability, the activated user/home, Bun compatibility and the real protocol
import. Invalid pins, incompatible runtimes and failed probes leave the running preview alone.
A healthy request for the exact revision already running is a no-op: stable tooling verifies
the named `pr-N` node plus disposable real terminal creation, command output and cleanup without
building or replacing the container.

A revision change or removal first closes terminal admission through `core.machines.drain`. Any
retained terminal produces an actionable HOLD, admission is reopened, and the existing container
and work remain untouched; automation never kills terminals to make either operation pass. An
empty acknowledged inventory may proceed to replacement or removal. Replacement success requires
the named node to reconnect; a failure reports its durable `lastRefusal` code/time. Once online,
verification reopens admission and exercises the same real terminal I/O probe. Ordinary canvas and
identity data remain in `/data`; the home and mutable Nix state survive stop/start but not an
explicitly empty container recreation.

Integrated deployment resolves the existing checkout's `.env` and Compose overlays to a
private temporary configuration, then appends the stable `compose.development.yaml`.
It preserves the project, network, `dev-hub` machine identity and named `/data` volume.
Before any live mutation it refuses a project outside `manifold-dev`/`manifold-dev-*`,
a machine other than `dev-hub`, a non-preview public URL, a missing configured loopback
port or a data volume other than `<project>_manifold-data`. This is deliberately not a
generic migration command for arbitrary stacks or external/shared volumes. The existing
identity files and ordinary canvas data stay in the same volume; no production data is
seeded into integrated development. The resolved configuration is mode-private and removed
on exit, never printed. Existing host proxy configuration remains operator-owned.

`deploy-dev.sh` builds the ordinary application as `<project>:candidate`, never the shared
`manifold:local` tag. After ordering is accepted, `<project>:local` first pins the actual incumbent
image, then is promoted to the new image only after healthy activation. These two bounded references
preserve immutable image metadata across refused builds and failed activations, including on
containerd image stores; neither tag is deployment-order evidence. It requires explicit
`MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID` and `MANIFOLD_DEV_SPAWN_AGENT=0`.
Build and final Compose validation precede replacement.
The final merge is frozen once in a private memory-backed directory (0700, files 0600)
and the built image is sealed by content ID before incumbent mutation. Preflight and
creation consume that same configuration, not newly resolved local overrides.
The image is built from that revision's Git archive, not untracked checkout files.
Every newly retained development image is stamped with the application marker
`io.manifold.deployment.provenance=git-v1` and
`org.opencontainers.image.revision=<full-commit-sha>`. Under the existing `dev.lock`, before
any build or live mutation, deployment reads the actual incumbent image's immutable provenance
and resolves the requested revision unambiguously. Ordinary `dev <sha>` permits retrying the same
revision and otherwise requires the incumbent to be an ancestor of the target. Moving backward
is available only as
`dev-rollback <expected-current-full-sha> <target-full-sha>`: both values are lowercase
40-character SHAs; the same-target case is a safe retry, while an actual move requires the
expected value to equal the incumbent and the target to be its strict ancestor. A missing,
dirty, divergent or ambiguous identity refuses without building or replacing anything.

The marked application revision is authoritative for newly built images. During migration,
an incumbent without that marker may resolve through its canonical `MANIFOLD_BUILD`: either
an exact immutable release tag or the clean `<version>+<distance>.g<sha>` development form.
Unmarked OCI revision labels may belong to the base image and are never application evidence.
The result must identify one full commit and agree with the retained repository; dirty,
malformed and non-unique legacy identities fail closed. This compatibility path is not a
second deployment state file and becomes unused as marked images replace legacy ones.
Alternate build contexts, recipes and undeclared build inputs are refused before build.
Image defaults and effective Compose command, entrypoint, workdir, PID namespace,
loader environment, healthcheck and execution hooks must have the ordinary server-only
shape. A configured `MANIFOLD_OWNER_KEY` is refused: only the retained `/data/owner.key`
may supply owner authority, without credential comparison, export or injection.
Its **retained** lifecycle stops and updates only `manifold`, with `--no-deps`: no terminal
retire/resume, recursive ownership rewrite, spoke compilation, build-stamp writes or
supervisor restart. The existing named volume must already exist; missing data fails closed.
Before any retained stop, the **actual incumbent** must also prove server-only:
its existing container configuration explicitly disables local spawning, uses the
supported ordinary entrypoint without execution overrides or non-data mounts, and
a credential-free `/proc` probe finds no live processes beyond the PID1 hub, the stock read-only
healthcheck and installed server-plugin isolates matching the hub loader's complete
direct-child command, bundle path, process identity, control descriptor and minimal
environment fingerprint. Those isolates are supervised parts of the hub: they stop
with it, reload from their pinned bundles after replacement and own no native execution.
An already terminated, single-threaded kernel zombie is non-owning only after two observations
confirm state `Z`, one thread and the same starttime. A zombie group leader with surviving
threads, an unreadable identity or a reused PID still holds; an absent executable alone
is not evidence of death.
Desired replacement settings never prove the old process tree safe.
A stopped failed candidate still counts as the incumbent for ordering. Replacement retains the
existing running-process safety requirement: explicit recovery of that same retained container
may be needed before retry or rollback. Ordering approval never bypasses this hold or grants
native-owner restart authority.
Its actual named volume, machine identity and selected networks must match the final
Compose merge; both generations must mount the volume's actual backing root and use
`/data` as the effective application data directory. Volume subpaths are unsupported;
an unused `/data` mount or a matching volume name alone is not persistence proof.
Absent or mismatched incumbents hold without creating a replacement identity.
An old default-spawning container, an in-container owner, custom wrappers (including
Litestream), or unknown process/configuration shapes cause HOLD without stopping it.
Resolve old execution ownership separately; preserved `/data` cannot preserve PTYs
inside a stopped container.
The resolved Compose configuration stays in a private `/dev/shm` directory and is removed
on exit, not persisted or printed. The environment digest is irrelevant to this hub path.

`down` and `url` do not need the environment pin. Teardown removes the preview's
base and final tags, not the shared environment image. No global environment
cache pruning is performed.

The independent CI job runs `bun scripts/verify-preview-environment.ts` with a
private local deployment fixture, real Docker/Compose, SDK clients and Chromium.
Plain mode proves the allowlisted seed and fresh authority boundary, independent `pr-N` node
identity, occupied-owner replacement refusal without disruption, explicit empty replacement,
same-SHA no-op with retained terminal I/O, node admission plus disposable terminal cleanup,
actionable refusal text in the real roster, and two real browsers observing one terminal.
It also exercises root-to-developer migration, native terminal interaction and reattachment.
Pass `--integrated` to exercise server-only retained replacement through the actual
`deploy-dev.sh` with a unique `manifold-dev-N` project, private checkout, loopback port and volume.
It checks a real single-threaded zombie alongside a live server-plugin isolate, persisted
canvas/identity, unchanged nonstandard data ownership and network selection, no local owner, and
non-disruptive configuration refusals with the disposable pin/lifecycle helper absent.
Actual-incumbent volume, machine, network and writable-layer data-root mismatches, plus desired
base/final-overlay data-root, volume-subpath and network overrides, must leave the original
container generation, identity, data ownership and canvas state unchanged. The same guarantee
covers an actual incumbent mounted on a volume subpath. It also creates an incumbent local owner
with live PTYs, requests server-only replacement, and requires refusal to preserve its process
generation, identity and working terminals. No existing development stack is selected. Only fixed
host-service calls to Caddy/systemd are shimmed. Run both modes before shipping composition changes:

```sh
bun scripts/verify-preview-environment.ts
bun scripts/verify-preview-environment.ts --integrated
```

Add `--measure-storage` locally to build two distinct application bases and record
actual storage deltas. Screenshots and measurements are retained as CI evidence.

## Request, inspect and stop a PR preview

Opening a draft PR claims work, not compute. An agent MAY request a numbered preview when live
verification is useful or the operator should likely inspect the change, and MUST request one
when the operator explicitly asks to inspect a deployed PR preview. Do not request one for
ordinary docs/internal-only changes with nothing useful to inspect. Source checkpoint, CI and
merge rules still apply; pushing is not a deployment request.

A numbered preview is a shared, persistent deployment, not an exemption from full verification.
First obtain successful **full CI** for the exact current PR head. The fast `pull_request`
gate is never deployment evidence; dispatching `CI` on the PR's branch runs the full suite
without granting that branch deployment credentials. Resolve `BRANCH` and `SHA` from
`gh pr view NUMBER --json headRefName,headRefOid`, then:

```sh
gh workflow run ci.yml --repo atyrode/manifold --ref BRANCH
gh run list --repo atyrode/manifold --workflow ci.yml --event workflow_dispatch --branch BRANCH --commit SHA --limit 10
gh run view FULL_RUN_ID --repo atyrode/manifold
```

Inspect the matching run until its full `gate` succeeds; a later push needs new exact-head
proof. Only then request deployment below. Missing, failed, incomplete or mismatched evidence
is refused before SSH. This branch proof authorizes neither integrated-main deployment nor
release, which require their own full main evidence. Stopping a preview never waits for CI.

From an authenticated GitHub CLI with permission to run this repository's workflow, replace
`NUMBER` with a positive canonical PR number (for example `123`, never `0123`):

```sh
gh workflow run deploy-preview.yml --repo atyrode/manifold --ref main -f pr=NUMBER -f action=deploy
```

Only the trusted workflow on `main` deploys, and only an open PR whose head belongs to this
repository. It resolves the exact current head SHA through the GitHub API; no local checkout
or SHA argument is needed. Each request is one-shot: the preview stays on the last successfully
deployed SHA after subsequent pushes. Run the same command again to deploy the new head.

Find the run matching your PR, action and request time; do not blindly watch another user's
latest request. Replace `RUN_ID` with that run's ID:

```sh
gh run list --repo atyrode/manifold --workflow deploy-preview.yml --event workflow_dispatch --branch main --limit 10
gh run watch RUN_ID --repo atyrode/manifold --exit-status
gh run view RUN_ID --repo atyrode/manifold --web
```

If dispatch prints a run URL, use it to identify the run directly. `gh run watch` does not
support fine-grained PAT authentication; in that case, use `gh run view ... --web` and watch
the run in the browser instead.

The successful run summary and PR comment record the exact deployed SHA and ordinary
`https://<N>.<domain>` URL. Open that URL through the normal production browser identity
handoff described below, then exercise the changed panel/action and check its expected result.
A successful deployment alone is not runtime verification. Report the SHA, ordinary URL,
specific action and expected result when handing the preview to the operator, and distinguish
what you actually verified from what remains to inspect. Never report credentials or a
key-bearing URL; never imply that a later, undeployed push is visible.

Release resources before closing the PR with:

```sh
gh workflow run deploy-preview.yml --repo atyrode/manifold --ref main -f pr=NUMBER -f action=stop
```

Watch the stop run with the same commands; its result marks the preview stopped. Stop removes
the preview's data as well as its compute. A later deploy request can recreate it while the PR
is open. Closing or merging the PR still triggers automatic teardown, including when a deploy
request was queued; closing is not a reason to leave a preview running.

The GitHub UI offers the same controls: repository **Actions** → `deploy-preview.yml` →
**Run workflow**, choose branch `main`, enter `pr`, and choose `action` (`deploy` or `stop`).
Open the resulting run to watch it and read its summary. Neither this UI nor the numbered
preview workflow changes integrated-main automation or authorizes production deployment.

## Configuration

In GitHub, keep the `preview` environment's deployment branch policy restricted to the
branch `main` (not tags). Both manual requests and closed-PR cleanup use the trusted
default-branch workflow; no PR checkout runs on its credential-bearing runner. This
environment rule is defense in depth, not isolation from maintainers who can edit workflows
or repository-level secrets. Keep the existing deployment variables and forced-command SSH
credential configured; updating receiver code does not change its SSH configuration or production credentials.

Write `$PREVIEW_HOME/env` before using the SSH receiver. It is literal `KEY=VALUE`,
without shell quoting, expansion or secrets; blank lines and `#` comments are allowed.
The CLI also reads this file; file values override inherited environment values.

- `PREVIEW_DOMAIN`: required base domain (without `preview.`).
- `PREVIEW_DEV_CHECKOUT`: stable deployment tooling/configuration checkout; default
  `$HOME/manifold-dev`. It is not moved to the requested application revision.
- `PREVIEW_DEV_URL`: dev health URL; default `https://preview.<domain>`.
- `PREVIEW_DEV_PORT`: the dev stack's loopback port; default `7912`. The `plugin` verb installs
  through it.
- `PREVIEW_SEED`: optional absolute path to a full `/data` backup `.tgz`; new PR volumes only.
  Stable tooling reads only its canonical `data/manifold.db{,-wal,-shm}` members and projects
  the explicit representative allowlist: `container_folders(id,name,created_at,parent_folder_id,sort_order)`,
  `containers(id,name,created_at,sort_order,folder_id,discipline)` and
  `scene_docs(container_id,epoch,rev,ts,hash,doc)`. Every other table starts empty and no
  adjacent file crosses. The sanitized database is vacuumed before it enters the volume;
  startup generates fresh owner, preview-signing and machine authority for that preview.
- `PREVIEW_PORT_RANGE`: default `7920-7999`; live servers use routed port + 1000.
- `PREVIEW_ROUTER_PORT`: default `7900`; change the public proxy and ask URL to match.
- `MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID`: required opaque enrolled native service-owner ID
  for shared development; never a machine-name lookup or automatic fallback.
- `MANIFOLD_DEV_SPAWN_AGENT`: required literal `0`. The [native execution-only
  profile](../../docs/SELF-HOST.md#explicit-remote-execution) owns execution; the hub cannot substitute.

The native profile's owner and transport are activated from their pinned declaration, not
rebuilt from the preview checkout. Remove obsolete `MANIFOLD_DEV_SPOKE_*` entries from the
public configuration; they are no longer accepted. Before native startup, explicitly retire
the old owner using the operation below. Native activation must fail closed while either
declared old user supervisor is active, enabled/restartable, or its user-manager state
cannot be proved. Activation is not permission to stop or mask those supervisors.

Production browser identity is the normal preview admission path. Set
`MANIFOLD_PREVIEW_DOMAIN=<domain>` on the production manifold instance whose public URL is
`https://<domain>`; the preview tooling automatically gives integrated and numbered preview
processes `MANIFOLD_IDENTITY_AUTHORITY=https://<domain>`. Production issues only for those hosts;
a live worktree keeps its own key and does not advertise the production authority. No production
owner key, bearer, signing private key or per-preview secret belongs on the preview host.

Rollout has two independent inputs: deploy the issuer support and namespace configuration on
production, then update the stable tooling checkout used by the SSH receiver before redeploying
previews. `compose.preview.yaml` is loaded from that stable checkout, not from the PR being
built. A successful app build does not prove admission is configured: check each preview's
`GET /api/identity/preview-config` names the production origin, then exercise the browser
handoff through its ordinary public URL.

Set `PREVIEW_HOME` in the invoking environment, not inside its own env file. The dev
checkout keeps its existing Compose project, data and host-proxy configuration;
`dev <sha>` replaces only its `manifold` service through the retained server-only application path.

The forced-command receiver and deployment scripts come from the stable tooling checkout,
not the requested application revision. Roll out ordering support by updating that stable
checkout from reviewed source, serialized with `dev.lock`, before using the rollback workflow;
this is a host-tool installation, not an application deployment. Existing automatic
`dev <sha>` callers also pass through the same installed host guard, so an older queued
workflow cannot move the instance backward. No SSH key/configuration or Nix change is needed.
This rollout does not deploy an application, restart the separately owned native profile,
or change production or fleet pins.
Create `preview` and `*` DNS A records pointing to the host's public address.
In the operator-owned public Caddy configuration **outside this repository**, substitute
`<domain>` and add the global option to your existing global block:

```caddyfile
{
  on_demand_tls {
    ask http://127.0.0.1:7900/__preview/ask
  }
}
preview.<domain> {
  reverse_proxy 127.0.0.1:7912
}
*.<domain> {
  tls { on_demand }
  reverse_proxy 127.0.0.1:7900
}
```

With `on_demand`, Caddy issues a certificate for each requested hostname at handshake time
(HTTP validation), never a wildcard certificate, so no DNS plugin or zone credential is
needed; the ask endpoint permits only `preview.<domain>` and registered names. Prefer the
`*.<domain>` site address over a catch-all `https://` on a host that fronts other sites.
Forced-command `authorized_keys` entry (use absolute paths; no forwarding or PTY):

```text
restrict,command="env PREVIEW_HOME=/path/to/previews /path/to/repo/infra/previews/receiver.sh" ssh-ed25519 <public-key>
```

## Operations

Run `infra/previews/preview.sh` with: `router`; `up 123 <sha>`; `down 123`; `ls`;
`url 123`; `live feature /path/to/worktree`; `url feature`; `unlive feature`; `gc`; `gc-timer`;
`plugin <https-url> <sha256> [--hardened]`.
`up` reuses the port and data on redeploy, waits for the exact build, then prints its URL.
`down` destroys the container, volume, checkout and per-PR image (including an image whose
checkout is already gone). An absent image is a no-op; `unlive` retains live data.
`gc` removes PRs reported CLOSED or MERGED by `gh pr view`; without `gh` it is a no-op.
The receiver accepts `dev <sha>`, `dev-rollback <expected-current-full-sha> <target-full-sha>`,
`preview up 123 <sha>`, `preview down 123`, `plugin <https-url> <sha256> [--hardened]`, or a bare
`<sha>` (legacy dev deployment). Other commands are refused.

`plugin <url> <sha256>` installs a published plugin bundle on the integrated preview: it runs
`packages/plugin-kit/src/install.ts` from this stable checkout against `http://127.0.0.1:$PREVIEW_DEV_PORT`
with `--deliver docker:<container>`, the container being the dev checkout's compose service
`manifold`; the owner key is read out of that container's `/data/owner.key` and never leaves the
host. An author repository's release workflow calls it once per bundle, parents first, over the
same forced-command key (`docs/PLUGINS.md` §9 Delivering). The stable checkout needs
`bun install --frozen-lockfile` once, like a live worktree. Production is never a receiver verb:
the operator installs there from the release URL in the plugin manager, by hand.
The three-word `plugin <url> <sha256>` form keeps the installer's in-realm default.
Append the exact fourth word `--hardened` to explicitly select its existing hardened runner;
the bundle must already target that runner. Both the receiver and direct CLI reject unknown
options and extra arguments before invoking the installer. The receiver does not infer the
runner from the URL, manifest or hash.

Integrated and numbered previews normally admit an existing production browser identity through
the POST handoff in ADR 0027. The ordinary public URL carries no credential. A seeded numbered
preview receives only the representative database projection above and generates fresh authority:
the development owner key and reusable development credentials cannot open it. `url 123` prints
that preview's own pre-auth `/#key=…` URL **only in the operator's local terminal**, and automated
deployment never announces it. Live keys stay in `$PREVIEW_HOME/live/<name>/data/owner.key`;
journals contain no pre-auth URL.
Observe live processes with `journalctl --user -u manifold-live-feature` and restart
with `systemctl --user restart manifold-live-feature`. Install worktree dependencies
with `bun install --frozen-lockfile` before `live`; source changes update without redeploy.

### Retire an old development spoke before native activation

Run this source-managed operation **only with separate operator authorization**, from the
stable reviewed checkout with dependencies already installed. It is not a `dev` receiver verb.
Run as the user owning the two old user services, with the existing hub container accessible,
a private mode-0700 runtime directory, and Bun, Docker, jq, flock and systemctl available:

```sh
bash infra/previews/retire-spoke.sh \
  --container "$DEV_HUB_CONTAINER" \
  --machine-id "$OLD_MACHINE_ID" \
  --terminal-host-id "$OLD_TERMINAL_HOST_ID" \
  --terminal-host-unit "$OLD_TERMINAL_HOST_UNIT" \
  --transport-unit "$OLD_TRANSPORT_UNIT" \
  --transport-package "$REVIEWED_OLD_TRANSPORT_PACKAGE" \
  --socket "$OLD_TERMINAL_HOST_SOCKET" \
  --runtime-dir "$XDG_RUNTIME_DIR"
```

All arguments are explicit **public references**, not credentials or discovered names.
Review the machine and live terminal-host identities, the exact `.service` units and the
absolute socket before invoking it. The container must be the existing owning dev hub;
its admission endpoint is `http://127.0.0.1:7777` and key reference `/data/owner.key`.
The transport package is a **separately approved provenance reference**, never a value
automatically trusted from the live process or its reported build. Review the exact
Nix output's source and compiled entrypoint: the supported flake installs compiled
`packages/agent/src/main.ts` at `/nix/store/HASH-manifold-agent-VERSION/libexec/manifold-agent`
with its launcher in `bin/manifold-agent`. That reviewed source must implement the
split non-owning default mode. The helper compares the kernel executable bytes with
that immutable root-owned artifact. A retained compiled binary outside the store is
accepted only when it matches this independently reviewed reference byte-for-byte.
It permits only the single executable argument and requires the transport cgroup to
contain exactly that PID and no child cgroups. A bare Bun executable plus mutable
repository entrypoint, missing provenance,
or any owner-mode argument is **unknown and refused**. Legacy owner IPC alone cannot
establish a transport's role; do not infer it from a different PID, cgroup or owner revision.
Both units must have no external stop propagation, activation edges, exit actions or stop
hooks. The owner's sole permitted stop-dependent is its proved non-owning transport,
which is stopped before the owner can exit. Both units and their direct pinning
dependencies must have `StopWhenUnneeded=no`; otherwise stopping one can implicitly
terminate its owner or unrelated work. Hook lists are checked through typed `busctl`
replies: an empty-looking `systemctl` rendering is not proof of no commands.
The transport requires `KillMode=control-group` or `mixed` and `SendSIGKILL=yes`.
Distinct PID/cgroup alone is insufficient.
Both old services must initially be proved running; uncertain or already-partially-retired state is a manual hold.
Do not concurrently change/activate unit definitions, start replacement owners or reopen admission.

The helper bundles **only public maintenance CLI source** in the private runtime directory
and streams it into the existing container. This also supports containers predating
`--maintenance`, without invoking an old main entrypoint that could ignore the flag.
Only that container reads its owner key. No key/token is exported, logged or copied;
neither the retained executable nor any credential/data file is rewritten.

It closes machine admission using the merged `manifold-agent --maintenance` implementation.
Busy terminal inventory, unavailable/unknown work, or an identity mismatch holds without
stopping an owner. An empty terminal list is not job-idle proof. After drain confirms the
named host, it stops only the non-owning transport, then uses the local observer socket for
the named owner's atomic drained-and-empty shutdown. Jobs/services and retained terminal
entries must finish or be resolved through their governed controls; this command never
kills, cancels, force-retires, retries or escalates them.

Maintenance shutdown passes the expected systemd MainPID and checks it against status
on the **same observer connection** before requesting shutdown. Before transport stop,
the helper temporarily inhibits automatic restarts for both exact supervisors through
uniquely owned runtime drop-ins, then checks actual `DropInPaths`, `Restart=no`, empty
`RestartForceExitStatus` and unchanged process/invocation identities. This does not stop,
restart, mask or replace an owner. Overrides are removed only when their inode/content
still belongs to this operation; original effective restart policies are checked on restoration.
After transport stop, the original PID must be absent and its original cgroup absent
or positively unpopulated, including descendants. Manager `MainPID=0` alone never
authorizes the owner's shutdown or starting a recovery transport.

Only the exact successful `shutting_down` identity acknowledgement permits disabling
the old supervisors. The helper **never sends a unit-name stop to the owner**, even
after acknowledgement: it waits for that proved process to exit itself and refuses
a new/unproved generation. Actual loaded/inactive/dead, PID-zero, disabled state is
checked afterward; successful disable alone is insufficient. Restart policies are
restored on success and refusal. A refusal attempts to restore the previously running
transport but **leaves admission closed**. Failed restoration, recovery or final proof
is a visible hold, never permission to activate native execution.

The helper never invokes Nix, activates a native profile, deploys a hub/production, changes
credentials, or reopens admission. Only a proved empty shutdown and stopped/disabled old
supervisors permit the separate native-owner startup. Preserve identity, journals and data;
review the source-owned native declaration and its fail-closed old-unit guard before activation.
Hub deployment itself uses the retained path and does not perform this retirement.

Offline lifecycle regression scenarios (fixture credentials, loopback/Unix protocol peers and
a stateful supervisor boundary; no real user manager) are:

```sh
bun test packages/agent/test/retire-spoke.test.ts packages/agent/src/maintenance.test.ts
```

These default fixtures substitute supervisor metadata and model kernel role/exit
evidence; they cannot establish real systemd drop-in reload semantics.
The opt-in kernel fixture builds inert public C code into a root-owned immutable Nix
output and runs UUID-named, time-limited user services. It exercises the unmodified
production `/proc`/cgroup proof against a valid transport, a byte-identical copy outside
the store, an owner-mode argument, different executable bytes, and a hidden child process.
It also proves that `KillMode=none` can leave a live process behind manager PID-zero
state and must be refused. It needs Linux cgroup v2, a functioning user systemd manager
and Nix access to this flake's pinned dependencies:

```sh
MANIFOLD_RETIREMENT_SYSTEMD_FIXTURE=1 bun test packages/agent/test/retire-spoke-systemd.test.ts
```

Before activation, a disposable real user-manager handoff fixture must additionally
exercise `Restart=always` with zero restart delay, `RestartForceExitStatus`, owner and
transport stop propagation/hooks, automatic teardown of an owner or direct dependency,
a surviving `KillMode=none` transport, a mismatched owner PID, ignored/overridden drop-ins,
policy restoration on refusal, and an unexpected replacement generation. The kernel
fixture does not exercise that maintenance/restart handshake. No fixture result may
be inferred from source review, and its inert test artifact is not provenance for an
incumbent Manifold transport.

## Disk / gc

Run `infra/previews/preview.sh gc-timer` from the stable tooling checkout to install and
enable `manifold-previews-gc.timer` immediately. Re-running the command updates the generated
user units idempotently. With user linger enabled, it runs `preview.sh gc` daily, including
a missed run after the host returns. It inherits the installation's `PATH` and `PREVIEW_HOME`
and reads `$PREVIEW_HOME/env` at each run; `gh` must be authenticated for the deployment user.
The installation also preserves `DOCKER_HOST` and `DOCKER_CONTEXT` when set, so a rootless
Docker daemon remains reachable without an interactive login shell.
Keep that checkout available for the service, just as for live units.

After closed-PR teardown, `gc` runs `docker builder prune --all --force --keep-storage 5G` and
`docker image prune --force`. The 5G constant in `common.sh` retains recent build layers
while bounding reclaimable build-cache growth; `--all` includes unused non-dangling cache.
Docker cannot prune layers still in use.
Only dangling images are pruned globally: tagged images for open PRs are never swept.
`down N` removes `manifold-pr-pr-N:base`, `manifold-pr-pr-N:local` and the older
`manifold-pr-N:local` tag, without forcing removal of an image used by another container.
Inspect disk use with `docker system df`, the schedule with
`systemctl --user list-timers manifold-previews-gc.timer`, and runs with
`journalctl --user -u manifold-previews-gc.service`. To run it immediately:
`systemctl --user start manifold-previews-gc.service`.
