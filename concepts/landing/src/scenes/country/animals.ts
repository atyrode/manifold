// Pasture enclosures (countryFieldCrop 9): grazed grass, a post-and-rail fence set just inside the
// hedges, and a herd of cattle or sheep living inside each one. The animals themselves (bodies,
// poses and their schedule) come from the shared livestock library (shaders/lib/livestock.ts);
// this file keeps them on the countryside's ground.
//
// Everything lives in field space (countryFieldSpace), where an enclosure is a Voronoi cell of
// countryCells: its walls are the bisectors with the eight neighbouring sites, plus the farm track
// or the river where they pass, and the crest above. A herd is a loose disc of animals round a
// centre that wanders slowly about the field's site. Each animal's anchors (its place in the herd at
// the start of each schedule slot plus a stray of its own) are pushed back inside every wall by the
// clearance its body needs on screen there; it moves between anchors, so it never leaves the field.
// Before an animal is drawn its actual footprint is checked once more against the walls, the
// crest, the track, the river and the woods, and it is not drawn if it would touch them.
//
// Drawing follows countryDots: the screen offset from the foot at the ridge's depth d and the
// slope's own down-slope rate, with the crest's lean undone so the animals stand upright on any
// hillside. Up close they have legs, heads and markings; a couple of cells long they become soft
// specks; beyond the third ridge the enclosure keeps its grass alone.
import { livestockGlsl } from "../../shaders/lib/livestock.ts";

