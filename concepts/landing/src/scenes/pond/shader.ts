// The pond's layers' GLSL (layers.ts), under the overhead composer (composer/overhead-glsl.ts):
// the floor (pondBed), the water and what floats on it (pondWater), the Manifold stone (stone), the
// border plants and canopy (border), the koi (koi). The koi are drawn with the shared fish
// (sims/fish.ts); while they are drawn to the pointer the sim steers them (koi.ts). The border plants
// come drawn in the plant sheet (borderField0, sims/plantsheet.ts), coloured here by material, and
// turned by the year with the plant component's colours (shaders/lib/plants.ts). The floor's
// caustics are the shared water's cellular net, carried by the current (its caustics tier,
// shaders/caustics.ts and shaders/lib/water.ts); the floor is seen through the drop rings' slope, as
// far as the water is deep, and the sun glints on them with the shared glint (waterGlint). Where
// the pads and the petals are comes from the water's layout pass (pondWaterField0), where the koi on
// their loops from the koi's (koiField1, layout.ts). Each pass keeps the scene's painter's order and
// its arithmetic, so the composed pond draws as the scene drew.
import type { OverheadRig, SharedGlsl } from "../../composer/types.ts";
import { fishGlsl } from "../../sims/fish.ts";
import { plantSheetGlsl } from "../../sims/plantsheet.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { plantsGlsl } from "../../shaders/lib/plants.ts";
import { CANOPY_MARGIN } from "./atlas.ts";
import { POND_PASSAGE } from "./constants.ts";

/** The most lily pads, koi and petals the pond draws (the layout's rows run to the widest). */
export const POND_LAYOUT = { pads: 9, koi: 8, petals: 18 } as const;

/**
 * Where the pads, the koi on their loops and the petals are this frame: the same for every pixel.
 * The layout passes (layout.ts) work it out once a frame, the water's pads and petals into its
 * field, the koi's loops into theirs; the layers read them there, and work them out per pixel with
 * these same functions only where float targets are missing (the field off), so both draw byte for
 * byte alike. Reads passageIn(), passageOut(), hash12, vnoise and TAU.
 */
export const pondLayoutGlsl = `
// Passage, in seconds (POND_PASSAGE).
const float POND_ENTER = ${glslFloat(POND_PASSAGE.enter)};
const float POND_EXIT = ${glslFloat(POND_PASSAGE.exit)};

// Smooth looping swim path for koi number i at path time s (mirrored for steering in koi.ts).
vec2 pondKoiPath(float i, float s, float aspect) {
  float a = 0.13 + 0.07 * hash12(vec2(i, 1.0));
  float b = 0.11 + 0.08 * hash12(vec2(i, 2.0));
  float ph = hash12(vec2(i, 3.0)) * TAU;
  return vec2(
    sin(s * a + ph) * 0.42 * aspect + sin(s * a * 2.3 + ph * 1.7) * 0.12,
    sin(s * b + ph * 0.7) * 0.34 + cos(s * b * 1.9 + ph) * 0.1
  );
}

// Koi i on its loop at swimTime: where it is (xy) and its path's step over 0.1 of path time (zw),
// whose direction is its heading.
vec4 pondKoiSwim(float fi, float swimTime, float aspect) {
  float s = swimTime + fi * 11.0;
  return vec4(pondKoiPath(fi, s, aspect), pondKoiPath(fi, s + 0.05, aspect) - pondKoiPath(fi, s - 0.05, aspect));
}

// Lily pad i: centre (xy) and radius (z); 'anchor' is where its stem is rooted in the floor.
// Tethered pads lean downstream as far as the stem allows; untethered ones are carried along.
vec3 pondPadState(float fi, float aspect, float tm, vec2 flow, float turbulence, float placement, float wander, bool tethered, out vec2 anchor) {
  anchor = (vec2(hash12(vec2(fi, 21.0 + placement * 1.37)), hash12(vec2(fi, 22.0 + placement * 1.91))) - 0.5) * vec2(aspect * 0.9, 0.85);
  float radius = 0.045 + 0.05 * hash12(vec2(fi, 23.0 + placement));
  vec2 roam = wander > 0.0
    ? vec2(sin(tm * wander * 0.11 + fi * 1.7), cos(tm * wander * 0.083 + fi * 2.3)) * 0.15
    : vec2(sin(tm * 0.07 + fi), cos(tm * 0.05 + fi * 2.0)) * 0.012;
  vec2 eddy = (vec2(vnoise(vec2(tm * 0.35 + fi * 3.1, 1.0)), vnoise(vec2(tm * 0.35 + fi * 3.1, 9.0))) - 0.5) * turbulence * 0.12 * (0.3 + length(flow) * 2.0);
  if (tethered) {
    float stem = radius * 1.4 + 0.03;
    vec2 push = flow * 0.35 + roam + eddy;
    return vec3(anchor + push / (1.0 + length(push) / stem), radius);
  }
  vec2 span = vec2(aspect * 1.15, 1.15);
  vec2 travelled = anchor + flow * tm * 0.05 + roam + eddy;
  return vec3(mod(travelled + span * 0.5, span) - span * 0.5, radius);
}

// A lily pad's drift while the scene passes: settling in from a little way off (moving from the
// start, done by 2.7 s), then carried off downwind with the breeze, gathering speed.
vec2 pondPadPassage(float fi) {
  float settle = 1.0 - clamp(passageIn() * POND_ENTER / 2.7, 0.0, 1.0);
  float bearing = hash12(vec2(fi, 73.0)) * TAU;
  float gust = passageOut() * passageOut();
  return vec2(cos(bearing), sin(bearing)) * (0.04 + 0.04 * hash12(vec2(fi, 74.0))) * settle * settle
    + vec2(0.9, 0.4) * (0.02 + 0.02 * hash12(vec2(fi, 75.0))) * gust;
}

// The first 'pads' lily pads (centre, radius; their stems' roots): where each wants to float, then
// two passes pushing overlapping pairs apart, so pads crowded by the current just touch and nudge
// rather than stack.
void pondPads(int pads, float aspect, float tm, vec2 flow, float turbulence, float placement, float wander, bool tethered, out vec3 padAt[${POND_LAYOUT.pads}], out vec2 padRoot[${POND_LAYOUT.pads}]) {
  for (int i = 0; i < ${POND_LAYOUT.pads}; i++) {
    if (i >= pads) break;
    vec2 anchor;
    padAt[i] = pondPadState(float(i), aspect, tm, flow, turbulence, placement, wander, tethered, anchor);
    padAt[i].xy += pondPadPassage(float(i));
    padRoot[i] = anchor;
  }
  for (int pass = 0; pass < 2; pass++) {
    for (int i = 0; i < ${POND_LAYOUT.pads}; i++) {
      if (i >= pads) break;
      for (int j = 0; j < ${POND_LAYOUT.pads}; j++) {
        if (j >= pads) break;
        if (j <= i) continue;
        vec2 gap = padAt[j].xy - padAt[i].xy;
        float apart = length(gap);
        float touching = (padAt[i].z + padAt[j].z) * 0.97;
        if (apart < touching) {
          vec2 away = apart > 1e-4 ? gap / apart : vec2(1.0, 0.0);
          vec2 push = away * (touching - apart) * 0.5;
          padAt[i].xy -= push;
          padAt[j].xy += push;
        }
      }
    }
  }
}

// Whether lily pad i carries a flower.
bool pondPadFlower(float fi, float placement) {
  return hash12(vec2(fi, 24.0 + placement)) > 0.6;
}

// Petal i of those riding the current over a pond 'span' wide, recycled when it leaves: where it is
// (xy) and how far it has turned (z).
vec3 pondPetal(float fi, vec2 span, vec2 flow, float tm, float turbulence) {
  vec2 start = (vec2(hash12(vec2(fi, 51.0)), hash12(vec2(fi, 52.0))) - 0.5) * span;
  vec2 eddy = (vec2(vnoise(vec2(tm * 0.5 + fi, 3.0)), vnoise(vec2(tm * 0.5 + fi, 8.0))) - 0.5) * turbulence * 0.1;
  vec2 at = mod(start + flow * tm * (0.07 + 0.03 * hash12(vec2(fi, 53.0))) + eddy + span * 0.5, span) - span * 0.5;
  return vec3(at, tm * (0.6 + hash12(vec2(fi, 54.0))) + fi);
}
`;

