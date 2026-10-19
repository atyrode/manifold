// What the meadow's preset and layer manifests (index.ts, layers.ts) share with its GLSL and sims
// (shader.ts, sim.ts, wildflowers.ts), without loading them: the rig, the passage that moves it and
// the front it sends through the gust field, the tree line's depth and the most clocks.
import type { PassageGustShape } from "../../composer/gust.ts";
import type { Rig } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { clamp } from "../../sims/math.ts";

/** Screen height of the horizon (uv.y). */
export const MEADOW_HORIZON = 0.4;
/** Focal length in screen heights per unit of ray slope: a vertical field of view of about 46°. */
export const MEADOW_FOCAL = 1.18;
/** Eye height above the ground (m): standing in grass that reaches past the hips. */
export const MEADOW_GROUND = 2;
/** Depth of the tree line at the far edge of the meadow (m): where the downs' land ends. */
export const MEADOW_TREES_Z = 110;
/** The most dandelion clocks. */
export const MAX_CLOCKS = 5;
/**
 * Rows of the composer's records atlas each layer writes (LayerDef.data): the grass's breath; the
 * dandelions' seeds (three rows) and a row per clock; the wildflowers' clumps and their organs.
 */
export const MEADOW_ROWS = { grass: 1, dandelions: 3 + MAX_CLOCKS, wildflowers: 5 } as const;

/** Seconds the entrance and the exit take (SceneDef.passage; the rig's passage reads them too). */
export const MEADOW_PASSAGE = { enter: 3, exit: 1.6 } as const;

/**
 * The passage's choreography, in seconds into the entrance or the exit. The rig's height above rest
 * (m): it starts `dropIn` up (the sky and the far field in view, the near grass below the frame)
 * already on its way down, lowers into the grass over the first `descentLength` seconds, braking
 * (ease-out) and settling a little past rest (`settle`: the phase of the cosine that overshoots); and
 * leaving it rises from `liftFrom` over `liftLength`, accelerating to the end, to `dropOut`. Both are
 * eased in the height as the picture sees it, drop / (drop + `near`): the near grass fills the view
 * while the eye is within `near` of rest and moves the picture far more than the same rise does
 * higher up, so a height eased in that measure moves the picture at the pace the ease gives (fastest
 * as the scene arrives, and as it leaves). The passage gust (MEADOW_PASSAGE_GUST) is a front like the
 * 'now' gust (its shape, wobble and the same ground), with its own gain, leading edge and short tail
 * so it is a wave and not a flood.
 */
export const MEADOW_MOVE = {
  dropIn: 1.35,
  dropOut: 2.4,
  near: 0.5,
  descentLength: 2.55,
  settle: 0.8 * Math.PI,
  liftFrom: 0.25,
  liftLength: 1.35,
  gustInAmp: 0.75,
} as const;

/** The share of the descent (its end) and of the lift (its start) over which cells take up or let go of cutting their edges, one by one. */
const CUT_FADE = 0.25;

/**
 * The front the meadow's passage sends through the gust field (composer/gust.ts): arriving, a first
 * wave once the eye has mostly come down, fading before the scene is at rest; leaving, a strong one.
 */
export const MEADOW_PASSAGE_GUST: PassageGustShape = {
  enter: MEADOW_PASSAGE.enter,
  exit: MEADOW_PASSAGE.exit,
  from: -4,
  gain: 1.2,
  edge: 3,
  tail: 7,
  inAt: 1.3,
  inSpeed: 18,
  inAmp: MEADOW_MOVE.gustInAmp,
  inRise: 0.3,
  inFade: 0.9,
  outSpeed: 22,
  outAmp: 1.2,
  outRise: 0.25,
};

