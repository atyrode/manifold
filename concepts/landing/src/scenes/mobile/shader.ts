// A solar system hanging in a quiet room under a glowing Sun, the room's lamp. The mobile itself is
// the shared part (sims/mobile.ts): its balls, wires and links traced along each view ray
// (mobileTrace) and the share of a round light it hides from any point (mobileShadow). The planets'
// looks lean on the shared giant planet (shaders/lib/planet.ts): Jupiter's and Saturn's belts and
// zones in its band colours (planetBandColor), Venus's and Neptune's turbulent belts (planetBelts),
// the Earth's cloud deck (planetClouds), the noise of the rocky ones (planetFbm), Saturn's banded
// rings (planetRingBands). Each planet's markings are fixed to its own axis, kept still in the room
// (it hangs on a swivel). This file is the room, the Sun and the paint.
//
// Light: the Sun (K_sun) lights everything from where it hangs, so each planet shows a day side
// toward it and a night side away from it as its arm turns; its light (K_softness: how big the bulb
// inside the globe is) throws the mobile's shadows, Saturn's ring's included, onto the wall, the
// ceiling and the other planets, each cut per cell against its own threshold. A dim window on the
// right (K_fill) and the room's own ambient keep the room and the night sides readable. K_room picks
// a dark room or a white one in daylight.
//
// Passage: the Sun lights up from an ember as the mobile comes to rest, and cools as it leaves
// (mobileSunWarm, 1 at rest); the mobile's lowering and hoisting are the sim's pose.
//
// Knobs read here: K_planets (which arm Saturn is on), K_room, K_sun, K_softness, K_fill, K_mark (the
// others drive the simulation). Textures: uSim0, the MobileTexture.
import { MARK_VERTICES } from "../../mark.ts";
import { glslFloat, glslVec3 } from "../../shaders/glsl.ts";
import { planetGlsl } from "../../shaders/lib/planet.ts";
import { mobileGlsl } from "../../sims/mobile.ts";
import { MOBILE_SUN_CENTRE, MOBILE_TEX_ORIGIN, mobileLayoutGlsl } from "./layout.ts";
import { SOLAR_LOOKS, SOLAR_RINGS, solarGlsl } from "./solar.ts";

/** The Sun's gold: the accent. */
export const MOBILE_SUN = "#f2a52c";

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

