// The fractal scene's picture. Four fractals share one visual language, so every palette and knob
// means the same in each:
//   ripples  level lines of a potential: equipotentials round the Julia and Mandelbrot sets, rings
//            inside each Apollonian circle, raked rings round each stone of the Newton garden
//   rays     the family crossing them at right angles: field lines, the hyperbolic tiling inside
//            each circle, spokes round each stone
//   edge     the fractal's own outline, drawn at a constant width from a distance estimate
//   gild     orbit traps: wherever an orbit passes a small disc (pearls) or circle (lace), that
//            shape is drawn pulled back through the iteration; the gasket gilds its kissing points
//   mark     the Manifold M as an orbit trap: an M in every circle, or echoes of one round the set
// Every line is drawn from the derivative of its map, so it keeps a set width in cells at any
// depth, and line families fade out before they crowd closer than the dither can hold. Moving
// detail is smeared along its motion (sim.ts sends how fast things move; the shader turns that into
// cells per second here): a line that would flash a cell on and off widens and pales instead,
// keeping its ink.
//
// uSim0 is the sim's state row (layout in sim.ts). Knobs read here: K_palette, K_lines, K_glow,
// K_ripples, K_rays, K_filigree, K_trap.
import { FRACTAL_GLOBAL_TEXELS, FRACTAL_LAYER_TEXELS } from "./sim.ts";

interface FractalPalette {
  label: string;
  /** A light ground: the page takes its paper theme, and ink means dark. */
  paper: boolean;
  /** The ground; the halo round the set (and a disc's or basin's tint); ripples and rays outside. */
  bg: string;
  glow: string;
  line: string;
  /** The outline; inside the set and the stones, dark and lit; ripples and rays inside. */
  edge: string;
  body: string;
  lit: string;
  bodyLine: string;
  /** The filigree, and the M. */
  gild: string;
  seal: string;
}

/** The `palette` knob's values, in order. */
export const fractalPalettes: readonly FractalPalette[] = [
  // Moonlit: silver lines on a night-blue ground, pale gold pearls, a gold M.
  { label: "moonlit", paper: false, bg: "#060a16", glow: "#1f335c", line: "#7394c2", edge: "#dfe9f8", body: "#070c18", lit: "#1b2d52", bodyLine: "#5874a6", gild: "#efcd82", seal: "#ffd277" },
  // Gilt: gold on black lacquer, as maki-e, with a vermilion M.
  { label: "gilt", paper: false, bg: "#070504", glow: "#3a2610", line: "#9a7434", edge: "#f6d98e", body: "#050302", lit: "#2a1b0a", bodyLine: "#8a6a32", gild: "#ffe2a0", seal: "#d0482c" },
  // Sumi: ink on paper, ochre-gold filigree, a cinnabar seal for the M.
  { label: "sumi", paper: true, bg: "#ece6d8", glow: "#cfc6b4", line: "#8f877a", edge: "#1a1918", body: "#2b2927", lit: "#5a5650", bodyLine: "#9d968a", gild: "#b08636", seal: "#c0392b" },
  // Porcelain: cobalt on white glaze, gilded.
  { label: "porcelain", paper: true, bg: "#eef1f5", glow: "#c9d6ec", line: "#7d95c8", edge: "#14307a", body: "#1d3b8c", lit: "#4a68b8", bodyLine: "#a9bbe3", gild: "#c49a3c", seal: "#a8741e" },
];

/** A CSS hex colour as a GLSL vec3 literal (the pipeline works in display sRGB, as the canvas). */
function glslColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => (c / 255).toFixed(4));
  return `vec3(${channels.join(", ")})`;
}

const inks = fractalPalettes
  .map((p, i) => {
    const colours = [p.bg, p.glow, p.line, p.edge, p.body, p.lit, p.bodyLine, p.gild, p.seal].map(glslColor).join(", ");
    return `  if (K_palette < ${i}.5) return FractalInk(${colours}, ${p.paper ? "1.0" : "0.0"});`;
  })
  .join("\n");

