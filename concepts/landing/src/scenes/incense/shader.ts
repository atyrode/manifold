// The incense's layers (layers.ts) on the `interior` composer (composer/room.ts), back to front: the
// shaft wall (the backdrop: a dark room, light from a window off to the left lying on the plaster as
// a tall pane, crossed by the shadows of what stands in the room, roomCaster; the M of lamplight on
// it; and, as its front veil, the hazy shaft the light crosses the room in); the low table (the
// ground), the light spilling onto its top; the incense (a dressing), standing dark against that
// light, its candle, and its smoke (simulated in sim.ts), which glows where it drifts through the
// shaft and whose shadow, with the incense's, is its caster; then, its front veil, the dust motes in
// the light, the ember and the candle's flame.
// The incense's fields (sim.ts):
//   incenseField0  dye: r smoke, g heat, b fresh smoke (b / r: how young it is)
//   incenseField1  velocity, frame heights per second
//   incenseField2  the burner: texel 0 ember (from the anchor), glow, presence; texel 1 progress, ash
//                  length, ash curl, ash pieces in the dish; texel 2 falling ash (seconds, from x, y,
//                  length)
//   incenseField3  dust motes
// Without field 0 (no float render targets) an analytic plume stands in for the fluid.
// Knobs read here: the shaft wall's K_window, K_room, K_mark (the shaft's slant and colour are the
// World's sun or moon through the room's window off to the left: roomSun, roomMoon); the incense's K_stick,
// K_dust, K_candle. The cell's state (incenseBegin) reads both, as the layers stand in one room.
import type { SharedGlsl } from "../../composer/types.ts";
import { incenseLayoutGlsl, incensePassageGlsl, incenseShapesGlsl } from "./sim.ts";

