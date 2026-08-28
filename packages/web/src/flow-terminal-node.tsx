import type { MachineSummary } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import type { NodeProps } from "@xyflow/react";
import { createContext, useContext, useEffect, useRef } from "react";
import { TerminalView } from "./terminal-view.tsx";
import type { SessionMachine } from "./machine-visibility.ts";

/**
 * The one node type this spike registers. Declared in its own module so the `nodeTypes`
 * map in the container can be a module-scope constant: an inline object literal would give
 * React Flow a new component identity on every render, remounting every node — which for
 * manifold means destroying every PTY. React Flow only warns about this in development.
 */

export interface FlowPadContextValue {
  readonly client: SessionClient;
  readonly machines: readonly MachineSummary[] | null;
  readonly machineFor: (sessionId: string) => SessionMachine | null;
  readonly onClose: (elementId: string, sessionId: string) => void;
  readonly onRestart: (elementId: string, sessionId: string) => Promise<void>;
  readonly sessionShared: (elementId: string, sessionId: string) => boolean;
  /**
   * Remount telemetry for the spike's acceptance criteria. A terminal that survives
   * pan/zoom/select must report exactly one mount for the life of the route.
   */
  readonly noteMount: (elementId: string) => void;
}

const FlowPadContext = createContext<FlowPadContextValue | null>(null);

export const FlowPadProvider = FlowPadContext.Provider;

export function useFlowPad(): FlowPadContextValue {
  const value = useContext(FlowPadContext);
  if (value === null) throw new Error("FlowPadContext is missing above a terminal node");
  return value;
}

/** Selector React Flow uses as this node's drag handle; see the grip element below. */
export const TERMINAL_DRAG_HANDLE = ".flow-terminal__grip";

export function TerminalNode({ id, data, selected }: NodeProps): React.ReactElement {
  const sessionId = typeof data["sessionId"] === "string" ? data["sessionId"] : "";
  const pad = useFlowPad();
  const notedRef = useRef(false);

  useEffect(() => {
    // Counted once per real mount. StrictMode's deliberate double-invoke would otherwise
    // read as a remount, so the ref keeps this honest per component instance.
    if (notedRef.current) return;
    notedRef.current = true;
    pad.noteMount(id);
  }, [id, pad]);

  if (sessionId === "") return <div className="terminal-placeholder">Opening terminal…</div>;

  return (
    <div className="flow-terminal" style={{ width: "100%", height: "100%" }}>
      {/*
        Manifold-owned drag strip, deliberately OUTSIDE TerminalView's frame. The frame
        stops pointerdown propagation so xterm keeps its own selection and focus, which
        also means React Flow can never observe a drag that starts inside it. Rather than
        reach into TerminalView's internal titlebar, the node supplies its own grip.
      */}
      <div className={`flow-terminal__grip${selected ? " flow-terminal__grip--selected" : ""}`}>
        <span className="flow-terminal__grip-dots" aria-hidden="true">
          ⠿
        </span>
        <span className="flow-terminal__grip-hint">drag</span>
      </div>
      {/*
        `nodrag`/`nopan` are belt-and-braces: TerminalView already stops pointerdown, so
        React Flow would not start a gesture here anyway. `nowheel` is deliberately NOT
        set — TerminalView stops wheel only while focused, which preserves today's
        behaviour where scrolling over an idle terminal still zooms the canvas.
      */}
      <div className="flow-terminal__body nodrag nopan">
        <TerminalView
          client={pad.client}
          sessionId={sessionId}
          elementId={id}
          active={selected === true}
          sessionShared={pad.sessionShared(id, sessionId)}
          panelHighlighted={false}
          onClose={() => pad.onClose(id, sessionId)}
          onRestart={() => pad.onRestart(id, sessionId)}
          machine={pad.machineFor(sessionId)}
        />
      </div>
    </div>
  );
}
