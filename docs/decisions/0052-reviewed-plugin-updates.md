# 0052 — Reviewed plugin families use the one installer

Date: 2026-09-27
Status: accepted
Ratified: 2026-09-24, issue #238's agent-ready full-flow scope after the common artifact retriever shipped

Implements ADR 0016's distribution follow-through and ADR 0025's version-coupling obligation.
[CONTRACTS.md](../CONTRACTS.md#hardened-plugins) and
[PLUGINS.md](../PLUGINS.md#reviewed-third-party-updates) are the living specification.

## Context

A single installed bundle already has a pinned replacement path, attenuated grants, managed
storage migrations and optional hardened execution. Repeating that door for a family cannot
make the family atomic: a later member may fail after an earlier member has committed. An
availability link also cannot stand in for consent to executable bytes whose permissions or
compatibility differ from the current installation.

Core code is compiled and verified with its Manifold distribution. Unpacked plugins have an
owning source/rebuild loop. Neither is a third-party bundle-feed consumer. Installed bundles
need a producer-neutral mechanism which observes availability without admitting code until an
administrator reviews it, using the existing outbound-fetch boundary rather than a new one.

## Decision

1. **Publisher metadata names pins, not executable authority.** A declared feed's first release
   is preferred; GitHub latest-release assets are an alternate metadata representation, accepted
   only with published SHA-256 digests. Every artifact, feed and external changelog traverses
   the existing bounded public-HTTPS or local drop-box reader. Remote metadata cannot name a
   local file. Discovery neither executes candidates nor changes grants.
2. **A review is an exact, expiring capability to attempt one replacement.** Root-only
   `engine.plugins.reviewUpdate` produces the complete family comparison and stores the verified
   bytes. Its digest binds the reviewing principal and credential, incumbent pins/grants/desired
   enablement/data/native evidence, candidates and expiry. `applyUpdate` accepts that digest and
   exact per-member consent for every growing capability ceiling. It consumes the review and
   re-proves authority and snapshot after awaits and immediately before commit.
3. **The existing installer owns the transaction.** Single installs and reviewed families share
   the same assembly mutex, staging, dependency ordering, migrations and rollback. Managed KV,
   SQLite images, migration metadata and installation rows commit as a group. A precommit failure
   restores the prior family and publishes no candidate roster. Previously dormant held code is
   never executed merely to roll it back. Arbitrary plugin hooks and external effects are outside
   the managed-state transaction.
4. **Approval does not erase other boundaries.** Existing withheld authority stays withheld;
   narrowing removes authority; governed capabilities never become ordinary grants. Desired
   enablement and hardening persist. Enabled native declarations cannot be replaced under this
   approval; unchanged declarations retain their installation identity and jobs. Core code
   remains release-owned and unpacked code remains source-owned.
5. **Known build drift is visible before execution.** Packs stamp protocol wire metadata; shared
   builds also record React/package versions. An incompatible wire version or React major is a
   named hold/refusal at boot/admission. Legacy missing metadata remains unknown. The review
   records current effective enablement separately from desired enablement so a held incumbent
   can be repaired without being mistaken for a stale review or an intentionally disabled row.

## Alternatives rejected

- **Automatic application after polling:** would admit changed code or authority without the
  required human/API review. Polling only publishes availability; application is a separate door.
- **One install call per member:** exposes partial families and makes migration rollback depend
  on callers undoing already-committed state. The group commit belongs inside the installer.
- **A parallel updater loader, fetcher or persistence layer:** duplicates the authority and
  recovery boundaries, and can disagree with ordinary install/boot behavior.
- **Unpinned GitHub downloads:** hashing downloaded bytes establishes only what was received,
  not the publisher's declared pin. Missing digests are a visible refusal.
- **Treating absent historical metadata as incompatible:** would quarantine bundles without
  evidence of a mismatch. Unknown remains explicit; known mismatch is held before execution.

## Consequences

Reviews are bounded, in-memory and short-lived; a restart, expiry, changed family or failed
apply requires a fresh review. Publisher failures remain visible on the installed row without
changing the working installation. Whole families include all installed dotted descendants;
updates may add descendants but cannot silently remove them. Changelogs are bounded UTF-8 text
and rendered escaped. The manager is one consumer of the same declared doors available to
other principals, not a separate privileged endpoint.
