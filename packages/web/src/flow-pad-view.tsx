import {
  CURSOR_MIN_INTERVAL_MS,
  MAX_GESTURE_POINT_VALUES,
  VIEWPORT_MIN_INTERVAL_MS,
  parseManifoldUri,
  placementItemFor,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PlacementDestination,
  type PlacementItem,
} from "@manifold/protocol";
import type { PadViewportHandle } from "@manifold/plugin";
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
import { deletePad, getMachines } from "./api.ts";
import type { StoredIdentity } from "./api.ts";
import { CanvasToolbar } from "./canvas-toolbar.tsx";
import { FLOOR_TOOLS, toolFlags, toolForKey, type CanvasTool } from "./canvas-tool.ts";
import {
  debugSeamEnabled,
  lastSpotlight,
  renderCounts,
  toElementSnapshot,
} from "./debug-seam.ts";
import { remoteCursorSocketId } from "./cursor-identity.ts";
import {
  PluginPlaceholder,
  useComposition,
  useViewportRegistration,
  type PlaceholderState,
  type WebElement,
} from "./plugin-host.tsx";
import { SpotlightChip, useSpotlight } from "./spotlight.tsx";
import { currentViewState, setViewState, subscribeViewState } from "./view-presence.ts";
import { MONO_PORTAL_CLASS_SELECTOR, PORTAL_DRAG_HANDLE, PortalNode } from "./flow-portal-node.tsx";
import {
  FlowPadProviders,
  TERMINAL_DRAG_HANDLE,
  useFlowPad,
  type FlowPadContextValue,
} from "./flow-terminal-node.tsx";
import {
  reconcileNodes,
  createDrawElement,
  createPortalElement,
  createTextElement,
  projectElements,
  type ProjectedNode,
} from "./flow-scene.ts";
import { TextNode } from "./flow-text-node.tsx";
import { createGestureStream, gestureSendIntervalOverride } from "./gesture-stream.ts";
import { RemoteCursorIcon, SurfaceIcon } from "./icons.tsx";
import { createPlacementLookup, denialMessage, useItemDrop } from "./item-drop.ts";
import { carriesItem, type ItemEnvelope } from "./item-envelope.ts";
import { sessionMachine } from "./machine-visibility.ts";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { deriveRosterRows, type RosterRow } from "./roster-model.ts";
import { carryGhosts, remoteTileCarries } from "./carry.ts";
import { useCarry, useRemoteGestures } from "./use-carry.ts";
import { loadViewport, saveViewport } from "./viewport-memory.ts";
import { buildSessionRows } from "./session-inventory.ts";
import { PresenceIsland, type WorkspaceSidebarState } from "./top-right.tsx";
import { appendPoint, DEFAULT_STROKE_WIDTH, pointsToPath } from "./stroke.ts";
import { createTileDropStore } from "./tile-drop-store.ts";
import { composeTargetAt } from "./tile-snap.ts";
import { useToast } from "./toast.tsx";
import {
  carrierColor,
  REMOTE_CURSOR_FALLBACK_COLOR,
  useRemoteCursors,
} from "./use-remote-cursors.ts";
import type { WidgetRole } from "./widget-engagement.ts";

/**
 * React Flow is manifold's pad renderer. Native terminal scene records project directly
 * into React Flow nodes.
 */

/** The node species the ENGINE renders. Everything else arrives from the composition. */
const FLOOR_NODE_TYPES: NodeTypes = {
  text: TextNode,
  portal: PortalNode,
};

/** Contributed ink may shrink to a thumbnail, so the resize floor is deliberately tiny. */
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
 * What a change in the element registry MEANS for React Flow: the ordered list of element
 * types, whether each is enabled, and which component is attached. Toggling an unrelated
 * plugin (`core.machines`, say) leaves this string identical, which is what keeps a terminal
 * from being remounted — and reattached — by an administrator flipping a sidebar section.
 */
function elementRegistrySignature(elements: ReadonlyMap<string, WebElement>): string {
  const parts: string[] = [];
  for (const [type, element] of elements) {
    parts.push(`${type}:${element.enabled ? "1" : "0"}:${componentTag(element.Component)}`);
  }
  return parts.join("|");
}

