/**
 * `core.compositions`'s browser half.
 *
 * One registration, and it is not a panel: the tiled renderer is a PAD SURFACE, keyed by the
 * container discipline it draws. The routed shell projects the container the viewer asked for
 * through the same registry a tile leaf uses to project an embedded one, so "draw a container
 * of layout L" has exactly one door (invariant 14) — and the recursion falls out of it: a
 * canvas inside a composition and a composition inside a canvas are the same call with a
 * different key, and neither plugin learns the other's name.
 */
export { TiledPadSurface } from "./tiled-pad-view.tsx";

import { TiledPadSurface } from "./tiled-pad-view.tsx";

export const compositionsWebPlugin = {
  id: "core.compositions",
  padSurfaces: { tiled: TiledPadSurface },
};