export const fractalGlsl = `
const int FRACTAL_GLOBAL = ${FRACTAL_GLOBAL_TEXELS};
const int FRACTAL_LAYER = ${FRACTAL_LAYER_TEXELS};
// Iteration ceiling for the escape-time loops. Fractals need more than the usual 32: the sim sends
// 44..128 for Julia sets and 32..128 for the dive (growing with depth: an island of period p needs p
// times the iterations of the whole set), and every loop stops early on escape, on settling into
// an attracting cycle, or (the dive) inside a known cardioid. The gasket's folding stops at 64,
// usually after a handful; Newton's method at 40, usually after a few.
const int FRACTAL_ITER_CAP = 128;
// Orbit traps (pearls, lace, the M) are tested on the first iterations only: later copies are
// smaller than a cell anyway.
const int FRACTAL_TRAP_ITER = 16;
// |z|^2 beyond which an orbit has escaped: large, so the escape time and field lines run smooth.
const float FRACTAL_BAIL = 4096.0;
const float FRACTAL_LN2 = 0.6931472;
// Seconds of travel a moving feature is smeared over (it then never crosses a cell faster than the
// dither can follow).
const float FRACTAL_SMEAR = 0.7;
// Newton's method has converged within this many z units of a stone.
const float FRACTAL_NEWTON_TOL = 0.002;

struct FractalInk {
  vec3 bg;
  vec3 glow;
  vec3 line;
  vec3 edge;
  vec3 body;
  vec3 lit;
  vec3 bodyLine;
  vec3 gild;
  vec3 seal;
  float paper;
};

FractalInk fractalInk() {
${inks}
  return FractalInk(vec3(0.0), vec3(0.2), vec3(0.5), vec3(1.0), vec3(0.0), vec3(0.2), vec3(0.4), vec3(1.0, 0.8, 0.4), vec3(1.0, 0.8, 0.4), 0.0);
}

// What a layer drew at a pixel, as coverages (0..1) the palette turns into colour.
struct FractalSample {
  float wash;   // the halo near the set; a circle's or basin's tint
  float shade;  // a stone's shadow on the sand
  float body;   // inside the set; on a stone
  float lit;    // how lit the body is
  float sheen;  // light caught on a stone's rim
  float ripple; // ripple lines
  float ray;    // ray lines
  float edge;   // the outline (or the garden's braided boundary)
  float gild;   // filigree
  float mark;   // the M
};

FractalSample fractalBlank() {
  return FractalSample(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
}

FractalSample fractalMix(FractalSample a, FractalSample b, float t) {
  return FractalSample(
    mix(a.wash, b.wash, t), mix(a.shade, b.shade, t), mix(a.body, b.body, t), mix(a.lit, b.lit, t),
    mix(a.sheen, b.sheen, t), mix(a.ripple, b.ripple, t), mix(a.ray, b.ray, t), mix(a.edge, b.edge, t),
    mix(a.gild, b.gild, t), mix(a.mark, b.mark, t));
}

vec4 fractalTexel(int i) {
  return texelFetch(uSim0, ivec2(i, 0), 0);
}

vec2 fractalMul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 fractalDiv(vec2 a, vec2 b) {
  return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / max(dot(b, b), 1e-30);
}

// Principal square root.
vec2 fractalSqrt(vec2 a) {
  float r = length(a);
  float im = sqrt(max(0.5 * (r - a.x), 0.0));
  return vec2(sqrt(max(0.5 * (r + a.x), 0.0)), a.y < 0.0 ? -im : im);
}

// Cells a feature moving at speed cells per second is smeared over.
float fractalBlur(float speed) {
  return min(FRACTAL_SMEAR * speed, 24.0);
}

// Coverage of a line whose middle is d cells away, w cells wide, smeared by blur cells: it widens
// and pales in step, keeping its ink.
float fractalLine(float d, float w, float blur) {
  float reach = 0.5 * w + blur;
  return (1.0 - smoothstep(reach - 0.6, reach + 0.6, d)) * (0.5 * w + 0.6) / (reach + 0.6);
}

// A family of lines spacing cells apart fades out before it crowds into grey shimmer.
float fractalRoom(float spacing, float blur) {
  return smoothstep(4.0, 10.0, spacing - 2.0 * blur);
}

// Distance in cells to the nearest of a family of level lines: value in units of the family's
// step, gradient = cells per unit step.
float fractalLevel(float value, float cellsPerStep) {
  float f = fract(value);
  return min(f, 1.0 - f) * cellsPerStep;
}

float fractalEdgeWidth() {
  return mix(0.7, 3.2, K_lines);
}

float fractalFineWidth() {
  return mix(0.6, 1.5, K_lines);
}

// An orbit trap seen through the iteration: when the orbit first comes within about 1.8 radii of
// the trap's centre, the disc (pearls) or circle (lace) of trap (centre, pearl radius, lace
// radius) there is drawn pulled back to the screen, where zCell z units span one cell. Only the
// first visit counts (fading smoothly across the visiting radius, so the choice of visit never
// jumps): an orbit settling onto a cycle through the trap would otherwise gild its whole basin;
// this way every chamber gets one pearl at its heart. Copies smaller than a few cells fade rather
// than fizz.
float fractalTrap(vec2 z, float zCell, vec4 trap, float blur, inout float fresh) {
  if (fresh < 0.001) return 0.0;
  bool lace = K_trap > 0.5;
  float r = lace ? trap.w : trap.z;
  float reach = length(z - trap.xy);
  float weight = fresh;
  fresh *= smoothstep(1.4 * r, 2.2 * r, reach);
  float size = r / zCell;
  if (reach > 2.2 * r || size < 2.0) return 0.0;
  float d = (reach - r) / zCell;
  float cover = lace ? fractalLine(abs(d), 1.2, blur) : 1.0 - smoothstep(-0.6 - blur, 0.6 + blur, d);
  return weight * cover * smoothstep(2.0, 6.0, size);
}

// The M as an orbit trap (mark: centre, size, turn), pulled back the same way. The strokes grow
// with the copy; only copies standing within about 60 degrees of upright are drawn, since the
// iteration turns as many over (z and -z share an orbit) and an M upside down reads as a W.
float fractalMarkTrap(vec2 z, vec2 dz, float zCell, vec4 mark, float blur) {
  vec2 q = rotate(z - mark.xy, -mark.w) / mark.z;
  if (max(abs(q.x), abs(q.y)) > 0.75) return 0.0;
  float size = mark.z / zCell;
  if (size < 6.0) return 0.0;
  float w = clamp(0.07 * size, 0.8, 4.0);
  vec2 heading = dz / max(length(dz), 1e-30);
  float upright = smoothstep(0.4, 0.75, dot(heading, vec2(cos(mark.w), sin(mark.w))));
  return fractalLine(markDistance(q) * size, w, blur) * smoothstep(6.0, 14.0, size) * upright;
}

// Outside an escape-time set: z escaped after n steps, dzl = |dz_n/dp| per content unit. The
// smooth escape time nu has the equipotentials as level lines (ripples); where z_n points along
// the axes are the field lines (rays); 0.5 |z| log|z| / |dz| is the distance to the set.
void fractalOutside(inout FractalSample o, vec2 z, float m2, int n, float dzl, float cell, float blur, float phase) {
  float r = sqrt(m2);
  float lz = log(r);
  float nu = float(n) + 1.0 - log2(lz);
  float band = r * lz * FRACTAL_LN2 / (dzl * cell);
  float de = 0.5 * r * lz / (dzl * cell);
  o.wash = exp(-de * cell / (0.03 + 0.17 * K_glow));
  o.body = 1.0 - smoothstep(0.0, 1.2 + blur, de);
  float w = fractalEdgeWidth();
  // Smeared, the outline thins out faster than its ink would spread: a moving edge goes quiet
  // rather than fogging the dense filaments round it.
  o.edge = (1.0 - smoothstep(w - 0.6 + blur, w + 0.6 + 2.0 * blur, de)) * pow((w + 0.6) / (w + 0.6 + blur), 1.6);
  float fine = fractalFineWidth();
  o.ripple = fractalLine(fractalLevel(nu - phase, band), fine, blur) * fractalRoom(band, blur);
  float spacing = 0.25 * TAU * r / (dzl * cell);
  o.ray = fractalLine(fractalLevel(atan(z.y, z.x) * (4.0 / TAU), spacing), fine, blur) * fractalRoom(spacing, blur);
}

// Julia sets of z^2 + c, c walking the edge of the Mandelbrot set (sim.ts). Inside, when c lies
// in the main cardioid, every orbit settles on the fixed point alpha with multiplier mu, and the
// Koenigs coordinate kappa = (z_n - alpha)/mu^n lays a polar grid of rings and spokes into every
// chamber of the filled set. Motion: the pattern at a pixel shifts by (dz_n/dc)/(dz_n/dz_0) per
// unit of c.
FractalSample fractalJulia(vec2 p, int at, float markOn) {
  FractalSample o = fractalBlank();
  vec4 head = fractalTexel(at);
  vec4 walk = fractalTexel(at + 1);
  vec4 fixedPoint = fractalTexel(at + 2);
  float grid = fractalTexel(at + 3).x;
  vec4 trap = fractalTexel(at + 10);
  vec4 mark = fractalTexel(at + 11);
  int iterations = int(head.y);
  float reach = head.w;
  float cell = 2.0 / uRes.y;
  vec2 c = walk.xy;
  vec2 alpha = fixedPoint.xy;
  float cMove = length(walk.zw) / (reach * cell);

  vec2 z = p * reach;
  vec2 dz = vec2(1.0, 0.0);
  vec2 dc = vec2(0.0);
  vec2 saved = z;
  int nextSave = 8;
  float m2 = dot(z, z);
  int n = 0;
  bool escaped = false;
  float fresh = 1.0;
  for (int i = 0; i < FRACTAL_ITER_CAP; i++) {
    if (i >= iterations) break;
    dc = 2.0 * fractalMul(z, dc) + vec2(1.0, 0.0);
    dz = 2.0 * fractalMul(z, dz);
    z = fractalMul(z, z) + c;
    n = i + 1;
    m2 = dot(z, z);
    if (i < FRACTAL_TRAP_ITER) {
      float dzLength = length(dz);
      float zCell = dzLength * reach * cell;
      float blur = fractalBlur(cMove * length(dc) / dzLength);
      o.gild = max(o.gild, fractalTrap(z, zCell, trap, blur, fresh));
      if (markOn > 0.0) o.mark = max(o.mark, fractalMarkTrap(z, dz, zCell, mark, blur));
    }
    if (m2 > FRACTAL_BAIL) {
      escaped = true;
      break;
    }
    vec2 toAlpha = z - alpha;
    if (grid > 0.0 && dot(toAlpha, toAlpha) < 1e-8) break;
    vec2 drift = z - saved;
    if (dot(drift, drift) < 1e-10) break;
    if (n == nextSave) {
      saved = z;
      nextSave *= 2;
    }
  }

  float dzLength = max(length(dz), 1e-30);
  float dzl = dzLength * reach;
  float blur = fractalBlur(cMove * length(dc) / dzLength);
  if (escaped) {
    fractalOutside(o, z, m2, n, dzl, cell, blur, head.z);
  } else {
    o.body = 1.0;
    o.lit = 0.3;
    vec2 w = z - alpha;
    float lw = max(length(w), 1e-30);
    float settled = grid * (1.0 - smoothstep(0.02, 0.08, lw));
    if (settled > 0.0) {
      vec2 mu = fixedPoint.zw;
      float logKappa = log(lw) - float(n) * log(length(mu));
      float argKappa = atan(w.y, w.x) - float(n) * atan(mu.y, mu.x);
      float cellsPerLog = lw / (dzl * cell);
      float fine = fractalFineWidth();
      float ringStep = 0.8 * cellsPerLog;
      o.ripple = settled * fractalLine(fractalLevel(logKappa / 0.8 - head.z, ringStep), fine, blur) * fractalRoom(ringStep, blur);
      float spokeStep = (TAU / 6.0) * cellsPerLog;
      o.ray = settled * fractalLine(fractalLevel(argKappa * (6.0 / TAU), spokeStep), fine, blur) * fractalRoom(spokeStep, blur);
      o.lit = mix(0.3, 0.15 + 0.7 * smoothstep(-5.0, 0.5, logKappa), settled);
    }
  }
  // The pearls melt while c travels between stations (the chambers they sit in are being torn and
  // re-formed) and gather again once it rests; the breath alone leaves them be.
  o.gild *= 1.0 - smoothstep(0.005, 0.012, length(walk.zw));
  o.mark *= markOn;
  return o;
}

// The multiplier mu of the attracting cycle for c in the main cardioid (mu = 1 - sqrt(1 - 4c)) or
// the period-2 bulb (mu = 4(c + 1)): xy = mu, z = |dmu/dc|; |mu| > 1 outside both.
vec3 fractalMultiplier(vec2 c) {
  vec2 root = fractalSqrt(vec2(1.0, 0.0) - 4.0 * c);
  vec2 cardioid = vec2(1.0, 0.0) - root;
  if (dot(cardioid, cardioid) < 1.0) return vec3(cardioid, 2.0 / max(length(root), 1e-6));
  vec2 bulb = 4.0 * (c + vec2(1.0, 0.0));
  if (dot(bulb, bulb) < 1.0) return vec3(bulb, 4.0);
  return vec3(2.0, 0.0, 0.0);
}

// The polar grid of a hyperbolic component, from its multiplier m (xy = mu, z = |dmu/dp| per
// content unit): rings of |mu| and the internal rays, which land on the bulbs' roots.
void fractalComponent(inout FractalSample o, vec3 m, float cell, float blur) {
  float radius = length(m.xy);
  float cellsPerMu = 1.0 / max(m.z * cell, 1e-30);
  float fine = fractalFineWidth();
  float ringStep = 0.25 * cellsPerMu;
  o.ripple = fractalLine(fractalLevel(radius * 4.0, ringStep), fine, blur) * fractalRoom(ringStep, blur);
  float spokeStep = (TAU / 12.0) * radius * cellsPerMu;
  o.ray = fractalLine(fractalLevel(atan(m.y, m.x) * (12.0 / TAU), spokeStep), fine, blur) * fractalRoom(spokeStep, blur);
  o.lit = 0.1 + 0.6 * radius * radius;
}

// The Mandelbrot dive (sim.ts): delta c = A + B p is this pixel's offset from the island's
// nucleus c0, whose orbit is periodic, so the reference orbit Z runs alongside in float32 and the
// pixel's orbit is carried as its offset d from it: d' = d (2Z + d) + delta c. That keeps the
// precision of delta c at any depth. When the orbit comes nearer 0 than its offset, carry on from
// the orbit itself against the reference's start (rebasing), so the offset stays small.
FractalSample fractalDive(vec2 p, int at, float markOn) {
  FractalSample o = fractalBlank();
  vec4 head = fractalTexel(at);
  vec4 view = fractalTexel(at + 1);
  vec4 stride = fractalTexel(at + 2);
  vec4 focus = fractalTexel(at + 3);
  vec4 trap = fractalTexel(at + 10);
  vec4 mark = fractalTexel(at + 11);
  float cell = 2.0 / uRes.y;
  vec2 c0 = view.xy;
  vec2 delta = view.zw + fractalMul(stride.xy, p);
  float blur = fractalBlur(length(p - focus.xy) * head.w / cell);

  // Known interior: the main cardioid and 2-bulb, and the island's own (c' = delta c / sigma, as
  // the island is c0 + sigma M). Its orbits never escape, so they only run long enough for the traps.
  vec3 m0 = fractalMultiplier(c0 + delta);
  vec3 m1 = fractalMultiplier(fractalDiv(delta, stride.zw));
  bool known = dot(m0.xy, m0.xy) < 0.94 || dot(m1.xy, m1.xy) < 0.8;
  int iterations = known ? FRACTAL_TRAP_ITER : int(head.y);

  vec2 ref = vec2(0.0);
  vec2 d = vec2(0.0);
  vec2 z = vec2(0.0);
  vec2 dz = vec2(0.0);
  vec2 saved = vec2(0.0);
  int nextSave = 8;
  float m2 = 0.0;
  int n = 0;
  bool escaped = false;
  float fresh = 1.0;
  for (int i = 0; i < FRACTAL_ITER_CAP; i++) {
    if (i >= iterations) break;
    dz = 2.0 * fractalMul(z, dz) + stride.xy;
    d = fractalMul(d, 2.0 * ref + d) + delta;
    ref = fractalMul(ref, ref) + c0;
    z = ref + d;
    n = i + 1;
    m2 = dot(z, z);
    if (i < FRACTAL_TRAP_ITER) {
      float zCell = length(dz) * cell;
      // Near the island its orbits pass the trap once a period (p, then p^2 at the island within
      // it), each time as if from a whole set shrunk by the island's slope: shrink the trap alike,
      // so its pearl is to the island what the main pearl is to the set, and the loop's end
      // matches its start.
      float level = floor(log(float(n)) / log(focus.w) + 0.001);
      vec4 levelTrap = vec4(trap.xy, trap.zw * pow(focus.z, -level));
      o.gild = max(o.gild, fractalTrap(z, zCell, levelTrap, blur, fresh));
      // z_1 = c: the first copy of the M would just be the M itself, so its echoes start at z_2.
      if (markOn > 0.0 && i > 0) o.mark = max(o.mark, fractalMarkTrap(z, dz, zCell, mark, blur));
    }
    if (m2 > FRACTAL_BAIL) {
      escaped = true;
      break;
    }
    if (m2 < dot(d, d)) {
      d = z;
      ref = vec2(0.0);
    }
    vec2 drift = z - saved;
    if (dot(drift, drift) < 1e-12 * max(m2, 1e-6)) break;
    if (n == nextSave) {
      saved = z;
      nextSave *= 2;
    }
  }

  if (escaped) {
    fractalOutside(o, z, m2, n, length(dz), cell, blur, head.z);
  } else {
    o.body = 1.0;
    o.lit = 0.25;
    float stretch = length(stride.xy);
    if (dot(m0.xy, m0.xy) < 1.0) fractalComponent(o, vec3(m0.xy, m0.z * stretch), cell, blur);
    else if (dot(m1.xy, m1.xy) < 1.0) fractalComponent(o, vec3(m1.xy, m1.z * stretch / length(stride.zw)), cell, blur);
  }
  // Pearls streaming past fade: a filled disc rushing by would flash every cell it crosses.
  o.gild *= 1.0 - smoothstep(1.5, 8.0, blur);
  o.mark *= markOn;
  return o;
}

// The Apollonian gasket (sim.ts): content units go to the band packing by a Mobius map
// (u = (ap + b)/(cp + d), ad - bc = 1), where the gasket is the orbit of four circles under
// reflection in four dual circles: the lines x = 0, x = 1 and the circles of radius 1/2 round
// (1/2, 0) and (1/2, 1). Folding a point home through them (each inversion scaling distances by
// r^2/|u - centre|^2) lands it in one of the base discs: A round (0, 1/2), B round (1, 1/2), or the
// half-planes y > 1 and y < 0 (below is the ground outside the outer circle, until folded).
// Recorded where it first enters a base disc, the point gives its own circle's geometry; folded
// on, the hyperbolic tiling inside every circle and an M in each.
FractalSample fractalGasket(vec2 p, int at, float markOn) {
  FractalSample o = fractalBlank();
  vec4 head = fractalTexel(at);
  vec4 ab = fractalTexel(at + 1);
  vec4 cd = fractalTexel(at + 2);
  vec4 flowA = fractalTexel(at + 3);
  vec4 flowC = fractalTexel(at + 4);
  vec4 mark = fractalTexel(at + 11);
  float cell = 2.0 / uRes.y;
  vec2 den = fractalMul(cd.xy, p) + cd.zw;
  vec2 u = fractalDiv(fractalMul(ab.xy, p) + ab.zw, den);
  float uCell = cell / dot(den, den);
  vec2 flow = flowA.xy + fractalMul(p, flowA.zw + fractalMul(p, flowC.xy));
  float blur = fractalBlur(length(flow) / cell);
  float inside = smoothstep(-0.7, 0.7, u.y / uCell);
  // Near the point the map sends to infinity a whole band period shrinks below a cell and the
  // folded coordinates lose their precision: there the gasket is only its even tint.
  float resolved = 1.0 - smoothstep(0.12, 0.45, uCell);
  float w = fractalEdgeWidth();
  if (u.y < -(w + 2.0 + 2.0 * blur) * uCell) return o;

  int iterations = int(head.y);
  float scale = 1.0;
  float scaleIn = 0.0;
  vec2 uIn = u;
  int folds = 0;
  for (int i = 0; i < 64; i++) {
    if (i >= iterations) break;
    u.x -= 2.0 * floor(0.5 * u.x);
    if (u.x > 1.0) u.x = 2.0 - u.x;
    bool inDisc = u.y < 0.0 || u.y > 1.0 || length(u - vec2(0.0, 0.5)) < 0.5 || length(u - vec2(1.0, 0.5)) < 0.5;
    if (inDisc && scaleIn == 0.0) {
      scaleIn = scale;
      uIn = u;
    }
    vec2 centre = vec2(0.5, u.y < 0.5 ? 0.0 : 1.0);
    vec2 v = u - centre;
    float r2 = dot(v, v);
    if (r2 >= 0.25) break;
    float k = 0.25 / r2;
    u = centre + v * k;
    scale *= k;
    if (inDisc) folds++;
  }
  if (scaleIn == 0.0) {
    scaleIn = scale;
    uIn = u;
  }
  float toCells = 1.0 / (scale * uCell);
  float toCellsIn = 1.0 / (scaleIn * uCell);

  // The circle this pixel lies in, from where it entered: A, B, or a half-plane.
  float dA = length(uIn - vec2(0.0, 0.5));
  float dB = length(uIn - vec2(1.0, 0.5));
  bool circular = dA < 0.5 || dB < 0.5;
  float rim = circular ? 0.5 - min(dA, dB) : (uIn.y > 1.0 ? uIn.y - 1.0 : -uIn.y);
  float radius = circular ? 0.5 * toCellsIn : 400.0;
  // Circles a few cells across are drawn as an even foam, not as rims that would sparkle as they flow.
  float fine = smoothstep(2.5, 8.0, radius);
  float lit = circular ? rim / 0.5 : 1.0 - exp(-3.0 * rim);
  float small = 1.0 - smoothstep(2.0, 7.5, log2(max(radius, 1.0)));
  o.wash = inside * mix(mix(0.18, 0.85, small) * mix(1.0, 1.25 - 0.5 * lit, fine), 0.7, 1.0 - resolved);

  // Growth rings, parallel to each circle's rim (horocycles in the half-planes).
  float lineWidth = fractalFineWidth();
  float ringStep = 0.09 * toCellsIn;
  float ringBlur = fractalBlur(length(flow) / cell + abs(flowC.z) * ringStep);
  o.ripple = resolved * inside * fractalLine(fractalLevel(rim / 0.09 - head.z, ringStep), lineWidth, ringBlur) * fractalRoom(ringStep, ringBlur);

  // The rims: the nearest gasket circle to the folded point.
  float rimFolded = min(min(abs(length(u - vec2(0.0, 0.5)) - 0.5), abs(length(u - vec2(1.0, 0.5)) - 0.5)), min(abs(u.y), abs(u.y - 1.0)));
  o.edge = resolved * fractalLine(rimFolded * toCells, w, blur) * mix(0.2, 1.0, fine);

  // The dual circles: an ideal-triangle tiling of every circle, Escher's Circle Limit in each.
  float dual = min(min(abs(u.x), abs(1.0 - u.x)), min(abs(length(u - vec2(0.5, 0.0)) - 0.5), abs(length(u - vec2(0.5, 1.0)) - 0.5)));
  float tile = 0.5 * toCells;
  o.ray = resolved * inside * fractalLine(dual * toCells, lineWidth, blur) * fractalRoom(tile, blur) * smoothstep(1.0, 4.0, rim * toCellsIn);

  // Filigree: a pearl where circles kiss (pearls), or the circle inscribed in every tile (lace).
  float pearl;
  float pearlSize;
  if (K_trap > 0.5) {
    pearlSize = 0.075 * toCells;
    pearl = fractalLine(abs(length(vec2(min(u.x, 1.0 - u.x) - 0.125, u.y - 0.5)) - 0.075) * toCells, 1.2, blur);
  } else {
    vec2 a = u - vec2(0.5, 0.5);
    vec2 b = vec2(min(u.x, 1.0 - u.x), min(abs(u.y), abs(u.y - 1.0)));
    float kiss = min(length(a), length(b));
    pearlSize = 0.05 * toCells;
    pearl = 1.0 - smoothstep(pearlSize - 0.6 - blur, pearlSize + 0.6 + blur, kiss * toCells);
  }
  o.gild = resolved * inside * pearl * smoothstep(1.5, 4.0, pearlSize) * (1.0 - smoothstep(1.0, 4.0, blur));

  // An M in every circle A and B are images of, standing on the mirror x = 0 (or 1) that its own
  // symmetry keeps whole, in the one tile it is folded into without its inner reflections.
  if (markOn > 0.0 && folds == 0 && circular) {
    vec2 q = (u - vec2(u.x < 0.5 ? 0.0 : 1.0, 0.5)) / mark.z;
    float size = mark.z * toCells;
    float strokes = clamp(0.07 * size, 0.8, 4.0);
    o.mark = markOn * inside * fractalLine(markDistance(q) * size, strokes, blur) * smoothstep(8.0, 16.0, size);
  }
  return o;
}

// The Newton garden (sim.ts): Newton's method z -> z - a / sum w_k/(z - r_k) for stones at the
// roots r_k with weights w_k (the sixth is the pointer's pebble). Each pixel's orbit runs to a
// stone; the smooth count of steps it took has rings round each stone for level lines (raked
// sand), the bearing of its last approach has spokes, and where the count crowds the basins meet
// in a braid of beads. dz tracks dz_n/dz_0 through N'(z) = 1 - a S2/S1^2; zt the orbit's motion,
// dz_n/dt, through the stones' and a's velocities.
FractalSample fractalGarden(vec2 p, int at, float markOn) {
  FractalSample o = fractalBlank();
  vec4 head = fractalTexel(at);
  vec4 weightsA = fractalTexel(at + 4);
  vec4 weightsB = fractalTexel(at + 5);
  float rakeRate = fractalTexel(at + 9).x;
  vec4 trap = fractalTexel(at + 10);
  vec4 mark = fractalTexel(at + 11);
  vec2 roots[6];
  vec2 moves[6];
  float weights[6];
  for (int k = 0; k < 3; k++) {
    vec4 pair = fractalTexel(at + 1 + k);
    roots[2 * k] = pair.xy;
    roots[2 * k + 1] = pair.zw;
    vec4 move = fractalTexel(at + 6 + k);
    moves[2 * k] = move.xy;
    moves[2 * k + 1] = move.zw;
  }
  // The sixth velocity slot carries da/dt; the pebble's own motion is the pointer's, left unsoftened.
  vec2 relaxRate = moves[5];
  moves[5] = vec2(0.0);
  weights[0] = weightsA.x;
  weights[1] = weightsA.y;
  weights[2] = weightsA.z;
  weights[3] = weightsA.w;
  weights[4] = weightsB.x;
  weights[5] = weightsB.y;
  vec2 relax = weightsB.zw;
  int iterations = int(head.y);
  float reach = head.w;
  float cell = 2.0 / uRes.y;

  vec2 z = p * reach;
  vec2 dz = vec2(1.0, 0.0);
  vec2 zt = vec2(0.0);
  float e = 1.0;
  float ePrev = 1.0;
  int found = -1;
  float fresh = 1.0;
  int n = 0;
  for (int i = 0; i < 40; i++) {
    if (i >= iterations) break;
    vec2 s1 = vec2(0.0);
    vec2 s2 = vec2(0.0);
    vec2 st = vec2(0.0);
    float best = 1e30;
    int nearest = 0;
    for (int k = 0; k < 6; k++) {
      vec2 v = z - roots[k];
      float d2 = dot(v, v) + 1e-24;
      vec2 inv = vec2(v.x, -v.y) / d2;
      vec2 inv2 = fractalMul(inv, inv);
      s1 += weights[k] * inv;
      s2 += weights[k] * inv2;
      st += weights[k] * fractalMul(moves[k], inv2);
      if (weights[k] > 0.05 && d2 < best) {
        best = d2;
        nearest = k;
      }
    }
    e = sqrt(best);
    n = i;
    if (e < FRACTAL_NEWTON_TOL) {
      found = nearest;
      break;
    }
    ePrev = e;
    vec2 invS1 = fractalDiv(vec2(1.0, 0.0), s1);
    vec2 invS1sq = fractalMul(invS1, invS1);
    vec2 slope = vec2(1.0, 0.0) - fractalMul(relax, fractalMul(s2, invS1sq));
    zt = fractalMul(slope, zt) + fractalMul(relax, fractalMul(st, invS1sq)) - fractalMul(relaxRate, invS1);
    dz = fractalMul(slope, dz);
    z -= fractalMul(relax, invS1);
    if (i < FRACTAL_TRAP_ITER) {
      float zCell = length(dz) * reach * cell;
      o.gild = max(o.gild, fractalTrap(z, zCell, trap, 0.0, fresh));
      if (markOn > 0.0) o.mark = max(o.mark, fractalMarkTrap(z, dz, zCell, mark, 0.0));
    }
  }

  float dzl = max(length(dz), 1e-30) * reach;
  if (found >= 0) {
    vec2 toStone = z - roots[found];
    float speed = length(zt - moves[found]) / (dzl * cell);
    float blur = fractalBlur(speed);
    float steps = max(log(ePrev / max(e, 1e-30)), 0.3);
    float nu = float(n) - log(FRACTAL_NEWTON_TOL / max(e, 1e-30)) / steps;
    float band = e * steps / (dzl * cell);
    float fine = fractalFineWidth();
    float rakeBlur = fractalBlur(speed + rakeRate * 0.5 * band);
    o.ripple = fractalLine(fractalLevel(2.0 * nu - head.z, 0.5 * band), fine, rakeBlur) * fractalRoom(0.5 * band, rakeBlur);
    float spokeStep = (TAU / 8.0) * e / (dzl * cell);
    o.ray = fractalLine(fractalLevel(atan(toStone.y, toStone.x) * (8.0 / TAU), spokeStep), fine, blur) * fractalRoom(spokeStep, blur);
    o.edge = 1.0 - smoothstep(0.7, 2.6 + blur, band);
    o.wash = 0.12 + 0.22 * fract(float(found) * 0.618 + 0.2);
    o.gild *= 1.0 - smoothstep(0.0, 8.0, blur);
    o.mark *= 1.0 - smoothstep(0.0, 8.0, blur);
  } else {
    // Still among the stones: the braid itself. Far out, the orbit passed near a pole of the
    // step and is still falling back from afar: plain sand, not a stray speck of ink.
    o.edge = 1.0 - smoothstep(2.5, 5.0, length(z));
  }

  // The stones, lit from the upper left, each a little irregular, with a soft shadow on the sand.
  for (int k = 0; k < 6; k++) {
    float weight = weights[k];
    if (weight < 0.01) continue;
    vec2 centre = roots[k] / reach;
    float size = (k == 5 ? 0.028 : 0.045 + 0.02 * fract(float(k) * 0.37 + 0.1)) * smoothstep(0.0, 0.6, weight) / (reach / 1.3);
    vec2 v = p - centre;
    float angle = atan(v.y, v.x);
    float outline = size * (1.0 + 0.08 * sin(3.0 * angle + float(k) * 1.7) + 0.05 * sin(5.0 * angle + float(k) * 2.9));
    float stone = 1.0 - smoothstep(outline - cell, outline + cell, length(v));
    o.shade = max(o.shade, 1.0 - smoothstep(0.4 * size, 1.5 * size, length(v - vec2(0.35, -0.5) * size)));
    float light = clamp(dot(v / max(outline, 1e-6), vec2(-0.6, 0.8)), -1.0, 1.0);
    o.body = max(o.body, stone);
    o.lit = mix(o.lit, 0.35 + 0.45 * light, stone);
    // The moon catches each stone's upper-left rim.
    o.sheen = max(o.sheen, 0.6 * stone * smoothstep(0.55, 0.95, length(v) / outline) * max(light, 0.0));
    o.edge *= 1.0 - stone;
    o.ripple *= 1.0 - stone;
    o.ray *= 1.0 - stone;
    o.gild *= 1.0 - stone;
  }
  o.mark *= markOn;
  return o;
}

FractalSample fractalLayer(vec2 p, int at, float markOn) {
  float mode = fractalTexel(at).x;
  if (mode < 0.5) return fractalJulia(p, at, markOn);
  if (mode < 1.5) return fractalDive(p, at, markOn);
  if (mode < 2.5) return fractalGasket(p, at, markOn);
  return fractalGarden(p, at, markOn);
}

vec3 fractalPaint(FractalSample s, FractalInk k) {
  vec3 col = mix(k.bg, k.glow, clamp(s.wash, 0.0, 1.0));
  col *= 1.0 - 0.3 * s.shade;
  col = mix(col, mix(k.body, k.lit, clamp(s.lit, 0.0, 1.0)), clamp(s.body, 0.0, 1.0));
  col = mix(col, k.paper > 0.5 ? k.bg : k.edge, clamp(s.sheen, 0.0, 1.0));
  vec3 lines = mix(k.line, k.bodyLine, clamp(s.body, 0.0, 1.0));
  col = mix(col, lines, clamp(s.ripple * K_ripples, 0.0, 1.0));
  col = mix(col, lines, clamp(s.ray * K_rays, 0.0, 1.0));
  col = mix(col, k.edge, clamp(s.edge, 0.0, 1.0));
  col = mix(col, k.gild, clamp(s.gild * K_filigree, 0.0, 1.0));
  col = mix(col, k.seal, clamp(s.mark, 0.0, 1.0));
  return col;
}

Shade sceneFractal(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  FractalInk ink = fractalInk();
  if (uSimOn.x < 0.5) {
    o.rgb = ink.bg;
    o.source = ink.bg;
    return o;
  }
  vec4 wipe = fractalTexel(0);
  vec4 view = fractalTexel(1);
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0 - view.xy;

  // Between two pictures: the incoming inside a soft front that spreads like ink in water.
  float away = 0.0;
  if (wipe.z < 1e3) {
    float wobble = (fbm(p * 1.6 + vec2(0.0, 0.04 * t)) - 0.5) * 1.2 * wipe.w;
    away = smoothstep(wipe.z - wipe.w, wipe.z + wipe.w, length(p - wipe.xy) + wobble);
  }
  // One call site for every mode, run for each layer the pixel needs; the bounds are dynamic so the
  // compiler keeps the loop rather than copying four fractals twice.
  FractalSample fore = fractalBlank();
  FractalSample back = fractalBlank();
  int first = away > 0.999 ? 1 : 0;
  int last = away > 0.001 ? 2 : 1;
  for (int slot = first; slot < last; slot++) {
    FractalSample drawn = fractalLayer(p, FRACTAL_GLOBAL + slot * FRACTAL_LAYER, view.z);
    if (slot == 0) fore = drawn;
    else back = drawn;
  }
  FractalSample s = fractalMix(fore, back, away);

  vec3 col = fractalPaint(s, ink);
  float lum = dot(col, LUMA);
  float ground = dot(ink.bg, LUMA);
  o.ink = ink.paper > 0.5 ? clamp((ground - lum) / max(ground - 0.06, 0.1), 0.0, 1.0) : clamp((lum - ground) / max(0.8 - ground, 0.1), 0.0, 1.0);
  o.accent = max(s.gild * K_filigree * 0.85, s.mark);
  o.rgb = col;
  o.source = col;
  return o;
}
`;
