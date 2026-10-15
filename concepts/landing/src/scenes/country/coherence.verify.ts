// Real-WebGL regressions for how the countryside's parts share the ground (run by verify-browser.ts):
// the settlements added to the original village (its growth, hamlets, farmsteads and the castle)
// stand on open ground, never on a track, the river's water or reeds, or a wood, whatever the river's
// width and however much of the track network shows; neither knob moves or removes a building; no
// building's footprint covers a track or the river; and no animal stands on a track or in the river.
// Each renders the actual scene (sceneCountry) against masks of the bare land from the routes' own
// API (countryRouteAt, countryRiverDistance) and the settlements' (countrySettlementDistance).
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { sceneDefs } from "../index.ts";
import { COUNTRY_FULL } from "./index.ts";

const W = 320;
const H = 200;

// Mode 0: the scene as drawn. Mode 1: the bare land each pixel shows, front to back over the bare
// ridges (no trees, buildings or animals): red its kind (0 open ground, 1 the river's open water or
// reeds at the river's width, 2 a track shown, within its half-width, 3 woodland or treetops), green
// its ridge (6: sky). Mode 2: as 1, blue 1 where a track or the river lies inside a building's
// footprint (countrySettlementDistance 0).
const wrapper = /* glsl */ `
uniform int coherenceMode;
Shade coherenceRegression(vec2 uv, vec2 cell, float t) {
  // The scene sets the landscape's seed (countrySeed) the masks read.
  Shade scene = sceneCountry(uv, cell, t);
  if (coherenceMode == 0) return scene;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  vec2 spots = vec2(-0.2, 0.24) * aspect + countrySeed * 0.004 * aspect;
  for (int k = 0; k < 6; k++) {
    float i = float(k);
    float terrain = 0.0;
    float c = countryCrest(i, p.x, spots, terrain);
    if (p.y >= c) continue;
    float d = countryLayer(i).x;
    float s = max(terrain - p.y, 0.0);
    vec2 w = vec2(p.x * d, countryDown(s, d));
    float kind = 0.0;
    if (p.y > terrain || countryWoodStand(i, w.x, w.y, countrySpots(p.x, spots)) > 0.53) kind = 3.0;
    float bank = countryRiverBank(max(w.y, 0.0));
    float broad = countryRiverScale();
    if (countryRiverDistance(i, w, spots) < countryRiverReeds(bank, broad) - bank * broad) kind = 1.0;
    vec2 axis = vec2(0.0);
    vec4 route = countryRouteAt(i, w, s, terrain, spots, K_tracks, axis);
    if (route.z > 0.0 && abs(route.x) < route.y) kind = 2.0;
    float inside = 0.0;
    if (coherenceMode == 2 && kind > 0.5 && kind < 2.5 && countrySettlementDistance(i, w, spots) <= 0.0) inside = 1.0;
    return shadeOf(vec3(kind / 4.0, i / 8.0, inside), 0.0, 0.0);
  }
  return shadeOf(vec3(0.0, 0.75, 0.0), 0.0, 0.0);
}`;

const KINDS = ["open ground", "the river", "a track", "woodland"];

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`country coherence: ${message}`);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  [vertexSource, fragment].forEach((source, index) => {
    const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    check(Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)), gl.getShaderInfoLog(shader) ?? "compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  });
  gl.linkProgram(linked);
  check(Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)), gl.getProgramInfoLog(linked) ?? "link failed");
  return linked;
}

/** Pixels (bottom-up rows) where two renders differ. */
function changed(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let at = 0; at < W * H; at++) {
    if ([0, 1, 2].some((c) => a[at * 4 + c] !== b[at * 4 + c])) out[at] = 1;
  }
  return out;
}

const count = (mask: Uint8Array): number => mask.reduce((n, v) => n + v, 0);
const where = (at: number): string => `${at % W},${Math.floor(at / W)}`;

function land(mask: Uint8Array, at: number): { kind: number; ridge: number; inside: boolean } {
  return {
    kind: Math.round(((mask[at * 4] ?? 0) * 4) / 255),
    ridge: Math.round(((mask[at * 4 + 1] ?? 0) * 8) / 255),
    inside: (mask[at * 4 + 2] ?? 0) > 127,
  };
}

/**
 * Every building's foot: the pixel under the lowest pixel of a column of building pixels inside a
 * building's width (eaves and verges overhanging the ground at its sides do not count). Where it is
 * the face of the building's own ridge it must be open ground. Returns how many feet were checked.
 */
function footings(built: Uint8Array, bare: Uint8Array, label: string): number {
  let checked = 0;
  for (let at = W; at < W * H; at++) {
    if (!built[at] || built[at - W] || !built[at - 1] || !built[at + 1]) continue;
    const below = land(bare, at - W);
    if (below.ridge !== land(bare, at).ridge) continue;
    check(below.kind === 0, `${label}: a building on ridge ${below.ridge} stands on ${KINDS[below.kind]} at ${where(at)}`);
    checked++;
  }
  return checked;
}

