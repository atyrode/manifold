// The window-sill scene: a lo-fi evening seen from inside a dark room. A sash window raised onto a
// city at dusk; a cat on the sill watching it, a steaming mug, a plant, books, a stirring curtain;
// three rows of skyline with windows switching on and off, and across the street a neon Manifold M.
// Knobs arrive as K_<key> defines (see ./index.ts); the sky, weather and lightning come from the
// shared libraries (src/shaders/lib/); the scene's own motion runs on uMotionTime. In the window the
// shared sky components (src/scenes/README.md, "Composing components"): stars (K_stars), the moon in
// its phase (K_moon, SKY_MOON_PHASE), the aurora (K_aurora) and shooting stars (K_meteors).
// Rain and snow fall only outside the window, through the depth of the city, and the city answers
// them: an overcast sky, wet roofs and brick, drips and splashes, snow settling (uWeather).
// The cat's gaze is eased on the CPU (./index.ts) and read from uSim0.

import { glslFloat } from "../../shaders/glsl.ts";

/**
 * Seconds the entrance and the exit take (SceneDef.passage; the shader reads the same). In: the cat
 * hops up onto the sill and settles, its tail curling round. Out: it stretches and hops down out of
 * frame. At rest the cat is exactly as it always was.
 */
export const SILL_PASSAGE = { enter: 2.8, exit: 1.6 } as const;

/** Trigger slot of the shooting stars' "now" button (0 is the cat's, 1 lightning's, 2 the neon's). */
export const SILL_METEOR_TRIGGER = 3;

