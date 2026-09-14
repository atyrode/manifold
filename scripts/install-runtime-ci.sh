#!/usr/bin/env bash
# Explicit privileged setup for an ephemeral GitHub-hosted Ubuntu runner only.
# Production agents need neither this compiler toolchain nor this installation step.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]] || {
  printf 'install-runtime-ci: requires an ordinary user on an ephemeral GitHub-hosted runner\n' >&2
  exit 1
}
sudo -n apt-get update
sudo -n apt-get install -y gcc libc6-dev binutils busybox-static

# Ubuntu's stock bubblewrap can predate FD binds. Build the immutable v0.11.2 commit,
# without setuid support, instead of weakening the runtime proof for old packages.
revision=1b80120ef26a28e065e67f89bfef873f13bdd317
cache=${MANIFOLD_BWRAP_CACHE:-}
if [[ -n $cache && ( $cache != /* || $cache == / ) ]]; then
  printf 'install-runtime-ci: MANIFOLD_BWRAP_CACHE must be an absolute cache directory\n' >&2
  exit 1
fi

root=$(mktemp -d "${RUNNER_TEMP:?}/manifold-bwrap.XXXXXXXX")
cache_stage=
cache_displaced=
cleanup() {
  rm -rf -- "$root"
  [[ -z $cache_stage ]] || rm -rf -- "$cache_stage"
  [[ -z $cache_displaced ]] || rm -rf -- "$cache_displaced"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cache_is_valid() {
  local directory=$1
  [[ -d $directory && ! -L $directory &&
    -f $directory/bwrap && ! -L $directory/bwrap &&
    -x $directory/bwrap && ! -u $directory/bwrap && ! -g $directory/bwrap &&
    -f $directory/revision && ! -L $directory/revision ]] &&
    cmp -s -- "$directory/revision" <(printf '%s' "$revision") &&
    "$directory/bwrap" --version >/dev/null 2>&1
}

bwrap=$root/build/bwrap
if [[ -n $cache ]] && cache_is_valid "$cache"; then
  bwrap=$cache/bwrap
else
  sudo -n apt-get install -y clang-18 libcap-dev pkg-config meson ninja-build git
  git init --quiet "$root/source"
  git -C "$root/source" remote add origin https://github.com/containers/bubblewrap.git
  git -C "$root/source" fetch --depth=1 origin "$revision"
  git -C "$root/source" checkout --detach FETCH_HEAD
  [[ $(git -C "$root/source" rev-parse HEAD) == "$revision" ]]
  # GCC 13's optimized null-format analysis rejects this upstream release; Clang
  # builds it with the same strict warning policy rather than disabling diagnostics.
  CC=clang-18 meson setup "$root/build" "$root/source" --buildtype=release \
    -Dsupport_setuid=false -Dtests=false -Dman=disabled -Dselinux=disabled \
    -Dbash_completion=disabled -Dzsh_completion=disabled
  meson compile -C "$root/build"

  if [[ -n $cache ]]; then
    cache_parent=$(dirname -- "$cache")
    cache_name=$(basename -- "$cache")
    mkdir -p -- "$cache_parent"
    cache_stage=$(mktemp -d "$cache_parent/.${cache_name}.tmp.XXXXXXXX")
    install -m 0755 "$root/build/bwrap" "$cache_stage/bwrap"
    printf '%s' "$revision" > "$cache_stage/revision"

    # Serialize only publication: concurrent jobs may build independently, while
    # the executable and its revision become visible together as one directory.
    exec {cache_lock_fd}> "$cache_parent/.${cache_name}.lock"
    flock "$cache_lock_fd"
    if cache_is_valid "$cache"; then
      rm -rf -- "$cache_stage"
      cache_stage=
    else
      if [[ -e $cache || -L $cache ]]; then
        cache_displaced=$(mktemp -d "$cache_parent/.${cache_name}.old.XXXXXXXX")
        mv -T -- "$cache" "$cache_displaced/cache"
      fi
      mv -T -- "$cache_stage" "$cache"
      cache_stage=
      if [[ -n $cache_displaced ]]; then
        rm -rf -- "$cache_displaced"
        cache_displaced=
      fi
    fi
    flock -u "$cache_lock_fd"
    bwrap=$cache/bwrap
  fi
fi
sudo -n install -m 0755 "$bwrap" /usr/local/bin/bwrap
printf 'MANIFOLD_TEST_BWRAP=/usr/local/bin/bwrap\nMANIFOLD_TEST_STATIC_BUSYBOX=/bin/busybox\n' >> "${GITHUB_ENV:?}"

# The proof uses unprivileged user namespaces, not host-root jobs. Ubuntu's optional
# AppArmor-wide restriction otherwise rejects unshare before the proof can start.
# This host setting is changed only on the disposable hosted runner, never locally.
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo -n sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
