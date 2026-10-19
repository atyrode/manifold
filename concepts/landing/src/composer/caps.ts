// The composer's caps and budgets (ADR 0062 "Budgets and caps", README "Programs and cost"). The
// counts are enforced as layers are resolved and assembled (place.ts, compose.ts, sim.ts); the
// program sizes and uniform vectors by src/composer/budget.test.ts and scripts/glsl-check.ts.
import { MAX_PARAMS, MAX_PROGRAM_PARAMS, MAX_TRIGGERS } from "../params.ts";

export const COMPOSER_CAPS = {
  /** Layers on at once, the World not counted. */
  layers: 8,
  /** Dressings marked `subject` in the front band. */
  subjects: 2,
  /** Claims one program holds (compile-time constants, no uniforms). */
  claims: 12,
  /** Local lights one program sums (`localLight`). */
  lights: 8,
  /** Sim textures: the speck map, the records atlas and up to six fields. */
  simTextures: 8,
  fields: 6,
  /**
   * Knobs a composed scene lists, and knobs one of its programs reads: the per-program layout
   * (shaders/index.ts `knobSlots`, compose.ts `checkKnobCaps`) packs only the composer's and the on
   * layers' into a program's `uParams`. Trigger slots: the renderer's uTriggers (MAX_TRIGGERS); the
   * ADR's 32 packed slots are what a composer outgrowing them takes on.
   */
  params: MAX_PARAMS,
  programParams: MAX_PROGRAM_PARAMS,
  triggers: MAX_TRIGGERS,
  /** Characters of a shaken program: at a preset's defaults, and a layer set's all-features one. */
  shakenDefault: 160 * 1024,
  shakenAll: 256 * 1024,
  /** The pilot mix's all-features program (ADR Phase 1 acceptance). */
  shakenPilotMix: 230 * 1024,
  /** Fragment uniform vectors (WebGL2's guaranteed minimum; scripts/glsl-check.ts). */
  uniformVectors: 224,
} as const;

/** The records atlas: rgba16f, nearest, this many texels a row. */
export const ATLAS_WIDTH = 512;

/** The speck map's depth byte: steps per metre (the bees' quarter metre). */
export const SPECK_DEPTH_STEP = 4;
