# 0022 — Hosting posture: self-hosted software, and the operator's instance is one deployment of it

Date: 2026-09-02
Status: **ACCEPTED — operator-ratified constraint, 2026-09-02.** Issue #173 is the work this
record obliges; `verify:axioms` S17 is its enforcement.

## Context

manifold ships as a self-hosted hub: `docs/SELF-HOST.md` is the front door, `compose.yaml` on any
box with a DNS record is the install, and the flake's `manifold-server` is the NixOS shape of the
same process. Until this record the only running deployment was the operator's — a docker-compose
stack built by hand on one host from a runbook — and the operator is moving that instance to a
hosted provider (Clever Cloud, sanctioned as the hosting fallback by atyrode/dotfiles ADR 0008
under its "no provider is load-bearing" exit test).

A move like that is where a self-hosted project quietly stops being one: a provider's config
directory appears, an env prefix leaks into the entrypoint, the image grows a port the provider
likes, the release workflow learns to deploy exactly one instance, and a year later "self-hosted"
means "runs where the maintainer runs it". The operator ruled the constraint out loud before the
first line was written: the tree must stay hostable anywhere, by anyone, with no provider in the
way, and Clever Cloud must merely be how HE happens to host it.

The move also needs something the tree did not have: a way to keep the SQLite store alive on a
host with an ephemeral disk. That is a real self-hosting feature (a backup that is continuous
rather than a nightly `tar`), and the only acceptable form of it is one every self-hoster can use.

## Decision

1. **The tree ships provider-neutral artifacts, and only those.** Source plus `compose.yaml`; a
   per-tag image at `ghcr.io/<owner>/<repo>:<tag>` published by the release workflow under the
   repository's own namespace, so a fork publishes its own; the flake's `manifold-server`. Every
   knob is `MANIFOLD_*` (`docs/CONTRACTS.md` §Ports and env), the replication target is any
   S3-compatible endpoint, and the image listens on 7777 whatever the host prefers. There is no
   `latest` tag, ever: a deploy names a version, or it is not a deploy.
2. **Litestream 0.5.16 is admitted under invariant 8 as an OPTIONAL binary in the image.** One
   statically linked Go binary, fetched at image build from its GitHub release and pinned by
   sha256 for x86_64 and arm64, inert unless `MANIFOLD_REPLICA_BUCKET` is set — in which case
   `infra/entrypoint.sh` restores `<data>/manifold.db` from the replica when the file is absent
   and runs the server under `litestream replicate`. It is "boring, small, pinned" on all three
   counts. The alternative — replication inside the server process — would be a second write path
   to SQLite beside `bun:sqlite`, which is the one thing a WAL-shipping replicator must never share
   an author with. Without the bucket variable the entrypoint is byte-for-byte the old
   `bun packages/server/src/main.ts`; a self-hoster who never reads about replication pays nothing
   for it.
3. **The operator's instance is exactly one file, and it is the only file allowed to name a
   provider.** `.github/workflows/deploy-hub.yml` subscribes to the Release workflow through
   `workflow_run`, is inert unless the repository variable `CLEVER_HUB_APP_ID` exists (a fork
   never runs it), and holds every provider-specific verb. The provider's own configuration —
   its `CC_*` variables, the bucket, the DNS record — lives on the provider, never in the tree.
   `verify:axioms` S17 fails the gate on a provider noun or its env prefix anywhere else that a
   self-hoster ships or runs: `Dockerfile`, `compose.yaml`, `flake.nix`, `infra/**`, `packages/**`,
   `scripts/**`, `.github/workflows/**`. The exemption list is that one path and does not grow;
   a hit is reworded, never allow-listed.
4. **`scripts/release.ts` stays one command and stays neutral.** It waits for whatever workflows
   the release triggered downstream, by event kind rather than by name, so "release, then the
   hub is deployed" holds for the operator without the script knowing there is a hub.

## Alternatives rejected

- **A provider config directory or a provider-specific Dockerfile.** The first line of every
  such directory is the first line of the drift described above. The stock image with one
  port variable set on the provider side is the whole integration.
- **Zero-downtime deploys.** They keep the old instance running while the new one starts, which
  puts two writers on one SQLite replica. Twenty to forty seconds of downtime per deploy is the
  price of one writer, and it is paid on purpose.
- **Deploying the operator's instance from `release.yml`.** It would make the shipped workflow
  know a provider, and it would make a fork's release fail on the operator's secrets.
- **Documenting the posture without enforcing it.** Two operator-ratified constraints already
  have gate rungs (invariants 12–16); a third one that lived only in prose would be the one
  that eroded.

## Revisit when

- A second operator-run instance exists (then the one-file rule needs a per-instance shape).
- The hub returns to the workshop as a NixOS service from `packages.manifold-server` plus
  `litestream restore` (atyrode/dotfiles ADR 0008 step 5) — the exit path this record is
  designed to keep open.
- Litestream's `-if-replica-exists` / `-if-db-not-exists` restore semantics change across a
  version bump: the entrypoint's first-boot contract depends on both.
