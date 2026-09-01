/**
 * POLYLINE GEOMETRY: the one derivation of a flat `[x0, y0, x1, y1, …]` coordinate list into
 * the two SVG strings a browser needs to paint it, plus the extents both of those rest on.
 *
 * It was written twice — `core.canvas`'s stroke module and `core.draw`'s renderer each carried
 * a byte-for-byte equivalent copy, because sibling plugins may not import each other
 * (REGISTRY.md §Foundation, `verify:axioms` S2) and no shared shelf held the math. The copy in
 * the renderer justified itself with a comment citing a floor-import restriction that never
 * applied to it; the comment was wrong and the duplication was real (issue #117). Two copies of
 * a viewBox formula is the divergence class where nothing throws and the ink is simply in the
 * wrong place for one of the two surfaces.
 *
 * WHY THIS IS FLOOR, AND WHY IT IS SPELLED `polyline` (AXIOMS.md §Foundation law, criterion by
 * criterion, for the `plugin-engine` pillar this file joins):
 *
 *   BOOTSTRAP. It is element-plane mechanism. The protocol carries a scene element as a neutral
 *   envelope and bounds its payload without reading it (ADR 0013 §16); what a renderer and an
 *   author both need from a coordinate payload — where it extends to, and the path data that
 *   paints it — is the plane's own geometry, exactly as `tile-geometry.ts` is the tile plane's.
 *   Both halves of every such payload are already reachable only through the engine's element
 *   host, so the geometry cannot sit below it.
 *
 *   NEUTRALITY, which is the criterion that decided the NAME. "Stroke" is `core.draw`'s domain
 *   noun (REGISTRY.md §Lexicon: "one freehand ink record") and the pillar whose verdict is "it
 *   names no plugin" may not learn it — the element schema deliberately unlearned `draw` for
 *   the same reason. A POLYLINE is not a stroke: it is a coordinate sequence, and this module
 *   would be unchanged if every plugin in the tree were replaced by different ones. So the
 *   INK stayed behind. Minimum sampling distance, the default stroke width, the append
 *   heuristic and the commit into a scene record are authoring facts about ink and they live in
 *   `core.canvas`; `margin` here is a number, not a stroke width.
 *
 *   ARBITRATION. It is the single definition the two renderers of one coordinate list are
 *   measured against. An arbiter cannot be a party, and neither plugin could be trusted to hold
 *   the other's copy — which is the shape the duplication took.
 *
 * It is DOM-free and React-free on purpose: the two callers are a `<path d>` and a scene
 * author, and a module the author could not import would have to be two modules. Published
 * through `@manifold/plugin/hooks`, beside the tile plane's geometry, rather than through
 * `/ui`, whose entry pulls the chrome stylesheet a scene module has no business loading.
 */

/** Extents in the polyline's own coordinate space. */
export interface PolylineBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The smallest box a polyline fits in, grown by `margin` on every side. A degenerate polyline
 * still needs a box, and 1×1 is the smallest one an SVG viewBox stays valid at.
 */
export function polylineBounds(points: readonly number[], margin: number): PolylineBounds {
  if (points.length < 2) return { x: 0, y: 0, width: 1, height: 1 };

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

  return {
    x: minX - margin,
    y: minY - margin,
    width: Math.max(1, maxX - minX + margin * 2),
    height: Math.max(1, maxY - minY + margin * 2),
  };
}

/**
 * Maps a polyline's natural bounds onto whatever box the node currently has, so a resized
 * element SCALES its drawing instead of growing an empty frame around it. The origin is read
 * from the points rather than assumed: a canonical payload starts at `margin`, but nothing in
 * the envelope guarantees one, and a record authored by an older client must still land where
 * it was drawn.
 */
export function polylineViewBox(points: readonly number[], margin: number): string {
  const bounds = polylineBounds(points, margin);
  return `${String(bounds.x)} ${String(bounds.y)} ${String(bounds.width)} ${String(bounds.height)}`;
}

/** The same polyline rebased onto an origin, which is how a payload becomes box-relative. */
export function polylineRelativeTo(
  points: readonly number[],
  origin: { readonly x: number; readonly y: number },
): number[] {
  return points.map((value, index) => value - (index % 2 === 0 ? origin.x : origin.y));
}

/** SVG path data for the polyline: one `M`, then an `L` per remaining point. */
export function polylinePath(points: readonly number[]): string {
  const commands: string[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    commands.push(
      `${index === 0 ? "M" : "L"} ${String(points[index])} ${String(points[index + 1])}`,
    );
  }
  return commands.join(" ");
}
