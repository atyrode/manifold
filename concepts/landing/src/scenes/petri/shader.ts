// The petri dish's picture: the bench under a lamp (or a light box), the dish's shadow and glass,
// the meniscus, and the chemistry the sim (sim.ts) steps inside.
//   uSim0  the view, rgba16f, grid uv = (p - dish centre) / dish diameter + 0.5: x the shown
//          quantity (Turing: the activator v; BZ: the oxidised share), yz its gradient per texel,
//          w Turing: how young the growth is, BZ: the excitation u
//   uSim1  events, rgba16f 8×2: row 0 bubbles marking BZ pacemakers (grid uv x, y, radius,
//          presence), row 1 ripples where drops fell (grid uv x, y, age in seconds, strength)
// Without uSim0 (no float render targets) the dish holds a still lattice of stripes (Turing) or a
// pair of turning spirals (BZ) drawn here.
// Knobs read here: K_chemistry, K_palette, K_relief, K_lightbox, K_size, K_mark.
import { PETRI_BUBBLES, PETRI_FIT, PETRI_MARK, PETRI_RADIUS, PETRI_RIPPLE, PETRI_RIPPLES } from "./sim.ts";

const glsl = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const petriGlsl = `
const float PETRI_RADIUS = ${glsl(PETRI_RADIUS)};
const float PETRI_FIT = ${glsl(PETRI_FIT)};
const float PETRI_MARK_BASE = ${glsl(PETRI_MARK.base)};
const float PETRI_MARK_SPAN = ${glsl(PETRI_MARK.span)};
const float PETRI_RIPPLE_SPEED = ${glsl(PETRI_RIPPLE.speed)};
const float PETRI_RIPPLE_WIDTH = ${glsl(PETRI_RIPPLE.width)};
const float PETRI_RIPPLE_SHIFT = ${glsl(PETRI_RIPPLE.shift)};
const float PETRI_RIPPLE_LIFE = ${glsl(PETRI_RIPPLE.life)};
const float PETRI_WALL = 0.028;                       // the glass wall's thickness, in dish radii
const float PETRI_MENISCUS = 0.08;                    // where the liquid climbs the glass, in dish radii
const float PETRI_RELIEF = 7.0;                       // surface slope per unit of v per texel, at full relief
const float PETRI_SCHLIEREN = 0.9;                    // BZ: light bent by a front, per unit of blue per texel
const vec3 PETRI_LIGHT = vec3(-0.416, 0.516, 0.749);  // toward the lamp, high on the upper left
const vec3 PETRI_HALF = vec3(-0.222, 0.276, 0.935);   // halfway between the lamp and the eye
const vec2 PETRI_TOWARD = vec2(-0.628, 0.778);        // the lamp's bearing across the bench
const vec2 PETRI_CAST = vec2(0.11, -0.135);           // the dish's shadow, offset in dish radii
const vec2 PETRI_POOL = vec2(-1.05, 0.75);            // the lamp's pool of light, from the dish, in radii

// The dish's inner radius in frame heights (sim.ts petriRadius).
float petriRadius(float aspect) {
  return min(PETRI_RADIUS * (0.75 + 0.5 * K_size), PETRI_FIT * aspect);
}

// The lamp: warm white, or a blacklight for the fluorescent palette.
vec3 petriLamp(int palette) {
  return palette == 2 ? vec3(0.40, 0.22, 0.92) : vec3(1.0, 0.94, 0.84);
}

// The colour the liquid lends the light passing through it, seen in the dish's shadow.
vec3 petriTint(bool bz, int palette) {
  if (palette == 1) return vec3(0.62);
  if (palette == 2) return vec3(0.55, 0.32, 0.85);
  return bz ? vec3(0.95, 0.45, 0.22) : vec3(0.9, 0.62, 0.45);
}

// The bench in the lamp's pool of light, or the light box's panel (a UV transilluminator for the
// fluorescent palette). p from the dish centre, frame heights.
vec3 petriGround(vec2 p, float aspect, float R, int palette, bool box, vec3 lamp) {
  if (box) {
    vec2 q = p / vec2(0.5 * aspect, 0.5);
    vec3 panel = palette == 2 ? vec3(0.22, 0.09, 0.48) : vec3(0.99, 0.985, 0.97);
    return panel * (1.0 - 0.08 * dot(q, q));
  }
  vec3 bench = palette == 2 ? vec3(0.012, 0.008, 0.026) : vec3(0.018, 0.019, 0.022);
  vec2 d = p - PETRI_POOL * R;
  float pool = exp(-dot(d, d) / (R * R * 2.2));
  return bench * (0.7 + 0.9 * pool) + lamp * (0.07 * pool);
}

// The dish's shadow on the bench, away from the lamp: tinted by the liquid the light came through,
// darker under the wall, with the bright arc the wall's glass focuses just inside it. Only the
// crescent beyond the dish shows.
vec3 petriShadow(vec3 col, vec2 p, float R, float W, vec3 tint, vec3 lamp) {
  vec2 q = p - PETRI_CAST * R;
  float rs = length(q);
  float soft = 0.06 * R;
  float under = 1.0 - smoothstep(R + W - soft, R + W + soft, rs);
  float wall = smoothstep(R - soft, R + 0.5 * W, rs) * under;
  col *= mix(vec3(1.0), mix(tint * 0.6, vec3(0.25), wall), under);
  float x = (rs - (R - 1.2 * W)) / (1.4 * W);
  return col + lamp * mix(vec3(1.0), tint, 0.6) * (0.12 * exp(-x * x) * (1.0 - wall));
}

// A still dish for when there is no simulation: crossed stripes, or a spiral pair turning.
float petriStill(vec2 g, bool bz, float t) {
  if (bz) {
    vec2 a = vec2(0.40, 0.56);
    vec2 b = vec2(0.53, 0.47);
    float phase = (atan(g.y - a.y, g.x - a.x) - atan(g.y - b.y, g.x - b.x)) / TAU
      - 5.5 * length(g - 0.5 * (a + b)) + 0.06 * t * uMotion;
    float f = fract(phase);
    return smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.18, 0.45, f));
  }
  float n = 0.0;
  for (int i = 0; i < 5; i++) {
    float a = float(i) * 0.6283 + 0.4;
    n += cos(dot(g, vec2(cos(a), sin(a))) * 104.0 + float(i) * 1.7);
  }
  return 0.3 * smoothstep(-0.4, 0.8, n);
}

// The chemistry at g (grid uv): the sim's view, or the still dish with its gradient per texel.
vec4 petriField(vec2 g, bool bz, float t) {
  if (uSimOn.x > 0.5) return texture(uSim0, g);
  float e = 1.0 / 224.0;
  float c = petriStill(g, bz, t);
  return vec4(c, petriStill(g + vec2(e, 0.0), bz, t) - c, petriStill(g + vec2(0.0, e), bz, t) - c, 0.0);
}

// The Turing culture: raised growth on the gel, lit by the lamp (coral, bone-white chalk, or green
// fluorescence), or seen against the light box by the light it soaks up. Fresh growth is paler.
vec3 petriCulture(vec4 f, int palette, bool box, vec3 ground, vec3 lamp, float lit, out float accent) {
  float v = f.x;
  float s = smoothstep(0.1, 0.28, v);
  float young = f.w;
  vec3 n = normalize(vec3(-f.yz * (PETRI_RELIEF * K_relief), 1.0));
  float diffuse = max(dot(n, PETRI_LIGHT), 0.0) / PETRI_LIGHT.z;
  float gloss = max(pow(max(dot(n, PETRI_HALF), 0.0), 24.0) - pow(PETRI_HALF.z, 24.0), 0.0);
  accent = s * smoothstep(0.4, 0.9, young);
  vec3 glow = mix(vec3(0.10, 0.62, 0.32), vec3(0.50, 0.95, 0.45), young);
  if (box) {
    float thick = s * (0.8 + 0.6 * (1.0 - young));
    vec3 col;
    if (palette == 0) col = ground * vec3(0.98, 0.91, 0.76) * exp(-vec3(0.35, 1.5, 1.9) * thick);
    else if (palette == 1) col = ground * vec3(0.98, 0.97, 0.94) * exp(-vec3(2.0, 1.75, 0.95) * thick);
    else col = mix(ground * 0.6, glow * 1.1, s);
    return col * (1.0 + 0.4 * K_relief * s * (diffuse - 1.0));
  }
  if (palette == 0) {
    vec3 gel = vec3(0.085, 0.066, 0.046) * lit;
    vec3 body = mix(vec3(0.60, 0.19, 0.14), vec3(0.90, 0.44, 0.30), smoothstep(0.12, 0.32, v));
    body = mix(body, vec3(1.0, 0.76, 0.58), 0.6 * young);
    return mix(gel, body * lit * diffuse + lamp * (0.8 * gloss), s);
  }
  if (palette == 1) {
    vec3 gel = vec3(0.030, 0.032, 0.038) * lit;
    return mix(gel, vec3(0.86, 0.85, 0.80) * lit * diffuse + lamp * (0.5 * gloss), s);
  }
  vec3 gel = vec3(0.022, 0.012, 0.045) * lit;
  return mix(gel, glow * (0.75 + 0.25 * diffuse) + lamp * (0.3 * gloss), s);
}

// BZ: the indicator turning from its reduced colour to its oxidised one where a wave passes, the
// leading edge first; fronts bend the light a little, catching it on the lamp's side. Ferroin
// red-orange and blue, ink and paper, or ruthenium's orange glow under UV, dark where oxidised.
vec3 petriWaves(vec4 f, int palette, bool box, vec3 ground, float lit, out float accent) {
  float ox = max(f.x, 0.5 * f.w);
  vec3 reduced;
  vec3 oxidised;
  if (palette == 0) {
    reduced = box ? vec3(0.93, 0.36, 0.13) : vec3(0.66, 0.21, 0.07);
    oxidised = box ? vec3(0.20, 0.40, 0.85) : vec3(0.14, 0.30, 0.72);
  } else if (palette == 1) {
    reduced = box ? vec3(0.95, 0.94, 0.90) : vec3(0.032, 0.034, 0.040);
    oxidised = box ? vec3(0.12, 0.17, 0.37) : vec3(0.82, 0.83, 0.84);
  } else {
    reduced = box ? vec3(1.0, 0.50, 0.17) : vec3(0.78, 0.30, 0.07);
    oxidised = box ? vec3(0.20, 0.08, 0.38) : vec3(0.05, 0.02, 0.08);
  }
  vec3 col = mix(reduced, oxidised, ox);
  if (!box) col *= lit;
  else if (palette != 2) col *= dot(ground, LUMA) / 0.985;
  col *= 1.0 + PETRI_SCHLIEREN * K_relief * dot(f.yz, PETRI_TOWARD);
  accent = palette == 2 ? 0.8 * (1.0 - ox) : ox;
  return col;
}

// Rings where drops fell: how far they bend the view of the bottom (grid uv), and their crests.
vec2 petriRipples(vec2 g, out float crest) {
  vec2 shift = vec2(0.0);
  crest = 0.0;
  for (int i = 0; i < ${PETRI_RIPPLES}; i++) {
    vec4 ripple = texelFetch(uSim1, ivec2(i, 1), 0);
    if (ripple.w <= 0.0) continue;
    vec2 d = g - ripple.xy;
    float dist = length(d);
    float x = (dist - ripple.z * PETRI_RIPPLE_SPEED) / PETRI_RIPPLE_WIDTH;
    float wave = sin(3.0 * x) * exp(-x * x) * ripple.w * (1.0 - ripple.z / PETRI_RIPPLE_LIFE);
    shift += d / max(dist, 1e-4) * (wave * PETRI_RIPPLE_SHIFT);
    crest += max(wave, 0.0);
  }
  return shift;
}

// The bubbles that mark BZ pacemakers: a dark refracting rim, a glint toward the lamp; they swell
// as they appear and shrink as they dissolve.
vec3 petriBubbles(vec3 col, vec2 p, float R, float px, bool box, vec3 lamp) {
  for (int i = 0; i < ${PETRI_BUBBLES}; i++) {
    vec4 b = texelFetch(uSim1, ivec2(i, 0), 0);
    if (b.w <= 0.0) continue;
    float rb = max(b.z * 2.0 * R * (0.4 + 0.6 * b.w), 2.0 * px);
    vec2 d = (p - (b.xy - 0.5) * (2.0 * R)) / rb;
    float dd = length(d);
    if (dd > 1.5) continue;
    float aa = px / rb;
    float body = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dd);
    float rim = smoothstep(0.4, 0.95, dd) * body;
    float glint = (1.0 - smoothstep(0.18, 0.4, length(d - 0.42 * PETRI_TOWARD))) * body;
    float shown = smoothstep(0.0, 0.3, b.w);
    col = mix(col, col * (box ? 0.3 : 0.5), rim * shown);
    col += (box ? vec3(0.45) : lamp * 0.7) * (glint * shown);
  }
  return col;
}

Shade scenePetri(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float px = 1.0 / uRes.y;
  float R = petriRadius(aspect);
  float W = max(R * PETRI_WALL, 2.5 * px);
  float r = length(p);
  vec2 dir = p / max(r, 1e-5);
  bool bz = K_chemistry > 0.5;
  int palette = int(K_palette + 0.5);
  bool box = K_lightbox > 0.5;
  vec3 lamp = petriLamp(palette);

  vec3 ground = petriGround(p, aspect, R, palette, box, lamp);
  vec3 col = box ? ground : petriShadow(ground, p, R, W, petriTint(bz, palette), lamp);
  float accent = 0.0;

  // The liquid, seen from above through its surface: it climbs the glass at the rim (the meniscus),
  // which bends the view of the bottom outward and catches the light (or, over the light box, bends
  // it away into a dark ring).
  if (r < R + px) {
    // The lamp lights the dish brightest toward its upper left.
    vec2 l = p - vec2(-0.6, 0.5) * R;
    float lit = box ? 1.0 : 0.75 + 0.45 * exp(-dot(l, l) / (1.1 * R * R));
    float men = smoothstep(R * (1.0 - PETRI_MENISCUS), R, r);
    men *= men;
    vec2 g = p / (2.0 * R) + 0.5 + dir * (0.014 * men);
    float crest = 0.0;
    if (uSimOn.y > 0.5) g += petriRipples(g, crest);
    vec4 f = petriField(g, bz, t);
    float act = 0.0;
    vec3 med = bz ? petriWaves(f, palette, box, ground, lit, act) : petriCulture(f, palette, box, ground, lamp, lit, act);
    if (bz && uSimOn.y > 0.5) med = petriBubbles(med, p, R, px, box, lamp);

    // The Manifold M etched into the glass floor, frosted where the chemistry takes hold.
    if (K_mark > 0.0) {
      float H = (PETRI_MARK_BASE + PETRI_MARK_SPAN * K_mark) * 2.0 * R;
      float w = max(1.5 * px, 0.016 * H);
      float etch = 1.0 - smoothstep(0.6 * w, w + px, markDistance(p / H) * H);
      etch *= bz ? 1.0 : 1.0 - 0.75 * smoothstep(0.1, 0.28, f.x);
      med = box ? med * (1.0 - 0.3 * etch) : med + lamp * (0.07 * etch);
      act = max(act, 0.8 * etch);
    }

    if (box) {
      med *= 1.0 - 0.7 * men;
    } else {
      // The meniscus mirrors the lamp on the side away from it; a soft sheen of the lamp lies on the
      // liquid toward it; the ripples' crests catch it too.
      vec2 s = p - vec2(-0.42, 0.48) * R;
      float sheen = exp(-dot(s, s) / (0.12 * R * R)) * (0.02 + 0.05 * K_relief);
      float rim = men * (0.025 + 0.3 * pow(max(-dot(dir, PETRI_TOWARD), 0.0), 3.0));
      med += lamp * (rim + sheen + 0.06 * crest);
    }
    float inside = 1.0 - smoothstep(R - px, R, r);
    col = mix(col, med, inside);
    accent = act * inside;
  }

  // The glass wall, seen from above: the rounded top of the rim catching the lamp on its side and
  // the inner face on the far side; over the light box, a dark ring with a bright core.
  float tw = (r - R) / W;
  if (tw > -0.5 && tw < 1.5) {
    float aw = px / W;
    float glass = smoothstep(-aw, 0.0, tw) * (1.0 - smoothstep(1.0, 1.0 + aw, tw));
    float x = (tw - 0.55) / 0.3;
    float top = exp(-x * x);
    vec3 wall;
    if (box) {
      wall = ground * (0.14 + 0.75 * top);
    } else {
      float facing = pow(max(dot(dir, PETRI_TOWARD), 0.0), 5.0);
      float far = pow(max(-dot(dir, PETRI_TOWARD), 0.0), 3.0);
      float y = tw / 0.25;
      wall = col * 0.7 + lamp * (top * (0.05 + 0.8 * facing) + 0.28 * exp(-y * y) * far);
    }
    col = mix(col, wall, glass);
    accent *= 1.0 - glass;
  }

  Shade o = blankShade();
  o.rgb = col;
  o.source = col;
  // Over the light box the page takes its paper theme, where ink means dark.
  float lum = dot(col, LUMA);
  o.ink = box && palette != 2 ? clamp((0.95 - lum) / 0.85, 0.0, 1.0) : clamp(1.25 * lum, 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  return o;
}
`;
