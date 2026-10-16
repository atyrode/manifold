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
// knob. The habitat knob's open bank grows low scrub along a wide mud bank instead and spreads the
// fireflies low over all of it, exactly as many as the dense crowns would hold (#matchOpenBank), so
// the two layouts compare at one population. Each crawls a little about a jittered place in its
// cell. A few more drift low over the river between us and the bank, and a few hang close to us, out
// of focus, in the upper corners.
//
// Disturbances: the pointer's lantern (fireflies near a light lose the beat, and right beside it
// stop flashing, as real ones do under a street lamp), a click (the lantern flares and scatters the
// phases around it), and a breeze that now and then crosses the bank, detuning every firefly it
// passes; behind it the forest falls into step again. The Manifold M: the fireflies along its
// strokes gather onto them and lock half a cycle away from the forest, so the M flashes alone in
// the dark between the pulses for a few beats, then lets go.
//
// The trees are rooted plants of the shared plant component (sims/plants.ts): each a stem carrying
// the clumps of its crown, and Rhizophora prop roots arching from under the crown down into the
// water, in pairs from apexes on the lattice the shader always drew them on (a root bin every
// FIREFLIES_ROOT_PITCH, the same hashes), each pair belonging to the tree above it. The breeze pushes
// them as it crosses: the stems bow downwind one after another and swing back, carrying their
// crowns, and the roots barely give. Between breezes they stand still, the bank exactly as laid out.
//
// Time: the swarm steps STEP at a time on a FixedStep (sims/clock.ts), so a seed falls into step
// the same at 60 and at 144 Hz, and is drawn between its last two steps (phases the short way
// round), as the lantern is between its own.
//
// Units: x in screen heights from the middle of the view, y in uv height (0 bottom, 1 top).
//
// Textures:
//   uSim0  rgba16f, cols × FIREFLIES_ROWS (row 0 at the waterline), linear: R, G the firefly's place
//          in its cell (0.06..0.94, read with texelFetch; R = -1: no firefly in this cell, G negative:
//          it is drawing the M); B its light (flash × its own brightness); A its soft halo, the
//          light of the 3×3 cells around it over 9 (sampled smoothly, it glows through the crowns).
//   uSim1  rgba16f, cols·FIREFLIES_PROFILE_RES × 2, linear: the far bank. Row 0: canopy top, canopy
//          underside (uv heights), crown tone 0..1, 0. Row 1: R trunk 0..1. While the crowns sway it
//          is the bank's profile with every crown where its stem carries it.
//   uSim2  rgba16f, (FIREFLIES_NEAR + 2) × 1, nearest: the lights nearer than the bank (x, y on
//          screen, distance in metres, negative for a drifter left out, flash): FIREFLIES_DRIFTERS
//          drifters, then the out-of-focus ones; then the lantern (x, y, shown, flare) and the bank
//          (mean flash, breeze front x, breeze on 0/1, M strength 0..1).
//   uSim3  rgba16f PlantTexture (sims/plants.ts) of the prop roots, after one row of its own whose
//          first texel is (first root bin, bins, 0, 0): bin k's left root at record 2 (k - first),
//          its right root at the next (tier 0: none); a and the record's bend give each its turn.
import { markVertex } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { LevelCamera } from "../../sims/camera.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import { clamp, glslHash12, smoothstep } from "../../sims/math.ts";
import {
  PlantHabit,
  PlantRole,
  PlantTexture,
  plantClimate,
  RootedPlants,
  type PlantBuilder,
  type PlantSpecies,
} from "../../sims/plants.ts";
import { mulberry32 } from "../../sims/random.ts";
import { springStep, type Spring } from "../../sims/spring.ts";
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
export const FIREFLIES_HORIZON =
  FIREFLIES_WATER + (FIREFLIES_EYE / FIREFLIES_BANK) * FIREFLIES_FOCAL;
/** uSim2 texels: the foreground fireflies, then the lantern and the bank. */
export const FIREFLIES_STATE_LANTERN = FIREFLIES_NEAR;
export const FIREFLIES_STATE_BANK = FIREFLIES_NEAR + 1;
const STATE_TEXELS = FIREFLIES_NEAR + 2;
/** The eye the lights nearer than the bank move about in front of (sims/camera.ts). */
const CAMERA = new LevelCamera({
  horizon: FIREFLIES_HORIZON,
  eye: FIREFLIES_EYE,
  focal: FIREFLIES_FOCAL,
});

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
/**
 * The swarm's fixed step (s) and the most steps one frame catches up: every frame rate steps the
 * same moments, and the swarm is drawn between its last two steps by the clock's alpha.
 */
const STEP = 1 / 60;
const MAX_STEPS = 6;
/**
 * Seconds of rhythm simulated before the first frame (the forest starts out of step either way), in
 * whole steps of PREWARM_STEP: the swarm holds still until they are done, so the opening picture
 * never depends on the machine. The budget only caps how long one frame may block; a slow machine
 * spreads the steps over a few frames.
 */
const PREWARM_SECONDS = 2;
const PREWARM_STEP = 0.05;
const PREWARM_STEPS = Math.round(PREWARM_SECONDS / PREWARM_STEP);
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
/**
 * The open bank (habitat knob): the fireflies hover low over the whole bank instead, thinning with
 * height over about OPEN_REACH (screen heights), a little less among the leaves and less still
 * under them; host trees count for nothing there. It holds exactly as many fireflies as the dense
 * crowns would (see #matchOpenBank).
 */
const OPEN_REACH = 0.09;
const OPEN_LEAVES = 0.7;
const OPEN_UNDER = 0.5;
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
/** The open bank's share of lone Sonneratia among its scrub, and the chance of open mud after each clump. */
const OPEN_GRAND = 0.12;
const OPEN_GAPS = 0.6;

// The trees as rooted plants.
/** The prop roots' lattice (screen heights): an apex now and then in each bin, as the shader always hashed them. */
export const FIREFLIES_ROOT_PITCH = 0.012;
/** Bins either side of the lattice's span: a root reaches at most 2.4 pitches from its own. */
const ROOT_MARGIN = 3;
/** How far a root goes on below the waterline, so its foot stays in the water as it gives. */
const ROOT_SINK = 0.003;
/** Root records: a left and a right root per bin, for the widest lattice. */
const ROOT_RECORDS =
  2 * (Math.floor((MAX_COLS * FIREFLIES_CELL) / FIREFLIES_ROOT_PITCH) + 2 * ROOT_MARGIN + 2);
