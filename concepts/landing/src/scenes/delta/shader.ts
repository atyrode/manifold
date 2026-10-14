// The delta from above: the simulation's ground and water (sim.ts) lit and coloured as a satellite
// picture, a false-colour infrared scene, or a surveyor's chart on paper.
//   uSim0  r bed height above the sea level knob, g water depth (both in grid cells), b silt per
//          unit of depth, a vegetation 0..1
//   uSim1  r fresh sediment 0..1, g recently under water 0..1, b the Manifold M's rock 0..1,
//          a current speed (grid cells per model time unit)
// The grid is cover-fitted to the frame. Knobs read here: K_palette (0 satellite, 1 infrared,
// 2 chart), K_relief, K_clouds, K_farms.
//
// Entrance and exit are the camera's: it descends from a higher orbit onto the delta (the ground
// swells from a little farther away, drifting as the orbit carries it, with a small overshoot and
// settle) while a bank of thin high cloud, nearer the camera and so moving faster across the frame,
// slides past and away; on exit the camera climbs back out, the ground shrinking and drifting on
// the same way, and a bank of cloud drifts in over the land. Everything is built from one view of
// the grid (deltaViewUv), so the land, the sim's picture and the clouds share a projection; at
// rest (passageIn() 1, passageOut() 0) every one of them returns its input untouched.
import { glslFloat } from "../../shaders/glsl.ts";

/** Seconds the entrance and the exit take (SceneDef.passage). */
export const DELTA_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };

/**
 * The camera's passage. zoomIn / zoomOut: how much farther (as a share of the resting view) the
 * ground looks at the start of the entrance and the end of the exit; drift: how far (grid uv) the
 * orbit carries the ground across the frame over the entrance, and on over the exit; settle: the
 * entrance's overshoot (0 none); parallax: how much faster the cloud's scale changes than the
 * ground's (it is nearer the camera); windX/windY: the cloud's drift direction, and slide: how far
 * (uv) a bank of cloud travels to leave the frame; rest: how far into the frame the exit's bank has
 * come when it ends.
 */
const VIEW = { zoomIn: 0.2, zoomOut: 0.18, driftX: 0.04, driftY: 0.02, settle: 1.2, parallax: 1.5, windX: 1, windY: 0.3, slide: 1.8, rest: 0.55 } as const;