/** What the pond's layers share: the passage's seconds and the layout's functions. */
export const pondSharedGlsl: SharedGlsl<OverheadRig> = {
  id: "pond",
  glsl: () => pondLayoutGlsl,
};

/** The floor and the weed on it. */
export const pondBedGlsl = `
// Pebble floor: cells with dark seams, each stone its own shade. Returns brightness.
float pondBedPebbles(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  float shade = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = 0.15 + 0.7 * vec2(hash12(i + g + 3.1), hash12(i + g + 8.7));
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; shade = hash12(i + g + 1.3); } else if (d < f2) { f2 = d; }
    }
  }
  return smoothstep(0.02, 0.12, f2 - f1) * (0.35 + 0.65 * shade) * (1.0 - 0.5 * f1);
}
// The floor: pebbles or silt with moss between, dimmer when deep, seen through the water where its
// surface bends it (x.floorP). 'col' is the full-colour picture; ink and accent coverage carry the
// same layers for the accent and mono palettes.
void pondBedFloor(Patch x, inout Spot c) {
  vec2 floorP = x.floorP;
  float depth = x.depth;
  int bed = int(K_floorType + 0.5);
  float grain = mix(1.6, 0.6, K_grain);
  vec3 tint = mix(vec3(0.42, 0.47, 0.5), vec3(0.62, 0.5, 0.34), 0.5 + 0.5 * K_floorTint);
  float stones;
  if (bed == 0) {
    stones = pondBedPebbles(floorP * 22.0 * grain);
  } else if (bed == 1) {
    // River stones: big and smooth.
    stones = pondBedPebbles(floorP * 8.0 * grain) * 1.15;
  } else if (bed == 2) {
    // Sand with ripple marks.
    float marks = 0.5 + 0.5 * sin((floorP.x * 0.6 + floorP.y) * 90.0 * grain + fbm(floorP * 6.0) * 6.0);
    stones = 0.5 + 0.28 * marks + 0.15 * fbm(floorP * 40.0);
    tint = mix(tint, vec3(0.9, 0.78, 0.55), 0.7);
  } else if (bed == 3) {
    // Laid slate: offset rows of tiles with dark joints.
    vec2 g = floorP * 7.0 * grain;
    g.x += step(1.0, mod(floor(g.y), 2.0)) * 0.5;
    vec2 tile = fract(g);
    float joint = smoothstep(0.0, 0.05, min(min(tile.x, 1.0 - tile.x), min(tile.y, 1.0 - tile.y)));
    stones = joint * (0.32 + 0.3 * hash12(floor(g))) * (0.85 + 0.15 * fbm(floorP * 30.0));
    tint = mix(tint, vec3(0.34, 0.37, 0.4), 0.6);
  } else {
    // Moss cushions: lumpy mounds with darker hollows between.
    float cushions = fbm(floorP * 10.0 * grain);
    stones = 0.15 + 0.7 * smoothstep(0.3, 0.75, cushions) + 0.1 * fbm(floorP * 60.0);
  }
  float floorLight = stones * 0.14 * (1.0 - depth * 0.6);
  vec3 floorCol = tint * (0.5 + 1.1 * stones) * (0.9 + 0.2 * fbm(floorP * 5.0));
  float mossAmount = K_floorMoss;
  float moss = bed == 4 ? 0.75 + 0.25 * fbm(floorP * 20.0) : smoothstep(1.0 - mossAmount * 0.9 - 0.05, 1.0 - mossAmount * 0.9 + 0.2, fbm(floorP * 3.2 + 7.0));
  floorCol = mix(floorCol, vec3(0.2, 0.42, 0.16) * (0.6 + 0.6 * stones), moss * 0.8);
  c.col = floorCol;
  c.o.ink = floorLight;
}

// Water weeds: clumps of blades radiating from the floor, swaying and bent downstream.
void pondBedWeeds(Patch x, inout Spot c) {
  vec2 floorP = x.floorP;
  vec2 flow = x.flow;
  float aspect = x.aspect;
  float tm = x.tm;
  float weed = 0.0;
  if (K_weeds > 0.0) {
    int clumps = int(3.0 + K_weeds * 7.0);
    for (int n = 0; n < 10; n++) {
      if (n >= clumps) break;
      float fc = float(n);
      vec2 rel = floorP - (vec2(hash12(vec2(fc, 31.0)), hash12(vec2(fc, 32.0))) - 0.5) * vec2(aspect * 0.95, 0.9);
      float reach = 0.07 + 0.07 * hash12(vec2(fc, 33.0));
      float s = clamp(length(rel) / reach, 0.0, 1.0);
      rel -= flow * 0.09 * s * s;
      float r = length(rel);
      if (r > reach) continue;
      s = r / reach;
      float angle = atan(rel.y, rel.x);
      for (int b = 0; b < 7; b++) {
        float fb = float(b);
        float blade = hash12(vec2(fc, fb + 40.0)) * TAU + 0.45 * sin(tm * 0.7 + s * 2.6 + fb * 1.3 + fc) * s;
        float off = abs(mod(angle - blade + 3.14159, TAU) - 3.14159) * r;
        weed = max(weed, step(off, 0.0055 * (1.0 - s) + 0.0012) * (1.0 - s * 0.5));
      }
    }
  }
  c.col = mix(c.col, vec3(0.2, 0.52, 0.24) * (0.7 + 0.5 * weed), step(0.001, weed) * 0.85);
  c.o.ink = max(c.o.ink, weed * 0.32);
}
`;

