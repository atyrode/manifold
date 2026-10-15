// Real-WebGL regressions for how the countryside's parts share the ground (run by verify-browser.ts):
// the settlements added to the original village (its growth, hamlets, farmsteads and the castle)
// stand on open ground, never on a track, the river's water or reeds, or a wood, whatever the river's
// width and however much of the track network shows; neither knob moves or removes a building; no
// building's footprint covers a track, a farm track or the river; and no animal stands on a track, a
// farm track or in the river. The farmsteads' farm tracks come only with the tracks, never cross the
// river, and change nothing but the ground they cover and what gives way to them.
// Each renders the actual scene (sceneCountry) against masks of the bare land from the routes' own
// API (countryRouteAt, countryRiverDistance, countrySpurAt) and the settlements'
// (countrySettlementDistance).
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { sceneDefs } from "../index.ts";
import { COUNTRY_FULL } from "./index.ts";

const W = 320;
const H = 200;

// Mode 0: the scene as drawn. Mode 1: the bare land each pixel shows, front to back over the bare
// ridges (no trees, buildings or animals): red its kind (0 open ground, 1 the river's open water or
// reeds at the river's width, 2 a track shown, within its half-width, 3 woodland or treetops, 4 a
// farm track over open ground, within its half-width), green its ridge (6: sky), blue 0.4 wherever a
// farm track is drawn, thinned or under whatever lies there, 1 where one is over the river's water
// or reeds. Mode 2: as 1, blue 1 where a track, a farm track or the river lies inside a building's
// footprint (countrySettlementDistance 0). Mode 3: the hedgerow trees rooted on a farm track (below).
const wrapper = /* glsl */ `
uniform int coherenceMode;
Shade coherenceRegression(vec2 uv, vec2 cell, float t) {
  // The scene sets the landscape's seed (countrySeed) the masks read.
  Shade scene = sceneCountry(uv, cell, t);
  if (coherenceMode == 0) return scene;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  vec2 spots = vec2(-0.2, 0.24) * aspect + countrySeed * 0.004 * aspect;
  float i = 6.0;
  float terrain = 0.0;
  for (int k = 0; k < 6; k++) {
    if (p.y < countryCrest(float(k), p.x, spots, terrain)) {
      i = float(k);
      break;
    }
  }
  if (i > 5.5) return shadeOf(vec3(0.0, 0.75, 0.0), 0.0, 0.0);
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
  float blue = 0.0;
#if COUNTRY_HAS_SPURS
  countrySpursFor(i, w.x, spots);
  vec4 spur = countrySpurAt(i, w, axis);
  // Drawn as sceneCountry draws a track: a thin one wider and fainter.
  float cells = spur.y * length(axis / vec2(countryFaceDepth(s, d), countryDownRate(s, d))) * uRes.y;
  if (spur.z > 0.0 && abs(spur.x) * min(cells / 0.7, 1.0) < 1.3 * spur.y) blue = 0.4;
  if (spur.z > 0.0 && abs(spur.x) < spur.y) {
    if (kind > 0.5 && kind < 1.5) blue = 1.0;
    if (kind < 0.5) kind = 4.0;
  }
  if (coherenceMode == 3) {
    // The hedgerow trees this pixel's field border carries (as countryTrees lays them out), with
    // countryClearing as sceneCountry sets it: red 1 where one rooted on a farm track still stands,
    // green 1 where one rooted on a farm track gives way.
    vec2 f = countryFieldSpace(i, w);
    vec2 site = vec2(0.0);
    vec2 other = vec2(0.0);
    vec2 border = vec2(0.0);
    countryCells(f, site, other, border);
    vec2 along = vec2(-border.y, border.x);
    float density = 0.3 * (1.0 - 0.8 * countrySpots(p.x, spots).x);
    countryClearing(i, w, spots);
    vec2 trees = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
      vec2 root = 0.5 * (site + other) + along * (0.3 * float(j));
      vec2 rootAxis = vec2(0.0);
      vec4 rootSpur = countrySpurAt(i, w + (root - f) / COUNTRY_FIELDS, rootAxis);
      if (i > 1.5 || hash12(floor((site + other) * 37.0) + float(j) * 3.7) > density || rootSpur.z <= 0.0 || abs(rootSpur.x) > rootSpur.y) continue;
      if (countryTreeCleared(root, f)) trees.y = 1.0;
      else trees.x = 1.0;
    }
    return shadeOf(vec3(trees, 0.0), 0.0, 0.0);
  }
#endif
  if (coherenceMode == 2) blue = (kind > 0.5 && kind < 2.5 || kind > 3.5) && countrySettlementDistance(i, w, spots) <= 0.0 ? 1.0 : 0.0;
  return shadeOf(vec3(kind / 4.0, i / 8.0, blue), 0.0, 0.0);
}`;