/**
 * The paint boundary for a contributed element. Geometry stays ENGINE business — one
 * resizer, one selection rule, one commit path for every species — so a plugin's renderer
 * paints its own `data` and never learns how a scene document is written.
 */
function pluginElementNode(Component: ComponentType<never>): ComponentType<NodeProps> {
  /*
    The ONE cast at this boundary. `WebPluginDef.elements` are deliberately opaque
    (`ComponentType<never>`): a React Flow node component's props are the renderer's own
    contract, and the flow paint boundary is the single place allowed to name them.
  */
  const Painter = Component as unknown as ComponentType<NodeProps>;
  return memo(function PluginElementNode(props: NodeProps) {
    const pad = useFlowPad();
    return (
      <>
        {/* Ink and text keep the classic bounding-box handles; only terminals grab by border. */}
        <NodeResizer
          nodeId={props.id}
          isVisible={pad.tool === "select" && props.selected === true}
          minWidth={MIN_PLUGIN_ELEMENT_SIZE}
          minHeight={MIN_PLUGIN_ELEMENT_SIZE}
          onResize={(_event, params) =>
            pad.onResize(props.id, params.x, params.y, params.width, params.height)
          }
          onResizeEnd={(_event, params) =>
            pad.onResizeEnd(props.id, params.x, params.y, params.width, params.height)
          }
        />
        <Painter {...props} />
      </>
    );
  });
}

/**
 * An element whose plugin is off — or which declares a renderer nobody registered — draws
 * the shared inert surface NAMING it. A stroke authored while `core.draw` was on must not
 * vanish when somebody disables the plugin: the scene still holds it, so the canvas says so
 * (D4), and enabling the plugin brings the ink back without a reload (R3).
 */
function pluginPlaceholderNode(name: string, state: PlaceholderState): ComponentType<NodeProps> {
  return memo(function PluginElementPlaceholderNode() {
    return <PluginPlaceholder name={name} state={state} />;
  });
}

function buildNodeTypes(
  elements: ReadonlyMap<string, WebElement>,
  pluginTitle: (id: string) => string | null,
): NodeTypes {
  const contributed: Record<string, ComponentType<NodeProps>> = {};
  for (const [type, element] of elements) {
    const name = pluginTitle(element.plugin) ?? element.plugin;
    if (!element.enabled) {
      contributed[type] = pluginPlaceholderNode(name, "disabled");
    } else if (element.Component === null) {
      contributed[type] = pluginPlaceholderNode(name, "unavailable");
    } else {
      contributed[type] = pluginElementNode(element.Component);
    }
  }
  // Floor species last: the engine's own renderers are not overridable by a manifest that
  // happens to declare their wire type (D5 refuses plugin/plugin collisions; this refuses
  // plugin-over-engine shadowing at the one place it could bite).
  return { ...contributed, ...FLOOR_NODE_TYPES };
}
/**
 * A canvas cannot DERIVE solo occupancy: it holds elements, not tile layouts, and the
 * containers its portals point at belong to rooms it has not joined. Its host supplies
 * the answer instead ({@link FlowPadViewProps.soloOccupants}); this is the fallback for
 * a canvas mounted without one — an embedded board inside a composition tile.
 */
