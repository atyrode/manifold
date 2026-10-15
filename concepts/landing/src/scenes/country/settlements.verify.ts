// Regressions for the countryside's settlements on actual renders of the scene (run by
// verify-browser.ts in real WebGL): buildings stand on open ground and never float; the village
// grows without moving a cottage, its lights and smoke growing with it; the castle rises against the
// sky from a cleared hilltop; hamlets keep behind the nearer ridges; farms only ever add; and the
// footprint API (countrySettlementDistance) knows every building drawn.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { sceneDefs } from "../index.ts";

const W = 320;
const H = 200;

// Mode 0: the scene as drawn. Mode 1: the bare land each pixel shows without any building: red
// its kind (0 open ground, 1 the river and its banks, 2 the farm track, 3 woodland or treetops),
// green its ridge (6: sky). Mode 2: as 1, blue the settlements' clearance there (world units, 1 cap).
const wrapper = /* glsl */ `
uniform int settleMode;
Shade settleRegression(vec2 uv, vec2 cell, float t) {
  Shade scene = sceneCountry(uv, cell, t);
  if (settleMode == 0) return scene;
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
    if (k == 0) {
      vec2 lane = countryLane(w.y, spots.x * 0.6);
      float z = d * (1.0 - 0.35 * smoothstep(0.0, 0.2, s));
      if (abs(p.x * z - lane.x) / sqrt(1.0 + lane.y * lane.y) < 1.3 * COUNTRY_LANE) kind = 2.0;
    }
    if (k == 1) {
      vec2 river = countryRiver(w.y, (spots.x + 0.07) * d);
      float bank = 0.012 + 0.008 * clamp(w.y / 0.6, 0.0, 1.0);
      if (abs(w.x - river.x) / sqrt(1.0 + river.y * river.y) < 1.7 * bank) kind = 1.0;
    }
    float clear = settleMode == 2 ? min(countrySettlementDistance(i, w, spots), 1.0) : 0.0;
    return shadeOf(vec3(kind / 4.0, i / 8.0, clear), 0.0, 0.0);
  }
  return shadeOf(vec3(0.0, 0.75, 1.0), 0.0, 0.0);
}`;

const KINDS = ["open ground", "the river", "the farm track", "woodland"];

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
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

/** The share of `inner`'s pixels also in `outer` (all of none: 1). */
function kept(inner: Uint8Array, outer: Uint8Array): number {
  let both = 0;
  for (let at = 0; at < W * H; at++) if (inner[at] && outer[at]) both++;
  const total = count(inner);
  return total === 0 ? 1 : both / total;
}

function surface(land: Uint8Array, at: number): { kind: number; ridge: number; clear: number } {
  return {
    kind: Math.round(((land[at * 4] ?? 0) * 4) / 255),
    ridge: Math.round(((land[at * 4 + 1] ?? 0) * 8) / 255),
    clear: (land[at * 4 + 2] ?? 255) / 255,
  };
}

/**
 * Every building's foot: the pixel under the lowest pixel of a column of building pixels, inside a
 * building's width (its neighbours on that row are building too, so the eaves and verges that
 * overhang the ground at its sides do not count). It must never be sky (a floating building); where
 * it is the face of the building's own ridge, it must be open ground and (with `api`) inside the
 * footprint countrySettlementDistance reports. Returns how many feet were checked.
 */
function footings(built: Uint8Array, land: Uint8Array, label: string, api = false): number {
  let checked = 0;
  for (let at = W; at < W * H; at++) {
    if (!built[at] || built[at - W] || !built[at - 1] || !built[at + 1]) continue;
    const below = surface(land, at - W);
    const self = surface(land, at);
    const where = `${at % W},${Math.floor(at / W)}`;
    check(below.ridge !== 6, `${label}: a building floats over the sky at ${where}`);
    if (below.ridge !== self.ridge) continue;
    check(below.kind === 0, `${label}: a building on ridge ${self.ridge} stands on ${KINDS[below.kind]} at ${where}`);
    if (api) check(below.clear < 0.15, `${label}: countrySettlementDistance misses the building at ${where} (${below.clear.toFixed(2)})`);
    checked++;
  }
  return checked;
}

