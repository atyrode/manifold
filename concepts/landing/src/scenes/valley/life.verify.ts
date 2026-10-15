// GPU checks of the valley's life and its compile-time features, over the real sim's terrain
// (verify-browser.ts):
//
// `valleyLife`: through the scene's own GLSL (probe entries over valleyGlsl), every walking party
// and cart at many motion times stands on one of the generator's roads (within its half width of
// its centreline, the bridge's span included: checked against the same terrain built on the CPU),
// and every animal of every field's herd stands inside its own field, its fence's set and a body's
// length clear of the field's edge, off the roads, streams and water; the scene with all its life
// drawn is the same picture twice, stands still at motion 0 and differs from the scene without it.
//
// `valleyFeaturesAll`: the all-features program (featuresAll) draws each gated setting byte for
// byte as that setting's own program (featuresFor) does.
import {
  featureKey,
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
} from "../../shaders/index.ts";
import { generateTerrain } from "../../sims/terrain.ts";
import { valleyScene } from "./index.ts";
import { VALLEY_MAP } from "./sim.ts";
import { fnv, valleyBuild, valleyDraw, valleyProgram } from "./terrain.verify.ts";

// Probe columns and rows: parties then carts by motion time; fields by id, each herd's animals by
// motion time.
const AGENTS = 9;
const AGENT_TIMES = 64;
const FIELDS = 1024;
const HERD = 14;
const HERD_TIMES = 6;

// The probe writes per pixel, r 1 where a figure or animal is out: the figures' map position (modes
// 0 and 1: x, then z, over the map in 16 bits, g the high byte and b the low), or for the animals
// (mode 2) g 1 where it stands where it must (0.5 where not) and b its field's border.
const probeGlsl = /* glsl */ `
uniform int probeMode;
Shade probeValley(vec2 uv, vec2 cell, float t) {
  valleyWoodTh = 1.0 - 0.75 * K_woodland;
  int x = int(cell.x);
  int y = int(cell.y);
  if (probeMode < 2) {
    ValleyAgent agent;
    if (!valleyAgent(x, 3.0 + 7.31 * float(y), agent)) return shadeOf(vec3(0.0), 0.0, 0.0);
    float n = floor(clamp((probeMode == 0 ? agent.at.x : agent.at.z) / VALLEY_EXTENT, 0.0, 1.0) * 65535.0 + 0.5);
    float high = floor(n / 256.0);
    return shadeOf(vec3(1.0, high / 255.0, (n - 256.0 * high) / 255.0), 0.0, 0.0);
  }
  float id = float(x + 1);
  vec3 core = terrainCore(uSim3, id);
  if (core.z <= 0.0) return shadeOf(vec3(0.0), 0.0, 0.0);
  ValleyHerd herd = valleyHerd(id, core);
  int k = y - (y / ${HERD}) * ${HERD};
  if (float(k) >= herd.count) return shadeOf(vec3(0.0), 0.0, 0.0);
  LivestockSlot slot;
  float act;
  vec2 way;
  vec2 at = valleyHerdAnimal(herd, float(k), 1.0 + 41.3 * float(y / ${HERD}), slot, act, way);
  TerrainParcel parcel = terrainParcel(uSim2, uSim3, at, VALLEY_EXTENT);
  vec4 cover = terrainCover(uSim1, at, VALLEY_EXTENT);
  bool inside = parcel.id == id && parcel.border >= VALLEY_FENCE_SET + herd.size;
  bool clear = cover.x > 2.0 && cover.y > 0.0 && cover.w > -0.01 && terrainWater(terrainGround(uSim0, at, VALLEY_EXTENT)) < 0.0;
  return shadeOf(vec3(1.0, inside && clear ? 1.0 : 0.5, clamp(parcel.border / 100.0, 0.0, 1.0)), 0.0, 0.0);
}
`;

/**
 * The life the checks draw: flower fields, pastures with full herds, six walking parties and three
 * carts, birds (a feature's amount is `<key>-amount`).
 */
const LIFE = {
  wildflowers: 30,
  lavender: 20,
  sunflowers: 20,
  pasture: 60,
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

function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++;
  return count;
}

