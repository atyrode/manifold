import type { MachineSummary } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { createContext, memo, useContext } from "react";
import { TerminalView } from "./terminal-view.tsx";
import type { CanvasTool } from "./canvas-tool.ts";
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
  /**
   * The active canvas tool. Terminals only offer their border grab zones under the
   * select tool, so a draw or text gesture starting on a frame edge stays a draw or
   * text gesture.
   */
  readonly tool: CanvasTool;
  readonly editingId: string | null;
  readonly beginTextEditing: (elementId: string) => void;
  readonly endTextEditing: (elementId: string) => void;
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

function TerminalNodeImpl({ id, data, selected }: NodeProps): React.ReactElement {
  const sessionId = typeof data["sessionId"] === "string" ? data["sessionId"] : "";
  const pad = useFlowPad();

  if (sessionId === "") return <div className="terminal-placeholder">Opening terminal…</div>;

  return (
    <div className="flow-terminal">
      {/*
        Desktop-window ergonomics: the frame border is the grab zone, so the pointer
        turns into a resize cursor on hover and no selection step is needed. The
        controls stay transparent — the cursor is the affordance — and commit once on
        resize end, matching the drag path.
      */}
      <NodeResizer
        nodeId={id}
        isVisible={pad.tool === "select"}
        lineClassName="flow-terminal-resize-edge"
        handleClassName="flow-terminal-resize-corner"
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

/**
 * React Flow's own `NodeWrapper` re-renders once per pointermove for the node being
 * dragged, and calls its node component unconditionally. None of the props below change
 * during a plain move, so memoizing keeps the xterm subtree out of the drag hot path.
 */
export const TerminalNode = memo(TerminalNodeImpl);
