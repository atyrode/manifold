// Caustics: the net of light a rippled water surface focuses onto the bed beneath it, worked out
// from the surface's curvature rather than drawn as a pattern. Light refracted through a surface of
// height h(p) lands on a bed D below displaced by D · ∇h (D = (1 - 1/n) · depth, a quarter of the
// depth for water), so it spreads over det(I + D · H) of the area it left (H the Hessian of h): crests
// focus it (det < 1, brighter), troughs spread it, and where det crosses 0 the light piles into the
// bright caustic lines. The same Jacobian ShallowWater.surface carries for a simulated surface
// (sims/shallow.ts), so a scene can multiply the two: the swell's broad bands times the wind
// ripples' fine net.
//
// Beside it, a cheaper stylised net for a scene with no ripple spectrum of its own (the pond): the
// seams where the soft cells of a wandering lattice meet (Worley's F2 - F1), bright where they cross
// when two are layered. It focuses nothing: it is a pattern, not a Jacobian.
//
// The water library's caustics tier (shaders/lib/water.ts): compiled into a scene's program when it
// selects WATER_TIER >= WATER_CAUSTICS, beside waterCaustic, which composes the two Jacobians. It
// reads no uniform or knob.
//
//   vec2 causticRipples(vec2 p, float tm, vec2 wind, float scale, float steep, float pace, float foot, out vec3 hessian)
//       Five trains of wind ripples fanned about `wind` (a unit vector, the way they run), the longest
//       `scale` long and each 0.77 of the last, each with steepest slope `steep` (0.03 a breath of air
//       .. 0.12 choppy), phase speed pace · sqrt(k) per second of tm (uMotionTime). Returns the
//       surface slope (dh/dx, dh/dy); `hessian` is (h_xx, h_yy, h_xy). p, scale and foot (the surface
//       one dither cell covers) in one unit, any; a train whose wavelength spans fewer than ~10 cells
//       fades out, since its lines would only flicker, and one under 6 cells is not worked out at all.
//   float causticJacobian(vec3 hessian, float d)
//       det(I + d · H): d the refraction distance (0.25 · depth for water) in the unit of p.
//
// The light on the bed is then 1 / max(abs(j), soft) times what still water lets through: soft
// 0.1..0.4 caps the peak at 1 / soft (smaller: sharper lines that flicker sooner). waterCaustic
// works it out, times a simulated surface's own focus.
//
// Example (a pool's floor, p in frame heights, depth 0.1 frame heights, no sim):
//   vec3 h;
//   vec2 slope = causticRipples(p, uMotionTime, vec2(0.8, 0.6), 0.06, 0.06, 0.35, 1.0 / uRes.y, h);
//   float light = waterCaustic(h, 0.1, 1.0, 0.25);
//   floorColour *= ambient + sun * light;
//
// The stylised net:
//   float causticCells(vec2 x, float t, float foot)
//       0..1, 1 on a seam: x in net cells (one cell of the lattice a unit), t the cells' wander in
//       radians (~0.7 a second of tm is calm), foot the span of one dither cell in x's units. A seam
//       spans CAUSTIC_SEAM (0.06) of a cell: once that is under a dither cell it fades to the net's
//       area mean, CAUSTIC_CELLS_MEAN, which is all that is worked out below half a cell. Where the
//       seams span a cell or more it is the full net bit for bit.
//
// Example (the pond's floor, p in frame heights: two nets, light where their seams cross, carried
// by the current with the flow tier's waterDrift; tm = uMotionTime):
//   vec2 q = waterDrift(p, 0.03 * flow, tm);
//   float a = causticCells(q * 4.2 + vec2(tm * 0.03, 0.0), tm * 0.7, 4.2 / uRes.y);
//   float b = causticCells(q * 5.6 + vec2(4.0, -tm * 0.025), tm * 0.9 + 2.0, 5.6 / uRes.y);
//   float light = a * 0.3 + b * 0.2 + a * b * 0.9;
export const causticsGlsl = `
// ---- caustics (shaders/caustics.ts) ----

vec2 causticRipples(vec2 p, float tm, vec2 wind, float scale, float steep, float pace, float foot, out vec3 hessian) {
  vec2 slope = vec2(0.0);
  hessian = vec3(0.0);
  float wavelength = scale;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    // Fanned either side of the wind, alternately, wider for the shorter trains.
    float turn = (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0) * (0.25 + 0.3 * fi);
    vec2 along = vec2(wind.x * cos(turn) - wind.y * sin(turn), wind.x * sin(turn) + wind.y * cos(turn));
    float k = TAU / wavelength;
    float seen = smoothstep(6.0, 12.0, wavelength / max(foot, 1e-6));
    if (seen > 0.0) {
      float a = steep / k * seen;
      float ph = k * dot(along, p) - pace * sqrt(k) * tm + 1.7 * fi * fi + 0.4;
      slope += along * (a * k * cos(ph));
      hessian -= vec3(along.x * along.x, along.y * along.y, along.x * along.y) * (a * k * k * sin(ph));
    }
    wavelength *= 0.77;
  }
  return slope;
}

float causticJacobian(vec3 hessian, float d) {
  vec3 m = d * hessian;
  return (1.0 + m.x) * (1.0 + m.y) - m.z * m.z;
}

const float CAUSTIC_SEAM = 0.06;        // a seam's span, in net cells
const float CAUSTIC_CELLS_MEAN = 0.078; // the net's mean over its area and its wander

float causticCells(vec2 x, float t, float foot) {
  float seen = smoothstep(0.5, 1.0, CAUSTIC_SEAM / max(foot, 1e-6));
  if (seen <= 0.0) return CAUSTIC_CELLS_MEAN;
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = vec2(hash12(i + g), hash12(i + g + 19.1));
      o = 0.5 + 0.45 * sin(t + TAU * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  float seam = 1.0 - smoothstep(0.0, CAUSTIC_SEAM, f2 - f1);
  return seen < 1.0 ? mix(CAUSTIC_CELLS_MEAN, seam, seen) : seam;
}
`;
