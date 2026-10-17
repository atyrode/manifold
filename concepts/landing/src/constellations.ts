// Recognisable constellations, simplified from their usual stick figures. Local coordinates are y
// up in sky units; `at` places each figure (x as a fraction of the half-width, y in sky units) so
// they stay in frame at any aspect ratio. Below them, star-joining: the agents' chore of drawing
// the figures' lines in the night sky, its schedule and the twin of the GLSL that draws it.
import type { ParamDef } from "./params.ts";
import type { Pose } from "./principals.ts";
import { fract } from "./sims/math.ts";
import { DAY_SECONDS, SUNSET } from "./world-clock.ts";

interface Figure {
  name: string;
  at: readonly [number, number];
  scale: number;
  /** [x, y, brightness 0..1] */
  stars: readonly (readonly [number, number, number])[];
  /** Index pairs into `stars`. */
  lines: readonly (readonly [number, number])[];
}

const figures: readonly Figure[] = [
  {
    name: "Orion",
    at: [0.12, 0.2],
    scale: 0.42,
    stars: [
      [-0.18, 0.32, 1],
      [0.17, 0.3, 0.8],
      [0, 0.45, 0.5],
      [-0.06, 0, 0.8],
      [0, 0.02, 0.8],
      [0.06, 0.04, 0.7],
      [-0.14, -0.32, 0.7],
      [0.2, -0.28, 1],
    ],
    lines: [
      [0, 2],
      [2, 1],
      [0, 3],
      [1, 5],
      [3, 4],
      [4, 5],
      [3, 6],
      [5, 7],
    ],
  },
  {
    name: "Big Dipper",
    at: [0.6, 0.36],
    scale: 0.42,
    stars: [
      [-0.45, 0.02, 0.8],
      [-0.3, 0.07, 0.8],
      [-0.15, 0.06, 0.9],
      [0, 0.02, 0.6],
      [0.03, -0.14, 0.7],
      [0.25, -0.12, 0.8],
      [0.24, 0.06, 0.9],
    ],
    lines: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 3],
    ],
  },
  {
    name: "Cassiopeia",
    at: [-0.3, 0.4],
    scale: 0.4,
    stars: [
      [-0.3, 0.05, 0.7],
      [-0.15, -0.08, 0.8],
      [0, 0, 0.8],
      [0.15, -0.1, 0.7],
      [0.28, 0.06, 0.6],
    ],
    lines: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
  {
    name: "Cygnus",
    at: [0.86, 0.08],
    scale: 0.4,
    stars: [
      [0, 0.3, 1],
      [0, 0.05, 0.7],
      [-0.2, 0, 0.6],
      [0.2, 0.12, 0.6],
      [0.02, -0.3, 0.6],
    ],
    lines: [
      [0, 1],
      [1, 4],
      [2, 1],
      [1, 3],
    ],
  },
  {
    name: "Leo",
    at: [-0.72, 0.12],
    scale: 0.5,
    stars: [
      [-0.25, -0.12, 1],
      [-0.24, 0, 0.5],
      [-0.2, 0.1, 0.8],
      [-0.24, 0.18, 0.5],
      [-0.16, 0.25, 0.5],
      [-0.07, 0.22, 0.6],
      [0.12, 0.08, 0.6],
      [0.12, -0.05, 0.5],
      [0.32, -0.02, 0.8],
    ],
    lines: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [2, 6],
      [6, 8],
      [8, 7],
      [7, 0],
    ],
  },
  {
    name: "Crux",
    at: [-0.15, -0.02],
    scale: 0.45,
    stars: [
      [0, 0.16, 0.8],
      [0.02, -0.16, 0.9],
      [-0.1, 0.02, 0.8],
      [0.11, 0.05, 0.6],
      [0.05, -0.05, 0.4],
    ],
    lines: [
      [0, 1],
      [2, 3],
    ],
  },
];

/** The Manifold mark traced as an asterism, after the app icon's M. Kept separate so it toggles alone. */
const mark: Figure = {
  name: "Manifold",
  at: [0.45, 0.06],
  scale: 0.24,
  stars: [
    [-0.47, -0.5, 0.8],
    [-0.47, 0, 0.6],
    [-0.47, 0.5, 1],
    [0, -0.08, 0.7],
    [0.47, 0.5, 1],
    [0.47, 0, 0.6],
    [0.47, -0.5, 0.8],
  ],
  lines: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ],
};

