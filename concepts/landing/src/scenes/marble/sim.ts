// Paper marbling: ink floating on size, dropped, combed and swirled (Turkish ebru, Japanese
// suminagashi), after "Mathematical Marbling" (S. Lu, A. Jaffer, X. Jin, H. Zhao, X. Mao, IEEE
// Computer Graphics and Applications 32(6), 2012).
//
// Every ink region is a closed polygon and every operation a closed-form map applied to all of its
// vertices, so boundaries stay crisp however far they are drawn out:
//   drop of radius r at c     p -> c + (p - c) sqrt(1 + r² / |p - c|²)   (area-preserving: the ink
//                             already there makes room for exactly the new circle)
//   tine line through b, m    p -> p + z m,  z = α λ / (d + λ),  d = distance from p to the line
//                             (α the largest shift, λ the sharpness)
//   wavy tine                 d measured to a sine wave about the line
//   circular stir             z along a circle about c, applied as a rotation
// Drops compose additively in r² (|p - c|² grows by r²), so a drop can spread over many frames and
// still land exactly on the paper's result. The paper moves a whole tine line at once; here the
// tool travels, and each frame hands on the share of z its tip has delivered so far (a smooth window
// around the tip): over a full pass the shares sum to the paper's map, and a short stroke combs only
// where it went.
//
// Polygons are resampled as they stretch (vertices inserted on long edges near the view, merged
// where they bunch up), ink pushed far outside the view is culled, and a region that covers the
// whole view hides everything beneath it. The regions are filled with Canvas 2D in drop order into
// an OffscreenCanvas and uploaded as uSim0 (premultiplied rgba, alpha = ink cover); uSim1 carries the
// tool and the veil over the ink (lifting the sheet, or a fresh one fading up) for the shader.
//
// Sheet units: height 1, origin at the centre of the view, y up; x spans ±aspect/2.
import { KnobReader, type ParamDef } from "../../params.ts";
import { MARK_VERTICES, markVertex } from "../../mark.ts";
import { runBudgeted } from "../../sims/clock.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

export const marblePatterns = ["stone", "gel-git", "nonpareil", "bouquet", "chevron"] as const;
export type MarblePattern = (typeof marblePatterns)[number];

/**
 * How the ink is laid and moved. Ebru: a ground colour spread over the size, then colours flicked
 * from a brush into packed stones, which the pattern's stylus and combs then work. Suminagashi: two
 * brushes touched to the water in turn, one with ink and one with clear water, so every drop pushes
 * the last out into a ring; left uncombed (the stone pattern), breath and a fan turn the rings.
 */
export const marblePractices = ["ebru", "suminagashi"] as const;
export type MarblePractice = (typeof marblePractices)[number];
/** The `practice` knob, in order: the inks' own practice, then each practice by name. */
export const marblePracticeChoices = ["by inks", ...marblePractices] as const;

export interface MarblePalette {
  label: string;
  /** CSS colours the routines draw from. */
  inks: readonly string[];
  /** The ink painted in the lab's accent colour by the two-tone palette. */
  accent: string;
  /** The practice these inks belong to: what the `practice` knob's "by inks" follows. */
  practice: MarblePractice;
  /** Dark inks: floated on clear water over a pale tray (and the page goes light), not on dark size. */
  basin: boolean;
}

// Ebru's pigments, kept clear and saturated so the dither keeps them rich: deep indigo, ochre gold,
// madder rust, cream and lamp black.
const EBRU: MarblePalette = {
  label: "ebru",
  inks: ["#1f3a96", "#dca12c", "#b5401f", "#f2e4c2", "#151419"],
  accent: "#1f3a96",
  practice: "ebru",
  basin: false,
};
// Sumi and indigo, each pushed out into a ring by a drop of clear water.
const SUMINAGASHI: MarblePalette = {
  label: "suminagashi",
  inks: ["#1d1c21", "#2c3a6e"],
  accent: "#2c3a6e",
  practice: "suminagashi",
  basin: true,
};
// Risograph spot inks: fluorescent pink, teal, sunflower, medium blue, midnight.
const RISO: MarblePalette = {
  label: "riso",
  inks: ["#ff5c98", "#00a29a", "#ffd03d", "#3e52d0", "#1e1b3b"],
  accent: "#3e52d0",
  practice: "ebru",
  basin: false,
};

/** In `palette` knob order. */
export const marblePalettes: readonly MarblePalette[] = [EBRU, SUMINAGASHI, RISO];

/** The practice the `practice` knob's value picks for these inks: 0 follows them, 1.. names one. */
export function marblePractice(choice: number, palette: MarblePalette): MarblePractice {
  return marblePractices[Math.round(choice) - 1] ?? palette.practice;
}

const TAU = Math.PI * 2;

/** Longest side of the ink canvas in pixels; the other follows the frame's aspect. */
const CANVAS_LONG_SIDE = 1024;
/** Redraws of the ink canvas are capped at this rate (the shapes move slowly), on the frame's wall clock. */
const REDRAW_MS = 1000 / 30;
/** Longest edge kept near the view, in sheet units (~3 px of the canvas, about a dither cell). */
const MAX_EDGE = 0.0055;
/** Above this many vertices edges are allowed to grow (as the square root of the excess)... */
const VERTEX_TARGET = 50_000;
/** ...and above this none are inserted at all. Canvas 2D fills ~1e5 vertices in a few ms. */
const VERTEX_CAP = 90_000;
/** Most vertices inserted on one edge in one frame. */
const MAX_SPLIT = 64;
/** Neighbours closer than this share of the longest edge may merge if the vertex between is flat. */
const MERGE_SHARE = 0.8;
/** Flatness tolerance for merging (largest distance from the chord), near the view and far outside. */
const FLAT_NEAR = 0.0006;
const FLAT_FAR = 0.002;
/** Longest chord a merge may leave outside the view. */
const MERGE_FAR = 0.05;
/** Edges are refined within this margin around the view; regions beyond the cull margin are dropped. */
const REFINE_MARGIN = 0.12;
const CULL_MARGIN = 0.35;
/** Radius a drop starts from (it then spreads with its own map). */
const SPAWN_RADIUS = 0.0015;

/** Longest simulated step; a stalled tab must not throw the tools across the tray. */
const MAX_STEP = 0.1;
/** Seconds after the last touch before the choreography carries on. */
const IDLE_RESUME = 4;
/** How long lifting the sheet takes, at the end of a loop and when asked for at once. */
const LIFT_SECONDS = 3;
const QUICK_LIFT_SECONDS = 1.2;
/**
 * Fast-forward of a fresh sheet's sprinkling, done out of sight (nothing is drawn until it ends):
 * step in routine seconds, and budget per frame at least. A machine already drawing slow frames
 * (software GL) gets the frame's larger budget (a share of the frame interval), so the sheet is
 * laid in about a second there too.
 */
const PREROLL_STEP = 0.2;
const PREROLL_BUDGET_MS = 12;
/** A prerolled sheet fades up from the bare tray over this many seconds. */
const ARRIVE_SECONDS = 0.8;
/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads the exit's share).
 * Entrance: the first sheet's drops land and spread on a clean bath, then the combs go to work.
 * Exit: a sheet of paper is laid on the tray and lifted off, taking the ink and leaving a clean bath.
 */
