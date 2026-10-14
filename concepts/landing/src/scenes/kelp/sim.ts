// The kelp forest's moving parts, worked out on the CPU for shader.ts.
//
// Giant kelp: every stipe is a buoyant Verlet chain (src/sims/verlet.ts) pinned to its holdfast on
// the sea floor. The gas bladders along it lift it taut; water drag pulls each point toward the
// local flow (dv/dt = DRAG · (u − v)). The flow is the swell's surge, a slow back-and-forth that
// travels across the forest as a long wave (two components, so it never quite repeats), with a
// little vertical orbit near the surface; a steady current the forest leans into; now and then a
// big swell rolling through from one side; and the diver's hand: dragging the pointer stirs a wake
// that pushes the kelp aside. A grown plant is longer than the water is deep: its lift fades in a
// damped band under the surface, so its top bends over and lies along the surface, trailing
// downstream, and its blades hang there as the canopy.
//
// Seen side-on, the forest stands in four depth layers (KELP_LAYERS), each a row of slots holding
// at most one plant. A layer is simulated in its own screen units: lengths, flows and buoyancy are
// scaled by its perspective scale, which leaves the timing of the motion the same at every depth,
// so a far stipe sways exactly as a near one would, only smaller. The surge's phase runs on world
// x (screen x over the scale), so the wave reaches near and far kelp at the right place.
//
// Each blade streams with the water flowing past its node (flow minus the node's own velocity),
// against its buoyancy; that lean, relative to the stipe and eased over BLADE_EASE, rides in the w
// of the point texture. The kelp density knob shows a share of the slots (by a seeded rank), fading
// plants in from the haze and back; the near layer keeps the middle of the frame clear until the
// forest is dense, framing the page.
//
// Also: a school of small silver fish (boids, fixed steps of FISH_STEP), flashing as they turn and
// scattering from the hand; a sea lion gliding past far off now and then; and the hand's fading
// trail, where the night plankton sparks.
//
// Textures:
//   uSim0  rgba16f PointTexture, two texels per point, KELP_POINTS per stipe in stipe order:
//          xyz = position − KELP_ORIGIN, w = blade lean (radians, from the stipe toward screen +x);
//          then velocity xyz (screen heights/s), w = speed.
//   uSim1  rgba16f KELP_STATE_WIDTH × 5, nearest:
//          row 0, per stipe: min x, max x of its rising part, top y of it, presence 0..1 (0 = not drawn)
//          row 1, per fish: x, y, heading cos, sin (screen heights from the frame's centre/bottom)
//          row 2, per fish: body length (0 = hidden), flash 0..1, flank (1 broadside, less turned
//                 toward or away), shown 0..1
//          row 3, globals: KELP_GLOBAL columns (see there)
//          row 4, per stipe: the node its rising part ends at (the first at the surface, else the
//                 top), the x it reaches the surface at, the farthest x it floats to, link length
//          row 5, per stipe: its own perspective scale (its layer's, jittered by DEPTH_JITTER), 0, 0, 0
//   uSim2  r8 the hand's fading trail (TrailField), linear, uv.
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import { TrailField } from "../../sims/trail.ts";
import { PointTexture, VerletSystem, type VerletForce, type VerletStepOptions } from "../../sims/verlet.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

const TAU = Math.PI * 2;

/** The side-on camera. Screen heights; x from the frame's centre, y up from its bottom edge. */
export const KELP_VIEW = {
  /** Eye level: where the floor and the surface meet in the haze. */
  horizon: 0.4,
  /** How far the floor lies below eye level, and the surface above it, at the nearest layer. */
  floor: 0.52,
  surface: 0.8,
  /** Focal length: Snell's window (48.6° off the vertical) opens over the top tenth of the frame. */
  focal: 0.58,
} as const;

/** Links per stipe; a stipe has one more point than links. */
export const KELP_SEGMENTS = 12;
export const KELP_POINTS = KELP_SEGMENTS + 1;
/** Plants are this far apart at the nearest layer (screen heights), one per slot. */
const SPACING = 0.45;
/** Half the width the forest is laid out over: a 21:9 frame with the sway to spare. */
const HALF_SPAN = 1.55;
/** Perspective scale of each layer, and how far its slots are shifted (in slots) off the others. */
const LAYER_SCALES = [1, 0.7, 0.48, 0.32] as const;
const LAYER_SHIFT = [0, 0.37, 0.71, 0.13] as const;
/**
 * Stipe length over the water's depth. A grown plant is longer than the water is deep: its top
 * reaches the surface and trails along it downstream, some a little way, some far, and its blades
 * hang there as the canopy. A young plant (YOUNG_SHARE of them) stops short in mid-water.
 */
const GROWN_MIN = 1.05;
const GROWN_MAX = 1.6;
const YOUNG_MIN = 0.5;
const YOUNG_MAX = 0.85;
const YOUNG_SHARE = 0.22;
/** Each plant stands a little nearer or farther than its layer: ± half this share of its scale. */
const DEPTH_JITTER = 0.1;

export interface KelpLayer {
  /** Perspective scale: 1 at the nearest layer, smaller farther off. */
  readonly scale: number;
  /** Width of a slot, screen heights. */
  readonly spacing: number;
  /** Left edge of slot 0, screen heights from the frame's centre. */
  readonly left: number;
  readonly slots: number;
  /** The layer's first stipe. */
  readonly first: number;
}

export const KELP_LAYERS: readonly KelpLayer[] = (() => {
  const layers: KelpLayer[] = [];
  let first = 0;
  LAYER_SCALES.forEach((scale, l) => {
    const spacing = SPACING * scale;
    const slots = Math.ceil((2 * HALF_SPAN) / spacing);
    layers.push({ scale, spacing, left: (-0.5 * slots + (LAYER_SHIFT[l] ?? 0)) * spacing, slots, first });
    first += slots;
  });
  return layers;
})();
export const KELP_STIPES = KELP_LAYERS.reduce((n, layer) => n + layer.slots, 0);
const POINT_COUNT = KELP_STIPES * KELP_POINTS;
/** Texels per row of the point texture: every point's two texels in one row. */
export const KELP_POINT_ROW = 2 * POINT_COUNT;
/** Subtracted from positions before packing (half floats are finest near 0): mid-frame. */
export const KELP_ORIGIN = [0, 0.5, 0] as const;