/** How far above its rest height the eye is (m): 0 at rest. GLSL: rigLift (MEADOW_RIG). */
export function meadowDrop(enter: number, exit: number): number {
  const M = MEADOW_MOVE;
  const a = clamp((enter * MEADOW_PASSAGE.enter) / M.descentLength, 0, 1);
  const down = 1 - (1 - a) * (1 - a);
  const up = clamp((exit * MEADOW_PASSAGE.exit - M.liftFrom) / M.liftLength, 0, 1);
  // The height as the picture sees it (drop / (drop + near)), eased, and back to metres.
  const seen =
    (M.dropIn / (M.dropIn + M.near)) * (1 - down) * Math.cos(down * M.settle) +
    (M.dropOut / (M.dropOut + M.near)) * up * up;
  return (M.near * seen) / (1 - seen);
}

const M = MEADOW_MOVE;

/**
 * The meadow's rig: standing in the grass at golden hour, turned toward the sinking sun; lowered into
 * the grass as the scene arrives and lifted out as it leaves (rigLift, meadowDrop's twin), every cell
 * cutting its edges while it moves (rigCut), and a gust sent through on the way.
 */
export const MEADOW_RIG: Rig = {
  horizon: MEADOW_HORIZON,
  focal: MEADOW_FOCAL,
  eye: MEADOW_GROUND,
  turn: 0.8,
  pitch: 0,
  // No stage: nothing of the meadow is laid out across the frame's width.
  minAspect: 1,
  passage: {
    lift: meadowDrop,
    gust: MEADOW_PASSAGE_GUST,
    glsl: `
// ---- the meadow's passage: the eye lowered into the grass and lifted out (constants.ts) ----
const float MEADOW_ENTER = ${glslFloat(MEADOW_PASSAGE.enter)};
const float MEADOW_EXIT = ${glslFloat(MEADOW_PASSAGE.exit)};
const float MEADOW_DROP_IN = ${glslFloat(M.dropIn)};
const float MEADOW_DROP_OUT = ${glslFloat(M.dropOut)};
const float MEADOW_NEAR = ${glslFloat(M.near)};
const float MEADOW_DESCENT_LENGTH = ${glslFloat(M.descentLength)};
const float MEADOW_SETTLE = ${glslFloat(M.settle)};
const float MEADOW_LIFT_FROM = ${glslFloat(M.liftFrom)};
const float MEADOW_LIFT_LENGTH = ${glslFloat(M.liftLength)};
const float MEADOW_CUT_FADE = ${glslFloat(CUT_FADE)};

// How far above its rest height the eye is (m; meadowDrop): 0 at rest. It lowers into the grass as
// the scene arrives, on its way from the first frame and braking to settle a little past rest, and
// rises out of it, speeding up to the end, as the scene leaves.
float rigLift() {
  float a = clamp(passageIn() * MEADOW_ENTER / MEADOW_DESCENT_LENGTH, 0.0, 1.0);
  float down = 1.0 - (1.0 - a) * (1.0 - a);
  float up = clamp((passageOut() * MEADOW_EXIT - MEADOW_LIFT_FROM) / MEADOW_LIFT_LENGTH, 0.0, 1.0);
  float seen = MEADOW_DROP_IN / (MEADOW_DROP_IN + MEADOW_NEAR) * (1.0 - down) * cos(down * MEADOW_SETTLE) + MEADOW_DROP_OUT / (MEADOW_DROP_OUT + MEADOW_NEAR) * up * up;
  return MEADOW_NEAR * seen / (1.0 - seen);
}

// The share of cells that cut their edges for the eye's motion (0 at rest): all of them while it
// moves, taken up as the lift starts and let go as the descent settles.
float rigCut() {
  float a = clamp(passageIn() * MEADOW_ENTER / MEADOW_DESCENT_LENGTH, 0.0, 1.0);
  float up = clamp((passageOut() * MEADOW_EXIT - MEADOW_LIFT_FROM) / MEADOW_LIFT_LENGTH, 0.0, 1.0);
  return clamp(max(1.0 - a, up) / MEADOW_CUT_FADE, 0.0, 1.0);
}
`,
  },
};
