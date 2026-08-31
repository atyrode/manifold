import {
  CURSOR_MIN_INTERVAL_MS,
  MAX_GESTURE_POINT_VALUES,
  VIEWPORT_MIN_INTERVAL_MS,
  parseManifoldUri,
  placementItemFor,
  type MachineSummary,
  type PlacementDestination,
  type PlacementItem,
} from "@manifold/protocol";
import { lastSpotlight, type ViewportHandle } from "@manifold/plugin";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import {
  NodeResizer,
  ReactFlow,
  ViewportPortal,
  useNodesState,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { CanvasToolbar } from "./canvas-toolbar.tsx";
import { toolFlags, toolForKey, type CanvasTool } from "./canvas-tool.ts";
import {
  ContainerOverlayOutlet,
  REMOTE_CURSOR_FALLBACK_COLOR,
  carrierColor,
  carriesItem,
  carryGhosts,
  composeTargetAt,
  createGestureStream,
  createPlacementLookup,
  createTileDropStore,
  debugProbeEnabled,
  envelopeRef,
  gestureSendIntervalOverride,
  remoteCursorSocketId,
  remoteTileCarries,
  renderCounts,
  sessionUrl,
  toElementSnapshot,
  useCarry,
  useItemDrop,
  useContainerRoute,
  useProjection,
  useRemoteCursors,
  useRemoteGestures,
  useViewportRegistration,
  type ItemEnvelope,
  type ContainerRendererProps,
  type ProjectionPlaceholderProps,
  type ProjectionState,
  type RegisteredElement,
} from "@manifold/plugin/hooks";
import {
  RemoteCursorIcon,
  CarriedItemIcon,
  currentVantage,
  setVantage,
  subscribeVantage,
  useNotice,
} from "@manifold/plugin/ui";
import { MONO_PORTAL_CLASS_SELECTOR, PORTAL_DRAG_HANDLE, PortalNode } from "./portal-element.tsx";
import {
  CanvasProviders,
  TERMINAL_DRAG_HANDLE,
  useCanvas,
  type CanvasContextValue,
} from "./terminal-element.tsx";
import {
  reconcileNodes,
  createDrawElement,
  createPortalElement,
  createTextElement,
  projectElements,
  type ProjectedNode,
} from "./canvas-scene.ts";
import { loadViewport, saveViewport } from "./viewport-memory.ts";
import { appendPoint, DEFAULT_STROKE_WIDTH, pointsToPath } from "./stroke.ts";
import type { ChannelRole } from "./portal-engagement.ts";

/**
 * `core.canvas`'s renderer: React Flow is the projection boundary, and a scene record becomes
 * a node here or nowhere.
 */

/**
 * The node species THIS PLUGIN renders itself. Exactly one, and it is not content: a `portal`
 * is ADDRESSING — the projection of one container inside another — so it belongs to whoever
 * draws the canvas rather than to the element registry, which exists to give a STRANGER's
 * element a resizer and a commit path. Everything else on the canvas arrives from the
 * composition, `text` and `draw` included.
 */
const CANVAS_NODE_TYPES: NodeTypes = {
  portal: PortalNode,
};

/**
 * ONE resize floor for every contributed species, deliberately tiny: ink may shrink to a
 * thumbnail, and a note that got dragged small is still clickable and still resizable back.
 * A per-species minimum would be geometry policy travelling in a manifest, which is the
 * element frame's whole reason not to exist twice.
 */
const MIN_PLUGIN_ELEMENT_SIZE = 16;

/**
 * Stable tags for contributed renderers. The node-type map has to be memoized on WHICH
 * components are registered — a fresh map remounts every node, live PTYs included — and a
 * component is a function, so it needs an identity that survives into a string key.
 */
const componentTags = new WeakMap<ComponentType<never>, string>();
let nextComponentTag = 0;

function componentTag(component: ComponentType<never> | null): string {
  if (component === null) return "-";
  const existing = componentTags.get(component);
  if (existing !== undefined) return existing;
  nextComponentTag += 1;
  const tag = String(nextComponentTag);
  componentTags.set(component, tag);
  return tag;
}

/**
 * What a change in the element registry MEANS for React Flow: which element types exist,
 * whether each is enabled, and which component is attached. Toggling an unrelated plugin
 * (`core.machines`, say) leaves this string identical, which is what keeps a terminal from
 * being remounted — and reattached — by an administrator flipping a sidebar section.
 *
 * Sorted, because the SET is what React Flow cares about: the node-type map is keyed by
 * type, so two rosters listing the same renderers in a different order compose the identical
 * map. Ordering the parts is what stops a reshuffled roster from paying for that agreement
 * with a remount of every live PTY on the canvas.
 */
function elementRegistrySignature(elements: ReadonlyMap<string, RegisteredElement>): string {
  const parts: string[] = [];
  for (const [type, element] of elements) {
    parts.push(`${type}:${element.enabled ? "1" : "0"}:${componentTag(element.Component)}`);
  }
  return parts.sort().join("|");
}

/**
 * The paint boundary for a contributed element. Geometry stays ENGINE business — one
 * resizer, one selection rule, one commit path for every species — so a plugin's renderer
 * paints its own `data` and never learns how a scene document is written.
 */
function pluginElementNode(Component: ComponentType<never>): ComponentType<NodeProps> {
  /*
    The ONE cast at this boundary. Registered element components are deliberately opaque
    (`ComponentType<never>`): a React Flow node component's props are the renderer's own
    contract, and this paint boundary is the single place allowed to name them.
  */
  const Painter = Component as unknown as ComponentType<NodeProps>;
  return memo(function PluginElementNode(props: NodeProps) {
    const container = useCanvas();
    return (
      <>
        {/* Ink and text keep the classic bounding-box handles; only terminals grab by border. */}
        <NodeResizer
          nodeId={props.id}
          isVisible={container.tool === "select" && props.selected === true}
          minWidth={MIN_PLUGIN_ELEMENT_SIZE}
          minHeight={MIN_PLUGIN_ELEMENT_SIZE}
          onResize={(_event, params) =>
            container.onResize(props.id, params.x, params.y, params.width, params.height)
          }
          onResizeEnd={(_event, params) =>
            container.onResizeEnd(props.id, params.x, params.y, params.width, params.height)
          }
        />
        <Painter {...props} />
      </>
    );
  });
}

/**
 * An element whose plugin is off — or which declares a renderer nobody registered — draws
 * the shared inert ref NAMING it. A stroke authored while `core.draw` was on must not
 * vanish when somebody disables the plugin: the scene still holds it, so the canvas says so
 * (D4), and enabling the plugin brings the ink back without a reload (R3).
 */
function pluginPlaceholderNode(
  Placeholder: ComponentType<ProjectionPlaceholderProps>,
  name: string,
  state: ProjectionState,
): ComponentType<NodeProps> {
  return memo(function PluginElementPlaceholderNode() {
    return <Placeholder name={name} state={state} />;
  });
}

function buildNodeTypes(
  elements: ReadonlyMap<string, RegisteredElement>,
  Placeholder: ComponentType<ProjectionPlaceholderProps>,
): NodeTypes {
  const contributed: Record<string, ComponentType<NodeProps>> = {};
  for (const [type, element] of elements) {
    const name = element.title;
    if (!element.enabled) {
      contributed[type] = pluginPlaceholderNode(Placeholder, name, "disabled");
    } else if (element.Component === null) {
      contributed[type] = pluginPlaceholderNode(Placeholder, name, "unavailable");
    } else {
      contributed[type] = pluginElementNode(element.Component);
    }
  }
  // This plugin's own species last: `portal` is not overridable by a manifest that happens to
  // declare its wire type (D5 refuses plugin/plugin collisions; this refuses shadowing of the
  // ref's own addressing species at the one place it could bite).
  return { ...contributed, ...CANVAS_NODE_TYPES };
}

/**
 * One `NodeTypes` object per element-registry signature, for the life of the tab.
 *
 * React Flow remounts every node when this object's identity changes — reattaching every
 * live PTY on the canvas — so the map may NOT be rebuilt per render, and it may not be keyed
 * on the composition either: hiding a sidebar section would then reattach the terminals.
 * The signature IS the key, and the cache is module-level and pure precisely so that no
 * hook, ref or render order is involved in answering "have I built this vocabulary before".
 * It grows by one entry per distinct registry shape a terminal ever sees — a handful.
 *
 * Placeholder titles come from the registry row and are NOT part of the key: a manifest's
 * title is fixed for the roster that declared it, so a title cannot move under a stable
 * signature. The `Placeholder` component is the engine's, stable for the tab, and likewise
 * outside the key.
 */
const nodeTypesBySignature = new Map<string, NodeTypes>();

export function nodeTypesFor(
  elements: ReadonlyMap<string, RegisteredElement>,
  Placeholder: ComponentType<ProjectionPlaceholderProps>,
): NodeTypes {
  const signature = elementRegistrySignature(elements);
  const cached = nodeTypesBySignature.get(signature);
  if (cached !== undefined) return cached;
  const built = buildNodeTypes(elements, Placeholder);
  nodeTypesBySignature.set(signature, built);
  return built;
}
/**
 * A canvas cannot DERIVE solo occupancy: it holds elements, not tile layouts, and the
 * containers its portals point at belong to rooms it has not joined. Its host supplies
 * the answer instead ({@link ContainerRendererProps.soloOccupants}); this is the fallback for
 * a canvas mounted without one — an embedded canvas inside a composition tile.
 */
const NO_SOLO_OCCUPANTS: ReadonlyMap<string, PlacementItem> = new Map();
const NO_EDGES: readonly never[] = Object.freeze([]);
const ROUND_GESTURE_COORDINATE = 10;
const PRO_OPTIONS = Object.freeze({ hideAttribution: true });
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
/**
 * How long a dragged ref must hover a node before the canvas arms it as a drop
 * target. Long enough that dragging a terminal PAST another one on the way somewhere
 * else never arms; short enough that deliberately holding it there feels immediate.
 * The armed portal's own overlay resolves WHICH zone and WHAT releasing means; the
 * canvas only decides WHICH portal is armed. Once armed, zone changes are immediate.
 */
const COMPOSE_ARM_MS = 150;

/**
 * "Nowhere", the destination a release over the sidebar means. One frozen literal: the
 * unplaced destination carries no fields, so every door into it is the same door.
 */
const UNPLACED_DESTINATION: PlacementDestination = Object.freeze({ kind: "unplaced" });

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("textarea, input, [contenteditable], .xterm") !== null
  );
}

