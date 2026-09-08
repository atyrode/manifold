#!/usr/bin/env bash
# Explicit privileged setup for an ephemeral GitHub-hosted Ubuntu runner only.
# Production agents need neither this compiler toolchain nor this installation step.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]] || {
  printf 'install-runtime-ci: requires an ordinary user on an ephemeral GitHub-hosted runner\n' >&2
  exit 1
}
sudo -n apt-get update
sudo -n apt-get install -y gcc libc6-dev binutils busybox-static libcap-dev pkg-config meson ninja-build git

# Ubuntu's stock bubblewrap can predate FD binds. Build the immutable v0.11.2 commit,
# without setuid support, instead of weakening the runtime proof for old packages.
revision=1b80120ef26a28e065e67f89bfef873f13bdd317
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
meson setup "$root/build" "$root/source" --buildtype=release \
  -Dsupport_setuid=false -Dtests=false -Dman=disabled -Dselinux=disabled \
  -Dbash_completion=disabled -Dzsh_completion=disabled
meson compile -C "$root/build"
sudo -n install -m 0755 "$root/build/bwrap" /usr/local/bin/bwrap
printf 'MANIFOLD_TEST_BWRAP=/usr/local/bin/bwrap\nMANIFOLD_TEST_STATIC_BUSYBOX=/bin/busybox\n' >> "${GITHUB_ENV:?}"

# The proof uses unprivileged user namespaces, not host-root jobs. Ubuntu's optional
# AppArmor-wide restriction otherwise rejects unshare before the proof can start.
# This host setting is changed only on the disposable hosted runner, never locally.
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo -n sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
