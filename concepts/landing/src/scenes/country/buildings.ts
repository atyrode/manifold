// The countryside's buildings: near ones modelled, far ones the shared sprites (shaders/buildings.ts),
// the castle always modelled (castle.ts).
//
// A cottage, barn or church whose gable spans more than COUNTRY_MODEL_CELLS dither cells is a solid
// the eye ray meets in the building's own frame (x along its ridge, the record's facing; y up from
// its terrace; z across): a block under a pitched roof (one convex solid, countryBlock), a cottage's
// chimney stack on the ridge, a church's square tower at its west gable and the spire on it, so it
// reads true from the vantage's oblique heading. Its faces carry the sprites' windows (at the same
// places along the walls, lit by buildingWindow), its chimney the shared smoke. Smaller ones are the
// sprites projected from their footings, as before.
//
// Their life, each compiled in only while its knob is on: windows lighting one by one as dusk
// falls and most going dark late at night, `lights` the share of them that ever light (a church's
// and the castle's half that), warming the walls and the ground round a lit cottage or farmhouse
// (COUNTRY_HAS_LIGHTS); smoke curling from the cottages' chimney stacks and leaning with the wind,
// thicker as the light goes, `settlementsSmoke` its density (COUNTRY_HAS_SMOKE). Both are the
// settlements layer's knobs, read through the valley's macros (VALLEY_LIGHTS, VALLEY_SMOKE).
import { glslFloat } from "../../shaders/glsl.ts";
import { TERRAIN_MAX_COTTAGES } from "../../sims/terrain-limits.ts";
import { TERRAIN_HOUSE, TERRAIN_MAX_PLACES } from "../../sims/terrain.ts";
import { COUNTRY_CASTLE_REACH, countryCastleGlsl } from "./castle.ts";

/** A building is modelled once its gable spans this many dither cells; smaller, it is a sprite. */
export const COUNTRY_MODEL_CELLS = 6;

