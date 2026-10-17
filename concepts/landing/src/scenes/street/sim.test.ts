import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { streetScene } from "./index.ts";
import {
  CAM_H,
  CAM_X,
  FOCAL,
  KIND_BIKE,
  KIND_VAN,
  MAX_AGENTS,
  MAX_WALKERS,
  PITCH,
  PORTALS,
  SHAPES,
  Z_REF,
} from "./sim.ts";

/** Frames of 0.2 s: six of the sim's steps each, the most it takes in one frame. */
const FRAME = 0.2;
/** An agent that has moved less than this (m) since it last moved stands still. */
const STILL = 0.3;

/** Runs the street for `seconds` with these knobs, handing uSim0 (as the shader samples it) to
 *  `look` every `every` frames with the time. */
function run(
  knobs: Record<string, number>,
  seconds: number,
  every: number,
  look: (data: Float32Array, t: number) => void,
): void {
  const sim = new HeadlessSim(streetScene);
  const frames = Math.round(seconds / FRAME);
  for (let f = 1; f <= frames; f++) {
    sim.step({ dt: FRAME, knobs });
    if (f % every === 0) look(sim.upload(0).data as Float32Array, f * FRAME);
  }
}

/** How long the agent in each slot has stood still, and how many walkers have come since. */
class Watch {
  readonly #x = new Float64Array(MAX_AGENTS).fill(Number.NaN);
  readonly #z = new Float64Array(MAX_AGENTS).fill(Number.NaN);
  readonly #since = new Float64Array(MAX_AGENTS);
  readonly #seed = new Float64Array(MAX_AGENTS).fill(Number.NaN);
  #first = true;
  /** Walkers who have come into the street since the last look (none at the first). */
  arrived = 0;

