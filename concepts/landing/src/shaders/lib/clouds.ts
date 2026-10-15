// Clouds in tiers, cheapest first: one cloud deck the scenes compose rather than each drawing its own.
// A scene selects the highest tier it draws (`features: { CLOUD_TIER: CLOUD_TIERS.volume }` in its
// SceneDef) and its program gets that tier and every one below it; a tier it did not select is not in
// its program, so calling one of its functions fails to compile, never silently. A scene that selects
// none gets the lit deck (CLOUD_LIT), as every sky had before the tiers. Compiled into every scene
// program after sky.ts; the contract and the tier each scene draws are in src/scenes/README.md
// ("Clouds").
//
//   flat     CLOUD_FLAT 0     the deck's plane and drift (cloudDeckPoint) and a calm deck of two broad
//                             octaves (cloudFlatField, cloudFlatFine) the scene thresholds and lights
//   lit      CLOUD_LIT 1      the deck lit by the sky, seen from below: skyClouds (rgb and cover)
//   shadows  CLOUD_SHADOWS 2  the lit deck's shadow on the scene's ground: skyCloudShadow
//   volume   CLOUD_VOLUME 3   a sea of cloud tops seen from above, ray-marched: cloudSeaMarch, its
//                             tops' relief and normal (cloudSeaTop), light reaching them through the
//                             cloud (cloudSeaShadow), the forward-scattering phase (cloudPhase)
//
// Projected size: the lit deck's octaves fade to their mean once a cell outgrows them (skyCloudField),
// the calm deck drops its finer octave toward the horizon (cloudFlatFine), and the sea's relief fades
// with the cell's footprint and is then not worked out at all (cloudSeaSurface): far or small cloud
// costs little, and resolved cloud is bit for bit the full-detail picture.

/** The cloud tiers, cheapest first; a tier includes every one below it (SceneDef.features CLOUD_TIER). */
export const CLOUD_TIERS = { flat: 0, lit: 1, shadows: 2, volume: 3 } as const;

const tierDefines = Object.entries(CLOUD_TIERS).map(([name, value]) => `#define CLOUD_${name.toUpperCase()} ${value}`).join("\n");

