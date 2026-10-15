// Shared weather under a closed canopy (bamboo, forest): the rain's cloud closing over the sky and the
// light it leaves, where the key light (sun or moon) comes from and how its shafts slant, where the
// shafts leave the canopy, where the canopy is open overhead, and the sky seen through those gaps.
// Compiled into every scene program after the sky and weather libraries; the contract and conventions
// are in src/scenes/README.md.
//
// The scene keeps its own look: the leaves' tint on the light and the sky, the fill and the shelter
// (how much rain gets through under the leaves), its rays, mist and canopy, and what stands in front.

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
