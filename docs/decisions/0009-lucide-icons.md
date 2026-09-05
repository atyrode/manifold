# Use lucide-react as the one icon vocabulary

Date: 2026-08-29
Status: accepted

Addendum 2026-09-01 (#116): the CONTROL half is narrowed the same way, and in the opposite
direction from where the pressure came. `ControlKind` stays closed, but "closed" is closed to
ADDITIONS, not to callers: `ControlIcon` ships through `@manifold/plugin/ui` so a plugin's
chrome wears the same mark for the same verb the shell's does, and the discipline that keeps the
list the engine's own is on the NAME, not on the consumer — every kind is a neutral verb (or a
neutral noun for what pressing opens), so the list reads the same with every plugin in this
build replaced. Two kinds failed that and were deleted: `endTerminal` and `terminalTree` named
one plugin's object in the floor's vocabulary, and neither had a call site. `restart` stayed:
the word carries no object, and relocating it would have bought neutrality by forcing the
terminals plugin to hand-roll the wrapper this record exists to abolish. Added, for call sites
that were doing exactly that: `locked` (a control's refusal, drawn in the control's slot),
`assembly` (what a thing is composed of, as a list), `nesting` (reveal the level inside every
row, the bulk sibling of `disclosed`/`collapsed`, which is where `terminalTree`'s drawing went).
`core.pluginManager`, `core.index` and `core.machines` stopped importing lucide directly — the
index alone had fifteen call sites behind a local re-implementation of the one wrapper — and
`verify:axioms` S2 now refuses the import from any plugin package, so the decision's last clause
is a check rather than a habit: outside `packages/plugin/src/ui/icons.tsx`, no call site names a
lucide drawing.

Addendum 2026-08-31 (#69 wave F): this record is history and is not rewritten, but one clause of
the decision below has been narrowed. The ITEM half of the vocabulary is no longer a closed type:
`ItemIconKind` is deleted and `ItemIcon` takes a plain kind string, because item kinds are the
floor's five plus every element type a manifest contributes — a closed union at the plugin edge
had the engine claiming to know a set only the assembly knows, and it bound no plugin anyway,
since chrome here has always taken `icon: ReactNode`. An element contribution publishes no glyph,
so a kind this build holds no drawing for now wears one neutral element mark instead of borrowing
`core.notes`' sticky note. `ControlKind` stays closed, and that contrast is the rule: controls are
the engine's own verbs, items are a contributed vocabulary. Unchanged: one module, one pinned
dependency, and no call site naming a lucide drawing.

## Context

The web application answered "what does this object look like?" with three unreconciled
systems, and which one you got depended on which file painted the pixel:

- **Unicode box characters** in titlebars and carry ghosts — `▣` a terminal, `▤` a
  composition, `▦` a canvas, `□`/`❐` maximize/restore, `✕` close, `–` minimize, `•••` a row
  menu, `⌘` the session tree, `⠿` a drag grip, `⌄`/`›` disclosure, `✓`/`×` inline confirm,
  `●`/`○` liveness, `⟳` restart.
- **Hand-drawn inline SVG paths** — `SidebarIcon`, `TilesGlyph`, `EyeIcon`, `PowerIcon`,
  `TrashIcon`, plus the remote-cursor arrow copied verbatim into two renderers.
- **CSS pseudo-element shapes** — the pad dot, the folder icon and its flap, the section
  disclosure chevron, the empty-leaf square.

The costs were concrete rather than aesthetic. The same object wore a different mark in the
sidebar than in its titlebar. Unicode coverage is a property of the machine's installed
fonts, not of the app: U+26F6 (`⛶`) already had to be abandoned mid-implementation because it
rendered as tofu in headless Chromium here, and every remaining box character is one font
substitution away from the same fate. Weight, size and optical alignment were tuned per call
site (`font-size` on a glyph, `width`/`height` on an SVG, `border` on a pseudo-element), so
there was no single place to change how the application looks.

## Decision

Add `lucide-react`, pinned to the exact version `1.37.0`, and make ONE module the only place in
the tree that imports it. Call sites ask for manifold concepts —
`<ItemIcon kind="composition" />`, `<ControlIcon kind="park" />` — never for a lucide name, so
the drawing set is an implementation detail of one file and can be re-drawn without touching a
single call site. One wrapper applies 16px and stroke weight 1.75 by default and renders in
`currentColor`, so hover, focus and disabled states keep working through the colour the button
already sets.

That module was `packages/web/src/icons.tsx` when this was decided; the plugin conversion moved
it verbatim to `@manifold/plugin/ui`, because plugins draw manifold's chrome too and a plugin
may not import a floor module. The decision is unchanged — one module, one dependency, closed
vocabularies — and the registry in `REGISTRY.md` is where its current home is recorded.

Status stays out of the vocabulary: the machine pip, the running/exited tint and the
connection dot are live state (and, for a machine, an identity colour), which a stroke icon
cannot carry.

Per invariant 8, this is boring, small and pinned:

- **Boring:** an ISC-licensed SVG icon set, the default choice for React applications.
- **Small:** zero runtime dependencies, `sideEffects: false`, and every icon is a separate
  named export, so the bundler tree-shakes the set down to the icons actually imported. The
  whole sweep — 25 icons in, three glyph systems out — measured **+3.32 kB raw / +1.55 kB
  gzipped** of application JS and **−2.19 kB raw / −0.37 kB gzipped** of CSS, out of a 31 MB
  unpacked package.

## Alternatives rejected

- **Keep unicode glyphs.** Rendering depends on the platform's font stack, weights and
  baselines vary per glyph, and no amount of CSS makes `▣` and `▦` read as one family. The
  tofu incident with `⛶` was the second time this cost real implementation time.
- **Hand-roll one SVG set.** Perpetual drawing chores: every new affordance becomes a
  path-authoring task, and the ones already written (eye, power, trash, chevron) had drifted
  into three different stroke weights across three files.
- **A webfont icon set (Font Awesome and similar).** Reintroduces the font-loading failure
  mode this decision exists to remove, and ships the whole set rather than the used subset.

## Revisit when

Bundle cost becomes material (the tree-shaken subset outgrows a few tens of kilobytes), or
coverage fails — a concept manifold needs has no lucide drawing that reads correctly at 16px.
Either trigger is a change to `icons.tsx` alone.