export const MARBLE_PASSAGE: { enter: number; exit: number } = { enter: 3.2, exit: 1.6 };
/**
 * An entered scene plays the first sheet's sprinkling live instead of prerolling it out of sight and
 * fading it up. From the first moment it spreads the ground drop alone over SPRINKLE_LEAD_SECONDS
 * (it is the bath the colours land on), then lands the rest over the remaining time, fastest at
 * first and slowing to the end, leaving SPRINKLE_SETTLE of the entrance for the last drops to
 * spread out. The ground drop has covered the view by SPRINKLE_GROUND_VIEW of its routine time
 * (whatever the aspect and where it lands). That much takes SPRINKLE_GROUND_SHARE of the lead,
 * square in time: a drop's area grows with its routine time, so its rim sets off at an even pace
 * (not in one jump) and slows as it fills the view. The rest, out of sight, is made up in the
 * lead's last moments, so the colours follow as the flood fills the view.
 */
const SPRINKLE_SETTLE = 0.2;
const SPRINKLE_LEAD_SECONDS = 0.8;
const SPRINKLE_SECONDS = MARBLE_PASSAGE.enter - SPRINKLE_SETTLE;
const SPRINKLE_GROUND_VIEW = 0.35;
const SPRINKLE_GROUND_SHARE = 0.9;
/** Tool fade in and out, seconds. */
const TOOL_FADE = 0.3;
/** Share of a stroke's time the tool spends getting up to its even pace, and again slowing down. */
const STROKE_RAMP = 0.2;

/** Travel speeds in sheet units per routine second. */
const STYLUS_SPEED = 0.65;
const COMB_SPEED = 0.15;
const MARK_SPEED = 0.24;
/** Pause between the stages of a routine. */
const STAGE_GAP = 1.2;

/** Pointer combing and dropping, before the scale knob. */
const DRAG_START = 0.012;
const DRAG_ALPHA = 0.07;
const DRAG_LAMBDA = 0.01;
const DRAG_RANGE = 0.2;
const CLICK_RADIUS = 0.06;

// ---- geometry -----------------------------------------------------------------------------------

/** One ink region: a closed polygon. */
interface Blob {
  /** x0, y0, x1, y1, ... (capacity may exceed 2n). */
  xy: Float64Array;
  n: number;
  /** CSS colour, or null for clear water that only pushes the ink aside. */
  color: string | null;
  /** Still spreading from its drop: too small to merge vertices yet. */
  fresh: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A stylus or comb drawn through the ink along a straight path (Lu et al.'s tine line). */
interface Tool {
  /** A point on the path, and the unit direction of travel. */
  ox: number;
  oy: number;
  mx: number;
  my: number;
  /** Largest shift α and sharpness λ. */
  alpha: number;
  lambda: number;
  /** Distance between the tines of a comb across the path; 0 for a single stylus. */
  spacing: number;
  /** Wavy tines: amplitude across the path, wavenumber along it (radians per unit), phase. */
  amp: number;
  wave: number;
  phase: number;
  /**
   * How far across its path a single stylus still moves the ink. Lu et al.'s tine reaches across the
   * whole tray with a slow 1/d tail that drags every stone in view by a cell or two as it passes,
   * which reads as the sheet crawling; here the shift fades out smoothly by this distance.
   */
  range: number;
}

function circle(x: number, y: number, finalRadius: number, color: string | null): Blob {
  const n = Math.min(720, Math.max(24, Math.ceil((TAU * finalRadius) / (MAX_EDGE * 0.8))));
  const xy = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n;
    xy[2 * i] = x + SPAWN_RADIUS * Math.cos(a);
    xy[2 * i + 1] = y + SPAWN_RADIUS * Math.sin(a);
  }
  return {
    xy,
    n,
    color,
    fresh: true,
    minX: x - SPAWN_RADIUS,
    minY: y - SPAWN_RADIUS,
    maxX: x + SPAWN_RADIUS,
    maxY: y + SPAWN_RADIUS,
  };
}

/** A slice of Lu et al.'s ink drop at (cx, cy): every |p - c|² grows by dr2. */
function spread(blobs: readonly Blob[], cx: number, cy: number, dr2: number): void {
  if (dr2 <= 0) return;
  for (const blob of blobs) {
    const xy = blob.xy;
    const end = blob.n * 2;
    for (let i = 0; i < end; i += 2) {
      const dx = (xy[i] ?? 0) - cx;
      const dy = (xy[i + 1] ?? 0) - cy;
      const k = Math.sqrt(1 + dr2 / Math.max(dx * dx + dy * dy, 1e-12));
      xy[i] = cx + dx * k;
      xy[i + 1] = cy + dy * k;
    }
  }
}

/** How far ahead of and behind its tip a tool moves the ink; wide enough that ink never outruns it. */
function windowWidth(alpha: number): number {
  return Math.max(0.04, 1.4 * alpha);
}

/** 0 while the tip is well short of a point, 1 once it is well past; u in window widths. */
function passed(u: number): number {
  if (u <= -1) return 0;
  if (u >= 1) return 1;
  const s = (u + 1) * 0.5;
  return s * s * (3 - 2 * s);
}

/**
 * Move the tool's tip from `tip0` to `tip1` along its path. Each vertex gets the share of the tine
 * shift z = α λ / (d + λ) that the tip delivered in passing it; for a comb, d is to the nearest tine
 * on either side and both contribute; a stylus's shift fades as (1 - d²/range²)² to nothing at its
 * range. The shift depends only on d, so the map still preserves area. The window's slope stays
 * below 1/α per unit of travel, so ink on the line falls behind the tine instead of riding along
 * with it forever.
 */
function sweep(blobs: readonly Blob[], tool: Tool, tip0: number, tip1: number): void {
  if (!(tip1 > tip0)) return;
  const { ox, oy, mx, my, alpha, lambda, spacing, amp, wave, phase, range } = tool;
  const nx = -my;
  const ny = mx;
  const w = windowWidth(alpha);
  const steps = Math.ceil((tip1 - tip0) / (w * 0.5));
  for (let step = 0; step < steps; step++) {
    const a = tip0 + ((tip1 - tip0) * step) / steps;
    const b = tip0 + ((tip1 - tip0) * (step + 1)) / steps;
    const lo = a - w;
    const hi = b + w;
    for (const blob of blobs) {
      const xy = blob.xy;
      const end = blob.n * 2;
      for (let i = 0; i < end; i += 2) {
        const qx = (xy[i] ?? 0) - ox;
        const qy = (xy[i + 1] ?? 0) - oy;
        const along = qx * mx + qy * my;
        if (along < lo || along > hi) continue;
        const share = passed((b - along) / w) - passed((a - along) / w);
        if (share <= 0) continue;
        let across = qx * nx + qy * ny;
        if (amp !== 0) across -= amp * Math.sin(wave * along + phase);
        let f: number;
        if (spacing > 0) {
          const d = across - spacing * Math.floor(across / spacing);
          f = lambda / (d + lambda) + lambda / (spacing - d + lambda);
        } else {
          const d = Math.abs(across);
          if (d >= range) continue;
          const fade = 1 - (d * d) / (range * range);
          f = (lambda / (d + lambda)) * fade * fade;
        }
        const z = alpha * f * share;
        xy[i] = (xy[i] ?? 0) + z * mx;
        xy[i + 1] = (xy[i + 1] ?? 0) + z * my;
      }
    }
  }
}

/**
 * A slice of a stir: a Lamb–Oseen vortex of core radius R about c (the viscous vortex of Oseen 1911,
 * Lamb 1932). Ink at distance ρ turns by θ = Γ (1 - e^(-ρ²/R²)) / ρ²: as a solid body inside the
 * core and falling off as 1/ρ² beyond, a pure rotation per circle and so area-preserving like Lu et
 * al.'s strokes. Their circular tine has a cusp at its circle that creases suminagashi rings; breath
 * and fanning bend them smoothly. Γ = α R / 0.638 makes α the largest shift, reached at ρ ≈ 1.12 R.
 */
function swirl(blobs: readonly Blob[], op: SwirlOp, amount: number): void {
  if (amount === 0) return;
  const { cx, cy, radius, alpha } = op;
  const strength = (amount * alpha * radius) / 0.638;
  const core2 = radius * radius;
  for (const blob of blobs) {
    const xy = blob.xy;
    const end = blob.n * 2;
    for (let i = 0; i < end; i += 2) {
      const dx = (xy[i] ?? 0) - cx;
      const dy = (xy[i + 1] ?? 0) - cy;
      const rho2 = dx * dx + dy * dy;
      const theta = strength * (rho2 > 1e-12 ? -Math.expm1(-rho2 / core2) / rho2 : 1 / core2);
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      xy[i] = cx + dx * c - dy * s;
      xy[i + 1] = cy + dx * s + dy * c;
    }
  }
}

/** Whether the segment touches the view rectangle |x| <= hw, |y| <= hh (Liang–Barsky clipping). */
function segmentMeetsRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  hw: number,
  hh: number,
): boolean {
  if (
    (x0 < -hw && x1 < -hw) ||
    (x0 > hw && x1 > hw) ||
    (y0 < -hh && y1 < -hh) ||
    (y0 > hh && y1 > hh)
  )
    return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, x0 + hw) && clip(dx, hw - x0) && clip(-dy, y0 + hh) && clip(dy, hh - y0);
}

