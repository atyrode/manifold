# 0049 — Operator-declared read-only anchors

Date: 2026-09-24
Status: accepted
Ratified: 2026-09-24, issue #839's triaged technical scope

## Context

A plugin location resolved only from six built-in anchors, `home`, `data`, `state`, `cache`,
`config` and `runtime`. The enum was closed in the machine declaration and in the owner
configuration, and the native module roots all six in Manifold's own storage
(`/var/lib/manifold-workload/*` and the `runtime` tmpfs). A governed job therefore could not read
a host directory outside that storage, such as an agent harness's session tree in the operator's
own home, without first copying it into the workload home. Babel's `archive` operation needs
exactly that read on every machine it backs up.

Three constraints shape the answer. ADR 0033 holds that raw paths are not public grants and that
adjacent authentication files are never implied grants. Anchors are already a reviewed, pinned
resource (ADR 0036), but the pin was an inode identity, not a path, so a review could not show
what it approved. And a node that protects `/home` to hide an enrollment token kept in a home had
no coherent way to expose one subtree beneath it.

## Decision

### 1. An open, operator-named, read-only anchor namespace

A location may name `anchor: "operator.<name>"`, where `<name>` is 1–63 lowercase letters,
digits or inner hyphens. The set is open: each machine's operator declares which host directory a
name presents, and names describe what they expose, so several plugins can share one anchor under
their own consents. Every string-keyed resource path — requirements, inventory, bindings, review
rows and refusals — works unchanged, and a machine without the anchor reports the existing
`anchors_unavailable` for the operations that read it.

Operator anchors are read-only by construction. The declaration schema refuses `write`, `create`
and `managed` on them, and the owner refuses non-read access again at resolution
(`operator_anchor_read_only`). `components: []` names an operator anchor's directory whole, so an
operator can expose exactly one subtree and nothing around it; built-in anchors and `kind: "file"`
keep at least one component.

The owner configuration gains `operatorAnchors: { "operator.<name>": { path, source?, readOnly:
true } }`, at most 32 entries. At startup the owner holds each anchor, or logs
`operator_anchor_unavailable` with `operator_anchor_absent`, `operator_anchor_not_read_only`,
`operator_anchor_overlaps_protected` or `operator_anchor_unopenable`. One unavailable anchor never
stops the owner and never falls back to another directory.

### 2. Read access through root-made, read-only, idmapped views (D1)

The native module presents each declared directory to the `manifold` account as a non-recursive
bind at `/run/manifold-anchors/<name>`, mounted `ro,nosuid,nodev,noexec,nosymfollow` and idmapped
so that the source owner's uid and gid appear as `manifold`'s. A root oneshot,
`manifold-operator-anchors.service`, makes the views before the owner starts. It refuses a source
with a symbolic-link component, one that is not a directory, one owned by root or `manifold`, one
that fails containment on its real path, and any bind that lacks a promised option, and it never
leaves a bare mountpoint. The owner additionally requires the held view's own mount to be `ro`:
through the idmap `manifold` owns every file it reads, so only the mount stops it from writing
the operator's files.

The source's owner, mode and ACLs never change, and `manifold` gains no traversal of the
directories above it. Files the operator creates later with mode 0600 are readable through the
view with nothing re-applied.

### 3. `protectedDirectories` keeps descriptor identity (D2)

A view may present a subtree beneath a protected directory, never a directory that is or contains
a protected directory, the enrollment token, a service credential source or Manifold's own
storage. A view's ancestry is `/run/manifold-anchors`, so the owner cannot see that a view
presents something beneath `/home`; the module's evaluation assertions and the root helper are
the enforcement point for what a view may present, and the owner adds
`operator_anchor_overlaps_protected` for anything it can see. A node that protects `/home` keeps
it protected.

### 4. The review names the host path, and the pin binds it

Owners advertise `anchorDefinitions: { name: { source, readOnly: true } }` only for held operator
anchors, so every other inventory is byte-identical. Root describe and deployment review return
it; non-root describes omit it. Review rows for operator anchors carry `source`, and Native
Plugins renders every location on one as `Host path <source>[/<components>] · read-only`. A row
without an advertised definition is `resource_evidence_unknown`: a disconnected review may reuse
an immutable promoted pin, but a pin alone carries no path, so an operator anchor is never
approved blind.

The operator-anchor pin digests `{ device, inode, path, source, readOnly: true }` of the held view.
It omits the mount id that built-in pins include, because the view is re-created every boot, and
the owner re-checks the read-only mount on every refresh instead. Changing what an anchor
presents, or recreating its source directory, is a new pin, and admission refuses
`anchors_revision_changed` until a new review is applied. Built-in pins and review digests are
unchanged.

### 5. Reading an operator anchor always requires resource bindings

An operation that reads an operator anchor requires reviewed resource bindings whether or not
its machine half sets `requiresResourceBindings`, both at direct installation
(`resource_bindings_required`) and at admission. Otherwise a manifest that omitted the flag would
get unpinned access to a host path its operator never saw in a review.

