// The pond scene: water, floor, koi, lilies, foliage, sun and canopy. The koi are drawn with the
// shared fish (sims/fish.ts); while they are drawn to the pointer the sim steers them (koi.ts).

import { CANOPY_MARGIN } from "../../decor.ts";
import { fishGlsl } from "../../sims/fish.ts";
import { glslFloat } from "../../shaders/glsl.ts";

/** Seconds of the pond's entrance and exit (SceneDef.passage). */
export const POND_PASSAGE = { enter: 3.2, exit: 1.8 } as const;

export const pondGlsl = `${fishGlsl}
// One layer of animated cellular light: bright where neighbouring cells meet.
float pondCausticLayer(vec2 x, float t) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = vec2(hash12(i + g), hash12(i + g + 19.1));
      o = 0.5 + 0.45 * sin(t + TAU * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return 1.0 - smoothstep(0.0, 0.06, f2 - f1);
}

// Pebble floor: cells with dark seams, each stone its own shade. Returns brightness.
float pondPebbles(vec2 x) {
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

// One texel of the plant sheet (uSim0), exactly as painted: material codes must never be interpolated.
vec4 pondDecorTexel(vec2 at) {
  ivec2 size = textureSize(uSim0, 0);
  return texelFetch(uSim0, clamp(ivec2(at * vec2(size)), ivec2(0), size - 1), 0);
}

// A paper boat seen from above, in its own frame (x along the keel, unit = half its length):
// rgb paper colour, a coverage. The hull is a long hexagon, the sail a ridge along the middle
// with one face lit and one in shade, pockets of shadow inside the hull, crease lines to the bows.
vec4 pondPaperBoat(vec2 q, float litSide) {
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

// Passage, in seconds (POND_PASSAGE).
const float POND_ENTER = ${glslFloat(POND_PASSAGE.enter)};
const float POND_EXIT = ${glslFloat(POND_PASSAGE.exit)};

// Koi i's glide in from, or out beyond, the frame's edge while the scene passes. 'base' is where its
// swim path has it; the koi comes and goes along a fixed bearing of its own, from or to just clear of
// the frame, with an eased glide. 'slideVel' is the glide's velocity, for the heading.
// Entrance: starts 0.5-1.0 s, glides for 2.1 s, so each has arrived by 3.1 s, as the plants settle.
// Exit: starts 0-0.3 s, glides for 1.4 s, so each is gone by 1.7 s.
vec2 pondKoiPassage(float fi, vec2 base, float len, float aspect, out vec2 slideVel) {
  float tin = passageIn() * POND_ENTER;
  float tout = passageOut() * POND_EXIT;
  float stagger = hash12(vec2(fi, 71.0));
  float bearing = hash12(vec2(fi, 72.0)) * TAU;
  vec2 n = vec2(cos(bearing), sin(bearing));
  // How far along the bearing before the koi, nose to tail, is clear of the frame.
  vec2 reach = vec2(aspect * 0.5, 0.5) + (len * 1.05 + 0.04);
  vec2 room = (reach - base * sign(n)) / max(abs(n), vec2(1e-4));
  float clear = max(min(room.x, room.y), 0.0);
  float arrive = clamp((tin - 0.5 - 0.5 * stagger) / 2.1, 0.0, 1.0);
  float leave = clamp((tout - 0.3 * stagger) / 1.4, 0.0, 1.0);
  float comingIn = arrive > 0.0 && arrive < 1.0 ? 1.0 : 0.0;
  float goingOut = leave > 0.0 && leave < 1.0 ? 1.0 : 0.0;
  slideVel = n * clear * (-2.0 * (1.0 - arrive) / 2.1 * comingIn + 6.0 * leave * (1.0 - leave) / 1.4 * goingOut);
  return n * clear * ((1.0 - arrive) * (1.0 - arrive) + leave * leave * (3.0 - 2.0 * leave));
}

// A lily pad's drift while the scene passes: settling in from a little way off (done by 2.7 s),
// then carried off downwind with the breeze.
vec2 pondPadPassage(float fi) {
  float settle = 1.0 - clamp((passageIn() * POND_ENTER - 0.3) / 2.4, 0.0, 1.0);
  float bearing = hash12(vec2(fi, 73.0)) * TAU;
  float gust = smoothstep(0.0, 1.0, passageOut());
  return vec2(cos(bearing), sin(bearing)) * (0.04 + 0.04 * hash12(vec2(fi, 74.0))) * settle * settle
    + vec2(0.9, 0.4) * (0.02 + 0.02 * hash12(vec2(fi, 75.0))) * gust;
}

// How far the foliage at each edge (left, right, bottom, top, in sheet UV) is held out beyond the
// frame: 'amount' at the start of the entrance, easing in to 0 with a small overshoot past rest, edge
// by edge (each runs 1.9 s from its own delay, plus 'lag'); and out again on exit.
vec4 pondFoliageShift(float tin, float tout, float lag, float amount) {
  vec4 delay = vec4(0.0, 0.25, 0.4, 0.1);
  vec4 a = clamp((vec4(tin) - delay - lag) / 1.9, 0.0, 1.0);
  vec4 u = a * a * (3.0 - 2.0 * a);
  vec4 b = clamp((vec4(tout) - 0.5 * delay) / 1.3, 0.0, 1.0);
  return amount * ((1.0 - u) * cos(u * 2.51327) + b * b);
}

// One edge's push on a lookup, strongest at the edge and gone 0.4 into the frame. Overshoot (the
// negative side) fades out toward the edge so the lookup never leaves the sheet there.
float pondEdgeShift(float dist, float amount) {
  float w = 1.0 - smoothstep(0.0, 0.4, dist);
  if (amount < 0.0) w *= smoothstep(0.0, 0.15, dist);
  return amount * w;
}

// A sheet lookup with each side's foliage held out (or let in) by its shift: plants near the left
// edge come from the left, and so on. 'scale' lets near layers move a little more than far ones.
vec2 pondFoliageWarp(vec2 at, vec4 shift, float scale) {
  if (shift == vec4(0.0)) return at;
  return at + vec2(
    pondEdgeShift(at.x, shift.x * scale) - pondEdgeShift(1.0 - at.x, shift.y * scale),
    pondEdgeShift(at.y, shift.z * scale) - pondEdgeShift(1.0 - at.y, shift.w * scale)
  );
}

Shade scenePond(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float depth = K_depth;
  vec2 flow = vec2(cos(K_currentDir * TAU), sin(K_currentDir * TAU)) * K_current;
  float turbulence = K_turbulence;
  bool tethered = K_tether > 0.5;
  // The sun: placed anywhere (off screen too); its power lifts the water, caustics and rays.
  vec2 sunUV = vec2(K_sunX, K_sunY);
  vec2 sunP = (sunUV - 0.5) * vec2(aspect, 1.0);
  float power = K_sunPower;
  vec2 towardSun = normalize(sunP - p + 1e-5);
  Shade o = blankShade();
  // Passage: the foliage moves in from beyond the frame and the koi follow, the water settles; only
  // while arriving or leaving. At rest every term below is exactly 0, 1 or off.
  float pin = passageIn();
  float pout = passageOut();
  bool passing = pin < 1.0 || pout > 0.0;
  float tin = pin * POND_ENTER;
  float tout = pout * POND_EXIT;
  float lightK = 1.0;
  float causticK = 1.0;
  vec4 plantShift = vec4(0.0);
  vec4 canopyShift = vec4(0.0);
  if (passing) {
    float up = smoothstep(0.0, 1.0, pin);
    float down = smoothstep(0.0, 1.0, pout);
    // Barely a breath of light: the motion carries the passage.
    lightK = mix(0.96, 1.0, up) * mix(1.0, 0.96, down);
    causticK = mix(0.95, 1.0, up) * mix(1.0, 0.95, down);
    plantShift = pondFoliageShift(tin, tout, 0.0, 0.2);
    // The canopy lowers in a moment after the plants.
    canopyShift = pondFoliageShift(tin, tout, 0.5, 0.12);
  }

  // Surface: rings spreading from drops, carried by the current; used for refraction and glints.
  float surface = 0.0;
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
        surface += sin((dist - radius) * 160.0) * bell((dist - radius) / 0.012) * fade;
        ringLight = max(ringLight, smoothfall(0.004, 0.0, abs(dist - radius)) * fade + smoothfall(0.003, 0.0, abs(dist - radius * 0.6)) * fade * 0.6);
      }
    }
  }
  // "now": one drop at a random spot.
  float dropAge = sinceTrigger(0);
  if (dropAge >= 0.0 && dropAge < 5.0) {
    vec2 drop = (vec2(hash12(vec2(uTriggers[0], 1.0)), hash12(vec2(uTriggers[0], 2.0))) - 0.5) * vec2(aspect * 0.7, 0.7) + flow * dropAge * 0.06;
    float dist = length(p - drop);
    float radius = dropAge * 0.07;
    float fade = exp(-dropAge * 0.9);
    surface += sin((dist - radius) * 160.0) * bell((dist - radius) / 0.012) * fade;
    ringLight = max(ringLight, (smoothfall(0.004, 0.0, abs(dist - radius)) + 0.6 * smoothfall(0.003, 0.0, abs(dist - radius * 0.6))) * fade);
  }
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
  vec2 bend = vec2(dFdx(surface), dFdy(surface)) * 0.01 + vec2(sin(p.y * 9.0 + tm * 0.7), cos(p.x * 8.0 + tm * 0.6)) * 0.0025 * m;
  vec2 floorP = p + bend;

  // Floor: pebbles or silt with moss between, dimmer when deep. 'col' is the full-colour picture;
  // ink and accent coverage carry the same layers for the accent and mono palettes.
  int bed = int(K_floorType + 0.5);
  float grain = mix(1.6, 0.6, K_grain);
  vec3 tint = mix(vec3(0.42, 0.47, 0.5), vec3(0.62, 0.5, 0.34), 0.5 + 0.5 * K_floorTint);
  float stones;
  if (bed == 0) {
    stones = pondPebbles(floorP * 22.0 * grain);
  } else if (bed == 1) {
    // River stones: big and smooth.
    stones = pondPebbles(floorP * 8.0 * grain) * 1.15;
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
  // Turquoise water, deepening with depth; the floor shows through it.
  vec3 water = mix(vec3(0.06, 0.46, 0.42), vec3(0.02, 0.2, 0.24), depth) * (0.85 + 0.3 * fbm(p * 1.4 + vec2(tm * 0.01, 0.0)));
  vec3 col = mix(floorCol, water, 0.52 + 0.3 * depth) * (0.75 + 0.7 * power);
  float caustic = 0.0;
  if (K_caustics > 0.0) {
    // Two drifting layers; light gathers where their seams cross. The current carries them.
    vec2 drift = flow * tm * 0.03;
    float a = pondCausticLayer((floorP - drift) * 4.2 + vec2(tm * 0.03, 0.0), tm * 0.7);
    float b = pondCausticLayer((floorP - drift) * 5.6 + vec2(4.0, -tm * 0.025), tm * 0.9 + 2.0);
    caustic = (a * 0.3 + b * 0.2 + a * b * 0.9) * K_caustics * (1.0 - depth * 0.45) * (0.6 + 0.9 * power);
  }
  caustic *= causticK;
  col += vec3(0.7, 1.0, 0.92) * caustic * 0.55;

  // Water weeds: clumps of blades radiating from the floor, swaying and bent downstream.
  float weed = 0.0;
  if (K_weeds > 0.0) {
    int clumps = int(3.0 + K_weeds * 7.0);
    for (int c = 0; c < 10; c++) {
      if (c >= clumps) break;
      float fc = float(c);
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
  col = mix(col, vec3(0.2, 0.52, 0.24) * (0.7 + 0.5 * weed), step(0.001, weed) * 0.85);

  // Lily pads: where each wants to float, then two passes pushing overlapping pairs apart, so
  // pads crowded by the current just touch and nudge rather than stack.
  int pads = int(K_lilies * 9.0 + 0.5);
  vec3 padAt[9];
  vec2 padRoot[9];
  for (int i = 0; i < 9; i++) {
    if (i >= pads) break;
    vec2 anchor;
    padAt[i] = pondPadState(float(i), aspect, tm, flow, turbulence, K_lilySeed, K_lilyDrift, tethered, anchor);
    padAt[i].xy += pondPadPassage(float(i));
    padRoot[i] = anchor;
  }
  for (int pass = 0; pass < 2; pass++) {
    for (int i = 0; i < 9; i++) {
      if (i >= pads) break;
      for (int j = 0; j < 9; j++) {
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
  // Stems, rooted in the floor and seen through the water.
  float stem = 0.0;
  if (tethered) {
    for (int i = 0; i < 9; i++) {
      if (i >= pads) break;
      stem = max(stem, smoothfall(0.003, 0.0012, segmentDistance(floorP, padRoot[i], padAt[i].xy)) * smoothstep(0.004, 0.012, length(floorP - padRoot[i]) + 0.01));
    }
  }
  col = mix(col, vec3(0.16, 0.36, 0.17), stem * 0.75);

  // Koi and their shadows on the floor. Each swims its own loop; while they are drawn to the
  // pointer the sim steers them (uSim2, koi.ts), and tag.x says how much of that to show.
  int count = int(K_koi + 0.5);
  float swimTime = tm * (0.6 + 2.4 * K_swim);
  float shadow = 0.0;
  float fish = 0.0;
  float fishAccent = 0.0;
  bool onFish = false;
  vec3 fishCol = vec3(0.0);
  // Shadows fall away from the sun, further in deeper water.
  vec2 shadowOffset = -towardSun * 0.034 * (0.4 + 1.2 * depth);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    float fi = float(i);
    float s = swimTime + fi * 11.0;
    vec2 pos = pondKoiPath(fi, s, aspect);
    vec2 pathDiff = pondKoiPath(fi, s + 0.05, aspect) - pondKoiPath(fi, s - 0.05, aspect);
    vec2 dir = normalize(pathDiff + 1e-5);
    // How fast it goes per second of the scene clock, for the passage's heading.
    vec2 vel = pathDiff * (10.0 * (0.6 + 2.4 * K_swim) * m);
    if (uSimOn.z > 0.5) {
      FishPose steered = fishPose(uSim2, i);
      float w = steered.tag.x;
      pos = mix(pos, steered.at, w);
      dir = normalize(mix(dir, steered.dir, w) + 1e-5);
      vel = mix(vel, steered.dir * steered.speed * m, w);
    }
    float len = 0.11 + 0.06 * hash12(vec2(fi, 6.0));
    if (passing) {
      // Gliding in from or out past the frame's edge: head the way it is actually going.
      vec2 slide;
      pos += pondKoiPassage(fi, pos, len, aspect, slide);
      dir = normalize(vel + slide + 1e-5);
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
      if (shape > 1.5) { fish = 0.45; fishAccent = 0.0; fishCol = mix(water, vec3(0.97, 0.95, 0.9), 0.55); }
      if (fishTopEye(q, len)) { fish = 0.0; fishAccent = 0.0; fishCol = vec3(0.07, 0.07, 0.08); }
    }
  }

  // Lily pads float above the fish; some carry a flower.
  float pad = 0.0;
  float padShadow = 0.0;
  float flower = 0.0;
  vec3 padCol = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    if (i >= pads) break;
    float fi = float(i);
    vec2 centre = padAt[i].xy;
    float radius = padAt[i].z;
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
    padShadow = max(padShadow, step(length(p - centre - shadowOffset * 0.6), radius));
    if (hash12(vec2(fi, 24.0 + K_lilySeed)) > 0.6) {
      vec2 f = rotate(p - centre - vec2(radius * 0.25, radius * 0.1), tm * 0.05);
      float fr = radius * 0.32;
      float petals = fr * (0.55 + 0.45 * abs(cos(atan(f.y, f.x) * 4.0)));
      flower = max(flower, step(length(f), petals) * (length(f) < fr * 0.25 ? 2.0 : 1.0));
    }
  }

  float darken = 1.0 - 0.85 * max(shadow, padShadow * 0.8);
  o.ink = max(max(floorLight + caustic, weed * 0.32), stem * 0.2) * darken;
  col = col * (1.0 - 0.55 * max(shadow, padShadow * 0.8));
  if (onFish) {
    o.ink = fish + caustic * 0.25;
    o.accent = fishAccent;
    col = fishCol + vec3(0.7, 1.0, 0.92) * caustic * 0.2;
  }
  if (pad > 0.0) { o.ink = pad; o.accent = 0.0; col = padCol; }
  if (flower > 0.0) {
    o.ink = flower > 1.5 ? 0.0 : 0.95;
    o.accent = flower > 1.5 ? 0.9 : 0.0;
    col = flower > 1.5 ? vec3(1.0, 0.85, 0.3) : vec3(1.0, 0.72, 0.84);
  }

  // Petals riding the current, recycled when they leave the pond.
  if (K_current > 0.0 && K_petals > 0.0) {
    int petals = int(K_petals * 18.0 + 0.5);
    vec2 span = vec2(aspect * 1.1, 1.1);
    for (int i = 0; i < 18; i++) {
      if (i >= petals) break;
      float fi = float(i);
      vec2 start = (vec2(hash12(vec2(fi, 51.0)), hash12(vec2(fi, 52.0))) - 0.5) * span;
      vec2 eddy = (vec2(vnoise(vec2(tm * 0.5 + fi, 3.0)), vnoise(vec2(tm * 0.5 + fi, 8.0))) - 0.5) * turbulence * 0.1;
      vec2 at = mod(start + flow * tm * (0.07 + 0.03 * hash12(vec2(fi, 53.0))) + eddy + span * 0.5, span) - span * 0.5;
      vec2 d = rotate(p - at, tm * (0.6 + hash12(vec2(fi, 54.0))) + fi);
      if (length(d / vec2(0.011, 0.006)) < 1.0) {
        o.ink = 0.9;
        o.accent = 0.0;
        col = mix(vec3(1.0, 0.75, 0.86), vec3(1.0, 0.97, 0.95), hash12(vec2(fi, 55.0)));
      }
    }
  }

  o.ink = max(o.ink, ringLight * 0.7);
  col += vec3(0.85, 1.0, 1.0) * ringLight * 0.45;

  // The paper boat: once in a while (or now, on trigger) it rides the current across, entering
  // upstream and leaving downstream, rocking with the eddies. Real clock, so it sails at motion 0.
  if (K_current > 0.0) {
    float age = sinceTrigger(1);
    float lane = hash12(vec2(uTriggers[1], 61.0));
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
      vec4 shadowBoat = pondPaperBoat(rotate(p - at + towardSun * 0.012, -heading) / size, litSide);
      col *= 1.0 - 0.35 * shadowBoat.a;
      o.ink *= 1.0 - 0.4 * shadowBoat.a;
      // A faint V of wake trailing behind.
      vec2 w = rotate(p - at, -heading) / size;
      if (w.x < -1.0 && w.x > -5.0) {
        float wake = smoothfall(0.08, 0.0, abs(abs(w.y) - (-w.x - 1.0) * 0.32)) * (1.0 + (w.x + 1.0) / 4.0);
        o.ink = max(o.ink, wake * 0.35);
        col += vec3(0.85, 1.0, 1.0) * wake * 0.12;
      }
      vec4 boat = pondPaperBoat(w, litSide);
      if (boat.a > 0.0) {
        col = boat.rgb * (0.85 + 0.3 * power);
        o.ink = 0.55 + 0.4 * boat.r;
        o.accent = 0.0;
        o.shimmer = 0.0;
      }
    }
  }

  // The Manifold stone: a carved M standing in the water, its shadow on the floor and the water
  // lapping at its foot.
  if (K_stone > 0.0) {
    vec2 at = vec2(K_stoneX * aspect * 0.5, K_stoneY * 0.5);
    float scale = 0.16 + 0.34 * K_stone;
    float thickness = 0.12;
    // A hand-cut edge: the outline wavers a little, the way chiselled stone does.
    float d = markDistance((p - at) / scale) - thickness + (vnoise((p - at) / scale * 22.0) - 0.5) * 0.025;
    float shade = markDistance((p - at - vec2(0.025, -0.035)) / scale) - thickness;
    if (shade < 0.0 && d > 0.0) { col *= 0.55; o.ink *= 0.35; o.accent *= 0.4; }
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
      col = mix(granite, vec3(0.24, 0.48, 0.2) * (0.8 + 0.4 * fbm(q * 30.0)), growth);
      o.ink = mix(0.35 + 0.5 * light * grain, 0.22, growth);
      o.accent = 0.0;
      o.shimmer = 0.0;
    } else if (d < 0.07) {
      // Water lapping at the stone: a foam line and small waves running outward.
      float foam = smoothfall(0.03, 0.0, d) * (0.6 + 0.4 * vnoise(p * 140.0 + tm * 2.0));
      float lap = (0.5 + 0.5 * sin(d * 120.0 - tm * 3.0)) * smoothfall(0.07, 0.01, d) * 0.35;
      col = mix(col, vec3(0.92, 0.98, 0.97), max(foam, lap));
      o.ink = max(o.ink, max(foam, lap));
    }
  }

  // Foliage: border plants (in frame) and the canopy (above the camera). Both cast shadows away
  // from the sun and stand in the way of its rays.
  int style = int(K_plantStyle + 0.5);
  float wind = K_wind * m;
  float gust = 0.6 + 0.4 * vnoise(vec2(t * 0.25, 3.0));
  // Slow and wide enough to read as leaning in the breeze: a sway of only a cell or two, back and
  // forth quickly, reads as jitter once pixelated.
  vec2 sway = vec2(sin(t * 0.55 + uv.y * 3.0), cos(t * 0.45 + uv.x * 2.5)) * 0.008 * wind * gust;
  vec2 sunwardUV = normalize((sunUV - uv) * vec2(aspect, 1.0) + 1e-5) / vec2(aspect, 1.0);
  float canopySpan = 1.0 + 2.0 * ${CANOPY_MARGIN.toFixed(2)};
  float softness = K_canopySoft;
  float shadeAmount = 0.0;
  if (uSimOn.y > 0.5) {
    vec2 canopyUV = (pondFoliageWarp(uv + sunwardUV * (0.05 + 0.08 * softness) + sway * 2.2, canopyShift, 1.0) + ${CANOPY_MARGIN.toFixed(2)}) / canopySpan;
    float leaves = textureLod(uSim1, canopyUV, 0.3 + softness * 2.6).r;
    shadeAmount = max(shadeAmount, smoothstep(0.25 - 0.12 * softness, 0.6, leaves) * (0.85 - 0.25 * softness));
  }
  if (uSimOn.x > 0.5 && style != 1) {
    vec4 hanging = textureLod(uSim0, pondFoliageWarp(uv + sunwardUV * 0.035 + sway * 1.6, plantShift, 1.0), 2.5);
    shadeAmount = max(shadeAmount, smoothstep(0.08, 0.6, hanging.r) * 0.8);
  }
  col *= 1.0 - 0.6 * shadeAmount;
  o.ink *= 1.0 - 0.7 * shadeAmount;
  o.accent *= 1.0 - 0.5 * shadeAmount;

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
      if (uSimOn.x > 0.5) block = textureLod(uSim0, pondFoliageWarp(at + sway, plantShift, 1.0), 2.0).r;
      if (uSimOn.y > 0.5) block = max(block, smoothstep(0.15, 0.6, textureLod(uSim1, (pondFoliageWarp(at, canopyShift, 1.0) + ${CANOPY_MARGIN.toFixed(2)}) / canopySpan, 2.5).r));
      lit += (1.0 - block) * weight;
      total += weight;
      weight *= 0.93;
    }
    float angle = atan(uv.y - sunUV.y, (uv.x - sunUV.x) * aspect);
    float beams = 0.5 + 0.5 * vnoise(vec2(angle * 16.0 + tm * 0.04, tm * 0.08));
    float reachOfLight = exp(-length((uv - sunUV) * vec2(aspect, 1.0)) * 1.1);
    float rays = (lit / total) * beams * reachOfLight * K_rays * (0.35 + 1.3 * power);
    col += vec3(1.0, 0.95, 0.78) * rays * 0.55;
    o.ink += rays * 0.45;
  }
  // Glare where the sun itself is in frame.
  float glare = exp(-length(p - sunP) * 11.0) * power;
  col += vec3(1.0, 0.97, 0.85) * glare * 0.7;
  o.ink = max(o.ink, glare);

  if (uSimOn.x > 0.5 && style != 2) {
    // Each layer sways by its own amount: front to back, take the first texel that belongs to
    // the layer whose offset found it, so overlapping leaves never swap from frame to frame.
    vec4 leaf = vec4(0.0);
    float layer = 0.0;
    for (int l = 2; l >= 0; l--) {
      vec4 texel = pondDecorTexel(pondFoliageWarp(uv + sway * (0.5 + 0.5 * float(l)), plantShift, 0.7 + 0.15 * float(l)));
      if (texel.r > 0.5 && floor(mod(floor(texel.b * 255.0 + 0.5), 16.0) / 4.0) == float(l)) {
        leaf = texel;
        layer = float(l);
        break;
      }
    }
    if (leaf.r > 0.5) {
      // Materials (botany.ts): 0 monstera, 1 fern, 2 banana, 3 pothos, 4 hibiscus, 5 frangipani,
      // 6 pollen, 7 grass, 8 stem, 9 aerial root, 10 stigma.
      float code = floor(leaf.b * 255.0 + 0.5);
      float material = floor(code / 16.0);
      layer = floor(mod(code, 16.0) / 4.0);
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
      col = mix(dark, bright, leaf.g) * (0.72 + 0.14 * layer) * (0.85 + 0.35 * power) * (1.0 - 0.35 * shadeAmount);
      // Red blooms take the accent; everything else is ink, pale flowers brightest.
      bool red = (material > 3.5 && material < 4.5) || material > 9.5;
      o.ink = red ? 0.0 : (0.1 + 0.55 * leaf.g) * (0.72 + 0.14 * layer) + (material > 4.5 && material < 6.5 ? 0.35 : 0.0);
      o.accent = red ? 0.6 + 0.35 * leaf.g : 0.0;
      o.shimmer = 0.0;
    }
  }

  if (passing) {
    if (pout > 0.0) {
      // A breeze crossing the surface: a band of ruffled, darker water sweeping over, cut per cell.
      vec2 gustDir = normalize(vec2(0.9, 0.4));
      float span = 0.5 * (aspect * abs(gustDir.x) + abs(gustDir.y));
      float front = mix(-span - 0.55, span + 0.55, pout);
      lightK *= 1.0 - 0.08 * hardEdge(bell((dot(p, gustDir) - front) / 0.2) * 0.9);
    }
    col *= lightK;
    o.ink *= lightK;
    o.accent *= lightK;
  }

  o.shimmer = max(o.shimmer, caustic * 0.15);
  o.rgb = col;
  o.source = col;
  return o;
}
`;