/** The region fills the whole view: no edge crosses it and it contains its centre. */
function coversView(blob: Blob, hw: number): boolean {
  if (!(blob.minX < -hw && blob.maxX > hw && blob.minY < -0.5 && blob.maxY > 0.5)) return false;
  const xy = blob.xy;
  const n = blob.n;
  let px = xy[2 * n - 2] ?? 0;
  let py = xy[2 * n - 1] ?? 0;
  let inside = false;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i] ?? 0;
    const y = xy[2 * i + 1] ?? 0;
    if (segmentMeetsRect(px, py, x, y, hw, 0.5)) return false;
    if (y > 0 !== py > 0 && px + ((0 - py) * (x - px)) / (y - py) > 0) inside = !inside;
    px = x;
    py = y;
  }
  return inside;
}

// ---- operations and routines -------------------------------------------------------------------

interface Timed {
  start: number;
  duration: number;
  /** Progress already applied, 0..1. */
  done: number;
}

interface DropOp extends Timed {
  kind: "drop";
  x: number;
  y: number;
  /** Final radius squared. */
  r2: number;
  color: string | null;
  blob: Blob | undefined;
}

interface StrokeOp extends Timed {
  kind: "stroke";
  tool: Tool;
  /** Tip travel along the path, measured from the tool's origin. */
  from: number;
  to: number;
}

interface SwirlOp extends Timed {
  kind: "swirl";
  cx: number;
  cy: number;
  /** Core radius. */
  radius: number;
  /** Largest shift; its sign is the direction of turn. */
  alpha: number;
}

type Op = DropOp | StrokeOp | SwirlOp;

/** Ink spreads fast, then slows as the surface tension evens out. */
const growth = (p: number): number => 1 - (1 - p) * (1 - p) * (1 - p);
/**
 * Share of its travel a stroke has covered at time share p: the hand gets up to an even pace over
 * the first STROKE_RAMP of the time, holds it, and slows over the last, so the tool spends little
 * time creeping off-screen and crosses the view steadily.
 */
function glide(p: number): number {
  const pace = 1 / (1 - STROKE_RAMP);
  if (p < STROKE_RAMP) return (pace * p * p) / (2 * STROKE_RAMP);
  if (p > 1 - STROKE_RAMP) return 1 - (pace * (1 - p) * (1 - p)) / (2 * STROKE_RAMP);
  return pace * (p - STROKE_RAMP / 2);
}
const dropSeconds = (radius: number): number => 0.35 + 3.5 * radius;

function drop(start: number, x: number, y: number, radius: number, color: string | null): DropOp {
  return {
    kind: "drop",
    start,
    duration: dropSeconds(radius),
    done: 0,
    x,
    y,
    r2: radius * radius,
    color,
    blob: undefined,
  };
}

function line(
  ox: number,
  oy: number,
  mx: number,
  my: number,
  alpha: number,
  lambda: number,
  tines: Partial<Pick<Tool, "spacing" | "amp" | "wave" | "phase" | "range">> = {},
): Tool {
  return {
    ox,
    oy,
    mx,
    my,
    alpha,
    lambda,
    spacing: tines.spacing ?? 0,
    amp: tines.amp ?? 0,
    wave: tines.wave ?? 0,
    phase: tines.phase ?? 0,
    range: tines.range ?? Infinity,
  };
}

function stroke(start: number, tool: Tool, from: number, to: number, speed: number): StrokeOp {
  return { kind: "stroke", start, duration: (to - from) / speed, done: 0, tool, from, to };
}

/** Where a stroke's tip is now (on tine 0 of a comb, riding its wave), written into `out`. */
function tipInto(op: StrokeOp, out: { x: number; y: number }): void {
  const { ox, oy, mx, my, amp, wave, phase } = op.tool;
  const along = op.from + (op.to - op.from) * glide(op.done);
  const off = amp * Math.sin(wave * along + phase);
  out.x = ox + mx * along - my * off;
  out.y = oy + my * along + mx * off;
}

function sheetSeed(seed: number, sheet: number): number {
  return (Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(sheet, 0x85ebca6b)) >>> 0;
}

function pick<T>(items: readonly T[], rand: () => number): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("marble: nothing to pick from");
  return item;
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export interface RoutineSpec {
  pattern: MarblePattern;
  palette: MarblePalette;
  /** How the ink is laid, and moved when the pattern combs nothing (see marblePractices). */
  practice: MarblePractice;
  /** Drop sizes and comb spacings scale with this, 0.6..1.4. */
  scale: number;
  aspect: number;
  /** Height of the M the stylus writes at the end, or 0 for none. */
  mark: number;
  rand: () => number;
}

export interface Routine {
  ops: Op[];
  /** Routine time at which the sprinkling is done. */
  sprinkled: number;
  /** Routine time the first drop (the stones' ground) has the tray to itself; 0 when there is none. */
  lead: number;
}

/** The stones' ground drop spreads alone over this many routine seconds; the colours follow. */
const GROUND_SECONDS = 3;

/**
 * Ebru's stone ground (battal). The first colour spreads over the whole tray; then colour after
 * colour is flicked from a brush, each with a little more ox gall so it spreads wider than the last,
 * and an early one comes round again, widest of all. The drop map preserves area, so ink in view
 * only thins as later drops push it out, to about e^-(ink added after it / view area): twice the
 * view's area in drops leaves the ground as veins, and giving each earlier layer 1.3 times the ink of
 * the next keeps every colour's share of the finished sheet about even.
 */
