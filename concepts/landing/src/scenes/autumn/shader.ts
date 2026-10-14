// The autumn park's picture, back to front: the sky (clouds, low sun) and three layers of far trees in
// haze; the lawn and the path (gravel, wet and pooled in rain) with the sun's long shadows and the
// canopy's dapple on them, the carpet of fallen leaves (one leaf per lattice cell in two layers, from
// the simulation: sim.ts) over a mottle of finer litter; the lamp post and the bench; the great tree's
// canopy as a solid mass and three layers of leaf sprites at three depths (back and mid behind the
// trunk, the front layer before it), its trunk and boughs between them; and the leaves in the air,
// each a plate the simulation tumbles (a maple, ginkgo or oak outline, two-toned: its paler underside
// shows when it turns over), sorted into the canopy's depths so a leaf can fall out from behind the
// front boughs and in front of the bench. Rain, mist, the lamp's halo and the M come last.
//
// Everything that moves cuts its edges per cell (hardFill / hardEdge) so it never shimmers: leaves,
// sprites, the dapple. The sun's light is the sky library's, with its elevation lifted a little so
// that shadows still reach the path; the sun stands behind the scene, so leaves are lit from behind
// and glow.
//
// Knobs read here: K_species, K_season, K_parkSeed, K_lamp, K_time, K_cycle, K_clouds, K_rain, K_fog,
// K_wind (the others, K_fall, K_gusts and K_mark, live in the simulation). Textures: see sim.ts.
import { autumnLayoutGlsl } from "./layout.ts";