/** Connected groups of pixels (8-neighbours, gaps up to `reach` bridged) and their extents. */
function groups(mask: Uint8Array, reach = 2): { n: number; x0: number; x1: number; y0: number; y1: number }[] {
  const seen = new Uint8Array(W * H);
  const out: { n: number; x0: number; x1: number; y0: number; y1: number }[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue;
    const box = { n: 0, x0: W, x1: -1, y0: H, y1: -1 };
    const stack = [start];
    seen[start] = 1;
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      const x = at % W;
      const y = (at - x) / W;
      box.n++;
      box.x0 = Math.min(box.x0, x);
      box.x1 = Math.max(box.x1, x);
      box.y0 = Math.min(box.y0, y);
      box.y1 = Math.max(box.y1, y);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const next = ny * W + nx;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || !mask[next] || seen[next]) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    out.push(box);
  }
  return out;
}

export function verifyCountrySettlements(gl: WebGL2RenderingContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const linked = program(
    gl,
    fragmentSourceFor({ ...sceneDefs.country, entry: "settleRegression", glsl: sceneDefs.country.glsl + wrapper }),
  );
  gl.canvas.width = W;
  gl.canvas.height = H;
  gl.viewport(0, 0, W, H);
  gl.useProgram(linked);
  const u = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(u("uRes"), W, H);
  gl.uniform1f(u("uTime"), 10);
  gl.uniform1f(u("uMotionTime"), 6);
  gl.uniform1f(u("uLevels"), 2);
  gl.uniform3f(u("uBg"), 0, 0, 0);
  gl.uniform3f(u("uInk"), 0, 1, 0);
  gl.uniform3f(u("uAccent"), 1, 0, 1);
  gl.uniform2f(u("uPassage"), 1, 0);
  gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
  // A still, clear afternoon, unlit windows and no smoke: what changes is the buildings alone.
  const day = { time: 0.55, clouds: 0, shadows: 0, wind: 0, fog: 0, lights: 0, smoke: 0 };
  const bare = { village: 11, hamlets: 0, castle: 0, farms: 0 };
  // accent: the dithered accent palette, where only lit windows (Shade.accent) turn magenta.
  const draw = (knobs: Record<string, number>, mode = 0, accent = false): Uint8Array => {
    gl.uniform1i(u("settleMode"), mode);
    gl.uniform1i(u("uView"), accent ? 0 : 1);
    gl.uniform1i(u("uColor"), 0);
    gl.uniform2f(u("uWeather"), 0, 0);
    const values = { ...paramDefaults("country"), ...knobs };
    gl.uniform1fv(u("uParams"), Float32Array.from(renderSettings(defaultsFor("country"), values).params));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };
  const lamps = (bytes: Uint8Array): number => {
    let n = 0;
    for (let at = 0; at < W * H; at++) if ((bytes[at * 4] ?? 0) > 0) n++;
    return n;
  };

  // Every village cottage, hamlet house and farm stands on open ground of its own ridge (never the
  // river, the track or a wood), never over the sky, and inside the footprint the API reports.
  let feet = 0;
  let built = 0;
  for (const scene of [
    { landscape: 0, woodland: 0.5 },
    { landscape: 42, woodland: 0.8 },
    { landscape: 137, woodland: 0.5 },
  ]) {
    const all = { ...day, ...scene, village: 26, hamlets: 3, farms: 1 };
    const buildings = changed(draw(all), draw({ ...day, ...scene, ...bare }));
    built += count(buildings);
    feet += footings(buildings, draw(all, 2), `landscape ${scene.landscape}`, true);
  }
  check(feet >= 60 && built >= 600, `Settlement fixture too thin: ${feet} feet, ${built} pixels`);
  result.settlementFeet = feet;

  // The village grows without moving a cottage: each size covers all a smaller one did, and more.
  const smallest = draw({ ...day, ...bare, village: 2 });
  let last: Uint8Array = new Uint8Array(W * H);
  const sizes: number[] = [];
  for (const village of [6, 11, 18, 26]) {
    const grown = changed(draw({ ...day, ...bare, village }), smallest);
    check(count(grown) > count(last), `Village ${village} covers no more than the smaller one: ${count(grown)}`);
    check(kept(last, grown) > 0.99, `Village ${village} moved cottages of the smaller one (${kept(last, grown)})`);
    sizes.push(count(grown));
    last = grown;
  }
  result.villageCoverage = sizes;
  // Its lit windows at dusk and its chimney smoke grow with it.
  const dusk = { ...bare, time: 0.8, clouds: 0, wind: 0, fog: 0 };
  const [few = 0, some = 0, many = 0] = [2, 11, 26].map((village) => lamps(draw({ ...dusk, village }, 0, true)));
  check(few < some && some < many, `Village lights do not grow with it: ${few}, ${some}, ${many}`);
  const [hamlet = 0, town = 0] = [6, 26].map((village) => {
    const still = { ...day, ...bare, village };
    return count(changed(draw({ ...still, smoke: 1 }), draw(still)));
  });
  check(hamlet > 0 && hamlet < town, `Village smoke does not grow with it: ${hamlet}, ${town}`);
  result.villageLights = [few, some, many];
  result.villageSmoke = [hamlet, town];

  // The castle: without woods to clear, it is exactly one compact group of new pixels; it rises
  // above the land's outline against the sky, and nothing under it is sky.
  const open = { ...day, ...bare, woodland: 0 };
  const castle = changed(draw({ ...open, castle: 1 }), draw(open));
  const parts = groups(castle);
  check(parts.length === 1 && (parts[0]?.n ?? 0) >= 150, `Castle is not one structure: ${JSON.stringify(parts)}`);
  const land = draw(open, 1);
  let skyline = 0;
  for (let x = 0; x < W; x++) {
    let outline = -1;
    let top = -1;
    for (let y = 0; y < H; y++) {
      if (surface(land, y * W + x).ridge !== 6) outline = y;
      if (castle[y * W + x]) top = y;
    }
    if (top > outline) skyline++;
  }
  check(skyline >= 8, `Castle does not rise against the sky: ${skyline} columns`);
  const grounded = footings(castle, land, "castle");
  result.castle = { pixels: parts[0]?.n, skylineColumns: skyline, feet: grounded };
  // In the default woodland its walls still stand on open ground: the woods clear around them.
  const castleFeet = footings(castle, draw({ ...day, ...bare, castle: 1 }, 1), "castle");
  check(castleFeet >= 10, `Castle feet not in sight: ${castleFeet}`);
  result.castleFeet = castleFeet;

  // Hamlets only ever add, and stand behind the nearer ridges: none of their pixels lies on the land
  // of ridges 0..2. (A landscape where more than one third of the view has open ground for one.)
  const quiet = { ...day, ...bare, landscape: 99 };
  const before = draw(quiet);
  const nearLand = draw(quiet, 1);
  last = new Uint8Array(W * H);
  const hamlets: number[] = [];
  for (const n of [1, 2, 3]) {
    const added = changed(draw({ ...quiet, hamlets: n }), before);
    check(count(added) >= count(last) && kept(last, added) > 0.99, `Hamlets ${n} moved or lost buildings`);
    for (let at = 0; at < W * H; at++) {
      if (added[at]) check(surface(nearLand, at).ridge >= 3, `A hamlet shows in front of ridge ${surface(nearLand, at).ridge} at ${at % W},${Math.floor(at / W)}`);
    }
    hamlets.push(count(added));
    last = added;
  }
  check((hamlets[2] ?? 0) > (hamlets[0] ?? 0), `Hamlets do not grow: ${hamlets}`);
  result.hamlets = hamlets;

  // More farms add farms and never move one; none stands on the nearest ridge. (At 0.35 the default
  // landscape shows none yet.)
  const fields = { ...day, ...bare };
  const empty = draw(fields);
  const fieldLand = draw(fields, 1);
  last = new Uint8Array(W * H);
  const farms: number[] = [];
  for (const amount of [0.6, 0.7, 1]) {
    const added = changed(draw({ ...fields, farms: amount }), empty);
    check(count(added) > count(last) && kept(last, added) > 0.99, `Farms ${amount} moved or lost buildings`);
    for (let at = 0; at < W * H; at++) {
      if (added[at]) check(surface(fieldLand, at).ridge >= 1, `A farm shows on the nearest field at ${at % W},${Math.floor(at / W)}`);
    }
    farms.push(count(added));
    last = added;
  }
  result.farms = farms;

  // At dusk, the hamlets, farms and castle light windows of their own.
  const villageOnly = lamps(draw({ ...dusk }, 0, true));
  const everyone = lamps(draw({ ...dusk, hamlets: 3, farms: 1, castle: 1 }, 0, true));
  check(everyone > villageOnly, `Settlements light no windows at dusk: ${everyone} vs ${villageOnly}`);
  result.duskLamps = { village: villageOnly, all: everyone };

  gl.deleteProgram(linked);
  return result;
}
