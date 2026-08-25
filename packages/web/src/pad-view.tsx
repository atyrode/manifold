import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  newElementWith,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type {
  NonDeleted,
  ExcalidrawEmbeddableElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import {
  CURSOR_MIN_INTERVAL_MS,
  MAX_ELEMENTS_PER_UPDATE,
  SceneElementSchema,
  TerminalCustomDataSchema,
  VIEWPORT_MIN_INTERVAL_MS,
  compareElements,
  defaultRuntime,
  type MachineSummary,
  type RuntimeDeps,
  type SceneElement,
} from "@manifold/protocol";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getMachines, getPad, type StoredIdentity } from "./api.ts";
import {
  INITIAL_CANVAS_PAINT_READINESS,
  advanceCanvasPaintReadiness,
  canPaintCanvas,
} from "./canvas-readiness.ts";
import { mergeCanonicalScene } from "./canvas-merge.ts";
import { recordRemoteCursor, remoteCursorSocketId, type RemoteCursor } from "./cursor-identity.ts";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { sessionMachine } from "./machine-visibility.ts";
import { debugSeamEnabled, toElementSnapshot } from "./debug-seam.ts";
import { sceneResetAction } from "./scene-reset-policy.ts";
import { buildSessionRows, type SessionRow } from "./session-inventory.ts";
import { PadTopRight } from "./top-right.tsx";
import { deriveRosterRows, type RosterRow } from "./roster-model.ts";
import { TerminalView } from "./terminal-view.tsx";
import { loadViewport, saveViewport } from "./viewport-memory.ts";
/**
 * Scene flush cadence, i.e. remote motion smoothness (up to ~60Hz configured; 53.7Hz
 * measured under the harness's 55Hz synthetic pointer). Chosen from measured
 * tradeoffs (scripts/bench-sync.ts, single-element localhost drag: 53.7Hz remote,
 * ~25 KiB/s per active dragger, 8/13ms latency p50/p95); large rooms or constrained
 * WANs are NOT covered by that benchmark — adaptive backpressure is tracked in #14.
 * Build-time override (VITE_SCENE_SEND_MS) exists for benchmarking.
 */
const configuredSendMs = Number(import.meta.env["VITE_SCENE_SEND_MS"]);
const SCENE_SEND_INTERVAL_MS =
  Number.isFinite(configuredSendMs) && configuredSendMs >= 4 && configuredSendMs <= 1000
    ? configuredSendMs
    : 16;
const TERMINAL_LINK = "manifold://terminal";
const TERMINAL_WIDTH = 720;
const TERMINAL_HEIGHT = 480;

interface ElementVersion {
  readonly version: number;
  readonly versionNonce: number;
}

interface CursorUpdate {
  readonly x: number;
  readonly y: number;
  readonly tool: "pointer" | "laser";
}