const incenseShared = `
${incenseLayoutGlsl}
${incenseShapesGlsl}
${incensePassageGlsl}
#define INCENSE_TABLE_BACK (INCENSE_FLOOR + 0.07)  // where the table top meets the wall
#define INCENSE_TABLE_FRONT 0.045   // the table top's front edge; its front face below
#define INCENSE_DEPTH 0.12          // how far in front of the wall the incense stands, along the light
#define INCENSE_POOL_W 0.23         // half the width of the window's light on the wall
#define INCENSE_POOL_H 0.44         // half its height
#define INCENSE_HAZE 0.07           // light the hazy air scatters out of the shaft
#define INCENSE_DENSE 3.2           // smoke cover per unit of dye
#define INCENSE_SHADOW 60.0         // light lost per unit of dye and frame height, toward the window
#define INCENSE_WALL_SHADOW 2.5     // shadow on the wall per unit of dye in front of it
#define INCENSE_STICK_HW 0.0022     // half the stick's width
#define INCENSE_FLAME_W 0.0068      // half the candle flame's width

const vec3 INCENSE_EMBER = vec3(1.0, 0.36, 0.08);
const vec3 INCENSE_EMBER_CORE = vec3(1.0, 0.74, 0.42);
const vec3 INCENSE_ASH = vec3(0.5, 0.49, 0.47);
const vec3 INCENSE_STICK_COLOR = vec3(0.13, 0.085, 0.06);  // agarwood brown
const vec3 INCENSE_CONE_COLOR = vec3(0.17, 0.1, 0.065);
const vec3 INCENSE_COIL_COLOR = vec3(0.1, 0.13, 0.075);    // a green temple coil
const vec3 INCENSE_GLAZE = vec3(0.1, 0.13, 0.12);          // celadon gone nearly black
const vec3 INCENSE_SAND = vec3(0.32, 0.31, 0.29);          // the ash-sand in the dish
const vec3 INCENSE_BRASS = vec3(0.24, 0.17, 0.08);
const vec3 INCENSE_STONEWARE = vec3(0.085, 0.095, 0.09);
const vec3 INCENSE_WAX = vec3(0.86, 0.8, 0.68);
const vec3 INCENSE_FLAME_LIGHT = vec3(1.0, 0.64, 0.32);
const vec3 INCENSE_FRESH = vec3(0.74, 0.86, 1.12);         // young smoke: fine particles scatter blue
const vec3 INCENSE_AGED = vec3(1.0, 0.96, 0.9);            // older smoke: grown particles, neutral
const vec3 INCENSE_MARK_LIGHT = vec3(1.0, 0.66, 0.34);     // lamplight from the next room
const vec3 INCENSE_SUMI = vec3(0.24, 0.27, 0.34);          // smoke on washi, read as ink
const vec3 INCENSE_SHEEN = vec3(0.55, 0.45, 0.38);         // the light's glint along a stick's edge


// Set once per cell by incenseBegin, read by the layers.
vec2 incenseP;          // the cell on the incense's frame: frame heights from its bottom left
float incenseAa;
float incenseKind;      // 0 stick, 1 cone, 2 coil, 3 waterfall
bool incensePaper;      // the page's paper theme (the washi room)
vec4 incenseS1;
vec4 incenseS2;
vec2 incenseBase;       // where the incense stands on the table
vec2 incenseSource;
vec2 incenseEmber;
float incenseHeat;
float incensePresence;
vec3 incenseLightCol;
vec2 incenseDir;
vec2 incenseCentre;
vec2 incensePool;
float incenseSlope;
float incenseBand;
vec3 incenseAmbient;
vec2 incenseFlame;
float incenseFlameOn;
vec2 incenseFlameBase;
float incenseLean;
float incenseShaftHere; // the window's light at the incense's plane in this cell
float incenseHazeHere;  // the shaft in the hazy air
float incenseLitHere;   // how much of it the smoke between here and the window lets through
vec3 incenseWarm;       // the candle's and the ember's light on the wall and the table
vec2 incenseMarkAt;     // the M of light's centre
float incenseMark;      // the M of light in the air here, times its brightness

// The window's light: the World's sun, or once it is down its moon, through the room's window off to
// the left (roomShellBegin: turned by the way the room faces), its colour at full brightness, faded
// out as it fails (a new moon, a closed sky); and the way it comes in, toward it.
vec3 incenseKey(out vec3 toward) {
  bool sun = dot(roomSunLight, vec3(1.0)) > 0.02;
  vec3 key = sun ? roomSunLight : roomMoonLight;
  toward = sun ? roomSun : roomMoon;
  float peak = max(key.r, max(key.g, key.b));
  return key / max(peak, 1e-4) * smoothstep(0.0, 0.06, peak);
}

// The wall: ink, indigo, umber, or pale washi paper.
vec3 incenseWallColor() {
  if (K_room < 0.5) return vec3(0.03, 0.03, 0.034);
  if (K_room < 1.5) return vec3(0.022, 0.028, 0.052);
  if (K_room < 2.5) return vec3(0.058, 0.04, 0.03);
  return vec3(0.84, 0.81, 0.74);
}

// Plaster in the window's light: the colour the pool takes.
vec3 incensePlaster() {
  if (K_room < 0.5) return vec3(0.15, 0.15, 0.16);
  if (K_room < 1.5) return vec3(0.13, 0.14, 0.18);
  if (K_room < 2.5) return vec3(0.2, 0.15, 0.12);
  return vec3(0.85, 0.82, 0.76);
}

vec3 incenseTableColor() {
  if (K_room < 0.5) return vec3(0.042, 0.034, 0.03);
  if (K_room < 1.5) return vec3(0.03, 0.028, 0.044);
  if (K_room < 2.5) return vec3(0.075, 0.048, 0.032);
  return vec3(0.46, 0.36, 0.27);
}

// Approximate signed distance to an ellipse of radii r (after Quilez): close enough for its outline.
float incenseEllipse(vec2 q, vec2 r) {
  float k0 = length(q / r);
  float k1 = length(q / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

// The window's light where it falls on the wall at w: a tall pane, its sides upright, its top and
// bottom slanting with the light, crossed by its transom bar; soft-edged.
float incenseWindow(vec2 w) {
  vec2 r = w - incensePool;
  float v = r.y - incenseSlope * r.x;
  float side = 1.0 - smoothstep(INCENSE_POOL_W - 0.03, INCENSE_POOL_W + 0.03, abs(r.x));
  float ends = 1.0 - smoothstep(INCENSE_POOL_H - 0.03, INCENSE_POOL_H + 0.03, abs(v));
  float bar = 1.0 - 0.35 * (1.0 - smoothstep(0.007, 0.02, abs(v - 0.14)));
  return side * ends * bar;
}

// The light reaching the incense's plane at p: it carries on to the wall INCENSE_DEPTH further on.
// Smoke and solids there are lit by it; outside it they stay dim.
float incenseShaft(vec2 p) {
  return incenseWindow(p + incenseDir * INCENSE_DEPTH);
}

// The window's light spilling past the foot of the wall onto the table top at p (and whatever
// stands low on it), reaching further right as the table comes nearer.
float incenseSpill(vec2 p) {
  float nearer = max(INCENSE_TABLE_BACK - p.y, 0.0);
  return incenseWindow(vec2(p.x - 0.9 * nearer, INCENSE_TABLE_BACK + 0.01)) * (1.0 - 0.5 * nearer / INCENSE_TABLE_BACK) * (1.0 - smoothstep(INCENSE_TABLE_BACK, INCENSE_TABLE_BACK + 0.05, p.y));
}

// The window's light on a solid standing at p: in the shaft, or in the spill on the table.
float incenseLit(vec2 p) {
  return max(incenseShaft(p), incenseSpill(p));
}

// The shaft seen in the hazy air: the band the window's light sweeps on its way down to the wall,
// fading out where it lands.
float incenseHaze(vec2 p) {
  vec2 r = p - incensePool;
  float across = abs(dot(r, vec2(-incenseDir.y, incenseDir.x)));
  return (1.0 - smoothstep(incenseBand - 0.06, incenseBand + 0.04, across)) * smoothfall(0.3, -0.25, dot(r, incenseDir));
}

// Without the fluid: a thread that sways, widens and breaks into wavering veils.
vec4 incenseAnalytic(vec2 p) {
  vec2 src = incenseSource;
  float h = p.y - src.y;
  if (h < -0.005) return vec4(0.0);
  float tm = uMotionTime;
  float rise = smoothstep(0.08, 0.45, h);
  float axis = src.x - 0.03 * h + 0.025 * h * sin(0.21 * tm) + 0.02 * rise * sin(19.0 * h - 0.8 * tm);
  axis += 0.07 * rise * min(1.0, h / 0.45) * (vnoise(vec2(3.0 * p.x, 4.0 * p.y - 0.25 * tm)) - 0.5) + 0.12 * smoothstep(0.35, 0.65, h);
  // The exit's draught leans the whole plume over to the right.
  float outU = passageOut();
  if (outU > 0.0) axis += outU * outU * 1.2 * (h + 0.1);
  float w = 0.0035 + 0.09 * rise * min(1.0, h / 0.5);
  float dx = (p.x - axis) / w;
  float veil = mix(1.0, 0.25 + 1.5 * vnoise(vec2(14.0 * p.x, 10.0 * p.y - 0.4 * tm)), rise);
  float r = 0.5 * pow(0.0035 / w, 0.6) * exp(-dx * dx) * veil * smoothstep(-0.005, 0.004, h) * (1.0 - smoothstep(0.93, 1.0, p.y));
  // The entrance: the head climbs out of the ember (sim.ts riseHead); the exit cuts the thread off above the ember, the cut climbing away.
  float inU = passageIn();
  if (inU < 1.0) {
    float s = clamp((inU - INCENSE_RISE_FROM) / (INCENSE_RISE_TO - INCENSE_RISE_FROM), 0.0, 1.0);
    float head = max(INCENSE_RISE_TOP - src.y, 0.0) * (1.0 - (1.0 - s) * (1.0 - s));
    r *= 1.0 - smoothstep(head - 0.03, head, h);
  }
  if (outU > 0.0) r *= 1.0 - smoothstep(0.0, INCENSE_BREAK, outU) * (1.0 - smoothstep(0.0, 0.05, h - 0.5 * outU));
  return vec4(r, 0.0, r * exp(-3.2 * max(h, 0.0)), 0.0);
}

// The smoke at uv (the incense's field 0, or the analytic plume without it); none with the incense off.
vec4 incenseDye(vec2 uv) {
#if LAYER_INCENSE
  if (incenseField0On()) return textureLod(incenseField0, uv, 0.0);
  return incenseAnalytic(uv * vec2(uRes.x / uRes.y, 1.0));
#else
  return vec4(0.0);
#endif
}

// Smoke between uv and the window along the shaft (toward: uv per frame height toward the light):
// the smoke's own shadow, and the shadows it casts down the shaft.
float incenseOptical(vec2 uv, vec2 toward) {
  float tau = 0.0;
  float s = 0.006;
  for (int i = 0; i < 8; i++) {
    tau += incenseDye(uv + toward * s).r * (0.42 * s);
    s *= 1.5;
  }
  return tau;
}


// The cell's state: where it stands on the incense's frame, the burner (the incense's field 2; with
// the incense off nothing stands on the table and no ember glows), the window's light, its shaft
// and the smoke's shadow down it, the candle.
void incenseBegin(Ctx x) {
  float aspect = x.aspect;
  vec2 p = x.p + vec2(0.5 * aspect, 0.5);
  incenseP = p;
  incenseAa = 0.75 / uRes.y;
  float kind = floor(K_stick + 0.5);
  incenseKind = kind;
  incensePaper = pagePaper();
  float tm = x.tm;

  // The burner (sim.ts Burner.write).
  vec4 s0 = vec4(sin(INCENSE_STICK_LEAN) * 0.26, INCENSE_STICK_BASE + cos(INCENSE_STICK_LEAN) * 0.26, 1.0, 1.0);
  vec4 s1 = vec4(0.12, 0.016, 0.3, 2.0);
  vec4 s2 = vec4(-1.0, 0.0, 0.0, 0.0);
  bool candle = false;
#if LAYER_INCENSE
  if (incenseField2On()) {
    s0 = texelFetch(incenseField2, ivec2(0, 0), 0);
    s1 = texelFetch(incenseField2, ivec2(1, 0), 0);
    s2 = texelFetch(incenseField2, ivec2(2, 0), 0);
  }
  candle = K_candle > 0.5;
#else
  s0.zw = vec2(0.0);
#endif
  incenseS1 = s1;
  incenseS2 = s2;
  incenseBase = vec2(INCENSE_X * aspect, INCENSE_FLOOR);
  incenseEmber = incenseBase + s0.xy;
  incensePresence = s0.w;
  float progress = s1.x;
  vec2 axis = vec2(sin(INCENSE_STICK_LEAN), cos(INCENSE_STICK_LEAN));
  if (kind < 0.5) incenseSource = incenseEmber + 0.005 * axis;
  else if (kind < 1.5) incenseSource = incenseBase + vec2(0.0, INCENSE_CONE_BASE + INCENSE_CONE_H * (1.0 - INCENSE_CONE_CRUMBLE * progress) + 0.003);
  else if (kind < 2.5) incenseSource = incenseEmber + vec2(0.0, 0.005);
  else incenseSource = incenseBase + vec2(INCENSE_MOUNT_CUP_X, INCENSE_MOUNT_TOP + INCENSE_MOUNT_CONE_H * (1.0 - INCENSE_CONE_CRUMBLE * progress) + 0.003);

  // The ember breathes slowly, and brightens when air moves over it: a draft, a hand, a breath.
  float fan = 0.0;
#if LAYER_INCENSE
  if (incenseField1On()) {
    vec2 v = textureLod(incenseField1, (incenseEmber + vec2(0.0, 0.008)) / vec2(aspect, 1.0), 0.0).xy;
    fan = smoothstep(0.04, 0.22, length(v - vec2(0.0, 0.06)));
  }
#endif
  incenseHeat = s0.z * (0.88 + 0.12 * sin(0.7 * tm) * sin(0.43 * tm + 1.0) + 0.7 * fan);

  // The window's light: its colour, the way it travels (down to the right, and on into the room),
  // where it lights the incense's plane (around the plume, a little higher over a stick than over
  // the short burners) and where it lands on the wall, INCENSE_DEPTH further on.
  vec3 keyAt;
  incenseLightCol = incenseKey(keyAt) * 2.0 * K_window;
  float angle = clamp(atan(keyAt.y, max(-keyAt.x, 0.05)), radians(12.0), radians(64.0));
  incenseDir = vec2(cos(angle), -sin(angle));
  incenseCentre = vec2(incenseBase.x, kind < 0.5 ? 0.6 : kind > 2.5 ? 0.42 : 0.5);
  incensePool = incenseCentre + incenseDir * INCENSE_DEPTH;
  incenseSlope = max(-1.0, 0.5 * incenseDir.y / incenseDir.x);
  vec2 across = vec2(-incenseDir.y, incenseDir.x);
  incenseBand = max(abs(dot(across, vec2(INCENSE_POOL_W, incenseSlope * INCENSE_POOL_W + INCENSE_POOL_H))),
                    abs(dot(across, vec2(INCENSE_POOL_W, incenseSlope * INCENSE_POOL_W - INCENSE_POOL_H))));
  vec3 wall = incenseWallColor();
  incenseAmbient = incensePaper ? vec3(0.9) : wall * 3.0 + 0.012;
  incenseFlameOn = candle ? 1.0 : 0.0;
  incenseFlameBase = incenseBase + vec2(INCENSE_CANDLE_DX, INCENSE_CANDLE_Y + INCENSE_CANDLE_H + INCENSE_FLAME_BASE);
  float lean = 0.0;
#if LAYER_INCENSE
  if (candle) {
    vec2 air = incenseField1On() ? textureLod(incenseField1, (incenseFlameBase + vec2(0.0, 0.025)) / vec2(aspect, 1.0), 0.0).xy : vec2(0.012 * sin(0.4 * tm), 0.15);
    lean = clamp(air.x / (abs(air.y) + 0.12), -1.1, 1.1);
  }
#endif
  incenseLean = lean;
  incenseFlame = incenseFlameBase + vec2(0.3 * lean, 0.4) * INCENSE_FLAME_H;

  bool window = K_window > 0.0;
  incenseShaftHere = window ? incenseShaft(p) : 0.0;
  incenseHazeHere = window ? incenseHaze(p) : 0.0;
  vec2 toward = -incenseDir / vec2(aspect, 1.0);
  incenseLitHere = incenseShaftHere > 0.002 || incenseHazeHere > 0.002 ? exp(-INCENSE_SHADOW * incenseOptical(x.uv, toward)) : 1.0;

  vec2 df = p - incenseFlame;
  vec2 de = p - incenseEmber;
  incenseWarm = INCENSE_FLAME_LIGHT * incenseFlameOn * 0.02 / (dot(df, df) + 0.01) + INCENSE_EMBER * incenseHeat * incensePresence * 0.0004 / (dot(de, de) + 0.0015);

  // The M of light (Manifold): lamplight from the next room through a carved transom; where the
  // smoke drifts through it, the smoke lights up in its shape.
  incenseMarkAt = vec2(incenseBase.x + 0.01, incenseCentre.y + 0.07);
  incenseMark = 0.0;
  if (K_mark > 0.0) incenseMark = K_mark * (1.0 - smoothstep(0.012, 0.021, markDistance((p - incenseMarkAt) / 0.22) * 0.22));
}
`;

