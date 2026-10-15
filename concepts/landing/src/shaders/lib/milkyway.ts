// Shared Milky Way: the band of the galaxy across a night sky, one implementation for every sky that
// shows it (campfire over the pines, lake over the ice). The contract and conventions are in
// src/scenes/README.md ("Composing components").
//
// Opt-in, unlike the libraries in `libs`: a scene that shows the band puts `milkyWayGlsl` in its own
// GLSL (at its top, before the functions that call it), so no other scene's program compiles it. It
// reads no knob defines: the scene passes its band and multiplies by its own K_milkyWay
// (skyComponentKnobs({ milkyWay })), K_stars and night.
//
// What is shared: the band's shape (a soft gaussian across it, mottled star clouds along it, a dark
// lane of dust down it, fading into the horizon haze) and how much it crowds the stars (milkyWayStars).
// What is the scene's: where the band runs (its pole), its glow's tint, what dims it (night, the moon,
// cloud) and what stands in front.

export const milkyWayGlsl = `
// ---- Milky Way ----
// Where a band runs: the galactic plane's unit normal in the scene's sky frame (a band across the
// frame has its pole well off the view axis) and one axis in the plane. Declare it once, as a
// constant built with MILKY_WAY_BAND(pole), so the axis is worked out as the program builds.
struct MilkyWayBand { vec3 pole; vec3 across; };
#define MILKY_WAY_BAND(pole) MilkyWayBand(pole, normalize(cross(pole, vec3(0.0, 0.0, 1.0))))

// The band's brightness for a view ray, 0..~1.3: 0 below the horizon and more than ~20 degrees off the
// galactic plane.
float milkyWay(vec3 dir, MilkyWayBand way) {
  float b = dot(dir, way.pole);
  if (dir.y <= 0.0 || abs(b) > 0.35) return 0.0;
  vec3 e1 = way.across;
  vec3 e2 = cross(way.pole, e1);
  float l = atan(dot(dir, e2), dot(dir, e1));
  float band = exp(-b * b / 0.014);
  float clouds = 0.55 * vnoise(vec2(l * 8.0, b * 26.0)) + 0.45 * vnoise(vec2(l * 21.0 + 3.0, b * 60.0));
  float lane = (b - 0.02 - 0.015 * sin(l * 5.0)) / 0.016;
  float dust = 1.0 - 0.75 * exp(-lane * lane) * smoothstep(0.25, 0.6, vnoise(vec2(l * 4.0, 7.0)));
  return band * (0.35 + 0.9 * clouds) * dust * smoothstep(0.0, 0.15, dir.y);
}

// The star density to hand skyStars where the band shows 'band' (milkyWay times the scene's gain):
// the stars crowd into it, up to ~1.7x the density in its brightest clouds and 0.7x away from it.
float milkyWayStars(float density, float band) {
  return density * (0.7 + 0.8 * band);
}
`;