function sprinkleStones(ops: Op[], spec: RoutineSpec): number {
  const { rand } = spec;
  const inks = shuffled(spec.palette.inks, rand);
  const reachX = spec.aspect / 2 + 0.1;
  const reachY = 0.6;
  const gx = (2 * rand() - 1) * reachX * 0.5;
  const gy = (2 * rand() - 1) * reachY * 0.5;
  const ground = Math.hypot(reachX + 0.1 + Math.abs(gx), reachY + 0.1 + Math.abs(gy));
  ops.push({ ...drop(0, gx, gy, ground, pick(inks, rand)), duration: GROUND_SECONDS });
  const layers = [...inks, pick(inks.slice(0, -1), rand)];
  const weight = (layer: number): number => Math.pow(1.3, layers.length - 1 - layer);
  const total = 4 * reachX * reachY * 1.9;
  const weights = layers.reduce((sum, _color, layer) => sum + weight(layer), 0);
  let t = GROUND_SECONDS;
  layers.forEach((color, layer) => {
    const r = 0.1 * spec.scale * Math.pow(0.9, layers.length - 1 - layer);
    const count = Math.max(5, Math.round((total * weight(layer)) / weights / (Math.PI * r * r)));
    const span = 1.5 + count * 0.03;
    for (let i = 0; i < count; i++) {
      const radius = r * (0.75 + 0.5 * rand());
      ops.push(
        drop(
          t + rand() * span,
          (2 * rand() - 1) * reachX,
          (2 * rand() - 1) * reachY,
          radius,
          color,
        ),
      );
    }
    t += span + 0.5;
  });
  return t + 0.6;
}

/**
 * Suminagashi: at each site two brushes touch the water in turn, one with ink (sumi and indigo
 * alternating) and one with clear water, so every drop pushes the last out into a ring.
 */
function sprinkleRings(ops: Op[], spec: RoutineSpec): number {
  const { rand } = spec;
  const inks = spec.palette.inks;
  const sites = 4 + Math.floor(rand() * 3);
  const reachX = Math.max(0.1, spec.aspect / 2 - 0.12);
  let end = 0;
  for (let site = 0; site < sites; site++) {
    const cx = (2 * rand() - 1) * reachX;
    const cy = (2 * rand() - 1) * 0.36;
    const r = 0.055 * spec.scale * (0.85 + 0.3 * rand());
    const count = 2 * (7 + Math.floor(rand() * 5));
    const t0 = site * 2.4 + rand() * 0.6;
    for (let j = 0; j < count; j++) {
      const color = j % 2 === 0 ? (inks[(j / 2 + site) % inks.length] ?? null) : null;
      const jitter = r * 0.12;
      const start = t0 + j * 0.3;
      ops.push(
        drop(start, cx + (2 * rand() - 1) * jitter, cy + (2 * rand() - 1) * jitter, r, color),
      );
      end = Math.max(end, start + dropSeconds(r));
    }
  }
  return end + 0.6;
}

/** Suminagashi is moved by breath and fan rather than combs: three slow eddies, turning by turns. */
function fan(ops: Op[], spec: RoutineSpec, start: number): number {
  const { rand } = spec;
  const spin = rand() < 0.5 ? -1 : 1;
  let end = start;
  for (let k = 0; k < 3; k++) {
    const eddy: SwirlOp = {
      kind: "swirl",
      start: start + k * 3,
      duration: 8,
      done: 0,
      cx: (2 * rand() - 1) * Math.max(0.1, spec.aspect / 2 - 0.25),
      cy: (2 * rand() - 1) * 0.25,
      radius: (0.14 + 0.14 * rand()) * spec.scale,
      alpha: (k % 2 === 0 ? spin : -spin) * 0.15 * spec.scale,
    };
    ops.push(eddy);
    end = Math.max(end, eddy.start + eddy.duration);
  }
  return end;
}

/**
 * Gel-git ("come and go"): a stylus drawn across the tray and back, line after line from the
 * bottom up. The first line runs a third of a spacing or more inside the view, so the very first
 * pass is seen; the last lies within two thirds of a spacing of the top edge. Each pass moves only
 * the ink within two spacings of its line.
 */
function gelGit(ops: Op[], spec: RoutineSpec, start: number): number {
  const g = 0.13 * spec.scale;
  const alpha = 1.2 * g;
  const reach = spec.aspect / 2 + 0.12 + windowWidth(alpha);
  const lines = Math.ceil(1 / g);
  const first = -0.5 + g * (0.35 + 0.3 * spec.rand());
  let t = start;
  for (let k = 0; k < lines; k++) {
    const pass = stroke(
      t,
      line(0, first + g * k, k % 2 === 0 ? 1 : -1, 0, alpha, 0.3 * g, { range: 2 * g }),
      -reach,
      reach,
      STYLUS_SPEED,
    );
    ops.push(pass);
    t += pass.duration + 0.2;
  }
  return t;
}

/** Nonpareil: a fine comb drawn once up the tray, across the gel-git, raising a row of small arches. */
function nonpareil(ops: Op[], spec: RoutineSpec, start: number): number {
  const c = 0.045 * spec.scale;
  const alpha = c;
  const reach = 0.5 + 0.12 + windowWidth(alpha);
  const pass = stroke(
    start,
    line(spec.rand() * c, 0, 0, 1, alpha, 0.12 * c, { spacing: c }),
    -reach,
    reach,
    COMB_SPEED,
  );
  ops.push(pass);
  return start + pass.duration;
}

/** Bouquet: a coarser comb drawn back down the nonpareil in a wave, fanning the arches into sprays. */
function bouquet(ops: Op[], spec: RoutineSpec, start: number): number {
  const c = 0.09 * spec.scale;
  const alpha = 1.4 * c;
  const amp = 0.5 * c;
  const reach = 0.5 + 0.12 + windowWidth(alpha) + amp;
  const tool = line(spec.rand() * c, 0, 0, -1, alpha, 0.1 * c, {
    spacing: c,
    amp,
    wave: TAU / (0.14 * spec.scale),
    phase: spec.rand() * TAU,
  });
  const pass = stroke(start, tool, -reach, reach, COMB_SPEED * 0.8);
  ops.push(pass);
  return start + pass.duration;
}

/** Chevron: a comb drawn up the tray, then back down between its own tracks. */
function chevron(ops: Op[], spec: RoutineSpec, start: number): number {
  const c = 0.16 * spec.scale;
  const alpha = 0.6 * c;
  const lambda = 0.08 * c;
  const reach = 0.5 + 0.12 + windowWidth(alpha);
  const x0 = spec.rand() * c;
  const up = stroke(
    start,
    line(x0, 0, 0, 1, alpha, lambda, { spacing: c }),
    -reach,
    reach,
    COMB_SPEED,
  );
  const down = stroke(
    start + up.duration + 0.6,
    line(x0 + c / 2, 0, 0, -1, alpha, lambda, { spacing: c }),
    -reach,
    reach,
    COMB_SPEED,
  );
  ops.push(up, down);
  return down.start + down.duration;
}

/** A stylus writing the Manifold M through the ink: one tine stroke along each of its four strokes. */
function markStrokes(height: number, start: number): StrokeOp[] {
  const out: StrokeOp[] = [];
  const alpha = 0.16 * height;
  const lambda = 0.02 * height;
  let t = start;
  for (let i = 0; i + 1 < MARK_VERTICES.length; i++) {
    const a = markVertex(i);
    const b = markVertex(i + 1);
    const ax = a[0] * height;
    const ay = a[1] * height;
    const dx = (b[0] - a[0]) * height;
    const dy = (b[1] - a[1]) * height;
    const length = Math.hypot(dx, dy);
    const pass = stroke(
      t,
      line(ax, ay, dx / length, dy / length, alpha, lambda, { range: 0.3 * height }),
      0,
      length,
      MARK_SPEED,
    );
    out.push(pass);
    t += pass.duration;
  }
  return out;
}

/**
 * One sheet's choreography: the practice's sprinkling, then the pattern's strokes (or, for an
 * uncombed suminagashi sheet, breath and the fan), then (optionally) the M.
 */
