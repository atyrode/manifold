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
 * edge was the floor claiming to know a set only the assembly knows. The engine's own verbs
 * (`ControlKind`) stay closed, and that contrast is the rule rather than an exception to it.
 */
import "./styles.css";
export {
  ControlIcon,
  ItemIcon,
  RemoteCursorIcon,
  type ControlKind,
  type IconProps,
} from "./icons.tsx";
export {
  NodeTitleBar,
  TITLEBAR_ACTIONS_CLASS,
  type MaximizeControl,
  type NodeTitleBarProps,
} from "./node-titlebar.tsx";
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
export { TileZoneDebug } from "./tile-zone-debug.tsx";
export {
  NoticeContext,
  useNotice,
  type NoticeApi,
  type NoticeLifetime,
  type NoticeOptions,
} from "./notice.ts";
export { currentVantage, setVantage, subscribeVantage, type Vantage } from "./vantage.ts";
