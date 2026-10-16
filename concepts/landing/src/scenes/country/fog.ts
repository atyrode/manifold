// The valley fog (the `fog` knob, its amount): a bank of mist lying on the valley floor with mist
// thinning upward over it, seen through along each ray rather than painted on the surface it ends at.
//
// The floor: cold air drains down the valley and pools along the river, so the bank's floor is the
// river's level along the valley, a profile the sim lays into the records once per terrain
// (packCountryFog): the river's course projected on its axis (source to mouth), and at each of
// COUNTRY_FOG.samples points along it the lowest the river has come down to by there (its level
// never rises downstream). It falls with the river, from the far hills down past the vantage; the
// coast's runs down to the sea. Off the river the floor is the river's at the same distance down the
// valley, so the valley's sides and the hills rise out of the bank. The bank is shallower up the
// valley, where the cold air drains away rather than pools.
//
// The density along a ray (countryFogDepth): the bank, full up to its top (the floor plus its depth)
// and fading over a soft margin above it (a logistic step), and the mist over it, exponential in the
// height over the floor. Both are integrated in closed form along the straight ray from the eye,
// with the floor taken linear between the eye's and the end's: the bank's through its softplus, the
// mist's through its exponential. So a ray running down into the valley crosses metres of bank and
// whitens, one that grazes a ridge and drops behind it whitens behind the crest, the trees and roofs
// standing up out of it take less, and the far land, the far ridges and the horizon's sky take the
// same integral to their own distance, so the ground's fog and the sky's meet without a seam. Patches
// (two octaves of value noise drifting down the valley and with the wind) lift and lower the bank's
// top and thicken or thin it where a ray ends, less so the farther it ends. Ground mist lies in the
// hollows above the bank too (countryFogHollow), as deep as each is sunk below the land round it.
//
// The hour and the season: the bank gathers through the night, is deepest and thickest at dawn, and
// burns off through the morning to a thin, low remnant and a light mist by day, thickening again
// from late afternoon; a cold season's weak sun burns less of it, and a thick fog outlasts the day.
// Wind and an overcast sky soften its top. Its light: the sky's and the moon's, and the sun's
// scattered forward (Henyey-Greenstein, g 0.6), so the bank glows toward a low sun and lies cool
// and grey in the hills' shadows. Dim by night: the lit windows deep in it are dimmed by it, and the
// fog round them glows with the light it scatters (their halo, buildings.ts).
//
// Compiled in only while the knob is on (COUNTRY_HAS_FOG, index.ts).
import { TERRAIN_RECORDS, type Terrain, type TerrainPacked } from "../../sims/terrain.ts";

/**
 * The fog's record in the records' misc row (TERRAIN_RECORDS: the terrain takes texels 0..5, the
 * chalk M 8..9).
 */
export const COUNTRY_FOG = {
  /** Texel column of its header: (axis x, axis z, first and last place along it, metres). */
  column: 10,
  /** The floor's levels along the axis, four a texel after the header. */
  samples: 16,
} as const;

/**
 * Write the valley floor's profile (see the header) into the records' misc row: the header, then
 * the levels. Places along the axis are measured from the map's centre.
 */
export function packCountryFog(packed: TerrainPacked, terrain: Terrain): void {
  const { x, z, level } = terrain.river;
  const count = level.length;
  const centre = 0.5 * terrain.extent;
  const dx = (x[count - 1] ?? 0) - (x[0] ?? 0);
  const dz = (z[count - 1] ?? 0) - (z[0] ?? 0);
  const length = Math.hypot(dx, dz);
  const ax = length > 1 ? dx / length : 1;
  const az = length > 1 ? dz / length : 0;
  const along = new Float32Array(count);
  let first = Infinity;
  let last = -Infinity;
  for (let k = 0; k < count; k++) {
    const s = ((x[k] ?? 0) - centre) * ax + ((z[k] ?? 0) - centre) * az;
    along[k] = s;
    first = Math.min(first, s);
    last = Math.max(last, s);
  }
  if (count === 0) {
    first = 0;
    last = 1;
  }
  const o = 4 * (TERRAIN_RECORDS.misc * TERRAIN_RECORDS.width + COUNTRY_FOG.column);
  const records = packed.records;
  records.set([ax, az, first, Math.max(last, first + 1)], o);
  const n = COUNTRY_FOG.samples;
  for (let i = 0; i < n; i++) {
    const s = first + ((last - first) * i) / (n - 1);
    let lowest = Infinity;
    for (let k = 0; k < count; k++)
      if ((along[k] ?? 0) <= s + 1e-3) lowest = Math.min(lowest, level[k] ?? 0);
    records[o + 4 + i] = Number.isFinite(lowest) ? lowest : 0;
  }
}

