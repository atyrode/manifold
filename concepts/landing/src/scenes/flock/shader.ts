// The murmuration, drawn as two layers of the `outdoor` composer (layers.ts), and the flock's ink,
// which every scene that flies the flock shares (flockInkGlsl). sim.ts flies the birds.
//
// roost (backdrop, roostGlsl). The World's sky over the roost, with the afterglow low toward the sun
// as the accent while there is twilight (hidden behind the cloud deck), and a low skyline along the
// foot of the frame that grounds the sky without competing with it, laid out on the frame in screen
// heights as the scene always drew it, each part composed at its depth in metres (ROOST_DEPTHS):
//   city   a hazy far row of rooftops behind a dark near one whose windows light up one by one as
//          the sky darkens and then stay lit;
//   reeds  still water mirroring the sky and the low far shore of trees and hedges, two lamps on the
//          shore and their paths down the water, reeds standing in clumps along the bottom edge,
//          leaning downwind and swaying slowly in the wind, stems two cells wide so they never
//          shimmer;
//   sea    open sea to the horizon mirroring the sky in its swell, a headland rising to the right
//          edge and its reflection broken by the swell, a lighthouse whose lamp glows and flashes
//          every six seconds as its beam sweeps past.
// The water mirrors the sky's dome along the ray its ripples or swell send up, with the cloud deck
// over it and greyed as the sky above it is (roostMirrored). Only one skyline is compiled in at a
// time (ROOST_CITY, ROOST_REEDS, ROOST_SEA); the all-features program has all three behind the same
// test of the knob. Its passes keep the scene's order: the sky, the skyline's land and water (far),
// the lamps over the flock (farVeil), the reeds in front of everything (middle), and the water's
// sparkle (shade).
//
// murmuration (life, murmurationGlsl). The flock inked from the sim's density field (field 0: R
// birds per texel, G the same weighted by how hard they roll, so a startle wave runs through the
// flock as a dark band), MURMURATION_DEPTH metres out, so anything nearer hides it: a stretched sheet
// is a pale veil, face-on grey, edge-on or folded back black. Behind the birds, the warm glow along
// the strokes of the Manifold M they are drawing; in front of them, the falcon. Its row of the records
// atlas: texel 0 the falcon's position (uv) and heading; texel 1 the falcon shown, wings open and
// wingbeat, and in w the birds per texel of a sheet at the reference density seen face-on; texel 2
// the M's strength, centre (uv) and height (screen heights). See sim.ts.
import { glslFloat } from "../../shaders/glsl.ts";
import { MURMURATION_DEPTH, ROOST_DEPTHS } from "./constants.ts";

// The flock's sheet inked from the simulation's density field: shared with every scene that flies
// the flock (the murmuration layer, or a Flock packed into a texture of the scene's own, which samples
// its field itself and inks it with flockInk), so the birds read the same wherever they fly.
export const flockInkGlsl = `
/**
 * Ink of the flock's sheet: coverage 1 - exp(-GAIN * density^CURVE), density 1 being the reference
 * sheet seen face-on (a pale grey); the curve leaves stretched parts a veil and folds black.
 */
const float FLOCK_INK_GAIN = 0.33;
const float FLOCK_INK_CURVE = 1.25;
/** A lone bird's speck: coverage per bird of excess over its neighbourhood, in birds per texel. */
const float FLOCK_SPECK_GAIN = 2.2;

// The flock's ink from its density field sampled at a point (fine: rg there; wide: the mean of rg
// one texel off along both diagonals) and the reference density (birds per texel of the reference
// sheet): x how much it covers 0..1, y how hard the birds there roll 0..1. Its density is read
// through the wide footprint where the birds are sparse, so a moving veil stays smooth under the
// dither, and the sharp one where they crowd, so rims and folds stay crisp: a stretched sheet is a
// pale veil, face-on it is grey, edge-on or folded back black, and a startle wave a dark band.
// Where birds thin out, each one's excess over its neighbourhood shows as a speck of its own.
vec2 flockInk(vec2 fine, vec2 wide, float reference) {
  float sheet = mix(wide.r, fine.r, smoothstep(0.8, 2.5, wide.r)) / reference;
  float roll = clamp(wide.g / max(wide.r, 0.15), 0.0, 1.0);
  float body = 1.0 - exp(-FLOCK_INK_GAIN * pow(sheet, FLOCK_INK_CURVE) * (1.0 + 0.9 * roll));
  float speck = clamp((fine.r - wide.r) * FLOCK_SPECK_GAIN, 0.0, 1.0) * (1.0 - smoothstep(0.3, 0.8, wide.r / reference));
  return vec2(1.0 - (1.0 - body) * (1.0 - speck), roll);
}
`;

