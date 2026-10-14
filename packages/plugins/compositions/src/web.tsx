/**
 * `core.compositions`'s browser half.
 *
 * ONE registration, and it is not a panel. The composition renderer is a CONTAINER REF, keyed
 * by the container discipline it draws: the routed shell projects the container the viewer
 * asked for through the same registry a tile leaf uses to project an embedded one, so "draw a
 * container of layout L" has exactly one door (docs/CONTRACTS.md §One authoritative implementation) — and the recursion falls out of
 * it: a canvas inside a composition and a composition inside a canvas are the same call with a
 * different key, and neither plugin learns the other's name. The rail's "New composition" is a
 * creator the manifest declares, drawn by the shell, so it registers nothing here.
 */
import "./styles.css";

export { CompositionView } from "./composition-view.tsx";

import { CompositionView } from "./composition-view.tsx";

export const compositionsWebPlugin = {
  id: "core.compositions",
  renderers: { composition: CompositionView },
};
