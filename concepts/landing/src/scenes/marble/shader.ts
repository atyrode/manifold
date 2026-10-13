// The marbling scene's picture: the tray of size, or the printed paper, under the ink that the sim
// (sim.ts) floats and combs.
//   uSim0  the ink, premultiplied rgba (alpha = cover), top row at uv.y = 1
//   uSim1  texel 0: tool tip (uv), tool shown 0..1, lift fade 0..1
//          texel 1: tool direction (unit), tine spacing across it in uv heights (0 = one stylus)
// Knobs read here: K_medium (0 tray, 1 print), K_palette, K_ripples, K_sheen, K_fibre, K_edges.
import { marblePalettes } from "./sim.ts";

/** A CSS hex colour as a GLSL vec3 literal (the pipeline works in display sRGB, as the canvas). */
function glslColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => (c / 255).toFixed(4));
  return `vec3(${channels.join(", ")})`;
}

const accentInks = marblePalettes.map((palette, i) => `  if (K_palette < ${i}.5) return ${glslColor(palette.accent)};`).join("\n");
const ringPalettes = marblePalettes.map((palette, i) => `  if (K_palette < ${i}.5) return ${palette.rings ? "true" : "false"};`).join("\n");

export const marbleGlsl = `
const vec3 MARBLE_SIZE = vec3(0.035, 0.047, 0.058);  // dark size in a dim studio (ebru, riso)
const vec3 MARBLE_BASIN = vec3(0.64, 0.68, 0.69);    // clear water over a pale tray (suminagashi)
const vec3 MARBLE_PAPER = vec3(0.922, 0.886, 0.800); // the sheet the pattern is printed onto
const vec3 MARBLE_FLOAT = vec3(0.6, 0.62, 0.66);     // the dim, cool light the floating ink is seen in

// The palette's ink that the two-tone palette paints in the accent colour.
vec3 marbleAccentInk() {
${accentInks}
  return vec3(0.0);
}

// Suminagashi is done on clear water over a pale tray; ebru on dark size.
bool marbleRings() {
${ringPalettes}
  return false;
}

// The size's surface: four long, slow swells from different directions (summed sines), their
// strength wandering so the crests never march in step. Returns the slope, dimensionless.
vec2 marbleSlope(vec2 p, float t) {
  vec2 d1 = vec2(0.866, 0.5);
  vec2 d2 = vec2(-0.423, 0.906);
  vec2 d3 = vec2(-0.961, -0.276);
  vec2 d4 = vec2(0.196, -0.981);
  vec2 g = d1 * (0.010 * cos(dot(p, d1) * 7.0 - t * 0.6))
    + d2 * (0.007 * cos(dot(p, d2) * 12.0 - t * 0.9 + 1.7))
    + d3 * (0.005 * cos(dot(p, d3) * 19.0 - t * 1.3 + 4.1))
    + d4 * (0.003 * cos(dot(p, d4) * 31.0 - t * 1.9 + 2.6));
  return g * (0.7 + 0.6 * vnoise(p * 2.0 + vec2(t * 0.05, 3.1)));
}

// The studio window mirrored in the wet surface: four panes, soft at the edges; r from its centre.
float marbleWindow(vec2 r) {
  vec2 d = abs(r) - vec2(0.22, 0.15);
  float pane = 1.0 - smoothstep(-0.025, 0.02, max(d.x, d.y));
  float bars = smoothstep(0.003, 0.009, min(abs(r.x), abs(r.y)));
  return pane * bars;
}

// Paper fibres in cell space, so they never crawl: streaks of stretched value noise in three
// directions, two sets lighter than the sheet and one darker. Roughly -1..2.
float marbleFibre(vec2 cell) {
  vec2 q = cell / 2.5;
  float f = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 r = rotate(q, fk * 2.09 + 0.35) * vec2(0.06, 0.8) + vec2(fk * 31.7, fk * 7.3);
    float streak = smoothstep(0.8, 0.94, vnoise(r));
    f += k == 1 ? -0.8 * streak : streak;
  }
  return f;
}

// A point relative to the tool's tip in the tool's frame (along, across), folded onto the
// nearest tine of a comb.
vec2 marbleTine(vec2 v, vec2 m, vec2 n, float spacing) {
  float across = dot(v, n);
  if (spacing > 0.0) across -= spacing * floor(across / spacing + 0.5);
  return vec2(dot(v, m), across);
}

Shade sceneMarble(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  bool print = K_medium > 0.5;
  bool rings = marbleRings();
  float tm = t * uMotion;

  vec4 tool = vec4(0.0);
  vec4 toolDir = vec4(1.0, 0.0, 0.0, 0.0);
  if (uSimOn.y > 0.5) {
    tool = texelFetch(uSim1, ivec2(0, 0), 0);
    toolDir = texelFetch(uSim1, ivec2(1, 0), 0);
  }
  // Lifting the sheet takes the ink with it.
  float keep = 1.0 - clamp(tool.w, 0.0, 1.0);

  vec2 slope = print ? vec2(0.0) : marbleSlope(p, tm) * (2.0 * K_ripples);

  // The ink rides the swell a little. A cross of four taps around it softens the edges (wider and
  // weighted more as K_edges falls) and finds where colours meet, for the fine dark rim that ink
  // with ox gall draws round itself.
  vec4 ink = vec4(0.0);
  float rim = 0.0;
  if (uSimOn.x > 0.5) {
    vec2 at = uv + slope * vec2(0.12 / aspect, 0.12);
    vec2 texel = 1.0 / vec2(textureSize(uSim0, 0));
    float reach = mix(2.8, 1.2, K_edges);
    vec2 dx = vec2(texel.x * reach, 0.0);
    vec2 dy = vec2(0.0, texel.y * reach);
    vec4 c = texture(uSim0, at);
    vec4 b = 0.25 * (texture(uSim0, at + dx) + texture(uSim0, at - dx) + texture(uSim0, at + dy) + texture(uSim0, at - dy));
    ink = mix(b, c, 0.25 + 0.75 * K_edges);
    rim = smoothstep(0.06, 0.4, length(c - b)) * K_edges;
  }
  ink *= keep;
  rim *= keep;
  vec3 inkColor = ink.rgb / max(ink.a, 0.001);

  vec3 col;
  if (print) {
    // The ink soaks into the sheet: its tone and mottling show through, lighter fibres resist it.
    float mottle = fbm(cell / 160.0 + vec2(5.3, 1.7)) - 0.5;
    float fibre = marbleFibre(cell) * K_fibre;
    vec3 paper = MARBLE_PAPER * (1.0 + 0.1 * K_fibre * mottle) + 0.035 * fibre;
    float soak = clamp(ink.a * (1.0 - 0.18 * max(fibre, 0.0)), 0.0, 1.0);
    col = mix(paper, inkColor * (paper / MARBLE_PAPER), soak);
    col *= 1.0 - 0.35 * rim;
  } else {
    vec2 vq = p / vec2(0.5 * aspect, 0.5);
    vec3 water = (rings ? MARBLE_BASIN : MARBLE_SIZE) * (1.0 - 0.18 * dot(vq, vq));
    col = mix(water, inkColor * MARBLE_FLOAT, ink.a);
    col *= 1.0 - 0.35 * rim;
    // The swells catch the light from the window, high on the left.
    col *= 1.0 + 3.0 * dot(slope, vec2(-0.6, 0.8));
    // Sheen: the window mirrored in the wet surface, wobbling with the swell, and its broad glow.
    vec2 r = p - vec2(-0.3 * aspect, 0.27) + slope * 2.5;
    float win = marbleWindow(r);
    float glow = exp(-2.5 * dot(r, r));
    col += K_sheen * (0.09 * win + 0.035 * glow) * vec3(0.86, 0.91, 1.0);
    o.shimmer = 0.12 * K_sheen * win;

    // The stylus or comb: steel pins standing in the size, each with its shadow down-right, a
    // bright meniscus round it and a glint toward the window.
    if (tool.z > 0.001) {
      vec2 m = normalize(toolDir.xy + vec2(1e-5, 0.0));
      vec2 n = vec2(-m.y, m.x);
      vec2 tip = vec2((tool.x - 0.5) * aspect, tool.y - 0.5);
      float spacing = toolDir.z;
      float pinR = 0.0055;
      float d = length(marbleTine(p - tip, m, n, spacing));
      float pin = (1.0 - smoothstep(pinR - 0.0012, pinR + 0.0004, d)) * tool.z;
      float shadow = 1.0 - smoothstep(pinR - 0.001, pinR + 0.004, length(marbleTine(p - tip - vec2(0.0035, -0.0045), m, n, spacing)));
      float meniscus = 1.0 - smoothstep(pinR + 0.0015, pinR + 0.01, d);
      float glint = 1.0 - smoothstep(0.0, 0.6 * pinR, length(marbleTine(p - tip + vec2(0.0018, -0.0018), m, n, spacing)));
      col *= 1.0 - 0.35 * shadow * tool.z;
      col += 0.05 * meniscus * tool.z;
      col = mix(col, vec3(0.34, 0.36, 0.39) + 0.55 * glint, pin);
    }
  }

  float lum = dot(col, LUMA);
  o.rgb = col;
  o.source = col;
  // Paper and the pale basin put the page in its light theme, where ink means dark; on the dark
  // size it means light.
  o.ink = (print || rings) ? clamp((0.9 - lum) / 0.8, 0.0, 1.0) : clamp(1.3 * lum, 0.0, 1.0);
  o.accent = ink.a * (1.0 - smoothstep(0.07, 0.18, distance(inkColor, marbleAccentInk())));
  return o;
}
`;
