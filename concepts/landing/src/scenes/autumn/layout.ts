// The park's fixed geometry, shared by sim.ts (where leaves fall and lie, where the M is laid) and
// shader.ts (which templates these numbers into GLSL, so the two cannot drift).
//
// World units are metres: x to the right, y up, z away from the viewer (depth). The camera is a
// shifted-lens pinhole at height `eye`, looking along +z, the horizon at screen height `horizon`;
// `focal` is in screen heights (the shared sky library's 0.5 / tan(fov / 2)), so a point at depth z
// lands at (x, y - eye) * focal / z from the horizon's centre.
//
//   path     a gravel walk drifting from the near left toward the far left: x = x0 - swing sin(rate (z - from)),
//            `half` its half width
//   tree     the great tree's trunk (base at x, z; radius at the foot; height of the first boughs) and the
//            canopy's shadow footprint (centre x, z, radius), the canopy's two shading layers by height
//   bench    a park bench facing the viewer: centre x, z, half length, and its depth and height
//   lamp     a cast-iron lamp post beside the path
//   carpet   the lattice the fallen leaves lie on: square cells `cell` metres wide from (x0, z0)
//   mark     the Manifold M, laid out along the path like a road marking (stretched in depth so that
//            it reads in perspective): centre, width, depth, stroke half width in M units
//   passage  the scene's entrance and exit: a gust blows a flurry of leaves through the canopy as the
//            camera lowers from the boughs onto the path; at the exit a stronger gust whirls the leaves
//            up across the frame as the camera tilts up into the canopy
import { glslFloat } from "../../shaders/glsl.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { AUTUMN_PASSAGE } from "./constants.ts";

/**
 * The entrance's gust, as a strength 0..1 by seconds into the entrance: it rises from the first frame,
 * fastest at once and easing in to full strength at `rise` (so that the leaves are already streaming when
 * the new scene shows through the dissolve), holds, and dies away from `fall` to nothing at the
 * entrance's end.
 */
export const AUTUMN_FLURRY = { rise: 1.1, fall: 1.7 } as const;

/** The entrance's gust strength `seconds` into the entrance (exactly 0 at its end); the shader repeats this. */
export function autumnFlurry(seconds: number): number {
  const still = 1 - clamp(seconds / AUTUMN_FLURRY.rise, 0, 1);
  return (1 - still * still) * (1 - smoothstep(AUTUMN_FLURRY.fall, AUTUMN_PASSAGE.enter, seconds));
}

/** The exit's gust rises over the first `rise` of the exit; `canopy` is how hard it leans the canopy, against the entrance's gust at 1. */
export const AUTUMN_WHIRL = { rise: 0.3, canopy: 1.3 } as const;

/**
 * The camera's lens shift (screen heights, up): the entrance starts this far up in the canopy, already
 * coming down, and settles onto the path; the exit rises this far from `exitFrom` of its progress,
 * gathering speed to the end.
 */
export const AUTUMN_TILT = { enter: 0.24, exit: 0.24, exitFrom: 0.15 } as const;

export const AUTUMN_VIEW = { horizon: 0.36, eye: 1.5, focal: 1.0 } as const;

export const AUTUMN_PATH = { x: -0.2, swing: 1.25, rate: 0.11, from: 3.0, half: 1.25 } as const;

/** Where the path's centre line runs at depth z. */
export function autumnPathX(z: number): number {
  return AUTUMN_PATH.x - AUTUMN_PATH.swing * Math.sin(AUTUMN_PATH.rate * (z - AUTUMN_PATH.from));
}

export const AUTUMN_TREE = {
  x: -3.3,
  z: 5.0,
  radius: 0.55,
  boughs: 3.0,
  canopyX: -1.0,
  canopyZ: 7.0,
  canopyRadius: 11.5,
} as const;

export const AUTUMN_BENCH = {
  x: 2.6,
  z: 7.6,
  half: 0.9,
  depth: 0.5,
  height: 0.9,
  seat: 0.45,
} as const;

export const AUTUMN_LAMP = { x: -2.7, z: 10.0, height: 3.8 } as const;

export const AUTUMN_CARPET = { cell: 0.3, x0: -14, z0: 3.3, cols: 100, rows: 96 } as const;

export const AUTUMN_MARK = {
  x: -0.9,
  z: 11.5,
  width: 2.8,
  depth: 11,
  stroke: 0.12,
  margin: 0.22,
} as const;

/** Leaves in the air at once (the falling-leaf texture's rows). */
export const AUTUMN_SLOTS = 36;

