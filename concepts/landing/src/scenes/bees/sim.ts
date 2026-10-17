// The hillside's living specks: up to two hundred bees working three hives, now and then a swarm, a
// handful of butterflies, bumblebees, hoverflies and dragonflies, and fireflies after dusk, flying in
// the garden's own three-dimensional space and drawn at the size and place that space projects to.
//
// The world. The garden is a ground plane seen through CAMERA (a LevelCamera, sims/camera.ts): the eye
// BEES_CAM metres above it, its horizon at uv height BEES_YH and a focal length of one screen height. A
// world point (X, Z, H) (metres: right, away from the viewer, above the ground) therefore lies at
// screen (x, y) = (X / Z, BEES_YH - (BEES_CAM - H) / Z) in screen heights from the middle of the view:
// the ground at depth Z is at BEES_YH - BEES_CAM / Z, and a metre there is 1 / Z screen heights, the
// shader's own ground mapping (beesS). Hives, flower drifts, foxgloves, the orchard's trees and the
// blossom in their crowns are laid out on screen as fractions of the stage half width (shader.ts paints
// them there) and converted to world targets through CAMERA, so a bee lands exactly on the landing
// board it is drawn next to, a bumblebee on the foxglove bell the shader sways in the wind, and a swarm
// hangs from the limb of the tree the shader draws.
//
// Size. A worker is BEE_LENGTH long, a butterfly BUTTERFLY_SPAN across, a bumblebee, a hoverfly and a
// dragonfly their own lengths, so at the hives' distance a bee is about one dither cell, and fewer the
// farther off: far traffic is one cell of a fainter dark, a bee within a few metres of the lens two or
// three with a glint of wing. There is no other scale. The map (SpeckMap, sims/specks.ts) carries, with
// each cell's code, the depth of what it draws (BEES_DEPTH_STEP bytes per metre) so the shader can
// hide an insect behind the wall, a tree or a hive. Where two insects fall in one cell the nearer one
// is drawn, whichever was plotted first: the shader sees one depth per cell, so a farther insect
// hidden behind a hive must not take the cell of a nearer one flying in front of it.
//
// Bees (a small state machine each, stepped at a fixed 1/60 s):
//   inside   in the hive, waiting its turn;
//   mill     at the entrance: walking on the landing board or hovering before the slot, a small crowd;
//   orient   a young bee's orientation flight: slow loops in front of its hive, learning the place;
//   out      a forager's nearly straight, slightly wobbly beeline to a flower patch (now and then via a
//            pass close to the lens);
//   forage   hopping zig-zag from flower to flower in the patch, resting a moment on each, loading up
//            with pollen;
//   home     the beeline back to the landing board;
//   land     alighting on the board for a moment, then in or among the crowd.
// Butterflies: an erratic, lazy flutter above the flowers with bursts of wingbeats and glides, bobbing
// on every beat, now and then settling on a flower where the wings slowly open and close.
// Bumblebees: big, slow and low, lurching from plant to plant, working the bells of the foxgloves up
// and down the spike (following the spike as the wind sways it) and the lavender, now and then a
// poppy or the cosmos. Hoverflies: dead still in the air over a drift, then a dart too quick to
// follow, still again, now and then down onto a flower. Dragonflies: fast straight runs along the path
// and over the garden that turn sharply at the end of each, a hover or a rest on a foxglove's tip
// between beats, the wings catching the light.
//
// The swarm (BEES_SWARM_TRIGGER, or now and then by itself while the `swarm` knob is on, on a dry day):
// BEES_SWARM_BEES bees of one hive pour out of its entrance over SWARM_POUR seconds, mill in a loose
// ball a few metres across over the garden, each on a loop of its own through it, and drift onto a
// limb of one of the two big apple trees in the middle of the orchard (SWARM_TREES, the BEES_TREES the
// shader draws), where they settle as a cluster hanging in the lower crown, a few scouts flying out
// and back. After a while the cluster breaks up into the ball again, which lifts off and leaves the
// frame. It is stepped on the sim's own steps from the press's motion-clock stamp
// (`SimFrame.motionTriggers`) and drawn from a stream seeded by that moment, so a seed and a stamp
// play the same swarm at any frame rate. Each of its specks stands for a knot of bees, drawn as a bee
// twice its size, and a cell where three or more fall is the honey-brown mass of the cluster
// (BEES_CODE.swarm).
//
// The world's hours and weather. The sim reads the world clock (world-clock.ts: timeOfDay and skyState
// from the `time` and `cycle` knobs, at each step's moment) and the `rain` and `snow` knobs where the
// scene has them. The hives close at dusk and in rain or snow: foragers come home, the crowd at the
// entrances files in and nobody comes out until it is light and dry again. Butterflies settle on a
// flower with their wings shut from the golden hour on and in the wet, and the other insects leave the
// frame. Fireflies rise from the grass once the sky is dark, each at its own darkness, drifting slowly
// and blinking a slow yellow-green, and sink back as the night lifts; by day there are none. In a dry
// afternoon none of it applies and the colony's random draws are unchanged.
//
// A thing is drawn in the cell its projection falls in, and only changes cell once it has clearly left
// it (hysteresis, followCell), so a hovering bee never flickers between two. It is drawn between its
// last two steps by the clock's alpha, so the traffic moves as smoothly at 144 Hz as at 60.
//
// Randomness. The colony and the butterflies share one stream, as they always have; every other kind
// and the swarm draw from streams of their own, so what else is about never moves a bee.
//
// Passage (BEES_PASSAGE). An entrance skips the pre-run: the colony starts asleep and nearly every bee
// comes out of its hive within the first two seconds and flies at once for its flowers (a little hurried,
// easing to the usual pace), while the butterflies fly in over the edges of the screen. An exit sends the
// foragers home at speed, files the crowd at the entrances in, keeps everyone inside and has the
// butterflies and the other insects bolt for the nearest edge. At rest none of it applies and the random
// draws are unchanged.
//
// Texture:
//   uSim0  rg8, one texel per dither cell (rows bottom to top, the shader's `cell`): R a BEES_CODE value
//          (0 nothing), G the depth of what is drawn there in BEES_DEPTH_STEP-ths of a metre.
import { KnobReader, type ParamDef } from "../../params.ts";
import { LevelCamera } from "../../sims/camera.ts";
import { FixedStep } from "../../sims/clock.ts";
import { clamp, glslHash22, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { followCell, SpeckMap } from "../../sims/specks.ts";
import { DataTexture } from "../../sims/texture.ts";
import { skyState, timeOfDay } from "../../world-clock.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

const TAU = Math.PI * 2;

/** Horizon of the garden plane (uv height), the eye's height above it (m) and the narrowest stage half width. */
export const BEES_YH = 0.47;
export const BEES_CAM = 1.6;
export const BEES_STAGE_MIN = 0.62;
export const BEES_MAX_BEES = 200;
export const BEES_MAX_BUTTERFLIES = 6;
export const BEES_MAX_BUMBLEBEES = 6;
export const BEES_MAX_HOVERFLIES = 10;
export const BEES_MAX_DRAGONFLIES = 3;
export const BEES_MAX_FIREFLIES = 48;
/** Bees in a swarm. */
export const BEES_SWARM_BEES = 360;
/** Trigger slot of the swarm's "now" button (the shooting stars have slot 0, lightning 1). */
export const BEES_SWARM_TRIGGER = 2;
/** Bytes of depth per metre in the map's second channel. */
export const BEES_DEPTH_STEP = 4;
/** The garden's eye: everything flies in the world and is drawn where this projects it. */
const CAMERA = new LevelCamera({ horizon: BEES_YH, eye: BEES_CAM, focal: 1 });

/** Seconds the scene's entrance and its exit take (SceneDef.passage; the shader reads the same). */
export const BEES_PASSAGE = { enter: 2.8, exit: 1.6 } as const;

/** Half the width of the stage, screen heights: fractions `f` below are of this. */
export function beesStage(aspect: number): number {
  return Math.max(0.5 * aspect, BEES_STAGE_MIN);
}

/** A box hive on its stand, metres: stand height, one box, boxes, roof, width, slot height, board thickness. */
export const BEES_HIVE = {
  stand: 0.3,
  box: 0.3,
  boxes: 2,
  roof: 0.1,
  width: 0.52,
  slot: 0.04,
  board: 0.02,
} as const;
/** Half the landing board's width, metres. */
export const BEES_BOARD_HALF = 0.17;
/** Hives are built this many times larger than the metres above, so the entrances read. */
export const BEES_HIVE_SCALE = 1.5;

export interface BeesHive {
  /** x as a fraction of the stage half width, and the y of the hive's feet (uv). */
  f: number;
  y: number;
}

/** The three hives, left to right: white, powder blue and butter yellow, the M on the middle one. */
export const BEES_HIVES: readonly BeesHive[] = [
  { f: -0.3, y: 0.32 },
  { f: -0.09, y: 0.298 },
  { f: 0.14, y: 0.33 },
];

/**
 * Foxgloves in the foreground: x (fraction of the stage), the y of their feet, height (m), and the
 * `flowers` value they stand from (all at 1; thinned away below it, by 0 every one gone).
 */
export const BEES_FOXGLOVES: readonly (readonly [number, number, number, number])[] = [
  [-0.92, 0.035, 1.2, 0.35],
  [-0.8, 0.075, 1.0, 0.6],
  [0.83, 0.04, 1.15, 0.45],
  [0.93, 0.09, 1.0, 0.75],
  [0.5, 0.28, 1.0, 0.25],
  [0.45, 0.3, 0.9, 0.5],
];

/** The orchard, far to near: x (fraction of the stage), the y of the trunk's foot, size, seed. */
export const BEES_TREES: readonly (readonly [number, number, number, number])[] = [
  [-0.74, 0.389, 0.65, 3.1],
  [0.62, 0.388, 0.75, 19.4],
  [-0.22, 0.385, 1.0, 7.7],
  [0.2, 0.383, 0.85, 12.3],
];

/** Kinds of flower patch (shader.ts paints each; the bees only care where they are). */
export const BEES_LAVENDER = 0;
export const BEES_POPPY = 1;
export const BEES_DAISY = 2;
export const BEES_WILD = 3;
export const BEES_COSMOS = 4;
/** Apple blossom in the orchard's crowns, and a meadow on the hill beyond the wall: flowers the foragers fly up to (the shader paints them as part of the trees and the hill). */
export const BEES_BLOSSOM = 5;
export const BEES_HILL = 6;

export interface BeesPatch {
  f: number;
  y: number;
  /** Radii: a fraction of the stage half width, and uv height. */
  rx: number;
  ry: number;
  kind: number;
  /** How often a forager (or butterfly, for the first BEES_GROUND_PATCHES) picks it. */
  weight: number;
  /** Height of the flower heads above the ground (m) for a drift on the ground. */
  top: number;
  /**
   * For flowers in the air (a crown, a hill): the uv y of the ground they stand over, which sets their
   * depth; the ellipse's y is then where they are on screen, and their height follows from the two.
   */
  footY?: number;
}

/** The first this many patches are drifts on the garden's ground; butterflies keep to them. */
export const BEES_GROUND_PATCHES = 5;

export const BEES_PATCHES: readonly BeesPatch[] = [
  { f: -0.62, y: 0.17, rx: 0.32, ry: 0.1, kind: BEES_LAVENDER, weight: 0.3, top: 0.32 },
  { f: 0.6, y: 0.15, rx: 0.32, ry: 0.09, kind: BEES_POPPY, weight: 0.2, top: 0.5 },
  { f: 0.0, y: 0.095, rx: 0.26, ry: 0.06, kind: BEES_DAISY, weight: 0.12, top: 0.3 },
  { f: -0.55, y: 0.348, rx: 0.4, ry: 0.022, kind: BEES_WILD, weight: 0.06, top: 0.3 },
  { f: 0.72, y: 0.285, rx: 0.22, ry: 0.05, kind: BEES_COSMOS, weight: 0.08, top: 0.6 },
  { f: -0.22, y: 0.56, rx: 0.12, ry: 0.045, kind: BEES_BLOSSOM, weight: 0.1, top: 0, footY: 0.378 },
  { f: 0.2, y: 0.54, rx: 0.1, ry: 0.04, kind: BEES_BLOSSOM, weight: 0.08, top: 0, footY: 0.378 },
  { f: 0.45, y: 0.47, rx: 0.3, ry: 0.025, kind: BEES_HILL, weight: 0.08, top: 0, footY: 0.4 },
];

/** What a texel of uSim0's red channel means (the byte value; 0 is nothing). */
export const BEES_CODE = {
  bee: 1,
  beeWing: 2,
  beeLoaded: 3,
  butterflyBody: 4,
  orange: 5,
  white: 6,
  blue: 7,
  orangeDim: 8,
  whiteDim: 9,
  blueDim: 10,
  /** A bee a little farther off, and one far off: a fainter dark. */
  beeDim: 11,
  beeFaint: 12,
  /** Three or more of a swarm's specks in one cell: the honey-brown mass of a cluster of bees. */
  swarm: 13,
  /** A bumblebee's black fur, and its yellow band (close by). */
  bumblebee: 14,
  bumblebeeBand: 15,
  /** A hoverfly, amber and black. */
  hoverfly: 16,
  /** A dragonfly's blue body, and its wing catching the light. */
  dragonfly: 17,
  dragonflyWing: 18,
  /** A firefly's flash, and its glow (round a near flash, and the flash fading). */
  firefly: 19,
  fireflyGlow: 20,
} as const;

const BUTTERFLY_OPEN = [BEES_CODE.orange, BEES_CODE.white, BEES_CODE.blue] as const;
const BUTTERFLY_SHUT = [BEES_CODE.orangeDim, BEES_CODE.whiteDim, BEES_CODE.blueDim] as const;

const STEP = 1 / 60;
const MAX_STEPS = 6;
/** Seconds pre-run so the page opens with the colony at work. */
const WARM_STEPS = 30 * 60;
/**
 * The colony's first this many bees take their opening state from the colony's stream, as when it
 * held no more, so a colony of up to this many opens as it always has; the rest from a stream of
 * their own.
 */
const BEES_FIRST = 64;

// Sizes (m).
const BEE_LENGTH = 0.015;
const BUTTERFLY_SPAN = 0.05;
const BUMBLEBEE_LENGTH = 0.022;
const HOVERFLY_LENGTH = 0.011;
const DRAGONFLY_LENGTH = 0.075;
const DRAGONFLY_SPAN = 0.1;

// Bees (m and m/s). Speeds are scaled by depth (see `pace`) so on screen they read the same near and far.
const CRUISE = 0.9;
const HOP = 0.55;
const MILL_SPEED = 0.15;
const ARRIVE = 0.07;
const ORIENT_RATE = 0.85;
/** Share of foragers that fly a pass close to the lens on their way out, and where (m). */
const PASS_SHARE = 0.12;
const PASS_Z_MIN = 1.8;
const PASS_Z_MAX = 3.2;

// Butterflies.
const BUTTERFLY_SPEED = 0.45;
const BUTTERFLY_GLIDE_SPEED = 0.2;

// Bumblebees, hoverflies, dragonflies (m/s, m).
const BUMBLEBEE_SPEED = 0.5;
const BUMBLEBEE_HOP = 0.32;
/** The drifts a bumblebee works besides the foxgloves: lavender, poppies, cosmos (patch indices). */
const BUMBLEBEE_DRIFTS = [0, 1, 4] as const;
const HOVERFLY_DART = 3.2;
/** Farthest a hoverfly darts in one go. */
const HOVERFLY_REACH = 1.4;
const DRAGONFLY_SPEED = 4.5;

// Fireflies.
/** Seconds a firefly takes to rise from the grass, or sink back (a time constant). */
const FIREFLY_RISE = 2.5;
const FIREFLY_SPEED = 0.22;

// The world's hours: daylight (skyState's `day`) below which the hives close and above which they
// open again, and the butterflies' roost the same way; the space between keeps a dusk from flickering.
const HIVES_SHUT = 0.2;
const HIVES_OPEN = 0.3;
const ROOST_FROM = 0.4;
const ROOST_UNTIL = 0.5;

// The swarm: its course in seconds from the start (pouring out until SWARM_POUR, the ball onto the
// branch from SWARM_SETTLE, everyone hanging by SWARM_HANG, off the branch from SWARM_LIFT, away from
// SWARM_LEAVE, gone by SWARM_END at the latest), its ball's radius, how fast it leaves (m/s, reached
// over SWARM_RAMP s) and the gaps between swarms that come by themselves.
const SWARM_POUR = 12;
const SWARM_SETTLE = 46;
const SWARM_HANG = 66;
const SWARM_LIFT = 140;
const SWARM_LEAVE = 148;
const SWARM_END = 220;
const SWARM_RADIUS = 1.3;
const SWARM_GO = 3.2;
const SWARM_RAMP = 6;
const SWARM_FIRST = [25, 75] as const;
const SWARM_GAP = [150, 330] as const;
/**
 * The trees a swarm hangs in: the two big apple trees in the middle of the orchard, whose crowns
 * stand clear of the hives' roofs (BEES_TREES indices).
 */
const SWARM_TREES = [2, 3] as const;
/**
 * Where the cluster hangs on its tree, in the tree's units (shader.ts beesTree, metres × its size):
 * part way out along one of the two limbs from the fork, under it, in the lower crown.
 */
const SWARM_LIMB = 0.6;
const SWARM_BRANCH = 2.55;
/** How far in front of the crown it hangs (m), so the shader draws it over the leaves it hangs from. */
const SWARM_FRONT = 0.4;
/** The cluster's half width, depth and half length (m): it hangs from the branch, widest at the top. */
const CLUSTER = { x: 0.15, z: 0.1, h: 0.24 } as const;
/** Where a swarm bee is: in the hive, flying, hanging in the cluster, gone from the frame. */
const SWARM_HIVE = 0;
const SWARM_FLYING = 1;
const SWARM_HUNG = 2;
const SWARM_GONE = 3;

type WeatherKnob = "rain" | "snow" | "wind";
const WEATHER_KNOBS: readonly WeatherKnob[] = ["rain", "snow", "wind"];
type BeesKnob =
  | "bees"
  | "butterflies"
  | "swarm"
  | "bumblebees"
  | "hoverflies"
  | "dragonflies"
  | "fireflies"
  | "time"
  | "cycle"
  | WeatherKnob;

export class BeesSimError extends Error {}

/** What every insect the map draws has: where it is (m), where it was a step ago, and its drawn cell (NaN: not yet placed). */
interface Flier {
  x: number;
  z: number;
  h: number;
  px: number;
  pz: number;
  ph: number;
  cx: number;
  cy: number;
}

/** A flier that moves by its velocity toward a target. */
interface Moving extends Flier {
  vx: number;
  vz: number;
  vh: number;
  tx: number;
  tz: number;
  th: number;
}

/** A flier that steers as a bee does (`#steer`): seconds into its leg and alive, its weave's phase and its own pace. */
interface Steered extends Moving {
  t: number;
  age: number;
  phase: number;
  pace: number;
}

type BeeMode = "inside" | "mill" | "orient" | "out" | "forage" | "home" | "land";

interface Bee extends Steered {
  hive: number;
  mode: BeeMode;
  /** Seconds left in this mode (where it has a length), and seconds since it began. */
  hold: number;
  patch: number;
  visits: number;
  load: number;
  newbie: boolean;
  resting: boolean;
  fly: boolean;
  /** On its way out it first flies a pass close to the lens. */
  via: boolean;
  /** Its first time out of the hive (an entrance): straight for the flowers. */
  pour: boolean;
}

type ButterflyMode = "fly" | "approach" | "settle";

interface Butterfly extends Flier {
  active: boolean;
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

type BumblebeeMode = "fly" | "feed";

interface Bumblebee extends Steered {
  active: boolean;
  /** Leaving the frame (dusk, rain, fewer asked for, the scene's exit); inactive once out of it. */
  off: boolean;
  mode: BumblebeeMode;
  hold: number;
  /** The plant it works: a foxglove's index, or BEES_FOXGLOVES.length + a drift's place in BUMBLEBEE_DRIFTS. */
  plant: number;
  /** On a foxglove: the bell's height on the spike (a share of it), and which side of it. */
  bell: number;
  side: number;
  visits: number;
}

type HoverflyMode = "hover" | "dart" | "rest";

interface Hoverfly extends Flier {
  active: boolean;
  off: boolean;
  mode: HoverflyMode;
  /** Seconds left hovering or resting; seconds into a dart, and how long it takes. */
  hold: number;
  t: number;
  span: number;
  /** A dart sets out from (ax, az, ah) and stops dead at (tx, tz, th). */
  ax: number;
  az: number;
  ah: number;
  tx: number;
  tz: number;
  th: number;
  /** The drift it keeps to, and whether the dart ends on a flower of it. */
  patch: number;
  land: boolean;
}

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

interface Firefly extends Moving {
  active: boolean;
  /** The darkness of the night (skyState's `night`) it rises at; whether it is out, and how far up (0 in the grass .. 1 flying). */
  wake: number;
  out: boolean;
  up: number;
  /** Seconds between its flashes, and where it is in them (whole flashes since it started). */
  period: number;
  beat: number;
  wayLeft: number;
  /** The highest it drifts (m). */
  cruise: number;
}

interface SwarmBee extends Moving {
  /** SWARM_HIVE, SWARM_FLYING, SWARM_HUNG or SWARM_GONE. */
  stage: number;
  /** Seconds into the swarm it leaves the hive, settles in the cluster, and takes off from it again (after SWARM_LIFT). */
  launch: number;
  land: number;
  lift: number;
  /** Its loop through the ball: radius (a share of the ball's), rate (rad/s), start angle and the loop's plane (two unit axes). */
  r: number;
  w: number;
  a0: number;
  e1x: number;
  e1z: number;
  e1h: number;
  e2x: number;
  e2z: number;
  e2h: number;
  /** Its place in the cluster, from the branch (m). */
  sx: number;
  sz: number;
  sh: number;
  /** A scout: flies out and back while the cluster hangs. */
  scout: boolean;
}

interface Swarm {
  active: boolean;
  /** Seconds since it began. */
  age: number;
  /** The board it pours from, the middle of the garden it mills over, the branch it hangs from (m). */
  ox: number;
  oz: number;
  oh: number;
  mx: number;
  mz: number;
  mh: number;
  kx: number;
  kz: number;
  kh: number;
  /** Which way it leaves (a unit vector). */
  ex: number;
  ez: number;
  eh: number;
  /** The ball's wander phases. */
  p1: number;
  p2: number;
  p3: number;
  /** The ball's middle and radius now. */
  cx: number;
  cz: number;
  ch: number;
  radius: number;
}

function newBee(hive: number): Bee {
  return {
    hive,
    mode: "inside",
    hold: 0,
    t: 0,
    age: 0,
    x: 0,
    z: 10,
    h: 0,
    vx: 0,
    vz: 0,
    vh: 0,
    tx: 0,
    tz: 10,
    th: 0,
    patch: 0,
    visits: 0,
    load: 0,
    phase: 0,
    pace: 1,
    newbie: false,
    resting: false,
    fly: false,
    via: false,
    pour: false,
    cx: Number.NaN,
    cy: Number.NaN,
    px: 0,
    pz: 10,
    ph: 0,
  };
}

function newButterfly(kind: number): Butterfly {
  return {
    active: false,
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

/** A resting flier, nowhere yet: the fields every kind starts from. */
function moving(): Moving {
  return {
    x: 0,
    z: 8,
    h: 0,
    px: 0,
    pz: 8,
    ph: 0,
    cx: Number.NaN,
    cy: Number.NaN,
    vx: 0,
    vz: 0,
    vh: 0,
    tx: 0,
    tz: 8,
    th: 0,
  };
}

function newBumblebee(): Bumblebee {
  return {
    ...moving(),
    t: 0,
    age: 0,
    phase: 0,
    pace: 1,
    active: false,
    off: false,
    mode: "fly",
    hold: 0,
    plant: 0,
    bell: 0.6,
    side: 1,
    visits: 0,
  };
}

function newHoverfly(): Hoverfly {
  const { x, z, h, px, pz, ph, cx, cy } = moving();
  return {
    x,
    z,
    h,
    px,
    pz,
    ph,
    cx,
    cy,
    active: false,
    off: false,
    mode: "hover",
    hold: 0,
    t: 0,
    span: 1,
    ax: 0,
    az: 8,
    ah: 0,
    tx: 0,
    tz: 8,
    th: 0,
    patch: 0,
    land: false,
  };
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

function newFirefly(): Firefly {
  return {
    ...moving(),
    active: false,
    wake: 0,
    out: false,
    up: 0,
    period: 6,
    beat: 0,
    wayLeft: 0,
    cruise: 1,
  };
}

function newSwarmBee(): SwarmBee {
  return {
    ...moving(),
    stage: SWARM_HIVE,
    launch: 0,
    land: 0,
    lift: 0,
    r: 0,
    w: 0,
    a0: 0,
    e1x: 1,
    e1z: 0,
    e1h: 0,
    e2x: 0,
    e2z: 0,
    e2h: 1,
    sx: 0,
    sz: 0,
    sh: 0,
    scout: false,
  };
}

/** Draw a flier from where it is now, as if it had been there a step ago too. */
function settle(thing: Flier): void {
  thing.px = thing.x;
  thing.pz = thing.z;
  thing.ph = thing.h;
}

/** How fast a thing at depth z moves, as a share of its nominal speed: the same on screen near and far. */
function depthPace(z: number): number {
  return clamp(z / 8, 0.45, 1.3);
}

/** The map's depth byte for a thing at depth z (m). */
function depthByte(z: number): number {
  return Math.min(255, Math.round(z * BEES_DEPTH_STEP));
}

/**
 * Ease `b`'s velocity toward (tx, tz, th) at up to `top` m/s, slowing over its last `tau` seconds,
 * by the share `k` of a step, then move it a step. Returns the distance it had left.
 */
function chase(
  b: Moving,
  tx: number,
  tz: number,
  th: number,
  tau: number,
  top: number,
  k: number,
  dt: number,
): number {
  const dx = tx - b.x;
  const dz = tz - b.z;
  const dh = th - b.h;
  const dist = Math.hypot(dx, dz, dh) + 1e-6;
  const go = Math.min(top, dist / tau);
  b.vx += ((dx / dist) * go - b.vx) * k;
  b.vz += ((dz / dist) * go - b.vz) * k;
  b.vh += ((dh / dist) * go - b.vh) * k;
  b.x += b.vx * dt;
  b.z += b.vz * dt;
  b.h = Math.max(0, b.h + b.vh * dt);
  return dist;
}

/** A firefly's light, 0..1: a quick rise, a moment lit and a slower fade at the start of each of its periods, once it is up. */
function fireflyLight(f: Firefly): number {
  const since = (f.beat - Math.floor(f.beat)) * f.period;
  if (since >= 1.1) return 0;
  return (
    smoothstep(0, 0.15, since) * (1 - smoothstep(0.45, 1.1, since)) * smoothstep(0.4, 0.8, f.up)
  );
}

const PATCH_WEIGHTS: readonly number[] = BEES_PATCHES.map((patch) => patch.weight);
const PATCH_WEIGHT_TOTAL = PATCH_WEIGHTS.reduce((sum, w) => sum + w, 0);
const GROUND_WEIGHT_TOTAL = PATCH_WEIGHTS.slice(0, BEES_GROUND_PATCHES).reduce(
  (sum, w) => sum + w,
  0,
);

class BeesSim implements SceneSim {
  readonly #knobs: KnobReader<BeesKnob>;
  /** The weather knobs the scene has (the rest read 0). */
  readonly #weather: readonly WeatherKnob[];
  readonly #swarmSlot: number;
  readonly #texture: DataTexture;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #random = new Random(0x5eed);
  /** The opening state of the bees beyond BEES_FIRST. */
  readonly #reserve = new Random(0x5eed64);
  readonly #bumbleRandom = new Random(0xb0b);
  readonly #hoverRandom = new Random(0x40f);
  readonly #dragonRandom = new Random(0xd7a);
  readonly #fireflyRandom = new Random(0xf1e);
  /** The swarm's own draws (re-seeded for each swarm), and the waits between swarms that come by themselves. */
  readonly #swarmRandom = new Random(0);
  readonly #swarmClock = new Random(0x5a4);
  readonly #bees: Bee[] = Array.from({ length: BEES_MAX_BEES }, (_, i) =>
    newBee(i % BEES_HIVES.length),
  );
  readonly #butterflies: Butterfly[] = Array.from({ length: BEES_MAX_BUTTERFLIES }, (_, i) =>
    newButterfly(i % 3),
  );
  readonly #bumblebees: Bumblebee[] = Array.from({ length: BEES_MAX_BUMBLEBEES }, newBumblebee);
  readonly #hoverflies: Hoverfly[] = Array.from({ length: BEES_MAX_HOVERFLIES }, newHoverfly);
  readonly #dragonflies: Dragonfly[] = Array.from({ length: BEES_MAX_DRAGONFLIES }, newDragonfly);
  readonly #fireflies: Firefly[] = Array.from({ length: BEES_MAX_FIREFLIES }, newFirefly);
  readonly #swarmBees: SwarmBee[] = Array.from({ length: BEES_SWARM_BEES }, newSwarmBee);
  readonly #swarm: Swarm = {
    active: false,
    age: 0,
    ox: 0,
    oz: 0,
    oh: 0,
    mx: 0,
    mz: 0,
    mh: 0,
    kx: 0,
    kz: 0,
    kh: 0,
    ex: 0,
    ez: 0,
    eh: 1,
    p1: 0,
    p2: 0,
    p3: 0,
    cx: 0,
    cz: 0,
    ch: 0,
    radius: 0,
  };
  /** The swarm's specks of a frame, sorted by cell then depth: cell × 256 + depth byte. */
  readonly #swarmKeys = new Float64Array(BEES_SWARM_BEES);
  /** The hive last asked about: world position of its entrance, its landing board and how wide it is. */
  readonly #geo = { x: 0, z: 0, landZ: 0, landH: 0, half: 0 };
  readonly #pt = { x: 0, z: 0, h: 0 };
  readonly #pc = { ex: 0, ey: 0 };
  /** Where the last thing projected is drawn from (m), `alpha` of the way through its step. */
  readonly #at = { x: 0, z: 0, h: 0 };
  readonly #hash = new Float64Array(2);
  /** The branches a swarm may hang from, in view (SWARM_TREES place × 2 + side). */
  readonly #branches = new Int8Array(SWARM_TREES.length * 2);
  readonly #specks = new SpeckMap();
  #stage = BEES_STAGE_MIN;
  #beeCount = 0;
  #butterflyCount = 0;
  #bumblebeeCount = 0;
  #hoverflyCount = 0;
  #dragonflyCount = 0;
  #fireflyCount = 0;
  #swarmOn = false;
  #warm = false;
  #dirty = true;
  #born = false;
  /** The sim's first frame fell inside an entrance: the colony opens asleep and pours out of the hives, the butterflies come in from the edges. */
  #arriving = false;
  /** The scene is leaving: the foragers fly home, the butterflies bolt for the edge of the frame and nobody comes out. */
  #leaving = false;
  #aspect = 1;
  /** Speed multipliers (bees on their way out and home, butterflies): 1 at rest, more while the scene arrives or leaves. */
  #rush = 1;
  #flit = 1;
  /** K_time and K_cycle; the motion clock at the step being taken (the shader's uMotionTime then). */
  #time = 0;
  #cycle = 0;
  #tm = 0;
  /** The time of day last read, and its daylight and darkness (skyState's `day` and `night`). */
  #tod = Number.NaN;
  #day = 1;
  #night = 0;
  /** Rain or snow falling (the larger amount, 0 dry), and the wind (K_wind). */
  #wet = 0;
  #wind = 0;
  /** Light enough and dry: bees may come out. */
  #open = true;
  /** Dusk, night or rain: the butterflies settle and the other day fliers stay away. */
  #roost = false;
  /** The motion-clock moment a pressed swarm starts at (NaN: none waiting), and seconds until one comes by itself (NaN: not counting). */
  #swarmAt = Number.NaN;
  #swarmWait = Number.NaN;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#weather = WEATHER_KNOBS.filter((key) => params.some((def) => def.key === key));
    this.#knobs = new KnobReader<BeesKnob>("bees", params, [
      "bees",
      "butterflies",
      "swarm",
      "bumblebees",
      "hoverflies",
      "dragonflies",
      "fireflies",
      "time",
      "cycle",
      ...this.#weather,
    ]);
    this.#swarmSlot = this.#knobs.trigger("swarm");
    this.#texture = new DataTexture(gl, { width: 1, height: 1, format: "rg8", filter: "nearest" });
    this.#specks.resize(1, 1);
    this.#textures = [this.#texture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    const count = (key: BeesKnob, most: number): number =>
      clamp(Math.round(knobs.value(frame, key)), 0, most);
    this.#beeCount = count("bees", BEES_MAX_BEES);
    this.#butterflyCount = count("butterflies", BEES_MAX_BUTTERFLIES);
    this.#bumblebeeCount = count("bumblebees", BEES_MAX_BUMBLEBEES);
    this.#hoverflyCount = count("hoverflies", BEES_MAX_HOVERFLIES);
    this.#dragonflyCount = count("dragonflies", BEES_MAX_DRAGONFLIES);
    this.#fireflyCount = count("fireflies", BEES_MAX_FIREFLIES);
    this.#swarmOn = knobs.value(frame, "swarm") > 0.5;
    this.#time = knobs.value(frame, "time");
    this.#cycle = knobs.value(frame, "cycle");
    this.#wet = Math.max(this.#weatherKnob(frame, "rain"), this.#weatherKnob(frame, "snow"));
    this.#wind = this.#weatherKnob(frame, "wind");
    const width = Math.max(1, Math.round(frame.width));
    const height = Math.max(1, Math.round(frame.height));
    if (width !== this.#specks.width || height !== this.#specks.height) {
      this.#specks.resize(width, height);
      this.#texture.resize(width, height);
      const lists: readonly (readonly Flier[])[] = [
        this.#bees,
        this.#butterflies,
        this.#bumblebees,
        this.#hoverflies,
        this.#dragonflies,
        this.#fireflies,
        this.#swarmBees,
      ];
      for (const list of lists)
        for (const thing of list) {
          thing.cx = Number.NaN;
          thing.cy = Number.NaN;
        }
      this.#dirty = true;
    }
    const aspect = frame.aspect > 0 ? frame.aspect : width / height;
    this.#aspect = aspect;
    this.#setStage(beesStage(aspect));
    this.#passage(frame);
    if (!this.#warm) {
      // The world as the page opens: the hives shut and the butterflies roosting from the start.
      this.#tm = frame.motionTime;
      this.#skyAt(frame.motionTime);
      this.#open = this.#wet <= 0 && this.#day >= 0.5 * (HIVES_SHUT + HIVES_OPEN);
      this.#roost = this.#wet > 0 || this.#day < 0.5 * (ROOST_FROM + ROOST_UNTIL);
    }
    this.#wake();
    if (!this.#warm) {
      // An entrance skips the pre-run: the colony is to be seen coming out of its hives.
      if (!this.#arriving) for (let i = 0; i < WARM_STEPS; i++) this.#step(STEP, false);
      this.#warm = true;
    }
    this.#arriving = false;
    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    // A "now": the swarm starts at the first step at least half a step past the press's moment on the
    // motion clock (the frame's start where the frame carries no stamps, as a press just before it would
    // have stamped). Never a step taken before the press was seen, and never a step that lands on the
    // stamp itself, which float rounding may count on either side of it at another frame rate.
    if (frame.fired[this.#swarmSlot] === true && !this.#swarm.active)
      this.#swarmAt = frame.motionTriggers?.[this.#swarmSlot] ?? frame.motionTime - advance;
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) {
      this.#tm = frame.motionTime - this.#clock.lag(i);
      this.#skyAt(this.#tm);
      this.#step(STEP, true);
    }
    // Drawn between the last two steps, so every frame that moves the clock repaints.
    if (advance > 0 || this.#dirty) {
      this.#paint(this.#clock.alpha);
      // Only the tiles whose cells changed go up (the whole map after a resize): a few KB a frame.
      this.#specks.upload(this.#texture);
      this.#dirty = false;
    }
    return this.#textures;
  }

  dispose(): void {
    this.#texture.dispose();
  }

  #weatherKnob(frame: SimFrame, key: WeatherKnob): number {
    return this.#weather.includes(key) ? this.#knobs.value(frame, key) : 0;
  }

  /** A new stage width (the frame's aspect changed): the layout widens, so every X (which scales with it) follows. */
  #setStage(stage: number): void {
    if (Math.abs(stage - this.#stage) < 1e-5) return;
    const ratio = stage / this.#stage;
    this.#stage = stage;
    for (const bee of this.#bees) {
      bee.x *= ratio;
      bee.px *= ratio;
      bee.tx *= ratio;
    }
    for (const butterfly of this.#butterflies) {
      butterfly.x *= ratio;
      butterfly.px *= ratio;
      butterfly.tx *= ratio;
    }
    for (const list of [this.#bumblebees, this.#dragonflies, this.#fireflies, this.#swarmBees])
      for (const thing of list) {
        thing.x *= ratio;
        thing.px *= ratio;
        thing.tx *= ratio;
      }
    for (const f of this.#hoverflies) {
      f.x *= ratio;
      f.px *= ratio;
      f.ax *= ratio;
      f.tx *= ratio;
    }
    const s = this.#swarm;
    s.ox *= ratio;
    s.mx *= ratio;
    s.kx *= ratio;
    s.cx *= ratio;
  }

  /** Each kind as many as its knob asks for (and the day fliers only on a dry day): newcomers appear at the edge of the frame, the rest leave. */
  #wake(): void {
    const rand = this.#random;
    for (const [i, g] of this.#butterflies.entries()) {
      const want = i < this.#butterflyCount;
      if (want && !g.active) {
        g.active = true;
        const side = rand.next() < 0.5 ? -1 : 1;
        g.z = rand.range(4.5, 10);
        // Arriving, they come in over the very edge of the screen, not of the stage.
        const edge = this.#arriving ? 0.5 * this.#aspect + 0.04 : this.#stage + 0.03;
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
      } else if (!want) {
        g.active = false;
      }
    }
    if (!this.#warm) this.#seed();
    // The page opens with them at work where they are; later ones come in from the edge.
    const first = !this.#warm;
    const day = !this.#roost && !this.#leaving;
    for (const [i, b] of this.#bumblebees.entries()) {
      const want = day && i < this.#bumblebeeCount;
      if (want && !b.active) this.#wakeBumblebee(b, first);
      else if (!want && b.active && !b.off) {
        this.#sendOff(b);
        b.mode = "fly";
        b.t = 1;
      }
    }
    for (const [i, f] of this.#hoverflies.entries()) {
      const want = day && i < this.#hoverflyCount;
      if (want && !f.active) this.#wakeHoverfly(f, first);
      else if (!want && f.active && !f.off) {
        f.off = true;
        this.#edgePoint(f.x, f.z, f.h);
        this.#dartTo(f, this.#pt.x, this.#pt.z, this.#pt.h, false);
      }
    }
    for (const [i, d] of this.#dragonflies.entries()) {
      const want = day && i < this.#dragonflyCount;
      if (want && !d.active) this.#wakeDragonfly(d, first);
      else if (!want && d.active && !d.off) {
        this.#sendOff(d);
        d.mode = "run";
        d.perch = -1;
      }
    }
    for (const [i, f] of this.#fireflies.entries()) {
      const want = i < this.#fireflyCount;
      if (want && !f.active) this.#wakeFirefly(f, first);
      else if (!want) f.active = false;
    }
  }

  /** The very first frame: bees start asleep inside at scattered times, butterflies in the air over the flowers. */
  #seed(): void {
    const rand = this.#random;
    const seedBee = (bee: Bee, from: Random): void => {
      bee.mode = "inside";
      bee.hold = from.range(0.5, 9);
      bee.newbie = from.next() < 0.14;
      bee.pace = from.range(0.9, 1.12);
      bee.phase = from.next() * TAU;
      bee.patch = this.#pickPatch(false, from);
    };
    for (const [i, bee] of this.#bees.entries())
      seedBee(bee, i < BEES_FIRST ? rand : this.#reserve);
    if (this.#arriving) {
      this.#pourOut();
      return;
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      this.#flowerPoint(this.#pickPatch(true));
      g.x = this.#pt.x;
      g.z = this.#pt.z;
      g.h = this.#pt.h + rand.range(0.3, 1.2);
      settle(g);
    }
  }

  // ---- places -------------------------------------------------------------------------------------

  #locate(hive: number): void {
    const def = BEES_HIVES[hive];
    if (def === undefined) throw new BeesSimError(`no hive ${hive}`);
    const g = this.#geo;
    g.z = CAMERA.groundDepth(BEES_YH - def.y);
    g.x = CAMERA.worldX(def.f * this.#stage, g.z);
    // The board is drawn at the hive's own depth; a bee on it stands a hair in front.
    g.landZ = g.z - 0.1;
    g.landH = (BEES_HIVE.stand + 0.004) * BEES_HIVE_SCALE;
    g.half = BEES_BOARD_HALF * BEES_HIVE_SCALE;
  }

  /** A patch by weight: any, or (for butterflies) only a drift on the ground. */
  #pickPatch(groundOnly: boolean, rand: Random = this.#random): number {
    let pick = rand.next() * (groundOnly ? GROUND_WEIGHT_TOTAL : PATCH_WEIGHT_TOTAL);
    for (const [i, w] of PATCH_WEIGHTS.entries()) {
      if (groundOnly && i >= BEES_GROUND_PATCHES) break;
      pick -= w;
      if (pick <= 0) return i;
    }
    return 0;
  }

  /** The world point at (ex, ey) in patch `index`'s ellipse (unit disc), written to #pt. */
  #patchPoint(index: number, ex: number, ey: number, rand: Random = this.#random): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    const sx = (patch.f + ex * patch.rx) * this.#stage;
    const sy = patch.y + ey * patch.ry;
    const pt = this.#pt;
    if (patch.footY === undefined) {
      // On the ground: the point is the plant's foot at screen row sy, its head a little above it.
      pt.z = CAMERA.groundDepth(BEES_YH - sy);
      pt.x = CAMERA.worldX(sx, pt.z);
      pt.h = patch.top + 0.05 + 0.12 * rand.next();
    } else {
      pt.z = CAMERA.groundDepth(BEES_YH - patch.footY);
      pt.x = CAMERA.worldX(sx, pt.z);
      pt.h = CAMERA.worldY(sy, pt.z);
    }
  }

  /** Where a world point lies in patch `index`'s ellipse (unit disc), written to #pc. */
  #patchCoords(index: number, x: number, z: number, h: number): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    const sx = CAMERA.screenX(x, z);
    const sy = CAMERA.screenY(patch.footY === undefined ? 0 : h, z);
    this.#pc.ex = (sx / this.#stage - patch.f) / patch.rx;
    this.#pc.ey = (sy - patch.y) / patch.ry;
  }

  /** A flower in patch `index`: uniform over most of its ellipse, written to #pt. */
  #flowerPoint(index: number, rand: Random = this.#random): void {
    const r = Math.sqrt(rand.next()) * 0.85;
    const a = rand.next() * TAU;
    this.#patchPoint(index, r * Math.cos(a), r * Math.sin(a), rand);
  }

  /** A flower of patch `index` a short hop (`near`..`far` m) from (x, z, h), kept inside the drift: into #pt. */
  #nearFlower(
    index: number,
    x: number,
    z: number,
    h: number,
    near: number,
    far: number,
    rand: Random,
  ): void {
    const a = rand.next() * TAU;
    const r = rand.range(near, far);
    this.#patchCoords(
      index,
      x + Math.cos(a) * r,
      z + Math.sin(a) * r,
      h + (rand.next() - 0.5) * 0.15,
    );
    let ex = this.#pc.ex;
    let ey = this.#pc.ey;
    const e = Math.hypot(ex, ey);
    if (e > 0.9) {
      ex *= 0.9 / e;
      ey *= 0.9 / e;
    }
    this.#patchPoint(index, ex, ey, rand);
  }

  /**
   * A bell `bell` of the way up foxglove `i`, on its `side` (-1, 0, 1), where the stem's lean holds it
   * at this step: shader.ts beesFoxglove's bend (K_wind, uMotionTime) in metres. Into #pt.
   */
  #bellPoint(i: number, bell: number, side: number): void {
    const fox = BEES_FOXGLOVES[i];
    if (fox === undefined) throw new BeesSimError(`no foxglove ${i}`);
    const [f, y, height] = fox;
    const z = CAMERA.groundDepth(BEES_YH - y);
    const lean =
      (0.4 + 0.8 * Math.abs(this.#wind)) * 0.05 * Math.sin(this.#tm * 0.55 + i * 2.1) +
      0.04 * Math.sin(i * 1.9);
    const pt = this.#pt;
    pt.x = CAMERA.worldX(f * this.#stage, z) + height * lean * bell * bell + side * 0.045;
    pt.z = z - 0.06;
    pt.h = bell * height;
  }

  /** The middle of shader.ts beesPath at screen row sy, screen heights from the middle of the view. */
  #pathX(sy: number): number {
    const w = this.#stage;
    return (
      w * (0.05 + 0.3 * smoothstep(0, 0.38, sy)) +
      0.05 * w * Math.sin(sy * 8 + 1) * smoothstep(0.02, 0.2, sy)
    );
  }

  /** A point just past the side of the frame nearest (x, z), a little higher than h: into #pt. */
  #edgePoint(x: number, z: number, h: number): void {
    const pt = this.#pt;
    pt.z = clamp(z * 0.8, 3, 14);
    pt.x = (x < 0 ? -1 : 1) * (0.5 * this.#aspect + 0.3) * pt.z;
    pt.h = h + 0.5;
  }

  /** Whether a point is outside the frame by `margin` screen heights. */
  #outside(x: number, z: number, h: number, margin: number): boolean {
    if (z < 0.8 || z > 80) return true;
    return (
      Math.abs(CAMERA.screenX(x, z)) > 0.5 * this.#aspect + margin ||
      CAMERA.screenY(h, z) > 1 + margin
    );
  }

  // ---- the world's hours and weather ----------------------------------------------------------------

  /** The world clock at motion time tm: the daylight and the darkness, and so whether the hives are open and the day fliers about. */
  #skyAt(tm: number): void {
    const tod = timeOfDay(this.#time, this.#cycle, tm);
    if (tod !== this.#tod) {
      const sky = skyState(tod);
      this.#tod = tod;
      this.#day = sky.day;
      this.#night = sky.night;
    }
    const wet = this.#wet > 0;
    if (this.#open ? wet || this.#day < HIVES_SHUT : !wet && this.#day > HIVES_OPEN)
      this.#open = !this.#open;
    if (this.#roost ? !wet && this.#day > ROOST_UNTIL : wet || this.#day < ROOST_FROM)
      this.#roost = !this.#roost;
  }

  // ---- the passage -------------------------------------------------------------------------------

  /** Where the scene stands in its entrance and exit: how hurried the traffic is, and the moment the exit begins. */
  #passage(frame: SimFrame): void {
    const enter = clamp(frame.passage.enter, 0, 1);
    const leave = clamp(frame.passage.exit, 0, 1);
    if (!this.#born) {
      this.#born = true;
      this.#arriving = enter < 1;
    }
    const leaving = leave > 0;
    if (leaving && !this.#leaving) this.#recall();
    this.#leaving = leaving;
    this.#rush = 1;
    this.#flit = 1;
    if (leaving) {
      this.#rush = 1 + 5 * smoothstep(0, 0.2, leave);
      this.#flit = 1 + 6 * smoothstep(0, 0.25, leave);
    } else if (enter < 1) {
      // Quick at first, easing back to their ordinary pace over the last of the entrance.
      this.#rush = 1 + 1.5 * (1 - smoothstep(0.7, 1, enter));
      this.#flit = 1 + 2 * (1 - smoothstep(0.5, 1, enter));
    }
  }

  /** An entrance opens on a colony yet to come out: nearly every bee leaves its hive within the first two seconds, young ones to loop before it. */
  #pourOut(): void {
    const rand = this.#random;
    for (const [i, bee] of this.#bees.entries()) {
      if (i >= this.#beeCount) continue;
      if (bee.newbie) {
        bee.hold = rand.range(0.6, 2.2);
      } else if (rand.next() < 0.85) {
        bee.pour = true;
        bee.hold = rand.range(0.3, 2.2);
      }
    }
  }

  /** The exit begins: foragers and young bees turn for their hive, the crowd at the entrances files in, the butterflies bolt for the nearest edge. */
  #recall(): void {
    const rand = this.#random;
    for (const bee of this.#bees) {
      if (bee.mode === "out" || bee.mode === "forage" || bee.mode === "orient") {
        this.#home(bee);
        bee.t = 1;
      } else if (bee.mode === "mill") {
        bee.hold = Math.min(bee.hold, rand.range(0.1, 0.9));
      }
    }
    const edge = 0.5 * this.#aspect + 0.4;
    for (const g of this.#butterflies) {
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

  // ---- stepping -----------------------------------------------------------------------------------

  /** One step of everything; `live` for the steps the clock owes (not the pre-run), which the swarm takes. */
  #step(dt: number, live: boolean): void {
    for (const [i, bee] of this.#bees.entries()) {
      settle(bee);
      this.#stepBee(bee, i, dt);
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      settle(g);
      this.#stepButterfly(g, dt);
    }
    for (const b of this.#bumblebees) {
      if (!b.active) continue;
      settle(b);
      this.#stepBumblebee(b, dt);
    }
    for (const f of this.#hoverflies) {
      if (!f.active) continue;
      settle(f);
      this.#stepHoverfly(f, dt);
    }
    for (const d of this.#dragonflies) {
      if (!d.active) continue;
      settle(d);
      this.#stepDragonfly(d, dt);
    }
    for (const f of this.#fireflies) {
      settle(f);
      this.#stepFirefly(f, dt);
    }
    if (live) this.#tendSwarm(dt);
  }

  /**
   * Steer toward (tx, tz, th) at `speed` m/s: eased in over the first second, slowing as it arrives,
   * with a lateral weave of velocity `weave` (and a little vertical wobble). Returns the distance left.
   */
  #steer(b: Steered, speed: number, weave: number, dt: number): number {
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const dh = b.th - b.h;
    const dist = Math.hypot(dx, dz, dh) + 1e-6;
    const ux = dx / dist;
    const uz = dz / dist;
    const uh = dh / dist;
    const pace = depthPace(b.z);
    const go =
      speed *
      pace *
      b.pace *
      (0.12 + 0.88 * smoothstep(0, 0.7, dist)) *
      (0.25 + 0.75 * smoothstep(0, 0.9, b.t));
    const far = smoothstep(0.3, 1.4, dist);
    const lateral =
      weave *
      pace *
      (0.55 * Math.sin(TAU * 0.37 * b.age + b.phase) +
        0.25 * Math.sin(TAU * 1.3 * b.age + 2 * b.phase)) *
      far;
    const wobble = 0.3 * weave * pace * Math.sin(TAU * 0.53 * b.age + 1.7 * b.phase) * far;
    const flat = Math.hypot(ux, uz) + 1e-6;
    const k = 1 - Math.exp(-dt / 0.22);
    b.vx += (ux * go - (uz / flat) * lateral - b.vx) * k;
    b.vz += (uz * go + (ux / flat) * lateral - b.vz) * k;
    b.vh += (uh * go + wobble - b.vh) * k;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h = Math.max(0, b.h + b.vh * dt);
    return dist;
  }

  #enter(b: Bee, i: number): void {
    const rand = this.#random;
    b.mode = "inside";
    b.hold = rand.range(1, 4);
    b.fly = false;
    b.load = 0;
    b.vx = 0;
    b.vz = 0;
    b.vh = 0;
    // Now and then the bee that goes in is a young one when it comes out again.
    if (i < this.#beeCount && rand.next() < 0.1) b.newbie = true;
  }

  #begin(b: Bee, mode: BeeMode, hold: number): void {
    b.mode = mode;
    b.hold = hold;
    b.t = 0;
  }

  #millTarget(b: Bee): void {
    const rand = this.#random;
    this.#locate(b.hive);
    const g = this.#geo;
    b.tx = g.x + rand.range(-1, 1) * g.half;
    const hover = rand.next() < 0.45;
    b.tz = g.landZ - (hover ? rand.range(0, 0.2) : 0);
    b.th = g.landH + (hover ? rand.range(0.03, 0.75) : 0);
    b.fly = hover;
    b.phase = rand.next() * TAU;
  }

  #depart(b: Bee): void {
    const rand = this.#random;
    if (rand.next() > 0.7) b.patch = this.#pickPatch(false);
    b.fly = true;
    b.resting = false;
    b.via = rand.next() < PASS_SHARE;
    if (b.via) {
      // A pass close to the lens: out toward the viewer, then on to the flowers.
      b.tz = rand.range(PASS_Z_MIN, PASS_Z_MAX);
      b.tx = rand.range(-0.7, 0.7) * this.#stage * b.tz;
      b.th = rand.range(0.6, 1.5);
    } else {
      this.#flowerPoint(b.patch);
      b.tx = this.#pt.x;
      b.tz = this.#pt.z;
      b.th = this.#pt.h;
    }
    this.#begin(b, "out", 0);
  }

  #home(b: Bee): void {
    const rand = this.#random;
    this.#locate(b.hive);
    const g = this.#geo;
    b.tx = g.x + rand.range(-0.8, 0.8) * g.half;
    b.tz = g.landZ;
    b.th = g.landH;
    b.fly = true;
    b.via = false;
    this.#begin(b, "home", 0);
  }

  #stepBee(b: Bee, i: number, dt: number): void {
    const rand = this.#random;
    b.age += dt;
    b.t += dt;
    switch (b.mode) {
      case "inside": {
        // Shut in at dusk, at night and in the wet: the wait resumes when it is light and dry.
        if (i >= this.#beeCount || this.#leaving || !this.#open) break;
        b.hold -= dt;
        if (b.hold > 0) break;
        this.#locate(b.hive);
        const g = this.#geo;
        b.x = g.x + rand.range(-0.7, 0.7) * g.half;
        b.z = g.landZ;
        b.h = g.landH;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        // Out of the hive: drawn from here, not from where it went in.
        settle(b);
        if (b.newbie) {
          this.#begin(b, "orient", rand.range(9, 16));
          b.fly = true;
          b.phase = rand.next() * TAU;
        } else if (b.pour) {
          b.pour = false;
          this.#depart(b);
          b.t = 0.6;
        } else if (rand.next() < 0.4) {
          this.#begin(b, "mill", rand.range(4, 10));
          this.#millTarget(b);
        } else {
          this.#depart(b);
        }
        break;
      }
      case "mill": {
        b.hold -= dt;
        this.#steerMill(b, dt);
        if (b.age % 1.7 < dt) this.#millTarget(b);
        if (b.hold <= 0) {
          if (this.#leaving || !this.#open) this.#enter(b, i);
          else if (!b.newbie && i < this.#beeCount && rand.next() < 0.6) this.#depart(b);
          else this.#enter(b, i);
        }
        break;
      }
      case "orient": {
        if (!this.#open) {
          // Dusk or rain cuts the lesson short; it is still young tomorrow.
          this.#home(b);
          break;
        }
        this.#locate(b.hive);
        const g = this.#geo;
        const a = ORIENT_RATE * b.t + b.phase;
        b.tx = g.x + 0.9 * BEES_HIVE_SCALE * Math.cos(a);
        b.tz = g.z - 0.9 + 0.7 * Math.sin(a);
        b.th = (BEES_HIVE.stand + 0.1) * BEES_HIVE_SCALE + 0.75 * (0.6 + 0.4 * Math.sin(2 * a));
        chase(b, b.tx, b.tz, b.th, 0.5, 1.4, 1 - Math.exp(-dt / 0.2), dt);
        b.hold -= dt;
        if (b.hold <= 0) {
          b.newbie = false;
          this.#home(b);
        }
        break;
      }
      case "out": {
        if (!this.#open) {
          this.#home(b);
          break;
        }
        if (this.#steer(b, CRUISE * this.#rush, 0.3, dt) < ARRIVE * (b.via ? 4 : 1)) {
          if (b.via) {
            b.via = false;
            this.#flowerPoint(b.patch);
            b.tx = this.#pt.x;
            b.tz = this.#pt.z;
            b.th = this.#pt.h;
            b.t = 0.5;
            break;
          }
          b.visits = 3 + rand.int(5);
          b.resting = true;
          b.fly = false;
          this.#begin(b, "forage", rand.range(0.6, 1.6));
        }
        break;
      }
      case "forage": {
        if (!this.#open) {
          this.#home(b);
          break;
        }
        if (b.resting) {
          b.hold -= dt;
          b.vx *= Math.exp(-dt * 6);
          b.vz *= Math.exp(-dt * 6);
          b.vh *= Math.exp(-dt * 6);
          if (b.hold > 0) break;
          if (b.visits <= 0) {
            this.#home(b);
            break;
          }
          this.#nextFlower(b);
          break;
        }
        if (this.#steer(b, HOP, 1.0, dt) < ARRIVE) {
          b.visits -= 1;
          b.load = Math.min(1, b.load + 0.22);
          b.resting = true;
          b.fly = false;
          b.hold = rand.range(0.5, 1.8);
        }
        break;
      }
      case "home": {
        if (this.#steer(b, CRUISE * this.#rush, 0.3, dt) < ARRIVE) {
          b.fly = false;
          this.#begin(b, "land", rand.range(0.5, 1.2));
        }
        break;
      }
      case "land": {
        b.hold -= dt;
        if (this.#leaving && b.hold > 0.15) b.hold = 0.15;
        const k = 1 - Math.exp(-dt * 5);
        b.x += (b.tx - b.x) * k;
        b.z += (b.tz - b.z) * k;
        b.h += (b.th - b.h) * k;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        if (b.hold <= 0) {
          if (!this.#leaving && this.#open && rand.next() < 0.65) {
            this.#begin(b, "mill", rand.range(4, 9));
            this.#millTarget(b);
            b.load = 0;
          } else {
            this.#enter(b, i);
          }
        }
        break;
      }
      default: {
        const unreachable: never = b.mode;
        throw new BeesSimError(`unknown bee mode ${String(unreachable)}`);
      }
    }
  }

  /** Walk or hover toward the mill target; returns the distance left. */
  #steerMill(b: Bee, dt: number): number {
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const dh = b.th - b.h;
    const dist = Math.hypot(dx, dz, dh) + 1e-6;
    const go = MILL_SPEED * b.pace * smoothstep(0, 0.2, dist);
    const k = 1 - Math.exp(-dt / 0.3);
    b.vx += ((dx / dist) * go - b.vx) * k;
    b.vz += ((dz / dist) * go - b.vz) * k;
    b.vh += ((dh / dist) * go - b.vh) * k;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h += b.vh * dt;
    return dist;
  }

  /** The next flower of a foraging bee: a short zig-zag hop within its patch, toward or away from the viewer as often as across. */
  #nextFlower(b: Bee): void {
    const rand = this.#random;
    this.#nearFlower(b.patch, b.x, b.z, b.h, 0.2, 0.55, rand);
    b.tx = this.#pt.x;
    b.tz = this.#pt.z;
    b.th = this.#pt.h;
    b.phase = rand.next() * TAU;
    b.resting = false;
    b.fly = true;
    b.t = 0.5;
  }

  // ---- butterflies --------------------------------------------------------------------------------

  #waypoint(g: Butterfly, mayPerch: boolean): void {
    const rand = this.#random;
    g.wayLeft = rand.range(2.5, 5);
    if (mayPerch && g.quiet <= 0 && rand.next() < 0.45) {
      this.#perch(g);
      return;
    }
    // Wander over the flowers, a metre or so above them.
    this.#flowerPoint(this.#pickPatch(true));
    g.tx = this.#pt.x + rand.range(-0.8, 0.8);
    g.tz = clamp(this.#pt.z + rand.range(-0.8, 0.8), 3, 13);
    g.th = clamp(this.#pt.h + rand.range(0.3, 1.3), 0.3, 2.4);
  }

  /** Down onto a flower of a drift. */
  #perch(g: Butterfly): void {
    g.patch = this.#pickPatch(true);
    this.#flowerPoint(g.patch);
    g.tx = this.#pt.x;
    g.tz = this.#pt.z;
    g.th = this.#pt.h;
    g.mode = "approach";
    g.gliding = false;
    g.t = 0;
  }

  /** The roost begins (one in the air makes for a flower) or ends (one settled opens its wings and is off in a while). */
  #roostTurn(g: Butterfly): void {
    g.roost = this.#roost;
    if (g.roost) {
      if (g.mode === "fly" && !this.#leaving) this.#perch(g);
    } else if (g.mode === "settle") {
      g.openStart = g.open;
      g.t = 0;
      g.hold = this.#random.range(1, 10);
    }
  }

  #stepButterfly(g: Butterfly, dt: number): void {
    g.age += dt;
    g.t += dt;
    const rand = this.#random;
    if (g.roost !== this.#roost) this.#roostTurn(g);
    if (g.mode === "settle") {
      g.vx *= Math.exp(-dt * 6);
      g.vz *= Math.exp(-dt * 6);
      g.vh *= Math.exp(-dt * 6);
      if (g.roost && !this.#leaving) {
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
      if (!this.#leaving && (dist < 0.5 || g.wayLeft <= 0)) this.#waypoint(g, true);
      speed = lerp(BUTTERFLY_SPEED, BUTTERFLY_GLIDE_SPEED, g.glide);
    } else {
      speed = 0.3 * smoothstep(0, 0.8, dist) + 0.08;
    }
    speed *= this.#flit;
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
    const k = 1 - Math.exp(-dt / (this.#leaving ? 0.3 : 0.55));
    g.vx += (ux * speed * pace - (uz / flat) * meander * pace - g.vx) * k;
    g.vz += (uz * speed * pace + (ux / flat) * meander * pace - g.vz) * k;
    g.vh += (uh * speed * pace - 0.1 * g.glide - g.vh) * k;
    // Every downstroke lifts the butterfly and every upstroke lets it fall: the bobbing flight.
    const bob = -0.8 * pace * Math.sin(g.flap) * (1 - g.glide);
    g.x += g.vx * dt;
    g.z = clamp(g.z + g.vz * dt, 2.8, 14);
    g.h = Math.max(0.2, g.h + (g.vh + bob) * dt);
    if (g.mode === "approach" && dist < ARRIVE + 0.05) {
      g.mode = "settle";
      g.t = 0;
      g.hold = rand.range(8, 15);
      g.openStart = g.open;
      g.phase = rand.next() * TAU;
    }
  }

  // ---- bumblebees, hoverflies, dragonflies ------------------------------------------------------------

  /** Head for just past the nearest side of the frame (the day is over, fewer are asked for, the scene leaves). */
  #sendOff(b: Moving & { off: boolean }): void {
    b.off = true;
    this.#edgePoint(b.x, b.z, b.h);
    b.tx = this.#pt.x;
    b.tz = this.#pt.z;
    b.th = this.#pt.h;
  }

  #wakeBumblebee(b: Bumblebee, inScene: boolean): void {
    const rand = this.#bumbleRandom;
    b.active = true;
    b.off = false;
    b.phase = rand.next() * TAU;
    b.pace = rand.range(0.85, 1.1);
    b.age = rand.next() * 10;
    b.cx = Number.NaN;
    this.#nextPlant(b);
    if (inScene) {
      // At work on its first plant.
      b.mode = "feed";
      b.hold = rand.range(0.5, 5);
      b.x = b.tx;
      b.z = b.tz;
      b.h = b.th;
    } else {
      this.#edgePoint(b.tx, b.tz, b.th);
      b.x = this.#pt.x;
      b.z = this.#pt.z;
      b.h = clamp(b.th, 0.3, 1);
      b.mode = "fly";
    }
    b.vx = 0;
    b.vz = 0;
    b.vh = 0;
    settle(b);
  }

  /** A new plant: a foxglove now and then, else the lavender, less often a poppy or the cosmos. */
  #nextPlant(b: Bumblebee): void {
    const rand = this.#bumbleRandom;
    const pick = rand.next();
    if (pick < 0.45) {
      b.plant = rand.int(BEES_FOXGLOVES.length);
      b.bell = rand.range(0.48, 0.85);
      b.side = rand.next() < 0.5 ? -1 : 1;
      b.visits = 3 + rand.int(4);
    } else {
      const drift = pick < 0.8 ? 0 : pick < 0.9 ? 1 : 2;
      b.plant = BEES_FOXGLOVES.length + drift;
      this.#flowerPoint(BUMBLEBEE_DRIFTS[drift] ?? 0, rand);
      b.tx = this.#pt.x;
      b.tz = this.#pt.z;
      b.th = this.#pt.h;
      b.visits = 2 + rand.int(4);
    }
    this.#bloomPoint(b);
    b.t = 0;
  }

  /** Where it feeds: a foxglove's bell, which moves with the spike, or the flower it picked in a drift. */
  #bloomPoint(b: Bumblebee): void {
    if (b.plant >= BEES_FOXGLOVES.length) return;
    this.#bellPoint(b.plant, b.bell, b.side);
    b.tx = this.#pt.x;
    b.tz = this.#pt.z;
    b.th = this.#pt.h;
  }

  #stepBumblebee(b: Bumblebee, dt: number): void {
    const rand = this.#bumbleRandom;
    b.age += dt;
    b.t += dt;
    if (b.off) {
      this.#steer(b, BUMBLEBEE_SPEED * 2 * this.#flit, 0.4, dt);
      if (this.#outside(b.x, b.z, b.h, 0.08)) b.active = false;
      return;
    }
    this.#bloomPoint(b);
    if (b.mode === "feed") {
      // Clinging to the bell (swaying with it) or the flower head.
      b.x = b.tx;
      b.z = b.tz;
      b.h = b.th;
      b.vx = 0;
      b.vz = 0;
      b.vh = 0;
      b.hold -= dt;
      if (b.hold > 0) return;
      b.visits -= 1;
      if (b.visits > 0) {
        // The next bell up or down the spike, or a flower close by.
        if (b.plant < BEES_FOXGLOVES.length) {
          const step = (rand.next() < 0.5 ? -1 : 1) * rand.range(0.06, 0.16);
          b.bell = clamp(b.bell + step, 0.45, 0.88);
          if (rand.next() < 0.3) b.side = -b.side;
          this.#bloomPoint(b);
        } else {
          const drift = BUMBLEBEE_DRIFTS[b.plant - BEES_FOXGLOVES.length] ?? 0;
          this.#nearFlower(drift, b.x, b.z, b.h, 0.12, 0.4, rand);
          b.tx = this.#pt.x;
          b.tz = this.#pt.z;
          b.th = this.#pt.h;
        }
        b.t = 0.5;
      } else {
        this.#nextPlant(b);
      }
      b.mode = "fly";
      return;
    }
    const hop = b.visits > 0 && b.t > 0.4 && Math.hypot(b.tx - b.x, b.tz - b.z) < 0.6;
    const dist = this.#steer(b, hop ? BUMBLEBEE_HOP : BUMBLEBEE_SPEED, 0.45, dt);
    // Heavy: a slow lurch up and down on the way.
    b.h = Math.max(
      0.03,
      b.h +
        0.06 * TAU * 1.3 * Math.cos(TAU * 1.3 * b.age + b.phase) * dt * smoothstep(0.1, 0.5, dist),
    );
    if (dist < ARRIVE) {
      b.mode = "feed";
      b.hold = b.plant < BEES_FOXGLOVES.length ? rand.range(2.5, 6) : rand.range(1.5, 4.5);
    }
  }

  #wakeHoverfly(f: Hoverfly, inScene: boolean): void {
    const rand = this.#hoverRandom;
    f.active = true;
    f.off = false;
    f.cx = Number.NaN;
    f.patch = this.#pickPatch(true, rand);
    this.#flowerPoint(f.patch, rand);
    const pt = this.#pt;
    const lift = rand.range(0.25, 0.9);
    if (inScene) {
      f.x = pt.x;
      f.z = pt.z;
      f.h = pt.h + lift;
      f.mode = "hover";
      f.hold = rand.range(0.3, 3.5);
      settle(f);
      return;
    }
    const tx = pt.x;
    const tz = pt.z;
    const th = pt.h + lift;
    this.#edgePoint(tx, tz, th);
    f.x = this.#pt.x;
    f.z = this.#pt.z;
    f.h = th;
    settle(f);
    this.#dartTo(f, tx, tz, th, false);
  }

  /** A dart from where it hangs to (tx, tz, th): fast, straight, stopping dead. */
  #dartTo(f: Hoverfly, tx: number, tz: number, th: number, land: boolean): void {
    f.ax = f.x;
    f.az = f.z;
    f.ah = f.h;
    f.tx = tx;
    f.tz = tz;
    f.th = th;
    f.land = land;
    f.mode = "dart";
    f.t = 0;
    const dist = Math.hypot(tx - f.x, tz - f.z, th - f.h);
    f.span = Math.max(0.12, dist / (HOVERFLY_DART * depthPace(f.z) * this.#flit));
  }

  #stepHoverfly(f: Hoverfly, dt: number): void {
    const rand = this.#hoverRandom;
    if (f.mode === "dart") {
      f.t += dt;
      const u = Math.min(1, f.t / f.span);
      const e = u * u * (3 - 2 * u);
      f.x = lerp(f.ax, f.tx, e);
      f.z = lerp(f.az, f.tz, e);
      f.h = lerp(f.ah, f.th, e);
      if (u < 1) return;
      if (f.off) {
        f.active = false;
        return;
      }
      f.mode = f.land ? "rest" : "hover";
      f.hold = f.land ? rand.range(1.5, 6) : rand.range(0.6, 3.5);
      return;
    }
    // Hovering or resting: dead still.
    f.hold -= dt;
    if (f.hold > 0) return;
    if (rand.next() < 0.1) f.patch = this.#pickPatch(true, rand);
    this.#flowerPoint(f.patch, rand);
    const pt = this.#pt;
    const land = f.mode === "hover" && rand.next() < 0.2;
    let tx = pt.x;
    let tz = pt.z;
    let th = land ? pt.h : pt.h + rand.range(0.25, 0.9);
    const dist = Math.hypot(tx - f.x, tz - f.z, th - f.h);
    if (!land && dist > HOVERFLY_REACH) {
      // No farther than a dart goes: on toward it next time.
      const k = HOVERFLY_REACH / dist;
      tx = f.x + (tx - f.x) * k;
      tz = f.z + (tz - f.z) * k;
      th = Math.max(0.2, f.h + (th - f.h) * k);
    }
    this.#dartTo(f, tx, tz, th, land);
  }

  #wakeDragonfly(d: Dragonfly, inScene: boolean): void {
    const rand = this.#dragonRandom;
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
      this.#edgePoint(d.tx, d.tz, d.th);
      d.x = this.#pt.x;
      d.z = this.#pt.z;
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
    const rand = this.#dragonRandom;
    for (let tries = 0; tries < 4; tries++) {
      if (rand.next() < 0.55) {
        const sy = rand.range(0.02, 0.36);
        d.tz = CAMERA.groundDepth(BEES_YH - sy);
        d.tx = CAMERA.worldX(this.#pathX(sy), d.tz) + rand.range(-0.5, 0.5);
        d.th = rand.range(0.5, 1.5);
      } else {
        this.#flowerPoint(this.#pickPatch(true, rand), rand);
        d.tz = clamp(this.#pt.z + rand.range(-1, 1), 2.5, 16);
        d.tx = this.#pt.x + rand.range(-1, 1);
        d.th = this.#pt.h + rand.range(0.4, 1.6);
      }
      if (Math.hypot(d.tx - d.x, d.tz - d.z) > 2) return;
    }
  }

  #stepDragonfly(d: Dragonfly, dt: number): void {
    const rand = this.#dragonRandom;
    d.age += dt;
    if (d.mode !== "run") {
      d.vx = 0;
      d.vz = 0;
      d.vh = 0;
      if (d.mode === "perch" && d.perch >= 0) {
        // On the spike's tip, swaying with it.
        this.#bellPoint(d.perch, 1, 0);
        d.x = this.#pt.x;
        d.z = this.#pt.z;
        d.h = this.#pt.h + 0.02;
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
      DRAGONFLY_SPEED * pace * this.#flit,
      1 - Math.exp(-dt / 0.06),
      dt,
    );
    const speed = Math.hypot(d.vx, d.vz);
    if (speed > 0.3) {
      d.hx = d.vx / speed;
      d.hz = d.vz / speed;
    }
    if (d.off) {
      if (this.#outside(d.x, d.z, d.h, 0.08)) d.active = false;
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
    } else if (rand.next() < 0.55) {
      d.mode = "hover";
      d.hold = rand.range(0.8, 2.5);
    } else {
      // Off to rest on a foxglove's tip.
      d.perch = rand.int(BEES_FOXGLOVES.length);
      this.#bellPoint(d.perch, 1, 0);
      d.tx = this.#pt.x;
      d.tz = this.#pt.z;
      d.th = this.#pt.h + 0.02;
    }
  }

  // ---- fireflies ----------------------------------------------------------------------------------

  #wakeFirefly(f: Firefly, inScene: boolean): void {
    const rand = this.#fireflyRandom;
    f.active = true;
    f.cx = Number.NaN;
    // Down in the grass anywhere in the garden, near or far.
    const sy = rand.range(0.02, 0.36);
    f.z = CAMERA.groundDepth(BEES_YH - sy);
    f.x = CAMERA.worldX(rand.range(-0.98, 0.98) * this.#stage, f.z);
    f.h = 0.02;
    // Never so low that its going-in mark (less a twentieth) is no dark at all.
    f.wake = rand.range(0.1, 0.5);
    f.period = rand.range(2.5, 5);
    f.beat = rand.next();
    f.cruise = rand.range(0.6, 2.2);
    f.wayLeft = 0;
    f.tx = f.x;
    f.tz = f.z;
    f.th = f.h;
    f.vx = 0;
    f.vz = 0;
    f.vh = 0;
    // A page that opens in the dark finds them up already.
    f.out = inScene && this.#night > f.wake;
    f.up = f.out ? 1 : 0;
    if (f.out) f.h = rand.range(0.3, f.cruise);
    settle(f);
  }

  #stepFirefly(f: Firefly, dt: number): void {
    const out = f.active && !this.#leaving && this.#night > (f.out ? f.wake - 0.05 : f.wake);
    f.out = out;
    if (!out && f.up <= 0) return;
    f.up += ((out ? 1 : 0) - f.up) * (1 - Math.exp(-dt / FIREFLY_RISE));
    if (!out && f.up < 0.01) {
      // Back down in the grass, dark until the next dusk.
      f.up = 0;
      f.h = 0.02;
      return;
    }
    const rand = this.#fireflyRandom;
    f.beat += dt / f.period;
    f.wayLeft -= dt;
    if (f.wayLeft <= 0 || Math.hypot(f.tx - f.x, f.tz - f.z) < 0.25) {
      f.wayLeft = rand.range(3, 8);
      f.tz = clamp(f.z + rand.range(-1.2, 1.2), 2.5, 16);
      const across = this.#stage * f.tz * 0.98;
      f.tx = clamp(f.x + rand.range(-1.5, 1.5), -across, across);
      f.th = rand.range(0.25, f.cruise);
    }
    const th = 0.02 + (f.th - 0.02) * f.up;
    chase(f, f.tx, f.tz, th, 1.5, FIREFLY_SPEED * depthPace(f.z), 1 - Math.exp(-dt / 1.1), dt);
  }

  // ---- the swarm ----------------------------------------------------------------------------------

  /** A swarm pressed for, or one due by itself; one at a time. */
  #tendSwarm(dt: number): void {
    const s = this.#swarm;
    if (!s.active && this.#tm >= this.#swarmAt + STEP / 2) {
      this.#beginSwarm(this.#tm - this.#swarmAt);
      this.#swarmAt = Number.NaN;
    }
    if (!this.#swarmOn) this.#swarmWait = Number.NaN;
    else if (!s.active) {
      // Now and then by itself, on a fine day.
      if (Number.isNaN(this.#swarmWait))
        this.#swarmWait = this.#swarmClock.range(SWARM_FIRST[0], SWARM_FIRST[1]);
      if (this.#open && !this.#leaving) {
        this.#swarmWait -= dt;
        if (this.#swarmWait <= 0) this.#beginSwarm(0);
      }
    }
    if (s.active) this.#stepSwarm(dt);
  }

  /** A swarm sets out, `age` seconds ago (a step or so): its hive, its branch, its path, and every bee's part in it. */
  #beginSwarm(age: number): void {
    const s = this.#swarm;
    const rand = this.#swarmRandom;
    rand.seed(Math.imul(Math.round(this.#tm / STEP) + 1, 0x9e3779b1) ^ 0x5a4e7);
    s.active = true;
    s.age = age;
    this.#locate(rand.int(BEES_HIVES.length));
    const g = this.#geo;
    s.ox = g.x;
    s.oz = g.landZ;
    s.oh = g.landH;
    this.#pickBranch(rand);
    s.kx = this.#pt.x;
    s.kz = this.#pt.z;
    s.kh = this.#pt.h;
    s.mx = lerp(s.ox, s.kx, 0.45) + rand.range(-0.8, 0.8);
    s.mz = lerp(s.oz, s.kz, 0.4) + rand.range(-0.5, 0.5);
    s.mh = rand.range(2.3, 3);
    // Away over the side its tree stands on, climbing.
    const side = s.kx < 0 ? -1 : 1;
    const ex = side * 0.75;
    const ez = rand.range(0.1, 0.35);
    const eh = 0.62;
    const e = Math.hypot(ex, ez, eh);
    s.ex = ex / e;
    s.ez = ez / e;
    s.eh = eh / e;
    s.p1 = rand.next() * TAU;
    s.p2 = rand.next() * TAU;
    s.p3 = rand.next() * TAU;
    this.#swarmCentre();
    for (const b of this.#swarmBees) {
      b.stage = SWARM_HIVE;
      // A thick stream at first, thinning out.
      b.launch = SWARM_POUR * rand.next() ** 1.6;
      b.r = Math.cbrt(rand.next());
      b.w = (rand.next() < 0.5 ? -1 : 1) * rand.range(0.9, 2.3);
      b.a0 = rand.next() * TAU;
      // Its loop's plane: a random normal and two axes across it.
      const nh = 2 * rand.next() - 1;
      const around = rand.next() * TAU;
      const flat = Math.sqrt(1 - nh * nh);
      const nx = flat * Math.cos(around);
      const nz = flat * Math.sin(around);
      // a × n with a the up axis (0, 0, 1), or across (1, 0, 0) where the normal is nearly up.
      let ax = 0;
      let ah = 1;
      if (Math.abs(nh) > 0.9) {
        ax = 1;
        ah = 0;
      }
      let e1x = -ah * nz;
      let e1z = ah * nx - ax * nh;
      let e1h = ax * nz;
      const e1 = Math.hypot(e1x, e1z, e1h);
      e1x /= e1;
      e1z /= e1;
      e1h /= e1;
      b.e1x = e1x;
      b.e1z = e1z;
      b.e1h = e1h;
      b.e2x = nz * e1h - nh * e1z;
      b.e2z = nh * e1x - nx * e1h;
      b.e2h = nx * e1z - nz * e1x;
      b.land = SWARM_SETTLE + 6 + 14 * rand.next();
      b.lift = 8 * rand.next();
      // Its place in the cluster: an egg hanging from the branch, narrowing toward its foot.
      const c = 2 * rand.next() - 1;
      const spin = rand.next() * TAU;
      const reach = Math.cbrt(rand.next());
      const across = Math.sqrt(1 - c * c) * reach;
      const taper = 0.55 + 0.45 * (c * reach + 1) * 0.5;
      b.sx = CLUSTER.x * across * Math.cos(spin) * taper;
      b.sz = CLUSTER.z * across * Math.sin(spin) * taper;
      b.sh = -CLUSTER.h + CLUSTER.h * c * reach;
      b.scout = rand.next() < 0.05;
      b.vx = 0;
      b.vz = 0;
      b.vh = 0;
      b.cx = Number.NaN;
    }
  }

  /** One of the limbs of SWARM_TREES in view to hang from (the one nearest the middle if none is): into #pt. */
  #pickBranch(rand: Random): void {
    const half = 0.5 * this.#aspect - 0.06;
    let count = 0;
    let nearest = 0;
    let nearestX = Number.POSITIVE_INFINITY;
    for (let k = 0; k < this.#branches.length; k++) {
      this.#branchPoint(k);
      const sx = Math.abs(CAMERA.screenX(this.#pt.x, this.#pt.z));
      if (sx < nearestX) {
        nearestX = sx;
        nearest = k;
      }
      if (sx <= half) this.#branches[count++] = k;
    }
    this.#branchPoint(count > 0 ? (this.#branches[rand.int(count)] ?? nearest) : nearest);
  }

  /**
   * Branch k (SWARM_TREES[k >> 1], its left limb for even k): out along the limb shader.ts beesTree
   * draws from the fork (its tip hashed from the tree's seed as the shader hashes it), under it, a
   * little in front of the leaves. Into #pt.
   */
  #branchPoint(k: number): void {
    const tree = BEES_TREES[SWARM_TREES[k >> 1] ?? 0];
    if (tree === undefined) throw new BeesSimError(`no swarm tree ${k >> 1}`);
    const [f, y, size, seed] = tree;
    const z = CAMERA.groundDepth(BEES_YH - y);
    glslHash22(seed, 2, this.#hash);
    const limb = k % 2 === 0 ? -1.4 - 0.9 * (this.#hash[0] ?? 0) : 1.5 + 0.8 * (this.#hash[1] ?? 0);
    const pt = this.#pt;
    pt.x = CAMERA.worldX(f * this.#stage, z) + SWARM_LIMB * limb * size;
    pt.z = z - SWARM_FRONT;
    pt.h = SWARM_BRANCH * size;
  }

  /** The ball's middle and radius at its age: out of the hive to the middle of the garden, milling, onto the branch, off it and away. */
  #swarmCentre(): void {
    const s = this.#swarm;
    const a = s.age;
    const go = smoothstep(0, SWARM_POUR + 6, a);
    let x = lerp(s.ox, s.mx, go) + 0.7 * Math.sin(0.29 * a + s.p1) * go;
    let z = lerp(s.oz - 0.3, s.mz, go) + 0.45 * Math.sin(0.21 * a + s.p2) * go;
    let h = lerp(s.oh + 0.5, s.mh, go) + 0.3 * Math.sin(0.37 * a + s.p3) * go;
    const onto = smoothstep(SWARM_SETTLE, SWARM_SETTLE + 14, a);
    x = lerp(x, s.kx, onto);
    z = lerp(z, s.kz, onto);
    h = lerp(h, s.kh - CLUSTER.h, onto);
    const run = Math.max(0, a - SWARM_LEAVE);
    const away =
      run < SWARM_RAMP
        ? (SWARM_GO * run * run) / (2 * SWARM_RAMP)
        : SWARM_GO * (run - SWARM_RAMP / 2);
    s.cx = x + s.ex * away;
    s.cz = z + s.ez * away;
    s.ch = h + 0.8 * smoothstep(SWARM_LIFT, SWARM_LEAVE, a) + s.eh * away;
    let radius =
      lerp(0.45, SWARM_RADIUS, smoothstep(0, 16, a)) * (1 + 0.08 * Math.sin(0.5 * a + s.p2));
    radius = lerp(radius, 0.18, onto);
    s.radius =
      lerp(radius, 1.1 * SWARM_RADIUS, smoothstep(SWARM_LIFT, SWARM_LEAVE + 4, a)) + 0.04 * run;
  }

  #stepSwarm(dt: number): void {
    const s = this.#swarm;
    s.age += dt;
    this.#swarmCentre();
    const a = s.age;
    const k = 1 - Math.exp(-dt / 0.3);
    const top = a > SWARM_LIFT ? 4.5 : 2.8;
    const half = BEES_BOARD_HALF * BEES_HIVE_SCALE * 0.8;
    let gone = 0;
    for (const b of this.#swarmBees) {
      if (b.stage === SWARM_GONE) {
        gone++;
        continue;
      }
      if (b.stage === SWARM_HIVE) {
        if (a < b.launch) continue;
        // Out of the entrance and up, into the stream.
        b.x = s.ox + half * Math.sin(b.a0);
        b.z = s.oz;
        b.h = s.oh;
        b.vx = 0.3 * Math.cos(b.a0);
        b.vz = -0.6;
        b.vh = 0.9;
        b.cx = Number.NaN;
        b.stage = SWARM_FLYING;
      }
      settle(b);
      const hangs = a >= b.land - 4 && a < SWARM_LIFT + b.lift;
      const scouting =
        b.scout && a > SWARM_HANG && a < SWARM_LIFT && Math.sin(0.5 * a + b.a0) > 0.55;
      if (b.stage === SWARM_HUNG) {
        if (!scouting && a < SWARM_LIFT + b.lift) continue;
        b.stage = SWARM_FLYING;
      }
      // Its loop through the ball (a scout's wider, round the cluster), drawn in to its place there as it settles.
      const theta = b.a0 + b.w * a;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const r = scouting ? 0.8 : b.r * s.radius;
      let tx = s.cx + r * (b.e1x * cos + b.e2x * sin);
      let tz = s.cz + r * (b.e1z * cos + b.e2z * sin);
      let th = s.ch + r * (b.e1h * cos + b.e2h * sin);
      let w = 0;
      if (hangs && !scouting) {
        w = smoothstep(b.land - 4, b.land, a);
        tx = lerp(tx, s.kx + b.sx, w);
        tz = lerp(tz, s.kz + b.sz, w);
        th = lerp(th, s.kh + b.sh, w);
      }
      const dist = chase(b, tx, tz, th, 0.35, top, k, dt);
      if (w >= 1 && dist < 0.04) {
        b.x = s.kx + b.sx;
        b.z = s.kz + b.sz;
        b.h = s.kh + b.sh;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        b.stage = SWARM_HUNG;
      } else if (a > SWARM_LEAVE && this.#outside(b.x, b.z, b.h, 0.1)) {
        b.stage = SWARM_GONE;
        gone++;
      }
    }
    if (gone === this.#swarmBees.length || a > SWARM_END) this.#endSwarm();
  }

  /** The swarm has gone: its bees are no more to be drawn, and the next one by itself is a while off. */
  #endSwarm(): void {
    this.#swarm.active = false;
    for (const b of this.#swarmBees) b.stage = SWARM_HIVE;
    this.#swarmWait = this.#swarmOn
      ? this.#swarmClock.range(SWARM_GAP[0], SWARM_GAP[1])
      : Number.NaN;
  }

  // ---- drawing into the cell map ------------------------------------------------------------------------

  /**
   * Where `t` is drawn, `alpha` of the way from its last step: its cell (hysteretic) into t.cx, t.cy,
   * its position into #at. Returns its depth (m), or 0 for a thing too near the lens to draw.
   */
  #project(t: Flier, alpha: number): number {
    const z = t.pz + (t.z - t.pz) * alpha;
    if (z < 0.8) return 0;
    const x = t.px + (t.x - t.px) * alpha;
    const lift = t.ph + (t.h - t.ph) * alpha;
    const h = this.#specks.height;
    // Its projection (the shader's own ground mapping) in cells.
    t.cx = followCell(t.cx, CAMERA.screenX(x, z) * h + 0.5 * this.#specks.width);
    t.cy = followCell(t.cy, CAMERA.screenY(lift, z) * h);
    this.#at.x = x;
    this.#at.z = z;
    this.#at.h = lift;
    return z;
  }

  /** Every insect into the cell map, `alpha` of the way from where it was a step ago to where it is. */
  #paint(alpha: number): void {
    const specks = this.#specks;
    specks.clear();
    const h = specks.height;
    for (const b of this.#bees) {
      if (b.mode === "inside") continue;
      const z = this.#project(b, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      // Its real size in cells there.
      const n = (BEE_LENGTH * h * CAMERA.focal) / z;
      if (n < 1.7) {
        specks.plot(
          b.cx,
          b.cy,
          n >= 0.8 ? BEES_CODE.bee : n >= 0.5 ? BEES_CODE.beeDim : BEES_CODE.beeFaint,
          depth,
        );
        continue;
      }
      // Close to the lens: a dark body two or three cells long (two tall when very near), golden at the back with pollen, and a glint of wing above it in flight.
      const length = n < 3.2 ? 2 : 3;
      const tall = n < 3.2 ? 1 : 2;
      specks.block(b.cx, b.cy, length, tall, BEES_CODE.bee, depth);
      if (b.load > 0.5) specks.block(b.cx + length - 1, b.cy, 1, tall, BEES_CODE.beeLoaded, depth);
      if (b.fly) specks.block(b.cx, b.cy + tall, length - 1, 1, BEES_CODE.beeWing, depth);
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      const z = this.#project(g, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      if (g.roost && g.mode === "settle" && this.#day < 0.2) {
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
    this.#paintBumblebees(alpha);
    this.#paintHoverflies(alpha);
    this.#paintDragonflies(alpha);
    this.#paintSwarm(alpha);
    this.#paintFireflies(alpha);
  }

  /** Bumblebees: a dark speck, bigger than a bee; near, a black body with its yellow band and a glint of wing in flight. */
  #paintBumblebees(alpha: number): void {
    const specks = this.#specks;
    const h = specks.height;
    for (const b of this.#bumblebees) {
      if (!b.active) continue;
      const z = this.#project(b, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      const n = (BUMBLEBEE_LENGTH * h * CAMERA.focal) / z;
      if (n < 1.7) {
        specks.plot(
          b.cx,
          b.cy,
          n >= 0.8 ? BEES_CODE.bumblebee : n >= 0.5 ? BEES_CODE.beeDim : BEES_CODE.beeFaint,
          depth,
        );
        continue;
      }
      const length = n < 3.2 ? 2 : 3;
      const tall = n < 3.2 ? 1 : 2;
      specks.block(b.cx, b.cy, length, tall, BEES_CODE.bumblebee, depth);
      specks.plot(b.cx + length - 2, b.cy + tall - 1, BEES_CODE.bumblebeeBand, depth);
      if (b.mode === "fly")
        specks.block(b.cx, b.cy + tall, length - 1, 1, BEES_CODE.beeWing, depth);
    }
  }

  /** Hoverflies: an amber speck; near, two cells with the shimmer of wing above while it hangs in the air. */
  #paintHoverflies(alpha: number): void {
    const specks = this.#specks;
    const h = specks.height;
    for (const f of this.#hoverflies) {
      if (!f.active) continue;
      const z = this.#project(f, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      const n = (HOVERFLY_LENGTH * h * CAMERA.focal) / z;
      if (n < 1.7) {
        specks.plot(f.cx, f.cy, n >= 0.5 ? BEES_CODE.hoverfly : BEES_CODE.beeFaint, depth);
        continue;
      }
      specks.block(f.cx, f.cy, 2, 1, BEES_CODE.hoverfly, depth);
      if (f.mode !== "rest") specks.plot(f.cx, f.cy + 1, BEES_CODE.beeWing, depth);
    }
  }

  /** Dragonflies: the body a line of cells along its heading as the camera sees it, the wings across it catching the light. */
  #paintDragonflies(alpha: number): void {
    const specks = this.#specks;
    const h = specks.height;
    const w = specks.width;
    const at = this.#at;
    const cell = (x: number, z: number): number => CAMERA.screenX(x, z) * h + 0.5 * w;
    const row = (lift: number, z: number): number => CAMERA.screenY(lift, z) * h;
    for (const d of this.#dragonflies) {
      if (!d.active) continue;
      const z = this.#project(d, alpha);
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
        this.#line(
          d.cx + Math.round(cell(tx - d.hz * half, tz + d.hx * half) - midX),
          d.cy + Math.round(row(at.h + 0.004, tz + d.hx * half) - midY),
          d.cx + Math.round(cell(tx + d.hz * half, tz - d.hx * half) - midX),
          d.cy + Math.round(row(at.h + 0.004, tz - d.hx * half) - midY),
          BEES_CODE.dragonflyWing,
          depth,
        );
      }
      // Head a little more than half its length ahead of the middle, the tail of the abdomen behind.
      this.#line(
        d.cx + Math.round(cell(at.x - d.hx * 0.035, at.z - d.hz * 0.035) - midX),
        d.cy + Math.round(row(at.h, at.z - d.hz * 0.035) - midY),
        d.cx + Math.round(cell(at.x + d.hx * 0.04, at.z + d.hz * 0.04) - midX),
        d.cy + Math.round(row(at.h, at.z + d.hz * 0.04) - midY),
        BEES_CODE.dragonfly,
        depth,
      );
    }
  }

  /** The cells from (x0, y0) to (x1, y1), both ends included. */
  #line(x0: number, y0: number, x1: number, y1: number, code: number, depth: number): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const u = n === 0 ? 0 : i / n;
      this.#specks.plot(
        Math.round(x0 + (x1 - x0) * u),
        Math.round(y0 + (y1 - y0) * u),
        code,
        depth,
      );
    }
  }

  /**
   * The swarm, cell by cell: a speck stands for a knot of bees, drawn as a bee twice its size; two in a
   * cell are a dark speck and three or more the mass of the cluster (BEES_CODE.swarm), at the nearest
   * one's depth.
   */
  #paintSwarm(alpha: number): void {
    if (!this.#swarm.active) return;
    const specks = this.#specks;
    const h = specks.height;
    const w = specks.width;
    const keys = this.#swarmKeys;
    let n = 0;
    for (const b of this.#swarmBees) {
      if (b.stage !== SWARM_FLYING && b.stage !== SWARM_HUNG) continue;
      const z = this.#project(b, alpha);
      if (z === 0 || b.cx < 0 || b.cx >= w || b.cy < 0 || b.cy >= h) continue;
      keys[n++] = (b.cy * w + b.cx) * 256 + depthByte(z);
    }
    keys.fill(Number.POSITIVE_INFINITY, n);
    keys.sort();
    for (let i = 0; i < n;) {
      const key = keys[i] ?? 0;
      const at = Math.floor(key / 256);
      let j = i + 1;
      while (j < n && Math.floor((keys[j] ?? 0) / 256) === at) j++;
      const depth = key - at * 256;
      const size = (2 * BEE_LENGTH * h * CAMERA.focal) / Math.max(0.8, depth / BEES_DEPTH_STEP);
      const many = j - i;
      const code =
        many >= 3
          ? BEES_CODE.swarm
          : many === 2 || size >= 0.8
            ? BEES_CODE.bee
            : size >= 0.5
              ? BEES_CODE.beeDim
              : BEES_CODE.beeFaint;
      const cy = Math.floor(at / w);
      specks.plot(at - cy * w, cy, code, depth);
      i = j;
    }
  }

  /** Fireflies: the flash a bright cell (with a glow round it close by), the glow alone as it fades. */
  #paintFireflies(alpha: number): void {
    const specks = this.#specks;
    for (const f of this.#fireflies) {
      if (f.up <= 0) continue;
      const light = fireflyLight(f);
      if (light < 0.12) continue;
      const z = this.#project(f, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      if (light <= 0.5) {
        specks.plot(f.cx, f.cy, BEES_CODE.fireflyGlow, depth);
        continue;
      }
      if (z < 8 && light > 0.75) {
        specks.plot(f.cx - 1, f.cy, BEES_CODE.fireflyGlow, depth);
        specks.plot(f.cx + 1, f.cy, BEES_CODE.fireflyGlow, depth);
        specks.plot(f.cx, f.cy - 1, BEES_CODE.fireflyGlow, depth);
        specks.plot(f.cx, f.cy + 1, BEES_CODE.fireflyGlow, depth);
      }
      specks.plot(f.cx, f.cy, BEES_CODE.firefly, depth);
    }
  }
}

/** The colony's simulation, for a scene whose `params` carry the knobs BeesKnob names (rain, snow and wind where it has them). */
export function beesSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new BeesSim(gl, params);
}