/**
 * Must match `MAX_CON_STARS` / `MAX_CON_LINES` in the fragment shader, which takes brightness four
 * stars and lines two to a vec4 (common.ts `conBright`, `conLine`): multiples of 4 and of 2.
 */
export const MAX_CON_STARS = 48;
export const MAX_CON_LINES = 48;

export interface ConstellationUniforms {
  /** Per star: anchor x (half-width fraction), anchor y, offset x, offset y. */
  stars: Float32Array;
  /** Per star: brightness 0..1 (`uConBright`, four stars a vec4). */
  brightness: Float32Array;
  /** Per line: two star indices (`uConLines`, two lines a vec4). */
  lines: Float32Array;
  starCount: number;
  lineCount: number;
  /** First star and line index belonging to the Manifold mark. */
  markStar: number;
  markLine: number;
}

export const constellationUniforms: ConstellationUniforms = (() => {
  const stars = new Float32Array(MAX_CON_STARS * 4);
  const brightness = new Float32Array(MAX_CON_STARS);
  const lines = new Float32Array(MAX_CON_LINES * 2);
  let starCount = 0;
  let lineCount = 0;
  let markStar = 0;
  let markLine = 0;
  for (const figure of [...figures, mark]) {
    if (figure === mark) {
      markStar = starCount;
      markLine = lineCount;
    }
    const first = starCount;
    for (const [x, y, b] of figure.stars) {
      stars.set([figure.at[0], figure.at[1], x * figure.scale, y * figure.scale], starCount * 4);
      brightness[starCount] = b;
      starCount++;
    }
    for (const [a, b] of figure.lines) {
      lines.set([first + a, first + b], lineCount * 2);
      lineCount++;
    }
  }
  return { stars, brightness, lines, starCount, lineCount, markStar, markLine };
})();

// ---- star-joining -------------------------------------------------------------------------------
//
// The agents' chore in the night sky (the `join` knob beside the constellations, scenes/
// atmosphere.ts): while the figures are out, the cast's agents leave the page in turn to join a
// figure's stars, its lines growing one after another behind a cursor the sky draws at the tip
// (shaders/lib/sky.ts skyFigures, which draws the figures whole while no agent is about). The lines
// stand until dawn fades them with the stars; the next night they are joined afresh, from the next
// figure on. It keeps no state: it is a schedule of the world clock and the motion clock that the
// GLSL (skyJoinNight, skyJoinTime) and the twin here (joinNight, joinTime) read alike, so the page
// knows which agents are up in the sky (skyJoinAway) without knowing where a star stands on screen.
// - The night: the agents may work from JOIN_WINDOW[0] to JOIN_WINDOW[1] days after sunset, the
//   stars a third out at either end. The work is counted on the motion clock from the window's
//   opening (taken back at the day cycle's pace now), never from before the scene began; with the
//   clock standing in the window, from the scene's start. A sky without the shared clock (no
//   K_time) keeps a night of its own, always open.
// - The rota: night n starts at figure n (of the six, in turn) and joins as many as the knob's
//   amount. Of `agents` agents, agent k takes the night's kth figure, then the (k + agents)th and
//   so on, landing JOIN_FIRST + k JOIN_STAGGER seconds into the work and JOIN_REST seconds back on
//   the page between two figures.
// - A job (joinPlan): the cursor lands on the figure's first star, then draws its lines in turn,
//   each from star to star and easing in and out, pausing at every star and hopping to the next
//   line's first star where that is not the one it is on; it leaves from the last.

/**
 * Days after sunset the agents may join stars from, and until: the stars a third out at either
 * end.
 */
export const JOIN_WINDOW = [0.04, 0.46] as const;
/** Seconds into the night's work the first agent lands, and how much later each next one does. */
export const JOIN_FIRST = 2;
export const JOIN_STAGGER = 5;
/** Seconds an agent spends back on the page between two figures. */
export const JOIN_REST = 6;
/** Seconds a cursor stays on a figure's first star before drawing, and on its last before going. */
const JOIN_SETTLE = 0.8;
/** Seconds it pauses at a star between two lines (each side of a hop). */
const JOIN_PAUSE = 0.35;
/** Seconds to draw a line, and to hop to a line's first star: a base and so much a radian of it. */
const JOIN_DRAW = { base: 0.6, perRadian: 12 } as const;
const JOIN_HOP = { base: 0.4, perRadian: 6 } as const;

