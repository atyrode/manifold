// The countryside scene: rolling hills receding into haze, patchwork fields with hedgerows, trees
// and sheep, a river catching the sky, a village with a church spire and smoking chimneys, woods on
// the far ridges, and (optionally) a chalk hill figure of the Manifold M.
//
// The land is six ridges in depth (0 nearest .. 5 farthest), each a 1D fbm silhouette placed by a
// pinhole projection: focal length one screen height (the shared viewRay at COUNTRY_FOV), eye
// COUNTRY_EYE above the valley floor, so ridge i at depth d sits around COUNTRY_HORIZON - EYE / d.
// The sky, the cloud deck and the deck's shadows on the ground therefore all line up with the land.
// A ridge's face gets slope coordinates from its silhouette: across = x * depth, and down the slope
// grows with the square root of the drop below the crest (a rounded hill top seen at a grazing
// angle), which foreshortens fields toward the crest. One pass, front to back: the first ridge
// (or a tree or building standing on it) that covers the pixel is the one shaded.
//
// The weather belongs to that world. Rain comes from a grey deck that sinks and darkens with the
// amount, flattening the light; shafts of rain hang from its base over the far hills; the falling
// drops and their veil are drawn only as far as the first surface each pixel meets, so the near
// field shows a few large drops and the dense fine rain fills the valleys behind it. The land, the
// farm track and the roofs wetten (uWeather.x): darker, glossier, puddles in the ruts mirroring the
// sky, drops bouncing off the track and dimpling the river. Snow falls the same way and settles
// (uWeather.y): first on the high far ridges, then down to the near fields, roofs and tree tops.

import { countryAnimalsGlsl } from "./animals.ts";
import { countryFieldsGlsl } from "./fields.ts";
import { countryWildlifeGlsl } from "./wildlife.ts";
import { countryRoutesGlsl } from "./routes.ts";
import { countrySettlementsGlsl } from "./settlements.ts";

