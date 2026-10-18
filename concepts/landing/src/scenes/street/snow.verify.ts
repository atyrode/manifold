// GPU check (verify-browser.ts): street's snow, the World's through the city's axes (citySeen, the
// backdrop's precip.seen). The eye looks down on the crossing (STREET_PITCH), so the flakes' paths
// close in on the point below the street, as the rain's do: in still air those at the sides of the
// frame drift inward while they fall, and those in the middle fall straight down. A level camera's
// snow (snowFall) would bring every flake straight down the frame.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, sceneFeatures, vertexSource } from "../../shaders/index.ts";
import { loadScene } from "../index.ts";

// A composed scene draws its program from glslFor: the check's entry goes after the default one.
const { glslFor, ...streetScene } = await loadScene("street");

const WIDTH = 320;
const HEIGHT = 180;
/** Rows searched each way, and columns either side, for the shift that best maps one frame onto the next. */
const ROWS = 10;
const COLUMNS = 10;

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("street snow: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "street snow: compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(linked) ?? "street snow: link failed");
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

export function streetSnowCheck(gl: WebGL2RenderingContext): Record<string, unknown> {
  const linked = compile(
    gl,
    fragmentSourceFor({
      ...streetScene,
      entry: "regressionStreetSnow",
      glsl: `${glslFor?.(sceneFeatures(streetScene)) ?? streetScene.glsl}
    Shade regressionStreetSnow(vec2 uv, vec2 cell, float t) {
      Ctx x = composerCtx(uv, cell);
      streetBegin(x);
      mat3 rain;
      mat3 snow;
      citySeen(x, rain, snow);
      vec3 vanish = rainVanish(snowFallDir(K_snow, K_wind), snow[0], snow[1], snow[2], RIG_FOCAL);
      Precip p = snowFallSeen(uv, uRes.x / uRes.y, t, K_snow, K_wind, 1.0, vanish);
      return shadeOf(vec3(p.cover), p.cover, 0.0);
    }`,
    }),
  );
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  gl.uniform2f(gl.getUniformLocation(linked, "uRes"), WIDTH, HEIGHT);
  gl.uniform1i(gl.getUniformLocation(linked, "uView"), 1);
  gl.uniform1f(gl.getUniformLocation(linked, "uMotion"), 1);
  gl.uniform1f(gl.getUniformLocation(linked, "uMotionTime"), 30);
  gl.uniform2f(gl.getUniformLocation(linked, "uPassage"), 1, 0);
  gl.uniform1fv(gl.getUniformLocation(linked, "uTriggers"), new Float32Array(8).fill(-1e4));
  const knobs = { ...paramDefaults("street"), snow: 1, "snow-amount": 1, wind: 0 };
  gl.uniform4fv(
    gl.getUniformLocation(linked, "uParams"),
    packParams(renderSettings(defaultsFor("street"), knobs).params),
  );
  const frame = (time: number): Uint8Array => {
    gl.uniform1f(gl.getUniformLocation(linked, "uTime"), time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  const before = frame(40);
  const after = frame(40.3);
  gl.deleteProgram(linked);
  // The outer quarters of the frame's upper half, and the middle third.
  const rows: readonly [number, number] = [Math.round(HEIGHT * 0.5), Math.round(HEIGHT * 0.9)];
  const bands = {
    left: drift(before, after, rows, [0, Math.round(WIDTH / 4)]),
    middle: drift(before, after, rows, [Math.round(WIDTH / 3), Math.round((2 * WIDTH) / 3)]),
    right: drift(before, after, rows, [Math.round((3 * WIDTH) / 4), WIDTH]),
  };
  for (const [band, seen] of Object.entries(bands)) {
    if (seen.flakes < 20)
      throw new Error(`street snow: too few flakes to follow in the ${band} band: ${seen.flakes}`);
    if (seen.dy >= 0)
      throw new Error(
        `street snow: flakes in the ${band} band moved ${seen.dy} rows, not down the frame`,
      );
  }
  const { left, middle, right } = bands;
  if (left.dx <= 0 || right.dx >= 0)
    throw new Error(
      `street snow: flakes at the sides moved ${left.dx} (left) and ${right.dx} (right) columns, not in toward the point below the street`,
    );
  if (Math.abs(middle.dx) > 1)
    throw new Error(
      `street snow: flakes in the middle moved ${middle.dx} columns sideways in still air`,
    );
  return bands;
}