export const mobileSceneGlsl = `
${planetGlsl}
${mobileGlsl("uSim0", MOBILE_TEX_ORIGIN)}
${mobileLayoutGlsl}
${solarGlsl(MOBILE_SUN_CENTRE)}
${looks}
const vec3 MOBILE_SATURN_AXIS = ${glslVec3(SATURN_AXIS)};
// Saturn's rings: the C ring dim, the B ring bright, the Cassini division, the A ring (Saturn radii).
const PlanetRingBands MOBILE_RINGS = PlanetRingBands(${glslFloat(SOLAR_RINGS.inner)}, ${glslFloat(SOLAR_RINGS.outer)}, 3.0, 0.12, 1.0, 0.0, 0.0);
// The window on the right the fill comes through, and how the Sun's light falls off (m²).
const vec3 MOBILE_WINDOW = vec3(0.62, 0.42, 0.66);
const float MOBILE_FALLOFF = 0.5;
// The most of the Sun's light a shadow on the room takes.
const float MOBILE_SHADE = 0.5;
// The M of stars on the wall: its middle (x, y) and height (m).
const vec3 MOBILE_STARS = vec3(1.55, 2.3, 0.42);
const vec2 MOBILE_STAR[${MARK_STARS.length}] = vec2[${MARK_STARS.length}](${MARK_STARS.map(([x, y]) => `vec2(${glslFloat(x ?? 0)}, ${glslFloat(y ?? 0)})`).join(", ")});

bool mobileDay() {
  return K_room > 0.5;
}

// The Sun's centre: the loop it is threaded on, as the mobile swings and the passage poses it.
vec3 mobileSunCentre() {
  return mobileAt(mobileSunArm(), 2);
}

// How lit the Sun is: 1 at rest. Coming in it glows like an ember as it is lowered and lights up as
// it comes to rest; going out it cools back to an ember as it is hoisted away.
float mobileSunWarm() {
  if (passageIn() >= 1.0 && passageOut() <= 0.0) return 1.0;
  return mix(0.3, 1.0, smoothstep(0.45, 0.85, passageIn()) * smoothfall(0.8, 0.0, passageOut()));
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

vec3 mobileAmbient() {
  return mobileDay() ? vec3(0.36, 0.37, 0.39) : vec3(0.012, 0.013, 0.02);
}

vec3 mobileFill() {
  return (mobileDay() ? vec3(1.0, 0.88, 0.7) * 0.7 : vec3(0.42, 0.52, 0.9) * 0.7) * K_fill;
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

// Light reaching P (normal n): the Sun, hidden as far as the mobile and Saturn's rings hide it, cut
// per cell; the window; the room's ambient. skipArm/skipEnd: the ball P lies on. On the room's own
// surfaces (room 1) the shadows stay secondary: thrown from the whole glowing globe at least, so
// they blur and shrink with distance, and taking at most MOBILE_SHADE of the Sun's light.
vec3 mobileLight(vec3 P, vec3 n, MobileSaturn sat, float warm, int skipArm, int skipEnd, float room) {
  vec3 light = mobileAmbient() + mobileFill() * max(dot(n, MOBILE_WINDOW), 0.0);
  if (warm <= 0.0) return light;
  vec3 S = mobileSunCentre();
  vec3 toS = S - P;
  float d2 = dot(toS, toS);
  float lr = mobileLightRadius();
  // The light has a size: past the terminator it wraps by its angular radius.
  float wrap = lr * inversesqrt(d2);
  float facing = dot(n, toS) * inversesqrt(d2);
  float sun = facing >= wrap ? facing : facing > -wrap ? (facing + wrap) * (facing + wrap) / (4.0 * wrap) : 0.0;
  if (sun <= 0.0) return light;
  float spread = mix(lr, max(lr, MOBILE_SUN_RADIUS), room);
  float hidden = mobileShadow(P, S, spread, skipArm, skipEnd);
  if (sat.on) hidden = 1.0 - (1.0 - hidden) * (1.0 - mobileRingShade(sat, P, S, spread));
  return light + mobileSunLight(warm) * sun / (MOBILE_FALLOFF + d2) * (1.0 - mix(1.0, MOBILE_SHADE, room) * hardEdge(hidden));
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

// The Sun's face: hot gold at the middle, deep orange toward the limb, a faint static mottle; an
// ember's dull red while it is cold.
vec3 mobileSunFace(vec3 n, vec3 rd, float warm) {
  float mu = max(dot(n, -rd), 0.0);
  float mottle = 0.92 + 0.08 * vnoise(n.xy * 9.0 + n.z * 3.0);
  vec3 face = mix(vec3(1.0, 0.5, 0.1), vec3(1.0, 0.93, 0.7), pow(mu, 0.7)) * mottle * mix(0.75, 1.5, K_sun);
  return mix(vec3(0.22, 0.05, 0.02) * (0.6 + 0.4 * mu), face, warm);
}

Shade sceneMobile(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec3 ro = MOBILE_EYE + vec3(MOBILE_SWAY * uPointer, 0.0);
  vec3 fwd = normalize(MOBILE_AIM - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  float focal = mobileFocal(aspect);
  vec3 rd = normalize(fwd * focal + right * p.x + up * p.y);
  float cellW = dot(fwd, rd) / (focal * uRes.y);
  float tm = uMotionTime;
  float warm = mobileSunWarm();
  MobileSaturn sat = mobileSaturn();
  vec3 S = mobileSunCentre();

  // The room: the wall, or the floor or ceiling where the ray meets them first.
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
  vec3 P = ro + rd * tSurf;
  float cw = tSurf * cellW;
  vec3 albedo = surface == 1 ? mobileFloor(P, cw) : surface == 2 ? (mobileDay() ? vec3(0.8) : vec3(0.45)) : mobileWall(P);
  // The rose in the ceiling the Sun's cord hangs from.
  if (surface == 2) albedo *= 1.0 - 0.6 * hardFill((length(P.xz - S.xz) - 0.06) / cw, 0.7);
  vec3 roomLight = mobileLight(P + n * 0.002, n, sat, warm, -1, -1, 1.0);
  vec3 col = albedo * roomLight;
  // Glow-in-the-dark stars: pale where the light falls on them, their own green glow in the dark.
  if (surface == 0 && K_mark > 0.0 && mobileStars(P, cw) > 0.5) col = vec3(0.92, 0.94, 0.8) * roomLight + vec3(0.45, 1.0, 0.4) * 0.3 * K_mark;
  float tHit = tSurf;
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
    vec3 light = mobileLight(Q + hit.n * 0.002, hit.n, sat, warm, hit.arm, hit.end, 0.0);
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
      col = vec3(0.86, 0.76, 0.58) * tone * mobileLight(Q + rn * 0.002, rn, sat, warm, -1, -1, 0.0);
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

  // At night the room falls away into the dark toward the edges of the picture.
  if (!mobileDay()) col *= 1.0 - 0.3 * smoothstep(0.45, 1.3, length(p * vec2(0.75, 1.0)));
  return shadeOf(col, inkOf(col, 1.4, 0.8), accent);
}
`;