const NO_SOLO_OCCUPANTS: ReadonlyMap<string, PlacementItem> = new Map();
const NO_EDGES: readonly never[] = Object.freeze([]);
const ROUND_GESTURE_COORDINATE = 10;
const PRO_OPTIONS = Object.freeze({ hideAttribution: true });
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
/**
 * How long a dragged surface must hover a node before the canvas arms it as a drop
 * target. Long enough that dragging a terminal PAST another one on the way somewhere
 * else never arms; short enough that deliberately holding it there feels immediate.
 * The armed widget's own overlay resolves WHICH zone and WHAT releasing means; the
 * canvas only decides WHICH widget is armed. Once armed, zone changes are immediate.
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

interface FlowPadViewProps {
  readonly padId: string;
  readonly identity: StoredIdentity;
  readonly onWorkspaceChange: (workspace: WorkspaceSidebarState | null) => void;
  /** Pushes a route: expanding a terminal and entering a portal both navigate. */
  readonly navigate: (path: string) => void;
  /** Polled principal-level presence; portal widgets show their container's occupants. */
  readonly presence: readonly PadPresence[];
  /**
   * Every container the sidebar indexes. The canvas needs it to answer the algebra's
   * discipline question locally: without it a drag preview could not tell a canvas from a
   * composition, which is why the compose target used to disagree with the tile target.
   */
  readonly pads: readonly Pad[];
  /**
   * What each container holds when it holds exactly ONE item — the index's own solo-comp
   * fold, handed down because the canvas cannot compute it (see {@link NO_SOLO_OCCUPANTS}).
   * This is what makes "compositions merge, never nest" resolve the same way here as on
   * the server: without it every portal reads as a real composition and terminal-onto-
   * terminal compose is refused `not_solo` — the canvas-side door into a composition.
   */
  readonly soloOccupants?: ReadonlyMap<string, PlacementItem>;
  /**
   * True when a client point lands on the workspace sidebar. Supplied by the sidebar
   * host so dropping a terminal there parks it instead of committing the drag.
   */
  readonly isOverSidebar?: (clientX: number, clientY: number) => boolean;
  /**
   * Container nesting depth of this canvas: 1 when it is the routed pad, 2 when it
   * is embedded in a container. Portals render live above the depth-2 floor only.
   */
  readonly depth?: number;
}