export function verifyValleyLife(gl: WebGL2RenderingContext): Record<string, unknown> {
  const all = sceneFeaturesAll(valleyScene);
  const built = valleyBuild(gl, LIFE);
  const probe = valleyProgram(
    gl,
    fragmentSourceFor(
      { ...valleyScene, entry: "probeValley", glsl: valleyScene.glsl + probeGlsl },
      all,
    ),
  );
  const scene = valleyProgram(gl, fragmentSourceFor(valleyScene, all));
  try {
    const result: Record<string, unknown> = {};
    const probeDraw = (mode: number, width: number, height: number): Uint8Array => {
      gl.useProgram(probe);
      gl.uniform1i(gl.getUniformLocation(probe, "probeMode"), mode);
      return valleyDraw(gl, probe, built, { ...LIFE, time: 0.5 }, { width, height });
    };
    // Walkers and carts keep to the roads the generator laid, the bridge's span included: each
    // position within its road's half width of the road's centreline (the probe's 16 bits: 5 cm).
    const terrain = generateTerrain({ seed: 0, size: VALLEY_MAP.size, extent: VALLEY_MAP.extent });
    const xs = probeDraw(0, AGENTS, AGENT_TIMES);
    const zs = probeDraw(1, AGENTS, AGENT_TIMES);
    const decode = (bytes: Uint8Array, i: number) =>
      ((256 * (bytes[4 * i + 1] ?? 0) + (bytes[4 * i + 2] ?? 0)) / 65535) * VALLEY_MAP.extent;
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
        `valley: figure ${i % AGENTS} at time sample ${Math.floor(i / AGENTS)} stands ${off.toFixed(2)} m off its road, at ${px.toFixed(1)}, ${pz.toFixed(1)}`,
      );
    }
    check(figures >= AGENTS * AGENT_TIMES * 0.9, `valley: only ${figures} figures out to check`);
    result.figures = figures;
    result.roadMargin = -farthest;
    // Every animal stays in its own field, clear of the fence, roads, streams and water.
    const herds = probeDraw(2, FIELDS, HERD * HERD_TIMES);
    let animals = 0;
    for (let i = 0; i < FIELDS * HERD * HERD_TIMES; i++) {
      if ((herds[4 * i] ?? 0) < 200) continue;
      animals++;
      check(
        (herds[4 * i + 1] ?? 0) > 200,
        `valley: an animal of field ${(i % FIELDS) + 1} (row ${Math.floor(i / FIELDS)}) strays out of its field's clear ground (border code ${herds[4 * i + 2] ?? 0})`,
      );
    }
    check(animals >= 2000, `valley: only ${animals} animals to check`);
    result.animals = animals;
    // The scene with its life: the same picture twice, still at motion 0, other than without it.
    const options = { width: 320, height: 180, motionTime: 40 };
    const life = valleyDraw(gl, scene, built, LIFE, options);
    check(
      fnv(life) === fnv(valleyDraw(gl, scene, built, LIFE, options)),
      "valley: the same frame with its life drew two different pictures",
    );
    const still = valleyDraw(gl, scene, built, LIFE, { ...options, motion: 0, time: 5 });
    check(
      differing(still, valleyDraw(gl, scene, built, LIFE, { ...options, motion: 0, time: 55 })) ===
        0,
      "valley: the scene with its life moved at motion 0",
    );
    const bare = valleyDraw(gl, scene, built, {}, options);
    result.lifePixels = differing(life, bare);
    check((result.lifePixels as number) > 200, `valley: the life drew ${result.lifePixels} pixels`);
    return result;
  } finally {
    gl.deleteProgram(probe);
    gl.deleteProgram(scene);
    built.dispose();
  }
}

/** Gated settings: each turns one or more of valleyFeatures' gates or tiers on (or off). */
const GATED: readonly Record<string, number>[] = [
  {},
  { pines: 0 },
  { roads: 0 },
  { wildflowers: 40, lavender: 30, sunflowers: 30 },
  { pasture: 50 },
  { walkers: 1, carts: 3 },
  { birds: 1 },
  { rain: 0.5, fog: 0.4 },
  { snow: 0.6 },
  { shadows: 0 },
  { moon: 0.4 },
];

export function verifyValleyFeaturesAll(gl: WebGL2RenderingContext): Record<string, unknown> {
  const built = valleyBuild(gl, {});
  const programs = new Map<string, WebGLProgram>();
  const programFor = (features: Readonly<Record<string, number>>): WebGLProgram => {
    const key = featureKey(features);
    let program = programs.get(key);
    if (!program) {
      program = valleyProgram(gl, fragmentSourceFor(valleyScene, features));
      programs.set(key, program);
    }
    return program;
  };
  try {
    const all = programFor(sceneFeaturesAll(valleyScene) ?? {});
    const options = { width: 160, height: 90, motionTime: 40 };
    GATED.forEach((knobs) => {
      const own = programFor(sceneFeatures(valleyScene, shaderValues(valleyScene, knobs)));
      const count = differing(
        valleyDraw(gl, own, built, knobs, options),
        valleyDraw(gl, all, built, knobs, options),
      );
      check(
        count === 0,
        `valley: featuresAll draws ${JSON.stringify(knobs)} other than its own program (${count} pixels)`,
      );
    });
    return { settings: GATED.length, programs: programs.size };
  } finally {
    for (const program of programs.values()) gl.deleteProgram(program);
    built.dispose();
  }
}
