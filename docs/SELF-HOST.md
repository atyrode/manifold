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
docker compose exec manifold sh -c 'echo "$MANIFOLD_PUBLIC_URL/#key=$(cat /data/owner.key)"'
```

Open the printed URL in a browser. The `#key=` fragment is the owner bootstrap: it
never leaves the browser (fragments are not sent in requests) and the app moves it
to localStorage and scrubs the URL immediately.

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
- `agent.token` / `agent.pid` / `agent.lock` — respawn handles of the in-container agent.

Presence, cursor traffic, and terminal bytes are never persisted (by design).

## Backup

```sh
docker compose exec manifold tar cz -C / data > manifold-backup-$(date +%F).tgz
```

The archive contains the owner key — store it like a secret.

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

```sh
git pull && docker compose up -d --build
```

SQLite schema migrations run automatically on boot (`packages/server/src/db.ts`
MIGRATIONS); the volume carries the data across image rebuilds.

## The hub is also a machine

The container auto-spawns a terminal agent named `${MANIFOLD_MACHINE_NAME}`
(default `hub`). Its shells run **inside the container** — the toolset is whatever
the image ships. For real shells on the host (or any other box), enroll that box
natively as a spoke per `docs/ENROLL.md`; do not mount the docker socket or host
paths into the hub container for this.

## Verify a deployment

From any checkout of this repo:

```sh
bun scripts/verify-public.ts https://<your-domain>
```

This drives a real browser through drawing, canvas persistence, an embedded
terminal on the `hub` machine, two viewers on one session, and anonymous denial.
