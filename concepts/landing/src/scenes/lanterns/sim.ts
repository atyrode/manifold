// The lantern river's simulation: paper lanterns floating on a river at dusk (tōrō nagashi), flown
// on the CPU and handed to the shader (shader.ts) as one row of texels.
//
// World units are metres: x along the river (right is upstream, the water runs to the left), z
// across it, away from the viewer, who stands on the near bank EYE metres above the water. The
// water's velocity anywhere is a closed-form sum:
// - the stream, fastest mid-river and slowing toward the banks (a power of a sine across the
//   channel), plus a gentle drift out from our bank that carries lanterns set down there out into
//   the current;
// - slow eddies, strongest along our bank: the curl of a stream function (a few drifting sines
//   times an envelope across the river), so they swirl the lanterns without gathering or
//   scattering the water;
// - potential flow round each rock (a cylinder in a uniform stream, which parts and closes again
//   round it), and behind it a wake where the stream slows and swings from side to side.
// Lanterns take up the water's velocity with a little inertia, push one another apart where they
// touch (so they bunch against a rock and in slack water, and spread again in the stream), turn
// with the water's spin (half its vorticity, as any small floating body does) and with the knocks
// they take, and slide off the rocks.
//
// A steady population follows the count knob: lanterns float off downstream past the left edge
// and new ones come round the bend upstream, mostly in a stream that passes the near rock (as if
// set down from a jetty upstream), the rest scattered across the river. Flotillas are pushed off
// from our bank, just below the frame; a click sets a lantern down on the water under the pointer,
// its candle catching as rings spread from it; dragging the held pointer pushes the water along.
// The M lantern (the landmark) has a slot of its own and keeps turning back to face the bank.
//
// Time runs in fixed steps of STEP seconds of simulated time, so the river depends only on the
// knobs, the seed and simulated time, not on the frame rate; positions are interpolated between
// the last two steps for drawing. The first frame lays the river out and lets it run for PREWARM
// seconds, so the scene opens on an evening already under way. Nothing is allocated per frame.
//
// Texture (rgba16f, TEXTURE_WIDTH × 1, nearest):
//   texel i            lantern slot i: x, z (m; z = 0 marks an empty slot), turn (rad, 0..2π),
//                      candle 0..1
//   texel MAX + i      its looks: seed 0..1, 1 for the M lantern, seconds since it was set down on
//                      the water (60 at most), size (1 = LANTERN_HALF by LANTERN_TALL)
//   texel 2 MAX + r    rock r: lantern light falling on its visible face, and from which side
//                      (-1 left .. 1 right)
import type { ParamDef } from "../../params.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- The view and the river, shared with the shader ----

/** Screen height (uv) of the horizon. */
export const HORIZON = 0.56;
/** Vertical field of view (rad), and the focal length it gives (screen heights). */
export const FOV = 0.5;
export const FOCAL = 0.5 / Math.tan(FOV / 2);
/** Eye height over the water, and the distance to the far bank's waterline (m). */
export const EYE = 2;
export const FAR_BANK = 130;
/** Lantern slots; the last is the M lantern's. */
export const MAX_LANTERNS = 32;
/** A lantern's half-side and height at size 1 (m), and the M lantern's size. */
export const LANTERN_HALF = 0.15;
export const LANTERN_TALL = 0.36;
export const MARK_SIZE = 1.35;
/** The stream mid-river (m/s) at either end of the current knob. */
export const CURRENT_SLOW = 0.05;
export const CURRENT_FAST = 0.5;

