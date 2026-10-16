// The mystic forest's simulation: what lives in it.
// - Spirits (kodama): a small population. Each appears on a perch (the mossy boulders, the fallen
//   log, the beech's branch, the torii's top beam, a stepping stone, the floor between the trunks),
//   rising out of the moss as it materialises; sits a while, breathing, its head now and then
//   turning in a few quick rattling ticks; when the pointer comes near, a curious one looks toward
//   it and a shy one (the shyness knob's share) ducks into the moss looking away until it has gone;
//   then dissolves. Far more at dusk and night than by day, and often a companion follows.
// - The stag: now and then it walks across the far forest, stops once (often framed by the torii)
//   to raise its head and look toward you, and walks on; small lights bloom where it has stepped.
// - Spores and motes on a gentle curl-noise wind (divergence-free, so they swirl and never bunch),
//   stirred by the pointer; puffs from the mushrooms, from a click and from the M.
// - The mist: a coarse field of banks advected by the same wind and relaxing toward slowly drifting
//   banks, so the pointer leaves swirls in it that heal.
// The shader (shader.ts) reads three textures (rows bottom to top):
//   uSim0  rgba16f, 3 x (FOREST_SPIRITS + 1), nearest: one row per spirit, (screen x, screen y of its
//          feet, depth m, alpha 0..1), (head tilt rad + = its top to the left, yaw -1..1 + = its face
//          to the right, glow, variant 0..1), (sink: 0..1 while rising out of the moss, up to
//          DUCK_SINK ducked away from the pointer, in 0.45 of its height; height m, 0, 0); all 0 for
//          a free slot. The last row is the stag: (x m, gait phase 0..1, heading +-1,
//          alpha), (look 0..1, head up 0..1, x where it set out m, distance walked m), (standing 0..1:
//          1 - its speed / its walking pace, 0, 0, 0).
//   uSim1  rgba16f, (2 x bins) x FOREST_MOTE_ROWS, nearest: the motes, binned on square bins
//          FOREST_MOTE_ROWS to the screen height starting at the left edge, two slots (texels) per
//          bin: (x, y within the bin 0..1, depth m, glow 0..1); glow 0 marks an empty slot.
//   uSim2  r16f, FOREST_FOG.width x FOREST_FOG.height over the screen's uv, linear: how thick the
//          mist is here, about 1.
import type { ParamDef } from "../../params.ts";
import { clamp, hash31, smoothstep } from "../../sims/math.ts";
import { valueNoise } from "../../sims/noise.ts";
import { mulberry32 } from "../../sims/random.ts";
import { atEase, facing, isShy, stepShrink, type Shrink } from "../../sims/temperament.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- the forest's layout, shared with shader.ts ----

/**
 * Side-on camera: the horizon's screen height and the eye's height (m). A point at depth z and
 * height y (metres) lands at screen y = FOREST_HORIZON + (y - FOREST_EYE) / z, and at screen x =
 * (world x) / z, in screen heights from the centre.
 */
export const FOREST_HORIZON = 0.36;
export const FOREST_EYE = 1.15;
/** Frames narrower than this are laid out as if this wide: the features anchored to the edges are cropped rather than crowded into the middle. */
export const FOREST_MIN_ASPECT = 1.3;

export function forestLayoutAspect(aspect: number): number {
  return Math.max(aspect, FOREST_MIN_ASPECT);
}

/** Screen y of a point `height` metres up at depth z (m). */
export function forestScreenY(height: number, z: number): number {
  return FOREST_HORIZON + (height - FOREST_EYE) / z;
}

/** The stream: its centre line x = centre - swing sin((z - from) rate) (m) and half-width half + widen z (m). */
export const FOREST_STREAM = {
  centre: 0.6,
  swing: 1.5,
  rate: 0.2,
  from: 3,
  half: 0.6,
  widen: 0.012,
} as const;

export function forestStreamX(z: number): number {
  return (
    FOREST_STREAM.centre -
    FOREST_STREAM.swing * Math.sin((z - FOREST_STREAM.from) * FOREST_STREAM.rate)
  );
}

export function forestStreamHalf(z: number): number {
  return FOREST_STREAM.half + FOREST_STREAM.widen * z;
}

/**
 * The great cedar on the left, its axis `edge` screen heights in from the left edge so the whole bole
 * shows: its radius (m), how much wider its buttressed foot is (a share), over how many metres up that
 * flare fades, and its lean (m across per m up).
 */
export const FOREST_HERO = {
  edge: 0.33,
  z: 3.8,
  radius: 0.95,
  flare: 0.8,
  flareHeight: 0.7,
  lean: 0.04,
} as const;
/** The old beech on the right, its axis `edge` in from the right edge; it puts out the branch. */
export const FOREST_ELDER = {
  edge: 0.17,
  z: 7,
  radius: 0.85,
  flare: 0.8,
  flareHeight: 0.6,
  lean: -0.02,
} as const;
/**
 * The beech's branch, in metres at its depth: it leaves the trunk `root` radii left of the axis at
 * `height`; along s = 0..1 of its `length` its centre line rises by rise s - sag s^2 and its radius
 * narrows from `radius` to `tip`.
 */
export const FOREST_BRANCH = {
  height: 3.05,
  length: 3.3,
  rise: 0.75,
  sag: 0.45,
  radius: 0.17,
  tip: 0.07,
  root: 0.55,
} as const;
/** Moss beards hang from the branch in lanes this far apart (m); the drips fall from their tips. */
export const FOREST_BEARD_SPACING = 0.2;
/** Mossy boulders: centre `edge` screen heights in from the left / right edge, depth, radii across and up (m), centre height (m). */
export const FOREST_ROCK_LEFT = { edge: 0.62, z: 3, rx: 0.62, ry: 0.5, centre: 0.1 } as const;
export const FOREST_ROCK_RIGHT = { edge: 0.31, z: 4.4, rx: 0.6, ry: 0.44, centre: -0.02 } as const;
/** The fallen log, lying across from world x `from` to `to` (m) at depth z, its radius (m). */
export const FOREST_LOG = { from: 0.95, to: 5.8, z: 8.5, radius: 0.34 } as const;
/**
 * The torii over the stream, centred on it: pillars `span` m either side, the top beam from `height`
 * up `beam` m, overhanging the pillars by `overhang`; leaning `lean` rad to the left about its right
 * foot, the left foot sunk in a mound of moss.
 */
export const FOREST_TORII = {
  z: 13,
  span: 1.55,
  height: 3.05,
  beam: 0.25,
  overhang: 0.75,
  lean: 0.05,
} as const;
/** A cluster of mushrooms on the moss mound swallowing the torii's left foot, in the torii's own frame (m). */
export const FOREST_GATE_SHROOMS = { x: -1.15, y: 0.42 } as const;
/** Stepping stones across the stream: depth, offset from the stream's centre, radius, height above the water (m). */
export const FOREST_STONES = [
  { z: 5.2, offset: -0.42, radius: 0.24, height: 0.14 },
  { z: 5.7, offset: 0.06, radius: 0.27, height: 0.17 },
  { z: 6.2, offset: 0.5, radius: 0.22, height: 0.13 },
] as const;
/** The Manifold M of roots on the near boulder's face: its centre `lift` x ry above the boulder's centre, its height `size` x ry; its top corners meet the root across the face. */
export const FOREST_MARK = { lift: 0.36, size: 0.58 } as const;
/** The stag's path: its depth (m), and how far apart the lights it leaves behind bloom (m). */
export const FOREST_STAG = { z: 18, stride: 0.7 } as const;
/** Spirit slots: rows of uSim0 before the stag's. */
export const FOREST_SPIRITS = 12;
/** Mote bins: this many to the screen height, square. */
export const FOREST_MOTE_ROWS = 30;
/** The mist field's grid over the screen. */
export const FOREST_FOG = { width: 64, height: 36 } as const;

