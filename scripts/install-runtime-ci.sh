#!/usr/bin/env bash
# Explicit privileged setup for an ephemeral GitHub-hosted Ubuntu runner only.
# Production agents need neither this compiler toolchain nor this installation step.
#
# Two invocations now need this: the jobs proof and the browser proof run as separate CI jobs,
# so the bubblewrap build below would be paid twice per PR on top of once per run. It is a
# fixed upstream commit built with fixed options, so it is cached instead: set
# MANIFOLD_BWRAP_CACHE to a directory the workflow restores and saves, and a hit skips both
# the source build and the build-only half of the apt set.
#
# The cache is trusted only as far as it has to be. The file name carries the pinned revision,
# so a binary built for any other revision can never be served; the workflow keys the cache on
# that revision and the runner image with NO restore-key prefix, so a near-miss rebuilds rather
# than silently accepting an older binary; and verify-runtime.sh re-probes whatever lands here
# for setuid bits and for the required --bind-fd/--seccomp/--block-fd options before trusting
# it, exactly as it does for a freshly built one.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]] || {
  printf 'install-runtime-ci: requires an ordinary user on an ephemeral GitHub-hosted runner\n' >&2
  exit 1
}

# Ubuntu's stock bubblewrap can predate FD binds. Build the immutable v0.11.2 commit,
# without setuid support, instead of weakening the runtime proof for old packages.
revision=1b80120ef26a28e065e67f89bfef873f13bdd317
cache_dir=${MANIFOLD_BWRAP_CACHE:-}
cached=""
if [[ -n $cache_dir && -x "$cache_dir/bwrap-$revision" ]]; then
  cached="$cache_dir/bwrap-$revision"
fi

# What the proofs need on every run, cache hit or miss: cc to build the static probes,
# readelf (binutils) to prove they are static, a static BusyBox as the sandbox's only
# userland, and libcap for the bubblewrap binary itself.
runtime_packages=(gcc libc6-dev binutils busybox-static libcap2)
# What only the bubblewrap build needs. Skipped entirely on a cache hit — this is the
# expensive half of the apt step.
build_packages=(clang-18 pkg-config meson ninja-build git libcap-dev)

sudo -n apt-get update
if [[ -n $cached ]]; then
  printf 'install-runtime-ci: reusing cached bwrap %s\n' "$revision"
  sudo -n apt-get install -y "${runtime_packages[@]}"
  sudo -n install -m 0755 "$cached" /usr/local/bin/bwrap
else
  sudo -n apt-get install -y "${runtime_packages[@]}" "${build_packages[@]}"
  root=$(mktemp -d "${RUNNER_TEMP:?}/manifold-bwrap.XXXXXXXX")
  trap 'rm -rf -- "$root"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
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
  sudo -n install -m 0755 "$root/build/bwrap" /usr/local/bin/bwrap
  # Deposit it for the next run only after the build succeeded, under the revision it was
  # built from. Written unprivileged: the cache belongs to the workflow, not to root.
  if [[ -n $cache_dir ]]; then
    install -D -m 0755 "$root/build/bwrap" "$cache_dir/bwrap-$revision"
  fi
fi

printf 'MANIFOLD_TEST_BWRAP=/usr/local/bin/bwrap\nMANIFOLD_TEST_STATIC_BUSYBOX=/bin/busybox\n' >> "${GITHUB_ENV:?}"

# The proof uses unprivileged user namespaces, not host-root jobs. Ubuntu's optional
# AppArmor-wide restriction otherwise rejects unshare before the proof can start.
# This host setting is changed only on the disposable hosted runner, never locally.
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo -n sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
