// A solar system hanging in a quiet room under a glowing Sun, the room's lamp: a preset of the
// `interior` composer (layers.ts). The shared chunk (mobileBegin) holds the room in metres, the
// mobile's own pinhole and where the cell's ray meets the room; the quiet room (the backdrop) paints
// the wall, the floor and the ceiling, and the solar system (the subject) the mobile in front of them.
// The mobile itself is the shared part (sims/mobile.ts): its balls, wires and links traced along each
// view ray (mobileTrace) and the share of a round light it hides from any point (mobileShadow). The
// planets' looks lean on the shared giant planet (shaders/lib/planet.ts): Jupiter's and Saturn's
// belts and zones in its band colours (planetBandColor), Venus's and Neptune's turbulent belts
// (planetBelts), the Earth's cloud deck (planetClouds), the noise of the rocky ones (planetFbm),
// Saturn's banded rings (planetRingBands). Each planet's markings are fixed to its own axis, kept
// still in the room (it hangs on a swivel).
//
// Light: the Sun (K_sun) lights everything from where it hangs, so each planet shows a day side
// toward it and a night side away from it as its arm turns; its light (K_softness: how big the bulb
// inside the globe is) throws the mobile's shadows, Saturn's ring's included, onto the other planets
// (the mobile's own, mobileLight) and onto the wall, the floor and the ceiling: the Sun is the solar
// system's declared light (solarMobileSun, which the room takes through localLight), and it asks the
// room's shapes along the ray toward it (roomRayCaster, the mobile's rayCaster solarMobileCaster),
// each cut per cell against its own threshold. A dim window on the right (K_fill) and the room's own
// ambient keep the room and the night sides readable. K_room picks a dark room or a white one in
// daylight.
//
// Passage: the Sun lights up from an ember as the mobile comes to rest, and cools as it leaves
// (mobileSunWarm, 1 at rest); the mobile's lowering and hoisting are the sim's pose.
//
// Knobs read here: K_room, K_fill, K_mark (the quiet room's); K_planets (which arm Saturn is on),
// K_sun, K_softness (the solar system's; its others drive the simulation). Textures: the solar
// system's field 0, the MobileTexture.
import type { SharedGlsl } from "../../composer/types.ts";
import { MARK_VERTICES } from "../../mark.ts";
import { glslFloat, glslVec3 } from "../../shaders/glsl.ts";
import { planetGlsl } from "../../shaders/lib/planet.ts";
import { mobileGlsl } from "../../sims/mobile.ts";
import { MOBILE_SUN_CENTRE, MOBILE_TEX_ORIGIN, mobileLayoutGlsl } from "./layout.ts";
import { SOLAR_LOOKS, SOLAR_RINGS, solarGlsl } from "./solar.ts";

/** Saturn's axis: tipped SOLAR_RINGS.tilt from upright, mostly toward the eye, so its rings open to the room. */
const SATURN_AXIS = [
  0.3 * Math.sin(SOLAR_RINGS.tilt),
  Math.cos(SOLAR_RINGS.tilt),
  Math.sqrt(1 - 0.09) * Math.sin(SOLAR_RINGS.tilt),
] as const;

/** The M of glow-in-the-dark stars: three along each of the M's strokes and one at its last corner (mark units). */
const MARK_STARS = MARK_VERTICES.flatMap(([x, y], i) => {
  const next = MARK_VERTICES[i + 1];
  if (next === undefined) return [[x, y]];
  return [0, 1 / 3, 2 / 3].map((t) => [x + (next[0] - x) * t, y + (next[1] - y) * t]);
});

const looks = Object.entries(SOLAR_LOOKS)
  .map(([name, look]) => `const int MOBILE_${name.toUpperCase()} = ${look};`)
  .join("\n");