/** The water, the sun over it, and what floats on it. */
export const pondWaterGlsl = `
// The water, in screen heights (the frame some 3 m from top to bottom, a koi half a metre long):
// its depth, 0.15 plus 0.3 per unit of K_depth; the steepest slope of a fresh drop's ring; how fast
// a ring's crests turn (radians a second: ripples 160 a screen height, some 12 cm long, run at
// 0.144 screen heights a second, about twice the 0.07 their rings spread at, their group speed);
// how high the eye stands over it (a view 45 degrees tall); the slope variance of a calm surface,
// ruffled further by the breeze (x.wind), that the sun's glint spreads over; and the glint's
// exposure per unit of the sun's strength, and the share of the facets in the swell's broader
// tilts (variance 0.006), set so the glint is as bright at half its height as it always was
// (waterGlint).
const vec2 POND_DEPTH = vec2(0.15, 0.3);
const float POND_RING_SLOPE = 0.08;
const float POND_RING_OMEGA = 23.1;
const float POND_EYE = 1.2;
const vec2 POND_CALM = vec2(0.0003, 0.0012);
const float POND_GLINT = 1.04;
const float POND_TAIL = 0.585;
// Rain's drops: the grid of their sites (screen heights, some 36 cm), a site's beat (seconds), how
// fast a drop's ring fades (1/s) and its steepest slope.
const vec4 POND_RAIN = vec4(0.12, 1.2, 1.6, 0.06);

// A paper boat seen from above, in its own frame (x along the keel, unit = half its length):
// rgb paper colour, a coverage. The hull is a long hexagon, the sail a ridge along the middle
// with one face lit and one in shade, pockets of shadow inside the hull, crease lines to the bows.
vec4 pondWaterPaperBoat(vec2 q, float litSide) {
  float hull = 0.38 * clamp((1.0 - abs(q.x)) / 0.45, 0.0, 1.0);
  if (abs(q.y) > hull) return vec4(0.0);
  vec3 paper = vec3(0.96, 0.95, 0.91);
  float sail = 0.13 * clamp(1.0 - abs(q.x) / 0.62, 0.0, 1.0);
  float shade = 0.97;
  if (abs(q.y) < sail) {
    // The two faces of the sail, one toward the sun.
    shade = sign(q.y) == litSide ? 1.02 : 0.74;
    if (abs(q.y) < 0.012) shade = 0.9;
  } else if (abs(q.y) < hull - 0.05 && abs(q.x) < 0.78) {
    // Inside the hull, under the sail's overhang.
    shade = 0.8 + 0.12 * (abs(q.y) - sail) / max(0.01, hull - sail);
  }
  // Folds running from the sail's ends out to the bows.
  float crease = min(abs(abs(q.y) - (1.0 - abs(q.x)) * 0.32), 1.0);
  if (abs(q.x) > 0.6 && crease < 0.012) shade *= 0.86;
  return vec4(paper * shade, 1.0);
}

// The water's state at this cell, for its passes: the rings' light and roughness, the pads.
float pondWaterRingRough;
float pondWaterRingLight;
int pondWaterPads;
bool pondWaterLaid;
vec3 pondWaterPadAt[${POND_LAYOUT.pads}];
vec2 pondWaterPadRoot[${POND_LAYOUT.pads}];
bool pondWaterPadFlower[${POND_LAYOUT.pads}];

// The surface (the overhead composer's x.slope, x.floorP, x.depth, x.flow, x.waterCol, x.caustic)
// and the sun's strength over it (x.power); the pads' layout.
void pondWaterBegin(inout Patch x) {
  float m = x.m;
  float tm = x.tm;
  float aspect = x.aspect;
  vec2 p = x.p;
  float depth = K_depth;
  vec2 flow = vec2(cos(K_currentDir * TAU), sin(K_currentDir * TAU)) * K_current;
  float turbulence = K_turbulence;
  bool tethered = K_tether > 0.5;
  // The sun: where the World's hour puts it (the composer's x.sun, x.sunUV), its strength the
  // knob's against the pond's painted hour's (x.keyGain: dimmer low, at night and under cloud);
  // it lifts the water, caustics and rays.
  x.power = K_sunPower * x.keyGain;
  float power = x.power;
  // Passage: the water settles; only while arriving or leaving. At rest every term is exactly 1.
  float pin = passageIn();
  float pout = passageOut();
  float tin = pin * POND_ENTER;
  float causticK = 1.0;
  if (pin < 1.0 || pout > 0.0) {
    float up = 1.0 - (1.0 - pin) * (1.0 - pin);
    float down = pout * pout;
    causticK = mix(0.95, 1.0, up) * mix(1.0, 0.95, down);
  }

  // Surface: rings spreading from drops, carried by the current. Each is a short train of ripples,
  // its height POND_RING_SLOPE / 160 * sin(160 * dist - POND_RING_OMEGA * age) under a bell 0.012
  // wide that spreads at 0.07 a second: the crests run through their ring at twice its speed, each
  // born at its inside and dying at its front, as real ripples do. Summed here as its analytic
  // slope (dh/dx, dh/dy). The slope bends the light to the floor and tilts the mirror the sun
  // glints in; drawn only where the cells resolve the rings' 0.039 wavelength (7 to 14 cells, as
  // rippleTrain does), and below that it is only the variance (ringRough) that roughens the glint.
  vec2 slope = vec2(0.0);
  float ringRough = 0.0;
  float ringSeen = smoothstep(7.0, 14.0, TAU / 160.0 * uRes.y);
  float ringLight = 0.0;
  if (K_ripples > 0.0) {
    vec2 grid = p / 0.28;
    for (int y = -1; y <= 1; y++) {
      for (int k = -1; k <= 1; k++) {
        vec2 id = floor(grid) + vec2(float(k), float(y));
        float slot = mix(9.0, 2.2, K_ripples);
        float kk = tm / slot + hash12(id);
        float age = fract(kk) * slot;
        vec2 drop = (id + vec2(hash12(id + floor(kk)), hash12(id + floor(kk) + 4.0))) * 0.28 + flow * age * 0.06;
        float dist = length(p - drop);
        float radius = age * 0.07;
        float fade = exp(-age * 1.1) * step(0.3, hash12(id + floor(kk) * 3.1));
        float along = (dist - radius) / 0.012;
        float ring = POND_RING_SLOPE * bell(along) * fade;
        float phase = 160.0 * dist - POND_RING_OMEGA * age;
        slope += ring * (cos(phase) - sin(phase) * along / 0.96) * (p - drop) / max(dist, 1e-5);
        ringRough += 0.5 * ring * ring;
        ringLight = max(ringLight, smoothfall(0.004, 0.0, abs(dist - radius)) * fade + smoothfall(0.003, 0.0, abs(dist - radius * 0.6)) * fade * 0.6);
      }
    }
  }
  // "now": one drop at a random spot.
  float dropAge = sinceTrigger(TRIGGER_ripples);
  if (dropAge >= 0.0 && dropAge < 5.0) {
    vec2 drop = (vec2(hash12(vec2(uTriggers[TRIGGER_ripples], 1.0)), hash12(vec2(uTriggers[TRIGGER_ripples], 2.0))) - 0.5) * vec2(aspect * 0.7, 0.7) + flow * dropAge * 0.06;
    float dist = length(p - drop);
    float radius = dropAge * 0.07;
    float fade = exp(-dropAge * 0.9);
    float along = (dist - radius) / 0.012;
    float ring = POND_RING_SLOPE * bell(along) * fade;
    float phase = 160.0 * dist - POND_RING_OMEGA * dropAge;
    slope += ring * (cos(phase) - sin(phase) * along / 0.96) * (p - drop) / max(dist, 1e-5);
    ringRough += 0.5 * ring * ring;
    ringLight = max(ringLight, (smoothfall(0.004, 0.0, abs(dist - radius)) + 0.6 * smoothfall(0.003, 0.0, abs(dist - radius * 0.6))) * fade);
  }
#if WORLD_RAIN
  // Rain (the World's K_rain, on the fall clock): a drop lands at each site of a POND_RAIN.x grid
  // on a fixed beat of its own (POND_RAIN.y seconds, give or take a fifth); the amount gates only
  // which beats land, so a ring never runs backward as the rain eases. Each rings as the drops
  // above do, carried by the current, shorter-lived, dying before its site's next beat; their
  // slopes sum with the rest and their light adds up where they cross, so the rings interfere.
  if (K_rain > 0.0) {
    vec2 grid = p / POND_RAIN.x;
    for (int y = -1; y <= 1; y++) {
      for (int k = -1; k <= 1; k++) {
        vec2 id = floor(grid) + vec2(float(k), float(y));
        float period = POND_RAIN.y * (0.8 + 0.4 * hash12(id + 23.0));
        float beat = uFallTime / period + hash12(id + 17.0);
        float n = floor(beat);
        if (hash12(id + vec2(n * 0.123, n * 0.731)) >= K_rain) continue;
        float age = fract(beat) * period;
        vec2 drop = (id + 0.15 + 0.7 * vec2(hash12(id + n * 1.7 + 3.1), hash12(id + n * 2.3 + 8.7))) * POND_RAIN.x + flow * age * 0.06;
        float dist = length(p - drop);
        float radius = age * 0.07;
        float fade = exp(-age * POND_RAIN.z) * (1.0 - smoothstep(0.7, 1.0, fract(beat)));
        float along = (dist - radius) / 0.012;
        float ring = POND_RAIN.w * bell(along) * fade;
        float phase = 160.0 * dist - POND_RING_OMEGA * age;
        slope += ring * (cos(phase) - sin(phase) * along / 0.96) * (p - drop) / max(dist, 1e-5);
        ringRough += 0.5 * ring * ring;
        ringLight = min(ringLight + (smoothfall(0.006, 0.0, abs(dist - radius)) + 0.6 * smoothfall(0.004, 0.0, abs(dist - radius * 0.6))) * fade, 1.0);
      }
    }
  }
#endif
  // Arriving: a few drops ring the water as the koi swim in, each ring dying away before the end.
  if (pin < 1.0) {
    float ringsFade = 1.0 - smoothstep(2.2, 3.1, tin);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float age = tin - (0.5 + 0.5 * fk);
      if (age < 0.0) continue;
      vec2 drop = (vec2(hash12(vec2(fk, 81.0)), hash12(vec2(fk, 82.0))) - 0.5) * vec2(aspect * 0.8, 0.8);
      float dist = length(p - drop);
      float radius = age * 0.07;
      float fade = exp(-age * 1.2) * ringsFade * smoothstep(0.0, 0.3, age);
      float line = smoothfall(0.004, 0.0, abs(dist - radius)) + 0.6 * smoothfall(0.003, 0.0, abs(dist - radius * 0.6));
      ringLight = max(ringLight, 0.9 * hardEdge(line * fade));
    }
  }
  // The rings drawn where the cells resolve them, their variance below that; a slow swell over the
  // whole pond while the water moves. The light reaching the floor bends through that surface:
  // 0.25 of the water's depth times its slope (refraction into water, n 1.33, at small slopes, as
  // caustics.ts takes it), so deep water shifts the floor further than shallow.
  slope = slope * ringSeen + vec2(sin(p.y * 9.0 + tm * 0.7), cos(p.x * 8.0 + tm * 0.6)) * 0.033 * m;
  ringRough *= 1.0 - ringSeen;
  float waterDepth = POND_DEPTH.x + POND_DEPTH.y * depth;
  vec2 floorP = p + 0.25 * waterDepth * slope;
  x.depth = depth;
  x.slope = slope;
  x.floorP = floorP;
  x.flow = flow;
  pondWaterRingRough = ringRough;
  pondWaterRingLight = ringLight;

  // Turquoise water, deepening with depth; the floor shows through it.
  x.waterCol = mix(vec3(0.06, 0.46, 0.42), vec3(0.02, 0.2, 0.24), depth) * (0.85 + 0.3 * fbm(p * 1.4 + vec2(tm * 0.01, 0.0)));
  float caustic = 0.0;
  if (K_caustics > 0.0) {
    // Two layers of the water's cellular caustic net (its caustics tier); light gathers where their
    // seams cross. The current carries them (waterDrift).
    vec2 drifted = waterDrift(floorP, 0.03 * flow, tm);
    float a = causticCells(drifted * 4.2 + vec2(tm * 0.03, 0.0), tm * 0.7, 4.2 / uRes.y);
    float b = causticCells(drifted * 5.6 + vec2(4.0, -tm * 0.025), tm * 0.9 + 2.0, 5.6 / uRes.y);
    caustic = (a * 0.3 + b * 0.2 + a * b * 0.9) * K_caustics * (1.0 - depth * 0.45) * (0.6 + 0.9 * power);
  }
  caustic *= causticK;
  x.caustic = caustic;

  // Lily pads: this frame's layout (pondPads), worked out once a frame into pondWaterField0 by the
  // layout pass, or here where it is missing.
  pondWaterPads = int(K_lilies * 9.0 + 0.5);
  pondWaterLaid = pondWaterField0On();
  if (pondWaterLaid) {
    for (int i = 0; i < 9; i++) {
      if (i >= pondWaterPads) break;
      vec4 at = texelFetch(pondWaterField0, ivec2(i, 0), 0);
      pondWaterPadAt[i] = at.xyz;
      pondWaterPadFlower[i] = at.w > 0.5;
      pondWaterPadRoot[i] = texelFetch(pondWaterField0, ivec2(i, 1), 0).xy;
    }
  } else {
    pondPads(pondWaterPads, aspect, tm, flow, turbulence, K_lilySeed, K_lilyDrift, tethered, pondWaterPadAt, pondWaterPadRoot);
    for (int i = 0; i < 9; i++) {
      if (i >= pondWaterPads) break;
      pondWaterPadFlower[i] = pondPadFlower(float(i), K_lilySeed);
    }
  }
}

// Turquoise water over the floor, which shows through it, and the light it gathers there.
void pondWaterOver(Patch x, inout Spot c) {
  c.col = mix(c.col, x.waterCol, 0.52 + 0.3 * x.depth) * (0.75 + 0.7 * x.power);
  c.col += vec3(0.7, 1.0, 0.92) * x.caustic * 0.55;
  c.o.ink += x.caustic;
}

// The pads' stems, rooted in the floor and seen through the water.
void pondWaterStems(Patch x, inout Spot c) {
  float stem = 0.0;
  if (K_tether > 0.5) {
    for (int i = 0; i < 9; i++) {
      if (i >= pondWaterPads) break;
      stem = max(stem, smoothfall(0.003, 0.0012, segmentDistance(x.floorP, pondWaterPadRoot[i], pondWaterPadAt[i].xy)) * smoothstep(0.004, 0.012, length(x.floorP - pondWaterPadRoot[i]) + 0.01));
    }
  }
  c.col = mix(c.col, vec3(0.16, 0.36, 0.17), stem * 0.75);
  c.o.ink = max(c.o.ink, stem * 0.2);
}

// The pads' shadows on the floor, falling away from the sun, further in deeper water.
void pondWaterCast(Patch x, inout float shadow) {
  vec2 shadowOffset = -normalize(x.sun - x.p + 1e-5) * 0.034 * (0.4 + 1.2 * x.depth);
  float padShadow = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= pondWaterPads) break;
    padShadow = max(padShadow, step(length(x.p - pondWaterPadAt[i].xy - shadowOffset * 0.6), pondWaterPadAt[i].z));
  }
  shadow = max(shadow, padShadow * 0.8);
}

// What floats on the surface, in the pond's order: the pads and their flowers, the petals, the
// rings' light, the paper boat. What floats is dry: the sun glints on the water round it, never on it.
void pondWaterFloat(Patch x, inout Spot c) {
  float t = x.t;
  float tm = x.tm;
  float aspect = x.aspect;
  vec2 p = x.p;
  vec2 flow = x.flow;
  float turbulence = K_turbulence;
  float power = x.power;
  vec2 towardSun = normalize(x.sun - p + 1e-5);
  // Lily pads float above the fish; some carry a flower.
  float pad = 0.0;
  float flower = 0.0;
  vec3 padCol = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    if (i >= pondWaterPads) break;
    float fi = float(i);
    vec2 centre = pondWaterPadAt[i].xy;
    float radius = pondWaterPadAt[i].z;
    vec2 d = rotate(p - centre, -(tm * (0.02 + K_lilyDrift * 0.05) + fi * 1.7));
    float notch = abs(atan(d.y, d.x)) < 0.16 && length(d) > radius * 0.08 ? 1.0 : 0.0;
    float inside = step(length(d), radius) * (1.0 - notch);
    float veins = smoothfall(0.06, 0.0, abs(sin(atan(d.y, d.x) * 8.0))) * smoothstep(radius * 0.1, radius * 0.3, length(d));
    float rim = smoothstep(radius * 0.86, radius * 0.97, length(d));
    if (inside > 0.0) {
      pad = 0.22 + 0.12 * veins + 0.45 * rim;
      // The same greens as the foliage, lit like the lowest layer of it.
      padCol = mix(vec3(0.1, 0.34, 0.14), vec3(0.36, 0.62, 0.28), rim) * (1.0 - 0.25 * veins) * (0.9 + 0.2 * vnoise(d * 40.0)) * (0.8 + 0.4 * power);
    }
    if (pondWaterPadFlower[i]) {
      vec2 f = rotate(p - centre - vec2(radius * 0.25, radius * 0.1), tm * 0.05);
      float fr = radius * 0.32;
      float petals = fr * (0.55 + 0.45 * abs(cos(atan(f.y, f.x) * 4.0)));
      flower = max(flower, step(length(f), petals) * (length(f) < fr * 0.25 ? 2.0 : 1.0));
    }
  }
  // What floats on the water (pads, flowers, petals, the boat) or stands in it (the stone) is dry:
  // the sun glints on the water around it, never on it.
  c.dry = c.dry || pad > 0.0 || flower > 0.0;
  if (pad > 0.0) { c.o.ink = pad; c.o.accent = 0.0; c.col = padCol; }
  if (flower > 0.0) {
    c.o.ink = flower > 1.5 ? 0.0 : 0.95;
    c.o.accent = flower > 1.5 ? 0.9 : 0.0;
    c.col = flower > 1.5 ? vec3(1.0, 0.85, 0.3) : vec3(1.0, 0.72, 0.84);
  }

  // Petals riding the current, recycled when they leave the pond (pondPetal, in the layout's last
  // row when the layout pass has run).
  if (K_current > 0.0 && K_petals > 0.0) {
    int petals = int(K_petals * 18.0 + 0.5);
    vec2 span = vec2(aspect * 1.1, 1.1);
    for (int i = 0; i < 18; i++) {
      if (i >= petals) break;
      float fi = float(i);
      vec3 petal = pondWaterLaid ? texelFetch(pondWaterField0, ivec2(i, 2), 0).xyz : pondPetal(fi, span, flow, tm, turbulence);
      vec2 d = rotate(p - petal.xy, petal.z);
      if (length(d / vec2(0.011, 0.006)) < 1.0) {
        c.o.ink = 0.9;
        c.o.accent = 0.0;
        c.col = mix(vec3(1.0, 0.75, 0.86), vec3(1.0, 0.97, 0.95), hash12(vec2(fi, 55.0)));
        c.dry = true;
      }
    }
  }

  c.o.ink = max(c.o.ink, pondWaterRingLight * 0.7);
  c.col += vec3(0.85, 1.0, 1.0) * pondWaterRingLight * 0.45;

  // The paper boat: once in a while (or now, on trigger) it rides the current across, entering
  // upstream and leaving downstream, rocking with the eddies. Real clock, so it sails at motion 0.
  if (K_current > 0.0) {
    float age = sinceTrigger(TRIGGER_boat);
    float lane = hash12(vec2(uTriggers[TRIGGER_boat], 61.0));
    if (K_boat > 0.0 && (age < 0.0 || age > 90.0)) {
      float slot = mix(300.0, 45.0, K_boat);
      float k = floor(t / slot);
      float start = k * slot + hash12(vec2(k, 62.0)) * slot * 0.3;
      if (hash12(vec2(k, 63.0)) < 0.7) {
        age = t - start;
        lane = hash12(vec2(k, 64.0));
      }
    }
    vec2 dir = normalize(flow + vec2(1e-4, 0.0));
    vec2 across = vec2(-dir.y, dir.x);
    float speed = 0.035 + 0.09 * K_current;
    float reach = 0.62 * max(aspect, 1.0);
    if (age >= 0.0 && age * speed < reach * 2.0) {
      float rock = 0.3 + turbulence;
      vec2 at = -dir * reach + across * (lane - 0.5) * 0.7 + dir * speed * age + across * sin(age * 0.5 + lane * 6.0) * 0.025 * rock;
      float heading = atan(dir.y, dir.x) + sin(age * 0.8 + lane * 9.0) * 0.18 * rock;
      float size = 0.05 * (1.0 + 0.03 * sin(age * 2.3));
      vec2 sunAcross = rotate(towardSun, -heading);
      float litSide = sunAcross.y > 0.0 ? 1.0 : -1.0;
      // Its shadow on the water, then the boat itself.
      vec4 shadowBoat = pondWaterPaperBoat(rotate(p - at + towardSun * 0.012, -heading) / size, litSide);
      c.col *= 1.0 - 0.35 * shadowBoat.a;
      c.o.ink *= 1.0 - 0.4 * shadowBoat.a;
      // A faint V of wake trailing behind.
      vec2 w = rotate(p - at, -heading) / size;
      if (w.x < -1.0 && w.x > -5.0) {
        float wake = smoothfall(0.08, 0.0, abs(abs(w.y) - (-w.x - 1.0) * 0.32)) * (1.0 + (w.x + 1.0) / 4.0);
        c.o.ink = max(c.o.ink, wake * 0.35);
        c.col += vec3(0.85, 1.0, 1.0) * wake * 0.12;
      }
      vec4 boat = pondWaterPaperBoat(w, litSide);
      if (boat.a > 0.0) {
        c.col = boat.rgb * (0.85 + 0.3 * power);
        c.o.ink = 0.55 + 0.4 * boat.r;
        c.o.accent = 0.0;
        c.o.shimmer = 0.0;
        c.dry = true;
      }
    }
  }
}

// The sun's glint on the water (waterGlint). Seen from POND_EYE over the frame's middle, the sun
// stands where its mirror image falls on the pond: at x.sun, on screen or off it. The drawn rings
// and the slow swell tilt the mirror; the calm surface, the breeze and the rings too fine to draw
// spread the glint; the broader tilts of the swell (POND_TAIL of the facets) lay a wider sheen
// round it. Its exposure is the sun's strength, only on open water, and only where the leaves let
// the sun through.
void pondWaterGlint(Patch x, inout Spot c) {
  vec3 sunDir = normalize(vec3(x.sun.x, POND_EYE, x.sun.y));
  vec3 view = normalize(vec3(-x.p.x, POND_EYE, -x.p.y));
  vec3 n = normalize(vec3(-x.slope.x, 1.0, -x.slope.y));
  float rough = POND_CALM.x + POND_CALM.y * x.wind + pondWaterRingRough;
  float sun = POND_GLINT * x.power * (1.0 - c.shade);
  float glare = c.dry ? 0.0 : waterGlint(n, view, sunDir, rough, sun * (1.0 - POND_TAIL)) + waterGlint(n, view, sunDir, 0.006, sun * POND_TAIL);
  c.col += vec3(1.0, 0.97, 0.85) * glare * 0.7;
  c.o.ink = max(c.o.ink, glare);
}

// The pond's passage over everything: barely a breath of light as it arrives and leaves (the motion
// carries the passage), and leaving, a breeze crossing the surface: a band of ruffled, darker water
// sweeping over, cut per cell. At rest every term is exactly 1. Then the caustics' sparkle.
void pondWaterGrade(Patch x, inout Spot c) {
  float pin = passageIn();
  float pout = passageOut();
  if (pin < 1.0 || pout > 0.0) {
    float up = 1.0 - (1.0 - pin) * (1.0 - pin);
    float down = pout * pout;
    float lightK = mix(0.96, 1.0, up) * mix(1.0, 0.96, down);
    if (pout > 0.0) {
      vec2 gustDir = normalize(vec2(0.9, 0.4));
      float span = 0.5 * (x.aspect * abs(gustDir.x) + abs(gustDir.y));
      float front = mix(-span - 0.55, span + 0.55, pout);
      lightK *= 1.0 - 0.08 * hardEdge(bell((dot(x.p, gustDir) - front) / 0.2) * 0.9);
    }
    c.col *= lightK;
    c.o.ink *= lightK;
    c.o.accent *= lightK;
  }
  c.o.shimmer = max(c.o.shimmer, x.caustic * 0.15);
}
`;

