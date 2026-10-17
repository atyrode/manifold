// Principals: everyone present in a scene (AXIOMS A2; second audit I-20). The visitor is principal
// 0; the others follow, as a presence source places them. Sims and shaders treat every one alike:
// the koi do not know whose hand it is.
//
// The source here is a scripted cast of agents (`Cast`, I-40): calm, purposeful cursors that
// wander, go to a point of interest the scene declares (SceneSim.interest), pause there, act (press
// briefly) and move on. Agents run straight and even, ease in and out of each run and dwell still
// at the end: the motion says "agent" without a label. The cast is a function of the scene's seed
// knob and its motion clock alone, so it stands still at motion 0 and a reload replays it. Live
// presence from a Manifold room (I-23) would be another `PresenceSource`: nothing that reads
// principals changes with it.
//
// `Presence` turns a source's poses into what a frame hands over: SimFrame.principals, with press
// and release edges and velocities worked out from the frame before, and the shader's uPrincipals
// (x, y, 1 while pressed, the scene-clock time of the last press) and uPrincipalMotion (velocities,
// two principals a row), which the agents' cursors are drawn from (shaders/main.ts).
//
// Usage (the renderer, once a frame for each scene it draws):
//   const cast = new Cast(seed);
//   const presence = new Presence();
//   const poses = cast.poses(motionTime, aspect, agents, sim);
//   presence.update(visitor, visitorPressedAt, poses, dt, time);
//   sim.frame({ ..., pointer: visitor, principals: presence.principals });
import type { PrincipalState, ScenePoint, SceneSim } from "./scenes/types.ts";
import { Random } from "./sims/random.ts";

/** Principals a scene sees at most: the visitor and MAX_AGENTS others (uPrincipals' length). */
export const MAX_PRINCIPALS = 4;
/** Agents a cast holds at most: the lab's `agents` setting runs 0..MAX_AGENTS. */
export const MAX_AGENTS = MAX_PRINCIPALS - 1;
/** The press time of a principal that has not pressed (uPrincipals[i].w), as for triggers. */
const NEVER = -1e4;

/** A principal at rest: the visitor (human) at the middle, off the page, no button, still; `at` over it. */
export function principal(at: Partial<PrincipalState> = {}): PrincipalState {
  return {
    x: 0.5,
    y: 0.5,
    inside: false,
    down: false,
    pressed: false,
    released: false,
    vx: 0,
    vy: 0,
    kind: "human",
    ...at,
  };
}

/**
 * A frame's principals with the visitor alone, `at` over a visitor at rest (see `principal`): the
 * `pointer` and `principals` of a SimFrame built by hand, the one object in both.
 */
export function visitorAlone(at: Partial<PrincipalState> = {}): {
  pointer: PrincipalState;
  principals: PrincipalState[];
} {
  const pointer = principal(at);
  return { pointer, principals: [pointer] };
}

/** The first of `principals` over the page to press this frame, if any: whose click it is. */
export function firstPress(principals: readonly PrincipalState[]): PrincipalState | undefined {
  for (const p of principals) if (p.inside && p.pressed) return p;
  return undefined;
}

/** Where one of the others is, in scene uv, and whether it presses. */
export interface Pose {
  x: number;
  y: number;
  down: boolean;
}

/** What a source may ask of the scene: its points of interest (its sim's, SceneSim.interest). */
export type InterestSource = Pick<SceneSim, "interest">;

/**
 * Where the others are: `count` of them (at most MAX_AGENTS) at `time`, motion-clock seconds since
 * the scene began, over a frame of `aspect`, in scene uv and inside the frame. `scene` gives the
 * scene's points of interest, asked only when a source wants them. The array and its poses are the
 * source's, rewritten by its next call: read them, don't keep them.
 */
export interface PresenceSource {
  poses(
    time: number,
    aspect: number,
    count: number,
    scene: InterestSource | undefined,
  ): readonly Readonly<Pose>[];
}

const NO_POINTS: readonly ScenePoint[] = [];

// ---- the cast ------------------------------------------------------------------------------------

