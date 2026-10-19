// The engine's GLSL (src/engine/README.md "A frame"): one ray per dither cell from the document's
// camera, every placed object of every kind tested in its own frame, the nearest hit shaded once
// with the World's light, the sky where nothing is hit, then the air. Assembled for a program by
// src/engine/program.ts: the World (worldGlsl), the gust field, `engineTypesGlsl`, the air
// (src/engine/air.ts, which takes EngineRay), then `engineGlsl(plan)`: the core, each kind's code
// and the entry, `engineEntry`.
//
// THE KIND CONTRACT. A kind's GLSL (KindCode.glsl) names everything it defines with its id as the
// prefix (`<id>`, below) and works in the object's own frame: origin at its base centre, +y up, +z
// its forward, metres at scale 1. The core hands it the object as `EngineObj o` (its row, its first
// texel, at, scale, its bounds and its turn) and reads its options for it: `float <id><Key>(EngineObj
// o)` is the instance's value of option `key` (`groundRelief(o)`), generated ahead of the kind's
// code; a compiled option's value is readable so too, and the kind's GLSL is generated for the set of
// values its instances hold (KindCode.glsl). `engineCell` holds the radians one cell spans: a
// footprint at object distance t is `t * engineCell`, for detail by distance; `engineFoot` the
// footprint of the point a shadow ray leaves from, so a shadow tests no finer detail than its
// surface was drawn with. Animate an instance from its option values and the motion clock
// (`uMotionTime`, as the lamp's flicker does), never the scene clock. A kind that keeps sim state
// per instance (KindDef.state, stepped on the CPU by KindCode.sim: src/engine/state.ts) reads it
// as `vec4 <id>State(EngineObj o, int x, int y)`, texel (x, y) of the instance's block, generated
// beside its option accessors: zeros until its sim has warmed up.
//
// A kind's code follows the core's types and helpers (EngineObj, Hit, EngineLight, engineTexel,
// engineSlab, the frame conversions, its option accessors) and the shared libraries, and comes
// before the shadow, trace and light loops that call it. Its functions:
//
// Required:
//   float <id>Hit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part);
//     The nearest hit of the ray ro + rd t (rd unit; t in the object's metres, the world's t over
//     its scale) with t in span (already clipped to its bounds, to the eye and to the nearest hit so
//     far): its t, else -1. n: the unit normal there, `part`: anything the surface wants to know of
//     where it was hit (which piece of a compound shape, how far off).
//   void <id>Surface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h);
//     The surface at the hit (point p, normal n, as <id>Hit gave them), called once a cell for the
//     winning hit: sets h.albedo, h.emit (light it gives off, also the cell's accent), h.rough (0
//     polished .. 1 matte: the key's highlight), h.mirror (the share the one reflected ray shows: a
//     kind whose code can set it says so, KindCode.mirror), h.clear (the light it lets through, per
//     channel, below: a kind whose code can set it says so, KindCode.glass) and h.mat (its
//     material, any id); may bend n (a bump).
// With KindDef.casts:
//   float <id>Shadow(EngineObj o, vec3 ro, vec3 rd, vec2 span);
//     How much light the ray ro + rd t, t in span, lets through it: 1 open .. 0 blocked (soft
//     between, for a penumbra). Called for the World's key and every lamp's light, for each cell.
// With KindDef.emits:
//   EngineLight <id>Light(EngineObj o);
//     The point light it gives off: where (its own frame), its colour times its power, its reach
//     (metres at scale 1: the light falls to half at reach). Every lit surface sums it, shadowed by
//     the casting objects between.
//
// SEE-THROUGH SURFACES. A surface whose h.clear is above 0 (a window's glass) shows what lies behind
// it: the ray carries on from just past it (engineBehind) through at most ENGINE_PANES more such
// surfaces, each adding its own light and tinting what lies behind by its h.clear, to what it meets
// (lit, and hazed and fogged from the last pane on) or the sky. That, times h.clear, adds to the
// surface's own light (its albedo, small for clean glass), and its h.mirror reflects over both as a
// mirror's does: a pane shows the world outside by day and, faintly, the lit room at night. Light
// passes it as its kind's <id>Shadow says (the room's lets it through). All of it (Hit.clear itself,
// the ray carried on, the one reflected ray) is compiled in only while some kind's code can set it
// (KindCode.glass), so a kind's GLSL writes h.clear only for the compiled values its KindCode.glass
// answers true for; a program without one carries none of it.
import { WORLD_TRIGGERS } from "../composer/compose.ts";
import { glslFloat } from "../shaders/glsl.ts";
import { instanceStride, optionTexel } from "./instances.ts";
import { stateRow } from "./state.ts";
import type { KindCode, KindDef } from "./types.ts";

