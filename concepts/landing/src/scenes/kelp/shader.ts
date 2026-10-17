// The kelp forest's picture: a side-on view from mid-water, the sea floor below and the surface's
// underside above, both receding into blue-green haze toward eye level. Back to front: floor or
// surface (a rippled silver ceiling, Snell's window overhead, the kelp canopy floating on it: dark,
// cut by sunlit gaps), the boulders, urchins, anemones and small kelp on the floor, a hazy wall of
// distant kelp, four layers of simulated giant kelp with marine snow between them, a passing sea
// lion, the Manifold stone, jellyfish, the school of fish; then the light shafts, falling through
// the canopy's gaps, in the water in front of it all and, at night, plankton sparking where the
// water is stirred.
//
// Giant kelp (Macrocystis) as it grows: a thin, flexible stipe; long, wide, wavy-edged blades, one
// at a time on alternate sides, each on a small gas bladder, streaming with the water past them
// (sim.ts leans them) and rippling; a holdfast of branching haptera gripping a small rock; and in
// grown plants a top that bends over at the surface and trails along it downstream, its blades
// hanging as the canopy.
//
// One light model throughout: the shared sky's sun, moon and sky glow enter at the surface; the
// water absorbs red first (KELP_ABSORB per world unit of depth) and scatters what is left into the
// blue-green the far things fade to. The direct beam carries a soft caustic net (kelpCaustic, one
// slowly drifting function for the floor, the kelp and the stone), shines through the blades and
// converges, refracted, on a vanishing point above the frame that the shafts fan out from.
//
// Under the dither: nothing changes by chance from frame to frame, and the scene sets no shimmer.
// Every hard edge (kelp, floor life, canopy, fish, snow, the stone, the sea lion) is cut against a
// per-cell threshold, so an edge passing over a cell flips it once; the light patterns drift
// slowly and keep their contrast low.
//
// Sim textures (sim.ts): uSim0 the kelp's points, uSim1 the state rows (stipes, fish, globals,
// canopy), uSim2 the hand's trail. Units: screen heights, x from the frame's centre, y up from its
// bottom; a depth layer at perspective scale s shows world lengths times s ("world" = screen
// heights at the nearest layer).
// Knobs read here: K_haze, K_rays, K_caustics, K_surface, K_density, K_kelpSeed, K_species,
// K_understory, K_marineSnow, K_jellies, K_plankton, K_mark, K_time, K_cycle.
import { fishGlsl } from "../../sims/fish.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import {
  KELP_CAMERA,
  KELP_FISH,
  KELP_GLOBAL,
  KELP_LAYERS,
  KELP_MARK,
  KELP_ORIGIN,
  KELP_PASSAGE,
  KELP_POINT_ROW,
  KELP_POINTS,
  KELP_ROW,
  KELP_SEGMENTS,
  KELP_SURGE,
  KELP_SWELL,
  KELP_VIEW,
  KELP_VISITOR,
} from "./sim.ts";

/** A number as a GLSL float literal. */
const num = (x: number): string => x.toFixed(6);
/** A constant GLSL array of the given element type. */
const glslArray = (type: "float" | "int", values: readonly number[]): string =>
  `${type}[${values.length}](${values.map((v) => (type === "float" ? num(v) : String(v))).join(", ")})`;

const layerCount = KELP_LAYERS.length;

