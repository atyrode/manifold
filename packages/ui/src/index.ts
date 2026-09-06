/**
 * `@manifold/ui` — THE DESIGN SYSTEM: how a thing LOOKS like manifold.
 *
 * The third of three named layers (ADR 0025 §8, issue #240). `@manifold/protocol` and
 * `@manifold/sdk` are the SDK — talking to the hub. `@manifold/plugin` is the engine API —
 * being a plugin: HostServices, hooks, tile geometry, projection. This package is the
 * components, the tokens and the motion and layout rules the shell, every `core.*` panel and
 * every mod render with, so that one component set exists and the shell is built on the same
 * toolkit a mod imports (the precedent is Unity UI Toolkit and Unreal Slate: the editor is
 * built on the toolkit mods use). Nothing here touches the wire, a plane, or the composition,
 * and nothing here imports the engine: the dependency runs the other way, the engine's own
 * tile renderer wears these glyphs like any plugin does.
 *
 * Components are OPTIONAL; contracts are not. Tile geometry, D4′ disable semantics and
 * `data-action` come from `@manifold/plugin` whether or not a panel paints with `<Stack>`.
 *
 * TOKENS ARE THE THEMING SEAM. `styles.css` is the ground — the reset, the type and colour
 * ground, the CSS variables two owners read — so a surface that uses them coheres for free
 * and a surface that sets its own under its root diverges on purpose. The gate's S13 keeps
 * every family here painted from here and nowhere else.
 *
 * Being a standard library, not a component kit, has one consequence worth stating: a plugin
 * extends this chrome by passing nodes into its slots (`icon`, `middle`, `extraActions`), never
 * by growing a component's prop union — so re-shaping the titlebar or re-drawing the whole icon
 * set stays a change to one file and no call site. Where the VOCABULARY a slot names is itself
 * open the type is open with it: item kinds are the floor's five plus every element type a
 * manifest contributes, so `ItemIcon` takes a plain kind string, because a closed union at this
 * edge was the floor claiming to know a set only the assembly knows. `ControlKind` stays
 * closed — closed to ADDITIONS, not to callers, since a plugin is expected to name the engine's
 * verbs and forbidden to grow the union — and that contrast is the rule rather than an
 * exception to it.
 */
import "./styles.css";
export {
  ControlIcon,
  ItemIcon,
  RemoteCursorIcon,
  type ControlKind,
  type IconProps,
} from "./icons.tsx";
/**
 * THE keycap: one key label drawn as a key. Which words a keystroke wears — what `Mod`
 * becomes on this keyboard — is the engine's read (`keyCapLabel`, `@manifold/plugin/hooks`);
 * this is the box.
 */
export { KeyCap, type KeyCapProps } from "./keycap.tsx";
export {
  NodeTitleBar,
  TITLEBAR_ACTIONS_CLASS,
  type MaximizeControl,
  type NodeTitleBarProps,
  type TitlebarDragProps,
} from "./node-titlebar.tsx";
/**
 * The row vocabulary: THE chip (a bordered token that is a button exactly when it is
 * handed an `onClick`, and an inert span otherwise — one box either way, so the two forms
 * cannot drift apart the way hand-rolled rows already did) and THE key-value list (a
 * labelled reading of one thing, as the definition list it is). The stdlib owns the boxes;
 * an adopter tints them from its own family's sheet.
 */
export { Chip, type ChipProps } from "./chip.tsx";
export { KeyValueList, KeyValueRow, type KeyValueListProps, type KeyValueRowProps } from "./kv.tsx";
/**
 * THE LAYOUT ALGEBRA — six intrinsic boxes (Stack, Cluster, Sidebar, Switcher, Cover,
 * Frame) that answer "how do things sit together?" once, so no plugin body re-invents
 * flex soup. Start with {@link Stack} for vertical rhythm and {@link Cluster} for a
 * wrapping row; the module doc on `layout.tsx` teaches the whole algebra, including the
 * `min-width: 0` / gap / clamp() discipline every primitive enforces for you.
 */
export {
  Cluster,
  Cover,
  Frame,
  Sidebar,
  Stack,
  Switcher,
  type ClusterProps,
  type CoverProps,
  type FrameProps,
  type LayoutProps,
  type SidebarProps,
  type StackProps,
  type SwitcherProps,
} from "./layout.tsx";
/**
 * The behavior chrome: THE disclosure (a header that folds the body under it, keyboard
 * and ARIA included, body kept mounted while closed) and THE scroll container (vertical
 * only, slim overlay thumb, horizontal overflow refused by contract). Their behavior
 * engine is an internals decision — nothing Radix crosses these signatures
 * (docs/decisions/2026-08-31-radix-behavior-primitives.md).
 */
export { Disclosure, type DisclosureProps } from "./disclosure.tsx";
/**
 * The anchored layer: THE popover (adopter-owned trigger element, portaled content wearing
 * `popover__content`, standard dismissal). Its behavior engine is an internals decision —
 * nothing Radix crosses its signature (docs/decisions/2026-09-01-radix-popover.md).
 */
export { Popover, type PopoverProps } from "./popover.tsx";
export { ScrollRegion, type ScrollRegionProps } from "./scroll-region.tsx";
/**
 * THE motion primitive: FLIP over a stack of rows whose ORDER is data (a per-principal
 * arrangement, a roster's enabled set). Two parties that may not import each other stack
 * contributed rows and need the same measure-invert-play arithmetic, and
 * `prefers-reduced-motion` has to be honoured in one place rather than per adopter.
 */
export {
  FLIP_DURATION_MS,
  FLIP_EASING,
  FLIP_EPSILON,
  flipKeyframes,
  flipShifts,
  prefersReducedMotion,
  useFlipStack,
  type FlipOptions,
  type FlipRect,
  type FlipShift,
} from "./flip.ts";
