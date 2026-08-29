import type { MachineSummary, PadPresence } from "@manifold/protocol";
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
  /** Parks the element's terminal into the workspace pool (server removes the element). */
  readonly onPark: (elementId: string) => void;
  /** Kills the PTY and tombstones the element. */
  readonly onClose: (elementId: string, sessionId: string) => void;
  /**
   * Transmutes a canvas terminal into a tiled view born around it: the element
   * becomes a portal onto the new container and the expander navigates into it.
   * The server finds the placement from the session, so the id is enough.
   */
  readonly onExpand: (sessionId: string) => void;
  readonly onRestart: (elementId: string, sessionId: string) => Promise<void>;
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
  /**
   * Container nesting depth of the canvas these nodes live on: 1 for the routed
   * pad, 2 for a canvas embedded one container deep. Portals render their
   * container live while `depth < MAX_LIVE_DEPTH` and as cards below that.
   */
  readonly depth: number;
  /** Bearer token for the REST calls canvas nodes make on their own (portal reads). */
  readonly token: string;
  /**
   * Opens a SPECTATOR room socket for another container — the portal widget's live
   * preview. The canvas owns the session URL and identity, so nodes never rebuild
   * either. Spectator sockets watch without occupying: no avatar, no vote in the
   * bubble rule, and the server refuses every write they attempt.
   */
  readonly openClient: (padId: string) => SessionClient;
  /** Polled principal-level presence; portal widgets show their container's occupants. */
  readonly presence: readonly PadPresence[];
  /** Pushes a route; portals navigate into the container they point at. */
  readonly navigate: (path: string) => void;
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

/**
 * Painted on the node a dragged surface is hovering over, long enough to mean it
 * (see COMPOSE_ARM_MS): the frame morphs into view chrome so the release reads as
 * "these two become one view", not as a move that happens to end on top.
 */
export const COMPOSE_TARGET_CLASS = "flow-node--compose-target";

function TerminalNodeImpl({ id, data, selected }: NodeProps): React.ReactElement {
  const sessionId = typeof data["sessionId"] === "string" ? data["sessionId"] : "";
  const pad = useFlowPad();
  // The canvas stamps the armed compose zone onto this node's data, so only the
  // hovered node re-renders (see `reconcileNodes`) instead of the whole tree.
  const composeTarget = typeof data["composeZone"] === "string";

  if (sessionId === "") return <div className="terminal-placeholder">Opening terminal…</div>;

  return (
    <div className={composeTarget ? `flow-terminal ${COMPOSE_TARGET_CLASS}` : "flow-terminal"}>
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
        onPark={() => pad.onPark(id)}
        panelHighlighted={false}
        onClose={() => pad.onClose(id, sessionId)}
        onRestart={() => pad.onRestart(id, sessionId)}
        onExpand={() => pad.onExpand(sessionId)}
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
