// The murmuration: a few thousand starlings flown on the CPU, splatted into a density field the
// shader inks as the flock.
//
// Model, after StarDisplay (Hildenbrandt, Carere & Hemelrijk 2010, "Self-organized aerial displays
// of thousands of starlings: a model", Behavioral Ecology 21):
// - Topological interaction: each bird heeds its seven nearest neighbours, however far they are
//   (Ballerini et al. 2008, PNAS 105), found through a uniform-grid spatial hash rebuilt each step
//   with a counting sort, so a step costs O(N), never O(N²).
// - Separation, alignment, and a cohesion weighted by how peripheral a bird is (the mean of unit
//   vectors to its neighbours: ~0 inside the flock, ~1 at its rim), which gives the sharp edges of
//   real murmurations; speed held near a cruise speed between a minimum and a maximum.
// - Birds steer by turning, with inertia: the turn rate relaxes toward the steering demand and is
//   coupled to the neighbours' turn rates, after the inertial spin model (Attanasi et al. 2014,
//   "Information transfer and behavioural inertia in starling flocks", Nature Physics 10). Turns
//   therefore travel through the flock as waves instead of dying out on the spot.
// - A soft attraction to a roost point that wanders slowly keeps the flock in frame and makes it
//   sweep across the sky; a slow breathing of the spacing and a gentle large-scale steering field
//   fold and stretch it.
// - Agitation waves (Procaccini et al. 2011, "Propagating waves in starling flocks under
//   predation", Animal Behaviour 82): an excitable medium on the neighbour graph. A startled bird
//   rolls (shows more wing, so it reads darker) and startles its neighbours, then stays refractory
//   for a while, so a dark band runs out across the flock and does not echo back.
//
// Time runs in fixed steps of STEP seconds of simulated time, so the flight depends only on the seed,
// the knobs and simulated time, not on the frame rate; positions are interpolated between the last
// two steps for drawing. Every array is allocated up front for the largest flock (the spatial hash
// and the density field only grow on resize or a knob change), so a frame allocates nothing.
//
// Textures:
//   uSim0  rg16f, about half the cell resolution: R birds per DENSITY_UNIT² of sky (a short
//          exponential trail smooths their motion), G the same weighted by how hard the birds roll.
//   uSim1  rgba16f 3×1, nearest: texel 0 falcon (uv xy, heading cos, sin); texel 1 falcon (shown,
//          wings open 0..1, wingbeat sin, 0); texel 2 Manifold M (strength 0..1, centre uv xy, height
//          in screen heights).
import type { ParamDef } from "../../params.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** The flock sizes on offer (the `birds` choice). */
export const FLOCK_SIZES = [1500, 3000, 5000] as const;
const MAX_BIRDS = Math.max(...FLOCK_SIZES);
/** Fixed seed: the flock is the same every time it is grown with the same size. */
const SEED = 0x5ca1ab1e;

/** Simulated seconds per step; frames run as many whole steps as their (motion-scaled) time covers. */
const STEP = 1 / 60;
/** A long hitch drops time instead of catching up step by step. */
const MAX_STEPS = 4;
/** Steps flown before the first frame, so even a still frame shows a settled flock. */
const PREWARM_STEPS = 60;

/** Topological range: seven nearest neighbours (Ballerini et al. 2008). */
const NEIGHBOURS = 7;
/** Sky area (screen heights²) a flock of any size settles into: loose at cohesion 0, tight at 1. */
const LOOSE_AREA = 0.2;
const TIGHT_AREA = 0.07;
/** Hash cell side in bird spacings; the 3×3 cells searched always cover one cell side around a bird. */
const CELL_SPACINGS = 2.6;
/** Separation reach in bird spacings. */
const SEPARATION_SPACINGS = 1.15;
/** The hash covers the frame plus this margin (heights) on every side; birds beyond share edge cells. */
const GRID_MARGIN = 0.5;

/** Cruise speed in screen heights per second at speed 0 and 1; limits as multiples of it. */
const CRUISE_SLOW = 0.07;
const CRUISE_FAST = 0.21;
const SPEED_MIN = 0.55;
const SPEED_MAX = 1.7;
const SPEED_FLEE = 2.5;

// Steering gains: each is a turn rate (rad/s) per unit of its steering vector.
const ALIGN = 5.5;
const COHESION_LOOSE = 1;
const COHESION_TIGHT = 3.2;
const SEPARATE = 9;
/** Roost pull per screen height away, and the extra pull beyond ROOST_REACH. */
const ROOST = 1.6;
const ROOST_REACH = 0.42;
const ROOST_FAR = 6;
/** Stragglers with fewer than seven birds in sight head for the flock's centre. */
const REJOIN = 1.2;
/** Soft walls: the skyline below, the frame's other edges. */
const FLOOR = 0.22;
const CEILING = 0.95;
const SIDE = 0.06;
const WALL = 30;
/** Large-scale steering field, stronger with chaos: folds and stretches the flock. */
const FLOW_CALM = 0.2;
const FLOW_CHAOS = 0.6;
/** Each bird's own smooth wander (rad/s at chaos 1). */
const WANDER = 1;

/** Turn-rate inertia (s), coupling to the neighbours' turn rates (1/s), and the turn-rate limit. */
const TURN_INERTIA = 0.18;
const SPIN_COUPLING = 4;
const TURN_MAX = 4;
const TURN_MAX_PANIC = 8;
/** Speed: relaxation to cruise, matching the neighbours (1/s), and how separation/cohesion brake or push. */
const SPEED_RELAX = 1.5;
const SPEED_MATCH = 2;
const SEPARATE_SPEED = 3;
const COHESION_SPEED = 1;
/** Turn rate (rad/s) at which a bird reads fully rolled, and the roll's smoothing time (s). */
const ROLL_RATE = 2.2;
const ROLL_BLEND = 1 - Math.exp(-STEP / 0.1);

/** The breathing of the spacing: amplitudes and periods (s) of two slow swells. */
const BREATH_A = 0.16;
const BREATH_A_PERIOD = 23;
const BREATH_B = 0.07;
const BREATH_B_PERIOD = 9.1;