/** What a program draws of one kind: its code for its compiled values, its row, its loop's size. */
export interface KindPlan {
  readonly kind: KindDef;
  readonly code: KindCode;
  /** Its row of the instance texture (src/engine/instances.ts). */
  readonly row: number;
  /** Its loop's size: its instance count rounded up to a bucket. */
  readonly bucket: number;
  /** For each compiled option, the bitmask of the values its instances hold. */
  readonly compiled: Readonly<Record<string, number>>;
}

/** The entry `main` calls (SceneCode.entry). */
export const ENGINE_ENTRY = "engineEntry";

/** The ray every engine function takes; the air's (src/engine/air.ts) included, so it comes first. */
export const engineTypesGlsl = `
// ---- the engine's ray (src/engine/glsl.ts) ----
struct EngineRay { vec3 o; vec3 d; };  // from o along d (unit), metres
`;

const XYZW = "xyzw";

/**
 * `<id><Key>(o)` for each of a kind's options: its value of the instance; and `<id>State(o, x, y)`
 * for a kind that keeps state: texel (x, y) of the instance's block (src/engine/state.ts), its
 * index among its kind's instances from its first texel in the instance texture.
 */
function accessors(kind: KindDef): string {
  const options = kind.options.map((def, k) => {
    const [texel, component] = optionTexel(k);
    const name = `${kind.id}${def.key.charAt(0).toUpperCase()}${def.key.slice(1)}`;
    return `float ${name}(EngineObj o) { return engineTexel(o.col + ${texel}, o.row).${XYZW.charAt(component)}; }`;
  });
  const state =
    kind.state === undefined
      ? []
      : [
          `vec4 ${kind.id}State(EngineObj o, int x, int y) { return engineState(o.col / ${instanceStride(kind)} * ${kind.state.width} + x, ${stateRow(kind)} + y); }`,
        ];
  return [...options, ...state].join("\n");
}

/** The loop over one kind's instances (its bucket's size), testing each in its own frame. */
function instanceLoop(plan: KindPlan, tMax: string, body: string): string {
  return `  for (int i = 0; i < ${plan.bucket}; i++) {
    if (i >= engineCount(${plan.row})) break;
    EngineObj o = engineObj(${plan.row}, i, ${instanceStride(plan.kind)});
    vec3 ro = engineToObject(o, r.o);
    vec3 rd = engineDirToObject(o, r.d);
    vec2 span = engineSlab(ro, rd, o.lo, o.hi);
    span = vec2(max(span.x, 0.0), min(span.y, ${tMax} / o.scale));
    if (span.x > span.y) continue;
${body}
  }`;
}

/**
 * The core, every kind's code and the entry for one program's kinds (`plans`, in row order), whether
 * any of them can draw a mirror (`mirror`: the one reflected ray is compiled in) and whether any can
 * draw a see-through surface (`glass`: the ray carried on past it, and the reflected ray with it).
 */
