#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/previews/common.sh
source "$here/common.sh"
# shellcheck source=infra/previews/environment.sh
source "$here/environment.sh"
require_domain
[[ $# == 1 ]] || fail 'usage: deploy-dev.sh SHA'
sha_arg "$1"
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
echo "deploy-dev: converging on $1"
# Fetch everything and resolve locally: a remote serves want-lists by full object id only,
# and an operator at a terminal types the abbreviation.
git -C "$checkout" fetch -q --tags origin
git -C "$checkout" checkout -q --detach "$1"
identity "$checkout"
export MANIFOLD_CHANNEL=development
echo "deploy-dev: version=$MANIFOLD_VERSION build=$MANIFOLD_BUILD channel=$MANIFOLD_CHANNEL"
# Compose's resolved configuration can contain credentials. Keep it only in a private
# memory-backed directory, never in the persistent preview checkout or deployment state.
[[ -d /dev/shm ]] || fail 'integrated deployment requires memory-backed temporary storage'
configuration_dir=$(mktemp -d /dev/shm/manifold-dev-compose.XXXXXX)
configuration="$configuration_dir/compose.json"
trap 'rm -rf -- "$configuration_dir"' EXIT
(cd "$checkout" && MANIFOLD_DOMAIN="preview.$PREVIEW_DOMAIN" MANIFOLD_IDENTITY_AUTHORITY="https://$PREVIEW_DOMAIN" docker compose config --format json) >"$configuration"
project=$(jq -er '.name' "$configuration")
[[ $project =~ ^manifold-dev(-[a-z0-9-]+)?$ ]] || fail 'integrated deployment requires a manifold-dev Compose project'
# Refuse a misdirected stack before building, draining, or stopping any service. Preserve
# the existing dev-hub identity, selected volume and networks rather than create a new hub.
jq -e --arg port "$PREVIEW_DEV_PORT" --arg url "https://preview.$PREVIEW_DOMAIN" '
  .services.manifold.environment.MANIFOLD_MACHINE_NAME == "dev-hub" and
  .services.manifold.environment.MANIFOLD_PUBLIC_URL == $url and
  ([.services.manifold.ports[]? | select(.target == 7777 and .host_ip == "127.0.0.1" and (.published | tostring) == $port)] | length) == 1 and
  ([.services.manifold.volumes[]? | select(.target == "/data" and .type == "volume")] | length) == 1
' "$configuration" >/dev/null || fail 'integrated deployment requires the existing dev-hub, preview URL, loopback port and named /data volume'
volume=$(jq -er '.services.manifold.volumes[] | select(.target == "/data") | .source as $source | $source' "$configuration")
volume=$(jq -er --arg source "$volume" '.volumes[$source].name' "$configuration")
# A shared/external production volume is not a development migration target.
[[ $volume == "${project}_manifold-data" ]] || fail 'integrated deployment requires its project-owned manifold-data volume'
final_image="$project:local"
dev_compose() {
  local image=$1; shift
  (cd "$checkout" && PREVIEW_IMAGE="$image" docker compose --project-name "$project" \
    --file "$configuration" --file "$here/compose.development.yaml" "$@")
}
# Build the ordinary application image, not the disposable development environment.
dev_compose "$final_image" build manifold
# Resolve and validate the final merge before any live mutation as well.
dev_compose "$final_image" config --quiet
# Retained data must already exist: a typo must not silently create a fresh identity.
docker volume inspect "$volume" >/dev/null 2>&1 || fail 'retained development data volume is missing'
replace_environment retained "$volume" "$final_image" "$project" "$public_url" dev_compose
echo "deploy-dev: retained hub healthy on $MANIFOLD_BUILD; native execution unchanged"
