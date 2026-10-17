// The agents' cairns on the shore (knob `cairns`): an agent of the cast that presses at a site on the
// wet sand picks a pebble up there (a stone fallen from the cairn, or else one off the sand) and, at
// its next press, balances it on the cairn's top, or lays the first stone down; each site's stones are
// a small stack of rigid stones with friction (sims/stack.ts) that settles them or lets them fall.
// The sites lie across the view as far up the beach as only the bigger waves run (`SITES`), so a cairn
// stands through the small waves until a big one runs past it: then the water pushes the stones it
// covers (shader.ts's swash, mirrored in beach.ts) and the cairn topples, its stones lying round it on
// the sand for the agents to pick up again. A stone the sea carries far from its site is gone.
// Without agents none of it happens: the stones stand or lie where they are.
//
// Usage (shore/sim.ts, each frame; a principal is the agent it is by its index in `principals`):
//   const at: CairnFrame = { aspect, camX, tm, dt, period, size, stones };  // kept, rewritten
//   cairns.frame(frame.principals, at);
//   if (cairns.pack(data)) texture.upload(data);   // uSim1, laid out as CAIRN_ROW below
import { MAX_PRINCIPALS } from "../../principals.ts";
import { FixedStep } from "../../sims/clock.ts";
import { mulberry32 } from "../../sims/random.ts";
import { Stack, STACK_STEP } from "../../sims/stack.ts";
import type { PrincipalState, ScenePoint } from "../types.ts";
import { SHORE_BEACH, SHORE_FOCAL, swashAt, type Swash } from "./beach.ts";

/** The sites: across the beach (m), and how far up it from the still-water line (m). */
const SITES: readonly { readonly x: number; readonly e: number }[] = [
  { x: -2.8, e: 2.3 },
  { x: -0.9, e: 2.7 },
  { x: 1.0, e: 2.5 },
  { x: 2.9, e: 2.9 },
];
export const CAIRN_SITES = SITES.length;
/** Stones a site holds at most: its cairn and those fallen round it. */
export const CAIRN_STONES = 7;
/**
 * The upload (uSim1, rgba16f): a row per site, its first texel (x, z of the site, its stones, how wet
 * they are 0..1), then two a stone ((x from the site, height of its middle, turn, half width), (half
 * height, shade 0..1, 0, 0)), all in metres; then a row with a texel per principal, by its index in
 * uPrincipals, for the pebble it carries ((half width, half height, shade, 1), or zeros).
 */
export const CAIRN_ROW = 1 + 2 * CAIRN_STONES;

/** A press this near a site (m) works there; a stone the sea carries farther than STRAY is gone. */
const NEAR = 1.2;
const STRAY = 1.4;
/**
 * A stone lies loose on the sand while its bottom is this near the ground (m), unless it is the
 * base: the one nearest the site's middle, within BASE_NEAR.
 */
const LOOSE = 0.012;
const BASE_NEAR = 0.2;
/** A stone stands in the cairn, above its base, this near the site's middle (m). */
const COLUMN = 0.35;
/**
 * Stone sizes (m): a base's half width and half height, each stone above as a share of the one
 * under it, and the smallest.
 */
const BASE_HW = [0.12, 0.16] as const;
const BASE_HH = [0.05, 0.065] as const;
const SHRINK_HW = [0.66, 0.9] as const;
const SHRINK_HH = [0.72, 0.95] as const;
const SMALLEST_HW = 0.045;
const SMALLEST_HH = 0.022;
/** How true a stone is set down: across (a share of the narrower half width), turned (rad), dropped (m). */
const SET_ACROSS = 0.3;
const SET_TURN = 0.06;
const SET_DROP = 0.008;
/**
 * The surf: the push (m/s²) on a stone a metre of water run past it gives, counted up to PUSH_RUN;
 * the water's depth over the sand there (m) to start with and per metre run past; the backwash pulls
 * back, BACKWASH as hard.
 */
const PUSH = 16;
const PUSH_RUN = 1;
const DEPTH = 0.06;
const DEPTH_RUN = 0.2;
const BACKWASH = 0.6;
/** Seconds wet stones take to dry. */
const DRY = 8;
/** Most stack steps a frame (a stalled tab does not replay a minute). */
const MAX_STEPS = 24;

