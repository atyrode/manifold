import {
  CURSOR_MIN_INTERVAL_MS,
  MAX_GESTURE_POINT_VALUES,
  VIEWPORT_MIN_INTERVAL_MS,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PlacementDestination,
  type PlacementItem,
  type TileEdge,
} from "@manifold/protocol";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import {
  ReactFlow,
  ViewportPortal,
  useNodesState,
  type Node,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deletePad, getMachines, killTerminal, renameTerminal } from "./api.ts";
import type { StoredIdentity } from "./api.ts";
import { CanvasToolbar } from "./canvas-toolbar.tsx";
import { toolFlags, toolForKey, type CanvasTool } from "./canvas-tool.ts";
import { debugSeamEnabled, renderCounts, toElementSnapshot } from "./debug-seam.ts";
import { remoteCursorSocketId } from "./cursor-identity.ts";
import { DrawNode } from "./flow-draw-node.tsx";
import { MONO_PORTAL_CLASS_SELECTOR, PORTAL_DRAG_HANDLE, PortalNode } from "./flow-portal-node.tsx";
import {
  FlowPadProviders,
  TERMINAL_DRAG_HANDLE,
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
import {
  createPlacementLookup,
  denialMessage,
  useItemDrop,
  type ItemDropAssessment,
} from "./item-drop.ts";
import { carriesItem, type ItemEnvelope } from "./item-envelope.ts";
import { sessionMachine } from "./machine-visibility.ts";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { deriveRosterRows, type RosterRow } from "./roster-model.ts";
import { carryGhosts } from "./carry.ts";
import { useCarry, useRemoteGestures } from "./use-carry.ts";
import { loadViewport, saveViewport } from "./viewport-memory.ts";
import { buildSessionRows } from "./session-inventory.ts";
import { PresenceIsland, type WorkspaceSidebarState } from "./top-right.tsx";
import { appendPoint, DEFAULT_STROKE_WIDTH, pointsToPath } from "./stroke.ts";
import { composeTargetAt, previewRect, snapZone } from "./tile-snap.ts";
import { useToast } from "./toast.tsx";
import { REMOTE_CURSOR_FALLBACK_COLOR, useRemoteCursors } from "./use-remote-cursors.ts";
import type { WidgetRole } from "./widget-engagement.ts";

/**
 * React Flow is manifold's pad renderer. Native terminal scene records project directly
 * into React Flow nodes.
 */

/** Stable module-scope identity prevents React Flow from remounting live PTYs. */
const NODE_TYPES: NodeTypes = {
  text: TextNode,
  draw: DrawNode,
  portal: PortalNode,
};
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
 * How long a dragged surface must hover a node before the canvas offers to compose.
 * Long enough that dragging a terminal PAST another one on the way somewhere else
 * never arms; short enough that deliberately holding it there feels immediate.
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

/**
 * The armed drop: the node that morphed into composition chrome, the zone it will split
 * on, and what the pipeline says about it. A REFUSED arm is still armed — the target wears
 * the refusal instead of the preview, so the viewer learns the rule before releasing.
 */
interface ComposeArmed {
  readonly elementId: string;
  readonly zone: TileEdge;
  readonly assessment: ItemDropAssessment | null;
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
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
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
  const [composeArmed, setComposeArmed] = useState<ComposeArmed | null>(null);
  /**
   * The compose gesture runs off refs, not state: it is driven by drag frames and
   * read by the release handler, and re-rendering the canvas on every hover frame
   * would put the xterm subtrees back into the drag hot path. Only the armed drop
   * — a rare, deliberate transition — reaches React state, where it stamps the
   * hovered node's data and paints the preview overlay.
   */
  const composeArmedRef = useRef<ComposeArmed | null>(null);
  const composeCandidateRef = useRef<string | null>(null);
  const composeZoneRef = useRef<TileEdge | null>(null);
  const composeTimerRef = useRef<number | null>(null);
  /** True while a gesture is over this canvas; the WHAT lives in the carry register. */
  const carryingRef = useRef(false);
  const projectedRef = useRef<readonly ProjectedNode[]>([]);
  const initialViewport = useMemo(
    () => loadViewport(window.localStorage, padId) ?? { x: 0, y: 0, zoom: 1 },
    [padId],
  );

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
      client.sendPresence({ viewport });
    },
    [client],
  );

  const projected = useMemo(() => {
    void sceneRevision;
    return projectElements(client.elements, remoteGestures);
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

  /** A carrier's chosen color, so a ghost belongs to the same person as their cursor. */
  const carrierColor = useCallback(
    (principalId: string): string =>
      client.roster.get(principalId)?.principal.color ?? REMOTE_CURSOR_FALLBACK_COLOR,
    [client],
  );

  /**
   * The half the dropped surface would take over on the armed target, drawn in flow
   * coordinates beside the other presence overlays so it tracks pan and zoom for free.
   * A REFUSED arm paints the same box in the refusal style with the rule's prose in it,
   * so the viewer reads why before releasing rather than after.
   */
  const composePreview = useMemo(() => {
    if (composeArmed === null) return null;
    const target = projected.find((element) => element.id === composeArmed.elementId);
    if (target === undefined) return null;
    const rect = previewRect(
      { x: target.position.x, y: target.position.y, width: target.width, height: target.height },
      composeArmed.zone,
    );
    return { rect, denied: composeArmed.assessment?.message ?? null };
  }, [composeArmed, projected]);

  /**
   * The canonical projection carries no live-gesture geometry: `reconcileNodes` reuses the
   * node React Flow is dragging or resizing verbatim, so the pointer is tracked by React
   * Flow's own array and this memo only rebuilds when the scene or highlight actually moves.
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
        selected: element.id === highlightedId,
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
        // The armed compose zone rides in node data so only the hovered node
        // re-renders into view chrome (`reconcileNodes` reuses every other object).
        data:
          composeArmed?.elementId === element.id
            ? { ...element.data, composeZone: composeArmed.zone }
            : element.data,
      })),
    [composeArmed, highlightedId, projected],
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

  const clearCompose = useCallback((): void => {
    if (composeTimerRef.current !== null) {
      window.clearTimeout(composeTimerRef.current);
      composeTimerRef.current = null;
    }
    carryingRef.current = false;
    composeCandidateRef.current = null;
    composeZoneRef.current = null;
    composeArmedRef.current = null;
    setComposeArmed(null);
  }, []);

  /**
   * The destination an armed drop on `elementId` means. Always `compose`: the executor
   * turns a drop on a WIDGET into a plain tile add against the composition it points at,
   * so "compositions never nest" stays a declaration instead of a branch here.
   */
  const composeDestination = useCallback(
    (elementId: string, zone: TileEdge): PlacementDestination => ({
      kind: "compose",
      padId,
      targetElementId: elementId,
      edge: zone,
    }),
    [padId],
  );

  /**
   * One frame of the compose gesture: find the node under the pointer, hold it for
   * COMPOSE_ARM_MS, then arm the drop. Moving to another node restarts the hold and
   * leaving every node disarms, so dragging PAST a terminal never composes onto it.
   *
   * An arm carries the pipeline's verdict, so a refused pair still arms and shows the
   * declared rule rather than pretending the gesture is available.
   */
  const trackCompose = useCallback(
    (clientX: number, clientY: number, sourceElementId: string | null): void => {
      const flow = flowRef.current;
      if (flow === null || !carryingRef.current) return;
      const point = flow.screenToFlowPosition({ x: clientX, y: clientY });
      const target = composeTargetAt(projectedRef.current, point, sourceElementId);
      if (target === null) {
        if (composeCandidateRef.current === null) return;
        if (composeTimerRef.current !== null) {
          window.clearTimeout(composeTimerRef.current);
          composeTimerRef.current = null;
        }
        composeCandidateRef.current = null;
        composeZoneRef.current = null;
        composeArmedRef.current = null;
        setComposeArmed(null);
        return;
      }
      const zone = snapZone(
        { x: target.position.x, y: target.position.y, width: target.width, height: target.height },
        point,
      );
      if (zone === null) return;
      composeZoneRef.current = zone;
      const arm = (heldZone: TileEdge): ComposeArmed => ({
        elementId: target.id,
        zone: heldZone,
        assessment: drop.assess(composeDestination(target.id, heldZone)),
      });
      if (composeCandidateRef.current === target.id) {
        const armed = composeArmedRef.current;
        if (armed === null || armed.zone === zone) return;
        const rezoned = arm(zone);
        composeArmedRef.current = rezoned;
        setComposeArmed(rezoned);
        return;
      }
      composeCandidateRef.current = target.id;
      composeArmedRef.current = null;
      setComposeArmed(null);
      if (composeTimerRef.current !== null) window.clearTimeout(composeTimerRef.current);
      // The hold is timed, not sampled: a pointer that stops moving over a target
      // still arms, because drag frames stop arriving the moment it settles.
      composeTimerRef.current = window.setTimeout(() => {
        composeTimerRef.current = null;
        const heldZone = composeZoneRef.current;
        if (!carryingRef.current || composeCandidateRef.current !== target.id) return;
        if (heldZone === null) return;
        const armed = arm(heldZone);
        composeArmedRef.current = armed;
        setComposeArmed(armed);
      }, COMPOSE_ARM_MS);
    },
    [composeDestination, drop],
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
      carry.track({ x: node.position.x, y: node.position.y });
    },
    [carry, trackCompose],
  );

  const handleNodeDragStop = useCallback(
    (event: MouseEvent | TouchEvent, node: Node): void => {
      const element = client.elements.get(node.id);
      const armed = composeArmedRef.current;
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
      // Composed: the server rewrites both placements (the target becomes a portal, this
      // element is consumed), so the geometry this drag produced is dropped. A REFUSED arm
      // reports its rule and mutates nothing — the pipeline decides, not this handler.
      if (armed !== null) {
        drop.commit(null, composeDestination(armed.elementId, armed.zone));
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
    [carry, clearCompose, client, composeDestination, drop, isOverSidebar],
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
   * X is the deliberate destroy — park is the non-destructive exit. Kill goes over
   * HTTP: the wire's terminal_kill is gated on the session's HOME channel, which a
   * canvas peer does not hold. The server sweeps session + home + every portal
   * atomically; the local tombstone is optimism so the element vanishes this frame
   * rather than a round-trip later (the doc sweep makes it idempotent).
   */
  const onClose = useCallback(
    (elementId: string | null, sessionId: string): void => {
      if (elementId !== null) tombstone([elementId]);
      void killTerminal(identity.token, sessionId).catch((reason: unknown) => {
        notify(reason instanceof Error ? reason.message : "Could not kill the terminal", {
          key: `terminal-kill:${sessionId}`,
        });
      });
    },
    [identity.token, notify, tombstone],
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
      void renameTerminal(identity.token, sessionId, name).catch((reason: unknown) => {
        notify(reason instanceof Error ? reason.message : "Could not rename this terminal", {
          key: `rename-terminal:${sessionId}`,
        });
      });
    },
    [identity.token, notify],
  );

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
        selfCaps: client.selfCaps,
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
      onClose,
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
    }),
    [
      carry,
      client,
      notify,
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

  useEffect(() => {
    onWorkspaceChange({
      status,
      savedAt,
      rev: sceneRevision,
      machines,
      rows: sessionRows,
      onCreateTerminal: (machine) => void createTerminal(machine),
      onFocus: focusElement,
      onKill: (sessionId) => onClose(null, sessionId),
      onRemoveCopy: (_sessionId, elementId) => tombstone([elementId]),
      onRemoveAllCopies: (sessionId) => {
        const row = sessionRows.find((candidate) => candidate.id === sessionId);
        tombstone(row?.boundElementIds ?? []);
      },
      onHighlight: setHighlightedId,
    });
  }, [
    client,
    createTerminal,
    focusElement,
    machines,
    onWorkspaceChange,
    savedAt,
    sceneRevision,
    sessionRows,
    status,
    tombstone,
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
            if (nextTool !== null) {
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
          // The carry streams from wherever the pointer IS, so a drag that began on a
          // sidebar row or a widget's tile becomes visible to collaborators the moment
          // it enters this canvas — the same motion a node drag broadcasts.
          if (at !== null) carry.track(at);
          trackCompose(event.clientX, event.clientY, null);
          const armed = composeArmedRef.current;
          const verdict = armed?.assessment ?? pane;
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
          const armed = composeArmedRef.current;
          const transfer = event.dataTransfer;
          clearCompose();
          const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          // Released: the ghost is retired before the write, so nobody watches a carried
          // item hover over a canvas it has already landed on. The payload lives in the
          // transfer, so ending the carry cannot cost the drop its envelope.
          carry.end(at);
          if (armed !== null) {
            drop.commit(transfer, composeDestination(armed.elementId, armed.zone));
            return;
          }
          // Bare canvas is the one POLYMORPHIC door: a terminal portals, a container
          // becomes a portal, a tile is extracted, a note or a stroke moves. Which of
          // those it is comes from the declarations, not from a branch here — which is
          // exactly the gap that used to swallow a container dropped on empty canvas.
          drop.commit(transfer, { kind: "canvas", padId, x: at.x, y: at.y });
        }}
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
        <CanvasToolbar tool={tool} onChange={setTool} />
        <FlowPadProviders value={context} presence={presence}>
          {/* Laptop-native gestures (Excalidraw convention): two-finger scroll pans,
              pinch zooms (browsers report trackpad pinch as ctrl+wheel), and plain
              wheel-zoom is off so panning never zooms by surprise. */}
          <ReactFlow
            nodes={nodes}
            edges={NO_EDGES as never[]}
            nodeTypes={NODE_TYPES}
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
              client.sendPresence({ selection: selectedNodes.map((node) => node.id) });
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
                {composePreview === null ? null : (
                  <div
                    className={`flow-compose-preview${composePreview.denied === null ? "" : " is-denied"}`}
                    style={{
                      height: composePreview.rect.height,
                      transform: `translate(${String(composePreview.rect.x)}px, ${String(composePreview.rect.y)}px)`,
                      width: composePreview.rect.width,
                    }}
                  >
                    {composePreview.denied === null ? null : (
                      <span className="drop-denial-note">{composePreview.denied}</span>
                    )}
                  </div>
                )}
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
                      borderColor: carrierColor(ghost.principalId),
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
