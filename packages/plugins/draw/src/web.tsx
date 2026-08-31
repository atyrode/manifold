import type { NodeProps } from "@xyflow/react";
import { memo } from "react";

/**
 * The stroke renderer — `core.draw`'s browser half.
 *
 * It paints and nothing else. Geometry (resize handles, selection, the commit into the scene
 * document) belongs to the engine's element frame, which wraps every contributed renderer, so
 * this component never learns how a scene is written: it is handed the node's `data` and a
 * box, and it fills the box with ink. That is the whole element contract.
 *
 * The path math is here rather than shared with the canvas because a plugin package may not
 * import web floor modules (AXIOMS.md §Foundation import boundary) — and because the shape of
 * a stroke IS this plugin's business. The engine's copy survives only for the in-flight
 * gesture preview it still owns (`until core.canvas`).
 */

/** Fallbacks match the wire schema's own defaults for a stroke authored by an older client. */
const FALLBACK_STROKE_WIDTH = 3;
const FALLBACK_COLOR = "#f8f9fa";
/** A degenerate stroke still needs a viewBox; 1×1 keeps the SVG valid and invisible. */
const MIN_EXTENT = 1;

function numbers(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number");
}

function strokePath(points: readonly number[]): string {
  const commands: string[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    commands.push(
      `${index === 0 ? "M" : "L"} ${String(points[index])} ${String(points[index + 1])}`,
    );
  }
  return commands.join(" ");
}

/**
 * The stroke's natural bounds, published as the viewBox: mapping them onto whatever box the
 * node currently has is what makes a resized element SCALE its ink instead of growing an
 * empty frame around a fixed drawing. The origin is read from the points rather than assumed,
 * because nothing in the schema guarantees a canonical one.
 */
function strokeViewBox(points: readonly number[], strokeWidth: number): string {
  if (points.length < 2) return `0 0 ${String(MIN_EXTENT)} ${String(MIN_EXTENT)}`;
  let minX = points[0] ?? 0;
  let maxX = minX;
  let minY = points[1] ?? 0;
  let maxY = minY;
  for (let index = 2; index + 1 < points.length; index += 2) {
    const x = points[index] ?? 0;
    const y = points[index + 1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const x = minX - strokeWidth;
  const y = minY - strokeWidth;
  const width = Math.max(MIN_EXTENT, maxX - minX + strokeWidth * 2);
  const height = Math.max(MIN_EXTENT, maxY - minY + strokeWidth * 2);
  return `${String(x)} ${String(y)} ${String(width)} ${String(height)}`;
}

function DrawStrokeNodeImpl({ data }: NodeProps): React.ReactElement {
  const points = numbers(data["points"]);
  const strokeWidth =
    typeof data["strokeWidth"] === "number" ? data["strokeWidth"] : FALLBACK_STROKE_WIDTH;
  const color = typeof data["color"] === "string" ? data["color"] : FALLBACK_COLOR;
  const path = strokePath(points);
  return (
    <svg
      className="flow-draw"
      width="100%"
      height="100%"
      viewBox={strokeViewBox(points, strokeWidth)}
      preserveAspectRatio="none"
      overflow="visible"
    >
      {/* Wide invisible twin: the INK is the hit surface (Excalidraw-style), never the
          bounding box — the node wrapper is pointer-transparent until selected (CSS). */}
      <path
        className="flow-draw__hit"
        d={path}
        stroke="transparent"
        strokeWidth={Math.max(strokeWidth * 3, 12)}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={path}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Memoized for the same reason every node renderer is: React Flow re-invokes a node component
 * on every drag frame of the board, and none of these props move with the pointer.
 */
export const DrawStrokeNode = memo(DrawStrokeNodeImpl);

/**
 * What this plugin registers in the browser, keyed by the names its manifest declared. It is
 * inert data: `packages/web/src/composition.ts` is the one file that reads it, and the host
 * joins it against the server's roster before anything renders.
 *
 * The tool needs no registration: a tool is a NAME the surface owning the toolbar switches
 * on, and the strip reads that name — with its title and its enabled state — off the
 * composition's tool registry, which the manifest already fills.
 */
export const drawWebPlugin = {
  id: "core.draw",
  elements: { draw: DrawStrokeNode },
};
