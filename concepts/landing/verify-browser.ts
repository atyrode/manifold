import { DitherRenderer } from "./src/renderer.ts";
import { defaultsFor, paramDefaults, renderSettings } from "./src/state.ts";
import { sceneDefs } from "./src/scenes/index.ts";
import { verifyCountryAnimals } from "./src/scenes/country/animals.verify.ts";
import { fragmentSourceFor, vertexSource } from "./src/shaders/index.ts";
import { GpuCompute } from "./src/sims/gpu.ts";
import type { SimFrame } from "./src/scenes/types.ts";

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

/** Real WebGL outputs under controlled timing/state, not mocked helper calls. */
export function verify(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const gl = context();
  gl.bindVertexArray(gl.createVertexArray());

  // Observe Forest's actual scene entry sky state, so a legacy caller regression fails this check.
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
  result.clockBytes = clockValues;
  gl.deleteProgram(clock);
  // Exercise actual GLSL selection: relative ratios, zero-weight exclusion, crop diversity,
  // scale invariance and the all-zero fallback. This catches normalization/interval regressions.
  const fields = program(
    gl,
    fragmentSourceFor({
      ...sceneDefs.country,
      entry: "regressionFields",
      glsl:
        sceneDefs.country.glsl +
        `
      Shade regressionFields(vec2 uv, vec2 cell, float t) {
        float crop = countryFieldCrop(gl_FragCoord.x / uRes.x, K_season);
        return shadeOf(vec3(crop / 8.0), crop / 8.0, 0.0);
      }`,
    }),
  );
  gl.canvas.width = 400;
  gl.canvas.height = 1;
  gl.useProgram(fields);
  gl.viewport(0, 0, 400, 1);
  gl.uniform2f(gl.getUniformLocation(fields, "uRes"), 400, 1);
  gl.uniform1i(gl.getUniformLocation(fields, "uView"), 1);
  const drawFields = (weights: readonly number[], season = 1): number[] => {
    const knobs = {
      ...paramDefaults("country"),
      season,
      crops: weights[0] ?? 0,
      wildflowers: weights[1] ?? 0,
      lavender: weights[2] ?? 0,
      sunflowers: weights[3] ?? 0,
    };
    gl.uniform1fv(
      gl.getUniformLocation(fields, "uParams"),
      Float32Array.from(renderSettings(defaultsFor("country"), knobs).params),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const output = pixels(gl, 400, 1);
    return Array.from({ length: 400 }, (_, index) =>
      Math.round(((output[index * 4] ?? 0) * 8) / 255),
    );
  };
  const mixture = drawFields([2, 1, 0, 1]);
  const counts = [0, 0, 0, 0];
  for (const crop of mixture) {
    const index = crop < 6 ? 0 : crop - 5;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  check(counts.join(",") === "200,100,0,100", `Wrong field shares/exclusion: ${counts}`);
  check(
    drawFields([100, 50, 0, 50]).every((crop, i) => crop === mixture[i]),
    "Scaling all field weights changed the composition",
  );
  check(new Set(mixture.slice(0, 200)).size === 5, "Crop share lost seasonal crop diversity");
  for (const season of [0, 1, 2]) {
    const crops = drawFields([100, 0, 0, 0], season);
    check(
      drawFields([0, 0, 0, 0], season).every((crop, i) => crop === crops[i]),
      `All-zero field weights lost crop fallback in season ${season}`,
    );
  }
  check(
    drawFields([0, 0, 1, 0]).every((crop) => crop === 7),
    "Isolated lavender included another type",
  );
  result.fieldShares = counts;
  gl.deleteProgram(fields);
  // Observe the actual scene entry away from canopy overlaps: changing species must not deform
  // exposed ground, and fully pine woodland must remain evergreen through autumn, including LOD.
  const terrain = program(
    gl,
    fragmentSourceFor({
      ...sceneDefs.country,
      entry: "regressionCountrySurface",
      glsl:
        sceneDefs.country.glsl +
        `
      uniform int regressionHabitat;
      Shade regressionCountrySurface(vec2 uv, vec2 cell, float t) {
        Shade actual = sceneCountry(uv, cell, t);
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
        vec2 spots = vec2(-0.2, 0.24) * aspect + countrySeed * 0.004 * aspect;
        for (int k = 0; k < 6; k++) {
          float i = float(k);
          float d = countryLayer(i).x;
          float crest = countryGroundCrest(i, p.x, spots);
          if (abs(crest - p.y) < 0.07 / d) break;
          if (p.y < crest) {
            vec2 w = vec2(p.x * d, countryDown(crest - p.y, d));
            float woods = countryWoods(i, w.x, w.y, countrySpots(p.x, spots));
            if (regressionHabitat == 2) return actual;
            if (k >= 3 && (regressionHabitat == 0 ? woods < 0.001 : woods >= 1.0))
              return actual;
            break;
          }
        }
        return shadeOf(vec3(1.0, 0.0, 1.0), 0.0, 0.0);
      }`,
    }),
  );
  gl.canvas.width = 256;
  gl.canvas.height = 160;
  gl.useProgram(terrain);
  gl.viewport(0, 0, 256, 160);
  gl.uniform2f(gl.getUniformLocation(terrain, "uRes"), 256, 160);
  gl.uniform1i(gl.getUniformLocation(terrain, "uView"), 1);
  gl.uniform1fv(gl.getUniformLocation(terrain, "uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform2f(gl.getUniformLocation(terrain, "uPassage"), 1, 0);
  const drawTerrain = (
    season: number,
    pines: number,
    habitat: number,
    woodland = 0.5,
  ): Uint8Array => {
    gl.uniform1i(gl.getUniformLocation(terrain, "regressionHabitat"), habitat);
    const knobs = {
      ...paramDefaults("country"),
      pines,
      woodland,
      season,
      time: 0.58,
      clouds: 0,
      shadows: 0,
      wind: 0,
      fog: 0,
    };
    gl.uniform1fv(
      gl.getUniformLocation(terrain, "uParams"),
      Float32Array.from(renderSettings(defaultsFor("country"), knobs).params),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return pixels(gl, 256, 160);
  };
  const compareSurface = (a: Uint8Array, b: Uint8Array, message: string): number => {
    let observed = 0;
    for (let at = 0; at < a.length; at += 4) {
      if (a[at] === 255 && a[at + 1] === 0 && a[at + 2] === 255) continue;
      observed++;
      check(
        [0, 1, 2].every((channel) => a[at + channel] === b[at + channel]),
        `${message} at pixel ${at / 4}`,
      );
    }
    check(observed >= 20, `Surface fixture lacked the requested habitat: ${observed}`);
    return observed;
  };
  result.exposedGroundPixels = compareSurface(
    drawTerrain(1, 0, 0),
    drawTerrain(1, 1, 0),
    "Tree species changed exposed countryside ground",
  );
  result.evergreenPixels = compareSurface(
    drawTerrain(0, 1, 1),
    drawTerrain(2, 1, 1),
    "Pine woodland changed color in autumn",
  );
  // With woodland cleared, species must have nothing left to change anywhere on the far land.
  result.clearedPixels = compareSurface(
    drawTerrain(2, 0, 2, 0),
    drawTerrain(2, 1, 2, 0),
    "Woodland cover 0 left trees standing",
  );
  gl.deleteProgram(terrain);

  Object.assign(result, verifyCountryAnimals(gl));
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
  result.blendValues = blends;
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
  result.blendResizePreserved = true;
  gpu.dispose();

  const frostGl = context();
  const frost = sceneDefs.frost.sim?.(frostGl);
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
  };
  function mask(): Uint8Array {
    frame.values = renderSettings(defaultsFor("frost"), knobs).params;
    const texture = frost?.frame(frame)[1];
    if (!texture) throw new Error("Missing frost mask");
    // Sample the complete mask through a fullscreen draw onto a fixed-size readable canvas.
    const sampler = program(
      frostGl,
      `#version 300 es
      precision highp float; uniform sampler2D mask; out vec4 outColor;
      void main() { outColor = texture(mask, gl_FragCoord.xy / vec2(320.0, 200.0)); }`,
    );
    frostGl.canvas.width = 320;
    frostGl.canvas.height = 200;
    frostGl.bindVertexArray(frostGl.createVertexArray());
    frostGl.useProgram(sampler);
    frostGl.activeTexture(frostGl.TEXTURE0);
    frostGl.bindTexture(frostGl.TEXTURE_2D, texture);
    frostGl.uniform1i(frostGl.getUniformLocation(sampler, "mask"), 0);
    frostGl.viewport(0, 0, 320, 200);
    frostGl.drawArrays(frostGl.TRIANGLES, 0, 3);
    const bytes = pixels(frostGl, 320, 200);
    frostGl.deleteProgram(sampler);
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
  result.frost = { heated: true, pristineOnReseed: true, pristineOnResume: true };
  frost.dispose();

  const nativeRaf = window.requestAnimationFrame;
  let tick: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    tick = callback;
    return 1;
  };
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
  function draw(now: number): void {
    if (!tick) throw new Error("RAF missing");
    tick(now);
  }
  try {
    renderer.start();
    draw(1000);
    draw(2000);
    check(Math.abs(renderer.fps - 1) < 1e-9, `1fps delivery reported ${renderer.fps}`);
    result.fps = renderer.fps;
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
    result.dissolveSizes = resizeResults;
  } finally {
    window.requestAnimationFrame = nativeRaf;
    canvas.remove();
  }
  return result;
}
