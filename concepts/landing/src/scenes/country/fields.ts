// Flower fields' rooted plants, and the field type for a field's hash. The type mapping and the
// flower fields' materials are the shared fields component's (shaders/lib/fields.ts: fieldMix,
// fieldFlowerMaterial). Coordinates and LOD follow the countryside slope, not the screen: rows
// converge, nearby heads have structure, distant plants become field masses.
export const countryFieldsGlsl = /* glsl */ `
// 6 wildflower meadow, 7 lavender, 8 sunflowers, 9 pasture enclosure (animals.ts); 0..5 remain the
// seasonal crop catalogue (the crops' share remapped over it, so a small share keeps every crop).
float countryFieldCrop(float h, float season) {
  vec2 field = fieldMix(h, vec4(K_crops, K_wildflowers, K_lavender, K_sunflowers), K_pasture);
  return field.x < 0.5 ? countryCrop(field.y, season) : 5.0 + field.x;
}

// Bounded 3x3 rooted-plant neighbourhood. Screen delta uses actual depth and down-slope rate;
// this keeps vertical stems upright instead of flattening them into the field's surface texture.
vec4 countryFlowers(float crop, float h, float season, vec2 r, float depth, float down,
                    float wind, float sway, float tm, out float shadow) {
  shadow = 0.0;
  bool meadow = crop < 6.5;
  bool lavender = crop > 6.5 && crop < 7.5;
  vec2 grid = meadow ? vec2(0.023, 0.034) : (lavender ? vec2(0.052, 0.038) : vec2(0.045, 0.055));
  float height = meadow ? 0.013 : (lavender ? 0.012 : 0.023);
  float radius = meadow ? 0.0045 : (lavender ? 0.008 : 0.007);
  float cells = radius * uRes.y / depth;
  // Below resolution or on a severely foreshortened crest, use the area-mean material above.
  float detail = smoothstep(0.9, 1.8, cells);
  if (detail <= 0.0 || height * down / depth > grid.y * 1.8) return vec4(0.0);
  float tilt = meadow ? 0.0 : 0.14 * (h - 0.5);
  vec2 planted = vec2(r.x + r.y * tilt, r.y);
  vec2 cell = floor(planted / grid);
  float autumn = step(1.5, season);
  vec4 best = vec4(0.0);
  float nearestRoot = -1e4;
  for (int y = 0; y < 3; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 id = cell + vec2(float(x), float(y));
      float random = hash12(id + vec2(h * 31.0, h * 17.0));
      // Lavender and sunflowers are planted rows; meadow plants wander and cluster naturally.
      vec2 jitter = meadow ? vec2(0.2) + 0.6 * hash22(id + h * 71.0) : vec2(0.5, 0.25 + 0.5 * random);
      vec2 root = (id + jitter) * grid;
      root.x -= root.y * tilt;
      if (meadow && random > 0.28 + 0.6 * vnoise(root * 5.0 + h * 11.0)) continue;
      vec2 p = vec2((r.x - root.x) / depth, (root.y - r.y) / down);
      float plantHeight = height * (0.72 + 0.35 * random) / depth;
      float rad = radius * (0.8 + 0.25 * fract(random * 17.0)) / depth;
      float lean = sway * wind * 0.0025 * sin(tm * 0.8 + root.x * 9.0 + random * TAU) / depth;
      vec2 head = vec2(lean, plantHeight);
      float aa = 0.6 / uRes.y;
      float under = softFill(length(p / vec2(rad * 1.4, rad * 0.35)) - 1.0, 0.15);
      shadow = max(shadow, under * 0.22 * detail);
      vec3 color = vec3(0.21, 0.34, 0.12);
      float cover = softFill(segmentDistance(p, vec2(0.0), head) - 0.0007 / depth, aa);
      if (lavender) {
        // A bush of three upright flower spikes, not a purple version of the sunflower disc.
        for (int spike = -1; spike <= 1; spike++) {
          float side = float(spike);
          vec2 foot = vec2(side * rad * 0.5, plantHeight * 0.45);
          vec2 tip = vec2(lean + side * rad * 0.65, plantHeight * (1.0 - 0.12 * abs(side)));
          float bloom = softFill(segmentDistance(p, foot, tip) - rad * 0.23, aa);
          if (bloom > cover) {
            cover = bloom;
            color = mix(vec3(0.57, 0.4, 0.74), vec3(0.46, 0.44, 0.42), autumn);
          }
        }
      } else {
        vec2 q = (p - head) / rad;
        float angle = atan(q.y, q.x);
        float petals = 0.82 + (meadow ? 0.18 : 0.12) * cos(angle * (meadow ? 5.0 : 11.0));
        float bloom = softFill(length(q) - petals, aa / rad);
        if (bloom > cover) {
          cover = bloom;
          if (meadow) {
            color = random < 0.22 ? vec3(0.83, 0.31, 0.27) : (random < 0.48 ? vec3(0.93, 0.88, 0.72) : (random < 0.72 ? vec3(0.92, 0.75, 0.24) : vec3(0.59, 0.44, 0.78)));
            color = mix(color, vec3(0.56, 0.43, 0.26), 0.65 * autumn);
          } else {
            float center = 1.0 - smoothstep(0.38, 0.5, length(q));
            color = mix(mix(vec3(0.95, 0.73, 0.16), vec3(0.59, 0.45, 0.2), autumn), vec3(0.29, 0.19, 0.09), center);
          }
        }
        // Broad paired leaves distinguish tall sunflowers from the meadow's slender stems.
        if (!meadow) {
          vec2 leaf = vec2(abs(p.x - lean * 0.45) / (rad * 0.85), (p.y - plantHeight * 0.45) / (rad * 0.4));
          float leafy = softFill(length(leaf - vec2(0.7, 0.0)) - 1.0, aa / rad);
          if (leafy > cover) { cover = leafy; color = vec3(0.25, 0.4, 0.13); }
        }
      }
      // Closer roots occlude more distant plants in the same local neighbourhood.
      if (cover > 0.0 && root.y > nearestRoot) {
        best = vec4(color * (0.9 + 0.1 * random), cover * detail);
        nearestRoot = root.y;
      }
    }
  }
  return best;
}
`;