// Agitation waves (excitable medium on the neighbour graph).
/** Startle charge gained per second per unit of the most startled neighbour's excitation above FIRE. */
const STARTLE_RISE = 70;
const STARTLE_FIRE = 0.5;
const STARTLE_DECAY = Math.exp(-STEP / 0.25);
const REFRACTORY_DECAY = Math.exp(-STEP / 0.8);
/** Below this refractory level a bird can be startled again (~1.5 s after it fired). */
const REFRACTORY_READY = 0.15;
/** A startled bird's roll away from the wave's origin (rad/s) and its burst of speed. */
const STARTLE_TURN = 3;
const STARTLE_SPEED = 0.4;
/** Spontaneous waves per second at chaos 1, with no falcon in sight. */
const STARTLE_SPONTANEOUS = 0.04;

// The falcon.
const FALCON_STOOP = 0.75;
const FALCON_CRUISE = 0.5;
/** Pursuit and pull-out turn rates (rad/s). */
const FALCON_TURN = 2.2;
const FALCON_CLIMB = 1.6;
/** Birds flee within FEAR (heights); those within STARTLE start an agitation wave. */
const FEAR_RADIUS = 0.11;
const STARTLE_RADIUS = 0.045;
const FLEE = 40;
const FLEE_SPEED = 6;
const PANIC_SPEED = 1.2;
/** Wingbeats per second once the falcon pulls out of its dive. */
const FALCON_WINGBEAT = 4.5;
/** Seconds between attacks at frequency 0 and 1 (randomised ±40%). */
const ATTACK_RARE = 75;
const ATTACK_OFTEN = 15;

// The Manifold M: the flock streams along a racetrack around the M's strokes.
/** The mark's height in screen heights. */
const MARK_SIZE = 0.38;
/** Seconds: gathered by GATHER, released from HOLD, over at END. */
const MARK_GATHER = 1.8;
const MARK_HOLD = 5.6;
const MARK_END = 6.8;
/** Pull toward a bird's point on the track (rad/s per height), and along the track's direction. */
const MARK_PULL = 16;
const MARK_ALONG = 1.2;
/** How hard a bird speeds up for a point ahead of it (1/s), and the track's speed in cruise speeds. */
const MARK_CATCH = 2.5;
const MARK_STREAM = 0.45;
/** Seconds between formations at frequency 0 and 1, and the delay after switching it on. */
const MARK_RARE = 150;
const MARK_OFTEN = 40;
const MARK_FIRST = 4;
/** Columns for the left-to-right ordering that hands out places on the M. */
const MARK_BINS = 128;
/** Lanes either side of a stroke, in mark units: out along one side, back along the other. */
const MARK_LANE = 0.06;

/** Density unit: a texel's R counts birds per this square of sky (screen heights). */
const DENSITY_UNIT = 0.0065;
/** Exponential trail of the density field (s): softens the specks' motion into short streaks. */
const TRAIL = 0.03;

/** The Manifold M in mark units, as in shaders/common.ts: x in [-0.47, 0.47], y in [-0.5, 0.5]. */
const MARK_X = [-0.47, -0.47, 0, 0.47, 0.47];
const MARK_Y = [-0.5, 0.5, -0.08, 0.5, -0.5];

/**
 * The racetrack the birds stream along while they draw the M: up the strokes on one side and back
 * down on the other, each lane offset to the right of its direction of travel so the two streams
 * never meet head-on. Six floats per segment: start xy, end xy, arclength at its start, length.
 */
const MARK_TRACK = (() => {
  const route = [0, 1, 2, 3, 4, 3, 2, 1, 0];
  const track = new Float32Array((route.length - 1) * 6);
  let along = 0;
  for (let k = 0; k + 1 < route.length; k++) {
    const from = route[k] ?? 0;
    const to = route[k + 1] ?? 0;
    const ax = MARK_X[from] ?? 0;
    const ay = MARK_Y[from] ?? 0;
    const bx = MARK_X[to] ?? 0;
    const by = MARK_Y[to] ?? 0;
    const length = Math.hypot(bx - ax, by - ay);
    const rx = ((by - ay) / length) * MARK_LANE;
    const ry = (-(bx - ax) / length) * MARK_LANE;
    track.set([ax + rx, ay + ry, bx + rx, by + ry, along, length], k * 6);
    along += length;
  }
  return track;
})();
const MARK_TRACK_LENGTH = (MARK_TRACK[MARK_TRACK.length - 2] ?? 0) + (MARK_TRACK[MARK_TRACK.length - 1] ?? 0);
const MARK_OUTWARD_LENGTH = MARK_TRACK_LENGTH / 2;

type KnobKey = "birds" | "cohesion" | "chaos" | "speed" | "predator" | "wind" | "mark";

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** mulberry32: a small seeded generator, so the same seed always grows the same flock. */
class Random {
  #state = 0;

