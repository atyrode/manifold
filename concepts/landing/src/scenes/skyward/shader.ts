// Skyward: the view from the middle of a crossroads, lying on your back. Everything is analytic.
//
// The street. The avenue runs along z between two rows of facades on the planes x = +-A, the cross
// street along x between facades on z = +-B; the four corner blocks stand in the corners, each with
// two faces (face ids 0..3 the avenue faces, 4..7 the cross street's). A face is a row of lots along
// u (the distance from the corner), each with its own roof height and kind: glass tower, stone,
// brick or concrete. A view ray meets at most one plane of each axis, so the wall hit is two lot
// lookups; the same trace answers the sun's shadow and what a glass panel reflects.
//
// The camera lies at the crossing looking steeply up (SKYWARD_PITCH off the zenith toward the feet),
// turned SKYWARD_YAW about the vertical so the streets run diagonally across the frame. The shared
// sky lives in the same world, turned SKYWARD_SKY_YAW so the sun's noon path runs down the avenue.
//
// Overhead, nearest to farthest: a signal gantry and two street lamps, the tram wires and the spans
// that hold them, trams on their tracks (felt more than seen), the street tree's canopy, the banner
// (opt-in M), the birds, then the plane and its contrail beyond the clouds.
//
// Knobs (index.ts): K_towers, K_windows, K_greenery, K_traffic, K_citySeed (city); K_time, K_cycle,
// K_stars (sky); K_birds, K_planes (air); K_clouds, K_rain, K_snow, K_fog, K_wind (weather); K_mark.

/** Seconds of the entrance (the view tips back from street level to the zenith) and the exit (it tips down toward the street again) (SceneDef.passage). */
export const SKYWARD_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