interface ViewportUpdate {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

interface PadViewProps {
  readonly padId: string;
  readonly identity: StoredIdentity;
  readonly navigate: (path: string) => void;
  readonly runtime?: RuntimeDeps;
}

function sessionUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/session`;
}

/** Owns exactly one SDK session client and projects its scene, presence, and PTYs into Excalidraw. */
export function PadView({ padId, identity, navigate, runtime = defaultRuntime }: PadViewProps) {
  const [client] = useState(
    () =>
      new SessionClient({
        url: sessionUrl(),
        padId,
        token: identity.token,
      }),
  );
  const [paintReadiness, dispatchPaintReadiness] = useReducer(
    advanceCanvasPaintReadiness,
    INITIAL_CANVAS_PAINT_READINESS,
  );

  // Camera memory (per pad, per device): restored once at first paint; saved on
  // the same throttled cadence as viewport presence, plus a pagehide flush so a
  // refresh right after a pan keeps the final camera. Never saved before the
  // restore attempt, or the boot default would overwrite the remembered one.
  const viewportRestoredRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const apiGenerationRef = useRef(0);
  const readyApiGenerationRef = useRef(0);
  const applyingRemoteRef = useRef(false);
  const remoteApplyTokenRef = useRef(0);
  /** Next canonical paint replaces the canvas wholesale (epoch adoption) instead of merging. */
  const needsFullRepaintRef = useRef(true);
  const versionPairsRef = useRef(new Map<string, ElementVersion>());
  const pendingElementsRef = useRef(new Map<string, SceneElement>());
  /** Epoch whose lineage the current pending/bookkeeping state belongs to. */
  const lastEpochRef = useRef("");
  const sceneTimerRef = useRef<number | null>(null);
  const lastSceneSentAtRef = useRef<number | null>(null);
  const cursorTimerRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<CursorUpdate | null>(null);
  const lastCursorSentAtRef = useRef<number | null>(null);
  const viewportTimerRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<ViewportUpdate | null>(null);
  const observedViewportRef = useRef<ViewportUpdate | null>(null);
  const lastViewportSentAtRef = useRef<number | null>(null);
  const lastSelectionRef = useRef<readonly string[] | null>(null);
  /** Physical pointer position in client coords — OUR truth for cursor broadcasting. */
  const lastClientRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const remoteCursorsRef = useRef(new Map<string, RemoteCursor>());
  const connectStartedRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  /** Last observed Excalidraw menu state; a closed→canvas transition refreshes machines. */
  const lastOpenMenuRef = useRef<AppState["openMenu"]>(null);
  /** Latest completed machines fetch, readable inside stable callbacks. */
  const machinesRef = useRef<readonly MachineSummary[] | null>(null);
  /** Monotonic fetch epoch: stale responses (and post-unmount ones) are dropped. */
  const machinesEpochRef = useRef(0);

  const [padName, setPadName] = useState<string>(padId);
  const [padLoadError, setPadLoadError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [rosterRows, setRosterRows] = useState<readonly RosterRow[]>([]);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  const [sessionRows, setSessionRows] = useState<readonly SessionRow[]>([]);

  /** Refreshes the enrolled-machines list; failures keep the last known list. */
  const refreshMachines = useCallback((): void => {
    const epoch = ++machinesEpochRef.current;
    void getMachines(identity.token)
      .then((fetched) => {
        if (machinesEpochRef.current !== epoch) return;
        machinesRef.current = fetched;
        setMachines(fetched);
      })
      .catch(() => {
        // Menu falls back to the machine-agnostic item; the server still
        // enforces the sole-online-machine rule and errors precisely.
      });
  }, [identity.token]);

  const flushScene = useCallback((): void => {
    sceneTimerRef.current = null;
    if (client.epoch === "") return;
    const pending = [...pendingElementsRef.current.values()];
    pendingElementsRef.current.clear();
    if (pending.length === 0) return;
    lastSceneSentAtRef.current = runtime.now();
    for (let offset = 0; offset < pending.length; offset += MAX_ELEMENTS_PER_UPDATE) {
      client.updateScene(pending.slice(offset, offset + MAX_ELEMENTS_PER_UPDATE));
    }
  }, [client, runtime]);

  const scheduleSceneFlush = useCallback((): void => {
    if (sceneTimerRef.current !== null) return;
    const lastSentAt = lastSceneSentAtRef.current;
    const delay =
      lastSentAt === null
        ? SCENE_SEND_INTERVAL_MS
        : Math.max(0, SCENE_SEND_INTERVAL_MS - (runtime.now() - lastSentAt));
    sceneTimerRef.current = window.setTimeout(flushScene, delay);
  }, [flushScene, runtime]);

  const publishImmediately = useCallback(
    (elements: readonly SceneElement[]): void => {
      for (const element of elements) {
        versionPairsRef.current.set(element.id, {
          version: element.version,
          versionNonce: element.versionNonce,
        });
        pendingElementsRef.current.delete(element.id);
      }
      if (pendingElementsRef.current.size === 0 && sceneTimerRef.current !== null) {
        window.clearTimeout(sceneTimerRef.current);
        sceneTimerRef.current = null;
      }
      lastSceneSentAtRef.current = runtime.now();
      for (let offset = 0; offset < elements.length; offset += MAX_ELEMENTS_PER_UPDATE) {
        client.updateScene(elements.slice(offset, offset + MAX_ELEMENTS_PER_UPDATE));
      }
    },
    [client, runtime],
  );

  const flushCursor = useCallback((): void => {
    cursorTimerRef.current = null;
    const cursor = pendingCursorRef.current;
    pendingCursorRef.current = null;
    if (cursor === null) return;
    client.sendCursor(cursor.x, cursor.y, cursor.tool);
    lastCursorSentAtRef.current = runtime.now();
  }, [client, runtime]);

  const sendCursor = useCallback(
    (cursor: CursorUpdate): void => {
      const lastSentAt = lastCursorSentAtRef.current;
      if (lastSentAt === null || runtime.now() - lastSentAt >= CURSOR_MIN_INTERVAL_MS) {
        if (cursorTimerRef.current !== null) {
          window.clearTimeout(cursorTimerRef.current);
          cursorTimerRef.current = null;
        }
        pendingCursorRef.current = null;
        client.sendCursor(cursor.x, cursor.y, cursor.tool);
        lastCursorSentAtRef.current = runtime.now();
        return;
      }
      pendingCursorRef.current = cursor;
      if (cursorTimerRef.current === null) {
        const delay = Math.max(0, CURSOR_MIN_INTERVAL_MS - (runtime.now() - lastSentAt));
        cursorTimerRef.current = window.setTimeout(flushCursor, delay);
      }
    },
    [client, flushCursor, runtime],
  );

  /**
   * Cursor truth is OUR pointermove listener + the committed camera, not Excalidraw's
   * onPointerUpdate: during pans its emissions use stale scroll (and the pan teardown
   * replays the pointerdown coords against the final camera), which made a panning
   * user's cursor drift across remote canvases and teleport on release. Recomputing from
   * the physical position also keeps the cursor glued through wheel pans and zooms,
   * where Excalidraw emits nothing at all.
   */
  const emitCursorFromClient = useCallback((): void => {
    const api = apiRef.current;
    const clientPos = lastClientRef.current;
    if (api === null || clientPos === null) return;
    const appState = api.getAppState();
    const scene = viewportCoordsToSceneCoords(
      { clientX: clientPos.x, clientY: clientPos.y },
      appState,
    );
    sendCursor({
      x: scene.x,
      y: scene.y,
      tool: appState.activeTool.type === "laser" ? "laser" : "pointer",
    });
  }, [sendCursor]);

  const flushViewport = useCallback((): void => {
    viewportTimerRef.current = null;
    const viewport = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (viewport === null) return;
    client.sendPresence({ viewport });
    lastViewportSentAtRef.current = runtime.now();
    if (viewportRestoredRef.current) saveViewport(window.localStorage, padId, viewport);
  }, [client, padId, runtime]);

  const sendViewportOnChange = useCallback(
    (viewport: ViewportUpdate): void => {
      const previous = observedViewportRef.current;
      if (
        previous !== null &&
        previous.x === viewport.x &&
        previous.y === viewport.y &&
        previous.zoom === viewport.zoom
      ) {
        return;
      }
      observedViewportRef.current = viewport;
      pendingViewportRef.current = viewport;
      if (viewportTimerRef.current !== null) return;
      const lastSentAt = lastViewportSentAtRef.current;
      const delay =
        lastSentAt === null
          ? 0
          : Math.max(0, VIEWPORT_MIN_INTERVAL_MS - (runtime.now() - lastSentAt));
      viewportTimerRef.current = window.setTimeout(flushViewport, delay);
    },
    [flushViewport, runtime],
  );

  const handleCanvasChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState): void => {
      const apiGeneration = apiGenerationRef.current;
      if (apiGeneration > 0 && readyApiGenerationRef.current !== apiGeneration) {
        readyApiGenerationRef.current = apiGeneration;
        dispatchPaintReadiness({ type: "api_registered", generation: apiGeneration });
        dispatchPaintReadiness({ type: "api_ready", generation: apiGeneration });
      }
      rootRef.current?.classList.toggle("is-panning", appState.activeTool.type === "hand");

      const openMenu = appState.openMenu;
      if (openMenu === "canvas" && lastOpenMenuRef.current !== "canvas") refreshMachines();
      lastOpenMenuRef.current = openMenu;

      const selection = Object.keys(appState.selectedElementIds).sort();
      const previousSelection = lastSelectionRef.current;
      if (
        previousSelection === null ||
        previousSelection.length !== selection.length ||
        previousSelection.some((id, index) => id !== selection[index])
      ) {
        lastSelectionRef.current = selection;
        client.sendPresence({ selection });
      }

      sendViewportOnChange({
        x: appState.scrollX,
        y: appState.scrollY,
        zoom: appState.zoom.value,
      });

      if (applyingRemoteRef.current) return;
      let changed = false;
      for (const element of elements) {
        const parsed = SceneElementSchema.parse(element);
        const previous = versionPairsRef.current.get(parsed.id);
        if (
          previous !== undefined &&
          previous.version === parsed.version &&
          previous.versionNonce === parsed.versionNonce
        ) {
          continue;
        }
        versionPairsRef.current.set(parsed.id, {
          version: parsed.version,
          versionNonce: parsed.versionNonce,
        });
        pendingElementsRef.current.set(parsed.id, parsed);
        changed = true;
      }
      if (changed) scheduleSceneFlush();
    },
    [client, refreshMachines, scheduleSceneFlush, sendViewportOnChange],
  );

  const syncCanvas = useCallback((): void => {
    const api = apiRef.current;
    if (api === null) return;
    const replaceAll = needsFullRepaintRef.current;
    needsFullRepaintRef.current = false;
    let canvasElements: readonly OrderedExcalidrawElement[];
    if (replaceAll) {
      // Epoch adoption (init/resync): canonical is the whole truth; stale lineage must go.
      // Clone every record at the paint boundary — Excalidraw mutates painted objects in
      // place on later gestures, and aliasing client.scene made those edits invisible to
      // reconcile (idempotent duplicates), silently never sent.
      const sorted = [...client.scene.values()].sort(compareElements);
      for (const element of sorted) {
        versionPairsRef.current.set(element.id, {
          version: element.version,
          versionNonce: element.versionNonce,
        });
        pendingElementsRef.current.delete(element.id);
      }
      const cloned = sorted.map((element) => ({ ...element }));
      canvasElements = cloned as unknown as readonly OrderedExcalidrawElement[];
    } else {
      // Steady state: MERGE canonical into the live canvas. The canvas is legitimately
      // ahead of client.scene while a gesture is in flight (sends are throttled), so a
      // wholesale replace would revert in-progress strokes/drags to the last flushed
      // partial — and clearing their pending entries would drop the final state forever.
      const merge = mergeCanonicalScene(api.getSceneElementsIncludingDeleted(), client.scene);
      if (merge === null) return; // canvas at or ahead of canonical: nothing to repaint
      for (const element of merge.winners) {
        versionPairsRef.current.set(element.id, {
          version: element.version,
          versionNonce: element.versionNonce,
        });
        pendingElementsRef.current.delete(element.id);
      }
      canvasElements = merge.elements as unknown as readonly OrderedExcalidrawElement[];
    }
    const applyToken = ++remoteApplyTokenRef.current;
    applyingRemoteRef.current = true;
    api.updateScene({
      elements: canvasElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    queueMicrotask(() => {
      if (remoteApplyTokenRef.current === applyToken) applyingRemoteRef.current = false;
    });
  }, [client]);

  const syncCollaborators = useCallback((): void => {
    const api = apiRef.current;
    if (api === null) return;
    const collaborators = new Map<SocketId, Collaborator>();
    const principalsWithConnectionCursor = new Set<string>();
    for (const [socketId, cursor] of remoteCursorsRef.current) {
      const entry = client.roster.get(cursor.principalId);
      if (entry === undefined) continue;
      principalsWithConnectionCursor.add(cursor.principalId);
      collaborators.set(socketId as SocketId, {
        username: entry.principal.name,
        color: {
          background: entry.principal.color,
          stroke: entry.principal.color,
        },
        button: "up",
        pointer: { x: cursor.x, y: cursor.y, tool: cursor.tool },
      });
    }
    for (const entry of client.roster.values()) {
      if (
        entry.principal.id === client.self?.id ||
        principalsWithConnectionCursor.has(entry.principal.id)
      ) {
        continue;
      }
      const cursor = entry.payload.cursor;
      collaborators.set(remoteCursorSocketId(entry.principal.id, "presence") as SocketId, {
        username: entry.principal.name,
        color: {
          background: entry.principal.color,
          stroke: entry.principal.color,
        },
        button: "up",
        ...(cursor === null || cursor === undefined
          ? {}
          : {
              pointer: {
                x: cursor.x,
                y: cursor.y,
                tool: cursor.tool ?? "pointer",
              },
            }),
      });
    }
    api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
  }, [client]);

  // Latest-callback ref: initialized at declaration (no stale first-render window) and
  // refreshed in an effect, since refs must not be written during render.
  const emitCursorRef = useRef(emitCursorFromClient);
  useEffect(() => {
    emitCursorRef.current = emitCursorFromClient;
  }, [emitCursorFromClient]);

  const offScrollChangeRef = useRef<(() => void) | null>(null);

  const receiveExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI): void => {
    apiRef.current = api;
    apiGenerationRef.current += 1;
    // Post-commit camera changes re-anchor the cursor under the physical pointer: this
    // is the write that corrects any stale-scroll sample Excalidraw provoked mid-pan
    // (the 30ms cursor coalescer keeps the latest value, so the fresh sample wins).
    offScrollChangeRef.current?.();
    offScrollChangeRef.current = api.onScrollChange(() => emitCursorRef.current());
  }, []);

  useEffect(() => {
    if (!canPaintCanvas(paintReadiness)) return;
    syncCanvas();
    syncCollaborators();
    if (!viewportRestoredRef.current) {
      viewportRestoredRef.current = true;
      const remembered = loadViewport(window.localStorage, padId);
      const api = apiRef.current;
      if (remembered !== null && api !== null) {
        api.updateScene({
          appState: {
            scrollX: remembered.x,
            scrollY: remembered.y,
            zoom: { value: remembered.zoom } as AppState["zoom"],
          },
        });
      }
    }
  }, [padId, paintReadiness, syncCanvas, syncCollaborators]);

  // A refresh right after a pan must not lose the last (still-throttled) camera.
  useEffect(() => {
    const persistLatest = (): void => {
      const latest = observedViewportRef.current;
      if (latest !== null && viewportRestoredRef.current) {
        saveViewport(window.localStorage, padId, latest);
      }
    };
    window.addEventListener("pagehide", persistLatest);
    return () => {
      window.removeEventListener("pagehide", persistLatest);
    };
  }, [padId]);

  useEffect(() => {
    const offSceneReset = client.on("scene_reset", () => {
      remoteCursorsRef.current.clear();
      const action = sceneResetAction(lastEpochRef.current, client.epoch);
      lastEpochRef.current = client.epoch;
      if (action.discardPending) {
        // Old-lineage edits: re-stamping them into the new epoch would bypass the SDK's
        // lineage fence and resurrect deliberately-dropped content.
        pendingElementsRef.current.clear();
        versionPairsRef.current.clear();
        if (sceneTimerRef.current !== null) {
          window.clearTimeout(sceneTimerRef.current);
          sceneTimerRef.current = null;
        }
      }
      needsFullRepaintRef.current = action.repaint === "replace";
      if (action.flushPending) flushScene();
      dispatchPaintReadiness({ type: "scene_reset" });
    });
    const offSceneRejected = client.on("scene_rejected", (rejections) => {
      // Never swallow: surface the loss and un-record the version pairs so a later edit
      // of the same element re-enters the pending pipeline instead of being deduped.
      for (const rejection of rejections) {
        versionPairsRef.current.delete(rejection.element.id);
      }
      apiRef.current?.setToast({
        message: `${String(rejections.length)} element(s) could not be synced`,
        closable: true,
      });
    });
    const offSceneChanged = client.on("scene_changed", () => {
      dispatchPaintReadiness({ type: "scene_changed" });
    });
    const refreshRosterRows = (): void => {
      setRosterRows(deriveRosterRows(client.roster.values(), client.self ?? identity.principal));
    };
    const offRoster = client.on("roster_changed", () => {
      const connected = new Set(client.roster.keys());
      for (const [socketId, cursor] of remoteCursorsRef.current) {
        if (!connected.has(cursor.principalId)) remoteCursorsRef.current.delete(socketId);
      }
      syncCollaborators();
      refreshRosterRows();
    });
    const refreshSessionRows = (): void => {
      // Live bindings only: tombstoned elements must NOT satisfy a session —
      // that is exactly the orphan condition the janitor panel exists to show.
      const bindings = new Map<string, string>();
      for (const el of apiRef.current?.getSceneElementsIncludingDeleted() ?? []) {
        if (el.isDeleted || el.link !== TERMINAL_LINK) continue;
        const bound = TerminalCustomDataSchema.safeParse(el.customData);
        if (bound.success) bindings.set(bound.data.sessionId, el.id);
      }
      setSessionRows(
        buildSessionRows({
          sessions: [...client.sessions.values()],
          machines: machinesRef.current,
          liveBindings: bindings,
          selfId: client.self?.id ?? null,
          selfCaps: client.selfCaps,
        }),
      );
    };
    const offSessions = client.on("sessions_changed", refreshSessionRows);
    const offSceneApplied = client.on("scene_applied", () => refreshSessionRows());
    // Seed once at subscription time: init/resync can land before this effect mounts.
    refreshRosterRows();
    refreshSessionRows();
    const offCursor = client.on("cursor", (message) => {
      if (recordRemoteCursor(remoteCursorsRef.current, message, client.selfConnId)) {
        syncCollaborators();
      }
    });
    const offStatus = client.on("status", setConnectionStatus);
    const offSaved = client.on("saved", (message) => {
      setSavedAt(message.at);
      setRevision(message.rev);
    });
    const offMessage = client.on("message", () => setRevision(client.rev));
    return () => {
      offSceneReset();
      offSceneRejected();
      offSceneChanged();
      offRoster();
      offSessions();
      offSceneApplied();
      offCursor();
      offStatus();
      offSaved();
      offMessage();
    };
  }, [client, flushScene, syncCollaborators, identity.principal, machines]);

  useEffect(() => {
    mountedRef.current = true;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (!connectStartedRef.current) {
      connectStartedRef.current = true;
      void client.connect().catch((reason: unknown) => {
        if (mountedRef.current && client.status !== "closed") {
          setConnectError(reason instanceof Error ? reason.message : "Could not connect to pad");
        }
      });
    }
    return () => {
      mountedRef.current = false;
      closeTimerRef.current = window.setTimeout(() => {
        client.close();
        closeTimerRef.current = null;
      }, 0);
    };
  }, [client]);

  useEffect(() => {
    let active = true;
    void getPad(identity.token, padId)
      .then((pad) => {
        if (active) setPadName(pad.name);
      })
      .catch((reason: unknown) => {
        if (active) {
          setPadLoadError(reason instanceof Error ? reason.message : "Could not load pad details");
        }
      });
    return () => {
      active = false;
    };
  }, [identity.token, padId]);

  useEffect(() => {
    refreshMachines();
    // 10s fleet poll while the pad is open — deliberately no new protocol
    // message at this fleet size (docs/PLAN M3); the pre-decided upgrade path
    // is a machine_changed broadcast added protocol-first.
    const interval = window.setInterval(refreshMachines, 10_000);
    return () => {
      window.clearInterval(interval);
      // Invalidate in-flight fetches so a late resolution never lands post-unmount.
      machinesEpochRef.current += 1;
    };
  }, [refreshMachines]);

  useEffect(() => {
    const reportVisibility = (): void => {
      client.sendPresence({ status: document.hidden ? "idle" : "active" });
    };
    document.addEventListener("visibilitychange", reportVisibility);
    return () => document.removeEventListener("visibilitychange", reportVisibility);
  }, [client]);

  useEffect(() => {
    if (!debugSeamEnabled()) return;
    window.__manifold = {
      scene: () => [...client.scene.values()].map(toElementSnapshot),
      canvas: () =>
        (apiRef.current?.getSceneElementsIncludingDeleted() ?? []).map(toElementSnapshot),
      pending: () => [...pendingElementsRef.current.keys()],
      rev: () => client.rev,
      epoch: () => client.epoch,
      viewport: () => {
        const api = apiRef.current;
        if (api === null) return null;
        const appState = api.getAppState();
        return {
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom.value,
          offsetLeft: appState.offsetLeft,
          offsetTop: appState.offsetTop,
        };
      },
    };
    return () => {
      delete window.__manifold;
    };
  }, [client]);

  useEffect(() => {
    // Edits inside the last throttle window must not die with the tab: flushScene is
    // safe here — it reads refs only, no-ops when pending is empty or no epoch exists,
    // and the SDK outbox absorbs sends racing a closing socket.
    const flushOnHide = (): void => {
      if (document.visibilityState === "hidden") flushScene();
    };
    window.addEventListener("pagehide", flushScene);
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flushScene);
      document.removeEventListener("visibilitychange", flushOnHide);
      // Unmount: flush BEFORE the deferred client.close() (scheduled at 0ms elsewhere)
      // so navigation away does not drop the last window of edits.
      if (sceneTimerRef.current !== null) window.clearTimeout(sceneTimerRef.current);
      flushScene();
      if (cursorTimerRef.current !== null) window.clearTimeout(cursorTimerRef.current);
      if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current);
      offScrollChangeRef.current?.();
      offScrollChangeRef.current = null;
    };
  }, [flushScene]);

  /**
   * Picks the machine an implicit open (restart, single "New terminal" item)
   * should target. Only meaningful when several machines are online — with one
   * or none, omitting machineId keeps the server's own selection rule (and its
   * precise no_machine error) as the single source of truth.
   */
  const pickDefaultMachine = useCallback((): MachineSummary | null => {
    const fetched = machinesRef.current;
    if (fetched === null) return null;
    if (fetched.filter((machine) => machine.online).length <= 1) return null;
    return chooseDefaultMachine(fetched, recallMachine(browserMachineStorage(), padId));
  }, [padId]);

  /**
   * Opens a fresh PTY session for an existing terminal element and rebinds the
   * element's customData to it — used by creation and by restarting an exited
   * terminal in place (geometry preserved). Concurrent restarts: LWW settles
   * one binding and each loser best-effort kills its OWN session after a
   * settle window. This is mitigation, not a guarantee — a client that dies
   * mid-restart can leak its PTY (same exposure as Delete-key). A guaranteed
   * path needs a server-side conditional rebind; deliberately out of scope.
   */
  const openAndBindTerminal = useCallback(
    async (elementId: string, requested?: Pick<MachineSummary, "id" | "name">): Promise<void> => {
      const api = apiRef.current;
      if (api === null) return;
      const existing = api
        .getSceneElementsIncludingDeleted()
        .find((element) => element.id === elementId);
      const existingBinding = TerminalCustomDataSchema.safeParse(existing?.customData);
      if (
        existingBinding.success &&
        client.sessions.get(existingBinding.data.sessionId)?.status === "running"
      ) {
        return; // someone already restarted this terminal
      }
      const target = requested ?? pickDefaultMachine() ?? undefined;
      try {
        const session = await client.openTerminal({
          elementId,
          cols: 80,
          rows: 24,
          ...(target !== undefined ? { machineId: target.id } : {}),
        });
        // Any failure to bind below leaves the fresh PTY orphaned — kill our
        // own session (we are its controller) before bailing.
        const abandon = (): void => client.killTerminal(session.id);
        const currentApi = apiRef.current;
        if (currentApi === null) return abandon();
        const currentElements = currentApi.getSceneElementsIncludingDeleted();
        const latest = currentElements.find((element) => element.id === elementId);
        if (latest === undefined || latest.isDeleted) return abandon();
        const boundElement = newElementWith(latest, {
          customData: {
            kind: "terminal",
            sessionId: session.id,
            showHyperlinkIcon: false,
            fullInteractionTarget: true,
            showShapeActions: false,
          },
        });
        const boundParsed = SceneElementSchema.safeParse(boundElement);
        if (!boundParsed.success) {
          console.error("bound terminal element failed validation", boundParsed.error.issues);
          return abandon();
        }
        currentApi.updateScene({
          elements: currentElements.map((element) =>
            element.id === boundElement.id ? boundElement : element,
          ),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        publishImmediately([boundParsed.data]);
        // Concurrent-restart loser: if canonical customData settles on another
        // session, ours is orphaned — kill it rather than leak the PTY.
        window.setTimeout(() => {
          const nowApi = apiRef.current;
          if (nowApi === null) return;
          const now = nowApi
            .getSceneElementsIncludingDeleted()
            .find((element) => element.id === elementId);
          const bound = TerminalCustomDataSchema.safeParse(now?.customData);
          if (bound.success && bound.data.sessionId !== session.id) {
            client.killTerminal(session.id);
          }
        }, 2000);
      } catch (reason: unknown) {
        const failure = reason instanceof Error ? reason.message : "Could not open terminal";
        apiRef.current?.setToast({
          message: requested === undefined ? failure : `${failure} (machine ${requested.name})`,
          closable: true,
        });
      }
    },
    [client, pickDefaultMachine, publishImmediately],
  );

  const createTerminal = useCallback(
    async (machine?: MachineSummary): Promise<void> => {
      const api = apiRef.current;
      if (api === null) return;
      if (client.epoch === "") {
        api.setToast({ message: "Waiting for the pad connection" });
        return;
      }
      if (machine !== undefined) rememberMachine(browserMachineStorage(), padId, machine.id);
      const appState = api.getAppState();
      const center = viewportCoordsToSceneCoords(
        {
          clientX: appState.offsetLeft + appState.width / 2,
          clientY: appState.offsetTop + appState.height / 2,
        },
        appState,
      );
      const terminalSkeleton = {
        id: runtime.newId(),
        type: "embeddable",
        // Transparent on the canvas: the embed DOM owns every pixel, so the
        // canvas-painted stroke (inverted near-white by dark theme) never rings
        // the terminal. Existing terminals keep old colors until recreated.
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roundness: null,
        roughness: 0,
        opacity: 100,
        link: TERMINAL_LINK,
        // The flags feed re-derived per-element gates in the maintained fork
        // (atyrode/excalidraw-manifold, docs/decisions/0005): link affordance off,
        // whole-element click-to-activate, and the style panel suppressed while
        // the selection is terminals-only.
        customData: {
          showHyperlinkIcon: false,
          fullInteractionTarget: true,
          showShapeActions: false,
        },
        x: center.x - TERMINAL_WIDTH / 2,
        y: center.y - TERMINAL_HEIGHT / 2,
        width: TERMINAL_WIDTH,
        height: TERMINAL_HEIGHT,
        angle: 0,
        seed: 1,
        version: 1,
        versionNonce: 0,
        index: null,
        isDeleted: false,
        groupIds: [],
        frameId: null,
        boundElements: null,
        updated: runtime.now(),
        locked: false,
      } as const;
      const converted = convertToExcalidrawElements(
        [terminalSkeleton as unknown as ExcalidrawElementSkeleton],
        { regenerateIds: false },
      );
      const terminalElement = converted[0];
      if (terminalElement === undefined) throw new Error("Could not create terminal element");
      const parsed = SceneElementSchema.safeParse(terminalElement);
      if (!parsed.success) {
        console.error("terminal element failed protocol validation", parsed.error.issues);
        api.setToast({
          message: "Could not create terminal element (see console)",
          closable: true,
        });
        return;
      }
      const parsedTerminal = parsed.data;
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), terminalElement],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      publishImmediately([parsedTerminal]);

      await openAndBindTerminal(terminalElement.id, machine);
    },
    [client, openAndBindTerminal, padId, publishImmediately, runtime],
  );

  const renderEmbeddable = useCallback(
    (element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) => {
      if (element.link !== TERMINAL_LINK) return null;
      const customData = TerminalCustomDataSchema.safeParse(element.customData);
      if (!customData.success) {
        return <div className="terminal-placeholder">Opening terminal…</div>;
      }
      // Excalidraw disables pointer events on the embed until it is "active"
      // (one click anywhere, via the fullInteractionTarget guard). TerminalView
      // owns the idle veil, window chrome, and focus-presence from `active`.
      const active =
        appState.activeEmbeddable?.element.id === element.id &&
        appState.activeEmbeddable.state === "active";
      const sessionId = customData.data.sessionId;
      const countOtherBindings = (
        elements: readonly {
          id: string;
          isDeleted: boolean;
          link?: string | null;
          customData?: unknown;
        }[],
      ): number =>
        elements.filter((el) => {
          if (el.id === element.id || el.isDeleted || el.link !== TERMINAL_LINK) return false;
          const bound = TerminalCustomDataSchema.safeParse(el.customData);
          return bound.success && bound.data.sessionId === sessionId;
        }).length;
      // Clones share a session (a second viewport onto the same shell), so a
      // shared close is offered to everyone — it only removes the mirror.
      const sessionShared =
        countOtherBindings(apiRef.current?.getSceneElementsIncludingDeleted() ?? []) > 0;
      // Close tombstones this element for everyone; the PTY is killed only when
      // this was the LAST live element bound to the session, and only by its
      // controller (checked live at click; ambiguous ownership never kills).
      const onClose = (): void => {
        const api = apiRef.current;
        if (api === null) return;
        const elements = api.getSceneElementsIncludingDeleted();
        const target = elements.find((el) => el.id === element.id);
        if (target === undefined || target.isDeleted) return;
        const tombstoned = newElementWith(target, { isDeleted: true });
        api.updateScene({
          elements: elements.map((el) => (el.id === element.id ? tombstoned : el)),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        const parsed = SceneElementSchema.safeParse(tombstoned);
        if (parsed.success) publishImmediately([parsed.data]);
        const session = client.sessions.get(sessionId);
        if (
          countOtherBindings(elements) === 0 &&
          session?.status === "running" &&
          session.controllerId === client.self?.id
        ) {
          client.killTerminal(sessionId);
        }
      };
      const session = client.sessions.get(sessionId);
      const boundMachine =
        session === undefined ? null : sessionMachine(machines, session.machineId);
      // Restart must preserve machine identity — never silently substitute the
      // default machine. Pin the session's machineId even before /api/machines
      // resolves; the name falls back to the raw id in failure toasts only.
      const restartTarget =
        session === undefined
          ? undefined
          : { id: session.machineId, name: boundMachine?.name ?? session.machineId };
      return (
        <TerminalView
          client={client}
          sessionId={sessionId}
          elementId={element.id}
          active={active}
          sessionShared={sessionShared}
          onClose={onClose}
          onRestart={() => openAndBindTerminal(element.id, restartTarget)}
          machine={boundMachine}
        />
      );
    },
    [client, machines, openAndBindTerminal, publishImmediately],
  );

  /** null = never fetched (render the machine-agnostic item); [] = none online. */
  const onlineMachines = machines === null ? null : machines.filter((machine) => machine.online);

  const focusSession = useCallback((elementId: string): void => {
    const api = apiRef.current;
    if (api === null) return;
    const target = api.getSceneElementsIncludingDeleted().find((el) => el.id === elementId);
    if (target !== undefined) api.scrollToContent(target, { fitToViewport: true });
  }, []);
  const killSession = useCallback(
    (sessionId: string): void => client.killTerminal(sessionId),
    [client],
  );

  return (
    <div
      className="pad-view"
      ref={rootRef}
      onPointerMoveCapture={(event) => {
        lastClientRef.current = { x: event.clientX, y: event.clientY };
        emitCursorFromClient();
      }}
    >
      <Excalidraw
        theme="dark"
        isCollaborating
        excalidrawAPI={receiveExcalidrawApi}
        onChange={handleCanvasChange}
        validateEmbeddable={() => true}
        renderEmbeddable={renderEmbeddable}
        UIOptions={{ userList: false }}
        renderTopRightUI={(isMobile) => (
          <PadTopRight
            isMobile={isMobile}
            rows={rosterRows}
            machines={machines}
            sessionRows={sessionRows}
            onFocusSession={focusSession}
            onKillSession={killSession}
            status={connectionStatus}
            savedAt={savedAt}
            rev={revision}
          />
        )}
      >
        <MainMenu>
          {onlineMachines !== null && onlineMachines.length === 0 ? (
            <MainMenu.ItemCustom className="machine-none-menu-item">
              No machine online
            </MainMenu.ItemCustom>
          ) : onlineMachines !== null && onlineMachines.length > 1 ? (
            onlineMachines.map((machine) => (
              <MainMenu.Item key={machine.id} onSelect={() => void createTerminal(machine)}>
                New terminal on {machine.name}
              </MainMenu.Item>
            ))
          ) : (
            <MainMenu.Item onSelect={() => void createTerminal()}>New terminal</MainMenu.Item>
          )}
          <MainMenu.Item onSelect={() => navigate("/")}>Back to pads</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.ItemCustom className="pad-name-menu-item">{padName}</MainMenu.ItemCustom>
        </MainMenu>
      </Excalidraw>
      {padLoadError === null ? null : <div className="pad-load-error">{padLoadError}</div>}
      {connectError === null ? null : <div className="pad-load-error">{connectError}</div>}
    </div>
  );
}
