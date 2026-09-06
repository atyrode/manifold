# Self-hosting manifold

One `docker compose up -d --build` turns any box with a DNS record into a manifold
master node: the hub serving HTTP, both WebSocket endpoints, and the canonical scene
store — and a regular terminal-serving machine at the same time.

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
- Interactively minted credentials expire. The bearer token a browser bootstrap
  receives carries a **14 day** default expiry and is refused past it as `expired`
  — a socket close reason and an HTTP `forbidden` — after which the browser
  re-bootstraps from the owner key. Machine tokens (`docs/ENROLL.md`) are exempt
  and never expire: an agent's credential is long-lived by design.

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
`<N>.<domain>` follows PR N's head on every push, and non-numeric `<name>.<domain>` serves a live
worktree on the preview host with hot reload. `.github/workflows/deploy-preview.yml` deploys
same-repository PRs and tears them down on close. With
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