export const sillGlsl = `
// Where shooting stars set out: skyAngles of the view over the city (bearing, elevation, radians),
// high in the window.
const int SILL_METEOR_SLOT = ${SILL_METEOR_TRIGGER};
const vec4 SILL_METEOR_FIELD = vec4(-0.5, 0.3, 1.0, 0.12);
// Layout in screen heights from the centre, y up. The sill's top runs from the window (SILL_BACK)
// to its front edge (SILL_FRONT), then the nosing; things on it stand at SILL_SEAT. The lower sash
// is raised: its bottom rail spans SILL_RAIL..SILL_RAIL_TOP, open air below, glass above.
const float SILL_BACK = -0.265;
const float SILL_FRONT = -0.36;
const float SILL_NOSE = -0.384;
const float SILL_SEAT = -0.31;
const float SILL_RAIL = 0.155;
const float SILL_RAIL_TOP = 0.195;
const float SILL_HORIZON = -0.03;
const vec3 SILL_LAMP = vec3(1.0, 0.66, 0.34);
// Outside: a stone ledge runs from the window frame's own sill (SILL_BACK + 0.014) out to its lip
// (SILL_LEDGE), seen from above; water drips from the lintel over the window, just out of view
// (SILL_LINTEL). Rain and snow fall only out there, so the weather's depth runs from 0 at the
// window to 1 at the open sky, 1 - exp(-metres / 30): the ledge (0.4 m), the buildings across the
// street (16 m), the low blocks beyond (55 m) and the towers (120 m).
const float SILL_LEDGE = -0.239;
const float SILL_LINTEL = 0.56;
const float SILL_D_LEDGE = 0.013;
const float SILL_D_NEAR = 0.41;
const float SILL_D_MID = 0.84;
const float SILL_D_FAR = 0.98;

// ---- Shapes

// Polynomial smooth minimum (Inigo Quilez): unions two distance fields with a fillet of size k, so
// the cat's parts flow into one body instead of reading as stacked ellipses.
float sillSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Exact distance to a triangle (Quilez), either winding.
float sillTriangle(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec2 e0 = b - a;
  vec2 e1 = c - b;
  vec2 e2 = a - c;
  vec2 v0 = p - a;
  vec2 v1 = p - b;
  vec2 v2 = p - c;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

// ---- Time

// Occasional events: the clock is cut into slots of 'period' seconds, each holding one event at a
// random moment in its first half. Returns seconds since this slot's event (negative before it);
// 'pick' gets the slot's own random number, to vary or skip the event.
float sillEvent(float t, float period, float salt, out float pick) {
  float k = floor(t / period);
  pick = hash12(vec2(k, salt + 0.5));
  return t - (k + 0.05 + 0.45 * hash12(vec2(k, salt))) * period;
}

// A twitch: up in 'rise' seconds, held, back down over 'fall'; 0 before and after. Quick out,
// slower back: the feline rhythm.
float sillTwitch(float age, float rise, float hold, float fall) {
  return smoothstep(0.0, rise, age) * (1.0 - smoothstep(rise + hold, rise + hold + fall, age));
}

// Holds still, then moves to a new random setting over 'move' seconds, once per slot: how a cat
// looks around. Two independent values in -1..1.
vec2 sillGlance(float t, float period, float salt, float move) {
  float k = floor(t / period);
  float start = (k + 0.1 + 0.5 * hash12(vec2(k, salt))) * period;
  vec2 before = vec2(hash12(vec2(k - 1.0, salt + 1.0)), hash12(vec2(k - 1.0, salt + 2.0)));
  vec2 after = vec2(hash12(vec2(k, salt + 1.0)), hash12(vec2(k, salt + 2.0)));
  return mix(before, after, smoothstep(start, start + move, t)) * 2.0 - 1.0;
}

// ---- Light

// The lamp, out of frame to the right a little above the sill: inverse-square-like falloff,
// squashed vertically so its light spreads along the sill.
float sillLamp(vec2 p, float aspect) {
  vec2 d = (p - vec2(0.5 * aspect + 0.1, -0.2)) * vec2(1.0, 1.5);
  return 1.0 / (1.0 + dot(d, d) * 6.0);
}

// The room mirrored in the window glass, faint against the bright day and plainer at night: the
// lamp's drum shade glowing in the right-hand pane (centred at 'at'), its light spilling from the
// hem, a soft bloom below it and the warm room behind. Nearer than the city, it slides against it
// with the pointer.
vec3 sillMirror(vec2 p, vec2 at, float aspect, float dark) {
  vec2 r = p - at + uPointer * vec2(0.012, 0.005);
  float halfW = mix(0.034, 0.024, clamp(r.y / 0.044 + 0.5, 0.0, 1.0));
  float shade = 1.0 - smoothstep(-0.003, 0.005, max(abs(r.x) - halfW, abs(r.y) - 0.022));
  float hem = (1.0 - smoothstep(0.0, 0.007, abs(r.y + 0.024))) * (1.0 - smoothstep(0.03, 0.042, abs(r.x)));
  vec2 b = r + vec2(0.0, 0.032);
  float bloom = exp(-dot(b, b) / 0.004);
  float room = smoothstep(-0.2 * aspect, 0.5 * aspect, p.x);
  return SILL_LAMP * (shade * 0.11 + hem * 0.07 + bloom * 0.08 + room * 0.035) * (0.3 + 0.7 * dark);
}

// The neon sign's state: the brightness of each of the M's four strokes (left leg, left diagonal,
// right diagonal, right leg). The gas hums, a slow waver; every so often one stroke winks out for
// an instant; now and then, or on demand, one stutters as if its electrode were failing (uneven
// dropouts with a dim glow left in the tube, then a bright catch as it strikes again) while the
// rest dip on the shared transformer.
vec4 sillNeon(float tm, float power) {
  if (power <= 0.0) return vec4(0.0);
  float pick = 0.0;
  float age = sillEvent(tm, 26.0, 51.0, pick);
  float span = 0.5 + 1.1 * fract(pick * 7.3);
  float live = step(0.4, pick);
  float since = sinceTrigger(2);
  if (since >= 0.0 && since < 1.8) {
    age = since;
    span = 1.4;
    live = 1.0;
    pick = hash12(vec2(uTriggers[2], 5.0));
  }
  float burst = live * step(0.0, age) * step(age, span);
  // Dropouts of uneven length: the stutter's clock runs at a wavering (never reversing) rate.
  float beat = floor(age * 9.0 + 1.2 * sin(age * 5.0 + pick * 9.0));
  float on = step(0.4, hash12(vec2(beat, pick * 91.0)));
  float strike = sillTwitch(age - span, 0.03, 0.05, 0.25) * live;
  float bad = mix(1.0, 0.06 + 0.94 * on, burst) + 0.3 * strike;
  float rest = 1.0 - 0.12 * burst;
  float which = floor(fract(pick * 13.7) * 4.0);
  vec4 strokes = mix(vec4(rest), vec4(bad), vec4(equal(vec4(which), vec4(0.0, 1.0, 2.0, 3.0))));
  // The wink: one stroke out for a few frames, eased back.
  float pickW = 0.0;
  float winkAge = sillEvent(tm, 11.0, 57.0, pickW);
  float wink = sillTwitch(winkAge, 0.02, 0.04 + 0.06 * pickW, 0.12) * step(0.45, pickW);
  float winkAt = floor(fract(pickW * 5.1) * 4.0);
  strokes *= 1.0 - 0.75 * wink * vec4(equal(vec4(winkAt), vec4(0.0, 1.0, 2.0, 3.0)));
  float hum = 0.95 + 0.05 * sin(tm * 5.3) * sin(tm * 1.7 + 1.0);
  return strokes * power * hum;
}

// ---- Weather

// How heavy the weather overhead is. x: overcast 0..1 (any rain or snow closes the sky, a drizzle
// already greys it over); y: the fall's weight 0..1 (a downpour or a blizzard darkens and lowers it).
vec2 sillOvercast() {
  float storm = clamp(max(K_rain, 0.85 * K_snow), 0.0, 1.0);
  return vec2(clamp(storm * 10.0, 0.0, 1.0) * (0.65 + 0.35 * storm), storm);
}

// Rain shafts hanging under distant clouds, sp in sky coordinates: soft grey columns from the
// cloud base down past the horizon, leaning with the wind and drifting along with it, a faint
// grain of fall-streaks inside. 0..1.
float sillShafts(vec2 sp, float tm, float wind) {
  float h = sp.y - SILL_HORIZON;
  float x = sp.x + h * 0.3 * wind - tm * 0.012 * wind;
  float n = 0.65 * vnoise(vec2(x * 2.4, 3.1)) + 0.35 * vnoise(vec2(x * 6.5, 8.3));
  float hang = smoothfall(0.45, 0.15, h) * smoothstep(-0.15, 0.0, h);
  return smoothstep(0.5, 0.78, n) * hang * (0.75 + 0.25 * vnoise(vec2(x * 55.0, 4.7)));
}

// Lying snow lit by 'lit' (the light on a face turned to the sky), the city's orange glow thrown
// back up into it at night.
vec3 sillSnow(vec3 lit, float dark) {
  return vec3(0.82, 0.85, 0.93) * lit * 1.25 + vec3(0.17, 0.09, 0.06) * dark;
}

// Snow heaped on a ledge seen edge-on: coverage at 'above' (screen heights over the ledge's top),
// the heap up to 'deep' thick where snow lies fully, thinning to bare stretches as it settles or
// melts. x runs along the ledge in snowCover's units.
float sillCap(float above, float x, float deep, float lying, float px) {
  if (lying <= 0.0) return 0.0;
  float h = deep * snowCover(vec3(0.0, 1.0, 0.0), vec2(x, 0.37), lying);
  return smoothfall(0.6 * px, -0.6 * px, above - h) * step(-1.5 * px, above) * smoothstep(0.0, px, h);
}

// ---- The city

// A window's light. Each keeps its state for a minute or two, then may switch with a short fade:
// someone coming home, someone going to bed. Mostly warm lamps, some cool light, a few TVs.
vec3 sillWindow(vec2 id, float tm, float density) {
  float h = hash12(id);
  float period = 45.0 + 120.0 * hash12(id + 3.7);
  float s = tm / period + h;
  float k = floor(s);
  float now = step(hash12(id + vec2(k * 1.618, 0.31)), density);
  float before = step(hash12(id + vec2((k - 1.0) * 1.618, 0.31)), density);
  float lit = mix(before, now, smoothstep(0.0, 0.8, fract(s) * period));
  float hue = hash12(id + 9.1);
  vec3 c = vec3(1.0, 0.7, 0.36);
  if (hue > 0.5) c = vec3(1.0, 0.84, 0.58);
  if (hue > 0.78) c = vec3(0.72, 0.84, 1.0);
  if (hue > 0.93) c = vec3(0.42, 0.55, 1.0) * (0.7 + 0.3 * sin(tm * 2.1 + h * 40.0) * sin(tm * 0.83 + h * 17.0));
  return c * lit * (0.55 + 0.45 * hash12(id + 5.5));
}

// A pane centred in its grid cell: 'size' is its share of the cell, edges blurred over 'blur'
// (also in shares of the cell).
float sillPane(vec2 f, vec2 size, vec2 blur) {
  vec2 d = abs(f - 0.5) - size * 0.5;
  return softFill(d.x, blur.x) * softFill(d.y, blur.y);
}

// One row of buildings side by side in columns about w wide; the columns are warped (a monotonic
// sine offset) so widths vary. Returns how much of p is building, edges blurred by 'soft'. b gets
// the building's left and right edge and roof height and an id; x the warped x they are in.
float sillRow(vec2 p, float w, float lo, float hi, float salt, float soft, out vec4 b, out float x) {
  x = p.x + 0.3 * w * sin(p.x / w * 0.63 + salt);
  float c = floor(x / w);
  float h1 = hash12(vec2(c, salt));
  float h2 = hash12(vec2(c, salt + 1.3));
  float gap = w * 0.25 * h2 * h2;
  float x0 = c * w + gap * 0.5;
  float x1 = (c + 1.0) * w - gap * 0.5;
  float roof = mix(lo, hi, pow(h1, 1.3));
  b = vec4(x0, x1, roof, c + salt * 97.0);
  return smoothstep(-soft, soft, min(min(x - x0, x1 - x), roof - p.y));
}

// Everything beyond the window at p: sky, three rows of buildings sliding against each other with
// the pointer, the street's glow, the building across the street and its neon M, the stone ledge
// under the window, and the weather in the air between. 'soft' blurs every edge (wet glass, rain in
// the air); 'opening' is the open window's span in x. Rain and snow fall only out here, each
// pixel's drops and flakes ending at the first surface ('depth'). The world wets as it rains
// (uWeather.x): brick darkens, roofs shine and pool water that mirrors the sign, edges drip, the
// ledge splashes; snow settles on every face turned to the sky (uWeather.y). Returns colour, and
// the neon's accent coverage in .a.
vec4 sillCity(vec2 p, float aspect, float t, float tm, float px, float soft, Sky sky, vec3 haze, float dark, vec2 signAt, vec2 opening, vec4 neon, float boltAge, float boltSeed, float flash) {
  float density = K_lights;
  vec2 ov = sillOvercast();
  float wet = uWeather.x;
  float lying = uWeather.y;
  // Edges drip while it rains, on as the world dries, and from melting snow once a fall is over;
  // as that tails off, drip points fall silent one by one (dripOn: the share still dripping).
  float drip = max(max(K_rain, 0.4 * wet), 0.5 * lying * (1.0 - smoothstep(0.0, 0.1, K_snow)));
  float dripOn = smoothstep(0.02, 0.2, drip);
  vec3 up = vec3(0.0, 1.0, 0.0);
  float accent = 0.0;
  float neonMean = dot(neon, vec4(0.25));
  float depth = 1.0;

  // Sky: gradient, moon, stars and cloud deck from the shared library, lightning behind it all,
  // and the city's own glow low down. Rain or snow closes it over: a grey deck, darker and lower
  // the heavier the fall (its features loom larger and it reaches nearer the horizon), lit orange
  // from below by the streets at night, more with snow on the ground to throw their light back up.
  vec2 sp = p + uPointer * vec2(0.03, 0.012);
  vec3 dir = viewRay(sp / vec2(aspect, 1.0) + 0.5, aspect, 0.5 + SILL_HORIZON, 1.0);
  vec3 col = skyColor(sky, dir);
  col += vec3(0.85, 0.88, 1.0) * skyStars(sky, dir, K_stars) * (1.0 - 0.7 * smoothstep(0.001, 0.006, soft)) * (1.0 - ov.x);
  // The giant planet among the stars; the aurora over the city, and shooting stars in the gaps of
  // the deck, softened with the rest.
  float foot = max(2.0 * tan(0.5) / uRes.y, soft);
  col = skyGiant(sky, col, dir, foot, 1.0);
  col += auroraM(dir, tm, K_aurora, foot) * auroraSeen(sky, ov.x);
  vec3 deck = haze * (0.85 - 0.3 * ov.y) + vec3(0.3, 0.15, 0.1) * dark * (0.3 * ov.x + 0.25 * lying);
  col = mix(col, deck, 0.85 * ov.x);
  float clouds = max(K_clouds, ov.x);
  float cloudCover = 0.0;
  if (clouds > 0.0) {
    vec4 cloud = skyClouds(sky, normalize(vec3(dir.x, dir.y * (1.0 + 1.5 * ov.y), dir.z)), t, clouds, K_wind);
    col = mix(col, (cloud.rgb + vec3(0.22, 0.11, 0.07) * dark * 0.5) * (1.0 - 0.4 * ov.y), cloud.a);
    cloudCover = cloud.a;
  }
  float meteorSeed;
  float meteorAt = meteorAge(tm, K_meteors, SILL_METEOR_SLOT, meteorSeed);
  float meteor = meteorStreak(skyAngles(dir), SILL_METEOR_FIELD, meteorAt, meteorSeed, foot);
  col += METEOR_TINT * hardEdge(meteor * auroraSeen(sky, max(cloudCover, ov.x)) * (1.0 - 0.7 * smoothstep(0.001, 0.006, soft)));
  if (boltAge < 1.5) {
    vec2 top = vec2((hash12(vec2(boltSeed, 1.3)) - 0.5) * aspect * 0.8, 0.6);
    vec2 ground = vec2(top.x + (hash12(vec2(boltSeed, 2.7)) - 0.5) * 0.35, -0.05);
    col += vec3(0.75, 0.8, 1.0) * lightningBolt(sp, top, ground, boltSeed, boltAge);
  }
  col += vec3(0.4, 0.45, 0.6) * flash * 0.45;
  col += vec3(0.6, 0.3, 0.2) * exp(-max(sp.y - SILL_HORIZON + 0.1, 0.0) * 6.0) * dark * 0.25;
  col = mix(col, haze, fogAmount(K_fog, 1.0, clamp((sp.y - SILL_BACK) * 1.5, 0.0, 1.0)));

  // Far: towers in the haze; the tallest have a setback crown and a mast. Aircraft warning lights
  // on the masts (tip and halfway up) and on the corners of the taller flat roofs blink in three
  // synchronised groups: on for under a second, off a little longer, each flash eased in and out.
  // Snow lines their roofs and setbacks.
  vec2 fp = p + uPointer * vec2(0.022, 0.009);
  vec4 b = vec4(0.0);
  float x = 0.0;
  float cover = sillRow(fp, 0.062, -0.07, 0.16, 3.0, soft, b, x);
  float lightD = 1.0;
  float roofGap = b.z - fp.y;
  if (hash12(vec2(b.w, 4.0)) > 0.78) {
    float inset = (b.y - b.x) * 0.22;
    float inCrown = min(x - b.x - inset, b.y - inset - x);
    float crown = min(inCrown, b.z + 0.05 - fp.y);
    float mastX = 0.5 * (b.x + b.y);
    float mast = min(0.0018 - abs(x - mastX), b.z + 0.105 - fp.y);
    cover = max(cover, smoothstep(-soft, soft, max(crown, mast)));
    lightD = min(length(vec2(x - mastX, fp.y - b.z - 0.107)), length(vec2(x - mastX, fp.y - b.z - 0.078)) + 0.0008);
    if (inCrown > 0.0) roofGap += 0.05;
  } else if (b.z > 0.085) {
    lightD = length(vec2(min(x - b.x, b.y - x) - 0.004, fp.y - b.z - 0.002));
  }
  float beat = fract(tm / 2.2 + floor(hash12(vec2(b.w, 6.0)) * 3.0) / 3.0);
  float beacon = smoothstep(0.0, 0.08, beat) * (1.0 - smoothstep(0.3, 0.48, beat));
  float red = (1.0 - smoothstep(0.0025, 0.0045 + soft, lightD) + exp(-lightD / 0.01) * 0.3) * beacon * (0.4 + 0.6 * dark);
  vec3 lit = sky.ambient + sky.sunColor * sky.day * 0.3 + vec3(0.03, 0.03, 0.045);
  vec3 facade = wetten(vec3(0.3, 0.32, 0.42), wet, 0.3) * lit;
  vec2 g = vec2((x - b.x) / 0.011, (b.z - fp.y) / 0.014);
  float rows = step(0.004, x - b.x) * step(0.004, b.y - x) * step(0.012, b.z - fp.y);
  float pane = sillPane(fract(g), vec2(0.5, 0.42), vec2(0.6 * px + soft) / vec2(0.011, 0.014));
  facade += sillWindow(vec2(b.w * 31.0 + floor(g.x), floor(g.y) + 300.0), tm, density) * pane * rows * 0.7 * (0.3 + 0.7 * dark);
  float cap = step(0.0, roofGap) * (1.0 - smoothstep(0.002, 0.0045, roofGap));
  if (cap > 0.0 && lying > 0.0) facade = mix(facade, sillSnow(lit, dark), cap * snowCover(up, vec2(x * 30.0, b.w), lying));
  facade = mix(facade, haze, 0.38 + 0.3 * smoothfall(0.05, -0.2, fp.y));
  facade = mix(facade, haze, fogAmount(K_fog, 0.85, clamp((fp.y - SILL_BACK) * 1.5, 0.0, 1.0)));
  col = mix(col, facade, cover);
  depth = mix(depth, SILL_D_FAR, cover);
  col += vec3(1.0, 0.12, 0.08) * red;

  // Middle: lower blocks with flat roofs, water tanks standing on legs. From up here we look down
  // on the roofs, a band along each top facing the sky: wet, it shines with the overcast, brightest
  // where water pools; snow lies on it and on the tanks' conical lids.
  vec2 mp = p + uPointer * vec2(0.015, 0.006);
  cover = sillRow(mp, 0.14, -0.2, -0.03, 7.0, soft, b, x);
  float tank = 0.0;
  float lid = 0.0;
  if (hash12(vec2(b.w, 9.0)) > 0.4) {
    vec2 tq = vec2(x - mix(b.x + 0.035, b.y - 0.035, hash12(vec2(b.w, 10.0))), mp.y - b.z);
    float legs = min(0.0017 - abs(abs(tq.x) - 0.012), min(tq.y + 0.002, 0.017 - tq.y));
    float barrel = min(0.017 - abs(tq.x), min(tq.y - 0.015, 0.047 - tq.y));
    float cone = min(0.019 * (1.0 - (tq.y - 0.047) / 0.015) - abs(tq.x), tq.y - 0.046);
    tank = smoothstep(-soft, soft, max(max(legs, barrel), cone));
    if (lying > 0.0) lid = smoothstep(0.048, 0.051, tq.y) * snowCover(vec3(0.0, 0.75, 0.66), vec2(tq.x * 60.0, b.w), lying);
  }
  lit = sky.ambient + sky.sunColor * sky.day * 0.35 + vec3(0.025, 0.025, 0.04);
  facade = wetten(vec3(0.24, 0.22, 0.28), wet, 0.4) * lit;
  g = vec2((x - b.x) / 0.02, (b.z - mp.y) / 0.026);
  rows = step(0.006, x - b.x) * step(0.006, b.y - x) * step(0.014, b.z - mp.y);
  pane = sillPane(fract(g), vec2(0.52, 0.48), vec2(0.6 * px + soft) / vec2(0.02, 0.026));
  facade += sillWindow(vec2(b.w * 37.0 + floor(g.x), floor(g.y) + 700.0), tm, density) * pane * rows * (0.3 + 0.7 * dark);
  facade += vec3(0.5, 0.26, 0.14) * exp(-(mp.y - SILL_BACK) / 0.1) * dark * 0.25 * (1.0 + 0.8 * wet + 0.6 * lying);
  float band = clamp((SILL_HORIZON - b.z) * 0.12, 0.0, 0.012);
  if (band > 1.5 * px) {
    vec3 roof = wetten(vec3(0.2, 0.19, 0.21), wet, 0.2) * lit * 1.15;
    float pool = rainPuddles(vec2(x * 60.0, (mp.y - b.z) / band * 3.0 + b.w), wet);
    roof = mix(roof, deck * 0.8, max(wetGloss(wet, 1.0) * 0.6, pool * 0.85));
    if (lying > 0.0) roof = mix(roof, sillSnow(lit * 1.15, dark), snowCover(up, vec2(x * 30.0, (mp.y - b.z) / band * 4.0 + b.w), lying));
    facade = mix(facade, roof, smoothstep(-0.5 * px, 0.5 * px, mp.y - b.z + band));
  }
  facade = mix(facade, wetten(vec3(0.32, 0.22, 0.15), wet, 0.7) * lit * 1.2 + vec3(0.14, 0.07, 0.04) * dark, tank);
  facade = mix(facade, sillSnow(lit, dark), lid * tank);
  facade = mix(facade, haze, 0.18 + fogAmount(K_fog, 0.6, clamp((mp.y - SILL_BACK) * 1.5, 0.0, 1.0)));
  col = mix(col, facade, max(cover, tank));
  depth = mix(depth, SILL_D_MID, max(cover, tank));

  // The street below, out of sight: its traffic glow rising between the buildings, swelling
  // slowly as cars pass; brighter off wet tarmac or fresh snow.
  float street = exp(-max(p.y - SILL_BACK, 0.0) / 0.07);
  float traffic = 0.8 + 0.2 * sin(p.x * 9.0 - tm * 0.6) * sin(p.x * 3.7 + tm * 0.37);
  col += vec3(1.0, 0.52, 0.28) * street * traffic * (0.06 + 0.3 * dark) * (1.0 + 0.7 * wet + 0.6 * lying);

  // Across the street: a tall neighbour on the left, and the low building carrying the sign, its
  // roof deck in view from up here. Wet, their brick darkens and water drips off the cornice and
  // the parapet, catching the grey sky and the street's glow; snow heaps along their tops.
  vec2 np = p + uPointer * vec2(0.009, 0.004);
  lit = sky.ambient * 1.2 + sky.sunColor * sky.day * 0.4 + vec3(0.03, 0.025, 0.035);
  vec3 snowLit = sillSnow(lit, dark);
  vec3 dripLit = deck * 1.4 + vec3(1.0, 0.6, 0.35) * (0.04 + 0.1 * dark);
  float nearFog = fogAmount(K_fog, 0.3, clamp((np.y - SILL_BACK) * 1.5, 0.0, 1.0));
  float roofBack = signAt.y - 0.062;
  float roofFront = roofBack - 0.036;
  float ax0 = signAt.x - 0.32;
  float ax1 = signAt.x + 0.27;
  float bx1 = ax0 - 0.014;
  float roofB = 0.035;
  float body = min(bx1 - np.x, roofB - np.y);
  float corniceBand = min(bx1 + 0.006 - np.x, min(roofB + 0.006 - np.y, np.y - roofB + 0.012));
  float coverB = smoothstep(-soft, soft, max(body, corniceBand));
  if (coverB > 0.0) {
    vec3 c = wetten(vec3(0.3, 0.2, 0.18), wet, 0.6) * lit * (corniceBand > 0.0 ? 1.4 : 1.0);
    vec2 gb = vec2((bx1 - np.x) / 0.05, (roofB - 0.02 - np.y) / 0.064);
    float pb = sillPane(fract(gb), vec2(0.46, 0.58), vec2(0.6 * px + soft) / vec2(0.05, 0.064)) * step(0.0, gb.y) * step(0.3, gb.x);
    c += sillWindow(floor(gb) + vec2(900.0, 0.0), tm, density * 0.8) * pb * (0.25 + 0.75 * dark);
    if (lying > 0.0) {
      // Snow along the window sills.
      vec2 fb = fract(gb);
      float ledge = step(abs(fb.x - 0.5), 0.26) * step(0.79, fb.y) * step(fb.y, 0.87) * step(0.0, gb.y) * step(0.3, gb.x);
      c = mix(c, snowLit, ledge * snowCover(up, vec2(np.x * 20.0, floor(gb.y) * 3.0), lying));
    }
    c += vec3(0.5, 0.26, 0.14) * exp(-(np.y - SILL_BACK) / 0.12) * dark * 0.3 * (1.0 + 0.8 * wet + 0.6 * lying);
    col = mix(col, mix(c, haze, 0.06 + nearFog), coverB);
  }
  depth = mix(depth, SILL_D_NEAR + 0.04, coverB);
  if (dripOn > 0.0 && np.x < bx1 + 0.006) {
    float lane = step(hash12(vec2(floor(np.x / 0.03), 5.3)), dripOn);
    col = mix(col, mix(dripLit, haze, nearFog), rainDrips(vec2(np.x, roofB - 0.012 - np.y), t, drip, 0.03) * lane * 0.85);
  }
  float capB = sillCap(np.y - roofB - 0.006, np.x * 20.0, 0.007, lying, px) * softFill(np.x - bx1 - 0.006, soft);
  col = mix(col, mix(snowLit, haze, 0.06 + nearFog), capB);
  depth = mix(depth, SILL_D_NEAR + 0.04, capB);

  float coverA = smoothstep(-soft, soft, min(min(np.x - ax0, ax1 - np.x), roofBack - np.y));
  if (coverA > 0.0) {
    vec3 c = vec3(0.0);
    float a = 0.0;
    if (np.y > roofFront + 0.008) {
      // The roof deck: tar washed pink by the sign. Wet, it shines, and water pooling in its
      // hollows mirrors the M and the lit windows beyond, drawn down into streaks and broken by
      // rings where the rain lands. Snow covers it.
      float deckDepth = (np.y - roofFront - 0.008) / (roofBack - roofFront - 0.008);
      vec2 ground = vec2(np.x * 40.0, deckDepth * 3.0);
      c = wetten(vec3(0.1, 0.09, 0.1), wet, 0.2) * lit;
      float wash = exp(-abs(np.x - signAt.x) * 7.0) * neonMean * (0.4 + 0.6 * deckDepth) * (0.35 + 0.65 * dark);
      c += uAccent * wash * 0.18;
      a = wash * 0.15;
      if (wet > 0.0) {
        float pool = rainPuddles(ground, wet);
        float gloss = max(wetGloss(wet, 1.0), pool);
        vec3 ripple = rainRipples(np * 14.0, t, K_rain);
        vec2 rq = (vec2(np.x + ripple.x * 0.006, roofBack + (roofBack - np.y) * 2.4) - signAt) / 0.1;
        vec4 rd = vec4(segmentDistance(rq, M0, M1), segmentDistance(rq, M1, M2), segmentDistance(rq, M2, M3), segmentDistance(rq, M3, M4));
        vec4 rg = exp(-rd * 10.0) * neon;
        float mirrored = (max(rg.x, rg.y) + max(rg.z, rg.w)) * gloss * 0.6;
        float lights = smoothstep(0.55, 0.9, vnoise(vec2((np.x + ripple.x * 0.004) * 40.0, 2.3))) * density * (0.3 + 0.7 * dark);
        c += deck * 0.12 * gloss + vec3(1.0, 0.72, 0.45) * lights * 0.12 * gloss + uAccent * mirrored + vec3(0.6, 0.65, 0.75) * ripple.z * max(pool, 0.3 * wet) * 0.2;
        a = max(a, mirrored * 0.8);
      }
      float snowy = snowCover(up, ground, lying);
      c = mix(c, snowLit + uAccent * wash * 0.6, snowy);
      a = mix(a, wash * 0.3, snowy);
    } else {
      // The facade: brick, a parapet along the top (snow on its coping), one row of tall windows
      // with blinds.
      float parapet = step(roofFront, np.y);
      c = wetten(vec3(0.36, 0.2, 0.15), wet, 0.6) * lit * (1.0 + 0.5 * parapet);
      c += uAccent * parapet * neonMean * 0.12 * exp(-abs(np.x - signAt.x) * 5.0);
      if (lying > 0.0) c = mix(c, snowLit, step(roofFront + 0.0055, np.y) * snowCover(up, vec2(np.x * 20.0, 0.8), lying));
      float gx = (np.x - ax0) / 0.058;
      vec2 wq = vec2((fract(gx) - 0.5) * 0.058, np.y + 0.2265);
      float win = smoothfall(soft + 0.6 * px, -soft - 0.6 * px, sdBox(wq, vec2(0.013, 0.0285), 0.0));
      win *= step(0.5, gx) * step(gx, (ax1 - ax0) / 0.058 - 0.5);
      float slats = 0.75 + 0.25 * step(0.5, fract(np.y / 0.009));
      c = mix(c, vec3(0.02, 0.02, 0.03) + sillWindow(vec2(floor(gx) + 500.0, 3.0), tm, density) * slats * (0.3 + 0.7 * dark), win);
      c += vec3(0.6, 0.3, 0.15) * exp(-(np.y - SILL_BACK) / 0.08) * dark * 0.35 * (1.0 + 0.8 * wet + 0.6 * lying);
    }
    col = mix(col, mix(c, haze, 0.04 + nearFog), coverA);
    accent = mix(accent, a, coverA);
    if (dripOn > 0.0) {
      // Off the parapet's coping, pink in the sign's light.
      float lane = step(hash12(vec2(floor((np.x - ax0) / 0.03), 6.1)), dripOn);
      float d = rainDrips(vec2(np.x - ax0, roofFront - np.y), t, drip, 0.03) * lane * step(ax0 + 0.004, np.x) * step(np.x, ax1 - 0.004) * coverA;
      col = mix(col, mix(dripLit + uAccent * neonMean * 0.5 * (0.35 + 0.65 * dark), haze, nearFog), d * 0.85);
      accent = max(accent, d * neonMean * 0.4);
    }
  }
  depth = mix(depth, SILL_D_NEAR, coverA);

  // The sign: a steel frame on the roof, snow along its top bar, the M in neon tubes in front of
  // it, each stroke lit on its own (unlit glass still shows when one stutters). Round it the air
  // glows with the hum, slowly swelling and settling, more in fog, rain or snow.
  vec2 sq = np - signAt;
  float frameD = max(
    min(0.0024 - abs(abs(sq.x) - 0.066), min(sq.y + 0.062, 0.058 - sq.y)),
    min(0.0024 - abs(abs(sq.y + 0.002) - 0.056), 0.068 - abs(sq.x)));
  float frame = smoothstep(-soft, soft, frameD);
  col = mix(col, vec3(0.24, 0.2, 0.24) * lit + uAccent * neonMean * 0.25, frame);
  float capS = sillCap(sq.y - 0.0564, np.x * 20.0, 0.005, lying, px) * step(abs(sq.x), 0.0685);
  col = mix(col, snowLit + uAccent * neonMean * 0.4 * (0.35 + 0.65 * dark), capS);
  vec2 mq = sq / 0.1;
  vec4 ds = vec4(segmentDistance(mq, M0, M1), segmentDistance(mq, M1, M2), segmentDistance(mq, M2, M3), segmentDistance(mq, M3, M4));
  float edge = (soft + 0.6 * px) / 0.1;
  vec4 tube = 1.0 - smoothstep(vec4(0.045 - edge), vec4(0.045 + edge), ds);
  vec4 tubeLit = tube * neon;
  float core = min(max(max(tubeLit.x, tubeLit.y), max(tubeLit.z, tubeLit.w)), 1.0);
  vec4 sg = exp(-ds * 7.0) * neon;
  float glow = max(sg.x, sg.y) + max(sg.z, sg.w);
  vec4 sh = exp(-ds * 2.2) * neon;
  float halo = (max(sh.x, sh.y) + max(sh.z, sh.w)) * (0.35 + 0.65 * dark);
  float swell = 0.8 + 0.2 * sin(tm * 1.3) * sin(tm * 0.47 + 2.0);
  float air = exp(-min(min(ds.x, ds.y), min(ds.z, ds.w)) * 1.1) * neonMean * swell * (0.3 + 0.7 * dark) * (1.0 + 1.5 * K_fog + 1.4 * K_rain + 0.8 * K_snow);
  float glass = max(max(tube.x, tube.y), max(tube.z, tube.w));
  col = mix(col, vec3(0.16, 0.09, 0.12), glass * 0.8);
  col += uAccent * (glow * 0.45 + halo * 0.12 + air * 0.07);
  col = mix(col, mix(uAccent, vec3(1.0), 0.55), core);
  accent = max(accent, max(core, min(glow * 0.6 + halo * 0.15 + air * 0.05, 1.0)));
  depth = mix(depth, SILL_D_NEAR + 0.02, max(max(frame, capS), glass));

  // The light a raindrop shows: each one refracts the bright overcast, so about 1.2 x the cloud
  // base, plus what shines round it (the street's glow low down, the sign's pink near it,
  // lightning), never quite dark at night. Streaks, splashes and drips all take it.
  vec3 rainLight = max(deck * 1.2 + vec3(1.0, 0.52, 0.28) * street * (0.06 + 0.3 * dark) + uAccent * air * 0.5 + vec3(0.45, 0.5, 0.65) * flash * 0.6, vec3(0.08));

  // The stone ledge outside the window, seen from above past the frame's own sill, in the room's
  // light spilling out. Wet, it darkens and at this grazing angle mirrors the city: its lights
  // drawn into streaks, the grey sky, the sign's pink right below the sign; water pools on it,
  // ringing and splashing where the rain lands. Snow heaps up on it, deepest in the corners
  // against the reveals.
  float spill = sillLamp(p, aspect);
  float ledge0 = SILL_BACK + 0.014;
  float heap = 0.0;
  if (lying > 0.0 && p.y < SILL_LEDGE + 0.02) {
    float corner = min(exp(-(p.x - opening.x) / 0.035) + exp(-(opening.y - p.x) / 0.035), 1.0);
    heap = (0.004 + 0.012 * corner) * snowCover(up, vec2(p.x * 15.0, 1.3), lying);
  }
  float onLedge = smoothfall(0.6 * px, -0.6 * px, p.y - SILL_LEDGE - heap);
  if (onLedge > 0.0) {
    float v = clamp((p.y - ledge0) / (SILL_LEDGE - ledge0), 0.0, 1.0);
    vec3 light = sky.ambient * 1.2 + sky.sunColor * sky.day * 0.25 + SILL_LAMP * spill * 0.5 + vec3(0.03, 0.03, 0.04);
    vec3 c = wetten(vec3(0.44, 0.41, 0.37), wet, 0.35) * light * (0.8 + 0.25 * v);
    c += light * 0.1 * smoothstep(0.75, 1.0, v);
    float mirrored = 0.0;
    if (wet > 0.0) {
      float pool = rainPuddles(vec2(p.x * 20.0, v * 1.5), wet);
      float gloss = max(wetGloss(wet, 1.0), pool);
      float lights = smoothstep(0.55, 0.9, vnoise(vec2(p.x * 24.0, 0.5))) * density * (0.3 + 0.7 * dark);
      mirrored = neonMean * exp(-abs(p.x - signAt.x) * 6.0) * (0.35 + 0.65 * dark) * gloss;
      c = mix(c, deck * 0.6 + vec3(1.0, 0.72, 0.45) * lights * 0.25, gloss * 0.65);
      c += uAccent * mirrored * 0.45;
      if (K_rain > 0.0) {
        c += vec3(0.6, 0.65, 0.75) * rainRipples(p * 60.0, t, K_rain).z * pool * 0.25;
        // Splash crowns, flattened by the grazing view of the ledge: ~30 cells to the unit across
        // it, ~15 into it at 540 rows.
        c += (rainLight + SILL_LAMP * spill * 0.6) * rainSplashes(vec2(p.x * 18.0, p.y * 36.0), t, K_rain);
      }
    }
    float snowy = snowCover(up, vec2(p.x * 15.0, v * 0.6), lying);
    if (heap > 0.0) snowy = max(snowy, smoothstep(SILL_LEDGE - 0.5 * px, SILL_LEDGE + 0.5 * px, p.y));
    c = mix(c, sillSnow(light, dark), snowy);
    col = mix(col, c, onLedge);
    accent = mix(accent, mirrored * 0.4 * (1.0 - snowy), onLedge);
    depth = mix(depth, SILL_D_LEDGE, onLedge);
  }

  // The weather in the air between the window and the first surface beyond it: the veil first,
  // then the drops in their own light, the nearest out-of-focus ones a little dimmer but catching
  // the room's lamp just outside the window. Beyond the low blocks, rain shafts hang under the
  // clouds.
  vec2 wuv = (p + uPointer * vec2(0.012, 0.005)) / vec2(aspect, 1.0) + 0.5;
  vec3 airCol = mix(haze, deck, 0.6 * ov.x) + vec3(1.0, 0.52, 0.28) * street * (0.03 + 0.15 * dark) + uAccent * air * 0.3 + vec3(0.45, 0.5, 0.65) * flash * 0.4;
  if (K_rain > 0.0) {
    Precip fall = rainFall(wuv, aspect, t, K_rain, K_wind, depth);
    float shafts = sillShafts(sp, tm, K_wind) * smoothstep(0.1, 0.5, K_rain) * smoothstep(0.86, 0.97, depth);
    fall.veil = 1.0 - (1.0 - fall.veil) * (1.0 - 0.5 * shafts);
    accent *= 1.0 - 0.7 * fall.veil;
    vec3 drop = rainLight * (1.0 - 0.2 * fall.near) + SILL_LAMP * spill * 0.9 * fall.near;
    col = precipOver(col, airCol, drop, fall);
  }
  if (K_snow > 0.0) {
    Precip fall = snowFall(wuv, aspect, t, K_snow, K_wind, depth);
    vec3 flake = vec3(0.8, 0.82, 0.9) * (0.38 + 0.5 * sky.day * (1.0 - 0.3 * ov.y)) + vec3(0.14, 0.07, 0.04) * dark + uAccent * air * 0.5 + SILL_LAMP * spill * 0.9 * fall.near + vec3(0.5) * flash;
    accent *= 1.0 - 0.7 * fall.veil;
    col = precipOver(col, mix(airCol, flake, 0.5), flake, fall);
  }

  // Water off the lintel above the window, dripping past it onto the ledge from the spots where it
  // gathers (about half the 0.05-wide lanes along it). The edge's units are stretched downward so
  // each drop stays a couple of cells wide, is drawn out into a streak by its fall and reaches the
  // ledge before it fades.
  if (dripOn > 0.0) {
    float lane = step(hash12(vec2(floor(p.x / 0.05), 8.1)), 0.55 * dripOn);
    float d = rainDrips(vec2(p.x / 0.05, (SILL_LINTEL - p.y) / 0.27), t, drip, 1.0) * lane * smoothstep(ledge0, SILL_LEDGE, p.y);
    col = mix(col, rainLight * 1.1 + SILL_LAMP * spill * 0.9, d);
    accent *= 1.0 - d;
  }
  return vec4(col, clamp(accent, 0.0, 1.0));
}

// ---- The room

// The mug: a glazed cylinder seen a little from above, its handle toward the lamp, coffee inside.
// q is relative to its foot. Returns colour and coverage.
vec4 sillMug(vec2 q, vec3 light, vec3 cool, float px) {
  float r = 0.026;
  float top = 0.064;
  float ry = 0.0075;
  float foot = ry - ry * sqrt(max(1.0 - (q.x / r) * (q.x / r), 0.0));
  float body = max(abs(q.x) - r, max(foot - q.y, q.y - top));
  float lid = sdEllipse(q - vec2(0.0, top), vec2(r, ry));
  float handle = max(abs(length((q - vec2(r + 0.004, top * 0.52)) * vec2(1.0, 0.87)) - 0.016) - 0.0045, r - 0.003 - q.x);
  float cover = softFill(min(min(body, lid), handle), px);
  if (cover <= 0.0) return vec4(0.0);
  float nx = handle < min(body, lid) ? 1.0 : clamp(q.x / r, -1.0, 1.0);
  vec3 glaze = vec3(0.86, 0.8, 0.7);
  vec3 c = glaze * light * (0.5 + 0.9 * clamp(0.45 + 0.6 * nx, 0.0, 1.0));
  c += light * 0.45 * smoothfall(0.18, 0.0, abs(nx - 0.55));
  c += cool * 0.3 * smoothfall(-0.4, -1.0, nx);
  float coffee = sdEllipse(q - vec2(0.0, top), vec2(r - 0.004, ry - 0.0025));
  if (lid < 0.0) {
    c = coffee < 0.0
      ? vec3(0.13, 0.07, 0.04) * (0.4 + light) + light * 0.25 * smoothfall(0.004, 0.0, length(q - vec2(0.008, top + 0.001)))
      : glaze * light * 1.1;
  }
  return vec4(c, cover);
}

// A short stack of books lying flat, spines toward the room, the top one's cover in view.
// q is relative to the foot of the stack.
vec4 sillBooks(vec2 q, vec3 light, float px) {
  vec4 o = vec4(0.0);
  float y0 = 0.0;
  float off = 0.0;
  vec3 bc = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float th = 0.021 - 0.003 * fi;
    float w = 0.064 - 0.006 * fi;
    off = (hash12(vec2(fi, 7.0)) - 0.5) * 0.022;
    bc = i == 0 ? vec3(0.5, 0.13, 0.11) : i == 1 ? vec3(0.74, 0.54, 0.2) : vec3(0.12, 0.31, 0.33);
    vec2 bq = q - vec2(off, y0 + th * 0.5);
    float cover = softFill(sdBox(bq, vec2(w, th * 0.5), 0.0) - 0.0015, px);
    if (cover > 0.0) {
      float across = bq.y / (th * 0.5);
      float bulge = 0.75 + 0.25 * sqrt(max(1.0 - across * across, 0.0));
      vec3 c = bc * light * bulge * (0.55 + 0.45 * smoothstep(-w, w, bq.x));
      float label = step(abs(bq.x + w * 0.35), 0.012) * step(abs(across), 0.55);
      c = mix(c, vec3(0.85, 0.75, 0.5) * light * 0.8, label * 0.7);
      o = vec4(mix(o.rgb, c, cover), max(o.a, cover));
    }
    y0 += th;
  }
  // The top cover, seen from above and catching the lamp.
  float cover = softFill(sdBox(q - vec2(off, y0 + 0.0055), vec2(0.05, 0.0055), 0.0) - 0.001, px);
  o = vec4(mix(o.rgb, bc * light * 1.25, cover), max(o.a, cover));
  return o;
}

// A potted plant: a terracotta pot and a fan of long arching leaves nodding in the breeze, lit
// faintly from the room and rimmed by the window behind. q is relative to the pot's foot.
vec4 sillPlant(vec2 q, float tm, float breeze, vec3 light, vec3 cool, float px) {
  vec4 o = vec4(0.0);
  // The pot, its rim standing proud, soil seen from above.
  float potW = mix(0.03, 0.037, clamp(q.y / 0.065, 0.0, 1.0));
  float pot = softFill(max(abs(q.x) - potW, max(-q.y, q.y - 0.058)), px);
  float rimBand = softFill(max(abs(q.x) - 0.042, abs(q.y - 0.064) - 0.008), px);
  float potCover = max(pot, rimBand);
  if (potCover > 0.0) {
    float nx = q.x / 0.042;
    vec3 c = vec3(0.58, 0.3, 0.18) * light * (0.6 + 0.5 * clamp(0.5 + 0.6 * nx, 0.0, 1.0));
    c *= rimBand > pot ? 1.15 : 1.0 - 0.3 * smoothstep(0.05, 0.056, q.y);
    c += cool * 0.2 * smoothfall(-0.5, -1.0, nx);
    o = vec4(c, potCover);
  }
  float soil = softFill(sdEllipse(q - vec2(0.0, 0.07), vec2(0.035, 0.006)), px);
  o = vec4(mix(o.rgb, vec3(0.05, 0.035, 0.03) * (0.5 + light), soil), max(o.a, soil));
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float k = fi / 6.0 - 0.5;
    float ang = k * 2.2 + (hash12(vec2(fi, 3.0)) - 0.5) * 0.3 + breeze * (0.07 * sin(tm * 0.9 + fi * 1.7) + 0.04 * sin(tm * 2.1 + fi * 2.9));
    float len = 0.1 + 0.07 * hash12(vec2(fi, 5.0)) * (1.0 - abs(k));
    vec2 l = rotate(q - vec2(k * 0.03, 0.066), ang);
    float u = l.y / len;
    if (u <= 0.0 || u >= 1.0) continue;
    // Each leaf arches outward under its own weight.
    float v = l.x - sign(ang) * (0.12 + 0.4 * abs(ang)) * u * u * len;
    float halfW = len * 0.15 * pow(sin(3.14159 * u), 0.7);
    float cover = softFill(abs(v) - halfW, px);
    if (cover <= 0.0) continue;
    vec3 c = mix(vec3(0.05, 0.17, 0.08), vec3(0.14, 0.34, 0.15), v > 0.0 ? 1.0 : 0.35) * (0.55 + 0.45 * u) * (0.35 + light);
    c += cool * 0.35 * smoothstep(halfW * 0.4, halfW, abs(v));
    c *= mix(0.7, 1.0, smoothstep(0.0, halfW * 0.25 + px, abs(v)));
    o = vec4(mix(o.rgb, c, cover), max(o.a, cover));
  }
  return o;
}

// Steam from the mug: three ribbons that sway as they rise (the sway's phase climbs with time),
// widen, break into wisps and fade, carried sideways by the wind. Two eddies at a time rise
// through them, each swelling and dying away over a few seconds, and roll the ribbons they pass
// into a curl: the swirl is a rotation about the eddy's centre that fades with distance, so the
// steam folds smoothly and never tears.
float sillSteam(vec2 p, vec2 rim, float tm, float amount, float wind) {
  vec2 q = p - rim;
  float h0 = q.y;
  if (h0 < -0.005 || h0 > 0.27 || abs(q.x) > 0.17) return 0.0;
  for (int k = 0; k < 2; k++) {
    float ph = tm / 6.5 + float(k) * 0.5;
    float age = fract(ph);
    float side = sign(hash12(vec2(floor(ph), float(k) + 3.0)) - 0.5);
    float y = 0.012 + 0.15 * age;
    vec2 c = vec2(side * (0.006 + 0.02 * age) + wind * y * y * 1.5, y);
    float r = 0.014 + 0.03 * age;
    vec2 d = q - c;
    q = c + rotate(d, -side * 2.6 * sin(age * 3.14159) * exp(-dot(d, d) / (r * r)));
  }
  float h = q.y;
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = (fi - 1.0) * 0.008
      + (0.004 + 0.12 * h) * sin(h * 18.0 - tm * (1.1 + 0.25 * fi) + fi * 2.1)
      + (vnoise(vec2(h * 7.0 - tm * 0.35, fi * 3.7)) - 0.5) * 0.1 * h
      + wind * h * h * 1.5;
    float across = (q.x - x) / (0.005 + 0.03 * max(h, 0.0));
    float ribbon = exp(-across * across);
    float wisps = smoothstep(0.25, 0.7, vnoise(vec2(h * 22.0 - tm * 0.9, fi * 5.3 + q.x * 30.0)));
    s += ribbon * mix(1.0, wisps, smoothstep(0.02, 0.1, h)) * (1.0 - fi * 0.2);
  }
  float life = smoothstep(-0.005, 0.015, h0) * (1.0 - smoothstep(0.04, 0.1 + 0.15 * amount, h0));
  return clamp(s * life * (0.45 + 0.55 * amount), 0.0, 1.0);
}

// The curtain at the left of the window: linen in loose vertical folds, hung from a rod above the
// frame. The breeze through the open sash lifts its free edge and sends slow waves down the cloth.
vec4 sillCurtain(vec2 p, float aspect, float tm, float breeze, float xw0, vec3 light, vec3 cool, float px) {
  float left = -0.5 * aspect;
  float sway = smoothfall(0.5, -0.45, p.y);
  float gust = 0.55 + 0.45 * vnoise(vec2(tm * 0.17, 4.0));
  float wave = 0.6 * sin(tm * 0.8 - p.y * 4.5) + 0.4 * sin(tm * 1.3 - p.y * 8.0 + 1.3);
  float edge = left + max(0.12 * aspect, 0.09) + breeze * sway * gust * (0.025 + 0.02 * wave);
  float cover = softFill(p.x - edge, px);
  if (cover <= 0.0) return vec4(0.0);
  float x = (p.x - left) / (edge - left);
  float folds = sin(x * 21.0 + breeze * sway * gust * wave * 1.6 + 0.6 * sin(p.y * 2.0));
  float shade = (0.45 + 0.55 * (0.5 + 0.5 * folds)) * mix(1.0, 0.75, smoothstep(0.85, 1.0, x));
  vec3 c = vec3(0.62, 0.5, 0.42) * shade * (light + cool * 0.35);
  // Where it hangs across the window, the city's light comes through the cloth.
  c += cool * 0.45 * smoothstep(xw0 - 0.03, xw0 + 0.03, p.x) * (0.6 + 0.4 * folds) * smoothstep(SILL_BACK - 0.005, SILL_BACK + 0.06, p.y);
  return vec4(c, cover);
}

// ---- The passage

// Seconds the entrance and the exit take (SceneDef.passage), shared with index.ts.
const float SILL_ENTER = ${glslFloat(SILL_PASSAGE.enter)};
const float SILL_EXIT = ${glslFloat(SILL_PASSAGE.exit)};

// How far below the frame's bottom edge (cat units) the cat starts its hop up and ends its drop
// down: its stretched height, just out of sight.
const float SILL_HIDE = 1.2;

// The cat's passage pose, lengths in cat units (its sitting height is 1) and all of it identity at rest
// (passageIn() 1, passageOut() 0): lift above its place on the sill, squash and stretch about its
// foot, the head tipped up, the tail raised and curling, how much its outline is moving (0..1) and
// how much of its shadow lies on the sill.
struct SillHop {
  float lift;
  vec2 scale;
  float look;
  float up;
  float curl;
  float move;
  float shade;
};

// In: it springs up from just below the frame (already rising as the entrance starts, stretching as
// it rises, tail held up), tops out a little above the sill, lands with a squash that rings out, and
// the tail comes down and hooks round as it settles. Out: it rises into a long stretch, crouches,
// springs, and drops away below the frame, still falling as the exit ends. 'edge' is the frame's
// bottom edge in cat units from the sill's seat (negative).
SillHop sillPassage(float edge) {
  SillHop h;
  h.lift = 0.0;
  h.scale = vec2(1.0);
  h.look = 0.0;
  h.up = 0.0;
  h.curl = 0.0;
  h.move = 0.0;
  h.shade = 1.0;
  float pin = passageIn();
  float pout = passageOut();
  float hidden = edge - SILL_HIDE;
  if (pout > 0.0) {
    float s = pout * SILL_EXIT;
    float stretch = smoothstep(0.0, 0.5, s);
    float sy = 1.0 + 0.14 * stretch;
    sy = mix(sy, 0.86, smoothstep(0.5, 0.64, s));
    float u = clamp((s - 0.64) / (SILL_EXIT - 0.64), 0.0, 1.0);
    sy = mix(sy, 1.16, smoothstep(0.0, 0.1, u));
    sy = mix(sy, 1.04, smoothstep(0.1, 0.6, u));
    h.lift = 1.4 * u - (1.4 - hidden) * u * u;
    h.scale = vec2(inversesqrt(sy), sy);
    h.look = 0.55 * stretch;
    h.up = max(0.35 * stretch, 0.8 * smoothstep(0.1, 0.5, u));
    h.move = clamp(6.0 * abs(sy - 1.0) + 3.0 * h.up + abs(h.lift), 0.0, 1.0);
  } else if (pin < 1.0) {
    float s = pin * SILL_ENTER;
    float apexAt = 0.95;
    float apex = 0.35;
    float g = (apex - hidden) / (apexAt * apexAt);
    float land = apexAt + sqrt(apex / g);
    float sy = 1.0;
    float air = 0.0;
    float tau = max(s - land, 0.0);
    if (s < land) {
      float tt = s - apexAt;
      h.lift = apex - g * tt * tt;
      sy = 1.0 + 0.016 * clamp(-2.0 * g * tt, 0.0, 9.0);
      air = 1.0;
      h.up = 1.0;
    } else {
      float env = 1.0 - clamp(tau / (SILL_ENTER - land), 0.0, 1.0);
      sy = 1.0 - 0.15 * env * env * cos(11.0 * tau) * smoothstep(0.0, 0.05, tau);
      h.up = 1.0 - smoothstep(0.0, 0.7, tau);
      h.curl = sin(3.14159265 * clamp((tau - 0.3) / (SILL_ENTER - land - 0.3), 0.0, 1.0));
    }
    h.scale = vec2(inversesqrt(sy), sy);
    h.look = 0.45 * (1.0 - smoothstep(0.0, 0.4, tau));
    h.move = clamp(air + 6.0 * abs(sy - 1.0) + 1.5 * h.up + 2.0 * h.curl, 0.0, 1.0);
  }
  h.shade = smoothstep(-0.25, 0.0, h.lift) * (1.0 - 0.5 * smoothstep(0.0, 0.35, h.lift));
  return h;
}

// ---- The cat

// The cat's pose this frame, in cat units (its sitting height to the top of the head is about 1).
struct SillCat {
  vec2 head;    // centre of the head
  float yaw;    // head turn: 0 toward the city, +-PI/2 in profile, PI facing the room; + to its right
  float pitch;  // + looking up
  vec2 ears;    // swivel of the left and right ear: 0 at rest, 1 flicked outward, < 0 pricked up
  float breath; // 0..1
  float sway;   // tail swing at the sill's edge, radians
  float wave;   // phase of the lash travelling down the tail
  float lash;   // its size
  float flick;  // tail-tip flick, signed
  float turn;   // the look back over the shoulder, 0..1
  float tip;    // radius of the tail's tip, kept to a cell or more so it never breaks up
  float up;     // passage: the tail held up and out for balance, 0..1 (0 at rest)
  float curl;   // passage: the tip hooking round as it settles, 0..1 (0 at rest)
};

// One ear: a rounded triangle whose corners are 3D points (x out to 'side', y up, z toward the
// city), turned with the head and swivelled outward about its root by 'twitch'. The base corners
// sit deep in the skull, so near the head the ear's own field is shaped by its sides alone.
float sillEar(vec2 h, float side, float yaw, float pitch, float twitch) {
  float cy = cos(yaw);
  float sy = sin(yaw);
  vec3 a = vec3(0.009 * side, 0.072, 0.07);
  vec3 b = vec3(0.163 * side, -0.011, -0.045);
  vec3 c = vec3(0.138 * side, 0.27 + 0.025 * pitch, 0.01);
  vec2 pa = vec2(a.x * cy + a.z * sy, a.y);
  vec2 pb = vec2(b.x * cy + b.z * sy, b.y);
  vec2 pc = vec2(c.x * cy + c.z * sy, c.y);
  vec2 pivot = mix(0.5 * (pa + pb), pc, 0.25);
  float swivel = -side * 0.5 * twitch;
  return sillTriangle(h, rotateAbout(pa, pivot, swivel), rotateAbout(pb, pivot, swivel), rotateAbout(pc, pivot, swivel)) - 0.012;
}

// The thighs over the folded hind legs, centre and radii in cat units: the near one (the cat's
// right, turned a little toward us) and the far one. Shared by the silhouette and the shading.
const vec4 SILL_THIGH_NEAR = vec4(0.13, 0.13, 0.15, 0.14);
const vec4 SILL_THIGH_FAR = vec4(-0.13, 0.12, 0.13, 0.125);

// The cat from behind, three-quarter: the seat with a thigh standing proud over each folded hind
// leg, the near hind foot beneath its thigh, a front paw peeking out past the far one, the flanks
// narrowing to the shoulder blades, a short neck, the head with its cheek ruff and muzzle, ears,
// and the tail across the sill and over its edge, smooth-unioned into one silhouette (the return
// value). 'edge' is the sill's front edge in cat units. For shading, part.x: how far along the
// tail (0 root .. 1 tip; -1 elsewhere); part.y: distance to the ears alone; part.z: to the skull;
// part.w: to the cat without its ears.
// Ears and body are shaded from separate fields: any union of the two leaves a seam inside the
// head where the bulge normals would turn.
float sillCatDist(vec2 q, SillCat c, float edge, out vec4 part) {
  vec2 box = abs(q - vec2(0.05, 0.22)) - vec2(0.62, 1.02);
  float boxD = max(box.x, box.y);
  part = vec4(-1.0, boxD, boxD, boxD);
  if (boxD > 0.15) return boxD;
  float swell = 1.0 + 0.022 * c.breath;
  // Small fillets keep a crease where each thigh tucks under the flank, and a notch between the
  // near thigh and the hind foot showing beneath it.
  float d = sdEllipse(q - vec2(0.0, 0.14), vec2(0.2, 0.15));
  d = sillSmin(d, sdEllipse(q - SILL_THIGH_NEAR.xy, SILL_THIGH_NEAR.zw), 0.035);
  d = sillSmin(d, sdEllipse(q - SILL_THIGH_FAR.xy, SILL_THIGH_FAR.zw), 0.035);
  d = sillSmin(d, sdEllipse(q - vec2(0.2, 0.024), vec2(0.075, 0.026)), 0.02);
  d = sillSmin(d, sdEllipse(q - vec2(-0.225, 0.028), vec2(0.06, 0.03)), 0.02);
  d = sillSmin(d, sdEllipse(q - vec2(0.0, 0.38), vec2(0.195, 0.25) * swell), 0.07);
  vec2 shoulder = vec2(0.03 * c.turn, 0.6 + 0.008 * c.breath);
  d = sillSmin(d, sdEllipse(q - shoulder, vec2(0.16, 0.095)), 0.06);
  float u = 0.0;
  d = sillSmin(d, sdTaperCapsule(q, shoulder + vec2(0.0, 0.04), c.head - vec2(0.0, 0.08), 0.11, 0.098, u), 0.035);
  vec2 h = q - c.head;
  float skull = sdEllipse(h, vec2(0.17, 0.148));
  skull = sillSmin(skull, sdEllipse(h - vec2(0.0, -0.047), vec2(0.182, 0.1)), 0.04);
  skull = sillSmin(skull, sdEllipse(h - vec2(0.135 * sin(c.yaw), -0.058 + 0.02 * c.pitch), vec2(0.078, 0.06)), 0.035);
  float ears = min(sillEar(h, -1.0, c.yaw, c.pitch, c.ears.x), sillEar(h, 1.0, c.yaw, c.pitch, c.ears.y));
  part.yz = vec2(ears, skull);
  float earless = max(sillSmin(d, skull, 0.03), -q.y - 0.004);
  d = sillSmin(d, sillSmin(skull, ears, 0.03), 0.03);
  // Sitting flat on the sill.
  d = max(d, -q.y - 0.004);
  // The tail lies across the sill to its edge, then hangs, slender, tapering to a fine tip: a
  // slow swing at the edge, a lash travelling down it, a curl at the tip that flicks now and then.
  vec2 from = vec2(0.15, edge + 0.012);
  float tail = sdTaperCapsule(q, vec2(0.065, 0.065), from, 0.05, 0.044, u);
  float along = u * 0.22;
  float r0 = 0.044;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float w = (fi + 1.0) / 6.0;
    float ang = mix(c.sway * (0.5 + 0.5 * w) + c.lash * sin(c.wave - fi * 0.8) * w + 0.95 * smoothstep(0.45, 1.0, w) + c.flick * w * w * 1.5, 1.0 + 1.9 * w, c.up) - 1.6 * c.curl * smoothstep(0.3, 1.0, w);
    vec2 to = from + vec2(sin(ang), -cos(ang)) * 0.068;
    float r1 = max(0.044 * (1.0 - 0.2 * w) * (1.0 - 0.75 * smoothstep(0.45, 1.0, w)), c.tip);
    float sd = sdTaperCapsule(q, from, to, r0, r1, u);
    if (sd < tail) {
      tail = sd;
      along = 0.22 + 0.78 * (fi + u) / 6.0;
    }
    from = to;
    r0 = r1;
  }
  if (tail < d) part.x = along;
  part.w = sillSmin(earless, tail, 0.025);
  return sillSmin(d, tail, 0.025);
}

Shade sceneSill(vec2 uv, vec2 cell, float t) {
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float shimmer = 0.0;

  // Where things are. The window opening runs between its casings almost edge to edge; the cat
  // sits right of centre, clear of the page's copy at the lower left.
  float xw0 = -0.44 * aspect;
  float xw1 = 0.455 * aspect;
  float casing = 0.036;
  float reveal = 0.024;
  float xg0 = xw0 + reveal + 0.022;
  float xg1 = xw1 - reveal - 0.022;
  vec2 signAt = vec2(-0.03 * aspect, -0.08);
  float catX = 0.26 * aspect;
  float mugX = 0.085 * aspect;
  float booksX = 0.405 * aspect;
  float plantX = -0.33 * aspect;

  // Time of day and the light it brings: 'haze' is the air over the city, 'cool' the light that
  // comes in through the window. Rain or snow closes the sky over (sillOvercast): sun and moon fade
  // behind the deck, the daylight flattens to grey and dims as the fall gets heavier, and the
  // city's lamps and the sign come into their own early in the gloom.
  Sky sky = skyMoonPhase(skyAt(timeOfDayM(K_time, K_cycle, tm)), K_moon);
  vec2 ov = sillOvercast();
  sky.sunColor *= 1.0 - 0.8 * ov.x;
  sky.moonColor *= 1.0 - 0.7 * ov.x;
  sky.ambient = greyed(sky.ambient, vec3(1.0), 0.5 * ov.x) * (1.0 - 0.35 * ov.y);
  float dark = clamp(1.0 - sky.day * (1.0 - 0.45 * ov.y), 0.0, 1.0);
  vec3 haze = (vec3(0.62, 0.68, 0.78) * sky.day + vec3(0.5, 0.33, 0.34) * sky.twilight + vec3(0.11, 0.1, 0.16) * sky.night) / max(sky.day + sky.twilight + sky.night, 1e-3);
  haze += vec3(0.5, 0.26, 0.16) * dark * 0.25;
  haze = greyed(haze, vec3(1.0), 0.5 * ov.x) * (1.0 - 0.3 * ov.y);
  vec3 cool = mix(vec3(0.26, 0.31, 0.52), vec3(0.85, 0.88, 0.95), sky.day) + vec3(0.06, 0.03, 0.02) * dark;
  cool = greyed(cool, vec3(1.0), 0.4 * ov.x) * (1.0 - 0.3 * ov.y);
  // On a clear night the aurora's green comes in through the window too.
  cool += auroraGlow(tm, K_aurora) * auroraSeen(sky, ov.x);
  float boltSeed = 0.0;
  float boltAge = lightningAge(t, K_lightning, 1, boltSeed);
  float flash = lightningFlash(boltAge);
  // How wet the world is and how much snow lies, integrated by the renderer from the knobs.
  float wet = uWeather.x;
  float lying = uWeather.y;
  vec4 neon = sillNeon(tm, K_neon);
  float neonGlow = dot(neon, vec4(0.25)) * mix(0.35, 1.0, dark);

  // The view: the open lower half, and the glass above the raised sash's rail (between its
  // stiles and glazing bars, three panes across and two up).
  bool inOpen = p.y > SILL_BACK + 0.014 && p.y < SILL_RAIL && p.x > xw0 + reveal && p.x < xw1 - reveal;
  float xm1 = mix(xg0, xg1, 1.0 / 3.0);
  float xm2 = mix(xg0, xg1, 2.0 / 3.0);
  bool muntin = abs(p.x - xm1) < 0.006 || abs(p.x - xm2) < 0.006 || abs(p.y - 0.405) < 0.006;
  bool inGlass = p.y > SILL_RAIL_TOP && p.x > xg0 && p.x < xg1 && !muntin;
  vec3 col = vec3(0.0);
  float accent = 0.0;
  if (inOpen || inGlass) {
    vec2 at = p;
    float soft = 0.6 * px + 0.0015 * max(K_rain, K_snow);
    vec3 drop = vec3(0.0);
    vec2 fromCentre = vec2(0.0);
    float lens = 0.0;
    if (inGlass) {
      soft += 0.0012 + 0.005 * K_rain;
      if (K_drops > 0.5 && K_rain > 0.0) {
        drop = glassDrops(uv, aspect, t, K_rain);
        at += drop.xy * vec2(aspect, 1.0);
        if (drop.z > 0.0) {
          // Each drop is a little lens onto the lit city: a small inverted picture of the skyline
          // round the sign, fixed to the drop, so a sliding drop carries its picture down instead
          // of streaming the city through itself. The library's offset points through the drop's
          // centre at about three times the distance from it, which gives the centre back.
          fromCentre = -drop.xy * vec2(aspect, 1.0) / (3.2 * drop.z);
          vec2 centre = p - fromCentre;
          lens = smoothstep(0.15, 0.85, drop.z);
          at = mix(at, vec2(0.8 * centre.x, SILL_HORIZON - 0.03) - fromCentre * 1.5, lens);
          soft = mix(soft, 0.6 * px + 0.006, lens);
        }
      }
    }
    vec4 city = sillCity(at, aspect, t, tm, px, soft, sky, haze, dark, signAt, vec2(xw0 + reveal, xw1 - reveal), neon, boltAge, boltSeed, flash);
    col = city.rgb;
    accent = city.a;
    if (inGlass) {
      // Snow banked on the outside of the panes, drifted deepest into the corners against the bars
      // and stiles, lit by the lamp through the glass and by the city behind.
      if (lying > 0.0) {
        float bar = min(min(abs(p.x - xm1), abs(p.x - xm2)) - 0.006, min(p.x - xg0, xg1 - p.x));
        float h = (0.003 + 0.016 * exp(-bar / 0.018)) * snowCover(vec3(0.0, 1.0, 0.0), vec2(p.x * 12.0, step(0.405, p.y) * 3.0), lying);
        float bank = smoothfall(0.6 * px, -0.6 * px, p.y - (p.y < 0.405 ? SILL_RAIL_TOP : 0.411) - h) * smoothstep(0.0, px, h);
        col = mix(col, vec3(0.72, 0.75, 0.84) * (0.16 + 0.6 * sky.day * (1.0 - 0.3 * ov.y)) + SILL_LAMP * sillLamp(p, aspect) * 0.45 + vec3(0.14, 0.07, 0.05) * dark, bank);
        accent *= 1.0 - bank;
      }
      // The pane: a little light lost, the room faintly mirrored in it. Drops gather the city's
      // light into their pictures, darken at the rim where they bend the dark room in, and catch
      // the lamp along the side that faces it.
      col = col * 0.88 * (1.0 + 0.6 * lens) + sillMirror(p, vec2(mix(xm2, xg1, 0.68), 0.3), aspect, dark);
      float ring = 4.0 * drop.z * (1.0 - drop.z);
      float glint = ring * smoothstep(0.1, 0.8, dot(normalize(fromCentre + 1e-6), vec2(0.876, -0.482)));
      col = col * (1.0 - 0.35 * ring) + SILL_LAMP * glint * 0.45 + cool * drop.z * 0.05;
      accent *= 0.85;
      shimmer = glint * 0.25;
    }
  }

  // The room's light at this point: the lamp, a little ambient, the window's light near it, and
  // lightning flashes.
  float lamp = sillLamp(p, aspect);
  float nearWindow = smoothfall(0.25, 0.0, max(max(xw0 - p.x, p.x - xw1), SILL_BACK - p.y));
  vec3 roomLight = SILL_LAMP * lamp * 1.35 + vec3(0.05, 0.045, 0.06) + cool * ((0.08 + 0.25 * nearWindow) * (1.0 + 2.0 * sky.day) + 0.6 * flash);
  vec3 wood = vec3(0.42, 0.26, 0.15);
  vec3 wall = vec3(0.27, 0.24, 0.29);
  // The cat's size, a little smaller on narrow screens so it leaves the props in view.
  float S = 0.29 * mix(0.72, 1.28, K_cat) * clamp(0.3 + 0.6 * aspect, 0.72, 1.0);
  // The passage: the cat hops up onto the sill and settles, or stretches and hops down out of frame.
  // Identity at rest.
  SillHop hop = sillPassage((-0.5 - SILL_SEAT) / S);

  if (!(inOpen || inGlass)) {
    if (p.y < SILL_BACK) {
      float depth = clamp((p.y - SILL_FRONT) / (SILL_BACK - SILL_FRONT), 0.0, 1.0);
      float reach = casing + 0.02 + 0.025 * (1.0 - depth);
      if (p.y > SILL_FRONT && p.x > xw0 - reach && p.x < xw1 + reach) {
        // The sill: warm wood in the lamp's pool, cooler toward the window, props' shadows cast
        // away from the lamp.
        float grain = 0.82 + 0.18 * vnoise(vec2(p.x * 2.5 + vnoise(vec2(p.x * 9.0, depth * 3.0)) * 1.5, depth * 14.0));
        vec2 poolAt = vec2((p.x - 0.36 * aspect) / 0.32, (depth - 0.45) / 0.9);
        float pool = exp(-dot(poolAt, poolAt));
        col = wood * 1.1 * grain * (roomLight + SILL_LAMP * pool * 0.55 + cool * 0.4 * depth * depth);
        col += SILL_LAMP * (lamp + pool * 0.3) * 0.25 * smoothfall(0.08, 0.0, depth);
        float shadow = 0.5 * smoothfall(1.0, 0.3, length((p - vec2(mugX - 0.022, SILL_SEAT - 0.008)) / vec2(0.05, 0.012)));
        shadow = max(shadow, 0.5 * smoothfall(1.0, 0.4, length((p - vec2(booksX - 0.03, SILL_SEAT - 0.006)) / vec2(0.1, 0.014))));
        if (K_plant > 0.5) shadow = max(shadow, 0.5 * smoothfall(1.0, 0.3, length((p - vec2(plantX - 0.015, SILL_SEAT - 0.006)) / vec2(0.06, 0.012))));
        if (K_cat > 0.0) {
          shadow = max(shadow, 0.55 * hop.shade * smoothfall(1.0, 0.35, length((p - vec2(catX - 0.15 * S, SILL_SEAT - 0.006)) / vec2(0.5 * S, 0.03))));
        }
        col *= 1.0 - shadow;
        // Rain blowing in wets the sill by the window: it catches the city and the neon.
        float wetBand = wet * smoothstep(0.45, 1.0, depth) * (0.6 + 0.4 * vnoise(vec2(p.x * 60.0, depth * 3.0)));
        float mirrored = neonGlow * wetBand * exp(-abs(p.x - signAt.x) * 9.0);
        col += uAccent * mirrored * 0.35 + cool * wetBand * 0.15;
        accent = max(accent, mirrored * 0.3);
      } else if (p.y > SILL_NOSE && p.x > xw0 - casing - 0.045 && p.x < xw1 + casing + 0.045) {
        // The nosing: the sill's front face, its rounded top edge catching the lamp.
        float f = (p.y - SILL_NOSE) / (SILL_FRONT - SILL_NOSE);
        col = wood * roomLight * 0.75 * (0.8 + 0.2 * f) + SILL_LAMP * lamp * 0.35 * smoothstep(0.75, 1.0, f);
      } else {
        // Below the sill: the wall in its shadow, and an old radiator whose pale fins the tail
        // hangs in front of.
        float under = mix(0.3, 0.85, smoothstep(0.0, 0.08, SILL_NOSE - p.y));
        col = wall * roomLight * under;
        float rx = (p.x - 0.03 * aspect) / 0.022;
        if (p.y < SILL_NOSE - 0.02 && p.x > 0.03 * aspect - 0.01 && p.x < xw1 - 0.02) {
          float fin = abs(fract(rx) - 0.5) * 2.0;
          float ribs = smoothfall(0.75, 0.55, fin) * (0.75 + 0.25 * sqrt(max(1.0 - fin * fin, 0.0)));
          vec3 paint = vec3(0.6, 0.56, 0.5) * roomLight * under;
          col = mix(col * 0.6, paint, ribs * smoothfall(SILL_NOSE - 0.02, SILL_NOSE - 0.03, p.y));
          col = mix(col, paint * 1.1, smoothfall(0.006, 0.0, abs(p.y - (SILL_NOSE - 0.027))));
        }
      }
    } else if (p.y < SILL_BACK + 0.014 && p.x > xw0 && p.x < xw1) {
      // The window frame's own sill, its top edge lit from outside; rain blowing in darkens it and
      // gives it a sheen.
      col = wetten(wood * 0.6, wet, 0.6) * roomLight + cool * (0.18 + 0.3 * wetGloss(wet, 1.0)) * smoothstep(SILL_BACK, SILL_BACK + 0.014, p.y);
    } else if (p.x < xw0 - casing || p.x > xw1 + casing) {
      col = wall * roomLight;
    } else if (p.x < xw0 || p.x > xw1) {
      // The casing: a moulded wood surround, a groove and a bead along its inner edge.
      float u = p.x < xw0 ? (p.x - xw0 + casing) / casing : (xw1 + casing - p.x) / casing;
      float profile = 0.75 + 0.25 * smoothstep(0.0, 0.25, u) - 0.3 * smoothstep(0.55, 0.6, u) * smoothfall(0.72, 0.67, u) + 0.2 * smoothstep(0.85, 1.0, u);
      col = wood * roomLight * profile + cool * 0.2 * smoothstep(0.8, 1.0, u);
    } else if (p.x < xw0 + reveal || p.x > xw1 - reveal) {
      // The reveal, the wall's depth: the left one faces the lamp, the right one turns away.
      col = wall * roomLight * (p.x < 0.0 ? 1.0 : 0.45) + cool * 0.25;
    } else {
      // The raised sash: its bottom rail (underside lit by the lamp, a brass catch on top),
      // stiles and glazing bars.
      col = wood * 0.85 * roomLight + cool * 0.15;
      if (p.y < SILL_RAIL_TOP) {
        float v = (p.y - SILL_RAIL) / (SILL_RAIL_TOP - SILL_RAIL);
        col = col * (0.8 + 0.3 * smoothstep(0.0, 0.2, v)) + SILL_LAMP * lamp * 0.5 * smoothfall(0.2, 0.0, v);
        vec2 lq = (p - vec2(0.5 * (xw0 + xw1), SILL_RAIL_TOP - 0.004)) / vec2(0.024, 0.008);
        if (dot(lq, lq) < 1.0) col = vec3(0.85, 0.64, 0.3) * (0.4 + roomLight * 1.5) * (0.8 + 0.2 * lq.y);
      }
    }
  }

  // Things on the sill.
  float lampSill = sillLamp(vec2(p.x, SILL_SEAT + 0.04), aspect);
  vec3 propLight = SILL_LAMP * lampSill * 1.35 + vec3(0.05, 0.045, 0.06) + cool * (0.15 + 0.4 * sky.day + 0.6 * flash);
  if (K_plant > 0.5) {
    float breeze = 0.5 + 0.8 * abs(K_wind);
    vec4 plant = sillPlant(p - vec2(plantX, SILL_SEAT), tm, breeze, propLight, cool, px);
    col = mix(col, plant.rgb, plant.a);
    accent *= 1.0 - plant.a;
  }
  vec4 mug = sillMug(p - vec2(mugX, SILL_SEAT - 0.006), propLight, cool, px);
  col = mix(col, mug.rgb, mug.a);
  accent *= 1.0 - mug.a;
  vec4 books = sillBooks(p - vec2(booksX, SILL_SEAT - 0.004), propLight, px);
  col = mix(col, books.rgb, books.a);
  accent *= 1.0 - books.a;

  // The cat.
  if (K_cat > 0.0) {
    vec2 base = vec2(catX, SILL_SEAT);
    float restless = K_restless;
    // Where it is looking (the sim eases this toward the pointer): xy scene uv, z its interest
    // 0..1, w seconds since its gaze last jumped.
    vec4 gaze = vec4(0.5, 0.6, 0.0, 60.0);
    if (uSimOn.x > 0.5) gaze = texelFetch(uSim0, ivec2(0, 0), 0);
    SillCat cat;
    cat.breath = 0.5 + 0.5 * sin(tm * TAU / 3.1);
    // Idle, it watches the city and now and then glances elsewhere with a quick turn of the head;
    // while the pointer holds its interest, it follows that instead.
    vec2 glance = sillGlance(tm, mix(15.0, 4.0, restless), 11.0, 0.4);
    vec2 look = (gaze.xy - 0.5) * vec2(aspect, 1.0) - (base + vec2(0.0, 0.88 * S));
    float yaw = mix(glance.x * abs(glance.x) * 0.95, clamp(look.x * 3.2, -1.35, 1.35), gaze.z);
    float pitch = mix(glance.y * 0.3, clamp(look.y * 2.2, -0.6, 0.6), gaze.z);
    // Now: it looks back at you over its shoulder, blinks slowly, and turns back to the city.
    float since = sinceTrigger(0);
    cat.turn = smoothstep(0.0, 0.8, since) * (1.0 - smoothstep(4.4, 5.6, since));
    cat.yaw = mix(yaw, 2.5, cat.turn);
    cat.pitch = mix(pitch, -0.1, cat.turn) + hop.look;
    cat.head = vec2(0.03 * sin(cat.yaw) + 0.025 * cat.turn, 0.88 + 0.045 * cat.pitch);
    // Ears: each twitches on its own now and then (sometimes twice), both flick at a click, they
    // prick up when the gaze jumps.
    float pickL = 0.0;
    float pickR = 0.0;
    float earPeriod = mix(11.0, 2.6, restless);
    float ageL = sillEvent(tm, earPeriod, 21.0, pickL);
    float ageR = sillEvent(tm, earPeriod * 1.17, 23.0, pickR);
    float twitchL = step(0.3, pickL) * max(sillTwitch(ageL, 0.06, 0.08 + 0.3 * pickL, 0.35), step(0.8, pickL) * sillTwitch(ageL - 0.6, 0.05, 0.05, 0.3));
    float twitchR = step(0.3, pickR) * max(sillTwitch(ageR, 0.06, 0.08 + 0.3 * pickR, 0.35), step(0.8, pickR) * sillTwitch(ageR - 0.6, 0.05, 0.05, 0.3));
    float press = sillTwitch(t - uMouse.w, 0.05, 0.12, 0.45);
    float perk = sillTwitch(gaze.w, 0.1, 0.2, 0.6) * gaze.z;
    cat.ears = vec2(twitchL, twitchR) + press * 0.8 - perk * 0.35 - cat.turn * 0.25;
    // Tail: a slow swing, a lash running down it, and a tip that flicks.
    cat.sway = (0.08 + 0.16 * restless) * (0.7 * sin(tm * 0.37) + 0.3 * sin(tm * 0.16 + 1.3));
    cat.wave = tm * 0.9;
    cat.lash = 0.1 + 0.25 * restless;
    float pickT = 0.0;
    float ageT = sillEvent(tm, mix(8.0, 2.2, restless), 31.0, pickT);
    cat.flick = sillTwitch(ageT, 0.12, 0.06, 0.7) * step(0.25, pickT) * (pickT > 0.6 ? 1.0 : -0.8);
    // A slow blink now and then, seen when the face is turned this way; always one on looking back.
    float pickB = 0.0;
    float blink = sillTwitch(sillEvent(tm, mix(8.0, 4.5, restless), 41.0, pickB), 0.3, 0.3, 0.6);
    blink = max(blink, sillTwitch(since - 2.0, 0.45, 0.6, 0.9));

    vec2 q = (p - vec2(catX, SILL_SEAT + hop.lift * S)) / (S * hop.scale);
    vec4 part = vec4(0.0);
    float edgeQ = (SILL_FRONT - base.y) / S;
    cat.tip = max(0.011, 1.2 * px / S);
    cat.up = hop.up;
    cat.curl = hop.curl;
    float d = sillCatDist(q, cat, edgeQ, part);
    float aa = 1.1 * px / S;
    // Fur along the outline: tufts standing a cell or so proud of it, fixed to the cat (on the
    // head, to the head) so they never crawl; finer on the tail, none where it sits on the sill.
    float tuft = 0.0;
    if (d < 0.04) {
      vec2 fq = q - (cat.head - vec2(0.0, 0.88)) * smoothstep(0.6, 0.76, q.y);
      tuft = smoothstep(0.25, 0.85, vnoise(fq * vec2(34.0, 24.0) + 3.7));
      d -= max(0.008, 1.3 * px / S) * tuft * (part.x >= 0.0 ? 0.4 : smoothstep(-0.01, 0.04, q.y));
    }
    float cover = softFill(d, aa);
    // While it moves, its edge is cut per cell, so the outline does not crawl through the dither.
    cover = mix(cover, hardEdge(cover), hop.move);
    if (cover > 0.0) {
      // Shading normals by forward differences (smooth from pixel to pixel, where screen-space
      // derivatives would be constant over each 2x2 quad): from the ears' own field where an ear
      // rises above the skull, from the earless cat everywhere else.
      vec4 dx = vec4(0.0);
      vec4 dy = vec4(0.0);
      sillCatDist(q + vec2(0.006, 0.0), cat, edgeQ, dx);
      sillCatDist(q + vec2(0.0, 0.006), cat, edgeQ, dy);
      float ear = max(part.y, -part.z);
      float shapeD = ear < 0.0 ? part.y : part.w;
      vec2 n = normalize((ear < 0.0 ? vec2(dx.y, dy.y) : vec2(dx.w, dy.w)) - shapeD + 1e-6);
      float inner = clamp(-shapeD / 0.13, 0.0, 1.0);
      float rim = pow(1.0 - inner, 3.0);
      // Fur: a soft bulge lit by the lamp (to the right, toward the room).
      vec3 N = normalize(vec3(n * (1.0 - inner), 0.5 + inner));
      vec3 toLamp = normalize(vec3(0.75, 0.3, 0.6));
      float diffuse = max(dot(N, toLamp), 0.0);
      float lampCat = sillLamp(base + vec2(0.0, 0.4 * S), aspect);
      vec2 toSign = normalize(signAt - (base + vec2(0.0, 0.5 * S)));
      // The haunches: each thigh a bulge of its own, so the near one rounds out toward the lamp,
      // and a crease of shadow runs along its top where it tucks in under the flank.
      float crease = 0.0;
      if (part.x < 0.0) {
        float deep = smoothstep(0.012, 0.05, -part.w);
        for (int i = 0; i < 2; i++) {
          vec4 th = i == 0 ? SILL_THIGH_NEAR : SILL_THIGH_FAR;
          vec2 tq = q - th.xy;
          float td = sdEllipse(tq, th.zw);
          float tin = clamp(-td / 0.09, 0.0, 1.0);
          vec3 thighN = normalize(vec3(normalize(tq / (th.zw * th.zw) + 1e-6) * (1.0 - tin), 0.5 + tin));
          diffuse = mix(diffuse, max(dot(thighN, toLamp), 0.0), (1.0 - smoothstep(-0.03, 0.0, td)) * deep * 0.75);
          crease = max(crease, (1.0 - smoothstep(0.0, 0.025, abs(td + 0.006))) * smoothstep(0.0, 0.07, tq.y) * deep);
        }
      }
      // Grey tabby: stripes curving from the spine down the flanks, a dark line down the spine,
      // rings round the tail; faint enough to keep the silhouette whole.
      float stripes = part.x >= 0.0
        ? smoothstep(0.2, 0.7, sin(part.x * 40.0))
        : max(smoothstep(0.35, 0.85, sin(q.y * 30.0 + abs(q.x) * 10.0 + sin(q.x * 9.0 + q.y * 4.0) * 1.6)) * smoothfall(0.98, 0.5, q.y),
              smoothfall(0.05, 0.0, abs(q.x - 0.012 * sin(q.y * 7.0))) * smoothstep(0.1, 0.3, q.y) * smoothfall(0.85, 0.7, q.y));
      vec3 fur = vec3(0.15, 0.135, 0.13) * (1.0 - 0.45 * stripes) * (1.0 - 0.5 * crease);
      vec3 c = fur * (0.16 + diffuse * lampCat * SILL_LAMP * 1.3 + cool * 0.15 + cool * flash);
      // Soft light round the form: warm toward the lamp, the city's cool light on the outline
      // facing it, a touch of neon from the sign.
      c += SILL_LAMP * pow(max(dot(n, vec2(0.93, 0.36)), 0.0), 2.0) * rim * lampCat;
      c += cool * (0.3 + 0.7 * max(dot(n, vec2(-0.45, 0.89)), 0.0)) * rim * 0.45 * (part.x > 0.3 ? 0.4 : 1.0);
      c += uAccent * max(dot(n, toSign), 0.0) * rim * neonGlow * 0.35;
      // And a fine rim right on the outline, catching on the tufts: the lamp's along its side,
      // the city's (tinged by the sign) along the other side and over the top.
      float edgeLit = (1.0 - smoothstep(0.0, max(0.022, 3.0 * px / S), -d)) * (0.65 + 0.35 * tuft);
      float warmSide = smoothstep(0.1, 0.8, dot(n, vec2(0.94, 0.34)));
      float coolSide = smoothstep(-0.1, 0.7, dot(n, vec2(-0.5, 0.866)));
      c += edgeLit * SILL_LAMP * lampCat * 1.8 * warmSide;
      c += edgeLit * (cool * mix(0.75, 0.5, sky.day) + uAccent * neonGlow * 0.5 * max(dot(n, toSign), 0.0)) * coolSide * (part.x > 0.3 ? 0.4 : 1.0);
      // Thin ears glow where the city shines through them; turned this way, their pink insides.
      float earSkin = smoothfall(0.0, -0.03, ear);
      float facing = smoothfall(-0.1, -0.5, cos(cat.yaw));
      c += vec3(0.9, 0.4, 0.3) * earSkin * (0.05 + 0.15 * dark) * (1.0 - facing);
      c = mix(c, vec3(0.55, 0.32, 0.3) * (0.3 + lampCat * 1.2), facing * smoothfall(-0.02, -0.045, ear));
      // Eyes, on the turned face: amber with wide night pupils and a catchlight; they close in
      // a blink.
      for (int i = 0; i < 2; i++) {
        float al = cat.yaw + (float(i) * 2.0 - 1.0) * 0.55;
        float face = -cos(al);
        vec2 e = cat.head + vec2(0.14 * sin(al), 0.012 + 0.03 * cat.pitch);
        vec2 r = vec2(0.036 * clamp(face, 0.3, 1.0), max(0.025 * (1.0 - blink), 0.003));
        float eye = softFill(sdEllipse(q - e, r), aa) * smoothstep(0.05, 0.3, face);
        float pupil = softFill(sdEllipse(q - e, r * vec2(0.5, 0.85)), aa);
        vec3 iris = vec3(0.85, 0.72, 0.22) * (0.5 + 0.9 * lampCat) + cool * 0.2;
        vec3 ec = mix(iris, vec3(0.03, 0.03, 0.02), pupil);
        ec += vec3(1.0) * smoothfall(0.014, 0.006, length(q - e - r * 0.35)) * (1.0 - blink);
        c = mix(c, ec, eye);
      }
      vec2 nose = cat.head + vec2(0.16 * sin(cat.yaw), -0.055 + 0.03 * cat.pitch);
      c = mix(c, vec3(0.75, 0.42, 0.45) * (0.4 + lampCat), smoothfall(0.025, 0.015, length((q - nose) * vec2(1.0, 1.4))) * smoothfall(-0.3, -0.7, cos(cat.yaw)));
      col = mix(col, c, cover);
      accent *= 1.0 - cover;
    }
  }

  // Steam off the mug: it scatters the lamp's light (and a little of the window's and the sign's),
  // so it shows pale against the dark city behind.
  if (K_steam > 0.0) {
    float steam = sillSteam(p, vec2(mugX, SILL_SEAT - 0.006 + 0.064), tm, K_steam, K_wind);
    col += (vec3(0.74, 0.71, 0.67) * (0.3 + 1.5 * lampSill) + cool * 0.2 + uAccent * neonGlow * 0.15) * steam * 0.8;
  }

  if (K_curtain > 0.0) {
    vec4 curtain = sillCurtain(p, aspect, tm, K_curtain * (0.6 + 0.8 * abs(K_wind)), xw0, roomLight, cool, px);
    col = mix(col, curtain.rgb, curtain.a);
    accent *= 1.0 - curtain.a;
  }

  // A soft vignette pulls the corners into the room's dark.
  col *= 1.0 - 0.28 * smoothstep(0.45, 1.0, length((uv - 0.5) * vec2(1.2, 1.0)));

  Shade o = shadeOf(col, inkOf(col, 1.15, 0.8), clamp(accent, 0.0, 1.0));
  o.shimmer = shimmer;
  return o;
}
`;
