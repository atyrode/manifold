# Use Radix headless primitives under the ui stdlib's behavior chrome

Date: 2026-08-31
Status: accepted

## Context

`@manifold/plugin/ui` grew a behavior layer: the one disclosure (the sidebar's section
shells fold) and the one scroll container (each section body scrolls itself). The
previous disclosure was a raw `<details>` — free ARIA, but no controlled state without
fighting the platform, and every future folding surface would re-wire `aria-expanded`,
keyboard handling and keep-mounted semantics by hand. Scrolling was per-callsite
`overflow-y: auto` with platform gutters. Correct disclosure and scroll behavior
(focus, ARIA wiring, pointer/keyboard parity, overlay scrollbars that do not steal
layout) is a small interaction system with many failure modes — the same argument that
admitted `@dnd-kit/react` (2026-08-26).

## Decision

Pin exactly two packages in `@manifold/plugin`:

- `@radix-ui/react-collapsible` **1.1.20** — behavior engine of `Disclosure`
  (`packages/plugin/src/ui/disclosure.tsx`)
- `@radix-ui/react-scroll-area` **1.2.18** — behavior engine of `ScrollRegion`
  (`packages/plugin/src/ui/scroll-region.tsx`)

Both are headless (no styles beyond one inline scrollbar-hiding rule), tree-shakeable,
and each maps to exactly one component in the stdlib. No other Radix package is
admitted without its own stated need.

## The supersedeability contract

Radix is an INTERNALS decision, and the boundary is enforced, not remembered:

- Radix is never re-exported. No Radix type or component appears in any
  `@manifold/plugin/ui` public prop signature — `Disclosure` and `ScrollRegion` speak
  plain React (`open`, `onOpenChange`, `header`, div attributes).
- Plugins see only `@manifold/plugin/ui`. S2's plugin-import allowlist is unchanged;
  a plugin importing `@radix-ui/*` directly is gate RED.
- What adopters may rely on is written in each component's doc comment (data-state
  hooks, body-stays-mounted, vertical-only scrolling) — the contract, not the engine.
  Swapping Radix out is a change to two files and no call site.

## Why this beats boring local code

A local `<details>` kept the platform's semantics but froze the chrome to what the
platform styles; a local scroll area is either the platform gutter (layout-shifting,
inconsistent) or a hand-rolled thumb with drag math, RTL, touch and wheel handling.
Both pinned packages are narrow, boring in the way that matters (behavior only), and
removable without changing any adopter.

## Consequences

- `packages/plugin` gains two exact-pinned dependencies and their small internals.
- The section shell's collapse is now controlled state owned by the shell, with the
  same keep-mounted semantics `<details>` had (`forceMount` + CSS hide).
- Upgrades are deliberate; the pins stay exact until re-evaluated.