/** The incense's GLSL its layers share: its shapes, its colours, the window's light, the smoke, the cell's state. */
export const incenseSharedGlsl: SharedGlsl = {
  id: "incense",
  glsl: () => incenseShared,
  begin: "incenseBegin",
};

/**
 * The shaft wall (the backdrop of the incense's room): the plaster in the window's light, crossed by
 * the shadows of what stands in the room (roomCaster), the M of lamplight on it; the hazy shaft.
 */
export const shaftWallGlsl = `
// Plaster, mottled (fixed to the frame, so it never crawls), dimmer toward the ceiling; the window's
// light lying on it, crossed by the shadows of what stands in the room (roomCaster: the smoke's and
// the incense's), seen from the wall back along the light to the plane they stand in, INCENSE_DEPTH
// in front of it; the candle's and the ember's warmth; a guest's light (roomLight); the M of light.
void shaftWallFar(Ctx x, inout Cell c) {
  vec2 p = incenseP;
  float accent = 0.0;
  float onWall = 0.0;
  if (K_mark > 0.0) {
    float size = 0.22;
    onWall = 1.0 - smoothstep(0.01, 0.03, markDistance((p - incenseMarkAt - vec2(0.035, -0.02)) / (1.12 * size)) * 1.12 * size);
    accent = 0.35 * K_mark * onWall;
  }
  c.accent = accent;
#if LAYER_LOW_TABLE
  // The table stands below its back edge.
  if (p.y <= INCENSE_TABLE_BACK) return;
#endif
  vec3 wall = incenseWallColor();
  vec3 albedo = incensePlaster();
  float plaster = 1.0 + 0.35 * (fbm(x.cell / 70.0 + 3.1) - 0.5);
  vec3 col = wall * plaster * mix(1.1, 0.65, smoothstep(INCENSE_TABLE_BACK, 1.0, p.y));
  float pool = K_window > 0.0 ? incenseWindow(p) : 0.0;
  if (pool > 0.001) {
    vec2 at = p - incenseDir * INCENSE_DEPTH - vec2(0.5 * x.aspect, 0.5);
    col += albedo * plaster * incenseLightCol * pool * (1.0 - roomCaster(at)) * (incensePaper ? 0.18 : 0.6);
  }
  col += albedo * 0.5 * incenseWarm + albedo * plaster * roomLight(x, x.p, vec3(0.0, 0.0, -1.0));
#if LAYER_LOW_TABLE
  // A soft contact shadow where the wall meets the table.
  col *= 1.0 - 0.35 * exp(-(p.y - INCENSE_TABLE_BACK) / 0.012);
#endif
  if (p.y > INCENSE_TABLE_BACK) col += INCENSE_MARK_LIGHT * K_mark * (incensePaper ? 0.06 : 0.035) * onWall;
  c.col = col;
}

// The hazy air glows in the shaft on its way to the wall, darkened where the smoke shadows it.
void shaftWallFrontVeil(Ctx x, inout Cell c) {
  vec3 air = incenseLightCol * incenseHazeHere * incenseLitHere * INCENSE_HAZE;
  c.col += incensePaper ? air * 0.6 : air;
}
`;

