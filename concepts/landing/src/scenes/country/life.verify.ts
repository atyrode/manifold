// GPU check of the countryside's life, over the real sim's terrain (verify-browser.ts,
// `countryLife`): through the scene's own GLSL (probe entries over countryGlsl), every walking party
// and cart at many motion times stands on one of the generator's roads (within its half width of
// its centreline, the bridge's span included: checked against the same terrain built on the CPU),
// and every animal of every pasture's herd (the land model's pastures, read from their records)
// stands inside its own parcel, its fence's set and a body's length clear of the parcel's edge, off
// the roads, streams and water and out of the woods; the scene with all its life drawn is the same
// picture twice, stands still at motion 0 and differs from the scene without it.
import { fragmentSourceFor, sceneFeaturesAll } from "../../shaders/index.ts";
import { generateTerrain } from "../../sims/terrain.ts";
import { countryScene } from "./index.ts";
import { COUNTRY_MAP } from "./sim.ts";
import { countryBuild, countryDraw, countryProgram, differing, fnv } from "./terrain.verify.ts";

// Probe columns and rows: parties then carts by motion time; parcels by id, each pasture's animals
// by motion time.
const AGENTS = 9;
const AGENT_TIMES = 64;
const FIELDS = 1024;
const HERD = 14;
const HERD_TIMES = 6;

// The probe writes per pixel, r 1 where a figure or animal is out: the figures' map position (modes
// 0 and 1: x, then z, over the map in 16 bits, g the high byte and b the low), or for the animals
// (mode 2) g 1 where it stands where it must (0.5 where not) and b its parcel's border.
const probeGlsl = /* glsl */ `
uniform int probeMode;
Shade probeCountry(vec2 uv, vec2 cell, float t) {
  int x = int(cell.x);
  int y = int(cell.y);
  if (probeMode < 2) {
    CountryAgent agent;
    if (!countryAgent(x, 3.0 + 7.31 * float(y), agent)) return shadeOf(vec3(0.0), 0.0, 0.0);
    float n = floor(clamp((probeMode == 0 ? agent.at.x : agent.at.z) / COUNTRY_EXTENT, 0.0, 1.0) * 65535.0 + 0.5);
    float high = floor(n / 256.0);
    return shadeOf(vec3(1.0, high / 255.0, (n - 256.0 * high) / 255.0), 0.0, 0.0);
  }
  float id = float(x + 1);
  countryWoodsSet();
  vec4 data = terrainRecord(uSim3, TERRAIN_SITES_ROW + x / 32, 2 * (x - (x / 32) * 32) + 1);
  vec4 core = terrainCore(uSim3, id);
  if (floor(data.z + 0.5) != LAND_PASTURE || core.z <= 0.0) return shadeOf(vec3(0.0), 0.0, 0.0);
  CountryHerd herd = countryHerd(id, core, data.w);
  int k = y - (y / ${HERD}) * ${HERD};
  if (float(k) >= herd.count) return shadeOf(vec3(0.0), 0.0, 0.0);
  LivestockSlot slot;
  float act;
  vec2 way;
  vec2 at = countryHerdAnimal(herd, float(k), 1.0 + 41.3 * float(y / ${HERD}), slot, act, way);
  TerrainParcel parcel = terrainParcel(uSim2, uSim3, at, COUNTRY_EXTENT);
  vec4 cover = terrainCover(uSim1, at, COUNTRY_EXTENT);
  bool inside = parcel.id == id && parcel.border >= COUNTRY_FENCE_SET + herd.size;
  float water = terrainWater(terrainGround(uSim0, at, COUNTRY_EXTENT));
  bool clear = cover.x > 2.0 && cover.y > 0.0 && cover.w > -0.01 && water < 0.0 && countryWoods(cover, water, false) < 0.5;
  return shadeOf(vec3(1.0, inside && clear ? 1.0 : 0.5, clamp(parcel.border / 100.0, 0.0, 1.0)), 0.0, 0.0);
}
`;

/**
 * The life the checks draw: flower fields, pastures with full herds, six walking parties and three
 * carts, birds (a feature's amount is `<key>-amount`).
 */
const LIFE = {
  wildflowers: 1,
  "wildflowers-amount": 30,
  lavender: 1,
  sunflowers: 1,
  pasture: 1,
  "pasture-amount": 60,
  herd: 1,
  walkers: 1,
  "walkers-amount": 1,
  carts: 1,
  "carts-amount": 3,
  birds: 1,
};

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

