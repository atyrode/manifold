// The scene registry, in lab order (cards, `[` / `]` cycling). A scene is one folder under
// src/scenes/ (see README.md); adding one is an import and an entry here, keyed by its id.
import { orbitScene } from "./orbit/index.ts";
import { pondScene } from "./pond/index.ts";
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
} satisfies Record<string, SceneDef>;

export type SceneId = keyof typeof sceneDefs;
export const sceneIds = Object.keys(sceneDefs) as SceneId[];
