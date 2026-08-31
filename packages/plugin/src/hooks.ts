/**
 * The engine's browser PLANE mechanism: what a plugin needs in order to participate in a
 * plane the engine already owns — the carry/drop vocabulary, the element host, polling. Its
 * sibling `@manifold/plugin/ui` is the other browser entry and answers a different question:
 * how a plugin LOOKS like manifold (glyphs, the one titlebar, the notice hook, view state).
 *
 * Both are subpaths rather than part of `@manifold/plugin` itself because that entry is what
 * the server composes through, which is what lets the shell and a plugin share one drag
 * vocabulary without dragging `DataTransfer` into the server's type graph.
 */
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
  noteTitle,
  remoteTileCarries,
  refDisplayLabel,
  type CarryGhost,
  type CarryPoint,
  type CarrySource,
  type RemoteTileCarry,
  type RefLabelLookups,
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
  ContainerRenderer,
  ProjectionProvider,
  TerminalRenderer,
  ViewportRegistrationProvider,
  useProjection,
  useTerminalFacet,
  useViewportRegistration,
  type ElementOutletProps,
  type ContainerOverlayOutletProps,
  type ContainerOverlayProps,
  type ContainerRendererOutletProps,
  type ContainerRendererProps,
  type ProjectionPlaceholderProps,
  type ProjectionRegistry,
  type ProjectionState,
  type RegisteredElement,
  type RegisteredRenderer,
  type RegisteredTool,
  type TerminalFacet,
  type TerminalRendererProps,
} from "./projection.ts";
export { sessionUrl } from "./session-url.ts";
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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * The workspace index is HTTP, not a live channel: this tab learns that another tab created a
 * container, parked a terminal, or joined a room only by asking again. Five refs did that
 * with five hand-rolled effects, each re-deriving the same four concerns — fetch once
 * immediately, then on an interval; drop a response that a token or route change superseded;
 * hold a response that would land mid-gesture; and leave state untouched when the answer did
 * not change. This is that one poll.
 *
 * EVENTUAL FIX: a workspace event channel. The session socket already carries per-room fan-out;
 * once the server pushes container/terminal/presence changes over it, every caller of this hook
 * becomes a subscription and the intervals go away. The hook is deliberately shaped like a
 * subscription (value + local writes + explicit refresh) so that swap stays mechanical.
 */
export interface PolledResourceOptions<T> {
  /** The value before the first response settles; read once, like any `useState` seed. */
  readonly initial: T;
  /** While false nothing is fetched and no timer runs; flipping it true fetches at once. */
  readonly enabled?: boolean;
  /**
   * Consulted when a response settles: true drops it. A held response is never queued — the
   * next tick asks again — so pausing costs one stale interval and never a burst on release.
   */
  readonly hold?: () => boolean;
  /**
   * Content comparison. An equal response never reaches state, so an unchanged workspace
   * re-renders nobody: without this a 2s poll would rebuild every subscriber on every tick.
   */
  readonly equal?: (current: T, incoming: T) => boolean;
  readonly onError?: (reason: unknown) => void;
  /**
   * Anything outside the fetch that should make the answer stale right now — a route id, a
   * count a placement just moved. Changing it restarts the poll, immediate first fetch included.
   */
  readonly restartKey?: string | number | boolean | null;
}

export interface PolledResource<T> {
  readonly value: T;
  /** Local writes: an optimistic move, or a mutation's own response, ahead of the next tick. */
  readonly setValue: Dispatch<SetStateAction<T>>;
  /** Ask now, for a mutation whose effect the caller should not wait an interval to see. */
  readonly refresh: () => void;
}

/**
 * `fetchFn` identity is the restart signal for everything the fetch itself closes over (the
 * bearer token, an id): pass a `useCallback`. The policy callbacks are read late, so they may
 * be written inline without churning the timer.
 */
export function usePolledResource<T>(
  fetchFn: () => Promise<T>,
  intervalMs: number,
  options: PolledResourceOptions<T>,
): PolledResource<T> {
  const { initial, enabled = true, hold, equal, onError, restartKey = null } = options;
  const [value, setValue] = useState<T>(initial);

  const policy = useRef({ hold, equal, onError });
  // Declared before the poll effect, so it has already published this render's callbacks by the
  // time an immediate first fetch can settle.
  useEffect(() => {
    policy.current = { hold, equal, onError };
  });

  /**
   * Bumped whenever the poll restarts or unmounts. A response issued before the bump belongs to
   * a superseded fetch — an old token, a route the viewer already left — and is dropped rather
   * than allowed to overwrite the current answer.
   */
  const generation = useRef(0);

  const refresh = useCallback((): void => {
    const issued = generation.current;
    void fetchFn()
      .then((incoming) => {
        if (issued !== generation.current) return;
        if (policy.current.hold?.() === true) return;
        setValue((current) =>
          policy.current.equal?.(current, incoming) === true ? current : incoming,
        );
      })
      .catch((reason: unknown) => {
        if (issued !== generation.current) return;
        policy.current.onError?.(reason);
      });
  }, [fetchFn]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, refresh, restartKey]);

  return { value, setValue, refresh };
}
