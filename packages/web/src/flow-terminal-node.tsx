import type { MachineSummary } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { NodeResizer, type NodeProps } from "@xyflow/react";
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
  /** Streams live resize geometry and commits its final frame. */
  readonly onResize: (
    elementId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  readonly onResizeEnd: (
    elementId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  readonly editingId: string | null;
  readonly beginTextEditing: (elementId: string) => void;
  readonly endTextEditing: (elementId: string) => void;
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
  if (value === null) throw new Error("FlowPadContext is missing above a canvas node");
  return value;
}

/**
 * React Flow drag handle. The terminal's OWN titlebar, which is what a user reaches for —
 * enabled by `TerminalView`'s opt-in `titlebarDragsHost` seam, since the frame otherwise
 * swallows pointerdown so xterm can own selection.
 */
export const TERMINAL_DRAG_HANDLE = ".terminal-titlebar";

/** Keeps a resize from collapsing a terminal below a usable shell. */
export const MIN_TERMINAL_WIDTH = 320;
export const MIN_TERMINAL_HEIGHT = 200;

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
    <div className="flow-terminal">
      {/* Resize handles commit once on resize end, matching the drag path. */}
      <NodeResizer
        nodeId={id}
        isVisible={selected === true}
        minWidth={MIN_TERMINAL_WIDTH}
        minHeight={MIN_TERMINAL_HEIGHT}
        onResize={(_event, params) =>
          pad.onResize(id, params.x, params.y, params.width, params.height)
        }
        onResizeEnd={(_event, params) =>
          pad.onResizeEnd(id, params.x, params.y, params.width, params.height)
        }
      />
      {/*
        The titlebar is the drag handle (see TERMINAL_DRAG_HANDLE). `nowheel` is deliberately
        NOT set: TerminalView stops wheel only while focused, preserving today's behaviour
        where scrolling over an idle terminal still zooms the canvas.
      */}
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
  );
}
