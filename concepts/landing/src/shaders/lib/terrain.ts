// The terrain toolbox's GLSL side (opt-in: put `terrainGlsl` in the scene's GLSL, once, ahead of the
// code that calls it): reading the four textures `packTerrain` (sims/terrain.ts) lays out, which a
// scene's sim binds to sampler slots of its choosing. Points are map metres (x east, z north), the
// map `extent` metres a side. The scene draws: its camera, its march (with whatever it stands on the
// ground, woods for one), its palette and light.
//
//   vec4 terrainGround(sampler2D ground, vec2 p, float extent)   ground, water level, d/dx, d/dz
//   vec4 terrainCover(sampler2D cover, vec2 p, float extent)     road and stream signed distance
//                                                                (metres, negative on it), the
//                                                                woods' canopy (landuse.ts packLand:
//                                                                0..1), yard 0..1 (-1 a lone
//                                                                tree's texel)
//   float terrainSurface(vec4 ground)                            what a ray meets: max(ground, water)
//   float terrainWater(vec4 ground)                              water depth (≤ 0 dry)
//   vec3 terrainNormal(vec4 ground)                              the ground's normal, smooth between
//                                                                texels (from the packed slopes)
//   TerrainParcel terrainParcel(sampler2D ids, sampler2D records, vec2 p, float extent)
//       the parcel under p: its site's id (0 none), use (LAND_*) and attribute (a crop's
//       LAND_CROP_*, a pasture's herd 1 cattle 0 sheep, a wood's species 1 pine 0 broadleaf: the
//       land model's, sims/landuse.ts), heading and stretch, and `border`, the distance (metres,
//       first order) to the parcel's edge: the nearest two sites by each site's stretched metric
//       among the eight the four texels around p list, so borders are exact lines between texels,
//       not texel steps; `normal` the unit direction across the border (toward the neighbour),
//       `other` the neighbour's id and `otherUse` its use
//   vec3 terrainCore(sampler2D records, float id)                parcel id's clear core (a herd's
//                                                                ground): centre xy, radius z
//                                                                (metres; 0 none)
//   vec4 terrainRecord(sampler2D records, int row, int column)   one record texel (TERRAIN_*_ROW)
//   vec2 terrainSplit(vec4 v)                                    a position written as two half pairs
//   TerrainBuilding terrainBuilding(sampler2D records, int i)    position, base, heading, kind, span, hash
//   TerrainPlace terrainPlace(sampler2D records, int i)          settlement i: centre, radius, buildings
//   TerrainBridge terrainBridge(sampler2D records)               the bridge (on 0: none)
//   vec3 terrainEye(sampler2D records)                           the vantage's eye (metres)
//   ivec2 terrainCounts(sampler2D records)                       settlements, buildings
//   float terrainTop(sampler2D records)                          the highest ground or water on the
//                                                                map (metres, the river full): no
//                                                                ray above it rising meets the land
//   int terrainWayCount(sampler2D records)                       roads resampled (terrainWays)
//   TerrainWay terrainWay(sampler2D records, int i)              road i: points, spacing, kind
//   vec3 terrainWayAt(sampler2D records, TerrainWay way, float s, out vec2 heading)
//       the point s metres along a road (clamped to its ends) on its surface, and its unit heading
//       on the map: between two of its evenly spaced points, so always on the road
import { LAND_CROPS, LAND_PINE_FLAG, LAND_USES } from "../../sims/landuse.ts";
import { TERRAIN_BUILDING_KINDS, TERRAIN_RECORDS } from "../../sims/terrain.ts";
import { glslFloat } from "../glsl.ts";

const kinds = (names: readonly string[], prefix: string): string =>
  names
    .map((name, index) => `const float ${prefix}_${name.toUpperCase()} = ${index}.0;`)
    .join("\n");

