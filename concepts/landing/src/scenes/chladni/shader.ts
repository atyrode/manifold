// The Chladni plate seen from above: a dark metal plate on a black cloth, lit by one low lamp, with
// the sand the simulation (sim.ts) throws into figures.
//   uSim0  sand per texel over the plate's square: R at rest, G on the move
//   uSim1  the plate's field over the same square: R the figure it comes from, G the one it goes to
//   uSim2  texel 0: eased crossfade s, norm, swing A, share of the M in the field; texel 1: the
//          passage (xyz) and the grain's relief (w)
//   uSim3  powder per texel over the same square, only while the grain is fine enough to hold it
// A plate fragment reads the sand 35 times (the depth and its slope share their taps, see
// chladniDepths) and the field once.
// Knobs read here: K_shape, K_tone, K_sand, K_lamp, K_lampHue, K_shimmer, K_grainSize (its look:
// the sim reads its physics); the rest drive the sim.
import { glslFloat, glslPick, glslVec3 } from "../../shaders/glsl.ts";
import {
  CHLADNI_HUB,
  CHLADNI_MARK_SIZE,
  CHLADNI_MARK_Y,
  CHLADNI_PLATE,
  CHLADNI_PLATE_FIT,
  CHLADNI_SAND_TEXELS,
} from "./sim.ts";
import { chladniLamps, chladniMetals, chladniSands } from "./constants.ts";

