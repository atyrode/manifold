// Shared sky: the clock, sun and moon, a side-on camera ray, an analytic sky dome with sun and moon
// discs, stars, and a cloud deck seen from below. Compiled into every scene program right after the
// common preamble; the contract and conventions are in src/scenes/README.md.

export const skyGlsl = `
// ---- sky ----

// The clock: K_time and K_cycle -> 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset). At cycle 1 a
// whole day passes in four minutes; uMotion slows it with the rest of the scene.
float timeOfDay(float time, float cycle, float t) {
  return fract(time + cycle * uMotion * t / 240.0);
}

struct Sky {
  vec3 sun;       // unit direction (x right, y up, z into the scene)
  vec3 moon;      // unit direction
  float day;      // 0..1, full once the sun is ~12 degrees up
  float twilight; // 0..1, peaks with the sun on the horizon, lingers through civil and nautical twilight
  float night;    // 0..1, first stars at ~5 degrees down, full once the sun is ~15 degrees down
  vec3 sunColor;  // direct sunlight, reddened by the air mass; 0 once the sun has set
  vec3 ambient;   // light from the whole sky, for shading; never 0
  vec3 moonColor; // direct moonlight, cool and soft; 0 below the horizon and by day
};

// Sun and moon ride the daily circles of a low-latitude sky (15 degrees) seen facing the equator,
// the celestial pole low behind the viewer. Negative declinations put both circles in front: the sun
// (-28 degrees, a winter sun) rises ~61 degrees right of straight ahead, culminates 47 degrees up dead
// ahead and sets ~61 degrees left, so sunrise, golden hour and sunset happen in or near the frame;
// the moon (-45 degrees) runs a lower arc, rising ~43 degrees right, 30 degrees up ahead at midnight.
const float SKY_COS_LAT = 0.965926;
const float SKY_SIN_LAT = 0.258819;
const float SKY_SUN_COS_DEC = 0.882948;
const float SKY_SUN_SIN_DEC = -0.469472;
const float SKY_MOON_COS_DEC = 0.707107;
const float SKY_MOON_SIN_DEC = -0.707107;
// The sun's hour angle at sunrise, acos(-tan(dec) tan(lat)). The clock is warped onto it so the sun
// crosses the horizon exactly at .25 and .75 as the K_time contract says, and eased so it lingers
// around sunrise and sunset (half speed there, 1.5x at noon and midnight): golden hour and twilight
// get a wider stretch of the time slider, as they would at higher latitudes.
const float SKY_SUN_H0 = 1.427839;
// Angular radii in radians, ~4x true size so the discs survive a 2-4 px dither.
const float SKY_SUN_RADIUS = 0.02;
const float SKY_MOON_RADIUS = 0.024;

// A body on its daily circle at hour angle h (0 = culmination, negative = rising on the right).
vec3 skyBody(float h, float cosDec, float sinDec) {
  float c = cosDec * cos(h);
  return vec3(-cosDec * sin(h), c * SKY_COS_LAT + sinDec * SKY_SIN_LAT, c * SKY_SIN_LAT - sinDec * SKY_COS_LAT);
}

// Transmittance of a beam arriving at elevation sine e. Air mass ~ 1 / (e + 0.036), about 28 at the
// horizon (a simplification of Kasten and Young 1989), times a Rayleigh-like extinction that grows
// toward blue, so low light turns gold, then orange, then red.
vec3 skyTransmit(float e) {
  float m = 1.0 / (max(e, 0.0) + 0.036);
  return exp(-vec3(0.020, 0.056, 0.125) * m);
}

Sky skyAt(float tod) {
  Sky s;
  float d = fract(tod - 0.25); // 0 sunrise, 0.5 sunset
  float u = fract(d * 2.0);    // progress through the day half or the night half
  u -= 0.5 * sin(TAU * u) / TAU;
  float h = d < 0.5 ? mix(-SKY_SUN_H0, SKY_SUN_H0, u) : mix(SKY_SUN_H0, TAU - SKY_SUN_H0, u);
  s.sun = skyBody(h, SKY_SUN_COS_DEC, SKY_SUN_SIN_DEC);
  s.moon = skyBody(tod * TAU, SKY_MOON_COS_DEC, SKY_MOON_SIN_DEC);
  float e = s.sun.y;
  s.day = smoothstep(-0.02, 0.22, e);
  // Asymmetric bell: golden hour above the horizon, civil and nautical twilight below it.
  float w = (e + 0.02) / (e > -0.02 ? 0.17 : 0.15);
  s.twilight = exp(-w * w);
  s.night = 1.0 - smoothstep(-0.26, -0.03, e);
  s.sunColor = skyTransmit(e) * smoothstep(-0.035, 0.02, e);
  float moonUp = smoothstep(-0.02, 0.06, s.moon.y);
  s.moonColor = vec3(0.30, 0.36, 0.50) * sqrt(skyTransmit(s.moon.y)) * moonUp * (1.0 - s.day);
  // Dusk light is warm while the sun is up and turns blue once it has set (the blue hour).
  vec3 dusk = mix(vec3(0.12, 0.15, 0.30), vec3(0.36, 0.25, 0.30), smoothstep(-0.1, 0.03, e));
  s.ambient = vec3(0.030, 0.038, 0.075) + vec3(0.40, 0.48, 0.62) * s.day + dusk * s.twilight * (1.0 - s.day) + s.moonColor * 0.3;
  return s;
}

// Side-on pinhole camera with a shifted lens (no pitch): verticals stay vertical and the horizon is
// the straight line uv.y = horizon. fov is the full vertical field of view in radians.
vec3 viewRay(vec2 uv, float aspect, float horizon, float fov) {
  return normalize(vec3((uv.x - 0.5) * aspect, uv.y - horizon, 0.5 / tan(0.5 * fov)));
}

// Overhead colour through the day, keyed by the sun's elevation sine.
vec3 skyZenith(float e) {
  vec3 c = vec3(0.008, 0.011, 0.034);                                 // night: deep indigo
  c = mix(c, vec3(0.022, 0.032, 0.090), smoothstep(-0.32, -0.22, e)); // astronomical twilight
  c = mix(c, vec3(0.060, 0.100, 0.250), smoothstep(-0.22, -0.10, e)); // nautical: the blue hour
  c = mix(c, vec3(0.150, 0.240, 0.480), smoothstep(-0.10, 0.00, e));  // civil twilight to sunset
  c = mix(c, vec3(0.180, 0.340, 0.700), smoothstep(0.00, 0.15, e));   // low sun
  c = mix(c, vec3(0.120, 0.300, 0.720), smoothstep(0.15, 0.60, e));   // high sun: deeper blue
  return c;
}

// Horizon colour away from the sun: pale haze by day, lilac at sunset, faint airglow at night.
vec3 skyHorizon(float e) {
  vec3 c = vec3(0.030, 0.038, 0.066);
  c = mix(c, vec3(0.045, 0.052, 0.110), smoothstep(-0.32, -0.22, e));
  c = mix(c, vec3(0.150, 0.150, 0.290), smoothstep(-0.22, -0.10, e));
  c = mix(c, vec3(0.460, 0.380, 0.490), smoothstep(-0.10, 0.00, e));
  c = mix(c, vec3(0.720, 0.700, 0.700), smoothstep(0.00, 0.15, e));
  c = mix(c, vec3(0.640, 0.760, 0.900), smoothstep(0.15, 0.45, e));
  return c;
}

// The sky dome for a view ray: a Rayleigh-like zenith-to-horizon gradient, sunset bands toward the
// sun's azimuth (gold/orange low, pink above, violet higher), the Earth's shadow and the Belt of Venus
// opposite, moonlit blue and airglow at night, the sun with a Mie aureole and the moon with a halo.
// Below the horizon: the horizon colour dimming into haze, without discs. No stars (skyStars).
vec3 skyColor(Sky sky, vec3 dir) {
  float e = sky.sun.y;
  float hh = max(dir.y, 0.0);
  vec3 col = mix(skyZenith(e), skyHorizon(e), exp(-hh * 5.0));

  // 1 looking toward the sun's azimuth, 0 away from it.
  vec2 dxz = dir.xz;
  vec2 sxz = sky.sun.xz;
  float toward = 0.5 + 0.5 * dot(dxz, sxz) * inversesqrt(max(dot(dxz, dxz) * dot(sxz, sxz), 1e-8));
  float toward2 = toward * toward;

  // Golden hour, sunset and afterglow: bands stacked by height, strongest toward the sun, dimming as
  // it sinks. 'after' moves the palette from gold to red-orange and pink once the sun is down.
  float tw = sky.twilight;
  float after = 1.0 - smoothstep(-0.07, 0.05, e);
  float lit = smoothstep(-0.28, -0.02, e);
  vec3 high = vec3(0.34, 0.24, 0.52) * lit;
  vec3 mid = mix(vec3(0.98, 0.64, 0.50), vec3(0.88, 0.36, 0.46), after) * lit;
  vec3 low = mix(vec3(1.0, 0.64, 0.28), vec3(0.98, 0.34, 0.10), after) * lit;
  col = mix(col, high, tw * toward * exp(-hh * 2.0) * (1.0 - exp(-hh * 8.0)) * (0.2 + 0.4 * after));
  col = mix(col, mid, tw * toward2 * exp(-hh * 5.0) * (0.25 + 0.35 * after));
  col = mix(col, low, tw * toward2 * toward * exp(-hh * 14.0) * 0.85);
  // By day the haze is brighter on the sun's side.
  col += sky.sunColor * toward2 * exp(-hh * 3.0) * 0.1 * sky.day;

  // Opposite the sun just after sunset: the dark blue Earth's shadow on the horizon and the pink
  // Belt of Venus above it.
  float anti = 1.0 - toward;
  float belt = anti * anti * smoothstep(-0.16, -0.04, e) * (1.0 - smoothstep(-0.01, 0.05, e));
  col = mix(col, vec3(0.14, 0.16, 0.30), belt * exp(-hh * 35.0) * 0.55);
  float bh = (hh - 0.1) / 0.07;
  col += vec3(0.22, 0.09, 0.15) * belt * exp(-bh * bh);

  // Night: moonlight turns the sky blue; airglow lifts a faint green band a few degrees up.
  float moonVis = smoothstep(-0.02, 0.04, sky.moon.y) * (1.0 - sky.day);
  col += vec3(0.018, 0.028, 0.060) * moonVis * sky.night * (0.6 + 0.4 * exp(-hh * 3.0));
  col += vec3(0.012, 0.026, 0.020) * sky.night * hh * exp(-hh * 12.0) * 30.0;

  // Sun: three exponential lobes standing in for the Mie (Henyey-Greenstein) forward peak, then a
  // disc cut by the horizon. a = 1 - cos(angle), computed from the chord so it stays precise.
  float horizonCut = smoothstep(-0.004, 0.004, dir.y);
  vec3 dv = dir - sky.sun;
  float a = 0.5 * dot(dv, dv);
  col += sky.sunColor * (0.30 * exp(-a * 1400.0) + 0.16 * exp(-a * 90.0) + 0.07 * exp(-a * 10.0));
  col += sky.sunColor * (1.0 - smoothstep(SKY_SUN_RADIUS * 0.8, SKY_SUN_RADIUS, length(dv))) * horizonCut * 2.5;

  // Moon: a cool halo, then a disc with soft maria and limb darkening (no phase), gold when low.
  vec3 mv = dir - sky.moon;
  float am = 0.5 * dot(mv, mv);
  col += vec3(0.30, 0.36, 0.52) * (0.20 * exp(-am * 2500.0) + 0.06 * exp(-am * 120.0)) * moonVis;
  float md = length(mv);
  if (md < SKY_MOON_RADIUS) {
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), sky.moon)); // the moon never reaches the zenith
    vec3 up = cross(sky.moon, right);
    vec2 q = vec2(dot(mv, right), dot(mv, up)) / SKY_MOON_RADIUS;
    float l = length(q);
    float maria = vnoise(q * 2.3 + 4.7) * 0.65 + vnoise(q * 5.1 + 1.3) * 0.35;
    float shade = (1.0 - 0.3 * smoothstep(0.45, 0.68, maria)) * (0.8 + 0.2 * sqrt(max(1.0 - l * l, 0.0)));
    vec3 face = vec3(0.95, 0.94, 0.90) * shade * sqrt(skyTransmit(sky.moon.y));
    col = mix(col, face, (1.0 - smoothstep(0.82, 1.0, l)) * horizonCut * mix(1.0, 0.35, sky.day));
  }

  // Below the horizon: the horizon colour fading into a dim haze.
  return col * mix(1.0, 0.35, smoothstep(0.0, 0.25, -dir.y));
}

// One layer of stars on an equi-angular cube map of the sky: each face is a grid of cells that may
// hold one star, so a star belongs to a direction and never moves. atan() evens out the cells (plain
// gnomonic cells shrink ~5x in solid angle toward the cube corners and would bunch stars on the
// edges). size is the largest radius in cells; salt decorrelates layers.
float skyStarLayer(vec3 dir, float cells, float fill, float size, float salt) {
  vec3 a = abs(dir);
  vec2 f = vec2(0.0);
  float face = 0.0;
  if (a.x >= a.y && a.x >= a.z) {
    f = dir.zy / a.x;
    face = dir.x > 0.0 ? 0.0 : 1.0;
  } else if (a.y >= a.z) {
    f = dir.xz / a.y;
    face = dir.y > 0.0 ? 2.0 : 3.0;
  } else {
    f = dir.xy / a.z;
    face = dir.z > 0.0 ? 4.0 : 5.0;
  }
  vec2 g = (atan(f) * (2.0 / 3.14159265) + 0.5) * cells;
  vec2 id = floor(g);
  float h = hash12(id + vec2(face * 157.0 + salt, salt * 3.7));
  if (h >= fill) return 0.0;
  float u = h / fill; // uniform 0..1 among the cells that hold a star
  float h2 = hash12(id.yx + vec2(salt * 1.9 + 11.0, face * 61.0));
  vec2 c = 0.25 + 0.5 * vec2(h2, fract(h2 * 67.3));
  float m = u * u * u; // magnitudes: many faint stars, a few bright ones
  float r = size * (0.4 + 0.6 * m);
  float star = (1.0 - smoothstep(0.0, r, length(g - id - c))) * (0.3 + 0.7 * m);
  // Gentle twinkle, each star at its own slow rate; deeper near the horizon (scintillation).
  float wave = 0.5 + 0.5 * sin(uTime * uMotion * (0.8 + 2.2 * fract(h2 * 13.7)) + TAU * fract(h2 * 29.1));
  float depth = mix(0.12, 0.45, 1.0 - smoothstep(0.05, 0.45, dir.y));
  return star * (1.0 - depth * wave);
}

// Stars for a view ray, 0..1: a dense layer of faint stars and a sparse one of bright stars. density
// 0..1 (1 is a dark-site sky). Already faded by daylight, toward the horizon and around the moon.
float skyStars(Sky sky, vec3 dir, float density) {
  if (dir.y <= 0.0 || sky.night <= 0.0 || density <= 0.0) return 0.0;
  float s = skyStarLayer(dir, 120.0, 0.22 * density, 0.2, 0.0)
          + skyStarLayer(dir, 44.0, 0.1 * density, 0.09, 7.0) * 1.3;
  float fade = sky.night * smoothstep(0.0, 0.22, dir.y) * smoothstep(0.03, 0.1, length(dir - sky.moon));
  return clamp(s * fade, 0.0, 1.0);
}

// Cloud density on the deck: rotated fbm octaves over a slowly evolving domain warp (Quilez, "Domain
// warping", 2002). foot is the pixel footprint in deck units: octaves finer than ~3 pixels give way to
// their mean, so cloud near the horizon stays smooth instead of crawling as it drifts.
float skyCloudField(vec2 p, float foot, float t) {
  vec2 w = vec2(vnoise(p * 0.6 + vec2(t * 0.011, 5.2)), vnoise(p * 0.6 + vec2(1.7, 9.4 - t * 0.009)));
  vec2 q = (p + (w - 0.5) * 0.9) * 1.4;
  float s = 0.0;
  float a = 0.5;
  float f = 1.4;
  for (int i = 0; i < 5; i++) {
    float keep = 1.0 - smoothstep(0.18, 0.45, foot * f);
    if (keep <= 0.0) {
      s += a; // the remaining octaves at their mean: 0.5 x (a + a/2 + ...)
      break;
    }
    s += a * mix(0.5, vnoise(q), keep);
    q = mat2(1.6, 1.2, -1.2, 1.6) * q + vec2(3.1, 7.7);
    f *= 2.0;
    a *= 0.5;
  }
  return s;
}

// A cloud deck seen from below: the ray meets a plane one unit up (deck point = dir.xz / dir.y, in
// cloud-base heights, eye at the origin). cover 0..1: 0 clear, ~.35 fair-weather cumulus, .6 broken,
// 1 overcast. wind -1..1 drifts it sideways; it always evolves and creeps closer a little. Lit by the
// sun on the flanks that face it, silver-lined where the sun or moon is behind thin cloud, gold and
// then pink underneath around sunset, moonlit at night. Returns straight (not premultiplied) rgb and
// alpha, which fades out toward the horizon: col = mix(col, c.rgb, c.a).
vec4 skyClouds(Sky sky, vec3 dir, float t, float cover, float wind) {
  if (dir.y <= 0.015 || cover <= 0.0) return vec4(0.0);
  float tm = t * uMotion;
  vec2 p = dir.xz / dir.y - vec2(0.09 * wind, -0.01) * tm;
  // Deck units per pixel, taking a screen height as ~1 radian of view.
  float foot = 1.0 / (uRes.y * dir.y * dir.y);
  float n = skyCloudField(p, foot, tm);
  float th = mix(0.74, 0.2, clamp(cover, 0.0, 1.0));
  float alpha = smoothstep(th, th + 0.18, n);
  if (alpha <= 0.0) return vec4(0.0);
  float thick = smoothstep(th, th + 0.42, n);
  float thin = 1.0 - smoothstep(0.0, 0.55, thick);

  // Light across the deck from the sun (by day and dusk) or the moon: brighter where the cloud thins
  // toward the light, from a second, coarse density tap a step toward it.
  vec3 light = sky.sun.y > -0.1 ? sky.sun : sky.moon;
  vec2 lxz = normalize(light.xz); // neither body ever reaches the zenith
  float n2 = skyCloudField(p + lxz * 0.22, max(foot, 0.12), tm);
  float side = clamp(0.5 + (n - n2) * 3.5, 0.0, 1.0);

  float e = sky.sun.y;
  vec2 dxz = dir.xz;
  vec2 sxz = sky.sun.xz;
  float toward = 0.5 + 0.5 * dot(dxz, sxz) * inversesqrt(max(dot(dxz, dxz) * dot(sxz, sxz), 1e-8));
  // Undersides lit by the sky dome, greyed: clouds are white and pass less of the sky's blue.
  vec3 amb = mix(vec3(dot(sky.ambient, LUMA)), sky.ambient, 0.5);
  vec3 col = amb * 0.95 * (1.0 - 0.45 * thick);
  // Direct sun on the flanks that face it.
  col += sky.sunColor * (0.1 + 0.4 * side) * (1.0 - 0.6 * thick);
  // A low sun reaches under the deck: gold, then orange (sunColor reddens by itself).
  col += sky.sunColor * (1.0 - smoothstep(0.03, 0.3, e)) * (0.3 + 0.7 * toward) * 0.6;
  // Afterglow: still lit from below the horizon, undersides go orange, then pink, then grey.
  vec3 glow = mix(vec3(0.70, 0.26, 0.42), vec3(1.0, 0.46, 0.20), smoothstep(-0.08, 0.02, e));
  col += glow * sky.twilight * (1.0 - smoothstep(0.02, 0.2, e)) * (0.3 + 0.7 * toward) * (1.0 - 0.5 * thick) * 0.55;
  // Silver lining: forward scattering lights thin edges near the sun or moon (lobe ~16 degrees).
  vec3 dv = dir - sky.sun;
  vec3 mv = dir - sky.moon;
  col += sky.sunColor * exp(-dot(dv, dv) * 12.0) * thin * 2.2;
  col += sky.moonColor * exp(-dot(mv, mv) * 16.0) * thin * 2.0;
  // Moonlit body.
  col += sky.moonColor * (0.45 + 0.4 * side) * (1.0 - 0.5 * thick);
  return vec4(col, alpha * smoothstep(0.015, 0.16, dir.y));
}
`;