export const terrainGlsl = /* glsl */ `
// ---- terrain (shaders/lib/terrain.ts over sims/terrain.ts) ----
const int TERRAIN_SITES_ROW = ${TERRAIN_RECORDS.sites};
const int TERRAIN_BUILDINGS_ROW = ${TERRAIN_RECORDS.buildings};
const int TERRAIN_PLACES_ROW = ${TERRAIN_RECORDS.places};
const int TERRAIN_MISC_ROW = ${TERRAIN_RECORDS.misc};
const int TERRAIN_CORES_ROW = ${TERRAIN_RECORDS.cores};
const int TERRAIN_WAYS_ROW = ${TERRAIN_RECORDS.ways};
const int TERRAIN_POINTS_ROW = ${TERRAIN_RECORDS.points};
${kinds(LAND_USES, "LAND")}
${kinds(LAND_CROPS, "LAND_CROP")}
${kinds(TERRAIN_BUILDING_KINDS, "TERRAIN_BUILDING")}

vec4 terrainGround(sampler2D ground, vec2 p, float extent) {
  return texture(ground, p / extent);
}

vec4 terrainCover(sampler2D cover, vec2 p, float extent) {
  return texture(cover, p / extent);
}

float terrainSurface(vec4 ground) {
  return max(ground.x, ground.y);
}

float terrainWater(vec4 ground) {
  return ground.y - ground.x;
}

vec3 terrainNormal(vec4 ground) {
  return normalize(vec3(-ground.z, 1.0, -ground.w));
}

vec4 terrainRecord(sampler2D records, int row, int column) {
  return texelFetch(records, ivec2(column, row), 0);
}

vec2 terrainSplit(vec4 v) {
  return vec2(v.x + v.y, v.z + v.w);
}

struct TerrainParcel { float id; float other; float use; float attr; float otherUse; float border; vec2 normal; vec2 site; vec2 axis; float elongation; };

// Site id's stretched distance from p and its gradient: (d, dd/dx, dd/dz); fills the site's data.
vec3 terrainSiteDistance(sampler2D records, float id, vec2 p, out vec4 data, out vec2 site) {
  int s = int(id) - 1;
  int row = TERRAIN_SITES_ROW + s / 32;
  int column = 2 * (s - (s / 32) * 32);
  site = terrainSplit(terrainRecord(records, row, column));
  data = terrainRecord(records, row, column + 1);
  vec2 a = vec2(cos(data.x), sin(data.x));
  vec2 d = p - site;
  vec2 m = vec2(dot(d, a) / data.y, dot(d, vec2(-a.y, a.x)));
  float r = max(length(m), 1e-3);
  vec2 grad = (m.x / data.y * a + m.y * vec2(-a.y, a.x)) / r;
  return vec3(r, grad);
}

TerrainParcel terrainParcel(sampler2D ids, sampler2D records, vec2 p, float extent) {
  TerrainParcel parcel;
  parcel.id = 0.0;
  parcel.other = 0.0;
  parcel.use = 0.0;
  parcel.attr = 0.0;
  parcel.otherUse = 0.0;
  parcel.border = 1e3;
  parcel.normal = vec2(1.0, 0.0);
  parcel.site = vec2(0.0);
  parcel.axis = vec2(1.0, 0.0);
  parcel.elongation = 1.0;
  ivec2 size = textureSize(ids, 0);
  ivec2 base = ivec2(floor(p / extent * vec2(size) - 0.5));
  float best = 1e9;
  float next = 1e9;
  float bestId = 0.0;
  float nextId = 0.0;
  float nextUse = 0.0;
  vec2 bestGrad = vec2(0.0);
  vec2 nextGrad = vec2(0.0);
  vec4 bestData = vec4(0.0);
  vec2 bestSite = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    ivec2 at = clamp(base + ivec2(k - (k / 2) * 2, k / 2), ivec2(0), size - 1);
    vec4 t = texelFetch(ids, at, 0) * 255.0;
    // The nearest's high byte carries the land model's pine flag over its id's (LAND_PINE_FLAG).
    float high = mod(floor(t.y + 0.5), ${glslFloat(LAND_PINE_FLAG)});
    for (int c = 0; c < 2; c++) {
      float id = floor((c == 0 ? t.x + 256.0 * high : t.z + 256.0 * t.w) + 0.5);
      // The second site again would reproduce next bit for bit, so neither branch could fire: skip it too.
      if (id < 0.5 || id == bestId || id == nextId) continue;
      vec4 data;
      vec2 site;
      vec3 d = terrainSiteDistance(records, id, p, data, site);
      if (d.x < best) {
        if (bestId > 0.5) {
          next = best;
          nextGrad = bestGrad;
          nextId = bestId;
          nextUse = bestData.z;
        }
        best = d.x;
        bestId = id;
        bestGrad = d.yz;
        bestData = data;
        bestSite = site;
      } else if (d.x < next) {
        next = d.x;
        nextGrad = d.yz;
        nextId = id;
        nextUse = data.z;
      }
    }
  }
  if (bestId < 0.5) return parcel;
  parcel.id = bestId;
  parcel.other = nextId;
  parcel.otherUse = nextUse;
  parcel.use = bestData.z;
  parcel.attr = bestData.w;
  parcel.site = bestSite;
  parcel.axis = vec2(cos(bestData.x), sin(bestData.x));
  parcel.elongation = bestData.y;
  // First order: the gap between the two distances over how fast it closes, and the way across.
  vec2 closing = nextGrad - bestGrad;
  parcel.border = next < 1e8 ? (next - best) / max(length(closing), 0.05) : 1e3;
  parcel.normal = length(closing) > 1e-4 ? normalize(closing) : vec2(1.0, 0.0);
  return parcel;
}

vec3 terrainCore(sampler2D records, float id) {
  int s = int(id) - 1;
  vec2 site = terrainSplit(terrainRecord(records, TERRAIN_SITES_ROW + s / 32, 2 * (s - (s / 32) * 32)));
  vec4 core = terrainRecord(records, TERRAIN_CORES_ROW + s / 64, s - (s / 64) * 64);
  return vec3(site + core.xy, core.z);
}

// span: the long wall's length over the gable's width (TerrainBuilding.length in sims/terrain.ts:
// glslang reads a member named length as the length() method, and rejects the program).
struct TerrainBuilding { vec3 at; float facing; float kind; float span; float hash; };

TerrainBuilding terrainBuilding(sampler2D records, int i) {
  int row = TERRAIN_BUILDINGS_ROW + i / 16;
  int column = 4 * (i - (i / 16) * 16);
  vec2 xz = terrainSplit(terrainRecord(records, row, column));
  vec4 a = terrainRecord(records, row, column + 1);
  vec4 b = terrainRecord(records, row, column + 2);
  TerrainBuilding building;
  building.at = vec3(xz.x, a.x, xz.y);
  building.facing = a.y;
  building.kind = a.z;
  building.span = a.w;
  building.hash = b.x;
  return building;
}

struct TerrainPlace { vec3 at; float radius; int first; int count; };

TerrainPlace terrainPlace(sampler2D records, int i) {
  vec2 xz = terrainSplit(terrainRecord(records, TERRAIN_PLACES_ROW, 2 * i));
  vec4 a = terrainRecord(records, TERRAIN_PLACES_ROW, 2 * i + 1);
  TerrainPlace place;
  place.at = vec3(xz.x, a.x, xz.y);
  place.radius = a.y;
  place.first = int(a.z + 0.5);
  place.count = int(a.w + 0.5);
  return place;
}

struct TerrainBridge { vec2 from; vec2 to; float deck0; float deck1; float halfWidth; float water; float on; };

TerrainBridge terrainBridge(sampler2D records) {
  TerrainBridge bridge;
  bridge.from = terrainSplit(terrainRecord(records, TERRAIN_MISC_ROW, 0));
  bridge.to = terrainSplit(terrainRecord(records, TERRAIN_MISC_ROW, 1));
  vec4 a = terrainRecord(records, TERRAIN_MISC_ROW, 2);
  bridge.deck0 = a.x;
  bridge.deck1 = a.y;
  bridge.halfWidth = a.z;
  bridge.water = a.w;
  bridge.on = terrainRecord(records, TERRAIN_MISC_ROW, 4).z;
  return bridge;
}

vec3 terrainEye(sampler2D records) {
  vec2 xz = terrainSplit(terrainRecord(records, TERRAIN_MISC_ROW, 3));
  return vec3(xz.x, terrainRecord(records, TERRAIN_MISC_ROW, 4).x, xz.y);
}

ivec2 terrainCounts(sampler2D records) {
  vec4 a = terrainRecord(records, TERRAIN_MISC_ROW, 4);
  return ivec2(int(a.y + 0.5), int(a.w + 0.5));
}

int terrainWayCount(sampler2D records) {
  return int(terrainRecord(records, TERRAIN_MISC_ROW, 5).x + 0.5);
}

float terrainTop(sampler2D records) {
  return terrainRecord(records, TERRAIN_MISC_ROW, 5).y;
}

struct TerrainWay { int first; int count; float spacing; float kind; };

TerrainWay terrainWay(sampler2D records, int i) {
  vec4 a = terrainRecord(records, TERRAIN_WAYS_ROW, i);
  return TerrainWay(int(a.x + 0.5) * 64 + int(a.y + 0.5), int(a.z + 0.5), abs(a.w), a.w < 0.0 ? 1.0 : 0.0);
}

vec3 terrainWayPoint(sampler2D records, int k) {
  int row = TERRAIN_POINTS_ROW + k / 32;
  int column = 2 * (k - (k / 32) * 32);
  vec2 xz = terrainSplit(terrainRecord(records, row, column));
  return vec3(xz.x, terrainRecord(records, row, column + 1).x, xz.y);
}

vec3 terrainWayAt(sampler2D records, TerrainWay way, float s, out vec2 heading) {
  float f = clamp(s / way.spacing, 0.0, float(way.count - 1));
  int k = min(int(f), way.count - 2);
  vec3 a = terrainWayPoint(records, way.first + k);
  vec3 b = terrainWayPoint(records, way.first + k + 1);
  vec2 run = b.xz - a.xz;
  heading = length(run) > 1e-4 ? normalize(run) : vec2(1.0, 0.0);
  return mix(a, b, f - float(k));
}
`;