/**
 * The scene's passage (SceneDef.passage), one source for index.ts, the shader and the sim. Coming in,
 * the camera starts `back` m behind where it rests and dollies forward between the trunks over `settle`
 * s (arriving at speed and braking, a small overshoot, a settle), and the spirits pop up on their
 * perches one after another as it comes to rest; going out, the spirits turn their heads and vanish
 * one by one while the camera drifts `drift` m back into the mist, gathering speed.
 */
export const FOREST_PASSAGE = { enter: 3.2, exit: 1.6 } as const;
export const FOREST_DOLLY = { back: 2.6, settle: 2.0, drift: 1.4 } as const;

/** Height (m, in the torii's own frame) of the top of its top beam at x (m from its centre): the ends sweep up. */
export function forestKasagiTop(x: number): number {
  const k = (Math.abs(x) / (FOREST_TORII.span + FOREST_TORII.overhang)) ** 4;
  return FOREST_TORII.height + FOREST_TORII.beam + 0.18 * k;
}

interface Rock {
  readonly edge: number;
  readonly z: number;
  readonly rx: number;
  readonly ry: number;
  readonly centre: number;
}

/** A point on top of a boulder centred at screen x cx, u (-1..1) of its half-width across. */
function onRock(rock: Rock, cx: number, u: number): [number, number, number] {
  return [
    cx + (u * rock.rx) / rock.z,
    forestScreenY(rock.centre, rock.z) + (rock.ry / rock.z) * Math.sqrt(1 - u * u),
    rock.z,
  ];
}

/** A point of the torii's own frame (m: x from its centre, y up from its feet), leaning with it, on screen. */
function onTorii(x: number, y: number): [number, number, number] {
  const t = FOREST_TORII;
  const c = Math.cos(t.lean);
  const s = Math.sin(t.lean);
  const px = x - t.span;
  return [
    (forestStreamX(t.z) + t.span + c * px - s * y) / t.z,
    forestScreenY(s * px + c * y, t.z),
    t.z,
  ];
}

/**
 * Where the glowing mushrooms grow, for a frame of this aspect: screen x, y (at parallax 0) and
 * depth (m) of each cluster's foot. shader.ts places them the same way.
 */
export function forestShroomSites(aspect: number): [number, number, number][] {
  const la = forestLayoutAspect(aspect);
  const left = -0.5 * la + FOREST_ROCK_LEFT.edge;
  const right = 0.5 * la - FOREST_ROCK_RIGHT.edge;
  const logTop = forestScreenY(2 * FOREST_LOG.radius - 0.03, FOREST_LOG.z);
  const gate = FOREST_GATE_SHROOMS;
  return [
    onRock(FOREST_ROCK_LEFT, left, 0.8),
    onRock(FOREST_ROCK_LEFT, left, -0.66),
    [1.25 / FOREST_LOG.z, logTop, FOREST_LOG.z],
    [3.9 / FOREST_LOG.z, logTop, FOREST_LOG.z],
    onTorii(gate.x, gate.y),
    onRock(FOREST_ROCK_RIGHT, right, -0.72),
  ];
}

interface Perch {
  x: number;
  y: number;
  z: number;
}

/** Every place a spirit may appear, for a frame of this aspect: where its feet stand (screen) and its depth. */
function forestPerches(aspect: number): Perch[] {
  const la = forestLayoutAspect(aspect);
  const perches: Perch[] = [];
  const add = ([x, y, z]: [number, number, number]): void => {
    perches.push({ x, y, z });
  };
  const left = -0.5 * la + FOREST_ROCK_LEFT.edge;
  for (const u of [-0.42, 0.02, 0.42]) add(onRock(FOREST_ROCK_LEFT, left, u));
  const right = 0.5 * la - FOREST_ROCK_RIGHT.edge;
  for (const u of [-0.32, 0.3]) add(onRock(FOREST_ROCK_RIGHT, right, u));
  // On the log's moss.
  for (const x of [1.55, 2.6, 3.5])
    add([
      x / FOREST_LOG.z,
      forestScreenY(2 * FOREST_LOG.radius - 0.02, FOREST_LOG.z),
      FOREST_LOG.z,
    ]);
  // Along the beech's branch.
  const b = FOREST_BRANCH;
  const rootX = (0.5 * la - FOREST_ELDER.edge) * FOREST_ELDER.z - b.root * FOREST_ELDER.radius;
  for (const s of [0.42, 0.74]) {
    const top = b.height + b.rise * s - b.sag * s * s + b.radius + (b.tip - b.radius) * s;
    add([
      (rootX - s * b.length) / FOREST_ELDER.z,
      forestScreenY(top - 0.02, FOREST_ELDER.z),
      FOREST_ELDER.z,
    ]);
  }
  // On the torii's top beam, leaning with it.
  for (const lx of [-0.75, 0.8]) add(onTorii(lx, forestKasagiTop(lx) + 0.03));
  // Two of the stepping stones.
  for (const stone of [FOREST_STONES[0], FOREST_STONES[2]]) {
    add([
      (forestStreamX(stone.z) + stone.offset) / stone.z,
      forestScreenY(stone.height - 0.01, stone.z),
      stone.z,
    ]);
  }
  // The floor: on the right bank before the torii, at the beech's foot, on both banks nearer the torii.
  const elderX = (0.5 * la - FOREST_ELDER.edge) * FOREST_ELDER.z;
  const floor: [number, number][] = [
    [forestStreamX(9) + forestStreamHalf(9) + 0.3, 9],
    [elderX - 2.0, 6.5],
    [forestStreamX(12.2) + forestStreamHalf(12.2) + 0.6, 12.2],
    [forestStreamX(12) - forestStreamHalf(12) - 0.7, 12],
  ];
  for (const [x, z] of floor) add([x / z, forestScreenY(0, z), z]);
  return perches;
}

// ---- simulation constants ----

const STEP = 1 / 60;
const TAU = 2 * Math.PI;

// Spirits.
/** Seconds to rise out of the moss and materialise, and to dissolve. */
const RISE_TIME = 2.4;
const FADE_TIME = 2.8;
/** Seconds a spirit stays once it is there. */
const STAY_MIN = 16;
const STAY_MAX = 42;
/** Appearances per second at frequency 1, in full day and at night. */
const SPAWN_DAY = 0.04;
const SPAWN_NIGHT = 0.18;
/** Chance an appearance brings a companion to a nearby perch a moment later. */
const COMPANION = 0.4;
/** How far a companion may stand from the first (screen heights). */
const COMPANION_REACH = 0.4;
/** Seconds per tick of a rattling head turn; a turn takes 3 to 5 ticks. */
const TICK = 0.085;
/** Seconds between idle head turns. */
const TURN_MIN = 4;
const TURN_MAX = 11;
/** How near the pointer must come to a spirit's head to draw its look, and how near a click calls one (screen heights). */
const CURIOUS_REACH = 0.22;
const CALL_REACH = 0.3;
/** How near the pointer may come before a shy spirit ducks (screen heights), and how far it sinks then (its heights x 0.45: the eyes still peek over the moss). */
const SHY_REACH = 0.26;
const DUCK_SINK = 1.2;
/** Spirits a gathering ("now") calls, and seconds after it starts that they all turn together. */
const GATHERING = 6;
const CHORUS_AFTER = 4;
/** Spirit heights (m). */
const SIZE_MIN = 0.24;
const SIZE_MAX = 0.34;