export const chladniGlsl = `
const float CHLADNI_PLATE = ${glslFloat(CHLADNI_PLATE)};
const float CHLADNI_PLATE_FIT = ${glslFloat(CHLADNI_PLATE_FIT)};
const float CHLADNI_MARK_Y = ${glslFloat(CHLADNI_MARK_Y)};
const float CHLADNI_MARK_SIZE = ${glslFloat(CHLADNI_MARK_SIZE)};
const float CHLADNI_HUB = ${glslFloat(CHLADNI_HUB)};
const float CHLADNI_TEXELS = ${glslFloat(CHLADNI_SAND_TEXELS)};
const vec2 CHLADNI_TOWARD_LAMP = vec2(-0.6247, 0.7809); // in the plate's plane: the lamp stands low, up and left
const vec3 CHLADNI_CLOTH = vec3(0.015, 0.015, 0.017);   // the black cloth the plate stands over
const vec3 CHLADNI_ROOM = vec3(0.3, 0.32, 0.35);        // the light when the coloured lamp is off
const vec3 CHLADNI_STEEL = vec3(0.2, 0.21, 0.23);       // the hub's washer, nut and rod
const float CHLADNI_HEAP = 2.0;                         // grains per texel to heap the sand up to cover
const float CHLADNI_DUST = 4.0;                         // grains per texel for a full veil of dancing sand
const vec3 CHLADNI_LAMP_DIR = vec3(-0.4998, 0.6247, 0.6); // unit: toward the lamp, 37 degrees above the plate

vec3 chladniSandColor() {
${glslPick(
  "sand",
  chladniSands.map((sand) => glslVec3(sand.color)),
  "vec3(0.9)",
)}
}

vec3 chladniLampHue() {
${glslPick(
  "lampHue",
  chladniLamps.map((lamp) => glslVec3(lamp.color)),
  "vec3(1.0)",
)}
}

vec3 chladniMetal() {
${glslPick(
  "tone",
  chladniMetals.map((metal) => glslVec3(metal.base)),
  "vec3(0.08)",
)}
}

vec3 chladniSheen() {
${glslPick(
  "tone",
  chladniMetals.map((metal) => glslVec3(metal.sheen)),
  "vec3(0.8)",
)}
}

// Signed distance to the plate's edge in plate units: the unit disc, or the unit square with its
// corners slightly rounded.
float chladniPlateDistance(vec2 q, bool disc) {
  if (disc) return length(q) - 1.0;
  vec2 d = abs(q) - vec2(0.96);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.04;
}

// The hub the plate is driven through, from above: a turned washer, a hex nut and the end of the
// drive's threaded rod, lit by the lamp, throwing a short shadow away from it. px is a cell in plate
// units.
vec3 chladniHub(vec3 col, vec2 q, float px, vec3 light) {
  vec2 toward = CHLADNI_TOWARD_LAMP;
  float washerR = 0.92 * CHLADNI_HUB;
  float nutR = 0.55 * CHLADNI_HUB;
  float r = length(q);
  vec2 dir = q / max(r, 1e-4);
  col *= 1.0 - 0.55 * (1.0 - smoothstep(washerR - px, washerR + 3.0 * px, length(q + toward * 0.02)));

  // The washer, turned: fine rings and a bow-tie of light along the lamp's bearing.
  float washer = 1.0 - smoothstep(washerR - px, washerR + px, r);
  float rings = vnoise(vec2(r / px * 0.8, 0.0) + dir * 2.0);
  vec3 face = CHLADNI_STEEL * (0.8 + 0.25 * rings) + light * (0.08 + 0.3 * pow(abs(dot(dir, toward)), 6.0));
  col = mix(col, face, washer);

  // The nut: a hexagon (flats at distance nutR), its chamfer lit on the facets facing the lamp.
  vec2 h = rotate(q, 0.35);
  vec2 lamp = rotate(toward, 0.35);
  vec3 sides = vec3(h.y, dot(h, vec2(0.8660254, 0.5)), dot(h, vec2(0.8660254, -0.5)));
  vec3 reach = abs(sides);
  float apothem = max(reach.x, max(reach.y, reach.z));
  vec2 normal = reach.x >= apothem ? vec2(0.0, sign(sides.x))
    : reach.y >= apothem ? vec2(0.8660254, 0.5) * sign(sides.y)
    : vec2(0.8660254, -0.5) * sign(sides.z);
  float nut = 1.0 - smoothstep(nutR - px, nutR + px, apothem);
  float chamfer = smoothstep(nutR - 1.8 * px, nutR - 0.6 * px, apothem);
  vec3 top = CHLADNI_STEEL * 1.15 + light * 0.1;
  vec3 bevel = CHLADNI_STEEL * 0.6 + light * 0.55 * max(dot(normal, lamp), 0.0);
  col = mix(col, mix(top, bevel, chamfer), nut);

  // The rod's end, a shade darker, catching a little light on its near side.
  float rod = 1.0 - smoothstep(0.5 * nutR - px, 0.5 * nutR + px, r);
  return mix(col, CHLADNI_STEEL * 0.6 + light * 0.18 * max(dot(dir, toward), 0.0), rod);
}

// Grains per texel at st, smoothed over about three texels (five taps, four of them bilinear and
// offset diagonally): the density of a ridge, wide enough to take the grain out of it.
float chladniDepth(vec2 st) {
  float o = 0.8 / CHLADNI_TEXELS;
  float sum = 2.0 * texture(uSim0, st).r
    + texture(uSim0, st + vec2(o, o)).r + texture(uSim0, st + vec2(-o, o)).r
    + texture(uSim0, st + vec2(o, -o)).r + texture(uSim0, st + vec2(-o, -o)).r;
  return sum / 6.0;
}

// chladniDepth at st and, for the ridge's slope, at st ± g along each axis (g twice the kernel's
// diagonal offset): each outer kernel's two inner diagonal taps are the middle kernel's own, so the
// five take 16 taps besides st's own (mid, read once with the dust) rather than 25. Returns the
// depth at st; sides the depths at st + (g, 0), st - (g, 0), st + (0, g) and st - (0, g).
float chladniDepths(vec2 st, float g, float mid, out vec4 sides) {
  float o = 0.8 / CHLADNI_TEXELS;
  float ne = texture(uSim0, st + vec2(o, o)).r;
  float nw = texture(uSim0, st + vec2(-o, o)).r;
  float se = texture(uSim0, st + vec2(o, -o)).r;
  float sw = texture(uSim0, st + vec2(-o, -o)).r;
  vec2 e = st + vec2(g, 0.0);
  vec2 w = st - vec2(g, 0.0);
  vec2 n = st + vec2(0.0, g);
  vec2 s = st - vec2(0.0, g);
  sides.x = (2.0 * texture(uSim0, e).r + texture(uSim0, e + vec2(o, o)).r + ne
    + texture(uSim0, e + vec2(o, -o)).r + se) / 6.0;
  sides.y = (2.0 * texture(uSim0, w).r + nw + texture(uSim0, w + vec2(-o, o)).r
    + sw + texture(uSim0, w + vec2(-o, -o)).r) / 6.0;
  sides.z = (2.0 * texture(uSim0, n).r + texture(uSim0, n + vec2(o, o)).r
    + texture(uSim0, n + vec2(-o, o)).r + ne + nw) / 6.0;
  sides.w = (2.0 * texture(uSim0, s).r + se + sw
    + texture(uSim0, s + vec2(o, -o)).r + texture(uSim0, s + vec2(-o, -o)).r) / 6.0;
  return (2.0 * mid + ne + nw + se + sw) / 6.0;
}

// The height a depth of sand heaps to: it keeps rising where the depth is already great, so a deep
// ridge stays rounded rather than flat topped.
float chladniLift(float depth) {
  return depth / (depth + 3.0);
}

// Sand of colour albedo under the lamp's light at a Lambert term of lamb: dim room light and the
// lamp's own, held toward grey (soft).
vec3 chladniSandLit(vec3 albedo, vec3 soft, float lamb) {
  return albedo * (vec3(0.2) + soft * 1.5 * lamb);
}

Shade sceneChladni(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float size = min(CHLADNI_PLATE, 0.5 * CHLADNI_PLATE_FIT * aspect);
  vec2 q = p / size;
  float px = 1.0 / (uRes.y * size);
  bool disc = K_shape > 0.5;
  float tm = uMotionTime;
  vec2 toward = CHLADNI_TOWARD_LAMP;
  vec3 hue = chladniLampHue();
  vec3 light = K_lamp > 0.0 ? hue * (0.35 + 0.85 * K_lamp) : CHLADNI_ROOM;
  // Light off the metal and the cloth keeps only a little of the lamp's colour: dim, saturated
  // light dithers into single-channel specks, so it is held well toward grey.
  vec3 soft = mix(vec3(dot(light, LUMA)), light, 0.3);
  vec4 state = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(0), 0) : vec4(0.0, 1.0, 1.0, 0.0);
  // The passage, from the sim: x the veil of strewn sand, y how far the plate has tilted (its
  // shadow lengthens), z the veil's gain for the grain count. All 0 at rest.
  vec4 stage = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(1, 0), 0) : vec4(0.0);

  // The cloth the plate stands on: near black, a pool of the lamp's light on it toward the lamp,
  // and the plate's shadow thrown down and to the right, long (the lamp is low) and soft: a wide
  // penumbra, with a tighter, darker contact shadow along the plate's own edge.
  vec2 pool = p - toward * (0.9 * size);
  float poolLight = exp(-1.2 * dot(pool, pool));
  vec3 col = CHLADNI_CLOTH * (0.9 + 0.2 * vnoise(cell / 11.0)) * (0.7 + 1.2 * poolLight) + soft * 0.17 * poolLight;
  float thrown = 1.0 - smoothstep(-0.02, 0.26, chladniPlateDistance(q + toward * (0.13 + 0.12 * stage.y), disc));
  float contact = 1.0 - smoothstep(0.0, 0.07, chladniPlateDistance(q, disc));
  col *= 1.0 - max(0.82 * thrown, 0.5 * contact);

  float sd = chladniPlateDistance(q, disc);
  float accent = 0.0;
  if (sd < 2.0 * px) {
    float r = length(q);
    vec2 dir = q / max(r, 1e-4);
    vec3 metal = chladniMetal();
    vec3 tint = chladniSheen();

    // One calm sheet of brushed metal. The lamp's light falls across all of it, stronger toward
    // the lamp: a broad gradient that gives the plate its depth. The grain is fine and long, along
    // the brushing (straight across the square, round and round the turned disc), and shows
    // mostly in the reflection. The reflection is drawn out across the grain, as brushed metal
    // reflects: a broad, soft band to the lamp's side of the square; a soft bow-tie along the
    // lamp's bearing on the disc.
    float fall = smoothstep(-1.5, 1.3, dot(q, toward));
    float grooves;
    float band;
    if (disc) {
      grooves = 0.6 * vnoise(vec2(r / px * 0.3, 0.0) + dir * 1.7) + 0.4 * vnoise(vec2(r / px * 0.9, 5.0) + dir * 3.1);
      float bearing = abs(dot(dir, toward));
      band = pow(bearing, 5.0) * smoothstep(0.0, 0.6, r) * (0.6 + 0.4 * dot(dir, toward));
    } else {
      grooves = 0.6 * vnoise(vec2(q.x * 1.5, q.y / px * 0.3)) + 0.4 * vnoise(vec2(q.x * 3.0 + 9.0, q.y / px * 0.9));
      float across = (q.x + 0.5) / 0.95;
      band = exp(-across * across) * (0.55 + 0.45 * fall);
    }
    float sheen = 0.35 * fall * fall + 0.8 * band;

    // The plate's swing at this point, from the figure it is in (0 without the field): where it
    // swings hardest its reflection blurs into a faint glow, the shape of the tone, breathing
    // slowly on the bare metal, and a few loose grains lie in those antinodes.
    float swing = 0.0;
    if (uSimOn.y > 0.5) {
      float nodes = float(textureSize(uSim1, 0).x);
      vec2 f = texture(uSim1, (q * 0.5 + 0.5) * ((nodes - 1.0) / nodes) + 0.5 / nodes).rg;
      swing = abs(mix(f.r, f.g, state.x)) * state.y * state.z;
    }
    float haze = smoothstep(0.35, 1.3, swing) * K_shimmer * (0.8 + 0.2 * sin(tm * 0.7));
    vec3 plate = metal * (0.8 + 0.6 * fall) * (0.92 + 0.16 * grooves)
      + soft * tint * (0.95 * sheen * (0.8 + 0.4 * grooves) * (1.0 + 0.6 * haze) + 0.06 + 0.05 * haze);

    // The sand: R heaped at rest, G a veil of grains in the air, read wide so it moves smoothly.
    float ridge = 0.0;
    float dust = 0.0;
    float shade = 0.0;
    float lamb = 0.6;
    float strewn = 0.0;
    float crest = 0.0;
    if (uSimOn.x > 0.5) {
      vec2 st = q * 0.5 + 0.5;
      float tx = 1.0 / CHLADNI_TEXELS;
      vec2 c = texture(uSim0, st).rg;
      // The depth here and, for the slope below, a little way off along each axis.
      float g = 1.6 * tx;
      vec4 sides;
      float depth = chladniDepths(st, g, c.r, sides);
      // The grain's relief (sim): its angle of repose over dry sand's, so grit's ridges stand steeper.
      float relief = uSimOn.z > 0.5 ? stage.w : 1.0;
      // A ridge is where the smoothed depth passes about a grain per texel: a few cells wide, with
      // one narrow ramp for the cell threshold to cut, so its edge is hard and has no loose fringe.
      ridge = smoothstep(0.7, 1.1, depth);
      // Grit heaps into rough ridges: their edge breaks up in specks two cells across.
      if (K_grainSize > 0.5) ridge = smoothstep(0.7, 1.1, depth + 0.45 * smoothstep(0.5, 1.0, K_grainSize) * (hash12(floor(cell * 0.5) + 53.7) - 0.5));
      crest = chladniLift(depth);
      // The sand's own surface: its slope from the smoothed depth, lit from the lamp. A flank that
      // faces the lamp falls away toward it.
      vec2 slope = vec2(
        chladniLift(sides.x) - chladniLift(sides.y),
        chladniLift(sides.z) - chladniLift(sides.w)
      );
      lamb = clamp(dot(normalize(vec3(-3.0 * relief * slope, 1.0)), CHLADNI_LAMP_DIR), 0.0, 1.0);
      vec2 e = texture(uSim0, st + vec2(tx, 0.0)).rg;
      vec2 w = texture(uSim0, st - vec2(tx, 0.0)).rg;
      vec2 n = texture(uSim0, st + vec2(0.0, tx)).rg;
      vec2 s = texture(uSim0, st - vec2(0.0, tx)).rg;
      float wide = 1.7 * tx;
      float air = 2.0 * c.g + e.g + w.g + n.g + s.g
        + texture(uSim0, st + vec2(wide, wide)).g + texture(uSim0, st + vec2(-wide, wide)).g
        + texture(uSim0, st + vec2(wide, -wide)).g + texture(uSim0, st - vec2(wide, wide)).g;
      dust = 1.0 - exp(-air / (10.0 * CHLADNI_DUST));
      // The veil: while the sand lies thin (strewn on the still plate, or sliding off), each grain
      // of it shows, over about three texels; heaped sand has the ridge.
      if (stage.x > 0.0) {
        vec2 around = 2.0 * c + e + w + n + s;
        strewn = stage.x * 0.8 * smoothstep(0.12, 0.8, (around.x + around.y) * stage.z / 6.0);
      }
      // Each ridge shades the metal beside it, on the side away from the lamp.
      vec2 lampward = toward * tx;
      shade = 1.0 - exp(-0.5 * relief * (chladniDepth(st + 2.0 * lampward) + chladniDepth(st + 3.6 * lampward)) / CHLADNI_HEAP);
    }
    plate *= 1.0 - 0.6 * shade * (1.0 - ridge);

    float g1 = hash12(cell);
    float g2 = hash12(cell + 17.31);
    float g3 = hash12(cell + 53.7);
    float g4 = hash12(cell + 91.3);
    float g5 = hash12(cell + 29.7);
    vec3 albedo = chladniSandColor();

    // Heaped sand: the ridge cut per cell, lit on the flank toward the lamp, shaded on the far one,
    // a little paler along the crest, each grain of the surface a touch lighter or darker. A few
    // specks lie darker.
    float body = hardEdge(ridge);
    vec3 heap = chladniSandLit(albedo, soft, lamb) * (0.82 + 0.35 * crest);
    vec3 sand = heap * (0.92 + 0.16 * g3) * (g3 > 0.95 ? 0.7 : 1.0);
    // The grain shows in the heap's surface: grit in coarse specks two cells across, some dark;
    // fine sand an even, smooth surface.
    if (K_grainSize > 0.5) {
      float gb = hash12(floor(cell * 0.5) + 53.7);
      sand = mix(sand, heap * (0.76 + 0.48 * gb) * (gb > 0.86 ? 0.55 : 1.0), smoothstep(0.5, 1.0, K_grainSize));
    } else if (K_grainSize < 0.5) {
      sand = mix(sand, heap * (0.97 + 0.06 * g3), smoothfall(0.5, 0.0, K_grainSize));
    }

    // The sand gathered into the Manifold M warms toward the lamp's colour.
    float mark = 0.0;
    if (state.w > 0.001) {
      float d = markDistance((q - vec2(0.0, CHLADNI_MARK_Y)) / CHLADNI_MARK_SIZE) * CHLADNI_MARK_SIZE;
      mark = state.w * (1.0 - smoothstep(0.03, 0.11, d));
      sand = mix(sand, sand * 0.6 + hue * 0.45, 0.5 * mark);
    }

    // Loose grains: a sparse, still sprinkling on the bare metal where the plate swings hardest.
    // Each cell holds a grain once the swing there passes its own threshold, so as the figure
    // changes a cell changes once.
    float spread = 0.05 * smoothstep(0.5, 1.2, swing) * smoothstep(1.5 * CHLADNI_HUB, 3.0 * CHLADNI_HUB, r);
    float loose = hardEdge(spread, g5) * (1.0 - body);
    vec3 looseSand = chladniSandLit(albedo, soft, 0.62) * (0.85 + 0.3 * g1);

    // Sand in the air, over metal and heap alike: each cell holds a grain once the veil is thick
    // enough for its own threshold.
    float flying = hardEdge(dust, 0.1 + 0.85 * g2) * (1.0 - body);
    vec3 flyingSand = chladniSandLit(albedo, soft, 0.7);

    // Strewn sand (the passage's veil, absent at rest): single grains where the sand lies thin, each
    // cell holding one once the smoothed density passes its own threshold.
    float strewnCell = strewn > 0.0 ? hardEdge(strewn, hash12(cell + 7.7)) * (1.0 - body) : 0.0;

    // A few grains of quartz catch the lamp, slowly, one at a time, only on the lamp's flank.
    float twinkle = 0.5 + 0.5 * sin(tm * (0.5 + 0.7 * g2) + g1 * 40.0);
    float glint = step(0.986, g4) * body * smoothstep(0.62, 0.9, lamb) * twinkle * twinkle;

    float grainy = max(loose, strewnCell);
    vec3 top = mix(plate, looseSand, grainy);
    top = mix(top, flyingSand, 0.85 * flying);
    // Powder (the grain knob's fine end, uSim3): the dust the plate's air heaps where it swings
    // hardest, in pale, soft mounds; each cell holds some once the mound is deep enough for its own
    // threshold, so their edges fray into single motes.
    if (uSimOn.w > 0.5) {
      float motes = texture(uSim3, q * 0.5 + 0.5).r;
      float dusted = hardEdge(smoothstep(0.2, 2.5, motes), hash12(cell + 41.3)) * (1.0 - body);
      vec3 pale = chladniSandLit(mix(albedo, vec3(0.92), 0.55), soft, 0.62 + 0.12 * smoothstep(1.0, 6.0, motes));
      top = mix(top, pale * (0.94 + 0.12 * g1), dusted);
    }
    top = mix(top, sand, body);
    top += (light * 0.6 + 0.3) * glint;

    // The plate's edge, bevelled: a narrow face catching the lamp on the near sides, with a bright
    // line along its rim, and falling dark on the far ones. Its inner edge is cut per cell.
    vec2 corner = abs(q) - vec2(0.96);
    vec2 outward = disc ? dir
      : corner.x > 0.0 && corner.y > 0.0 ? normalize(corner) * sign(q)
      : corner.x > corner.y ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.y));
    float facing = dot(outward, toward);
    float lit = max(facing, 0.0);
    float away = max(-facing, 0.0);
    float bevel = hardEdge(1.0 - smoothstep(5.0 * px, 7.0 * px, -sd));
    float rim = 1.0 - smoothstep(0.8 * px, 2.2 * px, -sd);
    vec3 edge = metal * (0.55 + 0.9 * lit) * (1.0 - 0.5 * away)
      + soft * tint * ((0.1 + 0.9 * lit) * (0.6 + 0.4 * fall) + 0.5 * lit * rim);
    top = mix(top, edge, bevel);

    top = chladniHub(top, q, px, light);

    float cover = softFill(sd, px);
    col = mix(col, top, cover);
    accent = cover * (0.6 * smoothstep(0.3, 0.95, band) * step(0.001, K_lamp) * (1.0 - max(body, flying)) + body * mark);
    accent *= smoothstep(CHLADNI_HUB, CHLADNI_HUB + 2.0 * px, r);
  }

  return shadeOf(col, inkOf(col, 1.3, 1.0), clamp(accent, 0.0, 1.0));
}
`;
