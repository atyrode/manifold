#!/usr/bin/env bash
# Single-use public #469 migration. Remove after the proved cutover; not a deploy mode.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$here/common.sh"
source "$here/environment.sh"
phase=preflight
bundle_dir=
configuration_dir=
cleanup() {
  local code=$?
  trap - EXIT
  [[ -z $bundle_dir ]] || rm -rf -- "$bundle_dir"
  [[ -z $configuration_dir ]] || rm -rf -- "$configuration_dir"
  if ((code)); then
    printf 'legacy-cutover: HOLD phase=%s; no rollback, native activation or admission reopening\n' "$phase" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
[[ $# == 3 && $1 == --accept-reviewed-interpreted-source ]] ||
  fail 'usage: cutover-legacy-preview.sh --accept-reviewed-interpreted-source PUBLIC-EVIDENCE.json REVIEWED-REPLACEMENT-SHA'
require_domain
[[ $3 =~ ^[a-f0-9]{40}$ ]] || fail 'replacement requires a full reviewed commit SHA'
[[ -n ${MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID:-} && ${MANIFOLD_DEV_SPAWN_AGENT:-} == 0 ]] ||
  fail 'explicit existing native service owner and MANIFOLD_DEV_SPAWN_AGENT=0 required'
# This uses the same deployment lock as deploy-dev. Other Docker writers/execs must
# also be excluded by the operator for the entire transaction (including health).
umask 077
mkdir -p "$PREVIEW_HOME"
exec 9>"$PREVIEW_HOME/dev.lock"
flock -n 9 || fail 'another development deployment is in progress'
checkout=$PREVIEW_DEV_CHECKOUT
repo=$(cd "$here/../.." && pwd)
[[ $(git -C "$checkout" rev-parse HEAD) == "$3" ]] || fail 'replacement checkout differs from reviewed commit'
git -C "$checkout" diff --quiet HEAD -- || fail 'replacement checkout has tracked edits'
identity "$checkout"
export MANIFOLD_CHANNEL=development MANIFOLD_SPAWN_AGENT=0
export MANIFOLD_SERVICE_OWNER_MACHINE_ID="$MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID"
export MANIFOLD_DOMAIN="preview.$PREVIEW_DOMAIN" MANIFOLD_IDENTITY_AUTHORITY="https://$PREVIEW_DOMAIN"
project=manifold-dev
volume=manifold-dev_manifold-data
public_url=${PREVIEW_DEV_URL:-https://preview.$PREVIEW_DOMAIN}
# Resolve local overrides exactly once, using the ordinary deployment's private
# tmpfs pattern. Configuration/credentials never enter logs or the controller.
[[ -d /dev/shm && $(stat -f -c %T /dev/shm) == tmpfs ]] ||
  fail 'memory-backed replacement configuration storage required'
configuration_dir=$(mktemp -d /dev/shm/manifold-legacy-compose.XXXXXX)
configuration="$configuration_dir/compose.json"
final_configuration="$configuration_dir/final-compose.json"
sealed_configuration="$configuration_dir/sealed-compose.json"
(cd "$checkout" && docker compose config --format json) >"$configuration" 2>/dev/null ||
  fail 'cannot resolve the existing development stack'
final_image="$project:local"
resolved_configuration="$configuration_dir/resolved-compose.json"
seal_retained_configuration "$configuration" "$final_image" "$resolved_configuration"
(cd "$checkout" && PREVIEW_IMAGE="$final_image" frozen_retained_compose "$resolved_configuration" "$project" \
  --file "$here/compose.development.yaml" config --format json) >"$final_configuration" 2>/dev/null ||
  fail 'cannot resolve the final development stack'
jq -e --arg port "$PREVIEW_DEV_PORT" --arg url "https://preview.$PREVIEW_DOMAIN" \
  --arg owner "$MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID" '
  .services.manifold as $s |
  $s.environment.MANIFOLD_MACHINE_NAME == "dev-hub" and
  $s.environment.MANIFOLD_PUBLIC_URL == $url and
  $s.environment.MANIFOLD_SERVICE_OWNER_MACHINE_ID == $owner and
  ([ $s.ports[]? | select(.target == 7777 and .host_ip == "127.0.0.1" and (.published | tostring) == $port) ] | length) == 1
' "$final_configuration" >/dev/null 2>&1 || fail 'final development topology differs from the existing public hub contract'
seal_retained_configuration "$final_configuration" "$final_image" "$sealed_configuration"
dev_compose() {
  local image=$1; shift
  (cd "$checkout" && frozen_retained_compose "$sealed_configuration" "$project" "$@")
}
docker volume inspect "$volume" >/dev/null 2>&1 || fail 'existing named data volume is missing'
phase=building-reviewed-hub
build_retained_hub "$final_configuration" "$checkout" "$final_image" "$3"
# Pin the exact ordinary hub image, not its mutable build tag.
final_image=$(docker image inspect --format '{{.Id}}' "$final_image")
[[ $final_image =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'replacement image identity unavailable'
seal_retained_configuration "$final_configuration" "$final_image" "$sealed_configuration"
topology=$(retained_topology "$volume" "$final_image" dev_compose)
[[ -d /dev/shm ]] || fail 'memory-backed public maintenance bundle storage required'
bundle_dir=$(mktemp -d /dev/shm/manifold-legacy-cutover.XXXXXX)
printf 'import { runMaintenanceCLI } from %s;\nprocess.exitCode = await runMaintenanceCLI(process.argv.slice(2));\n' \
  "$(jq -Rn --arg path "$repo/packages/agent/src/maintenance.ts" '$path')" >"$bundle_dir/entry.ts"
bun build "$bundle_dir/entry.ts" --target=bun --outfile "$bundle_dir/maintenance.js" >/dev/null
bun build "$here/cutover-legacy-process.ts" --target=bun --outfile "$bundle_dir/process.js" >/dev/null
phase=retiring-legacy-container
python3 "$here/cutover-legacy-preview.py" "$2" "$topology" "$repo" "$bundle_dir/maintenance.js"
phase=legacy-removed-replacement-pending
[[ -z $(docker ps --all --quiet --filter "label=com.docker.compose.project=$project" \
  --filter 'label=com.docker.compose.service=manifold') ]] || fail 'unexpected replacement container appeared'
[[ $(retained_topology "$volume" "$final_image" dev_compose) == "$topology" ]] || fail 'replacement topology changed'
dev_compose "$final_image" up -d --no-build --no-deps manifold
phase=replacement-started
# The ordinary retained guard applies without a legacy exception.
require_retained_server_only "$project" "$volume" "$topology"
wait_health "$public_url" "$MANIFOLD_BUILD" || fail 'replacement health is unproved; do not restore the legacy owner'
phase=complete
printf 'legacy-cutover: ordinary hub healthy; state retained, existing native owner unchanged, admission not reopened\n'
