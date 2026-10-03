# 0055 — CodeMirror 6 binds the existing collaborative text

Date: 2026-09-29
Status: accepted
Ratified: CodeMirror 6 selection and the full text/document split are recorded in #263; this record discharges the dependency decision required by ADR 0023 §6.

The living specification is [Dependency decisions](../CONTRACTS.md#dependency-decisions).
This is the editor dependency decision, not permission to replace the document plane or
skip the identity-preserving ownership migration required by [#263](https://github.com/atyrode/manifold/issues/263).

## Context

`core.notes` currently implements editing with a textarea, a hand-maintained character diff,
and caret adjustment around a live room `Y.Text`. The text/document split needs the same
collaborative editor in a standalone document and in a borrowed canvas note. Keeping those
views consistent does not justify two editors, a second canonical text value, or another
synchronization provider.

[ADR 0023 §6](0023-plugin-topology.md#6-text-is-its-own-noun-coretext-and-corecanvasnote)
requires a dated editor decision before implementation. CodeMirror 6 is the selected editor;
Yjs remains the existing document-plane implementation, reached through `@manifold/scene`.

## Decision

Use the following exact runtime pins in the text plugin, with transitive versions retained
in the workspace lockfile:

| Package                | Version   | Responsibility                                                |
| ---------------------- | --------- | ------------------------------------------------------------- |
| `@codemirror/state`    | `6.7.6`   | Editor transactions and selection state                       |
| `@codemirror/view`     | `6.43.13` | Browser editing, rendering and accessibility surface          |
| `@codemirror/commands` | `6.11.1`  | Standard editing/navigation key bindings                      |
| `y-codemirror.next`    | `0.3.6`   | Bind the existing live `Y.Text`, including collaborative undo |

The binding's Yjs peer uses the existing `13.6.32` pin, not a second Yjs version or the
unstable Yjs 14 family. Application source continues to import Yjs through `@manifold/scene`.
The bindings and the scene engine must resolve the same Yjs implementation.

Use the upstream Yjs binding rather than implementing text/selection synchronization locally.
The live `Y.Text` is authoritative; CodeMirror's editor state is its editing projection.
Use one local collaborative undo history for this editor rather than layering CodeMirror's
independent history over the same changes. Preserve the existing document channel, authority,
bounds and reconnect behavior. No WebRTC/WebSocket provider, new persistence service, iframe
codec or React wrapper package is introduced by this choice.

The initial configuration uses the core packages and standard commands, not the broad
`basicSetup` aggregate or language packs. Syntax services can be evaluated when a concrete
consumer needs them. This is not a restriction on ordinary plaintext editing, selection,
clipboard, input-method composition, wrapping or accessible keyboard operation.

`core.text` remains first-party and in-realm. A serialized copy of a `Y.Text` is not a live
collaborative object, so moving the editor into the hardened frame boundary would not satisfy
this decision. Canvas notes borrow the same editor and document rather than owning another
text implementation.

## Alternatives and maintenance cost

- **Keep the textarea binding.** This adds no package, but retains bespoke caret, composition,
  selection, undo and multi-edit translation code. Those are editor concerns with maintained
  library implementations, not manifold-specific policy.
- **Monaco.** Its IDE-oriented services are not required for the shared text surface. Taking
  that larger editor and another collaboration integration would add maintenance without a
  demonstrated consumer requirement.
- **Hand-bind CodeMirror.** Rejected: `y-codemirror.next` already translates CodeMirror changes
  to Yjs operations and preserves relative selections. Recreating it would be a second library
  implementation rather than a smaller manifold feature.
- **Upstream development `@y/codemirror`.** Rejected for this change. Upstream explicitly marks
  its current main branch as the unstable Yjs 14 integration and recommends the stable
  `y-codemirror.next` package for Yjs 13 users.

All four selected packages are MIT-licensed. Their versions and dependency/peer declarations
were inspected in the npm registry; the stable binding's exact source was inspected rather
than treating its development branch as the released API. Package unpacked sizes are not
claims about emitted browser bytes: the repository's build/budget checks must measure the
actual integration. Upgrades retain the same dependency, compatibility and consumer-proof duties.

## Verification obligations

This decision is not runtime acceptance. Before shipping, exercise the actual mounted editor,
including two-browser and SDK convergence, reconnect/restart, independent local undo, Unicode,
selection, clipboard and input-method behavior, read-only/disabled transitions and cleanup.
The stable binding uses its own transaction-origin object; the SDK must transmit its edits and
classify their provenance correctly without rewriting the binding or adding an alternate writer.
Observe the real standalone, canvas-note and manager surfaces and inspect their screenshots.
The full identity/reference/grant/history/rollback migration acceptance remains separate and
mandatory; an editor demonstration cannot substitute for it.

## Sources

- [CodeMirror system guide](https://codemirror.net/docs/guide/): modular core, transactions and editor projections.
- [Stable Yjs binding repository guidance](https://github.com/yjs/y-codemirror.next): stable Yjs 13 versus development Yjs 14.
- [`y-codemirror.next` 0.3.6 binding source](https://github.com/yjs/y-codemirror.next/blob/51ffef1045423ee4f9f56ca304e3e4d0b7028120/src/index.js) and [transaction origin](https://github.com/yjs/y-codemirror.next/blob/51ffef1045423ee4f9f56ca304e3e4d0b7028120/src/y-sync.js).
- npm manifests: [state 6.7.6](https://registry.npmjs.org/@codemirror%2fstate/6.7.6), [view 6.43.13](https://registry.npmjs.org/@codemirror%2fview/6.43.13), [commands 6.11.1](https://registry.npmjs.org/@codemirror%2fcommands/6.11.1), [binding 0.3.6](https://registry.npmjs.org/y-codemirror.next/0.3.6).