export function buildRoutine(spec: RoutineSpec): Routine {
  const ops: Op[] = [];
  const rings = spec.practice === "suminagashi";
  const sprinkled = rings ? sprinkleRings(ops, spec) : sprinkleStones(ops, spec);
  let t = sprinkled + STAGE_GAP;
  const pattern = spec.pattern;
  switch (pattern) {
    case "stone":
      if (rings) t = fan(ops, spec, t);
      break;
    case "gel-git":
      t = gelGit(ops, spec, t);
      break;
    case "nonpareil":
      t = gelGit(ops, spec, t) + STAGE_GAP;
      t = nonpareil(ops, spec, t);
      break;
    case "bouquet":
      t = gelGit(ops, spec, t) + STAGE_GAP;
      t = nonpareil(ops, spec, t) + STAGE_GAP;
      t = bouquet(ops, spec, t);
      break;
    case "chevron":
      t = gelGit(ops, spec, t) + STAGE_GAP;
      t = chevron(ops, spec, t);
      break;
    default: {
      const unreachable: never = pattern;
      throw new Error(`marble: unknown pattern ${String(unreachable)}`);
    }
  }
  if (spec.mark > 0) ops.push(...markStrokes(spec.mark, t + STAGE_GAP));
  return { ops, sprinkled, lead: rings ? 0 : GROUND_SECONDS };
}

/** Ops on one clock, handed their progress in start order. */
class Timeline {
  clock = 0;
  #ops: Op[] = [];
  #next = 0;
  #active: Op[] = [];

  reset(ops: Op[] = []): void {
    this.#ops = ops.sort((a, b) => a.start - b.start);
    this.#next = 0;
    this.#active = [];
    this.clock = 0;
  }

  /** Schedule more ops, their start on this clock. */
  add(ops: readonly Op[]): void {
    this.#ops = this.#ops
      .slice(this.#next)
      .concat(ops)
      .sort((a, b) => a.start - b.start);
    this.#next = 0;
  }

  get finished(): boolean {
    return this.#next >= this.#ops.length && this.#active.length === 0;
  }

  /** The latest running stroke: its tool is the one in the tray. */
  get stroke(): StrokeOp | undefined {
    for (let i = this.#active.length - 1; i >= 0; i--) {
      const op = this.#active[i];
      if (op?.kind === "stroke") return op;
    }
    return undefined;
  }

  /** Advance the clock; true when any op moved the ink. */
  advance(dt: number, apply: (op: Op, from: number, to: number) => void): boolean {
    if (!(dt > 0)) return false;
    this.clock += dt;
    for (
      let op = this.#ops[this.#next];
      op !== undefined && op.start <= this.clock;
      op = this.#ops[this.#next]
    ) {
      this.#active.push(op);
      this.#next++;
    }
    let moved = false;
    for (const op of this.#active) {
      const p = op.duration > 0 ? clamp((this.clock - op.start) / op.duration, 0, 1) : 1;
      if (p <= op.done) continue;
      apply(op, op.done, p);
      op.done = p;
      moved = true;
    }
    if (moved) this.#active = this.#active.filter((op) => op.done < 1);
    return moved;
  }
}

// ---- the simulation ----------------------------------------------------------------------------

type MarbleKnob =
  "pattern" | "palette" | "practice" | "tempo" | "scale" | "renew" | "sheetSeed" | "stylus";

interface Settings {
  pattern: MarblePattern;
  palette: MarblePalette;
  practice: MarblePractice;
  tempo: number;
  /** Drop sizes and comb spacings, 0.6..1.4. */
  scale: number;
  seed: number;
  /** Seconds a finished sheet rests before it is lifted; undefined while new sheets are off. */
  rest: number | undefined;
  /** Height of the M written at the end of each sheet; 0 while the stylus is off. */
  mark: number;
  /** Height of the M the "now" button writes. */
  markNow: number;
}

const markHeight = (amount: number): number => 0.35 + 0.45 * amount;

/**
 * Routine time the entrance's sprinkling has reached `seconds` into the entrance: the ground drop
 * spreads alone for SPRINKLE_LEAD_SECONDS (in view for most of it, see SPRINKLE_GROUND_VIEW), then
 * the drops flicked onto it land fastest at first and ever slower, so they arrive on the flood's
 * heels and the last settle.
 */
function sprinkleAt(seconds: number, lead: number, sprinkled: number): number {
  if (!(seconds > 0)) return 0;
  const leadSeconds = lead > 0 ? SPRINKLE_LEAD_SECONDS : 0;
  if (seconds < leadSeconds) {
    const u = seconds / leadSeconds;
    const v = u / SPRINKLE_GROUND_SHARE;
    const shown =
      v < 1
        ? SPRINKLE_GROUND_VIEW * v * v
        : SPRINKLE_GROUND_VIEW +
          ((1 - SPRINKLE_GROUND_VIEW) * (u - SPRINKLE_GROUND_SHARE)) / (1 - SPRINKLE_GROUND_SHARE);
    return lead * shown;
  }
  const u = clamp((seconds - leadSeconds) / (SPRINKLE_SECONDS - leadSeconds), 0, 1);
  return lead + (sprinkled - lead) * (1 - (1 - u) * (1 - u));
}

interface ShownTool {
  x: number;
  y: number;
  mx: number;
  my: number;
  spacing: number;
  on: number;
}

class MarbleSim implements SceneSim {
  readonly #gl: WebGL2RenderingContext;
  readonly #knobs: KnobReader<MarbleKnob>;
  readonly #ink: DataTexture;
  readonly #state: DataTexture;
  readonly #stateData = new Float32Array(8);
  readonly #canvas = new OffscreenCanvas(1, 1);
  readonly #ctx: OffscreenCanvasRenderingContext2D;

  #blobs: Blob[] = [];
  #scratch = new Float64Array(1 << 15);
  #vertices = 0;

  /** The choreography, on the idle clock (motion × tempo); it waits while someone plays. */
  readonly #routine = new Timeline();
  /** Triggered strokes (the M), on the event clock (tempo; they play even at motion 0). */
  readonly #events = new Timeline();
  /** Drops from clicks, in real time. */
  readonly #user = new Timeline();