export const countryAnimalsGlsl = /* glsl */ `
${livestockGlsl}

const float COUNTRY_FENCE_HIGH = 0.008;  // post-and-rail fence height, world units
const float COUNTRY_FENCE_POST = 0.0018; // post width
const float COUNTRY_FENCE_RAIL = 0.0012; // rail depth
const float COUNTRY_FENCE_SPAN = 0.02;   // between posts
const float COUNTRY_FENCE_SET = 1.75;    // fence line inside a field's border, in mean hedge half-widths
const int COUNTRY_HERD_MAX = 14;         // most animals one herd holds (sheep at the largest herd size)
// Body half-length (world) of a cow and of a sheep, drawn a little large, as the hedgerow trees
// are, so a herd reads across the valley.
const vec2 COUNTRY_BEAST = vec2(0.0095, 0.0064);

// A pasture enclosure's grass: grazed short and even, flecked with the tussocks the herd leaves
// where it resolves, and paler trodden patches; lush in summer, drier at harvest, darker and
// poached to mud in autumn.
vec3 countryPastureColor(float h, float season, vec2 w, vec2 px, out float relief, out float sheen) {
  float tufts = smoothstep(0.55, 0.8, vnoise(w * 130.0 + h * 13.0)) * smoothstep(2.5, 5.0, 0.0077 / max(px.x, px.y));
  float mottle = vnoise(w * 9.0 + h * 5.0);
  float worn = smoothstep(0.68, 0.85, vnoise(w * 16.0 + h * 29.0));
  vec3 grass = season < 0.5 ? vec3(0.3, 0.53, 0.19) : (season < 1.5 ? vec3(0.4, 0.54, 0.21) : vec3(0.27, 0.45, 0.18));
  vec3 trodden = season > 1.5 ? vec3(0.4, 0.33, 0.22) : vec3(0.5, 0.53, 0.3);
  vec3 col = grass * (0.94 + 0.1 * mottle);
  col = mix(col, trodden, worn * (season > 1.5 ? 0.55 : 0.3));
  col *= 1.0 - 0.08 * tufts;
  relief = 0.5 + 0.3 * tufts;
  sheen = 0.0;
  return col;
}

// countryFieldSpace inverted: the slope point (world) of field-space point f on ridge i, with in
// f0 the unwarped field coordinate it comes from. Three fixed-point steps of the gentle warp.
vec2 countryFieldPoint(float i, vec2 f, out vec2 f0) {
  f0 = f;
  for (int k = 0; k < 3; k++) f0 = f - 0.5 * (vec2(vnoise(f0 * 0.55 + 3.1), vnoise(f0 * 0.55 + 8.7)) - 0.5);
  return (f0 - vec2(31.7 * i, 7.3 * i) - countrySeed) / COUNTRY_FIELDS;
}

// The field warp's Jacobian at unwarped point f0 (columns: df/df0.x, df/df0.y); f gets the exact
// warped point.
mat2 countryFieldWarp(vec2 f0, out vec2 f) {
  vec3 a = vnoiseD(f0 * 0.55 + 3.1);
  vec3 b = vnoiseD(f0 * 0.55 + 8.7);
  f = f0 + 0.5 * (vec2(a.x, b.x) - 0.5);
  return mat2(1.0 + 0.275 * a.y, 0.275 * b.y, 0.275 * a.z, 1.0 + 0.275 * b.z);
}

// countryDown inverted: the screen drop below the crest of ground v (world) down a ridge at depth d.
float countryDrop(float v, float d) {
  float r = max(v, 0.0) / (d * COUNTRY_SLOPE) + sqrt(COUNTRY_ROUND);
  return r * r - COUNTRY_ROUND;
}

// The down-slope rate over the depth (countryDownRate / d) at ground v down a ridge at depth d.
float countryFore(float v, float d) {
  return 0.5 * COUNTRY_SLOPE / sqrt(countryDrop(v, d) + COUNTRY_ROUND);
}

struct CountryHerd {
  float count;    // animals, 0 for an empty field
  float cattle;   // 1 cattle, 0 sheep
  float breed;    // LivestockBeast.breed, the same for the whole herd
  float size;     // body half-length, world
  float spacing;  // between neighbours, world
  float roam;     // how far the herd's centre wanders from its middle, world units
  float seed;
  float huddle;   // 1 spread out .. 0.55 bunched up in rain and snow
  vec2 site;      // the field's site, field space
  vec2 middle;    // where the herd's centre wanders about: the field point farthest inside its
                  // walls, from the site in world units (field space over COUNTRY_FIELDS)
  vec2 home;      // the site on the slope, world
};

// The clearance (field units) an animal of half-length size (world) needs from a wall with outward
// normal n: the fence line (set: its distance in from the border on screen, times the depth) plus
// the body's reach toward the wall on screen, on ground whose down-slope rate is fore times the
// depth, under the field warp J.
float countryHerdMargin(vec2 n, mat2 J, float fore, float set, float size) {
  vec2 m = transpose(J) * n;
  vec2 fs = vec2(1.0, fore) * COUNTRY_FIELDS;
  float reach = 1.45 * size * fs.x * abs(m.x) + size * fs.y * (m.y < 0.0 ? -1.5 * m.y : 0.35 * m.y);
  return set / length(n / fs) + reach;
}

// The least clearance (world units) from point c (relative to the site, field space over
// COUNTRY_FIELDS) to the herd's limits: xy their unit normals, z their distance from the site.
float countryHerdRoom(vec3 limits[10], vec2 c) {
  float room = 1e3;
  for (int w = 0; w < 10; w++) room = min(room, limits[w].z - dot(c, limits[w].xy));
  return room;
}

// The herd of the enclosure with this site (field space) on ridge i at depth d, and its walls: xy
// their outward unit normals, z the distance from the site. 0..7 the neighbouring fields (the
// bisectors of countryCells), 8 the farm track (first ridge) or the river (second) at the site's
// level. Each wall less the clearance an animal's feet need from it (the reach of its body on
// screen, taken where the wall stands, the most foreshortened ground it can reach that way), and
// the crest less an animal's height, bound the herd. Its middle is the point farthest inside those
// bounds (found by stepping away from the nearest); the herd is as large as fits round it at full
// spread, and its centre wanders only as far as leaves every member inside.
CountryHerd countryHerd(float i, float d, vec2 site, vec2 spots, out vec3 walls[9]) {
  CountryHerd herd;
  vec2 id = floor(site);
  herd.site = site;
  herd.seed = hash12(id * 1.13 + 4.13);
  herd.cattle = hash12(id + 9.71) < K_cows ? 1.0 : 0.0;
  herd.breed = hash12(id + 2.39);
  herd.size = herd.cattle > 0.5 ? COUNTRY_BEAST.x : COUNTRY_BEAST.y;
  herd.spacing = herd.size * 3.2;
  herd.huddle = clamp(1.0 - 0.3 * uWeather.x - 0.25 * uWeather.y, 0.55, 1.0);
  herd.roam = 0.0;
  herd.count = 0.0;
  herd.middle = vec2(0.0);
  vec2 f0 = vec2(0.0);
  herd.home = countryFieldPoint(i, site, f0);
  vec2 warped = vec2(0.0);
  mat2 J = countryFieldWarp(f0, warped);
  int j = 0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      // countryCells' own site for the neighbouring cell.
      vec2 c = id + vec2(float(x), float(y));
      vec2 to = c + 0.15 + 0.7 * vec2(hash12(c + 0.31), hash12(c + 5.77)) - site;
      walls[j] = vec3(normalize(to), 0.5 * length(to));
      j++;
    }
  }
  walls[8] = vec3(0.0, 1.0, 1e3);
  float v = herd.home.y;
  if (i < 1.5) {
    // The track or the river crossing the field: a straight wall at the site's level on the far
    // side of it. A site lying on it keeps no herd.
    float z = d * (1.0 - 0.35 * smoothstep(0.0, 0.2, countryDrop(v, d)));
    vec2 line = vec2(0.0);
    float reach = 0.0;
    if (i < 0.5) {
      vec2 lane = countryLane(v, spots.x * 0.6);
      line = lane * d / z;
      reach = COUNTRY_LANE * 1.3 * d / z * sqrt(1.0 + lane.y * lane.y);
    } else {
      line = countryRiver(v, (spots.x + 0.07) * d);
      reach = (0.012 + 0.008 * clamp(v / 0.6, 0.0, 1.0)) * 1.7 * sqrt(1.0 + line.y * line.y);
    }
    float side = herd.home.x < line.x ? -1.0 : 1.0;
    vec2 n = normalize(-side * normalize(vec2(1.0, -line.y)) / COUNTRY_FIELDS);
    walls[8] = vec3(n, dot(countryFieldSpace(i, vec2(line.x + side * reach, v)) - site, n));
    if (walls[8].z <= 0.0) return herd;
  } else {
    // Not on the village knoll or in a wood on the third ridge.
    vec2 near = countrySpots(herd.home.x / d, spots);
    if (near.x > 0.25 || countryWoodStand(i, herd.home.x, v, near) > 0.45) return herd;
  }
  // The limits in world units, where the herd's spacing is the same every way.
  vec3 limits[10];
  float set = COUNTRY_FENCE_SET * 0.0065 + COUNTRY_FENCE_POST;
  for (int w = 0; w < 9; w++) {
    vec3 wall = walls[w];
    float fore = countryFore(v + min(wall.z * wall.y, 0.0) / COUNTRY_FIELDS.y, d);
    vec2 n = wall.xy * COUNTRY_FIELDS;
    float limit = wall.z - countryHerdMargin(wall.xy, J, fore, set, herd.size) - 0.3 * herd.size * COUNTRY_FIELDS.y;
    limits[w] = vec3(n / length(n), limit / length(n));
  }
  limits[9] = vec3(0.0, -1.0, v - countryDown(1.6 * herd.size / d, d));
  // Step away from the nearest limit, by half the gap to the next nearest (which can only gain),
  // or out of a corner between two, keeping a step only where it gains.
  vec2 c = vec2(0.0);
  float room = countryHerdRoom(limits, c);
  for (int it = 0; it < 8; it++) {
    float c1 = 1e3;
    float c2 = 1e3;
    vec2 m1 = vec2(0.0);
    vec2 m2 = vec2(0.0);
    for (int w = 0; w < 10; w++) {
      float clear = limits[w].z - dot(c, limits[w].xy);
      if (clear < c1) {
        c2 = c1;
        m2 = m1;
        c1 = clear;
        m1 = limits[w].xy;
      } else if (clear < c2) {
        c2 = clear;
        m2 = limits[w].xy;
      }
    }
    bool corner = c2 - c1 < 0.2 * abs(c1) && dot(m1, m2) > -0.7;
    vec2 next = c - (corner ? normalize(m1 + m2) * 0.3 * abs(c1) : m1 * 0.5 * (c2 - c1));
    float gained = countryHerdRoom(limits, next);
    if (gained > room) {
      c = next;
      room = gained;
    }
  }
  herd.middle = c;
  float want = floor(K_herd * (herd.cattle > 0.5 ? 10.0 : 14.0) * (0.65 + 0.7 * hash12(id + 7.37)) + 0.5);
  herd.count = min(min(want, livestockFit(room / herd.spacing)), float(COUNTRY_HERD_MAX));
  // The drift reaches sqrt(2) of the roam at a corner.
  herd.roam = max(room - livestockReach(herd.count) * herd.spacing, 0.0) * 0.7071;
  return herd;
}

// Where the herd's centre is at clock time t, field space.
vec2 countryHerdCentre(CountryHerd herd, float t) {
  return herd.site + (herd.middle + herd.roam * livestockDrift(herd.seed, t)) * COUNTRY_FIELDS;
}

// Where animal k stands at the start of its slot n, which begins at clock time t: its place round
// the herd's centre then, plus its stray. Always inside the herd's limits (countryHerd).
vec2 countryHerdAnchor(CountryHerd herd, float k, float n, float t) {
  vec2 offset = livestockPlace(k, herd.seed) * herd.huddle + livestockStray(k, n, herd.seed);
  return countryHerdCentre(herd, t) + offset * herd.spacing * COUNTRY_FIELDS;
}

struct CountryStock {
  float cover;    // 0..1: an animal or the fence over the ground
  vec3 albedo;
  vec3 normal;
  float snow;     // how much of it faces up to hold snow, 0..1
  float porous;   // how much rain soaks in and darkens it
  float shadow;   // 0..1 darkening of the ground at the animals' feet
};

CountryStock countryNoStock() {
  CountryStock st;
  st.cover = 0.0;
  st.albedo = vec3(0.0);
  st.normal = vec3(0.0, 1.0, 0.0);
  st.snow = 0.0;
  st.porous = 0.5;
  st.shadow = 0.0;
  return st;
}

// The herd of the enclosure under this pixel. q: the pixel in the ridge's frame; s its drop below
// the bare crest, lean the crest's slope there; w its slope point, down the slope's rate; f, site:
// field space; hedgeMean: the hedges' mean half-width on screen. Returns the nearest animal covering
// the pixel, and the shadows at their feet; foot gets that animal's down-slope distance.
CountryStock countryHerdAt(float i, float d, vec2 q, float s, float lean, vec2 w, float down, vec2 f, vec2 site,
                           float hedgeMean, vec2 spots, out float foot) {
  CountryStock st = countryNoStock();
  foot = -1.0;
  vec3 walls[9];
  CountryHerd herd = countryHerd(i, d, site, spots, walls);
  if (herd.count < 0.5) return st;
  float r = herd.size / d;           // body half-length on screen
  float cells = r * uRes.y;
  if (cells < 0.6) return st;
  // How far (field units, the warp's stretch allowed for) a pixel showing part of an animal can lie
  // from its feet: across, above (where the body stands up on screen) and below.
  vec3 extent = 1.6 * r * vec3(1.6 * d * COUNTRY_FIELDS.x, 1.6 * down * COUNTRY_FIELDS.y, 0.4 * down * COUNTRY_FIELDS.y);
  vec2 rel = f - (herd.site + herd.middle * COUNTRY_FIELDS);
  rel = vec2(max(abs(rel.x) - extent.x, 0.0), rel.y < 0.0 ? min(rel.y + extent.y, 0.0) : max(rel.y - extent.z, 0.0));
  if (length(rel) > (1.4143 * herd.roam + livestockReach(herd.count) * herd.spacing) * COUNTRY_FIELDS.y) return st;
  float tm = uMotionTime;
  float span = herd.cattle > 0.5 ? 11.0 : 8.0;
  float aa = 0.5 / cells;
  bool speck = cells < 2.2;
  float set = COUNTRY_FENCE_SET * hedgeMean + COUNTRY_FENCE_POST / d;
  // Every animal stands within this of its place round the herd's centre now: its stray, and the
  // centre's drift since its slot began or until it ends (livestockDrift: 1/30 each way a second).
  vec2 centre = countryHerdCentre(herd, tm);
  float slip = (1.4143 * herd.roam * span / 30.0 + LIVESTOCK_STRAY * herd.spacing) * COUNTRY_FIELDS.y;
  // The herd's own count bounds the loop (at most COUNTRY_HERD_MAX), so it is never unrolled.
  int count = int(herd.count);
  for (int j = 0; j < count; j++) {
    float k = float(j);
    vec2 near = f - (centre + livestockPlace(k, herd.seed) * herd.huddle * herd.spacing * COUNTRY_FIELDS);
    if (abs(near.x) > slip + extent.x || near.y < -slip - extent.y || near.y > slip + extent.z) continue;
    LivestockSlot slot = livestockSlot(tm, span, hash12(vec2(k * 3.1, herd.seed * 77.0)));
    vec2 a0 = countryHerdAnchor(herd, k, slot.n, slot.start);
    vec2 a1 = countryHerdAnchor(herd, k, slot.n + 1.0, slot.start + span);
    // The slot's mood comes from the hour it began, so a turning day never flips it halfway.
    vec2 mood = livestockMood(timeOfDayM(K_time, K_cycle, slot.start), K_clouds, K_rain, K_snow);
    float act = livestockAct(mood, hash12(vec2(slot.n * 0.71 + k * 13.3, herd.seed * 41.0 + 3.0)));
    vec2 at = mix(a0, a1, livestockPace(act, slot.u));
    near = f - at;
    if (abs(near.x) > extent.x || near.y < -extent.y || near.y > extent.z) continue;
    // The foot on the slope, and the pixel's screen offset from it (y up), the crest's lean undone.
    vec2 g0 = vec2(0.0);
    vec2 wa = countryFieldPoint(i, at, g0);
    float sa = countryDrop(wa.y, d);
    vec2 ds = vec2(q.x - wa.x / d, 0.0);
    ds.y = lean * ds.x + sa - s;
    if (abs(ds.x) > 1.6 * r || ds.y > 1.6 * r || ds.y < -0.4 * r) continue;
    // Its footprint, checked where it actually stands: never on a fence, hedge, track or river,
    // nor over the crest; otherwise it is not drawn at all.
    vec2 fa = vec2(0.0);
    mat2 J = countryFieldWarp(g0, fa);
    float fore = countryFore(wa.y, d);
    bool clear = sa > 1.6 * r;
    for (int w = 0; w < 9; w++) {
      clear = clear && walls[w].z - dot(fa - herd.site, walls[w].xy) >= countryHerdMargin(walls[w].xy, J, fore, set * d, herd.size);
    }
    if (i < 0.5) {
      vec2 lane = countryLane(wa.y, spots.x * 0.6);
      float za = d * (1.0 - 0.35 * smoothstep(0.0, 0.2, sa));
      float across = abs(wa.x / d * za - lane.x) / sqrt(1.0 + lane.y * lane.y);
      clear = clear && (across - COUNTRY_LANE * 1.3) / za > 1.5 * r;
    } else if (i < 1.5) {
      vec2 river = countryRiver(wa.y, (spots.x + 0.07) * d);
      float across = abs(wa.x - river.x) / sqrt(1.0 + river.y * river.y);
      clear = clear && (across - (0.012 + 0.008 * clamp(wa.y / 0.6, 0.0, 1.0)) * 1.7) / d > 1.5 * r;
    } else {
      vec2 near = countrySpots(wa.x / d, spots);
      clear = clear && near.x < 0.3 && countryWoods(i, wa.x, wa.y, near) <= 0.0;
    }
    if (!clear) continue;
    LivestockBeast beast = LivestockBeast(herd.cattle, herd.breed, hash12(vec2(k * 5.3 + 0.7, herd.seed * 19.0)));
    vec2 travel = (a1 - a0) / COUNTRY_FIELDS / herd.size;
    LivestockPose pose = livestockPose(beast, act, slot, vec2(travel.x, -travel.y), K_rain, tm);
    vec2 p = ds / r;
    st.shadow = max(st.shadow, 0.42 * livestockShadow(p, pose) * (speck ? 0.5 : 1.0));
    vec3 albedo = vec3(0.0);
    vec3 normal = normalize(vec3(0.0, 0.85, -0.5));
    float top = 0.4;
    float cover = 0.0;
    if (speck) {
      vec4 mean = livestockSpeck(p, beast, pose, aa);
      albedo = mean.rgb;
      cover = mean.a;
    } else {
      // Soft-edged a cell wide: the animals stand still most of the time and walk slowly.
      cover = softFill(livestockBody(p, beast, pose, aa, albedo, normal, top), aa);
    }
    if (cover > 0.0 && wa.y > foot) {
      foot = wa.y;
      st.cover = cover;
      st.albedo = albedo;
      st.normal = normal;
      st.snow = top;
      st.porous = herd.cattle > 0.5 ? 0.35 : 0.6;
    }
  }
  return st;
}

// The post-and-rail fence round a pasture enclosure, standing COUNTRY_FENCE_SET mean hedge
// half-widths inside its border (as the hedges measure it). The pixel sees the fence where the
// fence line crosses the ground between it and the ground the fence's height below it on screen:
// rails and posts at their heights above that foot. Running down the slope, the fence is seen end
// on, as a line. Gaps where the track or the river pass. Returns colour and cover; foot gets the
// down-slope distance of its foot (for occlusion with the animals), top how much of it holds snow.
vec4 countryFence(float i, float d, vec2 q, float s, vec2 w, float down, vec2 field, vec2 site, vec2 axis, bool enclosed,
                  float season, float hedgeMean, vec2 spots, out float foot, out float top) {
  foot = -1.0;
  top = 0.0;
  float px = 1.0 / uRes.y;
  float high = COUNTRY_FENCE_HIGH / d;
  if (high < 2.5 * px) return vec4(0.0);
  float set = COUNTRY_FENCE_SET * hedgeMean;
  vec2 fs = vec2(d, down) * COUNTRY_FIELDS;
  // Far from every border (field units, the warp's stretch allowed for) no fence line is in reach.
  if (field.x > 1.4 * high * fs.y + (set + px) * max(fs.x, fs.y)) return vec4(0.0);
  float borderP = field.x * length(axis / fs);
  // The ground the fence's height below, and which side of a fence line each end lies on.
  float sR = s + high;
  vec2 siteR = vec2(0.0);
  vec2 otherR = vec2(0.0);
  vec2 axisR = vec2(0.0);
  vec2 fieldR = countryCells(countryFieldSpace(i, vec2(w.x, countryDown(sR, d))), siteR, otherR, axisR);
  float borderR = fieldR.x * length(axisR / (vec2(d, countryDownRate(sR, d)) * COUNTRY_FIELDS));
  bool sameField = length(siteR - site) < 1e-4;
  bool inP = enclosed && borderP > set;
  bool inR = countryFieldCrop(fieldR.y, season) > 8.5 && borderR > set;
  float rise = -1.0;
  vec2 run = vec2(0.0);
  if (inP != inR) {
    // Signed distance (screen) to the fence line of the enclosure at the inside end, at both ends.
    float gP = inP || sameField ? borderP - set : -(borderP + set);
    float gR = inR || sameField ? borderR - set : -(borderR + set);
    rise = high * gP / (gP - gR);
    vec2 inside = inP ? axis : axisR;
    run = normalize(vec2(-inside.y, inside.x) / COUNTRY_FIELDS);
  }
  float aa = 0.6 * px;
  float post = 0.5 * COUNTRY_FENCE_POST / d;
  float rail = 0.5 * COUNTRY_FENCE_RAIL / d;
  float cover = 0.0;
  float rails = 0.0;
  float which = 0.0;
  vec2 wf = w;
  if (rise >= -aa && rise <= 1.08 * high) {
    wf = vec2(w.x, countryDown(s + rise, d));
    float along = dot(wf, run) / COUNTRY_FENCE_SPAN;
    which = floor(along + 0.5);
    float toPost = abs(along - which) * COUNTRY_FENCE_SPAN / (max(abs(run.x), 0.3) * d);
    float posts = softFill(toPost - post, aa) * softFill(rise - 1.06 * high, aa) * step(-aa, rise);
    rails = max(softFill(abs(rise - 0.42 * high) - rail, aa), softFill(abs(rise - 0.84 * high) - rail, aa));
    cover = max(posts, rails);
  }
  // End on, where the fence runs down the slope.
  if (enclosed) {
    float line = softFill(abs(borderP - set) - post, aa);
    if (line > cover) {
      cover = line;
      wf = w;
      rails = 0.0;
    }
  }
  if (cover <= 0.0) return vec4(0.0);
  // Gaps for the track and the river.
  if (i < 0.5) {
    vec2 lane = countryLane(wf.y, spots.x * 0.6);
    float zf = d * (1.0 - 0.35 * smoothstep(0.0, 0.2, countryDrop(wf.y, d)));
    if (abs(q.x * zf - lane.x) / sqrt(1.0 + lane.y * lane.y) < COUNTRY_LANE * 1.5) return vec4(0.0);
  } else {
    vec2 river = countryRiver(wf.y, (spots.x + 0.07) * d);
    if (abs(wf.x - river.x) / sqrt(1.0 + river.y * river.y) < (0.012 + 0.008 * clamp(wf.y / 0.6, 0.0, 1.0)) * 1.7 + 0.004) return vec4(0.0);
  }
  foot = wf.y;
  top = rails > 0.5 ? 0.45 : 0.25;
  vec3 timber = mix(vec3(0.42, 0.35, 0.27), vec3(0.6, 0.53, 0.42), rails) * (0.88 + 0.24 * hash12(vec2(which, site.x * 7.0)));
  return vec4(timber, cover);
}

// Pasture enclosures under this pixel of ridge i's patchwork: the fence (first two ridges) and the
// herd (first three), whichever stands nearer. crop: the pixel's field type; the rest as for
// countryHerdAt and countryFence.
CountryStock countryStock(float i, vec2 q, float s, float lean, vec2 w, float down, vec2 f, vec2 field, vec2 site,
                          vec2 axis, float crop, float season, float hedgeMean, vec2 spots) {
  float d = countryLayer(i).x;
  float herdFoot = -1.0;
  CountryStock st = countryNoStock();
  if (crop > 8.5) st = countryHerdAt(i, d, q, s, lean, w, down, f, site, hedgeMean, spots, herdFoot);
  if (i < 1.5) {
    float fenceFoot = -1.0;
    float top = 0.0;
    vec4 fence = countryFence(i, d, q, s, w, down, field, site, axis, crop > 8.5, season, hedgeMean, spots, fenceFoot, top);
    if (fence.a > 0.0 && (st.cover <= 0.0 || fenceFoot > herdFoot)) {
      st.cover = fence.a;
      st.albedo = fence.rgb;
      st.normal = normalize(vec3(0.0, 0.3, -0.95));
      st.snow = top;
      st.porous = 0.6;
    }
  }
  return st;
}
`;
