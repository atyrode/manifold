#!/usr/bin/env bash
# Shared by the operator CLI and forced-command receiver; no shell evaluation of env files.
set -euo pipefail
export PREVIEW_HOME="${PREVIEW_HOME:-$HOME/manifold-previews}"
if [[ -f "$PREVIEW_HOME/env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    key=${line%%=*}; value=${line#*=}
    case "$key" in
      PREVIEW_DOMAIN|PREVIEW_SEED|PREVIEW_DEV_CHECKOUT|PREVIEW_DEV_URL|PREVIEW_DEV_PORT|PREVIEW_PORT_RANGE|PREVIEW_ROUTER_PORT|MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID|MANIFOLD_DEV_SPAWN_AGENT) export "$key=$value" ;;
      *) printf 'preview: unknown env key: %s\n' "$key" >&2; exit 2 ;;
    esac
  done <"$PREVIEW_HOME/env"
fi
export PREVIEW_DEV_CHECKOUT="${PREVIEW_DEV_CHECKOUT:-$HOME/manifold-dev}"
export PREVIEW_DEV_PORT="${PREVIEW_DEV_PORT:-7912}"
export PREVIEW_PORT_RANGE="${PREVIEW_PORT_RANGE:-7920-7999}"
export PREVIEW_ROUTER_PORT="${PREVIEW_ROUTER_PORT:-7900}"
# Keep recent build layers without letting daily preview rebuilds consume the host disk.
export PREVIEW_BUILD_CACHE_KEEP_STORAGE=5G
readonly PREVIEW_BUILD_CACHE_KEEP_STORAGE
log() { printf 'preview: %s\n' "$*"; }
fail() { log "$*" >&2; exit 2; }
require_domain() {
  [[ ${PREVIEW_DOMAIN:-} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail 'set PREVIEW_DOMAIN to a DNS domain'
  [[ $PREVIEW_ROUTER_PORT =~ ^[0-9]+$ ]] || fail 'invalid PREVIEW_ROUTER_PORT'
  [[ $PREVIEW_DEV_PORT =~ ^[0-9]+$ ]] || fail 'invalid PREVIEW_DEV_PORT'
}
pr_name() { [[ $1 =~ ^[1-9][0-9]{0,9}$ ]] || fail 'expected a positive PR number'; }
sha_arg() { [[ $1 =~ ^[0-9a-f]{7,40}$ ]] || fail 'expected a commit SHA'; }
sha256_arg() { [[ $1 =~ ^[0-9a-f]{64}$ ]] || fail 'expected a sha256'; }
# A published bundle's address: https, one host, a path of URL-safe characters and nothing a
# shell or a log line could misread. The receiver splits on whitespace before this runs.
plugin_url() { [[ $1 =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~%/+-]+\.manifold-plugin\.json$ ]] || fail 'expected an https URL ending in .manifold-plugin.json'; }
identity() {
  local repository=$1 revision=${2:-} output key value
  local version='' build='' channel='' version_count=0 build_count=0 channel_count=0
  local -a command=(bun "$here/../../scripts/build-identity.ts" --repository "$repository" --env)
  [[ -z $revision ]] || command+=(--revision "$revision")
  output=$("${command[@]}") ||
    fail 'cannot derive build identity with installed trusted tooling'
  while IFS='=' read -r key value; do
    case "$key" in
      'export MANIFOLD_VERSION')
        ((version_count += 1)); version=$value
        ;;
      'export MANIFOLD_BUILD')
        ((build_count += 1)); build=$value
        ;;
      'export MANIFOLD_CHANNEL')
        ((channel_count += 1)); channel=$value
        ;;
      *) fail 'invalid build identity output' ;;
    esac
  done <<<"$output"
  ((version_count == 1 && build_count == 1 && channel_count == 1)) ||
    fail 'incomplete or duplicate build identity output'
  [[ $version =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$ &&
     $build =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$ &&
     ($channel == release || $channel == development) ]] ||
    fail 'malformed inert build identity'
  export MANIFOLD_VERSION=$version MANIFOLD_BUILD=$build MANIFOLD_CHANNEL=$channel
}
wait_health() {
  local url=$1 build=$2 health attempt
  for ((attempt=0; attempt<60; attempt++)); do
    if health=$(curl -fsS --max-time 3 "$url/healthz" 2>/dev/null) &&
       [[ $(jq -r '.build' <<<"$health") == "$build" ]]; then
      return 0
    fi
    sleep 3
  done
  log "health check failed: $url did not report $build" >&2
  return 1
}