export const cloudDeckGlsl = `
// ---- clouds (shaders/lib/clouds.ts) ----
${tierDefines}
#ifndef CLOUD_TIER
#define CLOUD_TIER CLOUD_LIT
#endif

// Where a view ray from the eye meets the deck, a plane one cloud-base height up (the eye at the
// origin), in cloud-base heights, drifted to it on the deck's clock tm: sideways with the wind (0.09
// a second at wind 1) and creeping toward the eye (0.01 a second). travel: how far the eye has moved
// under the deck (a train running beneath it), in cloud-base heights. dir.y must be above 0.
vec2 cloudDeckPoint(vec3 dir, vec2 travel, float tm, float wind) {
  return dir.xz / dir.y + travel - vec2(0.09 * wind, -0.01) * tm;
}

// The calm deck: two broad octaves at deck point p, 0..1, the finer kept by fine (0..1; its mean
// where dropped). Soft and quiet where the lit deck's domain-warped detail would read as harsh
// swirls (a moonlit night); the scene picks its threshold, its edges and its light.
float cloudFlatField(vec2 p, float fine) {
  return 0.62 * vnoise(p * 0.55 + 4.3) + 0.38 * mix(0.5, vnoise(p * 1.3 + 9.1), fine);
}

// How much of the calm deck's finer octave a view along dir keeps, 0..1: it goes toward the horizon,
// where it would crawl as it drifts (a screen height taken as ~1 radian of view).
float cloudFlatFine(vec3 dir) {
  return 1.0 - smoothstep(0.08, 0.3, 1.3 / (uRes.y * dir.y * dir.y));
}

#if CLOUD_TIER >= CLOUD_LIT
// Cloud density on the lit deck: rotated fbm octaves over a slowly evolving domain warp (Quilez,
// "Domain warping", 2002). foot is the pixel footprint in deck units: octaves finer than ~3 pixels
// give way to their mean, so cloud near the horizon stays smooth instead of crawling as it drifts.
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

// The lit deck seen from below: the ray meets the deck (cloudDeckPoint) on the scene clock t times
// the motion. cover 0..1: 0 clear, ~.35 fair-weather cumulus, .6 broken, 1 overcast. wind -1..1
// drifts it sideways; it always evolves and creeps closer a little. Lit by the sun on the flanks that
// face it, silver-lined where the sun or moon is behind thin cloud, gold and then pink underneath
// around sunset, moonlit at night. Returns straight (not premultiplied) rgb and alpha, which fades
// out toward the horizon: col = mix(col, c.rgb, c.a).
vec4 skyClouds(Sky sky, vec3 dir, float t, float cover, float wind) {
  if (dir.y <= 0.015 || cover <= 0.0) return vec4(0.0);
  float tm = t * uMotion;
  vec2 p = cloudDeckPoint(dir, vec2(0.0), tm, wind);
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
#endif

#if CLOUD_TIER >= CLOUD_SHADOWS
// The lit deck's shadow on the scene's ground, 0..1: multiply the sun's light by 1 - darkness * it.
// It is the deck's cover where the sun's ray from ground (a point relative to the eye, y up, in the
// scene's units) meets the deck base units above the eye, as the sky shows the deck there, so a gap
// overhead toward the sun is a sunlit patch. The sun is taken at least ~7 degrees up: a low sun's
// shadows stay near instead of reaching for the horizon's thin deck.
float skyCloudShadow(Sky sky, vec3 ground, float base, float t, float cover, float wind) {
  vec3 deck = ground + sky.sun * ((base - ground.y) / max(sky.sun.y, 0.12));
  return skyClouds(sky, normalize(deck), t, cover, wind).a;
}
#endif

#if CLOUD_TIER >= CLOUD_VOLUME
// A sea of cloud tops below the eye, seen from above: its drift (deck units it has slid by), cover
// 0..1 (gaps down to the ground .. an unbroken floor), boil (the phase of the tops' slow change of
// shape), drop (how far below the eye the highest domes stand) and amp (the tops' height range, in
// the same units; domes are ~1.6 across).
struct CloudSea { vec2 drift; float cover; float boil; float drop; float amp; };

// Henyey-Greenstein phase relative to isotropic scattering: about 19 straight into the light for
// g = 0.7, a quarter side-on. Its forward lobe is what silvers cloud edges against a low sun
// (Schneider & Vos, "The real-time volumetric cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015).
float cloudPhase(float cosAngle, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosAngle, 1e-4), 1.5);
}

// Folded value noise |2n - 1|: rounded domes with sharp creases between them (Perlin's
// "turbulence", 1985), which is how cumulus tops read from above.
float cloudBillow(vec2 p) {
  return abs(2.0 * vnoise(p) - 1.0);
}

// The sea's large forms at deck point w, 0 on the floor of a gap .. 1 on the highest domes. A slow
// coverage noise opens gaps; a sine warp phased by it (cheap domain warping) breaks the value-noise
// lattice into drifting, swirling billows, and boil lets the tops change shape slowly.
float cloudSeaMacro(vec2 w, float cover, float boil) {
  float c = vnoise(w * 0.16 + vec2(11.3, 4.7));
  vec2 q = w + 0.75 * vec2(sin(w.y * 0.47 + c * 5.0 + boil), sin(w.x * 0.39 - c * 4.0 - boil * 0.7));
  float b = 0.62 * cloudBillow(q * 0.6) + 0.38 * cloudBillow(q * 1.37 + vec2(5.1, 2.3));
  float lo = 0.8 - 0.85 * cover;
  float deck = smoothstep(lo, lo + 0.2, c * 0.55 + b * 0.6);
  return deck * (0.3 + 0.7 * pow(b, 0.6));
}

// Cauliflower detail on the domes, for normals only; detail fades it out before it would alias.
// Fully faded (most of the far sea from high up) it adds exactly nothing, so its two noise octaves
// are not evaluated at all: the same picture for six fewer noise lookups per deck cell.
float cloudSeaSurface(vec2 w, float cover, float boil, float detail) {
  float h = cloudSeaMacro(w, cover, boil);
  float relief = 0.0;
  if (detail > 0.0) {
    float fine = 0.62 * cloudBillow(w * 3.3 + vec2(1.7, 8.2)) + 0.38 * cloudBillow(w * 7.4 - vec2(3.3, 0.6));
    relief = (fine - 0.4) * 0.16 * detail * smoothstep(0.1, 0.5, h);
  }
  return h + relief;
}

// The tops' height field against a ray rd from the eye at the origin; tops lie between y = -drop
// (highest domes) and -drop - amp (the floor of the gaps). Steps follow the vertical gap to the
// surface as in terrain marching (Quilez, "Terrain raymarching", 2002), capped so a step never jumps
// a whole dome and growing with distance where domes shrink below a cell; three secant steps then
// settle the hit. Returns the distance, or -1 when the ray passes tFar first. A ray that runs out of
// steps is skimming just over the tops, so where it stopped is taken as the hit.
float cloudSeaMarch(vec3 rd, CloudSea sea, float tFar) {
  float t = sea.drop / -rd.y;
  float tEnd = min((sea.drop + sea.amp) / -rd.y, tFar);
  if (t >= tEnd) return -1.0;
  float ta = t;
  float ga = sea.amp;
  for (int i = 0; i < 32; i++) {
    vec3 at = rd * t;
    float g = at.y + sea.drop + sea.amp * (1.0 - cloudSeaMacro(at.xz + sea.drift, sea.cover, sea.boil));
    if (g <= 0.0) {
      float tb = t;
      float gb = g;
      for (int k = 0; k < 3; k++) {
        float ts = ta + (tb - ta) * ga / max(ga - gb, 1e-5);
        vec3 mid = rd * ts;
        float gm = mid.y + sea.drop + sea.amp * (1.0 - cloudSeaMacro(mid.xz + sea.drift, sea.cover, sea.boil));
        if (gm > 0.0) {
          ta = ts;
          ga = gm;
        } else {
          tb = ts;
          gb = gm;
        }
      }
      return ta + (tb - ta) * ga / max(ga - gb, 1e-5);
    }
    if (t >= tEnd) break;
    ta = t;
    ga = g;
    t = min(t + clamp(0.55 * g / -rd.y, 0.01 + 0.004 * t, 0.12 + 0.05 * t), tEnd);
  }
  return t < tEnd ? t : -1.0;
}

// The tops where rd hit them at at (rd * cloudSeaMarch's distance): xyz the surface's normal, w its
// height 0..1 with the relief. foot: one cell's footprint there across the ray, in deck units (the
// distance times the cell's angle); the grazing view stretches it along the ray, so the relief fades
// as that outgrows a cell, and the normal's spacing follows it.
vec4 cloudSeaTop(vec3 at, vec3 rd, CloudSea sea, float foot) {
  vec2 w = at.xz + sea.drift;
  float detail = 1.0 - smoothstep(0.04, 0.12, foot / max(-rd.y, 0.05));
  float e = max(0.012, foot * 1.5);
  float h0 = cloudSeaSurface(w, sea.cover, sea.boil, detail);
  float hx = cloudSeaSurface(w + vec2(e, 0.0), sea.cover, sea.boil, detail);
  float hz = cloudSeaSurface(w + vec2(0.0, e), sea.cover, sea.boil, detail);
  return vec4(normalize(vec3(-(hx - h0) * sea.amp / e, 1.0, -(hz - h0) * sea.amp / e)), h0);
}

// Light reaching a point at on the tops from L (unit, toward the light): two taps toward it through
// the coarse field, the depth of cloud the ray passes under dimming it as Beer-Lambert extinction
// would. A low sun reaches further, so long shadows stretch from the domes across the valleys
// between them at golden hour. 1 in the open .. toward 0 deep in a dome's shadow.
float cloudSeaShadow(vec3 at, vec3 L, CloudSea sea) {
  float reach = clamp(0.14 / max(L.y, 0.04), 0.3, 1.8);
  vec3 a = at + L * (reach * 0.3);
  vec3 b = at + L * reach;
  float ya = -sea.drop - sea.amp * (1.0 - cloudSeaMacro(a.xz + sea.drift, sea.cover, sea.boil));
  float yb = -sea.drop - sea.amp * (1.0 - cloudSeaMacro(b.xz + sea.drift, sea.cover, sea.boil));
  float depth = max(ya - a.y, 0.0) * 1.3 + max(yb - b.y, 0.0) * 0.8;
  return exp(-depth * 9.0);
}
#endif
`;
