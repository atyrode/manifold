// Dragonflies: fast straight runs along the path and over the garden that turn sharply at the end of
// each, a hover or a rest on a standing foxglove's tip between beats, the wings catching the light.
// By day, in dry weather; they draw from a stream of their own.
import { clamp } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import {
  CAMERA,
  chase,
  depthPace,
  type Garden,
  type Moving,
  moving,
  settle,
  TAU,
} from "./garden.ts";
import { BEES_CODE, BEES_FOXGLOVES_ALL, BEES_YH } from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

export const BEES_MAX_DRAGONFLIES = 3;

const DRAGONFLY_LENGTH = 0.075;
const DRAGONFLY_SPAN = 0.1;
const DRAGONFLY_SPEED = 4.5;

type DragonflyMode = "run" | "hover" | "perch";

interface Dragonfly extends Moving {
  active: boolean;
  off: boolean;
  mode: DragonflyMode;
  hold: number;
  age: number;
  phase: number;
  /** Its heading on the ground plane (a unit vector), kept while it hovers or perches. */
  hx: number;
  hz: number;
  /** Runs left before it stops, and the foxglove it is flying to perch on (-1 none). */
  legs: number;
  perch: number;
}

function newDragonfly(): Dragonfly {
  return {
    ...moving(),
    active: false,
    off: false,
    mode: "run",
    hold: 0,
    age: 0,
    phase: 0,
    hx: 1,
    hz: 0,
    legs: 0,
    perch: -1,
  };
}

export class Dragonflies {
  readonly list: Dragonfly[] = Array.from({ length: BEES_MAX_DRAGONFLIES }, newDragonfly);
  /** How many are about (the `dragonflies` knob). */
  count = 0;
  readonly #garden: Garden;
  readonly #random = new Random(0xd7a);

  constructor(garden: Garden) {
    this.#garden = garden;
  }

  /** As many as the knob asks for by day: newcomers fly in from the edge (on their beat as the page opens), the rest fly off. */
  wake(first: boolean): void {
    const garden = this.#garden;
    const day = !garden.roost && !garden.leaving;
    for (const [i, d] of this.list.entries()) {
      const want = day && i < this.count;
      if (want && !d.active) this.#wake(d, first);
      else if (!want && d.active && !d.off) {
        garden.sendOff(d);
        d.mode = "run";
        d.perch = -1;
      }
    }
  }

  /** A new stage width: every X scales with it. */
  restage(ratio: number): void {
    for (const d of this.list) {
      d.x *= ratio;
      d.px *= ratio;
      d.tx *= ratio;
    }
  }

  step(dt: number): void {
    for (const d of this.list) {
      if (!d.active) continue;
      settle(d);
      this.#step(d, dt);
    }
  }

