// The lava lamp's picture: a dark room at night, a lava lamp on a teak sideboard against papered
// wall. Its bulb, hidden in the metal base, shines up through the glass: the liquid glows, bright
// over the coil and dimmer toward the cap, and the wax drifting in it (simulated in sim.ts) is drawn
// as a metaball surface seen through the glass: dark and saturated where it is thick, glowing along
// its thin edges, lit from below, pale and matte while still cold and solid. The lamp throws its
// coloured light on the room: the glass's glow cast larger on the wall with the wax's shadows
// drifting through it, a pool on the sideboard ringed by the base's shadow, a sheen on the oiled
// top, a glint down the brushed metal; a moonlit window off to the left adds a cool pane on the wall.
//   uSim0  the wax parcels: row 2k (x, y, radius, temperature), row 2k + 1 (vx, vy, M glow) for
//          lamp k (0 the lamp, 1 its twin), in glass units (the liquid 1 tall, gx across)
//   uSim1  the coarse wax picture: r how much wax, g the bulb's light left after the wax below
//   uSim2  per lamp: parcels in use, bulb 0..1, warm-up 0..1, the wax's share of the glass
// Knobs read here: K_wax, K_spill, K_moon, K_hand, K_twin, K_sleeve, K_shelf, K_badge; the rest
// drive the simulation.
import { lavaLayoutGlsl } from "./sim.ts";

