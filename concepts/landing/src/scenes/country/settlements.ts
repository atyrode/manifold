// The countryside's settlements (see shader.ts): the village on the knoll of the third ridge, up to
// three hamlets on the far ridges, a castle on a far hilltop and farmsteads among the fields.
//
// Every building is one of the shared shapes in src/shaders/buildings.ts, standing upright on the
// screen on its own ridge: its base is a point of that ridge's face (a drop below the bare crest,
// countryGroundCrest, never the treetops), one house unit (COUNTRY_HOUSE world units) at the depth
// of that ground across, and its walls reach down to the crest wherever the land falls away under
// them, so none ever floats. sceneCountry asks each ridge it passes, front to back, for what covers
// the pixel (countrySettlements); on a ridge the nearest building wins (the lowest base on screen),
// a hedgerow tree rooted nearer still stands in front of it (countryHidesCrown), and smoke and the
// glow of lit windows gather from every ridge passed. Far off, details drop out and a lit window
// grows to a cell, so a hamlet on the last ridge is a few cells of wall and roof and, at dusk, light.
//
// Placement is a pure function of the landscape seed, the aspect and the one knob that adds that kind
// of settlement, so no knob moves what another placed: the village grows along its lanes in a fixed
// order; a hamlet or the castle takes the best of a few seeded candidate sites; farms take seeded
// slots along each ridge. A pixel only looks at the few candidates within reach of its column. Sites
// keep to open ground: clear of woodland stands, the river, the village and the chalk down, and in
// sight over the nearer ridges. countrySettlementDistance gives the same footprints to the ground.
import { buildingsGlsl } from "../../shaders/buildings.ts";

