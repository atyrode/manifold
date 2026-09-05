import "./styles.css";
import { polylinePath, polylineViewBox } from "@manifold/plugin/hooks";
import type { ElementProps } from "@manifold/plugin";
import { memo } from "react";

/**
 * The stroke renderer — `core.draw`'s browser half.
 *
 * It paints and nothing else. Geometry (resize handles, selection, the commit into the scene
 * document) belongs to the mount site's element frame, so this component never learns how a
 * scene is written: it is handed the element's `data` and fills its box with ink. A composition
 * supplies tile geometry through the same neutral element contract.
 *
 * The path math is NOT here. It is `@manifold/plugin/hooks`' polyline geometry, the element
 * plane's one derivation of a coordinate payload into the strings that paint it — shared with
 * `core.canvas`'s in-flight preview, which draws the same wire form before it is committed
 * (issue #117). What this plugin owns is the STROKE: which payload fields carry it, what a
 * stroke authored by an older client falls back to, and that the ink is its own hit target.
 */

/** Fallbacks match the wire schema's own defaults for a stroke authored by an older client. */
const FALLBACK_STROKE_WIDTH = 3;
const FALLBACK_COLOR = "#f8f9fa";

function numbers(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number");
}

function DrawStrokeNodeImpl({ data }: ElementProps): React.ReactElement {
  const points = numbers(data["points"]);
  const strokeWidth =
    typeof data["strokeWidth"] === "number" ? data["strokeWidth"] : FALLBACK_STROKE_WIDTH;
  const color = typeof data["color"] === "string" ? data["color"] : FALLBACK_COLOR;
  const path = polylinePath(points);
  return (
    <svg
      className="draw"
      width="100%"
      height="100%"
      viewBox={polylineViewBox(points, strokeWidth)}
      preserveAspectRatio="none"
      overflow="visible"
    >
      {/* Wide invisible twin: the INK is the hit ref (Excalidraw-style), never the
          bounding box — the node wrapper is pointer-transparent until selected (CSS). */}
      <path
        className="draw__hit"
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
 * on every drag frame of the canvas, and none of these props move with the pointer.
 */
export const DrawStrokeNode = memo(DrawStrokeNodeImpl);

/**
 * What this plugin registers in the browser, keyed by the names its manifest declared. It is
 * inert data: `packages/web/src/assembly.ts` is the one file that reads it, and the host
 * joins it against the server's roster before anything renders.
 *
 * The tool needs no registration: a tool is a NAME the ref owning the toolbar switches
 * on, and the strip reads that name — with its title and its enabled state — off the
 * composition's tool registry, which the manifest already fills.
 */
export const drawWebPlugin = {
  id: "core.draw",
  elements: { draw: DrawStrokeNode },
};