/** The plants' organs: every tree's stem and crown clumps, every root. */
const TREE_ORGANS = 4096;
/** The breeze's push on the trees at its middle (push units), and how long they swing on after it (s). */
const BREEZE_PUSH = 1;
const SWAY_SETTLE = 12;

// The lantern.
/** Spring that the hanging lantern follows the pointer with (rad/s) and its damping ratio. */
const LANTERN_SPRING = 9;
const LANTERN_DAMPING = 0.55;
/** The lantern's fixed step (s), and the most steps one frame catches up. */
const LANTERN_STEP = 1 / 60;
const LANTERN_MAX_STEPS = 6;
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

type KnobKey =
  "coupling" | "density" | "habitat" | "period" | "drift" | "unrest" | "lantern" | "mark" | "seed";

interface Knobs {
  coupling: number;
  density: number;
  period: number;
  /** The open bank (habitat 1) instead of the dense crowns. */
  open: boolean;
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

/**
 * A phase (cycles, 0..1) `alpha` of the way from `was` to `now` the short way round: a step moves
 * it well under half a cycle, so a flash that wrapped past 0 is drawn on from where it was.
 */
function between(was: number, now: number, alpha: number): number {
  let d = now - was;
  d -= Math.round(d);
  const f = was + d * alpha;
  return f - Math.floor(f);
}

/** A stable number 0..1 for a lattice cell (world column, row) and a salt: survives resizes. */
function cellHash(column: number, row: number, salt: number): number {
  let h =
    Math.imul(column | 0, 0x27d4eb2d) ^
    Math.imul((row | 0) + 0x3c6ef372, 0x165667b1) ^
    Math.imul(salt | 0, 0x9e3779b1);
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

/** A bank of trees: the clumps of their crowns and the trees they belong to. */
interface Bank {
  lumps: Lump[];
  trees: Tree[];
}

/**
 * The far bank, left to right. Dense crowns (the default): Rhizophora mangroves, broad rounded
 * crowns standing on arching prop roots and packed into a wall, and now and then a tall Sonneratia,
 * the trees the fireflies gather in, with a bare trunk under a higher, ragged crown; a gap now and
 * then shows the low mud bank. Open bank: low mangrove scrub in clumps along a wide mud bank, with
 * a lone Sonneratia here and there. Each crown is a cluster of round clumps, taller in the middle.
 */
function growForest(seed: number, open: boolean): Bank {
  const rand = mulberry32((Math.imul(seed + 1, 0x9e3779b1) ^ 0x6f1e5a3) >>> 0);
  const lumps: Lump[] = [];
  const trees: Tree[] = [];
  let x = -FOREST_HALF - 0.15;
  while (x < FOREST_HALF + 0.15) {
    const grand = rand() < (open ? OPEN_GRAND : 0.17);
    const width = grand ? 0.2 + 0.14 * rand() : open ? 0.05 + 0.07 * rand() : 0.09 + 0.1 * rand();
    const height = grand
      ? 0.21 + 0.14 * rand()
      : open
        ? 0.025 + 0.04 * rand()
        : 0.09 + 0.12 * rand();
    const base =
      FIREFLIES_WATER +
      (grand ? 0.05 + 0.04 * rand() : open ? 0.01 + 0.01 * rand() : 0.022 + 0.026 * rand());
    const tree = trees.length;
    const centre = x + width * 0.5;
    trees.push({
      x: centre,
      base,
      host: grand ? 0.95 + 0.05 * rand() : 0.35 + 0.5 * rand(),
      shade: rand(),
      roots: grand ? 0.35 : 1,
      trunk: grand,
    });
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
    const gap = rand() < (open ? OPEN_GAPS : 0.1);
    x += gap
      ? width + (open ? 0.03 + 0.15 * rand() : 0.02 + 0.06 * rand())
      : width * (0.5 + 0.3 * rand());
  }
  return { lumps, trees };
}

/** The low mud bank and nipa where no tree stands: height above the waterline (screen heights). */
function lowBank(x: number, seed: number): number {
  const s = (seed % 97) * 0.37;
  return 0.011 + 0.004 * Math.sin(x * 37 + s) + 0.002 * Math.sin(x * 91 + 2.3 * s);
}

/**
 * A bank's profile over a lattice of `cols` columns, FIREFLIES_PROFILE_RES texels each: the canopy's
 * top and underside (uv heights), how much the fireflies like the trees there and which tree it is
 * (-1: open mud), and the uSim1 texels (see the file header).
 */
interface Profile {
  top: Float32Array;
  under: Float32Array;
  host: Float32Array;
  treeAt: Int32Array;
  texels: Float32Array;
}

function blankProfile(width: number): Profile {
  return {
    top: new Float32Array(width),
    under: new Float32Array(width),
    host: new Float32Array(width),
    treeAt: new Int32Array(width),
    texels: new Float32Array(width * 2 * 4),
  };
}

const emptyProfile: Profile = blankProfile(0);

function profileOf(bank: Bank, cols: number, seed: number): Profile {
  const profile = blankProfile(cols * FIREFLIES_PROFILE_RES);
  paintProfile(profile, bank, cols, seed);
  return profile;
}

/**
 * Paints `profile` (sized for `cols`) from the bank, its crowns' clumps where they stand, or, given
 * `centres` (x, y per clump), where their stems carry them.
 */
function paintProfile(
  profile: Profile,
  bank: Bank,
  cols: number,
  seed: number,
  centres?: Float64Array,
): void {
  const res = FIREFLIES_PROFILE_RES;
  const width = cols * res;
  const x0 = -0.5 * cols * FIREFLIES_CELL;
  const dx = FIREFLIES_CELL / res;
  const { top, under, host, treeAt, texels } = profile;
  top.fill(-1);
  under.fill(2);
  host.fill(0);
  treeAt.fill(-1);
  texels.fill(0);
  for (let l = 0; l < bank.lumps.length; l++) {
    const lump = bank.lumps[l];
    const tree = lump === undefined ? undefined : bank.trees[lump.tree];
    if (lump === undefined || tree === undefined) continue;
    const lx = centres ? (centres[2 * l] ?? lump.x) : lump.x;
    const ly = centres ? (centres[2 * l + 1] ?? lump.y) : lump.y;
    const k0 = Math.max(0, Math.ceil((lx - lump.r - x0) / dx - 0.5));
    const k1 = Math.min(width - 1, Math.floor((lx + lump.r - x0) / dx - 0.5));
    for (let k = k0; k <= k1; k++) {
      const off = x0 + (k + 0.5) * dx - lx;
      const crown = ly + Math.sqrt(Math.max(0, lump.r * lump.r - off * off));
      if (crown > (top[k] ?? -1)) {
        top[k] = crown;
        treeAt[k] = lump.tree;
        texels[4 * k + 2] = tree.shade;
      }
      under[k] = Math.min(under[k] ?? 2, tree.base);
      host[k] = Math.max(host[k] ?? 0, tree.host);
    }
  }
  for (const tree of bank.trees) {
    if (!tree.trunk) continue;
    const k0 = Math.max(0, Math.floor((tree.x - 2 * TRUNK_HALF - x0) / dx));
    const k1 = Math.min(width - 1, Math.ceil((tree.x + 2 * TRUNK_HALF - x0) / dx));
    for (let k = k0; k <= k1; k++) {
      const off = Math.abs(x0 + (k + 0.5) * dx - tree.x);
      const at = 4 * (width + k);
      texels[at] = Math.max(
        texels[at] ?? 0,
        1 - smoothstep(TRUNK_HALF * 0.7, TRUNK_HALF * 1.3, off),
      );
    }
  }
  for (let k = 0; k < width; k++) {
    const low = FIREFLIES_WATER + lowBank(x0 + (k + 0.5) * dx, seed);
    let t = top[k] ?? -1;
    let u = under[k] ?? 2;
    if (t < low || u > t) {
      // No crown here: the mud bank, solid to the water.
      t = Math.max(t, low);
      u = low;
      host[k] = 0;
    } else {
      u = Math.max(u, FIREFLIES_WATER + GAP_MIN);
    }
    top[k] = t;
    under[k] = u;
    texels[4 * k] = t;
    texels[4 * k + 1] = u;
  }
}

// ---- the trees as rooted plants ------------------------------------------------------------------

/** A pair of prop roots: its bin (from the first), its apex (x, height above the water) and how far out its feet land. */
interface RootApex {
  bin: number;
  x: number;
  rise: number;
  spread: number;
}

/** The bank the trees grow on, for their builds: each tree's clumps and root apexes, and the organ each clump becomes. */
interface TreeLayout {
  bank: Bank;
  lumpsOf: number[][];
  apexesOf: RootApex[][];
  lumpOrgan: Int32Array;
}

/**
 * A tree of the bank (site.kind: its index in layout.bank.trees): a stem from the waterline to its
 * crown's top, its crown's clumps held out from it at their heights (they ride the stem's bend, with
 * no give of their own), and its prop roots. Each root is a circular arc from its apex, leaving
 * outward and down and turning toward the vertical, so the pair lands `spread` either side at the
 * waterline and a little below: tall narrow apexes leave steeply, low wide ones rise first. Stems and
 * clumps are never packed (the shader draws the crowns through the bank's profile).
 */
function buildTree(plant: PlantBuilder, layout: TreeLayout): void {
  const t = plant.site.kind ?? 0;
  const bank = layout.bank;
  const tree = bank.trees[t];
  if (tree === undefined) return;
  const lumps = layout.lumpsOf[t] ?? [];
  let height = 0.02;
  for (const l of lumps) height = Math.max(height, (bank.lumps[l]?.y ?? 0) - FIREFLIES_WATER);
  const stem = plant.organ({ angle: Math.PI / 2, length: height, form: 0, slot: -1 });
  for (const l of lumps) {
    const lump = bank.lumps[l];
    if (lump === undefined) continue;
    const dx = lump.x - tree.x;
    layout.lumpOrgan[l] = plant.organ({
      parent: stem,
      at: (lump.y - FIREFLIES_WATER) / height,
      angle: dx >= 0 ? -Math.PI / 2 : Math.PI / 2,
      length: Math.abs(dx),
      habit: PlantHabit.rigid,
      give: 0,
      form: 0,
      slot: -1,
    });
  }
  for (const apex of layout.apexesOf[t] ?? []) {
    const drop = apex.rise + ROOT_SINK;
    // Leaving at beta below the horizontal and turning (pi/2 - beta) to the vertical, an arc of
    // radius R falls R cos(beta) as it reaches R (1 - sin(beta)) out.
    const beta = 2 * Math.atan(drop / apex.spread) - Math.PI / 2;
    const turn = Math.PI / 2 - beta;
    const length = (drop / Math.cos(beta)) * turn;
    const offset = [apex.x - tree.x, apex.rise] as const;
    plant.organ({
      offset,
      angle: Math.PI + beta,
      length,
      curl: turn,
      a: turn,
      form: 0,
      side: -1,
      role: PlantRole.root,
      slot: 2 * apex.bin,
    });
    plant.organ({
      offset,
      angle: -beta,
      length,
      curl: -turn,
      a: -turn,
      form: 0,
      side: 1,
      role: PlantRole.root,
      slot: 2 * apex.bin + 1,
    });
  }
}

/** The bank's two kinds of tree, building from `layout`: Rhizophora, and the tall Sonneratia (trunk: true). */
function mangroves(layout: TreeLayout): { rhizophora: PlantSpecies; sonneratia: PlantSpecies } {
  const build = (plant: PlantBuilder): void => buildTree(plant, layout);
  const evergreen = { shed: 0, turn: 2, bloom: [0, 0] as const };
  const life = { unfold: 10, span: 600 };
  const detail = { simple: 3, min: 1.5 };
  return {
    rhizophora: {
      id: "rhizophora",
      moisture: [0.8, 1],
      sway: { hz: 0.6, damping: 0.3, give: 0.07, limit: 0.25 },
      year: evergreen,
      life,
      detail,
      build,
    },
    sonneratia: {
      id: "sonneratia",
      moisture: [0.7, 1],
      sway: { hz: 0.5, damping: 0.25, give: 0.08, limit: 0.25 },
      year: evergreen,
      life,
      detail,
      build,
    },
  };
}

/** The trees' builds draw no randomness of their own (the bank and the hashes place everything). */
const NO_DRAWS = (): number => 0;

/**
 * The root apexes over a lattice of `cols` columns, from the bank's profile, into layout.apexesOf: in
 * every bin of FIREFLIES_ROOT_PITCH the shader's hashes place an apex, keep it as rooty trees allow
 * (fewer under a Sonneratia, none over open mud) and size it to the root gap above the water there.
 * Returns the first bin and how many there are.
 */
function layRoots(
  layout: TreeLayout,
  profile: Profile,
  cols: number,
): { first: number; bins: number } {
  const res = FIREFLIES_PROFILE_RES;
  const width = cols * res;
  const x0 = -0.5 * cols * FIREFLIES_CELL;
  const dx = FIREFLIES_CELL / res;
  const first = Math.floor(x0 / FIREFLIES_ROOT_PITCH) - ROOT_MARGIN;
  const last = Math.floor((x0 + cols * FIREFLIES_CELL) / FIREFLIES_ROOT_PITCH) + ROOT_MARGIN;
  for (let k = first; k <= last; k++) {
    const h2 = glslHash12(k, 62.7);
    const x = (k + 0.5 + 0.6 * (h2 - 0.5)) * FIREFLIES_ROOT_PITCH;
    const texel = clamp(Math.floor((x - x0) / dx), 0, width - 1);
    const t = profile.treeAt[texel] ?? -1;
    const tree = layout.bank.trees[t];
    const top = profile.top[texel] ?? 0;
    const under = profile.under[texel] ?? 0;
    if (tree === undefined || top - under < 0.004 || glslHash12(k, 61.3) > 0.15 + 0.55 * tree.roots)
      continue;
    const rise = (under - FIREFLIES_WATER) * (0.8 + 0.4 * h2) + 0.004;
    layout.apexesOf[t]?.push({
      bin: k - first,
      x,
      rise,
      spread: FIREFLIES_ROOT_PITCH * (0.9 + 1.5 * glslHash12(k, 64.1)),
    });
  }
  return { first, bins: last - first + 1 };
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
  readonly #textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined, undefined];
  /** One prewarm step, as runBudgeted calls it. */
  readonly #warmStep = (): void => this.#step(PREWARM_STEP, this.#knobs);
  #warmed = 0;
  readonly #steps = new FixedStep(STEP, MAX_STEPS);
  readonly #knobs: Knobs = {
    coupling: 0.5,
    density: 0.7,
    period: 3,
    open: false,
    drift: 0.35,
    unrest: 0,
    lantern: true,
    mark: 0,
    markNow: 5,
    seed: 0,
  };
  readonly #nearest = new Float64Array(2);

  // The banks, grown once per seed: the dense crowns, and the open bank.
  #seed = -1;
  #crowns: Bank = { lumps: [], trees: [] };
  #openBank: Bank = { lumps: [], trees: [] };
  /** The lattice is laid out on the open bank (the habitat knob, as last fitted). */
  #open = false;
  /** The profiles over the lattice: the bank on show, and the dense crowns', which set how many live. */
  #shown: Profile = emptyProfile;
  #crownProfile: Profile = emptyProfile;

  // The bank's trees as rooted plants: stems, crown clumps and prop roots (uSim3), and the profile
  // with the crowns where their stems carry them while they sway.
  readonly #trees = new RootedPlants(TREE_ORGANS, 0);
  readonly #roots: PlantTexture;
  readonly #treeClimate = plantClimate();
  readonly #layout: TreeLayout = {
    bank: { lumps: [], trees: [] },
    lumpsOf: [],
    apexesOf: [],
    lumpOrgan: new Int32Array(0),
  };
  readonly #species = mangroves(this.#layout);
  #rootFirst = 0;
  #rootBins = 0;
  #drawn: Profile = emptyProfile;
  #centres = new Float64Array(0);
  readonly #point = new Float64Array(3);
  /** Seconds the trees swing on (SWAY_SETTLE after a breeze); 0: at rest, the bank as laid out. */
  #swaying = 0;
  /** Dither cells per screen height the roots' tiers were set for. */
  #treeCells = 0;

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
  /** How much each cell of the dense crowns suits a firefly; on the open bank, the cell each takes the place of. */
  #habitat = new Float32Array(0);
  #partner = new Int32Array(0);
  #bright = new Float32Array(0);
  // The passage: each cell's own lateness (0..1) and its column's turn.
  #late = new Float32Array(0);
  #arrival = new Float32Array(0);
  // The M: how much each cell belongs to it, and the place on its strokes it gathers to.
  #member = new Float32Array(0);
  #snapX = new Float32Array(0);
  #snapY = new Float32Array(0);
  // Dynamic, and as it stood a step before: the swarm is drawn between the two (#keepDrawn).
  #phase = new Float32Array(0);
  #present = new Float32Array(0);
  #phaseWas = new Float32Array(0);
  #presentWas = new Float32Array(0);
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
  /** The clock, the bank's mean flash, the breeze's front and the M's strength a step before. */
  #clockWas = 0;
  #meanFlashWas = 0;
  #breezeFrontWas = 0;
  #markStrengthWas = 0;
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
  readonly #nearPhaseWas = new Float64Array(FIREFLIES_NEAR);
  readonly #nearX = new Float64Array(FIREFLIES_NEAR);
  readonly #nearY = new Float64Array(FIREFLIES_NEAR);