export interface Rock {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

/** Two stones in the stream: one near, in the lanterns' main lane, one further out. */
export const ROCKS: readonly Rock[] = [
  { x: -1.9, z: 13.5, radius: 0.75, height: 0.5 },
  { x: 6.5, z: 31, radius: 1.4, height: 0.85 },
];

export const TEXTURE_WIDTH = 2 * MAX_LANTERNS + ROCKS.length;

/** The lantern counts on offer (the `lanterns` knob). */
export const LANTERN_COUNTS = [6, 12, 18, 24, 30] as const;

// ---- The river (sim only) ----

const TAU = Math.PI * 2;
/** Our bank's waterline (m ahead, below the frame); the stream's profile runs from it to the far bank. */
const NEAR_SHORE = 3;
const RIVER_WIDTH = FAR_BANK - NEAR_SHORE;
/** The stream's profile across the river is sin^POWER: low powers give a flat middle and steep edges. */
const PROFILE_POWER = 0.4;
/** The lanterns' lane across the river: soft walls keep them between these distances (m). */
const LANE_NEAR = 7.6;
const LANE_FAR = 72;
const BANK_PUSH = 1.5;
/** The drift out from our bank (m/s at LANE_NEAR) and how far out it reaches (m). */
const OUTFLOW = 0.06;
const OUTFLOW_REACH = 2.5;
/** Eddies: modes, each's speed (m/s), the share left mid-river, how far from our bank they are strong, how fast they ride the stream. */
const EDDY_MODES = 3;
const EDDY_SPEED = 0.025;
const EDDY_FLOOR = 0.35;
const EDDY_REACH = 6;
const EDDY_DRIFT = 0.6;
/** Behind a rock the stream loses this share of its speed, over this many radii, and swings sideways by this share. */
const WAKE_DEFICIT = 0.55;
const WAKE_LENGTH = 7;
const WAKE_SWAY = 0.35;
/** The wind's push on the paper walls at full wind (m/s, positive to the right: upstream). */
const WIND_PUSH = 0.05;

// ---- Lanterns ----

/** Contact radius at size 1 (m): about the half-diagonal of the base. */
const RADIUS = 0.2;
/** Seconds a lantern takes to pick up the water's speed. */
const DRAG = 1.6;
/** Contact springs (1/s²) and the damping of lanterns running into each other (1/s). */
const CONTACT = 6;
const CONTACT_DAMP = 2;
/** How hard a glancing knock turns a lantern (rad/s² per m/s of slip, per m of radius⁻¹). */
const KNOCK = 0.4;
/** Seconds to settle into the water's spin; each lantern's own slow turn at most (rad/s). */
const SPIN_EASE = 5;
const OWN_SPIN = 0.04;
/** The M lantern's pull back toward facing the bank (rad/s²). */
const FACE_PULL = 0.06;
/** A lantern caught on a rock's upstream face is eased round it (m/s²). */
const SLIP = 0.1;
/** Seconds for a freshly lit candle to catch. */
const LIGHT_UP = 0.9;
/** Seconds of age kept for the shader (the set-down rings only need the first few). */
const AGE_KEPT = 60;

// ---- Spawning ----

/** Share of new lanterns in the main lane, its centre and spread (m across the river). */
const STREAM_SHARE = 0.65;
const STREAM_Z = 15;
const STREAM_SPREAD = 4;
/** New lanterns come in this far beyond the frame's right edge, and leave this far beyond its left (m). */
const SPAWN_MARGIN = 2.2;
const EXIT_MARGIN = 2.4;
/** A lantern blown this far upstream of the spawn line is let go. */
const STRAY = 6;
/** Seconds between arrivals while the river is short of lanterns; the chance one brings a companion. */
const SPAWN_GAP_MIN = 0.6;
const SPAWN_GAP_MAX = 5;
const PAIR_CHANCE = 0.3;
/** Short by more than this (the count went up): set lanterns down from our bank, this often (s). */
const CATCH_UP = 3;
const CATCH_UP_GAP = 0.7;
/** Released from our bank: where (m ahead, just below the frame), how hard they are pushed off (m/s), how far apart. */
const RELEASE_Z = 6.3;
const RELEASE_PUSH = 0.4;
const RELEASE_SPACING = 0.55;
/** Seconds between flotillas at frequency 0 and 1 (randomised ±40%), and before the first. */
const FLOTILLA_RARE = 150;
const FLOTILLA_OFTEN = 35;
const FLOTILLA_FIRST = 14;
/** The M lantern's lane when it comes round the bend (m across). */
const MARK_LANE_NEAR = 10;
const MARK_LANE_FAR = 15;
/** Clicks further out than this set the lantern down here (m). */
const CLICK_FAR = 75;

// ---- The pointer as a hand in the water ----

/** Radius of the water it pushes (m), how firmly (1/s), and the fastest push (m/s). */
const HAND_RADIUS = 0.9;
const HAND_GRIP = 3;
const HAND_MAX = 1.2;

// ---- Lantern light on the rocks ----

/** Distance (m) at which a lantern's light on a rock has fallen to half. */
const ROCK_GLOW_REACH = 0.9;

// ---- Time ----

const STEP = 1 / 60;
const MAX_STEPS = 8;
const PREWARM = 30;
const SEED_BASE = 0x70a0a6;

type KnobKey = "lanterns" | "current" | "flotilla" | "lanternSeed" | "wind" | "mark";

/** The simulation was set up wrong: a knob it reads is missing, or it ran out of lantern slots. */
export class LanternsSimError extends Error {}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** The stream's share of its mid-river speed at distance z across the river. */
const profileAt = (z: number): number => {
  const across = clamp((z - NEAR_SHORE) / RIVER_WIDTH, 0, 1);
  return Math.pow(Math.max(Math.sin(Math.PI * across), 0.05), PROFILE_POWER);
};

/** mulberry32: a small seeded generator, so the same seed always gives the same evening. */
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

class Lantern {
  alive = false;
  mark = false;
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  angle = 0;
  spin = 0;
  ownSpin = 0;
  /** Where it was at the step before, for drawing between steps. */
  lastX = 0;
  lastZ = 0;
  lastAngle = 0;
  light = 1;
  age = AGE_KEPT;
  seed = 0;
  size = 1;
  radius = RADIUS;
  // This step's sums.
  ax = 0;
  az = 0;
  torque = 0;
  vorticity = 0;
}

/** One drifting sine of the eddies' stream function. */
class Eddy {
  kx = 0;
  kz = 0;
  omega = 0;
  phase = 0;
  amp = 0;
}

class LanternRiver implements SceneSim {
  readonly #texture: DataTexture;
  readonly #data = new Float32Array(TEXTURE_WIDTH * 4);
  readonly #knobIndex: Readonly<Record<KnobKey, number>>;
  readonly #random = new Random();
  readonly #regular: readonly Lantern[] = Array.from({ length: MAX_LANTERNS - 1 }, () => new Lantern());
  readonly #mark = new Lantern();
  /** Every slot in texture order: the regular lanterns, then the M lantern. */
  readonly #all: readonly Lantern[] = [...this.#regular, this.#mark];
  readonly #eddies: readonly Eddy[] = Array.from({ length: EDDY_MODES }, () => new Eddy());
  /** Scratch: the water's velocity (x, z) and vorticity; a point on the water (x, z). */
  readonly #water = new Float64Array(3);
  readonly #point = new Float64Array(2);