export const deltaGlsl = `
// Sunlight from the upper left (north-west), some 35 degrees up.
const vec3 DELTA_SUN = vec3(-0.53, 0.58, 0.62);

// What the picture is made of at one point.
struct DeltaGround {
  float height;  // bed above the sea level knob, grid cells
  float depth;   // water, grid cells
  float silt;    // per unit of depth
  float veg;
  float fresh;
  float wet;
  float rock;
  float speed;
  float light;   // sunlight on the ground, 1 on the flat
  float water;   // water cover 0..1
  float film;    // a wet film too thin to call water
};

// The grid's uv for a frame uv: the grid is cover-fitted (as sim.ts maps the pointer).
vec2 deltaGridUv(vec2 uv) {
  vec2 size = vec2(textureSize(uSim0, 0));
  float grid = size.x / size.y;
  float frame = uRes.x / uRes.y;
  vec2 scale = frame > grid ? vec2(1.0, grid / frame) : vec2(frame / grid, 1.0);
  return 0.5 + (uv - 0.5) * scale;
}

// The passage's camera (see the header): the ground's zoom (1 at rest, above 1 the camera is farther
// off) in x and its drift in grid uv in yz; the entrance's term settles through 0 with a small
// overshoot, the exit's eases in, so the camera pulls away slowly and then faster.
const float DELTA_ZOOM_IN = ${glslFloat(VIEW.zoomIn)};
const float DELTA_ZOOM_OUT = ${glslFloat(VIEW.zoomOut)};
const vec2 DELTA_DRIFT = vec2(${glslFloat(VIEW.driftX)}, ${glslFloat(VIEW.driftY)});
const float DELTA_SETTLE = ${glslFloat(VIEW.settle)};
const float DELTA_PARALLAX = ${glslFloat(VIEW.parallax)};
const vec2 DELTA_WIND = vec2(${glslFloat(VIEW.windX)}, ${glslFloat(VIEW.windY)});
const float DELTA_SLIDE = ${glslFloat(VIEW.slide)};
const float DELTA_REST = ${glslFloat(VIEW.rest)};

bool deltaAtRest() {
  return passageIn() >= 1.0 && passageOut() <= 0.0;
}

// 0 to 1 over x in 0..1, overshooting a little on the way and ending exactly on 1.
float deltaSettle(float x) {
  float u = clamp(x, 0.0, 1.0) - 1.0;
  return 1.0 + (DELTA_SETTLE + 1.0) * u * u * u + DELTA_SETTLE * u * u;
}

vec3 deltaCamera() {
  float arrive = 1.0 - deltaSettle(passageIn());
  float leave = passageOut() * passageOut();
  return vec3(1.0 + DELTA_ZOOM_IN * arrive + DELTA_ZOOM_OUT * leave, DELTA_DRIFT * (arrive - leave));
}

// The grid's uv for a frame uv, through the passage's camera. Beyond the grid's edge the land is
// mirrored: more of the same country, with no streak of clamped edge cells.
vec2 deltaViewUv(vec2 uv) {
  vec2 g = deltaGridUv(uv);
  if (deltaAtRest()) return g;
  vec3 cam = deltaCamera();
  g = 0.5 + cam.yz + (g - 0.5) * cam.x;
  return 1.0 - abs(1.0 - mod(g, 2.0));
}

// A frame uv in the cloud's plane: it is nearer the camera than the ground, so the climb and the
// descent change its scale faster.
vec2 deltaCloudUv(vec2 uv) {
  if (deltaAtRest()) return uv;
  return 0.5 + (uv - 0.5) * (1.0 + DELTA_PARALLAX * (deltaCamera().x - 1.0));
}

DeltaGround deltaSample(vec2 g) {
  DeltaGround s;
  vec2 texel = 1.0 / vec2(textureSize(uSim0, 0));
  vec4 a = texture(uSim0, g);
  vec4 b = texture(uSim1, g);
  s.height = a.x;
  s.depth = max(a.y, 0.0);
  s.silt = max(a.z, 0.0);
  s.veg = clamp(a.w, 0.0, 1.0);
  s.fresh = clamp(b.x, 0.0, 1.0);
  s.wet = clamp(b.y, 0.0, 1.0);
  s.rock = clamp(b.z, 0.0, 1.0);
  s.speed = b.w;
  // Relief from the bed's slope, a cell either side (heights are in cells, so slopes are true).
  float hl = texture(uSim0, g - vec2(texel.x, 0.0)).x;
  float hr = texture(uSim0, g + vec2(texel.x, 0.0)).x;
  float hd = texture(uSim0, g - vec2(0.0, texel.y)).x;
  float hu = texture(uSim0, g + vec2(0.0, texel.y)).x;
  vec2 slope = 0.5 * vec2(hr - hl, hu - hd) * mix(2.0, 12.0, K_relief);
  vec3 n = normalize(vec3(-slope, 1.0));
  vec3 sun = normalize(DELTA_SUN);
  s.light = clamp(dot(n, sun) / sun.z, 0.0, 1.8);
  s.water = smoothstep(0.015, 0.08, s.depth);
  s.film = smoothstep(0.002, 0.02, s.depth) * (1.0 - s.water);
  return s;
}

// Farmland on old, settled ground: a patchwork of parcels on a slightly turned grid of grid cells.
// Returns the parcel's tone 0..1, the dark hedge along its edge (a grid cell or so wide, so it
// holds still under the dither) and how much farmland there is here.
vec3 deltaFarms(vec2 cellPos, DeltaGround s) {
  vec2 q = rotate(cellPos, 0.32) / vec2(9.0, 6.0);
  vec2 f = fract(q);
  float edge = min(min(f.x, 1.0 - f.x) * 9.0, min(f.y, 1.0 - f.y) * 6.0);
  float hedge = 1.0 - smoothstep(0.3, 1.0, edge);
  float lowland = smoothstep(0.5, 1.0, s.height) * (1.0 - smoothstep(2.0, 3.0, s.height));
  float settled = smoothstep(0.7, 0.95, s.veg) * lowland * (1.0 - s.fresh) * (1.0 - s.wet) * (1.0 - s.rock);
  float patchy = step(0.35, hash12(floor(q / 3.0) + 7.0));
  return vec3(hash12(floor(q) + 31.0), hedge, K_farms * settled * patchy);
}

// How turbid the water looks, 0..1: a long, soft ramp over the silt (so plumes fade out with
// distance instead of ending in rims), combed into streaks along the coast, the way the longshore
// current draws them out. The streaks are fixed to the ground, so they never crawl.
float deltaTurbid(DeltaGround s, vec2 cellPos) {
  float streak = vnoise(cellPos * vec2(0.035, 0.2) + vec2(3.1, 7.7));
  return smoothstep(0.0003, 0.007, s.silt * (0.65 + 0.7 * streak));
}

// The satellite picture: deep, saturated colours, so four levels a channel still read as ocean,
// marsh and sand rather than grey.
vec3 deltaSatellite(DeltaGround s, vec2 cellPos) {
  float grain = vnoise(cellPos * 0.45) * 0.5 + vnoise(cellPos * 0.13 + 7.0) * 0.5;
  float low = 1.0 - smoothstep(0.05, 0.6, s.height);
  float high = smoothstep(1.2, 4.5, s.height);
  vec3 soil = mix(vec3(0.55, 0.45, 0.27), vec3(0.45, 0.35, 0.22), high);
  // Low ground by the water is wet sand, darker where the water has just left it.
  soil = mix(soil, vec3(0.58, 0.50, 0.32), 0.85 * low);
  soil = mix(soil, vec3(0.82, 0.68, 0.42), s.fresh * (1.0 - 0.5 * low));
  soil *= 1.0 - 0.18 * max(s.wet, s.film);
  float canopy = clamp(s.veg * (0.8 + 0.45 * (grain - 0.5) * 2.0), 0.0, 1.0);
  vec3 green = mix(vec3(0.50, 0.62, 0.16), vec3(0.20, 0.48, 0.14), smoothstep(0.25, 0.8, canopy));
  green = mix(green, vec3(0.08, 0.36, 0.12), high);
  vec3 land = mix(soil, green, smoothstep(0.08, 0.7, canopy));
  vec3 farm = deltaFarms(cellPos, s);
  vec3 crop = mix(vec3(0.62, 0.66, 0.20), vec3(0.25, 0.52, 0.12), farm.x);
  crop = mix(crop, vec3(0.58, 0.44, 0.26), step(0.8, farm.x));
  land = mix(land, crop * (1.0 - 0.12 * farm.y), farm.z * 0.75);
  land *= 0.9 + 0.2 * grain;
  vec3 stone = mix(vec3(0.42, 0.40, 0.38), vec3(0.66, 0.62, 0.55), smoothstep(0.4, 1.0, s.rock));
  land = mix(land, stone, s.rock);
  land *= 0.42 + 0.58 * s.light;

  // Water: the bed showing through the shallows, light turquoise over the shelf, deepening to
  // navy; silt in jade, olive and tan.
  vec3 water = mix(vec3(0.14, 0.56, 0.52), vec3(0.04, 0.36, 0.42), smoothstep(0.05, 0.7, s.depth));
  water = mix(water, vec3(0.0, 0.18, 0.32), smoothstep(0.7, 2.0, s.depth));
  water = mix(water, vec3(0.0, 0.07, 0.20), smoothstep(2.0, 3.6, s.depth));
  water = mix(land * 0.9 + vec3(0.0, 0.1, 0.1), water, smoothstep(0.0, 0.4, s.depth));
  float plume = deltaTurbid(s, cellPos);
  vec3 silt = mix(vec3(0.20, 0.70, 0.60), vec3(0.45, 0.58, 0.36), smoothstep(0.005, 0.016, s.silt));
  silt = mix(silt, vec3(0.64, 0.48, 0.26), smoothstep(0.012, 0.03, s.silt));
  water = mix(water, silt, plume * mix(0.75, 0.9, smoothstep(0.2, 2.0, s.depth)));
  water += 0.05 * smoothstep(0.2, 0.6, s.speed) * vec3(0.8, 0.9, 0.9);
  return mix(land, water, s.water);
}

// False-colour infrared, as Landsat's near-infrared composites: plants red, bare sand pale, clear
// water black, silty water blue to cyan.
vec3 deltaInfrared(DeltaGround s, vec2 cellPos) {
  float grain = vnoise(cellPos * 0.45) * 0.5 + vnoise(cellPos * 0.13 + 7.0) * 0.5;
  float low = 1.0 - smoothstep(0.05, 0.6, s.height);
  float high = smoothstep(1.2, 4.5, s.height);
  vec3 soil = mix(vec3(0.70, 0.76, 0.74), vec3(0.55, 0.50, 0.48), high);
  soil = mix(soil, vec3(0.30, 0.40, 0.46), 0.8 * low);
  soil = mix(soil, vec3(0.90, 0.94, 0.91), s.fresh * (1.0 - 0.5 * low));
  soil *= 1.0 - 0.4 * max(s.wet, s.film);
  float canopy = clamp(s.veg * (0.8 + 0.45 * (grain - 0.5) * 2.0), 0.0, 1.0);
  vec3 red = mix(vec3(0.85, 0.32, 0.38), vec3(0.72, 0.06, 0.17), smoothstep(0.25, 0.8, canopy));
  red = mix(red, vec3(0.42, 0.04, 0.11), high);
  vec3 land = mix(soil, red, smoothstep(0.08, 0.7, canopy));
  vec3 farm = deltaFarms(cellPos, s);
  vec3 crop = mix(vec3(0.62, 0.60, 0.62), vec3(0.88, 0.18, 0.30), farm.x);
  land = mix(land, crop * (1.0 - 0.12 * farm.y), farm.z * 0.75);
  land *= 0.9 + 0.2 * grain;
  land = mix(land, mix(vec3(0.45, 0.42, 0.40), vec3(0.66, 0.60, 0.55), smoothstep(0.4, 1.0, s.rock)), s.rock);
  land *= 0.42 + 0.58 * s.light;

  vec3 water = mix(vec3(0.10, 0.22, 0.42), vec3(0.03, 0.07, 0.18), smoothstep(0.05, 0.8, s.depth));
  water = mix(water, vec3(0.008, 0.015, 0.04), smoothstep(0.8, 3.0, s.depth));
  water = mix(land * 0.6 + vec3(0.0, 0.03, 0.08), water, smoothstep(0.0, 0.4, s.depth));
  float plume = deltaTurbid(s, cellPos);
  vec3 silt = mix(vec3(0.13, 0.42, 0.72), vec3(0.50, 0.80, 0.90), smoothstep(0.008, 0.035, s.silt));
  water = mix(water, silt, plume * mix(0.5, 0.9, smoothstep(0.2, 2.0, s.depth)));
  return mix(land, water, s.water);
}

// A line of about 'width' cells along the level sets of v (anti-aliased by its screen rate).
float deltaIsoline(float v, float width) {
  float d = abs(fract(v + 0.5) - 0.5) / max(fwidth(v), 1e-4);
  return 1.0 - smoothstep(0.5 * width, 0.5 * width + 1.0, d);
}

// A surveyor's chart: paper, the land in soft relief with contours, the water washed blue and lined
// along the shore, rivers inked, the silt in sepia and the M's rock hatched.
vec3 deltaChart(DeltaGround s, vec2 cell) {
  vec3 paper = vec3(0.925, 0.89, 0.80);
  vec3 land = mix(paper, vec3(0.80, 0.83, 0.70), 0.55 * s.veg);
  land *= 0.88 + 0.12 * clamp(s.light, 0.0, 1.4);
  land = mix(land, vec3(0.62, 0.50, 0.36), 0.45 * deltaIsoline(s.height, 1.2) * smoothstep(0.5, 1.0, s.height));
  float hatch = step(0.5, fract((cell.x + cell.y) * 0.25));
  land = mix(land, vec3(0.29, 0.25, 0.22), s.rock * (0.25 + 0.6 * hatch));

  float surface = s.height + s.depth;
  vec3 water = mix(vec3(0.76, 0.85, 0.87), vec3(0.62, 0.75, 0.80), smoothstep(0.3, 3.0, s.depth));
  water = mix(water, vec3(0.78, 0.66, 0.47), 0.6 * smoothstep(0.001, 0.02, s.silt));
  water = mix(water, vec3(0.24, 0.36, 0.48), 0.6 * deltaIsoline(sqrt(s.depth) * 4.0, 1.0) * smoothstep(0.08, 0.2, s.depth));
  water = mix(water, vec3(0.30, 0.44, 0.58), smoothstep(0.1, 0.4, s.depth) * smoothstep(0.15, 0.35, surface));
  vec3 col = mix(land, water, s.water);
  float shore = 1.0 - smoothstep(0.75, 1.75, abs(s.depth - 0.05) / max(fwidth(s.depth), 1e-4));
  return mix(col, vec3(0.17, 0.23, 0.30), 0.85 * shore);
}

// Fair-weather cumulus drifting over, with their shadows thrown down and to the right.
vec3 deltaClouds(vec3 col, vec2 uv) {
  if (K_clouds <= 0.0) return col;
  vec2 p = vec2(uv.x * uRes.x / uRes.y, uv.y) * 5.5 + vec2(0.025, 0.009) * uMotionTime;
  // Only the tops of the noise: small, crisp puffs, a few percent of the sky at the default cover.
  float lo = 0.66 - 0.14 * K_clouds;
  float hi = lo + 0.05;
  float shadow = smoothstep(lo, hi, fbm(p + vec2(-0.2, 0.18)));
  float cloud = smoothstep(lo, hi, fbm(p));
  col *= 1.0 - 0.45 * shadow;
  return mix(col, vec3(0.86, 0.88, 0.90), 0.85 * cloud);
}

// How far along its drift the passage's bank of cloud has travelled (uv): the entrance's lies over
// the whole frame at first and slides off it; the exit's slides in from beyond the left edge and
// ends partway over the land.
float deltaBankAt() {
  if (passageOut() > 0.0) return -mix(DELTA_SLIDE, DELTA_REST, smoothstep(0.0, 1.0, passageOut()));
  return DELTA_SLIDE * smoothstep(0.0, 0.92, passageIn());
}

// Cover 0..1 of the bank at a point in the cloud's plane: thin wisps drawn out along the drift, in
// a bank that is a finite patch of sky (soft-edged, and empty beyond), so it leaves the frame whole
// and nothing new drifts in behind it. A smooth three-octave field: nothing fine to crawl as it moves.
float deltaBankCover(vec2 cuv, float bank) {
  vec2 q = cuv - DELTA_WIND * bank;
  float box = smoothstep(-0.5, -0.25, q.x) * (1.0 - smoothstep(1.1, 1.35, q.x)) * smoothstep(-0.5, -0.25, q.y) * (1.0 - smoothstep(1.1, 1.35, q.y));
  if (box <= 0.0) return 0.0;
  vec2 along = normalize(DELTA_WIND);
  vec2 a = vec2(q.x * uRes.x / uRes.y, q.y);
  vec2 w = vec2(dot(a, along) * 1.1, dot(a, vec2(-along.y, along.x)) * 4.2) + vec2(11.3, 4.7);
  return smoothstep(0.55, 0.72, fbm3(w)) * box;
}

// The passage's bank of cloud and the shadows it throws down and to the right. Per cell, so its
// edges step across the screen without shimmer. Nothing at rest.
vec3 deltaBank(vec3 col, vec2 cuv) {
  if (deltaAtRest()) return col;
  float bank = deltaBankAt();
  float shadow = deltaBankCover(cuv - vec2(0.035, -0.03), bank);
  float cloud = deltaBankCover(cuv, bank);
  col *= 1.0 - 0.35 * hardEdge(shadow);
  return mix(col, vec3(0.86, 0.88, 0.90), 0.85 * hardEdge(cloud));
}

Shade sceneDelta(vec2 uv, vec2 cell, float t) {
  if (uSimOn.x < 0.5) {
    vec3 sea = mix(vec3(0.02, 0.06, 0.11), vec3(0.05, 0.16, 0.2), uv.y);
    return shadeOf(sea, dot(sea, LUMA), 0.0);
  }
  vec2 g = deltaViewUv(uv);
  DeltaGround s = deltaSample(g);
  vec2 cellPos = g * vec2(textureSize(uSim0, 0));
  bool chart = K_palette > 1.5;
  vec3 col;
  if (chart) col = deltaChart(s, cell);
  else if (K_palette > 0.5) col = deltaInfrared(s, cellPos);
  else col = deltaSatellite(s, cellPos);
  if (!chart) {
    vec2 cuv = deltaCloudUv(uv);
    col = deltaBank(deltaClouds(col, cuv), cuv);
  }

  // The accent: the thin, jade end of the silt plumes spreading into the sea.
  float accent = s.water * deltaTurbid(s, cellPos) * (1.0 - smoothstep(0.012, 0.03, s.silt)) * smoothstep(0.1, 0.4, s.depth);
  return shadeOf(col, inkOf(col, 1.3, 1.0, vec2(0.92, 0.8)), accent);
}
`;
