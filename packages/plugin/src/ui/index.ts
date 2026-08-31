/**
 * `@manifold/plugin/ui` — the PLUGIN-FACING STANDARD LIBRARY.
 *
 * Everything behind this subpath is neutral chrome MECHANISM: the glyph vocabulary, the one
 * titlebar a container node wears, the consumer half of the one notice surface, and this
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
 * Being a standard library, not a component kit, has one consequence worth stating: these are
 * closed vocabularies deliberately. A plugin extends them by passing nodes into their slots
 * (`icon`, `middle`, `extraActions`), never by widening a union here — so re-drawing the whole
 * icon set or re-shaping the titlebar stays a change to one file and no call site.
 */
export {
  ControlIcon,
  ItemIcon,
  RemoteCursorIcon,
  SurfaceIcon,
  type ControlKind,
  type IconProps,
  type ItemIconKind,
} from "./icons.tsx";
export {
  NodeTitleBar,
  TITLEBAR_ACTIONS_CLASS,
  type MaximizeControl,
  type NodeTitleBarProps,
} from "./node-titlebar.tsx";
export {
  ToastContext,
  useToast,
  type ToastApi,
  type ToastLifetime,
  type ToastOptions,
} from "./toast.ts";
export {
  currentViewState,
  setViewState,
  subscribeViewState,
  type ViewState,
} from "./view-state.ts";
