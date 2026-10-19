// Regressions for the World's birds (shaders/lib/world.ts worldBirds) as the waterfall flies them
// (its preset's flyway: swifts), on the actual composed program: a bird is never drawn where the
// cliff in front of it covers it, the formation knob reaches the sky, and the birds follow the
// motion clock alone.
import { glslFloat } from "../../shaders/glsl.ts";
import {
  fragmentSourceFor,
  knobSlots,
  packParams,
  sceneFeatures,
  shaderValues,
  vertexSource,
} from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings, type Params } from "../../state.ts";
import { loadScene } from "../index.ts";
import { fallsComposed } from "./index.ts";

const { glslFor, ...fallsScene } = await loadScene("falls");

const WIDTH = 192;
const HEIGHT = 108;
/** Motion times (s) with swifts crossing: some in front of the cliff, some behind it. */
const TIMES = [100, 150, 233, 416];

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shaders = [vertexSource, fragment].map((source, index) => {
    const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    check(
      Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
      gl.getShaderInfoLog(shader) ?? "compile failed",
    );
    return shader;
  });
  const linked = gl.createProgram();
  for (const shader of shaders) gl.attachShader(linked, shader);
  gl.linkProgram(linked);
  check(
    Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)),
    gl.getProgramInfoLog(linked) ?? "link failed",
  );
  for (const shader of shaders) gl.deleteShader(shader);
  return linked;
}

const fly = fallsComposed.preset.flyway;
/** The preset's flyway as the composer's entry hands it to worldBirds (composer/glsl.ts). */
const FLYWAY = `WorldFlyway(vec2(${glslFloat(fly.depth[0])}, ${glslFloat(fly.depth[1])}), vec2(RIG_HORIZON + ${glslFloat(fly.above)}, ${glslFloat(fly.top)}), vec2(K_seed * 0.37, ${glslFloat(fly.seed)}), ${glslFloat(fly.skim)}, ${glslFloat(fly.spread)})`;

/**
 * Mode 0 draws the actual scene. Mode 1 draws, at rest, r: where a bird covers the pixel before any
 * occlusion (the World's birds over nothing at all), g: where the cliff face (its rock and the water
 * falling down it, 29 m off) covers the pixel and lies nearer than that bird, so the bird may not
 * show there.
 */
const wrapper = `
uniform int regressionMode;
Shade regressionFallsBirds(vec2 uv, vec2 cell, float t) {
  Shade actual = composerEntry(uv, cell, t);
  if (regressionMode == 0) return actual;
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y);
  Ctx x = composerCtx(uv, cell);
  vec3 col = vec3(-1.0);
  float depth = 1e9;
  float accent = 0.0;
  worldBirds(x.w, x.v, ${FLYWAY}, vec3(0.0), 0.0, col, depth, accent);
  float rim = fallsRim(q.x, fallsAt(aspect), K_cliffMark);
  float front = depth > FALLS_CLIFF_Z && q.y > FALLS_POOL && q.y < rim ? 1.0 : 0.0;
  return shadeOf(vec3(col.r >= 0.0 ? 1.0 : 0.0, front, 0.0), 0.0, 0.0);
}`;

