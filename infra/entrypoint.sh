#!/usr/bin/env bash
# Hub entrypoint. Without MANIFOLD_REPLICA_BUCKET this is exactly `bun packages/server/src/main.ts`.
# With replication, scripts/replica-bootstrap.ts admits usable history or an explicit
# one-attempt first initialization before the server or replicator can start.
# One writer per replica: never run two instances against one bucket path.
set -euo pipefail
cd /app
for recovery_setting in \
  MANIFOLD_RECOVERY_CHECKPOINT \
  MANIFOLD_RECOVERY_SHA256 \
  MANIFOLD_RECOVERY_EXPECTED_BUILD \
  MANIFOLD_RECOVERY_BASE_IMAGE; do
  if [ -n "${!recovery_setting:-}" ]; then
    echo "$recovery_setting is set, but the ordinary image cannot perform full-state recovery" >&2
    exit 1
  fi
done
if [ -z "${MANIFOLD_REPLICA_BUCKET:-}" ]; then
  exec bun packages/server/src/main.ts
fi
: "${MANIFOLD_REPLICA_ENDPOINT:?MANIFOLD_REPLICA_ENDPOINT (https://host) is required with MANIFOLD_REPLICA_BUCKET}"
: "${LITESTREAM_ACCESS_KEY_ID:?}" "${LITESTREAM_SECRET_ACCESS_KEY:?}"
export MANIFOLD_DATA_DIR="${MANIFOLD_DATA_DIR:-/data}"
bun scripts/replica-bootstrap.ts prepare
printf '%s\n' '{"evt":"hub_replica_boot","state":"replication_starting"}'
exec litestream replicate -config /app/infra/litestream.yml -exec "bun packages/server/src/main.ts"
