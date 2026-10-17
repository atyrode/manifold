// The city crossing's simulation: a scramble crossing where a side street meets an avenue, seen
// from a high window, run on the CPU and handed to the shader (shader.ts) as three textures.
//
// World units are metres: x right along the avenue, y up, z away from the window. The eye is
// CAM_H up at x = CAM_X, z = 0, looking up the side street and down at the crossing. The avenue
// runs across the view (kerbs at KERB_NEAR and KERB_FAR, traffic on the left as in Japan:
// eastbound on the far half, westbound on the near half); the side street leaves it straight
// ahead between two blocks (kerbs at ±SIDE_KERB, facades at ±SIDE_FACADE), so the junction is a
// T. Five crosswalks meet in it: W and E across the avenue, N across the side street's mouth, and
// two diagonals across the middle (D1 from the near left to the far right corner, D2 mirrored).
//
// The lights run one cycle (the `signal` knob, in seconds): the avenue's traffic goes (and its
// eastbound cars may turn left into the side street), amber, all red; the side street's traffic
// comes down and turns either way, amber, all red; then every crosswalk turns green at once (the
// scramble), flashes, all red. A click on the street or the knob's "now" button cuts the phase
// that is running short.
//
// Walkers. Each comes out of somewhere (an edge of the view, the station stairs under the window,
// a shop under it, the konbini or the café door, the far end of the side street) and is going
// somewhere else. A route is a handful of waypoints: along its sidewalk (round the corner of the
// far blocks if need be) to a kerb, across, and on to its exit; between the near sidewalk and a
// far corner it takes the straight crosswalk or the diagonal, whichever is shorter (with a little
// whim). At the kerb it waits for the green man: it picks a free spot in the crowd gathering
// there (the first-comers at the kerb, later ones behind), stands still, faces the street and
// now and then looks about. When the green man comes on the crowd steps off front first, each a
// beat after the one in front (a reaction time plus about half a second per metre behind the
// kerb), so the wave runs back through it. Walking is the social force model (D. Helbing and P.
// Molnár, "Social force model for pedestrian dynamics", Phys. Rev. E 51, 1995): a pull toward the
// next waypoint at the walker's own pace, exponential repulsion from the people near it, stronger
// from those ahead than behind, a firm push on contact, and a sidestep to the left from people
// coming the other way, which sorts counterflowing crowds into lanes on the crossing. Walkers
// keep to their sidewalk (soft walls, the corners rounded) except on a crossing, and a share of
// them come in pairs, keeping beside each other. Along a sidewalk they keep in from the kerb,
// stepping out to it only where they cross, and round the inside corner of a far block rather
// than into its wall. They step round the lamp and signal poles and the vending machines: these
// stand by the kerb or the wall, where the walkable sidewalk leaves no room behind them, so a
// walker held up by one in its way slides round it on the side that has room (a repulsion alone
// would stand it still there for good). A watchdog sees to any walker still pinned on its way: it
// joins the crowd at its kerb if it is that near, else steps aside, and in the end gives up its way:
// out of view it leaves there and then, in view it sets off for the nearest way out of its
// sidewalk (never vanishing where it can be seen), so nobody stands there for good or keeps
// newcomers away (they come while the crowd is short). People on the crossing when the green man
// flashes hurry. Standing walkers are frozen in place until somebody squeezes past: under the
// dither, a fidgeting crowd would shimmer.
//
// Rain or snow: each walker with an umbrella (most have one) opens it a few seconds after the
// fall starts (some at the first drops, some only when it is coming down properly) and closes it
// a while after it stops; walkers arriving in the rain come with it open.
//
// The pointer: walkers within LOOK_RADIUS of the point on the street under it look up at the
// window after a moment (tilting their umbrella back), and walk on a little slower; a click
// changes the lights.
//
// The school outing (a feature with a "now" trigger): a teacher leads small children in yellow
// hats two by two, each following the child ahead, an assistant at the end of the line; they wait
// and cross with everyone else, the line kept to its sidewalk until the one ahead steps off.
//
// The late delivery (a feature with a "now" trigger, off by default): now and then a white van comes
// along the avenue, crosses the junction and pulls in to the far kerb past the konbini, beyond the
// crossing and its crosswalks, blinker on; at the kerb its hazards blink while its driver wheels
// crates on a hand truck across the sidewalk to the konbini's service door and back, a few trips,
// then climbs in and the van pulls out into the traffic again (sims/errand.ts runs the episode's
// steps). The driver walks with the crowd's social force, so walkers step round the loaded trolley
// and it waits for them; cars pass the parked van close by, cyclists in the kerb lane swing out
// round it (waiting behind it while a car is coming). As it eases in, it and they keep in one file,
// neither passing the other; it pulls out once its lane and theirs are clear behind it, and the
// cars and cyclists that come up behind it keep behind it.
//
// Vehicles follow paths (straight lanes and turning arcs, sampled every PATH_STEP metres), their
// speed set by the intelligent driver model (M. Treiber, A. Hennecke, D. Helbing, "Congested
// traffic states in empirical observations and microscopic simulations", Phys. Rev. E 62, 2000):
// a free-road pace, eased on bends, a safe gap to the vehicle ahead in the lanes their path runs
// along, a stop line that is a standing obstacle while their light is red (or amber, if they can
// still stop) or while the way out of the junction has no room for them (they never stand in it
// across the cross traffic's way), and any walker still on the street in front of them; turning,
// they give way to anyone coming along the lanes they turn across (a left turn waits for the
// bicycles in the kerb lane). Cars, taxis, kei cars, vans and bicycles come in from the three ends
// at random (the `traffic` knob) and queue at the red.
//
// Time runs in fixed steps of STEP seconds of simulated time (motion-scaled, sims/clock.ts), so the
// street depends only on the knobs, the seed and simulated time, not on the frame rate; positions
// are interpolated between the last two steps for drawing. A seed lays the street out a few seconds
// before the scramble (crowds waiting at the kerbs, the avenue's traffic queued at its red light)
// and runs it for PREWARM seconds, the walkers on the opening's own paths (#layingOut): a count of
// steps, spread over as many frames as the frame's budget needs, while the clock holds and the
// textures keep what they show (on a reseed, the old street). Nothing is allocated per frame.
//
// The scene's passage (SceneDef.passage, STREET_PASSAGE): the camera comes down from the skyline onto
// the crossing as the crowd walks in along its sidewalks to where it gathers, and on the way out it
// tilts up again. The tilt (passageTilt) is the window's pitch raised above its rest value; the shader
// reads the same tilt from passageIn() / passageOut(), and the pointer is traced with it. The crowd's
// walk-in only moves where walkers are drawn (and binned), never the simulation, and draws no random
// numbers. Both are exactly off at rest.
//
// Textures:
//   uSim0  rgba16f, MAX_AGENTS × 2, nearest. Slot i (walkers first, then vehicles):
//          row 0: x, z − Z_REF (m), heading (rad: direction cos, sin in x, z), kind (KIND_*; 0 empty)
//          row 1: walkers and bicycles: umbrella open 0..1, looking up 0..1 (a porter: crates on its
//                 trolley), gait phase 0..1, seed;
//                 motor vehicles: brake 0..1, blinker (+1 left, −1 right, 2 hazards, 0), speed (m/s), seed
//   uSim1  rgba8, TILES_X·TILE_TEXELS × TILES_Z, nearest: for each TILE-metre square of the street,
//          the first TILE_BODIES / 4 texels hold up to TILE_BODIES agent slots + 1 (0: none) whose
//          bodies may be seen through it (seen from the window, a body covers the ground from its
//          feet to where the ray past its top lands), nearest the window first; the next
//          TILE_LIGHTS / 4 texels up to TILE_LIGHTS vehicles whose lamps light it (beams, tail
//          glow, their halo and their reflection).
//   uSim2  rgba16f, 3 × 1, nearest: texel 0 the avenue's lights (green, amber, red, 0), texel 1 the
//          side street's, texel 2 the walk signals (green man, red man, 0, 0), each eased over
//          LAMP_FADE seconds; the green man blinks while the walk phase runs out.
import type { ParamDef } from "../../params.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import { DataTexture } from "../../sims/texture.ts";
import { Errand } from "../../sims/errand.ts";
import { clamp, fract, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- The view and the street, shared with the shader ----

/** The eye: x (m), height (m), pitch below the horizontal (rad, 42°), focal length (screen heights
 *  per unit of slope: a 37° vertical field of view). The window is a little left of the side
 *  street, so the crossing sits right of centre and the lower left (the page's copy) looks down
 *  the quieter avenue with its queue of cars. */
export const CAM_X = -5;
export const CAM_H = 28;
export const PITCH = 0.733;
export const FOCAL = 1.5;
/** Positions go to the shader as z − Z_REF, which keeps them small for half floats. */
export const Z_REF = 40;

/** The avenue's kerbs, the near buildings (out of view below the frame), the far facades. */
export const KERB_NEAR = 22;
export const KERB_FAR = 40;
export const FACADE_NEAR = 14;
export const FACADE_FAR = 45;
/** The side street: kerbs and facades at ±these x; the far corners' kerbs are rounded. */
export const SIDE_KERB = 6;
export const SIDE_FACADE = 9;
export const CORNER_RADIUS = 2;
/** The avenue's centre line, and its lanes (z; the bicycles ride along the kerb). */
export const AVENUE_MID = 31;
export const LANE_EB_IN = 33.85;
export const LANE_EB_OUT = 37.15;
export const LANE_EB_BIKE = 38.75;
export const LANE_WB_IN = 28.15;
export const LANE_WB_OUT = 24.85;
export const LANE_WB_BIKE = 23.25;
/** The side street's lanes (x): coming down to the junction, its bicycles, and going up. */
export const LANE_SB = 3;
const LANE_SB_BIKE = 4.9;
export const LANE_NB = -3;
/** Stop lines: where the eastbound and westbound fronts stop (x), and the southbound (z). */
export const STOP_EB = -12.4;
export const STOP_WB = 12.4;
export const STOP_SB = 47.4;
/** Crosswalks: W and E centred at x = ∓CROSS_WE, N centred at z = CROSS_N, all 2·CROSS_HALF wide;
 *  the diagonals run from x = ±DIAG_NEAR on the near kerb to (∓DIAG_FAR, DIAG_FAR_Z) on the far
 *  corners. */
export const CROSS_WE = 9.5;
export const CROSS_HALF = 2;
export const CROSS_N = 44.5;
export const DIAG_NEAR = 6.6;
export const DIAG_FAR = 6.75;
export const DIAG_FAR_Z = 40.6;
/** The zebra M (the landmark): W and E are its legs, its V dips to (0, MARK_APEX_Z). */
export const MARK_APEX_Z = 29.6;

/** A pole on the sidewalk: base (m), height (m); walkers step round it. */
interface Pole {
  readonly x: number;
  readonly z: number;
  readonly height: number;
}

/** Street lamps: on the kerbs, their arms reaching over the road (toward the avenue's middle, or
 *  the side street's), LED white along the avenue, old sodium amber up the side street. The four on
 *  the signal poles light the crossings. */
export interface Lamp extends Pole {
  /** Where the head hangs, over the road. */
  readonly hx: number;
  readonly hz: number;
  readonly warm: boolean;
}

export const LAMPS: readonly Lamp[] = [
  { x: -25.5, z: 21.6, height: 7.2, hx: -25.5, hz: 23.2, warm: false },
  { x: -1.0, z: 21.6, height: 7.2, hx: -1.0, hz: 23.2, warm: false },
  { x: 23.5, z: 21.6, height: 7.2, hx: 23.5, hz: 23.2, warm: false },
  { x: -12.4, z: 21.55, height: 8.0, hx: -10.6, hz: 23.5, warm: false },
  { x: 12.4, z: 21.55, height: 8.0, hx: 10.6, hz: 23.5, warm: false },
  { x: -12.4, z: 40.45, height: 8.0, hx: -10.6, hz: 38.5, warm: false },
  { x: 12.4, z: 40.45, height: 8.0, hx: 10.6, hz: 38.5, warm: false },
  { x: -23.0, z: 40.4, height: 7.2, hx: -23.0, hz: 38.8, warm: false },
  { x: 21.0, z: 40.4, height: 7.2, hx: 21.0, hz: 38.8, warm: false },
  { x: -6.4, z: 61.0, height: 6.4, hx: -5.3, hz: 61.0, warm: true },
  { x: 6.4, z: 72.0, height: 6.4, hx: 5.3, hz: 72.0, warm: true },
];

/** Signal poles at the corners, and two small ones for the N crosswalk's walk signals. */
export const SIGNAL_POLES: readonly Pole[] = [
  { x: -12.4, z: 21.55, height: 6.0 },
  { x: 12.4, z: 21.55, height: 6.0 },
  { x: -12.4, z: 40.45, height: 6.0 },
  { x: 12.4, z: 40.45, height: 6.0 },
  { x: -6.45, z: 47.6, height: 3.1 },
  { x: 6.45, z: 47.6, height: 3.1 },
];

/** Vending machines against the walls: x0, x1, z0, z1 (m). Walkers step round them. */
export const VENDING: readonly (readonly [number, number, number, number])[] = [
  [-14.65, -12.95, 44.25, 45.0],
  [8.25, 9.0, 50.0, 51.6],
];

/** Doors walkers use: the café on the far left block, the konbini on the far right corner. */
const CAFE_DOOR = -17.5;
const KONBINI_DOOR = 14.0;

// ---- Agents ----

/** Kinds in uSim0 row 0 .w. */
const KIND_ADULT = 1;
export const KIND_CHILD = 2;
export const KIND_BIKE = 3;
const KIND_SEDAN = 4;
export const KIND_TAXI = 5;
export const KIND_KEI = 6;
export const KIND_VAN = 7;
/** The late delivery's driver on foot, wheeling a hand truck (drawn as a walker). */
export const KIND_PORTER = 8;

/** A vehicle's box seen from above: length, width (m), the top of its body and of its cabin (m),
 *  and where its cabin runs along it (m from its centre, rear and front). Bicycles: the rider's
 *  head height as `top`. Indexed by kind. */
interface VehicleShape {
  readonly length: number;
  readonly width: number;
  readonly body: number;
  readonly top: number;
  readonly cabinBack: number;
  readonly cabinFront: number;
}

export const SHAPES: readonly VehicleShape[] = [
  { length: 0, width: 0, body: 0, top: 0, cabinBack: 0, cabinFront: 0 },
  { length: 0, width: 0, body: 0, top: 0, cabinBack: 0, cabinFront: 0 },
  { length: 0, width: 0, body: 0, top: 0, cabinBack: 0, cabinFront: 0 },
  { length: 1.75, width: 0.6, body: 0.95, top: 1.5, cabinBack: -0.3, cabinFront: 0.2 },
  { length: 4.5, width: 1.76, body: 0.92, top: 1.45, cabinBack: -1.4, cabinFront: 0.85 },
  { length: 4.6, width: 1.7, body: 0.92, top: 1.5, cabinBack: -1.35, cabinFront: 0.9 },
  { length: 3.4, width: 1.48, body: 0.85, top: 1.68, cabinBack: -1.55, cabinFront: 0.95 },
  { length: 4.7, width: 1.72, body: 0.95, top: 1.98, cabinBack: -2.25, cabinFront: 1.15 },
  { length: 0, width: 0, body: 0, top: 0, cabinBack: 0, cabinFront: 0 },
];

/** The simulation was set up wrong: a knob it reads is missing, a phase is unknown, or its slots
 *  outgrow the tile lists. */
class StreetSimError extends Error {}

/** Walker and vehicle slots: walkers first. */
export const MAX_WALKERS = 160;
const MAX_VEHICLES = 54;
export const MAX_AGENTS = MAX_WALKERS + MAX_VEHICLES;

/** The tile grid over the street (m): origin, size, count; slots per tile. It spans what the window
 *  sees at the far kerb on the widest frame (32:9: x from about −62 to 52 at z = 40). */
export const TILE_X0 = -64;
export const TILE_Z0 = 12;
export const TILE = 1;
export const TILES_X = 120;
export const TILES_Z = 72;
export const TILE_BODIES = 16;
export const TILE_LIGHTS = 12;
export const TILE_TEXELS = (TILE_BODIES + TILE_LIGHTS) / 4;
// A tile lists an agent as its slot + 1 in a byte (0: none), which the shader reads back as
// int(code · 255 + 0.5) − 1; the slots stay under 255, with the byte's top value to spare.
if (MAX_AGENTS > 254) {
  throw new StreetSimError(`street: ${MAX_AGENTS} agent slots do not fit the tile lists' bytes`);
}

/** The tallest a walker stands with an open umbrella over it (m); its widest reach from its feet
 *  (m: an umbrella tipped forward, into the wind and back to look up). */
const WALKER_TOP = 2.3;
const WALKER_REACH = 0.9;
/** A porter's reach from its feet with the hand truck before it (the shader's truck ends 0.98 m out). */
const PORTER_TRUCK_REACH = 1.1;
/** How far a car's low beam lights the road ahead (m), a bicycle lamp's, and the tail glow behind. */
export const BEAM_REACH = 12;
export const BIKE_BEAM_REACH = 6;
const TAIL_REACH = 3;
/** How far a lamp's reflection on wet asphalt runs toward the window (m), beyond the beam. */
const STREAK_REACH = 7;

// ---- Signals ----

const PHASES = [
  "avenue",
  "avenueAmber",
  "clearA",
  "side",
  "sideAmber",
  "clearB",
  "walk",
  "flash",
  "clearC",
] as const;
type Phase = (typeof PHASES)[number];
type Light = "green" | "amber" | "red";

/** Fixed parts of the cycle (s): amber, all red, the green man flashing. */
const AMBER = 3;
const ALL_RED = 2;
const FLASH = 5;
const FIXED = 2 * AMBER + 3 * ALL_RED + FLASH;
/** How the rest of the cycle is shared: avenue, side street, walk. */
const SHARE_AVENUE = 0.45;
const SHARE_SIDE = 0.2;
const SHARE_WALK = 0.35;
/** Seconds a lamp takes to come on or go off (LEDs, but the dither should see one step). */
const LAMP_FADE = 0.12;

function phaseLength(phase: Phase, cycle: number): number {
  const flex = Math.max(cycle - FIXED, 24);
  switch (phase) {
    case "avenue":
      return SHARE_AVENUE * flex;
    case "side":
      return SHARE_SIDE * flex;
    case "walk":
      return SHARE_WALK * flex;
    case "avenueAmber":
    case "sideAmber":
      return AMBER;
    case "flash":
      return FLASH;
    case "clearA":
    case "clearB":
    case "clearC":
      return ALL_RED;
    default: {
      const unreachable: never = phase;
      throw new StreetSimError(`street: unknown signal phase ${String(unreachable)}`);
    }
  }
}

class Signals {
  index = 0;
  elapsed = 0;
  cycle = 80;
  /** Lamp brightness, eased: avenue green/amber/red, side green/amber/red, green man, red man. */
  readonly lamps = new Float64Array(8);
  readonly #targets = new Float64Array(8);

  get phase(): Phase {
    return PHASES[this.index] ?? "avenue";
  }

  get length(): number {
    return phaseLength(this.phase, this.cycle);
  }

  get remaining(): number {
    return this.length - this.elapsed;
  }

  get walk(): boolean {
    return this.phase === "walk";
  }

  get flash(): boolean {
    return this.phase === "flash";
  }

  avenue(): Light {
    const phase = this.phase;
    return phase === "avenue" ? "green" : phase === "avenueAmber" ? "amber" : "red";
  }

  side(): Light {
    const phase = this.phase;
    return phase === "side" ? "green" : phase === "sideAmber" ? "amber" : "red";
  }

  /** Advance the clock; returns true when the walk phase has just begun. */
  step(dt: number): boolean {
    this.elapsed += dt;
    let walkBegan = false;
    while (this.elapsed >= this.length) {
      this.elapsed -= this.length;
      this.index = (this.index + 1) % PHASES.length;
      if (this.phase === "walk") walkBegan = true;
    }
    this.#ease(dt);
    return walkBegan;
  }

  /** Cut the running phase short: a green goes to amber (or the green man to flashing) at once; a
   *  clearance phase gives way to the next green. Returns true if the walk phase began. */
  changeNow(): boolean {
    this.index = (this.index + 1) % PHASES.length;
    this.elapsed = 0;
    return this.phase === "walk";
  }

  #ease(dt: number): void {
    const avenue = this.avenue();
    const side = this.side();
    const blink = this.flash && this.elapsed % 1 >= 0.5;
    const targets = this.#targets;
    targets[0] = avenue === "green" ? 1 : 0;
    targets[1] = avenue === "amber" ? 1 : 0;
    targets[2] = avenue === "red" ? 1 : 0;
    targets[3] = side === "green" ? 1 : 0;
    targets[4] = side === "amber" ? 1 : 0;
    targets[5] = side === "red" ? 1 : 0;
    targets[6] = this.walk || (this.flash && !blink) ? 1 : 0;
    targets[7] = this.walk || this.flash ? 0 : 1;
    const k = dt > 0 ? Math.min(1, dt / LAMP_FADE) : 0;
    for (let i = 0; i < 8; i++) {
      const lamp = this.lamps[i] ?? 0;
      this.lamps[i] = lamp + ((targets[i] ?? 0) - lamp) * k;
    }
  }

  /** Snap the lamps to the phase (laying the street out). */
  settle(): void {
    for (let i = 0; i < 40; i++) this.#ease(LAMP_FADE);
  }
}

