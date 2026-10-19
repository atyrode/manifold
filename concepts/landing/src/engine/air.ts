// The engine's air (README "A frame", step 5): the wind at any point of the world, the height fog
// between the eye and what it sees, rain and snow as particles in the world, and the water and snow
// they leave on surfaces. One GLSL library (`engineAirGlsl`), assembled after the shader libraries
// (the weather's wetten, wetGloss, rainPuddles, snowCover), the World (shaders/lib/world.ts
// worldGlsl: World, worldAt), the gust field (composer/gust.ts gustGlsl: GustWind, gustWind,
// gustAt) and the core's `struct EngineRay { vec3 o; vec3 d; }` (d unit length); and the CPU twins
// of what a sim or a test reads (`engineWind`, `engineFogDepth`).
//
//   vec3 engineWind(vec3 p, float tm)       the wind at p, m/s: K_wind's steady wind along the gust
//                                            field's downwind direction, its gusts (gustAt over p.xz)
//                                            on top, both on a log profile over the ground: still at
//                                            y = 0, the reference speed at 10 m, stronger above
//   vec3 engineFog(w, r, t, col, sunDir, sunCol)
//                                            col seen through the height fog along r to distance t
//                                            (1e5 or more for the sky): its optical depth integrated
//                                            in closed form, lit by the sky's ambient and the key's
//                                            forward-peaked in-scatter (Henyey-Greenstein)
//   vec4 enginePrecip(w, r, tHit, tm, lightCol)
//                                            rain and snow nearer than tHit, premultiplied: draw it as
//                                            col * (1 - a) + rgb. Particles in hashed lattices round
//                                            the eye (three shells to 32 m), falling and blown with
//                                            the wind, and the veil of what lies beyond them
//   vec3 engineSurfaceWeather(w, p, n, albedo)
//                                            the albedo wetted (w.wet) and under lying snow (w.lying)
//   float engineWetGloss(w, p, n)           the wet surface's extra gloss 0..1, for its highlights
//
// Gates: the world's own (scenes/world.ts worldFeatures). Fog compiles in under WORLD_FOG, the rain's
// particles and wet surfaces under WORLD_RAIN, the snow's particles under WORLD_SNOW, lying snow
// under WORLD_SNOW or a dated sky (SKY_DATE_ANCHOR: the season's cold lays snow down without a snow
// knob). With its gate shut a function gives its neutral value (the colour or albedo it was given,
// no rain or snow, no gloss), so a dry, clear setup pays for none of it.
import { gustAt, gustWind, newGustWind, NO_PASSAGE_GUST } from "../composer/gust.ts";
import { glslFloat, glslVec3 } from "../shaders/glsl.ts";
import type { Vec3 } from "./types.ts";

/** The wind's constants (`engineWind`): speeds in m/s, heights in metres. */
export const ENGINE_WIND = {
  /** The steady wind at the reference height at |K_wind| 1. */
  speed: 10,
  /** A full gust's extra speed (gust load 1): in still air, and added at |K_wind| 1. */
  gustCalm: 3,
  gustWind: 6,
  /** The log profile over the ground: its roughness length (grass), reference height, and top. */
  roughness: 0.1,
  reference: 10,
  top: 200,
} as const;

/** The height fog's constants (`engineFogDepth`, `engineFog`). */
export const ENGINE_FOG = {
  /** Extinction per metre at y = 0 at K_fog 1: about 75 m of visibility in a thick fog. */
  density: 0.04,
  /** The height over which the density falls by e. */
  height: 10,
  /** Heights below this (under the ground) are read as this, so the density stays finite. */
  floor: -40,
  /** Distances beyond this are read as this: the sky. */
  far: 1e6,
  /** Henyey-Greenstein asymmetry of the key's in-scatter, and its strength. */
  forward: 0.72,
  sun: 0.05,
  /** The fog's own light: the sky's ambient greyed toward this tint by `grey`, times `sky`. */
  tint: [0.93, 0.96, 1.0],
  grey: 0.5,
  sky: 1.15,
} as const;

