// The city crossing's picture: a scramble crossing at dusk, seen from a high window.
//
// World units are metres, as in sim.ts: x right along the avenue, y up, z away from the window; the
// eye is STREET_CAM_H up, pitched STREET_PITCH down, so screen rows are lines of equal z on the
// street. Each cell's ray is traced against the street (y = 0) and everything standing on it:
// - the city: the far blocks' facades (z = FACADE_FAR) along the avenue and the side street's walls
//   (x = ±SIDE_FACADE), cut into buildings generated below (a ramen shop on the left corner, a
//   konbini on the right, then izakaya, drugstores, cafés, bars, a karaoke hall, shutters), each
//   with a lit shop window and its fascia, upper floors of windows that switch on and off over the
//   minutes, flat signs climbing the walls; blade signs hanging out over the sidewalk with columns of
//   characters; awnings; vending machines; lamp posts with arms over the road; signal poles with
//   the avenue's and the side street's lights and the walk signals (the walk signals on the far
//   corners face the window);
// - the walkers, bicycles and cars from the simulation: walkers are a head, a coat (an ellipsoid
//   turned to their heading), two legs that swing with their gait, a bag, and in the rain an
//   umbrella seen from above, eight panels lit each on its own (clear vinyl ones show who is under
//   them); a walker looking up at the window shows its face and tips its umbrella back. Cars are a
//   body and a cabin box (corners rounded from above) with glass, lamps, taxi signs; bicycles a
//   rider on a frame. Only the agents the simulation lists in the tile under the cell's ray are
//   tested (sim.ts, uSim1), at most TILE_BODIES of them.
// The street: asphalt with wheel-polished lanes and oil drips, the light concrete gutters of
// Japanese roads, kerbs, paved sidewalks with yellow tactile strips, lane lines, arrows, stop
// lines, the zebras (W, E, N and two diagonals; with the landmark on, the diagonals are repainted
// as a V that makes the zebras an M from above), bicycle marks, manholes.
//
// Light: the sky's ambient (and the sun, shadowed by the blocks, by day), the city's own warm
// bounce at night, the street lamps (each comes on at its own moment at dusk), the shop windows and
// signs spilling onto the sidewalks, the vending machines, and the vehicles' lamps (low beams on
// the road, tail glow, brake lights in the queues), each listed per tile by the simulation (uSim1).
// Lamps, signals and vehicle lamps glow in the air round them, more in rain and fog.
//
// Rain (the weather contract in scenes/README.md): the sky in the puddles closes over, rain falls
// in depth (the ray's distance to what it meets) along paths that converge below the street, as a
// camera pitched down sees them (streetVanish), splashes crown on the street and the sidewalks
// except under the awnings, which drip; as the street wets it darkens and mirrors: the reflected
// ray is traced to the facades and the sky above the roofs, its blur growing with the distance and
// the asphalt's roughness so every lit window and sign smears into a long streak toward the eye;
// the lamps, signals and vehicle lamps add their own streaks (from the point where their mirror
// image sits on the street, toward the eye); puddles mirror sharply, ringed by drops; tyres throw
// spray. Snow falls the same way (streetSnow: the flakes close in on the point under the eye) and
// settles on the street (except the wheel tracks and where people walk), on roofs of cars, on
// umbrellas, awnings, signs and lamps.
//
// Under the dither: walkers, vehicles and their parts are hit or missed per cell with no soft
// edges, so a moving outline flips each cell once; their colours are flat per part; nothing else
// moves except the slow window lights, the signals and the weather. No shimmer.
//
// The passage is the window's pitch: raised toward the skyline at the start of the entrance and
// coming down onto the crossing, raised again as the scene leaves (STREET_TILT_*, the twin of sim.ts's
// passageTilt; the pointer and the rain's vanishing point follow it). Raised, the view reaches the
// roofs and over them the sky and the city beyond (streetBeyond: two ranks of hazy towers whose
// windows light at dusk), and the far end of the avenue and the side street fade into the haze. All of
// it is gated on the tilt, which is exactly 0 at rest.
//
// Knobs: K_signs, K_windows (the city), K_mark (the zebra M), K_time, K_cycle, K_stars and K_moon (the
// shared stars and the moon in its phase, SKY_MOON_PHASE, as the windows and wet street mirror the
// sky), K_rain, K_snow, K_fog, K_wind; the crowd, traffic and lights are the simulation's.
import { glslFloat } from "../../shaders/glsl.ts";
import { Random } from "../../sims/random.ts";
import {
  BEAM_REACH,
  BIKE_BEAM_REACH,
  CAM_H,
  CAM_X,
  CORNER_RADIUS,
  CROSS_HALF,
  CROSS_N,
  CROSS_WE,
  DIAG_FAR,
  DIAG_FAR_Z,
  DIAG_NEAR,
  FACADE_FAR,
  FACADE_NEAR,
  FOCAL,
  KERB_FAR,
  KERB_NEAR,
  KIND_BIKE,
  KIND_CHILD,
  KIND_KEI,
  KIND_PORTER,
  KIND_TAXI,
  LAMPS,
  LANE_EB_BIKE,
  LANE_EB_IN,
  LANE_EB_OUT,
  LANE_NB,
  LANE_SB,
  LANE_WB_BIKE,
  LANE_WB_IN,
  LANE_WB_OUT,
  MARK_APEX_Z,
  PITCH,
  SHAPES,
  SIDE_FACADE,
  SIDE_KERB,
  SIGNAL_POLES,
  STOP_EB,
  STOP_SB,
  STOP_WB,
  TILE,
  TILE_BODIES,
  TILE_LIGHTS,
  TILE_TEXELS,
  TILE_X0,
  TILE_Z0,
  TILES_X,
  TILES_Z,
  TILT_ARRIVE,
  TILT_IN,
  TILT_OUT,
  VENDING,
  Z_REF,
  AVENUE_MID,
} from "./sim.ts";

/** A number as a GLSL float literal (rounded to 0.1 mm, always with a decimal point). */
const f = (value: number): string => {
  const text = String(Math.round(value * 1e4) / 1e4);
  return text.includes(".") ? text : `${text}.0`;
};

// ---- The city: the buildings along the four facades ----

/** Ground floor shops (STREET_SHOP_* below). */
const KONBINI = 0;
const IZAKAYA = 1;
const DRUGSTORE = 2;
const CAFE = 3;
const BOUTIQUE = 4;
const SHUTTER = 5;
const BAR = 6;
const KARAOKE = 7;

/** One building's stretch of a facade: from u0 to u1 metres from the corner; its roof (m), wall tone
 *  (STREET_TONE), shop, blade sign (0: none, else STREET_SIGN index + 1) and the sign's top (m). */
interface Building {
  readonly u0: number;
  readonly u1: number;
  readonly height: number;
  readonly tone: number;
  readonly shop: number;
  readonly sign: number;
  readonly signTop: number;
  readonly seed: number;
}

/** Buildings a facade holds at most (the shader's lookup loop). */
const PER_FACADE = 10;
/** How far the far blocks and the side street's walls are built out (m from the corners). */
const AVENUE_LENGTH = 46;
const SIDE_LENGTH = 74;

/** Shops along the avenue and up the side street (a backstreet of bars), by cumulative share. */
type ShopShares = readonly (readonly [number, number])[];
const AVENUE_SHOPS: ShopShares = [
  [0.2, DRUGSTORE],
  [0.38, CAFE],
  [0.58, BOUTIQUE],
  [0.7, IZAKAYA],
  [0.8, SHUTTER],
  [0.9, KARAOKE],
  [1.0, BAR],
];
const SIDE_SHOPS: ShopShares = [
  [0.32, IZAKAYA],
  [0.54, BAR],
  [0.68, SHUTTER],
  [0.78, CAFE],
  [0.86, KARAOKE],
  [0.92, DRUGSTORE],
  [1.0, BOUTIQUE],
];

/** A facade's row of buildings after its corner one, generated once from a fixed seed. */
function buildRow(random: Random, corner: Building, length: number, side: boolean): Building[] {
  const row = [corner];
  let u = corner.u1;
  while (u < length && row.length < PER_FACADE) {
    const width = 5 + 5.5 * random.next();
    const r = random.next();
    // Mostly tiled and concrete fronts; now and then a dark glass office tower.
    const tone =
      random.next() < 0.1 ? 5 : ([0, 1, 2, 3, 4, 6, 7][Math.floor(random.next() * 7)] ?? 1);
    const pick = random.next();
    const shops = side ? SIDE_SHOPS : AVENUE_SHOPS;
    const shop = shops.find(([share]) => pick <= share)?.[1] ?? SHUTTER;
    const sign = random.next() < (side ? 0.85 : 0.65) ? 1 + Math.floor(random.next() * 8) : 0;
    row.push({
      u0: u,
      u1: u + width,
      height: 11 + 28 * r * r,
      tone,
      shop,
      sign,
      signTop: (side ? 6.4 : 7.2) + 2.4 * random.next(),
      seed: random.next(),
    });
    u += width;
  }
  return row;
}

const cityRandom = new Random(0x0c17e5);
/** The left corner: a ramen shop under red lanterns, its sign turning the corner. */
const RAMEN: Building = {
  u0: 0,
  u1: 8.5,
  height: 26,
  tone: 3,
  shop: IZAKAYA,
  sign: 2,
  signTop: 8.8,
  seed: 0.37,
};
/** The right corner: the konbini, glass all along both fronts. */
const KONBINI_CORNER: Building = {
  u0: 0,
  u1: 12,
  height: 19,
  tone: 4,
  shop: KONBINI,
  sign: 0,
  signTop: 0,
  seed: 0.61,
};
const FACADES: readonly (readonly Building[])[] = [
  buildRow(cityRandom, RAMEN, AVENUE_LENGTH, false),
  buildRow(cityRandom, KONBINI_CORNER, AVENUE_LENGTH, false),
  buildRow(cityRandom, { ...RAMEN, u1: 7.5 }, SIDE_LENGTH, true),
  buildRow(cityRandom, { ...KONBINI_CORNER, u1: 9 }, SIDE_LENGTH, true),
];
const BUILDINGS = FACADES.flat();
const firsts = FACADES.map((_, i) => FACADES.slice(0, i).reduce((sum, row) => sum + row.length, 0));

const buildingA = BUILDINGS.map(
  (b) => `vec4(${f(b.u0)}, ${f(b.u1)}, ${f(b.height)}, ${f(b.tone)})`,
).join(",\n  ");
const buildingB = BUILDINGS.map(
  (b) => `vec4(${f(b.shop)}, ${f(b.sign)}, ${f(b.signTop)}, ${f(b.seed)})`,
).join(",\n  ");

// ---- Street furniture ----

const lamps = LAMPS.map(
  (l) => `vec4(${f(l.x)}, ${f(l.z)}, ${f(l.height)}, ${l.warm ? "1.0" : "0.0"})`,
).join(", ");
const lampHeads = LAMPS.map((l) => `vec2(${f(l.hx)}, ${f(l.hz)})`).join(", ");
const poles = SIGNAL_POLES.map((p) => `vec3(${f(p.x)}, ${f(p.z)}, ${f(p.height)})`).join(", ");
const vending = VENDING.map((v) => `vec4(${v.map(f).join(", ")})`).join(", ");

/** Car signal heads: hung from a signal pole's arm (pole index), centre, facing (toward the traffic
 *  they hold), and the light they show (0 avenue, 1 side street). */
const CAR_HEADS = [
  { pole: 0, x: -12.4, z: 26.6, fx: 1, fz: 0, group: 0 }, // westbound, on the near left pole
  { pole: 3, x: 12.4, z: 35.4, fx: -1, fz: 0, group: 0 }, // eastbound, on the far right pole
  { pole: 1, x: 4.8, z: 21.55, fx: 0, fz: 1, group: 1 }, // the side street, on the near right pole
] as const;
/** Walk signals on the poles, facing across their crosswalks (x, z, facing). */
const WALK_HEADS = [
  { x: -12.4, z: 40.22, fx: 0, fz: -1 },
  { x: 12.4, z: 40.22, fx: 0, fz: -1 },
  { x: -12.4, z: 21.78, fx: 0, fz: 1 },
  { x: 12.4, z: 21.78, fx: 0, fz: 1 },
  { x: -6.22, z: 47.6, fx: 1, fz: 0 },
  { x: 6.22, z: 47.6, fx: -1, fz: 0 },
] as const;
const carHeads = CAR_HEADS.map((h) => `vec4(${f(h.x)}, ${f(h.z)}, ${f(h.fx)}, ${f(h.fz)})`).join(
  ", ",
);
const carHeadMeta = CAR_HEADS.map((h) => `ivec2(${h.pole}, ${h.group})`).join(", ");
const walkHeads = WALK_HEADS.map((h) => `vec4(${f(h.x)}, ${f(h.z)}, ${f(h.fx)}, ${f(h.fz)})`).join(
  ", ",
);

/** Manholes on the road: x, z, radius. */
const MANHOLES = [
  [-17.5, 30.2, 0.32],
  [4.6, 35.2, 0.3],
  [16.0, 26.1, 0.32],
  [-2.2, 57.0, 0.3],
  [-29.0, 36.0, 0.3],
] as const;
const manholes = MANHOLES.map((m) => `vec3(${m.map(f).join(", ")})`).join(", ");

const sizes = SHAPES.map(
  (s) => `vec4(${f(s.length)}, ${f(s.width)}, ${f(s.body)}, ${f(s.top)})`,
).join(", ");
const cabins = SHAPES.map((s) => `vec2(${f(s.cabinBack)}, ${f(s.cabinFront)})`).join(", ");

