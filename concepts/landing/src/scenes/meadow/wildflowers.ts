// The wildflowers layer (`wildflowers`, a cover; off in the meadow by default): clumps of ox-eye
// daisies, buttercups, knapweed and field scabious standing up out of the grass in front of the view,
// grown by the shared plant component (sims/plants.ts, shaders/lib/plants.ts). The sim owns what
// happens: each clump's three stems and their heads, every one on its spring, bowed by the composer's
// gust field (composer/gust.ts: the gust at the clump's foot, along the gusts' heading across the
// view, through PlantClimate.wind), the 'now' gust and the passage's gust included, and stirred a
// little in steady wind. The shader owns where the clumps stand in the picture and how they look:
// rooted on the ground at their depth under the rig (lowered with it through the passage), hidden by
// whatever stands nearer than them, lit by the key light and the layers' lights.
//
// Layout. MEADOW_FLOWERS.slots slots across the frame, each a share of the width (jittered) and a
// depth between MEADOW_FLOWERS.near and .far, from the arrangement seed; the knob's amount plants
// the slots whose own hash it reaches, so fewer flowers keep some of more; none where the claims keep
// covers off the ground (LayerFrame.ground). Each clump's frame: x right on screen, y up, metres,
// rooted at its origin.
//
// Records: row 0, texel c: clump c's ground x and depth (m) and whether it grows (1). From row 1 the
// organ records (writePlantRecords at ATLAS_WIDTH), MEADOW_FLOWERS.organs per clump: three stems
// (a: their rest curl), then their heads (form: MEADOW_FLOWER_FORM).
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { gustAt, gustWind, newGustWind } from "../../composer/gust.ts";
import type { LayerFrame, LayerSim, PlacedClaim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { hash31 } from "../../sims/math.ts";
import {
  PlantHabit,
  PlantRole,
  RootedPlants,
  plantClimate,
  writePlantRecords,
  type PlantSpecies,
} from "../../sims/plants.ts";

/** The wildflowers' layout and reach (shared with the shader). */
export const MEADOW_FLOWERS = {
  /** Clump slots across the frame, and organ records per clump (three stems, three heads). */
  slots: 12,
  organs: 6,
  /** The nearest and farthest a clump stands (m). */
  near: 4.5,
  far: 11,
  /** The most a clump reaches above its root and either side of it, metres. */
  tall: 1.5,
  wide: 0.6,
} as const;

/** What a head record draws (its form; a stem's is `stem`). */
export const MEADOW_FLOWER_FORM = {
  stem: 0,
  daisy: 1,
  buttercup: 2,
  knapweed: 3,
  scabious: 4,
} as const;

/** The gust's push across a stem per unit of the gust load, and a stir of their own per unit of wind. */
const GUST_PUSH = 1;
const STIR = 0.08;
/** Seconds of still air (no gust, no wind) after which the clumps are set exactly at rest. */
const SETTLE = 6;
/** The plants' builds draw no randomness of their own: the slot's hashes shape everything. */
const NO_DRAWS = (): number => 0;

/**
 * A clump of a meadow flower: three stems rising out of the grass, each carrying a head of `form`
 * `head` metres across (and a fifth as deep), the tallest `tall` metres.
 */
function meadowFlower(id: string, form: number, tall: number, head: number): PlantSpecies {
  return {
    id,
    moisture: [0.2, 0.9],
    sway: { hz: 1.6, damping: 0.25, give: 0.5, limit: 0.5, flutter: 0.15 },
    year: { shed: 0, turn: 0.7, bloom: [0.15, 0.6] },
    life: { unfold: 10, span: 200 },
    detail: { simple: 4, min: 0.5 },
    build(plant) {
      const k = plant.site.kind ?? 0;
      const stems = [0, 1, 2].map((j) => {
        const h = hash31(k, j, 0x6d66);
        const curl = 0.4 * (h - 0.5);
        return plant.organ({
          offset: [0.06 * (j - 1) + 0.03 * (h - 0.5), 0],
          angle: Math.PI / 2 + 0.12 * (j - 1) + 0.1 * (h - 0.5),
          length: tall * (1 - 0.14 * j) * (0.9 + 0.1 * h),
          width: 0.007,
          curl,
          a: curl,
          form: MEADOW_FLOWER_FORM.stem,
          slot: j,
        });
      });
      stems.forEach((stem, j) => {
        const h = hash31(k, j + 3, 0x6d66);
        plant.organ({
          parent: stem,
          angle: 0,
          length: 0.2 * head,
          width: head * (0.85 + 0.3 * h),
          form,
          role: PlantRole.bloom,
          habit: PlantHabit.rigid,
          slot: 3 + j,
        });
      });
    },
  };
}

const FLOWERS: readonly PlantSpecies[] = [
  meadowFlower("ox-eye daisy", MEADOW_FLOWER_FORM.daisy, 1.05, 0.06),
  meadowFlower("meadow buttercup", MEADOW_FLOWER_FORM.buttercup, 1.0, 0.035),
  meadowFlower("common knapweed", MEADOW_FLOWER_FORM.knapweed, 1.2, 0.04),
  meadowFlower("field scabious", MEADOW_FLOWER_FORM.scabious, 1.3, 0.045),
];

/** The wildflowers' sim (see the header), into the layer's records. */
class WildflowersSim implements LayerSim {
  readonly #knobs: KnobReader<"wildflowers" | "seed">;
  readonly #climate = plantClimate();
  readonly #wind = newGustWind();
  #plants: RootedPlants | undefined;
  /** Each clump's ground (x, depth), and its gust's push this frame. */
  #ground = new Float64Array(0);
  #push = new Float64Array(0);
  /** What the clumps were grown for (aspect, rows, arrangement, amount, claims); empty: none grown. */
  #layout = "";
  #claims: readonly PlacedClaim[] | undefined;
  #fresh = false;
  #stillFor = 0;
  #rested = false;
  #still = true;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("meadow wildflowers", params, ["wildflowers", "seed"]);
    this.#climate.wind = (_x, _y, out, plant) => {
      out[0] = (out[0] ?? 0) + (this.#push[plant] ?? 0);
    };
  }

  frame(frame: LayerFrame): void {
    const knobs = this.#knobs;
    const amount = knobs.value(frame, "wildflowers");
    if (!(amount > 0)) {
      this.#plants = undefined;
      this.#layout = "";
      return;
    }
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    const rows = frame.height > 0 ? frame.height : 540;
    const arrangement = Math.round(knobs.value(frame, "seed"));
    const layout = `${aspect}:${rows}:${arrangement}:${amount}`;
    if (layout !== this.#layout || frame.ground.claims !== this.#claims) {
      this.#grow(frame, aspect, rows, arrangement, amount);
      this.#layout = layout;
      this.#claims = frame.ground.claims;
    }
    const plants = this.#plants;
    if (!plants) return;
    const gusts = frame.gusts;
    // The gust field as the other layers read it: the 'now' gust's age on the motion clock, the
    // passage's front as the composer hands it over.
    const wind = gustWind(
      this.#wind,
      gusts.wind,
      gusts.gusts,
      gusts.rate,
      gusts.nowAge,
      gusts.pass,
      gusts.shape,
    );
    const ground = this.#ground;
    this.#push.forEach((_, p) => {
      const g = gustAt(wind, ground[2 * p] ?? 0, ground[2 * p + 1] ?? 1, frame.motionTime, 0);
      this.#push[p] = GUST_PUSH * wind.dirX * g;
    });
    const climate = this.#climate;
    const h = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    climate.dt = h;
    climate.time = frame.motionTime;
    climate.air.calm = STIR * Math.abs(gusts.wind);
    // Still air: no gust anywhere (none of their own, no 'now' or passage gust) and no wind. They
    // swing while the air moves them; once it is still they are set exactly at rest, after SETTLE
    // seconds of swinging out or at once while time stands still; freshly grown, at rest in the
    // air as it is.
    const still = gusts.wind === 0 && this.#push.every((push) => push === 0);
    this.#stillFor = still ? this.#stillFor + h : 0;
    if (!still) this.#rested = false;
    let settle = this.#fresh || (h === 0 && still !== this.#still);
    let moved = false;
    if (!settle && h > 0) {
      plants.step(climate);
      moved = true;
      settle = still && !this.#rested && this.#stillFor >= SETTLE;
    } else if (!settle) {
      settle = still && !this.#rested;
    }
    if (settle) {
      plants.settle(climate);
      this.#rested = still;
      this.#fresh = false;
      moved = true;
    }
    this.#still = still;
    if (moved) {
      const data = frame.records.data;
      data.fill(0, ATLAS_WIDTH * 4);
      writePlantRecords(plants, data, ATLAS_WIDTH, 1, MEADOW_FLOWERS.slots * MEADOW_FLOWERS.organs);
      frame.records.touch();
    }
  }

  // Records only: nothing of its own to release.
  dispose(): void {}

  /** Grows the clumps the amount plants for this frame and arrangement (see the header). */
  #grow(
    frame: LayerFrame,
    aspect: number,
    rows: number,
    arrangement: number,
    amount: number,
  ): void {
    const S = MEADOW_FLOWERS;
    const focal = frame.rig.focal;
    const data = frame.records.data;
    data.fill(0);
    const plants = new RootedPlants(S.slots * S.organs, arrangement);
    const ground: number[] = [];
    for (let k = 0; k < S.slots; k++) {
      if (hash31(k, arrangement, 0x7766) >= amount) continue;
      const share = (k + 0.5 + 0.6 * (hash31(k, arrangement, 0x7767) - 0.5)) / S.slots;
      const z = S.near + (S.far - S.near) * hash31(k, arrangement, 0x7768) ** 1.3;
      const x = ((share - 0.5) * aspect * z) / focal;
      const species = FLOWERS[Math.floor(hash31(k, arrangement, 0x7769) * FLOWERS.length)];
      if (!species || frame.ground.coverAllowed(x, z) < 0.5) continue;
      plants.add(
        species,
        {
          x: 0,
          y: 0,
          heading: Math.PI / 2,
          moisture: 0.5,
          cells: (rows * focal) / z,
          kind: Math.imul(k + 1, 0x2c1b3c6d) ^ arrangement,
          slot: k * S.organs,
        },
        NO_DRAWS,
      );
      data.set([x, z, 1], k * 4);
      ground.push(x, z);
    }
    frame.records.touch();
    this.#plants = plants;
    this.#ground = Float64Array.from(ground);
    this.#push = new Float64Array(plants.plants);
    this.#stillFor = 0;
    this.#rested = false;
    this.#fresh = true;
  }
}

