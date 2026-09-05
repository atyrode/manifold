/**
 * The terminal VIEWER — `core.terminals`' browser ref for one PTY.
 *
 * The PTY plane below it stays floor and always will (the broker, the attach refcount, the
 * no-gap snapshot invariant, the byte frames); what lives here is everything that has an
 * answer a principal could argue with: which controls a viewer is offered, what a rename
 * dispatches, when a spectator socket may not write, and what an exited shell looks like.
 *
 * Chrome comes from `@manifold/plugin/ui` — the titlebar, the glyphs, the one notice ref,
 * the published view-state store — so this file owns no drawing and no notification mechanism
 * of its own.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { base64ToBytes } from "@manifold/sdk";
import {
  TitlebarOutlet,
  usePublishLocation,
  type TerminalRendererProps,
} from "@manifold/plugin/hooks";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import {
  ControlIcon,
  Cover,
  ItemIcon,
  NodeTitleBar,
  Stack,
  TITLEBAR_ACTIONS_CLASS,
  currentVantage,
  useNotice,
} from "@manifold/plugin/ui";
import { loadTerminalFont, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "./terminal-font";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  subscribeTerminalFontPreferences,
  terminalFontPreferences,
} from "./terminal-font-preferences";

/** Hosts one no-gap terminal viewer and keeps controller-only input and sizing explicit. */
export function TerminalView({
  client,
  terminalId,
  elementId,
  active,
  panelHighlighted,
  machine,
  chrome = "full",
  onPark,
  onClose,
  onRestart,
  onExpand,
  onShrink,
  titlebarExtras,
  titlebarMiddle,
  titlebarDragProps,
  projectionScope,
  frame = "window",
  onRenameTitle,
  renameAction,
}: TerminalRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const scheduleResizeRef = useRef<(() => void) | null>(null);
  /**
   * True once a snapshot has been painted into the LIVE terminal. It outlives socket
   * swaps on purpose: the next snapshot must replace what is on screen instead of
   * appending to it, whichever socket delivers it.
   */
  const paintedRef = useRef(false);
  /** Post-replay fit/refresh, owned by the terminal effect and called from the socket effect. */
  const settleRef = useRef<(() => void) | null>(null);
  const focusedRef = useRef(false);
  const [viewOnlyError, setViewOnlyError] = useState(false);
  const [fontState, setFontState] = useState<"loading" | "ready" | Error>("loading");
  const fontReady = fontState === "ready";
  const [, rerender] = useReducer((version: number) => version + 1, 0);
  const [isRestarting, setIsRestarting] = useState(false);
  const { notify } = useNotice();
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

  useEffect(() => {
    let cancelled = false;
    void loadTerminalFont().then(
      () => {
        if (!cancelled) setFontState("ready");
      },
      (error: unknown) => {
        if (!cancelled) {
          const failure =
            error instanceof Error ? error : new Error("Could not load terminal font.");
          setFontState(failure);
          notify(failure.message, { key: `terminal-font:${terminalId}` });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [notify, terminalId]);

  const terminal = client.terminals.get(terminalId);
  const terminalReady = terminal !== undefined;
  /** Non-null exactly when this terminal's machine is known and NOT online. */
  const offlineMachine = machine !== null && !machine.online ? machine : null;
  const selfId = client.self?.id ?? null;
  const isController = selfId !== null && terminal?.controllerId === selfId;
  const isControllerRef = useRef(false);

  useEffect(() => {
    isControllerRef.current = isController;
  }, [isController]);

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
  }, [readOnly]);

  /**
   * Real-terminal feel: activation (one click-release anywhere on the embed)
   * wakes the cursor immediately. Edge-triggered on inactive→active. The focus
   * is re-asserted frame-by-frame for a short window because browser focus can
   * land after ours; it stops as soon as focus settles inside the terminal,
   * yields to deliberate focus on an editable element elsewhere, and dies with
   * deactivation.
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
      const editableElsewhere =
        !settled &&
        focused instanceof HTMLElement &&
        (focused.tagName === "INPUT" ||
          focused.tagName === "TEXTAREA" ||
          focused.isContentEditable ||
          focused.closest(".node-titlebar") !== null);
      if (editableElsewhere) return; // user chose another input: stop wrestling
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
    const refreshTerminal = (): void => {
      if (client.terminals.get(terminalId)?.controllerId === client.self?.id) {
        setViewOnlyError(false);
      }
      rerender();
    };
    const offTerminals = client.on("terminals_changed", refreshTerminal);
    const offAttendance = client.on("attendance_changed", rerender);
    return () => {
      offTerminals();
      offAttendance();
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
  }, [client]);

  /**
   * The xterm instance and its DOM host, whose life is the TERMINAL's — never the
   * socket's. A portal escalating from spectator to occupant (and dropping back) hands
   * this component a DIFFERENT `SessionClient` for the same tile; a terminal disposed
   * and re-opened on that swap is a visible refresh — new DOM node, buffer repainted
   * from zero, selection and mouse-mode TUIs losing their host mid-gesture. So
   * creation depends on the terminal alone, and the socket wiring below re-runs against
   * the SAME terminal.
   *
   * `terminalReady` is read off whichever client is painting, and both sides of a role
   * swap know the terminal before the swap is visible (the switch promotes only after
   * `connect()` resolves, and init carries the terminal table), so an escalation never
   * flickers this effect.
   */
  useEffect(() => {
    if (!terminalReady || !fontReady) return;
    const container = containerRef.current;
    if (container === null) return;

    const initialTerminal = clientRef.current.terminals.get(terminalId);
    if (initialTerminal === undefined) return;
    const terminal = new Terminal({
      cols: initialTerminal.cols,
      rows: initialTerminal.rows,
      convertEol: false,
      cursorBlink: true,
      scrollback: 2000,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: terminalFontPreferences.get(terminalId),
      theme: {
        background: "#0b0d10",
        foreground: "#e6e9ef",
        cursor: "#f8f9fa",
        selectionBackground: "#364fc766",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    paintedRef.current = false;

    let lastSentGeometry: { cols: number; rows: number } | null = null;

    const sendCurrentGeometry = (): void => {
      resizeTimerRef.current = null;
      // A preview may fit its own display, but its spectator socket never changes
      // shared PTY geometry, even when another connection of this principal controls it.
      if (readOnlyRef.current) return;
      if (!isControllerRef.current) return;
      const geometry = { cols: terminal.cols, rows: terminal.rows };
      if (
        lastSentGeometry !== null &&
        lastSentGeometry.cols === geometry.cols &&
        lastSentGeometry.rows === geometry.rows
      ) {
        return;
      }
      lastSentGeometry = geometry;
      clientRef.current.resizeTerminal(terminalId, geometry.cols, geometry.rows);
    };

    const scheduleResize = (): void => {
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(sendCurrentGeometry, 250);
    };
    scheduleResizeRef.current = scheduleResize;

    const fitAndScheduleResize = (): void => {
      // Serialized snapshots contain cursor movements for the agent's PTY
      // geometry. Replaying them into an eagerly-fitted viewport corrupts
      // wrapping and character placement. Keep the advertised geometry until
      // replay completes, then fit the painted terminal to its canvas box.
      if (!paintedRef.current) return;
      fitAddon.fit();
      scheduleResize();
    };
    let settleFrame: number | null = null;
    let settleFollowupFrame: number | null = null;
    const settleAfterReplay = (): void => {
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      if (settleFollowupFrame !== null) window.cancelAnimationFrame(settleFollowupFrame);
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = null;
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
        scheduleResize();
        // The host canvas can settle transforms across successive frames. A
        // second measurement catches the final box without waiting for a user
        // resize to make xterm repaint at the correct cell geometry.
        settleFollowupFrame = window.requestAnimationFrame(() => {
          settleFollowupFrame = null;
          fitAddon.fit();
          terminal.refresh(0, terminal.rows - 1);
          scheduleResize();
        });
      });
    };
    settleRef.current = settleAfterReplay;

    const observer = new ResizeObserver(fitAndScheduleResize);
    observer.observe(container);
    const initialFitFrame = window.requestAnimationFrame(fitAndScheduleResize);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(initialFitFrame);
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      if (settleFollowupFrame !== null) window.cancelAnimationFrame(settleFollowupFrame);
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      scheduleResizeRef.current = null;
      settleRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      paintedRef.current = false;
    };
  }, [terminalId, terminalReady, fontReady]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null || terminal.options.fontSize === fontSize) return;
    terminal.options.fontSize = fontSize;
    // Queue behind pending snapshot writes, using the existing post-replay fit.
    // Its geometry publication remains controller-only and forbidden in previews.
    if (paintedRef.current) {
      terminal.write("", () => {
        if (terminalRef.current === terminal) settleRef.current?.();
      });
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

    let snapshotSeq: number | null = null;
    let lastWrittenSeq = 0;
    const bufferedOutputs = new Map<number, string>();
    const settle = (): void => settleRef.current?.();

    const offSnapshot = client.on("terminal_snapshot", (message) => {
      if (message.terminalId !== terminalId) return;
      // Whatever is on screen — painted by this socket or by the one it replaced — is
      // REPLACED by the snapshot, never appended to.
      if (paintedRef.current) terminal.reset();
      snapshotSeq = message.seq;
      lastWrittenSeq = message.seq;
      paintedRef.current = true;
      const queued = [...bufferedOutputs.entries()]
        .filter(([seq]) => seq > message.seq)
        .sort(([left], [right]) => left - right);
      bufferedOutputs.clear();
      terminal.write(base64ToBytes(message.data), queued.length === 0 ? settle : undefined);
      queued.forEach(([seq, data], index) => {
        terminal.write(base64ToBytes(data), index === queued.length - 1 ? settle : undefined);
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
      if (message.kind === "resized" && message.cols !== undefined && message.rows !== undefined) {
        terminal.resize(message.cols, message.rows);
      }
    });

    const offError = client.on("error", (message) => {
      if (
        message.code === "not_controller" &&
        (message.ref === undefined || message.ref === terminalId)
      ) {
        setViewOnlyError(true);
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
      // Connection dropped: the next snapshot starts a fresh sequence.
      snapshotSeq = null;
      lastWrittenSeq = 0;
      bufferedOutputs.clear();
    });

    return () => {
      offSnapshot();
      offOutput();
      offTerminalEvent();
      offError();
      offStatus();
      inputDisposable.dispose();
      client.detachTerminal(terminalId);
    };
  }, [client, terminalId, terminalReady, fontReady]);

  useEffect(() => {
    if (!isController || !paintedRef.current) return;
    fitRef.current?.fit();
    scheduleResizeRef.current?.();
  }, [isController]);

  const showViewOnly = viewOnlyError && !isController;

  // The preview's input remains read-only even when its host permits titlebar placement
  // actions. Terminal focus traffic belongs to the occupant socket, never to its chrome.
  const handleFocus = (): void => {
    if (readOnly) return;
    publishLocation();
    if (focusedRef.current) return;
    focusedRef.current = true;
    // The view rides every presence payload (`@manifold/plugin/ui` view state), so a focus
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
    if (focusedRef.current && !event.ctrlKey) event.stopPropagation();
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
            {machine === null ? null : (
              <span className="terminal-machine-badge" title={`machine ${machine.name}`}>
                {machine.color === undefined ? null : (
                  <span className="machine-dot" style={{ backgroundColor: machine.color }} />
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
      <div className="xterm-host" ref={containerRef} />
      {fontReady ? null : (
        <div
          className="terminal-font-status"
          role={fontState instanceof Error ? "alert" : "status"}
        >
          {fontState instanceof Error ? fontState.message : "Loading terminal font…"}
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
        NOT a notice, so it does not become a notice: this is a MODE indicator. It
        states a standing condition of this terminal ("your socket may not write
        here") and it is the control that ends that condition, anchored to the
        ref the condition applies to. A notice is a message about an event that
        just happened and then stops being true; this stays true until clicked, and
        in a canvas of many terminals it has to say WHICH terminal by sitting on it.
      */}
      {showViewOnly && !readOnly ? (
        <button
          className="view-only-ribbon"
          type="button"
          onClick={() => {
            client.takeTerminal(terminalId);
            // Hand focus straight back to the terminal: the whole point of
            // taking control is to type, and the button click just stole focus.
            terminalRef.current?.focus();
          }}
        >
          view-only — click to take control
        </button>
      ) : null}
      {terminal?.status === "exited" || offlineMachine !== null ? (
        <Cover className="terminal-exited">
          <Stack gap="0.6rem" align="center">
            {offlineMachine !== null ? (
              <span>machine offline — {offlineMachine.name}</span>
            ) : (
              // A null code is a shell that never reported one; "unknown" told the
              // operator nothing the missing number did not already say.
              <span>
                {typeof terminal?.exitCode === "number"
                  ? `exited (${String(terminal.exitCode)})`
                  : "exited"}
              </span>
            )}
            {!readOnly &&
            terminal?.status === "exited" &&
            offlineMachine === null &&
            onRestart !== undefined ? (
              <button
                type="button"
                className="terminal-restart"
                title="Restart terminal (new shell, same spot)"
                disabled={isRestarting}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setIsRestarting(true);
                  void onRestart()
                    .catch((reason: unknown) => {
                      // The button that started the restart is the one place that knows a
                      // restart was attempted at all, so it is where the failure is reported.
                      // Keyed per terminal: hammering restart replaces the notice, never stacks.
                      notify(
                        reason instanceof Error ? reason.message : "Could not restart terminal",
                        { key: `terminal-restart:${terminalId}` },
                      );
                    })
                    .finally(() => setIsRestarting(false));
                }}
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
