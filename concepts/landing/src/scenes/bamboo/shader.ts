// The bamboo grove's picture, back to front: the mist (lit by the sky, with beams slanting through
// it), the canopy overhead with the sky in its gaps, the ground, five depth layers of culms with leaf
// sprays hanging from the nearest three, the stone lantern between them, falling leaves, and the water
// clock in the near right corner: striking stone, tube, posts, spout and the basin's water. The sim
// (sim.ts) moves the culms, the tube, the leaves and the ripples; its textures are described there.
// Knobs read here: K_stems, K_mist, K_groveSeed, K_shafts, K_lantern, K_time, K_cycle, K_rain,
// K_wind, K_mark (trigger 2 summons the M).
import {
  BAMBOO_BASIN,
  BAMBOO_CELLS,
  BAMBOO_CORNER_FIT,
  BAMBOO_DEVICE_DEPTH,
  BAMBOO_EYE,
  BAMBOO_HORIZON,
  BAMBOO_LANTERN,
  BAMBOO_LAYERS,
  BAMBOO_LIP,
  BAMBOO_MAX_LEAVES,
  BAMBOO_POST_X,
  BAMBOO_POUR,
  BAMBOO_RIPPLES,
  BAMBOO_SPOUT,
  BAMBOO_STRIKE,
  BAMBOO_SWAY_HEIGHT,
  BAMBOO_TUBE,
  type BambooLayer,
} from "./sim.ts";

/** A number as a GLSL float literal. */
const f = (value: number): string => value.toFixed(4);
/** One number per depth layer, as a GLSL float array. */
const layerFloats = (pick: (layer: BambooLayer) => number): string => `float[${BAMBOO_LAYERS.length}](${BAMBOO_LAYERS.map((layer) => f(pick(layer))).join(", ")})`;
const LAYERS = BAMBOO_LAYERS.length;

