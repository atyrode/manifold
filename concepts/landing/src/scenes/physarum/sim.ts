// Physarum polycephalum, the many-headed slime mould: a living network of veins that links its
// food into an efficient transport network, thickening the tubes that carry the most and letting
// the rest go. Laid out as the cities around Tokyo, its oat flakes grew a network much like the
// railways (A. Tero et al., "Rules for biologically inspired adaptive network design", Science 327,
// 2010). Two models grow it together:
//   - Tero's adaptive flow network, live on the CPU (network.ts): its tubes swell with the flow they
//     carry between the flakes and wither without it, so it links the flakes with trunks, Steiner
//     junctions and a few loops, follows them as they are eaten and laid, and lets the tubes to an
//     eaten flake die away. It is drawn (draw.ts) as the opening picture and as a film the trail
//     never falls below (see DIFFUSE in passes.ts), so the specks ride it as it adapts.
//   - Jeff Jones's agent model ("Characteristics of pattern formation and evolution in
//     approximations of Physarum transport networks", Artificial Life 16(2), 2010) on the GPU
//     (sims/gpu.ts, passes.ts), the living mould over it.
// The agents:
//   - Each agent is a speck of plasmodium with a position and a heading. Every step it smells the
//     trail at three sensors ahead of it, turns toward the strongest smell, steps forward and
//     deposits trail where it lands; the trail spreads (a 3×3 blur) and evaporates. Specks follow
//     each other's trail and bundle into filaments, which knit into a reticulated lace over the
//     whole dish; the busiest filaments draw the most traffic and thicken into trunks.
//   - Oat flakes feed the specks that reach them and are where new plasmodium is born: a speck
//     that goes a minute without food dies and is reborn at a flake, heading out from it, so every
//     flake sends out a fan of fresh filaments. Each flake has a short halo of smell (about two and
//     a half sensor offsets), flat over the flake and falling off beyond it; hungry specks (half a
//     minute since they ate) smell it more keenly than fed ones. Trunks passing near a flake bend
//     into it and run through it, the lace round it gathers into a fan, and the flakes become the
//     network's junctions; when a flake is eaten its trunks lose their pull and relax back into
//     lace. The smell is kept apart from the trail, so the trail is only ever plasmodium (no
//     glowing pool round a flake), and it is short: a long-range scent pulled the whole population
//     into the flakes' basins and starved the lace.
//   - Each speck's sensor reach is its own (0.6–1.4 × the knob's): the short-sighted knit fine
//     branches and small loops between the trunks the long-sighted lay down.
//   - Salt (dragged across the dish), light (the sea on the Tokyo map, lit in the experiment so
//     the mould would shun it) and the dish's glass wall repel it, block it and kill the trail.
//   - Sensing saturates: where the plasmodium crowds onto a flake every sensor reads the same, so
//     specks cross it in straight lines and leave along the veins instead of circling it forever;
//     and every filament above a third of the trunk level reads alike, so the specks spread over
//     the mesh rather than piling into a few heavy bands.
// Per frame the trail is normalised by its trunk level (Σt³ / Σt² outside the flakes, followed
// over a second or two), so the picture is the same at any population or evaporation and the
// shader can draw trunks bright and the lace dim; smoothed over half a second, so the specks'
// flicker never reaches the dither; and remembered over a minute, so abandoned veins leave a faint
// track of slime. A distance field along the veins from the heart (where the mould began) carries
// the shuttle streaming: a slow brightness wave running out along the veins, easing to a stop and
// running back every minute or so.
//
// The first frame opens on a grown network: the flow network, settled under the dish's food, is
// drawn as trail (trunks joining the flakes, thinner veins between, a fine lace over the dish,
// widths by flow), the specks are spread over it, and a GPU prewarm (a fixed count of steps, spread
// over frames on a slow machine) lets the mould take it over. The view crosses over from that
// sketch to the live mould as the steps come in. The network's veins, lace and fans stay on as the
// film, redrawn as the network adapts, so the mould's own trunks form and reorganise over a fine
// net that does not condense away, and the veins to an eaten flake fade as their tubes wither (the
// evaporation knob sets how fast); the film fades while an M is laid. Without float render targets
// the scene shows the sketch, still, with its streaming.
//
// Textures:
//   uSim0  rg16f over the trail grid (the frame plus PHYSARUM_MARGIN texels on every side): R the
//          trail in units of its trunk level, smoothed; G its memory over the last minute.
//   uSim1  r32f at half resolution, nearest (r16f still, without float targets): distance along the
//          veins from the heart, screen heights (PHYSARUM_FAR off the network). 32-bit because it is
//          relaxed by adding steps of ~1/150 height, which half floats round away at a few heights.
//   uSim2  rgba16f PHYSARUM_MAX_FOOD × 3, nearest. Row 0 per flake: centre (screen uv), radius
//          (screen heights), presence (negative while it is being eaten). Row 1: turn (radians),
//          squash, grain (its own random number), 1 for a crumb. Row 2: texel 0 streaming phase
//          (0..1), the heart's presence and its centre (screen uv: the entrance grows the mould out
//          of it); texel 1 the M (centre uv, height in screen heights, shown 0..1); texel 2 how far
//          the entrance's growth has come (0..1, exactly 1 once grown and whenever there was none).
//   uSim3  rgba at half resolution: R food as the specks smell it (the flakes' halos, the M's
//          strokes), G salt, B feeding (1 in a flake's pool, 0.5 at its rim, a fringe beyond),
//          A light (the lit sea, and everything past the dish's glass wall).
import { KnobReader, type ParamDef } from "../../params.ts";
import { BuildSlot } from "../../sims/build.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import {
  GpuCompute,
  type Pass,
  type PingPong,
  type RenderTarget,
  type Scatter,
} from "../../sims/gpu.ts";
import { clamp, easeFactor } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PrincipalState, SceneSim, SimFactory, SimFrame } from "../types.ts";
import {
  agentShape,
  type PhysarumDish,
  physarumDish,
  type PhysarumDishRequest,
  SEA_SHUT,
} from "./build.ts";
import { Film, picture, seedAgents } from "./draw.ts";
import {
  cityMap,
  FEED_SCALE,
  FoodBook,
  type Layout,
  LAYOUTS,
  type SeaSampler,
  seaAt,
  seaCover,
} from "./food.ts";
import { PHYSARUM_PASSAGE, physarumAgentCounts, REFERENCE_AGENTS } from "./constants.ts";
import { AGENT_UNIT, Grid, LIFE, PHYSARUM_MAX_FOOD, PhysarumError, TAU } from "./grid.ts";
import { FlowNetwork } from "./network.ts";
import {
  DEPOSIT,
  DIFFUSE,
  DISTANCE,
  ENV,
  HALO_REACH,
  LEVEL,
  MOVE,
  SALT,
  sketchLevel,
  SUMS,
  tone,
  TURN_MIN,
  VIEW,
} from "./passes.ts";

