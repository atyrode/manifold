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

Numbered previews and integrated `main` compose their application artifact with the standalone
portable development environment published by dotfiles. The one environment pin
is `infra/previews/environment-image.txt` in the stable tooling checkout; it must
be an immutable, anonymously pullable OCI digest. Updating it is a reviewed code
change, not a startup installation or a registry login on the preview host.

The environment provides the configured zsh, OMP, Code and the portable profile's
other tools. It does not provide provider credentials or a model service.
Production continues using the ordinary application image; no preview operation promotes
an image, edits a host service or replaces a spoke terminal host.

`up` and `deploy-dev.sh` use the same `environment.sh` composition, offline probe and
terminal replacement path and require the selected Buildx builder's `docker` driver.
Numbered previews build the application as `manifold-pr-pr-N:base`, then compose
`manifold-pr-pr-N:local` with the environment as its base. Integrated development uses
its existing Compose project (`manifold-dev`) and project-local `:base`/`:local` tags,
never the shared `manifold:local` tag. The application artifact must contain an executable
`/app/infra/entrypoint.sh` and a nonempty `engines.bun` requirement that the environment's
Bun satisfies. Its `/app` is copied with UID/GID 1000 ownership; no Bun binary,
libraries, home or Nix store are copied out of the application image.

The current application requires Bun >= 1.4.2 for borrowed-descriptor ownership
([ADR 0032](../../docs/decisions/0032-bun-descriptor-ownership.md)). Updating the application
Dockerfile does not update the independently pinned development runtime. Before deploying
this cutover, the dotfiles environment owner must publish an environment with the corrected
Bun and its reviewed immutable digest must replace `environment-image.txt`; do not substitute
an unverified digest or copy Bun from the application layer. Until that dependency is met,
an older environment is refused before the existing service is stopped. Host-side source
builds and live worktrees also require the corrected Bun; changing source pins does not
upgrade installed tools or authorize a service restart.

Both builds and an offline activation/application-import probe complete before
the existing service is stopped. The probe checks application ownership, `omp`/`code`
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

`down` and `url` do not need the environment pin. Teardown removes the preview's
base and final tags, not the shared environment image. No global environment
cache pruning is performed.

The independent CI job runs `bun scripts/verify-preview-environment.ts` with a
private local deployment fixture, real Docker/Compose, SDK clients and Chromium.
It exercises root-to-developer migration, native terminal interaction and
reattachment, home recreation and non-disruptive preflight refusals. Pass `--integrated`
to exercise the actual `deploy-dev.sh` path with a unique `manifold-dev-N` project,
private checkout, loopback port and volume; no existing development stack is selected.
Both modes use real Docker, image activation, protocol probes and lifecycle actions.
Only the fixture's fixed host-service calls to Caddy and systemd are shimmed; the optional
external spoke is not configured. Run both modes before shipping composition changes:

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
- `MANIFOLD_DEV_SPOKE_UNIT`: optional user unit; unset skips the dev spoke rebuild.
- `MANIFOLD_DEV_SPOKE_BINARY`: default `$HOME/.local/share/manifold-dev-agent/manifold-agent`.
- `MANIFOLD_DEV_SPOKE_ENV`: build stamp file; default `$HOME/.config/manifold/dev/agent.env`.

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
`dev <sha>` replaces only its `manifold` service through the shared development-image path.
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

### Development spoke build skew

The optional `MANIFOLD_DEV_SPOKE_UNIT` restart updates only the network transport.
Its successful `welcome` is not evidence that the separately supervised terminal host
adopted the new build. Transport replacement intentionally preserves the old host and
all of its PTYs, so host-side features (including terminal mode snapshot tracking) can
remain on an older build even while the hub and transport report the new revision.
The deployment prints that distinction explicitly; use `dev-hub` for terminals in the
newly composed environment. Host `dev-01` terminals are a different machine and do not
inherit the container's tools or host build.

On 2026-09-07, read-only inspection found development transport `0.14.0` paired with
terminal host `0.7.0+9.g494973f` (an old deleted executable); its two live terminals
prevent an empty-host upgrade. This is a deployment hold, not permission to kill them.
The host service definitions and restart policy are owned by dotfiles, not this tooling.

Safe host maintenance is a separate bounded operation: update the host binary without
signalling the current process, close admission with `core.machines.drain`, then use the
local terminal-host `status_request` to inspect the retained inventory. Wait only to a
declared deadline for workloads to finish normally. Request `shutdown_request` through
that same local protocol; only its atomic `shutting_down` acceptance proves draining and
zero retained terminals. `shutdown_refused` (including exited-but-retained terminals),
timeout or an unreachable host is a visible hold: restore admission if abandoning the
maintenance attempt, report the remaining terminal IDs, and do not escalate to a signal.
After an accepted shutdown, the dotfiles-owned supervisor can start the updated host;
confirm its new build and transport attachment before reopening admission.
Do not use `systemctl restart` on an occupied terminal-host unit, cgroup teardown or
container recreation as a shortcut. Integrated `dev-hub` replacement is separately
announced and explicitly retires only that container machine's terminals.

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
