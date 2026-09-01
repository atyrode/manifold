/**
 * `@manifold/plugin/ui` — the PLUGIN-FACING STANDARD LIBRARY.
 *
 * Everything behind this subpath is neutral chrome MECHANISM: the glyph vocabulary, the one
 * titlebar a container node wears, the consumer half of the one notice ref, and this
 * device's published view-state store. Not one of them decides anything about a domain noun,
 * and every one of them is addressed by two parties that may not import each other — a floor
 * renderer and a plugin, or two plugins — which is the litmus that puts a thing here instead
 * of in the package that happens to use it first.
 *
 * The boundary against the other two entries of this package is a real one:
 *
 *   `@manifold/plugin`        the registry and the contracts. Platform-free, because the
 *                             SERVER composes through it.
 *   `@manifold/plugin/hooks`  the engine's own browser half — the carry/drop vocabulary, the
 *                             element host, polling — mechanism a plugin USES to participate
 *                             in an engine plane.
 *   `@manifold/plugin/ui`     mechanism a plugin uses to LOOK like manifold. Nothing here
 *                             touches the wire, a plane, or the composition.
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
 * THE keycap: one keystroke drawn as a key, and the one place `Mod` becomes ⌘ or Ctrl. Stdlib
 * because the composed key table is the ENGINE's read, so more than one surface prints it.
 */
export { KeyCap, keyCapLabel, type KeyCapProps } from "./keycap.tsx";
export {
  NodeTitleBar,
  TITLEBAR_ACTIONS_CLASS,
  type MaximizeControl,
  type NodeTitleBarProps,
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
/**
 * THE tile tree and its drop chrome. One renderer for every tile layout in the product — the
 * workspace shell's own panes, a composition's leaves, a portal portal's preview — because
 * "one tree vocabulary everywhere" is a ratified decision (D2) and a second tile renderer
 * would be a second answer to what a divider drag means.
 */
export {
  PORTAL_TREE_CLASSES,
  COMPOSITION_TREE_CLASSES,
  TileTree,
  WORKSPACE_TREE_CLASSES,
  type TileTreeClasses,
  type TileTreeProps,
} from "./tile-tree.tsx";
export { TilePreviewOverlay, type TilePreviewOverlayProps } from "./tile-preview-overlay.tsx";
export { TileZoneDebug, toggleZoneProbe } from "./tile-zone-debug.tsx";
export {
  NoticeContext,
  useNotice,
  type NoticeApi,
  type NoticeLifetime,
  type NoticeOptions,
} from "./notice.ts";
export {
  currentVantage,
  setVantage,
  subscribeVantage,
  toggleArranging,
  useVantage,
  type Vantage,
} from "./vantage.ts";
/**
 * THE handoff between a surface that LISTS a key and the one that EDITS it. Same litmus as
 * the store above and a different lifetime: a rebind request is consumed and gone, so it is
 * device-local memory rather than published view state (`./rebind.ts`).
 */
export {
  clearRebindRequest,
  currentRebindRequest,
  requestRebind,
  useRebindRequest,
} from "./rebind.ts";
