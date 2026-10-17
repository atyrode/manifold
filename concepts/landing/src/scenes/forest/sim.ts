// The mystic forest's simulation on the page: its life (build.ts, warmed up on the build worker)
// followed and stepped every frame and uploaded for the shader. Until the warmed-up life has landed
// the sim is not ready and nothing of it shows.
// The shader (shader.ts) reads three textures (rows bottom to top):
//   uSim0  rgba16f, 3 x (FOREST_SPIRITS + 1), nearest: one row per spirit, (screen x, screen y of its
//          feet, depth m, alpha 0..1), (head tilt rad + = its top to the left, yaw -1..1 + = its face
//          to the right, glow, variant 0..1), (sink: 0..1 while rising out of the moss, up to
//          DUCK_SINK ducked away from the pointer, in 0.45 of its height; height m, 0, 0); all 0 for
//          a free slot. The last row is the stag: (x m, gait phase 0..1, heading +-1,
//          alpha), (look 0..1, head up 0..1, x where it set out m, distance walked m), (standing 0..1:
//          1 - its speed / its walking pace, 0, 0, 0).
//   uSim1  rgba16f, (2 x bins) x FOREST_MOTE_ROWS, nearest: the motes, binned on square bins
//          FOREST_MOTE_ROWS to the screen height starting at the left edge, two slots (texels) per
//          bin: (x, y within the bin 0..1, depth m, glow 0..1); glow 0 marks an empty slot.
//   uSim2  r16f, FOREST_FOG.width x FOREST_FOG.height over the screen's uv, linear: how thick the
//          mist is here, about 1.
import type { ParamDef } from "../../params.ts";
import { BuildSlot } from "../../sims/build.ts";
import { DataTexture } from "../../sims/texture.ts";
import { skyNow } from "../../world-clock.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import {
  FOREST_FOG,
  FOREST_MOTE_ROWS,
  FOREST_SPIRITS,
  type ForestKnobs,
  ForestLife,
  ForestSimError,
  forestWarmup,
} from "./build.ts";

type KnobKey = "spirits" | "shy" | "stag" | "spores" | "wind" | "time" | "forestSeed";

/** What the sim hands the renderer before its life is up: nothing (no spirits, motes or mist field). */
const NO_TEXTURES: readonly (WebGLTexture | undefined)[] = [undefined, undefined, undefined];

class ForestSim implements SceneSim {
  readonly #beingTexture: DataTexture;
  readonly #moteTexture: DataTexture;
  readonly #fogTexture: DataTexture;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #knobIndex: Readonly<Record<KnobKey, number>>;
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
      if (at < 0) throw new ForestSimError(`forest: the scene has no '${key}' knob`);
      return at;
    };
    this.#knobIndex = {
      spirits: index("spirits"),
      shy: index("shy"),
      stag: index("stag"),
      spores: index("spores"),
      wind: index("wind"),
      time: index("time"),
      forestSeed: index("forestSeed"),
    };
    this.#beingTexture = new DataTexture(gl, {
      width: 3,
      height: FOREST_SPIRITS + 1,
      format: "rgba16f",
      filter: "nearest",
    });
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
    this.#textures = [
      this.#beingTexture.texture,
      this.#moteTexture.texture,
      this.#fogTexture.texture,
    ];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    const knobs = this.#read(frame);
    let life = this.#life;
    const landing = life === undefined;
    if (life === undefined) {
      // Warmed up on the build worker; nothing of the life shows until it lands.
      this.#warming.request(String(knobs.seed), { aspect, knobs: { ...knobs } });
      const landed = this.#warming.advance(frame.budget);
      if (landed === undefined) return NO_TEXTURES;
      life = new ForestLife(landed.result);
      this.#life = life;
    }
    life.follow(knobs);
    if (aspect !== life.aspect) life.resize(aspect);
    if (landing) life.arrive(frame.passage.enter);
    if (life.frame(frame, aspect)) {
      const cols = 2 * life.moteCols;
      if (this.#moteTexture.width !== cols) this.#moteTexture.resize(cols, FOREST_MOTE_ROWS);
      this.#beingTexture.upload(life.beingData);
      this.#moteTexture.upload(life.moteData);
      this.#fogTexture.upload(life.fogData);
    }
    return this.#textures;
  }

  /** Ready once the life has been warmed up (on the build worker). */
  ready(): boolean {
    return this.#life !== undefined;
  }

  dispose(): void {
    this.#warming.dispose();
    this.#beingTexture.dispose();
    this.#moteTexture.dispose();
    this.#fogTexture.dispose();
  }

  /** The knobs as the frame has them (written in place), with the dark of the sky at their hour. */
  #read(frame: SimFrame): ForestKnobs {
    const values = frame.values;
    const index = this.#knobIndex;
    const knobs = this.#knobs;
    knobs.spirits = values[index.spirits] ?? knobs.spirits;
    knobs.shy = values[index.shy] ?? knobs.shy;
    knobs.stag = values[index.stag] ?? knobs.stag;
    knobs.spores = values[index.spores] ?? knobs.spores;
    knobs.wind = values[index.wind] ?? knobs.wind;
    this.#time = values[index.time] ?? this.#time;
    // The dark of the shader's sky (src/world-clock.ts): none once the sun is ~12 degrees up.
    knobs.dark = 1 - skyNow({ time: this.#time, days: frame.phases?.["cycle"] ?? 0 }).day;
    knobs.seed = Math.round(values[index.forestSeed] ?? 0);
    return knobs;
  }
}

/** The forest's simulation for a scene whose knobs are `params` (looked up by key). */
export function forestSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new ForestSim(gl, params);
}