/** A figure line as an agent joins it. */
export interface JoinLine {
  /** Its stars (uConStars indices), in the order it is drawn. */
  readonly from: number;
  readonly to: number;
  /**
   * Seconds into its figure's job when the cursor leaves the star it is on (`leave`), reaches
   * `from` (`arrive`: at once where it is on it), starts drawing (`start`) and reaches `to`
   * (`end`).
   */
  readonly leave: number;
  readonly arrive: number;
  readonly start: number;
  readonly end: number;
}

/** A figure as an agent joins it. */
export interface JoinFigure {
  /** Its lines [first, end) in `JoinPlan.lines`, which are the uConLines indices too. */
  readonly lines: readonly [number, number];
  /** Seconds its job takes, landing to leaving. */
  readonly seconds: number;
}

export interface JoinPlan {
  /** Every figure but the Manifold mark, in order (shaders/lib/sky.ts skyFigures). */
  readonly figures: readonly JoinFigure[];
  /** Their lines, in order. */
  readonly lines: readonly JoinLine[];
}

/**
 * How each figure is joined: its lines' order, direction and timing, to the hundredth of a second
 * (sky.ts takes them as tables).
 */
export const joinPlan: JoinPlan = (() => {
  const { stars } = constellationUniforms;
  const apart = (a: number, b: number): number =>
    Math.hypot(
      (stars[b * 4 + 2] ?? 0) - (stars[a * 4 + 2] ?? 0),
      (stars[b * 4 + 3] ?? 0) - (stars[a * 4 + 3] ?? 0),
    );
  const hundredths = (seconds: number): number => Math.round(seconds * 100) / 100;
  const lines: JoinLine[] = [];
  const planned: JoinFigure[] = [];
  let firstStar = 0;
  for (const figure of figures) {
    const firstLine = lines.length;
    let tip = -1;
    let done = 0;
    for (const [a, b] of figure.lines) {
      // From the star the cursor is on where the line holds it, else from its end nearer to it.
      const starA = firstStar + a;
      const starB = firstStar + b;
      const flip =
        starB === tip || (starA !== tip && tip >= 0 && apart(tip, starB) < apart(tip, starA));
      const from = flip ? starB : starA;
      const to = flip ? starA : starB;
      const leave = tip < 0 ? 0 : hundredths(done + JOIN_PAUSE);
      const hop =
        tip < 0 || from === tip ? 0 : JOIN_HOP.base + JOIN_HOP.perRadian * apart(tip, from);
      const arrive = hundredths(leave + hop);
      const start = tip < 0 ? JOIN_SETTLE : hundredths(arrive + (hop > 0 ? JOIN_PAUSE : 0));
      const end = hundredths(start + JOIN_DRAW.base + JOIN_DRAW.perRadian * apart(from, to));
      lines.push({ from, to, leave, arrive, start, end });
      tip = to;
      done = end;
    }
    planned.push({ lines: [firstLine, lines.length], seconds: hundredths(done + JOIN_SETTLE) });
    firstStar += figure.stars.length;
  }
  return { figures: planned, lines };
})();

/** Where tonight's star-joining stands (GLSL `SkyJoin`): see joinNight. */
export interface JoinNight {
  /** Agents joining stars, 0 for none (the sky then draws the figures whole). */
  agents: number;
  /** Figures they join a night: K_join, its amount while on. */
  figures: number;
  /** Seconds of the motion clock they have worked tonight; below 0, not begun. */
  work: number;
  /** Whether they may be at it now: JOIN_WINDOW holds the hour. */
  open: boolean;
  /** The night's first figure. */
  first: number;
}

const tonight: JoinNight = { agents: 0, figures: 0, work: -1, open: false, first: 0 };