/** Kept this far (uv) inside the frame's edges, so a cursor never leaves it. */
export const CAST_MARGIN = 0.05;
/** Where agents wander and act when the scene declares no point of interest: the frame's middle. */
const MIDDLE = { x0: 0.14, x1: 0.86, y0: 0.16, y1: 0.84 } as const;
/** The shortest wander, view heights: a hop shorter than this reads as a twitch, not a purpose. */
const MIN_HOP = 0.16;
/** Cruising speed, view heights per second: unhurried. */
const SPEED = { min: 0.08, max: 0.13 } as const;
/** Seconds to come up to speed at a run's start and to brake at its end. */
const RAMP = 0.45;
/** The shortest run, seconds. */
const MIN_TRAVEL = 0.9;
/** How far a run bows off the straight line, as a share of its length either way. */
const BOW = 0.18;
/** Seconds an agent stays at a point it came to act at, and at a point it only wandered to. */
const DWELL_VISIT = { min: 1.6, max: 3.4 } as const;
const DWELL_WANDER = { min: 0.5, max: 1.4 } as const;
/** Seconds into a dwell an act begins, how long the press is held, and the least still after it. */
const ACT_AFTER = { min: 0.35, max: 0.7 } as const;
export const PRESS_SECONDS = 0.45;
const ACT_SETTLE = 0.25;
/** Shares of runs that go to a point of interest (when the scene has any), and of wanders that act. */
const VISIT_SHARE = 0.7;
const WANDER_ACT_SHARE = 0.45;
/** Seconds each agent waits before its first run, beyond a stagger of AGENT_STAGGER per agent. */
const FIRST_WAIT = { min: 0.4, max: 1.6 } as const;
const AGENT_STAGGER = 1.1;

/**
 * One run and the stop after it: from `from` along a quadratic bow through `via` to `to` (uv)
 * over `travel` seconds, then still there for `dwell`, pressing from `act` seconds into the dwell
 * for PRESS_SECONDS (NaN: it only passes by).
 */
interface Leg {
  start: number;
  fromX: number;
  fromY: number;
  viaX: number;
  viaY: number;
  toX: number;
  toY: number;
  travel: number;
  dwell: number;
  act: number;
}

const inFrame = (v: number): number => Math.min(1 - CAST_MARGIN, Math.max(CAST_MARGIN, v));

/**
 * Share of a run of `travel` seconds covered after `t`: up to speed over RAMP, even, then braking
 * over RAMP (a trapezoid of speed), 0 at 0 and 1 at `travel`.
 */
function along(t: number, travel: number): number {
  if (t <= 0) return 0;
  if (t >= travel) return 1;
  const r = Math.min(RAMP, 0.5 * travel);
  const v = 1 / (travel - r);
  if (t < r) return (0.5 * v * t * t) / r;
  if (t < travel - r) return 0.5 * v * r + v * (t - r);
  const left = travel - t;
  return 1 - (0.5 * v * left * left) / r;
}

