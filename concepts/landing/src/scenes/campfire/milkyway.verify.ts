// GPU regressions for the shared Milky Way (#1082: shaders/lib/milkyway.ts) and its brightness knob,
// run by concepts/landing/verify-browser.ts on real WebGL output. A probe entry on Campfire's program
// evaluates the World's band (WORLD_GALAXY) over a grid of directions: nothing below the horizon or
// off the galactic plane, a band along it, and the stars crowding into it. Then the knob in both
// skies that show the band: off, on and twice as bright light the night sky more and more, and leave
// what the band does not reach (Campfire's fire-lit ground) as it was.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, vertexSource } from "../../shaders/index.ts";
import { loadScene } from "../index.ts";

const { glslFor, ...campfireScene } = await loadScene("campfire");

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`milky way: ${message}`);
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

// A dome grid: bearing uProbe.x + column * uProbe.y, elevation uProbe.z + row * uProbe.y (radians).
// r: the band, g: the direction's height over the galactic plane, b: the stars it crowds at density 0.5.
const PROBE = `
uniform vec4 uProbe;

Shade milkyWayProbe(vec2 uv, vec2 cell, float t) {
  float az = uProbe.x + floor(cell.x) * uProbe.y;
  float el = uProbe.z + floor(cell.y) * uProbe.y;
  vec3 dir = vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
  float band = milkyWay(dir, dir.y, WORLD_GALAXY);
  Shade o = blankShade();
  o.source = vec3(band, dot(dir, WORLD_GALAXY.pole), milkyWayStars(0.5, band));
  return o;
}
`;

type Uniforms = Readonly<Record<string, readonly number[]>>;

/** Draws `linked` at width x height into a float target and returns RGBA floats, rows bottom up. */
function draw(
  gl: WebGL2RenderingContext,
  linked: WebGLProgram,
  width: number,
  height: number,
  uniforms: Uniforms,
): Float32Array {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  // Unbound, so no uSim sampler (all on unit 0) reads the target it renders into.
  gl.bindTexture(gl.TEXTURE_2D, null);
  check(
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
    "float target incomplete",
  );
  gl.useProgram(linked);
  gl.viewport(0, 0, width, height);
  const base: Uniforms = {
    uRes: [width, height],
    uView: [1],
    uTime: [40],
    uMotion: [0],
    uMotionTime: [0],
    uPassage: [1, 0],
    uTriggers: Array.from({ length: 8 }, () => -1e4),
    uPrincipals: [-1, -1, 0, -1e4],
    uBg: [0.03, 0.03, 0.05],
  };
  for (const [name, value] of Object.entries({ ...base, ...uniforms })) {
    const at = gl.getUniformLocation(linked, name);
    if (at === null) continue;
    if (name === "uView") gl.uniform1i(at, value[0] ?? 0);
    else if (name === "uParams") gl.uniform4fv(at, packParams(value));
    else if (name === "uTriggers") gl.uniform1fv(at, Float32Array.from(value));
    else if (value.length === 1) gl.uniform1f(at, value[0] ?? 0);
    else if (value.length === 2) gl.uniform2fv(at, value);
    else if (value.length === 3) gl.uniform3fv(at, value);
    else gl.uniform4fv(at, value);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const out = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  check(gl.getError() === gl.NO_ERROR, "float readPixels GL error");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
  return out;
}

const luma = (pixels: Float32Array, i: number): number =>
  0.2126 * (pixels[i * 4] ?? 0) +
  0.7152 * (pixels[i * 4 + 1] ?? 0) +
  0.0722 * (pixels[i * 4 + 2] ?? 0);

/** Summed luminance of rows [from, to) of a width-wide picture. */
function light(pixels: Float32Array, width: number, from: number, to: number): number {
  let sum = 0;
  for (let i = from * width; i < to * width; i++) sum += luma(pixels, i);
  return sum;
}

export async function verifyMilkyWay(gl: WebGL2RenderingContext): Promise<Record<string, unknown>> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const campfire = campfireScene;
  if (glslFor === undefined) throw new Error("milky way: campfire is not composed");

  // The band over the dome: none below the horizon or more than 0.35 off the plane, up to ~1.3 along
  // it, over a fair share of the sky; the stars it crowds are 0.7x the density off it, up to 1.5x
  // where the band is 1.
  const probe = program(
    gl,
    fragmentSourceFor({ ...campfire, entry: "milkyWayProbe", glsl: campfire.glsl + PROBE }),
  );
  const W = 96;
  const H = 64;
  const step = 0.025;
  const grid = draw(gl, probe, W, H, { uProbe: [-1.2, step, -0.2, 0] });
  let peak = 0;
  let inBand = 0;
  let above = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const band = grid[i * 4] ?? Number.NaN;
      const height = grid[i * 4 + 1] ?? Number.NaN;
      const stars = grid[i * 4 + 2] ?? Number.NaN;
      const elevation = -0.2 + y * step;
      if (elevation <= 0 || Math.abs(height) > 0.35)
        check(band === 0, `the band shows at (${x}, ${y}): below the horizon or off the plane`);
      check(
        Math.abs(stars - 0.5 * (0.7 + 0.8 * band)) < 1e-6,
        `the band crowds ${stars} stars at (${x}, ${y})`,
      );
      if (elevation > 0) above++;
      if (band > 0.05) inBand++;
      peak = Math.max(peak, band);
    }
  }
  check(peak > 0.9 && peak < 1.4, `the band peaks at ${peak}`);
  check(
    inBand > 0.05 * above && inBand < 0.6 * above,
    `the band covers ${inBand} of ${above} cells of sky`,
  );
  gl.deleteProgram(probe);

  // The knob in both skies, at night: off, on, twice as bright. Campfire's lowest quarter is its
  // fire-lit ground, which the band never reaches.
  const P = 160;
  const Q = 90;
  const lit: Record<string, number[]> = {};
  for (const [id, night] of [
    ["campfire", { time: 0 }],
    ["lake", { hour: 1, moon: 0 }],
  ] as const) {
    const scene = program(gl, fragmentSourceFor(await loadScene(id)));
    check(
      paramDefaults(id)["milkyWay"] === 1 && paramDefaults(id)["milkyWay-amount"] === 1,
      `${id}'s Milky Way is not on at its own brightness by default`,
    );
    const render = (knobs: Record<string, number>) =>
      draw(gl, scene, P, Q, {
        uParams: renderSettings(defaultsFor(id), { ...paramDefaults(id), ...night, ...knobs })
          .params,
      });
    const shots = [render({ milkyWay: 0 }), render({}), render({ "milkyWay-amount": 2 })];
    const sums = shots.map((pixels) => light(pixels, P, 0, Q));
    check(
      (sums[0] ?? 0) < (sums[1] ?? 0) && (sums[1] ?? 0) < (sums[2] ?? 0),
      `${id}'s night does not brighten with the band: ${sums.map((x) => x.toFixed(2)).join(", ")}`,
    );
    if (id === "campfire") {
      const ground = Math.floor(Q / 4) * P;
      for (let i = 0; i < ground * 4; i++)
        check(
          shots[0]?.[i] === shots[1]?.[i],
          `the band reaches campfire's ground at pixel ${Math.floor(i / 4)}`,
        );
    }
    lit[id] = sums.map((x) => Number(x.toFixed(2)));
    gl.deleteProgram(scene);
  }
  return { peak: Number(peak.toFixed(3)), bandCells: inBand, skyCells: above, light: lit };
}