/** The layout as GLSL constants and the path's centre line (autumnPathX). */
export const autumnLayoutGlsl = `
const float AUTUMN_HORIZON = ${glslFloat(AUTUMN_VIEW.horizon)};
const float AUTUMN_EYE = ${glslFloat(AUTUMN_VIEW.eye)};
const float AUTUMN_FOCAL = ${glslFloat(AUTUMN_VIEW.focal)};
const vec4 AUTUMN_PATH = vec4(${glslFloat(AUTUMN_PATH.x)}, ${glslFloat(AUTUMN_PATH.swing)}, ${glslFloat(AUTUMN_PATH.rate)}, ${glslFloat(AUTUMN_PATH.from)});
const float AUTUMN_PATH_HALF = ${glslFloat(AUTUMN_PATH.half)};
const vec3 AUTUMN_TREE = vec3(${glslFloat(AUTUMN_TREE.x)}, ${glslFloat(AUTUMN_TREE.z)}, ${glslFloat(AUTUMN_TREE.radius)});
const float AUTUMN_BOUGHS = ${glslFloat(AUTUMN_TREE.boughs)};
const vec3 AUTUMN_CANOPY = vec3(${glslFloat(AUTUMN_TREE.canopyX)}, ${glslFloat(AUTUMN_TREE.canopyZ)}, ${glslFloat(AUTUMN_TREE.canopyRadius)});
const vec2 AUTUMN_BENCH_AT = vec2(${glslFloat(AUTUMN_BENCH.x)}, ${glslFloat(AUTUMN_BENCH.z)});
const vec4 AUTUMN_BENCH_SIZE = vec4(${glslFloat(AUTUMN_BENCH.half)}, ${glslFloat(AUTUMN_BENCH.depth)}, ${glslFloat(AUTUMN_BENCH.height)}, ${glslFloat(AUTUMN_BENCH.seat)});
const vec3 AUTUMN_LAMP = vec3(${glslFloat(AUTUMN_LAMP.x)}, ${glslFloat(AUTUMN_LAMP.z)}, ${glslFloat(AUTUMN_LAMP.height)});
const vec4 AUTUMN_CARPET = vec4(${glslFloat(AUTUMN_CARPET.x0)}, ${glslFloat(AUTUMN_CARPET.z0)}, ${glslFloat(AUTUMN_CARPET.cell)}, 0.0);
const ivec2 AUTUMN_CARPET_SIZE = ivec2(${AUTUMN_CARPET.cols}, ${AUTUMN_CARPET.rows});
const vec2 AUTUMN_MARK_AT = vec2(${glslFloat(AUTUMN_MARK.x)}, ${glslFloat(AUTUMN_MARK.z)});
const vec2 AUTUMN_MARK_SIZE = vec2(${glslFloat(AUTUMN_MARK.width / 0.94)}, ${glslFloat(AUTUMN_MARK.depth)});
const int AUTUMN_SLOTS = ${AUTUMN_SLOTS};
const vec2 AUTUMN_PASSAGE = vec2(${glslFloat(AUTUMN_PASSAGE.enter)}, ${glslFloat(AUTUMN_PASSAGE.exit)});
const vec2 AUTUMN_FLURRY = vec2(${glslFloat(AUTUMN_FLURRY.rise)}, ${glslFloat(AUTUMN_FLURRY.fall)});
const vec2 AUTUMN_WHIRL = vec2(${glslFloat(AUTUMN_WHIRL.rise)}, ${glslFloat(AUTUMN_WHIRL.canopy)});
const vec3 AUTUMN_TILT = vec3(${glslFloat(AUTUMN_TILT.enter)}, ${glslFloat(AUTUMN_TILT.exit)}, ${glslFloat(AUTUMN_TILT.exitFrom)});

// The gust of the scene's passage, 0 at rest: the entrance's flurry (0..1, autumnFlurry in layout.ts) or
// the exit's whirl (0..AUTUMN_WHIRL.y). The canopy leans before it.
float autumnPassageBlow() {
  float pin = passageIn();
  float pout = passageOut();
  float blow = 0.0;
  if (pin < 1.0) {
    float s = pin * AUTUMN_PASSAGE.x;
    float still = 1.0 - clamp(s / AUTUMN_FLURRY.x, 0.0, 1.0);
    blow = (1.0 - still * still) * (1.0 - smoothstep(AUTUMN_FLURRY.y, AUTUMN_PASSAGE.x, s));
  }
  if (pout > 0.0) blow = max(blow, AUTUMN_WHIRL.y * smoothstep(0.0, AUTUMN_WHIRL.x, pout));
  return blow;
}

// The camera's lens shift in screen heights, up, 0 at rest: it starts the entrance raised into the
// canopy, already coming down, and settles onto the path (easing out into a long, gentle tail); at
// the exit it tilts back up, gathering speed to the end.
float autumnLensShift() {
  float pin = passageIn();
  float pout = passageOut();
  float shift = 0.0;
  if (pin < 1.0) shift += AUTUMN_TILT.x * (1.0 - pin) * (1.0 - pin) * (1.0 - pin);
  if (pout > 0.0) {
    float t = clamp((pout - AUTUMN_TILT.z) / (1.0 - AUTUMN_TILT.z), 0.0, 1.0);
    shift += AUTUMN_TILT.y * t * t;
  }
  return shift;
}

// The path's centre line at depth z.
float autumnPathX(float z) {
  return AUTUMN_PATH.x - AUTUMN_PATH.y * sin(AUTUMN_PATH.z * (z - AUTUMN_PATH.w));
}
`;