export const autumnGlsl = `
// ---- autumn ----
${autumnLayoutGlsl}
const float AUTUMN_FOV = 0.9272952;   // 2 atan(0.5 / focal) for focal 1

// This pixel's light and the season, set once at the top of sceneAutumn.
Sky autumnSky;
vec3 autumnL;         // toward the light (x right, y up, z into the scene), unit
vec2 autumnSh;        // horizontal shift of a shadow per metre of height: L.xz / L.y
vec3 autumnSun;       // direct light
vec3 autumnAmb;       // sky light
vec3 autumnHaze;      // the haze the distance fades into, here
float autumnOvercast;
float autumnWet;
float autumnTm;       // the motion clock
float autumnGust;     // signed gust strength
float autumnThin;     // 0..1: how much of the canopy has gone
float autumnGreen;    // 0..1: how green the leaves still are
float autumnLate;     // 0..1: how brown the season has turned them
float autumnCarpet;   // the carpet's overall density
float autumnLampOn;   // 0..1: the lamp is lit
vec4 autumnBin[5];    // the nearest loose leaf in each depth bin (rgb, cover)
float autumnBinZ[5];

// ---- leaves ----

// A leaf's size relative to its species: tied to its hue so the sim and the shader agree.
float autumnLeafScale(float h) {
  return 0.9 + 0.2 * fract(h * 7.3);
}

float autumnLeafRadius() {
  return K_species < 0.5 ? 0.11 : (K_species < 1.5 ? 0.09 : 0.10);
}

// A leaf's upper face for hue h (0..1) at this season: maple crimson to gold, ginkgo butter to lemon,
// oak russet to ochre; early in the season some are still green, late they brown.
vec3 autumnLeafTop(float h) {
  vec3 c;
  if (K_species < 0.5) {
    c = mix(vec3(0.62, 0.06, 0.06), vec3(0.86, 0.17, 0.05), smoothstep(0.0, 0.45, h));
    c = mix(c, vec3(0.95, 0.46, 0.08), smoothstep(0.4, 0.75, h));
    c = mix(c, vec3(0.97, 0.74, 0.15), smoothstep(0.8, 1.0, h));
  } else if (K_species < 1.5) {
    c = mix(vec3(0.92, 0.60, 0.08), vec3(0.98, 0.82, 0.20), smoothstep(0.0, 0.6, h));
    c = mix(c, vec3(0.95, 0.89, 0.36), smoothstep(0.6, 1.0, h));
  } else {
    c = mix(vec3(0.50, 0.23, 0.09), vec3(0.74, 0.44, 0.12), smoothstep(0.0, 0.5, h));
    c = mix(c, vec3(0.82, 0.62, 0.18), smoothstep(0.5, 0.85, h));
    c = mix(c, vec3(0.50, 0.46, 0.14), smoothstep(0.85, 1.0, h));
  }
  float green = autumnGreen * (0.25 + 0.75 * fract(h * 5.3));
  c = mix(c, vec3(0.38, 0.52, 0.10), green);
  return mix(c, vec3(0.38, 0.20, 0.09), 0.5 * autumnLate);
}

// The blade of the leaf at q (its radius about 1, its tip toward +y, the stalk toward -y): a signed
// distance in leaf units, near its outline. k: this leaf's own random 0..1.
float autumnBlade(vec2 q, float k) {
  if (K_species < 0.5) {
    // A maple: five pointed lobes round a notch at the stalk.
    float a = abs(atan(q.x, q.y + 1e-5));
    float r = 0.36;
    r = max(r, pow(max(1.0 - a / 0.46, 0.0), 1.2));
    r = max(r, (0.84 + 0.1 * k) * pow(max(1.0 - abs(a - 1.08) / 0.42, 0.0), 1.2));
    r = max(r, 0.58 * pow(max(1.0 - abs(a - 2.1) / 0.38, 0.0), 1.2));
    r *= 1.0 - 0.8 * smoothstep(2.65, 3.1, a);
    return (length(q) - r) * 0.9;
  }
  if (K_species < 1.5) {
    // A ginkgo: a fan from its stalk, notched at the top.
    vec2 f = q + vec2(0.0, 0.7);
    float a = atan(f.x, f.y + 1e-5);
    float rr = length(f);
    float notch = exp(-a * a / 0.012);
    float outer = rr - (1.35 - 0.3 * notch);
    float wedge = (abs(a) - 0.92) * max(rr, 0.25);
    return max(max(outer, wedge), 0.18 - rr) * 0.85;
  }
  // An oak: long, narrowing to its base, three rounded lobes down each side.
  float t = clamp((q.y + 0.95) / 1.9, 0.0, 1.0);
  float w = 0.64 * pow(max(sin(3.14159 * pow(t, 0.85)), 0.0), 0.75) * (0.78 + 0.22 * cos(18.0 * t + 0.4 + 2.0 * k));
  return max(abs(q.x) - w, abs(q.y) - 0.95) * 0.85;
}

float autumnStalk(vec2 q) {
  float y0 = K_species < 0.5 ? -0.25 : (K_species < 1.5 ? -0.6 : -0.85);
  return segmentDistance(q, vec2(0.0, y0), vec2(0.03, y0 - 0.55)) - 0.045;
}

// Blade and stalk together: a signed distance in leaf units.
float autumnLeafD(vec2 q, float k) {
  return min(autumnBlade(q, k), autumnStalk(q));
}

// Distance to the leaf's veins (leaf units).
float autumnVein(vec2 q) {
  if (K_species < 0.5) {
    float d = segmentDistance(q, vec2(0.0, -0.3), vec2(0.0, 0.9));
    d = min(d, segmentDistance(q, vec2(0.0, 0.05), vec2(0.7, 0.5)));
    d = min(d, segmentDistance(q, vec2(0.0, 0.05), vec2(-0.7, 0.5)));
    d = min(d, segmentDistance(q, vec2(0.0, -0.1), vec2(0.5, -0.5)));
    return min(d, segmentDistance(q, vec2(0.0, -0.1), vec2(-0.5, -0.5)));
  }
  if (K_species < 1.5) {
    vec2 f = q + vec2(0.0, 0.7);
    float a = atan(f.x, f.y + 1e-5);
    return abs(fract(a * 3.2 + 0.5) - 0.5) / 3.2 * length(f);
  }
  float d = segmentDistance(q, vec2(0.0, -0.9), vec2(0.0, 0.9));
  d = min(d, segmentDistance(q, vec2(0.0, -0.3), vec2(0.5, 0.15)));
  d = min(d, segmentDistance(q, vec2(0.0, -0.3), vec2(-0.5, 0.15)));
  d = min(d, segmentDistance(q, vec2(0.0, 0.2), vec2(0.45, 0.6)));
  return min(d, segmentDistance(q, vec2(0.0, 0.2), vec2(-0.45, 0.6)));
}

// A leaf lit: h its hue, top whether its upper face is toward the viewer, nv its normal toward the
// viewer, lit whether the sun reaches it, vein 0..1, mark 1 for a leaf of the M (always gold).
// Sunlight through the leaf takes its colour: backlit leaves glow.
vec3 autumnLeafColour(float h, bool top, vec3 nv, float lit, float vein, float mark) {
  vec3 base = mark > 0.5 ? vec3(0.98, 0.72, 0.14) * (0.88 + 0.24 * h) : autumnLeafTop(h);
  vec3 face = top ? base : mix(base, vec3(dot(base, LUMA)), 0.4) * 1.1 + vec3(0.06, 0.05, 0.02);
  face *= 1.0 - 0.3 * vein;
  face = wetten(face, autumnWet * 0.8, 0.5);
  float front = max(dot(nv, autumnL), 0.0);
  float back = max(dot(-nv, autumnL), 0.0);
  vec3 sun = autumnSun * lit;
  vec3 col = face * (autumnAmb * 0.9 + sun * (front + 0.5 * back));
  col += face * face * sun * back * 1.1;
  col += autumnAmb * 0.3 * wetGloss(autumnWet, nv.y);
  return col;
}

// ---- light and shade ----

// The sun's light reaching world point P (x right, y up, z into the scene): 1 in full sun, smaller in
// the shadows of the trunk, the lamp post, the bench and the canopy (two leafy layers, offset along the
// light, their holes the sun's flecks). Callers cut the result per cell with hardEdge.
float autumnShadow(vec3 P) {
  vec2 sh = autumnSh;
  float lit = 1.0;
  float rise = max(AUTUMN_BOUGHS + 1.5 - P.y, 0.1);
  float dt = segmentDistance(P.xz, AUTUMN_TREE.xy, AUTUMN_TREE.xy - sh * rise);
  lit *= smoothstep(0.34, 0.5 + 0.01 * rise, dt);
  float lr = max(AUTUMN_LAMP.z - P.y, 0.1);
  float dl = segmentDistance(P.xz, AUTUMN_LAMP.xy, AUTUMN_LAMP.xy - sh * lr);
  lit *= smoothstep(0.02, 0.07 + 0.01 * lr, dl);
  if (P.y < 0.5) {
    vec2 q = P.xz + sh * (0.45 - P.y) - AUTUMN_BENCH_AT;
    lit *= 0.2 + 0.8 * smoothstep(-0.02, 0.05, sdBox(q, vec2(AUTUMN_BENCH_SIZE.x, 0.24), 0.0));
  }
  if (P.y < 0.85) {
    vec2 q = P.xz + sh * (0.75 - P.y) - AUTUMN_BENCH_AT - vec2(0.0, 0.22);
    lit *= 0.45 + 0.55 * smoothstep(0.0, 0.05, sdBox(q, vec2(AUTUMN_BENCH_SIZE.x, 0.04), 0.0));
  }
  for (int k = 0; k < 2; k++) {
    float hc = k == 0 ? 5.0 : 7.4;
    vec2 shift = sh * (hc - P.y);
    shift *= min(1.0, 10.0 / max(length(shift), 1e-4));
    vec2 Q = P.xz + shift;
    float fp = 1.0 - smoothstep(0.55, 1.0, length((Q - AUTUMN_CANOPY.xy) / (AUTUMN_CANOPY.z * vec2(1.0, 0.85))));
    if (fp <= 0.0) continue;
    vec2 sway = 0.3 * vec2(sin(autumnTm * 0.31 + hc), cos(autumnTm * 0.27 + 2.0 * hc)) + vec2(autumnGust * 0.5, 0.0);
    float n = fbm3((Q + sway) * 0.75 + vec2(K_parkSeed * 2.3 + hc, 1.1));
    float leaf = fp * smoothstep(0.30 + 0.45 * autumnThin, 0.52 + 0.45 * autumnThin, n + 0.25 * (fp - 0.5));
    lit *= 1.0 - 0.9 * leaf;
  }
  return lit;
}

// The lamp's light on a ground point or leaf at (x, z): a warm pool under it.
vec3 autumnLampLight(vec2 w) {
  vec2 dl = w - AUTUMN_LAMP.xy;
  return vec3(1.0, 0.72, 0.38) * autumnLampOn * 1.6 / pow(1.0 + dot(dl, dl) / 6.0, 1.5);
}

// ---- the carpet ----

// One layer of the carpet at ground point pw (metres): the leaf there (rgb, cover) and whether it is
// one of the M's. layer 0 is the lattice, layer 1 the lattice shifted half a cell. aa: metres a cell
// covers; lit: the sun reaches the ground here (0 or 1).
vec4 autumnCarpetLayer(vec2 pw, float layer, float aa, float lit, float lod, out float isMark) {
  isMark = 0.0;
  vec2 g = (pw - AUTUMN_CARPET.xy) / AUTUMN_CARPET.z - 0.5 * layer;
  vec2 i0 = floor(g);
  vec2 f = g - i0;
  vec2 nb = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
  vec4 best = vec4(0.0);
  float dissolve = edgeThreshold(gl_FragCoord.xy, vec2(5.0, 2.0));
  for (int k = 0; k < 4; k++) {
    vec2 id = i0 + vec2(float(k - 2 * (k / 2)) * nb.x, float(k / 2) * nb.y);
    if (id.x < 0.0 || id.y < 0.0 || id.x >= float(AUTUMN_CARPET_SIZE.x) || id.y >= float(AUTUMN_CARPET_SIZE.y)) continue;
    vec4 c = layer < 0.5 ? texelFetch(uSim1, ivec2(id), 0) : texelFetch(uSim2, ivec2(id), 0);
    float aw = abs(c.w);
    if (aw < 1.0) continue;
    float mk = step(16.0, aw);
    aw -= 16.0 * mk;
    float level = floor(aw);
    if (level / 8.0 <= dissolve) continue;
    float hue = clamp(fract(aw) / 0.98, 0.0, 1.0);
    vec2 d = (g - (id + 0.5 + c.xy)) * AUTUMN_CARPET.z;
    float R = autumnLeafRadius() * autumnLeafScale(hue);
    if (dot(d, d) > R * R * 2.3) continue;
    float ca = cos(c.z);
    float sa = sin(c.z);
    vec2 q = vec2(-sa * d.x + ca * d.y, ca * d.x + sa * d.y) / R;
    float k1 = hash12(id + layer * 17.0);
    float cov = hardFill(autumnLeafD(q, k1) * R, aa);
    cov *= mk > 0.5 ? 1.0 : 1.0 - smoothstep(0.22, 0.6, lod);
    if (cov <= 0.0) continue;
    float vein = 0.0;
    if (R / aa > 7.0) vein = hardFill(autumnVein(q) - 0.04, aa / R);
    bool top = c.w > 0.0;
    vec3 col = autumnLeafColour(hue, top, vec3(0.0, 1.0, 0.0), lit, vein, mk);
    col += autumnLeafTop(hue) * autumnLampLight(pw) * 0.7;
    best = vec4(col, 1.0);
    isMark = mk;
  }
  return best;
}

// ---- the ground ----

// The lawn, path and carpet under the pixel: the colour, the depth in metres, whether it is a leaf of
// the M, and the dryness.
vec3 autumnGround(vec2 uv, float aspect, float t, out float depthZ, out float markCov) {
  Ground g = planeAt(uv, aspect, AUTUMN_HORIZON, AUTUMN_EYE, AUTUMN_FOCAL);
  vec2 w = g.p;
  depthZ = w.y;
  markCov = 0.0;
  float aa = 0.8 * sqrt(g.foot.x * g.foot.y);
  float lod = g.foot.y;

  // The path: gravel with a ragged edge.
  float wob = vnoise(vec2(w.y * 1.9 + 3.0, 7.0)) - 0.5;
  float dPath = abs(w.x - autumnPathX(w.y)) - AUTUMN_PATH_HALF * (1.0 + 0.18 * wob);
  float onPath = 1.0 - smoothstep(-0.1, 0.18, dPath);

  float broad = fbm3(w * 0.45 + K_parkSeed * 1.3);
  vec3 grass = mix(vec3(0.24, 0.32, 0.09), vec3(0.50, 0.46, 0.16), smoothstep(0.35, 0.75, broad));
  float fineFade = (1.0 - smoothstep(0.02, 0.06, g.foot.x)) * (1.0 - smoothstep(0.05, 0.15, g.foot.y));
  grass *= 1.0 + (vnoise(w * 3.0) - 0.5) * 0.2 * fineFade;
  vec3 gravel = mix(vec3(0.56, 0.47, 0.35), vec3(0.70, 0.61, 0.46), vnoise(w * 2.2));
  gravel *= 1.0 + (hash12(floor(w * 14.0)) - 0.5) * 0.14 * fineFade;
  vec3 albedo = mix(grass, gravel, onPath);
  albedo *= 1.0 - 0.25 * smoothfall(0.12, 0.0, abs(dPath));

  // Litter: finer than the carpet's leaves, a mottle of leaf colours that thickens with the season,
  // under the tree, and off the path; far away it is averaged into the colour.
  vec2 tc = w - AUTUMN_CANOPY.xy;
  float shape = (0.8 + 0.5 * exp(-dot(tc, tc) / 98.0)) * (1.0 - 0.35 * onPath);
  float dens = min(0.95, autumnCarpet * shape);
  vec2 gs = w / 0.17;
  vec2 sid = floor(gs);
  vec2 sj = hash22(sid + 7.0);
  float speckD = length(fract(gs) - 0.5 - (sj - 0.5) * 0.4) - 0.3;
  float speckLod = 1.0 - smoothstep(0.08, 0.2, g.foot.y);
  float speck = (hash12(sid + 41.0) < dens * 0.8 ? 1.0 : 0.0) * hardFill(speckD, aa / 0.17) * speckLod;
  vec3 speckCol = autumnLeafTop(hash12(sid + 3.0)) * 0.75;
  albedo = mix(albedo, speckCol, speck * 0.9);
  albedo = mix(albedo, autumnLeafTop(0.35) * 0.62, dens * 0.5 * (1.0 - speckLod));
  albedo = wetten(albedo, autumnWet, mix(0.8, 0.45, onPath));

  float lit = hardEdge(autumnShadow(vec3(w.x, 0.0, w.y)));
  vec3 light = autumnAmb * 0.95 + autumnSun * (autumnL.y * lit * 1.25) + autumnLampLight(w);
  vec3 col = albedo * light;

  // Water pools on the path and low in the lawn, mirroring the sky; rings spread in it while it rains.
  float pool = rainPuddles(w * 0.8, autumnWet) * (0.4 + 0.6 * onPath);
  if (pool > 0.0) {
    vec3 mirror = autumnHaze * 0.9 + autumnLampLight(w) * 0.5;
    col = mix(col, mirror, pool * 0.75);
    if (K_rain > 0.0) {
      vec3 ring = rainRipples(w * 1.8, t, K_rain);
      col += vec3(ring.z) * 0.3 * pool * (1.0 - smoothstep(0.05, 0.2, g.foot.y));
    }
  }
  if (K_rain > 0.0 && g.foot.x < 0.067) {
    float splash = rainSplashes(w * (uRes.y / 200.0), t, K_rain);
    col = mix(col, max(autumnAmb * 1.2, vec3(0.1)), splash * 0.5 * (1.0 - pool));
  }

  // The carpet: the half-shifted layer first, the lattice over it.
  float m1 = 0.0;
  float m2 = 0.0;
  vec4 lb = autumnCarpetLayer(w, 1.0, aa, lit, lod, m2);
  col = mix(col, lb.rgb, lb.a);
  vec4 la = autumnCarpetLayer(w, 0.0, aa, lit, lod, m1);
  col = mix(col, la.rgb, la.a);
  markCov = max(m2 * lb.a, m1 * la.a);

  // The haze takes the far lawn.
  return mix(col, autumnHaze, 1.0 - exp(-w.y * 0.012));
}

// ---- the sky and the far trees ----

vec3 autumnBackdrop(vec2 uv, vec2 p, vec3 dir, float t, out float depthZ) {
  vec3 sk = skyColor(autumnSky, dir);
  sk += skyStarLight(autumnSky, dir, 0.5) * (1.0 - autumnOvercast);
  vec4 cl = skyClouds(autumnSky, dir, t, max(K_clouds, autumnOvercast), K_wind);
  sk = mix(sk, cl.rgb, cl.a);
  sk = greyed(sk, vec3(0.94, 0.96, 1.0), 0.55 * autumnOvercast);
  depthZ = 1e4;
  if (K_rain > 0.0) {
    float shaft = rainShafts(dir.xy / (max(dir.z, 0.2) * 0.3), uMotionTime, K_rain, K_wind);
    sk = mix(sk, autumnAmb * 1.3 + vec3(0.1), shaft * 0.6);
  }
  vec3 col = sk;
  // Three rows of far crowns, far to near, each lost a little more in haze.
  if (p.y < AUTUMN_HORIZON + 0.14) {
    for (int k = 2; k >= 0; k--) {
      float fk = float(k);
      float w = 0.20 - 0.045 * fk;
      float hMax = 0.10 - 0.025 * fk;
      float zk = 38.0 + 30.0 * fk + 10.0 * fk * fk;
      float aerial = 0.45 + 0.17 * fk;
      float gx = (p.x + 0.31 * fk + K_parkSeed * 0.01) / w;
      float id0 = floor(gx);
      float best = 0.0;
      vec3 treeCol = vec3(0.0);
      for (int j = -1; j <= 1; j++) {
        float tid = id0 + float(j);
        float h = hash12(vec2(tid, fk * 7.0 + K_parkSeed));
        float h2 = hash12(vec2(tid * 1.7, fk * 3.0 + 1.0));
        float h3 = hash12(vec2(tid * 2.3, fk * 5.0 + 2.0));
        float cx = (tid + 0.5 + (h - 0.5) * 0.4) * w - 0.31 * fk - K_parkSeed * 0.01;
        float hgt = hMax * (0.45 + 0.75 * h2);
        float a = w * (0.5 + 0.3 * h3);
        float d = sdEllipse(vec2(p.x - cx, p.y - (AUTUMN_HORIZON - 0.004 + 0.5 * hgt)), vec2(a, 0.5 * hgt));
        float cov = hardFill(d, 0.0012);
        if (cov > 0.0) {
          best = 1.0;
          float tone = hash12(vec2(tid * 1.3, fk + 4.1));
          vec3 c = tone > 0.84 ? vec3(0.10, 0.20, 0.12) : autumnLeafTop(tone / 0.84) * (0.7 + 0.3 * h);
          float top = clamp((p.y - AUTUMN_HORIZON) / hgt, 0.0, 1.0);
          c *= (0.9 + 0.25 * top) * (0.88 + 0.24 * vnoise(p * 70.0));
          treeCol = c * (autumnAmb * 0.8 + autumnSun * 0.55);
        }
      }
      if (best > 0.0) {
        col = mix(treeCol, autumnHaze, aerial);
        depthZ = zk;
      }
    }
  }
  return col;
}

// ---- the lamp post ----

// The lamp post at depth: its iron (rgb, cover) and how brightly its glass shines.
vec4 autumnLampPost(vec2 p, out float glass) {
  glass = 0.0;
  float s = AUTUMN_FOCAL / AUTUMN_LAMP.y;
  vec2 q = vec2(p.x / s - AUTUMN_LAMP.x, (p.y - (AUTUMN_HORIZON - AUTUMN_EYE * s)) / s);
  if (abs(q.x) > 0.5 || q.y < -0.05 || q.y > AUTUMN_LAMP.z + 0.3) return vec4(0.0);
  float aa = 0.8 / (uRes.y * s);
  float hb = AUTUMN_LAMP.z - 0.55;
  float r = 0.045 + 0.07 * smoothfall(0.55, 0.0, q.y) + 0.015 * smoothfall(0.25, 0.0, abs(q.y - 1.4));
  float dPost = max(abs(q.x) - r, q.y - hb);
  float dPlate = sdBox(vec2(q.x, q.y - hb - 0.02), vec2(0.11, 0.03), 0.0);
  // The lantern: a tapering cage of glass with a cap and a finial.
  float wl = 0.15 + 0.03 * (q.y - hb) / 0.45;
  float dBody = max(abs(q.x) - wl, max(hb + 0.05 - q.y, q.y - (hb + 0.5)));
  float dGlass = dBody + 0.025;
  float capT = clamp((q.y - (hb + 0.5)) / 0.24, 0.0, 1.0);
  float dCap = max(abs(q.x) - (0.23 * (1.0 - capT) + 0.012), max(hb + 0.5 - q.y, q.y - (hb + 0.76)));
  float dIron = min(min(dPost, dPlate), min(dCap, 1e3));
  float cage = max(dBody, -dGlass);
  dIron = min(dIron, cage);
  float dAll = min(dIron, dBody);
  float cov = hardFill(dAll, aa);
  if (cov <= 0.0) return vec4(0.0);
  float nx = clamp(q.x / max(r, 0.02), -1.0, 1.0);
  vec3 N = vec3(nx, 0.0, -sqrt(max(1.0 - nx * nx, 0.0)));
  vec3 iron = vec3(0.09, 0.10, 0.09) * (autumnAmb * 0.9 + autumnSun * max(dot(N, autumnL), 0.0) * 0.7 + 0.04);
  if (dBody < 0.0 && dGlass < 0.0 && dIron > 0.0) {
    glass = 1.0;
    vec3 lamp = vec3(1.0, 0.78, 0.42) * 1.2;
    vec3 shine = mix(autumnHaze * 0.55, lamp, autumnLampOn);
    return vec4(shine, cov);
  }
  return vec4(iron, cov);
}

// ---- the bench ----

// A park bench seen from the front: wooden boards on iron ends, a few fallen leaves on the seat.
vec4 autumnBench(vec2 p) {
  float s = AUTUMN_FOCAL / AUTUMN_BENCH_AT.y;
  vec2 q = vec2(p.x / s - AUTUMN_BENCH_AT.x, (p.y - (AUTUMN_HORIZON - AUTUMN_EYE * s)) / s);
  if (abs(q.x) > 1.05 || q.y < -0.03 || q.y > 1.0) return vec4(0.0);
  float aa = 0.8 / (uRes.y * s);
  float legs = max(abs(abs(q.x) - 0.8) - 0.03, max(-q.y, q.y - 0.9));
  float arm = sdBox(vec2(abs(q.x) - 0.8, q.y - 0.63), vec2(0.06, 0.02), 0.0);
  float seatFront = sdBox(vec2(q.x, q.y - 0.425), vec2(0.86, 0.028), 0.0);
  float seatTop = sdBox(vec2(q.x, q.y - 0.49), vec2(0.86, 0.04), 0.0);
  float bi = floor((q.y - 0.55) / 0.115);
  float fy = q.y - 0.55 - (bi + 0.5) * 0.115;
  float board = (bi < -0.5 || bi > 2.5) ? 1.0 : max(abs(fy) - 0.045, abs(q.x) - 0.8);
  float dWood = min(min(seatFront, seatTop), board);
  float dIron = min(legs, arm);
  float cov = hardFill(min(dWood, dIron), aa);
  if (cov <= 0.0) return vec4(0.0);
  vec3 wood = vec3(0.45, 0.29, 0.15) * (0.82 + 0.3 * vnoise(vec2(q.x * 2.0, q.y * 40.0)));
  float sunLit = hardEdge(autumnShadow(vec3(AUTUMN_BENCH_AT.x + q.x, 0.5, AUTUMN_BENCH_AT.y)));
  wood = wetten(wood, autumnWet, 0.7);
  vec3 col;
  if (dIron < dWood) {
    col = vec3(0.07, 0.08, 0.07) * (autumnAmb * 0.9 + autumnSun * sunLit * 0.25);
  } else if (seatTop <= seatFront && seatTop < board) {
    // The seat's top, lit from above, with a line between its slats and the leaves that have settled.
    col = wood * 1.1 * (autumnAmb + autumnSun * (autumnL.y * 1.2 * sunLit));
    col *= 1.0 - 0.35 * smoothfall(0.006, 0.0, abs(q.y - 0.49));
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float cx = -0.52 + 0.58 * fi + 0.08 * hash12(vec2(fi, K_parkSeed));
      float d = sdEllipse(vec2(q.x - cx, q.y - 0.49 - 0.006 * fi), vec2(0.085, 0.026));
      if (hardFill(d, aa) > 0.0) {
        col = autumnLeafColour(fract(0.31 + 0.27 * fi), true, vec3(0.0, 1.0, 0.0), sunLit, 0.0, 0.0);
      }
    }
  } else {
    // The faces toward the viewer lie in the sun's shade: ambient, and a bright edge on top.
    col = wood * (autumnAmb * 0.75 + autumnSun * (max(-autumnL.z, 0.0) * 0.5 * sunLit));
    col += autumnSun * sunLit * 0.45 * smoothfall(0.016, 0.0, abs(fy - 0.045)) * step(board, min(seatFront, seatTop));
  }
  return vec4(col, cov);
}

// ---- the tree ----

// The trunk and its boughs at the tree's depth, as a signed distance in metres: q = (across from the
// trunk's foot, height).
float autumnTreeD(vec2 q) {
  float lean = 0.16 * sin(0.55 * q.y + 1.0) - 0.03 * q.y;
  float rt = AUTUMN_TREE.z * (1.0 + 0.9 * exp(-q.y * 2.2)) * (1.0 - 0.06 * q.y);
  float d = max(abs(q.x - lean) - rt, max(-0.2 - q.y, q.y - 4.0));
  if (q.y > 2.4) {
    d = min(d, sdTaperCapsule(q, vec2(-0.1, 2.9), vec2(-1.9, 4.3), 0.26, 0.15));
    d = min(d, sdTaperCapsule(q, vec2(-1.9, 4.3), vec2(-4.6, 5.4), 0.15, 0.07));
    d = min(d, sdTaperCapsule(q, vec2(-1.9, 4.3), vec2(-2.6, 6.4), 0.12, 0.06));
    d = min(d, sdTaperCapsule(q, vec2(0.1, 3.1), vec2(1.8, 4.5), 0.24, 0.14));
    d = min(d, sdTaperCapsule(q, vec2(1.8, 4.5), vec2(4.4, 5.2), 0.14, 0.06));
    d = min(d, sdTaperCapsule(q, vec2(1.8, 4.5), vec2(2.4, 6.6), 0.10, 0.05));
    d = min(d, sdTaperCapsule(q, vec2(0.0, 3.3), vec2(0.35, 6.2), 0.24, 0.11));
    d = min(d, sdTaperCapsule(q, vec2(-0.3, 3.6), vec2(-0.9, 6.0), 0.16, 0.07));
  }
  return d;
}

// The trunk and boughs (rgb, cover): bark ridged and mossy at the foot, lit on the side toward the sun.
vec4 autumnTrunk(vec2 p) {
  float s = AUTUMN_FOCAL / AUTUMN_TREE.y;
  vec2 q = vec2(p.x / s - AUTUMN_TREE.x, (p.y - (AUTUMN_HORIZON - AUTUMN_EYE * s)) / s);
  if (q.y < -0.3) return vec4(0.0);
  float aa = 0.8 / (uRes.y * s);
  float d = autumnTreeD(q);
  if (d > 0.1) return vec4(0.0);
  float cov = hardFill(d, aa);
  if (cov <= 0.0) return vec4(0.0);
  // A pseudo-normal: the outline's slope toward the viewer in the middle, round at the edge.
  float e = 0.03;
  vec2 grad = vec2(autumnTreeD(q + vec2(e, 0.0)) - autumnTreeD(q - vec2(e, 0.0)), autumnTreeD(q + vec2(0.0, e)) - autumnTreeD(q - vec2(0.0, e)));
  float gl = length(grad);
  vec2 gdir = gl > 1e-5 ? grad / gl : vec2(0.0, 1.0);
  float rad = mix(AUTUMN_TREE.z * 1.2, 0.14, smoothstep(2.6, 3.4, q.y));
  float m = clamp(1.0 + d / rad, 0.0, 1.0);
  vec3 N = vec3(gdir * m, -sqrt(max(1.0 - m * m, 0.0)));
  vec3 bark = K_species < 0.5 ? vec3(0.36, 0.30, 0.25) : (K_species < 1.5 ? vec3(0.42, 0.37, 0.31) : vec3(0.26, 0.21, 0.17));
  float fineBark = 1.0 - smoothstep(0.08, 0.2, 1.0 / (uRes.y * s) * 8.0);
  float ridge = 0.6 * smoothstep(0.35, 0.65, vnoise(vec2(q.x * 10.0, q.y * 0.9 + 3.0))) + 0.4 * mix(0.5, vnoise(vec2(q.x * 22.0, q.y * 2.0)), fineBark);
  vec3 albedo = bark * (0.65 + 0.55 * ridge);
  float moss = 0.5 * smoothfall(1.4, 0.2, q.y) * smoothstep(0.4, 0.7, vnoise(vec2(q.x * 5.0, q.y * 3.0)));
  albedo = mix(albedo, vec3(0.22, 0.30, 0.10), moss);
  albedo = wetten(albedo, autumnWet, 0.6);
  float sunLit = hardEdge(autumnShadow(vec3(AUTUMN_TREE.x + q.x, q.y, AUTUMN_TREE.y)));
  vec3 col = albedo * (autumnAmb * 0.75 + autumnSun * sunLit * (max(dot(N, autumnL), 0.0) * 1.2 + 0.1));
  return vec4(col, cov);
}

// ---- the canopy ----

// How much canopy there is at screen point p: 0 sky .. 1 solid. Its underside is ragged and droops
// round the trunk; holes open and the whole thins as the season runs on.
float autumnMass(vec2 p) {
  float seed = K_parkSeed;
  float edge = 0.70 + 0.05 * sin(p.x * 2.1 + 1.3 + seed * 0.7) + 0.04 * sin(p.x * 5.3 + seed) + 0.08 * (fbm3(vec2(p.x * 2.2 + seed * 1.7, 2.0)) - 0.5);
  float tx = (p.x - AUTUMN_TREE.x / AUTUMN_TREE.y * AUTUMN_FOCAL) / 0.55;
  edge -= 0.09 * exp(-tx * tx);
  float base = smoothstep(edge - 0.02, edge + 0.10, p.y);
  float holes = fbm3(p * 2.6 + vec2(seed * 3.1, 1.7));
  float cut = mix(0.55, 1.25, autumnThin);
  return base * smoothstep(cut, cut + 0.12, holes + 0.25 * base);
}

// One layer of the canopy's leaves: a jittered lattice of cs-wide cells in screen space, a leaf in
// each cell where there is canopy, each swaying a little; shadeK dims the layer (the far ones).
vec4 autumnCanopyLayer(vec2 p, float cs, float salt, float shadeK) {
  vec2 off = vec2(salt * 0.37, salt * 0.61);
  vec2 g = p / cs + off;
  vec2 i0 = floor(g);
  vec2 f = g - i0;
  vec2 nb = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
  vec4 best = vec4(0.0);
  float bestK = 2.0;
  float aa = 0.8 / uRes.y;
  for (int k = 0; k < 4; k++) {
    vec2 id = i0 + vec2(float(k - 2 * (k / 2)) * nb.x, float(k / 2) * nb.y);
    float h = hash12(id + salt * 11.3);
    vec2 jit = hash22(id + salt * 5.7);
    vec2 cp = (id + 0.5 + (jit - 0.5) * 0.6 - off) * cs;
    if (h > autumnMass(cp) * 0.95) continue;
    float h2 = hash12(id * 1.7 + salt);
    float ph = h * 18.85;
    vec2 sway = vec2(sin(autumnTm * 0.55 + ph), cos(autumnTm * 0.43 + ph * 1.3)) * cs * (0.05 + 0.06 * abs(K_wind) + 0.14 * abs(autumnGust));
    vec2 d = p - cp - sway;
    float r = cs * 0.62 * autumnLeafScale(h2);
    if (dot(d, d) > r * r * 2.4) continue;
    float ang = (hash12(id + 9.1 + salt) - 0.5) * 6.2831 + 0.12 * sin(autumnTm * 0.31 + ph);
    vec2 q = rotate(d, -ang) / r;
    if (h2 >= bestK) continue;
    float cov = hardFill(autumnLeafD(q, h2) * r, aa);
    if (cov <= 0.0) continue;
    bool top = hash12(id + 3.3 + salt) < 0.55;
    float hue = hash12(id * 0.37 + salt * 2.1);
    vec3 nv = normalize(vec3((jit.x - 0.5) * 1.4, (jit.y - 0.5) * 1.2 + 0.25, -1.0));
    float lit = hash12(id + 13.1 + salt) > 0.18 ? 1.0 : 0.0;
    best = vec4(autumnLeafColour(hue, top, nv, lit, 0.0, 0.0) * shadeK, 1.0);
    bestK = h2;
  }
  return best;
}

// The canopy's solid mass behind its leaves: shadowy leaves and boughs lit through.
vec4 autumnCanopyMass(vec2 p) {
  float mass = autumnMass(p);
  if (mass <= 0.0) return vec4(0.0);
  vec3 c = autumnLeafTop(fract(vnoise(p * 9.0) * 1.7 + 0.1)) * 0.3 * (autumnAmb * 0.7 + autumnSun * 0.45);
  return vec4(c, hardEdge(mass));
}

// ---- loose leaves ----

// The leaves in the air at this pixel: the nearest in each of five depth bins, in autumnBin.
// opaqueZ: the depth of what the pixel shows already (ground, bench, lamp), which hides the farther ones.
void autumnLoose(vec2 p, float opaqueZ) {
  for (int b = 0; b < 5; b++) {
    autumnBin[b] = vec4(0.0);
    autumnBinZ[b] = 1e4;
  }
  if (uSimOn.x < 0.5) return;
  float aa = 0.8 / uRes.y;
  for (int i = 0; i < AUTUMN_SLOTS; i++) {
    vec4 a = texelFetch(uSim0, ivec2(0, i), 0);
    if (a.w <= 0.0) continue;
    vec2 d = p - a.xy;
    float rr = a.z;
    if (dot(d, d) > rr * rr * 2.4) continue;
    vec4 e = texelFetch(uSim0, ivec2(2, i), 0);
    float z = e.w;
    if (z > opaqueZ + 0.5) continue;
    int b = z < 4.2 ? 0 : (z < 5.0 ? 1 : (z < 7.0 ? 2 : (z < 9.5 ? 3 : 4)));
    if (z >= autumnBinZ[b]) continue;
    vec4 axes = texelFetch(uSim0, ivec2(1, i), 0);
    vec4 info = texelFetch(uSim0, ivec2(3, i), 0);
    // The plate's two axes on the screen (t' = axes.xy along the leaf's tip, s' = axes.zw across it):
    // the leaf-local point whose image is this pixel, and which face looks at us.
    float det = axes.x * axes.w - axes.y * axes.z;
    float dm = (det > 0.0 ? -1.0 : 1.0) * max(abs(det), 0.1);
    vec2 u = d / rr;
    vec2 q = vec2(axes.y * u.x - axes.x * u.y, -axes.w * u.x + axes.z * u.y) / dm;
    if (dot(q, q) > 2.4) continue;
    float scale = rr * sqrt(max(abs(det), 0.1));
    float cov = hardFill(autumnLeafD(q, info.y) * scale, aa);
    // A leaf that has just let go dissolves in, a cell at a time.
    cov *= step(edgeThreshold(gl_FragCoord.xy, vec2(3.0, 9.0)), a.w);
    if (cov <= 0.0) continue;
    float vein = 0.0;
    if (scale * uRes.y > 7.0) vein = hardFill(autumnVein(q) - 0.04, aa / scale);
    bool top = det > 0.0;
    vec3 n = e.xyz;
    vec3 P = vec3(a.x * z, AUTUMN_EYE + (a.y - AUTUMN_HORIZON) * z, z);
    float lit = hardEdge(autumnShadow(P));
    vec3 col = autumnLeafColour(info.x, top, top ? n : -n, lit, vein, 0.0);
    col += autumnLeafTop(info.x) * autumnLampLight(P.xz) * 0.5 * step(P.y, 1.0);
    autumnBin[b] = vec4(col, 1.0);
    autumnBinZ[b] = z;
  }
}

// ---- the picture ----

void autumnSetup(float t) {
  autumnTm = uMotionTime;
  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, autumnTm));
  autumnSky = sky;
  autumnOvercast = weatherOvercast(K_rain, 0.0);
  autumnWet = clamp(uWeather.x, 0.0, 1.0);
  // The key light: the sun (or the moon once the sun is down), its direction kept but lifted so that
  // its shadows still fall on the park rather than far beyond it.
  bool moonKey = sky.sun.y < -0.02;
  vec3 key = moonKey ? sky.moon : sky.sun;
  vec3 keyCol = moonKey ? sky.moonColor * 1.6 : sky.sunColor;
  float elev = 0.25 + 0.55 * max(key.y, 0.0);
  vec2 hz = key.xz;
  hz = dot(hz, hz) > 1e-6 ? normalize(hz) : vec2(-0.8, 0.6);
  autumnL = normalize(vec3(hz.x * cos(elev), sin(elev), hz.y * cos(elev)));
  autumnSh = autumnL.xz / autumnL.y;
  autumnSun = keyCol * (1.0 - 0.9 * autumnOvercast) * 1.2;
  vec3 amb = sky.ambient;
  amb = mix(amb, vec3(dot(amb, LUMA)) * vec3(1.04, 1.0, 0.92), 0.3);
  amb = greyed(amb, vec3(0.95, 0.97, 1.0), 0.6 * autumnOvercast);
  autumnAmb = amb * (1.0 - 0.25 * autumnOvercast);
  float season = clamp(K_season, 0.0, 1.0);
  autumnThin = smoothstep(0.3, 1.0, season);
  autumnGreen = 1.0 - smoothstep(0.05, 0.4, season);
  autumnLate = smoothstep(0.55, 1.0, season);
  autumnCarpet = 0.14 + 0.86 * pow(season, 0.85);
  autumnLampOn = K_lamp * (1.0 - smoothstep(0.1, 0.34, dot(autumnAmb, LUMA) + 0.2 * dot(autumnSun, LUMA)));
  autumnGust = uSimOn.w > 0.5 ? texelFetch(uSim3, ivec2(0, 0), 0).x : 0.0;
}

Shade sceneAutumn(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  // The park is laid out for a wide frame; a narrower one squeezes it rather than lose the tree.
  float aspectE = max(aspect, 1.45);
  vec2 p = vec2((uv.x - 0.5) * aspectE, uv.y);
  autumnSetup(t);
  vec3 dir = viewRay(uv, aspectE, AUTUMN_HORIZON, AUTUMN_FOV);
  autumnHaze = horizonHaze(autumnSky, dir, 0.03);
  autumnHaze = greyed(autumnHaze, vec3(0.97, 0.98, 1.0), 0.5 * autumnOvercast);

  float markCov = 0.0;
  float hitZ = 1e4;
  vec3 col;
  if (uv.y < AUTUMN_HORIZON - 1e-4) {
    col = autumnGround(uv, aspectE, t, hitZ, markCov);
  } else {
    col = autumnBackdrop(uv, p, dir, t, hitZ);
  }
  float opaqueZ = hitZ;

  // The lamp post and the bench stand on the ground; what is nearer than they are shows over them.
  float glass = 0.0;
  vec4 lamp = autumnLampPost(p, glass);
  if (lamp.a > 0.0) {
    col = mix(col, lamp.rgb, lamp.a);
    hitZ = min(hitZ, AUTUMN_LAMP.y);
    opaqueZ = min(opaqueZ, AUTUMN_LAMP.y);
    markCov = 0.0;
  }
  vec4 bench = autumnBench(p);
  if (bench.a > 0.0) {
    col = mix(col, bench.rgb, bench.a);
    hitZ = min(hitZ, AUTUMN_BENCH_AT.y);
    opaqueZ = min(opaqueZ, AUTUMN_BENCH_AT.y);
    markCov = 0.0;
  }

  autumnLoose(p, opaqueZ);
  col = mix(col, autumnBin[4].rgb, autumnBin[4].a);

  bool high = uv.y > 0.4;
  if (high) {
    // Back: the mass and the farthest leaves, 9.5 m off.
    vec4 mass = autumnCanopyMass(p);
    vec4 back = autumnCanopyLayer(p, 0.030, 1.0, 0.62);
    vec4 c = back.a > 0.5 ? back : mass;
    if (c.a > 0.0) {
      col = mix(col, c.rgb, c.a);
      hitZ = min(hitZ, 9.5);
    }
  }
  col = mix(col, autumnBin[3].rgb, autumnBin[3].a);
  if (high) {
    vec4 mid = autumnCanopyLayer(p, 0.040, 2.0, 0.9);
    if (mid.a > 0.0) {
      col = mix(col, mid.rgb, mid.a);
      hitZ = min(hitZ, 7.0);
    }
  }
  col = mix(col, autumnBin[2].rgb, autumnBin[2].a);
  vec4 trunk = autumnTrunk(p);
  if (trunk.a > 0.0) {
    col = mix(col, trunk.rgb, trunk.a);
    hitZ = min(hitZ, AUTUMN_TREE.y);
    markCov = 0.0;
  }
  col = mix(col, autumnBin[1].rgb, autumnBin[1].a);
  if (high) {
    vec4 front = autumnCanopyLayer(p, 0.052, 3.0, 1.0);
    if (front.a > 0.0) {
      col = mix(col, front.rgb, front.a);
      hitZ = min(hitZ, 4.2);
    }
  }
  col = mix(col, autumnBin[0].rgb, autumnBin[0].a);

  // The lamp's halo, when it is lit.
  if (autumnLampOn > 0.0) {
    float s = AUTUMN_FOCAL / AUTUMN_LAMP.y;
    vec2 lc = vec2((AUTUMN_LAMP.x) * s, AUTUMN_HORIZON + (AUTUMN_LAMP.z - 0.3 - AUTUMN_EYE) * s);
    vec2 dl = (p - lc) / 0.07;
    col += vec3(1.0, 0.72, 0.36) * autumnLampOn * (0.45 + 0.5 * autumnWet) * exp(-dot(dl, dl) * 0.6);
  }

  // Rain falls through the depth of what each cell shows; mist thickens with distance.
  float depth = 1.0 - exp(-hitZ / 30.0);
  if (K_rain > 0.0) {
    Precip pr = rainFall(uv, aspect, t, K_rain, K_wind, depth);
    vec3 drop = max(autumnAmb * 1.2, vec3(0.08)) + autumnSun * 0.2;
    col = precipOver(col, autumnHaze * 0.9, drop, pr);
  }
  if (K_fog > 0.0) {
    col = mix(col, autumnHaze, fogAmount(K_fog, depth, max(uv.y - AUTUMN_HORIZON, 0.0)));
  }

  return shadeOf(col, inkOf(col, 1.3, 0.8), markCov);
}
`;
