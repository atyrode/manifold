import { CanvasView } from "./canvas-view.tsx";

/**
 * `core.canvas`, browser half — the registration, and deliberately nothing else.
 *
 * One entry: the canvas is the renderer for containers whose discipline is `canvas`, so it
 * registers a CONTAINER REF keyed by that discipline. The routed shell asks for the ref of
 * the container it is showing, and a composition's tile leaf asks for exactly the same thing
 * when it embeds a canvas; both arrive at this component with the same neutral props. That is
 * why a canvas can hold a composition and a composition can hold a canvas without either
 * plugin importing the other (A4: composition is projection).
 *
 * The tools this plugin declares (`select`, `text`) need no attachment: a tool is a NAME the
 * ref owning the toolbar switches on, and this ref owns it. The element species on the
 * canvas are other plugins' (`text`, `draw`) and reach it through the element registry.
 *
 * It is inert data: `packages/web/src/assembly.ts` is the one file that reads it, and the
 * host joins it against the server's roster before anything renders.
 */
export const canvasWebPlugin = {
  id: "core.canvas",
  renderers: { canvas: CanvasView },
};
