import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { streetScene } from "./index.ts";
import { MAX_AGENTS, MAX_WALKERS, SHAPES, Z_REF } from "./sim.ts";

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
