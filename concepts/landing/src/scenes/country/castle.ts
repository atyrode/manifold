// The castle on its hilltop (sims/terrain.ts sites it and levels its terrace, 42 m round): a model
// the eye ray meets in the castle's own frame, so it stands in three dimensions from the vantage at
// any distance. A curtain wall round a bailey with a round tower at each corner, a gatehouse (a
// block between two round towers, the gate's arch in its face), a square keep with a turret under a
// conical roof at one corner, and a hall under a pitched roof along one side. The curtain, towers,
// gatehouse and keep carry crenellated parapets round their walks, merlons at least three cells
// apart and a cell high so they hold under the dither however far off: a ray into a crenel goes on
// down to the walk, or through. Windows on the towers, the gatehouse, the keep's three storeys and
// the hall light at dusk at half the village lights' share (buildingWindow); near enough, the unlit
// ones are dark. The castle turns its gate half a radian to the right of the vantage, so its left
// side shows too, the side the afternoon sun ahead of the vantage lights.
//
// Its frame: x toward the gate, z across, y up, metres from the terrace's centre. Faces
// (CountryFind.face): 1 stone (curtain, gatehouse, the hall's walls), 2 a round tower, 3 the top of
// a wall or merlon (where snow lies), 4 the gate, 5 the keep, 7 the turret's cone, 8 the hall's roof.
// buildings.ts includes this after CountryFind and countryBlock, and calls countryCastle for the
// castle's record where its bounds hold the pixel (in a loop no pixel elsewhere enters, so a
// software rasteriser runs it only there; no compile-time gate, so switching the castle, which
// rebuilds the land, keeps the program).
import { glslFloat } from "../../shaders/glsl.ts";

/** The castle's reach from its terrace's centre, metres: across, above and below (its bounds). */
export const COUNTRY_CASTLE_REACH = { radius: 48, top: 55, sink: 20 } as const;

