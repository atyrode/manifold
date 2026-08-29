import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { base64ToBytes, type SessionClient } from "@manifold/sdk";
import type { Principal } from "@manifold/protocol";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import type { SessionMachine } from "./machine-visibility.ts";

interface TerminalViewProps {
  readonly client: SessionClient;
  readonly sessionId: string;
  /**
   * Stable placement id: the canvas element id, or the tile id inside a tiled
   * container. It is only ever a presence focus key, so either one is correct.
   */
  readonly elementId: string;
  /** Host-canvas selection state; a rising edge focuses xterm so typing works immediately. */
  readonly active: boolean;
  /** Session-panel hover target; highlights this copy without changing the viewport. */
  readonly panelHighlighted: boolean;
  /** Resolved machine of this session; null before the first machines fetch. */
  readonly machine: SessionMachine | null;
  /**
   * `preview` is the read-only chrome a portal widget paints inside a canvas: the
   * titlebar keeps the name and the machine badge, while the control cluster and
   * the idle veil are gone because nothing in a preview is actionable.
   */
  readonly chrome?: "full" | "preview";
  /** Parks this element: the PTY keeps running in the workspace terminal pool. */
  readonly onPark?: () => void;
  /** Kills the PTY and removes this element. */
  readonly onClose?: () => void;
  /** Opens a fresh PTY session and rebinds it to this element (restart in place). */
  readonly onRestart?: () => Promise<void>;
  /**
   * Transmutes this terminal into a tiled view born around it — the titlebar
   * Expand button and titlebar double-click. Omitted inside a view: the terminal
   * already lives in one.
   */
  readonly onExpand?: () => void;
}

