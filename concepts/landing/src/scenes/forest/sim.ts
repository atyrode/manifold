// The kodama's sim (the forest's life on the page): its life (build.ts, warmed up on the build worker)
// followed and stepped every frame and written for the shader. Until the warmed-up life has landed
// the sim is not ready and nothing of it shows.
// What the GLSL (shader.ts) reads, through the composer's accessors:
//   kodamaRecord(3 s + k, 0)  its row of the records atlas: texels 3 s .. 3 s + 2 for spirit slot s
//          (FOREST_SPIRITS of them), (screen x, screen y of its feet, depth m, alpha 0..1), (head tilt
//          rad + = its top to the left, yaw -1..1 + = its face to the right, glow, variant 0..1),
//          (sink: 0..1 while rising out of the moss, up to DUCK_SINK ducked away from the pointer, in
//          0.45 of its height; height m, 0, 0); all 0 for a free slot. Then the stag's three: (x m,
//          gait phase 0..1, heading +-1, alpha), (look 0..1, head up 0..1, x where it set out m,
//          distance walked m), (standing 0..1: 1 - its speed / its walking pace, 0, 0, 0).
//   kodamaField0  rgba16f, (2 x bins) x FOREST_MOTE_ROWS, nearest: the motes, binned on square bins
//          FOREST_MOTE_ROWS to the screen height starting at the left edge, two slots (texels) per
//          bin: (x, y within the bin 0..1, depth m, glow 0..1); glow 0 marks an empty slot.
//   kodamaField1  r16f, FOREST_FOG.width x FOREST_FOG.height over the screen's uv, linear: how thick
//          the mist is here, about 1 (the woods draw its banks).
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import type { ParamDef } from "../../params.ts";
import { BuildSlot } from "../../sims/build.ts";
import { DataTexture } from "../../sims/texture.ts";
import { skyNow } from "../../world-clock.ts";
import {
  type ForestKnobs,
  ForestLife,
  ForestSimError,
  type ForestSlots,
  forestWarmup,
} from "./build.ts";
import { FOREST_FOG, FOREST_MOTE_ROWS } from "./layout.ts";

type KnobKey = "spirits" | "shy" | "stag" | "spores" | "wind" | "time" | "seed";

class KodamaSim implements LayerSim {
  readonly #moteTexture: DataTexture;
  readonly #fogTexture: DataTexture;
  readonly #knobIndex: Readonly<Record<KnobKey, number>>;
  readonly #slots: ForestSlots;
  /** The knobs as the life follows them, rewritten in place each frame; the hour they set. */
  readonly #knobs: ForestKnobs = {
    spirits: 0.5,
    shy: 0,
    stag: 0.3,
    spores: 0.5,
    wind: 0.2,
    dark: 1,
    seed: 0,
  };
  #time = 0.82;
  /** Warming the life up on the build worker (sims/build.ts); the life once it has landed. */
  readonly #warming = new BuildSlot(forestWarmup);
  #life: ForestLife | undefined;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const index = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new ForestSimError(`kodama: the scene has no '${key}' knob`);
      return at;
    };
    this.#knobIndex = {
      spirits: index("spirits"),
      shy: index("shy"),
      stag: index("stag"),
      spores: index("spores"),
      wind: index("wind"),
      time: index("time"),
      seed: index("seed"),
    };
    const slot = (key: string): number => params.find((def) => def.key === key)?.trigger ?? -1;
    this.#slots = {
      gather: slot("spirits"),
      stag: slot("stag"),
      mark: slot("shrineMark"),
      spores: slot("spores"),
    };
    // Sized to the life's mote bins before each upload.
    this.#moteTexture = new DataTexture(gl, {
      width: 1,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#fogTexture = new DataTexture(gl, {
      width: FOREST_FOG.width,
      height: FOREST_FOG.height,
      format: "r16f",
    });
  }

  frame(frame: LayerFrame): void {
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    const knobs = this.#read(frame);
    let life = this.#life;
    const landing = life === undefined;
    if (life === undefined) {
      // Warmed up on the build worker; nothing of the life shows until it lands.
      this.#warming.request(String(knobs.seed), { aspect, knobs: { ...knobs } });
      const landed = this.#warming.advance(frame.budget);
      if (landed === undefined) return;
      life = new ForestLife(landed.result);
      this.#life = life;
      const [motes, fog] = frame.fields;
      if (motes !== undefined) motes.texture = this.#moteTexture.texture;
      if (fog !== undefined) fog.texture = this.#fogTexture.texture;
    }
    life.follow(knobs);
    if (aspect !== life.aspect) life.resize(aspect);
    if (landing) life.arrive(frame.passage.enter);
    if (life.frame(frame, aspect, this.#slots)) {
      const cols = 2 * life.moteCols;
      if (this.#moteTexture.width !== cols) this.#moteTexture.resize(cols, FOREST_MOTE_ROWS);
      frame.records.data.set(life.beingData);
      frame.records.touch();
      this.#moteTexture.upload(life.moteData);
      this.#fogTexture.upload(life.fogData);
    }
  }

  /** Ready once the life has been warmed up (on the build worker). */
  ready(): boolean {
    return this.#life !== undefined;
  }

  dispose(): void {
    this.#warming.dispose();
    this.#moteTexture.dispose();
    this.#fogTexture.dispose();
  }

  /** The knobs as the frame has them (written in place), with the dark of the sky at their hour. */
  #read(frame: LayerFrame): ForestKnobs {
    const values = frame.values;
    const index = this.#knobIndex;
    const knobs = this.#knobs;
    knobs.spirits = values[index.spirits] ?? knobs.spirits;
    knobs.shy = values[index.shy] ?? knobs.shy;
    knobs.stag = values[index.stag] ?? knobs.stag;
    knobs.spores = values[index.spores] ?? knobs.spores;
    knobs.wind = values[index.wind] ?? knobs.wind;
    this.#time = values[index.time] ?? this.#time;
    // The dark of the World's sky (src/world-clock.ts): none once the sun is ~12 degrees up.
    knobs.dark = 1 - skyNow({ time: this.#time, days: frame.phases?.["cycle"] ?? 0 }).day;
    knobs.seed = Math.round(values[index.seed] ?? 0);
    return knobs;
  }
}

/** The kodama's sim, given the composed scene's knobs (its own under their short keys). */
export function kodamaSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new KodamaSim(gl, params);
}
