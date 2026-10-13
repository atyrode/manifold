// The ripple tank's picture: a lamp above the tank throws the water's light and shadow on a white
// screen below it (the classic projection: crests gather the light into bright bands, troughs
// spread it thin), or, as a surface, the dark water itself with the room and the lamp mirrored in
// it. The fixtures show as the lamp throws them: dippers, barriers and the bar as solid shadows
// rimmed by the bright line of their meniscus, things over the water (the dippers' beam and stems,
// the barriers' tops) as soft shadows cast away from the lamp, the lens plate as a fine outline.
//   uSim0  the shown tank's view (sim.ts): x height, y the Jacobian of the light's path to the
//          screen, zw the slope (1 at a unit wave's steepest)
//   uSim1  the tank fading in, while it does
//   uSim2  the layout, 16×2 rgba32f: row 0 shown, row 1 fading in (RIPPLE_TEXELS)
// Without the sim (no float render targets) the screen shows two dippers' interference worked out
// here.
//
// Colour. The screen's brightness is dithered through a short ramp of the lamp's colours, each a
// colour the palette can show exactly: a cell takes the step below or above against its own
// threshold, so as a band of light passes, each cell changes once per step and all its channels
// together, never through stray hues. The M, a strip of coloured acrylic, throws accent light.
// Knobs read here: K_render, K_light, K_focus, K_speed, K_frequency.
import { RIPPLE_BAR, RIPPLE_BEAM_HEIGHT, RIPPLE_DIPPER, RIPPLE_FREQUENCY, RIPPLE_LAMP, RIPPLE_LAMP_HEIGHT, RIPPLE_MARK_HALF, RIPPLE_SPEED } from "./layout.ts";
import { RIPPLE_FOCUS, RIPPLE_LENS_GLSL, RIPPLE_TEXELS } from "./sim.ts";

const glsl = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/**
 * The lamps: six (brightness, colour) stops each, colours in thirds of full (the 4-level palette's
 * own steps; other levels snap them). Sea-green water, a tungsten lamp, a darkroom safelight,
 * moonlight.
 */
const LIGHTS: readonly (readonly (readonly [number, readonly [number, number, number]])[])[] = [
  [[0, [0, 0, 0]], [0.4, [0, 1, 1]], [0.6, [1, 2, 2]], [0.8, [3, 3, 2]], [1, [3, 3, 3]], [1, [3, 3, 3]]],
  [[0, [0, 0, 0]], [0.38, [0, 0, 1]], [0.55, [1, 1, 1]], [0.7, [2, 2, 1]], [0.85, [3, 3, 2]], [1, [3, 3, 3]]],
  [[0, [0, 0, 0]], [0.4, [1, 0, 0]], [0.58, [2, 1, 0]], [0.75, [3, 2, 1]], [0.9, [3, 3, 2]], [1, [3, 3, 3]]],
  [[0, [0, 0, 0]], [0.4, [0, 0, 1]], [0.6, [1, 1, 2]], [0.8, [2, 2, 3]], [1, [3, 3, 3]], [1, [3, 3, 3]]],
];
export const rippleLights = ["sea", "lamp", "safelight", "moon"] as const;

const STOPS = LIGHTS.flat();
const STOP_AT = `const float RIPPLE_AT[${STOPS.length}] = float[${STOPS.length}](${STOPS.map(([at]) => glsl(at)).join(", ")});`;
const STOP_RGB = `const vec3 RIPPLE_RGB[${STOPS.length}] = vec3[${STOPS.length}](${STOPS.map(([, [r, g, b]]) => `vec3(${glsl(r)}, ${glsl(g)}, ${glsl(b)}) / 3.0`).join(", ")});`;

