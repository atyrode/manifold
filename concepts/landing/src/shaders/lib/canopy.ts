// Shared weather under a closed canopy (bamboo, forest): the rain's cloud closing over the sky and the
// light it leaves, where the key light (sun or moon) comes from and how its shafts slant, where the
// shafts leave the canopy, where the canopy is open overhead, and the sky seen through those gaps.
// Compiled into every scene program after the sky and weather libraries; the contract and conventions
// are in src/scenes/README.md.
//
// The grove under it (canopyGroveGlsl, opt-in: the scene interpolates it into its own GLSL): the
// shafts falling from the gaps, the canopy's ragged underside and the drips running off it, each
// shaped by the scene's own constants. The scene keeps its own look: the leaves' tint on the light
// and the sky, the fill and the shelter (how much rain gets through under the leaves), its mist, and
// what stands in front.

export const canopyGlsl = `
// ---- canopy ----

// The weather as the grove sees it. sky: the clock's sky under the rain's cloud, the sun and the moon
// gone as it closes and the ambient turned toward the deck's grey; rain: the rain knob; overcast 0..1:
// how far the cloud has closed (drizzle lets some sun through, gone from a quarter of the knob up);
// cloud: the deck's brightness (luminance), lit from above, so the light turns grey but stays, dimming
// only in the heaviest rain; keySide: the key light's level heading (x across, z into the scene), unit,
// sun and moon weighed by their light; slant: shafts' angle from straight down, + falling toward -x.
struct CanopyWeather {
  Sky sky;
  float rain;
  float overcast;
  float cloud;
  vec2 keySide;
  float slant;
};

CanopyWeather canopyWeather(Sky clear, float rain) {
  CanopyWeather w;
  w.rain = rain;
  w.overcast = smoothstep(0.0, 0.25, rain);
  w.cloud = (dot(clear.ambient, LUMA) + 0.3 * dot(clear.sunColor, LUMA)) * (1.0 - 0.3 * rain * rain);
  w.sky = clear;
  w.sky.sunColor *= 1.0 - w.overcast;
  w.sky.moonColor *= 1.0 - w.overcast;
  w.sky.ambient = mix(w.sky.ambient, vec3(0.95, 0.98, 1.0) * w.cloud, w.overcast);
  float sunLevel = dot(w.sky.sunColor, LUMA);
  float moonLevel = dot(w.sky.moonColor, LUMA) * 1.3;
  vec2 side = w.sky.sun.xz * sunLevel + w.sky.moon.xz * moonLevel;
  w.keySide = dot(side, side) > 1e-8 ? normalize(side) : vec2(0.6, 0.8);
  vec3 toLight = normalize(w.sky.sun * sunLevel + w.sky.moon * moonLevel + vec3(0.0, 1e-4, 0.0));
  w.slant = clamp(atan(toLight.x, max(toLight.y, 0.0) + 0.35), -0.85, 0.85);
  return w;
}

// Where three shafts leave the canopy: screen x at the top of the frame, at seed-chosen places
// (base + jitter * spread, in frame widths), drifting very slowly on the motion clock tm, moved along
// their slant.
vec3 canopyRaySources(vec3 base, float spread, float seed, float aspect, float tm, float slant) {
  vec3 jitter = vec3(
    hash12(vec2(1.0, seed * 0.913 + 5.0)),
    hash12(vec2(4.7, seed * 0.913 + 5.0)),
    hash12(vec2(8.4, seed * 0.913 + 5.0))
  );
  return (base + (jitter - 0.5) * spread) * aspect + 0.02 * sin(tm * 0.011 + jitter * 6.0) + tan(slant) * 0.42;
}

// How open the canopy is above screen point p (x across from the centre, y up from the floor): 0
// under the leaves .. 1 in a gap. The gaps lean with the wind and are always open where a shaft
// (raySrc) comes through: where the rain pours in full.
float canopyGap(vec2 p, float wind, float seed, vec3 raySrc) {
  float gapX = p.x - wind * 0.35 * (1.0 - p.y);
  float gap = smoothstep(0.5, 0.75, vnoise(vec2(gapX * 2.2 + seed * 0.37, 7.3)));
  for (int r = 0; r < 3; r++) gap = max(gap, bell((gapX - raySrc[r]) / 0.09));
  return gap;
}

// The sky through a gap at screen point p along dir. washed: the scene's own view of the open sky
// (its hue mostly lost in the leaves). Stars (density 'stars', skyStars) show in it while the sky is
// clear; as the rain's cloud closes in, the deck: grey-white, lit from above (deck: its gain over the
// cloud's luminance), with shafts of heavier rain hanging from it, slanting with the wind.
vec3 canopyGapSky(CanopyWeather w, vec3 washed, vec3 dir, float stars, vec2 p, float wind, float seed, float deck) {
  vec3 col = washed + vec3(0.85, 0.88, 1.0) * skyStars(w.sky, dir, stars) * (1.0 - w.overcast);
  float shafts = smoothstep(0.45, 0.8, vnoise(vec2((p.x - wind * 0.3 * p.y) * 5.0 + seed, 3.7)));
  vec3 grey = vec3(0.94, 0.97, 1.0) * w.cloud * deck * (1.0 - 0.2 * shafts * w.rain);
  return mix(col, grey, 0.9 * w.overcast);
}
`;