// ---- Walkers ----

type Region = "near" | "fl" | "fr";
type WalkerMode = "walk" | "wait" | "cross" | "follow" | "errand";

/** Where walkers come and go: a point off screen (or behind a door) and its spread (m). */
interface Portal {
  readonly region: Region;
  readonly x: number;
  readonly z: number;
  readonly sx: number;
  readonly sz: number;
  readonly weight: number;
}

export const PORTALS: readonly Portal[] = [
  { region: "near", x: -37, z: 18, sx: 0, sz: 2.8, weight: 1.0 },
  { region: "near", x: 33, z: 18, sx: 0, sz: 2.8, weight: 1.0 },
  { region: "near", x: -14.0, z: 12.9, sx: 1.6, sz: 0, weight: 1.3 }, // the station stairs below the window
  { region: "near", x: 15.5, z: 13.2, sx: 1.0, sz: 0, weight: 0.5 }, // a shop below the window
  { region: "fl", x: -41, z: 42.6, sx: 0, sz: 1.5, weight: 1.0 },
  { region: "fl", x: -7.5, z: 94, sx: 0.8, sz: 0, weight: 0.8 },
  { region: "fl", x: CAFE_DOOR, z: 45.9, sx: 0.4, sz: 0, weight: 0.3 },
  { region: "fr", x: 37, z: 42.6, sx: 0, sz: 1.5, weight: 1.0 },
  { region: "fr", x: 7.5, z: 94, sx: 0.8, sz: 0, weight: 0.8 },
  { region: "fr", x: KONBINI_DOOR, z: 45.9, sx: 0.5, sz: 0, weight: 0.6 },
];
const PORTAL_WEIGHT = PORTALS.reduce((sum, portal) => sum + portal.weight, 0);

/** A crosswalk between two kerb points (a on region ra, b on rb). */
interface Crossing {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly ra: Region;
  readonly rb: Region;
}

const KERB_STEP = 0.3;
const CROSSINGS: readonly Crossing[] = [
  {
    ax: -CROSS_WE,
    az: KERB_NEAR - KERB_STEP,
    bx: -CROSS_WE,
    bz: KERB_FAR + KERB_STEP,
    ra: "near",
    rb: "fl",
  }, // W
  {
    ax: CROSS_WE,
    az: KERB_NEAR - KERB_STEP,
    bx: CROSS_WE,
    bz: KERB_FAR + KERB_STEP,
    ra: "near",
    rb: "fr",
  }, // E
  { ax: -DIAG_NEAR, az: KERB_NEAR - KERB_STEP, bx: DIAG_FAR, bz: DIAG_FAR_Z, ra: "near", rb: "fr" }, // D1
  { ax: DIAG_NEAR, az: KERB_NEAR - KERB_STEP, bx: -DIAG_FAR, bz: DIAG_FAR_Z, ra: "near", rb: "fl" }, // D2
  {
    ax: -SIDE_KERB - KERB_STEP,
    az: CROSS_N,
    bx: SIDE_KERB + KERB_STEP,
    bz: CROSS_N,
    ra: "fl",
    rb: "fr",
  }, // N
];

/** What walkers step round: the lamp and signal poles (a point and its radius) and the vending
 *  machines (a box, radius 0), each with its open side (ix, iz: the way toward the middle of its
 *  sidewalk, away from the kerb or the wall it stands by). */
interface Obstacle {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly r: number;
  readonly ix: number;
  readonly iz: number;
}

function obstacle(x0: number, x1: number, z0: number, z1: number, r: number): Obstacle {
  const open = new Float64Array(2);
  towardMiddle((x0 + x1) / 2, (z0 + z1) / 2, open);
  return { x0, x1, z0, z1, r, ix: open[0] ?? 0, iz: open[1] ?? 0 };
}

const OBSTACLES: readonly Obstacle[] = [
  ...LAMPS.map((pole) => obstacle(pole.x, pole.x, pole.z, pole.z, 0.14)),
  ...SIGNAL_POLES.map((pole) => obstacle(pole.x, pole.x, pole.z, pole.z, 0.16)),
  ...VENDING.map(([x0, x1, z0, z1]) => obstacle(x0, x1, z0, z1, 0)),
];

const MAX_WAYPOINTS = 8;
/** Walking pace (m/s): adults, and the outing (teacher and children). */
const PACE_MIN = 1.1;
const PACE_MAX = 1.45;
const OUTING_PACE = 0.95;
/** Seconds to take up the wanted velocity; the fastest anyone moves (m/s). */
const RELAX = 0.45;
const TOP_SPEED = 2.1;
/** Social force: strength (m/s²), range (m), the share left for people behind, personal space (m). */
const SOCIAL_A = 1.7;
const SOCIAL_B = 0.28;
const SOCIAL_BEHIND = 0.35;
const SOCIAL_SPACE = 0.14;
/** A firm push where bodies overlap (m/s² per m), the sidestep from oncoming people (m/s²). */
const CONTACT = 14;
const SIDESTEP = 0.8;
/** Neighbours further than this are ignored (m). */
const NEAR_RANGE = 2.2;
/** Margin walkers keep from kerbs and walls (m). */
const WALL = 0.32;
/** Waypoints count as reached within this (m); kerb points closer. */
const REACH = 0.8;
const REACH_KERB = 0.5;
/** The lamp and signal poles stand just inside the kerb, and the vending machines against the
 *  walls. A walker held up by one in its way (moving toward where it is going at less than HELD of
 *  the speed it wants) has this share of its push turned sideways, round it on the side with room. */
const SLIDE = 1.2;
const HELD = 0.5;
/** Along a sidewalk walkers keep this far in from the kerb (m), steering at a point CARROT metres
 *  ahead kept that far in, and step out to the kerb only over the last STEP_OUT metres to a
 *  crossing's kerb point; so they pass the poles on the kerb on their open side. */
const KERB_INSET = 0.9;
const CARROT = 1.5;
const STEP_OUT = 3;
/** A walker whose way along a far corner's L would cut through the building at its inside corner
 *  (the side street's facade meeting the avenue's) steers at a point this far in from that corner
 *  (m, each way) until its way is clear of it. */
const CORNER_CUT = 0.5;
/** The watchdog: a walker on its way that stays within STUCK_RADIUS (m) of one place for STUCK_TIME
 *  seconds, further than STUCK_FAR (m) from where it is going, is pinned. Near a crossing's kerb it
 *  joins the crowd waiting there; elsewhere it steps DETOUR_STEP metres aside (toward the middle of
 *  its sidewalk) for up to DETOUR_TIME seconds, and after STUCK_TRIES such detours without getting
 *  STUCK_CLEAR metres from where it was pinned it gives up its way: out of view it leaves (is
 *  retired), in view it heads for the nearest way out and the detours start over. */
const STUCK_RADIUS = 0.3;
const STUCK_TIME = 4;
const STUCK_FAR = 1;
const DETOUR_STEP = 1.2;
const DETOUR_TIME = 2.5;
const STUCK_TRIES = 3;
const STUCK_CLEAR = 3;
/** Waiting: the spot search (tries), how far back the crowd may stand (m), and the space each
 *  keeps (m). A standing walker settles (stops dead) below this speed near its spot, and is only
 *  moved again by a push stronger than UNSETTLE (m/s²). */
const SPOT_TRIES = 10;
const SPOT_DEPTH = 3.6;
const SPOT_SPACE = 0.72;
const SETTLE_SPEED = 0.12;
const SETTLE_NEAR = 0.3;
const UNSETTLE = 1.4;
/** Stepping off: a reaction time (s) plus this many seconds per metre behind the kerb. */
const STEP_OFF = 0.35;
const STEP_OFF_PER_METRE = 0.5;
const STEP_OFF_SPREAD = 0.9;
/** On the crossing while the green man flashes, walkers hurry by this much. */
const HURRY = 1.35;
/** Pairs: the share of arrivals that come as two, the gap they keep (m), how firmly (1/s²). */
const PAIR_SHARE = 0.2;
const PAIR_GAP = 0.6;
const PAIR_PULL = 1.2;
/** People: the crowd knob maps to this many walkers about. */
const CROWD_MIN = 8;
const CROWD_MAX = 140;
/** Mean seconds a walker spends in the simulated street (for the arrival rate). */
const DWELL = 75;
/** Umbrellas: the share who carry one; seconds to open; the rain or snow at which the keenest and
 *  the most stubborn open theirs; seconds they wait first. */
const UMBRELLA_SHARE = 0.88;
const UMBRELLA_OPEN = 0.6;
const UMBRELLA_KEEN = 0.01;
const UMBRELLA_STUBBORN = 0.3;
const UMBRELLA_DELAY_MIN = 1;
const UMBRELLA_DELAY_MAX = 9;
/** Looking up at the window: within this of the point under the pointer (m), after a moment (s). */
const LOOK_RADIUS = 3.4;
const LOOK_DELAY_MIN = 0.15;
const LOOK_DELAY_MAX = 0.9;
const LOOK_EASE = 0.35;
const LOOK_SLOW = 0.35;
/** Turning (rad/s): walking, and standing (facing the street, glancing about). */
const TURN_WALK = 3.5;
const TURN_STAND = 1.4;
/** A waiting walker glances away now and then: every this many seconds, for this long, this far (rad). */
const GLANCE_EVERY_MIN = 7;
const GLANCE_EVERY_MAX = 22;
const GLANCE_HOLD = 2.5;
const GLANCE_ANGLE = 0.6;
/** Metres per gait cycle (two steps). */
const STRIDE = 1.4;

/** The outing: children in it, spacing in the line (m), seconds between outings at frequency 0 and
 *  1 (randomised), and before the first. */
const OUTING_MIN = 8;
const OUTING_MAX = 14;
const OUTING_SPACING = 0.72;
const OUTING_ROW = 0.34;
const OUTING_RARE = 320;
const OUTING_OFTEN = 70;
const OUTING_FIRST = 30;

/** The neighbour grid: cells (m) over the walkable street. */
const GRID = 2;
const GRID_X0 = -48;
const GRID_Z0 = 8;
const GRID_W = 50;
const GRID_H = 46;

// ---- Vehicles ----

/** Path sampling (m). */
const PATH_STEP = 0.5;
/** Driving: free-road pace (m/s) for cars and bicycles, comfortable sideways pull on bends (m/s²),
 *  intelligent driver model's acceleration and braking (m/s²), standstill gap (m), headway (s). */
const CAR_PACE = 5.2;
const BIKE_PACE = 3.6;
const BEND_ACCEL = 1.6;
const IDM_A = 1.0;
const IDM_B = 1.8;
const IDM_HARD = 6;
const IDM_S0 = 2.0;
const IDM_S0_BIKE = 1.1;
const IDM_T = 1.3;
/** How far ahead a driver looks for others (m), and for people on the street (m, every step). */
const LOOKAHEAD = 45;
const YIELD_LOOK = 14;
const YIELD_STEP = 1.5;
/** The points a driver looks at along its way, from 0.5 m ahead of its front every YIELD_STEP. */
const WAY_POINTS = Math.floor((YIELD_LOOK - 0.5) / YIELD_STEP) + 1;
/** A turning vehicle gives way, across the lanes it turns over, to whoever is on its way or will be
 *  within this many seconds at their speed along their own path (a bicycle coming up the kerb lane
 *  beside it), that road looked at every SWEEP_STEP metres, at most SWEEP_POINTS of them (the
 *  fastest car covers 14.3 m in SWEEP). */
const SWEEP = 2.5;
const SWEEP_STEP = 0.75;
const SWEEP_POINTS = 20;
/** Don't block the box: short of its stop line a vehicle waits there unless the way out of the
 *  junction has room for it (its length and the standstill gap) before whatever stands in its way: a
 *  vehicle slower than BOX_SLOW (m/s), less the room the moving ones ahead will take queueing behind
 *  it, or a walker. Else a queue backed up from beyond would leave it standing across the cross
 *  traffic's way when the lights change. */
const BOX_SLOW = 1;
/** Vehicles per minute from each end at traffic 1: from the west, east, and down the side street. */
const RATE_EB = 28;
const RATE_WB = 28;
const RATE_SB = 14;
/** Shares: bicycles; eastbound cars turning left; side street cars turning left (else right). */
const BIKE_SHARE = 0.12;
const EB_LEFT_SHARE = 0.22;
const SB_LEFT_SHARE = 0.55;
/** Kinds of car: cumulative shares of sedan, taxi, kei, van. */
const CAR_KINDS = [
  [0.46, KIND_SEDAN],
  [0.66, KIND_TAXI],
  [0.88, KIND_KEI],
  [1.0, KIND_VAN],
] as const;
/** Blinkers come on this far before a turn (m). */
const BLINK_AHEAD = 28;

// ---- The late delivery ----

/** Where the van stops: its centre on the far kerb east of the junction (x), its back 4 m past the
 *  stop line and so clear of the E crosswalk, its front still in a 16:9 frame; over the kerbside
 *  bicycle lane (z, 9 cm off the kerb). */
const DELIVERY_X = 18.8;
const DELIVERY_Z = KERB_FAR - 0.95;
/** The konbini's service door in its glass front (x), and how far in the driver sets the crates down (m). */
const SERVICE_DOOR = 16.6;
const SERVICE_INSIDE = 1.2;
/** Where the driver stands on the sidewalk: by the van's back and by its kerbside cab door (m along
 *  the van from its centre), a step from the kerb (z). */
const PORTER_BACK = -2.7;
const PORTER_CAB = 1.2;
const PORTER_KERB = KERB_FAR + 0.45;
/** Within this of where it is going the driver has got there (m); or within PORTER_NEAR and held
 *  up there by people passing (slower than PORTER_STUCK m/s), so a crowd cannot keep it from its
 *  work. */
const PORTER_REACH = 0.3;
const PORTER_NEAR = 1;
const PORTER_STUCK = 0.25;
/** The driver's pace empty and wheeling a load (m/s); its radius alone and with the loaded trolley
 *  before it (m), which is what walkers keep clear of. */
const PORTER_PACE = 1.3;
const PORTER_LOADED = 0.85;
const PORTER_RADIUS = 0.26;
const PORTER_TROLLEY = 0.48;
/** The van's seed: white paint in the shader's streetPaint. */
const DELIVERY_SEED = 0.06;
/** Seconds between deliveries at the frequency knob's ends (randomised ±40%), and before the first
 *  once the feature is switched on. */
const DELIVERY_RARE = 600;
const DELIVERY_OFTEN = 120;
const DELIVERY_FIRST = 25;
/** The blinker comes on this far before the stop (m), and the van pulls in over the last PULL_IN
 *  metres and out over the first PULL_OUT: both begin past the junction's stop line and crosswalk,
 *  so it crosses straight and never signals a turn in it. */
const DELIVERY_SIGNAL = 6;
const PULL_IN = 6;
const PULL_OUT = 12;
/** It pulls out once its lane and the kerb lane it stands over are clear this far behind it and
 *  ahead of it (m), so nobody comes up behind it as it eases out. */
const CLEAR_BEHIND = 32;
const CLEAR_AHEAD = 6;
/** A cyclist in the kerb lane swings out round the parked van by this much (m), easing out and back
 *  over SWERVE_RAMP metres, and waits behind it while a car in the next lane is within SWERVE_WAIT
 *  metres behind it or alongside. */
const BIKE_SWERVE = 1.7;
const SWERVE_RAMP = 4;
const SWERVE_WAIT = 10;
/** The van and the cyclists in the kerb lane. Within DELIVERY_APPROACH metres of its stop, until it
 *  stands in at the kerb, they keep in one file: it does not pass a cyclist it would ease in over,
 *  nor a cyclist it. It stands in once VAN_IN metres off its lane toward the kerb, so near straight
 *  that a cyclist swinging out passes its tail clear. Pulling out, it is over their lane until it
 *  is back within VAN_OVER metres of its own (turned, its tail leaves their lane about there):
 *  they keep behind it, swinging out as they come up to it. */
const DELIVERY_APPROACH = 14;
const VAN_IN = 1.8;
const VAN_OVER = 0.1;

// ---- Time ----

const STEP = 1 / 30;
const MAX_STEPS = 6;
const PREWARM = 12;
const PREWARM_STEPS = Math.round(PREWARM / STEP);
/** Wall time the first street's warm-up may take a frame at least (ms; more when the frame's budget
 *  allows), so a typical machine lays it out in one frame. A reseed, with the old street still on
 *  screen, takes the frame's budget alone. The warm-up is a count of steps either way: a slow
 *  machine shows the same street, a few frames later. */
const PREWARM_BUDGET_MS = 90;
/** Warm-up steps between two looks at the clock (about 2 ms of them). */
const PREWARM_CHUNK = 8;
/** Seconds of the side street's green left once the street has been laid out. */
const OPENING = 3;
const SEED_BASE = 0x5717ee7;
const TAU = Math.PI * 2;

type KnobKey =
  "crowd" | "signal" | "outing" | "traffic" | "delivery" | "rain" | "snow" | "streetSeed";

/** Angle a − b wrapped to −π..π. */
const angleDiff = (a: number, b: number): number => {
  const d = (a - b) % TAU;
  return d > Math.PI ? d - TAU : d < -Math.PI ? d + TAU : d;
};

