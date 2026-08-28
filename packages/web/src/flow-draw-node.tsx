import type { NodeProps } from "@xyflow/react";
import { pointsToPath } from "./stroke.ts";

export function DrawNode({ data }: NodeProps): React.ReactElement {
  const points = Array.isArray(data["points"])
    ? data["points"].filter((value): value is number => typeof value === "number")
    : [];
  const strokeWidth = typeof data["strokeWidth"] === "number" ? data["strokeWidth"] : 3;
  const color = typeof data["color"] === "string" ? data["color"] : "#f8f9fa";
  return (
    <svg className="flow-draw" width="100%" height="100%" overflow="visible">
      <path
        d={pointsToPath(points)}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