/** The school: its depth (perspective scale), most fish, and the band of water it keeps to. */
export const KELP_FISH = { scale: 0.8, max: 32, low: 0.3, high: 0.76 } as const;
/** The sea lion: its depth and length (screen heights). */
export const KELP_VISITOR = { scale: 0.5, length: 0.095 } as const;
/**
 * The Manifold M of piled stones on the floor: its depth (perspective scale), the world x it
 * stands at, its height in world units at size 0 and 1, and its half-width in mark units (the M's
 * strokes plus the stones on them). The plants nearer than it give it a clearing.
 */
export const KELP_MARK = { scale: 0.62, x: 0.52, low: 0.15, high: 0.32, halfWidth: 0.6 } as const;

/**
 * The surge, in world units (screen heights at the nearest layer): u(x, t) = speed · surge knob ·
 * (sin(φ1 − k1·x) + second · sin(φ2 − k2·x + phase2)), with φ2 turning `ratio` times as fast as φ1.
 * Wavelengths of 5.2 and 8.9: the sway travels across the forest without ever lining up.
 */
export const KELP_SURGE = { speed: 0.32, k1: TAU / 5.2, k2: TAU / 8.9, second: 0.35, ratio: 1 / 2.37, phase2: 1.3, current: 0.16 } as const;
/**
 * A big swell: a displacement amplitude · sin²(π τ / span) · sin(2π τ / period) of the water, its
 * front starting `start` world units upstream and running at `speed`; τ is the time since the
 * front passed.
 */
export const KELP_SWELL = { amplitude: 0.62, period: 10, span: 15, start: 4.8, speed: 1.3 } as const;
const SWELL_END = KELP_SWELL.span + (2 * KELP_SWELL.start) / KELP_SWELL.speed;

/** State texture rows, and the columns of the globals row. */
export const KELP_ROW = { stipes: 0, fishPose: 1, fishLook: 2, globals: 3, canopy: 4, scale: 5 } as const;
/**
 * Globals (row 3):
 *   phases       cos φ1, sin φ1, cos φ2, sin φ2 of the surge
 *   flow         surge speed (world units/s), φ1's rate (rad/s), current (world units/s), swell age (s, −1 idle)
 *   school       the school's box: min x, min y, max x, max y
 *   visitorPose  the sea lion: x, y, heading (rad), shown 0..1
 *   visitorLook  fore-flipper stroke 0..1, facing (±1), swell direction (±1), 0
 */
export const KELP_GLOBAL = { phases: 0, flow: 1, school: 2, visitorPose: 3, visitorLook: 4 } as const;
export const KELP_STATE_WIDTH = Math.max(KELP_STIPES, KELP_FISH.max, 5);
const STATE_ROWS = 6;

// ---- kelp physics -------------------------------------------------------------------------------
/** Lift of the gas bladders, screen heights/s² at the nearest layer: a ~4 s natural sway. */
const BUOYANCY = 2;
/** Water drag rate (1/s): the kelp follows the flow with a lag of about 1/DRAG. */
const DRAG = 1.6;
/** Bending stiffness of a stipe (skip-one constraints): enough for a smooth curve, no more. */
const BEND = 0.2;
/** Vertical orbit of the surge at the surface, relative to its horizontal speed. */
const ORBIT = 0.12;
/**
 * The band under the surface (world units) where a floating stipe's lift fades to nothing (and
 * turns to a push down above it), and how hard its bobbing there is damped (1/s): critically, so
 * the canopy settles on the surface instead of ringing.
 */
const SURFACE_BAND = 0.04;
const SURFACE_DAMP = 14;
/** Extra drag (1/s) on a floating top's sideways motion: the canopy follows the surge only in part. */
const CANOPY_DRAG = 4;
/** Share of the surge (and of a swell) a floating top is sheltered from, so the drift beats it. */
const CANOPY_SHELTER = 0.7;
/**
 * The surface drift (world units/s, each plant 0.6–1.4 of it): a steady flow along the surface in
 * the current's direction (to the right while it is still), stronger than the surge there, so every
 * floating top trails downstream, all to one side, instead of folding back and forth.
 */
const SURFACE_DRIFT = 0.16;
/**
 * Lift per layer, near to far, as a share of BUOYANCY: the near plants hold more upright, so the
 * largest kelp in the frame sways least across the dither and frames the page calmly.
 */
const LAYER_LIFT = [1.6, 1.45, 1.15, 1] as const;
/** A node within this many bands of the surface counts as floating (the canopy starts there). */
const FLOATING = 1.5;
/** Blades stream with the relative flow: lean = atan(STREAM · flow), at most BLADE_MAX. */
const BLADE_STREAM = 4.5;
const BLADE_MAX = 1.25;
/** Seconds a blade takes to swing to its new lean. */
const BLADE_EASE = 0.35;
/** Seconds a plant takes to emerge from (or fade into) the haze when the density knob moves. */
const PRESENCE_EASE = 1.6;
/** Seconds of sway simulated before the first frame, in steps of PREWARM_STEP. */
const PREWARM = 3;
const PREWARM_STEP = 0.1;

// ---- the hand -----------------------------------------------------------------------------------
/** The wake's radius (screen heights) and how hard it pushes, per layer near to far. */
const HAND_RADIUS = 0.13;
const HAND_REACH = [1, 0.7, 0.45, 0.3] as const;
const HAND_GAIN = 1.6;
/** The hand's velocity is smoothed over this many seconds, and capped (screen heights/s). */
const HAND_SMOOTH = 0.06;
const HAND_MAX_SPEED = 1.5;
/** Seconds the wake takes to settle once the button is let go. */
const HAND_RELEASE = 0.25;
/** The plankton trail: grid, brush radius (uv heights), strength per stroke, half-life (s). */
const TRAIL_W = 128;
const TRAIL_H = 72;
const TRAIL_RADIUS = 0.035;
const TRAIL_STRENGTH = 0.5;
const TRAIL_HALF_LIFE = 1.4;

