#!/usr/bin/env bash
# A recovery image restores one authenticated checkpoint before the selected prior release starts.
# It writes subsequent SQLite changes to a checkpoint-specific replica namespace, never the
# forward deployment's history. The ordinary image refuses these settings instead of ignoring
# a stale recovery request.
set -euo pipefail
cd /app

: "${MANIFOLD_RECOVERY_CHECKPOINT:?}"
: "${MANIFOLD_RECOVERY_SHA256:?}"
: "${MANIFOLD_RECOVERY_EXPECTED_BUILD:?}"
: "${MANIFOLD_REPLICA_BUCKET:?}"
: "${MANIFOLD_REPLICA_ENDPOINT:?}"
: "${LITESTREAM_ACCESS_KEY_ID:?}"
: "${LITESTREAM_SECRET_ACCESS_KEY:?}"
: "${MANIFOLD_OWNER_KEY:?A pinned owner key outside the checkpoint is required}"

if [ "${MANIFOLD_BUILD:-}" != "$MANIFOLD_RECOVERY_EXPECTED_BUILD" ]; then
  echo "recovery image build identity does not match the selected prior release" >&2
  exit 1
fi

control="$(mktemp -d /tmp/manifold-recovery.XXXXXX)"
chmod 700 "$control"
config="$control/litestream.yml"
databases="$control/databases"
export MANIFOLD_RECOVERY_LITESTREAM_CONFIG="$config"
export MANIFOLD_RECOVERY_DATABASES_FILE="$databases"

/usr/local/bin/manifold-full-state-recovery restore \
  "$MANIFOLD_RECOVERY_CHECKPOINT" "$MANIFOLD_RECOVERY_SHA256"

index=0
while IFS= read -r database; do
  [ -n "$database" ] || continue
  latest="/tmp/manifold-recovery-latest-$index.db"
  rm -f "$latest" "$latest-wal" "$latest-shm" "$latest-journal"
  timeout 300 litestream restore -if-replica-exists -integrity-check full \
    -config "$config" -o "$latest" "$database"
  if [ -f "$latest" ]; then
    mv "$latest" "$database"
  fi
  index=$((index + 1))
done < "$databases"

exec litestream replicate -config "$config" -exec "bun packages/server/src/main.ts"