/** Hosts one no-gap terminal viewer and keeps controller-only input and sizing explicit. */
export function TerminalView({
  client,
  sessionId,
  elementId,
  active,
  panelHighlighted,
  machine,
  chrome = "full",
  onPark,
  onClose,
  onRestart,
  onExpand,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const scheduleResizeRef = useRef<(() => void) | null>(null);
  const focusedRef = useRef(false);
  const [viewOnlyError, setViewOnlyError] = useState(false);
  const [, rerender] = useReducer((version: number) => version + 1, 0);
  const [isRestarting, setIsRestarting] = useState(false);

  const session = client.sessions.get(sessionId);
  const sessionReady = session !== undefined;
  /** Non-null exactly when this session's machine is known and NOT online. */
  const offlineMachine = machine !== null && !machine.online ? machine : null;
  const selfId = client.self?.id ?? null;
  const isController = selfId !== null && session?.controllerId === selfId;
  const isControllerRef = useRef(false);

  useEffect(() => {
    isControllerRef.current = isController;
  }, [isController]);

  /**
   * Preview chrome paints a widget's read-only body over a SPECTATOR socket, so nothing
   * in it may write. Held in a ref for the same reason `isController` is: the xterm
   * lifecycle effect must not tear a live terminal down to observe a prop.
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
          focused.isContentEditable);
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
  }, [active]);

  useEffect(() => {
    const refreshSession = (): void => {
      if (client.sessions.get(sessionId)?.controllerId === client.self?.id) {
        setViewOnlyError(false);
      }
      rerender();
    };
    const offSessions = client.on("sessions_changed", refreshSession);
    const offRoster = client.on("roster_changed", rerender);
    return () => {
      offSessions();
      offRoster();
    };
  }, [client, sessionId]);

  useEffect(() => {
    if (!sessionReady) return;
    const container = containerRef.current;
    if (container === null) return;

    const initialSession = client.sessions.get(sessionId);
    if (initialSession === undefined) return;
    const terminal = new Terminal({
      cols: initialSession.cols,
      rows: initialSession.rows,
      convertEol: false,
      cursorBlink: true,
      scrollback: 2000,
      fontSize: 13,
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

    let snapshotSeq: number | null = null;
    let lastWrittenSeq = 0;
    let hasRenderedSnapshot = false;
    const bufferedOutputs = new Map<number, string>();
    let lastSentGeometry: { cols: number; rows: number } | null = null;

    const sendCurrentGeometry = (): void => {
      resizeTimerRef.current = null;
      // A preview paints a scaled-down box, and its socket is a spectator the server
      // refuses writes from. Sending this geometry would either be rejected or — worse,
      // if the same principal happens to hold the PTY — squeeze the real terminal down
      // to the size of somebody's widget.
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
      client.resizeTerminal(sessionId, geometry.cols, geometry.rows);
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
      if (!hasRenderedSnapshot) return;
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

    const observer = new ResizeObserver(fitAndScheduleResize);
    observer.observe(container);
    const initialFitFrame = window.requestAnimationFrame(fitAndScheduleResize);

    const offSnapshot = client.on("terminal_snapshot", (message) => {
      if (message.sessionId !== sessionId) return;
      if (hasRenderedSnapshot) terminal.reset();
      snapshotSeq = message.seq;
      lastWrittenSeq = message.seq;
      hasRenderedSnapshot = true;
      const queued = [...bufferedOutputs.entries()]
        .filter(([seq]) => seq > message.seq)
        .sort(([left], [right]) => left - right);
      bufferedOutputs.clear();
      terminal.write(
        base64ToBytes(message.data),
        queued.length === 0 ? settleAfterReplay : undefined,
      );
      queued.forEach(([seq, data], index) => {
        terminal.write(
          base64ToBytes(data),
          index === queued.length - 1 ? settleAfterReplay : undefined,
        );
        lastWrittenSeq = seq;
      });
    });

    const offOutput = client.on("terminal_output", (message) => {
      if (message.sessionId !== sessionId) return;
      if (snapshotSeq === null) {
        bufferedOutputs.set(message.seq, message.data);
        return;
      }
      if (message.seq <= lastWrittenSeq) return;
      terminal.write(base64ToBytes(message.data));
      lastWrittenSeq = message.seq;
    });

    const offSessionEvent = client.on("session_event", (message) => {
      if (message.sessionId !== sessionId) return;
      if (message.kind === "resized" && message.cols !== undefined && message.rows !== undefined) {
        terminal.resize(message.cols, message.rows);
      }
    });

    const offError = client.on("error", (message) => {
      if (
        message.code === "not_controller" &&
        (message.ref === undefined || message.ref === sessionId)
      ) {
        setViewOnlyError(true);
      }
    });

    // Previews are read-only: the widget's shield keeps focus out, and this keeps a
    // stray keystroke from ever reaching a spectator socket the server would refuse.
    const inputDisposable = terminal.onData((data) => {
      if (readOnlyRef.current) return;
      client.sendTerminalInput(sessionId, data);
    });

    // The SDK refcounts attach/detach per session (clones share one wire
    // subscription) and re-subscribes by itself after a reconnect.
    client.attachTerminal(sessionId);

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
      offSessionEvent();
      offError();
      offStatus();
      inputDisposable.dispose();
      observer.disconnect();
      window.cancelAnimationFrame(initialFitFrame);
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      if (settleFollowupFrame !== null) window.cancelAnimationFrame(settleFollowupFrame);
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      scheduleResizeRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      client.detachTerminal(sessionId);
    };
  }, [client, sessionId, sessionReady]);

  useEffect(() => {
    if (!isController) return;
    fitRef.current?.fit();
    scheduleResizeRef.current?.();
  }, [isController]);

  const showViewOnly = viewOnlyError && !isController;

  // Focus presence — other principals whose ephemeral focus is on THIS terminal.
  // Distinct from controllerId (the write lease): this is "who is looking/typing
  // here right now", the signal that veils the terminal for everyone else.
  const selfPrincipalId = client.self?.id ?? null;
  const remoteFocusers: Principal[] = [];
  for (const state of client.roster.values()) {
    if (state.principal.id === selfPrincipalId) continue;
    if (state.payload.focus?.elementId === elementId) remoteFocusers.push(state.principal);
  }
  const remoteFocuser = remoteFocusers[0] ?? null;

  // Focus presence is a write, and a preview's socket is a spectator: xterm's helper
  // textarea is tabbable even under the widget's shield, so the guard lives here.
  const handleFocus = (): void => {
    if (readOnly || focusedRef.current) return;
    focusedRef.current = true;
    client.sendPresence({ focus: { elementId } });
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    if (readOnly) return;
    focusedRef.current = false;
    client.sendPresence({ focus: null });
  };

  const stopFocusedWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (focusedRef.current) event.stopPropagation();
  };

  /**
   * Double-clicking the titlebar expands, exactly like the button — except on the
   * controls themselves, where a fast double click on Park or Close must not also
   * expand (dblclick fires independently of the pointerdown those buttons stop).
   */
  const handleTitlebarDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (onExpand === undefined) return;
    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest("button") !== null || target.closest(".terminal-titlebar__controls") !== null)
    ) {
      return;
    }
    onExpand();
  };

  const frameClass = [
    "manifold-terminal",
    remoteFocuser === null ? "" : "manifold-terminal--remote-focus",
    panelHighlighted ? "manifold-terminal--panel-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={frameClass}
      style={
        remoteFocuser === null
          ? undefined
          : { borderColor: remoteFocuser.color, boxShadow: `0 0 0 2px ${remoteFocuser.color}` }
      }
      onPointerDown={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(".terminal-titlebar") !== null) return;
        event.stopPropagation();
      }}
      onWheel={stopFocusedWheel}
      onKeyDown={(event) => event.stopPropagation()}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {remoteFocuser === null ? null : (
        <div className="terminal-presence" aria-hidden="true">
          {remoteFocusers.slice(0, 3).map((principal) => (
            <span
              key={principal.id}
              className="terminal-presence__tag"
              style={{ backgroundColor: principal.color }}
              title={`${principal.name} is here`}
            >
              <span className="terminal-presence__initial">
                {principal.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="terminal-presence__name">{principal.name}</span>
            </span>
          ))}
        </div>
      )}
      <div className="terminal-titlebar" onDoubleClick={handleTitlebarDoubleClick}>
        <span className="terminal-titlebar__title">
          <span className="terminal-titlebar__glyph" aria-hidden="true">
            {">_"}
          </span>
          {session?.name ?? "terminal"}
          {machine === null ? null : (
            <span className="terminal-machine-badge" title={`machine ${machine.name}`}>
              <span className="machine-dot" style={{ backgroundColor: machine.color }} />
              {machine.name}
            </span>
          )}
        </span>
        {chrome === "preview" ? null : (
          <div className="terminal-titlebar__controls">
            {onPark === undefined ? null : (
              <button
                type="button"
                className="terminal-ctl"
                title="Park terminal to sidebar (keeps the shell running)"
                aria-label="Park terminal to sidebar"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onPark}
              >
                –
              </button>
            )}
            {onExpand === undefined ? null : (
              <button
                type="button"
                className="terminal-ctl"
                title="Expand to full view"
                aria-label="Expand terminal to full view"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onExpand}
              >
                ⛶
              </button>
            )}
            {onClose === undefined ? null : (
              <button
                type="button"
                className="terminal-ctl terminal-ctl--close"
                title="Kill terminal (ends the session)"
                aria-label="Kill terminal"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onClose}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>
      <div className="xterm-host" ref={containerRef} />
      {chrome === "preview" ? null : (
        <div
          className={`terminal-idle-veil${active ? "" : " terminal-idle-veil--on"}`}
          aria-hidden="true"
        />
      )}
      {showViewOnly ? (
        <button
          className="view-only-ribbon"
          type="button"
          onClick={() => {
            client.takeTerminal(sessionId);
            // Hand focus straight back to the terminal: the whole point of
            // taking control is to type, and the button click just stole focus.
            terminalRef.current?.focus();
          }}
        >
          view-only — click to take control
        </button>
      ) : null}
      {session?.status === "exited" || offlineMachine !== null ? (
        <div className="terminal-exited">
          {offlineMachine !== null ? (
            <span>machine offline — {offlineMachine.name}</span>
          ) : (
            <span>exited (code {session?.exitCode ?? "unknown"})</span>
          )}
          {session?.status === "exited" && offlineMachine === null && onRestart !== undefined ? (
            <button
              type="button"
              className="terminal-restart"
              title="Restart terminal (new shell, same spot)"
              disabled={isRestarting}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                setIsRestarting(true);
                void onRestart().finally(() => setIsRestarting(false));
              }}
            >
              {isRestarting ? "⟳ restarting…" : "⟳ restart"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