export function verifyCountryLife(gl: WebGL2RenderingContext): Record<string, unknown> {
  const all = sceneFeaturesAll(countryScene);
  const built = countryBuild(gl, LIFE);
  const probe = countryProgram(
    gl,
    fragmentSourceFor(
      { ...countryScene, entry: "probeCountry", glsl: countryScene.glsl + probeGlsl },
      all,
    ),
  );
  const scene = countryProgram(gl, fragmentSourceFor(countryScene, all));
  try {
    const result: Record<string, unknown> = {};
    const probeDraw = (mode: number, width: number, height: number): Uint8Array => {
      gl.useProgram(probe);
      gl.uniform1i(gl.getUniformLocation(probe, "probeMode"), mode);
      return countryDraw(gl, probe, built, { ...LIFE, time: 0.5 }, { width, height });
    };
    // Walkers and carts keep to the roads the generator laid, the bridge's span included: each
    // position within its road's half width of the road's centreline (the probe's 16 bits: 5 cm).
    const terrain = generateTerrain({
      seed: 0,
      size: COUNTRY_MAP.size,
      extent: COUNTRY_MAP.extent,
    });
    const xs = probeDraw(0, AGENTS, AGENT_TIMES);
    const zs = probeDraw(1, AGENTS, AGENT_TIMES);
    const decode = (bytes: Uint8Array, i: number) =>
      ((256 * (bytes[4 * i + 1] ?? 0) + (bytes[4 * i + 2] ?? 0)) / 65535) * COUNTRY_MAP.extent;
    let figures = 0;
    let farthest = -Infinity;
    for (let i = 0; i < AGENTS * AGENT_TIMES; i++) {
      if ((xs[4 * i] ?? 0) < 200) continue;
      figures++;
      const px = decode(xs, i);
      const pz = decode(zs, i);
      // How far outside its road's edge the nearest road leaves it (negative: on it).
      let off = Infinity;
      for (const road of terrain.roads) {
        for (let k = 0; k + 1 < road.x.length; k++) {
          const ax = road.x[k] ?? 0;
          const az = road.z[k] ?? 0;
          const dx = (road.x[k + 1] ?? 0) - ax;
          const dz = (road.z[k + 1] ?? 0) - az;
          const f = Math.max(
            0,
            Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)),
          );
          off = Math.min(off, Math.hypot(px - ax - f * dx, pz - az - f * dz) - road.halfWidth);
        }
      }
      farthest = Math.max(farthest, off);
      check(
        off <= 0,
        `country: figure ${i % AGENTS} at time sample ${Math.floor(i / AGENTS)} stands ${off.toFixed(2)} m off its road, at ${px.toFixed(1)}, ${pz.toFixed(1)}`,
      );
    }
    check(figures >= AGENTS * AGENT_TIMES * 0.9, `country: only ${figures} figures out to check`);
    result.figures = figures;
    result.roadMargin = -farthest;
    // Every animal stays in its own parcel, clear of the fence, roads, streams, water and woods.
    const herds = probeDraw(2, FIELDS, HERD * HERD_TIMES);
    let animals = 0;
    for (let i = 0; i < FIELDS * HERD * HERD_TIMES; i++) {
      if ((herds[4 * i] ?? 0) < 200) continue;
      animals++;
      check(
        (herds[4 * i + 1] ?? 0) > 200,
        `country: an animal of parcel ${(i % FIELDS) + 1} (row ${Math.floor(i / FIELDS)}) strays out of its parcel's clear ground (border code ${herds[4 * i + 2] ?? 0})`,
      );
    }
    check(animals >= 2000, `country: only ${animals} animals to check`);
    result.animals = animals;
    // The scene with its life: the same picture twice, still at motion 0, other than without it.
    const options = { width: 320, height: 180, motionTime: 40 };
    const life = countryDraw(gl, scene, built, LIFE, options);
    check(
      fnv(life) === fnv(countryDraw(gl, scene, built, LIFE, options)),
      "country: the same frame with its life drew two different pictures",
    );
    const still = countryDraw(gl, scene, built, LIFE, { ...options, motion: 0, time: 5 });
    check(
      differing(still, countryDraw(gl, scene, built, LIFE, { ...options, motion: 0, time: 55 })) ===
        0,
      "country: the scene with its life moved at motion 0",
    );
    const bare = countryDraw(gl, scene, built, {}, options);
    result.lifePixels = differing(life, bare);
    check(
      (result.lifePixels as number) > 200,
      `country: the life drew ${result.lifePixels} pixels`,
    );
    return result;
  } finally {
    gl.deleteProgram(probe);
    gl.deleteProgram(scene);
    built.dispose();
  }
}
