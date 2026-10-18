// Frost on a window pane: the crystals that grow over the glass, and where warmth melted them.
// The frost glass layer's sim (frostGlassSim): its four textures are the layer's fields.
//
// field 0  crystals, rgba16f, GROWTH_ROWS texels high and as wide as the frame (512×288 at 16:9; a
//        half-resolution pass comes first). Each texel describes the nearest crystal branch:
//          r  growth-clock seconds at which the branch reached its point nearest this texel
//          g  signed distance across the branch, frame heights (+ on its left). It is linear
//             across a branch, so linear filtering reproduces it exactly and the shader draws
//             crisp lines from a coarse texture; it jumps where two branches' fields meet, and the
//             shader spots those seams by how fast it changes there
//          b  distance along the branch from its root, frame heights: the phase of its barbs
//          a  how far its barbs reach here, frame heights: longest near its root, none at its tip
// field 1  melt, rgba8 at half the crystal field's resolution, stepped every frame:
//          r  melt level (clear glass above MELT_CLEAR), g how recently the patch refroze,
//          b  warmth of the glass, a the M traced by the Manifold fingertip
// field 2  clock, r16f 1×1: the growth clock in seconds
// field 3  crystal detail, rgba8 at field 0's resolution:
//          r  fur lag × FUR_SCALE: the distance to the nearest branch in frame heights, roughened
//             by noise and shortened low on the pane, where the glass is coldest. The fur frost
//             reaches a texel this much behind its branch, at a pace the shader takes from the
//             style knob
//          g  the branch's half-width / WIDTH_SCALE
//          b  its brightness: thick stems scatter more light than fine needles
//          a  a random number per branch, varying the lengths of its barbs
//
// Growth. Window frost grows as "fern frost": dendrites nucleate on the pane's edges, its coldest
// corners and scratches, then branch as they go. Ice is hexagonal, so side branches leave at ±60°
// and their own branches at ±60° again, every branch shorter than the one it grew from. All tips
// advance together on one clock, and a tip stops where it meets older ice: that competition is
// what packs real frost into feathered fronds rather than a tangle (see Libbrecht, "The physics
// of snow crystals", Rep. Prog. Phys. 68, 2005, on dendritic side-branching). Big fronds start
// from every edge; then, as a frost front creeps in from the edges, fronds nucleate behind it and
// grow on into the clear glass left between, so the pane keeps frosting over until it is covered.
// Three levels of branches grow here, as points every STEP texels; the shader adds the fourth,
// the dense short barbs that make each frond feathery, from the distances along and across its
// branch. The texel field is a nearest-point distance transform, the two-pass sequential
// propagation of Danielsson ("Euclidean distance mapping", CGIP 14, 1980); each texel then
// measures itself against the branch through its nearest point.
//
// First frost. The pane opens at FROST_START on the growth clock, frosted along every edge and
// heaviest along the bottom. The growth is a build (build.ts) on the build worker: the branches
// grow, a half-resolution field lands first, then the full field; the pane stays clear until the
// first lands (the sim is not ready until then, so a passage waits for it). Where there is no
// worker it grows here, the quick field within the first frame and the full field over the next
// frames, on a budget that grows with the time between frames, so a slow machine, whose frames are
// far apart, refines it in seconds too. The growth clock itself runs on real time between frames, so
// a slow machine frosts over at the same pace.
//
// Resize. The branches grow on a texel grid fixed in frame heights, and every site frost nucleates
// at (a frond on the frame, a scratch, a nucleus behind the front) is counted in from the nearer
// side of the pane, with draws of its own seeded by where it is; every branch has draws of its own
// too. So a wider or narrower pane grows the same frost: each half keeps its branches where they
// were from its own edge, and only down the middle, where the halves meet, do a few branches run
// into different neighbours. A new frame shape waits until it has rested RESHAPE_MS, as a dragged
// window edge comes to rest, and the field on show stays up, stretched, until the regrown one has
// landed; a newer shape or pattern supersedes a growth still in progress.
//
// Melt. A TrailField records the principals' warmth, a stroke each. Where it is warm enough the
// frost melts; once it cools, the meltwater refreezes from the cleared patch's edges inward (only
// texels next to frozen glass refreeze quickly), and the new frost there starts thin and thickens
// back. While no warmth is left and nothing is melted or regrowing, the melt grid is not stepped at
// all.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { MARK_VERTICES } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { BuildSlot } from "../../sims/build.ts";
import { smoothstep } from "../../sims/math.ts";
import { DataTexture } from "../../sims/texture.ts";
import { TrailField } from "../../sims/trail.ts";
import type { SceneSim, SimFrame } from "../types.ts";
import { frostGrowth, type GrowthField, hash, type Size } from "./build.ts";
import { FROST_PASSAGE } from "./constants.ts";

