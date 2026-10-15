// GPU check of the shared mobile part (sims/mobile.ts) as the mobile scene compiles it: the GLSL's
// plate frames, outlines and projections must agree with the CPU twin that drives the physics, or
// the plates drawn and the shadows on the wall would part from where the simulated plates are.
// Two masks from a still mobile whose plates are spun, twisted and off-centre outlines (a drop and a
// crescent): the sharp shadow `mobileShadow` throws on a wall, and the plates `mobileTrace` sees from
// an eye, each against the same picture worked out on the CPU from `Mobile.plateFrame` and
// `mobilePlateDistance`.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import {
  Mobile,
  MobileTexture,
  mobileGlsl,
  mobilePlateDistance,
  type MobileDesign,
  type MobilePlateDesign,
} from "../../sims/mobile.ts";
import type { Vec3 } from "../../sims/verlet.ts";
import { mobileScene } from "./index.ts";

const ORIGIN: Vec3 = [0, 1.8, 0];
const WIDTH = 120;
const HEIGHT = 72;
/** The wall patch the shadow is drawn on (x0, y0, x1, y1 at z = WALL) and the lamp. */
const WALL = -1;
const PATCH = [-1.5, 0.8, 1.5, 2.6] as const;
const LAMP: Vec3 = [-1.2, 2.4, 2];
/** The eye and the image plane's half extents (rays (x, y, -1)). */
const EYE: Vec3 = [0.1, 1.9, 3];
const VIEW = [0.32, 0.2] as const;

const plates: [MobilePlateDesign, MobilePlateDesign] = [
  { shape: 2, size: 0.16, spin: 0.5, twist: 0.4, tone: 0, markable: false },
  { shape: 3, size: 0.13, spin: -0.3, twist: -0.5, tone: 0, markable: false },
];
const design: MobileDesign = {
  anchor: [0, 2.3, 0],
  arms: [
    {
      parent: -1,
      end: 0,
      depth: 0,
      link: 0.3,
      reach: [0.35, 0.25],
      loop: 0.03,
      heading: 0.6,
      plates,
    },
  ],
};

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("mobile: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "mobile: compile failed");
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "mobile: link failed");
  return program;
}

/** Whether the segment from `from` along `dir` (t in (0, limit)) meets any plate, by the CPU twin. */
function hitsPlate(mobile: Mobile, from: Vec3, dir: Vec3, limit: number): boolean {
  const f = new Float64Array(12);
  for (let i = 0; i < plates.length; i++) {
    mobile.plateFrame(i, f);
    const plate = plates[i];
    if (plate === undefined) continue;
    const dn = dir[0] * (f[9] ?? 0) + dir[1] * (f[10] ?? 0) + dir[2] * (f[11] ?? 0);
    if (Math.abs(dn) < 1e-9) continue;
    const t =
      (((f[0] ?? 0) - from[0]) * (f[9] ?? 0) +
        ((f[1] ?? 0) - from[1]) * (f[10] ?? 0) +
        ((f[2] ?? 0) - from[2]) * (f[11] ?? 0)) /
      dn;
    if (!(t > 0 && t < limit)) continue;
    const x = [0, 1, 2].map((c) => (from[c] ?? 0) + (dir[c] ?? 0) * t - (f[c] ?? 0));
    const qx =
      ((x[0] ?? 0) * (f[3] ?? 0) + (x[1] ?? 0) * (f[4] ?? 0) + (x[2] ?? 0) * (f[5] ?? 0)) /
      plate.size;
    const qy =
      ((x[0] ?? 0) * (f[6] ?? 0) + (x[1] ?? 0) * (f[7] ?? 0) + (x[2] ?? 0) * (f[8] ?? 0)) /
      plate.size;
    if (mobilePlateDistance(plate.shape, qx, qy) < 0) return true;
  }
  return false;
}

