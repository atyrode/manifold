// The scene registry, in lab order (cards, `[` / `]` cycling). A scene is one folder under
// src/scenes/ (see README.md); adding one is an import and an entry here, keyed by its id.
import { cloudsScene } from "./clouds/index.ts";
import { countryScene } from "./country/index.ts";
import { dunesScene } from "./dunes/index.ts";
import { fallsScene } from "./falls/index.ts";
import { flockScene } from "./flock/index.ts";
import { frostScene } from "./frost/index.ts";
import { marbleScene } from "./marble/index.ts";
import { orbitScene } from "./orbit/index.ts";
import { pondScene } from "./pond/index.ts";
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
} satisfies Record<string, SceneDef>;

export type SceneId = keyof typeof sceneDefs;
export const sceneIds = Object.keys(sceneDefs) as SceneId[];