/** Melt level above which the glass is clear of frost. */
export const MELT_CLEAR = 0.5;
/**
 * Seconds the fur frost takes to spread one frame height out from a crystal branch, at the fern
 * end and the fur end of the style knob (the shader interpolates geometrically between them).
 */
export const FUR_SLOW_FERN = 1500;
export const FUR_SLOW_FUR = 100;
/** Seconds from the fur frost's arrival until it is at full thickness. */
export const FUR_RIPEN = 15;
/**
 * Growth-clock second the pane opens at, and starts over from with a new pattern: frost along
 * every edge, heaviest along the bottom and in its corners, the first fronds climbing from them.
 */
export const FROST_START = 18;
/** Growth-clock seconds by which the thick frost along the frame has reached its full depth. */
export const RIME_GROWN = 150;
/** Growth seconds the entrance starts behind the opening state; the clock is FROST_EMERGE_FROM then. */
const ENTER_LEAD = 34;
export const FROST_EMERGE_FROM = FROST_START - ENTER_LEAD;
/** Growth second by which the frame's rime and the condensation are fully formed (the shader's). */
export const FROST_EMERGE_TO = FROST_START - 0.3 * ENTER_LEAD;
/**
 * The breath: where on the pane it lands when the pointer is not on it (uv), the radius it starts
 * from (frame heights), and how far it spreads by the end of the exit as a multiple of the distance
 * to the pane's farthest corner. The cleared edge runs behind the warmth's reach, so it is still
 * sweeping the last of the pane's corners as the exit ends.
 */
const BREATH_AT = [0.46, 0.5] as const;
const BREATH_START = 0.05;
const BREATH_REACH = 1.3;

/** The growth clock's pace for a style knob value, as the shader computes it. */
export function furSlowness(style: number): number {
  return FUR_SLOW_FERN * Math.pow(FUR_SLOW_FUR / FUR_SLOW_FERN, style);
}

/**
 * Rows of the crystal field per frame height, whatever the frame's shape (512×288 texels at 16:9).
 * The branches grow on this texel grid, so it is fixed in frame heights: a resize only widens or
 * narrows the pane, and every branch grows on the texels it grew on before.
 */
const GROWTH_ROWS = 288;
/**
 * How the growth is spread over frames where it grows on the page (no build worker, or a frame with
 * an Infinity budget), counted in slices of work (a lockstep round of the branches, or a few rows of
 * the field), never in time, so the field on show after n frames does not depend on the machine:
 * until a pattern's first field is up, as many slices as that takes; after that REFINE_SLICES a
 * frame. The caps in milliseconds only bound how long one frame may block (raised to the frame's
 * budget, SimFrame.budget, where that is more).
 */
const REFINE_SLICES = 8;
const FIRST_CAP_MS = 250;
const SLICE_CAP_MS = 50;
/**
 * Milliseconds a new frame shape must rest before the pane regrows for it (a dragged window edge),
 * as the garden waits before it re-lays. The field on show stays up, stretched to the new shape,
 * until the regrown one is complete: the same pattern, so there is nothing to race for.
 */
const RESHAPE_MS = 220;
/**
 * Longest real time one frame may add to the growth clock, seconds. The clock runs on the time
 * between frames, not the scene clock, which the renderer holds to 0.1 s a frame: on a slow
 * machine the scene's motion slows, but the pane should still frost over in its few minutes.
 */
const MAX_FRAME_SECONDS = 1;

/** Melt rises this much per second at full warmth; warmth below ONSET only fogs the glass. */
const MELT_RATE = 5;
const MELT_ONSET = 0.38;
/** Refreezing per second: fast beside frozen glass, slow in the middle of a cleared patch. */
const FRONT_RATE = 0.09;
const BULK_RATE = 0.005;
/** Seconds the refrozen frost takes to thicken back to the pattern around it. */
const REGROW_SECONDS = 90;
/** Half-life of the glass's warmth after a touch, seconds. */
const HEAT_HALF_LIFE = 0.9;
/** Touch radius in frame heights at the low and high end of the warmth knob. */
const TOUCH_RADIUS = [0.035, 0.085] as const;
/**
 * Warmth at full warmth: what a held fingertip (or the exit's breath) lays where it rests, per
 * second and at most 1 a frame, and what a held drag leaves along its middle; what a passing hand
 * leaves along its path at any speed, under MELT_ONSET, so passing over the glass never melts it
 * however slowly the pointer goes, while rubbing back and forth does.
 */