// ---- The passage ----

/** Seconds the entrance and the exit take (SceneDef.passage). The shader eases the same tilt from
 *  passageIn() and passageOut() with the constants below: keep passageTilt and its GLSL twin in step. */
export const STREET_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
/** How far the window's pitch is raised (rad, 31.5°) when the entrance starts, with the skyline in
 *  view and the crossing below the frame, and where the exit ends. */
export const TILT_IN = 0.55;
export const TILT_OUT = 0.55;
/** The share of the entrance the camera takes to come down and settle. */
export const TILT_ARRIVE = 0.8;

/** How far the camera is raised above its rest pitch (rad), from the passage's progress (0..1 each):
 *  coming in it is on its way down from the first frame, braking into a little overshoot, then
 *  settles; going out it rises faster and faster to the end. Exactly 0 at rest. */
export function passageTilt(enter: number, exit: number): number {
  if (enter >= 1 && exit <= 0) return 0;
  const back = clamp(enter / TILT_ARRIVE, 0, 1) - 1;
  const settle = 1 + 1.8 * back * back * back + 0.8 * back * back;
  return TILT_IN * (1 - settle) + TILT_OUT * exit * exit;
}

/** The crowd's walk-in: every walker is already on its way at the entrance's first frame and arrives
 *  between these shares of the entrance, at a pace in this range (m/s), so it comes in from that far
 *  along its sidewalk (a few metres). */
const ARRIVE_END_MIN = 0.72;
const ARRIVE_END_MAX = 0.94;
const ARRIVE_PACE_MIN = 1.15;
const ARRIVE_PACE_MAX = 1.6;
/** The last share of its walk in which a walker turns from its way in to its own heading. */
const ARRIVE_TURN = 0.2;

/** A repeatable number 0..1 from a walker's index and a salt (no draw from the simulation's random numbers). */
const hash01 = (n: number, salt: number): number =>
  fract(Math.sin(n * 127.1 + salt * 311.7) * 43758.5453);

class Walker {
  alive = false;
  child = false;
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  ax = 0;
  az = 0;
  heading = 0;
  lastX = 0;
  lastZ = 0;
  lastHeading = 0;
  pace = 1.3;
  radius = 0.25;
  seed = 0;
  mode: WalkerMode = "walk";
  // The route: points, the region each lies in, and at kerbs the crossing (index, +1 a→b, −1 b→a).
  readonly wx = new Float64Array(MAX_WAYPOINTS);
  readonly wz = new Float64Array(MAX_WAYPOINTS);
  readonly region: Region[] = Array.from({ length: MAX_WAYPOINTS }, (): Region => "near");
  readonly crossing = new Int8Array(MAX_WAYPOINTS);
  readonly direction = new Int8Array(MAX_WAYPOINTS);
  count = 0;
  next = 0;
  // Waiting at a kerb.
  spotX = 0;
  spotZ = 0;
  depth = 0;
  faceX = 0;
  faceZ = 1;
  goAt = Number.POSITIVE_INFINITY;
  settled = false;
  glanceTarget = 0;
  nextGlance = 0;
  // Company: a partner walking beside it, or (the outing) the one it follows in line.
  partner: Walker | undefined = undefined;
  ahead: Walker | undefined = undefined;
  row = 0;
  exitX = 0;
  exitZ = 0;
  // Umbrella.
  hasUmbrella = true;
  umbrella = 0;
  umbrellaUp = false;
  umbrellaClock = 0;
  umbrellaKeen = 0.1;
  umbrellaDelay = 3;
  // Looking up at the window.
  look = 0;
  interest = 0;
  lookDelay = 0.5;
  looking = false;
  gait = 0;
  onRoad = false;
  /** The late delivery's driver, on its errand (mode "errand"), going to (goalX, goalZ). */
  porter = false;
  goalX = 0;
  goalZ = 0;
  /** Where it is going this step (the waypoint, its spot, its place in line), and how far off. */
  awayX = 0;
  awayZ = 0;
  away = 0;
  /** The watchdog: where it has stood since `anchorAt` (clock), where it was last pinned, the
   *  detours since it got anywhere, and the one it is on (to detourX, detourZ until detourEnd). */
  anchorX = Number.NaN;
  anchorZ = Number.NaN;
  anchorAt = 0;
  pinX = Number.NaN;
  pinZ = Number.NaN;
  tries = 0;
  detourX = 0;
  detourZ = 0;
  detourEnd = Number.NEGATIVE_INFINITY;
}

/** A stretch of a path running along one lane, so drivers on different paths see each other there. */
interface LaneSpan {
  readonly lane: number;
  /** Path distance where it starts and ends. */
  readonly s0: number;
  readonly s1: number;
  /** Lane distance at s0. */
  readonly c0: number;
}

type Segment =
  | {
      readonly kind: "line";
      readonly x0: number;
      readonly z0: number;
      readonly x1: number;
      readonly z1: number;
      readonly lane: number;
      readonly c0: number;
    }
  | {
      readonly kind: "arc";
      readonly cx: number;
      readonly cz: number;
      readonly r: number;
      readonly a0: number;
      readonly a1: number;
      readonly lane: number;
      readonly c0: number;
    };

class VehiclePath {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly hs: Float64Array;
  /** The fastest it can be taken at each sample (m/s), braking comfortably into bends. */
  readonly vmax: Float64Array;
  readonly spans: readonly LaneSpan[];
  readonly length: number;
  /** Path distance where the start of the turn is (blinkers), Infinity if none. */
  readonly turnAt: number;
  readonly turnSide: number;
  /** Which light it obeys, and the path distance where the front stops for it. */
  readonly signal: "avenue" | "side";
  readonly stop: number;
  /** Path distance where it has left the junction (the box between the stop lines), beyond which a
   *  vehicle must find room before it crosses its stop line. */
  readonly exit: number;

  constructor(signal: "avenue" | "side", stop: number, segments: readonly Segment[]) {
    this.signal = signal;
    this.stop = stop;
    const lengths = segments.map((seg) =>
      seg.kind === "line"
        ? Math.hypot(seg.x1 - seg.x0, seg.z1 - seg.z0)
        : seg.r * Math.abs(seg.a1 - seg.a0),
    );
    this.length = lengths.reduce((a, b) => a + b, 0);
    const n = Math.ceil(this.length / PATH_STEP) + 2;
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    this.hs = new Float64Array(n);
    this.vmax = new Float64Array(n);
    const spans: LaneSpan[] = [];
    let s0 = 0;
    let turnAt = Number.POSITIVE_INFINITY;
    let turnSide = 0;
    segments.forEach((seg, i) => {
      const len = lengths[i] ?? 0;
      spans.push({ lane: seg.lane, s0, s1: s0 + len, c0: seg.c0 });
      if (seg.kind === "arc" && !Number.isFinite(turnAt)) {
        turnAt = s0;
        turnSide = seg.a1 > seg.a0 ? 1 : -1;
      }
      s0 += len;
    });
    this.spans = spans;
    this.turnAt = turnAt;
    this.turnSide = turnSide;
    for (let k = 0; k < n; k++) {
      let s = Math.min(k * PATH_STEP, this.length);
      let x = 0;
      let z = 0;
      let h = 0;
      let v = Number.POSITIVE_INFINITY;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const len = lengths[i] ?? 0;
        if (!seg) continue;
        if (s > len && i < segments.length - 1) {
          s -= len;
          continue;
        }
        const f = len > 0 ? clamp(s / len, 0, 1) : 0;
        if (seg.kind === "line") {
          x = seg.x0 + (seg.x1 - seg.x0) * f;
          z = seg.z0 + (seg.z1 - seg.z0) * f;
          h = Math.atan2(seg.z1 - seg.z0, seg.x1 - seg.x0);
        } else {
          const a = seg.a0 + (seg.a1 - seg.a0) * f;
          const dir = seg.a1 > seg.a0 ? 1 : -1;
          x = seg.cx + seg.r * Math.cos(a);
          z = seg.cz + seg.r * Math.sin(a);
          h = Math.atan2(dir * Math.cos(a), -dir * Math.sin(a));
          v = Math.sqrt(BEND_ACCEL * seg.r);
        }
        break;
      }
      this.xs[k] = x;
      this.zs[k] = z;
      this.hs[k] = h;
      this.vmax[k] = v;
    }
    for (let k = n - 2; k >= 0; k--) {
      const after = this.vmax[k + 1] ?? Number.POSITIVE_INFINITY;
      this.vmax[k] = Math.min(
        this.vmax[k] ?? Number.POSITIVE_INFINITY,
        Math.sqrt(after * after + 2 * IDM_B * PATH_STEP),
      );
    }
    let exit = stop;
    for (let k = 0; k < n; k++) {
      if (inJunction(this.xs[k] ?? 0, this.zs[k] ?? 0))
        exit = Math.max(exit, Math.min((k + 1) * PATH_STEP, this.length));
    }
    this.exit = exit;
  }

  /** Position and heading at path distance s, linearly between samples. */
  at(s: number, out: Float64Array): void {
    const f = clamp(s / PATH_STEP, 0, this.xs.length - 1.001);
    const k = Math.floor(f);
    const u = f - k;
    out[0] = (this.xs[k] ?? 0) + ((this.xs[k + 1] ?? 0) - (this.xs[k] ?? 0)) * u;
    out[1] = (this.zs[k] ?? 0) + ((this.zs[k + 1] ?? 0) - (this.zs[k] ?? 0)) * u;
    const h0 = this.hs[k] ?? 0;
    out[2] = h0 + angleDiff(this.hs[k + 1] ?? h0, h0) * u;
  }

  /** Where the lane position (lane, c) falls on this path, NaN if the path does not run there. */
  locate(lane: number, c: number): number {
    for (const span of this.spans) {
      if (span.lane !== lane) continue;
      const along = c - span.c0;
      if (along >= -2 && along <= span.s1 - span.s0 + 2) return span.s0 + along;
    }
    return Number.NaN;
  }

  /** The lane span holding path distance s. */
  span(s: number): LaneSpan | undefined {
    for (const span of this.spans) if (s < span.s1) return span;
    return this.spans[this.spans.length - 1];
  }
}

// Lanes: straight ones run the length of the street; each turn's arc is a lane of its own.
const L_EB_IN = 0;
const L_EB_OUT = 1;
const L_EB_BIKE = 2;
const L_WB_IN = 3;
const L_WB_OUT = 4;
const L_WB_BIKE = 5;
const L_SB = 6;
const L_SB_BIKE = 7;
const L_NB = 8;
const L_ARC_EBL = 9;
const L_ARC_SBL = 10;
const L_ARC_SBR = 11;
const L_ARC_SBB = 12;
/** Where the delivery van stands at the kerb: no path runs along it, so nobody queues behind it. */
const L_KERB = 13;

/** The avenue runs from x = −AVENUE_END to AVENUE_END; the side street comes down from z = SIDE_END. */
const AVENUE_END = 70;
const SIDE_END = 95;
/** Turning arcs: radii, and the z where turns into or out of the side street meet it. */
const TURN_SMALL = 5.5;
const TURN_BIKE = 3.9;
const TURN_Z = KERB_FAR + 2.65;

const line = (
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  lane: number,
  c0: number,
): Segment => ({ kind: "line", x0, z0, x1, z1, lane, c0 });
const arc = (cx: number, cz: number, r: number, a0: number, a1: number, lane: number): Segment => ({
  kind: "arc",
  cx,
  cz,
  r,
  a0,
  a1,
  lane,
  c0: 0,
});

const HALF_PI = Math.PI / 2;
const TURN_BIG = TURN_Z - LANE_WB_IN; // the side street's right turn sweeps onto the westbound inner lane
const PATHS = {
  ebIn: new VehiclePath("avenue", STOP_EB + AVENUE_END, [
    line(-AVENUE_END, LANE_EB_IN, AVENUE_END, LANE_EB_IN, L_EB_IN, 0),
  ]),
  ebOut: new VehiclePath("avenue", STOP_EB + AVENUE_END, [
    line(-AVENUE_END, LANE_EB_OUT, AVENUE_END, LANE_EB_OUT, L_EB_OUT, 0),
  ]),
  ebLeft: new VehiclePath("avenue", STOP_EB + AVENUE_END, [
    line(-AVENUE_END, LANE_EB_OUT, LANE_NB - TURN_SMALL, LANE_EB_OUT, L_EB_OUT, 0),
    arc(LANE_NB - TURN_SMALL, LANE_EB_OUT + TURN_SMALL, TURN_SMALL, -HALF_PI, 0, L_ARC_EBL),
    line(LANE_NB, LANE_EB_OUT + TURN_SMALL, LANE_NB, SIDE_END, L_NB, 0),
  ]),
  ebBike: new VehiclePath("avenue", STOP_EB + AVENUE_END, [
    line(-AVENUE_END, LANE_EB_BIKE, AVENUE_END, LANE_EB_BIKE, L_EB_BIKE, 0),
  ]),
  wbIn: new VehiclePath("avenue", AVENUE_END - STOP_WB, [
    line(AVENUE_END, LANE_WB_IN, -AVENUE_END, LANE_WB_IN, L_WB_IN, 0),
  ]),
  wbOut: new VehiclePath("avenue", AVENUE_END - STOP_WB, [
    line(AVENUE_END, LANE_WB_OUT, -AVENUE_END, LANE_WB_OUT, L_WB_OUT, 0),
  ]),
  wbBike: new VehiclePath("avenue", AVENUE_END - STOP_WB, [
    line(AVENUE_END, LANE_WB_BIKE, -AVENUE_END, LANE_WB_BIKE, L_WB_BIKE, 0),
  ]),
  sbLeft: new VehiclePath("side", SIDE_END - STOP_SB, [
    line(LANE_SB, SIDE_END, LANE_SB, TURN_Z, L_SB, 0),
    arc(LANE_SB + TURN_SMALL, TURN_Z, TURN_SMALL, Math.PI, 1.5 * Math.PI, L_ARC_SBL),
    line(
      LANE_SB + TURN_SMALL,
      TURN_Z - TURN_SMALL,
      AVENUE_END,
      TURN_Z - TURN_SMALL,
      L_EB_OUT,
      LANE_SB + TURN_SMALL + AVENUE_END,
    ),
  ]),
  sbRight: new VehiclePath("side", SIDE_END - STOP_SB, [
    line(LANE_SB, SIDE_END, LANE_SB, TURN_Z, L_SB, 0),
    arc(LANE_SB - TURN_BIG, TURN_Z, TURN_BIG, 0, -HALF_PI, L_ARC_SBR),
    line(
      LANE_SB - TURN_BIG,
      LANE_WB_IN,
      -AVENUE_END,
      LANE_WB_IN,
      L_WB_IN,
      AVENUE_END - (LANE_SB - TURN_BIG),
    ),
  ]),
  sbBike: new VehiclePath("side", SIDE_END - STOP_SB, [
    line(LANE_SB_BIKE, SIDE_END, LANE_SB_BIKE, TURN_Z, L_SB_BIKE, 0),
    arc(LANE_SB_BIKE + TURN_BIKE, TURN_Z, TURN_BIKE, Math.PI, 1.5 * Math.PI, L_ARC_SBB),
    line(
      LANE_SB_BIKE + TURN_BIKE,
      TURN_Z - TURN_BIKE,
      AVENUE_END,
      TURN_Z - TURN_BIKE,
      L_EB_BIKE,
      LANE_SB_BIKE + TURN_BIKE + AVENUE_END,
    ),
  ]),
} as const;
type PathName = keyof typeof PATHS;

class Vehicle {
  alive = false;
  kind = KIND_SEDAN;
  path: PathName = "ebIn";
  s = 0;
  v = 0;
  pace = CAR_PACE;
  seed = 0;
  brake = 0;
  /** Decided at amber: false = going through, true = stopping. */
  stopping = false;
  sawAmber = false;
  x = 0;
  z = 0;
  heading = 0;
  lastX = 0;
  lastZ = 0;
  lastHeading = 0;
  lane = 0;
  laneC = 0;
  umbrella = 0;
  /** The delivery van: it stops at the kerb past the junction, then goes on. */
  delivery = false;
  /** How far it has moved off its lane toward the kerb (m, to its left). */
  offset = 0;
  /** Where its pull-out began (path distance; NaN until it pulls out). */
  pullOut = Number.NaN;
  /** A bicycle: how far round the parked van it has swung, 0..1. */
  swerve = 0;
}

