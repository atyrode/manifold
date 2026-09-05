# Admit Radix Popover as the behavior engine of the ui stdlib's one popover

Date: 2026-09-01
Status: accepted
Ratified: extends 2026-08-31-radix-behavior-primitives.md

## Context

The 2026-08-31 decision pinned exactly two Radix packages (Collapsible, ScrollArea) and
closed the set: "no other Radix package is admitted without its own stated need." The F10
inspector wave (#131 item 7) states the need: the pinned card grows clickable content — a
door's generated argument form (#128) is the first — and "a small dismissable layer beside
this trigger" is a positioning-and-focus interaction system with the same many-failure-mode
profile that admitted the first two: collision flipping at viewport edges, outside-press and
Escape dismissal that respects other layers, focus return, ARIA `aria-haspopup`/`expanded`
wiring, and portal stacking. A hand-rolled positioner would be the third bespoke copy of
edge math the inspector already carries once (`placedAt`), growing toward a second layering
system (invariant 14 applied to floating chrome).

## Decision

Pin one more package in `@manifold/plugin`:

- `@radix-ui/react-popover` **1.1.20** — behavior engine of `Popover`
  (`packages/plugin/src/ui/popover.tsx`), pinned at the same version line as its two
  sibling primitives, which share their internals with it.

The Radix set is now exactly three, and the closure rule stands unchanged: the next Radix
package needs its own dated need.

## The supersedeability contract (unchanged)

Everything the 2026-08-31 record promises holds for this component: no Radix type or
component crosses `PopoverProps` (the trigger is a plain `ReactElement`, sides and aligns
are spelled as string literals), plugins see only `@manifold/plugin/ui` (S2), and what an
adopter may rely on — the portaled `popover__content` class, `data-state` hooks, standard
dismissal — is written in the component's doc comment. Swapping the engine out is a change
to one file and no call site.

## Why this beats boring local code

The inspector's own `placedAt` is the honest baseline: 10 lines that clamp a box to the
viewport, correct until the box needs to flip sides, trap no focus, dismiss on nothing,
and say nothing to a screen reader. Each of those is a small patch away, and the sum of
those patches is a floating-ui re-implementation owned by a debug plugin. The pinned
package is narrow, styles nothing beyond measurement, and is removable without changing
any adopter.

## Consequences

- `packages/plugin` gains one exact-pinned dependency; upgrades stay deliberate.
- Layered chrome gains a standard: a plugin that needs anchored floating content composes
  `Popover` and never learns which engine positions it.
