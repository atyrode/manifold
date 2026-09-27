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

# Match the checkpoint helper's trim/default/resolve rule before classifying replica paths.
MANIFOLD_DATA_DIR="$(bun -e 'import { resolve } from "node:path"; process.stdout.write(resolve(process.env.MANIFOLD_DATA_DIR?.trim() || "/data"));')"
export MANIFOLD_DATA_DIR

control="$(mktemp -d /tmp/manifold-recovery.XXXXXX)"
chmod 700 "$control"
trap 'rm -rf -- "$control"' EXIT
config="$control/litestream.yml"
databases="$control/databases"
export MANIFOLD_RECOVERY_LITESTREAM_CONFIG="$config"
export MANIFOLD_RECOVERY_DATABASES_FILE="$databases"

/usr/local/bin/manifold-full-state-recovery restore \
  "$MANIFOLD_RECOVERY_CHECKPOINT" "$MANIFOLD_RECOVERY_SHA256"

index=0
any_replica=0
main_replica=0
while IFS= read -r database; do
  [ -n "$database" ] || continue
  latest="$control/latest-$index.db"
  timeout 300 litestream restore -if-replica-exists -integrity-check full \
    -config "$config" -o "$latest" "$database"
  if [ -f "$latest" ]; then
    any_replica=1
    if [ "$database" = "$MANIFOLD_DATA_DIR/manifold.db" ]; then
      main_replica=1
    fi
    mv "$latest" "$database"
  fi
  index=$((index + 1))
done < "$databases"

# A main seal commits the complete SQLite set. Never validate it against checkpoint-era
# auxiliary files before their replicas have been restored.
if [ "$any_replica" -eq 1 ]; then
  if [ "$main_replica" -ne 1 ]; then
    echo '{"evt":"hub_replica_boot","state":"refused","reason":"replica_freshness_unestablished"}' >&2
    exit 1
  fi
  /usr/local/bin/manifold-replica-guard validate-restored "$MANIFOLD_DATA_DIR/manifold.db"
fi

exec < "$config"
rm -rf -- "$control"
trap - EXIT
unset MANIFOLD_RECOVERY_LITESTREAM_CONFIG MANIFOLD_RECOVERY_DATABASES_FILE
if [ "$any_replica" -eq 0 ]; then
  exec /usr/local/bin/manifold-replica-guard --config-stdin --authenticated-baseline
fi
exec /usr/local/bin/manifold-replica-guard --config-stdin