// ---- events ---------------------------------------------------------------------------------------
/** Seconds between big swells at frequency 0 and 1 (randomised ±40%), and before the first. */
const SWELL_RARE = 150;
const SWELL_OFTEN = 25;
const SWELL_FIRST = 30;
/** The sea lion: speed (screen heights/s at its depth), margin off screen, a stroke every STROKE s. */
const VISITOR_SPEED = 0.11;
const VISITOR_MARGIN = 0.12;
const VISITOR_STROKE = 2.6;
const VISITOR_RARE = 170;
const VISITOR_OFTEN = 35;
const VISITOR_FIRST = 18;

// ---- the school -----------------------------------------------------------------------------------
const FISH_STEP = 1 / 60;
const FISH_MAX_STEPS = 8;
/**
 * Neighbour radii (screen heights): keep apart (each fish its own, ±30%), swim alike, keep
 * together; and how strongly. A loose school: they align, but not in ranks.
 */
const FISH_SEPARATION = 0.04;
const FISH_ALIGN = 0.12;
const FISH_COHESION = 0.2;
const FISH_ALIGN_PULL = 0.9;
const FISH_COHESION_PULL = 0.5;
/** Each fish's own slow wandering (screen heights/s²), so headings and spacing vary. */
const FISH_WANDER = 0.04;
/** Speeds (screen heights/s): cruising, slowest, fastest, and the extra a fright allows. */
const FISH_CRUISE = 0.06;
const FISH_MIN = 0.035;
const FISH_MAX = 0.09;
const FISH_FRIGHT_SPEED = 0.32;
/**
 * Body length (screen heights at the school's depth): small fish, a few cells long, varied ±20%
 * and ±25% more by how near or far in the school's depth each swims.
 */
const FISH_LENGTH = 0.024;
/** A click scatters fish within this radius; dragging the hand repels them within FLEE. */
const FISH_SCATTER = 0.35;
const FISH_FLEE = 0.18;
/** Seconds a fright lasts, and a fish takes to fade in or out when the count changes. */
const FISH_FRIGHT_TIME = 2;
const FISH_FADE = 1.2;

type KnobKey = "surge" | "period" | "current" | "swell" | "density" | "kelpSeed" | "fish" | "visitor" | "mark";
const KNOB_KEYS: readonly KnobKey[] = ["surge", "period", "current", "swell", "density", "kelpSeed", "fish", "visitor", "mark"];

/** Fixed base seed: the same arrangement number always grows the same forest. */
const SEED = 0x6b31f00d;

/** The diver's hand: where it is (screen heights), its smoothed velocity, and how present (0..1). */
interface Hand {
  x: number;
  y: number;
  vx: number;
  vy: number;
  on: number;
}

/**
 * The school of fish, flown as boids in screen heights at the school's depth. Loose and in depth:
 * each fish keeps its own distance, wanders a little on its own, swims a little nearer or farther
 * (bigger or smaller), and now and then turns toward or away from the eye, foreshortening.
 */
class School {
  readonly x = new Float32Array(KELP_FISH.max);
  readonly y = new Float32Array(KELP_FISH.max);
  readonly vx = new Float32Array(KELP_FISH.max);
  readonly vy = new Float32Array(KELP_FISH.max);
  readonly heading = new Float32Array(KELP_FISH.max);
  readonly turn = new Float32Array(KELP_FISH.max);
  readonly flash = new Float32Array(KELP_FISH.max);
  /** How much of its side a fish shows: 1 broadside, less as it turns toward or away. */
  readonly flank = new Float32Array(KELP_FISH.max);
  readonly shown = new Float32Array(KELP_FISH.max);
  readonly size = new Float32Array(KELP_FISH.max);
  readonly #phase = new Float32Array(KELP_FISH.max);
  readonly #spread = new Float32Array(KELP_FISH.max);
  readonly #ax = new Float32Array(KELP_FISH.max);
  readonly #ay = new Float32Array(KELP_FISH.max);
  #clock = 0;
  readonly #stepper = new FixedStep(FISH_STEP, FISH_MAX_STEPS);
  #fright = 0;
  /** The wander target, as last worked out by #aim. */
  #tx = 0;
  #ty = 0.5;

  /** A loose shoal around the wander target, all heading the same way. */
  place(random: Random, aspect: number, count: number): void {
    this.#clock = random.next() * 400;
    this.#aim(aspect);
    const tx = this.#tx;
    const ty = this.#ty;
    for (let i = 0; i < KELP_FISH.max; i++) {
      const a = random.next() * TAU;
      const r = 0.12 * Math.sqrt(random.next());
      this.x[i] = tx + r * Math.cos(a) * 1.6;
      this.y[i] = ty + r * Math.sin(a) * 0.7;
      this.vx[i] = FISH_CRUISE;
      this.vy[i] = 0;
      this.heading[i] = 0;
      this.turn[i] = 0;
      this.flash[i] = 0;
      this.flank[i] = 1;
      this.shown[i] = i < count ? 1 : 0;
      const depth = 2 * random.next() - 1;
      this.size[i] = FISH_LENGTH * (0.8 + 0.4 * random.next()) * (1 + 0.25 * depth);
      this.#phase[i] = random.next();
      this.#spread[i] = 0.7 + 0.6 * random.next();
    }
  }

  /** Scatter from a click at (hx, hy). */
  scatter(hx: number, hy: number): void {
    for (let i = 0; i < KELP_FISH.max; i++) {
      const dx = (this.x[i] ?? 0) - hx;
      const dy = (this.y[i] ?? 0) - hy;
      const d = Math.hypot(dx, dy);
      if (d >= FISH_SCATTER || d < 1e-5) continue;
      const k = 0.45 * (1 - d / FISH_SCATTER) ** 2;
      this.vx[i] = (this.vx[i] ?? 0) + (dx / d) * k;
      this.vy[i] = (this.vy[i] ?? 0) + (dy / d) * k;
    }
    this.#fright = 1;
  }

  advance(dt: number, count: number, aspect: number, hand: Hand): void {
    const steps = this.#stepper.advance(dt);
    for (let i = 0; i < steps; i++) this.#step(FISH_STEP, count, aspect, hand);
  }

