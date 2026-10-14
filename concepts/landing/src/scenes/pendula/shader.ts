// The pendulum wave: a row of pendulums of slowly increasing length hung from a beam over a dark
// table, lit by one lamp. Pendulum n makes N0 + n swings in one cycle (N0 = 2 (count - 1)), so they
// start in line, drift into travelling waves, a double helix and apparent chaos, and realign. The
// motion is analytic (small angle), so the scene needs no simulation: everything is traced per pixel
// from one camera, and moving edges (bobs, threads, shadows, trails) are cut per cell.
// Knobs read here: K_count, K_cycle, K_swing, K_release, K_camera, K_trail, K_material, K_beam,
// K_lamp, K_mark.
import { glslFloat, glslPick, glslVec3 } from "../../shaders/glsl.ts";

export interface PendulaCamera {
  label: string;
  /** Degrees round the vertical from the front (the camera sits toward +x for a positive yaw). */
  yaw: number;
  /** Degrees above the horizontal. */
  pitch: number;
  /** Distance from the aim point, world units. */
  dist: number;
  /** Height of the aim point. */
  aim: number;
  /** Centre of the scene's extent on the image plane at focal length 1. */
  centre: readonly [number, number];
  /** Half the scene's width and height there. */
  half: readonly [number, number];
}

/** In `camera` knob order. The extents were measured from the beam, posts, feet and the bobs' reach. */
export const pendulaCameras: readonly PendulaCamera[] = [
  { label: "side", yaw: 62, pitch: 6, dist: 5, aim: 0.95, centre: [0.0347, -0.0479], half: [0.1951, 0.2466] },
  { label: "3/4", yaw: 38, pitch: 17, dist: 5, aim: 0.95, centre: [0.0498, -0.0426], half: [0.2751, 0.2365] },
  { label: "top", yaw: 0, pitch: 80, dist: 5, aim: 0.55, centre: [0, -0.0065], half: [0.4126, 0.0822] },
];

export interface PendulaBeam {
  label: string;
  color: string;
  /** 0 matt wood .. 1 polished metal. */
  gloss: number;
}

/** In `beam` knob order. */
export const pendulaBeams: readonly PendulaBeam[] = [
  { label: "oak", color: "#8d5f31", gloss: 0 },
  { label: "walnut", color: "#5b3822", gloss: 0 },
  { label: "brass", color: "#d9a64a", gloss: 1 },
];

/** The bobs' bare metals; the third `material` choice (anodised) is a hue per bob. */
export const pendulaBrass = "#f2b95a";
export const pendulaSteel = "#c4cddb";

const cameraPose = glslPick(
  "camera",
  pendulaCameras.map((c) => `vec4(${glslFloat(c.yaw)}, ${glslFloat(c.pitch)}, ${glslFloat(c.dist)}, ${glslFloat(c.aim)})`),
  "vec4(38.0, 17.0, 5.0, 0.95)",
);
const cameraFit = glslPick(
  "camera",
  pendulaCameras.map((c) => `vec4(${glslFloat(c.centre[0])}, ${glslFloat(c.centre[1])}, ${glslFloat(c.half[0])}, ${glslFloat(c.half[1])})`),
  "vec4(0.0498, -0.0426, 0.2751, 0.2365)",
);

