import {
  CURSOR_MIN_INTERVAL_MS,
  MAX_ELEMENTS_PER_UPDATE,
  SceneElementSchema,
  type MachineSummary,
  type SceneElement,
} from "@manifold/protocol";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import {
  ReactFlow,
  ViewportPortal,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMachines } from "./api.ts";
import type { StoredIdentity } from "./api.ts";
import { debugSeamEnabled, toElementSnapshot } from "./debug-seam.ts";
import { recordRemoteCursor, remoteCursorSocketId, type RemoteCursor } from "./cursor-identity.ts";
import {
  FlowPadProvider,
  TERMINAL_DRAG_HANDLE,
  TerminalNode,
  type FlowPadContextValue,
} from "./flow-terminal-node.tsx";
import {
  applyNodeMove,
  applyNodeResize,
  bumpElement,
  createTerminalElement,
  projectTerminals,
  terminalBinding,
  terminalGeometry,
} from "./flow-scene.ts";
import { sessionMachine } from "./machine-visibility.ts";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { deriveRosterRows, type RosterRow } from "./roster-model.ts";
import { loadViewport, saveViewport } from "./viewport-memory.ts";
import { buildSessionRows } from "./session-inventory.ts";
import { PresenceIsland, type WorkspaceSidebarState } from "./top-right.tsx";

/**
 * React Flow is manifold's pad renderer on this branch. The protocol remains unchanged:
 * persisted legacy terminal elements project directly into nodes, while new terminals are
 * written as the same loose scene records without involving Excalidraw.
 */

/** Stable module-scope identity prevents React Flow from remounting live PTYs. */
const NODE_TYPES: NodeTypes = { terminal: TerminalNode };
const NO_EDGES: readonly never[] = Object.freeze([]);
const PRO_OPTIONS = Object.freeze({ hideAttribution: true });
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

interface FlowPadViewProps {
  readonly padId: string;
  readonly identity: StoredIdentity;
  readonly onWorkspaceChange: (workspace: WorkspaceSidebarState | null) => void;
}

function sessionUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/session`;
}

export function FlowPadView({ padId, identity, onWorkspaceChange }: FlowPadViewProps) {
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), padId, token: identity.token }),
  );
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sceneRevision, setSceneRevision] = useState(0);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  const [rosterRows, setRosterRows] = useState<readonly RosterRow[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountCountsRef = useRef<Map<string, number>>(new Map());
  const connectStartedRef = useRef(false);
  const remoteCursorsRef = useRef(new Map<string, RemoteCursor>());
  const [remoteCursors, setRemoteCursors] = useState<readonly RemoteCursor[]>([]);
  const lastClientRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const cursorLastSentRef = useRef(0);
  const flowRef = useRef<ReactFlowInstance<Node, never> | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const initialViewport = useMemo(
    () => loadViewport(window.localStorage, padId) ?? { x: 0, y: 0, zoom: 1 },
    [padId],
  );

  useEffect(() => {
    const invalidate = (): void => setSceneRevision((value) => value + 1);
    const offScene = client.on("scene_changed", invalidate);
    const offReset = client.on("scene_reset", invalidate);
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
    refreshRoster();
    return () => {
      offScene();
      offReset();
      offSessions();
      offStatus();
      offRoster();
      offCursor();
    };
  }, [client, identity.principal]);

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

  const projected = useMemo(() => {
    void sceneRevision;
    return projectTerminals(client.scene);
  }, [client, sceneRevision]);

  const nodes = useMemo<Node[]>(
    () =>
      projected.map((terminal) => ({
        id: terminal.id,
        type: terminal.type,
        position: terminal.position,
        width: terminal.width,
        height: terminal.height,
        zIndex: terminal.zIndex,
        selected: terminal.id === highlightedId,
        dragHandle: TERMINAL_DRAG_HANDLE,
        data: { sessionId: terminal.data.sessionId },
      })),
    [highlightedId, projected],
  );

  const publish = useCallback(
    (elements: readonly SceneElement[]): void => {
      if (elements.length === 0) return;
      for (let index = 0; index < elements.length; index += MAX_ELEMENTS_PER_UPDATE) {
        client.updateScene(elements.slice(index, index + MAX_ELEMENTS_PER_UPDATE));
      }
    },
    [client],
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: Node): void => {
      const moved = applyNodeMove(client.scene, { id: node.id, position: node.position });
      if (moved !== null) publish([moved]);
    },
    [client, publish],
  );

  /** Selection is local UI state; geometry commits only on drag/resize end. */
  const handleNodesChange = useCallback((_changes: readonly NodeChange[]): void => {}, []);

  const handleResize = useCallback(
    (elementId: string, width: number, height: number): void => {
      const resized = applyNodeResize(client.scene, { id: elementId, width, height });
      if (resized !== null) publish([resized]);
    },
    [client, publish],
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
      for (const element of client.scene.values()) {
        if (element.id === elementId) continue;
        const binding = terminalBinding(element);
        if (binding !== null && binding.sessionId === sessionId) return true;
      }
      return false;
    },
    [client],
  );

  const tombstone = useCallback(
    (elementIds: readonly string[]): void => {
      const updates: SceneElement[] = [];
      for (const elementId of elementIds) {
        const element = client.scene.get(elementId);
        if (element !== undefined && !element.isDeleted) {
          updates.push(bumpElement(element, { isDeleted: true }));
        }
      }
      publish(updates);
    },
    [client, publish],
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
      const element = createTerminalElement(elementId, sessionId, canvasCenter());
      const parsed = SceneElementSchema.safeParse(element);
      if (!parsed.success) {
        setError("Could not create terminal element");
        return;
      }
      publish([parsed.data]);
    },
    [canvasCenter, publish],
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
      const element = client.scene.get(elementId);
      if (element === undefined || element.isDeleted) return;
      const machineId = client.sessions.get(sessionId)?.machineId;
      try {
        const session = await client.openTerminal({
          elementId,
          cols: 80,
          rows: 24,
          ...(machineId === undefined ? {} : { machineId }),
        });
        const rebound = bumpElement(element, {
          customData: {
            kind: "terminal",
            sessionId: session.id,
            showHyperlinkIcon: false,
            fullInteractionTarget: true,
            showShapeActions: false,
          },
        });
        publish([rebound]);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : "Could not restart terminal");
      }
    },
    [client, publish],
  );

  const focusElement = useCallback(
    (elementId: string): void => {
      const element = client.scene.get(elementId);
      if (element === undefined) return;
      const geometry = terminalGeometry(element);
      const flow = flowRef.current;
      if (geometry === null || flow === null) return;
      const zoom = flow.getViewport().zoom;
      void flow.setCenter(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2, {
        zoom,
        duration: 250,
      });
    },
    [client],
  );

  const liveBindings = useMemo(() => {
    const bindings = new Map<string, string[]>();
    for (const terminal of projected) {
      const ids = bindings.get(terminal.data.sessionId) ?? [];
      ids.push(terminal.id);
      bindings.set(terminal.data.sessionId, ids);
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

  const context = useMemo<FlowPadContextValue>(
    () => ({
      client,
      machines,
      machineFor,
      onClose,
      onRestart: restartTerminal,
      sessionShared,
      onResize: handleResize,
      noteMount: (elementId: string) => {
        const counts = mountCountsRef.current;
        counts.set(elementId, (counts.get(elementId) ?? 0) + 1);
      },
    }),
    [client, handleResize, machineFor, machines, onClose, restartTerminal, sessionShared],
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
      scene: () => [...client.scene.values()].map(toElementSnapshot),
      canvas: () => {
        const liveNodes = new Map(
          (flowRef.current?.getNodes() ?? []).map((node) => [node.id, node] as const),
        );
        return [...client.scene.values()].flatMap((element) => {
          const snapshot = toElementSnapshot(element);
          if (snapshot.isDeleted) return [snapshot];
          const node = liveNodes.get(element.id);
          if (node === undefined) return [];
          return [
            {
              ...snapshot,
              x: node.position.x,
              y: node.position.y,
              width: node.measured?.width ?? node.width ?? snapshot.width,
              height: node.measured?.height ?? node.height ?? snapshot.height,
            },
          ];
        });
      },
      pending: () => [],
      rev: () => sceneRevision,
      epoch: () => client.epoch,
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
  }, [client, sceneRevision]);

  return (
    <div className="flow-pad-view">
      {error === null ? null : <div className="flow-error">{error}</div>}
      <div
        className="flow-pad-canvas"
        ref={canvasRef}
        onPointerMoveCapture={(event) => emitCursor(event.clientX, event.clientY)}
      >
        <div className="flow-presence">
          <PresenceIsland rows={rosterRows} />
        </div>
        <FlowPadProvider value={context}>
          <ReactFlow
            nodes={nodes}
            edges={NO_EDGES as never[]}
            nodeTypes={NODE_TYPES}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            defaultViewport={initialViewport}
            onMoveEnd={(_event, viewport) => {
              saveViewport(window.localStorage, padId, viewport);
              cursorLastSentRef.current = 0;
              reemitCursor();
            }}
            onNodesChange={handleNodesChange}
            onNodeDragStop={handleNodeDragStop}
            zIndexMode="manual"
            onlyRenderVisibleElements={false}
            nodesConnectable={false}
            connectOnClick={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            panActivationKeyCode={null}
            zoomActivationKeyCode={null}
            nodeDragThreshold={2}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            proOptions={PRO_OPTIONS}
          >
            <ViewportPortal>
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
