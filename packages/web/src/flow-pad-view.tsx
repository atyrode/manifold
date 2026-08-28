import {
  CURSOR_MIN_INTERVAL_MS,
  MAX_GESTURE_POINT_VALUES,
  VIEWPORT_MIN_INTERVAL_MS,
  type MachineSummary,
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
import { getMachines } from "./api.ts";
import type { StoredIdentity } from "./api.ts";
import { CanvasToolbar } from "./canvas-toolbar.tsx";
import { toolFlags, toolForKey, type CanvasTool } from "./canvas-tool.ts";
import { debugSeamEnabled, toElementSnapshot } from "./debug-seam.ts";
import {
  recordRemoteCursor,
  remoteCursorSocketId,
  stepRemoteCursors,
  type RemoteCursor,
} from "./cursor-identity.ts";
import { DrawNode } from "./flow-draw-node.tsx";
import {
  FlowPadProvider,
  TERMINAL_DRAG_HANDLE,
  TerminalNode,
  type FlowPadContextValue,
} from "./flow-terminal-node.tsx";
import {
  createDrawElement,
  createTerminalElement,
  createTextElement,
  projectElements,
} from "./flow-scene.ts";
import { TextNode } from "./flow-text-node.tsx";
import { createGestureStream } from "./gesture-stream.ts";
import { sessionMachine } from "./machine-visibility.ts";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { deriveRosterRows, type RosterRow } from "./roster-model.ts";
import {
  applyGestureFrame,
  expireGestures,
  stepGestures,
  type GestureOverride,
} from "./remote-gestures.ts";
import { loadViewport, saveViewport } from "./viewport-memory.ts";
import { buildSessionRows } from "./session-inventory.ts";
import { PresenceIsland, type WorkspaceSidebarState } from "./top-right.tsx";
import { appendPoint, DEFAULT_STROKE_WIDTH, pointsToPath } from "./stroke.ts";

/**
 * React Flow is manifold's pad renderer. Native terminal scene records project directly
 * into React Flow nodes.
 */

/** Stable module-scope identity prevents React Flow from remounting live PTYs. */
const NODE_TYPES: NodeTypes = { terminal: TerminalNode, text: TextNode, draw: DrawNode };
const NO_EDGES: readonly never[] = Object.freeze([]);
const ROUND_GESTURE_COORDINATE = 10;
const PRO_OPTIONS = Object.freeze({ hideAttribution: true });
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("textarea, input, [contenteditable], .xterm") !== null
  );
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
}