class StreetCrossing implements SceneSim {
  readonly #agents: DataTexture;
  readonly #tiles: DataTexture;
  readonly #state: DataTexture;
  /** The textures handed to the renderer every frame. */
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #agentData = new Float32Array(MAX_AGENTS * 2 * 4);
  readonly #tileData = new Uint8Array(TILES_X * TILE_TEXELS * TILES_Z * 4);
  readonly #stateData = new Float32Array(3 * 4);
  readonly #bodyCount = new Uint8Array(TILES_X * TILES_Z);
  readonly #lightCount = new Uint8Array(TILES_X * TILES_Z);
  readonly #order = new Int32Array(MAX_AGENTS);
  readonly #orderKey = new Float64Array(MAX_AGENTS);
  readonly #knobIndex: Readonly<Record<KnobKey, number>>;
  readonly #random = new Random();
  readonly #walkers: readonly Walker[] = Array.from({ length: MAX_WALKERS }, () => new Walker());
  readonly #vehicles: readonly Vehicle[] = Array.from(
    { length: MAX_VEHICLES },
    () => new Vehicle(),
  );
  readonly #signals = new Signals();
  // The neighbour grid: a counting sort of walker indices by cell.
  readonly #cellStart = new Int32Array(GRID_W * GRID_H + 1);
  readonly #cellCursor = new Int32Array(GRID_W * GRID_H);
  readonly #cellItems = new Int32Array(MAX_WALKERS);
  readonly #cellOf = new Int32Array(MAX_WALKERS);
  /** Scratch: a point (x, z, heading); a force (x, z); a bounding box (x0, x1, z0, z1). */
  readonly #point = new Float64Array(3);
  readonly #point2 = new Float64Array(3);
  readonly #force = new Float64Array(2);
  readonly #box = new Float64Array(4);
  /** Scratch: the vehicles ahead of the one driving, where each is along its path (m), its length
   *  (m) and speed (m/s). */
  readonly #aheadAt = new Float64Array(MAX_VEHICLES);
  readonly #aheadLength = new Float64Array(MAX_VEHICLES);
  readonly #aheadSpeed = new Float64Array(MAX_VEHICLES);
  /** Scratch: a turning driver's way ahead (WAY_POINTS points), and the road another comes to. */
  readonly #wayX = new Float64Array(WAY_POINTS);
  readonly #wayZ = new Float64Array(WAY_POINTS);
  readonly #sweepX = new Float64Array(SWEEP_POINTS);
  readonly #sweepZ = new Float64Array(SWEEP_POINTS);

  #aspect = 16 / 9;
  #crowd = 0.5;
  #cycle = 80;
  #outing = 0.3;
  #traffic = 0.5;
  #precip = 0;
  #seed = Number.NaN;
  #enter = 1;
  #tilt = 0;
  /** Scratch: an arriving walker as drawn (x, z, heading, gait). */
  readonly #arrived = new Float64Array(4);

  #clock = 0;
  readonly #steps = new FixedStep(STEP, MAX_STEPS);
  /** Steps of the warm-up (#reset's PREWARM) taken so far; the street is live once all are. */
  #warmed = 0;
  /** Whether a street has been uploaded: a reseed's warm-up then takes the frame's budget alone. */
  #shown = false;
  /** One warm-up step, as runBudgeted calls it. */
  readonly #warmStep = (): void => this.#step(STEP);
  #nextWalker = 0;
  readonly #nextVehicle = new Float64Array(3);
  #nextOuting = Number.POSITIVE_INFINITY;

  // The late delivery: its knob, when the next sets out, the episode, the van and its driver on
  // foot. Its own generator, so switching it on leaves everyone else's draws as they were.
  #delivery = 0;
  #nextDelivery = Number.POSITIVE_INFINITY;
  readonly #errand = new Errand();
  readonly #deliveryRandom = new Random();
  #van: Vehicle | undefined;
  #porter: Walker | undefined;
  /** A delivery is due to set out as soon as the avenue's way in is clear. */
  #deliveryDue = false;
  /** The street is being laid out (#reset's warm-up). Walkers then keep to the opening's paths as
   *  composed: the slide round obstacles, the steering in from the kerb and round the inside corners
   *  and the watchdog take over once it is on screen, so the first frame keeps the same people where
   *  they always were (any of them changes who reaches a kerb when, and with it every later draw). */
  #layingOut = false;

  #primed = false;
  #seenSignal = 0;
  #seenOuting = 0;
  #seenDelivery = 0;

  #hover = false;
  #hoverX = 0;
  #hoverZ = 0;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const index = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new StreetSimError(`street: the scene has no '${key}' knob`);
      return at;
    };
    this.#knobIndex = {
      crowd: index("crowd"),
      signal: index("signal"),
      outing: index("outing"),
      traffic: index("traffic"),
      delivery: index("delivery"),
      rain: index("rain"),
      snow: index("snow"),
      streetSeed: index("streetSeed"),
    };
    this.#agents = new DataTexture(gl, {
      width: MAX_AGENTS,
      height: 2,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#tiles = new DataTexture(gl, {
      width: TILES_X * TILE_TEXELS,
      height: TILES_Z,
      format: "rgba8",
      filter: "nearest",
    });
    this.#state = new DataTexture(gl, {
      width: 3,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#textures = [this.#agents.texture, this.#tiles.texture, this.#state.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const values = frame.values;
    const index = this.#knobIndex;
    this.#crowd = clamp(values[index.crowd] ?? 0.5, 0, 1);
    this.#cycle = clamp(values[index.signal] ?? 80, 30, 200);
    this.#outing = clamp(values[index.outing] ?? 0, 0, 1);
    this.#traffic = clamp(values[index.traffic] ?? 0.5, 0, 1);
    this.#delivery = clamp(values[index.delivery] ?? 0, 0, 1);
    this.#precip = Math.max(
      clamp(values[index.rain] ?? 0, 0, 1),
      0.8 * clamp(values[index.snow] ?? 0, 0, 1),
    );
    this.#signals.cycle = this.#cycle;
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    const enter = clamp(frame.passage.enter, 0, 1);
    this.#enter = enter;
    this.#tilt = passageTilt(enter, clamp(frame.passage.exit, 0, 1));

    const seed = Math.round(values[index.streetSeed] ?? 0);
    if (seed !== this.#seed) this.#reset(seed);
    if (this.#warmed < PREWARM_STEPS) {
      this.#warmed = runBudgeted(
        this.#warmStep,
        this.#shown ? frame.budget : Math.max(PREWARM_BUDGET_MS, frame.budget),
        PREWARM_STEPS,
        this.#warmed,
        PREWARM_CHUNK,
      );
      // Until the street is laid out its clock holds and the textures keep what they show.
      if (this.#warmed < PREWARM_STEPS) return this.#textures;
      this.#laidOut();
    }

    // Outings on their own: a fresh wait whenever the feature comes on, none while it is off.
    if (this.#outing <= 0) this.#nextOuting = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.#nextOuting)) this.#nextOuting = this.#clock + OUTING_FIRST;
    // Deliveries the same way.
    if (this.#delivery <= 0) this.#nextDelivery = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.#nextDelivery))
      this.#nextDelivery = this.#clock + DELIVERY_FIRST;

    this.#watchTriggers(frame.triggers);
    this.#follow(frame.pointer);

    const steps = this.#steps.advance(Math.max(0, frame.dt) * Math.max(0, frame.motion));
    for (let i = 0; i < steps; i++) this.#step(STEP);
    this.#upload(this.#steps.alpha);
    this.#shown = true;
    return this.#textures;
  }

  dispose(): void {
    this.#agents.dispose();
    this.#tiles.dispose();
    this.#state.dispose();
  }

  /** A "now" button stamps its slot with the scene clock: any change since the last frame fires. */
  #watchTriggers(triggers: readonly number[]): void {
    const signal = triggers[0] ?? -1e4;
    const outing = triggers[1] ?? -1e4;
    const delivery = triggers[2] ?? -1e4;
    if (this.#primed) {
      if (signal !== this.#seenSignal && signal > -1e3) this.#changeLights();
      if (outing !== this.#seenOuting && outing > -1e3) this.#startOuting();
      if (delivery !== this.#seenDelivery && delivery > -1e3) this.#startDelivery();
    }
    this.#primed = true;
    this.#seenSignal = signal;
    this.#seenOuting = outing;
    this.#seenDelivery = delivery;
  }

  /** The pointer: where on the street it points (walkers near it look up); a click changes the lights. */
  #follow(pointer: PointerState): void {
    this.#hover = pointer.inside && this.#toGround(pointer.x, pointer.y);
    if (this.#hover) {
      this.#hoverX = this.#point[0] ?? 0;
      this.#hoverZ = this.#point[1] ?? 0;
    }
    if (pointer.inside && pointer.pressed) this.#changeLights();
  }

  #changeLights(): void {
    if (this.#signals.changeNow()) this.#walkBegins();
  }

  /** The point on the street (y = 0) under screen point (px, py) into #point. */
  #toGround(px: number, py: number): boolean {
    const sx = (px - 0.5) * this.#aspect;
    const sy = py - 0.5;
    const pitch = PITCH - this.#tilt;
    const dy = sy * Math.cos(pitch) - FOCAL * Math.sin(pitch);
    const dz = sy * Math.sin(pitch) + FOCAL * Math.cos(pitch);
    if (dy >= -1e-4) return false;
    const t = CAM_H / -dy;
    this.#point[0] = CAM_X + sx * t;
    this.#point[1] = dz * t;
    return true;
  }

  /** Lay a fresh street out for this seed: a few seconds before the scramble, people waiting at the
   *  kerbs and walking along the sidewalks, the avenue's traffic queued at its red light. frame()
   *  then runs it PREWARM_STEPS steps on (the warm-up) before it goes live (#laidOut). */
  #reset(seed: number): void {
    const random = this.#random;
    random.seed(SEED_BASE ^ Math.imul(seed + 1, 0x9e3779b1));
    this.#seed = seed;
    for (const walker of this.#walkers) walker.alive = false;
    for (const vehicle of this.#vehicles) vehicle.alive = false;
    this.#clock = 0;
    this.#steps.reset();
    this.#warmed = 0;
    this.#errand.stop();
    this.#van = undefined;
    this.#porter = undefined;
    this.#deliveryDue = false;
    this.#deliveryRandom.seed(SEED_BASE ^ 0xde1ae7 ^ Math.imul(seed + 1, 0x85ebca6b));

    const signals = this.#signals;
    signals.cycle = this.#cycle;
    signals.index = PHASES.indexOf("side");
    signals.elapsed = signals.length - (OPENING + PREWARM);
    signals.settle();

    const target = this.#crowdTarget();
    for (let k = 0; k < target; k++) this.#scatterWalker();
    // The avenue's queues at the red, and a car or two coming down the side street.
    const queue = Math.round(this.#traffic * 5);
    for (const name of ["ebIn", "ebOut", "wbIn", "wbOut"] as const) {
      const path = PATHS[name];
      let front = path.stop - random.range(0.5, 1.5);
      const n = Math.round(queue * random.range(0.5, 1.2));
      for (let k = 0; k < n; k++) {
        const vehicle = this.#launchVehicle(name, this.#pickCar());
        if (!vehicle) break;
        const shape = SHAPES[vehicle.kind] ?? SHAPES[KIND_SEDAN];
        const length = shape?.length ?? 4.5;
        vehicle.s = front - length / 2;
        vehicle.v = 0;
        front -= length + IDM_S0 + random.range(0.2, 1.2);
        this.#placeVehicle(vehicle);
      }
    }
    for (let k = 0; k < Math.round(this.#traffic * 3); k++) {
      const vehicle = this.#launchVehicle(
        random.next() < SB_LEFT_SHARE ? "sbLeft" : "sbRight",
        this.#pickCar(),
      );
      if (!vehicle) break;
      vehicle.s = random.range(5, 40);
      vehicle.v = vehicle.pace * 0.8;
      this.#placeVehicle(vehicle);
    }
    for (let e = 0; e < 3; e++) this.#nextVehicle[e] = random.wait(this.#vehicleRate(e));
    this.#nextWalker = random.wait(this.#walkerRate());
    this.#nextOuting = this.#outing > 0 ? OUTING_FIRST : Number.POSITIVE_INFINITY;
    this.#nextDelivery = this.#delivery > 0 ? DELIVERY_FIRST : Number.POSITIVE_INFINITY;

    this.#layingOut = true;
  }

  /** The warm-up is done: the street goes live, drawn from where it stands. */
  #laidOut(): void {
    this.#layingOut = false;
    for (const walker of this.#walkers) {
      walker.lastX = walker.x;
      walker.lastZ = walker.z;
      walker.lastHeading = walker.heading;
    }
    for (const vehicle of this.#vehicles) {
      vehicle.lastX = vehicle.x;
      vehicle.lastZ = vehicle.z;
      vehicle.lastHeading = vehicle.heading;
    }
  }

  #crowdTarget(): number {
    return Math.round(CROWD_MIN + (CROWD_MAX - CROWD_MIN) * Math.pow(this.#crowd, 1.2));
  }

  #walkerRate(): number {
    return this.#crowdTarget() / DWELL;
  }

  /** Vehicles per second from end e (0 west, 1 east, 2 down the side street). */
  #vehicleRate(e: number): number {
    const perMinute = e === 0 ? RATE_EB : e === 1 ? RATE_WB : RATE_SB;
    return (perMinute * this.#traffic) / 60;
  }

  // ---- The step ----

  #step(dt: number): void {
    this.#clock += dt;
    for (const w of this.#walkers) {
      w.lastX = w.x;
      w.lastZ = w.z;
      w.lastHeading = w.heading;
    }
    for (const v of this.#vehicles) {
      v.lastX = v.x;
      v.lastZ = v.z;
      v.lastHeading = v.heading;
    }
    const signals = this.#signals;
    if (signals.step(dt)) this.#walkBegins();
    this.#spawn();
    if (this.#errand.stage !== "idle") this.#stepDelivery(dt);
    this.#stepWalkers(dt);
    this.#stepVehicles(dt);
  }

  #spawn(): void {
    const random = this.#random;
    const clock = this.#clock;
    let alive = 0;
    for (const walker of this.#walkers)
      if (walker.alive && !walker.child && !walker.ahead && !walker.porter) alive++;
    if (clock >= this.#nextWalker) {
      if (alive < this.#crowdTarget()) {
        const first = this.#spawnWalker(undefined);
        if (first && random.next() < PAIR_SHARE) {
          const second = this.#spawnWalker(first);
          if (second) first.partner = second;
        }
      }
      this.#nextWalker =
        clock + random.wait(this.#walkerRate() * (alive < 0.7 * this.#crowdTarget() ? 2 : 1));
    }
    for (let e = 0; e < 3; e++) {
      if (clock < (this.#nextVehicle[e] ?? 0)) continue;
      const bike = random.next() < BIKE_SHARE;
      let name: PathName;
      if (e === 0)
        name = bike
          ? "ebBike"
          : random.next() < EB_LEFT_SHARE
            ? "ebLeft"
            : random.next() < 0.5
              ? "ebIn"
              : "ebOut";
      else if (e === 1) name = bike ? "wbBike" : random.next() < 0.5 ? "wbIn" : "wbOut";
      else name = bike ? "sbBike" : random.next() < SB_LEFT_SHARE ? "sbLeft" : "sbRight";
      // The way in must be clear; otherwise try again next step.
      const path = PATHS[name];
      const span = path.spans[0];
      let clear = true;
      if (span) {
        for (const other of this.#vehicles) {
          if (other.alive && other.lane === span.lane && other.laneC - span.c0 < 12) clear = false;
        }
      }
      if (!clear) continue;
      const vehicle = this.#launchVehicle(name, bike ? KIND_BIKE : this.#pickCar());
      if (vehicle) {
        vehicle.s = 0;
        vehicle.v = vehicle.pace;
        this.#placeVehicle(vehicle);
      }
      this.#nextVehicle[e] = clock + random.wait(this.#vehicleRate(e));
    }
    if (clock >= this.#nextOuting) {
      this.#startOuting();
      const often = OUTING_RARE + (OUTING_OFTEN - OUTING_RARE) * this.#outing;
      this.#nextOuting = clock + often * random.range(0.6, 1.4);
    }
    if (clock >= this.#nextDelivery) {
      this.#startDelivery();
      const often = DELIVERY_RARE + (DELIVERY_OFTEN - DELIVERY_RARE) * this.#delivery;
      this.#nextDelivery = clock + often * this.#deliveryRandom.range(0.6, 1.4);
    }
    if (this.#deliveryDue) this.#launchDelivery();
  }

  // ---- Walkers ----

  #freeWalker(): Walker | undefined {
    for (const walker of this.#walkers) if (!walker.alive) return walker;
    return undefined;
  }

  /** A portal by weight, other than `not`. */
  #pickPortal(not: Portal | undefined): Portal {
    const random = this.#random;
    for (let tries = 0; tries < 8; tries++) {
      let u = random.next() * PORTAL_WEIGHT;
      for (const portal of PORTALS) {
        u -= portal.weight;
        if (u <= 0) {
          if (portal !== not) return portal;
          break;
        }
      }
    }
    const other = PORTALS.find((portal) => portal !== not);
    if (!other) throw new StreetSimError("street: no portal to walk to");
    return other;
  }

  /** A new walker at a portal (or, with a companion given, beside it on the same route). */
  #spawnWalker(companion: Walker | undefined): Walker | undefined {
    const walker = this.#freeWalker();
    if (!walker) return undefined;
    const random = this.#random;
    this.#dress(walker, false);
    if (companion) {
      this.#copyRoute(walker, companion);
      walker.x = companion.x + random.range(-0.5, 0.5);
      walker.z = companion.z + random.range(-0.5, 0.5);
      walker.pace = companion.pace;
      walker.partner = companion;
    } else {
      const from = this.#pickPortal(undefined);
      const to = this.#pickPortal(from);
      walker.x = from.x + from.sx * random.range(-1, 1);
      walker.z = from.z + from.sz * random.range(-1, 1);
      this.#plan(walker, from, to);
    }
    this.#launchWalker(walker);
    return walker;
  }

  /** Who a walker is: pace, size, looks, umbrella habits. */
  #dress(walker: Walker, child: boolean): void {
    const random = this.#random;
    walker.alive = true;
    walker.child = child;
    walker.seed = random.next();
    walker.pace = child
      ? OUTING_PACE
      : random.range(PACE_MIN, PACE_MAX) * (random.next() < 0.08 ? 0.72 : 1);
    walker.radius = child ? 0.17 : random.range(0.23, 0.28);
    walker.hasUmbrella = child || random.next() < UMBRELLA_SHARE;
    walker.umbrellaKeen = child ? UMBRELLA_KEEN : random.range(UMBRELLA_KEEN, UMBRELLA_STUBBORN);
    walker.umbrellaDelay = random.range(UMBRELLA_DELAY_MIN, UMBRELLA_DELAY_MAX);
    walker.lookDelay = random.range(LOOK_DELAY_MIN, LOOK_DELAY_MAX);
    walker.partner = undefined;
    walker.ahead = undefined;
    walker.row = 0;
    walker.mode = "walk";
    walker.count = 0;
    walker.next = 0;
    walker.goAt = Number.POSITIVE_INFINITY;
    walker.settled = false;
    walker.glanceTarget = 0;
    walker.nextGlance = this.#clock + random.range(GLANCE_EVERY_MIN, GLANCE_EVERY_MAX);
    walker.look = 0;
    walker.interest = 0;
    walker.looking = false;
    walker.gait = random.next();
    walker.umbrellaClock = 0;
    walker.umbrellaUp = walker.hasUmbrella && this.#precip > walker.umbrellaKeen;
    walker.umbrella = walker.umbrellaUp ? 1 : 0;
    walker.porter = false;
    this.#unpin(walker);
  }

  /** Clear the watchdog's record: nowhere stood, never pinned, no detour. */
  #unpin(walker: Walker): void {
    walker.anchorX = Number.NaN;
    walker.anchorZ = Number.NaN;
    walker.anchorAt = this.#clock;
    walker.pinX = Number.NaN;
    walker.pinZ = Number.NaN;
    walker.tries = 0;
    walker.detourEnd = Number.NEGATIVE_INFINITY;
  }

  /** Start moving toward the first waypoint, already facing it. */
  #launchWalker(walker: Walker): void {
    const tx = walker.wx[walker.next] ?? walker.x;
    const tz = walker.wz[walker.next] ?? walker.z;
    walker.heading = Math.atan2(tz - walker.z, tx - walker.x);
    walker.vx = Math.cos(walker.heading) * walker.pace;
    walker.vz = Math.sin(walker.heading) * walker.pace;
    walker.lastX = walker.x;
    walker.lastZ = walker.z;
    walker.lastHeading = walker.heading;
  }

  #copyRoute(walker: Walker, from: Walker): void {
    const random = this.#random;
    walker.count = from.count;
    walker.next = from.next;
    for (let i = 0; i < from.count; i++) {
      walker.wx[i] = (from.wx[i] ?? 0) + random.range(-0.3, 0.3);
      walker.wz[i] = (from.wz[i] ?? 0) + random.range(-0.3, 0.3);
      walker.region[i] = from.region[i] ?? "near";
      walker.crossing[i] = from.crossing[i] ?? -1;
      walker.direction[i] = from.direction[i] ?? 0;
    }
  }

  #push(
    walker: Walker,
    x: number,
    z: number,
    region: Region,
    crossing: number,
    direction: number,
  ): void {
    if (walker.count >= MAX_WAYPOINTS) return;
    const i = walker.count++;
    walker.wx[i] = x;
    walker.wz[i] = z;
    walker.region[i] = region;
    walker.crossing[i] = crossing;
    walker.direction[i] = direction;
  }

  /** Along a sidewalk from (x0, z0) to (x1, z1): round the corner of a far block if one end is up the
   *  side street and the other along the avenue. */
  #pushAlong(walker: Walker, region: Region, x0: number, z0: number, x1: number, z1: number): void {
    if (region === "near") return;
    const s = region === "fl" ? -1 : 1;
    const up0 = z0 > FACADE_FAR - 0.2 && s * x0 < SIDE_FACADE + 0.5;
    const up1 = z1 > FACADE_FAR - 0.2 && s * x1 < SIDE_FACADE + 0.5;
    const along0 = s * x0 > SIDE_FACADE + 0.2;
    const along1 = s * x1 > SIDE_FACADE + 0.2;
    if ((up0 && along1) || (along0 && up1)) {
      this.#push(
        walker,
        s * (SIDE_KERB + 1.6) + this.#random.range(-0.4, 0.4),
        KERB_FAR + 2.7,
        region,
        -1,
        0,
      );
    }
  }

  /** A route from one portal to another: along the sidewalk, across (the shorter of the crossings
   *  that join the two sidewalks, with a little whim), and on. */
  #plan(walker: Walker, from: Portal, to: Portal): void {
    const random = this.#random;
    walker.count = 0;
    walker.next = 0;
    const ex = to.x + to.sx * random.range(-1, 1);
    const ez = to.z + to.sz * random.range(-1, 1);
    if (from.region === to.region) {
      this.#pushAlong(walker, from.region, walker.x, walker.z, ex, ez);
      this.#push(walker, ex, ez, to.region, -1, 0);
      return;
    }
    let best = -1;
    let bestDir = 1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let c = 0; c < CROSSINGS.length; c++) {
      const crossing = CROSSINGS[c];
      if (!crossing) continue;
      let dir = 0;
      if (crossing.ra === from.region && crossing.rb === to.region) dir = 1;
      else if (crossing.rb === from.region && crossing.ra === to.region) dir = -1;
      if (dir === 0) continue;
      const sx = dir > 0 ? crossing.ax : crossing.bx;
      const sz = dir > 0 ? crossing.az : crossing.bz;
      const fx = dir > 0 ? crossing.bx : crossing.ax;
      const fz = dir > 0 ? crossing.bz : crossing.az;
      const cost =
        Math.hypot(sx - walker.x, sz - walker.z) +
        Math.hypot(fx - sx, fz - sz) +
        Math.hypot(ex - fx, ez - fz) +
        random.range(0, 5);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
        bestDir = dir;
      }
    }
    const crossing = CROSSINGS[best];
    if (!crossing) {
      this.#push(walker, ex, ez, to.region, -1, 0);
      return;
    }
    const sx = bestDir > 0 ? crossing.ax : crossing.bx;
    const sz = bestDir > 0 ? crossing.az : crossing.bz;
    const fx = bestDir > 0 ? crossing.bx : crossing.ax;
    const fz = bestDir > 0 ? crossing.bz : crossing.az;
    // Spread over the crosswalk's width, a little to the left of the walking direction; both ends
    // kept on their sidewalks (the diagonals land on the rounded corners).
    const len = Math.hypot(fx - sx, fz - sz);
    const tx = -(fz - sz) / len;
    const tz = (fx - sx) / len;
    const across = CROSS_HALF * (0.85 * (random.next() + random.next() - 1) + 0.15);
    const point = this.#point;
    point[0] = sx + tx * across;
    point[1] = sz + tz * across;
    clampRegion(from.region, point);
    const kx = point[0] ?? sx;
    const kz = point[1] ?? sz;
    point[0] = fx + tx * across;
    point[1] = fz + tz * across;
    clampRegion(to.region, point);
    const lx = point[0] ?? fx;
    const lz = point[1] ?? fz;
    this.#pushAlong(walker, from.region, walker.x, walker.z, kx, kz);
    this.#push(walker, kx, kz, from.region, best, bestDir);
    this.#push(walker, lx, lz, to.region, -1, 0);
    this.#pushAlong(walker, to.region, lx, lz, ex, ez);
    this.#push(walker, ex, ez, to.region, -1, 0);
  }

  /** Put a walker somewhere along a route as if the evening had been going on a while: on a
   *  sidewalk, or (a good share) already waiting at its kerb for the green man. */
  #scatterWalker(): void {
    const walker = this.#freeWalker();
    if (!walker) return;
    const random = this.#random;
    this.#dress(walker, false);
    const from = this.#pickPortal(undefined);
    const to = this.#pickPortal(from);
    walker.x = from.x + from.sx * random.range(-1, 1);
    walker.z = from.z + from.sz * random.range(-1, 1);
    this.#plan(walker, from, to);
    let kerb = -1;
    for (let i = 0; i < walker.count; i++) if ((walker.crossing[i] ?? -1) >= 0) kerb = i;
    if (kerb >= 0 && random.next() < 0.6) {
      walker.next = kerb;
      walker.x = walker.wx[kerb] ?? walker.x;
      walker.z = walker.wz[kerb] ?? walker.z;
      this.#startWaiting(walker);
      walker.x = walker.spotX;
      walker.z = walker.spotZ;
      walker.vx = 0;
      walker.vz = 0;
      walker.heading = Math.atan2(walker.faceZ, walker.faceX);
      walker.settled = true;
      return;
    }
    // Somewhere on a sidewalk leg (not on a crossing): between two waypoints of the same region.
    const legs: number[] = [];
    for (let i = 0; i < walker.count; i++) {
      if (i === 0 || (walker.crossing[i - 1] ?? -1) < 0) legs.push(i);
    }
    const leg = legs[Math.floor(random.next() * legs.length)] ?? 0;
    const ax = leg > 0 ? (walker.wx[leg - 1] ?? walker.x) : walker.x;
    const az = leg > 0 ? (walker.wz[leg - 1] ?? walker.z) : walker.z;
    const f = random.range(0.1, 0.9);
    walker.x = ax + ((walker.wx[leg] ?? ax) - ax) * f;
    walker.z = az + ((walker.wz[leg] ?? az) - az) * f;
    walker.next = leg;
    this.#keepToSidewalk(walker, walker.region[leg] ?? "near");
    this.#launchWalker(walker);
  }

  /** The school outing: a teacher, children two by two, an assistant at the end of the line. */
  #startOuting(): void {
    const random = this.#random;
    const teacher = this.#freeWalker();
    if (!teacher) return;
    this.#dress(teacher, false);
    teacher.pace = OUTING_PACE;
    teacher.hasUmbrella = true;
    teacher.umbrellaKeen = UMBRELLA_KEEN;
    teacher.umbrellaUp = this.#precip > UMBRELLA_KEEN;
    teacher.umbrella = teacher.umbrellaUp ? 1 : 0;
    // From one side of the avenue to the other: the near sidewalk and a far corner.
    const nearSide = PORTALS.filter((portal) => portal.region === "near" && portal.sz > 0);
    const farSide = PORTALS.filter((portal) => portal.region !== "near" && portal.sz > 0);
    const near = nearSide[Math.floor(random.next() * nearSide.length)];
    const far = farSide[Math.floor(random.next() * farSide.length)];
    if (!near || !far) {
      teacher.alive = false;
      return;
    }
    const outbound = random.next() < 0.5;
    const from = outbound ? near : far;
    const to = outbound ? far : near;
    teacher.x = from.x;
    teacher.z = from.z;
    this.#plan(teacher, from, to);
    this.#launchWalker(teacher);
    const exitX = teacher.wx[teacher.count - 1] ?? to.x;
    const exitZ = teacher.wz[teacher.count - 1] ?? to.z;
    const back = from.x < 0 ? -1 : 1;
    const kids = 2 * Math.round(random.range(OUTING_MIN, OUTING_MAX) / 2);
    const line: Walker[] = [];
    for (let k = 0; k < kids; k++) {
      const child = this.#freeWalker();
      if (!child) break;
      this.#dress(child, true);
      const row = k % 2 === 0 ? -1 : 1;
      child.row = row;
      child.mode = "follow";
      child.ahead = k < 2 ? teacher : line[k - 2];
      child.exitX = exitX;
      child.exitZ = exitZ;
      child.x = from.x + back * (0.9 + OUTING_SPACING * Math.floor(k / 2));
      child.z = from.z + row * OUTING_ROW;
      child.heading = teacher.heading;
      child.lastX = child.x;
      child.lastZ = child.z;
      child.lastHeading = child.heading;
      line.push(child);
    }
    const assistant = this.#freeWalker();
    const last = line[line.length - 1];
    if (assistant && last) {
      this.#dress(assistant, false);
      assistant.pace = OUTING_PACE;
      assistant.mode = "follow";
      assistant.ahead = last;
      assistant.row = 0;
      assistant.exitX = exitX;
      assistant.exitZ = exitZ;
      assistant.x = last.x + back * OUTING_SPACING;
      assistant.z = from.z;
      assistant.heading = teacher.heading;
      assistant.lastX = assistant.x;
      assistant.lastZ = assistant.z;
      assistant.lastHeading = assistant.heading;
    }
  }

  // ---- The late delivery ----

  /** A delivery sets out (by the knob's schedule or its "now"), unless one is under way. */
  #startDelivery(): void {
    if (this.#errand.stage === "idle") this.#deliveryDue = true;
  }

  /** The van comes in from the west along the avenue's outer lane, once that way in is clear. Its
   *  looks and pace are fixed, so it draws nothing from the street's generator. */
  #launchDelivery(): void {
    for (const other of this.#vehicles)
      if (other.alive && other.lane === L_EB_OUT && other.laneC < 12) return;
    const van = this.#vehicles.find((v) => !v.alive);
    if (!van) return;
    van.alive = true;
    van.kind = KIND_VAN;
    van.path = "ebOut";
    van.seed = DELIVERY_SEED;
    van.pace = CAR_PACE * 0.95;
    van.brake = 0;
    van.stopping = false;
    van.sawAmber = false;
    van.umbrella = 0;
    van.delivery = true;
    van.offset = 0;
    van.pullOut = Number.NaN;
    van.swerve = 0;
    van.s = 0;
    van.v = van.pace;
    this.#placeVehicle(van);
    this.#van = van;
    this.#deliveryDue = false;
    this.#errand.start(this.#deliveryRandom);
  }

  /** The episode's step: what the van and its driver are doing goes to the errand, which says what
   *  comes next; the driver gets out of the cab once the van is parked and back in at the end. */
  #stepDelivery(dt: number): void {
    const errand = this.#errand;
    const van = this.#van;
    if (!van?.alive || !van.delivery) {
      // Driven off the end of the avenue.
      this.#retirePorter();
      errand.stop();
      this.#van = undefined;
      return;
    }
    const porter = this.#porter;
    const away = porter
      ? Math.hypot(porter.goalX - porter.x, porter.goalZ - porter.z)
      : Number.POSITIVE_INFINITY;
    const there =
      porter !== undefined &&
      (away < PORTER_REACH ||
        (away < PORTER_NEAR && Math.hypot(porter.vx, porter.vz) < PORTER_STUCK));
    const parked =
      van.lane === L_KERB && van.v < 0.05 && Math.abs(van.s - (DELIVERY_X + AVENUE_END)) < 0.6;
    errand.step(dt, { parked, porterThere: there });
    if (errand.porterOut && !this.#porter) this.#letOutPorter(van);
    if (!errand.porterOut) this.#retirePorter();
    const p = this.#porter;
    if (!p) return;
    switch (errand.goal) {
      case "vehicle":
        p.goalX = van.x + PORTER_BACK;
        p.goalZ = PORTER_KERB;
        p.faceX = 0.35;
        p.faceZ = -1;
        break;
      case "door":
        p.goalX = SERVICE_DOOR;
        p.goalZ = FACADE_FAR + SERVICE_INSIDE;
        p.faceX = 0;
        p.faceZ = 1;
        break;
      case "cab":
        p.goalX = van.x + PORTER_CAB;
        p.goalZ = PORTER_KERB;
        p.faceX = 0;
        p.faceZ = -1;
        break;
      default: {
        const unreachable: never = errand.goal;
        throw new StreetSimError(`street: unknown errand goal ${String(unreachable)}`);
      }
    }
    p.pace = errand.load > 0 ? PORTER_LOADED : PORTER_PACE;
    p.radius = errand.load > 0 ? PORTER_TROLLEY : PORTER_RADIUS;
  }

  /** The driver steps out of the kerbside cab door onto the sidewalk; without a free walker the
   *  delivery is called off and the van leaves. */
  #letOutPorter(van: Vehicle): void {
    const w = this.#freeWalker();
    if (!w) {
      this.#errand.stop();
      return;
    }
    w.alive = true;
    w.child = false;
    w.porter = true;
    w.mode = "errand";
    w.seed = DELIVERY_SEED;
    w.pace = PORTER_PACE;
    w.radius = PORTER_RADIUS;
    w.hasUmbrella = false;
    w.umbrellaUp = false;
    w.umbrella = 0;
    w.umbrellaClock = 0;
    w.look = 0;
    w.interest = 0;
    w.looking = false;
    w.gait = 0;
    w.partner = undefined;
    w.ahead = undefined;
    w.row = 0;
    w.count = 0;
    w.next = 0;
    w.goAt = Number.POSITIVE_INFINITY;
    w.settled = false;
    w.glanceTarget = 0;
    w.nextGlance = Number.POSITIVE_INFINITY;
    w.x = van.x + PORTER_CAB;
    w.z = PORTER_KERB;
    w.vx = 0;
    w.vz = 0;
    w.ax = 0;
    w.az = 0;
    w.heading = Math.PI;
    w.lastX = w.x;
    w.lastZ = w.z;
    w.lastHeading = w.heading;
    w.goalX = w.x;
    w.goalZ = w.z;
    w.faceX = -1;
    w.faceZ = 0;
    this.#unpin(w);
    this.#porter = w;
  }

  #retirePorter(): void {
    if (!this.#porter) return;
    this.#retire(this.#porter);
    this.#porter = undefined;
  }

  /** The van's blinker: left as it pulls in, hazards while parked, right as it waits and pulls out. */
  #vanBlinker(van: Vehicle): number {
    const errand = this.#errand;
    if (errand.hazards) return 2;
    if (errand.stage === "arriving")
      return DELIVERY_X + AVENUE_END - van.s < DELIVERY_SIGNAL ? 1 : 0;
    return van.offset > 0.2 ? -1 : 0;
  }

  /** The green man has come on: everyone waiting steps off, front first. */
  #walkBegins(): void {
    const random = this.#random;
    for (const walker of this.#walkers) {
      if (!walker.alive || walker.mode !== "wait") continue;
      walker.goAt =
        this.#clock +
        STEP_OFF +
        STEP_OFF_PER_METRE * walker.depth +
        STEP_OFF_SPREAD * random.next();
    }
    // Partners step off together.
    for (const walker of this.#walkers) {
      const partner = walker.partner;
      if (walker.alive && walker.mode === "wait" && partner?.alive && partner.mode === "wait") {
        walker.goAt = Math.min(walker.goAt, partner.goAt + 0.15);
      }
    }
  }

  /** Arrived at a kerb with the green man off: find a place in the crowd there and wait. */
  #startWaiting(walker: Walker): void {
    const random = this.#random;
    const c = walker.crossing[walker.next] ?? -1;
    const dir = walker.direction[walker.next] ?? 1;
    const crossing = CROSSINGS[c];
    if (!crossing) return;
    const sx = dir > 0 ? crossing.ax : crossing.bx;
    const sz = dir > 0 ? crossing.az : crossing.bz;
    const fx = dir > 0 ? crossing.bx : crossing.ax;
    const fz = dir > 0 ? crossing.bz : crossing.az;
    const len = Math.hypot(fx - sx, fz - sz);
    const dx = (fx - sx) / len;
    const dz = (fz - sz) / len;
    const region = dir > 0 ? crossing.ra : crossing.rb;
    const partner = walker.partner;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let tries = 0; tries < SPOT_TRIES; tries++) {
      let depth = SPOT_DEPTH * Math.pow(random.next(), 1.6);
      let side = (CROSS_HALF + 0.7) * (2 * random.next() - 1);
      if (partner?.alive && partner.mode === "wait") {
        // Beside its partner.
        depth = Math.max(0, partner.depth + random.range(-0.2, 0.2));
        side =
          (partner.spotX - sx) * -dz +
          (partner.spotZ - sz) * dx +
          (random.next() < 0.5 ? -PAIR_GAP : PAIR_GAP);
      }
      this.#point[0] = sx - dx * (0.15 + depth) - dz * side;
      this.#point[1] = sz - dz * (0.15 + depth) + dx * side;
      clampRegion(region, this.#point);
      const px = this.#point[0] ?? sx;
      const pz = this.#point[1] ?? sz;
      let score = depth + 0.3 * Math.abs(side);
      for (const other of this.#walkers) {
        if (other === walker || !other.alive || (other.mode !== "wait" && !other.child)) continue;
        const ox = other.mode === "wait" ? other.spotX : other.x;
        const oz = other.mode === "wait" ? other.spotZ : other.z;
        const d = Math.hypot(ox - px, oz - pz);
        if (d < SPOT_SPACE) score += (SPOT_SPACE - d) * 14;
      }
      if (score < bestScore) {
        bestScore = score;
        walker.spotX = px;
        walker.spotZ = pz;
        walker.depth = Math.max(0, (sx - px) * dx + (sz - pz) * dz);
      }
    }
    walker.faceX = dx;
    walker.faceZ = dz;
    walker.mode = "wait";
    walker.settled = false;
    walker.goAt = Number.POSITIVE_INFINITY;
  }

  #stepWalkers(dt: number): void {
    const walkers = this.#walkers;
    this.#buildGrid();
    for (const w of walkers) {
      if (!w.alive) continue;
      w.onRoad = w.z > KERB_NEAR + 0.1 && (w.z < KERB_FAR - 0.1 || Math.abs(w.x) < SIDE_KERB - 0.1);
    }
    // Forces from where everyone is now; then everyone moves.
    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i];
      if (!w?.alive) continue;
      this.#decide(w);
      if (!w.alive) continue;
      this.#forces(w, i);
    }
    for (const w of walkers) {
      if (!w.alive) continue;
      this.#move(w, dt);
    }
    this.#weatherAndPointer(dt);
  }

  /** Waypoints reached, kerbs, stepping off, leaving; the watchdog. */
  #decide(w: Walker): void {
    const signals = this.#signals;
    const clock = this.#clock;
    // The delivery's driver goes where its errand sends it (#stepDelivery).
    if (w.mode === "errand") return;
    if (this.#watch(w)) return;
    if (w.mode === "follow") {
      const ahead = w.ahead;
      if (ahead && !ahead.alive) w.ahead = undefined;
      if (!w.ahead && Math.hypot(w.exitX - w.x, w.exitZ - w.z) < 1.2) this.#retire(w);
      return;
    }
    if (w.mode === "wait") {
      // Nobody sets off once the green man flashes.
      if (clock >= w.goAt && signals.walk) {
        w.mode = "cross";
        w.settled = false;
        w.next++;
      }
      return;
    }
    const tx = w.wx[w.next] ?? w.x;
    const tz = w.wz[w.next] ?? w.z;
    const kerb = (w.crossing[w.next] ?? -1) >= 0 && w.mode === "walk";
    const dist = Math.hypot(tx - w.x, tz - w.z);
    if (dist > (kerb ? REACH_KERB : REACH)) return;
    if (kerb) {
      this.#atKerb(w);
      return;
    }
    if (w.next >= w.count - 1) {
      // Gone (an outing's children make their own way to the exit behind it).
      this.#retire(w);
      return;
    }
    w.next++;
    if (w.mode === "cross") w.mode = "walk";
  }

  /** At its crossing's kerb: across with the green man (or, the brave, while it flashes with time
   *  enough left), else into the crowd waiting there. */
  #atKerb(w: Walker): void {
    const signals = this.#signals;
    const crossing = CROSSINGS[w.crossing[w.next] ?? 0];
    const len = crossing ? Math.hypot(crossing.bx - crossing.ax, crossing.bz - crossing.az) : 18;
    const brave =
      signals.flash && signals.remaining > len / (w.pace * HURRY) && (w.seed * 13.7) % 1 < 0.35;
    if (signals.walk || brave) {
      w.mode = "cross";
      w.next++;
    } else {
      this.#startWaiting(w);
    }
  }

  /** The watchdog: a walker pinned on its way (against a pole, a wall or the crowd) joins the crowd
   *  at its crossing's kerb if it is that near, else steps aside for a moment, and after STUCK_TRIES
   *  detours that got it nowhere gives up its way: out of view it leaves there and then, in view it
   *  sets off for the nearest way out (#leaveNearest) and goes on stepping aside while it is held
   *  up, so it neither stands there for good, nor keeps newcomers away, nor vanishes before the
   *  eye. Returns true once it has stopped walking its way (it waits at the kerb now, or has gone). */
  #watch(w: Walker): boolean {
    const clock = this.#clock;
    const moved = Math.hypot(w.x - w.anchorX, w.z - w.anchorZ);
    if (this.#layingOut || w.mode === "wait" || !(moved <= STUCK_RADIUS) || w.away < STUCK_FAR) {
      w.anchorX = w.x;
      w.anchorZ = w.z;
      w.anchorAt = clock;
      if (!(Math.hypot(w.x - w.pinX, w.z - w.pinZ) < STUCK_CLEAR)) w.tries = 0;
      return false;
    }
    if (clock - w.anchorAt < STUCK_TIME) return false;
    w.anchorAt = clock;
    w.pinX = w.x;
    w.pinZ = w.z;
    const tx = w.wx[w.next] ?? w.x;
    const tz = w.wz[w.next] ?? w.z;
    if (
      w.mode === "walk" &&
      (w.crossing[w.next] ?? -1) >= 0 &&
      Math.hypot(tx - w.x, tz - w.z) < SPOT_DEPTH + 1
    ) {
      this.#atKerb(w);
      return true;
    }
    if (w.tries >= STUCK_TRIES) {
      if (!this.#inView(w.x, w.z)) {
        this.#retire(w);
        return true;
      }
      this.#leaveNearest(w);
      w.tries = 0;
    }
    w.tries++;
    // Aside: square to its way, toward the middle of its sidewalk first (the open side of a pole on
    // the kerb or a machine by the wall), then the other way; on the street, left first.
    const gd = Math.hypot(w.awayX - w.x, w.awayZ - w.z) || 1;
    const gx = (w.awayX - w.x) / gd;
    const gz = (w.awayZ - w.z) / gd;
    const point = this.#point2;
    let side = 1;
    if (!w.onRoad) {
      towardMiddle(w.x, w.z, point);
      if (-gz * (point[0] ?? 0) + gx * (point[1] ?? 0) < 0) side = -1;
    }
    if (w.tries % 2 === 0) side = -side;
    point[0] = w.x - gz * side * DETOUR_STEP + gx * 0.5;
    point[1] = w.z + gx * side * DETOUR_STEP + gz * 0.5;
    if (w.mode === "walk") clampRegion(w.region[w.next] ?? "near", point);
    else if (w.mode === "follow" && !w.onRoad) clampRegion(regionAt(w.x, w.z), point);
    w.detourX = point[0] ?? w.x;
    w.detourZ = point[1] ?? w.z;
    w.detourEnd = clock + DETOUR_TIME;
    return false;
  }

  #retire(w: Walker): void {
    w.alive = false;
    this.#alone(w);
  }

  /** It walks on alone: no partner, and nobody's. */
  #alone(w: Walker): void {
    w.partner = undefined;
    for (const other of this.#walkers) if (other.partner === w) other.partner = undefined;
  }

  /** A walker that has given up its way sets off alone for the nearest way out (its portal's spread
   *  picked by its seed): out of the sidewalk it is walking along, or, on a crossing, out of the one
   *  it is crossing to, reaching that kerb first. An outing's child keeps to its line. */
  #leaveNearest(w: Walker): void {
    if (w.mode !== "walk" && w.mode !== "cross") return;
    const region = w.region[w.next] ?? "near";
    const crossing = w.mode === "cross";
    const fromX = crossing ? (w.wx[w.next] ?? w.x) : w.x;
    const fromZ = crossing ? (w.wz[w.next] ?? w.z) : w.z;
    let exit: Portal | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const portal of PORTALS) {
      const d = Math.hypot(portal.x - fromX, portal.z - fromZ);
      if (portal.region === region && d < nearest) {
        nearest = d;
        exit = portal;
      }
    }
    if (!exit) return;
    const spread = 2 * ((w.seed * 7.31) % 1) - 1;
    const ex = exit.x + exit.sx * spread;
    const ez = exit.z + exit.sz * spread;
    w.count = 0;
    w.next = 0;
    if (crossing) this.#push(w, fromX, fromZ, region, -1, 0);
    this.#pushAlong(w, region, fromX, fromZ, ex, ez);
    this.#push(w, ex, ez, region, -1, 0);
    this.#alone(w);
  }

  /** Whether any of a walker standing at (x, z) shows in the frame as the window sees it now: its
   *  feet to the top of an open umbrella, and its reach either side. */
  #inView(x: number, z: number): boolean {
    const pitch = PITCH - this.#tilt;
    const sin = Math.sin(pitch);
    const cos = Math.cos(pitch);
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 2; k++) {
      // Relative to the window (CAM_X, CAM_H, 0), looking along +z pitched down (#toGround's ray).
      const dy = k * WALKER_TOP - CAM_H;
      const depth = z * cos - dy * sin;
      if (depth <= 1e-3) continue;
      const f = FOCAL / depth;
      const sx = (x - CAM_X) * f;
      const sy = (dy * cos + z * sin) * f;
      const reach = WALKER_REACH * f;
      left = Math.min(left, sx - reach);
      right = Math.max(right, sx + reach);
      low = Math.min(low, sy - reach);
      high = Math.max(high, sy + reach);
    }
    const half = this.#aspect / 2;
    return right >= -half && left <= half && high >= -0.5 && low <= 0.5;
  }

  #forces(w: Walker, i: number): void {
    const signals = this.#signals;
    // The pull: toward the next waypoint, the waiting spot, or the place in line.
    let tx = w.x;
    let tz = w.z;
    let speed = w.pace;
    let arrive = false;
    switch (w.mode) {
      case "walk":
        tx = w.wx[w.next] ?? w.x;
        tz = w.wz[w.next] ?? w.z;
        break;
      case "cross":
        tx = w.wx[w.next] ?? w.x;
        tz = w.wz[w.next] ?? w.z;
        if (signals.flash || (!signals.walk && w.onRoad)) speed *= HURRY;
        break;
      case "wait":
        tx = w.spotX;
        tz = w.spotZ;
        speed *= 0.8;
        arrive = true;
        break;
      case "follow": {
        const ahead = w.ahead;
        if (ahead) {
          const hx = Math.cos(ahead.heading);
          const hz = Math.sin(ahead.heading);
          const gap = ahead.child ? OUTING_SPACING : OUTING_SPACING + 0.2;
          const side = ahead.child ? 0 : w.row * OUTING_ROW;
          tx = ahead.x - hx * gap - hz * side;
          tz = ahead.z - hz * gap + hx * side;
        } else {
          tx = w.exitX;
          tz = w.exitZ;
        }
        speed *= 1.35;
        arrive = true;
        break;
      }
      case "errand":
        tx = w.goalX;
        tz = w.goalZ;
        arrive = true;
        break;
      default: {
        const unreachable: never = w.mode;
        throw new StreetSimError(`street: unknown walker mode ${String(unreachable)}`);
      }
    }
    w.awayX = tx;
    w.awayZ = tz;
    w.away = Math.hypot(tx - w.x, tz - w.z);
    const onItsWay =
      !this.#layingOut && (w.mode === "walk" || w.mode === "cross" || w.mode === "follow");
    if (onItsWay && w.detourEnd > this.#clock) {
      // Stepping aside (the watchdog's detour), until it is there.
      if (Math.hypot(w.detourX - w.x, w.detourZ - w.z) < 0.3) {
        w.detourEnd = Number.NEGATIVE_INFINITY;
      } else {
        tx = w.detourX;
        tz = w.detourZ;
        speed = w.pace;
        arrive = false;
      }
    } else if (onItsWay && w.mode === "walk") {
      const region = w.region[w.next] ?? "near";
      const point = this.#point2;
      if (roundCorner(region, w.x, w.z, tx, tz, point)) {
        tx = point[0] ?? tx;
        tz = point[1] ?? tz;
      } else if (!((w.crossing[w.next] ?? -1) >= 0 && w.away < STEP_OUT)) {
        // Along its sidewalk, in from the kerb: a point a little ahead on its way that comes within
        // KERB_INSET of the kerb is held that far in, and it steers at that instead (the walls are
        // as before); not while it steps out to the kerb point it crosses from.
        const reach = w.away > CARROT ? CARROT / w.away : 1;
        const carrotX = w.x + (tx - w.x) * reach;
        const carrotZ = w.z + (tz - w.z) * reach;
        point[0] = carrotX;
        point[1] = carrotZ;
        clampRegion(region, point, Number.NaN, KERB_INSET);
        const insetX = point[0] ?? carrotX;
        const insetZ = point[1] ?? carrotZ;
        point[0] = carrotX;
        point[1] = carrotZ;
        clampRegion(region, point);
        if (insetX !== point[0] || insetZ !== point[1]) {
          tx = insetX;
          tz = insetZ;
        }
      }
    }
    let dx = tx - w.x;
    let dz = tz - w.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-6) {
      dx /= dist;
      dz /= dist;
    }
    let want = arrive ? Math.min(speed, dist * 1.2) : speed;
    want *= 1 - LOOK_SLOW * w.look;
    let ax = (dx * want - w.vx) / RELAX;
    let az = (dz * want - w.vz) / RELAX;
    // How far it is held up: 0 while it makes HELD of the headway it wants, 1 standing (waiting
    // walkers stand by choice).
    const held =
      onItsWay && want > 0.2 ? clamp(1 - (w.vx * dx + w.vz * dz) / (HELD * want), 0, 1) : 0;

    // Pairs keep beside each other while they walk.
    const partner = w.partner;
    if (partner?.alive && (w.mode === "walk" || w.mode === "cross") && partner.mode === w.mode) {
      const hx = Math.cos(partner.heading);
      const hz = Math.sin(partner.heading);
      const side = (w.x - partner.x) * -hz + (w.z - partner.z) * hx >= 0 ? 1 : -1;
      const px = partner.x - hz * side * PAIR_GAP - w.x;
      const pz = partner.z + hx * side * PAIR_GAP - w.z;
      const pull = Math.min(Math.hypot(px, pz), 1.5) * PAIR_PULL;
      const pd = Math.hypot(px, pz) || 1;
      ax += (px / pd) * pull;
      az += (pz / pd) * pull;
    }

    // Everyone near: exponential repulsion, weaker from behind; contact; a sidestep to the left
    // from people coming the other way.
    const moving = Math.hypot(w.vx, w.vz);
    const ex = moving > 0.1 ? w.vx / moving : Math.cos(w.heading);
    const ez = moving > 0.1 ? w.vz / moving : Math.sin(w.heading);
    let sx = 0;
    let sz = 0;
    const cx = Math.floor((w.x - GRID_X0) / GRID);
    const cz = Math.floor((w.z - GRID_Z0) / GRID);
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      if (gz < 0 || gz >= GRID_H) continue;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        if (gx < 0 || gx >= GRID_W) continue;
        const cell = gz * GRID_W + gx;
        const end = this.#cellStart[cell + 1] ?? 0;
        for (let k = this.#cellStart[cell] ?? 0; k < end; k++) {
          const j = this.#cellItems[k] ?? -1;
          if (j === i) continue;
          const o = this.#walkers[j];
          if (!o?.alive) continue;
          let nx = w.x - o.x;
          let nz = w.z - o.z;
          const d = Math.sqrt(nx * nx + nz * nz);
          if (d > NEAR_RANGE || d < 1e-6) continue;
          nx /= d;
          nz /= d;
          const rr = w.radius + o.radius;
          const ahead = -(ex * nx + ez * nz); // 1: o is straight ahead
          const weight = SOCIAL_BEHIND + (1 - SOCIAL_BEHIND) * 0.5 * (1 + ahead);
          // The outing keeps close together; the crowd at a kerb stands a little closer than walkers pass.
          const space =
            (w.child && o.child) || w.ahead === o || o.ahead === w
              ? 0
              : w.mode === "wait" && o.mode === "wait"
                ? SOCIAL_SPACE * 0.4
                : SOCIAL_SPACE;
          let f = SOCIAL_A * Math.exp((rr + space - d) / SOCIAL_B) * weight;
          if (d < rr) f += CONTACT * (rr - d);
          sx += nx * f;
          sz += nz * f;
          // Oncoming: sidestep to the left of the walking direction.
          if (moving > 0.3 && ahead > 0.5 && d < 3) {
            const om = Math.hypot(o.vx, o.vz);
            if (om > 0.3 && (o.vx * ex + o.vz * ez) / om < -0.3) {
              const push = SIDESTEP * (1 - d / 3);
              sx += -ez * push;
              sz += ex * push;
            }
          }
        }
      }
    }
    // Poles and vending machines.
    const force = this.#force;
    force[0] = sx;
    force[1] = sz;
    // The sidewalk it is kept to, if any, for the room round an obstacle (#move's clamps).
    const keptTo =
      w.mode === "walk"
        ? (w.region[w.next] ?? "near")
        : w.mode === "follow" && !w.onRoad && !w.ahead?.onRoad
          ? regionAt(w.x, w.z)
          : undefined;
    for (const o of OBSTACLES)
      this.#avoid(w, clamp(w.x, o.x0, o.x1), clamp(w.z, o.z0, o.z1), o, dx, dz, held, keptTo);
    sx = force[0] ?? sx;
    sz = force[1] ?? sz;
    // A walker caught on the street keeps clear of the vehicles.
    if (w.onRoad) {
      for (const vehicle of this.#vehicles) {
        if (!vehicle.alive) continue;
        const shape = SHAPES[vehicle.kind];
        const reach = (shape?.length ?? 4) / 2 + 0.6;
        const dx2 = w.x - vehicle.x;
        const dz2 = w.z - vehicle.z;
        const d = Math.hypot(dx2, dz2);
        if (d < reach && d > 1e-6) {
          sx += (dx2 / d) * 2.5 * (reach - d);
          sz += (dz2 / d) * 2.5 * (reach - d);
        }
      }
    }
    if (w.settled) {
      // Standing still until pushed properly.
      if (Math.hypot(sx, sz) < UNSETTLE) {
        w.ax = 0;
        w.az = 0;
        return;
      }
      w.settled = false;
    }
    w.ax = ax + sx;
    w.az = az + sz;
  }

  /** Add the push from an obstacle to #force: the repulsion from its nearest point (px, pz), and
   *  for a walker held up (0..1) by it in its way (going gx, gz) a slide round it. A repulsion alone
   *  stands a walker pressed onto a pole by its pull still, and on the kerb side of a pole, or the
   *  wall side of a machine, the walker's sidewalk (`keptTo`) leaves it no room to pass. */
  #avoid(
    w: Walker,
    px: number,
    pz: number,
    o: Obstacle,
    gx: number,
    gz: number,
    held: number,
    keptTo: Region | undefined,
  ): void {
    const nx = w.x - px;
    const nz = w.z - pz;
    const d = Math.sqrt(nx * nx + nz * nz);
    if (d > 1.6 || d < 1e-6) return;
    const f =
      SOCIAL_A * 1.2 * Math.exp((w.radius + o.r + 0.08 - d) / SOCIAL_B) +
      (d < w.radius + o.r ? CONTACT * (w.radius + o.r - d) : 0);
    const force = this.#force;
    force[0] = (force[0] ?? 0) + (nx / d) * f;
    force[1] = (force[1] ?? 0) + (nz / d) * f;
    // How squarely it stands in the way (1: dead ahead).
    const ahead = -(gx * nx + gz * nz) / d;
    if (held <= 0 || ahead <= 0) return;
    // Square to the push: on the side toward where it is going (dead ahead, its open side), unless
    // its sidewalk has no room for it beside the obstacle there (past a machine's far end).
    const tx = -nz / d;
    const tz = nx / d;
    const toward = tx * gx + tz * gz;
    let side = Math.abs(toward) > 0.05 ? Math.sign(toward) : tx * o.ix + tz * o.iz < 0 ? -1 : 1;
    if (keptTo !== undefined) {
      const ux = side * tx;
      const uz = side * tz;
      const past =
        Math.max(o.x0 * ux, o.x1 * ux) + Math.max(o.z0 * uz, o.z1 * uz) - (px * ux + pz * uz);
      const clear = past + w.radius + o.r + 0.05;
      const room = this.#point;
      const qx = px + ux * clear;
      const qz = pz + uz * clear;
      room[0] = qx;
      room[1] = qz;
      clampRegion(keptTo, room);
      if (room[0] !== qx || room[1] !== qz) side = -side;
    }
    const slide = SLIDE * f * ahead * held * side;
    force[0] = (force[0] ?? 0) + tx * slide;
    force[1] = (force[1] ?? 0) + tz * slide;
  }

  #move(w: Walker, dt: number): void {
    const clock = this.#clock;
    if (!w.settled) {
      w.vx += w.ax * dt;
      w.vz += w.az * dt;
      const speed = Math.hypot(w.vx, w.vz);
      if (speed > TOP_SPEED) {
        w.vx *= TOP_SPEED / speed;
        w.vz *= TOP_SPEED / speed;
      }
      w.x += w.vx * dt;
      w.z += w.vz * dt;
      if (w.mode === "walk" || w.mode === "wait")
        this.#keepToSidewalk(w, w.region[w.next] ?? "near");
      else if (w.mode === "errand") this.#keepToSidewalk(w, "fr", SERVICE_DOOR);
      // The outing's line keeps to the sidewalk it is on until the one ahead steps off to cross
      // (else the crowd at a kerb would press the waiting children into the traffic).
      else if (w.mode === "follow" && !w.onRoad && !w.ahead?.onRoad)
        this.#keepToSidewalk(w, regionAt(w.x, w.z));
      // Settle: on the spot, or wherever the crowd has come to rest round it.
      const fromSpot = Math.hypot(w.spotX - w.x, w.spotZ - w.z);
      if (
        w.mode === "wait" &&
        ((fromSpot < SETTLE_NEAR && speed < SETTLE_SPEED) || (fromSpot < 1.2 && speed < 0.05))
      ) {
        w.settled = true;
        w.vx = 0;
        w.vz = 0;
      }
      // The gait runs with the distance walked; slowing to a stop, the feet come together (the
      // nearest half cycle, where the legs pass each other).
      if (speed > 0.25) w.gait = (w.gait + (speed * dt) / STRIDE) % 1;
      else w.gait += (Math.round(w.gait * 2) / 2 - w.gait) * Math.min(1, dt * 3);
    }
    // Facing: along the way when walking; the street when standing, glancing about now and then.
    const speed = Math.hypot(w.vx, w.vz);
    let target = w.heading;
    let rate = TURN_WALK;
    if (w.mode === "wait" && (w.settled || speed < 0.25)) {
      if (clock >= w.nextGlance) {
        w.glanceTarget =
          w.glanceTarget !== 0
            ? 0
            : (this.#random.next() < 0.5 ? -1 : 1) * GLANCE_ANGLE * this.#random.range(0.4, 1);
        w.nextGlance =
          clock +
          (w.glanceTarget !== 0
            ? GLANCE_HOLD * this.#random.range(0.6, 1.6)
            : this.#random.range(GLANCE_EVERY_MIN, GLANCE_EVERY_MAX));
      }
      target = Math.atan2(w.faceZ, w.faceX) + w.glanceTarget;
      rate = TURN_STAND;
    } else if (w.mode === "errand" && speed < 0.2) {
      // Standing at the van or at its door: facing what it is doing.
      target = Math.atan2(w.faceZ, w.faceX);
      rate = TURN_STAND;
    } else if (speed > 0.2) {
      target = Math.atan2(w.vz, w.vx);
    }
    const turn = angleDiff(target, w.heading);
    w.heading += clamp(turn, -rate * dt, rate * dt);
    if (w.heading > Math.PI) w.heading -= TAU;
    if (w.heading < -Math.PI) w.heading += TAU;
  }

  /** Clamp a walker into its sidewalk (and through `door`, a door only it may use). */
  #keepToSidewalk(w: Walker, region: Region, door = Number.NaN): void {
    this.#point2[0] = w.x;
    this.#point2[1] = w.z;
    clampRegion(region, this.#point2, door);
    const x = this.#point2[0] ?? w.x;
    const z = this.#point2[1] ?? w.z;
    if (x !== w.x) w.vx *= 0.5;
    if (z !== w.z) w.vz *= 0.5;
    w.x = x;
    w.z = z;
  }

  /** Umbrellas follow the rain or snow; heads turn up toward the pointer's window. */
  #weatherAndPointer(dt: number): void {
    const precip = this.#precip;
    for (const w of this.#walkers) {
      if (!w.alive || w.porter) continue;
      const wants = w.hasUmbrella && precip > w.umbrellaKeen * (w.umbrellaUp ? 0.5 : 1);
      if (wants !== w.umbrellaUp) {
        w.umbrellaClock += dt;
        if (w.umbrellaClock > w.umbrellaDelay * (wants ? 1 : 1.6)) {
          w.umbrellaUp = wants;
          w.umbrellaClock = 0;
        }
      } else {
        w.umbrellaClock = 0;
      }
      w.umbrella = clamp(w.umbrella + (w.umbrellaUp ? dt : -dt) / UMBRELLA_OPEN, 0, 1);

      const near = this.#hover && Math.hypot(this.#hoverX - w.x, this.#hoverZ - w.z) < LOOK_RADIUS;
      w.interest = clamp(w.interest + (near ? dt : -0.7 * dt), 0, 2.5);
      if (!w.looking && w.interest > w.lookDelay) w.looking = true;
      if (w.looking && w.interest < 0.05) w.looking = false;
      w.look = clamp(w.look + ((w.looking ? 1 : 0) - w.look) * Math.min(1, dt / LOOK_EASE), 0, 1);
    }
  }

  #buildGrid(): void {
    const start = this.#cellStart;
    start.fill(0);
    const walkers = this.#walkers;
    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i];
      let cell = -1;
      if (w?.alive) {
        const gx = Math.floor((w.x - GRID_X0) / GRID);
        const gz = Math.floor((w.z - GRID_Z0) / GRID);
        if (gx >= 0 && gx < GRID_W && gz >= 0 && gz < GRID_H) cell = gz * GRID_W + gx;
      }
      this.#cellOf[i] = cell;
      if (cell >= 0) start[cell + 1] = (start[cell + 1] ?? 0) + 1;
    }
    for (let c = 0; c < GRID_W * GRID_H; c++) start[c + 1] = (start[c + 1] ?? 0) + (start[c] ?? 0);
    const cursor = this.#cellCursor;
    for (let c = 0; c < GRID_W * GRID_H; c++) cursor[c] = start[c] ?? 0;
    for (let i = 0; i < walkers.length; i++) {
      const cell = this.#cellOf[i] ?? -1;
      if (cell < 0) continue;
      const at = cursor[cell] ?? 0;
      this.#cellItems[at] = i;
      cursor[cell] = at + 1;
    }
  }

  // ---- Vehicles ----

  #pickCar(): number {
    const u = this.#random.next();
    for (const [share, kind] of CAR_KINDS) if (u <= share) return kind;
    return KIND_SEDAN;
  }

  #launchVehicle(name: PathName, kind: number): Vehicle | undefined {
    const vehicle = this.#vehicles.find((v) => !v.alive);
    if (!vehicle) return undefined;
    const random = this.#random;
    vehicle.alive = true;
    vehicle.kind = kind;
    vehicle.path = name;
    vehicle.seed = random.next();
    vehicle.pace = (kind === KIND_BIKE ? BIKE_PACE : CAR_PACE) * random.range(0.88, 1.1);
    vehicle.brake = 0;
    vehicle.stopping = false;
    vehicle.sawAmber = false;
    vehicle.umbrella = kind === KIND_BIKE && this.#precip > 0.15 && random.next() < 0.6 ? 1 : 0;
    vehicle.delivery = false;
    vehicle.offset = 0;
    vehicle.pullOut = Number.NaN;
    vehicle.swerve = 0;
    return vehicle;
  }

  #placeVehicle(vehicle: Vehicle): void {
    const path = PATHS[vehicle.path];
    path.at(vehicle.s, this.#point);
    vehicle.x = this.#point[0] ?? 0;
    vehicle.z = this.#point[1] ?? 0;
    vehicle.heading = this.#point[2] ?? 0;
    const span = path.span(vehicle.s);
    vehicle.lane = span?.lane ?? -1;
    vehicle.laneC = span ? span.c0 + (vehicle.s - span.s0) : 0;
    vehicle.lastX = vehicle.x;
    vehicle.lastZ = vehicle.z;
    vehicle.lastHeading = vehicle.heading;
  }

  #stepVehicles(dt: number): void {
    const vehicles = this.#vehicles;
    const signals = this.#signals;
    // The delivery van and the cyclists in the kerb lane. Nearing its stop, easing in, it and they
    // keep in one file (neither passes the other), so it never eases in over one. Standing in at
    // the kerb, and pulling out, it is over their lane (kerbVan) and they swing out round it;
    // pulling out it is in their way too, and they keep behind it.
    const delivery = this.#van;
    const van =
      delivery !== undefined && delivery.alive && delivery.delivery ? delivery : undefined;
    const nearing =
      van !== undefined &&
      Number.isNaN(van.pullOut) &&
      van.offset < VAN_IN &&
      van.laneC > DELIVERY_X + AVENUE_END - DELIVERY_APPROACH;
    const pullingOut = van !== undefined && !Number.isNaN(van.pullOut) && van.offset > VAN_OVER;
    const kerbVan =
      van !== undefined && (pullingOut || (Number.isNaN(van.pullOut) && van.offset >= VAN_IN))
        ? van
        : undefined;
    for (const me of vehicles) {
      if (!me.alive) continue;
      // The delivery van stands at the kerb while its driver is out, then until it can pull out.
      if (me.delivery && this.#vanHolds(me)) {
        me.v = 0;
        me.brake = 0;
        continue;
      }
      const path = PATHS[me.path];
      const shape = SHAPES[me.kind] ?? SHAPES[KIND_SEDAN];
      const length = shape?.length ?? 4.5;
      const width = shape?.width ?? 1.7;
      const bike = me.kind === KIND_BIKE;
      const front = me.s + length / 2;
      let gap = Number.POSITIVE_INFINITY;
      let lead = 0;

      // The stop line, while the light says stop.
      const light = path.signal === "avenue" ? signals.avenue() : signals.side();
      const toLine = path.stop - front;
      if (toLine > -0.5) {
        if (light === "amber" && !me.sawAmber) {
          me.sawAmber = true;
          me.stopping = toLine > (me.v * me.v) / (2 * IDM_B) + 1;
        }
        if (light !== "amber") me.sawAmber = false;
        if (light === "red" || (light === "amber" && me.stopping)) {
          if (toLine < gap) {
            gap = Math.max(toLine, 0);
            lead = 0;
          }
        }
      }

      // The delivery van's stop at the kerb: a standing obstacle the standstill gap beyond it.
      if (me.delivery && this.#errand.stage === "arriving") {
        const toStop = DELIVERY_X + AVENUE_END + IDM_S0 - me.s;
        if (toStop < gap) {
          gap = Math.max(toStop, 0);
          lead = 0;
        }
      }
      // A cyclist in the kerb lane waits behind the parked van while a car comes up the next lane.
      if (bike && kerbVan && me.lane === L_EB_BIKE && me.swerve === 0) {
        const toSwerve =
          kerbVan.laneC -
          (SHAPES[KIND_VAN]?.length ?? 4.7) / 2 -
          SWERVE_RAMP -
          front -
          (me.laneC - me.s);
        if (toSwerve > -0.5 && toSwerve < 12) {
          let busy = false;
          for (const other of vehicles) {
            if (
              other.alive &&
              other.kind !== KIND_BIKE &&
              other.lane === L_EB_OUT &&
              other.laneC > me.laneC - SWERVE_WAIT &&
              other.laneC < me.laneC + 3
            )
              busy = true;
          }
          if (busy && toSwerve < gap) {
            gap = Math.max(toSwerve, 0);
            lead = 0;
          }
        }
      }

      // Vehicles ahead along the lanes this path runs on; one turning off it, by where it is; and
      // while turning, across other lanes, anyone going along them whose body is on the way (a left
      // turn yields to the bicycles going straight on along the kerb).
      const hx = Math.cos(me.heading);
      const hz = Math.sin(me.heading);
      const turning =
        (me.lane >= L_ARC_EBL && me.lane <= L_ARC_SBB) ||
        (me.s < path.turnAt && path.turnAt - front < YIELD_LOOK);
      if (turning) {
        for (let k = 0; k < WAY_POINTS; k++) {
          path.at(front + 0.5 + k * YIELD_STEP, this.#point2);
          this.#wayX[k] = this.#point2[0] ?? 0;
          this.#wayZ[k] = this.#point2[1] ?? 0;
        }
      }
      const aheadAt = this.#aheadAt;
      const aheadLength = this.#aheadLength;
      const aheadSpeed = this.#aheadSpeed;
      let seen = 0;
      for (const other of vehicles) {
        if (other === me || !other.alive) continue;
        const otherShape = SHAPES[other.kind];
        const otherLength = otherShape?.length ?? 4.5;
        const otherWidth = otherShape?.width ?? 1.7;
        let at = path.locate(other.lane, other.laneC);
        // Round the parked delivery van a cyclist rides in the outer lane for a while.
        if (Number.isNaN(at) && other.swerve > 0.35) at = path.locate(L_EB_OUT, other.laneC);
        if (Number.isNaN(at) && me.swerve > 0.35 && other.lane === L_EB_OUT)
          at = me.s + other.laneC - me.laneC;
        // The delivery van nearing its stop or pulling out: a cyclist in the kerb lane keeps behind
        // it, and nearing it the van keeps behind the cyclists in that lane.
        if (Number.isNaN(at) && other === van && (nearing || pullingOut) && me.lane === L_EB_BIKE)
          at = me.s + other.laneC - me.laneC;
        if (Number.isNaN(at) && me === van && nearing && other.lane === L_EB_BIKE)
          at = me.s + other.laneC - me.laneC;
        const onArc = other.lane >= L_ARC_EBL && other.lane <= L_ARC_SBB;
        if (Number.isNaN(at) && onArc) {
          const along = (other.x - me.x) * hx + (other.z - me.z) * hz;
          const across = Math.abs((other.z - me.z) * hx - (other.x - me.x) * hz);
          if (along > 0 && across < (width + otherWidth) / 2 + 0.3) at = me.s + along;
        }
        if (Number.isNaN(at) && turning && !onArc)
          at = this.#onTheWay(front, width, other, otherLength, otherWidth);
        if (Number.isNaN(at) || at <= me.s || at - me.s > LOOKAHEAD) continue;
        aheadAt[seen] = at;
        aheadLength[seen] = otherLength;
        aheadSpeed[seen] = other.v;
        seen++;
        const g = at - me.s - (length + otherLength) / 2;
        if (g < gap) {
          gap = g;
          lead = other.v;
        }
      }

      // Anyone still on the street in front.
      let walkerAt = Number.POSITIVE_INFINITY;
      for (const w of this.#walkers) {
        if (!w.alive || !w.onRoad) continue;
        if (Math.hypot(w.x - me.x, w.z - me.z) > YIELD_LOOK + length) continue;
        for (let ds = 0.5; ds <= YIELD_LOOK; ds += YIELD_STEP) {
          path.at(front + ds, this.#point2);
          if (
            Math.hypot(w.x - (this.#point2[0] ?? 0), w.z - (this.#point2[1] ?? 0)) <
            width / 2 + 0.8
          ) {
            walkerAt = Math.min(walkerAt, front + ds - 0.5);
            if (ds - 0.5 < gap) {
              gap = ds - 0.5;
              lead = 0;
            }
            break;
          }
        }
      }

      // Don't block the box: short of the stop line, wait at it unless the way out has room.
      const s0 = bike ? IDM_S0_BIKE : IDM_S0;
      if (toLine > -0.5 && toLine < gap) {
        let jam = walkerAt;
        for (let k = 0; k < seen; k++) {
          if ((aheadSpeed[k] ?? 0) < BOX_SLOW)
            jam = Math.min(jam, (aheadAt[k] ?? 0) - (aheadLength[k] ?? 0) / 2);
        }
        let room = jam - path.exit - length - s0;
        for (let k = 0; k < seen; k++) {
          const tail = (aheadAt[k] ?? 0) - (aheadLength[k] ?? 0) / 2;
          if ((aheadSpeed[k] ?? 0) >= BOX_SLOW && tail < jam) room -= (aheadLength[k] ?? 0) + s0;
        }
        if (room < 0) {
          gap = Math.max(toLine, 0);
          lead = 0;
        }
      }

      // The intelligent driver model, with the bend ahead as a speed limit.
      const v = me.v;
      const ahead = clamp(Math.round((front + v * 1.5) / PATH_STEP), 0, path.vmax.length - 1);
      const limit = Math.min(me.pace, path.vmax[ahead] ?? me.pace);
      let acc = IDM_A * (1 - Math.pow(v / Math.max(limit, 0.5), 4));
      if (Number.isFinite(gap)) {
        const sStar =
          s0 + Math.max(0, v * IDM_T + (v * (v - lead)) / (2 * Math.sqrt(IDM_A * IDM_B)));
        acc -= IDM_A * Math.pow(sStar / Math.max(gap, 0.05), 2);
      }
      acc = Math.max(acc, -IDM_HARD);
      me.v = Math.max(0, v + acc * dt);
      me.s += me.v * dt;
      // The van comes to rest at its stop.
      if (
        me.delivery &&
        this.#errand.stage === "arriving" &&
        Math.abs(DELIVERY_X + AVENUE_END - me.s) < 0.6 &&
        me.v < 0.4
      )
        me.v = 0;
      me.brake = clamp(
        me.brake +
          ((acc < -0.35 || (me.v < 0.3 && gap < 12) ? 1 : 0) - me.brake) * Math.min(1, dt / 0.15),
        0,
        1,
      );
      if (me.s > path.length - 1) {
        me.alive = false;
        continue;
      }
      path.at(me.s, this.#point);
      me.x = this.#point[0] ?? me.x;
      me.z = this.#point[1] ?? me.z;
      me.heading = this.#point[2] ?? me.heading;
      const span = path.span(me.s);
      me.lane = span?.lane ?? -1;
      me.laneC = span ? span.c0 + (me.s - span.s0) : 0;
      if (me.delivery) this.#pullOver(me);
      if (bike) {
        me.umbrella = clamp(
          me.umbrella + (this.#precip > 0.15 && me.seed < 0.6 ? dt : -dt) / UMBRELLA_OPEN,
          0,
          1,
        );
        this.#swerve(me, kerbVan, dt);
      }
    }
  }

  /** Whether another vehicle's body, or the road ahead of it along its own path that it covers in
   *  the next SWEEP seconds at its speed, lies on the way ahead of a front at path distance `front`
   *  (the WAY_POINTS points of #wayX, #wayZ, YIELD_STEP apart from 0.5 m on; each side within its
   *  half width and ours): the path distance to take as its centre, so the gap to it is the way to
   *  where it comes; NaN if the way is clear. */
  #onTheWay(
    front: number,
    width: number,
    other: Vehicle,
    otherLength: number,
    otherWidth: number,
  ): number {
    const wayX = this.#wayX;
    const wayZ = this.#wayZ;
    const half = otherLength / 2;
    const sweep = Math.min(other.v * SWEEP, (SWEEP_POINTS - 1) * SWEEP_STEP);
    const reach = (width + otherWidth) / 2 + 0.2;
    // The way runs within half its length of its middle point.
    const mid = WAY_POINTS >> 1;
    const far = Math.hypot(other.x - (wayX[mid] ?? 0), other.z - (wayZ[mid] ?? 0));
    if (far > YIELD_LOOK / 2 + YIELD_STEP + half + sweep + reach) return Number.NaN;
    const sweepX = this.#sweepX;
    const sweepZ = this.#sweepZ;
    const otherPath = PATHS[other.path];
    let swept = 0;
    for (let k = 0.5; k <= sweep; k += SWEEP_STEP) {
      otherPath.at(other.s + half + k, this.#point);
      sweepX[swept] = this.#point[0] ?? 0;
      sweepZ[swept] = this.#point[1] ?? 0;
      swept++;
    }
    const hx = Math.cos(other.heading);
    const hz = Math.sin(other.heading);
    for (let w = 0; w < WAY_POINTS; w++) {
      const mx = wayX[w] ?? 0;
      const mz = wayZ[w] ?? 0;
      const at = front + 0.5 + w * YIELD_STEP + half;
      // Its body where it stands...
      const px = mx - other.x;
      const pz = mz - other.z;
      const along = clamp(px * hx + pz * hz, -half, half);
      if (Math.hypot(px - hx * along, pz - hz * along) < reach) return at;
      // ...and the road it comes to.
      for (let k = 0; k < swept; k++)
        if (Math.hypot(mx - (sweepX[k] ?? 0), mz - (sweepZ[k] ?? 0)) < reach) return at;
    }
    return Number.NaN;
  }

  /** Whether the delivery van stands at the kerb this step: while its driver is out, and afterwards,
   *  blinker on, until its lane and the kerb lane it stands over are clear behind and ahead (then
   *  it notes where it set off). */
  #vanHolds(van: Vehicle): boolean {
    const stage = this.#errand.stage;
    if (stage === "arriving") return false;
    if (stage === "unloading") return true;
    if (!Number.isNaN(van.pullOut) || van.lane !== L_KERB) return false;
    for (const other of this.#vehicles) {
      if (other === van || !other.alive) continue;
      if (
        (other.lane === L_EB_OUT || other.lane === L_EB_BIKE) &&
        other.laneC > van.laneC - CLEAR_BEHIND &&
        other.laneC < van.laneC + CLEAR_AHEAD
      )
        return true;
      if (other.swerve > 0 && Math.abs(other.laneC - van.laneC) < 8) return true;
    }
    van.pullOut = van.s;
    return false;
  }

  /** How far the delivery van is off its lane toward the kerb at path distance s: easing in over the
   *  last PULL_IN metres to its stop, and out over the first PULL_OUT metres once it sets off. */
  #vanOffset(van: Vehicle, s: number): number {
    const pull = DELIVERY_Z - LANE_EB_OUT;
    const stop = DELIVERY_X + AVENUE_END;
    if (Number.isNaN(van.pullOut)) return pull * smoothstep(stop - PULL_IN, stop - 0.3, s);
    return pull * (1 - smoothstep(van.pullOut, van.pullOut + PULL_OUT, s));
  }

  /** Move the van off its lane by its offset (to its left, the kerb), turned along the way it is
   *  going; standing over the kerb lane it is in a lane of its own, which nobody queues behind. */
  #pullOver(van: Vehicle): void {
    van.offset = this.#vanOffset(van, van.s);
    const slope = (this.#vanOffset(van, van.s + 0.5) - van.offset) / 0.5;
    van.x -= Math.sin(van.heading) * van.offset;
    van.z += Math.cos(van.heading) * van.offset;
    van.heading += Math.atan(slope);
    if (Number.isNaN(van.pullOut) && van.offset > 1.0) van.lane = L_KERB;
  }

  /** A cyclist in the kerb lane swings out (to its right) round the delivery van over it, and eases
   *  back in once past; if the van leaves first it eases back where it is. Past the van's middle it
   *  only eases back in: it never swings out ahead of a van coming in behind it. */
  #swerve(bike: Vehicle, kerbVan: Vehicle | undefined, dt: number): void {
    const round = bike.lane === L_EB_BIKE ? kerbVan : undefined;
    const past = round !== undefined && bike.laneC > round.laneC;
    let target = round ? swerveRound(round, bike.laneC) : 0;
    if (past) target = Math.min(target, bike.swerve);
    bike.swerve = target >= bike.swerve ? target : Math.max(target, bike.swerve - dt);
    if (bike.swerve <= 0) return;
    const next = round ? swerveRound(round, bike.laneC + 0.5) : target;
    const turn = past ? Math.min(next - target, 0) : next - target;
    bike.z -= BIKE_SWERVE * bike.swerve;
    bike.heading -= Math.atan((BIKE_SWERVE * turn) / 0.5);
  }

  // ---- The crowd's walk-in ----

  /** Walker `index` as drawn `enter` (0..1) of the way into the entrance: it walks in from a few metres
   *  along its sidewalk (away from the middle of the window's view; down the side street it comes down
   *  it), each at its own time and pace, and turns to its own heading as it arrives, its legs
   *  swinging with the distance. Written to #arrived (x, z, heading, gait). */
  #arrive(
    index: number,
    walker: Walker,
    enter: number,
    x: number,
    z: number,
    heading: number,
    gait: number,
  ): void {
    // A pair keeps together: it takes the earlier partner's times.
    let key = index;
    if (walker.partner) {
      const at = this.#walkers.indexOf(walker.partner);
      if (at >= 0 && at < key) key = at;
    }
    const end = ARRIVE_END_MIN + (ARRIVE_END_MAX - ARRIVE_END_MIN) * hash01(key, 2);
    const pace = ARRIVE_PACE_MIN + (ARRIVE_PACE_MAX - ARRIVE_PACE_MIN) * hash01(key, 3);
    const done = clamp(enter / end, 0, 1);
    const left = pace * end * STREET_PASSAGE.enter * (1 - done);
    const sideStreet = z > FACADE_FAR && Math.abs(x) < SIDE_FACADE;
    const dx = sideStreet ? 0 : x < CAM_X ? -1 : 1;
    const dz = sideStreet ? 1 : 0;
    const walking = Math.atan2(-dz, -dx);
    const turn = smoothstep(0, 1, (done - (1 - ARRIVE_TURN)) / ARRIVE_TURN);
    const arrived = this.#arrived;
    arrived[0] = x + dx * left;
    arrived[1] = z + dz * left;
    arrived[2] = walking + angleDiff(heading, walking) * turn;
    arrived[3] = (gait + left / STRIDE) % 1;
  }

  // ---- Upload ----

  #upload(alpha: number): void {
    const data = this.#agentData;
    const walkers = this.#walkers;
    const vehicles = this.#vehicles;
    const row1 = MAX_AGENTS * 4;
    data.fill(0);
    const order = this.#order;
    const key = this.#orderKey;
    let n = 0;
    const arriving = this.#enter < 1;
    for (let i = 0; i < MAX_WALKERS; i++) {
      const w = walkers[i];
      if (!w?.alive) continue;
      let x = w.lastX + (w.x - w.lastX) * alpha;
      let z = w.lastZ + (w.z - w.lastZ) * alpha;
      let heading = w.lastHeading + angleDiff(w.heading, w.lastHeading) * alpha;
      let gait = w.gait;
      if (arriving && !w.onRoad && w.mode !== "cross") {
        this.#arrive(i, w, this.#enter, x, z, heading, gait);
        x = this.#arrived[0] ?? x;
        z = this.#arrived[1] ?? z;
        heading = this.#arrived[2] ?? heading;
        gait = this.#arrived[3] ?? gait;
      }
      const o = i * 4;
      data[o] = x;
      data[o + 1] = z - Z_REF;
      data[o + 2] = heading;
      data[o + 3] = w.child ? KIND_CHILD : w.porter ? KIND_PORTER : KIND_ADULT;
      data[row1 + o] = w.umbrella;
      data[row1 + o + 1] = w.porter ? this.#errand.load : w.look;
      data[row1 + o + 2] = gait;
      data[row1 + o + 3] = w.seed;
      order[n] = i;
      key[n] = Math.hypot(x - CAM_X, z);
      n++;
    }
    for (let k = 0; k < MAX_VEHICLES; k++) {
      const v = vehicles[k];
      if (!v?.alive) continue;
      const i = MAX_WALKERS + k;
      const x = v.lastX + (v.x - v.lastX) * alpha;
      const z = v.lastZ + (v.z - v.lastZ) * alpha;
      const o = i * 4;
      data[o] = x;
      data[o + 1] = z - Z_REF;
      data[o + 2] = v.lastHeading + angleDiff(v.heading, v.lastHeading) * alpha;
      data[o + 3] = v.kind;
      if (v.kind === KIND_BIKE) {
        data[row1 + o] = v.umbrella;
        data[row1 + o + 1] = 0;
        data[row1 + o + 2] = (v.s / 2.1) % 1;
      } else {
        const path = PATHS[v.path];
        const front = v.s + (SHAPES[v.kind]?.length ?? 4.5) / 2;
        const turning = front > path.turnAt - BLINK_AHEAD && v.s < path.turnAt + 8;
        data[row1 + o] = v.brake;
        data[row1 + o + 1] = v.delivery ? this.#vanBlinker(v) : turning ? path.turnSide : 0;
        data[row1 + o + 2] = v.v;
      }
      data[row1 + o + 3] = v.seed;
      order[n] = i;
      key[n] = Math.hypot(x - CAM_X, z);
      n++;
    }
    this.#agents.upload(data);

    // Nearest the window first, so a full tile keeps the nearest.
    for (let a = 1; a < n; a++) {
      const id = order[a] ?? 0;
      const k = key[a] ?? 0;
      let b = a - 1;
      while (b >= 0 && (key[b] ?? 0) > k) {
        order[b + 1] = order[b] ?? 0;
        key[b + 1] = key[b] ?? 0;
        b--;
      }
      order[b + 1] = id;
      key[b + 1] = k;
    }
    this.#tileData.fill(0);
    this.#bodyCount.fill(0);
    this.#lightCount.fill(0);
    for (let a = 0; a < n; a++) {
      const id = order[a] ?? 0;
      const o = id * 4;
      const x = data[o] ?? 0;
      const z = (data[o + 1] ?? 0) + Z_REF;
      const heading = data[o + 2] ?? 0;
      const kind = data[o + 3] ?? 0;
      if (kind === KIND_ADULT || kind === KIND_CHILD || kind === KIND_PORTER) {
        // A porter's hand truck reaches a metre before its feet.
        const reach = kind === KIND_PORTER ? PORTER_TRUCK_REACH : WALKER_REACH;
        this.#binProjected(id, x, z, WALKER_TOP, reach, reach, 0);
      } else {
        const shape = SHAPES[kind];
        if (!shape) continue;
        const bike = kind === KIND_BIKE;
        // A taxi's roof sign, a cyclist's umbrella.
        const top = shape.top + (kind === KIND_TAXI ? 0.25 : 0) + (bike ? 0.45 : 0);
        this.#binProjected(
          id,
          x,
          z,
          top,
          shape.length / 2 + 0.15,
          bike ? WALKER_REACH : shape.width / 2 + 0.15,
          heading,
        );
        this.#binLights(id, x, z, heading, shape, bike);
      }
    }
    this.#tiles.upload(this.#tileData);

    // The signals' lamps.
    const state = this.#stateData;
    const lamps = this.#signals.lamps;
    state.fill(0);
    state[0] = lamps[0] ?? 0;
    state[1] = lamps[1] ?? 0;
    state[2] = lamps[2] ?? 0;
    state[4] = lamps[3] ?? 0;
    state[5] = lamps[4] ?? 0;
    state[6] = lamps[5] ?? 0;
    state[8] = lamps[6] ?? 0;
    state[9] = lamps[7] ?? 0;
    this.#state.upload(state);
  }

  /** Bin an agent's body: a box (half extents along and across its heading) standing `top` high,
   *  over the ground it covers seen from the window (from its footprint to where the rays past its
   *  top land). */
  #binProjected(
    id: number,
    x: number,
    z: number,
    top: number,
    halfLong: number,
    halfWide: number,
    heading: number,
  ): void {
    const k = CAM_H / (CAM_H - top);
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    this.#box.set(EMPTY_BOX);
    for (let corner = 0; corner < 4; corner++) {
      const u = corner & 1 ? halfLong : -halfLong;
      const v = corner & 2 ? halfWide : -halfWide;
      const px = x + c * u - s * v;
      const pz = z + s * u + c * v;
      this.#extend(px, pz, 0);
      this.#extend(CAM_X + (px - CAM_X) * k, pz * k, 0);
    }
    this.#binBox(id, false);
  }

  /** Bin a vehicle's lamps: the beam ahead, the glow behind, and their reflections toward the window. */
  #binLights(
    id: number,
    x: number,
    z: number,
    heading: number,
    shape: VehicleShape,
    bike: boolean,
  ): void {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const half = shape.length / 2;
    const reach = bike ? BIKE_BEAM_REACH : BEAM_REACH;
    const side = shape.width / 2 + 0.5;
    const spread = shape.width / 2 + reach * 0.42;
    const fx = x + c * half;
    const fz = z + s * half;
    const bx = x - c * half;
    const bz = z - s * half;
    const rx = x - c * (half + TAIL_REACH);
    const rz = z - s * (half + TAIL_REACH);
    this.#box.set(EMPTY_BOX);
    this.#extend(fx - s * side, fz + c * side, 0);
    this.#extend(fx + s * side, fz - c * side, 0);
    this.#extend(fx + c * reach - s * spread, fz + s * reach + c * spread, 0);
    this.#extend(fx + c * reach + s * spread, fz + s * reach - c * spread, 0);
    this.#extend(rx - s * 2, rz + c * 2, 0);
    this.#extend(rx + s * 2, rz - c * 2, 0);
    // Reflections run from under each lamp toward the window.
    const df = Math.hypot(CAM_X - fx, fz) || 1;
    this.#extend(fx + ((CAM_X - fx) / df) * STREAK_REACH, fz - (fz / df) * STREAK_REACH, 1);
    const db = Math.hypot(CAM_X - bx, bz) || 1;
    this.#extend(bx + ((CAM_X - bx) / db) * STREAK_REACH, bz - (bz / db) * STREAK_REACH, 1);
    this.#binBox(id, true);
  }

  /** Grow #box (x0, x1, z0, z1) to hold a point and a margin round it. */
  #extend(x: number, z: number, pad: number): void {
    const box = this.#box;
    box[0] = Math.min(box[0] ?? x, x - pad);
    box[1] = Math.max(box[1] ?? x, x + pad);
    box[2] = Math.min(box[2] ?? z, z - pad);
    box[3] = Math.max(box[3] ?? z, z + pad);
  }

  /** List agent `id` in every tile under #box, among the bodies or the lights. */
  #binBox(id: number, light: boolean): void {
    const box = this.#box;
    const tx0 = Math.max(0, Math.floor(((box[0] ?? 0) - TILE_X0) / TILE));
    const tx1 = Math.min(TILES_X - 1, Math.floor(((box[1] ?? 0) - TILE_X0) / TILE));
    const tz0 = Math.max(0, Math.floor(((box[2] ?? 0) - TILE_Z0) / TILE));
    const tz1 = Math.min(TILES_Z - 1, Math.floor(((box[3] ?? 0) - TILE_Z0) / TILE));
    const counts = light ? this.#lightCount : this.#bodyCount;
    const cap = light ? TILE_LIGHTS : TILE_BODIES;
    const first = light ? TILE_BODIES : 0;
    const tiles = this.#tileData;
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = tz * TILES_X + tx;
        const count = counts[tile] ?? 0;
        if (count >= cap) continue;
        const slot = first + count;
        tiles[(tile * TILE_TEXELS + (slot >> 2)) * 4 + (slot & 3)] = id + 1;
        counts[tile] = count + 1;
      }
    }
  }
}

