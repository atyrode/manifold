// Pasture enclosures and their herds, observed through the actual countryside shader (WebGL):
// field-type shares with pasture, animals only inside enclosure interiors, and herds that hold
// still at motion 0 and move with the motion clock.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { sceneDefs } from "../index.ts";

// Large enough that the nearest herds draw whole bodies (a cow ~2.4 cells long) and farther ones
// specks; only the land below the horizon is drawn and compared.
const WIDTH = 400;
const HEIGHT = 250;
const LAND = Math.floor(HEIGHT * 0.6);

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  const shaders = [vertexSource, fragment].map((source, index) => {
    const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    check(Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)), gl.getShaderInfoLog(shader) ?? "compile failed");
    gl.attachShader(linked, shader);
    return shader;
  });
  gl.linkProgram(linked);
  check(Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)), gl.getProgramInfoLog(linked) ?? "link failed");
  for (const shader of shaders) gl.deleteShader(shader);
  return linked;
}

function pixels(gl: WebGL2RenderingContext, width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
  return bytes;
}

/** Land pixels whose colour differs between two frames, as a mask. */
function differing(a: Uint8Array, b: Uint8Array): Uint8Array {
  const mask = new Uint8Array(WIDTH * LAND);
  for (let at = 0; at < mask.length; at++) {
    const i = at * 4;
    mask[at] = a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] ? 1 : 0;
  }
  return mask;
}

function count(mask: Uint8Array): number {
  return mask.reduce((sum, value) => sum + value, 0);
}

/**
 * Field shares with pasture through countryFieldCrop; herds confined to enclosure interiors at
 * several motion times; frames that hold still at motion 0, and herds that move as the motion
 * clock advances.
 */
