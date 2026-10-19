// The scene registry, in lab order (cards, `[` / `]` cycling). A scene is one folder under
// src/scenes/ (see README.md); adding one is an import and an entry here, keyed by its id. The
// promoted variants (ADR 0062 D15: data in composer/interior-variants.ts, no folder) follow, from
// promoted/scenes.ts. The registry holds every scene's SceneDef, which loads with the page; a
// scene's code (its GLSL and sim, `SceneDef.code`) loads apart, the first time the scene is needed
// (`loadScene`), so the page's first load carries the code of the scene it opens on alone.
import { autumnScene } from "./autumn/index.ts";
import { bambooScene } from "./bamboo/index.ts";
import { barScene } from "./bar/index.ts";
import { beesScene } from "./bees/index.ts";
import { bonsaiScene } from "./bonsai/index.ts";
import { campfireScene } from "./campfire/index.ts";
import { cloudsScene } from "./clouds/index.ts";
import { chladniScene } from "./chladni/index.ts";
import { countryScene } from "./country/index.ts";
import { deltaScene } from "./delta/index.ts";
import { dewScene } from "./dew/index.ts";
import { dunesScene } from "./dunes/index.ts";
import { fallsScene } from "./falls/index.ts";
import { ferroScene } from "./ferro/index.ts";
import { filmScene } from "./film/index.ts";
import { firefliesScene } from "./fireflies/index.ts";
import { flockScene } from "./flock/index.ts";
import { forestScene } from "./forest/index.ts";
import { fractalScene } from "./fractal/index.ts";
import { frostScene } from "./frost/index.ts";
import { gardenScene } from "./garden/index.ts";
import { harmonographScene } from "./harmonograph/index.ts";
import { hyperbolicScene } from "./hyperbolic/index.ts";
import { incenseScene } from "./incense/index.ts";
import { islandScene } from "./island/index.ts";
import { kelpScene } from "./kelp/index.ts";
import { lakeScene } from "./lake/index.ts";
import { landScene } from "./land/index.ts";
import { lanternsScene } from "./lanterns/index.ts";
import { lavaScene } from "./lava/index.ts";
import { marbleScene } from "./marble/index.ts";
import { meadowScene } from "./meadow/index.ts";
import { mobileScene } from "./mobile/index.ts";
import { orbitScene } from "./orbit/index.ts";
import { patchScene } from "./patch/index.ts";
import { pearlScene } from "./pearl/index.ts";
import { pendulaScene } from "./pendula/index.ts";
import { petriScene } from "./petri/index.ts";
import { physarumScene } from "./physarum/index.ts";
import { pondScene } from "./pond/index.ts";
import { prismScene } from "./prism/index.ts";
import { rippleScene } from "./ripple/index.ts";
import { promotedScenes } from "./promoted/scenes.ts";
import { roomScene } from "./room/index.ts";
import { sandtableScene } from "./sandtable/index.ts";
import { shanshuiScene } from "./shanshui/index.ts";
import { shoreScene } from "./shore/index.ts";
import { sillScene } from "./sill/index.ts";
import { skywardScene } from "./skyward/index.ts";
import { streetScene } from "./street/index.ts";
import { swellScene } from "./swell/index.ts";
import { tidepoolScene } from "./tidepool/index.ts";
import { trainScene } from "./train/index.ts";
import type { LoadedScene, SceneDef } from "./types.ts";

export const sceneDefs = {
  orbit: orbitScene,
  swell: swellScene,
  pond: pondScene,
  clouds: cloudsScene,
  falls: fallsScene,
  country: countryScene,
  marble: marbleScene,
  dunes: dunesScene,
  flock: flockScene,
  frost: frostScene,
  shore: shoreScene,
  sill: sillScene,
  meadow: meadowScene,
  prism: prismScene,
  lanterns: lanternsScene,
  ferro: ferroScene,
  chladni: chladniScene,
  shanshui: shanshuiScene,
  hyperbolic: hyperbolicScene,
  fireflies: firefliesScene,
  bamboo: bambooScene,
  dew: dewScene,
  pearl: pearlScene,
  fractal: fractalScene,
  kelp: kelpScene,
  garden: gardenScene,
  petri: petriScene,
  physarum: physarumScene,
  film: filmScene,
  incense: incenseScene,
  sandtable: sandtableScene,
  delta: deltaScene,
  lava: lavaScene,
  forest: forestScene,
  lake: lakeScene,
  ripple: rippleScene,
  bonsai: bonsaiScene,
  street: streetScene,
  train: trainScene,
  bar: barScene,
  harmonograph: harmonographScene,
  campfire: campfireScene,
  pendula: pendulaScene,
  island: islandScene,
  bees: beesScene,
  skyward: skywardScene,
  autumn: autumnScene,
  tidepool: tidepoolScene,
  mobile: mobileScene,
  room: roomScene,
  land: landScene,
  patch: patchScene,
  ...promotedScenes,
} satisfies Record<string, SceneDef>;

export type SceneId = keyof typeof sceneDefs;
export const sceneIds = Object.keys(sceneDefs) as SceneId[];

/** A scene whose code could not be loaded (the page offline, a build without the chunk). */
export class SceneLoadError extends Error {}

const loading = new Map<SceneId, Promise<LoadedScene>>();
const loaded = new Map<SceneId, LoadedScene>();

/**
 * Scene `id` with its code, loaded the first time it is asked for. Every later call shares that load
 * and its one LoadedScene, so a check that patches a scene's `glsl` or `sim` patches what the
 * renderer builds. A load that fails is forgotten: the next call tries again.
 */
export function loadScene(id: SceneId): Promise<LoadedScene> {
  let load = loading.get(id);
  if (load === undefined) {
    const def: SceneDef = sceneDefs[id];
    load = def.code().then(
      (code) => {
        const scene: LoadedScene = { ...def, ...code };
        loaded.set(id, scene);
        return scene;
      },
      (error: unknown) => {
        loading.delete(id);
        throw new SceneLoadError(`scene ${id}: its code could not be loaded`, { cause: error });
      },
    );
    loading.set(id, load);
  }
  return load;
}

/** Scene `id` with its code once that has loaded (`loadScene`), else undefined. */
export function loadedScene(id: SceneId): LoadedScene | undefined {
  return loaded.get(id);
}

/** Every scene in `ids` (by default all, in lab order) with its code: `loadScene` for each. */
export function loadScenes(ids: readonly SceneId[] = sceneIds): Promise<LoadedScene[]> {
  return Promise.all(ids.map((id) => loadScene(id)));
}

/**
 * Start loading scene `id`'s code ahead of need (the scene the page opens on, the tour's next step,
 * the scenes `[` and `]` step to): a load that fails is left to the one that needs the scene (the
 * renderer's, through `loadScene`), which tries again and reports it.
 */
export function prefetchScene(id: SceneId): void {
  loadScene(id).catch(() => undefined);
}
