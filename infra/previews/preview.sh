#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/previews/common.sh
source "$here/common.sh"
# shellcheck source=infra/previews/caddy.sh
source "$here/caddy.sh"
# shellcheck source=infra/previews/environment.sh
source "$here/environment.sh"
require_domain
# These paths are interpolated in systemd and Caddy configuration, never shell code.
[[ $PREVIEW_HOME == /* && $PREVIEW_HOME != *[\"\\%$'\n\r']* ]] || fail 'PREVIEW_HOME must be an absolute configuration-safe path'
umask 077
mkdir -p "$PREVIEW_HOME" "$PREVIEW_HOME/checkouts" "$PREVIEW_HOME/live"
registry="$PREVIEW_HOME/registry"
touch "$registry"
exec 9>"$PREVIEW_HOME/lock"
flock 9

lookup() {
  local name kind port
  entry_kind='' entry_port=''
  while read -r name kind port; do
    if [[ $name == "$1" ]]; then entry_kind=$kind; entry_port=$port; return; fi
  done <"$registry"
}
allocate() {
  local name kind port first last candidate used
  lookup "$1"
  if [[ -n $entry_port ]]; then printf '%s' "$entry_port"; return; fi
  [[ $PREVIEW_PORT_RANGE =~ ^([0-9]{4,5})-([0-9]{4,5})$ ]] || fail 'invalid PREVIEW_PORT_RANGE'
  first=${BASH_REMATCH[1]}; last=${BASH_REMATCH[2]}
  ((first >= 1024 && last >= first && last <= 64535)) || fail 'invalid port range bounds'
  for ((candidate=first; candidate<=last; candidate++)); do
    used=0
    while read -r name kind port; do
      if ((candidate == port || candidate == port+1000 || candidate+1000 == port)); then used=1; break; fi
    done <"$registry"
    if ((used == 0)); then printf '%s' "$candidate"; return; fi
  done
  fail 'preview port range is full'
}
unregister() {
  local name kind port
  : >"$registry.new"
  while read -r name kind port; do
    [[ $name == "$1" ]] || printf '%s %s %s\n' "$name" "$kind" "$port" >>"$registry.new"
  done <"$registry"
  mv "$registry.new" "$registry"
}
register() { unregister "$1"; printf '%s %s %s\n' "$1" "$2" "$3" >>"$registry"; }
compose() {
  local number=$1 port=$2 image=$3; shift 3
  (
    cd "$here"
    COMPOSE_PROJECT_NAME="manifold-pr-$number" COMPOSE_FILE="$here/compose.preview.yaml" \
      MANIFOLD_DOMAIN="$number.$PREVIEW_DOMAIN" PREVIEW_PORT="$port" PREVIEW_MACHINE="pr-$number" PREVIEW_IMAGE="$image" \
      env -u MANIFOLD_OWNER_KEY docker compose --env-file /dev/null "$@"
  )
}
seed_preview_volume() (
  local volume=$1 archive seed_dir sanitized member
  local -a selected=()
  local database_count=0 wal_count=0 shm_count=0
  archive=$(realpath "$PREVIEW_SEED")
  [[ -f $archive && ! -L $archive ]] || fail 'PREVIEW_SEED must be a regular archive'
  seed_dir=$(mktemp -d "$PREVIEW_HOME/seed.XXXXXX")
  trap 'rm -rf -- "$seed_dir"' EXIT
  tar tzf "$archive" >"$seed_dir/members"
  while IFS= read -r member; do
    case "$member" in
      data/manifold.db) ((database_count += 1)); selected+=("$member") ;;
      data/manifold.db-wal) ((wal_count += 1)); selected+=("$member") ;;
      data/manifold.db-shm) ((shm_count += 1)); selected+=("$member") ;;
    esac
  done <"$seed_dir/members"
  ((database_count == 1 && wal_count <= 1 && shm_count <= 1)) ||
    fail 'PREVIEW_SEED must contain one canonical data/manifold.db member'
  tar xzf "$archive" -C "$seed_dir" -- "${selected[@]}"
  for member in "${selected[@]}"; do
    [[ -f $seed_dir/$member && ! -L $seed_dir/$member ]] ||
      fail 'PREVIEW_SEED database members must be regular files'
  done
  sanitized="$seed_dir/preview.db"
  bun --no-env-file "$here/../../scripts/preview-seed.ts" "$seed_dir/data/manifold.db" "$sanitized"
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
    -i -v "$volume:/data" alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 sh -c 'umask 077; cat > /data/manifold.db' <"$sanitized"
  log 'seeded representative containers, container_folders and scene_docs; preview authority is fresh'
)

up() {
  local number=$1 sha=$2 checkout port volume development_image base_image final_image revision
  local incumbent_revision health
  pr_name "$number"; sha_arg "$sha"
  checkout="$PREVIEW_HOME/checkouts/pr-$number"
  port=$(allocate "$number"); volume="manifold-pr-${number}_manifold-data"
  base_image="manifold-pr-pr-$number:base"; final_image="manifold-pr-pr-$number:local"
  log "fetching PR $number at $sha"
  if [[ ! -d $checkout ]]; then
    git clone -q --no-hardlinks "$PREVIEW_DEV_CHECKOUT" "$checkout"
    git -C "$checkout" remote set-url origin "$(git -C "$PREVIEW_DEV_CHECKOUT" remote get-url origin)"
  fi
  git -C "$checkout" fetch -q --tags origin
  git -C "$checkout" checkout -q --detach "$sha"
  revision=$(git -C "$checkout" rev-parse HEAD)
  identity "$checkout" "$revision"; export MANIFOLD_CHANNEL=development
  development_image=$(environment_image)
  if incumbent_revision=$(running_environment_revision "manifold-pr-$number" "$development_image") &&
     [[ $incumbent_revision == "$revision" ]] &&
     health=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" 2>/dev/null) &&
     [[ $(jq -r '.build' <<<"$health") == "$MANIFOLD_BUILD" ]]; then
    log "PR $number already runs exact healthy revision $revision; verifying without replacement"
    verify_disposable_environment "$final_image" compose "$number" "$port"
    register "$number" pr "$port"
    router
    log "https://$number.$PREVIEW_DOMAIN runs $MANIFOLD_BUILD without replacement"
    return
  fi
  require_environment_builder
  log "building PR $number: $MANIFOLD_BUILD on $development_image"
  log "stable preview boundary: using trusted standalone Compose topology"
  build_environment "$checkout" "$base_image" "$final_image" "manifold-pr-$number" "$development_image"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    log "creating data volume for PR $number"
    docker volume create "$volume" >/dev/null
    if [[ -n ${PREVIEW_SEED:-} ]]; then
      if ! seed_preview_volume "$volume"; then
        docker volume rm "$volume" >/dev/null
        fail 'seeding failed; removed incomplete data volume'
      fi
    fi
  fi
  replace_environment disposable "$volume" "$final_image" "manifold-pr-$number" "http://127.0.0.1:$port" compose "$number" "$port"
  register "$number" pr "$port"
  router
  log "https://$number.$PREVIEW_DOMAIN runs $MANIFOLD_BUILD on $development_image"
}
down() {
  local number=$1 port image image_id project resource resources volume incumbent
  pr_name "$number"; lookup "$number"; port=${entry_port:-7920}
  project="manifold-pr-$number"; volume="${project}_manifold-data"
  image="manifold-pr-pr-$number:local"
  incumbent=$(docker ps --quiet --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=manifold')
  if [[ -n $incumbent ]]; then
    [[ $incumbent =~ ^[0-9a-f]{64}$ ]] ||
      fail 'preview removal requires exactly one running manifold container'
    log "checking $project terminal owner before removal"
    if [[ -d $PREVIEW_HOME/checkouts/pr-$number ]]; then
      compose "$number" "$port" "$image" exec -T manifold bun - prepare <"$here/terminal-lifecycle.ts"
    else
      docker exec -i "$incumbent" bun - prepare <"$here/terminal-lifecycle.ts"
    fi
  fi
  log "removing PR $number"
  if [[ -d $PREVIEW_HOME/checkouts/pr-$number ]]; then
    compose "$number" "$port" "manifold-pr-pr-$number:local" down -v
    rm -rf -- "$PREVIEW_HOME/checkouts/pr-$number"
  else
    # A lost checkout must not strand this project's containers, networks or data.
    resources=$(docker container ls --all --quiet --filter "label=com.docker.compose.project=$project")
    while IFS= read -r resource; do
      [[ -z $resource ]] || docker container rm --force "$resource"
    done <<<"$resources"
    resources=$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")
    while IFS= read -r resource; do
      [[ -z $resource ]] || docker network rm "$resource"
    done <<<"$resources"
    resources=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")
    while IFS= read -r resource; do
      [[ -z $resource ]] || docker volume rm "$resource"
    done <<<"$resources"
    # The seed volume is created before Compose and can have no Compose labels.
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm "$volume"
    fi
  fi
  for image in "manifold-pr-pr-$number:base" "manifold-pr-pr-$number:local" "manifold-pr-$number:local"; do
    image_id=$(docker image ls --quiet "$image")
    if [[ -n $image_id ]]; then
      docker image rm "$image"
    fi
  done
  unregister "$number"
  router
}
live_name() {
  [[ $1 =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ || $1 =~ ^[a-z]$ ]] && [[ $1 != preview ]] || fail 'live name must be a non-numeric DNS label other than preview'
}
live() {
  local name=$1 worktree port unit
  live_name "$name"; worktree=$(realpath "$2")
  [[ -f $worktree/packages/server/src/main.ts && $worktree != *[\"\\%$'\n\r']* ]] || fail 'expected a configuration-safe manifold worktree path'
  port=$(allocate "$name")
  mkdir -p "$HOME/.config/systemd/user" "$PREVIEW_HOME/live/$name/data"
  identity "$worktree"
  {
    printf 'MANIFOLD_PORT=%s\nMANIFOLD_DATA_DIR="%s/live/%s/data"\n' "$((port+1000))" "$PREVIEW_HOME" "$name"
    printf 'MANIFOLD_PUBLIC_URL=https://%s.%s\nMANIFOLD_DEV_HOST=%s.%s\n' "$name" "$PREVIEW_DOMAIN" "$name" "$PREVIEW_DOMAIN"
    printf 'MANIFOLD_VERSION=%s\nMANIFOLD_BUILD=%s\nMANIFOLD_CHANNEL=development\n' "$MANIFOLD_VERSION" "$MANIFOLD_BUILD"
    printf 'MANIFOLD_ANNOUNCE_KEY=0\nMANIFOLD_PLUGIN_DEV_PATHS=1\nMANIFOLD_MACHINE_NAME=%s\nPREVIEW_PORT=%s\n' "$name" "$port"
    printf 'PATH="%s"\n' "$PATH"
  } >"$PREVIEW_HOME/live/$name.env"
  unit="$HOME/.config/systemd/user/manifold-live-$name.service"
  {
    printf '[Unit]\nDescription=Manifold live worktree %s\n[Service]\n' "$name"
    printf 'WorkingDirectory=%s\nEnvironmentFile=%s/live/%s.env\n' "$worktree" "$PREVIEW_HOME" "$name"
    printf 'ExecStart="%s" "%s/live-run.sh"\n' "$(command -v bash)" "$here"
    printf 'Restart=on-failure\nRestartSec=3\nKillMode=control-group\n[Install]\nWantedBy=default.target\n'
  } >"$unit"
  systemctl --user daemon-reload
  systemctl --user enable "manifold-live-$name.service"
  systemctl --user restart "manifold-live-$name.service"
  register "$name" live "$port"; router
  log "https://$name.$PREVIEW_DOMAIN — journalctl --user -u manifold-live-$name"
}
unlive() {
  local name=$1
  live_name "$name"
  log "stopping live worktree $name"
  if [[ -f $HOME/.config/systemd/user/manifold-live-$name.service ]]; then
    systemctl --user disable --now "manifold-live-$name.service"
    rm -- "$HOME/.config/systemd/user/manifold-live-$name.service"
    systemctl --user daemon-reload
  fi
  rm -f -- "$PREVIEW_HOME/live/$name.env"
  unregister "$name"; router
}
url() {
  local name=$1 key
  lookup "$name"; [[ -n $entry_kind ]] || fail 'preview is not registered'
  log "https://$name.$PREVIEW_DOMAIN"
  if [[ $entry_kind == pr ]]; then
    [[ -t 1 ]] || fail 'pre-auth URL is a secret: run url only in the operator local terminal'
    log 'SECRET: the following pre-auth URL is for the operator local terminal only.'
    key=$(compose "$name" "$entry_port" "manifold-pr-pr-$name:local" exec -T manifold sh -c 'cat /data/owner.key')
    [[ $key =~ ^[0-9a-f]{64}$ ]] || fail 'invalid owner key'
    printf 'https://%s.%s/#key=%s\n' "$name" "$PREVIEW_DOMAIN" "$key"
    unset key
  fi
}
gc() {
  local name kind port state
  command -v gh >/dev/null || { log 'gh unavailable; gc skipped'; return; }
  local -a closed=()
  while read -r name kind port; do
    [[ $kind == pr ]] || continue
    state=$(cd "$PREVIEW_DEV_CHECKOUT" && gh pr view "$name" --json state --jq .state)
    [[ $state == CLOSED || $state == MERGED ]] && closed+=("$name")
  done <"$registry"
  for name in "${closed[@]}"; do down "$name"; done
  docker builder prune --all --force --keep-storage "$PREVIEW_BUILD_CACHE_KEEP_STORAGE"
  docker image prune --force
  log 'gc complete'
}
gc_timer() {
  [[ $here != *[\"\\%$'\n\r']* ]] || fail 'expected a configuration-safe tooling path'
  mkdir -p "$HOME/.config/systemd/user"
  {
    printf '[Unit]\nDescription=Manifold preview garbage collection\n[Service]\nType=oneshot\n'
    printf 'Environment="PREVIEW_HOME=%s"\nEnvironment="PATH=%s"\n' "$PREVIEW_HOME" "$PATH"
    [[ -z ${DOCKER_HOST:-} ]] || printf 'Environment="DOCKER_HOST=%s"\n' "$DOCKER_HOST"
    [[ -z ${DOCKER_CONTEXT:-} ]] || printf 'Environment="DOCKER_CONTEXT=%s"\n' "$DOCKER_CONTEXT"
    printf 'ExecStart="%s" "%s/preview.sh" gc\n' "$(command -v bash)" "$here"
  } >"$HOME/.config/systemd/user/manifold-previews-gc.service"
  {
    printf '[Unit]\nDescription=Daily Manifold preview garbage collection\n[Timer]\n'
    printf 'OnCalendar=daily\nPersistent=true\n[Install]\nWantedBy=timers.target\n'
  } >"$HOME/.config/systemd/user/manifold-previews-gc.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now manifold-previews-gc.timer
}
plugin() {
  local url=$1 sha=$2 container
  plugin_url "$url"; sha256_arg "$sha"
  shift 2
  [[ -d $PREVIEW_DEV_CHECKOUT ]] || fail "no dev checkout at $PREVIEW_DEV_CHECKOUT"
  # The integrated preview's container, as its own compose project names it; the kit reads the
  # owner key out of it over docker exec, so no secret is ever on this side of the socket.
  container=$(cd "$PREVIEW_DEV_CHECKOUT" && MANIFOLD_DOMAIN="preview.$PREVIEW_DOMAIN" env -u MANIFOLD_OWNER_KEY docker compose ps -q manifold)
  [[ $container =~ ^[0-9a-f]{12,64}$ ]] || fail 'the integrated preview container is not running'
  log "installing $url on https://preview.$PREVIEW_DOMAIN"
  # The kit from THIS (stable) checkout, against the dev stack's loopback port. The checkout is
  # built inside Docker and has never needed node_modules on the host, so the verb installs the
  # workspace first — frozen, quiet, a no-op once present; the whole workspace, because a
  # `--filter` install does not link the workspace packages the kit imports — rather than
  # depending on someone having run `bun install` here by hand (the first release install failed
  # exactly there).
  (cd "$here/../.." \
    && bun install --frozen-lockfile --silent \
    && bun packages/plugin-kit/src/install.ts "$url" --sha256 "$sha" \
      --hub "http://127.0.0.1:$PREVIEW_DEV_PORT" --deliver "docker:$container" "$@")
}
case "${1:-}:$#" in
  up:3) up "$2" "$3" ;;
  down:2) down "$2" ;;
  ls:1) log 'name kind port'; cat "$registry" ;;
  url:2) url "$2" ;;
  live:3) live "$2" "$3" ;;
  unlive:2) unlive "$2" ;;
  router:1) router ;;
  gc:1) gc ;;
  gc-timer:1) gc_timer ;;
  plugin:3) plugin "$2" "$3" ;;
  plugin:4) [[ $4 == --hardened ]] || fail 'expected --hardened'; plugin "$2" "$3" --hardened ;;
  *) fail 'usage: preview.sh up N SHA | down N | ls | url N-or-name | live name worktree | unlive name | router | gc | gc-timer | plugin URL SHA256 [--hardened]' ;;
esac
