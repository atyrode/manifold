// Browser check of the solar-system mobile (verify-browser.ts, `mobile`):
// - parts: the shared mobile's GLSL (sims/mobile.ts) agrees with the CPU twin that drives the
//   physics, or the bodies drawn and the shadows on the wall would part from where the simulated
//   ones are. A still fixture of an arm of two balls and an arm of balls hung from its loop: the
//   sharp shadow `mobileShadow` throws on a wall and what `mobileTrace` sees from an eye, each
//   against the same picture worked out on the CPU from the balls' centres and radii.
// - kepler: the scene's own sim, motor at full speed, turns each planet's arm once in au^1.5 years of
//   `mobileYear` seconds (Kepler's third law) and the Moon's once a sidereal month: Mars against the
//   Earth 1.881.
// - sunlit: the scene's real program on its real sim: every planet whose sunward side faces across
//   the picture is brighter on that half of its disc than on the other.
// - rest: an entrance changes what is drawn while it plays, and leaves the sim, and so the picture
//   at rest, bit for bit what a scene that never had one draws.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, vertexSource } from "../../shaders/index.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import {
  Mobile,
  MOBILE_BALL_CODE,
  MOBILE_TEXELS,
  MobileTexture,
  mobileGlsl,
  type MobileDesign,
} from "../../sims/mobile.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { Vec3 } from "../../sims/verlet.ts";
import { mobileScene } from "./index.ts";
import {
  MOBILE_SUN_CENTRE,
  MOBILE_EYE,
  MOBILE_PASSAGE,
  MOBILE_TEX_ORIGIN,
  mobileCamera,
} from "./layout.ts";
import { mobileYear } from "./sim.ts";
import { SOLAR_BODIES, SOLAR_LOOKS, SOLAR_MOON, SOLAR_SUN_RADIUS, solarMobile } from "./solar.ts";

const ORIGIN: Vec3 = [0, 1.8, 0];
const WIDTH = 120;
const HEIGHT = 72;
/** The wall patch the shadow is drawn on (x0, y0, x1, y1 at z = WALL) and the lamp. */
const WALL = -1;
const PATCH = [-1.5, 0.6, 1.5, 2.6] as const;
const LAMP: Vec3 = [-1.2, 2.4, 2];
/** The eye and the image plane's half extents (rays (x, y, -1)). */
const EYE: Vec3 = [0.1, 1.8, 3];
const VIEW = [0.32, 0.22] as const;

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
      balls: [
        { radius: 0.12, mass: 0.1, look: 1 },
        { radius: 0.1, mass: 0.12, look: 2 },
      ],
    },
    {
      parent: 0,
      end: 2,
      depth: 1,
      link: 0.3,
      reach: [0.3, 0.42],
      loop: 0.03,
      heading: 2.2,
      balls: [
        { radius: 0.08, mass: 0.05, look: 3 },
        { radius: 0.05, mass: 0.036, look: 4 },
      ],
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

/** Whether the segment from `from` along `dir` (t in (0, limit)) meets any ball, by the CPU twin. */
function hitsBody(mobile: Mobile, from: Vec3, dir: Vec3, limit: number): boolean {
  const pos = mobile.system.positions;
  const dd = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
  for (let i = 0; i < mobile.balls; i++) {
    const { point, radius } = mobile.ball(i);
    const w = [0, 1, 2].map((c) => (pos[point * 3 + c] ?? 0) - (from[c] ?? 0));
    const t = ((w[0] ?? 0) * dir[0] + (w[1] ?? 0) * dir[1] + (w[2] ?? 0) * dir[2]) / dd;
    if (!(t > 0 && t < limit)) continue;
    const miss = Math.hypot(
      (w[0] ?? 0) - dir[0] * t,
      (w[1] ?? 0) - dir[1] * t,
      (w[2] ?? 0) - dir[2] * t,
    );
    if (miss < radius) return true;
  }
  return false;
}

/** The shared part's GLSL against its CPU twin (see the header). */
function verifyParts(gl: WebGL2RenderingContext): Record<string, unknown> {
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
    k = mobileTrace(vec3(${EYE.map((v) => v.toFixed(3)).join(", ")}), rd, 1.0e-5, 100.0, 0.0, 0.0).kind == MOBILE_BALL ? 1.0 : 0.0;
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
  try {
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
            expected = hitsBody(mobile, P, [LAMP[0] - P[0], LAMP[1] - P[1], LAMP[2] - P[2]], 1);
          } else {
            const x = VIEW[0] * (2 * u - 1);
            const y = VIEW[1] * (2 * v - 1);
            const l = Math.hypot(x, y, 1);
            expected = hitsBody(mobile, EYE, [x / l, y / l, -1 / l], 100);
          }
          const drawn = (bytes[(j * WIDTH + i) * 4] ?? 0) > 127;
          if (expected) covered++;
          if (drawn !== expected) mismatched++;
        }
      }
      // Pixels whose centre lies within a hair of an outline may fall either way, and a wire's
      // shadow may darken a pixel or two; anything more is the two pictures parting.
      const what = mode === 0 ? "shadow" : "bodies";
      if (covered < 200)
        throw new Error(`mobile: the ${what} fixture covers only ${covered} pixels`);
      if (mismatched > Math.max(8, 0.04 * covered))
        throw new Error(
          `mobile: GPU ${what} differ from the CPU twin in ${mismatched} of ${covered} covered pixels`,
        );
      result[what] = { covered, mismatched };
    }
  } finally {
    gl.deleteProgram(program);
    texture.dispose();
  }
  return result;
}

