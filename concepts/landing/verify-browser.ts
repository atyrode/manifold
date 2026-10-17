import { visitorAlone } from "./src/principals.ts";
import { DitherRenderer } from "./src/renderer.ts";
import { defaultsFor, paramDefaults, renderSettings } from "./src/state.ts";
import { sceneDefs } from "./src/scenes/index.ts";
import { incenseVentVerify } from "./src/scenes/incense/vent.verify.ts";
import { rippleEdgesVerify } from "./src/scenes/ripple/edges.verify.ts";
import { verifyHarmonographPrewarm } from "./src/scenes/harmonograph/prewarm.verify.ts";
import { fragmentSourceFor, packParams } from "./src/shaders/index.ts";
import { verifyFrostSky } from "./src/scenes/frost/sky.verify.ts";
import { GpuCompute } from "./src/sims/gpu.ts";
import { verifyOrbitRingDepth } from "./src/scenes/orbit/ring-depth.verify.ts";
import { verifySwellRelief } from "./src/scenes/swell/relief.verify.ts";
import { verifyLakeRipples } from "./src/scenes/lake/ripples.verify.ts";
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
import { motionClocksAll, verifyMotionClocks } from "./src/scenes/train/motion-clock.verify.ts";
import { verifyTrainLine } from "./src/scenes/train/line.verify.ts";
import { verifyFilmRupture } from "./src/scenes/film/rupture.verify.ts";
import { verifyPendulaSwing } from "./src/scenes/pendula/swing.verify.ts";
import { verifyFallsBirds } from "./src/scenes/falls/birds.verify.ts";
import { petriRegimesVerify } from "./src/scenes/petri/regimes.verify.ts";
import { verifyPondKoi } from "./src/scenes/pond/koi.verify.ts";
import { verifyPlanet } from "./src/scenes/campfire/planet.verify.ts";
import { streetSnowCheck } from "./src/scenes/street/snow.verify.ts";
import { verifyCanopy } from "./src/scenes/forest/canopy.verify.ts";
import { verifyWaterTiers } from "./src/shaders/lib/water.verify.ts";
import { verifyPondPlants } from "./src/scenes/pond/plants.verify.ts";
import { islandSnowCheck } from "./src/scenes/island/snow.verify.ts";
import { gardenClimateCheck } from "./src/scenes/garden/climate.verify.ts";
import {
  verifyFeatureToggles,
  verifySceneFeatures,
  verifyWorldFeaturesAll,
} from "./src/features.verify.ts";
import { verifyCloudTiers } from "./src/scenes/clouds/tiers.verify.ts";
import { verifyMilkyWay } from "./src/scenes/campfire/milkyway.verify.ts";
import { verifyStarsKnob } from "./src/scenes/shore/stars.verify.ts";
import { verifyMeadowWildflowers } from "./src/scenes/meadow/wildflowers.verify.ts";
import { verifyCountryTerrain } from "./src/scenes/country/terrain.verify.ts";
import { verifyCountryBehind } from "./src/scenes/country/behind.verify.ts";
import { verifyCountryLife } from "./src/scenes/country/life.verify.ts";
import { verifyCountryFeaturesAll } from "./src/scenes/country/features.verify.ts";
import { verifyCountryMurmuration, verifyCountryVerges } from "./src/scenes/country/wild.verify.ts";
import { verifyCountrySeason } from "./src/scenes/country/season.verify.ts";
import { verifyCountryYear } from "./src/scenes/country/year.verify.ts";
import { verifyCountryChalk } from "./src/scenes/country/chalk.verify.ts";
import { verifyCountryFog } from "./src/scenes/country/fog.verify.ts";
import { passageSpeeds } from "./src/passage-speed.verify.ts";
import { verifyNightPlanets, verifyNightSky } from "./src/night-sky.verify.ts";
import { verifyInspector } from "./src/lab/inspector.verify.ts";
import { verifyOrbitKepler } from "./src/scenes/orbit/kepler.verify.ts";
import { verifyContextRestore, verifyFrameGovernor } from "./src/display.verify.ts";
import { verifyShallowWater } from "./src/sims/shallow.verify.ts";
import { verifyWorldClock } from "./src/world-clock.verify.ts";
import { verifyFluidPressure } from "./src/sims/fluid.verify.ts";
import {
  check,
  holdFrames,
  link,
  pause,
  readBytes,
  stage,
  type SceneWalk,
} from "./src/verify/kit.ts";

