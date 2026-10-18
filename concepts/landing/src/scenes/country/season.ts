// The farming year over the land model's parcels (sims/landuse.ts): every crop parcel keeps the kind
// its record gives it and shows that kind as the time of year has it, and the rest of the land
// follows. The year is continuous: SKY_YEAR (src/climate.ts), the `date` knob carried round while
// `year` (the year passes) is on. Three dates are keys the land stands exactly at, the three seasons
// the old `season` choice offered (COUNTRY_SEASONS: summer 0.375, harvest 0.47, autumn 0.6); winter
// and spring lie round the rest of the year:
//
//   kind       winter              spring                   summer (0.375)       harvest (0.47)        autumn (0.6)
//   wheat      green rows          rows fill, standing      green, standing      gold, standing        cut, ploughed, drilled: green rows
//   barley     ploughed (a few     drilled: shoots in rows, green-gold          stubble, baled        ploughed, a few old stubbles
//              old stubbles)       standing green
//   grazing    dull, pale          fresh                    lush                 green                 duller
//   hay        dull, pale          fresh, grows tall        standing, in flower  the mown aftermath    the aftermath, duller
//   ploughed   dark wet furrows    drying                   dry fallow           earth                 fresh furrows, darker
//   rapeseed   ploughed            drilled: shoots, leafy,  yellow, in flower    stubble               ploughed
//                                  yellow in flower
//
// Between the keys each field changes on dates of its own (its hash), so the land never turns at
// once: a machine's work (the combine, the plough, the drill, the mower) crosses the field in lands
// along its rows, its front a hard edge per cell; growth comes on in patches. A pasture's grass is
// grazing's. The flower fields follow the shared fields' year (shaders/lib/fields.ts). Open grass is
// fresh in spring, lush in summer, tawnier in autumn and dull and pale in winter; the hedges russet
// in autumn, bare through winter and white with the hawthorn's may in late spring. The broadleaf
// trees turn in autumn, each its own colour and on its own date, drop their leaves to bare twigs
// through the gaps of which the land behind shows (trees.ts), and leaf out fresh in spring (the near
// crowns, trees.ts's countryLeaves, and the far canopy crown by crown, settling to the woods' mean
// where crowns grow too small), while the pines stay evergreen. Lying snow is the climate's
// (uWeather.y), never the date's. This GLSL goes ahead of trees.ts's trees in the scene's program,
// after its woods (countryWoodsGlsl); sceneCountry sets the year (countryYearSet) before anything
// reads it.
//
// Round bales (COUNTRY_HAS_BALES: while the date lies in COUNTRY_BALES or the year passes, with crops
// on) lie on the barley's stubble from a little after its field is cut until they are carted away,
// each on its own dates; at most one to a cell of a grid along the field's rows, inside the field's
// clear core (terrainCore, while the woods reach no part of it) or, looked up there, on its own
// ground well inside its border and clear of roads, streams, yards, trees and the woods' crowns;
// each a cylinder on its side met exactly by the ray in front of
// the ground it reached. A software renderer runs every line of a program, so the bales' cells are
// walked first and only the one bale a pixel finds is looked up.
import { glslFloat } from "../../shaders/glsl.ts";
import { COUNTRY_SEASONS, COUNTRY_BALES } from "./constants.ts";

const S = glslFloat(COUNTRY_SEASONS.summer);
const H = glslFloat(COUNTRY_SEASONS.harvest);
const A = glslFloat(COUNTRY_SEASONS.autumn);

