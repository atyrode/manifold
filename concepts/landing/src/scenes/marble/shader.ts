// The marbling scene's picture: the tray of size, or the printed paper, under the ink that the sim
// (sim.ts) floats and combs.
//   uSim0  the ink, premultiplied rgba (alpha = cover), top row at uv.y = 1
//   uSim1  texel 0: tool tip (uv), tool shown 0..1, ink veiled 0..1 (lifted off, or not yet faded up)
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
const vec3 MARBLE_FLOAT = vec3(0.8, 0.82, 0.86);     // the cool studio light the floating ink is seen in
const vec3 MARBLE_STEEL = vec3(0.5, 0.53, 0.58);     // the stylus's needle and the comb's pins
const vec3 MARBLE_WOOD = vec3(0.62, 0.44, 0.25);     // the stylus's handle and the comb's spine
const vec2 MARBLE_LIGHT = vec2(-0.6, 0.8);           // toward the studio window, high on the left
const vec2 MARBLE_CAST = vec2(0.45, -0.6);           // how far a shadow falls per unit of height

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

// The size's long swells: three from different directions, each one or two sheets long and twenty
// to thirty seconds round. They only bend the window's reflection (a small, faint area), so the
// dither over the ink holds still between strokes. Returns the slope, dimensionless.
vec2 marbleSwell(vec2 p, float t) {
  vec2 d1 = vec2(0.866, 0.5);
  vec2 d2 = vec2(-0.423, 0.906);
  vec2 d3 = vec2(-0.961, -0.276);
  return d1 * (0.006 * cos(dot(p, d1) * 3.1 - t * 0.21))
    + d2 * (0.005 * cos(dot(p, d2) * 4.3 - t * 0.27 + 1.7))
    + d3 * (0.004 * cos(dot(p, d3) * 5.9 - t * 0.33 + 4.1));
}

