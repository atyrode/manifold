// Fireflies that fall into step: a mangrove bank at night where every firefly is an oscillator.
//
// The model. Each firefly keeps a phase φ (in cycles) that runs at its own natural rate, a few
// percent either side of the flash-period knob, and flashes as φ wraps through 0: a smooth envelope,
// quick to rise and slow to fade. It also answers the light it sees, as Winfree's oscillators do
// (A. T. Winfree, "Biological rhythms and the behavior of populations of coupled oscillators",
// J. Theor. Biol. 16, 1967; for fireflies J. Buck, "Synchronous rhythmic flashing of fireflies II",
// Q. Rev. Biol. 63, 1988, and G. B. Ermentrout, J. Math. Biol. 29, 1991):
//     dφ/dt = ω (1 + detune) + K · light · Z(φ)
// Z, the phase response, is 0 through the firefly's own flash (refractory, so a bank flashing
// together never holds its own flashes back) and one sine over the dark rest of the cycle: a flash
// seen just after its own holds the next one back, one seen as its next nears brings it forward.
// A held-back firefly may stall but never runs backwards. The light a firefly sees is the mean
// flash of its neighbours within BOX cells (a box blur of the flash field, so it costs the same at
// any reach), plus a little of the whole bank's mean flash. Dense trees fall into step first; the
// beat spreads from them as waves that hop from crown to crown, and once the whole bank pulses
// together each pulse still sweeps out from the fastest patch, its pacemaker.
//
// One firefly per square lattice cell, FIREFLIES_CELL screen heights wide, from the waterline to
// the top of the frame and as wide as the frame, centred: columns are counted from the middle of the
// view, so a resize keeps every firefly that stays in view. Whether a cell holds one depends on the
// forest (most live in the crowns, the tall Sonneratia "firefly trees" above all) and on the density
// knob. Each crawls a little about a jittered place in its cell. A few more drift low over the river
// between us and the bank, and a few hang close to us, out of focus, in the upper corners.
//
// Disturbances: the pointer's lantern (fireflies near a light lose the beat, and right beside it
// stop flashing, as real ones do under a street lamp), a click (the lantern flares and scatters the
// phases around it), and a breeze that now and then crosses the bank, detuning every firefly it
// passes; behind it the forest falls into step again. The Manifold M: the fireflies along its
// strokes gather onto them and lock half a cycle away from the forest, so the M flashes alone in
// the dark between the pulses for a few beats, then lets go.
//
// Units: x in screen heights from the middle of the view, y in uv height (0 bottom, 1 top).
//
// Textures:
//   uSim0  rgba16f, cols × FIREFLIES_ROWS (row 0 at the waterline), linear: R, G the firefly's place
//          in its cell (0.06..0.94, read with texelFetch; R = -1: no firefly in this cell, G negative:
//          it is drawing the M); B its light (flash × its own brightness); A its soft halo, the
//          light of the 3×3 cells around it over 9 (sampled smoothly, it glows through the crowns).
//   uSim1  rgba16f, cols·FIREFLIES_PROFILE_RES × 2, linear: the far bank. Row 0: canopy top, canopy
//          underside (uv heights), crown tone 0..1, prop roots 0..1. Row 1: R trunk 0..1.
//   uSim2  rgba16f, (FIREFLIES_NEAR + 2) × 1, nearest: the lights nearer than the bank (x, y on
//          screen, distance in metres, negative for a drifter left out, flash): FIREFLIES_DRIFTERS
//          drifters, then the out-of-focus ones; then the lantern (x, y, shown, flare) and the bank
//          (mean flash, breeze front x, breeze on 0/1, M strength 0..1).
import { markVertex } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { runBudgeted } from "../../sims/clock.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

/** Lattice pitch in screen heights: one firefly per square cell (5–6 dither cells at 540 rows). */
export const FIREFLIES_CELL = 0.01;
/** The far bank's waterline, in uv height. */
export const FIREFLIES_WATER = 0.34;
/** Lattice rows, from the waterline to the top of the frame. */
export const FIREFLIES_ROWS = Math.ceil((1 - FIREFLIES_WATER) / FIREFLIES_CELL);
/** Forest profile texels per lattice column. */
export const FIREFLIES_PROFILE_RES = 4;
/**
 * Lights nearer than the bank, one uSim2 texel each: first FIREFLIES_DRIFTERS fireflies drifting
 * low over the river, then out-of-focus ones close to us (the `near` knob shows some of those).
 */
export const FIREFLIES_NEAR = 16;
export const FIREFLIES_DRIFTERS = 10;
/**
 * The camera, for the foreground fireflies: eye height above the river (m), focal length (screen
 * heights per unit of slope), the far bank's distance (m) and the aperture that blurs whatever is
 * nearer into a disc of radius APERTURE · FOCAL · (1/z − 1/BANK) screen heights.
 */
export const FIREFLIES_EYE = 1.2;
export const FIREFLIES_FOCAL = 1.2;
export const FIREFLIES_BANK = 60;
export const FIREFLIES_APERTURE = 0.15;
/** The true horizon, hidden behind the far bank: where the river would meet the sky. */
export const FIREFLIES_HORIZON = FIREFLIES_WATER + (FIREFLIES_EYE / FIREFLIES_BANK) * FIREFLIES_FOCAL;
/** uSim2 texels: the foreground fireflies, then the lantern and the bank. */
export const FIREFLIES_STATE_LANTERN = FIREFLIES_NEAR;
export const FIREFLIES_STATE_BANK = FIREFLIES_NEAR + 1;
const STATE_TEXELS = FIREFLIES_NEAR + 2;

const TAU = Math.PI * 2;
/** Widest frame aspect the lattice grows for; wider frames repeat the edge columns. */
const MAX_COLS = 2 * Math.ceil(2.6 / FIREFLIES_CELL);

// The flash.
/** Seconds a flash lasts, rise and fade, and the share of it spent rising. */
const FLASH_SECONDS = 0.85;
const FLASH_RISE = 0.22;
/** A flash never takes more than this share of the period (short periods squeeze it). */
const FLASH_SHARE = 0.5;

// The rhythm and how it spreads.
/** Natural rates spread this far either side of the period knob (roughly a normal spread's 2σ). */
const RATE_SPREAD = 0.05;
/** A few stubborn fireflies hardly answer and keep their own time, flashing alone between pulses. */
const STUBBORN_SHARE = 0.012;
const STUBBORN_PULL = 0.08;
const STUBBORN_SPREAD = 0.2;
/**
 * Phase response (cycles/s at full light) at coupling 1: to the neighbours, and to the whole bank.
 * At the default coupling (0.5) and the lab's default motion (0.6) the bank visibly falls into
 * step within about 10 s and pulses as one by about 20–25 s.
 */
const COUPLING_LOCAL = 1.65;
const COUPLING_GLOBAL = 0.63;
/** Neighbourhood radius in cells: a firefly sees the flashes within a (2·BOX + 1)² square. */
const BOX = 3;
/** A sparse neighbourhood's light is averaged over at least this many fireflies, so loners answer less. */
const COUNT_FLOOR = 7;
/** Seconds over which a firefly arrives or leaves when the density knob or the M asks it to. */
const PRESENCE_EASE = 0.8;
/** Longest simulated step (s); a frame takes as many as it needs. */
const MAX_STEP = 0.05;
/**
 * Seconds of rhythm simulated before the first frame (the forest starts out of step either way), in
 * whole steps: the swarm holds still until they are done, so the opening picture never depends on
 * the machine. The budget only caps how long one frame may block; a slow machine spreads the steps
 * over a few frames.
 */
const PREWARM_SECONDS = 2;
const PREWARM_STEPS = Math.round(PREWARM_SECONDS / MAX_STEP);
const PREWARM_BUDGET_MS = 90;
/**
 * How far a firefly wanders about its place, in cells, at drift 1, and its angular speeds (rad/s):
 * a slow crawl over the leaves, so the colour of a lit glow (set by where a cell lies in it) holds
 * through a flash.
 */
const WANDER = 0.42;
const WANDER_SLOW = 0.03;
const WANDER_FAST = 0.1;

// Where they live.
/**
 * Habitat (0..1) in the open air above the trees, among the prop roots along the waterline, and
 * just above a crown: most fireflies are in the crowns, so a pulse lights the trees from within.
 */
