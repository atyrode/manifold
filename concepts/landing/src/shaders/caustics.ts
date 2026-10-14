// Caustics: the net of light a rippled water surface focuses onto the bed beneath it, worked out
// from the surface's curvature rather than drawn as a pattern. Light refracted through a surface of
// height h(p) lands on a bed D below displaced by D · ∇h (D = (1 - 1/n) · depth, a quarter of the
// depth for water), so it spreads over det(I + D · H) of the area it left (H the Hessian of h): crests
// focus it (det < 1, brighter), troughs spread it, and where det crosses 0 the light piles into the
// bright caustic lines. The same Jacobian ShallowWater.surface carries for a simulated surface
// (sims/shallow.ts), so a scene can multiply the two: the swell's broad bands times the wind
// ripples' fine net.
//
// Include it in a scene's GLSL (`glsl: causticsGlsl + sceneGlsl`); it reads no uniform or knob.
//
//   vec2 causticRipples(vec2 p, float tm, vec2 wind, float scale, float steep, float pace, float foot, out vec3 hessian)
//       Five trains of wind ripples fanned about `wind` (a unit vector, the way they run), the longest
//       `scale` long and each 0.77 of the last, each with steepest slope `steep` (0.03 a breath of air
//       .. 0.12 choppy), phase speed pace · sqrt(k) per second of tm (uMotionTime). Returns the
//       surface slope (dh/dx, dh/dy); `hessian` is (h_xx, h_yy, h_xy). p, scale and foot (the surface
//       one dither cell covers) in one unit, any; a train whose wavelength spans fewer than ~10 cells
//       fades out, since its lines would only flicker.
//   float causticJacobian(vec3 hessian, float d)
//       det(I + d · H): d the refraction distance (0.25 · depth for water) in the unit of p.
//
// The light on the bed is then 1 / max(abs(j), soft) times what still water lets through: soft
// 0.1..0.4 caps the peak at 1 / soft (smaller: sharper lines that flicker sooner).
//
// Example (a pool's floor, p in frame heights, depth 0.1 frame heights):
//   vec3 h;
//   vec2 slope = causticRipples(p, uMotionTime, vec2(0.8, 0.6), 0.06, 0.06, 0.35, 1.0 / uRes.y, h);
//   float light = 1.0 / max(abs(causticJacobian(h, 0.25 * 0.1)), 0.25);
//   floorColour *= ambient + sun * light;
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
    float a = steep / k * seen;
    float ph = k * dot(along, p) - pace * sqrt(k) * tm + 1.7 * fi * fi + 0.4;
    slope += along * (a * k * cos(ph));
    hessian -= vec3(along.x * along.x, along.y * along.y, along.x * along.y) * (a * k * k * sin(ph));
    wavelength *= 0.77;
  }
  return slope;
}

float causticJacobian(vec3 hessian, float d) {
  vec3 m = d * hessian;
  return (1.0 + m.x) * (1.0 + m.y) - m.z * m.z;
}
`;
