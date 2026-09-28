# 0053 — Real React reconciles into the bounded component vocabulary

Date: 2026-09-27
Status: accepted
Ratified: 2026-09-27, issue #259's pinned upstream reconciler decision

Completes ADR 0025's React-authoring direction within ADR 0016's optional hardening boundary.
The living specifications remain [CONTRACTS.md](../CONTRACTS.md#hardened-plugins),
[PLUGINS.md](../PLUGINS.md) and [REGISTRY.md](../../REGISTRY.md).

## Context

The page runs real React, while a hardened web contribution currently authors `UiNode` values
and receives named events. A second authoring language makes the installer’s execution choice
an application rewrite. Replacing the builders with JSX is not sufficient: component identity,
state, context, effects and cleanup must retain their React meaning across event round trips.

React's public hook functions do not provide an independent retained renderer. A static-markup
render followed by a captured state update and a fresh static render does not retain component
state. A handwritten hook engine would instead own React's private dispatcher contract and the
behavior it dispatches, including abandoned renders, effect lifetime and keyed identity.

## Dated invariant-8 verdict

| Candidate | Code and maintenance saved | Cost and boundary fit | Verdict |
| --- | --- | --- | --- |
| `react-reconciler` 0.33.0 | React owns component reconciliation, hooks, context, scheduling and effect cleanup; Manifold supplies the host adapter. | Upstream explicitly calls its renderer API experimental and does not promise ordinary React semver. Its published peer range is React `^19.2.0`, covering the existing exact `19.2.8` pin. The host configuration and upgrade proof remain ours. | Adopt an exact production pin, with matching `@types/react-reconciler` 0.33.0. |
| Shopify Remote DOM / `@remote-dom/react` | Supplies cross-realm tree transport, remote custom elements and host mappings. | Its documented model mirrors DOM elements, using an iframe or a DOM polyfill in a Worker. Manifold already owns a bounded component schema and correlated transport; adopting that DOM model would replace the isolation boundary rather than implement it. | Reject for this boundary. |
| Handwritten reconciliation and hooks | Avoids the additional package. | Requires private React dispatcher coupling or a different, React-like hook runtime, plus ownership of reconciliation and effect semantics. A closed output vocabulary does not make those semantics disappear. | Reject; supersedes the earlier hand-roll implementation choice. |
| React DOM server rendering | Reuses the installed React packages and emits markup. | Does not supply a retained interactive root or the component-frame representation, and markup is not an admitted guest output. | Reject. |

Primary sources: [React's custom-renderer README](https://github.com/facebook/react/tree/main/packages/react-reconciler),
[the published 0.33.0 package contract](https://registry.npmjs.org/react-reconciler/0.33.0),
and [Remote DOM's model](https://github.com/Shopify/remote-dom).
The dependency's unpacked package size is not a shipped-bundle measurement; actual artifact and
runtime costs belong to the implementation's measured evidence.

## Decision

1. A portable web contribution is one real React component implementation. In-realm it uses the
   page's React instance. In a Worker, its self-contained build uses one React instance shared
   with its reconciler and portable design-system components. A page-global module registry is
   not assumed to exist in the Worker.
2. The custom renderer emits the existing bounded, host-owned component tree and named event
   frames, not DOM, HTML, SVG markup, arbitrary attributes, CSS or remote object handles. Any
   vocabulary additions are enumerated protocol data. Unknown primitives or unsupported
   DOM-dependent component behavior refuse explicitly; a DOM shim is not a fallback.
3. Reconciliation preserves stable node identity. Only committed controls own callable event
   registrations. Removed controls, unmounted roots and retired Workers cannot retain event
   authority; effects and subscriptions are cleaned up with their actual React lifetime.
4. The normal, unrestricted in-realm authoring path remains available. Portable compilation is
   an artifact capability, not an author's demand for hardening and not permission to reject
   ordinary DOM-based mods. The installer or trusted bootstrap still selects execution mode.
5. `core.machines` is the real first-party parity subject, including its actual server handlers,
   inventory refresh, authority-sensitive actions, confirmation and blur disarm, refusal
   presentation, terminal creation, and lifecycle. A renamed demonstration or a browser-only
   run is not that proof.
6. Necessary host bridges remain narrow and producer-neutral. Caller/session bearers
   stay in the host; the authorized `enrollMachine` and `rotateMachineToken`
   results necessarily deliver a newly minted machine credential to the server
   handler that requested one. Serialized caller state is not authority. Mutating
   calls re-enter the existing mechanisms with live caller checks and the
   plugin's admitted ceiling; machine ids resolve against current host state.
   Async adaptation preserves atomic decisions rather than adding read-then-mutate
   races across RPCs. Raw stores and live service objects are not exported to guests.
7. Trusted first-party execution selection does not authorize reserved-namespace uploads.
   Ordinary installation continues to refuse `core.*` and `engine.*`. Any bootstrap bundle must
   be bound to the build's own registered definition and use the same isolate supervisor,
   dispatch admission, lifecycle and failure reporting as other hardened code.
8. The source-level `ui.*` builders retire only with full parity and migrated consumers. Older
   admitted compiled artifacts retain their declared compatible wire behavior; the source
   cutover does not silently invalidate persistent installations.

## Compatibility and proof obligations

The reconciler, React and type pins are reviewed together. An upgrade must exercise actual
Worker rendering and the same first-party browser interactions in both modes, including keyed
state, event return, effects, host-context changes, cleanup, stale callbacks and denied calls.
Unsupported or incompatible artifacts fail by name rather than executing a different runtime.

The host adapter neither broadens server authority nor repairs Worker egress confinement; those
remain separate contracts. Browser interaction and screenshot inspection, real isolated-server
behavior, bounded artifact/frame evidence and the selected repository checks are all required
before this implementation is complete. A green compiler or counter fixture does not discharge
the first-party acceptance requirement.

## Implementation record (issue #259)

The shipped source uses `react-reconciler` 0.33.0 over `UiNodeSchema`'s fourteen
closed kinds. One portable `ReactWebPluginDef` exports React panel/section
components via `defineWebPlugin`; packing links the in-realm page entry to the
shell's React and generates a separate self-contained `web.worker.js` from the
same source, sharing the kit's React with its reconciler. The public Button prop
is `data-action`, and Worker callbacks are committed-control registrations
over scalar event frames. `Stack`/`Cluster` map adaptive or bounded rem gaps
to the host-owned `box`. DOM and `react-dom` do not cross the Worker build.
The boundary does **not** confine Worker networking or origin storage
(ADR 0048 remains a proposal).

`core.machines` is the first-party parity subject. Its real server handlers
use six bounded fleet calls: `machines.inventory`, `machines.drain`,
`identity.enrollMachine`, `identity.rotateMachineToken`,
`identity.revokeMachine`, `identity.forgetMachine`. The host regrades the
current caller, published declaration and install ceiling and resolves
machine ids itself; it does not export raw machine or identity services.
Native is the bootstrap default. An operator may select that registered
definition with `MANIFOLD_HARDENED_PLUGINS=core.machines`; source/Docker
compiles the trusted artifact at boot, and the source-free Nix wrapper names
its build-time artifacts with `MANIFOLD_FIRST_PARTY_ARTIFACTS`. A failed
selection stops the boot by plugin name without native fallback; neither
artifact is an install row or an exception to reserved-namespace uploads.
Compatibility stays stamped: contract 9 carries portable React and bounded
fleet additions, while older admitted artifacts retain their own declared
frame behavior.

The source evidence covers real browser interaction in both modes (inventory,
events, confirmation/blur, refusals, terminal, enablement and Worker
retirement) and real-server isolated fleet dispatch/lifecycle. The packaged
verifier ran successfully on `x86_64-linux`: independent dependency rebuild,
ephemeral native and hardened packaged boots, exact pinned-artifact/Worker
checks, real fleet door/disable cleanup and fail-closed unknown/unsupported
selector checks. That proof does not execute macOS/arm64 packaged binaries,
activate the native machine owner or establish target-kernel containment.
No broader runtime or bundle-size measurement is asserted by this decision.
