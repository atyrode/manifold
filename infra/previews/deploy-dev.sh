#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/previews/common.sh
source "$here/common.sh"
# shellcheck source=infra/previews/environment.sh
source "$here/environment.sh"
# shellcheck source=infra/previews/deployment-order.sh
source "$here/deployment-order.sh"
require_domain
mode=forward
expected_current=
case "$#" in
  1) sha_arg "$1"; target_arg=$1 ;;
  3)
    [[ $2 == --rollback-from ]] || fail 'usage: deploy-dev.sh SHA [--rollback-from EXPECTED_CURRENT_FULL_SHA]'
    [[ $1 =~ ^[0-9a-f]{40}$ && $3 =~ ^[0-9a-f]{40}$ ]] ||
      fail 'rollback target and expected current revision must be full commit SHAs'
    target_arg=$1
    expected_current=$3
    mode=rollback
    ;;
  *) fail 'usage: deploy-dev.sh SHA [--rollback-from EXPECTED_CURRENT_FULL_SHA]' ;;
esac
umask 077
mkdir -p "$PREVIEW_HOME"
exec 9>"$PREVIEW_HOME/dev.lock"
flock 9
checkout=$PREVIEW_DEV_CHECKOUT
public_url=${PREVIEW_DEV_URL:-https://preview.$PREVIEW_DOMAIN}
[[ -n ${MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID:-} ]] || fail 'set MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID to the explicit enrolled native owner'
[[ ${MANIFOLD_DEV_SPAWN_AGENT:-} == 0 ]] || fail 'MANIFOLD_DEV_SPAWN_AGENT must be explicitly 0; shared development is hub-only'
export MANIFOLD_SERVICE_OWNER_MACHINE_ID="$MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID"
# This configures only the replacement. The retained lifecycle separately proves
# the actual incumbent is server-only before it may stop or replace that container.
export MANIFOLD_SPAWN_AGENT=0
echo "deploy-dev: converging on $target_arg"
# Fetch and resolve without changing this checkout: it contains the installed receiver
# and guard, while the selected application is streamed from the immutable Git object.
git -C "$checkout" fetch -q --tags origin
revision=$(full_commit "$checkout" "$target_arg")
if [[ $mode == rollback && $revision != "$target_arg" ]]; then
  fail 'rollback target must identify an exact commit'
fi
unset MANIFOLD_VERSION MANIFOLD_BUILD MANIFOLD_CHANNEL
identity_output=$(bun "$here/../../scripts/build-identity.ts" --repository "$checkout" --revision "$revision" --env) ||
  fail 'cannot derive target build identity with installed trusted tooling'
while IFS='=' read -r key value; do
  case "$key" in
    'export MANIFOLD_VERSION') export MANIFOLD_VERSION="$value" ;;
    'export MANIFOLD_BUILD') export MANIFOLD_BUILD="$value" ;;
    'export MANIFOLD_CHANNEL') export MANIFOLD_CHANNEL="$value" ;;
    *) fail 'invalid target build identity output' ;;
  esac
done <<<"$identity_output"
[[ -n ${MANIFOLD_VERSION:-} && -n ${MANIFOLD_BUILD:-} && -n ${MANIFOLD_CHANNEL:-} ]] ||
  fail 'incomplete target build identity output'
export MANIFOLD_CHANNEL=development
echo "deploy-dev: version=$MANIFOLD_VERSION build=$MANIFOLD_BUILD channel=$MANIFOLD_CHANNEL"
# Compose's resolved configuration can contain credentials. Keep it only in a private
# memory-backed directory, never in the persistent preview checkout or deployment state.
[[ -d /dev/shm && $(stat -f -c %T /dev/shm) == tmpfs ]] ||
  fail 'integrated deployment requires memory-backed temporary storage'
configuration_dir=$(mktemp -d /dev/shm/manifold-dev-compose.XXXXXX)
configuration="$configuration_dir/compose.json"
trap 'rm -rf -- "$configuration_dir"' EXIT
(cd "$checkout" && MANIFOLD_DOMAIN="preview.$PREVIEW_DOMAIN" MANIFOLD_IDENTITY_AUTHORITY="https://$PREVIEW_DOMAIN" docker compose config --format json) >"$configuration" 2>/dev/null ||
  fail 'cannot resolve the existing development stack'
