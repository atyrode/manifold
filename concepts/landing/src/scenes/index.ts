// The scene registry, in lab order (cards, `[` / `]` cycling). A scene is one folder under
// src/scenes/ (see README.md); adding one is an import and an entry here, keyed by its id.
import { bambooScene } from "./bamboo/index.ts";
import { bonsaiScene } from "./bonsai/index.ts";
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
import { hyperbolicScene } from "./hyperbolic/index.ts";
import { incenseScene } from "./incense/index.ts";
import { kelpScene } from "./kelp/index.ts";
import { lakeScene } from "./lake/index.ts";
import { lanternsScene } from "./lanterns/index.ts";
import { lavaScene } from "./lava/index.ts";
import { marbleScene } from "./marble/index.ts";
import { meadowScene } from "./meadow/index.ts";
import { orbitScene } from "./orbit/index.ts";
import { pearlScene } from "./pearl/index.ts";
import { petriScene } from "./petri/index.ts";
import { physarumScene } from "./physarum/index.ts";
import { pondScene } from "./pond/index.ts";
import { prismScene } from "./prism/index.ts";
import { rippleScene } from "./ripple/index.ts";
import { sandtableScene } from "./sandtable/index.ts";
import { shanshuiScene } from "./shanshui/index.ts";
import { shoreScene } from "./shore/index.ts";
import { sillScene } from "./sill/index.ts";
import { starryScene } from "./starry/index.ts";
import { swellScene } from "./swell/index.ts";
import type { SceneDef } from "./types.ts";
import { waveScene } from "./wave/index.ts";

export const sceneDefs = {
  wave: waveScene,
  starry: starryScene,
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
} satisfies Record<string, SceneDef>;

export type SceneId = keyof typeof sceneDefs;
export const sceneIds = Object.keys(sceneDefs) as SceneId[];
