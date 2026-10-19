// The water's code (src/engine/glsl.ts, the kind contract). Its hit: the level surface inside the
// outline, exactly, and past it the wet bank falling away from the waterline, marched in steps that
// cannot overshoot it. Its surface, once a cell:
//
//   - The wind's waves: a fan of ripple trains (surface.ts rippleSpectrum) along the wind 10 m over
//     the water (air.ts engineWind), longer and steeper as it blows, no longer than the water's
//     breadth lets them grow, steeper in the cat's-paws drifting downwind. Trains too fine for the
//     cell are their slope's spread: each cell draws one facet from it, a few times a second, so
//     the dither averages them into glitter, and they widen the sun's highlight. Rain rings
//     (weather.ts rainRipples) where the World rains and the cells resolve them.
//   - The core's one bounce shows the sky and the world in it, as much as water's Fresnel reflectance
//     says (Schlick, f0 0.02): little looking down into it, nearly all at a grazing view; none traced
//     within some 40 degrees of straight down, where 2% would not show. Its waves tilt the mirror,
//     never so far that it would show the water under the horizon.
//   - Under the mirror, the bed seen through the surface: the view refracted into the water to the
//     bed's depth there, the bed's sand, pebbles, silt or tiles in the sun's net of caustics, through
//     the water's colour by the path's length.
//   - At the shore, foam on the side the wind blows toward; on the bank, the bed's material wet.
//   - Frozen (with the World's cold: its season's, or the snow lying on the land; or always): ice
//     creeping in from the shore, black where clear and white where frosted, crazed with cracks.
//
// The bed and the ice are compiled options: a program holds the beds its water holds, and the ice
// only where some water is always frozen, or freezes with the cold in a World that can be cold (its
// snow on, or a dated sky: the gates the air's lying snow follows).
//
// A surface needs the World (its rain, its cold, its sun) and the view (Fresnel, refraction): the
// contract hands it neither, so it reads the World as the entry does (worldAt) and the view from the
// camera's eye (a primary ray's; seen in another object's mirror, it is worked out as from the eye).
// The core blends its bounce by the mirror share times Schlick's term of that share; the share is
// set so that the blend is water's own reflectance (waterMirrorShare).
import { WORLD_TRIGGERS } from "../../../composer/compose.ts";
import { glslFloat } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import {
  WATER_BANK_DROP,
  WATER_BANK_SLOPE,
  WATER_BEDS,
  WATER_ICE,
  WATER_KIDNEY,
  WATER_LIFT,
  WATER_POOL_CORNER,
  WATER_SHAPES,
} from "./index.ts";

/** Each bed's colour at world plan point x (bank: on the bank, above the water), from its tone. */
const BED: Readonly<Record<(typeof WATER_BEDS)[number], string>> = {
  sand: `    // Sand, rippled by the water's own motion (not on the bank).
    float grain = fbmLod(x * 3.1, foot * 3.1, 2).x;
    float marks = bank ? 0.0 : 0.08 * sin(dot(x, vec2(5.0, 3.3)) + 6.0 * tone) * smoothstep(0.25, 0.08, foot);
    return vec3(0.66, 0.57, 0.4) * (0.82 + 0.3 * grain + marks);`,
  pebbles: `    // Rounded pebbles, each its own grey, ochre or brown, dark in the gaps; their mean far off.
    vec3 mean = vec3(0.4, 0.37, 0.32);
    float size = bank ? 0.07 : 0.09;
    float seen = smoothstep(0.6, 0.3, foot / size);
    if (seen <= 0.0) return mean * (0.85 + 0.3 * tone);
    vec3 c = waterCells(x / size, 0.0);
    vec3 stone = mix(mix(vec3(0.52, 0.5, 0.47), vec3(0.6, 0.5, 0.33), smoothstep(0.4, 0.8, c.z)), vec3(0.34, 0.27, 0.2), smoothstep(0.75, 0.95, fract(c.z * 7.3)));
    stone *= 0.75 + 0.35 * fract(c.z * 13.1) - 0.45 * smoothstep(0.25, 0.0, c.y - c.x);
    return mix(mean, stone, seen) * (0.9 + 0.2 * tone);`,
  silt: `    // Dark silt, mottled, green with weed in patches.
    float grain = fbmLod(x * 3.1, foot * 3.1, 2).x;
    vec3 silt = mix(vec3(0.21, 0.19, 0.13), vec3(0.17, 0.22, 0.11), smoothstep(0.45, 0.7, tone));
    return silt * (0.8 + 0.4 * grain);`,
  tiles: `    // A pool's pale tiles and their grout; its bank the coping's stone slabs.
    float size = bank ? 0.6 : 0.2;
    vec2 g = abs(fract(x / size) - 0.5) * size;
    float grout = (1.0 - smoothstep(0.005, 0.012, min(g.x, g.y) - 0.5 * size + 0.012)) * smoothstep(0.03, 0.01, foot / size);
    vec3 face = bank ? vec3(0.66, 0.64, 0.58) : vec3(0.5, 0.74, 0.8);
    return mix(face * (0.94 + 0.12 * tone), vec3(0.8, 0.8, 0.76), grout * (bank ? 0.6 : 0.8));`,
};

