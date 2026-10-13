// The Chladni plate seen from above: a dark metal plate on a black cloth, lit by one low lamp, with
// the sand the simulation (sim.ts) throws into figures.
//   uSim0  sand per texel over the plate's square: R at rest, G on the move
//   uSim1  the plate's field over the same square: R the figure it comes from, G the one it goes to
//   uSim2  texel 0: eased crossfade s, norm, swing A, share of the M in the field
// Knobs read here: K_shape, K_tone, K_sand, K_lamp, K_lampHue, K_shimmer (the rest drive the sim).
import { CHLADNI_HUB, CHLADNI_MARK_SIZE, CHLADNI_MARK_Y, CHLADNI_PLATE, CHLADNI_PLATE_FIT, CHLADNI_SAND_TEXELS } from "./sim.ts";

export interface ChladniColor {
  label: string;
  color: string;
}

export interface ChladniMetal {
  label: string;
  /** The bare metal in the dim room. */
  base: string;
  /** What the metal does to the lamp's reflection. */
  sheen: string;
}

/** In `sand` knob order. */
export const chladniSands: readonly ChladniColor[] = [
  { label: "quartz", color: "#e6dcc6" },
  { label: "desert", color: "#e2ab6c" },
  { label: "salt", color: "#e4ebf2" },
  { label: "coral", color: "#eda89c" },
];

/** In `lampHue` knob order. */
export const chladniLamps: readonly ChladniColor[] = [
  { label: "amber", color: "#ff9440" },
  { label: "sea", color: "#38c9d6" },
  { label: "violet", color: "#9a6cff" },
  { label: "moon", color: "#b8cbff" },
];

/** In `tone` knob order. */
export const chladniMetals: readonly ChladniMetal[] = [
  { label: "black", base: "#08090b", sheen: "#7d8594" },
  { label: "steel", base: "#17181a", sheen: "#d6dce8" },
  { label: "brass", base: "#1c140a", sheen: "#ffcf86" },
];

/** A CSS hex colour as a GLSL vec3 literal (the pipeline works in display sRGB, as the canvas). */
function glslColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => (c / 255).toFixed(4));
  return `vec3(${channels.join(", ")})`;
}

/** A number as a GLSL float literal (GLSL ES never turns an int literal into a float). */
const glslFloat = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** `if (K_<knob> < i.5) return <colour i>;` for each choice. */
function pick(knob: string, colors: readonly string[]): string {
  return colors.map((color, i) => `  if (K_${knob} < ${i}.5) return ${glslColor(color)};`).join("\n");
}

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

vec3 chladniSandColor() {
${pick("sand", chladniSands.map((sand) => sand.color))}
  return vec3(0.9);
}

vec3 chladniLampHue() {
${pick("lampHue", chladniLamps.map((lamp) => lamp.color))}
  return vec3(1.0);
}

vec3 chladniMetal() {
${pick("tone", chladniMetals.map((metal) => metal.base))}
  return vec3(0.08);
}

