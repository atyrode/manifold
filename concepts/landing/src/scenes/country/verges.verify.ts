// Real-WebGL regressions for the countryside's verges (verges.ts; run by verify-browser.ts) on the
// actual scene shader and the actual simulation: switched off they add nothing, compiled in or not
// and whatever texture is bound, and the simulation hands over none; switched on, their clumps
// stand on the two near ridges; the wind sways them; once it drops they stand exactly as clumps
// grown in still air do.
import {
  fragmentSourceFor,
  sceneFeatures,
  shaderValues,
  vertexSource,
} from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings, type Params } from "../../state.ts";
import { sceneDefs } from "../index.ts";
import type { SceneSim, SimFrame } from "../types.ts";

const W = 320;
const H = 200;
/** The motion time every frame is drawn at, so only the clumps' own records differ between them. */
const AT = 12;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`country verges: ${message}`);
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

/** Pixels (bottom-up rows) where two frames differ. */
function changed(a: Uint8Array, b: Uint8Array): boolean[] {
  return Array.from({ length: W * H }, (_, i) =>
    [0, 1, 2].some((c) => a[i * 4 + c] !== b[i * 4 + c]),
  );
}

const count = (mask: readonly boolean[]): number => mask.filter(Boolean).length;

export function verifyCountryVerges(gl: WebGL2RenderingContext): Record<string, unknown> {
  const country = sceneDefs.country;
  // A clear summer afternoon, unlit windows and no smoke: what changes is what the verges add.
  const calm: Params = {
    ...paramDefaults("country"),
    time: 0.55,
    clouds: 0,
    shadows: 0,
    fog: 0,
    lights: 0,
    smoke: 0,
    wind: 0,
    season: 0,
  };
  const grown: Params = { ...calm, verges: 1, "verges-amount": 1 };
  const off = sceneFeatures(country, shaderValues(country, calm));
  const on = sceneFeatures(country, shaderValues(country, grown));
  check(off.COUNTRY_HAS_VERGES === 0, "the verges are compiled in while they are off");
  check(
    JSON.stringify({ ...off, COUNTRY_HAS_VERGES: 1 }) === JSON.stringify(on),
    `turning the verges on changes other features: ${JSON.stringify(on)}`,
  );
  const plain = program(gl, fragmentSourceFor(country, off));
  const gated = program(gl, fragmentSourceFor(country, on));
  gl.canvas.width = W;
  gl.canvas.height = H;
  gl.viewport(0, 0, W, H);
  for (const linked of [plain, gated]) {
    gl.useProgram(linked);
    const u = (name: string) => gl.getUniformLocation(linked, name);
    gl.uniform2f(u("uRes"), W, H);
    gl.uniform1f(u("uTime"), AT);
    gl.uniform1f(u("uMotionTime"), AT);
    gl.uniform1f(u("uMotion"), 1);
    gl.uniform1f(u("uLevels"), 2);
    gl.uniform1i(u("uView"), 1);
    gl.uniform2f(u("uPassage"), 1, 0);
    gl.uniform2f(u("uWeather"), 0, 0);
    gl.uniform2f(u("uPointer"), 0, 0);
    gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
    for (const [slot, name] of ["uSim0", "uSim1", "uSim2", "uSim3"].entries())
      gl.uniform1i(u(name), slot);
  }
  const draw = (
    linked: WebGLProgram,
    knobs: Params,
    plants: WebGLTexture | undefined = undefined,
  ): Uint8Array => {
    gl.useProgram(linked);
    const u = (name: string) => gl.getUniformLocation(linked, name);
    gl.uniform1fv(
      u("uParams"),
      Float32Array.from(renderSettings(defaultsFor("country"), knobs).params),
    );
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, plants ?? null);
    gl.uniform4f(u("uSimOn"), 0, 0, plants ? 1 : 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };
  const frame = (knobs: Params, motionTime: number): SimFrame => ({
    dt: 1 / 60,
    time: motionTime,
    motionTime,
    motion: 1,
    width: W,
    height: H,
    aspect: W / H,
    params: knobs,
    values: renderSettings(defaultsFor("country"), knobs).params,
    triggers: Array.from({ length: 8 }, () => -1e4),
    fired: Array.from({ length: 8 }, () => false),
    passage: { enter: 1, exit: 0 },
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
  });
  /** Runs `sim` for `seconds` at `knobs` from motion time `from`; returns the verges' texture after. */
  const run = (
    sim: SceneSim,
    knobs: Params,
    from: number,
    seconds: number,
  ): WebGLTexture | undefined => {
    let plants: WebGLTexture | undefined;
    for (let n = 0; n <= Math.round(seconds * 60); n++)
      plants = sim.frame(frame(knobs, from + n / 60))[2];
    return plants;
  };
  const result: Record<string, unknown> = {};
  const still = country.sim?.(gl);
  const windy = country.sim?.(gl);
  if (!still || !windy) throw new Error("Countryside simulation unavailable");
  try {
    // (a) Off, the simulation hands over no texture, and the program with the verges compiled in
    // draws the default frame bit for bit, even with a grown verge's texture bound.
    check(
      run(still, calm, 0, 0) === undefined,
      "the verges switched off still handed over a texture",
    );
    const rest = run(still, grown, 0, 0);
    check(rest !== undefined, "the verges switched on handed over no texture");
    const bare = draw(plain, calm);
    check(
      count(changed(draw(gated, calm, rest), bare)) === 0,
      "the verges switched off changed the frame",
    );

    // (b) On, clumps stand on the two near ridges: nothing above the second ridge's highest crest
    // and the tallest clump over it (0.53 + 0.02 screen heights) changes.
    const standing = changed(draw(gated, grown, rest), bare);
    const shown = count(standing);
    check(shown >= 150, `the verges barely showed: ${shown} pixels`);
    const top = Math.ceil(0.56 * H);
    const above = standing.findIndex((v, i) => v && Math.floor(i / W) >= top);
    check(
      above < 0,
      `a clump stands above the near ridges at ${above % W},${Math.floor(above / W)}`,
    );
    result.vergesShown = shown;

    // (c) The wind sways them: two moments a second apart differ, and only where clumps stand then.
    const breeze = { ...grown, wind: 0.8 };
    const windless = draw(gated, breeze);
    const first = draw(gated, breeze, run(windy, breeze, 0, 3));
    const later = draw(gated, breeze, run(windy, breeze, 3, 1));
    const clumps = changed(first, windless);
    changed(later, windless).forEach((v, i) => {
      if (v) clumps[i] = true;
    });
    const swayed = changed(first, later);
    const moved = count(swayed);
    check(moved >= 10, `the wind barely moved the clumps: ${moved} pixels`);
    check(
      swayed.every((v, i) => !v || clumps[i] === true),
      "the wind changed the frame away from the clumps",
    );
    result.vergesSwayed = moved;

    // (d) Once the wind drops they come to rest and stand exactly as clumps grown in still air.
    const settled = run(windy, grown, 4, 8);
    check(
      count(changed(draw(gated, grown, settled), draw(gated, grown, rest))) === 0,
      "the clumps did not come back to rest once the wind dropped",
    );
    result.vergesRest = true;
  } finally {
    still.dispose();
    windy.dispose();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.deleteProgram(plain);
    gl.deleteProgram(gated);
  }
  return result;
}