/** Arm k's heading in a packed mobile: end A (the planet) about its end B, anticlockwise from +x seen from above. */
function heading(data: ArrayLike<number>, k: number): number {
  const a = k * MOBILE_TEXELS * 4;
  const b = a + 4;
  return Math.atan2(-((data[a + 2] ?? 0) - (data[b + 2] ?? 0)), (data[a] ?? 0) - (data[b] ?? 0));
}

/** The scene's motors keep the planets' real periods (see the header). */
function verifyKepler(): Record<string, unknown> {
  const sim = new HeadlessSim(mobileScene);
  // In still air (a gust may set an arm back past its motor's slip, as it should), at full speed.
  const knobs = {
    ...paramDefaults("mobile"),
    motor: 1,
    "motor-amount": 1,
    wind: 0,
    gusts: 0,
    drift: 0,
  };
  const frame = { dt: 0.05, knobs };
  const year = mobileYear(1);
  const arms = solarMobile(1, 1, MOBILE_SUN_CENTRE).arms;
  const jupiter = SOLAR_BODIES.find((body) => body.name === "Jupiter")?.au ?? 0;
  const turned = new Float64Array(arms.length);
  let last = sim.step(frame).upload(0).data;
  // Spin up, then watch for a little over a Jupiter year.
  for (let i = 0; i < 100; i++) last = sim.step(frame).upload(0).data;
  const watch = 1.05 * jupiter ** 1.5 * year;
  const frames = Math.round(watch / frame.dt);
  for (let i = 0; i < frames; i++) {
    const next = sim.step(frame).upload(0).data;
    for (let k = 0; k < arms.length; k++) {
      let d = heading(next, k) - heading(last, k);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      turned[k] = (turned[k] ?? 0) + d;
    }
    last = next.slice();
  }
  const periods: Record<string, number> = {};
  const errors: string[] = [];
  arms.forEach((arm, k) => {
    const period = (2 * Math.PI * frames * frame.dt) / (turned[k] ?? 0);
    periods[arm.name] = period;
    const expected = arm.years * year;
    // Bodies that turn at least once while watched keep their period within 2%.
    if (expected <= watch && Math.abs(period / expected - 1) > 0.02)
      errors.push(`${arm.name} ${period.toFixed(2)} s against ${expected.toFixed(2)} s`);
  });
  const mars = SOLAR_BODIES.find((body) => body.name === "Mars")?.au ?? 0;
  const ratio = (periods.Mars ?? 0) / (periods.Earth ?? 1);
  if (Math.abs(ratio / mars ** 1.5 - 1) > 0.01)
    errors.push(`Mars/Earth ${ratio.toFixed(4)} against ${(mars ** 1.5).toFixed(4)}`);
  const month = (periods.Moon ?? 0) / (periods.Earth ?? 1);
  if (Math.abs(month / SOLAR_MOON.years - 1) > 0.02)
    errors.push(`Moon/Earth ${month.toFixed(4)} against ${SOLAR_MOON.years.toFixed(4)}`);
  if (errors.length > 0)
    throw new Error(`mobile: the motors miss Kepler's periods: ${errors.join("; ")}`);
  return { year, watched: watch, ratio, month, periods };
}

