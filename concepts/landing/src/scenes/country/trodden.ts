// Snow trodden along the roads in use (with roads or tracks, and walkers or carts out on them:
// COUNTRY_HAS_ROADS and COUNTRY_HAS_AGENTS): under lying snow (uWeather.y) every road and track is
// packed down grey and thin but for a white rim at its edges, more the busier the roads (the
// walkers' and the carts' knobs). While snow is still falling (countryFall's: the snow knob, or a
// winter's rain) it fills the way back in, more the heavier it falls, so the tracks show clearest
// once the snowfall is over; trodden thin, they also clear first as the snow melts. Walkers and
// carts keep to every road and track (life.ts), so every one is trodden.
//
// The ground branch sets countryTrod on the roads (countryTrodden); the lying snow is then laid on
// every surface through countryTread.
export const countryTroddenGlsl = /* glsl */ `
#if COUNTRY_HAS_ROADS && COUNTRY_HAS_AGENTS
// ---- snow trodden along the roads (trodden.ts) ----
const vec3 COUNTRY_SLUSH = vec3(0.5, 0.49, 0.47);   // trodden snow with the road showing through

// How trodden the road's snow is under this pixel, 0..1: set on the roads, 0 elsewhere.
float countryTrod = 0.0;

// How trodden the snow is where a road covers \`road\` of a cell, \`edge\` metres from the road's edge
// (negative on it; terrainCover's x) and footRoad metres a cell spans across it: the way but for a
// rim at its edges, or most of the road where a cell is too coarse for the rim.
float countryTrodden(float edge, float footRoad, float road) {
  float walkers = VALLEY_WALKERS > 0.0 ? 0.4 + 0.6 * VALLEY_WALKERS : 0.0;
  float carts = VALLEY_CARTS > 0.0 ? 0.35 + 0.15 * VALLEY_CARTS : 0.0;
  float busy = 1.0 - (1.0 - walkers) * (1.0 - carts);
  if (busy <= 0.0) return 0.0;
  float way = mix(hardFill(edge + 0.35, 0.5 * footRoad), 0.8, smoothstep(0.8, 2.0, footRoad));
  return road * way * busy * (1.0 - 0.6 * clamp(countryFall.y, 0.0, 1.0));
}

// The lying snow (buried: how much covers this surface) where it is trodden: thinner, and packed
// grey where it lies.
void countryTread(inout vec3 albedo, inout float buried) {
  albedo = mix(albedo, COUNTRY_SLUSH, countryTrod * buried);
  buried *= 1.0 - 0.6 * countryTrod;
}
#endif
`;