### 6. Owner RPC 40, capability `operatorAnchors`

The capability is additive and takes owner RPC 40. Versions 38 and 39 are reserved by open drafts
and are not accepted, so the acceptance set is `{34, 35, 36, 37, 40}`. Because `jobOwnerSupports`
compares versions with `>=`, any later capability needs a version above 40. Older owners never
receive an operator-anchor declaration: the operation that reads one is refused
`operator_anchors_protocol_unsupported` and projected out of that owner's installation together
with its operator-anchor locations, while every other operation stays byte-identical, following
the bound-inputs pattern.

### 7. Writable operator anchors do not exist (D8)

`readOnly` is the literal `true` in the owner configuration and must be `true` in the native
option. No consumer needs a writable operator anchor; introducing one requires its own record.

### 8. One term: `operatorAnchors` (D9)

The native option is `services.manifold.execution.operatorAnchors.<name> = { path; readOnly =
true; }`, not `execution.anchors`. The option, the owner configuration field and the manifest's
`operator.` prefix are one term, and built-in anchors remain "anchors" without qualification.

## Refused alternatives

**Repoint `home` at the operator's home.** It grants write as well as read, turns every plugin's
workload-home location into the operator's real home, and collides with the `manifold` account's
own home.

**One closed `operator` anchor rooted at one directory.** One root cannot express "these subtrees
and nothing between them"; exposing a home's session trees would put the whole home under
consent-only control and force traversal of it.

**Closed per-harness anchor names.** They put product vocabulary into the engine, and every new
consumer would need a Manifold release.

**POSIX ACLs on the operator's home.** An inherited default ACL is masked by the creating mode's
group bits, so a file a harness creates as 0600 gets an empty mask and reads fail with `EACCES`;
an archive would seal incomplete snapshots unless ACLs were re-applied before every run, racing
the harness. ACLs also need `manifold` to traverse the home, which makes every world-readable file
beneath it readable by the service account.

**A FUSE re-export such as `bindfs --force-user`.** It adds a daemon and a userspace hop for every
read, needs `allow_other`, and gives nothing a kernel view does not.

**Narrow `protectedDirectories` from `/home` to the token's directory.** Holding that directory as
an exclusion descriptor requires `manifold` to traverse the home and every directory down to it,
which is the widening the views avoid. Moving the token's custody out of `/home` would make
narrowing free, but it is a separate credential decision this change does not need.

## Consequences

- A plugin can read an operator-chosen host directory, read-only, through the ordinary location,
  consent (`locations:read`) and review path, and the review shows the exact host path.
- Adopting operator anchors needs a plugin kit and every target hub at or above this change,
  because older ones reject the manifest's unknown anchor, and an owner at RPC 40.
- The declared anchor set is retained owner configuration. A node that declares none produces a
  byte-identical owner configuration and no helper unit; changing the set uses drained owner
  maintenance, with the helper restarted between shutdown and owner start. The helper never
  unmounts lazily, so it cannot replace a view an owner still holds.
- A node needs idmapped bind mounts (Linux 5.12 or newer on a supporting filesystem) and a
  util-linux `mount` with `X-mount.idmap`.

## Evidence

- `packages/protocol/src/job-resources.ts` — `OperatorAnchorSchema`, `isOperatorAnchor`,
  `readsOperatorAnchor`, `anchorDefinitions`, and the binding requirement in `jobResourceRefusal`.
- `packages/protocol/src/jobs.ts` — the location and machine-half refinements, owner RPC 40, the
  `operatorAnchors` capability, `jobOwnerOperationRefusal` and `jobOwnerMachine`.
- `packages/protocol/src/job-owner-config.ts` — `operatorAnchors`.
- `packages/agent/src/job-runtime.ts` (startup holding), `job-locations.ts` (resolution),
  `job-resources.ts` (the pin and definitions), `job-files.ts` (`fdMountReadOnly`, `reopen`).
- `packages/server/src/job-deployments.ts` and `job-service.ts` — review rows, the
  unknown-evidence rule, protocol refusal and the install-time binding requirement.
- `packages/plugins/plugin-manager/src/runtime-deployment.tsx` and `runtime.tsx` — the host-path
  rows.
- `infra/native/module.nix` — the option, assertions and view helper; `infra/native/module-test.nix`
  — the `anchors` VM node and the evaluation refusals.
- Tests: `packages/protocol/test/jobs.test.ts`, `packages/agent/test/job-locations.test.ts`,
  `job-resources.test.ts`, `job-runtime.test.ts` (including the `[real-linux]` read-only view
  case `verify:jobs` selects) and `packages/server/test/job-service.test.ts`.

## Revisit when

- A consumer needs to write through an operator anchor (D8).
- A consumer needs per-file exclusions inside a view, or a view that carries nested mounts.
- The container profile needs operator anchors; the owner configuration field is generic, but
  this record wires only the native module.
- The enrollment token's custody moves out of protected homes, which would let
  `protectedDirectories` narrow without traversal (D2).
