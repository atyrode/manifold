// A small island in a gentle sea, seen from a low three-quarter view with the horizon in frame.
// Raymarched, bounded: only rays through the island's box march (at most 64 steps) against one
// signed-distance map: a smooth heightfield (a sloping sand beach with a wet band, a lawn rising
// into a grassy hill with a rocky cliff edge and grass hanging over it), irregular leafy fruit
// trees, a swaying palm, a cottage, a pier with a lantern, driftwood, rocks and bushes. The sea is
// the analytic plane y = 0: clear turquoise shallows over the sand bed, deep blue-green beyond,
// swell lines, a soft swash, and haze into the horizon; the sky is the shared dome.
//
// Frame. World: x right, y up, z away from the camera. The island is built in its own frame q, which
// is the world with x mirrored when the seed says so (islSide), so one layout serves both hands.
// Camera: pitched 20 degrees, focal length 1.2 screen heights, a lens shift that puts the horizon at
// about 66% of the frame, aimed so the island sits in the lower middle.
//
// Light and weather are the shared ones: skyAt turned by ISL_YAW so the sun climbs over the left
// shoulder and sets behind the viewer; rain greys the deck and the light, rainFall and snowFall fall
// through the depth of each pixel's first surface, uWeather wets and whitens every exposed albedo.
//
// Calm under the dither: moving edges (foam, swell lines, cloud shadows, sprites, sparkle, glints)
// are cut per cell with hardEdge / hardFill, and every noise is faded out where a cell outgrows it.

import { glslFloat } from "../../shaders/glsl.ts";

/** Seconds of the island's entrance (the camera swoops down, the gull glides in) and exit (the camera lifts away) (SceneDef.passage). */
export const ISLAND_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