interface RemoteSelectionRect {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

export function sessionUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/session`;
}

export function FlowPadView({
  padId,
  identity,
  onWorkspaceChange,
  navigate,
  presence,
  pads,
  isOverSidebar,
  soloOccupants = NO_SOLO_OCCUPANTS,
  depth = 1,
}: FlowPadViewProps) {
  const { notify } = useToast();
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), padId, token: identity.token }),
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
   * on a sidebar row or a widget's tile is ADOPTED as it crosses this canvas, because
   * the item register is process-wide and entering a room is the whole invitation.
   *
   * `describe` is what a viewer will read under the carrier's pointer. This canvas can
   * name things the frame itself cannot — its own sessions, the containers the sidebar
   * indexed — and the name has to travel, since the viewer may share neither.
   */
  const carry = useCarry({
    client,
    describe: (envelope: ItemEnvelope): string | null => {
      switch (envelope.kind) {
        case "terminal":
          return client.sessions.get(envelope.sessionId)?.name ?? null;
        case "canvas":
        case "composition":
          return pads.find((candidate) => candidate.id === envelope.padId)?.name ?? null;
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
  const [rosterRows, setRosterRows] = useState<readonly RosterRow[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
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
   * The per-frame drop channel to this canvas's widget overlays. The compose gesture
   * runs off refs and this store, never React state: it is driven by drag frames, and
   * re-rendering the canvas on every hover frame would put the xterm subtrees back
   * into the drag hot path. Arming only flips `armedElementId`, which repaints the one
   * armed widget's overlay and nothing else.
   */
  const [dropStore] = useState(createTileDropStore);
  /** Which widget is armed right now; mirrored into the store with each frame. */
  const armedElementIdRef = useRef<string | null>(null);
  const composeCandidateRef = useRef<string | null>(null);
  const composeTimerRef = useRef<number | null>(null);
  /** True while a gesture is over this canvas; the WHAT lives in the carry register. */
  const carryingRef = useRef(false);
  const projectedRef = useRef<readonly ProjectedNode[]>([]);
  const initialViewport = useMemo(
    () => loadViewport(window.localStorage, padId) ?? { x: 0, y: 0, zoom: 1 },
    [padId],
  );

  /**
   * The vocabulary this canvas paints with: element renderers and tools are declared by
   * manifests and attached in `composition.ts`, so no plugin is named here.
   */
  const composition = useComposition();
  /** Stable for the host gate's lifetime, so registering is an ordinary effect. */
  const registerViewport = useViewportRegistration();
  const elementSignature = elementRegistrySignature(composition.elements);
  /*
    A derived cache, deliberately not a memo: React Flow remounts every node when
    `nodeTypes` changes identity, and a dependency array containing `composition` would do
    exactly that on any unrelated toggle — reattaching every live PTY on the board because
    somebody hid a sidebar section. The signature IS the dependency.
  */
  const nodeTypesRef = useRef<{ signature: string; value: NodeTypes }>({
    signature: elementSignature,
    value: buildNodeTypes(composition.elements, composition.pluginTitle),
  });
  if (nodeTypesRef.current.signature !== elementSignature) {
    nodeTypesRef.current = {
      signature: elementSignature,
      value: buildNodeTypes(composition.elements, composition.pluginTitle),
    };
  }
  const nodeTypes = nodeTypesRef.current.value;

  /**
   * VIEW STATE, published (A2). One subscription, declared FIRST so the mount-time writes
   * below are already heard: a view change puts the current state on the presence plane
   * through the same door cursors and selections use, and every other writer merges
   * `currentViewState()` into its own payload, so a reconnect republishes it with no second
   * send path.
   *
   * The routed canvas is the one that speaks for this device: an embedded board inside a
   * composition tile holds its own tool, and two publishers of one per-principal state would
   * fight over it. `depth === 1` is that test.
   */
  useEffect(() => {
    if (depth !== 1) return;
    return subscribeViewState((view) => client.sendPresence({ view }));
  }, [client, depth]);

  useEffect(() => {
    if (depth !== 1) return;
    setViewState({ tool });
  }, [depth, tool]);

  useEffect(() => {
    if (depth !== 1) return;
    setViewState({ editingElementId: editingId });
  }, [depth, editingId]);

  /*
    A tool the composition no longer offers cannot stay in the viewer's hand: disabling
    `core.draw` while its tool is held would otherwise leave a pointer authoring elements
    whose renderer is now a placeholder. The hand falls back to select, live (R3).
  */
  useEffect(() => {
    if (FLOOR_TOOLS.includes(tool)) return;
    if (composition.tools.some((candidate) => candidate.enabled && candidate.id === tool)) return;
    setTool("select");
  }, [composition, tool]);

  useEffect(() => {
    const invalidate = (): void => setSceneRevision((value) => value + 1);
    const offScene = client.on("elements_changed", invalidate);
    const offReset = client.on("scene_reset", () => {
      setEditingId(null);
      invalidate();
    });
    const offSessions = client.on("sessions_changed", invalidate);
    const offStatus = client.on("status", setStatus);
    const refreshRoster = (): void => {
      setRosterRows(deriveRosterRows(client.roster.values(), client.self ?? identity.principal));
    };
    const offRoster = client.on("roster_changed", refreshRoster);
    const offSaved = client.on("saved", (message) => setSavedAt(message.at));
    refreshRoster();
    return () => {
      offScene();
      offReset();
      offSessions();
      offStatus();
      offRoster();
      offSaved();
    };
  }, [client, identity.principal]);

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
    void getMachines(identity.token)
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
  }, [identity.token, notify]);

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
      // Every outgoing payload carries the view: presence is merged server-side, so this is
      // also how a reconnected socket re-publishes what this device is holding.
      client.sendPresence({ viewport, view: currentViewState() });
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
   * Remote selection outlines are pure presence. `rosterRows` is rebuilt by `refreshRoster`
   * on every `roster_changed`, which the SDK emits for each `presence` frame — selection
   * payloads included — so it is the dependency that provably invalidates this, and a purely
   * local drag frame no longer walks the roster at all.
   */
  const remoteSelections = useMemo<readonly RemoteSelectionRect[]>(() => {
    void rosterRows;
    const rects: RemoteSelectionRect[] = [];
    const projectedById = new Map(projected.map((element) => [element.id, element] as const));
    for (const viewer of client.roster.values()) {
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
  }, [client, projected, rosterRows]);

  /**
   * The carries this canvas owes a ghost. An element of THIS pad is excluded on purpose:
   * its override already moves the element itself, so the source container mutates live
   * under the carrier's pointer and a chip on top would draw the same object twice.
   */
  const remoteCarries = useMemo(
    () =>
      carryGhosts(
        remoteGestures.values(),
        (surface) =>
          surface.kind === "element" &&
          surface.padId === padId &&
          client.elements.has(surface.elementId),
      ),
    [client, padId, remoteGestures],
  );

  // Peers' armed aims, fed to the widget overlays through the same per-frame channel
  // the local pointer uses. Imperative store write: a collaborator's 60 Hz drag
  // repaints the armed overlay alone, never the node tree. Keyed per container, so two
  // peers aiming at two different widgets both preview instead of masking each other —
  // and this canvas's room is only ONE feed: each live widget publishes what its own
  // container's room hears, which is how a route dragger reaches these viewers.
  useEffect(() => {
    dropStore.setRemote(padId, remoteTileCarries(remoteGestures.values()));
  }, [dropStore, padId, remoteGestures]);

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
          A widget moves by its name strip, and its MONO form has no name strip: a solo
          composition wears the terminal's own titlebar instead (the arity rule), so the
          handle is a selector list and the widget's `--mono` class scopes the second arm.
          Without that scope, dragging a tile's titlebar inside a multi-tile widget would
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
        pads,
        self: { padId, layout: "canvas" },
        elements: client.elements,
        // A terminal's home composition is on its session record now, so the canvas can
        // answer "where does this terminal live" without joining anything.
        terminalHomes: new Map(
          [...client.sessions.values()].map((session) => [session.id, session.padId] as const),
        ),
        // Supplied by the index, which is the only party that can see the arity of a
        // container this canvas merely points at. Handing it down is what lets a canvas
        // drag preview agree with the write the server performs.
        soloOccupants,
      }),
    // `sceneRevision` is the element table's version: the lookup reads it live, and this
    // dependency is what makes a preview see an element authored a moment ago.
    [client, pads, padId, sceneRevision, soloOccupants],
  );

  const drop = useItemDrop({
    lookup,
    place: (surface, destination) => client.place(surface, destination),
    notify,
  });

  /**
   * Unplacing is entirely server-side: the element removal (and the terminal's return to
   * unplaced when this was its last reference) arrives as a normal doc update under a
   * non-local origin, which is also why it is not undoable.
   */
  const parkElement = useCallback(
    async (elementId: string): Promise<void> => {
      if (!client.elements.has(elementId)) return;
      // Addressing the ELEMENT, not the item behind it: a mirrored terminal loses the
      // copy the gesture named and stays placed through its siblings.
      const outcome = await client.place(
        { kind: "element", padId, elementId },
        UNPLACED_DESTINATION,
      );
      if (!outcome.ok) throw new Error(denialMessage(outcome.denial, lookup));
    },
    [client, lookup, padId],
  );

  const onPark = useCallback(
    (elementId: string): void => {
      void parkElement(elementId).catch((reason: unknown) => {
        // One key for every park: a multi-select park that fails N times reads as one row.
        notify(reason instanceof Error ? reason.message : "Could not park this terminal", {
          key: "park",
        });
      });
    },
    [notify, parkElement],
  );

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
   * never fly around inside every widget a drag merely crosses.
   *
   * The canvas decides only WHICH widget is armed. The armed widget's own overlay is
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
        { kind: "element", padId, elementId: node.id },
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
    [carry, client, padId],
  );

  const handleNodeDrag = useCallback(
    (event: MouseEvent | TouchEvent, node: Node): void => {
      if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return;
      const point = dragPoint(event);
      if (point !== null) trackCompose(point.x, point.y, node.id);
      // The armed widget's published aim rides this drag's frames (one frame behind
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
      // Aimed at a widget: the armed overlay resolved and published the destination —
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
      */
      const unplaced =
        point !== null &&
        isOverSidebar?.(point.x, point.y) === true &&
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
    [carry, clearCompose, client, drop, dropStore, isOverSidebar],
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

  const machineFor = useCallback(
    (sessionId: string) => {
      const session = client.sessions.get(sessionId);
      return session === undefined ? null : sessionMachine(machines, session.machineId);
    },
    [client, machines],
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

  const createTerminal = useCallback(
    async (machine?: MachineSummary): Promise<void> => {
      if (client.epoch === "") {
        notify("Waiting for the canvas connection", { key: "new-terminal" });
        return;
      }
      const target =
        machine ??
        (machines === null
          ? null
          : chooseDefaultMachine(machines, recallMachine(browserMachineStorage(), padId)));
      if (target !== null) {
        rememberMachine(browserMachineStorage(), padId, target.id);
      }
      const elementId = crypto.randomUUID();
      try {
        const session = await client.openTerminal({
          elementId,
          cols: 80,
          rows: 24,
          ...(target === null ? {} : { machineId: target.id }),
        });
        // The server created the terminal's home composition with its PTY, so the
        // element this canvas authors is a portal onto that home: on a canvas a
        // terminal IS a solo composition wearing its own chrome.
        client.transact((tx) => {
          tx.create(createPortalElement(elementId, session.padId, canvasCenter(), tx.nextZIndex()));
        });
      } catch (reason: unknown) {
        notify(reason instanceof Error ? reason.message : "Could not open a terminal", {
          key: "new-terminal",
        });
      }
    },
    [canvasCenter, client, machines, notify, padId],
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
   * Titlebar rename. The server broadcasts `session_event kind:"renamed"` into the
   * room, so every viewer's titlebar follows without a refetch here.
   */
  const onRenameTerminal = useCallback(
    (sessionId: string, name: string): void => {
      dispatchTerminalAction(
        "core.terminals.rename",
        { sessionId, name },
        "Could not rename this terminal",
        `rename-terminal:${sessionId}`,
      );
    },
    [dispatchTerminalAction],
  );

  /**
   * This pad's viewport, as the host contract sees it. A plugin never reaches into the
   * renderer: it names a NODE by `manifold://` URI and asks the mounted pad view to look at
   * it, which is precisely what a spotlight is. Registered by the ROUTED canvas only — an
   * embedded board is not what "the view on screen" means.
   */
  const viewportHandle = useMemo<PadViewportHandle>(
    () => ({
      centerOn: (uri: string): void => {
        const ref = parseManifoldUri(uri);
        const flow = flowRef.current;
        if (ref === null || flow === null) return;
        switch (ref.kind) {
          case "element":
            // A reference into another pad is the shell's business (navigate), not this view's.
            if (ref.padId === padId) focusElement(ref.elementId);
            return;
          case "pad":
          case "tile":
            // A canvas holds no tiles, and "look at this canvas" has one honest answer: all
            // of it. Fitting is also what a viewer does when handed an address with no box.
            if (ref.padId === padId) void flow.fitView({ duration: 250 });
            return;
          case "terminal": {
            // Terminal → the portal onto its home composition, when this canvas holds one.
            const home = client.sessions.get(ref.sessionId)?.padId;
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
    [client, focusElement, padId],
  );

  useEffect(() => {
    if (depth !== 1) return;
    registerViewport(viewportHandle);
    return () => registerViewport(null);
  }, [depth, registerViewport, viewportHandle]);

  /**
   * "Look at this", applied. The spotlight arrives in this principal's OWN presence — the
   * server wrote it after checking that the asker shares this room and holds `scene:write`
   * there — so the viewer sees who asked and can switch the whole affordance off.
   */
  const spotlight = useSpotlight(client, viewportHandle, depth === 1);

  /**
   * A view widget's minimize: the WIDGET leaves this canvas and the container it
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
   * A view widget's close: the container itself is deleted (the server frees its
   * occupants) and the widget goes with it, because a portal onto a deleted
   * container is a door into nothing.
   */
  const onDeleteContainer = useCallback(
    (containerId: string, elementId: string): void => {
      void deletePad(identity.token, containerId)
        .then(() => {
          tombstone([elementId]);
        })
        .catch((reason: unknown) => {
          notify(reason instanceof Error ? reason.message : "Could not delete this composition", {
            key: `delete-container:${containerId}`,
          });
        });
    },
    [identity.token, notify, tombstone],
  );

  /**
   * Room sockets for the containers portal widgets paint. The canvas owns the session
   * URL and the token so a widget never rebuilds either.
   *
   * The role is the difference between watching and working. `spectator` is what keeps
   * watching from participating: a resting widget must not fake an occupant avatar, and
   * it must not hold a transient view open — a bubble everyone can see would otherwise
   * be a bubble nobody can pop. Engaging a widget's tile swaps in an `occupant` socket,
   * which is an ordinary room member: writes are accepted, the roster shows the
   * principal, and the view legitimately stays alive while somebody is typing in it.
   */
  const openClient = useCallback(
    (containerId: string, role: WidgetRole) =>
      new SessionClient({
        url: sessionUrl(),
        padId: containerId,
        token: identity.token,
        // Omitted for an occupant: the flag's absence IS the occupant case on the wire.
        ...(role === "spectator" ? { spectator: true } : {}),
      }),
    [identity.token],
  );

  /**
   * Which elements represent which terminal. A canvas references a terminal THROUGH its
   * home composition now, so the chain is portal → home → session; a session whose home
   * this canvas has never heard of simply has no representation to report.
   */
  const liveBindings = useMemo(() => {
    const sessionByHome = new Map<string, string>();
    for (const session of client.sessions.values()) sessionByHome.set(session.padId, session.id);
    const bindings = new Map<string, string[]>();
    for (const element of projected) {
      if (element.type !== "portal") continue;
      const sessionId = sessionByHome.get(element.data.containerId);
      if (sessionId === undefined) continue;
      const ids = bindings.get(sessionId) ?? [];
      ids.push(element.id);
      bindings.set(sessionId, ids);
    }
    return bindings;
  }, [client, projected]);

  const sessionRows = useMemo(
    () =>
      buildSessionRows({
        sessions: [...client.sessions.values()],
        machines,
        liveBindings,
        selfId: client.self?.id ?? null,
        selfCaps: client.selfCaps(),
      }),
    [client, liveBindings, machines],
  );

  const createTextAt = useCallback(
    (clientX: number, clientY: number): void => {
      const flow = flowRef.current;
      if (flow === null) return;
      const id = crypto.randomUUID();
      const position = flow.screenToFlowPosition({ x: clientX, y: clientY });
      client.transact((tx) => {
        tx.create(createTextElement(id, position, tx.nextZIndex(), identity.principal.color));
      });
      setEditingId(id);
      setTool("select");
    },
    [client, identity.principal.color],
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
              identity.principal.color,
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
    [client, gestureStream, identity.principal.color],
  );

  const flags = toolFlags(tool);

  /**
   * The canvas's API, and deliberately NOT its polled data: presence rides its own
   * context (see `FlowPadPresenceProvider` below), so a poll tick no longer rebuilds
   * this object and re-renders every live terminal on the board for it.
   */
  const context = useMemo<FlowPadContextValue>(
    () => ({
      carry,
      client,
      machines,
      machineFor,
      onPark,
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
      token: identity.token,
      openClient,
      navigate,
      notify,
      padId,
      dropStore,
      // The index the sidebar fetched, as a lookup: a widget naming a canvas or a
      // composition nested in its own tree reads the same names this canvas does, which
      // is what stopped a displaced view from captioning here and nowhere in a widget.
      padName: (namedPadId) => pads.find((candidate) => candidate.id === namedPadId)?.name ?? null,
      assessDrop: drop.assess,
      // A portal element showing a terminal is a seated carry: its solo home's leaf
      // is the seat a displaced occupant trades into (#62).
      elementSeat: (elementPadId, elementId) =>
        placementItemFor({ kind: "element", padId: elementPadId, elementId }, lookup)?.kind ===
        "terminal",
    }),
    [
      carry,
      client,
      notify,
      lookup,
      drop.assess,
      dropStore,
      padId,
      pads,
      depth,
      editingId,
      handleResize,
      handleResizeEnd,
      identity.token,
      machineFor,
      machines,
      navigate,
      onDeleteContainer,
      onRenameTerminal,
      openClient,
      removeElement,
      tool,
    ],
  );

  /*
    What the shell still needs from the live canvas: connection state and the one creation
    verb a section can offer. The per-session row callbacks (focus, kill, copy removal,
    highlight) are GONE with the sidebar rows they served — `core.views` and `core.machines`
    render their own rows now and reach the server through the doors directly (D13: deleted
    plumbing is simply deleted).
  */
  useEffect(() => {
    onWorkspaceChange({
      status,
      savedAt,
      rev: sceneRevision,
      rows: sessionRows,
      onCreateTerminal: (machine) => void createTerminal(machine),
    });
  }, [
    createTerminal,
    onWorkspaceChange,
    savedAt,
    sceneRevision,
    sessionRows,
    status,
  ]);

  useEffect(() => () => onWorkspaceChange(null), [onWorkspaceChange]);

  useEffect(() => {
    if (!debugSeamEnabled()) return;
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
          ...(gesture.carry === undefined ? {} : { carry: gesture.carry.surface.kind }),
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
       * The pad CAMERA, verbatim: what `PadViewportHandle.viewport()` reports, which is what
       * a spotlight moves. Distinct from `viewport` above, which projects the canvas onto the
       * page for hit-test assertions.
       */
      padViewport: () => flowRef.current?.getViewport() ?? null,
      lastSpotlight,
    };
    return () => {
      delete window.__manifold;
    };
  }, [client, remoteGestures, sceneRevision]);

  return (
    <div className="flow-pad-view">
      <div
        className="flow-pad-canvas"
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
            // A shortcut naming a CONTRIBUTED tool means nothing while its plugin is off: the
            // key is floor, the vocabulary is the composition's.
            if (
              nextTool !== null &&
              (FLOOR_TOOLS.includes(nextTool) ||
                composition.tools.some(
                  (candidate) => candidate.enabled && candidate.id === nextTool,
                ))
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
            a stroke exists nowhere else, so that ends it; a widget's portal is only a
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
            at === null ? null : drop.assess({ kind: "canvas", padId, x: at.x, y: at.y });
          // Pointer FIRST, then read the answer: this frame's pointer reaches the armed
          // widget's overlay before anything here consults the store, so the aim is one
          // frame behind — the same lag the node-drag transport has, instead of two.
          trackCompose(event.clientX, event.clientY, null);
          const aim = dropStore.get().aim;
          // The carry streams from wherever the pointer IS, so a drag that began on a
          // sidebar row or a widget's tile becomes visible to collaborators the moment
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
          drop.commit(transfer, { kind: "canvas", padId, x: at.x, y: at.y });
        }}
        /*
          The STROKE gesture: what holding the contributed `draw` tool does. The tool's name
          and its button come from the composition, but the pointer behaviour is still floor
          — `until core.canvas tool-behavior contributions`, when a tool will bring its own
          gesture and this handler will dispatch to it instead of naming an id.
        */
        onPointerDownCapture={(event) => {
          if (tool !== "draw" || event.button !== 0 || isTypingTarget(event.target)) return;
          if (
            event.target instanceof Element &&
            event.target.closest(".flow-toolbar, .flow-presence") !== null
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
        <div className="flow-presence">
          <PresenceIsland rows={rosterRows} />
        </div>
        {spotlight === null ? null : <SpotlightChip spotlight={spotlight} />}
        <CanvasToolbar tool={tool} onChange={setTool} />
        <FlowPadProviders value={context} presence={presence}>
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
              saveViewport(window.localStorage, padId, viewport);
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
                view: currentViewState(),
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
              <div className="flow-presence-layer" style={{ zIndex: presenceZIndex }}>
                {activeStrokePoints === null ? null : (
                  <svg className="flow-stroke-preview" overflow="visible">
                    <path
                      d={pointsToPath(activeStrokePoints)}
                      stroke={identity.principal.color}
                      strokeWidth={DEFAULT_STROKE_WIDTH}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {[...remoteGestures.values()].map((gesture) => {
                  if (gesture.kind !== "draw" || gesture.points === undefined) return null;
                  const principal =
                    rosterRows.find((row) => row.principal.id === gesture.principalId)?.principal ??
                    null;
                  return (
                    <svg
                      className="flow-stroke-preview"
                      data-gesture-element={gesture.elementId}
                      key={`${gesture.connId}:${gesture.elementId}`}
                      overflow="visible"
                    >
                      <path
                        d={pointsToPath(gesture.points)}
                        stroke={principal?.color ?? "#868e96"}
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
                    className="flow-remote-selection"
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
                      <SurfaceIcon kind={ghost.kind} size={12} />
                    </span>
                    <span className="carry-ghost__label">{ghost.label}</span>
                  </div>
                ))}
                {remoteCursors.cursors.map((cursor) => {
                  const color = remoteCursors.colorFor(cursor);
                  return (
                    <div
                      className="flow-remote-cursor"
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
        </FlowPadProviders>
      </div>
    </div>
  );
}
