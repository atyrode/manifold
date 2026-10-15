import { DitherRenderer } from "./src/renderer.ts";
import { defaultsFor, paramDefaults, renderSettings } from "./src/state.ts";
import { sceneDefs } from "./src/scenes/index.ts";
import { incenseVentVerify } from "./src/scenes/incense/vent.verify.ts";
import { rippleEdgesVerify } from "./src/scenes/ripple/edges.verify.ts";
import { verifyHarmonographPrewarm } from "./src/scenes/harmonograph/prewarm.verify.ts";
import { fragmentSourceFor, vertexSource } from "./src/shaders/index.ts";
import { verifyFrostSky } from "./src/scenes/frost/sky.verify.ts";
import { GpuCompute } from "./src/sims/gpu.ts";
import { verifyOrbitRingDepth } from "./src/scenes/orbit/ring-depth.verify.ts";
import { verifySwellRelief } from "./src/scenes/swell/relief.verify.ts";
import { verifyAuroraRipples } from "./src/scenes/aurora/ripples.verify.ts";
import { verifyBarLastCall } from "./src/scenes/bar/lastcall.verify.ts";
import { verifyDewBins } from "./src/scenes/dew/bins.verify.ts";
import { verifyTidepoolExchange } from "./src/scenes/tidepool/exchange.verify.ts";
import { verifyRuntime } from "./src/runtime.verify.ts";
import { fallsGorgeCheck } from "./src/scenes/falls/gorge.verify.ts";
import { skywardSnowCheck } from "./src/scenes/skyward/snow.verify.ts";
import { mobileVerify } from "./src/scenes/mobile/mobile.verify.ts";
import { verifyCloudsDetail } from "./src/scenes/clouds/detail.verify.ts";
import type { SimFrame } from "./src/scenes/types.ts";
import { verifyLakeFreshSnow } from "./src/scenes/lake/snow.verify.ts";
import { verifyShanshui } from "./src/scenes/shanshui/shanshui.verify.ts";
import { verifyMotionClocks } from "./src/scenes/train/motion-clock.verify.ts";
import { verifyTrainLine } from "./src/scenes/train/line.verify.ts";
import { verifyFilmRupture } from "./src/scenes/film/rupture.verify.ts";
import { verifyPendulaSwing } from "./src/scenes/pendula/swing.verify.ts";
import { verifyFallsBirds } from "./src/scenes/falls/birds.verify.ts";
import { petriRegimesVerify } from "./src/scenes/petri/regimes.verify.ts";
import { verifyPondKoi } from "./src/scenes/pond/koi.verify.ts";
import { verifyPlanet } from "./src/scenes/campfire/planet.verify.ts";
import { streetSnowCheck } from "./src/scenes/street/snow.verify.ts";
import { verifyCanopy } from "./src/scenes/forest/canopy.verify.ts";
import { verifyWaterTiers } from "./src/scenes/island/water.verify.ts";
import { verifyPondPlants } from "./src/scenes/pond/plants.verify.ts";
import { islandSnowCheck } from "./src/scenes/island/snow.verify.ts";
import {
  verifyFeaturesAll,
  verifyFeatureToggles,
  verifySceneFeatures,
} from "./src/features.verify.ts";
import { verifyCloudTiers } from "./src/scenes/clouds/tiers.verify.ts";
import { verifyMilkyWay } from "./src/scenes/campfire/milkyway.verify.ts";
import { verifyStarsKnob } from "./src/scenes/shore/stars.verify.ts";
import { verifyMeadowWildflowers } from "./src/scenes/meadow/wildflowers.verify.ts";
import { verifyCountryTerrain } from "./src/scenes/country/terrain.verify.ts";
import { verifyCountryFeaturesAll, verifyCountryLife } from "./src/scenes/country/life.verify.ts";

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}
function context(): WebGL2RenderingContext {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) throw new Error("WebGL2 unavailable");
  return gl;
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
function pixels(gl: WebGL2RenderingContext, width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
  return bytes;
}