  #aspect = 16 / 9;
  #target = 18;
  #current = 0.2;
  #wind = 0;
  #flotilla = 0;
  #markOn = false;
  #markWasOn = false;
  #seed = Number.NaN;

  #clock = 0;
  #pending = 0;
  #nextSpawn = 0;
  #nextFlotilla = Number.POSITIVE_INFINITY;
  #nextMark = Number.POSITIVE_INFINITY;

  #primed = false;
  #seenFlotilla = 0;
  #seenMark = 0;

  #hand = false;
  #handHeld = false;
  #handX = 0;
  #handZ = 0;
  #handVX = 0;
  #handVZ = 0;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const index = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new LanternsSimError(`lanterns: the scene has no '${key}' knob`);
      return at;
    };
    this.#knobIndex = {
      lanterns: index("lanterns"),
      current: index("current"),
      flotilla: index("flotilla"),
      lanternSeed: index("lanternSeed"),
      wind: index("wind"),
      mark: index("mark"),
    };
    this.#mark.mark = true;
    this.#texture = new DataTexture(gl, { width: TEXTURE_WIDTH, height: 1, format: "rgba16f", filter: "nearest" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const values = frame.values;
    const index = this.#knobIndex;
    this.#target = clamp(Math.round(values[index.lanterns] ?? this.#target), 0, MAX_LANTERNS - 1);
    this.#current = CURRENT_SLOW + (CURRENT_FAST - CURRENT_SLOW) * clamp(values[index.current] ?? 0.45, 0, 1);
    this.#wind = clamp(values[index.wind] ?? 0, -1, 1);
    this.#flotilla = clamp(values[index.flotilla] ?? 0, 0, 1);
    this.#markOn = (values[index.mark] ?? 0) > 0.5;
    if (frame.aspect > 0) this.#aspect = frame.aspect;

    const seed = Math.round(values[index.lanternSeed] ?? 0);
    if (seed !== this.#seed) this.#reset(seed);

    // Flotillas on their own: a fresh wait whenever the knob comes on, none while it is off.
    if (this.#flotilla <= 0) this.#nextFlotilla = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.#nextFlotilla)) this.#nextFlotilla = this.#clock + FLOTILLA_FIRST;
    // Switching the M lantern on sets it on the water from our bank, so it shows at once.
    if (this.#markOn && !this.#markWasOn && !this.#mark.alive) this.#releaseMark();
    this.#markWasOn = this.#markOn;

    this.#watchTriggers(frame.triggers);
    this.#follow(frame);

    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    this.#pending = Math.min(this.#pending + advance, MAX_STEPS * STEP);
    while (this.#pending >= STEP) {
      this.#step();
      this.#pending -= STEP;
    }
    this.#upload(this.#pending / STEP);
    return [this.#texture.texture];
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** A "now" button stamps its slot with the scene clock: any change since the last frame fires. */
  #watchTriggers(triggers: readonly number[]): void {
    const flotilla = triggers[0] ?? -1e4;
    const mark = triggers[1] ?? -1e4;
    if (this.#primed) {
      if (flotilla !== this.#seenFlotilla && flotilla > -1e3) this.#releaseFlotilla();
      if (mark !== this.#seenMark && mark > -1e3) this.#releaseMark();
    }
    this.#primed = true;
    this.#seenFlotilla = flotilla;
    this.#seenMark = mark;
  }

  /** The pointer: a press on the water sets a lantern down there; holding it pushes the water along. */
  #follow(frame: SimFrame): void {
    const pointer = frame.pointer;
    this.#hand = false;
    const onWater = pointer.inside && this.#toWater(pointer.x, pointer.y);
    if (!onWater) {
      this.#handHeld = false;
      return;
    }
    const x = this.#point[0] ?? 0;
    const z = this.#point[1] ?? 0;
    if (pointer.pressed) this.#setDown(x, z);
    if (!pointer.down) {
      this.#handHeld = false;
      return;
    }
    const dt = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    if (this.#handHeld && dt > 0) {
      let vx = (x - this.#handX) / dt;
      let vz = (z - this.#handZ) / dt;
      const speed = Math.hypot(vx, vz);
      if (speed > HAND_MAX) {
        vx *= HAND_MAX / speed;
        vz *= HAND_MAX / speed;
      }
      this.#handVX = vx;
      this.#handVZ = vz;
      this.#hand = true;
    }
    this.#handX = x;
    this.#handZ = z;
    this.#handHeld = true;
  }

  /** The point on the water under screen point (px, py) into #point; false above the far waterline. */
  #toWater(px: number, py: number): boolean {
    const below = HORIZON - py;
    if (below <= (EYE * FOCAL) / FAR_BANK + 0.002) return false;
    const z = Math.min((EYE * FOCAL) / below, CLICK_FAR);
    this.#point[0] = ((px - 0.5) * this.#aspect * z) / FOCAL;
    this.#point[1] = z;
    return true;
  }

  /** Half the width of the view at distance z (m). */
  #halfWidth(z: number): number {
    return (0.5 * this.#aspect * z) / FOCAL;
  }

  /** Lay a fresh river out for this seed and let it run a while. */
  #reset(seed: number): void {
    const random = this.#random;
    random.seed(SEED_BASE ^ Math.imul(seed + 1, 0x9e3779b1));
    this.#seed = seed;
    for (const lantern of this.#all) lantern.alive = false;
    for (const eddy of this.#eddies) {
      const k = TAU / (6 + 6 * random.next());
      const heading = random.next() * TAU;
      eddy.kx = k * Math.cos(heading);
      eddy.kz = k * Math.sin(heading);
      eddy.omega = (random.next() * 2 - 1) * 0.08;
      eddy.phase = random.next() * TAU;
      eddy.amp = EDDY_SPEED / k;
    }
    this.#clock = 0;
    this.#pending = 0;
    this.#nextSpawn = 0;
    this.#nextFlotilla = Number.POSITIVE_INFINITY;
    this.#nextMark = Number.POSITIVE_INFINITY;
    this.#hand = false;
    this.#handHeld = false;

    // The evening is already under way: lanterns all across the view, the M lantern well in it.
    for (let k = 0; k < this.#target; k++) this.#scatter();
    if (this.#markOn) {
      const z = 0.5 * (MARK_LANE_NEAR + MARK_LANE_FAR);
      const x = 0.5 * this.#halfWidth(z);
      this.#flow(x, z);
      this.#launch(this.#mark, x, z, this.#water[0] ?? 0, 0, 1, AGE_KEPT);
    }
    for (let s = 0; s < PREWARM / STEP; s++) this.#step();
    for (const lantern of this.#all) {
      lantern.lastX = lantern.x;
      lantern.lastZ = lantern.z;
      lantern.lastAngle = lantern.angle;
      lantern.age = AGE_KEPT;
    }
    this.#nextFlotilla = this.#flotilla > 0 ? this.#clock + FLOTILLA_FIRST : Number.POSITIVE_INFINITY;
    this.#markWasOn = this.#markOn;
  }

  /** Put a lantern somewhere in view (laying the river out). */
  #scatter(): void {
    const random = this.#random;
    for (let tries = 0; tries < 6; tries++) {
      const z = this.#sampleLane();
      const x = (random.next() * 2 - 1) * (this.#halfWidth(z) + 1);
      const onRock = ROCKS.some((rock) => Math.hypot(x - rock.x, z - rock.z) < rock.radius + RADIUS + 0.2);
      if (onRock || this.#crowded(x, z, 0.6)) continue;
      const lantern = this.#freeSlot();
      if (!lantern) return;
      this.#flow(x, z);
      this.#launch(lantern, x, z, this.#water[0] ?? 0, this.#water[1] ?? 0, 1, AGE_KEPT);
      return;
    }
  }

  /** Where across the river a new lantern floats: mostly the main lane past the near rock. */
  #sampleLane(): number {
    const random = this.#random;
    let z: number;
    if (random.next() < STREAM_SHARE) {
      const g = random.next() + random.next() + random.next() - 1.5; // roughly normal, sd 0.5
      z = STREAM_Z + 2 * STREAM_SPREAD * g;
    } else {
      z = LANE_NEAR + 0.6 + (LANE_FAR - LANE_NEAR - 4) * Math.pow(random.next(), 1.3);
    }
    return clamp(z, LANE_NEAR + 0.4, LANE_FAR - 2);
  }

  #crowded(x: number, z: number, reach: number): boolean {
    for (const lantern of this.#all) {
      if (lantern.alive && Math.hypot(lantern.x - x, lantern.z - z) < reach) return true;
    }
    return false;
  }

  /** An empty regular slot, if any. */
  #freeSlot(): Lantern | undefined {
    return this.#regular.find((lantern) => !lantern.alive);
  }

  /** A slot for a lantern beyond the count: an empty one, else one out of view, else the one furthest downstream. */
  #slotForExtra(): Lantern {
    let best: Lantern | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const lantern of this.#regular) {
      if (!lantern.alive) return lantern;
      const half = this.#halfWidth(lantern.z);
      const away = lantern.x < -half - 0.5 || lantern.x > half + 0.5 ? 1000 : 0;
      const score = away - lantern.x / half;
      if (score > bestScore) {
        bestScore = score;
        best = lantern;
      }
    }
    if (!best) throw new LanternsSimError("lanterns: no lantern slots");
    return best;
  }

  #count(): number {
    let n = 0;
    for (const lantern of this.#regular) if (lantern.alive) n++;
    return n;
  }

  /** Put a lantern on the water. */
  #launch(lantern: Lantern, x: number, z: number, vx: number, vz: number, light: number, age: number): void {
    const random = this.#random;
    lantern.alive = true;
    lantern.x = lantern.lastX = x;
    lantern.z = lantern.lastZ = z;
    lantern.vx = vx;
    lantern.vz = vz;
    lantern.seed = random.next();
    lantern.size = lantern.mark ? MARK_SIZE : 0.9 + 0.2 * random.next();
    lantern.radius = RADIUS * lantern.size;
    lantern.angle = lantern.lastAngle = lantern.mark ? (random.next() - 0.5) * 0.6 : random.next() * TAU;
    lantern.ownSpin = lantern.mark ? 0 : (random.next() * 2 - 1) * OWN_SPIN;
    lantern.spin = lantern.ownSpin;
    lantern.light = light;
    lantern.age = age;
  }

  /** A lantern coming round the bend upstream, now and then with a companion. */
  #spawnUpstream(): void {
    const random = this.#random;
    for (let tries = 0; tries < 4; tries++) {
      const z = this.#sampleLane();
      const x = this.#halfWidth(z) + SPAWN_MARGIN + 1.5 * random.next();
      if (this.#crowded(x, z, 0.6)) continue;
      const lantern = this.#freeSlot();
      if (!lantern) return;
      this.#flow(x, z);
      this.#launch(lantern, x, z, this.#water[0] ?? 0, 0, 1, AGE_KEPT);
      if (random.next() < PAIR_CHANCE && this.#count() < this.#target) {
        const x2 = x + 0.45 + 0.4 * random.next();
        const z2 = clamp(z + (random.next() - 0.5) * 1.0, LANE_NEAR, LANE_FAR);
        const companion = this.#freeSlot();
        if (companion && !this.#crowded(x2, z2, 0.45)) this.#launch(companion, x2, z2, this.#water[0] ?? 0, 0, 1, AGE_KEPT);
      }
      return;
    }
  }

  /** Lanterns pushed off from our bank, just below the frame, side by side around x = centre. */
  #release(count: number, centre: number): void {
    const random = this.#random;
    for (let k = 0; k < count; k++) {
      const lantern = this.#slotForExtra();
      const x = centre + (k - (count - 1) / 2) * RELEASE_SPACING + (random.next() - 0.5) * 0.2;
      const z = RELEASE_Z + 0.35 * random.next();
      this.#flow(x, z);
      this.#launch(lantern, x, z, 0.5 * (this.#water[0] ?? 0), RELEASE_PUSH * (0.8 + 0.4 * random.next()), 1, AGE_KEPT);
    }
  }

  #releaseFlotilla(): void {
    const random = this.#random;
    const count = 4 + Math.floor(3 * random.next());
    this.#release(count, (random.next() * 2 - 1) * 0.45 * this.#halfWidth(RELEASE_Z + 1));
  }

  /** The M lantern pushed off from our bank, right of centre so it crosses the whole view. */
  #releaseMark(): void {
    const x = 0.2 * this.#halfWidth(RELEASE_Z + 1);
    this.#flow(x, RELEASE_Z);
    this.#launch(this.#mark, x, RELEASE_Z + 0.2, 0.5 * (this.#water[0] ?? 0), RELEASE_PUSH * 1.15, 1, AGE_KEPT);
    this.#nextMark = Number.POSITIVE_INFINITY;
  }

  /** A lantern set down by hand: dark at first, its candle catching as rings spread from it. */
  #setDown(x: number, z: number): void {
    const lantern = this.#slotForExtra();
    const at = clamp(z, RELEASE_Z, CLICK_FAR);
    this.#flow(x, at);
    this.#launch(lantern, x, at, this.#water[0] ?? 0, this.#water[1] ?? 0, 0, 0);
  }

  /** The water's velocity at (x, z) into #water[0..1] (m/s) and its vorticity into #water[2] (1/s). */
  #flow(x: number, z: number): void {
    const t = this.#clock;
    const stream = this.#current;
    const across = clamp((z - NEAR_SHORE) / RIVER_WIDTH, 0, 1);
    const sine = Math.max(Math.sin(Math.PI * across), 0.05);
    const profile = Math.pow(sine, PROFILE_POWER);
    let u = -stream * profile;
    let w = OUTFLOW * Math.exp(-(z - LANE_NEAR) / OUTFLOW_REACH);
    // The shear across the stream: vorticity -du/dz.
    let vorticity = stream * PROFILE_POWER * Math.pow(sine, PROFILE_POWER - 1) * Math.cos(Math.PI * across) * (Math.PI / RIVER_WIDTH);

    // Eddies: velocity = curl(e psi) = (d(e psi)/dz, -d(e psi)/dx), vorticity = -laplacian(e psi),
    // the envelope e strongest along our bank.
    const near = Math.exp(-(z - LANE_NEAR) / EDDY_REACH);
    const e = EDDY_FLOOR + near;
    const de = -near / EDDY_REACH;
    const dde = near / (EDDY_REACH * EDDY_REACH);
    const drift = EDDY_DRIFT * stream * t;
    let psi = 0;
    let psiX = 0;
    let psiZ = 0;
    let laplacian = 0;
    for (const eddy of this.#eddies) {
      const phase = eddy.kx * (x + drift) + eddy.kz * z + eddy.omega * t + eddy.phase;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      psi += eddy.amp * s;
      psiX += eddy.amp * eddy.kx * c;
      psiZ += eddy.amp * eddy.kz * c;
      laplacian -= eddy.amp * (eddy.kx * eddy.kx + eddy.kz * eddy.kz) * s;
    }
    u += de * psi + e * psiZ;
    w -= e * psiX;
    vorticity -= e * laplacian + 2 * de * psiZ + dde * psi;

    // Rocks: a cylinder in a uniform stream us, u - iw = us (1 - R² / ζ²), its radius grown by a
    // lantern's so their centres follow the streamlines round it; then the wake downstream.
    for (const rock of ROCKS) {
      const us = -stream * profileAt(rock.z);
      const dx = x - rock.x;
      const dz = z - rock.z;
      const r2 = dx * dx + dz * dz;
      const reach = rock.radius + RADIUS;
      const reach2 = reach * reach;
      if (r2 > 0.25 * reach2) {
        const r4 = r2 * r2;
        u -= (us * reach2 * (dx * dx - dz * dz)) / r4;
        w -= (2 * us * reach2 * dx * dz) / r4;
      }
      const downstream = us <= 0 ? -dx : dx;
      if (downstream > 0) {
        const side = dz / (1.3 * reach);
        const lateral = Math.exp(-side * side);
        const fade = Math.exp(-downstream / (WAKE_LENGTH * reach)) * smoothstep(0, reach, downstream);
        u -= us * WAKE_DEFICIT * lateral * fade;
        w += Math.abs(us) * WAKE_SWAY * Math.sin((downstream * 1.2) / reach - t * 0.5 + rock.x) * lateral * fade;
      }
    }

    this.#water[0] = u;
    this.#water[1] = w;
    this.#water[2] = vorticity;
  }

  #step(): void {
    const h = STEP;
    this.#clock += h;
    const all = this.#all;

    // The water's pull, the banks and the hand.
    for (const lantern of all) {
      if (!lantern.alive) continue;
      this.#flow(lantern.x, lantern.z);
      lantern.ax = ((this.#water[0] ?? 0) + this.#wind * WIND_PUSH - lantern.vx) / DRAG;
      lantern.az = ((this.#water[1] ?? 0) - lantern.vz) / DRAG;
      lantern.vorticity = this.#water[2] ?? 0;
      lantern.torque = 0;
      if (lantern.z < LANE_NEAR) lantern.az += (LANE_NEAR - lantern.z) * BANK_PUSH;
      else if (lantern.z > LANE_FAR) lantern.az -= (lantern.z - LANE_FAR) * BANK_PUSH;
      if (this.#hand) {
        const d = Math.hypot(lantern.x - this.#handX, lantern.z - this.#handZ);
        if (d < HAND_RADIUS) {
          const grip = HAND_GRIP * (1 - d / HAND_RADIUS) * (1 - d / HAND_RADIUS);
          lantern.ax += (this.#handVX - lantern.vx) * grip;
          lantern.az += (this.#handVZ - lantern.vz) * grip;
        }
      }
    }

    // Lanterns touching push apart; a glancing knock turns both.
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (!a?.alive) continue;
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (!b?.alive) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const reach = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= reach * reach || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const rvx = b.vx - a.vx;
        const rvz = b.vz - a.vz;
        const closing = rvx * nx + rvz * nz;
        const push = CONTACT * (reach - d) - CONTACT_DAMP * Math.min(closing, 0);
        a.ax -= nx * push;
        a.az -= nz * push;
        b.ax += nx * push;
        b.az += nz * push;
        const slip = rvz * nx - rvx * nz;
        a.torque += (slip * KNOCK) / a.radius;
        b.torque += (slip * KNOCK) / b.radius;
      }
    }

    for (const lantern of all) {
      if (!lantern.alive) continue;
      lantern.lastX = lantern.x;
      lantern.lastZ = lantern.z;
      lantern.lastAngle = lantern.angle;
      lantern.vx += lantern.ax * h;
      lantern.vz += lantern.az * h;
      lantern.x += lantern.vx * h;
      lantern.z += lantern.vz * h;

      // Rocks are solid: a lantern meeting one is set back on its face and eased round it.
      for (const rock of ROCKS) {
        const dx = lantern.x - rock.x;
        const dz = lantern.z - rock.z;
        const d = Math.hypot(dx, dz);
        const reach = rock.radius + lantern.radius;
        if (d >= reach) continue;
        const nx = d > 1e-6 ? dx / d : 0;
        const nz = d > 1e-6 ? dz / d : -1;
        lantern.x = rock.x + nx * reach;
        lantern.z = rock.z + nz * reach;
        const inward = lantern.vx * nx + lantern.vz * nz;
        if (inward < 0) {
          lantern.vx -= inward * nx;
          lantern.vz -= inward * nz;
        }
        const side = Math.abs(nz) > 0.05 ? Math.sign(nz) : lantern.seed < 0.5 ? -1 : 1;
        lantern.vz += side * SLIP * h;
      }

      // Turning: toward half the water's vorticity plus its own slow turn, and the knocks it takes.
      lantern.spin += (0.5 * lantern.vorticity + lantern.ownSpin - lantern.spin) * (h / SPIN_EASE) + lantern.torque * h;
      if (lantern.mark) lantern.spin -= FACE_PULL * Math.sin(2 * lantern.angle) * h;
      lantern.angle += lantern.spin * h;
      if (Math.abs(lantern.angle) > 64) {
        const turns = Math.round(lantern.angle / TAU) * TAU;
        lantern.angle -= turns;
        lantern.lastAngle -= turns;
      }
      lantern.light = Math.min(1, lantern.light + h / LIGHT_UP);
      lantern.age = Math.min(AGE_KEPT, lantern.age + h);

      // Gone downstream past the left edge (or blown far upstream): let it go.
      const half = this.#halfWidth(lantern.z);
      if (lantern.x < -half - EXIT_MARGIN || lantern.x > half + SPAWN_MARGIN + STRAY) {
        lantern.alive = false;
        if (lantern.mark && this.#markOn) this.#nextMark = this.#clock + 2 + 6 * this.#random.next();
      }
    }

    this.#spawn();
    if (this.#markOn && !this.#mark.alive && this.#clock >= this.#nextMark) {
      const z = MARK_LANE_NEAR + (MARK_LANE_FAR - MARK_LANE_NEAR) * this.#random.next();
      const x = this.#halfWidth(z) + SPAWN_MARGIN;
      this.#flow(x, z);
      this.#launch(this.#mark, x, z, this.#water[0] ?? 0, 0, 1, AGE_KEPT);
      this.#nextMark = Number.POSITIVE_INFINITY;
    }
    if (this.#clock >= this.#nextFlotilla) {
      this.#releaseFlotilla();
      const every = FLOTILLA_RARE + (FLOTILLA_OFTEN - FLOTILLA_RARE) * this.#flotilla;
      this.#nextFlotilla = this.#clock + every * (0.6 + 0.8 * this.#random.next());
    }
  }

  /** Keep the river at its count: new lanterns round the bend, or from our bank when far short. */
  #spawn(): void {
    if (this.#clock < this.#nextSpawn) return;
    const deficit = this.#target - this.#count();
    if (deficit <= 0) return;
    const random = this.#random;
    if (deficit > CATCH_UP) {
      this.#release(1, (random.next() * 2 - 1) * 0.5 * this.#halfWidth(RELEASE_Z + 1));
      this.#nextSpawn = this.#clock + CATCH_UP_GAP * (0.7 + 0.6 * random.next());
    } else {
      this.#spawnUpstream();
      this.#nextSpawn = this.#clock + SPAWN_GAP_MIN + (SPAWN_GAP_MAX - SPAWN_GAP_MIN) * random.next();
    }
  }

  #upload(alpha: number): void {
    const data = this.#data;
    const all = this.#all;
    for (let i = 0; i < all.length; i++) {
      const lantern = all[i];
      const o = i * 4;
      const k = (i + MAX_LANTERNS) * 4;
      if (!lantern?.alive) {
        data.fill(0, o, o + 4);
        data.fill(0, k, k + 4);
        continue;
      }
      const angle = lantern.lastAngle + (lantern.angle - lantern.lastAngle) * alpha;
      data[o] = lantern.lastX + (lantern.x - lantern.lastX) * alpha;
      data[o + 1] = lantern.lastZ + (lantern.z - lantern.lastZ) * alpha;
      data[o + 2] = angle - TAU * Math.floor(angle / TAU);
      data[o + 3] = lantern.light;
      data[k] = lantern.seed;
      data[k + 1] = lantern.mark ? 1 : 0;
      data[k + 2] = lantern.age;
      data[k + 3] = lantern.size;
    }

    // Lantern light on the rocks' visible faces: from lanterns on our side of each, and nearby.
    for (let r = 0; r < ROCKS.length; r++) {
      const rock = ROCKS[r];
      if (!rock) continue;
      let light = 0;
      let side = 0;
      for (const lantern of all) {
        if (!lantern.alive) continue;
        const dx = lantern.x - rock.x;
        const dz = lantern.z - rock.z;
        const gap = Math.max(Math.hypot(dx, dz) - rock.radius, 0) / ROCK_GLOW_REACH;
        const front = 0.25 + 0.75 * smoothstep(rock.radius, -rock.radius, dz);
        const share = (lantern.light * lantern.size * front) / (1 + gap * gap);
        light += share;
        side += share * clamp(dx / (rock.radius + gap * ROCK_GLOW_REACH), -1, 1);
      }
      const o = (2 * MAX_LANTERNS + r) * 4;
      data[o] = Math.min(light, 3);
      data[o + 1] = light > 1e-4 ? side / light : 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
    }
    this.#texture.upload(data);
  }
}

/** The lantern river's simulation for a scene whose knobs are `params` (looked up by key). */
export function lanternsSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new LanternRiver(gl, params);
}
