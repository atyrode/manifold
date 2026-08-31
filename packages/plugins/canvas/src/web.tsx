import { FlowPadView } from "./flow-pad-view.tsx";

/**
 * `core.canvas`, browser half — the registration, and deliberately nothing else.
 *
 * One entry: the canvas is the renderer for containers whose discipline is `canvas`, so it
 * registers a PAD SURFACE keyed by that discipline. The routed shell asks for the surface of
 * the container it is showing, and a composition's tile leaf asks for exactly the same thing
 * when it embeds a board; both arrive at this component with the same neutral props. That is
 * why a canvas can hold a composition and a composition can hold a canvas without either
 * plugin importing the other (A4: composition is projection).
 *
 * The tools this plugin declares (`select`, `text`) need no attachment: a tool is a NAME the
 * surface owning the toolbar switches on, and this surface owns it. The element species on the
 * board are other plugins' (`text`, `draw`) and reach it through the element registry.
 *
 * It is inert data: `packages/web/src/composition.ts` is the one file that reads it, and the
 * host joins it against the server's roster before anything renders.
 */
export const canvasWebPlugin = {
  id: "core.canvas",
  padSurfaces: { canvas: FlowPadView },
};