export function engineGlsl(plans: readonly KindPlan[], mirror: boolean, glass: boolean): string {
  const casting = plans.filter((plan) => plan.kind.casts === true);
  const emitting = plans.filter((plan) => plan.kind.emits === true);
  const trace = plans
    .map((plan) =>
      instanceLoop(
        plan,
        "h.t",
        `    vec3 n;
    float part;
    float t = ${plan.kind.id}Hit(o, ro, rd, span, n, part);
    if (t >= 0.0 && t * o.scale < h.t) {
      h.t = t * o.scale;
      h.row = ${plan.row};
      h.o = o;
      h.p = ro + rd * t;
      h.n = n;
      h.part = part;
    }`,
      ),
    )
    .join("\n");
  const surfaces = plans
    .map(
      (plan, k) =>
        `  ${k === 0 ? "" : "else "}if (h.row == ${plan.row}) ${plan.kind.id}Surface(h.o, h.p, n, h.part, h);`,
    )
    .join("\n");
  const shadows = casting
    .map((plan) =>
      instanceLoop(plan, "tMax", `    lit = min(lit, ${plan.kind.id}Shadow(o, ro, rd, span));`),
    )
    .join("\n");
  const lights = emitting
    .map(
      (plan) => `  for (int i = 0; i < ${plan.bucket}; i++) {
    if (i >= engineCount(${plan.row})) break;
    EngineObj o = engineObj(${plan.row}, i, ${instanceStride(plan.kind)});
    EngineLight light = ${plan.kind.id}Light(o);
    vec3 to = enginePointToWorld(o, light.at) - p;
    float d = max(length(to), 1e-3);
    vec3 l = to / d;
    float face = max(dot(n, l), 0.0);
    float reach = light.reach * o.scale;
    if (face > 0.0) sum += light.col * face / (1.0 + d * d / (reach * reach)) * engineShadow(p, l, d * 0.98);
  }`,
    )
    .join("\n");
  return `
// ---- the engine (src/engine/glsl.ts): kinds ${plans.map((plan) => `${plan.kind.id}×${plan.bucket}`).join(", ") || "none"} ----
const float ENGINE_FAR = 1e5;
// Aerial perspective: the distance over which far land takes on the haze of the sky at its horizon.
const float ENGINE_HAZE = ${glslFloat(9000)};
// Where shooting stars set out: all round, from low over the horizon to high up (skyAngles).
const vec4 ENGINE_METEOR_FIELD = vec4(-3.14159, 0.12, 6.28318, 0.8);
// The ink of the dither (inkOf): the outdoor composer's.
const float ENGINE_INK_GAIN = 1.3;
const float ENGINE_INK_GAMMA = 1.0;${
    glass
      ? `
// The most see-through surfaces a ray carries on past beyond the first (engineBehind).
const int ENGINE_PANES = 2;`
      : ""
  }

// Radians one cell spans (set once a cell, in the entry): a footprint at distance t is t * engineCell.
float engineCell;
// The footprint (metres) of the point being lit, set before its shadow rays: a <id>Shadow tests no
// finer detail than that surface was drawn with.
float engineFoot;

// A placed object as the instance texture holds it (src/engine/instances.ts).
struct EngineObj {
  int row;      // its kind's row
  int col;      // its first texel
  vec3 at;      // its origin, world metres
  float scale;
  vec3 lo;      // its bounds, its own frame, unscaled
  vec3 hi;
  vec2 turn;    // cos and sin of its yaw
};

// What a ray met: the winning object's hit, then (engineSurface) its surface.
struct Hit {
  float t;       // distance along the ray, metres; the ray's limit where nothing is hit
  vec3 n;        // unit normal: the object's frame until engineSurface turns it into the world's
  vec3 albedo;
  vec3 emit;     // light it gives off
  float rough;   // 0 polished .. 1 matte
  float mirror;  // the share of the reflected ray it shows, 0..1${
    glass
      ? `
  vec3 clear;    // the light it lets through, per channel: 0 opaque .. 1 clear (see-through surfaces)`
      : ""
  }
  int obj;       // its index in the document's objects; -1 nothing
  int mat;       // its kind's material id
  int row;       // its kind's row; 0 nothing
  EngineObj o;
  vec3 p;        // the hit in the object's frame
  float part;    // the kind's own note of where it was hit
};

// A point light a kind gives off (<id>Light).
struct EngineLight {
  vec3 at;       // the object's own frame
  vec3 col;      // colour times power
  float reach;   // metres at scale 1: the light falls to half there
};

vec4 engineTexel(int col, int row) {
  return texelFetch(uSim0, ivec2(col, row), 0);
}

