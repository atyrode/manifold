// Farmland, shared: the field-type mix (relative weights of crops, wildflowers, lavender, sunflowers
// and pasture mapped onto a field's own hash), the row profile that settles to its mean where the
// dither cannot hold it, and the flower fields' materials. Opt-in (not in `libs`): a scene with
// fields interpolates `fieldsGlsl` into its GLSL ahead of the code that calls it (the countryside
// and the valley do). The scene decides where its fields lie, their hashes, row space and lighting.
//
// Units are the scene's own field units (the countryside's world unit, about 120 m; the valley
// scales its metres to them): `w` a point of the land, `r` row space (rows run along r's x), `px`
// the size of one dither cell across and down the rows in the same units.
//
//   float fieldHold(float period, vec2 dir, vec2 px);         // 0..1: rows of this period hold up
//   float fieldRows(vec2 r, vec2 dir, float period, vec2 px); // soft ridge-and-trough profile 0..1
//   vec2 fieldMix(float h, vec4 weights, float pasture);      // x FIELD_* type, y the crops' own hash
//   vec3 fieldFlowerMaterial(float kind, float h, float season, vec2 w, vec2 r, vec2 px,
//                            float wind, float sway, float tm, out float relief, out float sheen);
export const fieldsGlsl = /* glsl */ `
// ---- fields ----
const float FIELD_CROPS = 0.0;
const float FIELD_WILDFLOWERS = 1.0;
const float FIELD_LAVENDER = 2.0;
const float FIELD_SUNFLOWERS = 3.0;
const float FIELD_PASTURE = 4.0;

// How well a texture of this period holds up in the dither: 0 when one period spans fewer than ~3
// cells along its direction (it would shimmer), 1 from ~5 cells. px: the size of a cell across and
// down the slope, in the period's units.
float fieldHold(float period, vec2 dir, vec2 px) {
  return smoothstep(2.5, 5.0, period / (abs(dir.x) * px.x + abs(dir.y) * px.y));
}

// Crop rows: a soft ridge-and-trough profile 0..1 across rows of this period in row space r; dir is
// the rows' unit normal in r. Settles to its mean where the rows get too fine to hold.
float fieldRows(vec2 r, vec2 dir, float period, vec2 px) {
  return 0.5 + 0.5 * fieldHold(period, dir, px) * sin(dot(r, dir) * TAU / period);
}

// A field's type for its hash h (0..1) under relative weights (crops, wildflowers, lavender,
// sunflowers) and pasture: x the FIELD_* type, y the hash the crops pick their own catalogue with
// (h remapped over the crops' share, so a small share still holds the whole catalogue). Weights are
// relative; all zero is crops alone. Pasture takes the top of the hash range, so a zero weight
// leaves every other field as it was, and the layout never moves as the weights change.
vec2 fieldMix(float h, vec4 weights, float pasture) {
  float total = dot(weights, vec4(1.0)) + pasture;
  if (total <= 0.0) return vec2(FIELD_CROPS, h);
  vec3 edges = vec3(weights.x, weights.x + weights.y, weights.x + weights.y + weights.z) / total;
  if (h < edges.x) return vec2(FIELD_CROPS, h / edges.x);
  if (h < edges.y) return vec2(FIELD_WILDFLOWERS, h);
  if (h < edges.z) return vec2(FIELD_LAVENDER, h);
  if (pasture <= 0.0 || h < 1.0 - pasture / total) return vec2(FIELD_SUNFLOWERS, h);
  return vec2(FIELD_PASTURE, h);
}

// A flower field's material (kind FIELD_WILDFLOWERS, FIELD_LAVENDER or FIELD_SUNFLOWERS) for its
// hash h and the farming season (0 summer, 1 harvest, 2 autumn), at land point w with row space r;
// wind -1..1 and sway (0 under snow) bow it on the motion clock tm. relief gets the row profile
// (where snow shows it), sheen how much it glints in low sun. Rows and heads fade to the same area
// mean where they get too fine to hold.
vec3 fieldFlowerMaterial(float kind, float h, float season, vec2 w, vec2 r, vec2 px,
                         float wind, float sway, float tm, out float relief, out float sheen) {
  float autumn = step(1.5, season);
  float drift = tm * wind * 0.22;
  float gust = vnoise(vec2((w.x - drift) * 3.2, w.y * 1.4 + h * 9.0)) - 0.5;
  float wave = gust * (0.12 + 0.3 * abs(wind)) * sway;
  float rich = vnoise(w * 4.0 + h * 17.0);
  relief = 0.5;
  sheen = 0.1;
  if (kind < 1.5) {
    // Uneven meadow islands, not drill rows: tall grass, flower-rich patches and sparse green gaps.
    float flowers = smoothstep(0.32, 0.68, rich);
    vec3 grass = mix(vec3(0.27, 0.43, 0.16), vec3(0.43, 0.5, 0.24), autumn);
    vec3 bloom = mix(vec3(0.62, 0.52, 0.57), vec3(0.48, 0.4, 0.25), autumn);
    relief = 0.3 + 0.5 * flowers;
    return mix(grass * (0.9 + 0.2 * rich), bloom, (0.12 + 0.28 * flowers) * (1.0 - 0.45 * autumn)) * (1.0 + wave);
  }
  vec2 dir = normalize(vec2(1.0, 0.14 * (h - 0.5)));
  if (kind < 2.5) {
    // Broad rounded lavender bushes with open earth between rows, fading to the same area mean.
    float held = fieldHold(0.052, dir, px);
    float row = 0.5 + 0.5 * cos(dot(r, dir) * TAU / 0.052);
    row = mix(0.48, smoothstep(0.25, 0.8, row), held);
    relief = row;
    vec3 soil = vec3(0.39, 0.32, 0.22);
    vec3 leaf = mix(vec3(0.4, 0.36, 0.56), vec3(0.36, 0.37, 0.34), autumn);
    return mix(soil, leaf * (0.82 + 0.22 * rich + wave), row);
  }
  // Sunflowers: green, broad-leaf rows. Golden heads remain as a subdued canopy at distance.
  float row = fieldRows(r, dir, 0.045, px);
  relief = row;
  sheen = 0.22;
  vec3 green = mix(vec3(0.29, 0.43, 0.15), vec3(0.4, 0.39, 0.19), autumn);
  vec3 heads = mix(vec3(0.78, 0.61, 0.17), vec3(0.47, 0.35, 0.19), autumn);
  return mix(green * (0.8 + 0.25 * row + wave), heads, 0.22 + 0.09 * rich);
}
`;
