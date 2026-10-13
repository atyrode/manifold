// The hyperbolic tiling's picture. Each pixel's point of the plane (the screen mapped onto the disk
// by the chosen model, then moved by the glide) is folded into one fundamental triangle of the
// {p,q} tiling by mirroring; there the strands, the checkerboard between them and the tile edges
// are a handful of circles. The sim (sim.ts) supplies the glide and the geometry:
//   uSim0  one row of state texels, laid out in HYPERBOLIC_TEXELS (sim.ts)
// Knobs read here: K_tiling, K_model, K_palette, K_breath.
import {
  HYPERBOLIC_DETAIL,
  HYPERBOLIC_PALETTES,
  HYPERBOLIC_SHADE,
  HYPERBOLIC_TEXELS,
  HYPERBOLIC_TILINGS,
  HYPERBOLIC_VIEW,
  hyperbolicFallback,
  tilingOf,
} from "./sim.ts";

const glslFloat = (x: number): string => x.toFixed(6);

/** A CSS hex colour as a GLSL vec3 literal (the pipeline works in display sRGB, as the canvas). */
function glslColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => (c / 255).toFixed(4));
  return `vec3(${channels.join(", ")})`;
}

const tilings = HYPERBOLIC_TILINGS.map((def) => {
  const t = tilingOf(def);
  return `HyperbolicTiling(${glslFloat(t.p)}, ${glslFloat(t.c)}, ${glslFloat(t.r)}, ${glslFloat(t.corner)}, ${t.q % 2 === 0})`;
});
const tilingTable = tilings.map((tiling, i) => `  if (K_tiling < ${i}.5) return ${tiling};`).join("\n");

const palettes = HYPERBOLIC_PALETTES.map((p) => {
  const colors = [p.ground, p.groundAlt, p.groundBreath, p.strand, p.strandBreath, p.ink, p.back, p.glow, p.rim, p.source, p.mark].map(glslColor);
  return `HyperbolicPalette(${colors.join(", ")}, ${glslFloat(p.lamp)}, ${p.paper})`;
});
const paletteTable = palettes.map((palette, i) => `  if (K_palette < ${i}.5) return ${palette};`).join("\n");

const fallback = hyperbolicFallback();
const fallbackTexels = Array.from({ length: fallback.length / 4 }, (_, i) => `vec4(${fallback.slice(i * 4, i * 4 + 4).map(glslFloat).join(", ")})`);

const T = HYPERBOLIC_TEXELS;
const D = HYPERBOLIC_DETAIL;
const S = HYPERBOLIC_SHADE;