// The studio window mirrored in the wet surface: four panes, soft at the edges; r from its centre.
float marbleWindow(vec2 r) {
  vec2 d = abs(r) - vec2(0.22, 0.15);
  float pane = 1.0 - smoothstep(-0.025, 0.02, max(d.x, d.y));
  float bars = smoothstep(0.004, 0.011, min(abs(r.x), abs(r.y)));
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

// Distance across a comb's path folded onto the nearest tine (spacing 0: a single stylus).
float marbleFold(float across, float spacing) {
  return spacing > 0.0 ? across - spacing * floor(across / spacing + 0.5) : across;
}

// The size heaped up ahead of a pin and drawn down into a dimple behind it, travelling with the
// tool: the slope of that rise and fall at q (along the path, across it, from the nearest pin),
// kept narrow enough for a comb's tines, turned back into sheet axes.
vec2 marbleWake(vec2 q, vec2 m, vec2 n, float spacing) {
  float s = spacing > 0.0 ? min(0.014, 0.22 * spacing) : 0.014;
  vec2 a = (q - vec2(0.6 * s, 0.0)) / s;
  vec2 b = (q + vec2(1.4 * s, 0.0)) / (1.3 * s);
  vec2 g = b * (0.09 * exp(-dot(b, b))) - a * (0.14 * exp(-dot(a, a)));
  return g.x * m + g.y * n;
}

// The stylus or comb seen from above, in the frame of the pin nearest p: q = (along the path,
// across it). Steel pins stand in the size with a bright meniscus round them and lean forward into
// the stroke, up to the stylus's wooden handle or the comb's spine, which spans the tray; all of it
// throws a shadow down and right, away from the window. m is the direction of travel, n across it,
// shown the tool's fade, aa a cell in sheet units.
vec3 marbleTool(vec3 col, vec2 q, vec2 m, vec2 n, float spacing, float shown, float aa) {
  bool comb = spacing > 0.0;
  // Seen from above, each rod runs from its pin to its top, lean ahead; the top stands rise high.
  float lean = comb ? 0.032 : 0.09;
  float rise = comb ? 0.03 : 0.06;
  float pinR = comb ? min(0.0075, 0.15 * spacing) : 0.009;
  float rodW = comb ? min(0.004, 0.6 * pinR) : 0.005;
  float woodW = comb ? 0.0065 : 0.009;
  float woodFrom = comb ? lean : 0.4 * lean; // the stylus's handle starts part way up
  vec2 light = vec2(dot(MARBLE_LIGHT, m), dot(MARBLE_LIGHT, n));
  vec2 top = vec2(lean, 0.0);

  // Shadows: each rod's runs from its pin to where its top's lands; take the nearest tine's copy.
  vec2 tail = top + vec2(dot(MARBLE_CAST, m), dot(MARBLE_CAST, n)) * rise;
  vec2 qs = q - 0.5 * tail;
  qs.y = marbleFold(qs.y, spacing);
  qs += 0.5 * tail;
  float rodShadow = segmentDistance(qs, vec2(0.0), tail) - rodW;
  float woodShadow = (comb ? abs(q.x - tail.x) : segmentDistance(qs, tail * (woodFrom / lean), tail)) - woodW;
  float shadow = 1.0 - smoothstep(-aa, 2.5 * aa, min(rodShadow, woodShadow));
  col *= 1.0 - 0.5 * shadow * shown;

  // The meniscus: the size climbing each pin, catching the light.
  float d = length(q);
  col += 0.07 * shown * (1.0 - smoothstep(pinR, pinR + 0.008, d));

  // The rod up to the wood, lit on the side toward the window.
  float rod = 1.0 - smoothstep(rodW - aa, rodW + aa, segmentDistance(q, vec2(0.0), vec2(woodFrom, 0.0)));
  col = mix(col, MARBLE_STEEL * (0.8 + 0.35 * clamp(q.y / rodW, -1.0, 1.0) * light.y), rod * shown);

  // The pin where it enters the size, with a glint toward the window.
  float pin = 1.0 - smoothstep(pinR - aa, pinR + aa, d);
  float glint = 1.0 - smoothstep(0.15 * pinR, 0.6 * pinR, length(q - 0.4 * pinR * light));
  col = mix(col, MARBLE_STEEL * 0.75 + 0.45 * glint, pin * shown);

  // The comb's spine across all its tines, or the stylus's handle; rounded, lit toward the window.
  vec2 side = comb ? vec2(q.x - lean, 0.0) : q - vec2(clamp(q.x, woodFrom, lean), 0.0);
  float wood = 1.0 - smoothstep(woodW - aa, woodW + aa, length(side));
  col = mix(col, MARBLE_WOOD * (0.8 + 0.35 * dot(side / woodW, light)), wood * shown);
  return col;
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
  // Lifting the sheet takes the ink with it; a fresh sheet fades up once it is laid.
  float keep = 1.0 - clamp(tool.w, 0.0, 1.0);

  // The tool, in the tray only, in the frame of its nearest tine: q = (along its path, across).
  bool held = !print && tool.z > 0.001;
  vec2 m = normalize(toolDir.xy + vec2(1e-5, 0.0));
  vec2 n = vec2(-m.y, m.x);
  float spacing = toolDir.z;
  vec2 v = p - vec2((tool.x - 0.5) * aspect, tool.y - 0.5);
  vec2 q = vec2(dot(v, m), marbleFold(dot(v, n), spacing));

  // At rest the tray holds still in value, so the dither holds still: the ink and the size are never
  // shifted or relit. Only the tool's wake catches the light, and the long swells only bend the
  // window's reflection.
  vec2 wake = held ? marbleWake(q, m, n, spacing) * tool.z : vec2(0.0);
  vec2 swell = print ? vec2(0.0) : marbleSwell(p, tm) * (2.0 * K_ripples);

  // A cross of four taps around the ink softens its edges (wider and weighted more as K_edges
  // falls) and finds where colours meet, for the fine dark rim that ink with ox gall draws round
  // itself.
  vec4 ink = vec4(0.0);
  float rim = 0.0;
  if (uSimOn.x > 0.5) {
    vec2 texel = 1.0 / vec2(textureSize(uSim0, 0));
    float reach = mix(2.8, 1.2, K_edges);
    vec2 dx = vec2(texel.x * reach, 0.0);
    vec2 dy = vec2(0.0, texel.y * reach);
    vec4 c = texture(uSim0, uv);
    vec4 b = 0.25 * (texture(uSim0, uv + dx) + texture(uSim0, uv - dx) + texture(uSim0, uv + dy) + texture(uSim0, uv - dy));
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
    // The tool's wake catches the light from the window, high on the left.
    col *= 1.0 + 4.0 * dot(wake, MARBLE_LIGHT);
    // Sheen: the window mirrored in the wet surface, its panes bent a little by the swell and the
    // wake, and its broad, steady glow.
    vec2 r = p - vec2(-0.3 * aspect, 0.27);
    float win = marbleWindow(r + swell * 0.8 + wake * 1.5);
    float glow = exp(-2.5 * dot(r, r));
    col += K_sheen * (0.09 * win + 0.035 * glow) * vec3(0.86, 0.91, 1.0);
    if (held) col = marbleTool(col, q, m, n, spacing, tool.z, 1.0 / uRes.y);
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