const KINDS = ["open ground", "the river", "a track", "woodland", "a farm track"];

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
    check(
      Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
      gl.getShaderInfoLog(shader) ?? "compile failed",
    );
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  });
  gl.linkProgram(linked);
  check(
    Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)),
    gl.getProgramInfoLog(linked) ?? "link failed",
  );
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

/** A pixel of a bare-land mask (mode 1, or mode 2 for `inside`). */
interface Land {
  kind: number;
  ridge: number;
  /** Blue 1: a farm track over the river (mode 1), the ground inside a building's footprint (mode 2). */
  inside: boolean;
  /** Blue 0.4 and up: a farm track (mode 1). */
  spur: boolean;
}

function land(mask: Uint8Array, at: number): Land {
  return {
    kind: Math.round(((mask[at * 4] ?? 0) * 4) / 255),
    ridge: Math.round(((mask[at * 4 + 1] ?? 0) * 8) / 255),
    inside: (mask[at * 4 + 2] ?? 0) > 191,
    spur: (mask[at * 4 + 2] ?? 0) > 63,
  };
}

/** The pixels of a bare-land mask where `pick` holds. */
function pixels(bare: Uint8Array, pick: (pixel: Land) => boolean): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let at = 0; at < W * H; at++) out[at] = pick(land(bare, at)) ? 1 : 0;
  return out;
}

/** mask grown by r pixels every way (a square). */
function grown(mask: Uint8Array, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let at = 0; at < W * H; at++) {
    if (!mask[at]) continue;
    const x = at % W;
    const y = Math.floor(at / W);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H) out[(y + dy) * W + x + dx] = 1;
      }
    }
  }
  return out;
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
    check(
      below.kind === 0,
      `${label}: a building on ridge ${below.ridge} stands on ${KINDS[below.kind]} at ${where(at)}`,
    );
    checked++;
  }
  return checked;
}