  look(data: Float32Array, t: number): void {
    this.arrived = 0;
    for (let i = 0; i < MAX_AGENTS; i++) {
      const o = i * 4;
      const seed = data[MAX_AGENTS * 4 + o + 3] ?? 0;
      if (!data[o + 3]) {
        this.#seed[i] = Number.NaN;
        continue;
      }
      const x = data[o] ?? 0;
      const z = data[o + 1] ?? 0;
      // Someone new in the slot: its seed differs from the last one's.
      const fresh = seed !== this.#seed[i];
      if (fresh && !this.#first && i < MAX_WALKERS) this.arrived++;
      if (fresh || !(Math.hypot(x - (this.#x[i] ?? 0), z - (this.#z[i] ?? 0)) < STILL)) {
        this.#x[i] = x;
        this.#z[i] = z;
        this.#since[i] = t;
      }
      this.#seed[i] = seed;
    }
    this.#first = false;
  }

  /** Seconds the agent in slot i has stood still at time t (0 for an empty slot). */
  still(data: Float32Array, i: number, t: number): number {
    return data[i * 4 + 3] ? t - (this.#since[i] ?? t) : 0;
  }
}

/** A vehicle's box seen from above: centre (m), heading (rad), length and width (m). */
interface Box {
  x: number;
  z: number;
  h: number;
  length: number;
  width: number;
}

/** How deep two boxes overlap (m; 0 apart): the least overlap of their shadows on the four axes
 *  along and across each. */
function overlap(a: Box, b: Box): number {
  let least = Number.POSITIVE_INFINITY;
  for (const axis of [a.h, a.h + Math.PI / 2, b.h, b.h + Math.PI / 2]) {
    const ux = Math.cos(axis);
    const uz = Math.sin(axis);
    const reach = (box: Box): number =>
      (Math.abs(Math.cos(box.h) * ux + Math.sin(box.h) * uz) * box.length +
        Math.abs(-Math.sin(box.h) * ux + Math.cos(box.h) * uz) * box.width) /
      2;
    const apart = Math.abs((b.x - a.x) * ux + (b.z - a.z) * uz);
    least = Math.min(least, reach(a) + reach(b) - apart);
    if (least <= 0) return 0;
  }
  return least;
}

test("at the defaults nobody stands pinned for good and the crowd keeps coming, two hours on", () => {
  const watch = new Watch();
  let pinned = 0;
  let early = 0;
  let late = 0;
  run({}, 7200, 5, (data, t) => {
    watch.look(data, t);
    if (t <= 600) early += watch.arrived;
    if (t > 3600) late += watch.arrived;
    if (t < 600) return;
    // Waiting for the green man takes at most a cycle (80 s at the default): five minutes still is
    // a walker pinned against a pole, a wall or the crowd.
    let now = 0;
    for (let i = 0; i < MAX_WALKERS; i++) if (watch.still(data, i, t) > 300) now++;
    pinned = Math.max(pinned, now);
  });
  expect(pinned).toBeLessThanOrEqual(2);
  // Pinned walkers would count toward the crowd the knob asks for and keep newcomers away: in the
  // second hour people still arrive at least three quarters as fast as in the first ten minutes.
  expect(late / 3600).toBeGreaterThanOrEqual((0.75 * early) / 600);
}, 150_000);

/** Whether the street point (x, z) shows in a 16:9 frame from the window at rest. */
function inView(x: number, z: number): boolean {
  const depth = z * Math.cos(PITCH) + CAM_H * Math.sin(PITCH);
  const across = ((x - CAM_X) * FOCAL) / depth;
  const up = ((z * Math.sin(PITCH) - CAM_H * Math.cos(PITCH)) * FOCAL) / depth;
  return Math.abs(across) <= 8 / 9 && Math.abs(up) <= 0.5;
}

test("at a full crowd no walker vanishes in view but through a way out, twenty minutes on", () => {
  // Where each walker slot's walker was last seen (its seed tells one walker from the next).
  const seed = new Float64Array(MAX_WALKERS).fill(Number.NaN);
  const lastX = new Float64Array(MAX_WALKERS);
  const lastZ = new Float64Array(MAX_WALKERS);
  const gone: string[] = [];
  let left = 0;
  run({ crowd: 1 }, 1200, 1, (data, t) => {
    for (let i = 0; i < MAX_WALKERS; i++) {
      const o = i * 4;
      const alive = Boolean(data[o + 3]);
      const now = data[MAX_AGENTS * 4 + o + 3] ?? 0;
      const was = seed[i] ?? Number.NaN;
      if (!Number.isNaN(was) && (!alive || now !== was)) {
        left++;
        const x = lastX[i] ?? 0;
        const z = lastZ[i] ?? 0;
        // A way out: a portal (a frame edge, a door, the station stairs), within its spread and
        // a stride or two.
        const out = PORTALS.some(
          (portal) =>
            Math.hypot(x - portal.x, z - portal.z) <= Math.max(portal.sx, portal.sz) + 1.5,
        );
        if (inView(x, z) && !out)
          gone.push(`${t.toFixed(1)} s at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
      seed[i] = alive ? now : Number.NaN;
      lastX[i] = data[o] ?? 0;
      lastZ[i] = (data[o + 1] ?? 0) + Z_REF;
    }
  });
  // Walkers did come and go (about 2,100 in twenty minutes), and none was seen to vanish: one the
  // watchdog gives up on in view sets off for the nearest way out instead.
  expect(left).toBeGreaterThan(1000);
  expect(gone).toEqual([]);
}, 150_000);

test("with the school outing out often and traffic at its top, no vehicle stands for good and none overlaps another", () => {
  const cycle = 80;
  for (const seed of [0, 1, 2, 3]) {
    const watch = new Watch();
    let still = 0;
    let deepest = 0;
    run({ traffic: 1, "outing-amount": 1, signal: cycle, streetSeed: seed }, 1200, 2, (data, t) => {
      watch.look(data, t);
      const boxes: Box[] = [];
      for (let i = MAX_WALKERS; i < MAX_AGENTS; i++) {
        const o = i * 4;
        const shape = SHAPES[data[o + 3] ?? 0];
        if (!data[o + 3] || !shape) continue;
        still = Math.max(still, watch.still(data, i, t));
        boxes.push({
          x: data[o] ?? 0,
          z: (data[o + 1] ?? 0) + Z_REF,
          h: data[o + 2] ?? 0,
          length: shape.length,
          width: shape.width,
        });
      }
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const p = boxes[a];
          const q = boxes[b];
          if (!p || !q) continue;
          // Further apart than their half diagonals they cannot touch.
          const near = (Math.hypot(p.length, p.width) + Math.hypot(q.length, q.width)) / 2;
          if (Math.hypot(p.x - q.x, p.z - q.z) < near) deepest = Math.max(deepest, overlap(p, q));
        }
      }
    });
    // A red light holds a vehicle for most of a cycle; three cycles still is a jam that never clears.
    expect(still, `seed ${seed}: a vehicle stood still (s)`).toBeLessThanOrEqual(3 * cycle);
    expect(deepest, `seed ${seed}: two vehicles overlapped (m)`).toBeLessThanOrEqual(0.05);
  }
}, 150_000);

test("with the late delivery out often and everything at its top, no cyclist rides through a van", () => {
  const knobs = { crowd: 1, traffic: 1, "outing-amount": 1, delivery: 1, "delivery-amount": 1 };
  for (const seed of [0, 1, 2, 3]) {
    let parked = 0;
    let deepest = 0;
    run({ ...knobs, streetSeed: seed }, 600, 1, (data) => {
      const bikes: Box[] = [];
      const vans: Box[] = [];
      for (let i = MAX_WALKERS; i < MAX_AGENTS; i++) {
        const o = i * 4;
        const kind = data[o + 3] ?? 0;
        const shape = SHAPES[kind];
        if (!shape || (kind !== KIND_BIKE && kind !== KIND_VAN)) continue;
        // The delivery van's hazards (blinker 2) blink while it stands at the kerb.
        if (data[MAX_AGENTS * 4 + o + 1] === 2) parked++;
        (kind === KIND_BIKE ? bikes : vans).push({
          x: data[o] ?? 0,
          z: (data[o + 1] ?? 0) + Z_REF,
          h: data[o + 2] ?? 0,
          length: shape.length,
          width: shape.width,
        });
      }
      for (const bike of bikes)
        for (const van of vans) deepest = Math.max(deepest, overlap(bike, van));
    });
    // Deliveries came and went, so the cyclists met the van easing in, at the kerb and pulling out.
    expect(parked, `seed ${seed}: the delivery van never stood at the kerb`).toBeGreaterThan(0);
    expect(deepest, `seed ${seed}: a cyclist overlapped a van (m)`).toBe(0);
  }
}, 150_000);