// The passage's spirits. Seconds are into the entrance / the exit (the scene's passage clock, not the sim's).
/** Entrance: the first spirit pops up at POP_FROM, the rest every POP_GAP (squeezed into POP_SPAN in all), each taking POP_RISE to come up out of the moss. */
const POP_FROM = 1.7;
const POP_SPAN = 0.8;
const POP_GAP = 0.3;
const POP_RISE = 0.7;
/** Spirits an entrance shows at least (at spirits frequency 0.5; fewer when it is lower). */
const POP_MIN = 3;
/** Exit: each spirit turns its head at its turn (every LEAVE_GAP, squeezed into LEAVE_SPAN in all), and LEAVE_TURN later dissolves over LEAVE_FADE. */
const LEAVE_SPAN = 0.7;
const LEAVE_GAP = 0.2;
const LEAVE_TURN = 0.32;
const LEAVE_FADE = 0.5;

// The stag.
const STAG_SPEED = 1.05; // m/s
const STAG_CYCLE = 1.4; // m per gait cycle: its hooves stay planted at this pace (shader.ts forestHoof)
const STAG_FIRST_MIN = 22; // s before its first crossing
const STAG_FIRST_MAX = 45;
const STAG_WAIT_RARE = 420; // mean s between crossings at frequency 0 .. 1
const STAG_WAIT_OFTEN = 60;
const STAG_PAUSE_MIN = 6;
const STAG_PAUSE_MAX = 9.5;
const STAG_SLOW = 1.2; // m over which it slows to its stop
const STAG_START = 1.6; // s to get going again
const STAG_LOOK_TIME = 0.7; // s time constant of turning its head
const STAG_FADE = 3; // s to fade away if its knob goes off mid-crossing

// Motes.
const MAX_MOTES = 140;
/** Motes at spores amount 1, leaving room for puffs. */
const MOTE_TARGET = 90;
/** Share of motes that rise from the mushrooms (the rest are dust, seen in the shafts). */
const MOTE_FROM_SHROOMS = 0.55;
const MOTE_FADE_IN = 2.5;
const MOTE_FADE_OUT = 3;
const MOTE_LIFE_MIN = 14;
const MOTE_LIFE_MAX = 36;
const MOTE_NEAR = 1.6; // m
const MOTE_FAR = 20;
/** Spores rise slowly in the still air (screen heights per second at 5 m). */
const MOTE_RISE = 0.0035;
const PUFF_LIFE_MIN = 6;
const PUFF_LIFE_MAX = 12;
/** Seconds for a puff's first push to die away. */
const PUFF_KICK_TIME = 1.2;

// The wind: the curl of a sum of slowly turning plane waves (wavenumbers per screen height).
const WAVES = 5;
/** Each wave's speed contribution (screen heights per second at 5 m): together a ~0.01 swirl. */
const WAVE_SPEED = 0.007;
/** Sideways drift per unit of the wind knob (screen heights per second at 5 m). */
const WIND_DRIFT = 0.016;
// Stirs: the pointer drags the air along behind it.
const STIR_REACH = 0.07;
const STIR_GAIN = 0.35;
const STIR_MAX_SPEED = 0.3;
const STIR_DECAY = 1.2;
const STIR_EVERY = 0.04;
const STIR_LIFE = 5;
const MAX_STIRS = 12;

// The mist field.
const FOG_STEP = 1 / 30;
/** Seconds for the mist to heal back toward its banks. */
const FOG_RELAX = 16;
/** Depth (m) at which the mist field rides the wind. */
const FOG_DEPTH = 6;
/** How long the sim runs before the first frame (s): motes and mist already in motion. */
const PREWARM_SECONDS = 1.5;

/**
 * A rattling turn: progress 0..1 of the whole turn mapped onto `ticks` quick snaps, each easing out
 * with a small overshoot, so the head clicks round in steps rather than gliding.
 */
function rattleEase(x: number, ticks: number): number {
  if (x >= 1) return 1;
  const at = Math.max(0, x) * ticks;
  const k = Math.min(Math.floor(at), ticks - 1);
  const f = Math.min(1, (at - k) / 0.55) - 1;
  const overshoot = 1.2;
  return (k + 1 + (overshoot + 1) * f * f * f + overshoot * f * f) / ticks;
}

export class ForestSimError extends Error {}

type SpiritState = "free" | "rising" | "present" | "fading";

interface Spirit {
  state: SpiritState;
  perch: number;
  /** Seconds in the current state. */
  age: number;
  /** Seconds it stays once present. */
  stay: number;
  /** Height (m). */
  size: number;
  variant: number;
  /** Phase of its slow breathing glow. */
  breath: number;
  tilt: number;
  turnFrom: number;
  turnTo: number;
  /** Seconds into the current turn; negative while the head is still. */
  turnAge: number;
  ticks: number;
  /** Seconds since its last turn began. */
  sinceTurn: number;
  /** Seconds until its next idle turn. */
  nextTurn: number;
  yaw: number;
  yawTo: number;
  /** Seconds it keeps facing you after a gathering's chorus. */
  yawHold: number;
  /** 0..1: how hard it is clicking now (it brightens). */
  rattle: number;
  /** Entrance: seconds into it at which this spirit pops up (it is hidden until then), or -1. */
  popAt: number;
  /** Seconds it takes to rise out of the moss, and to dissolve. */
  rise: number;
  fade: number;
  /** Exit: seconds into it at which this spirit turns its head and then goes, or -1. */
  leaveAt: number;
  turned: boolean;
  /** Its own stable number 0..1: shy while it is under the shyness knob (sims/temperament.ts). */
  trait: number;
  /** How far a shy spirit has ducked into the moss from the pointer. */
  shrink: Shrink;
}

interface Pending {
  at: number;
  /** A perch to stand near (-1: anywhere), or a perch to take exactly. */
  near: number;
  exact: number;
}

type StagMode = "walk" | "stop" | "go";

interface Stag {
  active: boolean;
  x: number;
  dir: number;
  startX: number;
  walked: number;
  gait: number;
  /** Current speed (m/s): the legs settle into a standing pose as it slows. */
  speed: number;
  pauseAt: number;
  pauseFor: number;
  stopped: boolean;
  mode: StagMode;
  timer: number;
  look: number;
  headUp: number;
  alpha: number;
  lastDir: number;
  next: number;
}

interface Mote {
  alive: boolean;
  puff: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  base: number;
  kickX: number;
  kickY: number;
}

interface Wave {
  kx: number;
  ky: number;
  omega: number;
  phase: number;
  amp: number;
}

interface Stir {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

type KnobKey = "spirits" | "shy" | "stag" | "spores" | "wind" | "time" | "cycle" | "forestSeed";

class ForestSim implements SceneSim {
  readonly #beingTexture: DataTexture;
  readonly #moteTexture: DataTexture;
  readonly #fogTexture: DataTexture;
  readonly #beingData = new Float32Array(3 * (FOREST_SPIRITS + 1) * 4);
  #moteData = new Float32Array(4);
  #fog = new Float32Array(FOREST_FOG.width * FOREST_FOG.height);
  #fogNext = new Float32Array(FOREST_FOG.width * FOREST_FOG.height);
  readonly #knobIndex: Readonly<Record<KnobKey, number>>;

  readonly #spirits: Spirit[] = [];
  readonly #pending: Pending[] = [];
  readonly #motes: Mote[] = [];
  readonly #waves: Wave[] = [];
  readonly #stirs: Stir[] = [];
  readonly #stag: Stag = {
    active: false,
    x: 0,
    dir: 1,
    startX: 0,
    walked: 0,
    gait: 0,
    speed: 0,
    pauseAt: 0,
    pauseFor: 0,
    stopped: false,
    mode: "walk",
    timer: 0,
    look: 0,
    headUp: 0.35,
    alpha: 0,
    lastDir: -1,
    next: Number.POSITIVE_INFINITY,
  };
  #perches: Perch[] = [];
  #shroomSites: [number, number, number][] = [];
  #aspect = 0;
  #moteCols = 0;

  // Knobs, as the sim follows them.
  #spiritRate = 0.5;
  #shyness = 0;
  #stagRate = 0.3;
  #spores = 0.5;
  #wind = 0.2;
  #time = 0.82;
  #cycle = 0;
  #seed = -1;
  #random = mulberry32(1);
  #dark = 1;