const SCENE_W = 480;
const SCENE_H = 270;

/** The scene's real program, ready to draw a texture at SCENE_W × SCENE_H, undithered. */
function sceneProgram(gl: WebGL2RenderingContext): {
  program: WebGLProgram;
  draw: (texture: WebGLTexture, passage: readonly [number, number]) => Uint8Array;
} {
  const program = compile(gl, fragmentSourceFor(mobileScene));
  gl.canvas.width = SCENE_W;
  gl.canvas.height = SCENE_H;
  gl.viewport(0, 0, SCENE_W, SCENE_H);
  gl.useProgram(program);
  const at = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform2f(at("uRes"), SCENE_W, SCENE_H);
  gl.uniform1f(at("uTime"), 4);
  gl.uniform1f(at("uMotionTime"), 4);
  gl.uniform1f(at("uMotion"), 1);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1i(at("uDither"), 3);
  gl.uniform1i(at("uColor"), 2);
  gl.uniform1f(at("uLevels"), 4);
  gl.uniform3f(at("uBg"), 0.03, 0.03, 0.04);
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform4fv(
    at("uParams"),
    packParams(renderSettings(defaultsFor("mobile"), paramDefaults("mobile")).params),
  );
  gl.uniform1i(at("uSim0"), 0);
  gl.uniform4f(at("uSimOn"), 1, 0, 0, 0);
  return {
    program,
    draw: (texture, passage) => {
      gl.useProgram(program);
      gl.uniform2f(at("uPassage"), passage[0], passage[1]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const bytes = new Uint8Array(SCENE_W * SCENE_H * 4);
      gl.readPixels(0, 0, SCENE_W, SCENE_H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return bytes;
    },
  };
}

/** A packed mobile as the scene's shader samples it. */
function upload(gl: WebGL2RenderingContext, data: Float32Array | Uint8Array): DataTexture {
  const texture = new DataTexture(gl, {
    width: data.length / 4,
    height: 1,
    format: "rgba16f",
    filter: "nearest",
  });
  texture.upload(data);
  return texture;
}

/** Where a point of the room lands on the SCENE_W × SCENE_H frame (pixels), and how far it is along the view. */
function project(point: Vec3): { x: number; y: number; z: number } {
  const { fwd, right, up, focal } = mobileCamera(SCENE_W / SCENE_H);
  const d = [point[0] - MOBILE_EYE[0], point[1] - MOBILE_EYE[1], point[2] - MOBILE_EYE[2]];
  const dot = (v: Vec3) => (d[0] ?? 0) * v[0] + (d[1] ?? 0) * v[1] + (d[2] ?? 0) * v[2];
  const z = dot(fwd);
  return {
    x: (dot(right) / z) * focal * SCENE_H + SCENE_W / 2,
    y: (dot(up) / z) * focal * SCENE_H + SCENE_H / 2,
    z,
  };
}

/** Each planet is lit on the side toward the Sun (see the header). */
function verifySunlit(gl: WebGL2RenderingContext): Record<string, unknown> {
  const scene = sceneProgram(gl);
  const frame = { dt: 1 / 30, aspect: SCENE_W / SCENE_H, height: SCENE_H };
  const twin = new HeadlessSim(mobileScene);
  for (let i = 0; i < 60; i++) twin.step(frame);
  const data = twin.upload(0).data;
  const texture = upload(gl, data);
  try {
    const bytes = scene.draw(texture.texture, [1, 0]);
    const texel = (k: number, i: number, c: number) => data[(k * MOBILE_TEXELS + i) * 4 + c] ?? 0;
    // Every ball: its centre (in the room), radius and look.
    const origin = MOBILE_TEX_ORIGIN;
    const balls: { c: Vec3; r: number; look: number }[] = [];
    for (let k = 0; texel(k, 0, 3) > 0.5; k++) {
      for (const e of [0, 1]) {
        const code = texel(k, 4 + e, 0);
        if (code < MOBILE_BALL_CODE - 0.5) continue;
        balls.push({
          c: [texel(k, e, 0) + origin[0], texel(k, e, 1) + origin[1], texel(k, e, 2) + origin[2]],
          r: texel(k, 4 + e, 1),
          look: Math.round(code - MOBILE_BALL_CODE),
        });
      }
    }
    // The Sun, threaded on its arm's loop (texel +2).
    const sunArm = solarMobile(1, 1, MOBILE_SUN_CENTRE).sun;
    const S: Vec3 = [
      texel(sunArm, 2, 0) + origin[0],
      texel(sunArm, 2, 1) + origin[1],
      texel(sunArm, 2, 2) + origin[2],
    ];
    const discs = [...balls, { c: S, r: SOLAR_SUN_RADIUS, look: -1 }].map((ball) => {
      const p = project(ball.c);
      return {
        ...ball,
        ...p,
        rp: (ball.r * mobileCamera(SCENE_W / SCENE_H).focal * SCENE_H) / p.z,
      };
    });
    const lum = (x: number, y: number) => {
      const o = (y * SCENE_W + x) * 4;
      return 0.2126 * (bytes[o] ?? 0) + 0.7152 * (bytes[o + 1] ?? 0) + 0.0722 * (bytes[o + 2] ?? 0);
    };
    const tested: Record<string, { day: number; night: number }> = {};
    for (const disc of discs) {
      if (disc.look < 0 || disc.look === SOLAR_LOOKS.weight || disc.look === SOLAR_LOOKS.saturn)
        continue;
      if (disc.rp < 3) continue;
      // Clear of every other disc on the picture.
      if (discs.some((o) => o !== disc && Math.hypot(o.x - disc.x, o.y - disc.y) < o.rp + disc.rp))
        continue;
      // The way to the Sun across the picture, and how much of it lies across rather than along the view.
      const to = [S[0] - disc.c[0], S[1] - disc.c[1], S[2] - disc.c[2]];
      const tl = Math.hypot(to[0] ?? 0, to[1] ?? 0, to[2] ?? 0);
      const step = 0.01;
      const ahead = project([
        disc.c[0] + ((to[0] ?? 0) / tl) * step,
        disc.c[1] + ((to[1] ?? 0) / tl) * step,
        disc.c[2] + ((to[2] ?? 0) / tl) * step,
      ]);
      const lx = ahead.x - disc.x;
      const ly = ahead.y - disc.y;
      const across = Math.hypot(lx, ly) / ((step * disc.rp) / disc.r);
      if (across < 0.5) continue;
      // A planet between the eye and the Sun shows a crescent, mostly past the limb's sampled disc:
      // only those at least about half lit as seen are judged (phase angle under ~100°).
      const eye = [MOBILE_EYE[0] - disc.c[0], MOBILE_EYE[1] - disc.c[1], MOBILE_EYE[2] - disc.c[2]];
      const el = Math.hypot(eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0);
      const phase =
        ((eye[0] ?? 0) * (to[0] ?? 0) +
          (eye[1] ?? 0) * (to[1] ?? 0) +
          (eye[2] ?? 0) * (to[2] ?? 0)) /
        (el * tl);
      if (phase < -0.17) continue;
      let day = 0;
      let night = 0;
      let dayN = 0;
      let nightN = 0;
      const reach = Math.ceil(disc.rp);
      for (let y = Math.floor(disc.y) - reach; y <= Math.ceil(disc.y) + reach; y++) {
        for (let x = Math.floor(disc.x) - reach; x <= Math.ceil(disc.x) + reach; x++) {
          if (x < 0 || y < 0 || x >= SCENE_W || y >= SCENE_H) continue;
          const qx = x + 0.5 - disc.x;
          const qy = y + 0.5 - disc.y;
          if (Math.hypot(qx, qy) > 0.75 * disc.rp) continue;
          const s = (qx * lx + qy * ly) / (Math.hypot(lx, ly) * disc.rp);
          if (s > 0.25) {
            day += lum(x, y);
            dayN++;
          } else if (s < -0.25) {
            night += lum(x, y);
            nightN++;
          }
        }
      }
      if (dayN === 0 || nightN === 0) continue;
      const name =
        Object.entries(SOLAR_LOOKS).find(([, look]) => look === disc.look)?.[0] ?? `${disc.look}`;
      tested[name] = { day: day / dayN, night: night / nightN };
    }
    const names = Object.keys(tested);
    if (names.length < 3)
      throw new Error(`mobile: only ${names.length} planets face the Sun across the picture`);
    const dark = names.filter((name) => {
      const t = tested[name];
      return t === undefined || t.day < 1.5 * t.night + 8;
    });
    if (dark.length > 0)
      throw new Error(
        `mobile: not lit on the Sun's side: ${dark.map((name) => `${name} ${JSON.stringify(tested[name])}`).join(", ")}`,
      );
    return tested;
  } finally {
    texture.dispose();
    gl.deleteProgram(scene.program);
  }
}

/** Pixels that differ between two frames. */
function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let at = 0; at < a.length; at += 4)
    if (a[at] !== b[at] || a[at + 1] !== b[at + 1] || a[at + 2] !== b[at + 2]) count++;
  return count;
}

