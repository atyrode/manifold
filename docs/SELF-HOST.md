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

## Already running a reverse proxy on this box?

Skip the bundled caddy: publish manifold on loopback and keep your existing proxy
as the TLS front (Caddy v2 forwards WebSocket upgrades natively):

```sh
docker compose -f compose.yaml -f infra/compose.hostproxy.yaml up -d --build manifold
```

Point your proxy's vhost at `127.0.0.1:7777` (Caddy block:
`infra/manifold.tyrode.dev.Caddyfile`). `MANIFOLD_DOMAIN` in `.env` must still be
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
