// The room the solar-system mobile hangs in, shared by the simulation (sim.ts) and the shader
// (shader.ts): where the Sun hangs, the wall its shadows fall on, the camera and the passage. Metres,
// y up, z toward the viewer (sims/mobile.ts's convention); the wall is the plane z = WALL.
import { glslFloat, glslVec3 } from "../../shaders/glsl.ts";
import type { Vec3 } from "../../sims/verlet.ts";
import { SOLAR_SUN_RADIUS } from "./solar.ts";

/** Seconds of the entrance (lowered from above, the Sun lighting up) and the exit (the motor winding down, the Sun cooling, hoisted away). */
export const MOBILE_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** The wall's plane (z) and the ceiling's height (y). */
export const MOBILE_WALL = -1.4;
export const MOBILE_CEILING = 3.6;

/** The Sun's centre at rest, in the middle of the frame: the mobile's hook hangs above it to suit (solar.ts). */
export const MOBILE_SUN_CENTRE: Vec3 = [0, 1.75, 0];
/** The texture's origin: the middle of where the mobile hangs. */
export const MOBILE_TEX_ORIGIN: Vec3 = [0, 1.8, 0];

/**
 * The eye, above the planets' plane and looking down on it at about 26°, so each orbit shows as an
 * ellipse round the Sun, looking at the wall through `aim` (the pointer sways the eye a little).
 */
export const MOBILE_EYE: Vec3 = [0, 3.3, 3.0];
export const MOBILE_AIM: Vec3 = [0, 1.86, 0];
/** Half the width and height (m) of the region at z = 0 the frame keeps in view. */
export const MOBILE_FIT = { halfW: 1.65, halfH: 1.0 } as const;

/**
 * The camera without the pointer's sway, as the shader builds it: unit axes, and the focal length
 * (screen heights) at which the fit region fills the frame at this aspect.
 */
export interface MobileCamera {
  readonly fwd: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly focal: number;
}

export function mobileCamera(aspect: number): MobileCamera {
  const fx = MOBILE_AIM[0] - MOBILE_EYE[0];
  const fy = MOBILE_AIM[1] - MOBILE_EYE[1];
  const fz = MOBILE_AIM[2] - MOBILE_EYE[2];
  const fl = Math.hypot(fx, fy, fz);
  // fwd, right = fwd × y (normalised), up = right × fwd.
  const [wx, wy, wz] = [fx / fl, fy / fl, fz / fl];
  const rl = Math.hypot(wz, wx);
  const [rx, rz] = [-wz / rl, wx / rl];
  const dist = MOBILE_EYE[2] - MOBILE_AIM[2];
  return {
    fwd: [wx, wy, wz],
    right: [rx, 0, rz],
    up: [-rz * wy, rz * wx - rx * wz, rx * wy],
    focal: Math.min((0.47 * dist) / MOBILE_FIT.halfH, (0.47 * aspect * dist) / MOBILE_FIT.halfW),
  };
}

/**
 * The unit view ray through screen point (px, py), in screen heights about the frame's centre,
 * without the pointer's sway: for picking a planet under the pointer.
 */
export function mobileRay(px: number, py: number, aspect: number): Vec3 {
  const { fwd, right, up, focal } = mobileCamera(aspect);
  const x = fwd[0] * focal + right[0] * px + up[0] * py;
  const y = fwd[1] * focal + right[1] * px + up[1] * py;
  const z = fwd[2] * focal + right[2] * px + up[2] * py;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** The pointer's sway of the eye (m) at uPointer = ±1. */
export const MOBILE_SWAY = { x: 0.35, y: 0.15 } as const;

/** The passage: how far above its place the mobile is lowered from (m), and how far it is hoisted. */
export const MOBILE_LOWER = 2.2;
export const MOBILE_HOIST = 2.6;

export const mobileLayoutGlsl = `
const float MOBILE_WALL = ${glslFloat(MOBILE_WALL)};
const float MOBILE_CEILING = ${glslFloat(MOBILE_CEILING)};
const vec3 MOBILE_EYE = ${glslVec3(MOBILE_EYE)};
const vec3 MOBILE_AIM = ${glslVec3(MOBILE_AIM)};
const vec2 MOBILE_SWAY = vec2(${glslFloat(MOBILE_SWAY.x)}, ${glslFloat(MOBILE_SWAY.y)});
const float MOBILE_SUN_RADIUS = ${glslFloat(SOLAR_SUN_RADIUS)};

float mobileFocal(float aspect) {
  float dist = MOBILE_EYE.z - MOBILE_AIM.z;
  return min(${glslFloat(0.47)} * dist / ${glslFloat(MOBILE_FIT.halfH)}, ${glslFloat(0.47)} * aspect * dist / ${glslFloat(MOBILE_FIT.halfW)});
}
`;