// ---- the mould --------------------------------------------------------------------------------

/**
 * Agent steps per second at tempo 1 (one texel each): calm growth, a link in five to ten seconds.
 * They run on a FixedStep of 1 / STEPS_PER_SECOND sim seconds, so the mould grows the same at any
 * frame rate; the view eases over VIEW_SECONDS of the frame clock, which hides the steps.
 */
const STEPS_PER_SECOND = 40;
/** Most steps in one frame; a slow machine's mould runs slow rather than skipping. */
const MAX_STEPS = 4;
/** Evaporation per step at evaporation 0 and 1 (log-spaced between; Jones's ~10% at 0.5). */
const LOSS_MIN = 0.03;
const LOSS_MAX = 0.3;
/**
 * Sim seconds a unit of the flow network's tube time lasts at evaporation 0 and 1 (log-spaced
 * between; ~13 s at the default): how fast a tube withers without flow, so how soon the veins to
 * an eaten flake fade, and how soon new ones reach a new one.
 */
const TUBE_SLOW = 30;
const TUBE_FAST = 4;
/** Sim seconds between redraws of the film as the network adapts. */
const FILM_EVERY = 1;

// ---- the view ---------------------------------------------------------------------------------

/** The trail is shown smoothed over this many seconds: single specks' motion never reaches the dither. */
const VIEW_SECONDS = 0.7;
/**
 * Steps after a reset by which the view has crossed over from the sketch to the live mould, and its
 * smoothing (seconds) at the start of the crossing: a fast GPU's prewarm covers it, a slow one's
 * mould grows out of the sketch over its first seconds.
 */
const SETTLE_STEPS = 160;
const SETTLE_SECONDS = 1.5;
/** Slime memory: seconds it takes to follow the network, updated every MEMORY_EVERY seconds. */
const MEMORY_SECONDS = 50;
const MEMORY_EVERY = 0.5;
/** The trunk level follows the trail over this many seconds. */
const REF_SECONDS = 1.5;
/** Distance relaxation passes per frame (strides alternate 1 and 2 texels). */
const DIST_PASSES = 2;
/** Streaming: wavelength along the veins (screen heights) and wave speed (heights per second). */
export const PHYSARUM_WAVE = 0.3;
const PULSE_SPEED = 0.05;
/** Shuttle streaming reverses every half period; the flow eases through zero over SHUTTLE_SOFT. */
const SHUTTLE_PERIOD = 96;
const SHUTTLE_SOFT = 0.06;
/** Phase of the shuttle at the start: flowing out, the first reversal after ~40 seconds. */
const SHUTTLE_START = 0.6;

// ---- prewarm ----------------------------------------------------------------------------------

/**
 * GPU prewarm at a reset: PREWARM_STEPS real steps in chunks (the first short: a software rasterizer
 * may only manage a handful), GPU-synced after each chunk. A count of steps, never a duration, so the
 * opening picture does not depend on the machine's speed: PREWARM_MS only caps how long one frame may
 * block, and a slower machine finishes the same steps over several frames (the sim holds still till then).
 */
const PREWARM_MS = 130;
const PREWARM_FIRST = 2;
const PREWARM_CHUNK = 8;
/** 320 steps, rounded up to whole chunks. */
const PREWARM_STEPS =
  PREWARM_FIRST + PREWARM_CHUNK * Math.ceil((320 - PREWARM_FIRST) / PREWARM_CHUNK);

// ---- the scene --------------------------------------------------------------------------------

/** Feeding: sim seconds between flakes eaten, at pace 0 and 1 (log-spaced between). */
const FEED_SLOW = 70;
const FEED_FAST = 14;
/** The M: height (screen heights) at size 0 and 1. */
const MARK_MIN = 0.4;
const MARK_MAX = 0.8;
/** Seconds the "now" button lays the M for; frames a size change must rest before it is relaid. */
const MARK_HOLD = 60;
const MARK_SETTLE = 20;

// ---- touch ------------------------------------------------------------------------------------

