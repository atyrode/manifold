#!/usr/bin/env bash
# Reproducible Linux proofs (each invocation owns a fresh delegated unit):
#   bash scripts/verify-runtime.sh jobs
#   bash scripts/verify-runtime.sh browser
# CI alone opts into the system manager: bash scripts/verify-runtime.sh --system jobs
# Absolute overrides: CC, BUN, MANIFOLD_TEST_BWRAP, MANIFOLD_TEST_STATIC_BUSYBOX.
# Browser-only overrides: MANIFOLD_CHROMIUM, MANIFOLD_GATE_DIST, MANIFOLD_RUNTIME_PROOF_DIR.
set -euo pipefail
umask 077

fail() { printf 'verify-runtime: %s\n' "$*" >&2; exit 1; }
system=false
if [[ ${1:-} == --system ]]; then system=true; shift; fi
[[ $# == 1 && ( $1 == jobs || $1 == browser ) ]] || fail 'usage: bash scripts/verify-runtime.sh [--system] jobs|browser'
mode=$1
[[ $(uname -s) == Linux ]] || fail 'Linux is required; this proof cannot skip'
[[ $EUID != 0 ]] || fail 'run as an ordinary host user; --system delegates only unit creation to sudo'
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

executable() {
  local path=${1:-}
  [[ $path == /* && -f $path && -x $path ]] || fail "$2 must resolve to an absolute executable path"
  printf '%s\n' "$path"
}
cc=$(executable "${CC:-$(command -v cc || true)}" CC)
bun=$(executable "${BUN:-$(command -v bun || true)}" BUN)
bwrap=$(executable "${MANIFOLD_TEST_BWRAP:-$(command -v bwrap || true)}" MANIFOLD_TEST_BWRAP)
busybox=$(executable "${MANIFOLD_TEST_STATIC_BUSYBOX:-$(command -v busybox || true)}" MANIFOLD_TEST_STATIC_BUSYBOX)
unshare=$(executable "$(command -v unshare || true)" unshare)
readelf=$(executable "$(command -v readelf || true)" readelf)
env_bin=$(executable "$(command -v env || true)" env)
timeout=$(executable "$(command -v timeout || true)" timeout)
systemd_run=$(executable "$(command -v systemd-run || true)" systemd-run)
systemctl=$(executable "$(command -v systemctl || true)" systemctl)
[[ ! -u $bwrap && ! -g $bwrap ]] || fail 'bubblewrap must not be setuid/setgid'
help=$("$bwrap" --help)
for option in --bind-fd --ro-bind-fd --seccomp --block-fd --info-fd; do
  [[ $help == *"$option "* ]] || fail "bubblewrap lacks required $option support"
done
static_elf() {
  local headers
  headers=$("$readelf" -l -d "$1") || fail "cannot inspect static ELF: $1"
  [[ $headers != *INTERP* && $headers != *NEEDED* ]] || fail "a static executable is required: $1"
}
static_elf "$busybox"

run=("$systemd_run" --user)
control=("$systemctl" --user)
identity=()
if $system; then
  sudo=$(executable "$(command -v sudo || true)" sudo)
  run=("$sudo" -n "$systemd_run" --system)
  control=("$sudo" -n "$systemctl" --system)
  identity=(--uid="$(id -u)" --gid="$(id -g)")
fi

root=$(mktemp -d "/tmp/manifold-jobs-${mode}.XXXXXXXX")
unit="manifold-jobs-${mode}-${root##*.}"
started=false
cleanup() {
  local status=$? state
  trap - EXIT INT TERM HUP
  if $started; then
    # --collect may already have removed the unit; never stop any other unit.
    if state=$("$timeout" --kill-after=5s 20s "${control[@]}" show "$unit.service" --property=LoadState --value); then
      if [[ $state != not-found ]]; then
        if ! "$timeout" --kill-after=5s 20s "${control[@]}" stop "$unit.service"; then
          printf 'verify-runtime: failed to stop owned unit %s\n' "$unit" >&2
          if [[ $status == 0 ]]; then status=1; fi
        fi
      fi
    else
      printf 'verify-runtime: could not confirm teardown of %s\n' "$unit" >&2
      if [[ $status == 0 ]]; then status=1; fi
    fi
  fi
  # The mount is private to the unit's namespace and disappears with its last process.
  if ! rm -rf -- "$root"; then
    printf 'verify-runtime: failed to remove owned temporary root %s\n' "$root" >&2
    if [[ $status == 0 ]]; then status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
mkdir -m 700 "$root/home" "$root/tmp" "$root/mount-tree" "$root/mount-tree/output"
path="$(dirname -- "$bun"):/usr/local/bin:/usr/bin:/bin"
"$timeout" --kill-after=5s 60s "$env_bin" -i PATH="$path" HOME="$root/home" TMPDIR="$root/tmp" \
  "$cc" -static -O2 -Wall -Wextra "$repo/packages/agent/test/fixtures/job-syscall-probe.c" -o "$root/syscall-probe"
static_elf "$root/syscall-probe"

# Allowlist only proof inputs, never forward caller/service-manager credentials.
proof_env=(PATH="$path" HOME="$root/home" TMPDIR="$root/tmp" LANG=C.UTF-8
  MANIFOLD_TEST_UNIT="$unit" MANIFOLD_TEST_BWRAP="$bwrap"
  MANIFOLD_TEST_STATIC_BUSYBOX="$busybox" MANIFOLD_TEST_SYSCALL_PROBE="$root/syscall-probe"
  MANIFOLD_TEST_OUTPUT_ROOT="$root/mount-tree/output" MANIFOLD_TEST_MOUNT_TREE="$root/mount-tree")
if [[ $mode == browser ]]; then
  for name in MANIFOLD_CHROMIUM MANIFOLD_GATE_DIST MANIFOLD_RUNTIME_PROOF_DIR; do
    if [[ -n ${!name:-} ]]; then
      [[ ${!name} == /* ]] || fail "$name must be absolute"
      proof_env+=("$name=${!name}")
    fi
  done
fi
printf 'verify-runtime: %s in disposable %s (%s manager; host uid %s)\n' "$mode" "$unit" "$(if $system; then printf system; else printf user; fi)" "$EUID"
started=true
"$timeout" --kill-after=10s 660s "${run[@]}" --unit="$unit" --collect --wait --pipe \
  "${identity[@]}" --working-directory="$repo" \
  --property='Delegate=cpu memory pids' --property=TasksMax=infinity \
  --property=RuntimeMaxSec=600 --property=TimeoutStopSec=10 --property=KillMode=control-group \
  --property=NoNewPrivileges=yes \
  "$env_bin" -i "${proof_env[@]}" \
  "$unshare" --user --map-root-user --mount --propagation private \
  "$busybox" sh -eu -c '
    # UID 0 exists only in this unprivileged user namespace, mapped to the host caller.
    "$MANIFOLD_TEST_STATIC_BUSYBOX" mount -t tmpfs -o size=65536,nr_inodes=4096,mode=0700 tmpfs "$MANIFOLD_TEST_OUTPUT_ROOT"
    case "$2" in
      jobs) exec "$1" run verify:jobs ;;
      browser) exec "$1" run verify:jobs:browser ;;
    esac
  ' verify-runtime "$bun" "$mode"
