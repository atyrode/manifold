/**
 * The engine's browser half: what a plugin needs in order to PARTICIPATE in a plane the engine
 * already owns — the carry/drop vocabulary, the element host, polling, the one tile tree and
 * its drop chrome, the notice consumer half, this device's published view state. How a plugin
 * LOOKS like manifold is the other package's question (`@manifold/ui`: glyphs, the titlebar,
 * the layout algebra, the tokens), and the engine wears that design system itself — the tile
 * renderer below imports its glyphs and its motion primitive from there like any plugin does.
 *
 * A subpath rather than part of `@manifold/plugin` itself because that entry is what the
 * server composes through, which is what lets the shell and a plugin share one drag
 * vocabulary without dragging `DataTransfer` into the server's type graph.
 */
import "./styles.css";
export {
  ITEM_MIME,
  beginCarry,
  carriedItem,
  carriedPlacement,
  carriesItem,
  containerEnvelope,
  endCarry,
  envelopeRef,
  parseEnvelope,
  readEnvelope,
  sealEnvelope,
  startItemDrag,
  validateEnvelope,
  type ItemEnvelope,
  type ItemEnvelopeKind,
} from "./item-envelope.ts";
export {
  createPlacementLookup,
  denialMessage,
  itemDenialMessage,
  useItemDrop,
  type ItemDropApi,
  type ItemDropAssessment,
  type PlacementLookupInputs,
  type RefusalProps,
  type UseItemDropOptions,
} from "./item-drop.ts";

export { ElementHostProvider, useElementHost } from "./element-host.ts";
/**
 * The PRESENCE plane's browser mechanism: cursor spaces and their snap epsilons, gesture
 * frames and their decay, the local projection of this device's own presence. Neutral math
 * over wire payloads — every renderer that paints remote intent measures with it, and the
 * presence plugin publishes through it.
 */
export * from "./presence/index.ts";
/**
 * The TILE vocabulary: one drop pipeline, one carry lifecycle, one snap geometry, shared by
 * every renderer that draws a tile layout. It lives in the engine for the same reason the
 * placement algebra does — two plugins and the workspace shell all measure against it, and
 * none of them may import each other.
 */
export {
  carryFrame,
  carryGhosts,
  carryPayload,
  carryPlacementId,
  firstLineLabel,
  remoteTileCarries,
  refDisplayLabel,
  type CarryGhost,
  type CarryPoint,
  type CarrySource,
  type RemoteTileCarry,
  type RefLabelLookups,
  type RefElementContent,
} from "./carry.ts";
export {
  useCarry,
  useRemoteGestures,
  type CarryController,
  type UseCarryOptions,
} from "./use-carry.ts";
export {
  createTileDropStore,
  tileDropSignalsEqual,
  type TileDropAim,
  type TileDropIntent,
  type TileDropSignal,
  type TileDropStore,
} from "./tile-drop-store.ts";
export {
  MIN_TILE_FRACTION,
  SNAP_EDGE_BAND,
  asTileTree,
  composeTargetAt,
  dividerRatios,
  resizeRatios,
  resolveSnapTarget,
  snapZone,
  type DividerDrag,
  type SnapAction,
  type SnapCarry,
  type SnapNode,
  type SnapPoint,
  type SnapRect,
  type SnapTarget,
} from "./tile-snap.ts";
export {
  RING_AXIS_CAP,
  RING_LEAF_CAP,
  ROOT_RING_PX,
  ZONE_HYSTERESIS,
  layoutRevision,
  paneShifts,
  resolveTileAim,
  ringFraction,
  refKey,
  tileChainAt,
  tileDestinationFor,
  tileProspect,
  tileRects,
  type PaneShift,
  type TileAction,
  type TileAim,
  type TileAimCarry,
  type TileProspect,
  type UnitPoint,
  type UnitRect,
} from "./tile-geometry.ts";
/**
 * The ELEMENT plane's geometry, as the tile plane has its own above: what a flat coordinate
 * payload extends to and the SVG strings that paint it. Neutral over producers — a polyline
 * is a coordinate sequence, never a stroke — which is what let two plugins stop carrying
 * private copies of it (issue #117); the doc comment on the module applies the litmus.
 */
export {
  polylineBounds,
  polylinePath,
  polylineRelativeTo,
  polylineViewBox,
  type PolylineBounds,
} from "./polyline.ts";
/**
 * WHAT A RELEASE MEANS over a tile tree: the one answer, shared by every surface that
 * resolves an aim — a composition's own tree, the workspace shell's, and the projection of
 * a panel's row arrangement (issue #104).
 */
export { releasedTileLayout, tradedSeats, type TileRelease } from "./tile-release.ts";
export {
  areaUnits,
  previewFor,
  sameAim,
  useTileDrop,
  wireCarryAim,
  type AreaFractions,
  type TileDropChip,
  type TileDropContext,
  type TileDropHost,
  type TileDropPipeline,
  type TileDropState,
} from "./use-tile-drop.ts";
/**
 * PROJECTION: how a container renderer paints an occupant belonging to another plugin, and
 * how a mounted ref publishes its viewport back to the host.
 */
