// Butterflies: an erratic, lazy flutter above the flowers with bursts of wingbeats and glides,
// bobbing on every beat, now and then settling on a flower where the wings slowly open and close;
// from the golden hour and in the wet they settle with their wings shut (the roost). Fewer asked
// for, the rest flutter off over the nearest side of the frame. They draw from the garden's stream
// (Garden.random), which they share with the colony, as they always have.
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { ARRIVE, CAMERA, depthPace, type Flier, type Garden, settle, TAU } from "./garden.ts";
import { BEES_CODE } from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

export const BEES_MAX_BUTTERFLIES = 6;

const BUTTERFLY_SPAN = 0.05;
const BUTTERFLY_SPEED = 0.45;
const BUTTERFLY_GLIDE_SPEED = 0.2;

const BUTTERFLY_OPEN = [BEES_CODE.orange, BEES_CODE.white, BEES_CODE.blue] as const;
const BUTTERFLY_SHUT = [BEES_CODE.orangeDim, BEES_CODE.whiteDim, BEES_CODE.blueDim] as const;

type ButterflyMode = "fly" | "approach" | "settle";

interface Butterfly extends Flier {
  active: boolean;
  /** Leaving the frame (fewer asked for); inactive once out of it. */
  off: boolean;
  kind: number;
  mode: ButterflyMode;
  t: number;
  hold: number;
  vx: number;
  vz: number;
  vh: number;
  tx: number;
  tz: number;
  th: number;
  patch: number;
  flap: number;
  pace: number;
  glide: number;
  glideLeft: number;
  gliding: boolean;
  wayLeft: number;
  open: number;
  openStart: number;
  age: number;
  phase: number;
  quiet: number;
  /** Roosting (dusk, night, rain): it settles on a flower, wings shut, until it is light and dry. */
  roost: boolean;
}

function newButterfly(kind: number): Butterfly {
  return {
    active: false,
    off: false,
    kind,
    mode: "fly",
    t: 0,
    hold: 0,
    x: 0,
    z: 8,
    h: 1,
    vx: 0,
    vz: 0,
    vh: 0,
    tx: 0,
    tz: 8,
    th: 1,
    patch: 0,
    flap: 0,
    pace: 1,
    glide: 0,
    glideLeft: 2,
    gliding: false,
    wayLeft: 3,
    open: 1,
    openStart: 1,
    age: 0,
    phase: 0,
    quiet: 0,
    roost: false,
    cx: Number.NaN,
    cy: Number.NaN,
    px: 0,
    pz: 8,
    ph: 1,
  };
}

export class Butterflies {
  readonly list: Butterfly[] = Array.from({ length: BEES_MAX_BUTTERFLIES }, (_, i) =>
    newButterfly(i % 3),
  );
  /** How many are about (the `butterflies` knob). */
  count = 0;
  readonly #garden: Garden;

  constructor(garden: Garden) {
    this.#garden = garden;
  }

  /** As many as the knob asks for: newcomers flutter in over the edge of the frame, the rest flutter off. */
  wake(): void {
    const garden = this.#garden;
    const rand = garden.random;
    for (const [i, g] of this.list.entries()) {
      const want = i < this.count;
      if (want && !g.active) {
        g.active = true;
        g.off = false;
        const side = rand.next() < 0.5 ? -1 : 1;
        g.z = rand.range(4.5, 10);
        // Arriving, they come in over the very edge of the screen, not of the stage.
        const edge = garden.arriving ? 0.5 * garden.aspect + 0.04 : garden.stage + 0.03;
        g.x = side * edge * g.z;
        g.h = rand.range(0.6, 1.5);
        g.vx = -side * 0.3;
        g.vz = 0;
        g.vh = 0;
        g.mode = "fly";
        g.age = rand.next() * 20;
        g.phase = rand.next() * TAU;
        g.flap = rand.next() * TAU;
        g.pace = rand.range(0.9, 1.12);
        g.gliding = false;
        g.glideLeft = rand.range(1.5, 4);
        g.glide = 0;
        g.quiet = rand.range(2, 9);
        g.roost = false;
        g.cx = Number.NaN;
        settle(g);
        this.#waypoint(g, false);
      } else if (!want && g.active && !g.off) {
        this.#sendOff(g);
      }
    }
  }

  /** The very first frame (not an entrance): those about are in the air over the flowers. */
  scatter(): void {
    const garden = this.#garden;
    const rand = garden.random;
    for (const g of this.list) {
      if (!g.active) continue;
      garden.flowerPoint(garden.pickPatch(true));
      g.x = garden.pt.x;
      g.z = garden.pt.z;
      g.h = garden.pt.h + rand.range(0.3, 1.2);
      settle(g);
    }
  }

