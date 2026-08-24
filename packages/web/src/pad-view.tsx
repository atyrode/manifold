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
  type RuntimeDeps,
  type SceneElement,
} from "@manifold/protocol";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getPad, type StoredIdentity } from "./api.ts";
import {
  INITIAL_CANVAS_PAINT_READINESS,
  advanceCanvasPaintReadiness,
  canPaintCanvas,
} from "./canvas-readiness.ts";
import { mergeCanonicalScene } from "./canvas-merge.ts";
import { recordRemoteCursor, remoteCursorSocketId, type RemoteCursor } from "./cursor-identity.ts";
import { debugSeamEnabled, toElementSnapshot } from "./debug-seam.ts";
import { sceneResetAction } from "./scene-reset-policy.ts";
import { Roster, StatusBar } from "./overlays.tsx";
import { TerminalView } from "./terminal-view.tsx";
/** Scene flush cadence; build-time override (VITE_SCENE_SEND_MS) exists for benchmarking only. */
const configuredSendMs = Number(import.meta.env["VITE_SCENE_SEND_MS"]);
const SCENE_SEND_INTERVAL_MS =
  Number.isFinite(configuredSendMs) && configuredSendMs >= 4 && configuredSendMs <= 1000
    ? configuredSendMs
    : 80;
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

  const [padName, setPadName] = useState<string>(padId);
  const [padLoadError, setPadLoadError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [, setRosterVersion] = useState(0);

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
  }, [client, runtime]);

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
    [client, scheduleSceneFlush, sendViewportOnChange],
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

  const emitCursorRef = useRef(emitCursorFromClient);
  emitCursorRef.current = emitCursorFromClient;

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
  }, [paintReadiness, syncCanvas, syncCollaborators]);

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
    const offRoster = client.on("roster_changed", () => {
      const connected = new Set(client.roster.keys());
      for (const [socketId, cursor] of remoteCursorsRef.current) {
        if (!connected.has(cursor.principalId)) remoteCursorsRef.current.delete(socketId);
      }
      syncCollaborators();
      setRosterVersion((version) => version + 1);
    });
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
      offCursor();
      offStatus();
      offSaved();
      offMessage();
    };
  }, [client, flushScene, syncCollaborators]);

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

  const createTerminal = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    if (client.epoch === "") {
      api.setToast({ message: "Waiting for the pad connection" });
      return;
    }
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
      strokeColor: "#868e96",
      backgroundColor: "#101216",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roundness: null,
      roughness: 0,
      opacity: 100,
      link: TERMINAL_LINK,
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
      api.setToast({ message: "Could not create terminal element (see console)", closable: true });
      return;
    }
    const parsedTerminal = parsed.data;
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), terminalElement],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    publishImmediately([parsedTerminal]);

    try {
      const session = await client.openTerminal({
        elementId: terminalElement.id,
        cols: 80,
        rows: 24,
      });
      const currentApi = apiRef.current;
      if (currentApi === null) return;
      const currentElements = currentApi.getSceneElementsIncludingDeleted();
      const latest = currentElements.find((element) => element.id === terminalElement.id);
      if (latest === undefined) return;
      const boundElement = newElementWith(latest, {
        customData: { kind: "terminal", sessionId: session.id },
      });
      const boundParsed = SceneElementSchema.safeParse(boundElement);
      if (!boundParsed.success) {
        console.error("bound terminal element failed validation", boundParsed.error.issues);
        return;
      }
      const parsedBoundElement = boundParsed.data;
      currentApi.updateScene({
        elements: currentElements.map((element) =>
          element.id === boundElement.id ? boundElement : element,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      publishImmediately([parsedBoundElement]);
    } catch (reason: unknown) {
      api.setToast({
        message: reason instanceof Error ? reason.message : "Could not open terminal",
        closable: true,
      });
    }
  }, [client, publishImmediately, runtime]);

  const renderEmbeddable = useCallback(
    (element: NonDeleted<ExcalidrawEmbeddableElement>) => {
      if (element.link !== TERMINAL_LINK) return null;
      const customData = TerminalCustomDataSchema.safeParse(element.customData);
      if (!customData.success) {
        return <div className="terminal-placeholder">Opening terminal…</div>;
      }
      return (
        <TerminalView
          client={client}
          sessionId={customData.data.sessionId}
          elementId={element.id}
        />
      );
    },
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
        validateEmbeddable={(link) => link === TERMINAL_LINK}
        renderEmbeddable={renderEmbeddable}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => void createTerminal()}>New terminal</MainMenu.Item>
          <MainMenu.Item onSelect={() => navigate("/")}>Back to pads</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.ItemCustom className="pad-name-menu-item">{padName}</MainMenu.ItemCustom>
        </MainMenu>
      </Excalidraw>
      <Roster client={client} fallbackSelf={identity.principal} />
      <StatusBar status={connectionStatus} savedAt={savedAt} rev={revision} />
      {padLoadError === null ? null : <div className="pad-load-error">{padLoadError}</div>}
      {connectError === null ? null : <div className="pad-load-error">{connectError}</div>}
    </div>
  );
}