const mobileShared = `
${mobileLayoutGlsl}
// The window on the right the fill comes through.
const vec3 MOBILE_WINDOW = vec3(0.62, 0.42, 0.66);

bool mobileDay() {
  return K_room > 0.5;
}

vec3 mobileAmbient() {
  return mobileDay() ? vec3(0.36, 0.37, 0.39) : vec3(0.012, 0.013, 0.02);
}

vec3 mobileFill() {
  return (mobileDay() ? vec3(1.0, 0.88, 0.7) * 0.7 : vec3(0.42, 0.52, 0.9) * 0.7) * K_fill;
}

// ---- The cell's state (mobileBegin), set once a cell and read by the mobile's layers

vec3 mobileRo;      // the eye, swayed by the pointer
vec3 mobileRd;      // the cell's ray
float mobileCellW;  // a cell's width along the ray, a metre out
vec3 mobileP;       // where the ray meets the room
vec3 mobileN;       // the room's surface there, facing into the room
int mobileSurface;  // which: 0 the wall, 1 the floor, 2 the ceiling
float mobileTSurf;  // how far along the ray (m)
float mobileCw;     // a cell there (m)

// The mobile's own camera, and the room: the wall, or the floor or ceiling where the ray meets them
// first. Off the rest pose (ROOM_POSE: the live camera, composer/camera.ts) the eye moves in the
// room's frame (its z ahead, the mobile's -z), turns about the up and pitches about its own right,
// and zooms; it draws through the cell's own frame point (x.q).
void mobileBegin(Ctx x) {
  vec3 ro = MOBILE_EYE + vec3(MOBILE_SWAY * uPointer, 0.0);
  vec3 fwd = normalize(MOBILE_AIM - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  float focal = mobileFocal(x.aspect);
#if ROOM_POSE
  vec4 a = uCamera[0];
  vec4 b = uCamera[1];
  ro += vec3(a.x, a.y, -a.z);
  float cy = cos(b.x);
  float sy = sin(b.x);
  fwd = vec3(fwd.x * cy + fwd.z * sy, fwd.y, fwd.z * cy - fwd.x * sy);
  right = vec3(right.x * cy + right.z * sy, right.y, right.z * cy - right.x * sy);
  up = vec3(up.x * cy + up.z * sy, up.y, up.z * cy - up.x * sy);
  float cp = cos(b.y);
  float sp = sin(b.y);
  vec3 ahead = fwd * cp - up * sp;
  up = up * cp + fwd * sp;
  fwd = ahead;
  focal *= a.w;
#endif
  vec3 rd = normalize(fwd * focal + right * x.q.x + up * x.q.y);
  mobileRo = ro;
  mobileRd = rd;
  mobileCellW = dot(fwd, rd) / (focal * uRes.y);
  float tSurf = (MOBILE_WALL - ro.z) / rd.z;
  vec3 n = vec3(0.0, 0.0, 1.0);
  int surface = 0;
  if (rd.y < 0.0 && -ro.y / rd.y < tSurf) {
    tSurf = -ro.y / rd.y;
    n = vec3(0.0, 1.0, 0.0);
    surface = 1;
  } else if (rd.y > 0.0 && (MOBILE_CEILING - ro.y) / rd.y < tSurf) {
    tSurf = (MOBILE_CEILING - ro.y) / rd.y;
    n = vec3(0.0, -1.0, 0.0);
    surface = 2;
  }
  mobileTSurf = tSurf;
  mobileN = n;
  mobileSurface = surface;
  mobileP = ro + rd * tSurf;
  mobileCw = tSurf * mobileCellW;
}
`;

/** The mobile's shared chunk: the room in metres, the mobile's pinhole, the cell's ray into the room. */
export const mobileSharedGlsl: SharedGlsl = {
  id: "mobile",
  glsl: () => mobileShared,
  begin: "mobileBegin",
};

