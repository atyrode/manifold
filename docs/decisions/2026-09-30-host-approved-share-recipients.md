# Host consent bounds each share recipient and its ordinary tickets

Date: 2026-09-30
Status: accepted

## Context

Issue #412 closes the ambient cross-instance admission described by ADR0014's first wave: a guest's local `containers:read` admitted every local principal to the immutable share ceiling. Local and remote capabilities are different authority spaces; intersecting matching names would neither establish host consent nor express a deliberately narrower remote delegation. The host remains the authority over the shared node, while the guest owns its principal namespace.

A ticket is an ordinary host credential, not a second credential engine. Host approval must therefore bind both ticket issuance and its existing ordinary derivation/revocation paths. Retiring only the initial ticket while leaving authority derived through minting, Runs or terminal session agents would not withdraw the recipient.

## Decision

The normative behavior is **Sharing across instances** in [CONTRACTS.md](../CONTRACTS.md); the action schemas remain discoverable through the ordinary protocol/action plane.

Persist one share recipient relationship for the share's immutable guest origin and guest-local principal id. A proposal grants nothing. The share owner or root approves a selected subset through the existing `tokens:mint` attenuation and container-scope ladder, with durable actor/time provenance. Each subsequent issuance uses that active approval: omission requests its actual subset; an explicit request outside approval or share ceiling is refused rather than intersected or widened. A different principal/share cannot inherit approval.

Ordinary tickets carry their actual caps and finite expiry. Approval narrowing/removal changes durable admission before retiring related ordinary credentials/grants and fencing live sockets. Derived credential and child-share issuance retains exact source provenance in the existing authority mechanisms. Unrelated relationships survive. Removal is not a permanent principal tombstone; reapproval is explicit, and does not resurrect revoked credentials.

Schema migration creates no automatic approvals and fences legacy share-ticket material before admission. Instance peers using the ambient-admission protocol are refused rather than resumed through a compatibility bypass. Session/instance, persistent schema, native and renderer floors remain separate; held unreleased branches do not reserve candidate numbers.

## Ownership and plane

Recipient approval/removal is Action state: it depends on host authority unavailable to the guest, so `core.access` owns the three administration verbs through ordinary traced dispatch. A proposal is durable host relationship data, not presence or a collaborative document. Existing identity/grant persistence and instance transport enforce that data; no new floor file, provider, capability or generic policy engine is introduced.

The existing identity/caps, persistence and transport pillars retain their roles. Transport interprets neutral origins, principal identities, grant bounds and version negotiation, not a preferred application/plugin. The registry records the share recipient vocabulary and the changed host/guest ticket enforcement in those existing floor rows.

## Alternatives

Automatic full-share admission fails host consent. Intersecting local and remote cap names conflates authority spaces. A guest-admin allowlist cannot authorize the host's node. An additional sharing evaluator, credential kind or hidden administration endpoint duplicates the existing action and grant machinery. Permanently revoking the synthetic host principal makes later explicit reapproval impossible and widens removal beyond the affected credentials.

## Evidence boundary

Acceptance exercises actual disposable host/guest instances and ordinary discovered actions: pending refusal, independent principals/shares, a narrower remote subset, wider-request refusal, scene/PTY projection, live narrowing/removal/reapproval, finite bearer/session admission expiry and share-wide revoke. Persisted legacy-state migration and repeated start must prove fail-closed admission without unrelated data loss. Derived ordinary mint/Run/session and child-share authority must be fenced by the originating relationship. These source/runtime proofs do not authorize persistent-instance credentials, fleet/native activation or production changes.
