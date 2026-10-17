// Glow-worms (the `glowworms` knob): the English garden's lights in the grass, Lampyris noctiluca, the
// wingless females glowing a steady green low in the grass after dusk to call the males. Each keeps to
// its own spot of the lawn and the drifts; once the night is dark enough for it (each at its own
// darkness) it climbs a grass stem a few centimetres as its light comes up over a few seconds, then
// holds it, steady; it goes out and down again as the night lifts, and in rain or snow (coming back
// when it is dry). None by day. They draw from a stream of their own.
import { smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { CAMERA, type Flier, type Garden, settle } from "./garden.ts";
import { BEES_CODE, BEES_YH } from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

export const BEES_MAX_GLOWWORMS = 40;

/** Seconds its light takes to come up, or go out (a time constant). */
const GLOW_RISE = 3;
/** Its height in the grass while dark (m), and the stems it climbs to glow (m). */
const GLOW_LOW = 0.01;
const GLOW_STEM = [0.03, 0.12] as const;

interface Glowworm extends Flier {
  active: boolean;
  /** The darkness of the night (skyState's `night`) it lights at; whether it is lit, and how far its light has come up (0 dark .. 1 full). */
  wake: number;
  out: boolean;
  up: number;
  /** How high up its stem it glows (m). */
  stem: number;
}

function newGlowworm(): Glowworm {
  return {
    x: 0,
    z: 8,
    h: GLOW_LOW,
    px: 0,
    pz: 8,
    ph: GLOW_LOW,
    cx: Number.NaN,
    cy: Number.NaN,
    active: false,
    wake: 0,
    out: false,
    up: 0,
    stem: GLOW_STEM[0],
  };
}

export class Glowworms {
  readonly list: Glowworm[] = Array.from({ length: BEES_MAX_GLOWWORMS }, newGlowworm);
  /** How many there are (the `glowworms` knob). */
  count = 0;
  readonly #garden: Garden;
  readonly #random = new Random(0x910);

  constructor(garden: Garden) {
    this.#garden = garden;
  }

  /** As many as the knob asks for, each at its spot (lit already where the page opens in a dry dark); the rest are gone. */
  wake(first: boolean): void {
    for (const [i, g] of this.list.entries()) {
      const want = i < this.count;
      if (want && !g.active) this.#wake(g, first);
      else if (!want) g.active = false;
    }
  }

  /** A new stage width: every X scales with it. */
  restage(ratio: number): void {
    for (const g of this.list) {
      g.x *= ratio;
      g.px *= ratio;
    }
  }

  step(dt: number): void {
    for (const g of this.list) {
      settle(g);
      this.#step(g, dt);
    }
  }

  #wake(g: Glowworm, inScene: boolean): void {
    const garden = this.#garden;
    const rand = this.#random;
    g.active = true;
    g.cx = Number.NaN;
    // In the grass anywhere in the garden, near or far.
    const sy = rand.range(0.02, 0.34);
    g.z = CAMERA.groundDepth(BEES_YH - sy);
    g.x = CAMERA.worldX(rand.range(-0.98, 0.98) * garden.stage, g.z);
    g.wake = rand.range(0.15, 0.6);
    g.stem = rand.range(GLOW_STEM[0], GLOW_STEM[1]);
    g.out = inScene && garden.wet <= 0 && garden.night > g.wake;
    g.up = g.out ? 1 : 0;
    g.h = GLOW_LOW + (g.out ? g.stem : 0);
    settle(g);
  }

  #step(g: Glowworm, dt: number): void {
    const garden = this.#garden;
    const out =
      g.active &&
      !garden.leaving &&
      garden.wet <= 0 &&
      garden.night > (g.out ? g.wake - 0.05 : g.wake);
    g.out = out;
    if (!out && g.up <= 0) return;
    g.up += ((out ? 1 : 0) - g.up) * (1 - Math.exp(-dt / GLOW_RISE));
    // Out and back down in the grass, dark until the next dusk (or the end of the rain).
    if (!out && g.up < 0.01) g.up = 0;
    g.h = GLOW_LOW + g.stem * smoothstep(0, 0.6, g.up);
  }

  /** The light a bright green cell (a glow round it close by), the glow alone while it comes up or goes out. */
  paint(p: Painter, alpha: number): void {
    const specks = p.specks;
    for (const g of this.list) {
      if (g.up <= 0) continue;
      const light = smoothstep(0.3, 0.9, g.up);
      if (light < 0.15) continue;
      const z = p.project(g, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      if (light < 0.6) {
        specks.plot(g.cx, g.cy, BEES_CODE.glowwormGlow, depth);
        continue;
      }
      if (z < 7) {
        specks.plot(g.cx - 1, g.cy, BEES_CODE.glowwormGlow, depth);
        specks.plot(g.cx + 1, g.cy, BEES_CODE.glowwormGlow, depth);
        specks.plot(g.cx, g.cy + 1, BEES_CODE.glowwormGlow, depth);
      }
      specks.plot(g.cx, g.cy, BEES_CODE.glowworm, depth);
    }
  }
}