/**
 * Tonight's star-joining (GLSL skyJoinNight) for `agents` agents and `figures` a night (K_join, 0
 * while off), on the world clock `clock` (K_time plus the days its cycle has run; undefined for a
 * sky without K_time, which keeps a night of its own) at the day cycle's pace `pace` (K_cycle: 0
 * while the clock stands), `motionTime` into the scene. The object is this module's, rewritten by
 * the next call: read it, don't keep it.
 */
export function joinNight(
  clock: number | undefined,
  pace: number,
  motionTime: number,
  agents: number,
  figures: number,
): Readonly<JoinNight> {
  const night = tonight;
  night.figures = Math.floor(figures + 0.5);
  night.agents = night.figures > 0 ? Math.max(0, agents) : 0;
  if (clock === undefined) {
    night.work = motionTime;
    night.open = true;
    night.first = 0;
    return night;
  }
  const since = clock - SUNSET;
  const into = fract(since);
  const [from, to] = JOIN_WINDOW;
  night.open = into >= from && into < to;
  night.work =
    pace > 0
      ? Math.min(motionTime, ((Math.min(into, to) - from) * DAY_SECONDS) / pace)
      : night.open
        ? motionTime
        : -1;
  const count = joinPlan.figures.length;
  night.first = ((Math.floor(since) % count) + count) % count;
  return night;
}

/**
 * Seconds into the job of the agent joining `figure` on `night` (0 as it lands on the first star,
 * the figure's `seconds` as it leaves the last; below 0 it has not come, and its lines are not
 * drawn), or -Infinity where no agent joins it that night (GLSL skyJoinTime).
 */
export function joinTime(night: Readonly<JoinNight>, figure: number): number {
  const count = joinPlan.figures.length;
  // Where it falls in the night's rota, 0 its first figure, and so whose it is.
  const slot = (figure - night.first + count) % count;
  if (night.agents <= 0 || slot >= night.figures) return Number.NEGATIVE_INFINITY;
  const agent = slot % night.agents;
  let start = JOIN_FIRST + agent * JOIN_STAGGER;
  for (let k = agent; k < slot; k += night.agents)
    start += (joinPlan.figures[(k + night.first) % count]?.seconds ?? 0) + JOIN_REST;
  return night.work - start;
}

/** Where knob `key` sits in `params`, -1 where the scene has none. */
function knobIndex(params: readonly ParamDef[], key: string): number {
  for (let i = 0; i < params.length; i++) if (params[i]?.key === key) return i;
  return -1;
}

/**
 * Marks the agents among `poses` (the cast's this frame) who are up in the sky joining stars as off
 * the page (Pose.inside false, pressing nothing): their hands leave the scene and their cursors
 * the ground, while the sky draws each at its work. `params` and `knobs` are the scene's knobs and
 * their values as the shader reads them (SimFrame.values), `phases` its rate knobs' phases by key
 * (the day cycle's: SimFrame.phases) and `motionTime` its motion clock. Agents stay on the page in
 * a scene without star-joining (no `join` knob), while it, the constellations or the stars are
 * off, and while the night has no work for them.
 */
export function skyJoinAway(
  poses: readonly Pose[],
  params: readonly ParamDef[],
  knobs: readonly number[],
  phases: Readonly<Record<string, number>>,
  motionTime: number,
): void {
  if (poses.length === 0) return;
  const value = (key: string, absent: number): number => {
    const index = knobIndex(params, key);
    return index < 0 ? absent : (knobs[index] ?? 0);
  };
  const figures = value("join", 0);
  if (figures <= 0 || value("constellations", 0) <= 0 || value("stars", 1) <= 0) return;
  const time = knobIndex(params, "time");
  const clock = time < 0 ? undefined : (knobs[time] ?? 0) + (phases["cycle"] ?? 0);
  const night = joinNight(clock, value("cycle", 0), motionTime, poses.length, figures);
  if (!night.open) return;
  const count = joinPlan.figures.length;
  for (let figure = 0; figure < count; figure++) {
    const t = joinTime(night, figure);
    if (!(t >= 0 && t < (joinPlan.figures[figure]?.seconds ?? 0))) continue;
    // Whose job it is: its place in the night's rota among the agents (joinTime).
    const pose = poses[((figure - night.first + count) % count) % night.agents];
    if (pose === undefined) continue;
    pose.inside = false;
    pose.down = false;
  }
}