/** A press that moves farther than this (heights) is a drag. */
const DRAG_START = 0.012;
/** Half-width of a line of salt (heights). */
const SALT_RADIUS = 0.011;
/** Salt lasts (sim seconds) at "lasts" 0 and 1; it is cleared away for good after SALT_TAIL × that. */
const SALT_SHORT = 15;
const SALT_LONG = 120;
const SALT_TAIL = 1.5;
/** A resize that changes the aspect by more than this share lays the dish out afresh once it rests. */
const RELAYOUT = 0.06;
const RELAYOUT_FRAMES = 30;
/** The step counter seeding the specks' random numbers wraps here. */
const STEP_WRAP = 1 << 24;

// ---- knobs ------------------------------------------------------------------------------------

const PHYSARUM_KNOBS = [
  "specks",
  "angle",
  "reach",
  "decay",
  "tempo",
  "layout",
  "feeding",
  "foodSeed",
  "salt",
  "mark",
] as const;
type PhysarumKnob = (typeof PHYSARUM_KNOBS)[number];

interface Settings {
  agents: number;
  /** Sensor angle, radians. */
  angle: number;
  /** Sensor distance, trail texels. */
  reach: number;
  /** Share of the trail evaporating per step. */
  loss: number;
  /** Sim seconds a unit of the flow network's tube time lasts. */
  tube: number;
  tempo: number;
  layout: Layout;
  /** Sim seconds between flakes eaten; undefined while feeding is off. */
  feedEvery: number | undefined;
  seed: number;
  /** Dragging sprinkles salt. */
  salt: boolean;
  /** How long salt lasts, sim seconds. */
  saltSeconds: number;
  /** Height of the M while the feature is on, else undefined. */
  mark: number | undefined;
  /** Height of the M the "now" button lays. */
  markNow: number;
}

const markHeight = (amount: number): number =>
  MARK_MIN + (MARK_MAX - MARK_MIN) * clamp(amount, 0, 1);

function readSettings(knobs: KnobReader<PhysarumKnob>, frame: SimFrame): Settings {
  const agents = physarumAgentCounts[Math.round(knobs.value(frame, "specks"))] ?? REFERENCE_AGENTS;
  const feeding = knobs.value(frame, "feeding");
  const mark = knobs.value(frame, "mark");
  const decay = clamp(knobs.value(frame, "decay"), 0, 1);
  return {
    agents,
    angle: (clamp(knobs.value(frame, "angle"), 1, 90) * Math.PI) / 180,
    reach: clamp(knobs.value(frame, "reach"), 1, 40),
    loss: LOSS_MIN * Math.pow(LOSS_MAX / LOSS_MIN, decay),
    tube: TUBE_SLOW * Math.pow(TUBE_FAST / TUBE_SLOW, decay),
    tempo: clamp(knobs.value(frame, "tempo"), 0, 4),
    layout: LAYOUTS[Math.round(knobs.value(frame, "layout"))] ?? "random",
    feedEvery:
      feeding > 0 ? FEED_SLOW * Math.pow(FEED_FAST / FEED_SLOW, clamp(feeding, 0, 1)) : undefined,
    seed: Math.round(knobs.value(frame, "foodSeed")),
    salt: knobs.value(frame, "salt") > 0,
    saltSeconds:
      SALT_SHORT * Math.pow(SALT_LONG / SALT_SHORT, clamp(knobs.amount(frame, "salt"), 0, 1)),
    mark: mark > 0 ? markHeight(mark) : undefined,
    markNow: markHeight(knobs.amount(frame, "mark")),
  };
}

// ---- clocks -----------------------------------------------------------------------------------

/**
 * The entrance's growth, on the sim's own clock: it starts when the prewarm has finished and runs
 * on frame time (which the renderer caps per frame), so a slow first frame or a long prewarm delays
 * the growth instead of using it up. 0..1 over PHYSARUM_PASSAGE.enter seconds of it; exactly 1 once
 * grown, and from the start when the scene was not entered with a passage.
 */
class GrowthClock {
  #arriving: boolean | undefined = undefined;
  #seconds = 0;