  /** Where the school is drawn toward: a slow figure wandering the middle of the frame, never off it. */
  #aim(aspect: number): void {
    const c = this.#clock;
    this.#tx = 0.5 * aspect * (0.34 * Math.sin(c * 0.043 + 0.7) + 0.12 * Math.sin(c * 0.11 + 2.3));
    this.#ty = 0.54 + 0.09 * Math.sin(c * 0.067 + 1.9);
  }

  #step(h: number, count: number, aspect: number, hand: Hand): void {
    this.#clock += h;
    this.#fright = Math.max(0, this.#fright - h / FISH_FRIGHT_TIME);
    const fright = this.#fright;
    this.#aim(aspect);
    const tx = this.#tx;
    const ty = this.#ty;
    const half = 0.5 * aspect - 0.12;
    const n = KELP_FISH.max;
    const { x, y, vx, vy } = this;
    const ax = this.#ax;
    const ay = this.#ay;
    for (let i = 0; i < n; i++) {
      const xi = x[i] ?? 0;
      const yi = y[i] ?? 0;
      let sx = 0;
      let sy = 0;
      let avx = 0;
      let avy = 0;
      let na = 0;
      let cx = 0;
      let cy = 0;
      let nc = 0;
      const reach = FISH_SEPARATION * (this.#spread[i] ?? 1);
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = (x[j] ?? 0) - xi;
        const dy = (y[j] ?? 0) - yi;
        const d2 = dx * dx + dy * dy;
        if (d2 > FISH_COHESION * FISH_COHESION) continue;
        cx += dx;
        cy += dy;
        nc++;
        if (d2 < FISH_ALIGN * FISH_ALIGN) {
          avx += vx[j] ?? 0;
          avy += vy[j] ?? 0;
          na++;
        }
        if (d2 < reach * reach && d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const push = (1 - d / reach) / d;
          sx -= dx * push;
          sy -= dy * push;
        }
      }
      const vxi = vx[i] ?? 0;
      const vyi = vy[i] ?? 0;
      let fx = 1.4 * sx;
      let fy = 1.4 * sy;
      if (na > 0) {
        fx += FISH_ALIGN_PULL * (avx / na - vxi);
        fy += FISH_ALIGN_PULL * (avy / na - vyi);
      }
      if (nc > 0) {
        const pull = FISH_COHESION_PULL * (1 - 0.7 * fright);
        fx += (pull * cx) / nc;
        fy += (pull * cy) / nc;
      }
      // Each fish's own slow wandering.
      const phase = (this.#phase[i] ?? 0) * TAU;
      fx += FISH_WANDER * Math.sin(this.#clock * 0.37 + phase);
      fy += 0.8 * FISH_WANDER * Math.cos(this.#clock * 0.29 + 1.4 * phase);
      // Toward the wander target, firmly enough to keep the school in frame, capped so it drifts
      // rather than homes in.
      let gx = (tx - xi) * 0.4;
      let gy = (ty - yi) * 0.4;
      const g = Math.hypot(gx, gy);
      if (g > 0.08) {
        gx *= 0.08 / g;
        gy *= 0.08 / g;
      }
      fx += gx;
      fy += gy;
      // Soft walls: the band of open water and the frame's sides.
      if (yi < KELP_FISH.low) fy += (KELP_FISH.low - yi) * 2;
      if (yi > KELP_FISH.high) fy -= (yi - KELP_FISH.high) * 2;
      if (xi < -half) fx += (-half - xi) * 2;
      if (xi > half) fx -= (xi - half) * 2;
      // The hand, while held: fish dart away from it.
      if (hand.on > 0) {
        const dx = xi - hand.x;
        const dy = yi - hand.y;
        const d = Math.hypot(dx, dy);
        if (d < FISH_FLEE && d > 1e-5) {
          const k = (2 * hand.on * (1 - d / FISH_FLEE)) / d;
          fx += dx * k;
          fy += dy * k;
        }
      }
      ax[i] = fx;
      ay[i] = fy;
    }

    const top = FISH_MAX + FISH_FRIGHT_SPEED * fright;
    const ease = 1 - Math.exp(-h / 0.2);
    const flashEase = 1 - Math.exp(-h / 0.15);
    const fade = h / FISH_FADE;
    for (let i = 0; i < n; i++) {
      let u = (vx[i] ?? 0) + (ax[i] ?? 0) * h;
      let v = (vy[i] ?? 0) + (ay[i] ?? 0) * h;
      // Back toward cruising speed, within the limits.
      let speed = Math.hypot(u, v);
      if (speed < 1e-6) {
        u = FISH_CRUISE;
        v = 0;
        speed = FISH_CRUISE;
      }
      const want = Math.min(top, Math.max(FISH_MIN, speed + (FISH_CRUISE - speed) * 0.8 * h));
      u *= want / speed;
      v *= want / speed;
      vx[i] = u;
      vy[i] = v;
      x[i] = (x[i] ?? 0) + u * h;
      y[i] = (y[i] ?? 0) + v * h;

      // Heading and how fast it turns: a turning fish rolls and flashes its silver flank.
      const angle = Math.atan2(v, u);
      let da = angle - (this.heading[i] ?? 0);
      da -= TAU * Math.round(da / TAU);
      this.heading[i] = angle;
      this.turn[i] = (this.turn[i] ?? 0) + (da / h - (this.turn[i] ?? 0)) * ease;
      const turning = Math.min(1, Math.max(0, (Math.abs(this.turn[i] ?? 0) - 0.25) * 1.2));
      // Now and then a glint sweeps across the school as it wheels in the light.
      const wheel = Math.max(0, Math.sin(this.#clock * 0.17 + (x[i] ?? 0) * 3 + (y[i] ?? 0) * 1.3)) ** 24;
      const target = Math.max(turning, 0.8 * wheel);
      this.flash[i] = (this.flash[i] ?? 0) + (target - (this.flash[i] ?? 0)) * flashEase;
      // Turning toward or away from the eye now and then, slowly.
      this.flank[i] = 0.55 + 0.45 * Math.abs(Math.cos(this.#clock * 0.11 + (this.#phase[i] ?? 0) * TAU));
      const shown = this.shown[i] ?? 0;
      this.shown[i] = i < count ? Math.min(1, shown + fade) : Math.max(0, shown - fade);
    }
  }
}

class KelpSim implements SceneSim {
  readonly #system: VerletSystem;
  readonly #points: PointTexture;
  readonly #state: DataTexture;
  readonly #stateData = new Float32Array(KELP_STATE_WIDTH * STATE_ROWS * 4);
  readonly #trail = new TrailField(TRAIL_W, TRAIL_H);
  readonly #trailTexture: DataTexture;
  readonly #textures: readonly WebGLTexture[];
  readonly #knobs: KnobReader<KnobKey>;
  readonly #swellSlot: number;
  readonly #visitorSlot: number;
  readonly #knob: Record<KnobKey, number>;
  readonly #random = new Random();
  readonly #school = new School();
  readonly #hand: Hand = { x: 0, y: 0.5, vx: 0, vy: 0, on: 0 };
  readonly #stepOptions: VerletStepOptions;

  // Per stipe: when the density knob shows it (rank), how far it has emerged from the haze, and
  // the length of its links.
  readonly #rank = new Float32Array(KELP_STIPES);
  readonly #presence = new Float32Array(KELP_STIPES);
  readonly #link = new Float32Array(KELP_STIPES);
  readonly #scale = new Float32Array(KELP_STIPES);
  readonly #baseX = new Float32Array(KELP_STIPES);
  // Per point: its layer's scale, floor and surface, how hard the surface drift takes its plant's
  // top, the flow it was last dragged toward (screen heights/s) and its blade's lean.
  readonly #pointScale = new Float32Array(POINT_COUNT);
  readonly #pointFloor = new Float32Array(POINT_COUNT);
  readonly #pointSurface = new Float32Array(POINT_COUNT);
  readonly #pointLayer = new Uint8Array(POINT_COUNT);
  readonly #pointDrift = new Float32Array(POINT_COUNT);
  readonly #flowX = new Float32Array(POINT_COUNT);
  readonly #lean = new Float32Array(POINT_COUNT);

  // The flow, advanced substep by substep from the system's clock (see #advanceFlow).
  #flowTime = 0;
  #phase1 = 1.1;
  #phase2 = 4;
  #omega1 = TAU / 8;
  #surgeSpeed = 0;
  #currentSpeed = 0;
  /** The way the floating tops trail: the current's (+1 while it is still). */
  #downstream = 1;
  #swellAge = -1;
  #swellDir = 1;

  #seed = -1;
  #aspect = 16 / 9;
  #clock = 0;
  #nextSwell = SWELL_FIRST;
  #visitorAge = -1;
  #visitorDir = 1;
  #visitorY = 0.5;
  #visitorPhase = 0;
  #nextVisitor = VISITOR_FIRST;
  #handPrevX = 0;
  #handPrevY = 0;
  #handHeld = false;
  #trailVersion = -1;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const knobs = new KnobReader("kelp", params, KNOB_KEYS);
    this.#knobs = knobs;
    this.#swellSlot = knobs.trigger("swell");
    this.#visitorSlot = knobs.trigger("visitor");
    this.#knob = {
      surge: knobs.initial("surge"),
      period: knobs.initial("period"),
      current: knobs.initial("current"),
      swell: knobs.initial("swell"),
      density: knobs.initial("density"),
      kelpSeed: knobs.initial("kelpSeed"),
      fish: knobs.initial("fish"),
      visitor: knobs.initial("visitor"),
      mark: knobs.initial("mark"),
    };
    this.#system = new VerletSystem({ points: POINT_COUNT, constraints: KELP_STIPES * (2 * KELP_SEGMENTS - 1) });
    this.#stepOptions = { gravity: [0, 0, 0], damping: DRAG, iterations: 4, force: this.#force };
    this.#points = new PointTexture(gl, { points: POINT_COUNT, velocity: true, width: KELP_POINT_ROW, origin: KELP_ORIGIN });
    this.#state = new DataTexture(gl, { width: KELP_STATE_WIDTH, height: STATE_ROWS, format: "rgba16f", filter: "nearest" });
    this.#trailTexture = new DataTexture(gl, { width: TRAIL_W, height: TRAIL_H, format: "r8" });
    this.#textures = [this.#points.texture, this.#state.texture, this.#trailTexture.texture];
    this.#applyKnobs();
    this.#build(Math.round(this.#knob.kelpSeed));
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knob = this.#knob;
    for (const key of KNOB_KEYS) knob[key] = this.#knobs.value(frame, key);
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#applyKnobs();
    const seed = Math.round(knob.kelpSeed);
    if (seed !== this.#seed) this.#build(seed);
    this.#watchTriggers(frame.fired);

    // Motion scales everything; a swell or a visitor fired with "now" plays even while it is 0.
    const busy = this.#swellAge >= 0 || this.#visitorAge >= 0;
    const advance = Math.max(0, frame.dt) * Math.max(frame.motion, busy ? 1 : 0);
    this.#clock += advance;
    this.#schedule(advance);
    this.#updateHand(frame, advance);

    this.#system.step(advance, this.#stepOptions);
    this.#settleBlades(advance);
    this.#updatePresence(advance);
    this.#school.advance(advance, Math.round(knob.fish), this.#aspect, this.#hand);
    if (frame.pointer.pressed && frame.pointer.inside) this.#school.scatter((frame.pointer.x - 0.5) * this.#aspect, frame.pointer.y);
    this.#advanceVisitor(advance);

    this.#trail.decay(advance, TRAIL_HALF_LIFE);
    this.#points.upload(this.#system, this.#lean);
    this.#packState();
    this.#state.upload(this.#stateData);
    if (this.#trail.version !== this.#trailVersion) {
      this.#trailTexture.upload(this.#trail.data);
      this.#trailVersion = this.#trail.version;
    }
    return this.#textures;
  }

  dispose(): void {
    this.#points.dispose();
    this.#state.dispose();
    this.#trailTexture.dispose();
  }

  // ---- the forest -------------------------------------------------------------------------------

  /** Plant the forest for an arrangement number and let it sway into shape. */
  #build(seed: number): void {
    this.#seed = seed;
    const random = this.#random;
    random.seed(SEED ^ Math.imul(seed + 1, 0x9e3779b1));
    const sys = this.#system;
    sys.clear();
    // Grown plants are laid out as they will float: up to the surface, then along it downstream.
    const downstream = this.#downstream;
    for (const [l, layer] of KELP_LAYERS.entries()) {
      for (let k = 0; k < layer.slots; k++) {
        const stipe = layer.first + k;
        const s = layer.scale * (1 + DEPTH_JITTER * (random.next() - 0.5));
        const floorY = KELP_VIEW.horizon - KELP_VIEW.floor * s;
        const surfaceY = KELP_VIEW.horizon + KELP_VIEW.surface * s;
        const rise = surfaceY - SURFACE_BAND * s - floorY;
        const x = layer.left + (k + 0.5 + 0.85 * (random.next() - 0.5)) * layer.spacing;
        const grown = random.next() >= YOUNG_SHARE;
        const r = random.next();
        const length = (surfaceY - floorY) * (grown ? GROWN_MIN + (GROWN_MAX - GROWN_MIN) * r : YOUNG_MIN + (YOUNG_MAX - YOUNG_MIN) * r);
        const drift = 0.6 + 0.8 * random.next();
        let rank = random.next();
        // The nearest plants keep the middle of the frame clear until the forest is dense.
        if (l === 0) rank += (0.92 + 0.07 * rank - rank) * (1 - smoothstep(0.25, 0.7, Math.abs(x)));
        this.#rank[stipe] = rank;
        this.#presence[stipe] = rank < this.#knob.density ? 1 : 0;
        this.#link[stipe] = length / KELP_SEGMENTS;
        this.#scale[stipe] = s;
        this.#baseX[stipe] = x;
        const chain = sys.addChain([x, floorY, 0], [x, floorY + length, 0], KELP_SEGMENTS, { bend: BEND, pinFirst: true });
        for (let j = 1; j <= KELP_SEGMENTS; j++) {
          const along = (j * length) / KELP_SEGMENTS;
          if (along > rise) sys.place(chain.first + j, x + downstream * (along - rise), floorY + rise, 0);
        }
        for (let p = chain.first; p < chain.first + chain.points; p++) {
          this.#pointScale[p] = s;
          this.#pointFloor[p] = floorY;
          this.#pointSurface[p] = surfaceY;
          this.#pointLayer[p] = l;
          this.#pointDrift[p] = drift;
          this.#flowX[p] = 0;
          this.#lean[p] = 0;
        }
      }
    }
    this.#updatePresence(0);
    this.#flowTime = sys.time;
    this.#swellAge = -1;
    this.#school.place(random, this.#aspect, Math.round(this.#knob.fish));
    for (let t = 0; t < PREWARM; t += PREWARM_STEP) {
      sys.step(PREWARM_STEP, this.#stepOptions);
      this.#settleBlades(PREWARM_STEP);
    }
    const fish = Math.round(this.#knob.fish);
    for (let t = 0; t < 2 * PREWARM; t += PREWARM_STEP) this.#school.advance(PREWARM_STEP, fish, this.#aspect, this.#hand);
  }

  #applyKnobs(): void {
    const knob = this.#knob;
    this.#omega1 = TAU / Math.max(1, knob.period);
    this.#surgeSpeed = KELP_SURGE.speed * knob.surge;
    this.#currentSpeed = KELP_SURGE.current * knob.current;
    this.#downstream = knob.current < 0 ? -1 : 1;
  }

  /** Advance the surge's phases and the swell to the system's clock (once per substep). */
  #advanceFlow(time: number): void {
    const dt = time - this.#flowTime;
    this.#flowTime = time;
    if (!(dt > 0)) return;
    this.#phase1 = (this.#phase1 + dt * this.#omega1) % TAU;
    this.#phase2 = (this.#phase2 + dt * this.#omega1 * KELP_SURGE.ratio) % TAU;
    if (this.#swellAge >= 0) {
      this.#swellAge += dt;
      if (this.#swellAge > SWELL_END) this.#swellAge = -1;
    }
  }

  /** The big swell's water speed at world x (world units/s): the time derivative of its displacement. */
  #swellFlow(xw: number): number {
    const { amplitude, period, span, start, speed } = KELP_SWELL;
    const tau = this.#swellAge - (this.#swellDir * xw + start) / speed;
    if (tau <= 0 || tau >= span) return 0;
    const w = TAU / period;
    const envelope = Math.sin((Math.PI * tau) / span) ** 2;
    const slope = (Math.PI / span) * Math.sin((TAU * tau) / span);
    return amplitude * (slope * Math.sin(w * tau) + envelope * w * Math.cos(w * tau));
  }

  /**
   * Bladders lift every point; drag pulls it toward the flow, the hand's wake included. In the band
   * just under the surface the lift fades out (and pushes down above it), with extra damping of
   * the up-and-down motion, so a grown plant's top comes to lie along the surface.
   */
  readonly #force: VerletForce = (i, x, y, _z, out) => {
    const time = this.#system.time;
    if (time !== this.#flowTime) this.#advanceFlow(time);
    const s = this.#pointScale[i] ?? 1;
    const xw = x / s;
    const a1 = this.#phase1 - KELP_SURGE.k1 * xw;
    const a2 = this.#phase2 - KELP_SURGE.k2 * xw + KELP_SURGE.phase2;
    let surge = this.#surgeSpeed * (Math.sin(a1) + KELP_SURGE.second * Math.sin(a2));
    if (this.#swellAge >= 0) surge += this.#swellFlow(xw);
    const band = SURFACE_BAND * s;
    const over = (y - ((this.#pointSurface[i] ?? 1) - band)) / band;
    const floating = Math.min(1, Math.max(0, over));
    // The surge (and a swell) reach a floating top only in part, so the steady drift decides which
    // way it trails; the current runs the whole depth.
    // The surge's orbit turns elliptical toward the surface: a little bob at the crown.
    const rise = Math.min(1, Math.max(0, (y - (this.#pointFloor[i] ?? 0)) / ((KELP_VIEW.floor + KELP_VIEW.surface) * s)));
    let fx = (surge * (1 - CANOPY_SHELTER * floating) + this.#currentSpeed) * s;
    let fy = ORBIT * this.#surgeSpeed * Math.cos(a1) * rise * s;
    const hand = this.#hand;
    if (hand.on > 0) {
      const dx = x - hand.x;
      const dy = y - hand.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 9 * HAND_RADIUS * HAND_RADIUS) {
        const k = HAND_GAIN * hand.on * (HAND_REACH[this.#pointLayer[i] ?? 0] ?? 0) * Math.exp(-d2 / (HAND_RADIUS * HAND_RADIUS));
        fx += hand.vx * k;
        fy += hand.vy * k;
      }
    }
    this.#flowX[i] = fx;
    let lift = BUOYANCY * s * (LAYER_LIFT[this.#pointLayer[i] ?? 0] ?? 1);
    let push = DRAG * fx;
    if (over > 0) {
      // Floating, its lift fades; its bobbing is damped, and so is its sloshing: the mat of fronds
      // at the surface, held by its neighbours, follows the water only part of the way.
      const prev = this.#system.previous;
      const rate = 1 / this.#system.substep;
      lift *= 1 - over;
      lift -= SURFACE_DAMP * (y - (prev[3 * i + 1] ?? y)) * rate * floating;
      push -= CANOPY_DRAG * (x - (prev[3 * i] ?? x)) * rate * floating;
      push += DRAG * this.#downstream * SURFACE_DRIFT * (this.#pointDrift[i] ?? 1) * s * floating;
    }
    out[0] = push;
    out[1] = lift + DRAG * fy;
  };

  /**
   * Each blade leans with the water flowing past its node, against its own buoyancy; stored
   * relative to the stipe's direction there, eased so a jolt never snaps it round.
   */
  #settleBlades(dt: number): void {
    if (!(dt > 0)) return;
    const sys = this.#system;
    const pos = sys.positions;
    const prev = sys.previous;
    const rate = 1 / sys.substep;
    const ease = 1 - Math.exp(-dt / BLADE_EASE);
    for (let stipe = 0; stipe < KELP_STIPES; stipe++) {
      const first = stipe * KELP_POINTS;
      for (let j = 0; j < KELP_POINTS; j++) {
        const i = first + j;
        const below = 3 * (first + Math.max(0, j - 1));
        const above = 3 * (first + Math.min(KELP_SEGMENTS, j + 1));
        const spine = Math.atan2((pos[above] ?? 0) - (pos[below] ?? 0), (pos[above + 1] ?? 0) - (pos[below + 1] ?? 0));
        // The pinned holdfast has no flow of its own: it takes its neighbour's.
        const flow = this.#flowX[j === 0 ? i + 1 : i] ?? 0;
        const vx = ((pos[3 * i] ?? 0) - (prev[3 * i] ?? 0)) * rate;
        const s = this.#pointScale[i] ?? 1;
        const lean = Math.max(-BLADE_MAX, Math.min(BLADE_MAX, Math.atan((BLADE_STREAM * (flow - vx)) / s)));
        const current = this.#lean[i] ?? 0;
        this.#lean[i] = current + (lean - spine - current) * ease;
      }
    }
  }

  /**
   * Plants emerge from the haze or fade into it as the density knob moves (at once while paused).
   * While the Manifold M stands, the plants nearer than it step aside: it stands in a clearing.
   */
  #updatePresence(dt: number): void {
    const density = this.#knob.density;
    const step = dt > 0 ? dt / PRESENCE_EASE : 1;
    const mark = this.#knob.mark;
    const markX = KELP_MARK.x * KELP_MARK.scale;
    const markHalf = KELP_MARK.halfWidth * (KELP_MARK.low + (KELP_MARK.high - KELP_MARK.low) * mark) * KELP_MARK.scale;
    for (let stipe = 0; stipe < KELP_STIPES; stipe++) {
      const s = this.#scale[stipe] ?? 1;
      const inFront = mark > 0 && s > KELP_MARK.scale && Math.abs((this.#baseX[stipe] ?? 0) - markX) < markHalf + 0.18 * s;
      const want = (this.#rank[stipe] ?? 1) < density && !inFront ? 1 : 0;
      const have = this.#presence[stipe] ?? 0;
      this.#presence[stipe] = want > have ? Math.min(want, have + step) : Math.max(want, have - step);
    }
  }

  // ---- the hand, events -------------------------------------------------------------------------

  #updateHand(frame: SimFrame, dt: number): void {
    const pointer = frame.pointer;
    const hand = this.#hand;
    const x = (pointer.x - 0.5) * this.#aspect;
    const y = pointer.y;
    const held = pointer.down && pointer.inside;
    if (held) {
      if (this.#handHeld && dt > 0) {
        const k = 1 - Math.exp(-dt / HAND_SMOOTH);
        let vx = (x - this.#handPrevX) / dt;
        let vy = (y - this.#handPrevY) / dt;
        const speed = Math.hypot(vx, vy);
        if (speed > HAND_MAX_SPEED) {
          vx *= HAND_MAX_SPEED / speed;
          vy *= HAND_MAX_SPEED / speed;
        }
        hand.vx += (vx - hand.vx) * k;
        hand.vy += (vy - hand.vy) * k;
      } else if (!this.#handHeld) {
        hand.vx = 0;
        hand.vy = 0;
      }
      hand.x = x;
      hand.y = y;
      hand.on = 1;
      this.#trail.stroke(pointer.x, pointer.y, TRAIL_RADIUS, TRAIL_STRENGTH, this.#aspect);
    } else {
      if (this.#handHeld) this.#trail.lift();
      hand.on = dt > 0 ? Math.max(0, hand.on - dt / HAND_RELEASE) : hand.on;
      const k = dt > 0 ? Math.exp(-dt / HAND_RELEASE) : 1;
      hand.vx *= k;
      hand.vy *= k;
    }
    this.#handHeld = held;
    this.#handPrevX = x;
    this.#handPrevY = y;
  }

  /** A "now" button stamps its slot with the scene clock: `fired` is true for the one frame after. */
  #watchTriggers(fired: readonly boolean[]): void {
    if (fired[this.#swellSlot] === true) this.#startSwell();
    if (fired[this.#visitorSlot] === true && this.#visitorAge < 0) this.#startVisitor();
  }

  /** Big swells and the sea lion turn up at random, as often as their knobs say. */
  #schedule(dt: number): void {
    if (dt <= 0) return;
    const random = this.#random;
    const swell = this.#knob.swell;
    if (swell > 0 && this.#clock >= this.#nextSwell) {
      if (this.#swellAge < 0) this.#startSwell();
      this.#nextSwell = this.#clock + (SWELL_RARE + (SWELL_OFTEN - SWELL_RARE) * swell) * (0.6 + 0.8 * random.next());
    } else if (swell <= 0) {
      this.#nextSwell = Math.max(this.#nextSwell, this.#clock + SWELL_FIRST);
    }
    const visitor = this.#knob.visitor;
    if (visitor > 0 && this.#clock >= this.#nextVisitor) {
      if (this.#visitorAge < 0) this.#startVisitor();
      this.#nextVisitor = this.#clock + (VISITOR_RARE + (VISITOR_OFTEN - VISITOR_RARE) * visitor) * (0.6 + 0.8 * random.next());
    } else if (visitor <= 0) {
      this.#nextVisitor = Math.max(this.#nextVisitor, this.#clock + VISITOR_FIRST);
    }
  }

  #startSwell(): void {
    this.#swellAge = 0;
    // Swells roll in downstream when a current runs, else from either side.
    const current = this.#knob.current;
    this.#swellDir = Math.abs(current) > 0.1 ? Math.sign(current) : this.#random.next() < 0.5 ? -1 : 1;
  }

  #startVisitor(): void {
    const random = this.#random;
    this.#visitorAge = 0;
    this.#visitorDir = random.next() < 0.5 ? -1 : 1;
    this.#visitorY = 0.44 + 0.16 * random.next();
    this.#visitorPhase = random.next() * TAU;
  }

  #advanceVisitor(dt: number): void {
    if (this.#visitorAge < 0) return;
    this.#visitorAge += dt;
    const travel = 2 * (0.5 * this.#aspect + VISITOR_MARGIN);
    if (this.#visitorAge * VISITOR_SPEED > travel) this.#visitorAge = -1;
  }

  // ---- packing ----------------------------------------------------------------------------------

  /** One texel of the state texture. */
  #put(row: number, col: number, a: number, b: number, c: number, d: number): void {
    const data = this.#stateData;
    const o = (row * KELP_STATE_WIDTH + col) * 4;
    data[o] = a;
    data[o + 1] = b;
    data[o + 2] = c;
    data[o + 3] = d;
  }

  #packState(): void {
    this.#stateData.fill(0);

    const pos = this.#system.positions;
    for (let stipe = 0; stipe < KELP_STIPES; stipe++) {
      const first = stipe * KELP_POINTS;
      const s = this.#pointScale[first] ?? 1;
      const floating = (this.#pointSurface[first] ?? 1) - FLOATING * SURFACE_BAND * s;
      // The stipe rises from the holdfast to its first node at the surface (or to its top); from
      // there it floats, the canopy, as far as the node that has trailed farthest along the surface.
      let rising = KELP_SEGMENTS;
      for (let j = 1; j <= KELP_SEGMENTS; j++) {
        if ((pos[3 * (first + j) + 1] ?? 0) > floating) {
          rising = j;
          break;
        }
      }
      let minX = Infinity;
      let maxX = -Infinity;
      for (let j = 0; j <= rising; j++) {
        const x = pos[3 * (first + j)] ?? 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      const start = pos[3 * (first + rising)] ?? 0;
      let end = start;
      for (let j = rising + 1; j <= KELP_SEGMENTS; j++) {
        const x = pos[3 * (first + j)] ?? 0;
        if ((x - end) * this.#downstream > 0) end = x;
      }
      this.#put(KELP_ROW.stipes, stipe, minX, maxX, pos[3 * (first + rising) + 1] ?? 0, this.#presence[stipe] ?? 0);
      this.#put(KELP_ROW.canopy, stipe, rising, start, end, this.#link[stipe] ?? 0);
      this.#put(KELP_ROW.scale, stipe, s, 0, 0, 0);
    }

    const school = this.#school;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < KELP_FISH.max; i++) {
      const shown = school.shown[i] ?? 0;
      const x = school.x[i] ?? 0;
      const y = school.y[i] ?? 0;
      const angle = school.heading[i] ?? 0;
      const size = school.size[i] ?? 0;
      this.#put(KELP_ROW.fishPose, i, x, y, Math.cos(angle), Math.sin(angle));
      this.#put(KELP_ROW.fishLook, i, shown > 0 ? size * (0.4 + 0.6 * shown) : 0, school.flash[i] ?? 0, school.flank[i] ?? 1, shown);
      if (shown <= 0) continue;
      minX = Math.min(minX, x - size);
      maxX = Math.max(maxX, x + size);
      minY = Math.min(minY, y - size);
      maxY = Math.max(maxY, y + size);
    }
    if (minX > maxX) this.#put(KELP_ROW.globals, KELP_GLOBAL.school, 1, 1, -1, -1);
    else this.#put(KELP_ROW.globals, KELP_GLOBAL.school, minX, minY, maxX, maxY);

    this.#put(KELP_ROW.globals, KELP_GLOBAL.phases, Math.cos(this.#phase1), Math.sin(this.#phase1), Math.cos(this.#phase2), Math.sin(this.#phase2));
    this.#put(KELP_ROW.globals, KELP_GLOBAL.flow, this.#surgeSpeed, this.#omega1, this.#currentSpeed, this.#swellAge);

    if (this.#visitorAge >= 0) {
      const travel = 2 * (0.5 * this.#aspect + VISITOR_MARGIN);
      const age = this.#visitorAge;
      const p = (age * VISITOR_SPEED) / travel;
      const dir = this.#visitorDir;
      const x = dir * (age * VISITOR_SPEED - 0.5 * travel);
      // A long, lazy dip and a slow undulation: a sea lion idling across the forest.
      const wave = TAU * 1.3 * p + this.#visitorPhase;
      const y = this.#visitorY + 0.035 * Math.sin(wave) - 0.05 * Math.sin(Math.PI * p);
      const dy = (0.035 * TAU * 1.3 * Math.cos(wave) - 0.05 * Math.PI * Math.cos(Math.PI * p)) / travel;
      const heading = Math.atan2(dy, dir);
      const shown = smoothstep(0, 0.08, p) * (1 - smoothstep(0.92, 1, p));
      const phase = (age % VISITOR_STROKE) / VISITOR_STROKE;
      const stroke = Math.sin(Math.PI * Math.min(1, phase / 0.3)) ** 2;
      this.#put(KELP_ROW.globals, KELP_GLOBAL.visitorPose, x, y, heading, shown);
      this.#put(KELP_ROW.globals, KELP_GLOBAL.visitorLook, stroke, dir, this.#swellDir, 0);
    } else {
      this.#put(KELP_ROW.globals, KELP_GLOBAL.visitorLook, 0, 1, this.#swellDir, 0);
    }
  }
}

/** The kelp forest's simulation for a scene whose knobs are `params` (looked up by key). */
export function kelpSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new KelpSim(gl, params);
}