  // The lantern (screen heights from the middle, uv height) on its springs, where it was a step
  // before (it is drawn between the two), and its swing.
  readonly #lanternX: Spring = { x: 0, v: 0 };
  readonly #lanternY: Spring = { x: 0.5, v: 0 };
  #lanternWasX = 0;
  #lanternWasY = 0.5;
  readonly #lanternClock = new FixedStep(LANTERN_STEP, LANTERN_MAX_STEPS);
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
    this.#reader = new KnobReader("fireflies", params, [
      "coupling",
      "density",
      "habitat",
      "period",
      "drift",
      "unrest",
      "lantern",
      "mark",
      "seed",
    ]);
    this.#breezeSlot = this.#reader.trigger("unrest");
    this.#markSlot = this.#reader.trigger("mark");
    this.#swarmTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f" });
    this.#forestTexture = new DataTexture(gl, { width: 1, height: 2, format: "rgba16f" });
    this.#stateTexture = new DataTexture(gl, {
      width: STATE_TEXELS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#roots = new PlantTexture(gl, ROOT_RECORDS, { rowBase: 1 });
    // The breeze is the trees' only air: a front crossing the bank, pushing downwind.
    this.#treeClimate.wind = (x, _y, out) => {
      if (!this.#breeze) return;
      const u = (x - this.#breezeFront) / BREEZE_WIDTH;
      out[0] = this.#breezeDir * BREEZE_PUSH * Math.exp(-u * u);
    };
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#read(frame);
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#arrive = clamp(frame.passage.enter, 0, 1);
    this.#leave = clamp(frame.passage.exit, 0, 1);
    const dt = Math.max(0, frame.dt);
    const cells = frame.height > 0 ? frame.height : this.#treeCells;
    const retier = cells !== this.#treeCells;
    this.#treeCells = cells;
    this.#trees.cells = cells;
    if (knobs.seed !== this.#seed) this.#grow(knobs);
    else this.#fit(knobs);
    if (retier) {
      // The roots' tiers follow the frame's resolution.
      this.#trees.pose();
      this.#showTrees();
    }
    // The opening seconds run in whole steps (a few frames of them on a slow machine) before the
    // swarm moves on its own.
    if (this.#warmed < PREWARM_STEPS) {
      this.#warmed = runBudgeted(
        this.#warmStep,
        Math.max(PREWARM_BUDGET_MS, frame.budget),
        PREWARM_STEPS,
        this.#warmed,
      );
      // Shown as the warm-up left it, nothing to draw between.
      this.#keepDrawn();
    }
    this.#watchTriggers(frame.fired, knobs);
    if (this.#warmed >= PREWARM_STEPS) {
      this.#schedule(knobs);
      this.#steerLantern(frame.pointer, knobs, dt);

      // Motion runs the swarm; a breeze or an M under way still plays while motion is 0.
      const busy = this.#breeze || this.#mark || this.#arrive < 1 || this.#leave > 0;
      const advance = dt * (frame.motion > 0 ? frame.motion : busy ? 1 : 0);
      for (let s = 0, n = this.#steps.advance(advance); s < n; s++) {
        this.#keepDrawn();
        this.#step(STEP, knobs);
      }
      if (this.#scatterAt) this.#scatterPhases(this.#scatterAt.x, this.#scatterAt.y);
      this.#scatterAt = undefined;
      // The trees swing while a breeze crosses and for a while after (at the breeze's pace while
      // motion is 0); then they stand exactly as laid out.
      if (this.#breeze) this.#swaying = SWAY_SETTLE;
      if (this.#swaying > 0 && dt > 0) this.#swayTrees(dt * (frame.motion > 0 ? frame.motion : 1));
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
    this.#textures[3] = this.#roots.texture;
    return this.#textures;
  }

  dispose(): void {
    this.#swarmTexture.dispose();
    this.#forestTexture.dispose();
    this.#stateTexture.dispose();
    this.#roots.dispose();
  }

  #read(frame: SimFrame): Knobs {
    const reader = this.#reader;
    const knobs = this.#knobs;
    knobs.coupling = reader.value(frame, "coupling");
    knobs.density = reader.value(frame, "density");
    knobs.open = reader.value(frame, "habitat") > 0.5;
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
    else if (!Number.isFinite(this.#nextBreeze))
      this.#nextBreeze = clock + this.#breezeInterval(knobs.unrest);
    if (this.#breezeNow || (!this.#breeze && !this.#mark && clock >= this.#nextBreeze)) {
      this.#breezeNow = false;
      this.#startBreeze();
      this.#nextBreeze =
        knobs.unrest > 0 ? clock + this.#breezeInterval(knobs.unrest) : Number.POSITIVE_INFINITY;
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
    this.#breezeFrontWas = this.#breezeFront;
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
    this.#crowns = growForest(knobs.seed, false);
    this.#openBank = growForest(knobs.seed, true);
    this.#cols = 0;
    // A new stretch of river starts calm: its trees grow (in #fit) standing still.
    this.#breeze = false;
    this.#swaying = 0;
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
        this.#nearAnchorX[k] =
          0.5 * side * (BOKEH_SIDE_MIN + (BOKEH_SIDE_MAX - BOKEH_SIDE_MIN) * near());
        this.#nearAnchorY[k] = CAMERA.worldY(y, z);
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
    this.#mark = false;
    this.#markStrength = 0;
    this.#gusts = 0;
    this.#nextBreeze = Number.POSITIVE_INFINITY;
    this.#nextMark = Number.POSITIVE_INFINITY;
    this.#markWasOn = false;
    this.#warmed = 0;
    this.#dirty = true;
  }

  /**
   * Fit the lattice to the frame's aspect and the habitat knob's bank, keeping every firefly whose
   * column stays in view (all of them when only the bank changes: they move over to their new places).
   */
  #fit(knobs: Knobs): void {
    const cols = Math.min(MAX_COLS, 2 * Math.ceil(this.#aspect / 2 / FIREFLIES_CELL + 1));
    if (cols === this.#cols && knobs.open === this.#open) return;
    this.#open = knobs.open;
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
    this.#partner = new Int32Array(n);
    this.#bright = new Float32Array(n);
    this.#late = new Float32Array(n);
    this.#member = new Float32Array(n);
    this.#snapX = new Float32Array(n);
    this.#snapY = new Float32Array(n);
    this.#phase = new Float32Array(n);
    this.#present = new Float32Array(n);
    this.#phaseWas = new Float32Array(n);
    this.#presentWas = new Float32Array(n);
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
    const trees = (this.#open ? this.#openBank : this.#crowns).trees;
    this.#arrival = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const tree = this.#shown.treeAt[c * FIREFLIES_PROFILE_RES + FIREFLIES_PROFILE_RES / 2] ?? -1;
      const x = tree >= 0 ? (trees[tree]?.x ?? 0) : (c + 0.5 - half) * FIREFLIES_CELL;
      const fromRight = clamp((this.#aspect / 2 - x) / this.#aspect, 0, 1);
      const luck = cellHash(tree >= 0 ? tree : c - half, 5, salt + 19);
      this.#arrival[c] = TREE_RANDOM * luck + (1 - TREE_RANDOM) * fromRight;
    }
    // How many live where: the dense crowns decide it, and the open bank takes the same count.
    for (let i = 0; i < n; i++) {
      this.#rank[i] = cellHash((i % cols) - half, Math.floor(i / cols), salt + 1);
      this.#habitat[i] = this.#habitatAt(i);
    }
    if (this.#open) this.#matchOpenBank(salt);
    for (let i = 0; i < n; i++) {
      const column = (i % cols) - half;
      const row = Math.floor(i / cols);
      const stubborn = cellHash(column, row, salt + 3) < STUBBORN_SHARE;
      const spread = cellHash(column, row, salt + 2) + cellHash(column, row, salt + 9) - 1;
      this.#rate[i] =
        1 + (stubborn ? STUBBORN_SPREAD * Math.sign(spread || 1) : RATE_SPREAD * spread);
      this.#pull[i] = stubborn ? STUBBORN_PULL : 1;
      this.#scatter[i] = 2 * cellHash(column, row, salt + 4) - 1;
      this.#jitterX[i] = 0.3 + 0.4 * cellHash(column, row, salt + 5);
      this.#jitterY[i] = 0.3 + 0.4 * cellHash(column, row, salt + 6);
      this.#wanderPhase[2 * i] = TAU * cellHash(column, row, salt + 7);
      this.#wanderPhase[2 * i + 1] = TAU * cellHash(column, row, salt + 8);
      this.#wanderSpeed[2 * i] =
        WANDER_SLOW + (WANDER_FAST - WANDER_SLOW) * cellHash(column, row, salt + 13);
      this.#wanderSpeed[2 * i + 1] =
        WANDER_SLOW + (WANDER_FAST - WANDER_SLOW) * cellHash(column, row, salt + 14);
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
    // A new lattice is drawn as it is laid, nothing to draw between.
    this.#phaseWas.set(this.#phase);
    this.#presentWas.set(this.#present);
    if (this.#mark) this.#placeMark();
    this.#dirty = true;
  }

  /** The bank on show and the dense crowns over the lattice's span; its trees grown on the one on show (uSim1, uSim3). */
  #paintForest(): void {
    this.#crownProfile = profileOf(this.#crowns, this.#cols, this.#seed);
    this.#shown = this.#open
      ? profileOf(this.#openBank, this.#cols, this.#seed)
      : this.#crownProfile;
    this.#forestTexture.resize(this.#cols * FIREFLIES_PROFILE_RES, 2);
    this.#growTrees();
  }

  /** The bank on show as rooted plants: a plant per tree, its roots in their bins over this lattice, at rest in the air now. */
  #growTrees(): void {
    const bank = this.#open ? this.#openBank : this.#crowns;
    const layout = this.#layout;
    layout.bank = bank;
    layout.lumpsOf = bank.trees.map(() => []);
    layout.apexesOf = bank.trees.map(() => []);
    layout.lumpOrgan = new Int32Array(bank.lumps.length).fill(-1);
    bank.lumps.forEach((lump, l) => layout.lumpsOf[lump.tree]?.push(l));
    const { first, bins } = layRoots(layout, this.#shown, this.#cols);
    this.#rootFirst = first;
    this.#rootBins = bins;
    const trees = this.#trees;
    trees.clear();
    bank.trees.forEach((tree, t) => {
      trees.add(
        tree.trunk ? this.#species.sonneratia : this.#species.rhizophora,
        { x: tree.x, y: FIREFLIES_WATER, heading: Math.PI / 2, moisture: 1, kind: t, slot: 0 },
        NO_DRAWS,
      );
    });
    this.#drawn = blankProfile(this.#cols * FIREFLIES_PROFILE_RES);
    this.#centres = new Float64Array(2 * bank.lumps.length);
    trees.settle(this.#treeClimate);
    this.#showTrees();
  }

  /**
   * The trees to the shader: the bank's profile (as laid out at rest, else with every crown clump
   * where its stem carries it) and the roots' records.
   */
  #showTrees(): void {
    if (this.#swaying > 0) {
      const lumps = this.#layout.bank.lumps;
      const centres = this.#centres;
      const point = this.#point;
      for (let l = 0; l < lumps.length; l++) {
        const organ = this.#layout.lumpOrgan[l] ?? -1;
        if (organ >= 0) this.#trees.pointAt(organ, 1, point);
        centres[2 * l] = organ >= 0 ? (point[0] ?? 0) : (lumps[l]?.x ?? 0);
        centres[2 * l + 1] = organ >= 0 ? (point[1] ?? 0) : (lumps[l]?.y ?? 0);
      }
      paintProfile(this.#drawn, this.#layout.bank, this.#cols, this.#seed, centres);
      this.#forestTexture.upload(this.#drawn.texels);
    } else {
      this.#forestTexture.upload(this.#shown.texels);
    }
    const roots = this.#roots;
    roots.pack(this.#trees);
    roots.data[0] = this.#rootFirst;
    roots.data[1] = this.#rootBins;
    roots.upload();
  }

  /** h seconds of the trees in the breeze; once they have swung out, they are set exactly at rest. */
  #swayTrees(h: number): void {
    const climate = this.#treeClimate;
    climate.dt = h;
    climate.time = this.#clock;
    this.#trees.step(climate);
    if (!this.#breeze) this.#swaying = Math.max(0, this.#swaying - h);
    if (this.#swaying <= 0) this.#trees.settle(climate);
    this.#showTrees();
  }

  /** How much a cell of the dense crowns suits a firefly (0..1): the crowns' outer leaves, a few in the air and roots. */
  #habitatAt(i: number): number {
    const column = i % this.#cols;
    const row = Math.floor(i / this.#cols);
    const k = column * FIREFLIES_PROFILE_RES + FIREFLIES_PROFILE_RES / 2;
    const y = FIREFLIES_WATER + (row + 0.5) * FIREFLIES_CELL;
    const profile = this.#crownProfile;
    const top = profile.top[k] ?? 0;
    const under = profile.under[k] ?? 0;
    const host = profile.host[k] ?? 0;
    if (y < under) return GAP_HABITAT;
    if (y <= top) return host * (1 - 0.35 * smoothstep(0.06, 0.18, top - y));
    return host * RIM_HABITAT * Math.max(0, 1 - (y - top) / RIM_REACH) + SKY_HABITAT;
  }

  /** How much a cell of the open bank suits a firefly: the air low over the bank, thinning with height. */
  #openHabitatAt(i: number): number {
    const column = i % this.#cols;
    const row = Math.floor(i / this.#cols);
    const k = column * FIREFLIES_PROFILE_RES + FIREFLIES_PROFILE_RES / 2;
    const y = FIREFLIES_WATER + (row + 0.5) * FIREFLIES_CELL;
    const air = Math.exp(-(((y - FIREFLIES_WATER) / OPEN_REACH) ** 2));
    if (y < (this.#shown.under[k] ?? 0)) return OPEN_UNDER * air;
    if (y <= (this.#shown.top[k] ?? 0)) return OPEN_LEAVES * air;
    return air;
  }

  /**
   * The open bank holds as many fireflies as the dense crowns at every density: rank the cells of
   * each (a cell's chance over how well it suits a firefly, as #target thresholds them), and let the
   * open bank's k-th cell stand in for the dense crowns' k-th, so it fills exactly when that one would.
   */
  #matchOpenBank(salt: number): void {
    const n = this.#n;
    const cols = this.#cols;
    const half = cols / 2;
    const crown = new Float64Array(n);
    const open = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      crown[i] = (this.#rank[i] ?? 1) / (this.#habitat[i] ?? 0);
      open[i] =
        cellHash((i % cols) - half, Math.floor(i / cols), salt + 20) / this.#openHabitatAt(i);
    }
    const byCrown = Uint32Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => (crown[a] ?? 0) - (crown[b] ?? 0) || a - b,
    );
    const byOpen = Uint32Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => (open[a] ?? 0) - (open[b] ?? 0) || a - b,
    );
    for (let m = 0; m < n; m++) this.#partner[byOpen[m] ?? 0] = byCrown[m] ?? 0;
  }

  /** Whether a cell holds a firefly now (0 or 1), before the M calls more in. */
  #target(i: number, density: number): number {
    const j = this.#open ? (this.#partner[i] ?? i) : i;
    return (this.#rank[j] ?? 1) < density * (this.#habitat[j] ?? 0) ? 1 : 0;
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
    return (
      smoothstep(inAt, inAt + ENTER_RAMP, this.#arrive) *
      (1 - smoothstep(outAt, outAt + EXIT_RAMP, this.#leave))
    );
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
        this.#snapY[i] = Math.min(
          0.92,
          Math.max(0.08, (sy - FIREFLIES_WATER) / FIREFLIES_CELL - row),
        );
      }
    }
  }

  // ---- the rhythm ------------------------------------------------------------------------------

  /** The swarm as it stands becomes the step before: what the next step is drawn from. */
  #keepDrawn(): void {
    this.#phaseWas.set(this.#phase);
    this.#presentWas.set(this.#present);
    this.#nearPhaseWas.set(this.#nearPhase);
    this.#clockWas = this.#clock;
    this.#meanFlashWas = this.#meanFlash;
    this.#breezeFrontWas = this.#breezeFront;
    this.#markStrengthWas = this.#markStrength;
  }

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
    const boost =
      1 +
      ENTER_BOOST * smoothstep(0.08, 0.3, this.#arrive) * (1 - smoothstep(0.75, 1, this.#arrive));
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
      const light =
        ((this.#sum[i] ?? 0) - own) / Math.max((this.#count[i] ?? 0) - ownCount, COUNT_FLOOR);
      const a = mark * (member[i] ?? 0);
      const drive =
        (kLocal * light + kGlobal) * (this.#pull[i] ?? 1) * (this.#calm[i] ?? 1) * (1 - a);
      let f = phase[i] ?? 0;
      const response = f < refractory ? 0 : -Math.sin(TAU * (f - refractory) * receptive);
      let rate =
        omega * (this.#rate[i] ?? 1) * Math.max(0.2, 1 + (this.#detune[i] ?? 0)) + drive * response;
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
      const lx = this.#lanternX.x;
      const lanternY = this.#lanternY.x;
      const ly = lanternY < FIREFLIES_WATER ? 2 * FIREFLIES_WATER - lanternY : lanternY;
      const c0 = Math.max(0, Math.floor((lx - LANTERN_REACH - x0) / FIREFLIES_CELL));
      const c1 = Math.min(cols - 1, Math.ceil((lx + LANTERN_REACH - x0) / FIREFLIES_CELL));
      const r0 = Math.max(0, Math.floor((ly - LANTERN_REACH - FIREFLIES_WATER) / FIREFLIES_CELL));
      const r1 = Math.min(
        FIREFLIES_ROWS - 1,
        Math.ceil((ly + LANTERN_REACH - FIREFLIES_WATER) / FIREFLIES_CELL),
      );
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
      this.#markStrength =
        smoothstep(0, rise, this.#markAge) * (1 - smoothstep(hold, end, this.#markAge));
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
      const d = Math.hypot(
        (this.#nearX[j] ?? 0) - this.#lanternX.x,
        (this.#nearY[j] ?? 0) - this.#lanternY.x,
      );
      const w = this.#lanternShown * Math.max(0, 1 - d / LANTERN_REACH);
      let f = this.#nearPhase[j] ?? 0;
      const detune = 1 + LANTERN_SCATTER * w * (j % 2 === 0 ? 1 : -1);
      f +=
        h *
        Math.max(0, omega * (this.#nearRate[j] ?? 1) * detune - k * (1 - w) * Math.sin(TAU * f));
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
      this.#lanternX.x = x;
      this.#lanternY.x = y;
      this.#lanternX.v = 0;
      this.#lanternY.v = 0;
      this.#lanternWasX = x;
      this.#lanternWasY = y;
    }
    if (dt > 0) {
      for (let s = 0, n = this.#lanternClock.advance(dt); s < n; s++) {
        this.#lanternWasX = this.#lanternX.x;
        this.#lanternWasY = this.#lanternY.x;
        springStep(this.#lanternX, x, LANTERN_SPRING, LANTERN_DAMPING, LANTERN_STEP);
        springStep(this.#lanternY, y, LANTERN_SPRING, LANTERN_DAMPING, LANTERN_STEP);
      }
      this.#lanternShown +=
        ((on ? 1 : 0) - this.#lanternShown) * (1 - Math.exp(-dt / LANTERN_FADE));
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
    const r1 = Math.min(
      FIREFLIES_ROWS - 1,
      Math.ceil((ly + CLICK_REACH - FIREFLIES_WATER) / FIREFLIES_CELL),
    );
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

  /** Every firefly's place in its cell, light and soft halo, drawn between the swarm's last two steps, for uSim0. */
  #pack(knobs: Knobs): void {
    const n = this.#n;
    const cols = this.#cols;
    const data = this.#data;
    const halo = this.#halo;
    const span = knobs.period / Math.min(FLASH_SECONDS, FLASH_SHARE * knobs.period);
    const wander = WANDER * knobs.drift;
    const alpha = this.#steps.alpha;
    const clock = this.#clockWas + (this.#clock - this.#clockWas) * alpha;
    const mark = this.#mark
      ? this.#markStrengthWas + (this.#markStrength - this.#markStrengthWas) * alpha
      : 0;
    const front = this.#breezeFrontWas + (this.#breezeFront - this.#breezeFrontWas) * alpha;
    const x0 = -0.5 * cols * FIREFLIES_CELL;
    for (let i = 0; i < n; i++) {
      const at = 4 * i;
      const was = this.#presentWas[i] ?? 0;
      const p = was + ((this.#present[i] ?? 0) - was) * alpha;
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
      const phase = between(this.#phaseWas[i] ?? 0, this.#phase[i] ?? 0, alpha);
      const lit = Math.max(flash(phase * span), MARK_EMBER * a);
      const e = p * bright * lit * (1 - (this.#hush[i] ?? 0));
      let ox =
        (this.#jitterX[i] ?? 0.5) +
        wander *
          Math.sin(clock * (this.#wanderSpeed[2 * i] ?? 0) + (this.#wanderPhase[2 * i] ?? 0));
      let oy =
        (this.#jitterY[i] ?? 0.5) +
        wander *
          0.7 *
          Math.sin(
            clock * (this.#wanderSpeed[2 * i + 1] ?? 0) + (this.#wanderPhase[2 * i + 1] ?? 0),
          );
      if (this.#breeze) {
        const u = (x0 + ((i % cols) + 0.5) * FIREFLIES_CELL - front) / BREEZE_WIDTH;
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
    return (
      smoothstep(inAt, inAt + NEAR_IN_RAMP, this.#arrive) *
      (1 - smoothstep(outAt, outAt + NEAR_OUT_RAMP, this.#leave))
    );
  }

  /** The lights nearer than the bank, the lantern and the bank, drawn between their last two steps, for uSim2. */
  #packState(knobs: Knobs): void {
    const state = this.#state;
    const span = knobs.period / Math.min(FLASH_SECONDS, FLASH_SHARE * knobs.period);
    const step = this.#steps.alpha;
    const clock = this.#clockWas + (this.#clock - this.#clockWas) * step;
    const alpha = this.#lanternClock.alpha;
    const lanternX = this.#lanternWasX + (this.#lanternX.x - this.#lanternWasX) * alpha;
    const lanternY = this.#lanternWasY + (this.#lanternY.x - this.#lanternWasY) * alpha;
    const drifters = Math.round(FIREFLIES_DRIFTERS * Math.min(1, knobs.density * DRIFT_DENSITY));
    for (let j = 0; j < FIREFLIES_NEAR; j++) {
      const drifter = j < FIREFLIES_DRIFTERS;
      const wanderX = Math.sin(
        clock * (this.#nearWander[j * 6 + 3] ?? 0) + (this.#nearWander[j * 6] ?? 0),
      );
      const wanderY = Math.sin(
        clock * (this.#nearWander[j * 6 + 4] ?? 0) + (this.#nearWander[j * 6 + 1] ?? 0),
      );
      const wanderZ = Math.sin(
        clock * (this.#nearWander[j * 6 + 5] ?? 0) + (this.#nearWander[j * 6 + 2] ?? 0),
      );
      const z =
        (this.#nearAnchorZ[j] ?? 6) * (1 + (drifter ? DRIFT_WANDER_Z : BOKEH_WANDER_Z) * wanderZ);
      const height =
        (this.#nearAnchorY[j] ?? 1) + (drifter ? DRIFT_WANDER_Y : BOKEH_WANDER_Y) * wanderY;
      const x =
        (this.#nearAnchorX[j] ?? 0) * this.#aspect +
        CAMERA.screenX((drifter ? DRIFT_WANDER_X : BOKEH_WANDER_X) * wanderX, z);
      const y = CAMERA.screenY(height, z);
      this.#nearX[j] = x;
      this.#nearY[j] = y;
      const d = Math.hypot(x - lanternX, y - lanternY);
      const hush = this.#lanternShown * (1 - smoothstep(LANTERN_HUSH * 0.4, LANTERN_HUSH, d)) * 0.9;
      state[4 * j] = x;
      state[4 * j + 1] = y;
      // A drifter the density leaves out is marked by a negative distance.
      state[4 * j + 2] = drifter && j >= drifters ? -z : z;
      const phase = between(this.#nearPhaseWas[j] ?? 0, this.#nearPhase[j] ?? 0, step);
      state[4 * j + 3] = flash(phase * span) * (1 - hush) * this.#nearGate(j);
    }
    let at = 4 * FIREFLIES_STATE_LANTERN;
    state[at] = lanternX;
    state[at + 1] = lanternY;
    state[at + 2] = this.#lanternShown;
    state[at + 3] = this.#flare;
    at = 4 * FIREFLIES_STATE_BANK;
    state[at] = this.#meanFlashWas + (this.#meanFlash - this.#meanFlashWas) * step;
    state[at + 1] = this.#breezeFrontWas + (this.#breezeFront - this.#breezeFrontWas) * step;
    state[at + 2] = this.#breeze ? 1 : 0;
    state[at + 3] = this.#mark
      ? this.#markStrengthWas + (this.#markStrength - this.#markStrengthWas) * step
      : 0;
  }
}

/** The fireflies' simulation, for a scene whose `params` carry the knobs KnobKey names. */
export function firefliesSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new FirefliesSim(gl, params);
}
