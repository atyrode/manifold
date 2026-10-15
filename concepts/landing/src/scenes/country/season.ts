// The farming year (`season`: K_season 0 summer, 1 harvest, 2 autumn) over the land model's parcels
// (sims/landuse.ts): every crop parcel keeps the kind its record gives it and shows that kind as
// the season has it, and the rest of the land follows.
//
//   kind       summer                  harvest (the default)        autumn
//   wheat      green, standing         gold, standing               drilled: green rows on earth
//   barley     green-gold, standing    stubble, its straw baled     ploughed, a few old stubbles
//   grazing    lush                    green                        duller
//   hay        standing, in flower     the mown aftermath           the aftermath, duller
//   ploughed   dry fallow              earth                        fresh furrows, darker
//   rapeseed   yellow, in flower       stubble                      ploughed
//
// A pasture's grass is grazing's. The flower fields take the shared fields' autumn (meadows gone to
// seed, lavender cut back, the sunflowers' heads hanging brown); open grassland turns lusher in
// summer and tawnier in autumn, the hedges russet, and the broadleaf trees turn, each its own colour
// (the near crowns, trees.ts's countryLeaves, and the far canopy crown by crown, settling to the
// turned woods' mean where crowns grow too small), while the pines stay evergreen. This GLSL goes
// ahead of trees.ts's in the scene's program.
//
// Round bales (COUNTRY_HAS_BALES: only at harvest, with crops on) lie on the barley's stubble, at
// most one to a cell of a grid along the field's rows, inside the field's clear core (terrainCore)
// or, looked up there, on its own ground well inside its border and clear of roads, streams, yards
// and trees; each a cylinder on its side met exactly by the ray in front of the ground it reached.
// A software renderer runs every line of a program, so the bales' cells are walked first and only
// the one bale a pixel finds is looked up.
export const countrySeasonGlsl = /* glsl */ `
// ---- the farming year (season.ts) ----
const float COUNTRY_STANDING = 0.0;   // a standing crop: drill rows and tramlines
const float COUNTRY_SWARD = 1.0;      // grass: the mower's stripes
const float COUNTRY_EARTH = 2.0;      // bare earth in furrows
const float COUNTRY_STUBBLE = 3.0;    // the combine's passes, the cut rows in them
const float COUNTRY_DRILLED = 4.0;    // green shoots in rows on bare earth
const float COUNTRY_MEADOW = 5.0;     // hay standing uncut, flecked with flowers

// What a crop parcel of this kind (LAND_CROP_*) shows in the season; h: the parcel's hash. Barley
// and rapeseed are cut before the wheat; by autumn the plough has had most of their stubbles.
float countryFieldLook(float kind, float h) {
  float k = floor(kind + 0.5);
  float season = K_season;
  float cut = season < 1.5 || (k == LAND_CROP_BARLEY && fract(h * 29.3) > 0.6) ? COUNTRY_STUBBLE : COUNTRY_EARTH;
  float arable = season < 0.5 ? COUNTRY_STANDING : (k == LAND_CROP_WHEAT ? (season < 1.5 ? COUNTRY_STANDING : COUNTRY_DRILLED) : cut);
  float hay = season < 0.5 ? COUNTRY_MEADOW : COUNTRY_SWARD;
  return k == LAND_CROP_GRAZING ? COUNTRY_SWARD : (k == LAND_CROP_HAY ? hay : (k == LAND_CROP_PLOUGHED ? COUNTRY_EARTH : arable));
}

// A crop field's colour and the relief of its rows, as the season has its kind. kind: LAND_CROP_*
// (a pasture's grass is LAND_CROP_GRAZING); h: the parcel's hash; r: row space along and across its
// heading (metres); foot: metres a cell covers there.
vec3 countryField(float kind, float h, vec2 r, float foot, out float rows) {
  float k = floor(kind + 0.5);
  float season = K_season;
  float look = countryFieldLook(kind, h);
  float h2 = fract(h * 13.7);
  float hold = smoothstep(2.5, 6.0, 3.2 / foot);
  rows = 0.5 + 0.5 * hold * sin(r.y * TAU / 3.2);
  float tram = smoothstep(4.0, 9.0, 24.0 / foot) * (1.0 - smoothstep(0.0, 0.7, abs(fract(r.y / 24.0) - 0.5) * 24.0 - 0.3));
  vec3 earth = mix(season < 0.5 ? vec3(0.48, 0.37, 0.25) : (season < 1.5 ? vec3(0.4, 0.29, 0.19) : vec3(0.36, 0.25, 0.16)), season < 0.5 ? vec3(0.55, 0.42, 0.28) : (season < 1.5 ? vec3(0.48, 0.35, 0.23) : vec3(0.44, 0.3, 0.2)), h2);
  vec3 c = earth;
  float relief = 1.0;
  if (look == COUNTRY_STANDING) {
    c = k == LAND_CROP_WHEAT
      ? (season < 0.5 ? mix(vec3(0.5, 0.6, 0.26), vec3(0.6, 0.66, 0.3), h2) : mix(vec3(0.74, 0.6, 0.28), vec3(0.82, 0.68, 0.33), h2))
      : (k == LAND_CROP_BARLEY ? mix(vec3(0.62, 0.66, 0.4), vec3(0.7, 0.71, 0.45), h2) : mix(vec3(0.86, 0.78, 0.16), vec3(0.93, 0.84, 0.22), h2));
    relief = 0.92 + 0.14 * rows - 0.1 * tram;
  } else if (look == COUNTRY_SWARD) {
    // Grazed or mown: the mower's stripes; lusher in summer, duller in autumn.
    c = k == LAND_CROP_HAY ? mix(vec3(0.44, 0.52, 0.22), vec3(0.52, 0.56, 0.26), h2) : mix(vec3(0.3, 0.46, 0.18), vec3(0.38, 0.52, 0.2), h2);
    c *= season < 0.5 ? vec3(0.97, 1.06, 1.03) : (season > 1.5 ? vec3(1.03, 0.92, 0.94) : vec3(1.0));
    relief = 0.94 + 0.1 * hold * (0.5 + 0.5 * sin(r.y * TAU / 9.0));
  } else if (look == COUNTRY_STUBBLE) {
    // The combine's passes, there and back, paler and darker by turns; barley's straw pale gold,
    // rapeseed's grey-brown, and weathered grey by autumn.
    c = season > 1.5 ? mix(vec3(0.64, 0.58, 0.43), vec3(0.7, 0.63, 0.47), h2)
      : (k == LAND_CROP_RAPESEED ? mix(vec3(0.55, 0.5, 0.36), vec3(0.62, 0.56, 0.4), h2) : mix(vec3(0.84, 0.72, 0.44), vec3(0.9, 0.78, 0.5), h2));
    float passes = 0.5 + 0.5 * smoothstep(2.5, 6.0, 18.0 / foot) * clamp(12.0 * abs(fract(r.y / 18.0) - 0.5) - 3.0, -1.0, 1.0);
    relief = 0.88 + 0.14 * passes + 0.06 * rows - 0.06 * tram;
  } else if (look == COUNTRY_MEADOW) {
    // Tall grass flecked with flowers where a cell is small enough to hold them.
    float flowers = step(0.8, hash12(floor(r * 1.4) + h * 50.0)) * smoothstep(0.9, 0.45, foot);
    c = mix(mix(vec3(0.44, 0.55, 0.23), vec3(0.5, 0.58, 0.27), h2), vec3(0.88, 0.84, 0.9), 0.45 * flowers);
  } else if (look == COUNTRY_DRILLED) {
    c = mix(earth, vec3(0.33, 0.49, 0.2), 0.15 + 0.6 * rows);
  } else {
    // Furrows.
    relief = 0.86 + 0.24 * rows;
  }
  return c * relief;
}

// How much rain a crop parcel soaks up (wetten's porous): bare earth most, stubble less, the
// crops' and grass's leaves shed it.
float countryFieldPorous(float kind, float h) {
  float look = countryFieldLook(kind, h);
  return look == COUNTRY_EARTH ? 0.85 : (look == COUNTRY_DRILLED ? 0.75 : (look == COUNTRY_STUBBLE ? 0.6 : 0.5));
}

// Open grass as the season has it: lusher in summer, tawnier in autumn.
vec3 countrySward(vec3 grass) {
  return K_season < 0.5 ? grass * vec3(0.97, 1.04, 1.0) : (K_season > 1.5 ? grass * vec3(1.08, 0.94, 0.9) : grass);
}

// A hedge's leaves: dark green, russet once autumn turns them.
vec3 countryHedge() {
  return K_season > 1.5 ? vec3(0.24, 0.17, 0.07) : vec3(0.11, 0.19, 0.08);
}

// A broadleaf's leaves (leaf: its green; h: its hash) as the season has them: in autumn each tree
// turns its own way, orange, russet or gold, a quarter still green.
vec3 countryTurn(vec3 leaf, float h) {
  if (K_season < 1.5) return leaf;
  float th = fract(h * 41.0);
  vec3 turned = th < 0.3 ? vec3(0.6, 0.34, 0.1) : (th < 0.55 ? vec3(0.48, 0.22, 0.08) : (th < 0.75 ? vec3(0.66, 0.54, 0.16) : vec3(0.25, 0.34, 0.12)));
  return turned * (0.9 + 0.2 * fract(h * 9.7));
}

// The far canopy of the woods or a lone tree (leaf: its green at p; foot: metres a cell spans
// there; lonePine: a lone tree's that is a pine, which keeps it) as the season has it: in autumn,
// crown by crown where a crown spans a cell or two, settling farther off to the turned woods' mean,
// in broad patches as their trees' kinds go. The pine woods' colour goes over it after.
vec3 countryCanopyTurn(vec3 leaf, vec2 p, float foot, bool lonePine) {
  if (K_season < 1.5 || lonePine) return leaf;
  vec3 crowns = countryTurn(leaf, hash12(floor(p / 6.0) + 0.5));
  vec3 mean = mix(vec3(0.5, 0.3, 0.1), vec3(0.42, 0.38, 0.14), smoothstep(0.25, 0.75, vnoise(p / 45.0)));
  return mix(crowns, mean, smoothstep(2.0, 5.0, foot));
}

#if COUNTRY_HAS_BALES
const float COUNTRY_BALE_RADIUS = 1.05;            // a round bale, metres (drawn large, as the herds are)
const float COUNTRY_BALE_HALF = 0.85;              // half its width along its axis, metres
const vec2 COUNTRY_BALE_GRID = vec2(26.0, 18.0);   // a bale's cell: along the rows, across them, metres

// The ray (ro, rd) against a bale lying on its side, its base's centre at base, its axis on the map
// axis: the distance to it (-1 none), its normal there (world), and rim: -1 on its round side, on a
// rolled end how far out from the end's centre (0..1).
float countryBaleHit(vec3 ro, vec3 rd, vec3 base, vec2 axis, out vec3 n, out float rim) {
  n = vec3(0.0, 1.0, 0.0);
  rim = -1.0;
  vec3 ax = vec3(axis.x, 0.0, axis.y);
  vec3 side = vec3(-axis.y, 0.0, axis.x);
  vec3 o = ro - base - vec3(0.0, COUNTRY_BALE_RADIUS, 0.0);
  // Along the axis, across it, up.
  vec3 lo = vec3(dot(o, ax), dot(o, side), o.y);
  vec3 ld = vec3(dot(rd, ax), dot(rd, side), rd.y);
  float r2 = COUNTRY_BALE_RADIUS * COUNTRY_BALE_RADIUS;
  float qa = dot(ld.yz, ld.yz);
  float qb = dot(lo.yz, ld.yz);
  float disc = qb * qb - qa * (dot(lo.yz, lo.yz) - r2);
  if (disc < 0.0 || qa < 1e-8) return -1.0;
  float best = -1.0;
  float t = (-qb - sqrt(disc)) / qa;
  if (t > 0.0 && abs(lo.x + ld.x * t) <= COUNTRY_BALE_HALF) {
    best = t;
    vec2 at = (lo.yz + ld.yz * t) / COUNTRY_BALE_RADIUS;
    n = side * at.x + vec3(0.0, at.y, 0.0);
  }
  if (abs(ld.x) > 1e-6) {
    // The end the ray comes in by.
    float face = ld.x > 0.0 ? -1.0 : 1.0;
    float te = (face * COUNTRY_BALE_HALF - lo.x) / ld.x;
    vec2 at = lo.yz + ld.yz * te;
    if (te > 0.0 && dot(at, at) <= r2 && (best < 0.0 || te < best)) {
      best = te;
      n = ax * face;
      rim = length(at) / COUNTRY_BALE_RADIUS;
    }
  }
  return best;
}

// Whether a bale may lie at site in parcel id (core: its clear core): inside the core, or else (the
// parcel looked up there) on its own ground well inside its border, clear of the roads, streams,
// yards, trees and woods. Decided by the site alone, so a bale is whole or not there at all.
bool countryBaleClear(vec2 site, float id, vec3 core) {
  if (length(site - core.xy) < core.z - 2.0) return true;
  vec4 c = terrainCover(uSim1, site, COUNTRY_EXTENT);
  if (c.x < 5.0 || c.y < 4.0 || abs(c.z) > 0.01 || abs(c.w) > 0.02) return false;
  TerrainParcel here = terrainParcel(uSim2, uSim3, site, COUNTRY_EXTENT);
  return here.id == id && here.border > 6.0;
}

// Round bales on a barley field's stubble at harvest (parcel: the field under the ground point p
// the ray met at tHit, g the ground there; sun: toward the sun, world): at most one to a grid cell
// of the field's rows, where countryBaleClear lets it lie. The nearest the ray meets in front of
// the ground covers it (albedo, normal n, its own snow, porous); otherwise one whose foot or cast
// shadow p lies in shades the stubble. Not drawn under half a cell. The cells are walked first and
// only the one bale found is looked up, so the look-up runs once a pixel. A bale near the field's
// far side seen at a glancing angle loses its top where the ray behind it reaches the next field
// (as the herds do).
void countryBales(vec3 eye, vec3 rd, float tHit, vec3 p, vec4 g, TerrainParcel parcel, float cellAngle, float lying, vec3 sun, inout vec3 albedo, inout vec3 n, inout float snowy, inout float porous) {
  if (K_season < 0.5 || K_season > 1.5 || floor(parcel.attr + 0.5) != LAND_CROP_BARLEY) return;
  float fall = dot(g.zw, rd.xz) - rd.y;
  if (COUNTRY_BALE_RADIUS < 0.6 * tHit * cellAngle || fall < 1e-3) return;
  vec3 core = terrainCore(uSim3, parcel.id);
  vec2 along = parcel.axis;
  vec2 across = vec2(-along.y, along.x);
  // The ray's way over the field from where it comes down to a bale's height (two cells at most) to
  // the ground, in grid cells from the core's centre, walked cell by cell.
  float reach = min(2.4 * COUNTRY_BALE_RADIUS / fall, 2.0 * COUNTRY_BALE_GRID.y / max(length(rd.xz), 1e-3));
  vec2 a = eye.xz + rd.xz * max(tHit - reach, 0.0) - core.xy;
  vec2 b = p.xz - core.xy;
  vec2 s0 = vec2(dot(a, along), dot(a, across)) / COUNTRY_BALE_GRID;
  vec2 d = vec2(dot(b, along), dot(b, across)) / COUNTRY_BALE_GRID - s0;
  vec2 cell = floor(s0);
  vec2 stepDir = vec2(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0);
  vec2 safe = vec2(abs(d.x) < 1e-5 ? 1e-5 : d.x, abs(d.y) < 1e-5 ? 1e-5 : d.y);
  vec2 delta = abs(1.0 / safe);
  vec2 edge = (cell + max(stepDir, 0.0) - s0) / safe;
  vec2 track = rd.xz / max(length(rd.xz), 1e-4);
  // The bales' shadows fall away from the sun, no farther than a cell's margin.
  vec2 thrown = -sun.xz / max(sun.y, 0.25) * COUNTRY_BALE_RADIUS;
  thrown *= min(1.0, 3.0 / max(length(thrown), 1e-3));
  float sunlit = smoothstep(0.0, 0.1, sun.y);
  float tBale = tHit;
  vec3 baleN = vec3(0.0, 1.0, 0.0);
  float baleRim = -1.0;
  vec2 baleSite = vec2(0.0);
  float shade = 0.0;
  vec2 shadeSite = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    float h = hash12(cell * 1.37 + vec2(parcel.id * 0.618, 4.1));
    // About half the cells hold a bale, kept clear of the cell's sides by more than its shadow;
    // looked into only where the ray's track passes over it or p lies by it.
    vec2 at = cell * COUNTRY_BALE_GRID + 4.0 + hash22(cell + parcel.id * 0.37) * (COUNTRY_BALE_GRID - 8.0);
    vec2 site = core.xy + along * at.x + across * at.y;
    vec2 off = p.xz - site;
    vec2 seen = site - eye.xz;
    if (h < 0.5 && (abs(track.x * seen.y - track.y * seen.x) < 1.4 || dot(off, off) < 4.0 || dot(off - thrown, off - thrown) < 4.0)) {
      // Dropped by the baler across its way, give or take.
      float turn = (fract(h * 17.3) - 0.5) * 0.6;
      vec2 axis = cos(turn) * across + sin(turn) * along;
      vec2 extent = vec2(COUNTRY_BALE_HALF + 0.4, COUNTRY_BALE_RADIUS + 0.5);
      vec2 foot = vec2(dot(off, axis), dot(off, vec2(-axis.y, axis.x))) / extent;
      vec2 under = vec2(dot(off - thrown, axis), dot(off - thrown, vec2(-axis.y, axis.x))) / extent;
      float dark = max(0.4 * (1.0 - smoothstep(0.6, 1.0, length(foot))), 0.45 * sunlit * (1.0 - smoothstep(0.7, 1.0, length(under))));
      if (dark > shade) {
        shade = dark;
        shadeSite = site;
      }
      vec3 bn;
      float rim;
      float t = countryBaleHit(eye, rd, vec3(site.x, terrainSurface(terrainGround(uSim0, site, COUNTRY_EXTENT)), site.y), axis, bn, rim);
      if (t > 0.0 && t < tBale) {
        tBale = t;
        baleN = bn;
        baleRim = rim;
        baleSite = site;
      }
    }
    if (min(edge.x, edge.y) > 1.0) break;
    if (edge.x < edge.y) {
      cell.x += stepDir.x;
      edge.x += delta.x;
    } else {
      cell.y += stepDir.y;
      edge.y += delta.y;
    }
  }
  bool hit = tBale < tHit;
  if ((!hit && shade <= 0.0) || !countryBaleClear(hit ? baleSite : shadeSite, parcel.id, core)) return;
  if (!hit) {
    albedo *= 1.0 - shade;
    return;
  }
  vec3 surface = eye + rd * tBale;
  // Straw a shade deeper than the stubble round its side; the rolled end lighter at its heart,
  // darker to its rim.
  albedo = baleRim < 0.0
    ? vec3(0.72, 0.57, 0.31) * (0.9 + 0.15 * vnoise(surface.xz * 3.0 + surface.y * 5.0))
    : mix(vec3(0.76, 0.6, 0.33), vec3(0.5, 0.37, 0.18), smoothstep(0.5, 1.0, baleRim));
  n = baleN;
  snowy = snowCover(baleN, surface.xz * 2.0 + surface.y, lying);
  porous = 0.6;
}
#endif
`;