export function verifyFallsBirds(gl: WebGL2RenderingContext): Record<string, unknown> {
  if (glslFor === undefined) throw new Error("falls birds: the scene is not composed");
  const calm: Params = { ...paramDefaults("falls"), time: 0.5, rain: 0, fog: 0 };
  const swifts: Params = { ...calm, birds: 1, "birds-amount": 1 };
  // The birds' own program: the World's birds compiled in (off at the preset's defaults).
  const features = sceneFeatures(fallsScene, shaderValues(fallsScene, swifts));
  const scene = program(
    gl,
    fragmentSourceFor(
      { ...fallsScene, entry: "regressionFallsBirds", glsl: glslFor(features) + wrapper },
      features,
    ),
  );
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(scene);
  const at = (name: string) => gl.getUniformLocation(scene, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform2f(at("uWeather"), 0, 0);
  gl.uniform2f(at("uPointer"), 0, 0);
  gl.uniform4f(at("uSimOn"), 0, 0, 0, 0);
  const draw = (
    knobs: Params,
    mode: number,
    motionTime: number,
    clock = motionTime,
    motion = 1,
  ): Uint8Array => {
    gl.uniform1i(at("regressionMode"), mode);
    gl.uniform1f(at("uTime"), clock);
    gl.uniform1f(at("uMotionTime"), motionTime);
    gl.uniform1f(at("uMotion"), motion);
    gl.uniform4fv(
      at("uParams"),
      packParams(
        renderSettings(defaultsFor("falls"), knobs).params,
        knobSlots(fallsScene, features),
      ),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };
  const pixels = WIDTH * HEIGHT;
  const raw = (mask: Uint8Array, i: number) => (mask[i * 4] ?? 0) > 127;

  // (a) A swift deeper than the cliff never shows over it: no pixel the birds change (the actual
  // frame with birds against the one without) lies where the cliff is nearer than the bird there,
  // while the fixture does put birds both in front of the cliff and behind it.
  let drawn = 0;
  let hidden = 0;
  for (const time of TIMES) {
    const on = draw(swifts, 0, time);
    const off = draw(calm, 0, time);
    const mask = draw(swifts, 1, time);
    for (let i = 0; i < pixels; i++) {
      const changed = [0, 1, 2].some((c) => on[i * 4 + c] !== off[i * 4 + c]);
      const behind = raw(mask, i) && (mask[i * 4 + 1] ?? 0) > 127;
      check(!(changed && behind), `A bird was drawn over the nearer cliff at ${time}s, pixel ${i}`);
      if (changed) drawn++;
      if (behind) hidden++;
    }
  }
  check(drawn >= 30, `Birds fixture drew too few birds: ${drawn}`);
  check(hidden >= 5, `Birds fixture never put a bird behind the cliff: ${hidden}`);

  // (b) The formation knob reaches the sky: the same flights flown as loose parties (three to seven
  // swifts) make at least twice as many separate marks (4-connected groups of covered pixels) as
  // flown solo. (A V of swifts this near spreads most of its arms off the frame.)
  const marks = (knobs: Params) =>
    TIMES.reduce((sum, time) => {
      const mask = draw(knobs, 1, time);
      const seen = new Uint8Array(pixels);
      let n = 0;
      for (let start = 0; start < pixels; start++) {
        if (seen[start] || !raw(mask, start)) continue;
        n++;
        const stack = [start];
        seen[start] = 1;
        for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
          const x = i % WIDTH;
          for (const j of [x > 0 ? i - 1 : -1, x < WIDTH - 1 ? i + 1 : -1, i - WIDTH, i + WIDTH]) {
            if (j < 0 || j >= pixels || seen[j] || !raw(mask, j)) continue;
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      return sum + n;
    }, 0);
  const solo = marks({ ...swifts, birdFormation: 1 });
  const party = marks({ ...swifts, birdFormation: 2 });
  check(
    solo > 0 && party >= 2 * solo,
    `Formation knob: ${solo} marks flown solo, ${party} as parties`,
  );

  // (c) The birds are fixed by the motion clock: the same motion time draws the same birds (the
  // actual frame with birds against the one without) at another scene clock and motion amount, and
  // they move on as the motion clock advances.
  const birdsAt = (motionTime: number, clock: number, motion: number): boolean[] => {
    const on = draw(swifts, 0, motionTime, clock, motion);
    const off = draw(calm, 0, motionTime, clock, motion);
    return Array.from({ length: pixels }, (_, i) =>
      [0, 1, 2].some((c) => on[i * 4 + c] !== off[i * 4 + c]),
    );
  };
  const time = TIMES[0] ?? 100;
  const still = birdsAt(time, time, 1);
  check(still.some(Boolean), "No birds in the clock fixture");
  check(
    birdsAt(time, time * 2.7 + 11, 0.35).every((bird, i) => bird === still[i]),
    "Birds moved with the scene clock or the motion amount at a fixed motion time",
  );
  const moved = birdsAt(time + 1.5, time, 1).filter((bird, i) => bird !== still[i]).length;
  check(moved > 0, "Birds did not move as the motion clock advanced");
  gl.deleteProgram(scene);
  return { drawn, hidden, solo, party, moved };
}