export const countryCastleGlsl = /* glsl */ `
// Its plan and heights, metres: half again life size, as the houses are drawn (TERRAIN_HOUSE).
const float CASTLE_RADIUS = ${glslFloat(COUNTRY_CASTLE_REACH.radius)};
const float CASTLE_TOP = ${glslFloat(COUNTRY_CASTLE_REACH.top)};
const float CASTLE_SINK = ${glslFloat(COUNTRY_CASTLE_REACH.sink)};
const vec2 CASTLE_BAILEY = vec2(26.0, 31.0);   // the curtain's centreline: half depth (x), half breadth (z)
const float CASTLE_WALL = 1.6;                 // the curtain's half thickness
const float CASTLE_WALK = 15.0;                // the curtain's walk over the terrace
const float CASTLE_PARAPET = 1.3;              // a parapet's thickness round a tower's or the keep's top
const vec2 CASTLE_TOWER = vec2(6.0, 21.0);     // corner towers: radius, walk
const vec4 CASTLE_GATE = vec4(4.0, 21.0, 18.0, 6.0); // gate towers' radius and walk, the block's walk, the towers' z
const vec4 CASTLE_KEEP = vec4(-8.0, -10.0, 9.0, 36.0); // centre (x, z), half side, walk
const vec4 CASTLE_TURRET = vec4(3.0, 44.0, 3.8, 54.0); // radius, eaves, the cone's eaves radius and tip
const vec4 CASTLE_HALL = vec4(-4.0, 20.0, 14.0, 7.0);  // centre (x, z), half length (x), half width (z)
const vec2 CASTLE_ROOF = vec2(10.0, 17.0);     // the hall's eaves and ridge

// The ray (o, d; inv = 1 / d) against the box lo..hi whose top above walk is a parapet rim thick
// round its sides, crenellated along each side (merlons period apart): the entering t (-1 none) and
// the outward normal. A ray into a crenel or over the parapet's inside goes on down to the walk, or
// through.
float countryCastleBox(vec3 o, vec3 d, vec3 inv, vec3 lo, vec3 hi, float walk, float rim, float period, out vec3 n) {
  vec3 t0 = (lo - o) * inv;
  vec3 t1 = (hi - o) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  float enter = max(max(tn.x, tn.y), tn.z);
  float leave = min(min(tf.x, tf.y), tf.z);
  n = vec3(0.0, 1.0, 0.0);
  if (enter <= 0.0 || leave < enter) return -1.0;
  n = enter == tn.x ? vec3(-sign(d.x), 0.0, 0.0) : (enter == tn.y ? vec3(0.0, -sign(d.y), 0.0) : vec3(0.0, 0.0, -sign(d.z)));
  vec3 p = o + d * enter;
  if (p.y <= walk) return enter;
  vec2 edge = min(p.xz - lo.xz, hi.xz - p.xz);
  if (min(edge.x, edge.y) < rim && fract((edge.x < edge.y ? p.z : p.x) / period + 0.25) < 0.55) return enter;
  if (d.y >= 0.0) return -1.0;
  float down = (walk - o.y) / d.y;
  if (down > leave) return -1.0;
  n = vec3(0.0, 1.0, 0.0);
  return down;
}

// The ray against the round tower on c (xz), radius r, up to its walk with a crenellated parapet
// band over it (as countryCastleBox; its merlons stand period apart across the view, along across,
// the unit level direction across the ray), reaching down the hill.
float countryCastleTower(vec3 o, vec3 d, vec2 across, vec2 c, float r, float walk, float band, float period, out vec3 n) {
  n = vec3(0.0, 1.0, 0.0);
  vec2 oc = o.xz - c;
  float a = dot(d.xz, d.xz);
  float b = dot(oc, d.xz);
  float disc = b * b - a * (dot(oc, oc) - r * r);
  if (disc < 0.0) return -1.0;
  float root = sqrt(disc);
  float enter = (-b - root) / a;
  float leave = (-b + root) / a;
  float y = o.y + d.y * enter;
  if (y > walk + band) {
    // Over the top: down through its cap, if the ray meets it inside.
    if (d.y >= 0.0) return -1.0;
    enter = (walk + band - o.y) / d.y;
    if (enter > leave) return -1.0;
  } else {
    if (y < -CASTLE_SINK) return -1.0;
    n = vec3(oc.x + d.x * enter, 0.0, oc.y + d.z * enter) / r;
  }
  if (enter <= 0.0) return -1.0;
  vec3 p = o + d * enter;
  if (p.y <= walk) return enter;
  vec2 rel = p.xz - c;
  if (length(rel) > r - CASTLE_PARAPET && fract(dot(rel, across) / period + 0.25) < 0.55) return enter;
  if (d.y >= 0.0) return -1.0;
  float down = (walk - o.y) / d.y;
  if (down > leave) return -1.0;
  n = vec3(0.0, 1.0, 0.0);
  return down;
}

// The ray against the cone over c (xz), r round at its eaves, up to its tip.
float countryCastleCone(vec3 o, vec3 d, vec2 c, float r, float eave, float tip, out vec3 n) {
  n = vec3(0.0, 1.0, 0.0);
  float kk = r * r / ((tip - eave) * (tip - eave));
  // From the tip, y down: |q.xz + t d.xz|^2 = kk (q.y - t d.y)^2.
  vec3 q = vec3(o.x - c.x, tip - o.y, o.z - c.y);
  float a = dot(d.xz, d.xz) - kk * d.y * d.y;
  float b = dot(q.xz, d.xz) + kk * q.y * d.y;
  float k = dot(q.xz, q.xz) - kk * q.y * q.y;
  float disc = b * b - a * k;
  if (abs(a) < 1e-6 || disc < 0.0) return -1.0;
  float root = sqrt(disc);
  float t0 = (-b - root) / a;
  float t1 = (-b + root) / a;
  float near = min(t0, t1);
  float far = max(t0, t1);
  for (int i = 0; i < 2; i++) {
    float t = i == 0 ? near : far;
    float y = o.y + d.y * t;
    if (t > 0.0 && y >= eave && y <= tip) {
      vec3 p = o + d * t;
      n = normalize(vec3(p.x - c.x, kk * (tip - y), p.z - c.y));
      return t;
    }
  }
  return -1.0;
}

// Whether at (along a face, up it) lies within the window centred on centre, size its half extents.
bool countryCastlePane(vec2 at, vec2 centre, vec2 size) {
  return all(lessThan(abs(at - centre), size));
}

// The castle b as the ray (eye, rd) meets it nearer than zLimit (camera depth); pxl: radians a cell.
CountryFind countryCastle(TerrainBuilding b, vec3 eye, vec3 rd, float pxl, float zLimit) {
  CountryFind f = countryNoBuilding(zLimit);
  vec3 db = b.at - eye;
  float zc = dot(db, countryFwd);
  if (zc < 30.0) return f;
  // Its frame: the gate turned half a radian off the vantage (counterclockwise on the map: to the
  // right as the vantage sees it).
  vec2 toEye = normalize(-db.xz);
  vec2 front = mat2(0.87758256, 0.47942554, -0.47942554, 0.87758256) * toEye;
  vec2 side = vec2(-front.y, front.x);
  vec3 o = vec3(dot(-db.xz, front), -db.y, dot(-db.xz, side));
  vec3 d = vec3(dot(rd.xz, front), rd.y, dot(rd.xz, side));
  // The upright cylinder holding it all first.
  float a = dot(d.xz, d.xz);
  float bq = dot(o.xz, d.xz);
  float disc = bq * bq - a * (dot(o.xz, o.xz) - CASTLE_RADIUS * CASTLE_RADIUS);
  if (disc < 0.0) return f;
  vec2 span = (vec2(-bq) + vec2(-1.0, 1.0) * sqrt(disc)) / a;
  vec2 ys = o.y + d.y * max(span, 0.0);
  if (min(ys.x, ys.y) > CASTLE_TOP || max(ys.x, ys.y) < -CASTLE_SINK || span.y <= 0.0) return f;
  // Battlements in whole cells: merlons three cells apart at least, a cell high.
  float cell = pxl * zc;
  float period = max(3.0, 3.0 * cell);
  float band = max(1.4, cell);
  vec3 inv = 1.0 / d;
  vec2 across = normalize(vec2(-d.z, d.x));
  vec2 bailey = CASTLE_BAILEY;
  float best = 1e9;
  float id = -1.0;
  vec3 nb = vec3(0.0, 1.0, 0.0);
  vec3 n;
  float t;
  // The curtain: its front and back walls run along z, its sides along x.
  for (int i = 0; i < 4; i++) {
    float s = i == 0 || i == 2 ? 1.0 : -1.0;
    vec3 lo = i < 2 ? vec3(s * bailey.x - CASTLE_WALL, -CASTLE_SINK, -bailey.y) : vec3(-bailey.x, -CASTLE_SINK, s * bailey.y - CASTLE_WALL);
    vec3 hi = i < 2 ? vec3(s * bailey.x + CASTLE_WALL, CASTLE_WALK + band, bailey.y) : vec3(bailey.x, CASTLE_WALK + band, s * bailey.y + CASTLE_WALL);
    t = countryCastleBox(o, d, inv, lo, hi, CASTLE_WALK, 9.0, period, n);
    if (t > 0.0 && t < best) { best = t; nb = n; id = float(i); }
  }
  // The corner towers.
  for (int i = 0; i < 4; i++) {
    vec2 c = bailey * vec2(i < 2 ? 1.0 : -1.0, i == 0 || i == 2 ? 1.0 : -1.0);
    t = countryCastleTower(o, d, across, c, CASTLE_TOWER.x, CASTLE_TOWER.y, band, period, n);
    if (t > 0.0 && t < best) { best = t; nb = n; id = 4.0 + float(i); }
  }
  // The gatehouse: its block across the front wall and its two towers.
  t = countryCastleBox(o, d, inv, vec3(bailey.x - 3.0, -CASTLE_SINK, -CASTLE_GATE.w), vec3(bailey.x + 3.5, CASTLE_GATE.z + band, CASTLE_GATE.w), CASTLE_GATE.z, CASTLE_PARAPET, period, n);
  if (t > 0.0 && t < best) { best = t; nb = n; id = 8.0; }
  for (int i = 0; i < 2; i++) {
    t = countryCastleTower(o, d, across, vec2(bailey.x + 2.5, (i == 0 ? 1.0 : -1.0) * CASTLE_GATE.w), CASTLE_GATE.x, CASTLE_GATE.y, band, period, n);
    if (t > 0.0 && t < best) { best = t; nb = n; id = 9.0 + float(i); }
  }
  // The keep, its turret and the turret's cone.
  vec3 keepLo = vec3(CASTLE_KEEP.x - CASTLE_KEEP.z, -CASTLE_SINK, CASTLE_KEEP.y - CASTLE_KEEP.z);
  vec3 keepHi = vec3(CASTLE_KEEP.x + CASTLE_KEEP.z, CASTLE_KEEP.w + band, CASTLE_KEEP.y + CASTLE_KEEP.z);
  t = countryCastleBox(o, d, inv, keepLo, keepHi, CASTLE_KEEP.w, CASTLE_PARAPET, period, n);
  if (t > 0.0 && t < best) { best = t; nb = n; id = 11.0; }
  vec2 turret = keepHi.xz;
  t = countryCastleTower(o, d, across, turret, CASTLE_TURRET.x, CASTLE_TURRET.y, 0.0, period, n);
  if (t > 0.0 && t < best) { best = t; nb = n; id = 12.0; }
  t = countryCastleCone(o, d, turret, CASTLE_TURRET.z, CASTLE_TURRET.y, CASTLE_TURRET.w, n);
  if (t > 0.0 && t < best) { best = t; nb = n; id = 13.0; }
  // The hall along the side wall, its ridge along x.
  vec3 hall = vec3(CASTLE_HALL.x, 0.0, CASTLE_HALL.y);
  t = countryBlock(o - hall, d, CASTLE_HALL.zw, CASTLE_SINK, CASTLE_ROOF.y, vec2(0.0, (CASTLE_ROOF.y - CASTLE_ROOF.x) / CASTLE_HALL.w), n);
  if (t > 0.0 && t < best) { best = t; nb = n; id = 14.0; }
  float zb = best * dot(rd, countryFwd);
  if (id < 0.0 || zb >= zLimit) return f;
  vec3 p = o + d * best;
  // The face, and the windows on it: (along the face, up it), at least a cell.
  vec2 at = vec2(abs(nb.x) > 0.5 ? p.z : p.x, p.y);
  vec2 pane = vec2(max(0.8, 0.5 * cell), max(1.4, 0.5 * cell));
  bool rounded = (id > 3.5 && id < 7.5) || (id > 8.5 && id < 10.5) || (id > 11.5 && id < 12.5);
  float face = id > 12.5 && id < 13.5 ? 7.0 : (id > 10.5 && id < 11.5 ? 5.0 : (rounded ? 2.0 : 1.0));
  float which = 0.0;
  if (nb.y > 0.5 && id < 12.5) {
    face = 3.0;
  } else if (id > 3.5 && id < 7.5) {
    // A corner tower's window looking out from the bailey's corner.
    float k = id - 4.0;
    vec2 c = bailey * vec2(k < 1.5 ? 1.0 : -1.0, k < 0.5 || (k > 1.5 && k < 2.5) ? 1.0 : -1.0);
    vec2 outward = normalize(c);
    vec2 rel = p.xz - c;
    if (dot(rel, outward) > 0.0 && countryCastlePane(vec2(rel.x * outward.y - rel.y * outward.x, p.y), vec2(0.0, CASTLE_TOWER.y - 4.0), pane)) which = 1.0 + k;
  } else if (id > 7.5 && id < 8.5 && nb.x > 0.5) {
    // The gate's arch, and a window over it.
    if (abs(p.z) < 2.0 && p.y < 6.0 + 2.0 * sqrt(max(1.0 - p.z * p.z / 4.0, 0.0))) face = 4.0;
    else if (countryCastlePane(vec2(p.z, p.y), vec2(0.0, 12.5), pane)) which = 5.0;
  } else if (id > 8.5 && id < 10.5) {
    // A gate tower's slit, looking out.
    vec2 rel = p.xz - vec2(bailey.x + 2.5, (id < 9.5 ? 1.0 : -1.0) * CASTLE_GATE.w);
    if (rel.x > 0.0 && countryCastlePane(vec2(rel.y, p.y), vec2(0.0, 11.0), pane)) which = id - 3.0;
  } else if (id > 10.5 && id < 11.5) {
    // The keep: two windows a face on each of three storeys.
    vec2 rel = vec2(abs(nb.x) > 0.5 ? p.z - CASTLE_KEEP.y : p.x - CASTLE_KEEP.x, p.y);
    float side = nb.x > 0.5 ? 0.0 : (nb.x < -0.5 ? 1.0 : (nb.z > 0.5 ? 2.0 : 3.0));
    for (int s = 0; s < 3; s++) {
      for (int w = 0; w < 2; w++) {
        if (countryCastlePane(rel, vec2(w == 0 ? -4.0 : 4.0, 15.0 + 7.5 * float(s)), pane)) which = 8.0 + side * 6.0 + float(s * 2 + w);
      }
    }
  } else if (id > 11.5 && id < 12.5) {
    // The turret's window, looking toward the gate.
    vec2 rel = p.xz - turret;
    if (rel.x > 0.0 && countryCastlePane(vec2(rel.y, p.y), vec2(0.0, CASTLE_TURRET.y - 4.0), pane)) which = 32.0;
  } else if (id > 13.5) {
    if (nb.y > 0.3) {
      face = 8.0;
    } else if (abs(nb.z) > 0.5) {
      // The hall's long walls: three tall windows.
      for (int w = 0; w < 3; w++) {
        if (countryCastlePane(vec2(p.x - CASTLE_HALL.x, p.y), vec2(8.0 * float(w - 1), 5.5), vec2(pane.x, max(2.2, pane.y)))) which = 33.0 + float(w);
      }
    }
  }
  vec3 nw = vec3(nb.x * front.x + nb.z * side.x, nb.y, nb.x * front.y + nb.z * side.y);
  return CountryFind(face, which, b.hash, b.kind, zb, cell, normalize(nw), at);
}

// How the castle's face looks: stone (the keep a shade darker), tops where snow lies, the gate's
// dark arch, slate on the turret's cone and tiles on the hall; a window lit (lamp) at dusk at half
// the share \`lights\` of the village's, or dark near enough to see.
vec3 countryCastleLook(CountryFind found, float tod, float dark, float lights, out float lamp, out float snowy, out float porous, out float glossy) {
  lamp = 0.0;
  snowy = 0.0;
  porous = 0.5;
  glossy = 0.05;
  float f = found.face;
  vec3 stone = vec3(0.7, 0.68, 0.62) * (0.93 + 0.07 * vnoise(found.wall / vec2(5.0, 2.5) + found.hash * 17.0));
  vec3 albedo = stone * (f > 4.5 && f < 5.5 ? 0.9 : 1.0);
  if (f > 2.5 && f < 3.5) {
    albedo = stone * 1.04;
    snowy = 1.0;
  } else if (f > 3.5 && f < 4.5) {
    albedo = vec3(0.12, 0.1, 0.09);
  } else if (f > 6.5 && f < 7.5) {
    albedo = vec3(0.3, 0.3, 0.34);
    snowy = 0.6;
    porous = 0.1;
    glossy = 0.2;
  } else if (f > 7.5) {
    albedo = vec3(0.5, 0.3, 0.22);
    snowy = 1.0;
    porous = 0.1;
    glossy = 0.15;
  }
  if (found.pane > 0.5) {
    float lit = buildingWindow(fract(found.pane * 0.37 + found.hash), tod, dark, 0.5 * lights);
    if (lit > 0.5 || found.px < 1.6) albedo = vec3(0.08, 0.08, 0.1);
    lamp = lit;
  }
  return albedo;
}
`;
