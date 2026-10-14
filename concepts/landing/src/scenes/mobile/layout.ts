// The room the mobile hangs in, shared by the simulation (sim.ts) and the shader (shader.ts): where
// the mobile is tied, the wall its shadows fall on, the camera, the lights and the passage. Metres,
// y up, z toward the viewer (sims/mobile.ts's convention); the wall is the plane z = WALL.
import { glslFloat } from "../../shaders/glsl.ts";
import type { Vec3 } from "../../sims/verlet.ts";

/** Seconds of the entrance (lowered from the ceiling on its link) and the exit (hoisted back up). */
export const MOBILE_PASSAGE = { enter: 2.6, exit: 1.5 } as const;

/** The wall's plane (z), the ceiling's height and the floor's (y). */
export const MOBILE_WALL = -1.4;
export const MOBILE_CEILING = 3.3;

/** Where the top link is tied to the ceiling, and its length down to the top arm's loop. */
export const MOBILE_ANCHOR: Vec3 = [0.3, MOBILE_CEILING, 0];
export const MOBILE_TOP_LINK = 0.92;
/** The top arm's span (m). */
export const MOBILE_SPAN = 1.05;
/** The texture's origin: the middle of where the mobile hangs. */
export const MOBILE_TEX_ORIGIN: Vec3 = [0, 1.8, 0];

/** The eye, looking straight at the wall through `aim` (the pointer sways the eye a little). */
export const MOBILE_EYE: Vec3 = [0, 1.62, 3.7];
export const MOBILE_AIM: Vec3 = [0, 1.72, 0];
/** Half the width and height (m) of the region at z = 0 the frame keeps in view. */
export const MOBILE_FIT = { halfW: 1.35, halfH: 1.05 } as const;

/** Focal length (screen heights) of the camera at this aspect: the fit region fills the frame. */
export function mobileFocal(aspect: number): number {
  const dist = MOBILE_EYE[2] - MOBILE_AIM[2];
  return Math.min((0.47 * dist) / MOBILE_FIT.halfH, (0.47 * aspect * dist) / MOBILE_FIT.halfW);
}

/**
 * The unit view ray through screen point (px, py), in screen heights about the frame's centre,
 * without the pointer's sway: for picking a plate under the pointer. The camera looks along -z.
 */
export function mobileRay(px: number, py: number, aspect: number): Vec3 {
  const f = mobileFocal(aspect);
  const l = Math.hypot(px, py, f);
  return [px / l, py / l, -f / l];
}

/** The pointer's sway of the eye (m) at uPointer = ±1. */
export const MOBILE_SWAY = { x: 0.35, y: 0.15 } as const;

/** The passage: how far above its place the mobile is lowered from (m), and how far it is hoisted. */
export const MOBILE_LOWER = 2.3;
export const MOBILE_HOIST = 2.6;

export const mobileLayoutGlsl = `
const float MOBILE_WALL = ${glslFloat(MOBILE_WALL)};
const float MOBILE_CEILING = ${glslFloat(MOBILE_CEILING)};
const vec3 MOBILE_EYE = vec3(${glslFloat(MOBILE_EYE[0])}, ${glslFloat(MOBILE_EYE[1])}, ${glslFloat(MOBILE_EYE[2])});
const vec3 MOBILE_AIM = vec3(${glslFloat(MOBILE_AIM[0])}, ${glslFloat(MOBILE_AIM[1])}, ${glslFloat(MOBILE_AIM[2])});
const vec3 MOBILE_HOOK = vec3(${glslFloat(MOBILE_ANCHOR[0])}, ${glslFloat(MOBILE_ANCHOR[1])}, ${glslFloat(MOBILE_ANCHOR[2])});
const vec2 MOBILE_SWAY = vec2(${glslFloat(MOBILE_SWAY.x)}, ${glslFloat(MOBILE_SWAY.y)});

float mobileFocal(float aspect) {
  float dist = MOBILE_EYE.z - MOBILE_AIM.z;
  return min(${glslFloat(0.47)} * dist / ${glslFloat(MOBILE_FIT.halfH)}, ${glslFloat(0.47)} * aspect * dist / ${glslFloat(MOBILE_FIT.halfW)});
}
`;