  advance(frame: SimFrame, ready: boolean): number {
    if (this.#arriving === undefined) this.#arriving = frame.passage.enter < 1;
    if (!this.#arriving) return 1;
    if (ready) this.#seconds += Math.max(0, frame.dt);
    if (this.#seconds >= PHYSARUM_PASSAGE.enter) {
      this.#arriving = false;
      return 1;
    }
    return this.#seconds / PHYSARUM_PASSAGE.enter;
  }
}

/** Streaming phase: crests advance along the veins, ease to a stop and run back, again and again. */
class PulseClock {
  phase = 0;
  #time = 0;

  advance(dt: number): void {
    if (dt <= 0) return;
    this.#time += dt;
    const s = Math.sin((TAU * this.#time) / SHUTTLE_PERIOD + SHUTTLE_START);
    const flow = s / Math.sqrt(s * s + SHUTTLE_SOFT);
    this.phase = (((this.phase + (dt * PULSE_SPEED * flow) / PHYSARUM_WAVE) % 1) + 1) % 1;
  }
}

/** Block sums of the trail: one texel per 16 × 16. */
function sumSize(grid: Grid): { width: number; height: number } {
  return { width: Math.ceil(grid.width / 16), height: Math.ceil(grid.height / 16) };
}

// ---- the simulation ---------------------------------------------------------------------------

/** The slime mould grown on the GPU over the flow network on the CPU. */
class PhysarumSim implements SceneSim {
  readonly #gpu: GpuCompute;
  readonly #knobs: KnobReader<PhysarumKnob>;
  readonly #feedSlot: number;
  readonly #markSlot: number;
  readonly #food = new FoodBook();
  readonly #pulse = new PulseClock();
  readonly #growth = new GrowthClock();
  readonly #foodTexture: DataTexture;
  readonly #foodData = new Float32Array(PHYSARUM_MAX_FOOD * 3 * 4);
  readonly #foodUniform = new Float32Array(PHYSARUM_MAX_FOOD * 4);
  readonly #markUniform = new Float32Array(4);
  readonly #heartUniform = new Float32Array(4);
  readonly #gridUniform = new Float32Array(2);
  readonly #stepHeight = new Float32Array(2);
  readonly #segment = new Float32Array(4);
  readonly #dishUniform = new Float32Array(3);

  readonly #move: Pass;
  readonly #deposit: Scatter;
  readonly #diffuse: Pass;
  readonly #envPass: Pass;
  readonly #saltPass: Pass;
  readonly #distPass: Pass;
  readonly #viewPass: Pass;
  readonly #sumPass: Pass;
  readonly #levelPass: Pass;

  #grid: Grid;
  #frameGrid: Grid;
  #frameAspect = 0;
  #agents: PingPong;
  #agentCount: number;
  readonly #trail: PingPong;
  readonly #film: RenderTarget;
  readonly #view: PingPong;
  readonly #env: RenderTarget;
  readonly #salt: PingPong;
  readonly #dist: PingPong;
  readonly #sea: RenderTarget;
  readonly #sums: RenderTarget;
  readonly #level: PingPong;
  #seaCover: Float32Array;
  /** The flow network (laid out once the first dish has landed), and the film drawn from it. */
  #network: FlowNetwork | undefined = undefined;
  readonly #filmField = new Film();
  /** Sim seconds until the film is next redrawn. */
  #filmDue = 0;
  /** Laying a fresh dish, on the build worker (sims/build.ts), and what it was asked for. */
  readonly #dish = new BuildSlot(physarumDish);
  #asked: PhysarumDishRequest | undefined;

  /** The layout and seed of the dish asked for last (on show once it has landed). */
  #layout: Layout | undefined = undefined;
  #seed = 0;
  #layoutAspect = 1;
  #resetIn = 0;
  /** Prewarm steps taken since the last reset; the sim holds still until all PREWARM_STEPS are done. */
  #warmed = PREWARM_STEPS;
  #markUntil = -1;
  #markLast: number | undefined = undefined;
  #markHeld = 0;
  #press: { x: number; y: number; dragging: boolean } | undefined = undefined;
  #saltX = 0;
  #saltY = 0;
  #paint = false;
  #saltLeft = 0;
  #envDirty = true;
  readonly #steps = new FixedStep(1 / STEPS_PER_SECOND, MAX_STEPS);
  #stepCount = 0;
  #stride = 1;
  #memoryDebt = 0;
  /** Steps since the last reset: the view crosses over from the sketch to the mould over SETTLE_STEPS. */
  #grown = 0;

  constructor(gpu: GpuCompute, knobs: KnobReader<PhysarumKnob>) {
    this.#gpu = gpu;
    this.#knobs = knobs;
    this.#feedSlot = knobs.trigger("feeding");
    this.#markSlot = knobs.trigger("mark");
    const gl = gpu.gl;
    this.#frameAspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight);
    const grid = new Grid(this.#frameAspect);
    this.#grid = grid;
    this.#frameGrid = grid;
    const field = { width: grid.width, height: grid.height };
    const half = { width: grid.envWidth, height: grid.envHeight };
    this.#agentCount = REFERENCE_AGENTS;
    this.#agents = gpu.pingPong({
      ...agentShape(REFERENCE_AGENTS),
      format: "rgba32f",
      filter: "nearest",
    });
    this.#trail = gpu.pingPong({ ...field, format: "r16f" });
    this.#film = gpu.target({ ...field, format: "r16f" });
    this.#view = gpu.pingPong({ ...field, format: "rg16f" });
    this.#env = gpu.target({ ...half, format: "rgba16f" });
    this.#salt = gpu.pingPong({ ...half, format: "r16f" });
    this.#dist = gpu.pingPong({ ...half, format: "r32f", filter: "nearest" });
    this.#sea = gpu.target({ ...half, format: "r8" });
    this.#sums = gpu.target({ ...sumSize(grid), format: "rgba32f", filter: "nearest" });
    this.#level = gpu.pingPong({ width: 1, height: 1, format: "rg32f", filter: "nearest" });
    this.#seaCover = new Float32Array(half.width * half.height);
    this.#foodTexture = new DataTexture(gl, {
      width: PHYSARUM_MAX_FOOD,
      height: 3,
      format: "rgba16f",
      filter: "nearest",
    });

    this.#move = gpu.pass(MOVE, "physarum move");
    this.#deposit = gpu.scatter(DEPOSIT, { name: "physarum deposit" });
    this.#diffuse = gpu.pass(DIFFUSE, "physarum diffuse");
    this.#envPass = gpu.pass(ENV, "physarum agar");
    this.#saltPass = gpu.pass(SALT, "physarum salt");
    this.#distPass = gpu.pass(DISTANCE, "physarum distance");
    this.#viewPass = gpu.pass(VIEW, "physarum view");
    this.#sumPass = gpu.pass(SUMS, "physarum sums");
    this.#levelPass = gpu.pass(LEVEL, "physarum level");

    this.#move.bind({
      uAgents: this.#agents,
      uTrail: this.#trail,
      uEnv: this.#env,
      uRef: this.#level,
    });
    this.#deposit.bind({ uAgents: this.#agents });
    this.#diffuse.bind({
      uTrail: this.#trail,
      uEnv: this.#env,
      uFilm: this.#film,
      uRef: this.#level,
    });
    this.#envPass.bind({ uSalt: this.#salt, uSea: this.#sea });
    this.#saltPass.bind({ uSalt: this.#salt });
    this.#distPass.bind({ uDist: this.#dist, uView: this.#view });
    this.#viewPass.bind({ uPrev: this.#view, uTrail: this.#trail, uRef: this.#level });
    this.#sumPass.bind({ uTrail: this.#trail, uEnv: this.#env, uRef: this.#level });
    this.#levelPass.bind({ uSums: this.#sums, uPrev: this.#level });
    this.#levelPass.set({ uBlend: 1 });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const settings = readSettings(this.#knobs, frame);
    if (frame.aspect !== this.#frameAspect) {
      this.#frameAspect = frame.aspect;
      this.#frameGrid = new Grid(frame.aspect);
    }
    const grid = this.#frameGrid;
    const fired = frame.fired;
    if (fired[this.#markSlot] === true) this.#markUntil = frame.time + MARK_HOLD;
    const mark = settings.mark ?? (frame.time < this.#markUntil ? settings.markNow : undefined);

    // A new layout or seed asks for a fresh dish at once, a resize that changed the frame's shape
    // once it has rested RELAYOUT_FRAMES; the dish on show goes on until the fresh one lands.
    const fresh = settings.layout !== this.#layout || settings.seed !== this.#seed;
    if (fresh) this.#ask(settings, frame.aspect, mark);
    else {
      if (!grid.same(this.#grid)) {
        this.#stretch(grid);
        if (Math.abs(frame.aspect / this.#layoutAspect - 1) > RELAYOUT)
          this.#resetIn = RELAYOUT_FRAMES;
      }
      if (this.#resetIn > 0) {
        this.#resetIn -= 1;
        if (this.#resetIn === 0) this.#ask(settings, frame.aspect, mark);
      }
    }
    const landed = this.#dish.advance(frame.budget);
    if (landed && this.#asked) this.#reset(landed.result, this.#asked, settings);
    else if (!fresh) {
      if (settings.agents !== this.#agentCount) this.#reseedAgents(settings.agents);
      this.#holdMark(mark);
    }
    if (this.#network === undefined) return this.#textures(this.#growth.advance(frame, false));
    if (fired[this.#feedSlot] === true) this.#food.constellation();
    this.#touch(frame.pointer, frame.aspect, settings.salt);
    if (this.#warmed < PREWARM_STEPS) {
      this.#warm(Math.max(PREWARM_MS, frame.budget));
      if (this.#warmed < PREWARM_STEPS) return this.#textures(this.#growth.advance(frame, false));
    }

    const dt = Math.max(0, frame.dt) * clamp(frame.motion, 0, 1);
    const simDt = dt * settings.tempo;
    this.#food.advance(simDt, settings.feedEvery);
    this.#pulse.advance(simDt);
    this.#adapt(simDt, settings.tube);
    this.#syncUniforms(settings);
    this.#dissolve(simDt, settings.saltSeconds);
    if (simDt > 0 || this.#envDirty) {
      this.#envPass.run(this.#env);
      this.#envDirty = false;
    }

    const steps = this.#steps.advance(simDt);
    for (let i = 0; i < steps; i++) this.#step();
    this.#grown += steps;
    if (dt > 0) {
      this.#measure(easeFactor(dt, REF_SECONDS));
      this.#memoryDebt += simDt;
      let remember = 0;
      if (this.#memoryDebt >= MEMORY_EVERY) {
        remember = easeFactor(this.#memoryDebt, MEMORY_SECONDS);
        this.#memoryDebt = 0;
      }
      // Smoothed heavily while the view is still crossing over from the sketch, then lightly.
      const settled = Math.min(1, this.#grown / SETTLE_STEPS);
      const smoothing = SETTLE_SECONDS + (VIEW_SECONDS - SETTLE_SECONDS) * settled;
      this.#show(easeFactor(dt, smoothing), remember);
      this.#trace(DIST_PASSES);
    }

    return this.#textures(this.#growth.advance(frame, true));
  }

  /** The flakes uploaded, with the textures the shader reads. */
  #textures(grown: number): readonly (WebGLTexture | undefined)[] {
    this.#food.writeTexture(this.#foodData, this.#pulse.phase, grown);
    this.#foodTexture.upload(this.#foodData);
    return [this.#view.texture, this.#dist.texture, this.#foodTexture.texture, this.#env.texture];
  }

  dispose(): void {
    this.#dish.dispose();
    this.#gpu.dispose();
    this.#foodTexture.dispose();
  }

  /** The sim shows its first dish once it has landed (the build worker lays it). */
  ready(): boolean {
    return this.#network !== undefined;
  }

  /** Ask for a fresh dish for these settings (physarumDish); a newer ask supersedes it. */
  #ask(settings: Settings, aspect: number, mark: number | undefined): void {
    this.#layout = settings.layout;
    this.#seed = settings.seed;
    this.#layoutAspect = aspect;
    this.#resetIn = 0;
    const asked = {
      layout: settings.layout,
      seed: settings.seed,
      aspect,
      mark,
      agents: settings.agents,
    };
    this.#asked = asked;
    this.#dish.request(JSON.stringify(asked), asked);
  }

  /** A fresh dish landed: lay its food, take its network, its trail and specks, its film and distances. */
  #reset(dish: PhysarumDish, asked: PhysarumDishRequest, settings: Settings): void {
    const { layout, seed, aspect, mark } = asked;
    const grid = new Grid(aspect);
    this.#layoutAspect = aspect;
    this.#resetIn = 0;
    this.#resize(grid, false);
    this.#seedSea(dish.cover);
    const map = layout === "cities" ? cityMap(aspect) : undefined;
    this.#food.reset(layout, seed, aspect, map, this.#seaAt, mark);
    this.#markLast = mark;
    this.#markHeld = 0;
    const { specks, film } = dish;
    if (asked.agents === undefined || !specks || !film)
      throw new PhysarumError("physarum: a live dish came without its specks");
    this.#replaceAgents(asked.agents);

    const network = new FlowNetwork(dish.network, (u, v) => this.#seaAt(u, v) > SEA_SHUT);
    this.#network = network;
    this.#agents.seed(specks.data);
    const trail = dish.sketch;
    for (let i = 0; i < trail.length; i++) trail[i] = (trail[i] ?? 0) * specks.level;
    this.#trail.seed(trail);
    this.#filmField.adopt(network, film.lace, film.data);
    this.#film.seed(film.data);
    this.#filmDue = FILM_EVERY;
    this.#dist.seed(dish.dist);
    this.#salt.clear(0);
    this.#saltLeft = 0;
    this.#steps.reset();
    this.#memoryDebt = 0;
    this.#grown = 0;

    this.#syncUniforms(settings);
    this.#envPass.run(this.#env);
    this.#envDirty = false;
    // The trunk level and the view, measured from the seeded trail as the live mould's are; twice,
    // as a measure's filament floor rests on the trunk level before it.
    this.#measure(1);
    this.#measure(1);
    this.#show(1, 1);
    this.#warmed = 0;
  }

  /**
   * The prewarm: PREWARM_STEPS real steps (the first chunk short), the trunk level followed and the
   * distances relaxed after each chunk, GPU-synced; then the view crossed over from the sketch by as
   * much as the mould grew (all the way after SETTLE_STEPS). Steps are counted, so every machine runs
   * the same ones in the same order; a slow one only takes more frames (frame() holds still until
   * #warmed reaches PREWARM_STEPS).
   */
  #warm(budgetMs: number): void {
    const gl = this.#gpu.gl;
    this.#warmed = runBudgeted(
      (i) => {
        this.#step();
        const done = i + 1;
        if ((done - PREWARM_FIRST) % PREWARM_CHUNK !== 0) return;
        this.#grown = done;
        this.#measure(0.3);
        this.#trace(1);
        gl.finish();
      },
      budgetMs,
      PREWARM_STEPS,
      this.#warmed,
      PREWARM_CHUNK,
    );
    if (this.#warmed < PREWARM_STEPS) return;
    const settled = Math.min(1, this.#grown / SETTLE_STEPS);
    this.#show(settled, settled);
  }

  #resize(grid: Grid, keep: boolean): void {
    this.#grid = grid;
    this.#trail.resize(grid.width, grid.height, keep);
    this.#film.resize(grid.width, grid.height, keep);
    this.#view.resize(grid.width, grid.height, keep);
    this.#env.resize(grid.envWidth, grid.envHeight);
    this.#salt.resize(grid.envWidth, grid.envHeight, keep);
    this.#dist.resize(grid.envWidth, grid.envHeight, keep);
    this.#sea.resize(grid.envWidth, grid.envHeight);
    const sums = sumSize(grid);
    this.#sums.resize(sums.width, sums.height);
    this.#envDirty = true;
  }

  /** A resize: every field stretched over the new grid (specks, flakes and the network keep their places). */
  #stretch(grid: Grid): void {
    this.#resize(grid, true);
    this.#seedSea(seaCover(this.#food.map, this.#grid));
    this.#drawFilm();
  }

  /** The lit sea over the grid (seaCover) as the sim's own and as the shader's texture. */
  #seedSea(cover: Float32Array): void {
    this.#seaCover = cover;
    const bytes = new Uint8Array(cover.length);
    for (let i = 0; i < cover.length; i++) bytes[i] = Math.round(clamp(cover[i] ?? 0, 0, 1) * 255);
    this.#sea.seed(bytes);
  }

  readonly #seaAt: SeaSampler = (u, v) => seaAt(this.#seaCover, this.#grid, u, v);

  /**
   * The flow network over `simDt` sim seconds (a unit of tube time lasting `tube` of them), with
   * the dish's food and light as they are now; the film redrawn from it every FILM_EVERY seconds.
   */
  #adapt(simDt: number, tube: number): void {
    const network = this.#network;
    if (network === undefined) return;
    const food = this.#food;
    network.setLight(food.markShown < 0.5);
    network.setFood(food.nodes, food.heartId);
    network.advance(simDt / tube);
    this.#filmDue -= simDt;
    if (this.#filmDue > 0) return;
    this.#filmDue = FILM_EVERY;
    this.#drawFilm();
  }

  #drawFilm(): void {
    const network = this.#network;
    if (network === undefined) return;
    const grid = this.#grid;
    this.#film.seed(this.#filmField.draw(picture(network, grid), grid));
  }

  #replaceAgents(count: number): void {
    if (count === this.#agentCount) return;
    this.#agents.dispose();
    this.#agents = this.#gpu.pingPong({
      ...agentShape(count),
      format: "rgba32f",
      filter: "nearest",
    });
    this.#agentCount = count;
    this.#move.bind({ uAgents: this.#agents });
    this.#deposit.bind({ uAgents: this.#agents });
  }

  /** A new population, spread over the network as it is now; the trail stays. */
  #reseedAgents(count: number): void {
    this.#replaceAgents(count);
    const network = this.#network;
    if (network === undefined) return;
    const grid = this.#grid;
    const rand = mulberry32((Math.imul(count, 0x9e3779b1) ^ this.#stepCount) >>> 0);
    const flakes = this.#food.sketchNodes(grid);
    this.#agents.seed(seedAgents(this.#agents, picture(network, grid), flakes, grid, rand).data);
  }

  /** On and off at once; a new size only once the knob has rested, so a slider drag lays one M. */
  #holdMark(mark: number | undefined): void {
    const shown = this.#food.markSize;
    if ((mark === undefined) !== (shown === undefined)) {
      this.#food.setMark(mark);
      this.#markLast = mark;
      this.#markHeld = 0;
      return;
    }
    if (mark === undefined || shown === undefined || Math.abs(mark - shown) < 0.005) {
      this.#markHeld = 0;
      return;
    }
    if (mark !== this.#markLast) {
      this.#markLast = mark;
      this.#markHeld = 0;
      return;
    }
    this.#markHeld += 1;
    if (this.#markHeld >= MARK_SETTLE) {
      this.#food.setMark(mark);
      this.#markHeld = 0;
    }
  }

  /** Click: an oat flake where it landed. Drag: a line of salt along it. */
  #touch(pointer: PrincipalState, aspect: number, salt: boolean): void {
    this.#paint = false;
    if (pointer.pressed && pointer.inside) {
      this.#press = { x: pointer.x, y: pointer.y, dragging: false };
      this.#saltX = pointer.x;
      this.#saltY = pointer.y;
    }
    const press = this.#press;
    if (press === undefined) return;
    if (
      !press.dragging &&
      Math.hypot((pointer.x - press.x) * aspect, pointer.y - press.y) > DRAG_START
    )
      press.dragging = true;
    if (press.dragging && salt) {
      const grid = this.#grid;
      this.#segment[0] = grid.envX(this.#saltX);
      this.#segment[1] = grid.envY(this.#saltY);
      this.#segment[2] = grid.envX(pointer.x);
      this.#segment[3] = grid.envY(pointer.y);
      this.#saltX = pointer.x;
      this.#saltY = pointer.y;
      this.#paint = true;
    }
    if (pointer.released || !pointer.down) {
      if (!press.dragging && pointer.inside) this.#food.drop(press.x, press.y);
      this.#press = undefined;
    }
  }

  /** Salt dissolves over its lifetime (and is cleared for good after); a drag adds more. */
  #dissolve(simDt: number, seconds: number): void {
    if (this.#paint) this.#saltLeft = Math.max(this.#saltLeft, seconds * SALT_TAIL);
    if (this.#saltLeft <= 0) return;
    this.#saltLeft -= simDt;
    this.#envDirty = true;
    if (this.#saltLeft <= 0) {
      this.#salt.clear(0);
      return;
    }
    const grid = this.#grid;
    this.#saltPass.run(this.#salt, {
      uniforms: {
        uKeep: Math.exp((-3 * simDt) / seconds),
        uPaint: this.#paint ? 1 : 0,
        uSegment: this.#segment,
        uRadius: SALT_RADIUS * grid.perHeight * (grid.envHeight / grid.height),
      },
    });
  }

  /** The flakes, the M, the heart and the knobs, as the passes read them. */
  #syncUniforms(settings: Settings): void {
    const grid = this.#grid;
    const food = this.#food;
    const count = food.writeUniform(this.#foodUniform, grid);
    this.#gridUniform[0] = grid.width;
    this.#gridUniform[1] = grid.height;
    this.#markUniform[0] = grid.domainX(0.5);
    this.#markUniform[1] = grid.domainY(0.5);
    this.#markUniform[2] = food.markHeight * grid.perHeight;
    this.#markUniform[3] = food.markShown;
    const heart = food.heartNode();
    this.#heartUniform[3] = 0;
    if (heart !== undefined && heart.strength > 0.5) {
      this.#heartUniform[0] = grid.domainX(heart.x);
      this.#heartUniform[1] = grid.domainY(heart.y);
      this.#heartUniform[2] =
        heart.radius * FEED_SCALE * grid.perHeight * (grid.envWidth / grid.width);
      this.#heartUniform[3] = 1;
    }
    this.#stepHeight[0] = grid.width / grid.envWidth / grid.perHeight;
    this.#stepHeight[1] = grid.height / grid.envHeight / grid.perHeight;
    this.#dishUniform[0] = grid.domainX(0.5);
    this.#dishUniform[1] = grid.domainY(0.5);
    this.#dishUniform[2] = grid.dish;
    this.#move.set({
      uGrid: this.#gridUniform,
      uReach: settings.reach,
      uAngle: settings.angle,
      uTurn: Math.max(settings.angle, (TURN_MIN * Math.PI) / 180),
      uLife: LIFE,
      uFood: this.#foodUniform,
      uFoodCount: count,
    });
    this.#deposit.set({
      uDeposit: (settings.loss * AGENT_UNIT * REFERENCE_AGENTS) / this.#agentCount,
    });
    this.#diffuse.set({ uKeep: 1 - settings.loss, uFilmGain: 1 - food.markShown });
    this.#envPass.set({
      uGrid: this.#gridUniform,
      uFood: this.#foodUniform,
      uFoodCount: count,
      uMark: this.#markUniform,
      uLight: 1 - food.markShown,
      uDish: this.#dishUniform,
      uHalo: HALO_REACH * settings.reach,
    });
    this.#distPass.set({ uHeart: this.#heartUniform, uStepH: this.#stepHeight });
  }

  #step(): void {
    this.#move.run(this.#agents, { uniforms: { uStep: this.#stepCount } });
    this.#deposit.run(this.#trail, { count: this.#agents.width * this.#agents.height });
    this.#diffuse.run(this.#trail);
    this.#stepCount = (this.#stepCount + 1) % STEP_WRAP;
  }

  /** Follow the trunk level by `blend`. */
  #measure(blend: number): void {
    this.#sumPass.run(this.#sums);
    this.#levelPass.run(this.#level, { uniforms: { uBlend: blend } });
  }

  #show(blend: number, remember: number): void {
    this.#viewPass.run(this.#view, { uniforms: { uBlend: blend, uRemember: remember } });
  }

  #trace(passes: number): void {
    for (let i = 0; i < passes; i++) {
      this.#stride = this.#stride === 1 ? 2 : 1;
      this.#distPass.run(this.#dist, { uniforms: { uStride: this.#stride } });
    }
  }
}

