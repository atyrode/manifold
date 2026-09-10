#!/usr/bin/env bash
# Explicit old-owner handoff, separate from hub deployment and native activation.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
retirement_hold() { printf 'retire-spoke: HOLD: %s; admission is not reopened\n' "$*" >&2; exit 1; }
userctl() { systemctl --user "$@"; }
unit_property() { userctl show "$1" --property="$2" --value; }
require_running_unit() {
  local unit=$1 pid
  [[ $(unit_property "$unit" LoadState) == loaded &&
     $(unit_property "$unit" ActiveState) == active &&
     $(unit_property "$unit" SubState) == running ]] || retirement_hold 'old supervisor state is uncertain or not running'
  pid=$(unit_property "$unit" MainPID)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || retirement_hold 'old supervisor has no proved process'
  printf '%s' "$pid"
}
require_stopped_unit() {
  local unit=$1 enabled
  enabled=$(unit_property "$unit" UnitFileState) || return 1
  [[ $(unit_property "$unit" LoadState) == loaded &&
     $(unit_property "$unit" ActiveState) == inactive &&
     $(unit_property "$unit" SubState) == dead &&
     $(unit_property "$unit" MainPID) == 0 &&
     $enabled == disabled ]]
}
# These two adapters keep the credential read in the owning container. The bundle
# contains only the reviewed maintenance CLI, never the owner/transport entrypoint.
drain_cli() {
  docker exec -i --workdir /app "$container" bun - drain --hub http://127.0.0.1:7777 \
    --machine-id "$machine_id" --owner-key-file /data/owner.key <"$bundle"
}
shutdown_cli() {
  bun "$bundle" shutdown --socket "$socket" --terminal-host-id "$terminal_host_id"
}
retire_spoke() {
  local owner_pid transport_pid owner_cgroup transport_cgroup property result
  owner_pid=$(require_running_unit "$terminal_host_unit") || retirement_hold 'cannot prove terminal-host supervisor'
  transport_pid=$(require_running_unit "$transport_unit") || retirement_hold 'cannot prove transport supervisor'
  [[ $owner_pid != "$transport_pid" ]] || retirement_hold 'transport and owner are not separate processes'
  owner_cgroup=$(unit_property "$terminal_host_unit" ControlGroup) || retirement_hold 'owner cgroup is unknown'
  transport_cgroup=$(unit_property "$transport_unit" ControlGroup) || retirement_hold 'transport cgroup is unknown'
  [[ $owner_cgroup == /* && $transport_cgroup == /* &&
     $owner_cgroup != "$transport_cgroup" && $owner_cgroup != "$transport_cgroup/"* ]] ||
    retirement_hold 'transport cgroup contains the owner or is unknown'
  for property in ConsistsOf BoundBy RequiredBy PropagatesStopTo; do
    result=$(unit_property "$transport_unit" "$property") || retirement_hold 'transport stop dependencies are unknown'
    [[ -z $result ]] || retirement_hold 'transport stop would propagate to another unit'
  done
  result=$(drain_cli) || retirement_hold 'drain refused or reported unknown work'
  jq -e --arg machine "$machine_id" --arg host "$terminal_host_id" '
    .ok == true and .command == "drain" and .machineId == $machine and
    .terminalHostId == $host and .draining == true and .terminalIds == []
  ' <<<"$result" >/dev/null || retirement_hold 'drain did not prove the named host with no retained terminals'
  # Drain's terminal inventory is NOT job-idle proof. Only the named owner's atomic
  # shutdown can decide that after the non-owning transport has released its seat.
  [[ $(require_running_unit "$terminal_host_unit") == "$owner_pid" &&
     $(require_running_unit "$transport_unit") == "$transport_pid" ]] || retirement_hold 'supervisor changed during drain'
  recover_transport=1
  userctl stop "$transport_unit" || retirement_hold 'transport stop failed'
  [[ $(unit_property "$transport_unit" ActiveState) == inactive &&
     $(unit_property "$transport_unit" SubState) == dead &&
     $(unit_property "$transport_unit" MainPID) == 0 ]] || retirement_hold 'transport did not stop'
  result=$(shutdown_cli) || retirement_hold 'atomic empty shutdown refused or unknown'
  jq -e --arg host "$terminal_host_id" '
    .ok == true and .command == "shutdown" and .terminalHostId == $host
  ' <<<"$result" >/dev/null || retirement_hold 'shutdown acknowledgement did not name the exact owner'
  # No owner stop/disable is permitted above this positive identity-bound proof.
  recover_transport=0
  userctl disable "$terminal_host_unit" "$transport_unit" || retirement_hold 'supervisor disable failed after acknowledgement'
  userctl stop "$terminal_host_unit" "$transport_unit" || retirement_hold 'supervisor stop failed after acknowledgement'
  require_stopped_unit "$terminal_host_unit" && require_stopped_unit "$transport_unit" ||
    retirement_hold 'supervisors are not proved stopped and disabled; native startup remains forbidden'
  printf 'retire-spoke: acknowledged named owner shutdown; both old supervisors are stopped and disabled; native activation remains a separate reviewed operation\n'
}
retirement_cleanup() {
  local code=$? recovery_pid
  trap - EXIT
  if [[ ${recover_transport:-0} == 1 ]]; then
    if ! userctl start "$transport_unit" || ! recovery_pid=$(require_running_unit "$transport_unit"); then
      printf 'retire-spoke: HOLD: transport recovery failed; keep admission closed and investigate\n' >&2
      code=1
    fi
  fi
  [[ -z ${bundle_dir:-} ]] || rm -rf -- "$bundle_dir"
  exit "$code"
}
retirement_main() {
  local flag value repo
  declare -A seen=()
  [[ $# == 14 ]] || retirement_hold 'usage: retire-spoke.sh --container CONTAINER --machine-id ID --terminal-host-id ID --terminal-host-unit UNIT.service --transport-unit UNIT.service --socket /absolute/socket --runtime-dir /run/user/UID'
  while (($#)); do
    flag=$1; value=$2; shift 2
    [[ -n $value && $value != -* && $value != *[$'\n\r\t']* && ! -v seen[$flag] ]] || retirement_hold 'invalid or duplicate public reference'
    seen[$flag]=1
    case "$flag" in
      --container) container=$value ;;
      --machine-id) machine_id=$value ;;
      --terminal-host-id) terminal_host_id=$value ;;
      --terminal-host-unit) terminal_host_unit=$value ;;
      --transport-unit) transport_unit=$value ;;
      --socket) socket=$value ;;
      --runtime-dir) runtime_dir=$value ;;
      *) retirement_hold 'unknown argument' ;;
    esac
  done
  [[ ${container:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && -n ${machine_id:-} && -n ${terminal_host_id:-} &&
     ${terminal_host_unit:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9@_.-]*\.service$ &&
     ${transport_unit:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9@_.-]*\.service$ &&
     $terminal_host_unit != "$transport_unit" && ${socket:-} == /* && ${runtime_dir:-} == /* ]] || retirement_hold 'invalid explicit references'
  [[ -d $runtime_dir && -O $runtime_dir && $(stat -c %a "$runtime_dir") == 700 ]] || retirement_hold 'runtime directory must be private and owned by this user'
  umask 077
  exec 9>"$runtime_dir/manifold-retire-spoke.lock"
  flock -n 9 || retirement_hold 'another retirement is in progress'
  bundle_dir=$(mktemp -d "$runtime_dir/manifold-retirement.XXXXXX")
  bundle="$bundle_dir/maintenance.js"
  recover_transport=0
  trap retirement_cleanup EXIT
  trap 'exit 1' HUP INT TERM
  repo=$(cd "$here/../.." && pwd)
  # Bundle only public source, so old containers need no install, binary replacement,
  # private-file copy, or unsafe probe of an old main.ts that ignores --maintenance.
  printf 'import { runMaintenanceCLI } from %s;\nprocess.exitCode = await runMaintenanceCLI(process.argv.slice(2));\n' \
    "$(jq -Rn --arg path "$repo/packages/agent/src/maintenance.ts" '$path')" >"$bundle_dir/entry.ts"
  bun build "$bundle_dir/entry.ts" --target=bun --outfile "$bundle" >/dev/null
  retire_spoke
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then retirement_main "$@"; fi