// Texel (col, row) of the state texture (src/engine/state.ts): zeros until the sim has handed it over.
vec4 engineState(int col, int row) {
  return uSimOn.y > 0.5 ? texelFetch(uSim1, ivec2(col, row), 0) : vec4(0.0);
}

bool engineOn() {
  return uSimOn.x > 0.5;
}

// How many objects of the kind in row \`row\` the document holds.
int engineCount(int row) {
  return engineOn() ? int(engineTexel(3 + row, 0).x + 0.5) : 0;
}

EngineObj engineObj(int row, int i, int stride) {
  EngineObj o;
  o.row = row;
  o.col = i * stride;
  vec4 a = engineTexel(o.col, row);
  vec4 b = engineTexel(o.col + 1, row);
  vec4 c = engineTexel(o.col + 2, row);
  o.at = a.xyz;
  o.scale = a.w;
  o.lo = b.xyz;
  o.hi = c.xyz;
  o.turn = vec2(b.w, c.w);
  return o;
}

int engineIndex(EngineObj o) {
  return int(engineTexel(o.col + 3, o.row).x + 0.5);
}

// The world's direction d in the object's frame, and back.
vec3 engineDirToObject(EngineObj o, vec3 d) {
  return vec3(o.turn.x * d.x + o.turn.y * d.z, d.y, o.turn.x * d.z - o.turn.y * d.x);
}

vec3 engineDirToWorld(EngineObj o, vec3 d) {
  return vec3(o.turn.x * d.x - o.turn.y * d.z, d.y, o.turn.y * d.x + o.turn.x * d.z);
}

vec3 engineToObject(EngineObj o, vec3 p) {
  return engineDirToObject(o, (p - o.at) / o.scale);
}

vec3 enginePointToWorld(EngineObj o, vec3 p) {
  return o.at + o.scale * engineDirToWorld(o, p);
}

// Where the ray ro + rd t is inside the box lo..hi: t from x to y (none where x > y).
vec2 engineSlab(vec3 ro, vec3 rd, vec3 lo, vec3 hi) {
  vec3 side = vec3(rd.x < 0.0 ? -1.0 : 1.0, rd.y < 0.0 ? -1.0 : 1.0, rd.z < 0.0 ? -1.0 : 1.0);
  vec3 inv = side / max(abs(rd), vec3(1e-9));
  vec3 a = (lo - ro) * inv;
  vec3 b = (hi - ro) * inv;
  vec3 near = min(a, b);
  vec3 far = max(a, b);
  return vec2(max(max(near.x, near.y), near.z), min(min(far.x, far.y), far.z));
}

// The camera, from the instance texture's header: its eye, axes and tan(fov / 2).
struct EngineCam { vec3 eye; vec3 fwd; vec3 right; vec3 up; float tan; };

EngineCam engineCamera() {
  EngineCam c;
  if (!engineOn()) {
    c.eye = vec3(0.0, 1.65, 0.0);
    c.fwd = vec3(0.0, 0.0, 1.0);
    c.right = vec3(1.0, 0.0, 0.0);
    c.up = vec3(0.0, 1.0, 0.0);
    c.tan = 0.45;
    return c;
  }
  vec4 eye = engineTexel(0, 0);
  c.eye = eye.xyz;
  c.tan = eye.w;
  c.fwd = engineTexel(1, 0).xyz;
  c.right = engineTexel(2, 0).xyz;
  c.up = engineTexel(3, 0).xyz;
  return c;
}

// The World's view along d for the sky: a pinhole at the camera's focal, its horizon where the
// camera's pitch puts it (for what the World still draws on the screen: the bolt).
WorldView engineView(EngineCam c, vec3 d, vec2 uv) {
  float focal = 0.5 / c.tan;
  float level = length(c.fwd.xz);
  float horizon = 0.5 - focal * c.fwd.y / max(level, 1e-3);
  return worldViewOf(d, uv, clamp(horizon, -4.0, 5.0), focal, c.eye.y, 0.0, 1.0);
}