  #phase: "routine" | "rest" | "lift" = "routine";
  #rested = 0;
  #lift = 0;
  #liftSeconds = LIFT_SECONDS;
  /** The running lift was asked for (new sheet, changed settings): it runs on real time. */
  #liftNow = false;
  /** Settings changed: start the run of sheets over and show the next one already sprinkled. */
  #fresh = false;
  #prerollTo = 0;
  /** 0..1: a prerolled sheet fading up from the bare tray once it is laid (1: nothing to fade). */
  #arrive = 1;
  /**
   * Entered with a passage (decided on the first frame): the first sheet's sprinkling is played live
   * on `#stageClock` (frame time since the sheet began) instead of being prerolled out of sight.
   */
  #entering: boolean | undefined = undefined;
  #stageNext = false;
  #staging = false;
  #stageClock = 0;
  #stageTarget = 0;
  /** Routine seconds the sheet's ground drop has the tray to itself (Routine.lead). */
  #lead = 0;
  /** The scene is leaving: the sheet on the tray is not renewed under the paper that takes it. */
  #exiting = false;
  /** The frame's wall clock (SimFrame.now) and budget (SimFrame.budget), for the redraw cap and the preroll. */
  #now = 0;
  #budget = PREROLL_BUDGET_MS;
  #sheet = 0;
  #signature: string | undefined;
  /** What the previous frame's settings were, so the unchanged frame builds no signature string. */
  readonly #seen: {
    pattern: MarblePattern | undefined;
    palette: MarblePalette | undefined;
    practice: MarblePractice | undefined;
    scale: number;
    seed: number;
  } = {
    pattern: undefined,
    palette: undefined,
    practice: undefined,
    scale: Number.NaN,
    seed: Number.NaN,
  };
  /** The frame's settings, rewritten in place each frame. */
  readonly #settings: Settings = {
    pattern: "bouquet",
    palette: EBRU,
    practice: "ebru",
    tempo: 1,
    scale: 1,
    seed: 0,
    rest: undefined,
    mark: 0,
    markNow: 0,
  };
  readonly #renewSlot: number;
  readonly #stylusSlot: number;
  /** Whether the fast-forward step in progress moved the ink. */
  #prerollMoved = false;
  readonly #textures: (WebGLTexture | undefined)[] = [undefined, undefined];

  #aspect = 0;
  #dirty = true;
  #force = true;
  #drawnAt = -Infinity;
  #idle = Infinity;
  /** The pointer this frame, and where a press began and a drag was last combed: reused, never reallocated. */
  readonly #at = { x: 0, y: 0 };
  #pressing = false;
  readonly #pressAt = { x: 0, y: 0 };
  readonly #last = { x: 0, y: 0 };
  #dragging = false;
  #dragTool: Tool | undefined;
  #nextInk = 0;
  readonly #jitter = mulberry32(0x6d61726c);
  readonly #shown: ShownTool = { x: 0, y: 0, mx: 1, my: 0, spacing: 0, on: 0 };

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<MarbleKnob>) {
    this.#gl = gl;
    this.#knobs = knobs;
    this.#renewSlot = knobs.trigger("renew");
    this.#stylusSlot = knobs.trigger("stylus");
    const ctx = this.#canvas.getContext("2d");
    if (ctx === null) throw new Error("marble: no 2D canvas context for the ink");
    this.#ctx = ctx;
    this.#ink = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
    this.#state = new DataTexture(gl, {
      width: 2,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const dt = Math.min(Math.max(frame.dt, 0), MAX_STEP);
    this.#now = frame.now;
    this.#budget = Math.max(PREROLL_BUDGET_MS, frame.budget);
    const settings = this.#read(frame);
    this.#fit(frame.aspect);
    if (this.#entering === undefined) this.#entering = frame.passage.enter < 1;
    this.#exiting = frame.passage.exit > 0;
    this.#follow(settings);

    if (frame.fired[this.#renewSlot] === true)
      this.#startLift(settings, QUICK_LIFT_SECONDS, true, false);
    if (frame.fired[this.#stylusSlot] === true)
      this.#events.add(markStrokes(settings.markNow, this.#events.clock + 0.3));

    let moved = this.#play(frame.pointer, settings);
    this.#idle += dt;
    moved = this.#choreograph(dt, frame.motion, settings) || moved;
    moved = this.#events.advance(dt * settings.tempo, this.#apply) || moved;
    moved = this.#user.advance(dt, this.#apply) || moved;
    // A prerolled sheet fades up once it is laid; paused or frozen, it shows at once.
    if (!this.#prerolling)
      this.#arrive = dt > 0 ? Math.min(1, this.#arrive + dt / ARRIVE_SECONDS) : 1;
    if (moved) {
      this.#refine();
      this.#dirty = true;
    }

    this.#showTool(dt);
    this.#render();
    this.#writeState();
    const textures = this.#textures;
    textures[0] = this.#ink.texture;
    textures[1] = this.#state.texture;
    return textures;
  }

  dispose(): void {
    this.#ink.dispose();
    this.#state.dispose();
  }

  #read(frame: SimFrame): Settings {
    const knobs = this.#knobs;
    const settings = this.#settings;
    const renew = knobs.value(frame, "renew");
    const stylus = knobs.value(frame, "stylus");
    settings.pattern = knobs.pick(frame, "pattern", marblePatterns, "bouquet");
    settings.palette = knobs.pick(frame, "palette", marblePalettes, EBRU);
    settings.practice = marblePractice(knobs.value(frame, "practice"), settings.palette);
    settings.tempo = Math.max(0.05, knobs.value(frame, "tempo"));
    settings.scale = 0.6 + 0.8 * knobs.value(frame, "scale");
    settings.seed = Math.round(knobs.value(frame, "sheetSeed"));
    settings.rest = renew > 0 ? 4 + 36 * renew : undefined;
    settings.mark = stylus > 0 ? markHeight(stylus) : 0;
    settings.markNow = markHeight(knobs.amount(frame, "stylus"));
    return settings;
  }

  /** Size the ink canvas to the frame's aspect; the ink itself lives in sheet units and stays. */
  #fit(aspect: number): void {
    const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    if (a === this.#aspect) return;
    this.#aspect = a;
    const width = a >= 1 ? CANVAS_LONG_SIDE : Math.max(1, Math.round(CANVAS_LONG_SIDE * a));
    const height = a >= 1 ? Math.max(1, Math.round(CANVAS_LONG_SIDE / a)) : CANVAS_LONG_SIDE;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    this.#dirty = true;
    this.#force = true;
  }

  /** A new pattern, palette, practice, scale or seed lifts the sheet at once and starts the new one. */
  #follow(settings: Settings): void {
    const seen = this.#seen;
    if (
      seen.pattern === settings.pattern &&
      seen.palette === settings.palette &&
      seen.practice === settings.practice &&
      seen.scale === settings.scale &&
      seen.seed === settings.seed
    )
      return;
    seen.pattern = settings.pattern;
    seen.palette = settings.palette;
    seen.practice = settings.practice;
    seen.scale = settings.scale;
    seen.seed = settings.seed;
    // The scale counts to three places: a change finer than that does not start a new sheet.
    const signature = `${settings.pattern}|${settings.palette.label}|${settings.practice}|${settings.scale.toFixed(3)}|${settings.seed}`;
    if (signature === this.#signature) return;
    const first = this.#signature === undefined;
    this.#signature = signature;
    if (first) {
      this.#fresh = true;
      this.#stageNext = this.#entering === true;
      this.#newSheet(settings);
    } else {
      this.#startLift(settings, QUICK_LIFT_SECONDS, true, true);
    }
  }

  /** Click: a drop of the next ink where the pointer is. Drag: a stylus along the drag. */
  #play(pointer: PointerState, settings: Settings): boolean {
    const at = this.#at;
    at.x = (pointer.x - 0.5) * this.#aspect;
    at.y = pointer.y - 0.5;
    if (pointer.pressed && pointer.inside) {
      this.#pressAt.x = at.x;
      this.#pressAt.y = at.y;
      this.#pressing = true;
      this.#last.x = at.x;
      this.#last.y = at.y;
      this.#dragging = false;
      this.#idle = 0;
      // Someone is playing with the tray: keep the sheet they are working on.
      if (this.#phase === "lift" && !this.#liftNow) {
        this.#phase = "rest";
        this.#rested = 0;
        this.#lift = 0;
      }
    }
    if (!this.#pressing) return false;
    const press = this.#pressAt;
    let moved = false;
    this.#idle = 0;
    if (pointer.down) {
      if (!this.#dragging && Math.hypot(at.x - press.x, at.y - press.y) > DRAG_START)
        this.#dragging = true;
      if (this.#dragging) {
        moved = this.#comb(this.#last, at, settings.scale);
        if (moved) {
          this.#last.x = at.x;
          this.#last.y = at.y;
        }
      }
    }
    if (pointer.released || !pointer.down) {
      if (!this.#dragging) this.#dropAt(press, settings);
      this.#pressing = false;
      this.#dragging = false;
      this.#dragTool = undefined;
    }
    return moved;
  }

  #comb(from: { x: number; y: number }, to: { x: number; y: number }, scale: number): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-5) return false;
    const tool = line(
      from.x,
      from.y,
      dx / length,
      dy / length,
      DRAG_ALPHA * scale,
      DRAG_LAMBDA * scale,
      { range: DRAG_RANGE * scale },
    );
    sweep(this.#blobs, tool, 0, length);
    this.#dragTool = tool;
    return true;
  }

  #dropAt(at: { x: number; y: number }, settings: Settings): void {
    const inks = settings.palette.inks;
    // Suminagashi alternates each ink with clear water, so repeated clicks raise rings.
    const sequence: readonly (string | null)[] =
      settings.practice === "suminagashi" ? inks.flatMap((ink) => [ink, null]) : inks;
    const color = sequence[this.#nextInk % sequence.length] ?? null;
    this.#nextInk++;
    const radius = CLICK_RADIUS * settings.scale * (0.85 + 0.3 * this.#jitter());
    this.#user.add([drop(this.#user.clock, at.x, at.y, radius, color)]);
  }

  #choreograph(dt: number, motion: number, settings: Settings): boolean {
    if (this.#prerolling) return this.#staging ? this.#sprinkle(dt) : this.#fastForward();
    const busy = this.#idle < IDLE_RESUME || this.#pressing || !this.#events.finished;
    const step = busy ? 0 : dt * motion * settings.tempo;
    const phase = this.#phase;
    switch (phase) {
      case "routine": {
        const moved = this.#routine.advance(step, this.#apply);
        if (this.#routine.finished) {
          this.#phase = "rest";
          this.#rested = 0;
        }
        return moved;
      }
      case "rest":
        if (settings.rest !== undefined && !this.#exiting) {
          this.#rested += step;
          if (this.#rested >= settings.rest) this.#startLift(settings, LIFT_SECONDS, false, false);
        }
        return false;
      case "lift":
        this.#lift = Math.min(1, this.#lift + (this.#liftNow ? dt : step) / this.#liftSeconds);
        if (this.#lift >= 1 && !this.#exiting) this.#newSheet(settings);
        return false;
      default: {
        const unreachable: never = phase;
        throw new Error(`marble: unknown phase ${String(unreachable)}`);
      }
    }
  }

  /** A fresh sheet's sprinkling is still being fast-forwarded: nothing of it is drawn yet. */
  get #prerolling(): boolean {
    return this.#prerollTo - this.#routine.clock > 1e-6;
  }

  /**
   * A fresh sheet opens on its stones: sprinkle at full speed, within a frame budget, out of sight
   * (the canvas is only drawn once it is done, and the sheet then fades up from the bare tray).
   */
  #fastForward(): boolean {
    // The sprinkle is a count of steps, the same on every machine; the budget only spreads them over frames.
    const steps = Math.ceil((this.#prerollTo - this.#routine.clock) / PREROLL_STEP) + 1;
    this.#prerollMoved = false;
    runBudgeted(this.#prerollStep, this.#budget, steps);
    return this.#prerollMoved;
  }

  /**
   * The entrance's sprinkling, played live: the very steps of the hidden fast-forward, in the same
   * order, so the sheet ends where the fast-forward leaves it, paced by the entrance's own clock
   * (frame time, so a slow frame delays the sprinkling instead of using it up).
   */
  #sprinkle(dt: number): boolean {
    this.#stageClock += dt;
    const target = sprinkleAt(this.#stageClock, this.#lead, this.#prerollTo);
    if (this.#routine.clock >= target - 1e-6) return false;
    this.#stageTarget = target;
    const steps = Math.ceil((this.#prerollTo - this.#routine.clock) / PREROLL_STEP) + 1;
    this.#prerollMoved = false;
    runBudgeted(this.#sprinkleStep, this.#budget, steps);
    return this.#prerollMoved;
  }

  /**
   * One step toward the entrance's target. The ground drop is alone on the tray until `lead`, so it
   * may take any step (one a frame, spreading smoothly); from there on the preroll's own grid.
   */
  readonly #sprinkleStep = (): boolean => {
    const clock = this.#routine.clock;
    if (clock < this.#lead - 1e-6) {
      if (this.#routine.advance(Math.min(this.#stageTarget, this.#lead) - clock, this.#apply)) {
        this.#refine();
        this.#prerollMoved = true;
      }
    } else {
      this.#prerollStep();
    }
    return !this.#prerolling || this.#routine.clock >= this.#stageTarget - 1e-6;
  };

  /** One fast-forward step; true once the sprinkling is laid. */
  readonly #prerollStep = (): boolean => {
    const step = Math.min(PREROLL_STEP, this.#prerollTo - this.#routine.clock);
    if (this.#routine.advance(step, this.#apply)) {
      this.#refine();
      this.#prerollMoved = true;
    }
    return !this.#prerolling;
  };

  #startLift(settings: Settings, seconds: number, now: boolean, fresh: boolean): void {
    this.#fresh ||= fresh;
    if (this.#phase !== "lift") {
      if (this.#blobs.length === 0) {
        this.#newSheet(settings);
        return;
      }
      this.#phase = "lift";
      this.#lift = 0;
      this.#liftSeconds = seconds;
      this.#liftNow = now;
      return;
    }
    if (now) {
      this.#liftNow = true;
      this.#liftSeconds = Math.min(this.#liftSeconds, seconds);
    }
  }

  #newSheet(settings: Settings): void {
    if (this.#fresh) this.#sheet = 0;
    this.#sheet++;
    const routine = buildRoutine({
      pattern: settings.pattern,
      palette: settings.palette,
      practice: settings.practice,
      scale: settings.scale,
      aspect: this.#aspect,
      mark: settings.mark,
      rand: mulberry32(sheetSeed(settings.seed, this.#sheet)),
    });
    this.#routine.reset(routine.ops);
    const staged = this.#fresh && this.#stageNext;
    this.#stageNext = false;
    this.#staging = staged;
    this.#stageClock = 0;
    this.#lead = routine.lead;
    this.#prerollTo = this.#fresh ? routine.sprinkled : 0;
    this.#arrive = this.#fresh && !staged ? 0 : 1;
    this.#fresh = false;
    this.#events.reset();
    this.#user.reset();
    this.#blobs = [];
    this.#vertices = 0;
    this.#phase = "routine";
    this.#lift = 0;
    this.#rested = 0;
    this.#liftNow = false;
    this.#dirty = true;
    this.#force = true;
  }

  readonly #apply = (op: Op, from: number, to: number): void => {
    switch (op.kind) {
      case "drop": {
        if (op.blob === undefined) {
          op.blob = circle(op.x, op.y, Math.sqrt(op.r2), op.color);
          this.#blobs.push(op.blob);
        }
        spread(this.#blobs, op.x, op.y, op.r2 * (growth(to) - growth(from)));
        if (to >= 1) op.blob.fresh = false;
        return;
      }
      case "stroke": {
        const span = op.to - op.from;
        sweep(this.#blobs, op.tool, op.from + span * glide(from), op.from + span * glide(to));
        return;
      }
      case "swirl":
        swirl(this.#blobs, op, smoothstep(0, 1, to) - smoothstep(0, 1, from));
        return;
      default: {
        const unreachable: never = op;
        throw new Error(`marble: unknown operation ${String(unreachable)}`);
      }
    }
  };

  /** Resample every region, drop the ones far outside the view and those hidden under a cover. */
  #refine(): void {
    const hw = this.#aspect / 2;
    const maxEdge = MAX_EDGE * Math.max(1, Math.sqrt(this.#vertices / VERTEX_TARGET));
    const insert = this.#vertices < VERTEX_CAP;
    const kept: Blob[] = [];
    let total = 0;
    for (const blob of this.#blobs) {
      if (!this.#resample(blob, hw, maxEdge, insert)) continue;
      if (
        blob.maxX < -hw - CULL_MARGIN ||
        blob.minX > hw + CULL_MARGIN ||
        blob.maxY < -0.5 - CULL_MARGIN ||
        blob.minY > 0.5 + CULL_MARGIN
      )
        continue;
      kept.push(blob);
      total += blob.n;
    }
    // Drops only ever push older ink outward, so a region that covers the view is drawn over
    // everything older that is still in it.
    for (let i = kept.length - 1; i > 0; i--) {
      const blob = kept[i];
      if (blob === undefined || !coversView(blob, hw)) continue;
      for (const hidden of kept.splice(0, i)) total -= hidden.n;
      break;
    }
    this.#blobs = kept;
    this.#vertices = total;
  }

  /**
   * Insert vertices on edges longer than `maxEdge` near the view, and merge a vertex into its
   * neighbours where they are close and it sits (nearly) on the chord between them; far outside
   * the view edges may grow long and coarse. False when the region has collapsed.
   */
  #resample(blob: Blob, hw: number, maxEdge: number, insert: boolean): boolean {
    const n = blob.n;
    const src = blob.xy;
    const nearX = hw + REFINE_MARGIN;
    const nearY = 0.5 + REFINE_MARGIN;
    const maxEdge2 = maxEdge * maxEdge;
    const mergeNear2 = (maxEdge * MERGE_SHARE) ** 2;
    let out = this.#scratch;
    let k = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const put = (x: number, y: number): void => {
      if (k + 2 > out.length) {
        const grown = new Float64Array(out.length * 2);
        grown.set(out);
        out = grown;
      }
      out[k++] = x;
      out[k++] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    let lx = src[0] ?? 0;
    let ly = src[1] ?? 0;
    let changed = false;
    put(lx, ly);
    for (let i = 1; i <= n; i++) {
      const j = i === n ? 0 : i;
      const cx = src[2 * j] ?? 0;
      const cy = src[2 * j + 1] ?? 0;
      const near = Math.abs(cx) < nearX && Math.abs(cy) < nearY;
      if (i < n && !blob.fresh) {
        const after = i + 1 === n ? 0 : i + 1;
        const ex = (src[2 * after] ?? 0) - lx;
        const ey = (src[2 * after + 1] ?? 0) - ly;
        const chord2 = ex * ex + ey * ey;
        if (chord2 < (near ? mergeNear2 : MERGE_FAR * MERGE_FAR)) {
          const cross = ex * (cy - ly) - ey * (cx - lx);
          const flat = near ? FLAT_NEAR : FLAT_FAR;
          if (cross * cross <= flat * flat * chord2) {
            changed = true;
            continue;
          }
        }
      }
      if (insert) {
        const dx = cx - lx;
        const dy = cy - ly;
        const e2 = dx * dx + dy * dy;
        if (e2 > maxEdge2 && (near || (Math.abs(lx) < nearX && Math.abs(ly) < nearY))) {
          const pieces = Math.min(MAX_SPLIT, Math.ceil(Math.sqrt(e2) / maxEdge));
          for (let s = 1; s < pieces; s++) put(lx + (dx * s) / pieces, ly + (dy * s) / pieces);
          changed = true;
        }
      }
      if (i < n) {
        put(cx, cy);
        lx = cx;
        ly = cy;
      }
    }
    this.#scratch = out;
    if (k < 6) return false;
    if (changed) {
      // Copy back by hand: a subarray view per region per frame is garbage the collector stalls on.
      if (blob.xy.length < k) blob.xy = new Float64Array(k * 2);
      const xy = blob.xy;
      for (let i = 0; i < k; i++) xy[i] = out[i] ?? 0;
      blob.n = k / 2;
    }
    blob.minX = minX;
    blob.minY = minY;
    blob.maxX = maxX;
    blob.maxY = maxY;
    return true;
  }

  /** The stylus or comb in the tray: the pointer's while dragging, else the running stroke's. */
  #showTool(dt: number): void {
    const shown = this.#shown;
    const drag = this.#dragging ? this.#dragTool : undefined;
    let following = false;
    if (drag !== undefined) {
      shown.x = this.#last.x;
      shown.y = this.#last.y;
      shown.mx = drag.mx;
      shown.my = drag.my;
      shown.spacing = 0;
      following = true;
    } else {
      const op =
        this.#events.stroke ?? (this.#phase === "routine" ? this.#routine.stroke : undefined);
      if (op !== undefined) {
        tipInto(op, shown);
        shown.mx = op.tool.mx;
        shown.my = op.tool.my;
        shown.spacing = op.tool.spacing;
        following = true;
      }
    }
    if (!following) {
      shown.on = Math.max(0, shown.on - dt / TOOL_FADE);
      return;
    }
    shown.on = Math.min(1, shown.on + dt / TOOL_FADE);
  }

  #render(): void {
    // A sheet still being prerolled is drawn once, when it is laid, not step by step.
    if (!this.#dirty || (this.#prerolling && !this.#staging)) return;
    const now = this.#now;
    if (!this.#force && now - this.#drawnAt < REDRAW_MS) return;
    this.#draw();
    // The canvas is premultiplied; keeping it so lets the GPU filter across ink/bare edges without
    // the black fringe that straight alpha (rgb 0 where bare) would bleed in.
    const gl = this.#gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.#ink.uploadImage(this.#canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.#dirty = false;
    this.#force = false;
    this.#drawnAt = now;
  }

  /** Fill the regions in drop order; clear water erases what lies beneath it. */
  #draw(): void {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const hw = this.#aspect / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(width / this.#aspect, 0, 0, -height, width / 2, height / 2);
    for (const blob of this.#blobs) {
      if (blob.maxX < -hw || blob.minX > hw || blob.maxY < -0.5 || blob.minY > 0.5) continue;
      const xy = blob.xy;
      const end = blob.n * 2;
      ctx.beginPath();
      ctx.moveTo(xy[0] ?? 0, xy[1] ?? 0);
      for (let i = 2; i < end; i += 2) ctx.lineTo(xy[i] ?? 0, xy[i + 1] ?? 0);
      ctx.closePath();
      if (blob.color === null) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "#000";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = blob.color;
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * uSim1: texel 0 = tool tip (uv), tool shown 0..1, ink veiled 0..1 (lifted off, or a fresh sheet
   * not yet faded up); texel 1 = direction, tine spacing.
   */
  #writeState(): void {
    const data = this.#stateData;
    const shown = this.#shown;
    data[0] = shown.x / this.#aspect + 0.5;
    data[1] = shown.y + 0.5;
    data[2] = shown.on;
    data[3] = Math.max(
      this.#phase === "lift" ? smoothstep(0, 1, this.#lift) : 0,
      1 - smoothstep(0, 1, this.#arrive),
    );
    data[4] = shown.mx;
    data[5] = shown.my;
    data[6] = shown.spacing;
    data[7] = 0;
    this.#state.upload(data);
  }
}

/** The marbling tray, for a scene whose `params` carry the knobs `MarbleKnob` names. */
export function marbleSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<MarbleKnob>("marble", params, [
    "pattern",
    "palette",
    "practice",
    "tempo",
    "scale",
    "renew",
    "sheetSeed",
    "stylus",
  ]);
  return (gl) => new MarbleSim(gl, knobs);
}