/** The wildflowers layer's sim (LayerCode.sim): records only. */
export function wildflowersSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new WildflowersSim(params);
}

const F = MEADOW_FLOWER_FORM;

/** The wildflowers' GLSL: the clumps (meadowWildflowers) and the layer's middle pass. */
export const wildflowersGlsl = /* glsl */ `
// ---- the wildflowers (wildflowers.ts) ----
const int MEADOW_FLOWER_SLOTS = ${MEADOW_FLOWERS.slots};
const int MEADOW_FLOWER_ORGANS = ${MEADOW_FLOWERS.organs};
const float MEADOW_FLOWER_TALL = ${glslFloat(MEADOW_FLOWERS.tall)};
const float MEADOW_FLOWER_WIDE = ${glslFloat(MEADOW_FLOWERS.wide)};
const vec3 MEADOW_DAISY = vec3(0.95, 0.94, 0.86);
const vec3 MEADOW_DAISY_EYE = vec3(0.95, 0.72, 0.12);
const vec3 MEADOW_BUTTERCUP = vec3(1.0, 0.8, 0.1);
const vec3 MEADOW_KNAPWEED = vec3(0.56, 0.2, 0.52);
const vec3 MEADOW_SCABIOUS = vec3(0.64, 0.56, 0.86);
const vec3 MEADOW_BRACTS = vec3(0.2, 0.16, 0.08);

// The wildflower clumps over what this cell shows (zHit: its depth), each rooted on the ground at
// its depth (the records' first row) under the eye at height \`eye\`, nearer ones in front. A stem is
// an arc turning its curl (a) plus its spring's bend, never under a cell and a half wide; a head an
// ellipse across the tip of its stem, a daisy's with its yellow eye, a knapweed's on dark bracts.
// Cut per cell, so a swaying stem changes each cell once. Lit as the clocks are, against the low
// sun; wet, darker. hazeDensity: the aerial haze per metre, as the sea of grass takes it.
void meadowWildflowers(vec2 p, float aspect, float eye, vec3 amb, vec3 sun, float behind, float sunNear, vec3 haze, float hazeDensity, float wet, float aa, inout vec3 col, inout float accent, inout float zHit) {
  if (K_wildflowers <= 0.0 || !wildflowersSimOn()) return;
  for (int c = 0; c < MEADOW_FLOWER_SLOTS; c++) {
    vec4 at = wildflowersRecord(c, 0); // ground x, depth, grows
    if (at.z < 0.5 || at.y >= zHit) continue;
    float scale = RIG_FOCAL / at.y;          // screen heights a metre spans there
    vec2 root = vec2(0.5 * aspect + at.x * scale, RIG_HORIZON - eye * scale);
    vec2 m = (p - root) / scale;
    if (m.y < -0.05 || m.y > MEADOW_FLOWER_TALL || abs(m.x) > MEADOW_FLOWER_WIDE) continue;
    float foot = aa / scale;
    float cover = 0.0;
    vec3 shade = vec3(0.0);
    for (int k = 0; k < MEADOW_FLOWER_ORGANS; k++) {
      PlantOrgan o = plantOrgan(wildflowersAtlas, wildflowersRow + 1, c * MEADOW_FLOWER_ORGANS + k);
      if (o.tier < 0.5) continue;
      vec2 l = plantLocal(m, o);
      float here = 0.0;
      vec3 lit = vec3(0.0);
      if (o.form < ${F.stem + 0.5}) {
        float s = 0.0;
        float dist = plantArc(l, o.len, o.a + o.bend, s);
        if (s < 0.0 || s > 1.0) continue;
        float girth = max(0.5 * o.width * (1.0 - 0.3 * s), 0.75 * foot);
        here = smoothfall(girth + 0.5 * foot, girth - 0.5 * foot, abs(dist));
        float rim = smoothstep(0.3 * girth, girth, abs(dist));
        lit = wetten(MEADOW_STALK * 1.3, wet, 0.45) * (amb * 0.35 + sun * (0.15 + 0.5 * behind)) + sun * MEADOW_RIM * rim * (0.2 + behind + 0.5 * sunNear);
      } else {
        float r = max(0.5 * o.width, 0.8 * foot);
        float deep = max(o.len, foot);
        float e = length(vec2((l.x - 0.5 * deep) / (0.5 * deep + 0.5 * foot), l.y / r));
        here = smoothfall(1.0 + 0.5 * foot / r, 1.0 - 0.5 * foot / r, e);
        vec3 petal = o.form < ${F.daisy + 0.5} ? (abs(l.y) < 0.3 * r ? MEADOW_DAISY_EYE : MEADOW_DAISY) : (o.form < ${F.buttercup + 0.5} ? MEADOW_BUTTERCUP : (o.form < ${F.knapweed + 0.5} ? (l.x < 0.35 * deep ? MEADOW_BRACTS : MEADOW_KNAPWEED) : MEADOW_SCABIOUS));
        lit = wetten(petal, wet, 0.3) * (amb * 0.6 + sun * (0.35 + 0.9 * behind + 0.4 * sunNear)) + sun * MEADOW_RIM * smoothstep(0.6, 1.0, e) * (0.2 + behind);
      }
      here = hardEdge(here);
      if (here > 0.5) {
        cover = 1.0;
        shade = lit;
      }
    }
    if (cover > 0.5) {
      col = mix(shade, haze, 1.0 - exp(-hazeDensity * at.y));
      accent = 0.0;
      zHit = at.y;
    }
  }
}

// The wildflowers' middle pass: the clumps over the field, lit by the key light on the land this
// cell sees (as the sea of grass is) and the layers' lights, in the backdrop's haze.
void wildflowersMiddle(Ctx x, inout Cell c) {
  float zLand = x.uv.y < RIG_HORIZON ? min(x.eye * RIG_FOCAL / (RIG_HORIZON - x.uv.y), x.landZ) : x.landZ;
  vec3 sunLand = x.light.sun * worldSunlit(x.w, x.v, vec3(meadowCx * zLand / RIG_FOCAL, -x.eye, zLand));
  float z = c.z;
  meadowWildflowers(meadowP, x.aspect, x.eye, x.light.amb, sunLand, meadowBehind, meadowSunNear, x.air.haze, x.air.dust + x.air.rain, uWeather.x, x.aa, c.col, c.accent, c.z);
  if (c.z < z) c.zs = min(c.zs, c.z);
}
`;