/** The quiet room: the wall, the floor and the ceiling, lit; the M's stars; the night's falling away. */
export const quietRoomGlsl = `
// The M of stars on the wall: its middle (x, y) and height (m).
const vec3 MOBILE_STARS = vec3(1.55, 2.3, 0.42);
const vec2 MOBILE_STAR[${MARK_STARS.length}] = vec2[${MARK_STARS.length}](${MARK_STARS.map(([x, y]) => `vec2(${glslFloat(x ?? 0)}, ${glslFloat(y ?? 0)})`).join(", ")});

// iq's five-pointed star: r its outer radius, rf the inner radius's share.
float mobileStar(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

// Whether wall point P lies on one of the M's stars (cut per cell; cw a cell there).
float mobileStars(vec3 P, float cw) {
  vec2 q = (P.xy - MOBILE_STARS.xy) / MOBILE_STARS.z;
  if (abs(q.x) > 0.62 || abs(q.y) > 0.62) return 0.0;
  float d = 1.0e3;
  for (int i = 0; i < ${MARK_STARS.length}; i++) d = min(d, mobileStar(q - MOBILE_STAR[i], 0.085, 0.45));
  return hardFill(d * MOBILE_STARS.z / cw, 0.7);
}

// The plaster wall: a faint, broad mottle; a skirting board along the floor.
vec3 mobileWall(vec3 P) {
  vec3 plaster = mobileDay() ? vec3(0.86, 0.85, 0.82) : vec3(0.58, 0.53, 0.48);
  plaster *= 0.96 + 0.06 * vnoise(P.xy * 3.0 + 7.0) + 0.03 * vnoise(P.xy * 11.0);
  if (P.y < 0.12) plaster = mobileDay() ? vec3(0.8, 0.79, 0.76) : vec3(0.33, 0.3, 0.27);
  return plaster;
}

// The floor: oak boards running across the room.
vec3 mobileFloor(vec3 P, float cw) {
  float v = P.z / 0.14;
  float board = floor(v);
  float seam = smoothfall(0.06 + cw / 0.14, 0.02, min(fract(v), 1.0 - fract(v)));
  float tone = 0.85 + 0.3 * hash12(vec2(board, 3.1));
  float grain = 0.9 + 0.2 * vnoise(vec2(P.x * 1.5 + board * 4.7, P.z * 40.0));
  vec3 oak = (mobileDay() ? vec3(0.55, 0.4, 0.26) : vec3(0.36, 0.25, 0.15)) * tone * mix(1.0, grain, smoothfall(0.02, 0.006, cw));
  return oak * (1.0 - 0.5 * seam);
}

// The room where the cell's ray meets it, lit by the room's ambient, the window and the lights in it
// (the Sun's, its shadows there thrown by what hangs in the room); the M's stars pale where the light
// falls on them, their own green glow in the dark.
void quietRoomFar(Ctx x, inout Cell c) {
  vec3 P = mobileP;
  vec3 n = mobileN;
  float cw = mobileCw;
  vec3 albedo = mobileSurface == 1 ? mobileFloor(P, cw) : mobileSurface == 2 ? (mobileDay() ? vec3(0.8) : vec3(0.45)) : mobileWall(P);
  vec3 light = mobileAmbient() + mobileFill() * max(dot(n, MOBILE_WINDOW), 0.0) + localLight(P + n * 0.002, n);
  c.col = albedo * light;
  if (mobileSurface == 0 && K_mark > 0.0 && mobileStars(P, cw) > 0.5) c.col = vec3(0.92, 0.94, 0.8) * light + vec3(0.45, 1.0, 0.4) * 0.3 * K_mark;
}

// At night the room falls away into the dark toward the edges of the picture, the mobile with it.
void quietRoomFrontVeil(Ctx x, inout Cell c) {
  if (!mobileDay()) c.col *= 1.0 - 0.3 * smoothstep(0.45, 1.3, length(x.q * vec2(0.75, 1.0)));
}
`;