export const pendulaGlsl = `
const float PENDULA_PIVOT = 1.7;       // height of the pivot line: the beam's underside
const float PENDULA_SPAN = 2.6;        // the row's length
const float PENDULA_LMAX = 1.42;       // the longest pendulum
const float PENDULA_DECAY = 0.2;       // amplitude lost per cycle while a release is running down
const float PENDULA_RELEASE = 3.0;     // cycles between gentle re-releases
const vec3 PENDULA_LAMP_POS = vec3(-0.8, 4.1, 1.3);
const vec3 PENDULA_LAMP_COL = vec3(1.0, 0.9, 0.74);
const vec3 PENDULA_TABLE = vec3(0.3, 0.19, 0.105);
const vec3 PENDULA_GOLD = vec3(1.0, 0.78, 0.42);
const vec3 PENDULA_BRASS = ${glslVec3(pendulaBrass)};
const vec3 PENDULA_STEEL = ${glslVec3(pendulaSteel)};

vec4 pendulaPose() {
${cameraPose}
}

vec4 pendulaFit() {
${cameraFit}
}

vec3 pendulaBeamColor() {
${glslPick("beam", pendulaBeams.map((b) => glslVec3(b.color)), "vec3(0.5)")}
}

float pendulaBeamGloss() {
${glslPick("beam", pendulaBeams.map((b) => glslFloat(b.gloss)), "0.0")}
}

// The bob's metal: brass, steel, or anodised, a pale hue per bob along the row (h 0..1).
vec3 pendulaBobTint(float h) {
  if (K_material < 0.5) return PENDULA_BRASS;
  if (K_material < 1.5) return PENDULA_STEEL;
  return mix(vec3(0.82), 0.5 + 0.5 * cos(TAU * (h * 0.85 + vec3(0.0, 0.33, 0.67))), 0.72);
}

float pendulaLampK() {
  return 0.5 + 1.3 * K_lamp;
}

// How much of the lamp's light reaches a point over the table: a broad pool round the row.
float pendulaPool(vec2 xz) {
  vec2 q = (xz - vec2(0.0, 0.1)) / vec2(2.5, 1.9);
  return exp(-dot(q, q));
}

float pendulaIllum(vec3 P) {
  return pendulaLampK() * (0.35 + 0.8 * pendulaPool(P.xz));
}

struct PendulaCam {
  vec3 pos;
  vec3 fwd;
  vec3 right;
  vec3 up;
  float focal;
  vec2 centre;
};

PendulaCam pendulaCamera(float aspect) {
  vec4 pose = pendulaPose();
  vec4 fit = pendulaFit();
  float yaw = radians(pose.x) + 0.06 * uPointer.x;
  float pitch = radians(pose.y) + 0.03 * uPointer.y;
  vec3 aim = vec3(0.0, pose.w, 0.0);
  PendulaCam c;
  c.pos = aim + pose.z * vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
  c.fwd = normalize(aim - c.pos);
  c.right = normalize(cross(c.fwd, vec3(0.0, 1.0, 0.0)));
  c.up = cross(c.right, c.fwd);
  c.focal = min(0.4 / fit.w, 0.46 * aspect / fit.z);
  c.centre = fit.xy;
  return c;
}

// The dark studio behind and beyond: a faint glow along the horizon and lamp spill on the far side.
vec3 pendulaBackdrop(vec2 p, float ry) {
  float glow = exp(-abs(ry) * 7.0);
  vec3 c = vec3(0.022, 0.028, 0.038) * (0.6 + 0.9 * glow);
  vec2 s = p - vec2(-0.15, 0.18);
  return c + vec3(0.02, 0.018, 0.014) * exp(-1.4 * dot(s, s));
}

// Position of pendulum swing at a phase (in cycles): the bob, hung from piv by a thread of length L.
vec3 pendulaBobAt(vec3 piv, float L, float amp, float k, float f) {
  float th = amp * cos(TAU * fract(k * f));
  return piv + vec3(0.0, -cos(th), sin(th)) * L;
}

// Where the shadow of P falls on the table: xy = (x, z), z = magnification.
vec3 pendulaCast(vec3 P) {
  float lam = PENDULA_LAMP_POS.y / max(PENDULA_LAMP_POS.y - P.y, 0.5);
  return vec3(PENDULA_LAMP_POS.xz + (P.xz - PENDULA_LAMP_POS.xz) * lam, lam);
}

// The lamp has size: a shadow's penumbra widens with the height of what casts it.
float pendulaPen(float y) {
  return 0.012 + 0.3 * y / max(PENDULA_LAMP_POS.y - y, 0.5);
}

// Shadow of the beam and posts on the table at q = (x, z): 0..1, steady.
float pendulaFrameShadow(vec2 q) {
  vec3 a = pendulaCast(vec3(-1.52, PENDULA_PIVOT + 0.05, 0.0));
  vec3 b = pendulaCast(vec3(1.52, PENDULA_PIVOT + 0.05, 0.0));
  float cov = 0.8 * softFill(sdTaperCapsule(q, a.xy, b.xy, 0.065 * a.z, 0.065 * b.z), pendulaPen(PENDULA_PIVOT + 0.05));
  for (int i = 0; i < 2; i++) {
    float side = i == 0 ? -1.0 : 1.0;
    vec3 f0 = pendulaCast(vec3(side * 1.43, 0.0, 0.0));
    vec3 f1 = pendulaCast(vec3(side * 1.43, PENDULA_PIVOT, 0.0));
    float t;
    float d = sdTaperCapsule(q, f0.xy, f1.xy, 0.045 * f0.z, 0.045 * f1.z, t);
    cov = max(cov, softFill(d, mix(pendulaPen(0.0), pendulaPen(PENDULA_PIVOT), t)));
  }
  return cov;
}

// Shadows of the bobs on the table at q: the largest coverage of any, penumbra and all.
float pendulaBobShadow(vec2 q, float cnt, float n0, float sp, float br, float fc, float amp) {
  float cov = 0.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    if (fi > cnt - 0.5) break;
    float k = n0 + fi;
    float L = PENDULA_LMAX * (n0 / k) * (n0 / k);
    vec3 bob = pendulaBobAt(vec3((fi + 0.5 - 0.5 * cnt) * sp, PENDULA_PIVOT, 0.0), L, amp, k, fc);
    vec3 s = pendulaCast(bob);
    cov = max(cov, softFill(length(q - s.xy) - br * s.z, pendulaPen(bob.y)));
  }
  return cov;
}

// The table: dark planks along x, lit in a pool by the lamp, shadowed (cut is 0 or 1 per cell), its
// far reaches lost in the studio's dark.
vec3 pendulaTableColor(vec3 P, vec3 rd, float t, float cw, float cut, vec3 fogCol) {
  float lampK = pendulaLampK();
  float v = (P.z + 0.35) / 0.5;
  float plank = floor(v);
  float seamAt = min(fract(v), 1.0 - fract(v)) * 0.5;
  float fade = smoothfall(0.02, 0.006, cw);
  float tone = 0.88 + 0.24 * hash12(vec2(plank, 4.7));
  float grain = 0.9 + 0.2 * vnoise(vec2(P.x * 0.9 + plank * 5.3, P.z * 38.0));
  float seam = smoothfall(0.009 + cw, 0.003, seamAt);
  vec3 alb = PENDULA_TABLE * tone * mix(1.0, grain, fade) * (1.0 - 0.55 * seam * fade);
  float pool = pendulaPool(P.xz);
  vec3 Ld = normalize(PENDULA_LAMP_POS - P);
  vec3 lit = PENDULA_LAMP_COL * lampK * 1.3 * pool * Ld.y;
  float glare = pow(max(dot(vec3(rd.x, -rd.y, rd.z), Ld), 0.0), 48.0) * 0.28 * lampK;
  vec3 col = alb * (vec3(0.07, 0.075, 0.09) + lit * (1.0 - 0.8 * cut)) + PENDULA_LAMP_COL * glare * pool * (1.0 - cut);
  return mix(col, fogCol, 1.0 - exp(-t / 16.0));
}

// The metal of a bob or finial: a dark studio mirrored in it, the lamp as a soft lobe and a hard
// highlight, the lit table in its lower half.
vec3 pendulaMetal(vec3 tint, vec3 P, vec3 nrm, vec3 rd) {
  vec3 Ld = normalize(PENDULA_LAMP_POS - P);
  float lampK = pendulaLampK();
  float facing = clamp(dot(nrm, -rd), 0.0, 1.0);
  vec3 R = reflect(rd, nrm);
  float lobe = pow(max(dot(R, Ld), 0.0), 9.0);
  float down = smoothfall(0.15, -0.45, R.y);
  vec2 fp = P.xz + R.xz * (P.y / max(-R.y, 0.25));
  vec3 floorLight = PENDULA_TABLE * PENDULA_LAMP_COL * lampK * (0.15 + 1.5 * pendulaPool(fp));
  vec3 env = vec3(0.04, 0.046, 0.058) + PENDULA_LAMP_COL * lampK * lobe;
  env = mix(env, floorLight, down);
  vec3 fres = tint + (vec3(1.0) - tint) * pow(1.0 - facing, 4.0);
  vec3 col = fres * env * 1.6 + tint * PENDULA_LAMP_COL * lampK * 0.16 * max(dot(nrm, Ld), 0.0);
  float hot = hardEdge(smoothstep(0.93, 0.962, dot(R, Ld)));
  return col + PENDULA_LAMP_COL * (0.95 * min(lampK, 1.2) * hot);
}

// One box of the frame i: 0 the beam, 1 and 2 the posts (left, right), 3 and 4 the feet.
void pendulaFrameBox(int i, out vec3 lo, out vec3 hi) {
  float side = (i == 1 || i == 3) ? -1.0 : 1.0;
  if (i == 0) {
    lo = vec3(-1.52, PENDULA_PIVOT, -0.065);
    hi = vec3(1.52, PENDULA_PIVOT + 0.1, 0.065);
    return;
  }
  if (i < 3) {
    float xa = side * 1.385;
    float xb = side * 1.475;
    lo = vec3(min(xa, xb), 0.04, -0.045);
    hi = vec3(max(xa, xb), PENDULA_PIVOT, 0.045);
    return;
  }
  float fa = side * 1.355;
  float fb = side * 1.505;
  lo = vec3(min(fa, fb), 0.0, -0.28);
  hi = vec3(max(fa, fb), 0.04, 0.28);
}

// The nearest frame box the ray enters before maxT: its t (-1: none), normal, index and bounds.
// inv is 1 / rd with a floor on each component.
float pendulaFrame(vec3 ro, vec3 inv, float maxT, out vec3 nrm, out int part, out vec3 lo, out vec3 hi) {
  float best = maxT;
  float found = -1.0;
  nrm = vec3(0.0, 1.0, 0.0);
  part = 0;
  lo = vec3(0.0);
  hi = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    vec3 bl;
    vec3 bh;
    pendulaFrameBox(i, bl, bh);
    vec3 t0 = (bl - ro) * inv;
    vec3 t1 = (bh - ro) * inv;
    vec3 tn = min(t0, t1);
    vec3 tx = max(t0, t1);
    float tNear = max(max(tn.x, tn.y), tn.z);
    float tFar = min(min(tx.x, tx.y), tx.z);
    if (tNear > 0.0 && tNear < tFar && tNear < best) {
      best = tNear;
      found = tNear;
      nrm = -sign(inv) * step(tn.yzx, tn.xyz) * step(tn.zxy, tn.xyz);
      part = i;
      lo = bl;
      hi = bh;
    }
  }
  return found;
}

// The frame lit by the lamp: wood with a grain along its length, or polished brass; a bright edge
// where two faces meet; the table's light bouncing up under it.
vec3 pendulaFrameShade(int part, vec3 lo, vec3 hi, vec3 P, vec3 nrm, vec3 rd, float cw) {
  vec3 alb = pendulaBeamColor();
  float gloss = pendulaBeamGloss();
  float along = (part == 1 || part == 2) ? P.y : P.x;
  float g = vnoise(vec2(along * 5.0, (P.x + P.y + P.z - along) * 70.0));
  float grain = mix(1.0, 0.82 + 0.3 * g, (1.0 - gloss) * smoothfall(0.03, 0.008, cw));
  vec3 Ld = normalize(PENDULA_LAMP_POS - P);
  float illum = pendulaIllum(P);
  float pool = pendulaPool(P.xz);
  vec3 bounce = PENDULA_TABLE * 0.25 * max(-nrm.y, 0.0) * pool * pendulaLampK();
  vec3 col = alb * grain * (vec3(0.09) + illum * PENDULA_LAMP_COL * max(dot(nrm, Ld), 0.0) + bounce);
  col *= 0.55 + 0.45 * smoothstep(0.0, 0.35, P.y);
  vec3 R = reflect(rd, nrm);
  col += alb * gloss * illum * PENDULA_LAMP_COL * (0.8 * pow(max(dot(R, Ld), 0.0), 18.0));
  vec3 e = abs(P - 0.5 * (lo + hi)) - 0.5 * (hi - lo);
  vec3 tangential = e - abs(nrm) * 10.0;
  float edge = smoothfall(0.016, 0.004, -max(tangential.x, max(tangential.y, tangential.z)));
  return col + alb * illum * PENDULA_LAMP_COL * (0.5 * edge);
}

// Ray against a sphere: the entry t (-1 when it is behind), and the ray's nearest approach to the
// centre. A ray that misses by a little still gets the t of its nearest approach, for the cut rim.
float pendulaSphere(vec3 ro, vec3 rd, vec3 ctr, float rad, out float closest) {
  vec3 oc = ro - ctr;
  float b = dot(oc, rd);
  closest = sqrt(max(dot(oc, oc) - b * b, 0.0));
  if (b >= 0.0) return -1.0;
  return max(-b - sqrt(max(rad * rad - closest * closest, 0.0)), 0.0);
}

// Ray against the segment a..b: the distance between them, the ray's t at the nearest point and
// where along the segment that is (0..1).
float pendulaRaySeg(vec3 ro, vec3 rd, vec3 a, vec3 b, out float rayT, out float along) {
  vec3 d = b - a;
  vec3 w = a - ro;
  float dr = dot(d, rd);
  float den = max(dot(d, d) - dr * dr, 1.0e-6);
  along = clamp(-(dot(d, w) - dot(rd, w) * dr) / den, 0.0, 1.0);
  vec3 q = w + d * along;
  rayT = dot(q, rd);
  return length(q - rd * rayT);
}

// A faint trail segment a..b, fading from fa at a to fb at b, cut per cell.
float pendulaTrailSeg(vec3 ro, vec3 rd, vec3 a, vec3 b, float cellW, float depth, float fa, float fb) {
  float rt;
  float s;
  float d = pendulaRaySeg(ro, rd, a, b, rt, s);
  if (rt <= 0.0 || rt >= depth) return 0.0;
  return mix(fa, fb, s) * softFill(d / (rt * cellW) - 0.55, 0.8);
}

Shade scenePendula(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  PendulaCam cam = pendulaCamera(aspect);
  vec3 ro = cam.pos;
  vec3 rd = normalize(cam.fwd + cam.right * (p.x / cam.focal + cam.centre.x) + cam.up * (p.y / cam.focal + cam.centre.y));
  float cellW = dot(cam.fwd, rd) / (cam.focal * uRes.y);  // world size of a cell per unit of ray length

  // The wave: pendulum n swings N0 + n times per cycle. A release lets the swing run down a little
  // each cycle, and every third realignment tops it up again, smoothly.
  float cnt = K_count;
  float n0 = 2.0 * (cnt - 1.0);
  float sp = PENDULA_SPAN / cnt;
  float br = 0.44 * sp;
  float c = uMotionTime / K_cycle;
  float fc = fract(c);
  float env = 1.0;
  if (K_release > 0.5) {
    float f = fract(c / PENDULA_RELEASE) * PENDULA_RELEASE;
    env = mix(exp(-PENDULA_DECAY * f), 1.0, smoothstep(PENDULA_RELEASE - 0.06, PENDULA_RELEASE, f));
  }
  float amp = mix(0.14, 0.4, K_swing) * env;

  // The surface behind everything: the studio's dark, or the table.
  vec3 col = pendulaBackdrop(p, rd.y);
  float depth = 1.0e4;
  if (rd.y < -0.0005) {
    float tTable = -ro.y / rd.y;
    vec3 tp = ro + rd * tTable;
    float shadow = pendulaFrameShadow(tp.xz);
    // The bobs' shadows fall only in a patch of table, away from the lamp.
    if (tp.x > -2.1 && tp.x < 3.3 && tp.z > -1.5 && tp.z < 0.7) shadow = max(shadow, pendulaBobShadow(tp.xz, cnt, n0, sp, br, fc, amp));
    float cut = hardEdge(shadow);
    col = pendulaTableColor(tp, rd, tTable, tTable * cellW, cut, pendulaBackdrop(p, 0.0));
    depth = tTable;
  }

  // The Manifold M: a lamp projects it on the studio floor; it brightens as the row lines up.
  float accent = 0.0;
  if (K_mark > 0.0) {
    float size = 0.1 + 0.2 * K_mark;
    vec2 mc = vec2(0.36 * aspect, 0.29);
    float dm = markDistance((p - mc) / size) * size;
    float edge = (dm - 0.085 * size) * uRes.y;
    float cov = hardFill(edge, 0.7);
    float align = bell((abs(fract(c + 0.5) - 0.5)) / 0.04);
    float glow = 0.55 + 0.45 * align;
    col = mix(col, col * 0.35 + PENDULA_GOLD * glow, cov) + PENDULA_GOLD * (0.05 * exp(-max(edge, 0.0) / 9.0));
    accent = cov * glow;
  }

  // The frame.
  vec3 inv = 1.0 / (max(abs(rd), vec3(1.0e-5)) * vec3(rd.x < 0.0 ? -1.0 : 1.0, rd.y < 0.0 ? -1.0 : 1.0, rd.z < 0.0 ? -1.0 : 1.0));
  vec3 fn;
  vec3 flo;
  vec3 fhi;
  int part;
  float tf = pendulaFrame(ro, inv, depth, fn, part, flo, fhi);
  if (tf > 0.0) {
    col = pendulaFrameShade(part, flo, fhi, ro + rd * tf, fn, rd, tf * cellW);
    depth = tf;
  }
  for (int i = 0; i < 2; i++) {
    vec3 fc3 = vec3(i == 0 ? -1.43 : 1.43, PENDULA_PIVOT + 0.145, 0.0);
    float closest;
    float ts = pendulaSphere(ro, rd, fc3, 0.045, closest);
    if (ts > 0.0 && ts < depth && hardFill((closest - 0.045) / (ts * cellW), 0.7) > 0.5) {
      vec3 P = ro + rd * ts;
      col = pendulaMetal(PENDULA_BRASS, P, normalize(P - fc3), rd);
      depth = ts;
    }
  }

  // The pendulums, near and far in whatever order: each thread pair and bob wins where it is nearer.
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    if (fi > cnt - 0.5) break;
    float k = n0 + fi;
    float L = PENDULA_LMAX * (n0 / k) * (n0 / k);
    float x = (fi + 0.5 - 0.5 * cnt) * sp;
    vec3 piv = vec3(x, PENDULA_PIVOT, 0.0);
    vec3 bob = pendulaBobAt(piv, L, amp, k, fc);
    vec3 dir = (bob - piv) / L;
    vec3 eye = piv + dir * (L - br);
    vec3 tint = pendulaBobTint(fi / max(cnt - 1.0, 1.0));

    // Where the bob has just been: three straight pieces along its arc.
    if (K_trail > 0.0) {
      float dc = (0.12 + 0.5 * K_trail) / k / 3.0;
      vec3 q1 = pendulaBobAt(piv, L, amp, k, fc - dc);
      vec3 q2 = pendulaBobAt(piv, L, amp, k, fc - 2.0 * dc);
      vec3 q3 = pendulaBobAt(piv, L, amp, k, fc - 3.0 * dc);
      vec3 mid = 0.25 * (bob + q1 + q2 + q3);
      float reach = max(max(length(bob - mid), length(q1 - mid)), max(length(q2 - mid), length(q3 - mid))) + 0.04;
      vec3 om = ro - mid;
      float bm = dot(om, rd);
      if (bm < 0.0 && dot(om, om) - bm * bm < reach * reach) {
        float tc = pendulaTrailSeg(ro, rd, bob, q1, cellW, depth, 0.6, 0.4);
        tc = max(tc, pendulaTrailSeg(ro, rd, q1, q2, cellW, depth, 0.4, 0.2));
        tc = max(tc, pendulaTrailSeg(ro, rd, q2, q3, cellW, depth, 0.2, 0.0));
        col = mix(col, tint * 0.85, hardEdge(tc));
      }
    }

    // The V of thread: two strings from the beam to the bob's eye, so it swings in one plane.
    vec3 mid = 0.5 * (piv + eye);
    vec3 om = ro - mid;
    float bm = dot(om, rd);
    float reach = 0.5 * (L - br) + 0.25 * sp + 0.05;
    if (bm < 0.0 && dot(om, om) - bm * bm < reach * reach) {
      for (int j = 0; j < 2; j++) {
        vec3 anchor = vec3(x + (j == 0 ? -0.2 : 0.2) * sp, PENDULA_PIVOT, 0.0);
        float rt;
        float s;
        float d = pendulaRaySeg(ro, rd, anchor, eye, rt, s);
        if (rt > 0.0 && rt < depth && hardFill(d / (rt * cellW) - 0.8, 0.8) > 0.5) {
          vec3 at = ro + rd * rt;
          col = vec3(0.5, 0.49, 0.46) * (0.5 + 0.5 * min(pendulaIllum(at), 1.2));
          depth = rt;
        }
      }
    }

    // The bob.
    float closest;
    float ts = pendulaSphere(ro, rd, bob, br, closest);
    if (ts > 0.0 && ts < depth && hardFill((closest - br) / (ts * cellW), 0.7) > 0.5) {
      vec3 P = ro + rd * ts;
      col = pendulaMetal(tint, P, normalize(P - bob), rd);
      depth = ts;
    }
  }

  // The dark falls away toward the edges of the picture.
  col *= 1.0 - 0.4 * smoothstep(0.35, 1.3, length(p * vec2(0.75, 1.0)));
  return shadeOf(col, inkOf(col, 1.5, 0.8), clamp(accent, 0.0, 1.0));
}
`;