  /** The exit begins: every one bolts for the nearest edge. */
  recall(): void {
    const edge = 0.5 * this.#garden.aspect + 0.4;
    for (const g of this.list) {
      if (!g.active) continue;
      if (g.mode !== "fly") {
        g.mode = "fly";
        g.vh = 0.4;
      }
      g.gliding = false;
      g.glideLeft = 99;
      g.tz = clamp(g.z * 0.7, 3, 14);
      g.tx = (g.x < 0 ? -1 : 1) * edge * g.tz;
      g.th = g.h + 0.8;
    }
  }

  /** A new stage width: every X scales with it. */
  restage(ratio: number): void {
    for (const g of this.list) {
      g.x *= ratio;
      g.px *= ratio;
      g.tx *= ratio;
    }
  }

  step(dt: number): void {
    for (const g of this.list) {
      if (!g.active) continue;
      settle(g);
      this.#step(g, dt);
    }
  }

  /** Off over the nearest side of the frame (one fewer is asked for), flapping, out of any roost. */
  #sendOff(g: Butterfly): void {
    const garden = this.#garden;
    g.off = true;
    if (g.mode !== "fly") {
      g.mode = "fly";
      g.vh = 0.4;
    }
    g.gliding = false;
    g.glideLeft = 99;
    garden.edgePoint(g.x, g.z, g.h);
    g.tx = garden.pt.x;
    g.tz = garden.pt.z;
    g.th = garden.pt.h;
  }

  #waypoint(g: Butterfly, mayPerch: boolean): void {
    const garden = this.#garden;
    const rand = garden.random;
    g.wayLeft = rand.range(2.5, 5);
    if (mayPerch && g.quiet <= 0 && rand.next() < 0.45) {
      this.#perch(g);
      return;
    }
    // Wander over the flowers, a metre or so above them.
    garden.flowerPoint(garden.pickPatch(true));
    g.tx = garden.pt.x + rand.range(-0.8, 0.8);
    g.tz = clamp(garden.pt.z + rand.range(-0.8, 0.8), 3, 13);
    g.th = clamp(garden.pt.h + rand.range(0.3, 1.3), 0.3, 2.4);
  }

  /** Down onto a flower of a drift. */
  #perch(g: Butterfly): void {
    const garden = this.#garden;
    g.patch = garden.pickPatch(true);
    garden.flowerPoint(g.patch);
    g.tx = garden.pt.x;
    g.tz = garden.pt.z;
    g.th = garden.pt.h;
    g.mode = "approach";
    g.gliding = false;
    g.t = 0;
  }

  /** The roost begins (one in the air makes for a flower) or ends (one settled opens its wings and is off in a while). */
  #roostTurn(g: Butterfly): void {
    const garden = this.#garden;
    g.roost = garden.roost;
    if (g.roost) {
      if (g.mode === "fly" && !garden.leaving && !g.off) this.#perch(g);
    } else if (g.mode === "settle") {
      g.openStart = g.open;
      g.t = 0;
      g.hold = garden.random.range(1, 10);
    }
  }

  #step(g: Butterfly, dt: number): void {
    const garden = this.#garden;
    g.age += dt;
    g.t += dt;
    const rand = garden.random;
    if (g.roost !== garden.roost) this.#roostTurn(g);
    if (g.mode === "settle") {
      g.vx *= Math.exp(-dt * 6);
      g.vz *= Math.exp(-dt * 6);
      g.vh *= Math.exp(-dt * 6);
      if (g.roost && !garden.leaving) {
        // Roosting: the wings close and stay shut.
        g.open += (0.06 - g.open) * (1 - Math.exp(-dt / 0.8));
        return;
      }
      g.hold -= dt;
      // The wings sit open and close again, slowly, with a pause at the top.
      const slow = 0.5 + 0.5 * Math.cos((TAU * g.t) / 6.5 + g.phase);
      const toward = smoothstep(0, 1.2, g.t);
      g.open = lerp(g.openStart, 0.08 + 0.92 * smoothstep(0.05, 0.75, slow), toward);
      if (g.hold <= 0) {
        g.mode = "fly";
        g.quiet = rand.range(10, 24);
        g.glide = 0;
        g.gliding = false;
        g.glideLeft = rand.range(2, 4);
        g.vh = 0.4;
        this.#waypoint(g, false);
      }
      return;
    }
    g.glideLeft -= dt;
    if (g.glideLeft <= 0 && g.mode === "fly") {
      g.gliding = !g.gliding;
      g.glideLeft = g.gliding ? rand.range(0.9, 2.2) : rand.range(2.2, 5);
    }
    g.quiet -= dt;
    g.glide += ((g.gliding ? 1 : 0) - g.glide) * (1 - Math.exp(-dt / 0.35));
    g.flap += TAU * lerp(3.1, 1.1, g.glide) * g.pace * dt;
    const beat = Math.cos(g.flap);
    g.open = lerp(0.5 + 0.5 * beat, 0.82 + 0.12 * beat, g.glide);

    let dist = Math.hypot(g.tx - g.x, g.tz - g.z, g.th - g.h);
    let speed: number;
    if (g.mode === "fly") {
      g.wayLeft -= dt;
      if (!garden.leaving && !g.off && (dist < 0.5 || g.wayLeft <= 0)) this.#waypoint(g, true);
      speed = lerp(BUTTERFLY_SPEED, BUTTERFLY_GLIDE_SPEED, g.glide);
    } else {
      speed = 0.3 * smoothstep(0, 0.8, dist) + 0.08;
    }
    speed *= garden.flit;
    const pace = depthPace(g.z);
    const dx = g.tx - g.x;
    const dz = g.tz - g.z;
    const dh = g.th - g.h;
    dist = Math.hypot(dx, dz, dh) + 1e-6;
    const ux = dx / dist;
    const uz = dz / dist;
    const uh = dh / dist;
    const flat = Math.hypot(ux, uz) + 1e-6;
    const meander =
      (0.5 * Math.sin(TAU * 0.31 * g.age + g.phase) +
        0.3 * Math.sin(TAU * 0.83 * g.age + 2.1 * g.phase)) *
      (g.mode === "approach" ? smoothstep(0.2, 1.2, dist) : 1);
    const k = 1 - Math.exp(-dt / (garden.leaving ? 0.3 : 0.55));
    g.vx += (ux * speed * pace - (uz / flat) * meander * pace - g.vx) * k;
    g.vz += (uz * speed * pace + (ux / flat) * meander * pace - g.vz) * k;
    g.vh += (uh * speed * pace - 0.1 * g.glide - g.vh) * k;
    // Every downstroke lifts the butterfly and every upstroke lets it fall: the bobbing flight.
    const bob = -0.8 * pace * Math.sin(g.flap) * (1 - g.glide);
    g.x += g.vx * dt;
    g.z = clamp(g.z + g.vz * dt, 2.8, 14);
    g.h = Math.max(0.2, g.h + (g.vh + bob) * dt);
    if (g.off) {
      if (garden.outside(g.x, g.z, g.h, 0.08)) g.active = false;
      return;
    }
    if (g.mode === "approach" && dist < ARRIVE + 0.05) {
      g.mode = "settle";
      g.t = 0;
      g.hold = rand.range(8, 15);
      g.openStart = g.open;
      g.phase = rand.next() * TAU;
    }
  }

  paint(p: Painter, alpha: number): void {
    const specks = p.specks;
    const h = specks.height;
    const day = this.#garden.day;
    for (const g of this.list) {
      if (!g.active) continue;
      const z = p.project(g, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      if (g.roost && g.mode === "settle" && day < 0.2) {
        // Roosting in the dark: wings shut, a dark shape on the flower.
        specks.plot(g.cx, g.cy, BEES_CODE.butterflyBody, depth);
        continue;
      }
      const open = BUTTERFLY_OPEN[g.kind] ?? BEES_CODE.orange;
      const shut = BUTTERFLY_SHUT[g.kind] ?? BEES_CODE.orangeDim;
      // The wingbeat is the size of the speck: its half span in cells decides how many cells each wing is.
      const half = (0.5 * (BUTTERFLY_SPAN * h) * CAMERA.focal) / z;
      if (half < 0.75) {
        specks.plot(g.cx, g.cy, g.open > 0.45 ? open : shut, depth);
      } else if (half < 1.5) {
        if (g.open > 0.62) {
          specks.plot(g.cx - 1, g.cy, open, depth);
          specks.plot(g.cx + 1, g.cy, open, depth);
          specks.plot(g.cx, g.cy, BEES_CODE.butterflyBody, depth);
        } else {
          specks.plot(g.cx, g.cy, g.open > 0.3 ? open : shut, depth);
        }
      } else if (half < 2.5) {
        if (g.open > 0.62) {
          specks.block(g.cx - 2, g.cy, 2, 1, open, depth);
          specks.block(g.cx + 1, g.cy, 2, 1, open, depth);
          specks.plot(g.cx, g.cy, BEES_CODE.butterflyBody, depth);
        } else if (g.open > 0.3) {
          specks.plot(g.cx - 1, g.cy, open, depth);
          specks.plot(g.cx + 1, g.cy, open, depth);
          specks.plot(g.cx, g.cy, BEES_CODE.butterflyBody, depth);
        } else {
          specks.block(g.cx, g.cy, 1, 2, shut, depth);
        }
      } else if (g.open > 0.62) {
        specks.block(g.cx - 2, g.cy, 2, 2, open, depth);
        specks.block(g.cx + 1, g.cy, 2, 2, open, depth);
        specks.block(g.cx, g.cy, 1, 2, BEES_CODE.butterflyBody, depth);
      } else if (g.open > 0.3) {
        specks.block(g.cx - 1, g.cy, 1, 2, open, depth);
        specks.block(g.cx + 1, g.cy, 1, 2, open, depth);
        specks.block(g.cx, g.cy, 1, 2, BEES_CODE.butterflyBody, depth);
      } else {
        specks.block(g.cx, g.cy, 1, 2, shut, depth);
      }
    }
  }
}