/**
 * Without float render targets: the settled network drawn as the sketch, still, with its
 * streaming. Knob changes (layout, dish, the M, the frame) lay it out afresh (physarumDish, on the
 * build worker; the dish on show stays up until the fresh one lands).
 */
class PhysarumStill implements SceneSim {
  readonly #knobs: KnobReader<PhysarumKnob>;
  readonly #food = new FoodBook();
  readonly #pulse = new PulseClock();
  readonly #growth = new GrowthClock();
  readonly #foodData = new Float32Array(PHYSARUM_MAX_FOOD * 3 * 4);
  readonly #foodTexture: DataTexture;
  readonly #view: DataTexture;
  readonly #dist: DataTexture;
  readonly #env: DataTexture;
  readonly #dish = new BuildSlot(physarumDish);
  #asked: PhysarumDishRequest | undefined;
  #shown = false;
  #frameAspect = 0;
  #grid = new Grid(16 / 9);
  #layout: Layout | undefined = undefined;
  #seed = 0;
  #mark: number | undefined = undefined;
  #width = 0;
  #height = 0;

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<PhysarumKnob>) {
    this.#knobs = knobs;
    this.#foodTexture = new DataTexture(gl, {
      width: PHYSARUM_MAX_FOOD,
      height: 3,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#view = new DataTexture(gl, { width: 1, height: 1, format: "rg16f" });
    this.#dist = new DataTexture(gl, { width: 1, height: 1, format: "r16f" });
    this.#env = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const settings = readSettings(this.#knobs, frame);
    if (frame.aspect !== this.#frameAspect) {
      this.#frameAspect = frame.aspect;
      this.#grid = new Grid(frame.aspect);
    }
    const grid = this.#grid;
    if (
      settings.layout !== this.#layout ||
      settings.seed !== this.#seed ||
      settings.mark !== this.#mark ||
      grid.width !== this.#width ||
      grid.height !== this.#height
    ) {
      this.#layout = settings.layout;
      this.#seed = settings.seed;
      this.#mark = settings.mark;
      this.#width = grid.width;
      this.#height = grid.height;
      const asked = {
        layout: settings.layout,
        seed: settings.seed,
        aspect: frame.aspect,
        mark: settings.mark,
        agents: undefined,
      };
      this.#asked = asked;
      this.#dish.request(JSON.stringify(asked), asked);
    }
    const landed = this.#dish.advance(frame.budget);
    if (landed && this.#asked) this.#lay(landed.result, this.#asked);
    this.#pulse.advance(Math.max(0, frame.dt) * clamp(frame.motion, 0, 1) * settings.tempo);
    this.#food.writeTexture(this.#foodData, this.#pulse.phase, this.#growth.advance(frame, true));
    this.#foodTexture.upload(this.#foodData);
    return [this.#view.texture, this.#dist.texture, this.#foodTexture.texture, this.#env.texture];
  }

  /** The sketch shows once the first dish has landed. */
  ready(): boolean {
    return this.#shown;
  }

  dispose(): void {
    this.#dish.dispose();
    this.#foodTexture.dispose();
    this.#view.dispose();
    this.#dist.dispose();
    this.#env.dispose();
  }

  /** A landed dish as the sketch: its food laid, its sketch toned, its sea and distances uploaded. */
  #lay(dish: PhysarumDish, { layout, seed, aspect, mark }: PhysarumDishRequest): void {
    const grid = new Grid(aspect);
    const { cover, sketch } = dish;
    const map = layout === "cities" ? cityMap(aspect) : undefined;
    this.#food.reset(layout, seed, aspect, map, (u, v) => seaAt(cover, grid, u, v), mark);
    const measured = sketchLevel(sketch);
    const view = new Float32Array(sketch.length * 2);
    const bare = tone(0, measured.share);
    for (let i = 0; i < sketch.length; i++) {
      const s = sketch[i] ?? 0;
      const v = s > 0 ? tone(s / measured.level, measured.share) : bare;
      view[2 * i] = v;
      view[2 * i + 1] = v;
    }
    // Under an M the lights over the sea are out, as in the live dish.
    const light = mark === undefined ? 255 : 0;
    const env = new Uint8Array(cover.length * 4);
    for (let i = 0; i < cover.length; i++)
      env[4 * i + 3] = Math.round(clamp(cover[i] ?? 0, 0, 1) * light);
    this.#view.resize(grid.width, grid.height);
    this.#view.upload(view);
    this.#dist.resize(grid.envWidth, grid.envHeight);
    this.#dist.upload(dish.dist);
    this.#env.resize(grid.envWidth, grid.envHeight);
    this.#env.upload(env);
    this.#shown = true;
  }
}

/** The slime mould, for a scene whose `params` carry the knobs `PhysarumKnob` names. */
export function physarumSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<PhysarumKnob>("physarum", params, PHYSARUM_KNOBS);
  return (gl) => {
    const gpu = GpuCompute.create(gl);
    return gpu === undefined ? new PhysarumStill(gl, knobs) : new PhysarumSim(gpu, knobs);
  };
}
