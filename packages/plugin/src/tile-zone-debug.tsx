import type { TileLayout } from "@manifold/protocol";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

import { resolveTileAim } from "./tile-geometry.ts";
import { areaUnits } from "./use-tile-drop.ts";

/**
 * The drop-zone field, made visible: a debug-only overlay that SAMPLES the real
 * `resolveTileAim` across the tile area and paints what it answers at every point —
 * ring, seams, seam ends, edge bands, centers, precedence and all. Nothing here
 * re-declares zone geometry, so the picture cannot drift from the resolver: it IS
 * the resolver, evaluated. It re-renders with the layout and re-samples on resize,
 * so it moves in real time with the composition — and because the resolver never
 * reads the FLIP transforms, the painted field also demonstrates that aiming is
 * independent of the preview's motion. Visual aid only: `pointer-events: none`.
 */

let enabled = false;
const listeners = new Set<() => void>();

/**
 * THE zone probe's toggle, and the whole of what this module publishes about being on.
 *
 * The KEY that reaches it is not this module's business: F9 is a binding row `core.shell`
 * declares, composed with every other plugin's keys and printed in the sidebar's help table,
 * and the host dispatches it here. This file owned a `window` keydown listener of its own until
 * that registry existed — an undeclared key nothing could collide with, nothing could list for
 * a reader, and nothing could turn off.
 */
export function toggleZoneProbe(): void {
  enabled = !enabled;
  for (const listener of [...listeners]) listener();
}

function useZoneProbeEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => enabled,
    () => false,
  );
}

/** One hue per edge; a structural target (the root or a group) paints the warm hue. */
const EDGE_COLORS: Record<string, string> = {
  left: "77, 171, 247",
  right: "59, 91, 219",
  top: "105, 219, 124",
  bottom: "43, 138, 62",
  center: "255, 212, 59",
};
const STRUCTURAL_COLOR = "240, 101, 149";
/** The seam band: a same-axis aim that wedges BETWEEN two siblings (thirds). */
const BETWEEN_COLOR = "34, 211, 238";

const CELL_PX = 10;

export function TileZoneDebug({
  layout,
  areaRef,
  dividerPx,
}: {
  readonly layout: TileLayout | null;
  readonly areaRef: RefObject<HTMLElement | null>;
  readonly dividerPx: number;
}): ReactNode {
  const on = useZoneProbeEnabled();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sizeTick, setSizeTick] = useState(0);

  useEffect(() => {
    const area = areaRef.current;
    if (!on || area === null) return;
    const observer = new ResizeObserver(() => setSizeTick((tick) => tick + 1));
    observer.observe(area);
    return () => observer.disconnect();
  }, [areaRef, on]);

  useEffect(() => {
    void sizeTick;
    const area = areaRef.current;
    const canvas = canvasRef.current;
    if (!on || area === null || canvas === null || layout === null) return;
    const width = area.offsetWidth;
    const height = area.offsetHeight;
    // The ONE unit-space conversion — divider fractions from the LAYOUT box, the ring
    // from the on-screen rect — so this picture is the resolver's own geometry rather
    // than a third transcription of a subtle rule.
    const units = areaUnits(area, dividerPx);
    if (units === null) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.clearRect(0, 0, width, height);
    const carry = { carriedTileId: null, holdsTileSeat: false };
    for (let y = CELL_PX / 2; y < height; y += CELL_PX) {
      for (let x = CELL_PX / 2; x < width; x += CELL_PX) {
        const aim = resolveTileAim(
          layout,
          { x: x / width, y: y / height },
          carry,
          units.dividers,
          units.ring,
        );
        if (aim === null) continue;
        const structural = layout[aim.tileId]?.dir !== null;
        const rgb = structural
          ? STRUCTURAL_COLOR
          : aim.between === true
            ? BETWEEN_COLOR
            : (EDGE_COLORS[aim.edge] ?? "255, 255, 255");
        context.fillStyle = `rgba(${rgb}, ${structural || aim.between === true ? "0.55" : "0.35"})`;
        context.fillRect(x - CELL_PX / 2 + 1, y - CELL_PX / 2 + 1, CELL_PX - 2, CELL_PX - 2);
      }
    }
    context.font = "11px sans-serif";
    const legend: readonly (readonly [string, string])[] = [
      ["left", EDGE_COLORS["left"] ?? ""],
      ["right", EDGE_COLORS["right"] ?? ""],
      ["top", EDGE_COLORS["top"] ?? ""],
      ["bottom", EDGE_COLORS["bottom"] ?? ""],
      ["center", EDGE_COLORS["center"] ?? ""],
      ["between (seam band: both cede thirds)", BETWEEN_COLOR],
      ["root / group (ring · seam · seam end)", STRUCTURAL_COLOR],
    ];
    legend.forEach(([label, rgb], index) => {
      const ly = 14 + index * 14;
      context.fillStyle = `rgba(${rgb}, 0.9)`;
      context.fillRect(8, ly - 8, 10, 10);
      context.fillStyle = "rgba(255, 255, 255, 0.9)";
      context.fillText(label, 22, ly);
    });
  }, [areaRef, dividerPx, layout, on, sizeTick]);

  if (!on || layout === null) return null;
  return <canvas className="tile-zone-debug" ref={canvasRef} aria-hidden="true" />;
}