export function verifyCountryAnimals(gl: WebGL2RenderingContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const country = sceneDefs.country;
  // regressionMode 0: the actual scene. 1: white where the bare ground's field is an enclosure.
  // 2: one field hash per pixel across, its type out (crop / 9).
  const scene = program(
    gl,
    fragmentSourceFor({
      ...country,
      entry: "regressionHerds",
      glsl:
        country.glsl +
        `
      uniform int regressionMode;
      Shade regressionHerds(vec2 uv, vec2 cell, float t) {
        if (regressionMode == 2) {
          float crop = countryFieldCrop(gl_FragCoord.x / uRes.x, K_season);
          return shadeOf(vec3(crop / 9.0), crop / 9.0, 0.0);
        }
        Shade actual = sceneCountry(uv, cell, t);
        if (regressionMode == 0) return actual;
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
        vec2 spots = vec2(-0.2, 0.24) * aspect + countrySeed * 0.004 * aspect;
        for (int k = 0; k < 6; k++) {
          float i = float(k);
          float d = countryLayer(i).x;
          float crest = countryGroundCrest(i, p.x, spots);
          if (p.y < crest) {
            vec2 site = vec2(0.0);
            vec2 other = vec2(0.0);
            vec2 axis = vec2(0.0);
            vec2 w = vec2(p.x * d, countryDown(crest - p.y, d));
            vec2 field = countryCells(countryFieldSpace(i, w), site, other, axis);
            float pen = countryFieldCrop(field.y, K_season) > 8.5 ? 1.0 : 0.0;
            return shadeOf(vec3(pen), pen, 0.0);
          }
        }
        return shadeOf(vec3(0.0), 0.0, 0.0);
      }`,
    }),
  );
  gl.useProgram(scene);
  const uniform = (name: string) => gl.getUniformLocation(scene, name);
  gl.uniform1i(uniform("uView"), 1);
  gl.uniform1i(uniform("uColor"), 2);
  gl.uniform1f(uniform("uLevels"), 4);
  gl.uniform1fv(uniform("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform2f(uniform("uPassage"), 1, 0);
  const settle = (knobs: Record<string, number>): void => {
    gl.uniform1fv(
      uniform("uParams"),
      Float32Array.from(renderSettings(defaultsFor("country"), { ...paramDefaults("country"), ...knobs }).params),
    );
  };

  // (a) Shares, scale invariance, exclusion, crop diversity and the all-zero fallback.
  gl.canvas.width = 400;
  gl.canvas.height = 1;
  gl.viewport(0, 0, 400, 1);
  gl.uniform2f(uniform("uRes"), 400, 1);
  gl.uniform1i(uniform("regressionMode"), 2);
  const drawFields = (weights: readonly number[], season = 1): number[] => {
    const [crops = 0, wildflowers = 0, lavender = 0, sunflowers = 0, pasture = 0] = weights;
    settle({ season, crops, wildflowers, lavender, sunflowers, pasture });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const output = pixels(gl, 400, 1);
    return Array.from({ length: 400 }, (_, index) => Math.round(((output[index * 4] ?? 0) * 9) / 255));
  };
  const shares = (types: readonly number[]): number[] => {
    const counts = [0, 0, 0, 0, 0];
    for (const type of types) {
      const index = type < 6 ? 0 : type - 5;
      counts[index] = (counts[index] ?? 0) + 1;
    }
    return counts;
  };
  const mixture = drawFields([2, 1, 0, 1, 1]);
  const counts = shares(mixture);
  check(counts.join(",") === "160,80,0,80,80", `Wrong field shares with pasture: ${counts}`);
  check(
    drawFields([100, 50, 0, 50, 50]).every((type, i) => type === mixture[i]),
    "Scaling all field weights changed the composition with pasture",
  );
  check(new Set(mixture.filter((type) => type < 6)).size === 5, "Pasture squeezed out the seasonal crop catalogue");
  const without = shares(drawFields([2, 1, 0, 1, 0]));
  check(without.join(",") === "200,100,0,100,0", `Zero pasture weight still took fields: ${without}`);
  check(drawFields([0, 0, 0, 0, 1]).every((type) => type === 9), "Pasture alone included another field type");
  for (const season of [0, 1, 2]) {
    const crops = drawFields([100, 0, 0, 0, 0], season);
    check(
      drawFields([0, 0, 0, 0, 0], season).every((type, i) => type === crops[i]),
      `All-zero weights with pasture lost the crop fallback in season ${season}`,
    );
  }
  result.pastureShares = counts;

  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, WIDTH, LAND);
  gl.uniform2f(uniform("uRes"), WIDTH, HEIGHT);
  const still = { time: 0.58, clouds: 0, shadows: 0, wind: 0, fog: 0, season: 1 };
  const drawScene = (
    knobs: Record<string, number>,
    motionTime: number,
    { mode = 0, motion = 1, time = 30 } = {},
  ): Uint8Array => {
    gl.uniform1i(uniform("regressionMode"), mode);
    gl.uniform1f(uniform("uMotion"), motion);
    gl.uniform1f(uniform("uTime"), time);
    gl.uniform1f(uniform("uMotionTime"), motionTime);
    settle({ ...still, ...knobs });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return pixels(gl, WIDTH, LAND);
  };

  // (b) Field interiors as the scene itself draws them: where a field's own material shows, the
  // colour follows its type, while hedges, hedgerow trees, the track, the river and the village
  // look the same whatever grows in the fields.
  const interior = differing(drawScene({ crops: 0, lavender: 1 }, 0), drawScene({ crops: 0, sunflowers: 1 }, 0));
  const herds = { crops: 50, pasture: 50, herd: 1 };
  const pens = drawScene(herds, 0, { mode: 1 });
  const masks: Uint8Array[] = [];
  for (const motionTime of [9.5, 23.75, 187.3]) {
    const animals = differing(drawScene(herds, motionTime), drawScene({ ...herds, herd: 0 }, motionTime));
    const stray = animals.findIndex((value, at) => value === 1 && (interior[at] === 0 || pens[at * 4] !== 255));
    check(
      stray < 0,
      `An animal at motion time ${motionTime} covers pixel ${stray % WIDTH},${HEIGHT - 1 - Math.floor(stray / WIDTH)} outside an enclosure's interior`,
    );
    masks.push(animals);
  }
  const herdPixels = masks.map(count);
  check(herdPixels.every((pixelCount) => pixelCount >= 30), `Too few animals drawn to judge confinement: ${herdPixels}`);
  result.herdPixels = herdPixels;

  // (c) At motion 0 the frame holds still while the scene clock runs; advancing the motion clock
  // moves some animals.
  const frozen = drawScene(herds, 17, { motion: 0, time: 5 });
  check(
    count(differing(frozen, drawScene(herds, 17, { motion: 0, time: 55 }))) === 0,
    "The countryside with herds changed at motion 0",
  );
  const [first, second] = masks;
  const moved = first && second ? first.reduce((sum, value, at) => sum + (value === second[at] ? 0 : 1), 0) : 0;
  check(moved >= 10, `Advancing the motion clock 14 s moved no animal: ${moved} pixels`);
  result.herdMotionPixels = moved;
  gl.disable(gl.SCISSOR_TEST);
  gl.deleteProgram(scene);
  return result;
}
