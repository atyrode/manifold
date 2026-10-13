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

export const countryGlsl = /* glsl */ `
const float COUNTRY_HORIZON = 0.62;      // eye level, uv.y
const float COUNTRY_EYE = 0.36;          // eye height above the valley floor (world unit: a screen height at depth 1)
const float COUNTRY_FOV = 0.9273;        // 2 atan(1/2): viewRay's focal length is one screen height
const float COUNTRY_SLOPE = 1.25;        // down-slope stretch of the faces
const float COUNTRY_ROUND = 0.004;       // how sharply a face folds over at its crest
const float COUNTRY_CLOUD_BASE = 1.6;    // cloud deck height above the eye, world units
const float COUNTRY_RECEDE = 0.22;       // how steeply a building's long wall runs away up the screen
const vec2 COUNTRY_FIELDS = vec2(3.0, 4.2); // fields per world unit across, down the slope
const vec3 COUNTRY_AMBER = vec3(1.0, 0.7, 0.3);
const vec3 COUNTRY_SNOW = vec3(0.9, 0.92, 0.95);

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
    n += a * vnoise(vec2(x, row + 3.1 * float(k)));
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

// Woodland cover on ridge i at slope point (wx across, wv down), 0..1: masses on the far hills,
// thickest toward the crests, copses on the middle ridge; never on the near fields, the village
// knoll or the chalk down.
float countryWoods(float i, float wx, float wv, vec2 near) {
  if (i < 1.5) return 0.0;
  float lean = i < 2.5 ? -0.1 : (i < 4.5 ? 0.06 : 0.14);
  float n = 0.65 * vnoise(vec2(wx * 1.1, wv * 1.6 + 7.3 * i)) + 0.35 * vnoise(vec2(wx * 2.9 + 4.1, wv * 3.3 + 2.9 * i));
  float keep = i < 2.5 ? 1.0 - near.x : (i < 3.5 ? 1.0 - near.y : 1.0);
  return smoothstep(0.5, 0.56, n + lean + 0.12 * exp(-3.0 * wv)) * keep;
}

// Silhouette of ridge i at screen x. The second ridge opens a saddle onto the village, the third
// carries the village knoll and dips in front of the chalk down, the fourth lifts the down into
// view. Woods raise the line by their height, in rounded crowns.
float countryCrest(float i, float x, vec2 spots) {
  vec4 L = countryLayer(i);
  float c = L.y + L.z * (2.0 * countryRidge(x * L.w + 11.0 * i, 5.0 * i + 0.5) - 1.0);
  vec2 near = countrySpots(x, spots);
  if (i > 0.5 && i < 1.5) c = mix(c, L.y - 0.06, 0.75 * near.x);
  if (i > 1.5 && i < 2.5) c = mix(c, L.y + 0.012, 0.8 * near.x) - 0.06 * near.y;
  if (i > 2.5 && i < 3.5) c = mix(c, L.y + 0.035, 0.7 * near.y);
  float wx = x * L.x;
  float woods = countryWoods(i, wx, 0.0, near);
  if (woods > 0.0) {
    float u = wx * 16.0 + 0.7 * vnoise(vec2(wx * 4.0, i + 0.5));
    float f = fract(u) * 2.0 - 1.0;
    float dome = sqrt(max(1.0 - f * f, 0.0)) * (0.55 + 0.45 * hash12(vec2(floor(u), i)));
    c += woods * (0.03 + 0.022 * dome) / L.x;
  }
  return c;
}

// Down-slope distance (world) at a drop s below the crest of a ridge at depth d, and its rate
// (world units per screen unit): steep near the crest, where the slope is seen edge-on.
float countryDown(float s, float d) {
  return d * COUNTRY_SLOPE * (sqrt(max(s, 0.0) + COUNTRY_ROUND) - sqrt(COUNTRY_ROUND));
}
float countryDownRate(float s, float d) {
  return d * COUNTRY_SLOPE * 0.5 / sqrt(max(s, 0.0) + COUNTRY_ROUND);
}

// Field space for ridge i: slope coordinates in fields, offset per ridge and domain-warped so the
// borders wander like old enclosures.
vec2 countryFieldSpace(float i, vec2 w) {
  vec2 f = w * COUNTRY_FIELDS + vec2(31.7 * i, 7.3 * i);
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
// 2 ploughed, 3 rapeseed, 4 stubble, 5 meadow (summer hay; in autumn, new shoots of winter wheat).
float countryCrop(float h, float season) {
  if (season < 0.5) return h < 0.3 ? 0.0 : (h < 0.62 ? 1.0 : (h < 0.76 ? 3.0 : (h < 0.9 ? 5.0 : 2.0)));
  if (season < 1.5) return h < 0.38 ? 0.0 : (h < 0.66 ? 1.0 : (h < 0.86 ? 4.0 : 2.0));
  return h < 0.4 ? 2.0 : (h < 0.72 ? 1.0 : (h < 0.84 ? 4.0 : 5.0));
}

// The crop's colour at slope point w (world). h: the field's hash; px: world size of a cell across
// and down; wind -1..1; t: the scene clock already scaled by motion.
vec3 countryCropColor(float crop, float h, float season, vec2 w, vec2 px, float wind, float t) {
  float h2 = fract(h * 13.7);
  float h3 = fract(h * 71.3);
  // Gusts roll downwind across standing crops as broad bands (the bent stalks show their paler
  // sides), stretched across the wind, with finer ripples riding on them.
  float drift = t * wind * 0.35;
  float gust = vnoise(vec2((w.x - drift) * 3.2, w.y * 1.4 + h * 9.0)) - 0.5;
  float ripple = (vnoise(vec2((w.x - drift * 1.7) * 9.0, w.y * 4.0 + 5.0)) - 0.5) * countryHold(0.11, vec2(1.0, 0.0), px);
  float wave = (gust + 0.6 * ripple) * (0.14 + 0.5 * abs(wind));
  vec3 col = vec3(0.0);
  if (crop < 0.5) {
    col = (season < 0.5 ? vec3(0.66, 0.66, 0.3) : vec3(0.86, 0.66, 0.27)) * (1.0 + wave);
  } else if (crop < 1.5) {
    col = season < 0.5 ? vec3(0.3, 0.52, 0.2) : (season < 1.5 ? vec3(0.38, 0.52, 0.21) : vec3(0.31, 0.45, 0.19));
    col *= 1.0 + 0.16 * (vnoise(w * vec2(40.0, 52.0)) - 0.5) * countryHold(0.025, vec2(0.7), px);
  } else if (crop < 2.5) {
    // Furrows: mostly along the contour, curving with the hill; some run straight down the slope.
    float a = (h2 < 0.6 ? 0.0 : 1.5708) + (h3 - 0.5) * 0.7;
    vec2 across = vec2(sin(a), cos(a));
    float furrow = 0.5 + 0.5 * sin(dot(w, across) * TAU / 0.022);
    vec3 earth = season > 1.5 ? vec3(0.3, 0.2, 0.13) : vec3(0.42, 0.31, 0.2);
    col = mix(earth, mix(earth * 0.68, earth * 1.22, furrow), countryHold(0.022, across, px));
  } else if (crop < 3.5) {
    col = vec3(0.94, 0.8, 0.14) * (1.0 + 0.4 * wave + 0.08 * (vnoise(w * 45.0) - 0.5) * countryHold(0.022, vec2(0.7), px));
  } else if (crop < 4.5) {
    // Stubble: the combine's passes as alternating pale and darker swaths down the slope.
    float a = (h2 - 0.5) * 0.8;
    vec2 across = vec2(cos(a), sin(a));
    float swath = step(0.5, fract(dot(w, across) / 0.04));
    vec3 straw = season > 1.5 ? vec3(0.66, 0.6, 0.42) : vec3(0.8, 0.7, 0.46);
    col = mix(straw, mix(straw * 0.92, straw * 1.08, swath), countryHold(0.04, across, px));
  } else if (season < 0.5) {
    // Hay meadow, flecked with flowers where the dither can hold them.
    float fleck = step(0.8, vnoise(w * 70.0)) * countryHold(0.015, vec2(0.7), px);
    col = mix(vec3(0.5, 0.6, 0.28) * (1.0 + 0.6 * wave), vec3(0.86, 0.82, 0.9), 0.5 * fleck);
  } else {
    // Winter wheat coming up: green drill rows on brown earth.
    float row = 0.5 + 0.5 * sin(w.x * TAU / 0.018);
    col = mix(vec3(0.36, 0.38, 0.2), mix(vec3(0.38, 0.28, 0.18), vec3(0.32, 0.48, 0.2), row), countryHold(0.018, vec2(1.0, 0.0), px));
  }
  return col * (0.93 + 0.14 * h3);
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
// would be rooted; scale: field units per screen unit across/down there; r: crown radius on screen.
// above: how far the pixel's root point lies above the crest (screen), for crowns standing over it.
// Returns the crown under the pixel: xy disc coordinates (y up), z 1 on a crown, w the tree's hash.
vec4 countryTrees(vec2 f, vec2 scale, float r, float density, float above) {
  vec2 site = vec2(0.0);
  vec2 other = vec2(0.0);
  vec2 axis = vec2(0.0);
  countryCells(f, site, other, axis);
  vec2 mid = 0.5 * (site + other);
  vec2 along = vec2(-axis.y, axis.x);
  vec4 best = vec4(0.0);
  float nearest = 1.0;
  for (int j = -1; j <= 1; j++) {
    float th = hash12(floor((site + other) * 37.0) + float(j) * 3.7);
    if (th > density) continue;
    vec2 ds = (f - (mid + along * (0.3 * float(j)))) / scale;
    ds.y = above - ds.y;
    float rad = r * (0.7 + 0.3 * fract(th * 17.3));
    float dd = length(ds) / rad;
    if (dd < nearest) {
      nearest = dd;
      best = vec4(ds / rad, 1.0, th);
    }
  }
  return best;
}

// A woodland canopy seen from the side: packed round crowns (cellular), each a dome. c: crown space
// (one crown per unit, y down the slope). Returns the dome normal (xyz) and the crown's hash (w);
// ao darkens the gaps between crowns.
vec4 countryCanopy(vec2 c, out float ao) {
  vec2 i = floor(c);
  vec2 g = fract(c);
  float d1 = 8.0;
  vec2 rel = vec2(0.0);
  vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 o = vec2(float(k), float(y));
      vec2 at = o + 0.2 + 0.6 * vec2(hash12(i + o + 1.7), hash12(i + o + 6.1));
      vec2 d = g - at;
      float dd = dot(d, d);
      if (dd < d1) {
        d1 = dd;
        rel = d;
        id = i + o;
      }
    }
  }
  ao = 1.0 - smoothstep(0.12, 0.5, d1);
  return vec4(normalize(vec3(rel.x, -rel.y + 0.2, -sqrt(max(0.45 - d1, 0.03)))), hash12(id + 2.3));
}

// The river winding down the second ridge toward us, from the saddle below the village: its centre
// across the slope (world x) at down-slope distance v, and the centre's drift per unit v.
vec2 countryRiver(float v, float start) {
  float x = start + 0.5 * v + 0.11 * sin(v * 9.0 + 0.8) + 0.04 * sin(v * 21.0 + 2.0);
  float dx = 0.5 + 0.99 * cos(v * 9.0 + 0.8) + 0.84 * cos(v * 21.0 + 2.0);
  return vec2(x, dx);
}

// Sun, moon and sky light on a surface with normal n (wrapped Lambert, so faces turned a little
// away still read). shade: how much direct sun gets through (cloud shadow, overcast).
vec3 countryLight(Sky sky, vec3 n, float shade) {
  float sun = clamp(dot(n, sky.sun) * 0.75 + 0.25, 0.0, 1.0) * shade;
  float moon = clamp(dot(n, sky.moon) * 0.75 + 0.25, 0.0, 1.0);
  return sky.ambient * (0.55 + 0.25 * n.y) + sky.sunColor * sun * 0.85 + sky.moonColor * moon;
}

// Whether a window is lit (0/1). h: the window's hash. Windows come on one by one as the light
// fails (or on a dark stormy day), most go dark between half past ten and two, and a few early
// risers light up again before dawn; only \`share\` of them ever light.
float countryWindow(float h, float tod, float dark, float share) {
  if (fract(h * 7.31) >= share) return 0.0;
  float on = step(0.12 + 0.6 * fract(h * 3.17), dark);
  float clock = tod < 0.5 ? tod + 1.0 : tod;   // from noon: 1.0 midnight, 1.25 dawn
  float bed = 0.94 + 0.14 * fract(h * 5.71);
  float rise = fract(h * 9.13) < 0.3 ? 1.2 + 0.05 * fract(h * 2.9) : 1.6;
  return on * (1.0 - step(bed, clock) * step(clock, rise));
}

// Where a cottage's chimney stands (its top), in cottage units; see countryCottage.
vec2 countryStack(float len, float wall, float rise) {
  vec2 eave = vec2(0.08, wall - 0.07);
  vec2 rafter = vec2(-0.5, wall + rise + 0.05) - eave;
  vec2 run = vec2(len + 0.06, (len + 0.06) * COUNTRY_RECEDE);
  return eave + 0.82 * rafter + 0.72 * run + vec2(0.0, 0.3);
}

// A building seen corner-on, in its own units: the gable end (1 wide, eaves \`wall\` up, ridge
// \`rise\` above them) faces front-left; the long wall (\`len\`) faces front-right and runs away up
// the screen; the roof over it is the gable's right-hand rafter swept along the house. q has x
// mirrored for buildings facing the other way. Returns the face under q: 0 none, 1 gable end,
// 2 long wall, 3 roof, 4 chimney; pane gets 1..3 on a window.
float countryCottage(vec2 q, float len, float wall, float rise, bool stack, out float pane) {
  pane = 0.0;
  vec2 ridge = vec2(-0.5, wall + rise);
  vec2 eave = vec2(0.08, wall - 0.07);
  vec2 rafter = ridge + vec2(0.0, 0.05) - eave;
  vec2 run = vec2(len + 0.06, (len + 0.06) * COUNTRY_RECEDE);
  if (stack) {
    vec2 top = countryStack(len, wall, rise);
    if (abs(q.x - top.x) < 0.085 && q.y > top.y - 0.5 && q.y < top.y) return 4.0;
  }
  // Roof: q = eave + a * rafter + b * run, inside for a, b in 0..1.
  vec2 rel = q - eave;
  float det = rafter.x * run.y - rafter.y * run.x;
  float a = (rel.x * run.y - rel.y * run.x) / det;
  float b = (rafter.x * rel.y - rafter.y * rel.x) / det;
  if (a >= 0.0 && a <= 1.0 && b >= 0.0 && b <= 1.0) return 3.0;
  // Gable end, edged by the verge of the roof along its left-hand rafter.
  if (q.x >= -1.06 && q.x <= 0.0 && q.y >= 0.0) {
    if (segmentDistance(q, vec2(-1.06, wall - 0.07), ridge + vec2(0.0, 0.05)) < 0.07) return 3.0;
    float top = wall + rise * (1.0 - abs(q.x + 0.5) / 0.5);
    if (q.x >= -1.0 && q.y <= top) {
      if (abs(q.x + 0.5) < 0.16 && q.y > 0.38 * wall && q.y < 0.75 * wall) pane = 1.0;
      return 1.0;
    }
  }
  // Long wall, its windows a third and two thirds along.
  float up = q.y - q.x * COUNTRY_RECEDE;
  if (q.x > 0.0 && q.x <= len && up >= 0.0 && up <= wall) {
    if (up > 0.38 * wall && up < 0.75 * wall) {
      if (abs(q.x - 0.3 * len) < 0.14) pane = 2.0;
      if (abs(q.x - 0.72 * len) < 0.14) pane = 3.0;
    }
    return 2.0;
  }
  return 0.0;
}

// The church: a long nave, a square west tower in front of its gable end and a spire on the tower.
// Faces as for cottages, plus 5 tower front, 6 tower side, 7 and 8 the spire's two faces, 9 the
// belfry opening.
float countryChurch(vec2 q, out float pane) {
  pane = 0.0;
  float tower = 2.3;
  vec2 apex = vec2(-0.42, tower + 2.08);
  if (q.y > tower && q.y < apex.y) {
    float k = (q.y - tower) / (apex.y - tower);
    float corner = mix(-0.16, apex.x, k);
    if (q.x > mix(-0.9, apex.x, k) && q.x < mix(0.08, apex.x, k)) return q.x < corner ? 7.0 : 8.0;
  }
  if (q.x >= -0.86 && q.x <= -0.16 && q.y >= 0.0 && q.y <= tower) {
    if (abs(q.x + 0.51) < 0.13 && q.y > tower - 0.5 && q.y < tower - 0.18) return 9.0;
    return 5.0;
  }
  if (q.x > -0.16 && q.x <= 0.06) {
    float up = q.y - (q.x + 0.16) * COUNTRY_RECEDE;
    if (up >= 0.0 && up <= tower) return 6.0;
  }
  return countryCottage(q, 2.5, 1.0, 0.62, false, pane);
}

// Chimney smoke from \`top\` (screen units), rising \`tall\`: a plume that curls, widens and thins as
// it climbs and leans downwind, more so higher up where the wind is stronger. Density 0..1.
float countrySmoke(vec2 q, vec2 top, float tall, float seed, float t, float wind) {
  float h = (q.y - top.y) / tall;
  if (h < 0.0 || h > 1.0) return 0.0;
  float lean = wind * (0.5 * h + 1.1 * h * h);
  float curl = 0.06 * sin(h * 8.0 - t * 1.1 + seed * 6.3) * smoothstep(0.0, 0.35, h) * (1.0 - 0.5 * abs(wind));
  float x = (q.x - top.x) / tall - lean - curl;
  float width = 0.03 + 0.14 * h;
  float body = exp(-x * x / (width * width));
  float puffs = vnoise(vec2(x * 9.0 + seed * 17.0, h * 6.0 - t * 0.7));
  return body * (0.45 + 0.75 * puffs) * smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.35, 1.0, h));
}

struct CountryVillage {
  float hit;     // 1 on a building
  vec3 albedo;
  vec3 normal;
  float roof;    // how much lying snow settles here: 1 roofs, 0 walls
  float lamp;    // 1 on a lit window
  float smoke;   // chimney smoke in front of whatever is behind, 0..1
  float glow;    // warm spill from lit windows nearby
};

CountryVillage countryNoVillage() {
  CountryVillage v;
  v.hit = 0.0;
  v.albedo = vec3(0.0);
  v.normal = vec3(0.0, 1.0, 0.0);
  v.roof = 0.0;
  v.lamp = 0.0;
  v.smoke = 0.0;
  v.glow = 0.0;
  return v;
}

// The village on the knoll of the third ridge (q in that ridge's frame): eleven cottages along a
// lane, either side, and the church up the knoll; nearer (lower) buildings stand in front.
CountryVillage countryVillage(vec2 q, float vx, float knoll, float tod, float dark, float t, float wind) {
  CountryVillage v = countryNoVillage();
  if (abs(q.x - vx) > 0.26 || q.y < knoll - 0.1 || q.y > knoll + 0.18) return v;
  float front = 2.0;
  float face = 0.0;
  float pane = 0.0;
  float flip = 1.0;
  float which = 0.37;
  float church = 0.0;
  float lights = K_lights;
  float smoke = 0.0;
  float glow = 0.0;
  vec2 c = (q - vec2(vx + 0.018, knoll - 0.02)) / 0.019;
  if (c.x > -1.2 && c.x < 2.8 && c.y > -0.05 && c.y < 4.6) {
    float pn = 0.0;
    float f = countryChurch(c, pn);
    if (f > 0.0) {
      face = f;
      pane = pn;
      front = knoll - 0.02;
      church = 1.0;
    }
  }
  for (int k = 0; k < 11; k++) {
    float fk = float(k);
    float hj = hash12(vec2(fk, 4.3));
    float u = (fk - 5.0) / 5.0;
    float side = mod(fk, 2.0) < 0.5 ? 1.0 : -1.0;
    float down = max(0.04 + 0.02 * sin(u * 2.3 + 0.9) + 0.01 * side + 0.008 * (hj - 0.5), 0.014);
    vec2 base = vec2(vx + u * 0.12 + 0.014 * (hj - 0.5), knoll - down);
    float size = 0.014 + 0.1 * (down - 0.014);
    float len = 1.2 + 0.8 * fract(hj * 7.1);
    vec2 h = (q - base) / size;
    h.x *= side;
    if (base.y < front && h.x > -1.15 && h.x < len + 0.15 && h.y > -0.05 && h.y < 1.75 + len * COUNTRY_RECEDE) {
      float pn = 0.0;
      float f = countryCottage(h, len, 0.75, 0.55, true, pn);
      if (f > 0.0) {
        face = f;
        pane = pn;
        front = base.y;
        flip = side;
        which = hj;
        church = 0.0;
      }
    }
    // Lit windows warm the walls and ground around them.
    float lit = countryWindow(fract(hj * 91.0 + 0.13), tod, dark, lights) + countryWindow(fract(hj * 91.0 + 0.57), tod, dark, lights) + countryWindow(fract(hj * 91.0 + 0.89), tod, dark, lights);
    vec2 g = h - vec2(0.3, 0.4);
    glow += lit * exp(-dot(g, g) * 0.3);
    // Every third cottage has its fire lit.
    if (abs(mod(fk, 3.0) - 1.0) < 0.5) {
      vec2 top = countryStack(len, 0.75, 0.55);
      smoke = max(smoke, countrySmoke(q, base + size * vec2(side * top.x, top.y), 0.1, hj, t, wind));
    }
  }
  v.smoke = smoke * (K_smoke > 0.0 ? 0.35 + 0.85 * K_smoke : 0.0);
  v.glow = min(glow, 1.5);
  if (face < 0.5) return v;
  v.hit = 1.0;
  float hw = fract(which * 11.3);
  float hr = fract(which * 23.7);
  vec3 wall = church > 0.5 ? vec3(0.7, 0.68, 0.62) : (hw < 0.35 ? vec3(0.84, 0.77, 0.62) : (hw < 0.6 ? vec3(0.88, 0.87, 0.82) : (hw < 0.85 ? vec3(0.62, 0.36, 0.26) : vec3(0.6, 0.6, 0.57))));
  vec3 roof = church > 0.5 ? vec3(0.27, 0.29, 0.33) : (hr < 0.5 ? vec3(0.56, 0.26, 0.17) : (hr < 0.8 ? vec3(0.26, 0.28, 0.32) : vec3(0.58, 0.48, 0.3)));
  vec3 gableNormal = vec3(-0.62, 0.0, -0.78);
  vec3 wallNormal = vec3(0.78, 0.0, -0.62);
  if (face < 1.5 || (face > 4.5 && face < 5.5)) {
    v.albedo = wall;
    v.normal = gableNormal;
  } else if (face < 2.5 || (face > 5.5 && face < 6.5)) {
    v.albedo = wall * 0.97;
    v.normal = wallNormal;
  } else if (face < 3.5) {
    v.albedo = roof;
    v.normal = normalize(vec3(0.42, 0.78, -0.46));
    v.roof = 1.0;
  } else if (face < 4.5) {
    v.albedo = vec3(0.5, 0.3, 0.22);
    v.normal = gableNormal;
  } else if (face < 8.5) {
    v.albedo = vec3(0.45, 0.47, 0.5);
    v.normal = face < 7.5 ? normalize(vec3(-0.55, 0.45, -0.7)) : normalize(vec3(0.6, 0.45, -0.66));
    v.roof = 0.5;
  } else {
    v.albedo = vec3(0.08, 0.07, 0.07);
    v.normal = gableNormal;
  }
  v.normal.x *= flip;
  if (pane > 0.5) {
    float lit = countryWindow(fract(which * 91.0 + (pane < 1.5 ? 0.13 : (pane < 2.5 ? 0.57 : 0.89))), tod, dark, church > 0.5 ? 0.5 * lights : lights);
    v.albedo = vec3(0.1, 0.12, 0.16);
    v.lamp = lit;
  }
  return v;
}

// Rain hanging from the cloud base in grey veils over the far hills, slanted by the wind and
// drifting with it; finer streaks inside each veil slide slowly down.
float countryVeils(vec2 p, float t, float wind) {
  float x = p.x + (p.y - COUNTRY_HORIZON) * wind * 0.35 - t * wind * 0.01;
  float shafts = smoothstep(0.45, 0.75, 0.7 * vnoise(vec2(x * 5.0, 1.7)) + 0.3 * vnoise(vec2(x * 13.0, 4.2 + t * 0.03)));
  float streaks = 0.75 + 0.25 * vnoise(vec2(x * 90.0, p.y * 3.0 + t * 0.4));
  float hang = (1.0 - smoothstep(0.74, 0.86, p.y)) * smoothstep(0.45, 0.56, p.y);
  return shafts * streaks * hang;
}

Shade sceneCountry(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  float pxl = 1.0 / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  // The village a third in from the left, the chalk down right of centre (screen x).
  vec2 spots = vec2(-0.2, 0.24) * aspect;
  float wind = K_wind;
  float season = K_season;

  float tod = timeOfDay(K_time, K_cycle, t);
  Sky sky = skyAt(tod);
  float cover = clamp(K_clouds + 0.7 * K_rain + 0.4 * K_snow + 0.3 * K_lightning, 0.0, 1.0);
  float overcast = smoothstep(0.55, 1.0, cover);
  // How dark it is for the villagers: the first lamps come on while the sun is still ~7 degrees up
  // (tod .70), most by sunset, all of them early in dusk (and earlier under a heavy sky).
  float dark = clamp(1.0 - smoothstep(-0.12, 0.2, sky.sun.y) + 0.3 * overcast, 0.0, 1.0);
  // Mist gathers most around dawn.
  float dawn = (tod - 0.27) / 0.06;
  float fog = clamp(K_fog * (0.6 + 0.8 * exp(-dawn * dawn)), 0.0, 1.0);
  // Snow lying on the land: the sim lets it build up while it snows and melt after.
  float lying = uSimOn.x > 0.5 ? texture(uSim0, vec2(0.5)).r : K_snow;
  vec3 air = sky.ambient + 0.5 * sky.sunColor + 0.4 * sky.moonColor;

  // Front to back: the first ridge, or a tree or building standing on it, that covers the pixel.
  int hit = 6;
  float crest = 0.0;
  float valley = -1.0;
  vec2 q = p;
  float object = 0.0;
  vec4 crown = vec4(0.0);
  CountryVillage village = countryNoVillage();
  bool villageSeen = false;
  for (int k = 0; k < 6; k++) {
    float i = float(k);
    vec4 L = countryLayer(i);
    // Nearer ridges slide further as the pointer moves.
    vec2 qi = p + uPointer * m * vec2(0.022, 0.01) / L.x;
    float c = countryCrest(i, qi.x, spots);
    if (k == 2) {
      village = countryVillage(qi, spots.x, L.y + 0.012, tod, dark, t * m, wind);
      villageSeen = true;
      if (village.hit > 0.5) {
        hit = k;
        crest = c;
        q = qi;
        object = 2.0;
        break;
      }
    }
    if (k < 2) {
      // Hedgerow trees, rooted on the face below and standing up over it (and over the crest).
      float r = 0.014 / L.x;
      float lift = r * 1.2;
      float sQ = c - qi.y + lift;
      if (sQ > -r) {
        // A root point above the crest still finds the trees standing on it.
        float sRoot = max(sQ, 0.0);
        vec2 fQ = countryFieldSpace(i, vec2(qi.x * L.x, countryDown(sRoot, L.x)));
        vec2 scale = vec2(L.x, countryDownRate(sRoot, L.x)) * COUNTRY_FIELDS;
        float density = 0.42 * (1.0 - 0.8 * countrySpots(qi.x, spots).x);
        crown = countryTrees(fQ, scale, r, density, max(-sQ, 0.0));
        if (crown.z > 0.5) {
          hit = k;
          crest = c;
          q = qi;
          object = 1.0;
          break;
        }
      }
    }
    if (qi.y < c) {
      hit = k;
      crest = c;
      q = qi;
      break;
    }
    valley = max(valley, c);
  }

  vec3 col = vec3(0.0);
  float accent = 0.0;
  float glint = 0.0;
  // The horizon at this x: the colour the land fades into with distance.
  vec3 haze = skyColor(sky, normalize(vec3(q.x, 0.02, 1.0)));
  vec3 mist = mix(haze, vec3(0.8, 0.82, 0.85) * air, 0.4);
  float i = float(hit);

  if (hit < 6) {
    vec4 L = countryLayer(i);
    float d = L.x;
    float s = max(crest - q.y, 0.0);
    vec2 w = vec2(q.x * d, countryDown(s, d));
    float down = countryDownRate(s, d);
    vec2 px = vec2(d, down) * pxl;
    vec2 near = countrySpots(q.x, spots);

    // The face turns from skyward at the crest toward us lower down, leans with the silhouette's
    // slope and rolls over low hummocks.
    float e = 2.0 * pxl;
    float lean = (countryCrest(i, q.x + e, spots) - crest) / e;
    float facing = 0.38 * sqrt(clamp(s / 0.12, 0.0, 1.0));
    vec2 hw = w * vec2(2.2, 3.0) + 3.0 * i;
    float h0 = vnoise(hw);
    vec2 hump = vec2(vnoise(hw + vec2(0.05, 0.0)) - h0, vnoise(hw + vec2(0.0, 0.05)) - h0) / 0.05;
    vec3 n = normalize(vec3(-lean * (1.0 - facing) * 0.9 - hump.x * 0.12, 1.0, -facing + hump.y * 0.1));

    // Sunlight through the cloud deck: follow the sun from this point of ground up to the deck.
    float z = d * (1.0 - 0.35 * clamp(s / 0.15, 0.0, 1.0));
    vec3 ground = vec3(q.x * z, (q.y - COUNTRY_HORIZON) * z, z);
    float sunShade = 1.0 - 0.75 * overcast;
    if (K_shadows > 0.0 && sky.sun.y > 0.0) {
      vec3 deck = ground + sky.sun * ((COUNTRY_CLOUD_BASE - ground.y) / max(sky.sun.y, 0.12));
      sunShade *= 1.0 - K_shadows * skyClouds(sky, normalize(deck), t, cover, wind).a;
    }

    vec3 albedo = vec3(0.0);
    float settles = 1.0;   // how much of the lying snow shows here
    float water = 0.0;
    float lamp = 0.0;
    float chalk = 0.0;
    vec3 reflection = vec3(0.0);
    if (object > 1.5) {
      albedo = village.albedo;
      n = village.normal;
      settles = village.roof;
      lamp = village.lamp;
    } else if (object > 0.5) {
      // A hedgerow tree: a leafy dome lit on the sun's side, darker underneath; in autumn each
      // turns its own colour.
      vec2 dc = crown.xy;
      n = normalize(vec3(dc.x, dc.y * 0.8 + 0.25, -sqrt(max(1.0 - dot(dc, dc), 0.0)) - 0.2));
      float th = fract(crown.w * 41.0);
      vec3 leaf = season < 0.5 ? vec3(0.15, 0.3, 0.11) : vec3(0.18, 0.29, 0.1);
      if (season > 1.5) leaf = th < 0.3 ? vec3(0.62, 0.36, 0.1) : (th < 0.55 ? vec3(0.5, 0.22, 0.08) : (th < 0.75 ? vec3(0.7, 0.56, 0.17) : vec3(0.2, 0.3, 0.11)));
      albedo = leaf * (0.82 + 0.36 * vnoise(q * uRes.y / 3.0)) * (0.75 + 0.25 * smoothstep(-1.0, 0.3, dc.y));
      settles = 0.5;
    } else {
      // The patchwork.
      vec2 site = vec2(0.0);
      vec2 other = vec2(0.0);
      vec2 axis = vec2(0.0);
      vec2 f = countryFieldSpace(i, w);
      vec2 field = countryCells(f, site, other, axis);
      float crop = countryCrop(field.y, season);
      albedo = countryCropColor(crop, field.y, season, w, px, wind, tm);
      if (hit < 2 && (crop > 0.5 && crop < 1.5 || crop > 3.5 && crop < 4.5 && season > 0.5 && season < 1.5)) {
        float shadow = 0.0;
        vec4 dots = countryDots(crop, w, d, down, tm, shadow);
        albedo = mix(albedo * (1.0 - shadow), dots.rgb, dots.a);
      }
      // Hedges on the borders where they are wide enough to hold in the dither; farther off they
      // only darken the seams between fields.
      vec2 fscale = vec2(d, down) * COUNTRY_FIELDS;
      float border = field.x * length(axis / fscale);
      float hedgeHalf = 0.0032 / d * (0.75 + 0.5 * vnoise(f * 6.0));
      float holds = smoothstep(0.6, 1.2, hedgeHalf * uRes.y);
      albedo *= 1.0 - 0.25 * (1.0 - holds) * (1.0 - smoothstep(0.0, 2.0 * pxl, border));
      if (border < hedgeHalf && holds > 0.0) {
        vec3 hedge = season > 1.5 ? vec3(0.27, 0.2, 0.08) : vec3(0.1, 0.22, 0.09);
        albedo = mix(albedo, hedge * (0.8 + 0.3 * vnoise(f * 30.0)), holds);
        settles = 0.5;
      }
      // Woods on the farther ridges, crown by crown where the crowns are big enough to show.
      float woods = countryWoods(i, w.x, w.y, near);
      if (woods > 0.0) {
        float ao = 0.0;
        vec4 canopy = countryCanopy(vec2(w.x, s * d) * 16.0, ao);
        float crowns = smoothstep(2.5, 5.0, 0.0625 / px.x);
        vec3 leaf = vec3(0.1, 0.22, 0.1);
        if (season > 1.5) leaf = canopy.w < 0.3 ? vec3(0.5, 0.26, 0.08) : (canopy.w < 0.5 ? vec3(0.62, 0.45, 0.12) : vec3(0.14, 0.26, 0.1));
        albedo = mix(albedo, leaf * mix(1.0, 0.65 + 0.35 * ao, crowns), woods);
        n = normalize(mix(n, canopy.xyz, woods * crowns));
        settles = mix(settles, 0.35 + 0.4 * max(canopy.y, 0.0), woods);
      }
      // The river on the second ridge, mirroring the sky between reedy banks.
      if (hit == 1) {
        vec2 river = countryRiver(w.y, (spots.x + 0.07) * d);
        float across = abs(w.x - river.x) / sqrt(1.0 + river.y * river.y);
        float bank = 0.012 + 0.008 * clamp(w.y / 0.6, 0.0, 1.0);
        if (across < bank * 1.7) {
          albedo = vec3(0.16, 0.24, 0.1) * (0.85 + 0.3 * vnoise(f * 40.0));
          settles = 0.6;
        }
        if (across < bank) {
          vec3 view = normalize(vec3(q.x, q.y - COUNTRY_HORIZON, 1.0));
          vec3 mirrored = vec3(view.x, -view.y, view.z);
          vec4 cloud = skyClouds(sky, mirrored, t, cover, wind);
          float ripple = vnoise(vec2(w.x * 60.0, w.y * 25.0 - tm * 0.6));
          reflection = mix(skyColor(sky, mirrored), cloud.rgb, cloud.a) * (0.82 + 0.25 * ripple);
          water = 0.85;
          settles = 0.0;
          glint = smoothstep(0.6, 0.9, ripple);
        }
      }
      // The chalk figure: an M cut through the turf of the down, foreshortened on its slope like
      // the Uffington White Horse, read whole only from across the valley.
      if (hit == 3 && K_chalk > 0.5) {
        float unit = 0.12 * d / 0.94;
        vec2 mq = vec2(w.x - spots.y * d, countryDown(0.036, d) - w.y) / unit;
        chalk = 1.0 - smoothstep(0.075, 0.09, markDistance(mq));
        albedo = mix(albedo, vec3(0.93, 0.92, 0.86) * (0.94 + 0.06 * vnoise(f * 20.0)), chalk);
      }
    }

    // Snow settles first on the high far ridges, then creeps down to the near fields.
    float snowLine = lying * 1.35 - 0.35 * vnoise(w * 2.5 + 11.0) - 0.12 * (1.0 - i / 5.0);
    albedo = mix(albedo, COUNTRY_SNOW, smoothstep(0.0, 0.18, snowLine) * settles);

    col = albedo * countryLight(sky, n, sunShade);
    col = mix(col, reflection, water);
    if (lamp > 0.0) {
      col = mix(col, COUNTRY_AMBER, lamp);
      accent = lamp;
    }
    accent = max(accent, 0.75 * chalk);

    // Atmospheric perspective: farther ridges paler and bluer (the horizon's colour) and softer.
    col = mix(col, haze, 1.0 - exp(-d * (0.055 + 0.07 * overcast + 0.05 * fog)));
    // Mist pooled in the valleys: thickest just above the nearer ridge, where the valley floor hides.
    float floorY = hit == 0 ? -0.3 : valley - 0.012;
    col = mix(col, mist, fogAmount(fog, i / 5.0, max(q.y - floorY, 0.0) * d / 0.25));
  } else {
    vec3 dir = viewRay(uv, aspect, COUNTRY_HORIZON, COUNTRY_FOV);
    col = skyColor(sky, dir);
    vec4 cloud = skyClouds(sky, dir, t, cover, wind);
    col += skyStars(sky, dir, 0.4) * vec3(0.9, 0.93, 1.0) * (1.0 - cloud.a);
    col = mix(col, cloud.rgb, cloud.a);
    col = mix(col, mist, fogAmount(fog, 1.0, max(p.y - valley, 0.0) * 12.0 / 0.25));
  }

  // The village's life: warm light around lit windows, smoke drifting over whatever lies behind.
  if (villageSeen && hit >= 2) {
    col += COUNTRY_AMBER * village.glow * 0.12 * dark * (1.0 - village.lamp);
    col = mix(col, vec3(0.8, 0.8, 0.83) * air, village.smoke * 0.75);
  }

  // Rain veils hang over the far hills.
  if (K_rain > 0.0 && hit >= 3) {
    col = mix(col, haze * 0.85 + 0.03, countryVeils(p, tm, wind) * K_rain * 0.7);
  }

  // Lightning over the far hills: bolts to the fourth ridge, the whole scene flashing.
  float seed = 0.0;
  float age = lightningAge(t, K_lightning, 0, seed);
  float flash = lightningFlash(age);
  if (age < 2.0 && hit >= 4) {
    float bx = (fract(seed * 7.13) - 0.5) * aspect * 0.8;
    float gx = bx + (fract(seed * 3.71) - 0.5) * 0.12;
    float bolt = lightningBolt(p, vec2(bx, 0.92), vec2(gx, countryCrest(4.0, gx, spots) - 0.004), seed, age);
    col += vec3(0.85, 0.9, 1.0) * bolt;
  }
  col += vec3(0.5, 0.55, 0.7) * flash * (hit == 6 ? 0.45 : 0.25);

  if (K_rain > 0.0) {
    col = mix(col, vec3(0.7, 0.75, 0.82) * air + 0.3 * flash, rainStreaks(uv, aspect, t, K_rain, wind) * 0.45);
  }
  if (K_snow > 0.0) {
    col = mix(col, vec3(0.95, 0.96, 1.0) * clamp(air * 1.3 + 0.1, 0.0, 1.0), snowFlakes(uv, aspect, t, K_snow, wind));
  }

  Shade o = blankShade();
  o.rgb = clamp(col, 0.0, 1.0);
  o.source = o.rgb;
  o.ink = clamp(dot(o.rgb, LUMA) * 1.1, 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  o.shimmer = glint * 0.3 * m;
  return o;
}
`;