/** An empty bounding box (x0, x1, z0, z1) to grow. */
const EMPTY_BOX = [
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
] as const;

/** How far a cyclist at lane position c in the kerb lane has swung out round the delivery van
 *  parked over it: 0 clear of it, 1 alongside, easing over SWERVE_RAMP metres before and after. */
function swerveRound(van: Vehicle, c: number): number {
  const half = (SHAPES[KIND_VAN]?.length ?? 4.7) / 2;
  return (
    smoothstep(van.laneC - half - SWERVE_RAMP, van.laneC - half - 0.5, c) *
    (1 - smoothstep(van.laneC + half + 0.5, van.laneC + half + SWERVE_RAMP, c))
  );
}

/** Clamp a point (x, z in p[0], p[1]) into a region's walkable sidewalk: the near sidewalk, or a far
 *  corner's L (along the avenue, up the side street, the corner's kerb rounded; doors let walkers
 *  through the facades, and `door` (x) lets one more through: the konbini's service door, for the
 *  delivery's driver only). `kerb`: the margin kept from the kerbs (m; the walls keep WALL). */
function clampRegion(region: Region, p: Float64Array, door = Number.NaN, kerb = WALL): void {
  let x = p[0] ?? 0;
  let z = p[1] ?? 0;
  if (region === "near") {
    p[1] = clamp(z, FACADE_NEAR - 1.6, KERB_NEAR - kerb);
    return;
  }
  const sign = region === "fl" ? -1 : 1;
  let u = sign * x;
  const inner = SIDE_KERB + kerb;
  const outer = SIDE_FACADE - WALL;
  const front = KERB_FAR + kerb;
  const doorway =
    Math.abs(x - CAFE_DOOR) < 0.9 || Math.abs(x - KONBINI_DOOR) < 0.9 || Math.abs(x - door) < 0.9;
  const back = doorway ? FACADE_FAR + 1.5 : FACADE_FAR - WALL;
  if (u < inner) u = inner;
  if (z < front) z = front;
  if (z > back && u > outer) {
    if (z - back < u - outer) z = back;
    else u = outer;
  }
  const cu = SIDE_KERB + CORNER_RADIUS;
  const cz = KERB_FAR + CORNER_RADIUS;
  if (u < cu && z < cz) {
    const du = u - cu;
    const dz = z - cz;
    const d = Math.hypot(du, dz);
    const lim = CORNER_RADIUS - kerb;
    if (d > lim) {
      u = cu + (du * lim) / d;
      z = cz + (dz * lim) / d;
    }
  }
  x = sign * u;
  p[0] = x;
  p[1] = z;
}