/** The World's wind knobs as the shader reads them, and the gusts' "now" age (`engineWind`). */
export interface EngineWindKnobs {
  /** K_wind, -1..1: its sign the side the wind blows toward (+x at 1), its size the strength. */
  readonly wind: number;
  /** K_gusts: the gusts' strength while on, 0 while off. */
  readonly gusts: number;
  /** K_gustRate 0..1. */
  readonly gustRate: number;
  /** Motion seconds since the gusts' "now" fired; negative while idle. */
  readonly nowAge: number;
}

/** The gust field's state for one call of `engineWind`, filled in place. */
const gust = newGustWind();

/** ln(1 + reference / roughness): the profile's value at the reference height, before scaling. */
const LOG_REFERENCE = Math.log(1 + ENGINE_WIND.reference / ENGINE_WIND.roughness);

/** The wind's share of its reference speed at a height over the ground: 0 at 0, 1 at 10 m. */
export function engineWindProfile(height: number): number {
  const W = ENGINE_WIND;
  const h = Math.min(Math.max(height, 0), W.top);
  return Math.log(1 + h / W.roughness) / LOG_REFERENCE;
}

/**
 * The wind at world point `p` at motion time `tm`, m/s, in `out` (shader: engineWind): horizontal,
 * along the gust field's downwind direction.
 */
export function engineWind(
  p: Vec3,
  tm: number,
  knobs: EngineWindKnobs,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const W = ENGINE_WIND;
  const g = gustWind(
    gust,
    knobs.wind,
    knobs.gusts,
    knobs.gustRate,
    knobs.nowAge,
    NO_PASSAGE_GUST,
    undefined,
  );
  const load = gustAt(g, p[0], p[2], tm, 0);
  const strength = Math.abs(knobs.wind);
  const speed =
    Math.max(W.speed * strength + (W.gustCalm + W.gustWind * strength) * load, 0) *
    engineWindProfile(p[1]);
  out[0] = g.dirX * speed;
  out[1] = 0;
  out[2] = g.dirZ * speed;
  return out;
}

/**
 * The height fog's optical depth along the ray from `o` in unit direction `d` to distance `t`
 * (shader: engineFogDepth): the integral of fog * density * exp(-y / height) over the ray, in
 * closed form, its series near level so a level ray stays exact.
 */
export function engineFogDepth(fog: number, o: Vec3, d: Vec3, t: number): number {
  const F = ENGINE_FOG;
  const s = Math.min(t, F.far);
  const base = F.density * Math.max(fog, 0) * Math.exp(-Math.max(o[1], F.floor) / F.height);
  const x = (d[1] * s) / F.height;
  const f = Math.abs(x) < 1e-3 ? 1 - x / 2 + (x * x) / 6 : (1 - Math.exp(-Math.max(x, -60))) / x;
  return base * s * f;
}

/**
 * The air in GLSL (see the header), the CPU twins' line for line. After the shader libraries, the
 * gust field and the core's EngineRay.
 */