/** One agent of the cast: its runs, drawn one after another from its own stream. */
class Agent {
  readonly #random = new Random();
  readonly #seed: number;
  readonly #index: number;
  readonly #leg: Leg = {
    start: 0,
    fromX: 0.5,
    fromY: 0.5,
    viaX: 0.5,
    viaY: 0.5,
    toX: 0.5,
    toY: 0.5,
    travel: 0,
    dwell: 0,
    act: Number.NaN,
  };
  /** The point of interest the last visit went to (-1: none), so the next goes elsewhere. */
  #visited = -1;
  #started = false;

  constructor(seed: number, index: number) {
    this.#seed = Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b) ^ 0x5bd1e995;
    this.#index = index;
  }

  /** Where it is at `time` (see PresenceSource). */
  pose(time: number, aspect: number, scene: InterestSource | undefined, out: Pose): void {
    const leg = this.#leg;
    if (!this.#started || time < leg.start) this.#begin();
    while (time >= leg.start + leg.travel + leg.dwell) this.#next(aspect, scene);
    const t = time - leg.start;
    if (t < leg.travel) {
      const s = along(t, leg.travel);
      const a = (1 - s) * (1 - s);
      const b = 2 * s * (1 - s);
      const c = s * s;
      out.x = a * leg.fromX + b * leg.viaX + c * leg.toX;
      out.y = a * leg.fromY + b * leg.viaY + c * leg.toY;
      out.down = false;
      return;
    }
    const still = t - leg.travel;
    out.x = leg.toX;
    out.y = leg.toY;
    out.down = still >= leg.act && still < leg.act + PRESS_SECONDS;
  }

  /** Its first stop: somewhere in the middle, waiting to set off. */
  #begin(): void {
    const random = this.#random;
    random.seed(this.#seed);
    this.#started = true;
    this.#visited = -1;
    const leg = this.#leg;
    const x = inFrame(random.range(MIDDLE.x0, MIDDLE.x1));
    const y = inFrame(random.range(MIDDLE.y0, MIDDLE.y1));
    leg.start = 0;
    leg.fromX = leg.viaX = leg.toX = x;
    leg.fromY = leg.viaY = leg.toY = y;
    leg.travel = 0;
    leg.dwell = this.#index * AGENT_STAGGER + random.range(FIRST_WAIT.min, FIRST_WAIT.max);
    leg.act = Number.NaN;
  }

  /** The run after this one: to a point of interest to act there, or a wander. */
  #next(aspect: number, scene: InterestSource | undefined): void {
    const random = this.#random;
    const leg = this.#leg;
    const fromX = leg.toX;
    const fromY = leg.toY;
    leg.start += leg.travel + leg.dwell;
    const points = scene?.interest?.(aspect) ?? NO_POINTS;
    let toX: number;
    let toY: number;
    let acts: boolean;
    if (points.length > 0 && random.next() < VISIT_SHARE) {
      let pick = random.int(points.length);
      if (pick === this.#visited && points.length > 1)
        pick = (pick + 1 + random.int(points.length - 1)) % points.length;
      this.#visited = pick;
      const point = points[pick];
      toX = inFrame(point?.x ?? 0.5);
      toY = inFrame(point?.y ?? 0.5);
      acts = true;
    } else {
      toX = fromX;
      toY = fromY;
      for (let tries = 0; tries < 4; tries++) {
        toX = inFrame(random.range(MIDDLE.x0, MIDDLE.x1));
        toY = inFrame(random.range(MIDDLE.y0, MIDDLE.y1));
        if (Math.hypot((toX - fromX) * aspect, toY - fromY) >= MIN_HOP) break;
      }
      acts = points.length === 0 && random.next() < WANDER_ACT_SHARE;
    }
    // The run, measured in view heights so it keeps its pace across the frame either way.
    const dx = (toX - fromX) * aspect;
    const dy = toY - fromY;
    const length = Math.hypot(dx, dy);
    const bow = random.range(-BOW, BOW);
    leg.fromX = fromX;
    leg.fromY = fromY;
    leg.viaX = inFrame(0.5 * (fromX + toX) - (bow * dy) / Math.max(aspect, 1e-3));
    leg.viaY = inFrame(0.5 * (fromY + toY) + bow * dx);
    leg.toX = toX;
    leg.toY = toY;
    leg.travel = Math.max(MIN_TRAVEL, length / random.range(SPEED.min, SPEED.max) + RAMP);
    const dwell = acts ? DWELL_VISIT : DWELL_WANDER;
    leg.dwell = random.range(dwell.min, dwell.max);
    leg.act = Number.NaN;
    if (acts) {
      leg.act = random.range(ACT_AFTER.min, ACT_AFTER.max);
      leg.dwell = Math.max(leg.dwell, leg.act + PRESS_SECONDS + ACT_SETTLE);
    }
  }
}

/**
 * The scripted cast: up to MAX_AGENTS agents, each on runs of its own drawn from `seed` (the
 * scene's seed knob), so one agent's path does not change as others join or leave. Deterministic:
 * the same seed, times, aspect and points of interest give the same poses, whatever was asked
 * before (a time earlier than the last asked replays the runs from the start).
 */
