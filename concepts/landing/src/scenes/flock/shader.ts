// The murmuration's picture: a dusk sky from the shared sky library, the flock inked from the
// simulation's density field (sim.ts), the falcon, the Manifold M the flock can draw, and a low
// skyline (city, reeds on still water, or the sea) that frames the sky without competing with it.
//
// uSim0 rg: R birds per texel, G the same weighted by how hard they roll (startled birds show more
// wing, so a startle wave runs through the flock as a dark band). uSim1 3×1: falcon position and
// heading; falcon shown / wings open / wingbeat, and in w the birds per texel of a sheet of birds at
// the reference density seen face-on; M strength / centre / height (see sim.ts).

// The flock's sheet inked from the simulation's density field: shared with every scene that flies
// the flock (flockSim, or a Flock packed into a texture of the scene's own, which samples its field
// itself and inks it with flockInk), so the birds read the same wherever they fly.
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

// The flock at uv from uSim0 (and uSim1's reference density), inked (flockInk). Call it only while
// uSimOn.x is set.
vec2 flockSheet(vec2 uv) {
  vec2 texel = 1.0 / vec2(textureSize(uSim0, 0));
  vec2 fine = texture(uSim0, uv).rg;
  vec2 wide = 0.25 * (texture(uSim0, uv - texel).rg + texture(uSim0, uv + texel).rg
    + texture(uSim0, uv + vec2(texel.x, -texel.y)).rg + texture(uSim0, uv + vec2(-texel.x, texel.y)).rg);
  float reference = uSimOn.y > 0.5 ? max(texelFetch(uSim1, ivec2(1, 0), 0).w, 0.01) : 1.0;
  return flockInk(fine, wide, reference);
}
`;

export const flockGlsl = `
${flockInkGlsl}
// The horizon sits behind the skyline; the camera looks a little left, toward where the sun sets.
const float FLOCK_HORIZON = 0.08;
const float FLOCK_FOV = 1.0;
const float FLOCK_VIEW_TURN = 0.75;
/** Half the falcon's wingspan, in screen heights. */
const float FLOCK_FALCON_SPAN = 0.018;
const vec3 FLOCK_INK = vec3(0.03, 0.025, 0.045);
const vec3 FLOCK_FALCON_INK = vec3(0.055, 0.042, 0.038);
const vec3 FLOCK_LAND = vec3(0.025, 0.022, 0.035);
const vec3 FLOCK_REED = vec3(0.03, 0.028, 0.03);
const vec3 FLOCK_DUSK = vec3(1.0, 0.54, 0.24);
const vec3 FLOCK_LAMP = vec3(1.0, 0.76, 0.42);

vec3 flockRay(vec2 uv, float aspect) {
  vec3 d = viewRay(uv, aspect, FLOCK_HORIZON, FLOCK_FOV);
  d.xz = rotate(d.xz, FLOCK_VIEW_TURN);
  return d;
}

// A peregrine seen from below in its own frame (x forward, y across, 1 = half its wingspan):
// coverage. Tucked wings give the narrow anchor of a stoop; open, they are long, pointed, swept
// back at the wrist, and beat.
float flockFalcon(vec2 q, float open, float beat, float aa) {
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

// Ripples on open water seen at a grazing angle: noise laid on the water plane, so it compresses
// toward the horizon; faded out where it would get finer than the dither.
float flockWaves(vec2 p, float tm, float wind) {
  float near = max(FLOCK_HORIZON - p.y, 0.002);
  vec2 plane = vec2(p.x / near, 1.0 / near) * 0.05;
  float w = vnoise(plane * vec2(3.0, 7.0) + vec2(tm * 0.04 * wind, tm * 0.22))
    + 0.5 * vnoise(plane * vec2(7.0, 15.0) + vec2(-tm * 0.06, tm * 0.35));
  return (w / 1.5 - 0.5) * smoothstep(0.0, 0.03, near);
}

// One row of blocks: the roof height at x (screen heights), or -1 in the gap between two blocks.
// Heights skew low; one block in a dozen is a tower.
float flockBlocks(float x, float width, float seed, float low, float high) {
  float i = floor(x / width);
  float gap = 0.04 + 0.18 * hash12(vec2(i, seed + 1.7));
  if (fract(x / width) < gap) return -1.0;
  float r = hash12(vec2(i, seed));
  float tower = step(0.92, hash12(vec2(i, seed + 4.2)));
  return low + (high - low) * r * r + tower * (high - low) * 0.8;
}

// Rooftops: a hazy far row behind a dark near one whose windows light up as night falls.
void flockCity(vec2 p, vec3 haze, float lights, inout vec3 col, inout float accent) {
  float above = p.y - FLOCK_HORIZON;
  float far = max(flockBlocks(p.x, 0.019, 3.0, 0.004, 0.03), flockBlocks(p.x + 0.007, 0.013, 9.0, 0.0, 0.022));
  if (above < far) {
    col = mix(FLOCK_LAND, haze, 0.45);
    accent = 0.0;
  }
  float roof = max(max(flockBlocks(p.x, 0.034, 1.0, 0.035, 0.085), flockBlocks(p.x + 0.013, 0.022, 7.0, 0.025, 0.07)), 0.03);
  if (p.y < roof) {
    col = FLOCK_LAND;
    accent = 0.0;
    // Windows on a fixed grid: as the sky darkens the lit share sweeps up through each window's
    // own threshold, so they come on one by one and then stay.
    vec2 g = p / vec2(0.009, 0.012);
    vec2 f = fract(g);
    float pane = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.75) * step(0.03, p.y) * step(p.y, roof - 0.005);
    float lit = pane * step(hash12(floor(g) + 7.7), lights * 0.38);
    col = mix(col, FLOCK_LAMP * (0.55 + 0.45 * hash12(floor(g) + 2.1)), lit);
    accent = lit;
  }
}