/** The Manifold stone. */
export const stoneGlsl = `
// The Manifold stone: a carved M standing in the water, its shadow on the floor and the water
// lapping at its foot.
void stoneStand(Patch x, inout Spot c) {
  float aspect = x.aspect;
  float tm = x.tm;
  vec2 p = x.p;
  if (K_stone > 0.0) {
    vec2 at = vec2(K_stoneX * aspect * 0.5, K_stoneY * 0.5);
    float scale = 0.16 + 0.34 * K_stone;
    float thickness = 0.12;
    // A hand-cut edge: the outline wavers a little, the way chiselled stone does.
    float d = markDistance((p - at) / scale) - thickness + (vnoise((p - at) / scale * 22.0) - 0.5) * 0.025;
    float shade = markDistance((p - at - vec2(0.025, -0.035)) / scale) - thickness;
    if (shade < 0.0 && d > 0.0) { c.col *= 0.55; c.o.ink *= 0.35; c.o.accent *= 0.4; }
    if (d < 0.0) {
      float e = 0.004;
      vec2 grad = vec2(
        markDistance((p - at + vec2(e, 0.0)) / scale) - markDistance((p - at - vec2(e, 0.0)) / scale),
        markDistance((p - at + vec2(0.0, e)) / scale) - markDistance((p - at - vec2(0.0, e)) / scale)
      );
      float bevel = smoothstep(-0.05, 0.0, d);
      float light = 0.62 + 0.38 * dot(normalize(grad + 1e-6), normalize(vec2(-0.6, 0.8))) * bevel;
      vec2 q = (p - at) / scale;
      float grain = 0.85 + 0.15 * fbm(q * 18.0);
      float growth = smoothstep(1.0 - K_moss, 1.0 - K_moss + 0.25, fbm(q * 4.5 + 3.0)) * (1.0 - bevel * 0.6);
      vec3 granite = vec3(0.6, 0.6, 0.57) * grain * light;
      c.col = mix(granite, vec3(0.24, 0.48, 0.2) * (0.8 + 0.4 * fbm(q * 30.0)), growth);
      c.o.ink = mix(0.35 + 0.5 * light * grain, 0.22, growth);
      c.o.accent = 0.0;
      c.o.shimmer = 0.0;
      c.dry = true;
    } else if (d < 0.07) {
      // Water lapping at the stone: a foam line and small waves running outward.
      float foam = smoothfall(0.03, 0.0, d) * (0.6 + 0.4 * vnoise(p * 140.0 + tm * 2.0));
      float lap = (0.5 + 0.5 * sin(d * 120.0 - tm * 3.0)) * smoothfall(0.07, 0.01, d) * 0.35;
      c.col = mix(c.col, vec3(0.92, 0.98, 0.97), max(foam, lap));
      c.o.ink = max(c.o.ink, max(foam, lap));
    }
  }
}
`;