// Observe Forest's actual scene entry sky state, so a legacy caller regression fails this check.
function forestClock(gl: WebGL2RenderingContext): number[] {
  const clock = program(
    gl,
    fragmentSourceFor({
      ...sceneDefs.forest,
      entry: "regressionClock",
      glsl:
        sceneDefs.forest.glsl +
        `
    Shade regressionClock(vec2 uv, vec2 cell, float t) {
      sceneForest(uv, cell, t);
      return shadeOf(vec3(forestSky.day), forestSky.day, 0.0);
    }`,
    }),
  );
  gl.useProgram(clock);
  gl.viewport(0, 0, 1, 1);
  gl.uniform2f(gl.getUniformLocation(clock, "uRes"), 1, 1);
  gl.uniform1i(gl.getUniformLocation(clock, "uView"), 1);
  gl.uniform1f(gl.getUniformLocation(clock, "uTime"), 96);
  gl.uniform1f(gl.getUniformLocation(clock, "uMotionTime"), 24);
  const clockKnobs = { ...paramDefaults("forest"), time: 0.2, cycle: 1, "cycle-amount": 1 };
  gl.uniform1fv(
    gl.getUniformLocation(clock, "uParams"),
    Float32Array.from(renderSettings(defaultsFor("forest"), clockKnobs).params),
  );
  const clockValues: number[] = [];
  for (const motion of [0.25, 1, 0]) {
    gl.uniform1f(gl.getUniformLocation(clock, "uMotion"), motion);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    clockValues.push(pixels(gl, 1, 1)[0] ?? -1);
  }
  check(
    clockValues[0] !== undefined &&
      clockValues[0] > 0 &&
      clockValues.every((value) => value === clockValues[0]),
    `Motion changed Forest's accumulated day phase: ${clockValues.join(",")}`,
  );
  gl.deleteProgram(clock);
  return clockValues;
}

// GpuCompute passes: every blend mode applies its own blending and leaves blending off, with the
// default equation and factors, whatever the caller had set; a preserving resize does not inherit it.
function gpuBlend(gl: WebGL2RenderingContext): Record<string, unknown> {
  const gpu = GpuCompute.create(gl);
  if (!gpu) throw new Error("Float GPU targets unavailable");
  const target = gpu.target({ width: 1, height: 1, format: "rgba16f" });
  const pass = gpu.pass("void main() { fragColor = vec4(0.5); }");
  const blends: number[] = [];
  for (const blend of ["none", "add", "max"] as const) {
    target.clear(0.25);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ZERO, gl.ONE);
    pass.run(target, { blend });
    check(!gl.isEnabled(gl.BLEND), `${blend} left blending enabled`);
    check(
      gl.getParameter(gl.BLEND_EQUATION_RGB) === gl.FUNC_ADD &&
        gl.getParameter(gl.BLEND_EQUATION_ALPHA) === gl.FUNC_ADD,
      `${blend} left wrong equation`,
    );
    check(
      gl.getParameter(gl.BLEND_SRC_RGB) === gl.ONE && gl.getParameter(gl.BLEND_DST_RGB) === gl.ZERO,
      `${blend} left wrong factors`,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    const value = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, value);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const expected = blend === "add" ? 0.75 : 0.5;
    check(
      Math.abs((value[0] ?? -1) - expected) < 0.001,
      `${blend}: expected ${expected}, got ${value[0]}`,
    );
    blends.push(value[0] ?? -1);
  }
  target.clear(0.25);
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.MAX);
  gl.blendFunc(gl.ZERO, gl.ONE);
  target.resize(2, 2, true);
  check(!gl.isEnabled(gl.BLEND), "Preserving resize left blending enabled");
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  const kept = new Float32Array(16);
  gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.FLOAT, kept);
  check(
    kept.every((value) => Math.abs(value - 0.25) < 0.001),
    "Preserving resize inherited blending",
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gpu.dispose();
  return { values: blends, resizePreserved: true };
}