/** The roost's GLSL: the sky over it, the skyline, the lamps, the reeds, the water's sparkle. */
export const roostGlsl = `
// ---- the roost (flock/shader.ts) ----
const vec3 ROOST_LAND = vec3(0.025, 0.022, 0.035);
const vec3 ROOST_REED = vec3(0.03, 0.028, 0.03);
const vec3 ROOST_LAMP = vec3(1.0, 0.76, 0.42);
// How far out each part stands (m): ROOST_DEPTHS.
const float ROOST_Z_REEDS = ${glslFloat(ROOST_DEPTHS.reeds)};
const float ROOST_Z_NEAR_CITY = ${glslFloat(ROOST_DEPTHS.nearCity)};
const float ROOST_Z_FAR_CITY = ${glslFloat(ROOST_DEPTHS.farCity)};
const float ROOST_Z_SHORE = ${glslFloat(ROOST_DEPTHS.shore)};
const float ROOST_Z_HEADLAND = ${glslFloat(ROOST_DEPTHS.headland)};
const float ROOST_Z_SEA = ${glslFloat(ROOST_DEPTHS.sea)};

// Each cell's (roostBegin): its point in screen heights from the frame's bottom left, the haze toward
// its bearing, how far the lights are on (they come on as the sky darkens), and what the far pass
// leaves for the later ones: the ripple or swell under it, the depth of the land or water it drew
// there (WORLD_FAR where it drew none), and the water's sparkle.
vec2 roostP;
vec3 roostHaze;
float roostLights;
float roostRipple;
float roostZ;
float roostShimmer;

// The air over the roost: the haze toward this bearing, which the fog and the far rain take on. The
// water and the rooftops are the land in front: the site's floor never shows.
void roostBegin(inout Ctx x) {
  Sky sky = x.w.sky;
  roostP = vec2(x.uv.x * x.aspect, x.uv.y);
  roostHaze = worldGrey(x.w, horizonHaze(sky, x.v.dir, 0.01), 1.0);
  roostLights = clamp(sky.night + 0.6 * sky.twilight, 0.0, 1.0);
  roostRipple = 0.0;
  roostZ = WORLD_FAR;
  roostShimmer = 0.0;
  x.air = Air(roostHaze, roostHaze, max(roostHaze * 1.2, vec3(0.06)), roostHaze, 0.0, 0.0, 0.0);
  x.groundTo = 0.0;
}

// The World's sky over the roost; the accent keeps the afterglow, low in the sky toward the sun
// while there is twilight, where the cloud leaves it open.
void roostSky(Ctx x, inout Cell c) {
  WorldSky heaven = worldSky(x.w, x.v, WORLD_METEOR_FIELD);
  c.col = heaven.col + heaven.strike;
  Sky sky = x.w.sky;
  vec3 dir = x.v.dir;
  c.accent = 0.8 * pow(max(dot(dir, sky.sun), 0.0), 10.0) * exp(-max(dir.y, 0.0) * 5.0) * clamp(sky.twilight + 0.3 * sky.day, 0.0, 1.0) * (1.0 - heaven.cloud);
}

// A part of the skyline over the cell, z metres out. The far pass paints them in order: the
// backdrop's is the first after the sky, so nothing else has drawn yet.
void roostPaint(inout Cell c, vec3 col, float z) {
  c.col = col;
  c.z = z;
  c.zs = min(c.zs, z);
  c.accent = 0.0;
}

// The water over the cell, z metres out: it keeps that share of the accent (the afterglow it
// mirrors), and leaves the specks' depth, being floor.
void roostWater(inout Cell c, vec3 col, float keep, float z) {
  c.col = col;
  c.accent *= keep;
  c.z = z;
}

#if ROOST_REEDS || ROOST_SEA
// The sky's dome along a ray a level mirror sends up (the sky's frame), with the cloud deck over it,
// greyed as the sky above it is: what the still water and the sea mirror. Exactly the dome in a
// clear, dry sky.
vec3 roostMirrored(Ctx x, vec3 dir) {
  vec3 col = skyColor(x.w.sky, dir);
  float open = 1.0;
#if WORLD_CLOUDS
  vec4 deck = skyClouds(x.w.sky, dir, x.w.tm, x.w.cover, worldDeckDrift(x.w, x.v));
  col = mix(col, deck.rgb, deck.a);
  open = 1.0 - deck.a;
#endif
  return worldGrey(x.w, col, open);
}

// Ripples on open water seen at a grazing angle: noise laid on the water plane, so it compresses
// toward the horizon; faded out where it would get finer than the dither.
float roostWaves(vec2 p, float tm, float wind) {
  float near = max(RIG_HORIZON - p.y, 0.002);
  vec2 plane = vec2(p.x / near, 1.0 / near) * 0.05;
  float w = vnoise(plane * vec2(3.0, 7.0) + vec2(tm * 0.04 * wind, tm * 0.22))
    + 0.5 * vnoise(plane * vec2(7.0, 15.0) + vec2(-tm * 0.06, tm * 0.35));
  return (w / 1.5 - 0.5) * smoothstep(0.0, 0.03, near);
}

// A lamp z metres out: its light over the cell, where nothing nearer than the lamp, or than the land
// or water the roost drew there, stands.
void roostGlow(inout Cell c, float glow, float z) {
  if (c.z < min(roostZ, z)) return;
  c.col = mix(c.col, ROOST_LAMP, glow);
  c.accent = max(c.accent, glow);
}
#endif

#if ROOST_CITY
// One row of blocks: the roof height at x (screen heights), or -1 in the gap between two blocks.
// Heights skew low; one block in a dozen is a tower.
float roostBlocks(float x, float width, float seed, float low, float high) {
  float i = floor(x / width);
  float gap = 0.04 + 0.18 * hash12(vec2(i, seed + 1.7));
  if (fract(x / width) < gap) return -1.0;
  float r = hash12(vec2(i, seed));
  float tower = step(0.92, hash12(vec2(i, seed + 4.2)));
  return low + (high - low) * r * r + tower * (high - low) * 0.8;
}

// Rooftops: a hazy far row behind a dark near one whose windows light up as night falls.
void roostCity(inout Cell c) {
  vec2 p = roostP;
  float above = p.y - RIG_HORIZON;
  float far = max(roostBlocks(p.x, 0.019, 3.0, 0.004, 0.03), roostBlocks(p.x + 0.007, 0.013, 9.0, 0.0, 0.022));
  if (above < far) roostPaint(c, mix(ROOST_LAND, roostHaze, 0.45), ROOST_Z_FAR_CITY);
  float roof = max(max(roostBlocks(p.x, 0.034, 1.0, 0.035, 0.085), roostBlocks(p.x + 0.013, 0.022, 7.0, 0.025, 0.07)), 0.03);
  if (p.y < roof) {
    roostPaint(c, ROOST_LAND, ROOST_Z_NEAR_CITY);
    // Windows on a fixed grid: as the sky darkens the lit share sweeps up through each window's
    // own threshold, so they come on one by one and then stay.
    vec2 g = p / vec2(0.009, 0.012);
    vec2 f = fract(g);
    float pane = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.75) * step(0.03, p.y) * step(p.y, roof - 0.005);
    float lit = pane * step(hash12(floor(g) + 7.7), roostLights * 0.38);
    c.col = mix(c.col, ROOST_LAMP * (0.55 + 0.45 * hash12(floor(g) + 2.1)), lit);
    c.accent = lit;
  }
}
#endif

#if ROOST_REEDS
// The far shore of the water: a low line of trees and hedges, height above the horizon.
float roostShore(float x) {
  return 0.003 + 0.012 * vnoise(vec2(x * 4.0, 1.3)) + 0.006 * vnoise(vec2(x * 15.0, 2.9));
}

// Still water under the far shore: the sky and the shore mirrored.
void roostReedbed(Ctx x, inout Cell c) {
  vec2 p = roostP;
  float above = p.y - RIG_HORIZON;
  vec3 shoreColor = mix(ROOST_LAND, roostHaze, 0.4);
  if (above >= 0.0 && above < roostShore(p.x)) roostPaint(c, shoreColor, ROOST_Z_SHORE);
  if (above < 0.0) {
    float ripple = roostWaves(p, x.tm, K_wind);
    roostRipple = ripple;
    vec3 mirrored = normalize(vec3(x.v.dir.x, -x.v.dir.y + ripple * 0.025, x.v.dir.z));
    vec3 col = roostMirrored(x, mirrored) * 0.7 + vec3(0.0, 0.01, 0.02);
    if (-above < roostShore(p.x + ripple * 0.004) * 0.9) col = mix(col, shoreColor, 0.85);
    roostWater(c, col, 0.4, min(x.zg, ROOST_Z_SHORE));
    roostShimmer = 0.1;
  }
}

// The two lamps on the far shore, and their paths down the water.
void roostShoreLamps(Ctx x, inout Cell c) {
  vec2 p = roostP;
  float above = p.y - RIG_HORIZON;
  for (int k = 0; k < 2; k++) {
    vec2 lamp = vec2(x.aspect * (k == 0 ? 0.19 : 0.64), RIG_HORIZON + 0.004);
    float on = roostLights * step(0.35 - 0.3 * float(k), roostLights);
    float bulb = smoothfall(0.0028, 0.0012, length((p - lamp) * vec2(1.0, 1.4))) * on;
    float streak = above < 0.0 ? smoothfall(0.0022, 0.0006, abs(p.x - lamp.x + roostRipple * 0.006)) * exp(above * 30.0) * on * (0.5 + roostRipple) : 0.0;
    roostGlow(c, max(bulb, streak * 0.7), ROOST_Z_SHORE);
  }
}

// Reeds standing in the water along the bottom edge, in clumps: coverage of stems and plumes.
// They lean downwind and sway slowly; stems are two cells wide so they never shimmer. (They take
// no gust: a sample of the gust field a cell costs a tenth of the frame under a software renderer.)
float roostReeds(vec2 p, float tm, float wind) {
  const float pitch = 0.0095;
  float cover = 0.0;
  float column = floor(p.x / pitch);
  for (int k = -2; k <= 2; k++) {
    float i = column + float(k);
    float clump = smoothstep(0.42, 0.72, vnoise(vec2(i * 0.09, 7.3)));
    float h1 = hash12(vec2(i, 41.0));
    if (h1 > clump) continue;
    float height = (0.045 + 0.075 * hash12(vec2(i, 42.0))) * (0.55 + 0.45 * clump);
    if (p.y > height + 0.016) continue;
    float base = (i + 0.5 + 0.7 * (hash12(vec2(i, 43.0)) - 0.5)) * pitch;
    float sway = 0.4 * wind + (0.08 + 0.1 * abs(wind)) * sin(tm * (0.5 + 0.3 * h1) + i * 1.7);
    float s = clamp(p.y / height, 0.0, 1.0);
    float stem = smoothfall(0.0021, 0.0011, abs(p.x - base - sway * height * 0.3 * s * s)) * step(p.y, height);
    cover = max(cover, stem);
    if (h1 < 0.6 * clump) {
      // A plume at the tip, drooping downwind.
      float lean = -sway * 0.8;
      vec2 tip = vec2(base + sway * height * 0.3, height);
      vec2 q = rotate(p - tip, -lean) - vec2(0.0, 0.006);
      cover = max(cover, smoothfall(1.0, 0.7, length(q / vec2(0.0032, 0.0095))));
    }
  }
  return cover;
}
#endif

#if ROOST_SEA
// The headland's height above the horizon at x, rising to the right edge.
float roostHeadland(float x, float start) {
  return 0.03 * smoothstep(start, start + 0.08, x) * (0.85 + 0.15 * vnoise(vec2(x * 30.0, 4.0)));
}

// Open sea to the horizon, the sky mirrored in its swell, a headland with a lighthouse.
void roostSea(Ctx x, inout Cell c) {
  vec2 p = roostP;
  float above = p.y - RIG_HORIZON;
  float wave = 0.0;
  if (above < 0.0) {
    wave = roostWaves(p, x.tm, K_wind);
    roostRipple = wave;
    vec3 dir = x.v.dir;
    vec3 mirrored = normalize(vec3(dir.x + wave * 0.05, -dir.y + wave * 0.09 + 0.004, dir.z));
    float fresnel = mix(0.35, 0.85, smoothfall(0.07, 0.0, -above));
    roostWater(c, roostMirrored(x, mirrored) * fresnel + vec3(0.01, 0.02, 0.035), 0.5, min(x.zg, ROOST_Z_SEA));
    roostShimmer = 0.16;
  }
  float start = x.aspect - max(0.3, 0.24 * x.aspect);
  float land = roostHeadland(p.x, start);
  if (land > 0.0 && above > -0.004 && above < land) roostPaint(c, mix(ROOST_LAND, roostHaze, 0.25), ROOST_Z_HEADLAND);
  // Its reflection, broken by the swell.
  if (above < -0.004 && -above - 0.004 < roostHeadland(p.x + wave * 0.01, start) * 0.8) c.col = mix(c.col, ROOST_LAND, 0.6);

  float towerX = start + 0.65 * (x.aspect - start);
  float base = RIG_HORIZON + roostHeadland(towerX, start);
  float rise = (p.y - base) / 0.022;
  if (rise > -0.1 && rise < 1.0 && abs(p.x - towerX) < mix(0.0036, 0.0024, clamp(rise, 0.0, 1.0))) roostPaint(c, mix(ROOST_LAND, roostHaze, 0.15), ROOST_Z_HEADLAND);
}

// The lighthouse's lamp: a steady glow with a flash every six seconds as the beam sweeps past, and
// its path down the swell.
void roostLighthouse(Ctx x, inout Cell c) {
  vec2 p = roostP;
  float above = p.y - RIG_HORIZON;
  float start = x.aspect - max(0.3, 0.24 * x.aspect);
  float towerX = start + 0.65 * (x.aspect - start);
  float base = RIG_HORIZON + roostHeadland(towerX, start);
  vec2 lamp = vec2(towerX, base + 0.025);
  float flash = 0.35 + 0.65 * pow(0.5 + 0.5 * cos(x.tm * TAU / 6.0), 24.0);
  float d = length(p - lamp);
  float light = (smoothfall(0.0035, 0.0015, d) * (0.5 + 0.5 * flash) + exp(-d / 0.012) * 0.35 * flash) * roostLights;
  if (above < 0.0) light += smoothfall(0.003, 0.0008, abs(p.x - towerX + roostRipple * 0.006)) * exp(above * 25.0) * roostLights * flash * 0.6;
  roostGlow(c, clamp(light, 0.0, 1.0), ROOST_Z_HEADLAND);
}
#endif

// The skyline: a thin band along the bottom, never more than about an eighth of the frame (the
// test reaches higher so the lighthouse's halo fades out before it).
void roostFar(Ctx x, inout Cell c) {
  if (x.uv.y >= 0.2) return;
  int skyline = int(K_skyline + 0.5);
#if ROOST_CITY
  if (skyline == 0) roostCity(c);
#endif
#if ROOST_REEDS
  if (skyline == 1) roostReedbed(x, c);
#endif
#if ROOST_SEA
  if (skyline != 0 && skyline != 1) roostSea(x, c);
#endif
  roostZ = c.z;
}

// The lamps, over the flock behind them.
void roostFarVeil(Ctx x, inout Cell c) {
  if (x.uv.y >= 0.2) return;
  int skyline = int(K_skyline + 0.5);
#if ROOST_REEDS
  if (skyline == 1) roostShoreLamps(x, c);
#endif
#if ROOST_SEA
  if (skyline != 0 && skyline != 1) roostLighthouse(x, c);
#endif
}

// The reeds, in front of everything.
void roostMiddle(Ctx x, inout Cell c) {
#if ROOST_REEDS
  if (x.uv.y >= 0.2 || int(K_skyline + 0.5) != 1 || ROOST_Z_REEDS >= c.z) return;
  float reeds = roostReeds(roostP, x.tm, K_wind);
  c.col = mix(c.col, ROOST_REED, reeds);
  c.accent *= 1.0 - reeds;
  if (reeds >= 0.5) {
    c.z = ROOST_Z_REEDS;
    c.zs = ROOST_Z_REEDS;
  }
#endif
}

// The water's sparkle: the dither's threshold jitter where the still water or the sea lies.
void roostShade(Ctx x, Cell c, inout Shade o) {
  o.shimmer = roostShimmer;
}
`;

