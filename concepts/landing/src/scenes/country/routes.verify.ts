// Real-WebGL regressions for the countryside's river width, track network and walkers and carts:
// each renders the actual scene (sceneCountry) and checks it against the routes' own GLSL API
// (countryRouteDistance, countryRiverDistance), evaluated by a separate regression entry.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { sceneDefs } from "../index.ts";
import { COUNTRY_FULL } from "./index.ts";

const WIDTH = 320;
const HEIGHT = 180;

// The ground each pixel shows, front to back over the bare ridges (no trees or buildings), as the
// scene places it: out.r 1 where `regressionProbe` holds there. Probes: 0 a walker's or cart's box
// (some route within 0.03 world below the pixel, up to a cart's height on screen); 1 open water by
// countryRiverDistance; 2 a track by countryRouteDistance on ridges 1..5; 3 the lane's own surface.
const regressionGlsl = `
uniform int regressionProbe;
Shade regressionRoutes(vec2 uv, vec2 cell, float t) {
  sceneCountry(uv, cell, t);
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  vec2 spots = vec2(-0.2, 0.24) * aspect + countrySeed * 0.004 * aspect;
  int steps = regressionProbe == 0 ? 24 : 1;
  for (int j = 0; j < 24; j++) {
    if (j >= steps) break;
    float y = p.y - float(j) * 0.0015;
    for (int k = 0; k < 6; k++) {
      float i = float(k);
      float d = countryLayer(i).x;
      float terrain = 0.0;
      float c = countryCrest(i, p.x, spots, terrain);
      if (y >= c) continue;
      vec2 w = vec2(p.x * d, countryDown(max(terrain - y, 0.0), d));
      bool hit = false;
      if (regressionProbe == 0) {
        hit = countryRouteDistance(i, w, spots) < 0.03;
        // Just under a crest: a walker or cart going over it stands on the route's far side.
        for (int b = 1; b <= 4; b++) {
          if (terrain - y < 0.01) hit = hit || countryRouteDistance(i, vec2(w.x, -0.05 * float(b)), spots) < 0.03;
        }
      }
      if (regressionProbe == 1) hit = countryRiverDistance(i, w, spots) < -0.5 * d / uRes.y;
      if (regressionProbe == 2) hit = k > 0 && countryRouteDistance(i, w, spots) < 0.8 * COUNTRY_LANE;
      if (regressionProbe == 3) hit = k == 0 && countryRouteDistance(i, w, spots) < 0.5 * COUNTRY_LANE;
      if (hit) return shadeOf(vec3(1.0), 1.0, 0.0);
      break;
    }
  }
  return shadeOf(vec3(0.0), 0.0, 0.0);
}`;

function fail(message: string): never {
  throw new Error(`country routes: ${message}`);
}

function link(gl: WebGL2RenderingContext, entry: string, glsl: string): WebGLProgram {
  const program = gl.createProgram();
  const scene = { ...sceneDefs.country, entry, glsl: sceneDefs.country.glsl + glsl };
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSourceFor(scene, COUNTRY_FULL)],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) fail("shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      fail(gl.getShaderInfoLog(shader) ?? "compile failed");
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    fail(gl.getProgramInfoLog(program) ?? "link failed");
  return program;
}

interface Frame {
  knobs?: Record<string, number>;
  motionTime?: number;
  time?: number;
  probe?: number;
}

function draw(gl: WebGL2RenderingContext, program: WebGLProgram, frame: Frame): Uint8Array {
  gl.useProgram(program);
  gl.viewport(0, 0, WIDTH, HEIGHT);
  const at = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform1f(at("uMotion"), 1);
  gl.uniform1f(at("uMotionTime"), frame.motionTime ?? 120);
  gl.uniform1f(at("uTime"), frame.time ?? frame.motionTime ?? 120);
  gl.uniform1i(at("regressionProbe"), frame.probe ?? 0);
  // Still air and a fixed sun, so only the routes' own knobs move anything.
  const knobs = {
    ...paramDefaults("country"),
    clouds: 0,
    shadows: 0,
    wind: 0,
    fog: 0,
    ...frame.knobs,
  };
  gl.uniform1fv(
    at("uParams"),
    Float32Array.from(renderSettings(defaultsFor("country"), knobs).params),
  );
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
  gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  if (gl.getError() !== gl.NO_ERROR) fail("readPixels GL error");
  return bytes;
}

/** Pixel indices whose colour differs between two renders. */
function changed(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let at = 0; at < a.length; at += 4) {
    if (a[at] !== b[at] || a[at + 1] !== b[at + 1] || a[at + 2] !== b[at + 2]) out.push(at / 4);
  }
  return out;
}

function marked(mask: Uint8Array): number[] {
  const out: number[] = [];
  for (let at = 0; at < mask.length; at += 4) if ((mask[at] ?? 0) > 127) out.push(at / 4);
  return out;
}