export const countrySeasonGlsl = /* glsl */ `
// ---- the farming year (season.ts) ----
const float COUNTRY_STANDING = 0.0;   // a standing crop: drill rows and tramlines
const float COUNTRY_SWARD = 1.0;      // grass: the mower's stripes
const float COUNTRY_EARTH = 2.0;      // bare earth in furrows
const float COUNTRY_STUBBLE = 3.0;    // the combine's passes, the cut rows in them
const float COUNTRY_DRILLED = 4.0;    // shoots in rows on bare earth
const float COUNTRY_MEADOW = 5.0;     // hay standing uncut, flecked with flowers
const float COUNTRY_SUMMER = ${S};
const float COUNTRY_HARVEST = ${H};
const float COUNTRY_AUTUMN = ${A};
const vec3 COUNTRY_TWIGS = vec3(0.35, 0.3, 0.28);   // a bare broadleaf's crown
const vec3 COUNTRY_BUDS = vec3(0.4, 0.55, 0.18);    // its new leaves' yellow-green

// The year the land shows (0 the start of spring .. 1), and the stretch between two keys it stands in
// (0 summer to harvest, 1 harvest to autumn, 2 autumn into winter, 3 winter into spring, 4 spring into
// summer) with how far through it: set once a pixel by countryYearSet, the harvest's until then.
float countryYear = COUNTRY_HARVEST;
int countryStretch = 1;
float countryStretchAt = 0.0;

// Sets the year from SKY_YEAR (the harvest's in a program without a season).
void countryYearSet(float year) {
  float y = year < 0.0 ? COUNTRY_HARVEST : year;
  countryYear = y;
  if (y >= COUNTRY_SUMMER && y < COUNTRY_HARVEST) {
    countryStretch = 0;
    countryStretchAt = smoothstep(0.385, 0.46, y);
  } else if (y >= COUNTRY_HARVEST && y < COUNTRY_AUTUMN) {
    countryStretch = 1;
    countryStretchAt = smoothstep(0.48, 0.59, y);
  } else if (y >= COUNTRY_AUTUMN) {
    countryStretch = 2;
    countryStretchAt = smoothstep(0.61, 0.72, y);
  } else if (y < 0.2) {
    countryStretch = 3;
    countryStretchAt = smoothstep(0.02, 0.18, y);
  } else {
    countryStretch = 4;
    countryStretchAt = smoothstep(0.21, 0.36, y);
  }
}

// a while t is 0, b once it reaches 1 (each exactly, so a key's own value is the key), mixed between.
vec3 countryBlend(vec3 a, vec3 b, float t) {
  return t <= 0.0 ? a : (t >= 1.0 ? b : mix(a, b, t));
}
float countryBlend(float a, float b, float t) {
  return t <= 0.0 ? a : (t >= 1.0 ? b : mix(a, b, t));
}

// A value keyed to the farming year: s in summer, h at the harvest, a in autumn, w through winter
// (from 0.72 to the year's turn), p in spring (0.18..0.21), eased from each key to the next and
// exactly the key's own at its date.
vec3 countryKeys(vec3 s, vec3 h, vec3 a, vec3 w, vec3 p) {
  float t = countryStretchAt;
  return countryStretch == 0 ? countryBlend(s, h, t)
    : (countryStretch == 1 ? countryBlend(h, a, t)
    : (countryStretch == 2 ? countryBlend(a, w, t)
    : (countryStretch == 3 ? countryBlend(w, p, t) : countryBlend(p, s, t))));
}
float countryKeys(float s, float h, float a, float w, float p) {
  float t = countryStretchAt;
  return countryStretch == 0 ? countryBlend(s, h, t)
    : (countryStretch == 1 ? countryBlend(h, a, t)
    : (countryStretch == 2 ? countryBlend(a, w, t)
    : (countryStretch == 3 ? countryBlend(w, p, t) : countryBlend(p, s, t))));
}

// How far a machine's work begun at 'from' has come over its 'span' of the year: 0 before, 1 done.
float countryWork(float from, float span) {
  return clamp((countryYear - from) / span, 0.0, 1.0);
}

// What a crop parcel of this kind (LAND_CROP_*) shows now; h: the parcel's hash. x the look it is
// leaving, y the look it comes to, z how much of the field has come to it (0..1), w 1 for a
// machine's work across the field (the combine, the mower, the plough, the drill), 0 for growth.
// Barley and rapeseed are cut before the wheat, and by autumn the plough has had the wheat's and most
// of their stubbles; the wheat is drilled again at once, the barley and rapeseed in spring.
vec4 countryFieldStage(float kind, float h) {
  float k = floor(kind + 0.5);
  float y = countryYear;
  float j = fract(h * 7.31);
  bool summer = y >= COUNTRY_SUMMER && y < COUNTRY_HARVEST;
  bool harvest = y >= COUNTRY_HARVEST && y < COUNTRY_AUTUMN;
  bool spring = y < COUNTRY_SUMMER;
  if (k == LAND_CROP_GRAZING) return vec4(COUNTRY_SWARD, COUNTRY_SWARD, 0.0, 0.0);
  if (k == LAND_CROP_PLOUGHED) return vec4(COUNTRY_EARTH, COUNTRY_EARTH, 0.0, 0.0);
  if (k == LAND_CROP_HAY) {
    if (summer) return vec4(COUNTRY_MEADOW, COUNTRY_SWARD, countryWork(0.39 + 0.03 * j, 0.02), 1.0);
    if (spring) return vec4(COUNTRY_SWARD, COUNTRY_MEADOW, smoothstep(0.17 + 0.04 * j, 0.22 + 0.04 * j, y), 0.0);
    return vec4(COUNTRY_SWARD, COUNTRY_SWARD, 0.0, 0.0);
  }
  if (k == LAND_CROP_WHEAT) {
    if (summer) return vec4(COUNTRY_STANDING, COUNTRY_STANDING, 0.0, 0.0);
    if (harvest) {
      float plough = 0.53 + 0.015 * j;
      float drill = 0.56 + 0.015 * j;
      if (y < plough) return vec4(COUNTRY_STANDING, COUNTRY_STUBBLE, countryWork(0.485 + 0.02 * j, 0.02), 1.0);
      if (y < drill) return vec4(COUNTRY_STUBBLE, COUNTRY_EARTH, countryWork(plough, 0.015), 1.0);
      return vec4(COUNTRY_EARTH, COUNTRY_DRILLED, countryWork(drill, 0.015), 1.0);
    }
    if (spring) return vec4(COUNTRY_DRILLED, COUNTRY_STANDING, smoothstep(0.08 + 0.04 * j, 0.12 + 0.04 * j, y), 0.0);
    return vec4(COUNTRY_DRILLED, COUNTRY_DRILLED, 0.0, 0.0);
  }
  if (k == LAND_CROP_BARLEY) {
    // Some stubbles are left over winter, ploughed only in spring.
    bool kept = fract(h * 29.3) > 0.6;
    if (summer) return vec4(COUNTRY_STANDING, COUNTRY_STUBBLE, countryWork(0.4 + 0.025 * j, 0.018), 1.0);
    if (spring) {
      float drill = 0.05 + 0.03 * j;
      if (y < drill) return kept ? vec4(COUNTRY_STUBBLE, COUNTRY_EARTH, countryWork(0.005 + 0.025 * j, 0.015), 1.0) : vec4(COUNTRY_EARTH, COUNTRY_EARTH, 0.0, 0.0);
      if (y < 0.2) return vec4(COUNTRY_EARTH, COUNTRY_DRILLED, countryWork(drill, 0.015), 1.0);
      return vec4(COUNTRY_DRILLED, COUNTRY_STANDING, smoothstep(0.2 + 0.03 * j, 0.24 + 0.03 * j, y), 0.0);
    }
    if (kept) return vec4(COUNTRY_STUBBLE, COUNTRY_STUBBLE, 0.0, 0.0);
    return harvest ? vec4(COUNTRY_STUBBLE, COUNTRY_EARTH, countryWork(0.5 + 0.04 * j, 0.02), 1.0) : vec4(COUNTRY_EARTH, COUNTRY_EARTH, 0.0, 0.0);
  }
  // Rapeseed.
  if (summer) return vec4(COUNTRY_STANDING, COUNTRY_STUBBLE, countryWork(0.39 + 0.02 * j, 0.018), 1.0);
  if (harvest) return vec4(COUNTRY_STUBBLE, COUNTRY_EARTH, countryWork(0.49 + 0.03 * j, 0.02), 1.0);
  if (spring) {
    if (y < 0.1) return vec4(COUNTRY_EARTH, COUNTRY_DRILLED, countryWork(0.02 + 0.02 * j, 0.015), 1.0);
    return vec4(COUNTRY_DRILLED, COUNTRY_STANDING, smoothstep(0.11 + 0.02 * j, 0.14 + 0.02 * j, y), 0.0);
  }
  return vec4(COUNTRY_EARTH, COUNTRY_EARTH, 0.0, 0.0);
}

// The look the field shows at row point r (along and across its heading, metres) as its stage has
// come: a machine works it in lands 48 m wide across the rows, each from one side, its front a hard
// edge per cell; growth comes on in 5 m patches.
float countryFieldPick(vec4 stage, float h, vec2 r) {
  if (stage.z <= 0.0) return stage.x;
  if (stage.z >= 1.0) return stage.y;
  float band = stage.w > 0.5 ? fract(r.y / 48.0 + h * 7.0) : hash12(floor(r / 5.0) + h * 61.0);
  return band < stage.z ? stage.y : stage.x;
}

// How thick the shoots stand in a drilled field of this kind (1 as the wheat's in autumn, toward 1.6
// as they fill the rows in spring); j: the field's date jitter.
float countryShoots(float k, float j) {
  float y = countryYear;
  if (k == LAND_CROP_WHEAT) {
    if (y >= COUNTRY_AUTUMN) return 1.0 + 0.25 * smoothstep(0.62, 0.75, y);
    if (y >= COUNTRY_HARVEST) return smoothstep(0.56 + 0.015 * j, 0.595, y);
    return 1.25 + 0.35 * smoothstep(0.0, 0.1, y);
  }
  float drill = k == LAND_CROP_BARLEY ? 0.05 + 0.03 * j : 0.02 + 0.02 * j;
  return 1.6 * smoothstep(drill, drill + 0.1, y);
}

// A crop field's colour and the relief of its rows, as the time of year has its kind. kind:
// LAND_CROP_* (a pasture's grass is LAND_CROP_GRAZING); h: the parcel's hash; r: row space along and
// across its heading (metres); foot: metres a cell covers there. rows gets the row profile, porous
// how much rain the ground soaks up (wetten's porous): bare earth most, stubble less, the crops' and
// grass's leaves shed it.
vec3 countryField(float kind, float h, vec2 r, float foot, out float rows, out float porous) {
  float k = floor(kind + 0.5);
  float y = countryYear;
  float j = fract(h * 7.31);
  float look = countryFieldPick(countryFieldStage(kind, h), h, r);
  float h2 = fract(h * 13.7);
  float hold = smoothstep(2.5, 6.0, 3.2 / foot);
  rows = 0.5 + 0.5 * hold * sin(r.y * TAU / 3.2);
  float tram = smoothstep(4.0, 9.0, 24.0 / foot) * (1.0 - smoothstep(0.0, 0.7, abs(fract(r.y / 24.0) - 0.5) * 24.0 - 0.3));
  // Dry fallow in summer, darker through autumn, dark and wet in winter, drying through spring.
  vec3 earth = mix(
    countryKeys(vec3(0.48, 0.37, 0.25), vec3(0.4, 0.29, 0.19), vec3(0.36, 0.25, 0.16), vec3(0.33, 0.23, 0.15), vec3(0.42, 0.32, 0.21)),
    countryKeys(vec3(0.55, 0.42, 0.28), vec3(0.48, 0.35, 0.23), vec3(0.44, 0.3, 0.2), vec3(0.41, 0.29, 0.2), vec3(0.5, 0.38, 0.26)),
    h2);
  vec3 c = earth;
  float relief = 1.0;
  porous = look == COUNTRY_EARTH ? 0.85 : (look == COUNTRY_DRILLED ? 0.75 : (look == COUNTRY_STUBBLE ? 0.6 : 0.5));
  if (look == COUNTRY_STANDING) {
    // Wheat green, ripening gold to the harvest; barley green, green-gold by summer; rapeseed leafy
    // green, then yellow in flower from late spring.
    float spring = y < COUNTRY_SUMMER ? 1.0 : 0.0;
    float ripe = spring > 0.5 ? 0.0 : (y < COUNTRY_HARVEST ? smoothstep(0.39 + 0.02 * j, 0.445 + 0.015 * j, y) : 1.0);
    float gold = spring > 0.5 ? smoothstep(0.26, 0.36, y) : 1.0;
    float flower = spring > 0.5 ? smoothstep(0.16 + 0.04 * j, 0.21 + 0.04 * j, y) : 1.0;
    c = k == LAND_CROP_WHEAT
      ? countryBlend(mix(vec3(0.5, 0.6, 0.26), vec3(0.6, 0.66, 0.3), h2), mix(vec3(0.74, 0.6, 0.28), vec3(0.82, 0.68, 0.33), h2), ripe)
      : (k == LAND_CROP_BARLEY
        ? countryBlend(mix(vec3(0.4, 0.56, 0.22), vec3(0.47, 0.6, 0.25), h2), mix(vec3(0.62, 0.66, 0.4), vec3(0.7, 0.71, 0.45), h2), gold)
        : countryBlend(mix(vec3(0.3, 0.47, 0.17), vec3(0.36, 0.52, 0.2), h2), mix(vec3(0.86, 0.78, 0.16), vec3(0.93, 0.84, 0.22), h2), flower));
    relief = 0.92 + 0.14 * rows - 0.1 * tram;
  } else if (look == COUNTRY_SWARD) {
    // Grazed or mown: the mower's stripes; fresh in spring, lusher in summer, duller in autumn, dull
    // and pale in winter.
    c = k == LAND_CROP_HAY ? mix(vec3(0.44, 0.52, 0.22), vec3(0.52, 0.56, 0.26), h2) : mix(vec3(0.3, 0.46, 0.18), vec3(0.38, 0.52, 0.2), h2);
    c *= countryKeys(vec3(0.97, 1.06, 1.03), vec3(1.0), vec3(1.03, 0.92, 0.94), vec3(1.06, 0.96, 0.9), vec3(0.97, 1.06, 0.97));
    c = countryBlend(c, vec3(dot(c, LUMA)) * vec3(1.14, 1.08, 0.92) + 0.04, countryKeys(0.0, 0.0, 0.0, 0.45, 0.0));
    relief = 0.94 + 0.1 * hold * (0.5 + 0.5 * sin(r.y * TAU / 9.0));
  } else if (look == COUNTRY_STUBBLE) {
    // The combine's passes, there and back, paler and darker by turns; barley's straw pale gold,
    // rapeseed's grey-brown, and weathered grey by autumn.
    c = countryBlend(
      k == LAND_CROP_RAPESEED ? mix(vec3(0.55, 0.5, 0.36), vec3(0.62, 0.56, 0.4), h2) : mix(vec3(0.84, 0.72, 0.44), vec3(0.9, 0.78, 0.5), h2),
      mix(vec3(0.64, 0.58, 0.43), vec3(0.7, 0.63, 0.47), h2),
      countryKeys(0.0, 0.0, 1.0, 1.0, 1.0));
    float passes = 0.5 + 0.5 * smoothstep(2.5, 6.0, 18.0 / foot) * clamp(12.0 * abs(fract(r.y / 18.0) - 0.5) - 3.0, -1.0, 1.0);
    relief = 0.88 + 0.14 * passes + 0.06 * rows - 0.06 * tram;
  } else if (look == COUNTRY_MEADOW) {
    // Tall grass flecked with flowers where a cell is small enough to hold them, the flowers out by
    // early summer.
    float bloom = y < COUNTRY_SUMMER ? smoothstep(0.24, 0.32, y) : 1.0;
    float flowers = step(0.8, hash12(floor(r * 1.4) + h * 50.0)) * smoothstep(0.9, 0.45, foot);
    c = mix(mix(vec3(0.44, 0.55, 0.23), vec3(0.5, 0.58, 0.27), h2), vec3(0.88, 0.84, 0.9), 0.45 * flowers * bloom);
  } else if (look == COUNTRY_DRILLED) {
    c = mix(earth, vec3(0.33, 0.49, 0.2), min((0.15 + 0.6 * rows) * countryShoots(k, j), 1.0));
  } else {
    // Furrows.
    relief = 0.86 + 0.24 * rows;
  }
  return c * relief;
}

// Open grass as the time of year has it: fresh in spring, lusher in summer, tawnier in autumn, dull
// and pale in winter.
vec3 countrySward(vec3 grass) {
  vec3 c = grass * countryKeys(vec3(0.97, 1.04, 1.0), vec3(1.0), vec3(1.08, 0.94, 0.9), vec3(1.08, 0.97, 0.9), vec3(0.97, 1.06, 0.95));
  return countryBlend(c, vec3(dot(c, LUMA)) * vec3(1.14, 1.08, 0.92) + 0.04, countryKeys(0.0, 0.0, 0.0, 0.45, 0.0));
}

// A hedge's leaves at p (metres): dark green, russet once autumn turns them, bare twigs through
// winter, fresh green in spring and white in patches with the hawthorn's may in late spring.
vec3 countryHedge(vec2 p) {
  vec3 c = countryKeys(vec3(0.11, 0.19, 0.08), vec3(0.11, 0.19, 0.08), vec3(0.24, 0.17, 0.07), vec3(0.2, 0.16, 0.13), vec3(0.15, 0.27, 0.09));
  float may = smoothstep(0.17, 0.21, countryYear) * smoothfall(0.3, 0.26, countryYear);
  if (may <= 0.0) return c;
  return countryBlend(c, vec3(0.9, 0.89, 0.84), 0.7 * may * smoothstep(0.5, 0.66, vnoise(p / 3.5)));
}

// A broadleaf's year (h: its hash): x how far its leaves have turned, y how bare it stands (0 in
// leaf .. 1 bare twigs), z how fresh its new leaves still are. Each tree keeps dates of its own: it
// turns, drops its leaves and leafs out a little before or after the next.
vec3 countryLeafYear(float h) {
  float y = countryYear;
  float j = fract(h * 23.17);
  if (y >= COUNTRY_SUMMER && y < COUNTRY_HARVEST) return vec3(0.0);
  if (y >= COUNTRY_HARVEST && y < COUNTRY_AUTUMN) return vec3(smoothstep(0.49 + 0.06 * j, 0.53 + 0.06 * j, y), 0.0, 0.0);
  if (y >= COUNTRY_AUTUMN) return vec3(1.0, smoothstep(0.615 + 0.05 * j, 0.66 + 0.05 * j, y), 0.0);
  return vec3(0.0, 1.0 - smoothstep(0.07 + 0.07 * j, 0.12 + 0.07 * j, y), 1.0 - smoothstep(0.18, 0.34, y));
}

// A broadleaf's crown (leaf: its summer green; h: its hash; year: its countryLeafYear): in autumn
// each tree turns its own way, orange, russet or gold, a quarter still green; its twigs show as the
// leaves fall; its new leaves come out yellow-green.
vec3 countryBroadleaf(vec3 leaf, float h, vec3 year) {
  float th = fract(h * 41.0);
  vec3 turned = th < 0.3 ? vec3(0.6, 0.34, 0.1) : (th < 0.55 ? vec3(0.48, 0.22, 0.08) : (th < 0.75 ? vec3(0.66, 0.54, 0.16) : vec3(0.25, 0.34, 0.12)));
  float tone = 0.9 + 0.2 * fract(h * 9.7);
  vec3 leaves = year.x > 0.0 ? countryBlend(leaf, turned * tone, year.x) : countryBlend(leaf, mix(leaf, COUNTRY_BUDS, 0.6), year.z);
  return countryBlend(leaves, COUNTRY_TWIGS * tone, year.y);
}

// The far canopy of the woods or a lone tree (leaf: its green at p; foot: metres a cell spans
// there; lonePine: a lone tree's that is a pine, which keeps it) as the time of year has it: from
// autumn through spring crown by crown where a crown spans a cell or two, settling farther off to
// the woods' mean (turned in broad patches as their trees' kinds go, bare, leafing out). The pine
// woods' colour goes over it after.
vec3 countryCanopyYear(vec3 leaf, vec2 p, float foot, bool lonePine) {
  float varied = countryKeys(0.0, 0.0, 1.0, 1.0, 1.0);
  if (varied <= 0.0 || lonePine) return leaf;
  float h = hash12(floor(p / 6.0) + 0.5);
  vec3 crowns = countryBroadleaf(leaf, h, countryLeafYear(h));
  vec3 turned = mix(vec3(0.5, 0.3, 0.1), vec3(0.42, 0.38, 0.14), smoothstep(0.25, 0.75, vnoise(p / 45.0)));
  vec3 mean = countryKeys(leaf, leaf, turned, COUNTRY_TWIGS, mix(leaf, COUNTRY_BUDS, 0.6));
  return mix(crowns, mean, smoothstep(2.0, 5.0, foot) * varied);
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

// Whether a bale may lie at site in parcel id (core: its clear core, and the highest clearance in
// it): inside the core while the woods reach no part of it, or else (the parcel looked up there) on
// its own ground well inside its border, clear of the roads, streams, yards, trees and the woods'
// crowns. Decided by the site alone, so a bale is whole or not there at all.
bool countryBaleClear(vec2 site, float id, vec4 core) {
  if (length(site - core.xy) < core.z - 2.0 && core.w <= countryWoodLine - COUNTRY_WOOD_EDGE) return true;
  vec4 c = terrainCover(valleyField1, site, COUNTRY_EXTENT);
  if (c.x < 5.0 || c.y < 4.0 || abs(c.w) > 0.02 || countryWoods(c, -2.0, true) > 0.0) return false;
  TerrainParcel here = terrainParcel(valleyField2, valleyField3, site, COUNTRY_EXTENT);
  return here.id == id && here.border > 6.0;
}

// Round bales on a barley field's stubble after its cut (parcel: the field under the ground point p
// the ray met at tHit, g the ground there; sun: toward the sun, world): at most one to a grid cell
// of the field's rows, where countryBaleClear lets it lie. The nearest the ray meets in front of
// the ground covers it (albedo, normal n, its own snow, porous); otherwise one whose foot or cast
// shadow p lies in shades the stubble. Not drawn under half a cell. The cells are walked first and
// only the one bale found is looked up, so the look-up runs once a pixel. A bale near the field's
// far side seen at a glancing angle loses its top where the ray behind it reaches the next field
// (as the herds do).
void countryBales(vec3 eye, vec3 rd, float tHit, vec3 p, vec4 g, TerrainParcel parcel, float cellAngle, float lying, vec3 sun, inout vec3 albedo, inout vec3 n, inout float snowy, inout float porous) {
  if (countryYear < ${glslFloat(COUNTRY_BALES[0])} || countryYear >= ${glslFloat(COUNTRY_BALES[1])} || floor(parcel.attr + 0.5) != LAND_CROP_BARLEY) return;
  // When the field's cut was done (countryFieldStage's barley), from the field's hash.
  float cut = 0.418 + 0.025 * fract(fract(parcel.id * 0.618034) * 7.31);
  float fall = dot(g.zw, rd.xz) - rd.y;
  if (COUNTRY_BALE_RADIUS < 0.6 * tHit * cellAngle || fall < 1e-3) return;
  vec4 core = terrainCore(valleyField3, parcel.id);
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
    // About half the cells hold a bale, kept clear of the cell's sides by more than its shadow, and
    // each lies from a little after the field's cut (the baler) until it is carted away before the
    // plough comes; looked into only where the ray's track passes over it or p lies by it.
    bool lies = h < 0.5 && countryYear >= cut + 0.02 * fract(h * 31.7) && countryYear < 0.485 + 0.012 * fract(h * 53.1);
    vec2 at = cell * COUNTRY_BALE_GRID + 4.0 + hash22(cell + parcel.id * 0.37) * (COUNTRY_BALE_GRID - 8.0);
    vec2 site = core.xy + along * at.x + across * at.y;
    vec2 off = p.xz - site;
    vec2 seen = site - eye.xz;
    if (lies && (abs(track.x * seen.y - track.y * seen.x) < 1.4 || dot(off, off) < 4.0 || dot(off - thrown, off - thrown) < 4.0)) {
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
      float t = countryBaleHit(eye, rd, vec3(site.x, terrainSurface(terrainGround(valleyField0, site, COUNTRY_EXTENT)), site.y), axis, bn, rim);
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
