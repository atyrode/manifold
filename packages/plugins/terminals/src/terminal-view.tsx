/**
 * The terminal VIEWER — `core.terminals`' browser ref for one PTY.
 *
 * The PTY plane below it stays floor and always will (the broker, the attach refcount, the
 * no-gap snapshot invariant, the byte frames); what lives here is everything that has an
 * answer a principal could argue with: which controls a viewer is offered, what a rename
 * dispatches, when a spectator socket may not write, and what an exited shell looks like.
 *
 * Chrome comes from `@manifold/ui` — the titlebar, the glyphs — and the one notice ref and the
 * published view-state store from `@manifold/plugin/hooks`, so this file owns no drawing and
 * no notification mechanism of its own.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { settingValue } from "@manifold/plugin";
import {
  TERMINAL_VIEWPORT_REFRESH_MS,
  trackTerminalPrivateMode,
  type TerminalDeliveryRefusal,
  type TerminalDeliveryState,
  type TerminalSizing,
} from "@manifold/protocol";
import {
  TitlebarOutlet,
  currentVantage,
  useNotice,
  usePublishLocation,
  type TerminalRendererProps,
} from "@manifold/plugin/hooks";
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import {
  Chip,
  Cluster,
  ControlIcon,
  Cover,
  ItemIcon,
  NodeTitleBar,
  Popover,
  Stack,
  TITLEBAR_ACTIONS_CLASS,
} from "@manifold/ui";
import {
  getTerminalFontState,
  loadTerminalFont,
  retryTerminalFont,
  subscribeTerminalFont,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from "./terminal-font";
import { terminalsManifest } from "./index";
import { installTerminalGestures } from "./terminal-gestures";
import { installTerminalGraphics } from "./terminal-graphics";
import { TerminalStream, type TerminalDeliveryHandlers } from "./terminal-stream";
import {
  installTerminalClipboard,
  type TerminalClipboard,
  type TerminalClipboardCopy,
} from "./terminal-clipboard";
import { TerminalExitStatus } from "./terminal-exit";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  subscribeTerminalFontPreferences,
  terminalFontPreferences,
} from "./terminal-font-preferences";
import { installTerminalRenderer } from "./terminal-renderer";
import {
  subscribeTerminalRendererPreferences,
  terminalRendererPreferences,
} from "./terminal-renderer-preferences";

/** This view's delivery as the reader is told it; `skipped` stays until the reader dismisses it. */
interface ViewDelivery {
  readonly terminalId: string;
  readonly state: TerminalDeliveryState | "stalled" | "catching_up";
  /** Why the server retired a `refused` attachment. */
  readonly reason: TerminalDeliveryRefusal | null;
  readonly skipped: boolean;
  /** A waiting delivery outlasted DELIVERY_WAITING_NOTICE_MS. */
  readonly noticed: boolean;
}

/** Ordinary output bursts briefly exhaust credit; only a reader still behind is told. */
const DELIVERY_WAITING_NOTICE_MS = 1_000;

/** A refused view receives nothing more; exits and removals already show their own state. */
const REFUSAL_MESSAGES: Record<TerminalDeliveryRefusal, string | null> = {
  exited: null,
  not_found: null,
  view_limit:
    "Too many views of this terminal are open on this connection, so this one receives no output.",
  owner_unavailable:
    "The terminal's machine could not send its screen to this view, so it receives no output.",
  snapshot_timeout:
    "The terminal's screen did not arrive in time, so this view receives no output.",
  pending_overflow:
    "Output outran this view while its screen was loading, so it receives no output.",
};

/** The truthful delivery notice, if any, and whether it offers the deliberate catch-up. */
function deliveryNotice(delivery: ViewDelivery): { message: string; catchUp: boolean } | null {
  switch (delivery.state) {
    case "catching_up":
      return { message: "Loading the terminal's retained screen…", catchUp: true };
    case "stalled":
      return {
        message:
          "This view exceeded its browser parser limit; output after this point was skipped.",
        catchUp: true,
      };
    case "recovering":
      return {
        message: delivery.skipped
          ? "Output was skipped for this view. It will load the terminal's retained screen after parsing already-delivered output."
          : "This view is waiting to synchronize with the terminal's retained screen after parsing already-delivered output.",
        catchUp: true,
      };
    case "refused": {
      const message = delivery.reason === null ? null : REFUSAL_MESSAGES[delivery.reason];
      if (message === null) break;
      return { message, catchUp: true };
    }
    case "waiting":
      if (!delivery.noticed) break;
      return {
        message:
          "This view is behind the terminal's output; newer output is held until it catches up.",
        catchUp: true,
      };
    case "live":
      break;
    default: {
      const unreachable: never = delivery.state;
      return unreachable;
    }
  }
  return delivery.skipped
    ? {
        message:
          "Output was skipped while this view was behind. It shows the terminal's retained screen; earlier output and scrollback may be incomplete.",
        catchUp: false,
      }
    : null;
}