export const countryBuildingsGlsl = /* glsl */ `
const float COUNTRY_HOUSE = ${glslFloat(TERRAIN_HOUSE)}; // metres a house unit (a cottage gable, drawn half again life size)
const float COUNTRY_MODEL_CELLS = ${glslFloat(COUNTRY_MODEL_CELLS)};
// The share of windows that ever light (the lights knob; none while it is off).
#if COUNTRY_HAS_LIGHTS
#define COUNTRY_LIGHTS VALLEY_LIGHTS
#else
#define COUNTRY_LIGHTS 0.0
#endif

// The ray (o, d) in a solid's frame against the solid |x| <= size.x, |z| <= size.y, y >= -sink,
// under a roof y <= top - slope.x |x| - slope.y |z| (slope 0: flat; one slope: a gable roof; both:
// a pyramid). The entering t (-1: missed, or the eye inside) and the face's outward normal there.
float countryBlock(vec3 o, vec3 d, vec2 size, float sink, float top, vec2 slope, out vec3 n) {
  float enter = 0.0;
  float leave = 1e9;
  n = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    vec3 plane;
    float offset;
    if (i < 4) {
      float sx = i == 0 ? 1.0 : (i == 1 ? -1.0 : 0.0);
      float sz = i == 2 ? 1.0 : (i == 3 ? -1.0 : 0.0);
      plane = vec3(sx, 0.0, sz);
      offset = i < 2 ? size.x : size.y;
    } else if (i == 4) {
      plane = vec3(0.0, -1.0, 0.0);
      offset = sink;
    } else {
      float sx = (i - 5) - ((i - 5) / 2) * 2 == 0 ? 1.0 : -1.0;
      float sz = i < 7 ? 1.0 : -1.0;
      plane = vec3(sx * slope.x, 1.0, sz * slope.y);
      offset = top;
    }
    float along = dot(plane, d);
    float room = offset - dot(plane, o);
    if (abs(along) < 1e-7) {
      if (room < 0.0) return -1.0;
      continue;
    }
    float t = room / along;
    if (along < 0.0) {
      if (t > enter) {
        enter = t;
        n = plane;
      }
    } else {
      leave = min(leave, t);
    }
  }
  if (enter > leave || dot(n, n) < 0.5) return -1.0;
  n = normalize(n);
  return enter;
}

// A building's face under this pixel, nearer than zLimit (camera depth): its face (buildings.ts's
// codes: 1 gable end, 2 long wall, 3 roof, 4 chimney, 5 tower, 6 tower side, 7 spire, 9 belfry; the
// castle's own, castle.ts; 0 none), window, hash, kind, depth, a cell in its units (the castle's:
// metres), its normal (world) and the point on the face (metres: along it, up it) for courses and
// tiles.
struct CountryFind { float face; float pane; float hash; float kind; float z; float px; vec3 n; vec2 wall; };

CountryFind countryNoBuilding(float zLimit) {
  return CountryFind(0.0, 0.0, 0.0, 0.0, zLimit, 1.0, vec3(0.0, 1.0, 0.0), vec2(0.0));
}

// A house's unit (metres a gable), and its shape's proportions in units: length, eaves, ridge.
float countryUnit(TerrainBuilding b) {
  return COUNTRY_HOUSE * (b.kind > TERRAIN_BUILDING_BARN - 0.5 ? 1.25 : 1.0);
}
${countryCastleGlsl}

// House b as the ray (eye, rd; q its pinhole point) meets it nearer than zLimit: modelled while its
// gable spans more than COUNTRY_MODEL_CELLS cells, else the sprite.
CountryFind countryBuilding(TerrainBuilding b, vec3 eye, vec3 rd, vec2 q, float pxl, float zLimit) {
  CountryFind f = countryNoBuilding(zLimit);
  bool church = b.kind > TERRAIN_BUILDING_CHURCH - 0.5 && b.kind < TERRAIN_BUILDING_CHURCH + 0.5;
  bool cottage = b.kind < 0.5;
  bool stack = cottage && fract(b.hash * 7.7) < 0.6;
  float unit = countryUnit(b);
  float len = church ? 2.5 : b.span;
  float wall = church ? 1.0 : 0.75;
  float rise = church ? 0.62 : 0.55;
  vec2 l = vec2(cos(b.facing), sin(b.facing));
  vec3 db = b.at - eye;
  if (unit / (dot(db, countryFwd) * pxl) > COUNTRY_MODEL_CELLS) {
    // Modelled: the ray in the building's frame, against its block, stack, tower and spire.
    vec3 along = vec3(l.x, 0.0, l.y);
    vec3 across = vec3(-l.y, 0.0, l.x);
    vec3 o = vec3(dot(-db, along), -db.y, dot(-db, across));
    vec3 dir = vec3(dot(rd, along), rd.y, dot(rd, across));
    vec2 size = 0.5 * unit * vec2(len, 1.0);
    vec3 n;
    float hit = countryBlock(o, dir, size, 3.0, (wall + rise) * unit, vec2(0.0, rise / 0.5), n);
    float face = n.y > 0.3 ? 3.0 : (abs(n.x) > 0.5 ? 1.0 : 2.0);
    vec3 nb;
    vec3 tower = vec3(-size.x - 0.35 * unit, 0.0, 0.0);
    if (stack) {
      float tb = countryBlock(o - vec3(0.3 * size.x, (wall + rise + 0.3) * unit, 0.0), dir, vec2(0.085 * unit), 0.45 * unit, 0.0, vec2(0.0), nb);
      if (tb > 0.0 && (hit < 0.0 || tb < hit)) {
        hit = tb;
        n = nb;
        face = 4.0;
      }
    }
    if (church) {
      float tb = countryBlock(o - tower, dir, vec2(0.35 * unit), 3.0, 2.3 * unit, vec2(0.0), nb);
      if (tb > 0.0 && (hit < 0.0 || tb < hit)) {
        hit = tb;
        n = nb;
        face = abs(nb.x) > 0.5 ? 5.0 : 6.0;
      }
      tb = countryBlock(o - tower - vec3(0.0, 2.3 * unit, 0.0), dir, vec2(0.35 * unit), 0.0, 2.08 * unit, vec2(2.08 / 0.35), nb);
      if (tb > 0.0 && (hit < 0.0 || tb < hit)) {
        hit = tb;
        n = nb;
        face = 7.0;
      }
    }
    float zb = hit * dot(rd, countryFwd);
    if (hit <= 0.0 || zb >= zLimit) return f;
    vec3 p = o + dir * hit;
    float px = pxl * zb / unit;
    // Windows where the sprites have them: the gable's middle, a third and two thirds along the
    // long walls, between sill and lintel (the church's nave a row of tall ones, its tower the
    // belfry); at least a cell, so a lit one shows far off.
    float pane = 0.0;
    float up = p.y / unit;
    if (face < 2.5 && !church && buildingSill(up, wall, px)) {
      float reach = max(0.14, 0.5 * px);
      if (face < 1.5 && abs(p.z) / unit < max(0.16, 0.5 * px)) pane = 1.0;
      if (face > 1.5 && abs(p.x / unit + 0.2 * len) < reach) pane = 2.0;
      if (face > 1.5 && abs(p.x / unit - 0.22 * len) < reach) pane = 3.0;
    }
    if (church && face > 1.5 && face < 2.5 && abs(fract(p.x / unit / 0.5) - 0.5) < max(0.12, 0.5 * px) && up > 0.35 && up < 0.8) pane = 2.0;
    if (face > 4.5 && face < 6.5 && px < 0.26 && up > 1.8 && up < 2.12 && abs(face < 5.5 ? p.z : p.x - tower.x) < 0.13 * unit) face = 9.0;
    return CountryFind(face, pane, b.hash, b.kind, zb, px, normalize(along * n.x + vec3(0.0, n.y, 0.0) + across * n.z), vec2(abs(n.x) > 0.5 ? p.z : p.x, face > 2.5 && face < 3.5 ? abs(p.z) : p.y));
  }
  // A sprite, corner-on: its front corner half its length back toward us along the long wall.
  if (dot(l, countryFwd.xz) < 0.0) l = -l;
  float lr = dot(l, countryRight.xz);
  float flip = lr < 0.0 ? -1.0 : 1.0;
  float lenS = b.span * clamp(abs(lr), 0.35, 1.0);
  vec3 dc = db - vec3(l.x, 0.0, l.y) * 0.5 * b.span * unit;
  float zb = dot(dc, countryFwd);
  if (zb < 20.0 || zb > zLimit) return f;
  float scale = zb / unit;
  vec2 h = (q - vec2(dot(dc, countryRight), dc.y) / zb) * scale;
  float px = pxl * scale;
  float recede = clamp(-dc.y / zb * max(dot(l, countryFwd.xz), 0.0) / max(abs(lr), 0.35), 0.03, 0.9);
  float pane = 0.0;
  float face = 0.0;
  h.x *= flip;
  if (church) {
    if (h.x > -1.2 && h.x < 2.9 && h.y > -0.3 && h.y < 4.6) face = buildingChurch(h, recede, -0.3, px, pane);
  } else if (h.x > -1.15 && h.x < lenS + 0.15 && h.y > -0.3 && h.y < 0.75 + 0.55 + 0.6 + lenS * recede) {
    face = buildingCottage(h, lenS, 0.75, 0.55, recede, cottage, -0.3, px, pane);
  }
  if (face < 0.5) return f;
  // The sprites' faces as the eye sees them (camera frame, mirrored with the sprite).
  vec3 nc = vec3(-0.62, 0.0, -0.78);
  if (face > 1.5 && face < 2.5 || face > 5.5 && face < 6.5) nc = vec3(0.78, 0.0, -0.62);
  else if (face > 2.5 && face < 3.5) nc = normalize(vec3(0.42, 0.78, -0.46));
  else if (face > 6.5 && face < 8.5) nc = face < 7.5 ? normalize(vec3(-0.55, 0.45, -0.7)) : normalize(vec3(0.6, 0.45, -0.66));
  nc.x *= flip;
  return CountryFind(face, pane, b.hash, b.kind, zb, px, normalize(countryToWorld(nc)), h * unit);
}

// The building under this pixel nearer than zLimit, and the glow of lit windows (and in the valley
// fog their halo, the light the fog round them scatters, fog.ts) and the smoke of chimneys around.
// The settlements near the pixel's column are walked for the two nearest houses whose bounds hold
// the pixel, then only those two are drawn (countryBuilding), so the cost per pixel stays two
// buildings' however many a village holds; and the castle, where its bounds hold it.
CountryFind countryBuildings(vec3 eye, vec3 rd, vec2 q, float pxl, float zLimit, float tod, float dark, float wind, inout float glow, inout float halo, inout float smoke) {
  ivec2 counts = terrainCounts(valleyField3);
  int first = -1;
  int second = -1;
  int castleIndex = -1;
  float near1 = 1e9;
  float near2 = 1e9;
  for (int s = 0; s < ${TERRAIN_MAX_PLACES}; s++) {
    if (s >= counts.x) break;
    TerrainPlace place = terrainPlace(valleyField3, s);
    vec3 d = place.at - eye;
    float zc = dot(d, countryFwd);
    if (zc < 30.0) continue;
    vec2 centre = vec2(dot(d, countryRight), d.y) / zc;
    float reach = (place.radius + 70.0) / zc;
    if (abs(q.x - centre.x) > reach || q.y < centre.y - reach || q.y > centre.y + reach + 80.0 / zc) continue;
#if COUNTRY_HAS_LIGHTS && COUNTRY_HAS_FOG
    // How much light the valley fog round this settlement scatters from its lit windows.
    float spread = VALLEY_LIGHTS > 0.0 && K_fog > 0.0 ? countryFogHalo(place.at) : 0.0;
#endif
    // The village's cottages and its church, the most any settlement holds.
    for (int k = 0; k < ${TERRAIN_MAX_COTTAGES + 1}; k++) {
      if (k >= place.count) break;
      TerrainBuilding b = terrainBuilding(valleyField3, place.first + k);
      bool castle = b.kind > TERRAIN_BUILDING_CASTLE - 0.5;
      vec3 db = b.at - eye;
      float zm = dot(db, countryFwd);
      if (zm < 20.0) continue;
      if (castle) {
        // Its bounds on screen: its reach round its centre, seen at its near side and its far one.
        float reachC = ${glslFloat(COUNTRY_CASTLE_REACH.radius)};
        vec2 zs = vec2(max(zm - reachC, 20.0), zm + reachC);
        float dx = dot(db, countryRight);
        vec4 xs = vec4((dx - reachC) / zs, (dx + reachC) / zs);
        vec4 ys = vec4((db.y - ${glslFloat(COUNTRY_CASTLE_REACH.sink)}) / zs, (db.y + ${glslFloat(COUNTRY_CASTLE_REACH.top)}) / zs);
        if (zm - reachC > zLimit || q.x < min(min(xs.x, xs.y), min(xs.z, xs.w)) || q.x > max(max(xs.x, xs.y), max(xs.z, xs.w)) || q.y < min(min(ys.x, ys.y), min(ys.z, ys.w)) || q.y > max(max(ys.x, ys.y), max(ys.z, ys.w))) continue;
        castleIndex = place.first + k;
        continue;
      } else {
        float unit = countryUnit(b);
        vec2 at = vec2(dot(db, countryRight), db.y) / zm;
        vec2 l = vec2(cos(b.facing), sin(b.facing));
#if COUNTRY_HAS_LIGHTS
        // Lit windows warm the walls and the ground around (a barn has none lit, a church's half).
        if (VALLEY_LIGHTS > 0.0 && (b.kind < TERRAIN_BUILDING_BARN - 0.5)) {
          float share = b.kind > 0.5 ? 0.5 * VALLEY_LIGHTS : VALLEY_LIGHTS;
          float lit = buildingWindow(fract(b.hash * 91.0 + 0.13), tod, dark, share) + buildingWindow(fract(b.hash * 91.0 + 0.57), tod, dark, share);
          vec2 g = (q - at) * zm / unit - vec2(0.0, 0.4);
          glow += lit * exp(-dot(g, g) * 0.3);
#if COUNTRY_HAS_FOG
          halo += lit * spread * exp(-dot(g, g) * 0.05);
#endif
        }
#endif
#if COUNTRY_HAS_SMOKE
        // A lit hearth smokes from a cottage's stack, thicker as the light goes.
        if (VALLEY_SMOKE > 0.0 && b.kind < 0.5 && fract(b.hash * 7.7) < 0.6) {
          vec3 top = db + vec3(l.x, 0.0, l.y) * 0.15 * b.span * unit + vec3(0.0, 1.6 * unit, 0.0);
          float zt = dot(top, countryFwd);
          smoke = max(smoke, buildingSmoke(q, vec2(dot(top, countryRight), top.y) / zt, 9.0 * unit / zt, b.hash, uMotionTime, wind) * (0.4 + 0.6 * dark) * (0.35 + 0.85 * VALLEY_SMOKE));
        }
#endif
        // Its bounds on screen: its length as it runs across the view and a gable either side, its
        // roof or tower above (the church's length is the nave's).
        float run = 0.5 * (b.kind > 0.5 && b.kind < 1.5 ? 2.5 : b.span) * max(abs(dot(l, countryRight.xz)), 0.35) + 1.2;
        float tall = (b.kind > 0.5 && b.kind < 1.5 ? 4.5 : 2.0) + 0.5 * b.span;
        float low = 0.3 + 0.25 * b.span;
        if (zm - run * unit > zLimit || abs(q.x - at.x) > run * unit / zm || q.y < at.y - low * unit / zm || q.y > at.y + tall * unit / zm) continue;
      }
      int index = place.first + k;
      if (zm < near1) {
        second = first;
        near2 = near1;
        first = index;
        near1 = zm;
      } else if (zm < near2) {
        second = index;
        near2 = zm;
      }
    }
  }
  CountryFind f = countryNoBuilding(zLimit);
  if (first >= 0) f = countryBuilding(terrainBuilding(valleyField3, first), eye, rd, q, pxl, zLimit);
  if (second >= 0) {
    CountryFind behind = countryBuilding(terrainBuilding(valleyField3, second), eye, rd, q, pxl, f.z);
    if (behind.face > 0.5) f = behind;
  }
  // A loop of at most one turn rather than an if: a software rasteriser runs every line of a
  // branch whichever way its pixels go, but no turn of a loop none of them enters, so the castle
  // costs only where it stands.
  int castles = castleIndex >= 0 ? 1 : 0;
  for (int i = 0; i < castles; i++) {
    CountryFind castle = countryCastle(terrainBuilding(valleyField3, castleIndex), eye, rd, pxl, f.z);
    if (castle.face > 0.5) f = castle;
  }
  return f;
}

// How a building's face looks: albedo, and through outs its lamp (a lit window), how much snow it
// holds (-1: none of its own), how porous and how glossy it is wet.
vec3 countryBuildingLook(CountryFind found, float tod, float dark, out float lamp, out float snowy, out float porous, out float glossy) {
  if (found.kind > TERRAIN_BUILDING_CASTLE - 0.5) return countryCastleLook(found, tod, dark, COUNTRY_LIGHTS, lamp, snowy, porous, glossy);
  lamp = 0.0;
  snowy = 0.0;
  porous = 0.6;
  glossy = 0.05;
  float hw = fract(found.hash * 11.3);
  float hr = fract(found.hash * 23.7);
  bool church = found.kind > 0.5 && found.kind < 1.5;
  bool barn = found.kind > 1.5 && found.kind < 2.5;
  vec3 wall = church ? vec3(0.7, 0.68, 0.62) : (hw < 0.35 ? vec3(0.84, 0.77, 0.62) : (hw < 0.6 ? vec3(0.88, 0.87, 0.82) : (hw < 0.85 ? vec3(0.62, 0.36, 0.26) : vec3(0.6, 0.6, 0.57))));
  vec3 roof = church ? vec3(0.27, 0.29, 0.33) : (hr < 0.5 ? vec3(0.56, 0.26, 0.17) : (hr < 0.8 ? vec3(0.26, 0.28, 0.32) : vec3(0.58, 0.48, 0.3)));
  if (barn) {
    wall = hw < 0.4 ? vec3(0.34, 0.26, 0.2) : (hw < 0.7 ? vec3(0.55, 0.24, 0.17) : vec3(0.66, 0.62, 0.54));
    roof = hr < 0.5 ? vec3(0.27, 0.28, 0.31) : vec3(0.46, 0.3, 0.22);
  }
  float f = found.face;
  vec3 albedo;
  // Courses on the walls and tiles on the roofs, where a course spans a few cells.
  float held = smoothstep(0.08, 0.03, found.px);
  if (f < 2.5 || (f > 4.5 && f < 6.5)) {
    albedo = wall * (f > 1.5 && f < 2.5 ? 0.97 : 1.0) * (1.0 - 0.07 * held * step(0.82, fract(found.wall.y / 0.9)));
  } else if (f < 3.5) {
    albedo = roof * (1.0 - 0.12 * held * step(0.7, fract(found.wall.y / 0.55)));
    snowy = 1.0;
    glossy = 0.2;
    porous = 0.1;
  } else if (f < 4.5) {
    albedo = vec3(0.5, 0.3, 0.22);
  } else if (f < 8.5) {
    albedo = vec3(0.45, 0.47, 0.5);
    snowy = 0.5;
  } else {
    albedo = vec3(0.08, 0.07, 0.07);
  }
  if (found.pane > 0.5 && !barn) {
    float lit = buildingWindow(fract(found.hash * 91.0 + (found.pane < 1.5 ? 0.13 : (found.pane < 2.5 ? 0.57 : 0.89))), tod, dark, church ? 0.5 * COUNTRY_LIGHTS : COUNTRY_LIGHTS);
    if (found.px < 0.25 || lit > 0.5) {
      albedo = vec3(0.1, 0.12, 0.16);
      lamp = lit;
    }
  }
  return albedo;
}
`;
