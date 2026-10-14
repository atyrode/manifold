// The campfire's picture, back to front: the night sky (dusk to deep night from the shared sky, the
// Milky Way, stars, a giant ringed planet, shooting stars), two rows of far pines fading into the haze,
// the ground (soil, and a flat rocky outcrop under the fire) lit by the fire, two big pines framing the
// view, the tent with its lantern and the backpack at the edge of the light, the far half of the stone
// ring, the coals, the back log, the flames (four nested layers of licking tongues), the smoke column,
// the two front logs, the near stones, the mug, the marshmallow stick, the log bench (with the M carved
// in it when it is on) and the sparks.
//
// Space: p = (x in view heights from the centre, y up from the bottom), one cell = 1 / uRes.y. The
// fire stands at campfireF; ground distances are foreshortened (a circle on the ground is an ellipse
// 0.32 as tall). Light is one warm source at the fire, falling off as 1 / (1 + (d / r0)^2)^2, breathing
// a few percent; every surface is albedo * (sky ambient + warm * firelight).
//
// Nothing here is a simulation. Moving edges (flame layers, smoke, sparks, shooting stars) are cut per
// cell with hardEdge / hardFill so a passing edge flips a cell once; the flames' noise advects upward at
// well under a flame height per second, the sparks drift at ~25 px/s, so nothing flickers cell by cell.
// Knobs read here: K_flame, K_lively, K_sparks, K_smoke, K_marshmallow, K_reach, K_camp, K_time,
// K_cycle, K_stars, K_planet, K_shooting (trigger 0), K_wind, K_fog, K_mark.
export const campfireGlsl = `
// ---- campfire ----
const float CAMPFIRE_HORIZON = 0.37;   // screen height of the far horizon (the pines hide it)
const float CAMPFIRE_FOV = 1.0;
const float CAMPFIRE_FLAME = 0.30;     // the full flame's height, in the fire's own units
const vec3 CAMPFIRE_WARM = vec3(1.0, 0.52, 0.18);
// The Milky Way's pole: the band runs from low on the left up to the top right.
const vec3 CAMPFIRE_GALAXY = vec3(0.5, -0.82, 0.28);

Sky campfireSkyState;
vec3 campfireAmb;       // light from the sky on upturned surfaces
vec2 campfireF;         // the fire's centre on the ground
float campfireS;        // flame scale, 0.62 .. 1.38
float campfireTm;       // the motion clock
float campfireBreath;   // firelight gain, breathing a few percent
float campfireHalf;     // half the frame width, kept in 0.5 .. 0.9 for the layout
float campfireGlow;     // what should glow in the accent colour

float campfireSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Firelight reaching p: 1 at the fire, falling off. lift 0 is flat ground (distances foreshortened),
// 1 an upright surface.
float campfireLight(vec2 p, float lift) {
  vec2 d = p - (campfireF + vec2(0.0, 0.085 * campfireS));
  d.y /= mix(0.34, 1.0, lift);
  float r0 = (0.20 + 0.36 * K_reach) * (0.8 + 0.2 * campfireS);
  float l = 1.0 / (1.0 + dot(d, d) / (r0 * r0));
  return l * l * campfireBreath;
}

void campfireSetup(float aspect) {
  campfireTm = uMotionTime;
  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, uMotionTime));
  vec3 amb = sky.ambient - sky.moonColor * 0.3;
  // No moon: the giant planet is the sky's other light.
  sky.moon = vec3(0.0, -1.0, 0.0);
  sky.moonColor = vec3(0.0);
  campfireSkyState = sky;
  campfireAmb = amb * 1.35 + vec3(0.006, 0.010, 0.022);
  campfireHalf = clamp(0.5 * aspect, 0.5, 0.9);
  campfireS = 0.62 + 0.76 * K_flame;
  campfireF = vec2(0.0, 0.16);
  float slow = 0.5 + 0.5 * sin(campfireTm * 0.9 + 1.3 * sin(campfireTm * 0.37));
  float lick = vnoise1(campfireTm * 0.8, 11.0).x;
  campfireBreath = (0.55 + 0.45 * campfireS) * (0.90 + 0.06 * slow + 0.06 * (lick - 0.5));
  campfireGlow = 0.0;
}

// ---- the sky ----

// A band of soft star clouds with a dark dust lane down it, 0..~1.3.
float campfireMilkyWay(vec3 d) {
  float b = dot(d, CAMPFIRE_GALAXY);
  if (d.y <= 0.0 || abs(b) > 0.35) return 0.0;
  vec3 e1 = normalize(cross(CAMPFIRE_GALAXY, vec3(0.0, 0.0, 1.0)));
  vec3 e2 = cross(CAMPFIRE_GALAXY, e1);
  float l = atan(dot(d, e2), dot(d, e1));
  float band = exp(-b * b / 0.014);
  float clouds = 0.55 * vnoise(vec2(l * 8.0, b * 26.0)) + 0.45 * vnoise(vec2(l * 21.0 + 3.0, b * 60.0));
  float lane = (b - 0.02 - 0.015 * sin(l * 5.0)) / 0.016;
  float dust = 1.0 - 0.75 * exp(-lane * lane) * smoothstep(0.25, 0.6, vnoise(vec2(l * 4.0, 7.0)));
  return band * (0.35 + 0.9 * clouds) * dust * smoothstep(0.0, 0.15, d.y);
}

vec3 campfireSkyAt(vec3 d) {
  Sky sky = campfireSkyState;
  vec3 col = skyColor(sky, d);
  float mw = campfireMilkyWay(d) * K_stars * sky.night;
  col += vec3(0.085, 0.080, 0.110) * mw;
  col += skyStarLight(sky, d, K_stars * (0.7 + 0.8 * mw));
  return col;
}

// The giant: a banded, storm-swirled planet lit from the upper left with a thin ring tipped across it.
vec3 campfirePlanetOver(vec3 col, vec2 p, float px) {
  if (K_planet <= 0.0) return col;
  vec2 c = vec2(0.58 * campfireHalf, 0.57);
  float r = 0.07 + 0.13 * K_planet;
  vec2 q = (p - c) / r;
  if (abs(q.x) > 2.3 || abs(q.y) > 2.3) return col;
  float vis = 1.0 - 0.85 * campfireSkyState.day;
  float night = campfireSkyState.night;
  float l = length(q);
  vec2 qt = rotate(q, -0.32);
  // The ring: an ellipse in the tilted frame, streaked, with a gap.
  float ru = length(vec2(qt.x, qt.y / 0.20));
  float ringBody = smoothstep(1.32, 1.38, ru) * smoothfall(2.12, 2.05, ru);
  float streak = clamp(0.6 + 0.4 * sin(ru * 30.0 + 1.0), 0.0, 1.0);
  ringBody *= (1.0 - 0.85 * bell((ru - 1.72) / 0.035)) * streak;
  vec3 ringCol = mix(vec3(0.42, 0.35, 0.25), vec3(0.78, 0.68, 0.50), streak);
  float ringCover = hardEdge(ringBody * 0.85);
  // Faint glow round the limb.
  col += vec3(0.012, 0.034, 0.034) * bell((l - 1.0) / 0.9) * night * vis;
  // Behind the disc: the far half of the ring.
  if (qt.y >= 0.0) col = mix(col, ringCol, ringCover * vis);
  float cover = hardFill((l - 1.0) * r, px);
  if (cover > 0.5) {
    vec3 n = vec3(q, sqrt(max(1.0 - l * l, 0.0)));
    vec3 lightDir = normalize(vec3(-0.62, 0.42, 0.66));
    float lit = smoothstep(-0.12, 0.62, dot(n, lightDir));
    vec2 sw = qt - vec2(-0.30, -0.28);
    float storm = bell(length(sw) / 0.38);
    vec2 qs = vec2(-0.30, -0.28) + rotate(sw, 2.6 * storm);
    float warp = fbm3(vec2(qs.x * 1.8 + 0.004 * campfireTm, qs.y * 5.0));
    float band = 0.5 + 0.5 * sin(qs.y * 11.0 + warp * 5.0);
    vec3 deep = vec3(0.04, 0.20, 0.22);
    vec3 mid = vec3(0.12, 0.45, 0.40);
    vec3 pale = vec3(0.62, 0.78, 0.62);
    vec3 base = mix(mix(deep, mid, smoothstep(0.1, 0.6, band)), pale, 0.8 * smoothstep(0.62, 0.95, band));
    base = mix(base, vec3(0.80, 0.86, 0.76), 0.35 * storm);
    vec3 disc = base * (0.10 + 0.95 * lit) * (0.55 + 0.45 * n.z);
    disc += vec3(0.08, 0.30, 0.30) * pow(1.0 - n.z, 3.0) * lit * 0.8;
    col = mix(col, disc, vis);
  }
  // In front of the disc: the near half of the ring.
  if (qt.y < 0.0) col = mix(col, ringCol, ringCover * vis);
  return col;
}

// A shooting star age seconds after it appeared: a head sliding along a straight path, a tail behind it.
float campfireMeteor(vec2 p, float age, float seed, float px) {
  const float dur = 1.4;
  if (age < 0.0 || age > dur) return 0.0;
  float f = age / dur;
  vec2 a = vec2((hash12(vec2(seed, 1.3)) - 0.5) * 1.5 * campfireHalf, 0.72 + 0.22 * hash12(vec2(seed, 2.3)));
  float sgn = hash12(vec2(seed, 3.3)) < 0.5 ? -1.0 : 1.0;
  vec2 dv = normalize(vec2(sgn, -0.42 - 0.3 * hash12(vec2(seed, 4.3))));
  vec2 head = a + dv * (0.5 * f);
  float tail = 0.02 + 0.2 * smoothstep(0.0, 0.2, f);
  vec2 ba = dv * tail;
  vec2 pa = p - (head - ba);
  float u = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float d = length(pa - ba * u);
  float r = px * (0.5 + 1.1 * u);
  float bright = u * u * smoothstep(0.0, 0.12, f) * (1.0 - smoothstep(0.6, 1.0, f));
  return hardEdge(softFill(d - r, px * 0.8) * bright * 1.3);
}

vec3 campfireMeteors(vec3 col, vec2 p, float px) {
  if (campfireSkyState.night < 0.2 || p.y < 0.4) return col;
  float m = 0.0;
  if (K_shooting > 0.0) {
    float period = 8.0 / (0.15 + K_shooting);
    float k = floor(campfireTm / period);
    float start = (k + 0.1 + 0.6 * hash12(vec2(k, 17.0))) * period;
    if (hash12(vec2(k, 23.0)) < 0.8) m = campfireMeteor(p, campfireTm - start, k * 1.31 + 2.0, px);
  }
  m = max(m, campfireMeteor(p, sinceTrigger(0), fract(uTriggers[0] * 0.173) * 50.0 + 5.0, px));
  return mix(col, vec3(0.86, 0.93, 1.0), m * campfireSkyState.night);
}

// ---- pines ----

// A pine of tiered boughs as a signed distance (< 0 inside): bare trunk below s = 0.14, then tiers that
// widen downward and taper to the top; lean sways the top.
float campfireTree(vec2 p, float cx, float base, float h, float w, float tiers, float lean) {
  float s = (p.y - base) / h;
  float sc = clamp(s, 0.0, 1.2);
  float cr = clamp((s - 0.14) / 0.86, 0.0, 1.0);
  float hw = s < 0.14 ? w * 0.07 : w * (1.0 - cr) * mix(1.0, 0.45, fract(cr * tiers));
  float x = cx + lean * sc * sc;
  return max(abs(p.x - x) - hw, p.y - (base + h));
}

// A row of pines along x, one per cell of width spacing (jittered), the nearest three tested.
float campfireRow(vec2 p, float spacing, float base, float hMin, float hMax, float w, float salt, float lean) {
  float d = 1e3;
  float i0 = floor(p.x / spacing);
  for (int k = -1; k <= 1; k++) {
    float id = i0 + float(k);
    float h1 = hash12(vec2(id, salt));
    float h2 = hash12(vec2(id, salt + 9.1));
    float cx = (id + 0.15 + 0.7 * h1) * spacing;
    float h = mix(hMin, hMax, h2 * h2);
    float tiers = 5.0 + floor(h1 * 3.0);
    float sway = lean * sin(campfireTm * 0.3 + id * 1.7);
    d = min(d, campfireTree(p, cx, base, h, w * mix(0.8, 1.2, h1), tiers, sway));
  }
  return d;
}

// Pine colour: nearly black, more haze the farther it stands.
vec3 campfireTreeTone(float haziness, vec3 haze) {
  vec3 dark = vec3(0.05, 0.075, 0.06) * (campfireAmb * 3.0 + 0.04);
  return mix(dark, haze * 0.8, clamp(haziness + K_fog * 0.6, 0.0, 1.0));
}

// ---- the ground ----

float campfireGroundTop(float x) {
  float side = smoothstep(0.55 * campfireHalf, campfireHalf * 1.05, abs(x));
  return 0.285 + 0.014 * vnoise(vec2(x * 3.0, 1.7)) + 0.045 * side;
}

// The ring of stones: centre of stone i and its half size. Stones further from the viewer sit higher
// and smaller.
vec2 campfireStone(int i, out vec2 sz) {
  float fi = float(i);
  float ang = (fi + 0.35 * hash12(vec2(fi, 5.1))) * (TAU / 12.0) + 0.2;
  float rr = 1.0 + 0.10 * (hash12(vec2(fi, 6.2)) - 0.5);
  float depth = sin(ang);
  vec2 c = campfireF + vec2(cos(ang) * 0.175 * rr, depth * 0.052 * rr);
  float sizeV = 0.020 + 0.012 * hash12(vec2(fi, 7.3));
  float scale = 1.0 - 0.22 * depth;
  sz = vec2(sizeV * 1.25, sizeV * 0.85) * scale;
  return c;
}

vec3 campfireGround(vec2 p) {
  vec2 q = p - campfireF;
  vec2 g = vec2(q.x, q.y / 0.32);
  float rho = length(g);
  vec2 u = g / max(rho, 1e-4);
  float slabR = 0.34 + 0.07 * vnoise(u * 1.7 + 3.0) + 0.03 * vnoise(u * 4.3 + 1.0);
  float n = fbm3(p * vec2(8.0, 16.0));
  vec3 soil = mix(vec3(0.16, 0.12, 0.085), vec3(0.10, 0.125, 0.085), smoothstep(0.35, 0.7, n));
  float pebble = step(0.97, hash12(floor(p * vec2(80.0, 140.0))));
  soil = mix(soil, vec3(0.24, 0.23, 0.22), pebble * 0.7);
  vec3 rock = mix(vec3(0.21, 0.205, 0.22), vec3(0.14, 0.14, 0.17), smoothstep(0.3, 0.8, fbm3(p * vec2(5.0, 12.0) + 4.0)));
  float crack = smoothfall(0.05, 0.022, abs(vnoise(p * vec2(6.0, 15.0) + 8.0) - 0.5));
  rock *= 1.0 - 0.55 * crack;
  float slab = hardEdge(smoothfall(slabR + 0.02, slabR - 0.02, rho));
  vec3 alb = mix(soil, rock, slab);
  // Contact shadows under the stones.
  float occ = 1.0;
  if (abs(q.x) < 0.27 && abs(q.y) < 0.11) {
    for (int i = 0; i < 12; i++) {
      vec2 sz;
      vec2 c = campfireStone(i, sz);
      vec2 e = (p - c + vec2(0.0, sz.y * 0.55)) / (sz * vec2(1.3, 0.9));
      occ *= 1.0 - 0.55 * (1.0 - smoothstep(0.7, 1.3, length(e)));
    }
  }
  vec3 lightc = campfireAmb * 0.9 + CAMPFIRE_WARM * (2.6 * campfireLight(p, 0.0));
  return alb * lightc * occ;
}

void campfireStones(vec2 p, float px, bool front, inout vec3 col) {
  if (abs(p.x - campfireF.x) > 0.27 || abs(p.y - campfireF.y) > 0.10) return;
  for (int i = 0; i < 12; i++) {
    vec2 sz;
    vec2 c = campfireStone(i, sz);
    if ((c.y < campfireF.y) != front) continue;
    vec2 lp = p - c;
    if (abs(lp.x) > sz.x * 1.2 || abs(lp.y) > sz.y * 1.2) continue;
    float fi = float(i);
    lp += (vec2(vnoise(lp * 90.0 + fi * 7.0), vnoise(lp * 90.0 + fi * 3.0 + 40.0)) - 0.5) * 0.004;
    float d = sdBox(lp, sz * 0.92, min(sz.x, sz.y) * 0.8);
    if (hardFill(d, px) < 0.5) continue;
    vec2 nn = normalize(vec2(lp.x / sz.x, lp.y / sz.y) + vec2(0.0001));
    vec2 toFire = normalize(campfireF + vec2(0.0, 0.07) - c);
    float lit = clamp(0.5 + 0.5 * dot(nn, toFire), 0.0, 1.0);
    float upward = clamp(0.5 + 0.5 * nn.y, 0.0, 1.0);
    vec3 alb = mix(vec3(0.17, 0.16, 0.17), vec3(0.25, 0.22, 0.19), hash12(vec2(fi, 9.4)));
    alb *= 0.82 + 0.3 * vnoise(lp * vec2(55.0, 70.0) + fi * 5.0);
    float lightv = campfireLight(c, 0.6);
    col = alb * (campfireAmb * (0.6 + 0.5 * upward) + CAMPFIRE_WARM * (3.4 * lightv * (0.2 + 0.9 * lit * lit)));
  }
}

// ---- the camp ----

void campfireTent(vec2 p, float px, inout vec3 col) {
  if (K_camp < 0.5) return;
  float cx = -mix(0.44, 0.58, smoothstep(0.5, 0.89, campfireHalf));
  vec2 q = p - vec2(cx, 0.2);
  const float tentH = 0.2;
  const float tentW = 0.16;
  if (abs(q.x) > 0.3 || q.y < -0.08 || q.y > 0.25) return;
  // Contact shadow, and the lantern's light spilling out of the door onto the ground.
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2(q.x / (tentW * 1.35), (q.y + 0.005) / 0.034))));
  float lantern = 0.88 + 0.12 * sin(campfireTm * 0.9 + 1.0);
  if (q.y < 0.0) col += vec3(1.0, 0.55, 0.2) * 0.07 * lantern * bell(length(vec2(q.x / 0.22, (q.y + 0.01) / 0.06)));
  float ty = clamp(q.y / tentH, 0.0, 1.0);
  float d = max((abs(q.x) - tentW * (1.0 - ty)) * 0.78, max(-q.y, q.y - tentH));
  if (hardFill(d, px) < 0.5) return;
  float side = smoothstep(-tentW, tentW, q.x);
  vec3 alb = mix(vec3(0.26, 0.17, 0.13), vec3(0.34, 0.24, 0.16), side);
  alb *= 0.88 + 0.12 * vnoise(vec2(q.x * 60.0, q.y * 8.0));
  float lightv = campfireLight(p, 0.9);
  vec3 c = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.0 * lightv * (0.5 + 0.5 * side));
  c += vec3(1.0, 0.55, 0.2) * 0.10 * lantern * bell(length(vec2(q.x, q.y - 0.065)) / 0.13);
  // The doorway, with the lantern inside.
  float dd = max((abs(q.x) - tentW * 0.36 * (1.0 - clamp(q.y / (tentH * 0.86), 0.0, 1.0))) * 0.8, q.y - tentH * 0.86);
  float door = hardFill(dd, px);
  vec3 inside = vec3(0.04, 0.025, 0.02) + vec3(1.0, 0.55, 0.2) * 0.34 * lantern * bell(length(vec2(q.x, q.y - 0.065)) / 0.075);
  col = mix(c, inside, door);
}

void campfirePack(vec2 p, float px, inout vec3 col) {
  if (K_camp < 0.5) return;
  vec2 q = p - vec2(-0.285, 0.15);
  if (abs(q.x) > 0.07 || q.y < -0.09 || q.y > 0.075) return;
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2(q.x / 0.052, (q.y + 0.056) / 0.014))));
  float body = sdBox(q, vec2(0.030, 0.045), 0.013);
  float lid = sdBox(q - vec2(0.0, 0.041), vec2(0.032, 0.013), 0.009);
  float pocket = sdBox(q - vec2(0.027, -0.018), vec2(0.012, 0.020), 0.007);
  float roll = sdBox(q - vec2(0.0, -0.047), vec2(0.036, 0.010), 0.009);
  if (hardFill(min(min(body, lid), min(pocket, roll)), px) < 0.5) return;
  vec3 alb = vec3(0.46, 0.31, 0.10);
  if (hardFill(roll, px) > 0.5) alb = vec3(0.20, 0.27, 0.25);
  if (hardFill(pocket, px) > 0.5) alb = vec3(0.38, 0.25, 0.08);
  if (hardFill(lid, px) > 0.5) alb = vec3(0.34, 0.22, 0.08);
  if (abs(q.x + 0.005) < 0.004 && q.y > -0.03 && q.y < 0.054) alb *= 0.55;
  float lightv = campfireLight(p, 0.9);
  float side = 0.45 + 0.55 * smoothstep(-0.035, 0.035, q.x);
  col = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.2 * lightv * side);
}

void campfireMug(vec2 p, float px, inout vec3 col) {
  vec2 q = p - vec2(0.232, 0.096);
  if (abs(q.x) > 0.03 || abs(q.y) > 0.03) return;
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2(q.x / 0.02, (q.y + 0.0125) / 0.006))));
  float body = sdBox(q, vec2(0.0108, 0.0125), 0.003);
  float handle = max(abs(length(q - vec2(0.0122, 0.0)) - 0.0068) - 0.0021, 0.008 - q.x);
  if (hardFill(min(body, handle), px) < 0.5) return;
  float lightv = campfireLight(p, 0.8);
  vec3 c = vec3(0.60, 0.58, 0.50) * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.4 * lightv * (0.5 + 0.5 * smoothstep(-0.011, 0.011, -q.x)));
  float rim = hardFill(sdEllipse(q - vec2(0.0, 0.0122), vec2(0.0100, 0.0030)), px);
  col = mix(c, vec3(0.06, 0.03, 0.02) + CAMPFIRE_WARM * 0.05 * lightv, rim);
}

// ---- the fire ----

void campfireCoals(vec2 p, float px, inout vec3 col) {
  vec2 q = p - (campfireF + vec2(0.0, 0.02));
  float k = 0.75 + 0.25 * campfireS;
  if (hardFill(sdEllipse(q, vec2(0.125, 0.036) * k), px) < 0.5) return;
  vec2 cp = p * vec2(55.0, 95.0);
  float lump = 0.6 * vnoise(cp) + 0.4 * vnoise(cp * 2.1 + 3.3);
  float phase = vnoise(p * vec2(9.0, 15.0) + 1.0) * 12.0;
  float breath = 0.5 + 0.5 * sin(campfireTm * 0.65 + phase);
  float glow = smoothstep(0.42, 0.72, lump) * (0.35 + 0.65 * breath);
  vec2 e = q / vec2(0.1, 0.03);
  float centre = exp(-dot(e, e));
  vec3 ember = mix(vec3(0.55, 0.10, 0.03), vec3(1.0, 0.45, 0.08), glow);
  vec3 ash = vec3(0.05, 0.04, 0.04) + CAMPFIRE_WARM * 0.06 * centre;
  col = mix(ash, ember, clamp(glow * (0.5 + 0.8 * centre), 0.0, 1.0));
  campfireGlow = max(campfireGlow, glow * 0.7);
}

// A log from a to b (radius ra to rb): bark furrows, lit from the fire's side, glowing cracks where it
// burns near the flames.
void campfireLog(vec2 p, vec2 a, vec2 b, float ra, float rb, float seed, float px, inout vec3 col) {
  float t;
  float d = sdTaperCapsule(p, a, b, ra, rb, t);
  if (hardFill(d, px) < 0.5) return;
  vec2 ba = b - a;
  float len = length(ba);
  vec2 axis = ba / len;
  vec2 nrm = vec2(-axis.y, axis.x);
  float across = clamp(dot(p - a, nrm) / mix(ra, rb, t), -1.0, 1.0);
  float along = t * len;
  float bark = vnoise(vec2(across * 3.2 + seed * 5.0, along * 38.0));
  vec3 alb = mix(vec3(0.085, 0.05, 0.03), vec3(0.15, 0.10, 0.065), bark);
  vec2 toFire = normalize(campfireF + vec2(0.0, 0.07) - p);
  float facing = clamp(0.55 + 0.6 * dot(nrm * across, toFire), 0.0, 1.0);
  vec3 c = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 2.8 * campfireLight(p, 0.85) * facing);
  vec2 hc = (p - (campfireF + vec2(0.0, 0.045))) / vec2(0.11, 0.05);
  float heat = exp(-dot(hc, hc));
  float crack = smoothstep(0.52, 0.72, vnoise(vec2(across * 4.0 + seed * 3.0, along * 60.0 + campfireTm * 0.02)));
  float breath = 0.55 + 0.45 * sin(campfireTm * 0.7 + seed * 4.0 + along * 25.0);
  c = c * (1.0 - 0.5 * heat) + vec3(1.0, 0.36, 0.07) * (crack * heat * breath * 1.3);
  col = c;
}

// One layer of the flame as a signed distance in the fire's own units (x across, y up): six tapered
// tongues joined smoothly, each leaning and growing on its own slow noise, the whole body warped by
// noise advected upward. wk and hk scale the layer's width and height.
float campfireTongues(vec2 q, float wk, float hk) {
  float tm = campfireTm;
  float lv = 0.55 + 0.9 * K_lively;
  float ht = clamp(q.y / CAMPFIRE_FLAME, 0.0, 1.4);
  float n1 = vnoise(vec2(q.x * 9.0 + 1.7, q.y * 6.0 - tm * 0.8)) - 0.5;
  float n2 = vnoise(vec2(q.x * 17.0 - 4.1, q.y * 10.0 - tm * 1.25)) - 0.5;
  q.x += (n1 * 0.06 + n2 * 0.022) * ht * lv;
  float d = 1e3;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float c = (fi - 2.5) * 0.4;
    float hs = hash12(vec2(fi, 4.7));
    float grow = vnoise1(tm * 0.30 + fi * 5.3, 2.0 + fi).x;
    float height = CAMPFIRE_FLAME * hk * (0.55 + 0.45 * grow * lv) * (1.0 - 0.38 * abs(c)) * (0.85 + 0.15 * hs);
    float lean = c * 0.04 + 0.05 * lv * sin(tm * 0.55 + fi * 2.1 + hs * 6.0) + K_wind * 0.08;
    vec2 a = vec2(c * 0.05 * wk, 0.0);
    vec2 b = vec2(a.x * 0.45 + lean * hk, height);
    float ra = 0.05 * wk * (1.0 - 0.3 * abs(c));
    d = campfireSmin(d, sdTaperCapsule(q, a, b, ra, 0.007 * wk), 0.032 * wk);
  }
  return d;
}

void campfireFlames(vec2 p, float px, inout vec3 col) {
  float s = campfireS;
  vec2 q = (p - (campfireF + vec2(0.0, 0.032))) / s;
  if (abs(q.x) > 0.42 || q.y < -0.06 || q.y > 0.66) return;
  float aa = px * 5.0 / s;
  float ht = clamp(q.y / CAMPFIRE_FLAME, 0.0, 1.0);
  float c0 = hardEdge(softFill(campfireTongues(q, 1.0, 1.0), aa));
  if (c0 < 0.5) return;
  float c1 = hardEdge(softFill(campfireTongues(q, 0.64, 0.74), aa));
  float c2 = hardEdge(softFill(campfireTongues(q, 0.38, 0.48), aa)) * c1;
  float c3 = hardEdge(softFill(campfireTongues(q, 0.20, 0.27), aa)) * c2;
  vec3 outer = mix(vec3(0.95, 0.26, 0.05), vec3(0.62, 0.08, 0.03), smoothstep(0.35, 1.0, ht));
  vec3 mid = mix(vec3(1.0, 0.56, 0.10), vec3(0.95, 0.34, 0.06), smoothstep(0.3, 0.9, ht));
  vec3 inner = mix(vec3(1.0, 0.84, 0.32), vec3(1.0, 0.62, 0.14), smoothstep(0.2, 0.8, ht));
  col = mix(col, outer, c0 * (0.92 - 0.45 * ht));
  col = mix(col, mid, c1 * 0.96);
  col = mix(col, inner, c2 * 0.98);
  col = mix(col, vec3(1.0, 0.96, 0.74), c3);
  campfireGlow = max(campfireGlow, max(c0 * 0.5, c1));
}

// A thin column from the flame tips: it meanders, widens and thins as it climbs, leans with the wind,
// lit warm near the fire and by the sky higher up. Cut per cell, so its edge flips each cell once.
void campfireSmoke(vec2 p, float px, inout vec3 col) {
  if (K_smoke <= 0.0) return;
  float tm = campfireTm;
  float u = p.y - campfireF.y - 0.26 * campfireS;
  if (u < 0.0) return;
  float meander = 0.020 * sin(u * 6.5 - tm * 0.42) + 0.012 * sin(u * 13.0 - tm * 0.7 + 1.3);
  float xc = campfireF.x + meander * (0.3 + 2.0 * u) + K_wind * (0.07 * u + 0.75 * u * u);
  float w = 0.012 + 0.09 * u;
  float wob = (vnoise(vec2(u * 6.0 - tm * 0.38, 7.0)) - 0.5) * w * 1.4;
  float z = (p.x - xc - wob) / w;
  if (abs(z) > 3.0) return;
  float nz = fbm3(vec2(z * 1.1 + 3.0, u * 8.0 - tm * 0.5));
  float fade = smoothstep(0.0, 0.07, u) * exp(-u * 2.4);
  float dens = exp(-1.3 * z * z) * (0.25 + 1.1 * nz) * fade * (0.55 + 0.9 * K_smoke) * 0.6;
  float cover = hardEdge(dens);
  if (cover < 0.5) return;
  float nearFire = bell(u / 0.30);
  vec3 smokeC = vec3(0.07, 0.08, 0.115) + campfireAmb * 1.4 + CAMPFIRE_WARM * (0.75 * nearFire * campfireBreath);
  col = mix(col, smokeC, 0.62);
}

// Sparks: each slot flies one slow arc (rising, swaying, leaning with the wind), winks out, and is
// re-rolled for its next flight. Few cells wide, moving about a quarter of a cell a frame.
void campfireSparks(vec2 p, float px, inout vec3 col) {
  if (K_sparks <= 0.0 || p.y < campfireF.y + 0.1 * campfireS || abs(p.x - campfireF.x) > 0.75) return;
  float tm = campfireTm;
  float s = campfireS;
  vec3 hit = vec3(0.0);
  float on = 0.0;
  for (int i = 0; i < 22; i++) {
    float fi = float(i);
    if (hash12(vec2(fi, 31.7)) > K_sparks) continue;
    float life = 5.5 + 4.0 * hash12(vec2(fi, 8.3));
    float ph = tm / life + hash12(vec2(fi, 2.9));
    float cyc = floor(ph);
    float u = ph - cyc;
    float age = u * life;
    vec2 h = hash22(vec2(fi + 0.5, cyc * 1.37 + 4.0));
    vec2 start = campfireF + vec2((h.x - 0.5) * 0.12 * s, (0.17 + 0.15 * h.y) * s);
    float vy = (0.045 + 0.04 * h.y) * (0.75 + 0.35 * s);
    float vx = (h.x - 0.5) * 0.02;
    float sway = 0.016 * sin(age * (0.7 + 0.5 * h.y) + h.x * TAU) * smoothstep(0.0, 2.0, age);
    vec2 pos = start + vec2(vx * age + sway + K_wind * 0.035 * age, vy * age);
    vec2 dd = p - pos;
    if (dot(dd, dd) > 144.0 * px * px) continue;
    float b = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.45, 0.95, u));
    b *= 0.8 + 0.2 * sin(age * 1.9 + fi * 2.3);
    float rad = px * (1.1 + 0.9 * h.y) * (0.45 + 0.55 * b);
    if (hardFill(length(dd) - rad, px * 0.7) > 0.5) {
      hit = mix(vec3(0.85, 0.18, 0.05), vec3(1.0, 0.78, 0.30), b);
      on = 1.0;
    }
  }
  col = mix(col, hit, on);
  campfireGlow = max(campfireGlow, on * 0.8);
}

// The stick rests on the bench and reaches over the fire; the marshmallow on its end slowly toasts.
void campfireStick(vec2 p, float px, inout vec3 col) {
  if (K_marshmallow < 0.5) return;
  vec2 a = vec2(0.56, 0.112);
  vec2 b = campfireF + vec2(0.052, 0.05);
  vec2 dir = normalize(b - a);
  vec2 nrm = vec2(-dir.y, dir.x);
  float t;
  float ds = sdTaperCapsule(p, a, b + dir * 0.01, 0.0046, 0.0030, t);
  vec2 mc = b - dir * 0.012;
  vec2 lp = vec2(dot(p - mc, dir), dot(p - mc, nrm));
  float dm = sdBox(lp, vec2(0.021, 0.0135), 0.0095);
  if (hardFill(dm, px) > 0.5) {
    float toast = (0.5 - 0.5 * cos(campfireTm * 0.04 + 1.2)) * 0.95;
    float hot = smoothstep(-0.8, 1.0, lp.y / 0.0135);
    float tl = toast * (0.5 + 0.8 * hot);
    vec3 alb = mix(vec3(0.92, 0.86, 0.72), vec3(0.80, 0.50, 0.16), smoothstep(0.1, 0.55, tl));
    alb = mix(alb, vec3(0.26, 0.13, 0.06), smoothstep(0.7, 1.0, tl));
    float lightv = campfireLight(p, 0.9);
    col = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 2.2 * lightv * (0.5 + 0.5 * hot));
  } else if (hardFill(ds, px) > 0.5) {
    float lightv = campfireLight(p, 0.9);
    col = vec3(0.17, 0.11, 0.06) * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.0 * lightv);
  }
}

// The log bench across the near right: a squared log with its cut end toward the fire, bark furrows,
// and (with the knob) the Manifold M carved into its side, the grooves glowing like coals.
void campfireBench(vec2 p, float px, inout vec3 col) {
  float x0 = 0.30;
  float x1 = campfireHalf + 0.2;
  vec2 c = vec2(0.5 * (x0 + x1), 0.072);
  vec2 hs = vec2(0.5 * (x1 - x0), 0.045);
  if (p.y > 0.13 || p.x < x0 - 0.04) return;
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2((p.x - c.x) / (hs.x * 1.04), (p.y - 0.028) / 0.022))));
  float d = sdBox(p - c, hs, 0.028);
  if (hardFill(d, px) < 0.5) return;
  float yy = (p.y - c.y) / hs.y;
  float bark = vnoise(vec2(p.x * 7.0, p.y * 42.0));
  vec3 alb = mix(vec3(0.085, 0.05, 0.03), vec3(0.16, 0.105, 0.065), bark);
  alb *= 1.0 + 0.5 * smoothstep(0.75, 0.95, yy);
  float lightv = campfireLight(p, 0.75);
  float facing = 0.35 + 0.65 * smoothstep(-0.8, 0.9, yy);
  vec3 c0 = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.0 * lightv * facing);
  // The cut end, rings and all, catching the firelight.
  vec2 e = (p - vec2(x0 + 0.002, c.y)) / vec2(0.016, 0.043);
  float cap = hardFill((length(e) - 1.0) * 0.016, px);
  float ring = 0.5 + 0.5 * sin(length(e) * 16.0 + 1.3);
  vec3 wood = mix(vec3(0.32, 0.20, 0.11), vec3(0.45, 0.30, 0.17), ring);
  c0 = mix(c0, wood * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.6 * lightv), cap);
  if (K_mark > 0.0) {
    float size = 0.066;
    float xm = 0.5 * (x0 + campfireHalf) + 0.03;
    float dm = markDistance((p - vec2(xm, 0.073)) / size) * size;
    float g = min(K_mark, 1.4);
    float pulse = 0.78 + 0.22 * sin(campfireTm * 0.8 + p.x * 6.0);
    float groove = hardFill(dm - 0.0042, px);
    float halo = hardEdge(0.45 * bell(dm / 0.011) * min(g, 1.0));
    c0 += vec3(1.0, 0.4, 0.1) * 0.35 * g * halo;
    c0 = mix(c0, vec3(1.0, 0.44, 0.10) * (0.55 + 0.6 * g * pulse), groove);
    campfireGlow = max(campfireGlow, groove * min(g, 1.0));
  }
  col = c0;
}

Shade sceneCampfire(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  campfireSetup(aspect);
  float px = 1.0 / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  vec3 dir = viewRay(uv, aspect, CAMPFIRE_HORIZON, CAMPFIRE_FOV);
  float tm = campfireTm;

  // The sky: stars, the Milky Way, the planet, a shooting star.
  vec3 col = campfireSkyAt(dir);
  col = campfirePlanetOver(col, p, px);
  col = campfireMeteors(col, p, px);

  // Far and middle pines in the haze, a little parallax with the pointer.
  vec3 haze = horizonHaze(campfireSkyState, dir, 0.01);
  vec2 pf = p + vec2(uPointer.x * 0.006, 0.0);
  vec2 pm = p + vec2(uPointer.x * 0.012, 0.0);
  float dFar = min(campfireRow(pf, 0.105, 0.27, 0.15, 0.27, 0.045, 3.0, 0.0), p.y - 0.30);
  col = mix(col, campfireTreeTone(0.55, haze), hardFill(dFar, px * 1.2));
  float dMid = campfireRow(pm, 0.165, 0.25, 0.17, 0.36, 0.07, 17.0, 0.0);
  col = mix(col, campfireTreeTone(0.2, haze), hardFill(dMid, px * 1.2));
  if (K_fog > 0.0) {
    float mist = K_fog * 0.5 * bell((p.y - 0.31) / 0.12) * (0.6 + 0.8 * fbm3(vec2(p.x * 3.0 - tm * 0.01 * (0.3 + K_wind), p.y * 9.0)));
    col = mix(col, haze * 0.9 + campfireAmb * 0.6, hardEdge(mist));
  }

  // The clearing.
  float top = campfireGroundTop(p.x);
  if (p.y < top + 0.01 && hardFill(p.y - top, px * 1.5) > 0.5) col = campfireGround(p);

  // Two big pines frame the view, swaying a little.
  float lean = 0.004 + 0.006 * abs(K_wind);
  float dNear = min(
    campfireTree(p, -0.90 * campfireHalf, 0.12, 1.05, 0.17, 7.0, lean * sin(tm * 0.31)),
    campfireTree(p, 0.84 * campfireHalf, 0.10, 0.95, 0.15, 6.0, -lean * sin(tm * 0.27 + 1.0)));
  col = mix(col, campfireTreeTone(0.0, haze), hardFill(dNear, px * 1.2));

  // The camp, the far half of the ring, the coals and the back log, then the flames and the smoke.
  campfireTent(p, px, col);
  campfirePack(p, px, col);
  campfireStones(p, px, false, col);
  campfireCoals(p, px, col);
  campfireLog(p, campfireF + vec2(-0.125, 0.036), campfireF + vec2(0.115, 0.056), 0.0155, 0.0145, 1.0, px, col);
  campfireFlames(p, px, col);
  campfireSmoke(p, px, col);

  // The two front logs crossed over the flames' foot, the near stones, the mug, the stick, the bench.
  campfireLog(p, campfireF + vec2(-0.135, -0.014), campfireF + vec2(0.03, 0.052), 0.0175, 0.0145, 2.0, px, col);
  campfireLog(p, campfireF + vec2(0.145, -0.010), campfireF + vec2(-0.02, 0.05), 0.0165, 0.0140, 3.0, px, col);
  campfireStones(p, px, true, col);
  campfireMug(p, px, col);
  campfireStick(p, px, col);
  campfireBench(p, px, col);
  campfireSparks(p, px, col);

  // A soft vignette keeps the eye by the fire.
  col *= 1.0 - 0.35 * smoothstep(0.6, 1.4, length((uv - 0.5) * vec2(aspect, 1.0) * 1.2));

  Shade o = blankShade();
  o.ink = inkOf(col, 1.5, 0.8);
  o.accent = clamp(campfireGlow, 0.0, 1.0);
  o.rgb = col;
  o.source = col;
  return o;
}
`;