export const countryFogGlsl = /* glsl */ `
#if COUNTRY_HAS_FOG
// ---- the valley fog (fog.ts) ----
const int COUNTRY_FOG_COLUMN = ${COUNTRY_FOG.column};
const int COUNTRY_FOG_SAMPLES = ${COUNTRY_FOG.samples};

// This pixel's fog (countryFogSet): the bank's density (1/m), its depth over the floor and the
// softness of its top (m); the mist's density over the floor (1/m) and its scale height (m); the
// patches' drift (m); the record's header (axis, first and last place along it); the eye, the ray
// and the floor under the eye; the light the bank scatters toward the eye from the sky and moon,
// and from the sun where the sun reaches it; the mist's light.
struct CountryFog {
  float bank;
  float depth;
  float soft;
  float mist;
  float scale;
  vec2 drift;
  vec4 axis;
  vec3 eye;
  vec3 rd;
  float base;
  vec3 sky;
  vec3 sun;
  vec3 haze;
};
CountryFog countryFog;

// The valley floor under map point p (metres): the record's profile at p's place along the axis,
// linear between its samples, held at its ends.
float countryFogFloor(vec2 p) {
  vec4 axis = countryFog.axis;
  float s = dot(p - 0.5 * COUNTRY_EXTENT, axis.xy);
  float f = clamp((s - axis.z) / (axis.w - axis.z), 0.0, 1.0) * float(COUNTRY_FOG_SAMPLES - 1);
  int i = min(int(f), COUNTRY_FOG_SAMPLES - 2);
  int j = i + 1;
  float a = terrainRecord(uSim3, TERRAIN_MISC_ROW, COUNTRY_FOG_COLUMN + 1 + i / 4)[i % 4];
  float b = terrainRecord(uSim3, TERRAIN_MISC_ROW, COUNTRY_FOG_COLUMN + 1 + j / 4)[j % 4];
  return mix(a, b, f - float(i));
}

// The patches over map point p, 0..1, drifting.
float countryFogPatches(vec2 p) {
  vec2 q = p + countryFog.drift;
  return 0.65 * vnoise(q / 420.0) + 0.35 * vnoise(q / 150.0 + 5.3);
}

// log(1 + e^x), without overflow: the integral of the logistic step the bank's top fades by.
float countryFogSoftplus(float x) {
  return max(x, 0.0) + log(1.0 + exp(-abs(x)));
}

// Set this pixel's fog: the knob's amount at this hour and season, its light along the ray (world
// rd and sun), the haze (the horizon's colour in this heading). A thick fog outlasts the day.
void countryFogSet(Sky sky, vec3 eye, vec3 rd, vec3 sun, vec3 haze, float tod, float cold, float wind, float overcast, float tm) {
  float dawn = (tod - 0.26) / 0.07;
  float morning = exp(-dawn * dawn);
  float day = smoothstep(0.27, 0.45, tod) * smoothfall(0.8, 0.62, tod) * (1.0 - 0.45 * cold) * (1.0 - 0.6 * K_fog * K_fog);
  countryFog.bank = K_fog * (1.0 + 0.5 * morning) * (1.0 - 0.65 * day) / 70.0;
  countryFog.depth = (10.0 + 40.0 * K_fog * (1.0 + K_fog)) * (1.0 + 0.3 * morning) * (1.0 - 0.5 * day);
  countryFog.soft = 2.0 + countryFog.depth * (0.35 + 0.4 * abs(wind) + 0.4 * overcast);
  countryFog.mist = 2.0 * K_fog * K_fog * (1.0 + 0.6 * overcast) * (1.0 - 0.3 * day) / 1500.0;
  countryFog.scale = 100.0 + 200.0 * K_fog;
  countryFog.axis = terrainRecord(uSim3, TERRAIN_MISC_ROW, COUNTRY_FOG_COLUMN);
  // Down the valley as the cold air drains, and across the view with the wind.
  countryFog.drift = -(countryFog.axis.xy * 0.8 + countryRight.xz * 3.0 * wind) * tm;
  countryFog.eye = eye;
  countryFog.rd = rd;
  countryFog.base = countryFogFloor(eye.xz);
  float forward = 0.64 / pow(1.36 - 1.2 * dot(rd, sun), 1.5);
  countryFog.sky = sky.ambient * 1.25 + sky.moonColor * 0.55 + vec3(0.01, 0.012, 0.02);
  countryFog.sun = sky.sunColor * (0.25 + 0.2 * forward) * (1.0 - 0.7 * overcast);
  countryFog.haze = haze * 1.04 + 0.02;
}

// Optical depth from the eye to dist metres along the ray: x the bank's, y the mist's (see the
// header). The bank is shallower up the valley, where the cold air drains away rather than pools
// (by how far its floor lies above the floor under the eye); the patches at the ray's end move its
// top and density there, less the farther it lies.
vec2 countryFogDepth(float dist) {
  vec3 end = countryFog.eye + countryFog.rd * dist;
  float base = countryFogFloor(end.xz);
  float patches = mix(0.5, countryFogPatches(end.xz), exp(-dist / 2500.0));
  float w = countryFog.soft;
  float u0 = countryFog.eye.y - countryFog.base - countryFog.depth;
  float u1 = end.y - base - countryFog.depth * (0.5 + patches) * exp(-max(base - countryFog.base, 0.0) / 150.0);
  float du = u1 - u0;
  float bank = abs(du) > 0.01 * w
    ? w * (countryFogSoftplus(-u0 / w) - countryFogSoftplus(-u1 / w)) / du
    : 1.0 / (1.0 + exp(min(0.5 * (u0 + u1) / w, 80.0)));
  float h = countryFog.scale;
  float v0 = max(countryFog.eye.y - countryFog.base, 0.0);
  float v1 = max(end.y - base, 0.0);
  float dv = v1 - v0;
  float mist = abs(dv) > 0.01 * h ? h * (exp(-v0 / h) - exp(-v1 / h)) / dv : exp(-0.5 * (v0 + v1) / h);
  return dist * vec2(countryFog.bank * (0.3 + 1.4 * patches) * bank, countryFog.mist * mist);
}

// Ground mist lying in a hollow, the bank's or one above it where the cold air drains into a side
// valley, as optical depth for a ray ending at p on the land: as deep as the hollow is sunk below
// the land 70 m round it (at most a third of the bank's depth), seen through for as far as the ray
// runs down through it.
float countryFogHollow(vec3 p, float dist) {
  float r = 70.0;
  float around = 0.25 * (terrainGround(uSim0, p.xz + vec2(r, 0.0), COUNTRY_EXTENT).x + terrainGround(uSim0, p.xz - vec2(r, 0.0), COUNTRY_EXTENT).x
    + terrainGround(uSim0, p.xz + vec2(0.0, r), COUNTRY_EXTENT).x + terrainGround(uSim0, p.xz - vec2(0.0, r), COUNTRY_EXTENT).x);
  float deep = clamp(0.5 * (around - p.y), 0.0, 0.3 * countryFog.depth);
  return countryFog.bank * 0.8 * min(dist, deep / max(-countryFog.rd.y, 0.03));
}

// The fog over col, seen dist metres along the ray: lit how much of the sun reaches the bank there
// (1 in the open), more the ground mist's optical depth (countryFogHollow). Returns how much of the
// fog's colour it took.
float countryFogged(inout vec3 col, float dist, float lit, float more) {
  vec2 tau = countryFogDepth(dist);
  tau.x += more;
  float total = tau.x + tau.y;
  if (total <= 0.0) return 0.0;
  vec3 light = (tau.x * (countryFog.sky + countryFog.sun * lit) + tau.y * countryFog.haze) / total;
  float amount = 1.0 - exp(-total);
  col = mix(col, light, amount);
  return amount;
}

// How much light the fog round a settlement at map point at scatters from each lit window (its
// halo's peak, buildings.ts): with the bank's density, none above the bank's top there.
float countryFogHalo(vec3 at) {
  float base = countryFogFloor(at.xz);
  float u = at.y - base - countryFog.depth * exp(-max(base - countryFog.base, 0.0) / 150.0);
  return min(countryFog.bank * 10.0, 0.1) / (1.0 + exp(min(u / countryFog.soft, 80.0)));
}
#endif
`;