/** The border plants and the canopy: their shade, the rays through them, the leaves. */
export const borderGlsl = `${plantsGlsl}${plantSheetGlsl}
// One texel of the plant sheet (borderField0), exactly as drawn: material codes must never be interpolated.
vec4 borderDecorTexel(vec2 at) {
  ivec2 size = textureSize(borderField0, 0);
  return texelFetch(borderField0, clamp(ivec2(at * vec2(size)), ivec2(0), size - 1), 0);
}

// A blur of the plant sheet as wide on the frame as mip 'lod' of a 2048-wide sheet, whatever the
// sheet's size (the sim draws it at two pixels a cell, up to 2048).
float borderSheetLod(float lod) {
  return lod + log2(float(textureSize(borderField0, 0).x) / 2048.0);
}

// How far the foliage at each edge (left, right, bottom, top, in sheet UV) is held out beyond the
// frame: 'amount' at the start of the entrance, coming in at speed and easing in to 0 with a small
// overshoot past rest, edge by edge (all set off at once; each settles 1.9 s after its own delay,
// plus 'lag'); and out again on exit, gathering speed to the exit's end.
vec4 borderFoliageShift(float tin, float tout, float lag, float amount) {
  vec4 delay = vec4(0.0, 0.25, 0.4, 0.1);
  vec4 a = clamp(vec4(tin) / (1.9 + delay + lag), 0.0, 1.0);
  vec4 u = 1.0 - (1.0 - a) * (1.0 - a) * (1.0 - a);
  vec4 b = clamp((vec4(tout) - 0.5 * delay) / (POND_EXIT - 0.5 * delay), 0.0, 1.0);
  return amount * ((1.0 - u) * cos(u * 2.51327) + b * b * b);
}

// One edge's push on a lookup, strongest at the edge and gone 0.4 into the frame. Overshoot (the
// negative side) fades out toward the edge so the lookup never leaves the sheet there.
float borderEdgeShift(float dist, float amount) {
  float w = 1.0 - smoothstep(0.0, 0.4, dist);
  if (amount < 0.0) w *= smoothstep(0.0, 0.15, dist);
  return amount * w;
}

// A sheet lookup with each side's foliage held out (or let in) by its shift: plants near the left
// edge come from the left, and so on. 'scale' lets near layers move a little more than far ones.
vec2 borderFoliageWarp(vec2 at, vec4 shift, float scale) {
  if (shift == vec4(0.0)) return at;
  return at + vec2(
    borderEdgeShift(at.x, shift.x * scale) - borderEdgeShift(1.0 - at.x, shift.y * scale),
    borderEdgeShift(at.y, shift.z * scale) - borderEdgeShift(1.0 - at.y, shift.w * scale)
  );
}

// How far the plants and the canopy are held out beyond the frame this frame (borderFoliageShift),
// only while the scene arrives or leaves.
vec4 borderPlantShift;
vec4 borderCanopyShift;

// The foliage's passage: it moves in from beyond the frame, and out again on leaving. The breeze is
// the World's wind (K_wind, its sign the way it blows), which the overhead composer's x.wind already
// carries to the water the sun glints on.
void borderBegin(inout Patch x) {
  float pin = passageIn();
  float pout = passageOut();
  borderPlantShift = vec4(0.0);
  borderCanopyShift = vec4(0.0);
  if (pin < 1.0 || pout > 0.0) {
    float tin = pin * POND_ENTER;
    float tout = pout * POND_EXIT;
    borderPlantShift = borderFoliageShift(tin, tout, 0.0, 0.2);
    // The canopy settles a moment after the plants.
    borderCanopyShift = borderFoliageShift(tin, tout, 0.5, 0.12);
  }
}

// Foliage: border plants (in frame) and the canopy (above the camera). Both cast shadows away
// from the sun and stand in the way of its rays. The border plants sway in the sim (plants.ts),
// each organ on its own spring; the canopy, never seen itself, sways here.
void borderCover(Patch x, inout Spot c) {
  float t = x.t;
  float tm = x.tm;
  float m = x.m;
  float aspect = x.aspect;
  vec2 uv = x.uv;
  vec2 sunUV = x.sunUV;
  float power = x.power;
  int style = int(K_plantStyle + 0.5);
  float wind = x.wind * m;
  float gust = 0.6 + 0.4 * vnoise(vec2(t * 0.25, 3.0));
  // Slow and wide enough to read as leaning in the breeze: a sway of only a cell or two, back and
  // forth quickly, reads as jitter once pixelated.
  vec2 sway = vec2(sin(t * 0.55 + uv.y * 3.0), cos(t * 0.45 + uv.x * 2.5)) * 0.008 * wind * gust;
  vec2 sunwardUV = normalize((sunUV - uv) * vec2(aspect, 1.0) + 1e-5) / vec2(aspect, 1.0);
  float canopySpan = 1.0 + 2.0 * ${CANOPY_MARGIN.toFixed(2)};
  float softness = K_canopySoft;
  float shadeAmount = 0.0;
  if (borderField1On()) {
    vec2 canopyUV = (borderFoliageWarp(uv + sunwardUV * (0.05 + 0.08 * softness) + sway * 2.2, borderCanopyShift, 1.0) + ${CANOPY_MARGIN.toFixed(2)}) / canopySpan;
    float leaves = textureLod(borderField1, canopyUV, 0.3 + softness * 2.6).r;
    shadeAmount = max(shadeAmount, smoothstep(0.25 - 0.12 * softness, 0.6, leaves) * (0.85 - 0.25 * softness));
  }
  if (borderField0On() && style != 1) {
    vec4 hanging = textureLod(borderField0, borderFoliageWarp(uv + sunwardUV * 0.035, borderPlantShift, 1.0), borderSheetLod(2.5));
    shadeAmount = max(shadeAmount, smoothstep(0.08, 0.6, hanging.r) * 0.8);
  }
  c.col *= 1.0 - 0.6 * shadeAmount;
  c.o.ink *= 1.0 - 0.7 * shadeAmount;
  c.o.accent *= 1.0 - 0.5 * shadeAmount;
  c.shade = shadeAmount;

  // God rays: march toward the sun; every leaf on the way blocks a little of the beam.
  if (K_rays > 0.0) {
    vec2 marchStep = (sunUV - uv) * (0.85 / 24.0);
    vec2 at = uv;
    float lit = 0.0;
    float weight = 1.0;
    float total = 0.0;
    for (int i = 0; i < 24; i++) {
      at += marchStep;
      float block = 0.0;
      if (borderField0On()) block = textureLod(borderField0, borderFoliageWarp(at, borderPlantShift, 1.0), borderSheetLod(2.0)).r;
      if (borderField1On()) block = max(block, smoothstep(0.15, 0.6, textureLod(borderField1, (borderFoliageWarp(at, borderCanopyShift, 1.0) + ${CANOPY_MARGIN.toFixed(2)}) / canopySpan, 2.5).r));
      lit += (1.0 - block) * weight;
      total += weight;
      weight *= 0.93;
    }
    float angle = atan(uv.y - sunUV.y, (uv.x - sunUV.x) * aspect);
    float beams = 0.5 + 0.5 * vnoise(vec2(angle * 16.0 + tm * 0.04, tm * 0.08));
    float reachOfLight = exp(-length((uv - sunUV) * vec2(aspect, 1.0)) * 1.1);
    float rays = (lit / total) * beams * reachOfLight * K_rays * (0.35 + 1.3 * power);
    c.col += vec3(1.0, 0.95, 0.78) * rays * 0.55;
    c.o.ink += rays * 0.45;
  }
}

// The border plants' leaves, over everything.
void borderOver(Patch x, inout Spot c) {
  vec2 uv = x.uv;
  float power = x.power;
  int style = int(K_plantStyle + 0.5);
  if (borderField0On() && style != 2) {
    // While the plants close in or part, each layer is held out by its own amount, nearer ones
    // more: front to back, take the first texel that belongs to the layer whose offset found it, so
    // overlapping leaves never swap from frame to frame. At rest the three lookups are one texel.
    vec4 leaf = vec4(0.0);
    float layer = 0.0;
    for (int l = 2; l >= 0; l--) {
      vec4 texel = borderDecorTexel(borderFoliageWarp(uv, borderPlantShift, 0.7 + 0.15 * float(l)));
      if (texel.r > 0.5 && plantSheetLayer(texel) == float(l)) {
        leaf = texel;
        layer = float(l);
        break;
      }
    }
    if (leaf.r > 0.5) {
      // Materials (botany.ts): 0 monstera, 1 fern, 2 banana, 3 pothos, 4 hibiscus, 5 frangipani,
      // 6 pollen, 7 grass, 8 stem, 9 aerial root, 10 stigma.
      float material = plantSheetMaterial(leaf);
      layer = plantSheetLayer(leaf);
      vec3 dark;
      vec3 bright;
      if (material < 0.5) { dark = vec3(0.04, 0.24, 0.1); bright = vec3(0.2, 0.52, 0.22); }
      else if (material < 1.5) { dark = vec3(0.2, 0.45, 0.12); bright = vec3(0.55, 0.8, 0.3); }
      else if (material < 2.5) { dark = vec3(0.18, 0.42, 0.12); bright = vec3(0.55, 0.78, 0.32); }
      else if (material < 3.5) { dark = vec3(0.08, 0.32, 0.12); bright = vec3(0.38, 0.68, 0.3); }
      else if (material < 4.5) { dark = vec3(0.45, 0.0, 0.08); bright = vec3(1.0, 0.3, 0.4); }
      else if (material < 5.5) { dark = vec3(0.85, 0.8, 0.7); bright = vec3(1.0, 0.98, 0.94); }
      else if (material < 6.5) { dark = vec3(0.9, 0.58, 0.1); bright = vec3(1.0, 0.86, 0.32); }
      else if (material < 7.5) { dark = vec3(0.25, 0.42, 0.1); bright = vec3(0.68, 0.8, 0.35); }
      else if (material < 8.5) { dark = vec3(0.16, 0.3, 0.1); bright = vec3(0.42, 0.55, 0.25); }
      else if (material < 9.5) { dark = vec3(0.22, 0.15, 0.08); bright = vec3(0.5, 0.38, 0.24); }
      else { dark = vec3(0.35, 0.0, 0.05); bright = vec3(0.8, 0.05, 0.15); }
      // Leaves catch the sun on its side and dim in the canopy's shade.
      c.col = mix(dark, bright, leaf.g);
      // The year and their age turn the leaves, stems and grass (the flowers come and go instead).
      if (material < 3.5 || (material > 6.5 && material < 9.5)) c.col = plantPhenology(c.col, plantSheetPheno(leaf));
      c.col *= (0.72 + 0.14 * layer) * (0.85 + 0.35 * power) * (1.0 - 0.35 * c.shade);
      // Red blooms take the accent; everything else is ink, pale flowers brightest.
      bool red = (material > 3.5 && material < 4.5) || material > 9.5;
      c.o.ink = red ? 0.0 : (0.1 + 0.55 * leaf.g) * (0.72 + 0.14 * layer) + (material > 4.5 && material < 6.5 ? 0.35 : 0.0);
      c.o.accent = red ? 0.6 + 0.35 * leaf.g : 0.0;
      c.o.shimmer = 0.0;
    }
  }
}
`;

