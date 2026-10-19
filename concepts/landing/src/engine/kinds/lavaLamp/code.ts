// The lava lamp's code (src/engine/glsl.ts, the kind contract), in lamp units (its `size` metres to
// one): its lathe (shape.ts) as cones hit exactly, the base and the cap brushed metal catching the
// glow of the glass, and the glass showing what lies in it. Seen through the glass (its surface, once
// a cell), the eye's ray bends into the liquid, then its wax (the sim's parcels, sim.ts, read per
// lamp from the state texture) is found along it as a metaball surface: the parcels the ray passes
// near are gathered, the stretch between them marched at the cell's footprint (bounded steps,
// fewer far off), the crossing refined. The wax is lit from below by the bulb, dimmed where wax
// below it stands in the light, glowing along its thin edges and toward its silhouette, pale while
// solid, veiled by the liquid in front of it; the liquid glows brightest low down and over the coil,
// dimmer toward the cap and over the wax. Its light (one point low in the glass) takes the liquid's
// colour, and the wax's as more of it rises; its base and cap cast a shadow, its glass part of one.
import { glslFloat } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import {
  BASE,
  CAP_TOP,
  GLASS,
  GLASS_BOTTOM,
  GLASS_TOP,
  GLASS_WIDE,
  LATHE,
  type LatheSegment,
  PARCELS,
  PART,
  WIDE_AT,
} from "./shape.ts";
import { lavaSim, REACH, STRETCH } from "./sim.ts";

export const sim = lavaSim;

const f = glslFloat;

/** The lathe for shadows: the glass's shoulder one cone from the collar to its widest. */
const HULL = LATHE.reduce<LatheSegment[]>((hull, s) => {
  const last = hull.at(-1);
  const shoulder = s.part === PART.glass && s.y1 <= BASE + WIDE_AT * GLASS + 1e-9;
  if (shoulder && last?.part === PART.glass)
    hull[hull.length - 1] = { ...last, y1: s.y1, r1: s.r1 };
  else hull.push(s);
  return hull;
}, []);

/** Cones as a GLSL array of vec4(y0, r0, y1, r1). */
function cones(segments: readonly LatheSegment[]): string {
  return `vec4[${segments.length}](\n  ${segments.map((s) => `vec4(${f(s.y0)}, ${f(s.r0)}, ${f(s.y1)}, ${f(s.r1)})`).join(",\n  ")}\n)`;
}