vec3 engineSky(World w, EngineCam c, vec3 d, vec2 uv) {
  WorldSky s = worldSky(w, engineView(c, d, uv), ENGINE_METEOR_FIELD);
  return s.col + s.strike;
}

${plans.map((plan) => `// ---- ${plan.kind.id}'s options ----\n${accessors(plan.kind)}`).join("\n")}

${plans.map((plan) => `// ---- the kind ${plan.kind.id} (src/engine/kinds/${plan.kind.id}) ----\n${plan.code.glsl(plan.compiled)}`).join("\n")}

// How much of a light along l from world point p reaches it past the casting objects, within tMax.
float engineShadow(vec3 p, vec3 l, float tMax) {
  float lit = 1.0;
  EngineRay r = EngineRay(p, l);
${shadows}
  return lit;
}

// The nearest object the ray meets within tMax.
Hit engineTrace(EngineRay r, float tMax) {
  Hit h;
  h.t = tMax;
  h.row = 0;
  h.obj = -1;
  h.mat = 0;
  h.n = vec3(0.0, 1.0, 0.0);
  h.p = vec3(0.0);
  h.part = 0.0;
  h.albedo = vec3(0.0);
  h.emit = vec3(0.0);
  h.rough = 1.0;
  h.mirror = 0.0;${glass ? "\n  h.clear = vec3(0.0);" : ""}
${trace}
  return h;
}

// The winning hit's surface, by its kind; its normal into the world's frame.
void engineSurface(inout Hit h) {
  if (h.row == 0) return;
  h.albedo = vec3(0.5);
  vec3 n = h.n;
${surfaces}
  h.n = normalize(engineDirToWorld(h.o, n));
  h.obj = engineIndex(h.o);
}

// The lamps' light at world point p facing n.
vec3 engineLights(vec3 p, vec3 n) {
  vec3 sum = vec3(0.0);
${lights}
  return sum;
}

// The World's key light: the sun, or the moon once the sun is down.
struct EngineKey { vec3 dir; vec3 col; };

EngineKey engineKey(World w) {
  bool moon = w.sky.sun.y < -0.02;
  return EngineKey(moon ? w.sky.moon : w.sky.sun, moon ? w.sky.moonColor : w.sky.sunColor);
}

// A hit lit: the key past the casting objects and the cloud's shadow, the sky's light from above,
// the lamps', the World's wet and snow on it, its highlight and its own glow.
vec3 engineLit(World w, WorldView v, EngineKey key, EngineRay r, Hit h, EngineCam c) {
  vec3 p = r.o + r.d * h.t;
  vec3 n = dot(h.n, r.d) > 0.0 ? -h.n : h.n;
  vec3 lifted = p + n * (0.002 + h.t * 4e-4);
  vec3 albedo = engineSurfaceWeather(w, p, n, h.albedo);
  float face = max(dot(n, key.dir), 0.0);
  engineFoot = h.t * engineCell;
  float lit = face > 0.0 ? engineShadow(lifted, key.dir, ENGINE_FAR) * worldSunlit(w, v, p - c.eye) : 0.0;
  vec3 sky = w.sky.ambient * (0.6 + 0.4 * n.y);
  vec3 col = albedo * (key.col * face * lit + sky + engineLights(lifted, n)) + h.emit;
  // Its highlight: polished by its material, or by the rain's film on it.
  float gloss = max(1.0 - h.rough, engineWetGloss(w, p, n));
  float shine = pow(max(dot(reflect(r.d, n), key.dir), 0.0), mix(6.0, 160.0, gloss));
  return col + key.col * shine * gloss * lit * 0.6;
}