export function verifyCountryRoutes(gl: WebGL2RenderingContext): Record<string, unknown> {
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  const scene = link(gl, "sceneCountry", "");
  const probe = link(gl, "regressionRoutes", regressionGlsl);
  try {
    // Walkers and carts: every pixel they change lies over a shown route (their feet within 0.03
    // world of a track, at most a cart's height below), they are there to be seen, and they stand
    // still when only the scene clock moves.
    const busy = { tracks: 1, walkers: 1, "walkers-amount": 1, carts: 1, "carts-amount": 3 };
    const near = new Set(marked(draw(gl, probe, { knobs: { tracks: 1 }, probe: 0 })));
    let agentPixels = 0;
    const moments = [40, 95, 140, 200, 260, 330, 410, 520];
    for (const motionTime of moments) {
      const shown = draw(gl, scene, { knobs: busy, motionTime });
      const bare = draw(gl, scene, { knobs: { tracks: 1 }, motionTime });
      const moved = changed(shown, bare);
      const stray = moved.filter((pixel) => !near.has(pixel));
      if (stray.length > 0)
        fail(
          `at ${motionTime}s ${stray.length} walker/cart pixels off every route, e.g. ${stray.slice(0, 5).join(",")}`,
        );
      agentPixels += moved.length;
      const later = draw(gl, scene, { knobs: busy, motionTime, time: motionTime + 30 });
      if (changed(shown, later).length > 0)
        fail(
          `walkers or carts moved with the scene clock while the motion clock stood at ${motionTime}s`,
        );
    }
    if (agentPixels < 6)
      fail(`walkers and carts left only ${agentPixels} pixels over ${moments.length} moments`);
    const moving = changed(
      draw(gl, scene, { knobs: busy, motionTime: 140 }),
      draw(gl, scene, { knobs: busy, motionTime: 150 }),
    );
    if (moving.length === 0) fail("walkers and carts did not move with the motion clock");

    // The river knob: open water by the API is water in the render at every width (its ripples move
    // with the motion clock, as nothing else in still air does), the river's footprint against the
    // dried-up river grows with the knob, and zero dries it up.
    const dry = draw(gl, scene, { knobs: { river: 0 } });
    const coverage: number[] = [];
    for (const river of [0.15, 0.3, 0.5, 0.75, 1]) {
      const wet = draw(gl, scene, { knobs: { river } });
      coverage.push(changed(wet, dry).length);
      const rippled = new Set(changed(wet, draw(gl, scene, { knobs: { river }, motionTime: 133 })));
      const water = marked(draw(gl, probe, { knobs: { river }, probe: 1 }));
      const live = water.filter((pixel) => rippled.has(pixel)).length;
      if (water.length > 0 && live < 0.7 * water.length)
        fail(`river ${river}: only ${live} of ${water.length} open-water pixels drawn as water`);
      if (river >= 0.5 && water.length < 20)
        fail(`river ${river}: only ${water.length} open-water pixels`);
    }
    for (let k = 1; k < coverage.length; k++) {
      if ((coverage[k] ?? 0) <= (coverage[k - 1] ?? 0))
        fail(`river footprint did not grow with the knob: ${coverage.join(",")}`);
    }
    if (marked(draw(gl, probe, { knobs: { river: 0 }, probe: 1 })).length > 0)
      fail("river 0 still reports open water");

    // Tracks: at zero only the lane exists; raised, the network appears on the farther ridges and
    // the lane itself is untouched.
    if (marked(draw(gl, probe, { knobs: { tracks: 0 }, probe: 2 })).length > 0)
      fail("tracks 0 reports a route beyond the near field");
    const network = marked(draw(gl, probe, { knobs: { tracks: 1 }, probe: 2 }));
    const without = draw(gl, scene, { knobs: { tracks: 0 } });
    const withNet = draw(gl, scene, { knobs: { tracks: 1 } });
    const drawn = new Set(changed(withNet, without));
    const networkShown = network.filter((pixel) => drawn.has(pixel)).length;
    if (networkShown < 0.6 * network.length || networkShown < 40)
      fail(`tracks 1 drew ${networkShown} of ${network.length} network pixels`);
    const lane = marked(draw(gl, probe, { knobs: { tracks: 0 }, probe: 3 }));
    if (lane.length < 40) fail(`the lane covers only ${lane.length} pixels`);
    const laneChanged = lane.filter((pixel) => drawn.has(pixel)).length;
    if (laneChanged > 0.02 * lane.length)
      fail(`raising tracks changed ${laneChanged} of ${lane.length} lane pixels`);
    return {
      routesAgentPixels: agentPixels,
      routesRiverCoverage: coverage,
      routesNetworkPixels: networkShown,
      routesLanePixels: lane.length,
    };
  } finally {
    gl.deleteProgram(scene);
    gl.deleteProgram(probe);
  }
}