export const islandGlsl = /* glsl */ `
const float ISL_SINP = 0.34202;
const float ISL_COSP = 0.93969;
const float ISL_FOCAL = 1.2;
const float ISL_LENS = 0.277;
const vec3 ISL_TARGET = vec3(0.0, 0.35, 0.1);
const float ISL_YAW = 2.2;

// Passage (ISLAND_PASSAGE): the camera comes down from higher and farther, pitched further over the
// sea, and settles into the usual framing; on the way out it lifts and backs away again.
const float ISL_ENTER = ${glslFloat(ISLAND_PASSAGE.enter)};
const float ISL_EXIT = ${glslFloat(ISLAND_PASSAGE.exit)};
const float ISL_PITCH = 0.349066;
const float ISL_SWOOP_PITCH = 0.2443;
const float ISL_SWOOP_DIST = 0.42;
const float ISL_LIFT_PITCH = 0.2094;
const float ISL_LIFT_DIST = 0.4;
const float ISL_METRES = 2.2;
const float ISL_RS = 2.4;
const float ISL_TOP = 0.98;
const float ISL_PIER_Z = -0.85;
const vec2 ISL_ROOF_N = vec2(0.561, 0.828);

// Island layout, set once per pixel by islSetup (all in the mirrored frame q).
float islSide;
vec3 islAmp;
vec3 islCph;
vec3 islSph;
vec2 islPl;
vec4 islTree[6];
float islTreeY[6];
vec3 islPalm;
vec2 islPalmLean;
vec2 islFrondDir[6];
vec2 islHouse;
vec2 islBedC;
vec2 islBedH;
float islMark;
vec4 islRock[2];
vec4 islBush[3];
vec4 islWood;
float islTrans;
// Clocks, weather, light.
float islT;
float islTime;
float islWind;
float islCover;
float islGrey;
float islStorm;
float islWet;
float islSnow;
vec2 islCell;
vec3 islRo;
vec3 islFwd;
vec3 islRgt;
vec3 islUp;
vec3 islLdir;
vec3 islSdir;
vec3 islLcol;
vec3 islAmb;
float islDark;
vec3 islLampW;
vec3 islLampL;
vec3 islDrop;
Sky islSky;
// Tiny life.
vec3 islGull;
vec3 islGullAhead;
float islGullOn;
vec3 islBall;
float islBallOn;
float islBallHue;
float islBallDir;
// What the last islAlbedo call found.
float islPorous;
float islHardS;
float islSnowOk;
vec3 islEmit;
float islAccent;

// ---- shapes ----

float islSmin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float islCap(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

float islRBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float islRnd(float i) {
  return hash12(vec2(K_isle * 0.731 + 4.7, i * 3.917 + 1.3));
}

// The shore's radius toward unit direction u: a round island with three gentle harmonics.
float islShore(vec2 u) {
  vec2 u2 = vec2(u.x * u.x - u.y * u.y, 2.0 * u.x * u.y);
  vec2 u3 = vec2(u.x * u2.x - u.y * u2.y, u.y * u2.x + u.x * u2.y);
  vec2 u4 = vec2(u2.x * u2.x - u2.y * u2.y, 2.0 * u2.x * u2.y);
  float w = islAmp.x * (u2.x * islCph.x + u2.y * islSph.x)
          + islAmp.y * (u3.x * islCph.y + u3.y * islSph.y)
          + islAmp.z * (u4.x * islCph.z + u4.y * islSph.z);
  return ISL_RS * (1.0 + w);
}

// Beach width: a broad ring of sand on the near and flanking sides, a cliff straight from the sea behind.
float islBeach(vec2 u) {
  return mix(0.52, 0.05, smoothstep(0.1, 0.8, u.y));
}

// The land as a smooth heightfield over the island's plane xz: x its height (0 at the waterline, a
// gentle sand beach rising inland, a lawn on top of it, a hill with a flat crown at ISL_TOP and a
// steep, noise-broken face toward the beach; below the sea outside the shore), y the lawn weight
// (0 sand .. 1 grass), z the hill weight, w the distance past the shore (positive in the sea).
vec4 islTerr(vec2 xz) {
  float r = max(length(xz), 1e-4);
  vec2 u = xz / r;
  float S = islShore(u);
  float dsh = r - S;
  float land = -dsh;
  float n1 = vnoise(xz * 2.1 + 3.0);
  float lawnT = S - islBeach(u) - r + 0.16 * (n1 - 0.5);
  float lawn = smoothstep(-0.12, 0.35, lawnT);
  float sandH = 0.17 * smoothstep(0.0, 0.75, land) - 0.25 * smoothstep(0.0, 0.6, dsh);
  float lawnH = 0.27 * smoothstep(-0.2, 0.9, lawnT) + 0.05 * (n1 - 0.5) * lawn;
  float rim = 0.34 * smoothstep(0.35, 0.9, u.y) * smoothstep(0.02, 0.3, land);
  float dh = length((xz - islPl) * vec2(1.0, 1.08)) + 0.12 * (vnoise(xz * 3.1 + 9.0) - 0.5);
  float hw = smoothfall(1.3, 0.62, dh);
  return vec4(mix(sandH + lawnH + rim, ISL_TOP, hw), lawn, hw, dsh);
}

vec2 islTreeSlot(int i) {
  if (i == 0) return vec2(-1.35, -0.55);
  if (i == 1) return vec2(1.6, 0.45);
  if (i == 2) return vec2(0.75, 1.3);
  if (i == 3) return vec2(-0.55, -1.05);
  if (i == 4) return vec2(1.7, 0.95);
  return vec2(-0.3, 1.9);
}

void islSetup() {
  islSide = islRnd(0.0) < 0.5 ? -1.0 : 1.0;
  vec3 ph = vec3(islRnd(1.0), islRnd(2.0), islRnd(3.0)) * TAU;
  islCph = cos(ph);
  islSph = sin(ph);
  islAmp = vec3(0.07, 0.045, 0.025) * (0.55 + 0.6 * islRnd(4.0));
  float fs = islShore(vec2(0.0, -1.0)) - islBeach(vec2(0.0, -1.0));
  islPl = vec2(-0.55, 0.85) + (vec2(islRnd(5.0), islRnd(6.0)) - 0.5) * 0.24;
  islHouse = islPl + vec2(0.0, 0.16);

  float count = floor(K_trees * 6.0 + 0.5);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 pos = islTreeSlot(i) * (fs / 1.85) + (hash22(vec2(fi * 3.7 + 1.0, K_isle * 0.31 + 2.0)) - 0.5) * 0.28;
    float rad = 0.31 + 0.08 * hash12(vec2(fi + 5.3, K_isle * 0.17 + 1.9));
    float rr = max(length(pos), 1e-3);
    vec2 uu = pos / rr;
    float lim = islShore(uu) - islBeach(uu) - rad - 0.12;
    if (rr > lim) pos *= lim / rr;
    islTree[i] = vec4(pos, rad, fi < count ? 1.0 : 0.0);
    islTreeY[i] = islTerr(pos).x;
  }

  vec2 pu = normalize(vec2(-0.8, -0.6));
  vec2 pb = pu * (islShore(pu) - 0.32);
  islPalm = vec3(pb.x, islTerr(pb).x, pb.y);
  islPalmLean = vec2(pu.x * 0.4, pu.y * 0.16);
  for (int k = 0; k < 6; k++) {
    float a = float(k) * 1.0472 + 0.4 + 0.5 * hash12(vec2(float(k), 9.2));
    islFrondDir[k] = vec2(cos(a), sin(a));
  }

  islMark = K_mark;
  islBedH = vec2(0.27, 0.5) * fs * islMark;
  islBedC = vec2(0.35, -0.38) * fs;

  vec2 ru = normalize(vec2(0.12, -1.0));
  vec2 r0 = ru * (islShore(ru) - 0.32);
  islRock[0] = vec4(r0.x, islTerr(r0).x + 0.02, r0.y, 0.15);
  vec2 ru1 = normalize(vec2(-0.25, -1.0));
  vec2 r1 = ru1 * (islShore(ru1) - 0.5);
  islRock[1] = vec4(r1.x, islTerr(r1).x + 0.02, r1.y, 0.09);

  vec2 b0 = islPl + vec2(0.58, -0.42);
  vec2 b1 = islPl + vec2(-0.62, -0.3);
  vec2 b2 = vec2(-1.05, -1.15) * (fs / 1.85);
  islBush[0] = vec4(b0.x, islTerr(b0).x + 0.04, b0.y, 0.15);
  islBush[1] = vec4(b1.x, islTerr(b1).x + 0.04, b1.y, 0.12);
  islBush[2] = vec4(b2.x, islTerr(b2).x + 0.04, b2.y, 0.14);

  // Driftwood on the beach, lying along the tideline.
  float wa = -1.05;
  vec2 wu = vec2(cos(wa), sin(wa));
  vec2 wp = wu * (islShore(wu) - 0.34);
  islWood = vec4(wp.x, islTerr(wp).x + 0.04, wp.y, wa + 1.5708 + 0.35);

  vec2 wl = islHouse + rotate(vec2(-0.12, -0.28), -0.25);
  islLampW = vec3(wl.x * islSide, ISL_TOP + 0.2, wl.y);
  islLampL = vec3(4.07 * islSide, 0.8, ISL_PIER_Z - 0.2);
}

// ---- the island's signed-distance map: x distance, y material id ----
// 1 terrain, 2 trunk, 3.x canopy of tree x, 4 palm trunk, 5 frond, 6 wall, 7 roof, 8 chimney,
// 9 deck, 10 post, 11 lantern iron, 12 lantern glass, 13 rock, 14 bush, 15 coconut, 16 driftwood.

float islFrond(vec3 q, vec3 tp, vec2 dir, float wob) {
  vec3 m = vec3(dir.x * 0.26, 0.13 + wob * 0.03, dir.y * 0.26);
  vec3 e = m + vec3(dir.x * 0.3, -0.22 + wob * 0.05, dir.y * 0.3);
  vec3 lq = q - tp;
  lq.y *= 1.9;
  m.y *= 1.9;
  e.y *= 1.9;
  return min(islCap(lq, vec3(0.0), m, 0.07, 0.07), islCap(lq, m, e, 0.07, 0.02)) / 1.9;
}

vec2 islMap(vec3 p) {
  vec3 q = vec3(p.x * islSide, p.y, p.z);
  vec4 tt = islTerr(q.xz);
  vec2 res = vec2((q.y - tt.x) * 0.62, 1.0);

  // Fruit trees.
  for (int i = 0; i < 6; i++) {
    vec4 tr = islTree[i];
    if (tr.w < 0.5) continue;
    vec3 c = vec3(tr.x, islTreeY[i] + 0.3 + 0.62 * tr.z, tr.y);
    float bb = length(q - c) - (1.5 * tr.z + 0.3);
    if (bb > 0.2) {
      res.x = min(res.x, bb);
      continue;
    }
    float fi = float(i);
    vec3 qs = q;
    qs.x += 0.012 * sin(islT * 0.9 + fi * 1.7) * (0.5 + abs(islWind));
    // A crown of leaf clumps: a core and four lobes, their silhouette broken by two scales of bumps.
    float dc = length((qs - c) * vec3(1.0, 1.15, 1.0)) - tr.z * 0.82;
    for (int j = 0; j < 4; j++) {
      float a = fi * 2.1 + 0.7 + float(j) * 1.5708;
      float hy = j == 1 ? 0.22 : (j == 3 ? 0.3 : -0.1);
      vec3 lobe = c + tr.z * vec3(cos(a) * 0.62, hy, sin(a) * 0.62);
      dc = islSmin(dc, length(qs - lobe) - tr.z * 0.58, 0.1 * tr.z);
    }
    dc += 0.045 * sin(qs.x * 11.0 + fi) * sin(qs.y * 10.0 + 1.7) * sin(qs.z * 12.0 + 2.3);
    dc += 0.014 * sin(qs.x * 23.0 + qs.z * 17.0) * sin(qs.y * 21.0 + qs.x * 9.0);
    dc *= 0.85;
    if (dc < res.x) res = vec2(dc, 3.0 + 0.1 * fi);
    float dt = islCap(q, vec3(tr.x, islTreeY[i] - 0.04, tr.y), vec3(tr.x, islTreeY[i] + 0.36, tr.y), 0.065, 0.045);
    if (dt < res.x) res = vec2(dt, 2.0);
  }

  // The palm: a bowed trunk, a crown of six drooping fronds that sway in the wind.
  {
    vec3 B = islPalm;
    vec3 cen = B + vec3(islPalmLean.x * 0.5, 0.65, islPalmLean.y * 0.5);
    float bp = length(q - cen) - 1.05;
    if (bp > 0.2) {
      res.x = min(res.x, bp);
    } else {
      float sw = sin(islT * 0.8) * 0.035 * (0.6 + abs(islWind));
      vec3 tp = B + vec3(islPalmLean.x + sw, 1.1, islPalmLean.y + sw * 0.4);
      vec3 mid = B + vec3(islPalmLean.x * 0.3, 0.58, islPalmLean.y * 0.3);
      float dt = min(islCap(q, B - vec3(0.0, 0.05, 0.0), mid, 0.085, 0.07), islCap(q, mid, tp, 0.07, 0.052));
      if (dt < res.x) res = vec2(dt, 4.0);
      float df = 1e3;
      for (int k = 0; k < 6; k++) {
        df = min(df, islFrond(q, tp, islFrondDir[k], sin(islT * 1.1 + float(k) * 1.3)));
      }
      if (df < res.x) res = vec2(df, 5.0);
      float dn = min(length(q - tp - vec3(0.05, -0.07, 0.04)) - 0.05, length(q - tp - vec3(-0.04, -0.06, -0.05)) - 0.045);
      if (dn < res.x) res = vec2(dn, 15.0);
    }
  }

  // The cottage on the plateau.
  {
    vec2 hl = rotate(q.xz - islHouse, 0.25);
    vec3 lp = vec3(hl.x, q.y - ISL_TOP, hl.y);
    float bh = length(lp - vec3(0.0, 0.28, 0.0)) - 0.55;
    if (bh > 0.2) {
      res.x = min(res.x, bh);
    } else {
      float dw = islRBox(lp - vec3(0.0, 0.07, 0.0), vec3(0.27, 0.27, 0.22), 0.025);
      if (dw < res.x) res = vec2(dw, 6.0);
      vec2 rp = vec2(abs(lp.x) - 0.31, lp.y - 0.335);
      float dr = max(max(dot(rp, ISL_ROOF_N), 0.335 - lp.y), abs(lp.z) - 0.27) - 0.012;
      if (dr < res.x) res = vec2(dr, 7.0);
      float dk = islRBox(lp - vec3(0.15, 0.4, 0.07), vec3(0.04, 0.13, 0.04), 0.008);
      if (dk < res.x) res = vec2(dk, 8.0);
    }
  }

  // The pier: planks, piles, a lantern on its last pile.
  {
    vec3 pq = q - vec3(0.0, 0.0, ISL_PIER_Z);
    float bpr = islRBox(pq - vec3(2.95, 0.3, 0.0), vec3(1.3, 0.7, 0.45), 0.0);
    if (bpr > 0.2) {
      res.x = min(res.x, bpr);
    } else {
      float dd = islRBox(pq - vec3(2.925, 0.24, 0.0), vec3(1.175, 0.035, 0.21), 0.012);
      if (dd < res.x) res = vec2(dd, 9.0);
      float px = pq.x - 2.25;
      float kx = clamp(floor(px / 0.9 + 0.5), 0.0, 2.0);
      px -= kx * 0.9;
      float dpost = max(length(vec2(px, abs(pq.z) - 0.2)) - 0.04, abs(pq.y - 0.05) - 0.38);
      float dpole = max(length(vec2(pq.x - 4.07, pq.z + 0.2)) - 0.032, abs(pq.y - 0.31) - 0.43);
      dpost = min(dpost, dpole);
      if (dpost < res.x) res = vec2(dpost, 10.0);
      float dg = islRBox(pq - vec3(4.07, 0.8, -0.2), vec3(0.055, 0.075, 0.055), 0.014);
      if (dg < res.x) res = vec2(dg, 12.0);
      float di = min(islRBox(pq - vec3(4.07, 0.895, -0.2), vec3(0.08, 0.022, 0.08), 0.012), islRBox(pq - vec3(4.07, 0.72, -0.2), vec3(0.068, 0.014, 0.068), 0.008));
      if (di < res.x) res = vec2(di, 11.0);
    }
  }

  // Rocks and bushes.
  for (int i = 0; i < 2; i++) {
    vec4 rk = islRock[i];
    float d = length((q - rk.xyz) * vec3(1.0, 1.5, 1.0)) - rk.w + 0.02 * sin(q.x * 17.0 + q.z * 9.0) * sin(q.y * 19.0 + q.x * 5.0);
    if (d < res.x) res = vec2(d, 13.0);
  }
  for (int i = 0; i < 3; i++) {
    vec4 bs = islBush[i];
    float d = length((q - bs.xyz) * vec3(1.0, 1.15, 1.0)) - bs.w;
    if (d < res.x) res = vec2(d, 14.0);
  }

  // Driftwood: a weathered log with a broken branch, lying along the tideline.
  {
    vec3 wd = q - islWood.xyz;
    float bw = length(wd) - 0.45;
    if (bw > 0.2) {
      res.x = min(res.x, bw);
    } else {
      vec2 ax = vec2(cos(islWood.w), sin(islWood.w));
      vec3 a3 = vec3(ax.x, 0.05, ax.y) * 0.27;
      float dl = islCap(wd, -a3, a3, 0.05, 0.042);
      vec3 s0 = vec3(0.05 * ax.x, 0.02, 0.05 * ax.y);
      dl = min(dl, islCap(wd, s0, s0 + vec3(-ax.y * 0.1, 0.09, ax.x * 0.1), 0.022, 0.012));
      if (dl < res.x) res = vec2(dl, 16.0);
    }
  }
  return res;
}

vec3 islNormal(vec3 p) {
  vec2 e = vec2(1.0, -1.0) * 0.5773 * 0.005;
  return normalize(e.xyy * islMap(p + e.xyy).x + e.yyx * islMap(p + e.yyx).x + e.yxy * islMap(p + e.yxy).x + e.xxx * islMap(p + e.xxx).x);
}

float islShadow(vec3 p, vec3 l) {
  float res = 1.0;
  float tt = 0.03;
  for (int i = 0; i < 10; i++) {
    float h = islMap(p + l * tt).x;
    res = min(res, 7.0 * h / tt);
    tt += clamp(h, 0.04, 0.4);
    if (res < 0.02 || tt > 4.5) break;
  }
  return smoothstep(0.0, 1.0, clamp(res, 0.0, 1.0));
}

float islAO(vec3 p, vec3 n) {
  float h1 = islMap(p + n * 0.07).x;
  float h2 = islMap(p + n * 0.22).x;
  return clamp(1.0 - 3.0 * (0.07 - h1) - 1.2 * (0.22 - h2), 0.0, 1.0);
}

vec2 islSlab(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 a = (vec3(-4.7, -0.3, -2.95) - ro) * inv;
  vec3 b = (vec3(4.7, 1.9, 3.0) - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

// A world point on the screen: x, y in the view's own units (screen heights), z the depth along the camera.
vec3 islProject(vec3 P) {
  vec3 v = P - islRo;
  float zc = dot(v, islFwd);
  return vec3(ISL_FOCAL * dot(v, islRgt) / zc, ISL_FOCAL * dot(v, islUp) / zc - ISL_LENS, zc);
}

// ---- clouds' shadows and the shadows of what flies ----

// The shade of the cloud deck overhead, 0, 0.5 or 1 per cell: a lattice of puffs drifting with the
// wind, each cell holding at most one. Two edge layers, each cut per cell against its own threshold,
// make a soft penumbra whose edge crosses the island once per cell as it passes.
float islCloudShadow(vec3 pos, float cover) {
  if (cover <= 0.02 || length(pos.xz) > 55.0) return 0.0;
  vec2 c = pos.xz + islLdir.xz / max(islLdir.y, 0.3) * 4.5;
  c.x -= islT * (0.09 * (islWind < 0.0 ? -1.0 : 1.0) + 0.22 * islWind);
  vec2 g = c / 7.0;
  vec2 id = floor(g);
  vec2 f = (g - id) * 7.0;
  float h = hash12(id + 17.3);
  if (h >= cover * 0.75) return 0.0;
  vec2 ctr = 2.9 + 1.2 * hash22(id + 3.3);
  float R = 1.1 + 0.8 * fract(h * 53.0);
  vec2 sq = vec2(0.85, 1.0);
  float d = length((f - ctr) * sq) - R;
  d = min(d, length((f - ctr - vec2(0.7 * R, -0.1 * R)) * sq) - 0.75 * R);
  d = min(d, length((f - ctr - vec2(-0.75 * R, 0.05 * R)) * sq) - 0.7 * R);
  return 0.5 * (hardFill(d + 0.45, 0.3, edgeThreshold(islCell, vec2(5.0, 3.0))) + hardFill(d, 0.3));
}

float islAirShadow(vec3 pos) {
  float s = 0.0;
  float k = 1.0 / max(islLdir.y, 0.3);
  if (islGullOn > 0.0) {
    vec2 g = islGull.xz - islLdir.xz * k * (islGull.y - pos.y);
    s = max(s, hardFill(length((pos.xz - g) * vec2(0.9, 1.4)) - 0.2, 0.05));
  }
  if (islBallOn > 0.0) {
    vec2 b = islBall.xz - islLdir.xz * k * (islBall.y - pos.y);
    s = max(s, hardFill(length(pos.xz - b) - 0.27, 0.06));
  }
  return s;
}

// ---- materials ----

// Pastel flowers sprinkled on grass: p in the island frame, dens 0..1.
vec3 islFlowers(vec2 p, vec3 base, float dens) {
  vec2 g = p / 0.27;
  vec2 id = floor(g);
  vec2 f = fract(g);
  float h = hash12(id + 31.7);
  if (h > dens * 0.5) return base;
  vec2 c = 0.3 + 0.4 * hash22(id + 5.5);
  float rad = 0.16 + 0.1 * fract(h * 91.0);
  float d = length(f - c);
  if (d > rad) return base;
  float k = fract(h * 17.0 * 7.0);
  vec3 pet = k < 0.3 ? vec3(0.94, 0.62, 0.68) : (k < 0.55 ? vec3(0.96, 0.88, 0.50) : (k < 0.8 ? vec3(0.95, 0.94, 0.90) : vec3(0.74, 0.66, 0.90)));
  pet = mix(pet, vec3(0.95, 0.78, 0.25), 1.0 - smoothstep(rad * 0.26, rad * 0.4, d));
  return mix(base, pet, 1.0 - smoothstep(rad * 0.8, rad, d));
}

// The Manifold M as a flowerbed, drawn anamorphically on the lawn: stretched in depth so that,
// foreshortened by the camera, it reads as an M. Pale pebbles edge it; pink, white and yellow flowers fill it.
vec3 islBed(vec2 xz, vec3 base) {
  if (islMark <= 0.0) return base;
  vec2 m = vec2((xz.x - islBedC.x) / (2.0 * islBedH.x) * 0.94, (xz.y - islBedC.y) / (2.0 * islBedH.y));
  if (abs(m.x) > 0.7 || abs(m.y) > 0.7) return base;
  float d = markDistance(m);
  float inside = 1.0 - smoothstep(0.078, 0.092, d);
  float border = (1.0 - smoothstep(0.118, 0.132, d)) * (1.0 - inside);
  if (inside + border <= 0.0) return base;
  vec3 stones = mix(vec3(0.90, 0.86, 0.78), vec3(0.78, 0.74, 0.70), step(0.5, hash12(floor(xz * 24.0))));
  vec2 g = xz / 0.115;
  vec2 id = floor(g);
  float h = hash12(id + 61.3);
  vec2 c = 0.5 + 0.28 * (hash22(id + 2.2) - 0.5) * 2.0;
  float fd = length(fract(g) - c);
  vec3 leaf = vec3(0.26, 0.58, 0.28);
  vec3 pet = h < 0.55 ? vec3(1.0, 0.48, 0.68) : (h < 0.8 ? vec3(0.99, 0.96, 0.95) : vec3(1.0, 0.86, 0.35));
  float fl = (1.0 - smoothstep(0.3, 0.4, fd)) * step(h, 0.92);
  vec3 bed = mix(leaf, pet, fl);
  bed = mix(bed, vec3(1.0, 0.82, 0.3), (1.0 - smoothstep(0.1, 0.16, fd)) * fl);
  islAccent = max(islAccent, inside * (0.35 + 0.65 * fl));
  vec3 col = mix(base, stones, border);
  return mix(col, bed, inside);
}

// Footprints in the sand: pairs of bare feet from the palm toward the water, tangent to the shore.
float islFoot(vec2 xz) {
  float a = atan(xz.y, xz.x);
  float a0 = -2.35;
  float a1 = -1.8;
  if (a < a0 || a > a1) return 0.0;
  float r = length(xz);
  float rp = islShore(xz / max(r, 1e-4)) - 0.3 - 0.03 * sin(a * 9.0);
  float arc = (a - a0) * rp;
  float k = floor(arc / 0.2);
  float f = arc - (k + 0.5) * 0.2;
  float side = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
  float d = sdEllipse(vec2(f, r - rp - side * 0.045), vec2(0.055, 0.03));
  return (1.0 - smoothstep(-0.006, 0.012, d)) * smoothstep(0.0, 0.1, arc) * smoothstep(0.0, 0.1, (a1 - a) * rp);
}

vec3 islTerrainAlbedo(vec3 q, vec3 n) {
  vec4 tt = islTerr(q.xz);
  float lawn = tt.y;
  float hw = tt.z;
  float land = -tt.w;
  float gn = vnoise(q.xz * 2.1) * 0.6 + vnoise(q.xz * 5.3 + 7.0) * 0.4;
  float streak = vnoise(vec2(q.x * 13.0 + q.z * 9.0, 1.0));

  // Rock: weathered strata, cooler and darker at the water.
  float band = sin(q.y * 24.0 + 2.2 * vnoise(q.xz * 2.5 + q.y * 2.0));
  vec3 rock = mix(vec3(0.62, 0.56, 0.49), vec3(0.50, 0.45, 0.41), smoothstep(-0.4, 0.4, band));
  rock *= 0.88 + 0.24 * vnoise(q.xz * 9.0 + q.y * 6.0);
  rock = mix(rock * vec3(0.78, 0.84, 0.92), rock, smoothstep(0.0, 0.3, q.y));

  // Grass: patchy and a little sun-bleached on the crown; it runs down the slope in ragged tongues
  // over the rock, darker where it thins out.
  vec3 grass = mix(vec3(0.30, 0.50, 0.20), vec3(0.50, 0.66, 0.27), gn);
  grass = mix(grass, vec3(0.58, 0.70, 0.32), 0.45 * hw);
  float slopeG = n.y + 0.3 * (streak - 0.5) + 0.12 * (gn - 0.5);
  float topK = smoothstep(0.55, 0.78, slopeG);
  grass = mix(grass, vec3(0.20, 0.36, 0.15), 0.55 * (1.0 - abs(2.0 * topK - 1.0)));
  if (topK > 0.9 && lawn > 0.9) {
    if (length(q.xz - islHouse) > 0.42) grass = islFlowers(q.xz, grass, K_flowers);
    if (hw < 0.05) grass = islBed(q.xz, grass);
  }
  vec3 ground = mix(rock, grass, topK);

  // Sand: ripples along the shore, a few pebbles, damp and darker at the tideline, footprints.
  float rip = 0.5 + 0.5 * sin(land * 38.0 + 3.0 * vnoise(q.xz * 2.0));
  vec3 sand = vec3(0.90, 0.80, 0.60) * (0.97 + 0.04 * rip);
  sand = mix(sand, vec3(0.78, 0.68, 0.52), 0.5 * step(0.985, hash12(floor(q.xz * 30.0))));
  sand *= mix(0.9, 1.0, smoothstep(0.0, 0.6, land));
  float wl = 0.26 + 0.05 * sin(islT * 0.3 + q.x * 1.3);
  float wetK = hardEdge(smoothstep(wl, wl - 0.1, land + 0.08 * (vnoise(q.xz * 4.5) - 0.5)));
  sand = mix(sand, sand * vec3(0.64, 0.60, 0.57), 0.85 * wetK);
  sand = mix(sand, sand * vec3(0.8, 0.77, 0.74), 0.7 * islFoot(q.xz));

  islPorous = mix(0.35, 0.5, lawn);
  islHardS = lawn < 0.5 ? 1.0 : 0.0;
  return mix(sand, ground, lawn);
}

vec3 islLeaf(int i) {
  if (i == 0) return vec3(0.27, 0.50, 0.22);
  if (i == 1) return vec3(0.22, 0.46, 0.27);
  if (i == 2) return vec3(0.34, 0.54, 0.20);
  if (i == 3) return vec3(0.25, 0.48, 0.24);
  if (i == 4) return vec3(0.30, 0.50, 0.25);
  return vec3(0.22, 0.44, 0.24);
}

vec3 islFruitCol(int i) {
  if (i == 0) return vec3(0.88, 0.30, 0.26);
  if (i == 1) return vec3(0.92, 0.55, 0.20);
  if (i == 2) return vec3(0.95, 0.65, 0.58);
  if (i == 3) return vec3(0.93, 0.82, 0.30);
  if (i == 4) return vec3(0.88, 0.30, 0.26);
  return vec3(0.92, 0.55, 0.20);
}

// A crown in clumps of leaves: broad light and dark patches, a finer grain, sun-bleached tips on
// top and shade underneath, a little fruit.
vec3 islCanopyAlbedo(vec3 q, vec3 n, float id) {
  int ti = int(floor((id - 3.0) * 10.0 + 0.5));
  vec4 tr = islTree[ti];
  vec3 c = vec3(tr.x, islTreeY[ti] + 0.3 + 0.62 * tr.z, tr.y);
  vec3 lp = (q - c) / tr.z;
  vec3 leaf = islLeaf(ti);
  float clump = vnoise(lp.xy * 3.2 + lp.z * 2.4 + float(ti) * 7.0);
  float fine = vnoise(lp.zy * 9.0 + lp.x * 6.0 + float(ti) * 3.0);
  vec3 col = leaf * (0.62 + 0.55 * clump + 0.2 * fine);
  col = mix(col, leaf * vec3(1.35, 1.3, 0.75), 0.45 * smoothstep(0.1, 0.9, lp.y * 0.8 + 0.5 * fine - 0.1));
  col *= mix(0.65, 1.0, smoothstep(-0.9, 0.1, lp.y));
  vec3 g = lp * 2.4;
  vec3 gi = floor(g);
  float h = hash12(gi.xy + gi.z * 17.0 + float(ti) * 3.3);
  if (h < 0.3) {
    vec3 cc = 0.3 + 0.4 * vec3(hash12(gi.xy + 1.7 + gi.z), hash12(gi.yz + 4.1), hash12(gi.zx + 8.3));
    float dd = length(fract(g) - cc);
    float fr = 1.0 - smoothstep(0.2, 0.28, dd);
    col = mix(col, islFruitCol(ti), fr * step(0.0, n.y + 0.55));
  }
  return col;
}

vec3 islHouseAlbedo(vec3 q, vec3 n, int m) {
  vec2 hl = rotate(q.xz - islHouse, 0.25);
  vec3 lp = vec3(hl.x, q.y - ISL_TOP, hl.y);
  vec2 nl = rotate(n.xz * vec2(islSide, 1.0), 0.25);
  vec3 wall = vec3(0.92, 0.86, 0.74);
  if (m == 8) {
    return mix(vec3(0.62, 0.40, 0.34), vec3(0.74, 0.52, 0.44), smoothstep(0.1, 0.5, n.y));
  }
  if (m == 7) {
    // The gable ends keep the wall's cream; the slopes are coral tiles in rows.
    if (abs(nl.y) > 0.6) return wall;
    islHardS = 1.0;
    islPorous = 0.2;
    return vec3(0.74, 0.38, 0.28) * (0.93 + 0.07 * smoothstep(-0.2, 0.2, sin(lp.y * 55.0)));
  }
  islPorous = 0.3;
  if (nl.y < -0.6) {
    vec2 wp = lp.xy - vec2(-0.12, 0.2);
    float dw = sdBox(wp, vec2(0.065, 0.06), 0.008);
    float shutter = sdBox(vec2(abs(wp.x) - 0.1, wp.y), vec2(0.03, 0.06), 0.004);
    if (shutter < 0.0) wall = vec3(0.34, 0.52, 0.50);
    if (dw < 0.02) wall = vec3(0.96, 0.93, 0.87);
    if (dw < 0.0) {
      wall = mix(vec3(0.50, 0.64, 0.76), vec3(0.95, 0.70, 0.38), islDark * 0.8);
      if (min(abs(wp.x), abs(wp.y)) < 0.006) wall = vec3(0.96, 0.93, 0.87);
      else islEmit += vec3(1.0, 0.72, 0.36) * islDark * 0.95;
    }
    float fb = sdBox(wp - vec2(0.0, -0.09), vec2(0.075, 0.018), 0.004);
    if (fb < 0.0) wall = fract(wp.x * 30.0) < 0.5 ? vec3(0.88, 0.50, 0.62) : vec3(0.42, 0.60, 0.32);
    vec2 dp = lp.xy - vec2(0.12, 0.085);
    float dd = min(sdBox(dp, vec2(0.052, 0.085), 0.0), length(dp - vec2(0.0, 0.085)) - 0.052);
    if (dd < 0.012) wall = vec3(0.96, 0.93, 0.87);
    if (dd < 0.0) wall = vec3(0.52, 0.35, 0.28);
    if (length(dp - vec2(0.03, -0.005)) < 0.01) wall = vec3(0.95, 0.80, 0.35);
  }
  return wall;
}

vec3 islAlbedo(vec3 pos, vec3 n, float id) {
  vec3 q = vec3(pos.x * islSide, pos.y, pos.z);
  int m = int(floor(id + 0.01));
  islPorous = 0.5;
  islHardS = 0.0;
  islSnowOk = 1.0;
  islEmit = vec3(0.0);
  islTrans = 0.0;
  if (m == 1) return islTerrainAlbedo(q, n);
  if (m == 2) {
    islSnowOk = 0.0;
    islPorous = 0.8;
    return vec3(0.50, 0.37, 0.27) * (0.9 + 0.1 * sin(q.y * 50.0 + q.x * 20.0));
  }
  if (m == 3) {
    islPorous = 0.7;
    islTrans = 0.6;
    return islCanopyAlbedo(q, n, id);
  }
  if (m == 4) {
    islSnowOk = 0.0;
    islPorous = 0.8;
    return vec3(0.62, 0.48, 0.34) * (0.86 + 0.14 * smoothstep(0.35, 0.65, 0.5 + 0.5 * sin(q.y * 38.0)));
  }
  if (m == 5) {
    islPorous = 0.7;
    islTrans = 0.45;
    return mix(vec3(0.20, 0.44, 0.20), vec3(0.36, 0.60, 0.26), vnoise(q.xz * 8.0 + q.y * 5.0));
  }
  if (m == 15) {
    islSnowOk = 0.0;
    return vec3(0.40, 0.28, 0.20);
  }
  if (m == 6 || m == 7 || m == 8) return islHouseAlbedo(q, n, m);
  if (m == 9) {
    islHardS = 1.0;
    islPorous = 0.85;
    float f = fract(q.x * 5.88);
    float seam = smoothstep(0.0, 0.07, f) * smoothstep(0.0, 0.07, 1.0 - f);
    return vec3(0.74, 0.58, 0.42) * (0.84 + 0.16 * seam) * (0.94 + 0.06 * vnoise(vec2(q.x * 8.0, q.z * 60.0)));
  }
  if (m == 10) {
    islSnowOk = 0.0;
    islPorous = 0.9;
    return vec3(0.46, 0.35, 0.26);
  }
  if (m == 11) {
    islSnowOk = 0.0;
    islPorous = 0.0;
    return vec3(0.26, 0.22, 0.24);
  }
  if (m == 12) {
    islSnowOk = 0.0;
    islPorous = 0.0;
    islEmit = vec3(1.0, 0.76, 0.4) * (0.3 + 1.15 * islDark);
    return vec3(0.95, 0.86, 0.6) * 0.5;
  }
  if (m == 13) {
    islHardS = 1.0;
    islPorous = 0.1;
    vec3 rk = vec3(0.60, 0.57, 0.54) * (0.85 + 0.25 * vnoise(q.xz * 10.0 + q.y * 6.0));
    return mix(rk, vec3(0.34, 0.46, 0.26), 0.6 * smoothstep(0.6, 0.9, n.y) * step(0.45, vnoise(q.xz * 6.0)));
  }
  if (m == 16) {
    islPorous = 0.8;
    return vec3(0.74, 0.66, 0.55) * (0.88 + 0.16 * vnoise(q.xz * 30.0 + q.y * 20.0));
  }
  // Bushes: round and leafy, dotted with blossom.
  vec3 g = q * 7.0;
  vec3 gi = floor(g);
  float h = hash12(gi.xy + gi.z * 13.0 + 3.7);
  vec3 col = vec3(0.26, 0.50, 0.27) * (0.8 + 0.4 * vnoise(q.xz * 9.0 + q.y * 4.0));
  float dd = length(fract(g) - (0.3 + 0.4 * vec3(fract(h * 7.0), fract(h * 13.0), fract(h * 29.0))));
  if (h < 0.28) col = mix(col, h < 0.14 ? vec3(0.94, 0.62, 0.70) : vec3(0.95, 0.94, 0.90), 1.0 - smoothstep(0.2, 0.28, dd));
  islPorous = 0.7;
  islTrans = 0.3;
  return col;
}

// ---- light ----

vec3 islLamps(vec3 pos, vec3 n) {
  vec3 w = islLampW - pos;
  float d2 = dot(w, w);
  float a = (0.35 + 0.65 * max(dot(n, w * inversesqrt(max(d2, 1e-4))), 0.0)) / (1.0 + d2 * 3.2);
  vec3 s = vec3(1.0, 0.72, 0.38) * (a * 0.55);
  vec3 l = islLampL - pos;
  float e2 = dot(l, l);
  float b = (0.35 + 0.65 * max(dot(n, l * inversesqrt(max(e2, 1e-4))), 0.0)) / (1.0 + e2 * 1.6);
  s += vec3(1.0, 0.78, 0.45) * (b * 0.9);
  return s * islDark;
}

vec3 islLit(vec3 alb, vec3 n, vec3 pos, vec3 rd, float sh, float ao, float cs, float gloss) {
  float ndl = dot(n, islLdir);
  vec3 up = mix(vec3(dot(islAmb, LUMA)), islAmb, 0.6);
  vec3 down = vec3(0.64, 0.60, 0.50) * dot(islAmb, vec3(0.333));
  vec3 hemi = mix(down, up, 0.5 + 0.5 * n.y);
  float wrap = islTrans * 0.35;
  float dir = max((ndl + wrap) / (1.0 + wrap), 0.0) * sh * (1.0 - 0.85 * cs);
  // Foliage glows where the sun shines through it toward the eye.
  float back = islTrans * pow(clamp(dot(rd, islLdir), 0.0, 1.0), 3.0) * (0.35 + 0.65 * sh) * (1.0 - 0.85 * cs);
  vec3 light = hemi * (1.2 * ao * (1.0 - 0.15 * cs)) + islLcol * (0.62 * dir) + islLcol * (back * vec3(0.9, 0.97, 0.63)) + islLamps(pos, n);
  vec3 col = alb * light;
  vec3 hv = normalize(islLdir - rd);
  col += islLcol * (gloss * pow(max(dot(n, hv), 0.0), 36.0) * sh * (1.0 - cs));
  return col;
}

vec3 islLand(vec3 pos, vec3 n, float id, vec3 rd) {
  islAccent = 0.0;
  vec3 alb = islAlbedo(pos, n, id);
  alb = wetten(alb, islWet, islPorous);
  float snowK = islSnowOk * snowCover(n, vec2(pos.x * islSide, pos.z) * 3.0, islSnow);
  alb = mix(alb, vec3(0.93, 0.95, 1.0), snowK);
  islAccent *= 1.0 - snowK;

  float sh = 1.0;
  if (dot(n, islLdir) > 0.0 && dot(islLcol, vec3(0.333)) > 0.02) sh = islShadow(pos + n * 0.012, islSdir);
  if (int(floor(id + 0.01)) == 1 && sh < 0.97 && n.y > 0.5) {
    // Light through the leaves above: dapples drifting slowly over the shade.
    sh = max(sh, 0.45 * hardEdge(smoothstep(0.52, 0.62, vnoise(vec2(pos.x * islSide, pos.z) * 9.0 + vec2(islT * 0.04, 0.0)))));
  }
  float ao = islAO(pos, n);
  float cs = max(islCloudShadow(pos, islCover * (1.0 - islStorm)) * smoothstep(0.02, 0.25, islLdir.y), islAirShadow(pos));
  float gloss = 0.5 * wetGloss(islWet, n.y);
  vec3 col = islLit(alb, n, pos, rd, sh, ao, cs, gloss);
  col += islEmit;
  if (K_rain > 0.0 && islHardS > 0.5 && n.y > 0.7) {
    col += islDrop * (rainSplashes(vec2(pos.x * islSide, pos.z) * 3.2, islTime, K_rain) * 0.4);
  }
  return col;
}

// ---- sky ----

vec3 islSkyCol(vec3 dir) {
  vec3 c = skyColor(islSky, dir);
  return greyed(c, vec3(0.92, 0.95, 1.0), 0.6 * islGrey) * (1.0 - 0.2 * K_rain);
}

vec3 islHaze(vec3 rd) {
  return islSkyCol(normalize(vec3(rd.x, 0.025, rd.z)));
}

vec3 islDome(vec3 rd) {
  vec3 c = islSkyCol(rd);
  vec4 cl = skyClouds(islSky, rd, islTime, islCover, islWind);
  cl.rgb = greyed(cl.rgb, vec3(0.94, 0.96, 1.0), 0.6 * islGrey) * (1.0 + 0.2 * islGrey - 0.35 * K_rain);
  c += skyStarLight(islSky, rd, K_stars) * (1.0 - cl.a);
  return mix(c, cl.rgb, cl.a);
}

// Low toon cumulus drifting along the horizon, far behind the island: billboards on a long loop that
// wraps well outside the frame. rgb and coverage; zScene hides those the sea in front of them covers.
vec4 islFarClouds(vec2 sp, float zScene) {
  float cs = 0.09 * (islWind < 0.0 ? -1.0 : 1.0) + 0.22 * islWind;
  vec3 lum = (islAmb + islSky.sunColor * 0.5 + islSky.moonColor * 0.6) * 0.95;
  lum = greyed(lum, vec3(0.96, 0.98, 1.0), 0.5 * islGrey);
  vec3 res = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    if (hash12(vec2(fi, 11.0 + K_isle * 0.13)) > islCover * 1.05 + 0.12) continue;
    float x = mod(hash12(vec2(fi, 3.1)) * 60.0 + islT * cs * 2.5, 60.0) - 30.0;
    float z = 19.0 + 11.0 * fract(fi * 0.618 + 0.3);
    float y = 3.0 + 3.5 * hash12(vec2(fi, 8.1));
    float R = 2.0 + 1.5 * hash12(vec2(fi, 5.5));
    vec3 pj = islProject(vec3(x, y, z));
    if (pj.z > zScene) continue;
    vec2 l = (sp - pj.xy) * pj.z / ISL_FOCAL / R;
    if (abs(l.x) > 2.2 || abs(l.y) > 1.6) continue;
    float d = length(l) - 0.85;
    d = min(d, length(l - vec2(-0.85, -0.2)) - 0.62);
    d = min(d, length(l - vec2(0.95, -0.24)) - 0.66);
    d = min(d, length(l - vec2(0.2, 0.45)) - 0.6);
    d = min(d, length(l - vec2(-0.45, 0.33)) - 0.5);
    d = max(d, -0.36 - l.y);
    if (hardFill(d * R, 0.06) > 0.5) {
      res = mix(vec3(0.78, 0.84, 0.96), vec3(1.0), smoothstep(-0.3, 0.6, l.y)) * lum;
      alpha = 1.0;
    }
  }
  return vec4(res, alpha);
}

// ---- the sea ----

// The wind ripples: four trains crossing at odd angles, the longest 4 units, at a slowed .35 of the
// deep-water pace.
const RippleTable ISL_RIPPLES = RippleTable(4,
  vec4[RIPPLE_TRAINS](vec4(4.0, 0.03, 0.35, 1.0), vec4(1.5, 0.035, 0.35, 0.0), vec4(0.9, 0.03, 0.35, 2.0), vec4(0.55, 0.025, 0.35, 4.0), vec4(0.0)),
  vec2[RIPPLE_TRAINS](normalize(vec2(0.25, 1.0)), normalize(vec2(1.0, 0.35)), normalize(vec2(-0.5, 1.0)), normalize(vec2(0.7, -0.7)), vec2(0.0)),
  vec2(7.0, 14.0));

vec3 islSea(vec3 Pfull, vec3 rd, float t) {
  // Past ~140 units everything below is faded flat anyway; keep the coordinates sane.
  vec3 P = t > 140.0 ? islRo + rd * 140.0 : Pfull;
  vec3 q = vec3(P.x * islSide, 0.0, P.z);
  float r = max(length(q.xz), 1e-4);
  float S = islShore(q.xz / r);
  float dsh = r - S;
  float ang = atan(q.z, q.x);
  float ws = smoothstep(0.0, 1.1, dsh);
  float wd = smoothstep(0.8, 3.6, dsh);

  // What one dither cell covers on the water, across and along the depth: every noise below fades
  // out (to its mean) once a cell outgrows its features, so the far sea never crawls. A detail whose
  // fade has reached 0 adds exactly nothing, so it is not evaluated at all there.
  vec2 foot = vec2(1.0, 1.0 / max(-rd.y, 0.1)) * t / (ISL_FOCAL * uRes.y);
  float fl = max(foot.x, foot.y);
  float lodB = 1.0 - smoothstep(0.1, 0.3, fl / 3.0);
  float lodW = 1.0 - smoothstep(0.1, 0.3, fl / 0.9);
  float lodS = 1.0 - smoothstep(0.1, 0.3, fl / 0.42);
  float lodL = 1.0 - smoothstep(0.1, 0.3, fl / 0.67);

  // Clear water over the sea bed: the sand shows through the shallows, tinted turquoise as red is
  // absorbed first; seagrass patches in the middle depths; deep blue-green beyond.
  float depth = 0.04 + 0.55 * clamp(dsh, 0.0, 2.0) + 0.7 * max(dsh - 2.0, 0.0);
  vec3 trans = exp(-vec3(2.4, 0.9, 0.6) * depth);
  float grassP = lodW > 0.0 ? smoothstep(0.55, 0.68, vnoise(q.xz * 1.1 + 7.0)) * smoothstep(0.3, 0.9, dsh) * (1.0 - smoothstep(1.6, 2.4, dsh)) * lodW : 0.0;
  vec3 bed = mix(vec3(0.86, 0.76, 0.57), vec3(0.28, 0.40, 0.28), 0.75 * grassP);
  vec3 scatter = mix(vec3(0.10, 0.36, 0.40), vec3(0.04, 0.20, 0.30), smoothstep(0.3, 3.0, dsh));
  vec3 base = bed * trans + scatter * (1.0 - trans);
  if (lodB > 0.0) base *= 1.0 + 0.1 * (vnoise(P.xz * 0.35 + vec2(islT * 0.02, 0.0)) - 0.5) * lodB;
  // Lighter swell bands drifting slowly across it, cut per cell.
  if (lodW > 0.0) {
    float wv = vnoise(P.xz * vec2(0.9, 1.3) + vec2(islT * 0.05, islT * 0.03));
    base = mix(base, base * 1.15 + vec3(0.025, 0.035, 0.035), 0.5 * hardEdge(smoothstep(0.6, 0.72, wv) * lodW));
  }

  // Light: the island and the clouds, the gull and the balloon all shade the water.
  float cs = max(islCloudShadow(P, islCover * (1.0 - islStorm)) * smoothstep(0.02, 0.25, islLdir.y), islAirShadow(P));
  float sh = 1.0;
  if (r < 5.3 && islLdir.y > 0.04 && dot(islLcol, vec3(0.333)) > 0.02) sh = islShadow(P + vec3(0.0, 0.02, 0.0), islSdir);
  vec3 ambN = mix(vec3(dot(islAmb, LUMA)), islAmb, 0.6);
  vec3 lm = ambN * (1.15 * (1.0 - 0.15 * cs)) + islLcol * (0.34 * sh * (1.0 - 0.85 * cs));
  vec3 col = base * lm * 1.1;

  // Wind ripples and a long swell: the slope tilts the mirror of the sky; the rain rings add their own.
  vec3 sl = rippleSpectrum(P.xz, islT, foot, 1.0, ISL_RIPPLES);
  float ringFade = 1.0 - smoothstep(10.0, 20.0, t);
  vec3 rr3 = vec3(0.0);
  if (K_rain > 0.0) {
    rr3 = rainRipples(P.xz * 2.4, islTime, K_rain);
    sl.xy += rr3.xy * 0.5 * ringFade;
  }
  WaterMirror sea = waterMirror(rd, sl.xy, 0.12);
  vec3 rr = sea.ray;
  rr.y = max(rr.y, 0.02);
  rr = normalize(rr);
  float fres = clamp(1.3 * sea.fresnel, 0.0, 0.9);
  col = mix(col, islSkyCol(rr), fres);

  // Foam: a ragged swash lapping the beach, a thin line at the waterline, and long soft swell
  // lines that roll toward the shore in broken pieces, each wave with its own gaps; a ring round
  // each pile. Every edge is cut per cell.
  float ph = islT * 0.45 + 3.0 * vnoise(vec2(ang * 1.4 + 2.0, 1.7));
  float edgeN = 0.55 + 0.9 * vnoise(vec2(ang * 7.0 + islT * 0.03, 4.0));
  float fr = (0.03 + 0.17 * (0.5 + 0.5 * sin(ph))) * edgeN;
  float lace = smoothstep(0.25, 0.6, vnoise(vec2(ang * 16.0, dsh * 22.0 - islT * 0.25)));
  float foam = max(bell((dsh + 0.01) / 0.035) * 0.55 * (0.6 + 0.4 * lace), bell((dsh - fr) / (0.035 + 0.03 * edgeN)) * (0.35 + 0.65 * lace));
  if (lodL > 0.0) {
    float wph = dsh * 1.5 + islT * 0.09 + 0.9 * vnoise(vec2(ang * 2.2 + 1.0, dsh * 0.5 + islT * 0.01));
    float crest = 0.5 - 0.5 * cos(TAU * wph);
    float broken = smoothstep(0.35, 0.7, vnoise(vec2(ang * 4.0 + floor(wph) * 3.1, 2.0)));
    foam = max(foam, 0.5 * smoothstep(0.86, 0.985, crest) * broken * smoothstep(0.15, 0.6, dsh) * (1.0 - smoothstep(1.2, 4.5, dsh)) * lodL);
  }
  if (q.x > 1.9 && q.x < 4.4 && abs(q.z - ISL_PIER_Z) < 0.5) {
    vec2 pp = vec2(q.x - 2.25, abs(q.z - ISL_PIER_Z) - 0.2);
    float kx = clamp(floor(pp.x / 0.9 + 0.5), 0.0, 2.0);
    pp.x -= kx * 0.9;
    foam = max(foam, bell((length(pp) - 0.085 - 0.02 * sin(islT * 1.3 + kx)) / 0.03) * 0.8);
  }
  vec3 foamCol = vec3(0.95, 0.97, 0.97) * min(lm * 1.1, vec3(1.0));
  col = mix(col, foamCol, 0.85 * hardEdge(clamp(foam * 1.2, 0.0, 1.0)));

  // Fish: dark shapes gliding round the island in the shallows, tails swishing.
  if (K_fish > 0.5) {
    float vis = (1.0 - smoothstep(0.6, 1.0, wd)) * smoothstep(0.1, 0.5, ws);
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float th = islT * 0.07 + 0.8 - fi * 0.16;
      vec2 fu = vec2(cos(th), sin(th));
      vec2 fp = fu * (islShore(fu) + 0.95 + 0.1 * sin(islT * 0.2 + fi));
      vec2 dd = q.xz - fp;
      vec2 fv = vec2(-fu.y, fu.x);
      vec2 lc = vec2(dot(dd, fv), dot(dd, vec2(-fv.y, fv.x)));
      float sc = i == 0 ? 1.0 : 0.6;
      lc /= sc;
      float wag = 0.05 * sin(islT * 3.0 + fi * 2.0);
      float d = min(sdEllipse(lc, vec2(0.17, 0.075)), sdTaperCapsule(lc, vec2(-0.14, 0.0), vec2(-0.3, wag), 0.045, 0.012));
      col *= 1.0 - 0.3 * hardFill(d * sc, 0.02) * vis;
    }
  }

  // Sparkle: little stars that kindle and die over a second or two, cut per cell; none where a cell
  // is bigger than they are.
  if (lodS > 0.0) {
    vec2 gs = P.xz / 0.42;
    vec2 sid = floor(gs);
    float hh = hash12(sid + 9.1);
    float ph2 = fract(islT * (0.11 + 0.1 * fract(hh * 7.7)) + hh * 13.0);
    float pulse = smoothstep(0.88, 0.93, ph2) * (1.0 - smoothstep(0.96, 1.0, ph2));
    vec2 sc2 = 0.25 + 0.5 * hash22(sid + 4.4);
    float spk = (1.0 - smoothstep(0.02, 0.06, length((fract(gs) - sc2) * 0.42))) * pulse * step(hh, 0.55) * lodS;
    float spkL = clamp(dot(islLcol, vec3(0.5)) + dot(islAmb, vec3(0.2)), 0.12, 1.0);
    col += vec3(1.0, 0.99, 0.92) * (spkL * 0.8 * hardEdge(spk * 1.1));
  }

  // The sun's or moon's glitter path on the broken mirror, in flecks; a tight glint, and the
  // lantern's long streak.
  float lightL = dot(islLcol, vec3(0.333));
  if (lightL > 0.02) {
    float a = 1.0 - dot(rr, islLdir);
    col += islLcol * (0.9 * hardEdge(exp(-a * 380.0) * lightL * 1.3));
    if (lodS > 0.0) {
      float fleck = smoothstep(0.35, 0.75, vnoise(P.xz * vec2(2.2, 3.2) + vec2(islT * 0.08, 0.0)));
      col += islLcol * (0.45 * hardEdge(exp(-a * 22.0) * fleck * lodS * min(lightL * 1.6, 1.0)));
    }
  }
  if (islDark > 0.02) {
    vec3 tl = normalize(islLampL - P);
    float al = 1.0 - dot(rr, tl);
    vec2 dl = P.xz - islLampL.xz;
    col += vec3(1.0, 0.76, 0.42) * (hardEdge(exp(-al * 260.0) * islDark * 1.4) * 0.9 + islDark * 0.2 * exp(-dot(dl, dl) * 0.9));
  }

  // Rain rings.
  if (K_rain > 0.0) col += islDrop * (0.35 * ringFade * hardEdge(rr3.z * 1.3, edgeThreshold(islCell, vec2(6.0, 1.0))));

  col = greyed(col, vec3(0.92, 0.95, 1.0), 0.45 * islGrey);
  // Haze: the sea gives way to the air toward the horizon, a shade darker than the sky behind it.
  float hz = 1.0 - exp(-max(t - 14.0, 0.0) * 0.035);
  return mix(col, islHaze(rd) * vec3(0.92, 0.96, 1.0), 0.85 * hz);
}

// ---- passage ----

// 0 -> 1 as k does: slow start, a brisk middle and a gentle settle that overshoots by about 5%.
float islSettle(float k) {
  float m = smoothstep(0.0, 1.0, k) - 1.0;
  return 1.0 + 2.2 * m * m * m + 1.2 * m * m;
}

// ---- tiny life ----

vec3 islGullAt(float tm) {
  float th = tm * 0.16 + 1.0;
  float R = 4.2 + 0.5 * sin(tm * 0.07);
  return vec3(0.2 + R * 1.25 * cos(th), 2.5 + 0.25 * sin(tm * 0.31) + 0.12 * sin(tm * 0.77), 0.6 + R * 0.9 * sin(th));
}

// A gift balloon floats across every minute or two, or when asked: left to right or the other way,
// at its own height and depth, taking as long as half the interval to cross.
void islBalloonSetup(float tm, float since) {
  islBallOn = 0.0;
  islBall = vec3(0.0);
  islBallHue = 0.0;
  islBallDir = 1.0;
  float P = mix(200.0, 70.0, clamp(K_balloon, 0.0, 1.0));
  float span = 0.5 * P;
  float prog = -1.0;
  float hs = 0.0;
  float ts = since * uMotion;
  if (ts >= 0.0 && ts < span) {
    prog = ts / span;
    hs = hash12(vec2(floor(uTriggers[0]), 7.7));
  } else if (K_balloon > 0.0) {
    float u = tm / P + 0.8;
    float f = fract(u);
    if (f < 0.5) {
      prog = f / 0.5;
      hs = hash12(vec2(floor(u), 31.7));
    }
  }
  if (prog < 0.0) return;
  float dirS = hs < 0.5 ? 1.0 : -1.0;
  islBallDir = dirS;
  islBall = vec3(dirS * (prog - 0.5) * 26.0, 2.9 + 0.6 * fract(hs * 7.31) + 0.1 * sin(tm * 0.6), -1.0 + 5.0 * fract(hs * 13.7));
  islBallHue = hs;
  islBallOn = 1.0;
}

vec4 islGullSprite(vec2 sp, vec3 pj) {
  vec2 l = (sp - pj.xy) * pj.z / ISL_FOCAL * 1.5;
  if (dot(l, l) > 0.45) return vec4(0.0);
  vec3 pv = islProject(islGullAhead);
  vec2 hv = (pv.xy - pj.xy) * pj.z / ISL_FOCAL;
  float hl = length(hv);
  vec2 along = hl > 1e-4 ? hv / hl : vec2(1.0, 0.0);
  vec2 perp = vec2(-along.y, along.x);
  vec2 lc = vec2(dot(l, along), dot(l, perp));
  float fl = 0.5 * sin(islT * 2.8) + 0.5 * sin(islT * 0.9 + 1.0);
  float d = min(sdEllipse(lc, vec2(0.115, 0.048)), length(lc - vec2(0.12, 0.0)) - 0.034);
  d = min(d, sdTaperCapsule(lc, vec2(-0.1, 0.0), vec2(-0.21, 0.0), 0.03, 0.012));
  float tip = 0.0;
  for (int s = 0; s < 2; s++) {
    float sg = s == 0 ? 1.0 : -1.0;
    vec2 s0 = along * 0.03 + perp * (sg * 0.02);
    vec2 m = along * (-0.015 - 0.04 * fl) + perp * (sg * 0.17) + vec2(0.0, 0.06 * fl);
    vec2 e = along * (-0.13 - 0.08 * fl) + perp * (sg * 0.33) + vec2(0.0, 0.13 * fl);
    float tt;
    float d2 = sdTaperCapsule(l, m, e, 0.028, 0.014, tt);
    d = min(d, min(sdTaperCapsule(l, s0, m, 0.038, 0.028), d2));
    tip = max(tip, step(d2, 0.0) * smoothstep(0.5, 0.8, tt));
  }
  vec3 lm = clamp(islAmb * 1.1 + islLcol * 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.98, 0.98, 0.97), vec3(0.26, 0.28, 0.34), tip) * lm;
  col = mix(col, vec3(0.95, 0.62, 0.2) * lm, 1.0 - smoothstep(0.008, 0.014, length(lc - vec2(0.165, 0.0))));
  return vec4(col, hardFill(d, 0.012));
}

vec4 islBalloonSprite(vec2 sp, vec3 pj) {
  vec2 l = (sp - pj.xy) * pj.z / ISL_FOCAL;
  if (dot(l, l) > 0.95) return vec4(0.0);
  vec2 b = rotate(l, 0.09 * sin(islT * 0.7 + islBallHue * 9.0));
  float dE = min(sdEllipse(b - vec2(0.0, 0.14), vec2(0.23, 0.29)), sdTaperCapsule(b, vec2(0.0, -0.1), vec2(0.0, -0.17), 0.05, 0.02));
  float dS = sdTaperCapsule(b, vec2(0.0, -0.17), vec2(0.015 * sin(islT * 1.3), -0.52), 0.009, 0.009);
  float dG = sdBox(b - vec2(0.0, -0.58), vec2(0.07, 0.06), 0.01);
  vec3 lm = clamp(islAmb * 1.1 + islLcol * 0.5, 0.0, 1.0);
  vec3 hue = islBallHue < 0.25 ? vec3(1.0, 0.52, 0.5) : (islBallHue < 0.5 ? vec3(1.0, 0.86, 0.4) : (islBallHue < 0.75 ? vec3(0.5, 0.88, 0.7) : vec3(0.55, 0.75, 1.0)));
  vec3 body = hue * (0.82 + 0.18 * smoothstep(-0.15, 0.4, b.y));
  body = mix(body, vec3(1.0), 0.5 * (1.0 - smoothstep(0.0, 0.1, length(b - vec2(-0.08, 0.26)))));
  vec3 box = (abs(b.x) < 0.012 || abs(b.y + 0.58) < 0.012) ? vec3(0.9, 0.35, 0.4) : vec3(0.98, 0.82, 0.45);
  float cE = hardFill(dE, 0.012);
  float cG = hardFill(dG, 0.012);
  float cS = hardFill(dS, 0.009);
  vec3 col = body * lm;
  float a = cE;
  if (cE < 0.5 && cG > 0.5) {
    col = box * lm;
    a = 1.0;
  } else if (cE < 0.5 && cS > 0.5) {
    col = vec3(0.95, 0.93, 0.9) * lm;
    a = 1.0;
  }
  return vec4(col, a);
}

// ---- the scene ----

Shade sceneIsland(vec2 uv, vec2 cell, float t) {
  islT = uMotionTime;
  islTime = t;
  islWind = K_wind;
  islCell = cell;
  float aspect = uRes.x / uRes.y;
  islSetup();

  // The sky, turned so the sun climbs over the left shoulder; rain closes it as in the other scenes.
  float tod = timeOfDayM(K_time, K_cycle, uMotionTime);
  islSky = skyFacing(skyAt(tod), ISL_YAW);
  float rain = K_rain;
  float snow = K_snow;
  float storm = weatherOvercast(rain, snow);
  float heavy = max(rain, 0.85 * snow);
  islStorm = storm;
  islGrey = smoothstep(0.0, 0.05, heavy);
  float lost = storm * (0.5 + 0.4 * heavy);
  vec3 diffused = islSky.sunColor * (lost * (0.55 - 0.3 * heavy));
  islSky.sunColor *= 1.0 - lost;
  islSky.moonColor *= 1.0 - storm * 0.6;
  islSky.ambient = greyed(islSky.ambient, vec3(0.95, 0.98, 1.04), 0.3 * storm) * (1.0 - 0.25 * rain) + diffused;
  islCover = clamp(max(K_clouds, storm), 0.0, 1.0);
  islLdir = islSky.sun.y > -0.06 ? islSky.sun : islSky.moon;
  islSdir = normalize(vec3(islLdir.x, max(islLdir.y, 0.12), islLdir.z));
  islLcol = islSky.sunColor + islSky.moonColor * 1.1;
  islAmb = islSky.ambient + islSky.night * vec3(0.05, 0.07, 0.13);
  islDark = clamp(1.0 - smoothstep(-0.12, 0.2, islSky.sun.y) + 0.3 * storm, 0.0, 1.0);
  islWet = uWeather.x;
  islSnow = uWeather.y;
  islDrop = max(vec3(dot(islAmb + 0.3 * islSky.sunColor, LUMA)) * 1.1, vec3(0.08));

  islGullOn = (K_gull > 0.5 && rain < 0.35 && islSky.night < 0.7) ? 1.0 : 0.0;
  islGull = islGullAt(islT);
  islGullAhead = islGullAt(islT + 0.6);
  islBalloonSetup(islT, sinceTrigger(0));
  if (rain > 0.7) islBallOn = 0.0;

  // Passage: the camera's swoop (1 at the start, 0 once settled; it dips a little below 0 in the
  // overshoot) and lift away, the gull gliding in along a bearing of its own and out the
  // other way, the balloon drifting in along its heading and rising away. Nothing below runs at rest.
  float pin = passageIn();
  float pout = passageOut();
  bool passing = pin < 1.0 || pout > 0.0;
  float sinP = ISL_SINP;
  float cosP = ISL_COSP;
  float D = 7.0 * max(1.0, 1.65 / aspect);
  if (passing) {
    float swoop = 1.0 - islSettle(pin);
    float away = smoothstep(0.0, 1.0, pout);
    float pitch = ISL_PITCH + swoop * ISL_SWOOP_PITCH + away * ISL_LIFT_PITCH;
    sinP = sin(pitch);
    cosP = cos(pitch);
    D *= 1.0 + swoop * ISL_SWOOP_DIST + away * ISL_LIFT_DIST;
    float tin = pin * ISL_ENTER;
    float tout = pout * ISL_EXIT;
    if (islGullOn > 0.0) {
      float sgn = hash12(vec2(K_isle, 41.0)) < 0.5 ? 1.0 : -1.0;
      // Gull: a quadratic glide in from beyond the frame's edge (decelerating to the orbit), the
      // heading taken from its velocity so it flies the way it travels.
      vec3 vIn = vec3(-sgn * 16.0, 1.5, -1.0);
      float fin = 1.0 - clamp(tin / ISL_ENTER, 0.0, 1.0);
      vec3 gOff = vIn * (fin * fin);
      vec3 gVel = vIn * (-2.0 * fin / ISL_ENTER);
      if (pout > 0.0) {
        vec3 vOut = vec3(sgn * 18.0, 2.5, 1.0);
        float fout = tout / ISL_EXIT;
        gOff += vOut * (fout * fout);
        gVel += vOut * (2.0 * fout / ISL_EXIT);
      }
      islGull += gOff;
      islGullAhead += gOff + 0.6 * gVel;
    }
    if (islBallOn > 0.0) {
      float fb = 1.0 - clamp((tin - 0.2) / (ISL_ENTER - 0.2), 0.0, 1.0);
      islBall += vec3(-islBallDir * 14.0, 0.6, 0.0) * (fb * fb) + vec3(islBallDir * 5.0, 5.0, 0.0) * (pout * pout);
    }
  }

  // The camera.
  islFwd = vec3(0.0, -sinP, cosP);
  islRgt = vec3(1.0, 0.0, 0.0);
  islUp = vec3(0.0, cosP, sinP);

  // Aim a little below the island so it sits in the lower middle of the frame, under the horizon.
  islRo = ISL_TARGET - islUp * (0.1314 * D) - islFwd * D;
  vec2 sp = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  vec3 rd = normalize(ISL_FOCAL * islFwd + sp.x * islRgt + (sp.y + ISL_LENS) * islUp);

  // March the island inside its box; anything it misses is sea or sky.
  float tSea = rd.y < -1e-4 ? -islRo.y / rd.y : 1.0e5;
  vec2 tb = islSlab(islRo, rd);
  float tEnd = min(tb.y, tSea);
  float tHit = -1.0;
  float hid = 0.0;
  if (tb.y > tb.x && tEnd > max(tb.x, 0.0)) {
    float tt = max(tb.x, 0.0);
    for (int i = 0; i < 64; i++) {
      vec2 h = islMap(islRo + rd * tt);
      if (h.x < 0.0008 * tt + 0.002) {
        tHit = tt;
        hid = h.y;
        break;
      }
      tt += h.x * 0.9;
      if (tt > tEnd) break;
    }
  }

  vec3 col;
  float zScene = 1.0e4;
  bool onIsland = false;
  float accent = 0.0;
  if (tHit > 0.0) {
    vec3 pos = islRo + rd * tHit;
    col = islLand(pos, islNormal(pos), hid, rd);
    accent = islAccent;
    zScene = tHit * dot(rd, islFwd);
    onIsland = true;
  } else if (tSea < 1.0e4) {
    col = islSea(islRo + rd * tSea, rd, tSea);
    zScene = tSea * dot(rd, islFwd);
  } else {
    col = islDome(rd);
  }

  if (!onIsland && uv.y > 0.55) {
    vec4 fc = islFarClouds(sp, zScene);
    float hor = 0.5 + ISL_FOCAL * sinP / cosP - ISL_LENS;
    if (fc.a > 0.0) col = mix(col, mix(fc.rgb, islHaze(rd), mix(0.5, 0.12, smoothstep(0.0, 0.2, uv.y - hor))), fc.a);
  }

  // The gull and the balloon, in front of whatever lies behind them.
  if (islGullOn > 0.0) {
    vec3 pj = islProject(islGull);
    if (pj.z < zScene) {
      vec4 g = islGullSprite(sp, pj);
      col = mix(col, g.rgb, g.a);
    }
  }
  if (islBallOn > 0.0) {
    vec3 pj = islProject(islBall);
    if (pj.z < zScene) {
      vec4 b = islBalloonSprite(sp, pj);
      col = mix(col, b.rgb, b.a);
    }
  }

  // Mist, then rain and snow falling through the air down to each pixel's first surface.
  float fogK = K_fog;
  vec3 haze = (fogK > 0.0 || rain > 0.0) ? islHaze(rd) : vec3(0.0);
  if (fogK > 0.0) {
    vec3 fogCol = mix(haze, vec3(dot(haze, LUMA)), 0.4);
    col = mix(col, fogCol, fogAmount(fogK, 1.0 - exp(-zScene / 9.0), 0.0));
  }
  float dep = 1.0 - exp(-zScene * ISL_METRES / 30.0);
  if (rain > 0.0) {
    // The camera looks down on the island: the rain's paths converge toward the sea below it (the
    // lens shift moves the frame's centre ISL_LENS up the image plane).
    vec3 vanish = rainVanish(rainFallDir(rain, islWind), islRgt, islUp, islFwd, ISL_FOCAL);
    vanish.y -= ISL_LENS * vanish.z;
    Precip pr = rainFallSeen(uv, aspect, t, rain, islWind, dep, vanish);
    vec3 air = mix(vec3(dot(haze, LUMA)) * vec3(0.94, 0.97, 1.0), haze, 0.4);
    vec3 dropCol = max(greyed(haze, vec3(1.0), 0.5) * 1.2, vec3(0.08));
    col = precipOver(col, air, dropCol * (1.0 - 0.2 * pr.near), pr);
  }
  if (snow > 0.0) {
    Precip ps = snowFall(uv, aspect, t, snow, islWind, dep);
    float airL = dot(islAmb + 0.5 * islSky.sunColor + 0.4 * islSky.moonColor, LUMA);
    vec3 flake = vec3(0.95, 0.96, 1.0) * clamp(airL * 1.3 + 0.1, 0.0, 1.0);
    col = mix(col, flake * 0.92, ps.veil);
    float contrast = clamp((dot(flake, LUMA) - dot(col, LUMA)) * 3.0, 0.0, 1.0);
    col = mix(col, flake, clamp(ps.cover, 0.0, 1.0) * (0.85 - 0.2 * ps.near) * contrast);
  }

  vec3 rgb = clamp(col, 0.0, 1.0);
  return shadeOf(rgb, inkOf(rgb, 1.15, 1.0), clamp(accent, 0.0, 1.0));
}
`;