project=$(jq -er '.name' "$configuration")
[[ $project =~ ^manifold-dev(-[a-z0-9-]+)?$ ]] || fail 'integrated deployment requires a manifold-dev Compose project'
final_image="$project:local"
resolved_configuration="$configuration_dir/resolved-compose.json"
seal_retained_configuration "$configuration" "$final_image" "$resolved_configuration"
dev_compose() {
  local image=$1; shift
  (cd "$checkout" && PREVIEW_IMAGE="$image" frozen_retained_compose "$resolved_configuration" "$project" \
    --file "$here/compose.development.yaml" "$@")
}
# Check the final merge, including the deployment overlay, not just the host base.
# Keep this credential-bearing configuration in the same private memory directory.
final_configuration="$configuration_dir/final-compose.json"
dev_compose "$final_image" config --format json >"$final_configuration" 2>/dev/null ||
  fail 'cannot resolve the final development stack'
# Refuse a misdirected stack before building, draining, or stopping any service. Preserve
# the existing dev-hub identity, selected volume and networks rather than create a new hub.
jq -e --arg port "$PREVIEW_DEV_PORT" --arg url "https://preview.$PREVIEW_DOMAIN" '
  .services.manifold.environment.MANIFOLD_MACHINE_NAME == "dev-hub" and
  .services.manifold.environment.MANIFOLD_PUBLIC_URL == $url and
  ([.services.manifold.ports[]? | select(.target == 7777 and .host_ip == "127.0.0.1" and (.published | tostring) == $port)] | length) == 1 and
  ([.services.manifold.volumes[]? | select(.target == "/data" and .type == "volume")] | length) == 1
' "$final_configuration" >/dev/null 2>&1 || fail 'integrated deployment requires the existing dev-hub, preview URL, loopback port and named /data volume'
volume=$(jq -er '.services.manifold.volumes[] | select(.target == "/data") | .source' "$final_configuration")
volume=$(jq -er --arg source "$volume" '.volumes[$source].name' "$final_configuration")
# A shared/external production volume is not a development migration target.
[[ $volume == "${project}_manifold-data" ]] || fail 'integrated deployment requires its project-owned manifold-data volume'
# From this point neither the checkout overrides nor the deployment overlay are
# consulted again, including during build. Keep the original merge for resealing.
sealed_configuration="$configuration_dir/sealed-compose.json"
seal_retained_configuration "$final_configuration" "$final_image" "$sealed_configuration"
dev_compose() {
  local image=$1; shift
  (cd "$checkout" && frozen_retained_compose "$sealed_configuration" "$project" "$@")
}
# Ordering follows the immutable image used by the exact Compose service, including
# a stopped candidate left by a failed activation. The installed checkout need not
# name that image's commit and is deliberately not deployment-state evidence.
incumbent_image=$(installed_development_image "$project")
incumbent_revision=$(development_image_revision "$incumbent_image" "$checkout")
require_development_order "$checkout" "$incumbent_revision" "$revision" "$mode" "$expected_current"
# Keep the incumbent's image record reachable even on containerd image stores.
# A failed activation may leave it referenced only by the previous candidate tag.
docker image tag "$incumbent_image" "$project:local" ||
  fail 'HOLD: cannot preserve incumbent image provenance'
candidate_image="$project:candidate"
# Build separately: replacing the incumbent's sole tag can discard its metadata.
build_retained_hub "$final_configuration" "$checkout" "$candidate_image" "$revision"
final_image=$(docker image inspect --format '{{.Id}}' "$candidate_image")
[[ $final_image =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'replacement image identity unavailable'
seal_retained_configuration "$final_configuration" "$final_image" "$sealed_configuration"
# Retained data must already exist: a typo must not silently create a fresh identity.
docker volume inspect "$volume" >/dev/null 2>&1 || fail 'retained development data volume is missing'
replace_environment retained "$volume" "$final_image" "$project" "$public_url" dev_compose
docker image tag "$final_image" "$project:local" ||
  fail 'retained hub is healthy but its current image reference could not be promoted'
echo "deploy-dev: retained hub healthy on $MANIFOLD_BUILD; native execution unchanged"