export function verifyCountryCoherence(gl: WebGL2RenderingContext): Record<string, unknown> {
  const linked = program(
    gl,
    fragmentSourceFor({ ...sceneDefs.country, entry: "coherenceRegression", glsl: sceneDefs.country.glsl + wrapper }, COUNTRY_FULL),
  );
  gl.canvas.width = W;
  gl.canvas.height = H;
  gl.viewport(0, 0, W, H);
  gl.useProgram(linked);
  const u = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(u("uRes"), W, H);
  gl.uniform1f(u("uTime"), 10);
  gl.uniform1f(u("uLevels"), 2);
  gl.uniform1i(u("uView"), 1);
  gl.uniform2f(u("uPassage"), 1, 0);
  gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
  // A still, clear afternoon, unlit windows and no smoke: what changes is what the knobs add.
  const day = { time: 0.55, clouds: 0, shadows: 0, wind: 0, fog: 0, lights: 0, smoke: 0 };
  const draw = (knobs: Record<string, number>, mode = 0, motionTime = 6): Uint8Array => {
    gl.uniform1i(u("coherenceMode"), mode);
    gl.uniform1f(u("uMotionTime"), motionTime);
    gl.uniform1fv(
      u("uParams"),
      Float32Array.from(renderSettings(defaultsFor("country"), { ...paramDefaults("country"), ...day, ...knobs }).params),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };
  const result: Record<string, unknown> = {};
  const widths = [
    { river: 0, tracks: 0 },
    { river: 0.5, tracks: 0.5 },
    { river: 1, tracks: 1 },
  ];
  const original = { village: 11, hamlets: 0, farms: 0, castle: 0 };
  const added = { village: 26, hamlets: 3, farms: 1, castle: 0 };

  // The village's growth, the hamlets and the farmsteads (beyond the original street, whose cottages
  // flank the street by design) stand on open ground of their own ridge at every river width and
  // track network shown, and the same buildings stand at all of them.
  let feet = 0;
  let footprint = 0;
  for (const landscape of [0, 42, 137]) {
    let first: Uint8Array | undefined;
    for (const width of widths) {
      const scene = { landscape, ...width };
      const built = changed(draw({ ...scene, ...added }), draw({ ...scene, ...original }));
      const label = `landscape ${landscape}, river ${width.river}, tracks ${width.tracks}`;
      if (first) check(first.every((v, at) => v === built[at]), `${label}: the buildings moved with the river or the tracks`);
      first ??= built;
      feet += footings(built, draw({ ...scene, ...added }, 1), label);
    }
    // No footprint of theirs covers a track or the river (the original street's own excepted).
    const scene = { landscape, river: 1, tracks: 1 };
    const before = draw({ ...scene, ...original }, 2);
    const after = draw({ ...scene, ...added, castle: 1 }, 2);
    for (let at = 0; at < W * H; at++) {
      const now = land(after, at);
      if (now.kind === 1 || now.kind === 2) footprint++;
      check(!now.inside || land(before, at).inside, `landscape ${landscape}: a building's footprint covers ${KINDS[now.kind]} at ${where(at)}`);
    }
  }
  check(feet >= 150, `Settlement fixture too thin: ${feet} feet`);
  check(footprint >= 1000, `Track and river fixture too thin: ${footprint} pixels`);
  result.coherenceFeet = feet;

  // The castle on the down keeps off the chalk track (without woods, whose clearing would count).
  const open = { landscape: 0, woodland: 0, tracks: 1, ...original };
  const castle = changed(draw({ ...open, castle: 1 }), draw(open));
  const castleFeet = footings(castle, draw({ ...open, castle: 1 }, 1), "castle");
  check(castleFeet >= 10, `Castle feet not in sight: ${castleFeet}`);
  result.coherenceCastleFeet = castleFeet;

  // No animal stands on a track shown or in the river's water or reeds, at its width.
  const herds = { crops: 50, pasture: 50, herd: 1, season: 1 };
  let animals = 0;
  for (const { landscape, river, tracks } of [
    { landscape: 0, river: 1, tracks: 1 },
    { landscape: 137, river: 1, tracks: 1 },
    { landscape: 137, river: 0.5, tracks: 0.5 },
  ]) {
    for (const motionTime of [9.5, 187.3]) {
      const scene = { landscape, river, tracks, ...herds };
      const drawn = changed(draw(scene, 0, motionTime), draw({ ...scene, herd: 0 }, 0, motionTime));
      const bare = draw(scene, 1, motionTime);
      for (let at = 0; at < W * H; at++) {
        if (!drawn[at]) continue;
        const under = land(bare, at);
        check(under.kind !== 1 && under.kind !== 2, `landscape ${landscape}, river ${river}, tracks ${tracks}: an animal at ${motionTime} s stands on ${KINDS[under.kind]} at ${where(at)}`);
      }
      animals += count(drawn);
    }
  }
  check(animals >= 1000, `Herd fixture too thin: ${animals} animal pixels`);
  result.coherenceAnimalPixels = animals;

  gl.deleteProgram(linked);
  return result;
}