  seed(seed: number): void {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

class FlockSim implements SceneSim {
  readonly #density: DataTexture;
  readonly #state: DataTexture;
  readonly #stateData = new Float32Array(12);
  readonly #knobIndex: Readonly<Record<KnobKey, number>>;
  readonly #knob: Record<KnobKey, number> = { birds: 3000, cohesion: 0.55, chaos: 0.35, speed: 0.5, predator: 0, wind: 0, mark: 0 };
  readonly #random = new Random();

  // Birds, double-buffered: a step reads the current arrays and writes the next ones, then swaps.
  #x = new Float32Array(MAX_BIRDS);
  #y = new Float32Array(MAX_BIRDS);
  #heading = new Float32Array(MAX_BIRDS);
  #hx = new Float32Array(MAX_BIRDS);
  #hy = new Float32Array(MAX_BIRDS);
  #speed = new Float32Array(MAX_BIRDS);
  #turn = new Float32Array(MAX_BIRDS);
  #startle = new Float32Array(MAX_BIRDS);
  #refractory = new Float32Array(MAX_BIRDS);
  #roll = new Float32Array(MAX_BIRDS);
  #x2 = new Float32Array(MAX_BIRDS);
  #y2 = new Float32Array(MAX_BIRDS);
  #heading2 = new Float32Array(MAX_BIRDS);
  #hx2 = new Float32Array(MAX_BIRDS);
  #hy2 = new Float32Array(MAX_BIRDS);
  #speed2 = new Float32Array(MAX_BIRDS);
  #turn2 = new Float32Array(MAX_BIRDS);
  #startle2 = new Float32Array(MAX_BIRDS);
  #refractory2 = new Float32Array(MAX_BIRDS);
  #roll2 = new Float32Array(MAX_BIRDS);
  // Fixed per bird.
  readonly #weight = new Float32Array(MAX_BIRDS);
  readonly #pace = new Float32Array(MAX_BIRDS);
  readonly #phaseA = new Float32Array(MAX_BIRDS);
  readonly #phaseB = new Float32Array(MAX_BIRDS);
  readonly #rateA = new Float32Array(MAX_BIRDS);
  readonly #rateB = new Float32Array(MAX_BIRDS);
  /** Where on the M's racetrack a bird streams, in mark units of arclength. */
  readonly #markPlace = new Float32Array(MAX_BIRDS);
  #n = 0;

  // Spatial hash: birds sorted by cell (counting sort); cell c holds order[start[c] .. start[c + 1]).
  #cellStart = new Int32Array(1);
  #cellCursor = new Int32Array(1);
  readonly #cellOf = new Int32Array(MAX_BIRDS);
  readonly #order = new Int32Array(MAX_BIRDS);
  #gridW = 1;
  #gridH = 1;
  #cell = 1;
  readonly #nearD = new Float32Array(NEIGHBOURS);
  readonly #nearI = new Int32Array(NEIGHBOURS);
  readonly #binStart = new Int32Array(MARK_BINS + 1);
  readonly #binCursor = new Int32Array(MARK_BINS);
  readonly #trackPoint = new Float32Array(4);

  // Density field (rg, rows bottom to top).
  #field = new Float32Array(2);
  #fieldW = 0;
  #fieldH = 0;

  #aspect = 16 / 9;
  #time = 0;
  #pending = 0;
  #dirty = true;
  #centreX = 0;
  #centreY = 0;
  #roostX = 0;
  #roostY = 0;
  #waveX = 0;
  #waveY = 0;

  #primed = false;
  #seenAttack = 0;
  #seenMark = 0;
  #attackNow = false;
  #markNow = false;

  #falcon = false;
  #falconX = 0;
  #falconY = 0;
  #falconPrevX = 0;
  #falconPrevY = 0;
  #falconVX = 0;
  #falconVY = 0;
  #falconAge = 0;
  #falconStoop = false;
  #falconPrey = 0;
  #wingOpen = 0;
  #wingbeat = 0;
  #nextAttack = Number.POSITIVE_INFINITY;

  #mark = false;
  #markAge = 0;
  #markRun = 0;
  #markX = 0;
  #markY = 0;
  #markStrength = 0;
  #nextMark = Number.POSITIVE_INFINITY;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const index = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new Error(`flock: the scene has no '${key}' knob`);
      return at;
    };
    this.#knobIndex = { birds: index("birds"), cohesion: index("cohesion"), chaos: index("chaos"), speed: index("speed"), predator: index("predator"), wind: index("wind"), mark: index("mark") };
    this.#density = new DataTexture(gl, { width: 1, height: 1, format: "rg16f" });
    this.#state = new DataTexture(gl, { width: 3, height: 1, format: "rgba16f", filter: "nearest" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const values = frame.values;
    const index = this.#knobIndex;
    const knob = this.#knob;
    knob.birds = values[index.birds] ?? knob.birds;
    knob.cohesion = values[index.cohesion] ?? knob.cohesion;
    knob.chaos = values[index.chaos] ?? knob.chaos;
    knob.speed = values[index.speed] ?? knob.speed;
    knob.predator = values[index.predator] ?? knob.predator;
    knob.wind = values[index.wind] ?? knob.wind;
    knob.mark = values[index.mark] ?? knob.mark;
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    const n = Math.min(MAX_BIRDS, Math.max(1, Math.round(knob.birds)));
    if (n !== this.#n) this.#reset(n);
    this.#fitField(frame.width, frame.height);
    this.#watchTriggers(frame.triggers);

    // Motion scales the flight; an event fired with "now" plays even while motion is 0.
    const busy = this.#falcon || this.#mark || this.#attackNow || this.#markNow;
    const advance = Math.max(0, frame.dt) * Math.max(frame.motion, busy ? 1 : 0);
    this.#pending = Math.min(this.#pending + advance, MAX_STEPS * STEP);
    while (this.#pending >= STEP) {
      this.#step();
      this.#pending -= STEP;
    }
    if (advance > 0 || this.#dirty) {
      this.#paint(this.#dirty ? 0 : Math.exp(-advance / TRAIL), this.#pending / STEP);
      this.#density.upload(this.#field);
      this.#state.upload(this.#stateData);
      this.#dirty = false;
    }
    return [this.#density.texture, this.#state.texture];
  }

  dispose(): void {
    this.#density.dispose();
    this.#state.dispose();
  }

  /** A "now" button stamps its slot with the scene clock: any change since the last frame fires. */
  #watchTriggers(triggers: readonly number[]): void {
    const attack = triggers[0] ?? -1e4;
    const mark = triggers[1] ?? -1e4;
    if (this.#primed) {
      if (attack !== this.#seenAttack && attack > -1e3) this.#attackNow = true;
      if (mark !== this.#seenMark && mark > -1e3) this.#markNow = true;
    }
    this.#primed = true;
    this.#seenAttack = attack;
    this.#seenMark = mark;
  }

  #fitField(width: number, height: number): void {
    const w = Math.max(4, Math.round(width * 0.5));
    const h = Math.max(4, Math.round(height * 0.5));
    if (w === this.#fieldW && h === this.#fieldH) return;
    this.#fieldW = w;
    this.#fieldH = h;
    this.#field = new Float32Array(w * h * 2);
    this.#density.resize(w, h);
    this.#dirty = true;
  }

  /** Grow a fresh flock of n birds: an elongated cloud around the roost, flying roughly together. */
  #reset(n: number): void {
    const random = this.#random;
    random.seed(SEED + n);
    this.#n = n;
    this.#time = 0;
    this.#pending = 0;
    this.#falcon = false;
    this.#mark = false;
    this.#markStrength = 0;
    this.#attackNow = false;
    this.#markNow = false;
    this.#nextAttack = Number.POSITIVE_INFINITY;
    this.#nextMark = Number.POSITIVE_INFINITY;
    this.#roost(0);
    const cruise = CRUISE_SLOW + (CRUISE_FAST - CRUISE_SLOW) * this.#knob.speed;
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(random.next());
      const a = random.next() * Math.PI * 2;
      const dx = Math.cos(a) * r * 0.24;
      const dy = Math.sin(a) * r * 0.09 + dx * 0.25;
      const heading = 0.15 + 0.5 * Math.sin(dx * 6) + (random.next() - 0.5) * 0.3;
      this.#x[i] = this.#roostX + dx;
      this.#y[i] = this.#roostY + dy;
      this.#heading[i] = heading;
      this.#hx[i] = Math.cos(heading);
      this.#hy[i] = Math.sin(heading);
      this.#pace[i] = 1 + 0.08 * (random.next() * 2 - 1);
      this.#speed[i] = cruise * (this.#pace[i] ?? 1);
      this.#turn[i] = 0;
      this.#startle[i] = 0;
      this.#refractory[i] = 0;
      this.#roll[i] = 0;
      // Nearer birds (heavier ink) and farther ones: a murmuration is a deep cloud seen flat.
      this.#weight[i] = 0.55 + 0.9 * random.next();
      this.#phaseA[i] = random.next() * Math.PI * 2;
      this.#phaseB[i] = random.next() * Math.PI * 2;
      this.#rateA[i] = 0.6 + 1.2 * random.next();
      this.#rateB[i] = 0.25 + 0.5 * random.next();
    }
    this.#centreX = this.#roostX;
    this.#centreY = this.#roostY;
    for (let k = 0; k < PREWARM_STEPS; k++) this.#step();
    this.#x2.set(this.#x);
    this.#y2.set(this.#y);
    this.#dirty = true;
  }

  /** The roost point the flock circles, wandering slowly across the sky and pushed downwind. */
  #roost(t: number): void {
    const a = this.#aspect;
    const x = a * (0.5 + 0.2 * Math.sin(0.043 * t + 1.1) + 0.06 * Math.sin(0.131 * t + 4)) + this.#knob.wind * 0.15 * a;
    this.#roostX = Math.min(a * 0.72, Math.max(a * 0.28, x));
    this.#roostY = 0.58 + 0.09 * Math.sin(0.061 * t + 2.3) + 0.04 * Math.sin(0.17 * t + 0.4);
  }