/** The low table (the ground of the incense's room): its top in the window's spill, its front face. */
export const lowTableGlsl = `
void lowTableGround(Ctx x, inout Cell c) {
  vec2 p = incenseP;
  if (p.y > INCENSE_TABLE_BACK) return;
  vec3 col;
  if (p.y > INCENSE_TABLE_FRONT) {
    // The table top, receding to the wall: faint grain, a sheen toward the back, the window's light
    // spilling onto it, the candle's and the ember's glow, a guest's light (roomLight).
    float depth = (INCENSE_TABLE_BACK - p.y) / (INCENSE_TABLE_BACK - INCENSE_TABLE_FRONT);
    float grain = vnoise(vec2(p.x * 9.0 / (0.4 + depth), 60.0 * log(0.4 + depth)));
    vec3 wood = incenseTableColor();
    col = wood * (0.8 + 0.4 * grain) * mix(1.2, 0.8, depth);
    vec3 woodAlbedo = incensePaper ? wood : wood * 5.0;
    col += woodAlbedo * (0.5 * incenseLightCol * (K_window > 0.0 ? incenseSpill(p) : 0.0) + 0.6 * incenseWarm + roomLight(x, x.p, vec3(0.0, 1.0, 0.0)));
    // The candle's flame mirrored in the polished top, a soft smear below the candle.
    if (incenseFlameOn > 0.5) {
      vec2 m = vec2(incenseFlame.x, 2.0 * (incenseBase.y + INCENSE_CANDLE_Y) - incenseFlame.y);
      vec2 r = (p - m) / vec2(0.012, 0.035);
      col += INCENSE_FLAME_LIGHT * 0.12 * exp(-dot(r, r)) * step(p.y, incenseBase.y + INCENSE_CANDLE_Y);
    }
    // The front edge, catching the light.
    col += (incenseAmbient * 0.5 + incenseLightCol * 0.05) * exp(-pow((p.y - INCENSE_TABLE_FRONT) / 0.0025, 2.0));
  } else {
    // The table's front face, in shadow.
    col = incenseTableColor() * mix(0.35, 0.5, p.y / INCENSE_TABLE_FRONT);
  }
  c.col = col;
}
`;

