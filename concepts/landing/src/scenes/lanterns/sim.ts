// The lantern river's simulation: paper lanterns floating on a river at dusk (tōrō nagashi), flown
// on the CPU and handed to the shader (shader.ts) as one row of texels.
//
// World units are metres: x along the river (right is upstream, the water runs to the left), z
// across it, away from the viewer, who stands on the near bank EYE metres above the water. The
// water's velocity anywhere is a closed-form sum:
// - the stream, which follows a lane: it comes round the bend far out on the right, along the far
//   side, and sweeps in diagonally toward our bank on the left (a meander's fastest water crossing
//   from one bank to the other). Every streamline is the lane shifted across the river, slower the
//   further from it; its pace grows with distance, so on screen the procession moves at much the
//   same pace near and far. Along our bank it turns to run beside the bank, and a gentle drift out
//   from the bank carries lanterns set down there out;
// - the near stream, a slower current straight along in front of us, which carries a share of the
//   lanterns across the foreground from the right edge to the left;
// - slow eddies, strongest along our bank: the curl of a stream function (a few drifting sines
//   times an envelope across the river), so they swirl the lanterns without gathering or
//   scattering the water;
// - potential flow round each rock (a cylinder in a uniform stream, which parts and closes again
//   round it), and behind it a wake where the stream slows and swings from side to side.
// Lanterns take up the water's velocity with a little inertia, push one another apart where they
// touch (so they bunch against a rock and in slack water, and spread again in the stream), turn
// with the water's spin (half its vorticity, as any small floating body does) and with the knocks
// they take, and slide off the rocks. Both kinds of contact are settled after each step: rocks by
// setting a lantern back on the stone's face, and lanterns sunk into one another past their walls
// (one set down on top of another) by moving them apart (sims/discs.ts).
//
// So the lanterns make a procession: a loose ribbon from small far points of light near the far
// bank on the right, growing as it sweeps in past the near stone, drifting off to the left, and a
// second string of big, close lanterns crossing the foreground. A steady population follows the
// count knob: lanterns leave past the left edge and new ones come round the bend, now and then in
// twos and threes, a few straying wide of their stream. Flotillas are pushed off from our bank,
// just below the frame, and glide along the front; a press, anyone's (SimFrame.principals), sets a
// lantern down on the water under it, its candle catching as rings spread from it; dragging a held
// hand pushes the water along. The M lantern (the landmark) has a slot of its own, keeps to the
// near water where its M reads, keeps turning back to face the bank, and comes round again soon
// after it has gone.
//
// Time runs in fixed steps of STEP seconds of simulated time, so the river depends only on the
// knobs, the seed and simulated time, not on the frame rate; positions are interpolated between
// the last two steps for drawing. The first frame lays the river out and lets it run for PREWARM
// seconds, so the scene opens on an evening already under way. Nothing is allocated per frame.
//
// Passage: arriving, the river opens with its lanterns unlit (the prewarm stops short by the
// entrance's own seconds, so the last arrivals are still upstream), and their candles catch in a
// wave from the right edge to the left; leaving, the flames gutter out one by one (see #flame).
//
// Texture (rgba16f, TEXTURE_WIDTH × 1, nearest):
//   texel i            lantern slot i: x, z (m; z = 0 marks an empty slot), turn (rad, 0..2π),
//                      candle 0..1
//   texel MAX + i      its looks: seed 0..1, 1 for the M lantern, seconds since it was set down on
//                      the water (60 at most), size (1 = LANTERN_HALF by LANTERN_TALL)
//   texel 2 MAX + r    rock r: lantern light falling on its visible face, and from which side
//                      (-1 left .. 1 right)
import { KnobReader, type ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { FixedStep } from "../../sims/clock.ts";
import { separateDiscs } from "../../sims/discs.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame, PrincipalState, ScenePoint } from "../types.ts";
import { PASSAGE_ENTER } from "./constants.ts";

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
export const LANTERN_HALF = 0.17;
export const LANTERN_TALL = 0.4;
export const MARK_SIZE = 1.3;
/** The stream on the lane where it is LANE_PACE metres out (m/s), at either end of the current knob. */
export const CURRENT_SLOW = 0.05;
export const CURRENT_FAST = 0.45;

export interface Rock {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

/** Two stones in the stream: one near, right in the lane, which the procession parts round; one
 *  further out on the lane's near side. */
export const ROCKS: readonly Rock[] = [
  { x: -3, z: 19.7, radius: 0.75, height: 0.36 },
  { x: 3.5, z: 33, radius: 1.3, height: 0.7 },
];

export const TEXTURE_WIDTH = 2 * MAX_LANTERNS + ROCKS.length;

// ---- The river (sim only) ----

const TAU = Math.PI * 2;
/** The lane: its distance across the river straight ahead (m), how much nearer it comes for every
 *  metre downstream, how far out it runs along the far side upstream, and how gently it bends
 *  there (m). At 16:9 the far side shows as a chain of small lights along the far bank over the
 *  right quarter of the frame, which bends into a straight sweep down to the near left. */
const LANE_Z0 = 27.3;
const LANE_SLOPE = 2.56;
const LANE_OUTER = 60;
const LANE_BEND = 5;
/** The stream slackens over this many metres either side of the lane, to this share of its speed. */
const LANE_WIDTH = 6;
const LANE_SLACK = 0.5;
/** The stream's pace along the lane grows with the lane's distance: it runs at the knob's speed
 *  LANE_PACE metres out, slower in the shallows toward our bank, faster in the channel along the
 *  far side, as (distance / LANE_PACE)^PACE_POWER within these bounds. Seen in perspective the
 *  procession then moves at much the same pace near and far (a little faster than in proportion,
 *  where the lane runs away into depth), so it is spread evenly along its path on screen instead
 *  of piling up in the distance. */
const LANE_PACE = 25;
const PACE_POWER = 1.4;
const PACE_MIN = 0.55;
const PACE_MAX = 3;
/** Lanterns keep between these distances (soft walls, m). Between the lane and our bank the stream
 *  flattens out to run beside the bank (over at least BANK_TURN metres), so lanterns there drift
 *  in toward the lane as it comes near instead of being pressed against the bank. */
const LANE_NEAR = 7.6;
const LANE_FAR = 72;
const BANK_PUSH = 1.5;
const BANK_TURN = 6;
/** The drift out from our bank (m/s at LANE_NEAR) and how far out it reaches (m). */
const OUTFLOW = 0.08;
const OUTFLOW_REACH = 2;
/** Right along our bank a little of the stream runs on regardless of the shallows (share of the
 *  knob's speed), so lanterns set down there glide out of view instead of lingering. */
const BANK_DRIFT = 0.25;
/** The near stream: a second, slower current close in front of us (centre and half-width, m; its
 *  own speed as a share of the knob's), carrying lanterns set down from a jetty upstream on our
 *  side across the foreground, big and close, from the right edge to the left. */
const NEAR_Z = 11.5;
const NEAR_WIDTH = 2.2;
const NEAR_PACE = 0.24;
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
const RADIUS = 0.22;
/** Seconds a lantern takes to pick up the water's speed. */
const DRAG = 1.6;
/** Contact springs (1/s²) and the damping of lanterns running into each other (1/s). */
const CONTACT = 6;
const CONTACT_DAMP = 2;
/**
 * The springs let lanterns sink into one another a little. Past the point where their walls meet
 * (centres a side apart, CONTACT_GIVE of the contact distance in) they are moved apart after the
 * step, at up to PART_SPEED (m/s), so two set down on one spot glide off each other within a second.
 * At the default current the river's own drift never brings them that close; at the fastest it
 * now and then does.
 */
const CONTACT_GIVE = 1 - LANTERN_HALF / RADIUS;
const PART_SPEED = 0.6;
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

/** New lanterns float this far either side of the lane (m, roughly the standard deviation); a
 *  share of them stray anywhere between these offsets. A share come on the near stream instead,
 *  this far either side of its centre (m). */
const LANE_SPREAD = 2.2;
const STRAY_SHARE = 0.18;
const STRAY_NEAR = -4;
const STRAY_FAR = 18;
const NEAR_SHARE = 0.3;
const NEAR_SPREAD = 1.6;
/** New lanterns come in this far beyond the frame's right edge, and leave this far beyond its left
 *  (m: past their halo, which is all that shows of them by then). */
const SPAWN_MARGIN = 1.2;
const EXIT_MARGIN = 1.2;
/** A lantern blown this far upstream of the spawn line is let go. */
const STRAY = 6;
/** Arrivals keep the count in view: one crossing of the view shared among the lanterns, varied by
 *  ±50%, sooner when short and later when over; the chance one brings one or two companions. */
const PAIR_CHANCE = 0.35;
/** Short by more than this (the count went up): set lanterns down from our bank, this often (s). */
const CATCH_UP = 5;
const CATCH_UP_GAP = 0.7;
/** Released from our bank: where (m ahead, just below the frame), how hard they are pushed off (m/s), how far apart. */
const RELEASE_Z = 6.3;
const RELEASE_PUSH = 0.4;
const RELEASE_SPACING = 0.55;
/** Seconds between flotillas at frequency 0 and 1 (randomised ±40%), and before the first. */
const FLOTILLA_RARE = 150;
const FLOTILLA_OFTEN = 35;
const FLOTILLA_FIRST = 14;
/** The M lantern keeps to the near water, where its M reads: it is drawn toward this distance
 *  (m) by a soft spring (1/s²), comes in this far beyond the right edge (m) so it is in view within
 *  seconds, and is set down from our bank this far ahead (m, its foot just in the frame). */
const MARK_Z = 13;
const MARK_HOLD = 0.08;
/** The most that spring pulls (m/s²), so its glide out from our bank stays gentle. */
const MARK_PULL = 0.22;
const MARK_MARGIN = 0.8;
const MARK_SET_Z = 7.7;
/** Presses further out than this set the lantern down here (m). */
const CLICK_FAR = 75;
/** Where the cast's agents set lanterns down, uv: the near water, mid-river and further out. */
const SET_DOWN_POINTS: readonly ScenePoint[] = [
  { x: 0.3, y: 0.22 },
  { x: 0.55, y: 0.3 },
  { x: 0.75, y: 0.38 },
];

// ---- Every hand in the water (SimFrame.principals) ----

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
const PREWARM = 20;
const SEED_BASE = 0x70a0a6;

// ---- Passage (entrance and exit) ----

/** The river opens unlit. The candles then catch in a wave that sweeps from the right edge to the
 *  left over these seconds of the entrance (after the old scene's dissolve has cleared), each a
 *  little ahead or behind by up to KINDLE_JITTER of the view's half-width. A lantern still beyond
 *  the right edge waits and catches as it comes in, KINDLE_EDGE of the half-width out. */
const KINDLE_FROM = 0.9;
const KINDLE_TO = 3.7;
const KINDLE_JITTER = 0.18;
const KINDLE_EDGE = 1.02;
/** The wave starts and ends this far (share of the view's half-width) to the right and left of the middle. */
const KINDLE_START_U = 1.15;
const KINDLE_END_U = -1.25;
/** On the way out each flame goes at its own time: it starts guttering between these shares of the
 *  exit and takes GUTTER_SPAN of it to go out. */
const GUTTER_FIRST = 0.04;
const GUTTER_LAST = 0.58;
const GUTTER_SPAN = 0.36;

type KnobKey = "lanterns" | "current" | "flotilla" | "lanternSeed" | "wind" | "mark";

/** The simulation was set up wrong: a knob it reads is missing, or it ran out of lantern slots. */
export class LanternsSimError extends Error {}

/** The lane's distance across the river at x (m): a straight diagonal on the water, bending
 *  upstream (softly, a softplus) to run along the far side. */
function laneZ(x: number): number {
  const t = (LANE_OUTER - LANE_Z0 - LANE_SLOPE * x) / LANE_BEND;
  return LANE_OUTER - LANE_BEND * (t > 30 ? t : Math.log1p(Math.exp(t)));
}

/** The stream's pace (share of the knob's speed) on a lane `centre` metres out. */
function paceAt(centre: number): number {
  return clamp(Math.pow(Math.max(centre, 0) / LANE_PACE, PACE_POWER), PACE_MIN, PACE_MAX);
}

/** How much nearer the lane comes per metre downstream at x: dz/dx of laneZ. */
function laneSlope(x: number): number {
  return LANE_SLOPE / (1 + Math.exp(-(LANE_OUTER - LANE_Z0 - LANE_SLOPE * x) / LANE_BEND));
}

/** Each rock's stream per unit of current: the water it stands in, as #flow has it. */
const ROCK_STREAM = ROCKS.map((rock) => {
  const centre = laneZ(rock.x);
  const off = (rock.z - centre) / LANE_WIDTH;
  const lane = Math.exp(-off * off);
  const pace = paceAt(rock.z) + (paceAt(centre) - paceAt(rock.z)) * lane;
  const speed = (LANE_SLACK + (1 - LANE_SLACK) * lane) * pace;
  const turn = smoothstep(
    LANE_NEAR,
    LANE_NEAR + Math.max(0.6 * (centre - LANE_NEAR), BANK_TURN),
    rock.z,
  );
  return { x: -speed, z: -speed * laneSlope(rock.x) * turn };
});

/** The unit vector downstream from each rock (x, z), for the wakes the shader draws. */
export const ROCK_DOWNSTREAM: readonly { readonly x: number; readonly z: number }[] =
  ROCK_STREAM.map((stream) => {
    const length = Math.hypot(stream.x, stream.z);
    return { x: stream.x / length, z: stream.z / length };
  });

class Lantern {
  alive = false;
  /** False while the river is opening: the candle waits unlit until the entrance's wave reaches it. */
  kindled = true;
  mark = false;
  /** Set down by hand or in a flotilla: on top of the procession's count, not part of it. */
  extra = false;
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
  readonly #knobs: KnobReader<KnobKey>;
  /** The trigger slots of the flotilla and M knobs: their "now" buttons. */
  readonly #flotillaSlot: number;
  readonly #markSlot: number;
  /** The fixed-step clock: STEP seconds of river per step, at most MAX_STEPS owed after a stall. */
  readonly #stepper = new FixedStep(STEP, MAX_STEPS);
  /** The textures handed to the renderer every frame. */
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #random = new Random();
  readonly #regular: readonly Lantern[] = Array.from(
    { length: MAX_LANTERNS - 1 },
    () => new Lantern(),
  );
  readonly #mark = new Lantern();
  /** Every slot in texture order: the regular lanterns, then the M lantern. */
  readonly #all: readonly Lantern[] = [...this.#regular, this.#mark];
  readonly #eddies: readonly Eddy[] = Array.from({ length: EDDY_MODES }, () => new Eddy());
  /** Scratch: the water's velocity (x, z) and vorticity; a point on the water (x, z). */
  readonly #water = new Float64Array(3);
  readonly #point = new Float64Array(2);

  #aspect = 16 / 9;
  #target = 24;
  #current = 0.2;
  #wind = 0;
  #flotilla = 0;
  #markOn = false;
  #markWasOn = false;
  #seed = Number.NaN;

  #clock = 0;
  /** How far the eddies had ridden the stream (m) when the current last changed, at #driftFrom on
   *  the clock: they ride on from there at the new pace, so moving the knob never makes them jump. */
  #drifted = 0;
  #driftFrom = 0;
  #nextSpawn = 0;
  #nextFlotilla = Number.POSITIVE_INFINITY;
  #nextMark = Number.POSITIVE_INFINITY;
  /** Seconds a lantern on the lane takes to cross the view (see #refreshCrossing), and what it was
   *  worked out for. */
  #crossing = 120;
  #crossingKey = Number.NaN;

  /** The entrance is playing: lanterns the river opened with, or that come round the bend, wait unlit. */
  #veil = false;
  /** How far the entrance's wave of kindling has got (0..1), and how far the exit has gone (0..1). */
  #wave = 0;
  #leave = 0;

  /**
   * The hands, by place in SimFrame.principals: whether each pushes the water this frame, whether
   * it was held on the water last frame, where (m) and how fast (m/s).
   */
  readonly #hand = new Uint8Array(MAX_PRINCIPALS);
  readonly #handHeld = new Uint8Array(MAX_PRINCIPALS);
  readonly #handX = new Float64Array(MAX_PRINCIPALS);
  readonly #handZ = new Float64Array(MAX_PRINCIPALS);
  readonly #handVX = new Float64Array(MAX_PRINCIPALS);
  readonly #handVZ = new Float64Array(MAX_PRINCIPALS);

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("lanterns", params, [
      "lanterns",
      "current",
      "flotilla",
      "lanternSeed",
      "wind",
      "mark",
    ]);
    this.#flotillaSlot = this.#knobs.trigger("flotilla");
    this.#markSlot = this.#knobs.trigger("mark");
    this.#mark.mark = true;
    this.#texture = new DataTexture(gl, {
      width: TEXTURE_WIDTH,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#textures = [this.#texture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#target = clamp(Math.round(knobs.value(frame, "lanterns")), 0, MAX_LANTERNS - 1);
    const current =
      CURRENT_SLOW + (CURRENT_FAST - CURRENT_SLOW) * clamp(knobs.value(frame, "current"), 0, 1);
    if (current !== this.#current) {
      this.#drifted += EDDY_DRIFT * this.#current * (this.#clock - this.#driftFrom);
      this.#driftFrom = this.#clock;
      this.#current = current;
    }
    this.#wind = clamp(knobs.value(frame, "wind"), -1, 1);
    this.#flotilla = clamp(knobs.value(frame, "flotilla"), 0, 1);
    this.#markOn = knobs.value(frame, "mark") > 0.5;
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#leave = clamp(frame.passage.exit, 0, 1);
    this.#wave = clamp(
      (frame.passage.enter * PASSAGE_ENTER - KINDLE_FROM) / (KINDLE_TO - KINDLE_FROM),
      0,
      1,
    );

    this.#refreshCrossing();
    const seed = Math.round(knobs.value(frame, "lanternSeed"));
    if (seed !== this.#seed) this.#reset(seed, frame.passage.enter < 1, frame.motion);
    else if (this.#veil && frame.passage.enter >= 1) this.#endVeil();

    // Flotillas on their own: a fresh wait whenever the knob comes on, none while it is off.
    if (this.#flotilla <= 0) this.#nextFlotilla = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.#nextFlotilla))
      this.#nextFlotilla = this.#clock + FLOTILLA_FIRST;
    // Switching the M lantern on sets it on the water from our bank, so it shows at once.
    if (this.#markOn && !this.#markWasOn && !this.#mark.alive) this.#releaseMark();
    this.#markWasOn = this.#markOn;

    // A "now" press releases a flotilla or sets the M lantern down again.
    if (frame.fired[this.#flotillaSlot]) this.#releaseFlotilla();
    if (frame.fired[this.#markSlot]) this.#releaseMark();
    for (let i = 0; i < MAX_PRINCIPALS; i++) this.#follow(i, frame.principals[i], frame);

    const due = this.#stepper.advance(Math.max(0, frame.dt) * Math.max(0, frame.motion));
    for (let i = 0; i < due; i++) this.#step();
    this.#upload(this.#stepper.alpha);
    return this.#textures;
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** The water, near and far, where a press sets a lantern down. */
  interest(): readonly ScenePoint[] {
    return SET_DOWN_POINTS;
  }

  /**
   * Hand `i` (every principal's alike; undefined: not present): a press on the water sets a lantern
   * down there; holding it pushes the water along.
   */
  #follow(i: number, hand: PrincipalState | undefined, frame: SimFrame): void {
    this.#hand[i] = 0;
    const onWater = hand !== undefined && hand.inside && this.#toWater(hand.x, hand.y);
    if (!onWater) {
      this.#handHeld[i] = 0;
      return;
    }
    const x = this.#point[0] ?? 0;
    const z = this.#point[1] ?? 0;
    if (hand.pressed) this.#setDown(x, z);
    if (!hand.down) {
      this.#handHeld[i] = 0;
      return;
    }
    const dt = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    if (this.#handHeld[i] === 1 && dt > 0) {
      let vx = (x - (this.#handX[i] ?? x)) / dt;
      let vz = (z - (this.#handZ[i] ?? z)) / dt;
      const speed = Math.hypot(vx, vz);
      if (speed > HAND_MAX) {
        vx *= HAND_MAX / speed;
        vz *= HAND_MAX / speed;
      }
      this.#handVX[i] = vx;
      this.#handVZ[i] = vz;
      this.#hand[i] = 1;
    }
    this.#handX[i] = x;
    this.#handZ[i] = z;
    this.#handHeld[i] = 1;
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
  #reset(seed: number, entering: boolean, motion: number): void {
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
    this.#drifted = 0;
    this.#driftFrom = 0;
    this.#stepper.reset();
    this.#nextSpawn = 0;
    this.#nextFlotilla = Number.POSITIVE_INFINITY;
    this.#nextMark = Number.POSITIVE_INFINITY;
    this.#hand.fill(0);
    this.#handHeld.fill(0);

    // The evening is already under way: the procession all across the view, settled into the
    // current. The M lantern floats in the near water right of centre, drifting into the middle.
    for (let k = 0; k < this.#target; k++) this.#scatter();
    // Arriving, the river runs on for the entrance's own seconds in real time, so what has to come
    // round the bend by the end of it is still upstream of the view when it opens.
    const prewarm = Math.max(0, PREWARM - (entering ? PASSAGE_ENTER * Math.max(0, motion) : 0));
    for (let s = 0; s < prewarm / STEP; s++) this.#step();
    if (this.#markOn) {
      const x = 0.25 * this.#halfWidth(MARK_Z);
      this.#flow(x, MARK_Z);
      this.#launch(this.#mark, x, MARK_Z, this.#water[0] ?? 0, 0, 1, AGE_KEPT);
    }
    for (const lantern of this.#all) {
      lantern.lastX = lantern.x;
      lantern.lastZ = lantern.z;
      lantern.lastAngle = lantern.angle;
      lantern.age = AGE_KEPT;
    }
    this.#veil = entering;
    if (entering) {
      for (const lantern of this.#all) if (lantern.alive) this.#unlit(lantern);
    }
    this.#nextFlotilla =
      this.#flotilla > 0 ? this.#clock + FLOTILLA_FIRST : Number.POSITIVE_INFINITY;
    this.#markWasOn = this.#markOn;
  }

  /** A lantern that is there while the river is opening waits unlit. */
  #unlit(lantern: Lantern): void {
    lantern.kindled = false;
    lantern.light = 0;
  }

  /** The entrance is over: whatever has not caught yet is out beyond the view; light it. */
  #endVeil(): void {
    this.#veil = false;
    for (const lantern of this.#all) {
      if (lantern.kindled) continue;
      lantern.kindled = true;
      lantern.light = 1;
    }
  }

  /** The flame the shader sees: the candle, guttering out in its turn as the scene leaves. */
  #flame(lantern: Lantern): number {
    if (this.#leave <= 0) return lantern.light;
    const start = GUTTER_FIRST + (GUTTER_LAST - GUTTER_FIRST) * lantern.seed;
    return lantern.light * (1 - smoothstep(start, start + GUTTER_SPAN, this.#leave));
  }

  /** Whether the entrance's wave has reached an unlit lantern: it is in view (or at its right edge)
   *  and the wave, sweeping from the right edge to the left, has passed its place. */
  #kindles(lantern: Lantern): boolean {
    const u = lantern.x / this.#halfWidth(lantern.z);
    if (u > KINDLE_EDGE) return false;
    if (this.#wave >= 1) return true;
    const front = KINDLE_START_U + (KINDLE_END_U - KINDLE_START_U) * this.#wave;
    return u + 2 * KINDLE_JITTER * (lantern.seed - 0.5) >= front;
  }

  /** Put a lantern somewhere on its streamline in view, evenly across the screen as the stream's
   *  pace spreads them in the steady state (laying the river out). */
  #scatter(): void {
    const random = this.#random;
    for (let tries = 0; tries < 6; tries++) {
      this.#place(2.1 * random.next() - 1, 0);
      const x = this.#point[0] ?? 0;
      const z = this.#point[1] ?? NEAR_Z;
      const onRock = ROCKS.some(
        (rock) => Math.hypot(x - rock.x, z - rock.z) < rock.radius + RADIUS + 0.2,
      );
      if (onRock || this.#crowded(x, z, 0.6)) continue;
      const lantern = this.#freeSlot();
      if (!lantern) return;
      this.#flow(x, z);
      this.#launch(lantern, x, z, this.#water[0] ?? 0, this.#water[1] ?? 0, 1, AGE_KEPT);
      return;
    }
  }

  /** Pick a new lantern's streamline (mostly on or about the lane, a share on the near stream) and
   *  where on it it is seen: `frac` of the way from the middle of the view to its right (1) or left
   *  (-1) edge, `margin` metres further out. Writes x, z into #point; returns whether it is on the
   *  near stream. */
  #place(frac: number, margin: number): boolean {
    const random = this.#random;
    if (random.next() < NEAR_SHARE) {
      const z = NEAR_Z + NEAR_SPREAD * (random.next() + random.next() - 1);
      this.#point[0] = frac * this.#halfWidth(z) + (frac < 0 ? -margin : margin);
      this.#point[1] = z;
      return true;
    }
    const offset = this.#sampleOffset();
    const x = this.#seenAt(offset, frac, margin);
    this.#point[0] = x;
    this.#point[1] = clamp(laneZ(x) + offset, LANE_NEAR + 0.3, LANE_FAR);
    return false;
  }

  /** How far off the lane a new lantern floats (m across, + further out): mostly close to it, a few strays. */
  #sampleOffset(): number {
    const random = this.#random;
    if (random.next() < STRAY_SHARE) return STRAY_NEAR + (STRAY_FAR - STRAY_NEAR) * random.next();
    const g = random.next() + random.next() + random.next() - 1.5; // roughly normal, sd 0.5
    return 2 * LANE_SPREAD * g;
  }

  /** Where the streamline `offset` off the lane is seen `frac` of the way from the middle of the
   *  view to its right (1) or left (-1) edge, `margin` metres further out: bisection between the
   *  middle and 200 m out, beyond which the streamline is always out of view. */
  #seenAt(offset: number, frac: number, margin: number): number {
    const side = frac < 0 ? -1 : 1;
    let inside = 0;
    let outside = 200 * side;
    for (let i = 0; i < 24; i++) {
      const x = 0.5 * (inside + outside);
      if (side * (x - frac * this.#halfWidth(Math.max(laneZ(x) + offset, LANE_NEAR))) - margin > 0)
        outside = x;
      else inside = x;
    }
    return outside;
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

  /** Lanterns in the procession (not the M lantern, flotillas or ones set down by hand). */
  #count(): number {
    let n = 0;
    for (const lantern of this.#regular) if (lantern.alive && !lantern.extra) n++;
    return n;
  }

  /** Put a lantern on the water. */
  #launch(
    lantern: Lantern,
    x: number,
    z: number,
    vx: number,
    vz: number,
    light: number,
    age: number,
  ): void {
    const random = this.#random;
    lantern.alive = true;
    lantern.x = lantern.lastX = x;
    lantern.z = lantern.lastZ = z;
    lantern.vx = vx;
    lantern.vz = vz;
    lantern.seed = random.next();
    lantern.size = lantern.mark ? MARK_SIZE : 0.9 + 0.2 * random.next();
    lantern.radius = RADIUS * lantern.size;
    lantern.angle = lantern.lastAngle = lantern.mark
      ? (random.next() - 0.5) * 0.6
      : random.next() * TAU;
    lantern.ownSpin = lantern.mark ? 0 : (random.next() * 2 - 1) * OWN_SPIN;
    lantern.spin = lantern.ownSpin;
    lantern.light = light;
    lantern.age = age;
    lantern.extra = false;
    lantern.kindled = true;
  }

  /** A lantern coming round the bend upstream on its streamline, now and then with one or two
   *  companions just behind it. Returns how many came. */
  #spawnUpstream(): number {
    const random = this.#random;
    for (let tries = 0; tries < 4; tries++) {
      const near = this.#place(1, SPAWN_MARGIN);
      const x0 = this.#point[0] ?? 0;
      const z0 = this.#point[1] ?? NEAR_Z;
      const x = x0 + 1.5 * random.next();
      const z = near ? z0 : clamp(z0 + laneZ(x) - laneZ(x0), LANE_NEAR + 0.3, LANE_FAR);
      if (this.#crowded(x, z, 0.6)) continue;
      const lantern = this.#freeSlot();
      if (!lantern) return 0;
      this.#flow(x, z);
      const vx = this.#water[0] ?? 0;
      const vz = this.#water[1] ?? 0;
      this.#launch(lantern, x, z, vx, vz, 1, AGE_KEPT);
      if (this.#veil) this.#unlit(lantern);
      let arrived = 1;
      const companions = random.next() < PAIR_CHANCE ? 1 + Math.floor(2 * random.next()) : 0;
      for (let k = 1; k <= companions && this.#count() <= this.#target; k++) {
        const x2 = x + k * (0.5 + 0.4 * random.next());
        const follow = near ? 0 : laneZ(x2) - laneZ(x);
        const z2 = clamp(z + follow + (random.next() - 0.5) * 1.2, LANE_NEAR + 0.3, LANE_FAR);
        const companion = this.#freeSlot();
        if (!companion || this.#crowded(x2, z2, 0.5)) continue;
        this.#launch(companion, x2, z2, vx, vz, 1, AGE_KEPT);
        if (this.#veil) this.#unlit(companion);
        arrived++;
      }
      return arrived;
    }
    return 0;
  }

  /** Lanterns pushed off from our bank, just below the frame, side by side around x = centre;
   *  `extra` ones are on top of the procession's count. */
  #release(count: number, centre: number, extra: boolean): void {
    const random = this.#random;
    for (let k = 0; k < count; k++) {
      const lantern = this.#slotForExtra();
      const x = centre + (k - (count - 1) / 2) * RELEASE_SPACING + (random.next() - 0.5) * 0.2;
      const z = RELEASE_Z + 0.35 * random.next();
      this.#flow(x, z);
      this.#launch(
        lantern,
        x,
        z,
        0.5 * (this.#water[0] ?? 0),
        RELEASE_PUSH * (0.8 + 0.4 * random.next()),
        1,
        AGE_KEPT,
      );
      lantern.extra = extra;
    }
  }

  /** A flotilla pushed off from our bank right of centre: it glides out and along the front. */
  #releaseFlotilla(): void {
    const random = this.#random;
    const count = 3 + Math.floor(3 * random.next());
    this.#release(count, (0.1 + 0.35 * random.next()) * this.#halfWidth(RELEASE_Z + 1), true);
  }

  /** The M lantern set down from our bank right of centre, its foot just in the frame: it glides
   *  out to the near water (MARK_Z) and drifts across the whole view. */
  #releaseMark(): void {
    const x = 0.35 * this.#halfWidth(MARK_SET_Z);
    this.#flow(x, MARK_SET_Z);
    this.#launch(this.#mark, x, MARK_SET_Z, this.#water[0] ?? 0, 0.15, 1, AGE_KEPT);
    this.#nextMark = Number.POSITIVE_INFINITY;
  }

  /** A lantern set down by hand: dark at first, its candle catching as rings spread from it. */
  #setDown(x: number, z: number): void {
    const lantern = this.#slotForExtra();
    const at = clamp(z, RELEASE_Z, CLICK_FAR);
    this.#flow(x, at);
    this.#launch(lantern, x, at, this.#water[0] ?? 0, this.#water[1] ?? 0, 0, 0);
    lantern.extra = true;
  }

  /** The water's velocity at (x, z) into #water[0..1] (m/s) and its vorticity into #water[2] (1/s). */
  #flow(x: number, z: number): void {
    const t = this.#clock;
    const stream = this.#current;
    // The stream along the lane, slackening either side of it. Streamlines are the lane shifted
    // across the river: u = -U p(x) s(o), w = -U p(x) s(o) z'(x) with o = z - laneZ(x) and p the
    // pace. Its vorticity is U (p (s'(o) (1 + z'²) - s(o) z'') - s(o) p' z'); where the pace falls
    // downstream the stream converges along the lane, so the lanterns close up as they come near.
    // Away from the lane the slack water keeps the pace of its own distance, so the shallows in
    // front of us stay slow even where the lane is far out.
    // Between the lane and our bank the stream flattens out to run beside the bank, so lanterns
    // there drift in toward the lane as it comes near; right along the bank a little of the stream
    // runs on regardless of the shallows; and the near stream runs straight along in front of us
    // (the vorticity of the first two is left out).
    const centre = laneZ(x);
    const slope = laneSlope(x);
    const curve = (-slope * (LANE_SLOPE - slope)) / LANE_BEND;
    const off = (z - centre) / LANE_WIDTH;
    const lane = Math.exp(-off * off);
    const speed = LANE_SLACK + (1 - LANE_SLACK) * lane;
    const dSpeed = (-(1 - LANE_SLACK) * 2 * off * lane) / LANE_WIDTH;
    const lanePace = paceAt(centre);
    const pace = paceAt(z) + (lanePace - paceAt(z)) * lane;
    const dPace =
      lanePace > PACE_MIN && lanePace < PACE_MAX
        ? (PACE_POWER * lanePace * slope * lane) / Math.max(centre, 1)
        : 0;
    const turn = smoothstep(
      LANE_NEAR,
      LANE_NEAR + Math.max(0.6 * (centre - LANE_NEAR), BANK_TURN),
      z,
    );
    const across = (z - NEAR_Z) / NEAR_WIDTH;
    const nearStream = NEAR_PACE * Math.exp(-across * across);
    let u =
      -stream *
      (speed * pace +
        nearStream +
        BANK_DRIFT * (1 - smoothstep(LANE_NEAR + 1, LANE_NEAR + 4.5, z)));
    let w =
      -stream * speed * pace * slope * turn + OUTFLOW * Math.exp(-(z - LANE_NEAR) / OUTFLOW_REACH);
    let vorticity =
      stream *
      (pace * (dSpeed * (1 + slope * slope) - speed * curve) -
        speed * dPace * slope -
        (2 * nearStream * across) / NEAR_WIDTH);

    // Eddies: velocity = curl(e psi) = (d(e psi)/dz, -d(e psi)/dx), vorticity = -laplacian(e psi),
    // the envelope e strongest along our bank.
    const near = Math.exp(-(z - LANE_NEAR) / EDDY_REACH);
    const e = EDDY_FLOOR + near;
    const de = -near / EDDY_REACH;
    const dde = near / (EDDY_REACH * EDDY_REACH);
    // The eddies ride the stream: EDDY_DRIFT of the current, summed over the time it ran at each
    // setting (#drifted), so moving the knob changes their pace, never where they are.
    const drift = this.#drifted + EDDY_DRIFT * stream * (t - this.#driftFrom);
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

    // Rocks: a cylinder in the uniform stream q = a + ib it stands in. By the circle theorem the
    // complex potential is conj(q) ζ + q R² / ζ, so u - iw = conj(q) - q R² conj(ζ)² / |ζ|⁴; its
    // radius is grown by a lantern's so their centres follow the streamlines round it. Then the
    // wake downstream, slowed and swinging from side to side.
    for (let r = 0; r < ROCKS.length; r++) {
      const rock = ROCKS[r];
      const flow = ROCK_STREAM[r];
      if (!rock || !flow) continue;
      const a = stream * flow.x;
      const b = stream * flow.z;
      const dx = x - rock.x;
      const dz = z - rock.z;
      const r2 = dx * dx + dz * dz;
      const reach = rock.radius + RADIUS;
      const reach2 = reach * reach;
      if (r2 > 0.25 * reach2) {
        const k = reach2 / (r2 * r2);
        const re = dx * dx - dz * dz;
        const im = 2 * dx * dz;
        u -= (a * re + b * im) * k;
        w += (b * re - a * im) * k;
      }
      const mag = Math.hypot(a, b);
      if (mag < 1e-6) continue;
      const ax = a / mag;
      const az = b / mag;
      const downstream = dx * ax + dz * az;
      if (downstream > 0) {
        const side = (ax * dz - az * dx) / (1.3 * reach);
        const shade =
          Math.exp(-side * side) *
          Math.exp(-downstream / (WAKE_LENGTH * reach)) *
          smoothstep(0, reach, downstream);
        const sway =
          mag * WAKE_SWAY * Math.sin((downstream * 1.2) / reach - t * 0.5 + rock.x) * shade;
        u += -a * WAKE_DEFICIT * shade - az * sway;
        w += -b * WAKE_DEFICIT * shade + ax * sway;
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
      // The M lantern keeps to the near water, where its M reads.
      if (lantern.mark)
        lantern.az += clamp((MARK_Z - lantern.z) * MARK_HOLD, -MARK_PULL, MARK_PULL);
      for (let h = 0; h < MAX_PRINCIPALS; h++) {
        if (this.#hand[h] !== 1) continue;
        const d = Math.hypot(lantern.x - (this.#handX[h] ?? 0), lantern.z - (this.#handZ[h] ?? 0));
        if (d < HAND_RADIUS) {
          const grip = HAND_GRIP * (1 - d / HAND_RADIUS) * (1 - d / HAND_RADIUS);
          lantern.ax += ((this.#handVX[h] ?? 0) - lantern.vx) * grip;
          lantern.az += ((this.#handVZ[h] ?? 0) - lantern.vz) * grip;
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
    }

    // Lanterns sunk into one another past their walls (set down on top of one another, or a
    // flotilla pushed off onto the last) glide apart; the springs above handle ordinary contact.
    separateDiscs(all, { give: CONTACT_GIVE, limit: PART_SPEED * h });

    for (const lantern of all) {
      if (!lantern.alive) continue;
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
      lantern.spin +=
        (0.5 * lantern.vorticity + lantern.ownSpin - lantern.spin) * (h / SPIN_EASE) +
        lantern.torque * h;
      if (lantern.mark) lantern.spin -= FACE_PULL * Math.sin(2 * lantern.angle) * h;
      lantern.angle += lantern.spin * h;
      if (Math.abs(lantern.angle) > 64) {
        const turns = Math.round(lantern.angle / TAU) * TAU;
        lantern.angle -= turns;
        lantern.lastAngle -= turns;
      }
      if (lantern.kindled) lantern.light = Math.min(1, lantern.light + h / LIGHT_UP);
      else if (this.#kindles(lantern)) lantern.kindled = true;
      lantern.age = Math.min(AGE_KEPT, lantern.age + h);

      // Gone downstream past the left edge (or blown far upstream): let it go.
      const half = this.#halfWidth(lantern.z);
      if (lantern.x < -half - EXIT_MARGIN || lantern.x > half + SPAWN_MARGIN + STRAY) {
        lantern.alive = false;
        if (lantern.mark && this.#markOn)
          this.#nextMark = this.#clock + 2 + 4 * this.#random.next();
      }
    }

    this.#spawn();
    if (this.#markOn && !this.#mark.alive && this.#clock >= this.#nextMark) {
      const z = MARK_Z + (this.#random.next() - 0.5);
      const x = this.#halfWidth(z) + MARK_MARGIN;
      this.#flow(x, z);
      this.#launch(this.#mark, x, z, this.#water[0] ?? 0, this.#water[1] ?? 0, 1, AGE_KEPT);
      this.#nextMark = Number.POSITIVE_INFINITY;
    }
    if (this.#clock >= this.#nextFlotilla) {
      this.#releaseFlotilla();
      const every = FLOTILLA_RARE + (FLOTILLA_OFTEN - FLOTILLA_RARE) * this.#flotilla;
      this.#nextFlotilla = this.#clock + every * (0.6 + 0.8 * this.#random.next());
    }
  }

  /** Keep the river at its count. Lanterns come round the bend at the rate that keeps that many in
   *  view (one crossing of the view shared among them, varied ±50%), sooner when short and later
   *  when over, so the procession has lanterns at every distance rather than in waves; when far
   *  short (the count went up) they are set down from our bank instead. */
  #spawn(): void {
    if (this.#clock < this.#nextSpawn || this.#target <= 0) return;
    const random = this.#random;
    const count = this.#count();
    const gap = this.#crossing / this.#target;
    if (this.#target - count > CATCH_UP) {
      this.#release(1, (random.next() * 2 - 1) * 0.5 * this.#halfWidth(RELEASE_Z + 1), false);
      this.#nextSpawn = this.#clock + CATCH_UP_GAP * (0.7 + 0.6 * random.next());
    } else if (count > this.#target) {
      this.#nextSpawn = this.#clock + 0.5 * gap;
    } else {
      const arrived = this.#spawnUpstream();
      const lean = count < this.#target - 1 ? 0.7 : 1.2;
      this.#nextSpawn =
        this.#clock + gap * Math.max(arrived, 1) * lean * (0.7 + 0.6 * random.next());
    }
  }

  /** Seconds a lantern on the lane takes to cross the view, from coming in to leaving, at this
   *  current and aspect (worked out again when either changes). */
  #refreshCrossing(): void {
    const key = this.#aspect * 1000 + this.#current;
    if (key === this.#crossingKey) return;
    this.#crossingKey = key;
    const from = this.#seenAt(0, -1, EXIT_MARGIN);
    const to = this.#seenAt(0, 1, SPAWN_MARGIN);
    const steps = 32;
    const dx = (to - from) / steps;
    let time = 0;
    for (let i = 0; i < steps; i++) {
      time += dx / (this.#current * paceAt(laneZ(from + (i + 0.5) * dx)));
    }
    this.#crossing = Math.max(time, 1);
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
      data[o + 3] = this.#flame(lantern);
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
        const share = (this.#flame(lantern) * lantern.size * front) / (1 + gap * gap);
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