const WARM_RATE = 40;
const HELD_PASS = 0.4;
const HOVER_PASS = 0.29;

/**
 * Mark units per second the fingertip traces, its pause at each corner, what its pass leaves along
 * its middle (well past MELT_ONSET: the M melts clear), the wait between tracings while the M is
 * on, and the growth clock before the first, so there is frost to write in.
 */
const MARK_SPEED = 1.5;
const MARK_PAUSE = 0.15;
const MARK_PASS = 3;
const MARK_REPEAT = 80;
const MARK_FIRST = FROST_START + 25;

/** Crystal field size for a frame shape: GROWTH_ROWS high and as wide as the frame. */
function growthSize(aspect: number): Size {
  const shape = Math.min(4, Math.max(0.25, aspect));
  return { width: Math.round(GROWTH_ROWS * shape), height: GROWTH_ROWS };
}

/**
 * Fade a trail of warmth, unless it is known to hold nothing. `empty` is the trail's version
 * (TrailField.version, which every stroke bumps) when it was last found empty, else -1; returns the
 * same as it stands after this call. A decay zeroes every value too faint to show as a byte, so once
 * one has run, all-zero bytes mean an empty trail.
 */
function fade(trail: TrailField, empty: number, dt: number): number {
  if (trail.version === empty) return empty;
  trail.decay(dt, HEAT_HALF_LIFE);
  if (dt <= 0) return -1;
  const data = trail.data;
  for (let k = 0; k < data.length; k++) if (data[k] !== 0) return -1;
  return trail.version;
}

/** Melting and refreezing on a grid at half the growth field's resolution. */
class MeltField {
  readonly width: number;
  readonly height: number;
  /** The pointer's warmth, and the fingertip tracing the Manifold M. */
  readonly heat: TrailField;
  readonly finger: TrailField;
  /** rgba8 texels for upload (see the header). */
  readonly bytes: Uint8Array;
  readonly #melt: Float32Array;
  readonly #regrow: Float32Array;
  readonly #mark: Float32Array;
  /** Per-texel refreezing pace, so the frost closes in by a ragged, crystalline edge. */
  readonly #pace: Float32Array;
  /**
   * Cold glass: the trails' versions when last found empty (fade), and whether the last step left
   * every texel at rest (no warmth, melt, regrowth or trace), as a new field is. While all three
   * hold, a step would change nothing, and is skipped.
   */
  #heatEmpty = 0;
  #fingerEmpty = 0;
  #rest = true;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.heat = new TrailField(width, height);
    this.finger = new TrailField(width, height);
    this.bytes = new Uint8Array(width * height * 4);
    this.#melt = new Float32Array(width * height);
    this.#regrow = new Float32Array(width * height);
    this.#mark = new Float32Array(width * height);
    this.#pace = new Float32Array(width * height);
    for (let k = 0; k < this.#pace.length; k++)
      this.#pace[k] = 0.55 + 0.9 * hash(k % width, Math.floor(k / width), 31);
  }

