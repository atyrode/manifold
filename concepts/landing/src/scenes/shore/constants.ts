// What the Shore preset and its layer manifests (index.ts, layers.ts) share with its GLSL and sims
// (shader.ts, sim.ts, cairns.ts), without loading them: the rig the beach is seen through and the
// passage that tilts it, the light it is graded by, the gulls' flyway and where the cairns stand.
import type { Flyway, Grade, Rig } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { SHORE_BEACH, SHORE_FOCAL } from "./beach.ts";

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Both are played in the picture: the
 * sea's surf runs in from out at sea on a decelerating curve under a lens that settles from the sand
 * up to the horizon (SHORE_RIG's passage), and is drawn back out to sea on the way out.
 */
export const SHORE_PASSAGE = { enter: 3, exit: 1.7 } as const;

/**
 * How far round from the sky's frame the beach faces (rad), toward moonrise: at the default hour
 * (time 0.82) the moon stands six degrees up a little right of ahead, its path lying across the
 * breakers, and at dawn the sun comes up at the right edge of the frame.
 */
export const SHORE_FACING = 0.506;

/** The passage's lens tilt down at the sand as the entrance begins, in screen heights. */
const SHORE_TILT = 0.085;

/**
 * The beach's rig: a level pinhole SHORE_BEACH.eye metres over the still water, a long lens that
 * stacks up the surf, turned toward moonrise. Nothing is laid out across the frame's width, so it has
 * no stage. Its passage moves no eye: it tilts the lens (rigShift), the frame's content read lower
 * in uv at the start of the entrance and settling with a little overshoot onto the horizon.
 */
export const SHORE_RIG: Rig = {
  horizon: SHORE_BEACH.horizon,
  focal: SHORE_FOCAL,
  eye: SHORE_BEACH.eye,
  turn: -SHORE_FACING,
  pitch: 0,
  minAspect: 1,
  passage: {
    lift: () => 0,
    shift: true,
    glsl: `
// ---- the shore's passage: the lens tilted down at the sand settles onto the horizon (constants.ts) ----
const float SHORE_TILT = ${glslFloat(SHORE_TILT)};

float rigLift() {
  return 0.0;
}

float rigCut() {
  return 0.0;
}

// The lens's vertical shift in screen heights: it starts tilted down at the sand, already moving,
// and comes up to the horizon with a little overshoot. 0 at rest.
float rigShift() {
  float pin = passageIn();
  if (pin >= 1.0) return 0.0;
  float settle = passageSettle(pin, 1.7);
  return -SHORE_TILT * (1.0 - settle);
}
`,
  },
};

/** The beach's light: the World's sky as it is (the sea lights its own surf by it), its ink. */
export const SHORE_GRADE: Grade = { ink: { gain: 1.3, gamma: 0.8 } };

/**
 * The World's gulls: over the surf and the sea 12 to 160 metres out, cruising from just over the
 * horizon to the top of the frame, a swooping party skimming the water at 1.2 metres, drawn half as
 * large again as life; they fade into the mist low over the sea by `ext` per metre. The sea's mirror
 * shows them by the same flyway (shader.ts shoreFlyway).
 */
export const SHORE_FLYWAY: Flyway = {
  depth: [12, 160],
  above: 0.03,
  top: 0.95,
  seed: 8.2,
  skim: 1.2,
  spread: 1.5,
  ext: 0.002,
};

/** The cairns' sites: across the beach (m), and how far up it from the still-water line (m). */
export const SHORE_CAIRN_SITES: readonly { readonly x: number; readonly e: number }[] = [
  { x: -2.8, e: 2.3 },
  { x: -0.9, e: 2.7 },
  { x: 1.0, e: 2.5 },
  { x: 2.9, e: 2.9 },
];

/** The cairns' rows of the records atlas: a row per site, then the carried pebbles' (cairns.ts). */
export const SHORE_CAIRN_ROWS = SHORE_CAIRN_SITES.length + 1;