export const skywardGlsl = `
// ---- The frame ----
const float SKYWARD_A = 11.0;        // the avenue's walls stand at x = +-A
const float SKYWARD_B = 9.0;         // the cross street's at z = +-B
const vec3 SKYWARD_RO = vec3(0.0, 0.2, 0.0);
const float SKYWARD_FOCAL = 0.5367;  // 0.5 / tan(fov / 2), fov 1.5 rad
const float SKYWARD_YAW = 0.55;
const float SKYWARD_PITCH = 0.28;
const float SKYWARD_STREET = 1.05;   // the pitch the entrance starts at and the exit ends at: the street a sliver at the foot of the frame
const float SKYWARD_WALK = 3.0;      // the sidewalks' width along the facades, m
const float SKYWARD_SKY_YAW = -3.19;
const float SKYWARD_LOT = 26.0;
const float SKYWARD_FAR = 100000.0;
const float SKYWARD_HP = 10500.0;    // airliners' altitude, m
const float SKYWARD_PLANE_V = 140.0; // m/s
const float SKYWARD_PLANE_T = 260.0; // s per flight
const float SKYWARD_RAIL = 5.2;      // the tram tracks at x = +-RAIL
const float SKYWARD_SAIL_Y = 17.0;
const vec4 SKYWARD_TREE[3] = vec4[3](vec4(9.0, 10.8, -17.0, 5.4), vec4(7.2, 9.6, -21.5, 4.4), vec4(9.8, 12.6, -20.0, 3.8));

Sky skywardSky;
vec3 skywardR;
vec3 skywardU;
vec3 skywardF;
float skywardPx;       // radians per cell
float skywardTm;       // the motion clock
float skywardT;        // the scene clock
float skywardSeedOff;
float skywardThB;      // two more cell thresholds, decorrelated from cellTh
float skywardThC;
float skywardStorm;
float skywardOver;
float skywardCover;
float skywardDark;
float skywardWet;
float skywardLying;
vec3 skywardAmbient;
vec3 skywardSunLight;
vec3 skywardDeck;

// ---- The sky ----

// Sky colour with the city's glow on the air and the stars, before the clouds.
vec3 skywardSkyBase(vec3 dir) {
  vec3 c = skyColor(skywardSky, dir);
  c = mix(c, skywardDeck, skywardOver * 0.9);
  float glow = skywardSky.night * (0.35 + 0.65 * (1.0 - clamp(dir.y, 0.0, 1.0)));
  c += mix(vec3(0.3, 0.14, 0.07), vec3(0.15, 0.07, 0.19), clamp(dir.y, 0.0, 1.0)) * glow * 0.6 * (1.0 + 1.5 * skywardOver);
  c += skyStarLight(skywardSky, dir, K_stars) * (1.0 - skywardOver);
  return c;
}

// The cloud deck over c. The deck is scaled up so a few cloud bodies fit the strip of sky.
vec3 skywardCloudsOver(vec3 dir, vec3 c) {
  if (skywardCover <= 0.0) return c;
  vec3 cd = normalize(vec3(dir.x * 1.9, dir.y, dir.z * 1.9));
  vec4 cl = skyClouds(skywardSky, cd, skywardT, skywardCover, K_wind);
  vec3 rgb = cl.rgb + vec3(0.16, 0.08, 0.04) * skywardSky.night * 0.45;
  return mix(c, rgb, cl.a);
}

// Airliners far overhead on the plane of their cruising altitude, and the trails they leave: three
// flight slots, each a pass across the sky over SKYWARD_PLANE_T seconds, the previous flight's
// contrail still spreading and fading. Contrail cover is cut per cell (stipple), never a soft edge.
vec3 skywardPlanes(vec3 rd, vec3 col) {
  if (K_planes <= 0.0 || rd.y < 0.15) return col;
  vec2 X = rd.xz * (SKYWARD_HP / rd.y);
  float foot = skywardPx * SKYWARD_HP / (rd.y * max(rd.y, 0.5));
  float lit = smoothstep(-0.12, 0.08, skywardSky.sun.y);
  vec3 trailCol = mix(skywardAmbient * 0.7 + 0.03, vec3(1.0, 0.93, 0.86), lit);
  trailCol = mix(trailCol, vec3(1.0, 0.62, 0.42), skywardSky.twilight * 0.7 * lit);
  trailCol *= 1.0 - 0.3 * skywardOver;
  vec3 bodyCol = mix(vec3(0.05, 0.05, 0.07), vec3(0.78, 0.8, 0.84), lit);
  for (int k = 0; k < 3; k++) {
    if (float(k) + 0.01 >= K_planes * 3.0) break;
    for (int j = 0; j < 2; j++) {
      float cyc = (skywardTm + float(k) * 91.0) / SKYWARD_PLANE_T;
      float n = floor(cyc) - float(j);
      float tau = (cyc - floor(cyc) + float(j)) * SKYWARD_PLANE_T; // seconds into flight n
      float seed = hash12(vec2(n * 1.31 + float(k) * 17.0, 3.3 + skywardSeedOff));
      float ang = seed * TAU;
      vec2 dv = vec2(cos(ang), sin(ang));
      vec2 pv = vec2(-dv.y, dv.x);
      float off = (fract(seed * 7.77) - 0.5) * 9000.0;
      vec2 head = pv * off + dv * ((tau - 0.5 * SKYWARD_PLANE_T) * SKYWARD_PLANE_V);
      vec2 rel = X - head;
      float a = dot(rel, dv);
      float b = dot(rel, pv);
      if (a < 0.0 && a > -SKYWARD_PLANE_V * 150.0) {
        float age = -a / SKYWARD_PLANE_V;
        if (age <= tau && tau - age <= SKYWARD_PLANE_T) {
          float wHalf = 0.5 * (24.0 + 3.2 * age);
          float wEff = max(wHalf, 1.1 * foot);
          float u = b / wEff;
          float life = exp(-age / 65.0) * (1.0 - smoothstep(110.0, 150.0, age)) * smoothstep(0.0, 2.5, age);
          float puff = 0.72 + 0.5 * vnoise(vec2(a * 0.0007 + seed * 40.0, b * 0.0016));
          float dens = exp(-u * u) * life * puff * (wHalf / wEff) * 0.95;
          col = mix(col, trailCol, hardEdge(dens, skywardThB));
        }
      }
      if (j == 0 && tau < SKYWARD_PLANE_T) {
        vec2 q = vec2(a, abs(b));
        float d = sdTaperCapsule(q, vec2(72.0, 0.0), vec2(-72.0, 0.0), 7.5, 5.0);
        d = min(d, sdTaperCapsule(q, vec2(10.0, 4.0), vec2(-40.0, 76.0), 7.0, 2.5));
        d = min(d, sdTaperCapsule(q, vec2(-62.0, 3.0), vec2(-84.0, 28.0), 4.0, 2.0));
        float alpha = smoothstep(0.0, 14.0, tau) * (1.0 - smoothstep(SKYWARD_PLANE_T - 14.0, SKYWARD_PLANE_T, tau));
        float cov = hardFill(d, 0.7 * foot) * hardEdge(alpha, skywardThC);
        if (cov > 0.0) {
          col = mix(col, bodyCol, cov);
          float beat = step(0.84, fract(skywardTm * 0.65 + seed * 9.0)) * skywardSky.night;
          float bl = hardFill(length(q) - 22.0, 0.7 * foot) * beat;
          col = mix(col, vec3(1.0, 0.16, 0.1), bl);
        }
      }
    }
  }
  return col;
}

// The sky for a direction: base, planes, clouds. Reflections use skywardSkyLight (no planes).
vec3 skywardSkyLight(vec3 dir) {
  return skywardCloudsOver(dir, skywardSkyBase(dir));
}

vec3 skywardSkyDirect(vec3 rd) {
  return skywardCloudsOver(rd, skywardPlanes(rd, skywardSkyBase(rd)));
}

// ---- Lots ----

struct SkywardLot {
  float h;       // roof height of the main block (m)
  float kind;    // 0 glass tower, 1 stone, 2 brick, 3 concrete
  float seed;
  float u0;
  float u1;
  float variant; // 0..1, for tones and proportions
};

float skywardEdge(float fid, float k) {
  return (k + (hash12(vec2(k * 1.37 + 5.0, fid * 7.1 + skywardSeedOff)) - 0.5) * 0.4) * SKYWARD_LOT;
}

float skywardLotIndex(float fid, float u) {
  float k = floor(u / SKYWARD_LOT);
  if (u < skywardEdge(fid, k)) return k - 1.0;
  if (u >= skywardEdge(fid, k + 1.0)) return k + 1.0;
  return k;
}

SkywardLot skywardLot(float fid, float u) {
  float k = skywardLotIndex(fid, u);
  SkywardLot l;
  l.seed = hash12(vec2(k * 3.17 + 1.3, fid * 5.3 + 2.7 + skywardSeedOff));
  float a = fract(l.seed * 41.3);
  float b = fract(l.seed * 97.1);
  float c = fract(l.seed * 173.7);
  l.u0 = skywardEdge(fid, k);
  l.u1 = skywardEdge(fid, k + 1.0);
  l.variant = b;
  // Each face stands at its own height, its buildings within 20-40% of it: no needles.
  float base = 30.0 + 6.0 * hash12(vec2(fid * 3.7 + 1.0, skywardSeedOff + 9.0));
  float corner = k < 1.0 ? 0.9 : 1.0; // the lots at the crossing stay a little lower
  if (a < K_towers * 0.85) {
    l.kind = 0.0;
    l.h = base * (1.15 + 0.35 * b) * corner;
  } else if (c < 0.5) {
    l.kind = 1.0;
    l.h = base * (0.8 + 0.3 * b) * corner;
  } else if (c < 0.8) {
    l.kind = 2.0;
    l.h = base * (0.85 + 0.3 * b) * corner;
  } else {
    l.kind = 3.0;
    l.h = base * (0.95 + 0.3 * b) * corner;
  }
  return l;
}

// The roofline: a clean flat edge, so lots read as solid massing against the sky.
float skywardRoof(SkywardLot l, float u) {
  return l.h;
}

struct SkywardHit {
  float t;
  float fid;
  float u;
  float y;
  vec3 n;      // pointing out of the wall, into the street
  vec3 p;
  bool hit;
  SkywardLot lot;
};

// The first facade a ray meets from ro (inside the canyon): at most one plane of each axis.
SkywardHit skywardTrace(vec3 ro, vec3 rd) {
  SkywardHit h;
  h.t = SKYWARD_FAR;
  h.fid = 0.0;
  h.u = 0.0;
  h.y = 0.0;
  h.n = vec3(0.0, -1.0, 0.0);
  h.p = vec3(0.0);
  h.hit = false;
  h.lot = SkywardLot(0.0, 0.0, 0.0, 0.0, 1.0, 0.0);
  if (abs(rd.x) > 1e-4) {
    float sx = rd.x > 0.0 ? 1.0 : -1.0;
    float t = (sx * SKYWARD_A - ro.x) / rd.x;
    if (t > 1e-3) {
      vec3 p = ro + rd * t;
      if (abs(p.z) > SKYWARD_B) {
        float sz = p.z > 0.0 ? 1.0 : -1.0;
        float fid = (sx > 0.0 ? 1.0 : 0.0) + (sz > 0.0 ? 2.0 : 0.0);
        float u = abs(p.z) - SKYWARD_B;
        SkywardLot l = skywardLot(fid, u);
        if (p.y < skywardRoof(l, u)) {
          h.t = t;
          h.fid = fid;
          h.u = u;
          h.y = p.y;
          h.n = vec3(-sx, 0.0, 0.0);
          h.p = p;
          h.hit = true;
          h.lot = l;
        }
      }
    }
  }
  if (abs(rd.z) > 1e-4) {
    float sz = rd.z > 0.0 ? 1.0 : -1.0;
    float t = (sz * SKYWARD_B - ro.z) / rd.z;
    if (t > 1e-3 && t < h.t) {
      vec3 p = ro + rd * t;
      if (abs(p.x) > SKYWARD_A) {
        float sx = p.x > 0.0 ? 1.0 : -1.0;
        float fid = 4.0 + (sx > 0.0 ? 1.0 : 0.0) + (sz > 0.0 ? 2.0 : 0.0);
        float u = abs(p.x) - SKYWARD_A;
        SkywardLot l = skywardLot(fid, u);
        if (p.y < skywardRoof(l, u)) {
          h.t = t;
          h.fid = fid;
          h.u = u;
          h.y = p.y;
          h.n = vec3(0.0, 0.0, -sz);
          h.p = p;
          h.hit = true;
          h.lot = l;
        }
      }
    }
  }
  return h;
}

// Metres one cell spans along the wall (x) and up it (y) at the hit.
vec2 skywardFoot(SkywardHit h, vec3 rd) {
  bool xf = h.fid < 3.5;
  float rc = xf ? rd.x : rd.z;
  rc = (rc < 0.0 ? -1.0 : 1.0) * max(abs(rc), 1e-3);
  vec3 dR = skywardR - rd * ((xf ? skywardR.x : skywardR.z) / rc);
  vec3 dU = skywardU - rd * ((xf ? skywardU.x : skywardU.z) / rc);
  float k = skywardPx * h.t;
  float fu = k * (abs(xf ? dR.z : dR.x) + abs(xf ? dU.z : dU.x));
  float fy = k * (abs(dR.y) + abs(dU.y));
  return max(vec2(fu, fy), vec2(0.02));
}

// ---- Palettes ----

vec3 skywardStoneTone(float v) {
  if (v < 0.25) return vec3(0.74, 0.64, 0.5);
  if (v < 0.5) return vec3(0.8, 0.72, 0.58);
  if (v < 0.75) return vec3(0.7, 0.54, 0.44);
  return vec3(0.64, 0.62, 0.57);
}

vec3 skywardBrickTone(float v) {
  if (v < 0.33) return vec3(0.54, 0.27, 0.2);
  if (v < 0.66) return vec3(0.46, 0.23, 0.18);
  return vec3(0.6, 0.38, 0.27);
}

vec3 skywardConcreteTone(float v) {
  if (v < 0.33) return vec3(0.62, 0.62, 0.6);
  if (v < 0.66) return vec3(0.72, 0.7, 0.66);
  return vec3(0.5, 0.52, 0.54);
}

vec3 skywardGlassTint(float v) {
  if (v < 0.34) return vec3(0.6, 0.88, 0.96);
  if (v < 0.67) return vec3(0.74, 0.84, 1.0);
  return vec3(0.94, 0.88, 0.72);
}

// ---- Light on a facade ----

// 1 where the sun reaches the wall point past the opposite row of buildings.
float skywardSunLit(SkywardHit h) {
  vec3 s = skywardSky.sun;
  if (dot(h.n, s) <= 0.02 || dot(skywardSky.sunColor, vec3(1.0)) <= 0.01) return 0.0;
  SkywardHit blocked = skywardTrace(h.p + h.n * 0.05, s);
  return blocked.hit ? 0.0 : 1.0;
}

vec3 skywardLight(vec3 n, float y, float sunLit) {
  float ao = mix(0.55, 1.0, smoothstep(2.0, 45.0, y));
  vec3 e = skywardAmbient * ao;
  e += skywardSunLight * max(dot(n, skywardSky.sun), 0.0) * sunLit;
  // The street's own lamps and shopfronts lighting the lower floors, warm, brighter under cloud.
  e += vec3(1.0, 0.58, 0.26) * 0.42 * skywardDark * (0.25 + 0.75 * exp(-y / 24.0)) * (0.7 + 0.6 * skywardOver);
  return e;
}

// What a glass panel sees when its reflection meets another building: its tone, roughly lit.
vec3 skywardCheap(SkywardHit r) {
  float k = r.lot.kind;
  vec3 tone = k < 0.5 ? vec3(0.22, 0.34, 0.42) : k < 1.5 ? skywardStoneTone(r.lot.variant) : k < 2.5 ? skywardBrickTone(r.lot.variant) : skywardConcreteTone(r.lot.variant);
  float lit = max(dot(r.n, skywardSky.sun), 0.0);
  float bands = 0.75 + 0.25 * smoothstep(0.3, 0.7, fract(r.y / 3.6));
  float ao = mix(0.5, 1.0, smoothstep(2.0, 45.0, r.y));
  vec3 e = skywardAmbient * ao + skywardSunLight * lit * 0.8;
  float win = step(0.8, hash12(floor(vec2(r.u / 3.0, r.y / 3.6)) + r.lot.seed * 13.0));
  return tone * e * bands + vec3(1.0, 0.7, 0.4) * 0.12 * skywardDark * win;
}

// ---- Traffic below: light and shade sliding along the lower floors ----

// x: light (headlights at dusk, windscreen glints by day), y: shade; both 0..1 before the knob.
vec2 skywardTraffic(SkywardHit h) {
  if (K_traffic <= 0.0 || h.y > 18.0) return vec2(0.0);
  bool xf = h.fid < 3.5;
  float f = xf ? h.fid : h.fid - 4.0;
  float sgn = xf ? (f > 1.5 ? 1.0 : -1.0) : (mod(f, 2.0) > 0.5 ? 1.0 : -1.0);
  float c = sgn * (h.u + (xf ? SKYWARD_B : SKYWARD_A));
  float hy = smoothfall(16.0, 6.0, h.y);
  float shade = 0.0;
  float light = 0.0;
  for (int j = 0; j < 3; j++) {
    float v = j == 0 ? 3.3 : j == 1 ? -4.4 : 5.3;
    float s = mod(float(j) * 61.0 + (xf ? 0.0 : 37.0) + v * skywardTm + 80.0, 160.0) - 80.0;
    float w = j == 0 ? 7.5 : 3.6;
    float q = (c - s) / w;
    float g = exp(-q * q);
    if (j == 0) shade = g; else light = max(light, g);
  }
  return vec2(min(light * hy * K_traffic * 1.8, 1.0), min(shade * hy * K_traffic * 1.3, 1.0));
}

// Rain running down glass: streaks of water that catch the sky, slowly sliding.
float skywardStreaks(float x, float y, vec2 fp) {
  if (skywardWet <= 0.05) return 0.0;
  float k = 2.2;
  float fade = 1.0 - smoothstep(0.12, 0.3, fp.x * k);
  float fld = vnoise(vec2(x * k, (y + 0.9 * skywardTm) * 0.2));
  return smoothstep(0.62, 0.8, fld) * skywardWet * fade;
}

// ---- Facade patterns ----

// Coverage of the band [lo, hi] (fractions of a pitch) in a pattern repeating every pitch metres;
// f metres per cell. Pitches under ~4 cells fade to the band's mean.
float skywardCover1(float x, float pitch, float lo, float hi, float f) {
  float fr = fract(x / pitch);
  float aa = max(0.5 * f / pitch, 1e-3);
  float cov = smoothstep(lo - aa, lo + aa, fr) - smoothstep(hi - aa, hi + aa, fr);
  return mix(cov, hi - lo, smoothstep(0.1, 0.28, aa));
}

// Brick, stone or concrete: window grid, string courses, balconies seen from below, window boxes.
// slope: how much wall height one metre of depth in front of it hides (the ray's steepness).
vec3 skywardMasonry(SkywardHit h, vec2 fp, float slope, vec3 tone, vec3 E, vec3 Eu, float sh, float wb, float winW, float winLo, float winHi, float balOdds) {
  SkywardLot l = h.lot;
  float x = h.u - l.u0;
  float y = h.y;
  float fi = floor(y / sh);
  float ly = y - fi * sh;
  float bi = floor(x / wb);
  float above = step(l.h, y);
  float wx = skywardCover1(x, wb, 0.5 - 0.5 * winW, 0.5 + 0.5 * winW, fp.x);
  float wy = skywardCover1(y, sh, winLo, winHi, fp.y);
  float win = wx * wy * (1.0 - above) * (1.0 - smoothstep(l.h - 2.2, l.h - 1.6, y));

  vec3 wallAlb = wetten(tone * (0.9 + 0.2 * vnoise(vec2(x * 0.7, y * 0.5) + l.seed * 31.0)), skywardWet, 0.3);
  wallAlb *= 1.0 + 0.18 * (1.0 - smoothstep(0.0, 0.3 + fp.y, ly));          // a string course at every floor
  float cornice = smoothstep(l.h - 1.0, l.h - 0.8, y);
  wallAlb = mix(wallAlb, tone * 1.15, cornice * (1.0 - above));
  wallAlb *= 1.0 - 0.2 * smoothstep(l.h - 2.4, l.h - 1.1, y) * (1.0 - cornice);
  wallAlb = mix(wallAlb, vec3(0.34, 0.2, 0.16), above);
  vec3 col = wallAlb * E;

  // The window: dark glass holding a little of the sky, or a light left on.
  float litP = clamp(K_windows * (0.08 + 1.5 * skywardDark), 0.0, 0.95);
  float hw = hash12(vec2(bi * 1.7 + l.seed * 91.0, fi * 3.3 + 1.0));
  float v = hw / max(litP, 1e-3);
  vec3 warm = v < 0.75 ? vec3(1.0, 0.7, 0.38) : v < 0.9 ? vec3(0.75, 0.88, 1.0) : vec3(1.0, 0.9, 0.6);
  warm *= 0.7 + 0.5 * fract(v * 13.0);
  float refl = 0.2 + 0.6 * smoothstep(4.0, 50.0, y) + 0.3 * wetGloss(skywardWet, 0.0);
  vec3 glassCol = vec3(0.03, 0.045, 0.07) + skywardAmbient * 0.45 * refl;
  vec3 winCol = hw < litP ? warm : glassCol;

  // Balconies: from below one sees the slab's underside, then the rail with its window boxes.
  float cb = 0.0;
  float zoneA = 0.0;
  float zoneB = 0.0;
  float plant = 0.0;
  float flower = 0.0;
  vec3 leaf = vec3(0.0);
  if (balOdds > 0.0) {
    float g = floor(x / (2.0 * wb));
    float present = hash12(vec2(g * 2.7 + l.seed * 57.0, fi * 5.1 + 3.0)) < balOdds ? 1.0 : 0.0;
    present *= step(1.0, fi) * (1.0 - above);
    cb = present * skywardCover1(x, 2.0 * wb, 0.06, 0.94, fp.x);
    float dS = min(1.05 * slope, 0.8 * sh);
    float aa = 0.5 * fp.y + 0.05;
    zoneA = 1.0 - smoothstep(dS - aa, dS + aa, ly);
    zoneB = smoothstep(dS - aa, dS + aa, ly) * (1.0 - smoothstep(dS + 0.95 - aa, dS + 0.95 + aa, ly));
    float grown = hash12(vec2(g * 4.3 + l.seed * 71.0, fi * 2.9 + 7.0)) < K_greenery ? 1.0 : 0.0;
    float height = clamp((ly - dS) / 0.95, 0.0, 1.0);
    float ln = mix(vnoise(vec2(x * 2.6, ly * 3.4) + l.seed * 17.0), 0.5, smoothstep(0.15, 0.4, fp.x * 2.6));
    plant = zoneB * grown * smoothstep(0.3, 0.55, 0.9 * ln + 0.55 * (1.0 - height));
    vec2 fc = floor(vec2(x * 4.0, ly * 5.0));
    flower = step(0.84, hash12(fc + l.seed * 7.0)) * (1.0 - smoothstep(0.1, 0.2, fp.x)) * step(0.45, height);
    vec3 green = mix(vec3(0.07, 0.19, 0.06), vec3(0.3, 0.48, 0.12), fract(ln * 4.0 + 0.2));
    vec3 bloom = hash12(fc + 3.0) < 0.5 ? vec3(0.9, 0.28, 0.32) : vec3(0.95, 0.75, 0.3);
    leaf = mix(green, bloom, flower) * (E + skywardSunLight * 0.35 * max(dot(skywardSky.sun, vec3(0.0, 1.0, 0.0)) + 0.5, 0.0)) + vec3(1.0, 0.6, 0.3) * 0.04 * skywardDark;
  }
  float hidden = cb * max(zoneA, 0.75 * zoneB);
  col = mix(col, winCol, win * (1.0 - hidden));
  col = mix(col, vec3(0.3, 0.27, 0.25) * Eu, cb * zoneA);
  col = mix(col, vec3(0.09, 0.09, 0.1) * E, cb * zoneB * 0.5);
  col = mix(col, leaf, cb * plant);

  // Snow keeps to the sills, the cornice and the roof's edge.
  if (skywardLying > 0.0) {
    float sill = wx * skywardCover1(y, sh, winLo - 0.07, winLo, fp.y);
    float rim = smoothstep(l.h - 1.2, l.h - 0.6, y) * (1.0 - above);
    float sn = max(sill, rim) * snowCover(vec3(0.0, 1.0, 0.0), vec2(x, y), skywardLying);
    col = mix(col, vec3(0.8, 0.85, 0.92) * (E * 0.9 + 0.05), sn);
  }
  return col;
}

// A curtain wall: panels of tinted glass mirroring the sky, the clouds, the opposite roofline and,
// where the angle is right, the sun; spandrel bands between floors; offices lit at night.
vec3 skywardGlassTower(SkywardHit h, vec3 rd, vec2 fp, vec3 E) {
  SkywardLot l = h.lot;
  float x = h.u - l.u0;
  float y = h.y;
  float sh = 3.9;
  float pw = mix(1.35, 1.8, fract(l.variant * 3.7));
  float fi = floor(y / sh);
  float bi = floor(x / pw);
  vec3 tint = skywardGlassTint(fract(l.seed * 29.0));
  float vx = skywardCover1(x, pw, 0.03, 0.97, fp.x);
  float vy = skywardCover1(y, sh, 0.28, 0.97, fp.y);

  // Each panel sits a hair off true, so the reflection breaks up panel by panel.
  vec2 jit = (hash22(vec2(bi, fi) + l.seed * 13.0) - 0.5) * 0.06;
  vec3 uaxis = h.fid < 3.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 nn = normalize(h.n + uaxis * jit.x + vec3(0.0, 1.0, 0.0) * jit.y);
  vec3 refl = reflect(rd, nn);
  SkywardHit rh = skywardTrace(h.p, refl);
  vec3 seen;
  if (rh.hit) {
    seen = skywardCheap(rh);
  } else {
    seen = skywardSkyLight(refl);
    vec3 dv = refl - skywardSky.sun;
    seen += skywardSky.sunColor * exp(-0.5 * dot(dv, dv) * 55.0) * 1.6;
  }
  float gloss = 0.8 + 0.2 * wetGloss(skywardWet, 0.0);
  vec3 glassCol = seen * tint * 0.9 * gloss + vec3(0.012, 0.02, 0.03);
  vec3 spandrelCol = tint * 0.22 * E + seen * tint * 0.3;
  vec3 frameCol = vec3(0.26, 0.28, 0.3) * E;

  // Offices lit in blocks of panels, cool white.
  float litP = clamp(K_windows * (0.06 + 1.4 * skywardDark), 0.0, 0.95);
  float block = hash12(vec2(floor(bi / 3.0) * 2.1 + l.seed * 83.0, fi * 1.9 + 5.0));
  vec3 office = vec3(0.88, 0.94, 1.0) * (0.55 + 0.4 * fract(block * 37.0));
  glassCol = block < litP ? mix(glassCol, office, 0.9) : glassCol;

  float streak = skywardStreaks(x, y, fp);
  glassCol = mix(glassCol, glassCol + seen * 0.3, hardEdge(streak * 0.8));

  vec3 col = frameCol * (1.0 - vx) + vx * (spandrelCol * (1.0 - vy) + glassCol * vy);
  float cornice = smoothstep(l.h - 0.7, l.h - 0.4, y);
  col = mix(col, frameCol * 1.2, cornice * (1.0 - step(l.h, y)));
  col = mix(col, vec3(0.2, 0.22, 0.25) * E, step(l.h, y));  // the crown's plant room
  if (skywardLying > 0.0) {
    float rim = smoothstep(l.h - 0.9, l.h - 0.4, y) * (1.0 - step(l.h, y));
    col = mix(col, vec3(0.82, 0.86, 0.93) * (E * 0.9 + 0.05), rim * snowCover(vec3(0.0, 1.0, 0.0), vec2(x, y), skywardLying));
  }
  return col;
}

vec3 skywardFacade(SkywardHit h, vec3 rd) {
  vec2 fp = skywardFoot(h, rd);
  float slope = rd.y / max(abs(dot(rd, h.n)), 0.05);
  float sunLit = skywardSunLit(h);
  vec3 E = skywardLight(h.n, h.y, sunLit);
  vec3 Eu = skywardAmbient * 0.35 + vec3(1.0, 0.6, 0.3) * 0.3 * skywardDark * (0.25 + 0.75 * exp(-h.y / 24.0));
  float k = h.lot.kind;
  vec3 col;
  if (k < 0.5) {
    col = skywardGlassTower(h, rd, fp, E);
  } else if (k < 1.5) {
    col = skywardMasonry(h, fp, slope, skywardStoneTone(h.lot.variant), E, Eu, mix(3.3, 3.9, h.lot.variant), mix(2.8, 3.4, fract(h.lot.variant * 5.3)), 0.4, 0.26, 0.84, 0.5);
  } else if (k < 2.5) {
    col = skywardMasonry(h, fp, slope, skywardBrickTone(h.lot.variant), E, Eu, 3.2, 2.5, 0.42, 0.25, 0.8, 0.18);
  } else {
    col = skywardMasonry(h, fp, slope, skywardConcreteTone(h.lot.variant), E, Eu, 3.6, 6.0, 0.9, 0.35, 0.78, 0.0);
  }
  // The road below, felt: shade and light sliding over the lower floors.
  vec2 tr = skywardTraffic(h);
  col *= 1.0 - 0.4 * hardEdge(tr.y);
  float dusk = 0.35 + 0.65 * skywardDark;
  col += mix(vec3(0.5, 0.58, 0.7) * (0.14 + 0.2 * step(k, 0.5)), vec3(1.0, 0.85, 0.6) * 0.5, skywardDark) * hardEdge(tr.x * dusk, skywardThC);
  // Distance haze, a little, so the far upper floors lighten toward the sky.
  vec3 haze = skyColor(skywardSky, normalize(vec3(rd.x, 0.14, rd.z)));
  haze = mix(haze, skywardDeck, skywardOver * 0.9);
  col = mix(col, haze, (1.0 - exp(-h.t / 300.0)) * 0.55);
  if (K_fog > 0.0) col = mix(col, haze * 0.85 + 0.02, fogAmount(K_fog * 1.4, h.t / 120.0, h.y / 60.0));
  return col;
}

// ---- Overhead hardware ----

// Closest approach of the ray from the eye along rd to the segment a-b: its distance, and s, the
// ray's length at that point.
float skywardSegment(vec3 rd, vec3 a, vec3 b, out float s) {
  vec3 pa = a - SKYWARD_RO;
  vec3 d = b - a;
  float c = dot(d, d);
  float bb = dot(rd, d);
  float e = dot(rd, pa);
  float f = dot(d, pa);
  float den = c - bb * bb;
  float u = den > 1e-6 ? clamp((e * bb - f) / den, 0.0, 1.0) : 0.5;
  vec3 q = pa + d * u;
  s = max(dot(rd, q), 0.0);
  return length(q - rd * s);
}

// A rod or wire of radius r from a to b, never thinner than ~1.6 cells (it fades instead), drawn
// per cell. strength < 1 for the finest wires.
vec3 skywardRod(vec3 col, vec3 rd, float tw, vec3 a, vec3 b, float r, vec3 alb, float strength) {
  float s;
  float d = skywardSegment(rd, a, b, s);
  if (s <= 0.0 || s >= tw) return col;
  float w = max(r / s, 0.8 * skywardPx);
  float cov = hardFill(d / s - w, 0.5 * skywardPx);
  if (cov <= 0.0) return col;
  float thin = clamp(r / (s * 0.8 * skywardPx), 0.3, 1.0) * strength;
  vec3 lit = alb * (skywardAmbient * 0.9 + skywardSunLight * 0.25) + 0.02;
  return mix(col, lit, cov * thin);
}

vec3 skywardInv(vec3 d) {
  return (step(vec3(0.0), d) * 2.0 - 1.0) / max(abs(d), vec3(1e-5));
}

// Ray against an axis-aligned box from the eye: entry distance (-1 if missed) and the face's normal.
float skywardBox(vec3 rd, vec3 lo, vec3 hi, out vec3 n) {
  vec3 inv = skywardInv(rd);
  vec3 t0 = (lo - SKYWARD_RO) * inv;
  vec3 t1 = (hi - SKYWARD_RO) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  float tin = max(max(tn.x, tn.y), tn.z);
  float tout = min(min(tf.x, tf.y), tf.z);
  n = vec3(0.0);
  if (tin > tout || tin < 0.0) return -1.0;
  if (tin == tn.x) n = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tin == tn.y) n = vec3(0.0, -sign(rd.y), 0.0);
  else n = vec3(0.0, 0.0, -sign(rd.z));
  return tin;
}

// The glow of a point light round it, r metres wide; 0 behind a wall.
float skywardGlow(vec3 rd, vec3 L, float r, float tw) {
  vec3 d = L - SKYWARD_RO;
  float s = dot(rd, d);
  if (s <= 0.0 || s >= tw) return 0.0;
  vec3 off = d - rd * s;
  return exp(-dot(off, off) / (r * r));
}

// The foliage of the street tree, in the corner of the sky: balls of leaves seen from underneath,
// backlit by the sky, swaying a little. Edges are cut per cell so the leaves never shimmer.
vec3 skywardCanopy(vec3 col, vec3 rd, float tw) {
  if (K_greenery <= 0.0) return col;
  for (int i = 0; i < 3; i++) {
    vec4 s = SKYWARD_TREE[i];
    vec3 oc = s.xyz - SKYWARD_RO;
    float b = dot(rd, oc);
    if (b <= 0.0) continue;
    vec3 off = rd * b - oc;
    float r = s.w * (0.65 + 0.4 * K_greenery);
    float d = length(off);
    if (d > r * 1.15) continue;
    if (b - sqrt(max(r * r - d * d, 0.0)) >= tw) continue;
    vec3 ax = normalize(cross(rd, vec3(0.0, 1.0, 0.0)));
    vec3 ay = cross(ax, rd);
    vec2 pq = vec2(dot(off, ax), dot(off, ay));
    float fi = float(i);
    vec2 sway = vec2(sin(skywardTm * 0.45 + fi * 2.0), cos(skywardTm * 0.37 + fi)) * (0.1 + 0.12 * abs(K_wind));
    float n1 = fbm3(pq * 0.55 + fi * 7.3 + sway);
    float n2 = vnoise(pq * 2.4 + fi * 3.1 + sway * 2.0);
    float env = 1.0 - smoothstep(0.55, 1.0, d / r);
    float v = env * (0.4 + 0.9 * n1) + 0.3 * n2 - 0.5;
    float cover = smoothstep(0.0, 0.35, v);
    if (hardEdge(cover) < 0.5) continue;
    float back = smoothstep(-0.4, 0.8, dot(rd, skywardSky.sun));
    vec3 leafAlb = mix(vec3(0.04, 0.1, 0.04), vec3(0.14, 0.28, 0.07), smoothstep(0.2, 0.7, n2));
    leafAlb = mix(leafAlb, vec3(0.45, 0.58, 0.14), smoothstep(0.6, 0.9, n2 * 0.7 + back * 0.4 * (1.0 - env * 0.5)));
    leafAlb = wetten(leafAlb, skywardWet, 0.5);
    vec3 e = skywardAmbient * 0.9 + skywardSunLight * 0.55 * back;
    vec3 leaf = leafAlb * e + vec3(1.0, 0.6, 0.3) * 0.07 * skywardDark;
    col = leaf;
  }
  return col;
}

// A street lamp's housing seen from underneath, its lens lit after dusk, haloed.
vec3 skywardLuminaire(vec3 col, vec3 rd, float tw, vec3 lo, vec3 hi) {
  float lit = smoothstep(0.3, 0.6, skywardDark);
  vec3 c = vec3(1.0, 0.8, 0.52);
  vec3 centre = 0.5 * (lo + hi);
  vec3 n;
  float t = skywardBox(rd, lo, hi, n);
  if (t > 0.0 && t < tw) {
    vec3 p = SKYWARD_RO + rd * t;
    vec3 body = vec3(0.1, 0.11, 0.12) * (skywardAmbient * 0.9 + skywardSunLight * 0.25) + 0.02;
    vec2 q = abs(p.xz - centre.xz) - 0.5 * (hi.xz - lo.xz) + vec2(0.1, 0.08);
    float inLens = n.y < -0.5 ? 1.0 - step(0.0, max(q.x, q.y)) : 0.0;
    vec3 lens = mix(vec3(0.45, 0.47, 0.46) * (skywardAmbient + 0.05), c * 2.2, lit);
    col = mix(body, lens, inLens);
  }
  float rain = 1.0 + 1.8 * skywardStorm + 1.0 * K_fog;
  col += c * lit * skywardGlow(rd, centre, 0.9 * rain, tw) * 0.5;
  col += c * lit * skywardGlow(rd, centre, 3.5 * rain, tw) * 0.1;
  return col;
}

vec3 skywardLamps(vec3 col, vec3 rd, float tw) {
  vec3 steel = vec3(0.12, 0.14, 0.14);
  // Right of the frame: the pole at the kerb, its arm reaching over the avenue.
  col = skywardRod(col, rd, tw, vec3(-9.4, 0.0, 3.8), vec3(-9.4, 8.0, 3.8), 0.1, steel, 1.0);
  col = skywardRod(col, rd, tw, vec3(-9.4, 8.0, 3.8), vec3(-8.5, 8.75, 3.8), 0.07, steel, 1.0);
  col = skywardRod(col, rd, tw, vec3(-8.5, 8.75, 3.8), vec3(-7.3, 8.6, 3.8), 0.06, steel, 1.0);
  col = skywardLuminaire(col, rd, tw, vec3(-7.55, 8.34, 3.6), vec3(-6.45, 8.6, 4.0));
  // Left of the frame, among the branches: the corner's lamp over the cross street.
  col = skywardRod(col, rd, tw, vec3(9.4, 0.0, -9.2), vec3(9.4, 8.3, -9.2), 0.1, steel, 1.0);
  col = skywardRod(col, rd, tw, vec3(9.4, 8.3, -9.2), vec3(8.4, 8.9, -9.2), 0.07, steel, 1.0);
  col = skywardRod(col, rd, tw, vec3(8.4, 8.9, -9.2), vec3(7.2, 8.75, -9.2), 0.06, steel, 1.0);
  col = skywardLuminaire(col, rd, tw, vec3(7.45, 8.5, -9.4), vec3(6.35, 8.76, -9.0));
  return col;
}

vec4 skywardLamp(vec2 f, float off, vec3 lampCol, float on) {
  float cov = hardFill(length(f - vec2(0.0, off)) - 0.125, 0.02);
  return vec4(lampCol * (0.06 + 1.7 * on), cov);
}

// The signal gantry across the cross street: pole, arm, three heads facing the crossing; the lights
// turn green, amber and red over 46 seconds.
vec3 skywardGantry(vec3 col, vec3 rd, float tw) {
  vec3 steel = vec3(0.16, 0.17, 0.18);
  col = skywardRod(col, rd, tw, vec3(9.4, 0.0, -4.0), vec3(9.4, 6.4, -4.0), 0.15, steel, 1.0);
  col = skywardRod(col, rd, tw, vec3(9.4, 6.35, -4.0), vec3(-4.4, 6.35, -4.0), 0.12, steel, 1.0);
  col = skywardRod(col, rd, tw, vec3(9.4, 4.6, -4.0), vec3(6.6, 6.3, -4.0), 0.07, steel, 1.0);
  float ph = fract(skywardTm / 46.0);
  float green = 1.0 - smoothstep(0.46, 0.5, ph);
  float amber = smoothstep(0.46, 0.5, ph) * (1.0 - smoothstep(0.56, 0.6, ph));
  float red = smoothstep(0.56, 0.6, ph);
  vec3 cRed = vec3(1.0, 0.12, 0.08);
  vec3 cAmber = vec3(1.0, 0.62, 0.1);
  vec3 cGreen = vec3(0.15, 1.0, 0.62);
  float halo = 1.0 + 1.8 * skywardStorm + K_fog;
  for (int i = 0; i < 3; i++) {
    float x = 5.2 - 4.0 * float(i);
    col = skywardRod(col, rd, tw, vec3(x, 6.35, -4.0), vec3(x, 6.0, -4.0), 0.05, steel, 1.0);
    vec3 n;
    float t = skywardBox(rd, vec3(x - 0.2, 5.0, -4.18), vec3(x + 0.2, 6.0, -3.82), n);
    if (t > 0.0 && t < tw) {
      vec3 p = SKYWARD_RO + rd * t;
      vec3 c = vec3(0.07, 0.075, 0.08) * (skywardAmbient + 0.04) + 0.01;
      if (n.z > 0.5) {
        vec2 f = vec2(p.x - x, p.y - 5.5);
        vec4 lr = skywardLamp(f, 0.32, cRed, red);
        vec4 la = skywardLamp(f, 0.0, cAmber, amber);
        vec4 lg = skywardLamp(f, -0.32, cGreen, green);
        c = mix(c, lr.rgb, lr.a);
        c = mix(c, la.rgb, la.a);
        c = mix(c, lg.rgb, lg.a);
      }
      col = c;
    }
    col += cRed * red * skywardGlow(rd, vec3(x, 5.82, -3.8), 0.5 * halo, tw) * 0.45;
    col += cAmber * amber * skywardGlow(rd, vec3(x, 5.5, -3.8), 0.5 * halo, tw) * 0.45;
    col += cGreen * green * skywardGlow(rd, vec3(x, 5.18, -3.8), 0.5 * halo, tw) * 0.45;
  }
  return col;
}

// The tram wires: a contact wire and its messenger over each track, spans from facade to facade,
// and a pair crossing the avenue's at the crossing.
vec3 skywardWires(vec3 col, vec3 rd, float tw) {
  vec3 wire = vec3(0.05);
  for (int i = 0; i < 2; i++) {
    float x = i == 0 ? -SKYWARD_RAIL : SKYWARD_RAIL;
    col = skywardRod(col, rd, tw, vec3(x, 6.0, -140.0), vec3(x, 6.0, 140.0), 0.012, wire, 0.9);
    col = skywardRod(col, rd, tw, vec3(x, 6.55, -140.0), vec3(x, 6.55, 140.0), 0.009, wire, 0.8);
  }
  col = skywardRod(col, rd, tw, vec3(-140.0, 6.3, -2.2), vec3(140.0, 6.3, -2.2), 0.011, wire, 0.9);
  col = skywardRod(col, rd, tw, vec3(-140.0, 6.3, 2.2), vec3(140.0, 6.3, 2.2), 0.011, wire, 0.9);
  // Spans: from a rosette on each facade, sagging in the middle.
  col = skywardRod(col, rd, tw, vec3(-SKYWARD_A, 7.9, -15.0), vec3(0.0, 7.0, -15.0), 0.012, wire, 0.9);
  col = skywardRod(col, rd, tw, vec3(0.0, 7.0, -15.0), vec3(SKYWARD_A, 7.9, -15.0), 0.012, wire, 0.9);
  col = skywardRod(col, rd, tw, vec3(-SKYWARD_A, 7.9, 16.0), vec3(0.0, 7.0, 16.0), 0.012, wire, 0.9);
  col = skywardRod(col, rd, tw, vec3(0.0, 7.0, 16.0), vec3(SKYWARD_A, 7.9, 16.0), 0.012, wire, 0.9);
  return col;
}

// A tram on its track: a long body gliding past the foot of the frame (felt more than seen), its
// pantograph on the contact wire, a small spark now and then where they meet.
vec3 skywardTram(vec3 col, vec3 rd, float tw, float side) {
  if (K_traffic <= 0.0) return col;
  float period = mix(190.0, 80.0, K_traffic);
  float travel = 26.0;
  float lt = mod(skywardTm + (side > 0.0 ? 20.0 : 75.0), period);
  if (lt > travel) return col;
  float k = lt / travel;
  float zc = side > 0.0 ? -60.0 + 120.0 * k : 60.0 - 120.0 * k;
  float x0 = side * SKYWARD_RAIL;
  vec3 n;
  float t = skywardBox(rd, vec3(x0 - 1.25, 0.5, zc - 11.0), vec3(x0 + 1.25, 3.4, zc + 11.0), n);
  if (t > 0.0 && t < tw) {
    vec3 p = SKYWARD_RO + rd * t;
    float fp = skywardPx * t * 1.6;
    vec3 e = skywardAmbient * 0.85 + skywardSunLight * 0.3 * max(dot(n, skywardSky.sun), 0.0);
    vec3 body = vec3(0.05);
    if (abs(n.x) > 0.5) {
      float yy = p.y;
      vec3 alb = yy < 0.9 ? vec3(0.1, 0.12, 0.12) : yy < 2.75 ? vec3(0.11, 0.3, 0.22) : vec3(0.78, 0.76, 0.68);
      body = wetten(alb, skywardWet, 0.1) * e;
      float band = smoothstep(1.3 - fp, 1.3 + fp, yy) - smoothstep(2.75 - fp, 2.75 + fp, yy);
      float posts = skywardCover1(p.z - zc, 2.3, 0.07, 0.93, fp);
      vec3 inside = vec3(1.0, 0.8, 0.55) * mix(0.1, 0.8, skywardDark);
      vec3 glass = vec3(0.05, 0.07, 0.1) + skywardAmbient * 0.3 + inside;
      body = mix(body, glass, band * posts);
    } else if (abs(n.z) > 0.5) {
      body = vec3(0.22, 0.23, 0.22) * e;
    }
    col = body;
  }
  // The pantograph on the roof, reaching the wire at 6 m.
  float dirSign = side > 0.0 ? 1.0 : -1.0;
  float pz = zc - 7.0 * dirSign;
  vec3 dark = vec3(0.07);
  col = skywardRod(col, rd, tw, vec3(x0, 3.45, pz), vec3(x0, 4.9, pz - 0.9 * dirSign), 0.035, dark, 1.0);
  col = skywardRod(col, rd, tw, vec3(x0, 4.9, pz - 0.9 * dirSign), vec3(x0, 5.97, pz), 0.03, dark, 1.0);
  col = skywardRod(col, rd, tw, vec3(x0 - 0.75, 5.99, pz), vec3(x0 + 0.75, 5.99, pz), 0.04, dark, 1.0);
  float sk = skywardTm * 0.9 + side * 3.1;
  float hh = hash12(vec2(floor(sk), 9.0 + side));
  float env = hh > 0.55 ? bell((fract(sk) - 0.3) / 0.12) : 0.0;
  if (env > 0.0) {
    vec3 L = vec3(x0, 6.02, pz);
    float core = skywardGlow(rd, L, 0.3, tw) * env;
    col = mix(col, vec3(0.85, 0.92, 1.0), hardEdge(core * 1.2, skywardThC));
    col += vec3(0.45, 0.55, 1.0) * skywardGlow(rd, L, 1.0, tw) * env * 0.25;
  }
  return col;
}

// The banner over the crossroads (opt-in): a square of cloth on four cables, the M in the accent
// colour, lit from within at night. accent: the M's coverage.
vec3 skywardBanner(vec3 col, vec3 rd, float tw, out float accent) {
  accent = 0.0;
  if (K_mark < 0.5 || rd.y < 0.2) return col;
  vec2 rh = normalize(skywardR.xz);
  vec2 uh = normalize(skywardU.xz);
  vec3 cable = vec3(0.07);
  for (int i = 0; i < 4; i++) {
    float ca = (i == 0 || i == 3) ? 5.0 : -5.0;
    float cb = i < 2 ? 5.0 : -5.0;
    vec2 cw = rh * ca + uh * cb;
    vec3 from = vec3(cw.x, SKYWARD_SAIL_Y, cw.y);
    vec3 to = vec3(cw.x > 0.0 ? SKYWARD_A : -SKYWARD_A, SKYWARD_SAIL_Y + 4.5, cw.y > 0.0 ? SKYWARD_B + 8.0 : -SKYWARD_B - 8.0);
    col = skywardRod(col, rd, tw, from, to, 0.04, cable, 1.0);
  }
  float t = (SKYWARD_SAIL_Y - SKYWARD_RO.y) / rd.y;
  if (t >= tw) return col;
  vec3 p = SKYWARD_RO + rd * t;
  float a = dot(p.xz, rh);
  float b = dot(p.xz, uh);
  float aa = 0.5 * skywardPx * t / rd.y;
  float cloth = hardFill(sdBox(vec2(a, b), vec2(5.0), 0.0), aa);
  if (cloth <= 0.0) return col;
  float fold = 0.9 + 0.1 * vnoise(vec2(a, b) * 0.45 + 3.0);
  vec3 fabric = vec3(0.88, 0.82, 0.7) * fold * (skywardAmbient * 1.1 + skywardSunLight * 0.45) + col * 0.22;
  float m = hardFill(markDistance(vec2(a, b) / 8.4) * 8.4 - 0.5, aa);
  vec3 paint = vec3(1.0, 0.5, 0.2) * (0.7 + 0.6 * skywardDark);
  vec3 shown = mix(fabric, paint, m);
  col = mix(col, shown, cloth);
  accent = m * cloth;
  return col;
}

// ---- Birds ----

// A bird from below in its own frame (x forward, y across, 1 = half its wingspan): a signed
// distance. open: how far the wings spread; flap: -1..1; swift: 1 for the long scythe wing.
float skywardBird(vec2 q, float open, float flap, float swift) {
  q.y = abs(q.y);
  float d = sdTaperCapsule(q, vec2(0.3, 0.0), vec2(-0.3, 0.0), 0.12, 0.08);
  d = min(d, sdTaperCapsule(q, vec2(-0.28, 0.0), vec2(-0.62, 0.0), mix(0.06, 0.03, swift), mix(0.13, 0.06, swift)));
  float span = mix(0.3, 1.0, open) * (1.0 - 0.22 * abs(flap));
  vec2 sh = vec2(mix(0.1, 0.05, swift), mix(0.07, 0.05, swift));
  vec2 wrist = vec2(mix(-0.02, -0.18, swift) - 0.08 * flap, 0.5 * span);
  vec2 tip = vec2(mix(-0.34, -0.62, swift) - 0.12 * flap, span);
  d = min(d, sdTaperCapsule(q, sh, wrist, mix(0.2, 0.11, swift), mix(0.15, 0.08, swift)));
  d = min(d, sdTaperCapsule(q, wrist, tip, mix(0.15, 0.08, swift), mix(0.05, 0.02, swift)));
  return d;
}

// Pigeons wheeling over the street in a loose chain, swifts on long loops above them. Each bird is a
// world position and velocity; its silhouette is cut per cell, wings beating slowly, gliding between.
vec3 skywardBirds(vec3 rd, float tw, vec3 col) {
  float present = clamp(skywardSky.day + 0.7 * skywardSky.twilight, 0.0, 1.0) * (1.0 - 0.75 * skywardStorm);
  if (K_birds <= 0.0 || present < 0.2) return col;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    if (fi + 0.5 > K_birds * 10.0 || present < 0.2 + 0.05 * fi) break;
    bool swift = (i % 3) == 2;
    vec3 pos;
    vec3 vel;
    float span;
    if (swift) {
      float sp = float(i / 3);
      float th = 0.25 * skywardTm * (1.0 + 0.2 * sp) + sp * 2.1;
      pos = vec3(30.0 * cos(th), 52.0 + 5.0 * sin(1.7 * th + sp), 18.0 * sin(2.0 * th));
      vel = 0.25 * (1.0 + 0.2 * sp) * vec3(-30.0 * sin(th), 8.5 * cos(1.7 * th + sp), 36.0 * cos(2.0 * th));
      span = 0.6;
    } else {
      float th = 0.42 * skywardTm + fi * 0.23;
      float r = 16.0 + 2.5 * sin(fi * 2.3 + skywardTm * 0.2);
      pos = vec3(-1.5 + r * cos(th), 31.0 + 2.0 * sin(fi * 1.7) + 4.0 * sin(th), -1.5 + r * sin(th));
      vel = vec3(-r * 0.42 * sin(th), 4.0 * 0.42 * cos(th), r * 0.42 * cos(th));
      span = 0.36;
    }
    vec3 dv = pos - SKYWARD_RO;
    float db = length(dv);
    if (db > tw) continue;
    vec3 bd = dv / db;
    float c = dot(rd, bd);
    float ex = 1.4 * span / db;
    if (c < 1.0 - 0.5 * ex * ex) continue;
    vec3 m = rd * (db / c) - dv;
    vec3 vp = vel - bd * dot(vel, bd);
    float vl = length(vp);
    vec3 hv = vl > 1e-3 ? vp / vl : normalize(cross(bd, vec3(0.0, 1.0, 0.0)));
    vec3 sv = cross(bd, hv);
    vec2 q = vec2(dot(m, hv), dot(m, sv)) / span;
    // Wings: gliding with them held open most of the time, beating in bouts, slowly.
    float hb = hash12(vec2(fi, 4.4));
    float bout = smoothstep(0.1, 0.6, 0.5 + 0.5 * sin(skywardTm * 0.13 + fi * 2.9));
    float flap = swift ? 0.0 : bout * sin(skywardTm * (1.15 + 0.1 * hb) * TAU + fi * 1.3);
    float open = swift ? 1.0 : mix(0.85, 1.0, 0.5 + 0.5 * flap);
    float aa = 0.55 * skywardPx * db / span;
    float cov = hardFill(skywardBird(q, open, flap, swift ? 1.0 : 0.0), aa);
    if (cov > 0.0) {
      float pale = swift ? 0.0 : smoothstep(0.2, 0.45, abs(q.y)) * 0.4;
      vec3 bc = mix(vec3(0.07, 0.075, 0.09), vec3(0.42, 0.44, 0.48), pale) * (0.5 + skywardAmbient * 0.8) + skywardSunLight * 0.06;
      col = mix(col, bc, cov);
    }
  }
  return col;
}

// ---- The street under you, seen only while the view is tipped toward it ----

// The road, the kerb and sidewalks at the foot of the facades, the zebra and the lane dashes. The
// camera lies in the middle of the crossing looking up, so at rest no ray reaches it; the entrance
// and the exit tip the view down to it. Every edge is a hard per-cell cut of a world-fixed shape,
// and the detail drops out with distance rather than aliasing.
vec3 skywardGround(vec3 rd, float tg, SkywardHit h) {
  vec2 q = SKYWARD_RO.xz + rd.xz * tg;
  vec2 a = abs(q);
  float foot = skywardPx * tg / max(-rd.y, 0.04);
  float aa = 0.5 * foot;
  float fine = 1.0 - smoothstep(0.2, 0.8, foot);
  float finer = 1.0 - smoothstep(0.08, 0.3, foot);
  // The sidewalks: the strips along every facade, widening into the corners (d < 0 inside).
  float dWalk = -min(a.x - (SKYWARD_A - SKYWARD_WALK), a.y - (SKYWARD_B - SKYWARD_WALK));
  float walk = hardFill(dWalk, aa, skywardThB);
  float kerb = hardEdge(softFill(abs(dWalk) - 0.12, aa) * fine, skywardThC);
  vec2 g = abs(fract(q / 1.4 + 0.5) - 0.5) * 1.4;
  float joint = hardEdge(softFill(min(g.x, g.y) - 0.02, aa) * finer, skywardThC) * walk;
  // Paint: a zebra across each arm's mouth and dashed centre lines beyond it.
  float zebraAve = sdBox(vec2(q.x, a.y - (SKYWARD_B - SKYWARD_WALK + 1.95)), vec2(SKYWARD_A - SKYWARD_WALK - 0.8, 1.25), 0.0);
  float zebraX = abs(fract(q.x / 1.2) - 0.5) * 1.2 - 0.3;
  float zebraCross = sdBox(vec2(a.x - (SKYWARD_A - SKYWARD_WALK + 1.35), q.y), vec2(1.15, SKYWARD_B - SKYWARD_WALK - 0.8), 0.0);
  float zebraZ = abs(fract(q.y / 1.2) - 0.5) * 1.2 - 0.3;
  float dashAve = sdBox(vec2(q.x, (fract(q.y / 6.0) - 0.5) * 6.0), vec2(0.08, 1.5), 0.0);
  float dashCross = sdBox(vec2((fract(q.x / 6.0) - 0.5) * 6.0, q.y), vec2(1.5, 0.08), 0.0);
  float dPaint = min(max(zebraAve, zebraX), max(zebraCross, zebraZ));
  dPaint = min(dPaint, max(dashAve, SKYWARD_B - SKYWARD_WALK + 3.8 - a.y));
  dPaint = min(dPaint, max(dashCross, SKYWARD_A + 0.8 - a.x));
  float paint = hardEdge(softFill(dPaint, aa) * fine, skywardThB) * (1.0 - walk);

  vec3 asphalt = vec3(0.3, 0.3, 0.315);
  vec3 stone = vec3(0.62, 0.6, 0.55);
  vec3 alb = mix(asphalt, stone, walk);
  alb = mix(alb, stone * 0.62, joint);
  alb = mix(alb, vec3(0.66, 0.64, 0.6), kerb * walk);
  alb = mix(alb, vec3(0.82, 0.8, 0.74), paint);
  alb = wetten(alb, skywardWet, 0.25);

  SkywardHit gh = h;
  gh.p = vec3(q.x, 0.0, q.y);
  gh.n = vec3(0.0, 1.0, 0.0);
  // The open sky lights the road almost whole: skywardLight's wall ao is lifted back, its lamp warmth kept.
  vec3 E = skywardLight(gh.n, 1.0, skywardSunLit(gh)) + skywardAmbient * 0.35;
  vec3 col = alb * E;
  // Wet road mirrors what stands over it, more so at a grazing angle.
  float gloss = wetGloss(skywardWet, 1.0) * (1.0 - 0.7 * walk);
  if (gloss > 0.01) {
    vec3 mr = vec3(rd.x, -rd.y, rd.z);
    SkywardHit rh = skywardTrace(gh.p, mr);
    vec3 seen = rh.hit ? skywardCheap(rh) : skywardSkyDirect(mr);
    float fres = 0.05 + 0.95 * pow(1.0 - clamp(-rd.y, 0.0, 1.0), 5.0);
    col = mix(col, seen, gloss * clamp(0.15 + 0.7 * fres, 0.0, 1.0));
  }
  if (skywardLying > 0.0) {
    float sn = clamp(skywardLying * (0.55 + 0.5 * walk), 0.0, 1.0);
    col = mix(col, vec3(0.8, 0.84, 0.92) * (E * 0.9 + 0.05), sn);
  }
  // Distance haze, as on the facades but heavier: the road runs away grazing, into the haze.
  vec3 haze = skyColor(skywardSky, normalize(vec3(rd.x, 0.14, rd.z)));
  haze = mix(haze, skywardDeck, skywardOver * 0.9);
  col = mix(col, haze, 0.75 * (1.0 - exp(-tg / 14.0)));
  if (K_fog > 0.0) col = mix(col, haze * 0.85 + 0.02, fogAmount(K_fog * 1.4, tg / 120.0, 0.0));
  return col;
}

// ---- The picture ----

Shade sceneSkyward(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  skywardT = t;
  skywardTm = uMotionTime;
  skywardPx = 1.0 / (uRes.y * SKYWARD_FOCAL);
  skywardSeedOff = K_citySeed * 0.317;
  skywardThB = edgeThreshold(cell, vec2(3.0, 7.0));
  skywardThC = edgeThreshold(cell, vec2(11.0, 5.0));

  // The hour, and the weather over it: rain and snow close the sky, flatten and dim the light.
  skywardSky = skyFacing(skyAt(timeOfDayM(K_time, K_cycle, uMotionTime)), SKYWARD_SKY_YAW);
  skywardStorm = clamp(max(K_rain, 0.85 * K_snow), 0.0, 1.0);
  skywardOver = weatherOvercast(K_rain, K_snow);
  skywardCover = clamp(max(K_clouds, skywardOver), 0.0, 1.0);
  skywardSky.sunColor *= 1.0 - 0.85 * skywardOver;
  skywardSky.moonColor *= 1.0 - 0.75 * skywardOver;
  skywardSky.ambient = greyed(skywardSky.ambient, vec3(1.0), 0.5 * skywardOver) * (1.0 - 0.35 * skywardStorm);
  skywardDark = clamp(1.0 - skywardSky.day * (1.0 - 0.5 * skywardOver), 0.0, 1.0);
  // The city's own glow, orange-violet, lifts the light on everything after dark.
  skywardAmbient = skywardSky.ambient * 1.25 + vec3(0.07, 0.04, 0.06) * skywardSky.night * (1.0 + skywardOver);
  skywardSunLight = skywardSky.sunColor * 1.25;
  skywardDeck = mix(vec3(dot(skywardSky.ambient, LUMA)) * 1.5, vec3(0.13, 0.1, 0.09), skywardDark) * (1.0 - 0.3 * skywardStorm);
  skywardWet = uWeather.x;
  skywardLying = uWeather.y;

  // The camera lies on its back, tilted toward the feet, the screen's top toward the heading h.
  // The entrance tips the view back from street level to the zenith, buildings swinging into their
  // lean (a short settle past the mark); the exit sits up again, tipping it down toward the street.
  // Both are exactly 0 at rest.
  bool passing = passageIn() < 1.0 || passageOut() > 0.0;
  float tilt = 0.0;
  if (passing) {
    float pin = passageIn();
    float sx = clamp((pin - 0.7) / 0.3, 0.0, 1.0);
    float arrived = smoothstep(0.0, 0.8, pin) + 0.06 * sin(3.14159265 * sx) * sin(3.14159265 * sx);
    tilt = (SKYWARD_STREET - SKYWARD_PITCH) * ((1.0 - arrived) + smoothstep(0.0, 1.0, passageOut()));
  }
  float yaw = SKYWARD_YAW + 0.05 * uPointer.x;
  float pitch = SKYWARD_PITCH + 0.04 * uPointer.y + tilt;
  vec3 hd = vec3(sin(yaw), 0.0, cos(yaw));
  skywardF = normalize(vec3(-sin(pitch) * hd.x, cos(pitch), -sin(pitch) * hd.z));
  skywardU = normalize(hd - skywardF * dot(hd, skywardF));
  skywardR = cross(skywardU, skywardF);
  vec2 s = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  vec3 rd = normalize(skywardR * s.x + skywardU * s.y + skywardF * SKYWARD_FOCAL);

  SkywardHit hit = skywardTrace(SKYWARD_RO, rd);
  // Tipped toward the street, a ray looking down reaches the road before any wall.
  float tg = (passing && rd.y < -1e-3) ? SKYWARD_RO.y / -rd.y : SKYWARD_FAR;
  bool ground = tg < (hit.hit ? hit.t : SKYWARD_FAR);
  float tw = ground ? tg : (hit.hit ? hit.t : SKYWARD_FAR);
  vec3 col = ground ? skywardGround(rd, tg, hit) : hit.hit ? skywardFacade(hit, rd) : skywardSkyDirect(rd);

  // Overhead, far to near.
  col = skywardBirds(rd, tw, col);
  float accent = 0.0;
  col = skywardBanner(col, rd, tw, accent);
  col = skywardCanopy(col, rd, tw);
  col = skywardWires(col, rd, tw);
  col = skywardTram(col, rd, tw, -1.0);
  col = skywardTram(col, rd, tw, 1.0);
  col = skywardLamps(col, rd, tw);
  col = skywardGantry(col, rd, tw);

  // The air: rain streams out of the zenith straight at you; snow comes down the frame.
  float depth = weatherDepth(tw);
  float stars = 0.0;
  if (K_rain > 0.0) {
    vec3 vanish = rainVanish(rainFallDir(K_rain, K_wind), skywardR, skywardU, skywardF, SKYWARD_FOCAL);
    Precip pr = rainFallSeen(uv, aspect, t, K_rain, K_wind, depth, vanish);
    // Every path bunches into the zenith: thin the streaks out there so the centre is not a smear.
    vec2 vp = vanish.xy / (abs(vanish.z) < 1e-3 ? 1e-3 : vanish.z);
    float vd = length(vec2((uv.x - 0.5) * aspect, uv.y - 0.5) - vp);
    pr.cover *= smoothstep(0.12, 0.55, vd);
    vec3 air = skywardDeck * 0.9 + vec3(0.02, 0.016, 0.012) * skywardDark;
    vec3 dropLight = max(skywardDeck * 1.2 + skywardAmbient * 0.25, vec3(0.08));
    col = precipOver(col, air, dropLight * (1.0 - 0.2 * pr.near), pr);
  }
  if (K_snow > 0.0) {
    Precip ps = snowFall(uv, aspect, t, K_snow, K_wind, depth);
    vec3 air = mix(skywardDeck * 1.3, vec3(0.75, 0.78, 0.85) * (skywardAmbient + 0.1), 0.5);
    col = mix(col, air, ps.veil);
    col = mix(col, max(vec3(0.8, 0.83, 0.9) * (skywardDeck * 1.6 + skywardAmbient * 0.4), vec3(0.1)), ps.cover);
  }
  if (!hit.hit && !ground) stars = skyStars(skywardSky, rd, K_stars) * (1.0 - skywardOver);

  Shade o = shadeOf(col, inkOf(col, 1.15, 0.85), clamp(accent, 0.0, 1.0));
  o.shimmer = stars * 0.4; // main scales it by the motion
  return o;
}
`;