vec3 chladniSheen() {
${pick("tone", chladniMetals.map((metal) => metal.sheen))}
  return vec3(0.8);
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

Shade sceneChladni(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float size = min(CHLADNI_PLATE, 0.5 * CHLADNI_PLATE_FIT * aspect);
  vec2 q = p / size;
  float px = 1.0 / (uRes.y * size);
  bool disc = K_shape > 0.5;
  float tm = t * uMotion;
  vec2 toward = CHLADNI_TOWARD_LAMP;
  vec3 hue = chladniLampHue();
  vec3 light = K_lamp > 0.0 ? hue * (0.35 + 0.85 * K_lamp) : CHLADNI_ROOM;
  // Light off the metal and the cloth keeps only a little of the lamp's colour: dim, saturated
  // light dithers into single-channel specks, so it is held well toward grey.
  vec3 soft = mix(vec3(dot(light, LUMA)), light, 0.3);
  vec4 state = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(0), 0) : vec4(0.0, 1.0, 1.0, 0.0);

  // The cloth: near black, lit a little toward the lamp, enough for the plate's soft shadow,
  // thrown down and to the right, to show on it.
  vec2 pool = p - toward * (0.9 * size);
  vec3 col = CHLADNI_CLOTH * (0.9 + 0.2 * vnoise(cell / 11.0)) + soft * 0.05 * exp(-1.4 * dot(pool, pool));
  col *= 1.0 - 0.85 * (1.0 - smoothstep(-0.05, 0.2, chladniPlateDistance(q + toward * 0.09, disc)));

  float sd = chladniPlateDistance(q, disc);
  float accent = 0.0;
  if (sd < 2.0 * px) {
    float r = length(q);
    vec2 dir = q / max(r, 1e-4);
    vec3 metal = chladniMetal();
    vec3 tint = chladniSheen();

    // One calm sheet of metal. The lamp's light falls across all of it, stronger toward the lamp:
    // the gradient that gives the plate its depth. Its grain is fine, faint and long, along the
    // brushing (straight across the square, round and round the turned disc), and shows mostly in
    // the reflection. The reflection is drawn out across the grain, as brushed metal reflects: a
    // broad, soft band to the lamp's side of the square; a soft bow-tie along the lamp's bearing
    // on the disc.
    float fall = smoothstep(-1.5, 1.3, dot(q, toward));
    float grooves;
    float band;
    if (disc) {
      grooves = vnoise(vec2(r / px * 0.3, 0.0) + dir * 1.7);
      float bearing = abs(dot(dir, toward));
      band = pow(bearing, 5.0) * smoothstep(0.0, 0.6, r) * (0.6 + 0.4 * dot(dir, toward));
    } else {
      grooves = vnoise(vec2(q.x * 1.5, q.y / px * 0.3));
      float across = (q.x + 0.5) / 0.65;
      band = exp(-across * across) * (0.55 + 0.45 * fall);
    }
    float sheen = (0.4 * fall + 0.6 * band) * (0.9 + 0.2 * grooves);

    // Where the plate swings hardest its reflection blurs into a faint glow: the shape of the tone,
    // breathing slowly, on the bare metal.
    float haze = 0.0;
    if (uSimOn.y > 0.5) {
      float nodes = float(textureSize(uSim1, 0).x);
      vec2 f = texture(uSim1, (q * 0.5 + 0.5) * ((nodes - 1.0) / nodes) + 0.5 / nodes).rg;
      float swing = abs(mix(f.r, f.g, state.x)) * state.y * state.z;
      haze = smoothstep(0.35, 1.3, swing) * K_shimmer * (0.8 + 0.2 * sin(tm * 0.7));
    }
    vec3 plate = metal * (0.75 + 0.55 * fall) * (0.95 + 0.1 * grooves) + soft * tint * (0.26 * sheen * (1.0 + 0.6 * haze) + 0.04 * haze);

    // The sand: R heaped at rest, G a veil of grains in the air, read wide so it moves smoothly.
    float heap = 0.0;
    float dust = 0.0;
    float shade = 0.0;
    vec2 slope = vec2(0.0);
    if (uSimOn.x > 0.5) {
      vec2 st = q * 0.5 + 0.5;
      float tx = 1.5 / CHLADNI_TEXELS;
      vec2 c = texture(uSim0, st).rg;
      vec2 e = texture(uSim0, st + vec2(tx, 0.0)).rg;
      vec2 w = texture(uSim0, st - vec2(tx, 0.0)).rg;
      vec2 n = texture(uSim0, st + vec2(0.0, tx)).rg;
      vec2 s = texture(uSim0, st - vec2(0.0, tx)).rg;
      heap = 1.0 - exp(-c.r / CHLADNI_HEAP);
      slope = vec2(exp(-w.r / CHLADNI_HEAP) - exp(-e.r / CHLADNI_HEAP), exp(-s.r / CHLADNI_HEAP) - exp(-n.r / CHLADNI_HEAP));
      float wide = 1.7 * tx;
      float air = 2.0 * c.g + e.g + w.g + n.g + s.g
        + texture(uSim0, st + vec2(wide, wide)).g + texture(uSim0, st + vec2(-wide, wide)).g
        + texture(uSim0, st + vec2(wide, -wide)).g + texture(uSim0, st - vec2(wide, wide)).g;
      dust = 1.0 - exp(-air / (10.0 * CHLADNI_DUST));
      // Each ridge shades the metal beside it, on the side away from the lamp.
      vec2 lampward = toward / CHLADNI_TEXELS;
      float behind = texture(uSim0, st + 2.0 * lampward).r + texture(uSim0, st + 4.0 * lampward).r;
      shade = 1.0 - exp(-0.5 * behind / CHLADNI_HEAP);
    }
    plate *= 1.0 - 0.7 * shade * (1.0 - heap);

    // A ridge is solid where the sand lies deep and breaks up into loose grains where only a few
    // lie. Each cell holds a grain once the sand there is deep enough for its own threshold, so the
    // edge is grains rather than a screen, and a cell changes at most once as sand comes and goes.
    // The thresholds stay clear of 0, so bare metal never shows a grain.
    float g1 = hash12(cell);
    float g2 = hash12(cell + 17.31);
    float g3 = hash12(cell + 53.7);
    float g4 = hash12(cell + 91.3);
    float t1 = 0.06 + 0.9 * g1;
    float t2 = 0.1 + 0.85 * g2;
    float grain = smoothstep(t1 - 0.05, t1 + 0.05, smoothstep(0.15, 0.7, heap));
    float flying = smoothstep(t2 - 0.08, t2 + 0.08, dust) * (1.0 - grain);
    // Lit on the flank toward the lamp, darker on the far one.
    float lit = clamp(0.8 + 2.4 * dot(slope, toward), 0.45, 1.3);
    vec3 sand = chladniSandColor() * (0.8 + 0.32 * g3) * lit * (g3 > 0.94 ? 0.55 : 1.0) + soft * 0.1 * max(lit - 0.9, 0.0);

    // The sand gathered into the Manifold M warms toward the lamp's colour.
    float mark = 0.0;
    if (state.w > 0.001) {
      float d = markDistance((q - vec2(0.0, CHLADNI_MARK_Y)) / CHLADNI_MARK_SIZE) * CHLADNI_MARK_SIZE;
      mark = state.w * (1.0 - smoothstep(0.03, 0.11, d));
      sand = mix(sand, sand * 0.6 + hue * 0.55, 0.5 * mark);
    }

    // A few grains of quartz catch the lamp, slowly, one at a time.
    float twinkle = 0.5 + 0.5 * sin(tm * (0.5 + 0.7 * g2) + g1 * 40.0);
    float glint = step(0.986, g4) * grain * smoothstep(0.5, 1.0, heap) * twinkle * twinkle;

    vec3 top = mix(plate, sand, grain);
    top = mix(top, chladniSandColor() * 1.08 + soft * 0.06, 0.85 * flying);
    top += (light * 0.6 + 0.3) * glint;

    // The plate's edge, bevelled: a narrow face catching the lamp on the near sides and falling
    // dark on the far ones.
    vec2 corner = abs(q) - vec2(0.96);
    vec2 outward = disc ? dir
      : corner.x > 0.0 && corner.y > 0.0 ? normalize(corner) * sign(q)
      : corner.x > corner.y ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.y));
    float facing = max(dot(outward, toward), 0.0);
    float bevel = 1.0 - smoothstep(0.5 * px, 2.5 * px, -sd);
    top = mix(top, metal * (0.55 + 0.9 * facing) + soft * tint * 0.6 * facing * (0.6 + 0.4 * fall), bevel);

    top = chladniHub(top, q, px, light);

    float cover = 1.0 - smoothstep(-px, px, sd);
    col = mix(col, top, cover);
    accent = cover * (0.6 * smoothstep(0.3, 0.95, band) * step(0.001, K_lamp) * (1.0 - max(grain, flying)) + grain * mark);
    accent *= smoothstep(CHLADNI_HUB, CHLADNI_HUB + 2.0 * px, r);
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(1.3 * dot(col, LUMA), 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  return o;
}
`;