// The far shore of the water: a low line of trees and hedges, height above the horizon.
float flockShore(float x) {
  return 0.003 + 0.012 * vnoise(vec2(x * 4.0, 1.3)) + 0.006 * vnoise(vec2(x * 15.0, 2.9));
}

// Reeds standing in the water along the bottom edge, in clumps: coverage of stems and plumes.
// They lean downwind and sway slowly; stems are two cells wide so they never shimmer.
float flockReeds(vec2 p, float tm, float wind) {
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

// Still water with a reed bed: the sky and the far shore mirrored, a few lights on the shore.
void flockReedbed(vec2 p, float aspect, Sky sky, vec3 dir, vec3 haze, float lights, float tm, inout vec3 col, inout float accent, inout float shimmer) {
  float above = p.y - FLOCK_HORIZON;
  vec3 shoreColor = mix(FLOCK_LAND, haze, 0.4);
  if (above >= 0.0 && above < flockShore(p.x)) {
    col = shoreColor;
    accent = 0.0;
  }
  float ripple = 0.0;
  if (above < 0.0) {
    ripple = flockWaves(p, tm, K_wind);
    vec3 mirrored = normalize(vec3(dir.x, -dir.y + ripple * 0.025, dir.z));
    col = skyColor(sky, mirrored) * 0.7 + vec3(0.0, 0.01, 0.02);
    if (-above < flockShore(p.x + ripple * 0.004) * 0.9) col = mix(col, shoreColor, 0.85);
    accent *= 0.4;
    shimmer = max(shimmer, 0.1);
  }
  for (int k = 0; k < 2; k++) {
    vec2 lamp = vec2(aspect * (k == 0 ? 0.19 : 0.64), FLOCK_HORIZON + 0.004);
    float on = lights * step(0.35 - 0.3 * float(k), lights);
    float bulb = smoothfall(0.0028, 0.0012, length((p - lamp) * vec2(1.0, 1.4))) * on;
    float streak = above < 0.0 ? smoothfall(0.0022, 0.0006, abs(p.x - lamp.x + ripple * 0.006)) * exp(above * 30.0) * on * (0.5 + ripple) : 0.0;
    float glow = max(bulb, streak * 0.7);
    col = mix(col, FLOCK_LAMP, glow);
    accent = max(accent, glow);
  }
  float reeds = flockReeds(p, tm, K_wind);
  col = mix(col, FLOCK_REED, reeds);
  accent *= 1.0 - reeds;
}

// The headland's height above the horizon at x, rising to the right edge.
float flockHeadland(float x, float start) {
  return 0.03 * smoothstep(start, start + 0.08, x) * (0.85 + 0.15 * vnoise(vec2(x * 30.0, 4.0)));
}

// Open sea to the horizon, the sky mirrored in its swell, a headland with a lighthouse.
void flockSea(vec2 p, float aspect, Sky sky, vec3 dir, vec3 haze, float lights, float tm, inout vec3 col, inout float accent, inout float shimmer) {
  float above = p.y - FLOCK_HORIZON;
  float wave = 0.0;
  if (above < 0.0) {
    wave = flockWaves(p, tm, K_wind);
    vec3 mirrored = normalize(vec3(dir.x + wave * 0.05, -dir.y + wave * 0.09 + 0.004, dir.z));
    float fresnel = mix(0.35, 0.85, smoothfall(0.07, 0.0, -above));
    col = skyColor(sky, mirrored) * fresnel + vec3(0.01, 0.02, 0.035);
    accent *= 0.5;
    shimmer = max(shimmer, 0.16);
  }
  float start = aspect - max(0.3, 0.24 * aspect);
  float land = flockHeadland(p.x, start);
  if (land > 0.0 && above > -0.004 && above < land) {
    col = mix(FLOCK_LAND, haze, 0.25);
    accent = 0.0;
  }
  // Its reflection, broken by the swell.
  if (above < -0.004 && -above - 0.004 < flockHeadland(p.x + wave * 0.01, start) * 0.8) col = mix(col, FLOCK_LAND, 0.6);

  float towerX = start + 0.65 * (aspect - start);
  float base = FLOCK_HORIZON + flockHeadland(towerX, start);
  float rise = (p.y - base) / 0.022;
  if (rise > -0.1 && rise < 1.0 && abs(p.x - towerX) < mix(0.0036, 0.0024, clamp(rise, 0.0, 1.0))) {
    col = mix(FLOCK_LAND, haze, 0.15);
    accent = 0.0;
  }
  // The lamp turns: a steady glow with a flash every six seconds as the beam sweeps past.
  vec2 lamp = vec2(towerX, base + 0.025);
  float flash = 0.35 + 0.65 * pow(0.5 + 0.5 * cos(tm * TAU / 6.0), 24.0);
  float d = length(p - lamp);
  float light = (smoothfall(0.0035, 0.0015, d) * (0.5 + 0.5 * flash) + exp(-d / 0.012) * 0.35 * flash) * lights;
  if (above < 0.0) light += smoothfall(0.003, 0.0008, abs(p.x - towerX + wave * 0.006)) * exp(above * 25.0) * lights * flash * 0.6;
  light = clamp(light, 0.0, 1.0);
  col = mix(col, FLOCK_LAMP, light);
  accent = max(accent, light);
}

// Knobs (K_*): birds, cohesion, chaos, speed, predator, skyline, time, cycle, wind, mark. The
// flock's knobs drive the simulation; here only the sky, the skyline and the wind are read.
Shade sceneFlock(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float tm = uMotionTime;
  float aa = 1.0 / uRes.y;

  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, tm));
  vec3 dir = flockRay(uv, aspect);
  vec3 col = skyColor(sky, dir);
  col += vec3(0.86, 0.88, 1.0) * skyStars(sky, dir, K_stars);
  // The giant planet among the stars, behind the flock and the skyline.
  col = skyGiant(sky, col, dir, FLOCK_FOV / uRes.y, 1.0);
  // The accent palette keeps the afterglow: low sky toward the sun, while there is twilight.
  float accent = 0.8 * pow(max(dot(dir, sky.sun), 0.0), 10.0) * exp(-max(dir.y, 0.0) * 5.0) * clamp(sky.twilight + 0.3 * sky.day, 0.0, 1.0);
  float lights = clamp(sky.night + 0.6 * sky.twilight, 0.0, 1.0);
  float shimmer = 0.0;

  // The Manifold M the flock is drawing: a warm glow along its strokes behind the birds.
  float markOn = 0.0;
  float markDist = 1.0;
  if (uSimOn.y > 0.5) {
    vec4 mark = texelFetch(uSim1, ivec2(2, 0), 0);
    markOn = mark.x;
    if (markOn > 0.001) markDist = markDistance((p - vec2(mark.y * aspect, mark.z)) / mark.w) * mark.w;
  }
  col += FLOCK_DUSK * markOn * exp(-markDist / 0.035) * 0.3;

  // The flock (flockSheet): a stretched sheet is a pale veil, face-on grey, folded back black.
  float cover = 0.0;
  if (uSimOn.x > 0.5) {
    vec2 sheet = flockSheet(uv);
    cover = sheet.x;
    col = mix(col, mix(FLOCK_INK, col, 0.1 * (1.0 - sheet.y)), cover);
  }
  accent *= 1.0 - cover;
  accent = max(accent, markOn * cover * smoothfall(0.06, 0.015, markDist));

  if (uSimOn.y > 0.5) {
    vec4 shown = texelFetch(uSim1, ivec2(1, 0), 0);
    if (shown.x > 0.5) {
      vec4 pose = texelFetch(uSim1, ivec2(0, 0), 0);
      vec2 d = (p - vec2(pose.x * aspect, pose.y)) / FLOCK_FALCON_SPAN;
      vec2 q = vec2(dot(d, pose.zw), dot(d, vec2(-pose.w, pose.z)));
      float falcon = flockFalcon(q, shown.y, shown.z, aa / FLOCK_FALCON_SPAN);
      col = mix(col, FLOCK_FALCON_INK, falcon);
      accent *= 1.0 - falcon;
    }
  }

  // The skyline: a thin band along the bottom, never more than about an eighth of the frame (the
  // test reaches higher so the lighthouse's halo fades out before it).
  if (uv.y < 0.2) {
    vec3 haze = horizonHaze(sky, dir, 0.01);
    int skyline = int(K_skyline + 0.5);
    if (skyline == 0) flockCity(p, haze, lights, col, accent);
    else if (skyline == 1) flockReedbed(p, aspect, sky, dir, haze, lights, tm, col, accent, shimmer);
    else flockSea(p, aspect, sky, dir, haze, lights, tm, col, accent, shimmer);
  }

  Shade o = shadeOf(col, inkOf(col, 1.4, 1.0), clamp(accent, 0.0, 1.0));
  o.shimmer = shimmer;
  return o;
}
`;
