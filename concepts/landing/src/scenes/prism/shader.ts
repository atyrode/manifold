// The prism scene's picture: the beams the sim (sim.ts) traces through the glass, integrated across
// wavelength into a continuous spectrum; the glass itself, one solid prism drawn with restraint;
// dust in the light; the screen the spectrum may land on; and the M cut in Newton's shutter.
//   uSim0  the fans, one per row (layout in sim.ts)
//   uSim1  the prisms, the shutter's M, the source beam and the screen (layout in sim.ts)
// Knobs read here: K_edges, K_dust, K_screen, K_backdrop.
import { glslFloat } from "../../shaders/glsl.ts";
import {
  PRISM_CAUSTIC_CELLS,
  PRISM_CAUSTIC_SPREAD,
  PRISM_FANS,
  PRISM_GLOW_CELLS,
  PRISM_GLOW_SPREAD,
  PRISM_HEADER,
  PRISM_KIND_SOURCE,
  PRISM_MIN_WIDTH,
  PRISM_SAMPLES,
  prismSpectrum,
} from "./sim.ts";

// The wavelengths' colours are written to four places, as the picture was tuned with.
const spectrum = prismSpectrum.map((c) => `vec3(${c.map((v) => v.toFixed(4)).join(", ")})`).join(",\n  ");

