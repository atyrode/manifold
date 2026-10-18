// GPU check (verify-browser.ts): Island's snow, through the scene's own camera: the World's snow seen
// through the axes the sky over the sea gives it (seaSkySeen, the precip `seen` of its backdrop). The
// eye looks down on the island (ISL_PITCH, 20 degrees), so the flakes' paths close in on the point
// below the sea that its rain's converge on too, several screen heights under the frame: in still
// air the flakes at the sides of the frame lean inward while they fall, those in the middle fall
// straight down. At this pitch the lean is gentle (about a column in four rows at the sides of a wide
// frame) and the flakes sway on their own, so the check follows them over several steps and sums the
// shifts. The level camera's snowFall, drawn the same way as the control, brings every flake straight
// down the frame.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, sceneFeatures, vertexSource } from "../../shaders/index.ts";
import { loadScene } from "../index.ts";

// A composed scene draws its program from glslFor: the check's entry goes after the default one.
const { glslFor, ...islandScene } = await loadScene("island");

/** A wide frame (2.4:1): the lean grows toward the sides. */
const WIDTH = 384;
const HEIGHT = 160;
/** Rows searched each way, and columns either side, for the shift that best maps one frame onto the next. */
const ROWS = 12;
const COLUMNS = 6;
/** Seconds between the frames compared, and how many steps are summed. */
const STEP = 0.25;
const STEPS = 8;
/** Columns per row: the least inward lean at the sides (the band's middle leans about 0.28 toward
 *  the point), and the most a band falling straight down may show from the flakes' own sway. */
const LEAN_IN = 0.12;
const LEAN_STRAIGHT = 0.1;

type Band = "left" | "middle" | "right";
interface Moved {
  /** Summed shifts over the steps (columns, rows; rows up). */
  dx: number;
  dy: number;
  /** Columns per row fallen: + toward the right. */
  lean: number;
  /** The fewest flakes the band held in any frame followed. */
  flakes: number;
}

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("island snow: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "island snow: compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(linked) ?? "island snow: link failed");
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

/** The flakes' movement in three bands of the frame, the snow drawn by `snow` (GLSL returning a Precip) after the scene set its camera at rest. */
function follow(gl: WebGL2RenderingContext, snow: string): Record<Band, Moved> {
  const linked = compile(
    gl,
    fragmentSourceFor({
      ...islandScene,
      entry: "regressionIslandSnow",
      glsl: `${glslFor?.(sceneFeatures(islandScene)) ?? islandScene.glsl}
    Shade regressionIslandSnow(vec2 uv, vec2 cell, float t) {
      Ctx x = composerCtx(uv, cell);
      isleBegin(x);
      seaSkyBegin(x);
      mat3 rain;
      mat3 axes;
      seaSkySeen(x, rain, axes);
      Precip p = ${snow};
      return shadeOf(vec3(p.cover), p.cover, 0.0);
    }`,
    }),
  );
  try {
    gl.useProgram(linked);
    gl.uniform2f(gl.getUniformLocation(linked, "uRes"), WIDTH, HEIGHT);
    gl.uniform1i(gl.getUniformLocation(linked, "uView"), 1);
    gl.uniform1f(gl.getUniformLocation(linked, "uMotion"), 1);
    gl.uniform1f(gl.getUniformLocation(linked, "uMotionTime"), 30);
    gl.uniform2f(gl.getUniformLocation(linked, "uPassage"), 1, 0);
    gl.uniform1fv(gl.getUniformLocation(linked, "uTriggers"), new Float32Array(8).fill(-1e4));
    const knobs = { ...paramDefaults("island"), snow: 1, "snow-amount": 1, wind: 0 };
    gl.uniform4fv(
      gl.getUniformLocation(linked, "uParams"),
      packParams(renderSettings(defaultsFor("island"), knobs).params),
    );
    const frame = (time: number): Uint8Array => {
      gl.uniform1f(gl.getUniformLocation(linked, "uTime"), time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return bytes;
    };
    // The outer fifths of the frame's upper half, where the paths lean most, and its middle fifth.
    const rows: readonly [number, number] = [Math.round(HEIGHT * 0.5), Math.round(HEIGHT * 0.92)];
    const columns: Record<Band, readonly [number, number]> = {
      left: [0, Math.round(WIDTH / 5)],
      middle: [Math.round((2 * WIDTH) / 5), Math.round((3 * WIDTH) / 5)],
      right: [Math.round((4 * WIDTH) / 5), WIDTH],
    };
    const moved: Record<Band, Moved> = {
      left: { dx: 0, dy: 0, lean: 0, flakes: Number.POSITIVE_INFINITY },
      middle: { dx: 0, dy: 0, lean: 0, flakes: Number.POSITIVE_INFINITY },
      right: { dx: 0, dy: 0, lean: 0, flakes: Number.POSITIVE_INFINITY },
    };
    let before = frame(40);
    for (let step = 1; step <= STEPS; step++) {
      const after = frame(40 + step * STEP);
      for (const band of ["left", "middle", "right"] as const) {
        const shift = drift(before, after, rows, columns[band]);
        const sum = moved[band];
        sum.dx += shift.dx;
        sum.dy += shift.dy;
        sum.flakes = Math.min(sum.flakes, shift.flakes);
      }
      before = after;
    }
    for (const sum of Object.values(moved)) sum.lean = sum.dy < 0 ? sum.dx / -sum.dy : Number.NaN;
    return moved;
  } finally {
    gl.deleteProgram(linked);
  }
}

export function islandSnowCheck(gl: WebGL2RenderingContext): Record<string, unknown> {
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  const seen = follow(
    gl,
    "snowFallSeen(uv, uRes.x / uRes.y, t, 1.0, islWind, 1.0, rainVanish(snowFallDir(1.0, islWind), axes[0], axes[1], axes[2], RIG_FOCAL))",
  );
  const level = follow(gl, "snowFall(uv, uRes.x / uRes.y, t, 1.0, islWind, 1.0)");
  for (const [name, measured] of Object.entries({ seen, level })) {
    for (const [band, moved] of Object.entries(measured)) {
      if (moved.flakes < 20)
        throw new Error(
          `island snow (${name}): too few flakes to follow in the ${band} band: ${moved.flakes}`,
        );
      if (moved.dy >= 0)
        throw new Error(
          `island snow (${name}): flakes in the ${band} band moved ${moved.dy} rows, not down the frame`,
        );
    }
    if (Math.abs(measured.middle.lean) > LEAN_STRAIGHT)
      throw new Error(
        `island snow (${name}): flakes in the middle leaned ${measured.middle.lean} columns a row in still air`,
      );
  }
  if (seen.left.lean < LEAN_IN || seen.right.lean > -LEAN_IN) {
    throw new Error(
      `island snow: flakes at the sides leaned ${seen.left.lean} (left) and ${seen.right.lean} (right) columns a row, not in toward the point below the sea`,
    );
  }
  if (Math.abs(level.left.lean) > LEAN_STRAIGHT || Math.abs(level.right.lean) > LEAN_STRAIGHT) {
    throw new Error(
      `island snow (level control): flakes at the sides leaned ${level.left.lean} (left) and ${level.right.lean} (right) columns a row in still air`,
    );
  }
  return { seen, level };
}