export function verifyCountryCoherence(gl: WebGL2RenderingContext): Record<string, unknown> {
  // Every optional part compiled in, and the same without the farm tracks: the buildings are told
  // from the farm tracks that come with them, and what a farm track changes is what tells them apart.
  const source = (features: Record<string, number>): string =>
    fragmentSourceFor(
      {
        ...sceneDefs.country,
        entry: "coherenceRegression",
        glsl: sceneDefs.country.glsl + wrapper,
      },
      features,
    );
  const spurs = program(gl, source(COUNTRY_FULL));
  const plain = program(gl, source({ ...COUNTRY_FULL, COUNTRY_HAS_SPURS: 0 }));
  gl.canvas.width = W;
  gl.canvas.height = H;
  gl.viewport(0, 0, W, H);
  for (const linked of [spurs, plain]) {
    gl.useProgram(linked);
    const u = (name: string) => gl.getUniformLocation(linked, name);
    gl.uniform2f(u("uRes"), W, H);
    gl.uniform1f(u("uTime"), 10);
    gl.uniform1f(u("uLevels"), 2);
    gl.uniform1i(u("uView"), 1);
    gl.uniform2f(u("uPassage"), 1, 0);
    gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
  }
  // A still, clear afternoon, unlit windows and no smoke: what changes is what the knobs add.
  const day = { time: 0.55, clouds: 0, shadows: 0, wind: 0, fog: 0, lights: 0, smoke: 0 };
  const draw = (
    knobs: Record<string, number>,
    mode = 0,
    motionTime = 6,
    linked = spurs,
  ): Uint8Array => {
    gl.useProgram(linked);
    const u = (name: string) => gl.getUniformLocation(linked, name);
    gl.uniform1i(u("coherenceMode"), mode);
    gl.uniform1f(u("uMotionTime"), motionTime);
    gl.uniform1fv(
      u("uParams"),
      Float32Array.from(
        renderSettings(defaultsFor("country"), { ...paramDefaults("country"), ...day, ...knobs })
          .params,
      ),
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
  // track network shown, and the same buildings stand at all of them (drawn without the farm tracks,
  // which come with the tracks).
  let feet = 0;
  let footprint = 0;
  for (const landscape of [0, 42, 137]) {
    let first: Uint8Array | undefined;
    for (const width of widths) {
      const scene = { landscape, ...width };
      const built = changed(
        draw({ ...scene, ...added }, 0, 6, plain),
        draw({ ...scene, ...original }, 0, 6, plain),
      );
      const label = `landscape ${landscape}, river ${width.river}, tracks ${width.tracks}`;
      if (first)
        check(
          first.every((v, at) => v === built[at]),
          `${label}: the buildings moved with the river or the tracks`,
        );
      first ??= built;
      feet += footings(built, draw({ ...scene, ...added }, 1, 6, plain), label);
    }
    // No footprint of theirs covers a track, a farm track or the river (the original street's own
    // excepted).
    const scene = { landscape, river: 1, tracks: 1 };
    const before = draw({ ...scene, ...original }, 2);
    const after = draw({ ...scene, ...added, castle: 1 }, 2);
    for (let at = 0; at < W * H; at++) {
      const now = land(after, at);
      if (now.kind === 1 || now.kind === 2) footprint++;
      check(
        !now.inside || land(before, at).inside,
        `landscape ${landscape}: a building's footprint covers ${KINDS[now.kind]} at ${where(at)}`,
      );
    }
  }
  check(feet >= 150, `Settlement fixture too thin: ${feet} feet`);
  check(footprint >= 1000, `Track and river fixture too thin: ${footprint} pixels`);
  result.coherenceFeet = feet;

  // The farm tracks: with the tracks they lie on open ground, never over the river, and change
  // nothing but the ground they cover and the hedgerow trees and fence rails giving way to them
  // (within a crown's height of it on screen); where nothing stands in front of one, it is drawn, and
  // every hedgerow tree rooted on one gives way. Without the tracks there are none, and nothing
  // changes.
  let farmTracks = 0;
  let drawn = 0;
  // Pixels whose field border carries a hedgerow tree rooted on a farm track (that gives way).
  let clearedTreePixels = 0;
  for (const landscape of [0, 42, 137]) {
    for (const tracks of [0.5, 1]) {
      const scene = { landscape, river: 0.5, tracks, ...added };
      const label = `landscape ${landscape}, tracks ${tracks}`;
      const bare = draw(scene, 1);
      const spur = pixels(bare, (pixel) => pixel.kind === 4);
      for (let at = 0; at < W * H; at++)
        check(!land(bare, at).inside, `${label}: a farm track crosses the river at ${where(at)}`);
      const effect = changed(draw(scene), draw(scene, 0, 6, plain));
      // Under the woods too, where it shows between the crowns.
      const near = grown(
        pixels(bare, (pixel) => pixel.spur),
        10,
      );
      for (let at = 0; at < W * H; at++)
        check(
          !effect[at] || near[at] === 1,
          `${label}: a farm track changes the scene far from it at ${where(at)}`,
        );
      // Its own farm's buildings stand in front of a farm track's end.
      const built = changed(draw(scene, 0, 6, plain), draw({ ...scene, ...original }, 0, 6, plain));
      for (let at = 0; at < W * H; at++) {
        if (!spur[at] || built[at]) continue;
        farmTracks++;
        if (effect[at]) drawn++;
      }
      const trees = draw(scene, 3);
      for (let at = 0; at < W * H; at++) {
        check(
          (trees[at * 4] ?? 0) < 128,
          `${label}: a hedgerow tree stands on a farm track at ${where(at)}`,
        );
        if ((trees[at * 4 + 1] ?? 0) > 127) clearedTreePixels++;
      }
    }
    const none = { landscape, river: 0.5, tracks: 0, ...added, crops: 50, pasture: 50, herd: 1 };
    check(
      count(changed(draw(none), draw(none, 0, 6, plain))) === 0,
      `landscape ${landscape}: farm tracks show without the tracks`,
    );
  }
  check(farmTracks >= 150, `Farm track fixture too thin: ${farmTracks} pixels`);
  check(
    drawn >= 0.85 * farmTracks,
    `Farm tracks hidden on open ground: ${drawn} of ${farmTracks} pixels drawn`,
  );
  check(clearedTreePixels > 0, "Farm track fixture has no hedgerow tree rooted on a farm track");
  result.coherenceFarmTracks = { pixels: farmTracks, drawn, clearedTreePixels };

  // The castle on the down keeps off the chalk track (without woods, whose clearing would count).
  const open = { landscape: 0, woodland: 0, tracks: 1, ...original };
  const castle = changed(draw({ ...open, castle: 1 }), draw(open));
  const castleFeet = footings(castle, draw({ ...open, castle: 1 }, 1), "castle");
  check(castleFeet >= 10, `Castle feet not in sight: ${castleFeet}`);
  result.coherenceCastleFeet = castleFeet;

  // No animal stands on a track or a farm track shown or in the river's water or reeds, at its width.
  const herds = { crops: 50, pasture: 50, herd: 1, season: 1, farms: 1 };
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
        check(
          under.kind !== 1 && under.kind !== 2 && under.kind !== 4,
          `landscape ${landscape}, river ${river}, tracks ${tracks}: an animal at ${motionTime} s stands on ${KINDS[under.kind]} at ${where(at)}`,
        );
      }
      animals += count(drawn);
    }
  }
  check(animals >= 1000, `Herd fixture too thin: ${animals} animal pixels`);
  result.coherenceAnimalPixels = animals;

  gl.deleteProgram(spurs);
  gl.deleteProgram(plain);
  return result;
}