  /** The sim's own clock: scene seconds scaled by motion. */
  #clock = 0;
  #fogDue = 0;
  #fogShift = 0;
  #chorusAt = Number.POSITIVE_INFINITY;
  /** The passage (FOREST_PASSAGE): the spirits are being brought in, or sent away, and nothing else appears. */
  #arriving = false;
  #leaving = false;
  #quiet = false;
  #warm = false;
  #dirty = true;

  // The wind at the last point asked (#flow).
  #vx = 0;
  #vy = 0;

  // The pointer, in screen units (x from the centre); undefined while it is away.
  #pointerX: number | undefined;
  #pointerY = 0;
  #sinceStir = 0;

  // Triggers: a "now" stamps its slot with the scene clock, so any change fires.
  #primed = false;
  #seen = [0, 0, 0, 0];

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const index = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new ForestSimError(`forest: the scene has no '${key}' knob`);
      return at;
    };
    this.#knobIndex = {
      spirits: index("spirits"),
      shy: index("shy"),
      stag: index("stag"),
      spores: index("spores"),
      wind: index("wind"),
      time: index("time"),
      cycle: index("cycle"),
      forestSeed: index("forestSeed"),
    };
    this.#beingTexture = new DataTexture(gl, {
      width: 3,
      height: FOREST_SPIRITS + 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#moteTexture = new DataTexture(gl, {
      width: 1,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#fogTexture = new DataTexture(gl, {
      width: FOREST_FOG.width,
      height: FOREST_FOG.height,
      format: "r16f",
    });
    for (let i = 0; i < FOREST_SPIRITS; i++) {
      this.#spirits.push({
        state: "free",
        perch: 0,
        age: 0,
        stay: 0,
        size: SIZE_MIN,
        variant: 0,
        breath: 0,
        tilt: 0,
        turnFrom: 0,
        turnTo: 0,
        turnAge: -1,
        ticks: 3,
        sinceTurn: 0,
        nextTurn: 0,
        yaw: 0,
        yawTo: 0,
        yawHold: 0,
        rattle: 0,
        popAt: -1,
        rise: RISE_TIME,
        fade: FADE_TIME,
        leaveAt: -1,
        turned: false,
        trait: 1,
        shrink: atEase(),
      });
    }
    for (let i = 0; i < MAX_MOTES; i++) {
      this.#motes.push({
        alive: false,
        puff: false,
        x: 0,
        y: 0,
        z: 5,
        age: 0,
        life: 1,
        base: 0,
        kickX: 0,
        kickY: 0,
      });
    }
    for (let i = 0; i < WAVES; i++) this.#waves.push({ kx: 0, ky: 0, omega: 0, phase: 0, amp: 0 });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    this.#readKnobs(frame);
    if (aspect !== this.#aspect) this.#resize(aspect);
    if (!this.#warm) {
      this.#prewarm(aspect);
      this.#warm = true;
      // Only a sim built while the scene comes in plays the entrance (the prewarm and its draws are unchanged).
      this.#arriving = frame.passage.enter < 1;
      if (this.#arriving) this.#stageEntrance();
    }
    this.#playPassage(frame.passage.enter, frame.passage.exit);
    this.#watchTriggers(frame.triggers, aspect);
    this.#trackPointer(frame.pointer, frame.dt, aspect);

    const advance = Math.min(Math.max(0, frame.dt) * Math.max(0, frame.motion), 0.25);
    if (advance > 0) this.#advance(advance, aspect);
    if (advance > 0 || this.#dirty) {
      this.#pack(aspect);
      this.#beingTexture.upload(this.#beingData);
      this.#moteTexture.upload(this.#moteData);
      this.#fogTexture.upload(this.#fog);
      this.#dirty = false;
    }
    return [this.#beingTexture.texture, this.#moteTexture.texture, this.#fogTexture.texture];
  }

  dispose(): void {
    this.#beingTexture.dispose();
    this.#moteTexture.dispose();
    this.#fogTexture.dispose();
  }

  #readKnobs(frame: SimFrame): void {
    const values = frame.values;
    const index = this.#knobIndex;
    this.#spiritRate = values[index.spirits] ?? this.#spiritRate;
    this.#shyness = values[index.shy] ?? this.#shyness;
    this.#stagRate = values[index.stag] ?? this.#stagRate;
    this.#spores = values[index.spores] ?? this.#spores;
    this.#wind = values[index.wind] ?? this.#wind;
    this.#time = values[index.time] ?? this.#time;
    this.#cycle = values[index.cycle] ?? this.#cycle;
    // The same clock as the shader's timeOfDayM(K_time, K_cycle, uMotionTime).
    const tod = this.#time + (this.#cycle * frame.motionTime) / 240;
    const t = tod - Math.floor(tod);
    this.#dark = 1 - smoothstep(0.24, 0.31, t) * (1 - smoothstep(0.69, 0.76, t));
    const seed = Math.round(values[index.forestSeed] ?? 0);
    if (seed !== this.#seed) {
      this.#seed = seed;
      this.#random = mulberry32(0x6b6f6461 ^ Math.imul(seed + 1, 0x9e3779b1));
      const random = mulberry32(0x77696e64 ^ Math.imul(seed + 7, 0x85ebca6b));
      for (const wave of this.#waves) {
        const angle = random() * TAU;
        const k = 4 + 5 * random();
        wave.kx = k * Math.cos(angle);
        wave.ky = k * Math.sin(angle);
        wave.omega = (0.04 + 0.08 * random()) * (random() < 0.5 ? -1 : 1);
        wave.phase = random() * TAU;
        wave.amp = (WAVE_SPEED * (0.6 + 0.4 * random())) / k;
      }
      this.#dirty = true;
    }
  }

  #resize(aspect: number): void {
    this.#aspect = aspect;
    this.#perches = forestPerches(aspect);
    this.#shroomSites = forestShroomSites(aspect);
    this.#moteCols = Math.ceil(FOREST_MOTE_ROWS * aspect) + 1;
    this.#moteTexture.resize(2 * this.#moteCols, FOREST_MOTE_ROWS);
    this.#moteData = new Float32Array(2 * this.#moteCols * FOREST_MOTE_ROWS * 4);
    this.#dirty = true;
  }

  /**
   * Before the first frame: the mist lies in its banks, the motes are already drifting at every age,
   * the spirits that would be about at this hour are sitting on their perches, and the stag's first
   * crossing is due within the first minute.
   */
  #prewarm(aspect: number): void {
    const w = FOREST_FOG.width;
    const h = FOREST_FOG.height;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++)
        this.#fog[j * w + i] = this.#fogTarget(((i + 0.5) / w - 0.5) * aspect, (j + 0.5) / h);
    }
    const target = Math.round(this.#spores * MOTE_TARGET);
    for (let i = 0; i < target; i++) {
      const mote = this.#motes[i];
      if (mote) this.#spawnMote(mote, aspect, true);
    }
    const stay = 0.5 * (STAY_MIN + STAY_MAX);
    const expected = Math.round(this.#rate() * (stay + RISE_TIME + FADE_TIME) * (1 + COMPANION));
    for (let i = 0; i < Math.min(expected, FOREST_SPIRITS - 2); i++) {
      const spirit = this.#appear(-1, -1, false);
      if (!spirit) break;
      spirit.state = "present";
      spirit.age = this.#random() * spirit.stay * 0.8;
    }
    if (this.#stagRate > 0)
      this.#stag.next =
        this.#clock + STAG_FIRST_MIN + (STAG_FIRST_MAX - STAG_FIRST_MIN) * this.#random();
    const steps = Math.round(PREWARM_SECONDS / STEP);
    for (let s = 0; s < steps; s++) this.#step(STEP, aspect);
  }

  #watchTriggers(triggers: readonly number[], aspect: number): void {
    const fired = (slot: number): boolean => {
      const at = triggers[slot] ?? -1e4;
      const changed = this.#primed && at !== this.#seen[slot] && at > -1e3;
      this.#seen[slot] = at;
      return changed;
    };
    if (fired(0)) this.#gather();
    if (fired(1) && !this.#stag.active) this.#startStag(aspect, true);
    if (fired(2)) this.#puffMark(aspect);
    if (fired(3)) this.#puffShrooms();
    this.#primed = true;
  }

  /** The pointer drags the air (and the motes and the mist) along behind it; a click calls a spirit. */
  #trackPointer(pointer: PointerState, dt: number, aspect: number): void {
    if (!pointer.inside) {
      this.#pointerX = undefined;
      return;
    }
    const px = (pointer.x - 0.5) * aspect;
    const py = pointer.y;
    if (this.#pointerX !== undefined && dt > 0) {
      const vx = (px - this.#pointerX) / dt;
      const vy = (py - this.#pointerY) / dt;
      this.#sinceStir += dt;
      const speed = Math.hypot(vx, vy);
      if (speed > 0.05 && this.#sinceStir >= STIR_EVERY) {
        this.#sinceStir = 0;
        const k = Math.min(1, STIR_MAX_SPEED / (speed * STIR_GAIN));
        this.#addStir(px, py, vx * STIR_GAIN * k, vy * STIR_GAIN * k);
      }
    }
    this.#pointerX = px;
    this.#pointerY = py;
    if (pointer.pressed) this.#press(px, py);
  }

  /** A click: a puff of spores where it landed, and the nearest free perch within reach gets a spirit. */
  #press(px: number, py: number): void {
    this.#puff(px, py, 5, 8, 0.03, 0.5);
    for (let i = 0; i < 4; i++) {
      const a = (i + 0.5) * (TAU / 4);
      this.#addStir(
        px + 0.02 * Math.cos(a),
        py + 0.02 * Math.sin(a),
        0.08 * Math.cos(a),
        0.08 * Math.sin(a),
      );
    }
    const perch = this.#nearestFreePerch(px, py, CALL_REACH);
    if (perch >= 0) {
      this.#appear(-1, perch, false);
      return;
    }
    // No room: the nearest spirit turns its head instead.
    let best: Spirit | undefined;
    let bestD = CALL_REACH * CALL_REACH;
    for (const spirit of this.#spirits) {
      if (spirit.state === "free") continue;
      const p = this.#perches[spirit.perch];
      if (!p) continue;
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = spirit;
      }
    }
    if (best) this.#turn(best, (this.#random() < 0.5 ? -1 : 1) * (0.35 + 0.25 * this.#random()));
  }

  #addStir(x: number, y: number, vx: number, vy: number): void {
    if (this.#stirs.length >= MAX_STIRS) this.#stirs.shift();
    this.#stirs.push({ x, y, vx, vy, age: 0 });
  }

  #advance(total: number, aspect: number): void {
    const steps = Math.ceil(total / STEP);
    const h = total / steps;
    for (let s = 0; s < steps; s++) this.#step(h, aspect);
  }

  #step(h: number, aspect: number): void {
    this.#clock += h;
    for (let i = this.#stirs.length - 1; i >= 0; i--) {
      const stir = this.#stirs[i];
      if (!stir) continue;
      stir.age += h;
      if (stir.age > STIR_LIFE) this.#stirs.splice(i, 1);
    }
    this.#stepSpirits(h);
    this.#stepStag(h, aspect);
    this.#stepMotes(h, aspect);
    this.#fogDue += h;
    while (this.#fogDue >= FOG_STEP) {
      this.#fogDue -= FOG_STEP;
      this.#stepFog(FOG_STEP, aspect);
    }
  }

  /** The wind at screen point (x, y) for something at depth z (m): leaves it in #vx, #vy. */
  #flow(x: number, y: number, z: number): void {
    const depth = clamp(Math.sqrt(5 / z), 0.55, 1.6);
    let vx = 0;
    let vy = 0;
    for (const w of this.#waves) {
      const c = w.amp * Math.cos(w.kx * x + w.ky * y + w.omega * this.#clock + w.phase);
      vx += c * w.ky;
      vy -= c * w.kx;
    }
    vx = (vx + this.#wind * WIND_DRIFT) * depth;
    vy *= depth;
    for (const stir of this.#stirs) {
      const dx = x - stir.x;
      const dy = y - stir.y;
      const f = Math.exp(-(dx * dx + dy * dy) / (STIR_REACH * STIR_REACH) - stir.age / STIR_DECAY);
      vx += stir.vx * f;
      vy += stir.vy * f;
    }
    this.#vx = vx;
    this.#vy = vy;
  }

  // ---- spirits ----

  #rate(): number {
    return this.#spiritRate * (SPAWN_DAY + (SPAWN_NIGHT - SPAWN_DAY) * this.#dark);
  }

  #visible(perch: Perch): boolean {
    return Math.abs(perch.x) < 0.5 * this.#aspect - 0.03;
  }

  #occupied(index: number): boolean {
    for (const spirit of this.#spirits)
      if (spirit.state !== "free" && spirit.perch === index) return true;
    return false;
  }

  #nearestFreePerch(x: number, y: number, reach: number): number {
    let best = -1;
    let bestD = reach * reach;
    for (const [i, perch] of this.#perches.entries()) {
      if (!this.#visible(perch) || this.#occupied(i)) continue;
      const d = (perch.x - x) ** 2 + (perch.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * A spirit appears: on perch `exact` if it is free, else near perch `near` (within reach), else on
   * any free perch in view. Returns it, or undefined when there is no room.
   */
  #appear(near: number, exact: number, companion: boolean): Spirit | undefined {
    const spirit = this.#spirits.find((s) => s.state === "free");
    if (!spirit) return undefined;
    let perch = -1;
    if (exact >= 0) {
      const p = this.#perches[exact];
      if (p && this.#visible(p) && !this.#occupied(exact)) perch = exact;
    } else if (near >= 0) {
      const p = this.#perches[near];
      if (p) perch = this.#nearestFreePerch(p.x, p.y, COMPANION_REACH);
    } else {
      const free: number[] = [];
      for (const [i, p] of this.#perches.entries())
        if (this.#visible(p) && !this.#occupied(i)) free.push(i);
      perch = free[Math.floor(this.#random() * free.length)] ?? -1;
    }
    if (perch < 0) return undefined;
    const r = this.#random;
    spirit.state = "rising";
    spirit.perch = perch;
    spirit.age = 0;
    spirit.stay = STAY_MIN + (STAY_MAX - STAY_MIN) * r();
    spirit.size = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * r();
    spirit.variant = r();
    spirit.breath = r() * TAU;
    spirit.tilt = (r() - 0.5) * 0.3;
    spirit.turnAge = -1;
    spirit.sinceTurn = 0;
    spirit.nextTurn = 2 + 5 * r();
    spirit.yaw = 0;
    spirit.yawTo = (r() - 0.5) * 0.5;
    spirit.yawHold = 0;
    spirit.rattle = 0;
    spirit.popAt = -1;
    spirit.rise = RISE_TIME;
    spirit.fade = FADE_TIME;
    spirit.leaveAt = -1;
    spirit.turned = false;
    // Its temperament comes from its own variant, so the knob never shifts the seeded draws.
    spirit.trait = hash31(Math.floor(spirit.variant * 16777216), 0x6b6f, 0x7368);
    spirit.shrink.amount = 0;
    spirit.shrink.calm = Number.POSITIVE_INFINITY;
    if (companion && r() < COMPANION)
      this.#pending.push({ at: this.#clock + 1.2 + 1.8 * r(), near: perch, exact: -1 });
    return spirit;
  }

  /** Start a rattling turn of the head toward tilt `to`. */
  #turn(spirit: Spirit, to: number): void {
    spirit.turnFrom = spirit.tilt;
    spirit.turnTo = to;
    spirit.turnAge = 0;
    spirit.ticks = 3 + Math.floor(this.#random() * 3);
    spirit.sinceTurn = 0;
  }

  /** A gathering: spirits appear on free perches one after another, then all turn their heads together. */
  #gather(): void {
    const free: number[] = [];
    for (const [i, p] of this.#perches.entries())
      if (this.#visible(p) && !this.#occupied(i)) free.push(i);
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(this.#random() * (i + 1));
      const a = free[i] ?? 0;
      free[i] = free[j] ?? 0;
      free[j] = a;
    }
    for (const [k, perch] of free.slice(0, GATHERING).entries()) {
      this.#pending.push({
        at: this.#clock + 0.35 * k + 0.2 * this.#random(),
        near: -1,
        exact: perch,
      });
    }
    this.#chorusAt = this.#clock + CHORUS_AFTER;
  }

  #stepSpirits(h: number): void {
    const rate = this.#rate();
    if (!this.#quiet && rate > 0 && this.#random() < rate * h) this.#appear(-1, -1, true);
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const pending = this.#pending[i];
      if (!pending || pending.at > this.#clock) continue;
      this.#pending.splice(i, 1);
      this.#appear(pending.near, pending.exact, false);
    }
    if (this.#clock >= this.#chorusAt) {
      this.#chorusAt = Number.POSITIVE_INFINITY;
      const side = this.#random() < 0.5 ? -1 : 1;
      for (const spirit of this.#spirits) {
        if (spirit.state !== "rising" && spirit.state !== "present") continue;
        this.#turn(spirit, side * (0.4 + 0.15 * this.#random()));
        spirit.ticks = 4;
        spirit.yawTo = 0;
        spirit.yawHold = 4;
        spirit.nextTurn = 3 + 2 * this.#random();
      }
    }

    const ease = 1 - Math.exp(-h / 0.3);
    for (const spirit of this.#spirits) {
      if (spirit.state === "free" || spirit.popAt >= 0) continue;
      spirit.age += h;
      if (spirit.state === "rising" && spirit.age >= spirit.rise) {
        spirit.state = "present";
        spirit.age = 0;
      } else if (spirit.state === "present" && spirit.age >= spirit.stay) {
        spirit.state = "fading";
        spirit.age = 0;
        // Some give a last rattle as they go.
        if (spirit.turnAge < 0 && this.#random() < 0.45)
          this.#turn(spirit, (this.#random() - 0.5) * 1.1);
      } else if (spirit.state === "fading" && spirit.age >= spirit.fade) {
        spirit.state = "free";
        continue;
      }

      // The head: a turn in progress clicks on; otherwise the pointer or an idle whim starts one.
      spirit.sinceTurn += h;
      if (spirit.turnAge >= 0) {
        spirit.turnAge += h;
        const x = spirit.turnAge / (spirit.ticks * TICK);
        spirit.tilt =
          spirit.turnFrom + (spirit.turnTo - spirit.turnFrom) * rattleEase(x, spirit.ticks);
        if (x >= 1) spirit.turnAge = -1;
      }
      spirit.rattle += ((spirit.turnAge >= 0 ? 1 : 0) - spirit.rattle) * (1 - Math.exp(-h / 0.15));
      spirit.yawHold = Math.max(0, spirit.yawHold - h);

      // The pointer near its head: a curious spirit turns to look at it, a shy one ducks into the moss
      // looking away, and peeps back up a while after the pointer has gone (sims/temperament.ts).
      const perch = this.#perches[spirit.perch];
      const shy = isShy(spirit.trait, this.#shyness);
      let engaged = false;
      if (perch && this.#pointerX !== undefined && spirit.state !== "fading") {
        const dx = this.#pointerX - perch.x;
        const dy = this.#pointerY - (perch.y + (0.75 * spirit.size) / perch.z);
        const reach = shy ? SHY_REACH : CURIOUS_REACH;
        if (dx * dx + dy * dy < reach * reach) {
          engaged = true;
          spirit.yawTo = facing(dx, 0.1, shy);
          const want = (shy ? 1 : -1) * Math.sign(dx) * 0.3 * (0.8 + 0.4 * spirit.variant);
          if (spirit.turnAge < 0 && spirit.sinceTurn > 0.8 && Math.abs(spirit.turnTo - want) > 0.25)
            this.#turn(spirit, want);
        }
      }
      if (shy || spirit.shrink.amount > 0) stepShrink(spirit.shrink, h, shy && engaged);
      if (!engaged && spirit.state !== "fading") {
        spirit.nextTurn -= h;
        if (spirit.nextTurn <= 0 && spirit.turnAge < 0) {
          const r = this.#random();
          this.#turn(spirit, r < 0.35 ? 0 : (r < 0.675 ? -1 : 1) * (0.25 + 0.35 * this.#random()));
          spirit.nextTurn = TURN_MIN + (TURN_MAX - TURN_MIN) * this.#random();
          spirit.yawTo = spirit.yawHold > 0 ? 0 : (this.#random() - 0.5) * 0.8;
        }
      }
      spirit.yaw += (spirit.yawTo - spirit.yaw) * ease;
    }
  }

  // ---- the passage ----

  /** The live spirits, ordered by their perch's screen x (ascending for sign 1, descending for -1). */
  #inOrder(sign: number): Spirit[] {
    const x = (s: Spirit): number => this.#perches[s.perch]?.x ?? 0;
    return this.#spirits.filter((s) => s.state !== "free").sort((a, b) => sign * (x(a) - x(b)));
  }

  /**
   * The entrance: the spirits the prewarm seated (and a few more, so that there is something to see by
   * day) stay hidden, and pop up one after another from POP_FROM, left to right.
   */
  #stageEntrance(): void {
    if (this.#spiritRate > 0) {
      let live = this.#spirits.filter((s) => s.state !== "free").length;
      const wanted = Math.min(POP_MIN, Math.ceil((POP_MIN * this.#spiritRate) / 0.5));
      while (live < wanted && this.#appear(-1, -1, false)) live++;
    }
    const order = this.#inOrder(1);
    const gap = order.length > 1 ? Math.min(POP_GAP, POP_SPAN / (order.length - 1)) : 0;
    for (const [k, spirit] of order.entries()) {
      spirit.state = "rising";
      spirit.age = 0;
      spirit.rise = POP_RISE;
      spirit.popAt = POP_FROM + k * gap;
    }
    this.#dirty = true;
  }

  /** The exit: the spirits go one after another, right to left (a hidden one that never came is dropped). */
  #stageExit(): void {
    for (const spirit of this.#spirits) {
      if (spirit.popAt < 0) continue;
      spirit.popAt = -1;
      spirit.state = "free";
    }
    this.#pending.length = 0;
    this.#chorusAt = Number.POSITIVE_INFINITY;
    const order = this.#inOrder(-1);
    const gap = order.length > 1 ? Math.min(LEAVE_GAP, LEAVE_SPAN / (order.length - 1)) : 0;
    for (const [k, spirit] of order.entries()) {
      spirit.leaveAt = k * gap;
      spirit.turned = false;
    }
  }

  /** Where the passage stands: `enter` and `exit` are SimFrame.passage's progress 0..1. */
  #playPassage(enter: number, exit: number): void {
    if (exit > 0) {
      if (!this.#leaving) {
        this.#leaving = true;
        this.#arriving = false;
        this.#stageExit();
      }
      this.#playExit(Math.min(1, exit) * FOREST_PASSAGE.exit);
    } else if (this.#arriving) {
      const done = enter >= 1;
      this.#playEntrance(
        done ? Number.POSITIVE_INFINITY : Math.max(0, enter) * FOREST_PASSAGE.enter,
      );
      if (done) this.#arriving = false;
    }
    this.#quiet = this.#arriving || this.#leaving;
  }

  #playEntrance(seconds: number): void {
    for (const spirit of this.#spirits) {
      if (spirit.popAt < 0 || seconds < spirit.popAt) continue;
      spirit.popAt = -1;
      this.#dirty = true;
    }
  }

  #playExit(seconds: number): void {
    for (const spirit of this.#spirits) {
      if (spirit.state === "free" || spirit.leaveAt < 0 || seconds < spirit.leaveAt) continue;
      if (!spirit.turned) {
        spirit.turned = true;
        spirit.nextTurn = Number.POSITIVE_INFINITY;
        this.#turn(spirit, (this.#random() < 0.5 ? -1 : 1) * (0.4 + 0.2 * this.#random()));
      }
      if (seconds >= spirit.leaveAt + LEAVE_TURN && spirit.state !== "fading") {
        spirit.state = "fading";
        spirit.age = 0;
        spirit.fade = LEAVE_FADE;
      }
    }
  }

  // ---- the stag ----

  #stagWait(): number {
    const mean = STAG_WAIT_RARE + (STAG_WAIT_OFTEN - STAG_WAIT_RARE) * Math.min(1, this.#stagRate);
    return mean * clamp(-Math.log(1 - this.#random()), 0.4, 2.2);
  }

  /** It sets out from beyond one edge; it will stop once, in the torii's frame if `atGate`. */
  #startStag(aspect: number, atGate: boolean): void {
    const st = this.#stag;
    const z = FOREST_STAG.z;
    const half = 0.5 * aspect * z;
    const dir = this.#random() < 0.75 ? -st.lastDir : st.lastDir;
    st.lastDir = dir;
    st.dir = dir;
    st.x = -dir * (half + 3.5);
    st.startX = st.x;
    st.walked = 0;
    st.gait = this.#random();
    st.speed = STAG_SPEED;
    const gate = (forestStreamX(FOREST_TORII.z) / FOREST_TORII.z) * z;
    st.pauseAt = clamp(
      atGate ? gate + (this.#random() - 0.5) * 0.6 : (this.#random() - 0.5) * 1.2 * half,
      -0.7 * half,
      0.7 * half,
    );
    st.pauseFor = STAG_PAUSE_MIN + (STAG_PAUSE_MAX - STAG_PAUSE_MIN) * this.#random();
    st.stopped = false;
    st.mode = "walk";
    st.timer = 0;
    st.look = 0;
    st.headUp = 0.35;
    st.alpha = 1;
    st.active = true;
  }

  #stepStag(h: number, aspect: number): void {
    const st = this.#stag;
    if (!st.active) {
      if (this.#stagRate <= 0) {
        st.next = Number.POSITIVE_INFINITY;
        return;
      }
      if (!Number.isFinite(st.next)) st.next = this.#clock + this.#stagWait();
      if (this.#clock >= st.next) this.#startStag(aspect, this.#random() < 0.5);
      return;
    }
    if (this.#stagRate <= 0) {
      st.alpha -= h / STAG_FADE;
      if (st.alpha <= 0) {
        st.alpha = 0;
        st.active = false;
        st.next = Number.POSITIVE_INFINITY;
        return;
      }
    }
    let v = 0;
    switch (st.mode) {
      case "walk": {
        v = STAG_SPEED;
        const ahead = st.dir * (st.pauseAt - st.x);
        if (!st.stopped && ahead < STAG_SLOW) {
          v = STAG_SPEED * Math.max(0.12, ahead / STAG_SLOW);
          if (ahead <= 0.01) {
            st.mode = "stop";
            st.timer = 0;
            st.stopped = true;
            v = 0;
          }
        }
        break;
      }
      case "stop":
        st.timer += h;
        if (st.timer >= st.pauseFor) {
          st.mode = "go";
          st.timer = 0;
        }
        break;
      case "go":
        st.timer += h;
        v = STAG_SPEED * smoothstep(0, STAG_START, st.timer);
        if (st.timer >= STAG_START) st.mode = "walk";
        break;
      default: {
        const unreachable: never = st.mode;
        throw new ForestSimError(`forest: unknown stag mode ${String(unreachable)}`);
      }
    }
    st.speed = v;
    st.x += st.dir * v * h;
    st.walked += v * h;
    st.gait = (st.gait + (v * h) / STAG_CYCLE) % 1;
    const looking = st.mode === "stop" && st.timer > 0.8 && st.timer < st.pauseFor - 0.6;
    st.look += ((looking ? 1 : 0) - st.look) * (1 - Math.exp(-h / STAG_LOOK_TIME));
    st.headUp += ((st.mode === "stop" ? 1 : 0.35) - st.headUp) * (1 - Math.exp(-h / 0.9));
    if (st.dir * st.x > 0.5 * aspect * FOREST_STAG.z + 4) {
      st.active = false;
      st.alpha = 0;
      st.next = this.#stagRate > 0 ? this.#clock + this.#stagWait() : Number.POSITIVE_INFINITY;
    }
  }

  // ---- motes ----

  #spawnMote(mote: Mote, aspect: number, anyAge: boolean): void {
    const r = this.#random;
    mote.alive = true;
    mote.puff = false;
    const site =
      r() < MOTE_FROM_SHROOMS
        ? this.#shroomSites[Math.floor(r() * this.#shroomSites.length)]
        : undefined;
    if (site) {
      const [x, y, z] = site;
      mote.x = x + (r() - 0.5) * 0.12;
      mote.y = y + 0.08 * r();
      mote.z = Math.max(MOTE_NEAR, z * (0.9 + 0.2 * r()));
    } else {
      mote.x = (2 * r() - 1) * 0.5 * aspect;
      mote.y = 0.04 + 0.9 * r();
      mote.z = MOTE_NEAR * (MOTE_FAR / MOTE_NEAR) ** r();
    }
    mote.life = MOTE_LIFE_MIN + (MOTE_LIFE_MAX - MOTE_LIFE_MIN) * r();
    mote.age = anyAge ? r() * mote.life : 0;
    mote.base = 0.5 + 0.5 * r();
    mote.kickX = 0;
    mote.kickY = 0;
  }

  /** A puff of `count` bright spores from (x, y) at depth z, spreading `spread` and pushed upward by `up`. */
  #puff(x: number, y: number, z: number, count: number, spread: number, up: number): void {
    const r = this.#random;
    let left = count;
    for (const mote of this.#motes) {
      if (left <= 0) break;
      if (mote.alive) continue;
      left--;
      mote.alive = true;
      mote.puff = true;
      mote.x = x + (r() - 0.5) * spread;
      mote.y = y + r() * spread * 0.5;
      mote.z = z * (0.9 + 0.2 * r());
      mote.life = PUFF_LIFE_MIN + (PUFF_LIFE_MAX - PUFF_LIFE_MIN) * r();
      mote.age = 0;
      mote.base = 0.8 + 0.2 * r();
      const a = (r() - 0.5) * 2.2;
      const speed = 0.03 + 0.05 * r();
      mote.kickX = Math.sin(a) * speed;
      mote.kickY = Math.cos(a) * speed * up + 0.01;
    }
  }

  /** The mushrooms breathe out their spores. */
  #puffShrooms(): void {
    for (const [x, y, z] of this.#shroomSites) this.#puff(x, y + 0.06 / z, z - 0.1, 5, 0.12 / z, 1);
  }

  /** Spores rise from the roots of the M. */
  #puffMark(aspect: number): void {
    const la = forestLayoutAspect(aspect);
    const rock = FOREST_ROCK_LEFT;
    const ry = rock.ry / rock.z;
    const mx = -0.5 * la + rock.edge;
    const my = forestScreenY(rock.centre, rock.z) + FOREST_MARK.lift * ry;
    const ms = FOREST_MARK.size * ry;
    const vx = [-0.47, -0.47, 0, 0.47, 0.47];
    const vy = [-0.5, 0.5, -0.08, 0.5, -0.5];
    for (let i = 0; i < 14; i++) {
      const k = Math.min(3, Math.floor(this.#random() * 4));
      const t = this.#random();
      const x = (vx[k] ?? 0) + ((vx[k + 1] ?? 0) - (vx[k] ?? 0)) * t;
      const y = (vy[k] ?? 0) + ((vy[k + 1] ?? 0) - (vy[k] ?? 0)) * t;
      this.#puff(mx + x * ms, my + y * ms, rock.z - 0.1, 1, 0.01, 0.6);
    }
  }

  #stepMotes(h: number, aspect: number): void {
    const half = 0.5 * aspect;
    const target = Math.round(this.#spores * MOTE_TARGET);
    let regular = 0;
    for (const mote of this.#motes) if (mote.alive && !mote.puff) regular++;
    // Fewer wanted: the extra ones fade out early.
    let excess = regular - target;
    for (const mote of this.#motes) {
      if (excess <= 0) break;
      if (!mote.alive || mote.puff || mote.life - mote.age <= MOTE_FADE_OUT) continue;
      mote.life = mote.age + MOTE_FADE_OUT;
      excess--;
    }
    // More wanted: one more each step.
    if (regular < target) {
      const free = this.#motes.find((m) => !m.alive);
      if (free) this.#spawnMote(free, aspect, false);
    }
    for (const mote of this.#motes) {
      if (!mote.alive) continue;
      mote.age += h;
      if (mote.age >= mote.life) {
        mote.alive = false;
        continue;
      }
      this.#flow(mote.x, mote.y, mote.z);
      const kick = Math.exp(-mote.age / PUFF_KICK_TIME);
      const depth = clamp(Math.sqrt(5 / mote.z), 0.55, 1.6);
      mote.x += (this.#vx + mote.kickX * kick) * h;
      mote.y += (this.#vy + mote.kickY * kick + MOTE_RISE * depth) * h;
      if (Math.abs(mote.x) > half + 0.03 || mote.y < -0.03 || mote.y > 1.03) mote.alive = false;
    }
  }

  // ---- the mist ----

  /** The banks the mist relaxes toward: thickest in a band low over the far floor and the stream. */
  #fogTarget(x: number, y: number): number {
    const band =
      0.8 +
      0.45 * Math.exp(-(((y - 0.3) / 0.13) ** 2)) +
      0.15 * Math.exp(-(((y - 0.05) / 0.1) ** 2));
    const shift = this.#fogShift;
    const n =
      0.6 * valueNoise(x * 1.6 - shift, y * 3.2 + 0.7, 10) +
      0.4 * valueNoise(x * 3.7 - 1.6 * shift, y * 6 + 2.1, 11);
    return band * (0.62 + 0.76 * n);
  }

  /** Bilinear sample of the mist at uv, or undefined outside the grid. */
  #sampleFog(u: number, v: number): number | undefined {
    const w = FOREST_FOG.width;
    const h = FOREST_FOG.height;
    const gx = u * w - 0.5;
    const gy = v * h - 0.5;
    if (gx < -0.5 || gy < -0.5 || gx > w - 0.5 || gy > h - 0.5) return undefined;
    const x0 = clamp(Math.floor(gx), 0, w - 1);
    const y0 = clamp(Math.floor(gy), 0, h - 1);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const fx = clamp(gx - x0, 0, 1);
    const fy = clamp(gy - y0, 0, 1);
    const f = this.#fog;
    const a = f[y0 * w + x0] ?? 1;
    const b = f[y0 * w + x1] ?? 1;
    const c = f[y1 * w + x0] ?? 1;
    const d = f[y1 * w + x1] ?? 1;
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /** Carry the mist on the wind (semi-Lagrangian), and let it heal toward its drifting banks. */
  #stepFog(h: number, aspect: number): void {
    const w = FOREST_FOG.width;
    const rows = FOREST_FOG.height;
    this.#fogShift += (0.012 + 0.03 * Math.abs(this.#wind)) * Math.sign(this.#wind || 1) * h;
    const relax = 1 - Math.exp(-h / FOG_RELAX);
    for (let j = 0; j < rows; j++) {
      const y = (j + 0.5) / rows;
      for (let i = 0; i < w; i++) {
        const x = ((i + 0.5) / w - 0.5) * aspect;
        this.#flow(x, y, FOG_DEPTH);
        const bx = x - this.#vx * h;
        const by = y - this.#vy * h;
        const target = this.#fogTarget(x, y);
        const carried = this.#sampleFog(bx / aspect + 0.5, by) ?? this.#fogTarget(bx, by);
        this.#fogNext[j * w + i] = carried + (target - carried) * relax;
      }
    }
    const swap = this.#fog;
    this.#fog = this.#fogNext;
    this.#fogNext = swap;
  }

  // ---- packing ----

  #pack(aspect: number): void {
    const data = this.#beingData;
    data.fill(0);
    for (const [i, spirit] of this.#spirits.entries()) {
      const perch = this.#perches[spirit.perch];
      if (spirit.state === "free" || spirit.popAt >= 0 || !perch) continue;
      let alpha = 1;
      let sink = 0;
      if (spirit.state === "rising") {
        const x = Math.min(1, spirit.age / spirit.rise);
        alpha = smoothstep(0, 1, x);
        sink = (1 - x) * (1 - x);
      } else if (spirit.state === "fading") {
        alpha = 1 - smoothstep(0, 1, spirit.age / spirit.fade);
      }
      let glow = 0.72 + 0.14 * Math.sin(this.#clock * 0.8 + spirit.breath) + 0.3 * spirit.rattle;
      const duck = spirit.shrink.amount;
      if (duck > 0) {
        // Ducked: down in the moss to its eyes, its glow drawn in.
        sink = Math.max(sink, DUCK_SINK * duck);
        glow *= 1 - 0.6 * duck;
      }
      data.set(
        [
          perch.x,
          perch.y,
          perch.z,
          alpha,
          spirit.tilt,
          spirit.yaw,
          glow,
          spirit.variant,
          sink,
          spirit.size,
          0,
          0,
        ],
        i * 12,
      );
    }
    const st = this.#stag;
    if (st.active) {
      data.set(
        [
          st.x,
          st.gait,
          st.dir,
          st.alpha,
          st.look,
          st.headUp,
          st.startX,
          st.walked,
          1 - st.speed / STAG_SPEED,
        ],
        FOREST_SPIRITS * 12,
      );
    }

    const motes = this.#moteData;
    motes.fill(0);
    const cols = this.#moteCols;
    const rows = FOREST_MOTE_ROWS;
    for (const mote of this.#motes) {
      if (!mote.alive) continue;
      const fadeIn = smoothstep(0, MOTE_FADE_IN, mote.age);
      const fadeOut = smoothstep(0, MOTE_FADE_OUT, mote.life - mote.age);
      const glow = mote.base * fadeIn * fadeOut;
      if (glow < 0.004) continue;
      const gx = (mote.x + 0.5 * aspect) * rows;
      const gy = mote.y * rows;
      const bx = Math.floor(gx);
      const by = Math.floor(gy);
      if (bx < 0 || by < 0 || bx >= cols || by >= rows) continue;
      // Two slots per bin; a third mote in the same bin (rare) waits its turn.
      let at = (by * 2 * cols + 2 * bx) * 4;
      if ((motes[at + 3] ?? 0) > 0) at += 4;
      if ((motes[at + 3] ?? 0) > 0) continue;
      motes[at] = gx - bx;
      motes[at + 1] = gy - by;
      motes[at + 2] = mote.z;
      motes[at + 3] = glow;
    }
  }
}

/** The forest's simulation for a scene whose knobs are `params` (looked up by key). */
export function forestSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new ForestSim(gl, params);
}