// Far land taking on the haze of the sky at its horizon.
vec3 engineHaze(World w, vec3 d, float t, vec3 col) {
  return mix(col, horizonHaze(w.sky, d, 0.02), 1.0 - exp(-t / ENGINE_HAZE));
}${
    glass
      ? `

// What lies behind the see-through hit h along r (Hit.clear): the ray carried on from just past it
// through at most ENGINE_PANES more see-through surfaces, each adding its own light and tinting what
// lies behind it, to what it meets (lit, then hazed and fogged from the last pane on) or the sky.
// glow: the light given off there that comes through, for the cell's accent.
vec3 engineBehind(World w, WorldView v, EngineKey key, EngineRay r, Hit h, EngineCam c, vec2 uv, out float glow) {
  vec3 col = vec3(0.0);
  vec3 pass = vec3(1.0);
  float from = h.t;
  glow = 0.0;
  for (int k = 0; k <= ENGINE_PANES; k++) {
    float skip = from + 0.002 + from * 4e-4;
    Hit g = engineTrace(EngineRay(r.o + r.d * skip, r.d), ENGINE_FAR);
    float to = ENGINE_FAR;
    vec3 seen;
    if (g.row == 0) {
      seen = engineSky(w, c, r.d, uv);
    } else {
      g.t += skip;
      to = g.t;
      engineSurface(g);
      seen = engineLit(w, v, key, r, g, c);
      if (k < ENGINE_PANES && g.clear != vec3(0.0)) {
        col += pass * seen;
        pass *= g.clear;
        from = g.t;
        continue;
      }
      seen = engineHaze(w, r.d, to - from, seen);
      glow = dot(g.emit * pass, LUMA);
    }
    return col + pass * engineFog(w, EngineRay(r.o + r.d * from, r.d), to - from, seen, key.dir, key.col);
  }
  return col;
}`
      : ""
  }

Shade ${ENGINE_ENTRY}(vec2 uv, vec2 cell, float time) {
  World w = worldAt(${WORLD_TRIGGERS.meteors}, ${WORLD_TRIGGERS.lightning});
  EngineCam c = engineCamera();
  engineCell = 2.0 * c.tan / uRes.y;
  vec2 ndc = uv * 2.0 - 1.0;
  EngineRay r = EngineRay(c.eye, normalize(c.fwd + c.right * (ndc.x * c.tan * uRes.x / uRes.y) + c.up * (ndc.y * c.tan)));
  WorldView v = engineView(c, r.d, uv);
  EngineKey key = engineKey(w);
  Hit h = engineTrace(r, ENGINE_FAR);
  engineSurface(h);
  vec3 col;
  float accent = 0.0;
  if (h.row == 0) {
    col = engineSky(w, c, r.d, uv);
  } else {
    col = engineLit(w, v, key, r, h, c);${
      glass
        ? `
    // A see-through surface: what lies behind it, through it.
    float glow = 0.0;
    if (h.clear != vec3(0.0)) {
      col += h.clear * engineBehind(w, v, key, r, h, c, uv, glow);
      glow *= dot(h.clear, LUMA);
    }`
        : ""
    }
${
  mirror || glass
    ? `    if (h.mirror > 0.0) {
      // One bounce: what the mirror shows, lit but not mirrored again.
      vec3 n = dot(h.n, r.d) > 0.0 ? -h.n : h.n;
      EngineRay m = EngineRay(r.o + r.d * h.t + n * (0.002 + h.t * 4e-4), reflect(r.d, n));
      Hit g = engineTrace(m, ENGINE_FAR);
      engineSurface(g);
      vec3 seen = g.row == 0 ? engineSky(w, c, m.d, uv) : engineHaze(w, m.d, g.t, engineLit(w, v, key, m, g, c));
      float fresnel = h.mirror + (1.0 - h.mirror) * pow(1.0 - max(dot(n, -r.d), 0.0), 5.0);
      col = mix(col, seen, clamp(fresnel * h.mirror, 0.0, 1.0));
    }
`
    : ""
}    col = engineHaze(w, r.d, h.t, col);
    accent = clamp(dot(h.emit, LUMA)${glass ? " + glow" : ""}, 0.0, 1.0);
  }
  // The air between the eye and what the cell shows: fog, then rain and snow.
  col = engineFog(w, r, h.t, col, key.dir, key.col);
  vec4 fall = enginePrecip(w, r, h.t, w.tm, key.col + w.sky.ambient);
  col = col * (1.0 - fall.a) + fall.rgb;
  accent *= 1.0 - fall.a;
  return shadeOf(col, inkOf(col, ENGINE_INK_GAIN, ENGINE_INK_GAMMA), accent);
}
`;
}
