// GPU check (verify-browser.ts): the garden's climate (src/climate.ts), through the all-features
// program of its home layers on their own sims' garden. The season sets what falls (the World's
// worldAt): in winter the rain comes down as snow, drawing exactly as the snow switch does, while
// outside winter rain stays rain; the snow switch falls in any season; and the snow lying on the
// garden is uWeather.y's alone (the renderer lays winter's own there), never the season's. Below the
// maple (the only other thing the season changes in the shader) winter with no snow lying draws the
// garden exactly as autumn does. The garden's sky is dated (world-clock.ts): autumn's sun and
// winter's, either side of midwinter, stand alike, so those two seasons compare.
import {
  fragmentSourceFor,
  packParams,
  sceneFeaturesAll,
  shaderValues,
  vertexSource,
} from "../../shaders/index.ts";
import { visitorAlone } from "../../principals.ts";
import { defaultsFor, paramDefaults, renderSettings, type Params } from "../../state.ts";
import { loadScene } from "../index.ts";
import type { SimFrame } from "../types.ts";

const gardenScene = await loadScene("garden");

const WIDTH = 240;
const HEIGHT = 135;
/** Rows from the bottom that the maple never reaches (the shader skips it below ~0.77 of the height). */
const BELOW_MAPLE = Math.round(HEIGHT * 0.6);
/** Garden's season choice. */
const AUTUMN = 2;
const WINTER = 3;

function fail(message: string): never {
  throw new Error(`garden climate: ${message}`);
}

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type) ?? fail("shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      fail(gl.getShaderInfoLog(shader) ?? "compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
    fail(gl.getProgramInfoLog(linked) ?? "link failed");
  return linked;
}

/** Bytes that differ between two frames over their first `rows` rows (from the bottom). */
function changed(a: Uint8Array, b: Uint8Array, rows = HEIGHT): number {
  let count = 0;
  for (let at = 0; at < rows * WIDTH * 4; at++) if (a[at] !== b[at]) count++;
  return count;
}

/** Mean brightness over the first `rows` rows. */
function brightness(bytes: Uint8Array, rows: number): number {
  let sum = 0;
  for (let at = 0; at < rows * WIDTH * 4; at += 4)
    sum += (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) + (bytes[at + 2] ?? 0);
  return sum / (3 * rows * WIDTH);
}

export function gardenClimateCheck(gl: WebGL2RenderingContext): Record<string, unknown> {
  const defaults = paramDefaults("garden");
  const sim = gardenScene.sim?.(gl) ?? fail("no sim");
  const frame: SimFrame = {
    dt: 0,
    time: 0,
    motionTime: 0,
    motion: 1,
    now: 0,
    budget: Infinity,
    width: WIDTH,
    height: HEIGHT,
    aspect: WIDTH / HEIGHT,
    values: renderSettings(defaultsFor("garden"), defaults).params,
    params: defaults,
    triggers: [],
    fired: [],
    passage: { enter: 1, exit: 0 },
    ...visitorAlone(),
  };
  const textures = sim.frame(frame);
  const linked = compile(
    gl,
    fragmentSourceFor(
      gardenScene,
      sceneFeaturesAll(gardenScene, shaderValues(gardenScene)) ?? fail("not knob-keyed"),
    ),
  );
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  const uniform = (name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(linked, name);
  gl.uniform2f(uniform("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(uniform("uView"), 1);
  gl.uniform1f(uniform("uTime"), 40);
  gl.uniform1f(uniform("uMotionTime"), 40);
  gl.uniform1f(uniform("uMotion"), 1);
  gl.uniform2f(uniform("uPassage"), 1, 0);
  gl.uniform4f(uniform("uPrincipals"), 0, 0, 0, -1e4);
  gl.uniform1fv(uniform("uTriggers"), new Float32Array(8).fill(-1e4));
  textures.forEach((texture, slot) => {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
    gl.uniform1i(uniform(`uSim${slot}`), slot);
  });
  gl.uniform4f(uniform("uSimOn"), 1, 1, 1, 1);

  // The same garden (the sim's textures stay as laid out) at noon, under other knobs and weather.
  const draw = (knobs: Params, lying: number): Uint8Array => {
    gl.uniform4fv(
      uniform("uParams"),
      packParams(
        renderSettings(defaultsFor("garden"), { ...defaults, time: 0.5, ...knobs }).params,
      ),
    );
    gl.uniform2f(uniform("uWeather"), 0, lying);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  const rain = { rain: 1, "rain-amount": 0.6 };
  const snow = { snow: 1, "snow-amount": 0.6 };
  const winterRain = draw({ season: WINTER, ...rain }, 1);
  const winterSnow = draw({ season: WINTER, ...snow }, 1);
  const winterStill = draw({ season: WINTER }, 1);
  const winterBare = draw({ season: WINTER }, 0);
  const autumnSnowLying = draw({ season: AUTUMN, ...snow }, 1);
  const autumnRain = draw({ season: AUTUMN, ...rain }, 0);
  const autumnSnow = draw({ season: AUTUMN, ...snow }, 0);
  const autumnBare = draw({ season: AUTUMN }, 0);
  sim.dispose();
  gl.deleteProgram(linked);
  for (let slot = 0; slot < 4; slot++) {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);

  const measured = {
    winterRainVsSnow: changed(winterRain, winterSnow),
    winterRainVsStill: changed(winterRain, winterStill),
    autumnRainVsSnow: changed(autumnRain, autumnSnow),
    autumnRainVsBare: changed(autumnRain, autumnBare),
    autumnVsWinterSnowBelowMaple: changed(autumnSnowLying, winterSnow, BELOW_MAPLE),
    winterVsAutumnBareBelowMaple: changed(winterBare, autumnBare, BELOW_MAPLE),
    lyingChanged: changed(winterStill, winterBare, BELOW_MAPLE) / (BELOW_MAPLE * WIDTH * 4),
    bareBrightness: brightness(winterBare, BELOW_MAPLE),
    lyingBrightness: brightness(winterStill, BELOW_MAPLE),
  };
  if (measured.winterRainVsSnow !== 0)
    fail(`winter's rain draws ${measured.winterRainVsSnow} bytes off the same snow falling`);
  if (measured.winterRainVsStill === 0) fail("winter's rain draws nothing falling");
  if (measured.autumnRainVsBare === 0) fail("autumn's rain draws nothing falling");
  if (measured.autumnRainVsSnow === 0) fail("autumn's rain draws as snow");
  if (measured.autumnVsWinterSnowBelowMaple !== 0)
    fail(
      `the snow switch falls differently in autumn: ${measured.autumnVsWinterSnowBelowMaple} bytes below the maple`,
    );
  if (measured.winterVsAutumnBareBelowMaple !== 0)
    fail(
      `winter lays snow of its own beside uWeather.y: ${measured.winterVsAutumnBareBelowMaple} bytes below the maple`,
    );
  if (measured.lyingChanged < 0.3 || measured.lyingBrightness <= measured.bareBrightness)
    fail(
      `the snow lying (uWeather.y 1) changes ${measured.lyingChanged} of the garden, brightness ${measured.bareBrightness} -> ${measured.lyingBrightness}`,
    );
  return measured;
}