export {
  ElementOutlet,
  ContainerOverlayOutlet,
  OVERLAY_SLOTS,
  WORKSPACE_OVERLAY_SLOTS,
  WorkspaceOverlayOutlet,
  ContainerRenderer,
  ProjectionProvider,
  RoomPipeRegistrationProvider,
  ProjectionScopeProvider,
  TitlebarOutlet,
  extendProjectionScope,
  useProjectionScope,
  usePublishLocation,
  type ProjectionScope,
  TerminalRenderer,
  type TerminalRendererProps,
  SectionOutlet,
  ViewportRegistrationProvider,
  useProjection,
  useRoomPipeRegistration,
  useTerminalFacet,
  useViewportRegistration,
  type ElementOutletProps,
  type ContainerOverlayOutletProps,
  type ContainerOverlayProps,
  type OverlayRegistrations,
  type OverlaySlot,
  type WorkspaceOverlayOutletProps,
  type WorkspaceOverlayProps,
  type WorkspaceOverlayRegistrations,
  type WorkspaceOverlaySlot,
  type ContainerRendererOutletProps,
  type ContainerRendererProps,
  type SectionOutletProps,
  type ProjectionPlaceholderProps,
  type ProjectionRegistry,
  type ProjectionState,
  type RegisteredElement,
  type RegisteredRenderer,
  type RegisteredTool,
  type RoomPipe,
  type RoomPipeRegistration,
  type TerminalFacet,
} from "./projection.ts";
/**
 * THE tile tree and its drop chrome. One renderer for every tile layout in the product — the
 * workspace shell's own panes, a composition's leaves, a portal's preview — because
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
export {
  TilePreviewOverlay,
  useTileDeparture,
  type TileDeparture,
  type TilePreviewOverlayProps,
} from "./tile-preview-overlay.tsx";
export { TileZoneDebug, toggleZoneProbe } from "./tile-zone-debug.tsx";
/**
 * The words a keycap wears: the platform-bound half of the engine's keystroke grammar, asked
 * once (`./keycap-label.ts`). The box is `KeyCap` in `@manifold/ui`.
 */
export { keyCapLabel } from "./keycap-label.ts";
/**
 * The consumer half of the one notice ref (`./notice.ts`), and this device's published view
 * state (`./vantage.ts`). Neither decides anything about a domain noun, and each is addressed
 * by two parties that may not import each other — a floor renderer and a plugin, or two
 * plugins — which is the litmus that puts a thing here instead of in the package that happens
 * to use it first.
 */
export {
  NoticeContext,
  useNotice,
  type NoticeApi,
  type NoticeLifetime,
  type NoticeOptions,
} from "./notice.ts";
export {
  currentVantage,
  publishLocation,
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
/** The rebind slot's sibling: a picked-up structure, handed to the palette (`./held.ts`, #148). */
export {
  heldStructure,
  holdStructure,
  releaseStructure,
  useHeldStructure,
  type HeldStructure,
} from "./held.ts";
/**
 * WHICH INSTANCE the lens looks at, and the doors derived from it. Browser-only (it reads
 * `window.location` and this device's memory), so it rides this subpath with the rest of the
 * platform-bound seam.
 */
export {
  chooseInstance,
  instanceOrigin,
  instanceUrl,
  isForeignInstance,
  sessionUrl,
} from "./instance.ts";
/**
 * The read-only automation seam the browser gates read. It touches `window`, so it rides this
 * browser-only subpath and never `@manifold/plugin`'s platform-free root.
 */
export {
  countRender,
  debugProbeEnabled,
  renderCounts,
  toElementSnapshot,
  type DebugCamera,
  type DebugElementSnapshot,
  type DebugGestureSnapshot,
  type DebugViewport,
  type ManifoldDebugProbe,
} from "./debug-probe.ts";
/**
 * THE ROUTED CONTAINER, as the shell publishes it: which container the viewer asked for, what the
 * index knows about it, and the verbs a renderer inside it needs. Its own module because
 * three parties read it — the floor shell that publishes it and the two container renderers
 * that consume it — and a context cannot ride `@manifold/plugin`'s platform-free root.
 */
export {
  ContainerRouteProvider,
  useContainerRoute,
  type ContainerRoute,
  type WorkspaceSidebarState,
} from "./container-route.ts";

/**
 * THE SHELL'S OWN HALF, as the workspace host publishes it to the plugin occupying its sidebar
 * panel. Its own module for the same reason the route above is: the producer is floor, the
 * consumer is a plugin, and neither may import the other (`./workspace-shell.ts`).
 */
export {
  WorkspaceShellProvider,
  useWorkspaceShell,
  type WebChangelogRelease,
  type WorkspaceShell,
} from "./workspace-shell.ts";

/**
 * THE workspace poll. It lives in its own module because it is no longer a hook over local
 * state: subscribers naming one resource share one timer, one request and one snapshot, and
 * an unchanged answer reaches nobody (`./polled-resource.ts`).
 */
export {
  usePolledResource,
  polledFeedReport,
  resetPolledResources,
  ATTENDANCE_RESOURCE,
  CONTAINER_TERMINALS_RESOURCE,
  FALLBACK_POLL_MS,
  INDEX_RESOURCE,
  MACHINES_RESOURCE,
  TERMINALS_RESOURCE,
  type PolledResource,
  type PolledResourceOptions,
  type PolledEquality,
  type PolledFeedReport,
} from "./polled-resource.ts";