const SKY_HABITAT = 0.002;
const GAP_HABITAT = 0.2;
const RIM_HABITAT = 0.15;
const RIM_REACH = 0.025;
/** A firefly's brightness (it also feeds its soft halo): most are modest, a few blaze. */
const BRIGHT_MIN = 0.55;
const BRIGHT_RANGE = 0.8;
const BRIGHT_SKEW = 2.5;
/** Brightness of the fireflies drawing the M. */
const MARK_BRIGHT = 1.1;
/**
 * Between its flashes the M's fireflies keep a faint steady glow (as Photuris do), this share of a
 * flash, so its shape reads all through the episode; it rises and fades with the M itself.
 */
const MARK_EMBER = 0.25;

// The forest.
/** Half the world width the forest is grown over (screen heights): frames up to aspect 5.2. */
const FOREST_HALF = 2.6;
/** The bank's root gap: the canopy never comes lower than this above the water. */
const GAP_MIN = 0.016;
/** Half width of a Sonneratia trunk (screen heights). */
const TRUNK_HALF = 0.0055;

// The lantern.
/** Spring that the hanging lantern follows the pointer with (rad/s) and its damping ratio. */
const LANTERN_SPRING = 9;
const LANTERN_DAMPING = 0.55;
/** Seconds the lantern takes to appear or go out. */
const LANTERN_FADE = 0.35;
/** Reach (screen heights) of its light: inside it fireflies lose the beat; inside HUSH they go dark. */
const LANTERN_REACH = 0.16;
const LANTERN_HUSH = 0.055;
/** Detuning at the lantern, as a share of the natural rate. */
const LANTERN_SCATTER = 0.9;
/** A click: reach (screen heights), the flare's fade (s) and how far phases scatter (cycles). */
const CLICK_REACH = 0.2;
const FLARE_FADE = 0.5;
const CLICK_SCATTER = 1;

// The breeze.
/** Front speed (screen heights/s), half width (screen heights), detuning at its middle. */
const BREEZE_SPEED = 0.22;
const BREEZE_WIDTH = 0.12;
const BREEZE_SCATTER = 3.2;
/** How far it pushes the fireflies downwind (cells). */
const BREEZE_SWAY = 0.3;
/** Seconds between breezes at frequency 0 and 1 (±30%). */
const BREEZE_RARE = 240;
const BREEZE_OFTEN = 50;

// The Manifold M.
/** Height (screen heights), preferred centre x and centre y of the M. */
const MARK_HEIGHT = 0.22;
const MARK_X = 0.32;
const MARK_Y = 0.62;
/** Half width of its strokes, in cells: the fireflies within it draw the M. */
const MARK_STROKE = 1.15;
/** Share of the way onto its stroke a firefly of the M gathers: the rest keeps it a swarm, not a line. */
const MARK_GATHER = 0.8;
/** How hard the M's fireflies are held to their phase (cycles/s), and how it follows the forest. */
const MARK_PULL = 2.4;
const MARK_FOLLOW = 0.6;
/** Gathering and letting go, in periods. */
const MARK_RISE = 1.2;
const MARK_RELEASE = 1.6;
/**
 * When it is on: seconds of swarm time (scene seconds × motion) before the first M, soon after
 * loading or switching it on, and between them.
 */
const MARK_FIRST = 3;
const MARK_INTERVAL = 60;

// The lights nearer than the bank.
/**
 * Drifters: distances (m), heights above the water (m) and how far they wander (m, and as a share
 * of their distance); they keep low over the river, between us and the bank.
 */
const DRIFT_Z_MIN = 14;
const DRIFT_Z_MAX = 40;
const DRIFT_Y_MIN = 0.25;
const DRIFT_Y_MAX = 1.4;
const DRIFT_WANDER_X = 1;
const DRIFT_WANDER_Y = 0.25;
const DRIFT_WANDER_Z = 0.1;
/** Drifters on show at density 1 / DRIFT_DENSITY and above; fewer below. */
const DRIFT_DENSITY = 1.5;
/**
 * Out-of-focus fireflies close by: distances (m), where they hang on screen (uv height, and the
 * share of the half width out from the middle: they keep to the sides and the upper half), and how
 * far they wander (m, and as a share of their distance).
 */
const BOKEH_Z_MIN = 3.2;
const BOKEH_Z_MAX = 7;
const BOKEH_Y_MIN = 0.52;
const BOKEH_Y_MAX = 0.92;
const BOKEH_SIDE_MIN = 0.55;
const BOKEH_SIDE_MAX = 0.94;
const BOKEH_WANDER_X = 0.25;
const BOKEH_WANDER_Y = 0.15;
const BOKEH_WANDER_Z = 0.1;
/** Their phase response to the bank's mean flash at coupling 1. */
const NEAR_COUPLING = 0.8;

// ---- Passage (entrance and exit) ----
//
// Arriving, the bank is dark and the fireflies come in tree by tree: a few blink out of step in the
// first trees, more join crown after crown (each tree at its own time, the sweep running from the
// right edge, the way the camera drifts, each crown filling up firefly by firefly), and while they
// join the neighbours answer one another harder, so the clusters begin to fall into step. The camera
// settles in the shader. Leaving, the beat is lost (every firefly detunes, the coupling lets go) and
// the crowns go dark tree by tree. At rest every gate is exactly open and none of this runs.

/** Seconds the scene's entrance and exit take (its `passage`). */
export const FIREFLIES_PASSAGE = { enter: 2.8, exit: 1.5 };
/**
 * A crown's firefly opens between these shares of the entrance: ENTER_START plus ENTER_SPAN times
 * its tree's turn (0 first, 1 last), plus up to ENTER_LATE for the firefly itself; the opening is
 * ENTER_RAMP wide. A tree's turn is TREE_RANDOM luck, the rest its place from the right edge.
 */
const ENTER_START = 0.04;
const ENTER_SPAN = 0.46;
const ENTER_LATE = 0.14;
const ENTER_RAMP = 0.1;
const TREE_RANDOM = 0.55;
/** Leaving: the same, with the trees' turns reversed (the last in is the first out). */
const EXIT_START = 0.04;
const EXIT_SPAN = 0.44;
const EXIT_LATE = 0.12;
const EXIT_RAMP = 0.12;
/** Seconds over which a firefly arrives or leaves while the scene does (shorter than PRESENCE_EASE). */
const PASSAGE_EASE = 0.35;
/** Extra coupling while they join (a share of the usual, at its height around the middle of the entrance). */
const ENTER_BOOST = 2.5;
/** Leaving: how far the rates scatter (a share of the natural rate) as the beat is lost. */
const EXIT_DETUNE = 1.6;
/** The lights nearer than the bank join and leave at their own times, as shares of the passage. */
const NEAR_IN_FROM = 0.25;
const NEAR_IN_SPAN = 0.4;
const NEAR_IN_RAMP = 0.12;
const NEAR_OUT_FROM = 0.05;
const NEAR_OUT_SPAN = 0.5;
const NEAR_OUT_RAMP = 0.2;

type KnobKey = "coupling" | "density" | "period" | "drift" | "unrest" | "lantern" | "mark" | "seed";

interface Knobs {
  coupling: number;
  density: number;
  period: number;
  drift: number;
  /** Breeze frequency 0..1; 0 while the breeze is off. */
  unrest: number;
  lantern: boolean;
  /** Beats the M holds; 0 while it is off. */
  mark: number;
  /** Beats a triggered M holds (the feature's amount, even while it is off). */
  markNow: number;
  seed: number;
}

/** One rounded clump of a crown, and the tree it belongs to. */
interface Lump {
  x: number;
  y: number;
  r: number;
  tree: number;
}

interface Tree {
  x: number;
  /** Height of the crown's underside above which the leaves begin (uv). */
  base: number;
  /** How much the fireflies like it, 0..1. */
  host: number;
  shade: number;
  roots: number;
  trunk: boolean;
}

/** The flash envelope at u = time since the flash began over its length: 0 outside 0..1. */
function flash(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  if (u < FLASH_RISE) return smoothstep(0, FLASH_RISE, u);
  // A smooth fall, raised to 1.5 so it drops quickly from the peak and lingers as an afterglow.
  const fall = 1 - smoothstep(FLASH_RISE, 1, u);
  return fall * Math.sqrt(fall);
}

