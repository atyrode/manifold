import {
  MAX_ELEMENTS_PER_UPDATE,
  SceneElementSchema,
  type MachineSummary,
  type SceneElement,
} from "@manifold/protocol";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import { ReactFlow, type Node, type NodeChange, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMachines } from "./api.ts";
import type { StoredIdentity } from "./api.ts";
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
  projectTerminals,
  terminalBinding,
} from "./flow-scene.ts";
import { sessionMachine } from "./machine-visibility.ts";

/**
 * React Flow spike route (`/flow/:padId`) — see manifold#15.
 *
 * Deliberately additive: the Excalidraw route is untouched, and this view reuses the
 * EXISTING terminal element shape, so the same pad renders in both. Only terminals are
 * projected; ink, shapes and text stay in the scene untouched and reappear on the
 * Excalidraw route.
 *
 * Writes are OFF unless `?write=1`. A prototype that silently moves elements in a real pad
 * is worse than one that renders read-only, so persistence is opt-in for the whole route.
 */

/**
 * MUST stay module scope. An inline literal gives React Flow a new component identity each
 * render, remounting every node — which here destroys every PTY. React Flow only warns
 * about this in development (error 002).
 */
const NODE_TYPES: NodeTypes = { terminal: TerminalNode };

/** No edges in this spike; a frozen constant keeps the prop referentially stable. */
const NO_EDGES: readonly never[] = Object.freeze([]);

/**
 * MIT imposes no attribution-display condition, and `hideAttribution` is a plain boolean in
 * the MIT core — no licence key, no watermark enforcement. Hidden here because a prototype
 * evaluating the library should not look like it ships a third-party badge. If manifold
 * adopts React Flow for real, sponsoring the project is the right call.
 */
const PRO_OPTIONS = Object.freeze({ hideAttribution: true });