interface RemoteSelectionRect {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

interface LocalGestureGeometry {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}

function sessionUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/session`;
}

function gestureIntervalOverride(): number | null {
  const value = Number(import.meta.env["VITE_GESTURE_SEND_MS"]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function FlowPadView({ padId, identity, onWorkspaceChange }: FlowPadViewProps) {
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), padId, token: identity.token }),
  );
  const [gestureStream] = useState(() => {
    const intervalMs = gestureIntervalOverride();
    return createGestureStream({
      ...(intervalMs === null ? {} : { intervalMs }),
      send: (gesture) => client.sendGesture(gesture),
    });
  });
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sceneRevision, setSceneRevision] = useState(0);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  const [rosterRows, setRosterRows] = useState<readonly RosterRow[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeStrokePoints, setActiveStrokePoints] = useState<readonly number[] | null>(null);
  const [remoteGestures, setRemoteGestures] = useState<ReadonlyMap<string, GestureOverride>>(
    new Map(),
  );
  const [localGestures, setLocalGestures] = useState<ReadonlyMap<string, LocalGestureGeometry>>(
    new Map(),
  );
  const mountCountsRef = useRef<Map<string, number>>(new Map());
  const connectStartedRef = useRef(false);
  const remoteCursorsRef = useRef(new Map<string, RemoteCursor>());
  const [remoteCursors, setRemoteCursors] = useState<readonly RemoteCursor[]>([]);
  const remoteGesturesRef = useRef(new Map<string, GestureOverride>());
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
  const updateLocalGesture = useCallback(
    (elementId: string, geometry: LocalGestureGeometry): void => {
      setLocalGestures((current) => {
        const next = new Map(current);
        next.set(elementId, geometry);
        return next;
      });
    },
    [],
  );
  const clearLocalGesture = useCallback((elementId: string): void => {
    setLocalGestures((current) => {
      if (!current.has(elementId)) return current;
      const next = new Map(current);
      next.delete(elementId);
      return next;
    });
  }, []);
  const initialViewport = useMemo(
    () => loadViewport(window.localStorage, padId) ?? { x: 0, y: 0, zoom: 1 },
    [padId],
  );

  useEffect(() => {
    const invalidate = (): void => setSceneRevision((value) => value + 1);
    const offScene = client.on("elements_changed", invalidate);
    const offReset = client.on("scene_reset", () => {
      setEditingId(null);
      remoteGesturesRef.current.clear();
      setRemoteGestures(new Map());
      invalidate();
    });
    const offSessions = client.on("sessions_changed", invalidate);
    const offStatus = client.on("status", setStatus);
    const refreshRoster = (): void => {
      const connected = new Set(client.roster.keys());
      for (const [socketId, cursor] of remoteCursorsRef.current) {
        if (!connected.has(cursor.principalId)) remoteCursorsRef.current.delete(socketId);
      }
      setRemoteCursors([...remoteCursorsRef.current.values()]);
      setRosterRows(deriveRosterRows(client.roster.values(), client.self ?? identity.principal));
    };
    const offRoster = client.on("roster_changed", refreshRoster);
    const offCursor = client.on("cursor", (message) => {
      if (recordRemoteCursor(remoteCursorsRef.current, message, client.selfConnId)) {
        setRemoteCursors([...remoteCursorsRef.current.values()]);
      }
    });
    const offGesture = client.on("gesture", (message) => {
      if (
        applyGestureFrame(remoteGesturesRef.current, message, client.selfConnId, performance.now())
      ) {
        setRemoteGestures(new Map(remoteGesturesRef.current));
      }
    });
    refreshRoster();
    return () => {
      offScene();
      offReset();
      offSessions();
      offStatus();
      offRoster();
      offCursor();
      offGesture();
    };
  }, [client, identity.principal]);

  useEffect(() => {
    let animationFrame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const elapsed = Math.max(0, now - previous);
      previous = now;
      const gesturesChanged = stepGestures(remoteGesturesRef.current, elapsed);
      const gesturesExpired = expireGestures(remoteGesturesRef.current, now);
      if (gesturesChanged || gesturesExpired) {
        setRemoteGestures(new Map(remoteGesturesRef.current));
      }
      if (stepRemoteCursors(remoteCursorsRef.current, elapsed)) {
        setRemoteCursors([...remoteCursorsRef.current.values()]);
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => () => gestureStream.cancel(), [gestureStream]);

  useEffect(() => {
    if (connectStartedRef.current) return;
    connectStartedRef.current = true;
    void client.connect().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not connect to pad");
    });
    return () => client.close();
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void getMachines(identity.token)
      .then((fetched) => {
        if (!cancelled) setMachines(fetched);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not load machines");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [identity.token]);

  const emitCursor = useCallback(
    (clientX: number, clientY: number): void => {
      lastClientRef.current = { x: clientX, y: clientY };
      const now = performance.now();
      if (now - cursorLastSentRef.current < CURSOR_MIN_INTERVAL_MS) return;
      const flow = flowRef.current;
      if (flow === null) return;
      cursorLastSentRef.current = now;
      const position = flow.screenToFlowPosition({ x: clientX, y: clientY });
      client.sendCursor(position.x, position.y, "pointer");
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

  const remoteSelections: RemoteSelectionRect[] = [];
  const projectedById = new Map(projected.map((element) => [element.id, element] as const));
  for (const presence of client.roster.values()) {
    if (presence.principal.id === client.self?.id) continue;
    for (const elementId of presence.payload.selection ?? []) {
      const element = projectedById.get(elementId);
      if (element === undefined) continue;
      remoteSelections.push({
        key: `${presence.principal.id}:${elementId}`,
        x: element.position.x,
        y: element.position.y,
        width: element.width,
        height: element.height,
        color: presence.principal.color,
      });
    }
  }

  const canonicalNodes = useMemo<Node[]>(
    () =>
      projected.map((element) => {
        const local = localGestures.get(element.id);
        return {
          id: element.id,
          type: element.type,
          position: local === undefined ? element.position : { x: local.x, y: local.y },
          width: local?.width ?? element.width,
          height: local?.height ?? element.height,
          zIndex: element.zIndex,
          selected: element.id === highlightedId,
          ...(element.type === "terminal" ? { dragHandle: TERMINAL_DRAG_HANDLE } : {}),
          data: element.data,
        };
      }),
    [highlightedId, localGestures, projected],
  );
  const [nodes, setNodes, handleNodesChange] = useNodesState<Node>(canonicalNodes);

  useEffect(() => {
    setNodes(canonicalNodes);
  }, [canonicalNodes, setNodes]);

  const handleNodeDragStart = useCallback(
    (_event: unknown, node: Node): void => {
      updateLocalGesture(node.id, { x: node.position.x, y: node.position.y });
    },
    [updateLocalGesture],
  );

  const handleNodeDrag = useCallback(
    (_event: unknown, node: Node): void => {
      if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return;
      updateLocalGesture(node.id, { x: node.position.x, y: node.position.y });
      gestureStream.push({
        kind: "move",
        phase: "active",
        elementId: node.id,
        x: node.position.x,
        y: node.position.y,
      });
    },
    [gestureStream, updateLocalGesture],
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: Node): void => {
      const element = client.elements.get(node.id);
      if (
        element === undefined ||
        !Number.isFinite(node.position.x) ||
        !Number.isFinite(node.position.y)
      ) {
        clearLocalGesture(node.id);
        return;
      }
      if (element.x !== node.position.x || element.y !== node.position.y) {
        client.transact((tx) => {
          tx.patch(node.id, { x: node.position.x, y: node.position.y });
        });
      }
      gestureStream.end({
        kind: "move",
        phase: "end",
        elementId: node.id,
        x: node.position.x,
        y: node.position.y,
      });
      clearLocalGesture(node.id);
    },
    [clearLocalGesture, client, gestureStream],
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
      updateLocalGesture(elementId, { x, y, width, height });
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
    [client, gestureStream, updateLocalGesture],
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
        clearLocalGesture(elementId);
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
      clearLocalGesture(elementId);
    },
    [clearLocalGesture, client, gestureStream],
  );

  const machineFor = useCallback(
    (sessionId: string) => {
      const session = client.sessions.get(sessionId);
      return session === undefined ? null : sessionMachine(machines, session.machineId);
    },
    [client, machines],
  );

  const sessionShared = useCallback(
    (elementId: string, sessionId: string): boolean => {
      for (const element of client.elements.values()) {
        if (
          element.id !== elementId &&
          element.type === "terminal" &&
          element.sessionId === sessionId
        ) {
          return true;
        }
      }
      return false;
    },
    [client],
  );

  const tombstone = useCallback(
    (elementIds: readonly string[]): void => {
      client.transact((tx) => {
        for (const elementId of elementIds) tx.remove(elementId);
      });
    },
    [client],
  );

  const onClose = useCallback(
    (elementId: string, sessionId: string): void => {
      tombstone([elementId]);
      const session = client.sessions.get(sessionId);
      if (
        !sessionShared(elementId, sessionId) &&
        session?.status === "running" &&
        session.controllerId === client.self?.id
      ) {
        client.killTerminal(sessionId);
      }
    },
    [client, sessionShared, tombstone],
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

  const placeSession = useCallback(
    (sessionId: string, elementId: string = crypto.randomUUID()): void => {
      client.transact((tx) => {
        tx.create(createTerminalElement(elementId, sessionId, canvasCenter(), tx.nextZIndex()));
      });
    },
    [canvasCenter, client],
  );

  const createTerminal = useCallback(
    async (machine?: MachineSummary): Promise<void> => {
      if (client.epoch === "") {
        setError("Waiting for the pad connection");
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
        placeSession(session.id, elementId);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : "Could not open terminal");
      }
    },
    [client, machines, padId, placeSession],
  );

  const restartTerminal = useCallback(
    async (elementId: string, sessionId: string): Promise<void> => {
      const element = client.elements.get(elementId);
      if (element?.type !== "terminal") return;
      const machineId = client.sessions.get(sessionId)?.machineId;
      try {
        const session = await client.openTerminal({
          elementId,
          cols: 80,
          rows: 24,
          ...(machineId === undefined ? {} : { machineId }),
        });
        client.transact((tx) => {
          tx.patch(elementId, { sessionId: session.id });
        });
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : "Could not restart terminal");
      }
    },
    [client],
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

  const liveBindings = useMemo(() => {
    const bindings = new Map<string, string[]>();
    for (const element of projected) {
      if (element.type !== "terminal") continue;
      const ids = bindings.get(element.data.sessionId) ?? [];
      ids.push(element.id);
      bindings.set(element.data.sessionId, ids);
    }
    return bindings;
  }, [projected]);

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

  const context = useMemo<FlowPadContextValue>(
    () => ({
      client,
      machines,
      machineFor,
      onClose,
      onRestart: restartTerminal,
      sessionShared,
      onResize: handleResize,
      onResizeEnd: handleResizeEnd,
      editingId,
      beginTextEditing: setEditingId,
      endTextEditing: (elementId) => {
        setEditingId((current) => (current === elementId ? null : current));
      },
      noteMount: (elementId: string) => {
        const counts = mountCountsRef.current;
        counts.set(elementId, (counts.get(elementId) ?? 0) + 1);
      },
    }),
    [
      client,
      editingId,
      handleResize,
      handleResizeEnd,
      machineFor,
      machines,
      onClose,
      restartTerminal,
      sessionShared,
    ],
  );

  useEffect(() => {
    onWorkspaceChange({
      status,
      savedAt: null,
      rev: sceneRevision,
      machines,
      rows: sessionRows,
      onCreateTerminal: (machine) => void createTerminal(machine),
      onFocus: focusElement,
      onKill: (sessionId) => {
        const row = sessionRows.find((candidate) => candidate.id === sessionId);
        if (row?.orphaned && !row.isController && !client.selfCaps.includes("*")) {
          client.takeTerminal(sessionId);
        }
        client.killTerminal(sessionId);
      },
      onRestore: (sessionId) => placeSession(sessionId),
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
    placeSession,
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
        })),
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
      {error === null ? null : <div className="flow-error">{error}</div>}
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
          client.transact((tx) => {
            for (const node of selected) tx.remove(node.id);
          });
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
        <FlowPadProvider value={context}>
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
            nodeDragThreshold={2}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            proOptions={PRO_OPTIONS}
          >
            <ViewportPortal>
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
              {remoteCursors.map((cursor) => {
                const principal =
                  rosterRows.find((row) => row.principal.id === cursor.principalId)?.principal ??
                  null;
                return (
                  <div
                    className="flow-remote-cursor"
                    data-cursor-color={principal?.color ?? ""}
                    key={remoteCursorSocketId(cursor.principalId, cursor.connId)}
                    style={{
                      color: principal?.color ?? "#868e96",
                      transform: `translate(${String(cursor.x)}px, ${String(cursor.y)}px)`,
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 2 20 12l-8 2-4 7Z" fill="currentColor" />
                    </svg>
                    <span>{principal?.name ?? "Collaborator"}</span>
                  </div>
                );
              })}
            </ViewportPortal>
          </ReactFlow>
        </FlowPadProvider>
      </div>
    </div>
  );
}
