#!/usr/bin/env bash
# Hub entrypoint. Without MANIFOLD_REPLICA_BUCKET this is exactly `bun packages/server/src/main.ts`.
# With it, <data>/manifold.db is restored from the replica when the local file is absent and
# replicated continuously while the server runs (Litestream, infra/litestream.yml). One
# writer per replica: never run two instances against one bucket path.
set -euo pipefail
cd /app
if [ -z "${MANIFOLD_REPLICA_BUCKET:-}" ]; then
  exec bun packages/server/src/main.ts
fi
: "${MANIFOLD_REPLICA_ENDPOINT:?MANIFOLD_REPLICA_ENDPOINT (https://host) is required with MANIFOLD_REPLICA_BUCKET}"
: "${LITESTREAM_ACCESS_KEY_ID:?}" "${LITESTREAM_SECRET_ACCESS_KEY:?}"
db="${MANIFOLD_DATA_DIR:-/data}/manifold.db"
mkdir -p "$(dirname "$db")"
# Bounded: an unreachable store otherwise retries forever in silence, and a deploy that
# never starts must fail as one rather than hang as "unhealthy".
timeout 300 litestream restore -if-db-not-exists -if-replica-exists -config /app/infra/litestream.yml "$db"
exec litestream replicate -config /app/infra/litestream.yml -exec "bun packages/server/src/main.ts"