// Frost's real melt sim: a press warms the pane; after a traced mark, reseeding while paused clears
// every trace of warmth and resuming brings none of it back.
function frostWarmth(gl: WebGL2RenderingContext): Record<string, boolean> {
  const frost = sceneDefs.frost.sim?.(gl);
  if (!frost) throw new Error("Frost simulation unavailable");
  const knobs = paramDefaults("frost");
  const frame: SimFrame = {
    dt: 0,
    time: 0,
    motionTime: 0,
    motion: 1,
    width: 320,
    height: 200,
    aspect: 1.6,
    params: knobs,
    values: [],
    triggers: [],
    fired: [],
    passage: { enter: 1, exit: 0 },
    pointer: { x: 0.5, y: 0.5, inside: true, down: false, pressed: false, released: false },
    parallax: { x: 0, y: 0 },
  };
  function mask(): Uint8Array {
    frame.values = renderSettings(defaultsFor("frost"), knobs).params;
    const texture = frost?.frame(frame)[1];
    if (!texture) throw new Error("Missing frost mask");
    // Sample the complete mask through a fullscreen draw onto a fixed-size readable canvas.
    const sampler = program(
      gl,
      `#version 300 es
      precision highp float; uniform sampler2D mask; out vec4 outColor;
      void main() { outColor = texture(mask, gl_FragCoord.xy / vec2(320.0, 200.0)); }`,
    );
    gl.canvas.width = 320;
    gl.canvas.height = 200;
    gl.bindVertexArray(gl.createVertexArray());
    gl.useProgram(sampler);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(sampler, "mask"), 0);
    gl.viewport(0, 0, 320, 200);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = pixels(gl, 320, 200);
    gl.deleteProgram(sampler);
    return bytes;
  }
  const pristine = mask();
  frame.dt = 0.05;
  frame.pointer.down = true;
  frame.pointer.pressed = true;
  for (let i = 0; i < 30; i++) {
    frost.frame(frame);
    frame.pointer.pressed = false;
  }
  const warm = mask();
  check(
    warm.some((value, index) => value !== pristine[index]),
    "Frost interaction did not heat the pane",
  );
  const traceSlot = sceneDefs.frost.params.find((param) => param.key === "mark")?.trigger;
  if (traceSlot === undefined) throw new Error("Frost trace trigger unavailable");
  frame.fired = Array.from({ length: 8 }, (_, slot) => slot === traceSlot);
  mask();
  frame.fired = [];
  frame.time = 0.6;
  mask();
  frame.dt = 0;
  frame.pointer.down = false;
  frame.pointer.released = true;
  knobs.pattern = (knobs.pattern ?? 0) + 1;
  const reseeded = mask();
  check(
    reseeded.every((value, index) => value === pristine[index]),
    "Reseed retained old melt mask",
  );
  frame.dt = 0.05;
  frame.pointer.released = false;
  const resumed = mask();
  check(
    resumed.every((value, index) => value === pristine[index]),
    "Old warmth reappeared after resume",
  );
  frost.dispose();
  return { heated: true, pristineOnReseed: true, pristineOnResume: true };
}

// The real renderer on a hand-driven frame clock (its own canvas and context): 1 fps delivery
// reports 1 fps, and the passage's saved outgoing frame is sampled exactly at larger, smaller,
// aspect-changed and unchanged render sizes.
function rendererDissolve(_gl: WebGL2RenderingContext): Record<string, unknown> {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:320px;height:200px";
  document.body.append(canvas);
  const state = {
    ...defaultsFor("country"),
    pixel: 1,
    motion: 1,
    view: "source" as const,
    transitions: "off" as const,
  };
  const rendererGl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!rendererGl) throw new Error("Renderer context unavailable");
  const locations = new WeakSet<WebGLUniformLocation>();
  const getLocation = rendererGl.getUniformLocation.bind(rendererGl);
  rendererGl.getUniformLocation = (linked, name) => {
    const location = getLocation(linked, name);
    if (location && name === "uDissolve") locations.add(location);
    return location;
  };
  const renderer = new DitherRenderer(
    canvas,
    renderSettings(state, paramDefaults("country")),
    false,
  );
  const uniform = rendererGl.uniform2f.bind(rendererGl);
  let holdSaved = false;
  // Freeze only the arrival seam; the outgoing frame must remain a real, nonuniform scene image.
  rendererGl.uniform2f = (location, x, y) => {
    if (holdSaved && location !== null && locations.has(location)) uniform(location, 1, 1);
    else uniform(location, x, y);
  };
  const nativeRaf = window.requestAnimationFrame;
  let tick: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    tick = callback;
    return 1;
  };
  function draw(now: number): void {
    if (!tick) throw new Error("RAF missing");
    tick(now);
  }
  try {
    renderer.start();
    draw(1000);
    draw(2000);
    check(Math.abs(renderer.fps - 1) < 1e-9, `1fps delivery reported ${renderer.fps}`);
    const fps = renderer.fps;
    renderer.replayPassage();
    draw(3000);
    draw(5000);
    // Read the outgoing saved image before entering the fresh scene.
    rendererGl.activeTexture(rendererGl.TEXTURE0 + 4);
    const saved = rendererGl.getParameter(rendererGl.TEXTURE_BINDING_2D) as WebGLTexture;
    const fb = rendererGl.createFramebuffer();
    rendererGl.bindFramebuffer(rendererGl.FRAMEBUFFER, fb);
    rendererGl.framebufferTexture2D(
      rendererGl.FRAMEBUFFER,
      rendererGl.COLOR_ATTACHMENT0,
      rendererGl.TEXTURE_2D,
      saved,
      0,
    );
    const source = pixels(rendererGl, 320, 200);
    check(
      source.some((value, index) => index % 4 !== 3 && value !== source[index % 4]),
      "Saved scene must be nonuniform",
    );
    rendererGl.bindFramebuffer(rendererGl.FRAMEBUFFER, null);
    rendererGl.deleteFramebuffer(fb);
    holdSaved = true;
    const resizeResults: string[] = [];
    for (const [width, height] of [
      [480, 300],
      [160, 100],
      [480, 200],
      [320, 200],
    ]) {
      if (width === undefined || height === undefined) throw new Error("Missing dimensions");
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      draw(5010);
      const output = pixels(rendererGl, width, height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const sx = ((x + 0.5) * 320) / width;
          const sy = ((y + 0.5) * 200) / height;
          // At an exact nearest-filter boundary, float UV rounding may choose either adjacent texel.
          const xs =
            Math.abs(sx - Math.round(sx)) < 1e-5
              ? [Math.floor(sx), Math.floor(sx) - 1]
              : [Math.floor(sx)];
          const ys =
            Math.abs(sy - Math.round(sy)) < 1e-5
              ? [Math.floor(sy), Math.floor(sy) - 1]
              : [Math.floor(sy)];
          const dst = (y * width + x) * 4;
          const matches = ys.some((yy) =>
            xs.some((xx) => {
              if (xx < 0 || xx >= 320 || yy < 0 || yy >= 200) return false;
              const src = (yy * 320 + xx) * 4;
              return [0, 1, 2].every((channel) => output[dst + channel] === source[src + channel]);
            }),
          );
          check(matches, `Dissolve mismatch at ${width}x${height}:${x},${y}`);
        }
      resizeResults.push(`${width}x${height}`);
    }
    return { fps, dissolveSizes: resizeResults };
  } finally {
    window.requestAnimationFrame = nativeRaf;
    canvas.remove();
  }
}