  /** Rebuild the spatial hash for cells of side `cell` (screen heights). */
  #buildGrid(cell: number): void {
    const n = this.#n;
    const w = Math.max(1, Math.ceil((this.#aspect + 2 * GRID_MARGIN) / cell));
    const h = Math.max(1, Math.ceil((1 + 2 * GRID_MARGIN) / cell));
    const cells = w * h;
    if (this.#cellStart.length < cells + 1) {
      this.#cellStart = new Int32Array(cells + 1);
      this.#cellCursor = new Int32Array(cells);
    }
    this.#gridW = w;
    this.#gridH = h;
    this.#cell = cell;
    const start = this.#cellStart;
    const cursor = this.#cellCursor;
    const cellOf = this.#cellOf;
    const order = this.#order;
    const x = this.#x;
    const y = this.#y;
    start.fill(0, 0, cells + 1);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(w - 1, Math.max(0, Math.floor(((x[i] ?? 0) + GRID_MARGIN) / cell)));
      const cy = Math.min(h - 1, Math.max(0, Math.floor(((y[i] ?? 0) + GRID_MARGIN) / cell)));
      const c = cy * w + cx;
      cellOf[i] = c;
      start[c + 1] = (start[c + 1] ?? 0) + 1;
    }
    for (let c = 1; c <= cells; c++) start[c] = (start[c] ?? 0) + (start[c - 1] ?? 0);
    for (let c = 0; c < cells; c++) cursor[c] = start[c] ?? 0;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i] ?? 0;
      const slot = cursor[c] ?? 0;
      order[slot] = i;
      cursor[c] = slot + 1;
    }
  }

  /**
   * Find bird i's nearest neighbours within one cell side; fills #nearI/#nearD (squared distances)
   * nearest first and returns how many were found (up to NEIGHBOURS).
   */
  #neighbours(i: number): number {
    const x = this.#x;
    const y = this.#y;
    const start = this.#cellStart;
    const order = this.#order;
    const nearD = this.#nearD;
    const nearI = this.#nearI;
    const w = this.#gridW;
    const h = this.#gridH;
    const reach = this.#cell * this.#cell;
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    const c = this.#cellOf[i] ?? 0;
    const cx = c % w;
    const cy = (c - cx) / w;
    let found = 0;
    let worst = reach;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(h - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(w - 1, cx + 1); gx++) {
        const cellIndex = gy * w + gx;
        const end = start[cellIndex + 1] ?? 0;
        for (let k = start[cellIndex] ?? 0; k < end; k++) {
          const j = order[k] ?? 0;
          if (j === i) continue;
          const dx = (x[j] ?? 0) - xi;
          const dy = (y[j] ?? 0) - yi;
          const d2 = dx * dx + dy * dy;
          if (d2 >= worst) continue;
          // Insertion into the short sorted list, dropping the farthest once it is full.
          let slot = found < NEIGHBOURS ? found++ : NEIGHBOURS - 1;
          while (slot > 0 && (nearD[slot - 1] ?? 0) > d2) {
            nearD[slot] = nearD[slot - 1] ?? 0;
            nearI[slot] = nearI[slot - 1] ?? 0;
            slot--;
          }
          nearD[slot] = d2;
          nearI[slot] = j;
          if (found === NEIGHBOURS) worst = nearD[NEIGHBOURS - 1] ?? reach;
        }
      }
    }
    return found;
  }

  /** One fixed step of simulated time. */
  #step(): void {
    const knob = this.#knob;
    const n = this.#n;
    const aspect = this.#aspect;
    this.#time += STEP;
    const t = this.#time;
    this.#roost(t);
    this.#events(t);

    const chaos = knob.chaos;
    const cohesionKnob = knob.cohesion;
    const cruise = CRUISE_SLOW + (CRUISE_FAST - CRUISE_SLOW) * knob.speed;
    const spacing = Math.sqrt((LOOSE_AREA + (TIGHT_AREA - LOOSE_AREA) * cohesionKnob) / n);
    this.#buildGrid(spacing * CELL_SPACINGS);
    // The flock breathes: its spacing swells and settles over tens of seconds.
    const breath = 1 + BREATH_A * Math.sin((t / BREATH_A_PERIOD) * Math.PI * 2) + BREATH_B * Math.sin((t / BREATH_B_PERIOD) * Math.PI * 2 + 1.7);
    const separation = spacing * SEPARATION_SPACINGS * breath;
    const align = ALIGN - 2.5 * chaos;
    const cohesion = COHESION_LOOSE + (COHESION_TIGHT - COHESION_LOOSE) * cohesionKnob;
    const flow = FLOW_CALM + FLOW_CHAOS * chaos;
    const wander = WANDER * chaos;
    const drift = knob.wind * 0.04;
    // The roost holds the flock to an ellipse: wider frames give it more room to sweep sideways.
    const roostX = ROOST * Math.min(2.5, Math.max(0.55, 1 / aspect));
    const roostY = ROOST * 2.2;

    // The M: everything else gives way to the pull toward each bird's place on the track.
    const mark = this.#markStrength;
    const free = 1 - mark;
    const markStream = MARK_STREAM * cruise;

    const falcon = this.#falcon;
    const fx = this.#falconX;
    const fy = this.#falconY;
    const waveX = this.#waveX;
    const waveY = this.#waveY;

    const x = this.#x;
    const y = this.#y;
    const hx = this.#hx;
    const hy = this.#hy;
    const speed = this.#speed;
    const turn = this.#turn;
    const startle = this.#startle;
    const refractory = this.#refractory;
    const roll = this.#roll;
    const nx = this.#x2;
    const ny = this.#y2;
    const nHeading = this.#heading2;
    const nhx = this.#hx2;
    const nhy = this.#hy2;
    const nSpeed = this.#speed2;
    const nTurn = this.#turn2;
    const nStartle = this.#startle2;
    const nRefractory = this.#refractory2;
    const nRoll = this.#roll2;
    const heading = this.#heading;
    const nearI = this.#nearI;
    const nearD = this.#nearD;
    const track = this.#trackPoint;
    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < n; i++) {
      const xi = x[i] ?? 0;
      const yi = y[i] ?? 0;
      const hxi = hx[i] ?? 1;
      const hyi = hy[i] ?? 0;
      const si = speed[i] ?? cruise;
      const found = this.#neighbours(i);

      // Social terms over the topological neighbourhood.
      let alignX = 0;
      let alignY = 0;
      let inX = 0;
      let inY = 0;
      let sepX = 0;
      let sepY = 0;
      let turnSum = 0;
      let speedSum = 0;
      let startled = 0;
      for (let m = 0; m < found; m++) {
        const j = nearI[m] ?? 0;
        const d = Math.sqrt(nearD[m] ?? 0) + 1e-6;
        const ux = ((x[j] ?? 0) - xi) / d;
        const uy = ((y[j] ?? 0) - yi) / d;
        inX += ux;
        inY += uy;
        if (d < separation) {
          const push = 1 - d / separation;
          sepX -= ux * push;
          sepY -= uy * push;
        }
        alignX += hx[j] ?? 0;
        alignY += hy[j] ?? 0;
        turnSum += turn[j] ?? 0;
        speedSum += speed[j] ?? 0;
        startled = Math.max(startled, startle[j] ?? 0);
      }
      const share = found > 0 ? 1 / found : 0;
      // Cohesion: the mean unit vector to the neighbours is ~0 inside the flock and points inward,
      // with length ~1, at its rim, so only the edge birds are pulled in (Hemelrijk's centrality).
      inX *= share;
      inY *= share;

      // Social steering (alignment, cohesion, separation) as a turn-rate vector: the bird turns by its
      // component across the heading; the component along it is left to the speed control.
      const socialX = alignX * share * align * (1 - 0.8 * mark) + inX * cohesion * free + sepX * SEPARATE;
      const socialY = alignY * share * align * (1 - 0.8 * mark) + inY * cohesion * free + sepY * SEPARATE;
      let demand = hxi * socialY - hyi * socialX;
      let pushT = SEPARATE_SPEED * (hxi * sepX + hyi * sepY) + COHESION_SPEED * free * (hxi * inX + hyi * inY);

      // Everything else pulls on the bird from outside the flock: the roost, the walls, the sky's
      // large-scale drift, the falcon, the M.
      let steerX = 0;
      let steerY = 0;

      const rdx = this.#roostX - xi;
      const rdy = this.#roostY - yi;
      const roostDistance = Math.hypot(rdx, rdy) + 1e-6;
      const far = Math.max(0, roostDistance - ROOST_REACH) * ROOST_FAR / roostDistance;
      steerX += (rdx * roostX + rdx * far) * free;
      steerY += (rdy * roostY + rdy * far) * free;

      if (found < NEIGHBOURS) {
        const cdx = this.#centreX - xi;
        const cdy = this.#centreY - yi;
        const lost = (REJOIN * (1 - found / NEIGHBOURS) * free) / (Math.hypot(cdx, cdy) + 1e-3);
        steerX += cdx * lost;
        steerY += cdy * lost;
      }

      if (yi < FLOOR) steerY += (FLOOR - yi) * WALL;
      if (yi > CEILING) steerY -= (yi - CEILING) * WALL;
      if (xi < SIDE) steerX += (SIDE - xi) * WALL;
      if (xi > aspect - SIDE) steerX -= (xi - aspect + SIDE) * WALL;

      // A slowly changing large-scale steering field: one broad mode turns the whole flock, a finer
      // one (with chaos) turns its parts differently, folding and stretching it.
      const bearing =
        2.1 * Math.sin(1.3 * xi + 0.071 * t + 0.4) + 1.7 * Math.sin(1.9 * yi - 0.053 * t + 1.3) + 1.8 * chaos * Math.sin(4.6 * xi - 3.7 * yi + 0.23 * t);
      steerX += Math.cos(bearing) * flow * free;
      steerY += Math.sin(bearing) * flow * free;

      // The falcon: flee hard, faster the closer it is.
      let panic = 0;
      if (falcon) {
        const ax = xi - fx;
        const ay = yi - fy;
        const d = Math.hypot(ax, ay) + 1e-6;
        if (d < FEAR_RADIUS) {
          panic = 1 - d / FEAR_RADIUS;
          const flee = (FLEE * panic * panic) / d;
          steerX += ax * flee;
          steerY += ay * flee;
          pushT += (FLEE_SPEED * panic * (hxi * ax + hyi * ay)) / d;
        }
      }

      let target = cruise * (this.#pace[i] ?? 1) * (1 + PANIC_SPEED * panic);
      let slowest = cruise * SPEED_MIN;
      if (mark > 0) {
        // The bird's place on the racetrack moves along it; lanes keep the streams apart.
        markTrackAt((this.#markPlace[i] ?? 0) + this.#markRun, track);
        const px = this.#markX + (track[0] ?? 0) * MARK_SIZE - xi;
        const py = this.#markY + (track[1] ?? 0) * MARK_SIZE - yi;
        steerX += mark * (px * MARK_PULL + (track[2] ?? 0) * MARK_ALONG);
        steerY += mark * (py * MARK_PULL + (track[3] ?? 0) * MARK_ALONG);
        target += (markStream + MARK_CATCH * (hxi * px + hyi * py) - target) * mark;
        slowest *= 1 - 0.3 * mark;
      }

      // A pull from behind turns the bird at its full strength, one way or the other, so neither a
      // flock flying straight away from the roost nor a bird diving at the floor is a stable state.
      const cross = hxi * steerY - hyi * steerX;
      const ahead = hxi * steerX + hyi * steerY;
      demand += ahead >= 0 ? cross : (cross >= 0 ? 1 : -1) * Math.hypot(steerX, steerY);
      demand += wander * (1 - 0.7 * mark) * (Math.sin((this.#rateA[i] ?? 1) * t + (this.#phaseA[i] ?? 0)) + 0.6 * Math.sin((this.#rateB[i] ?? 0.5) * t + (this.#phaseB[i] ?? 0)));

      // Agitation: a startled bird rolls away from where the wave came from and spurts ahead.
      let s = startle[i] ?? 0;
      let r = refractory[i] ?? 0;
      if (s > 0.01) {
        const away = hxi * (yi - waveY) - hyi * (xi - waveX);
        demand += STARTLE_TURN * s * (away >= 0 ? 1 : -1);
        target *= 1 + STARTLE_SPEED * s;
      }

      // Inertial turning (implicit, so it is stable at any gain): relax toward the demand and toward
      // the neighbours' turn rates; turns spread through the flock as waves.
      const turnI = turn[i] ?? 0;
      const neighbourTurn = found > 0 ? turnSum * share : turnI;
      const spin = found > 0 ? SPIN_COUPLING : 0;
      const limit = TURN_MAX + (TURN_MAX_PANIC - TURN_MAX) * panic;
      let w = (turnI + STEP * (demand / TURN_INERTIA + spin * neighbourTurn)) / (1 + STEP * (1 / TURN_INERTIA + spin));
      w = Math.max(-limit, Math.min(limit, w));
      let angle = (heading[i] ?? 0) + w * STEP;
      if (angle > Math.PI) angle -= Math.PI * 2;
      else if (angle < -Math.PI) angle += Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      const neighbourSpeed = found > 0 ? speedSum * share : si;
      const fastest = cruise * (SPEED_MAX + (SPEED_FLEE - SPEED_MAX) * panic);
      let v = (si + STEP * (SPEED_RELAX * target + SPEED_MATCH * neighbourSpeed + si * pushT)) / (1 + STEP * (SPEED_RELAX + SPEED_MATCH));
      v = Math.max(slowest, Math.min(fastest, v));

      // Excitable medium: charge from the most startled neighbour, fire, then rest.
      s *= STARTLE_DECAY;
      r *= REFRACTORY_DECAY;
      if (r < REFRACTORY_READY && startled > STARTLE_FIRE) {
        s = Math.min(1, s + STARTLE_RISE * (startled - STARTLE_FIRE) * STEP);
        if (s >= 0.999) r = 1;
      }

      const xn = xi + (cosA * v + drift) * STEP;
      const yn = yi + sinA * v * STEP;
      nx[i] = xn;
      ny[i] = yn;
      nHeading[i] = angle;
      nhx[i] = cosA;
      nhy[i] = sinA;
      nSpeed[i] = v;
      nTurn[i] = w;
      nStartle[i] = s;
      nRefractory[i] = r;
      // Banking: a turning or startled bird shows more of its wings and reads darker.
      const rolled = Math.max(Math.min(1, Math.abs(w) / ROLL_RATE), s);
      const rollI = roll[i] ?? 0;
      nRoll[i] = rollI + (rolled - rollI) * ROLL_BLEND;
      sumX += xn;
      sumY += yn;
    }
    this.#centreX = sumX / n;
    this.#centreY = sumY / n;

    // Swap: the next state becomes the current one; the old one is kept for drawing in between.
    this.#x = nx;
    this.#x2 = x;
    this.#y = ny;
    this.#y2 = y;
    this.#heading = nHeading;
    this.#heading2 = heading;
    this.#hx = nhx;
    this.#hx2 = hx;
    this.#hy = nhy;
    this.#hy2 = hy;
    this.#speed = nSpeed;
    this.#speed2 = speed;
    this.#turn = nTurn;
    this.#turn2 = turn;
    this.#startle = nStartle;
    this.#startle2 = startle;
    this.#refractory = nRefractory;
    this.#refractory2 = refractory;
    this.#roll = nRoll;
    this.#roll2 = roll;

    this.#ignite(chaos);
  }

  /** Start agitation waves: around the falcon's beak, and now and then for no visible reason. */
  #ignite(chaos: number): void {
    const startle = this.#startle;
    const refractory = this.#refractory;
    if (this.#falcon) {
      const x = this.#x;
      const y = this.#y;
      const r2 = STARTLE_RADIUS * STARTLE_RADIUS;
      for (let i = 0; i < this.#n; i++) {
        const dx = (x[i] ?? 0) - this.#falconX;
        const dy = (y[i] ?? 0) - this.#falconY;
        if (dx * dx + dy * dy < r2 && (refractory[i] ?? 0) < REFRACTORY_READY) {
          startle[i] = 1;
          refractory[i] = 1;
        }
      }
      this.#waveX = this.#falconX;
      this.#waveY = this.#falconY;
    }
    if (this.#random.next() < STARTLE_SPONTANEOUS * chaos * STEP) {
      const i = Math.min(this.#n - 1, Math.floor(this.#random.next() * this.#n));
      if ((refractory[i] ?? 0) < REFRACTORY_READY) {
        startle[i] = 1;
        refractory[i] = 1;
        this.#waveX = this.#x[i] ?? 0;
        this.#waveY = this.#y[i] ?? 0;
      }
    }
  }

  /** Schedule and fly the falcon; schedule and time the M. */
  #events(t: number): void {
    const knob = this.#knob;
    const random = this.#random;

    if (knob.predator > 0) {
      const interval = ATTACK_RARE + (ATTACK_OFTEN - ATTACK_RARE) * knob.predator;
      if (!Number.isFinite(this.#nextAttack)) this.#nextAttack = t + interval * (0.3 + 0.3 * random.next());
      else if (t >= this.#nextAttack && !this.#falcon) {
        this.#attackNow = true;
        this.#nextAttack = t + interval * (0.6 + 0.8 * random.next());
      }
    } else this.#nextAttack = Number.POSITIVE_INFINITY;
    if (this.#attackNow) {
      this.#attackNow = false;
      this.#launchFalcon();
    }
    if (this.#falcon) this.#flyFalcon();

    if (knob.mark > 0) {
      if (!Number.isFinite(this.#nextMark)) this.#nextMark = t + MARK_FIRST;
      else if (t >= this.#nextMark && !this.#mark) {
        this.#markNow = true;
        this.#nextMark = t + (MARK_RARE + (MARK_OFTEN - MARK_RARE) * knob.mark) * (0.7 + 0.6 * random.next());
      }
    } else this.#nextMark = Number.POSITIVE_INFINITY;
    if (this.#markNow) {
      this.#markNow = false;
      this.#formMark();
    }
    if (this.#mark) {
      const age = (this.#markAge += STEP);
      this.#markRun += (STEP * MARK_STREAM * (CRUISE_SLOW + (CRUISE_FAST - CRUISE_SLOW) * knob.speed)) / MARK_SIZE;
      this.#markStrength = smoothstep(0, MARK_GATHER, age) * (1 - smoothstep(MARK_HOLD, MARK_END, age));
      if (age - STEP < MARK_HOLD && age >= MARK_HOLD) this.#releaseMark();
      if (age >= MARK_END) {
        this.#mark = false;
        this.#markStrength = 0;
      }
    }
  }

  /** A peregrine stoops from above the frame at a bird in the thick of the flock. */
  #launchFalcon(): void {
    const random = this.#random;
    // The prey: of a few birds picked at random, the one nearest the flock's centre.
    let prey = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 8; k++) {
      const i = Math.min(this.#n - 1, Math.floor(random.next() * this.#n));
      const d = Math.hypot((this.#x[i] ?? 0) - this.#centreX, (this.#y[i] ?? 0) - this.#centreY);
      if (d < best) {
        best = d;
        prey = i;
      }
    }
    const px = this.#x[prey] ?? 0;
    const py = this.#y[prey] ?? 0;
    const side = random.next() < 0.5 ? -1 : 1;
    this.#falcon = true;
    this.#falconPrey = prey;
    this.#falconX = px + side * (0.35 + 0.3 * random.next());
    this.#falconY = 1.12;
    this.#falconPrevX = this.#falconX;
    this.#falconPrevY = this.#falconY;
    const dx = px - this.#falconX;
    const dy = py - this.#falconY;
    const d = Math.hypot(dx, dy) + 1e-6;
    this.#falconVX = (dx / d) * FALCON_STOOP;
    this.#falconVY = (dy / d) * FALCON_STOOP;
    this.#falconAge = 0;
    this.#falconStoop = true;
    this.#wingOpen = 0.1;
    this.#wingbeat = 0;
  }

  /** Pursue the prey in a stoop; once past it, pull out, open the wings, climb away and leave. */
  #flyFalcon(): void {
    this.#falconAge += STEP;
    this.#falconPrevX = this.#falconX;
    this.#falconPrevY = this.#falconY;
    const vx = this.#falconVX;
    const vy = this.#falconVY;
    const speed = Math.hypot(vx, vy) + 1e-6;
    let angle = Math.atan2(vy, vx);
    let goal: number;
    let rate: number;
    let cruise: number;
    if (this.#falconStoop) {
      const dx = (this.#x[this.#falconPrey] ?? 0) - this.#falconX;
      const dy = (this.#y[this.#falconPrey] ?? 0) - this.#falconY;
      goal = Math.atan2(dy, dx);
      rate = FALCON_TURN;
      cruise = FALCON_STOOP;
      if (Math.hypot(dx, dy) < 0.025 || dx * vx + dy * vy < 0) this.#falconStoop = false;
    } else {
      goal = vx >= 0 ? 0.5 : Math.PI - 0.5;
      rate = FALCON_CLIMB;
      cruise = FALCON_CRUISE;
      this.#wingbeat += STEP * FALCON_WINGBEAT * Math.PI * 2;
    }
    let delta = goal - angle;
    delta -= Math.round(delta / (Math.PI * 2)) * Math.PI * 2;
    angle += Math.max(-rate * STEP, Math.min(rate * STEP, delta));
    const v = speed + (cruise - speed) * (1 - Math.exp(-STEP / 0.6));
    this.#falconVX = Math.cos(angle) * v;
    this.#falconVY = Math.sin(angle) * v;
    this.#falconX += this.#falconVX * STEP;
    this.#falconY += this.#falconVY * STEP;
    this.#wingOpen += ((this.#falconStoop ? 0.1 : 1) - this.#wingOpen) * (1 - Math.exp(-STEP / 0.25));
    const out = this.#falconX < -0.15 || this.#falconX > this.#aspect + 0.15 || this.#falconY < -0.15 || this.#falconY > 1.2;
    if ((out && this.#falconAge > 0.6) || this.#falconAge > 9) this.#falcon = false;
  }

  /**
   * Hand every bird a place on the M's racetrack, left to right as the birds already are, so the
   * flock flows into the letter instead of criss-crossing the sky; centre the M on the flock.
   */
  #formMark(): void {
    const n = this.#n;
    const x = this.#x;
    const a = this.#aspect;
    // Centre the M on the flock, kept clear of the frame's sides.
    const left = Math.max(a * 0.3, 0.47 * MARK_SIZE + 0.05);
    const right = Math.max(left, Math.min(a * 0.7, a - 0.47 * MARK_SIZE - 0.05));
    this.#markX = Math.min(right, Math.max(left, this.#centreX));
    this.#markY = Math.min(0.64, Math.max(0.5, this.#centreY));
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, x[i] ?? 0);
      hi = Math.max(hi, x[i] ?? 0);
    }
    // Counting sort into columns gives each bird its rank from the left.
    const bins = this.#binStart;
    const cursor = this.#binCursor;
    const scale = (MARK_BINS - 1e-3) / Math.max(hi - lo, 1e-6);
    bins.fill(0);
    for (let i = 0; i < n; i++) {
      const b = Math.floor(((x[i] ?? 0) - lo) * scale);
      bins[b + 1] = (bins[b + 1] ?? 0) + 1;
    }
    for (let b = 1; b <= MARK_BINS; b++) bins[b] = (bins[b] ?? 0) + (bins[b - 1] ?? 0);
    for (let b = 0; b < MARK_BINS; b++) cursor[b] = bins[b] ?? 0;
    for (let i = 0; i < n; i++) {
      const b = Math.floor(((x[i] ?? 0) - lo) * scale);
      const rank = cursor[b] ?? 0;
      cursor[b] = rank + 1;
      const across = (rank + 0.5) / n;
      // Alternate birds take the outward lane (left to right) and the return lane (right to left).
      this.#markPlace[i] = (i & 1) === 0 ? across * MARK_OUTWARD_LENGTH : MARK_TRACK_LENGTH - across * MARK_OUTWARD_LENGTH;
    }
    this.#mark = true;
    this.#markAge = 0;
    this.#markRun = 0;
  }

  /** Letting go of the M: a ripple runs out from its middle vertex as the birds scatter. */
  #releaseMark(): void {
    const cx = this.#markX + (MARK_X[2] ?? 0) * MARK_SIZE;
    const cy = this.#markY + (MARK_Y[2] ?? 0) * MARK_SIZE;
    const r2 = 0.05 * 0.05;
    for (let i = 0; i < this.#n; i++) {
      const dx = (this.#x[i] ?? 0) - cx;
      const dy = (this.#y[i] ?? 0) - cy;
      if (dx * dx + dy * dy < r2) {
        this.#startle[i] = 1;
        this.#refractory[i] = 1;
      }
    }
    this.#waveX = cx;
    this.#waveY = cy;
  }

  /**
   * Splat the birds into the density field (cloud-in-cell: each bird shares its weight bilinearly
   * among the four nearest texels; Hockney & Eastwood, "Computer Simulation Using Particles"),
   * blended over the last frame's field as a short trail. `keep` is how much of the old field
   * survives; `between` how far the clock is from the previous step to the latest one.
   */
  #paint(keep: number, between: number): void {
    const field = this.#field;
    const w = this.#fieldW;
    const h = this.#fieldH;
    const n = this.#n;
    for (let k = 0; k < field.length; k++) field[k] = (field[k] ?? 0) * keep;
    const gain = (1 - keep) * (DENSITY_UNIT * h) * (DENSITY_UNIT * h);
    const sx = w / this.#aspect;
    const sy = h;
    const f = Math.min(1, Math.max(0, between));
    const x = this.#x;
    const y = this.#y;
    const px = this.#x2;
    const py = this.#y2;
    const roll = this.#roll;
    const weight = this.#weight;
    for (let i = 0; i < n; i++) {
      const xi = (px[i] ?? 0) + ((x[i] ?? 0) - (px[i] ?? 0)) * f;
      const yi = (py[i] ?? 0) + ((y[i] ?? 0) - (py[i] ?? 0)) * f;
      const gx = xi * sx - 0.5;
      const gy = yi * sy - 0.5;
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      if (i0 < -1 || j0 < -1 || i0 >= w || j0 >= h) continue;
      const ax = gx - i0;
      const ay = gy - j0;
      const mass = gain * (weight[i] ?? 1);
      const dark = mass * (roll[i] ?? 0);
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= h) continue;
        const wy = dj === 0 ? 1 - ay : ay;
        for (let di = 0; di < 2; di++) {
          const col = i0 + di;
          if (col < 0 || col >= w) continue;
          const share = wy * (di === 0 ? 1 - ax : ax);
          const k = (j * w + col) * 2;
          field[k] = (field[k] ?? 0) + mass * share;
          field[k + 1] = (field[k + 1] ?? 0) + dark * share;
        }
      }
    }

    const d = this.#stateData;
    const a = this.#aspect;
    const speed = Math.hypot(this.#falconVX, this.#falconVY) + 1e-6;
    d[0] = (this.#falconPrevX + (this.#falconX - this.#falconPrevX) * f) / a;
    d[1] = this.#falconPrevY + (this.#falconY - this.#falconPrevY) * f;
    d[2] = this.#falconVX / speed;
    d[3] = this.#falconVY / speed;
    d[4] = this.#falcon ? 1 : 0;
    d[5] = this.#wingOpen;
    d[6] = Math.sin(this.#wingbeat);
    d[7] = 0;
    d[8] = this.#markStrength;
    d[9] = this.#markX / a;
    d[10] = this.#markY;
    d[11] = MARK_SIZE;
  }
}

/** A point on the M's racetrack at arclength u (wrapping): out[0..1] position, out[2..3] direction, mark units. */
function markTrackAt(u: number, out: Float32Array): void {
  const along = u - Math.floor(u / MARK_TRACK_LENGTH) * MARK_TRACK_LENGTH;
  const segments = MARK_TRACK.length / 6;
  let k = 0;
  while (k + 1 < segments && along >= (MARK_TRACK[(k + 1) * 6 + 4] ?? 0)) k++;
  const o = k * 6;
  const ax = MARK_TRACK[o] ?? 0;
  const ay = MARK_TRACK[o + 1] ?? 0;
  const bx = MARK_TRACK[o + 2] ?? 0;
  const by = MARK_TRACK[o + 3] ?? 0;
  const length = MARK_TRACK[o + 5] ?? 1;
  const f = Math.min(1, Math.max(0, (along - (MARK_TRACK[o + 4] ?? 0)) / length));
  out[0] = ax + (bx - ax) * f;
  out[1] = ay + (by - ay) * f;
  out[2] = (bx - ax) / length;
  out[3] = (by - ay) / length;
}

/** The murmuration's simulation for a scene whose knobs are `params` (looked up by key). */
export function flockSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new FlockSim(gl, params);
}
