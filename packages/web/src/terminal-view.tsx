import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { base64ToBytes, type SessionClient } from "@manifold/sdk";
import type { Principal } from "@manifold/protocol";
import { useEffect, useReducer, useRef, useState, type FocusEvent, type WheelEvent } from "react";
import type { SessionMachine } from "./machine-visibility.ts";

interface TerminalViewProps {
  readonly client: SessionClient;
  readonly sessionId: string;
  readonly elementId: string;
  /** Excalidraw activation state; a rising edge focuses xterm so typing works right away. */
  readonly active: boolean;
  /** True when other live elements are bound to this same session (clones/mirrors). */
  readonly sessionShared: boolean;
  /** Session-panel hover target; highlights this copy without changing the viewport. */
  readonly panelHighlighted: boolean;
  /** Tombstones this element; kills the PTY only when it was the last binding. */
  readonly onClose: () => void;
  /** Opens a fresh PTY session and rebinds it to this element (restart in place). */
  readonly onRestart: () => Promise<void>;
  /** Resolved machine of this session; null before the first machines fetch. */
  readonly machine: SessionMachine | null;
}

/** Hosts one no-gap terminal viewer and keeps controller-only input and sizing explicit. */
export function TerminalView({
  client,
  sessionId,
  elementId,
  active,
  sessionShared,
  panelHighlighted,
  onClose,
  onRestart,
  machine,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const scheduleResizeRef = useRef<(() => void) | null>(null);
  const focusedRef = useRef(false);
  const [viewOnlyError, setViewOnlyError] = useState(false);
  const [, rerender] = useReducer((version: number) => version + 1, 0);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const session = client.sessions.get(sessionId);
  /** Non-null exactly when this session's machine is known and NOT online. */
  const offlineMachine = machine !== null && !machine.online ? machine : null;
  const selfId = client.self?.id ?? null;
  const isController = selfId !== null && session?.controllerId === selfId;
  const isControllerRef = useRef(false);

  useEffect(() => {
    isControllerRef.current = isController;
  }, [isController]);

  /**
   * Real-terminal feel: activation (one click-release anywhere on the embed)
   * wakes the cursor immediately. Edge-triggered on inactive→active. The focus
   * is re-asserted frame-by-frame for a short window because the browser's own
   * post-click focusing (and Excalidraw's) can land after ours; it stops as
   * soon as focus settles inside the terminal, yields to any deliberate focus
   * on an editable element elsewhere, and dies with deactivation.
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
      // Keep watching through the whole activation transition: a post-click
      // Excalidraw or browser refocus can land after our first success.
      if (performance.now() < deadline) frame = requestAnimationFrame(tick);
    };
    let frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [active]);

  // Maximize = this terminal becomes the view. The Popover API promotes the
  // SAME node into the browser top layer (xterm survives, no remount), escaping
  // Excalidraw's transform without browser-chrome fullscreen. popover="manual"
  // so an outside click can't accidentally restore; Esc and the button do.
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    if (isMaximized) {
      frame.setAttribute("popover", "manual");
      try {
        frame.showPopover();
      } catch (reason: unknown) {
        // Unreachable by design (the button is disabled without Popover
        // support) — but if showPopover still throws, recover instead of
        // wedging in a maximized-without-top-layer state.
        console.error("evt=terminal_maximize_failed", reason);
        frame.removeAttribute("popover");
        const recover = requestAnimationFrame(() => setIsMaximized(false));
        return () => cancelAnimationFrame(recover);
      }
      // Esc restores ONLY while the shell doesn't own the keyboard: inside
      // xterm, Escape belongs to the running program (vim, readline). While
      // typing, the Restore button is the way back.
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        const host = containerRef.current;
        if (host !== null && host.contains(document.activeElement)) return;
        event.stopPropagation();
        setIsMaximized(false);
      };
      document.addEventListener("keydown", onKeyDown, true);
      const onToggle = (event: Event): void => {
        if ((event as ToggleEvent).newState === "closed") setIsMaximized(false);
      };
      frame.addEventListener("toggle", onToggle);
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        scheduleResizeRef.current?.();
        terminalRef.current?.focus();
      });
      return () => {
        document.removeEventListener("keydown", onKeyDown, true);
        frame.removeEventListener("toggle", onToggle);
        if (frame.hasAttribute("popover")) {
          try {
            frame.hidePopover();
          } catch {
            // already hidden
          }
          frame.removeAttribute("popover");
        }
      };
    }
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      scheduleResizeRef.current?.();
    });
    return;
  }, [isMaximized]);

  // A collapsed host has no size to fit against; refit when it reappears.
  useEffect(() => {
    if (isMinimized) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      scheduleResizeRef.current?.();
    });
  }, [isMinimized]);

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
    const container = containerRef.current;
    if (container === null) return;

    const terminal = new Terminal({
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
      fitAddon.fit();
      scheduleResize();
    };

    const observer = new ResizeObserver(fitAndScheduleResize);
    observer.observe(container);
    const initialFitFrame = window.requestAnimationFrame(fitAndScheduleResize);

    const offSnapshot = client.on("terminal_snapshot", (message) => {
      if (message.sessionId !== sessionId) return;
      if (hasRenderedSnapshot) terminal.reset();
      terminal.write(base64ToBytes(message.data));
      snapshotSeq = message.seq;
      lastWrittenSeq = message.seq;
      hasRenderedSnapshot = true;
      const queued = [...bufferedOutputs.entries()].sort(([left], [right]) => left - right);
      bufferedOutputs.clear();
      for (const [seq, data] of queued) {
        if (seq <= message.seq) continue;
        terminal.write(base64ToBytes(data));
        lastWrittenSeq = seq;
      }
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

    const inputDisposable = terminal.onData((data) => {
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
  }, [client, sessionId]);

  useEffect(() => {
    if (!isController) return;
    fitRef.current?.fit();
    scheduleResizeRef.current?.();
  }, [isController]);

  const isRunning = session?.status === "running";
  const showViewOnly = viewOnlyError && !isController;
  // Close is offered when it can complete cleanly: as controller, once the
  // session stopped running, or when this element is just one of several
  // mirrors of the session (closing a mirror never kills the PTY).
  const canClose = isController || !isRunning || sessionShared;

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

  const handleFocus = (): void => {
    if (focusedRef.current) return;
    focusedRef.current = true;
    client.sendPresence({ focus: { elementId } });
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    focusedRef.current = false;
    client.sendPresence({ focus: null });
  };

  const stopFocusedWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (focusedRef.current) event.stopPropagation();
  };

  const supportsMaximize = "showPopover" in HTMLElement.prototype;
  const toggleMaximize = (): void => {
    setIsMaximized((value) => !value);
  };

  // All close semantics (tombstone + last-binding kill decision) live in the
  // host's onClose, which sees the authoritative scene at click time.
  const handleClose = (): void => onClose();

  const frameClass = [
    "manifold-terminal",
    isMinimized ? "manifold-terminal--collapsed" : "",
    isMaximized ? "manifold-terminal--maximized" : "",
    remoteFocuser === null ? "" : "manifold-terminal--remote-focus",
    panelHighlighted ? "manifold-terminal--panel-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={frameRef}
      className={frameClass}
      style={
        remoteFocuser === null
          ? undefined
          : { borderColor: remoteFocuser.color, boxShadow: `0 0 0 2px ${remoteFocuser.color}` }
      }
      onPointerDown={(event) => event.stopPropagation()}
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
      <div className="terminal-titlebar">
        <span className="terminal-titlebar__title">
          <span className="terminal-titlebar__glyph" aria-hidden="true">
            {">_"}
          </span>
          terminal
          {machine === null ? null : (
            <span className="terminal-machine-badge" title={`machine ${machine.name}`}>
              <span className="machine-dot" style={{ backgroundColor: machine.color }} />
              {machine.name}
            </span>
          )}
        </span>
        <div className="terminal-titlebar__controls">
          <button
            type="button"
            className="terminal-ctl"
            title={isMinimized ? "Expand" : "Minimize"}
            aria-label={isMinimized ? "Expand terminal" : "Minimize terminal"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setIsMinimized((value) => !value)}
          >
            {isMinimized ? "□" : "–"}
          </button>
          <button
            type="button"
            className="terminal-ctl"
            title={isMaximized ? "Restore (Esc)" : "Maximize"}
            aria-label={isMaximized ? "Restore terminal" : "Maximize terminal"}
            disabled={!supportsMaximize}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={toggleMaximize}
          >
            ⛶
          </button>
          {canClose ? (
            <button
              type="button"
              className="terminal-ctl terminal-ctl--close"
              title="Close terminal (ends session)"
              aria-label="Close terminal"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handleClose}
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
      <div className="xterm-host" ref={containerRef} />
      <div
        className={`terminal-idle-veil${active || isMinimized || isMaximized ? "" : " terminal-idle-veil--on"}`}
        aria-hidden="true"
      />
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
          {session?.status === "exited" && offlineMachine === null ? (
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