/** Hosts one no-gap terminal viewer and keeps controller-only input and sizing explicit. */
export function TerminalView({
  host,
  client,
  terminalId,
  elementId,
  active,
  panelHighlighted,
  machine,
  chrome = "full",
  onPark,
  onClose,
  onExpand,
  onEngage,
  onShrink,
  titlebarExtras,
  titlebarMiddle,
  titlebarDragProps,
  projectionScope,
  frame = "window",
  onRenameTitle,
  renameAction,
}: TerminalRendererProps) {
  const copyOnSelect =
    settingValue(host.assembly.settings, terminalsManifest.id, "copy-on-select") === true;
  const pasteOnRightClick =
    settingValue(host.assembly.settings, terminalsManifest.id, "paste-on-right-click") === true;
  const gesturePreferencesRef = useRef({ copyOnSelect, pasteOnRightClick });
  useEffect(() => {
    gesturePreferencesRef.current = { copyOnSelect, pasteOnRightClick };
  }, [copyOnSelect, pasteOnRightClick]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewportId] = useState(() => crypto.randomUUID());
  const sizingDescriptionId = useId();
  const [sizingOpen, setSizingOpen] = useState(false);
  const terminalRef = useRef<Terminal | null>(null);
  const clipboardRef = useRef<TerminalClipboard | null>(null);
  const streamRef = useRef<TerminalStream | null>(null);
  const pasteModeRef = useRef<ReturnType<typeof trackTerminalPrivateMode> | null>(null);
  const clipboardLiveRef = useRef(false);
  const activeRef = useRef(active);
  const [clipboardCopy, setClipboardCopy] = useState<TerminalClipboardCopy | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const scheduleResizeRef = useRef<((refresh?: boolean) => void) | null>(null);
  const syncViewportRef = useRef<(() => void) | null>(null);
  const withdrawViewportRef = useRef<(() => void) | null>(null);
  /**
   * True once a snapshot has been painted into the LIVE terminal. It outlives socket
   * swaps on purpose: the next snapshot must replace what is on screen instead of
   * appending to it, whichever socket delivers it.
   */
  const paintedRef = useRef(false);
  /** Post-replay measurement/refresh, owned by the terminal effect and called by the socket. */
  const settleRef = useRef<(() => void) | null>(null);
  const focusedRef = useRef(false);
  const [takeDenied, setTakeDenied] = useState<{
    readonly client: TerminalRendererProps["client"];
    readonly terminalId: string;
  } | null>(null);
  const pendingTakeRef = useRef<{ terminalId: string; elementId: string } | null>(null);
  /**
   * A deliberate catch-up retires this view's whole xterm/parser incarnation: xterm.reset()
   * cannot cancel parser work already queued, so the old instance and every callback bound to
   * it are disposed, and the same opaque viewport detaches and attaches anew.
   */
  const [incarnation, setIncarnation] = useState(0);
  const [delivery, setDelivery] = useState<ViewDelivery>(() => ({
    terminalId,
    state: "live",
    reason: null,
    skipped: false,
    noticed: false,
  }));
  useEffect(() => {
    if (delivery.state !== "waiting" || delivery.noticed) return;
    const timer = window.setTimeout(() => {
      setDelivery((current) => (current === delivery ? { ...current, noticed: true } : current));
    }, DELIVERY_WAITING_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [delivery]);
  const fontState = useSyncExternalStore(
    subscribeTerminalFont,
    getTerminalFontState,
    getTerminalFontState,
  );
  const fontReady = fontState.status === "ready";
  const [, rerender] = useReducer((version: number) => version + 1, 0);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartArmed, setRestartArmed] = useState(false);
  const { notify } = useNotice();
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);
  const publishLocation = usePublishLocation(projectionScope);
  const fontSize = useSyncExternalStore(
    subscribeTerminalFontPreferences,
    useCallback(() => terminalFontPreferences.get(terminalId), [terminalId]),
    () => TERMINAL_FONT_SIZE,
  );
  const changeFontSize = (size: number): void => {
    try {
      terminalFontPreferences.set(terminalId, size);
    } catch (error: unknown) {
      notify(
        error instanceof Error
          ? `Could not save terminal font size: ${error.message}`
          : "Could not save terminal font size",
        { key: `terminal-font-size:${terminalId}` },
      );
    }
  };
  const rendererMode = useSyncExternalStore(
    subscribeTerminalRendererPreferences,
    useCallback(() => terminalRendererPreferences.get(terminalId), [terminalId]),
    () => "dom" as const,
  );
  const toggleRenderer = (): void => {
    try {
      terminalRendererPreferences.set(terminalId, rendererMode === "dom" ? "webgl" : "dom");
    } catch (error: unknown) {
      notify(
        error instanceof Error
          ? `Could not save terminal renderer choice: ${error.message}`
          : "Could not save terminal renderer choice",
        { key: `terminal-renderer-preference:${terminalId}` },
      );
    }
  };

  useEffect(loadTerminalFont, []);
  useEffect(() => {
    if (fontState.status === "failed") {
      notify(fontState.error.message, { key: `terminal-font:${terminalId}` });
    }
  }, [fontState, notify, terminalId]);

  const terminal = client.terminals.get(terminalId);
  const terminalReady = terminal !== undefined;
  const cwd = terminal?.cwd;
  const cwdLabel = cwd?.replace(/\/+$/, "").split("/").pop() || cwd || "unknown";
  const hostCaps = host.client.selfCaps();
  const canRestart =
    terminal !== undefined &&
    (hostCaps.includes("*") ||
      (hostCaps.includes("terminals:write") &&
        (terminal.status === "exited" || terminal.controllerId === host.principal.id)));
  /** Non-null exactly when this terminal's machine is known and NOT online. */
  const offlineMachine = machine !== null && !machine.online ? machine : null;
  const machineOnlineRef = useRef(offlineMachine === null);
  useEffect(() => {
    machineOnlineRef.current = offlineMachine === null;
    syncViewportRef.current?.();
    scheduleResizeRef.current?.();
  }, [offlineMachine]);
  const selfId = client.self?.id ?? null;
  const isController = selfId !== null && terminal?.controllerId === selfId;

  /**
   * Preview bodies use a SPECTATOR socket, so PTY input, resize and focus traffic
   * remain read-only. Host-supplied titlebar callbacks use the host's own authority
   * and remain available independently of that socket. Held in a ref so changing
   * chrome never tears down the live xterm instance.
   */
  const readOnly = chrome === "preview";
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
    syncViewportRef.current?.();
    scheduleResizeRef.current?.();
  }, [readOnly]);
  useEffect(() => {
    if (!active || readOnly || !isController) {
      clipboardRef.current?.reset();
      clipboardRef.current?.setPasteMode(pasteModeRef.current?.enabled ?? false);
    }
    activeRef.current = active;
  }, [active, readOnly, isController]);

  /**
   * Real-terminal feel: activation (one click-release anywhere on the embed)
   * wakes the cursor immediately. Edge-triggered on inactive→active. The focus
   * is re-asserted frame-by-frame for a short window because browser focus can
   * land after ours; it yields to deliberate focus on another input, titlebar
   * control or floating disclosure and dies with deactivation.
   */
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (!fontReady || !terminalReady) return;
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active || wasActive) return;
    let cancelled = false;
    const deadline = performance.now() + 350;
    const tick = (): void => {
      if (cancelled) return;
      const host = containerRef.current;
      const terminal = terminalRef.current;
      if (host === null || terminal === null) return;
      const focused = document.activeElement;
      const settled = focused !== null && host.contains(focused);
      const interactiveElsewhere =
        !settled &&
        focused instanceof HTMLElement &&
        (focused.tagName === "INPUT" ||
          focused.tagName === "TEXTAREA" ||
          focused.isContentEditable ||
          focused.closest(".node-titlebar, .popover__content, .terminal-delivery") !== null);
      if (interactiveElsewhere) return; // user chose another control: stop wrestling
      if (!settled) terminal.focus();
      // Keep watching through the whole activation transition: browser refocus
      // can land after our first success.
      if (performance.now() < deadline) frame = requestAnimationFrame(tick);
    };
    let frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [active, fontReady, terminalReady]);

  useEffect(() => {
    const refreshViewport = (): void => {
      syncViewportRef.current?.();
      scheduleResizeRef.current?.();
      rerender();
    };
    const offTerminals = client.on("terminals_changed", refreshViewport);
    const offAttendance = client.on("attendance_changed", refreshViewport);
    const offStatus = client.on("status", refreshViewport);
    const offError = client.on("error", (message) => {
      if (message.code === "forbidden" && message.ref === terminalId) {
        pendingTakeRef.current = null;
        setTakeDenied({ client, terminalId });
      }
    });
    return () => {
      offTerminals();
      offAttendance();
      offError();
      offStatus();
    };
  }, [client, terminalId]);

  /**
   * The current socket, reachable from the xterm lifecycle without being a dependency
   * of it. See the two effects below: the terminal belongs to the terminal, the
   * subscriptions belong to the socket.
   */
  const clientRef = useRef(client);
  useEffect(() => {
    clientRef.current = client;
    syncViewportRef.current?.();
    scheduleResizeRef.current?.();
  }, [client]);

  /**
   * The xterm instance and its DOM host, whose life is the TERMINAL TILE's — never the
   * socket's or the PTY's. A pending tile exists before its PTY so its first real viewer can
   * measure the host and publish the birth geometry without inventing process dimensions.
   * The local 80x24 grid below is only an unpainted xterm bootstrap; it never reaches the
   * broker. A portal escalating from spectator to occupant (and dropping back) hands this
   * component a DIFFERENT `SessionClient` for the same tile; a terminal disposed and
   * re-opened on that swap is a visible refresh — new DOM node, buffer repainted from zero,
   * selection and mouse-mode TUIs losing their host mid-gesture. So creation depends on the
   * tile alone, and the socket wiring below re-runs against the SAME terminal. Only the
   * reader's deliberate catch-up replaces it, in the same DOM host, with a new incarnation.
   */
  useEffect(() => {
    if (!fontReady) return;
    const container = containerRef.current;
    if (container === null) return;

    const initialTerminal = clientRef.current.terminals.get(terminalId);
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: initialTerminal?.cols ?? 80,
      rows: initialTerminal?.rows ?? 24,
      convertEol: false,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: terminalFontPreferences.get(terminalId),
      theme: {
        background: getComputedStyle(container).getPropertyValue("--terminal-background").trim(),
        foreground: "#e6e9ef",
        cursor: "#f8f9fa",
        selectionBackground: "#364fc766",
      },
    });
    // Pinch belongs to the canvas; xterm must neither scroll history nor report it to the PTY.
    terminal.attachCustomWheelEventHandler((event) => !event.ctrlKey);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    const renderer = installTerminalRenderer(terminal, container, (message) =>
      notifyRef.current(message, { key: `terminal-renderer:${terminalId}` }),
    );
    const syncRenderer = (): void => renderer.setMode(terminalRendererPreferences.get(terminalId));
    const unsubscribeRenderer = subscribeTerminalRendererPreferences(syncRenderer);
    syncRenderer();
    const graphics = installTerminalGraphics(terminal, (message) =>
      notifyRef.current(message, { key: `terminal-graphics:${terminalId}` }),
    );
    const stream = new TerminalStream(terminal, graphics);
    streamRef.current = stream;
    terminalRef.current = terminal;
    const canWrite = (): boolean => {
      const current = clientRef.current;
      return (
        terminalRef.current === terminal &&
        clipboardLiveRef.current &&
        activeRef.current &&
        !readOnlyRef.current &&
        current.status === "open" &&
        current.self !== null &&
        current.terminals.get(terminalId)?.controllerId === current.self.id
      );
    };
    const clipboard = installTerminalClipboard(terminal, container, {
      canWrite,
      send: (data) => {
        if (canWrite()) clientRef.current.sendTerminalInput(terminalId, data);
      },
      notice: (message) => notifyRef.current(message, { key: `terminal-clipboard:${terminalId}` }),
      offerCopy: (request) => {
        if (
          request === null &&
          document.hasFocus() &&
          document.activeElement?.closest(".terminal-clipboard-request")?.parentElement ===
            container.parentElement
        ) {
          terminal.focus();
        }
        setClipboardCopy(request);
      },
    });
    clipboardRef.current = clipboard;
    const pasteMode = trackTerminalPrivateMode(terminal.parser, 5522, (enabled) =>
      clipboard.setPasteMode(enabled),
    );
    pasteModeRef.current = pasteMode;
    const disposeGestures = installTerminalGestures(
      terminal,
      container,
      () => readOnlyRef.current,
      (message) => notifyRef.current(message, { key: `terminal-clipboard:${terminalId}` }),
      () => gesturePreferencesRef.current,
      (stillCurrent) => clipboard.pasteFromClipboard(stillCurrent),
    );

    paintedRef.current = false;

    let hasBeenBorn = initialTerminal !== undefined;
    let intersecting = false;
    let pageVisible = true;
    let refreshPending = false;
    let published: {
      client: TerminalRendererProps["client"];
      connId: string;
      cols: number;
      rows: number;
    } | null = null;

    const withdrawViewport = (): void => {
      if (published !== null) {
        published.client.releaseTerminalViewport(terminalId, viewportId);
        published = null;
      }
      refreshPending = false;
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
    withdrawViewportRef.current = withdrawViewport;

    const canPublishViewport = (): boolean => {
      const current = clientRef.current;
      const info = current.terminals.get(terminalId);
      if (info !== undefined) hasBeenBorn = true;
      const self = current.self;
      const connId = current.selfConnId;
      const caps = current.selfCaps();
      const rect = container.getBoundingClientRect();
      return (
        !readOnlyRef.current &&
        machineOnlineRef.current &&
        pageVisible &&
        document.visibilityState === "visible" &&
        intersecting &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight &&
        getComputedStyle(container).visibility === "visible" &&
        current.status === "open" &&
        self !== null &&
        connId !== null &&
        current.attendance.get(self.id)?.connIds.includes(connId) === true &&
        (caps.includes("*") || caps.includes("terminals:write")) &&
        (info === undefined
          ? !hasBeenBorn
          : info.status === "running" &&
            info.controllerId === self.id &&
            paintedRef.current &&
            clipboardLiveRef.current)
      );
    };

    const syncViewport = (): void => {
      if (
        !canPublishViewport() ||
        (published !== null &&
          (published.client !== clientRef.current ||
            published.connId !== clientRef.current.selfConnId))
      ) {
        withdrawViewport();
      }
    };
    syncViewportRef.current = syncViewport;

    const sendCurrentGeometry = (): void => {
      resizeFrameRef.current = null;
      syncViewport();
      if (!canPublishViewport()) return;
      const current = clientRef.current;
      const connId = current.selfConnId;
      if (connId === null) return;
      // Desired geometry always comes from the host, never from the applied shared grid.
      // Only the unpainted birth placeholder is resized locally; LIVE viewers all adopt
      // authoritative stream geometry without feeding the applied size back to the broker.
      const proposal = fitAddon.proposeDimensions();
      if (
        proposal === undefined ||
        !Number.isInteger(proposal.cols) ||
        !Number.isInteger(proposal.rows) ||
        proposal.cols <= 0 ||
        proposal.rows <= 0
      ) {
        withdrawViewport();
        return;
      }
      const cols = Math.min(1000, proposal.cols);
      const rows = Math.min(1000, proposal.rows);
      const refresh = refreshPending;
      refreshPending = false;
      if (!refresh && published !== null && published.cols === cols && published.rows === rows) {
        return;
      }
      if (!current.terminals.has(terminalId)) terminal.resize(cols, rows);
      current.resizeTerminal(terminalId, cols, rows, viewportId);
      published = { client: current, connId, cols, rows };
    };

    const scheduleResize = (refresh = false): void => {
      syncViewport();
      if (!canPublishViewport()) return;
      refreshPending ||= refresh;
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(sendCurrentGeometry);
    };
    scheduleResizeRef.current = scheduleResize;
    let settleFrame: number | null = null;
    let settleFollowupFrame: number | null = null;
    const settleAfterReplay = (): void => {
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      if (settleFollowupFrame !== null) window.cancelAnimationFrame(settleFollowupFrame);
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = null;
        terminal.refresh(0, terminal.rows - 1);
        scheduleResize();
        // The host canvas can settle transforms across successive frames. A
        // second measurement catches the final box without waiting for a user
        // resize to make xterm repaint at the correct cell geometry.
        settleFollowupFrame = window.requestAnimationFrame(() => {
          settleFollowupFrame = null;
          terminal.refresh(0, terminal.rows - 1);
          scheduleResize();
        });
      });
    };
    settleRef.current = settleAfterReplay;

    const observer = new ResizeObserver(() => scheduleResize());
    observer.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      intersecting =
        entry !== undefined &&
        entry.isIntersecting &&
        entry.intersectionRect.width > 0 &&
        entry.intersectionRect.height > 0;
      scheduleResize();
    });
    intersectionObserver.observe(container);
    const onVisibilityChange = (): void => {
      scheduleResize();
      if (document.visibilityState === "visible") settleAfterReplay();
    };
    const onPageHide = (): void => {
      pageVisible = false;
      withdrawViewport();
    };
    const onPageShow = (): void => {
      pageVisible = true;
      settleAfterReplay();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.fonts.addEventListener("loadingdone", settleAfterReplay);
    const refreshInterval = window.setInterval(
      () => scheduleResize(true),
      TERMINAL_VIEWPORT_REFRESH_MS,
    );

    return () => {
      withdrawViewport();
      observer.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.fonts.removeEventListener("loadingdone", settleAfterReplay);
      window.clearInterval(refreshInterval);
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      if (settleFollowupFrame !== null) window.cancelAnimationFrame(settleFollowupFrame);
      scheduleResizeRef.current = null;
      syncViewportRef.current = null;
      withdrawViewportRef.current = null;
      settleRef.current = null;
      disposeGestures();
      clipboard.dispose();
      clipboardRef.current = null;
      stream.dispose();
      streamRef.current = null;
      graphics.dispose();
      pasteMode.dispose();
      pasteModeRef.current = null;
      clipboardLiveRef.current = false;
      unsubscribeRenderer();
      renderer.dispose();
      terminal.dispose();
      terminalRef.current = null;
      paintedRef.current = false;
    };
  }, [terminalId, fontReady, viewportId, incarnation]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null || terminal.options.fontSize === fontSize) return;
    terminal.options.fontSize = fontSize;
    // Queue behind pending snapshot replay, using the existing post-replay measurement.
    // Its geometry publication remains controller-only and forbidden in previews.
    if (paintedRef.current) {
      streamRef.current?.barrier(() => {
        if (terminalRef.current === terminal) settleRef.current?.();
      });
    } else {
      scheduleResizeRef.current?.();
    }
  }, [fontSize, fontReady, terminalReady]);

  /**
   * The SOCKET half: output subscriptions, keyboard input and the attach refcount.
   * Keyed on the client, so a portal's spectator⇄occupant swap re-runs exactly this
   * much — the terminal, its DOM node and its buffer all survive — and the re-attach's
   * snapshot lands in the existing terminal as a single-frame `reset()` + replay.
   * That is lossless because the server's snapshot is a complete, seq-anchored picture
   * of the PTY (the no-gap invariant): the replay paints what was already on screen,
   * plus whatever the swap would otherwise have missed. Every frame is this mount's own:
   * sibling views on the same client hold independent deliveries and credit.
   *
   * Declared AFTER the terminal effect so `terminalRef` is populated in the commit that
   * creates it; React runs setups in declaration order.
   */
  useEffect(() => {
    if (!terminalReady || !fontReady) return;
    const terminal = terminalRef.current;
    if (terminal === null) return;
    const stream = streamRef.current;
    if (stream === null) return;

    let subscribed = true;
    clipboardLiveRef.current = false;
    syncViewportRef.current?.();
    const ours = (message: { readonly terminalId: string; readonly viewportId: string }) =>
      message.terminalId === terminalId && message.viewportId === viewportId;
    // A retired delivery's waiting, recovery or refusal no longer describes this view.
    const retireDelivery = (): void => {
      setDelivery((current) =>
        current.terminalId === terminalId &&
        (current.state === "waiting" ||
          current.state === "recovering" ||
          current.state === "refused" ||
          current.state === "stalled")
          ? { ...current, state: "live", reason: null, noticed: false }
          : current,
      );
    };
    const handlers: TerminalDeliveryHandlers = {
      prepare: (preserved) => {
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
        if (preserved) {
          clipboardRef.current?.setPasteMode(pasteModeRef.current?.enabled ?? false);
        } else {
          pasteModeRef.current?.reset();
        }
        paintedRef.current = true;
      },
      settled: () => {
        if (!subscribed) return;
        setDelivery((current) =>
          current.terminalId === terminalId && current.state === "catching_up"
            ? { ...current, state: "live" }
            : current,
        );
        clipboardLiveRef.current = true;
        settleRef.current?.();
      },
      acknowledge: (deliveryId, deliverySeq) => {
        client.ackTerminal(terminalId, viewportId, deliveryId, deliverySeq);
      },
      stalled: () => {
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
        setDelivery({ terminalId, state: "stalled", reason: null, skipped: true, noticed: false });
      },
    };

    const offSnapshot = client.on("terminal_snapshot", (message) => {
      if (!ours(message) || !stream.snapshot(message, handlers)) return;
      // Retained-screen recovery is complete only after replay, not on socket receipt.
      const state = stream.coherent ? "live" : "catching_up";
      setDelivery((current) => {
        const skipped = message.skipped || (current.terminalId === terminalId && current.skipped);
        return current.terminalId === terminalId &&
          current.state === state &&
          current.skipped === skipped
          ? current
          : { terminalId, state, reason: null, skipped, noticed: false };
      });
    });

    const offOutput = client.on("terminal_output", (message) => {
      if (ours(message)) stream.append(message);
    });
    const offGeometry = client.on("terminal_geometry", (message) => {
      if (ours(message)) stream.append(message);
    });
    const offDelivery = client.on("terminal_delivery", (message) => {
      // Only a refusal may precede its attachment's first snapshot, with a null delivery.
      if (
        !ours(message) ||
        (message.deliveryId !== null && message.deliveryId !== stream.deliveryId)
      )
        return;
      if (message.state === "recovering") {
        // Drain and credit accepted work, without trusting modes after the server skipped bytes.
        stream.recover();
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
      }
      if (message.state === "refused") {
        // The server retired this attachment: no credit, no viewport, no input until replay.
        stream.refuse();
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
      }
      setDelivery((current) => ({
        terminalId,
        state: message.state,
        reason: message.reason,
        skipped: message.skipped || (current.terminalId === terminalId && current.skipped),
        noticed: false,
      }));
    });

    const offTerminalEvent = client.on("terminal_event", (message) => {
      if (message.terminalId !== terminalId) return;
      if (message.kind === "restarted") {
        // This is a new byte stream under the same identity. The SDK re-attaches after
        // notifying every view; only its fresh snapshot may make input live again.
        stream.restart();
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
        pasteModeRef.current?.reset();
        paintedRef.current = false;
        setRestartArmed(false);
        // The old process's screen, and any notice about its skipped output, are gone.
        setDelivery((current) =>
          current.terminalId === terminalId && current.state === "catching_up"
            ? { ...current, skipped: false }
            : { terminalId, state: "live", reason: null, skipped: false, noticed: false },
        );
        if (message.fallback !== undefined) {
          notifyRef.current(
            `${message.fallback === "no_recipe" ? "Terminal restored as a plain shell" : `Terminal restarted in ${message.fallback === "original" ? "its original directory" : "the home directory"}`}${message.cwd === undefined ? "" : `: ${message.cwd}`}`,
            { key: `terminal-restart:${terminalId}` },
          );
        }
      }
      if (message.kind === "exited") {
        stream.suspend();
        retireDelivery();
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
        setRestartArmed(false);
      }
    });

    // A watched portal may receive browser focus before its occupant socket is ready.
    // Keep keystrokes off the spectator socket throughout that transition; host-owned
    // titlebar controls never lift this PTY input guard. A fresh, restarted or stalled
    // parser has no coherent modes yet, so keys and its replies cannot encode against them.
    const inputDisposable = terminal.onData((data) => {
      if (readOnlyRef.current || !stream.coherent) return;
      client.sendTerminalInput(terminalId, data);
    });

    // The SDK refcounts each exact (terminal, viewport) pair and re-attaches every held
    // pair by itself after a reconnect or restart.
    client.attachTerminal(terminalId, viewportId);

    const offStatus = client.on("status", (status) => {
      if (status === "open") return;
      stream.suspend();
      retireDelivery();
      clipboardRef.current?.reset();
      clipboardLiveRef.current = false;
    });

    return () => {
      subscribed = false;
      stream.suspend();
      retireDelivery();
      clipboardRef.current?.reset();
      clipboardLiveRef.current = false;
      withdrawViewportRef.current?.();
      offSnapshot();
      offOutput();
      offGeometry();
      offDelivery();
      offTerminalEvent();
      offStatus();
      inputDisposable.dispose();
      client.detachTerminal(terminalId, viewportId);
    };
  }, [client, terminalId, terminalReady, fontReady, viewportId, incarnation]);

  const caps = client.selfCaps();
  const canTake =
    terminal?.status === "running" &&
    offlineMachine === null &&
    !isController &&
    (caps.includes("*") || caps.includes("terminals:write")) &&
    !(takeDenied?.client === client && takeDenied.terminalId === terminalId);
  const showTakeControl = canTake && (!readOnly || onEngage !== undefined);

  // The explicit gesture survives the portal's gapless spectator → occupant swap.
  // A changed placement, ended engagement or refused join cancels it; only the
  // promoted, initialized occupant may send the existing take action.
  useEffect(() => {
    const pending = pendingTakeRef.current;
    if (pending === null) return;
    if (
      pending.terminalId !== terminalId ||
      pending.elementId !== elementId ||
      !active ||
      !canTake
    ) {
      pendingTakeRef.current = null;
      return;
    }
    if (readOnly || client.status !== "open") return;
    pendingTakeRef.current = null;
    client.takeTerminal(terminalId);
    terminalRef.current?.focus();
  }, [active, canTake, client, elementId, readOnly, terminalId]);

  const handleTakeControl = (): void => {
    if (!showTakeControl) return;
    if (readOnly) {
      pendingTakeRef.current = { terminalId, elementId };
      onEngage?.();
      return;
    }
    if (client.status !== "open") return;
    client.takeTerminal(terminalId);
    terminalRef.current?.focus();
  };

  const handleRestart = (): void => {
    if (!canRestart || offlineMachine !== null || isRestarting) return;
    if (terminal?.status === "running" && !restartArmed) {
      setRestartArmed(true);
      return;
    }
    setRestartArmed(false);
    setIsRestarting(true);
    void host.client
      .action("core.terminals.restart", { terminalId })
      .then((outcome) => {
        if (!outcome.ok) throw new Error(outcome.denial.message);
      })
      .catch((reason: unknown) => {
        notify(reason instanceof Error ? reason.message : "Could not restart terminal", {
          key: `terminal-restart:${terminalId}`,
        });
      })
      .finally(() => setIsRestarting(false));
  };

  const notice = delivery.terminalId === terminalId ? deliveryNotice(delivery) : null;
  // Only this view is replaced: its old parser, xterm and credit retire with the incarnation.
  const handleCatchUp = (): void => {
    setDelivery({ terminalId, state: "catching_up", reason: null, skipped: true, noticed: false });
    setIncarnation((value) => value + 1);
  };
  const handleDismissSkipped = (): void => {
    setDelivery((current) => ({ ...current, skipped: false }));
    if (active && !readOnly) terminalRef.current?.focus();
  };

  // The preview's input remains read-only even when its host permits titlebar placement
  // actions. Terminal focus traffic belongs to the occupant socket, never to its chrome.
  const handleFocus = (): void => {
    if (readOnly) return;
    publishLocation();
    if (focusedRef.current) return;
    focusedRef.current = true;
    // The view rides every presence payload (`@manifold/plugin/hooks` view state), so a focus
    // re-publishes what this device is holding.
    client.sendPresence({ focus: { elementId }, vantage: currentVantage() });
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    if (readOnly) return;
    focusedRef.current = false;
    client.sendPresence({ focus: null, vantage: currentVantage() });
  };

  const stopFocusedWheel = (event: WheelEvent<HTMLDivElement>): void => {
    /*
      Plain scroll on a FOCUSED terminal belongs to its scrollback; pinch-zoom
      (browsers report trackpad pinch as ctrl+wheel) belongs to the canvas even
      there. The ctrl guard is load-bearing since the content-portal cutover in
      `tile-tree.tsx`: React instruments every portal container with its own
      listener set, so this handler now runs BEFORE React Flow's zoom listener —
      an unconditional stop here would silently kill pinch-zoom over a terminal.
    */
    if (active && focusedRef.current && !event.ctrlKey) event.stopPropagation();
  };

  /**
   * Double-clicking the titlebar expands, exactly like the button — except on the
   * controls themselves, where a fast double click on Park or Close must not also
   * expand (dblclick fires independently of the pointerdown those buttons stop).
   * A bubble's terminal has no expand at all, so the gesture stays inert there:
   * leaving a view is a deliberate click on Shrink.
   */
  const handleTitlebarDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (onExpand === undefined) return;
    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest("button") !== null || target.closest(`.${TITLEBAR_ACTIONS_CLASS}`) !== null)
    ) {
      return;
    }
    onExpand();
  };

  /**
   * One slot, two meanings. On a canvas the terminal can still grow, so it offers
   * Expand; as the lone leaf of a bubble it is already as big as it gets, so the
   * same corner is how you leave the view that was born around it.
   */
  const maximize =
    onShrink === undefined
      ? {
          onActivate: onExpand,
          control: "maximize" as const,
          label: "Expand terminal to full view",
          tooltip: "Expand to full view",
        }
      : {
          onActivate: onShrink,
          control: "shrink" as const,
          label: "Shrink view",
          tooltip: "Leave this view (Esc)",
        };

  const frameClass = [
    "terminal-frame",
    frame === "tile" ? "terminal-frame--tile" : "",
    panelHighlighted ? "terminal-frame--panel-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const sizing = client.terminalSizing.get(terminalId);
  const describeLimitingViews = (refs: TerminalSizing["columns"]): string => {
    const labels = new Map<string, number>();
    for (const ref of refs) {
      let label = "Another active view";
      if (ref.connId === client.selfConnId && ref.viewportId === viewportId) {
        label = "This view";
      } else {
        for (const attendance of client.attendance.values()) {
          if (attendance.connIds.includes(ref.connId)) {
            label = `${attendance.principal.name}’s view`;
            break;
          }
        }
      }
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
    const names = [...labels].map(([label, count]) =>
      count === 1 ? label : `${label} (${count} views)`,
    );
    return `${names.join(", ")}${refs.length > 1 ? " — tied" : ""}`;
  };
  const columnLimits = sizing?.mode === "smallest" ? describeLimitingViews(sizing.columns) : "";
  const rowLimits = sizing?.mode === "smallest" ? describeLimitingViews(sizing.rows) : "";
  const sizingSummary =
    sizing === undefined
      ? "The shared terminal grid is shown; sizing attribution is unavailable."
      : sizing.mode === "retained"
        ? "No active eligible view. Retaining the last shared terminal grid."
        : "Foreground, on-screen writable views of the controller set the smallest grid, regardless of keyboard focus. Columns and rows are limited independently.";
  const sizingDescription =
    sizing?.mode === "smallest"
      ? `${sizingSummary} Columns limited by: ${columnLimits}. Rows limited by: ${rowLimits}.`
      : sizingSummary;

  return (
    <div
      className={frameClass}
      onPointerDown={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(".terminal-titlebar") !== null) return;
        event.stopPropagation();
        handleFocus();
      }}
      onWheel={stopFocusedWheel}
      onKeyDown={(event) => event.stopPropagation()}
      onFocus={(event) => {
        if (event.target.closest(".node-titlebar, .terminal-delivery") !== null) {
          publishLocation();
          return;
        }
        handleFocus();
      }}
      onBlur={handleBlur}
    >
      <NodeTitleBar
        className="terminal-titlebar"
        dragProps={titlebarDragProps}
        icon={<ItemIcon kind="terminal" size={13} />}
        title={terminal?.name ?? null}
        defaultTitle="terminal"
        onRenameTitle={onRenameTitle}
        {...(renameAction === undefined ? {} : { renameAction })}
        onDoubleClick={handleTitlebarDoubleClick}
        middle={
          <>
            <TitlebarOutlet
              {...(projectionScope === undefined ? {} : { scope: projectionScope })}
            />
            {titlebarMiddle}
            <span className="terminal-cwd" title={cwd ?? "Working directory unknown"}>
              {cwdLabel}
            </span>
            {machine === null ? null : (
              <span className="terminal-machine-badge" title={`machine ${machine.name}`}>
                {machine.color === undefined ? null : (
                  <span
                    className="terminal-machine-dot"
                    style={{ backgroundColor: machine.color }}
                  />
                )}
                {machine.name}
              </span>
            )}
          </>
        }
        onMinimize={onPark}
        minimizeLabel="Park terminal to sidebar"
        minimizeTooltip="Park terminal to sidebar (keeps the shell running)"
        onMaximize={maximize.onActivate}
        maximizeControl={maximize.control}
        maximizeLabel={maximize.label}
        maximizeTooltip={maximize.tooltip}
        onClose={onClose}
        closeLabel="Kill terminal"
        closeTooltip="Kill terminal (ends the terminal)"
        closeClassName="terminal-ctl--close"
        extraActions={
          <>
            {terminal === undefined ? null : (
              <>
                <Popover
                  open={sizingOpen}
                  onOpenChange={setSizingOpen}
                  side="bottom"
                  align="end"
                  contentClassName="terminal-sizing-popover"
                  trigger={
                    <button
                      type="button"
                      className="node-titlebar__ctl terminal-sizing-control"
                      aria-label={`Terminal size ${terminal.cols} columns by ${terminal.rows} rows; sizing details`}
                      aria-describedby={sizingDescriptionId}
                      title={`${terminal.cols}×${terminal.rows}. ${sizingDescription}`}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      {terminal.cols}×{terminal.rows}
                    </button>
                  }
                >
                  <div
                    className="terminal-sizing-details"
                    role="region"
                    aria-label="Terminal sizing details"
                    onPointerDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <strong>
                      Shared terminal grid: {terminal.cols} columns × {terminal.rows} rows
                    </strong>
                    <p>{sizingSummary}</p>
                    {sizing?.mode === "smallest" ? (
                      <dl>
                        <dt>Columns limited by</dt>
                        <dd>{columnLimits}</dd>
                        <dt>Rows limited by</dt>
                        <dd>{rowLimits}</dd>
                      </dl>
                    ) : null}
                  </div>
                </Popover>
                <span id={sizingDescriptionId} hidden>
                  {sizingDescription}
                </span>
              </>
            )}
            {terminal === undefined ? null : (
              <button
                type="button"
                className="node-titlebar__ctl terminal-ctl--restart"
                data-action="core.terminals.restart"
                data-confirming={restartArmed}
                aria-label={restartArmed ? "Confirm restart terminal" : "Restart terminal"}
                title={
                  !canRestart
                    ? "Restart requires terminal write access and control of a running terminal"
                    : restartArmed
                      ? "Press again to end the running process and restart in this directory"
                      : "Restart terminal in this directory"
                }
                disabled={!canRestart || offlineMachine !== null || isRestarting}
                onPointerDown={(event) => event.stopPropagation()}
                onBlur={() => setRestartArmed(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRestartArmed(false);
                }}
                onClick={handleRestart}
              >
                <ControlIcon kind="restart" size={12} />
                {restartArmed ? <span>Restart?</span> : null}
              </button>
            )}
            {showTakeControl ? (
              <button
                type="button"
                className="node-titlebar__ctl"
                data-action="core.terminals.take"
                aria-label="Take control of terminal"
                title="Take control · or double-click terminal"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handleTakeControl}
              >
                <ControlIcon kind="takeControl" size={12} />
              </button>
            ) : null}
            <button
              type="button"
              className="node-titlebar__ctl terminal-renderer-control"
              data-testid="terminal-renderer-toggle"
              aria-label="Use WebGL terminal renderer on this device"
              aria-pressed={rendererMode === "webgl"}
              title={
                rendererMode === "webgl"
                  ? "WebGL requested for this terminal on this device; unsupported or lost contexts use DOM. Press to use DOM."
                  : "Use experimental WebGL for this terminal on this device. DOM remains the default."
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggleRenderer}
            >
              GPU
            </button>
            <button
              type="button"
              className="node-titlebar__ctl"
              aria-label="Decrease terminal font size"
              title="Decrease terminal font size (minimum 8 px)"
              disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => changeFontSize(fontSize - 1)}
            >
              −
            </button>
            <button
              type="button"
              className="node-titlebar__ctl terminal-font-size"
              aria-label={`Terminal font size ${fontSize} pixels; reset to 13 pixels`}
              title={`Font size: ${fontSize} px. Reset to 13 px`}
              disabled={fontSize === TERMINAL_FONT_SIZE}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => changeFontSize(TERMINAL_FONT_SIZE)}
            >
              {fontSize}
            </button>
            <button
              type="button"
              className="node-titlebar__ctl"
              aria-label="Increase terminal font size"
              title="Increase terminal font size (maximum 32 px)"
              disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => changeFontSize(fontSize + 1)}
            >
              +
            </button>
            {titlebarExtras}
          </>
        }
      />
      <div
        className={
          onEngage !== undefined && !active ? "xterm-host xterm-host--inactive" : "xterm-host"
        }
        ref={containerRef}
        data-action={showTakeControl ? "core.terminals.take" : undefined}
        onDoubleClickCapture={handleTakeControl}
        onDoubleClick={(event) => {
          // Never preventDefault: a controller keeps xterm's word selection.
          event.stopPropagation();
          // xterm may consume the event before this bubble handler; takeover runs in capture.
        }}
      />
      {fontReady ? null : (
        <div
          className="terminal-font-status"
          role={fontState.status === "failed" ? "alert" : "status"}
        >
          <Stack gap="0.6rem" align="center">
            <span>
              {fontState.status === "failed" ? fontState.error.message : "Loading terminal font…"}
            </span>
            {fontState.status === "failed" ? (
              <Chip
                className="terminal-font-retry"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={retryTerminalFont}
              >
                Retry font
              </Chip>
            ) : null}
          </Stack>
        </div>
      )}
      {/*
        The idle veil is a property of ATTENTION, not of chrome. It used to be skipped in
        preview because a preview had no notion of a focused tile; a portal's tiles now
        carry `active` (false for every tile while the portal only watches, true for the
        one engaged tile), so the same dimming that tells a canvas which terminal you are
        in tells a portal it is resting — and inside an engaged portal, which tile holds
        the keyboard while its siblings stay veiled.
      */}
      <div
        className={`terminal-idle-veil${active ? "" : " terminal-idle-veil--on"}`}
        aria-hidden="true"
      />
      {/*
        The live region stays mounted so each delivery change is announced. One action
        element keeps focus from the catch-up through the retained-history notice.
      */}
      <div className="terminal-delivery" role="status" aria-label="Terminal output delivery">
        {notice === null ? null : (
          <div className="terminal-delivery__notice">
            <span>{notice.message}</span>
            <Chip
              className="terminal-delivery__action"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={notice.catchUp ? handleCatchUp : handleDismissSkipped}
            >
              {notice.catchUp ? "Catch up to retained screen" : "Dismiss notice"}
            </Chip>
          </div>
        )}
      </div>
      {clipboardCopy === null ? null : (
        <Cover
          className="terminal-clipboard-request"
          role="group"
          aria-label="Terminal clipboard request"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            clipboardCopy.cancel();
          }}
        >
          <Stack gap="0.6rem" align="center">
            <strong>Copy terminal data to your clipboard?</strong>
            <span>
              {clipboardCopy.mimeTypes.join(", ")} · {clipboardCopy.byteLength.toLocaleString()}{" "}
              bytes
            </span>
            <Cluster gap="0.6rem">
              <Chip onClick={() => void clipboardCopy.accept()}>Copy</Chip>
              <Chip autoFocus onClick={() => clipboardCopy.cancel()}>
                Cancel
              </Chip>
            </Cluster>
          </Stack>
        </Cover>
      )}
      {terminal?.status === "exited" || offlineMachine !== null ? (
        <Cover className="terminal-exited">
          <Stack gap="0.6rem" align="center">
            {offlineMachine !== null ? (
              <span>machine offline — {offlineMachine.name}</span>
            ) : (
              <TerminalExitStatus
                exitCode={terminal?.exitCode ?? null}
                exitReason={terminal?.exitReason ?? null}
              />
            )}
            {terminal?.status === "exited" && offlineMachine === null && canRestart ? (
              <button
                type="button"
                className="terminal-restart"
                data-action="core.terminals.restart"
                aria-label="Restart exited terminal"
                title="Restart terminal in this directory, keeping its tile and name"
                disabled={isRestarting}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handleRestart}
              >
                <ControlIcon kind="restart" />
                <span>{isRestarting ? "restarting…" : "restart"}</span>
              </button>
            ) : null}
          </Stack>
        </Cover>
      ) : null}
    </div>
  );
}
