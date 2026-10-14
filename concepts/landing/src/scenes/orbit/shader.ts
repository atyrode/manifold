// The orbit scene: the shared giant planet (shaders/lib/planet.ts) as the subject, with every
// feature (surface, clouds, storms, aurora, city lights, day cycle, ring system, moons), drawn in ink
// and accent coverage; plus constellations, shooting stars, captured meteors and the M city lights.

/** Seconds of the orbit's entrance and exit (SceneDef.passage). */
export const ORBIT_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

export const orbitGlsl = `
// Real constellations, plus the optional Manifold asterism, drifting with the sky.
vec2 orbitConstellations(vec2 sky, float aspect, float px, bool figures, bool lines, bool mark, float tm) {
  float star = 0.0;
  float line = 0.0;
  for (int i = 0; i < MAX_CON_STARS; i++) {
    if (i >= uConStarCount) break;
    if (!(i < uConMarkStar ? figures : mark)) continue;
    vec4 s = uConStars[i];
    vec2 q = (sky - (vec2(s.x * aspect * 0.5, s.y) + s.zw)) / px;
    float b = uConBright[i];
    float core = smoothfall(1.3 + b, 0.4 + b, length(q));
    float glint = step(min(abs(q.x), abs(q.y)), 0.5) * smoothfall(2.0 + 4.0 * b, 0.0, max(abs(q.x), abs(q.y))) * b;
    star = max(star, max(core, glint * 0.8) * (0.85 + 0.15 * sin(tm * 0.9 + float(i) * 2.3)));
  }
  for (int i = 0; i < MAX_CON_LINES; i++) {
    if (i >= uConLineCount) break;
    if (!(i < uConMarkLine ? figures && lines : mark)) continue;
    vec4 sa = uConStars[int(uConLines[i].x)];
    vec4 sb = uConStars[int(uConLines[i].y)];
    vec2 a = vec2(sa.x * aspect * 0.5, sa.y) + sa.zw;
    vec2 b = vec2(sb.x * aspect * 0.5, sb.y) + sb.zw;
    vec2 ba = b - a;
    float h = clamp(dot(sky - a, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(sky - a - ba * h) / px;
    float fromEnds = min(h, 1.0 - h) * length(ba) / px;
    float dash = step(0.45, fract(h * length(ba) / px / 3.0));
    line = max(line, step(d, 0.5) * dash * step(3.0, fromEnds));
  }
  return vec2(star, line);
}

// One shooting star 'tau' seconds into its flight.
float orbitMeteorStreak(vec2 p, float tau, vec2 seed, float px) {
  float duration = 0.6 + 0.5 * hash12(seed + 2.0);
  if (tau < 0.0 || tau > duration) return 0.0;
  vec2 start = vec2((hash12(seed + 4.0) - 0.3) * 1.6, 0.2 + 0.3 * hash12(seed + 6.0));
  float angle = 3.65 + 0.5 * hash12(seed + 8.0);
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 head = start + dir * tau * 0.9;
  vec2 tail = head - dir * 0.16;
  vec2 pa = p - tail;
  float along = clamp(dot(pa, dir) / 0.16, 0.0, 1.0);
  float d = length(pa - dir * along * 0.16) / px;
  float fade = 1.0 - smoothstep(0.6 * duration, duration, tau);
  return step(d, 0.6 + 0.6 * along) * along * along * fade;
}

// Shooting stars: each time slot may throw one streak; trigger slot 0 throws one now.
float orbitMeteors(vec2 p, float rate, float px, float tm) {
  float acc = orbitMeteorStreak(p, sinceTrigger(0), vec2(uTriggers[0], 91.0), px);
  if (rate <= 0.0) return acc;
  for (int layer = 0; layer < 2; layer++) {
    float slotLength = mix(10.0, 1.6, rate) * (1.0 + 0.37 * float(layer));
    float k = tm / slotLength + float(layer) * 0.5;
    vec2 seed = vec2(floor(k), float(layer) * 17.0);
    if (hash12(seed) > 0.35 + 0.65 * rate) continue;
    acc = max(acc, orbitMeteorStreak(p, fract(k) * slotLength, seed, px));
  }
  return acc;
}

// Captured meteor 'tau' seconds after it appears: spirals inward around the planet and burns up in
// the atmosphere. q: the pixel in planet radii, foot a cell there (the shared planet's frame);
// ringZ, ringOpacity: the ring at this pixel (its depth toward the viewer and how much it hides, see
// orbitRingOver); the meteor dims behind ring material nearer the eye. Returns (ink, accent).
vec2 orbitCapturedEvent(vec2 q, float tau, float id, float foot, float ringZ, float ringOpacity) {
  vec2 acc = vec2(0.0);
  float duration = 8.0;
  if (tau < 0.0 || tau > duration + 1.4) return acc;
  float tilt = 0.3 + 0.55 * hash12(vec2(id, 5.1));
  float roll = (hash12(vec2(id, 9.7)) - 0.5) * 0.9;
  float start = hash12(vec2(id, 3.3)) * TAU;
  float turn = hash12(vec2(id, 1.9)) > 0.5 ? 1.0 : -1.0;
  for (int i = 0; i < 16; i++) {
    float back = float(i) * 0.05;
    if (tau - back < 0.0) break;
    float tt = clamp((tau - back) / duration, 0.0, 1.0);
    vec3 pos = planetOrbit(start + turn * TAU * 1.4 * pow(tt, 0.8), mix(3.4, 1.02, pow(tt, 1.25)), tilt, roll);
    if (planetBehind(pos) || tau - back > duration) continue;
    float d = length(q - pos.xy) / foot;
    float seen = ringZ > pos.z ? 1.0 - ringOpacity : 1.0;
    acc.x = max(acc.x, step(d, i == 0 ? 1.4 : 0.75) * (1.0 - float(i) / 16.0) * seen);
  }
  if (tau > duration) {
    vec3 end = planetOrbit(start + turn * TAU * 1.4, 1.02, tilt, roll);
    float f = (tau - duration) / 1.4;
    float d = length(q - end.xy) / foot;
    float flash = (1.0 - f) * smoothfall(3.0 + 30.0 * f, 0.0, d);
    float seen = ringZ > end.z ? 1.0 - ringOpacity : 1.0;
    if (!planetBehind(end)) acc.y = max(acc.y, flash * seen);
  }
  return acc;
}

// Scheduled captures at the chosen frequency; trigger slot 1 starts one now.
vec2 orbitCaptured(vec2 q, float tm, float freq, float foot, float ringZ, float ringOpacity) {
  vec2 acc = orbitCapturedEvent(q, sinceTrigger(1), 1000.0 + uTriggers[1], foot, ringZ, ringOpacity);
  if (freq <= 0.0) return acc;
  float slot = mix(40.0, 10.0, freq);
  float k = tm / slot;
  return max(acc, orbitCapturedEvent(q, fract(k) * slot, floor(k), foot, ringZ, ringOpacity));
}

// The auroral oval's pole, tipped toward the viewer so the oval drifts over the polar night side.
const vec3 ORBIT_AURORA_POLE = normalize(vec3(0.12, 0.86, 0.5));

// The ring system from the knobs: its plane, and its bands (the shared planetRingBands).
PlanetRing orbitRingPlane() {
  return PlanetRing(mix(0.06, 0.97, K_ringTilt), K_ringRoll * 0.7);
}

PlanetRingBands orbitRingBands() {
  float inner = 1.1 + 0.9 * K_ringInner;
  return PlanetRingBands(inner, inner + 0.15 + 1.6 * K_ringWidth, K_ringCount, K_ringSpacing, K_ringDensity, K_ringTexture, K_ringSpin);
}

// Whether a band (planetRingBands' band) is drawn in ink (1) or the accent (0).
float orbitRingTone(float band) {
  int tone = int(K_ringTone + 0.5);
  return tone == 1 ? 1.0 : tone == 2 ? mod(band, 2.0) : 0.0;
}

// The ring over whatever this pixel shows behind it: its cover hides that (planetRingOpacity), then
// it shines in ink or the accent. Drawn over the sky and planet, and again over a moon it passes in
// front of.
void orbitRingOver(inout Shade o, float ring, float ringInk) {
  if (ring <= 0.0) return;
  float opacity = planetRingOpacity(ring);
  o.ink *= 1.0 - opacity;
  o.accent *= 1.0 - opacity;
  if (ringInk > 0.5) o.ink = max(o.ink, ring * 0.8);
  else o.accent = max(o.accent, ring * 0.75);
}

// Share of a body's way still to go as the camera swings it in and settles: 1 at the start, easing
// out through a slight overshoot (about 2%) to exactly 0 once s reaches 0.85 of the entrance.
float orbitSettle(float s) {
  float w = smoothstep(0.0, 0.85, s);
  float u = 1.0 - w;
  return u * u * (1.0 - 1.9 * w);
}

// How far the camera pulls back as the planet leaves (planet-space scale at the end: 1 + this).
const float ORBIT_PULL = 0.35;

Shade sceneOrbit(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * 0.012 * m;

  float r = 1.12 * K_planet;
  vec2 c = vec2(K_planetX * aspect * 0.5, K_planetY);

  // Passage: the camera swings round so the planet slides in from the right and settles, the moons
  // catch up along their orbits; leaving, the camera pulls back as the planet slides off to the
  // left. cam shifts the planet, zoom pulls the camera back, spin turns the surface along with
  // the swing. All of it is exactly 0 / 1 at rest.
  vec2 cam = vec2(0.0);
  float zoom = 1.0;
  float spin = 0.0;
  float moonIn = 0.0;
  float moonOut = 0.0;
  if (passageIn() < 1.0 || passageOut() > 0.0) {
    float settle = orbitSettle(passageIn());
    float leave = smoothstep(0.0, 1.0, passageOut());
    vec2 fromSide = vec2(aspect * 0.5 + r + 0.15 - c.x, -0.12);
    vec2 toSide = vec2(c.x + (1.0 + ORBIT_PULL) * aspect * 0.5 + r + 0.15, 0.0);
    cam = fromSide * settle - toSide * leave;
    zoom = 1.0 + ORBIT_PULL * leave;
    spin = 0.4 * leave - 0.5 * settle;
    moonIn = orbitSettle(clamp((passageIn() - 0.12) / 0.88, 0.0, 1.0));
    moonOut = leave;
    c += cam;
  }

  Shade o = blankShade();
  // The stars are far off: they follow the swing only a little.
  vec2 sky = p - cam * 0.15 + vec2(tm * 0.006 * K_drift, 0.0);
  o.ink = starfield(floor(sky * uRes.y), 0.001 + 0.009 * K_stars, K_twinkle, K_scatter);
  o.ink += 0.16 * K_nebula * smoothstep(0.5, 0.95, fbm(p * 1.8 + vec2(tm * 0.012 * K_drift, 3.0)));
  o.accent = 0.08 * K_nebula * smoothstep(0.55, 0.95, fbm(p * 2.4 + vec2(9.0, -tm * 0.008 * K_drift)));
  if (K_constellations > 0.5 || K_mark > 0.5) {
    vec2 figures = orbitConstellations(sky, aspect, px, K_constellations > 0.5, K_lines > 0.5, K_mark > 0.5, tm);
    o.ink = max(o.ink, figures.x);
    o.accent = max(o.accent, figures.y * 0.6);
  }
  o.ink = max(o.ink, orbitMeteors(p, K_meteors, px, tm));

  // The shared planet (shaders/lib/planet.ts) with every feature, in planet radii; foot is a cell.
  PlanetPoint s = planetAt(p * zoom, c, r);
  vec2 q = s.q;
  float d = s.d;
  float foot = px * zoom / r;
  // The sun can circle the planet (day cycle), sweeping the terminator across it.
  vec3 L = planetSun(normalize(vec3(-0.55, 0.75, 0.38)), tm * K_daycycle * 0.25);
  float sunSide = smoothstep(-0.3, 0.7, planetSunward(q, L));

  // Ring sample along this pixel's line of sight, with the planet's shadow across it.
  float ring = 0.0;
  float ringInk = 0.0;
  float ringZ = 0.0;
  PlanetRing ringPlane = orbitRingPlane();
  PlanetRingBands ringBands = orbitRingBands();
  if (K_ring > 0.5) {
    vec3 at = planetRingAt(ringPlane, q);
    float band;
    ring = planetRingBands(at.xy, ringBands, tm, foot / max(ringPlane.facing, 0.02), band);
    ringInk = orbitRingTone(band);
    if (planetShadowed(vec3(q, at.z), L)) ring *= 0.15;
    ringZ = at.z;
  }

  if (d < 1.0) {
    vec3 normal = s.normal;
    float diff = max(dot(normal, L), 0.0);
    float lon = planetLongitude(normal, tm * 0.012, spin);
    float bands = planetBelts(normal, lon, foot);
    float rim = planetRim(normal);
    float limbSun = smoothstep(-0.2, 0.6, planetSunward(q, L));
    float night = planetNight(diff);
    float lights = K_lights > 0.5 ? planetCityLights(normal, lon, t, K_lightsTwinkle, foot) * night : 0.0;
    o.ink = diff * diff * (0.2 + 0.6 * bands) * 0.85;
    o.accent = rim * limbSun * 1.4 + lights * 0.85;
    if (K_aurora > 0.0) o.accent = max(o.accent, planetAurora(normal, ORBIT_AURORA_POLE, K_auroraSize, tm, foot) * mix(0.6, 1.0, night) * K_aurora * 2.0);
    // Cloud decks drift faster than the surface and catch the light.
    float cloud = planetClouds(normal, lon, tm, foot);
    o.ink = max(o.ink, cloud * K_clouds * (0.15 + 0.8 * diff));
    // Storms: brief flashes inside the night-side clouds, each cell on its own clock.
    float burst = sinceTrigger(2) >= 0.0 ? 0.9 * (1.0 - smoothstep(1.5, 3.0, sinceTrigger(2))) : 0.0;
    float stormLevel = max(K_storms * step(0.001, m), burst);
    float storm = planetStorms(normal, lon, t, stormLevel, cloud, diff, foot);
    o.ink = max(o.ink, storm);
    o.shimmer = storm * 0.3;
    if (K_mlights > 0.5) {
      // City lights on the night side, laid out as the M.
      vec2 at = (normal.xy + normalize(L.xy + 1e-4) * 0.45) / 0.3;
      vec2 town = floor(normal.xy * 180.0);
      float lit = step(0.6, hash12(town)) * (0.8 + 0.2 * hash12(town + 3.0));
      o.accent = max(o.accent, step(markDistance(at), 0.06) * lit * smoothfall(0.25, 0.0, diff));
    }
    // The rings' shadow bands across the surface.
    vec2 shadowAt;
    if (K_ring > 0.5 && planetRingShadowAt(ringPlane, normal, L, shadowAt)) {
      float band;
      float shadow = planetRingBands(shadowAt, ringBands, tm, foot, band);
      o.ink *= 1.0 - 0.75 * min(shadow * 1.3, 1.0);
    }
    // Rings in front of the planet's surface cover it; rings behind it are hidden.
    if (ring > 0.0 && ringZ < normal.z) ring = 0.0;
  } else {
    // Atmosphere glow. Ring material in front of the planet hides it; glow veils rings behind.
    float halo = planetHalo(d, r, 26.0) * sunSide;
    float cover = planetRingOpacity(ring);
    if (ringZ > 0.0) halo *= 1.0 - cover;
    else ring *= 1.0 - 0.8 * min(halo, 1.0);
    // Where the oval meets the horizon its curtains rise into space.
    if (K_aurora > 0.0) halo += planetAuroraCurtain(q, d, ORBIT_AURORA_POLE, K_auroraSize, tm, foot) * K_aurora * 1.2;
    o.accent += halo * 0.9;
    o.ink *= 1.0 - min(halo, 1.0);
  }
  orbitRingOver(o, ring, ringInk);

  // Moons on inclined orbits (planetMoon's family about a nearly face-on frame): they cross the sky
  // round the planet, pass in front of and behind the rings, and can cast their shadow onto it.
  for (int i = 0; i < 3; i++) {
    if (float(i) >= K_moons) break;
    float fi = float(i);
    PlanetMoon mo = planetMoon(i, PlanetRing(0.9, -0.15));
    vec3 moon = planetMoonAt(mo, tm, -moonIn * (1.7 + 0.5 * fi) + moonOut * (0.8 + 0.3 * fi), 1.0 + 0.35 * moonIn + 0.25 * moonOut);
    if (K_eclipses > 0.5 && d < 1.0) {
      float shade = planetMoonShadow(q, moon, mo.size, L);
      o.ink *= 1.0 - 0.9 * shade;
      o.accent *= 1.0 - 0.6 * shade;
    }
    vec3 disc = planetMoonDisc(q, moon, mo.size, L, fi, foot);
    if (disc.x > 0.5) {
      o.ink = 0.08 + 0.85 * disc.y;
      o.accent = 0.0;
      // Ring material nearer the eye than this point of the moon passes in front of it.
      if (ringZ > disc.z) orbitRingOver(o, ring, ringInk);
    }
  }

  vec2 meteor = orbitCaptured(q, tm, K_captures, foot, ringZ, planetRingOpacity(ring));
  o.ink = max(o.ink, meteor.x);
  o.accent = max(o.accent, meteor.y);

  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  o.source = o.rgb;
  return o;
}
`;
