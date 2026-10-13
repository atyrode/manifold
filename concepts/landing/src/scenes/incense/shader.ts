// The incense scene's picture: a dark room, light from a window off to the left crossing it in a
// hazy shaft and lying on the plaster wall as a tall pane of light; a low table, the incense on it
// standing dark against that light, and its smoke (simulated in sim.ts), which glows where it drifts
// through the shaft and throws soft shadows on the wall.
//   uSim0  dye: r smoke, g heat, b fresh smoke (b / r: how young it is)
//   uSim1  velocity, frame heights per second
//   uSim2  the burner: texel 0 ember (from the anchor), glow, presence; texel 1 progress, ash
//          length, ash curl, ash pieces in the dish; texel 2 falling ash (seconds, from x, y, length)
//   uSim3  dust motes
// Without uSim0 (no float render targets) an analytic plume stands in for the fluid.
// Knobs read here: K_stick, K_window, K_angle, K_tint, K_room, K_dust, K_candle, K_mark.
import { incenseLayoutGlsl, incenseShapesGlsl } from "./sim.ts";

export const incenseGlsl = `
${incenseLayoutGlsl}
${incenseShapesGlsl}
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

// Set once per pixel by sceneIncense, read by the helpers below.
vec2 incenseAnchor;
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

// The window's light: moonlight, a pale morning, a low gold sun.
vec3 incenseLightColor() {
  if (K_tint < 0.5) return vec3(0.62, 0.74, 1.0);
  if (K_tint < 1.5) return vec3(1.0, 0.9, 0.74);
  return vec3(1.0, 0.62, 0.38);
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

float incenseFill(float d, float aa) {
  return 1.0 - smoothstep(-aa, aa, d);
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
  return (1.0 - smoothstep(incenseBand - 0.06, incenseBand + 0.04, across)) * smoothstep(0.3, -0.25, dot(r, incenseDir));
}

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

// Without the fluid: a thread that sways, widens and breaks into wavering veils.
vec4 incenseAnalytic(vec2 p) {
  vec2 src = incenseSource;
  float h = p.y - src.y;
  if (h < -0.005) return vec4(0.0);
  float tm = uTime * uMotion;
  float rise = smoothstep(0.08, 0.45, h);
  float axis = src.x - 0.03 * h + 0.025 * h * sin(0.21 * tm) + 0.02 * rise * sin(19.0 * h - 0.8 * tm);
  axis += 0.07 * rise * min(1.0, h / 0.45) * (vnoise(vec2(3.0 * p.x, 4.0 * p.y - 0.25 * tm)) - 0.5) + 0.12 * smoothstep(0.35, 0.65, h);
  float w = 0.0035 + 0.09 * rise * min(1.0, h / 0.5);
  float dx = (p.x - axis) / w;
  float veil = mix(1.0, 0.25 + 1.5 * vnoise(vec2(14.0 * p.x, 10.0 * p.y - 0.4 * tm)), rise);
  float r = 0.5 * pow(0.0035 / w, 0.6) * exp(-dx * dx) * veil * smoothstep(-0.005, 0.004, h) * (1.0 - smoothstep(0.93, 1.0, p.y));
  return vec4(r, 0.0, r * exp(-3.2 * max(h, 0.0)), 0.0);
}

vec4 incenseDye(vec2 uv) {
  if (uSimOn.x > 0.5) return textureLod(uSim0, uv, 0.0);
  return incenseAnalytic(uv * vec2(uRes.x / uRes.y, 1.0));
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

// The window's light reaching the wall at w past what stands INCENSE_DEPTH in front of it: the
// smoke (soft shadows drifting and curling over the plaster), the incense and its holder, the candle.
float incenseWallShade(vec2 w, float kind, float aspect) {
  vec2 s = w - incenseDir * INCENSE_DEPTH;
  vec2 spread = vec2(-incenseDir.y, incenseDir.x) * 0.004;
  vec2 k = vec2(aspect, 1.0);
  float rho = incenseDye(s / k).r + incenseDye((s + spread) / k).r + incenseDye((s - spread) / k).r;
  float shade = exp(-INCENSE_WALL_SHADOW * max(rho, 0.0) / 3.0);
  vec2 q = s - incenseAnchor;
  float solid = incenseHolder(q, kind);
  if (kind < 0.5) solid = min(solid, segmentDistance(s, incenseAnchor + vec2(0.0, INCENSE_STICK_BASE), incenseEmber) - INCENSE_STICK_HW);
  else if (kind < 1.5) solid = min(solid, segmentDistance(q, vec2(0.0, INCENSE_CONE_BASE), vec2(0.0, INCENSE_CONE_BASE + 0.7 * INCENSE_CONE_H)) - 0.6 * INCENSE_CONE_W);
  shade *= 1.0 - 0.7 * incensePresence * (1.0 - smoothstep(-0.002, 0.006, solid));
  if (incenseFlameOn > 0.5) shade *= 0.3 + 0.7 * smoothstep(-0.002, 0.006, incenseCandleBody(q));
  return shade;
}

// The dish, dark celadon, seen a little from above: its body, the rim's ellipse, sand inside, the
// ash that has dropped into it.
vec3 incenseDrawDish(vec3 col, vec2 p, vec4 s1, bool stick, float aa) {
  vec2 q = p - incenseAnchor;
  vec2 rimC = vec2(0.0, INCENSE_DISH_H - 0.001);
  vec2 rimR = vec2(INCENSE_DISH_W - 0.001, 0.0065);
  float rim = incenseEllipse(q - rimC, rimR);
  float body = min(incenseDish(q), rim);
  if (body > 2.0 * aa) return col;
  float side = clamp(q.x / INCENSE_DISH_W, -1.0, 1.0);
  float light = incenseLit(p);
  vec3 glaze = INCENSE_GLAZE * incenseLightAt(p, -side) * (0.65 + 0.5 * smoothstep(0.0, INCENSE_DISH_H, q.y));
  // A soft highlight in the glaze on the shoulder toward the window.
  glaze += incenseLightCol * light * 0.22 * exp(-pow((side + 0.55) / 0.16, 2.0)) * smoothstep(0.003, 0.01, q.y);
  col = mix(col, glaze, incenseFill(body, aa) * incensePresence);
  // Sand inside the rim, darker toward the back where the rim shades it.
  float sand = incenseEllipse(q - rimC, rimR - vec2(0.003, 0.0016));
  vec3 sandCol = INCENSE_SAND * incenseLightAt(p, 0.3) * (0.55 + 0.45 * smoothstep(0.004, -0.004, q.y - rimC.y));
  col = mix(col, sandCol, incenseFill(sand, aa) * incensePresence);
  // The lip catching the light along the rim's front.
  float lip = exp(-pow(rim / 0.0012, 2.0)) * smoothstep(rimC.y + 0.002, rimC.y - 0.004, q.y);
  col += (INCENSE_GLAZE * incenseLightAt(p, 0.5) * 1.4 + incenseLightCol * light * 0.15) * lip * incensePresence;
  if (!stick) return col;
  // Ash that broke off earlier lies on the sand.
  vec3 ash = INCENSE_ASH * incenseLightAt(p, 0.3);
  for (int i = 0; i < INCENSE_MAX_FALLEN; i++) {
    if (float(i) >= s1.w - 0.5) break;
    float h1 = hash12(vec2(float(i), 7.31));
    float h2 = hash12(vec2(float(i), 1.93));
    vec2 c = incenseAnchor + vec2((h1 - 0.5) * 1.4 * (INCENSE_DISH_W - 0.008), rimC.y + 0.0035 * (h2 - 0.5));
    vec2 a = rotate(vec2(0.003 + 0.004 * h2, 0.0), (h1 - 0.5) * 0.8);
    col = mix(col, ash * (0.8 + 0.3 * h2), incenseFill(segmentDistance(p, c - a, c + a) - 0.0016, aa) * incensePresence);
  }
  return col;
}

// The stick from the dish up to the ember, then its ash, grey and curling.
vec3 incenseDrawStick(vec3 col, vec2 p, vec4 s1, vec4 s2, float aa) {
  vec2 base = incenseAnchor + vec2(0.0, INCENSE_STICK_BASE);
  vec2 axis = vec2(sin(INCENSE_STICK_LEAN), cos(INCENSE_STICK_LEAN));
  vec2 n = vec2(axis.y, -axis.x);
  float across = clamp(dot(p - base, n) / INCENSE_STICK_HW, -1.0, 1.0);
  float shade = 0.7 + 0.3 * sqrt(max(0.0, 1.0 - across * across));
  float d = segmentDistance(p, base, incenseEmber) - INCENSE_STICK_HW;
  // Dark wood, its edge toward the window catching a thin line of the light.
  vec3 sheen = INCENSE_SHEEN * incenseLightCol * incenseLit(p) * smoothstep(-0.1, -0.85, across) * 0.45;
  col = mix(col, INCENSE_STICK_COLOR * incenseLightAt(p, -across) * shade + sheen, incenseFill(d, aa) * incensePresence);

  vec3 ash = INCENSE_ASH * incenseLightAt(p, -across) * shade + sheen;
  float length0 = s1.y;
  if (length0 > 0.0005) {
    vec2 mid = incenseEmber + rotate(axis, 0.35 * s1.z) * (0.5 * length0);
    vec2 tip = mid + rotate(axis, s1.z) * (0.5 * length0);
    float da = min(segmentDistance(p, incenseEmber, mid), segmentDistance(p, mid, tip)) - INCENSE_STICK_HW * 1.08;
    // Ash is cracked and uneven: a little lighter in flecks, darker toward its tip.
    float fleck = 0.85 + 0.3 * vnoise(p * 1400.0);
    col = mix(col, ash * fleck * mix(1.0, 0.75, smoothstep(0.0, length0, distance(p, incenseEmber))), incenseFill(da, aa) * incensePresence);
  }
  // A piece breaking off tumbles down into the dish.
  if (s2.x >= 0.0) {
    float age = s2.x;
    vec2 c = incenseAnchor + s2.yz + vec2(0.012 * age, -0.5 * INCENSE_ASH_GRAVITY * age * age);
    vec2 a = rotate(axis, -3.0 * age) * (0.5 * s2.w);
    col = mix(col, ash, incenseFill(segmentDistance(p, c - a, c + a) - INCENSE_STICK_HW, aa) * incensePresence);
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
  vec3 body = mix(INCENSE_ASH * 0.85 * (0.85 + 0.3 * vnoise(p * 1200.0)), INCENSE_CONE_COLOR, smoothstep(ring + 0.0012, ring - 0.0012, q.y));
  body *= incenseLightAt(p, -across) * (0.7 + 0.3 * sqrt(max(0.0, 1.0 - across * across)));
  float inside = incenseFill(d, aa);
  col = mix(col, body, inside * incensePresence);
  // The burning ring, glowing through the ash.
  float band = exp(-pow((q.y - ring) / 0.0018, 2.0)) * inside;
  col += (INCENSE_EMBER * 1.3 + INCENSE_EMBER_CORE * 0.5 * band) * band * incenseHeat * incensePresence;
  return col;
}

// The coil lying on its little brass stand, seen from a little above: an Archimedean spiral, green
// where it has yet to burn, grey ash where it has (it keeps its shape).
vec3 incenseDrawCoil(vec3 col, vec2 p, float progress, float aa) {
  vec2 q = p - incenseAnchor;
  // The stand: a round plate on three feet.
  for (int i = 0; i < 3; i++) {
    float x = (float(i) - 1.0) * 0.6 * INCENSE_PLATE_W;
    float leg = incenseBox(q - vec2(x, 0.5 * INCENSE_PLATE_Y), vec2(0.0018, 0.5 * INCENSE_PLATE_Y), 0.0008);
    col = mix(col, INCENSE_BRASS * 0.5 * incenseLightAt(p, 0.0), incenseFill(leg, aa) * incensePresence);
  }
  vec2 pr = vec2(INCENSE_PLATE_W, INCENSE_PLATE_W * INCENSE_COIL_SQUASH);
  float plate = incenseEllipse(q - vec2(0.0, INCENSE_PLATE_Y), pr);
  vec3 brass = INCENSE_BRASS * incenseLightAt(p, -q.x / INCENSE_PLATE_W) * (0.6 + 0.4 * smoothstep(-pr.y, pr.y, q.y - INCENSE_PLATE_Y));
  col = mix(col, brass, incenseFill(plate, aa) * incensePresence);
  col += INCENSE_BRASS * incenseLightAt(p, 0.5) * 1.5 * exp(-pow(plate / 0.001, 2.0)) * incensePresence;
  // The pin the coil hangs on.
  float pin = segmentDistance(q, vec2(0.0, INCENSE_PLATE_Y), vec2(0.0, INCENSE_COIL_Y + 0.012)) - 0.0012;
  col = mix(col, INCENSE_BRASS * incenseLightAt(p, 0.3), incenseFill(pin, aa) * incensePresence);

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
    col = mix(col, coil, incenseFill(best, aa) * incensePresence);
  }
  return col;
}

// The backflow burner: a little stoneware mountain, glazed dark, its ledges catching the light; the
// outlet the cold smoke pours from; and its cone on top.
vec3 incenseDrawMountain(vec3 col, vec2 p, float progress, float aa) {
  vec2 q = p - incenseAnchor;
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
    col = mix(col, stone, incenseFill(d, aa) * incensePresence);
    float hole = length((q - vec2(INCENSE_OUTLET_X - 0.009, INCENSE_OUTLET_Y)) / vec2(0.5, 1.0)) - 0.0045;
    col = mix(col, col * 0.25, incenseFill(hole, aa) * incensePresence);
  }
  return incenseDrawCone(col, p, incenseAnchor + vec2(INCENSE_MOUNT_CUP_X, INCENSE_MOUNT_TOP), INCENSE_MOUNT_CONE_H, INCENSE_MOUNT_CONE_W, progress, aa);
}

// The candle: an ivory pillar, glowing through near its top, a wick.
vec3 incenseDrawCandle(vec3 col, vec2 p, float aa) {
  vec2 q = p - incenseAnchor;
  float d = incenseCandleBody(q);
  if (d > 2.0 * aa) return col;
  float across = clamp((q.x - INCENSE_CANDLE_DX) / INCENSE_CANDLE_W, -1.0, 1.0);
  float top = INCENSE_CANDLE_Y + INCENSE_CANDLE_H;
  float through = exp(-max(top - q.y, 0.0) / 0.014);
  vec3 wax = INCENSE_WAX * incenseRoomLight(p, -across) * (0.7 + 0.3 * sqrt(max(0.0, 1.0 - across * across)));
  wax += INCENSE_FLAME_LIGHT * (0.12 + 0.6 * through) * (0.75 + 0.25 * (1.0 - across * across));
  col = mix(col, wax, incenseFill(d, aa));
  float wick = segmentDistance(q, vec2(INCENSE_CANDLE_DX, top), vec2(INCENSE_CANDLE_DX, top + INCENSE_FLAME_BASE + 0.002)) - 0.0011;
  return mix(col, vec3(0.05, 0.04, 0.035), incenseFill(wick, aa));
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
  vec3 flame = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.78, 0.4), smoothstep(0.95, 0.35, t));
  flame = mix(flame, vec3(1.0, 0.97, 0.86), core);
  col = mix(col, flame, body * (0.4 + 0.6 * smoothstep(0.0, 0.2, t)));
  col += vec3(0.15, 0.25, 0.75) * 0.5 * (1.0 - smoothstep(0.0, 0.2, t)) * smoothstep(0.3, 0.9, d) * (1.0 - smoothstep(0.9, 1.3, d)) * inside;
  vec2 g = p - incenseFlame;
  return col + INCENSE_FLAME_LIGHT * 0.2 * exp(-dot(g, g) / 0.0016);
}

Shade sceneIncense(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float aa = 0.75 / uRes.y;
  float kind = floor(K_stick + 0.5);
  bool paper = K_room > 2.5;
  float tm = t * uMotion;

  // The burner (sim.ts Burner.write).
  vec4 s0 = vec4(sin(INCENSE_STICK_LEAN) * 0.26, INCENSE_STICK_BASE + cos(INCENSE_STICK_LEAN) * 0.26, 1.0, 1.0);
  vec4 s1 = vec4(0.12, 0.016, 0.3, 2.0);
  vec4 s2 = vec4(-1.0, 0.0, 0.0, 0.0);
  if (uSimOn.z > 0.5) {
    s0 = texelFetch(uSim2, ivec2(0, 0), 0);
    s1 = texelFetch(uSim2, ivec2(1, 0), 0);
    s2 = texelFetch(uSim2, ivec2(2, 0), 0);
  }
  incenseAnchor = vec2(INCENSE_X * aspect, INCENSE_FLOOR);
  incenseEmber = incenseAnchor + s0.xy;
  incensePresence = s0.w;
  float progress = s1.x;
  vec2 axis = vec2(sin(INCENSE_STICK_LEAN), cos(INCENSE_STICK_LEAN));
  if (kind < 0.5) incenseSource = incenseEmber + 0.005 * axis;
  else if (kind < 1.5) incenseSource = incenseAnchor + vec2(0.0, INCENSE_CONE_BASE + INCENSE_CONE_H * (1.0 - INCENSE_CONE_CRUMBLE * progress) + 0.003);
  else if (kind < 2.5) incenseSource = incenseEmber + vec2(0.0, 0.005);
  else incenseSource = incenseAnchor + vec2(INCENSE_MOUNT_CUP_X, INCENSE_MOUNT_TOP + INCENSE_MOUNT_CONE_H * (1.0 - INCENSE_CONE_CRUMBLE * progress) + 0.003);

  // The ember breathes slowly, and brightens when air moves over it: a draft, a hand, a breath.
  float fan = 0.0;
  if (uSimOn.y > 0.5) {
    vec2 v = textureLod(uSim1, (incenseEmber + vec2(0.0, 0.008)) / vec2(aspect, 1.0), 0.0).xy;
    fan = smoothstep(0.04, 0.22, length(v - vec2(0.0, 0.06)));
  }
  incenseHeat = s0.z * (0.88 + 0.12 * sin(0.7 * tm) * sin(0.43 * tm + 1.0) + 0.7 * fan);

  // The window's light: its colour, the way it travels (down to the right, and on into the room),
  // where it lights the incense's plane (around the plume, a little higher over a stick than over
  // the short burners) and where it lands on the wall, INCENSE_DEPTH further on.
  incenseLightCol = incenseLightColor() * 2.0 * K_window;
  float angle = radians(mix(12.0, 64.0, K_angle));
  incenseDir = vec2(cos(angle), -sin(angle));
  incenseCentre = vec2(incenseAnchor.x, kind < 0.5 ? 0.6 : kind > 2.5 ? 0.42 : 0.5);
  incensePool = incenseCentre + incenseDir * INCENSE_DEPTH;
  incenseSlope = max(-1.0, 0.5 * incenseDir.y / incenseDir.x);
  vec2 across = vec2(-incenseDir.y, incenseDir.x);
  incenseBand = max(abs(dot(across, vec2(INCENSE_POOL_W, incenseSlope * INCENSE_POOL_W + INCENSE_POOL_H))),
                    abs(dot(across, vec2(INCENSE_POOL_W, incenseSlope * INCENSE_POOL_W - INCENSE_POOL_H))));
  vec3 wall = incenseWallColor();
  incenseAmbient = paper ? vec3(0.9) : wall * 3.0 + 0.012;
  bool candle = K_candle > 0.5;
  incenseFlameOn = candle ? 1.0 : 0.0;
  vec2 flameBase = incenseAnchor + vec2(INCENSE_CANDLE_DX, INCENSE_CANDLE_Y + INCENSE_CANDLE_H + INCENSE_FLAME_BASE);
  float lean = 0.0;
  if (candle) {
    vec2 air = uSimOn.y > 0.5 ? textureLod(uSim1, (flameBase + vec2(0.0, 0.025)) / vec2(aspect, 1.0), 0.0).xy : vec2(0.012 * sin(0.4 * tm), 0.15);
    lean = clamp(air.x / (abs(air.y) + 0.12), -1.1, 1.1);
  }
  incenseFlame = flameBase + vec2(0.3 * lean, 0.4) * INCENSE_FLAME_H;

  bool window = K_window > 0.0;
  float shaft = window ? incenseShaft(p) : 0.0;
  float haze = window ? incenseHaze(p) : 0.0;
  vec2 toward = -incenseDir / vec2(aspect, 1.0);
  float lit = shaft > 0.002 || haze > 0.002 ? exp(-INCENSE_SHADOW * incenseOptical(uv, toward)) : 1.0;

  // ---- the room ----------------------------------------------------------------------------------
  vec3 col;
  vec3 albedo = incensePlaster();
  vec2 df = p - incenseFlame;
  vec2 de = p - incenseEmber;
  vec3 warm = INCENSE_FLAME_LIGHT * incenseFlameOn * 0.02 / (dot(df, df) + 0.01) + INCENSE_EMBER * incenseHeat * incensePresence * 0.0004 / (dot(de, de) + 0.0015);
  if (p.y > INCENSE_TABLE_BACK) {
    // Plaster, mottled (fixed to the frame, so it never crawls), dimmer toward the ceiling; the
    // window's light lying on it, crossed by the shadows of the smoke and the incense.
    float plaster = 1.0 + 0.35 * (fbm(cell / 70.0 + 3.1) - 0.5);
    col = wall * plaster * mix(1.1, 0.65, smoothstep(INCENSE_TABLE_BACK, 1.0, p.y));
    float pool = window ? incenseWindow(p) : 0.0;
    if (pool > 0.001) col += albedo * plaster * incenseLightCol * pool * incenseWallShade(p, kind, aspect) * (paper ? 0.18 : 0.6);
    col += albedo * 0.5 * warm;
    // A soft contact shadow where the wall meets the table.
    col *= 1.0 - 0.35 * exp(-(p.y - INCENSE_TABLE_BACK) / 0.012);
  } else if (p.y > INCENSE_TABLE_FRONT) {
    // The table top, receding to the wall: faint grain, a sheen toward the back, the window's light
    // spilling onto it, the candle's and the ember's glow.
    float depth = (INCENSE_TABLE_BACK - p.y) / (INCENSE_TABLE_BACK - INCENSE_TABLE_FRONT);
    float grain = vnoise(vec2(p.x * 9.0 / (0.4 + depth), 60.0 * log(0.4 + depth)));
    vec3 wood = incenseTableColor();
    col = wood * (0.8 + 0.4 * grain) * mix(1.2, 0.8, depth);
    vec3 woodAlbedo = paper ? wood : wood * 5.0;
    col += woodAlbedo * (0.5 * incenseLightCol * (window ? incenseSpill(p) : 0.0) + 0.6 * warm);
    // The candle's flame mirrored in the polished top, a soft smear below the candle.
    if (candle) {
      vec2 m = vec2(incenseFlame.x, 2.0 * (incenseAnchor.y + INCENSE_CANDLE_Y) - incenseFlame.y);
      vec2 r = (p - m) / vec2(0.012, 0.035);
      col += INCENSE_FLAME_LIGHT * 0.12 * exp(-dot(r, r)) * step(p.y, incenseAnchor.y + INCENSE_CANDLE_Y);
    }
    // The front edge, catching the light.
    col += (incenseAmbient * 0.5 + incenseLightCol * 0.05) * exp(-pow((p.y - INCENSE_TABLE_FRONT) / 0.0025, 2.0));
  } else {
    // The table's front face, in shadow.
    col = incenseTableColor() * mix(0.35, 0.5, p.y / INCENSE_TABLE_FRONT);
  }

  // The M of light (Manifold): lamplight from the next room through a carved transom, landing on the
  // wall as a faint M; where the smoke drifts through it, the smoke lights up in its shape.
  float mark = 0.0;
  if (K_mark > 0.0) {
    float size = 0.22;
    vec2 mc = vec2(incenseAnchor.x + 0.01, incenseCentre.y + 0.07);
    mark = 1.0 - smoothstep(0.012, 0.021, markDistance((p - mc) / size) * size);
    float onWall = 1.0 - smoothstep(0.01, 0.03, markDistance((p - mc - vec2(0.035, -0.02)) / (1.12 * size)) * 1.12 * size);
    if (p.y > INCENSE_TABLE_BACK) col += INCENSE_MARK_LIGHT * K_mark * (paper ? 0.06 : 0.035) * onWall;
    o.accent = 0.35 * K_mark * onWall;
  }

  // ---- the burner ---------------------------------------------------------------------------------
  if (abs(p.x - incenseAnchor.x) < 0.14 && p.y < INCENSE_FLOOR + 0.48) {
    if (kind < 0.5) {
      col = incenseDrawDish(col, p, s1, true, aa);
      col = incenseDrawStick(col, p, s1, s2, aa);
    } else if (kind < 1.5) {
      col = incenseDrawDish(col, p, s1, false, aa);
      col = incenseDrawCone(col, p, incenseAnchor + vec2(0.0, INCENSE_CONE_BASE), INCENSE_CONE_H, INCENSE_CONE_W, progress, aa);
    } else if (kind < 2.5) {
      col = incenseDrawCoil(col, p, progress, aa);
    } else {
      col = incenseDrawMountain(col, p, progress, aa);
    }
  }
  if (candle) col = incenseDrawCandle(col, p, aa);

  // ---- the smoke ----------------------------------------------------------------------------------
  vec4 dye = incenseDye(uv);
  float rho = dye.r;
  vec2 slope = vec2(0.0);
  if (uSimOn.x > 0.5) {
    // A blur across the dither's scale (thin moving edges would shimmer), and the smoke's slope for
    // its lit faces.
    vec2 e = 1.3 / vec2(textureSize(uSim0, 0));
    float a = textureLod(uSim0, uv + vec2(e.x, e.y), 0.0).r;
    float b = textureLod(uSim0, uv + vec2(-e.x, e.y), 0.0).r;
    float c = textureLod(uSim0, uv + vec2(e.x, -e.y), 0.0).r;
    float d = textureLod(uSim0, uv - e, 0.0).r;
    rho = 0.4 * rho + 0.15 * (a + b + c + d);
    slope = vec2(a + c - b - d, a + b - c - d);
  }
  rho = max(rho, 0.0);
  float cover = 1.0 - exp(-INCENSE_DENSE * rho);
  float fresh = clamp(dye.b / max(dye.r, 0.02), 0.0, 1.0);
  vec3 tint = mix(INCENSE_AGED, INCENSE_FRESH, fresh);
  // In the shaft the smoke lights up, faces turned toward the window brightest, thin wisps glowing (the
  // light scatters forward through them unshadowed); outside it, only the room's dim light finds it.
  float facing = dot(-slope / (length(slope) + 1e-4), -incenseDir) * smoothstep(0.0, 0.06, length(slope));
  vec3 onSmoke = incenseLightCol * shaft * lit * (1.0 + 0.35 * facing) * (1.0 + 0.6 * (1.0 - cover));
  onSmoke += INCENSE_FLAME_LIGHT * incenseFlameOn * 0.6 / (1.0 + dot(df, df) / 0.012);
  onSmoke += INCENSE_EMBER * incenseHeat * incensePresence * 0.8 * exp(-dot(de, de) / 0.0005);
  onSmoke += INCENSE_MARK_LIGHT * K_mark * 2.2 * mark;
  onSmoke += incenseAmbient * (paper ? 0.3 : 1.0);

  // The hazy air glows in the shaft on its way to the wall, darkened where the smoke shadows it;
  // motes drift in it.
  vec3 air = incenseLightCol * haze * lit * INCENSE_HAZE;
  if (uSimOn.w > 0.5 && K_dust > 0.0) air += incenseLightCol * max(haze, shaft) * lit * textureLod(uSim3, uv, 0.0).r * K_dust * 0.9;
  if (paper) {
    // On washi the smoke reads as ink: a cool grey wash, paler where the light catches it.
    float light = clamp(dot(onSmoke - incenseAmbient * 0.3, LUMA) * 0.5, 0.0, 1.0);
    col = mix(col, INCENSE_SUMI * (0.75 + 0.9 * light) * tint, cover * 0.6);
    col += air * 0.6;
  } else {
    col = col * (1.0 - 0.45 * cover) + cover * tint * onSmoke + air;
  }
  o.accent = max(o.accent, cover * mark * K_mark);

  // ---- light sources, on top ----------------------------------------------------------------------
  // The ember: a hot bead under the ash, its glow.
  float ember = incenseHeat * incensePresence;
  float glowShape = 1.2 * exp(-dot(de, de) / 0.0000045) + 0.3 * exp(-dot(de, de) / 0.00012) + 0.06 * exp(-dot(de, de) / 0.0016);
  if ((kind > 0.5 && kind < 1.5) || kind > 2.5) glowShape *= 0.5;
  col += (INCENSE_EMBER_CORE * exp(-dot(de, de) / 0.0000045) + INCENSE_EMBER * glowShape) * ember;
  o.accent = max(o.accent, clamp(glowShape * ember * 1.5, 0.0, 1.0));
  if (candle) col = incenseDrawFlame(col, p, flameBase, lean, aa);

  o.rgb = col;
  o.source = col;
  float lum = dot(col, LUMA);
  o.ink = paper ? clamp((0.9 - lum) / 0.8, 0.0, 1.0) : clamp(1.25 * lum, 0.0, 1.0);
  return o;
}
`;
