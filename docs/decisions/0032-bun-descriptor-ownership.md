# ADR 0032: Bun 1.4.2 preserves borrowed descriptor ownership

Date: 2026-09-08
Status: accepted
Ratified: operator-authorized correction of the governed-runtime blocker; source changes only, not installation, release or deployment approval.

## Decision

Use **Bun 1.4.2** for the current Docker build and runtime stages and all Bun-pinned
CI, release, deployment and reusable plugin workflows. Raise `engines.bun` and the
source-run minimum to **>=1.4.2**. Compiled agents embed their compiler's Bun runtime;
Nix packaging must reject an older `pkgs.bun`, not silently produce a broken agent.

This updates the Bun version decision in [ADR 0001](0001-runtime-and-pins.md), without
rewriting that historical record or released changelog entries. Bun remains the same
runtime dependency. The public-source `noNewRuntimeDeps` convention is preserved:
there is no new library, runtime or alternate execution backend. A dated decision is
still warranted because the runtime's file-descriptor ownership is load-bearing.
The living requirement is [Dependency decisions](../CONTRACTS.md#dependency-decisions).
No protocol number, capability, permission rule or containment boundary changes.

## Failure and direct evidence

The governed runner lends already-open descriptors to children in extended numeric
`stdio` slots. Those descriptors remain the runner's resources: child cleanup must
not close them in the parent. Correct resource cleanup later closes each descriptor
once, by its owner. PR #429's blocker reproduced outside Manifold, without permission
evaluation, bubblewrap, cgroups, plugin loading or job admission.

The isolated reproduction opens `/dev/null` in the parent, passes its numeric descriptor
as child fd 3 to `Bun.spawnSync(["true"], { stdio: ["ignore", "ignore", "ignore", fd] })`,
and calls `fstatSync(fd)` after the child exits. Its decisive observations on 2026-09-08:

| Runtime                                      | Child result | Parent's borrowed descriptor after return               |
| -------------------------------------------- | ------------ | ------------------------------------------------------- |
| Bun 1.3.13                                   | exit code 0  | `fstatSync` fails with `EBADF`                          |
| Official Bun 1.4.2, Ubuntu 24.04             | exit code 0  | `fstatSync` succeeds; the parent retains its descriptor |
| Bun 1.4.2, temporary Nix-loader-adapted copy | exit code 0  | `fstatSync` succeeds; the parent retains its descriptor |

The official `bun-linux-x64.zip` 1.4.2 archive was verified against SHA-256
`36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913`.
The temporary loader adaptation was a local probe, not a repository runtime patch,
installed-tool replacement or proposed deployment artifact. The ordinary Ubuntu run
provides the unmodified upstream-binary result.

### Upstream ownership evidence

The [Bun 1.3.13 subprocess bindings](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/api/bun/js_bun_spawn_bindings.zig)
retain `spawned.extra_pipes` as `subprocess.stdio_pipes` via `moveToUnmanaged()` and
call `subprocess.finalize()` before returning the synchronous result. In the matching
[subprocess implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/api/bun/subprocess.zig),
`finalize()` calls `finalizeStreams()`, which closes every valid POSIX descriptor in
`stdio_pipes`. The reproduction demonstrates that a caller-owned extended numeric
stdio descriptor reaches this cleanup: a successful child exit is followed by the
parent's `EBADF`. Retaining a borrowed descriptor in an owning cleanup list is the
runtime ownership defect, not evidence of a denied Manifold operation.

The [official 1.4.2 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2)
is selected because the direct ownership reproduction passes on that stable runtime.
This decision does **not** infer a first-fixed release, claim that an unexamined release
note names this bug, or extend the measured result to every platform and spawn mode.
Agent preflight and regression coverage exercise the required ownership behavior;
full governed-runtime and platform acceptance remain separate verification.

## Rejected alternatives

- **Suppress `EBADF` in Manifold:** hides the loss of a live parent-owned resource;
  descriptor reuse can make a later close affect a different resource. It does not
  restore ownership or containment correctness.
- **Duplicate, pad, reopen or special-case descriptors around Bun:** adds a local
  workaround for an upstream runtime defect and a second lifetime model. Use the
  stable runtime that preserves the existing ownership contract instead.
- **Change permission logic or fall back to a different executor:** the minimal
  reproduction has neither; weakening admission cannot repair descriptor ownership.
- **Keep 1.3.13 behind successful child exit checks:** exit code 0 is already observed
  in the failing reproduction and says nothing about parent descriptor survival.

## Packaging and operational boundary

Source pins do not update installed tools, running hubs, existing compiled binaries,
terminal hosts or fleets. Rebuild artifacts with the corrected runtime and verify the
actual governed-job path before claiming runtime acceptance; publication, deployment
and fleet activation retain their existing authorization boundaries.

The preview composition deliberately copies only `/app` from the application image.
Its Bun comes from the independently digest-pinned dotfiles development environment,
not from either application Docker stage. That environment must be rebuilt and published
with Bun >=1.4.2, followed by a reviewed `infra/previews/environment-image.txt` digest
update. This source correction does not invent a replacement digest or perform that
publication. The existing build-time and offline `engines.bun` checks refuse an older
environment before stopping a running preview. Preview CI uses the same real digest
and cannot be called green until that external prerequisite is satisfied.

The pinned Nix input must likewise supply Bun >=1.4.2 before Nix packaging can proceed.
The minimum assertion makes stale inputs fail explicitly. Updating that input and
revalidating any affected vendored-dependency hash are separate from changing source
pins; this correction does not generate a lock file or change an installed Nix profile.
Host-side preview helpers and live worktrees need the corrected runtime too; no source
change alone upgrades the host's `bun` executable.