/** What the cairns take from each frame (shore/sim.ts rewrites one in place). */
export interface CairnFrame {
  /** The frame's width over its height, and the camera's step along the beach (m). */
  aspect: number;
  camX: number;
  /** The motion clock, and the seconds of it since the last frame. */
  tm: number;
  dt: number;
  /** The surf's knobs: the wave period (s) and size (0..1). */
  period: number;
  size: number;
  /** Stones a cairn is built to, before it counts as done (the knob). */
  stones: number;
}

interface Site {
  readonly x: number;
  readonly z: number;
  readonly stack: Stack;
  /** Each stone's shade, in the stack's order. */
  readonly shades: number[];
  /** Seconds since the water last ran over it. */
  dry: number;
  /** The surf's push this frame (m/s² along the beach), and the depth (m) it pushes under. */
  push: number;
  depth: number;
}

/** A pebble an agent carries. */
interface Held {
  on: boolean;
  hw: number;
  hh: number;
  shade: number;
}

const range = (r: () => number, [from, to]: readonly [number, number]): number =>
  from + (to - from) * r();

export class ShoreCairns {
  readonly #sites: readonly Site[];
  readonly #held: readonly Held[] = Array.from({ length: MAX_PRINCIPALS }, () => ({
    on: false,
    hw: 0,
    hh: 0,
    shade: 0,
  }));
  readonly #clock = new FixedStep(STACK_STEP, MAX_STEPS);
  readonly #random = mulberry32(0x6361_6972);
  readonly #swash: Swash = { over: 0, seed: 0, rising: false };
  readonly #interest: ScenePoint[] = [];
  readonly #points = Array.from({ length: CAIRN_SITES }, () => ({ x: 0, y: 0 }));
  /** Agents present last frame: a fresh site for each beyond the cairns under way. */
  #agents = 0;
  /** Stones a cairn is built to, as last set. */
  #target = CAIRN_STONES;
  /** A site's cairn, as #column last found it. */
  readonly #col = { base: -1, count: 0, top: -1, height: 0 };

  constructor() {
    this.#sites = SITES.map(({ x, e }) => ({
      x,
      z: SHORE_BEACH.line - e,
      stack: new Stack(CAIRN_STONES),
      shades: [],
      dry: Infinity,
      push: 0,
      depth: 0,
    }));
  }

  /**
   * A frame on: the agents' presses among `principals`, then the surf and the stones, as `at` says.
   */
  frame(principals: readonly PrincipalState[], at: Readonly<CairnFrame>): void {
    const { aspect, camX, tm, dt, period, size } = at;
    this.#target = Math.min(CAIRN_STONES, Math.max(1, Math.round(at.stones)));
    this.#agents = 0;
    for (let i = 0; i < MAX_PRINCIPALS; i++) {
      const hand = principals[i];
      const held = this.#held[i];
      if (held === undefined) continue;
      // An agent gone drops what it carried.
      if (hand === undefined || hand.kind !== "agent") {
        held.on = false;
        continue;
      }
      this.#agents++;
      if (!hand.inside || !hand.pressed) continue;
      const site = this.#siteAt(hand.x, hand.y, aspect, camX);
      if (site === undefined) continue;
      if (held.on) this.#place(site, held);
      else this.#pick(site, held, hand.x, hand.y, aspect, camX);
    }

    for (const site of this.#sites) {
      site.push = 0;
      site.depth = 0;
      if (site.stack.stones.length === 0) continue;
      swashAt(site.x, site.z, camX, tm, period, size, this.#swash);
      const { over, seed, rising } = this.#swash;
      if (over > 0) {
        site.dry = 0;
        // The run-up pushes one way along the beach (the wave's own slant), the backwash back.
        const way = (seed < 0.5 ? -1 : 1) * (rising ? 1 : -BACKWASH);
        site.push = PUSH * Math.min(over, PUSH_RUN) * way;
        site.depth = DEPTH + DEPTH_RUN * over;
      } else site.dry += dt;
    }

    for (let n = this.#clock.advance(dt); n > 0; n--)
      for (const site of this.#sites) {
        const stack = site.stack;
        for (let j = 0; site.push !== 0 && j < stack.stones.length; j++) {
          const under = (site.depth - stack.lift(j)) / (2 * (stack.stones[j]?.hh ?? 1));
          if (under > 0) stack.push(j, site.push * Math.min(1, under), 0);
        }
        stack.step(STACK_STEP);
      }

    // What the sea carries off is gone.
    for (const site of this.#sites) {
      const { stack, shades } = site;
      for (let j = stack.stones.length - 1; j >= 0; j--)
        if (Math.abs(stack.stones[j]?.x ?? 0) > STRAY) {
          stack.remove(j);
          shades.splice(j, 1);
        }
    }
  }

  /**
   * Where the agents go to work, in screen uv for a frame of `aspect` (the camera stepped camX): the
   * cairns under way (short of their height, or with stones fallen round them), and a fresh site for
   * each agent beyond them. A cairn standing done draws no one until the sea knocks it down.
   */
  interest(aspect: number, camX: number): readonly ScenePoint[] {
    const points = this.#interest;
    points.length = 0;
    let fresh = Math.max(1, this.#agents);
    for (const site of this.#sites)
      if (site.stack.stones.length > 0 && !this.#done(site)) {
        this.#point(site, aspect, camX);
        fresh--;
      }
    for (const site of this.#sites)
      if (fresh > 0 && site.stack.stones.length === 0) {
        this.#point(site, aspect, camX);
        fresh--;
      }
    return points;
  }

  /** The stones and the carried pebbles into `data` (CAIRN_ROW × (CAIRN_SITES + 1) texels); false when there are none. */
  pack(data: Float32Array): boolean {
    data.fill(0);
    let any = false;
    this.#sites.forEach((site, row) => {
      const stones = site.stack.stones;
      if (stones.length > 0) any = true;
      const at = row * CAIRN_ROW * 4;
      data[at] = site.x;
      data[at + 1] = site.z;
      data[at + 2] = stones.length;
      data[at + 3] = Math.exp(-site.dry / DRY);
      stones.forEach((stone, j) => {
        const o = at + 4 + j * 8;
        data[o] = stone.x;
        data[o + 1] = stone.y;
        data[o + 2] = stone.angle;
        data[o + 3] = stone.hw;
        data[o + 4] = stone.hh;
        data[o + 5] = site.shades[j] ?? 0.5;
      });
    });
    const carried = CAIRN_SITES * CAIRN_ROW * 4;
    this.#held.forEach((held, i) => {
      if (!held.on) return;
      any = true;
      data[carried + i * 4] = held.hw;
      data[carried + i * 4 + 1] = held.hh;
      data[carried + i * 4 + 2] = held.shade;
      data[carried + i * 4 + 3] = 1;
    });
    return any;
  }

  /** How many stones stand in the cairn at site `site` (its base and those resting above it). */
  standing(site: number): number {
    const s = this.#sites[site];
    if (s === undefined) return 0;
    this.#column(s);
    return this.#col.count;
  }

  /** The site whose foot lies within NEAR of the ground under screen point (u, v), if any. */
  #siteAt(u: number, v: number, aspect: number, camX: number): Site | undefined {
    const { horizon, eye } = SHORE_BEACH;
    const drop = horizon - v;
    if (!(drop > 1e-3)) return undefined;
    const z = (eye * SHORE_FOCAL) / drop;
    const x = camX + ((u - 0.5) * aspect * z) / SHORE_FOCAL;
    let best: Site | undefined;
    let nearest = NEAR;
    for (const site of this.#sites) {
      const d = Math.hypot(site.x - x, site.z - z);
      if (d < nearest) {
        nearest = d;
        best = site;
      }
    }
    return best;
  }

  /** A site's foot in screen uv, onto the interest list. */
  #point(site: Site, aspect: number, camX: number): void {
    const point = this.#points[this.#interest.length];
    if (point === undefined) return;
    point.x = 0.5 + (SHORE_FOCAL * (site.x - camX)) / (site.z * aspect);
    point.y = SHORE_BEACH.horizon - (SHORE_FOCAL * SHORE_BEACH.eye) / site.z;
    this.#interest.push(point);
  }

  /**
   * A site's cairn into #col: its base (the stone lying nearest its middle, within BASE_NEAR; -1 for
   * none), how many stand in it, the topmost (-1 for none) and the height of its top (m).
   */
  #column(site: Site): void {
    const stones = site.stack.stones;
    const col = this.#col;
    col.base = -1;
    let nearest = BASE_NEAR;
    for (let j = 0; j < stones.length; j++) {
      const across = Math.abs(stones[j]?.x ?? Infinity);
      if (site.stack.lift(j) < LOOSE && across < nearest) {
        nearest = across;
        col.base = j;
      }
    }
    const base = stones[col.base];
    col.count = base === undefined ? 0 : 1;
    col.top = col.base;
    col.height = base === undefined ? 0 : base.y + base.hh;
    if (base === undefined) return;
    for (let j = 0; j < stones.length; j++) {
      const stone = stones[j];
      if (stone === undefined || j === col.base) continue;
      if (site.stack.lift(j) < LOOSE || Math.abs(stone.x) > COLUMN) continue;
      col.count++;
      if (stone.y + stone.hh > col.height) {
        col.height = stone.y + stone.hh;
        col.top = j;
      }
    }
  }

  /** Built to its height, nothing lying round it. */
  #done(site: Site): boolean {
    this.#column(site);
    return this.#col.count >= this.#target && this.#col.count === site.stack.stones.length;
  }

  /** Pick a pebble up at a site: the loose stone nearest the press, else a fresh one off the sand. */
  #pick(site: Site, held: Held, u: number, v: number, aspect: number, camX: number): void {
    const stack = site.stack;
    this.#column(site);
    const { base, top } = this.#col;
    // The press, across the site (m), where the ground under it lies.
    const z = (SHORE_BEACH.eye * SHORE_FOCAL) / Math.max(SHORE_BEACH.horizon - v, 1e-3);
    const across = camX + ((u - 0.5) * aspect * z) / SHORE_FOCAL - site.x;
    let loose = -1;
    let nearest = Infinity;
    for (let j = 0; j < stack.stones.length; j++) {
      if (j === base || stack.lift(j) >= LOOSE) continue;
      const d = Math.abs((stack.stones[j]?.x ?? Infinity) - across);
      if (d < nearest) {
        nearest = d;
        loose = j;
      }
    }
    held.on = true;
    const stone = stack.stones[loose];
    if (stone !== undefined) {
      held.hw = stone.hw;
      held.hh = stone.hh;
      held.shade = site.shades[loose] ?? 0.5;
      stack.remove(loose);
      site.shades.splice(loose, 1);
      return;
    }
    // A fresh pebble, sized to go next on the cairn.
    const random = this.#random;
    const under = stack.stones[top];
    if (under === undefined) {
      held.hw = range(random, BASE_HW);
      held.hh = range(random, BASE_HH);
    } else {
      held.hw = Math.max(SMALLEST_HW, under.hw * range(random, SHRINK_HW));
      held.hh = Math.max(SMALLEST_HH, under.hh * range(random, SHRINK_HH));
    }
    held.shade = random();
  }

  /**
   * Set the carried pebble down at a site: balanced on its cairn's top, or laid as its base; at a
   * site that holds all it can, it is put back on the sand.
   */
  #place(site: Site, held: Held): void {
    const stack = site.stack;
    const random = this.#random;
    this.#column(site);
    const under = stack.stones[this.#col.top];
    let x: number;
    let y: number;
    let angle: number;
    if (under === undefined) {
      x = (random() * 2 - 1) * 0.03;
      y = held.hh + 0.002;
      angle = (random() * 2 - 1) * 0.03;
    } else {
      x = under.x + (random() * 2 - 1) * SET_ACROSS * Math.min(under.hw, held.hw);
      y = this.#col.height + held.hh + SET_DROP;
      angle = 0.5 * under.angle + (random() * 2 - 1) * SET_TURN;
    }
    held.on = false;
    if (stack.add(x, y, angle, held.hw, held.hh) >= 0) site.shades.push(held.shade);
  }
}
