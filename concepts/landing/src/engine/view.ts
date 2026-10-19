// The engine view of the running page (EngineView, src/engine/types.ts): the document the canvas
// scene shows, set whole (`setDoc`), and what lies under a cell, found on the CPU from the
// document's camera (src/engine/camera.ts) and its objects (src/engine/cast.ts). A document whose
// program key (src/engine/program.ts) is the one on screen only uploads its data: the renderer works
// its features out again (`refresh`), finds the program it draws, and the scene's sim uploads the
// new document; a new key builds its program in the background, the old one drawing meanwhile.
import type { SceneId } from "../scenes/index.ts";
import { cameraRay } from "./camera.ts";
import { castDoc } from "./cast.ts";
import { engineStage, type EngineStage } from "./stage.ts";
import type { EngineDoc, EngineView } from "./types.ts";

/** The lab-only scene that shows the engine's document (src/scenes/canvas). */
export const CANVAS_SCENE = "canvas" satisfies SceneId;

/** What the view needs of the renderer (src/renderer.ts DitherRenderer). */
export interface EngineRenderer {
  /** The cell grid the picture is drawn at. */
  readonly grid: { readonly width: number; readonly height: number };
  /** The scene's document changed under its settings: work its features out again and draw. */
  refresh(): void;
}

/**
 * The page's engine view over `renderer`. `world` takes the World's knobs of each document set whose
 * World differs from the one before (keyed as Params are), for the page's setup to follow them.
 */
export function createEngineView(
  renderer: EngineRenderer,
  world: (values: Readonly<Record<string, number>>) => void,
  stage: EngineStage = engineStage,
): EngineView {
  let doc: EngineDoc = stage.doc;
  const under = (cellX: number, cellY: number, ignore?: string) => {
    const { width, height } = renderer.grid;
    return castDoc(doc, cameraRay(doc.camera, cellX, cellY, width, height), ignore);
  };
  return {
    get doc() {
      return doc;
    },
    setDoc(next) {
      const before = doc.world;
      const keys = new Set([...Object.keys(before), ...Object.keys(next.world)]);
      stage.show(next, () => renderer.refresh());
      doc = next;
      if ([...keys].some((key) => before[key] !== next.world[key])) world(next.world);
    },
    pick(cellX, cellY) {
      return under(cellX, cellY)?.id;
    },
    surface(cellX, cellY, ignore) {
      const hit = under(cellX, cellY, ignore);
      return hit === undefined ? undefined : { at: hit.at, normal: hit.normal };
    },
    cast(origin, dir, ignore) {
      const hit = castDoc(doc, { o: origin, d: dir }, ignore);
      return hit === undefined ? undefined : { at: hit.at, normal: hit.normal };
    },
  };
}