/** A stable number 0..1 for a lattice cell (world column, row) and a salt: survives resizes. */
function cellHash(column: number, row: number, salt: number): number {
  let h = Math.imul(column | 0, 0x27d4eb2d) ^ Math.imul((row | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The nearest point of the Manifold M (mark units) to (x, y): written to out, distance returned. */
function markNearest(x: number, y: number, out: Float64Array): number {
  let best = Infinity;
  for (let s = 0; s < 4; s++) {
    const a = markVertex(s);
    const c = markVertex(s + 1);
    const ax = a[0];
    const ay = a[1];
    const bx = c[0] - ax;
    const by = c[1] - ay;
    const t = Math.min(1, Math.max(0, ((x - ax) * bx + (y - ay) * by) / (bx * bx + by * by)));
    const px = ax + bx * t;
    const py = ay + by * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best) {
      best = d;
      out[0] = px;
      out[1] = py;
    }
  }
  return best;
}

/**
 * The far bank, left to right: Rhizophora mangroves, broad rounded crowns standing on arching prop
 * roots and packed into a wall, and now and then a tall Sonneratia, the trees the fireflies gather
 * in, with a bare trunk under a higher, ragged crown. Each crown is a cluster of round clumps,
 * taller in the middle; a gap now and then shows the low mud bank.
 */
function growForest(seed: number): { lumps: Lump[]; trees: Tree[] } {
  const rand = mulberry32((Math.imul(seed + 1, 0x9e3779b1) ^ 0x6f1e5a3) >>> 0);
  const lumps: Lump[] = [];
  const trees: Tree[] = [];
  let x = -FOREST_HALF - 0.15;
  while (x < FOREST_HALF + 0.15) {
    const grand = rand() < 0.17;
    const width = grand ? 0.2 + 0.14 * rand() : 0.09 + 0.1 * rand();
    const height = grand ? 0.21 + 0.14 * rand() : 0.09 + 0.12 * rand();
    const base = FIREFLIES_WATER + (grand ? 0.05 + 0.04 * rand() : 0.022 + 0.026 * rand());
    const tree = trees.length;
    const centre = x + width * 0.5;
    trees.push({ x: centre, base, host: grand ? 0.95 + 0.05 * rand() : 0.35 + 0.5 * rand(), shade: rand(), roots: grand ? 0.35 : 1, trunk: grand });
    const count = grand ? 7 + Math.floor(4 * rand()) : 4 + Math.floor(3 * rand());
    for (let k = 0; k < count; k++) {
      const u = k / (count - 1) - 0.5;
      const r = width * (grand ? 0.15 + 0.12 * rand() : 0.22 + 0.13 * rand());
      const dome = 1 - 0.55 * (2 * u) * (2 * u);
      // Sonneratia crowns are tiered and ragged; mangroves are one smooth dome.
      const tier = grand ? (rand() - 0.5) * height * 0.45 : (rand() - 0.5) * height * 0.12;
      const lx = centre + u * width * 0.8 + (rand() - 0.5) * width * 0.15;
      const ly = base + height * dome - r * 0.9 + tier;
      lumps.push({ x: lx, y: Math.max(ly, base + r * 0.25), r, tree });
    }
    const gap = rand() < 0.1;
    x += gap ? width + 0.02 + 0.06 * rand() : width * (0.5 + 0.3 * rand());
  }
  return { lumps, trees };
}

/** The low mud bank and nipa where no tree stands: height above the waterline (screen heights). */
function lowBank(x: number, seed: number): number {
  const s = (seed % 97) * 0.37;
  return 0.011 + 0.004 * Math.sin(x * 37 + s) + 0.002 * Math.sin(x * 91 + 2.3 * s);
}

class FirefliesSim implements SceneSim {
  readonly #swarmTexture: DataTexture;
  readonly #forestTexture: DataTexture;
  readonly #stateTexture: DataTexture;
  readonly #state = new Float32Array(4 * STATE_TEXELS);
  readonly #reader: KnobReader<KnobKey>;
  /** The trigger slots of the breeze's and the M's "now". */
  readonly #breezeSlot: number;
  readonly #markSlot: number;
  readonly #textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined];
  /** One prewarm step, as runBudgeted calls it. */
  readonly #warmStep = (): void => this.#step(MAX_STEP, this.#knobs);
  #warmed = 0;
  readonly #knobs: Knobs = { coupling: 0.5, density: 0.7, period: 3, drift: 0.35, unrest: 0, lantern: true, mark: 0, markNow: 5, seed: 0 };
  readonly #nearest = new Float64Array(2);

  // The forest, grown once per seed.
  #seed = -1;
  #lumps: Lump[] = [];
  #trees: Tree[] = [];
  /** The canopy's top, underside and how much the fireflies like it, per profile texel. */
  #top = new Float32Array(1);
  #under = new Float32Array(1);
  #host = new Float32Array(1);

  // The lattice: cols × FIREFLIES_ROWS cells, row-major from the waterline up.
  #cols = 0;
  #n = 0;
  #aspect = 16 / 9;
  // Fixed per cell (from its world column, row and the seed).
  #rank = new Float32Array(0);
  #rate = new Float32Array(0);
  #pull = new Float32Array(0);
  #scatter = new Float32Array(0);
  #jitterX = new Float32Array(0);
  #jitterY = new Float32Array(0);
  #wanderPhase = new Float32Array(0);
  #wanderSpeed = new Float32Array(0);
  #habitat = new Float32Array(0);
  #bright = new Float32Array(0);
  // The passage: each cell's own lateness (0..1), its column's turn and the tree under each profile texel.
  #late = new Float32Array(0);
  #arrival = new Float32Array(0);
  #treeAt = new Int32Array(0);
  // The M: how much each cell belongs to it, and the place on its strokes it gathers to.
  #member = new Float32Array(0);
  #snapX = new Float32Array(0);
  #snapY = new Float32Array(0);
  // Dynamic.
  #phase = new Float32Array(0);
  #present = new Float32Array(0);
  // Per step: what the lantern and breeze do to each cell, the flash field and the light seen.
  #calm = new Float32Array(0);
  #detune = new Float32Array(0);
  #hush = new Float32Array(0);
  #glowIn = new Float32Array(0);
  #presIn = new Float32Array(0);
  #rowSum = new Float32Array(0);
  #sum = new Float32Array(0);
  #count = new Float32Array(0);
  #data = new Float32Array(0);
  // Per frame: each firefly's light, and its 3×3 sum, the soft halo the shader samples.
  #halo = new Float32Array(0);
  #haloSum = new Float32Array(0);

  /** The swarm's own clock: scene seconds times motion. */
  #clock = 0;
  #dirty = true;
  #meanFlash = 0;
  /** The bank's mean phase (cycles) and how much in step it is (0..1): the Kuramoto order parameter. */
  #theta = 0;
  #sync = 0;
  /** How far the scene has come in (0..1, 1 at rest) and gone out (0 at rest). */
  #arrive = 1;
  #leave = 0;

  // The foreground fireflies: anchors (share of the frame width, height m, distance m), wander, rhythm.
  readonly #nearAnchorX = new Float64Array(FIREFLIES_NEAR);
  readonly #nearAnchorY = new Float64Array(FIREFLIES_NEAR);
  readonly #nearAnchorZ = new Float64Array(FIREFLIES_NEAR);
  readonly #nearWander = new Float64Array(FIREFLIES_NEAR * 6);
  readonly #nearRate = new Float64Array(FIREFLIES_NEAR);
  readonly #nearPhase = new Float64Array(FIREFLIES_NEAR);
  readonly #nearX = new Float64Array(FIREFLIES_NEAR);
  readonly #nearY = new Float64Array(FIREFLIES_NEAR);

  // The lantern (screen heights from the middle, uv height) and its swing.
  #lanternX = 0;
  #lanternY = 0.5;
  #lanternVX = 0;
  #lanternVY = 0;
  #lanternShown = 0;
  #flare = 0;
  #clicks = 0;
  #scatterAt: { x: number; y: number } | undefined;

  // The breeze.
  #breeze = false;
  #breezeFront = 0;
  #breezeDir = 1;
  #gusts = 0;
  #nextBreeze = Number.POSITIVE_INFINITY;
  #breezeNow = false;

  // The M.
  #mark = false;
  #markAge = 0;
  #markBeats = 5;
  #markStrength = 0;
  #markPsi = 0;
  #nextMark = Number.POSITIVE_INFINITY;
  #markWasOn = false;
  #markNow = false;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#reader = new KnobReader("fireflies", params, ["coupling", "density", "period", "drift", "unrest", "lantern", "mark", "seed"]);
    this.#breezeSlot = this.#reader.trigger("unrest");
    this.#markSlot = this.#reader.trigger("mark");
    this.#swarmTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f" });
    this.#forestTexture = new DataTexture(gl, { width: 1, height: 2, format: "rgba16f" });
    this.#stateTexture = new DataTexture(gl, { width: STATE_TEXELS, height: 1, format: "rgba16f", filter: "nearest" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#read(frame);
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#arrive = clamp(frame.passage.enter, 0, 1);
    this.#leave = clamp(frame.passage.exit, 0, 1);
    const dt = Math.max(0, frame.dt);
    if (knobs.seed !== this.#seed) this.#grow(knobs);
    else this.#fit(knobs);
    // The opening seconds run in whole steps (a few frames of them on a slow machine) before the
    // swarm moves on its own.
    if (this.#warmed < PREWARM_STEPS) this.#warmed = runBudgeted(this.#warmStep, PREWARM_BUDGET_MS, PREWARM_STEPS, this.#warmed);
    this.#watchTriggers(frame.fired, knobs);
    if (this.#warmed >= PREWARM_STEPS) {
      this.#schedule(knobs);
      this.#steerLantern(frame.pointer, knobs, dt);

      // Motion runs the swarm; a breeze or an M under way still plays while motion is 0.
      const busy = this.#breeze || this.#mark || this.#arrive < 1 || this.#leave > 0;
      const advance = dt * (frame.motion > 0 ? frame.motion : busy ? 1 : 0);
      let left = advance;
      while (left > 1e-6) {
        const h = Math.min(MAX_STEP, left);
        this.#step(h, knobs);
        left -= h;
      }
      if (this.#scatterAt) this.#scatterPhases(this.#scatterAt.x, this.#scatterAt.y);
      this.#scatterAt = undefined;
    }

    if (dt > 0 || this.#dirty) {
      this.#pack(knobs);
      this.#swarmTexture.upload(this.#data);
      this.#packState(knobs);
      this.#stateTexture.upload(this.#state);
      this.#dirty = false;
    }
    this.#textures[0] = this.#swarmTexture.texture;
    this.#textures[1] = this.#forestTexture.texture;
    this.#textures[2] = this.#stateTexture.texture;
    return this.#textures;
  }

  dispose(): void {
    this.#swarmTexture.dispose();
    this.#forestTexture.dispose();
    this.#stateTexture.dispose();
  }

  #read(frame: SimFrame): Knobs {
    const reader = this.#reader;
    const knobs = this.#knobs;
    knobs.coupling = reader.value(frame, "coupling");
    knobs.density = reader.value(frame, "density");
    knobs.period = Math.max(0.5, reader.value(frame, "period"));
    knobs.drift = reader.value(frame, "drift");
    knobs.unrest = reader.value(frame, "unrest");
    knobs.lantern = reader.value(frame, "lantern") > 0.5;
    knobs.mark = Math.round(reader.value(frame, "mark"));
    knobs.markNow = Math.max(1, Math.round(reader.amount(frame, "mark")));
    knobs.seed = Math.round(reader.value(frame, "seed"));
    return knobs;
  }

  /** A "now" button stamps its slot with the scene clock: `fired` is true for the one frame after. */
  #watchTriggers(fired: readonly boolean[], knobs: Knobs): void {
    if (fired[this.#breezeSlot] === true) this.#breezeNow = true;
    if (fired[this.#markSlot] === true) {
      this.#markNow = true;
      this.#markBeats = knobs.markNow;
    }
  }

  /** Start the breeze and the M when they are due or asked for. */
  #schedule(knobs: Knobs): void {
    const clock = this.#clock;
    if (knobs.unrest <= 0) this.#nextBreeze = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.#nextBreeze)) this.#nextBreeze = clock + this.#breezeInterval(knobs.unrest);
    if (this.#breezeNow || (!this.#breeze && !this.#mark && clock >= this.#nextBreeze)) {
      this.#breezeNow = false;
      this.#startBreeze();
      this.#nextBreeze = knobs.unrest > 0 ? clock + this.#breezeInterval(knobs.unrest) : Number.POSITIVE_INFINITY;
    }

    const on = knobs.mark > 0;
    if (on && !this.#markWasOn) this.#nextMark = clock + MARK_FIRST;
    if (!on) this.#nextMark = Number.POSITIVE_INFINITY;
    this.#markWasOn = on;
    if (this.#markNow || (!this.#mark && !this.#breeze && clock >= this.#nextMark)) {
      if (!this.#markNow) this.#markBeats = knobs.mark;
      this.#markNow = false;
      this.#startMark();
      this.#nextMark = on ? clock + MARK_INTERVAL : Number.POSITIVE_INFINITY;
    }
  }

  #breezeInterval(frequency: number): number {
    const mean = BREEZE_RARE + (BREEZE_OFTEN - BREEZE_RARE) * Math.min(1, frequency);
    return mean * (0.7 + 0.6 * cellHash(this.#gusts, 7, this.#seed * 16 + 11));
  }

  #startBreeze(): void {
    this.#gusts++;
    this.#breeze = true;
    this.#breezeDir = cellHash(this.#gusts, 3, this.#seed * 16 + 12) < 0.6 ? 1 : -1;
    this.#breezeFront = -this.#breezeDir * (this.#aspect / 2 + 2.5 * BREEZE_WIDTH);
  }

  #startMark(): void {
    this.#mark = true;
    this.#markAge = 0;
    this.#measureOrder();
    this.#markPsi = this.#theta + 0.5;
    this.#placeMark();
  }

  // ---- the forest and the lattice ---------------------------------------------------------------

  /** A new seed: grow its forest and a fresh, unsynchronised swarm, and run its first seconds. */
  #grow(knobs: Knobs): void {
    this.#seed = knobs.seed;
    const forest = growForest(knobs.seed);
    this.#lumps = forest.lumps;
    this.#trees = forest.trees;
    this.#cols = 0;
    this.#fit(knobs);
    const near = mulberry32((Math.imul(knobs.seed + 7, 0x85ebca6b) ^ 0x2545f491) >>> 0);
    for (let k = 0; k < FIREFLIES_NEAR; k++) {
      if (k < FIREFLIES_DRIFTERS) {
        // Drifters: golden-ratio steps across the frame, so however many show, they spread out.
        const slot = (0.5 + k * 0.6180339887 + 0.08 * (near() - 0.5)) % 1;
        this.#nearAnchorX[k] = (slot - 0.5) * 0.92;
        this.#nearAnchorY[k] = DRIFT_Y_MIN + (DRIFT_Y_MAX - DRIFT_Y_MIN) * near();
        this.#nearAnchorZ[k] = DRIFT_Z_MIN * Math.pow(DRIFT_Z_MAX / DRIFT_Z_MIN, near());
      } else {
        // Close by and out of focus: alternately left and right, in the upper half of the frame.
        const side = (k - FIREFLIES_DRIFTERS) % 2 === 0 ? -1 : 1;
        const z = BOKEH_Z_MIN + (BOKEH_Z_MAX - BOKEH_Z_MIN) * near();
        const y = BOKEH_Y_MIN + (BOKEH_Y_MAX - BOKEH_Y_MIN) * near();
        this.#nearAnchorX[k] = 0.5 * side * (BOKEH_SIDE_MIN + (BOKEH_SIDE_MAX - BOKEH_SIDE_MIN) * near());
        this.#nearAnchorY[k] = FIREFLIES_EYE + ((y - FIREFLIES_HORIZON) * z) / FIREFLIES_FOCAL;
        this.#nearAnchorZ[k] = z;
      }
      for (let j = 0; j < 3; j++) {
        this.#nearWander[k * 6 + j] = near() * TAU;
        this.#nearWander[k * 6 + 3 + j] = 0.02 + 0.04 * near();
      }
      this.#nearRate[k] = 1 + RATE_SPREAD * (near() + near() - 1);
      this.#nearPhase[k] = near();
    }
    this.#clock = 0;
    this.#breeze = false;
    this.#mark = false;
    this.#markStrength = 0;
    this.#gusts = 0;
    this.#nextBreeze = Number.POSITIVE_INFINITY;
    this.#nextMark = Number.POSITIVE_INFINITY;
    this.#markWasOn = false;
    this.#warmed = 0;
    this.#dirty = true;
  }

  /** Fit the lattice to the frame's aspect, keeping every firefly whose column stays in view. */
  #fit(knobs: Knobs): void {
    const cols = Math.min(MAX_COLS, 2 * Math.ceil(this.#aspect / 2 / FIREFLIES_CELL + 1));
    if (cols === this.#cols) return;
    const oldCols = this.#cols;
    const oldPhase = this.#phase;
    const oldPresent = this.#present;
    const n = cols * FIREFLIES_ROWS;
    this.#cols = cols;
    this.#n = n;
    this.#rank = new Float32Array(n);
    this.#rate = new Float32Array(n);
    this.#pull = new Float32Array(n);
    this.#scatter = new Float32Array(n);
    this.#jitterX = new Float32Array(n);
    this.#jitterY = new Float32Array(n);
    this.#wanderPhase = new Float32Array(2 * n);
    this.#wanderSpeed = new Float32Array(2 * n);
    this.#habitat = new Float32Array(n);
    this.#bright = new Float32Array(n);
    this.#late = new Float32Array(n);
    this.#member = new Float32Array(n);
    this.#snapX = new Float32Array(n);
    this.#snapY = new Float32Array(n);
    this.#phase = new Float32Array(n);
    this.#present = new Float32Array(n);
    this.#calm = new Float32Array(n);
    this.#detune = new Float32Array(n);
    this.#hush = new Float32Array(n);
    this.#glowIn = new Float32Array(n);
    this.#presIn = new Float32Array(n);
    this.#rowSum = new Float32Array(n);
    this.#sum = new Float32Array(n);
    this.#count = new Float32Array(n);
    this.#data = new Float32Array(4 * n);
    this.#halo = new Float32Array(n);
    this.#haloSum = new Float32Array(n);
    this.#swarmTexture.resize(cols, FIREFLIES_ROWS);
    this.#paintForest();

    const salt = this.#seed * 16;
    const half = cols / 2;
    this.#arrival = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const tree = this.#treeAt[c * FIREFLIES_PROFILE_RES + FIREFLIES_PROFILE_RES / 2] ?? -1;
      const x = tree >= 0 ? (this.#trees[tree]?.x ?? 0) : (c + 0.5 - half) * FIREFLIES_CELL;
      const fromRight = clamp((this.#aspect / 2 - x) / this.#aspect, 0, 1);
      const luck = cellHash(tree >= 0 ? tree : c - half, 5, salt + 19);
      this.#arrival[c] = TREE_RANDOM * luck + (1 - TREE_RANDOM) * fromRight;
    }
    for (let i = 0; i < n; i++) {
      const column = (i % cols) - half;
      const row = Math.floor(i / cols);
      this.#rank[i] = cellHash(column, row, salt + 1);
      const stubborn = cellHash(column, row, salt + 3) < STUBBORN_SHARE;
      const spread = cellHash(column, row, salt + 2) + cellHash(column, row, salt + 9) - 1;
      this.#rate[i] = 1 + (stubborn ? STUBBORN_SPREAD * Math.sign(spread || 1) : RATE_SPREAD * spread);
      this.#pull[i] = stubborn ? STUBBORN_PULL : 1;
      this.#scatter[i] = 2 * cellHash(column, row, salt + 4) - 1;
      this.#jitterX[i] = 0.3 + 0.4 * cellHash(column, row, salt + 5);
      this.#jitterY[i] = 0.3 + 0.4 * cellHash(column, row, salt + 6);
      this.#wanderPhase[2 * i] = TAU * cellHash(column, row, salt + 7);
      this.#wanderPhase[2 * i + 1] = TAU * cellHash(column, row, salt + 8);
      this.#wanderSpeed[2 * i] = WANDER_SLOW + (WANDER_FAST - WANDER_SLOW) * cellHash(column, row, salt + 13);
      this.#wanderSpeed[2 * i + 1] = WANDER_SLOW + (WANDER_FAST - WANDER_SLOW) * cellHash(column, row, salt + 14);
      this.#habitat[i] = this.#habitatAt(i);
      this.#bright[i] = BRIGHT_MIN + BRIGHT_RANGE * cellHash(column, row, salt + 16) ** BRIGHT_SKEW;
      this.#late[i] = cellHash(column, row, salt + 18);
      // Columns still in view keep their firefly's rhythm; new ones arrive in their places.
      const oldColumn = column + oldCols / 2;
      if (oldCols > 0 && oldColumn >= 0 && oldColumn < oldCols) {
        const j = row * oldCols + oldColumn;
        this.#phase[i] = oldPhase[j] ?? 0;
        this.#present[i] = oldPresent[j] ?? 0;
      } else {
        this.#phase[i] = cellHash(column, row, salt + 10);
        this.#present[i] = this.#target(i, knobs.density) * this.#gate(i);
      }
    }
    if (this.#mark) this.#placeMark();
    this.#dirty = true;
  }

  /** The bank's profile over the lattice's span, uploaded as uSim1; kept per texel for habitats. */
  #paintForest(): void {
    const res = FIREFLIES_PROFILE_RES;
    const width = this.#cols * res;
    const x0 = -0.5 * this.#cols * FIREFLIES_CELL;
    const dx = FIREFLIES_CELL / res;
    const top = new Float32Array(width).fill(-1);
    const under = new Float32Array(width).fill(2);
    const host = new Float32Array(width);
    const treeAt = new Int32Array(width).fill(-1);
    const profile = new Float32Array(width * 2 * 4);
    for (const lump of this.#lumps) {
      const tree = this.#trees[lump.tree];
      if (tree === undefined) continue;
      const k0 = Math.max(0, Math.ceil((lump.x - lump.r - x0) / dx - 0.5));
      const k1 = Math.min(width - 1, Math.floor((lump.x + lump.r - x0) / dx - 0.5));
      for (let k = k0; k <= k1; k++) {
        const off = x0 + (k + 0.5) * dx - lump.x;
        const crown = lump.y + Math.sqrt(Math.max(0, lump.r * lump.r - off * off));
        if (crown > (top[k] ?? -1)) {
          top[k] = crown;
          treeAt[k] = lump.tree;
          profile[4 * k + 2] = tree.shade;
          profile[4 * k + 3] = tree.roots;
        }
        under[k] = Math.min(under[k] ?? 2, tree.base);
        host[k] = Math.max(host[k] ?? 0, tree.host);
      }
    }
    for (const tree of this.#trees) {
      if (!tree.trunk) continue;
      const k0 = Math.max(0, Math.floor((tree.x - 2 * TRUNK_HALF - x0) / dx));
      const k1 = Math.min(width - 1, Math.ceil((tree.x + 2 * TRUNK_HALF - x0) / dx));
      for (let k = k0; k <= k1; k++) {
        const off = Math.abs(x0 + (k + 0.5) * dx - tree.x);
        const at = 4 * (width + k);
        profile[at] = Math.max(profile[at] ?? 0, 1 - smoothstep(TRUNK_HALF * 0.7, TRUNK_HALF * 1.3, off));
      }
    }
    for (let k = 0; k < width; k++) {
      const low = FIREFLIES_WATER + lowBank(x0 + (k + 0.5) * dx, this.#seed);
      let t = top[k] ?? -1;
      let u = under[k] ?? 2;
      if (t < low || u > t) {
        // No crown here: the mud bank, solid to the water.
        t = Math.max(t, low);
        u = low;
        profile[4 * k + 3] = 0;
        host[k] = 0;
      } else {
        u = Math.max(u, FIREFLIES_WATER + GAP_MIN);
      }
      top[k] = t;
      under[k] = u;
      profile[4 * k] = t;
      profile[4 * k + 1] = u;
    }
    this.#top = top;
    this.#under = under;
    this.#host = host;
    this.#treeAt = treeAt;
    this.#forestTexture.resize(width, 2);
    this.#forestTexture.upload(profile);
  }

  /** How much a cell suits a firefly (0..1): the crowns' outer leaves, a few in the air and roots. */
  #habitatAt(i: number): number {
    const column = i % this.#cols;
    const row = Math.floor(i / this.#cols);
    const k = column * FIREFLIES_PROFILE_RES + FIREFLIES_PROFILE_RES / 2;
    const y = FIREFLIES_WATER + (row + 0.5) * FIREFLIES_CELL;
    const top = this.#top[k] ?? 0;
    const under = this.#under[k] ?? 0;
    const host = this.#host[k] ?? 0;
    if (y < under) return GAP_HABITAT;
    if (y <= top) return host * (1 - 0.35 * smoothstep(0.06, 0.18, top - y));
    return host * RIM_HABITAT * Math.max(0, 1 - (y - top) / RIM_REACH) + SKY_HABITAT;
  }

  /** Whether a cell holds a firefly now (0 or 1), before the M calls more in. */
  #target(i: number, density: number): number {
    return (this.#rank[i] ?? 1) < density * (this.#habitat[i] ?? 0) ? 1 : 0;
  }

  /**
   * Whether cell i's firefly has joined (1) or gone (0) with the passage: its crown's turn plus its
   * own lateness, in and out. 1 at rest.
   */
  #gate(i: number): number {
    const turn = this.#arrival[i % this.#cols] ?? 0;
    const late = this.#late[i] ?? 0;
    const inAt = ENTER_START + ENTER_SPAN * turn + ENTER_LATE * late;
    const outAt = EXIT_START + EXIT_SPAN * (1 - turn) + EXIT_LATE * late;
    return smoothstep(inAt, inAt + ENTER_RAMP, this.#arrive) * (1 - smoothstep(outAt, outAt + EXIT_RAMP, this.#leave));
  }

  /** Centre the M for this frame's aspect and work out which fireflies draw it and where. */
  #placeMark(): void {
    const markX = Math.max(0, Math.min(MARK_X, this.#aspect / 2 - MARK_HEIGHT * 0.62));
    const cols = this.#cols;
    const x0 = -0.5 * cols * FIREFLIES_CELL;
    const stroke = (MARK_STROKE * FIREFLIES_CELL) / MARK_HEIGHT;
    const nearest = this.#nearest;
    this.#member.fill(0);
    for (let row = 0; row < FIREFLIES_ROWS; row++) {
      const cy = FIREFLIES_WATER + (row + 0.5) * FIREFLIES_CELL;
      const my = (cy - MARK_Y) / MARK_HEIGHT;
      if (Math.abs(my) > 0.5 + 2 * stroke) continue;
      for (let column = 0; column < cols; column++) {
        const cx = x0 + (column + 0.5) * FIREFLIES_CELL;
        const mx = (cx - markX) / MARK_HEIGHT;
        if (Math.abs(mx) > 0.47 + 2 * stroke) continue;
        const d = markNearest(mx, my, nearest) / stroke;
        if (d >= 1.3) continue;
        const i = row * cols + column;
        this.#member[i] = 1 - smoothstep(0.7, 1.3, d);
        // Its place on the stroke, as a share of its own cell.
        const sx = markX + (nearest[0] ?? 0) * MARK_HEIGHT;
        const sy = MARK_Y + (nearest[1] ?? 0) * MARK_HEIGHT;
        this.#snapX[i] = Math.min(0.92, Math.max(0.08, (sx - x0) / FIREFLIES_CELL - column));
        this.#snapY[i] = Math.min(0.92, Math.max(0.08, (sy - FIREFLIES_WATER) / FIREFLIES_CELL - row));
      }
    }
  }

  // ---- the rhythm ------------------------------------------------------------------------------

  /** One step of h simulated seconds: disturbances, the flash field, the light seen, the phases. */
  #step(h: number, knobs: Knobs): void {
    this.#clock += h;
    this.#advanceEvents(h, knobs.period);
    this.#disturb();
    const n = this.#n;
    const span = knobs.period / Math.min(FLASH_SECONDS, FLASH_SHARE * knobs.period);
    const mark = this.#mark ? this.#markStrength : 0;
    const passing = this.#arrive < 1 || this.#leave > 0;
    const ease = 1 - Math.exp(-h / (passing ? PASSAGE_EASE : PRESENCE_EASE));
    const phase = this.#phase;
    const present = this.#present;
    const glowIn = this.#glowIn;
    const presIn = this.#presIn;
    const member = this.#member;
    const hush = this.#hush;

    // The flash field, without the M's fireflies (their light must not drag the forest).
    let glowTotal = 0;
    let presTotal = 0;
    let flashTotal = 0;
    let presAll = 0;
    for (let i = 0; i < n; i++) {
      const a = mark * (member[i] ?? 0);
      const want = Math.max(this.#target(i, knobs.density) * (passing ? this.#gate(i) : 1), a);
      const p = (present[i] ?? 0) + (want - (present[i] ?? 0)) * ease;
      present[i] = p;
      const e = p * flash((phase[i] ?? 0) * span) * (1 - (hush[i] ?? 0));
      flashTotal += e;
      const keep = 1 - a;
      glowIn[i] = e * keep;
      presIn[i] = p * keep;
      glowTotal += e * keep;
      presTotal += p * keep;
      presAll += p;
    }
    const mean = presTotal > 0 ? glowTotal / presTotal : 0;
    this.#meanFlash = presAll > 0 ? flashTotal / presAll : 0;
    this.#box(glowIn, this.#sum, BOX);
    this.#box(presIn, this.#count, BOX);

    // The phases.
    // While they join, the neighbours answer harder (1 at rest).
    const boost = 1 + ENTER_BOOST * smoothstep(0.08, 0.3, this.#arrive) * (1 - smoothstep(0.75, 1, this.#arrive));
    const kLocal = COUPLING_LOCAL * knobs.coupling * boost;
    const kGlobal = COUPLING_GLOBAL * knobs.coupling * mean * boost;
    const omega = 1 / knobs.period;
    // Refractory through its own flash: a firefly only answers in the dark part of its cycle, so a
    // bank flashing together never holds its own flashes back. Over the dark part the response is
    // one sine: held back just after the flash, brought forward as the next one nears.
    const refractory = 1 / span;
    const receptive = 1 / (1 - refractory);
    const psi = this.#markPsi;
    for (let i = 0; i < n; i++) {
      const own = glowIn[i] ?? 0;
      const ownCount = presIn[i] ?? 0;
      const light = ((this.#sum[i] ?? 0) - own) / Math.max((this.#count[i] ?? 0) - ownCount, COUNT_FLOOR);
      const a = mark * (member[i] ?? 0);
      const drive = (kLocal * light + kGlobal) * (this.#pull[i] ?? 1) * (this.#calm[i] ?? 1) * (1 - a);
      let f = phase[i] ?? 0;
      const response = f < refractory ? 0 : -Math.sin(TAU * (f - refractory) * receptive);
      let rate = omega * (this.#rate[i] ?? 1) * Math.max(0.2, 1 + (this.#detune[i] ?? 0)) + drive * response;
      if (a > 0) rate += a * MARK_PULL * Math.sin(TAU * (psi - f));
      // A held-back firefly can stall but never runs backwards through its flash.
      f += h * Math.max(0, rate);
      f -= Math.floor(f);
      phase[i] = f;
    }
    if (this.#mark) this.#measureOrder();
    this.#stepNear(h, knobs, mean);
  }

  /** The bank's mean phase and how much in step it is (the Kuramoto order parameter), without the M. */
  #measureOrder(): void {
    let re = 0;
    let im = 0;
    let total = 0;
    for (let i = 0; i < this.#n; i++) {
      const w = this.#presIn[i] ?? 0;
      if (w <= 0) continue;
      const angle = TAU * (this.#phase[i] ?? 0);
      re += w * Math.cos(angle);
      im += w * Math.sin(angle);
      total += w;
    }
    this.#sync = total > 0 ? Math.hypot(re, im) / total : 0;
    this.#theta = Math.atan2(im, re) / TAU;
  }

  /** Sum src over the (2·radius + 1)² square around every cell into dst (running sums: O(n)). */
  #box(src: Float32Array, dst: Float32Array, radius: number): void {
    const cols = this.#cols;
    const rows = FIREFLIES_ROWS;
    const tmp = this.#rowSum;
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      let acc = 0;
      for (let c = 0; c < radius && c < cols; c++) acc += src[base + c] ?? 0;
      for (let c = 0; c < cols; c++) {
        if (c + radius < cols) acc += src[base + c + radius] ?? 0;
        if (c - radius - 1 >= 0) acc -= src[base + c - radius - 1] ?? 0;
        tmp[base + c] = acc;
      }
    }
    for (let c = 0; c < cols; c++) {
      let acc = 0;
      for (let r = 0; r < radius && r < rows; r++) acc += tmp[r * cols + c] ?? 0;
      for (let r = 0; r < rows; r++) {
        if (r + radius < rows) acc += tmp[(r + radius) * cols + c] ?? 0;
        if (r - radius - 1 >= 0) acc -= tmp[(r - radius - 1) * cols + c] ?? 0;
        dst[r * cols + c] = acc;
      }
    }
  }

  /** What the lantern and the breeze do to each cell this step: calm (coupling kept), detune, hush. */
  #disturb(): void {
    this.#calm.fill(1);
    this.#detune.fill(0);
    this.#hush.fill(0);
    const cols = this.#cols;
    const x0 = -0.5 * cols * FIREFLIES_CELL;

    const shown = this.#lanternShown;
    if (shown > 0.005) {
      // Over the river the lantern's light reaches the trees it mirrors: it acts at its reflection.
      const lx = this.#lanternX;
      const ly = this.#lanternY < FIREFLIES_WATER ? 2 * FIREFLIES_WATER - this.#lanternY : this.#lanternY;
      const c0 = Math.max(0, Math.floor((lx - LANTERN_REACH - x0) / FIREFLIES_CELL));
      const c1 = Math.min(cols - 1, Math.ceil((lx + LANTERN_REACH - x0) / FIREFLIES_CELL));
      const r0 = Math.max(0, Math.floor((ly - LANTERN_REACH - FIREFLIES_WATER) / FIREFLIES_CELL));
      const r1 = Math.min(FIREFLIES_ROWS - 1, Math.ceil((ly + LANTERN_REACH - FIREFLIES_WATER) / FIREFLIES_CELL));
      for (let r = r0; r <= r1; r++) {
        const dy = FIREFLIES_WATER + (r + 0.5) * FIREFLIES_CELL - ly;
        for (let c = c0; c <= c1; c++) {
          const dx = x0 + (c + 0.5) * FIREFLIES_CELL - lx;
          const d = Math.hypot(dx, dy);
          if (d >= LANTERN_REACH) continue;
          const i = r * cols + c;
          const q = 1 - (d / LANTERN_REACH) * (d / LANTERN_REACH);
          const w = shown * q * q;
          this.#calm[i] = 1 - w;
          this.#detune[i] = LANTERN_SCATTER * w * (this.#scatter[i] ?? 0);
          this.#hush[i] = shown * (1 - smoothstep(LANTERN_HUSH * 0.4, LANTERN_HUSH, d)) * 0.9;
        }
      }
    }

    if (this.#breeze) {
      const front = this.#breezeFront;
      const reach = 2.5 * BREEZE_WIDTH;
      const c0 = Math.max(0, Math.floor((front - reach - x0) / FIREFLIES_CELL));
      const c1 = Math.min(cols - 1, Math.ceil((front + reach - x0) / FIREFLIES_CELL));
      const salt = this.#seed * 16 + 15 + this.#gusts * 131;
      const half = cols / 2;
      for (let c = c0; c <= c1; c++) {
        const u = (x0 + (c + 0.5) * FIREFLIES_CELL - front) / BREEZE_WIDTH;
        const g = Math.exp(-u * u);
        for (let r = 0; r < FIREFLIES_ROWS; r++) {
          const i = r * cols + c;
          const noise = 2 * cellHash(c - half, r, salt) - 1;
          this.#calm[i] = (this.#calm[i] ?? 1) * (1 - g);
          this.#detune[i] = (this.#detune[i] ?? 0) + BREEZE_SCATTER * g * noise;
        }
      }
    }

    if (this.#leave > 0) {
      // Leaving: every firefly drifts off its own rate and the beat stops pulling them back.
      const scatter = EXIT_DETUNE * smoothstep(0, 0.7, this.#leave);
      const calm = 1 - smoothstep(0, 0.5, this.#leave);
      for (let i = 0; i < this.#n; i++) {
        this.#detune[i] = (this.#detune[i] ?? 0) + scatter * (this.#scatter[i] ?? 0);
        this.#calm[i] = (this.#calm[i] ?? 1) * calm;
      }
    }
  }

  /** The breeze crosses the bank; the M gathers, holds its beats and lets go. */
  #advanceEvents(h: number, period: number): void {
    if (this.#breeze) {
      this.#breezeFront += this.#breezeDir * BREEZE_SPEED * h;
      const edge = this.#aspect / 2 + 2.5 * BREEZE_WIDTH;
      if (this.#breezeFront * this.#breezeDir > edge) {
        this.#breeze = false;
      }
    }
    if (this.#mark) {
      this.#markAge += h;
      const rise = MARK_RISE * period;
      const hold = rise + this.#markBeats * period;
      const end = hold + MARK_RELEASE * period;
      this.#markStrength = smoothstep(0, rise, this.#markAge) * (1 - smoothstep(hold, end, this.#markAge));
      // The M keeps half a cycle off the forest's beat, so it flashes in the dark between pulses.
      let lag = this.#theta + 0.5 - this.#markPsi;
      lag -= Math.round(lag);
      this.#markPsi += h * (1 / period + MARK_FOLLOW * this.#sync * lag);
      this.#markPsi -= Math.floor(this.#markPsi);
      if (this.#markAge >= end) {
        this.#mark = false;
        this.#markStrength = 0;
      }
    }
  }

  /** The foreground fireflies follow the bank's mean flash; the lantern unsettles them too. */
  #stepNear(h: number, knobs: Knobs, mean: number): void {
    const omega = 1 / knobs.period;
    const k = NEAR_COUPLING * knobs.coupling * mean;
    for (let j = 0; j < FIREFLIES_NEAR; j++) {
      const d = Math.hypot((this.#nearX[j] ?? 0) - this.#lanternX, (this.#nearY[j] ?? 0) - this.#lanternY);
      const w = this.#lanternShown * Math.max(0, 1 - d / LANTERN_REACH);
      let f = this.#nearPhase[j] ?? 0;
      const detune = 1 + LANTERN_SCATTER * w * (j % 2 === 0 ? 1 : -1);
      f += h * Math.max(0, omega * (this.#nearRate[j] ?? 1) * detune - k * (1 - w) * Math.sin(TAU * f));
      this.#nearPhase[j] = f - Math.floor(f);
    }
  }

  // ---- the lantern -----------------------------------------------------------------------------

  #steerLantern(pointer: PointerState, knobs: Knobs, dt: number): void {
    const on = knobs.lantern && pointer.inside;
    const x = (pointer.x - 0.5) * this.#aspect;
    const y = pointer.y;
    if (on && this.#lanternShown < 0.02) {
      // Lit where the pointer comes in, not swung across from where it went out.
      this.#lanternX = x;
      this.#lanternY = y;
      this.#lanternVX = 0;
      this.#lanternVY = 0;
    }
    if (dt > 0) {
      const w = LANTERN_SPRING;
      const steps = Math.ceil(dt / 0.02);
      const h = dt / steps;
      for (let s = 0; s < steps; s++) {
        this.#lanternVX += h * (w * w * (x - this.#lanternX) - 2 * LANTERN_DAMPING * w * this.#lanternVX);
        this.#lanternVY += h * (w * w * (y - this.#lanternY) - 2 * LANTERN_DAMPING * w * this.#lanternVY);
        this.#lanternX += h * this.#lanternVX;
        this.#lanternY += h * this.#lanternVY;
      }
      this.#lanternShown += ((on ? 1 : 0) - this.#lanternShown) * (1 - Math.exp(-dt / LANTERN_FADE));
      this.#flare *= Math.exp(-dt / FLARE_FADE);
    }
    if (on && pointer.pressed) {
      this.#flare = 1;
      this.#clicks++;
      this.#scatterAt = { x, y };
      this.#dirty = true;
    }
  }

  /** A click: the lantern flares and every phase within reach jumps by its own random amount. */
  #scatterPhases(x: number, y: number): void {
    const ly = y < FIREFLIES_WATER ? 2 * FIREFLIES_WATER - y : y;
    const cols = this.#cols;
    const x0 = -0.5 * cols * FIREFLIES_CELL;
    const half = cols / 2;
    const salt = this.#seed * 16 + 17 + this.#clicks * 977;
    const c0 = Math.max(0, Math.floor((x - CLICK_REACH - x0) / FIREFLIES_CELL));
    const c1 = Math.min(cols - 1, Math.ceil((x + CLICK_REACH - x0) / FIREFLIES_CELL));
    const r0 = Math.max(0, Math.floor((ly - CLICK_REACH - FIREFLIES_WATER) / FIREFLIES_CELL));
    const r1 = Math.min(FIREFLIES_ROWS - 1, Math.ceil((ly + CLICK_REACH - FIREFLIES_WATER) / FIREFLIES_CELL));
    for (let r = r0; r <= r1; r++) {
      const dy = FIREFLIES_WATER + (r + 0.5) * FIREFLIES_CELL - ly;
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(x0 + (c + 0.5) * FIREFLIES_CELL - x, dy) / CLICK_REACH;
        if (d >= 1) continue;
        const i = r * cols + c;
        const w = (1 - d * d) * (1 - d * d);
        const f = (this.#phase[i] ?? 0) + CLICK_SCATTER * w * (cellHash(c - half, r, salt) - 0.5);
        this.#phase[i] = f - Math.floor(f);
      }
    }
    for (let j = 0; j < FIREFLIES_NEAR; j++) {
      const d = Math.hypot((this.#nearX[j] ?? 0) - x, (this.#nearY[j] ?? 0) - y) / CLICK_REACH;
      if (d >= 1) continue;
      const f = (this.#nearPhase[j] ?? 0) + CLICK_SCATTER * (1 - d) * (cellHash(j, 99, salt) - 0.5);
      this.#nearPhase[j] = f - Math.floor(f);
    }
  }

  // ---- textures --------------------------------------------------------------------------------

  /** Every firefly's place in its cell, light and soft halo, for uSim0. */
  #pack(knobs: Knobs): void {
    const n = this.#n;
    const cols = this.#cols;
    const data = this.#data;
    const halo = this.#halo;
    const span = knobs.period / Math.min(FLASH_SECONDS, FLASH_SHARE * knobs.period);
    const wander = WANDER * knobs.drift;
    const clock = this.#clock;
    const mark = this.#mark ? this.#markStrength : 0;
    const x0 = -0.5 * cols * FIREFLIES_CELL;
    for (let i = 0; i < n; i++) {
      const at = 4 * i;
      const p = this.#present[i] ?? 0;
      if (p <= 0.002) {
        // No firefly here: R = -1 says so.
        data[at] = -1;
        data[at + 1] = 0.5;
        data[at + 2] = 0;
        halo[i] = 0;
        continue;
      }
      const a = mark * (this.#member[i] ?? 0);
      const bright = (this.#bright[i] ?? 1) + (MARK_BRIGHT - (this.#bright[i] ?? 1)) * a;
      const lit = Math.max(flash((this.#phase[i] ?? 0) * span), MARK_EMBER * a);
      const e = p * bright * lit * (1 - (this.#hush[i] ?? 0));
      let ox = (this.#jitterX[i] ?? 0.5) + wander * Math.sin(clock * (this.#wanderSpeed[2 * i] ?? 0) + (this.#wanderPhase[2 * i] ?? 0));
      let oy = (this.#jitterY[i] ?? 0.5) + wander * 0.7 * Math.sin(clock * (this.#wanderSpeed[2 * i + 1] ?? 0) + (this.#wanderPhase[2 * i + 1] ?? 0));
      if (this.#breeze) {
        const u = (x0 + ((i % cols) + 0.5) * FIREFLIES_CELL - this.#breezeFront) / BREEZE_WIDTH;
        ox += this.#breezeDir * BREEZE_SWAY * Math.exp(-u * u);
      }
      if (a > 0) {
        ox += ((this.#snapX[i] ?? 0.5) - ox) * a * MARK_GATHER;
        oy += ((this.#snapY[i] ?? 0.5) - oy) * a * MARK_GATHER;
      }
      data[at] = Math.min(0.94, Math.max(0.06, ox));
      // A firefly drawing the M is marked by its place's sign (the place is never 0).
      data[at + 1] = (a > 0.5 ? -1 : 1) * Math.min(0.94, Math.max(0.06, oy));
      data[at + 2] = e;
      halo[i] = e;
    }
    // The soft halo: each firefly's light spread over the 3×3 cells around it (the shader's linear
    // filtering rounds it off), so bright fireflies and dense crowns glow from within.
    this.#box(halo, this.#haloSum, 1);
    for (let i = 0; i < n; i++) data[4 * i + 3] = (this.#haloSum[i] ?? 0) / 9;
  }

  /** Whether foreground light j has come in with the passage (1 at rest); each at its own time. */
  #nearGate(j: number): number {
    if (this.#arrive >= 1 && this.#leave <= 0) return 1;
    const turn = (j * 0.6180339887) % 1;
    const inAt = NEAR_IN_FROM + NEAR_IN_SPAN * turn;
    const outAt = NEAR_OUT_FROM + NEAR_OUT_SPAN * (1 - turn);
    return smoothstep(inAt, inAt + NEAR_IN_RAMP, this.#arrive) * (1 - smoothstep(outAt, outAt + NEAR_OUT_RAMP, this.#leave));
  }

  /** The lights nearer than the bank, the lantern and the bank, for uSim2. */
  #packState(knobs: Knobs): void {
    const state = this.#state;
    const span = knobs.period / Math.min(FLASH_SECONDS, FLASH_SHARE * knobs.period);
    const clock = this.#clock;
    const drifters = Math.round(FIREFLIES_DRIFTERS * Math.min(1, knobs.density * DRIFT_DENSITY));
    for (let j = 0; j < FIREFLIES_NEAR; j++) {
      const drifter = j < FIREFLIES_DRIFTERS;
      const wanderX = Math.sin(clock * (this.#nearWander[j * 6 + 3] ?? 0) + (this.#nearWander[j * 6] ?? 0));
      const wanderY = Math.sin(clock * (this.#nearWander[j * 6 + 4] ?? 0) + (this.#nearWander[j * 6 + 1] ?? 0));
      const wanderZ = Math.sin(clock * (this.#nearWander[j * 6 + 5] ?? 0) + (this.#nearWander[j * 6 + 2] ?? 0));
      const z = (this.#nearAnchorZ[j] ?? 6) * (1 + (drifter ? DRIFT_WANDER_Z : BOKEH_WANDER_Z) * wanderZ);
      const height = (this.#nearAnchorY[j] ?? 1) + (drifter ? DRIFT_WANDER_Y : BOKEH_WANDER_Y) * wanderY;
      const x = (this.#nearAnchorX[j] ?? 0) * this.#aspect + ((drifter ? DRIFT_WANDER_X : BOKEH_WANDER_X) * FIREFLIES_FOCAL * wanderX) / z;
      const y = FIREFLIES_HORIZON + ((height - FIREFLIES_EYE) * FIREFLIES_FOCAL) / z;
      this.#nearX[j] = x;
      this.#nearY[j] = y;
      const d = Math.hypot(x - this.#lanternX, y - this.#lanternY);
      const hush = this.#lanternShown * (1 - smoothstep(LANTERN_HUSH * 0.4, LANTERN_HUSH, d)) * 0.9;
      state[4 * j] = x;
      state[4 * j + 1] = y;
      // A drifter the density leaves out is marked by a negative distance.
      state[4 * j + 2] = drifter && j >= drifters ? -z : z;
      state[4 * j + 3] = flash((this.#nearPhase[j] ?? 0) * span) * (1 - hush) * this.#nearGate(j);
    }
    let at = 4 * FIREFLIES_STATE_LANTERN;
    state[at] = this.#lanternX;
    state[at + 1] = this.#lanternY;
    state[at + 2] = this.#lanternShown;
    state[at + 3] = this.#flare;
    at = 4 * FIREFLIES_STATE_BANK;
    state[at] = this.#meanFlash;
    state[at + 1] = this.#breezeFront;
    state[at + 2] = this.#breeze ? 1 : 0;
    state[at + 3] = this.#mark ? this.#markStrength : 0;
  }
}

/** The fireflies' simulation, for a scene whose `params` carry the knobs KnobKey names. */
export function firefliesSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new FirefliesSim(gl, params);
}