export class Cast implements PresenceSource {
  readonly #agents: Agent[];
  readonly #poses: Pose[] = [];
  readonly #pool: Pose[] = Array.from({ length: MAX_AGENTS }, () => ({
    x: 0.5,
    y: 0.5,
    down: false,
  }));
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.#agents = Array.from({ length: MAX_AGENTS }, (_, index) => new Agent(seed, index));
  }

  poses(
    time: number,
    aspect: number,
    count: number,
    scene: InterestSource | undefined,
  ): readonly Readonly<Pose>[] {
    const poses = this.#poses;
    const n = Math.max(0, Math.min(MAX_AGENTS, Math.round(count)));
    poses.length = 0;
    const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    const at = Number.isFinite(time) ? Math.max(0, time) : 0;
    for (let i = 0; i < n; i++) {
      const pose = this.#pool[i];
      const agent = this.#agents[i];
      if (pose === undefined || agent === undefined) break;
      agent.pose(at, safe, scene, pose);
      poses.push(pose);
    }
    return poses;
  }
}

// ---- what a frame hands over ----------------------------------------------------------------------

/**
 * The principals one scene sees each frame: the visitor, then the others a presence source places,
 * as SimFrame.principals and the shader's uPrincipals and uPrincipalMotion take them.
 */
export class Presence {
  /** SimFrame.principals: the visitor, then the others; rewritten in place each frame. */
  readonly principals: PrincipalState[] = [];
  /**
   * uPrincipals, MAX_PRINCIPALS rows: x, y (uv), 1 while pressed, the scene-clock time of its last
   * press (-1e4: none).
   */
  readonly upload = new Float32Array(4 * MAX_PRINCIPALS);
  /** uPrincipalMotion: each principal's velocity (uv per second), two principals a row. */
  readonly motion = new Float32Array(2 * MAX_PRINCIPALS);
  readonly #others: PrincipalState[] = Array.from({ length: MAX_AGENTS }, () =>
    principal({ inside: true, kind: "agent" }),
  );
  readonly #pressedAt: number[] = Array.from({ length: MAX_AGENTS }, () => NEVER);
  /** How many others there were last frame: one just come has no edge or velocity yet. */
  #had = 0;

  /**
   * This frame's principals: `visitor` (its last press at `visitorPressedAt` on the scene clock),
   * then the others at `poses`; `dt` real seconds since the previous frame, `time` the scene clock.
   */
  update(
    visitor: PrincipalState,
    visitorPressedAt: number,
    poses: readonly Readonly<Pose>[],
    dt: number,
    time: number,
  ): void {
    const list = this.principals;
    list.length = 0;
    list.push(visitor);
    const upload = this.upload;
    const motion = this.motion;
    upload.fill(0);
    motion.fill(0);
    this.#row(0, visitor, visitorPressedAt);
    const n = Math.min(poses.length, MAX_AGENTS);
    for (let i = 0; i < n; i++) {
      const pose = poses[i];
      const other = this.#others[i];
      if (pose === undefined || other === undefined) break;
      const known = i < this.#had;
      const was = known && other.down;
      other.vx = known && dt > 0 ? (pose.x - other.x) / dt : 0;
      other.vy = known && dt > 0 ? (pose.y - other.y) / dt : 0;
      other.x = pose.x;
      other.y = pose.y;
      other.down = pose.down;
      other.pressed = pose.down && !was;
      other.released = !pose.down && was;
      if (!known) this.#pressedAt[i] = NEVER;
      if (other.pressed) this.#pressedAt[i] = time;
      list.push(other);
      this.#row(i + 1, other, this.#pressedAt[i] ?? NEVER);
    }
    this.#had = n;
  }

  #row(row: number, p: PrincipalState, pressedAt: number): void {
    const at = 4 * row;
    this.upload[at] = p.x;
    this.upload[at + 1] = p.y;
    this.upload[at + 2] = p.down ? 1 : 0;
    this.upload[at + 3] = pressedAt;
    this.motion[2 * row] = p.vx;
    this.motion[2 * row + 1] = p.vy;
  }
}