export const bambooGlsl = `
// ---- bamboo ----
const float BAMBOO_HORIZON = ${f(BAMBOO_HORIZON)};
const float BAMBOO_EYE = ${f(BAMBOO_EYE)};
const int BAMBOO_LAYERS = ${LAYERS};
const float BAMBOO_Z[${LAYERS}] = ${layerFloats((layer) => layer.depth)};
const float BAMBOO_SPACING[${LAYERS}] = ${layerFloats((layer) => layer.spacing)};
const float BAMBOO_DIAMETER[${LAYERS}] = ${layerFloats((layer) => layer.diameter)};
const int BAMBOO_CELLS = ${BAMBOO_CELLS};
const float BAMBOO_SWAY_HEIGHT = ${f(BAMBOO_SWAY_HEIGHT)};
// Leaf sprays hang into the top of the frame from the three nearest layers, from these heights up;
// one leaf per cell of a grid in metres, hung from a point inside it.
const float BAMBOO_LEAF_LOW[3] = float[3](0.80, 0.74, 0.70);
const vec2 BAMBOO_LEAF_CELL = vec2(0.26, 0.2);

// The water clock, in device units (see sim.ts).
const vec2 BAMBOO_PIVOT = vec2(${f(BAMBOO_TUBE.x)}, ${f(BAMBOO_TUBE.y)});
const float BAMBOO_BACK = ${f(BAMBOO_TUBE.back)};
const float BAMBOO_FRONT = ${f(BAMBOO_TUBE.front)};
const float BAMBOO_RADIUS = ${f(BAMBOO_TUBE.radius)};
const float BAMBOO_CUT = ${f(BAMBOO_TUBE.cut)};
const float BAMBOO_REST = ${f(BAMBOO_TUBE.rest)};
const vec2 BAMBOO_STRIKE = vec2(${f(BAMBOO_STRIKE.x)}, ${f(BAMBOO_STRIKE.top)});
const vec2 BAMBOO_SPOUT_FROM = vec2(${f(BAMBOO_SPOUT.fromX)}, ${f(BAMBOO_SPOUT.fromY)});
const vec2 BAMBOO_SPOUT_TO = vec2(${f(BAMBOO_SPOUT.toX)}, ${f(BAMBOO_SPOUT.toY)});
const float BAMBOO_SPOUT_R = ${f(BAMBOO_SPOUT.radius)};
const vec2 BAMBOO_LIP = vec2(${f(BAMBOO_LIP.x)}, ${f(BAMBOO_LIP.y)});
const float BAMBOO_POST_X = ${f(BAMBOO_POST_X)};
const vec4 BAMBOO_BASIN = vec4(${f(BAMBOO_BASIN.x)}, ${f(BAMBOO_BASIN.y)}, ${f(BAMBOO_BASIN.rx)}, ${f(BAMBOO_BASIN.ry)});
const float BAMBOO_POUR_SPEED = ${f(BAMBOO_POUR.speed)};
const float BAMBOO_POUR_GRAVITY = ${f(BAMBOO_POUR.gravity)};
const float BAMBOO_DEVICE_DEPTH = ${f(BAMBOO_DEVICE_DEPTH)};
const float BAMBOO_CORNER_ASPECT = ${f(BAMBOO_CORNER_FIT.aspect)};
const float BAMBOO_CORNER_SMALLEST = ${f(BAMBOO_CORNER_FIT.smallest)};
const float BAMBOO_LANTERN_X = ${f(BAMBOO_LANTERN.x)};
const float BAMBOO_LANTERN_DEPTH = ${f(BAMBOO_LANTERN.depth)};
const int BAMBOO_RIPPLES = ${BAMBOO_RIPPLES};
const int BAMBOO_LEAVES = ${BAMBOO_MAX_LEAVES};

const vec3 BAMBOO_YOUNG = vec3(0.09, 0.25, 0.10);    // a young culm, deep green
const vec3 BAMBOO_OLD = vec3(0.35, 0.36, 0.14);      // an old one, gone olive and yellow
const vec3 BAMBOO_BLOOM = vec3(0.44, 0.50, 0.46);    // the white wax below a young culm's nodes
const vec3 BAMBOO_LEAF = vec3(0.07, 0.17, 0.06);     // a leaf in shade
const vec3 BAMBOO_LEAF_LIT = vec3(0.50, 0.72, 0.16); // a leaf with the light through it
const vec3 BAMBOO_DRY = vec3(0.62, 0.48, 0.22);      // a fallen leaf
const vec3 BAMBOO_LITTER = vec3(0.14, 0.10, 0.06);   // the grove floor
const vec3 BAMBOO_MOSS = vec3(0.14, 0.22, 0.07);
const vec3 BAMBOO_GRANITE = vec3(0.31, 0.31, 0.30);
const vec3 BAMBOO_CANE = vec3(0.50, 0.46, 0.20);     // the water clock's seasoned cane
const vec3 BAMBOO_CUT_FACE = vec3(0.72, 0.68, 0.50); // fresh-cut cane
const vec3 BAMBOO_FLAME = vec3(1.0, 0.62, 0.28);     // the lantern
const float BAMBOO_SHADE = 0.6;                      // share of the open sky's light inside the grove

// This pixel's light, set once at the top of sceneBamboo.
Sky bambooSky;
float bambooAspect;
vec3 bambooAmbient;   // the grove's shade light
vec3 bambooKey;       // direct sun and moon, where a beam gets through
vec2 bambooKeySide;   // their horizontal direction (x across, z into the scene), unit
float bambooBeam;     // 0..1: how much this line of sight lies in a beam (dapples on what it meets)
vec3 bambooMist;      // the mist's colour here, beams included
float bambooWisp;     // the mist's thickness here, about 1
float bambooWet;      // rain 0..1
vec2 bambooLanternAt; // the lantern's window, in screen units
float bambooLanternLit;

float bambooBell(float x) {
  return exp(-x * x);
}

// The mist as the sky lights it: the shade light brightening toward the canopy, warmer toward the
// sun's side of the grove, cool under the moon.
vec3 bambooMistColor(vec2 p) {
  Sky s = bambooSky;
  float lift = 0.62 + 0.55 * smoothstep(0.05, 1.0, p.y);
  float toward = clamp(0.5 + p.x * s.sun.x / bambooAspect, 0.0, 1.0);
  vec3 c = s.ambient * 0.85 * lift;
  c += s.sunColor * (0.08 + 0.26 * toward * toward) * (0.55 + 0.45 * p.y);
  c += s.moonColor * (0.35 + 0.25 * p.y);
  return c * BAMBOO_SHADE * (1.0 + 0.25 * bambooWet);
}

// How much of something at depth z (m) and height (m above the ground) shows through the mist. The
// mist pools low, and drifts in banks (bambooWisp).
float bambooTransmit(float z, float height) {
  float dens = (0.012 + 0.17 * K_mist + 0.05 * K_rain) * bambooWisp;
  return exp(-dens * z * (1.0 + 1.6 * exp(-max(height, 0.0) / 1.1)));
}

// Beams slanting through gaps in the canopy for light from sky direction 'dir': x = how much this
// line of sight lies in a beam (soft-edged bands of value noise across the beams, drifting and
// opening and closing over tens of seconds), y = how bright the beam's air is here (fading with the
// distance travelled down from the canopy, uneven where the mist is). The slant follows the light,
// steepened so a low sun still sends long diagonals rather than flat streaks.
vec2 bambooBeams(vec2 p, vec3 dir, float tm) {
  float slant = clamp(atan(dir.x, max(dir.y, 0.0) + 0.35), -0.85, 0.85);
  vec2 down = vec2(-sin(slant), -cos(slant));
  float a = dot(p, vec2(-down.y, down.x));
  float b = max(1.05 - p.y, 0.0) / -down.y;
  float n = 0.62 * vnoise(vec2(a * 8.0 + tm * 0.011, 1.7)) + 0.38 * vnoise(vec2(a * 19.0 - tm * 0.017, 6.3));
  float beam = smoothstep(0.55, 0.74, n);
  float body = 0.5 + 0.5 * vnoise(vec2(a * 3.0 + 4.0, b * 2.4 - tm * 0.025));
  return vec2(beam, beam * body * exp(-1.15 * b));
}

// The lantern's warm light reaching something at screen point p, depth z.
vec3 bambooLanternLight(vec2 p, float z) {
  if (bambooLanternLit <= 0.0) return vec3(0.0);
  vec2 v = p - bambooLanternAt;
  return BAMBOO_FLAME * bambooLanternLit * 1.1 * exp(-dot(v, v) / 0.07) * exp(-abs(z - BAMBOO_LANTERN_DEPTH) * 0.25);
}

// A small round cane seen side-on, u across it (-1..1, +1 toward the light): lit, with the waxy
// stripe and the rim that bamboo takes from the bright mist around it.
vec3 bambooRod(vec3 albedo, float u, vec3 light) {
  float nz = sqrt(max(1.0 - u * u, 0.0));
  vec3 c = albedo * light * (0.6 + 0.55 * clamp(0.5 + 0.5 * u, 0.0, 1.0)) * (0.75 + 0.25 * nz);
  return c + bambooMist * (0.28 * bambooBell((u - 0.45) / 0.22) + 0.35 * pow(1.0 - nz, 3.0));
}

// The chance that a cell of layer i holds a culm, for a culm at screen x: thinned by the stems knob;
// the nearest stems keep to the edges of the frame, and none stand just in front of the lantern.
float bambooOccupancy(int i, float xs) {
  float occ = mix(0.3, 0.95, K_stems);
  if (i == 0) occ *= 0.8 * smoothstep(0.26, 0.4, abs(xs) / bambooAspect);
  if (i == 1) occ *= smoothstep(0.06, 0.12, abs(xs - bambooLanternAt.x));
  return occ;
}

// The culms of layer i at q (screen units, shifted for parallax): lit colour before the mist, and
// coverage; 'height' returns the height above the ground (m), 'depth' how far off the mist takes it to
// be (each culm a little nearer or farther than its layer, so the layers never read as flat bands).
// Each cell of the layer's grid may hold one culm, leaning a little, bent by the sim's deflection more
// toward the top, tapering, with node rings (closer together near the ground), the white wax below
// the nodes of young culms, the mottling of old ones, and a waxy sheen.
vec4 bambooCulms(vec2 q, int i, out float height, out float depth) {
  float z = BAMBOO_Z[i];
  float yb = BAMBOO_HORIZON - BAMBOO_EYE / z;
  height = (q.y - yb) * z;
  depth = z;
  if (height < -0.1) return vec4(0.0);
  float hh = max(height, 0.0);
  float xw = q.x * z;
  float sp = BAMBOO_SPACING[i];
  float aa = z / uRes.y;
  float bend = pow(hh / BAMBOO_SWAY_HEIGHT, 1.5);
  // Neighbouring stems sway nearly together: search the cells around where this point stood before
  // the local sway moved it, so even a storm's bend of more than a cell finds its stem.
  float local = 0.0;
  if (uSimOn.x > 0.5) {
    float cells = float(BAMBOO_CELLS);
    local = texture(uSim0, vec2((xw / sp + 0.5 * cells) / cells, (float(i) + 0.5) / float(BAMBOO_LAYERS))).r;
  }
  float k0 = floor((xw - local * bend) / sp);
  float best = 1e9;
  float axis = 0.0;
  float radius = 1.0;
  float hc = 0.0;
  for (int j = -1; j <= 1; j++) {
    float k = k0 + float(j);
    float hk = hash12(vec2(k + 0.5, float(i) * 7.1 + K_groveSeed * 3.17 + 40.0));
    float x0 = (k + 0.5 + 0.7 * (fract(hk * 41.7) - 0.5)) * sp;
    if (hash12(vec2(k * 1.37 + K_groveSeed * 0.731, float(i) * 11.3 + 2.0)) > bambooOccupancy(i, x0 / z)) continue;
    float deflect = 0.0;
    if (uSimOn.x > 0.5) deflect = texelFetch(uSim0, ivec2(clamp(int(k) + BAMBOO_CELLS / 2, 0, BAMBOO_CELLS - 1), i), 0).r;
    float ax = x0 + (fract(hk * 113.9) - 0.5) * 0.07 * hh + deflect * bend;
    float r = 0.5 * BAMBOO_DIAMETER[i] * (0.8 + 0.4 * fract(hk * 7.3)) * (1.0 - 0.012 * hh);
    float e = abs(xw - ax) - r;
    if (e < best) {
      best = e;
      axis = ax;
      radius = r;
      hc = hk;
    }
  }
  if (best > 0.1 * radius + 2.0 * aa) return vec4(0.0);

  // Nodes: ph counts them up a warped height whose rate is 1 + e^(-h/1.1), so internodes are half as
  // long at the ground as up the stem; dn is the distance (m) above (+) or below (-) the nearest node.
  // Where a node's ring would be finer than the dither can hold (far layers), it fades out.
  float hn = fract(hc * 17.9);
  float ip = 0.36 * (0.85 + 0.3 * hn);
  float low = exp(-hh / 1.1);
  float ph = (hh + 1.1 * (1.0 - low)) / ip + hn * 5.0;
  float dn = (fract(ph + 0.5) - 0.5) * ip / (1.0 + low);
  float rw = max(0.008, 1.1 * aa);
  float rings = 1.0 - smoothstep(0.02, 0.05, aa);
  float groove = (1.0 - smoothstep(0.5 * rw, rw, abs(dn))) * rings;
  float ridge = smoothstep(0.6 * rw, 1.4 * rw, dn) * (1.0 - smoothstep(1.4 * rw, 3.2 * rw, dn)) * rings;
  float edge = abs(xw - axis) - radius * (1.0 + 0.06 * ridge + 0.03 * groove);
  float cover = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, edge)) * smoothstep(-0.1, 0.02, height);
  if (cover <= 0.0) return vec4(0.0);

  float u = clamp((xw - axis) / radius, -1.0, 1.0);
  float age = fract(hc * 29.3);
  age *= age;
  vec3 albedo = mix(BAMBOO_YOUNG, BAMBOO_OLD, age);
  albedo *= 1.0 + age * 0.35 * (vnoise(vec2(u * 1.7 + hc * 50.0, hh * 2.6)) - 0.5);
  float bloom = (1.0 - age) * rings * smoothstep(-0.17, -0.06, dn) * (1.0 - smoothstep(-rw - 0.03, -rw, dn));
  albedo = mix(albedo, BAMBOO_BLOOM, 0.4 * bloom);
  albedo *= 1.0 - 0.55 * groove;
  albedo += 0.05 * ridge;
  albedo *= 1.0 - 0.3 * bambooWet;

  // Seen side-on: the normal is (u, 0, -nz); the key light usually comes from behind the stems, so
  // it rims the side it falls on (wrapped a little).
  float nz = sqrt(max(1.0 - u * u, 0.0));
  float key = clamp((u * bambooKeySide.x - nz * bambooKeySide.y + 0.35) / 1.35, 0.0, 1.0);
  vec2 at = vec2(axis / z, q.y);
  float toLantern = clamp(0.5 + 0.5 * u * sign(bambooLanternAt.x - at.x), 0.0, 1.0);
  vec3 light = bambooAmbient * (0.7 + 0.3 * nz) + bambooKey * key * (0.12 + 0.88 * bambooBeam) + bambooLanternLight(at, z) * toLantern;
  vec3 col = albedo * light;
  float face = bambooKeySide.x < 0.0 ? -1.0 : 1.0;
  col += bambooMist * ((0.2 + 0.25 * bambooWet) * bambooBell((u - 0.45 * face) / 0.2) + 0.45 * pow(1.0 - nz, 3.0));
  depth = z * (0.82 + 0.36 * fract(hc * 3.7));
  return vec4(col, cover);
}

// Leaf sprays of layer i (the three nearest) hanging into the top of the frame: lance-shaped leaves
// on a grid in metres, each hung from a point in its cell and drooping, clumped by a coarse noise.
// They move with the stems' sway (uSim0.r), lean downwind and shiver with the local gust (uSim0.g).
// A leaf reaches at most 0.8 of a cell sideways and 1.3 cells down, so the four cells checked (this
// one, its neighbour on the near side, and the two above) always hold every leaf that can be here.
vec4 bambooLeaves(vec2 q, int i, float tm) {
  float low = BAMBOO_LEAF_LOW[i];
  if (q.y < low - 0.05) return vec4(0.0);
  float z = BAMBOO_Z[i];
  float aa = z / uRes.y;
  vec2 w = vec2(q.x, q.y - BAMBOO_HORIZON) * z;
  vec2 sway = vec2(0.0);
  if (uSimOn.x > 0.5) {
    float cells = float(BAMBOO_CELLS);
    sway = texture(uSim0, vec2((w.x / BAMBOO_SPACING[i] + 0.5 * cells) / cells, (float(i) + 0.5) / float(BAMBOO_LAYERS))).rg;
  }
  // The sprays hang from tops far above the frame, carried along by a share of the stems' sway.
  w.x -= 0.2 * sway.x;
  float gust = sway.y;
  float wind = abs(K_wind);
  float windDir = K_wind < 0.0 ? -1.0 : 1.0;
  vec2 g = w / BAMBOO_LEAF_CELL;
  vec2 id = floor(g);
  float sx = g.x - id.x < 0.5 ? -1.0 : 1.0;
  float cover = 0.0;
  float tone = 0.0;
  for (int c = 0; c < 4; c++) {
    vec2 cid = id + vec2((c == 1 || c == 3) ? sx : 0.0, c >= 2 ? 1.0 : 0.0);
    float h = hash12(cid + vec2(float(i) * 31.7 + K_groveSeed * 1.73, 5.3));
    vec2 anchor = (cid + 0.3 + 0.4 * vec2(fract(h * 13.1), fract(h * 71.3))) * BAMBOO_LEAF_CELL;
    float ys = anchor.y / z + BAMBOO_HORIZON;
    float occ = smoothstep(low, low + 0.14, ys) * smoothstep(0.3, 0.62, vnoise(cid * vec2(0.23, 0.31) + vec2(float(i) * 7.0 + K_groveSeed, 3.0)));
    if (i == 0) occ *= smoothstep(0.24, 0.42, abs(anchor.x / z) / bambooAspect);
    if (fract(h * 5.37) > occ) continue;
    float len = 0.16 * (0.75 + 0.5 * fract(h * 3.9));
    float ang = (fract(h * 9.1) - 0.5) * 1.2 + windDir * wind * (0.25 + 0.5 * gust);
    ang += (0.05 + 0.25 * gust) * sin(tm * (2.4 + 1.3 * fract(h * 17.0)) + h * TAU);
    vec2 dir = vec2(sin(ang), -cos(ang));
    vec2 v = w - anchor;
    float s = dot(v, dir) / len;
    if (s <= 0.0 || s >= 1.0) continue;
    float across = dot(v, vec2(-dir.y, dir.x)) - (fract(h * 2.3) - 0.5) * 0.5 * len * s * s;
    // Narrow stalk, widest a fifth of the way along, then the long taper to the point.
    float hw = 0.02 * (0.8 + 0.4 * fract(h * 29.0)) * smoothstep(0.0, 0.16, s) * pow(1.0 - s, 0.85);
    float cv = 1.0 - smoothstep(hw - 0.7 * aa, hw + 0.7 * aa, abs(across));
    if (cv > cover) {
      cover = cv;
      tone = fract(h * 61.0);
    }
  }
  if (cover <= 0.0) return vec4(0.0);
  // Leaves glow green-gold where a beam comes through them from behind.
  float behind = 0.3 + 0.7 * clamp(bambooKeySide.y * 1.5, 0.0, 1.0);
  vec3 col = BAMBOO_LEAF * (0.7 + 0.6 * tone) * (bambooAmbient * 1.3 + bambooLanternLight(q, z) * 0.6);
  col += BAMBOO_LEAF_LIT * bambooKey * (0.06 + 0.94 * bambooBeam) * behind * (0.25 + 0.5 * tone);
  return vec4(col, cover);
}

// The canopy overhead, far off in the mist: a ragged ceiling of foliage breathing with the far
// stems' sway, thinning into gaps toward the top of the frame where the sky shows.
vec4 bambooCanopy(vec2 p) {
  int back = BAMBOO_LAYERS - 1;
  float sway = 0.0;
  if (uSimOn.x > 0.5) {
    float cells = float(BAMBOO_CELLS);
    sway = texture(uSim0, vec2((p.x * BAMBOO_Z[back] / BAMBOO_SPACING[back] + 0.5 * cells) / cells, (float(back) + 0.5) / float(BAMBOO_LAYERS))).r;
  }
  vec2 q = vec2(p.x - 0.04 * sway, p.y);
  float edge = 0.8 + 0.09 * vnoise(vec2(q.x * 2.3 + K_groveSeed * 0.37, 0.5));
  float n = 0.6 * vnoise(q * vec2(9.0, 12.0)) + 0.4 * vnoise(q * vec2(23.0, 27.0) + 3.1);
  float dens = smoothstep(edge - 0.1, edge + 0.12, q.y + 0.16 * (n - 0.5));
  float gap = smoothstep(0.6, 0.78, n) * smoothstep(0.86, 1.02, q.y);
  float behind = 0.3 + 0.7 * clamp(bambooKeySide.y * 1.5, 0.0, 1.0);
  vec3 col = BAMBOO_LEAF * (0.8 + 0.4 * n) * bambooAmbient * 1.2 + BAMBOO_LEAF_LIT * bambooKey * bambooBeam * behind * 0.15;
  return vec4(col, clamp(dens * (1.0 - gap), 0.0, 1.0));
}

// The grove floor at screen point p (below the horizon): leaf litter with moss, strewn with fallen
// leaves whose detail gives way to its mean once finer than a few cells; dappled where beams reach
// it, and warm in the lantern's pool. zg returns its depth.
vec3 bambooGround(vec2 p, out float zg) {
  zg = BAMBOO_EYE / max(BAMBOO_HORIZON - p.y, 1e-3);
  vec2 w = vec2(p.x * zg, zg);
  float foot = zg * zg / (BAMBOO_EYE * uRes.y);
  float keep = 1.0 - smoothstep(0.04, 0.2, foot);
  float n1 = vnoise(w * vec2(1.3, 2.6) + K_groveSeed);
  float n2 = vnoise(w * vec2(3.5, 9.0) + 7.0);
  float strewn = mix(0.4, smoothstep(0.52, 0.8, n2), keep);
  vec3 albedo = mix(BAMBOO_LITTER, BAMBOO_DRY * 0.55, strewn * 0.7) * (0.8 + 0.4 * n1);
  albedo = mix(albedo, BAMBOO_MOSS * 0.8, smoothstep(0.58, 0.78, n1) * 0.6);
  albedo *= 1.0 - 0.4 * bambooWet;
  vec3 light = bambooAmbient * 0.85 + bambooKey * (0.05 + 0.6 * bambooBeam) * 0.7 + bambooLanternLight(p, zg) * 1.4;
  return albedo * light;
}

// The stone lantern's outline (a kasuga-doro pared down): half-width (m) of the stone at height y,
// 0 where there is none. Base, pillar with a carved band, flaring platform, fire box, broad eaves, a
// concave roof and the jewel on top.
float bambooLanternWidth(float y) {
  if (y < 0.0) return 0.0;
  if (y < 0.16) return 0.23 - 0.05 * smoothstep(0.1, 0.16, y);
  if (y < 0.86) return 0.075 + 0.012 * (1.0 - smoothstep(0.015, 0.025, abs(y - 0.5)));
  if (y < 1.0) return mix(0.1, 0.21, smoothstep(0.86, 0.97, y));
  if (y < 1.32) return 0.17;
  if (y < 1.37) return 0.33;
  if (y < 1.52) return 0.33 * pow(1.0 - (y - 1.37) / 0.15, 1.7) + 0.045;
  if (y < 1.7) {
    float s = (y - 1.52) / 0.18;
    return 0.14 * sqrt(max(s * (1.0 - s), 0.0)) * (1.0 - 0.4 * s);
  }
  return 0.0;
}

// The stone lantern at q (metres from the foot of its axis, y up): stone colour and coverage. Its
// window is a paper screen lit from within; with the Manifold mark (0..1) the M shines through the
// paper. 'glow' returns how much of its light shows here (the accent).
vec4 bambooLantern(vec2 q, float aaM, float mark, out float glow) {
  glow = 0.0;
  float hw = bambooLanternWidth(q.y);
  // The eaves' corners turn up.
  float tips = length(vec2(abs(q.x) - 0.335, q.y - 1.395)) - 0.028;
  float sd = hw > 0.0 ? min(abs(q.x) - hw, tips) : tips;
  float cover = 1.0 - smoothstep(-aaM, aaM, sd);
  if (cover <= 0.0) return vec4(0.0);
  float u = clamp(q.x / max(hw, 0.03), -1.0, 1.0);
  vec3 albedo = BAMBOO_GRANITE * (0.78 + 0.32 * vnoise(q * 48.0) + 0.1 * vnoise(q * 9.0));
  // Moss and lichen on the faces the rain lands on: the roof, the platform, the base.
  float roof = smoothstep(1.37, 1.42, q.y) * (1.0 - smoothstep(1.5, 1.53, q.y));
  float ledges = roof + (1.0 - smoothstep(0.0, 0.02, abs(q.y - 0.985))) + (1.0 - smoothstep(0.0, 0.02, abs(q.y - 0.155)));
  albedo = mix(albedo, BAMBOO_MOSS, clamp(ledges, 0.0, 1.0) * smoothstep(0.4, 0.7, vnoise(q * 22.0 + 2.0)) * 0.85);
  albedo *= 1.0 - 0.3 * bambooWet;
  float nz = sqrt(max(1.0 - u * u, 0.0));
  float key = clamp((u * bambooKeySide.x - nz * bambooKeySide.y + 0.4) / 1.4, 0.0, 1.0);
  vec3 light = bambooAmbient * (0.75 + 0.25 * nz) + bambooKey * key * (0.1 + 0.9 * bambooBeam);
  // Its own light, on the platform below the fire box and under the eaves.
  float under = (1.0 - smoothstep(0.0, 0.03, abs(q.y - 1.335))) * smoothstep(0.15, 0.2, abs(q.x));
  float sill = (1.0 - smoothstep(0.0, 0.025, abs(q.y - 0.985))) * (1.0 - smoothstep(0.1, 0.2, abs(q.x)));
  light += BAMBOO_FLAME * bambooLanternLit * (0.5 * under + 0.4 * sill);
  vec3 col = albedo * light;

  vec2 wq = q - vec2(0.0, 1.16);
  float win = 1.0 - smoothstep(-aaM, aaM, max(abs(wq.x) - 0.105, abs(wq.y) - 0.12));
  if (win > 0.0) {
    float paper = bambooLanternLit * (0.55 + 0.45 * exp(-dot(wq, wq) / 0.006));
    float strokes = (1.0 - smoothstep(-aaM, aaM, markDistance(wq / 0.2) * 0.2 - 0.016)) * mark;
    vec3 lit = BAMBOO_FLAME * paper * 1.2 + vec3(1.0, 0.82, 0.55) * strokes * 1.4;
    col = mix(col, col * 0.35 + lit, win);
    glow = win * clamp(paper + strokes, 0.0, 1.0);
  }
  return vec4(col, cover);
}

// A bamboo leaf's half-width at s (0 stalk .. 1 tip), as a share of its length.
float bambooLeafWidth(float s) {
  return smoothstep(0.0, 0.14, s) * pow(max(1.0 - s, 0.0), 0.8);
}

// Leaves in the air or lying on the ground (uSim2 rows with state 1): the nearest one covering p,
// coloured and misted. A dry leaf, turning about its length as it falls; it lights up crossing a beam.
vec4 bambooFallingLeaves(vec2 p, vec2 par) {
  if (uSimOn.z < 0.5) return vec4(0.0);
  float aa = 1.0 / uRes.y;
  vec4 best = vec4(0.0);
  for (int i = 0; i < BAMBOO_LEAVES; i++) {
    vec4 a = texelFetch(uSim2, ivec2(0, i), 0);
    // Most pixels are nowhere near a leaf: reject before the second fetch (parallax moves a leaf
    // at most par / BAMBOO_DEVICE_DEPTH).
    if (a.w <= 0.0 || abs(p.x - a.x) > a.w + 0.035 || abs(p.y - a.y) > a.w + 0.035) continue;
    vec4 b = texelFetch(uSim2, ivec2(1, i), 0);
    if (b.w > 1.5) continue;
    vec2 v = p - (a.xy - par / b.y);
    if (abs(v.x) > a.w || abs(v.y) > a.w) continue;
    vec2 l = rotate(v, -a.z);
    float s = l.x / a.w + 0.5;
    if (s <= 0.0 || s >= 1.0) continue;
    float hw = max(0.13 * a.w * b.x * bambooLeafWidth(s), 0.9 * aa);
    float curl = 0.1 * a.w * (s - 0.5) * (s - 0.5);
    float cv = (1.0 - smoothstep(hw - 0.7 * aa, hw + 0.7 * aa, abs(l.y - curl))) * b.z;
    if (cv > best.a) {
      float tone = fract(float(i) * 0.618);
      vec3 albedo = mix(BAMBOO_DRY, BAMBOO_OLD, 0.4 * tone) * (1.0 - 0.3 * bambooWet);
      vec3 col = albedo * (bambooAmbient * 1.2 + bambooKey * (0.1 + 0.9 * bambooBeam) * 0.8 + bambooLanternLight(p, b.y));
      col = mix(bambooMist, col, bambooTransmit(b.y, 2.0));
      best = vec4(col, cv);
    }
  }
  return best;
}

// Rings on the basin's water, w in basin-disc units (the water's ellipse mapped to the unit disc, so
// rings are circles on the water and ellipses on screen): the sim's events (the pour, the clack, a leaf
// landing, a click) and, in rain, the shared drops. Returns the slope (xy) and light on the crests (z).
vec3 bambooRipples(vec2 w, float t) {
  vec2 tilt = vec2(0.0);
  float light = 0.0;
  if (uSimOn.y > 0.5) {
    for (int i = 0; i < BAMBOO_RIPPLES; i++) {
      vec4 e = texelFetch(uSim1, ivec2(2 + i, 0), 0);
      if (e.w <= 0.0 || e.z > 5.0) continue;
      vec2 v = w - e.xy;
      float r = length(v);
      float x = r - 0.45 * e.z;
      float fade = 1.0 - e.z / 5.0;
      float env = exp(-x * x * 30.0) * e.w * fade * fade / (1.0 + 2.0 * r);
      tilt += v / max(r, 1e-3) * cos(x * 24.0) * env;
      light += max(sin(x * 24.0), 0.0) * env;
    }
  }
  vec3 rain = rainRipples(w * 2.2, t, K_rain);
  return vec3(tilt * 0.6 + rain.xy, min(light + rain.z, 1.0));
}

// The basin's water at disc point w: dark, mirroring the grove (the far side the mist at eye level,
// the near side the dark canopy overhead), bent by the rings; the lantern's warm sheen on the side
// toward it; foam where the pour lands; leaves floating on it.
vec3 bambooWater(vec2 w, vec2 p, float t, float landing, float pour, vec3 lantern, inout float accent) {
  vec3 rip = bambooRipples(w, t);
  float farSide = 0.5 + 0.5 * w.y;
  vec3 mirror = bambooMistColor(vec2(p.x + rip.x * 0.06, mix(0.78, 0.48, farSide) + rip.y * 0.25));
  mirror *= mix(0.45, 1.0, smoothstep(-0.8, 0.6, w.y));
  vec3 col = mix(vec3(0.015, 0.022, 0.02), mirror * 1.1, 0.35 + 0.3 * farSide);
  col += (bambooMist * 0.9 + lantern * 1.5) * rip.z * 0.5;
  float sheen = bambooBell((w.x + 0.8) * 1.1) * (0.6 + 0.4 * farSide) * bambooLanternLit;
  col += BAMBOO_FLAME * sheen * (0.1 + 0.25 * rip.z);
  accent += sheen * (0.25 + 0.5 * rip.z);
  if (pour > 0.0) {
    vec2 fv = w - vec2(landing, 0.0);
    float foam = exp(-dot(fv, fv) / (0.02 + 0.04 * pour)) * pour;
    col = mix(col, bambooMist * 1.8 + 0.05, clamp(foam, 0.0, 0.8));
  }
  if (uSimOn.z > 0.5) {
    float aa = 1.5 / (uRes.y * BAMBOO_BASIN.z);
    for (int i = 0; i < BAMBOO_LEAVES; i++) {
      vec4 b = texelFetch(uSim2, ivec2(1, i), 0);
      if (b.w < 1.5) continue;
      vec4 a = texelFetch(uSim2, ivec2(0, i), 0);
      vec2 l = rotate(w - a.xy, -a.z);
      float s = l.x / a.w + 0.5;
      if (s <= 0.0 || s >= 1.0) continue;
      float hw = 0.14 * a.w * bambooLeafWidth(s);
      float cv = (1.0 - smoothstep(hw - aa, hw + aa, abs(l.y))) * b.z;
      // Soaked and darkened, lit like the water around it.
      vec3 leaf = BAMBOO_DRY * 0.6 * (bambooAmbient * 1.4 + bambooKey * bambooBeam * 0.5 + lantern);
      col = mix(col, leaf, cv);
    }
  }
  return col;
}

// The water clock in the near right corner, painted over col. d is in device units (sim.ts), p the
// screen point, aa one cell in device units. Adds to accent where the lantern's light shows.
vec3 bambooDevice(vec2 d, vec2 p, float aa, float t, float tm, vec3 col, inout float accent) {
  vec4 st = vec4(BAMBOO_REST, 0.0, 0.0, 1.0);
  if (uSimOn.y > 0.5) st = texelFetch(uSim1, ivec2(0, 0), 0);
  float theta = st.x;
  float fill = st.y;
  float pour = st.z;
  float flow = st.w;
  vec2 cs = vec2(cos(theta), sin(theta));
  vec2 nrm = vec2(-cs.y, cs.x);
  vec3 lantern = bambooLanternLight(p, BAMBOO_DEVICE_DEPTH);
  // The corner stands out of the grove's shade a little: more of the sky reaches it.
  vec3 light = bambooAmbient * 1.5 + bambooKey * (0.08 + 0.6 * bambooBeam) + lantern;
  float face = bambooKeySide.x < 0.0 ? -1.0 : 1.0;

  // The striking stone under the tube's closed end, worn pale and wet where it is struck.
  {
    vec2 c = d - vec2(BAMBOO_STRIKE.x, BAMBOO_STRIKE.y - 0.13);
    vec2 box = abs(c) - vec2(0.05 - 0.035, 0.13 - 0.035);
    float sd = length(max(box, 0.0)) + min(max(box.x, box.y), 0.0) - 0.035 + 0.004 * (vnoise(d * 30.0) - 0.5);
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      float up = clamp((d.y - (BAMBOO_STRIKE.y - 0.06)) / 0.06, 0.0, 1.0);
      vec3 albedo = BAMBOO_GRANITE * (0.75 + 0.35 * vnoise(d * 60.0));
      albedo = mix(albedo, BAMBOO_MOSS, smoothstep(0.55, 0.7, vnoise(d * 18.0 + 3.0)) * (1.0 - up) * 0.8);
      float worn = bambooBell((d.x - BAMBOO_STRIKE.x) / 0.02) * smoothstep(BAMBOO_STRIKE.y - 0.015, BAMBOO_STRIKE.y, d.y);
      albedo = mix(albedo, vec3(0.42, 0.41, 0.38), worn * 0.6);
      albedo *= 1.0 - 0.3 * bambooWet;
      col = mix(col, albedo * light * (0.55 + 0.6 * up), cv);
    }
  }

  // The post the spout is tied to, behind the basin.
  {
    float u = (d.x - BAMBOO_POST_X) / 0.011;
    float sd = max((abs(u) - 1.0) * 0.011, d.y - 0.392);
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 c = bambooRod(BAMBOO_CANE * 0.75, u * face, light);
      float node = 1.0 - smoothstep(0.002, 0.004 + aa, abs(d.y - 0.381));
      float top = 1.0 - smoothstep(0.0, 0.004 + aa, 0.392 - d.y);
      c = mix(c * (1.0 - 0.45 * node), BAMBOO_CUT_FACE * (light + 0.02), top * 0.7);
      col = mix(col, c, cv);
    }
  }

  // The trickle from the spout's lip: into the tube's mouth while it waits, onto the tipped tube, or
  // down into the basin. It bows a little as it falls; slow beads run down it.
  float landing = 0.0;
  if (pour > 0.0) {
    vec2 lip = BAMBOO_PIVOT + BAMBOO_FRONT * cs - BAMBOO_RADIUS * nrm;
    float vx = BAMBOO_POUR_SPEED * cs.x;
    float vy = BAMBOO_POUR_SPEED * cs.y;
    float flight = (vy + sqrt(vy * vy + 2.0 * BAMBOO_POUR_GRAVITY * max(lip.y - BAMBOO_BASIN.y, 0.0))) / BAMBOO_POUR_GRAVITY;
    landing = (lip.x + vx * flight - BAMBOO_BASIN.x) / BAMBOO_BASIN.z;
  }
  vec3 water = bambooMist * 1.6 + lantern * 0.8 + 0.03;
  if (flow > 0.01) {
    float a = (BAMBOO_LIP.x - BAMBOO_PIVOT.x + BAMBOO_RADIUS * cs.y) / cs.x;
    float yEnd = BAMBOO_BASIN.y;
    if (a > -BAMBOO_BACK && a < BAMBOO_FRONT) {
      yEnd = BAMBOO_PIVOT.y + a * cs.y + BAMBOO_RADIUS * cs.x;
      if (a > BAMBOO_FRONT - BAMBOO_CUT) yEnd -= BAMBOO_RADIUS;
    }
    float drop = BAMBOO_LIP.y - d.y;
    if (drop > 0.0 && d.y > yEnd) {
      float x = BAMBOO_LIP.x - 0.006 * sqrt(drop / 0.04);
      float hw = max(0.0026 * sqrt(flow), 0.8 * aa);
      float cv = 1.0 - smoothstep(hw - 0.6 * aa, hw + 0.6 * aa, abs(d.x - x));
      float beads = 0.85 + 0.15 * sin((d.y + tm * 0.05) * 90.0);
      col = mix(col, water * beads, cv * 0.9);
    }
  }

  // The tube (tsutsu): cane on a pivot, closed at the back by a node, its mouth cut obliquely so the
  // upper wall is shorter. The fresh cut is a pale rim, and as the tube brims the water's surface
  // glints in the mouth: the moment before it tips.
  {
    vec2 rel = d - BAMBOO_PIVOT;
    float a = dot(rel, cs);
    float ub = dot(rel, nrm) / BAMBOO_RADIUS;
    float tipEnd = BAMBOO_FRONT - BAMBOO_CUT * clamp(0.5 * (ub + 1.0), 0.0, 1.0);
    float sd = max(max((abs(ub) - 1.0) * BAMBOO_RADIUS, -BAMBOO_BACK - a), (a - tipEnd) * 0.9);
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      float u = clamp(ub, -1.0, 1.0);
      vec3 albedo = BAMBOO_CANE * (0.85 + 0.25 * vnoise(vec2(a * 9.0, u * 3.0 + 5.0)));
      float groove = 1.0 - smoothstep(0.002, 0.004 + aa, min(abs(a + BAMBOO_BACK - 0.012), abs(a - 0.035)));
      albedo *= (1.0 - 0.45 * groove) * (1.0 - 0.25 * smoothstep(0.05, 0.2, a)) * (1.0 - 0.3 * bambooWet);
      float rim = 1.0 - smoothstep(0.0, 0.006 + aa, tipEnd - a);
      vec3 c = albedo * light * (0.55 + 0.7 * (0.5 + 0.5 * u * cs.x));
      c += bambooMist * 0.3 * bambooBell((u - 0.5) / 0.22);
      c = mix(c, BAMBOO_CUT_FACE * (light * 1.2 + 0.02), rim * 0.8);
      c += (bambooMist * 1.2 + lantern) * rim * smoothstep(0.75, 1.0, fill) * 0.6;
      col = mix(col, c, cv);
    }
  }

  // The front post with the pivot pin through it.
  {
    float u = (d.x - BAMBOO_PIVOT.x) / 0.012;
    float top = BAMBOO_PIVOT.y + 0.035;
    float sd = max((abs(u) - 1.0) * 0.012, d.y - top);
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 c = bambooRod(BAMBOO_CANE * 0.8, u * face, light);
      float node = 1.0 - smoothstep(0.002, 0.004 + aa, abs(d.y - (top - 0.012)));
      float cap = 1.0 - smoothstep(0.0, 0.004 + aa, top - d.y);
      c = mix(c * (1.0 - 0.45 * node), BAMBOO_CUT_FACE * (light + 0.02), cap * 0.7);
      float pin = length(d - BAMBOO_PIVOT);
      float pinCover = 1.0 - smoothstep(0.0065 - aa, 0.0065 + aa, pin);
      float glint = 1.0 - smoothstep(0.0, 0.003, length(d - BAMBOO_PIVOT - vec2(0.002 * face, 0.002)));
      c = mix(c, vec3(0.06, 0.05, 0.04) * (light + 0.05) + bambooMist * 0.4 * glint, pinCover);
      col = mix(col, c, cv);
    }
  }

  // At the clack the tube stops dead and the last water in its mouth flies on: a few drops leap from
  // the lip and fall back, smaller for the softer knock of the bounce.
  vec4 knock = uSimOn.y > 0.5 ? texelFetch(uSim1, ivec2(1, 0), 0) : vec4(60.0, 0.0, 0.0, 0.0);
  if (knock.x < 0.7 && knock.y > 0.0) {
    vec2 lip = BAMBOO_PIVOT + (BAMBOO_FRONT - BAMBOO_CUT) * cs + BAMBOO_RADIUS * nrm;
    float shown = 1.0 - smoothstep(0.4, 0.7, knock.x);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      vec2 launch = vec2(0.03 + 0.05 * fract(fi * 0.618 + 0.3), 0.22 + 0.12 * fract(fi * 0.382 + 0.7)) * (0.5 + 0.5 * knock.y);
      vec2 at = lip + launch * knock.x - vec2(0.0, 0.5 * BAMBOO_POUR_GRAVITY * knock.x * knock.x);
      float r = 0.0035 * (1.0 - 0.4 * knock.x);
      col = mix(col, water * 1.2, (1.0 - smoothstep(r - aa, r + aa, length(d - at))) * shown);
    }
  }

  // The spout (kakei), its end cut so the lower lip reaches out, and the hemp rope tying it to its post.
  {
    vec2 axis = BAMBOO_SPOUT_TO - BAMBOO_SPOUT_FROM;
    float span = length(axis);
    vec2 along = axis / span;
    vec2 rel = d - BAMBOO_SPOUT_FROM;
    float a = dot(rel, along);
    float ub = dot(rel, vec2(along.y, -along.x)) / BAMBOO_SPOUT_R;
    float end = span - 0.018 * clamp(0.5 * (ub + 1.0), 0.0, 1.0);
    float sd = max((abs(ub) - 1.0) * BAMBOO_SPOUT_R, max(-a, a - end));
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 c = bambooRod(BAMBOO_CANE * 0.9, clamp(ub, -1.0, 1.0), light);
      float cut = 1.0 - smoothstep(0.0, 0.004 + aa, end - a);
      col = mix(col, mix(c, BAMBOO_CUT_FACE * (light + 0.02), cut * 0.8), cv);
    }
    vec2 tie = abs(d - vec2(BAMBOO_POST_X, 0.362)) - vec2(0.014, 0.016);
    float rope = 1.0 - smoothstep(-aa, aa, max(tie.x, tie.y));
    if (rope > 0.0) {
      float turns = 0.5 + 0.5 * sin((d.y - 0.346) * 785.0);
      col = mix(col, vec3(0.07, 0.055, 0.04) * (0.6 + 0.8 * turns) * (light + 0.05), rope);
    }
  }

  // The basin (tsukubai): a rounded stone, mossy low down, its rim's top face catching the sky; in its
  // opening, the water, and the inner wall showing above it on the far side.
  {
    float rimY = BAMBOO_BASIN.y + 0.006;
    vec2 bq = d - vec2(BAMBOO_BASIN.x, rimY);
    float flank = 0.106 + 0.012 * sin(clamp(-bq.y / 0.16, 0.0, 1.0) * 3.14159) + 0.005 * (vnoise(vec2(d.y * 30.0, 3.0)) - 0.5);
    float outer = length(vec2(bq.x / 0.106, bq.y / 0.028));
    float sd = bq.y < 0.0 ? abs(bq.x) - flank : (outer - 1.0) * 0.028;
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 albedo = BAMBOO_GRANITE * (0.7 + 0.4 * vnoise(d * 55.0));
      albedo = mix(albedo, BAMBOO_MOSS, smoothstep(0.5, 0.72, vnoise(d * 14.0 + 9.0)) * smoothstep(-0.02, -0.12, bq.y) * 0.85);
      albedo *= 1.0 - 0.3 * bambooWet;
      float topFace = 1.0 - smoothstep(0.96, 1.04, outer);
      float side = clamp(0.5 + 0.5 * face * bq.x / flank, 0.0, 1.0);
      vec3 c = albedo * light * mix(0.5 + 0.35 * side, 1.15, topFace);
      float opening = length(vec2(bq.x / 0.082, bq.y / 0.021));
      if (opening < 1.05) {
        vec2 w = vec2((d.x - BAMBOO_BASIN.x) / BAMBOO_BASIN.z, (d.y - BAMBOO_BASIN.y) / BAMBOO_BASIN.w);
        vec3 surface = bambooWater(w, p, t, landing, pour, lantern, accent);
        vec3 inside = mix(albedo * 0.3 * light, surface, 1.0 - smoothstep(0.94, 1.0, length(w)));
        c = mix(c, inside, 1.0 - smoothstep(0.95, 1.02, opening));
      }
      col = mix(col, c, cv);
    }
  }

  // The pour: water leaving the mouth's lower lip along the tube and falling in an arc to the basin,
  // thinning as it speeds up.
  if (pour > 0.0) {
    vec2 lip = BAMBOO_PIVOT + BAMBOO_FRONT * cs - BAMBOO_RADIUS * nrm;
    float vx = max(BAMBOO_POUR_SPEED * cs.x, 1e-3);
    float vy = BAMBOO_POUR_SPEED * cs.y;
    float g = BAMBOO_POUR_GRAVITY;
    float flight = (vy + sqrt(vy * vy + 2.0 * g * max(lip.y - BAMBOO_BASIN.y, 0.0))) / g;
    float tau = (d.x - lip.x) / vx;
    if (tau > -0.02 && tau < flight) {
      float y = lip.y + vy * tau - 0.5 * g * tau * tau;
      float slope = (vy - g * tau) / vx;
      float dist = abs(d.y - y) / sqrt(1.0 + slope * slope);
      float hw = (0.003 + 0.007 * sqrt(pour)) * (1.0 - 0.35 * clamp(tau / flight, 0.0, 1.0));
      float cv = (1.0 - smoothstep(hw - aa, hw + aa, dist)) * smoothstep(-0.02, 0.0, tau);
      col = mix(col, water * 1.15, cv * 0.9);
    }
  }
  return col;
}

// Rain dripping from the leaves: here and there a big drop lets go of a leaf tip high up and falls,
// a short streak lengthening as it speeds up.
float bambooDrips(vec2 p, float tm, float amount) {
  float cw = 0.05;
  float cx = floor(p.x / cw);
  float h = hash12(vec2(cx, 17.0));
  if (h > 0.35 + 0.5 * amount) return 0.0;
  float period = 1.3 + 1.8 * fract(h * 37.3);
  float fallTime = fract(tm / period + fract(h * 91.0)) * period;
  float y0 = 0.8 + 0.17 * fract(h * 13.7);
  float x = (cx + 0.5 + 0.5 * (fract(h * 5.1) - 0.5)) * cw;
  float y = y0 - 1.2 * fallTime * fallTime;
  float len = clamp(0.01 + 0.07 * fallTime, 0.01, 0.08);
  float along = (p.y - y) / len;
  float across = 1.0 - smoothstep(0.002, 0.002 + 1.0 / uRes.y, abs(p.x - x));
  return across * step(0.0, along) * (1.0 - smoothstep(0.3, 1.0, along)) * step(0.0, y);
}

Shade sceneBamboo(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  bambooAspect = aspect;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  float tm = t * uMotion;
  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  bambooSky = sky;
  bambooWet = K_rain;
  // Parallax: nearer things slide further as the pointer moves (divided by depth below).
  vec2 par = uPointer * vec2(0.05, 0.02);
  float gustAll = uSimOn.y > 0.5 ? texelFetch(uSim1, ivec2(1, 0), 0).z : 0.0;

  // Light: the grove's shade, the key (sun and moon), and the side it comes from.
  bambooAmbient = sky.ambient * BAMBOO_SHADE + sky.moonColor * 0.2;
  bambooKey = sky.sunColor + 1.3 * sky.moonColor;
  float sunLevel = dot(sky.sunColor, LUMA);
  float moonLevel = dot(sky.moonColor, LUMA) * 1.3;
  vec2 keySide = sky.sun.xz * sunLevel + sky.moon.xz * moonLevel;
  bambooKeySide = dot(keySide, keySide) > 1e-8 ? normalize(keySide) : vec2(0.6, 0.8);

  // Beams: the canopy's gaps open and close a little as gusts pass.
  vec2 sunBeam = sunLevel > 0.003 ? bambooBeams(p, sky.sun, tm) : vec2(0.0);
  vec2 moonBeam = moonLevel > 0.003 ? bambooBeams(p, sky.moon, tm) : vec2(0.0);
  float flutter = 1.0 - 0.3 * gustAll * (0.5 + 0.5 * sin(tm * 1.1 + dot(p, vec2(7.0, 3.0))));
  float beamMask = (sunBeam.x * sunLevel + moonBeam.x * moonLevel) / max(sunLevel + moonLevel, 1e-4);
  bambooBeam = K_shafts > 0.0 ? beamMask * flutter : 0.3;
  vec3 beamGlow = (sky.sunColor * sunBeam.y + sky.moonColor * 1.6 * moonBeam.y) * flutter * K_shafts * (0.3 + 0.9 * K_mist) * 0.9;

  // Banks of mist drifting downwind, thick and thin.
  float windDir = K_wind < 0.0 ? -1.0 : 1.0;
  bambooWisp = 0.75 + 0.5 * (0.6 * vnoise(vec2(p.x * 2.1 - tm * 0.018 * windDir, p.y * 4.5 + 1.0)) + 0.4 * vnoise(vec2(p.x * 5.3 - tm * 0.03 * windDir, p.y * 9.0 + 4.0)));
  vec3 mist = bambooMistColor(p) + beamGlow;
  bambooMist = mist;

  // The corner group (lantern and water clock) scales down on narrow frames.
  float k = clamp(aspect / BAMBOO_CORNER_ASPECT, BAMBOO_CORNER_SMALLEST, 1.0);
  float lanternScale = k / BAMBOO_LANTERN_DEPTH;
  vec2 lanternFoot = vec2(0.5 * aspect + k * BAMBOO_LANTERN_X, BAMBOO_HORIZON - BAMBOO_EYE / BAMBOO_LANTERN_DEPTH) - par / BAMBOO_LANTERN_DEPTH;
  bambooLanternAt = lanternFoot + vec2(0.0, 1.16 * lanternScale);
  float since = sinceTrigger(2);
  float summon = since >= 0.0 ? smoothstep(0.0, 1.5, since) * (1.0 - smoothstep(14.0, 18.0, since)) : 0.0;
  float mark = max(K_mark, 0.8 * summon);
  float flame = 1.0 + 0.04 * sin(tm * 1.9 + 2.0 * sin(tm * 0.7));
  bambooLanternLit = max(K_lantern * (1.0 - 0.85 * sky.day), 0.6 * mark) * flame;
  float accent = 0.0;

  // Far: the mist, the sky through the canopy's gaps, the canopy, the floor.
  vec3 col = mist;
  if (p.y > 0.6) {
    vec3 dir = viewRay(uv, aspect, BAMBOO_HORIZON, 1.0);
    vec3 skyCol = skyColor(sky, dir) + vec3(0.85, 0.88, 1.0) * skyStars(sky, dir, 0.5);
    col = mix(col, mix(skyCol * 0.8, mist, 0.45), smoothstep(0.78, 1.0, p.y));
    vec4 canopy = bambooCanopy(p);
    col = mix(col, mix(mist, canopy.rgb, bambooTransmit(5.0, 8.0)), canopy.a);
  }
  if (p.y < BAMBOO_HORIZON) {
    float zg;
    vec3 ground = bambooGround(p, zg);
    col = mix(mist, ground, bambooTransmit(zg, 0.0));
  }

  // The grove, far layers first; the lantern stands between the third and second. Loop budget per
  // pixel: 5 layers x 3 culm cells, plus 3 x 4 leaf cells only in the top band; then 12 falling-leaf
  // slots, almost all rejected on one fetch. Everything else (ripples, floating leaves, the clack's
  // drops) runs only inside the water clock's corner.
  for (int i = BAMBOO_LAYERS - 1; i >= 0; i--) {
    float z = BAMBOO_Z[i];
    vec2 q = p + par / z;
    float height;
    float depth;
    vec4 culm = bambooCulms(q, i, height, depth);
    if (culm.a > 0.0) col = mix(col, mix(mist, culm.rgb, bambooTransmit(depth, height)), culm.a);
    if (i <= 2) {
      vec4 leaf = bambooLeaves(q, i, tm);
      if (leaf.a > 0.0) col = mix(col, mix(mist, leaf.rgb, bambooTransmit(z, 8.0)), leaf.a);
    }
    if (i == 2) {
      vec2 lq = (p - lanternFoot) / lanternScale;
      if (abs(lq.x) < 0.42 && lq.y > -0.05 && lq.y < 1.75) {
        float glow;
        vec4 stone = bambooLantern(lq, 1.0 / (uRes.y * lanternScale), mark, glow);
        float through = bambooTransmit(BAMBOO_LANTERN_DEPTH, lq.y);
        col = mix(col, mix(mist, stone.rgb, through), stone.a);
        col += BAMBOO_FLAME * glow * (1.0 - through) * 0.8;
        accent = max(accent, glow);
      }
      // Its light scattered in the mist around it.
      vec2 hv = p - bambooLanternAt;
      float halo = bambooLanternLit * exp(-dot(hv, hv) / (0.006 + 0.012 * K_mist));
      col += BAMBOO_FLAME * halo * (0.12 + 0.3 * K_mist);
      accent = max(accent, halo * 0.45);
    }
  }

  vec4 falling = bambooFallingLeaves(p, par);
  col = mix(col, falling.rgb, falling.a);

  vec2 d = (p - vec2(0.5 * aspect, 0.0) + par / BAMBOO_DEVICE_DEPTH) / k;
  if (d.x > -0.56 && d.y < 0.42) col = bambooDevice(d, p, 1.0 / (uRes.y * k), t, tm, col, accent);

  if (K_rain > 0.0) {
    vec3 drop = bambooMist * 1.5 + 0.04;
    col = mix(col, drop, rainStreaks(uv, aspect, t, K_rain, K_wind) * 0.4);
    col = mix(col, drop * 1.2, bambooDrips(p, tm, K_rain) * 0.6);
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(dot(col, LUMA) * 1.5, 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  return o;
}
`;