/** Client point of a React Flow node drag frame; React Flow may hand us either event. */
function dragPoint(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0] ?? event.touches[0];
  return touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
}

function gesturePoints(points: readonly number[]): number[] {
  return points
    .slice(-MAX_GESTURE_POINT_VALUES)
    .map((value) => Math.round(value * ROUND_GESTURE_COORDINATE) / ROUND_GESTURE_COORDINATE);
}

/** One peer's selection outline, in this ref's own scene coordinates. */
interface RemoteSelectionRect {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

/**
 * The canvas takes the NEUTRAL projection props and nothing else: an address, the index facts
 * the placement algebra needs locally, and how deep it is nested. Who this device is comes
 * from `host`; the routed extras — report your connection state, is this point over the
 * sidebar — come from {@link useContainerRoute}, and only while this mount IS the route (depth 1).
 * That is what lets one component be both the routed canvas and a tile leaf's embedded one.
 */
export function CanvasView({
  host,
  containerId,
  navigate,
  presence,
  containers,
  soloOccupants = NO_SOLO_OCCUPANTS,
  depth = 1,
}: ContainerRendererProps) {
  const { notify } = useNotice();
  const route = useContainerRoute();
  const routed = depth === 1;
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), containerId, token: host.token }),
  );
  const [gestureStream] = useState(() => {
    const intervalMs = gestureSendIntervalOverride();
    return createGestureStream({
      ...(intervalMs === null ? {} : { intervalMs }),
      send: (gesture) => client.sendGesture(gesture),
    });
  });
  /**
   * Peers' live geometry AND their carries: one override map, because a carry of an
   * element in this room IS that element's live geometry — the source container mutates
   * under the carrier's pointer rather than waiting for the drop.
   */
  const remoteGestures = useRemoteGestures(client);
  /**
   * The one grab, whatever started it. A node drag opens it directly; a drag that began
   * on a sidebar row or a portal's tile is ADOPTED as it crosses this canvas, because
   * the item register is process-wide and entering a room is the whole invitation.
   *
   * `describe` is what a viewer will read under the carrier's pointer. This canvas can
   * name things the frame itself cannot — its own terminals, the containers the sidebar
   * indexed — and the name has to travel, since the viewer may share neither.
   *
   * `resolveItem` is the other half of that: what the grab HOLDS, classified against this
   * canvas's own lookup so the answer rides the wire instead of every viewer guessing.
   */
  const carry = useCarry({
    client,
    resolveItem: (envelope: ItemEnvelope) => placementItemFor(envelopeRef(envelope), lookup),
    describe: (envelope: ItemEnvelope): string | null => {
      switch (envelope.kind) {
        case "terminal":
          return client.terminals.get(envelope.terminalId)?.name ?? null;
        case "canvas":
        case "composition":
          return (
            containers.find((candidate) => candidate.id === envelope.containerId)?.name ?? null
          );
        case "tile":
        case "element":
          return null;
        default: {
          const exhaustive: never = envelope;
          return exhaustive;
        }
      }
    },
  });
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sceneRevision, setSceneRevision] = useState(0);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  /** Bumped on every presence frame; the invalidation key for anything derived from the roster. */
  const [attendanceRevision, setAttendanceRevision] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** What the viewer PICKED; the tool actually in force is derived below, against the roster. */
  const [heldTool, setTool] = useState<CanvasTool>("select");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeStrokePoints, setActiveStrokePoints] = useState<readonly number[] | null>(null);
  const connectStartedRef = useRef(false);
  const remoteCursors = useRemoteCursors(client, "flow");
  const lastClientRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const cursorLastSentRef = useRef(0);
  const viewportLastSentRef = useRef(0);
  const flowRef = useRef<ReactFlowInstance<Node, never> | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<{
    readonly id: string;
    readonly pointerId: number;
    readonly points: number[];
  } | null>(null);
  /**
   * The per-frame drop channel to this canvas's portal overlays. The compose gesture
   * runs off refs and this store, never React state: it is driven by drag frames, and
   * re-rendering the canvas on every hover frame would put the xterm subtrees back
   * into the drag hot path. Arming only flips `armedElementId`, which repaints the one
   * armed portal's overlay and nothing else.
   */
  const [dropStore] = useState(createTileDropStore);
  /** Which portal is armed right now; mirrored into the store with each frame. */
  const armedElementIdRef = useRef<string | null>(null);
  const composeCandidateRef = useRef<string | null>(null);
  const composeTimerRef = useRef<number | null>(null);
  /** True while a gesture is over this canvas; the WHAT lives in the carry register. */
  const carryingRef = useRef(false);
  const projectedRef = useRef<readonly ProjectedNode[]>([]);
  const initialViewport = useMemo(
    () => loadViewport(window.localStorage, containerId) ?? { x: 0, y: 0, zoom: 1 },
    [containerId],
  );

  /**
   * The vocabulary this canvas paints with: element renderers and tools are declared by
   * manifests and resolved by the engine, so no plugin is named here — not even this one.
   */
  const projection = useProjection();
  /** Stable for the host gate's lifetime, so registering is an ordinary effect. */
  const registerViewport = useViewportRegistration();
  /*
    Pure and module-cached (see {@link nodeTypesFor}): the same registered vocabulary hands
    back the same object, so React Flow keeps every node — and every attached PTY — mounted
    across renders and across toggles of plugins that contribute no elements.
  */
  const nodeTypes = nodeTypesFor(projection.elements, projection.Placeholder);
  /*
    A tool the composition no longer offers cannot stay in the viewer's hand: disabling
    `core.draw` while its tool is held would otherwise leave a pointer authoring elements
    whose renderer is now a placeholder. So the held tool is a REQUEST and the tool in force
    is derived from it — the hand falls back to select the instant the tool leaves the
    vocabulary, live and without a reload (R3), and takes it back if the plugin returns.

    `select` is this plugin's own manifest row, so it needs no special case: a canvas that is
    rendering at all has an enabled `core.canvas`, and therefore an enabled `select`.
  */
  const tool = projection.tools.some((candidate) => candidate.enabled && candidate.id === heldTool)
    ? heldTool
    : "select";

  /**
   * VIEW STATE, published (A2). One subscription, declared FIRST so the mount-time writes
   * below are already heard: a view change puts the current state on the presence plane
   * through the same door cursors and selections use, and every other writer merges
   * `currentVantage()` into its own payload, so a reconnect republishes it with no second
   * send path.
   *
   * The routed canvas is the one that speaks for this device: an embedded canvas inside a
   * composition tile holds its own tool, and two publishers of one per-principal state would
   * fight over it. `depth === 1` is that test.
   */
  useEffect(() => {
    if (depth !== 1) return;
    return subscribeVantage((vantage) => client.sendPresence({ vantage }));
  }, [client, depth]);

  useEffect(() => {
    if (depth !== 1) return;
    setVantage({ tool });
  }, [depth, tool]);

  useEffect(() => {
    if (depth !== 1) return;
    setVantage({ editingElementId: editingId });
  }, [depth, editingId]);

  useEffect(() => {
    const invalidate = (): void => setSceneRevision((value) => value + 1);
    const offScene = client.on("elements_changed", invalidate);
    const offReset = client.on("scene_reset", () => {
      setEditingId(null);
      invalidate();
    });
    const offTerminals = client.on("terminals_changed", invalidate);
    const offStatus = client.on("status", setStatus);
    /**
     * The SDK emits `attendance_changed` for every presence frame, selection payloads included.
     * The canvas keeps a COUNTER rather than a projection of the roster: what it needs from
     * presence is an invalidation signal (remote selection outlines are derived from
     * `client.attendance` directly) plus a colour per principal, and both come off the wire.
     * Rendering WHO is here belongs to `core.presence`, which paints it as an overlay.
     */
    const refreshAttendance = (): void => {
      setAttendanceRevision((value) => value + 1);
    };
    const offAttendance = client.on("attendance_changed", refreshAttendance);
    const offSaved = client.on("saved", (message) => setSavedAt(message.at));
    refreshAttendance();
    return () => {
      offScene();
      offReset();
      offTerminals();
      offStatus();
      offAttendance();
      offSaved();
    };
  }, [client]);

  useEffect(() => () => gestureStream.cancel(), [gestureStream]);

  useEffect(() => {
    if (connectStartedRef.current) return;
    connectStartedRef.current = true;
    void client.connect().catch((reason: unknown) => {
      // Sticky: the canvas stays degraded until this is resolved, so the notice must not
      // fade out from under the viewer. Keyed, so a reconnect loop shows one row.
      notify(reason instanceof Error ? reason.message : "Could not connect to this canvas", {
        lifetime: "sticky",
        key: "canvas-connect",
      });
    });
    return () => client.close();
  }, [client, notify]);

  useEffect(() => {
    let cancelled = false;
    void host.client
      .machines()
      .then((fetched) => {
        if (!cancelled) setMachines(fetched);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          notify(reason instanceof Error ? reason.message : "Could not load machines", {
            lifetime: "sticky",
            key: "machines",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [host.client, notify]);

  const emitCursor = useCallback(
    (clientX: number, clientY: number): void => {
      lastClientRef.current = { x: clientX, y: clientY };
      const now = performance.now();
      if (now - cursorLastSentRef.current < CURSOR_MIN_INTERVAL_MS) return;
      const flow = flowRef.current;
      if (flow === null) return;
      cursorLastSentRef.current = now;
      const position = flow.screenToFlowPosition({ x: clientX, y: clientY });
      client.sendCursor(position.x, position.y);
    },
    [client],
  );

  const reemitCursor = useCallback((): void => {
    const latest = lastClientRef.current;
    if (latest !== null) emitCursor(latest.x, latest.y);
  }, [emitCursor]);

  const publishViewport = useCallback(
    (
      viewport: { readonly x: number; readonly y: number; readonly zoom: number },
      force: boolean,
    ) => {
      const now = performance.now();
      if (!force && now - viewportLastSentRef.current < VIEWPORT_MIN_INTERVAL_MS) return;
      viewportLastSentRef.current = now;
      // Every outgoing payload carries the vantage: presence is merged server-side, so this is
      // also how a reconnected socket re-publishes what this device is holding.
      client.sendPresence({ viewport, vantage: currentVantage() });
    },
    [client],
  );

  /*
    A peer's carried element eases away exactly like the node in your own hand. The fade
    is a property of the CARRY — an override whose carry has an armed aim — not of being
    the dragger, so both producers resolve to the ONE rule in styles.css. It rides the
    projection because React Flow owns the node box the class has to land on.
  */
  const projected = useMemo<readonly (ProjectedNode & { readonly className?: string })[]>(() => {
    void sceneRevision;
    return projectElements(client.elements, remoteGestures).map((node) => {
      const override = remoteGestures.get(node.id);
      if (override === undefined || override.kind !== "carry" || override.carry?.aim === undefined)
        return node;
      return { ...node, className: "is-carried-away" };
    });
  }, [client, remoteGestures, sceneRevision]);
  // Compose hit-testing reads the freshest projection from inside handlers that
  // must stay stable across drag frames, so it travels by ref, written post-commit
  // (handlers only fire on pointer events, which land after the effect flush).
  useEffect(() => {
    projectedRef.current = projected;
  }, [projected]);

  /**
   * React Flow paints every node with its own `zIndex` inside the viewport's stacking
   * context, and element bands grow with each creation, so presence has to be lifted
   * above the highest one — the same thing React Flow does for its node toolbar.
   */
  const presenceZIndex = useMemo(
    () => projected.reduce((highest, element) => Math.max(highest, element.zIndex), 0) + 1,
    [projected],
  );

  /**
   * Remote selection outlines are pure presence, painted into THIS ref's coordinate space
   * — which is why the canvas paints them rather than an overlay: a selection outline is a box
   * around a node only this renderer can locate (invariant 11: a view renders remote intent as
   * part of its own ref). `attendanceRevision` moves on every `attendance_changed`, which the SDK
   * emits for each `presence` frame — selection payloads included — so it is the dependency
   * that provably invalidates this, and a purely local drag frame no longer walks the roster.
   */
  const remoteSelections = useMemo<readonly RemoteSelectionRect[]>(() => {
    void attendanceRevision;
    const rects: RemoteSelectionRect[] = [];
    const projectedById = new Map(projected.map((element) => [element.id, element] as const));
    for (const viewer of client.attendance.values()) {
      if (viewer.principal.id === client.self?.id) continue;
      for (const elementId of viewer.payload.selection ?? []) {
        const element = projectedById.get(elementId);
        if (element === undefined) continue;
        rects.push({
          key: `${viewer.principal.id}:${elementId}`,
          x: element.position.x,
          y: element.position.y,
          width: element.width,
          height: element.height,
          color: viewer.principal.color,
        });
      }
    }
    return rects;
  }, [client, projected, attendanceRevision]);

  /**
   * The carries this canvas owes a ghost. An element of THIS container is excluded on purpose:
   * its override already moves the element itself, so the source container mutates live
   * under the carrier's pointer and a chip on top would draw the same object twice.
   */
  const remoteCarries = useMemo(
    () =>
      carryGhosts(
        remoteGestures.values(),
        (ref) =>
          ref.kind === "element" &&
          ref.containerId === containerId &&
          client.elements.has(ref.elementId),
      ),
    [client, containerId, remoteGestures],
  );

  // Peers' armed aims, fed to the portal overlays through the same per-frame channel
  // the local pointer uses. Imperative store write: a collaborator's 60 Hz drag
  // repaints the armed overlay alone, never the node tree. Keyed per container, so two
  // peers aiming at two different portals both preview instead of masking each other —
  // and this canvas's room is only ONE feed: each live portal publishes what its own
  // container's room hears, which is how a route dragger reaches these viewers.
  useEffect(() => {
    dropStore.setRemote(containerId, remoteTileCarries(remoteGestures.values()));
  }, [dropStore, containerId, remoteGestures]);

  /**
   * The canonical projection carries no live-gesture geometry: `reconcileNodes` reuses the
   * node React Flow is dragging or resizing verbatim, so the pointer is tracked by React
   * Flow's own array and this memo only rebuilds when the scene actually moves. Selection is
   * React Flow's own: the sidebar-row highlight that used to drive it went with those rows.
   */
  const canonicalNodes = useMemo<Node[]>(
    () =>
      projected.map((element) => ({
        id: element.id,
        type: element.type,
        position: element.position,
        width: element.width,
        height: element.height,
        zIndex: element.zIndex,
        ...(element.className === undefined ? {} : { className: element.className }),
        /*
          A portal moves by its name strip, and its MONO form has no name strip: a solo
          composition wears the terminal's own titlebar instead (the arity rule), so the
          handle is a selector list and the portal's `--mono` class scopes the second arm.
          Without that scope, dragging a tile's titlebar inside a multi-tile portal would
          move the whole node instead of extracting the tile.
        */
        ...(element.type === "portal"
          ? {
              dragHandle: `${PORTAL_DRAG_HANDLE}, ${MONO_PORTAL_CLASS_SELECTOR} ${TERMINAL_DRAG_HANDLE}`,
            }
          : {}),
        data: element.data,
      })),
    [projected],
  );
  const [nodes, setNodes, handleNodesChange] = useNodesState<Node>(canonicalNodes);

  useEffect(() => {
    setNodes((current) => reconcileNodes(canonicalNodes, current));
  }, [canonicalNodes, setNodes]);

  /**
   * The state the algebra asks about, answered from this canvas's own props and document.
   * The server answers the same two questions from its rows and rooms, so a drag preview
   * here can never disagree with the write that follows it.
   */
  const lookup = useMemo(
    () =>
      createPlacementLookup({
        containers,
        self: { containerId, discipline: "canvas" },
        elements: client.elements,
        // A terminal's home composition is on its terminal record now, so the canvas can
        // answer "where does this terminal live" without joining anything.
        terminalHomes: new Map(
          [...client.terminals.values()].map(
            (terminal) => [terminal.id, terminal.containerId] as const,
          ),
        ),
        // Supplied by the index, which is the only party that can see the arity of a
        // container this canvas merely points at. Handing it down is what lets a canvas
        // drag preview agree with the write the server performs.
        soloOccupants,
        /*
          The composed vocabulary, because a CONTRIBUTED element kind's placement traits live
          in its manifest rather than in the closed floor table (ADR 0013 §12): without it a
          note dragged into a composition would be refused by this preview and accepted by the
          server, which is the one disagreement the local algebra exists to prevent.
        */
        roster: host.assembly.roster(),
      }),
    /*
      `sceneRevision` is a KEY, not a closure read, and the exhaustive-deps rule says so out
      loud — leave it anyway: the session client's tables mutate in place, so the version
      counter is the only value that moves when the scene does, and the terminal-home map
      above is a SNAPSHOT of one of them. Drop this dependency and a terminal created a
      moment ago has no home here, which reads as a placement denial mid-drag.

      `projection.revision` is the roster's version for the same reason: `roster()` answers a
      fresh array every call, so the revision is the only value that moves when the composed
      vocabulary does.
    */
    [
      client,
      containers,
      containerId,
      sceneRevision,
      soloOccupants,
      host.assembly,
      projection.revision,
    ],
  );

  const drop = useItemDrop({
    lookup,
    place: (ref, destination) => client.place(ref, destination),
    notify,
  });

  /**
   * The held node steps almost out of the way while a target is armed, so the live
   * preview underneath stays readable. Imperative — a class on the canvas root plus
   * React Flow's own `.dragging` marker — because arming deliberately touches no
   * React state (re-rendering the canvas per hover frame is the drag hot path).
   */
  const reflectArmed = useCallback((): void => {
    canvasRef.current?.classList.toggle("is-composing", armedElementIdRef.current !== null);
  }, []);

  const clearCompose = useCallback((): void => {
    if (composeTimerRef.current !== null) {
      window.clearTimeout(composeTimerRef.current);
      composeTimerRef.current = null;
    }
    carryingRef.current = false;
    composeCandidateRef.current = null;
    armedElementIdRef.current = null;
    reflectArmed();
    dropStore.set({ ...dropStore.get(), pointer: null, armedElementId: null, aim: null });
  }, [dropStore, reflectArmed]);

  /**
   * One frame of the compose gesture: find the node under the pointer, hold it for
   * COMPOSE_ARM_MS, then arm it. Moving to another node restarts the hold and leaving
   * every node disarms, so dragging PAST a terminal never composes onto it — and panes
   * never fly around inside every portal a drag merely crosses.
   *
   * The canvas decides only WHICH portal is armed. The armed portal's own overlay is
   * the side that can see its layout, so it resolves the zone, paints the preview, and
   * publishes the destination back into the store for the release handlers to commit.
   */
  const trackCompose = useCallback(
    (clientX: number, clientY: number, sourceElementId: string | null): void => {
      const flow = flowRef.current;
      if (flow === null || !carryingRef.current) return;
      const point = flow.screenToFlowPosition({ x: clientX, y: clientY });
      const target = composeTargetAt(projectedRef.current, point, sourceElementId);
      const publish = (): void => {
        const armedElementId = armedElementIdRef.current;
        reflectArmed();
        dropStore.set({
          ...dropStore.get(),
          pointer: { clientX, clientY },
          armedElementId,
          // The aim is the armed overlay's answer; disarming retires it with the arm.
          aim: armedElementId === null ? null : dropStore.get().aim,
        });
      };
      if (target === null) {
        if (composeTimerRef.current !== null) {
          window.clearTimeout(composeTimerRef.current);
          composeTimerRef.current = null;
        }
        composeCandidateRef.current = null;
        armedElementIdRef.current = null;
        publish();
        return;
      }
      if (composeCandidateRef.current === target.id) {
        // Held or already armed: stream the pointer either way, so the armed overlay
        // re-resolves its zone immediately (arming is delayed; zone changes are not).
        publish();
        return;
      }
      composeCandidateRef.current = target.id;
      armedElementIdRef.current = null;
      publish();
      if (composeTimerRef.current !== null) window.clearTimeout(composeTimerRef.current);
      // The hold is timed, not sampled: a pointer that stops moving over a target
      // still arms, because drag frames stop arriving the moment it settles.
      composeTimerRef.current = window.setTimeout(() => {
        composeTimerRef.current = null;
        if (!carryingRef.current || composeCandidateRef.current !== target.id) return;
        armedElementIdRef.current = target.id;
        reflectArmed();
        // The pointer already in the store is the one the drag settled on.
        dropStore.set({ ...dropStore.get(), armedElementId: target.id });
      }, COMPOSE_ARM_MS);
    },
    [dropStore, reflectArmed],
  );

  /**
   * Escape abandons the composition without abandoning the drag, and a drag that
   * ends anywhere but this canvas (`dragend` fires on the source) must not leave a
   * node wearing view chrome.
   */
  useEffect(() => {
    const onDragEnd = (): void => clearCompose();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") clearCompose();
    };
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [clearCompose]);

  useEffect(
    () => () => {
      if (composeTimerRef.current !== null) window.clearTimeout(composeTimerRef.current);
    },
    [],
  );

  /**
   * A node drag is a CARRY of the placement it is: the element itself. It arms the same
   * envelope an HTML5 drag seals, minus the DataTransfer (React Flow has none), so the
   * pipeline judges a node-over-node drop with exactly the rules a sidebar drop gets —
   * which is how the compose target stopped disagreeing with the tile target.
   *
   * The frames it streams ARE the old move gesture and more: a carry names what is being
   * moved, and its geometry is the element's own box, so a viewer keeps animating the
   * element exactly as before while now knowing what is in flight.
   */
  const handleNodeDragStart = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node): void => {
      const element = client.elements.get(node.id);
      if (element === undefined) return;
      carryingRef.current = true;
      carry.begin(
        { kind: "element", containerId, elementId: node.id },
        {
          at: {
            x: node.position.x,
            y: node.position.y,
            width: element.width,
            height: element.height,
          },
        },
      );
    },
    [carry, client, containerId],
  );

  const handleNodeDrag = useCallback(
    (event: MouseEvent | TouchEvent, node: Node): void => {
      if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return;
      const point = dragPoint(event);
      if (point !== null) trackCompose(point.x, point.y, node.id);
      // The armed portal's published aim rides this drag's frames (one frame behind
      // the overlay's resolution), so every viewer paints the same split preview.
      carry.track({ x: node.position.x, y: node.position.y }, dropStore.get().aim?.tile);
    },
    [carry, dropStore, trackCompose],
  );

  const handleNodeDragStop = useCallback(
    (event: MouseEvent | TouchEvent, node: Node): void => {
      const element = client.elements.get(node.id);
      const aim = dropStore.get().aim;
      if (
        element === undefined ||
        !Number.isFinite(node.position.x) ||
        !Number.isFinite(node.position.y)
      ) {
        clearCompose();
        return;
      }
      const point = dragPoint(event);
      const release = { x: node.position.x, y: node.position.y };
      // Aimed at a portal: the armed overlay resolved and published the destination —
      // the very state it previewed — so the geometry this drag produced is dropped. A
      // REFUSED aim still commits and reports its rule; the pipeline decides, not this
      // handler.
      if (aim !== null) {
        drop.commit(null, aim.destination);
        clearCompose();
        carry.end(release);
        return;
      }
      clearCompose();
      /*
        Released over the sidebar: the gesture asked for nowhere, not for a canvas
        position. Whether "nowhere" is a legal destination for THIS item is the algebra's
        question, never this handler's — an item the pool refuses simply lands where it
        was dropped instead of raising a rule nobody invoked on purpose.

        Only the ROUTED canvas can be over the sidebar: an embedded one is inside a tile.
      */
      const unplaced =
        routed &&
        point !== null &&
        route.isOverSidebar(point.x, point.y) &&
        drop.assess(UNPLACED_DESTINATION)?.denial == null;
      if (unplaced) {
        drop.commit(null, UNPLACED_DESTINATION);
      } else if (element.x !== release.x || element.y !== release.y) {
        client.transact((tx) => {
          tx.patch(node.id, release);
        });
      }
      carry.end(release);
    },
    [carry, clearCompose, client, drop, dropStore, route, routed],
  );

  const handleResize = useCallback(
    (elementId: string, x: number, y: number, width: number, height: number): void => {
      if (
        !client.elements.has(elementId) ||
        ![x, y, width, height].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
      ) {
        return;
      }
      gestureStream.push({
        kind: "resize",
        phase: "active",
        elementId,
        x,
        y,
        width,
        height,
      });
    },
    [client, gestureStream],
  );

  const handleResizeEnd = useCallback(
    (elementId: string, x: number, y: number, width: number, height: number): void => {
      const element = client.elements.get(elementId);
      if (
        element === undefined ||
        ![x, y, width, height].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
      ) {
        return;
      }
      if (
        element.x !== x ||
        element.y !== y ||
        element.width !== width ||
        element.height !== height
      ) {
        client.transact((tx) => tx.patch(elementId, { x, y, width, height }));
      }
      gestureStream.end({
        kind: "resize",
        phase: "end",
        elementId,
        x,
        y,
        width,
        height,
      });
    },
    [client, gestureStream],
  );

  const tombstone = useCallback(
    (elementIds: readonly string[]): void => {
      client.transact((tx) => {
        for (const elementId of elementIds) tx.remove(elementId);
      });
    },
    [client],
  );

  /**
   * The terminal verbs this canvas offers, dispatched through the ACTION DOOR. A denial is
   * DATA — the declared rule that refused it — so a disabled plugin, a scoped token or a
   * missing capability reads as the door's own sentence instead of an HTTP status nobody
   * can render. Affordances that fire these carry `data-action` (AGENTS invariant 12).
   */
  const dispatchTerminalAction = useCallback(
    (name: string, args: unknown, fallback: string, key: string): void => {
      void client
        .action(name, args)
        .then((outcome) => {
          if (!outcome.ok) notify(outcome.denial.message, { key });
        })
        .catch((reason: unknown) => {
          notify(reason instanceof Error ? reason.message : fallback, { key });
        });
    },
    [client, notify],
  );

  const canvasCenter = useCallback((): { x: number; y: number } => {
    const flow = flowRef.current;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (flow === null || bounds === undefined) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
  }, []);

  /**
   * Which machine a new terminal is born on is `core.terminals`' policy, not the canvas's:
   * this device's memory for this container, then the composed default. The canvas asks the
   * facet and records the answer through it, so the memory has one owner even though two
   * renderers offer the verb. No facet (terminals unregistered or disabled) means no choice to
   * make — the server reads the omission as "wherever you like", and refuses the open itself
   * if the plugin is off (D12).
   */
  const terminals = projection.terminals;
  const createTerminal = useCallback(
    async (machine?: MachineSummary): Promise<void> => {
      if (client.epoch === "") {
        notify("Waiting for the canvas connection", { key: "new-terminal" });
        return;
      }
      const facet = terminals !== null && terminals.enabled ? terminals.facet : null;
      const target = machine ?? facet?.defaultMachine(containerId, machines) ?? null;
      if (target !== null) facet?.rememberMachine(containerId, target.id);
      const elementId = crypto.randomUUID();
      try {
        const terminal = await client.openTerminal({
          elementId,
          cols: 80,
          rows: 24,
          ...(target === null ? {} : { machineId: target.id }),
        });
        // The server created the terminal's home composition with its PTY, so the
        // element this canvas authors is a portal onto that home: on a canvas a
        // terminal IS a solo composition wearing its own chrome.
        client.transact((tx) => {
          tx.create(
            createPortalElement(elementId, terminal.containerId, canvasCenter(), tx.nextZIndex()),
          );
        });
      } catch (reason: unknown) {
        notify(reason instanceof Error ? reason.message : "Could not open a terminal", {
          key: "new-terminal",
        });
      }
    },
    [canvasCenter, client, machines, notify, containerId, terminals],
  );

  const focusElement = useCallback(
    (elementId: string): void => {
      const element = client.elements.get(elementId);
      if (element === undefined) return;
      const flow = flowRef.current;
      if (flow === null) return;
      const zoom = flow.getViewport().zoom;
      void flow.setCenter(element.x + element.width / 2, element.y + element.height / 2, {
        zoom,
        duration: 250,
      });
    },
    [client],
  );

  /**
   * Titlebar rename. The server broadcasts `terminal_event kind:"renamed"` into the
   * room, so every viewer's titlebar follows without a refetch here.
   */
  const onRenameTerminal = useCallback(
    (terminalId: string, name: string): void => {
      dispatchTerminalAction(
        "core.terminals.rename",
        { terminalId, name },
        "Could not rename this terminal",
        `rename-terminal:${terminalId}`,
      );
    },
    [dispatchTerminalAction],
  );

  /**
   * This container's viewport, as the host contract sees it. A plugin never reaches into the
   * renderer: it names a NODE by `manifold://` URI and asks the mounted container view to look at
   * it, which is precisely what a spotlight is. Registered by the ROUTED canvas only — an
   * embedded canvas is not what "the view on screen" means.
   */
  const viewportHandle = useMemo<ViewportHandle>(
    () => ({
      centerOn: (uri: string): void => {
        const ref = parseManifoldUri(uri);
        const flow = flowRef.current;
        if (ref === null || flow === null) return;
        switch (ref.kind) {
          case "element":
            // A reference into another container is the shell's business (navigate), not this view's.
            if (ref.containerId === containerId) focusElement(ref.elementId);
            return;
          case "container":
          case "tile":
            // A canvas holds no tiles, and "look at this canvas" has one honest answer: all
            // of it. Fitting is also what a viewer does when handed an address with no box.
            if (ref.containerId === containerId) void flow.fitView({ duration: 250 });
            return;
          case "terminal": {
            // Terminal → the portal onto its home composition, when this canvas holds one.
            const home = client.terminals.get(ref.terminalId)?.containerId;
            if (home === undefined) return;
            for (const element of client.elements.values()) {
              if (element.type === "portal" && element.containerId === home) {
                focusElement(element.id);
                return;
              }
            }
            return;
          }
          case "principal":
          case "plugin":
          case "action":
            return;
          default: {
            const exhaustive: never = ref;
            return exhaustive;
          }
        }
      },
      viewport: () => flowRef.current?.getViewport() ?? null,
    }),
    [client, focusElement, containerId],
  );

  useEffect(() => {
    if (!routed) return;
    registerViewport(viewportHandle);
    return () => registerViewport(null);
  }, [registerViewport, routed, viewportHandle]);

  /**
   * A view portal's minimize: the WIDGET leaves this canvas and the container it
   * points at is untouched — a shared view is not this canvas's to end, and its
   * sidebar row is how everyone else still reaches it.
   */
  const removeElement = useCallback(
    (elementId: string): void => {
      tombstone([elementId]);
    },
    [tombstone],
  );

  /**
   * A view portal's close: the container itself is deleted (the server frees its
   * occupants) and the portal goes with it, because a portal onto a deleted
   * container is a door into nothing.
   */
  const onDeleteContainer = useCallback(
    (containerId: string, elementId: string): void => {
      void host.client
        .deleteContainer(containerId)
        .then(() => {
          tombstone([elementId]);
        })
        .catch((reason: unknown) => {
          notify(reason instanceof Error ? reason.message : "Could not delete this composition", {
            key: `delete-container:${containerId}`,
          });
        });
    },
    [host.client, notify, tombstone],
  );

  /**
   * Room sockets for the containers portal portals paint. The canvas owns the terminal
   * URL and the token so a portal never rebuilds either.
   *
   * The role is the difference between watching and working. `spectator` is what keeps
   * watching from participating: a resting portal must not fake an occupant avatar, and
   * it must not hold a transient view open — a bubble everyone can see would otherwise
   * be a bubble nobody can pop. Engaging a portal's tile swaps in an `occupant` socket,
   * which is an ordinary room member: writes are accepted, the roster shows the
   * principal, and the view legitimately stays alive while somebody is typing in it.
   */
  const openClient = useCallback(
    (containerId: string, role: ChannelRole) =>
      new SessionClient({
        url: sessionUrl(),
        containerId: containerId,
        token: host.token,
        // Omitted for an occupant: the flag's absence IS the occupant case on the wire.
        ...(role === "spectator" ? { spectator: true } : {}),
      }),
    [host.token],
  );

  /**
   * How many terminals the open container is holding, for the shell's index row. It is the
   * room's OWN terminal table and nothing derived: which terminals a janitor should still OFFER
   * (an exited one with no ref left has no remaining action) is `core.terminals`' policy,
   * and re-deciding it here would be a second answer to a question that already has one.
   */
  const terminalCount = useMemo(() => {
    void sceneRevision;
    return client.terminals.size;
  }, [client, sceneRevision]);

  const createTextAt = useCallback(
    (clientX: number, clientY: number): void => {
      const flow = flowRef.current;
      if (flow === null) return;
      const id = crypto.randomUUID();
      const position = flow.screenToFlowPosition({ x: clientX, y: clientY });
      client.transact((tx) => {
        tx.create(createTextElement(id, position, tx.nextZIndex(), host.principal.color));
      });
      setEditingId(id);
      setTool("select");
    },
    [client, host.principal.color, setEditingId, setTool],
  );

  const completeStroke = useCallback(
    (pointerId: number): void => {
      const stroke = strokeRef.current;
      if (stroke === null || stroke.pointerId !== pointerId) return;
      strokeRef.current = null;
      if (stroke.points.length >= 4) {
        client.transact((tx) => {
          tx.create(
            createDrawElement(
              stroke.id,
              stroke.points,
              host.principal.color,
              DEFAULT_STROKE_WIDTH,
              tx.nextZIndex(),
            ),
          );
        });
      }
      gestureStream.end({
        kind: "draw",
        phase: "end",
        elementId: stroke.id,
        x: stroke.points.at(-2) ?? 0,
        y: stroke.points.at(-1) ?? 0,
      });
      setActiveStrokePoints(null);
      setTool("select");
    },
    [client, gestureStream, host.principal.color, setActiveStrokePoints, setTool],
  );

  const flags = toolFlags(tool);

  /**
   * The canvas's API, and deliberately NOT its polled data: presence rides its own
   * context (see `CanvasPresenceProvider` below), so a poll tick no longer rebuilds
   * this object and re-renders every live terminal on the canvas for it.
   */
  const context = useMemo<CanvasContextValue>(
    () => ({
      carry,
      client,
      host,
      machines,
      onRenameTerminal,
      removeElement,
      onDeleteContainer,
      onResize: handleResize,
      onResizeEnd: handleResizeEnd,
      tool,
      editingId,
      beginTextEditing: setEditingId,
      endTextEditing: (elementId) => {
        setEditingId((current) => (current === elementId ? null : current));
      },
      depth,
      openClient,
      navigate,
      notify,
      containerId,
      dropStore,
      // The index the sidebar fetched, as a lookup: a portal naming a canvas or a
      // composition nested in its own tree reads the same names this canvas does, which
      // is what stopped a displaced view from captioning here and nowhere in a portal.
      containerName: (namedContainerId) =>
        containers.find((candidate) => candidate.id === namedContainerId)?.name ?? null,
      assessDrop: drop.assess,
      // A portal element showing a terminal is a seated carry: its solo home's leaf
      // is the seat a displaced occupant trades into (#62).
      elementSeat: (elementContainerId, elementId) =>
        placementItemFor({ kind: "element", containerId: elementContainerId, elementId }, lookup)
          ?.kind === "terminal",
    }),
    [
      carry,
      client,
      notify,
      lookup,
      drop.assess,
      dropStore,
      containerId,
      containers,
      depth,
      editingId,
      handleResize,
      handleResizeEnd,
      host,
      machines,
      navigate,
      onDeleteContainer,
      onRenameTerminal,
      openClient,
      removeElement,
      tool,
      setEditingId,
    ],
  );

  /*
    What the shell still needs from the live canvas: connection state and the one creation
    verb a section can offer. Only the ROUTED canvas reports: an embedded one is not what "the
    open container" means, and two reporters would fight over one row.
  */
  useEffect(() => {
    if (!routed) return;
    route.onWorkspaceChange({
      status,
      savedAt,
      rev: sceneRevision,
      terminalCount,
      onCreateTerminal: (machine) => void createTerminal(machine),
    });
    return () => route.onWorkspaceChange(null);
  }, [createTerminal, route, routed, savedAt, sceneRevision, terminalCount, status]);

  useEffect(() => {
    if (!debugProbeEnabled()) return;
    window.__manifold = {
      scene: () => [...client.elements.values()].map(toElementSnapshot),
      canvas: () => {
        const liveNodes = new Map(
          (flowRef.current?.getNodes() ?? []).map((node) => [node.id, node] as const),
        );
        return [...client.elements.values()].flatMap((element) => {
          const snapshot = toElementSnapshot(element);
          const node = liveNodes.get(element.id);
          if (node === undefined) return [];
          return [
            {
              ...snapshot,
              x: node.position.x,
              y: node.position.y,
              width: node.width ?? node.measured?.width ?? snapshot.width,
              height: node.height ?? node.measured?.height ?? snapshot.height,
            },
          ];
        });
      },
      outbox: () => client.outboxSize(),
      rev: () => sceneRevision,
      epoch: () => client.epoch,
      gestures: () =>
        [...remoteGestures.values()].map((gesture) => ({
          elementId: gesture.elementId,
          connId: gesture.connId,
          x: gesture.current.x,
          y: gesture.current.y,
          ...(gesture.carry === undefined ? {} : { carry: gesture.carry.ref.kind }),
        })),
      renders: renderCounts,
      viewport: () => {
        const flow = flowRef.current;
        const bounds = canvasRef.current?.getBoundingClientRect();
        if (flow === null || bounds === undefined) return null;
        const viewport = flow.getViewport();
        return {
          scrollX: viewport.x / viewport.zoom,
          scrollY: viewport.y / viewport.zoom,
          zoom: viewport.zoom,
          offsetLeft: bounds.left,
          offsetTop: bounds.top,
        };
      },
      /**
       * The container CAMERA, verbatim: what `ViewportHandle.viewport()` reports, which is what
       * a spotlight moves. Distinct from `viewport` above, which projects the canvas onto the
       * page for hit-test assertions.
       */
      containerViewport: () => flowRef.current?.getViewport() ?? null,
      lastSpotlight,
    };
    return () => {
      delete window.__manifold;
    };
  }, [client, remoteGestures, sceneRevision]);

  return (
    <div className="canvas-view">
      <div
        className="canvas"
        ref={canvasRef}
        tabIndex={0}
        onDoubleClick={(event) => {
          if (
            !(event.target instanceof Element) ||
            !event.target.classList.contains("react-flow__pane")
          ) {
            return;
          }
          createTextAt(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (isTypingTarget(event.target)) return;
          const modifier = event.ctrlKey || event.metaKey;
          if (modifier && event.key.toLowerCase() === "z") {
            event.preventDefault();
            if (event.shiftKey) client.redo();
            else client.undo();
            return;
          }
          if (!modifier && !event.altKey) {
            const nextTool = toolForKey(event.key);
            // A shortcut naming a tool means nothing while its plugin is off: the key binding
            // is this ref's, the vocabulary is the composition's.
            if (
              nextTool !== null &&
              projection.tools.some((candidate) => candidate.enabled && candidate.id === nextTool)
            ) {
              event.preventDefault();
              setTool(nextTool);
              return;
            }
          }
          if (event.key !== "Delete" && event.key !== "Backspace") return;
          const selected = flowRef.current?.getNodes().filter((node) => node.selected) ?? [];
          if (selected.length === 0) return;
          event.preventDefault();
          /*
            One verb for every species now: Delete removes the REPRESENTATION. A note or
            a stroke exists nowhere else, so that ends it; a portal's portal is only a
            reference, so the composition behind it lives on — and a terminal whose last
            reference goes with it is simply unplaced, since "unplaced" is derived from
            nothing pointing at its home rather than stored anywhere. That is why this is
            an ordinary undoable scene edit and no longer a server round trip.
          */
          tombstone(selected.map((node) => node.id));
        }}
        onDragOver={(event) => {
          if (!carriesItem(event.dataTransfer)) return;
          // Claimed even when refused: keeping the gesture lets the target paint the RULE
          // instead of the browser silently showing a no-drop cursor with no explanation.
          event.preventDefault();
          carryingRef.current = true;
          const flow = flowRef.current;
          const at =
            flow === null
              ? null
              : flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          const pane =
            at === null ? null : drop.assess({ kind: "canvas", containerId, x: at.x, y: at.y });
          // Pointer FIRST, then read the answer: this frame's pointer reaches the armed
          // portal's overlay before anything here consults the store, so the aim is one
          // frame behind — the same lag the node-drag transport has, instead of two.
          trackCompose(event.clientX, event.clientY, null);
          const aim = dropStore.get().aim;
          // The carry streams from wherever the pointer IS, so a drag that began on a
          // sidebar row or a portal's tile becomes visible to collaborators the moment
          // it enters this canvas — the same motion a node drag broadcasts.
          if (at !== null) carry.track(at, aim?.tile);
          const verdict = aim !== null ? drop.assess(aim.destination) : pane;
          event.dataTransfer.dropEffect = verdict?.denial == null ? "move" : "none";
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Element && event.currentTarget.contains(next)) return;
          clearCompose();
        }}
        onDrop={(event) => {
          if (!carriesItem(event.dataTransfer)) return;
          event.preventDefault();
          const flow = flowRef.current;
          if (flow === null) return;
          const aim = dropStore.get().aim;
          const transfer = event.dataTransfer;
          clearCompose();
          const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          // Released: the ghost is retired before the write, so nobody watches a carried
          // item hover over a canvas it has already landed on. The payload lives in the
          // transfer, so ending the carry cannot cost the drop its envelope.
          carry.end(at);
          if (aim !== null) {
            drop.commit(transfer, aim.destination);
            return;
          }
          // Bare canvas is the one POLYMORPHIC door: a terminal portals, a container
          // becomes a portal, a tile is extracted, a note or a stroke moves. Which of
          // those it is comes from the declarations, not from a branch here — which is
          // exactly the gap that used to swallow a container dropped on empty canvas.
          drop.commit(transfer, { kind: "canvas", containerId, x: at.x, y: at.y });
        }}
        /*
          The STROKE gesture: what holding the contributed `draw` tool does. The tool's name
          and its button come from the assembly, but the pointer behaviour is still floor
          — `until core.canvas tool-behavior contributions`, when a tool will bring its own
          gesture and this handler will dispatch to it instead of naming an id.
        */
        onPointerDownCapture={(event) => {
          if (tool !== "draw" || event.button !== 0 || isTypingTarget(event.target)) return;
          if (
            event.target instanceof Element &&
            event.target.closest(".canvas-toolbar, .canvas-presence") !== null
          ) {
            return;
          }
          const flow = flowRef.current;
          if (flow === null) return;
          const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          const points: number[] = [];
          appendPoint(points, point.x, point.y);
          strokeRef.current = {
            id: crypto.randomUUID(),
            pointerId: event.pointerId,
            points,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setActiveStrokePoints([...points]);
          event.preventDefault();
        }}
        onPointerMoveCapture={(event) => {
          emitCursor(event.clientX, event.clientY);
          const stroke = strokeRef.current;
          const flow = flowRef.current;
          if (stroke === null || stroke.pointerId !== event.pointerId || flow === null) return;
          const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          if (appendPoint(stroke.points, point.x, point.y)) {
            const points = gesturePoints(stroke.points);
            gestureStream.push({
              kind: "draw",
              phase: "active",
              elementId: stroke.id,
              x: points.at(-2) ?? 0,
              y: points.at(-1) ?? 0,
              points,
            });
            setActiveStrokePoints([...stroke.points]);
          }
        }}
        onPointerUpCapture={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          completeStroke(event.pointerId);
        }}
        onPointerCancelCapture={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          completeStroke(event.pointerId);
        }}
      >
        {/*
          WHO is here, and "look at this" — `core.presence`'s chrome, mounted rather than
          imported. Two named slots: the canvas owns WHERE presence chrome sits on its own
          ref, `core.presence` owns what goes in it, and neither package names the other.
          Only the routed canvas mounts them: an embedded canvas would stack a second island
          and centre a second time for one ask.
        */}
        {routed ? (
          <>
            <div className="canvas-presence">
              <ContainerOverlayOutlet
                slot="container-roster"
                client={client}
                containerId={containerId}
                host={host}
              />
            </div>
            <ContainerOverlayOutlet
              slot="container-spotlight"
              client={client}
              containerId={containerId}
              host={host}
            />
          </>
        ) : null}
        <CanvasToolbar tool={tool} onChange={setTool} />
        <CanvasProviders value={context} presence={presence}>
          {/* Laptop-native gestures (Excalidraw convention): two-finger scroll pans,
              pinch zooms (browsers report trackpad pinch as ctrl+wheel), and plain
              wheel-zoom is off so panning never zooms by surprise. */}
          <ReactFlow
            nodes={nodes}
            edges={NO_EDGES as never[]}
            nodeTypes={nodeTypes}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            defaultViewport={initialViewport}
            onPaneClick={(event) => {
              if (tool === "text") createTextAt(event.clientX, event.clientY);
            }}
            onMove={(_event, viewport) => publishViewport(viewport, false)}
            onMoveEnd={(_event, viewport) => {
              saveViewport(window.localStorage, containerId, viewport);
              publishViewport(viewport, true);
              cursorLastSentRef.current = 0;
              reemitCursor();
            }}
            onNodesChange={handleNodesChange}
            onNodeDragStart={handleNodeDragStart}
            onNodeDrag={handleNodeDrag}
            onSelectionChange={({ nodes: selectedNodes }) => {
              client.sendPresence({
                selection: selectedNodes.map((node) => node.id),
                vantage: currentVantage(),
              });
            }}
            onNodeDragStop={handleNodeDragStop}
            nodesDraggable={flags.nodesDraggable}
            panOnDrag={flags.panOnDrag}
            elementsSelectable={flags.elementsSelectable}
            zIndexMode="manual"
            onlyRenderVisibleElements={false}
            nodesConnectable={false}
            connectOnClick={false}
            deleteKeyCode={null}
            selectionKeyCode="Shift"
            multiSelectionKeyCode="Shift"
            panActivationKeyCode={null}
            zoomActivationKeyCode={null}
            zoomOnDoubleClick={false}
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            nodeDragThreshold={2}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            proOptions={PRO_OPTIONS}
          >
            <ViewportPortal>
              <div className="canvas-presence-layer" style={{ zIndex: presenceZIndex }}>
                {activeStrokePoints === null ? null : (
                  <svg className="stroke-preview" overflow="visible">
                    <path
                      d={pointsToPath(activeStrokePoints)}
                      stroke={host.principal.color}
                      strokeWidth={DEFAULT_STROKE_WIDTH}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {[...remoteGestures.values()].map((gesture) => {
                  if (gesture.kind !== "draw" || gesture.points === undefined) return null;
                  return (
                    <svg
                      className="stroke-preview"
                      data-gesture-element={gesture.elementId}
                      key={`${gesture.connId}:${gesture.elementId}`}
                      overflow="visible"
                    >
                      <path
                        d={pointsToPath(gesture.points)}
                        stroke={carrierColor(client, gesture.principalId)}
                        strokeWidth={DEFAULT_STROKE_WIDTH}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  );
                })}
                {remoteSelections.map((selection) => (
                  <div
                    className="remote-selection"
                    key={selection.key}
                    style={{
                      borderColor: selection.color,
                      height: selection.height,
                      transform: `translate(${String(selection.x)}px, ${String(selection.y)}px)`,
                      width: selection.width,
                    }}
                  />
                ))}
                {/*
                  A collaborator's carry, drawn where their pointer holds it. Only for
                  items this canvas does NOT already draw: an element carried across it
                  IS its own ghost, moving live under their cursor.
                */}
                {remoteCarries.map((ghost) => (
                  <div
                    className="carry-ghost"
                    data-carry-kind={ghost.kind}
                    key={ghost.key}
                    style={{
                      borderColor: carrierColor(client, ghost.principalId),
                      transform: `translate(${String(ghost.x)}px, ${String(ghost.y)}px)`,
                    }}
                  >
                    <span className="carry-ghost__glyph" aria-hidden="true">
                      <CarriedItemIcon kind={ghost.kind} size={12} />
                    </span>
                    <span className="carry-ghost__label">{ghost.label}</span>
                  </div>
                ))}
                {remoteCursors.cursors.map((cursor) => {
                  const color = remoteCursors.colorFor(cursor);
                  return (
                    <div
                      className="remote-cursor"
                      data-cursor-color={color ?? ""}
                      key={remoteCursorSocketId(cursor.principalId, cursor.connId)}
                      style={{
                        color: color ?? REMOTE_CURSOR_FALLBACK_COLOR,
                        transform: `translate(${String(cursor.x)}px, ${String(cursor.y)}px)`,
                      }}
                    >
                      <RemoteCursorIcon />
                      <span>{remoteCursors.labelFor(cursor)}</span>
                    </div>
                  );
                })}
              </div>
            </ViewportPortal>
          </ReactFlow>
        </CanvasProviders>
      </div>
    </div>
  );
}