function context(): WebGL2RenderingContext {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) throw new Error("WebGL2 unavailable");
  return gl;
}

// Observe Forest's actual scene entry sky state, so a legacy caller regression fails this check.
function forestClock(gl: WebGL2RenderingContext): number[] {
  const clock = link(
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
  gl.uniform4fv(
    gl.getUniformLocation(clock, "uParams"),
    packParams(renderSettings(defaultsFor("forest"), clockKnobs).params),
  );
  const clockValues: number[] = [];
  for (const motion of [0.25, 1, 0]) {
    gl.uniform1f(gl.getUniformLocation(clock, "uMotion"), motion);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    clockValues.push(readBytes(gl, 1, 1)[0] ?? -1);
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
    now: 0,
    budget: Infinity,
    width: 320,
    height: 200,
    aspect: 1.6,
    params: knobs,
    values: [],
    triggers: [],
    fired: [],
    passage: { enter: 1, exit: 0 },
    ...visitorAlone({ inside: true }),
    parallax: { x: 0, y: 0 },
  };
  function mask(): Uint8Array {
    frame.values = renderSettings(defaultsFor("frost"), knobs).params;
    const texture = frost?.frame(frame)[1];
    if (!texture) throw new Error("Missing frost mask");
    // Sample the complete mask through a fullscreen draw onto a fixed-size readable canvas.
    const sampler = link(
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
    const bytes = readBytes(gl, 320, 200);
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

// The real renderer on a hand-driven frame clock (its own canvas and context, unpaced): 1 fps
// delivery reports 1 fps; the scene enters once its program is built in the background; a replayed
// passage enters `overlap` of the way through the exit; while the blend runs the leaving scene goes
// on drawing (its frame changes from one frame to the next), and the screen samples it exactly at
// larger, smaller, aspect-changed and unchanged sizes, with the incoming scene at a coarser cell
// size than the leaving one.
async function rendererPassage(_gl: WebGL2RenderingContext): Promise<Record<string, unknown>> {
  const { canvas, gl: rendererGl } = stage(320, 200);
  const state = {
    ...defaultsFor("country"),
    pixel: 1,
    motion: 1,
    view: "source" as const,
    transitions: "off" as const,
    overlap: 0.5,
    weave: 4,
  };
  const locations = new WeakSet<WebGLUniformLocation>();
  const passageLocations = new WeakSet<WebGLUniformLocation>();
  const getLocation = rendererGl.getUniformLocation.bind(rendererGl);
  rendererGl.getUniformLocation = (linked, name) => {
    const location = getLocation(linked, name);
    if (location && name === "uDissolve") locations.add(location);
    if (location && name === "uPassage") passageLocations.add(location);
    return location;
  };
  const sent: number[][] = [];
  /** The exit each draw into the leaving frame was sent, and the last one sent on screen. */
  const leavingExits: number[] = [];
  let screenExit = 0;
  const uniform2 = rendererGl.uniform2f.bind(rendererGl);
  rendererGl.uniform2f = (location, x, y) => {
    const offScreen = rendererGl.getParameter(rendererGl.FRAMEBUFFER_BINDING) !== null;
    if (location !== null && passageLocations.has(location)) {
      if (offScreen) leavingExits.push(y);
      else screenExit = y;
    }
    uniform2(location, x, y);
  };
  const uniform = rendererGl.uniform3f.bind(rendererGl);
  let holdLeaving = false;
  // Record every dissolve sent; to read the leaving frame whole, show only it on screen (the leaving
  // scene's own draw, into its frame, keeps its own).
  rendererGl.uniform3f = (location, x, y, z) => {
    const dissolve = location !== null && locations.has(location);
    if (dissolve) sent.push([x, y, z]);
    const onScreen = rendererGl.getParameter(rendererGl.FRAMEBUFFER_BINDING) === null;
    if (dissolve && holdLeaving && onScreen) uniform(location, 1, 1, z);
    else uniform(location, x, y, z);
  };
  const params = paramDefaults("country");
  const renderer = new DitherRenderer(canvas, renderSettings(state, params), false);
  const frames = holdFrames();
  function draw(now: number): void {
    sent.length = 0;
    frames.run(now);
  }
  /** The leaving scene's frame as last drawn: the texture on the uLeaving unit. */
  function leavingFrame(): { bytes: Uint8Array; width: number; height: number } {
    const gl = rendererGl;
    gl.activeTexture(gl.TEXTURE0 + 4);
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const bytes = readBytes(gl, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return { bytes, width, height };
  }
  try {
    renderer.start({ paced: false });
    draw(1000);
    draw(2000);
    check(Math.abs(renderer.fps - 1) < 1e-9, `1fps delivery reported ${renderer.fps}`);
    const fps = renderer.fps;
    // Frames a millisecond apart, a little real time apart too (a build's status changes only
    // between tasks), until the scene is on screen.
    let at = 2000;
    while (renderer.waiting) {
      await pause(20);
      draw((at += 1));
    }
    const exit = sceneDefs.country.passage?.exit ?? 0;
    check(exit > 0, "Countryside needs an exit for this check");
    renderer.replayPassage();
    // The first frame only makes the incoming program ready: the scene idles, nothing blends.
    at += 1000;
    draw(at);
    check(
      sent.length === 1 && sent[0]?.[0] === 0,
      `Blended while preparing: ${JSON.stringify(sent)}`,
    );
    // Then the incoming scene runs ahead off screen (one cell, no blend) while the leaving one
    // still idles, until its sim has built its land: only then does the exit start.
    let waited = 0;
    for (; waited < 400; waited++) {
      at += 20;
      draw(at);
      check(
        sent.every((dissolve) => dissolve[0] === 0),
        `Blended while running ahead: ${JSON.stringify(sent)}`,
      );
      if (screenExit > 0) break;
    }
    check(waited > 2 && screenExit > 0, `The exit did not wait for the land (${waited} frames)`);
    // It began on the frame before; the entrance is due half-way through it.
    const start = at - 20;
    draw(start + exit * 500 - 50);
    check(
      sent.length === 2 && sent.every((dissolve) => dissolve[0] === 0),
      `Entered before the overlap: ${JSON.stringify(sent)}`,
    );
    draw(start + exit * 500 + 50);
    check(
      sent.length === 2 && sent[1]?.[0] === 1 && sent[1][1] === 1,
      `The entrance did not start over the leaving scene: ${JSON.stringify(sent)}`,
    );
    // The incoming scene at twice the leaving scene's cell size.
    renderer.update(renderSettings({ ...state, pixel: 2 }, params));
    holdLeaving = true;
    let t = start + exit * 500 + 150;
    draw(t);
    const first = leavingFrame();
    check(
      first.bytes.some((value, index) => index % 4 !== 3 && value !== first.bytes[index % 4]),
      "Leaving frame must be nonuniform",
    );
    t += 100;
    draw(t);
    const second = leavingFrame();
    let moved = 0;
    for (let i = 0; i < second.bytes.length; i += 4)
      if (second.bytes[i] !== first.bytes[i] || second.bytes[i + 1] !== first.bytes[i + 1]) moved++;
    check(moved > 0, "The leaving scene stood still during the blend");
    const resizeResults: string[] = [];
    for (const [cssWidth, cssHeight] of [
      [480, 300],
      [160, 100],
      [480, 200],
      [320, 200],
    ]) {
      if (cssWidth === undefined || cssHeight === undefined) throw new Error("Missing dimensions");
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      // The canvas takes its new size from its observer, which reports at a rendering update.
      await frames.rendered();
      t += 10;
      draw(t);
      // Read the screen first: reading the leaving frame binds another framebuffer.
      const width = cssWidth / 2;
      const height = cssHeight / 2;
      const output = readBytes(rendererGl, width, height);
      const source = leavingFrame();
      const sw = source.width;
      const sh = source.height;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const sx = ((x + 0.5) * sw) / width;
          const sy = ((y + 0.5) * sh) / height;
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
              if (xx < 0 || xx >= sw || yy < 0 || yy >= sh) return false;
              const src = (yy * sw + xx) * 4;
              return [0, 1, 2].every(
                (channel) => output[dst + channel] === source.bytes[src + channel],
              );
            }),
          );
          check(matches, `Blend mismatch at ${width}x${height}:${x},${y}`);
        }
      resizeResults.push(`${width}x${height} over ${sw}x${sh}`);
    }
    // The exit is drawn out to last the blend: just before the blend's end the leaving scene is
    // still on its way out (0.7 s of exit left at the overlap, over a 4 s blend).
    holdLeaving = false;
    const length = exit * 0.5 + 4;
    leavingExits.length = 0;
    t = start + (length - 0.1) * 1000;
    draw(t);
    const lateExit = leavingExits.at(-1) ?? Number.NaN;
    check(
      lateExit > 0.95 && lateExit < 1 && (sent.at(-1)?.[0] ?? 0) > 0,
      `The leaving scene stood still under the blend: exit ${lateExit}, ${JSON.stringify(sent)}`,
    );
    // The blend ends once the incoming scene shows alone; the leaving scene is then gone.
    t += 4100;
    draw(t);
    draw(t + 10);
    check(
      sent.length === 1 && sent[0]?.[0] === 0,
      `The blend did not end: ${JSON.stringify(sent)}`,
    );
    return { fps, movedTexels: moved, blendSizes: resizeResults, lateExit };
  } finally {
    frames.restore();
    canvas.remove();
  }
}

/**
 * A regression on real WebGL output: throws on failure, returns what it measured (as JSON). One that
 * walks scenes (`walk`, src/verify/kit.ts) carries them, and a run scoped to some walks those alone.
 */
type Check = readonly [name: string, check: ((gl: WebGL2RenderingContext) => unknown) | SceneWalk];

/**
 * Every check, by name: real WebGL outputs under controlled timing/state, not mocked helper calls.
 * verify.ts runs each on a freshly loaded page (`run`), so a check gets a context of its own and
 * must restore any global it patches.
 */
export const checks: readonly Check[] = [
  ["forestClock", forestClock],
  ["gpuBlend", gpuBlend],
  ["frostWarmth", frostWarmth],
  ["rendererPassage", rendererPassage],
  ["passageSpeeds1", passageSpeeds(0, 4)],
  ["passageSpeeds2", passageSpeeds(1, 4)],
  ["passageSpeeds3", passageSpeeds(2, 4)],
  ["passageSpeeds4", passageSpeeds(3, 4)],
  // Registered checks: one import above and one line here each, appended at the end.
  ["mobile", mobileVerify],
  ["orbitRingDepth", verifyOrbitRingDepth],
  ["swellRelief", verifySwellRelief],
  ["lakeRipples", verifyLakeRipples],
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
  ["gardenClimate", gardenClimateCheck],
  ["fallsBirds", verifyFallsBirds],
  ["sceneFeatures", verifySceneFeatures],
  ["cloudTiers", verifyCloudTiers],
  ["milkyWay", verifyMilkyWay],
  ["starsKnob", verifyStarsKnob],
  ["meadowWildflowers", verifyMeadowWildflowers],
  ["countryTerrain", verifyCountryTerrain],
  ["countryBehind", verifyCountryBehind],
  ["featureToggles", verifyFeatureToggles],
  ["countryLife", verifyCountryLife],
  ["countryFeaturesAll", verifyCountryFeaturesAll],
  ["countryMurmuration", verifyCountryMurmuration],
  ["countryVerges", verifyCountryVerges],
  ["countrySeason", verifyCountrySeason],
  ["countryYear", verifyCountryYear],
  ["countryChalk", verifyCountryChalk],
  ["worldFeaturesAll", verifyWorldFeaturesAll],
  ["nightSky", verifyNightSky],
  ["countryFog", verifyCountryFog],
  ["motionClocksAll1", motionClocksAll(0, 4)],
  ["motionClocksAll2", motionClocksAll(1, 4)],
  ["motionClocksAll3", motionClocksAll(2, 4)],
  ["motionClocksAll4", motionClocksAll(3, 4)],
  ["nightPlanets", verifyNightPlanets],
  ["labInspector", verifyInspector],
  ["orbitKepler", verifyOrbitKepler],
  ["contextRestore", verifyContextRestore],
  ["frameGovernor", verifyFrameGovernor],
  ["shallowWater", verifyShallowWater],
  ["worldClock", verifyWorldClock],
  ["fluidPressure", verifyFluidPressure],
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