/** The koi and their shadows. */
export const koiGlsl = `${fishGlsl}
// Koi i's glide in from, or out beyond, the frame's edge while the scene passes. 'base' is where its
// swim path has it; the koi comes and goes along a fixed bearing of its own, from or to just clear of
// the frame. 'slideVel' is the glide's velocity, for the heading.
// Entrance: sets off out of sight at once, glides in at speed and settles, arriving by 2.6-3.1 s
// (each its own), as the plants settle. Exit: starts 0-0.3 s, gathers speed and is just clear of
// the frame as the exit ends.
vec2 koiPassage(float fi, vec2 base, float len, float aspect, out vec2 slideVel) {
  float tin = passageIn() * POND_ENTER;
  float tout = passageOut() * POND_EXIT;
  float stagger = hash12(vec2(fi, 71.0));
  float bearing = hash12(vec2(fi, 72.0)) * TAU;
  vec2 n = vec2(cos(bearing), sin(bearing));
  // How far along the bearing before the koi, nose to tail, is clear of the frame.
  vec2 reach = vec2(aspect * 0.5, 0.5) + (len * 1.05 + 0.04);
  vec2 room = (reach - base * sign(n)) / max(abs(n), vec2(1e-4));
  float clear = max(min(room.x, room.y), 0.0);
  float arriveFor = 2.6 + 0.5 * stagger;
  float arrive = clamp(tin / arriveFor, 0.0, 1.0);
  float leaveFor = POND_EXIT - 0.3 * stagger;
  float leave = clamp((tout - 0.3 * stagger) / leaveFor, 0.0, 1.0);
  float comingIn = arrive > 0.0 && arrive < 1.0 ? 1.0 : 0.0;
  float goingOut = leave > 0.0 && leave < 1.0 ? 1.0 : 0.0;
  float rest = 1.0 - arrive;
  slideVel = n * clear * (-3.0 * rest * rest / arriveFor * comingIn + 3.0 * leave * leave / leaveFor * goingOut);
  return n * clear * (rest * rest * rest + leave * leave * leave);
}

// The koi at this cell, worked out once for their shadow and their bodies.
float koiShadow;
bool koiOn;
vec3 koiCol;
float koiInk;
float koiAccent;

// Koi and their shadows on the floor. Each swims its own loop (its own layout pass, koiField1, or
// worked out here where it is missing); while they are drawn to the pointer the sim steers them
// (koiField0, koi.ts), and tag.x says how much of that to show. Drawn in the frame's own units.
void koiBegin(inout Patch x) {
  float m = x.m;
  float tm = x.tm;
  float aspect = x.aspect;
  vec2 p = x.p;
  bool passing = passageIn() < 1.0 || passageOut() > 0.0;
  vec2 towardSun = normalize(x.sun - p + 1e-5);
  int count = int(K_koi + 0.5);
  float swimTime = tm * (0.6 + 2.4 * K_swim);
  float shadow = 0.0;
  float fish = 0.0;
  float fishAccent = 0.0;
  bool onFish = false;
  vec3 fishCol = vec3(0.0);
  // Shadows fall away from the sun, further in deeper water.
  vec2 shadowOffset = -towardSun * 0.034 * (0.4 + 1.2 * x.depth);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    float fi = float(i);
    vec4 swum = koiField1On() ? texelFetch(koiField1, ivec2(i, 0), 0) : pondKoiSwim(fi, swimTime, aspect);
    vec2 pos = swum.xy;
    vec2 pathDiff = swum.zw;
    vec2 dir = normalize(pathDiff + 1e-5);
    // How fast it goes per second of the scene clock, for the passage's heading.
    vec2 vel = pathDiff * (10.0 * (0.6 + 2.4 * K_swim) * m);
    if (koiField0On()) {
      FishPose steered = fishPose(koiField0, i);
      float w = steered.tag.x;
      pos = mix(pos, steered.at, w);
      dir = normalize(mix(dir, steered.dir, w) + 1e-5);
      vel = mix(vel, steered.dir * steered.speed * m, w);
    }
    float len = 0.11 + 0.06 * hash12(vec2(fi, 6.0));
    if (passing) {
      // Gliding in from or out past the frame's edge: head the way it is actually going. Before
      // and after its glide it keeps its own heading, so nothing turns at the passage's ends.
      vec2 slide;
      pos += koiPassage(fi, pos, len, aspect, slide);
      if (slide != vec2(0.0)) dir = normalize(vel + slide + 1e-5);
    }
    vec2 side = vec2(-dir.y, dir.x);
    float swim = tm * (3.0 + 4.0 * K_swim) + fi;
    vec2 rel = p - pos;
    vec2 q = vec2(dot(rel, dir), dot(rel, side));
    vec2 rs = rel - shadowOffset;
    shadow = max(shadow, step(0.5, fishTop(vec2(dot(rs, dir), dot(rs, side)), len, swim, FISH_KOI)));
    float shape = fishTop(q, len, swim, FISH_KOI);
    if (shape > 0.0) {
      onFish = true;
      float u = (0.3 * len - q.x) / len;
      float marking = vnoise(vec2(u * 4.0, q.y / len * 6.0) + fi * 13.0);
      float tone; // 0 dark, 1 white, 2 colour
      fishCol = fishKoiCoat(hash12(vec2(fi, 9.0)), marking, tone);
      fish = tone > 0.5 && tone < 1.5 ? 0.92 : 0.0;
      fishAccent = tone > 1.5 ? 0.95 : 0.0;
      if (shape > 1.5) { fish = 0.45; fishAccent = 0.0; fishCol = mix(x.waterCol, vec3(0.97, 0.95, 0.9), 0.55); }
      if (fishTopEye(q, len)) { fish = 0.0; fishAccent = 0.0; fishCol = vec3(0.07, 0.07, 0.08); }
    }
  }
  koiShadow = shadow;
  koiOn = onFish;
  koiCol = fishCol;
  koiInk = fish;
  koiAccent = fishAccent;
}

// The koi's shadows on the floor.
void koiCast(Patch x, inout float shadow) {
  shadow = max(shadow, koiShadow);
}

// The koi themselves, in the water over the shadows, the light it gathers on them.
void koiSwim(Patch x, inout Spot c) {
  if (koiOn) {
    c.o.ink = koiInk + x.caustic * 0.25;
    c.o.accent = koiAccent;
    c.col = koiCol + vec3(0.7, 1.0, 0.92) * x.caustic * 0.2;
    c.dithered = false;
  }
}
`;
