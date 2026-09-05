# Use cmdk for the command menu's list

Date: 2026-09-01
Status: accepted

## Context

`core.commands` (issue #129) puts one searchable menu over three registries the composition
already publishes: every composed action, every composed binding, every container in the index.
The projection — which rows exist, which are runnable, what a refusal says — is ours and is a
pure, tested module (`packages/plugins/commands/src/commands.ts`). What is left over is the
LIST, and a list like this is a small interaction system with many failure modes: incremental
filtering with a scoring function that ranks acronyms and gaps sensibly, arrow/Home/End
traversal that skips disabled rows, groups that appear and disappear as the query narrows,
`role="combobox"` over `role="listbox"` with `aria-activedescendant` following the highlight,
pointer and keyboard highlight agreeing, and scroll-into-view on traversal. That is the same
argument that admitted `@radix-ui/react-collapsible` and `@radix-ui/react-scroll-area`
(2026-08-31) and `@headless-tree/core` (2026-08-26): behavior we would otherwise re-derive
badly, once, in one plugin.

## Evidence

- **cmdk 1.1.1** — MIT, published 2025-03-14, 124 KB installed, four dependencies, all
  `@radix-ui/*` (`react-id`, `react-primitive`, `react-compose-refs`, `react-dialog`); three of
  the four were already resolved in this tree by the 2026-08-31 Radix record. React 19 is in its
  peer range. It is headless: it ships no stylesheet and marks its parts with data attributes
  (`[cmdk-item]`, `[cmdk-group-heading]`), which is what let the menu be skinned entirely from
  this repo's own palette. <https://github.com/pacocoursey/cmdk>
- **kbar 1.0.0** — MIT, the named fallback on #129, and rejected on a structural reason rather
  than a size one. kbar is not a list, it is a COMMAND FRAMEWORK: it owns an action registry
  (`useRegisterActions`), its own provider and store, a nested-action router, its own animation
  and its own priority model. Our action list is the composition — the roster the server
  publishes and the binding table the engine composes — so adopting kbar would mean maintaining
  a second registry of what a command is and keeping it in sync with the first, which is exactly
  the second door invariant 14 forbids. Its footprint follows from that ambition: 0.61 MB
  installed and five dependencies including `fuse.js` and `@tanstack/react-virtual`.
  <https://github.com/timc1/kbar>
- **Hand-rolled** — the third option, and the one this repo has been burned by: a list is easy
  to draw and hard to make behave. The specific failures are known and boring (highlight
  desynchronised between pointer and keyboard, disabled rows swallowing Enter, groups collapsing
  the wrong way as the query narrows, `aria-activedescendant` pointing at an unmounted id) and
  every one of them is a bug we would ship, find and fix in a package that has already shipped,
  found and fixed it.

## Decision

Pin exactly one package in `@manifold-plugin/commands`:

- `cmdk` **1.1.1** — the list behind `packages/plugins/commands/src/web.tsx`.

Nothing else in the tree may import it. No other plugin gets a command list of its own: there
is one menu, because there is one composition.

## The supersedeability contract

cmdk is an INTERNALS decision, on the same terms Radix is:

- **Never re-exported.** This package's public surface is `COMMANDS_BINDINGS` (engine
  `WebBinding` rows) and `CommandsOverlay` (a `WorkspaceOverlayProps` component). No cmdk type
  appears in either, and `packages/web/src/assembly.ts` never learns the library exists.
- **The rows are ours.** `composeCommands` returns plain data and is unit-tested with no
  renderer at all. cmdk receives `value`, `disabled` and `onSelect` and returns keystrokes.
  Swapping it for kbar — or for a hand-rolled list, if the trade ever reverses — is a change to
  one component and one stylesheet, and no test in `test/commands.test.ts` moves.
- **`Command.Dialog` is deliberately unused.** The surface is the platform `<dialog>` with
  `showModal()`, which is what `core.keys`' editor already is: one modal idiom, the platform's
  top layer, `::backdrop`, focus containment and Escape for free.

## Consequences

- One exact pin, and one transitively new Radix package (`@radix-ui/react-dialog`, with its
  dismissable-layer/focus-scope/portal internals). It arrives even though `Command.Dialog` is
  unused, because cmdk attaches `Dialog` to the exported `Command` object and a bundler cannot
  drop a property of a value the app holds. That is a measured cost, not a design choice.
- Measured against `origin/dev` at 5d410a5, one production `vite build` each:
  `1,219.99 kB → 1,262.97 kB` raw, `357.03 kB → 372.54 kB` gzip — **+15.51 kB gzip** for the
  library, the plugin and its projection together. CSS `+0.41 kB` gzip.
- Zero idle cost. The surface renders nothing while closed, and its index feed subscriber is
  `enabled: open`, so a closed palette holds no subscription, no timer and no request — the
  property `verify:budgets` exists to keep.
- The pin stays exact until re-evaluated.