/**
 * The grove under a closed canopy (bamboo, forest): its shafts, crowns and drips, each shaped by the
 * scene's constants. Opt-in: interpolate it into the scene's GLSL. Reads `uRes`.
 */
export const canopyGroveGlsl = `
// ---- the grove under the canopy ----

// The shafts: three beams falling from gaps in the canopy (raySrc: screen x where each leaves the top
// of the frame, canopyRaySources) at slant, seen at screen point p. Each is width.x wide where it
// leaves its gap and widens by width.y (and up to 0.04 more, by its seed's hash) per unit it falls,
// is combed by the shadows of what it passed (a few streaks along it, spreading with the beam), and
// breathes in and out over a couple of minutes on the motion clock tm. Returns x: how much p lies in
// a beam (to light what it falls on), y: the beams' glow in the air.
vec2 canopyRays(vec2 p, float tm, vec3 raySrc, float slant, float seed, vec2 width) {
  float b = max(1.02 - p.y, 0.0) / cos(slant);
  float at = p.x + sin(slant) * b;
  float lit = 0.0;
  float glow = 0.0;
  for (int r = 0; r < 3; r++) {
    float h = hash12(vec2(float(r) * 3.7 + 1.0, seed * 0.913 + 5.0));
    float across = (at - raySrc[r]) * cos(slant);
    float w = width.x + (width.y + 0.04 * h) * b;
    float beam = 1.0 - smoothstep(0.25 * w, w, abs(across));
    if (beam <= 0.0) continue;
    float comb = smoothstep(0.6, 0.8, vnoise(vec2(across / w * 3.0 + h * 17.0, 0.5)));
    float breathe = 0.75 + 0.25 * sin(tm * (0.045 + 0.03 * h) + h * TAU);
    beam *= (1.0 - 0.6 * comb) * breathe * (0.65 + 0.35 * h);
    lit = max(lit, beam);
    glow += beam * exp(-0.55 * b);
  }
  return vec2(lit, glow);
}

// A canopy's shape (canopyCrowns). edge: its ragged underside, at screen y edge.x wandering by edge.y
// over a noise of edge.z per unit across; grain, fine: the scales of the leaves' two octaves of
// noise; rise: its cover rising from rise.x below the underside to rise.y above it, the leaves' noise
// moving it by up to rise.z / 2; gaps: open where that noise passes gaps.x .. gaps.y, from screen y
// gaps.z to the top; opening: over each shaft, an opening opening.x wide (a bell) and opening.y deep,
// from screen y opening.z to opening.w.
struct CanopyCrowns { vec3 edge; vec2 grain; vec2 fine; vec3 rise; vec3 gaps; vec4 opening; };

// The canopy overhead at screen point q, as the scene sways it (p: the same point unswayed, which the
// shafts raySrc open while shafts is on), placed by seed. Returns x: its cover 0..1, y: the leaves'
// noise 0..1 (to shade them by), z: 0.3..1, how much of the key light (from keySide, x across and z
// into the scene) reaches its underside from behind.
vec3 canopyCrowns(vec2 q, vec2 p, CanopyCrowns c, float seed, bool shafts, vec3 raySrc, vec2 keySide) {
  float edge = c.edge.x + c.edge.y * vnoise(vec2(q.x * c.edge.z + seed * 0.37, 0.5));
  float n = 0.6 * vnoise(q * c.grain) + 0.4 * vnoise(q * c.fine + 3.1);
  float dens = smoothstep(edge - c.rise.x, edge + c.rise.y, q.y + c.rise.z * (n - 0.5));
  float gap = smoothstep(c.gaps.x, c.gaps.y, n) * smoothstep(c.gaps.z, 1.02, q.y);
  float open = 0.0;
  if (shafts) {
    for (int r = 0; r < 3; r++) open = max(open, bell((p.x - raySrc[r]) / c.opening.x));
  }
  dens *= 1.0 - c.opening.y * open * smoothstep(c.opening.z, c.opening.w, p.y);
  float behind = 0.3 + 0.7 * clamp(keySide.y * 1.5, 0.0, 1.0);
  return vec3(clamp(dens * (1.0 - gap), 0.0, 1.0), n, behind);
}

// A grove's dripping canopy (canopyDrip): its view (horizon: the horizon's screen y; eye: the eye's
// height, m), the columns its tips hang in (width m wide, a share of them dripping at amount 1) and
// the screen heights the tips hang at (tip.x up to tip.x + tip.y).
struct CanopyDrips { float horizon; float eye; float width; float share; vec2 tip; };

// Water gathered in the canopy running off and falling through the grove at depth z (m), seen at
// screen point q. In metres at that depth, columns drips.width wide, drips.share × amount of them
// holding a tip that drips over and over on the motion clock tm: a bead swells at the tip for half
// the beat, lets go and falls under gravity as a streak lengthening with its speed, down to the
// floor; then a fresh tip in the column takes its turn. amount 0..1 also sets how quickly they
// refill; salt sets the layer apart. Returns coverage; a falling drop is never narrower than two
// cells.
float canopyDrip(vec2 q, float tm, float amount, float z, float salt, CanopyDrips drips) {
  vec2 w = vec2(q.x * z, (q.y - drips.horizon) * z + drips.eye);
  float cw = drips.width;
  float cx = floor(w.x / cw);
  float h = hash12(vec2(cx + 0.5, salt * 17.0 + 3.0));
  if (h > drips.share * amount) return 0.0;
  float period = mix(4.5, 2.0, amount) * (0.75 + 0.5 * fract(h * 37.3));
  float ph = tm / period + fract(h * 91.0);
  float n = floor(ph);
  float age = (ph - n) * period;
  float hn = hash12(vec2(cx + 0.5, n + salt * 11.0));
  float tipY = (drips.tip.x + drips.tip.y * hn - drips.horizon) * z + drips.eye;
  float x = (cx + 0.2 + 0.6 * fract(hn * 17.3)) * cw;
  float aa = z / uRes.y;
  float hw = max(0.003, 1.2 * aa);
  float hang = 0.5 * period;
  vec2 a = vec2(x, tipY);
  vec2 b = a;
  float r = hw;
  if (age < hang) {
    // The bead swelling at the tip.
    r = hw * (0.7 + 0.6 * age / hang);
    a = vec2(x, tipY - r);
    b = a;
  } else {
    float fall = age - hang;
    float y = tipY - 4.9 * fall * fall;
    if (y < 0.0) return 0.0;
    a = vec2(x, y);
    b = vec2(x, y + clamp(0.3 * fall, 2.0 * hw, 0.25));
  }
  return 1.0 - smoothstep(r - 0.6 * aa, r + 0.6 * aa, segmentDistance(w, a, b));
}
`;