/** The murmuration's GLSL: the flock, the falcon and the M, far out in the sky. */
export const murmurationGlsl = `
// ---- the murmuration (flock/shader.ts) ----
const float MURMURATION_Z = ${glslFloat(MURMURATION_DEPTH)};
/** Half the falcon's wingspan, in screen heights. */
const float MURMURATION_FALCON_SPAN = 0.018;
const vec3 MURMURATION_INK = vec3(0.03, 0.025, 0.045);
const vec3 MURMURATION_FALCON_INK = vec3(0.055, 0.042, 0.038);
const vec3 MURMURATION_DUSK = vec3(1.0, 0.54, 0.24);

// A peregrine seen from below in its own frame (x forward, y across, 1 = half its wingspan):
// coverage. Tucked wings give the narrow anchor of a stoop; open, they are long, pointed, swept
// back at the wrist, and beat.
float murmurationFalcon(vec2 q, float open, float beat, float aa) {
  q.y = abs(q.y);
  float d = sdTaperCapsule(q, vec2(0.48, 0.0), vec2(-0.42, 0.0), 0.12, 0.1);
  d = min(d, sdTaperCapsule(q, vec2(-0.38, 0.0), vec2(-0.85, 0.0), 0.07, 0.13));
  float span = mix(0.32, 1.0, open) * (1.0 - 0.18 * open * (0.5 - 0.5 * beat));
  vec2 shoulder = vec2(0.14, 0.06);
  vec2 wrist = vec2(mix(-0.2, 0.02, open), 0.5 * span);
  vec2 tip = vec2(mix(-0.68, -0.32, open) + 0.06 * open * beat, span);
  d = min(d, sdTaperCapsule(q, shoulder, wrist, 0.2, 0.14));
  d = min(d, sdTaperCapsule(q, wrist, tip, 0.14, 0.03));
  return softFill(d, aa);
}

// The flock at uv from its density field (field 0) and the reference density (its row), inked
// (flockInk). Call it only while the field is bound.
vec2 murmurationSheet(vec2 uv) {
  vec2 texel = 1.0 / vec2(textureSize(murmurationField0, 0));
  vec2 fine = texture(murmurationField0, uv).rg;
  vec2 wide = 0.25 * (texture(murmurationField0, uv - texel).rg + texture(murmurationField0, uv + texel).rg
    + texture(murmurationField0, uv + vec2(texel.x, -texel.y)).rg + texture(murmurationField0, uv + vec2(-texel.x, texel.y)).rg);
  float reference = max(murmurationRecord(1, 0).w, 0.01);
  return flockInk(fine, wide, reference);
}

// The Manifold M the flock is drawing (a warm glow along its strokes behind the birds), the flock
// (a stretched sheet is a pale veil, face-on grey, folded back black), the falcon: where nothing
// nearer than the flock stands. Where the birds or the falcon cover the cell, it shows them.
void murmurationFar(Ctx x, inout Cell c) {
  if (MURMURATION_Z >= c.z || !murmurationSimOn()) return;
  vec2 p = vec2(x.uv.x * x.aspect, x.uv.y);
  vec4 mark = murmurationRecord(2, 0);
  float markOn = mark.x;
  float markDist = 1.0;
  if (markOn > 0.001) markDist = markDistance((p - vec2(mark.y * x.aspect, mark.z)) / mark.w) * mark.w;
  vec3 col = c.col + MURMURATION_DUSK * markOn * exp(-markDist / 0.035) * 0.3;
  float accent = c.accent;

  float cover = 0.0;
  if (murmurationField0On()) {
    vec2 sheet = murmurationSheet(x.uv);
    cover = sheet.x;
    col = mix(col, mix(MURMURATION_INK, col, 0.1 * (1.0 - sheet.y)), cover);
  }
  accent *= 1.0 - cover;
  accent = max(accent, markOn * cover * smoothfall(0.06, 0.015, markDist));

  float falcon = 0.0;
  vec4 shown = murmurationRecord(1, 0);
  if (shown.x > 0.5) {
    vec4 pose = murmurationRecord(0, 0);
    vec2 d = (p - vec2(pose.x * x.aspect, pose.y)) / MURMURATION_FALCON_SPAN;
    vec2 q = vec2(dot(d, pose.zw), dot(d, vec2(-pose.w, pose.z)));
    falcon = murmurationFalcon(q, shown.y, shown.z, x.aa / MURMURATION_FALCON_SPAN);
    col = mix(col, MURMURATION_FALCON_INK, falcon);
    accent *= 1.0 - falcon;
  }
  c.col = col;
  c.accent = accent;
  if (max(cover, falcon) >= 0.5) {
    c.z = MURMURATION_Z;
    c.zs = min(c.zs, MURMURATION_Z);
  }
}
`;
