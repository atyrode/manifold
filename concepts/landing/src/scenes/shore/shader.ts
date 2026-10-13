// The shore scene's picture: a beach at night, surf rolling in, plankton flashing blue.
//
// World units are metres: x right, y up, z ahead of the viewer, still water at y = 0 and the eye
// SHORE_EYE above it. The surf is a train of crest lines parallel to the beach. Each wave's whole
// life (shoaling, breaking, the bore, the swash up the sand and the backwash) is a closed-form
// function of time, so every frame is drawn on its own with no state. Plankton light (Noctiluca
// scintillans, the accent) gathers wherever that water is agitated, and where the pointer stirs it
// (uSim0.r, see sim.ts).
//
// Knobs: K_size, K_period (surf); K_glow, K_sparkles, K_stir, K_fish (bioluminescence; fish fire
// on trigger 0); K_time, K_cycle (sky); K_rain, K_fog, K_wind, K_lightning (weather; lightning on
// trigger 1); K_mark (the M in the sand).

export const shoreGlsl = `
const float SHORE_HORIZON = 0.6;  // screen height of the horizon
const float SHORE_FOV = 0.7;      // vertical field of view (rad): a long lens stacks up the surf
const float SHORE_EYE = 1.8;      // eye height above still water
const float SHORE_LINE = 9.0;     // the still-water line, metres ahead
const float SHORE_FAR = 72.0;     // where each swell line comes into view
const float SHORE_TRAVEL = 22.0;  // seconds from SHORE_FAR to the still-water line
const int SHORE_WAVES = 9;        // waves tracked at once, from new swell to drained backwash
const vec2 SHORE_MARK = vec2(2.0, 7.5);       // the M's centre on the sand (x, z)
const vec2 SHORE_MARK_SIZE = vec2(1.3, 3.0);  // drawn long, like road lettering, so it reads from here
const vec3 SHORE_BIO = vec3(0.16, 0.9, 1.0);  // Noctiluca blue

struct ShoreWave {
  float zc;     // crest, or the bore's front once broken (metres ahead)
  float amp;    // crest height above still water
  float front;  // width of the face toward the beach
  float back;   // width of the slope behind the crest
  float steep;  // 0 open swell .. 1 about to break
  float broken; // metres run since the lip fell (0 before the break)
  float height; // the wave's breaking height here
  float swash;  // seconds since it reached the still-water line (< 0 before)
  float seed;
};

// Wave k, where its crest crosses this view ray (x = camX + slopeX * z). Born at a jittered multiple
// of the period, it crosses the surf in SHORE_TRAVEL seconds, slowing to a third of its offshore
// speed as the water shallows (shallow-water waves travel at sqrt(g * depth)).
ShoreWave shoreWave(float k, float camX, float slopeX, float tm, float period, float size) {
  ShoreWave w;
  w.seed = hash12(vec2(k, 11.3));
  float age = tm - (k + 0.45 * hash12(vec2(k, 3.7))) * period;
  float u = age / SHORE_TRAVEL;
  float uc = clamp(u, 0.0, 1.0);
  float run = (SHORE_FAR - SHORE_LINE) * (1.0 - uc) * (1.0 - 0.5 * uc);
  float x = camX + slopeX * (SHORE_LINE + run);
  // Crests are gently bowed out at sea and straighten as they reach the beach.
  float bow = (1.1 * sin(x * 0.045 + w.seed * TAU) + 0.5 * sin(x * 0.12 + w.seed * 17.0)) * (1.0 - uc);
  w.zc = SHORE_LINE + run + bow;
  // Height: sets of bigger waves every seventh or so, each wave its own, and peaks along the crest.
  float set = 0.5 + 0.5 * sin(k * TAU / 7.0 + 1.3);
  float peaks = 1.0 + 0.22 * sin(x * 0.09 + w.seed * 31.0) + 0.12 * sin(x * 0.23 + w.seed * 7.0);
  w.height = min(size * (0.6 + 0.25 * set + 0.3 * w.seed) * peaks, 1.45);
  // Bigger waves feel the bottom sooner and break further out (a wave breaks once the depth is
  // about 1.3 times its height, McCowan's limit), so the peaks go first and the break peels
  // sideways along the crest.
  float breakAt = SHORE_LINE + 3.0 + 8.5 * w.height;
  w.broken = max(breakAt - w.zc, 0.0);
  float shoal = clamp((SHORE_FAR - w.zc) / (SHORE_FAR - breakAt), 0.0, 1.0);
  w.steep = shoal * shoal * shoal * shoal;
  // Shoaling lifts the crest (Green's law); after the break the bore keeps about half its height
  // and spends it on the way in, collapsing at the waterline.
  float grow = 0.22 + 0.78 * shoal * shoal;
  float spend = mix(1.0, 0.5, smoothstep(0.0, 3.5, w.broken)) * exp(-max(w.broken - 3.5, 0.0) / 16.0);
  float land = mix(0.25, 1.0, smoothstep(SHORE_LINE, SHORE_LINE + 4.0, w.zc));
  w.amp = w.height * grow * spend * land * smoothstep(0.0, 0.08, u) * step(u, 1.0);
  float bore = smoothstep(0.0, 3.0, w.broken);
  w.front = w.broken > 0.0 ? mix(0.7, 0.45, bore) : mix(5.0, 0.7, w.steep);
  w.back = w.broken > 0.0 ? mix(4.0, 3.0, bore) : mix(6.0, 4.0, w.steep);
  w.swash = age - SHORE_TRAVEL;
  return w;
}

// Wave w's height at distance z: a swell hump that steepens on its beach side, becoming a bore
// (a step of white water sloping away behind it) once broken.
float shoreWaveHeight(ShoreWave w, float z) {
  float d = z - w.zc;
  float s = d < 0.0 ? w.front : w.back;
  float swell = exp(-d * d / (s * s));
  float bore = smoothstep(-w.front, 0.0, d) * exp(-max(d, 0.0) / w.back);
  return w.amp * mix(swell, bore, smoothstep(0.0, 2.0, w.broken));
}

// How far wave w's swash runs up the sand at x (metres from the still-water line): bigger waves
// further, and beach cusps a dozen metres apart bunch it into tongues.
float shoreRunup(ShoreWave w, float x) {
  float cusps = 1.0 + 0.22 * sin(x * 0.5 + w.seed * 13.0) + 0.12 * sin(x * 1.3 + w.seed * 5.0);
  return (0.9 + 1.5 * w.height) * cusps;
}

// Seconds a swash takes to run up and drain back to the still-water line.
float shoreSwashTime(float runup) {
  return 1.5 + 2.2 * sqrt(runup);
}

// Where wave w's water reaches up the beach (metres from the still-water line; negative while it
// is still offshore, and once its backwash has drained below the line). The swash front flies up
// like a thrown ball (the ballistic swash of Shen & Meyer 1963), stops, and drains back more slowly
// than it came, the sand soaking up part of the sheet.
float shoreReach(ShoreWave w, float runup) {
  if (w.swash < 0.0) return SHORE_LINE - w.zc;
  float dur = shoreSwashTime(runup);
  float rise = 0.38 * dur;
  if (w.swash < rise) {
    float a = 1.0 - w.swash / rise;
    return runup * (1.0 - a * a);
  }
  float b = min((w.swash - rise) / (dur - rise), 1.18);
  return runup * (1.0 - b * b);
}

// Seconds since wave w's backwash uncovered the sand e metres up the beach: huge if its swash
// never got there or still covers it.
float shoreDrained(ShoreWave w, float runup, float e) {
  if (w.swash < 0.0 || e >= runup || e < -0.39 * runup) return 1e4;
  float dur = shoreSwashTime(runup);
  float rise = 0.38 * dur;
  float at = rise + sqrt(1.0 - e / runup) * (dur - rise);
  return w.swash >= at ? w.swash - at : 1e4;
}

// Wind ripples as a few travelling trains with deep-water dispersion (omega^2 = g k). Returns the
// resolved surface slope (dh/dx, dh/dz) and, in z, the slope variance of the trains too fine for
// this cell, which the glitter takes as roughness instead (as LEAN mapping does, Olano & Baker 2010).
vec3 shoreRipples(vec2 p, float tm, vec2 cellSize, float rough) {
  vec2 slope = vec2(0.0);
  float hidden = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float wavelength = 3.2 * pow(0.58, fi);
    float a = 1.7 + fi * 2.4; // golden-angle spread of directions
    vec2 along = vec2(sin(a), cos(a));
    float k = TAU / wavelength;
    float s = (0.11 - 0.008 * fi) * rough; // steepest slope of this train
    float footprint = mix(cellSize.x, cellSize.y, abs(along.y));
    float seen = smoothstep(3.0, 6.0, wavelength / footprint);
    float phase = k * dot(along, p) - sqrt(9.81 * k) * tm + fi * 1.7;
    slope += along * cos(phase) * s * seen;
    hidden += 0.5 * s * s * (1.0 - seen);
  }
  return vec3(slope, hidden);
}

// Moon or sun glitter: the share of surface facets tilted to mirror the light into the eye, for
// facet slopes spread with variance s2 (a Beckmann distribution, after Cox & Munk's 1954 sea-slope
// measurements). A narrow bright path on calm water, a broad shimmering one in a chop.
float shoreGlitter(vec3 n, vec3 view, vec3 light, float s2) {
  if (light.y <= 0.0) return 0.0;
  vec3 h = normalize(view + light);
  float c = max(dot(n, h), 1e-3);
  float tan2 = (1.0 - c * c) / (c * c);
  return exp(-tan2 / s2) * clamp(0.06 / s2, 0.4, 12.0);
}

// Foam lace: bright where neighbouring Voronoi cells meet (F2 - F1 small, after Worley 1996); the
// cell centres wander so the net keeps tearing and re-forming.
float shoreLace(vec2 x, float t) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = vec2(hash12(i + g + 0.7), hash12(i + g + 13.9));
      o = 0.5 + 0.42 * sin(t + TAU * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return 1.0 - smoothstep(0.04, 0.16, f2 - f1);
}

// Foam bubbles bursting on freshly drained sand, each a brief spark: Noctiluca flashes for a
// tenth of a second or so when its membrane is stressed. Cells are long in z so the sparks come
// out round once perspective squashes the beach.
float shoreSparks(vec2 p, float tm, float density) {
  vec2 g = p / vec2(0.16, 0.5);
  vec2 id = floor(g);
  if (hash12(id + 17.0) > density) return 0.0;
  vec2 at = 0.2 + 0.6 * vec2(hash12(id + 3.1), hash12(id + 5.7));
  float phase = fract(tm * (0.35 + 0.5 * hash12(id + 9.2)) + hash12(id + 1.9));
  float r = length(fract(g) - at);
  return exp(-phase * 14.0) * (1.0 - smoothstep(0.1, 0.32, r));
}

// The storm out at sea: a bank of cloud standing on the horizon right of ahead. az, el: the view
// direction's x and y over z. Returns its cover.
float shoreStormBank(float az, float el, float drift) {
  float across = (az - 0.3) / 0.4;
  float spread = exp(-across * across);
  float top = spread * (0.03 + 0.08 * fbm(vec2(az * 3.0 + drift, 2.7)));
  return 1.0 - smoothstep(top - 0.012, top, el);
}

// A school of fish darting through the shallows. Each fish runs a wavy line across the view and
// its wake is where it passed, fading and spreading with the seconds since. p is the point on the
// water (x, z); returns the wake's light, and the fish themselves in body.
float shoreFish(vec2 p, float age, float seed, float camX, float halfSpan, float cellZ, out float body) {
  body = 0.0;
  float side = seed > 0.5 ? 1.0 : -1.0;
  float lane = SHORE_LINE + 1.6 + 2.6 * fract(seed * 7.13);
  if (abs(p.y - lane) > 3.5) return 0.0;
  float start = camX - side * (halfSpan + 4.0);
  float wake = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float h1 = hash12(vec2(fi, seed * 91.0));
    float h2 = hash12(vec2(fi, seed * 57.0 + 3.0));
    float run = age - h1 * 0.7;
    if (run < 0.0) continue;
    float speed = 6.0 + 2.0 * h2;
    float behind = side * (start + side * speed * run - p.x); // metres behind this fish's nose
    if (behind < -0.4 || behind > speed * 3.5) continue;
    float pathZ = lane + (h2 - 0.5) * 1.8 + 0.45 * sin(p.x * 0.7 + fi * 2.1) + 0.2 * sin(p.x * 2.3 + h1 * 9.0);
    float since = max(behind, 0.0) / speed;
    float width = max(0.1, 2.0 * cellZ) * (1.0 + 1.5 * since);
    float dz = (p.y - pathZ) / width;
    float across = exp(-dz * dz);
    wake += across * exp(-since / 1.3) * smoothstep(-0.4, 0.0, behind) / (1.0 + since);
    float nose = (behind - 0.1) / 0.16;
    body = max(body, exp(-dz * dz * 1.5) * exp(-nose * nose));
  }
  return wake;
}

Shade sceneShore(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  float focal = 0.5 / tan(SHORE_FOV * 0.5);
  vec3 dir = viewRay(uv, aspect, SHORE_HORIZON, SHORE_FOV);
  vec3 view = -dir;
  vec2 sp = (uv - 0.5) * vec2(aspect, 1.0); // screen-height units, for the lightning

  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  // The plankton only shows in the dark: full at night, fading through dawn, gone by day.
  float dark = 1.0 - smoothstep(0.05, 0.5, sky.day);
  float bio = K_glow * 1.5 * dark;
  float boltSeed = 0.0;
  float boltAge = lightningAge(t, K_lightning, 1, boltSeed);
  float flash = lightningFlash(boltAge);
  // The storm stands out to sea right of ahead; each bolt drops from its cloud base to the water.
  float boltAz = 0.3 + (fract(boltSeed * 7.31) - 0.5) * 0.4;
  vec2 boltTop = vec2(boltAz * focal, SHORE_HORIZON - 0.5 + 0.085);
  vec2 boltFoot = vec2(boltTop.x + (fract(boltSeed * 3.17) - 0.5) * 0.06, SHORE_HORIZON - 0.5);
  // The bank stands while lightning is on; a strike fired with lightning off brings it only briefly.
  float storm = K_lightning > 0.0 ? 1.0 : 1.0 - smoothstep(1.0, 3.0, boltAge);
  // Light on a level surface. The moon is held back so the night stays dark around the plankton.
  vec3 lit = sky.ambient + sky.sunColor * max(sky.sun.y, 0.0) + sky.moonColor * max(sky.moon.y, 0.0) * 0.6 + vec3(0.3, 0.33, 0.42) * flash;

  vec3 col = vec3(0.0);
  float glow = 0.0;    // plankton light, before the strength knob and the dark
  float mark = 0.0;    // the M's own glow, independent of the plankton knob
  float sparkle = 0.0; // dither jitter: glitter and sparks

  if (dir.y >= 0.0) {
    float az = dir.x / dir.z;
    float el = dir.y / dir.z;
    col = skyColor(sky, dir) + vec3(0.85, 0.9, 1.0) * skyStars(sky, dir, 0.6);
    if (storm > 0.0) {
      float bank = shoreStormBank(az, el, tm * 0.004 * K_wind) * storm;
      float inside = flash * exp(-abs(az - boltAz) * 3.0) * (0.5 + fbm(vec2(az * 9.0, el * 40.0)));
      col = mix(col, sky.ambient * 0.6 + vec3(0.5, 0.55, 0.8) * inside, bank * 0.92);
    }
    float bolt = boltAge < 1.5 ? lightningBolt(sp, boltTop, boltFoot, boltSeed, boltAge) : 0.0;
    col += mix(vec3(0.55, 0.45, 1.0), vec3(1.0), smoothstep(0.45, 0.75, bolt)) * min(bolt, 1.5);
    col += vec3(0.1, 0.11, 0.16) * flash * exp(-el * 6.0);
    if (K_fog > 0.0) col = mix(col, skyColor(sky, normalize(vec3(dir.x, 0.03, dir.z))), fogAmount(K_fog, 1.0, clamp(el * 5.0, 0.0, 1.0)));
  } else {
    float q = -dir.y / dir.z; // tangent of the angle below the horizon
    float slopeX = dir.x / dir.z;
    float camX = uPointer.x * 0.35 * m; // a step along the beach with the pointer
    float zPlane = min(SHORE_EYE / q, 4000.0);
    float size = mix(0.35, 1.5, K_size);
    float kNow = floor(tm / K_period);

    // Oldest first, which is nearest the beach first.
    ShoreWave waves[SHORE_WAVES];
    for (int i = 0; i < SHORE_WAVES; i++) {
      waves[i] = shoreWave(kNow - float(SHORE_WAVES - 1 - i), camX, slopeX, tm, K_period, size);
    }

    // Where the ray meets the water: test each wave's hump, nearest first, between where the ray
    // has dropped to the crest's height and where it would meet still water; bisect the crossing.
    float hz = zPlane;
    bool onWave = false;
    ShoreWave hit = waves[0];
    for (int i = 0; i < SHORE_WAVES; i++) {
      ShoreWave w = waves[i];
      if (w.amp < 0.02) continue;
      float lo = max(w.zc - 3.0 * w.front, (SHORE_EYE - w.amp) / q);
      float hi = min(w.zc + 2.5 * w.back, zPlane);
      if (lo >= hi) continue;
      float above = lo;
      float below = -1.0;
      for (int s = 0; s <= 12; s++) {
        float z = mix(lo, hi, float(s) / 12.0);
        if (SHORE_EYE - q * z <= shoreWaveHeight(w, z)) { below = z; break; }
        above = z;
      }
      if (below < 0.0) continue;
      for (int s = 0; s < 5; s++) {
        float z = 0.5 * (above + below);
        if (SHORE_EYE - q * z <= shoreWaveHeight(w, z)) below = z; else above = z;
      }
      hz = below;
      hit = w;
      onWave = true;
      break;
    }
    float hx = camX + slopeX * hz;
    float hy = SHORE_EYE - q * hz;
    vec2 g = vec2(hx, hz);
    // Ground covered by one cell, depthwise and across: for antialiasing and level of detail.
    float cellZ = hz * hz / (SHORE_EYE * focal * uRes.y);
    float cellX = hz / (focal * uRes.y);
    float e = SHORE_LINE - hz; // metres up the beach from the still-water line

    // The waterline is the most advanced of the bores coming in and the swashes running up.
    float reach = -1e4;
    float topSwash = -1.0;
    float topRunup = 1.0;
    float drained = 1e4; // seconds since a backwash last uncovered this spot
    for (int i = 0; i < SHORE_WAVES; i++) {
      float runup = shoreRunup(waves[i], hx);
      float r = shoreReach(waves[i], runup);
      if (r > reach) { reach = r; topSwash = waves[i].swash; topRunup = runup; }
      drained = min(drained, shoreDrained(waves[i], runup, e));
    }
    bool water = e < reach;
    float edge = reach - e; // metres inside the water from its leading edge
    float wet = 1.0;

    // Rain: rings on the water and the wet sand, stretched along z so they survive perspective,
    // and faded out where a ring would shrink below a few cells.
    vec3 drops = vec3(0.0);
    if (K_rain > 0.0) {
      float fade = 1.0 - smoothstep(0.08, 0.25, max(cellX * 5.0, cellZ * 2.0));
      drops = rainRipples(vec2(hx * 5.0, hz * 2.0), t, K_rain) * fade;
    }

    vec3 mirror = vec3(0.0);
    if (water) {
      // Surface slope: the waves' own (along z) plus wind ripples and raindrops.
      float eps = max(0.05, cellZ);
      float slopeZ = 0.0;
      for (int i = 0; i < SHORE_WAVES; i++) {
        if (waves[i].amp < 0.02) continue;
        slopeZ += (shoreWaveHeight(waves[i], hz + eps) - shoreWaveHeight(waves[i], hz - eps)) / (2.0 * eps);
      }
      vec3 rip = shoreRipples(g, tm, vec2(cellX, cellZ), 0.6 + 0.9 * abs(K_wind));
      vec2 tilt = rip.xy + drops.xy * 0.5;
      vec3 n = normalize(vec3(-tilt.x, 1.0, -(slopeZ + tilt.y)));
      // Facets too fine to draw still lean toward the eye: at a grazing view the sea mirrors sky
      // from higher up, and less of it, so it stays darker than the sky at the horizon.
      float rough = 0.006 + rip.z + 0.004 * K_rain;
      float spread = sqrt(rough);
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), spread * 0.8), 5.0);
      vec3 refl = reflect(dir, n);
      mirror = skyColor(sky, normalize(vec3(refl.x, max(refl.y, 0.0) + spread * 1.5, refl.z))) + vec3(0.1, 0.11, 0.16) * flash;
      // Glitter of the moon (and the sun by day), its facets spread by ripples too fine to draw.
      // Moonlight on water is played up: it is the brightest thing on a dark sea.
      vec3 shine = sky.moonColor * shoreGlitter(n, view, sky.moon, rough) * 2.5 + sky.sunColor * shoreGlitter(n, view, sky.sun, rough);

      // Water: dark blue offshore, turquoise over the sand in the shallows, the sand itself showing
      // through the thin sheet of the swash.
      float shallow = 1.0 - smoothstep(SHORE_LINE, SHORE_LINE + 14.0, hz);
      vec3 body = mix(vec3(0.01, 0.07, 0.13), vec3(0.04, 0.38, 0.38), shallow) * lit;
      body = mix(body, vec3(0.36, 0.3, 0.23) * lit, (1.0 - clamp(edge / 2.2, 0.0, 1.0)) * 0.85);
      vec3 sea = mix(body, mirror, fres) + shine * 0.7;

      if (onWave) {
        float hr = clamp(hy / max(hit.amp, 1e-3), 0.0, 1.0);
        float face = 1.0 - smoothstep(-0.2, 0.3, hz - hit.zc); // the side toward the beach
        // Light through the thin top of a steep wave, turquoise in the sun; a paler lip as it curls.
        float thin = smoothstep(0.45, 0.95, hr) * face * hit.steep * (1.0 - smoothstep(0.0, 2.0, hit.broken));
        sea += vec3(0.06, 0.45, 0.38) * thin * (sky.sunColor * 0.6 + sky.moonColor * 0.3 + sky.ambient * 0.4);
        float lip = smoothstep(0.86, 0.98, hr) * smoothstep(0.5, 1.0, hit.steep);
        sea = mix(sea, vec3(0.75, 0.85, 0.88) * lit, lip * 0.45);
        // As it plunges, the curl's shadow: a dark tube under the falling lip.
        float plunge = smoothstep(0.0, 0.3, hit.broken) * (1.0 - smoothstep(0.8, 2.5, hit.broken));
        sea *= 1.0 - 0.6 * plunge * face * smoothstep(0.3, 0.55, hr) * (1.0 - smoothstep(0.72, 0.86, hr));
      }

      // White water and the light in it, wave by wave.
      float dens = 0.0;       // white water
      float rel = 0.0;        // position behind the densest front, for the foam's texture
      float foamSeed = 0.0;
      float laceAmount = 0.0; // old foam left lying on the surface
      float surf = 0.0;       // plankton light from the surf
      for (int i = 0; i < SHORE_WAVES; i++) {
        ShoreWave w = waves[i];
        float d = hz - w.zc;
        // Once its swash has started, a wave's white water lingers a moment behind the waterline.
        float linger = w.swash < 0.0 ? 1.0 : exp(-w.swash / 1.5);
        if (w.broken > 0.0) {
          // The white water starts at the pitching lip and pours down the face within a metre or so
          // of travel; on and behind the crest it is white at once.
          float level = shoreWaveHeight(w, hz) / max(w.amp, 1e-3);
          float poured = 1.0 - w.broken / 1.2;
          float cascade = d < 0.0 ? smoothstep(poured - 0.15, poured, level) : 1.0;
          float lead = w.front * 1.5 + 0.6 * (1.0 - smoothstep(0.0, 3.0, w.broken));
          float band = 1.0 + min(w.broken * 0.6, 7.0);
          float wd = smoothstep(-lead, -0.1, d) * exp(-max(d, 0.0) / band) * smoothstep(0.0, 0.6, w.broken) * cascade * linger;
          if (wd > dens) { dens = wd; rel = d; foamSeed = w.seed; }
          laceAmount = max(laceAmount, smoothstep(-0.2, 0.6, d) * exp(-max(d, 0.0) / 14.0) * smoothstep(0.0, 4.0, w.broken) * (w.swash < 0.0 ? 1.0 : exp(-w.swash / 5.0)));
          // The lip lights up as it pitches, the light pours down the face with the white water, and
          // the flash runs along the crest as the break peels.
          float burst = smoothstep(0.0, 0.5, w.broken) * exp(-w.broken / 3.0) * linger;
          float atLip = (d + 0.4 * w.front) / (w.front + 0.8);
          surf += burst * exp(-atLip * atLip) * cascade * 1.4;
          // The bore stays lit, brightest in the churn at its front.
          surf += wd * (0.3 + 0.7 * exp(-w.broken / 9.0)) * mix(0.45, 1.0, exp(-max(d, 0.0) / 1.2));
        } else if (w.steep > 0.6) {
          // Just before the break the crest begins to spill: flecks of white, and of light.
          float atTop = (d + 0.15) / 0.45;
          float top = exp(-atTop * atTop) * smoothstep(0.6, 1.0, w.steep);
          float flecks = top * smoothstep(0.55, 0.85, vnoise(vec2(hx * 1.3 - tm * 0.6, w.seed * 19.0)));
          if (flecks * 0.6 > dens) { dens = flecks * 0.6; rel = d; foamSeed = w.seed; }
          surf += flecks * 0.6;
        }
      }
      // Turbulent white water, its texture carried along with the front that made it.
      float churn = fbm(vec2(hx * 1.4 + K_wind * tm * 0.3, rel * 0.9) + vec2(foamSeed * 37.0, -tm * 0.4));
      float white = smoothstep(0.38, 0.62, dens + (churn - 0.5) * 0.9);
      // Old foam: a lace drifting shoreward on the open water.
      float lace = laceAmount > 0.01 ? shoreLace(vec2(hx * 1.5, hz * 0.55 + tm * 0.25), tm * 0.3) * laceAmount : 0.0;
      surf += lace * 0.15;

      // The swash: a rim of foam pushed ahead of the sheet, and behind it a net of foam carried
      // with the flow, thinning as the sheet slows and drains.
      float rim = 0.0;
      if (topSwash >= 0.0 && edge < 5.0) {
        float young = exp(-topSwash / 2.0);
        float rising = topSwash < 0.38 * shoreSwashTime(topRunup) ? 1.0 : 0.0;
        float net = exp(-edge / (0.5 + 1.5 * young)) * (0.35 + 0.65 * young);
        float web = shoreLace(vec2(hx * 2.4, (e - reach * 0.85) * 1.1), tm * 0.3);
        rim = exp(-edge / 0.12) * (0.3 + 0.7 * young) * (0.75 + 0.25 * web);
        lace = max(lace, web * net);
        surf += rim * mix(0.45, 1.0, rising) * (0.4 + 0.6 * young) + web * net * young * 0.5;
      }
      float foam = clamp(max(max(white, lace), rim), 0.0, 1.0);
      vec3 foamCol = vec3(0.9, 0.94, 0.96) * (lit * 1.1 + sky.moonColor * 0.15);
      col = mix(sea, foamCol, foam);
      col += drops.z * 0.25 * (mirror + lit * 0.3);
      sparkle = min(dot(shine, LUMA), 1.0) * (1.0 - foam);
      glow = surf * (0.55 + 0.7 * churn) + drops.z * 0.5;

      // Lightning mirrored in the sea near the horizon, broken up by the ripples.
      if (boltAge < 1.5 && SHORE_HORIZON - uv.y < 0.15) {
        vec2 mp = vec2(sp.x + n.x * 0.12, 2.0 * (SHORE_HORIZON - 0.5) - sp.y);
        col += vec3(0.7, 0.72, 0.95) * min(lightningBolt(mp, boltTop, boltFoot, boltSeed, boltAge), 1.5) * fres * 0.8;
      }
    } else {
      // Sand: dry above the swash's usual reach, darker where wet, and a mirror while a film of
      // water drains off it.
      float usual = 0.9 + 1.3 * size;
      float soaked = 1.0 - smoothstep(0.4, 1.0, e / usual);
      float film = exp(-drained / 2.5);
      wet = max(soaked * 0.55, exp(-drained / 6.0));
      float grain = fbm(g * vec2(1.3, 0.45));
      // Wind ripples on the dry sand, faded before they get finer than the cells.
      float ripples = (0.5 + 0.5 * sin(hz * 7.0 + hx * 0.9 + 3.0 * vnoise(g * vec2(0.6, 0.3)))) * (1.0 - smoothstep(0.08, 0.2, cellZ));
      vec3 dry = vec3(0.76, 0.67, 0.5) * (0.82 + 0.3 * grain) * (1.0 - 0.16 * ripples);
      vec3 damp = vec3(0.36, 0.3, 0.23) * (0.9 + 0.2 * grain);
      vec3 sand = mix(dry, damp, wet) * lit;
      // The wrack line: dark strands of weed where the highest waves leave them.
      float wrackAt = usual * 1.25 + 0.3 * sin(hx * 0.4) + 0.15 * sin(hx * 1.1);
      float wrack = (1.0 - smoothstep(0.06, 0.16 + cellZ, abs(e - wrackAt))) * smoothstep(0.45, 0.6, vnoise(vec2(hx * 2.5, 3.0)));
      sand *= 1.0 - 0.6 * wrack;

      vec2 grit = (vec2(vnoise(g * vec2(9.0, 3.0)), vnoise(g * vec2(9.0, 3.0) + 5.0)) - 0.5) * 0.06 * (1.0 - film);
      vec2 tilt = grit + drops.xy * 0.4 * wet;
      vec3 n = normalize(vec3(-tilt.x, 1.0, -tilt.y));
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
      vec3 refl = reflect(dir, n);
      refl = normalize(vec3(refl.x, max(refl.y, 0.01), refl.z));
      mirror = skyColor(sky, refl) + vec3(0.9, 0.95, 1.0) * skyStars(sky, refl, 0.6) * film + vec3(0.1, 0.11, 0.16) * flash;
      float rough = 0.003 + 0.02 * (1.0 - film);
      vec3 shine = (sky.moonColor * shoreGlitter(n, view, sky.moon, rough) * 2.5 + sky.sunColor * shoreGlitter(n, view, sky.sun, rough)) * (wet * 0.4 + film);
      col = mix(sand, mirror, clamp(fres * (wet * 0.6 + film * 1.3), 0.0, 1.0)) + shine * 0.6 + drops.z * 0.2 * mirror * wet;
      sparkle = min(dot(shine, LUMA), 1.0);
      // Bubbles bursting in the foam the backwash leaves behind.
      if (K_sparkles > 0.0) {
        float sparks = shoreSparks(g, tm, K_sparkles * 0.7) * exp(-drained / 4.0);
        glow += sparks * 1.3;
        sparkle = max(sparkle, sparks * 0.5);
      }
      glow += drops.z * 0.4 * wet;
    }

    // The pointer's wake: swirls of a ridged noise warped by a slowly turning flow. A fresh stir
    // glows solid; an older one breaks into filaments as it fades. Only where there is plankton:
    // in the water, and stranded on wet sand.
    if (K_stir > 0.5 && uSimOn.x > 0.5) {
      float trail = textureLod(uSim0, uv, 0.0).r;
      if (trail > 0.004) {
        vec2 s = vec2(uv.x * aspect, uv.y * 2.2) * 7.0;
        vec2 warp = s + 1.6 * vec2(vnoise(s * 0.5 + vec2(tm * 0.3, 3.1)), vnoise(s * 0.5 + vec2(7.7, -tm * 0.27)));
        float ridge = 1.0 - abs(2.0 * vnoise(warp * 1.8) - 1.0);
        float stir = trail * mix(smoothstep(0.6, 0.92, ridge), 1.0, smoothstep(0.4, 0.95, trail));
        glow += stir * 1.2 * (water ? 1.0 : clamp(wet * 1.5, 0.0, 1.0));
      }
    }

    // Fish: from the "now" button, or now and then on their own.
    float fishAge = sinceTrigger(0);
    float fishSeed = hash12(vec2(uTriggers[0], 5.1));
    if (K_fish > 0.0) {
      float every = mix(70.0, 18.0, K_fish);
      float slot = floor(tm / every);
      float age = tm - (slot + 0.1 + 0.5 * hash12(vec2(slot, 41.0))) * every;
      if (age >= 0.0 && age < fishAge && hash12(vec2(slot, 43.0)) < 0.85) {
        fishAge = age;
        fishSeed = hash12(vec2(slot, 42.0));
      }
    }
    if (water && fishAge < 9.0) {
      float fishBody = 0.0;
      float halfSpan = aspect * 0.5 * (SHORE_LINE + 3.0) / focal;
      float wake = shoreFish(g, fishAge, fishSeed, camX, halfSpan, cellZ, fishBody);
      glow += wake * 1.1 + fishBody * 0.8;
      // Glowing darts at night; dark slips under the surface by day.
      col *= 1.0 - 0.45 * fishBody * (1.0 - dark);
    }

    // The M in the sand: a groove holding water that mirrors the sky. Each wave that washes over
    // it fills it with lit plankton, glowing while it is covered and fading after.
    if (K_mark > 0.5) {
      vec2 mq = (g - SHORE_MARK) / SHORE_MARK_SIZE;
      float fp = max(cellX / SHORE_MARK_SIZE.x, cellZ / SHORE_MARK_SIZE.y);
      float groove = 1.0 - smoothstep(0.05 - fp, 0.05 + fp, markDistance(mq));
      col = mix(col * (1.0 - 0.35 * groove), mirror * 0.8, groove * wet * 0.35);
      mark = groove * (water ? 1.0 : exp(-drained / 3.5)) * mix(0.55, 1.0, dark);
    }

    if (K_fog > 0.0) {
      float f = fogAmount(K_fog, 1.0 - exp(-hz / 45.0), clamp(hy / 3.0, 0.0, 1.0));
      col = mix(col, skyColor(sky, normalize(vec3(dir.x, 0.03, dir.z))), f);
      glow *= 1.0 - f;
      mark *= 1.0 - f;
    }
  }

  if (K_rain > 0.0) {
    float streak = rainStreaks(uv, aspect, t, K_rain, K_wind);
    col = mix(col, lit * 0.8 + vec3(0.05, 0.06, 0.08), streak * 0.5);
  }

  // Ink is the picture's light without the plankton; the plankton and the M are the accent, and in
  // full colour they add their blue on top, burning toward white where they are brightest. A sunlit
  // beach puts the page in its paper theme (index.ts), where ink is dark on a light ground.
  float light = clamp(glow * bio, 0.0, 1.5);
  float lum = dot(col, LUMA);
  bool paper = K_cycle <= 0.0 && K_time > 0.33 && K_time < 0.67;
  Shade o = blankShade();
  o.ink = paper ? clamp((0.9 - lum) / 0.8, 0.0, 1.0) : clamp(pow(lum, 0.8) * 1.3, 0.0, 1.0);
  o.accent = clamp(max(light, mark), 0.0, 1.0);
  o.shimmer = clamp(sparkle, 0.0, 1.0) * 0.35 * m;
  col += SHORE_BIO * (light + mark) * 1.1;
  o.rgb = col;
  o.source = col;
  return o;
}
`;