/** The solar system: the Sun and its light, the mobile and its shadows, the planets, the rings. */
export const solarMobileGlsl = `
${planetGlsl}
${mobileGlsl("solarMobileField0", MOBILE_TEX_ORIGIN)}
${solarGlsl(MOBILE_SUN_CENTRE)}
${looks}
const vec3 MOBILE_SATURN_AXIS = ${glslVec3(SATURN_AXIS)};
// Saturn's rings: the C ring dim, the B ring bright, the Cassini division, the A ring (Saturn radii).
const PlanetRingBands MOBILE_RINGS = PlanetRingBands(${glslFloat(SOLAR_RINGS.inner)}, ${glslFloat(SOLAR_RINGS.outer)}, 3.0, 0.12, 1.0, 0.0, 0.0);
// How the Sun's light falls off (m²).
const float MOBILE_FALLOFF = 0.5;
// The most of the Sun's light a shadow on the room takes.
const float MOBILE_SHADE = 0.5;

// The Sun's centre: the loop it is threaded on, as the mobile swings and the passage poses it.
vec3 mobileSunCentre() {
  return mobileAt(mobileSunArm(), 2);
}

// How lit the Sun is: 1 at rest. Coming in it glows like an ember and warms as it is lowered, fastest
// at first, lighting up fully as it comes to rest; going out it cools back to an ember as it is
// hoisted away, ever faster.
float mobileSunWarm() {
  float pin = passageIn();
  float pout = passageOut();
  if (pin >= 1.0 && pout <= 0.0) return 1.0;
  float coming = 1.0 - min(pin / 0.85, 1.0);
  return mix(0.3, 1.0, (1.0 - coming * coming * coming) * (1.0 - pout * pout * pout));
}

// The Sun's light (colour times strength at 1 m): an ember's red while it warms, then gold-white.
vec3 mobileSunLight(float warm) {
  vec3 tint = mix(vec3(1.0, 0.3, 0.05), vec3(1.0, 0.84, 0.62), warm);
  return tint * warm * warm * mix(0.8, 4.0, K_sun) * (mobileDay() ? 0.5 : 1.0);
}

// The radius of the light inside the Sun (m): a bulb's to the whole globe's.
float mobileLightRadius() {
  return mix(0.008, MOBILE_SUN_RADIUS, K_softness * K_softness);
}

// Saturn, if it hangs: its centre and radius, and its frame (x, its axis, z).
struct MobileSaturn {
  bool on;
  vec3 c;
  float r;
  mat3 frame;
};

// A body's frame: its axis, and x and z kept still in the room, so a planet's markings stay put as it
// moves round (it hangs on a swivel).
mat3 mobileFrame(vec3 axis) {
  vec3 z = normalize(vec3(0.0, 0.0, 1.0) - axis * axis.z);
  return mat3(cross(axis, z), axis, z);
}

vec3 mobileAxis(int look) {
  if (look == MOBILE_SATURN) return MOBILE_SATURN_AXIS;
  if (look == MOBILE_EARTH) return normalize(vec3(-0.3, 0.9, 0.3));
  if (look == MOBILE_MARS) return normalize(vec3(0.3, 0.9, 0.3));
  if (look == MOBILE_URANUS) return normalize(vec3(0.85, 0.12, 0.5));
  if (look == MOBILE_NEPTUNE) return normalize(vec3(-0.3, 0.92, 0.25));
  return vec3(0.0, 1.0, 0.0);
}

MobileSaturn mobileSaturn() {
  MobileSaturn s = MobileSaturn(false, vec3(0.0), 1.0, mat3(1.0));
  int k = mobileSaturnArm();
  if (k < 0) return s;
  vec4 ball;
  int look;
  s.on = mobileBall(k, 0, mobileAt(k, 0), mobileAt(k, 1), ball, look);
  s.c = ball.xyz;
  s.r = max(ball.w, 1.0e-3);
  s.frame = mobileFrame(MOBILE_SATURN_AXIS);
  return s;
}

// The rings' cover at a point of their plane (Saturn radii from its centre), the C ring thin enough
// to see through: which band in band.
float mobileRingCover(MobileSaturn s, vec3 x, float foot, out float band) {
  float cover = planetRingBands(vec2(dot(x, s.frame[0]), dot(x, s.frame[2])), MOBILE_RINGS, 0.0, foot, band);
  return cover * (band < 0.5 ? 0.35 : band < 1.5 ? 1.0 : 0.8);
}

// Saturn's rings along the ray: their t, or -1 where this cell misses them; tone their brightness.
float mobileRingRay(MobileSaturn s, vec3 ro, vec3 rd, float cellW, float maxT, out float tone) {
  tone = 0.0;
  vec3 axis = s.frame[1];
  float dn = dot(rd, axis);
  if (abs(dn) < 1.0e-4) return -1.0;
  float t = dot(s.c - ro, axis) / dn;
  if (t <= 0.0 || t >= maxT) return -1.0;
  float band;
  float cover = mobileRingCover(s, (ro + rd * t - s.c) / s.r, cellW * t / (s.r * max(abs(dn), 0.05)), band);
  if (hardEdge(min(cover * 2.5, 1.0)) < 0.5) return -1.0;
  tone = (band < 0.5 ? 0.45 : band < 1.5 ? 1.0 : 0.78) * (0.85 + 0.15 * cover);
  return t;
}

// How much of the light the rings hide from P: where the line to the light (centre L, radius lr)
// crosses their plane, their cover there, blurred by the light's size.
float mobileRingShade(MobileSaturn s, vec3 P, vec3 L, float lr) {
  vec3 axis = s.frame[1];
  vec3 pl = L - P;
  float dn = dot(pl, axis);
  if (abs(dn) < 1.0e-6) return 0.0;
  float u = dot(s.c - P, axis) / dn;
  if (u <= 1.0e-4 || u >= 1.0) return 0.0;
  float band;
  return min(mobileRingCover(s, (P + pl * u - s.c) / s.r, (lr * u + 1.0e-3) / s.r, band) * 2.5, 1.0);
}

// The mobile's state for this cell: how lit the Sun is, its centre, Saturn.
float mobileWarm;
vec3 mobileSun;
MobileSaturn mobileSat;

void solarMobileBegin(Ctx x) {
  mobileWarm = mobileSunWarm();
  mobileSat = mobileSaturn();
  mobileSun = mobileSunCentre();
}

// How square the Sun's light falls on P facing n: the light has a size, so past the terminator it
// wraps by its angular radius. d2: P's squared distance from the Sun's centre.
float mobileFacing(vec3 P, vec3 n, out float d2) {
  vec3 toS = mobileSun - P;
  d2 = dot(toS, toS);
  float wrap = mobileLightRadius() * inversesqrt(d2);
  float facing = dot(n, toS) * inversesqrt(d2);
  return facing >= wrap ? facing : facing > -wrap ? (facing + wrap) * (facing + wrap) / (4.0 * wrap) : 0.0;
}

// How much of a round light (centre L, radius r) the mobile and Saturn's rings hide from P.
// skipArm/skipEnd: the ball P lies on (-1 for none).
float mobileHidden(vec3 P, vec3 L, float r, int skipArm, int skipEnd) {
  float hidden = mobileShadow(P, L, r, skipArm, skipEnd);
  if (mobileSat.on) hidden = 1.0 - (1.0 - hidden) * (1.0 - mobileRingShade(mobileSat, P, L, r));
  return hidden;
}

// The solar system's rayCaster, which the room's surfaces ask through roomRayCaster.
float solarMobileCaster(vec3 P, vec3 L, float r) {
  return mobileHidden(P, L, r, -1, -1);
}

// The Sun's light on the room's own surfaces (its declared light, which the room takes through
// localLight): the shadows there stay secondary, thrown from the whole glowing globe at least, so
// they blur and shrink with distance, and take at most MOBILE_SHADE of its light.
vec3 solarMobileSun(vec3 P, vec3 n) {
  float d2;
  float sun = mobileFacing(P, n, d2);
  if (sun <= 0.0) return vec3(0.0);
  float hidden = roomRayCaster(P, mobileSun, max(mobileLightRadius(), MOBILE_SUN_RADIUS));
  return mobileSunLight(mobileWarm) * sun / (MOBILE_FALLOFF + d2) * (1.0 - MOBILE_SHADE * hardEdge(hidden));
}

// Light reaching a planet, a weight or a ring at P (normal n): the Sun, hidden as far as the mobile
// and Saturn's rings hide it, cut per cell; the window; the room's ambient. skipArm/skipEnd: the ball
// P lies on.
vec3 mobileLight(vec3 P, vec3 n, int skipArm, int skipEnd) {
  vec3 light = mobileAmbient() + mobileFill() * max(dot(n, MOBILE_WINDOW), 0.0);
  float d2;
  float sun = mobileFacing(P, n, d2);
  if (sun <= 0.0) return light;
  float hidden = mobileHidden(P, mobileSun, mobileLightRadius(), skipArm, skipEnd);
  return light + mobileSunLight(mobileWarm) * sun / (MOBILE_FALLOFF + d2) * (1.0 - hardEdge(hidden));
}

// A planet's paint at its normal nb in its own frame (y its axis, z toward the room's front), foot a
// cell in its radii, tm the motion clock.
vec3 mobileBodyPaint(int look, vec3 nb, float foot, float tm) {
  float lon = planetLongitude(nb, 0.0, 0.0);
  if (look == MOBILE_MERCURY) {
    return vec3(0.52, 0.48, 0.44) * (0.8 + 0.4 * planetFbm(vec2(lon * 1.5, nb.y * 2.4) + 4.0, foot * 2.4));
  }
  if (look == MOBILE_VENUS) {
    return mix(vec3(0.95, 0.86, 0.62), vec3(0.85, 0.7, 0.42), 0.6 * smoothstep(0.35, 0.7, planetBelts(nb, lon * 0.4, foot)));
  }
  if (look == MOBILE_EARTH) {
    float land = planetFbm(vec2(lon * 1.4, nb.y * 2.4) + vec2(3.1, 7.7), foot * 2.4);
    vec3 ground = mix(vec3(0.2, 0.42, 0.14), vec3(0.62, 0.5, 0.3), smoothstep(0.58, 0.72, land));
    vec3 c = mix(vec3(0.06, 0.2, 0.55), ground, hardEdge(smoothstep(0.51, 0.55, land)));
    c = mix(c, vec3(0.94), hardEdge(smoothstep(0.84, 0.9, abs(nb.y))));
    return mix(c, vec3(0.96), 0.85 * planetClouds(nb, lon, tm, foot));
  }
  if (look == MOBILE_MOON) {
    float maria = planetFbm(nb.xy * 1.6 + 2.0, foot * 1.6);
    return mix(vec3(0.66, 0.65, 0.62), vec3(0.36, 0.36, 0.36), smoothstep(0.52, 0.66, maria));
  }
  if (look == MOBILE_MARS) {
    float dark = planetFbm(vec2(lon * 1.4, nb.y * 2.2) + 9.0, foot * 2.2);
    vec3 c = mix(vec3(0.74, 0.32, 0.14), vec3(0.42, 0.18, 0.09), smoothstep(0.5, 0.68, dark));
    return mix(c, vec3(0.95, 0.93, 0.9), hardEdge(smoothstep(0.86, 0.92, nb.y)));
  }
  if (look == MOBILE_CERES) {
    return vec3(0.42, 0.4, 0.38) * (0.85 + 0.3 * planetFbm(nb.xy * 1.6, foot * 1.6));
  }
  if (look == MOBILE_JUPITER) {
    // Belts and zones across the latitudes, a little wavy, drifting slowly, and the Great Red Spot
    // south of the equator.
    float wave = vnoise(vec2(lon * 2.5 + tm * 0.01, nb.y * 7.0));
    float band = 0.5 + 0.5 * sin(nb.y * 10.5 + 1.1 + wave * 0.9);
    float spot = hardEdge(smoothfall(1.0, 0.65, length(vec2(lon + 0.45, nb.y + 0.36) * vec2(2.6, 6.0))));
    vec3 c = planetBandColor(vec2(band, 0.0), vec3(0.5, 0.3, 0.17), vec3(0.82, 0.64, 0.44), vec3(0.97, 0.92, 0.8), vec3(0.0));
    return mix(c, vec3(0.78, 0.3, 0.14), 0.85 * spot);
  }
  if (look == MOBILE_SATURN) {
    float band = 0.5 + 0.5 * sin(nb.y * 9.0 + 0.4 + 0.6 * vnoise(vec2(lon * 2.0, nb.y * 6.0)));
    return planetBandColor(vec2(band, 0.0), vec3(0.72, 0.56, 0.32), vec3(0.88, 0.76, 0.5), vec3(0.98, 0.92, 0.72), vec3(0.0));
  }
  if (look == MOBILE_URANUS) {
    return vec3(0.6, 0.86, 0.88) * (0.9 + 0.1 * smoothstep(0.2, 0.9, nb.y));
  }
  if (look == MOBILE_NEPTUNE) {
    vec3 c = mix(vec3(0.16, 0.3, 0.8), vec3(0.3, 0.48, 0.92), 0.5 * smoothstep(0.35, 0.7, planetBelts(nb, lon, foot)));
    return mix(c, vec3(0.08, 0.14, 0.42), hardEdge(0.8 * bell(length((nb.xy - vec2(0.32, -0.22)) * vec2(1.0, 1.6)) / 0.2)));
  }
  if (look == MOBILE_PLUTO) {
    return mix(vec3(0.7, 0.56, 0.42), vec3(0.95, 0.9, 0.82), smoothstep(0.4, 0.7, bell(length(nb.xy - vec2(0.15, -0.1)) / 0.45)));
  }
  return vec3(0.5);
}

// The Sun's face: hot gold at the middle, deep orange toward the limb, a faint static mottle; an
// ember's dull red while it is cold.
vec3 mobileSunFace(vec3 n, vec3 rd, float warm) {
  float mu = max(dot(n, -rd), 0.0);
  float mottle = 0.92 + 0.08 * vnoise(n.xy * 9.0 + n.z * 3.0);
  vec3 face = mix(vec3(1.0, 0.5, 0.1), vec3(1.0, 0.93, 0.7), pow(mu, 0.7)) * mottle * mix(0.75, 1.5, K_sun);
  return mix(vec3(0.22, 0.05, 0.02) * (0.6 + 0.4 * mu), face, warm);
}

// The mobile in front of the room: the rose in the ceiling, the Sun's cord, the arms and the planets,
// Saturn's rings, the Sun and its glow; the Sun's face the accent.
void solarMobileMiddle(Ctx x, inout Cell c) {
  vec3 ro = mobileRo;
  vec3 rd = mobileRd;
  float cellW = mobileCellW;
  float tm = x.tm;
  float warm = mobileWarm;
  MobileSaturn sat = mobileSat;
  vec3 S = mobileSun;
  vec3 col = c.col;
  // The rose in the ceiling the Sun's cord hangs from.
  if (mobileSurface == 2) col *= 1.0 - 0.6 * hardFill((length(mobileP.xz - S.xz) - 0.06) / mobileCw, 0.7);
  float tHit = mobileTSurf;
  float accent = 0.0;

  // The Sun's cord, up to the ceiling.
  float rt;
  float along;
  float d = mobileRaySeg(ro, rd, mobileAt(0, 3), vec3(S.x, MOBILE_CEILING, S.z), rt, along);
  if (rt > 0.0 && rt < tHit && hardFill((d - max(0.004, 0.45 * cellW * rt)) / (cellW * rt), 0.6) > 0.5) {
    tHit = rt;
    col = vec3(0.02) + 0.05 * mobileAmbient();
  }

  // The mobile, in front of the room: its wires and links at least about 1.2 and 1 cells wide where
  // it hangs (some 3.7 m off), so a turning arm's wire stays one unbroken line.
  MobileHit hit = mobileTrace(ro, rd, cellW, tHit, max(0.0013, 0.6 * 3.7 * cellW), max(0.0008, 0.5 * 3.7 * cellW));
  if (hit.kind == MOBILE_BALL) {
    vec3 Q = ro + rd * hit.t;
    vec4 ball;
    int look;
    mobileBall(hit.arm, hit.end, mobileAt(hit.arm, 0), mobileAt(hit.arm, 1), ball, look);
    vec3 light = mobileLight(Q + hit.n * 0.002, hit.n, hit.arm, hit.end);
    if (look == MOBILE_WEIGHT) {
      // Brass, catching the Sun.
      float glint = pow(max(dot(reflect(rd, hit.n), normalize(S - Q)), 0.0), 30.0);
      col = vec3(0.62, 0.44, 0.18) * light + 0.8 * glint * mobileSunLight(warm) / (MOBILE_FALLOFF + dot(S - Q, S - Q));
    } else {
      mat3 frame = mobileFrame(mobileAxis(look));
      col = mobileBodyPaint(look, hit.n * frame, cellW * hit.t / ball.w, tm) * light;
    }
    tHit = hit.t;
  } else if (hit.kind != MOBILE_NONE) {
    vec3 Q = ro + rd * hit.t;
    float glint = pow(max(dot(reflect(rd, hit.n), normalize(S - Q)), 0.0), 24.0);
    col = vec3(0.03, 0.03, 0.035) * (1.0 + 4.0 * mobileAmbient()) + 0.5 * glint * mobileSunLight(warm) / (MOBILE_FALLOFF + dot(S - Q, S - Q));
    tHit = hit.t;
  }

  // Saturn's rings, over whatever lies behind them.
  if (sat.on) {
    float tone;
    float tr = mobileRingRay(sat, ro, rd, cellW, tHit, tone);
    if (tr > 0.0) {
      vec3 Q = ro + rd * tr;
      vec3 rn = dot(rd, sat.frame[1]) < 0.0 ? sat.frame[1] : -sat.frame[1];
      col = vec3(0.86, 0.76, 0.58) * tone * mobileLight(Q + rn * 0.002, rn, -1, -1);
      tHit = tr;
    }
  }

  // The Sun: the globe itself, and its glow in the room's air in front of whatever lies behind it.
  vec3 oc = S - ro;
  float tc = dot(oc, rd);
  float ds = length(rd * tc - oc);
  if (tc > 0.0 && tc < tHit + MOBILE_SUN_RADIUS) {
    float cover = hardFill((ds - MOBILE_SUN_RADIUS) / (cellW * tc), 0.7);
    float ts = tc - sqrt(max(MOBILE_SUN_RADIUS * MOBILE_SUN_RADIUS - ds * ds, 0.0));
    if (cover > 0.5 && ts < tHit) {
      col = mobileSunFace(normalize(rd * ts - oc), rd, warm);
      accent = 1.0;
    } else if (tc < tHit) {
      float above = max(ds - MOBILE_SUN_RADIUS, 0.0);
      col += mobileSunLight(warm) * (0.22 * exp(-above / 0.07) + 0.07 * exp(-above / 0.4));
    }
  }

  c.col = col;
  if (accent > 0.0) c.accent = accent;
}
`;
