import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { base64ToBytes, type SessionClient } from "@manifold/sdk";
import { useEffect, useReducer, useRef, useState, type FocusEvent, type WheelEvent } from "react";

interface TerminalViewProps {
  readonly client: SessionClient;
  readonly sessionId: string;
  readonly elementId: string;
  /** Excalidraw activation state; a rising edge focuses xterm so typing works right away. */
  readonly active: boolean;
}

type AttachmentState = "none" | "queued" | "open";

/** Hosts one no-gap terminal viewer and keeps controller-only input and sizing explicit. */
export function TerminalView({ client, sessionId, elementId, active }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const detachTimerRef = useRef<number | null>(null);
  const attachmentRef = useRef<AttachmentState>("none");
  const scheduleResizeRef = useRef<(() => void) | null>(null);
  const focusedRef = useRef(false);
  const [viewOnlyError, setViewOnlyError] = useState(false);
  const [, rerender] = useReducer((version: number) => version + 1, 0);

  const session = client.sessions.get(sessionId);
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

    if (detachTimerRef.current !== null) {
      window.clearTimeout(detachTimerRef.current);
      detachTimerRef.current = null;
    }

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

    if (attachmentRef.current === "none") {
      client.attachTerminal(sessionId);
      attachmentRef.current = client.status === "open" ? "open" : "queued";
    }

    const offStatus = client.on("status", (status) => {
      if (status === "open") {
        if (attachmentRef.current !== "open") {
          client.attachTerminal(sessionId);
          attachmentRef.current = "open";
        }
        return;
      }
      if (attachmentRef.current === "open") attachmentRef.current = "none";
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
      detachTimerRef.current = window.setTimeout(() => {
        client.detachTerminal(sessionId);
        attachmentRef.current = "none";
        detachTimerRef.current = null;
      }, 0);
    };
  }, [client, sessionId]);

  useEffect(() => {
    if (!isController) return;
    fitRef.current?.fit();
    scheduleResizeRef.current?.();
  }, [isController]);

  const controllerId = session?.controllerId ?? null;
  const controller =
    controllerId === client.self?.id
      ? client.self
      : controllerId === null
        ? null
        : (client.roster.get(controllerId)?.principal ?? null);
  const showViewOnly = viewOnlyError && !isController;

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

  return (
    <div
      className="manifold-terminal"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={stopFocusedWheel}
      onKeyDown={(event) => event.stopPropagation()}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="terminal-toolbar">
        <span
          className="controller-badge"
          style={
            controller === null
              ? undefined
              : { borderColor: controller.color, color: controller.color }
          }
        >
          {controller === null ? "no controller" : `controller: ${controller.name}`}
        </span>
      </div>
      <div className="xterm-host" ref={containerRef} />
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
      {session?.status === "exited" ? (
        <div className="terminal-exited">exited (code {session.exitCode ?? "unknown"})</div>
      ) : null}
    </div>
  );
}