export const prismGlsl = `
const int PRISM_FANS = ${PRISM_FANS};
const int PRISM_SAMPLES = ${PRISM_SAMPLES};
const int PRISM_HEADER = ${PRISM_HEADER};
const float PRISM_SOURCE = ${glslFloat(PRISM_KIND_SOURCE)};
const float PRISM_GLOW_SPREAD = ${glslFloat(PRISM_GLOW_SPREAD)};
const float PRISM_GLOW_CELLS = ${glslFloat(PRISM_GLOW_CELLS)};
const float PRISM_MIN_WIDTH = ${glslFloat(PRISM_MIN_WIDTH)};
const float PRISM_CAUSTIC_SPREAD = ${glslFloat(PRISM_CAUSTIC_SPREAD)};
const float PRISM_CAUSTIC_CELLS = ${glslFloat(PRISM_CAUSTIC_CELLS)};

// The sampled wavelengths' colours, linear sRGB; across all samples (trapezoid rule) they sum to white.
const vec3 PRISM_COLOR[PRISM_SAMPLES] = vec3[PRISM_SAMPLES](
  ${spectrum}
);

const float PRISM_EXPOSURE = 3.2;                 // light to display: 1 - exp(-light * exposure), then a soft gamma
const float PRISM_GAMMA = 1.6;
const float PRISM_SHOULDER = 0.3;                 // a beam's soft edge, in half-widths either side of it
const float PRISM_GLOW = 0.03;                    // light scattered sideways by the dust, against the beam
const float PRISM_CAUSTIC = 0.55;                 // the soft spot where a beam meets glass
const float PRISM_DUST_GLINT = 4.0;               // a mote against the light it floats in
const float PRISM_SCREEN_GAIN = 4.0;              // light landing on the screen, against the beam it lands from
const float PRISM_SCREEN_SPREAD = 0.035;          // how far it spreads across the screen (screen heights)
const vec3 PRISM_SCREEN_FACE = vec3(0.010, 0.011, 0.014); // the screen itself, barely there
const vec3 PRISM_GLASS = vec3(0.80, 0.88, 1.0);   // light on the glass, cool
const vec3 PRISM_TINT = vec3(0.008, 0.012, 0.017); // the glass's own body
const vec2 PRISM_ROOM = vec2(-0.6, 0.8);          // the room's soft light, high on the left
const vec3 PRISM_SUN = vec3(1.0, 0.95, 0.86);     // sunlight in the shutter's M

vec2 prismPair(vec4 v) {
  return vec2(v.x + v.y, v.z + v.w);
}

// A beam's cross-section in units of its half-width: flat, with a linear shoulder PRISM_SHOULDER wide
// either side of 1 (area 2, half power at 1); and its antiderivative.
float prismCoreProfile(float x) {
  return clamp((1.0 + PRISM_SHOULDER - abs(x)) / (2.0 * PRISM_SHOULDER), 0.0, 1.0);
}

float prismCoreArea(float x) {
  float a = abs(x);
  float y = clamp(a - (1.0 - PRISM_SHOULDER), 0.0, 2.0 * PRISM_SHOULDER);
  return sign(x) * (min(a, 1.0 - PRISM_SHOULDER) + y - y * y / (4.0 * PRISM_SHOULDER));
}

// Signed distance from q (in a fan's frame) to one wavelength's ray: s = origin xy, sin of its angle.
float prismRayDistance(vec2 q, vec4 s) {
  vec2 dir = vec2(sqrt(max(1.0 - s.z * s.z, 0.0)), s.z);
  return dir.x * (q.y - s.y) - dir.y * (q.x - s.x);
}

// Where, between two wavelength samples (0..1), a distance running linearly d0 -> d0 + dd stays
// within +-h: the middle of that stretch, for the colour.
float prismCovered(float d0, float dd, float h) {
  float a = (-h - d0) / dd;
  float b = (h - d0) / dd;
  return 0.5 * (clamp(min(a, b), 0.0, 1.0) + clamp(max(a, b), 0.0, 1.0));
}

// The dark room: black, or a deep blue a little lighter high up and away from the window.
vec3 prismRoom(vec2 p, float aspect) {
  if (K_backdrop < 0.5) return vec3(0.0);
  return mix(vec3(0.004, 0.010, 0.040), vec3(0.014, 0.030, 0.090), smoothstep(-0.4, 1.0, p.y + 0.5 + 0.3 * (p.x / aspect + 0.5)));
}

// Dust in the air scatters a little of each beam sideways, unevenly: a slow drifting haze, 0.2..1.5.
float prismHaze(vec2 p, float t) {
  vec2 drift = vec2(0.006, 0.003) * t;
  float n = 0.6 * vnoise((p - drift) * 7.0) + 0.4 * vnoise((p + drift) * 19.0 + vec2(5.2, 1.3));
  return 0.2 + 1.3 * smoothstep(0.35, 0.8, n);
}

struct PrismGlass {
  float inside; // 0..1, soft over a cell
  vec2 behind;  // where the room behind is seen through the glass
  vec3 light;   // the glass's own light: silhouette, bevels, corner glints, body
};

// Prism k (0, 1) at p, from its centre, turn and circumradius in uSim1; glow: light trapped inside.
PrismGlass prismGlass(int k, vec2 p, float px, float glow) {
  PrismGlass g;
  vec2 c = prismPair(texelFetch(uSim1, ivec2(2 * k, 0), 0));
  vec2 cs = prismPair(texelFetch(uSim1, ivec2(2 * k + 1, 0), 0));
  float radius = texelFetch(uSim1, ivec2(4, 0), 0).x;
  vec2 corner[3];
  corner[0] = vec2(-cs.y, cs.x);
  corner[1] = vec2(-0.8660254 * cs.x + 0.5 * cs.y, -0.8660254 * cs.y - 0.5 * cs.x);
  corner[2] = vec2(0.8660254 * cs.x + 0.5 * cs.y, 0.8660254 * cs.y - 0.5 * cs.x);

  float edge = 1e9;
  float outside = -1e9;
  float lit = 0.0;
  float glint = 0.0;
  for (int m = 0; m < 3; m++) {
    vec2 a = c + radius * corner[m];
    vec2 b = c + radius * corner[m == 2 ? 0 : m + 1];
    vec2 n = normalize(vec2(b.y - a.y, a.x - b.x));
    float d = segmentDistance(p, a, b);
    // A face toward the room's light catches it, the far side stays dim, and a face turned square
    // to the light flares.
    float facing = dot(n, PRISM_ROOM);
    float catchLight = 0.15 + 0.85 * smoothstep(-0.5, 0.9, facing) + 0.6 * pow(max(facing, 0.0), 12.0);
    if (d < edge) {
      edge = d;
      lit = catchLight;
    }
    outside = max(outside, dot(p - a, n));
    // A corner turned toward the light glints.
    vec2 r = p - a;
    glint += pow(max(dot(corner[m], PRISM_ROOM), 0.0), 6.0) * exp(-dot(r, r) / (6.0 * px * px));
  }
  float sd = outside > 0.0 ? edge : -edge;
  g.inside = softFill(sd, 0.5 * px);
  // One crisp silhouette, and inside it the bevel: the ground edge rounding off into the glass,
  // bright where it faces the light and a whisper on the far side.
  float silhouette = 1.0 - smoothstep(0.5 * px, 1.7 * px, edge);
  float bevelWidth = max(6.0 * px, 0.07 * radius);
  float bevel = g.inside * pow(1.0 - clamp(-sd / bevelWidth, 0.0, 1.0), 2.0);
  // The body: a faint cool tint, brighter toward the edges where glass reflects more at a glance, a
  // soft sheen across it from the room's light, and the glow of light trapped inside.
  vec2 local = (p - c) / radius;
  float sheen = bell((dot(local, PRISM_ROOM) - 0.2) / 0.3);
  float rim = exp(min(sd, 0.0) / (0.12 * radius));
  vec3 body = K_edges * (PRISM_TINT * (1.0 + 1.5 * rim) + 0.03 * sheen * PRISM_GLASS) + 0.03 * min(glow, 2.0) * PRISM_GLASS;
  g.light = K_edges * PRISM_GLASS * (1.2 * silhouette * lit + 0.8 * bevel * lit + glint) + g.inside * body;
  // The room seen through the glass, drawn in a little toward its middle.
  g.behind = c + (p - c) * 0.86;
  return g;
}

// Every fan's light at p: the beams' cores and dust-scattered glow (linear rgb) and the soft spots
// where they meet glass. inside1, inside2: how far p is inside prism 1 and 2.
// Most pixels meet no fan or one; where several overlap (at the faces) each runs its wavelength
// loop, so the worst case is PRISM_FANS × (PRISM_SAMPLES - 1) steps over a few small patches, while
// the common path stays within one fan's 24.
void prismFans(vec2 p, float px, float inside1, float inside2, out vec3 core, out vec3 glow, out vec3 caustic) {
  core = vec3(0.0);
  glow = vec3(0.0);
  caustic = vec3(0.0);
  float inside = max(inside1, inside2);
  vec4 beam = texelFetch(uSim1, ivec2(6, 0), 0);
  vec2 shutter = prismPair(texelFetch(uSim1, ivec2(5, 0), 0));
  float source = texelFetch(uSim1, ivec2(7, 0), 0).x;
  for (int f = 0; f < PRISM_FANS; f++) {
    vec4 box = texelFetch(uSim0, ivec2(0, f), 0);
    if (box.x > box.z) break;
    if (p.x < box.x || p.x > box.z || p.y < box.y || p.y > box.w) continue;
    vec2 v = p - prismPair(texelFetch(uSim0, ivec2(1, f), 0));
    vec2 cs = prismPair(texelFetch(uSim0, ivec2(2, f), 0));
    vec2 q = vec2(cs.x * v.x + cs.y * v.y, cs.x * v.y - cs.y * v.x);
    vec4 shape = texelFetch(uSim0, ivec2(6, f), 0);
    vec4 spot = texelFetch(uSim0, ivec2(7, f), 0);
    float hw = max(shape.z, PRISM_MIN_WIDTH * px);
    float rc = PRISM_CAUSTIC_SPREAD * hw + PRISM_CAUSTIC_CELLS * px;
    caustic += spot.rgb * exp(-dot(v, v) / (rc * rc));

    vec4 bounds = texelFetch(uSim0, ivec2(5, f), 0);
    if (q.x < bounds.x || q.x > bounds.y || q.y < bounds.z + bounds.w * q.x || q.y > shape.x + shape.y * q.x) continue;
    vec4 start = texelFetch(uSim0, ivec2(3, f), 0);
    vec4 end = texelFetch(uSim0, ivec2(4, f), 0);
    // Between the faces it runs from and to; a ghost (partial reflection) fades with distance.
    float clip = smoothstep(-px, px, dot(start.xy, p) + start.z + start.w) * smoothstep(-px, px, dot(end.xy, p) + end.z + end.w);
    float fade = max(q.x, 0.0) * texelFetch(uSim0, ivec2(8, f), 0).x;
    clip *= bell(fade);
    float coreMask = 1.0 - inside;
    float glowMask = 1.0 - 0.5 * inside;
    if (spot.w > PRISM_SOURCE - 0.5) {
      // The sunbeam starts at the shutter while the M is shown.
      clip *= 1.0 - beam.z * softFill(dot(beam.xy, p - shutter), px);
    } else if (spot.w > 1.5) {
      coreMask = inside2;
      glowMask = inside2;
    } else if (spot.w > 0.5) {
      coreMask = inside1;
      glowMask = inside1;
    }
    if (clip <= 0.001) continue;

    float hg = PRISM_GLOW_SPREAD * hw + PRISM_GLOW_CELLS * px;
    vec3 c = vec3(0.0);
    vec3 g = vec3(0.0);
    int stride = int(shape.w + 0.5);
    if (stride < 1) {
      // Colours that never part: one white band.
      vec4 s = texelFetch(uSim0, ivec2(PRISM_HEADER + PRISM_SAMPLES / 2, f), 0);
      float d = prismRayDistance(q, s);
      float th = tanh(d / hg);
      c = vec3(prismCoreProfile(d / hw) * s.w);
      g = vec3((1.0 - th * th) * s.w);
    } else {
      // Across wavelength: between neighbouring samples the distance from p to the ray runs
      // linearly, so each interval's share of the beam's cross-section over p is exact, and the
      // colour is taken at the middle of the stretch that covers p.
      vec4 s0 = texelFetch(uSim0, ivec2(PRISM_HEADER, f), 0);
      float d0 = prismRayDistance(q, s0);
      float a0 = prismCoreArea(d0 / hw);
      float t0 = tanh(d0 / hg);
      float w0 = s0.w;
      vec3 col0 = PRISM_COLOR[0];
      for (int i = stride; i < PRISM_SAMPLES; i += stride) {
        vec4 s1 = texelFetch(uSim0, ivec2(PRISM_HEADER + i, f), 0);
        float d1 = prismRayDistance(q, s1);
        float a1 = prismCoreArea(d1 / hw);
        float t1 = tanh(d1 / hg);
        float w1 = s1.w;
        vec3 col1 = PRISM_COLOR[i];
        if (max(w0, w1) > 0.0) {
          float dd = d1 - d0;
          float fc;
          float fg;
          float mc = 0.5;
          float mg = 0.5;
          if (abs(dd) > 1e-3 * hw) {
            fc = (a1 - a0) * hw / dd;
            fg = (t1 - t0) * hg / dd;
            mc = prismCovered(d0, dd, hw);
            mg = prismCovered(d0, dd, 1.5 * hg);
          } else {
            float mid = d0 + 0.5 * dd;
            float th = tanh(mid / hg);
            fc = prismCoreProfile(mid / hw);
            fg = 1.0 - th * th;
          }
          c += fc * mix(w0, w1, mc) * mix(col0, col1, mc);
          g += fg * mix(w0, w1, mg) * mix(col0, col1, mg);
        }
        d0 = d1;
        a0 = a1;
        t0 = t1;
        w0 = w1;
        col0 = col1;
      }
      float span = float(stride) / float(PRISM_SAMPLES - 1);
      c *= span;
      g *= span;
    }
    // A narrower beam carries the same light: brighter per cell.
    float gain = clip * source / hw;
    core += c * gain * coreMask;
    glow += g * gain * glowMask;
  }
}

// Dust drifting through the room: two layers of sparse motes, each a disc 2.5 to 4 cells across on
// its own slow wobble, turning a facet to the light now and then. 0..1 where a mote is.
float prismMotes(vec2 p, float t, float px, float amount) {
  float m = 0.0;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float grid = mix(0.045, 0.075, fk);
    vec2 drift = mix(vec2(0.0045, 0.0025), vec2(-0.0025, 0.004), fk) * t;
    vec2 q = (p - drift) / grid + fk * vec2(13.7, 7.1);
    vec2 id = floor(q);
    float h = hash12(id + fk * 31.0);
    if (h > 0.3 * amount) continue;
    float h2 = hash12(id + vec2(17.0, 3.0));
    float h3 = hash12(id + vec2(5.0, 41.0));
    vec2 centre = 0.5 + (vec2(h2, h3) - 0.5) * 0.5 + 0.12 * vec2(sin(t * 0.23 + h * 40.0), cos(t * 0.19 + h2 * 40.0));
    float r = (1.25 + 0.75 * h3) * px / grid;
    float disc = 1.0 - smoothstep(0.45 * r, r, length(q - id - centre));
    float facet = 0.25 + 0.75 * pow(max(0.5 + 0.5 * sin(t * (0.5 + 0.8 * h2) + h * 60.0), 0.0), 6.0);
    m = max(m, disc * facet);
  }
  return m;
}

// Newton's shutter, its hole cut as the Manifold M: sunlight fills the hole and the beam leaves it.
vec3 prismShutter(vec2 p, float px, out float hole) {
  hole = 0.0;
  vec4 info = texelFetch(uSim1, ivec2(6, 0), 0);
  float shown = info.z;
  float size = info.w;
  if (shown <= 0.0 || size <= 0.0) return vec3(0.0);
  vec2 q = (p - prismPair(texelFetch(uSim1, ivec2(5, 0), 0))) / size;
  float d = markDistance(q);
  float w = 0.085;
  float cut = 1.0 - smoothstep(w - 0.6 * px / size, w + 0.9 * px / size, d);
  float halo = exp(-max(d - w, 0.0) * 9.0) * (1.0 - cut);
  hole = shown * cut;
  return shown * PRISM_SUN * (cut + 0.22 * halo);
}

Shade scenePrism(vec2 uv, vec2 cell, float t) {
  float accent = 0.0;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float px = 1.0 / uRes.y;
  vec3 col = prismRoom(p, aspect);

  if (uSimOn.x > 0.5 && uSimOn.y > 0.5) {
    vec4 info = texelFetch(uSim1, ivec2(4, 0), 0);
    PrismGlass first = prismGlass(0, p, px, info.z);
    PrismGlass second;
    second.inside = 0.0;
    second.behind = p;
    second.light = vec3(0.0);
    if (info.y > 0.5) second = prismGlass(1, p, px, info.w);
    float inside = max(first.inside, second.inside);
    // The room through the glass: shifted, and a shade darker.
    if (inside > 0.0) col = mix(col, 0.85 * prismRoom(first.inside > second.inside ? first.behind : second.behind, aspect), inside);

    vec3 core;
    vec3 glow;
    vec3 caustic;
    prismFans(p, px, first.inside, second.inside, core, glow, caustic);
    float tm = uMotionTime;
    // Dust makes the scattered glow uneven; clean air leaves an even, fainter halo.
    glow *= K_dust > 0.0 ? prismHaze(p, tm) : 0.6;

    // Motes catch whatever light they drift through (not inside the glass).
    float motes = K_dust > 0.0 ? prismMotes(p, tm, px, K_dust) * (1.0 - inside) : 0.0;
    vec3 light = core + PRISM_GLOW * glow + PRISM_CAUSTIC * caustic;
    light += motes * PRISM_DUST_GLINT * (core + 0.6 * glow);

    // The screen: where the fan lands, a soft band of its colours spreading across the plane.
    vec4 screen = texelFetch(uSim1, ivec2(7, 0), 0);
    float across = p.x - screen.y;
    if (screen.z > 0.5 && K_screen > 0.0 && across > -2.0 * px) {
      float face = smoothstep(-px, px, across);
      col += face * K_screen * PRISM_SCREEN_FACE;
      if (across < 6.0 * PRISM_SCREEN_SPREAD) {
        vec3 landed;
        vec3 landedGlow;
        vec3 landedSpot;
        prismFans(vec2(screen.y - 2.0 * px, p.y), px, 0.0, 0.0, landed, landedGlow, landedSpot);
        // Most of it lands in a bright line; a little scatters further across the plane.
        float spread = face * (exp(-max(across, 0.0) / (0.2 * PRISM_SCREEN_SPREAD)) + 0.3 * exp(-max(across, 0.0) / PRISM_SCREEN_SPREAD));
        light += K_screen * PRISM_SCREEN_GAIN * spread * (landed + PRISM_GLOW * landedGlow);
      }
    }

    vec3 beams = pow(max(1.0 - exp(-light * PRISM_EXPOSURE), vec3(0.0)), vec3(1.0 / PRISM_GAMMA));
    col = 1.0 - (1.0 - col) * (1.0 - beams);
    col = 1.0 - (1.0 - col) * (1.0 - clamp(first.light + second.light, 0.0, 1.0));

    float hole;
    vec3 sun = prismShutter(p, px, hole);
    col = 1.0 - (1.0 - col) * (1.0 - clamp(sun, 0.0, 1.0));

    // Two-tone: the spectrum and the M in the accent colour, white light and glass in ink.
    float chroma = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
    accent = max(clamp(1.5 * chroma - 0.06, 0.0, 1.0), hole);
  }
  return shadeOf(col, inkOf(col, 1.3, 1.0), accent);
}
`;
