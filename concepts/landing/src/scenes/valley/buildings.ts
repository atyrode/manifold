// The valley's buildings: near ones modelled, far ones the shared sprites (shaders/buildings.ts).
//
// A cottage, barn or church whose gable spans more than VALLEY_MODEL_CELLS dither cells is a solid
// the eye ray meets in the building's own frame (x along its ridge, the record's facing; y up from
// its terrace; z across): a block under a pitched roof (one convex solid, valleyBlock), a cottage's
// chimney stack on the ridge, a church's square tower at its west gable and the spire on it, so it
// reads true from the vantage's oblique heading. Its faces carry the sprites' windows (at the same
// places along the walls, lit by buildingWindow), its chimney the shared smoke. Smaller ones, and
// the castle at any size, are the sprites projected from their footings, as before.
import { glslFloat } from "../../shaders/glsl.ts";
import { TERRAIN_HOUSE } from "../../sims/terrain.ts";

/** A building is modelled once its gable spans this many dither cells; smaller, it is a sprite. */
export const VALLEY_MODEL_CELLS = 6;

export const valleyBuildingsGlsl = /* glsl */ `
const float VALLEY_HOUSE = ${glslFloat(TERRAIN_HOUSE)}; // metres a house unit (a cottage gable, drawn half again life size)
const float VALLEY_MODEL_CELLS = ${glslFloat(VALLEY_MODEL_CELLS)};

// The ray (o, d) in a solid's frame against the solid |x| <= size.x, |z| <= size.y, y >= -sink,
// under a roof y <= top - slope.x |x| - slope.y |z| (slope 0: flat; one slope: a gable roof; both:
// a pyramid). The entering t (-1: missed, or the eye inside) and the face's outward normal there.
float valleyBlock(vec3 o, vec3 d, vec2 size, float sink, float top, vec2 slope, out vec3 n) {
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
// castle's own; 0 none), window, hash, kind, depth, a cell in its units, its normal (world) and the
// point on the face (metres: along it, up it) for courses and tiles.
struct ValleyFind { float face; float pane; float hash; float kind; float z; float px; vec3 n; vec2 wall; };

ValleyFind valleyNoBuilding(float zLimit) {
  return ValleyFind(0.0, 0.0, 0.0, 0.0, zLimit, 1.0, vec3(0.0, 1.0, 0.0), vec2(0.0));
}

// A building's unit (metres a gable), and its shape's proportions in units: length, eaves, ridge.
float valleyUnit(TerrainBuilding b) {
  return b.kind > TERRAIN_BUILDING_CASTLE - 0.5 ? 5.5 : VALLEY_HOUSE * (b.kind > TERRAIN_BUILDING_BARN - 0.5 ? 1.25 : 1.0);
}

// Building b as the ray (eye, rd; q its pinhole point) meets it nearer than zLimit: modelled while
// its gable spans more than VALLEY_MODEL_CELLS cells (not the castle), else the sprite.
ValleyFind valleyBuilding(TerrainBuilding b, vec3 eye, vec3 rd, vec2 q, float pxl, float zLimit) {
  ValleyFind f = valleyNoBuilding(zLimit);
  bool castle = b.kind > TERRAIN_BUILDING_CASTLE - 0.5;
  bool church = b.kind > TERRAIN_BUILDING_CHURCH - 0.5 && b.kind < TERRAIN_BUILDING_CHURCH + 0.5;
  bool cottage = b.kind < 0.5;
  bool stack = cottage && fract(b.hash * 7.7) < 0.6;
  float unit = valleyUnit(b);
  float len = church ? 2.5 : b.length;
  float wall = church ? 1.0 : 0.75;
  float rise = church ? 0.62 : 0.55;
  vec2 l = vec2(cos(b.facing), sin(b.facing));
  vec3 db = b.at - eye;
  if (!castle && unit / (dot(db, valleyFwd) * pxl) > VALLEY_MODEL_CELLS) {
    // Modelled: the ray in the building's frame, against its block, stack, tower and spire.
    vec3 along = vec3(l.x, 0.0, l.y);
    vec3 across = vec3(-l.y, 0.0, l.x);
    vec3 o = vec3(dot(-db, along), -db.y, dot(-db, across));
    vec3 dir = vec3(dot(rd, along), rd.y, dot(rd, across));
    vec2 size = 0.5 * unit * vec2(len, 1.0);
    vec3 n;
    float hit = valleyBlock(o, dir, size, 3.0, (wall + rise) * unit, vec2(0.0, rise / 0.5), n);
    float face = n.y > 0.3 ? 3.0 : (abs(n.x) > 0.5 ? 1.0 : 2.0);
    vec3 nb;
    vec3 tower = vec3(-size.x - 0.35 * unit, 0.0, 0.0);
    if (stack) {
      float tb = valleyBlock(o - vec3(0.3 * size.x, (wall + rise + 0.3) * unit, 0.0), dir, vec2(0.085 * unit), 0.45 * unit, 0.0, vec2(0.0), nb);
      if (tb > 0.0 && (hit < 0.0 || tb < hit)) {
        hit = tb;
        n = nb;
        face = 4.0;
      }
    }
    if (church) {
      float tb = valleyBlock(o - tower, dir, vec2(0.35 * unit), 3.0, 2.3 * unit, vec2(0.0), nb);
      if (tb > 0.0 && (hit < 0.0 || tb < hit)) {
        hit = tb;
        n = nb;
        face = abs(nb.x) > 0.5 ? 5.0 : 6.0;
      }
      tb = valleyBlock(o - tower - vec3(0.0, 2.3 * unit, 0.0), dir, vec2(0.35 * unit), 0.0, 2.08 * unit, vec2(2.08 / 0.35), nb);
      if (tb > 0.0 && (hit < 0.0 || tb < hit)) {
        hit = tb;
        n = nb;
        face = 7.0;
      }
    }
    float zb = hit * dot(rd, valleyFwd);
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
    return ValleyFind(face, pane, b.hash, b.kind, zb, px, normalize(along * n.x + vec3(0.0, n.y, 0.0) + across * n.z), vec2(abs(n.x) > 0.5 ? p.z : p.x, face > 2.5 && face < 3.5 ? abs(p.z) : p.y));
  }
  // A sprite, corner-on: its front corner half its length back toward us along the long wall.
  if (dot(l, valleyFwd.xz) < 0.0) l = -l;
  float lr = dot(l, valleyRight.xz);
  float flip = lr < 0.0 ? -1.0 : 1.0;
  float lenS = castle ? 1.0 : b.length * clamp(abs(lr), 0.35, 1.0);
  vec3 dc = castle ? db : db - vec3(l.x, 0.0, l.y) * 0.5 * b.length * unit;
  float zb = dot(dc, valleyFwd);
  if (zb < 20.0 || zb > zLimit) return f;
  float scale = zb / unit;
  vec2 h = (q - vec2(dot(dc, valleyRight), dc.y) / zb) * scale;
  float px = pxl * scale;
  float recede = clamp(-dc.y / zb * max(dot(l, valleyFwd.xz), 0.0) / max(abs(lr), 0.35), 0.03, 0.9);
  float pane = 0.0;
  float across = 0.0;
  float face = 0.0;
  if (castle) {
    if (abs(h.x) < 9.0 && h.y > -1.5 && h.y < 9.5) {
      float slit = 0.0;
      face = buildingCastle(h, 0.0, px, flip, step(0.45, fract(b.hash * 13.1)), across, slit);
      pane = slit;
    }
  } else if (church) {
    h.x *= flip;
    if (h.x > -1.2 && h.x < 2.9 && h.y > -0.3 && h.y < 4.6) face = buildingChurch(h, recede, -0.3, px, pane);
  } else {
    h.x *= flip;
    if (h.x > -1.15 && h.x < lenS + 0.15 && h.y > -0.3 && h.y < 0.75 + 0.55 + 0.6 + lenS * recede) {
      face = buildingCottage(h, lenS, 0.75, 0.55, recede, cottage, -0.3, px, pane);
    }
  }
  if (face < 0.5) return f;
  // The sprites' faces as the eye sees them (camera frame, mirrored with the sprite).
  vec3 nc = vec3(-0.62, 0.0, -0.78);
  if (castle) {
    // Castle faces: 1 wall, 2 round tower, 3 tops, 4 gate, 5 keep front, 6 keep side, 7 roofs.
    nc = face > 2.5 && face < 3.5 ? vec3(0.0, 1.0, 0.0) : (face > 5.5 && face < 6.5 ? vec3(0.78, 0.0, -0.62) : normalize(vec3(across * 0.8, 0.0, -1.0)));
    if (face > 6.5) nc = normalize(vec3(across, 0.6, -0.8));
  } else {
    if (face > 1.5 && face < 2.5 || face > 5.5 && face < 6.5) nc = vec3(0.78, 0.0, -0.62);
    else if (face > 2.5 && face < 3.5) nc = normalize(vec3(0.42, 0.78, -0.46));
    else if (face > 6.5 && face < 8.5) nc = face < 7.5 ? normalize(vec3(-0.55, 0.45, -0.7)) : normalize(vec3(0.6, 0.45, -0.66));
    nc.x *= flip;
  }
  return ValleyFind(face, pane, b.hash, b.kind, zb, px, normalize(valleyToWorld(nc)), h * unit);
}

// The building under this pixel nearer than zLimit, and the glow of lit windows and the smoke of
// chimneys around. The settlements near the pixel's column are walked for the two nearest buildings
// whose bounds hold the pixel, then only those two are drawn (valleyBuilding), so the cost per pixel
// stays two buildings' however many a village holds.
ValleyFind valleyBuildings(vec3 eye, vec3 rd, vec2 q, float pxl, float zLimit, float tod, float dark, float wind, inout float glow, inout float smoke) {
  ivec2 counts = terrainCounts(uSim3);
  int first = -1;
  int second = -1;
  float near1 = 1e9;
  float near2 = 1e9;
  for (int s = 0; s < 16; s++) {
    if (s >= counts.x) break;
    TerrainPlace place = terrainPlace(uSim3, s);
    vec3 d = place.at - eye;
    float zc = dot(d, valleyFwd);
    if (zc < 30.0) continue;
    vec2 centre = vec2(dot(d, valleyRight), d.y) / zc;
    float reach = (place.radius + 70.0) / zc;
    if (abs(q.x - centre.x) > reach || q.y < centre.y - reach || q.y > centre.y + reach + 80.0 / zc) continue;
    for (int k = 0; k < 24; k++) {
      if (k >= place.count) break;
      TerrainBuilding b = terrainBuilding(uSim3, place.first + k);
      bool castle = b.kind > TERRAIN_BUILDING_CASTLE - 0.5;
      float unit = valleyUnit(b);
      vec3 db = b.at - eye;
      float zm = dot(db, valleyFwd);
      if (zm < 20.0) continue;
      vec2 at = vec2(dot(db, valleyRight), db.y) / zm;
      vec2 l = vec2(cos(b.facing), sin(b.facing));
      if (!castle) {
        // Lit windows warm the walls and the ground around; a lit hearth smokes.
        float lit = buildingWindow(fract(b.hash * 91.0 + 0.13), tod, dark, 0.7) + buildingWindow(fract(b.hash * 91.0 + 0.57), tod, dark, 0.7);
        vec2 g = (q - at) * zm / unit - vec2(0.0, 0.4);
        glow += lit * exp(-dot(g, g) * 0.3);
        if (b.kind < 0.5 && fract(b.hash * 7.7) < 0.6) {
          vec3 top = db + vec3(l.x, 0.0, l.y) * 0.15 * b.length * unit + vec3(0.0, 1.6 * unit, 0.0);
          float zt = dot(top, valleyFwd);
          smoke = max(smoke, buildingSmoke(q, vec2(dot(top, valleyRight), top.y) / zt, 9.0 * unit / zt, b.hash, uMotionTime, wind) * (0.4 + 0.6 * dark));
        }
      }
      // Its bounds on screen: its length as it runs across the view and a gable either side, its
      // roof, tower or keep above (the church's length is the nave's).
      float run = castle ? 9.5 : 0.5 * (b.kind > 0.5 && b.kind < 1.5 ? 2.5 : b.length) * max(abs(dot(l, valleyRight.xz)), 0.35) + 1.2;
      float tall = castle ? 9.6 : (b.kind > 0.5 && b.kind < 1.5 ? 4.5 : 2.0) + 0.5 * b.length;
      float low = castle ? 1.5 : 0.3 + 0.25 * b.length;
      if (zm - run * unit > zLimit || abs(q.x - at.x) > run * unit / zm || q.y < at.y - low * unit / zm || q.y > at.y + tall * unit / zm) continue;
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
  ValleyFind f = valleyNoBuilding(zLimit);
  if (first >= 0) f = valleyBuilding(terrainBuilding(uSim3, first), eye, rd, q, pxl, zLimit);
  if (second >= 0) {
    ValleyFind behind = valleyBuilding(terrainBuilding(uSim3, second), eye, rd, q, pxl, f.z);
    if (behind.face > 0.5) f = behind;
  }
  return f;
}

// How a building's face looks: albedo, and through outs its lamp (a lit window), how much snow it
// holds (-1: none of its own), how porous and how glossy it is wet.
vec3 valleyBuildingLook(ValleyFind found, float tod, float dark, out float lamp, out float snowy, out float porous, out float glossy) {
  lamp = 0.0;
  snowy = 0.0;
  porous = 0.6;
  glossy = 0.05;
  float hw = fract(found.hash * 11.3);
  float hr = fract(found.hash * 23.7);
  bool church = found.kind > 0.5 && found.kind < 1.5;
  bool barn = found.kind > 1.5 && found.kind < 2.5;
  bool castle = found.kind > 2.5;
  vec3 wall = church || castle ? vec3(0.7, 0.68, 0.62) : (hw < 0.35 ? vec3(0.84, 0.77, 0.62) : (hw < 0.6 ? vec3(0.88, 0.87, 0.82) : (hw < 0.85 ? vec3(0.62, 0.36, 0.26) : vec3(0.6, 0.6, 0.57))));
  vec3 roof = church ? vec3(0.27, 0.29, 0.33) : (hr < 0.5 ? vec3(0.56, 0.26, 0.17) : (hr < 0.8 ? vec3(0.26, 0.28, 0.32) : vec3(0.58, 0.48, 0.3)));
  if (barn) {
    wall = hw < 0.4 ? vec3(0.34, 0.26, 0.2) : (hw < 0.7 ? vec3(0.55, 0.24, 0.17) : vec3(0.66, 0.62, 0.54));
    roof = hr < 0.5 ? vec3(0.27, 0.28, 0.31) : vec3(0.46, 0.3, 0.22);
  }
  float f = found.face;
  vec3 albedo;
  if (castle) {
    albedo = f > 6.5 ? vec3(0.3, 0.3, 0.34) : (f > 3.5 && f < 4.5 ? vec3(0.12, 0.1, 0.09) : wall * (f > 5.5 ? 0.88 : 1.0));
    if (found.pane > 0.5) {
      float lit = buildingWindow(fract(found.pane * 0.37 + found.hash), tod, dark, 0.5);
      if (lit > 0.5 || found.px < 0.3) albedo = vec3(0.08, 0.08, 0.1);
      lamp = lit;
    }
    snowy = f > 2.5 && f < 3.5 ? 1.0 : (f > 6.5 ? 0.6 : 0.0);
    return albedo;
  }
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
    float lit = buildingWindow(fract(found.hash * 91.0 + (found.pane < 1.5 ? 0.13 : (found.pane < 2.5 ? 0.57 : 0.89))), tod, dark, church ? 0.35 : 0.7);
    if (found.px < 0.25 || lit > 0.5) {
      albedo = vec3(0.1, 0.12, 0.16);
      lamp = lit;
    }
  }
  return albedo;
}
`;