  /**
   * Melt where the glass is warm (`dt`, real seconds) and refreeze elsewhere (`cool`, seconds
   * scaled by motion). Returns whether the texels changed.
   */
  step(dt: number, cool: number): boolean {
    this.#heatEmpty = fade(this.heat, this.#heatEmpty, dt);
    this.#fingerEmpty = fade(this.finger, this.#fingerEmpty, dt);
    if (dt <= 0) return false;
    if (this.#rest && this.#heatEmpty >= 0 && this.#fingerEmpty >= 0) return false;
    const { width, height, bytes } = this;
    const melt = this.#melt;
    const regrow = this.#regrow;
    const mark = this.#mark;
    const heat = this.heat.data;
    const finger = this.finger.data;
    let changed = false;
    let rest = true;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = y * width + x;
        const traced = (finger[k] ?? 0) / 255;
        const warmth = Math.max((heat[k] ?? 0) / 255, traced);
        let level = melt[k] ?? 0;
        if (warmth > MELT_ONSET) {
          level = Math.min(1, level + ((warmth - MELT_ONSET) / (1 - MELT_ONSET)) * MELT_RATE * dt);
        } else if (level > 0 && warmth < 0.05) {
          // Only texels beside frozen glass (or the frame) refreeze quickly: the front moves inward.
          const front =
            x === 0 ||
            y === 0 ||
            x === width - 1 ||
            y === height - 1 ||
            (melt[k - 1] ?? 0) < MELT_CLEAR ||
            (melt[k + 1] ?? 0) < MELT_CLEAR ||
            (melt[k - width] ?? 0) < MELT_CLEAR ||
            (melt[k + width] ?? 0) < MELT_CLEAR;
          level = Math.max(
            0,
            level - (front ? FRONT_RATE : BULK_RATE) * (this.#pace[k] ?? 1) * cool,
          );
        }
        melt[k] = level;
        const young =
          level >= MELT_CLEAR ? 1 : Math.max(0, (regrow[k] ?? 0) - cool / REGROW_SECONDS);
        regrow[k] = young;
        const traceMark = traced > MELT_ONSET ? 1 : Math.min(mark[k] ?? 0, young);
        mark[k] = traceMark;
        if (warmth > 0 || level > 0 || young > 0 || traceMark > 0) rest = false;
        const o = k * 4;
        const r = Math.round(level * 255);
        const g = Math.round(young * 255);
        const b = Math.round(warmth * 255);
        const a = Math.round(traceMark * 255);
        if (bytes[o] !== r || bytes[o + 1] !== g || bytes[o + 2] !== b || bytes[o + 3] !== a) {
          bytes[o] = r;
          bytes[o + 1] = g;
          bytes[o + 2] = b;
          bytes[o + 3] = a;
          changed = true;
        }
      }
    }
    this.#rest = rest;
    return changed;
  }
}

/** Where the fingertip is `elapsed` seconds into tracing the M, in mark units; undefined once done. */
function markPoint(elapsed: number): readonly [number, number] | undefined {
  let left = elapsed;
  for (let i = 0; i + 1 < MARK_VERTICES.length; i++) {
    const a = MARK_VERTICES[i];
    const b = MARK_VERTICES[i + 1];
    if (!a || !b) break;
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]) / MARK_SPEED;
    if (left <= span) {
      // Slowing into each corner, as a hand does.
      const u = smoothstep(0, 1, left / span);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    left -= span;
    if (left <= MARK_PAUSE) return b;
    left -= MARK_PAUSE;
  }
  return undefined;
}

/**
 * The frost simulation. `params` are the scene's knobs, so it can read its own knobs from
 * `SimFrame.values` by key.
 */
function frostSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): SceneSim {
  const knobs = new KnobReader("frost", params, ["speed", "style", "pattern", "warmth", "mark"]);
  const markTrigger = knobs.trigger("mark");

  const growthTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f" });
  const meltTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
  const clockTexture = new DataTexture(gl, {
    width: 1,
    height: 1,
    format: "r16f",
    filter: "nearest",
  });
  const detailTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
  const clockData = new Float32Array(1);
  let field: GrowthField | undefined;
  const growth = new BuildSlot(frostGrowth);
  /** The pattern and texel size the pane grows (or grew) for, as `${pattern}|${width}x${height}`. */
  let jobKey = "";
  let jobPattern: number | undefined;
  let jobSize: Size | undefined;
  /** The pattern of the field on show: until it is the job's, the job races to its first field. */
  let shownPattern: number | undefined;
  /** A new frame shape waiting to rest before the pane regrows for it, and since when (ms). */
  let pendingKey = "";
  let pendingSince = 0;
  let lastFrame: number | undefined;
  let pattern: number | undefined;
  let clock = FROST_START;
  let uploadedClock = Number.NaN;
  let melt: MeltField | undefined;
  let traceStart: number | undefined;
  let traceSize = 0.4;
  let nextTrace: number | undefined;
  /** Whether the entrance is still on, and seconds of it gone since the first field was on show. */
  let arriving: boolean | undefined;
  let arrived = 0;
  /** Where the exit's breath landed. */
  let breath: { x: number; y: number } | undefined;

  const show = (next: GrowthField): void => {
    field = next;
    growthTexture.resize(next.width, next.height);
    growthTexture.upload(next.data);
    detailTexture.resize(next.width, next.height);
    detailTexture.upload(next.detail);
  };

  /**
   * Warm the glass under every hand over it (each principal's its own stroke): a held fingertip
   * melts, a passing hand only breathes on it.
   */
  const touch = (frame: SimFrame, glass: MeltField): void => {
    const warmth = knobs.value(frame, "warmth");
    const { aspect, dt } = frame;
    const radius = TOUCH_RADIUS[0] + (TOUCH_RADIUS[1] - TOUCH_RADIUS[0]) * warmth;
    for (let i = 0; i < MAX_PRINCIPALS; i++) {
      const hand = frame.principals[i];
      if (warmth <= 0 || hand === undefined || !hand.inside || dt <= 0) {
        glass.heat.lift(i);
        continue;
      }
      if (hand.pressed) glass.heat.lift(i);
      if (hand.down) {
        const heat = 0.55 + 0.45 * warmth;
        glass.heat.stroke(hand.x, hand.y, radius, HELD_PASS * heat, aspect, i);
        glass.heat.hold(hand.x, hand.y, radius, Math.min(1, dt * WARM_RATE) * heat, aspect);
      } else glass.heat.stroke(hand.x, hand.y, radius * 1.25, HOVER_PASS, aspect, i);
    }
  };

  /** The Manifold M: a fingertip writes it in the frost on "now", and now and then while on. */
  const trace = (frame: SimFrame, glass: MeltField): void => {
    const size = knobs.value(frame, "mark");
    if (frame.fired[markTrigger]) {
      // "now": start over, even halfway through a tracing.
      glass.finger.lift();
      traceStart = frame.time;
    }
    if (size <= 0) nextTrace = undefined;
    else if (
      traceStart === undefined &&
      clock >= MARK_FIRST &&
      (nextTrace === undefined || frame.time >= nextTrace)
    )
      traceStart = frame.time;
    if (traceStart === undefined) return;
    const elapsed = frame.time - traceStart;
    if (elapsed < 0) {
      traceStart = undefined;
      glass.finger.lift();
      return;
    }
    if (elapsed === 0 || frame.dt > 0) {
      if (elapsed === 0) traceSize = 0.24 + 0.32 * (size > 0 ? size : 0.5);
      const point = markPoint(elapsed);
      if (!point) {
        traceStart = undefined;
        glass.finger.lift();
        nextTrace = frame.time + MARK_REPEAT;
        return;
      }
      const x = 0.5 + (point[0] * traceSize) / frame.aspect;
      const y = 0.52 + point[1] * traceSize;
      glass.finger.stroke(x, y, traceSize * 0.085, MARK_PASS, frame.aspect);
    }
  };

  /**
   * Growth seconds the shown clock is behind the real one: FROST_EMERGE_FROM's worth at the start
   * of the entrance, running down fast at first and easing to exactly 0 over FROST_PASSAGE.enter
   * seconds that begin once the first field is up (so a slow first frame does not use the entrance
   * up). 0 when not entered with a passage.
   */
  const enterLead = (frame: SimFrame): number => {
    if (arriving === undefined) arriving = frame.passage.enter < 1;
    if (!arriving) return 0;
    if (field) arrived += Math.max(0, frame.dt);
    const progress = arrived / FROST_PASSAGE.enter;
    if (progress >= 1) {
      arriving = false;
      return 0;
    }
    return ENTER_LEAD * (1 - progress) ** 3;
  };

  /**
   * The exit: a warm breath lands on the glass and its warmth spreads, gathering pace and still
   * spreading as the exit ends, melting the frost out of its way.
   */
  const breathe = (frame: SimFrame, glass: MeltField): void => {
    const { exit } = frame.passage;
    if (!(exit > 0)) {
      breath = undefined;
      return;
    }
    if (frame.dt <= 0) return;
    const { pointer, aspect } = frame;
    breath ??= pointer.inside
      ? { x: pointer.x, y: pointer.y }
      : { x: BREATH_AT[0], y: BREATH_AT[1] };
    const far = Math.hypot(
      Math.max(breath.x, 1 - breath.x) * aspect,
      Math.max(breath.y, 1 - breath.y),
    );
    const spread = Math.min(1, exit);
    const radius = BREATH_START + (BREATH_REACH * far - BREATH_START) * spread * spread;
    glass.heat.hold(breath.x, breath.y, radius, Math.min(1, frame.dt * WARM_RATE) * 0.9, aspect);
  };

  return {
    frame(frame) {
      const now = frame.now;
      const interval = lastFrame === undefined ? 16 : Math.min(1000, Math.max(0, now - lastFrame));
      lastFrame = now;
      const { aspect } = frame;
      if (!(aspect > 0) || !Number.isFinite(aspect)) {
        return [
          field ? growthTexture.texture : undefined,
          melt ? meltTexture.texture : undefined,
          clockTexture.texture,
          field ? detailTexture.texture : undefined,
        ];
      }

      // A new pattern frosts over afresh from the opening state; a new frame shape, once it has
      // rested RESHAPE_MS, regrows the same pattern (see "Resize" above).
      const seed = Math.round(knobs.value(frame, "pattern"));
      if (pattern !== undefined && seed !== pattern) {
        clock = FROST_START;
        // Recreate both trails too: clearing only their bytes would leave hidden warmth and
        // stroke endpoints behind. The new field is uploaded below even when dt is zero.
        melt = undefined;
        traceStart = undefined;
        traceSize = 0.4;
        nextTrace = undefined;
        breath = undefined;
      }
      pattern = seed;
      const size = growthSize(aspect);
      const key = `${seed}|${size.width}x${size.height}`;
      let grow = false;
      if (key === jobKey) pendingKey = "";
      else if (shownPattern !== seed) grow = true;
      else {
        if (key !== pendingKey) {
          pendingKey = key;
          pendingSince = now;
        }
        grow = now - pendingSince >= RESHAPE_MS;
      }
      if (grow) {
        jobKey = key;
        jobPattern = seed;
        jobSize = size;
        growth.request(key, { pattern: seed, size, quick: shownPattern !== seed });
        pendingKey = "";
      }
      // On the build worker; on the page, race to this pattern's first field, then refine a few
      // slices a frame (REFINE_SLICES). Regrown for a new shape, the same pattern grows no quick
      // field: the old one stays up until the new one is finished.
      const race = shownPattern !== seed;
      const landed = growth.advance(
        Math.max(race ? FIRST_CAP_MS : SLICE_CAP_MS, frame.budget),
        race ? Number.POSITIVE_INFINITY : REFINE_SLICES,
      );
      if (landed) {
        show(landed.result);
        shownPattern = jobPattern;
      }

      // The growth clock: real time between frames while the scene runs (see MAX_FRAME_SECONDS),
      // paced by the speed knob and the lab's motion, held once all is frosted.
      const elapsed =
        frame.dt > 0 ? Math.max(frame.dt, Math.min(interval / 1000, MAX_FRAME_SECONDS)) : 0;
      clock += elapsed * frame.motion * knobs.value(frame, "speed");
      if (field)
        clock = Math.min(
          clock,
          Math.max(
            RIME_GROWN,
            field.latest + field.reach * furSlowness(knobs.value(frame, "style")) + FUR_RIPEN + 5,
          ),
        );
      clock = Math.min(clock, 60000);
      const shown = clock - enterLead(frame);
      if (shown !== uploadedClock) {
        clockData[0] = shown;
        clockTexture.upload(clockData);
        uploadedClock = shown;
      }

      // The melt grid: half the resolution of the field the pane grows for.
      const meltWidth = Math.ceil((jobSize ?? size).width / 2);
      const meltHeight = Math.ceil((jobSize ?? size).height / 2);
      if (!melt || melt.width !== meltWidth || melt.height !== meltHeight) {
        melt = new MeltField(meltWidth, meltHeight);
        meltTexture.resize(meltWidth, meltHeight);
        meltTexture.upload(melt.bytes);
      }
      touch(frame, melt);
      breathe(frame, melt);
      trace(frame, melt);
      if (melt.step(frame.dt, frame.dt * frame.motion)) meltTexture.upload(melt.bytes);

      return [
        field ? growthTexture.texture : undefined,
        meltTexture.texture,
        clockTexture.texture,
        field ? detailTexture.texture : undefined,
      ];
    },
    // The pane is ready once its first field is up.
    ready: () => field !== undefined,
    dispose() {
      growthTexture.dispose();
      meltTexture.dispose();
      clockTexture.dispose();
      detailTexture.dispose();
      growth.dispose();
    },
  };
}

/**
 * The frost glass layer's sim (README "The interior composer"): the crystals and the melt, its four
 * textures to its fields (frostGlassField0..3).
 */
export function frostGlassSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  const sim = frostSim(gl, params);
  return {
    frame(frame: LayerFrame) {
      const textures = sim.frame(frame);
      frame.fields.forEach((field, k) => {
        field.texture = textures[k];
      });
    },
    ready: () => sim.ready?.() !== false,
    dispose() {
      sim.dispose();
    },
  };
}
