// The kelp forest's picture: a side-on view from mid-water, the sea floor below and the surface's
// underside above, both receding into blue-green haze toward eye level. Back to front: floor or
// surface (a rippled silver ceiling with Snell's window overhead), a hazy wall of distant kelp,
// three layers of simulated kelp with marine snow between them, a passing sea lion, the Manifold
// stone, jellyfish, the school of fish; then the light shafts in the water in front of it all and,
// at night, the plankton sparking where the water is stirred.
//
// One light model throughout: the shared sky's sun, moon and sky glow enter at the surface; the
// water absorbs red first (KELP_ABSORB per world unit of depth) and scatters what is left into the
// blue-green the far things fade to. The direct beam carries the caustic net (kelpCaustic, one
// moving function for the floor, the kelp and the stone), shines through the blades and converges,
// refracted, on a vanishing point above the frame that the shafts fan out from.
//
// Sim textures (sim.ts): uSim0 the kelp's points, uSim1 the state rows (stipe boxes, fish, globals),
// uSim2 the hand's trail. Units: screen heights, x from the frame's centre, y up from its bottom;
// a depth layer at perspective scale s shows world lengths times s ("world" = screen heights at the
// nearest layer).
// Knobs read here: K_haze, K_rays, K_caustics, K_surface, K_density, K_kelpSeed, K_marineSnow,
// K_jellies, K_plankton, K_mark, K_time, K_cycle.
import {
  KELP_FISH,
  KELP_GLOBAL,
  KELP_LAYERS,
  KELP_ORIGIN,
  KELP_POINT_ROW,
  KELP_POINTS,
  KELP_ROW,
  KELP_SEGMENTS,
  KELP_STIPE_LENGTH,
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

export const kelpGlsl = `
// ---- shared with the simulation (sim.ts) ----
const float KELP_HORIZON = ${num(KELP_VIEW.horizon)};
const float KELP_FLOOR = ${num(KELP_VIEW.floor)};
const float KELP_SURFACE = ${num(KELP_VIEW.surface)};
const float KELP_FOCAL = ${num(KELP_VIEW.focal)};
const int KELP_SEGMENTS = ${KELP_SEGMENTS};
const int KELP_POINTS = ${KELP_POINTS};
const int KELP_POINT_ROW = ${KELP_POINT_ROW};
const vec3 KELP_ORIGIN = vec3(${KELP_ORIGIN.map(num).join(", ")});
// A link of a plant in the shader's reckoning (the mean plant's length over its links), at scale 1:
// it only sets the blade spacing, measured along the stipe in links.
const float KELP_LINK = ${num((KELP_STIPE_LENGTH * 0.92) / KELP_SEGMENTS)};
const float KELP_LAYER_SCALE[${layerCount}] = ${glslArray("float", KELP_LAYERS.map((l) => l.scale))};
const float KELP_LAYER_LEFT[${layerCount}] = ${glslArray("float", KELP_LAYERS.map((l) => l.left))};
const float KELP_LAYER_SPACING[${layerCount}] = ${glslArray("float", KELP_LAYERS.map((l) => l.spacing))};
const int KELP_LAYER_SLOTS[${layerCount}] = ${glslArray("int", KELP_LAYERS.map((l) => l.slots))};
const int KELP_LAYER_FIRST[${layerCount}] = ${glslArray("int", KELP_LAYERS.map((l) => l.first))};
const int KELP_ROW_STIPES = ${KELP_ROW.stipes};
const int KELP_ROW_FISH_POSE = ${KELP_ROW.fishPose};
const int KELP_ROW_FISH_LOOK = ${KELP_ROW.fishLook};
const int KELP_ROW_GLOBALS = ${KELP_ROW.globals};
const int KELP_G_PHASES = ${KELP_GLOBAL.phases};
const int KELP_G_FLOW = ${KELP_GLOBAL.flow};
const int KELP_G_SCHOOL = ${KELP_GLOBAL.school};
const int KELP_G_VISITOR_POSE = ${KELP_GLOBAL.visitorPose};
const int KELP_G_VISITOR_LOOK = ${KELP_GLOBAL.visitorLook};
const int KELP_MAX_FISH = ${KELP_FISH.max};
const float KELP_FISH_SCALE = ${num(KELP_FISH.scale)};
const float KELP_VISITOR_SCALE = ${num(KELP_VISITOR.scale)};
const float KELP_VISITOR_LENGTH = ${num(KELP_VISITOR.length)};
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
const float KELP_CAUSTIC_RATE = 0.35;                  // how fast the net shifts (per second of t)

// ---- the kelp ----
const vec3 KELP_OLIVE = vec3(0.34, 0.26, 0.09);        // a blade in the water's light
const vec3 KELP_GOLD = vec3(1.0, 0.74, 0.26);          // sunlight shining through a blade
const vec3 KELP_GLINT = vec3(1.0, 0.93, 0.72);         // a highlight on a gas bladder
const vec3 KELP_STIPE = vec3(0.20, 0.15, 0.06);
const vec3 KELP_ROCK = vec3(0.24, 0.26, 0.22);
const vec3 KELP_SAND = vec3(0.62, 0.56, 0.42);
const float KELP_DIFFUSE = 0.32;                       // share of the water's light a blade sends back
const float KELP_TRANSLUCENT = 0.55;                   // share of the beam it lets through
const float KELP_BLADE_GAP = 0.05;                     // between blades along one side (world units)
const float KELP_BLADE_LEN = 0.14;
const float KELP_BLADE_WIDTH = 0.10;                   // widest half-width over the length
const float KELP_BLADE_ANGLE = 0.55;                   // radians off the stipe in still water
const float KELP_BLADE_CURL = 0.3;                     // how far a blade curls up toward its tip
const float KELP_STIPE_HALF = 0.0042;
const float KELP_BLADDER = 0.0065;
const float KELP_REACH = 0.2;                          // how far blades reach past the stipe's points

// ---- life ----
const vec3 KELP_SILVER = vec3(0.78, 0.86, 0.90);
const vec3 KELP_FISH_BACK = vec3(0.10, 0.20, 0.26);
const vec3 KELP_SEALION = vec3(0.17, 0.13, 0.10);
const vec3 KELP_JELLY_DAY = vec3(0.75, 0.80, 0.92);
const vec3 KELP_GLOW = vec3(0.30, 0.95, 1.0);          // bioluminescence: plankton, jellies, the stone's crust
const vec3 KELP_STONE = vec3(0.34, 0.36, 0.31);
const vec3 KELP_CORALLINE = vec3(0.86, 0.45, 0.58);

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

KelpEnv kelpEnvironment(float t) {
  KelpEnv e;
  e.sky = skyAt(timeOfDay(K_time, K_cycle, t));
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
// the time integral of the flow the kelp is dragged by in sim.ts, so snow, plankton, jellyfish and
// the shade on the floor all sway with the forest.
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

// The net of light the surface's waves focus onto whatever lies below: the edges of slowly
// wandering, warped cells, brightest where they meet. p is a point on a horizontal plane in world
// units; t the caustic clock; blur a cell's footprint in caustic units, which widens and dims the
// lines where they would otherwise alias.
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
  float w = 0.07 + blur;
  return exp(-(f2 - f1) / w) * (0.6 + 0.8 * smoothstep(0.3, 0.6, f1)) * (0.07 / w);
}

// The shafts: beams fanning from the vanishing point, slowly changing, leaning with the surge as
// the swell tilts the surface they are focused by. 0..1, strongest toward the surface.
float kelpShafts(vec2 P, KelpEnv e, float tc) {
  float fan = (P.x - e.vanish.x) / max(e.vanish.y - P.y, 0.08);
  float sway = 0.07 * e.phases.y * e.flow.x / KELP_SURGE_SPEED;
  float a = vnoise(vec2((fan + sway) * 6.0, tc * 0.035));
  float b = vnoise(vec2((fan + sway) * 14.0 - 3.1, tc * 0.05 + 7.0));
  return smoothstep(0.45, 0.9, 0.7 * a + 0.4 * b - 0.05) * mix(0.3, 1.0, smoothstep(0.0, 1.0, P.y));
}

// Slopes of the surface's small waves, plus the swell's long slope swaying with the surge.
vec2 kelpWaves(vec2 w, float tc, KelpEnv e) {
  vec2 g = vec2(0.8, 0.6) * 0.024 * cos(dot(w, vec2(0.8, 0.6)) * 13.0 - tc * 0.9);
  g += vec2(-0.5, 0.866) * 0.02 * cos(dot(w, vec2(-0.5, 0.866)) * 17.0 - tc * 1.1 + 1.7);
  g += vec2(0.96, -0.28) * 0.016 * cos(dot(w, vec2(0.96, -0.28)) * 23.0 - tc * 1.3 + 4.1);
  g += vec2(-0.2, -0.98) * 0.013 * cos(dot(w, vec2(-0.2, -0.98)) * 31.0 - tc * 1.6 + 2.6);
  float a1 = KELP_SURGE_K1 * w.x;
  g.x += 0.06 * e.flow.x / KELP_SURGE_SPEED * (e.phases.y * cos(a1) - e.phases.x * sin(a1));
  return g;
}

// ---- the floor and the surface ----

// Whichever the view ray meets, hazed by distance. rays: the shafts' weight in front of it;
// window: how much of Snell's window shows here.
vec3 kelpBackground(vec2 P, vec3 water, float aa, float tc, KelpEnv e, out float rays, out float window) {
  window = 0.0;
  if (P.y < KELP_HORIZON) {
    // The sea floor: sand rippled across the surge, patches of rock and turf, the canopy's shade
    // drifting over it and the caustic net.
    float s = max((KELP_HORIZON - P.y) / KELP_FLOOR, 1e-3);
    vec2 w = vec2(P.x / s, 1.0 / s);
    float foot = aa / (s * s * KELP_FLOOR);
    float detail = 1.0 - smoothstep(0.02, 0.08, foot);
    float patches = fbm(w * vec2(1.1, 0.9) + 3.7);
    float ripple = sin(w.x * 24.0 + 3.0 * vnoise(w * 1.7)) * detail;
    vec3 ground = mix(KELP_SAND * (0.92 + 0.08 * ripple), KELP_ROCK * (0.8 + 0.4 * vnoise(w * 7.0)), smoothstep(0.52, 0.62, patches));
    float depth = KELP_FLOOR + KELP_SURFACE;
    float shift = kelpShift(w.x, e);
    float shade = 0.6 + 0.4 * smoothstep(0.35, 0.65, vnoise(vec2(w.x * 0.7 - shift * 0.7, w.y * 0.55)));
    float caustic = kelpCaustic(vec2(w.x - depth * e.slant + shift * 0.25, w.y + 0.35 * depth), tc * KELP_CAUSTIC_RATE, foot * KELP_CAUSTIC_SCALE * 3.0) * K_caustics;
    vec3 c = ground * shade * (kelpLightAt(depth, e) * 0.55 + kelpBeamAt(depth, e) * (0.25 + 1.6 * caustic));
    rays = kelpRayWeight(s);
    return mix(c, water, kelpFog(s));
  }

  // The surface from below: a silvery, rippled mirror of the bright water beneath it, except
  // overhead, where Snell's window opens onto the sky, its edge wavering with the ripples.
  float s = max((P.y - KELP_HORIZON) / KELP_SURFACE, 1e-3);
  vec2 w = vec2(P.x / s, 1.0 / s);
  float foot = aa / (s * s * KELP_SURFACE);
  float detail = 1.0 - smoothstep(0.015, 0.06, foot);
  vec2 g = kelpWaves(w, tc, e) * detail * (0.4 + 0.6 * K_surface);
  vec3 rd = normalize(vec3(P.x, P.y - KELP_HORIZON, KELP_FOCAL));
  vec3 nrm = normalize(vec3(-g.x, 1.0, -g.y));
  float cosI = dot(rd, nrm);
  vec3 c = e.up * (1.1 + 9.0 * K_surface * dot(g, vec2(0.45, 0.9)));
  window = smoothstep(0.64, 0.70, cosI) * K_surface;
  if (window > 0.0) {
    // Little gets through near the critical angle (Fresnel), all of it overhead.
    vec3 skyDir = refract(rd, -nrm, 1.333);
    vec3 skyC = skyColor(e.sky, normalize(skyDir + vec3(0.0, 1e-4, 0.0)));
    c = mix(c, (skyC * 1.8 + e.beam * 0.4) * (0.55 + 0.45 * smoothstep(0.661, 0.8, cosI)), window);
  }
  rays = kelpRayWeight(s);
  return mix(c, water, kelpFog(s));
}

// A wall of distant kelp in the haze: columns that sway with the surge, ragged with blades.
void kelpBackdrop(vec2 P, vec3 water, float aa, KelpEnv e, inout vec3 col, inout float rays) {
  const float s = 0.22;
  float floorY = KELP_HORIZON - KELP_FLOOR * s;
  float surfaceY = KELP_HORIZON + KELP_SURFACE * s;
  if (P.y < floorY || P.y > surfaceY) return;
  float spacing = 0.36 * s;
  float frac = (P.y - floorY) / (surfaceY - floorY);
  float cell = floor(P.x / spacing);
  float cover = 0.0;
  for (int d = -1; d <= 1; d++) {
    float c = cell + float(d);
    float h = hash12(vec2(c, K_kelpSeed + 11.0));
    if (h > 0.25 + 0.75 * K_density) continue;
    float h2 = hash12(vec2(c + 0.5, K_kelpSeed + 23.0));
    if (frac > 0.82 + 0.14 * fract(h2 * 7.3)) continue;
    float bx = (c + 0.5 + 0.6 * (h2 - 0.5)) * spacing;
    float x = bx + kelpShift(bx / s, e) * s * pow(frac, 1.3) * 0.8;
    float fuzz = smoothstep(0.35, 0.85, vnoise(vec2(frac * 38.0, c * 3.1))) * smoothstep(0.05, 0.2, frac);
    float halfWidth = max(s * (0.004 + 0.02 * fuzz), aa);
    cover = max(cover, 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(P.x - x)));
  }
  if (cover <= 0.0) return;
  vec3 kelp = KELP_OLIVE * kelpLightAt((surfaceY - P.y) / s, e) * KELP_DIFFUSE;
  col = mix(col, mix(kelp, water, kelpFog(s)), cover);
  rays = mix(rays, kelpRayWeight(s), cover);
}

// ---- the kelp ----

struct KelpHit {
  float cover;   // 0..1
  vec3 albedo;   // what the water's light shows of it
  float glow;    // light shining through the blades
  float shine;   // glints on the gas bladders
  float stir;    // how fast it moves here (world units/s), for the plankton
};

// Stipe i (in a layer at scale s) at P: a Hermite spine through its points, blades leaving it at
// even gaps on alternating sides (each streaming with the water as sim.ts leans it, rippling
// slowly, splaying into a canopy at the crown), a gas bladder at each blade's foot, and the
// holdfast on its boulder.
KelpHit kelpStipe(int i, float s, vec2 P, float aa, float tc, bool wantStir) {
  KelpHit h = KelpHit(0.0, vec3(0.0), 0.0, 0.0, 0.0);
  int first = i * KELP_POINTS;
  vec4 root = kelpNode(first);
  vec4 top = kelpNode(first + KELP_SEGMENTS);

  // The link at the pixel's height, from how high the crown stands (a stipe rises nearly evenly),
  // moved by one where it bends.
  float rise = max(top.y - root.y, 1e-3);
  int k = clamp(int(floor((P.y - root.y) / rise * float(KELP_SEGMENTS))), 0, KELP_SEGMENTS - 1);
  vec4 a = kelpNode(first + k);
  vec4 b = kelpNode(first + k + 1);
  if (P.y < a.y && k > 0) {
    k -= 1;
    b = a;
    a = kelpNode(first + k);
  } else if (P.y > b.y && k < KELP_SEGMENTS - 1) {
    k += 1;
    a = b;
    b = kelpNode(first + k + 1);
  }
  vec2 a0 = kelpNode(first + max(k - 1, 0)).xy;
  vec2 b1 = kelpNode(first + min(k + 2, KELP_SEGMENTS)).xy;
  vec2 ta = k > 0 ? 0.5 * (b.xy - a0) : b.xy - a.xy;
  vec2 tb = k < KELP_SEGMENTS - 1 ? 0.5 * (b1 - a.xy) : b.xy - a.xy;

  // The spine near the pixel's height (Catmull-Rom tangents), its direction, and the pixel in its
  // frame: t along the stipe from the holdfast, n across it (positive to the left).
  float u = clamp((P.y - a.y) / max(b.y - a.y, 1e-4), 0.0, 1.0);
  float u2 = u * u;
  float u3 = u2 * u;
  vec2 S = (2.0 * u3 - 3.0 * u2 + 1.0) * a.xy + (u3 - 2.0 * u2 + u) * ta + (3.0 * u2 - 2.0 * u3) * b.xy + (u3 - u2) * tb;
  vec2 T = normalize((6.0 * u2 - 6.0 * u) * (a.xy - b.xy) + (3.0 * u2 - 4.0 * u + 1.0) * ta + (3.0 * u2 - 2.0 * u) * tb + vec2(0.0, 1e-6));
  vec2 N = vec2(-T.y, T.x);
  vec2 r = P - S;
  float link = KELP_LINK * s;
  float len = link * float(KELP_SEGMENTS);
  float t = (float(k) + u) * link + dot(r, T);
  float n = dot(r, N);
  float an = abs(n);
  float side = n >= 0.0 ? 1.0 : -1.0;
  float along = t / len;
  float plant = hash12(vec2(float(i) * 1.37, K_kelpSeed + 0.5));

  // The stipe, thicker toward the holdfast.
  float hwS = max(KELP_STIPE_HALF * s * (1.0 + 1.4 * (1.0 - smoothstep(0.0, 0.1, along))), 0.8 * aa);
  float body = (1.0 - smoothstep(hwS - aa, hwS + aa, an)) * smoothstep(-aa, aa, t + hwS) * (1.0 - smoothstep(len - aa, len + aa, t));

  // Blades: the one through the pixel leaves the stipe at t0, at angle alpha off it on this side,
  // curling up toward its tip. alpha drifts slowly along the stipe and in time, and a ripple runs
  // up it, so no two blades hang quite alike.
  float lean = mix(a.w, b.w, u);
  float flutter = 0.12 * sin(t / s * 11.0 - tc * 1.1 + side * 1.3 + plant * TAU) + 0.5 * vnoise(vec2(t / s * 9.0 + plant * 17.0, side * 3.3 + tc * 0.05)) - 0.25;
  float alpha = clamp(KELP_BLADE_ANGLE + 0.45 * smoothstep(0.72, 1.0, along) - side * lean + flutter, 0.12, 1.45);
  float sa = sin(alpha);
  float gap = KELP_BLADE_GAP * s;
  float phase = side > 0.0 ? 0.0 : 0.5;
  float outward = an / sa;
  float t0 = t - an * cos(alpha) / sa - KELP_BLADE_CURL * outward * outward / (KELP_BLADE_LEN * s);
  float index = floor(t0 / gap - phase + 0.5);
  float foot = (index + phase) * gap;
  float hb = hash12(vec2(index * side + 0.5, float(i) + 31.0 * K_kelpSeed));
  float blen = KELP_BLADE_LEN * s * (0.75 + 0.5 * hb) * (1.0 + 0.3 * smoothstep(0.72, 1.0, foot / len));
  float q = an / (sa * blen);
  float qc = clamp(q, 0.0, 1.0);
  float v = (t0 - foot) * sa;
  // A lance with a wavy margin, slender at its foot.
  float hw = blen * KELP_BLADE_WIDTH * 2.9 * pow(qc, 0.55) * (1.0 - qc) * (1.0 + 0.12 * sin(qc * 30.0 + hb * 20.0));
  float blade = step(0.06 * len, foot) * step(foot, len) * step(q, 1.0) * (1.0 - smoothstep(hw - aa, hw + aa, abs(v)));

  // Gas bladders at the blades' feet (near layers only: farther they would be specks).
  float bladder = 0.0;
  float spot = 0.0;
  if (s > 0.45) {
    float rb = KELP_BLADDER * s;
    float tbb = (floor((t - 0.5 * rb) / gap - phase + 0.5) + phase) * gap + 0.5 * rb;
    vec2 bq = vec2(an - hwS - 0.7 * rb, t - tbb);
    bladder = step(0.06 * len, tbb) * step(tbb, len) * (1.0 - smoothstep(rb - aa, rb + aa, length(bq)));
    spot = 1.0 - smoothstep(0.1 * rb, 0.7 * rb, length(bq - vec2(-0.25, 0.4) * rb));
  }

  // Back to front: boulder, holdfast, blade, stipe, bladder. The light through the blades and the
  // glints ride along premultiplied (lit), so a blade's soft edge keeps its glow.
  vec4 paint = vec4(0.0);
  vec2 hr = (P - root.xy) / s;
  if (hr.y < 0.05) {
    // The holdfast, a tangle of haptera gripping a boulder on the floor.
    float tangle = vnoise(hr * 150.0 + plant * 40.0);
    float hold = (1.0 - smoothstep(-0.08, 0.08, length(hr / vec2(0.03, 0.022)) - 1.0 + 0.35 * tangle)) * step(-0.003, hr.y);
    vec2 rq = (hr - vec2((plant - 0.5) * 0.03, -0.008)) / vec2(0.062, 0.03);
    float rock = (1.0 - smoothstep(-0.06, 0.06, length(rq) - 1.0 + 0.12 * vnoise(hr * 60.0))) * step(-0.006, hr.y);
    paint = kelpOver(paint, KELP_ROCK * (0.8 + 0.5 * smoothstep(-0.4, 0.8, rq.y)), rock);
    paint = kelpOver(paint, KELP_STIPE * (0.6 + 0.7 * tangle), hold);
  }
  paint = kelpOver(paint, KELP_OLIVE * (0.8 + 0.4 * hb) * (0.85 + 0.25 * qc), blade);
  // Thin toward the tips, so the light shines through them most.
  vec2 lit = vec2((0.3 + 0.7 * qc) * (0.75 + 0.5 * hb), 0.0) * blade;
  paint = kelpOver(paint, KELP_STIPE, body);
  lit *= 1.0 - body;
  paint = kelpOver(paint, KELP_OLIVE * 1.25, bladder);
  lit = vec2(0.4, spot) * bladder + lit * (1.0 - bladder);
  float inv = 1.0 / max(paint.a, 1e-4);
  h.cover = paint.a;
  h.albedo = paint.rgb * inv;
  h.glow = lit.x * inv;
  h.shine = lit.y * inv;
  if (wantStir) {
    float speed = mix(kelpNodeSpeed(first + k), kelpNodeSpeed(first + k + 1), u) / s;
    h.stir = speed * (1.0 - smoothstep(0.0, KELP_BLADE_LEN * s * 1.3, an));
  }
  return h;
}

// Layer l of the forest over col: the plants in the slots around P, lit at their depth, emerging
// from or fading into the haze with the density knob, hazed by distance.
void kelpForest(int l, vec2 P, vec3 water, float aa, float tc, KelpEnv e, bool wantStir, inout vec3 col, inout float rays, inout float accent, inout float stir) {
  if (uSimOn.x < 0.5 || uSimOn.y < 0.5) return;
  float s = KELP_LAYER_SCALE[l];
  float floorY = KELP_HORIZON - KELP_FLOOR * s;
  float surfaceY = KELP_HORIZON + KELP_SURFACE * s;
  if (P.y < floorY - 0.03 * s || P.y > surfaceY) return;
  float reach = KELP_REACH * s;
  int slot = int(floor((P.x - KELP_LAYER_LEFT[l]) / KELP_LAYER_SPACING[l]));
  float dw = (surfaceY - P.y) / s;
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
    if (box.w < 0.004 || P.x < box.x - reach || P.x > box.y + reach || P.y > box.z + reach) continue;
    KelpHit h = kelpStipe(i, s, P, aa, tc, wantStir);
    stir = max(stir, h.stir * box.w);
    if (h.cover <= 0.0) continue;
    // The caustic net plays over the kelp too (worked out once, for the first plant that needs it).
    if (caustic < 0.0) {
      caustic = kelpCaustic(vec2(P.x / s - dw * e.slant, 1.0 / s + 0.35 * dw), tc * KELP_CAUSTIC_RATE, 0.0) * K_caustics * smoothstep(0.0, 0.4, dw);
    }
    float lit = 0.45 + 1.4 * caustic;
    vec3 c = h.albedo * light + (h.glow * KELP_GOLD + h.shine * KELP_GLINT) * beam * lit;
    c = mix(water, c, box.w);
    float alpha = h.cover * smoothstep(0.0, 0.3, box.w);
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
// the surge and the current and sinking slowly, each wobbling a little on its own. Returns 0..1.
float kelpSnow(vec2 P, float s, float cell, float radius, float amount, float aa, float tc, KelpEnv e, float salt) {
  vec2 drift = vec2((kelpShift(P.x / s, e) + e.flow.z * tc) * s, -0.012 * s * tc);
  vec2 q = (P - drift) / cell;
  vec2 id = floor(q);
  float h = hash12(id + salt);
  if (h > amount) return 0.0;
  vec2 c = 0.22 + 0.56 * vec2(hash12(id + salt + 7.1), hash12(id + salt + 3.3));
  c += 0.1 * vec2(sin(tc * 0.35 + h * 40.0), cos(tc * 0.29 + h * 23.0));
  float r = max(radius, 1.6 * aa) / cell;
  return 1.0 - smoothstep(0.35 * r, r, length(fract(q) - c));
}

// Lay a snow layer over col: lit by the water at its depth, brighter inside a shaft.
void kelpSnowLayer(vec2 P, float s, float cell, float radius, float density, float aa, float tc, float shafts, KelpEnv e, float salt, vec3 water, inout vec3 col) {
  float amount = K_marineSnow * density;
  if (amount <= 0.0) return;
  float flake = kelpSnow(P, s, cell, radius, amount, aa, tc, e, salt);
  if (flake <= 0.0) return;
  float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
  vec3 c = kelpLightAt(max(dw, 0.0), e) * vec3(0.4, 0.46, 0.44) + kelpBeamAt(max(dw, 0.0), e) * KELP_SHAFT_TINT * shafts * 0.4;
  col = mix(col, mix(c, water, kelpFog(s)), flake * 0.6);
}

// Night plankton: a fixed sprinkle in the water (carried by the surge), each one flaring once the
// water around it is stirred past its own threshold, pulsing softly while it lasts. 0..1.
float kelpSparks(vec2 P, float stir, float aa, float tc, KelpEnv e) {
  const float s = 0.75;
  const float cell = 0.017;
  vec2 q = (P - vec2(kelpShift(P.x / s, e) * s, 0.0)) / cell;
  vec2 id = floor(q);
  float h = hash12(id + 91.7);
  float threshold = 0.12 + 0.8 * h;
  float gate = smoothstep(threshold, threshold + 0.2, stir);
  if (gate <= 0.0) return 0.0;
  vec2 c = 0.25 + 0.5 * vec2(hash12(id + 13.1), hash12(id + 5.9));
  float r = max(0.004, 2.0 * aa) / cell;
  float spark = 1.0 - smoothstep(0.3 * r, r, length(fract(q) - c));
  return gate * spark * (0.55 + 0.45 * sin(tc * (1.6 + 2.2 * fract(h * 7.7)) + h * 50.0));
}

// ---- the stone, the sea lion, the jellyfish, the school ----

// The Manifold M carved in stone, standing half sunk in the sand, crusted with coralline algae; the
// caustic net plays over it. At night the crust breathes a faint glow and a bioluminescent film
// traces the stone's edges, so the M still reads in the dark.
void kelpStone(vec2 P, vec3 water, float aa, float tc, KelpEnv e, inout vec3 col, inout float rays, inout float accent) {
  if (K_mark <= 0.0) return;
  const float s = 0.55;
  float floorY = KELP_HORIZON - KELP_FLOOR * s;
  float height = mix(0.16, 0.34, K_mark) * s;
  vec2 q = rotate(P - vec2(0.64 * s, floorY), -0.05) / height - vec2(0.0, 0.45);
  if (abs(q.x) > 0.62 || abs(q.y) > 0.62) return;
  float erode = 0.025 * (vnoise(q * 18.0) - 0.5) + 0.012 * (vnoise(q * 47.0) - 0.5);
  float d = markDistance(q) - 0.105 + erode;
  float sand = -0.47 + 0.04 * vnoise(vec2(q.x * 6.0, 1.3));
  float px = aa / height;
  float cover = (1.0 - smoothstep(-px, px, d)) * smoothstep(sand - px, sand + px, q.y);
  if (cover <= 0.0) return;
  // Bevelled edges catch the light from above.
  vec2 eps = vec2(0.01, 0.0);
  vec2 grad = vec2(markDistance(q + eps.xy) - markDistance(q - eps.xy), markDistance(q + eps.yx) - markDistance(q - eps.yx));
  float relief = 1.0 + 0.45 * smoothstep(-0.07, 0.0, d) * dot(normalize(grad + 1e-5), vec2(0.25, 0.97));
  float crust = smoothstep(0.55, 0.68, vnoise(q * 9.0 + 4.0)) * (0.5 + 0.5 * smoothstep(-0.2, 0.4, q.y));
  float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
  float caustic = kelpCaustic(vec2(P.x / s - dw * e.slant, 1.0 / s + 0.35 * dw), tc * KELP_CAUSTIC_RATE, 0.0) * K_caustics;
  vec3 c = mix(KELP_STONE, KELP_CORALLINE, crust) * relief * (kelpLightAt(dw, e) * 0.4 + kelpBeamAt(dw, e) * (0.2 + 1.2 * caustic));
  float breathe = 0.6 + 0.4 * sin(tc * 0.5);
  float outline = (1.0 - smoothstep(0.0, 0.035, -d)) * breathe * e.night;
  c += KELP_GLOW * (0.25 * crust * breathe * e.night + 0.35 * outline);
  float fog = kelpFog(s);
  col = mix(col, mix(c, water, fog), cover);
  rays = mix(rays, kelpRayWeight(s), cover);
  accent = mix(accent, (0.55 + 0.45 * max(crust, outline)) * (1.0 - fog), cover);
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
  float cover = smoothstep(-aa / L, aa / L, max(max(body, flipper), hind)) * pose.w;
  if (cover <= 0.0) return;
  const float s = KELP_VISITOR_SCALE;
  float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
  vec3 c = KELP_SEALION * kelpLightAt(dw, e) * (0.35 + 0.3 * smoothstep(-0.04, 0.07, q.y));
  col = mix(col, mix(c, water, kelpFog(s)), cover);
  rays = mix(rays, kelpRayWeight(s), cover);
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
    float ph = fract(tc / (2.8 + 1.2 * fract(h * 3.7)) + h);
    float squeeze = smoothstep(0.0, 0.14, ph) * (1.0 - smoothstep(0.14, 0.75, ph));
    c.y += 0.006 * s * sin(TAU * ph - 0.6);
    float W = 0.034 * s * (1.0 - 0.16 * squeeze);
    float Hb = 0.026 * s * (1.0 + 0.14 * squeeze);
    float trail = Hb * (2.6 + 0.6 * squeeze);
    vec2 d = P - c;
    if (abs(d.x) > 1.4 * W || d.y > 1.2 * Hb || d.y < -trail - Hb) continue;
    vec2 q = rotate(d, -0.18 * sin(tc * 0.07 + h * 11.0));
    vec2 bq = q / vec2(W, Hb);
    float rim = length(vec2(bq.x, max(bq.y, 0.0)));
    float under = -0.18 * (1.0 - bq.x * bq.x);
    float px = aa / Hb;
    float bell = (1.0 - smoothstep(1.0 - px, 1.0 + px, rim)) * smoothstep(under - px, under + px, bq.y);
    vec2 gq = (vec2(abs(bq.x), bq.y) - vec2(0.38, 0.3)) / 0.17;
    float gonads = exp(-dot(gq, gq)) * bell;
    float below = clamp(-q.y / trail, 0.0, 1.0);
    float arms = 0.0;
    float fringe = 0.0;
    if (q.y < 0.0) {
      for (int m = 0; m < 4; m++) {
        float fm = float(m);
        float x = (fm - 1.5) * 0.22 * W + 0.3 * W * below * sin(below * 5.0 - tc * 1.3 + fm * 1.7 + h * 9.0);
        float hw = max(0.07 * W * (1.0 - 0.7 * below), 0.9 * aa);
        arms = max(arms, (1.0 - smoothstep(hw - aa, hw + aa, abs(q.x - x))) * (1.0 - below));
      }
      float edge = (abs(q.x) - 0.85 * W) / (0.18 * W);
      fringe = exp(-edge * edge) * (1.0 - smoothstep(0.0, 0.8 * trail, -q.y));
    }
    float alpha = max(bell * (0.35 + 0.45 * smoothstep(0.6, 1.0, rim)), max(0.5 * arms, 0.22 * fringe)) * show;
    if (alpha <= 0.0) continue;
    float glow = (bell * (0.25 + 0.75 * smoothstep(0.55, 1.0, rim) * (0.6 + 0.4 * squeeze)) + 0.6 * gonads + 0.4 * arms + 0.2 * fringe) * show;
    float fog = kelpFog(s);
    float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
    vec3 jc = mix(KELP_JELLY_DAY * kelpLightAt(max(dw, 0.0), e) * 0.7, KELP_GLOW * 0.35, e.night);
    col = mix(col, mix(jc, water, fog), alpha * (1.0 - 0.5 * fog));
    col += KELP_GLOW * glow * e.night * (1.0 - fog) * 0.4;
    accent = max(accent, glow * e.night * (1.0 - fog));
  }
}

// The school: slim silver fish, dark along the back, flashing as they roll into a turn.
void kelpFish(vec2 P, vec3 water, float aa, KelpEnv e, inout vec3 col, inout float rays, inout float accent) {
  if (uSimOn.y < 0.5) return;
  vec4 box = kelpState(KELP_G_SCHOOL, KELP_ROW_GLOBALS);
  if (P.x < box.x || P.x > box.z || P.y < box.y || P.y > box.w) return;
  const float s = KELP_FISH_SCALE;
  float dw = (KELP_HORIZON + KELP_SURFACE * s - P.y) / s;
  vec3 light = kelpLightAt(dw, e);
  vec3 beam = kelpBeamAt(dw, e);
  vec4 acc = vec4(0.0);
  float flash = 0.0;
  for (int f = 0; f < KELP_MAX_FISH; f++) {
    vec4 look = kelpState(f, KELP_ROW_FISH_LOOK);
    float len = look.x;
    if (len <= 0.0) continue;
    vec4 pose = kelpState(f, KELP_ROW_FISH_POSE);
    vec2 d = P - pose.xy;
    if (dot(d, d) > 0.36 * len * len) continue;
    // Body lengths: x toward the snout, y up whichever way it swims; the tail beats.
    float up = pose.z >= 0.0 ? 1.0 : -1.0;
    vec2 q = vec2(dot(d, pose.zw), dot(d, vec2(-pose.w, pose.z)) * up) / len;
    float rear = clamp((0.1 - q.x) / 0.6, 0.0, 1.0);
    q.y -= look.z * 0.05 * rear * rear;
    float bx = (q.x - 0.08) / 0.42;
    float body = min(0.12 * sqrt(max(1.0 - bx * bx, 0.0)) - abs(q.y), 0.1 * (1.0 - abs(bx)));
    float tl = -0.3 - q.x;
    float fin = min(min(0.02 + 0.6 * tl - abs(q.y), 0.2 - tl), tl + 0.04);
    float px = aa / len;
    float alpha = smoothstep(-px, px, max(body, fin));
    if (alpha <= 0.0) continue;
    float dorsal = smoothstep(-0.03, 0.06, q.y);
    vec3 c = mix(KELP_SILVER, KELP_FISH_BACK, dorsal) * light * 0.75 + beam * look.y * (1.0 - 0.6 * dorsal) * 1.4;
    acc = kelpOver(acc, c, alpha);
    flash = look.y * alpha + flash * (1.0 - alpha);
  }
  if (acc.a <= 0.0) return;
  float fog = kelpFog(s);
  col = mix(col, mix(acc.rgb / acc.a, water, fog), acc.a);
  rays = mix(rays, kelpRayWeight(s), acc.a);
  accent = mix(accent, 0.6 * flash / acc.a, acc.a);
}

Shade sceneKelp(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 P = vec2((uv.x - 0.5) * aspect, uv.y);
  float aa = 1.0 / uRes.y;
  float tc = t * uMotion;
  KelpEnv e = kelpEnvironment(t);
  vec3 water = kelpWater(P, e);
  bool wantStir = e.night * K_plankton > 0.01;
  float shafts = kelpShafts(P, e, tc) * K_rays;

  float rays = 1.0;
  float window = 0.0;
  float accent = 0.0;
  float stir = 0.0;
  vec3 col = kelpBackground(P, water, aa, tc, e, rays, window);
  kelpBackdrop(P, water, aa, e, col, rays);
  kelpForest(2, P, water, aa, tc, e, wantStir, col, rays, accent, stir);
  kelpSnowLayer(P, 0.45, 0.035, 0.0022, 0.12, aa, tc, shafts, e, 3.0, water, col);
  kelpVisitor(P, water, aa, tc, e, col, rays);
  kelpStone(P, water, aa, tc, e, col, rays, accent);
  kelpForest(1, P, water, aa, tc, e, wantStir, col, rays, accent, stir);
  kelpJellies(P, aspect, water, aa, tc, e, col, accent);
  kelpSnowLayer(P, 0.7, 0.055, 0.003, 0.1, aa, tc, shafts, e, 17.0, water, col);
  kelpFish(P, water, aa, e, col, rays, accent);
  kelpForest(0, P, water, aa, tc, e, wantStir, col, rays, accent, stir);
  kelpSnowLayer(P, 1.15, 0.1, 0.005, 0.08, aa, tc, shafts, e, 41.0, water, col);

  // The shafts: light scattered toward the eye from the water in front of whatever is seen.
  col += e.beam * KELP_SHAFT_TINT * shafts * rays * 0.25;

  // Night plankton, sparking where the kelp moves and where the hand has stirred the water.
  float sparks = 0.0;
  if (wantStir) {
    float trail = uSimOn.z > 0.5 ? texture(uSim2, uv).r : 0.0;
    sparks = kelpSparks(P, max(stir / 0.3, 1.3 * trail), aa, tc, e) * K_plankton * e.night;
    col += KELP_GLOW * sparks * 0.8;
    accent = max(accent, sparks);
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(dot(col, LUMA) * 1.6, 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  o.shimmer = 0.15 * window + 0.2 * sparks;
  return o;
}
`;