export const streetGlsl = `
// ---- The view and the street (sim.ts) ----
const float STREET_CAM_X = ${f(CAM_X)};
const float STREET_CAM_H = ${f(CAM_H)};
const float STREET_PITCH = ${f(PITCH)};
const float STREET_FOCAL = ${f(FOCAL)};
const float STREET_TILT_IN = ${glslFloat(TILT_IN)};
const float STREET_TILT_OUT = ${glslFloat(TILT_OUT)};
const float STREET_TILT_ARRIVE = ${glslFloat(TILT_ARRIVE)};
const float STREET_ZREF = ${f(Z_REF)};
const float STREET_KERB_NEAR = ${f(KERB_NEAR)};
const float STREET_KERB_FAR = ${f(KERB_FAR)};
const float STREET_FACADE_NEAR = ${f(FACADE_NEAR)};
const float STREET_FACADE_FAR = ${f(FACADE_FAR)};
const float STREET_SIDE_KERB = ${f(SIDE_KERB)};
const float STREET_SIDE_FACADE = ${f(SIDE_FACADE)};
const float STREET_CORNER = ${f(CORNER_RADIUS)};
const float STREET_MID = ${f(AVENUE_MID)};
const float STREET_EB_IN = ${f(LANE_EB_IN)};
const float STREET_EB_OUT = ${f(LANE_EB_OUT)};
const float STREET_EB_BIKE = ${f(LANE_EB_BIKE)};
const float STREET_WB_IN = ${f(LANE_WB_IN)};
const float STREET_WB_OUT = ${f(LANE_WB_OUT)};
const float STREET_WB_BIKE = ${f(LANE_WB_BIKE)};
const float STREET_SB = ${f(LANE_SB)};
const float STREET_NB = ${f(LANE_NB)};
const float STREET_STOP_EB = ${f(STOP_EB)};
const float STREET_STOP_WB = ${f(STOP_WB)};
const float STREET_STOP_SB = ${f(STOP_SB)};
const float STREET_CROSS_WE = ${f(CROSS_WE)};
const float STREET_CROSS_HALF = ${f(CROSS_HALF)};
const float STREET_CROSS_N = ${f(CROSS_N)};
const float STREET_DIAG_NEAR = ${f(DIAG_NEAR)};
const float STREET_DIAG_FAR = ${f(DIAG_FAR)};
const float STREET_DIAG_FAR_Z = ${f(DIAG_FAR_Z)};
const float STREET_MARK_APEX = ${f(MARK_APEX_Z)};
const float STREET_BEAM = ${f(BEAM_REACH)};
const float STREET_BIKE_BEAM = ${f(BIKE_BEAM_REACH)};
const int STREET_LAMPS = ${LAMPS.length};
const vec4 STREET_LAMP[${LAMPS.length}] = vec4[${LAMPS.length}](${lamps}); // pole x, z, height, sodium
const vec2 STREET_LAMP_HEAD[${LAMPS.length}] = vec2[${LAMPS.length}](${lampHeads});
const int STREET_POLES = ${SIGNAL_POLES.length};
const vec3 STREET_POLE[${SIGNAL_POLES.length}] = vec3[${SIGNAL_POLES.length}](${poles}); // x, z, height
const vec4 STREET_VENDING[${VENDING.length}] = vec4[${VENDING.length}](${vending}); // x0, x1, z0, z1
const vec4 STREET_CAR_HEAD[${CAR_HEADS.length}] = vec4[${CAR_HEADS.length}](${carHeads}); // x, z, facing
const ivec2 STREET_CAR_HEAD_META[${CAR_HEADS.length}] = ivec2[${CAR_HEADS.length}](${carHeadMeta}); // pole, light
const vec4 STREET_WALK_HEAD[${WALK_HEADS.length}] = vec4[${WALK_HEADS.length}](${walkHeads}); // x, z, facing
const vec3 STREET_MANHOLE[${MANHOLES.length}] = vec3[${MANHOLES.length}](${manholes});
const int STREET_KIND_CHILD = ${KIND_CHILD};
const int STREET_KIND_BIKE = ${KIND_BIKE};
const int STREET_KIND_TAXI = ${KIND_TAXI};
const int STREET_KIND_KEI = ${KIND_KEI};
const int STREET_KIND_PORTER = ${KIND_PORTER};
const vec4 STREET_SIZE[${SHAPES.length}] = vec4[${SHAPES.length}](${sizes}); // length, width, body, top
const vec2 STREET_CABIN[${SHAPES.length}] = vec2[${SHAPES.length}](${cabins}); // cabin back, front
const float STREET_TILE_X0 = ${f(TILE_X0)};
const float STREET_TILE_Z0 = ${f(TILE_Z0)};
const float STREET_TILE = ${f(TILE)};
const int STREET_TILES_X = ${TILES_X};
const int STREET_TILES_Z = ${TILES_Z};
const int STREET_TILE_TEXELS = ${TILE_TEXELS};
const int STREET_BODY_TEXELS = ${TILE_BODIES / 4}; // the bodies' slots, four per texel
const int STREET_LIGHT_TEXELS = ${TILE_LIGHTS / 4}; // then the lamps'

// ---- The city ----
// Facades: 0 the far left block along the avenue (x = -SIDE_FACADE - u, z = FACADE_FAR), 1 the far
// right block (x = SIDE_FACADE + u), 2 the side street's left wall (x = -SIDE_FACADE, z =
// FACADE_FAR + u), 3 its right wall. The corner buildings turn the corners.
const int STREET_BLD_MAX = ${PER_FACADE};
const int STREET_BLD_FIRST[4] = int[4](${firsts.join(", ")});
const int STREET_BLD_COUNT[4] = int[4](${FACADES.map((row) => row.length).join(", ")});
const vec4 STREET_BLD_A[${BUILDINGS.length}] = vec4[${BUILDINGS.length}](
  ${buildingA}); // u0, u1, roof, tone
const vec4 STREET_BLD_B[${BUILDINGS.length}] = vec4[${BUILDINGS.length}](
  ${buildingB}); // shop, blade sign (0 none), its top, seed
const vec3 STREET_TONE[8] = vec3[8](
  vec3(0.56, 0.5, 0.42), vec3(0.46, 0.46, 0.46), vec3(0.52, 0.47, 0.43), vec3(0.3, 0.23, 0.19),
  vec3(0.7, 0.69, 0.66), vec3(0.1, 0.12, 0.15), vec3(0.5, 0.34, 0.28), vec3(0.36, 0.4, 0.45));
// Sign colours: warm whites, reds, ambers and a few cooler panels, as they glow at night.
const vec3 STREET_SIGN[8] = vec3[8](
  vec3(1.0, 0.94, 0.82), vec3(1.0, 0.32, 0.2), vec3(1.0, 0.74, 0.26), vec3(0.55, 0.8, 1.0),
  vec3(1.0, 0.5, 0.6), vec3(0.5, 1.0, 0.62), vec3(1.0, 0.56, 0.2), vec3(1.0, 0.88, 0.46));
const int STREET_SHOP_KONBINI = ${KONBINI};
const int STREET_SHOP_IZAKAYA = ${IZAKAYA};
const int STREET_SHOP_DRUGSTORE = ${DRUGSTORE};
const int STREET_SHOP_CAFE = ${CAFE};
const int STREET_SHOP_BOUTIQUE = ${BOUTIQUE};
const int STREET_SHOP_SHUTTER = ${SHUTTER};
const int STREET_SHOP_BAR = ${BAR};
const int STREET_SHOP_KARAOKE = ${KARAOKE};
// Signal colours: the avenue's and side street's green (Japan's blue-green), amber, red.
const vec3 STREET_GO = vec3(0.1, 1.0, 0.72);
const vec3 STREET_AMBER = vec3(1.0, 0.62, 0.08);
const vec3 STREET_STOP = vec3(1.0, 0.1, 0.07);

// Umbrellas (0 clear vinyl, see-through), coats, hair.
const vec3 STREET_BROLLY[10] = vec3[10](
  vec3(0.86, 0.9, 0.93), vec3(0.06, 0.06, 0.07), vec3(0.08, 0.12, 0.32), vec3(0.78, 0.1, 0.12),
  vec3(0.96, 0.78, 0.1), vec3(0.12, 0.44, 0.26), vec3(0.42, 0.7, 0.92), vec3(0.74, 0.63, 0.48),
  vec3(0.95, 0.55, 0.68), vec3(0.1, 0.14, 0.34));
// Coats: black, cream, navy, camel, red, grey, denim, mustard.
const vec3 STREET_COAT[8] = vec3[8](
  vec3(0.07, 0.07, 0.08), vec3(0.82, 0.8, 0.74), vec3(0.14, 0.18, 0.34), vec3(0.68, 0.52, 0.32),
  vec3(0.66, 0.16, 0.16), vec3(0.48, 0.49, 0.5), vec3(0.36, 0.5, 0.68), vec3(0.58, 0.52, 0.24));
const vec3 STREET_HAIR[4] = vec3[4](vec3(0.03, 0.025, 0.025), vec3(0.11, 0.07, 0.05), vec3(0.32, 0.2, 0.12), vec3(0.6, 0.6, 0.58));

const float STREET_TAU = 6.2831853;
const int STREET_K_GROUND = 0;
const int STREET_K_FACADE = 1;
const int STREET_K_SIGN = 2;
const int STREET_K_AWNING = 3;
const int STREET_K_VENDING = 4;
const int STREET_K_METAL = 5;
const int STREET_K_SIGNAL = 6;
const int STREET_K_AGENT = 7;

// What a ray met: distance, what (STREET_K_*), which, the normal, its own coordinates, its colour
// before lighting, the light it gives off, how it shines when wet, whether snow settles there.
struct StreetHit {
  float t;
  int kind;
  int id;
  vec3 n;
  vec3 q;
  vec3 albedo;
  vec3 emit;
  float gloss;
  float snow;
};

StreetHit streetMiss() {
  StreetHit h;
  h.t = 1e9;
  h.kind = -1;
  h.id = -1;
  h.n = vec3(0.0, 1.0, 0.0);
  h.q = vec3(0.0);
  h.albedo = vec3(0.0);
  h.emit = vec3(0.0);
  h.gloss = 0.0;
  h.snow = 0.0;
  return h;
}

// The hour, set once per cell by streetHour.
Sky streetSky;
float streetDark;     // 0 day .. 1 night (a heavy sky darkens the day)
float streetOver;     // 0 clear .. 1 overcast
float streetStorm;    // the rain's or snow's weight 0..1
vec3 streetBounce;   // the city's own warm light bounced about at night
float streetWet;      // uWeather.x
float streetLying;    // uWeather.y
float streetLit;      // share of the windows lit
float streetTm;       // the motion clock (uMotionTime)
vec3 streetAmbient;   // sky light plus the city's own bounce
vec3 streetSun;       // direct sun
vec3 streetDeck;      // the cloud base
vec3 streetG;         // where the cell's ray meets the street
vec2 streetLean;      // how the ray's ground point moves per metre up (toward the eye)
vec4 streetSignal[3]; // avenue (green, amber, red), side street, walk (green man, red man, progress)
float streetTilt;     // the passage: how far the camera is raised above its rest pitch (rad), 0 at rest

// ---- Small helpers ----

// 1 between a and b, edges softened over w.
float streetBand(float x, float a, float b, float w) {
  return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x);
}

// 1 / d without dividing by zero.
vec3 streetInv(vec3 d) {
  return (step(vec3(0.0), d) * 2.0 - 1.0) / max(abs(d), vec3(1e-6));
}

// Ray against an axis-aligned box: entry distance (-1: missed or inside), n the face it enters.
float streetBox(vec3 ro, vec3 rd, vec3 inv, vec3 lo, vec3 hi, out vec3 n) {
  vec3 t0 = (lo - ro) * inv;
  vec3 t1 = (hi - ro) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  float enter = max(max(tn.x, tn.y), tn.z);
  float leave = min(min(tf.x, tf.y), tf.z);
  n = vec3(0.0, 1.0, 0.0);
  if (enter > leave || enter < 0.0) return -1.0;
  if (tn.x >= tn.y && tn.x >= tn.z) n = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tn.y >= tn.z) n = vec3(0.0, -sign(rd.y), 0.0);
  else n = vec3(0.0, 0.0, -sign(rd.z));
  return enter;
}

float streetSphere(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - dot(oc, oc) + r * r;
  return h < 0.0 ? -1.0 : -b - sqrt(h);
}

// Ray (o, d in the ellipsoid's own axes) against an ellipsoid of radii r at the origin.
float streetEllipsoid(vec3 o, vec3 d, vec3 r, out vec3 n) {
  vec3 oc = o / r;
  vec3 dc = d / r;
  float a = dot(dc, dc);
  float b = dot(oc, dc);
  float h = b * b - a * (dot(oc, oc) - 1.0);
  n = vec3(0.0, 1.0, 0.0);
  if (h < 0.0) return -1.0;
  float t = (-b - sqrt(h)) / a;
  n = normalize((o + d * t) / (r * r));
  return t;
}

// Ray against an upright cylinder (axis at c, from y0 to y1), seen from above: side or top.
float streetPillar(vec3 ro, vec3 rd, vec2 c, float r, float y0, float y1) {
  vec2 oc = ro.xz - c;
  float a = max(dot(rd.xz, rd.xz), 1e-8);
  float b = dot(oc, rd.xz);
  float h = b * b - a * (dot(oc, oc) - r * r);
  if (h < 0.0) return -1.0;
  float t = (-b - sqrt(h)) / a;
  float y = ro.y + rd.y * t;
  if (y > y1) {
    float tc = (y1 - ro.y) / rd.y;
    vec2 q = ro.xz + rd.xz * tc - c;
    return dot(q, q) < r * r ? tc : -1.0;
  }
  return y < y0 ? -1.0 : t;
}

// Ray against a capsule from a to b (after Inigo Quilez).
float streetCapsule(vec3 ro, vec3 rd, vec3 a, vec3 b, float r) {
  vec3 ba = b - a;
  vec3 oa = ro - a;
  float baba = dot(ba, ba);
  float bard = dot(ba, rd);
  float baoa = dot(ba, oa);
  float rdoa = dot(rd, oa);
  float oaoa = dot(oa, oa);
  float qa = baba - bard * bard;
  float qb = baba * rdoa - baoa * bard;
  float qc = baba * oaoa - baoa * baoa - r * r * baba;
  float h = qb * qb - qa * qc;
  if (h < 0.0) return -1.0;
  float t = (-qb - sqrt(h)) / qa;
  float y = baoa + t * bard;
  if (y > 0.0 && y < baba) return t;
  vec3 oc = y <= 0.0 ? oa : ro - b;
  float pb = dot(rd, oc);
  float pc = dot(oc, oc) - r * r;
  float ph = pb * pb - pc;
  return ph > 0.0 ? -pb - sqrt(ph) : -1.0;
}

// How close the cell's ray passes (in plan, m) to an upright axis at c between the street and
// height top: a cheap test before tracing anything standing there.
float streetNear(vec2 c, float top) {
  float y = clamp(dot(c - streetG.xz, streetLean) / max(dot(streetLean, streetLean), 1e-6), 0.0, top);
  return length(streetG.xz + streetLean * y - c);
}

// A light at L seen along the ray: a tight core and a soft halo (r: halo radius, m), dimmed where
// something stands in front of it.
float streetGlow(vec3 ro, vec3 rd, vec3 L, float r, float tHit) {
  vec3 oc = L - ro;
  float tl = dot(oc, rd);
  vec3 off = oc - rd * tl;
  float d2 = dot(off, off);
  float shown = tl < tHit + 0.35 ? 1.0 : 0.3;
  return (exp(-d2 / 0.012) * 2.2 * shown + exp(-d2 / (r * r)) * 0.4) * step(0.0, tl);
}

// A light at L mirrored in wet ground, at ground point g: its image sits where the ray to its
// mirror twin crosses the street, and roughness draws it out toward the eye into a long streak
// (rough asphalt) or keeps it a sharp spot (a puddle). rough 0 mirror .. ~0.35 wet asphalt.
float streetStreak(vec2 g, vec3 L, float rough) {
  vec2 eye = vec2(STREET_CAM_X, 0.0);
  vec2 m = eye + (L.xz - eye) * (STREET_CAM_H / (STREET_CAM_H + L.y));
  vec2 e = normalize(m - eye + vec2(1e-5));
  vec2 d = g - m;
  float along = -dot(d, e);
  float lat = dot(d, vec2(-e.y, e.x));
  float r = clamp(rough * 2.8, 0.0, 1.0);
  float len = mix(0.4, 7.0 + 0.6 * L.y, r);
  float wid = mix(0.07, 0.2, r) + 0.012 * max(along, 0.0) * r;
  float a = along > 0.0 ? exp(-along / len) : exp(along / (0.12 + 0.5 * r));
  // Broken into wavering dashes by the asphalt, fixed to the street.
  float grain = mix(1.0, 0.35 + 1.1 * vnoise(vec2(g.x * 3.1, g.y * 1.3) + vec2(7.0, 3.0)), r);
  return a * exp(-lat * lat / (wid * wid)) * grain;
}

// Lettering: characters on a grid of 4 x 4 strokes switched by hash, one character per unit with a
// gap round it. blur: units per cell; when a stroke spans fewer than ~1.5 cells it fades to its mean.
float streetGlyphs(vec2 p, float seed, float blur) {
  vec2 g = floor(p);
  vec2 q = fract(p);
  float inside = step(0.14, q.x) * step(q.x, 0.86) * step(0.1, q.y) * step(q.y, 0.9);
  vec2 s = floor((q - vec2(0.14, 0.1)) / vec2(0.72, 0.8) * 4.0);
  float ink = inside * step(0.52, hash12(g * vec2(7.13, 3.71) + s * vec2(1.7, 9.3) + seed * 13.0));
  return mix(ink, 0.3, smoothstep(0.1, 0.28, blur));
}

// ---- Buildings ----

int streetBuildingAt(int f, float u) {
  int first = STREET_BLD_FIRST[f];
  int count = STREET_BLD_COUNT[f];
  int found = first + count - 1;
  for (int i = 0; i < STREET_BLD_MAX; i++) {
    if (i >= count) break;
    if (u < STREET_BLD_A[first + i].y) {
      found = first + i;
      break;
    }
  }
  return found;
}

// A shop's window light by its kind.
vec3 streetShopLight(float shop, float seed) {
  int s = int(shop + 0.5);
  vec3 c = s == STREET_SHOP_KONBINI ? vec3(0.92, 0.98, 1.0) * 1.8
         : s == STREET_SHOP_IZAKAYA ? vec3(1.0, 0.6, 0.3) * 0.95
         : s == STREET_SHOP_DRUGSTORE ? vec3(0.95, 1.0, 0.94) * 1.4
         : s == STREET_SHOP_CAFE ? vec3(1.0, 0.68, 0.38) * 0.95
         : s == STREET_SHOP_BOUTIQUE ? vec3(1.0, 0.88, 0.72) * 1.15
         : s == STREET_SHOP_SHUTTER ? vec3(0.0)
         : s == STREET_SHOP_BAR ? vec3(1.0, 0.55, 0.62) * 0.5
         : vec3(1.0, 0.62, 0.72) * 1.05;
  return c * (0.82 + 0.36 * fract(seed * 17.3));
}

// A fascia's colour as it glows from a distance, letters and all, by the shop's kind.
vec3 streetFasciaGlow(int shop) {
  return shop == STREET_SHOP_KONBINI ? vec3(0.42, 0.72, 0.82)
       : shop == STREET_SHOP_IZAKAYA ? vec3(0.5, 0.38, 0.28) * 0.55
       : shop == STREET_SHOP_DRUGSTORE ? vec3(1.0, 0.82, 0.2)
       : shop == STREET_SHOP_CAFE ? vec3(0.4, 0.42, 0.3) * 0.4
       : shop == STREET_SHOP_BOUTIQUE ? vec3(0.92, 0.9, 0.86)
       : shop == STREET_SHOP_SHUTTER ? vec3(0.0)
       : shop == STREET_SHOP_BAR ? vec3(1.0, 0.4, 0.6) * 0.3
       : vec3(0.95, 0.5, 0.62);
}

// How much of a light spanning y0..y1 up a wall is seen at height y: all of it inside, fading over
// "below" metres under it and "above" over it.
float streetReach(float y, float y0, float y1, float below, float above) {
  return y < y0 ? exp((y - y0) / below) : y < y1 ? 1.0 : exp((y1 - y) / above);
}

// The bright band of facade f at u, as glows without lettering: the shop window, the fascia, the
// red lanterns, the blade sign and the flat sign up the wall. Each is seen at height y through
// streetReach: a short reach both ways makes the soft bloom round them; a long reach above is
// their reflection in the wet street, drawn out toward the eye. bx softens it along the wall.
vec3 streetLitBand(int f, float u, float y, float bx, float below, float above) {
  int b = streetBuildingAt(f, u);
  vec4 A = STREET_BLD_A[b];
  vec4 B = STREET_BLD_B[b];
  float x = u - A.x;
  float w = A.y - A.x;
  int shop = int(B.x + 0.5);
  float glow = 0.2 + K_signs;
  vec3 c = streetShopLight(B.x, B.w) * (0.35 + 0.75 * K_signs) * streetBand(x, 0.35, w - 0.35, bx) * streetReach(y, 0.3, 2.78, below, above);
  c += streetFasciaGlow(shop) * glow * streetBand(x, 0.12, w - 0.12, bx) * streetReach(y, 2.88, 3.62, below, above);
  if (shop == STREET_SHOP_IZAKAYA) {
    float mid = w * 0.5;
    float lanterns = streetBand(x, mid - 1.2, mid - 0.8, bx) + streetBand(x, mid + 0.8, mid + 1.2, bx);
    c += vec3(1.0, 0.3, 0.12) * 1.3 * glow * lanterns * streetReach(y, 1.87, 2.43, below, above);
  }
  if (B.y > 0.5) {
    float us = f < 2 ? 0.55 : 0.75;
    float len = 3.2 + 1.2 * fract(B.w * 5.3);
    vec3 sc = mix(STREET_SIGN[int(B.y - 0.5)], vec3(1.0), 0.3) * glow * 1.2;
    c += sc * streetBand(x, us - 0.45, us + 0.45, bx) * streetReach(y, B.z - len, B.z, below, above);
  }
  if (fract(B.w * 7.7) < 0.35) {
    float top = min(A.z - 0.8, 13.5);
    vec3 sc = mix(STREET_SIGN[int(fract(B.w * 5.3) * 8.0)], vec3(1.0), 0.3) * glow;
    c += sc * streetBand(x, w - 1.25, w - 0.35, bx) * streetReach(y, 4.4, top, below, above);
  }
  return c;
}

bool streetHasAwning(vec4 B) {
  int s = int(B.x + 0.5);
  return s == STREET_SHOP_CAFE || ((s == STREET_SHOP_IZAKAYA || s == STREET_SHOP_BOUTIQUE || s == STREET_SHOP_KARAOKE) && fract(B.w * 5.7) < 0.7);
}

// A blade sign's face: a colour panel with a column of characters and a frame. s.x across 0..1,
// s.y down from the top 0..1; len its height (m); blur metres per cell.
vec3 streetBladeFace(vec2 s, float len, float colour, float seed, float blur) {
  vec3 c = STREET_SIGN[int(colour + 0.5)];
  float rows = max(floor(len / 0.62), 2.0);
  float ink = streetGlyphs(vec2(0.05 + s.x * 0.9, s.y * rows + 0.1), seed, blur / 0.6);
  vec3 face = fract(seed * 3.1) < 0.5 ? mix(vec3(1.0, 0.96, 0.88), c * 0.9, ink) : mix(c, vec3(1.0, 0.97, 0.92), ink);
  float frame = max(smoothstep(0.84, 0.94, abs(s.x * 2.0 - 1.0)), smoothstep(0.95, 0.99, abs(s.y * 2.0 - 1.0)));
  return mix(face, c * 0.3, frame);
}

// What facade f looks like at u metres along it and y up: its colour (to be lit), the light it gives
// off, and how much of it is glass (which mirrors the sky). blur: metres a cell spans here (x along,
// y up). Seen mirrored in the wet street (mirrored), the blade signs hanging off it are drawn flat on
// it, and a long vertical blur smears every light into a streak.
void streetFacade(int f, float u, float y, vec2 blur, bool mirrored, out vec3 albedo, out vec3 emit, out float glass) {
  int b = streetBuildingAt(f, u);
  vec4 A = STREET_BLD_A[b];
  vec4 B = STREET_BLD_B[b];
  float seed = B.w;
  float x = u - A.x;
  float w = A.y - A.x;
  int shop = int(B.x + 0.5);
  int tone = int(A.w + 0.5);
  bool tower = tone == 5;
  float fine = 1.0 - smoothstep(0.03, 0.1, max(blur.x, blur.y));
  vec3 wall = STREET_TONE[tone] * (0.92 + 0.08 * fine * hash12(floor(vec2(x / 0.45, y / 0.3)) + seed * 37.0));
  float seam = 1.0 - streetBand(x, 0.08, w - 0.08, blur.x);
  albedo = wall * (1.0 - 0.45 * seam);
  emit = vec3(0.0);
  glass = 0.0;
  float glow = 0.2 + K_signs;
  if (y < 3.7) {
    // The shop: its window lit from inside, the fascia over it.
    float win = streetBand(x, 0.35, w - 0.35, blur.x) * streetBand(y, 0.28, 2.78, blur.y);
    float fascia = streetBand(x, 0.12, w - 0.12, blur.x) * streetBand(y, 2.88, 3.62, blur.y);
    if (shop == STREET_SHOP_SHUTTER) {
      float ribs = 0.85 + 0.15 * fine * step(0.5, fract(y / 0.1));
      albedo = mix(albedo, vec3(0.4, 0.41, 0.42) * ribs, win);
      albedo = mix(albedo, vec3(0.16, 0.16, 0.17), fascia);
      return;
    }
    vec3 inside = streetShopLight(B.x, seed) * (0.35 + 0.75 * K_signs);
    float mull = 1.0 - 0.7 * fine * (1.0 - streetBand(fract(x / 1.6), 0.03, 0.97, blur.x / 1.6));
    float shelves = shop == STREET_SHOP_KONBINI || shop == STREET_SHOP_DRUGSTORE ? 1.0 - 0.35 * fine * step(0.72, fract(y / 0.42)) : 1.0;
    if (shop == STREET_SHOP_KARAOKE) inside *= 0.7 + 0.6 * vec3(0.5 + 0.5 * sin(x * 1.3), 0.5 + 0.5 * sin(x * 1.3 + 2.1), 1.0);
    emit += inside * win * mull * shelves;
    albedo = mix(albedo, vec3(0.04, 0.045, 0.05), win);
    glass = win * 0.45;
    // The lettering on the fascia, up to six characters.
    float chars = min(floor((w - 0.8) / 0.52), 6.0);
    float text = streetGlyphs(vec2((x - 0.4) / 0.52, (y - 2.94) / 0.62), seed * 3.0, blur.x / 0.52) * streetBand(x, 0.4, 0.4 + chars * 0.52, blur.x);
    vec3 face;
    vec3 ink;
    float lit = 1.0;
    if (shop == STREET_SHOP_KONBINI) {
      // The chain's stripes: blue, white, green.
      face = y < 3.14 ? vec3(0.1, 0.35, 0.95) : y < 3.36 ? vec3(0.95, 0.97, 1.0) : vec3(0.1, 0.72, 0.32);
      ink = face;
    } else if (shop == STREET_SHOP_IZAKAYA) {
      face = vec3(0.22, 0.13, 0.07);
      ink = vec3(1.0, 0.95, 0.85);
      lit = 0.55;
    } else if (shop == STREET_SHOP_DRUGSTORE) {
      face = vec3(1.0, 0.85, 0.12);
      ink = vec3(0.1, 0.12, 0.35);
    } else if (shop == STREET_SHOP_CAFE) {
      face = vec3(0.07, 0.2, 0.13);
      ink = vec3(0.95, 0.88, 0.7);
      lit = 0.4;
    } else if (shop == STREET_SHOP_BOUTIQUE) {
      face = vec3(0.95, 0.93, 0.9);
      ink = vec3(0.08, 0.08, 0.1);
    } else if (shop == STREET_SHOP_BAR) {
      face = vec3(0.04, 0.04, 0.05);
      ink = vec3(1.0, 0.35, 0.75);
    } else {
      face = vec3(0.9, 0.38, 0.55);
      ink = vec3(1.0, 0.95, 0.96);
    }
    vec3 board = mix(face, ink, text);
    albedo = mix(albedo, board * 0.8, fascia);
    emit = mix(emit, board * lit * glow * 1.25 * (shop == STREET_SHOP_BAR ? text : 1.0), fascia);
    if (shop == STREET_SHOP_IZAKAYA) {
      // A pair of red paper lanterns by the door, and the noren hanging across it.
      float mid = w * 0.5;
      for (int i = 0; i < 2; i++) {
        vec2 lq = vec2(x - mid - (i == 0 ? -1.0 : 1.0), y - 2.15) / vec2(0.2, 0.28);
        float lantern = 1.0 - smoothstep(1.0 - blur.x * 6.0, 1.0, length(lq));
        float ribs = 0.8 + 0.2 * fine * step(0.35, fract(y / 0.08));
        emit = mix(emit, vec3(1.0, 0.3, 0.12) * 1.3 * glow * ribs * (1.0 - 0.4 * lq.x * lq.x), lantern);
        albedo = mix(albedo, vec3(0.6, 0.1, 0.06), lantern);
      }
      float noren = streetBand(x, mid - 0.75, mid + 0.75, blur.x) * streetBand(y, 1.72, 2.6, blur.y) * (1.0 - 0.8 * fine * (1.0 - streetBand(fract((x - mid) / 0.5), 0.04, 0.96, blur.x / 0.5)));
      float crest = 1.0 - smoothstep(0.17, 0.2, length(vec2(x - mid, y - 2.2)));
      albedo = mix(albedo, mix(vec3(0.07, 0.09, 0.22), vec3(0.85, 0.82, 0.75), crest), noren);
      emit *= 1.0 - noren;
      emit += inside * noren * 0.15;
    }
  } else if (y < A.z) {
    // Upper floors: a slab line at each floor, windows in bays (a glass tower is all glass); each
    // window lit or dark for minutes at a time, switching with a short fade now and then.
    float fy = y - 3.7;
    float fl = floor(fy / 3.3);
    float v = fy - fl * 3.3;
    float nb = max(1.0, floor(w / 2.3 + 0.5));
    float bay = w / nb;
    float bi = floor(x / bay);
    float bx = x - bi * bay;
    float wwin = tower ? streetBand(bx, 0.05, bay - 0.05, blur.x) * streetBand(v, 0.35, 3.15, blur.y)
                       : streetBand(bx, bay * 0.16, bay * 0.84, blur.x) * streetBand(v, 0.75, 2.55, blur.y);
    vec2 wid = vec2(bi + float(b) * 17.0, fl);
    float h = hash12(wid + 0.37);
    float period = 70.0 + 170.0 * hash12(wid + 5.1);
    float ph = streetTm / period + h * 3.0;
    float k = floor(ph);
    float was = step(hash12(wid + (k - 1.0) * 1.37), streetLit);
    float now = step(hash12(wid + k * 1.37), streetLit);
    // The switch spreads over a second, cell by cell against the dither, so each cell steps once.
    float on = mix(was, now, smoothstep(0.0, 1.2 / period, ph - k) > threshold(gl_FragCoord.xy + vec2(3.0, 7.0)) ? 1.0 : 0.0);
    vec3 wc = tower ? vec3(0.85, 0.92, 1.0) : h < 0.6 ? vec3(1.0, 0.72, 0.42) : h < 0.86 ? vec3(0.85, 0.9, 1.0) : vec3(0.5, 0.6, 1.0);
    emit += wc * on * wwin * (0.45 + 0.4 * fract(h * 13.1));
    albedo = mix(albedo, vec3(0.04, 0.05, 0.06), wwin);
    glass = wwin * (1.0 - 0.8 * on) * (tower ? 1.0 : 0.7);
    if (!tower) albedo = mix(albedo, albedo * 1.3 + 0.03, streetBand(v, 0.0, 0.28, blur.y));
    // A flat sign climbing the wall on some buildings.
    if (!mirrored && fract(seed * 7.7) < 0.35) {
      float top = min(A.z - 0.8, 13.5);
      float band = streetBand(x, w - 1.25, w - 0.35, blur.x) * streetBand(y, 4.4, top, blur.y);
      if (band > 0.0) {
        vec3 c = streetBladeFace(vec2((x - w + 1.25) / 0.9, (top - y) / (top - 4.4)), top - 4.4, floor(fract(seed * 5.3) * 8.0), seed * 2.3, blur.y);
        albedo = mix(albedo, c * 0.7, band);
        emit = mix(emit, c * glow * 0.9, band);
        glass *= 1.0 - band;
      }
    }
  }
  // Seen in the wet street, the shop front and the signs come from streetLitBand, drawn out into
  // streaks: here only the wall and the upper windows.
  if (mirrored && y < 3.7) emit = vec3(0.0);
}

// The sky, as the puddles and windows mirror it: overcast under rain, stars on a clear night.
vec3 streetSkyLight(vec3 dir) {
  vec3 c = skyColor(streetSky, dir);
  c += vec3(skyStars(streetSky, dir, K_stars)) * (1.0 - streetOver);
  return mix(c, streetDeck, streetOver * 0.92);
}

// The air at the horizon in a direction: what the far city and the end of the streets fade into.
vec3 streetHaze(vec3 d) {
  return streetSkyLight(normalize(vec3(d.x, 0.0, max(d.z, 1e-3))));
}

// One rank of far towers at distance D (m): the direction's azimuth picks a column of the rank, whose
// roof stands from lo up to lo + span metres. x is 1 where the ray, at that distance, is inside a
// tower; y the light of a window there (a coarse grid of lit ones, by the windows knob).
vec2 streetTowers(float az, float slope, float D, float freq, float lo, float span, float seed) {
  float h = hash12(vec2(floor(az * freq), seed));
  float y = STREET_CAM_H + slope * D;
  if (y > lo + span * h * h) return vec2(0.0);
  vec2 g = vec2(az * freq * 2.0, y / 4.0);
  vec2 fg = fract(g);
  float win = step(0.25, fg.x) * step(fg.x, 0.75) * step(0.3, fg.y) * step(fg.y, 0.7);
  float lit = step(hash12(floor(g) + seed * 7.3), 0.8 * streetLit);
  return vec2(1.0, win * lit);
}

// The city beyond the near blocks, seen over their roofs when the camera is raised: the sky above,
// two ranks of towers in the haze below it. A function of the ray's direction alone, so it moves
// rigidly with the camera.
vec3 streetBeyond(vec3 d) {
  float slope = d.y / max(length(d.xz), 1e-3);
  float az = atan(d.x, max(d.z, 1e-3));
  vec3 haze = streetHaze(d);
  vec3 col = d.y > 0.0 ? streetSkyLight(d) : haze;
  vec3 body = mix(vec3(0.2, 0.21, 0.25), vec3(0.03, 0.035, 0.05), streetDark);
  vec3 window = vec3(1.0, 0.74, 0.46) * streetDark;
  vec2 rank = streetTowers(az, slope, 380.0, 23.0, 20.0, 50.0, 5.0);
  if (rank.x > 0.5) col = mix(body, haze, 0.8) + window * rank.y * 0.1;
  rank = streetTowers(az, slope, 150.0, 38.0, 12.0, 28.0, 2.0);
  if (rank.x > 0.5) col = mix(body, haze, 0.55) + window * rank.y * 0.2;
  return col;
}

// What the wet street mirrors at ground point g along the reflected ray rr: the facade it meets
// (blurred by rough over the way) or, above the roofs, the sky; and over them the shop fronts and
// signs, their reflections drawn out toward the eye into long wavering streaks (the rougher the
// wet asphalt, the longer), sharp in a puddle.
vec3 streetMirror(vec3 g, vec3 rr, float rough) {
  int f = -1;
  float u = 0.0;
  float y = 0.0;
  float travel = 0.0;
  if (g.z < STREET_FACADE_FAR) {
    float t1 = (STREET_FACADE_FAR - g.z) / max(rr.z, 1e-4);
    vec3 q = g + rr * t1;
    if (abs(q.x) >= STREET_SIDE_FACADE) {
      f = q.x < 0.0 ? 0 : 1;
      u = abs(q.x) - STREET_SIDE_FACADE;
      y = q.y;
      travel = t1;
    }
  }
  if (f < 0) {
    float wx = rr.x < 0.0 ? -STREET_SIDE_FACADE : STREET_SIDE_FACADE;
    float t2 = (wx - g.x) / (abs(rr.x) > 1e-4 ? rr.x : 1e-4);
    vec3 q = g + rr * t2;
    f = rr.x < 0.0 ? 2 : 3;
    u = max(q.z - STREET_FACADE_FAR, 0.0);
    y = q.y;
    travel = t2;
  }
  float r = clamp(rough * 2.8, 0.0, 1.0);
  float grain = mix(1.0, 0.3 + 1.2 * vnoise(vec2(g.x * 3.1, g.z * 1.3) + vec2(11.0, 5.0)), r);
  vec3 streaks = streetLitBand(f, u, y, 0.08 + 0.4 * rough, 0.3, 1.5 + 30.0 * rough) * grain * streetDark;
  vec3 sky = streetSkyLight(rr);
  float roof = STREET_BLD_A[streetBuildingAt(f, u)].z;
  vec2 blur = vec2(0.04 + rough * travel * 0.05, 0.08 + rough * travel * 0.5);
  if (y > roof + blur.y || travel > 300.0) return sky + streaks;
  vec3 albedo;
  vec3 emit;
  float glass;
  streetFacade(f, u, y, blur, true, albedo, emit, glass);
  vec3 c = albedo * streetAmbient * 0.7 + emit + glass * streetSkyLight(normalize(vec3(rr.x, 0.2 - rr.y * 0.3, -rr.z))) * 0.25;
  return mix(c, sky, smoothstep(roof - blur.y, roof + blur.y, y)) + streaks;
}

// Whether the sun reaches p past the blocks (1) or not (0).
float streetSunlit(vec3 p) {
  vec3 s = streetSky.sun;
  if (s.y <= 0.0) return 0.0;
  if (s.z > 0.01 && p.z < STREET_FACADE_FAR) {
    vec3 q = p + s * ((STREET_FACADE_FAR - p.z) / s.z);
    if (abs(q.x) > STREET_SIDE_FACADE && q.y < STREET_BLD_A[streetBuildingAt(q.x < 0.0 ? 0 : 1, abs(q.x) - STREET_SIDE_FACADE)].z) return 0.0;
  }
  if (abs(s.x) > 0.01) {
    float wx = s.x > 0.0 ? STREET_SIDE_FACADE : -STREET_SIDE_FACADE;
    float t = (wx - p.x) / s.x;
    vec3 q = p + s * t;
    if (t > 0.0 && q.z > STREET_FACADE_FAR && q.y < STREET_BLD_A[streetBuildingAt(s.x > 0.0 ? 3 : 2, q.z - STREET_FACADE_FAR)].z) return 0.0;
  }
  if (s.z < -0.01 && p.z > STREET_FACADE_NEAR) {
    if (p.y + s.y * ((STREET_FACADE_NEAR - p.z) / s.z) < 24.0) return 0.0;
  }
  return 1.0;
}

// The shops' light at u along facade f, softened over a metre, with the blade sign's colour.
vec3 streetShopGlow(int f, float u) {
  int b = streetBuildingAt(f, u);
  vec4 A = STREET_BLD_A[b];
  vec4 B = STREET_BLD_B[b];
  float x = u - A.x;
  float win = smoothstep(0.0, 1.2, x) * smoothstep(0.0, 1.2, A.y - A.x - x);
  vec3 c = streetShopLight(B.x, B.w) * win * (0.35 + 0.75 * K_signs);
  if (B.y > 0.5) {
    float us = f < 2 ? 0.55 : 0.75;
    c += STREET_SIGN[int(B.y - 0.5)] * exp(-(x - us) * (x - us) / 2.5) * 0.45 * K_signs;
  }
  return c;
}

// Light from the shops, the vending machines and the unseen shops below the window, at p.
vec3 streetSpill(vec3 p) {
  vec3 s = vec3(0.0);
  float ax = abs(p.x);
  if (p.z > STREET_KERB_FAR - 7.0 && p.z < STREET_FACADE_FAR + 0.5 && ax > STREET_SIDE_FACADE - 1.5) {
    float d = max(STREET_FACADE_FAR - p.z, 0.0);
    s += streetShopGlow(p.x < 0.0 ? 0 : 1, max(ax - STREET_SIDE_FACADE, 0.0)) * exp(-d / 1.9) * (1.0 - smoothstep(1.5, 4.0, p.y));
  }
  if (p.z > STREET_FACADE_FAR - 1.5 && ax < STREET_SIDE_FACADE + 0.5) {
    float d = max(STREET_SIDE_FACADE - ax, 0.0);
    s += streetShopGlow(p.x < 0.0 ? 2 : 3, max(p.z - STREET_FACADE_FAR, 0.0)) * exp(-d / 1.9) * (1.0 - smoothstep(1.5, 4.0, p.y));
  }
  if (p.z < STREET_KERB_NEAR + 3.0) {
    // Shops under the window: pools of light on the near sidewalk, a few metres wide.
    float fall = exp(-max(p.z - STREET_FACADE_NEAR, 0.0) / 2.3);
    float c0 = floor(p.x / 9.0);
    for (int i = -1; i <= 1; i++) {
      float cx = c0 + float(i);
      float h = hash12(vec2(cx, 2.3));
      if (fract(h * 3.7) < 0.3) continue;
      float x0 = (cx + 0.25 + 0.5 * h) * 9.0;
      vec3 c = h < 0.5 ? vec3(1.0, 0.72, 0.45) : vec3(0.88, 0.94, 1.0);
      s += c * (0.45 + 0.6 * fract(h * 7.1)) * exp(-(p.x - x0) * (p.x - x0) / 9.0) * fall * (0.4 + 0.6 * K_signs);
    }
  }
  // Vending machines glow white in front of their fronts.
  vec4 v0 = STREET_VENDING[0];
  vec2 d0 = vec2(clamp(p.x, v0.x, v0.y) - p.x, (v0.z - p.z));
  s += vec3(0.85, 0.92, 1.0) * 0.9 * exp(-dot(d0, d0) / 1.6) * step(p.z, v0.z + 0.1);
  vec4 v1 = STREET_VENDING[1];
  vec2 d1 = vec2(v1.x - p.x, clamp(p.z, v1.z, v1.w) - p.z);
  s += vec3(0.95, 0.95, 1.0) * 0.8 * exp(-dot(d1, d1) / 1.6) * step(p.x, v1.x + 0.1);
  return s;
}

// ---- The street surface ----

// One zebra: bars every 0.9 m across the walk (along it: 0 at one kerb .. len at the other), 2 *
// CROSS_HALF wide. fw metres per cell; far off the bars fuse into a grey.
float streetZebra(float along, float across, float len, float fw) {
  float inside = streetBand(across, -STREET_CROSS_HALF, STREET_CROSS_HALF, fw) * streetBand(along, 0.35, len - 0.35, fw);
  float bar = streetBand(fract(along / 0.9 + 0.25), 0.25, 0.75, fw / 0.9);
  return inside * mix(bar, 0.5, smoothstep(0.12, 0.3, fw));
}

// A zebra from a to b (plan points).
float streetZebraAB(vec2 p, vec2 a, vec2 b, float fw) {
  vec2 d = b - a;
  float len = length(d);
  d /= len;
  vec2 q = p - a;
  return streetZebra(dot(q, d), dot(q, vec2(-d.y, d.x)), len, fw);
}

// A lane arrow painted along a lane: q = (along, across) from its tail; turn -1 / 1 adds a branch
// to the right / left, 2 both.
float streetArrow(vec2 q, float fw, float turn) {
  float shaft = streetBand(q.x, 0.0, 3.0, fw) * streetBand(q.y, -0.09, 0.09, fw);
  float head = streetBand(q.x, 3.0, 4.2, fw) * step(abs(q.y), 0.42 * (4.2 - q.x) / 1.2 + fw);
  float a = max(shaft, head);
  for (int i = 0; i < 2; i++) {
    float s = i == 0 ? 1.0 : -1.0;
    if (turn != s && turn != 2.0) continue;
    // A branch leaving the shaft at 45 degrees, ending in a head.
    vec2 b = vec2(q.x - 1.4, q.y * s);
    vec2 r = vec2(b.x + b.y, b.y - b.x) * 0.7071;
    float arm = streetBand(r.x, 0.0, 1.5, fw) * streetBand(r.y, -0.09, 0.09, fw) * step(0.0, b.y);
    float tip = streetBand(r.x, 1.5, 2.4, fw) * step(abs(r.y), 0.36 * (2.4 - r.x) / 0.9 + fw);
    a = max(a, max(arm, tip));
  }
  return a;
}

// The street at plan point p: its colour before light. info: x 1 on a sidewalk, y white or yellow
// paint, z the M's paint, w sheltered under an awning (no rain, no puddles). fw: metres per cell.
vec3 streetGround(vec2 p, float fw, out vec4 info) {
  float ax = abs(p.x);
  // The kerbs: signed distance, positive on the road.
  float dNear = p.y - STREET_KERB_NEAR;
  vec2 q = vec2(ax - STREET_SIDE_KERB, p.y - STREET_KERB_FAR);
  float dFar = q.x < STREET_CORNER && q.y < STREET_CORNER ? length(q - vec2(STREET_CORNER)) - STREET_CORNER : -min(q.x, q.y);
  float dk = min(dNear, dFar);
  info = vec4(0.0);
  vec3 c;
  if (dk < 0.0) {
    // Sidewalk: grey pavers in a running bond, a few warm ones, granite kerbstones at the edge.
    info.x = 1.0;
    vec2 tq = vec2(p.x / 0.6 + 0.5 * step(0.5, fract(p.y / 0.6)), p.y / 0.3);
    vec2 id = floor(tq);
    float h = hash12(id);
    c = (h < 0.12 ? vec3(0.46, 0.36, 0.32) : vec3(0.42, 0.41, 0.39)) * (0.9 + 0.12 * fract(h * 7.3));
    vec2 jq = abs(fract(tq) - 0.5) * vec2(0.6, 0.3);
    float joint = 1.0 - min(smoothstep(0.0, 0.025, 0.3 - jq.x), smoothstep(0.0, 0.025, 0.15 - jq.y));
    c *= 1.0 - 0.25 * joint * (1.0 - smoothstep(0.02, 0.05, fw));
    c = mix(c, vec3(0.6, 0.6, 0.58), streetBand(dk, -0.24, 0.0, fw * 0.5));
    // Yellow tactile paving: guide lines along the sidewalks, warning strips at every crossing.
    float guide = p.y < STREET_KERB_NEAR ? streetBand(p.y, 17.35, 17.65, fw)
                : ax < STREET_SIDE_FACADE + 0.2 && p.y > STREET_KERB_FAR + 2.5 ? streetBand(ax, 7.35, 7.65, fw)
                : streetBand(p.y, 42.85, 43.15, fw) * step(7.5, ax);
    float warn = streetBand(dk, -0.95, -0.35, fw) * (
        step(abs(ax - STREET_CROSS_WE), 1.7)
      + step(abs(ax - STREET_DIAG_NEAR), 1.4) * step(p.y, STREET_KERB_NEAR)
      + step(abs(p.y - STREET_CROSS_N), 1.7) * step(STREET_KERB_FAR + 1.0, p.y)
      + step(length(vec2(ax, p.y) - vec2(STREET_DIAG_FAR + 0.6, STREET_DIAG_FAR_Z + 0.6)), 1.4));
    float tactile = clamp(max(guide, warn), 0.0, 1.0);
    c = mix(c, vec3(0.86, 0.68, 0.1), tactile);
    // Under an awning the sidewalk keeps dry.
    if (p.y > STREET_FACADE_FAR - 1.3 && ax > STREET_SIDE_FACADE) {
      int f = p.x < 0.0 ? 0 : 1;
      float u = ax - STREET_SIDE_FACADE;
      int b = streetBuildingAt(f, u);
      vec4 A = STREET_BLD_A[b];
      if (streetHasAwning(STREET_BLD_B[b]) && u - A.x > 0.3 && A.y - u > 0.3) info.w = smoothstep(STREET_FACADE_FAR - 1.3, STREET_FACADE_FAR - 1.0, p.y);
    }
    if (p.y > STREET_FACADE_FAR && ax > STREET_SIDE_FACADE - 1.3 && ax < STREET_SIDE_FACADE) {
      int f = p.x < 0.0 ? 2 : 3;
      float u = p.y - STREET_FACADE_FAR;
      int b = streetBuildingAt(f, u);
      vec4 A = STREET_BLD_A[b];
      if (streetHasAwning(STREET_BLD_B[b]) && u - A.x > 0.3 && A.y - u > 0.3) info.w = smoothstep(STREET_SIDE_FACADE - 1.3, STREET_SIDE_FACADE - 1.0, ax);
    }
    return c;
  }
  // Road: asphalt with a grain, older patches, wheel-polished lanes darker, oil down their middles,
  // the light concrete gutter along the kerbs and the kerb's shadow.
  float grain = 0.86 + 0.1 * vnoise(p * 0.7) + 0.08 * vnoise(p * 4.1 + 3.0) * (1.0 - smoothstep(0.03, 0.08, fw));
  c = vec3(0.085, 0.087, 0.095) * grain;
  vec2 patchId = floor(p / vec2(7.0, 3.3));
  if (hash12(patchId + 9.1) < 0.12) c *= 0.88;
  float lanes = 0.0;
  if (p.y > STREET_KERB_NEAR && p.y < STREET_KERB_FAR) {
    float zz = p.y > STREET_MID ? min(abs(p.y - STREET_EB_IN), abs(p.y - STREET_EB_OUT)) : min(abs(p.y - STREET_WB_IN), abs(p.y - STREET_WB_OUT));
    lanes = 1.0 - smoothstep(0.05, 0.35, abs(zz - 0.75));
    c *= 1.0 - 0.1 * lanes;
    c *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.3, zz)) * smoothstep(9.0, 14.0, ax) * vnoise(vec2(p.x * 0.8, 1.0));
  }
  float gutter = streetBand(dk, 0.0, 0.42, fw * 0.5);
  c = mix(c, vec3(0.38, 0.38, 0.37) * grain, gutter);
  c *= 1.0 - 0.5 * streetBand(dk, 0.0, 0.07, fw * 0.5);
  // Paint.
  float white = 0.0;
  float yellow = 0.0;
  float blue = 0.0;
  float mark = 0.0;
  if (p.y > STREET_KERB_NEAR && p.y < STREET_KERB_FAR) {
    float beyond = step(STREET_STOP_WB + 0.5, ax);
    yellow = max(streetBand(p.y, STREET_MID - 0.25, STREET_MID - 0.1, fw), streetBand(p.y, STREET_MID + 0.1, STREET_MID + 0.25, fw)) * beyond;
    float dash = ax < 32.0 ? 1.0 : streetBand(fract((ax - 32.0) / 9.0), 0.0, 0.5, fw / 9.0);
    white = max(white, (streetBand(p.y, 26.43, 26.57, fw) + streetBand(p.y, 35.43, 35.57, fw)) * beyond * dash);
    white = max(white, (streetBand(p.y, 23.58, 23.72, fw) + streetBand(p.y, 38.28, 38.42, fw)) * beyond);
    // Stop lines.
    white = max(white, streetBand(p.x, STREET_STOP_EB + 0.05, STREET_STOP_EB + 0.5, fw) * streetBand(p.y, STREET_MID + 0.15, 38.42, fw));
    white = max(white, streetBand(p.x, STREET_STOP_WB - 0.5, STREET_STOP_WB - 0.05, fw) * streetBand(p.y, 23.58, STREET_MID - 0.15, fw));
    // Arrows: straight on the inner lanes, straight-or-left on the eastbound outer lane.
    for (int i = 0; i < 2; i++) {
      float x0 = i == 0 ? -27.0 : -40.0;
      white = max(white, streetArrow(vec2(p.x - x0, p.y - STREET_EB_IN), fw, 0.0));
      white = max(white, streetArrow(vec2(p.x - x0, p.y - STREET_EB_OUT), fw, 1.0));
      white = max(white, streetArrow(vec2(-x0 - p.x, STREET_WB_IN - p.y), fw, 0.0));
      white = max(white, streetArrow(vec2(-x0 - p.x, STREET_WB_OUT - p.y), fw, 0.0));
    }
    // Bicycle marks along the kerbs: blue chevrons every ten metres.
    float bz = p.y < STREET_MID ? p.y - STREET_WB_BIKE : p.y - STREET_EB_BIKE;
    float bx = fract(p.x / 10.0) * 10.0;
    blue = streetBand(abs(bz) * 0.9 + abs(bx - 5.0) * 0.55, -1.0, 0.32, fw) * step(abs(bx - 5.0), 0.55) * step(13.0, ax) * step(abs(bz), 0.45);
    // The zebras across the avenue.
    white = max(white, streetZebra(p.y - STREET_KERB_NEAR, p.x + STREET_CROSS_WE, STREET_KERB_FAR - STREET_KERB_NEAR, fw));
    white = max(white, streetZebra(p.y - STREET_KERB_NEAR, p.x - STREET_CROSS_WE, STREET_KERB_FAR - STREET_KERB_NEAR, fw));
    if (K_mark > 0.5) {
      // The landmark: the diagonals repainted as a V from the far ends of W and E down to the
      // middle, so from up here the zebras spell the M.
      vec2 top0 = vec2(-STREET_CROSS_WE, STREET_KERB_FAR);
      vec2 top1 = vec2(STREET_CROSS_WE, STREET_KERB_FAR);
      vec2 apex = vec2(0.0, STREET_MARK_APEX);
      mark = max(streetZebraAB(p, top0, apex + vec2(0.0, -0.9), fw), streetZebraAB(p, top1, apex + vec2(0.0, -0.9), fw));
      mark = max(mark, streetZebra(p.y - STREET_KERB_NEAR, ax - STREET_CROSS_WE, STREET_KERB_FAR - STREET_KERB_NEAR, fw));
      white = max(white, mark);
    } else {
      white = max(white, streetZebraAB(p, vec2(-STREET_DIAG_NEAR, STREET_KERB_NEAR), vec2(STREET_DIAG_FAR, STREET_DIAG_FAR_Z), fw));
      white = max(white, streetZebraAB(p, vec2(STREET_DIAG_NEAR, STREET_KERB_NEAR), vec2(-STREET_DIAG_FAR, STREET_DIAG_FAR_Z), fw));
    }
  } else {
    // The side street: its zebra, stop line, centre and edge lines, the turn arrow.
    white = max(white, streetZebra(p.x + STREET_SIDE_KERB, p.y - STREET_CROSS_N, 2.0 * STREET_SIDE_KERB, fw));
    white = max(white, streetBand(p.y, STREET_STOP_SB - 0.5, STREET_STOP_SB - 0.05, fw) * streetBand(p.x, 0.15, STREET_SIDE_KERB - 0.6, fw));
    float up = step(STREET_STOP_SB + 0.5, p.y);
    white = max(white, streetBand(p.x, -0.07, 0.07, fw) * streetBand(fract(p.y / 8.0), 0.0, 0.55, fw / 8.0) * up);
    white = max(white, streetBand(ax, STREET_SIDE_KERB - 0.62, STREET_SIDE_KERB - 0.48, fw) * up);
    white = max(white, streetArrow(vec2(58.0 - p.y, p.x - STREET_SB), fw, 2.0));
  }
  info.y = max(white, yellow);
  info.z = mark;
  c = mix(c, vec3(0.78, 0.78, 0.74), white);
  c = mix(c, vec3(0.85, 0.62, 0.1), yellow);
  c = mix(c, vec3(0.1, 0.3, 0.75), blue);
  // Manholes: an iron lid in a ring.
  for (int i = 0; i < ${MANHOLES.length}; i++) {
    vec3 m = STREET_MANHOLE[i];
    float d = length(p - m.xy);
    if (d < m.z + 0.08) {
      float lid = 1.0 - smoothstep(m.z - fw, m.z, d);
      float pattern = 0.8 + 0.2 * (1.0 - smoothstep(0.03, 0.08, fw)) * step(0.5, fract((p.x + p.y) / 0.09));
      c = mix(c * 0.6, vec3(0.16, 0.15, 0.14) * pattern, lid);
    }
  }
  return c;
}

// ---- Things standing in the street ----

// A blade sign hanging off a far block (f 0 or 1), building b: hit it if nearer.
void streetBladeFar(int f, int b, vec3 ro, vec3 rd, vec3 inv, inout StreetHit hit, inout vec3 halo) {
  vec4 A = STREET_BLD_A[b];
  vec4 B = STREET_BLD_B[b];
  if (B.y < 0.5) return;
  float side = f == 0 ? -1.0 : 1.0;
  float xs = side * (STREET_SIDE_FACADE + A.x + 0.55);
  float len = 3.2 + 1.2 * fract(B.w * 5.3);
  vec3 lo = vec3(xs - 0.09, B.z - len, STREET_FACADE_FAR - 0.9);
  vec3 hi = vec3(xs + 0.09, B.z, STREET_FACADE_FAR);
  vec3 c = STREET_SIGN[int(B.y - 0.5)] * (0.2 + K_signs);
  float gap = streetNear(vec2(xs, STREET_FACADE_FAR - 0.45), B.z) - 0.1;
  halo += c * (0.3 * exp(-gap * gap / 0.35) + 0.12 * exp(-gap * gap / 2.5)) * streetDark;
  vec3 n;
  float t = streetBox(ro, rd, inv, lo, hi, n);
  if (t <= 0.0 || t >= hit.t) return;
  vec3 p = ro + rd * t;
  hit.t = t;
  hit.kind = STREET_K_SIGN;
  hit.n = n;
  hit.gloss = 0.4;
  hit.snow = n.y > 0.5 ? 1.0 : 0.0;
  float fw = t / (STREET_FOCAL * uRes.y);
  if (abs(n.x) > 0.5) {
    vec3 face = streetBladeFace(vec2((STREET_FACADE_FAR - p.z) / 0.9, (B.z - p.y) / len), len, B.y - 1.0, B.w, fw);
    hit.albedo = face * 0.7;
    hit.emit = mix(face, vec3(1.0), 0.15) * (0.2 + K_signs) * 1.3;
  } else {
    hit.albedo = vec3(0.2);
    hit.emit = c * 0.3;
  }
}

// A blade sign hanging into the side street (f 2 or 3), building b.
void streetBladeSide(int f, int b, vec3 ro, vec3 rd, vec3 inv, inout StreetHit hit, inout vec3 halo) {
  vec4 A = STREET_BLD_A[b];
  vec4 B = STREET_BLD_B[b];
  if (B.y < 0.5) return;
  float side = f == 2 ? -1.0 : 1.0;
  float zs = STREET_FACADE_FAR + A.x + 0.75;
  float len = 3.2 + 1.2 * fract(B.w * 5.3);
  float x0 = side * (STREET_SIDE_FACADE - 0.9);
  float x1 = side * STREET_SIDE_FACADE;
  vec3 lo = vec3(min(x0, x1), B.z - len, zs - 0.1);
  vec3 hi = vec3(max(x0, x1), B.z, zs + 0.1);
  vec3 c = STREET_SIGN[int(B.y - 0.5)] * (0.2 + K_signs);
  float gap = streetNear(vec2(side * (STREET_SIDE_FACADE - 0.45), zs), B.z) - 0.1;
  halo += c * (0.3 * exp(-gap * gap / 0.35) + 0.12 * exp(-gap * gap / 2.5)) * streetDark;
  vec3 n;
  float t = streetBox(ro, rd, inv, lo, hi, n);
  if (t <= 0.0 || t >= hit.t) return;
  vec3 p = ro + rd * t;
  hit.t = t;
  hit.kind = STREET_K_SIGN;
  hit.n = n;
  hit.gloss = 0.4;
  hit.snow = n.y > 0.5 ? 1.0 : 0.0;
  float fw = t / (STREET_FOCAL * uRes.y);
  if (abs(n.z) > 0.5) {
    vec3 face = streetBladeFace(vec2((side * STREET_SIDE_FACADE - p.x) * side / 0.9, (B.z - p.y) / len), len, B.y - 1.0, B.w, fw);
    hit.albedo = face * 0.7;
    hit.emit = mix(face, vec3(1.0), 0.15) * (0.2 + K_signs) * 1.3;
  } else {
    hit.albedo = vec3(0.2);
    hit.emit = c * 0.3;
  }
}

// An awning over a shop front: its top (y = 2.95) and its valance. along: u on facade f; out: how far
// out from the wall (m) the ray is at the awning's height.
void streetAwning(int f, float u, float reach, float t, vec3 n, bool valance, inout StreetHit hit) {
  if (t <= 0.0 || t >= hit.t || reach < 0.0 || reach > 1.1) return;
  int b = streetBuildingAt(f, u);
  vec4 A = STREET_BLD_A[b];
  vec4 B = STREET_BLD_B[b];
  float x = u - A.x;
  if (!streetHasAwning(B) || x < 0.3 || x > A.y - A.x - 0.3) return;
  int s = int(B.x + 0.5);
  vec3 c = s == STREET_SHOP_CAFE ? mix(vec3(0.08, 0.36, 0.2), vec3(0.88, 0.85, 0.74), step(0.5, fract(x / 0.9)))
         : s == STREET_SHOP_IZAKAYA ? vec3(0.45, 0.07, 0.05)
         : s == STREET_SHOP_KARAOKE ? vec3(0.3, 0.08, 0.36)
         : vec3(0.08, 0.08, 0.09);
  hit.t = t;
  hit.kind = STREET_K_AWNING;
  hit.n = n;
  hit.albedo = c;
  hit.emit = valance ? streetShopLight(B.x, B.w) * 0.12 * (0.35 + 0.75 * K_signs) : vec3(0.0);
  hit.gloss = 0.5;
  hit.snow = valance ? 0.0 : 1.0;
  hit.q = vec3(float(f), u, reach);
}

// The fixed things in the street: the facades, blade signs, awnings, vending machines, lamp posts,
// signal poles and their heads. halo gathers the blade signs' glow.
void streetStatics(vec3 ro, vec3 rd, vec3 inv, inout StreetHit hit, inout vec3 halo) {
  // The far blocks' fronts.
  if (rd.z > 0.0) {
    float t = (STREET_FACADE_FAR - ro.z) / rd.z;
    vec3 q = ro + rd * t;
    if (abs(q.x) >= STREET_SIDE_FACADE && q.y >= 0.0 && t < hit.t && (streetTilt <= 0.0 || q.y < STREET_BLD_A[streetBuildingAt(q.x < 0.0 ? 0 : 1, abs(q.x) - STREET_SIDE_FACADE)].z)) {
      hit.t = t;
      hit.kind = STREET_K_FACADE;
      hit.n = vec3(0.0, 0.0, -1.0);
      hit.q = vec3(q.x < 0.0 ? 0.0 : 1.0, abs(q.x) - STREET_SIDE_FACADE, q.y);
    }
  }
  // The side street's walls.
  {
    float wx = rd.x < 0.0 ? -STREET_SIDE_FACADE : STREET_SIDE_FACADE;
    float t = (wx - ro.x) / (abs(rd.x) > 1e-5 ? rd.x : 1e-5);
    vec3 q = ro + rd * t;
    if (t > 0.0 && q.z >= STREET_FACADE_FAR && q.y >= 0.0 && t < hit.t && (streetTilt <= 0.0 || q.y < STREET_BLD_A[streetBuildingAt(rd.x < 0.0 ? 2 : 3, q.z - STREET_FACADE_FAR)].z)) {
      hit.t = t;
      hit.kind = STREET_K_FACADE;
      hit.n = vec3(rd.x < 0.0 ? 1.0 : -1.0, 0.0, 0.0);
      hit.q = vec3(rd.x < 0.0 ? 2.0 : 3.0, q.z - STREET_FACADE_FAR, q.y);
    }
  }
  // Blade signs: the one on the building the ray passes over the sidewalk, and the next one.
  {
    float t = (STREET_FACADE_FAR - 0.45 - ro.z) / rd.z;
    vec3 q = ro + rd * t;
    if (abs(q.x) > STREET_SIDE_FACADE && q.y > 2.0 && q.y < 12.0) {
      int f = q.x < 0.0 ? 0 : 1;
      float u = abs(q.x) - STREET_SIDE_FACADE;
      int b = streetBuildingAt(f, u);
      streetBladeFar(f, b, ro, rd, inv, hit, halo);
      if (b + 1 < STREET_BLD_FIRST[f] + STREET_BLD_COUNT[f] && STREET_BLD_A[b].y - u < 2.2) streetBladeFar(f, b + 1, ro, rd, inv, hit, halo);
    }
  }
  if (abs(rd.x) > 1e-4) {
    float side = rd.x < 0.0 ? -1.0 : 1.0;
    float ta = (side * (STREET_SIDE_FACADE - 0.9) - ro.x) / rd.x;
    float tb = (side * STREET_SIDE_FACADE - ro.x) / rd.x;
    float za = ro.z + rd.z * ta - 0.2;
    float zb = ro.z + rd.z * tb + 0.2;
    if (zb > STREET_FACADE_FAR && ro.y + rd.y * ta > 2.0) {
      int f = side < 0.0 ? 2 : 3;
      int b0 = streetBuildingAt(f, max(za - STREET_FACADE_FAR - 2.2, 0.0));
      int b1 = streetBuildingAt(f, max(zb - STREET_FACADE_FAR, 0.0));
      for (int i = 0; i < 3; i++) {
        if (b0 + i > b1) break;
        streetBladeSide(f, b0 + i, ro, rd, inv, hit, halo);
      }
    }
  }
  // Awnings: their tops, then their fronts.
  {
    float t = (2.95 - ro.y) / rd.y;
    vec3 q = ro + rd * t;
    if (abs(q.x) > STREET_SIDE_FACADE) streetAwning(q.x < 0.0 ? 0 : 1, abs(q.x) - STREET_SIDE_FACADE, STREET_FACADE_FAR - q.z, t, vec3(0.0, 1.0, 0.0), false, hit);
    else if (q.z > STREET_FACADE_FAR) streetAwning(q.x < 0.0 ? 2 : 3, q.z - STREET_FACADE_FAR, STREET_SIDE_FACADE - abs(q.x), t, vec3(0.0, 1.0, 0.0), false, hit);
    float tf = (STREET_FACADE_FAR - 1.1 - ro.z) / rd.z;
    vec3 qf = ro + rd * tf;
    if (abs(qf.x) > STREET_SIDE_FACADE && qf.y > 2.6 && qf.y < 2.95) streetAwning(qf.x < 0.0 ? 0 : 1, abs(qf.x) - STREET_SIDE_FACADE, 1.1, tf, vec3(0.0, 0.0, -1.0), true, hit);
    if (abs(rd.x) > 1e-4) {
      float side = rd.x < 0.0 ? -1.0 : 1.0;
      float ts = (side * (STREET_SIDE_FACADE - 1.1) - ro.x) / rd.x;
      vec3 qs = ro + rd * ts;
      if (qs.z > STREET_FACADE_FAR && qs.y > 2.6 && qs.y < 2.95) streetAwning(side < 0.0 ? 2 : 3, qs.z - STREET_FACADE_FAR, 1.1, ts, vec3(-side, 0.0, 0.0), true, hit);
    }
  }
  // Vending machines: glowing fronts full of little bottles.
  for (int i = 0; i < 2; i++) {
    vec4 v = STREET_VENDING[i];
    vec3 n;
    float t = streetBox(ro, rd, inv, vec3(v.x, 0.0, v.z), vec3(v.y, 1.83, v.w), n);
    if (t <= 0.0 || t >= hit.t) continue;
    vec3 p = ro + rd * t;
    bool front = i == 0 ? n.z < -0.5 : n.x < -0.5;
    float across = i == 0 ? (p.x - v.x) / (v.y - v.x) : (p.z - v.z) / (v.w - v.z);
    float machine = floor(across * 2.0);
    float s = fract(across * 2.0);
    vec3 body = machine < 0.5 ? vec3(0.75, 0.08, 0.08) : vec3(0.85, 0.86, 0.88);
    hit.t = t;
    hit.kind = STREET_K_VENDING;
    hit.n = n;
    hit.gloss = 0.5;
    hit.snow = n.y > 0.5 ? 1.0 : 0.0;
    hit.albedo = n.y > 0.5 ? vec3(0.3) : body;
    hit.emit = vec3(0.0);
    if (front) {
      float yv = p.y / 1.83;
      float shelf = streetBand(yv, 0.5, 0.93, 0.01) * streetBand(s, 0.08, 0.92, 0.02);
      vec2 g = vec2(s * 8.0, yv * 14.0);
      float bottle = step(0.3, fract(g.x)) * step(0.25, fract(g.y)) * step(fract(g.y), 0.8);
      vec3 drink = 0.5 + 0.5 * cos(STREET_TAU * (hash12(floor(g) + machine * 9.0) + vec3(0.0, 0.33, 0.67)));
      hit.emit = mix(vec3(0.9, 0.95, 1.0), drink, bottle * 0.8) * shelf * 1.1;
      hit.albedo = mix(body, vec3(0.08), streetBand(yv, 0.12, 0.3, 0.01) * streetBand(s, 0.2, 0.8, 0.02));
      hit.emit += vec3(0.6, 0.85, 1.0) * 0.5 * streetBand(yv, 0.36, 0.44, 0.01) * streetBand(s, 0.6, 0.85, 0.02);
    }
  }
  // Lamp posts: pole, arm over the road, the head.
  for (int i = 0; i < STREET_LAMPS; i++) {
    vec4 l = STREET_LAMP[i];
    vec2 head = STREET_LAMP_HEAD[i];
    if (min(streetNear(l.xy, l.z), streetNear(head, l.z)) > 1.5) continue;
    float t = streetPillar(ro, rd, l.xy, 0.1, 0.0, l.z);
    vec3 n = vec3(0.0);
    if (t > 0.0 && t < hit.t) {
      vec3 p = ro + rd * t;
      n = abs(p.y - l.z) < 0.01 ? vec3(0.0, 1.0, 0.0) : vec3(normalize(p.xz - l.xy), 0.0).xzy;
    }
    float ta = streetCapsule(ro, rd, vec3(l.x, l.z - 0.12, l.y), vec3(head.x, l.z - 0.12, head.y), 0.055);
    if (ta > 0.0 && ta < hit.t && (t <= 0.0 || ta < t)) {
      t = ta;
      n = vec3(0.0, 1.0, 0.0);
    }
    vec2 dir = normalize(head - l.xy + vec2(1e-5));
    float th = streetCapsule(ro, rd, vec3(head - dir * 0.55, l.z - 0.24).xzy, vec3(head + dir * 0.1, l.z - 0.24).xzy, 0.13);
    bool lampHead = th > 0.0 && th < hit.t && (t <= 0.0 || th < t);
    if (lampHead) {
      t = th;
      n = vec3(0.0, 1.0, 0.0);
    }
    if (t > 0.0 && t < hit.t) {
      hit.t = t;
      hit.kind = STREET_K_METAL;
      hit.n = n;
      hit.albedo = lampHead ? vec3(0.32, 0.33, 0.34) : vec3(0.22, 0.23, 0.24);
      hit.emit = vec3(0.0);
      hit.gloss = 0.6;
      hit.snow = n.y > 0.5 ? 1.0 : 0.0;
    }
  }
  // Signal poles and arms.
  for (int i = 0; i < STREET_POLES; i++) {
    vec3 sp = STREET_POLE[i];
    if (streetNear(sp.xy, sp.z) > 0.6) continue;
    float t = streetPillar(ro, rd, sp.xy, 0.12, 0.0, sp.z);
    if (t > 0.0 && t < hit.t) {
      vec3 p = ro + rd * t;
      hit.t = t;
      hit.kind = STREET_K_METAL;
      hit.n = abs(p.y - sp.z) < 0.01 ? vec3(0.0, 1.0, 0.0) : vec3(normalize(p.xz - sp.xy), 0.0).xzy;
      hit.albedo = vec3(0.3, 0.31, 0.3);
      hit.emit = vec3(0.0);
      hit.gloss = 0.6;
      hit.snow = hit.n.y;
    }
  }
  // Car signal heads, hung from their arms: green, amber, red from the driver's left.
  for (int i = 0; i < ${CAR_HEADS.length}; i++) {
    vec4 h = STREET_CAR_HEAD[i];
    ivec2 meta = STREET_CAR_HEAD_META[i];
    vec3 pole = STREET_POLE[meta.x];
    vec3 c = vec3(h.x, 5.55, h.y);
    if (streetNear(h.xy, 6.0) > 7.0) continue;
    float ta = streetCapsule(ro, rd, vec3(pole.x, 5.85, pole.y), vec3(h.x, 5.85, h.y), 0.07);
    if (ta > 0.0 && ta < hit.t) {
      hit.t = ta;
      hit.kind = STREET_K_METAL;
      hit.n = vec3(0.0, 1.0, 0.0);
      hit.albedo = vec3(0.3, 0.31, 0.3);
      hit.emit = vec3(0.0);
      hit.gloss = 0.6;
      hit.snow = 1.0;
    }
    vec3 ext = abs(h.z) > 0.5 ? vec3(0.17, 0.22, 0.66) : vec3(0.66, 0.22, 0.17);
    vec3 n;
    float t = streetBox(ro, rd, inv, c - ext, c + ext, n);
    if (t <= 0.0 || t >= hit.t) continue;
    vec3 p = ro + rd * t;
    hit.t = t;
    hit.kind = STREET_K_SIGNAL;
    hit.n = n;
    hit.albedo = vec3(0.32, 0.33, 0.33);
    hit.emit = vec3(0.0);
    hit.gloss = 0.5;
    hit.snow = n.y > 0.5 ? 1.0 : 0.0;
    if (dot(n.xz, h.zw) > 0.5) {
      vec2 left = vec2(h.w, -h.z);
      float along = dot(p.xz - h.xy, left);
      vec4 s = streetSignal[meta.y];
      for (int k = 0; k < 3; k++) {
        float off = 0.42 - 0.42 * float(k);
        float lamp = 1.0 - smoothstep(0.11, 0.14, length(vec2(along - off, p.y - c.y)));
        vec3 lc = k == 0 ? STREET_GO : k == 1 ? STREET_AMBER : STREET_STOP;
        float on = k == 0 ? s.x : k == 1 ? s.y : s.z;
        hit.emit += lc * lamp * (0.06 + 2.2 * on);
        hit.albedo = mix(hit.albedo, vec3(0.05), lamp);
      }
      hit.q = vec3(1.0, 0.0, 0.0);
    }
  }
  // Walk signals: the red man above, the green man below.
  for (int i = 0; i < ${WALK_HEADS.length}; i++) {
    vec4 h = STREET_WALK_HEAD[i];
    vec3 c = vec3(h.x, 2.75, h.y);
    if (streetNear(h.xy, 3.3) > 0.8) continue;
    vec3 ext = abs(h.w) > 0.5 ? vec3(0.21, 0.42, 0.13) : vec3(0.13, 0.42, 0.21);
    vec3 n;
    float t = streetBox(ro, rd, inv, c - ext, c + ext, n);
    if (t <= 0.0 || t >= hit.t) continue;
    vec3 p = ro + rd * t;
    hit.t = t;
    hit.kind = STREET_K_SIGNAL;
    hit.n = n;
    hit.albedo = vec3(0.32, 0.33, 0.33);
    hit.emit = vec3(0.0);
    hit.gloss = 0.5;
    hit.snow = n.y > 0.5 ? 1.0 : 0.0;
    if (dot(n.xz, h.zw) > 0.5) {
      float across = dot(p.xz - h.xy, vec2(h.w, -h.z));
      float up = p.y - c.y;
      float red = streetBand(across, -0.15, 0.15, 0.01) * streetBand(up, 0.06, 0.36, 0.01);
      float green = streetBand(across, -0.15, 0.15, 0.01) * streetBand(up, -0.36, -0.06, 0.01);
      // The figures: a man standing, a man walking.
      float standing = step(length(vec2(across, up - 0.29)), 0.035) + step(abs(across), 0.04) * streetBand(up, 0.1, 0.24, 0.005);
      float walking = step(length(vec2(across + 0.02, up + 0.1)), 0.035) + step(abs(across + 0.02 * (up + 0.2) / 0.1), 0.04) * streetBand(up, -0.3, -0.14, 0.005);
      vec4 s = streetSignal[2];
      hit.emit = STREET_STOP * red * (0.05 + 2.0 * s.y) * (0.35 + 0.65 * min(standing, 1.0)) + STREET_GO * green * (0.05 + 2.0 * s.x) * (0.35 + 0.65 * min(walking, 1.0));
      hit.albedo = mix(hit.albedo, vec3(0.04), max(red, green));
      hit.q = vec3(2.0, 0.0, 0.0);
    }
  }
}

// ---- The walkers, bicycles and cars ----

// An umbrella over (cx, cz) at height y (its rim radius r, panels turned by spin): distance to its
// canopy along the ray (-1: missed), and the panel's normal.
float streetUmbrella(vec3 ro, vec3 rd, vec2 c, float y, float r, float spin, out vec3 n, out vec2 q) {
  n = vec3(0.0, 1.0, 0.0);
  q = vec2(0.0);
  // A shallow cone: apex 0.1 above y, rim 0.08 below, found in two steps.
  float t = (y - ro.y) / rd.y;
  vec2 d = ro.xz + rd.xz * t - c;
  float yh = y + 0.1 - 0.18 * clamp(length(d) / r, 0.0, 1.3);
  t = (yh - ro.y) / rd.y;
  d = ro.xz + rd.xz * t - c;
  float a = atan(d.y, d.x) - spin;
  // Eight ribs; the cloth sags between their tips.
  float rim = r * (0.94 + 0.06 * abs(cos(4.0 * a)));
  if (length(d) > rim) return -1.0;
  // Each panel a flat facet, tipped only a little so neighbouring panels stay close in tone.
  float mid = (floor(a / (STREET_TAU / 8.0)) + 0.5) * (STREET_TAU / 8.0) + spin;
  n = normalize(vec3(cos(mid) * 0.16, 1.0, sin(mid) * 0.16));
  q = d / r;
  return t;
}

// A walker (agent id, its two texels): head, coat, legs, bag, and umbrella. A clear vinyl umbrella
// goes to veil, to be laid over what is under it. The late delivery's driver (a porter) wears a work
// jacket and cap and wheels a hand truck before it, with a1.y crates stacked on it.
void streetWalker(int id, vec4 a0, vec4 a1, vec3 ro, vec3 rd, inout StreetHit hit, inout StreetHit veil) {
  vec3 F = vec3(a0.x, 0.0, a0.y + STREET_ZREF);
  bool child = int(a0.w + 0.5) == STREET_KIND_CHILD;
  bool porter = int(a0.w + 0.5) == STREET_KIND_PORTER;
  float seed = a1.w;
  float open = a1.x;
  if (streetNear(F.xz, 2.3) > (porter ? 1.15 : open > 0.02 ? 0.95 : 0.5)) return;
  float h = child ? 1.06 + 0.12 * fract(seed * 7.13) : 1.56 + 0.26 * fract(seed * 7.13);
  float k = h / 1.7;
  vec2 fw = vec2(cos(a0.z), sin(a0.z));
  vec2 lf = vec2(-fw.y, fw.x);
  float look = porter ? 0.0 : a1.y;
  float best = hit.t;
  int part = -1;
  vec3 nb = vec3(0.0, 1.0, 0.0);
  vec2 uq = vec2(0.0);

  // The umbrella: tipped forward as they walk, into the wind, back when they look up.
  float brolly = fract(seed * 5.71);
  int colour = child ? 4 : brolly < 0.36 ? 0 : brolly < 0.52 ? 1 : brolly < 0.6 ? 2 : brolly < 0.66 ? 3 : brolly < 0.7 ? 4 : brolly < 0.74 ? 5 : brolly < 0.8 ? 6 : brolly < 0.85 ? 7 : brolly < 0.9 ? 8 : 9;
  if (open > 0.02) {
    vec2 toEye = normalize(vec2(STREET_CAM_X, 0.0) - F.xz);
    float r = (child ? 0.42 : 0.5 + 0.06 * fract(seed * 3.3)) * mix(0.18, 1.0, open);
    vec2 c = F.xz + fw * 0.1 * k + vec2(0.14 * K_wind, 0.0) - toEye * 0.25 * look;
    vec3 un;
    vec2 q;
    float tu = streetUmbrella(ro, rd, c, h + 0.3, r, seed * STREET_TAU + a0.z, un, q);
    if (tu > 0.0 && tu < best) {
      if (colour == 0) {
        if (tu < veil.t) {
          veil.t = tu;
          veil.kind = STREET_K_AGENT;
          veil.n = un;
          veil.albedo = STREET_BROLLY[0];
          veil.emit = vec3(0.0);
          veil.gloss = 0.9;
          veil.snow = 1.0;
          veil.id = id;
        }
      } else {
        best = tu;
        part = 0;
        nb = un;
        uq = q;
      }
    }
  }
  // Head: a round dot over the shoulders, a little large so it reads from up here.
  float hr = child ? 0.12 : 0.135 * k;
  vec3 hc = vec3(F.x + fw.x * 0.03 * k, h - hr, F.z + fw.y * 0.03 * k);
  float th = streetSphere(ro, rd, hc, hr);
  if (th > 0.0 && th < best) {
    best = th;
    part = 1;
    nb = (ro + rd * th - hc) / hr;
  }
  // Coat: a broad-shouldered ellipsoid turned to the heading, down over the thighs, so from above a
  // walker is a head on a wide oval of colour.
  vec3 tc = vec3(F.x, 0.64 * h, F.z);
  vec3 to = ro - tc;
  vec3 lo = vec3(dot(to.xz, fw), to.y, dot(to.xz, lf));
  vec3 ld = vec3(dot(rd.xz, fw), rd.y, dot(rd.xz, lf));
  vec3 tn;
  float tt = streetEllipsoid(lo, ld, child ? vec3(0.13 * k, 0.25 * h, 0.2 * k) : vec3(0.17 * k, 0.25 * h, 0.27 * k), tn);
  if (tt > 0.0 && tt < best) {
    best = tt;
    part = 2;
    nb = vec3(tn.x * fw.x + tn.z * lf.x, tn.y, tn.x * fw.y + tn.z * lf.y);
  }
  // Legs under the hem, swinging a little with the gait.
  float stride = 0.09 * k * sin(STREET_TAU * a1.z);
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? -1.0 : 1.0;
    vec2 lc = F.xz + lf * side * 0.09 * k + fw * stride * side;
    float tl = streetPillar(ro, rd, lc, 0.08 * k, 0.0, 0.42 * h);
    if (tl > 0.0 && tl < best) {
      best = tl;
      part = 3;
      vec3 p = ro + rd * tl;
      nb = normalize(vec3(p.x - lc.x, 0.2, p.z - lc.y));
    }
  }
  // A bag: a backpack, a shoulder bag, or a white konbini bag hanging from a hand.
  float bag = fract(seed * 9.31);
  if (child || bag < 0.42) {
    vec3 bc;
    vec3 br;
    if (child || bag < 0.22) {
      bc = vec3(F.x, 0.0, F.z) + vec3(-fw.x, 0.0, -fw.y) * 0.21 * k + vec3(0.0, 0.7 * h, 0.0);
      br = vec3(0.09, 0.17, 0.15) * k;
    } else if (bag < 0.34) {
      bc = vec3(F.x + lf.x * 0.32 * k, 0.6 * h, F.z + lf.y * 0.32 * k);
      br = vec3(0.12, 0.13, 0.07) * k;
    } else {
      bc = vec3(F.x - lf.x * 0.36 * k, 0.42 * h, F.z - lf.y * 0.36 * k);
      br = vec3(0.12, 0.14, 0.1) * k;
    }
    vec3 bo = ro - bc;
    vec3 bl = vec3(dot(bo.xz, fw), bo.y, dot(bo.xz, lf));
    vec3 bn;
    float tb = streetEllipsoid(bl, ld, br, bn);
    if (tb > 0.0 && tb < best) {
      best = tb;
      part = 4;
      nb = vec3(bn.x * fw.x + bn.z * lf.x, bn.y, bn.x * fw.y + bn.z * lf.y);
    }
  }
  // The porter's hand truck: two rails up to a handle, the nose plate at their foot, and the crates
  // stacked on it, all turned to its heading.
  float crateY = 0.0;
  if (porter) {
    vec3 po = ro - F;
    vec3 pl = vec3(dot(po.xz, fw), po.y, dot(po.xz, lf));
    vec3 pinv = streetInv(ld);
    vec3 pn;
    for (int r = 0; r < 4; r++) {
      vec3 lo3 = r == 0 ? vec3(0.36, 0.0, 0.17) : r == 1 ? vec3(0.36, 0.0, -0.23) : r == 2 ? vec3(0.3, 1.04, -0.23) : vec3(0.44, 0.0, -0.24);
      vec3 hi3 = r == 0 ? vec3(0.42, 1.12, 0.23) : r == 1 ? vec3(0.42, 1.12, -0.17) : r == 2 ? vec3(0.42, 1.12, 0.23) : vec3(0.98, 0.05, 0.24);
      float tp = streetBox(pl, ld, pinv, lo3, hi3, pn);
      if (tp > 0.0 && tp < best) {
        best = tp;
        part = 5;
        nb = vec3(pn.x * fw.x + pn.z * lf.x, pn.y, pn.x * fw.y + pn.z * lf.y);
      }
    }
    if (a1.y > 0.5) {
      float tp = streetBox(pl, ld, pinv, vec3(0.46, 0.05, -0.21), vec3(0.96, 0.05 + 0.29 * floor(a1.y + 0.5), 0.21), pn);
      if (tp > 0.0 && tp < best) {
        best = tp;
        part = 6;
        nb = vec3(pn.x * fw.x + pn.z * lf.x, pn.y, pn.x * fw.y + pn.z * lf.y);
        crateY = pl.y + ld.y * tp;
      }
    }
  }
  if (part < 0) return;
  hit.t = best;
  hit.kind = STREET_K_AGENT;
  hit.id = id;
  hit.n = nb;
  hit.emit = vec3(0.0);
  hit.gloss = 0.15;
  hit.snow = 0.0;
  vec3 coat = porter ? vec3(0.16, 0.27, 0.22) : child ? (fract(seed * 2.9) < 0.6 ? vec3(0.55, 0.75, 0.92) : vec3(0.95, 0.6, 0.62)) : STREET_COAT[int(fract(seed * 3.71) * 8.0)];
  if (part == 0) {
    vec3 c = STREET_BROLLY[colour];
    if (colour == 9) {
      // White dots on navy.
      vec2 dq = uq * 3.2;
      c = mix(c, vec3(0.92), step(length(fract(dq) - 0.5), 0.2));
    }
    hit.albedo = c;
    hit.gloss = 0.8;
    hit.snow = 1.0;
  } else if (part == 1) {
    // Hair on the crown and back; the face shows where it turns to the eye (looking up, it does).
    vec3 toEye = normalize(ro - hc);
    vec3 faceDir = normalize(mix(vec3(fw.x, -0.25, fw.y), toEye, look));
    float face = step(0.42, dot(nb, faceDir));
    vec3 hair = STREET_HAIR[fract(seed * 6.1) < 0.6 ? 0 : fract(seed * 6.1) < 0.84 ? 1 : fract(seed * 6.1) < 0.93 ? 2 : 3];
    hit.albedo = mix(hair, vec3(0.86, 0.66, 0.53), face);
    // The outing's yellow hats; a few adults in a knit cap.
    if (child) hit.albedo = mix(vec3(0.98, 0.82, 0.08), hit.albedo, face * step(nb.y, 0.55));
    else if (porter) hit.albedo = mix(hit.albedo, vec3(0.1, 0.16, 0.13), step(0.3, nb.y) * (1.0 - face));
    else if (fract(seed * 11.3) < 0.1) hit.albedo = mix(hit.albedo, STREET_COAT[int(fract(seed * 4.3) * 8.0)] + 0.08, step(0.3, nb.y) * (1.0 - face));
    hit.snow = 0.4;
  } else if (part == 2) {
    hit.albedo = coat;
    hit.snow = 0.25;
  } else if (part == 3) {
    hit.albedo = child ? vec3(0.08, 0.1, 0.2) : fract(seed * 8.7) < 0.3 ? vec3(0.13, 0.17, 0.3) : vec3(0.05, 0.05, 0.06);
  } else if (part == 4) {
    float kind = fract(seed * 9.31);
    hit.albedo = child ? vec3(0.7, 0.1, 0.1) : kind < 0.22 ? vec3(0.08, 0.08, 0.09) : kind < 0.34 ? vec3(0.35, 0.22, 0.12) : vec3(0.92, 0.92, 0.9);
  } else if (part == 5) {
    hit.albedo = vec3(0.42, 0.44, 0.47);
    hit.gloss = 0.5;
  } else {
    // Folding crates, a colour a crate, each with a darker rim.
    float level = floor((crateY - 0.05) / 0.29);
    vec3 crate = mod(level, 3.0) < 0.5 ? vec3(0.1, 0.33, 0.78) : mod(level, 3.0) < 1.5 ? vec3(0.12, 0.55, 0.3) : vec3(0.95, 0.72, 0.1);
    hit.albedo = crate * (fract((crateY - 0.05) / 0.29) > 0.84 ? 0.6 : 1.0);
    hit.gloss = 0.3;
    hit.snow = nb.y > 0.5 ? 1.0 : 0.0;
  }
}

// A bicycle and its rider (umbrella in hand in the rain).
void streetBike(int id, vec4 a0, vec4 a1, vec3 ro, vec3 rd, inout StreetHit hit, inout StreetHit veil) {
  vec3 P = vec3(a0.x, 0.0, a0.y + STREET_ZREF);
  if (streetNear(P.xz, 2.0) > 1.3) return;
  vec2 fw = vec2(cos(a0.z), sin(a0.z));
  vec2 lf = vec2(-fw.y, fw.x);
  float seed = a1.w;
  vec3 o = ro - P;
  vec3 lo = vec3(dot(o.xz, fw), o.y, dot(o.xz, lf));
  vec3 ld = vec3(dot(rd.xz, fw), rd.y, dot(rd.xz, lf));
  vec3 inv = streetInv(ld);
  float best = hit.t;
  int part = -1;
  vec3 nb = vec3(0.0, 1.0, 0.0);
  vec3 n;
  // Frame and wheels, the handlebar, the basket at the front.
  float t = streetBox(lo, ld, inv, vec3(-0.85, 0.05, -0.05), vec3(0.85, 0.75, 0.05), n);
  if (t > 0.0 && t < best) { best = t; part = 0; nb = n; }
  t = streetBox(lo, ld, inv, vec3(0.42, 0.92, -0.3), vec3(0.5, 0.98, 0.3), n);
  if (t > 0.0 && t < best) { best = t; part = 0; nb = n; }
  t = streetBox(lo, ld, inv, vec3(0.55, 0.7, -0.17), vec3(0.85, 0.95, 0.17), n);
  if (t > 0.0 && t < best) { best = t; part = 3; nb = n; }
  // The rider, leaning to the bars.
  vec3 tn;
  t = streetEllipsoid(lo - vec3(-0.12, 1.1, 0.0), ld, vec3(0.2, 0.3, 0.2), tn);
  if (t > 0.0 && t < best) { best = t; part = 1; nb = tn; }
  t = streetSphere(lo, ld, vec3(0.08, 1.45, 0.0), 0.11);
  if (t > 0.0 && t < best) { best = t; part = 2; nb = normalize(lo + ld * t - vec3(0.08, 1.45, 0.0)); }
  if (a1.x > 0.02) {
    vec3 un;
    vec2 q;
    vec2 c = P.xz + fw * 0.1 + vec2(0.12 * K_wind, 0.0);
    float tu = streetUmbrella(ro, rd, c, 1.9, 0.5 * mix(0.18, 1.0, a1.x), seed * STREET_TAU, un, q);
    if (tu > 0.0 && tu < best) {
      bool clear = fract(seed * 5.71) < 0.45;
      if (clear) {
        if (tu < veil.t) {
          veil.t = tu;
          veil.kind = STREET_K_AGENT;
          veil.n = un;
          veil.albedo = STREET_BROLLY[0];
          veil.emit = vec3(0.0);
          veil.gloss = 0.9;
          veil.snow = 1.0;
          veil.id = id;
        }
      } else {
        best = tu;
        part = 4;
        nb = un;
      }
    }
  }
  if (part < 0) return;
  hit.t = best;
  hit.kind = STREET_K_AGENT;
  hit.id = id;
  hit.emit = vec3(0.0);
  hit.gloss = 0.3;
  hit.snow = 0.0;
  hit.n = part == 4 ? nb : vec3(nb.x * fw.x + nb.z * lf.x, nb.y, nb.x * fw.y + nb.z * lf.y);
  hit.albedo = part == 0 ? vec3(0.12, 0.13, 0.14)
             : part == 1 ? STREET_COAT[int(fract(seed * 3.71) * 8.0)]
             : part == 2 ? STREET_HAIR[int(fract(seed * 6.1) * 3.0)]
             : part == 3 ? vec3(0.3, 0.32, 0.34)
             : STREET_BROLLY[1 + int(fract(seed * 4.9) * 8.0)];
  if (part == 4) hit.snow = 1.0;
}

// Body paint: white, black and silver most of all; taxis black, deep green, yellow or white.
vec3 streetPaint(float seed, int kind) {
  float u = fract(seed * 3.97);
  if (kind == STREET_KIND_TAXI) return u < 0.45 ? vec3(0.05, 0.05, 0.06) : u < 0.7 ? vec3(0.06, 0.26, 0.18) : u < 0.86 ? vec3(0.95, 0.74, 0.1) : vec3(0.85, 0.85, 0.82);
  return u < 0.3 ? vec3(0.86, 0.86, 0.84) : u < 0.5 ? vec3(0.05, 0.05, 0.06) : u < 0.67 ? vec3(0.55, 0.57, 0.6)
       : u < 0.75 ? vec3(0.25, 0.27, 0.3) : u < 0.81 ? vec3(0.1, 0.15, 0.33) : u < 0.85 ? vec3(0.6, 0.08, 0.08)
       : u < 0.92 ? vec3(0.74, 0.69, 0.58) : vec3(0.48, 0.68, 0.64);
}

// A car, taxi, kei car or van: a body box and a cabin box, corners rounded as seen from above.
void streetCar(int id, vec4 a0, vec4 a1, vec3 ro, vec3 rd, inout StreetHit hit) {
  int kind = int(a0.w + 0.5);
  vec4 size = STREET_SIZE[kind];
  vec2 cab = STREET_CABIN[kind];
  vec3 P = vec3(a0.x, 0.0, a0.y + STREET_ZREF);
  if (streetNear(P.xz, size.w) > size.x * 0.5 + 0.6) return;
  vec2 fw = vec2(cos(a0.z), sin(a0.z));
  vec2 lf = vec2(-fw.y, fw.x);
  vec3 o = ro - P;
  vec3 lo = vec3(dot(o.xz, fw), o.y, dot(o.xz, lf));
  vec3 ld = vec3(dot(rd.xz, fw), rd.y, dot(rd.xz, lf));
  vec3 inv = streetInv(ld);
  float hl = size.x * 0.5;
  float hw = size.y * 0.5;
  float best = hit.t;
  int part = -1;
  vec3 nb = vec3(0.0, 1.0, 0.0);
  vec3 n;
  float t = streetBox(lo, ld, inv, vec3(-hl, 0.06, -hw), vec3(hl, size.z, hw), n);
  if (t > 0.0 && t < best) {
    vec3 q = lo + ld * t;
    vec2 c = max(abs(q.xz) - vec2(hl, hw) + 0.4, 0.0);
    if (length(c) < 0.4) { best = t; part = 0; nb = n; }
  }
  float inset = kind == STREET_KIND_KEI ? 0.06 : 0.12; // a kei car's boxy cabin is nearly as wide as it
  t = streetBox(lo, ld, inv, vec3(cab.x, size.z - 0.02, -hw + inset), vec3(cab.y, size.w, hw - inset), n);
  if (t > 0.0 && t < best) {
    vec3 q = lo + ld * t;
    vec2 c = max(abs(q.xz - vec2((cab.x + cab.y) * 0.5, 0.0)) - vec2((cab.y - cab.x) * 0.5, hw - inset) + 0.28, 0.0);
    if (length(c) < 0.28) { best = t; part = 1; nb = n; }
  }
  if (kind == STREET_KIND_TAXI) {
    t = streetBox(lo, ld, inv, vec3(-0.25, size.w - 0.01, -0.24), vec3(0.05, size.w + 0.2, 0.24), n);
    if (t > 0.0 && t < best) { best = t; part = 2; nb = n; }
  }
  if (part < 0) return;
  vec3 q = lo + ld * best;
  float seed = a1.w;
  vec3 paint = streetPaint(seed, kind);
  float on = smoothstep(0.18 + 0.12 * fract(seed * 7.7), 0.3 + 0.12 * fract(seed * 7.7), streetDark);
  hit.t = best;
  hit.kind = STREET_K_AGENT;
  hit.id = id;
  hit.n = vec3(nb.x * fw.x + nb.z * lf.x, nb.y, nb.x * fw.y + nb.z * lf.y);
  hit.q = q;
  hit.emit = vec3(0.0);
  hit.gloss = 0.7;
  hit.snow = nb.y > 0.5 ? 1.0 : 0.0;
  vec3 glassCol = vec3(0.03, 0.035, 0.045);
  if (part == 0) {
    hit.albedo = nb.y > 0.5 ? paint : paint * 0.72;
    if (q.y < 0.32) hit.albedo = vec3(0.03);
    if (nb.x > 0.5) {
      // The front: dark grille between the headlamps.
      float lamp = streetBand(abs(q.z), hw - 0.45, hw - 0.1, 0.01) * streetBand(q.y, 0.5, 0.72, 0.01);
      hit.albedo = mix(mix(hit.albedo, vec3(0.04), streetBand(q.y, 0.35, 0.62, 0.01) * step(abs(q.z), hw - 0.48)), vec3(0.9), lamp);
      hit.emit = vec3(1.0, 0.97, 0.9) * lamp * on * 2.5;
    } else if (nb.x < -0.5) {
      float lamp = streetBand(abs(q.z), hw - 0.42, hw - 0.08, 0.01) * streetBand(q.y, 0.62, 0.84, 0.01);
      hit.albedo = mix(hit.albedo, vec3(0.5, 0.05, 0.04), lamp);
      hit.emit = vec3(1.0, 0.08, 0.05) * lamp * (on * 0.8 + a1.x * 1.8);
    } else if (nb.y > 0.5) {
      // A shine of the sky along the bonnet and the boot.
      hit.emit = streetSkyLight(reflect(rd, hit.n)) * 0.12;
    }
  } else if (part == 1) {
    // Roof between the windscreen and the rear glass; windows round the cabin.
    bool roof = nb.y > 0.5 && q.x < cab.y - 0.7 && q.x > cab.x + 0.42;
    hit.albedo = roof ? paint : glassCol;
    hit.emit = streetSkyLight(reflect(rd, hit.n)) * (roof ? 0.12 : 0.3);
    if (!roof) hit.snow *= 0.3;
    // A taxi's red "vacant" light glows behind the windscreen.
    if (kind == STREET_KIND_TAXI && nb.y > 0.5 && q.x > cab.y - 0.7 && fract(seed * 13.1) < 0.6) {
      hit.emit += vec3(1.0, 0.15, 0.1) * 1.4 * step(length(vec2(q.x - cab.y + 0.25, q.z - hw * 0.45)), 0.13);
    }
  } else {
    hit.albedo = vec3(0.95, 0.92, 0.8);
    hit.emit = vec3(1.0, 0.86, 0.5) * on * 1.2;
  }
}

// One entry of the tile's body list (a channel of uSim1, 0 for none).
void streetAgent(float code, vec3 ro, vec3 rd, inout StreetHit hit, inout StreetHit veil) {
  int id = int(code * 255.0 + 0.5) - 1;
  if (id < 0) return;
  vec4 a0 = texelFetch(uSim0, ivec2(id, 0), 0);
  vec4 a1 = texelFetch(uSim0, ivec2(id, 1), 0);
  int kind = int(a0.w + 0.5);
  if (kind <= 0) return;
  if (kind <= STREET_KIND_CHILD || kind == STREET_KIND_PORTER) streetWalker(id, a0, a1, ro, rd, hit, veil);
  else if (kind == STREET_KIND_BIKE) streetBike(id, a0, a1, ro, rd, hit, veil);
  else streetCar(id, a0, a1, ro, rd, hit);
}

// A vehicle's lamps (an entry of the tile's light list): low beams and tail glow on p (normal n),
// their streaks in the wet street at the ground point (when ground), their glow in the air, and
// the spray its tyres throw off a wet road (when road). These lights move with the vehicle, and a
// soft gradient sliding over the street would step each colour channel at its own moment: each
// is switched per cell against th instead (its strength becomes the density of lit cells), so a
// passing beam lights a cell once and lets it go once.
void streetLamps(float code, vec3 p, vec3 n, vec3 ro, vec3 rd, float tHit, float rough, bool ground, bool road, float th, inout vec3 light, inout vec3 streaks, inout vec3 glow, inout vec4 spray) {
  int id = int(code * 255.0 + 0.5) - 1;
  if (id < 0) return;
  vec4 a0 = texelFetch(uSim0, ivec2(id, 0), 0);
  vec4 a1 = texelFetch(uSim0, ivec2(id, 1), 0);
  int kind = int(a0.w + 0.5);
  if (kind < STREET_KIND_BIKE || kind == STREET_KIND_PORTER) return;
  bool bike = kind == STREET_KIND_BIKE;
  float seed = a1.w;
  float on = smoothstep(0.18 + 0.12 * fract(seed * 7.7), 0.3 + 0.12 * fract(seed * 7.7), streetDark);
  vec4 size = STREET_SIZE[kind];
  vec2 P = vec2(a0.x, a0.y + STREET_ZREF);
  vec2 fw = vec2(cos(a0.z), sin(a0.z));
  vec2 lf = vec2(-fw.y, fw.x);
  float hl = size.x * 0.5;
  float hw = size.y * 0.5;
  vec2 front = P + fw * hl;
  vec2 rear = P - fw * hl;
  float brake = bike ? 0.0 : a1.x;
  vec3 head = (bike ? vec3(1.0, 0.95, 0.82) : fract(seed * 2.3) < 0.6 ? vec3(0.9, 0.95, 1.0) : vec3(1.0, 0.86, 0.66)) * on;
  vec3 tail = vec3(1.0, 0.08, 0.05) * (on * 0.35 + 0.75 * brake);
  // The low beam: a widening fan on the road ahead.
  vec2 d = p.xz - front;
  float a = dot(d, fw);
  float b = dot(d, lf);
  float reach = bike ? STREET_BIKE_BEAM : STREET_BEAM;
  if (a > 0.0 && a < reach && p.y < 2.5) {
    float wa = hw + 0.42 * a;
    float beam = (1.0 - smoothstep(0.55 * wa, wa, abs(b))) * exp(-a / (0.42 * reach)) * smoothstep(0.0, 1.2, a) * (1.0 - smoothstep(0.7 * reach, reach, a));
    float face = ground ? 1.0 : 0.3 + max(-dot(n.xz, fw), 0.0);
    light += head * step(th, beam * 1.5) * face * (bike ? 1.2 : 2.6);
  }
  vec2 dr = p.xz - rear;
  light += tail * step(th, exp(-dot(dr, dr) / 2.4)) * 1.4;
  // The lamps themselves: two heads, two tails (one each on a bicycle).
  vec2 toEye = normalize(vec2(STREET_CAM_X, 0.0) - P);
  float faceOn = smoothstep(-0.4, 0.7, dot(fw, toEye));
  float backOn = smoothstep(-0.4, 0.7, -dot(fw, toEye));
  for (int i = 0; i < 4; i++) {
    bool isHead = i < 2;
    if (bike && (i == 1 || i == 3)) continue;
    float s = (i == 0 || i == 2) ? -1.0 : 1.0;
    vec2 at = isHead ? front + lf * s * (bike ? 0.0 : hw - 0.28) : rear + lf * s * (bike ? 0.0 : hw - 0.22);
    vec3 L = vec3(at.x, isHead ? (bike ? 0.95 : 0.66) : (bike ? 0.7 : 0.8), at.y);
    vec3 c = isHead ? head * (0.25 + 0.75 * faceOn) : tail * (0.3 + 0.7 * backOn);
    float g = streetGlow(ro, rd, L, 0.6 + 0.4 * streetWet, tHit);
    glow += c * (step(th, min(g, 1.0)) * 0.4 + step(1.0, g) * 1.1);
    if (ground && rough >= 0.0) streaks += c * step(th, streetStreak(p.xz, L, rough)) * (isHead ? 0.45 : 0.65);
    // Blinkers: amber on the turning side, front and back; hazards (2) on both sides at once.
    if (!bike && a1.y != 0.0 && (s == a1.y || a1.y > 1.5)) {
      float blink = step(0.5, fract(streetTm * 1.5 + seed * 3.0));
      glow += STREET_AMBER * blink * step(th, min(streetGlow(ro, rd, L + vec3(isHead ? -0.05 : 0.05, 0.0, 0.0), 0.3, tHit), 1.0)) * 0.6;
    }
  }
  // Spray behind the tyres on a wet road.
  if (road && streetWet > 0.25 && !bike) {
    float speed = a1.z;
    float behind = -dot(p.xz - rear, fw);
    float off = abs(dot(p.xz - rear, lf)) - (hw - 0.3);
    float len = 0.6 + 0.3 * speed;
    if (behind > -0.5 && behind < len && abs(off) < 0.3 + 0.25 * max(behind, 0.0)) {
      vec2 cq = vec2((behind - streetTm * speed * 0.6) / 0.12, (off + 1.0) / 0.12);
      float dens = smoothstep(0.8, 4.0, speed) * smoothstep(0.25, 0.8, streetWet) * (1.0 - max(behind, 0.0) / len) * 0.55;
      if (hash12(floor(cq) + floor(seed * 97.0)) > 1.0 - dens) spray = vec4(tail * 0.6 + head * 0.15 + streetAmbient * 0.8 + 0.06, 1.0);
    }
  }
}

// The passage's tilt of the camera (rad above its rest pitch; sim.ts passageTilt is its twin): coming
// down from the skyline, on its way from the first frame and braking into a touch of overshoot, then
// settled; going out it rises faster and faster. 0 at rest.
float streetTiltAt() {
  float pin = passageIn();
  float pout = passageOut();
  if (pin >= 1.0 && pout <= 0.0) return 0.0;
  float settle = passageSettle(pin / STREET_TILT_ARRIVE, 0.8);
  return STREET_TILT_IN * (1.0 - settle) + STREET_TILT_OUT * pout * pout;
}

// Where rain or snow falling along dir seems to come from or go to, seen from the window: the
// camera is pitched down (cp, sp: the cosine and sine of the pitch a cell was traced with, the
// passage's tilt included), so the paths converge below the street, and the point moves with the
// camera.
vec3 streetVanish(vec3 dir, float cp, float sp) {
  return rainVanish(dir, vec3(1.0, 0.0, 0.0), vec3(0.0, cp, sp), vec3(0.0, -sp, cp), STREET_FOCAL);
}

// Snow past the window on the motion clock tm: the flakes close in on the point under the eye, as the
// rain's paths do.
Precip streetSnow(vec2 uv, float aspect, float tm, float depth, float cp, float sp) {
  return snowFallSeen(uv, aspect, tm, K_snow, K_wind, depth, streetVanish(snowFallDir(K_snow, K_wind), cp, sp));
}

// The hour, and the weather over it: rain or snow close the sky, flatten and dim the light; at
// night the city's own light bounces about, warmer under low cloud. Sets the clock, sky and light
// globals above for everything the cell then draws.
void streetHour() {
  streetTm = uMotionTime;
  streetSky = skyMoonPhase(skyAt(timeOfDayM(K_time, skyDays())), K_moon);
  streetStorm = clamp(max(K_rain, 0.85 * K_snow), 0.0, 1.0);
  streetOver = clamp(streetStorm * 8.0, 0.0, 1.0) * (0.65 + 0.35 * streetStorm);
  streetSky.sunColor *= 1.0 - 0.85 * streetOver;
  streetSky.moonColor *= 1.0 - 0.75 * streetOver;
  streetSky.ambient = mix(streetSky.ambient, vec3(dot(streetSky.ambient, LUMA)), 0.5 * streetOver) * (1.0 - 0.35 * streetStorm);
  streetDark = clamp(1.0 - streetSky.day * (1.0 - 0.5 * streetOver), 0.0, 1.0);
  streetSun = streetSky.sunColor * 1.5;
  // At night the sky's light all but goes: the street is lit by its own lamps, shops, signs and
  // headlights, with only a faint warm bounce between them (more under low cloud, which the city
  // lights from below).
  streetBounce = vec3(0.034, 0.028, 0.024) * streetDark * (1.0 + 0.8 * streetOver);
  streetAmbient = streetSky.ambient * mix(1.4, 0.4, streetDark) + streetBounce;
  streetDeck = mix(vec3(dot(streetSky.ambient, LUMA)) * 1.5, vec3(0.13, 0.1, 0.09), streetDark) * (1.0 - 0.3 * streetStorm);
  streetWet = uWeather.x;
  streetLying = uWeather.y;
  streetLit = clamp(K_windows * (0.35 + 0.65 * streetDark), 0.0, 1.0);
}

Shade sceneStreet(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  streetHour();
  if (uSimOn.z > 0.5) {
    streetSignal[0] = texelFetch(uSim2, ivec2(0, 0), 0);
    streetSignal[1] = texelFetch(uSim2, ivec2(1, 0), 0);
    streetSignal[2] = texelFetch(uSim2, ivec2(2, 0), 0);
  } else {
    streetSignal[0] = vec4(1.0, 0.0, 0.0, 0.0);
    streetSignal[1] = vec4(0.0, 0.0, 1.0, 0.0);
    streetSignal[2] = vec4(0.0, 1.0, 0.0, 0.0);
  }

  // The cell's ray from the window, and where it meets the street.
  vec2 s = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  streetTilt = streetTiltAt();
  float cp = cos(STREET_PITCH);
  float sp = sin(STREET_PITCH);
  if (streetTilt != 0.0) {
    cp = cos(STREET_PITCH - streetTilt);
    sp = sin(STREET_PITCH - streetTilt);
  }
  vec3 ro = vec3(STREET_CAM_X, STREET_CAM_H, 0.0);
  vec3 rdView = normalize(vec3(s.x, s.y * cp - STREET_FOCAL * sp, s.y * sp + STREET_FOCAL * cp));
  // Raised, the view can reach the horizon and the sky: those cells are traced as a ray just under
  // the horizon (so nothing below divides by a ray that never meets the street) and replaced by the
  // city beyond once shaded.
  bool skyward = streetTilt > 0.0 && rdView.y > -0.004;
  vec3 rd = skyward ? normalize(vec3(rdView.x, -0.004, rdView.z)) : rdView;
  vec3 inv = streetInv(rd);
  float tg = -ro.y / rd.y;
  vec3 G = ro + rd * tg;
  streetG = G;
  streetLean = rd.xz / rd.y;
  float fw = tg / (STREET_FOCAL * uRes.y);
  // The cell's own threshold, offset from the palette's, for lights that move with the traffic.
  float lampTh = threshold(cell + vec2(5.0, 1.0));

  StreetHit hit = streetMiss();
  hit.t = tg;
  hit.kind = STREET_K_GROUND;
  StreetHit veil = streetMiss();
  vec3 signHalo = vec3(0.0);
  streetStatics(ro, rd, inv, hit, signHalo);

  // Who stands in the way: the simulation lists them for the tile under the ray.
  ivec2 tile = ivec2(floor((G.xz - vec2(STREET_TILE_X0, STREET_TILE_Z0)) / STREET_TILE));
  bool inGrid = uSimOn.x > 0.5 && uSimOn.y > 0.5 && tile.x >= 0 && tile.y >= 0 && tile.x < STREET_TILES_X && tile.y < STREET_TILES_Z;
  if (inGrid) {
    for (int k = 0; k < STREET_BODY_TEXELS; k++) {
      vec4 ids = texelFetch(uSim1, ivec2(tile.x * STREET_TILE_TEXELS + k, tile.y), 0);
      if (ids.x <= 0.0) break;
      streetAgent(ids.x, ro, rd, hit, veil);
      streetAgent(ids.y, ro, rd, hit, veil);
      streetAgent(ids.z, ro, rd, hit, veil);
      streetAgent(ids.w, ro, rd, hit, veil);
    }
  }
  // Beyond the near blocks: the sky, and whatever a ray lands on behind the blocks' roofs.
  bool beyond = skyward || (streetTilt > 0.0 && hit.kind == STREET_K_GROUND && G.z > STREET_FACADE_FAR && abs(G.x) > STREET_SIDE_FACADE);

  vec3 P = ro + rd * hit.t;
  vec3 n = hit.n;
  bool ground = hit.kind == STREET_K_GROUND;
  vec4 info = vec4(0.0);
  vec3 albedo = hit.albedo;
  if (ground) albedo = streetGround(P.xz, fw, info);
  float shelter = info.w;
  float wet = streetWet * (1.0 - shelter);
  float puddle = 0.0;
  if (ground && wet > 0.35) puddle = rainPuddles(P.xz, wet * (info.x > 0.5 ? 0.85 : 1.0));
  float rough = mix(0.34, 0.02, puddle);

  // Light on the point: sky, sun, street lamps, shops; the lamps' glow along the ray and their
  // streaks in the wet street; then the vehicles' lamps.
  vec3 E = streetAmbient * (0.55 + 0.45 * n.y) + streetBounce * 0.35;
  if (streetSky.sun.y > 0.0) E += streetSun * max(dot(n, streetSky.sun), 0.0) * streetSunlit(P);
  vec3 glow = signHalo;
  vec3 streaks = vec3(0.0);
  float green = 0.0;
  for (int i = 0; i < STREET_LAMPS; i++) {
    vec4 l = STREET_LAMP[i];
    float lit = smoothstep(0.0, 0.06, streetDark - (0.18 + 0.16 * hash12(vec2(float(i), 4.1))));
    if (lit <= 0.0) continue;
    // Warm white along the avenue and over the crossing, old sodium up the side street.
    vec3 c = (l.w > 0.5 ? vec3(1.0, 0.58, 0.24) * 2.4 : vec3(1.0, 0.84, 0.62) * 2.7) * lit;
    vec3 L = vec3(STREET_LAMP_HEAD[i].x, l.z - 0.3, STREET_LAMP_HEAD[i].y);
    vec3 dl = L - P;
    float d2 = dot(dl, dl);
    // The luminaire throws its light down in a cone: a bright pool some seven metres across under
    // it, falling away fast beyond, a little stray light further out.
    float cone = 0.1 + 0.9 * smoothstep(0.42, 0.86, dl.y * inversesqrt(d2));
    E += c * max(dot(n, dl) * inversesqrt(d2), 0.0) * cone * 52.0 / (d2 + 18.0);
    glow += c * streetGlow(ro, rd, L, 0.9 + 1.6 * max(K_fog, K_rain), hit.t) * 0.22;
    // The cone itself in the air, faint in clear air, plain in rain and fog: where the ray passes
    // nearest the lamp's axis, inside the cone's widening radius, in front of what it meets.
    float yy = clamp(dot(L.xz - G.xz, streetLean) / max(dot(streetLean, streetLean), 1e-6), 0.0, L.y - 0.3);
    float dd = length(G.xz + streetLean * yy - L.xz);
    float rad = 0.2 + 0.72 * (L.y - yy);
    float shown = (ro.y - yy) / -rd.y < hit.t ? 1.0 : 0.0;
    glow += c * exp(-dd * dd / (rad * rad)) * shown * (0.02 + 0.1 * max(K_fog, streetStorm)) * smoothstep(0.0, 1.0, L.y - yy);
    if (ground && wet > 0.05) streaks += c * streetStreak(P.xz, L, rough) * 0.35;
  }
  E += streetSpill(P) * (0.5 + 0.5 * max(n.y, 0.0) + 0.4 * max(n.z, 0.0));
  // The lit street throws a little light back up onto the people and cars in it.
  if (hit.kind == STREET_K_AGENT) E += vec3(0.15, 0.13, 0.11) * streetDark;
  // The signals' lamps: glow in the air and streaks in the wet street.
  for (int i = 0; i < ${CAR_HEADS.length}; i++) {
    vec4 h = STREET_CAR_HEAD[i];
    vec4 sg = streetSignal[STREET_CAR_HEAD_META[i].y];
    vec2 left = vec2(h.w, -h.z);
    vec2 toEye = normalize(vec2(STREET_CAM_X, 0.0) - h.xy);
    float facing = 0.25 + 0.75 * smoothstep(-0.3, 0.6, dot(h.zw, toEye));
    for (int k = 0; k < 3; k++) {
      float on = k == 0 ? sg.x : k == 1 ? sg.y : sg.z;
      if (on < 0.01) continue;
      vec3 lc = (k == 0 ? STREET_GO : k == 1 ? STREET_AMBER : STREET_STOP) * on;
      vec2 at = h.xy + left * (0.42 - 0.42 * float(k)) + h.zw * 0.2;
      vec3 L = vec3(at.x, 5.55, at.y);
      vec3 gc = lc * (streetGlow(ro, rd, L, 0.7 + 1.2 * max(K_fog, K_rain), hit.t) * 0.35 * facing);
      vec3 sc = ground && wet > 0.05 ? lc * streetStreak(P.xz, L, rough) * 0.5 * facing : vec3(0.0);
      glow += gc;
      streaks += sc;
      if (k == 0) green += dot(gc + sc, vec3(0.33));
    }
  }
  for (int i = 0; i < ${WALK_HEADS.length}; i++) {
    vec4 h = STREET_WALK_HEAD[i];
    vec2 toEye = normalize(vec2(STREET_CAM_X, 0.0) - h.xy);
    float facing = 0.2 + 0.8 * smoothstep(-0.3, 0.6, dot(h.zw, toEye));
    vec4 sg = streetSignal[2];
    vec3 L = vec3(h.x + h.z * 0.15, 2.75, h.y + h.w * 0.15);
    vec3 gc = (STREET_GO * sg.x * streetGlow(ro, rd, L - vec3(0.0, 0.21, 0.0), 0.45, hit.t) + STREET_STOP * sg.y * streetGlow(ro, rd, L + vec3(0.0, 0.21, 0.0), 0.45, hit.t)) * 0.3 * facing;
    vec3 sc = ground && wet > 0.05 ? (STREET_GO * sg.x * streetStreak(P.xz, L - vec3(0.0, 0.21, 0.0), rough) + STREET_STOP * sg.y * streetStreak(P.xz, L + vec3(0.0, 0.21, 0.0), rough)) * 0.45 * facing : vec3(0.0);
    glow += gc;
    streaks += sc;
    green += (dot(gc, vec3(0.33)) + dot(sc, vec3(0.33))) * sg.x / max(sg.x + sg.y, 1e-3);
  }
  vec4 spray = vec4(0.0);
  if (inGrid) {
    bool road = ground && info.x < 0.5;
    for (int k = 0; k < STREET_LIGHT_TEXELS; k++) {
      vec4 ids = texelFetch(uSim1, ivec2(tile.x * STREET_TILE_TEXELS + STREET_BODY_TEXELS + k, tile.y), 0);
      if (ids.x <= 0.0) break;
      streetLamps(ids.x, P, n, ro, rd, hit.t, rough, ground, road, lampTh, E, streaks, glow, spray);
      streetLamps(ids.y, P, n, ro, rd, hit.t, rough, ground, road, lampTh, E, streaks, glow, spray);
      streetLamps(ids.z, P, n, ro, rd, hit.t, rough, ground, road, lampTh, E, streaks, glow, spray);
      streetLamps(ids.w, P, n, ro, rd, hit.t, rough, ground, road, lampTh, E, streaks, glow, spray);
    }
  }

  // What lights a raindrop here: the cloud base, the light round it, the glows it falls through.
  vec3 dropLight = max(streetDeck * 1.2 + E * 0.25 + glow * 0.4, vec3(0.08));

  // The surface.
  vec3 col;
  float accent = 0.0;
  float snowy = 0.0;
  vec3 snowLit = vec3(0.82, 0.86, 0.94) * E * 0.95 + 0.02;
  if (ground) {
    float porous = info.x > 0.5 ? 0.4 : 0.25;
    vec3 a = wetten(albedo, wet, porous);
    col = a * E;
    // Snow lies on the street but for the wheel tracks and where people walk.
    if (streetLying > 0.0) {
      float cover = snowCover(vec3(0.0, 1.0, 0.0), P.xz, streetLying);
      if (info.x < 0.5) {
        float zz = P.z < STREET_MID ? min(abs(P.z - STREET_WB_IN), abs(P.z - STREET_WB_OUT)) : min(abs(P.z - STREET_EB_IN), abs(P.z - STREET_EB_OUT));
        float xx = min(abs(P.x - STREET_SB), abs(P.x - STREET_NB));
        float tracks = P.z < STREET_KERB_FAR ? zz : xx;
        cover *= 0.25 + 0.75 * smoothstep(0.12, 0.32, abs(tracks - 0.78));
        cover *= 1.0 - 0.55 * info.y;
      } else {
        cover *= 0.65 + 0.35 * smoothstep(0.2, 0.9, abs(fract(P.z / 7.0) - 0.5));
      }
      cover *= 1.0 - shelter;
      snowy = cover;
    }
    // Wet: the street mirrors the city, sharper in the puddles, ringed where drops land.
    float gloss = wetGloss(wet, 1.0);
    if (gloss > 0.01) {
      vec3 rr = reflect(rd, vec3(0.0, 1.0, 0.0));
      vec3 ring = vec3(0.0);
      if (puddle > 0.0 && K_rain > 0.0) {
        ring = rainRipples(P.xz * 2.4, uFallTime, K_rain);
        rr = normalize(rr + vec3(ring.x, 0.0, ring.y) * 0.04);
      }
      float mirror = mix(gloss * 0.32, 0.72, puddle) * (1.0 - snowy);
      vec3 seen = streetMirror(P, rr, rough);
      col = col * (1.0 - 0.45 * puddle) + seen * mirror + streaks * mirror * 2.2;
      // The rings' crests catch the light, switched per cell (they move).
      col += dropLight * 0.35 * step(lampTh, ring.z) * puddle;
      accent += green * mirror * 1.5;
    }
    // The landmark's paint shows in the accent colour.
    accent = max(accent, info.z * step(0.5, K_mark) * 0.75);
  } else if (hit.kind == STREET_K_FACADE) {
    vec3 a;
    vec3 em;
    float gl;
    // Metres a cell spans on the wall: far more along it where the side street's walls are seen
    // edge-on, so their windows fuse into an even glow instead of aliasing.
    float mpc = hit.t / (STREET_FOCAL * uRes.y);
    vec2 blur = vec2(mpc / max(abs(dot(rd, n)), 0.08), mpc * 1.4);
    streetFacade(int(hit.q.x + 0.5), hit.q.y, hit.q.z, blur, false, a, em, gl);
    a = wetten(a, wet * 0.5, 0.3);
    // The shop fronts and signs bloom softly onto the wall round them.
    vec3 bloom = streetLitBand(int(hit.q.x + 0.5), hit.q.y, hit.q.z, 0.5, 0.7, 0.7) * 0.28 * streetDark;
    col = a * E * 0.85 + em + bloom + gl * streetSkyLight(reflect(rd, n)) * 0.45;
  } else {
    vec3 a = wetten(albedo, wet * (hit.kind == STREET_K_AGENT ? 0.6 : 0.8), 0.3);
    col = a * E + hit.emit;
    col += hit.gloss * wetGloss(wet, max(n.y, 0.0)) * streetSkyLight(reflect(rd, n)) * 0.25;
    // The green lamps (car signals and the green man) glow in the accent colour.
    if (hit.kind == STREET_K_SIGNAL) accent += max(hit.emit.g - hit.emit.r, 0.0) * 0.5;
    if (streetLying > 0.0 && hit.snow > 0.0) snowy = snowCover(n, P.xz + P.y, streetLying) * hit.snow;
  }
  col = mix(col, snowLit, snowy);
  // A clear vinyl umbrella: the city's light through it and on it.
  if (veil.t < hit.t) {
    vec3 vp = ro + rd * veil.t;
    vec3 ve = streetAmbient * (0.6 + 0.4 * veil.n.y) + E * 0.5;
    vec3 sheen = streetSkyLight(reflect(rd, veil.n)) * 0.25 + wetGloss(streetWet, veil.n.y) * 0.12;
    vec3 vc = veil.albedo * ve + sheen;
    if (streetLying > 0.0) vc = mix(vc, snowLit, snowCover(veil.n, vp.xz, streetLying));
    col = mix(col, vc, 0.45);
    accent *= 0.6;
  }
  // Spray behind tyres.
  col = mix(col, spray.rgb, spray.a * 0.8);

  // Splashes on hard ground; drips from the awnings' edges.
  if (ground && K_rain > 0.0 && shelter < 0.5) {
    float cpm = 1.0 / fw;
    float splash = rainSplashes(P.xz, uFallTime, K_rain) * smoothstep(13.0, 18.0, cpm);
    col = mix(col, dropLight, splash * 0.85);
  }
  if (K_rain > 0.0 || streetWet > 0.1) {
    float amount = max(K_rain, 0.4 * streetWet);
    float tf = (STREET_FACADE_FAR - 1.1 - ro.z) / rd.z;
    vec3 qf = ro + rd * tf;
    if (tf < hit.t && abs(qf.x) > STREET_SIDE_FACADE && qf.y > 0.0 && qf.y < 2.62) {
      int f = qf.x < 0.0 ? 0 : 1;
      float u = abs(qf.x) - STREET_SIDE_FACADE;
      int b = streetBuildingAt(f, u);
      vec4 A = STREET_BLD_A[b];
      if (streetHasAwning(STREET_BLD_B[b]) && u - A.x > 0.35 && A.y - u > 0.35) {
        col = mix(col, dropLight * 1.2, rainDrips(vec2(u, 2.62 - qf.y), uFallTime, amount, 1.0));
      }
    }
  }

  // Raised toward the skyline: over the roofs the city beyond and its sky; what is far in the
  // streets fades into the haze (nothing at rest reaches that far).
  if (streetTilt > 0.0) {
    if (beyond) {
      col = streetBeyond(rdView);
      accent = 0.0;
      glow = vec3(0.0);
      hit.t = 800.0;
    } else if (hit.t > 130.0) {
      col = mix(col, streetHaze(rdView), smoothstep(130.0, 520.0, hit.t));
    }
  }
  // The air: lamp glow, then fog, then the falling rain or snow.
  float wetAir = 1.0 + 1.5 * max(K_fog, streetStorm);
  col += glow * wetAir;
  accent += green * 0.6;
  if (K_fog > 0.0) {
    vec3 fogCol = streetAmbient * 1.4 + streetBounce * 2.0 + glow * 0.3;
    col = mix(col, fogCol, fogAmount(K_fog * 1.4, hit.t / 90.0, P.y / 12.0));
  }
  float depth = weatherDepth(hit.t);
  if (K_rain > 0.0) {
    // From the window the rain falls past a camera pitched down: its paths converge below the street.
    Precip pr = rainFallSeen(uv, aspect, streetTm, uFallTime, K_rain, K_wind, depth, streetVanish(rainFallDir(K_rain, K_wind), cp, sp));
    vec3 air = streetDeck * 0.9 + streetBounce + glow * 0.25;
    col = mix(col, air, pr.veil);
    // At the window there are no drops at arm's length.
    col = mix(col, dropLight * 1.1, pr.cover * (1.0 - pr.near));
  }
  if (K_snow > 0.0) {
    Precip ps = streetSnow(uv, aspect, streetTm, depth, cp, sp);
    vec3 air = mix(streetDeck * 1.3, vec3(0.75, 0.78, 0.85) * (streetAmbient + 0.1), 0.5) + glow * 0.3;
    col = mix(col, air, ps.veil);
    col = mix(col, max(vec3(0.8, 0.83, 0.9) * (streetDeck * 1.6 + E * 0.4 + glow * 0.5), vec3(0.1)), ps.cover);
  }

  // Ink is the picture's light; the green of the signals (and the M, when painted) is the accent. A
  // sunlit street puts the page in its paper theme (index.ts), where inkOf makes ink dark on light.
  return shadeOf(col, inkOf(col, 1.3, 0.8), clamp(accent, 0.0, 1.0));
}
`;