  #wake(d: Dragonfly, inScene: boolean): void {
    const garden = this.#garden;
    const rand = this.#random;
    d.active = true;
    d.off = false;
    d.cx = Number.NaN;
    d.phase = rand.next() * TAU;
    d.age = rand.next() * 10;
    d.perch = -1;
    d.legs = 2 + rand.int(4);
    d.mode = "run";
    this.#runTo(d);
    if (inScene) {
      d.x = d.tx;
      d.z = d.tz;
      d.h = d.th;
      this.#runTo(d);
    } else {
      garden.edgePoint(d.tx, d.tz, d.th);
      d.x = garden.pt.x;
      d.z = garden.pt.z;
      d.h = d.th;
    }
    const dx = d.tx - d.x;
    const dz = d.tz - d.z;
    const flat = Math.hypot(dx, dz) + 1e-6;
    d.hx = dx / flat;
    d.hz = dz / flat;
    d.vx = 0;
    d.vz = 0;
    d.vh = 0;
    settle(d);
  }

  /** The next point of its beat, at least a couple of metres off: over the path, or over a drift. */
  #runTo(d: Dragonfly): void {
    const garden = this.#garden;
    const rand = this.#random;
    for (let tries = 0; tries < 4; tries++) {
      if (rand.next() < 0.55) {
        const sy = rand.range(0.02, 0.36);
        d.tz = CAMERA.groundDepth(BEES_YH - sy);
        d.tx = CAMERA.worldX(garden.pathX(sy), d.tz) + rand.range(-0.5, 0.5);
        d.th = rand.range(0.5, 1.5);
      } else {
        garden.flowerPoint(garden.pickPatch(true, rand), rand);
        d.tz = clamp(garden.pt.z + rand.range(-1, 1), 2.5, 16);
        d.tx = garden.pt.x + rand.range(-1, 1);
        d.th = garden.pt.h + rand.range(0.4, 1.6);
      }
      if (Math.hypot(d.tx - d.x, d.tz - d.z) > 2) return;
    }
  }

  #step(d: Dragonfly, dt: number): void {
    const garden = this.#garden;
    const rand = this.#random;
    d.age += dt;
    if (d.mode !== "run") {
      d.vx = 0;
      d.vz = 0;
      d.vh = 0;
      if (d.mode === "perch" && d.perch >= 0) {
        const fox = BEES_FOXGLOVES_ALL[d.perch];
        if (fox === undefined || garden.flowers < fox[3]) {
          // Thinned away under it: up and off.
          d.hold = 0;
        } else {
          // On the spike's tip, swaying with it.
          garden.bellPoint(d.perch, 1, 0);
          d.x = garden.pt.x;
          d.z = garden.pt.z;
          d.h = garden.pt.h + 0.02;
        }
      }
      d.hold -= dt;
      if (d.hold > 0) return;
      d.mode = "run";
      d.perch = -1;
      d.legs = 2 + rand.int(4);
      this.#runTo(d);
      return;
    }
    const pace = depthPace(d.z);
    const dist = chase(
      d,
      d.tx,
      d.tz,
      d.th,
      0.12,
      DRAGONFLY_SPEED * pace * garden.flit,
      1 - Math.exp(-dt / 0.06),
      dt,
    );
    const speed = Math.hypot(d.vx, d.vz);
    if (speed > 0.3) {
      d.hx = d.vx / speed;
      d.hz = d.vz / speed;
    }
    if (d.off) {
      if (garden.outside(d.x, d.z, d.h, 0.08)) d.active = false;
      return;
    }
    if (dist > 0.35) return;
    if (d.perch >= 0) {
      d.mode = "perch";
      d.hold = rand.range(4, 9);
      return;
    }
    d.legs -= 1;
    if (d.legs > 0) {
      // A sharp turn onto the next run.
      this.#runTo(d);
      return;
    }
    // A hover, or off to rest on a standing foxglove's tip (a hover where none stands).
    const perch = rand.next() < 0.55 ? -1 : garden.pickStanding(BEES_FOXGLOVES_ALL, rand);
    if (perch < 0) {
      d.mode = "hover";
      d.hold = rand.range(0.8, 2.5);
      return;
    }
    d.perch = perch;
    garden.bellPoint(d.perch, 1, 0);
    d.tx = garden.pt.x;
    d.tz = garden.pt.z;
    d.th = garden.pt.h + 0.02;
  }

  /** The body a line of cells along its heading as the camera sees it, the wings across it catching the light. */
  paint(p: Painter, alpha: number): void {
    const specks = p.specks;
    const h = specks.height;
    const w = specks.width;
    const at = p.at;
    const cell = (x: number, z: number): number => CAMERA.screenX(x, z) * h + 0.5 * w;
    const row = (lift: number, z: number): number => CAMERA.screenY(lift, z) * h;
    for (const d of this.list) {
      if (!d.active) continue;
      const z = p.project(d, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      const midX = cell(at.x, at.z);
      const midY = row(at.h, at.z);
      // The wings glint now and then in flight, and lie flat in the light at rest.
      const glint = d.mode !== "run" || Math.sin(TAU * 1.9 * d.age + d.phase) > 0.35;
      const length = (DRAGONFLY_LENGTH * h * CAMERA.focal) / z;
      if (length < 1.5) {
        if (glint) specks.plot(d.cx, d.cy + 1, BEES_CODE.dragonflyWing, depth);
        specks.plot(d.cx, d.cy, BEES_CODE.dragonfly, depth);
        continue;
      }
      if (glint) {
        // Across the thorax, a little ahead of its middle.
        const tx = at.x + d.hx * 0.012;
        const tz = at.z + d.hz * 0.012;
        const half = 0.5 * DRAGONFLY_SPAN;
        p.line(
          d.cx + Math.round(cell(tx - d.hz * half, tz + d.hx * half) - midX),
          d.cy + Math.round(row(at.h + 0.004, tz + d.hx * half) - midY),
          d.cx + Math.round(cell(tx + d.hz * half, tz - d.hx * half) - midX),
          d.cy + Math.round(row(at.h + 0.004, tz - d.hx * half) - midY),
          BEES_CODE.dragonflyWing,
          depth,
        );
      }
      // Head a little more than half its length ahead of the middle, the tail of the abdomen behind.
      p.line(
        d.cx + Math.round(cell(at.x - d.hx * 0.035, at.z - d.hz * 0.035) - midX),
        d.cy + Math.round(row(at.h, at.z - d.hz * 0.035) - midY),
        d.cx + Math.round(cell(at.x + d.hx * 0.04, at.z + d.hz * 0.04) - midX),
        d.cy + Math.round(row(at.h, at.z + d.hz * 0.04) - midY),
        BEES_CODE.dragonfly,
        depth,
      );
    }
  }
}