/** An entrance leaves nothing behind at rest (see the header). */
function verifyRest(gl: WebGL2RenderingContext): Record<string, unknown> {
  const frame = { dt: 1 / 30, aspect: SCENE_W / SCENE_H, height: SCENE_H };
  const entered = new HeadlessSim(mobileScene);
  const never = new HeadlessSim(mobileScene);
  const scene = sceneProgram(gl);
  let during = 0;
  let middle: Float32Array | Uint8Array | undefined;
  const frames = Math.ceil((MOBILE_PASSAGE.enter + 1.5) / frame.dt);
  for (let i = 1; i <= frames; i++) {
    const enter = Math.min(1, (i * frame.dt) / MOBILE_PASSAGE.enter);
    const a = entered.step({ ...frame, passage: { enter } }).upload(0).data;
    const b = never.step(frame).upload(0).data;
    let same = a.length === b.length;
    for (let j = 0; same && j < a.length; j++) same = a[j] === b[j];
    if (enter < 1 && !same) during++;
    if (enter < 1 && enter > 0.4 && middle === undefined) middle = a.slice();
    if (enter >= 1 && !same)
      throw new Error(
        `mobile: ${(i * frame.dt).toFixed(2)} s in, at rest after an entrance, the mobile is not where it is without one`,
      );
  }
  if (during === 0 || middle === undefined)
    throw new Error("mobile: the entrance never moved the mobile");
  const rest = upload(gl, entered.upload(0).data);
  const plain = upload(gl, never.upload(0).data);
  const coming = upload(gl, middle);
  try {
    const atRest = scene.draw(rest.texture, [1, 0]);
    const restChanged = differing(atRest, scene.draw(plain.texture, [1, 0]));
    if (restChanged > 0)
      throw new Error(`mobile: at rest after an entrance ${restChanged} pixels differ`);
    const comingChanged = differing(atRest, scene.draw(coming.texture, [0.5, 0]));
    if (comingChanged < 0.05 * SCENE_W * SCENE_H)
      throw new Error(`mobile: halfway in, only ${comingChanged} pixels differ from rest`);
    return { framesMoved: during, restChanged, comingChanged };
  } finally {
    for (const texture of [rest, plain, coming]) texture.dispose();
    gl.deleteProgram(scene.program);
  }
}

/** Throws unless the shared parts, the motors, the sunlight and the passage hold (see the header). */
export function mobileVerify(gl: WebGL2RenderingContext): Record<string, unknown> {
  return {
    parts: verifyParts(gl),
    kepler: verifyKepler(),
    sunlit: verifySunlit(gl),
    rest: verifyRest(gl),
  };
}