/** The sidewalk a point is on (the near one, or a far corner's), going by which side of the avenue's
 *  middle and of the side street's it lies. */
function regionAt(x: number, z: number): Region {
  if (z < AVENUE_MID) return "near";
  return x < 0 ? "fl" : "fr";
}

/** Whether the way from (x, z) to (tx, tz) along a far corner's L cuts through the building at its
 *  inside corner, where the side street's facade meets the avenue's: then the point CORNER_CUT in
 *  from that corner, to steer at instead, goes into p[0], p[1]. */
function roundCorner(
  region: Region,
  x: number,
  z: number,
  tx: number,
  tz: number,
  p: Float64Array,
): boolean {
  if (region === "near") return false;
  const sign = region === "fl" ? -1 : 1;
  const u0 = sign * x;
  const u1 = sign * tx;
  const outer = SIDE_FACADE - WALL;
  const back = FACADE_FAR - WALL;
  // One end up the side street, the other along the avenue, and the way past the facade's line
  // behind the corner.
  if (u0 <= outer === u1 <= outer) return false;
  if (z + ((tz - z) * (outer - u0)) / (u1 - u0) <= back) return false;
  p[0] = sign * (outer - CORNER_CUT);
  p[1] = back - CORNER_CUT;
  return true;
}

/** Whether a point on the road is in the junction: the avenue between the stop lines, or the side
 *  street's mouth up to its stop line. */