export const glsl: KindCode["glsl"] = () => `
const int LAVA_LAMP_SEGMENTS = ${LATHE.length};
// The lathe's cones, bottom to top: (y0, r0, y1, r1), lamp units, and what each is; the cap's top a disc.
const vec4 LAVA_LAMP_LATHE[${LATHE.length}] = ${cones(LATHE)};
const float LAVA_LAMP_PARTS[${LATHE.length}] = float[${LATHE.length}](${LATHE.map((s) => f(s.part)).join(", ")});
// The lathe as a shadow sees it: the glass's shoulder one cone.
const int LAVA_LAMP_HULLS = ${HULL.length};
const vec4 LAVA_LAMP_HULL[${HULL.length}] = ${cones(HULL)};
const float LAVA_LAMP_HULL_PARTS[${HULL.length}] = float[${HULL.length}](${HULL.map((s) => f(s.part)).join(", ")});
const float LAVA_LAMP_BASE = ${f(BASE)};
const float LAVA_LAMP_GLASS = ${f(GLASS)};
const float LAVA_LAMP_CAP_TOP = ${f(CAP_TOP)};
const int LAVA_LAMP_PARCELS = ${PARCELS};
// A parcel's metaball reach (its radii) and the field's level at a lone parcel's surface.
const float LAVA_LAMP_REACH = ${f(REACH)};
const float LAVA_LAMP_ISO = ${f((1 - 1 / (REACH * REACH)) ** 3)};
const float LAVA_LAMP_STRETCH = ${f(STRETCH)};
// The finest step the wax is marched at (glass units: a third of a small parcel), and the most steps.
const float LAVA_LAMP_STEP = 0.014;
const int LAVA_LAMP_STEPS = 24;
// How much light a unit of wax (glass units) stops on its way up from the bulb.
const float LAVA_LAMP_KAPPA = 7.0;
// The share of light the glass and its liquid let through, for a shadow.
const float LAVA_LAMP_THROUGH = 0.6;
// The light: its power (it is behind the glass), its reach (lamp heights), its place up the glass.
const float LAVA_LAMP_POWER = 1.4;
const float LAVA_LAMP_REACH_LIGHT = 1.1;
const float LAVA_LAMP_LIGHT_AT = 0.35;
const vec3 LAVA_LAMP_METAL = vec3(0.56, 0.54, 0.52);
const vec3 LAVA_LAMP_HOT = vec3(1.0, 0.92, 0.76);

// The lamp being drawn through its glass: how many parcels it holds, and (bit i for parcel i) the
// ones the ray passes near (lavaLampGather). No arrays: a renderer may clear every global array
// for every cell, drawn through the glass or not.
int lavaLampCount;
uint lavaLampNear;

// The colours of the wax, the liquid and the light the lamp throws.
struct LavaLampInk { vec3 wax; vec3 liquid; vec3 light; };

vec3 lavaLampHue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

LavaLampInk lavaLampInk(EngineObj o) {
  LavaLampInk ink;
  ink.wax = mix(lavaLampHue(lavaLampWax(o)), vec3(1.0), 0.05);
  ink.liquid = mix(lavaLampHue(lavaLampLiquid(o)), vec3(1.0), 0.12);
  ink.light = mix(ink.liquid, vec3(1.0), 0.15);
  return ink;
}

// The bulb's brightness: a hotter bulb shines brighter.
float lavaLampBulb(EngineObj o) {
  return 0.8 + 0.4 * lavaLampHeat(o);
}

// The glass's outer radius at s (0 at the collar .. 1 under the cap) and its slope dr/ds.
vec2 lavaLampGlassR(float s) {
  float t = clamp(s, 0.0, 1.0);
  if (t < ${f(WIDE_AT)}) {
    float a = 1.0 - t / ${f(WIDE_AT)};
    return vec2(${f(GLASS_BOTTOM)} + ${f(GLASS_WIDE - GLASS_BOTTOM)} * (1.0 - a * a), ${f(GLASS_WIDE - GLASS_BOTTOM)} * 2.0 * a / ${f(WIDE_AT)});
  }
  float k = ${f((GLASS_TOP - GLASS_WIDE) / (1 - WIDE_AT))};
  return vec2(${f(GLASS_WIDE)} + k * (t - ${f(WIDE_AT)}), k);
}

// Where the ray ro + rd t crosses cone s (radius s.y at height s.x up to s.w at s.z) between its
// rims: both crossings' t, nearer first, -1 for one that misses.
vec2 lavaLampCone(vec3 ro, vec3 rd, vec4 s) {
  float k = (s.w - s.y) / (s.z - s.x);
  float a = s.y + (ro.y - s.x) * k;
  float b = rd.y * k;
  float A = dot(rd.xz, rd.xz) - b * b;
  float B = dot(ro.xz, rd.xz) - a * b;
  float C = dot(ro.xz, ro.xz) - a * a;
  float disc = B * B - A * C;
  if (disc < 0.0 || abs(A) < 1e-9) return vec2(-1.0);
  float q = sqrt(disc);
  vec2 t = vec2(-B - q, -B + q) / A;
  if (t.x > t.y) t = t.yx;
  vec2 y = ro.y + rd.y * t;
  vec2 r = a + b * t;
  if (y.x < s.x || y.x > s.z || r.x < 0.0) t.x = -1.0;
  if (y.y < s.x || y.y > s.z || r.y < 0.0) t.y = -1.0;
  return t;
}

// The heights the ray ro + rd t covers for t in span: low, high.
vec2 lavaLampHeights(vec3 ro, vec3 rd, vec2 span) {
  vec2 y = ro.y + rd.y * span;
  return vec2(min(y.x, y.y), max(y.x, y.y));
}

// The ray's first crossing of the lathe within span (lamp units): its t, else -1, and the cone it
// crossed (LAVA_LAMP_SEGMENTS: the cap's top). Cones out of the ray's heights are not tried.
float lavaLampLathe(vec3 ro, vec3 rd, vec2 span, out int seg) {
  float best = -1.0;
  seg = -1;
  vec2 ys = lavaLampHeights(ro, rd, span);
  for (int k = 0; k < LAVA_LAMP_SEGMENTS; k++) {
    vec4 s = LAVA_LAMP_LATHE[k];
    if (ys.y < s.x || ys.x > s.z) continue;
    vec2 t = lavaLampCone(ro, rd, s);
    float c = t.x >= span.x && t.x <= span.y ? t.x : (t.y >= span.x && t.y <= span.y ? t.y : -1.0);
    if (c >= 0.0 && (best < 0.0 || c < best)) {
      best = c;
      seg = k;
    }
  }
  if (abs(rd.y) > 1e-6) {
    float t = (1.0 - ro.y) / rd.y;
    vec2 xz = ro.xz + rd.xz * t;
    if (t >= span.x && t <= span.y && dot(xz, xz) <= LAVA_LAMP_CAP_TOP * LAVA_LAMP_CAP_TOP && (best < 0.0 || t < best)) {
      best = t;
      seg = LAVA_LAMP_SEGMENTS;
    }
  }
  return best;
}

float lavaLampHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  float size = lavaLampSize(o);
  int seg;
  vec3 q = ro / size;
  float t = lavaLampLathe(q, rd, span / size, seg);
  n = vec3(0.0, 1.0, 0.0);
  part = ${f(PART.top)};
  if (t < 0.0) return -1.0;
  if (seg < LAVA_LAMP_SEGMENTS) {
    vec3 p = q + rd * t;
    vec4 s = LAVA_LAMP_LATHE[seg];
    part = LAVA_LAMP_PARTS[seg];
    // The glass's normal from its smooth profile, not its cones'.
    float k = part == ${f(PART.glass)} ? lavaLampGlassR((p.y - LAVA_LAMP_BASE) / LAVA_LAMP_GLASS).y / LAVA_LAMP_GLASS : (s.w - s.y) / (s.z - s.x);
    n = normalize(vec3(p.x, -length(p.xz) * k, p.z));
  }
  return t * size;
}

// The base and the cap block light; the glass and its liquid let some through.
float lavaLampShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  float size = lavaLampSize(o);
  vec3 q = ro / size;
  vec2 s = span / size;
  vec2 ys = lavaLampHeights(q, rd, s);
  float lit = 1.0;
  for (int k = 0; k < LAVA_LAMP_HULLS; k++) {
    vec4 c = LAVA_LAMP_HULL[k];
    if (ys.y < c.x || ys.x > c.z) continue;
    vec2 t = lavaLampCone(q, rd, c);
    if ((t.x >= s.x && t.x <= s.y) || (t.y >= s.x && t.y <= s.y))
      lit = min(lit, LAVA_LAMP_HULL_PARTS[k] == ${f(PART.glass)} ? LAVA_LAMP_THROUGH : 0.0);
  }
  return lit;
}

EngineLight lavaLampLight(EngineObj o) {
  float size = lavaLampSize(o);
  LavaLampInk ink = lavaLampInk(o);
  float risen = lavaLampState(o, 0, 0).y;
  vec3 col = mix(ink.light, ink.light * ink.wax * 1.4, 0.5 * risen) * lavaLampBulb(o) * LAVA_LAMP_POWER;
  float y = LAVA_LAMP_BASE + LAVA_LAMP_LIGHT_AT * LAVA_LAMP_GLASS;
  return EngineLight(vec3(0.0, y * size, 0.0), col, LAVA_LAMP_REACH_LIGHT * size);
}

// The lamp's parcels whose reach the ray g + d t (glass units) passes within for t in 0..len: into
// lavaLampNear, with lavaLampCount. Returns the stretch of the ray they span (x > y: none).
vec2 lavaLampGather(EngineObj o, vec3 g, vec3 d, float len) {
  lavaLampCount = int(lavaLampState(o, 0, 0).x + 0.5);
  lavaLampNear = 0u;
  vec2 span = vec2(len, 0.0);
  for (int i = 0; i < LAVA_LAMP_PARCELS; i++) {
    if (i >= lavaLampCount) break;
    vec4 a = lavaLampState(o, 1 + 2 * i, 0);
    if (a.w <= 0.0) continue;
    float R = a.w * LAVA_LAMP_REACH;
    // The teardrop reaches furthest behind the parcel, at most 1.65 reaches: bound it so first.
    vec3 to = a.xyz - g;
    float tc = dot(to, d);
    float miss = dot(to, to) - tc * tc;
    if (miss >= 2.7225 * R * R) continue;
    float st = min(length(lavaLampState(o, 2 + 2 * i, 0).xyz) * LAVA_LAMP_STRETCH, 0.5);
    float bound = R * (1.0 + 1.3 * st);
    float h2 = bound * bound - miss;
    if (h2 <= 0.0) continue;
    float h = sqrt(h2);
    if (tc + h < 0.0 || tc - h > len) continue;
    span = vec2(min(span.x, max(tc - h, 0.0)), max(span.y, min(tc + h, len)));
    lavaLampNear |= 1u << uint(i);
  }
  return span;
}

// Parcel a (centre, radius) moving at b.xyz, at glass point g: its metaball (1 - s²)³ (x), drawn
// out behind it into a teardrop as it moves (a rising blob trails a tail, a sinking one hangs a
// drip), and its gradient (yzw).
vec4 lavaLampBall(vec4 a, vec4 b, vec3 g) {
  float speed = length(b.xyz);
  float st = min(speed * LAVA_LAMP_STRETCH, 0.5);
  vec3 dir = speed > 1e-4 ? b.xyz / speed : vec3(0.0, 1.0, 0.0);
  float R = a.w * LAVA_LAMP_REACH;
  vec3 d = g - a.xyz;
  float along = dot(d, dir);
  float ka = along < 0.0 ? 1.0 / (1.0 + 1.3 * st) : 1.0 / (1.0 + 0.1 * st);
  float kc = 1.0 + 0.25 * st;
  float u = along * ka;
  vec3 side = d - along * dir;
  float s2 = (u * u + kc * kc * dot(side, side)) / (R * R);
  if (s2 >= 1.0) return vec4(0.0);
  float k = 1.0 - s2;
  return vec4(k * k * k, -6.0 * k * k / (R * R) * (u * ka * dir + kc * kc * side));
}

// The wax's field at glass point g: the sum of the gathered parcels' metaballs.
float lavaLampField(EngineObj o, vec3 g) {
  float f = 0.0;
  for (int i = 0; i < LAVA_LAMP_PARCELS; i++) {
    if (i >= lavaLampCount) break;
    if ((lavaLampNear & (1u << uint(i))) == 0u) continue;
    f += lavaLampBall(lavaLampState(o, 1 + 2 * i, 0), lavaLampState(o, 2 + 2 * i, 0), g).x;
  }
  return f;
}

// The field's gradient at g (it rises into the wax), and its parcels' field-weighted temperature.
vec3 lavaLampGrad(EngineObj o, vec3 g, out float temp) {
  vec4 sum = vec4(0.0);
  temp = 0.0;
  for (int i = 0; i < LAVA_LAMP_PARCELS; i++) {
    if (i >= lavaLampCount) break;
    if ((lavaLampNear & (1u << uint(i))) == 0u) continue;
    vec4 b = lavaLampState(o, 2 + 2 * i, 0);
    vec4 ball = lavaLampBall(lavaLampState(o, 1 + 2 * i, 0), b, g);
    sum += ball;
    temp += ball.x * b.w;
  }
  temp = sum.x > 0.0 ? temp / sum.x : 0.0;
  return sum.yzw;
}

// How much of the bulb's light reaches glass point g past the wax below it: each parcel lower down
// stops it by the chord of its ball the light's vertical crosses.
float lavaLampBelow(EngineObj o, vec3 g) {
  float column = 0.0;
  for (int i = 0; i < LAVA_LAMP_PARCELS; i++) {
    if (i >= lavaLampCount) break;
    vec4 a = lavaLampState(o, 1 + 2 * i, 0);
    vec2 d = a.xz - g.xz;
    float c = a.w * a.w - dot(d, d);
    if (a.y < g.y && c > 0.0) column += 2.0 * sqrt(c);
  }
  return exp(-LAVA_LAMP_KAPPA * column);
}

// What shows through the glass at p (lamp units, its outward normal n), seen along rd: the
// glowing liquid and the coil, the wax, then the glass itself. foot: a cell's span there.
vec3 lavaLampGlass(EngineObj o, vec3 p, vec3 n, vec3 rd, float foot) {
  LavaLampInk ink = lavaLampInk(o);
  float bulb = lavaLampBulb(o);
  // Into the liquid, bent toward the axis; where it leaves (the glass's far side, the collar or
  // the cap), in glass units from the collar.
  vec3 d = refract(rd, n, 0.75);
  float len = 1e3;
  for (int k = 0; k < LAVA_LAMP_SEGMENTS; k++) {
    if (LAVA_LAMP_PARTS[k] != ${f(PART.glass)}) continue;
    float far = lavaLampCone(p, d, LAVA_LAMP_LATHE[k]).y;
    if (far > 1e-4) len = min(len, far);
  }
  if (d.y < 0.0) len = min(len, (LAVA_LAMP_BASE - p.y) / d.y);
  if (d.y > 0.0) len = min(len, (LAVA_LAMP_BASE + LAVA_LAMP_GLASS - p.y) / d.y);
  len = max(len, 0.0) / LAVA_LAMP_GLASS;
  vec3 g = vec3(p.x, p.y - LAVA_LAMP_BASE, p.z) / LAVA_LAMP_GLASS;

  // The wax along it: marched in steps of dt until a sample lies inside it, the last step halved
  // onto the crossing, then stepped on through it to where it ends (its thickness there). One
  // field sample a turn, at one place in the code.
  float tw = -1.0;
  float thick = 0.0;
  vec2 span = lavaLampGather(o, g, d, len);
  if (span.x < span.y) {
    float stride = max(LAVA_LAMP_STEP, foot / LAVA_LAMP_GLASS);
    int steps = int(clamp(ceil((span.y - span.x) / stride), 2.0, float(LAVA_LAMP_STEPS)));
    float dt = (span.y - span.x) / float(steps);
    float lo = span.x;
    float hi = span.x;
    float t = span.x;
    int k = 0;
    int phase = 0;  // 0 marching, 1 .. 4 halving, 5 through the wax
    for (int i = 0; i <= LAVA_LAMP_STEPS + 12; i++) {
      bool inside = lavaLampField(o, g + d * t) >= LAVA_LAMP_ISO;
      if (phase == 0 && inside) {
        hi = t;
        phase = k == 0 ? 5 : 1;
      } else if (phase == 0) {
        lo = t;
      } else if (phase < 5) {
        if (inside) hi = t;
        else lo = t;
        phase++;
      } else if (!inside) {
        break;
      }
      if (phase == 5 && tw < 0.0) {
        tw = hi;
        k = 0;
      }
      k += phase == 0 || phase == 5 ? 1 : 0;
      if (phase == 0 && k > steps) break;
      t = phase == 0 ? span.x + dt * float(k) : phase < 5 ? 0.5 * (lo + hi) : tw + dt * float(k);
      if (phase == 5 && (k > 8 || t >= span.y)) break;
    }
    if (tw >= 0.0) thick = min(t, span.y) - tw;
  }

  // The liquid in front of the wax (or all the way through): it glows with the bulb's light
  // scattered in it, brightest low down and fuller through the middle of the glass, dimmer toward
  // the cap and over the wax that shades it (taken where the wax is, else half way through); over
  // the coil, a white-hot core.
  float through = tw >= 0.0 ? tw : len;
  vec3 mid = g + d * (0.5 * through);
  vec3 at = g + d * tw;
  float s = clamp(mid.y, 0.0, 1.0);
  float low = exp(-3.0 * s);
  float shade = mix(1.0, lavaLampBelow(o, tw >= 0.0 ? at : mid), 0.55);
  float deep = clamp(len * LAVA_LAMP_GLASS / (2.0 * lavaLampGlassR(s).x), 0.0, 1.0);
  float glow = bulb * (0.3 + low * shade) * (0.6 + 0.4 * deep);
  vec3 col = ink.liquid * glow + ink.light * bulb * (0.045 + 0.03 * (1.0 - s));
  vec3 c = vec3(0.0, 0.02, 0.0) - g;
  vec3 near = g + d * clamp(dot(c, d), 0.0, through) - vec3(0.0, 0.02, 0.0);
  float core = bulb * exp(-dot(near.xz, near.xz) / 0.01 - near.y * near.y / 0.005);
  col = mix(col, LAVA_LAMP_HOT, 0.55 * core);
  // The coil on the bottom: two turns of wire, where the ray reaches its plane before the wax.
  if (d.y < 0.0) {
    float tc = (0.03 - g.y) / d.y;
    if (tc > 0.0 && tc < through) {
      float r = length((g + d * tc).xz);
      float w = 0.006 + 0.5 * foot / LAVA_LAMP_GLASS;
      float wire = 1.0 - smoothstep(0.5 * w, w, min(abs(r - 0.11), abs(r - 0.065)));
      col *= 1.0 - 0.75 * wire;
    }
  }

  if (tw >= 0.0) {
    float temp;
    vec3 wn = -normalize(lavaLampGrad(o, at, temp));
    float wl = exp(-3.0 * clamp(at.y, 0.0, 1.0));
    // The glowing liquid all round it, brighter below than above; the bulb from below, round the
    // blob from the coil; thin and grazing edges glow with the light through them.
    float liq = bulb * (0.3 + wl * shade) * (0.75 - 0.35 * wn.y);
    float under = bulb * (0.16 + 1.05 * wl * shade);
    float below = max(dot(wn, normalize(vec3(0.0, 0.02, 0.0) - at)), 0.0);
    float body = 1.0 - exp(-thick / 0.07);
    float rim = max(1.0 - smoothstep(0.0, 0.42, body), pow(1.0 - abs(dot(wn, d)), 3.0));
    vec3 wax = ink.wax * (0.7 * liq + 0.7 * under * (0.3 + 0.7 * below)) * (1.0 - 0.3 * body);
    wax += ink.wax * rim * (0.5 * liq + 0.9 * under) + ink.light * rim * rim * 0.12 * bulb;
    wax *= mix(vec3(1.0), ink.wax, 0.4 * body);
    wax = mix(wax, wax * ink.liquid * 1.6, 0.2);
    float solid = 1.0 - smoothstep(0.1, 0.22, temp);
    vec3 cold = mix(ink.wax, vec3(0.86, 0.84, 0.8), 0.35) * (0.08 + 0.5 * under * (0.6 + 0.4 * below));
    wax = mix(wax, cold, solid);
    wax *= 1.0 + 0.3 * smoothstep(0.6, 1.0, temp);
    // The liquid in front veils it: wax deeper in the glass takes more of the liquid's glow.
    col = mix(wax, col, 0.4 * (1.0 - exp(-5.0 * tw)));
  }

  // The glass: a darker band where the light bends away toward its silhouette, a bright line along it.
  float graze = 1.0 - abs(dot(n, rd));
  col *= 1.0 - 0.5 * smoothstep(0.7, 0.97, graze);
  col += (vec3(0.06) + ink.light * 0.14 * bulb) * smoothstep(0.92, 1.0, graze);
  return col;
}

void lavaLampSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float size = lavaLampSize(o);
  vec3 q = p / size;
  float foot = h.t * engineCell / (o.scale * size);
  if (part == ${f(PART.glass)}) {
    // The eye's ray (the reflected ray's, where a mirror shows the lamp, is taken as straight in).
    vec3 rd = normalize(q - engineToObject(o, engineCamera().eye) / size);
    if (dot(rd, n) > 0.0) rd = -n;
    h.emit = lavaLampGlass(o, q, n, rd, foot);
    h.albedo = vec3(0.04);
    h.rough = 0.06;
    h.mat = ${PART.glass};
    return;
  }
  LavaLampInk ink = lavaLampInk(o);
  float bulb = lavaLampBulb(o);
  // Brushed metal: lathe rings, gone once a cell spans them, and grooves over the foot ring and
  // under the collar's lip.
  float rings = 1.0 - smoothstep(0.003, 0.01, foot);
  float groove = max(1.0 - smoothstep(0.0, 0.004 + foot, abs(q.y - 0.012)), 1.0 - smoothstep(0.0, 0.004 + foot, abs(q.y - LAVA_LAMP_BASE + 0.03)));
  h.albedo = LAVA_LAMP_METAL * (1.0 + 0.05 * rings * sin(q.y * 900.0)) * (1.0 - 0.6 * groove);
  h.rough = 0.3;
  h.mat = int(part + 0.5);
  if (part == ${f(PART.base)}) {
    // The glow of the glass's shoulder over it falls on the base, strongest up by the collar.
    h.emit = LAVA_LAMP_METAL * ink.light * bulb * (0.06 + 0.6 * smoothstep(0.12, LAVA_LAMP_BASE, q.y));
  } else if (part == ${f(PART.cap)}) {
    // The cap's lower rim, lit by the glowing liquid just under it.
    float u = (q.y - LAVA_LAMP_BASE - LAVA_LAMP_GLASS) / (1.0 - LAVA_LAMP_BASE - LAVA_LAMP_GLASS);
    h.emit = LAVA_LAMP_METAL * ink.light * bulb * (0.06 + 0.7 * (1.0 - smoothstep(0.0, 0.45, u)));
  }
}
`;
