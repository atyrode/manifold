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
  type TerminalSizing,
} from "@manifold/protocol";
import { base64ToBytes } from "@manifold/sdk";
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
import { installTerminalGraphics, type TerminalGraphics } from "./terminal-graphics";
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

const EMPTY_SNAPSHOT = new Uint8Array(0);

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
  const graphicsRef = useRef<TerminalGraphics | null>(null);
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
          focused.closest(".node-titlebar, .popover__content") !== null);
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
   * tile alone, and the socket wiring below re-runs against the SAME terminal.
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
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    const graphics = installTerminalGraphics(terminal, (message) =>
      notifyRef.current(message, { key: `terminal-graphics:${terminalId}` }),
    );
    graphicsRef.current = graphics;
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
      // authoritative resize events without feeding their applied size back to the broker.
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
      graphics.dispose();
      graphicsRef.current = null;
      pasteMode.dispose();
      pasteModeRef.current = null;
      clipboardLiveRef.current = false;
      terminal.dispose();
      terminalRef.current = null;
      paintedRef.current = false;
    };
  }, [terminalId, fontReady, viewportId]);

  useEffect(() => {
    const instance = terminalRef.current;
    if (
      instance === null ||
      terminal === undefined ||
      (instance.cols === terminal.cols && instance.rows === terminal.rows)
    )
      return;
    instance.resize(terminal.cols, terminal.rows);
  }, [terminal]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null || terminal.options.fontSize === fontSize) return;
    terminal.options.fontSize = fontSize;
    // Queue behind pending snapshot writes, using the existing post-replay measurement.
    // Its geometry publication remains controller-only and forbidden in previews.
    if (paintedRef.current) {
      terminal.write("", () => {
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
   * plus whatever the swap would otherwise have missed.
   *
   * Declared AFTER the terminal effect so `terminalRef` is populated in the commit that
   * creates it; React runs setups in declaration order.
   */
  useEffect(() => {
    if (!terminalReady || !fontReady) return;
    const terminal = terminalRef.current;
    if (terminal === null) return;

    let subscribed = true;
    clipboardLiveRef.current = false;
    syncViewportRef.current?.();
    let snapshotSeq: number | null = null;
    let lastWrittenSeq = 0;
    let streamGeneration = 0;
    const bufferedOutputs = new Map<number, string>();
    const settle = (generation: number): void => {
      if (!subscribed || generation !== streamGeneration) return;
      clipboardLiveRef.current = true;
      settleRef.current?.();
    };

    const offSnapshot = client.on("terminal_snapshot", (message) => {
      if (message.terminalId !== terminalId) return;
      const generation = ++streamGeneration;
      const settled = (): void => settle(generation);
      // A retained owner's unchanged watermark is already painted. Rewriting identical
      // stream state on a transport handoff would clear the user's live selection.
      const alreadyPainted =
        snapshotSeq !== null && paintedRef.current && message.seq === lastWrittenSeq;
      clipboardRef.current?.reset();
      clipboardLiveRef.current = false;
      syncViewportRef.current?.();
      if (alreadyPainted) {
        clipboardRef.current?.setPasteMode(pasteModeRef.current?.enabled ?? false);
      } else {
        pasteModeRef.current?.reset();
      }
      // Changed stream state replaces the screen; it is never appended to.
      snapshotSeq = message.seq;
      lastWrittenSeq = message.seq;
      paintedRef.current = true;
      const queued = [...bufferedOutputs.entries()]
        .filter(([seq]) => seq > message.seq)
        .sort(([left], [right]) => left - right);
      bufferedOutputs.clear();
      if (alreadyPainted) {
        if (queued.length === 0) settled();
      } else {
        graphicsRef.current?.writeSnapshot(
          base64ToBytes(message.data),
          queued.length === 0 ? settled : undefined,
        );
      }
      queued.forEach(([seq, data], index) => {
        terminal.write(base64ToBytes(data), index === queued.length - 1 ? settled : undefined);
        lastWrittenSeq = seq;
      });
    });

    const offOutput = client.on("terminal_output", (message) => {
      if (message.terminalId !== terminalId) return;
      if (snapshotSeq === null) {
        bufferedOutputs.set(message.seq, message.data);
        return;
      }
      if (message.seq <= lastWrittenSeq) return;
      terminal.write(base64ToBytes(message.data));
      lastWrittenSeq = message.seq;
    });

    const offTerminalEvent = client.on("terminal_event", (message) => {
      if (message.terminalId !== terminalId) return;
      if (message.kind === "restarted") {
        // This is a new byte stream under the same identity. The SDK re-attaches after
        // notifying every view; only its fresh snapshot may make input live again.
        streamGeneration++;
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
        pasteModeRef.current?.reset();
        snapshotSeq = null;
        lastWrittenSeq = 0;
        bufferedOutputs.clear();
        paintedRef.current = false;
        graphicsRef.current?.writeSnapshot(EMPTY_SNAPSHOT);
        setRestartArmed(false);
        if (message.fallback !== undefined) {
          notifyRef.current(
            `${message.fallback === "no_recipe" ? "Terminal restored as a plain shell" : `Terminal restarted in ${message.fallback === "original" ? "its original directory" : "the home directory"}`}${message.cwd === undefined ? "" : `: ${message.cwd}`}`,
            { key: `terminal-restart:${terminalId}` },
          );
        }
      }
      if (message.kind === "exited") {
        streamGeneration++;
        clipboardRef.current?.reset();
        clipboardLiveRef.current = false;
        syncViewportRef.current?.();
        setRestartArmed(false);
      }
      if (message.kind === "resized" && message.cols !== undefined && message.rows !== undefined) {
        const { cols, rows } = message;
        terminal.write("", () => terminal.resize(cols, rows));
      }
    });

    // A watched portal may receive browser focus before its occupant socket is ready.
    // Keep keystrokes off the spectator socket throughout that transition; host-owned
    // titlebar controls never lift this PTY input guard.
    const inputDisposable = terminal.onData((data) => {
      if (readOnlyRef.current) return;
      client.sendTerminalInput(terminalId, data);
    });

    // The SDK refcounts attach/detach per terminal (clones share one wire
    // subscription) and re-subscribes by itself after a reconnect.
    client.attachTerminal(terminalId);

    const offStatus = client.on("status", (status) => {
      if (status === "open") return;
      streamGeneration++;
      clipboardRef.current?.reset();
      clipboardLiveRef.current = false;
      pasteModeRef.current?.reset();
      // Connection dropped: the next snapshot starts a fresh sequence.
      snapshotSeq = null;
      lastWrittenSeq = 0;
      bufferedOutputs.clear();
    });

    return () => {
      subscribed = false;
      clipboardRef.current?.reset();
      clipboardLiveRef.current = false;
      withdrawViewportRef.current?.();
      pasteModeRef.current?.reset();
      offSnapshot();
      offOutput();
      offTerminalEvent();
      offStatus();
      inputDisposable.dispose();
      client.detachTerminal(terminalId);
    };
  }, [client, terminalId, terminalReady, fontReady]);

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
        if (event.target.closest(".node-titlebar") !== null) {
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