export const rippleGlsl = `
const float RIPPLE_DIPPER_R = ${glsl(RIPPLE_DIPPER)};
const float RIPPLE_BAR_HALF = ${glsl(RIPPLE_BAR)};
const float RIPPLE_MARK_W = ${glsl(RIPPLE_MARK_HALF)};
const float RIPPLE_LAMP_H = ${glsl(RIPPLE_LAMP_HEIGHT)};
const float RIPPLE_BEAM_Z = ${glsl(RIPPLE_BEAM_HEIGHT)};
const vec2 RIPPLE_LAMP_AT = vec2(${glsl(RIPPLE_LAMP.along)}, ${glsl(RIPPLE_LAMP.across)});
const vec2 RIPPLE_FOCUS = vec2(${glsl(RIPPLE_FOCUS[0])}, ${glsl(RIPPLE_FOCUS[1])});
const float RIPPLE_C = ${glsl(RIPPLE_SPEED)};
const float RIPPLE_F = ${glsl(RIPPLE_FREQUENCY)};
const float RIPPLE_TONE = 0.42;     // screen brightness = 1 - exp(-tone x light), light 1 under still water
const float RIPPLE_WALL_Z = 0.07;   // the barriers stand this high above the water (short sides)
const float RIPPLE_STEM = 0.003;    // half-width of a dipper's stem
const float RIPPLE_BEAM_HALF = 0.007;
const float RIPPLE_RIM = 0.32;      // the meniscus's bright line, × the lamp's light there
const vec2 RIPPLE_TOWARD = vec2(-0.6, 0.8); // where the room's light comes from, seen in the surface
${STOP_AT}
${STOP_RGB}
${RIPPLE_LENS_GLSL}
float rippleTh = 0.5;
float ripplePx = 0.002;

struct RippleLook {
  float b;    // brightness 0..1
  float m;    // coverage of the M's acrylic strip (soft)
  float lit;  // the light falling on the M
};

struct RippleFix {
  float wall;   // barriers (soft coverage; cut per cell when drawn)
  float bar;    // the plane-wave bar
  float ball;   // dipper balls
  float mark;   // the M strip
  float rim;    // the meniscus round anything in the water
  float shade;  // shadows of what stands over the water, 0..1
  float lens;   // over the lens plate
  float edge;   // the plate's rim
  float glint;  // a ball's highlight (surface view)
};

// A cell flips once as a soft edge passes: coverage cut against its own threshold.
float rippleHard(float cover) {
  return cover > rippleTh ? 1.0 : 0.0;
}

// The palette's own colour nearest c, nudged so the dither never rounds it down a level.
vec3 rippleSnap(vec3 c) {
  float n = max(uLevels - 1.0, 1.0);
  return (floor(clamp(c, 0.0, 1.0) * n + 0.5) + 0.004) / n;
}

// The lamp's colour ramp at brightness b: the stop below or above, against the cell's threshold.
// smoothCol: the undithered colour, for the source view.
vec3 rippleRamp(float b, int light, out vec3 smoothCol) {
  b = clamp(b, 0.0, 1.0);
  int base = light * 6;
  int i = 1;
  for (; i < 5; i++) {
    if (b <= RIPPLE_AT[base + i]) break;
  }
  float a0 = RIPPLE_AT[base + i - 1];
  float a1 = RIPPLE_AT[base + i];
  vec3 lo = RIPPLE_RGB[base + i - 1];
  vec3 hi = RIPPLE_RGB[base + i];
  float t = a1 > a0 ? clamp((b - a0) / (a1 - a0), 0.0, 1.0) : 1.0;
  smoothCol = mix(lo, hi, t);
  return rippleSnap(t > rippleTh ? hi : lo);
}

vec2 ripplePlace(float a, float b, bool portrait) {
  return portrait ? vec2(b, a) : vec2(a, b);
}

vec4 rippleView(int row, vec2 uv) {
  return row == 0 ? textureLod(uSim0, uv, 0.0) : textureLod(uSim1, uv, 0.0);
}

vec4 rippleAt(int row, int texel) {
  return texelFetch(uSim2, ivec2(texel, row), 0);
}

// Where a point at height z over the screen throws its shadow: out along the line from the lamp.
vec2 rippleCast(vec2 q, vec2 lamp, float z) {
  return lamp + (q - lamp) * (RIPPLE_LAMP_H / (RIPPLE_LAMP_H - z));
}

// The meniscus: a bright line a cell or so out from an edge at signed distance d (outside > 0).
float rippleMeniscus(float d) {
  float x = (d - 1.5 * ripplePx) / (1.2 * ripplePx);
  return step(0.0, d) * exp(-x * x);
}

// A soft shadow of a bar over the water at height z, from a to b, half-width w.
float rippleHigh(vec2 p, vec2 a, vec2 b, float w, float z, vec2 lamp) {
  float mag = RIPPLE_LAMP_H / (RIPPLE_LAMP_H - z);
  float d = segmentDistance(p, rippleCast(a, lamp, z), rippleCast(b, lamp, z)) - w * mag;
  float blur = max(0.04 * z, ripplePx);
  return 1.0 - smoothstep(-blur, blur, d);
}

// Everything in and over the water of a layout row, at p.
RippleFix rippleFixtures(int row, vec2 p, vec2 lamp) {
  RippleFix f = RippleFix(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  float px = ripplePx;
  vec4 halves = rippleAt(row, ${RIPPLE_TEXELS.halves});
  for (int i = 0; i < 4; i++) {
    float h = halves[i];
    if (h <= 0.0) continue;
    vec4 s = rippleAt(row, ${RIPPLE_TEXELS.walls} + i);
    float d = segmentDistance(p, s.xy, s.zw) - h;
    f.wall = max(f.wall, 1.0 - smoothstep(-px, px, d));
    f.rim = max(f.rim, rippleMeniscus(d));
    f.shade = max(f.shade, 0.35 * rippleHigh(p, s.xy, s.zw, h, RIPPLE_WALL_Z, lamp));
  }
  vec4 flags = rippleAt(row, ${RIPPLE_TEXELS.flags});
  if (flags.y > 0.5) {
    vec4 s = rippleAt(row, ${RIPPLE_TEXELS.bar});
    float d = segmentDistance(p, s.xy, s.zw) - RIPPLE_BAR_HALF;
    f.bar = 1.0 - smoothstep(-px, px, d);
    f.rim = max(f.rim, rippleMeniscus(d));
  }
  if (flags.x > 0.5) {
    vec4 s = rippleAt(row, ${RIPPLE_TEXELS.beam});
    f.shade = max(f.shade, 0.4 * rippleHigh(p, s.xy, s.zw, RIPPLE_BEAM_HALF, RIPPLE_BEAM_Z, lamp));
  }
  for (int i = 0; i < 4; i++) {
    vec4 s = rippleAt(row, ${RIPPLE_TEXELS.dippers} + i);
    if (s.w <= 0.0) continue;
    vec2 q = p - s.xy;
    float d = length(q) - s.z;
    if (d > 0.6) continue;
    f.ball = max(f.ball, 1.0 - smoothstep(-px, px, d));
    f.rim = max(f.rim, rippleMeniscus(d));
    // Its stem rises to the beam; the lamp throws its shadow outward from the ball.
    float stem = segmentDistance(p, s.xy, rippleCast(s.xy, lamp, RIPPLE_BEAM_Z)) - RIPPLE_STEM;
    f.shade = max(f.shade, 0.5 * (1.0 - smoothstep(-px, 1.5 * px, stem)));
    vec2 toward = normalize(lamp - s.xy + vec2(1e-4));
    vec2 g = (q - 0.4 * s.z * toward) / (0.35 * s.z);
    f.glint = max(f.glint, exp(-dot(g, g)));
  }
  vec4 lens = rippleAt(row, ${RIPPLE_TEXELS.lens});
  if (lens.z > 0.0) {
    vec4 axis = rippleAt(row, ${RIPPLE_TEXELS.axis});
    float depth = rippleLensDepth(p, lens, axis.xy);
    f.lens = smoothstep(-px, px, depth);
    float x = depth / (1.2 * px);
    f.edge = exp(-x * x);
  }
  vec4 m = rippleAt(row, ${RIPPLE_TEXELS.mark});
  if (m.w > 0.0) {
    float d = markDistance((p - m.xy) / m.z) * m.z - RIPPLE_MARK_W;
    f.mark = 1.0 - smoothstep(-px, px, d);
    f.rim = max(f.rim, rippleMeniscus(d));
  }
  return f;
}

// The screen under the tank: the lamp's light, gathered and spread by the water, and the
// fixtures' shadows.
RippleLook rippleProjection(int row, vec2 p, vec2 F, vec2 lamp, float pool) {
  vec4 meta = rippleAt(row, ${RIPPLE_TEXELS.meta});
  float kappa = mix(RIPPLE_FOCUS.x, RIPPLE_FOCUS.y, clamp(K_focus, 0.0, 1.0)) * meta.z;
  vec2 uv = p / F;
  // The light landing here crossed the surface a little upslope of it (the water bends it by the
  // slope times the screen's distance): read the focus there.
  vec2 slope = rippleView(row, uv).zw;
  vec4 v = rippleView(row, uv - slope * (kappa * meta.w * 0.159) / F);
  float light = 1.0 / max(v.y, 0.18);
  float b = pool * (1.0 - exp(-RIPPLE_TONE * light));
  RippleFix f = rippleFixtures(row, p, lamp);
  b *= 1.0 - f.shade;
  b *= 1.0 - 0.08 * f.lens;
  b += pool * (0.2 * f.edge * (1.0 - f.lens * 0.5) + RIPPLE_RIM * f.rim);
  float solid = rippleHard(max(max(f.wall, f.bar), f.ball));
  b = mix(b, 0.03 * pool, solid);
  return RippleLook(b, f.mark * (1.0 - solid), pool * 0.8);
}

// The water itself from above, dark, its slopes catching the room's light and the lamp mirrored in
// it, broken up by the waves; the fixtures seen as they are: wax barriers, a steel bar, black
// glossy balls, the glass plate pale under its shallow water.
RippleLook rippleSurface(int row, vec2 p, vec2 F, vec2 lamp) {
  vec4 meta = rippleAt(row, ${RIPPLE_TEXELS.meta});
  vec2 slope = rippleView(row, p / F).zw;
  vec2 d = p - lamp;
  float room = 0.12 + 0.12 * exp(-dot(d, d) / 1.1);
  float b = room * max(1.0 + 1.1 * dot(slope, RIPPLE_TOWARD), 0.0);
  vec2 q = p + slope * (0.05 + 0.25 * meta.w) - lamp;
  b += 0.85 * exp(-dot(q, q) / 0.03);
  RippleFix f = rippleFixtures(row, p, lamp);
  b += 0.05 * f.lens + 0.14 * f.edge + 0.12 * f.rim;
  b = mix(b, 0.48 + 0.12 * exp(-dot(d, d) / 0.8), rippleHard(f.wall));
  b = mix(b, 0.34, rippleHard(f.bar));
  b = mix(b, 0.1 + 0.8 * f.glint, rippleHard(f.ball));
  return RippleLook(b, f.mark, 0.9);
}

// Without the sim: two dippers' rings summed, the screen's focus worked out from the height (a
// ring's curvature is -k^2 times its height).
RippleLook rippleStill(vec2 p, vec2 F, float pool, float t) {
  bool portrait = F.y > F.x;
  float L = max(F.x, F.y);
  float lambda = RIPPLE_C * K_speed / (RIPPLE_F * K_frequency);
  float d = min(3.5 * lambda, 0.6);
  vec2 s0 = ripplePlace(0.3 * L, 0.5 - 0.5 * d, portrait);
  vec2 s1 = ripplePlace(0.3 * L, 0.5 + 0.5 * d, portrait);
  float k = TAU / lambda;
  float phase = TAU * RIPPLE_F * K_frequency * t * uMotion;
  float r0 = distance(p, s0);
  float r1 = distance(p, s1);
  float h = sqrt(lambda / max(r0, 0.25 * lambda)) * sin(phase - k * r0 - 0.785)
          + sqrt(lambda / max(r1, 0.25 * lambda)) * sin(phase - k * r1 - 0.785);
  float kappa = mix(RIPPLE_FOCUS.x, RIPPLE_FOCUS.y, clamp(K_focus, 0.0, 1.0));
  float b = pool * (1.0 - exp(-RIPPLE_TONE / max(1.0 - kappa * h, 0.18)));
  float ball = 1.0 - smoothstep(-ripplePx, ripplePx, min(r0, r1) - RIPPLE_DIPPER_R);
  b = mix(b, 0.03 * pool, rippleHard(ball));
  return RippleLook(b, 0.0, pool);
}

Shade sceneRipple(vec2 uv, vec2 cell, float t) {
  rippleTh = threshold(cell);
  float aspect = uRes.x / uRes.y;
  vec2 F = aspect >= 1.0 ? vec2(aspect, 1.0) : vec2(1.0, 1.0 / aspect);
  bool portrait = F.y > F.x;
  ripplePx = 1.0 / min(uRes.x, uRes.y);
  vec2 p = uv * F;
  vec2 lamp = ripplePlace(RIPPLE_LAMP_AT.x * max(F.x, F.y), RIPPLE_LAMP_AT.y, portrait);
  vec2 dl = p - lamp;
  float pool = 0.45 + 0.55 * exp(-dot(dl, dl) / 0.72);
  bool surface = K_render > 0.5;

  RippleLook look;
  if (uSimOn.x > 0.5 && uSimOn.z > 0.5) {
    if (surface) look = rippleSurface(0, p, F, lamp);
    else look = rippleProjection(0, p, F, lamp, pool);
    float fade = rippleAt(1, ${RIPPLE_TEXELS.meta}).x;
    if (fade > 0.0) {
      RippleLook next;
      if (surface) next = rippleSurface(1, p, F, lamp);
      else next = rippleProjection(1, p, F, lamp, pool);
      look.b = mix(look.b, next.b, fade);
      look.m = mix(look.m, next.m, fade);
      look.lit = mix(look.lit, next.lit, fade);
    }
  } else {
    look = rippleStill(p, F, pool, t);
  }

  vec3 smoothCol;
  vec3 col = rippleRamp(look.b, clamp(int(K_light + 0.5), 0, ${LIGHTS.length - 1}), smoothCol);
  vec3 tint = uAccent * (0.25 + 0.9 * look.lit);
  float mark = rippleHard(look.m);
  if (mark > 0.5) col = rippleSnap(tint);
  smoothCol = mix(smoothCol, tint, look.m);

  Shade o = blankShade();
  o.rgb = col;
  o.source = smoothCol;
  o.ink = clamp(1.1 * look.b, 0.0, 1.0) * (1.0 - mark);
  o.accent = mark;
  return o;
}
`;