export const kelpGlsl = `${fishGlsl}
// ---- shared with the simulation (sim.ts) ----
const float KELP_HORIZON = ${num(KELP_VIEW.horizon)};
const float KELP_FLOOR = ${num(KELP_VIEW.floor)};
const float KELP_SURFACE = ${num(KELP_VIEW.surface)};
const float KELP_FOCAL = ${num(KELP_VIEW.focal)};
const int KELP_SEGMENTS = ${KELP_SEGMENTS};
const int KELP_POINTS = ${KELP_POINTS};
const int KELP_POINT_ROW = ${KELP_POINT_ROW};
const vec3 KELP_ORIGIN = vec3(${KELP_ORIGIN.map(num).join(", ")});
const float KELP_LAYER_SCALE[${layerCount}] = ${glslArray(
  "float",
  KELP_LAYERS.map((l) => l.scale),
)};
const float KELP_LAYER_LEFT[${layerCount}] = ${glslArray(
  "float",
  KELP_LAYERS.map((l) => l.left),
)};
const float KELP_LAYER_SPACING[${layerCount}] = ${glslArray(
  "float",
  KELP_LAYERS.map((l) => l.spacing),
)};
const int KELP_LAYER_SLOTS[${layerCount}] = ${glslArray(
  "int",
  KELP_LAYERS.map((l) => l.slots),
)};
const int KELP_LAYER_FIRST[${layerCount}] = ${glslArray(
  "int",
  KELP_LAYERS.map((l) => l.first),
)};
const int KELP_ROW_STIPES = ${KELP_ROW.stipes};
const int KELP_ROW_FISH_POSE = ${KELP_ROW.fishPose};
const int KELP_ROW_FISH_LOOK = ${KELP_ROW.fishLook};
const int KELP_ROW_GLOBALS = ${KELP_ROW.globals};
const int KELP_ROW_CANOPY = ${KELP_ROW.canopy};
const int KELP_ROW_SCALE = ${KELP_ROW.scale};
const int KELP_G_PHASES = ${KELP_GLOBAL.phases};
const int KELP_G_FLOW = ${KELP_GLOBAL.flow};
const int KELP_G_SCHOOL = ${KELP_GLOBAL.school};
const int KELP_G_VISITOR_POSE = ${KELP_GLOBAL.visitorPose};
const int KELP_G_VISITOR_LOOK = ${KELP_GLOBAL.visitorLook};
const int KELP_MAX_FISH = ${KELP_FISH.max};
const float KELP_FISH_SCALE = ${num(KELP_FISH.scale)};
const float KELP_VISITOR_SCALE = ${num(KELP_VISITOR.scale)};
const float KELP_VISITOR_LENGTH = ${num(KELP_VISITOR.length)};
const float KELP_MARK_SCALE = ${num(KELP_MARK.scale)};
const float KELP_MARK_X = ${num(KELP_MARK.x)};
const float KELP_MARK_LOW = ${num(KELP_MARK.low)};
const float KELP_MARK_HIGH = ${num(KELP_MARK.high)};
const float KELP_MARK_HALF = ${num(KELP_MARK.halfWidth)};
const float KELP_SURGE_SPEED = ${num(KELP_SURGE.speed)};
const float KELP_SURGE_K1 = ${num(KELP_SURGE.k1)};
const float KELP_SURGE_K2 = ${num(KELP_SURGE.k2)};
const float KELP_SURGE_SECOND = ${num(KELP_SURGE.second)};
const float KELP_SURGE_RATIO = ${num(KELP_SURGE.ratio)};
const float KELP_SURGE_PHASE2 = ${num(KELP_SURGE.phase2)};
const float KELP_SWELL_AMPLITUDE = ${num(KELP_SWELL.amplitude)};
const float KELP_SWELL_PERIOD = ${num(KELP_SWELL.period)};
const float KELP_SWELL_SPAN = ${num(KELP_SWELL.span)};
const float KELP_SWELL_START = ${num(KELP_SWELL.start)};
const float KELP_SWELL_SPEED = ${num(KELP_SWELL.speed)};

// ---- the camera's passage (sim.ts KELP_CAMERA, KELP_PASSAGE) ----
const float KELP_DIP_FROM = ${glslFloat(KELP_CAMERA.dipFrom / KELP_PASSAGE.enter)};   // entrance progress it starts to settle past its mark at
const float KELP_DROP = ${glslFloat(KELP_CAMERA.drop)};                                // world units above its place it starts, just under the surface
const float KELP_DIP = ${glslFloat(KELP_CAMERA.dip)};                                  // how far below its place it settles
const float KELP_RISE = ${glslFloat(KELP_CAMERA.rise)};                                // how far up it goes on leaving

// ---- the water and its light ----
const float KELP_PI = 3.14159265;
const vec3 KELP_ABSORB = vec3(1.05, 0.30, 0.22);       // light lost per world unit of depth: red first
const vec3 KELP_TINT_UP = vec3(0.11, 0.38, 0.37);      // the water's colour (times the light) looking up,
const vec3 KELP_TINT_LEVEL = vec3(0.02, 0.19, 0.165);  // level,
const vec3 KELP_TINT_DOWN = vec3(0.004, 0.06, 0.075);  // and down, by day: green over blue, so the
                                                       // dither keeps it teal rather than indigo
const vec3 KELP_NIGHT_UP = vec3(0.05, 0.17, 0.36);     // the same under the moon: bluer
const vec3 KELP_NIGHT_LEVEL = vec3(0.012, 0.06, 0.15);
const vec3 KELP_NIGHT_DOWN = vec3(0.003, 0.016, 0.05);
const vec3 KELP_SHAFT_TINT = vec3(0.55, 0.95, 0.85);   // light scattered out of the shafts
const float KELP_CAUSTIC_SCALE = 1.4;                  // caustic cells per world unit
const float KELP_CAUSTIC_RATE = 0.12;                  // how fast the net drifts (per second of t)

// ---- the kelp ----
const vec3 KELP_OLIVE = vec3(0.34, 0.26, 0.09);        // a blade in the water's light
const vec3 KELP_GOLD = vec3(0.95, 0.80, 0.30);         // sunlight shining through a blade: gold-green under water
const vec3 KELP_GLINT = vec3(1.0, 0.93, 0.72);         // a highlight on a gas bladder
const vec3 KELP_STIPE = vec3(0.24, 0.19, 0.08);
const vec3 KELP_HOLDFAST = vec3(0.30, 0.22, 0.10);
const vec3 KELP_ROCK = vec3(0.38, 0.33, 0.27);
const vec3 KELP_SAND = vec3(0.62, 0.56, 0.42);
const vec3 KELP_CANOPY = vec3(0.10, 0.08, 0.03);       // the canopy floating overhead, against the light
const float KELP_DIFFUSE = 0.32;                       // share of the water's light a blade sends back
const float KELP_TRANSLUCENT = 0.55;                   // share of the beam it lets through
const float KELP_BLADE_GAP = 0.07;                     // between blades on one side (they alternate sides)
const float KELP_BLADE_LEN = 0.2;
const float KELP_BLADE_HALF = 0.022;                   // a blade's half-width: a ribbon, not a leaflet
const float KELP_BLADE_REST = 0.32;                    // radians off the stipe in still water: floating up
const float KELP_BLADE_FOLD = 0.1;                     // pressed against the stipe, upstream
const float KELP_BLADE_OPEN = 1.3;                     // streaming out, downstream
const float KELP_BLADE_STREAM = 1.6;                   // how far the water past them swings them
const float KELP_BLADE_CURL = 0.22;                    // how far a blade curls up toward its tip
const float KELP_STIPE_HALF = 0.006;
const float KELP_BLADDER = 0.0075;
const float KELP_REACH = 0.3;                          // how far blades reach past the stipe's points
const float KELP_HANG = 0.17;                          // how deep the canopy's blades hang under the surface
const float KELP_BULB = 0.022;                         // bull kelp: its gas bulb's radius
const int KELP_STRAPS = 8;                             // the strap blades streaming from the bulb,
const float KELP_STRAP_LEN = 0.22;                     // their length (within KELP_REACH with the bulb),
const float KELP_STRAP_HALF = 0.011;                   // half-width: narrow straps,
const float KELP_STRAP_FAN = 0.7;                      // the angle the fan opens over (radians),
const float KELP_STRAP_STREAM = 2.6;                   // how far the water past the bulb swings it (per radian of lean)
const float KELP_STRAP_DROOP = 0.9;                    // and how far a strap leaning off upright bows over toward its tip
const float KELP_BULL_MATS = 0.12;                     // how much a bull kelp forest thins the canopy mats overhead

// ---- life ----
const vec3 KELP_SILVER = vec3(0.85, 0.92, 0.95);
const vec3 KELP_FISH_BACK = vec3(0.06, 0.13, 0.18);
const vec3 KELP_SEALION = vec3(0.17, 0.13, 0.10);
const vec3 KELP_JELLY_DAY = vec3(0.75, 0.80, 0.92);
const vec3 KELP_GLOW = vec3(0.30, 0.95, 1.0);          // bioluminescence: plankton, jellies, the stone's crust
const vec3 KELP_STONE = vec3(0.52, 0.50, 0.44);        // pale limestone
const vec3 KELP_CORALLINE = vec3(0.86, 0.45, 0.58);
const vec3 KELP_URCHIN = vec3(0.20, 0.06, 0.22);
const float KELP_THING_TALL = 0.16;                    // the tallest thing standing on the floor (world units)

// This cell's threshold for hard edges, apart from the colour dither's (cellTh): edgeThreshold keeps
// it off 0 and 1, so nothing shows where a cover is 0 and everything where it is 1. Set by sceneKelp.
float kelpTh = 0.5;

// How far the camera is above its resting place (world units; 0 at rest, set by sceneKelp): the
// entrance sinks it from just under the surface, the exit lifts it toward the light. Pure
// translation, so a layer at perspective scale s moves s times as far (parallax), the floor lies
// that much farther below the eye and the surface that much nearer overhead, and the light's
// vanishing point, at infinity, does not move.
float kelpDrop = 0.0;

vec2 kelpAt(vec2 P, float s) {
  return P + vec2(0.0, s * kelpDrop);
}

float kelpFloorDepth() {
  return KELP_FLOOR + kelpDrop;
}

float kelpSurfaceDepth() {
  return max(KELP_SURFACE - kelpDrop, 0.05);
}

// ---- the simulation's textures ----

vec4 kelpState(int col, int row) {
  return texelFetch(uSim1, ivec2(col, row), 0);
}

// Point i of the forest: position in xyz, blade lean (radians, toward screen +x) in w.
vec4 kelpNode(int i) {
  int k = 2 * i;
  return texelFetch(uSim0, ivec2(k % KELP_POINT_ROW, k / KELP_POINT_ROW), 0) + vec4(KELP_ORIGIN, 0.0);
}

// How fast point i moves (screen heights/s).
float kelpNodeSpeed(int i) {
  int k = 2 * i + 1;
  return texelFetch(uSim0, ivec2(k % KELP_POINT_ROW, k / KELP_POINT_ROW), 0).w;
}

// ---- light and water ----

struct KelpEnv {
  Sky sky;
  vec3 light;     // light arriving at the surface from the sun, moon and sky, before the water's share
  vec3 beam;      // the direct beam alone: the sun by day, the moon by night
  vec3 up;        // the water's colour looking up toward the surface, level, and down
  vec3 level;
  vec3 down;
  vec2 vanish;    // where the shafts converge (screen heights; above the frame but at dawn and dusk)
  float slant;    // how far the beam moves sideways per unit of depth
  float night;
  vec4 phases;    // the surge: cos φ1, sin φ1, cos φ2, sin φ2
  vec4 flow;      // surge speed, φ1's rate, current (world units/s), swell age (s, -1 idle)
  float swellDir;
};

KelpEnv kelpEnvironment(float tm) {
  KelpEnv e;
  e.sky = skyAt(timeOfDayM(K_time, skyDays()));
  float sunUp = smoothstep(-0.02, 0.5, e.sky.sun.y);
  float moonUp = smoothstep(0.0, 0.4, e.sky.moon.y);
  // A low sun glances off the surface but still sends long golden shafts down; the moon gives a
  // faint, cool beam.
  e.beam = e.sky.sunColor * (0.45 + 0.55 * sunUp) + e.sky.moonColor * 0.5 * moonUp;
  e.light = e.sky.ambient * 1.15 + e.sky.sunColor * (0.8 * sunUp + 0.3 * e.sky.twilight) + e.sky.moonColor * 0.3 * moonUp + vec3(0.03, 0.04, 0.07);
  e.night = e.sky.night;
  e.up = e.light * mix(KELP_TINT_UP, KELP_NIGHT_UP, e.night);
  e.level = e.light * mix(KELP_TINT_LEVEL, KELP_NIGHT_LEVEL, e.night);
  e.down = e.light * mix(KELP_TINT_DOWN, KELP_NIGHT_DOWN, e.night);
  // The key light refracted into the water (Snell: the zenith angle's sine over 1.333), and where
  // its parallel rays meet in the picture.
  vec3 key = e.sky.sun.y > -0.04 ? e.sky.sun : e.sky.moon;
  vec2 across = key.xz / 1.333;
  vec3 d = vec3(across.x, sqrt(max(1.0 - dot(across, across), 0.0)), max(across.y, 0.12));
  e.vanish = vec2(KELP_FOCAL * d.x / d.z, KELP_HORIZON + KELP_FOCAL * d.y / d.z);
  e.slant = d.x / max(d.y, 0.3);
  if (uSimOn.y > 0.5) {
    e.phases = kelpState(KELP_G_PHASES, KELP_ROW_GLOBALS);
    e.flow = kelpState(KELP_G_FLOW, KELP_ROW_GLOBALS);
    e.swellDir = kelpState(KELP_G_VISITOR_LOOK, KELP_ROW_GLOBALS).z;
  } else {
    e.phases = vec4(1.0, 0.0, 1.0, 0.0);
    e.flow = vec4(0.0, 1.0, 0.0, -1.0);
    e.swellDir = 1.0;
  }
  return e;
}

// How far the water at world x has been carried by the surge and the big swell (world units):
// the time integral of the flow the kelp is dragged by in sim.ts, so snow, plankton, jellyfish,
// the canopy overhead and the small kelp on the floor all sway with the forest.
float kelpShift(float x, KelpEnv e) {
  float a1 = KELP_SURGE_K1 * x;
  float a2 = KELP_SURGE_K2 * x - KELP_SURGE_PHASE2;
  float c1 = e.phases.x * cos(a1) + e.phases.y * sin(a1);
  float c2 = e.phases.z * cos(a2) + e.phases.w * sin(a2);
  float w1 = max(e.flow.y, 1e-3);
  float shift = -e.flow.x * (c1 + KELP_SURGE_SECOND * c2 / KELP_SURGE_RATIO) / w1;
  if (e.flow.w >= 0.0) {
    float tau = e.flow.w - (e.swellDir * x + KELP_SWELL_START) / KELP_SWELL_SPEED;
    if (tau > 0.0 && tau < KELP_SWELL_SPAN) {
      float rise = sin(KELP_PI * tau / KELP_SWELL_SPAN);
      shift += KELP_SWELL_AMPLITUDE * rise * rise * sin(TAU * tau / KELP_SWELL_PERIOD);
    }
  }
  return shift;
}

// Share of the water's colour in front of something at perspective scale s: depth haze.
float kelpFog(float s) {
  float haze = mix(0.15, 1.3, K_haze);
  return 1.0 - exp(-haze * max(1.0 / max(s, 1e-3) - 1.0, 0.0));
}

// How much of the shafts' scattered light lies between the eye and something at scale s.
float kelpRayWeight(float s) {
  return 1.0 - exp(-1.4 * max(1.0 / max(s, 1e-3) - 1.0, 0.0) - 0.15);
}

// The light left after dw world units of water.
vec3 kelpLightAt(float dw, KelpEnv e) {
  return e.light * exp(-dw * KELP_ABSORB);
}

vec3 kelpBeamAt(float dw, KelpEnv e) {
  return e.beam * exp(-dw * KELP_ABSORB * 1.15);
}

// Paint c at coverage a over acc (premultiplied colour, coverage).
vec4 kelpOver(vec4 acc, vec3 c, float a) {
  return vec4(c * a, a) + acc * (1.0 - a);
}

// The water seen along the view at P: brighter toward the surface, glowing toward the light.
vec3 kelpWater(vec2 P, KelpEnv e) {
  float el = (P.y - KELP_HORIZON) / KELP_FOCAL;
  vec3 c = mix(e.level, e.up, smoothstep(0.0, 1.1, el));
  c = mix(c, e.down, 1.0 - smoothstep(-0.75, 0.0, el));
  c += e.beam * mix(vec3(0.10, 0.22, 0.20), vec3(0.04, 0.08, 0.14), e.night) * exp(-1.8 * length(P - e.vanish));
  return c;
}

// The net of light the surface's waves focus onto whatever lies below: the soft edges of slowly
// wandering, warped cells, brightest where they meet. p is a point on a horizontal plane in world
// units; t the caustic clock; blur a cell's footprint in caustic units, which widens and dims the
// lines where they would otherwise alias. The cells drift and change shape over tens of seconds:
// the net brightens and dims in place far more than it travels.
float kelpCaustic(vec2 p, float t, float blur) {
  vec2 q = p * KELP_CAUSTIC_SCALE;
  q += 0.7 * vec2(vnoise(q * 0.9 + vec2(t * 0.05, 0.0)), vnoise(q * 0.9 + vec2(5.2, -t * 0.04))) - 0.35;
  vec2 i = floor(q);
  vec2 f = fract(q);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float hx = hash12(i + g);
      float hy = hash12(i + g + vec2(19.1, 7.7));
      vec2 o = 0.5 + 0.42 * vec2(sin(t * (0.6 + 0.4 * hy) + TAU * hx), cos(t * (0.6 + 0.4 * hx) + TAU * hy));
      float d = length(g + o - f);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  float w = 0.1 + blur;
  return exp(-(f2 - f1) / w) * (0.6 + 0.8 * smoothstep(0.3, 0.6, f1)) * (0.1 / w);
}

// The canopy floating on the surface at world point w (across, distance): mats of fronds with open
// water between them, drifting a little with the surge; denser forests close the gaps. Returns how
// far inside a mat the point lies (positive) or out in a gap (negative), in noise units.
float kelpCanopy(vec2 w, KelpEnv e) {
  vec2 p = vec2(w.x * 2.2 - 0.3 * kelpShift(w.x, e), w.y * 1.6) + 9.1;
  float n = 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.1 + 5.3) + 0.15 * vnoise(p * 4.3 + 1.7);
  float cut = mix(0.6, 0.42, K_density);
  // Bull kelp leaves the surface open but for its bulbs and straps: few mats (fewer in a mixed forest).
  if (K_species > 0.5) cut += KELP_BULL_MATS * (K_species > 1.5 ? 0.5 : 1.0);
  return n - cut;
}

// The shafts: beams fanning from the vanishing point, falling through the canopy's gaps (looked up
// where the beam's line meets the surface at the top of the frame), so they lean as the canopy
// drifts with the surge and change slowly. 0..1, strongest toward the surface.
float kelpShafts(vec2 P, KelpEnv e, float tc) {
  float fan = (P.x - e.vanish.x) / max(e.vanish.y - P.y, 0.08);
  float sTop = (1.0 - KELP_HORIZON) / kelpSurfaceDepth();
  float xTop = e.vanish.x + fan * (e.vanish.y - 1.0);
  float gap = 1.0 - smoothstep(-0.06, 0.06, kelpCanopy(vec2(xTop / sTop, 1.0 / sTop), e));
  float beams = smoothstep(0.35, 0.8, vnoise(vec2(fan * 6.0, tc * 0.012)));
  // Faint far down too, where the far water and the distant kelp give them depth.
  return beams * (0.2 + 0.8 * gap) * mix(0.45, 1.0, smoothstep(0.1, 0.9, P.y));
}

// Slopes of the surface's small waves (long and slow), plus the swell's long slope swaying with
// the surge.
vec2 kelpWaves(vec2 w, float tc, KelpEnv e) {
  vec2 g = vec2(0.8, 0.6) * 0.016 * cos(dot(w, vec2(0.8, 0.6)) * 11.0 - tc * 0.5);
  g += vec2(-0.5, 0.866) * 0.012 * cos(dot(w, vec2(-0.5, 0.866)) * 15.0 - tc * 0.6 + 1.7);
  g += vec2(0.96, -0.28) * 0.009 * cos(dot(w, vec2(0.96, -0.28)) * 19.0 - tc * 0.7 + 4.1);
  float a1 = KELP_SURGE_K1 * w.x;
  g.x += 0.05 * e.flow.x / KELP_SURGE_SPEED * (e.phases.y * cos(a1) - e.phases.x * sin(a1));
  return g;
}

// ---- the floor and the surface ----

// Whichever the view ray meets, hazed by distance. rays: the shafts' weight in front of it.
vec3 kelpBackground(vec2 P, vec3 water, float aa, float tc, KelpEnv e, out float rays) {
  float fl = kelpFloorDepth();
  float sf = kelpSurfaceDepth();
  if (P.y < KELP_HORIZON) {
    // The sea floor: sand rippled across the surge, patches of rock and turf, the canopy's shade
    // lying over it and the caustic net.
    float s = max((KELP_HORIZON - P.y) / fl, 1e-3);
    vec2 w = vec2(P.x / s, 1.0 / s);
    float foot = aa / (s * s * fl);
    float detail = 1.0 - smoothstep(0.02, 0.08, foot);
    float patches = fbm(w * vec2(1.1, 0.9) + 3.7);
    float ripple = sin(w.x * 24.0 + 3.0 * vnoise(w * 1.7)) * detail;
    float grit = (vnoise(w * vec2(40.0, 20.0)) - 0.5) * detail;
    vec3 ground = mix(KELP_SAND * (0.9 + 0.07 * ripple + 0.12 * grit), KELP_ROCK * (0.7 + 0.4 * vnoise(w * 7.0)), smoothstep(0.52, 0.62, patches));
    float depth = KELP_FLOOR + KELP_SURFACE;
    float shade = 0.55 + 0.45 * smoothstep(0.3, 0.7, vnoise(vec2(w.x * 0.7 - 0.25 * kelpShift(w.x, e), w.y * 0.55)));
    float caustic = kelpCaustic(vec2(w.x - depth * e.slant, w.y + 0.35 * depth), tc * KELP_CAUSTIC_RATE, foot * KELP_CAUSTIC_SCALE * 3.0) * K_caustics;
    vec3 c = ground * shade * (kelpLightAt(depth, e) * 0.55 + kelpBeamAt(depth, e) * (0.3 + 0.9 * caustic));
    rays = kelpRayWeight(s);
    return mix(c, water, kelpFog(s));
  }

  // The surface from below: a silvery, rippled mirror of the bright water beneath it, except
  // overhead, where Snell's window opens onto the sky, its edge wavering with the ripples. The
  // canopy floats on it, dark against the light, its fronds lit gold-green at the gaps' edges.
  float s = max((P.y - KELP_HORIZON) / sf, 1e-3);
  vec2 w = vec2(P.x / s, 1.0 / s);
  float foot = aa / (s * s * sf);
  float detail = 1.0 - smoothstep(0.015, 0.06, foot);
  vec2 g = kelpWaves(w, tc, e) * detail * (0.4 + 0.6 * K_surface);
  vec3 rd = normalize(vec3(P.x, P.y - KELP_HORIZON, KELP_FOCAL));
  vec3 nrm = normalize(vec3(-g.x, 1.0, -g.y));
  float cosI = dot(rd, nrm);
  vec3 c = e.up * (1.1 + 3.0 * K_surface * dot(g, vec2(0.45, 0.9)));
  float window = smoothstep(0.64, 0.70, cosI) * K_surface;
  if (window > 0.0) {
    // Little gets through near the critical angle (Fresnel), all of it overhead.
    vec3 skyDir = refract(rd, -nrm, 1.333);
    vec3 skyC = skyColor(e.sky, normalize(skyDir + vec3(0.0, 1e-4, 0.0)));
    c = mix(c, (skyC * 1.8 + e.beam * 0.4) * (0.55 + 0.45 * smoothstep(0.661, 0.8, cosI)), window);
  }
  // (Beyond s = 0.2 the haze has it all; cutting it there keeps a dissolve out of the picture.)
  float margin = kelpCanopy(w, e);
  float mat = hardEdge(smoothstep(-0.012, 0.012, margin), kelpTh) * step(0.2, s);
  vec3 frond = KELP_CANOPY * e.light + KELP_GOLD * e.beam * 0.35 * (1.0 - smoothstep(0.0, 0.05, margin));
  c = mix(c, frond, mat);
  rays = kelpRayWeight(s);
  return mix(c, water, kelpFog(s));
}

// What stands on the floor in front of the floor point under P: boulders (some crusted pink),
// purple urchins, anemones and small understory kelp, scattered over a grid on the floor. The
// nearest one covering P, its colour (unhazed), cover (cut against the cell's threshold) and scale.
struct KelpThing {
  vec3 col;
  float cover;
  float s;
};

KelpThing kelpThings(vec2 P, float aa, float tc, KelpEnv e) {
  KelpThing best = KelpThing(vec3(0.0), 0.0, 0.0);
  if (K_understory <= 0.0 || P.y > KELP_HORIZON - 0.05) return best;
  const float CX = 0.5;
  const float CZ = 0.45;
  float fl = kelpFloorDepth();
  float zFloor = fl / (KELP_HORIZON - P.y);
  // Only things standing between the eye and the floor point, and tall enough, can reach P.
  int rowFar = int(floor(zFloor / CZ));
  int rowNear = int(floor(zFloor * (1.0 - KELP_THING_TALL / fl) / CZ));
  float depth = KELP_FLOOR + KELP_SURFACE;
  for (int r = 0; r < 3; r++) {
    int row = rowNear + r;
    if (row > rowFar) break;
    float zMid = (float(row) + 0.5) * CZ;
    float cx0 = floor(P.x * zMid / CX) - 1.0;
    for (int c = 0; c < 3; c++) {
      vec2 cell = vec2(cx0 + float(c), float(row));
      float h = hash12(cell + vec2(K_kelpSeed * 3.7, 17.0));
      if (hash12(cell + vec2(5.1, K_kelpSeed)) > 0.75 * K_understory) continue;
      float z = (cell.y + 0.2 + 0.6 * hash12(cell + 2.9)) * CZ;
      if (z < 1.05 || z > 3.4) continue;
      float s = 1.0 / z;
      if (s <= best.s) continue;
      float x = (cell.x + 0.2 + 0.6 * hash12(cell + 7.7)) * CX;
      // Nothing stands between the eye and the Manifold M: it has its clearing.
      if (K_mark > 0.0 && s > KELP_MARK_SCALE && abs(x * s - KELP_MARK_X * KELP_MARK_SCALE) < (KELP_MARK_HALF * mix(KELP_MARK_LOW, KELP_MARK_HIGH, K_mark) + 0.12) * KELP_MARK_SCALE) continue;
      vec2 q = (P - vec2(x * s, KELP_HORIZON - fl * s)) / s;
      if (q.y < 0.0 || q.y > KELP_THING_TALL || abs(q.x) > 0.16) continue;
      float px = aa / s;
      // Lit by the water at its depth, though its colours are not quite all taken.
      vec3 lit = kelpLightAt(0.7 * (depth - q.y), e);
      vec3 col = vec3(0.0);
      float cover = 0.0;
      if (h < 0.34) {
        // A boulder, half sunk, lit from above; some wear a crust of pink coralline algae.
        float R = 0.045 + 0.075 * hash12(cell + 4.4);
        vec2 bq = (q - vec2(0.0, -0.15 * R)) / vec2(R, 0.72 * R);
        float d = length(bq) - 1.0 + 0.12 * (vnoise(q / R * 2.5 + h * 30.0) - 0.5);
        cover = 1.0 - smoothstep(-px / R, px / R, d);
        float crust = smoothstep(0.62, 0.7, vnoise(q / R * 3.0 + 11.0)) * smoothstep(0.0, 0.5, bq.y) * step(0.6, hash12(cell + 9.3));
        col = mix(KELP_ROCK, KELP_CORALLINE * 0.7, crust) * (0.45 + 0.75 * smoothstep(-0.6, 0.9, bq.y)) * lit;
      } else if (h < 0.52) {
        // A pair of purple urchins, spines out.
        for (int j = 0; j < 2; j++) {
          float fj = float(j);
          float ur = 0.014 + 0.008 * hash12(cell + fj * 3.3);
          vec2 uq = q - vec2((fj - 0.5) * 0.05 * hash12(cell + 6.1), 0.8 * ur);
          float spikes = ur * (0.72 + 0.5 * pow(abs(cos(atan(uq.y, uq.x) * 6.5 + fj * 2.0)), 5.0));
          float u = 1.0 - smoothstep(spikes - px, spikes + px, length(uq));
          if (u > cover) {
            cover = u;
            col = mix(KELP_URCHIN, KELP_URCHIN * 2.2, smoothstep(0.0, 1.0, uq.y / ur)) * lit * 1.6;
          }
        }
      } else if (h < 0.68) {
        // An anemone: a short column under a crown of tentacles, waving slowly; strawberry pink,
        // orange or cream, the colour the water has not quite taken.
        vec3 tint = h < 0.57 ? vec3(0.95, 0.42, 0.55) : h < 0.63 ? vec3(1.0, 0.58, 0.25) : vec3(0.92, 0.9, 0.82);
        float column = (1.0 - smoothstep(0.011 - px, 0.011 + px, abs(q.x))) * step(q.y, 0.032);
        vec2 cq = (q - vec2(0.0, 0.036)) / vec2(0.03, 0.014);
        float wave = 0.2 * sin(atan(cq.y, cq.x) * 11.0 + tc * 0.4 + h * 40.0) * step(0.0, cq.y);
        float crown = 1.0 - smoothstep(-px / 0.014, px / 0.014, length(cq) - 1.0 - wave);
        cover = max(column, crown);
        col = tint * mix(0.55, 1.0, crown) * kelpLightAt(0.5 * (depth - q.y), e) * 0.8;
      } else if (h < 0.9) {
        // Small kelp of the understory: a stiff stalk and a tuft of blades nodding with the surge.
        float tall = 0.055 + 0.035 * hash12(cell + 8.8);
        float nod = 0.35 * kelpShift(x, e);
        float bend = nod * (q.y / tall) * (q.y / tall);
        float stalk = (1.0 - smoothstep(0.0035 - px, 0.0035 + px, abs(q.x - bend * tall))) * step(q.y, tall);
        vec2 tip = vec2(nod * tall, tall);
        float blades = 0.0;
        for (int j = 0; j < 4; j++) {
          float a = KELP_PI * 0.5 + (float(j) - 1.5) * 0.55 - nod * 1.5;
          vec2 dir = vec2(cos(a), sin(a));
          vec2 bq = q - tip - dir * 0.032;
          vec2 local = vec2(dot(bq, dir), dot(bq, vec2(-dir.y, dir.x))) / vec2(0.034, 0.009);
          blades = max(blades, 1.0 - smoothstep(1.0 - px / 0.009, 1.0 + px / 0.009, length(local)));
        }
        cover = max(stalk, blades);
        col = (KELP_OLIVE * lit * KELP_DIFFUSE + KELP_GOLD * kelpBeamAt(depth - q.y, e) * 0.3 * blades);
      }
      if (hardEdge(cover, kelpTh) > 0.5) {
        best.col = col;
        best.cover = 1.0;
        best.s = s;
      }
    }
  }
  return best;
}

// Lay what stands on the floor over col once the painter reaches its depth: just before the first
// layer nearer than it (placed says it is down).
void kelpPlace(KelpThing thing, float s, vec3 water, inout bool placed, inout vec3 col, inout float rays) {
  if (placed || s <= thing.s) return;
  col = mix(col, mix(thing.col, water, kelpFog(thing.s)), thing.cover);
  rays = mix(rays, kelpRayWeight(thing.s), thing.cover);
  placed = true;
}

// A wall of distant kelp at scale s: columns that sway with the surge, ragged with blades, rising
// into the ragged band of their canopy along the surface; faint silhouettes in the haze, a little
// darker than it.
void kelpBackdrop(float s, float salt, vec2 P, vec3 water, float aa, KelpEnv e, inout vec3 col, inout float rays) {
  float floorY = KELP_HORIZON - KELP_FLOOR * s;
  float surfaceY = KELP_HORIZON + KELP_SURFACE * s;
  if (P.y < floorY || P.y > surfaceY) return;
  float spacing = 0.36 * s;
  float frac = (P.y - floorY) / (surfaceY - floorY);
  float cell = floor(P.x / spacing);
  // The canopy: a band under the surface, thicker and thinner, with gaps, drifting with the surge.
  float mat = vnoise(vec2((P.x / s - 0.5 * kelpShift(P.x / s, e)) * 5.0 + salt, salt));
  float band = s * (0.015 + 0.05 * mat) * smoothstep(0.3, 0.45, mat + 0.25 * K_density);
  if (K_species > 0.5) band *= K_species > 1.5 ? 0.6 : 0.25;
  float cover = 1.0 - smoothstep(band - aa, band + aa, surfaceY - P.y);
  for (int d = -1; d <= 1; d++) {
    float c = cell + float(d);
    float h = hash12(vec2(c, K_kelpSeed + salt));
    if (h > 0.25 + 0.75 * K_density) continue;
    float h2 = hash12(vec2(c + 0.5, K_kelpSeed + salt + 12.0));
    float x = (c + 0.5 + 0.9 * (h2 - 0.5)) * spacing;
    x += kelpShift(x / s, e) * s * pow(frac, 1.3) * 0.8;
    float fuzz = smoothstep(0.35, 0.85, vnoise(vec2(frac * 30.0, c * 3.1 + salt))) * smoothstep(0.05, 0.2, frac);
    float halfWidth = max(s * (0.008 + 0.03 * fuzz), 1.2 * aa);
    cover = max(cover, 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(P.x - x)));
  }
  if (hardEdge(cover, kelpTh) < 0.5) return;
  vec3 kelp = KELP_OLIVE * kelpLightAt((surfaceY - P.y) / s, e) * KELP_DIFFUSE;
  col = mix(kelp, water, 0.82 * kelpFog(s));
  rays = kelpRayWeight(s);
}

// ---- the kelp ----

struct KelpHit {
  float cover;   // 0..1, soft
  vec3 albedo;   // what the water's light shows of it
  float glow;    // light shining through the blades
  float shine;   // glints on the gas bladders
  float stir;    // how fast it moves here (world units/s), for the plankton
};

// One ribbon blade, its foot at tf along the stem (on a gas bladder), leaving it at angle th toward
// the pixel's side: long, wavy-edged, slender at its foot and rounding off at its tip, curling up
// as it goes and rippling as the water runs along it. an, t: the pixel off the stem and along it.
// hb: the blade's own seed; grow: longer at the crown. Returns (cover, place along it 0..1, bladder).
vec3 kelpBlade(float an, float t, float tf, float th, float hb, float s, float aa, float tc, float grow) {
  float len = KELP_BLADE_LEN * s * (0.7 + 0.6 * hb) * grow;
  float halfW = KELP_BLADE_HALF * s * (0.8 + 0.4 * fract(hb * 7.31));
  float sn = sin(th);
  float cs = cos(th);
  float dt = t - tf;
  float l = an * sn + dt * cs;
  float v = an * cs - dt * sn;
  float q = l / len;
  float qc = clamp(q, 0.0, 1.0);
  float centre = -KELP_BLADE_CURL * len * qc * qc + 0.4 * halfW * qc * sin(qc * 6.5 - tc * 0.7 + hb * 40.0);
  float tip = max(qc - 0.55, 0.0) / 0.45;
  float w = halfW * (0.16 + 0.84 * smoothstep(0.02, 0.24, qc)) * sqrt(max(1.0 - tip * tip, 0.0));
  w *= 1.0 + 0.16 * sin(qc * 26.0 + hb * 17.0);
  float cover = (1.0 - smoothstep(w - aa, w + aa, abs(v - centre))) * step(0.0, q) * step(q, 1.0);
  float rb = KELP_BLADDER * s;
  float bladder = 1.0 - smoothstep(rb - aa, rb + aa, length(vec2(l - 1.2 * rb, v)));
  return vec3(cover, qc, bladder);
}

// The two blades of one side nearest the pixel (an off the stem, t along it): their feet every
// KELP_BLADE_GAP from 'phase', between 'from' and 'to' along the stem, leaving it at angle th.
// Adds them to paint (premultiplied albedo, cover) and lit (premultiplied glow, shine).
void kelpBladePair(float an, float t, float th, float phase, float from, float to, float salt, float s, float aa, float tc, float crownAt, float growBase, inout vec4 paint, inout vec2 lit) {
  float gap = KELP_BLADE_GAP * s;
  float outward = an / sin(th);
  float t0 = t - an * cos(th) / sin(th) - KELP_BLADE_CURL * outward * outward * sin(th) / (KELP_BLADE_LEN * s);
  float first = floor(t0 / gap - phase);
  for (int c = 0; c < 2; c++) {
    float index = first + float(c);
    float tf = (index + phase) * gap;
    if (tf < from || tf > to) continue;
    float hb = hash12(vec2(index + 0.5, salt));
    float grow = growBase + 0.35 * clamp((tf - crownAt) / max(to - crownAt, 1e-4), 0.0, 1.0);
    vec3 b = kelpBlade(an, t, tf, clamp(th + 0.3 * (hb - 0.5), KELP_BLADE_FOLD, KELP_BLADE_OPEN), hb, s, aa, tc, grow);
    // Blades differ only a little in tone and brighten only a little toward the tip: as they sway,
    // what the dither sees change is their edges, not their insides.
    float glow = (0.6 + 0.4 * b.y) * (1.0 + 0.2 * (hb - 0.5));
    paint = kelpOver(paint, KELP_OLIVE * (1.0 + 0.2 * (hb - 0.5)) * (0.95 + 0.1 * b.y), b.x);
    lit = vec2(glow, 0.0) * b.x + lit * (1.0 - b.x);
    paint = kelpOver(paint, KELP_OLIVE * 1.15, b.z);
    lit = vec2(0.5, 0.35) * b.z + lit * (1.0 - b.z);
  }
}

// The holdfast at hr (world units from the stipe's foot): a small lumpy rock and, gripping it, a
// tangle of haptera: thin, branching root-strands that leave the stipe's swollen base, arch out over
// the stone and down to the floor, a little wider than the stipe. px: one cell in world units.
void kelpHoldfast(vec2 hr, float px, float plant, float salt, inout vec4 paint) {
  float ground = step(0.0, hr.y);
  vec2 rc = vec2((plant - 0.5) * 0.02, 0.0);
  vec2 rq = (hr - rc) / vec2(0.062, 0.034);
  float lump = 0.1 * (vnoise(hr * 40.0 + plant * 7.0) - 0.5) + 0.05 * sin(rq.x * 5.0 + plant * 20.0);
  float rock = (1.0 - smoothstep(-px, px, (length(rq) - 1.0 + lump) * 0.034)) * ground;
  paint = kelpOver(paint, KELP_ROCK * (0.4 + 0.7 * smoothstep(-0.6, 0.9, rq.y)), rock);
  // The stipe's base, swollen where the haptera spring from it.
  float roots = sdTaperCapsule(hr, vec2(0.0, 0.026), vec2(0.0, 0.06), max(0.0085, 0.8 * px), max(0.0055, 0.8 * px));
  for (int j = 0; j < 9; j++) {
    float fj = float(j);
    float hj = hash12(vec2(fj, salt) + 3.1);
    float hk = fract(hj * 7.13);
    float side = (fj + 0.5) / 4.5 - 1.0;
    float away = hj < 0.5 ? -1.0 : 1.0;
    float mx = rc.x + side * 0.036 + (hj - 0.5) * 0.006;
    float over = (mx - rc.x) / 0.062;
    // From the base, over the stone's shoulder, down to where the strand grips the floor.
    vec2 base = vec2((hk - 0.5) * 0.008, 0.038 + 0.01 * hj);
    vec2 mid = vec2(mx, 0.034 * sqrt(max(1.0 - over * over, 0.04)) + 0.003 + 0.004 * hk);
    vec2 foot = vec2(rc.x + side * (0.062 + 0.012 * hk) + (hk - 0.5) * 0.008, 0.001 + 0.005 * hj);
    vec2 twig = mid + vec2(away * (0.009 + 0.006 * hk), -0.009 - 0.004 * hj);
    twig.y = max(twig.y, 0.002);
    float r0 = max(0.0042 - 0.0007 * abs(side), 0.7 * px);
    roots = min(roots, sdTaperCapsule(hr, base, mid, r0, 0.8 * r0));
    roots = min(roots, sdTaperCapsule(hr, mid, foot, 0.8 * r0, max(0.4 * r0, 0.5 * px)));
    roots = min(roots, sdTaperCapsule(hr, mid, twig, 0.55 * r0, max(0.3 * r0, 0.5 * px)));
  }
  float hold = (1.0 - smoothstep(-px, px, roots)) * ground;
  paint = kelpOver(paint, KELP_HOLDFAST * (0.55 + 0.5 * smoothstep(0.004, 0.045, hr.y)), hold);
}

// Bull kelp's crown at the top of its stipe (top: the top point, its w the lean sim.ts gives the
// water past it; below: the point under it): a gas bulb, a little long along the stipe, and a fan of
// narrow strap blades leaving it around the stipe's direction, swung round with the water past the
// bulb, each bowing over toward its tip the farther it leans off upright (a willow, not a palm), and
// rippling. Adds to paint (premultiplied albedo, cover) and lit (premultiplied glow, shine) as
// kelpBladePair does.
void kelpBullCrown(vec2 P, vec4 top, vec2 below, float s, float aa, float tc, float salt, inout vec4 paint, inout vec2 lit) {
  vec2 T = normalize(top.xy - below + vec2(0.0, 1e-6));
  float rb = KELP_BULB * s;
  vec2 r = P - (top.xy + T * 0.6 * rb);
  float reach = KELP_STRAP_LEN * s * 1.25 + 2.0 * rb;
  if (dot(r, r) > reach * reach) return;
  float axis = atan(T.x, T.y) + clamp(top.w * KELP_STRAP_STREAM, -1.4, 1.4);
  for (int j = 0; j < KELP_STRAPS; j++) {
    float fj = float(j);
    float hb = hash12(vec2(fj + 0.5, salt + 5.0));
    float spread = (fj / float(KELP_STRAPS - 1) - 0.5) * KELP_STRAP_FAN + 0.15 * (hb - 0.5);
    float a = axis + spread + 0.08 * sin(tc * 0.5 + fj * 1.7 + salt);
    vec2 d = vec2(sin(a), cos(a));
    float len = KELP_STRAP_LEN * s * (0.75 + 0.5 * hb);
    float q = (dot(r, d) - 0.5 * rb) / len;
    if (q < 0.0 || q > 1.0) continue;
    float halfW = KELP_STRAP_HALF * s * (0.8 + 0.4 * fract(hb * 7.31));
    // Bowing over (clockwise for a strap leaning right, d's right-hand side), rippling as the water
    // runs along it.
    float centre = KELP_STRAP_DROOP * clamp(a, -1.5, 1.5) * len * q * q + 0.4 * halfW * q * sin(q * 6.5 - tc * 0.7 + hb * 40.0);
    float tip = max(q - 0.7, 0.0) / 0.3;
    float w = halfW * (0.3 + 0.7 * smoothstep(0.0, 0.12, q)) * sqrt(max(1.0 - tip * tip, 0.0));
    w *= 1.0 + 0.16 * sin(q * 26.0 + hb * 17.0);
    float cover = 1.0 - smoothstep(w - aa, w + aa, abs(dot(r, vec2(d.y, -d.x)) - centre));
    paint = kelpOver(paint, KELP_OLIVE * (1.0 + 0.2 * (hb - 0.5)) * (0.95 + 0.1 * q), cover);
    lit = vec2((0.6 + 0.4 * q) * (1.0 + 0.2 * (hb - 0.5)), 0.0) * cover + lit * (1.0 - cover);
  }
  // The bulb over the straps' feet, glinting like a giant's bladders but brighter: a big float.
  vec2 b = vec2(dot(r, T) / 1.25, dot(r, vec2(-T.y, T.x)));
  float bulb = 1.0 - smoothstep(rb - aa, rb + aa, length(b));
  paint = kelpOver(paint, KELP_OLIVE * 1.3, bulb);
  lit = vec2(0.55, 0.6) * bulb + lit * (1.0 - bulb);
}

// Stipe i (in a layer at scale s, its surface at surfaceY) at P. The rising part: a Hermite spine
// through its points from the holdfast to where it reaches the surface, blades on alternate sides
// (the downstream ones streaming out, the upstream ones pressed to the stipe, as sim.ts leans
// them), a knobby holdfast gripping a boulder. The floating part (grown plants): the top lying
// along the surface, its blades hanging and trailing downstream, the canopy. Bull kelp (bull): a
// bare stipe thickening toward its crown (kelpBullCrown) instead of blades all the way up.
KelpHit kelpStipe(int i, float s, float surfaceY, vec2 P, float aa, float tc, bool wantStir, bool rising, bool floating, bool bull) {
  KelpHit h = KelpHit(0.0, vec3(0.0), 0.0, 0.0, 0.0);
  int first = i * KELP_POINTS;
  vec4 canopy = kelpState(i, KELP_ROW_CANOPY);
  int m = clamp(int(canopy.x + 0.5), 1, KELP_SEGMENTS);
  float link = max(canopy.w, 1e-4);
  float len = float(m) * link;
  float plant = hash12(vec2(float(i) * 1.37, K_kelpSeed + 0.5));
  float salt = float(i) + 31.0 * K_kelpSeed;
  vec4 paint = vec4(0.0);
  vec2 lit = vec2(0.0);
  float hwS = max(KELP_STIPE_HALF * s, 1.0 * aa);

  if (rising) {
    vec4 root = kelpNode(first);
    vec4 top = kelpNode(first + m);
    // The link at the pixel's height, from how high the rising part reaches (it rises nearly
    // evenly), moved by one where it bends.
    float rise = max(top.y - root.y, 1e-3);
    int k = clamp(int(floor((P.y - root.y) / rise * float(m))), 0, m - 1);
    vec4 a = kelpNode(first + k);
    vec4 b = kelpNode(first + k + 1);
    if (P.y < a.y && k > 0) {
      k -= 1;
      b = a;
      a = kelpNode(first + k);
    } else if (P.y > b.y && k < m - 1) {
      k += 1;
      a = b;
      b = kelpNode(first + k + 1);
    }
    vec2 a0 = kelpNode(first + max(k - 1, 0)).xy;
    vec2 b1 = kelpNode(first + min(k + 2, KELP_SEGMENTS)).xy;
    vec2 ta = k > 0 ? 0.5 * (b.xy - a0) : b.xy - a.xy;
    vec2 tb = 0.5 * (b1 - a.xy);

    // The spine near the pixel's height (Catmull-Rom tangents), its direction, and the pixel in its
    // frame: t along the stipe from the holdfast, n across it (positive to the left).
    float u = clamp((P.y - a.y) / max(b.y - a.y, 1e-4), 0.0, 1.0);
    float u2 = u * u;
    float u3 = u2 * u;
    vec2 S = (2.0 * u3 - 3.0 * u2 + 1.0) * a.xy + (u3 - 2.0 * u2 + u) * ta + (3.0 * u2 - 2.0 * u3) * b.xy + (u3 - u2) * tb;
    vec2 T = normalize((6.0 * u2 - 6.0 * u) * (a.xy - b.xy) + (3.0 * u2 - 4.0 * u + 1.0) * ta + (3.0 * u2 - 2.0 * u) * tb + vec2(0.0, 1e-6));
    vec2 N = vec2(-T.y, T.x);
    vec2 r = P - S;
    float t = (float(k) + u) * link + dot(r, T);
    float n = dot(r, N);
    float an = abs(n);
    float side = n >= 0.0 ? 1.0 : -1.0;

    // The holdfast: a tangle of haptera on a small rock.
    vec2 hr = (P - root.xy) / s;
    if (hr.y < 0.075 && abs(hr.x) < 0.1) kelpHoldfast(hr, aa / s, plant, salt, paint);

    // Blades, leaning with the water as sim.ts says and wavering slowly up the stipe. Each side's
    // blades leave at an angle toward their own side; once the water past them swings that angle
    // below zero they are swept over the stipe and stream on the other side with the rest, so in a
    // current every blade trails downstream like a flag.
    float lean = mix(a.w, b.w, u);
    float wobble = 0.12 * sin(t / s * 9.0 - tc * 0.6 + plant * TAU);
    float thMine = KELP_BLADE_REST - side * lean * KELP_BLADE_STREAM + wobble;
    float thOther = KELP_BLADE_REST + side * lean * KELP_BLADE_STREAM + wobble;
    vec4 blades = vec4(0.0);
    vec2 bladeLit = vec2(0.0);
    if (!bull && thMine > 0.0) {
      kelpBladePair(an, t, clamp(thMine, KELP_BLADE_FOLD, KELP_BLADE_OPEN), side > 0.0 ? 0.0 : 0.5, 0.12 * len, len, salt + side * 0.37, s, aa, tc, 0.7 * len, 1.0, blades, bladeLit);
    }
    if (!bull && thOther < 0.0) {
      kelpBladePair(an, t, clamp(-thOther, KELP_BLADE_FOLD, KELP_BLADE_OPEN), side > 0.0 ? 0.5 : 0.0, 0.12 * len, len, salt - side * 0.37, s, aa, tc, 0.7 * len, 1.0, blades, bladeLit);
    }
    // Nothing of the rising part shows above its surface.
    float under = step(P.y, surfaceY);
    paint = kelpOver(paint, blades.rgb / max(blades.a, 1e-4), blades.a * under);
    lit = bladeLit * under + lit * (1.0 - blades.a * under);

    // The stipe itself, from inside the holdfast up to the surface: thin, olive, a little light
    // coming through it too. Bull kelp's is a whip, thickening toward its bulb.
    float hw = hwS;
    vec3 stipe = KELP_STIPE;
    float stipeGlow = 0.3;
    if (bull) {
      hw = max(hwS * (0.5 + 1.1 * clamp(t / len, 0.0, 1.0)), aa);
      stipe = KELP_OLIVE * 0.8;
      stipeGlow = 0.45;
    }
    float body = (1.0 - smoothstep(hw - aa, hw + aa, an)) * smoothstep(0.02 * s, 0.03 * s, t) * (1.0 - smoothstep(len - aa, len + aa, t)) * under;
    paint = kelpOver(paint, stipe, body);
    lit = vec2(stipeGlow, 0.0) * body + lit * (1.0 - body);
    if (bull) kelpBullCrown(P, top, kelpNode(first + m - 1).xy, s, aa, tc, salt, paint, lit);

    if (wantStir) {
      float speed = mix(kelpNodeSpeed(first + k), kelpNodeSpeed(first + k + 1), u) / s;
      h.stir = speed * (1.0 - smoothstep(0.0, KELP_BLADE_LEN * s * 1.3, an));
    }
  }

  if (floating && m < KELP_SEGMENTS) {
    // The canopy: the top lies along the surface from where it reached it, a dark mass of floating
    // fronds with a ragged underside; more blades hang from it, trailing downstream.
    float span = abs(canopy.z - canopy.y);
    float dir = canopy.z >= canopy.y ? 1.0 : -1.0;
    float tf = (P.x - canopy.y) * dir;
    float nf = surfaceY - 0.006 * s - P.y;
    if (P.y < surfaceY) {
      float along = smoothstep(-0.5 * link, 0.0, tf) * (1.0 - smoothstep(span, span + 0.6 * link, tf));
      float ragged = s * (0.012 + 0.012 * vnoise(vec2(tf / s * 26.0, plant * 9.0)));
      float mass = (1.0 - smoothstep(ragged - aa, ragged + aa, nf)) * along;
      vec4 hang = vec4(0.0);
      vec2 hangLit = vec2(0.0);
      if (nf > 0.0) {
        float th = 0.7 + 0.15 * sin(tf / s * 7.0 - tc * 0.5 + plant * 9.0);
        kelpBladePair(nf, tf, th, 0.0, 0.0, span + 0.5 * link, salt + 7.0, s, aa, tc, span + 0.5 * link, 1.1, hang, hangLit);
        kelpBladePair(nf, tf, th + 0.25, 0.5, 0.0, span + 0.5 * link, salt + 9.0, s, aa, tc, span + 0.5 * link, 0.9, hang, hangLit);
      }
      paint = kelpOver(paint, hang.rgb / max(hang.a, 1e-4), hang.a);
      lit = hangLit + lit * (1.0 - hang.a);
      paint = kelpOver(paint, KELP_OLIVE * 0.7, mass);
      lit = vec2(0.25, 0.0) * mass + lit * (1.0 - mass);
    }
  }

  float inv = 1.0 / max(paint.a, 1e-4);
  h.cover = paint.a;
  h.albedo = paint.rgb * inv;
  h.glow = lit.x * inv;
  h.shine = lit.y * inv;
  return h;
}

// Layer l of the forest over col: the plants in the slots around P, lit at their depth, emerging
// from or fading into the haze with the density knob, hazed by distance; each cell is kelp or not
// by its threshold, so a passing edge flips it once.
void kelpForest(int l, vec2 P, vec3 water, float aa, float tc, KelpEnv e, bool wantStir, inout vec3 col, inout float rays, inout float accent, inout float stir) {
  if (uSimOn.x < 0.5 || uSimOn.y < 0.5) return;
  float s = KELP_LAYER_SCALE[l];
  // Each plant stands a little off its layer's depth (row 5): bounds wide enough for all of them.
  float floorY = KELP_HORIZON - KELP_FLOOR * s * 1.06;
  float surfaceY = KELP_HORIZON + KELP_SURFACE * s;
  if (P.y < floorY - 0.03 * s || P.y > KELP_HORIZON + KELP_SURFACE * s * 1.06) return;
  float reach = KELP_REACH * s;
  bool canopyBand = P.y > KELP_HORIZON + KELP_SURFACE * s * 0.94 - KELP_HANG * s;
  int slot = int(floor((P.x - KELP_LAYER_LEFT[l]) / KELP_LAYER_SPACING[l]));
  float dw = max(surfaceY - P.y, 0.0) / s;
  // The nearest kelp stands in its own shade against the bright water.
  float dim = 1.0 - 0.3 * smoothstep(0.7, 1.0, s);
  vec3 light = kelpLightAt(dw, e) * KELP_DIFFUSE * dim;
  // Light through a blade comes from just above it: less of it lost to the water than the scene's.
  vec3 beam = e.beam * exp(-dw * KELP_ABSORB * 0.7) * KELP_TRANSLUCENT * dim;
  float caustic = -1.0;
  vec4 acc = vec4(0.0);
  float glow = 0.0;
  for (int d = -2; d <= 2; d++) {
    int k = slot + d;
    if (k < 0 || k >= KELP_LAYER_SLOTS[l]) continue;
    int i = KELP_LAYER_FIRST[l] + k;
    vec4 box = kelpState(i, KELP_ROW_STIPES);
    if (box.w < 0.004) continue;
    bool rising = P.x > box.x - reach && P.x < box.y + reach && P.y < box.z + reach;
    bool floating = false;
    if (canopyBand) {
      vec4 canopy = kelpState(i, KELP_ROW_CANOPY);
      floating = canopy.x < float(KELP_SEGMENTS) - 0.5 && P.x > min(canopy.y, canopy.z) - reach && P.x < max(canopy.y, canopy.z) + reach;
    }
    if (!rising && !floating) continue;
    vec4 placed = kelpState(i, KELP_ROW_SCALE);
    float si = placed.x;
    KelpHit h = kelpStipe(i, si, KELP_HORIZON + KELP_SURFACE * si, P + vec2(0.0, (si - s) * kelpDrop), aa, tc, wantStir, rising, floating, placed.y > 0.5);
    stir = max(stir, h.stir * box.w);
    float alpha = hardEdge(h.cover * smoothstep(0.0, 0.3, box.w), kelpTh);
    if (alpha <= 0.0) continue;
    // The caustic net plays softly over the kelp too (worked out once, for the first plant here).
    if (caustic < 0.0) {
      caustic = kelpCaustic(vec2(P.x / s - dw * e.slant, 1.0 / s + 0.35 * dw), tc * KELP_CAUSTIC_RATE, 0.1) * K_caustics * smoothstep(0.0, 0.4, dw);
    }
    float lit = 0.75 + 0.4 * caustic;
    vec3 c = h.albedo * light + (h.glow * KELP_GOLD + h.shine * KELP_GLINT) * beam * lit;
    c = mix(water, c, box.w);
    acc = kelpOver(acc, c, alpha);
    glow = h.glow * lit * alpha + glow * (1.0 - alpha);
  }
  if (acc.a <= 0.0) return;
  float fog = kelpFog(s);
  col = mix(col, mix(acc.rgb / acc.a, water, fog), acc.a);
  rays = mix(rays, kelpRayWeight(s), acc.a);
  accent = mix(accent, clamp(2.5 * glow / acc.a * dot(beam, LUMA), 0.0, 1.0) * (1.0 - fog), acc.a);
}

// ---- marine snow and plankton ----

// One drifting layer of marine snow at scale s: a flake in some of the cells of a grid carried by
// the surge and the current and sinking slowly, each wobbling a little on its own. Returns the
// flake's soft cover 0..1.
float kelpSnow(vec2 P, float s, float cell, float radius, float amount, float aa, float tc, KelpEnv e, float salt) {
  vec2 drift = vec2((kelpShift(P.x / s, e) + e.flow.z * tc) * s, -0.008 * s * tc);
  vec2 q = (P - drift) / cell;
  vec2 id = floor(q);
  float h = hash12(id + salt);
  if (h > amount) return 0.0;
  vec2 c = 0.22 + 0.56 * vec2(hash12(id + salt + 7.1), hash12(id + salt + 3.3));
  c += 0.08 * vec2(sin(tc * 0.25 + h * 40.0), cos(tc * 0.2 + h * 23.0));
  float r = max(radius, 1.8 * aa) / cell;
  return 1.0 - smoothstep(0.5 * r, r, length(fract(q) - c));
}

// Lay a snow layer over col: lit by the water at its depth, brighter inside a shaft.
void kelpSnowLayer(vec2 P, float s, float cell, float radius, float density, float aa, float tc, float shafts, KelpEnv e, float salt, vec3 water, inout vec3 col) {
  float amount = K_marineSnow * density;
  if (amount <= 0.0) return;
  float flake = hardEdge(0.9 * kelpSnow(P, s, cell, radius, amount, aa, tc, e, salt), kelpTh);
  if (flake <= 0.0) return;
  float dw = max((KELP_HORIZON + KELP_SURFACE * s - P.y) / s, 0.0);
  vec3 c = kelpLightAt(dw, e) * vec3(0.4, 0.46, 0.44) + kelpBeamAt(dw, e) * KELP_SHAFT_TINT * shafts * 0.4;
  col = mix(col, mix(c, water, kelpFog(s)), 0.6);
}

// Night plankton: a fixed sprinkle in the water (carried by the surge), each one flaring once the
// water around it is stirred past its own threshold, pulsing softly while it lasts. 0..1.
float kelpSparks(vec2 P, float stir, float aa, float tc, KelpEnv e) {
  const float s = 0.75;
  const float cell = 0.017;
  vec2 q = (P - vec2(kelpShift(P.x / s, e) * s, 0.0)) / cell;
  vec2 id = floor(q);
  float h = hash12(id + 91.7);
  float wakesAt = 0.12 + 0.8 * h;
  float gate = smoothstep(wakesAt, wakesAt + 0.2, stir);
  if (gate <= 0.0) return 0.0;
  vec2 c = 0.25 + 0.5 * vec2(hash12(id + 13.1), hash12(id + 5.9));
  float r = max(0.004, 2.0 * aa) / cell;
  float spark = 1.0 - smoothstep(0.3 * r, r, length(fract(q) - c));
  return gate * spark * (0.55 + 0.45 * sin(tc * (1.0 + 1.2 * fract(h * 7.7)) + h * 50.0));
}

// ---- the stone, the sea lion, the jellyfish, the school ----

// The Manifold M of rounded stones piled along its strokes on the floor, in a clearing the nearer
// plants leave it (sim.ts), crusted pink and white with coralline algae and lit by the caustic net;
// it carries a little through the haze. At night a bioluminescent film outlines it.
void kelpStone(vec2 P, vec3 water, float aa, float tc, KelpEnv e, inout vec3 col, inout float rays, inout float accent) {
  if (K_mark <= 0.0) return;
  const float s = KELP_MARK_SCALE;
  float floorY = KELP_HORIZON - KELP_FLOOR * s;
  float height = mix(KELP_MARK_LOW, KELP_MARK_HIGH, K_mark) * s;
  // Mark units, the M's foot on the floor.
  vec2 q = (P - vec2(KELP_MARK_X * s, floorY)) / height - vec2(0.0, 0.5);
  if (abs(q.x) > KELP_MARK_HALF + 0.05 || q.y > 0.65 || q.y < -0.56) return;
  // The nearest stone: along each stroke, the two around the pixel's place on it.
  float d = 1e3;
  vec2 nrm = vec2(0.0, 1.0);
  float stone = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 a = markVertex(k);
    vec2 ab = markVertex(k + 1) - a;
    float L = length(ab);
    vec2 dir = ab / L;
    vec2 across = vec2(-dir.y, dir.x);
    float before = floor(clamp(dot(q - a, dir), 0.0, L) / 0.12);
    for (int j = 0; j < 2; j++) {
      float index = min(before + float(j), floor(L / 0.12));
      float hs = hash12(vec2(float(k) * 17.0 + index, 3.7));
      vec2 c = a + dir * (index * 0.12 + 0.03 * (hs - 0.5)) + across * 0.04 * (fract(hs * 7.1) - 0.5);
      vec2 rel = (q - c) / vec2(1.0, 0.8);
      float dd = length(rel) - (0.09 + 0.045 * fract(hs * 13.3));
      if (dd < d) {
        d = dd;
        nrm = rel / max(length(rel), 1e-4);
        stone = hs;
      }
    }
  }
  float px = aa / height;
  if (hardFill(d, px, kelpTh) <= 0.0) return;
  // Each stone a dome lit from above; coralline crust on the tops, pink or white stone by stone.
  float crust = smoothstep(0.42, 0.56, vnoise(q * 14.0 + stone * 40.0)) * smoothstep(-0.2, 0.5, nrm.y);
  vec3 coral = mix(KELP_CORALLINE, vec3(0.95, 0.92, 0.88), step(0.7, fract(stone * 5.3)));
  vec3 albedo = mix(KELP_STONE * (0.85 + 0.35 * stone), coral, crust);
  float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
  float caustic = kelpCaustic(vec2(P.x / s - dw * e.slant, 1.0 / s + 0.35 * dw), tc * KELP_CAUSTIC_RATE, 0.05) * K_caustics;
  float top = max(nrm.y, 0.0);
  vec3 c = albedo * (kelpLightAt(0.5 * dw, e) * 0.7 * (0.65 + 0.5 * top) + kelpBeamAt(0.7 * dw, e) * (0.35 + 0.9 * caustic) * (0.45 + 0.75 * top));
  float breathe = 0.6 + 0.4 * sin(tc * 0.5);
  float outline = (1.0 - smoothstep(0.0, 0.03, -d)) * breathe * e.night;
  c += KELP_GLOW * (0.12 * crust * breathe * e.night + 0.35 * outline);
  float fog = 0.6 * kelpFog(s);
  col = mix(c, water, fog);
  rays = kelpRayWeight(s);
  accent = (0.55 + 0.45 * max(crust, outline)) * (1.0 - fog);
}

// A sea lion gliding past far off in the blue: a sleek dark shape, a fore flipper sweeping now and
// then, the hind flippers trailing.
void kelpVisitor(vec2 P, vec3 water, float aa, float tc, KelpEnv e, inout vec3 col, inout float rays) {
  if (uSimOn.y < 0.5) return;
  vec4 pose = kelpState(KELP_G_VISITOR_POSE, KELP_ROW_GLOBALS);
  if (pose.w <= 0.0) return;
  float L = KELP_VISITOR_LENGTH;
  vec2 d = P - pose.xy;
  if (dot(d, d) > 0.5 * L * L) return;
  vec4 look = kelpState(KELP_G_VISITOR_LOOK, KELP_ROW_GLOBALS);
  vec2 hd = vec2(cos(pose.z), sin(pose.z));
  // Body lengths: x toward the snout, y up whichever way it swims.
  vec2 q = vec2(dot(d, hd), dot(d, vec2(-hd.y, hd.x)) * look.y) / L;
  q.y -= 0.012 * sin(q.x * 5.0 - tc * 1.6);
  float bx = (q.x - 0.06) / 0.46;
  float neck = (q.x - 0.32) / 0.06;
  float profile = 0.105 * pow(clamp(1.0 - bx * bx, 0.0, 1.0), 0.6) * (1.0 - 0.18 * exp(-neck * neck));
  // (Capped past the snout and tail, where the profile is 0 and the axis would otherwise show.)
  float body = min(profile - abs(q.y + 0.01 * q.x), 0.2 * (1.0 - abs(bx)));
  float sweep = mix(-2.5, -1.7, look.x);
  vec2 shoulder = vec2(0.18, -0.05);
  vec2 tip = shoulder + 0.24 * vec2(cos(sweep), sin(sweep));
  float reachOut = clamp(dot(q - shoulder, tip - shoulder) / dot(tip - shoulder, tip - shoulder), 0.0, 1.0);
  float flipper = 0.035 - 0.02 * reachOut - segmentDistance(q, shoulder, tip);
  float hind = 0.022 - min(segmentDistance(q, vec2(-0.42, 0.0), vec2(-0.58, 0.035)), segmentDistance(q, vec2(-0.42, 0.0), vec2(-0.6, -0.025)));
  float cover = hardEdge(smoothstep(-aa / L, aa / L, max(max(body, flipper), hind)) * pose.w, kelpTh);
  if (cover <= 0.0) return;
  const float s = KELP_VISITOR_SCALE;
  float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
  vec3 c = KELP_SEALION * kelpLightAt(dw, e) * (0.35 + 0.3 * smoothstep(-0.04, 0.07, q.y));
  col = mix(c, water, kelpFog(s));
  rays = kelpRayWeight(s);
}

// A few jellyfish drifting through the forest with the water, bells pulsing (a quick squeeze, a slow
// release), oral arms waving and a faint fringe of tentacles; translucent by day, glowing at night.
void kelpJellies(vec2 P, float aspect, vec3 water, float aa, float tc, KelpEnv e, inout vec3 col, inout float accent) {
  int count = int(K_jellies + 0.5);
  if (count <= 0) return;
  float show = mix(0.35, 1.0, e.night);
  for (int j = 0; j < 5; j++) {
    if (j >= count) break;
    float fj = float(j);
    float h = hash12(vec2(fj * 7.3 + 1.0, 4.1));
    float s = mix(0.5, 0.85, fract(h * 13.7));
    vec2 c = vec2(0.42 * aspect * sin(tc * (0.009 + 0.006 * h) + h * TAU), 0.3 + 0.21 * (1.0 + sin(tc * (0.013 + 0.007 * fract(h * 5.1)) + fj * 2.1)));
    c.x += kelpShift(c.x / s, e) * s;
    float ph = fract(tc / (3.2 + 1.2 * fract(h * 3.7)) + h);
    float squeeze = smoothstep(0.0, 0.2, ph) * (1.0 - smoothstep(0.2, 0.85, ph));
    c.y += 0.005 * s * sin(TAU * ph - 0.6);
    float W = 0.034 * s * (1.0 - 0.12 * squeeze);
    float Hb = 0.026 * s * (1.0 + 0.1 * squeeze);
    float trail = Hb * (2.6 + 0.5 * squeeze);
    vec2 Pj = kelpAt(P, s);
    vec2 d = Pj - c;
    if (abs(d.x) > 1.4 * W || d.y > 1.2 * Hb || d.y < -trail - Hb) continue;
    vec2 q = rotate(d, -0.18 * sin(tc * 0.07 + h * 11.0));
    vec2 bq = q / vec2(W, Hb);
    float rim = length(vec2(bq.x, max(bq.y, 0.0)));
    float under = -0.18 * (1.0 - bq.x * bq.x);
    float px = aa / Hb;
    float dome = (1.0 - smoothstep(1.0 - px, 1.0 + px, rim)) * smoothstep(under - px, under + px, bq.y);
    vec2 gq = (vec2(abs(bq.x), bq.y) - vec2(0.38, 0.3)) / 0.17;
    float gonads = exp(-dot(gq, gq)) * dome;
    float below = clamp(-q.y / trail, 0.0, 1.0);
    float arms = 0.0;
    float fringe = 0.0;
    if (q.y < 0.0) {
      for (int m = 0; m < 4; m++) {
        float fm = float(m);
        float x = (fm - 1.5) * 0.22 * W + 0.3 * W * below * sin(below * 5.0 - tc * 0.9 + fm * 1.7 + h * 9.0);
        float hw = max(0.07 * W * (1.0 - 0.7 * below), 1.0 * aa);
        arms = max(arms, (1.0 - smoothstep(hw - aa, hw + aa, abs(q.x - x))) * (1.0 - below));
      }
      float edge = (abs(q.x) - 0.85 * W) / (0.18 * W);
      fringe = exp(-edge * edge) * (1.0 - smoothstep(0.0, 0.8 * trail, -q.y));
    }
    float alpha = max(dome * (0.35 + 0.45 * smoothstep(0.6, 1.0, rim)), max(0.5 * arms, 0.22 * fringe)) * show;
    if (alpha <= 0.0) continue;
    float glow = (dome * (0.25 + 0.75 * smoothstep(0.55, 1.0, rim) * (0.6 + 0.4 * squeeze)) + 0.6 * gonads + 0.4 * arms + 0.2 * fringe) * show;
    float fog = kelpFog(s);
    float dw = (KELP_HORIZON + KELP_SURFACE * s - Pj.y) / s;
    vec3 jc = mix(KELP_JELLY_DAY * kelpLightAt(max(dw, 0.0), e) * 0.7, KELP_GLOW * 0.35, e.night);
    col = mix(col, mix(jc, water, fog), alpha * (1.0 - 0.5 * fog));
    col += KELP_GLOW * glow * e.night * (1.0 - fog) * 0.4;
    accent = max(accent, glow * e.night * (1.0 - fog));
  }
}

// The school: small spindle-shaped fish a few cells long (the shared fishSide, sims/fish.ts),
// pointed at the snout and forked at the tail, silver along the flank and dark along the back,
// swimming loosely at slightly different depths (and so sizes). A fish turning toward or away from
// the eye shows less of its side; each flank catches the light by its heading, and a fish rolling
// into a turn flashes bright.
void kelpFish(vec2 P, vec3 water, float aa, KelpEnv e, inout vec3 col, inout float rays, inout float accent) {
  if (uSimOn.y < 0.5) return;
  vec4 box = kelpState(KELP_G_SCHOOL, KELP_ROW_GLOBALS);
  if (P.x < box.x || P.x > box.z || P.y < box.y || P.y > box.w) return;
  const float s = KELP_FISH_SCALE;
  float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
  vec3 light = kelpLightAt(dw, e);
  vec3 beam = kelpBeamAt(dw, e);
  float cover = 0.0;
  vec3 fishCol = vec3(0.0);
  float flash = 0.0;
  for (int f = 0; f < KELP_MAX_FISH; f++) {
    vec4 look = kelpState(f, KELP_ROW_FISH_LOOK);
    float len = look.x;
    if (len <= 0.0) continue;
    vec4 pose = kelpState(f, KELP_ROW_FISH_POSE);
    vec2 d = P - pose.xy;
    if (dot(d, d) > 0.4 * len * len) continue;
    // Body lengths: x toward the snout (foreshortened as it turns in depth), y up whichever way it
    // swims.
    float up = pose.z >= 0.0 ? 1.0 : -1.0;
    vec2 q = vec2(dot(d, pose.zw) / max(look.z, 0.3), dot(d, vec2(-pose.w, pose.z)) * up) / len;
    float px = aa / len;
    if (hardEdge(smoothstep(-px, px, fishSide(q)) * min(look.w * 1.5, 1.0), kelpTh) <= 0.0) continue;
    float sheen = 0.7 + 0.35 * cos(2.0 * atan(pose.w, pose.z) + float(f) * 1.7);
    vec3 flank = KELP_SILVER * (light * 0.95 * sheen + beam * (0.3 + 1.4 * look.y));
    fishCol = mix(flank, KELP_FISH_BACK * light * 1.3, step(0.03, q.y));
    flash = look.y;
    cover = 1.0;
  }
  if (cover <= 0.0) return;
  float fog = kelpFog(s);
  col = mix(fishCol, water, fog);
  rays = kelpRayWeight(s);
  accent = 0.6 * flash;
}

Shade sceneKelp(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 P = vec2((uv.x - 0.5) * aspect, uv.y);
  float aa = 1.0 / uRes.y;
  float tc = uMotionTime;
  kelpTh = edgeThreshold(cell, vec2(2.0, 7.0));
  // The camera. Entering, it sinks from just under the surface, already on its way down, braking,
  // and settles a hair below its mark; leaving, it rises toward the light, gathering speed. Every
  // term is exactly 0 at rest.
  float arrive = passageIn();
  float sink = (1.0 - arrive) * (1.0 - arrive);
  float settle = clamp((arrive - KELP_DIP_FROM) / (1.0 - KELP_DIP_FROM), 0.0, 1.0);
  float leave = passageOut();
  kelpDrop = KELP_DROP * sink - KELP_DIP * 16.0 * settle * settle * (1.0 - settle) * (1.0 - settle) + KELP_RISE * leave * leave;
  KelpEnv e = kelpEnvironment(tc);
  vec3 water = kelpWater(P, e);
  bool wantStir = e.night * K_plankton > 0.01;
  float shafts = kelpShafts(P, e, tc) * K_rays;

  float rays = 1.0;
  float accent = 0.0;
  float stir = 0.0;
  vec3 col = kelpBackground(P, water, aa, tc, e, rays);
  // Things on the floor go down just before the first layer nearer than they are.
  KelpThing thing = kelpThings(P, aa, tc, e);
  bool placed = thing.cover <= 0.0;
  // Two walls of distant kelp, the farther first, both behind anything on the floor.
  kelpBackdrop(0.16, 11.0, kelpAt(P, 0.16), water, aa, e, col, rays);
  kelpBackdrop(0.24, 37.0, kelpAt(P, 0.24), water, aa, e, col, rays);
  kelpPlace(thing, KELP_LAYER_SCALE[3], water, placed, col, rays);
  kelpForest(3, kelpAt(P, KELP_LAYER_SCALE[3]), water, aa, tc, e, wantStir, col, rays, accent, stir);
  kelpPlace(thing, 0.45, water, placed, col, rays);
  kelpSnowLayer(kelpAt(P, 0.45), 0.45, 0.035, 0.0022, 0.1, aa, tc, shafts, e, 3.0, water, col);
  kelpPlace(thing, KELP_LAYER_SCALE[2], water, placed, col, rays);
  kelpForest(2, kelpAt(P, KELP_LAYER_SCALE[2]), water, aa, tc, e, wantStir, col, rays, accent, stir);
  kelpPlace(thing, KELP_VISITOR_SCALE, water, placed, col, rays);
  kelpVisitor(kelpAt(P, KELP_VISITOR_SCALE), water, aa, tc, e, col, rays);
  kelpPlace(thing, KELP_MARK_SCALE, water, placed, col, rays);
  kelpStone(kelpAt(P, KELP_MARK_SCALE), water, aa, tc, e, col, rays, accent);
  kelpPlace(thing, KELP_LAYER_SCALE[1], water, placed, col, rays);
  kelpForest(1, kelpAt(P, KELP_LAYER_SCALE[1]), water, aa, tc, e, wantStir, col, rays, accent, stir);
  kelpJellies(P, aspect, water, aa, tc, e, col, accent);
  kelpPlace(thing, KELP_FISH_SCALE, water, placed, col, rays);
  kelpSnowLayer(kelpAt(P, 0.75), 0.75, 0.055, 0.003, 0.08, aa, tc, shafts, e, 17.0, water, col);
  kelpFish(kelpAt(P, KELP_FISH_SCALE), water, aa, e, col, rays, accent);
  kelpPlace(thing, KELP_LAYER_SCALE[0], water, placed, col, rays);
  kelpForest(0, kelpAt(P, KELP_LAYER_SCALE[0]), water, aa, tc, e, wantStir, col, rays, accent, stir);

  // The shafts: light scattered toward the eye from the water in front of whatever is seen.
  col += e.beam * KELP_SHAFT_TINT * shafts * rays * 0.28;

  // Night plankton, sparking where the kelp moves and where the hand has stirred the water.
  if (wantStir) {
    float trail = uSimOn.z > 0.5 ? texture(uSim2, uv).r : 0.0;
    float sparks = kelpSparks(P, max(stir / 0.3, 1.3 * trail), aa, tc, e) * K_plankton * e.night;
    col += KELP_GLOW * sparks * 0.8;
    accent = max(accent, sparks);
  }

  return shadeOf(col, inkOf(col, 1.6, 1.0), clamp(accent, 0.0, 1.0));
}
`;
