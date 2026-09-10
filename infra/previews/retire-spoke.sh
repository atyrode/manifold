#!/usr/bin/env bash
# Explicit old-owner handoff, separate from hub deployment and native activation.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
retirement_hold() { printf 'retire-spoke: HOLD: %s; admission is not reopened\n' "$*" >&2; exit 1; }
userctl() { systemctl --user "$@"; }
unit_property() {
  local response
  response=$(userctl show "$1" --property="$2" --all) || return 1
  [[ $response == "$2="* && $response != *$'\n'* ]] || return 1
  printf '%s' "${response#*=}"
}
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
  bun "$bundle" shutdown --socket "$socket" --terminal-host-id "$terminal_host_id" --expected-pid "$owner_pid"
}
# The supplied store output is a separately reviewed provenance reference, NOT a
# value discovered from this process. Its compiled main.ts must have the split
# non-owning default mode (flake.nix), not a Bun interpreter plus mutable source.
prove_transport() {
  local executable="$transport_package/libexec/manifold-agent" actual_executable arg mode child
  local -a argv=() processes=()
  mode=$(stat -c %a "$executable") || retirement_hold 'transport artifact permissions are unknown'
  [[ $(readlink -f -- "$executable") == "$executable" &&
     -f $executable && -x $executable &&
     $(stat -c %u "$executable") == 0 && $mode =~ ^[0145]{3}$ ]] ||
    retirement_hold 'transport approval is not an immutable compiled executable'
  # Independently reproduced bytes also identify retained compiled deployments
  # outside the store. Never approve an artifact from the running process itself.
  cmp -s -- "/proc/$transport_pid/exe" "$executable" ||
    retirement_hold 'transport bytes differ from the independently reviewed executable'
  actual_executable=$(readlink -- "/proc/$transport_pid/exe") ||
    retirement_hold 'transport executable identity is unknown'
  actual_executable=${actual_executable%" (deleted)"}
  while IFS= read -r -d '' arg; do argv+=("$arg"); done <"/proc/$transport_pid/cmdline"
  [[ ${#argv[@]} == 1 &&
     ( ${argv[0]} == "$actual_executable" || ${argv[0]} == "$executable" ||
       ${argv[0]} == "$transport_package/bin/manifold-agent" ) ]] ||
    retirement_hold 'transport executable arguments do not prove the reviewed non-owning mode'
  mapfile -t processes <"/sys/fs/cgroup$transport_cgroup/cgroup.procs" ||
    retirement_hold 'transport cgroup membership is unknown'
  [[ ${#processes[@]} == 1 && ${processes[0]} == "$transport_pid" ]] ||
    retirement_hold 'transport supervisor contains other unproved processes'
  for child in "/sys/fs/cgroup$transport_cgroup/"*; do
    [[ ! -d $child ]] || retirement_hold 'transport supervisor contains an unproved child cgroup'
  done
}
# A dependency can tear down unrelated work without a reverse stop-propagation
# edge: its last active user disappearing is enough when StopWhenUnneeded=yes.
# Checking the direct pinning dependencies is sufficient to prevent that cascade.
require_no_unneeded_stop() {
  local unit=$1 property dependencies dependency
  [[ $(unit_property "$unit" StopWhenUnneeded) == no ]] ||
    retirement_hold 'supervisor can stop automatically when unneeded or policy is unknown'
  for property in Requires Requisite Wants BindsTo Upholds; do
    dependencies=$(unit_property "$unit" "$property") ||
      retirement_hold 'supervisor forward dependencies are unknown'
    local -a units=()
    read -r -a units <<<"$dependencies"
    for dependency in "${units[@]}"; do
      [[ $(unit_property "$dependency" StopWhenUnneeded) == no ]] ||
        retirement_hold 'forward dependency can stop automatically when unneeded or policy is unknown'
    done
  done
}
require_transport_kill_policy() {
  case $(unit_property "$transport_unit" KillMode) in
    control-group|mixed) ;;
    *) retirement_hold 'transport kill policy does not prove process-group termination' ;;
  esac
  [[ $(unit_property "$transport_unit" SendSIGKILL) == yes ]] ||
    retirement_hold 'transport final kill policy is disabled or unknown'
}
# Manager MainPID=0 is not kernel exit evidence. Fail closed on a surviving or
# reused PID, unreadable cgroup, or populated descendants. Prove absence one
# directory at a time so an inaccessible ancestor cannot masquerade as absence.
transport_exited() {
  local pid=$1 cgroup=$2 directory=/sys/fs/cgroup component key value populated=
  [[ $pid =~ ^[1-9][0-9]*$ && -r /proc/self/stat && -r /proc && -x /proc &&
     ! -e /proc/$pid && $cgroup == /* && -r $directory/cgroup.controllers ]] || return 1
  local -a components=()
  IFS=/ read -r -a components <<<"${cgroup#/}"
  for component in "${components[@]}"; do
    [[ -n $component && $component != . && $component != .. &&
       -d $directory && -r $directory && -x $directory ]] || return 1
    directory+=/"$component"
    [[ ! -L $directory ]] || return 1
    [[ -e $directory ]] || return 0
  done
  [[ -r $directory/cgroup.events ]] || return 1
  while read -r key value; do
    [[ $key != populated ]] || populated=$value
  done <"$directory/cgroup.events"
  [[ $populated == 0 ]]
}
# Exiting an empty owner is as significant as stopping its transport. Inspect both
# sides of the supervisor graph before either process can become inactive.
require_no_propagation() {
  local unit=$1 property result
  require_no_unneeded_stop "$unit"
  for property in ConsistsOf BoundBy RequiredBy RequisiteOf UpheldBy PropagatesStopTo; do
    result=$(unit_property "$unit" "$property") || retirement_hold 'supervisor propagation metadata is unknown'
    # The proved non-owning transport is stopped before the owner can exit.
    [[ -z $result || ( $unit == "$terminal_host_unit" && $result == "$transport_unit" ) ]] ||
      retirement_hold 'supervisor exit or stop has external effects'
  done
  for property in OnSuccess OnFailure TriggeredBy; do
    result=$(unit_property "$unit" "$property") || retirement_hold 'supervisor activation metadata is unknown'
    [[ -z $result ]] || retirement_hold 'supervisor has unproved activation paths'
  done
  for property in SuccessAction FailureAction StartLimitAction; do
    [[ $(unit_property "$unit" "$property") == none ]] || retirement_hold 'supervisor exit action is not inert'
  done
  # systemctl omits empty command arrays even with --all. Typed D-Bus replies
  # distinguish an empty hook list from an unsupported or missing property.
  local unit_path
  unit_path=$(busctl --user --json=short call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
    org.freedesktop.systemd1.Manager GetUnit s "$unit" |
    jq -er 'select(.type == "o" and (.data | length) == 1) | .data[0] |
      select(startswith("/org/freedesktop/systemd1/unit/"))') ||
    retirement_hold 'supervisor service object is unknown'
  for property in ExecStop ExecStopPost; do
    result=$(busctl --user --json=short get-property org.freedesktop.systemd1 "$unit_path" \
      org.freedesktop.systemd1.Service "$property") || retirement_hold 'supervisor stop commands are unknown'
    jq -e '.type == "a(sasbttttuii)" and .data == []' <<<"$result" >/dev/null ||
      retirement_hold 'supervisor has unproved stop commands'
  done
}
inhibit_supervisor_restarts() {
  local unit directory override
  for unit in "$terminal_host_unit" "$transport_unit"; do
    original_restart[$unit]=$(unit_property "$unit" Restart) || retirement_hold 'restart policy is unknown'
    original_force_restart[$unit]=$(unit_property "$unit" RestartForceExitStatus) || retirement_hold 'forced restart policy is unknown'
    [[ -n ${original_restart[$unit]} ]] || retirement_hold 'restart policy is missing'
    directory="$runtime_dir/systemd/user/$unit.d"
    mkdir -p -- "$directory"
    [[ -d $directory && ! -L $directory && -O $directory &&
       $(readlink -f -- "$directory") == "$directory" ]] || retirement_hold 'runtime override directory is not owned or canonical'
    override=$(mktemp "$directory/zzzz-manifold-retirement-XXXXXXXX.conf")
    restart_overrides[$unit]=$override
    restart_override_identities[$unit]=$(stat -c '%d:%i' "$override")
    printf '[Service]\nRestart=no\nRestartForceExitStatus=\n' >"$override"
  done
  userctl daemon-reload || retirement_hold 'cannot load temporary restart inhibition'
  require_restart_inhibited
}
require_restart_inhibited() {
  local unit paths force_restart
  for unit in "$terminal_host_unit" "$transport_unit"; do
    paths=$(unit_property "$unit" DropInPaths) || retirement_hold 'loaded restart override is unknown'
    force_restart=$(unit_property "$unit" RestartForceExitStatus) || retirement_hold 'forced restart policy is unknown'
    [[ " $paths " == *" ${restart_overrides[$unit]} "* &&
       $(unit_property "$unit" Restart) == no &&
       -z $force_restart ]] ||
      retirement_hold 'temporary restart inhibition was not loaded'
  done
  [[ $(require_running_unit "$terminal_host_unit") == "$owner_pid" &&
     $(unit_property "$terminal_host_unit" InvocationID) == "$owner_invocation" ]] ||
    retirement_hold 'restart inhibition did not preserve the proved owner generation'
}
restore_supervisor_restarts() {
  local unit override current_restart current_force_restart failed=0 changed=0
  for unit in "${!restart_overrides[@]}"; do
    override=${restart_overrides[$unit]}
    # Never remove another operation's inode or edits, including edits in place.
    if [[ -f $override && ! -L $override &&
          $(stat -c '%d:%i' "$override") == "${restart_override_identities[$unit]:-}" &&
          $(<"$override") == $'[Service]\nRestart=no\nRestartForceExitStatus=' ]]; then
      if rm -- "$override"; then changed=1; else failed=1; fi
    else
      failed=1
    fi
  done
  if ((changed)); then
    userctl daemon-reload || failed=1
    for unit in "${!restart_overrides[@]}"; do
      if current_restart=$(unit_property "$unit" Restart) &&
         current_force_restart=$(unit_property "$unit" RestartForceExitStatus) &&
         [[ ! -e ${restart_overrides[$unit]} &&
            $current_restart == "${original_restart[$unit]}" &&
            $current_force_restart == "${original_force_restart[$unit]}" ]]; then
        unset 'restart_overrides[$unit]'
      else
        failed=1
      fi
    done
  fi
  return "$failed"
}
retire_spoke() {
  local transport_pid transport_invocation owner_cgroup transport_cgroup result
  owner_pid=$(require_running_unit "$terminal_host_unit") || retirement_hold 'cannot prove terminal-host supervisor'
  transport_pid=$(require_running_unit "$transport_unit") || retirement_hold 'cannot prove transport supervisor'
  owner_invocation=$(unit_property "$terminal_host_unit" InvocationID) || retirement_hold 'owner invocation is unknown'
  [[ $owner_invocation =~ ^[a-fA-F0-9]{32}$ ]] || retirement_hold 'owner invocation is missing'
  transport_invocation=$(unit_property "$transport_unit" InvocationID) || retirement_hold 'transport invocation is unknown'
  [[ $transport_invocation =~ ^[a-fA-F0-9]{32}$ ]] || retirement_hold 'transport invocation is missing'
  [[ $owner_pid != "$transport_pid" ]] || retirement_hold 'transport and owner are not separate processes'
  owner_cgroup=$(unit_property "$terminal_host_unit" ControlGroup) || retirement_hold 'owner cgroup is unknown'
  transport_cgroup=$(unit_property "$transport_unit" ControlGroup) || retirement_hold 'transport cgroup is unknown'
  [[ $owner_cgroup == /* && $transport_cgroup == /* &&
     $owner_cgroup != "$transport_cgroup" && $owner_cgroup != "$transport_cgroup/"* ]] ||
    retirement_hold 'transport cgroup contains the owner or is unknown'
  require_no_propagation "$terminal_host_unit"
  require_no_propagation "$transport_unit"
  require_transport_kill_policy
  prove_transport
  result=$(drain_cli) || retirement_hold 'drain refused or reported unknown work'
  jq -e --arg machine "$machine_id" --arg host "$terminal_host_id" '
    .ok == true and .command == "drain" and .machineId == $machine and
    .terminalHostId == $host and .draining == true and .terminalIds == []
  ' <<<"$result" >/dev/null || retirement_hold 'drain did not prove the named host with no retained terminals'
  # Drain's terminal inventory is NOT job-idle proof. Only the named owner's atomic
  # shutdown can decide that after the non-owning transport has released its seat.
  [[ $(require_running_unit "$terminal_host_unit") == "$owner_pid" &&
     $(require_running_unit "$transport_unit") == "$transport_pid" ]] || retirement_hold 'supervisor changed during drain'
  inhibit_supervisor_restarts
  require_no_propagation "$terminal_host_unit"
  require_no_propagation "$transport_unit"
  require_transport_kill_policy
  prove_transport
  [[ $(require_running_unit "$transport_unit") == "$transport_pid" &&
     $(unit_property "$transport_unit" InvocationID) == "$transport_invocation" ]] || retirement_hold 'proved transport generation changed'
  retiring_transport_pid=$transport_pid
  retiring_transport_cgroup=$transport_cgroup
  recover_transport=1
  userctl stop "$transport_unit" || retirement_hold 'transport stop failed'
  [[ $(unit_property "$transport_unit" ActiveState) == inactive &&
     $(unit_property "$transport_unit" SubState) == dead &&
     $(unit_property "$transport_unit" MainPID) == 0 ]] || retirement_hold 'transport did not stop'
  transport_exited "$retiring_transport_pid" "$retiring_transport_cgroup" ||
    retirement_hold 'original transport process or cgroup has not proved empty'
  require_restart_inhibited
  result=$(shutdown_cli) || retirement_hold 'atomic empty shutdown refused or unknown'
  jq -e --arg host "$terminal_host_id" '
    .ok == true and .command == "shutdown" and .terminalHostId == $host
  ' <<<"$result" >/dev/null || retirement_hold 'shutdown acknowledgement did not name the exact owner'
  # Never stop the owner by unit name, even after acknowledgement: that could
  # target an unproved replacement generation. With Restart inhibited, await the
  # acknowledged process's own exit and refuse any other observed generation.
  local attempt
  for ((attempt = 0; attempt < 100; attempt++)); do
    [[ $(unit_property "$terminal_host_unit" MainPID) == 0 ]] && break
    [[ $(unit_property "$terminal_host_unit" MainPID) == "$owner_pid" &&
       $(unit_property "$terminal_host_unit" InvocationID) == "$owner_invocation" ]] ||
      retirement_hold 'owner generation changed after acknowledgement; no owner stop is authorized'
    sleep 0.1
  done
  [[ $(unit_property "$terminal_host_unit" ActiveState) == inactive &&
     $(unit_property "$terminal_host_unit" SubState) == dead &&
     $(unit_property "$terminal_host_unit" MainPID) == 0 ]] ||
    retirement_hold 'acknowledged owner has not exited; no owner stop is authorized'
  recover_transport=0
  userctl disable "$terminal_host_unit" "$transport_unit" || retirement_hold 'supervisor disable failed after acknowledgement'
  restore_supervisor_restarts || retirement_hold 'cannot restore original supervisor restart policies'
  require_stopped_unit "$terminal_host_unit" && require_stopped_unit "$transport_unit" ||
    retirement_hold 'supervisors are not proved stopped and disabled; native startup remains forbidden'
  printf 'retire-spoke: acknowledged named owner shutdown; both old supervisors are stopped and disabled; native activation remains a separate reviewed operation\n'
}
retirement_cleanup() {
  local code=$? recovery_pid
  trap - EXIT
  if ! restore_supervisor_restarts; then
    printf 'retire-spoke: HOLD: restart-policy restoration failed; inspect the owned runtime override\n' >&2
    code=1
  fi
  if [[ ${recover_transport:-0} == 1 ]]; then
    if [[ $(unit_property "$transport_unit" ActiveState) != inactive ||
          $(unit_property "$transport_unit" SubState) != dead ||
          $(unit_property "$transport_unit" MainPID) != 0 ]] ||
       ! transport_exited "$retiring_transport_pid" "$retiring_transport_cgroup"; then
      printf 'retire-spoke: HOLD: original transport exit is unproved; no second transport is authorized\n' >&2
      code=1
    elif ! userctl start "$transport_unit" || ! recovery_pid=$(require_running_unit "$transport_unit"); then
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
  [[ $# == 16 ]] || retirement_hold 'usage: retire-spoke.sh --container CONTAINER --machine-id ID --terminal-host-id ID --terminal-host-unit UNIT.service --transport-unit UNIT.service --transport-package /nix/store/REVIEWED-manifold-agent-VERSION --socket /absolute/socket --runtime-dir /run/user/UID'
  while (($#)); do
    flag=$1; value=$2; shift 2
    [[ -n $value && $value != -* && $value != *[$'\n\r\t']* && ! -v seen[$flag] ]] || retirement_hold 'invalid or duplicate public reference'
    seen[$flag]=1
    case "$flag" in
      --container) container=$value ;;
      --machine-id) machine_id=$value ;;
      --terminal-host-id) terminal_host_id=$value ;;
      --terminal-host-unit) terminal_host_unit=$value ;;
      --transport-package) transport_package=$value ;;
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
  [[ ${transport_package:-} =~ ^/nix/store/[a-z0-9]{32}-manifold-agent-[a-zA-Z0-9.+_-]+$ ]] ||
    retirement_hold 'transport requires a separately reviewed immutable compiled agent package'
  [[ -d $runtime_dir && -O $runtime_dir && $(stat -c %a "$runtime_dir") == 700 ]] || retirement_hold 'runtime directory must be private and owned by this user'
  umask 077
  exec 9>"$runtime_dir/manifold-retire-spoke.lock"
  flock -n 9 || retirement_hold 'another retirement is in progress'
  bundle_dir=$(mktemp -d "$runtime_dir/manifold-retirement.XXXXXX")
  bundle="$bundle_dir/maintenance.js"
  recover_transport=0
  declare -gA original_restart=() original_force_restart=() restart_overrides=() restart_override_identities=()
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
