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

Numbered `up` uses `environment.sh` composition and an offline probe, requiring the
selected Buildx builder's `docker` driver. It builds `manifold-pr-pr-N:base`, then
composes `manifold-pr-pr-N:local` with the environment as its base. The application
artifact must contain an executable `/app/infra/entrypoint.sh` and a nonempty
`engines.bun` requirement that the environment's Bun satisfies. Its `/app` is copied
with UID/GID 1000 ownership; no Bun binary, libraries, home or Nix store are copied
out of the application image.

The current application requires Bun >= 1.4.2 for borrowed-descriptor ownership
([ADR 0032](../../docs/decisions/0032-bun-descriptor-ownership.md)). Updating the application
Dockerfile does not update the independently pinned disposable development runtime. Before
deploying numbered previews, the dotfiles environment owner must publish an environment with corrected
Bun and its reviewed immutable digest must replace `environment-image.txt`; do not substitute
an unverified digest or copy Bun from the application layer. Until that dependency is met,
an older environment is refused before the existing service is stopped. Host-side source
builds and live worktrees also require the corrected Bun; changing source pins does not
upgrade installed tools or authorize a service restart.

For numbered previews, both builds and an offline activation/application-import probe
complete before the existing service is stopped. The probe checks application ownership, `omp`/`code`
availability, the activated user/home, Bun compatibility and the real protocol import.
Invalid pins, incompatible runtimes and failed probes leave the running preview alone.
After preflight, deployment announces
that existing PTYs and their terminal entries are retired and the disposable home
is replaced. It closes machine admission through `core.machines.drain`, retires
those PTYs through `core.terminals.kill`, stops the service, changes only its
`/data` volume's ownership to UID/GID 1000, then starts the application as that
user and reopens admission. Ordinary canvas and identity data remain in `/data`;
the home and mutable Nix state survive stop/start but not container recreation.
A failure after retirement is a deployment failure, not a transactional rollback.

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

`deploy-dev.sh` builds the ordinary application directly as `<project>:local`, never the
shared `manifold:local` tag. It requires explicit `MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID`
and `MANIFOLD_DEV_SPAWN_AGENT=0`. Build and final Compose validation precede replacement.
Its **retained** lifecycle stops and updates only `manifold`, with `--no-deps`: no terminal
retire/resume, recursive ownership rewrite, spoke compilation, build-stamp writes or
supervisor restart. The existing named volume must already exist; missing data fails closed.
Before any retained stop, the **actual incumbent** must also prove server-only:
its existing container configuration explicitly disables local spawning, uses the
supported ordinary entrypoint without execution overrides or non-data mounts, and
a credential-free `/proc` probe finds only the PID1 hub and the stock read-only
healthcheck. Desired replacement settings never prove the old process tree safe.
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
It exercises root-to-developer migration, native terminal interaction and
reattachment, home recreation and non-disruptive preflight refusals. Pass `--integrated`
to exercise server-only retained replacement through the actual `deploy-dev.sh` with a unique
`manifold-dev-N` project, private checkout, loopback port and volume. It checks persisted
canvas/identity, unchanged nonstandard data ownership and network selection, no local owner,
and non-disruptive configuration refusals with the disposable pin/lifecycle helper absent.
It also creates an incumbent local owner with live PTYs, requests server-only replacement,
and requires refusal to preserve its process generation, identity and working terminals.
No existing development stack is selected. Only fixed host-service calls to Caddy/systemd
are shimmed. Run both modes before shipping composition changes:

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
credential configured; this cutover does not change the receiver or production credentials.

Write `$PREVIEW_HOME/env` before using the SSH receiver. It is literal `KEY=VALUE`,
without shell quoting, expansion or secrets; blank lines and `#` comments are allowed.
The CLI also reads this file; file values override inherited environment values.

- `PREVIEW_DOMAIN`: required base domain (without `preview.`).
- `PREVIEW_DEV_CHECKOUT`: existing dev checkout; default `$HOME/manifold-dev`.
- `PREVIEW_DEV_URL`: dev health URL; default `https://preview.<domain>`.
- `PREVIEW_DEV_PORT`: the dev stack's loopback port; default `7912`. The `plugin` verb installs
  through it.
- `PREVIEW_SEED`: optional absolute path to a `/data` backup `.tgz`; new PR volumes only. The
  production assertion signing key is always excluded so every preview generates its own.
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
The receiver accepts `dev <sha>`, `preview up 123 <sha>`, `preview down 123`,
`plugin <https-url> <sha256> [--hardened]`, or a bare `<sha>` (legacy dev deployment). Other commands are refused.

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
the POST handoff in ADR 0027. The ordinary public URL carries no credential. A fresh seeded
preview still accepts the development owner key as break-glass; `url 123` prints its pre-auth
`/#key=…` URL **only in the operator's local terminal**, and automated deployment never announces
it. Live keys stay in `$PREVIEW_HOME/live/<name>/data/owner.key`; journals contain no pre-auth URL.
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
which is stopped before the owner can exit. Hook lists are checked through typed
`busctl` replies: an empty-looking `systemctl` rendering is not proof of no commands.
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

These default fixtures substitute supervisor metadata and explicitly bypass kernel
transport-role proof; they cannot establish real systemd drop-in reload semantics.
The opt-in kernel fixture builds inert public C code into a root-owned immutable Nix
output and runs UUID-named, time-limited user services. It exercises the unmodified
production `/proc`/cgroup proof against a valid transport, a byte-identical copy outside
the store, an owner-mode argument, different executable bytes, and a hidden child process. It needs Linux cgroup v2,
a functioning user systemd manager and Nix access to this flake's pinned dependencies:

```sh
MANIFOLD_RETIREMENT_SYSTEMD_FIXTURE=1 bun test packages/agent/test/retire-spoke-systemd.test.ts
```

Before activation, a disposable real user-manager handoff fixture must additionally
exercise `Restart=always` with zero restart delay, `RestartForceExitStatus`, owner and
transport stop propagation/hooks, a mismatched owner PID, ignored/overridden drop-ins,
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