function inJunction(x: number, z: number): boolean {
  if (Math.abs(x) < STOP_WB && z > KERB_NEAR && z < KERB_FAR) return true;
  return Math.abs(x) < SIDE_KERB && z >= KERB_FAR && z < STOP_SB;
}

/** The way from (x, z) toward the middle of its sidewalk (a unit vector into p[0], p[1]; 0, 0 on the
 *  middle): across the near sidewalk, or toward the L running along the middle of a far corner's
 *  (along the avenue, and up the side street). Away from the kerb, or from a wall. */
function towardMiddle(x: number, z: number, p: Float64Array): void {
  let dx = 0;
  let dz = 0;
  if (z < AVENUE_MID) {
    dz = (FACADE_NEAR + KERB_NEAR) / 2 - z;
  } else {
    const sign = x < 0 ? -1 : 1;
    const u = sign * x;
    const midU = (SIDE_KERB + SIDE_FACADE) / 2;
    const midZ = (KERB_FAR + FACADE_FAR) / 2;
    // The nearer of the L's two arms: along the avenue (z = midZ, u ≥ midU), up the side street
    // (u = midU, z ≥ midZ).
    const alongU = Math.max(u, midU) - u;
    const alongZ = midZ - z;
    const upU = midU - u;
    const upZ = Math.max(z, midZ) - z;
    const along = Math.hypot(alongU, alongZ) <= Math.hypot(upU, upZ);
    dx = sign * (along ? alongU : upU);
    dz = along ? alongZ : upZ;
  }
  const d = Math.hypot(dx, dz);
  p[0] = d > 1e-9 ? dx / d : 0;
  p[1] = d > 1e-9 ? dz / d : 0;
}

/** The crossing's simulation for a scene whose knobs are `params` (looked up by key). */
export function streetSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new StreetCrossing(gl, params);
}
