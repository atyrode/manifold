// A canvas document drawn as a plan from above, for its card or its row in the Scenes view.
import type { EngineDoc } from "../engine/types.ts";
import { svg } from "./dom.ts";

/**
 * A document from above, for its card: x across, z up the card, every object a dot and the
 * camera a wedge pointing the way it looks, all fitted in.
 */
export function docPlan(doc: EngineDoc): SVGSVGElement {
  const [w, hgt, pad] = [160, 100, 14];
  const points = [doc.camera.at, ...doc.objects.map((object) => object.at)];
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[2]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const fit = Math.min(
    (w - 2 * pad) / Math.max(x1 - x0, 1),
    (hgt - 2 * pad) / Math.max(z1 - z0, 1),
  );
  const at = (x: number, z: number) =>
    [w / 2 + (x - (x0 + x1) / 2) * fit, hgt / 2 - (z - (z0 + z1) / 2) * fit] as const;
  const dots = doc.objects.map((object) => {
    const [cx, cy] = at(object.at[0], object.at[2]);
    return svg("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2.5, class: "plan-object" });
  });
  const [ex, ey] = at(doc.camera.at[0], doc.camera.at[2]);
  // The camera's heading on the card: +z up, a yaw turning counter-clockwise.
  const [dx, dy] = [-Math.sin(doc.camera.yaw), -Math.cos(doc.camera.yaw)];
  const wedge = [
    [ex + dx * 9, ey + dy * 9],
    [ex - dy * 4, ey + dx * 4],
    [ex + dy * 4, ey - dx * 4],
  ]
    .map(([px, py]) => `${(px ?? 0).toFixed(1)},${(py ?? 0).toFixed(1)}`)
    .join(" ");
  return svg(
    "svg",
    { viewBox: `0 0 ${w} ${hgt}`, class: "plan", "aria-hidden": "true" },
    ...dots,
    svg("polygon", { points: wedge, class: "plan-camera" }),
  );
}