const holds = (mask: number, value: number) => (mask & (1 << value)) !== 0;

export const mirror: NonNullable<KindCode["mirror"]> = () => true;

export const glsl: KindCode["glsl"] = (compiled) => {
  const beds = WATER_BEDS.flatMap((name, k) => (holds(compiled["bed"] ?? 0, k) ? [name] : []));
  const last = beds.at(-1) ?? "sand";
  const bedCode = [
    ...beds
      .slice(0, -1)
      .map((name) => `  if (bed == ${WATER_BEDS.indexOf(name)}) {\n${BED[name]}\n  }`),
    BED[last].replace(/^ {2}/gm, ""),
  ].join("\n");
  const ice = compiled["ice"] ?? 0;
  const icy = holds(ice, WATER_ICE.indexOf("frozen"))
    ? "1"
    : holds(ice, WATER_ICE.indexOf("with the cold"))
      ? "WORLD_SNOW || defined(SKY_DATE_ANCHOR)"
      : "0";
  return `
const float WATER_LIFT = ${glslFloat(WATER_LIFT)};
const float WATER_BANK_DROP = ${glslFloat(WATER_BANK_DROP)};
const float WATER_BANK_NATURAL = ${glslFloat(WATER_BANK_SLOPE.natural)};
const float WATER_BANK_POOL = ${glslFloat(WATER_BANK_SLOPE.pool)};
const float WATER_POOL_CORNER = ${glslFloat(WATER_POOL_CORNER)};
// The kidney: its band's half height, its centre line's bend and the middle's lift, of the half length.
const vec3 WATER_KIDNEY = vec3(${glslFloat(WATER_KIDNEY.half)}, ${glslFloat(WATER_KIDNEY.bend)}, ${glslFloat(WATER_KIDNEY.lift)});
const int WATER_ROUND = ${WATER_SHAPES.indexOf("round")};
const int WATER_KIDNEY_SHAPE = ${WATER_SHAPES.indexOf("kidney")};
const int WATER_POOL = ${WATER_SHAPES.indexOf("pool")};
const int WATER_TILES = ${WATER_BEDS.indexOf("tiles")};
const int WATER_BANK_STEPS = 14;
// Rain rings: metres to a drop's cell (rainRipples' unit), and how much its rings tilt the water.
const float WATER_RING_CELL = 0.3;
const float WATER_RING_TILT = 0.4;
// The caustic net's cell, metres, a seam's share of it, and the means once a seam is under a cell:
// one net's, and the two nets' blend.
const float WATER_NET_CELL = 0.42;
const float WATER_NET_SEAM = 0.09;
const float WATER_NET_ONE = 0.115;
const float WATER_NET_MEAN = 0.07;
// The cat's-paws: the breadth of the wind's puffs on the water, metres; and how often a cell draws
// another of the facets it cannot resolve, a second.
const float WATER_PAW = 6.0;
const float WATER_TWINKLE = 3.0;
// Whether any of it can be frozen in this program (see the header).
#if ${icy}
#define WATER_ICY 1
const int WATER_FROZEN = ${WATER_ICE.indexOf("frozen")};
const int WATER_OPEN = ${WATER_ICE.indexOf("open")};
#else
#define WATER_ICY 0
#endif

// The outline's half extents, metres: across (x) and front to back (z).
vec2 waterHalves(EngineObj o, int shape) {
  float a = 0.5 * waterWidth(o);
  return vec2(a, shape == WATER_ROUND ? a : 0.5 * waterLength(o));
}

// Signed distance (metres, negative inside) from plan point x of its own frame to the outline of
// shape with half extents r (index.ts waterEdge, line for line).
float waterEdge(int shape, vec2 r, vec2 x) {
  if (shape == WATER_ROUND) return length(x) - r.x;
  if (shape == WATER_POOL) return sdBox(x, r, min(WATER_POOL_CORNER, min(r.x, r.y)));
  if (shape == WATER_KIDNEY_SHAPE) {
    float u = x.x / r.x;
    float centre = WATER_KIDNEY.y * r.y * (WATER_KIDNEY.z - u * u);
    float lean = 2.0 * WATER_KIDNEY.y * r.y * u / r.x;
    return sdEllipse(vec2(x.x, x.y - centre), vec2(r.x, WATER_KIDNEY.x * r.y)) * inversesqrt(1.0 + lean * lean);
  }
  return sdEllipse(x, r);
}

float waterBankSlope(int shape) {
  return shape == WATER_POOL ? WATER_BANK_POOL : WATER_BANK_NATURAL;
}

// The bed's depth under the waterline at plan point x, metres: a pool's all over within a few
// centimetres of its walls; a pond's shelving from nothing at the shore to its depth over a shelf
// as wide as most of its narrower half.
float waterBedDepth(int shape, vec2 r, float depth, vec2 x) {
  float s = waterEdge(shape, r, x);
  if (shape == WATER_POOL) return depth * smoothstep(0.0, 0.04, -s);
  float k = clamp(-s / clamp(0.7 * min(r.x, r.y), 0.3, 60.0), 0.0, 1.0);
  float e = 1.0 - (1.0 - k) * (1.0 - k);
  return depth * e * sqrt(e);
}

float waterHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  n = vec3(0.0, 1.0, 0.0);
  part = 0.0;
  // Every surface of it lies at or below the waterline: an eye under it, or a ray rising, meets none.
  if (ro.y < WATER_LIFT || rd.y >= 0.0) return -1.0;
  float level = (WATER_LIFT - ro.y) / rd.y;
  if (level > span.y) return -1.0;
  int shape = int(waterShape(o) + 0.5);
  vec2 r = waterHalves(o, shape);
  if (level >= span.x && waterEdge(shape, r, ro.xz + rd.xz * level) <= 0.0) return level;
  // Past the outline at the waterline: down the bank, a cone falling slope per metre outward from
  // the outline, in steps that cannot overshoot it, met within the cell's footprint.
  float slope = waterBankSlope(shape);
  float lean = -rd.y + slope * length(rd.xz);
  float bottom = min(span.y, (WATER_LIFT - WATER_BANK_DROP - ro.y) / rd.y);
  float t = max(level, span.x);
  for (int i = 0; i < WATER_BANK_STEPS; i++) {
    if (t > bottom) break;
    vec3 p = ro + rd * t;
    float s = waterEdge(shape, r, p.xz);
    float d = p.y - WATER_LIFT + slope * max(s, 0.0);
    if (d < max(1e-3, 0.5 * t * engineCell)) {
      if (s > WATER_BANK_DROP / slope) return -1.0;
      float e = max(0.01, t * engineCell);
      vec2 g = vec2(
        waterEdge(shape, r, p.xz + vec2(e, 0.0)) - waterEdge(shape, r, p.xz - vec2(e, 0.0)),
        waterEdge(shape, r, p.xz + vec2(0.0, e)) - waterEdge(shape, r, p.xz - vec2(0.0, e))) / (2.0 * e);
      n = normalize(vec3(slope * g.x, 1.0, slope * g.y));
      part = 1.0;
      return t;
    }
    t += d / lean;
  }
  return -1.0;
}

// The nearest two lattice points' distances (x, y) and the nearest's hash (z) at x, in cells of a
// lattice whose points wander by t radians (Worley's F1 and F2).
vec3 waterCells(vec2 x, float t) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec3 near = vec3(8.0, 8.0, 0.0);
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = vec2(hash12(i + g), hash12(i + g + 19.1));
      float d = length(g + 0.5 + 0.45 * sin(t + TAU * o) - f);
      if (d < near.x) near = vec3(d, near.x, o.x);
      else if (d < near.y) near.y = d;
    }
  }
  return near;
}

// The seams of that lattice, 0..1, a seam seam cells wide; its mean once a seam is under a cell
// (foot: a cell's span in lattice cells), and never worked out below half a cell.
float waterSeams(vec2 x, float t, float foot, float seam, float mean) {
  float seen = smoothstep(0.5, 1.0, seam / max(foot, 1e-6));
  if (seen <= 0.0) return mean;
  vec3 c = waterCells(x, t);
  return mix(mean, 1.0 - smoothstep(0.0, seam, c.y - c.x), seen);
}

// The bed's colour (bank: its bank's, above the water) at world plan point x, foot metres a cell:
// the beds this program's water holds.
vec3 waterBedColour(int bed, vec2 x, float foot, bool bank) {
  float tone = fbmLod(x * 0.6 + 7.0, foot * 0.6, 2).x;
${bedCode}
}

// The mirror share whose blend in the core's bounce (the share times Schlick's term of it, about
// the same normal and view, cosine cosI) is reflectance f.
float waterMirrorShare(float f, float cosI) {
  float f5 = pow(1.0 - cosI, 5.0);
  float a = 1.0 - f5;
  return a < 1e-4 ? f : (sqrt(f5 * f5 + 4.0 * a * f) - f5) / (2.0 * a);
}

void waterSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  World w = worldAt(${WORLD_TRIGGERS.meteors}, ${WORLD_TRIGGERS.lightning});
  vec3 eye = engineCamera().eye;
  vec3 wp = enginePointToWorld(o, p);
  vec3 v = normalize(wp - eye);
  float foot = length(wp - eye) * engineCell;
  int shape = int(waterShape(o) + 0.5);
  vec2 r = waterHalves(o, shape);
  float inner = min(r.x, r.y);
  float s = waterEdge(shape, r, p.xz);
  int bed = int(waterBed(o) + 0.5);
  bool bank = part > 0.5;
#if WATER_ICY
  int ice = int(waterIce(o) + 0.5);
  float freeze = ice == WATER_FROZEN ? 1.0 : ice == WATER_OPEN ? 0.0 : clamp(max(w.cold, w.lying), 0.0, 1.0);
  float tone = freeze > 0.0 ? fbmLod(wp.xz * 0.35 + 3.0, foot * 0.35, 2).x : 0.5;
  // Ice: in from the shore as the cold sets in, its edge wandering, all over once it is hard frozen.
  if (!bank && freeze > 0.0 && -s < freeze * inner * (1.4 + 0.8 * (tone - 0.5))) {
    float frost = clamp(smoothstep(0.42, 0.68, tone) + 0.5 * (1.0 - smoothstep(0.2, 1.6, -s)), 0.0, 1.0);
    float cracks = waterSeams(wp.xz / 1.7, 0.0, foot / 1.7, 0.03, 0.05) + 0.5 * waterSeams(wp.xz / 0.6 + 3.1, 0.0, foot / 0.6, 0.035, 0.055) * (1.0 - frost);
    vec3 black = mix(vec3(0.04, 0.06, 0.08), vec3(0.1, 0.13, 0.15), smoothstep(0.0, 1.0, 1.0 + s / inner));
    h.albedo = mix(mix(black, vec3(0.74, 0.8, 0.86), frost), vec3(0.86, 0.9, 0.94), clamp(cracks, 0.0, 1.0));
    float cosI = max(-v.y, 0.0);
    float reflects = fresnelSchlick(cosI, 0.018, 0.0);
    h.mirror = waterMirrorShare(reflects, cosI) * (1.0 - frost) * (1.0 - clamp(cracks, 0.0, 1.0)) * smoothstep(0.0183, 0.0204, reflects);
    h.rough = mix(0.08, 0.85, frost);
    h.mat = 1;
    return;
  }
#else
  float freeze = 0.0;
  float tone = 0.5;
#endif

  // The wind 10 m over the water; the waves it raises, no longer than its breadth lets them grow,
  // steeper in the cat's-paws its puffs lay on the water and carry downwind.
  vec3 air = engineWind(vec3(wp.x, wp.y + 10.0, wp.z), uMotionTime);
  float speed = length(air.xz);
  vec2 along = speed > 1e-3 ? air.xz / speed : vec2(0.0, 1.0);
  float steep = 0.0;
  float spread = 0.0;
  float ringLight = 0.0;
  float cosI = 1.0;
  float d = 0.0;
  vec3 through = vec3(0.0);
  float tint = waterTint(o);
  // On the bank, its own bed's material; on the water, the bed where the view refracted into it lands.
  vec2 bedAt = wp.xz;
  if (!bank) {
    float longest = min(0.05 + 0.02 * speed * speed, 0.04 * pow(2.0 * inner * o.scale, 0.7));
    float paws = smoothstep(0.3, 0.75, vnoise((wp.xz - along * uMotionTime * (0.5 + 0.3 * speed)) / WATER_PAW));
    steep = (0.016 + 0.13 * smoothstep(0.5, 9.0, speed)) * (0.35 + 1.3 * paws);
    // The cell's footprint on the water: stretched along the view by its slant.
    vec2 lookDir = normalize(v.xz + vec2(1e-6, 0.0));
    float stretch = 1.0 / max(-v.y, 0.03);
    vec2 foot2 = foot * vec2(mix(1.0, stretch, lookDir.x * lookDir.x), mix(1.0, stretch, lookDir.y * lookDir.y));
    RippleFan fan = RippleFan(5, vec2(longest, 0.62), vec2(steep, 0.1 * steep), vec2(1.0, 0.0), vec2(atan(along.x, along.y), 0.0), vec3(0.55, 2.4, 0.0), 1.7, vec2(6.0, 12.0));
    vec3 waves = rippleSpectrum(wp.xz, uMotionTime, foot2, 1.0, fan);
    vec2 slope = waves.xy;
    spread = waves.z;
    if (w.rain > 0.0) {
      // Rain rings where the cells resolve their crests, 0.21 of a drop's cell apart (rainRipples'
      // 30 radians a cell); finer, they only roughen it.
      float seen = smoothstep(2.5, 5.0, 0.21 * WATER_RING_CELL / sqrt(foot2.x * foot2.y));
      if (seen > 0.0) {
        vec3 rings = rainRipples(wp.xz / WATER_RING_CELL, w.tf, clamp(1.5 * w.rain, 0.0, 1.0));
        slope += rings.xy * WATER_RING_TILT * seen;
        ringLight = rings.z * seen;
      }
      spread += 0.012 * w.rain * (1.0 - seen);
    }
    // The facets too fine for the cell: one of them, drawn from their spread, each cell its own and
    // changing a few times a second, so the dither averages the glitter they make of the sky and sun.
    vec2 cellSeed = gl_FragCoord.xy + floor(uMotionTime * WATER_TWINKLE + hash12(gl_FragCoord.xy)) * vec2(3.17, 1.93);
    slope += (vec2(hash12(cellSeed), hash12(cellSeed + 7.7)) - 0.5) * 2.45 * sqrt(spread);
    // Never tilted so far that the bounce would leave under the horizon.
    float most = 0.5 * max(-v.y, 0.0);
    float tilt = length(slope);
    if (tilt > most) slope *= most / tilt;
    vec3 nw = normalize(vec3(-slope.x, 1.0, -slope.y));
    n = engineDirToObject(o, nw);
    cosI = max(dot(nw, -v), 0.0);

    // Into the water: the view refracted down to the bed, found again where it lands; how much of
    // the bed comes through the water's colour (its tint) on the way down and back (its clarity).
    float depth = waterDepth(o);
    vec3 into = engineDirToObject(o, refract(v, nw, 1.0 / 1.333));
    float down = max(-into.y, 0.05);
    d = waterBedDepth(shape, r, depth, p.xz);
    vec2 lands = p.xz + into.xz * (d / down);
    d = waterBedDepth(shape, r, depth, lands);
    lands = p.xz + into.xz * (d / down);
    bedAt = enginePointToWorld(o, vec3(lands.x, 0.0, lands.y)).xz;
    vec3 hue = tint < 0.5 ? mix(vec3(0.9, 1.1, 2.0), vec3(1.6, 0.75, 1.1), 2.0 * tint) : mix(vec3(1.6, 0.75, 1.1), vec3(2.0, 0.8, 0.5), 2.0 * tint - 1.0);
    float clarity = waterClarity(o);
    through = exp(-hue * (d / down + d) * o.scale / mix(0.35, 10.0, clarity * clarity));
  }
  vec3 bedCol = waterBedColour(bed, bedAt, foot, bank);

  if (bank) {
    // The bank: soaked at the waterline and drying up the bank; rimed when frozen.
    float wet = 1.0 - smoothstep(0.02, 0.45, s);
    float porous = bed == WATER_TILES ? 0.15 : 0.85;
    vec3 col = bedCol * (bed == WATER_TILES ? 1.0 : 1.0 - 0.25 * wet);
    h.albedo = mix(wetten(col, wet, porous), vec3(0.8, 0.84, 0.88), 0.6 * freeze * (0.6 + 0.4 * tone));
    h.rough = mix(1.0, 0.4, wet * (1.0 - freeze));
    h.mat = 2;
    return;
  }

  // Wet under the water: darker, and no richer, its colour the water's to tint. The sun's net of
  // caustics plays on it, carried by the wind, sharp in the shallows and faint deep down, by the
  // share of the light that comes straight from the sun.
  bedCol *= 0.6;
  float sun = dot(w.sky.sunColor, LUMA) * max(w.sky.sun.y, 0.0);
  float share = sun / (sun + dot(w.sky.ambient, LUMA) + 1e-4);
  float strength = share * smoothstep(0.0, 0.04, steep) * exp(-0.35 * d * o.scale) * step(0.01, dot(through, LUMA));
  if (strength > 0.01) {
    vec2 q = (bedAt - along * uMotionTime * 0.04) / WATER_NET_CELL;
    float cell = foot / WATER_NET_CELL;
    float a = waterSeams(q, uMotionTime * 0.7, cell, WATER_NET_SEAM, WATER_NET_ONE);
    float b = waterSeams(q * 1.33 + 4.0, uMotionTime * 0.9 + 2.0, cell * 1.33, WATER_NET_SEAM, WATER_NET_ONE);
    bedCol *= 1.0 + strength * 2.6 * (a * 0.3 + b * 0.2 + a * b * 0.9 - WATER_NET_MEAN);
  }
  vec3 deep = tint < 0.5 ? mix(vec3(0.13, 0.1, 0.05), vec3(0.06, 0.15, 0.12), 2.0 * tint) : mix(vec3(0.06, 0.15, 0.12), vec3(0.04, 0.11, 0.19), 2.0 * tint - 1.0);
  vec3 col = bedCol * through + deep * (1.0 - through);

  // Foam along the shore the wind blows toward, as it freshens; the rain's crests catch the light.
  float foam = 0.0;
  if (-s < 0.6 && speed > 1.0) {
    float e = 0.05;
    vec2 g = vec2(waterEdge(shape, r, p.xz + vec2(e, 0.0)) - waterEdge(shape, r, p.xz - vec2(e, 0.0)), waterEdge(shape, r, p.xz + vec2(0.0, e)) - waterEdge(shape, r, p.xz - vec2(0.0, e)));
    vec2 outward = engineDirToWorld(o, vec3(g.x, 0.0, g.y)).xz / max(length(g), 1e-6);
    float lace = fbmLod(wp.xz * 5.0 - along * uMotionTime * 0.15, foot * 5.0, 2).x;
    float band = 1.0 - smoothstep(0.0, 0.08 + 0.3 * smoothstep(2.0, 10.0, speed), -s);
    foam = band * smoothstep(1.0, 7.0, speed) * (0.3 + 0.7 * max(dot(outward, along), 0.0)) * smoothstep(0.35, 0.6, lace + 0.25 * band);
  }
  h.albedo = mix(col + vec3(0.8, 0.85, 0.88) * ringLight, vec3(0.84, 0.87, 0.88), foam);
  // Looked down into within some 40 degrees of straight down, it reflects no more than still water's
  // 2%, too little to show: no bounce is traced there.
  float reflects = fresnelSchlick(cosI, 0.02, 0.0);
  h.mirror = waterMirrorShare(reflects, cosI) * (1.0 - foam) * smoothstep(0.0203, 0.0224, reflects);
  h.rough = clamp(0.03 + 3.0 * sqrt(spread) + foam, 0.03, 1.0);
  h.mat = 0;
}
`;
};