export const engineAirGlsl = `
// ---- the engine's air (engine/air.ts) ----
const float ENGINE_WIND_SPEED = ${glslFloat(ENGINE_WIND.speed)};
const float ENGINE_GUST_CALM = ${glslFloat(ENGINE_WIND.gustCalm)};
const float ENGINE_GUST_WIND = ${glslFloat(ENGINE_WIND.gustWind)};
const float ENGINE_WIND_ROUGHNESS = ${glslFloat(ENGINE_WIND.roughness)};
const float ENGINE_WIND_LOG_REFERENCE = ${glslFloat(LOG_REFERENCE)};
const float ENGINE_WIND_TOP = ${glslFloat(ENGINE_WIND.top)};

// The wind's share of its reference speed at a height over the ground: 0 at 0, 1 at 10 m.
float engineWindProfile(float height) {
  float h = clamp(height, 0.0, ENGINE_WIND_TOP);
  return log(1.0 + h / ENGINE_WIND_ROUGHNESS) / ENGINE_WIND_LOG_REFERENCE;
}

// The wind at world point p, m/s (tm: uMotionTime): K_wind's steady wind and the gusts at p.xz,
// along the gust field's downwind direction, still at the ground and stronger with height.
vec3 engineWind(vec3 p, float tm) {
  GustWind g = gustWind();
  float load = gustAt(g, p.xz, tm, 0.0);
  float strength = abs(K_wind);
  float speed = max(ENGINE_WIND_SPEED * strength + (ENGINE_GUST_CALM + ENGINE_GUST_WIND * strength) * load, 0.0) * engineWindProfile(p.y);
  return vec3(g.dir.x, 0.0, g.dir.y) * speed;
}

#if WORLD_FOG
const float ENGINE_FOG_DENSITY = ${glslFloat(ENGINE_FOG.density)};
const float ENGINE_FOG_HEIGHT = ${glslFloat(ENGINE_FOG.height)};
const float ENGINE_FOG_FLOOR = ${glslFloat(ENGINE_FOG.floor)};
const float ENGINE_FOG_FAR = ${glslFloat(ENGINE_FOG.far)};
const float ENGINE_FOG_FORWARD = ${glslFloat(ENGINE_FOG.forward)};
const float ENGINE_FOG_SUN = ${glslFloat(ENGINE_FOG.sun)};
const vec3 ENGINE_FOG_TINT = ${glslVec3(ENGINE_FOG.tint)};
const float ENGINE_FOG_GREY = ${glslFloat(ENGINE_FOG.grey)};
const float ENGINE_FOG_SKY = ${glslFloat(ENGINE_FOG.sky)};

// The height fog's optical depth from o along unit d to distance t: fog * density * exp(-y / height)
// integrated in closed form, its series near level.
float engineFogDepth(float fog, vec3 o, vec3 d, float t) {
  float s = min(t, ENGINE_FOG_FAR);
  float base = ENGINE_FOG_DENSITY * max(fog, 0.0) * exp(-max(o.y, ENGINE_FOG_FLOOR) / ENGINE_FOG_HEIGHT);
  float x = d.y * s / ENGINE_FOG_HEIGHT;
  float f = abs(x) < 1e-3 ? 1.0 - x / 2.0 + x * x / 6.0 : (1.0 - exp(-max(x, -60.0))) / x;
  return base * s * f;
}
#endif

// col seen through the height fog (K_fog) along r to distance t (1e5 or more for the sky, whose
// horizon then fogs over): toward the fog's light, the sky's ambient greyed and the key's (sunDir,
// sunCol: the sun's or the moon's, dimmed by what shades the air) scattered forward.
vec3 engineFog(World w, EngineRay r, float t, vec3 col, vec3 sunDir, vec3 sunCol) {
#if WORLD_FOG
  float keep = exp(-engineFogDepth(w.fog, r.o, r.d, t));
  float g = ENGINE_FOG_FORWARD;
  float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * dot(r.d, sunDir), 1.5);
  vec3 light = greyed(w.sky.ambient, ENGINE_FOG_TINT, ENGINE_FOG_GREY) * ENGINE_FOG_SKY + sunCol * ENGINE_FOG_SUN * phase;
  return mix(light, col, keep);
#else
  return col;
#endif
}

#if WORLD_RAIN || WORLD_SNOW
// ---- rain and snow as particles ----
// Three shells round the eye, each a lattice of cells (the shell's size times the fall's cell shape)
// holding at most one particle, walked cell by cell along the ray (a 3D DDA, at most
// ENGINE_PRECIP_STEPS cells a shell). The lattice falls with the particles (their drift through the
// world: the fall and the steady wind, on the fall's clock) and is shifted as a whole by the gust
// now, so a particle moves smoothly, a moving eye sees the near ones pass the far ones, and each is
// tested against the ray exactly: a streak from where it is back along its velocity over the eye's
// shutter (longer in the far shells, so fine rain still reads as streaks), about 2 dither cells wide
// in the nearest shell and 1 in the farthest, hidden behind tHit. Beyond the shells the fall fuses
// into a veil. What a shell's particles share (their streak, their margins in a cell) is worked out
// once a shell, so a cell costs a hash, the streak's nearest point to the ray and a DDA step.
const float ENGINE_PRECIP_FROM[3] = float[3](0.7, 4.0, 12.0);
const float ENGINE_PRECIP_TO[3] = float[3](4.0, 12.0, 32.0);
const float ENGINE_PRECIP_CELL[3] = float[3](0.5, 1.1, 2.6);
const int ENGINE_PRECIP_STEPS = 12;
// The drops are blown by the wind this far above the eye (the air they fall through).
const float ENGINE_PRECIP_LIFT = 2.0;

// One fall's particles: how they move, how big they are, how many and how bright, per shell.
struct EngineFall {
  vec3 drift;    // their velocity through the world, m/s: the fall and the steady wind
  vec3 seen;     // their velocity now, as their streaks show it: drift and the gust
  vec3 offset;   // the gust's shift of the whole lattice, m
  vec2 shear;    // the lattice leans along the drift: horizontal metres per metre fallen
  vec3 shape;    // a cell's shape: times the shell's cell size, metres
  vec3 fill;     // share of cells holding a particle, per shell
  vec3 level;    // a particle's light, per shell
  vec3 shutter;  // the eye's exposure, s, per shell: a streak is seen * shutter long
  vec3 cells;    // a particle's least half-width, in dither cells, per shell
  float radius;  // a particle's own radius, m
  float flutter; // how far it sways about its path, m (0: none)
  float spin;    // its tumbling (snow: 1, catching the light twice a turn) or none (0)
  float clock;   // seconds the lattice has fallen
  float salt;
};

// Four independent 0..1 hashes of a lattice cell (Hoskins, "Hash without Sine").
vec4 engineAirHash(vec3 p) {
  vec4 p4 = fract(p.xyzx * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// The fall's particles along the ray from o in unit direction d nearer than tHit, foot the radians a
// dither cell spans, th the cell's weather threshold: x = their cover (each cell on or off against
// th, at the particle's light), y = the nearest shell's share of it.
vec2 engineFallCover(EngineFall f, vec3 o, vec3 d, float tHit, float foot, float tm, float th) {
  // The lattice's frame: the world less the fall and the gust, leaned along the drift.
  vec3 p = o - f.drift * f.clock - f.offset;
  vec3 qo = vec3(p.x + p.y * f.shear.x, p.y, p.z + p.y * f.shear.y);
  vec3 qd = vec3(d.x + d.y * f.shear.x, d.y, d.z + d.y * f.shear.y);
  float clear = 1.0;
  float near = 0.0;
  for (int k = 0; k < 3; k++) {
    float t0 = ENGINE_PRECIP_FROM[k];
    float t1 = min(ENGINE_PRECIP_TO[k], tHit);
    float fill = f.fill[k];
    if (t0 >= t1 || fill <= 0.0) continue;
    vec3 cell = f.shape * ENGINE_PRECIP_CELL[k];
    // The shell's streak (head to tail, from the head) and its part across the ray; the head sits
    // low enough in its cell for the streak to stay inside.
    vec3 tail = -f.seen * f.shutter[k];
    float b = dot(tail, d);
    vec3 bp = tail - d * b;
    float bb = 1.0 / max(dot(bp, bp), 1e-10);
    vec3 lo = vec3(0.2, 0.06, 0.2);
    vec3 span = vec3(0.6, 0.88 - min(max(tail.y, 0.0) / cell.y, 0.6), 0.6);
    float wide = foot * f.cells[k];
    float salt = f.salt + 61.0 * float(k);
    vec3 go = qo / cell;
    vec3 gd = qd / cell;
    vec3 gp = go + gd * t0;
    vec3 id = floor(gp);
    vec3 st = vec3(gd.x < 0.0 ? -1.0 : 1.0, gd.y < 0.0 ? -1.0 : 1.0, gd.z < 0.0 ? -1.0 : 1.0);
    vec3 inv = 1.0 / max(abs(gd), vec3(1e-6));
    vec3 next = t0 + (st * (id - gp) + max(st, 0.0)) * inv;
    float t = t0;
    for (int i = 0; i < ENGINE_PRECIP_STEPS; i++) {
      if (t >= t1) break;
      vec4 h = engineAirHash(id + salt);
      if (h.x < fill) {
        // The particle's head inside its cell, from the eye in the world, and its sway.
        vec3 at = (id + lo + span * h.yzw) * cell - qo;
        vec3 rel = vec3(at.x - at.y * f.shear.x, at.y, at.z - at.y * f.shear.y);
        if (f.flutter > 0.0) {
          float phase = TAU * fract(h.y * 7.3 + h.w * 3.1);
          float beat = tm * (0.6 + 0.9 * fract(h.z * 5.7));
          rel += f.flutter * vec3(sin(beat + phase), 0.4 * sin(1.7 * beat + 2.0 * phase), cos(0.8 * beat - phase));
        }
        // The streak's nearest point to the ray (u: 0 its head .. 1 its tail), the ray's distance
        // there (s) and how far off it passes.
        float a = dot(rel, d);
        vec3 ap = rel - d * a;
        float u = clamp(-dot(ap, bp) * bb, 0.0, 1.0);
        float s = a + u * b;
        float off = length(ap + bp * u);
        float hw = max(f.radius * (0.65 + 0.35 * fract(h.x * 17.3)), wide * s);
        float shape = (1.0 - smoothstep(0.5 * hw, hw, off)) * (1.0 - smoothstep(0.45, 1.0, u)) * clamp((fill - h.x) * 12.0, 0.0, 1.0);
        float light = f.level[k] * (0.8 + 0.2 * fract(h.x * 53.3));
        if (f.spin > 0.0) light *= 0.75 + 0.25 * sin(2.0 * (tm * (0.3 + 0.9 * fract(h.w * 3.1)) + TAU * fract(h.z * 9.3)));
        bool shown = s > ENGINE_PRECIP_FROM[0] && s < tHit && o.y + rel.y + u * tail.y > 0.0 && shape > th;
        float c = shown ? light : 0.0;
        if (k == 0) near = 1.0 - (1.0 - near) * (1.0 - c);
        clear *= 1.0 - c;
      }
      vec3 m = step(next, min(next.yzx, next.zxy));
      t = min(min(next.x, next.y), next.z);
      next += m * inv;
      id += m * st;
    }
  }
  float cover = 1.0 - clear;
  return vec2(cover, cover > 0.0 ? near / cover : 0.0);
}

// A fall's veil (toward air) and particles (cover, in light) over what lies behind (premultiplied).
vec4 engineAirOver(vec4 behind, vec3 air, float veil, vec3 light, float cover) {
  float a = 1.0 - (1.0 - veil) * (1.0 - cover);
  vec3 rgb = air * veil * (1.0 - cover) + light * cover;
  return vec4(rgb + behind.rgb * (1.0 - a), 1.0 - (1.0 - behind.a) * (1.0 - a));
}

// The rain's cells: three times as tall as wide, for its streaks.
const vec3 ENGINE_RAIN_CELL = vec3(1.0, 3.0, 1.0);
// The gust shifts the rain's lattice by its speed over this many seconds, the snow's by more.
const float ENGINE_RAIN_LAG = 0.3;
const float ENGINE_SNOW_LAG = 1.2;
// The rain's veil: the air's light times this, darker by this share in heavy rain; its drops the
// light they refract times this, never under ENGINE_DROP_FLOOR.
const float ENGINE_RAIN_AIR = 0.55;
const float ENGINE_RAIN_DARK = 0.35;
const float ENGINE_DROP_LIGHT = 1.15;
const float ENGINE_DROP_FLOOR = 0.06;
// Snowflakes: the air's light (its luminance) times this.
const float ENGINE_FLAKE_LIGHT = 1.35;
#endif

// Rain and snow (w.rain, w.snow) between the eye and tHit along r (tm: uMotionTime; the rain falls
// on the World's fall clock, w.tf), premultiplied: draw it as col * (1 - a) + rgb. lightCol: the
// light on the air round the eye (the sky's ambient and the key's colour). Call it where every cell
// runs it (it reads the ray's footprint from its neighbours').
vec4 enginePrecip(World w, EngineRay r, float tHit, float tm, vec3 lightCol) {
  vec4 o = vec4(0.0);
#if WORLD_RAIN || WORLD_SNOW
  float foot = max(length(dFdx(r.d)), length(dFdy(r.d)));
  float th = weatherThreshold();
  float depth = weatherDepth(min(tHit, 1e4));
  vec3 eye = r.o + vec3(0.0, ENGINE_PRECIP_LIFT, 0.0);
  GustWind g = gustWind();
  vec3 steady = vec3(g.dir.x, 0.0, g.dir.y) * ENGINE_WIND_SPEED * abs(K_wind) * engineWindProfile(eye.y);
  vec3 gust = engineWind(eye, tm) - steady;
  vec3 air = lightCol * ENGINE_RAIN_AIR * (1.0 - ENGINE_RAIN_DARK * w.heavy);
#if WORLD_RAIN
  if (w.rain > 0.0) {
    float a = clamp(w.rain, 0.0, 1.0);
    float fall = mix(6.0, 9.0, smoothstep(0.05, 0.85, a)); // m/s: drizzle drifts, a downpour hurtles
    EngineFall f;
    f.drift = vec3(steady.x, -fall, steady.z);
    f.seen = f.drift + gust;
    f.offset = gust * ENGINE_RAIN_LAG;
    f.shear = steady.xz / fall;
    f.shape = ENGINE_RAIN_CELL;
    // Far shells fill first (drizzle is fine and distant), the big near drops only in real rain.
    f.fill = vec3(0.55 * smoothstep(0.15, 0.9, a), 0.6 * smoothstep(0.05, 0.75, a), 0.7 * smoothstep(-0.05, 0.6, a));
    f.level = vec3(0.85, 0.7, 0.5) * mix(0.75, 1.0, smoothstep(0.05, 0.7, a));
    // 1/30 s for the nearest drops, longer for far ones (0.033 s times the shell's middle distance
    // to the 0.32), so that fine far rain still reads as streaks, not dots.
    f.shutter = vec3(0.041, 0.062, 0.086);
    f.radius = 0.0015;
    f.cells = vec3(1.0, 0.75, 0.5);
    f.flutter = 0.0;
    f.spin = 0.0;
    f.clock = w.tf;
    f.salt = 0.0;
    vec2 c = engineFallCover(f, r.o, r.d, tHit, foot, tm, th);
    // The rain too fine and far to resolve: weatherDepth's veil, as rainFallSeen's.
    float k = 0.22 * smoothstep(0.0, 0.12, a) + 0.3 * a + 0.87 * a * a * a;
    float veil = 1.0 - exp(-k * depth * (0.4 + 0.6 * depth));
    vec3 drop = (lightCol * ENGINE_DROP_LIGHT + ENGINE_DROP_FLOOR) * (1.0 - WORLD_NEAR_DIM * c.y);
    o = engineAirOver(o, air, veil, drop, c.x);
  }
#endif
#if WORLD_SNOW
  if (w.snow > 0.0) {
    float a = clamp(w.snow, 0.0, 1.0);
    float fall = mix(0.8, 1.3, a); // m/s
    EngineFall f;
    f.drift = vec3(steady.x, -fall, steady.z);
    f.seen = f.drift + gust;
    f.offset = gust * ENGINE_SNOW_LAG;
    f.shear = vec2(0.0);
    f.shape = vec3(1.1);
    f.fill = vec3(0.6 * smoothstep(-0.2, 0.6, a), 0.65 * smoothstep(-0.25, 0.65, a), 0.7 * smoothstep(-0.3, 0.7, a));
    f.level = vec3(0.7, 0.95, 0.85);
    f.shutter = vec3(0.015);
    f.radius = 0.006;
    f.cells = vec3(2.2, 1.6, 1.0);
    f.flutter = 0.06;
    f.spin = 1.0;
    f.clock = tm;
    f.salt = 17.0;
    vec2 c = engineFallCover(f, r.o, r.d, tHit, foot, tm, th);
    float k = 0.12 * smoothstep(0.0, 0.15, a) + 0.35 * a + 2.1 * a * a * a;
    float veil = 1.0 - exp(-k * depth * (0.4 + 0.6 * depth));
    vec3 flake = WORLD_FLAKE * (dot(lightCol, LUMA) * ENGINE_FLAKE_LIGHT + 0.04);
    o = engineAirOver(o, mix(air, flake, 0.5), veil, flake * (1.0 - WORLD_NEAR_DIM * c.y), c.x);
  }
#endif
#endif
  return o;
}

// ---- weather on surfaces ----
// How porous a surface the engine shades is taken to be (wetten: 0 stone, metal, glass .. 1 soil,
// wood, cloth), and how much darker and glossier its puddles stand on level ground.
const float ENGINE_POROUS = 0.5;
const float ENGINE_PUDDLE_DARK = 0.35;
// Lying snow: in the key's light, and bluer where the key does not reach.
const vec3 ENGINE_SNOW_LIT = vec3(0.93, 0.95, 0.98);
const vec3 ENGINE_SNOW_SHADE = vec3(0.8, 0.87, 0.98);

// How wet a surface facing n is, of the ground's w.wet: tops and sides, not undersides.
float engineWetness(World w, vec3 n) {
  return w.wet * smoothstep(-0.7, -0.1, n.y) * mix(0.6, 1.0, smoothstep(0.0, 0.7, n.y));
}

// albedo at world point p on a surface facing n (unit), under the World's weather: wetted and
// pooled after rain (w.wet: darker and richer, puddles on level ground) and under the snow that lies
// (w.lying: on what faces up, white, bluer where the key does not reach).
vec3 engineSurfaceWeather(World w, vec3 p, vec3 n, vec3 albedo) {
  vec3 col = albedo;
#if WORLD_RAIN
  col = wetten(col, engineWetness(w, n), ENGINE_POROUS);
  col *= 1.0 - ENGINE_PUDDLE_DARK * rainPuddles(p.xz, w.wet) * smoothstep(0.9, 0.98, n.y);
#endif
#if WORLD_SNOW || defined(SKY_DATE_ANCHOR)
  float lit = clamp(dot(n, w.sky.sun), 0.0, 1.0) * smoothstep(-0.05, 0.1, w.sky.sun.y);
  col = mix(col, mix(ENGINE_SNOW_SHADE, ENGINE_SNOW_LIT, lit), snowCover(n, p.xz, w.lying));
#endif
  return col;
}

// A wet surface's extra gloss 0..1 at p facing n: wetGloss of its wetness, a puddle a mirror; less
// where snow lies.
float engineWetGloss(World w, vec3 p, vec3 n) {
#if WORLD_RAIN
  float gloss = max(wetGloss(engineWetness(w, n), n.y), rainPuddles(p.xz, w.wet) * smoothstep(0.9, 0.98, n.y));
  return gloss * (1.0 - w.lying * smoothstep(0.0, 0.85, n.y));
#else
  return 0.0;
#endif
}
`;
