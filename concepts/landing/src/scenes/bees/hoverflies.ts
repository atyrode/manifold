// Hoverflies: dead still in the air over a drift, then a dart too quick to follow, still again, now
// and then down onto a flower. By day, in dry weather; they draw from a stream of their own.
import { lerp } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { CAMERA, depthPace, type Flier, type Garden, moving, settle } from "./garden.ts";
import { BEES_CODE } from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

export const BEES_MAX_HOVERFLIES = 10;

const HOVERFLY_LENGTH = 0.011;
const HOVERFLY_DART = 3.2;
/** Farthest a hoverfly darts in one go. */
const HOVERFLY_REACH = 1.4;

type HoverflyMode = "hover" | "dart" | "rest";

interface Hoverfly extends Flier {
  active: boolean;
  off: boolean;
  mode: HoverflyMode;
  /** Seconds left hovering or resting; seconds into a dart, and how long it takes. */
  hold: number;
  t: number;
  span: number;
  /** A dart sets out from (ax, az, ah) and stops dead at (tx, tz, th). */
  ax: number;
  az: number;
  ah: number;
  tx: number;
  tz: number;
  th: number;
  /** The drift it keeps to, and whether the dart ends on a flower of it. */
  patch: number;
  land: boolean;
}

function newHoverfly(): Hoverfly {
  const { x, z, h, px, pz, ph, cx, cy } = moving();
  return {
    x,
    z,
    h,
    px,
    pz,
    ph,
    cx,
    cy,
    active: false,
    off: false,
    mode: "hover",
    hold: 0,
    t: 0,
    span: 1,
    ax: 0,
    az: 8,
    ah: 0,
    tx: 0,
    tz: 8,
    th: 0,
    patch: 0,
    land: false,
  };
}

export class Hoverflies {
  readonly list: Hoverfly[] = Array.from({ length: BEES_MAX_HOVERFLIES }, newHoverfly);
  /** How many are about (the `hoverflies` knob). */
  count = 0;
  readonly #garden: Garden;
  readonly #random = new Random(0x40f);

  constructor(garden: Garden) {
    this.#garden = garden;
  }

  /** As many as the knob asks for by day: newcomers dart in from the edge (at work where they are as the page opens), the rest dart off. */
  wake(first: boolean): void {
    const garden = this.#garden;
    const day = !garden.roost && !garden.leaving;
    for (const [i, f] of this.list.entries()) {
      const want = day && i < this.count;
      if (want && !f.active) this.#wake(f, first);
      else if (!want && f.active && !f.off) {
        f.off = true;
        garden.edgePoint(f.x, f.z, f.h);
        this.#dartTo(f, garden.pt.x, garden.pt.z, garden.pt.h, false);
      }
    }
  }

  /** A new stage width: every X scales with it. */
  restage(ratio: number): void {
    for (const f of this.list) {
      f.x *= ratio;
      f.px *= ratio;
      f.ax *= ratio;
      f.tx *= ratio;
    }
  }

  step(dt: number): void {
    for (const f of this.list) {
      if (!f.active) continue;
      settle(f);
      this.#step(f, dt);
    }
  }

  #wake(f: Hoverfly, inScene: boolean): void {
    const garden = this.#garden;
    const rand = this.#random;
    f.active = true;
    f.off = false;
    f.cx = Number.NaN;
    f.patch = garden.pickPatch(true, rand);
    garden.flowerPoint(f.patch, rand);
    const pt = garden.pt;
    const lift = rand.range(0.25, 0.9);
    if (inScene) {
      f.x = pt.x;
      f.z = pt.z;
      f.h = pt.h + lift;
      f.mode = "hover";
      f.hold = rand.range(0.3, 3.5);
      settle(f);
      return;
    }
    const tx = pt.x;
    const tz = pt.z;
    const th = pt.h + lift;
    garden.edgePoint(tx, tz, th);
    f.x = pt.x;
    f.z = pt.z;
    f.h = th;
    settle(f);
    this.#dartTo(f, tx, tz, th, false);
  }

  /** A dart from where it hangs to (tx, tz, th): fast, straight, stopping dead. */
  #dartTo(f: Hoverfly, tx: number, tz: number, th: number, land: boolean): void {
    f.ax = f.x;
    f.az = f.z;
    f.ah = f.h;
    f.tx = tx;
    f.tz = tz;
    f.th = th;
    f.land = land;
    f.mode = "dart";
    f.t = 0;
    const dist = Math.hypot(tx - f.x, tz - f.z, th - f.h);
    f.span = Math.max(0.12, dist / (HOVERFLY_DART * depthPace(f.z) * this.#garden.flit));
  }

  #step(f: Hoverfly, dt: number): void {
    const garden = this.#garden;
    const rand = this.#random;
    if (f.mode === "dart") {
      f.t += dt;
      const u = Math.min(1, f.t / f.span);
      const e = u * u * (3 - 2 * u);
      f.x = lerp(f.ax, f.tx, e);
      f.z = lerp(f.az, f.tz, e);
      f.h = lerp(f.ah, f.th, e);
      if (u < 1) return;
      if (f.off) {
        f.active = false;
        return;
      }
      f.mode = f.land ? "rest" : "hover";
      f.hold = f.land ? rand.range(1.5, 6) : rand.range(0.6, 3.5);
      return;
    }
    // Hovering or resting: dead still.
    f.hold -= dt;
    if (f.hold > 0) return;
    if (rand.next() < 0.1) f.patch = garden.pickPatch(true, rand);
    garden.flowerPoint(f.patch, rand);
    const pt = garden.pt;
    const land = f.mode === "hover" && rand.next() < 0.2;
    let tx = pt.x;
    let tz = pt.z;
    let th = land ? pt.h : pt.h + rand.range(0.25, 0.9);
    const dist = Math.hypot(tx - f.x, tz - f.z, th - f.h);
    if (!land && dist > HOVERFLY_REACH) {
      // No farther than a dart goes: on toward it next time.
      const k = HOVERFLY_REACH / dist;
      tx = f.x + (tx - f.x) * k;
      tz = f.z + (tz - f.z) * k;
      th = Math.max(0.2, f.h + (th - f.h) * k);
    }
    this.#dartTo(f, tx, tz, th, land);
  }

  /** An amber speck; near, two cells with the shimmer of wing above while it hangs in the air. */
  paint(p: Painter, alpha: number): void {
    const specks = p.specks;
    const h = specks.height;
    for (const f of this.list) {
      if (!f.active) continue;
      const z = p.project(f, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      const n = (HOVERFLY_LENGTH * h * CAMERA.focal) / z;
      if (n < 1.7) {
        specks.plot(f.cx, f.cy, n >= 0.5 ? BEES_CODE.hoverfly : BEES_CODE.beeFaint, depth);
        continue;
      }
      specks.block(f.cx, f.cy, 2, 1, BEES_CODE.hoverfly, depth);
      if (f.mode !== "rest") specks.plot(f.cx, f.cy + 1, BEES_CODE.beeWing, depth);
    }
  }
}