export const hyperbolicGlsl = `
const float HYPERBOLIC_DISK = ${glslFloat(HYPERBOLIC_VIEW.disk)};       // the disk's radius, screen heights
const float HYPERBOLIC_BAND = ${glslFloat(HYPERBOLIC_VIEW.band)};       // the band's half-height
const float HYPERBOLIC_HORIZON = ${glslFloat(HYPERBOLIC_VIEW.horizon)}; // the half-plane's horizon below the centre
const float HYPERBOLIC_PLANE = ${glslFloat(HYPERBOLIC_VIEW.plane)};     // half-plane units per screen height
const float HYPERBOLIC_CUSHION = ${glslFloat(S.cushion)};
const float HYPERBOLIC_CUSHION_FALL = ${glslFloat(S.cushionFall)};
const float HYPERBOLIC_LANTERN = ${glslFloat(S.lantern)};
const float HYPERBOLIC_MARK_STROKE = 0.085;  // the M's stroke half-width, in M heights
const float HYPERBOLIC_PULSE_WIDTH = 0.6;    // the light pulse's ring, hyperbolic units
const float HYPERBOLIC_SOURCE_FOCUS = 6.0;   // how tightly the rim's glow gathers where tiles come from
const float HYPERBOLIC_DEPTH = 0.3;          // how far dissolved detail sinks toward the background

struct HyperbolicTiling {
  float p;        // sides of a tile
  float c;        // the circle carrying the edge across the positive real axis: centre (c, 0)...
  float r;        // ...and radius
  float corner;   // a corner's distance from the tile's centre (disk units)
  bool alternate; // an even number of tiles at each corner: neighbours can alternate in two colours
};

HyperbolicTiling hyperbolicTiling() {
${tilingTable}
  return ${tilings[tilings.length - 1] ?? "HyperbolicTiling(7.0, 2.0, 1.7, 0.3, false)"};
}

struct HyperbolicPalette {
  vec3 ground;       // the regions between strands, in two colours...
  vec3 groundAlt;
  vec3 groundBreath; // ...the second breathing toward this
  vec3 strand;
  vec3 strandBreath;
  vec3 ink;          // outlines
  vec3 back;         // beyond the rim
  vec3 glow;         // round the rim (a shadow on paper)
  vec3 rim;
  vec3 source;       // the light where tiles come from, and of the pulse
  vec3 mark;         // the M
  float lamp;        // light at the screen's edges, against 1 in the middle
  bool paper;
};

HyperbolicPalette hyperbolicPalette() {
${paletteTable}
  return ${palettes[palettes.length - 1] ?? "HyperbolicPalette(vec3(0.0), vec3(0.0), vec3(0.0), vec3(1.0), vec3(1.0), vec3(0.0), vec3(0.0), vec3(0.5), vec3(1.0), vec3(1.0), vec3(1.0), 1.0, false)"};
}

// The default tiling at rest, for a frame without the sim.
const vec4 HYPERBOLIC_FALLBACK[${fallbackTexels.length}] = vec4[${fallbackTexels.length}](
  ${fallbackTexels.join(",\n  ")}
);

vec4 hyperbolicState(int i) {
  return uSimOn.x > 0.5 ? texelFetch(uSim0, ivec2(i, 0), 0) : HYPERBOLIC_FALLBACK[i];
}

// A motion (a, b) stored as a coarse texel, exact in half floats, and the fine remainder after it.
vec4 hyperbolicMotion(int i) {
  return hyperbolicState(i) + hyperbolicState(i + 1);
}

vec2 hyperbolicMul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 hyperbolicDiv(vec2 a, vec2 b) {
  return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b);
}

// z -> (a z + b) / (conj(b) z + conj(a)), m = (a, b): a motion of the plane seen in the disk.
vec2 hyperbolicMove(vec4 m, vec2 z) {
  return hyperbolicDiv(hyperbolicMul(m.xy, z) + m.zw, hyperbolicMul(vec2(m.z, -m.w), z) + vec2(m.x, -m.y));
}

struct HyperbolicView {
  vec2 z;     // the point of the disk shown here (past the rim: its mirror image, for the glow)
  float cell; // hyperbolic length of one cell here
  float edge; // screen heights out past the rim (negative inside)
};

// The three maps of the plane: the Poincare disk; the band, z = tanh(zeta) over the strip
// |Im zeta| < pi/4; the upper half-plane w, z = (w - i) / (w + i). All conformal, so a cell's
// hyperbolic size is one number.
HyperbolicView hyperbolicView(vec2 q, float aspect) {
  HyperbolicView v;
  float cell = 1.0 / uRes.y;
  if (K_model < 0.5) {
    float radius = HYPERBOLIC_DISK * min(1.0, aspect);
    v.z = q / radius;
    v.cell = 2.0 * cell / (radius * max(1.0 - dot(v.z, v.z), 1e-6));
    v.edge = length(q) - radius;
  } else if (K_model < 1.5) {
    float k = 0.785398 / HYPERBOLIC_BAND;
    vec2 zeta = q * k;
    v.z = vec2(sinh(2.0 * zeta.x), sin(2.0 * zeta.y)) / (cosh(2.0 * zeta.x) + cos(2.0 * zeta.y));
    v.cell = 2.0 * k * cell / max(cos(2.0 * zeta.y), 1e-6);
    v.edge = abs(q.y) - HYPERBOLIC_BAND;
  } else {
    vec2 w = vec2(q.x, q.y + HYPERBOLIC_HORIZON) * HYPERBOLIC_PLANE;
    v.z = hyperbolicDiv(w - vec2(0.0, 1.0), w + vec2(0.0, 1.0));
    v.cell = HYPERBOLIC_PLANE * cell / max(w.y, 1e-6);
    v.edge = -(q.y + HYPERBOLIC_HORIZON);
  }
  return v;
}

struct HyperbolicFold {
  vec2 x;       // the point, in the wedge 0 <= arg <= pi/p of the central tile
  float parity; // mirrors crossed: odd turns the picture over
  float edges;  // tile edges crossed: odd lands on the other colour where tiles alternate
};

// Turn into the sector of the edge across the real axis, mirror into its upper half, and if the
// point lies beyond that edge, mirror it across (an inversion in the edge's circle). Each pass
// brings it about one tile nearer, so 32 passes reach some twenty tiles out: far past where the
// detail has dissolved and the fold is skipped. Most pixels stop within a few passes.
HyperbolicFold hyperbolicFold(vec2 w, HyperbolicTiling g) {
  HyperbolicFold f;
  f.parity = 0.0;
  f.edges = 0.0;
  float sector = TAU / g.p;
  vec2 centre = vec2(g.c, 0.0);
  float r2 = g.r * g.r;
  for (int i = 0; i < 32; i++) {
    w = rotate(w, -sector * floor(atan(w.y, w.x) / sector + 0.5));
    if (w.y < 0.0) {
      w.y = -w.y;
      f.parity += 1.0;
    }
    vec2 d = w - centre;
    float d2 = dot(d, d);
    if (d2 >= r2) break;
    w = centre + d * (r2 / d2);
    f.parity += 1.0;
    f.edges += 1.0;
  }
  f.x = w;
  return f;
}

struct HyperbolicStrands {
  float closest; // signed distance to the nearest strand's centre line (negative in its cap)
  float second;  // and to the next nearest
  float turn;    // which way the nearest strand's normal turns onto the next one's
  float checker; // 0/1: the two colours of the regions between strands
};

// The tile's p strands are rotated copies of one circle (centre s along the bisector at angle
// k pi / p, radius rho; side: +1 when the cap it cuts off lies inside it). The regions between
// them alternate in colour with every strand crossed: count the caps the point lies in.
HyperbolicStrands hyperbolicStrands(vec2 x, float p, float k, float s, float rho, float side) {
  HyperbolicStrands st;
  st.closest = 1e3;
  st.second = 1e3;
  st.checker = 0.0;
  vec2 closestNormal = vec2(1.0, 0.0);
  vec2 secondNormal = vec2(0.0, 1.0);
  float sector = TAU / p;
  vec2 o = s * vec2(cos(0.5 * k * sector), sin(0.5 * k * sector));
  vec2 turnStep = vec2(cos(sector), sin(sector));
  for (int j = 0; j < 8; j++) {
    if (float(j) > p - 0.5) break;
    vec2 d = x - o;
    float len = max(length(d), 1e-6);
    float g = (len - rho) * side;
    if (g < 0.0) st.checker = 1.0 - st.checker;
    vec2 n = d * (side / len);
    if (abs(g) < abs(st.closest)) {
      st.second = st.closest;
      secondNormal = closestNormal;
      st.closest = g;
      closestNormal = n;
    } else if (abs(g) < abs(st.second)) {
      st.second = g;
      secondNormal = n;
    }
    o = vec2(turnStep.x * o.x - turnStep.y * o.y, turnStep.y * o.x + turnStep.x * o.y);
  }
  st.turn = sign(closestNormal.x * secondNormal.y - closestNormal.y * secondNormal.x);
  return st;
}

// Coverage of a band of the given half-width round a centre line 'gap' away. The edge is
// antialiased over aa, then cut against this cell's own threshold, its grain: the edge keeps its
// smoothness as a dither pattern, and as it slides past, each cell flips just once.
float hyperbolicCover(float halfWidth, float gap, float aa, float grain) {
  return step(grain, 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(gap)));
}

Shade sceneHyperbolic(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  HyperbolicPalette pal = hyperbolicPalette();
  HyperbolicView view = hyperbolicView(q, aspect);
  float grain = bayer4(cell + vec2(2.0, 1.0)) * 0.9375 + 0.03125;

  // The palette breathes: the second ground and the strands drift between neighbouring shades.
  vec4 breath = hyperbolicState(${T.breath});
  vec3 ground = pal.ground;
  vec3 groundAlt = mix(pal.groundAlt, pal.groundBreath, K_breath * (0.5 + 0.5 * breath.x));
  vec3 strandColor = mix(pal.strand, pal.strandBreath, K_breath * (0.5 + 0.5 * breath.y));

  // The rim glows brightest, and warmest, where the tiles come from.
  vec4 source = hyperbolicState(${T.source});
  vec2 heading = view.z / max(length(view.z), 1e-6);
  float toward = source.z * exp(-HYPERBOLIC_SOURCE_FOCUS * (1.0 - dot(heading, source.xy)));

  vec3 col;
  float accent = 0.0;
  if (view.edge > 0.0) {
    float halo = (0.5 * exp(-view.edge / 0.012) + 0.22 * exp(-view.edge / 0.07)) * (1.0 + 0.8 * toward);
    col = mix(pal.back, mix(pal.glow, pal.source, toward), clamp(halo, 0.0, 1.0));
    accent = 0.6 * toward * exp(-view.edge / 0.03);
  } else {
    HyperbolicTiling g = hyperbolicTiling();
    vec4 strand = hyperbolicState(${T.strand});   // edges spanned (0: lattice), cap side, half-widths
    vec4 average = hyperbolicState(${T.average}); // weights of ground, alternate ground, ink, strand
    vec4 scale = hyperbolicState(${T.scale});     // spacing between strands, the M's glow
    vec4 flow = hyperbolicState(${T.flow});       // the glide's velocity: turn, push

    // Toward the rim tiles shrink without end, and however slow the glide is in the middle they
    // sweep past ever faster. Detail dissolves before it can shimmer: where it gets too fine for
    // the cells (strands first, then the regions between them), and, like motion blur, where the
    // glide carries it past too quickly. The plane's velocity here is
    // dz/dt = push + 2i turn z - conj(push) z^2, measured in hyperbolic units.
    vec2 dz = flow.yz + 2.0 * flow.x * vec2(-view.z.y, view.z.x) - hyperbolicMul(vec2(flow.y, -flow.z), hyperbolicMul(view.z, view.z));
    float sweep = 2.0 * length(dz) / max(1.0 - dot(view.z, view.z), 1e-6);
    float motionDetail = 1.0 - smoothstep(${glslFloat(D.motionFrom)}, ${glslFloat(D.motionTo)}, sweep / scale.x);
    float groundDetail = (1.0 - smoothstep(${glslFloat(D.groundFrom)}, ${glslFloat(D.groundTo)}, view.cell / scale.x)) * motionDetail;
    float strandDetail = (1.0 - smoothstep(${glslFloat(D.strandFrom)}, ${glslFloat(D.strandTo)}, view.cell / (2.0 * strand.w))) * motionDetail;
    // A strand's outline thins away first, leaving ground where it was.
    float outlineDetail = smoothstep(${glslFloat(D.outlineTo)}, ${glslFloat(D.outlineFrom)}, (strand.w - strand.z) / view.cell);
    float outlineWidth = mix(strand.z, strand.w, outlineDetail);
    float inked = average.z * outlineDetail;
    float cover = inked + average.w;
    vec3 veil = (inked * pal.ink + average.w * strandColor) / max(cover, 1e-4);
    // What detail dissolves into: the tile's average colour, dimmed a little toward the
    // background, so the countless tiles crowding the rim read as an even, slightly hazy texture.
    vec3 even = average.x * ground + average.y * groundAlt + average.z * pal.ink + average.w * strandColor;
    even = mix(even, pal.back, HYPERBOLIC_DEPTH);
    float fill = 0.0;
    col = even;
    if (groundDetail > 0.0) {
      HyperbolicFold f = hyperbolicFold(hyperbolicMove(hyperbolicMotion(${T.motion}), view.z), g);
      vec2 x = f.x;
      float eu = 0.5 * (1.0 - dot(x, x)); // disk units per hyperbolic unit at x
      float aa = 0.5 * view.cell * eu;    // half a cell
      float body = strand.z * eu;
      float outline = outlineWidth * eu;
      float rel = length(x) / g.corner;
      float cushion = HYPERBOLIC_CUSHION - HYPERBOLIC_CUSHION_FALL * rel * rel;
      vec3 base;
      vec3 detail;
      if (strand.x < 0.5) {
        // The lattice: the tiles' edges, the tiles in two colours where they can alternate, or lit
        // from the middle like lanterns where an odd number meet at each corner.
        float tone = g.alternate ? mod(f.edges + breath.z, 2.0) : clamp(1.0 - HYPERBOLIC_LANTERN * rel * rel, 0.0, 1.0);
        base = mix(ground, groundAlt, tone) * cushion;
        float gap = length(x - vec2(g.c, 0.0)) - g.r;
        detail = mix(base, pal.ink, hyperbolicCover(outline, gap, aa, grain));
        fill = hyperbolicCover(body, gap, aa, grain);
        detail = mix(detail, strandColor, fill);
      } else {
        vec4 arc = hyperbolicState(${T.arc});
        HyperbolicStrands st = hyperbolicStrands(x, g.p, strand.x, arc.x + arc.y, arc.z + arc.w, strand.y);
        base = mix(ground, groundAlt, st.checker) * cushion;
        // Over or under: turning the nearer strand anticlockwise onto the other sweeps two opposite
        // regions; it goes over where they are the alternate colour. Regions alternate round every
        // crossing, so each strand goes over, under, over all the way along; a mirrored tile turns
        // the other way, and swaps.
        float swept = st.turn * st.closest * st.second < 0.0 ? st.checker : 1.0 - st.checker;
        bool closestOver = mod(swept + f.parity, 2.0) > 0.5;
        float top = closestOver ? st.closest : st.second;
        float below = closestOver ? st.second : st.closest;
        // The strand underneath dips into the shadow of the one on top.
        float shadow = 1.0 - smoothstep(outline, outline + 2.5 * body, abs(top));
        float under = hyperbolicCover(body, below, aa, grain);
        float over = hyperbolicCover(body, top, aa, grain);
        detail = mix(base, pal.ink, hyperbolicCover(outline, below, aa, grain));
        detail = mix(detail, strandColor * (1.0 - 0.45 * shadow), under);
        detail = mix(detail, pal.ink, hyperbolicCover(outline, top, aa, grain));
        detail = mix(detail, strandColor, over);
        fill = max(under, over);
      }
      col = mix(even, mix(mix(base, veil, cover), detail, strandDetail), groundDetail);
      fill *= strandDetail * groundDetail;
    }

    // The M, inlaid in the one tile that carries it, outlined like the strands, in a pool of light.
    if (source.w > 0.001) {
      vec2 local = hyperbolicMove(hyperbolicMotion(${T.mark}), view.z);
      float r = length(local);
      if (r < g.corner) {
        float h = breath.w;
        float eul = 0.5 * (1.0 - r * r);
        float aal = 0.5 * view.cell * eul;
        float d = markDistance(local / (2.0 * h)) * 2.0 * h;
        float stroke = HYPERBOLIC_MARK_STROKE * 2.0 * h;
        float rimmed = stroke + (outlineWidth - strand.z) * eul;
        float seen = source.w * (1.0 - smoothstep(${glslFloat(D.markFrom)}, ${glslFloat(D.markTo)}, view.cell));
        float halo = scale.y * seen * exp(-max(d - stroke, 0.0) / (0.5 * h)) * (1.0 - smoothstep(0.6 * g.corner, g.corner, r));
        col = mix(col, pal.mark, 0.4 * halo);
        col = mix(col, pal.ink, hyperbolicCover(rimmed, d, aal, grain) * seen);
        float letter = hyperbolicCover(stroke, d, aal, grain) * seen;
        col = mix(col, pal.mark, letter);
        accent = max(letter, 0.4 * halo);
        fill *= 1.0 - letter;
      }
    }

    // The light pulse: a ring a steady hyperbolic distance from where it started, so on screen it
    // slows as it spreads toward the rim. It lights the strands most.
    vec4 pulse = hyperbolicState(${T.pulse});
    if (pulse.w > 0.001) {
      vec2 c = pulse.xy;
      float chord = length(view.z - c) / max(length(vec2(1.0, 0.0) - hyperbolicMul(vec2(c.x, -c.y), view.z)), 1e-6);
      float u = (2.0 * atanh(min(chord, 0.999999)) - pulse.z) / HYPERBOLIC_PULSE_WIDTH;
      float ring = pulse.w * exp(-u * u);
      col = pal.paper ? mix(col, col * pal.source, 0.45 * ring) : col + ring * pal.source * (0.05 + 0.3 * fill);
    }

    col *= mix(pal.lamp, 1.04, exp(-dot(q, q) / 0.16));
    // The rim itself: a fine line of light (of ink, on paper).
    float rim = exp(view.edge / 0.008);
    col = mix(col, mix(pal.rim, pal.source, toward), 0.55 * rim);
    accent = max(accent, 0.5 * toward * rim);
  }

  float lum = dot(col, LUMA);
  o.rgb = col;
  o.source = col;
  o.ink = pal.paper ? clamp((0.92 - lum) / 0.8, 0.0, 1.0) : clamp(1.25 * lum, 0.0, 1.0);
  o.accent = accent;
  return o;
}
`;
