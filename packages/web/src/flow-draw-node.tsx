import { NodeResizer, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useFlowPad } from "./flow-terminal-node.tsx";
import { pointsToPath, strokeViewBox } from "./stroke.ts";

/** Freehand ink stays legible when scaled, so a stroke may shrink to a thumbnail. */
export const MIN_DRAW_SIZE = 16;

function DrawNodeImpl({ id, data, selected }: NodeProps): React.ReactElement {
  const pad = useFlowPad();
  const points = Array.isArray(data["points"])
    ? data["points"].filter((value): value is number => typeof value === "number")
    : [];
  const strokeWidth = typeof data["strokeWidth"] === "number" ? data["strokeWidth"] : 3;
  const color = typeof data["color"] === "string" ? data["color"] : "#f8f9fa";
  // Points are element-relative, so their own bounds are the stroke's natural size:
  // publishing them as the viewBox makes the ink scale with the node instead of the box
  // growing around a fixed drawing.
  const viewBox = strokeViewBox(points, strokeWidth);
  return (
    <>
      {/* Ink and text keep the classic bounding-box handles; only terminals grab by border. */}
      <NodeResizer
        nodeId={id}
        isVisible={pad.tool === "select" && selected === true}
        minWidth={MIN_DRAW_SIZE}
        minHeight={MIN_DRAW_SIZE}
        onResize={(_event, params) =>
          pad.onResize(id, params.x, params.y, params.width, params.height)
        }
        onResizeEnd={(_event, params) =>
          pad.onResizeEnd(id, params.x, params.y, params.width, params.height)
        }
      />
      <svg
        className="flow-draw"
        width="100%"
        height="100%"
        viewBox={viewBox}
        preserveAspectRatio="none"
        overflow="visible"
      >
        {/* Wide invisible twin: the INK is the hit surface (Excalidraw-style), never the
            bounding box — the node wrapper is pointer-transparent until selected (CSS). */}
        <path
          className="flow-draw__hit"
          d={pointsToPath(points)}
          stroke="transparent"
          strokeWidth={Math.max(strokeWidth * 3, 12)}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={pointsToPath(points)}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}

/**
 * Memoized for the same reason as `TerminalNode`: React Flow's node wrapper re-invokes its
 * node component on every drag frame, and none of these props move with the pointer.
 */
export const DrawNode = memo(DrawNodeImpl);