/** Throws unless the GPU's mobile shadow and plates match the CPU twin's to within edge pixels. */
export function mobileVerify(gl: WebGL2RenderingContext): Record<string, unknown> {
  const program = compile(
    gl,
    fragmentSourceFor({
      ...mobileScene,
      entry: "regressionMobile",
      glsl: `${mobileGlsl("uSim0", ORIGIN)}
uniform int regressionMode;
Shade regressionMobile(vec2 uv, vec2 cell, float t) {
  float k;
  if (regressionMode == 0) {
    vec3 P = vec3(mix(${PATCH[0].toFixed(3)}, ${PATCH[2].toFixed(3)}, uv.x), mix(${PATCH[1].toFixed(3)}, ${PATCH[3].toFixed(3)}, uv.y), ${WALL.toFixed(3)});
    k = mobileShadow(P, vec3(${LAMP.map((v) => v.toFixed(3)).join(", ")}), 1.0e-4, -1, -1) > 0.5 ? 1.0 : 0.0;
  } else {
    vec3 rd = normalize(vec3(mix(-${VIEW[0].toFixed(3)}, ${VIEW[0].toFixed(3)}, uv.x), mix(-${VIEW[1].toFixed(3)}, ${VIEW[1].toFixed(3)}, uv.y), -1.0));
    k = mobileTrace(vec3(${EYE.map((v) => v.toFixed(3)).join(", ")}), rd, 1.0e-5, 100.0, 0.0, 0.0).kind == MOBILE_PLATE ? 1.0 : 0.0;
  }
  return shadeOf(vec3(k), k, 0.0);
}`,
    }),
  );
  const mobile = new Mobile(design);
  const texture = new MobileTexture(gl, ORIGIN);
  texture.upload(mobile);
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture.texture);
  gl.uniform1i(gl.getUniformLocation(program, "uSim0"), 0);
  gl.uniform4f(gl.getUniformLocation(program, "uSimOn"), 1, 0, 0, 0);
  gl.uniform2f(gl.getUniformLocation(program, "uRes"), WIDTH, HEIGHT);
  gl.uniform1i(gl.getUniformLocation(program, "uView"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uDither"), 3);
  gl.uniform2f(gl.getUniformLocation(program, "uPassage"), 1, 0);

  const result: Record<string, unknown> = {};
  for (const mode of [0, 1] as const) {
    gl.uniform1i(gl.getUniformLocation(program, "regressionMode"), mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    let covered = 0;
    let mismatched = 0;
    for (let j = 0; j < HEIGHT; j++) {
      for (let i = 0; i < WIDTH; i++) {
        const u = (i + 0.5) / WIDTH;
        const v = (j + 0.5) / HEIGHT;
        let expected: boolean;
        if (mode === 0) {
          const P: Vec3 = [
            PATCH[0] + (PATCH[2] - PATCH[0]) * u,
            PATCH[1] + (PATCH[3] - PATCH[1]) * v,
            WALL,
          ];
          expected = hitsPlate(mobile, P, [LAMP[0] - P[0], LAMP[1] - P[1], LAMP[2] - P[2]], 1);
        } else {
          const x = VIEW[0] * (2 * u - 1);
          const y = VIEW[1] * (2 * v - 1);
          const l = Math.hypot(x, y, 1);
          expected = hitsPlate(mobile, EYE, [x / l, y / l, -1 / l], 100);
        }
        const drawn = (bytes[(j * WIDTH + i) * 4] ?? 0) > 127;
        if (expected) covered++;
        if (drawn !== expected) mismatched++;
      }
    }
    // Pixels whose centre lies within a hair of an outline may fall either way, and a wire's shadow
    // may darken a pixel or two; anything more is the two pictures parting.
    if (covered < 60)
      throw new Error(
        `mobile: the ${mode === 0 ? "shadow" : "plates"} fixture covers only ${covered} pixels`,
      );
    if (mismatched > Math.max(6, 0.04 * covered))
      throw new Error(
        `mobile: GPU ${mode === 0 ? "shadow" : "plates"} differ from the CPU twin in ${mismatched} of ${covered} covered pixels`,
      );
    result[mode === 0 ? "shadow" : "plates"] = { covered, mismatched };
  }
  gl.deleteProgram(program);
  texture.dispose();
  return result;
}