export const lavaGlsl = `
${lavaLayoutGlsl}
// The eye, in lamp units from a lamp's foot: its height and distance. We look down a little on the
// base and the sideboard and up a little at the cap; the sideboard's depth on screen follows.
#define LAVA_EYE 0.62
#define LAVA_DIST 3.2
// The sideboard: its top's front edge and where it meets the wall (frame heights), the top's thickness.
#define LAVA_TOP_FRONT 0.088
#define LAVA_TOP_BACK 0.2
#define LAVA_TOP_EDGE 0.014
// The lamp's light on the wall: the glass's glow cast LAVA_CAST times larger, as if from a point
// LAVA_CAST_Y up inside the base (lamp units).
#define LAVA_CAST 1.55
#define LAVA_CAST_Y 0.12
// How far the wax stands out of the picture: the dome over its outline (glass units).
#define LAVA_BULGE 0.06
// The record sleeve's half size (frame heights).
#define LAVA_SLEEVE 0.15

const vec3 LAVA_PAPER = vec3(0.5, 0.44, 0.4);   // the wallpaper
const vec3 LAVA_TEAK = vec3(0.42, 0.23, 0.12);  // the sideboard
const vec3 LAVA_MOON = vec3(0.42, 0.52, 0.8);   // moonlight through the window
const vec3 LAVA_BULB = vec3(1.0, 0.86, 0.6);    // the bulb itself, seen through the base

// A lamp's colours: its wax, its liquid, the light it throws on the room, its metal, and how much
// the liquid itself glows (clear liquid hardly scatters the light: the room shows through it).
struct LavaInk { vec3 wax; vec3 liquid; vec3 light; vec3 metal; float glow; };

struct LavaLamp {
  vec2 foot;    // where it stands (frame units: x from the left, y up)
  float size;   // its height (frame heights)
  int lamp;     // 0 the lamp, 1 its twin
  int count;    // wax parcels in use
  float bulb;   // 0 off .. 1 on
  float warm;   // 0 cold .. 1 warmed through
  float share;  // how much of the glass the wax covers in the picture
  LavaInk ink;
};

// The wax's metaball field at a point: its value and gradient, and the field-weighted temperature
// and M glow of the parcels making it.
struct LavaField { float f; vec2 grad; float temp; float mark; };

// Set once per pixel by sceneLava.
float lavaTh;       // this cell's dither threshold
float lavaPx;       // one cell, in frame heights
float lavaAccent;   // the accent gathered while drawing
float lavaSpill;    // how much of the lamps' light reaches the room
vec3 lavaAmbient;   // the room's own dim light: the lamps' glow bounced about, a little moonlight

float lavaBell(float x) {
  return exp(-x * x);
}

// The palettes, in K_wax order: red in yellow on gold, purple in blue on silver, green in aqua on
// black, white in clear on silver.
LavaInk lavaInk(float k) {
  LavaInk p;
  if (k < 0.5) {
    p.wax = vec3(0.95, 0.17, 0.05);
    p.liquid = vec3(1.0, 0.64, 0.12);
    p.light = vec3(1.0, 0.6, 0.2);
    p.metal = vec3(0.86, 0.62, 0.3);
    p.glow = 1.0;
  } else if (k < 1.5) {
    p.wax = vec3(0.72, 0.16, 0.92);
    p.liquid = vec3(0.14, 0.38, 1.0);
    p.light = vec3(0.34, 0.42, 1.0);
    p.metal = vec3(0.74, 0.76, 0.82);
    p.glow = 0.85;
  } else if (k < 2.5) {
    p.wax = vec3(0.45, 0.95, 0.12);
    p.liquid = vec3(0.05, 0.55, 0.75);
    p.light = vec3(0.22, 0.75, 0.7);
    p.metal = vec3(0.2, 0.2, 0.22);
    p.glow = 0.8;
  } else {
    p.wax = vec3(0.98, 0.94, 0.86);
    p.liquid = vec3(0.7, 0.78, 0.9);
    p.light = vec3(1.0, 0.84, 0.62);
    p.metal = vec3(0.74, 0.76, 0.82);
    p.glow = 0.35;
  }
  return p;
}

// Lamp k as it stands and as the simulation left it; the twin takes the next palette.
LavaLamp lavaLamp(int k, float aspect) {
  LavaLamp L;
  L.lamp = k;
  L.foot = k == 0 ? vec2(LAVA_A_X * aspect, LAVA_A_FOOT) : vec2(LAVA_B_X * aspect, LAVA_B_FOOT);
  L.size = k == 0 ? LAVA_A_SIZE : LAVA_B_SIZE;
  vec4 s = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(k, 0), 0) : vec4(0.0, 1.0, 1.0, 0.0);
  L.count = uSimOn.x > 0.5 ? int(s.x + 0.5) : 0;
  L.bulb = s.y;
  L.warm = s.z;
  L.share = s.w;
  float pal = floor(K_wax + 0.5);
  L.ink = lavaInk(k == 0 ? pal : mod(pal + 1.0, 4.0));
  // The more of the glass the wax covers (spread out, not merged), the more of its colour is in the
  // light the lamp throws.
  L.ink.light = mix(L.ink.light, L.ink.light * L.ink.wax * 1.4, 0.5 * L.share);
  return L;
}

// The coarse wax picture at glass point g: how much wax, and how much of the bulb's light is left.
vec2 lavaGrid(int lamp, vec2 g) {
  if (uSimOn.y < 0.5) return vec2(0.0, 1.0);
  float u = (g.x + LAVA_GRID_HALF) / (2.0 * LAVA_GRID_HALF);
  float v = (clamp(g.y * LAVA_GRID_Y, 0.5, LAVA_GRID_Y - 0.5) + float(lamp) * LAVA_GRID_Y) / (2.0 * LAVA_GRID_Y);
  return textureLod(uSim1, vec2(u, v), 0.0).rg;
}

// The wax at glass point q: each parcel a metaball, drawn out behind it into a teardrop as it moves
// (a rising blob trails a tail, a sinking one hangs a drip).
LavaField lavaField(vec2 q, int row, int n) {
  LavaField w;
  w.f = 0.0;
  w.grad = vec2(0.0);
  w.temp = 0.0;
  w.mark = 0.0;
  float sum = 0.0;
  for (int i = 0; i < LAVA_MAX; i++) {
    if (i >= n) break;
    vec4 a = texelFetch(uSim0, ivec2(i, row), 0);
    float R = a.z * LAVA_REACH;
    vec2 d = q - a.xy;
    if (R <= 0.0 || dot(d, d) > 3.0 * R * R) continue;
    vec4 b = texelFetch(uSim0, ivec2(i, row + 1), 0);
    float sp = length(b.xy);
    vec2 dir = sp > 1e-4 ? b.xy / sp : vec2(0.0, 1.0);
    vec2 side = vec2(dir.y, -dir.x);
    float st = min(sp * LAVA_STRETCH, 0.5);
    float along = dot(d, dir);
    float ka = along < 0.0 ? 1.0 / (1.0 + 1.3 * st) : 1.0 / (1.0 + 0.1 * st);
    float kc = 1.0 + 0.25 * st;
    float u = along * ka;
    float v = dot(d, side) * kc;
    float s2 = (u * u + v * v) / (R * R);
    if (s2 >= 1.0) continue;
    float k = 1.0 - s2;
    float k3 = k * k * k;
    w.f += k3;
    w.grad -= 6.0 * k * k / (R * R) * (u * ka * dir + v * kc * side);
    w.temp += k3 * a.w;
    w.mark += k3 * b.z;
    sum += k3;
  }
  if (sum > 0.0) {
    w.temp /= sum;
    w.mark /= sum;
  }
  return w;
}

// How far the front of a level circle of radius r at height y (lamp units) dips below its centre
// line at x across: we look down on the base and up at the cap.
float lavaDip(float y, float r, float x) {
  float c = clamp(x / r, -1.0, 1.0);
  return r * (LAVA_EYE - y) / LAVA_DIST * sqrt(1.0 - c * c);
}

// Distance to the outline of an ellipse of radii r (first order: good near the outline).
float lavaEllipseRing(vec2 q, vec2 r) {
  vec2 a = q / r;
  float k = length(a);
  return abs(k - 1.0) * k / max(length(a / r), 1e-4);
}

// The wire coil lying on the bottom of the glass, seen nearly edge on: two turns of a flat spiral.
float lavaCoil(vec2 q, float px) {
  float d = min(lavaEllipseRing(q - vec2(0.0, 0.03), vec2(0.11, 0.016)), lavaEllipseRing(q - vec2(0.0, 0.027), vec2(0.065, 0.01)));
  return 1.0 - smoothstep(0.8 * px, 1.8 * px, d);
}

// The light lamp L throws on the wall at p: the glass's glow cast larger on the paper, as if from a
// point low in the base, coloured and shadowed by the wax inside it, and a soft halo all round.
vec3 lavaAura(LavaLamp L, vec2 p) {
  vec2 c = L.foot + vec2(0.0, LAVA_CAST_Y * L.size);
  vec2 l = (c + (p - c) / LAVA_CAST - L.foot) / L.size;
  float s = (l.y - LAVA_BASE_H) / LAVA_GLASS_H;
  float rg = lavaGlassR(s);
  float soft = 0.025 + 0.05 * clamp(s, 0.0, 1.5);
  float shown = (1.0 - smoothstep(rg - soft, rg + soft, abs(l.x))) * smoothstep(-0.08, 0.04, s) * (1.0 - smoothstep(0.92, 1.04, s));
  vec3 col = vec3(0.0);
  if (shown > 0.0) {
    vec2 g = lavaGrid(L.lamp, vec2(l.x / LAVA_GLASS_H, clamp(s, 0.0, 1.0)));
    float bright = (0.3 + 0.9 * exp(-2.4 * max(s, 0.0))) * mix(1.0, g.y, 0.5);
    col = mix(L.ink.light, L.ink.wax * L.ink.light * 1.4, 0.6 * g.x) * (1.0 - 0.4 * g.x) * bright * shown;
  }
  // A warm halo all round: strong close to the glass, and faint over the whole wall.
  vec2 h = (p - L.foot) / L.size - vec2(0.0, 0.55);
  float d2 = dot(h, h);
  col += L.ink.light * (0.4 / (1.0 + 1.5 * d2) + 0.07 / (1.0 + 0.15 * d2));
  return col * L.bulb;
}

// Where p on the sideboard's top lies around lamp L's foot, in lamp units (x across, y in depth).
vec2 lavaOnTop(LavaLamp L, vec2 p) {
  return vec2(p.x - L.foot.x, (p.y - L.foot.y) * LAVA_DIST / LAVA_EYE) / L.size;
}

// Lamp L's light on the sideboard at p: from the glowing glass above, cut off close in by the base's
// shadow (the higher up the glass the light leaves, the nearer the foot it reaches).
vec3 lavaPool(LavaLamp L, vec2 p) {
  float rho = length(lavaOnTop(L, p));
  float e = 0.0;
  for (int k = 0; k < 3; k++) {
    float h = 0.4 + 0.18 * float(k);
    float r2 = rho * rho + h * h;
    float lit = smoothstep(-0.03, 0.03, rho - LAVA_COLLAR_R * h / (h - LAVA_BASE_H));
    e += (1.0 - 0.25 * float(k)) * h / (r2 * sqrt(r2)) * lit;
  }
  return L.ink.light * L.bulb * e * 0.1;
}

// The dark ring where lamp L's foot stands on the sideboard: 0.3 at its rim, 1 clear of it.
float lavaContact(LavaLamp L, vec2 p) {
  return mix(0.3, 1.0, smoothstep(LAVA_FOOT_R, LAVA_FOOT_R + 0.05, length(lavaOnTop(L, p))));
}

// Moonlight from a window off to the left, lying on the wall as a pane slanting down to the right,
// crossed by the window's mullion and transom.
float lavaMoonPane(vec2 p, float aspect) {
  vec2 r = p - vec2(0.27 * aspect, 0.56);
  float v = r.y + 0.32 * r.x;
  float side = 1.0 - smoothstep(0.15, 0.19, abs(r.x));
  float ends = 1.0 - smoothstep(0.24, 0.28, abs(v));
  float bars = (1.0 - 0.8 * (1.0 - smoothstep(0.006, 0.014, abs(r.x)))) * (1.0 - 0.8 * (1.0 - smoothstep(0.006, 0.014, abs(v - 0.05))));
  return side * ends * bars;
}

// The wallpaper: a tone-on-tone seventies pattern of rings and beads, fixed to the frame, seen only
// where the light falls.
float lavaPaper(vec2 p) {
  vec2 w = p / 0.15;
  w.x += 0.5 * mod(floor(w.y), 2.0);
  float d = length(fract(w) - 0.5);
  float ring = 1.0 - smoothstep(0.03, 0.06, abs(d - 0.32));
  float bead = 1.0 - smoothstep(0.08, 0.11, d);
  return 0.92 + 0.12 * ring + 0.08 * bead;
}

// Brushed metal round a cone, at xi across it (-1..1) and v up the part: the moonlit window streaked
// down its left, the room's warm glow on its right, the glowing glass above mirrored where it faces
// up (up 0..1), the pool on the sideboard where it faces down (down 0..1), faint lathe rings.
vec3 lavaMetal(LavaLamp L, float xi, float v, float up, float down) {
  float face = sqrt(max(1.0 - xi * xi, 0.0));
  vec3 tint = L.ink.metal;
  vec3 shine = mix(tint, vec3(1.0), 0.3);
  vec3 warm = L.ink.light * L.bulb;
  vec3 col = tint * (0.03 + 0.05 * face) + 2.0 * tint * lavaAmbient;
  col += shine * LAVA_MOON * K_moon * lavaBell((xi + 0.52) / 0.12);
  col += tint * warm * 0.24 * lavaBell((xi - 0.4) / 0.25);
  col += tint * warm * up * face * 0.7;
  col += tint * warm * down * 0.2 * lavaSpill;
  col *= 0.95 + 0.05 * sin(v * 130.0);
  return col * mix(0.5, 1.0, face);
}

// The Manifold M etched into the base's metal: a shallow groove, darker than the metal round it, its
// floor catching only a little of the bulb's warmth and the glass's glow.
vec3 lavaBadge(vec3 metal, LavaLamp L, vec2 l, float aa) {
  float size = 0.075;
  float stroke = 0.006;
  float d = markDistance((l - vec2(0.0, 0.14)) / size) * size;
  float cut = 1.0 - smoothstep(stroke - aa, stroke + aa, d);
  vec3 groove = 0.45 * metal + L.bulb * (0.06 * L.ink.metal * L.ink.light + 0.035 * LAVA_BULB);
  lavaAccent = max(lavaAccent, 0.4 * cut);
  return mix(metal, groove, cut);
}

// What shows through the glass at lamp point l (s up the glass, rg its outer radius there): the
// glowing liquid and the coil, the wax, then the glass itself. 'behind' is the room behind it.
vec3 lavaGlass(vec3 behind, LavaLamp L, vec2 l, float s, float rg, float aa) {
  LavaInk ink = L.ink;
  float ax = abs(l.x);
  float ri = rg - LAVA_WALL;
  float xo = l.x / rg;
  float xi = clamp(l.x / ri, -1.0, 1.0);
  // What shows here lies nearer the axis: the liquid magnifies the middle of the glass.
  vec2 q = vec2(ri / LAVA_GLASS_H * xi * (LAVA_LENS + (1.0 - LAVA_LENS) * xi * xi), s);
  vec2 grid = lavaGrid(L.lamp, vec2(q.x, clamp(s, 0.0, 1.0)));
  float P = sqrt(max(1.0 - xi * xi, 0.0));
  float low = exp(-3.0 * max(s, 0.0));
  float shade = mix(1.0, grid.y, 0.55);

  // The liquid glows with the bulb's light scattered in it: brightest low down, dimmer toward the
  // cap and over the wax that shades it, fuller through the middle where the glass is deepest, with
  // a faint warm haze all the way up so the glass reads to the cap; over the coil a white-hot core.
  // Cold, it is cloudy.
  float glow = L.bulb * (0.3 + low * shade) * (0.6 + 0.4 * P);
  vec3 col = ink.liquid * glow * ink.glow + behind * (1.0 - ink.glow) * 0.8;
  col += ink.light * L.bulb * (0.045 + 0.03 * (1.0 - clamp(s, 0.0, 1.0)));
  float core = L.bulb * exp(-(q.x * q.x / 0.01 + s * s / 0.005));
  col = mix(col, vec3(1.0, 0.92, 0.76), 0.55 * core);
  float cloud = 1.0 - smoothstep(0.15, 0.8, L.warm);
  vec3 milky = mix(ink.liquid, vec3(0.92, 0.9, 0.86), 0.55) * L.bulb * (0.16 + 0.5 * low) * (0.5 + 0.5 * P);
  col = mix(col, milky, 0.85 * cloud);
  col *= 1.0 - 0.75 * lavaCoil(q, aa / LAVA_GLASS_H);
  // Your hand on the glass: the liquid under it warms and glows a little.
  if (K_hand > 0.5 && uMouse.z > 0.5) {
    vec2 hand = (uMouse.xy * vec2(uRes.x / uRes.y, 1.0) - L.foot) / L.size - l;
    col += ink.light * 0.12 * L.bulb * exp(-dot(hand, hand) / 0.004);
  }

  // The wax: its outline all or nothing per cell against the dither, so a moving edge flips each
  // cell once. Inside, lit by the glowing liquid all round it and by the bulb from below, deeper and
  // more saturated where thick, glowing along its thin, back-lit edges; pale and matte while solid;
  // brighter in the M.
  if (L.count > 0) {
    LavaField w = lavaField(q, 2 * L.lamp, L.count);
    float depth = w.f - LAVA_ISO;
    float cell = aa / LAVA_GLASS_H * 0.5 * (1.0 + LAVA_LENS + 3.0 * (1.0 - LAVA_LENS) * xi * xi);
    float cover = clamp(0.5 + depth / (max(length(w.grad), 1e-3) * cell), 0.0, 1.0);
    if (cover > lavaTh) {
      float dd = max(depth, 0.0);
      vec3 n = normalize(vec3(-w.grad * LAVA_BULGE / (2.0 * sqrt(dd + 0.002)), 1.0));
      float thick = 1.0 - exp(-2.4 * dd);
      float liq = L.bulb * (0.3 + low * shade);
      float under = L.bulb * (0.16 + 1.05 * low * shade);
      float below = max(-n.y, 0.0);
      float rim = 1.0 - smoothstep(0.0, 0.42, thick);
      vec3 wax = ink.wax * (0.7 * liq + 0.7 * under * (0.45 + 0.55 * below)) * (1.0 - 0.3 * thick);
      wax += ink.wax * rim * (0.5 * liq + 0.9 * under) + ink.light * rim * rim * 0.12 * L.bulb;
      wax *= mix(vec3(1.0), ink.wax, 0.4 * thick);
      wax = mix(wax, wax * ink.liquid * 1.6, 0.2 * ink.glow);
      float solid = 1.0 - smoothstep(0.1, 0.22, w.temp);
      vec3 cold = mix(ink.wax, vec3(0.86, 0.84, 0.8), 0.35) * (0.08 + 0.5 * under * (0.6 + 0.4 * below));
      wax = mix(wax, cold, solid);
      wax *= 1.0 + 0.3 * smoothstep(0.6, 1.0, w.temp);
      wax = mix(wax, ink.wax * 1.25 + 0.12, 0.55 * w.mark);
      col = wax;
      lavaAccent = max(lavaAccent, mix(0.6 + 0.4 * rim, 1.0, w.mark));
    }
  }

  // The glass: its wall a darker band where the light bends away, a bright line along its outer edge,
  // the moonlit window mirrored in a narrow streak down the left, the room's glow broad on the right.
  float wall = smoothstep(ri - aa, ri + aa, ax);
  col = mix(col, col * 0.5 + ink.liquid * glow * 0.12, wall);
  col += (vec3(0.06) + ink.light * 0.14 * L.bulb) * lavaBell((ax - rg + 0.8 * aa) / (1.1 * aa));
  col += LAVA_MOON * (0.04 + 0.5 * K_moon) * lavaBell((xo + 0.56) / 0.075) * (0.5 + 0.5 * smoothstep(0.0, 0.4, s));
  col += ink.light * 0.06 * L.bulb * lavaBell((xo - 0.5) / 0.2);
  return col;
}

// Lamp L over col at p: the glass, then the metal base (a cone from its foot ring up to the collar
// the glass sits in) and the cap. Their level rims curve with the eye's height.
vec3 lavaDrawLamp(vec3 col, vec2 p, LavaLamp L) {
  vec2 l = (p - L.foot) / L.size;
  float ax = abs(l.x);
  if (ax > LAVA_FOOT_R + 0.02 || l.y < -0.05 || l.y > 1.02) return col;
  float aa = lavaPx / L.size;
  float footY = -lavaDip(0.0, LAVA_FOOT_R + 0.006, l.x);
  float collarY = LAVA_BASE_H - lavaDip(LAVA_BASE_H, LAVA_COLLAR_R + 0.007, l.x);
  float capY = LAVA_BASE_H + LAVA_GLASS_H;
  float capLow = capY - lavaDip(capY, LAVA_CAP_BOTTOM, l.x);
  float capHigh = 1.0 - lavaDip(1.0, LAVA_CAP_TOP, l.x);

  float s = (l.y - LAVA_BASE_H) / LAVA_GLASS_H;
  float rg = lavaGlassR(s);
  float inGlass = (1.0 - smoothstep(-aa, aa, ax - rg)) * step(collarY - 2.0 * aa, l.y) * step(l.y, capLow + 2.0 * aa);
  if (inGlass > 0.0) col = mix(col, lavaGlass(col, L, l, s, rg, aa), inGlass);

  float v = clamp(l.y / LAVA_BASE_H, 0.0, 1.0);
  float lipY = collarY - 0.03;
  float lip = smoothstep(lipY - aa, lipY + aa, l.y);
  float ring = 1.0 - smoothstep(0.012, 0.012 + aa, l.y - footY);
  float rb = mix(LAVA_FOOT_R, LAVA_COLLAR_R, v) + 0.007 * lip + 0.006 * ring;
  float inBase = (1.0 - smoothstep(-aa, aa, ax - rb)) * smoothstep(footY - aa, footY + aa, l.y) * (1.0 - smoothstep(collarY - aa, collarY + aa, l.y));
  if (inBase > 0.0) {
    float xi = clamp(l.x / rb, -1.0, 1.0);
    // Up the surface, so the lathe rings curve round the cone with its rims.
    float around = (l.y + lavaDip(l.y, rb, l.x)) / LAVA_BASE_H;
    vec3 metal = lavaMetal(L, xi, around, max(lip, 0.6 * smoothstep(0.6, 0.95, v)), 1.0 - smoothstep(0.0, 0.25, v));
    // Grooves under the collar's lip and over the foot ring.
    float groove = max(1.0 - smoothstep(0.0, 1.5 * aa, abs(l.y - lipY)), 1.0 - smoothstep(0.0, 1.5 * aa, abs(l.y - footY - 0.012)));
    metal *= 1.0 - 0.6 * groove;
    if (L.lamp == 0 && K_badge > 0.5) metal = lavaBadge(metal, L, l, aa);
    col = mix(col, metal, inBase);
  }

  float u = clamp((l.y - capY) / LAVA_CAP_H, 0.0, 1.0);
  float rc = mix(LAVA_CAP_BOTTOM, LAVA_CAP_TOP, u);
  float inCap = (1.0 - smoothstep(-aa, aa, ax - rc)) * smoothstep(capLow - aa, capLow + aa, l.y) * (1.0 - smoothstep(capHigh - aa, capHigh + aa, l.y));
  if (inCap > 0.0) {
    float xi = clamp(l.x / rc, -1.0, 1.0);
    // Its lower rim lit by the glowing liquid just under it.
    vec3 metal = lavaMetal(L, xi, u, 0.25, 0.0) + L.ink.metal * L.ink.light * L.bulb * 0.5 * (1.0 - smoothstep(0.0, 0.25, u));
    col = mix(col, metal, inCap);
  }
  return col;
}

// The record sleeve leaning on the wall left of the lamp: its centre (frame units).
vec2 lavaSleeveAt(LavaLamp A) {
  return vec2(A.foot.x - 0.43, LAVA_TOP_BACK - 0.008 + LAVA_SLEEVE);
}

// 1 inside the sleeve centred at c, soft-edged by w; leaning back, it is a touch narrower at the top.
float lavaSleeveMask(vec2 p, vec2 c, float w) {
  vec2 q = p - c;
  float hw = LAVA_SLEEVE * (1.0 - 0.03 * q.y / LAVA_SLEEVE);
  return (1.0 - smoothstep(hw - w, hw + w, abs(q.x))) * (1.0 - smoothstep(LAVA_SLEEVE - w, LAVA_SLEEVE + w, abs(q.y)));
}

// The sleeve's shadow on the wall: the lamp stands to its right and in front, so it falls a little left.
float lavaSleeveShadow(vec2 p, LavaLamp A) {
  return lavaSleeveMask(p + vec2(0.03, 0.0), lavaSleeveAt(A), 0.02);
}

// The sleeve's print at a (-1..1 across and up): a setting sun cut by bands that thicken toward the
// horizon, a brown ground with an orange line, the title as two bars, and ring wear where the
// record inside has rubbed through the ink.
vec3 lavaSleeveArt(vec2 a) {
  vec3 col = vec3(0.86, 0.78, 0.62);
  vec2 sc = a - vec2(0.0, 0.12);
  float sun = 1.0 - smoothstep(0.6, 0.63, length(sc));
  float below = max(-sc.y, 0.0);
  float bands = sc.y > 0.0 ? 1.0 : smoothstep(0.3, 0.36, fract(sqrt(below) * 3.5));
  vec3 sunCol = mix(vec3(0.98, 0.72, 0.22), vec3(0.86, 0.26, 0.12), smoothstep(-0.6, 0.6, -sc.y));
  col = mix(col, sunCol, sun * bands);
  col = mix(col, vec3(0.32, 0.15, 0.08), 1.0 - smoothstep(-0.63, -0.6, a.y));
  col = mix(col, vec3(0.9, 0.45, 0.12), (1.0 - smoothstep(0.0, 0.02, abs(a.y + 0.56))));
  float title = step(abs(a.y - 0.8), 0.035) * step(-0.84, a.x) * step(a.x, -0.18);
  title = max(title, step(abs(a.y - 0.68), 0.025) * step(-0.84, a.x) * step(a.x, -0.42));
  col = mix(col, vec3(0.22, 0.12, 0.08), title);
  col *= 1.0 + 0.08 * (1.0 - smoothstep(0.0, 0.05, abs(length(a) - 0.88)));
  return col * (0.9 + 0.1 * (1.0 - smoothstep(0.9, 1.0, max(abs(a.x), abs(a.y)))));
}

// The wall: papered, lit by the lamps (the sleeve shadowing them) and the moon, darker into the
// corner where it meets the sideboard.
vec3 lavaWall(vec2 p, LavaLamp A, LavaLamp B, bool twin, float aspect) {
  vec3 lamp = lavaAura(A, p);
  if (twin) lamp += lavaAura(B, p);
  if (K_sleeve > 0.5) lamp *= 1.0 - 0.55 * lavaSleeveShadow(p, A);
  vec3 light = lavaAmbient + lavaSpill * lamp + LAVA_MOON * K_moon * 0.9 * lavaMoonPane(p, aspect);
  vec3 col = LAVA_PAPER * lavaPaper(p) * light;
  return col * (1.0 - 0.45 * exp(-(p.y - LAVA_TOP_BACK) / 0.014));
}

// The sideboard's oiled teak top, seen at a low angle: grain, the lamps' pools ringed by their bases'
// shadows, moonlight along the back, the glowing wall mirrored toward the back, the lit front edge.
vec3 lavaTop(vec2 p, LavaLamp A, LavaLamp B, bool twin, float aspect) {
  float depth = (p.y - LAVA_TOP_FRONT) / (LAVA_TOP_BACK - LAVA_TOP_FRONT);
  float grain = vnoise(vec2(p.x * 7.0 / (0.35 + depth), 34.0 * log(0.35 + depth)));
  vec3 albedo = LAVA_TEAK * (0.78 + 0.44 * grain);
  vec3 lamp = lavaPool(A, p);
  float shade = lavaContact(A, p);
  if (twin) {
    lamp += lavaPool(B, p);
    shade *= lavaContact(B, p);
  }
  vec3 light = lavaAmbient + lavaSpill * lamp + LAVA_MOON * K_moon * 0.2 * depth * lavaMoonPane(vec2(p.x + 0.12, 0.45), aspect);
  vec3 col = albedo * light * shade;
  vec2 m = vec2(p.x, 2.0 * LAVA_TOP_BACK - p.y);
  vec3 seen = lavaAura(A, m);
  if (twin) seen += lavaAura(B, m);
  col += LAVA_PAPER * seen * lavaSpill * (0.03 + 0.12 * depth) * shade;
  col += LAVA_TEAK * (light * 1.6 + 0.015) * lavaBell((p.y - LAVA_TOP_FRONT - 1.5 * lavaPx) / (1.5 * lavaPx));
  return col;
}

// The sideboard's front, in shadow under the top's lit edge: sliding doors and their seams.
vec3 lavaFront(vec2 p, LavaLamp A, LavaLamp B, bool twin) {
  vec2 edgeAt = vec2(p.x, LAVA_TOP_FRONT);
  vec3 pool = lavaPool(A, edgeAt);
  if (twin) pool += lavaPool(B, edgeAt);
  vec3 lit = lavaAmbient + lavaSpill * pool * 0.35;
  float edge = step(LAVA_TOP_FRONT - LAVA_TOP_EDGE, p.y);
  vec3 col = LAVA_TEAK * (0.04 + 0.015 * vnoise(vec2(p.x * 3.0, p.y * 45.0)));
  col = mix(col, LAVA_TEAK * (lit * 1.2 + 0.03), edge);
  float under = 1.0 - smoothstep(0.0, 3.0 * lavaPx, LAVA_TOP_FRONT - LAVA_TOP_EDGE - p.y);
  float seam = 1.0 - smoothstep(0.0, 1.5 * lavaPx, abs(fract(p.x / 0.55 + 0.3) - 0.5) * 0.55);
  return col * (1.0 - (1.0 - edge) * max(0.6 * under, 0.5 * seam));
}

// The lamp's cord, out of the back of the base and across the top to the wall, with its switch.
vec3 lavaCord(vec3 col, vec2 p, LavaLamp A) {
  float x0 = A.foot.x - 0.02;
  float x1 = A.foot.x - 0.3;
  if (p.x > x0 || p.x < x1 - 0.02 || p.y < A.foot.y) return col;
  float y0 = A.foot.y + 0.018;
  float y1 = LAVA_TOP_BACK - 0.004;
  float t = clamp((x0 - p.x) / (x0 - x1), 0.0, 1.0);
  float y = mix(y0, y1, smoothstep(0.0, 1.0, t));
  float slope = (y1 - y0) * 6.0 * t * (1.0 - t) / (x0 - x1);
  float d = abs(p.y - y) / sqrt(1.0 + slope * slope);
  float cord = 1.0 - smoothstep(0.0022 - 0.6 * lavaPx, 0.0022 + 0.6 * lavaPx, d);
  vec2 sc = vec2(mix(x0, x1, 0.55), mix(y0, y1, smoothstep(0.0, 1.0, 0.55)));
  vec2 sd = abs(p - sc) - vec2(0.016, 0.0045);
  float sw = 1.0 - smoothstep(-lavaPx, lavaPx, length(max(sd, 0.0)) + min(max(sd.x, sd.y), 0.0) - 0.002);
  vec3 lit = lavaAmbient + lavaSpill * lavaPool(A, p);
  vec3 c = vec3(0.018) + lit * (0.25 + 0.35 * sw * smoothstep(sc.y - 0.002, sc.y + 0.005, p.y));
  return mix(col, c, max(cord, sw));
}

// The record sleeve and its record, slid half out to the right: black vinyl whose grooves catch the
// lamp in a bright band pointing at it, a printed sleeve lit by the lamps and the moon.
vec3 lavaSleeve(vec3 col, vec2 p, LavaLamp A, LavaLamp B, bool twin, float aspect) {
  vec2 c = lavaSleeveAt(A);
  vec2 q = p - c;
  if (abs(q.y) > LAVA_SLEEVE + 0.01 || q.x < -LAVA_SLEEVE - 0.01 || q.x > LAVA_SLEEVE + 0.08) return col;
  vec3 lamp = lavaAura(A, p);
  if (twin) lamp += lavaAura(B, p);
  vec3 light = lavaAmbient + lavaSpill * lamp * 1.15 + LAVA_MOON * K_moon * 0.9 * lavaMoonPane(p, aspect);

  vec2 rc = c + vec2(0.072, 0.004);
  vec2 rq = p - rc;
  float rr = LAVA_SLEEVE * 0.94;
  float dr = length(rq);
  float disc = 1.0 - smoothstep(rr - lavaPx, rr + lavaPx, dr);
  if (disc > 0.0) {
    vec2 toLamp = normalize(A.foot + vec2(0.0, 0.55 * A.size) - rc);
    float c1 = dot(rq / max(dr, 1e-4), toLamp);
    float grooves = smoothstep(0.045, 0.06, dr) * (1.0 - smoothstep(rr - 0.012, rr - 0.004, dr));
    float sheen = pow(abs(c1), 24.0) * grooves;
    vec3 vinyl = vec3(0.025, 0.024, 0.028) * (0.4 + 2.0 * light) + sheen * (1.2 * lavaSpill * lamp + 0.02);
    vinyl += 0.6 * lavaSpill * lamp * (1.0 - smoothstep(0.0, 2.0 * lavaPx, rr - dr)) * max(c1, 0.0);
    col = mix(col, vinyl, disc);
  }

  float inside = lavaSleeveMask(p, c, lavaPx);
  if (inside > 0.0) {
    vec2 a = vec2(q.x / (LAVA_SLEEVE * (1.0 - 0.03 * q.y / LAVA_SLEEVE)), q.y / LAVA_SLEEVE);
    vec3 sleeve = lavaSleeveArt(a) * light * 1.1;
    // The open edge on the right, catching the lamp.
    sleeve += 0.25 * lavaSpill * lamp * (1.0 - smoothstep(0.0, 0.03, 1.0 - a.x));
    col = mix(col, sleeve, inside);
  }
  return col;
}

// A small trailing plant in a clay pot standing on the shelf at base: a crown of leaves over the pot,
// two vines hanging over the shelf's edge, swaying very slowly.
vec3 lavaPlant(vec3 col, vec2 p, vec2 base, vec3 light, float tm) {
  vec2 q = p - base;
  if (abs(q.x) > 0.12 || q.y > 0.13 || q.y < -0.32) return col;
  float potW = mix(0.026, 0.034, clamp(q.y / 0.06, 0.0, 1.0));
  float pot = step(0.0, q.y) * step(q.y, 0.06) * (1.0 - smoothstep(potW - lavaPx, potW + lavaPx, abs(q.x)));
  col = mix(col, vec3(0.5, 0.26, 0.16) * light * (0.75 + 0.5 * smoothstep(-0.03, 0.03, q.x)), pot);
  float cover = 0.0;
  float lit = 0.0;
  for (int k = 0; k < 16; k++) {
    float fk = float(k);
    vec2 c;
    float ang;
    float sz;
    if (k < 4) {
      ang = -1.0 + 0.65 * fk;
      c = vec2(0.0, 0.07) + 0.03 * vec2(sin(ang), 0.8 * cos(ang));
      sz = 0.016;
    } else {
      float vine = k < 10 ? 0.0 : 1.0;
      float j = fk - (k < 10 ? 4.0 : 10.0);
      float s = (j + 0.6) / 6.0;
      float len = vine < 0.5 ? 0.28 : 0.2;
      float alt = mod(j, 2.0) < 0.5 ? 1.0 : -1.0;
      c = vec2((vine < 0.5 ? -0.032 : 0.028) + 0.012 * sin(s * 5.0 + vine) + 0.006 * sin(0.25 * tm + 2.0 * vine) * s * s + 0.008 * alt, 0.04 - len * s);
      ang = 3.14159 + 0.8 * alt;
      sz = 0.013 * (1.0 - 0.3 * s);
    }
    vec2 d = rotate(q - c, -ang);
    float lf = length(vec2(d.x / (sz * 0.62 * (1.1 - 0.45 * clamp(d.y / sz, -1.0, 1.0))), d.y / sz));
    float leaf = 1.0 - smoothstep(1.0 - lavaPx / sz, 1.0 + lavaPx / sz, lf);
    if (leaf > cover) {
      cover = leaf;
      lit = 0.7 + 0.5 * clamp(d.x / sz, -1.0, 1.0) - 0.25 * (1.0 - smoothstep(0.0, 0.12, abs(d.x / sz)));
    }
  }
  return mix(col, vec3(0.1, 0.24, 0.08) * light * lit * 1.4, cover);
}

// A wall shelf up to the left: a row of books, the plant, the board and its shadow on the wall.
vec3 lavaShelf(vec3 col, vec2 p, LavaLamp A, LavaLamp B, bool twin, float aspect, float tm) {
  float x0 = A.foot.x - 1.08;
  float x1 = A.foot.x - 0.46;
  float top = 0.7;
  if (p.x < x0 - 0.05 || p.x > x1 + 0.05 || p.y > top + 0.2 || p.y < top - 0.34) return col;
  vec3 lamp = lavaAura(A, p);
  if (twin) lamp += lavaAura(B, p);
  vec3 light = lavaAmbient + lavaSpill * lamp + LAVA_MOON * K_moon * 0.9 * lavaMoonPane(p, aspect);
  float span = smoothstep(x0 - 0.03, x0 + 0.03, p.x) * (1.0 - smoothstep(x1 - 0.03, x1 + 0.03, p.x));
  col *= 1.0 - 0.5 * span * smoothstep(top - 0.09, top - 0.02, p.y) * step(p.y, top - 0.02);

  float bx = p.x - (x0 + 0.03);
  if (bx > 0.0 && bx < 0.33 && p.y > top && p.y < top + 0.2) {
    float i = floor(bx / 0.024);
    float h = hash12(vec2(i, 7.1));
    float height = 0.11 + 0.07 * h;
    float fx = fract(bx / 0.024);
    float book = step(p.y, top + height) * smoothstep(0.02, 0.08, fx) * (1.0 - smoothstep(0.92, 0.98, fx)) * step(0.12, hash12(vec2(i, 3.3)));
    vec3 cover = mix(vec3(0.35, 0.12, 0.08), vec3(0.12, 0.2, 0.3), h);
    cover = mix(cover, vec3(0.5, 0.42, 0.28), step(0.7, fract(h * 13.7)));
    cover *= 1.0 - 0.3 * step(abs(p.y - top - height + 0.025), 0.004);
    col = mix(col, cover * light * (0.85 + 0.3 * sin(fx * 3.14159)), book);
  }
  col = lavaPlant(col, p, vec2(x1 - 0.07, top), light, tm);

  float board = span * (1.0 - smoothstep(0.011 - lavaPx, 0.011 + lavaPx, abs(p.y - top + 0.011)));
  vec3 wood = LAVA_TEAK * light * (0.9 + 0.8 * (1.0 - smoothstep(0.0, 2.0 * lavaPx, top - p.y)));
  return mix(col, wood, board);
}

Shade sceneLava(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  lavaTh = threshold(cell);
  lavaPx = 1.0 / uRes.y;
  lavaAccent = 0.0;
  lavaSpill = 1.2 * K_spill;
  LavaLamp A = lavaLamp(0, aspect);
  LavaLamp B = lavaLamp(1, aspect);
  bool twin = K_twin > 0.5;
  vec3 bounce = A.ink.light * A.bulb + (twin ? 0.6 * B.ink.light * B.bulb : vec3(0.0));
  lavaAmbient = vec3(0.008, 0.009, 0.014) + 0.03 * lavaSpill * bounce + 0.01 * K_moon * LAVA_MOON;

  vec3 col;
  if (p.y > LAVA_TOP_BACK) col = lavaWall(p, A, B, twin, aspect);
  else if (p.y > LAVA_TOP_FRONT) col = lavaCord(lavaTop(p, A, B, twin, aspect), p, A);
  else col = lavaFront(p, A, B, twin);
  if (K_shelf > 0.5) col = lavaShelf(col, p, A, B, twin, aspect, t * uMotion);
  if (K_sleeve > 0.5) col = lavaSleeve(col, p, A, B, twin, aspect);
  if (twin) col = lavaDrawLamp(col, p, B);
  col = max(lavaDrawLamp(col, p, A), 0.0);

  o.rgb = col;
  o.source = col;
  o.ink = clamp(1.3 * dot(col, LUMA), 0.0, 1.0);
  o.accent = clamp(lavaAccent, 0.0, 1.0);
  return o;
}
`;