export const countryGlsl = /* glsl */ `
const float COUNTRY_HORIZON = 0.62;      // eye level, uv.y
const float COUNTRY_EYE = 0.36;          // eye height above the valley floor (world unit: a screen height at depth 1)
const float COUNTRY_FOV = 0.9273;        // 2 atan(1/2): viewRay's focal length is one screen height
const float COUNTRY_SLOPE = 1.25;        // down-slope stretch of the faces
const float COUNTRY_ROUND = 0.004;       // how sharply a face folds over at its crest
const float COUNTRY_CLOUD_BASE = 1.6;    // cloud deck height above the eye, world units
const float COUNTRY_RECEDE = 0.22;       // how steeply a building's long wall runs away up the screen
const vec2 COUNTRY_FIELDS = vec2(3.0, 4.2); // fields per world unit across, down the slope
const float COUNTRY_LANE = 0.014;        // half-width of the farm track over the near field, world units
const vec3 COUNTRY_AMBER = vec3(1.0, 0.7, 0.3);
const vec3 COUNTRY_SNOW = vec3(0.9, 0.92, 0.95);
// One deterministic domain offset per fragment; seed zero leaves the original landscape untouched.
vec2 countrySeed;

// Ridge i: x depth, y silhouette baseline on screen, z swell, w silhouette frequency per screen unit.
vec4 countryLayer(float i) {
  float depth = pow(1.65, i);
  return vec4(depth, COUNTRY_HORIZON - COUNTRY_EYE / depth, 0.16 / sqrt(depth), 1.15 * pow(depth, 0.6));
}

// 1D fbm along a ridge, about 0..1.
float countryRidge(float x, float row) {
  float n = 0.0;
  float a = 0.5;
  for (int k = 0; k < 4; k++) {
    n += a * vnoise(vec2(x, row + 3.1 * float(k)) + countrySeed);
    x = x * 2.07 + 1.3;
    a *= 0.5;
  }
  return n / 0.9375;
}

// How close screen x is to the village (x) and to the chalk down (y), 0..1.
vec2 countrySpots(float x, vec2 spots) {
  vec2 a = (vec2(x) - spots) / vec2(0.16, 0.14);
  return exp(-a * a);
}

// Woodland suitability on ridge i at slope point (wx across, wv down): masses on the far hills,
// thickest toward the crests, copses on the middle ridge. Woodland stands where it exceeds 0.53;
// K_woodland 0.5 keeps the original extent, 0 removes woods and 1 spreads them widely.
float countryWoodScore(float i, float wx, float wv) {
  float lean = i < 2.5 ? -0.1 : (i < 4.5 ? 0.06 : 0.14);
  float n = 0.65 * vnoise(vec2(wx * 1.1, wv * 1.6 + 7.3 * i) + countrySeed) + 0.35 * vnoise(vec2(wx * 2.9 + 4.1, wv * 3.3 + 2.9 * i) + countrySeed);
  return n + lean + 0.12 * exp(-3.0 * wv) + 0.36 * (K_woodland - 0.5);
}

// Never on the near fields, the village knoll or the chalk down: the exclusion lowers the score,
// so the woods' edge there still follows the land instead of a straight cut. The castle on the
// down's top (settlements.ts) clears the hilltop around its walls.
float countryWoodKeep(float i, vec2 near) {
  if (i < 1.5 || K_woodland <= 0.0) return 0.0;
  if (i > 2.5 && i < 3.5 && K_castle > 0.5) return min(1.0 - near.y, 1.0 - smoothstep(0.19, 0.6, near.y));
  return i < 2.5 ? 1.0 - near.x : (i < 3.5 ? 1.0 - near.y : 1.0);
}
float countryWoodStand(float i, float wx, float wv, vec2 near) {
  float keep = countryWoodKeep(i, near);
  if (keep <= 0.0) return -1.0;
  return countryWoodScore(i, wx, wv) - 0.3 * (1.0 - keep);
}

// Woodland area fraction, for distant detail that resolves below one crown.
float countryWoods(float i, float wx, float wv, vec2 near) {
  return smoothstep(0.5, 0.56, countryWoodStand(i, wx, wv, near));
}

// Whether one tree, rooted at (wx, wv) with hash h, stands: whole trees, never translucent woods.
// A ragged edge and occasional clearings keep the stand from reading as a planted block.
bool countryTreeStands(float i, float wx, float wv, vec2 near, float h) {
  if (fract(h * 53.7) < 0.08) return false;
  return countryWoodStand(i, wx, wv, near) + 0.06 * (fract(h * 29.3) - 0.5) > 0.53;
}

// Bare terrain only: settlement shaping belongs to the ground, tree crowns never do.
float countryGroundCrest(float i, float x, vec2 spots) {
  vec4 L = countryLayer(i);
  float c = L.y + L.z * (2.0 * countryRidge(x * L.w + 11.0 * i, 5.0 * i + 0.5) - 1.0);
  vec2 near = countrySpots(x, spots);
  if (i > 0.5 && i < 1.5) c = mix(c, L.y - 0.06, 0.75 * near.x);
  if (i > 1.5 && i < 2.5) c = mix(c, L.y + 0.012, 0.8 * near.x) - 0.06 * near.y;
  if (i > 2.5 && i < 3.5) c = mix(c, L.y + 0.035, 0.7 * near.y);
  return c;
}

// A stable species draw, independent of season and canopy density.
bool countryPine(float h) {
  return fract(h * 83.17 + 0.19) < K_pines;
}

// Tiered, tapered boughs in crown coordinates (y up); evergreen structure, not a tinted dome.
float countryPineWidth(float y) {
  float taper = clamp((1.4 - y) / 2.4, 0.0, 1.0);
  return 0.82 * taper * (0.78 + 0.22 * fract((1.4 - y) * 2.0));
}

// One woodland tree's size (0.7..1.3, most near 1), varied so stands never read as planted rows.
float countryTreeSize(float h) {
  return 0.7 + 0.3 * (fract(h * 7.13) + fract(h * 11.7));
}

// Treetop height above the bare crest at x (screen units at depth one): a ragged line of whole
// trees, up to two per crown cell with jittered roots, varied sizes, clearings and both species.
float countryTreeline(float i, float wx, vec2 near) {
  if (countryWoodStand(i, wx, 0.0, near) < 0.4) return 0.0;
  float u = wx * 16.0;
  float cell = floor(u);
  float top = 0.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = 0; j < 2; j++) {
      float h = hash12(vec2(cell + float(k), i + 0.5 + 7.1 * float(j)));
      // A second tree in only some cells: clumps and gaps rather than even spacing.
      if (j == 1 && fract(h * 91.3) > 0.4) continue;
      float root = cell + float(k) + 0.1 + 0.8 * fract(h * 17.3);
      if (!countryTreeStands(i, root / 16.0, 0.0, near, h)) continue;
      float size = countryTreeSize(h);
      float t;
      if (countryPine(h)) {
        float f = abs(u - root) / (0.42 * size);
        // A spire with tiered shoulders; the tallest pines stand well above the rest.
        float spire = max(1.0 - f, 0.0);
        t = size * (0.012 * step(f, 1.0) + 0.052 * spire * (0.88 + 0.12 * fract(spire * 4.0)));
      } else {
        float f = (u - root) / (0.62 * size);
        t = size * 0.046 * pow(max(1.0 - f * f, 0.0), 0.35);
      }
      top = max(top, t);
    }
  }
  return top;
}

// The visible outline includes treetops for occlusion, but never defines the ground underneath.
float countryCrest(float i, float x, vec2 spots, out float terrain) {
  vec4 L = countryLayer(i);
  terrain = countryGroundCrest(i, x, spots);
  if (i < 1.5) return terrain;
  return terrain + countryTreeline(i, x * L.x, countrySpots(x, spots)) / L.x;
}

// Down-slope distance (world) at a drop s below the crest of a ridge at depth d, and its rate
// (world units per screen unit): steep near the crest, where the slope is seen edge-on.
float countryDown(float s, float d) {
  return d * COUNTRY_SLOPE * (sqrt(max(s, 0.0) + COUNTRY_ROUND) - sqrt(COUNTRY_ROUND));
}
float countryDownRate(float s, float d) {
  return d * COUNTRY_SLOPE * 0.5 / sqrt(max(s, 0.0) + COUNTRY_ROUND);
}
// countryDown inverted: the screen drop below the crest of ground v (world) down a ridge at depth d.
float countryDrop(float v, float d) {
  float r = max(v, 0.0) / (d * COUNTRY_SLOPE) + sqrt(COUNTRY_ROUND);
  return r * r - COUNTRY_ROUND;
}

// Field space for ridge i: slope coordinates in fields, offset per ridge and domain-warped so the
// borders wander like old enclosures.
vec2 countryFieldSpace(float i, vec2 w) {
  vec2 f = w * COUNTRY_FIELDS + vec2(31.7 * i, 7.3 * i) + countrySeed;
  return f + 0.5 * (vec2(vnoise(f * 0.55 + 3.1), vnoise(f * 0.55 + 8.7)) - 0.5);
}

// The patchwork: cellular noise (Worley, "A cellular texture basis function", SIGGRAPH 1996), one
// field per cell. Returns the distance to the border with the second-nearest field, measured along
// the line between the two sites so hedges keep their width (x), and the field's hash (y); site and
// other get both sites in field space, axis the unit direction from site to other.
vec2 countryCells(vec2 f, out vec2 site, out vec2 other, out vec2 axis) {
  vec2 i = floor(f);
  vec2 g = fract(f);
  float d1 = 8.0;
  float d2 = 8.0;
  vec2 s1 = vec2(0.0);
  vec2 s2 = vec2(0.0);
  vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 o = vec2(float(k), float(y));
      vec2 at = o + 0.15 + 0.7 * vec2(hash12(i + o + 0.31), hash12(i + o + 5.77));
      vec2 d = at - g;
      float dd = dot(d, d);
      if (dd < d1) {
        d2 = d1;
        s2 = s1;
        d1 = dd;
        s1 = at;
        id = i + o;
      } else if (dd < d2) {
        d2 = dd;
        s2 = at;
      }
    }
  }
  axis = normalize(s2 - s1);
  site = s1 + i;
  other = s2 + i;
  return vec2(dot(0.5 * (s1 + s2) - g, axis), hash12(id + 0.71));
}

// How well a texture of this period (world) holds up in the dither: 0 when one period spans fewer
// than ~3 cells along its direction (it would shimmer), 1 from ~5 cells. px: world size of a cell
// across and down the slope.
float countryHold(float period, vec2 dir, vec2 px) {
  return smoothstep(2.5, 5.0, period / (abs(dir.x) * px.x + abs(dir.y) * px.y));
}

// A field's crop for its hash and the season (0 summer, 1 harvest, 2 autumn): 0 wheat, 1 pasture,
// 2 ploughed, 3 rapeseed, 4 stubble, 5 meadow (summer hay; at harvest the green aftermath growing
// back; in autumn, new shoots of winter wheat).
float countryCrop(float h, float season) {
  if (season < 0.5) return h < 0.3 ? 0.0 : (h < 0.62 ? 1.0 : (h < 0.76 ? 3.0 : (h < 0.92 ? 5.0 : 2.0)));
  if (season < 1.5) return h < 0.36 ? 0.0 : (h < 0.62 ? 1.0 : (h < 0.82 ? 4.0 : (h < 0.9 ? 2.0 : 5.0)));
  return h < 0.34 ? 2.0 : (h < 0.68 ? 1.0 : (h < 0.82 ? 4.0 : 5.0));
}

// Crop rows: a soft ridge-and-trough profile 0..1 across rows of this period (world) in row space
// r; dir is the rows' unit normal in r. Settles to its mean where the rows get too fine to hold.
float countryRows(vec2 r, vec2 dir, float period, vec2 px) {
  return 0.5 + 0.5 * countryHold(period, dir, px) * sin(dot(r, dir) * TAU / period);
}

${countryFieldsGlsl}
${countryRoutesGlsl}

// The crop's colour at slope point w (world). r: row space, w with x taken at the ground's own
// depth, so rows running down the slope converge into the distance while rows along the contour
// crowd toward the crest. h: the field's hash; px: world size of a cell across and down; wind
// -1..1; sway: how freely the crop moves (0 under snow, where it stands still); t: the motion clock
// (uMotionTime). relief gets the row profile (1 on the ridges, where snow shows them),
// sheen how much the crop's surface glints in low sun.
vec3 countryCropColor(float crop, float h, float season, vec2 w, vec2 r, vec2 px, float wind, float sway, float t, out float relief, out float sheen) {
  float h2 = fract(h * 13.7);
  float h3 = fract(h * 71.3);
  // Most fields are drilled along the contour, the rest straight down the slope.
  float a = (h2 < 0.55 ? 1.5708 : 0.0) + (h3 - 0.5) * 0.5;
  vec2 dir = vec2(cos(a), sin(a));
  // Gusts roll downwind across standing crops as broad bands (the bent stalks show their paler
  // sides), stretched across the wind, with finer ripples riding on them.
  float drift = t * wind * 0.35;
  float gust = vnoise(vec2((w.x - drift) * 3.2, w.y * 1.4 + h * 9.0)) - 0.5;
  float ripple = (vnoise(vec2((w.x - drift * 1.7) * 9.0, w.y * 4.0 + 5.0)) - 0.5) * countryHold(0.11, vec2(1.0, 0.0), px);
  float wave = (gust + 0.6 * ripple) * (0.14 + 0.5 * abs(wind)) * sway;
  // Richer and leaner patches within a field, a little more golden or more green.
  float rich = vnoise(w * 3.3 + h * 17.0);
  relief = 0.5;
  sheen = 0.0;
  vec3 col = vec3(0.0);
  if (crop < 0.5) {
    // Wheat: green-gold in summer, gold at harvest; the gusts bend it into soft sheen.
    relief = countryRows(r, dir, 0.03, px);
    vec3 ear = season < 0.5 ? vec3(0.6, 0.66, 0.28) : vec3(0.93, 0.74, 0.3);
    col = ear * (0.84 + 0.22 * relief) * (1.0 + 0.6 * wave);
    sheen = 0.35 + 0.65 * smoothstep(-0.1, 0.15, wave);
  } else if (crop < 1.5) {
    // Grazed grass, mown in broad lighter and darker stripes.
    relief = countryRows(r, dir, 0.09, px);
    vec3 grass = season < 0.5 ? vec3(0.32, 0.55, 0.2) : (season < 1.5 ? vec3(0.38, 0.56, 0.22) : vec3(0.32, 0.5, 0.2));
    col = grass * (0.93 + 0.1 * relief);
  } else if (crop < 2.5) {
    // Ploughed: furrows whose ridges catch the light.
    relief = countryRows(r, dir, 0.024, px);
    vec3 earth = season > 1.5 ? vec3(0.44, 0.29, 0.19) : vec3(0.52, 0.37, 0.24);
    col = earth * (0.7 + 0.45 * relief);
  } else if (crop < 3.5) {
    relief = countryRows(r, dir, 0.035, px);
    col = vec3(0.95, 0.82, 0.16) * (0.9 + 0.14 * relief) * (1.0 + 0.4 * wave);
    sheen = 0.3;
  } else if (crop < 4.5) {
    // Stubble: the combine's passes as alternating paler and darker swaths, the cut rows in them.
    relief = countryRows(r, dir, 0.022, px);
    float swath = countryRows(r, dir, 0.07, px);
    vec3 straw = season > 1.5 ? vec3(0.76, 0.66, 0.44) : vec3(0.9, 0.77, 0.47);
    col = straw * (0.86 + 0.12 * swath + 0.08 * relief);
  } else if (season < 1.5) {
    // Hay meadow flecked with flowers where the dither can hold them; at harvest the aftermath.
    float fleck = season < 0.5 ? step(0.8, vnoise(w * 70.0)) * countryHold(0.015, vec2(0.7), px) : 0.0;
    vec3 hay = season < 0.5 ? vec3(0.5, 0.62, 0.28) : vec3(0.44, 0.6, 0.25);
    col = mix(hay * (1.0 + 0.6 * wave), vec3(0.86, 0.82, 0.9), 0.5 * fleck);
  } else {
    // Winter wheat coming up: green drill rows on brown earth.
    relief = countryRows(r, dir, 0.022, px);
    col = mix(vec3(0.48, 0.34, 0.21), vec3(0.34, 0.52, 0.22), relief);
  }
  return col * (0.9 + 0.12 * h3) * vec3(0.93 + 0.14 * rich, 0.95 + 0.1 * rich, 0.97);
}

// Sheep grazing a pasture (crop 1) or round bales lying on stubble (crop 4), at slope point w on a
// ridge at depth d; down: world units per screen unit down the slope. Sized on screen so they keep
// their shape however foreshortened the slope. Returns colour and coverage; shadow darkens the
// ground at their feet.
vec4 countryDots(float crop, vec2 w, float d, float down, float t, out float shadow) {
  shadow = 0.0;
  bool sheep = crop < 1.5;
  float grid = sheep ? 0.06 : 0.05;
  float rx = (sheep ? 0.0055 : 0.0042) / d;
  float ry = (sheep ? 0.0036 : 0.0042) / d;
  if (rx * uRes.y < 1.2 || down * ry * 2.0 > grid * 0.4) return vec4(0.0);
  vec2 id = floor(w / grid);
  for (int j = 0; j < 2; j++) {
    // This cell, and the one below whose animal may stand up into it.
    vec2 cid = id + vec2(0.0, float(j));
    float h = hash12(cid + (sheep ? 3.3 : 9.1));
    if (h > (sheep ? 0.55 : 0.4) || (sheep && vnoise(cid * 0.35 + 2.0) < 0.45)) continue;
    vec2 at = (cid + 0.3 + 0.4 * vec2(fract(h * 7.3), fract(h * 13.1))) * grid;
    if (sheep) at.x += 0.006 * sin(t * 0.04 + h * 40.0);
    vec2 ds = vec2((w.x - at.x) / d, (at.y - w.y) / down);
    vec2 under = vec2(ds.x / (rx * 1.15), ds.y / (ry * 0.45));
    if (dot(under, under) < 1.0) shadow = 0.45;
    vec2 body = vec2(ds.x / rx, (ds.y - ry) / ry);
    if (sheep) {
      float face = fract(h * 29.0) < 0.5 ? -1.0 : 1.0;
      vec2 head = vec2((ds.x - face * rx * 0.95) / (rx * 0.42), (ds.y - ry * 1.15) / (ry * 0.5));
      if (dot(head, head) < 1.0) return vec4(0.12, 0.1, 0.09, 1.0);
      if (dot(body, body) < 1.0) return vec4(vec3(0.9, 0.88, 0.82) * (0.9 + 0.1 * body.y), 1.0);
    } else if (dot(body, body) < 1.0) {
      // The rolled face toward us, its rim darker.
      return vec4(mix(vec3(0.74, 0.6, 0.32), vec3(0.55, 0.42, 0.2), smoothstep(0.55, 1.0, length(body))), 1.0);
    }
  }
  return vec4(0.0);
}

// Hedgerow trees, standing on the field borders: up to three per border, spaced along it from the
// midpoint between the two fields' sites. f: field-space point where a crown centred on the pixel
// would be rooted (1.2 r below it); scale: field units per screen unit across/down there; r: crown
// radius on screen. above: how far the pixel's root point lies above the crest (screen), for crowns
// standing over it. Returns the crown under the pixel: xy disc coordinates (y up), z 1 on a crown,
// w the tree's hash. Off the crowns, shadow gets the trees' shadows on the ground (0..1): trunk and
// crown cast away from the sun (sun: its direction), long when it is low, flattened by the grazing
// view of the ground.
vec4 countryTrees(vec2 f, vec2 scale, float r, float density, float above, vec3 sun, out float shadow) {
  shadow = 0.0;
  vec2 site = vec2(0.0);
  vec2 other = vec2(0.0);
  vec2 axis = vec2(0.0);
  countryCells(f, site, other, axis);
  vec2 mid = 0.5 * (site + other);
  vec2 along = vec2(-axis.y, axis.x);
  vec4 best = vec4(0.0);
  float nearest = 1.0;
  // Where the crown's shadow falls from the root, in crown radii on screen (y up).
  vec2 reach = vec2(-sun.x, -0.4 * sun.z) * 1.2 / max(sun.y, 0.08);
  reach *= min(1.0, 4.0 / max(length(reach), 1e-3));
  for (int j = -1; j <= 1; j++) {
    float th = hash12(floor((site + other) * 37.0) + float(j) * 3.7);
    if (th > density || countryTreeCleared(mid + along * (0.3 * float(j)), f)) continue;
    vec2 ds = (f - (mid + along * (0.3 * float(j)))) / scale;
    ds.y = above - ds.y;
    float rad = r * (0.7 + 0.3 * fract(th * 17.3));
    float dd = length(ds) / rad;
    if (dd < nearest) {
      nearest = dd;
      best = vec4(ds / rad, 1.0, th);
    }
    // The ground point under the pixel, from the root, with the ground's foreshortening undone.
    vec2 g = vec2(ds.x, ds.y + 1.2 * r) / vec2(rad, 0.5 * rad);
    float sd = segmentDistance(g, vec2(0.0), reach * vec2(1.0, 2.0));
    shadow = max(shadow, 1.0 - smoothstep(0.75, 1.0, sd));
  }
  return best;
}

// Woodland crowns in their own side-view space (c: 16 crowns per world unit across, y down from
// the visible treeline). Each crown stands or not by the woodland at its own root, so stands have
// whole-tree edges, clearings and no translucent overlay. lift: treeline height above the bare
// crest here; depth: the ridge's. Returns the nearest covering crown's normal (xyz) and hash (w);
// cover 1 on a crown; ao darkens toward crown edges.
vec4 countryCanopy(vec2 c, float ridge, float depth, float lift, vec2 near, out float ao, out float cover) {
  vec2 i = floor(c);
  vec2 g = fract(c);
  float d1 = 8.0;
  vec2 rel = vec2(0.0);
  float size1 = 1.0;
  vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 o = vec2(float(k), float(y));
      float h = hash12(i + o + 2.3);
      vec2 at = o + 0.1 + 0.8 * vec2(hash12(i + o + 1.7), hash12(i + o + 6.1));
      vec2 root = (i + at) / vec2(16.0, 16.0 * depth);
      if (!countryTreeStands(ridge, root.x, countryDown(max(root.y - lift, 0.0), depth), near, h)) continue;
      float size = countryTreeSize(h);
      vec2 d = g - at;
      float dd;
      if (countryPine(h)) {
        vec2 pinePoint = vec2(d.x / 1.3, -d.y) * 2.0 / size;
        dd = max(abs(pinePoint.x) / max(countryPineWidth(pinePoint.y), 0.01),
                 abs((pinePoint.y - 0.2) / 1.2));
      } else {
        dd = length(d) / (0.62 * size);
      }
      if (dd < d1) {
        d1 = dd;
        rel = d;
        size1 = size;
        id = i + o;
      }
    }
  }
  cover = step(d1, 1.0);
  ao = 1.0 - smoothstep(0.35, 1.0, d1);
  float h = hash12(id + 2.3);
  vec2 r = rel / (0.62 * size1);
  vec3 normal = countryPine(h)
    ? normalize(vec3(rel.x / max(size1 * countryPineWidth(-rel.y * 2.0 / size1), 0.06), 0.38, -0.75))
    : normalize(vec3(r.x, -r.y + 0.2, -sqrt(max(1.0 - dot(r, r), 0.05))));
  return vec4(normal, h);
}

// The river winding down the second ridge toward us, from the saddle below the village: its centre
// across the slope (world x) at down-slope distance v, and the centre's drift per unit v.
vec2 countryRiver(float v, float start) {
  float x = start + 0.5 * v + 0.11 * sin(v * 9.0 + 0.8) + 0.04 * sin(v * 21.0 + 2.0);
  float dx = 0.5 + 0.99 * cos(v * 9.0 + 0.8) + 0.84 * cos(v * 21.0 + 2.0);
  return vec2(x, dx);
}

// Sun, moon and sky light on a surface with normal n. wrap: how far round the terminator the light
// reaches (wrapped Lambert; 0 is plain Lambert, so a low sun leaves faces turned away in shade).
// shade: how much direct sun gets through (cloud shadow, overcast, hedges and trees). Shaded faces
// still get a little warm light bounced off the sunlit land around them, so they stay warm rather
// than turning a muddy grey under the blue skylight. By night the eye adapts: moonlight counts for
// more and a cool skylight lifts the land, so moonlit fields read around 0.2 and snow pale blue-white
// rather than near black (and a moonless night stays dim but legible).
vec3 countryLight(Sky sky, vec3 n, float shade, float wrap) {
  float sun = clamp((dot(n, sky.sun) + wrap) / (1.0 + wrap), 0.0, 1.0) * shade;
  float moon = clamp((dot(n, sky.moon) + wrap) / (1.0 + wrap), 0.0, 1.0);
  vec3 adapted = sky.night * (vec3(0.08, 0.1, 0.16) * (0.7 + 0.3 * n.y) + sky.moonColor * (0.4 + 0.6 * moon));
  return sky.ambient * (0.6 + 0.25 * n.y) + sky.sunColor * (sun + 0.12) + sky.moonColor * moon + adapted;
}

// The valley mist's colour where the sight line meets it, at screen x and \`above\` scale heights
// over the valley floor: cool skylight in its depths, its top catching the low sun (warmest toward
// the sun, where the droplets scatter forward), moonlit by night.
vec3 countryMist(Sky sky, float x, float above, float overcast) {
  vec3 cool = sky.ambient * 1.3 + sky.moonColor * 0.7 + vec3(0.01, 0.012, 0.02);
  float toward = 0.5 + 0.5 * dot(normalize(vec2(x, 1.0)), normalize(sky.sun.xz));
  vec3 warm = cool * 0.8 + sky.sunColor * (0.55 + 0.6 * toward) * (1.0 - 0.7 * overcast);
  return mix(cool, warm, smoothstep(0.0, 2.0, above));
}

// The cloud deck, straight rgb and alpha like skyClouds. By night the shared deck's domain-warped
// detail reads as harsh moonlit swirls, so it gives way to a calm deck of the scene's own: two
// broad octaves (the finer one dropped toward the horizon, where it would crawl), soft edges, a
// gentle moonlit body silvered toward the moon, drifting with the wind like the day deck.
vec4 countryClouds(Sky sky, vec3 dir, float t, float cover, float wind) {
  vec4 day = sky.night < 1.0 ? skyClouds(sky, dir, t, cover, wind) : vec4(0.0);
  if (sky.night <= 0.0 || dir.y <= 0.015 || cover <= 0.0) return day;
  vec2 p = dir.xz / dir.y - vec2(0.09 * wind, -0.01) * uMotionTime;
  float fine = 1.0 - smoothstep(0.08, 0.3, 1.3 / (uRes.y * dir.y * dir.y));
  float n = 0.62 * vnoise(p * 0.55 + 4.3) + 0.38 * mix(0.5, vnoise(p * 1.3 + 9.1), fine);
  float th = mix(0.66, 0.3, cover);
  float alpha = smoothstep(th - 0.06, th + 0.26, n) * smoothstep(0.015, 0.22, dir.y) * 0.92;
  float thick = smoothstep(th, th + 0.4, n);
  vec3 mv = dir - sky.moon;
  vec3 body = sky.ambient * 1.1 + sky.moonColor * (0.35 - 0.15 * thick + 0.5 * exp(-dot(mv, mv) * 8.0) * (1.0 - thick));
  // Blend the two decks premultiplied, so a clear patch of one does not darken the other.
  vec4 m = mix(vec4(day.rgb * day.a, day.a), vec4(body * alpha, alpha), sky.night);
  return vec4(m.rgb / max(m.a, 1e-4), m.a);
}

// Any rain at all hangs a grey deck over the sky, 0..1.
float countryGrey(float rain) {
  return smoothstep(0.0, 0.05, rain);
}

// The sky dome as the weather has it: rain greys it and dims it a little; it stays the brightest
// thing in the scene, as an overcast sky does. No stars, no deck.
vec3 countryDome(Sky sky, vec3 dir, float rain) {
  vec3 c = skyColor(sky, dir);
  return greyed(c, vec3(0.92, 0.95, 1.0), 0.6 * countryGrey(rain)) * (1.0 - 0.2 * rain);
}

// The cloud deck as the weather has it. Rain brings its base down (low > 1: the same clouds, nearer,
// so they loom larger and race faster across the view) and turns it grey: an even, pale grey in a
// drizzle, a duller slate in a downpour.
vec4 countryDeck(Sky sky, vec3 dir, float t, float cover, float wind, float low, float rain) {
  vec4 c = countryClouds(sky, normalize(vec3(dir.x, dir.y * low, dir.z)), t, cover, wind);
  float grey = countryGrey(rain);
  c.rgb = greyed(c.rgb, vec3(0.94, 0.96, 1.0), 0.6 * grey) * (1.0 + 0.2 * grey - 0.35 * rain);
  return c;
}

// The farm track over the near field, from the bottom of the frame up over the brow toward the
// village: its centre across the slope (x at the ground's own depth, so it narrows into the
// distance) at down-slope distance v below the crest, and the centre's drift per unit v.
vec2 countryLane(float v, float start) {
  return vec2(start + 0.42 * v + 0.05 * sin(v * 6.0 + 1.1), 0.42 + 0.3 * cos(v * 6.0 + 1.1));
}

// Rain shafts hanging from the cloud base over the far hills: three curtains at distances D (world),
// each filling the view between the cloud base (\`base\` above the eye) and the ground at D, its feet
// trailing downwind as the drops drift in falling, so each shaft leans as a slanted column (a little
// even in still air), riding along with the deck. Steady rain hangs a few faint, separate shafts;
// heavier rain widens and darkens them until a downpour merges them into one grey wall; a drizzle
// leaves wisps of virga that thin out before they reach the ground. seen: distance to the pixel's
// own surface (world), so a shaft shows only in front of what lies beyond it; tm: the motion clock
// (uMotionTime). x: the shafts' opacity; y: how much the cloud base above them darkens.
vec2 countryShafts(vec2 p, float seen, float base, float tm, float rain, float wind) {
  float clear = 1.0;
  float belly = 0.0;
  float th = mix(0.66, 0.16, rain);
  float reach = mix(0.6, 1.5, smoothstep(0.1, 0.5, rain));
  float lean = (wind < 0.0 ? -0.25 : 0.25) + 0.6 * wind;
  for (int j = 0; j < 3; j++) {
    float fj = float(j);
    float D = 5.5 * pow(1.75, fj);
    if (seen <= D) break;
    // 0 at the cloud base .. 1 on the ground at D.
    float f = (COUNTRY_HORIZON + base / D - p.y) * D / (base + COUNTRY_EYE);
    if (f < -0.5 || f > 1.0) continue;
    // Along the curtain, in world units at D: the deck drifts 0.09 * wind cloud-base heights a
    // second (skyClouds), and the lower the drops the further downwind they have blown.
    float x = p.x * D - 0.09 * COUNTRY_CLOUD_BASE * wind * tm - lean * (base + COUNTRY_EYE) * max(f, 0.0);
    float n = 0.7 * vnoise(vec2(x * 0.6, 5.3 * fj + 1.0)) + 0.3 * vnoise(vec2(x * 1.9, 3.1 * fj + 7.0));
    float shaft = smoothstep(th, th + 0.22, n);
    belly = max(belly, shaft * smoothstep(-0.5, 0.0, f) * (1.0 - smoothstep(0.0, 0.35, f)));
    float hang = smoothstep(-0.04, 0.12, f) * (1.0 - smoothstep(reach - 0.45, reach, f));
    // Long streaks inside, slanting with the curtain and sliding slowly down.
    float streaks = 0.78 + 0.22 * vnoise(vec2(x * 5.0, p.y * 4.0 + tm * 0.5));
    clear *= 1.0 - shaft * hang * streaks * (0.15 + 0.5 * rain * rain);
  }
  return vec2(1.0 - clear, belly);
}

${countryWildlifeGlsl}

${countrySettlementsGlsl}
${countryAnimalsGlsl}
Shade sceneCountry(vec2 screenUv, vec2 cell, float t) {
  float m = uMotion;
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  float pxl = 1.0 / uRes.y;
  // Entrance and exit are one camera move: a vertical lens shift of the whole frame (the horizon
  // slides down the screen as the camera looks up), so the land, the sky, the cloud deck, its
  // shadows and the falling rain, all built from uv, stay in one projection. The camera arrives
  // from the sky and leaves toward it. arrive/leave are exactly 0 at rest, where uv == screenUv.
  float arrive = 1.0 - smoothstep(0.0, 1.0, passageIn());
  float leave = smoothstep(0.0, 1.0, passageOut());
  vec2 uv = screenUv + vec2(0.0, 0.3 * arrive + 0.3 * leave);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  // The village a third in from the left, the chalk down right of centre (screen x).
  vec2 spots = vec2(-0.2, 0.24) * aspect;
  countrySeed = K_landscape < 0.5 ? vec2(0.0) : (hash22(vec2(K_landscape, 17.3)) - 0.5) * 32.0;
  spots += countrySeed * 0.004 * aspect;
  float wind = K_wind;
  float season = K_season;
  float rain = K_rain;
  // How wet the land is and how much snow lies on it: the renderer lets both build up while it rains
  // or snows and fade after, so a shower leaves the track shining for a while.
  float wet = uWeather.x;
  float lying = uWeather.y;

  float tod = timeOfDayM(K_time, K_cycle, uMotionTime);
  Sky sky = skyAt(tod);
  // Rain falls from a grey deck over the whole sky, lower and darker the heavier it is: the sun is
  // lost behind it and its light, diffused through the cloud, comes from the whole sky instead, so
  // the light goes flat (no shadows, no modelling) but the land keeps its colours: bright in a
  // drizzle, dimmer in a downpour.
  float grey = countryGrey(rain);
  float low = 1.0 + 0.8 * rain;
  float lost = grey * (0.5 + 0.45 * rain);
  vec3 diffused = sky.sunColor * lost * (0.55 - 0.3 * rain);
  sky.sunColor *= 1.0 - lost;
  sky.moonColor *= 1.0 - grey * (0.4 + 0.3 * rain);
  sky.ambient = greyed(sky.ambient, vec3(0.95, 0.98, 1.04), 0.3 * grey) * (1.0 - 0.25 * rain) + diffused;
  float cover = clamp(max(K_clouds + 0.4 * K_snow + 0.3 * K_lightning, grey * (0.86 + 0.14 * smoothstep(0.15, 0.7, rain))), 0.0, 1.0);
  float overcast = smoothstep(0.55, 1.0, cover);
  // How dark it is for the villagers: the first lamps come on while the sun is still ~7 degrees up
  // (tod .70), most by sunset, all of them early in dusk (and earlier under a heavy sky).
  float dark = clamp(1.0 - smoothstep(-0.12, 0.2, sky.sun.y) + 0.3 * overcast + 0.2 * rain, 0.0, 1.0);
  // Mist gathers in the valleys around dawn and burns off as the sun climbs: a layer lying on the
  // valley floors, densest at the bottom and thinning with height (scale height fogTop, world
  // units), lower and thinner as the morning wears on.
  float dawn = (tod - 0.26) / 0.07;
  float burn = smoothstep(0.27, 0.42, tod) * (1.0 - smoothstep(0.62, 0.8, tod));
  float fog = min(K_fog * (0.55 + 0.9 * exp(-dawn * dawn)) * (1.0 - 0.55 * burn), 1.5);
  float fogTop = 0.03 + 0.03 * fog;
  vec3 air = sky.ambient + 0.5 * sky.sunColor + 0.4 * sky.moonColor;
  float seed = 0.0;
  float age = lightningAge(t, K_lightning, 0, seed);
  float flash = lightningFlash(age);

  // Front to back: the first ridge, or a tree or building standing on it, that covers the pixel.
  int hit = 6;
  float crest = 0.0;
  float groundCrest = 0.0;
  float valley = -1.0;
  vec2 q = p;
  float object = 0.0;
  vec4 crown = vec4(0.0);
  float treeShadow = 0.0;
  // The building hit, if any, and the smoke and window glow of every ridge passed (settlements.ts);
  // core: the village's on the third ridge.
  CountryVillage village = countryNoVillage();
  CountryVillage core = countryNoVillage();
  // How far off the surface the pixel sees is (world): the falling rain and snow stop there.
  float seen = 1e3;
  for (int k = 0; k < 6; k++) {
    float i = float(k);
    treeShadow = 0.0;
    vec4 L = countryLayer(i);
    // Nearer ridges slide further as the pointer moves.
    vec2 qi = p + uPointer * m * vec2(0.022, 0.01) / L.x;
    float terrain = 0.0;
    float c = countryCrest(i, qi.x, spots, terrain);
    // The village standing on this ridge (settlements.ts); what the knobs add is looked for after.
    if (k == 2) {
      core = countryVillage(qi, spots.x, L.y + 0.012, terrain, spots, tod, dark, uMotionTime, wind);
      village = countryNearer(village, core);
    }
    if (k < 2) {
      // Hedgerow trees, rooted on the face below and standing up over it (and over the crest).
      float r = 0.018 / L.x;
      float lift = r * 1.2;
      float sQ = c - qi.y + lift;
      if (sQ > -r) {
        // A root point above the crest still finds the trees standing on it.
        float sRoot = max(sQ, 0.0);
        vec2 fQ = countryFieldSpace(i, vec2(qi.x * L.x, countryDown(sRoot, L.x)));
        vec2 scale = vec2(L.x, countryDownRate(sRoot, L.x)) * COUNTRY_FIELDS;
        // Hedgerow trees give way to the tracks and a broadened river (routes.ts).
        countryClearing(i, vec2(qi.x * L.x, countryDown(sRoot, L.x)), spots);
        float density = 0.3 * (1.0 - 0.8 * countrySpots(qi.x, spots).x);
        crown = countryTrees(fQ, scale, r, density, max(-sQ, 0.0), sky.sun, treeShadow);
        // A building standing nearer than the tree's root hides it.
        if (crown.z > 0.5 && !countryHidesCrown(village, crown, qi.y, r)) {
          hit = k;
          crest = c;
          groundCrest = terrain;
          q = qi;
          object = 1.0;
          seen = L.x * (1.0 - 0.35 * smoothstep(0.0, 0.2, sRoot));
          break;
        }
      }
    }
    if (village.hit > 0.5) {
      hit = k;
      crest = c;
      groundCrest = terrain;
      q = qi;
      object = 2.0;
      seen = 0.9 * L.x;
      treeShadow = 0.0;
      break;
    }
    if (qi.y < c) {
      hit = k;
      crest = c;
      groundCrest = terrain;
      q = qi;
      break;
    }
    // What this ridge showed here, for a walker or cart over its skyline (routes.ts).
    countrySeen[k] = vec4(qi, c, terrain);
    valley = max(valley, c);
  }
  // The hamlets, farms and castle the knobs add (settlements.ts), out of the loop above so that,
  // switched off, their code leaves it lean: on the ridges passed, front to back as the loop meets
  // them, one standing nearer than what the pixel shows covers it (in front of a hedgerow tree
  // whose root lies behind it), and smoke and glow gather from every ridge up to the one shown.
  if (K_hamlets > 0.5 || K_farms > 0.0 || K_castle > 0.5) {
    CountryVillage passed = countryNoVillage();
    for (int k = 0; k < 6; k++) {
      if (k > hit) break;
      float i = float(k);
      vec4 L = countryLayer(i);
      vec4 at = k < hit ? countrySeen[k] : vec4(q, crest, groundCrest);
      CountryVillage here = countryNoVillage();
      if (k == 2) here = core;
      passed = countryNearer(passed, countrySettlements(i, at.xy, at.w, L, spots, tod, dark, uMotionTime, wind, here));
      if (passed.hit > 0.5 && (k < hit || object < 0.5 || object > 1.5 || countryHidesCrown(passed, crown, at.y, 0.018 / L.x))) {
        hit = k;
        q = at.xy;
        crest = at.z;
        groundCrest = at.w;
        object = 2.0;
        seen = 0.9 * L.x;
        treeShadow = 0.0;
        break;
      }
    }
    village = passed;
  }
  // A walker or cart (routes.ts) standing on the ground this pixel shows or in front of a building
  // on it, or over the skyline of a nearer ridge, covers it.
  vec4 agentFrame = vec4(0.0);
  float agentRidge = 0.0;
  float agentZ = 0.0;
  Figure agent = countryAgentAt(hit, object, village.front, q, crest, groundCrest, spots, dark, agentFrame, agentRidge, agentZ);
  if (agent.cover > 0.5) {
    hit = int(agentRidge);
    q = agentFrame.xy;
    crest = agentFrame.z;
    groundCrest = agentFrame.w;
    object = 5.0;
    seen = agentZ;
  }

  vec3 col = vec3(0.0);
  float accent = 0.0;
  float glint = 0.0;
  // The horizon at this x: the colour the land fades into with distance (by night a little lighter
  // than the sky there, as the adapted eye sees moonlit far hills).
  vec3 haze = countryDome(sky, normalize(vec3(q.x, 0.02, 1.0)), rain) + sky.night * vec3(0.03, 0.04, 0.07);
  // Raindrops are seen by the bright sky they refract: about 1.2x the overcast horizon (greyed a
  // little, as the cloud base is), with a floor so some rain still reads at night, plus the
  // lightning and lamplight by the village.
  vec3 dropCol = max(greyed(haze, vec3(1.0), 0.5) * 1.2, vec3(0.08)) + 0.5 * flash + COUNTRY_AMBER * village.glow * 0.12 * dark;
  float i = float(hit);

  if (hit < 6) {
    vec4 L = countryLayer(i);
    float d = L.x;
    float s = max(groundCrest - q.y, 0.0);
    float canopyDrop = max(crest - q.y, 0.0);
    vec2 w = vec2(q.x * d, countryDown(s, d));
    float down = countryDownRate(s, d);
    vec2 px = vec2(d, down) * pxl;
    vec2 near = countrySpots(q.x, spots);

    // Ground lighting follows the bare ridge and broad swells, never the treetop outline.
    float e = 2.0 * pxl;
    float lean = (countryGroundCrest(i, q.x + e, spots) - groundCrest) / e;
    float facing = 0.38 * sqrt(clamp(s / 0.12, 0.0, 1.0));
    vec2 hw = w * vec2(1.5, 2.2) + 3.0 * i;
    float h0 = vnoise(hw);
    vec2 hump = vec2(vnoise(hw + vec2(0.05, 0.0)) - h0, vnoise(hw + vec2(0.0, 0.05)) - h0) / 0.05;
    vec3 n = normalize(vec3(-lean * (1.0 - facing) * 0.9 - hump.x * 0.55, 1.0, -facing + hump.y * 0.3));

    // Depth of this point of ground (the face comes toward us below the crest), its height above
    // the valley floor, and row space for the crops: across at that depth, so rows running down
    // the slope converge into the distance.
    float z = d * (1.0 - 0.35 * smoothstep(0.0, 0.2, s));
    if (object < 0.5) seen = z;
    vec3 ground = vec3(q.x * z, (q.y - COUNTRY_HORIZON) * z, z);
    float height = COUNTRY_EYE + ground.y;
    vec2 rows = vec2(q.x * z, w.y);
    vec2 pxr = vec2(z, down) * pxl;
    // How fully lying snow covers this ground, 0..1: it settles first on the high far ridges, then
    // creeps down to the near fields. A pure function of the lying snow, so once that has settled
    // nothing here changes; crops under it stop swaying.
    float buried = smoothstep(0.0, 0.35, lying * 1.4 - 0.3 * vnoise(w * 2.5 + 11.0) - 0.1 * (1.0 - i / 5.0));
    // The same front for the trees and buildings, which carry their own snow (snowCover).
    float lyingHere = clamp(lying * 1.4 - 0.1 * (1.0 - i / 5.0), 0.0, 1.0);
    // Sunlight through the cloud deck: follow the sun from this point of ground up to the deck,
    // brought down by rain as the sky shows it (countryDeck).
    float sunShade = 1.0 - 0.75 * overcast;
    if (K_shadows > 0.0 && sky.sun.y > 0.0) {
      vec3 deck = ground + sky.sun * ((COUNTRY_CLOUD_BASE / low - ground.y) / max(sky.sun.y, 0.12));
      sunShade *= 1.0 - K_shadows * skyClouds(sky, normalize(vec3(deck.x, deck.y * low, deck.z)), t, cover, wind).a;
    }

    vec3 albedo = vec3(0.0);
    float settles = 1.0;   // how much of the lying snow shows here
    float snowy = -1.0;    // snow on a tree or building, which carries its own; below 0 on the land
    float porous = 0.8;    // how much rain soaks in and darkens: 0 slate .. 1 soil, thatch
    float glossy = 0.06;   // how much a wet surface mirrors the sky: fields little, the track and roofs most
    float water = 0.0;
    float lamp = 0.0;
    float chalk = 0.0;
    vec3 reflection = vec3(0.0);
    float relief = 0.5;    // crop rows: 1 on their ridges, where snow shows them
    float sheen = 0.0;     // low sun glancing off standing crops
    float shadow = treeShadow;
    float onLane = 0.0;    // 1 on the farm track
    float rut = 0.0;       // 1 in its wheel ruts
    vec2 lp = vec2(0.0);   // track space for its puddles: across, down the slope, ~0.007 world a unit
    if (object > 4.5) {
      // A walker or a cart (routes.ts): rain wets it like the land; snow settles only on a load's top.
      albedo = agent.albedo;
      n = agent.normal;
      lamp = agent.lamp;
      porous = 0.5;
      glossy = 0.12;
      snowy = agent.top * snowCover(n, q * 40.0, lyingHere);
      shadow = 0.0;
    } else if (object > 1.5) {
      albedo = village.albedo;
      n = village.normal;
      lamp = village.lamp;
      porous = village.porous;
      glossy = 0.15 + 0.2 * village.roof;
      // Snow lies on the roofs and the spire's ledges, never the walls, its edge broken over the tiles.
      snowy = village.roof * snowCover(n, q * 32.0, lyingHere);
    } else if (object > 0.5) {
      // A hedgerow tree: a leafy dome lit on the sun's side, darker underneath; in autumn each
      // turns its own colour.
      vec2 dc = crown.xy;
      n = normalize(vec3(dc.x, dc.y * 0.8 + 0.25, -sqrt(max(1.0 - dot(dc, dc), 0.0)) - 0.2));
      float th = fract(crown.w * 41.0);
      vec3 leaf = season < 0.5 ? vec3(0.2, 0.37, 0.13) : vec3(0.23, 0.36, 0.12);
      if (season > 1.5) leaf = th < 0.3 ? vec3(0.62, 0.36, 0.1) : (th < 0.55 ? vec3(0.5, 0.22, 0.08) : (th < 0.75 ? vec3(0.7, 0.56, 0.17) : vec3(0.2, 0.3, 0.11)));
      albedo = leaf * (0.82 + 0.36 * vnoise(q * uRes.y / 3.0)) * (0.7 + 0.3 * smoothstep(-1.0, 0.3, dc.y));
      porous = 0.3;
      glossy = 0.15;
      // Snow lies on the tops of the crowns, its edge ragged over the leaves; the undersides stay dark.
      snowy = snowCover(n, dc * 0.7 + crown.w * 31.0, lyingHere);
      shadow = 0.0;
    } else {
      // The patchwork.
      vec3 slope = n;
      vec2 site = vec2(0.0);
      vec2 other = vec2(0.0);
      vec2 axis = vec2(0.0);
      vec2 f = countryFieldSpace(i, w);
      vec2 field = countryCells(f, site, other, axis);
      float crop = countryFieldCrop(field.y, season);
      albedo = crop < 5.5
        ? countryCropColor(crop, field.y, season, w, rows, pxr, wind, 1.0 - buried, tm, relief, sheen)
        : (crop < 8.5
          ? countryFlowerMaterial(crop, field.y, season, w, rows, pxr, wind, 1.0 - buried, tm, relief, sheen)
          : countryPastureColor(field.y, season, w, pxr, relief, sheen));
      // Bare earth soaks rain up and darkens most; standing crops and grass, whose leaves shed it,
      // keep their colour and only deepen it.
      porous = crop > 1.5 && crop < 2.5 ? 0.85 : (crop > 3.5 && crop < 4.5 ? 0.55 : (crop > 4.5 && season > 1.5 ? 0.7 : 0.35));
      if (crop > 5.5 && crop < 8.5) {
        float under = 0.0;
        vec4 flowers = countryFlowers(crop, field.y, season, rows, z, down, wind, 1.0 - buried, tm, under);
        albedo = mix(albedo * (1.0 - under), flowers.rgb, flowers.a);
      } else if (hit < 2 && (crop > 0.5 && crop < 1.5 || crop > 3.5 && crop < 4.5 && season > 0.5 && season < 1.5)) {
        float under = 0.0;
        vec4 dots = countryDots(crop, w, d, down, tm, under);
        albedo = mix(albedo * (1.0 - under), dots.rgb, dots.a);
      }
      // Hedgerows along the borders, bushy and uneven: wider and narrower along their length,
      // rounded on top and lit on the sun's side, casting a shadow across the field beyond them.
      // On the two near ridges they keep at least the width the dither holds; farther off, where
      // they would be thinner, they only tint the seam between fields.
      vec2 fscale = vec2(d, down) * COUNTRY_FIELDS;
      vec2 toHedge = axis / fscale;   // on screen, y down
      float border = field.x * length(toHedge);
      toHedge = normalize(toHedge);
      float along = dot(f, vec2(-axis.y, axis.x));
      float hedgeMean = max(0.0065 / d, hit < 2 ? 1.3 * pxl : 0.0);
      float hedgeHalf = hedgeMean * (0.6 + 0.5 * vnoise(vec2(along * 7.0, field.y * 31.0)) + 0.25 * vnoise(vec2(along * 23.0, 3.0)));
      float holds = smoothstep(0.7, 1.3, hedgeMean * uRes.y);
      vec3 hedgeLeaf = season > 1.5 ? vec3(0.3, 0.24, 0.1) : vec3(0.13, 0.27, 0.1);
      albedo = mix(albedo, hedgeLeaf * 1.3, 0.4 * (1.0 - holds) * (1.0 - smoothstep(0.0, 1.5 * pxl, border)));
      // The sun's way across the ground on screen (y down): toward it, a hedge shades this field.
      float toSun = dot(toHedge, vec2(sky.sun.x, -0.4 * sky.sun.z));
      if (border < hedgeHalf && holds > 0.0) {
        // Across the hedge: its spine faces up, its flank on this side faces away from it.
        float u = border / hedgeHalf;
        n = normalize(mix(n, normalize(vec3(-toHedge.x * u, 1.0 - 0.6 * u, toHedge.y * u)), holds));
        albedo = mix(albedo, hedgeLeaf * (0.8 + 0.35 * vnoise(f * 30.0)), holds);
        // Snow caps the hedge tops and leaves their flanks dark, so the patchwork still shows under
        // snow: its pattern at a middling depth, brought in with the land's own front (buried).
        settles = 0.25 + 0.5 * snowCover(n, f * 2.0, 0.6);
        porous = 0.4;
        glossy = 0.08;
        relief = 0.5;
        sheen = 0.0;
      } else if (toSun > 0.0 && sky.sun.y > 0.0) {
        float reach = hedgeHalf * (1.0 + min(1.6 * toSun / max(sky.sun.y, 0.1), 6.0));
        shadow = max(shadow, (1.0 - smoothstep(0.75 * reach, reach, border)) * holds);
      }
      // Woods on the farther ridges. Resolved stands are whole crowns over a dark forest floor;
      // unresolved ones use the area mean. Pixels above the bare crest lie inside the treeline
      // silhouette, so they are always canopy and never stretched field.
      bool treetop = q.y > groundCrest;
      float woods = treetop ? 1.0 : countryWoods(i, w.x, w.y, near);
      float crowns = smoothstep(2.5, 5.0, 0.0625 / px.x);
      float ao = 1.0;
      float cover = 0.0;
      vec4 canopy = vec4(0.0, 0.55, -0.835, 0.5);
      float stand = countryWoodStand(i, w.x, w.y, near);
      bool standing = treetop || stand > 0.45;
      if (crowns > 0.0 && standing)
        canopy = countryCanopy(vec2(w.x, canopyDrop * d) * 16.0, i, d, crest - groundCrest, near, ao, cover);
      if (treetop) cover = 1.0;
      float trees = mix(woods, cover, crowns);
      if (trees > 0.0 || (crowns > 0.0 && standing)) {
        vec3 evergreen = vec3(0.085, 0.2, 0.145);
        vec3 leaf = vec3(0.12, 0.25, 0.11);
        if (countryPine(canopy.w)) leaf = evergreen;
        else if (season > 1.5) leaf = canopy.w < 0.3 ? vec3(0.5, 0.26, 0.08) : (canopy.w < 0.5 ? vec3(0.62, 0.45, 0.12) : vec3(0.14, 0.26, 0.1));
        vec3 broadleafMean = season > 1.5 ? vec3(0.38, 0.31, 0.1) : vec3(0.12, 0.25, 0.11);
        vec3 mean = mix(broadleafMean, evergreen, K_pines);
        // Between resolved crowns inside a stand: shaded needles and leaf litter, not open field.
        vec3 floorColor = mix(albedo, albedo * 0.45 + vec3(0.02, 0.04, 0.02), step(0.53, stand));
        vec3 resolved = mix(floorColor, leaf * (0.65 + 0.35 * ao), cover);
        albedo = mix(mix(albedo, mean, woods), resolved, crowns);
        n = normalize(mix(n, canopy.xyz, cover * crowns));
        settles = mix(settles, 0.35 + 0.4 * max(canopy.y, 0.0), trees);
        porous = mix(porous, 0.35, trees);
        glossy = mix(glossy, 0.08, trees);
        relief = mix(relief, 0.5, trees);
        sheen *= 1.0 - trees;
      }
      // The farm track up the near field and over its brow toward the village: two wheel ruts either
      // side of a grassy crown, cutting through the hedges. Rain darkens it and makes it shine, and
      // puddles gather in the ruts (once it is lit, below); snow shows the ruts as darker lines.
      if (hit == 0) {
        vec2 lane = countryLane(w.y, spots.x * 0.6);
        float side = (rows.x - lane.x) / sqrt(1.0 + lane.y * lane.y);
        float u = abs(side) / COUNTRY_LANE;
        if (u < 1.3) {
          onLane = 1.0 - smoothstep(1.0, 1.3, u);
          rut = 1.0 - smoothstep(0.1, 0.24, abs(u - 0.56));
          lp = vec2(side, w.y) * 150.0;
          vec3 track = vec3(0.56, 0.48, 0.36) * (0.88 + 0.24 * vnoise(lp * 0.8));
          track = mix(track, vec3(0.42, 0.34, 0.24), rut);
          vec3 sward = season > 1.5 ? vec3(0.36, 0.42, 0.19) : vec3(0.3, 0.47, 0.18);
          track = mix(track, sward, 1.0 - smoothstep(0.16, 0.3, u));
          albedo = mix(albedo, track, onLane);
          n = normalize(mix(n, slope, onLane));
          settles = mix(settles, 0.95 - 0.4 * rut, onLane);
          relief = mix(relief, 0.5, onLane);
          sheen *= 1.0 - onLane;
          porous = mix(porous, 0.5, onLane);
          glossy = mix(glossy, 0.6, onLane);
        }
      }
      // The tracks beyond the near field (routes.ts), as K_tracks brings them in: worn like the lane
      // (the street and the valley road metalled, the hill track chalk), plainer as the knob rises,
      // opening the hedges and passing under the woods. Narrower than the dither holds, a track thins
      // rather than breaking up; its grassy crown and ruts show only where they hold.
      if (hit > 0 && K_tracks > 0.0) {
        vec2 axis = vec2(0.0);
        vec4 route = countryRouteAt(i, w, s, groundCrest, spots, K_tracks, axis);
        float cells = route.y * length(axis / vec2(z, down)) * uRes.y;
        float hold = min(cells / 0.7, 1.0);
        float u = abs(route.x) * hold / route.y;
        if (route.z > 0.0 && u < 1.3) {
          onLane = (1.0 - smoothstep(1.0, 1.3, u)) * route.z * hold * (1.0 - trees);
          rut = (1.0 - smoothstep(0.1, 0.24, abs(u - 0.56))) * smoothstep(2.5, 5.0, cells);
          lp = vec2(route.x, w.x + w.y) * 150.0;
          albedo = mix(albedo, countryTrackColor(route.w, u, rut, lp, cells, season), onLane);
          n = normalize(mix(n, slope, onLane));
          settles = mix(settles, 0.95 - 0.4 * rut, onLane);
          relief = mix(relief, 0.5, onLane);
          sheen *= 1.0 - onLane;
          porous = mix(porous, route.w > 0.5 && route.w < 1.5 ? 0.25 : 0.5, onLane);
          glossy = mix(glossy, 0.6, onLane);
        }
      }
      // The river on the second ridge, mirroring the sky between reedy banks. K_river scales its open
      // water (routes.ts; 1 is the original stream): the reeds widen more slowly, a broad river shows
      // shingle at its edge, and a brook too narrow for the dither thins instead of breaking up.
      if (hit == 1) {
        vec2 river = countryRiver(w.y, (spots.x + 0.07) * d);
        float across = abs(w.x - river.x) / sqrt(1.0 + river.y * river.y);
        float bank = 0.012 + 0.008 * clamp(w.y / 0.6, 0.0, 1.0);
        float broad = countryRiverScale();
        float open = bank * broad;
        float thin = 1.0;
        if (broad < 1.0) {
          float least = 0.6 * d / uRes.y;
          thin = open / max(open, least);
          open = max(open, least);
        }
        if (thin >= 1.0 && across < countryRiverReeds(bank, broad)) {
          albedo = vec3(0.16, 0.24, 0.1) * (0.85 + 0.3 * vnoise(f * 40.0));
          settles = 0.6;
          relief = 0.5;
          sheen = 0.0;
          porous = 0.5;
        }
        if (broad > 1.0 && across < open + 0.3 * bank * (broad - 1.0)) {
          // Shingle and mud between a broad river and its reeds.
          albedo = vec3(0.58, 0.53, 0.44) * (0.85 + 0.3 * vnoise(f * 60.0));
          settles = 0.8;
          porous = 0.7;
          glossy = 0.3;
        }
        if (across < open) {
          // Raindrops dimple it: rings of light spreading from each drop, sized on screen so they
          // stay several cells apart, each cell lit or not against its own threshold so a passing
          // ring flips it once instead of crawling through the colour steps.
          vec3 rr = rainRipples(vec2(q.x, q.y * 1.6) * uRes.y / 20.0, t, rain);
          float ring = hardEdge(rr.z * 1.4, threshold(cell + vec2(6.0, 1.0)));
          vec3 view = normalize(vec3(q.x, q.y - COUNTRY_HORIZON, 1.0));
          vec3 mirrored = vec3(view.x, -view.y, view.z);
          vec4 cloud = countryDeck(sky, mirrored, t, cover, wind, low, rain);
          float ripple = vnoise(vec2(w.x * 60.0, w.y * 25.0 - tm * 0.6));
          reflection = mix(countryDome(sky, mirrored, rain), cloud.rgb, cloud.a) * (0.82 + 0.25 * ripple) + dropCol * ring * 0.3;
          water = 0.85;
          settles = 0.0;
          glint = smoothstep(0.6, 0.9, ripple) * (1.0 - grey);
          if (thin < 1.0) {
            water *= thin;
            glint *= thin;
          }
        }
        // The stone bridge taking the bridge track over it (routes.ts), seen from downstream: the
        // deck and its parapets, the face toward us with its arch in shadow over the water.
        vec4 bridge = countryBridge(w, z, down, spots);
        if (bridge.x > 0.5) {
          float stone = 0.86 + 0.2 * vnoise(vec2(w.x * 300.0, q.y * uRes.y * 0.5));
          albedo = (bridge.w > 0.5 ? vec3(0.74, 0.71, 0.64) : (bridge.y > 0.5 ? vec3(0.5, 0.47, 0.42) : vec3(0.6, 0.55, 0.47))) * stone;
          n = bridge.y > 0.5 ? normalize(vec3(0.0, 0.15, -1.0)) : slope;
          if (bridge.z > 0.5) albedo = vec3(0.05, 0.06, 0.07);
          settles = bridge.y > 0.5 ? 0.0 : 0.9;
          porous = 0.3;
          glossy = 0.2;
          relief = 0.5;
          sheen = 0.0;
          water = 0.25 * bridge.z;
          glint = 0.0;
          onLane *= 1.0 - bridge.y;
        }
      }
      // Pasture enclosures (animals.ts): their post-and-rail fences and grazing herds, standing in
      // front of the grass, hedges, track and river behind them; snow settles on their backs.
      if (K_pasture > 0.0 && hit < 3 && !treetop) {
        CountryStock stock = countryStock(i, q, s, lean, w, down, f, field, site, axis, crop, season, hedgeMean, spots);
        albedo = mix(albedo * (1.0 - stock.shadow), stock.albedo, stock.cover);
        if (stock.cover > 0.0) {
          n = normalize(mix(n, stock.normal, stock.cover));
          snowy = mix(buried * settles * (0.8 + 0.2 * relief), stock.snow * snowCover(stock.normal, w * 300.0, lyingHere), stock.cover);
          porous = mix(porous, stock.porous, stock.cover);
          glossy = mix(glossy, 0.1, stock.cover);
          sheen *= 1.0 - stock.cover;
          onLane *= 1.0 - stock.cover;
          water *= 1.0 - stock.cover;
        }
      }
      // The chalk figure: an M cut through the turf of the down, foreshortened on its slope like
      // the Uffington White Horse, read whole only from across the valley.
      if (hit == 3 && K_chalk > 0.5) {
        float unit = 0.12 * d / 0.94;
        vec2 mq = vec2(w.x - spots.y * d, countryDown(0.036, d) - w.y) / unit;
        chalk = 1.0 - smoothstep(0.075, 0.09, markDistance(mq));
        albedo = mix(albedo, vec3(0.93, 0.92, 0.86) * (0.94 + 0.06 * vnoise(f * 20.0)), chalk);
        porous = mix(porous, 0.3, chalk);
      }
      // A walker or cart too small to draw tints the ground it stands on; nearer ones shade it at
      // their feet (routes.ts).
      if (agent.faint > 0.0 || agent.shadow > 0.0) {
        albedo = mix(albedo, agent.albedo, agent.faint);
        shadow = max(shadow, agent.shadow);
      }
    }

    // Rain soaks in, darkening and deepening the colours. Snow whitens the land, the ridges of the
    // crop rows holding it first so the rows still show faintly through; trees and roofs carry their own.
    albedo = wetten(albedo, wet, porous);
    float snowCov = snowy >= 0.0 ? snowy : buried * settles * (0.8 + 0.2 * relief);
    albedo = mix(albedo, COUNTRY_SNOW, snowCov);

    // Direct sun through cloud and the shadows of hedges and trees; the land takes it with little
    // wrap so a low sun models the hills, trees and buildings a little softer.
    float lit = sunShade * (1.0 - 0.8 * shadow);
    col = albedo * countryLight(sky, n, lit, object > 0.5 ? 0.35 : 0.2);
    col += albedo * sky.sunColor * lit * sheen * 0.3 * (1.0 - snowCov);
    // A wet surface mirrors the sky low over the land, flat ground and roofs most: the bright grey
    // of the cloud under the rain, gold when the sun breaks through after it.
    col = mix(col, haze, wetGloss(wet, n.y) * glossy * (1.0 - snowCov));
    // Puddles gather in the track's ruts as it wets, mirroring the sky, ringed by the drops landing
    // in them (calm rings, as on the river).
    if (onLane > 0.0 && wet > 0.0) {
      float puddle = rainPuddles(lp, wet) * (0.4 + 0.6 * rut) * onLane * (1.0 - snowCov);
      if (puddle > 0.0) {
        vec3 rr = rainRipples(vec2(q.x, q.y * 2.0) * uRes.y / 22.0, t, rain);
        float ring = hardEdge(rr.z * 1.4, threshold(cell + vec2(6.0, 1.0)));
        vec3 view = normalize(vec3(q.x, q.y - COUNTRY_HORIZON, 1.0));
        vec3 mirrored = vec3(view.x, -view.y, view.z);
        vec4 cloud = countryDeck(sky, mirrored, t, cover, wind, low, rain);
        reflection = mix(countryDome(sky, mirrored, rain), cloud.rgb, cloud.a) * 0.9 + dropCol * ring * 0.25;
        water = 0.85 * puddle;
      }
    }
    col = mix(col, reflection, water);
    // Drops bouncing off the hard track, sized on screen: a splash rises toward us, unforeshortened.
    if (onLane > 0.0 && rain > 0.0) {
      col += dropCol * rainSplashes(q * uRes.y / 34.0, t, rain) * 0.45 * onLane * (1.0 - snowCov);
    }
    if (lamp > 0.0) {
      col = mix(col, COUNTRY_AMBER, lamp);
      accent = lamp;
    }
    accent = max(accent, 0.75 * chalk);

    // Atmospheric perspective: farther ridges paler and bluer (the horizon's colour) and softer.
    // Under rain the falling rain's own veil carries most of the distance (below), and the land
    // fades toward a grey a little darker and bluer than the sky, so each ridge stays apart from it.
    col = mix(col, haze * mix(vec3(1.0), vec3(0.82, 0.86, 0.94), grey), 1.0 - exp(-d * (0.055 + 0.07 * overcast * (1.0 - 0.5 * grey) + 0.03 * fog)));
    // Valley mist: the sight line's optical depth through a layer whose density falls off
    // exponentially with height (closed form for the straight ray from the eye down to this
    // point), so it pools in the hollows behind each ridge while crests, trees and the spire stand
    // clear (ground above eye level, which the formula would make negative, takes none). The
    // nearest slope, just below us, only takes a little. A slow drift varies it.
    if (fog > 0.0) {
      float hy = max(height, -0.05);
      float tau = 6.0 * fog * z / max(COUNTRY_EYE - hy, 0.05) * fogTop * max(exp(-hy / fogTop) - exp(-COUNTRY_EYE / fogTop), 0.0);
      tau *= (hit == 0 ? 0.3 : 1.0) * (0.75 + 0.5 * vnoise(vec2(w.x * 1.3 - tm * 0.01, hy * 12.0 + 2.0 * i)));
      col = mix(col, countryMist(sky, q.x, hy / fogTop, overcast), min(1.0 - exp(-tau), 0.97));
    }
    // The morning haze thinning as the camera comes down: the horizon's colour over the land,
    // heaviest on the far ridges.
    if (arrive > 0.0) col = mix(col, haze, arrive * (0.12 + 0.2 * i / 5.0));
  } else {
    vec3 dir = viewRay(uv, aspect, COUNTRY_HORIZON, COUNTRY_FOV);
    col = countryDome(sky, dir, rain);
    vec4 cloud = countryDeck(sky, dir, t, cover, wind, low, rain);
    col += skyStars(sky, dir, 0.4) * vec3(0.9, 0.93, 1.0) * (1.0 - cloud.a);
    col = mix(col, cloud.rgb, cloud.a);
    col = mix(col, countryMist(sky, p.x, 2.0, overcast), fogAmount(min(fog, 1.0), 1.0, max(p.y - valley, 0.0) * 12.0 / 0.25));
  }

  // The settlements' life: warm light around lit windows (pooling on wet ground), smoke drifting
  // over whatever lies behind.
  col += COUNTRY_AMBER * village.glow * 0.12 * dark * (1.0 - village.lamp) * (1.0 + 1.5 * wet);
  col = mix(col, vec3(0.8, 0.8, 0.83) * air, village.smoke * 0.75);

  // Birds and the starling murmuration (wildlife.ts), in the air in front of the shaded surface.
  countryWildlife(col, seen, accent, p, uv, spots, sky, haze, tod, overcast);

  // Lightning over the far hills: bolts to the fourth ridge, behind the rain.
  if (age < 2.0 && hit >= 4) {
    float bx = (fract(seed * 7.13) - 0.5) * aspect * 0.8;
    float gx = bx + (fract(seed * 3.71) - 0.5) * 0.12;
    float boltTerrain = 0.0;
    float boltCrest = countryCrest(4.0, gx, spots, boltTerrain);
    float bolt = lightningBolt(p, vec2(bx, 0.92), vec2(gx, boltCrest - 0.004), seed, age);
    col += vec3(0.85, 0.9, 1.0) * bolt;
  }
  // The whole scene flashing.
  col += vec3(0.5, 0.55, 0.7) * flash * (hit == 6 ? 0.45 : 0.25);

  // Rain and snow falling through the air as far as the first surface: the veil of all that lies
  // too deep to resolve, then the drops and flakes themselves (already calm, cell by cell). Their
  // depth runs 0 at the eye .. 1 at the horizon, not to scale (the land lies hundreds of metres off,
  // beyond any drop the eye resolves). For rain the near field sits a sixth to a fifth of the way
  // in, so only the nearest, sparse drops fall in front of it while the dense fine rain hangs in the
  // valleys beyond, and the veil deepens ridge by ridge into the distance. Snow keeps a shorter
  // scale, more flakes drifting in front of the near fields.
  if (rain > 0.0) {
    Precip pr = rainFall(uv, aspect, t, rain, wind, 1.0 - exp(-seen / 4.0));
    col = mix(col, mix(vec3(dot(haze, LUMA)) * vec3(0.94, 0.97, 1.0), haze, 0.4) + 0.25 * flash, pr.veil);
    // Rain shafts hanging under the cloud base over the far hills: darker slanted columns of denser
    // rain against the lighter cloud and haze, the base a little darker where they leave it.
    vec2 shafts = countryShafts(p, seen, COUNTRY_CLOUD_BASE / low, tm, rain, wind);
    if (hit == 6) col *= 1.0 - 0.2 * rain * shafts.y;
    col = mix(col, mix(vec3(dot(haze, LUMA)), haze, 0.35) * 0.6, shafts.x);
    // The drops, already levelled to cross a dither step; the nearest, out of focus, a little dimmer.
    col = mix(col, dropCol * (1.0 - 0.15 * pr.near), pr.cover);
  }
  if (K_snow > 0.0) {
    Precip ps = snowFall(uv, aspect, t, K_snow, wind, 1.0 - exp(-seen / 2.5));
    vec3 flake = vec3(0.95, 0.96, 1.0) * clamp(air * 1.3 + 0.1, 0.0, 1.0);
    // A blizzard whites out the distance.
    col = mix(col, flake * 0.92, ps.veil);
    // Flakes at most 85% so the passing of each one crosses fewer dither steps against the dark sky;
    // against pale snow-covered land they all but vanish, as falling snow does, instead of speckling it.
    float contrast = clamp((dot(flake, LUMA) - dot(col, LUMA)) * 3.0, 0.0, 1.0);
    col = mix(col, flake, clamp(ps.cover, 0.0, 1.0) * (0.85 - 0.2 * ps.near) * contrast);
  }

  // Light coming up on arrival; on leaving, the cloud's grey closing over and the light dimming.
  if (arrive > 0.0 || leave > 0.0) {
    col *= 1.0 - 0.06 * arrive - 0.06 * leave;
    col = mix(col, vec3(dot(col, LUMA)), 0.22 * leave);
  }
  vec3 rgb = clamp(col, 0.0, 1.0);
  Shade o = shadeOf(rgb, inkOf(rgb, 1.1, 1.0), clamp(accent, 0.0, 1.0));
  o.shimmer = glint * 0.3;
  return o;
}
`;
