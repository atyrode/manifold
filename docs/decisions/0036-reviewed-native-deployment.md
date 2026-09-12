# ADR 0036: Reviewed native deployment approvals

Date: 2026-09-12
Status: accepted
Ratified: operator-authorized implementation in issue #503 and atyrode/code#161; not production promotion or unrestricted fleet installation.

## Decision

Extend the existing native installation authority with exactly reviewed, explicitly targeted
pending approvals. The normative behavior belongs to the governed machine jobs section of
[CONTRACTS.md](../CONTRACTS.md#governed-machine-jobs) and the plugin-facing interface belongs to
[PLUGINS.md](../PLUGINS.md#governed-jobs-and-continuous-streams). The existing plugin-manager
runtime inspector remains the operator surface. This decision does not define Manifold in
terms of the optional Code or OMP consumers that exposed the need.

The existing per-machine inspector already reviews resource pins, installs artifacts and
approves revision-bound execution rights. Native installation records already survive hub
restarts and replay to proved owners. Neither mechanism is missing. What is missing is a
headless, coherent review of several explicit destinations, and a safe record of an approved
resource-bound installation that cannot execute until its owner is available again.

A review binds the current manifest declaration, selected platform artifact, destination
identities, existing installation revisions, exact resource evidence and consent changes.
Selecting operations is separate from selecting installation targets: an empty operation
selection grants no execution, location, invocation or host-network consent. Named operations
project their concrete required rights through the existing native consent vocabulary; there
is no wildcard or product-specific authority.

Apply requires current root authority and an unchanged review. The retained approval contains
only an existing credential reference, attribution and bounded reviewed data, never a token
or owner key. A pending target is revalidated against current authority, enrollment, plugin
state, declaration, installation, resources and consent before the existing installation and
consent functions can run. Unknown resource evidence requires another review rather than an
automatically selected future binding. Re-enrollment and new machines never enter an approved
set. Changed declarations or resources do not become an automatic update policy.

Once effects are applied, native installation and consent rows remain authoritative. Readiness
requires the owner's installed acknowledgement and the selected operations' current readiness.
Cancelling an unapplied approval prevents further effects; it is not uninstall, purge or
revocation of an already committed installation. Existing revocation remains effective and is
never repaired by reapplying an old approval. An uncertain interrupted application is reported
for review rather than replaying authority-changing effects without evidence.

The public headless doors and the plugin-manager controls use the same schemas and authority
path. Product contexts receive only a capability-checked, plugin-bound destination progress
read; they do not acquire installation or consent administration. The existing journal records
action and deferred lifecycle attribution, and the existing native event topic notifies readers
to reread state. There is no second audit log or event queue.

## Alternatives

Keeping only per-machine browser-local review makes an operator repeat the same preparation
and offers no headless review boundary. Product-local installers or reconnect workers would
duplicate authority, retain credentials or invent a second runtime registry. Automatic fleet
membership and latest-version policies would approve destinations or bytes that were never
reviewed. These are rejected. The selected mechanism composes existing Manifold-specific
installation admission and owner lifecycle; it introduces no generic scheduler, retry library,
package manager or dependency.

## Foundation admission

The deployment protocol vocabulary joins the existing protocol pillar. The approval
coordinator joins the existing transport pillar and composes the native installation service.
Bootstrap circularity holds because a machine half cannot authorize or deliver the machinery
needed to install itself; an unavailable or disabled plugin cannot own the authority needed
to prepare or cancel its own pending installation. Neutrality holds because the coordinator
interprets only manifests, explicit machine identities, pinned resources and existing native
rights, with no provider, product or preferred-machine names. Arbitration holds because the
host alone can decide between current installation state, competing approvals, credential
revocation and owner evidence. Target selection and rendering remain in the existing plugin
surface, not in the floor.

This is implementation direction, not evidence that the gate, browser acceptance, deferred
lifecycle scenarios or deployment have passed. Those results belong to issue #503 and its
pull request. No axiom, machine-owner wire version or production compatibility set changes.