/** A regression on real WebGL output: throws on failure, returns what it measured (as JSON). */
type Check = readonly [name: string, check: (gl: WebGL2RenderingContext) => unknown];

/**
 * Every check, by name: real WebGL outputs under controlled timing/state, not mocked helper calls.
 * verify.ts runs each on a freshly loaded page (`run`), so a check gets a context of its own and
 * must restore any global it patches.
 */
export const checks: readonly Check[] = [
  ["forestClock", forestClock],
  ["gpuBlend", gpuBlend],
  ["frostWarmth", frostWarmth],
  ["rendererDissolve", rendererDissolve],
  // Registered checks: one import above and one line here each, appended at the end.
  ["mobile", mobileVerify],
  ["orbitRingDepth", verifyOrbitRingDepth],
  ["swellRelief", verifySwellRelief],
  ["auroraRipples", verifyAuroraRipples],
  ["barLastCall", verifyBarLastCall],
  ["dewBins", verifyDewBins],
  ["tidepoolExchange", verifyTidepoolExchange],
  ["lakeFreshSnow", verifyLakeFreshSnow],
  ["shanshui", verifyShanshui],
  ["rippleEdges", rippleEdgesVerify],
  ["incenseVent", incenseVentVerify],
  ["runtime", verifyRuntime],
  ["skywardSnow", skywardSnowCheck],
  ["fallsGorge", fallsGorgeCheck],
  ["motionClocks", verifyMotionClocks],
  ["filmRupture", verifyFilmRupture],
  ["pendulaSwing", verifyPendulaSwing],
  ["frostSky", verifyFrostSky],
  ["cloudsDetail", verifyCloudsDetail],
  ["petriRegimes", petriRegimesVerify],
  ["pondKoi", verifyPondKoi],
  ["planet", verifyPlanet],
  ["streetSnow", streetSnowCheck],
  ["harmonographPrewarm", verifyHarmonographPrewarm],
  ["trainLine", verifyTrainLine],
  ["canopy", verifyCanopy],
  ["waterTiers", verifyWaterTiers],
  ["pondPlants", verifyPondPlants],
  ["islandSnow", islandSnowCheck],
  ["fallsBirds", verifyFallsBirds],
  ["sceneFeatures", verifySceneFeatures],
  ["cloudTiers", verifyCloudTiers],
  ["milkyWay", verifyMilkyWay],
  ["starsKnob", verifyStarsKnob],
  ["meadowWildflowers", verifyMeadowWildflowers],
  ["countryTerrain", verifyCountryTerrain],
  ["featureToggles", verifyFeatureToggles],
  ["featuresAll", verifyFeaturesAll],
  ["countryLife", verifyCountryLife],
  ["countryFeaturesAll", verifyCountryFeaturesAll],
];

/**
 * Runs the named check on a fresh WebGL2 context with a vertex array bound, and hands `report` its
 * outcome as JSON, `{ result }` or `{ error }`. verify.ts passes a page binding as `report`, so the
 * check may outlast any one protocol call.
 */
export async function run(name: string, report: (outcome: string) => void): Promise<void> {
  try {
    const entry = checks.find(([key]) => key === name);
    if (!entry) throw new Error(`No check named ${name}`);
    const gl = context();
    gl.bindVertexArray(gl.createVertexArray());
    report(JSON.stringify({ result: await entry[1](gl) }));
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    report(JSON.stringify({ error: message }));
  }
}
