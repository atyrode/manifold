/**
 * `core.compositions`'s browser half.
 *
 * TWO registrations, and neither is a panel. The composition renderer is a CONTAINER REF, keyed
 * by the container discipline it draws: the routed shell projects the container the viewer
 * asked for through the same registry a tile leaf uses to project an embedded one, so "draw a
 * container of layout L" has exactly one door (invariant 14) — and the recursion falls out of
 * it: a canvas inside a composition and a composition inside a canvas are the same call with a
 * different key, and neither plugin learns the other's name. Beside it, one SECTION: the rail's
 * "New composition" creator, this discipline's own offer, ordered against every other row of
 * the sidebar rather than hand-written into it.
 */
import "./styles.css";

export { CompositionView } from "./composition-view.tsx";

import { CompositionView } from "./composition-view.tsx";
import { NewCompositionRow } from "./new-composition-row.tsx";

export const compositionsWebPlugin = {
  id: "core.compositions",
  renderers: { composition: CompositionView },
  sections: { "new-composition": NewCompositionRow },
};
