// The orbit scene: planet, rings, moons, aurora, constellations, city lights.

export const orbitGlsl = `
// Real constellations, plus the optional Manifold asterism, drifting with the sky.
vec2 constellations(vec2 sky, float aspect, float px, bool figures, bool lines, bool mark, float tm) {
  float star = 0.0;
  float line = 0.0;
  for (int i = 0; i < MAX_CON_STARS; i++) {
    if (i >= uConStarCount) break;
    if (!(i < uConMarkStar ? figures : mark)) continue;
    vec4 s = uConStars[i];
    vec2 q = (sky - (vec2(s.x * aspect * 0.5, s.y) + s.zw)) / px;
    float b = uConBright[i];
    float core = smoothstep(1.3 + b, 0.4 + b, length(q));
    float glint = step(min(abs(q.x), abs(q.y)), 0.5) * smoothstep(2.0 + 4.0 * b, 0.0, max(abs(q.x), abs(q.y))) * b;
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
float meteorStreak(vec2 p, float tau, vec2 seed, float px) {
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
float meteors(vec2 p, float rate, float px, float t) {
  float acc = meteorStreak(p, sinceTrigger(0), vec2(uTriggers[0], 91.0), px);
  if (rate <= 0.0) return acc;
  for (int layer = 0; layer < 2; layer++) {
    float slotLength = mix(10.0, 1.6, rate) * (1.0 + 0.37 * float(layer));
    float k = t / slotLength + float(layer) * 0.5;
    vec2 seed = vec2(floor(k), float(layer) * 17.0);
    if (hash12(seed) > 0.35 + 0.65 * rate) continue;
    acc = max(acc, meteorStreak(p, fract(k) * slotLength, seed, px));
  }
  return acc;
}

// A body on an inclined orbit about the planet's centre: x, y on screen (relative to the centre),
// z toward the viewer. 'tilt' is cos of the inclination; 'roll' turns the orbit on screen.
vec3 inclined(float angle, float radius, float tilt, float roll) {
  vec3 p = vec3(cos(angle) * radius, sin(angle) * radius * tilt, -sin(angle) * radius * sqrt(1.0 - tilt * tilt));
  p.xy = rotate(p.xy, roll);
  return p;
}

bool behindPlanet(vec3 p, float r) {
  float l2 = dot(p.xy, p.xy);
  return l2 < r * r && p.z < sqrt(r * r - l2);
}

// Captured meteor 'tau' seconds after it appears: spirals inward around the planet and burns up
// in the atmosphere. Returns (ink, accent).
vec2 capturedEvent(vec2 dp, float r, float tau, float id, float px) {
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
    vec3 pos = inclined(start + turn * TAU * 1.4 * pow(tt, 0.8), mix(3.4, 1.02, pow(tt, 1.25)) * r, tilt, roll);
    if (behindPlanet(pos, r) || tau - back > duration) continue;
    float d = length(dp - pos.xy) / px;
    acc.x = max(acc.x, step(d, i == 0 ? 1.4 : 0.75) * (1.0 - float(i) / 16.0));
  }
  if (tau > duration) {
    vec3 end = inclined(start + turn * TAU * 1.4, 1.02 * r, tilt, roll);
    float f = (tau - duration) / 1.4;
    float d = length(dp - end.xy) / px;
    float flash = (1.0 - f) * smoothstep(3.0 + 30.0 * f, 0.0, d);
    if (!behindPlanet(end, r)) acc.y = max(acc.y, flash);
  }
  return acc;
}

// Scheduled captures at the chosen frequency; trigger slot 1 starts one now.
vec2 captured(vec2 dp, float r, float t, float freq, float px) {
  vec2 acc = capturedEvent(dp, r, sinceTrigger(1), 1000.0 + uTriggers[1], px);
  if (freq <= 0.0) return acc;
  float slot = mix(40.0, 10.0, freq);
  float k = t / slot;
  return max(acc, capturedEvent(dp, r, fract(k) * slot, floor(k), px));
}

// Auroral oval around a pole tipped toward the viewer: a band at a set distance from the pole,
// broken into drifting folds and patches. 'n' is a unit direction from the planet's centre.
float auroraOval(vec3 n, float size, float tm) {
  vec3 pole = normalize(vec3(0.12, 0.86, 0.5));
  float colat = acos(clamp(dot(n, pole), -1.0, 1.0));
  vec3 e1 = normalize(cross(pole, vec3(0.0, 0.0, 1.0)));
  vec3 e2 = cross(pole, e1);
  float az = atan(dot(n, e2), dot(n, e1));
  vec2 ring = vec2(cos(az), sin(az));
  float wobble = (fbm(ring * 2.2 + vec2(tm * 0.06, -tm * 0.04)) - 0.5) * 0.22;
  float band = exp(-pow((colat - mix(0.25, 0.75, size) - wobble) / 0.09, 2.0));
  float folds = 0.55 + 0.45 * sin(az * 38.0 + fbm(ring * 3.0 + tm * 0.08) * 7.0 + tm * 0.4);
  float mass = smoothstep(0.25, 0.7, fbm(ring * 4.0 + vec2(colat * 6.0, tm * 0.12)));
  return band * folds * mass;
}

// Ring plane geometry shared by the ring itself and the shadows it casts.
vec3 ringNormal() {
  float facing = mix(0.06, 0.97, uParams[24]);
  vec3 n = vec3(0.0, sqrt(1.0 - facing * facing), facing);
  n.xy = rotate(n.xy, uParams[25] * 0.7);
  return n;
}

// Ring cover at an in-plane point (planet radii), and whether that band is drawn in ink.
float ringCover(vec3 point, vec3 n, float t, out float inkTone) {
  inkTone = 0.0;
  float rho = length(point);
  float inner = 1.1 + 0.9 * uParams[22];
  float outer = inner + 0.15 + 1.6 * uParams[23];
  float u = (rho - inner) / (outer - inner);
  if (u < 0.0 || u > 1.0) return 0.0;
  float count = max(uParams[20], 1.0);
  float band = floor(u * count);
  float v = fract(u * count);
  float gap = uParams[21] * 0.5;
  float soft = 0.015 * count;
  float inBand = count < 1.5 ? 1.0 : smoothstep(gap, gap + soft, v) * smoothstep(1.0 - gap, 1.0 - gap - soft, v);
  vec3 e1 = normalize(vec3(n.y, -n.x, 0.0));
  vec3 e2 = cross(n, e1);
  // Inner bands orbit faster (Kepler); the texture rides along with them.
  float spin = uParams[29] * t * 0.6 / pow(rho, 1.5);
  vec2 plane = rotate(vec2(dot(point, e1), dot(point, e2)), -spin);
  int kind = int(uParams[28] + 0.5);
  float density = uParams[26];
  float texture;
  if (kind == 0) {
    texture = (0.65 + 0.35 * vnoise(plane * 7.0)) * density;
  } else if (kind == 1) {
    texture = (0.62 + 0.22 * sin(rho * 190.0) + 0.16 * (vnoise(vec2(rho * 120.0, 1.0)) - 0.5) + 0.12 * (vnoise(plane * 18.0) - 0.5)) * density;
  } else {
    vec2 grid = plane * 45.0;
    vec2 id = floor(grid);
    vec2 f = fract(grid) - 0.5 - (vec2(hash12(id), hash12(id + 7.0)) - 0.5) * 0.5;
    float size = 0.12 + 0.28 * hash12(id + 3.0);
    texture = step(length(f), size) * step(1.0 - density * 0.9, hash12(id + 11.0)) * 1.2;
  }
  int tone = int(uParams[27] + 0.5);
  inkTone = tone == 1 ? 1.0 : tone == 2 ? mod(band, 2.0) : 0.0;
  return inBand * texture * (0.6 + 0.4 * hash12(vec2(band, 5.0)));
}

// Orbit knobs: 0 stars, 1 twinkle, 2 scatter, 3 constellations, 4 lines, 5 mark, 6 meteors,
// 7 captures, 8 nebula, 9 drift, 10 planetX, 11 planetY, 12 planet, 13 clouds, 14 storms,
// 15 aurora, 16 daycycle, 17 moons, 18 eclipses, 19 ring, 20 ringCount, 21 ringSpacing,
// 22 ringInner, 23 ringWidth, 24 ringTilt, 25 ringRoll, 26 ringDensity, 27 ringTone,
// 28 ringTexture, 29 ringSpin.
Shade sceneOrbit(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * 0.012 * m;

  Shade o = blankShade();
  vec2 sky = p + vec2(tm * 0.006 * uParams[9], 0.0);
  o.ink = starfield(floor(sky * uRes.y), 0.001 + 0.009 * uParams[0], uParams[1], uParams[2]);
  o.ink += 0.16 * uParams[8] * smoothstep(0.5, 0.95, fbm(p * 1.8 + vec2(tm * 0.012 * uParams[9], 3.0)));
  o.accent = 0.08 * uParams[8] * smoothstep(0.55, 0.95, fbm(p * 2.4 + vec2(9.0, -tm * 0.008 * uParams[9])));
  if (uParams[3] > 0.5 || uParams[5] > 0.5) {
    vec2 figures = constellations(sky, aspect, px, uParams[3] > 0.5, uParams[4] > 0.5, uParams[5] > 0.5, tm);
    o.ink = max(o.ink, figures.x);
    o.accent = max(o.accent, figures.y * 0.6);
  }
  o.ink = max(o.ink, meteors(p, uParams[6], px, tm));

  float r = 1.12 * uParams[12];
  vec2 c = vec2(uParams[10] * aspect * 0.5, uParams[11]);
  vec2 dp = p - c;
  vec2 q = dp / r;
  float d = length(q);
  // The sun can circle the planet (day cycle), sweeping the terminator across it.
  vec3 L = normalize(vec3(-0.55, 0.75, 0.38));
  float sweep = tm * uParams[16] * 0.25;
  L = vec3(L.x * cos(sweep) + L.z * sin(sweep), L.y, -L.x * sin(sweep) + L.z * cos(sweep));
  float sunSide = smoothstep(-0.3, 0.7, dot(normalize(q), normalize(L.xy + 1e-4)));

  // Ring sample along this pixel's line of sight, with the planet's shadow across it.
  float ring = 0.0;
  float ringInk = 0.0;
  float ringZ = 0.0;
  vec3 n = ringNormal();
  if (uParams[19] > 0.5) {
    float z = -(n.x * dp.x + n.y * dp.y) / max(n.z, 0.02);
    vec3 point = vec3(dp, z) / r;
    ring = ringCover(point, n, tm, ringInk);
    if (dot(point, L) < 0.0 && length(point - dot(point, L) * L) < 1.0) ring *= 0.15;
    ringZ = z;
  }

  if (d < 1.0) {
    vec3 normal = vec3(q, sqrt(1.0 - d * d));
    float diff = max(dot(normal, L), 0.0);
    float lon = atan(normal.x, normal.z) + tm * 0.012;
    float bands = fbm(vec2(lon * 3.0, normal.y * 11.0));
    float rim = pow(1.0 - normal.z, 3.0);
    float limbSun = smoothstep(-0.2, 0.6, dot(normalize(q), normalize(L.xy + 1e-4)));
    float night = smoothstep(0.15, 0.0, diff);
    vec2 city = floor(vec2(lon * 90.0, normal.y * 140.0));
    float lights = step(0.992, hash12(city)) * night * step(0.5, uParams[32]);
    lights *= 1.0 - uParams[33] * m * (0.5 + 0.5 * sin(t * (1.0 + 3.0 * hash12(city + 7.0)) + hash12(city) * 40.0));
    o.ink = diff * diff * (0.2 + 0.6 * bands) * 0.85;
    o.accent = rim * limbSun * 1.4 + lights * 0.85;
    if (uParams[15] > 0.0) o.accent = max(o.accent, auroraOval(normal, uParams[31], tm) * mix(0.6, 1.0, night) * uParams[15] * 2.0);
    // Cloud decks drift faster than the surface and catch the light.
    float cloud = smoothstep(0.52, 0.72, fbm(vec2(lon * 4.0 + tm * 0.02, normal.y * 9.0) + vec2(5.0, 1.0)));
    o.ink = max(o.ink, cloud * uParams[13] * (0.15 + 0.8 * diff));
    // Storms: brief flashes inside the night-side clouds, each cell on its own clock.
    vec2 stormCell = floor(vec2(lon * 40.0, normal.y * 60.0));
    float burst = sinceTrigger(2) >= 0.0 ? 0.9 * (1.0 - smoothstep(1.5, 3.0, sinceTrigger(2))) : 0.0;
    float stormLevel = max(uParams[14] * step(0.001, m), burst);
    float strike = step(1.0 - 0.06 * stormLevel, hash12(stormCell + floor(t * 6.0 + hash12(stormCell) * 6.0)));
    float storm = strike * step(0.001, stormLevel) * (0.4 + 0.6 * cloud) * smoothstep(0.35, 0.0, diff);
    o.ink = max(o.ink, storm);
    o.shimmer = storm * 0.3;
    if (uParams[30] > 0.5) {
      // City lights on the night side, laid out as the M.
      vec2 at = (normal.xy + normalize(L.xy + 1e-4) * 0.45) / 0.3;
      vec2 town = floor(normal.xy * 180.0);
      float lit = step(0.6, hash12(town)) * (0.8 + 0.2 * hash12(town + 3.0));
      o.accent = max(o.accent, step(markDistance(at), 0.06) * lit * smoothstep(0.25, 0.0, diff));
    }
    // The rings' shadow bands across the surface.
    if (uParams[19] > 0.5) {
      float toward = dot(n, L);
      float s = -dot(n, normal) / (abs(toward) < 1e-3 ? 1e-3 : toward);
      float tone;
      if (s > 0.0) {
        float shadow = ringCover(normal + L * s, n, tm, tone);
        o.ink *= 1.0 - 0.75 * min(shadow * 1.3, 1.0);
      }
    }
    // Rings in front of the planet's surface cover it; rings behind it are hidden.
    float surfaceZ = sqrt(1.0 - d * d) * r;
    if (ring > 0.0 && ringZ < surfaceZ) ring = 0.0;
  } else {
    // Atmosphere glow. Ring material in front of the planet hides it; glow veils rings behind.
    float halo = exp(-(d - 1.0) * r * 26.0) * sunSide;
    float cover = min(ring * 1.4, 1.0);
    if (ringZ > 0.0) halo *= 1.0 - cover;
    else ring *= 1.0 - 0.8 * min(halo, 1.0);
    if (uParams[15] > 0.0) {
      // Where the oval meets the horizon its curtains rise into space.
      float height = d - 1.0;
      float curtain = auroraOval(vec3(q / d, 0.0), uParams[31], tm) * exp(-height / 0.06) * smoothstep(0.0, 0.008, height);
      halo += curtain * uParams[15] * 1.2;
    }
    o.accent += halo * 0.9;
    o.ink *= 1.0 - min(halo, 1.0);
  }
  if (ring > 0.0) {
    float opacity = min(ring * 1.4, 1.0);
    o.ink *= 1.0 - opacity;
    o.accent *= 1.0 - opacity;
    if (ringInk > 0.5) o.ink = max(o.ink, ring * 0.8);
    else o.accent = max(o.accent, ring * 0.75);
  }

  // Moons on inclined orbits: they rise from behind the planet, cross the sky and set again,
  // and can cast their shadow onto it.
  for (int i = 0; i < 3; i++) {
    if (float(i) >= uParams[17]) break;
    float fi = float(i);
    float size = (0.016 + 0.01 * fi) * uParams[12];
    vec3 moon = inclined(tm * (0.06 - 0.014 * fi) + 1.2 + fi * 0.9, r * (1.2 + 0.18 * fi), 0.9 - 0.1 * fi, -0.15 + 0.15 * fi);
    if (uParams[18] > 0.5 && d < 1.0) {
      float toward = dot(moon, L);
      float disc = toward * toward - dot(moon, moon) + r * r;
      if (toward > 0.0 && disc > 0.0) {
        vec3 hit = moon - L * (toward - sqrt(disc));
        float shade = smoothstep(size * 1.25, size * 0.8, length(dp - hit.xy));
        if (hit.z > 0.0) { o.ink *= 1.0 - 0.9 * shade; o.accent *= 1.0 - 0.6 * shade; }
      }
    }
    vec2 mq = (dp - moon.xy) / size;
    float md = length(mq);
    if (md < 1.0 && !behindPlanet(moon, r)) {
      vec3 mn = vec3(mq, sqrt(1.0 - md * md));
      float lit = max(dot(mn, L), 0.0);
      o.ink = 0.08 + 0.85 * lit * (0.7 + 0.3 * vnoise(mq * 4.0 + fi * 9.0));
      o.accent = 0.0;
    }
  }

  vec2 meteor = captured(dp, r, tm, uParams[7], px);
  o.ink = max(o.ink, meteor.x);
  o.accent = max(o.accent, meteor.y);

  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  o.source = o.rgb;
  return o;
}
`;