export const countrySettlementsGlsl = /* glsl */ `
${buildingsGlsl}
const float COUNTRY_HOUSE = 0.045;      // one house unit (a cottage's gable end), world units
const float COUNTRY_CASTLE = 0.036;     // one castle unit (buildingCastle), world units
const float COUNTRY_FARM_SLOT = 0.6;    // world units across a slope between possible farmsteads
const float COUNTRY_CLEAR = 0.48;       // woodland stand below which no tree stands (they need 0.5 and more)

// The village's growth past its first eleven cottages, in the order it fills: up the knoll beside
// the church, down a lane toward the river, out along the street's ends. x: offset from the
// village's middle (screen); y: drop below the bare crest (screen); z: which way it faces.
const vec3 COUNTRY_VILLAGE_MORE[15] = vec3[15](
  vec3(-0.03, 0.021, 1.0), vec3(0.012, 0.085, -1.0), vec3(0.1, 0.025, -1.0), vec3(-0.145, 0.017, -1.0),
  vec3(-0.02, 0.097, 1.0), vec3(0.145, 0.03, 1.0), vec3(-0.072, 0.014, 1.0), vec3(0.032, 0.108, -1.0),
  vec3(0.128, 0.017, 1.0), vec3(-0.042, 0.115, 1.0), vec3(-0.17, 0.014, 1.0), vec3(0.05, 0.128, -1.0),
  vec3(0.172, 0.026, -1.0), vec3(-0.062, 0.135, -1.0), vec3(-0.105, 0.012, -1.0)
);

struct CountryVillage {
  float hit;     // 1 on a building
  vec3 albedo;
  vec3 normal;
  float roof;    // 1 roofs and battlements, 0.5 the spire, 0 walls: where snow can lie and how much a wet face shines
  float porous;  // how much rain soaks in and darkens it: 0 slate, lead, glass .. 1 thatch
  float lamp;    // 1 on a lit window
  float smoke;   // chimney smoke in front of whatever is behind, 0..1
  float glow;    // warm spill from lit windows nearby
  float front;   // its base on screen: of two buildings on one ridge, the lower stands nearer
};

CountryVillage countryNoVillage() {
  CountryVillage v;
  v.hit = 0.0;
  v.albedo = vec3(0.0);
  v.normal = vec3(0.0, 1.0, 0.0);
  v.roof = 0.0;
  v.porous = 0.6;
  v.lamp = 0.0;
  v.smoke = 0.0;
  v.glow = 0.0;
  v.front = 2.0;
  return v;
}

// The nearer of two buildings found on one ridge, or what the pixel met on a nearer ridge and the
// ridge it now passes: the building hit, with smoke and window glow from both.
CountryVillage countryNearer(CountryVillage a, CountryVillage b) {
  CountryVillage o = a;
  if (b.hit > 0.5 && (a.hit < 0.5 || b.front < a.front)) o = b;
  o.smoke = max(a.smoke, b.smoke);
  o.glow = a.glow + b.glow;
  return o;
}

// Whether building b stands in front of the hedgerow tree whose crown (countryTrees, radius r on
// screen) covers the pixel at height y: its base lies lower on the face than the tree's root.
bool countryHidesCrown(CountryVillage b, vec4 crown, float y, float r) {
  float rad = r * (0.7 + 0.3 * fract(crown.w * 17.3));
  return b.hit > 0.5 && b.front < y - crown.y * rad - 1.2 * r;
}

// One cottage of a settlement: its front corner on screen, screen units per house unit, which way
// it faces (1: gable to the left), the length of its long wall, its hash.
struct CountryHouse { vec2 base; float size; float side; float len; float which; };

// The building found under a pixel so far: buildingCottage's face and window, how near it stands
// (its base on screen), which way it faces, its hash, kind (0 cottage, 1 church, 2 barn) and one
// dither cell in its units.
struct CountryFind { float face; float pane; float front; float flip; float which; float kind; float px; };

CountryFind countryNoFind() {
  CountryFind f;
  f.face = 0.0;
  f.pane = 0.0;
  f.front = 2.0;
  f.flip = 1.0;
  f.which = 0.37;
  f.kind = 0.0;
  f.px = 0.0;
  return f;
}

// A cottage or barn (house units h, mirrored to face its way) takes the pixel if it covers it in
// front of what was found so far. base: its base on screen; ground: the bare crest at the pixel's
// column, in house units above the base.
void countryTryCottage(vec2 h, float base, float len, float wall, float rise, bool stack, float ground, float px, float which, float flip, float kind, inout CountryFind f) {
  if (base < f.front && h.x > -1.15 && h.x < len + 0.15 && h.y > min(-0.05, ground) && h.y < wall + rise + 0.45 + len * COUNTRY_RECEDE) {
    float pane = 0.0;
    float face = buildingCottage(h, len, wall, rise, COUNTRY_RECEDE, stack, ground, px, pane);
    if (face > 0.0) {
      f.face = face;
      f.pane = pane;
      f.front = base;
      f.flip = flip;
      f.which = which;
      f.kind = kind;
      f.px = px;
    }
  }
}

// A church likewise, in church units c (its tower 2.3 high), mirrored by flip.
void countryTryChurch(vec2 c, float base, float ground, float px, float flip, inout CountryFind f) {
  if (base < f.front && c.x > -1.2 && c.x < 2.8 && c.y > min(-0.05, ground) && c.y < 4.6) {
    float pane = 0.0;
    float face = buildingChurch(c, COUNTRY_RECEDE, ground, px, pane);
    if (face > 0.0) {
      f.face = face;
      f.pane = pane;
      f.front = base;
      f.flip = flip;
      f.kind = 1.0;
      f.px = px;
    }
  }
}

// How much light a cottage's lit windows spill on its walls and the ground around (h: house units).
float countryHouseGlow(vec2 h, float which, float tod, float dark, float lights) {
  float lit = buildingWindow(fract(which * 91.0 + 0.13), tod, dark, lights) + buildingWindow(fract(which * 91.0 + 0.57), tod, dark, lights) + buildingWindow(fract(which * 91.0 + 0.89), tod, dark, lights);
  vec2 g = h - vec2(0.3, 0.4);
  return lit * exp(-dot(g, g) * 0.3);
}

// Cottage c on the pixel: its walls, roof and windows into f, the glow of its lit windows and, with
// its fire lit, smoke rising \`tall\` (screen) from its chimney. ground: the bare crest at the
// pixel's column (screen); px: a dither cell in house units.
void countryCottageAt(vec2 q, CountryHouse c, float ground, float px, bool fire, float tall, float tod, float dark, float t, float wind, inout CountryFind f, inout float glow, inout float smoke) {
  vec2 h = (q - c.base) / c.size;
  h.x *= c.side;
  countryTryCottage(h, c.base.y, c.len, 0.75, 0.55, true, (ground - c.base.y) / c.size, px, c.which, c.side, 0.0, f);
  // Lit windows warm the walls and ground around them.
  glow += countryHouseGlow(h, c.which, tod, dark, K_lights);
  if (fire) {
    vec2 top = buildingStack(c.len, 0.75, 0.55, COUNTRY_RECEDE);
    smoke = max(smoke, buildingSmoke(q, c.base + c.size * vec2(c.side * top.x, top.y), tall, c.which, t, wind));
  }
}

// The colours and light of the building found: walls, roofs, windows, the church's stone and spire,
// a barn's boards and its door. Far off (more than a quarter house unit to a cell) unlit windows
// merge into the wall.
CountryVillage countryBuilding(CountryFind f, float tod, float dark, float lights) {
  CountryVillage v = countryNoVillage();
  v.hit = 1.0;
  v.front = f.front;
  float face = f.face;
  float which = f.which;
  bool church = f.kind > 0.5 && f.kind < 1.5;
  bool barn = f.kind > 1.5;
  float hw = fract(which * 11.3);
  float hr = fract(which * 23.7);
  vec3 wall = church ? vec3(0.7, 0.68, 0.62) : (hw < 0.35 ? vec3(0.84, 0.77, 0.62) : (hw < 0.6 ? vec3(0.88, 0.87, 0.82) : (hw < 0.85 ? vec3(0.62, 0.36, 0.26) : vec3(0.6, 0.6, 0.57))));
  vec3 roof = church ? vec3(0.27, 0.29, 0.33) : (hr < 0.5 ? vec3(0.56, 0.26, 0.17) : (hr < 0.8 ? vec3(0.26, 0.28, 0.32) : vec3(0.58, 0.48, 0.3)));
  if (barn) {
    // Tarred boards, a red barn or a stone one; slate, rusted iron or thatch over it.
    wall = hw < 0.4 ? vec3(0.34, 0.26, 0.2) : (hw < 0.7 ? vec3(0.55, 0.24, 0.17) : vec3(0.66, 0.62, 0.54));
    roof = hr < 0.5 ? vec3(0.27, 0.28, 0.31) : (hr < 0.8 ? vec3(0.46, 0.3, 0.22) : vec3(0.58, 0.48, 0.3));
  }
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
    // Clay tiles drink a little rain, slate and iron none, thatch a lot.
    v.porous = church || (hr >= 0.5 && hr < 0.8) ? 0.05 : (hr < 0.5 ? (barn ? 0.05 : 0.35) : 0.85);
  } else if (face < 4.5) {
    v.albedo = vec3(0.5, 0.3, 0.22);
    v.normal = gableNormal;
  } else if (face < 8.5) {
    v.albedo = vec3(0.45, 0.47, 0.5);
    v.normal = face < 7.5 ? normalize(vec3(-0.55, 0.45, -0.7)) : normalize(vec3(0.6, 0.45, -0.66));
    v.roof = 0.5;
    v.porous = 0.05;
  } else {
    v.albedo = vec3(0.08, 0.07, 0.07);
    v.normal = gableNormal;
  }
  v.normal.x *= f.flip;
  if (f.pane > 0.5) {
    if (barn) {
      // The barn's doors on its gable end; its long wall is blind.
      if (f.pane < 1.5) v.albedo = vec3(0.13, 0.1, 0.08);
    } else {
      float lit = buildingWindow(fract(which * 91.0 + (f.pane < 1.5 ? 0.13 : (f.pane < 2.5 ? 0.57 : 0.89))), tod, dark, church ? 0.5 * lights : lights);
      if (f.px < 0.25 || lit > 0.5) {
        v.albedo = vec3(0.1, 0.12, 0.16);
        v.porous = 0.0;
        v.lamp = lit;
      }
    }
  }
  return v;
}

// Whether building c on ridge i would stand in a wood: any of its feet (the gable's far corner, the
// front corner, the long wall's far corner, which lies farther up the slope, taken a house unit
// higher still, as its wall reaches down to the crest where the brow falls away). crest: the bare
// crest at its front corner, taken for all three.
bool countryInWood(CountryHouse c, float i, float crest, vec2 spots) {
  float d = countryLayer(i).x;
  bool wooded = false;
  for (int k = 0; k < 3; k++) {
    float along = k == 0 ? -1.0 : (k == 1 ? 0.0 : c.len);
    vec2 foot = c.base + c.size * vec2(c.side * along, max(along, 0.0) * COUNTRY_RECEDE + (k == 2 ? 1.0 : 0.0));
    wooded = wooded || countryWoodStand(i, foot.x * d, countryDown(max(crest - foot.y, 0.0), d), countrySpots(foot.x, spots)) > COUNTRY_CLEAR;
  }
  return wooded;
}

// Cottage k of the village: 0..10 the original street across the knoll, either side of it; 11..25
// its growth (COUNTRY_VILLAGE_MORE). knoll: the knoll's top on screen; vx: the village's middle.
// The woodland keeps off the street (countryWoodKeep); the growth's places reaching a wood stay
// empty (size 0).
CountryHouse countryVillageHouse(float k, float vx, float knoll, vec2 spots) {
  CountryHouse c;
  float drop = 0.0;
  if (k < 10.5) {
    float hj = hash12(vec2(k, 4.3) + countrySeed);
    float u = (k - 5.0) / 5.0;
    c.side = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
    float down = max(0.04 + 0.02 * sin(u * 2.3 + 0.9) + 0.01 * c.side + 0.008 * (hj - 0.5), 0.014);
    c.base = vec2(vx + u * 0.12 + 0.014 * (hj - 0.5), knoll - down);
    c.size = 0.014 + 0.1 * (down - 0.014);
    c.len = 1.2 + 0.8 * fract(hj * 7.1);
    c.which = hj;
  } else {
    vec3 slot = COUNTRY_VILLAGE_MORE[int(k) - 11];
    float hj = hash12(vec2(k, 8.9) + countrySeed);
    c.side = slot.z;
    c.base = vec2(vx + slot.x + 0.01 * (hj - 0.5), 2.0);
    drop = slot.y + 0.004 * (fract(hj * 3.7) - 0.5);
    c.len = 1.1 + 0.8 * fract(hj * 7.1);
    c.which = hj;
  }
  // On the knoll's face: the street never above the bare crest under its corner, whatever the
  // landscape; the growth its drop below it.
  float crest = countryGroundCrest(2.0, c.base.x, spots);
  c.base.y = min(c.base.y, crest - drop);
  if (k > 10.5) c.size = 0.014 + 0.1 * max(knoll - c.base.y - 0.014, 0.0);
  if (k > 10.5 && countryInWood(c, 2.0, crest, spots)) c.size = 0.0;
  return c;
}

// The village on the knoll of the third ridge (q in that ridge's frame; ground: its bare crest at
// q.x): K_village cottages and the church up the knoll; nearer (lower) buildings stand in front.
// The first eleven line a street across the knoll, either side of it; a smaller village keeps those
// nearest its middle, a larger one fills a lane beside the church, a lane down toward the river and
// the street's ends. Every third cottage has its fire lit.
CountryVillage countryVillage(vec2 q, float vx, float knoll, float ground, vec2 spots, float tod, float dark, float t, float wind) {
  CountryVillage v = countryNoVillage();
  float n = K_village;
  bool street = !(abs(q.x - vx) > 0.26 || q.y < knoll - 0.1 || q.y > knoll + 0.18);
  bool grown = n > 11.5 && abs(q.x - vx) < 0.36 && q.y > knoll - 0.17 && q.y < knoll + 0.2;
  if (!street && !grown) return v;
  CountryFind f = countryNoFind();
  float smoke = 0.0;
  float glow = 0.0;
  if (street) {
    vec2 church = vec2(vx + 0.018, min(knoll - 0.02, countryGroundCrest(2.0, vx + 0.018, spots)));
    countryTryChurch((q - church) / 0.019, church.y, (ground - church.y) / 0.019, 0.0, 1.0, f);
  }
  for (int k = 0; k < 26; k++) {
    float fk = float(k);
    if (k < 11) {
      // A smaller village keeps the cottages nearest the middle of the street.
      if (!street || 2.0 * abs(fk - 5.0) - step(fk, 4.5) >= n) continue;
    } else {
      if (!grown || fk >= n) break;
      // Beyond the reach of its glow and smoke.
      if (abs(q.x - vx - COUNTRY_VILLAGE_MORE[k - 11].x) > 0.23) continue;
    }
    CountryHouse c = countryVillageHouse(fk, vx, knoll, spots);
    if (c.size <= 0.0) continue;
    countryCottageAt(q, c, ground, 0.0, abs(mod(k < 11 ? fk : fk - 11.0, 3.0) - 1.0) < 0.5, 0.1, tod, dark, t, wind, f, glow, smoke);
  }
  v.smoke = smoke * (K_smoke > 0.0 ? 0.35 + 0.85 * K_smoke : 0.0);
  v.glow = min(glow, 1.5);
  if (f.face < 0.5) return v;
  CountryVillage b = countryBuilding(f, tod, dark, K_lights);
  b.smoke = v.smoke;
  b.glow = v.glow;
  return b;
}

// Hamlet j's site within the screen x range win: the first of nine seeded places, taking the far
// ridges (3, 4, 5) in turn from a seeded one, that is clear of the village's quarter and the
// castle's down, gently sloping, in sight over the nearer ridges and mostly open where its houses
// stand (houses that would stand in a wood are left out; a wood on the crest above may shelter
// it). x: screen; y: the drop of its lane below the crest (screen); z: one house unit on screen;
// w: its ridge, 0 where none was found.
vec4 countryHamletSite(float j, vec2 win, vec2 spots) {
  float first = floor(3.0 * hash12(vec2(j, 5.1) + countrySeed));
  for (int c = 0; c < 9; c++) {
    float ridge = 3.0 + mod(first + float(c), 3.0);
    float d = countryLayer(ridge).x;
    float unit = COUNTRY_HOUSE / d;
    float h = hash12(vec2(j * 9.0 + float(c), 13.7) + countrySeed);
    float x = mix(win.x, win.y, 0.1 + 0.8 * h);
    vec2 near = countrySpots(x, spots);
    if (abs(x - spots.x) < 0.2 || near.y > 0.2) continue;
    // The crest here and four house units either side, then the highest nearer ridge in front.
    float g = 0.0;
    float lean = 0.0;
    float hidden = -1.0;
    for (int e = 0; e < 7; e++) {
      float k = float(e) - 2.0;
      if (e > 2 && k >= ridge) break;
      float y = countryGroundCrest(e < 3 ? ridge : k, x + (e < 3 ? 4.0 * (float(e) - 1.0) * unit : 0.0), spots);
      if (e == 1) g = y;
      else if (e < 3) lean += (float(e) - 1.0) * y;
      else hidden = max(hidden, y);
    }
    if (g - hidden < 4.0 * unit || abs(lean) > 2.4 * unit) continue;
    float s = min(mix(1.5 * unit, g - hidden - 2.5 * unit, fract(h * 7.3)), 8.0 * unit);
    // Open ground at its middle and along most of its lane.
    float v = countryDown(s + 0.25 * unit, d);
    float open = 0.0;
    bool middle = false;
    for (int k = 0; k < 5; k++) {
      float wx = (x + 2.2 * (float(k) - 2.0) * unit) * d;
      bool clear = countryWoodStand(ridge, wx, v, countrySpots(wx / d, spots)) <= COUNTRY_CLEAR;
      open += clear ? 1.0 : 0.0;
      middle = middle || (k == 2 && clear);
    }
    if (middle && open > 2.5) return vec4(x, s, unit, ridge);
  }
  return vec4(0.0);
}

// How many cottages hamlet j has: three to six.
float countryHamletHouses(float j) {
  return 3.0 + floor(3.99 * fract(hash12(vec2(j, 21.1) + countrySeed) * 5.3));
}

// House n of hamlet j (m houses) at site: either side of its lane, the odd ones a row nearer,
// facing each other across it (size 0 where it would stand in a wood).
CountryHouse countryHamletHouse(float j, float n, float m, vec4 site, vec2 spots) {
  CountryHouse c;
  float h = hash12(vec2(j * 8.0 + n, 31.3) + countrySeed);
  c.side = mod(n, 2.0) < 0.5 ? 1.0 : -1.0;
  c.base.x = site.x + ((n - 0.5 * (m - 1.0)) * 2.2 + 0.6 * (h - 0.5)) * site.z;
  float drop = site.y + ((c.side < 0.0 ? 1.3 : 0.0) + 0.4 * (fract(h * 3.1) - 0.5)) * site.z;
  float crest = countryGroundCrest(site.w, c.base.x, spots);
  c.base.y = crest - drop;
  c.size = site.z;
  c.len = 1.0 + 0.7 * fract(h * 7.1);
  c.which = h;
  if (countryInWood(c, site.w, crest, spots)) c.size = 0.0;
  return c;
}

// Hamlet j's chapel, in some of them: at the back of the lane, behind the cottages, in church units
// (size 0 where there is none).
CountryHouse countryHamletChapel(float j, float m, vec4 site, vec2 spots) {
  CountryHouse c;
  float h = hash12(vec2(j, 21.1) + countrySeed);
  c.side = fract(h * 2.3) < 0.5 ? 1.0 : -1.0;
  c.base.x = site.x + (fract(h * 2.7) - 0.5) * m * site.z;
  float crest = countryGroundCrest(site.w, c.base.x, spots);
  c.base.y = crest - max(site.y - 0.8 * site.z, 0.3 * site.z);
  c.size = 0.9 * site.z;
  c.len = 2.5;
  c.which = h;
  if (fract(h * 9.1) >= 0.45 || countryInWood(c, site.w, crest, spots)) c.size = 0.0;
  return c;
}

// Hamlets: K_hamlets small clusters of cottages, each in its own third of the view on one of the far
// ridges: three to six cottages and, in some, a chapel. Draws the ones on ridge i within reach
// of q into f (with their glow and smoke) and returns in near0/near1 those close enough to q for
// the farms there to keep clear of.
void countryHamlets(vec2 q, float ground, float i, vec2 spots, float tod, float dark, float t, float wind, inout CountryFind f, inout float glow, inout float smoke, out vec4 near0, out vec4 near1) {
  near0 = vec4(0.0);
  near1 = vec4(0.0);
  float aspect = uRes.x / uRes.y;
  float turn = floor(3.0 * hash12(vec2(3.3, 7.9) + countrySeed));
  for (int k = 0; k < 3; k++) {
    float j = float(k);
    if (j >= K_hamlets) break;
    vec2 win = aspect * (vec2(-0.48, -0.16) + 0.32 * mod(j + turn, 3.0));
    // A hamlet, its smoke and the farms that keep clear of it all lie within 0.3 of its third.
    if (q.x < win.x - 0.3 || q.x > win.y + 0.3) continue;
    vec4 site = countryHamletSite(j, win, spots);
    if (site.w != i) continue;
    if (near0.w < 0.5) near0 = site;
    else near1 = site;
    float unit = site.z;
    float m = countryHamletHouses(j);
    float tall = 5.0 * unit;
    if (abs(q.x - site.x) > (1.1 * m + 3.0) * unit + 1.7 * tall) continue;
    float px = 1.0 / (uRes.y * unit);
    CountryHouse chapel = countryHamletChapel(j, m, site, spots);
    if (chapel.size > 0.0) {
      vec2 c = (q - chapel.base) / chapel.size;
      c.x *= chapel.side;
      countryTryChurch(c, chapel.base.y, (ground - chapel.base.y) / chapel.size, px / 0.9, chapel.side, f);
    }
    for (int k2 = 0; k2 < 6; k2++) {
      float n = float(k2);
      if (n >= m) break;
      if (abs(q.x - site.x - (n - 0.5 * (m - 1.0)) * 2.2 * unit) > 3.5 * unit + 1.7 * tall) continue;
      CountryHouse c = countryHamletHouse(j, n, m, site, spots);
      if (c.size > 0.0) countryCottageAt(q, c, ground, px, fract(c.which * 13.7) < 0.4, tall, tod, dark, t, wind, f, glow, smoke);
    }
  }
}

// The castle, if K_castle, on ridge 3 (q in its frame; L: its layer; ground: its bare crest at q.x):
// on top of the chalk down, the third ridge's raised hill right of the middle (countryGroundCrest),
// in sight over the nearer ridges with the sky above its towers. A hill fort above the chalk figure,
// as Uffington Castle stands above the White Horse; the woods clear from around its walls while it
// stands (countryWoodKeep). Stone walls lit by the sun and moon, battlement tops and roofs where
// snow lies, a dark gate and a few windows lit at dusk.
CountryVillage countryCastle(vec2 q, float ground, vec4 L, vec2 spots, float tod, float dark) {
  CountryVillage v = countryNoVillage();
  float unit = COUNTRY_CASTLE / L.x;
  if (abs(q.x - spots.y) > 8.8 * unit || q.y > L.y + L.z + 9.5 * unit) return v;
  vec2 site = vec2(spots.y, countryGroundCrest(3.0, spots.y, spots));
  vec2 c = (q - site) / unit;
  float g = (ground - site.y) / unit;
  if (c.y > 9.5 || c.y < g - 1.0) return v;
  float h = hash12(vec2(7.3, 2.9) + countrySeed);
  float flip = h < 0.5 ? 1.0 : -1.0;
  float px = 1.0 / (uRes.y * unit);
  float across = 0.0;
  float slit = 0.0;
  float face = buildingCastle(c, g, px, flip, step(0.45, fract(h * 13.1)), across, slit);
  if (face < 0.5) return v;
  v.hit = 1.0;
  v.front = site.y - 0.9 * unit;
  vec3 stone = mix(vec3(0.72, 0.68, 0.6), vec3(0.6, 0.58, 0.54), fract(h * 7.7));
  v.albedo = stone;
  v.porous = 0.15;
  if (face < 1.5) {
    v.normal = normalize(vec3(0.15 * flip, 0.0, -1.0));
  } else if (face < 2.5) {
    v.normal = vec3(across, 0.0, -sqrt(max(1.0 - across * across, 0.0)));
  } else if (face < 3.5) {
    v.normal = normalize(vec3(0.0, 1.0, -0.35));
    v.roof = 1.0;
  } else if (face < 4.5) {
    v.albedo = vec3(0.07, 0.06, 0.06);
    v.normal = vec3(0.0, 0.0, -1.0);
  } else if (face < 5.5) {
    v.normal = normalize(vec3(-0.3 * flip, 0.0, -0.95));
  } else if (face < 6.5) {
    v.albedo = stone * 0.94;
    v.normal = normalize(vec3(0.8 * flip, 0.0, -0.6));
  } else {
    v.albedo = vec3(0.27, 0.29, 0.33);
    v.normal = normalize(vec3(0.8 * across, 0.55, -0.6));
    v.roof = 1.0;
    v.porous = 0.05;
  }
  if (slit > 0.5) {
    float lit = buildingWindow(hash12(vec2(slit, 3.7) + countrySeed), tod, dark, 0.5 * K_lights);
    // Near enough to see, an unlit window is a dark slit; farther off only a lit one shows.
    if (lit > 0.5 || px < 0.3) {
      v.albedo = vec3(0.08, 0.08, 0.1);
      v.porous = 0.0;
      v.lamp = lit;
    }
  }
  return v;
}

// Farm slot k on ridge i (COUNTRY_FARM_SLOT world units apart across the slope): where its
// farmhouse stands (x across, y down the slope: world), its hash, and 1 where there is one: the slot
// is taken (more as K_farms rises; none move), and the place is out of the village's quarter and off
// the chalk down, clear of the hamlets near0/near1, in sight over the nearer ridges, at the margin of
// a field (never on its hedge or in its middle) and clear of the river (countryFarmPlan keeps it out
// of the woods). ceiling: the pixel's height on screen, above which the farm and its smoke cannot
// reach it (skips the rest).
vec4 countryFarmSite(float i, float k, vec2 spots, vec4 near0, vec4 near1, float ceiling) {
  float h = hash12(vec2(k, 7.7 * i + 1.3) + countrySeed);
  if (h >= 0.7 * K_farms) return vec4(0.0);
  float d = countryLayer(i).x;
  float unit = COUNTRY_HOUSE / d;
  float wx = (k + 0.25 + 0.5 * fract(h * 37.1)) * COUNTRY_FARM_SLOT;
  float x = wx / d;
  vec2 near = countrySpots(x, spots);
  if (near.x > (i > 1.5 && i < 2.5 ? 0.03 : 0.25) || (i > 2.5 && near.y > 0.2)) return vec4(0.0);
  if ((near0.w > 0.5 && abs(x - near0.x) < 12.0 * near0.z) || (near1.w > 0.5 && abs(x - near1.x) < 12.0 * near1.z)) return vec4(0.0);
  // Its ridge's crest here, then the highest of the nearer ridges in front of it.
  float g = 0.0;
  float hidden = -1.0;
  for (int j = 0; j < 4; j++) {
    float ridge = i - float(j);
    if (ridge < 0.0) break;
    float y = countryGroundCrest(ridge, x, spots);
    if (j > 0) hidden = max(hidden, y);
    else if (ceiling > y + (fract(h * 41.3) < 0.6 ? 0.45 : 0.17) / d) return vec4(0.0);
    else g = y;
  }
  if (g - hidden < 3.5 * unit) return vec4(0.0);
  float v = countryDown(mix(1.2 * unit, g - hidden - 1.5 * unit, 0.1 + 0.6 * fract(h * 53.3)), d);
  // To the margin of its field, a fifth to three tenths of a field in from the hedge it is nearest,
  // then checked there: a farmstead stands at the edge of its land, never on the hedge.
  vec2 site = vec2(0.0);
  vec2 other = vec2(0.0);
  vec2 axis = vec2(0.0);
  vec2 cell = vec2(0.0);
  for (int pass = 0; pass < 2; pass++) {
    cell = countryCells(countryFieldSpace(i, vec2(wx, v)), site, other, axis);
    if (pass > 0) break;
    vec2 shift = axis * (cell.x - 0.2 - 0.1 * fract(h * 7.9)) / COUNTRY_FIELDS;
    wx += shift.x;
    v = max(v + shift.y, countryDown(unit, d));
  }
  float s = pow(v / (d * COUNTRY_SLOPE) + sqrt(COUNTRY_ROUND), 2.0) - COUNTRY_ROUND;
  // Pasture enclosures (crop 9, when the animals' fields are in) keep their herds to themselves.
  if (s > g - hidden - 1.0 * unit || cell.x < 0.12 || countryFieldCrop(cell.y, K_season) > 8.5) return vec4(0.0);
  // The farmstead keeps a fifth of a world unit from the river, past its barn's side.
  if (i < 1.5) {
    vec2 river = countryRiver(v, (spots.x + 0.07) * d);
    float side = fract(h * 17.9) < 0.5 ? 1.0 : -1.0;
    if (abs(wx + side * 1.8 * COUNTRY_HOUSE - river.x) / sqrt(1.0 + river.y * river.y) < 0.24) return vec4(0.0);
  }
  return vec4(wx, v, h, 1.0);
}

// The farmstead at site (countryFarmSite) on ridge i: its farmhouse, and on most a barn behind it to
// one side (barn.size 0 for a lone house). A farmhouse whose feet would stand in a wood is not
// built at all (house.size 0), nor a barn whose would.
void countryFarmPlan(vec4 site, float i, vec2 spots, out CountryHouse house, out CountryHouse barn) {
  float d = countryLayer(i).x;
  float s = pow(site.y / (d * COUNTRY_SLOPE) + sqrt(COUNTRY_ROUND), 2.0) - COUNTRY_ROUND;
  float unit = COUNTRY_HOUSE / (d * (1.0 - 0.35 * smoothstep(0.0, 0.2, s)));
  float h = site.z;
  house.side = fract(h * 17.9) < 0.5 ? 1.0 : -1.0;
  house.size = unit;
  house.len = 1.2 + 0.6 * fract(h * 7.1);
  house.which = fract(h * 3.3);
  barn.size = fract(h * 23.3) < 0.65 ? 1.15 * unit : 0.0;
  barn.side = house.side;
  barn.len = 2.1;
  barn.which = fract(h * 5.9);
  // Each on the face below the bare crest at its own corner, the barn a little farther up.
  for (int b = 0; b < 2; b++) {
    float x = site.x / d + float(b) * house.side * 2.3 * unit;
    float y = countryGroundCrest(i, x, spots);
    if (b == 0) {
      house.base = vec2(x, y - s);
      if (countryInWood(house, i, y, spots)) house.size = 0.0;
    } else {
      barn.base = vec2(x, y - max(s - 0.8 * unit, 0.4 * unit));
      if (barn.size > 0.0 && countryInWood(barn, i, y, spots)) barn.size = 0.0;
    }
  }
}

// Farms on ridge i within reach of q (their smoke included): into f, glow and smoke.
void countryFarms(vec2 q, float ground, float i, vec4 L, vec2 spots, vec4 near0, vec4 near1, float tod, float dark, float t, float wind, inout CountryFind f, inout float glow, inout float smoke) {
  float d = L.x;
  // Nothing of a farm, its smoke included, rises this far above the ridge's highest crest.
  if (q.y > L.y + L.z + 0.45 / d) return;
  float wx = q.x * d;
  float first = floor((wx - 0.55) / COUNTRY_FARM_SLOT);
  for (int j = 0; j < 3; j++) {
    float k = first + float(j);
    if (k * COUNTRY_FARM_SLOT > wx + 0.55) break;
    vec4 site = countryFarmSite(i, k, spots, near0, near1, q.y);
    if (site.w < 0.5) continue;
    CountryHouse house;
    CountryHouse barn;
    countryFarmPlan(site, i, spots, house, barn);
    if (house.size <= 0.0) continue;
    float px = 1.0 / (uRes.y * house.size);
    if (barn.size > 0.0) {
      vec2 hb = (q - barn.base) / barn.size;
      hb.x *= barn.side;
      countryTryCottage(hb, barn.base.y, barn.len, 0.95, 0.7, false, (ground - barn.base.y) / barn.size, px / 1.15, barn.which, barn.side, 2.0, f);
    }
    countryCottageAt(q, house, ground, px, fract(site.z * 41.3) < 0.6, 4.0 * house.size, tod, dark, t, wind, f, glow, smoke);
  }
}

// The buildings standing on ridge i that cover the pixel q (in the ridge's frame; ground: its bare
// crest at q.x; L: countryLayer(i)), and their smoke and window glow there.
CountryVillage countrySettlements(float i, vec2 q, float ground, vec4 L, vec2 spots, float tod, float dark, float t, float wind) {
  CountryVillage v = countryNoVillage();
  if (i > 1.5 && i < 2.5) v = countryVillage(q, spots.x, L.y + 0.012, ground, spots, tod, dark, t, wind);
  bool hamlets = K_hamlets > 0.5 && i > 2.5;
  bool farms = K_farms > 0.0 && i > 0.5 && i < 3.5;
  if (hamlets || farms) {
    CountryFind f = countryNoFind();
    float glow = 0.0;
    float smoke = 0.0;
    vec4 near0 = vec4(0.0);
    vec4 near1 = vec4(0.0);
    if (hamlets) countryHamlets(q, ground, i, spots, tod, dark, t, wind, f, glow, smoke, near0, near1);
    if (farms) countryFarms(q, ground, i, L, spots, near0, near1, tod, dark, t, wind, f, glow, smoke);
    CountryVillage o = countryNoVillage();
    if (f.face > 0.5) o = countryBuilding(f, tod, dark, K_lights);
    o.smoke = smoke * (K_smoke > 0.0 ? 0.35 + 0.85 * K_smoke : 0.0);
    o.glow = min(glow, 1.5);
    v = countryNearer(v, o);
  }
  if (K_castle > 0.5 && i > 2.5 && i < 3.5) v = countryNearer(v, countryCastle(q, ground, L, spots, tod, dark));
  return v;
}

// How far a house stands from slope point w on a ridge at depth d (world units, 0 inside its
// footprint): a disc around the ground it covers behind its front corner.
float countryHouseDistance(CountryHouse c, float ground, float d, vec2 w) {
  float s = max(ground - c.base.y, 0.0);
  float unit = c.size * d * (1.0 - 0.35 * smoothstep(0.0, 0.2, s));
  vec2 centre = vec2(c.base.x * d + c.side * 0.5 * (c.len - 1.0) * unit, countryDown(s, d) - 0.5 * unit);
  return max(length(w - centre) - 0.55 * (c.len + 1.0) * unit, 0.0);
}

// How far slope point w (world: across, x * depth, and down the slope, as in countryFieldSpace) on
// ridge \`ridge\` lies from the nearest building's footprint (world units; 1e3 with none within
// reach): for keeping tracks, animals or anything else on the ground clear of the settlements.
float countrySettlementDistance(float ridge, vec2 w, vec2 spots) {
  float best = 1e3;
  vec4 L = countryLayer(ridge);
  float d = L.x;
  float x = w.x / d;
  if (ridge > 1.5 && ridge < 2.5 && abs(x - spots.x) < 0.3) {
    float knoll = L.y + 0.012;
    CountryHouse church;
    church.base = vec2(spots.x + 0.018, min(knoll - 0.02, countryGroundCrest(2.0, spots.x + 0.018, spots)));
    church.size = 0.019;
    church.side = 1.0;
    church.len = 2.5;
    church.which = 0.37;
    best = countryHouseDistance(church, countryGroundCrest(2.0, church.base.x, spots), d, w);
    for (int k = 0; k < 26; k++) {
      float fk = float(k);
      if (fk < 10.5 ? 2.0 * abs(fk - 5.0) - step(fk, 4.5) >= K_village : fk >= K_village) continue;
      CountryHouse c = countryVillageHouse(fk, spots.x, knoll, spots);
      if (c.size <= 0.0 || abs(c.base.x - x) > 0.08) continue;
      best = min(best, countryHouseDistance(c, countryGroundCrest(2.0, c.base.x, spots), d, w));
    }
  }
  vec4 near0 = vec4(0.0);
  vec4 near1 = vec4(0.0);
  if (K_hamlets > 0.5 && ridge > 2.5) {
    float aspect = uRes.x / uRes.y;
    float turn = floor(3.0 * hash12(vec2(3.3, 7.9) + countrySeed));
    for (int k = 0; k < 3; k++) {
      float j = float(k);
      if (j >= K_hamlets) break;
      vec2 win = aspect * (vec2(-0.48, -0.16) + 0.32 * mod(j + turn, 3.0));
      if (x < win.x - 0.3 || x > win.y + 0.3) continue;
      vec4 site = countryHamletSite(j, win, spots);
      if (site.w != ridge) continue;
      if (near0.w < 0.5) near0 = site;
      else near1 = site;
      float m = countryHamletHouses(j);
      CountryHouse chapel = countryHamletChapel(j, m, site, spots);
      if (chapel.size > 0.0) best = min(best, countryHouseDistance(chapel, countryGroundCrest(ridge, chapel.base.x, spots), d, w));
      for (int n = 0; n < 6; n++) {
        if (float(n) >= m) break;
        CountryHouse c = countryHamletHouse(j, float(n), m, site, spots);
        if (c.size > 0.0) best = min(best, countryHouseDistance(c, countryGroundCrest(ridge, c.base.x, spots), d, w));
      }
    }
  }
  if (K_farms > 0.0 && ridge > 0.5 && ridge < 3.5) {
    float first = floor((w.x - 0.4) / COUNTRY_FARM_SLOT);
    for (int j = 0; j < 3; j++) {
      float k = first + float(j);
      if (k * COUNTRY_FARM_SLOT > w.x + 0.4) break;
      vec4 site = countryFarmSite(ridge, k, spots, near0, near1, -1e3);
      if (site.w < 0.5) continue;
      CountryHouse house;
      CountryHouse barn;
      countryFarmPlan(site, ridge, spots, house, barn);
      if (house.size <= 0.0) continue;
      best = min(best, countryHouseDistance(house, countryGroundCrest(ridge, house.base.x, spots), d, w));
      if (barn.size > 0.0) best = min(best, countryHouseDistance(barn, countryGroundCrest(ridge, barn.base.x, spots), d, w));
    }
  }
  if (K_castle > 0.5 && ridge > 2.5 && ridge < 3.5) {
    // Its walls run 8.6 castle units either side of the down's top, from the crest to just below.
    float foot = 0.5 * countryDown(COUNTRY_CASTLE / d, d);
    vec2 e = abs(w - vec2(spots.y * d, foot)) - vec2(8.6 * COUNTRY_CASTLE, foot);
    best = min(best, length(max(e, 0.0)));
  }
  return best;
}
`;