/** Matches the Excalidraw route's remembered zoom range so B is tested at real extremes. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

interface FlowPadViewProps {
  readonly padId: string;
  readonly identity: StoredIdentity;
}

function sessionUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/session`;
}

export function FlowPadView({ padId, identity }: FlowPadViewProps) {
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), padId, token: identity.token }),
  );
  const writesEnabled = useMemo(
    () => new URLSearchParams(window.location.search).get("write") === "1",
    [],
  );

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sceneRevision, setSceneRevision] = useState(0);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** elementId -> observed mount count; criterion A fails if any value exceeds 1. */
  const mountCountsRef = useRef<Map<string, number>>(new Map());
  const connectStartedRef = useRef(false);

  useEffect(() => {
    const offScene = client.on("scene_changed", () => setSceneRevision((value) => value + 1));
    const offReset = client.on("scene_reset", () => setSceneRevision((value) => value + 1));
    const offSessions = client.on("sessions_changed", () => setSceneRevision((v) => v + 1));
    const offStatus = client.on("status", setStatus);
    return () => {
      offScene();
      offReset();
      offSessions();
      offStatus();
    };
  }, [client]);

  useEffect(() => {
    if (connectStartedRef.current) return;
    connectStartedRef.current = true;
    void client.connect().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not connect to pad");
    });
    return () => {
      client.close();
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void getMachines(identity.token)
      .then((fetched) => {
        if (!cancelled) setMachines(fetched);
      })
      .catch(() => {
        // Machine badges degrade to null; the terminal itself still renders.
      });
    return () => {
      cancelled = true;
    };
  }, [identity.token]);

  const nodes = useMemo<Node[]>(() => {
    // sceneRevision is the invalidation signal: client.scene is mutated in place by the
    // SDK, so its identity never changes and cannot be a dependency on its own.
    void sceneRevision;
    return projectTerminals(client.scene).map((projected) => ({
      id: projected.id,
      type: projected.type,
      position: projected.position,
      width: projected.width,
      height: projected.height,
      zIndex: projected.zIndex,
      dragHandle: TERMINAL_DRAG_HANDLE,
      data: { sessionId: projected.data.sessionId },
    }));
  }, [client, sceneRevision]);

  const publish = useCallback(
    (elements: readonly SceneElement[]): void => {
      if (!writesEnabled || elements.length === 0) return;
      for (let index = 0; index < elements.length; index += MAX_ELEMENTS_PER_UPDATE) {
        client.updateScene(elements.slice(index, index + MAX_ELEMENTS_PER_UPDATE));
      }
    },
    [client, writesEnabled],
  );

  /**
   * Commits a finished drag. Two traps are load-bearing here, both found by measurement:
   *
   * 1. `onNodeDragStop` is the ONLY position seam. React Flow's drag-end `NodeChange`
   *    carries `dragging: false` but no `position`, so committing from `onNodesChange`
   *    silently never fired: the node moved on screen (React Flow's internal geometry)
   *    and snapped back on reload.
   * 2. NEVER write the new element into `client.scene` before sending. That map is the
   *    SDK's own mirror; pre-advancing it makes the SDK treat the outgoing edit as an
   *    idempotent duplicate and drop it, so the server never sees the move. This is
   *    manifold's projection-ownership rule (AGENTS invariant 9) biting a second time,
   *    in a canvas that does not even use Excalidraw — the lesson generalises. The SDK
   *    owns the mirror; we publish and let `scene_changed` re-project.
   */
  const handleNodeDragStop = useCallback(
    (_event: unknown, node: Node): void => {
      if (!writesEnabled) return;
      const moved = applyNodeMove(client.scene, { id: node.id, position: node.position });
      if (moved === null) return;
      publish([moved]);
    },
    [client, publish, writesEnabled],
  );

  /**
   * Controlled mode requires the handler to exist so React Flow reports changes, but
   * manifold deliberately ignores them: selection is presence-level, and position is
   * committed once on drag stop above.
   */
  const handleNodesChange = useCallback((_changes: readonly NodeChange[]): void => {}, []);

  /**
   * Commits a finished resize. Same two rules as the drag path: commit once on end, and
   * publish WITHOUT pre-writing `client.scene` (the SDK owns its mirror).
   */
  const handleResize = useCallback(
    (elementId: string, width: number, height: number): void => {
      if (!writesEnabled) return;
      const resized = applyNodeResize(client.scene, { id: elementId, width, height });
      if (resized === null) return;
      publish([resized]);
    },
    [client, publish, writesEnabled],
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

  const onClose = useCallback(
    (elementId: string, sessionId: string): void => {
      if (!writesEnabled) return;
      const element = client.scene.get(elementId);
      if (element === undefined) return;
      const tombstoned = bumpElement(element, { isDeleted: true });
      const parsed = SceneElementSchema.safeParse(tombstoned);
      if (!parsed.success) return;
      // Same rule as the drag path: publish only. Pre-writing the SDK's mirror would make
      // the tombstone look like a duplicate and the close would never reach the server.
      publish([parsed.data]);
      const session = client.sessions.get(sessionId);
      if (
        !sessionShared(elementId, sessionId) &&
        session?.status === "running" &&
        session.controllerId === client.self?.id
      ) {
        client.killTerminal(sessionId);
      }
    },
    [client, publish, sessionShared, writesEnabled],
  );

  const context = useMemo<FlowPadContextValue>(
    () => ({
      client,
      machines,
      machineFor,
      onClose,
      onRestart: async () => {
        // Restart rebinds a fresh PTY to the element, which is a scene write; out of
        // scope for the read-only spike and intentionally inert rather than half-done.
      },
      sessionShared,
      onResize: handleResize,
      noteMount: (elementId: string) => {
        const counts = mountCountsRef.current;
        counts.set(elementId, (counts.get(elementId) ?? 0) + 1);
      },
    }),
    [client, handleResize, machineFor, machines, onClose, sessionShared],
  );

  /**
   * Read-only probe for the spike's acceptance criteria, gated exactly like
   * `debug-seam.ts`: opt-in via `localStorage['manifold:debug'] = '1'`. It exposes internal
   * epoch state, which must not be reachable from a normal production page.
   */
  useEffect(() => {
    if (window.localStorage.getItem("manifold:debug") !== "1") return;
    const probe = {
      mounts: () => Object.fromEntries(mountCountsRef.current),
      nodeCount: () => nodes.length,
      writesEnabled: () => writesEnabled,
      status: () => status,
      epoch: () => client.epoch,
    };
    (window as unknown as Record<string, unknown>)["__manifoldFlow"] = probe;
    return () => {
      delete (window as unknown as Record<string, unknown>)["__manifoldFlow"];
    };
  }, [client, nodes.length, status, writesEnabled]);

  return (
    <div className="flow-pad-view">
      <div className="flow-pad-banner">
        <strong>React Flow spike</strong>
        <span>pad {padId}</span>
        <span>{status}</span>
        <span>
          {nodes.length} terminal{nodes.length === 1 ? "" : "s"}
        </span>
        <span className={writesEnabled ? "flow-write-on" : "flow-write-off"}>
          {writesEnabled ? "writes ON (?write=1)" : "read-only"}
        </span>
        <a href={`/p/${encodeURIComponent(padId)}`}>open Excalidraw route</a>
        {error === null ? null : <span className="flow-error">{error}</span>}
      </div>
      <div className="flow-pad-canvas">
        <FlowPadProvider value={context}>
          <ReactFlow
            nodes={nodes}
            edges={NO_EDGES as never[]}
            nodeTypes={NODE_TYPES}
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
          />
        </FlowPadProvider>
      </div>
    </div>
  );
}
