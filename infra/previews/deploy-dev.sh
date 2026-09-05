#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/previews/common.sh
source "$here/common.sh"
require_domain
[[ $# == 1 ]] || fail 'usage: deploy-dev.sh SHA'
sha_arg "$1"
mkdir -p "$PREVIEW_HOME"
exec 9>"$PREVIEW_HOME/dev.lock"
flock 9
checkout=$PREVIEW_DEV_CHECKOUT
public_url=${PREVIEW_DEV_URL:-https://preview.$PREVIEW_DOMAIN}
echo "deploy-dev: converging on $1"
# Fetch everything and resolve locally: a remote serves want-lists by full object id only,
# and an operator at a terminal types the abbreviation.
git -C "$checkout" fetch -q --tags origin
git -C "$checkout" checkout -q --detach "$1"
identity "$checkout"
echo "deploy-dev: version=$MANIFOLD_VERSION build=$MANIFOLD_BUILD channel=$MANIFOLD_CHANNEL"
(cd "$checkout" && MANIFOLD_DOMAIN="preview.$PREVIEW_DOMAIN" docker compose up -d --build manifold)
echo "deploy-dev: waiting for $public_url/healthz"
wait_health "$public_url" "$MANIFOLD_BUILD"
echo "deploy-dev: hub healthy on $MANIFOLD_BUILD"
if [[ -z ${MANIFOLD_DEV_SPOKE_UNIT:-} ]]; then
  echo 'deploy-dev: no spoke unit configured; skipping spoke rebuild'
  exit 0
fi
binary=${MANIFOLD_DEV_SPOKE_BINARY:-$HOME/.local/share/manifold-dev-agent/manifold-agent}
agent_env=${MANIFOLD_DEV_SPOKE_ENV:-$HOME/.config/manifold/dev/agent.env}
echo 'deploy-dev: rebuilding the dev spoke'
mkdir -p "$(dirname "$binary")" "$(dirname "$agent_env")"
(cd "$checkout" && bun build --compile packages/agent/src/main.ts --outfile "$binary" >/dev/null)
printf 'MANIFOLD_BUILD=%s\n' "$MANIFOLD_BUILD" >"$agent_env"
since=$(date --iso-8601=seconds)
systemctl --user restart "$MANIFOLD_DEV_SPOKE_UNIT"
for ((attempt=0; attempt<20; attempt++)); do
  journal=$(journalctl --user -u "$MANIFOLD_DEV_SPOKE_UNIT" --since "$since" -o cat)
  if [[ $journal == *'"evt":"welcome"'* ]]; then
    echo 'deploy-dev: spoke welcomed by the hub'
    exit 0
  fi
  sleep 2
done
echo "deploy-dev: no spoke welcome; check journalctl --user -u $MANIFOLD_DEV_SPOKE_UNIT" >&2
exit 1
