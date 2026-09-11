#!/usr/bin/env bash
# Single-use public #469 preview reset. Remove after proof; not a deployment mode.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$here/common.sh"
source "$here/environment.sh"
phase=preflight
configuration_dir=
cleanup() {
  local code=$?
  trap - EXIT
  [[ -z $configuration_dir ]] || rm -rf -- "$configuration_dir"
  if ((code)); then
    printf 'preview-reset: HOLD phase=%s; no native lifecycle command or rollback\n' "$phase" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
[[ $# == 2 && $1 == --reset-disposable-preview ]] ||
  fail 'usage: cutover-legacy-preview.sh --reset-disposable-preview REVIEWED-REPLACEMENT-SHA'
require_domain
[[ $2 =~ ^[a-f0-9]{40}$ ]] || fail 'replacement requires a full reviewed commit SHA'
[[ -n ${MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID:-} && ${MANIFOLD_DEV_SPAWN_AGENT:-} == 0 ]] ||
  fail 'explicit existing native service owner and MANIFOLD_DEV_SPAWN_AGENT=0 required'
# Serialize normal preview deployers; other work inside this disposable container
# may be interrupted. External owners, transports and production are not targets.
umask 077
mkdir -p "$PREVIEW_HOME"
exec 9>"$PREVIEW_HOME/dev.lock"
flock -n 9 || fail 'another development deployment is in progress'
checkout=$PREVIEW_DEV_CHECKOUT
repo=$(cd "$here/../.." && pwd)
[[ $(git -C "$checkout" rev-parse HEAD) == "$2" && $(git -C "$repo" rev-parse HEAD) == "$2" ]] ||
  fail 'cutover source or replacement checkout differs from reviewed commit'
git -C "$checkout" diff --quiet HEAD -- || fail 'replacement checkout has tracked edits'
git -C "$repo" diff --quiet HEAD -- || fail 'cutover source has tracked edits'
identity "$checkout"
export MANIFOLD_CHANNEL=development MANIFOLD_SPAWN_AGENT=0
export MANIFOLD_SERVICE_OWNER_MACHINE_ID="$MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID"
export MANIFOLD_DOMAIN="preview.$PREVIEW_DOMAIN" MANIFOLD_IDENTITY_AUTHORITY="https://$PREVIEW_DOMAIN"
project=manifold-dev
volume=manifold-dev_manifold-data
public_url=${PREVIEW_DEV_URL:-https://preview.$PREVIEW_DOMAIN}
[[ $PREVIEW_DOMAIN == manifold.tyrode.dev && $PREVIEW_DEV_PORT == 7912 &&
   $public_url == https://preview.manifold.tyrode.dev ]] ||
  fail 'single-use reset is restricted to the named preview endpoint'
container=e56a20921a42dddeb0ceaff70181f113fdd36aff2de9568c6ac5f30d86625c05
require_preview_container() {
  local proof
  proof=$(docker inspect --format '
    {{- $machine := false -}}{{- $url := false -}}
    {{- range .Config.Env -}}
      {{- if eq . "MANIFOLD_MACHINE_NAME=dev-hub" -}}{{- $machine = true -}}{{- end -}}
      {{- if eq . "MANIFOLD_PUBLIC_URL=https://preview.manifold.tyrode.dev" -}}{{- $url = true -}}{{- end -}}
    {{- end -}}
    {{- if and $machine $url
      (eq .Name "/manifold-dev-manifold-1")
      (eq (index .Config.Labels "com.docker.compose.project") "manifold-dev")
      (eq (index .Config.Labels "com.docker.compose.service") "manifold")
      (eq .HostConfig.PidMode "") (eq .HostConfig.IpcMode "private")
      (eq .HostConfig.CgroupnsMode "private") (not .HostConfig.Privileged)
      (eq (len .HostConfig.CapAdd) 0) (eq (len .HostConfig.Devices) 0)
      (eq (len .Mounts) 1)
    -}}
      {{- range .Mounts -}}
        {{- if and (eq .Type "volume") (eq .Name "manifold-dev_manifold-data")
          (eq .Destination "/data") .RW -}}disposable-preview-only{{- end -}}
      {{- end -}}
    {{- end -}}' "$container" 2>/dev/null) ||
    fail 'cannot identify the explicitly disposable preview container'
  [[ $proof == disposable-preview-only ]] ||
    fail 'container is not the isolated preview target; production and native owners are protected'
}
require_preview_container
# Resolve local overrides exactly once, using the ordinary deployment's private
# tmpfs pattern. Configuration and credentials never enter logs.
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
build_retained_hub "$final_configuration" "$checkout" "$final_image" "$2"
# Pin the exact ordinary hub image, not its mutable build tag.
final_image=$(docker image inspect --format '{{.Id}}' "$final_image")
[[ $final_image =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'replacement image identity unavailable'
seal_retained_configuration "$final_configuration" "$final_image" "$sealed_configuration"
topology=$(retained_topology "$volume" "$final_image" dev_compose)
[[ $(docker inspect --format '{{json .NetworkSettings.Networks}}' "$container" | jq -ce 'keys | sort') == \
   "$(jq -c '.networks' <<<"$topology")" ]] ||
  fail 'replacement networks differ from the existing preview'
# No maintenance RPC is sent: an external native owner can serve production too.
# Only Docker's isolated preview container is stopped; the volume is never removed.
require_preview_container
phase=stopping-disposable-preview
docker update --restart=no "$container" >/dev/null
docker stop --time 20 "$container" >/dev/null
docker rm "$container" >/dev/null
phase=preview-removed-replacement-pending
[[ -z $(docker ps --all --quiet --filter "label=com.docker.compose.project=$project" \
  --filter 'label=com.docker.compose.service=manifold') ]] || fail 'unexpected replacement container appeared'
[[ $(retained_topology "$volume" "$final_image" dev_compose) == "$topology" ]] || fail 'replacement topology changed'
dev_compose "$final_image" up -d --no-build --no-deps manifold
phase=replacement-started
# The ordinary retained guard applies without a legacy exception.
require_retained_server_only "$project" "$volume" "$topology"
wait_health "$public_url" "$MANIFOLD_BUILD" || fail 'replacement health is unproved; do not restore the legacy owner'
phase=complete
printf 'preview-reset: ordinary hub healthy; data volume preserved; no native lifecycle command issued\n'
