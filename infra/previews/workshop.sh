#!/usr/bin/env bash
# This service owns source frontend/watch resources only, never the retained hub or native owner.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/previews/common.sh
source "$here/common.sh"
service=manifold-code-workshop.service
unit="$HOME/.config/systemd/user/$service"
state="$PREVIEW_HOME/workshop"
marker='# Managed by Manifold infra/previews/workshop.sh'

config_path() {
  [[ $1 == /* && $1 != *[\"\\%$'\n\r']* ]] || fail 'expected an absolute configuration-safe path'
}
owned_unit() {
  local first
  if [[ -e $unit || -L $unit ]]; then
    [[ -f $unit && ! -L $unit ]] || fail 'workshop unit is not a regular owned file'
    IFS= read -r first <"$unit" || fail 'workshop unit ownership marker is missing'
    [[ $first == "$marker" ]] || fail 'workshop unit is not owned by this lifecycle tool'
  fi
}
usage() {
  printf '%s\n' 'usage: workshop.sh start CONFIG.json | status | stop' \
    'start installs/enables one user service; SDK workshop has plugin installation authority.' \
    'status reports only owned service/listener state; stop retains source/config/data and the hub.'
}

case "${1:-}:$#" in
  --help:1|help:1) usage; exit 0 ;;
  start:2|status:1|stop:1) ;;
  *) usage >&2; exit 2 ;;
esac
config_path "$PREVIEW_HOME"
config_path "$here"
mkdir -p "$state"
exec 8>"$state/lifecycle.lock"
flock 8
owned_unit
case "$1" in
  start)
    config_path "$2"
    [[ -f $2 ]] || fail 'workshop config is not a regular file'
    bun=$(command -v bun) || fail 'Bun >=1.4.2 is required'
    config_path "$bun"
    [[ $PATH != *[\"\\%$'\n\r']* ]] || fail 'PATH is not configuration-safe'
    "$bun" --no-env-file "$here/workshop-run.ts" validate "$2"
    manifold_root=$(jq -er '.manifoldRoot' "$2")
    config_path "$manifold_root"
    [[ ! -L $state/config.json && ! -L $unit ]] || fail 'workshop state or unit must not be a symlink'
    umask 077
    # Configuration is non-secret; never write the owner key into a file or environment.
    if [[ $2 != "$state/config.json" ]]; then
      cp -- "$2" "$state/config.json.next"
      mv -- "$state/config.json.next" "$state/config.json"
    fi
    mkdir -p "$(dirname -- "$unit")"
    {
      printf '%s\n' "$marker" '[Unit]' 'Description=Manifold Code live workshop (retained preview hub)'
      printf '[Service]\nWorkingDirectory="%s"\n' "$manifold_root"
      printf 'Environment="PATH=%s"\n' "$PATH"
      printf 'ExecStart="%s" --no-env-file "%s/workshop-run.ts" run "%s/config.json"\n' "$bun" "$here" "$state"
      printf 'Restart=on-failure\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=30\n'
      printf '[Install]\nWantedBy=default.target\n'
    } >"$unit"
    systemctl --user daemon-reload
    systemctl --user enable "$service"
    systemctl --user restart "$service"
    log 'workshop service started; status/journal confirm frontend readiness and install outcomes'
    ;;
  status)
    if [[ -f $unit ]]; then
      systemctl --user show "$service" --property=UnitFileState,ActiveState,SubState,MainPID
    else
      log 'workshop service not installed'
    fi
    if curl -sS --max-time 2 --output /dev/null --header 'Host: preview.manifold.tyrode.dev' http://127.0.0.1:7913/; then
      log 'loopback source frontend listening on 7913'
    else
      log 'source frontend absent; public frontend uses installed hub build on 7912'
    fi
    ;;
  stop)
    if [[ -f $unit ]]; then
      systemctl --user disable --now "$service"
      rm -- "$unit"
      systemctl --user daemon-reload
    fi
    log 'workshop stopped; source/config/data retained and installed frontend remains on 7912'
    ;;
esac
