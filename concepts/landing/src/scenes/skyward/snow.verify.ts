// GPU check (verify-browser.ts): skyward's snow, the World's, through the crossing's own camera and
// the axes the crossroads hands the World for it (crossroadsSeen), as worldPrecipAxes draws it. With
// 'snow from overhead' the flakes stream out of the patch of sky they fall from (the zenith, a little
// above the frame's centre, in still air): at the sides of the frame they move outward, below it down;
// switched off, the snow keeps the level camera's look and comes straight down the frame everywhere.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import {
  fragmentSourceFor,
  packParams,
  sceneFeatures,
  shaderValues,
  vertexSource,
} from "../../shaders/index.ts";
import { loadScene } from "../index.ts";

const skywardScene = await loadScene("skyward");

const WIDTH = 320;
const HEIGHT = 180;
/** Rows searched each way, and columns either side, for the shift that best maps one frame onto the next. */
const ROWS = 10;
const COLUMNS = 10;
/** Steady snow in still air. */
const SNOW = { snow: 1, "snow-amount": 1, wind: 0 } as const;

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("skyward snow: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "skyward snow: compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(linked) ?? "skyward snow: link failed");
  return linked;
}

/** The shift (columns, rows; rows up) that best lays the flakes of `before` onto those of `after`, over a band of the frame. */
function drift(
  before: Uint8Array,
  after: Uint8Array,
  rows: readonly [number, number],
  columns: readonly [number, number],
): { dx: number; dy: number; flakes: number } {
  const lit = (bytes: Uint8Array, x: number, y: number): boolean =>
    (bytes[(y * WIDTH + x) * 4] ?? 0) > 127;
  let best = { dx: 0, dy: 0, score: -1 };
  let flakes = 0;
  for (let y = rows[0]; y < rows[1]; y++)
    for (let x = columns[0]; x < columns[1]; x++) if (lit(after, x, y)) flakes++;
  for (let dy = -ROWS; dy <= ROWS; dy++) {
    for (let dx = -COLUMNS; dx <= COLUMNS; dx++) {
      let score = 0;
      for (let y = rows[0]; y < rows[1]; y++) {
        for (let x = columns[0]; x < columns[1]; x++) {
          const sx = x - dx;
          const sy = y - dy;
          if (
            sx >= 0 &&
            sx < WIDTH &&
            sy >= 0 &&
            sy < HEIGHT &&
            lit(after, x, y) &&
            lit(before, sx, sy)
          )
            score++;
        }
      }
      if (score > best.score) best = { dx, dy, score };
    }
  }
  return { dx: best.dx, dy: best.dy, flakes };
}

export function skywardSnowCheck(gl: WebGL2RenderingContext): Record<string, unknown> {
  const { glslFor } = skywardScene;
  if (glslFor === undefined) throw new Error("skyward snow: the scene is not composed");
  const linked = compile(
    gl,
    fragmentSourceFor(
      {
        ...skywardScene,
        entry: "regressionSkywardSnow",
        glslFor: (features) => `${glslFor(features)}
    Shade regressionSkywardSnow(vec2 uv, vec2 cell, float t) {
      Ctx x = composerCtx(uv, cell);
      crossroadsBegin(x);
      mat3 rain;
      mat3 snow;
      crossroadsSeen(x, rain, snow);
      vec3 vanish = rainVanish(snowFallDir(x.w.snow, x.w.wind), snow[0], snow[1], snow[2], x.v.focal);
      Precip p = snowFallSeen(x.v.uv, x.v.aspect, x.w.tm, x.w.snow, x.w.wind, 1.0, vanish);
      return shadeOf(vec3(p.cover), p.cover, 0.0);
    }`,
      },
      sceneFeatures(skywardScene, shaderValues(skywardScene, SNOW)),
    ),
  );
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  gl.uniform2f(gl.getUniformLocation(linked, "uRes"), WIDTH, HEIGHT);
  gl.uniform1i(gl.getUniformLocation(linked, "uView"), 1);
  gl.uniform1f(gl.getUniformLocation(linked, "uMotion"), 1);
  gl.uniform1f(gl.getUniformLocation(linked, "uTime"), 30);
  gl.uniform2f(gl.getUniformLocation(linked, "uPassage"), 1, 0);
  gl.uniform1fv(gl.getUniformLocation(linked, "uTriggers"), new Float32Array(8).fill(-1e4));
  const frame = (overhead: boolean, time: number): Uint8Array => {
    const knobs = { ...paramDefaults("skyward"), ...SNOW, snowOverhead: overhead ? 1 : 0 };
    gl.uniform4fv(
      gl.getUniformLocation(linked, "uParams"),
      packParams(renderSettings(defaultsFor("skyward"), knobs).params),
    );
    // The World's snow falls on the motion clock.
    gl.uniform1f(gl.getUniformLocation(linked, "uMotionTime"), time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  // Bands well clear of the zenith: the outer quarters at its height, and the lower third of the
  // middle columns.
  const sideRows: readonly [number, number] = [Math.round(HEIGHT * 0.5), Math.round(HEIGHT * 0.8)];
  const left: readonly [number, number] = [0, Math.round(WIDTH / 4)];
  const right: readonly [number, number] = [Math.round((3 * WIDTH) / 4), WIDTH];
  const bottom: readonly [number, number] = [0, Math.round(HEIGHT * 0.3)];
  const middle: readonly [number, number] = [Math.round(WIDTH / 3), Math.round((2 * WIDTH) / 3)];
  const result: Record<string, unknown> = {};
  for (const overhead of [false, true]) {
    const before = frame(overhead, 40);
    const after = frame(overhead, 40.15);
    const bands = {
      left: drift(before, after, sideRows, left),
      right: drift(before, after, sideRows, right),
      below: drift(before, after, bottom, middle),
    };
    const name = overhead ? "overhead" : "level";
    result[name] = bands;
    for (const [band, seen] of Object.entries(bands)) {
      if (seen.flakes < 20)
        throw new Error(
          `skyward snow (${name}): too few flakes to follow in the ${band} band: ${seen.flakes}`,
        );
    }
    const { left: l, right: r, below: b } = bands;
    if (b.dy >= 0)
      throw new Error(
        `skyward snow (${name}): flakes below the zenith moved ${b.dy} rows, not down the frame`,
      );
    if (overhead && (l.dx >= 0 || r.dx <= 0))
      throw new Error(
        `skyward snow (overhead): flakes beside the zenith moved ${l.dx} (left) and ${r.dx} (right) columns, not outward`,
      );
    if (!overhead && (l.dy >= 0 || r.dy >= 0 || Math.abs(l.dx) > 1 || Math.abs(r.dx) > 1)) {
      throw new Error(
        `skyward snow (level): flakes at the sides moved (${l.dx}, ${l.dy}) and (${r.dx}, ${r.dy}), not straight down the frame`,
      );
    }
  }
  gl.deleteProgram(linked);
  return result;
}
