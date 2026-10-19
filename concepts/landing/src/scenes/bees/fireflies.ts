// Fireflies (the `fireflies` knob, off: the garden's own lights in the grass are its glow-worms,
// glowworms.ts): once the sky is dark they rise from the grass all over the garden, each at its own
// darkness, drifting slowly and blinking a slow yellow-green, each in its own time; they sink back as
// the night lifts, and in rain or snow, and rise again when it is dry. They draw from a stream of
// their own.
import { clamp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { CAMERA, chase, depthPace, type Garden, type Moving, moving, settle } from "./garden.ts";
import { BEES_CODE, BEES_YH } from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

export const BEES_MAX_FIREFLIES = 48;

/** Seconds a firefly takes to rise from the grass, or sink back (a time constant). */
const FIREFLY_RISE = 2.5;
const FIREFLY_SPEED = 0.22;

interface Firefly extends Moving {
  active: boolean;
  /** The darkness of the night (skyState's `night`) it rises at; whether it is out, and how far up (0 in the grass .. 1 flying). */
  wake: number;
  out: boolean;
  up: number;
  /** Seconds between its flashes, and where it is in them (whole flashes since it started). */
  period: number;
  beat: number;
  wayLeft: number;
  /** The highest it drifts (m). */
  cruise: number;
}

function newFirefly(): Firefly {
  return {
    ...moving(),
    active: false,
    wake: 0,
    out: false,
    up: 0,
    period: 6,
    beat: 0,
    wayLeft: 0,
    cruise: 1,
  };
}

/** A firefly's light, 0..1: a quick rise, a moment lit and a slower fade at the start of each of its periods, once it is up. */
function fireflyLight(f: Firefly): number {
  const since = (f.beat - Math.floor(f.beat)) * f.period;
  if (since >= 1.1) return 0;
  return (
    smoothstep(0, 0.15, since) * (1 - smoothstep(0.45, 1.1, since)) * smoothstep(0.4, 0.8, f.up)
  );
}

export class Fireflies {
  readonly list: Firefly[] = Array.from({ length: BEES_MAX_FIREFLIES }, newFirefly);
  /** How many there are (the `fireflies` knob). */
  count = 0;
  readonly #garden: Garden;
  readonly #random = new Random(0xf1e);

  constructor(garden: Garden) {
    this.#garden = garden;
  }

  /** As many as the knob asks for, each in the grass (up already where the page opens in the dark); the rest are gone. */
  wake(first: boolean): void {
    for (const [i, f] of this.list.entries()) {
      const want = i < this.count;
      if (want && !f.active) this.#wake(f, first);
      else if (!want) f.active = false;
    }
  }

  /** A new stage width: every X scales with it. */
  restage(ratio: number): void {
    for (const f of this.list) {
      f.x *= ratio;
      f.px *= ratio;
      f.tx *= ratio;
    }
  }

  step(dt: number): void {
    for (const f of this.list) {
      settle(f);
      this.#step(f, dt);
    }
  }

  #wake(f: Firefly, inScene: boolean): void {
    const garden = this.#garden;
    const rand = this.#random;
    f.active = true;
    f.cx = Number.NaN;
    // Down in the grass anywhere in the garden, near or far.
    const sy = rand.range(0.02, 0.36);
    f.z = CAMERA.groundDepth(BEES_YH - sy);
    f.x = CAMERA.worldX(rand.range(-0.98, 0.98) * garden.stage, f.z);
    f.h = 0.02;
    // Never so low that its going-in mark (less a twentieth) is no dark at all.
    f.wake = rand.range(0.1, 0.5);
    f.period = rand.range(2.5, 5);
    f.beat = rand.next();
    f.cruise = rand.range(0.6, 2.2);
    f.wayLeft = 0;
    f.tx = f.x;
    f.tz = f.z;
    f.th = f.h;
    f.vx = 0;
    f.vz = 0;
    f.vh = 0;
    // A page that opens in the dark (and dry) finds them up already.
    f.out = inScene && garden.wet <= 0 && garden.night > f.wake;
    f.up = f.out ? 1 : 0;
    if (f.out) f.h = rand.range(0.3, f.cruise);
    settle(f);
  }

  #step(f: Firefly, dt: number): void {
    const garden = this.#garden;
    const out =
      f.active &&
      !garden.leaving &&
      garden.wet <= 0 &&
      garden.night > (f.out ? f.wake - 0.05 : f.wake);
    f.out = out;
    if (!out && f.up <= 0) return;
    f.up += ((out ? 1 : 0) - f.up) * (1 - Math.exp(-dt / FIREFLY_RISE));
    if (!out && f.up < 0.01) {
      // Back down in the grass, dark until the next dusk (or the end of the rain).
      f.up = 0;
      f.h = 0.02;
      return;
    }
    const rand = this.#random;
    f.beat += dt / f.period;
    f.wayLeft -= dt;
    if (f.wayLeft <= 0 || Math.hypot(f.tx - f.x, f.tz - f.z) < 0.25) {
      f.wayLeft = rand.range(3, 8);
      f.tz = clamp(f.z + rand.range(-1.2, 1.2), 2.5, 16);
      const across = garden.stage * f.tz * 0.98;
      f.tx = clamp(f.x + rand.range(-1.5, 1.5), -across, across);
      f.th = rand.range(0.25, f.cruise);
    }
    const th = 0.02 + (f.th - 0.02) * f.up;
    chase(f, f.tx, f.tz, th, 1.5, FIREFLY_SPEED * depthPace(f.z), 1 - Math.exp(-dt / 1.1), dt);
  }

  /** The flash a bright cell (with a glow round it close by), the glow alone as it fades. */
  paint(p: Painter, alpha: number): void {
    const specks = p.specks;
    for (const f of this.list) {
      if (f.up <= 0) continue;
      const light = fireflyLight(f);
      if (light < 0.12) continue;
      const z = p.project(f, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      if (light <= 0.5) {
        specks.plot(f.cx, f.cy, BEES_CODE.fireflyGlow, depth);
        continue;
      }
      if (z < 8 && light > 0.75) {
        specks.plot(f.cx - 1, f.cy, BEES_CODE.fireflyGlow, depth);
        specks.plot(f.cx + 1, f.cy, BEES_CODE.fireflyGlow, depth);
        specks.plot(f.cx, f.cy - 1, BEES_CODE.fireflyGlow, depth);
        specks.plot(f.cx, f.cy + 1, BEES_CODE.fireflyGlow, depth);
      }
      specks.plot(f.cx, f.cy, BEES_CODE.firefly, depth);
    }
  }
}