/**
 * The incense (a dressing on the table): what burns and its holder, the candle, the smoke lit by the
 * shaft; the dust motes, the ember and the flame (its front veil); its silhouette for the shadows on
 * the wall (incenseCaster, the room's roomCaster).
 */
export const incenseGlsl = `
// Light on a solid at p from the room, the shaft and the ember; facing -1..1 turns it away from or
// toward the window.
vec3 incenseRoomLight(vec2 p, float facing) {
  vec3 light = incenseAmbient;
  light += incenseLightCol * incenseLit(p) * (0.2 + 0.8 * clamp(0.5 + 0.5 * facing, 0.0, 1.0)) * 0.55;
  vec2 de = p - incenseEmber;
  light += INCENSE_EMBER * incenseHeat * 0.0003 / (dot(de, de) + 0.00015);
  return light;
}

// ...and from the candle.
vec3 incenseLightAt(vec2 p, float facing) {
  vec2 df = p - incenseFlame;
  return incenseRoomLight(p, facing) + INCENSE_FLAME_LIGHT * incenseFlameOn * 0.02 / (dot(df, df) + 0.01);
}

// The incense's silhouette at the room's frame point q (its caster, the room's roomCaster): how much
// of the window's light the smoke (soft, spread across the light), the incense and its holder and the
// candle stop there, on the plane they stand in.
float incenseCaster(vec2 q) {
  float aspect = uRes.x / uRes.y;
  vec2 s = q + vec2(0.5 * aspect, 0.5);
  float kind = incenseKind;
  vec2 spread = vec2(-incenseDir.y, incenseDir.x) * 0.004;
  vec2 k = vec2(aspect, 1.0);
  float rho = incenseDye(s / k).r + incenseDye((s + spread) / k).r + incenseDye((s - spread) / k).r;
  float shade = exp(-INCENSE_WALL_SHADOW * max(rho, 0.0) / 3.0);
  vec2 r = s - incenseBase;
  float solid = incenseHolder(r, kind);
  if (kind < 0.5) solid = min(solid, segmentDistance(s, incenseBase + vec2(0.0, INCENSE_STICK_BASE), incenseEmber) - INCENSE_STICK_HW);
  else if (kind < 1.5) solid = min(solid, segmentDistance(r, vec2(0.0, INCENSE_CONE_BASE), vec2(0.0, INCENSE_CONE_BASE + 0.7 * INCENSE_CONE_H)) - 0.6 * INCENSE_CONE_W);
  shade *= 1.0 - 0.7 * incensePresence * (1.0 - smoothstep(-0.002, 0.006, solid));
  if (incenseFlameOn > 0.5) shade *= 0.3 + 0.7 * smoothstep(-0.002, 0.006, incenseCandleBody(r));
  return 1.0 - shade;
}

// The dish, dark celadon, seen a little from above: its body, the rim's ellipse, sand inside, the
// ash that has dropped into it.
vec3 incenseDrawDish(vec3 col, vec2 p, vec4 s1, bool stick, float aa) {
  vec2 q = p - incenseBase;
  vec2 rimC = vec2(0.0, INCENSE_DISH_H - 0.001);
  vec2 rimR = vec2(INCENSE_DISH_W - 0.001, 0.0065);
  float rim = incenseEllipse(q - rimC, rimR);
  float body = min(incenseDish(q), rim);
  if (body > 2.0 * aa) return col;
  float side = clamp(q.x / INCENSE_DISH_W, -1.0, 1.0);
  float light = incenseLit(p);
  vec3 glaze = INCENSE_GLAZE * incenseLightAt(p, -side) * (0.65 + 0.5 * smoothstep(0.0, INCENSE_DISH_H, q.y));
  // A soft highlight in the glaze on the shoulder toward the window.
  glaze += incenseLightCol * light * 0.22 * exp(-pow(abs((side + 0.55) / 0.16), 2.0)) * smoothstep(0.003, 0.01, q.y);
  col = mix(col, glaze, softFill(body, aa) * incensePresence);
  // Sand inside the rim, darker toward the back where the rim shades it.
  float sand = incenseEllipse(q - rimC, rimR - vec2(0.003, 0.0016));
  vec3 sandCol = INCENSE_SAND * incenseLightAt(p, 0.3) * (0.55 + 0.45 * smoothfall(0.004, -0.004, q.y - rimC.y));
  col = mix(col, sandCol, softFill(sand, aa) * incensePresence);
  // The lip catching the light along the rim's front.
  float lip = exp(-pow(abs(rim / 0.0012), 2.0)) * smoothfall(rimC.y + 0.002, rimC.y - 0.004, q.y);
  col += (INCENSE_GLAZE * incenseLightAt(p, 0.5) * 1.4 + incenseLightCol * light * 0.15) * lip * incensePresence;
  if (!stick) return col;
  // Ash that broke off earlier lies on the sand.
  vec3 ash = INCENSE_ASH * incenseLightAt(p, 0.3);
  for (int i = 0; i < INCENSE_MAX_FALLEN; i++) {
    if (float(i) >= s1.w - 0.5) break;
    float h1 = hash12(vec2(float(i), 7.31));
    float h2 = hash12(vec2(float(i), 1.93));
    vec2 c = incenseBase + vec2((h1 - 0.5) * 1.4 * (INCENSE_DISH_W - 0.008), rimC.y + 0.0035 * (h2 - 0.5));
    vec2 a = rotate(vec2(0.003 + 0.004 * h2, 0.0), (h1 - 0.5) * 0.8);
    col = mix(col, ash * (0.8 + 0.3 * h2), softFill(segmentDistance(p, c - a, c + a) - 0.0016, aa) * incensePresence);
  }
  return col;
}

// The stick from the dish up to the ember, then its ash, grey and curling.
vec3 incenseDrawStick(vec3 col, vec2 p, vec4 s1, vec4 s2, float aa) {
  vec2 base = incenseBase + vec2(0.0, INCENSE_STICK_BASE);
  vec2 axis = vec2(sin(INCENSE_STICK_LEAN), cos(INCENSE_STICK_LEAN));
  vec2 n = vec2(axis.y, -axis.x);
  float across = clamp(dot(p - base, n) / INCENSE_STICK_HW, -1.0, 1.0);
  float shade = 0.7 + 0.3 * sqrt(max(0.0, 1.0 - across * across));
  float d = segmentDistance(p, base, incenseEmber) - INCENSE_STICK_HW;
  // Dark wood, its edge toward the window catching a thin line of the light.
  vec3 sheen = INCENSE_SHEEN * incenseLightCol * incenseLit(p) * smoothfall(-0.1, -0.85, across) * 0.45;
  col = mix(col, INCENSE_STICK_COLOR * incenseLightAt(p, -across) * shade + sheen, softFill(d, aa) * incensePresence);

  vec3 ash = INCENSE_ASH * incenseLightAt(p, -across) * shade + sheen;
  float length0 = s1.y;
  if (length0 > 0.0005) {
    vec2 mid = incenseEmber + rotate(axis, 0.35 * s1.z) * (0.5 * length0);
    vec2 tip = mid + rotate(axis, s1.z) * (0.5 * length0);
    float da = min(segmentDistance(p, incenseEmber, mid), segmentDistance(p, mid, tip)) - INCENSE_STICK_HW * 1.08;
    // Ash is cracked and uneven: a little lighter in flecks, darker toward its tip.
    float fleck = 0.85 + 0.3 * vnoise(p * 1400.0);
    col = mix(col, ash * fleck * mix(1.0, 0.75, smoothstep(0.0, length0, distance(p, incenseEmber))), softFill(da, aa) * incensePresence);
  }
  // A piece breaking off tumbles down into the dish.
  if (s2.x >= 0.0) {
    float age = s2.x;
    vec2 c = incenseBase + s2.yz + vec2(0.012 * age, -0.5 * INCENSE_ASH_GRAVITY * age * age);
    vec2 a = rotate(axis, -3.0 * age) * (0.5 * s2.w);
    col = mix(col, ash, softFill(segmentDistance(p, c - a, c + a) - INCENSE_STICK_HW, aa) * incensePresence);
  }
  return col;
}

// A cone standing at base: unburnt below its ember ring, ash above, the tip slowly crumbling.
vec3 incenseDrawCone(vec3 col, vec2 p, vec2 base, float height, float halfW, float progress, float aa) {
  vec2 q = p - base;
  float apex = height * (1.0 - INCENSE_CONE_CRUMBLE * progress);
  float ring = height * (1.0 - INCENSE_CONE_BURN * progress);
  float side = dot(vec2(abs(q.x), q.y - height), normalize(vec2(height, halfW)));
  float d = max(max(side, -q.y), q.y - apex + 0.002 * (1.0 - smoothstep(0.0, halfW, abs(q.x))));
  if (d > 2.0 * aa) return col;
  float across = clamp(q.x / max(halfW * (1.0 - q.y / height), 1e-4), -1.0, 1.0);
  vec3 body = mix(INCENSE_ASH * 0.85 * (0.85 + 0.3 * vnoise(p * 1200.0)), INCENSE_CONE_COLOR, smoothfall(ring + 0.0012, ring - 0.0012, q.y));
  body *= incenseLightAt(p, -across) * (0.7 + 0.3 * sqrt(max(0.0, 1.0 - across * across)));
  float inside = softFill(d, aa);
  col = mix(col, body, inside * incensePresence);
  // The burning ring, glowing through the ash.
  float band = exp(-pow(abs((q.y - ring) / 0.0018), 2.0)) * inside;
  col += (INCENSE_EMBER * 1.3 + INCENSE_EMBER_CORE * 0.5 * band) * band * incenseHeat * incensePresence;
  return col;
}

// The coil lying on its little brass stand, seen from a little above: an Archimedean spiral, green
// where it has yet to burn, grey ash where it has (it keeps its shape).
vec3 incenseDrawCoil(vec3 col, vec2 p, float progress, float aa) {
  vec2 q = p - incenseBase;
  // The stand: a round plate on three feet.
  for (int i = 0; i < 3; i++) {
    float x = (float(i) - 1.0) * 0.6 * INCENSE_PLATE_W;
    float leg = sdBox(q - vec2(x, 0.5 * INCENSE_PLATE_Y), vec2(0.0018, 0.5 * INCENSE_PLATE_Y), 0.0008);
    col = mix(col, INCENSE_BRASS * 0.5 * incenseLightAt(p, 0.0), softFill(leg, aa) * incensePresence);
  }
  vec2 pr = vec2(INCENSE_PLATE_W, INCENSE_PLATE_W * INCENSE_COIL_SQUASH);
  float plate = incenseEllipse(q - vec2(0.0, INCENSE_PLATE_Y), pr);
  vec3 brass = INCENSE_BRASS * incenseLightAt(p, -q.x / INCENSE_PLATE_W) * (0.6 + 0.4 * smoothstep(-pr.y, pr.y, q.y - INCENSE_PLATE_Y));
  col = mix(col, brass, softFill(plate, aa) * incensePresence);
  col += INCENSE_BRASS * incenseLightAt(p, 0.5) * 1.5 * exp(-pow(abs(plate / 0.001), 2.0)) * incensePresence;
  // The pin the coil hangs on.
  float pin = segmentDistance(q, vec2(0.0, INCENSE_PLATE_Y), vec2(0.0, INCENSE_COIL_Y + 0.012)) - 0.0012;
  col = mix(col, INCENSE_BRASS * incenseLightAt(p, 0.3), softFill(pin, aa) * incensePresence);

  // The spiral: its top face, then its side wall below it (the coil has some height).
  float burnt = INCENSE_COIL_TURNS - progress * (INCENSE_COIL_TURNS - INCENSE_COIL_END);
  float best = 1.0;
  float bestU = 0.0;
  float wall = 0.0;
  for (int k = 0; k < 2; k++) {
    vec2 c = vec2(q.x, q.y - INCENSE_COIL_Y + float(k) * 0.0035) / vec2(1.0, INCENSE_COIL_SQUASH);
    float r = length(c);
    float turn = fract(atan(c.y, c.x) / TAU);
    float u = turn + floor((r - INCENSE_COIL_IN) / INCENSE_COIL_PITCH - turn + 0.5);
    float uc = clamp(u, 0.0, INCENSE_COIL_TURNS);
    vec2 dir = c / max(r, 1e-5);
    float scale = length(vec2(dir.x, dir.y * INCENSE_COIL_SQUASH));
    float d = abs(r - INCENSE_COIL_IN - INCENSE_COIL_PITCH * uc) * scale - 0.0028 * scale + 2.0 * (u - uc) * (u - uc);
    // The top face wins wherever it covers; the side wall shows only below it.
    if (d < best && (k == 0 || best > 0.0)) {
      best = d;
      bestU = uc;
      wall = float(k);
    }
  }
  if (best < 2.0 * aa) {
    float ash = smoothstep(burnt - 0.004, burnt + 0.004, bestU);
    vec3 coil = mix(INCENSE_COIL_COLOR, INCENSE_ASH * 0.9, ash) * incenseLightAt(p, 0.2) * (wall > 0.5 ? 0.6 : 1.0);
    col = mix(col, coil, softFill(best, aa) * incensePresence);
  }
  return col;
}

// The backflow burner: a little stoneware mountain, glazed dark, its ledges catching the light; the
// outlet the cold smoke pours from; and its cone on top.
vec3 incenseDrawMountain(vec3 col, vec2 p, float progress, float aa) {
  vec2 q = p - incenseBase;
  float d = incenseMountain(q);
  if (d < 2.0 * aa) {
    vec2 e = vec2(0.0025, 0.0);
    vec2 n = normalize(vec2(incenseMountain(q + e.xy) - incenseMountain(q - e.xy), incenseMountain(q + e.yx) - incenseMountain(q - e.yx)) + 1e-6);
    float edge = smoothstep(-0.012, 0.0, d);
    float facing = dot(n, -incenseDir);
    vec3 stone = INCENSE_STONEWARE * (0.8 + 0.4 * hash12(floor(p * 900.0))) * (0.6 + 0.4 * smoothstep(0.0, 0.17, q.y));
    stone *= incenseLightAt(p, mix(0.0, facing, edge));
    // The glaze's sheen along the ledges' upper edges.
    stone += INCENSE_STONEWARE * incenseLightAt(p, 1.0) * 1.5 * edge * smoothstep(0.3, 0.9, n.y) * smoothstep(-0.004, 0.0, d);
    col = mix(col, stone, softFill(d, aa) * incensePresence);
    float hole = length((q - vec2(INCENSE_OUTLET_X - 0.009, INCENSE_OUTLET_Y)) / vec2(0.5, 1.0)) - 0.0045;
    col = mix(col, col * 0.25, softFill(hole, aa) * incensePresence);
  }
  return incenseDrawCone(col, p, incenseBase + vec2(INCENSE_MOUNT_CUP_X, INCENSE_MOUNT_TOP), INCENSE_MOUNT_CONE_H, INCENSE_MOUNT_CONE_W, progress, aa);
}

// The candle: an ivory pillar, glowing through near its top, a wick.
vec3 incenseDrawCandle(vec3 col, vec2 p, float aa) {
  vec2 q = p - incenseBase;
  float d = incenseCandleBody(q);
  if (d > 2.0 * aa) return col;
  float across = clamp((q.x - INCENSE_CANDLE_DX) / INCENSE_CANDLE_W, -1.0, 1.0);
  float top = INCENSE_CANDLE_Y + INCENSE_CANDLE_H;
  float through = exp(-max(top - q.y, 0.0) / 0.014);
  vec3 wax = INCENSE_WAX * incenseRoomLight(p, -across) * (0.7 + 0.3 * sqrt(max(0.0, 1.0 - across * across)));
  wax += INCENSE_FLAME_LIGHT * (0.12 + 0.6 * through) * (0.75 + 0.25 * (1.0 - across * across));
  col = mix(col, wax, softFill(d, aa));
  float wick = segmentDistance(q, vec2(INCENSE_CANDLE_DX, top), vec2(INCENSE_CANDLE_DX, top + INCENSE_FLAME_BASE + 0.002)) - 0.0011;
  return mix(col, vec3(0.05, 0.04, 0.035), softFill(wick, aa));
}

// The flame, leaning and bending with the air around it: a blue root, a white-gold core, an orange
// tip, and its glow in the air.
vec3 incenseDrawFlame(vec3 col, vec2 p, vec2 base, float lean, float aa) {
  vec2 q = p - base;
  float len = INCENSE_FLAME_H * (1.0 - 0.25 * min(1.0, abs(lean)));
  float t = q.y / len;
  float x = q.x - lean * 0.7 * len * t * t;
  float w = INCENSE_FLAME_W * 1.25 * sqrt(max(t + 0.07, 0.0)) * pow(max(1.0 - t, 0.0), 0.7);
  float d = abs(x) / max(w, 1e-4);
  float inside = step(-0.07, t) * step(t, 1.0);
  float body = (1.0 - smoothstep(0.7, 1.0 + aa / max(w, 1e-4), d)) * inside;
  float core = (1.0 - smoothstep(0.15, 0.55, d)) * smoothstep(0.04, 0.22, t) * (1.0 - smoothstep(0.4, 0.75, t));
  vec3 flame = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.78, 0.4), smoothfall(0.95, 0.35, t));
  flame = mix(flame, vec3(1.0, 0.97, 0.86), core);
  col = mix(col, flame, body * (0.4 + 0.6 * smoothstep(0.0, 0.2, t)));
  col += vec3(0.15, 0.25, 0.75) * 0.5 * (1.0 - smoothstep(0.0, 0.2, t)) * smoothstep(0.3, 0.9, d) * (1.0 - smoothstep(0.9, 1.3, d)) * inside;
  vec2 g = p - incenseFlame;
  return col + INCENSE_FLAME_LIGHT * 0.2 * exp(-dot(g, g) / 0.0016);
}

// What burns and its holder, the candle; then the smoke over them, lit where it drifts through the
// shaft.
void incenseFront(Ctx x, inout Cell c) {
  vec2 p = incenseP;
  vec2 uv = x.uv;
  float aa = incenseAa;
  float kind = incenseKind;
  bool paper = incensePaper;
  vec3 col = c.col;
  if (abs(p.x - incenseBase.x) < 0.14 && p.y < INCENSE_FLOOR + 0.48) {
    if (kind < 0.5) {
      col = incenseDrawDish(col, p, incenseS1, true, aa);
      col = incenseDrawStick(col, p, incenseS1, incenseS2, aa);
    } else if (kind < 1.5) {
      col = incenseDrawDish(col, p, incenseS1, false, aa);
      col = incenseDrawCone(col, p, incenseBase + vec2(0.0, INCENSE_CONE_BASE), INCENSE_CONE_H, INCENSE_CONE_W, incenseS1.x, aa);
    } else if (kind < 2.5) {
      col = incenseDrawCoil(col, p, incenseS1.x, aa);
    } else {
      col = incenseDrawMountain(col, p, incenseS1.x, aa);
    }
  }
  if (incenseFlameOn > 0.5) col = incenseDrawCandle(col, p, aa);

  vec4 dye = incenseDye(uv);
  float rho = dye.r;
  vec2 slope = vec2(0.0);
  if (incenseField0On()) {
    // A blur across the dither's scale (thin moving edges would shimmer), and the smoke's slope for
    // its lit faces.
    vec2 e = 1.3 / vec2(textureSize(incenseField0, 0));
    float a = textureLod(incenseField0, uv + vec2(e.x, e.y), 0.0).r;
    float b = textureLod(incenseField0, uv + vec2(-e.x, e.y), 0.0).r;
    float cc = textureLod(incenseField0, uv + vec2(e.x, -e.y), 0.0).r;
    float d = textureLod(incenseField0, uv - e, 0.0).r;
    rho = 0.4 * rho + 0.15 * (a + b + cc + d);
    slope = vec2(a + cc - b - d, a + b - cc - d);
  }
  rho = max(rho, 0.0);
  float cover = 1.0 - exp(-INCENSE_DENSE * rho);
  float fresh = clamp(dye.b / max(dye.r, 0.02), 0.0, 1.0);
  vec3 tint = mix(INCENSE_AGED, INCENSE_FRESH, fresh);
  // In the shaft the smoke lights up, faces turned toward the window brightest, thin wisps glowing (the
  // light scatters forward through them unshadowed); outside it, only the room's dim light finds it.
  vec2 df = p - incenseFlame;
  vec2 de = p - incenseEmber;
  float facing = dot(-slope / (length(slope) + 1e-4), -incenseDir) * smoothstep(0.0, 0.06, length(slope));
  vec3 onSmoke = incenseLightCol * incenseShaftHere * incenseLitHere * (1.0 + 0.35 * facing) * (1.0 + 0.6 * (1.0 - cover));
  onSmoke += INCENSE_FLAME_LIGHT * incenseFlameOn * 0.6 / (1.0 + dot(df, df) / 0.012);
  onSmoke += INCENSE_EMBER * incenseHeat * incensePresence * 0.8 * exp(-dot(de, de) / 0.0005);
  onSmoke += INCENSE_MARK_LIGHT * 2.2 * incenseMark;
  onSmoke += incenseAmbient * (paper ? 0.3 : 1.0);
  if (paper) {
    // On washi the smoke reads as ink: a cool grey wash, paler where the light catches it.
    float light = clamp(dot(onSmoke - incenseAmbient * 0.3, LUMA) * 0.5, 0.0, 1.0);
    col = mix(col, INCENSE_SUMI * (0.75 + 0.9 * light) * tint, cover * 0.6);
  } else {
    col = col * (1.0 - 0.45 * cover) + cover * tint * onSmoke;
  }
  c.col = col;
  c.accent = max(c.accent, cover * incenseMark);
}

// The motes drifting in the light, carried by the smoke's air; the light sources on top: the ember,
// a hot bead under the ash, its glow; the candle's flame.
void incenseFrontVeil(Ctx x, inout Cell c) {
  vec2 p = incenseP;
  vec3 col = c.col;
  if (incenseField3On() && K_dust > 0.0) {
    vec3 dust = incenseLightCol * max(incenseHazeHere, incenseShaftHere) * incenseLitHere * textureLod(incenseField3, x.uv, 0.0).r * K_dust * 0.9;
    col += incensePaper ? dust * 0.6 : dust;
  }
  vec2 de = p - incenseEmber;
  float kind = incenseKind;
  float ember = incenseHeat * incensePresence;
  float glowShape = 1.2 * exp(-dot(de, de) / 0.0000045) + 0.3 * exp(-dot(de, de) / 0.00012) + 0.06 * exp(-dot(de, de) / 0.0016);
  if ((kind > 0.5 && kind < 1.5) || kind > 2.5) glowShape *= 0.5;
  col += (INCENSE_EMBER_CORE * exp(-dot(de, de) / 0.0000045) + INCENSE_EMBER * glowShape) * ember;
  c.accent = max(c.accent, clamp(glowShape * ember * 1.5, 0.0, 1.0));
  if (incenseFlameOn > 0.5) col = incenseDrawFlame(col, p, incenseFlameBase, incenseLean, incenseAa);
  c.col = col;
}
`;
