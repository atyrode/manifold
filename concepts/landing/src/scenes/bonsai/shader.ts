// The bonsai's picture, back to front: the wall (plaster, shoji or dark) with the window's patch of
// sun on it and the tree's soft shadow moving through the day (and the lamp's big one at night);
// the veranda floor; the rosewood stand; the pot and its glaze; the moss with the litter of the
// season on it, a stone and a little clay sage; then the tree from the sim's maps, warped by the
// pads' sway: bark with its own light and snow along the tops of branches, foliage tuft by tuft in
// the season's colour, thinning as it falls; this spring's shoots; leaves, petals and needles in
// the air; a cut twig falling; the snip's glint; and in winter the snow, in depth.
// Knobs read here: K_species, K_pot, K_figure, K_time, K_cycle, K_light, K_wall, K_lamp, K_mark
// (trigger 2: the M gleams). The sim (sim.ts) owns the year, the snow, the sway, the shoots and
// everything that falls; its textures are described there and laid out in geometry.ts.
import {
  BONSAI_ATLAS,
  BONSAI_FIELD,
  BONSAI_FIGURE,
  BONSAI_FLOOR_Y,
  BONSAI_FRAME,
  BONSAI_GRID,
  BONSAI_GRID_CELL,
  BONSAI_LITTER,
  BONSAI_MAP,
  BONSAI_MAX_MOTES,
  BONSAI_MOUND,
  BONSAI_PER_UNIT,
  BONSAI_POT,
  BONSAI_REGION,
  BONSAI_ROWS,
  BONSAI_SOIL_Y,
  BONSAI_SPRITE,
  BONSAI_STAND,
  BONSAI_STONE,
  BONSAI_TILT,
  BONSAI_TRUNK,
  BONSAI_WALL_Z,
} from "./geometry.ts";
import { bonsaiSeasonGlsl } from "./season.ts";

/** A number as a GLSL float literal. */
const f = (value: number): string => value.toFixed(5);

export const bonsaiGlsl = `
// ---- bonsai ----
const float BONSAI_TILT = ${f(BONSAI_TILT)};
const vec4 BONSAI_REGION = vec4(${f(BONSAI_REGION.x0)}, ${f(BONSAI_REGION.y0)}, ${f(BONSAI_REGION.x1)}, ${f(BONSAI_REGION.y1)});
const vec2 BONSAI_MAP = vec2(${f(BONSAI_MAP.width)}, ${f(BONSAI_MAP.height)});
const float BONSAI_PER = ${f(BONSAI_PER_UNIT)};
const int BONSAI_DATA_W = ${BONSAI_FIELD.width};
const float BONSAI_FIELD_H = ${f(BONSAI_FIELD.height)};
const float BONSAI_DATA_H = ${f(BONSAI_ROWS.total)};
const int BONSAI_ROW_TUFTS = ${BONSAI_ROWS.tufts};
const int BONSAI_ROW_SHOOTS = ${BONSAI_ROWS.shoots};
const int BONSAI_ROW_MOTES = ${BONSAI_ROWS.motes};
const int BONSAI_ROW_LITTER = ${BONSAI_ROWS.litter};
const int BONSAI_ROW_STATE = ${BONSAI_ROWS.state};
const int BONSAI_ROW_GRID = ${BONSAI_ROWS.grid};
const int BONSAI_GRID_W = ${BONSAI_GRID.width};
const int BONSAI_GRID_H = ${BONSAI_GRID.height};
const float BONSAI_GRID_CELL = ${f(BONSAI_GRID_CELL)};
const int BONSAI_MOTES = ${BONSAI_MAX_MOTES};
const vec2 BONSAI_LITTER_AT = vec2(${f(BONSAI_LITTER.x0)}, ${f(BONSAI_LITTER.y0)});
const ivec2 BONSAI_LITTER_SIZE = ivec2(${BONSAI_LITTER.width}, ${BONSAI_LITTER.height});
const int BONSAI_SPRITE_SIZE = ${BONSAI_SPRITE.size};
const float BONSAI_SPRITE_SPAN = ${f(BONSAI_SPRITE.span)};
const int BONSAI_SPRITE_X = ${BONSAI_LITTER.width};
const float BONSAI_ATLAS_W = ${f(BONSAI_ATLAS.width)};
const vec3 BONSAI_POT_SIZE = vec3(${f(BONSAI_POT.a)}, ${f(BONSAI_POT.b)}, ${f(BONSAI_POT.height)});
const float BONSAI_POT_FOOT = ${f(BONSAI_POT.foot)};
const float BONSAI_POT_LIP = ${f(BONSAI_POT.lip)};
const float BONSAI_POT_TAPER = ${f(BONSAI_POT.taper)};
const float BONSAI_SOIL = ${f(BONSAI_SOIL_Y)};
const vec2 BONSAI_MOUND = vec2(${f(BONSAI_MOUND.height)}, ${f(BONSAI_MOUND.radius)});
const vec2 BONSAI_TRUNK = vec2(${f(BONSAI_TRUNK.x)}, ${f(BONSAI_TRUNK.z)});
const float BONSAI_STAND_TOP = ${f(BONSAI_STAND.top)};
const vec2 BONSAI_STAND_HALF = vec2(${f(BONSAI_STAND.halfWidth)}, ${f(BONSAI_STAND.halfDepth)});
const float BONSAI_STAND_SLAB = ${f(BONSAI_STAND.slab)};
const float BONSAI_STAND_APRON = ${f(BONSAI_STAND.apron)};
const float BONSAI_STAND_LEG = ${f(BONSAI_STAND.leg)};
const float BONSAI_FLOOR = ${f(BONSAI_FLOOR_Y)};
const float BONSAI_WALL_Z = ${f(BONSAI_WALL_Z)};
const vec4 BONSAI_STONE = vec4(${f(BONSAI_STONE.x)}, ${f(BONSAI_STONE.z)}, ${f(BONSAI_STONE.rx)}, ${f(BONSAI_STONE.ry)});
const vec3 BONSAI_FIGURE = vec3(${f(BONSAI_FIGURE.x)}, ${f(BONSAI_FIGURE.z)}, ${f(BONSAI_FIGURE.height)});
const vec4 BONSAI_FRAME = vec4(${f(BONSAI_FRAME.right)}, ${f(BONSAI_FRAME.wideAspect)}, ${f(BONSAI_FRAME.fitAspect)}, ${f(BONSAI_FRAME.rimY)});
const float BONSAI_LIFT = ${f(BONSAI_FRAME.lift)};
// The paper lamp off to the left, low and in front (world units).
const vec3 BONSAI_LAMP_AT = vec3(-1.05, -0.02, -0.5);
const vec3 BONSAI_LAMP = vec3(1.0, 0.6, 0.28);
// The window: where its patch of sun falls on the wall with the sun straight in front (display units).
const vec4 BONSAI_WINDOW = vec4(-0.95, -0.4, 1.45, 0.82);

const vec3 BONSAI_SNOW = vec3(0.90, 0.93, 0.98);
const vec3 BONSAI_ROSEWOOD = vec3(0.25, 0.115, 0.06);
const vec3 BONSAI_MOSS = vec3(0.19, 0.31, 0.08);
const vec3 BONSAI_GOLD = vec3(1.0, 0.76, 0.32);

${bonsaiSeasonGlsl}

// This pixel's world, set once at the top of sceneBonsai.
float bonsaiPx;        // display units per cell
float bonsaiYear;      // year phase 0..1 from the start of spring
float bonsaiSpecies;   // 0 pine, 1 maple, 2 cherry
float bonsaiLying;     // snow lying 0..1
float bonsaiFalling;   // snow falling 0..1
float bonsaiLeafy;     // how much foliage the tree carries, 0..1
float bonsaiCold;      // 1 deep in winter .. 0 high summer
vec3 bonsaiL;          // toward the sun (x right, y up, z away from the viewer: negative, it lights the front)
vec3 bonsaiSun;        // direct sun
vec3 bonsaiAmb;        // soft light from the sky over the veranda
vec3 bonsaiLampLight;  // the lamp's colour and strength
float bonsaiShift;     // how far right the stand (pot, tree, everything on it) stands off its place: 0 at rest, the entrance and exit slide it

// A record in one of the sim's tables: entry i of a table starting at 'row', laid along the rows.
vec4 bonsaiTable(int row, int i) {
  return texelFetch(uSim3, ivec2(i % BONSAI_DATA_W, row + i / BONSAI_DATA_W), 0);
}

// The low-resolution field at display point d: sway (x, y), wood and foliage silhouettes.
vec4 bonsaiField(vec2 d) {
  vec2 u = (d - BONSAI_REGION.xy) / (BONSAI_REGION.zw - BONSAI_REGION.xy);
  if (u.x < 0.0 || u.y < 0.0 || u.x > 1.0 || u.y > 1.0) return vec4(0.0);
  return texture(uSim3, vec2(u.x, clamp(u.y * BONSAI_FIELD_H, 0.5, BONSAI_FIELD_H - 0.5) / BONSAI_DATA_H));
}

// What casts a shadow at display point d: the wood, and the foliage as far as the season has it.
float bonsaiCaster(vec2 d) {
  vec4 s = bonsaiField(d);
  s = bonsaiField(d - s.xy);
  return max(s.z, s.w * bonsaiLeafy);
}

// Light arriving at a world point with normal n: the sun (times its visibility), the sky over
// the veranda (more from above), and the lamp.
vec3 bonsaiLight(vec3 p, vec3 n, float sun) {
  vec3 c = bonsaiSun * max(dot(n, bonsaiL), 0.0) * sun;
  c += bonsaiAmb * (0.62 + 0.38 * n.y);
  vec3 l = BONSAI_LAMP_AT - p;
  float r2 = dot(l, l);
  c += bonsaiLampLight * max(dot(n, l * inversesqrt(r2)), 0.0) * 0.45 / (r2 + 0.15);
  return c;
}

// The canopy's shadow on something below it at world point p: the silhouette seen from p toward
// the sun, a quarter unit up.
float bonsaiCanopyShade(vec3 p) {
  float s = 0.26 / max(bonsaiL.y, 0.2);
  vec3 q = p + bonsaiL * s;
  return 0.8 * bonsaiCaster(vec2(q.x, q.y + BONSAI_TILT * q.z));
}

vec3 bonsaiLeafColor(float hue) {
  vec3 c = mix(vec3(0.09, 0.22, 0.07), vec3(0.34, 0.54, 0.12), smoothstep(0.0, 0.2, hue));
  c = mix(c, vec3(0.80, 0.64, 0.12), smoothstep(0.24, 0.45, hue));
  c = mix(c, vec3(0.88, 0.38, 0.07), smoothstep(0.47, 0.62, hue));
  c = mix(c, vec3(0.80, 0.12, 0.06), smoothstep(0.64, 0.85, hue));
  return mix(c, vec3(0.50, 0.04, 0.07), smoothstep(0.88, 1.0, hue));
}

vec3 bonsaiNeedleColor(float hue) {
  vec3 c = mix(vec3(0.06, 0.17, 0.10), vec3(0.09, 0.22, 0.11), clamp(hue / 0.06, 0.0, 1.0));
  c = mix(c, vec3(0.30, 0.46, 0.14), smoothstep(0.07, 0.2, hue));
  return mix(c, vec3(0.56, 0.48, 0.17), smoothstep(0.22, 0.4, hue));
}

// The species' foliage colour for a palette position.
vec3 bonsaiFoliageColor(float hue) {
  return bonsaiSpecies < 0.5 ? bonsaiNeedleColor(hue) : bonsaiLeafColor(hue);
}

// Bark: pine in rough reddish plates, maple smooth grey, cherry dark with pale lenticels; jin bleached.
vec3 bonsaiBark(vec2 q, vec2 g, float r, float dead) {
  float vertical = abs(g.x);
  vec2 a = mix(vec2(q.y, q.x), q, vertical);
  vec3 c;
  if (bonsaiSpecies < 0.5) {
    float plates = vnoise(vec2(a.x * 90.0, a.y * 26.0));
    float cracks = 1.0 - smoothstep(0.18, 0.32, abs(vnoise(vec2(a.x * 40.0, a.y * 12.0)) - 0.5));
    c = mix(vec3(0.30, 0.21, 0.17), vec3(0.42, 0.31, 0.25), plates);
    c = mix(c, vec3(0.11, 0.08, 0.07), cracks * smoothstep(0.004, 0.012, r));
  } else if (bonsaiSpecies < 1.5) {
    float mottle = vnoise(q * 70.0);
    c = mix(vec3(0.36, 0.35, 0.32), vec3(0.52, 0.51, 0.46), mottle);
    c = mix(c, vec3(0.36, 0.22, 0.16), 1.0 - smoothstep(0.0025, 0.006, r));
  } else {
    float bands = smoothstep(0.62, 0.8, vnoise(vec2(a.x * 22.0, a.y * 160.0)));
    c = mix(vec3(0.24, 0.17, 0.16), vec3(0.32, 0.23, 0.21), vnoise(q * 60.0));
    c = mix(c, vec3(0.52, 0.44, 0.40), bands * smoothstep(0.005, 0.012, r));
  }
  vec3 bone = mix(vec3(0.70, 0.68, 0.62), vec3(0.88, 0.86, 0.80), vnoise(vec2(a.x * 120.0, a.y * 20.0)));
  return mix(c, bone, dead);
}

// ---- the room ----

vec3 bonsaiWall(vec2 d) {
  vec3 p = vec3(d.x, d.y - BONSAI_TILT * BONSAI_WALL_Z, BONSAI_WALL_Z);
  float wall = K_wall;
  vec3 albedo;
  float glow = 0.0;
  float base = BONSAI_FLOOR + BONSAI_TILT * BONSAI_WALL_Z;
  if (wall < 0.5) {
    // Earthen plaster: mottled, with the faint arcs of the trowel.
    float m = 0.6 * vnoise(d * 5.0) + 0.4 * vnoise(d * 13.0 + 3.1);
    float trowel = vnoise(vec2(d.x * 3.0 + sin(d.y * 9.0) * 0.4, d.y * 28.0));
    albedo = mix(vec3(0.50, 0.41, 0.31), vec3(0.62, 0.52, 0.39), m) * (0.94 + 0.08 * trowel);
    albedo *= 0.96 + 0.08 * vnoise(d * 140.0);
    if (d.y < base + 0.032) albedo = mix(vec3(0.16, 0.10, 0.065), vec3(0.22, 0.14, 0.09), vnoise(vec2(d.x * 6.0, d.y * 200.0)));
  } else if (wall < 1.5) {
    // Shoji: paper in a lattice of thin bars, on a low wooden kick panel; it glows with the day.
    vec2 cell = vec2(0.155, 0.2);
    vec2 g = (0.5 - abs(fract((d + vec2(0.04, 0.0)) / cell) - 0.5)) * cell;
    float bar = step(min(g.x, g.y), 0.0055);
    float stile = step((0.5 - abs(fract((d.x + 0.04) / 0.93) - 0.5)) * 0.93, 0.014);
    vec3 paper = vec3(0.80, 0.78, 0.70) * (0.95 + 0.06 * vnoise(vec2(d.x * 30.0, d.y * 260.0)));
    albedo = mix(paper, vec3(0.30, 0.21, 0.13), max(bar, stile));
    glow = (1.0 - max(bar, stile)) * 0.5;
    if (d.y < base + 0.1) albedo = mix(vec3(0.20, 0.13, 0.08), vec3(0.27, 0.18, 0.11), vnoise(vec2(d.x * 8.0, d.y * 160.0)));
    if (abs(d.y - (base + 0.1)) < 0.006) albedo = vec3(0.14, 0.09, 0.06);
  } else {
    // A dark alcove wall: charcoal plaster.
    albedo = mix(vec3(0.065, 0.06, 0.058), vec3(0.095, 0.085, 0.08), vnoise(d * 7.0)) * (0.95 + 0.1 * vnoise(d * 120.0));
  }
  // The sun's patch through the window: it slides across the wall with the sun.
  float cot = 1.0 / max(-bonsaiL.z, 0.25);
  vec2 shift = -bonsaiL.xy * cot * 0.45;
  vec4 w = BONSAI_WINDOW + vec4(shift, shift);
  float soft = 0.05;
  float beam = smoothstep(w.x - soft, w.x + soft, d.x) * (1.0 - smoothstep(w.z - soft, w.z + soft, d.x))
             * smoothstep(w.y - soft, w.y + soft, d.y) * (1.0 - smoothstep(w.w - soft * 1.6, w.w + soft * 1.6, d.y));
  // The tree's shadow (and the stand's and pot's below it): seen from the wall toward the sun.
  float s = min(BONSAI_WALL_Z * cot, 1.3);
  vec2 at = vec2(d.x - bonsaiShift + bonsaiL.x * s, p.y + bonsaiL.y * s);
  float shade = bonsaiCaster(at);
  float pot = (1.0 - smoothstep(-0.01, 0.02, abs(at.x) - BONSAI_POT_SIZE.x)) * (1.0 - smoothstep(-0.01, 0.02, abs(at.y + 0.5 * BONSAI_POT_SIZE.z) - 0.5 * BONSAI_POT_SIZE.z));
  float stand = (1.0 - smoothstep(-0.01, 0.02, abs(at.x) - BONSAI_STAND_HALF.x)) * (1.0 - smoothstep(-0.01, 0.02, abs(at.y - BONSAI_STAND_TOP + 0.5 * BONSAI_STAND_SLAB) - 0.5 * BONSAI_STAND_SLAB));
  shade = max(shade, max(pot, stand) * 0.9);
  vec3 n = vec3(0.0, 0.0, -1.0);
  vec3 c = albedo * (bonsaiSun * max(-bonsaiL.z, 0.0) * beam * (1.0 - 0.82 * shade) + bonsaiAmb * 0.8);
  // The lamp: a warm pool on the wall, and the tree's shadow thrown big and soft.
  vec3 l = BONSAI_LAMP_AT - p;
  float r2 = dot(l, l);
  float u = -BONSAI_WALL_Z / (BONSAI_LAMP_AT.z - BONSAI_WALL_Z);
  vec3 q = p + (BONSAI_LAMP_AT - p) * u;
  float lampShade = 0.75 * bonsaiCaster(vec2(q.x - bonsaiShift, q.y));
  vec3 lamp = bonsaiLampLight * max(dot(n, normalize(l)), 0.0) * 0.45 / (r2 + 0.15);
  c += albedo * lamp * (1.0 - lampShade);
  c += vec3(0.95, 0.88, 0.72) * glow * (bonsaiAmb * 0.5 + bonsaiSun * 0.12) * (1.0 - 0.7 * shade * beam);
  // The base of the wall in the floor's shade.
  c *= 0.7 + 0.3 * smoothstep(base, base + 0.12, d.y);
  return c;
}

vec3 bonsaiFloorAt(vec2 d) {
  float z = (d.y - BONSAI_FLOOR) / BONSAI_TILT;
  vec3 p = vec3(d.x, BONSAI_FLOOR, z);
  // Planks along the veranda, each its own tone, with grain and a dark seam.
  float k = floor(z / 0.11 + 0.3);
  float seam = abs(fract(z / 0.11 + 0.3) - 0.5) * 0.11 * BONSAI_TILT;
  vec3 albedo = mix(vec3(0.17, 0.11, 0.07), vec3(0.25, 0.16, 0.10), hash12(vec2(k, 3.0)));
  albedo *= 0.88 + 0.2 * vnoise(vec2(d.x * 7.0 + k * 5.0, k * 3.0 + z * 4.0));
  albedo *= 1.0 - 0.45 * (1.0 - smoothstep(0.4 * bonsaiPx, 1.4 * bonsaiPx, 0.5 * 0.11 * BONSAI_TILT - seam));
  // The stand's shadow: from the floor toward the sun up to the stand's top.
  float h = BONSAI_STAND_TOP - BONSAI_FLOOR;
  vec3 s = p + bonsaiL * (h / max(bonsaiL.y, 0.12));
  vec2 e = abs(vec2(s.x - bonsaiShift, s.z)) - BONSAI_STAND_HALF;
  float shadow = 1.0 - smoothstep(-0.02, 0.03, max(e.x, e.y));
  vec2 under = abs(vec2(p.x - bonsaiShift, p.z)) - BONSAI_STAND_HALF;
  float ao = 1.0 - 0.55 * (1.0 - smoothstep(-0.02, 0.06, max(under.x, under.y)));
  vec3 c = albedo * bonsaiLight(p, vec3(0.0, 1.0, 0.0), 1.0 - 0.85 * shadow) * ao;
  return c;
}

// The snow on an upward surface at display point d: mixes toward lit snow.
vec3 bonsaiSnowOn(vec3 col, vec3 n, vec2 p, vec3 light, float amount) {
  float cover = snowCover(n, p, bonsaiLying * amount);
  return mix(col, BONSAI_SNOW * light, hardEdge(cover));
}

// ---- the litter: what has come down and lies on the moss, the stand and the floor ----

vec4 bonsaiLitter(vec2 d) {
  ivec2 c = ivec2(floor((d - BONSAI_LITTER_AT) * BONSAI_PER));
  if (c.x < 0 || c.y < 0 || c.x >= BONSAI_LITTER_SIZE.x || c.y >= BONSAI_LITTER_SIZE.y) return vec4(0.0);
  vec4 l = texelFetch(uSim2, c, 0);
  if (l.a <= 0.0) return vec4(0.0);
  int slot = int(l.g + 0.5);
  vec4 decays = texelFetch(uSim3, ivec2(slot / 4, BONSAI_ROW_LITTER), 0);
  int k = slot - (slot / 4) * 4;
  float decay = k == 0 ? decays.x : k == 1 ? decays.y : k == 2 ? decays.z : decays.w;
  if (l.b < decay * 1.15 - 0.05) return vec4(0.0);
  float code = l.r * 4.0;
  float kind = floor(code);
  float hue = fract(code);
  vec3 col;
  if (kind < 0.5) col = bonsaiFoliageColor(hue);
  else if (kind < 1.5) col = mix(vec3(0.96, 0.80, 0.85), vec3(0.88, 0.62, 0.70), hue);
  else if (kind < 2.5) col = vec3(0.48, 0.32, 0.16) * (0.8 + 0.4 * hue);
  else col = vec3(0.30, 0.20, 0.14);
  // Drying and rotting: browner, then gone in patches.
  col = mix(col, vec3(0.30, 0.19, 0.10), smoothstep(0.1, 0.8, decay) * 0.8);
  return vec4(col * l.a, 1.0);
}

// ---- the stand, the pot, the moss ----

// The stand at display point d: rgb and coverage. top: 1 on its top surface (for litter and snow).
vec4 bonsaiStand(vec2 d, out float top) {
  top = 0.0;
  float hw = BONSAI_STAND_HALF.x;
  float hd = BONSAI_STAND_HALF.y;
  float front = BONSAI_STAND_TOP - BONSAI_TILT * hd;
  float back = BONSAI_STAND_TOP + BONSAI_TILT * hd;
  float slabBottom = front - BONSAI_STAND_SLAB;
  float floorFront = BONSAI_FLOOR - BONSAI_TILT * (hd - 0.03);
  vec3 albedo;
  vec3 n;
  vec3 p;
  if (abs(d.x) < hw && d.y > front && d.y < back) {
    top = 1.0;
    p = vec3(d.x, BONSAI_STAND_TOP, (d.y - BONSAI_STAND_TOP) / BONSAI_TILT);
    n = vec3(0.0, 1.0, 0.0);
    albedo = BONSAI_ROSEWOOD * (0.8 + 0.4 * vnoise(vec2(d.x * 9.0, p.z * 60.0))) * (0.9 + 0.15 * vnoise(vec2(d.x * 60.0, p.z * 400.0)));
  } else if (abs(d.x) < hw && d.y <= front && d.y > slabBottom) {
    float v = (front - d.y) / BONSAI_STAND_SLAB;
    p = vec3(d.x, BONSAI_STAND_TOP - v * BONSAI_STAND_SLAB, -hd);
    // A rounded edge on top, a softer one below.
    n = normalize(vec3(0.0, mix(0.9, -0.4, smoothstep(0.0, 1.0, v)) * (1.0 - smoothstep(0.25, 0.75, v)) - 0.4 * smoothstep(0.75, 1.0, v), -1.0));
    albedo = BONSAI_ROSEWOOD * (0.85 + 0.3 * vnoise(vec2(d.x * 10.0, d.y * 260.0)));
  } else {
    // The apron with its cloud-cut lower edge, and the legs curling out into scroll feet.
    float apronBottom = slabBottom - BONSAI_STAND_APRON * (0.55 + 0.45 * pow(abs(cos(d.x * 3.14159 / 0.18)), 3.0));
    float inset = hw - 0.012;
    float legT = clamp((slabBottom - d.y) / max(slabBottom - floorFront, 1e-3), 0.0, 1.0);
    float legX = hw - 0.012 - BONSAI_STAND_LEG * 0.5 + 0.014 * pow(smoothstep(0.55, 1.0, legT), 2.0) - 0.006 * sin(legT * 3.14159);
    float legW = BONSAI_STAND_LEG * 0.5 * (1.0 - 0.25 * legT) + 0.006 * smoothstep(0.85, 1.0, legT);
    bool apron = abs(d.x) < inset && d.y <= slabBottom && d.y > apronBottom;
    bool leg = abs(abs(d.x) - legX) < legW && d.y <= slabBottom && d.y > floorFront;
    if (!apron && !leg) return vec4(0.0);
    p = vec3(d.x, d.y + BONSAI_TILT * hd, -hd + 0.012);
    float side = leg ? (abs(d.x) - legX) / legW : 0.0;
    n = normalize(vec3(sign(d.x) * side * 0.7, 0.0, -1.0));
    albedo = BONSAI_ROSEWOOD * (0.75 + 0.3 * vnoise(vec2(d.x * 30.0, d.y * 120.0))) * (apron ? 0.82 : 1.0);
  }
  vec3 light = bonsaiLight(p, n, 1.0 - bonsaiCanopyShade(p));
  vec3 c = albedo * light;
  // Lacquered: a soft sheen of the sun and the lamp.
  vec3 v = normalize(vec3(0.0, BONSAI_TILT, -1.0));
  float spec = pow(max(dot(n, normalize(bonsaiL + v)), 0.0), 30.0);
  c += bonsaiSun * spec * 0.18;
  if (top > 0.5) {
    // The pot's contact shadow on the top.
    vec2 e = vec2(d.x / (BONSAI_POT_SIZE.x + 0.02), p.z / (BONSAI_POT_SIZE.y + 0.02));
    c *= 0.55 + 0.45 * smoothstep(0.85, 1.25, length(e));
  }
  return vec4(c, 1.0);
}

// The pot's outline: half depth at x for its shape (oval, or a rounded rectangle when unglazed).
float bonsaiPotDepth(float x, float a, float b, float k) {
  return b * pow(max(0.0, 1.0 - pow(min(abs(x) / a, 1.0), k)), 1.0 / k);
}

// The pot at display point d: rgb and coverage. rim: 1 on the rim top (snow).
vec4 bonsaiPot(vec2 d, out float rim) {
  rim = 0.0;
  float glaze = K_pot;
  float k = glaze < 0.5 ? 8.0 : 2.0;
  float a = BONSAI_POT_SIZE.x;
  float b = BONSAI_POT_SIZE.y;
  float H = BONSAI_POT_SIZE.z;
  float rimFront = -BONSAI_TILT * bonsaiPotDepth(d.x, a, b, k);
  float rimBack = BONSAI_TILT * bonsaiPotDepth(d.x, a, b, k);
  vec3 n;
  vec3 p;
  float v = 0.0;
  bool foot = false;
  if (d.y > rimFront && d.y < rimBack && abs(d.x) < a) {
    // The rim's top and the inner back wall above the soil (the soil itself is drawn after).
    rim = 1.0;
    p = vec3(d.x, 0.0, (d.y) / BONSAI_TILT);
    n = vec3(0.0, 1.0, 0.0);
  } else {
    // The body: solve for how far down the front surface this point is.
    v = (rimFront - d.y) / H;
    float aw = a - BONSAI_POT_TAPER * v * v;
    float bw = b - BONSAI_POT_TAPER * v * v;
    v = (-BONSAI_TILT * bonsaiPotDepth(d.x, aw, bw, k) - d.y) / H;
    aw = a - BONSAI_POT_TAPER * v * v + (v < BONSAI_POT_LIP / H ? 0.004 : 0.0);
    if (v < 0.0 || abs(d.x) > aw) return vec4(0.0);
    if (v > 1.0) {
      // Feet.
      float fx = abs(abs(d.x) - (k > 4.0 ? aw - 0.035 : 0.6 * aw));
      if (v > 1.0 + BONSAI_POT_FOOT / H || fx > 0.024 - 0.012 * (v - 1.0) * H / BONSAI_POT_FOOT) return vec4(0.0);
      foot = true;
    }
    float x = d.x / aw;
    float zf = -bonsaiPotDepth(d.x, aw, b - BONSAI_POT_TAPER * v * v, k);
    p = vec3(d.x, -v * H, zf);
    vec2 g = vec2(sign(x) * pow(min(abs(x), 1.0), k - 1.0) / aw, -pow(min(abs(zf) / b, 1.0), k - 1.0) / b);
    n = normalize(vec3(g.x, 0.0, g.y) / max(length(g), 1e-4));
    // The rolled lip catches the light from above; the belly turns under toward the foot.
    n.y += v < BONSAI_POT_LIP / H ? 0.45 : -0.35 * smoothstep(0.6, 1.0, v);
    n = normalize(n);
  }
  vec3 albedo;
  float gloss;
  vec2 t = d;
  if (glaze < 0.5) {
    albedo = mix(vec3(0.30, 0.17, 0.12), vec3(0.38, 0.22, 0.15), vnoise(t * 40.0)) * (0.92 + 0.12 * vnoise(t * 300.0));
    gloss = 0.08;
    // The potter's seal pressed into the lower corner of the face.
    vec2 s = abs(d - vec2(a - 0.05, -0.7 * H - BONSAI_TILT * b)) - vec2(0.011);
    float seal = step(max(s.x, s.y), 0.0) * step(-0.0035, max(s.x, s.y));
    albedo *= 1.0 - 0.35 * seal;
  } else if (glaze < 1.5) {
    albedo = mix(vec3(0.46, 0.60, 0.52), vec3(0.56, 0.68, 0.58), vnoise(t * 18.0));
    float crackle = (1.0 - smoothstep(0.0, 0.035, abs(vnoise(t * 55.0) - 0.5))) * 0.6 + (1.0 - smoothstep(0.0, 0.02, abs(vnoise(t * 23.0 + 9.0) - 0.5))) * 0.4;
    albedo *= 1.0 - 0.3 * crackle;
    gloss = 0.7;
  } else if (glaze < 2.5) {
    float pool = vnoise(vec2(d.x * 20.0, d.y * 6.0));
    albedo = mix(vec3(0.07, 0.13, 0.34), vec3(0.16, 0.28, 0.56), pool);
    // Where the glaze runs thin at the rim it breaks to the clay's brown; it pools in runs below.
    float runs = smoothstep(0.55, 0.85, vnoise(vec2(d.x * 70.0, 3.0))) * smoothstep(0.3, 0.9, v);
    albedo = mix(albedo, vec3(0.24, 0.40, 0.66), runs * 0.5);
    albedo = mix(albedo, vec3(0.36, 0.24, 0.17), (1.0 - smoothstep(0.0, 0.12, v)) * 0.75 + rim * 0.6);
    gloss = 0.9;
  } else {
    albedo = mix(vec3(0.74, 0.67, 0.53), vec3(0.82, 0.75, 0.60), vnoise(t * 14.0));
    albedo *= 1.0 - 0.55 * smoothstep(0.82, 0.9, vnoise(t * 160.0));
    gloss = 0.5;
  }
  if (foot) albedo *= 0.7;
  vec3 c = albedo * bonsaiLight(p, n, 1.0 - bonsaiCanopyShade(p));
  vec3 view = normalize(vec3(0.0, BONSAI_TILT, -1.0));
  float spec = pow(max(dot(n, normalize(bonsaiL + view)), 0.0), 60.0);
  vec3 lampDir = normalize(BONSAI_LAMP_AT - p);
  float lampSpec = pow(max(dot(n, normalize(lampDir + view)), 0.0), 50.0);
  c += (bonsaiSun * spec + bonsaiLampLight * lampSpec * 0.5) * gloss;
  // Its shadow at the foot, on the stand.
  c *= 0.75 + 0.25 * (1.0 - smoothstep(0.7, 1.0, v));
  if (rim > 0.5) c = bonsaiSnowOn(c, n, d * 20.0, bonsaiLight(p, n, 1.0), 1.0);
  return vec4(c, 1.0);
}

// The moss mound's height over the soil at (x, z).
float bonsaiMoundAt(float x, float z) {
  vec2 v = vec2(x - BONSAI_TRUNK.x, (z - BONSAI_TRUNK.y) * 1.4);
  return BONSAI_MOUND.x * exp(-dot(v, v) / (BONSAI_MOUND.y * BONSAI_MOUND.y));
}

// The soil and moss inside the rim at display point d: rgb, coverage; p is the world point.
vec4 bonsaiMossAt(vec2 d, out vec3 p) {
  float glaze = K_pot;
  float k = glaze < 0.5 ? 8.0 : 2.0;
  float a = BONSAI_POT_SIZE.x - BONSAI_POT_LIP;
  float b = BONSAI_POT_SIZE.y - BONSAI_POT_LIP;
  p = vec3(0.0);
  if (abs(d.x) > a) return vec4(0.0);
  float z = (d.y - BONSAI_SOIL) / BONSAI_TILT;
  float h = 0.0;
  for (int i = 0; i < 3; i++) {
    h = bonsaiMoundAt(d.x, z);
    z = (d.y - BONSAI_SOIL - h) / BONSAI_TILT;
  }
  float back = bonsaiPotDepth(d.x, a, b, k);
  // Beyond the back edge is the pot's inner wall and rim.
  if (z > back) return vec4(0.0);
  if (d.y < -BONSAI_TILT * bonsaiPotDepth(d.x, BONSAI_POT_SIZE.x, BONSAI_POT_SIZE.y, k)) return vec4(0.0);
  p = vec3(d.x, BONSAI_SOIL + h, z);
  // Cushions of moss with a velvet nap, bare soil and grit toward the rim.
  float cushion = vnoise(vec2(d.x, z) * 34.0);
  float nap = vnoise(vec2(d.x, z) * 160.0);
  float edge = bonsaiPotDepth(d.x, a, b, k) - abs(z);
  float bare = smoothstep(0.45, 0.7, vnoise(vec2(d.x, z) * 11.0 + 4.0)) * (1.0 - smoothstep(0.0, 0.05, edge)) + 1.0 - smoothstep(0.0, 0.02, edge);
  vec3 season = mix(vec3(1.15, 1.2, 0.8), vec3(0.95, 0.9, 0.7), smoothstep(0.45, 0.7, bonsaiYear));
  season = mix(season, vec3(0.85, 0.85, 0.85), smoothstep(0.72, 0.85, bonsaiYear) * (1.0 - smoothstep(0.95, 1.0, bonsaiYear)));
  vec3 moss = BONSAI_MOSS * season * (0.7 + 0.5 * cushion) * (0.85 + 0.3 * nap);
  vec3 soil = mix(vec3(0.13, 0.09, 0.06), vec3(0.24, 0.20, 0.16), step(0.75, vnoise(vec2(d.x, z) * 260.0)));
  vec3 albedo = mix(moss, soil, clamp(bare, 0.0, 1.0));
  // The cushions' bumps catch the light.
  vec3 n = normalize(vec3((cushion - vnoise(vec2(d.x + 0.01, z) * 34.0)) * 3.0, 1.0, 0.25));
  vec3 c = albedo * bonsaiLight(p, n, 1.0 - bonsaiCanopyShade(p));
  // Near the trunk's foot, under the canopy, a deeper shade.
  c *= 0.75 + 0.25 * smoothstep(0.0, 0.12, abs(d.x - BONSAI_TRUNK.x));
  return vec4(c, 1.0);
}

// The stone on the moss, and the Manifold M mended into it in gold. accent: the gold's glow.
vec4 bonsaiStone(vec2 d, inout float accent) {
  float z = BONSAI_STONE.y;
  vec2 c = vec2(BONSAI_STONE.x, BONSAI_SOIL + bonsaiMoundAt(BONSAI_STONE.x, z) + BONSAI_TILT * z + BONSAI_STONE.w * 0.55);
  vec2 q = (d - c) / BONSAI_STONE.zw;
  // A river stone: flatter below, a little lopsided.
  q.y *= q.y < 0.0 ? 1.6 : 1.0;
  q.x -= 0.12 * q.y;
  float r = length(q);
  if (r > 1.0) return vec4(0.0);
  vec3 n = normalize(vec3(q.x * 0.8, q.y * 0.9 + 0.2, -sqrt(max(1.0 - r * r, 0.0)) - 0.2));
  vec3 p = vec3(d.x, c.y, z);
  vec3 albedo = mix(vec3(0.17, 0.18, 0.20), vec3(0.27, 0.28, 0.30), vnoise(q * 6.0)) * (0.9 + 0.2 * vnoise(q * 30.0));
  vec3 col = albedo * bonsaiLight(p, n, 1.0 - bonsaiCanopyShade(p));
  vec3 view = normalize(vec3(0.0, BONSAI_TILT, -1.0));
  col += bonsaiSun * pow(max(dot(n, normalize(bonsaiL + view)), 0.0), 24.0) * 0.12;
  col = bonsaiSnowOn(col, n, q * 3.0, bonsaiLight(p, n, 1.0), 1.0);
  if (K_mark > 0.0) {
    // Kintsugi: the M in gold lacquer, catching the sun and the lamp; 'now' makes it gleam.
    vec2 m = (d - c - vec2(0.0, 0.002)) / (BONSAI_STONE.w * 1.25);
    float dm = markDistance(m);
    float gold = hardEdge(1.0 - smoothstep(0.085, 0.085 + 2.5 * bonsaiPx / (BONSAI_STONE.w * 1.25), dm));
    float since = sinceTrigger(2);
    float gleam = since >= 0.0 && since < 6.0 ? sin(3.14159 * since / 6.0) : 0.0;
    float shine = pow(max(dot(n, normalize(bonsaiL + view)), 0.0), 8.0);
    vec3 lit = BONSAI_GOLD * (0.35 + bonsaiLight(p, n, 1.0) * 0.9 + shine * bonsaiSun * 0.6) * (0.75 + 0.5 * K_mark) + BONSAI_GOLD * gleam * 0.6;
    col = mix(col, lit, gold);
    accent = max(accent, gold * clamp(K_mark * 0.9 + gleam, 0.0, 1.0));
  }
  return vec4(col, 1.0);
}

// A little clay sage in a straw hat, sitting on the moss under the tree.
vec4 bonsaiFigure(vec2 d) {
  float z = BONSAI_FIGURE.y;
  float h = BONSAI_FIGURE.z;
  vec2 base = vec2(BONSAI_FIGURE.x, BONSAI_SOIL + bonsaiMoundAt(BONSAI_FIGURE.x, z) + BONSAI_TILT * z);
  vec2 q = (d - base) / h;
  if (q.y < -0.05 || q.y > 1.0 || abs(q.x) > 0.5) return vec4(0.0);
  vec3 p = vec3(d.x, base.y, z);
  vec3 col = vec3(0.0);
  float cover = 0.0;
  // Robe: a rounded cone, sitting.
  float w = mix(0.36, 0.16, smoothstep(0.0, 0.6, q.y));
  if (q.y < 0.62 && abs(q.x + 0.03 * q.y) < w) {
    float side = (q.x + 0.03 * q.y) / w;
    vec3 n = normalize(vec3(side * 0.8, 0.2, -1.0));
    col = vec3(0.16, 0.26, 0.42) * (0.85 + 0.25 * vnoise(q * 20.0)) * bonsaiLight(p, n, 1.0 - bonsaiCanopyShade(p));
    col += bonsaiSun * pow(max(dot(n, normalize(bonsaiL + vec3(0.0, 0.14, -1.0))), 0.0), 20.0) * 0.25;
    cover = 1.0;
  }
  // Face, then the wide hat.
  if (length((q - vec2(0.0, 0.66)) * vec2(1.0, 1.1)) < 0.11) {
    col = vec3(0.42, 0.28, 0.20) * bonsaiLight(p, vec3(0.0, 0.0, -1.0), 1.0);
    cover = 1.0;
  }
  float hat = q.y - 0.7;
  if (hat > 0.0 && hat < 0.17 && abs(q.x) < 0.34 * (1.0 - hat / 0.17)) {
    vec3 n = normalize(vec3(q.x * 1.5, 1.0, -0.6));
    col = vec3(0.62, 0.48, 0.24) * (0.85 + 0.25 * vnoise(q * 40.0)) * bonsaiLight(p, n, 1.0 - bonsaiCanopyShade(p));
    col = bonsaiSnowOn(col, n, q, bonsaiLight(p, n, 1.0), 1.4);
    cover = 1.0;
  }
  return vec4(col, cover);
}

// ---- the tree ----

// The tree at display point d: wood and foliage from the maps, warped by the sway.
// Returns rgb and coverage; z gets the depth of what was drawn (world units).
vec4 bonsaiTree(vec2 d, out float z, inout float accent) {
  z = 1.0;
  vec2 sway = bonsaiField(d).xy;
  vec2 q = d - sway;
  vec2 u = (q - BONSAI_REGION.xy) / (BONSAI_REGION.zw - BONSAI_REGION.xy);
  if (u.x <= 0.0 || u.y <= 0.0 || u.x >= 1.0 || u.y >= 1.0) return vec4(0.0);
  vec2 e = 1.0 / BONSAI_MAP;
  vec4 w = texture(uSim0, u);
  vec4 fo = texture(uSim1, u);
  float px = bonsaiPx;
  vec3 col = vec3(0.0);
  float cover = 0.0;
  vec2 toSun = normalize(bonsaiL.xy + vec2(0.0, 0.25));

  // Wood.
  float cw = 0.0;
  vec3 woodCol = vec3(0.0);
  if (w.x < 2.0 * px) {
    cw = hardEdge(clamp(0.5 - w.x / px, 0.0, 1.0));
    vec2 g = vec2(texture(uSim0, u + vec2(e.x, 0.0)).x - texture(uSim0, u - vec2(e.x, 0.0)).x,
                  texture(uSim0, u + vec2(0.0, e.y)).x - texture(uSim0, u - vec2(0.0, e.y)).x);
    g /= max(length(g), 1e-6);
    float r = max(w.y, 1e-4);
    float across = clamp((w.x + r) / r, 0.0, 1.0);
    vec3 n = normalize(vec3(g * across, -sqrt(max(1.0 - across * across, 0.0))));
    vec3 p = vec3(q.x, q.y - BONSAI_TILT * w.z, w.z);
    vec4 above = bonsaiField(q + toSun * 0.07);
    float sun = 1.0 - 0.85 * clamp(above.w * bonsaiLeafy * 1.4, 0.0, 1.0);
    vec3 albedo = bonsaiBark(q, g, r, w.w);
    vec3 light = bonsaiLight(p, n, sun);
    woodCol = albedo * light;
    // Snow along the tops of the larger branches.
    if (r > 0.0035) woodCol = bonsaiSnowOn(woodCol, n, q * 9.0, bonsaiLight(p, vec3(0.0, 1.0, 0.0), sun), 1.1);
  }

  // Foliage.
  float cf = 0.0;
  vec3 leafCol = vec3(0.0);
  float zf = 1.0;
  if (fo.x > -0.3) {
    int id = int(texelFetch(uSim1, ivec2(u * BONSAI_MAP), 0).a + 0.5);
    vec4 t0 = bonsaiTable(BONSAI_ROW_TUFTS, 2 * id);
    vec4 t1 = bonsaiTable(BONSAI_ROW_TUFTS, 2 * id + 1);
    float lf = bonsaiLeafiness(bonsaiSpecies, bonsaiYear, t1.x, t1.z, t1.w);
    float bl = bonsaiBlossom(bonsaiSpecies, bonsaiYear, t1.x);
    vec2 nxy = fo.yz;
    float nz = sqrt(max(1.0 - dot(nxy, nxy), 0.0));
    vec3 n = vec3(nxy, -nz);
    float freq = 1.0 / (4.5 * px);
    float clump = 0.7 * vnoise(q * freq + t1.y * 31.0) + 0.3 * vnoise(q * freq * 1.7 + 7.3);
    if (bonsaiSpecies < 0.5) {
      // Needles fan out from each tuft's heart.
      vec2 v = q - t0.xy;
      vec2 dir = v / max(length(v), 1e-4);
      clump = 0.55 * vnoise(vec2(dot(q, dir) * freq * 0.55, dot(q, vec2(-dir.y, dir.x)) * freq * 1.4) + t1.y * 17.0) + 0.45 * clump;
    }
    float tr = max(t0.w, 1e-3);
    float aa = px / tr;
    vec3 p = vec3(q.x, t0.y - BONSAI_TILT * (t0.z + tr), t0.z + tr * (1.0 - nz));
    zf = p.z;
    vec4 above = bonsaiField(q + toSun * 0.08);
    float sun = 1.0 - 0.75 * clamp((above.w * bonsaiLeafy - 0.35) * 1.6, 0.0, 1.0);
    float rim = 0.55 + 0.45 * smoothstep(0.0, 0.5, fo.x);
    float shade = (0.68 + 0.6 * (clump - 0.5)) * rim;
    vec3 light = bonsaiLight(p, normalize(n + vec3(0.0, 0.25, 0.0)), sun);
    if (lf > 0.0) {
      // Leaves: the tuft fills out as they open and thins in patches as they fall.
      float thr = (1.0 - lf) * 1.02 - 0.03;
      float c = fo.x - thr + (clump - 0.5) * 0.5 * (0.6 + 0.4 * (1.0 - lf));
      cf = hardEdge(clamp(c / aa + 0.5, 0.0, 1.0));
      float hue = bonsaiHue(bonsaiSpecies, bonsaiYear, t1.x, t1.y, t1.z);
      leafCol = bonsaiFoliageColor(hue) * (0.85 + 0.3 * t1.y) * shade * light;
      // Thin leaves glow where the sun comes through them at a slant.
      leafCol += bonsaiFoliageColor(hue) * bonsaiSun * 0.12 * sun * (1.0 - nz);
      leafCol = bonsaiSnowOn(leafCol, normalize(n + vec3(0.0, 0.6, 0.0)), q * 7.0, bonsaiLight(p, vec3(0.0, 1.0, 0.0), sun), 1.0);
      float red = bonsaiSpecies < 0.5 ? 0.0 : smoothstep(0.6, 0.85, hue);
      accent = max(accent, cf * red * 0.9);
    }
    if (bl > 0.0) {
      // Blossom: clusters of pale pink flowers over the bare twigs, then over the first leaves.
      float flowers = vnoise(q * freq * 1.25 + 3.0 + t1.x * 9.0);
      float c = fo.x - (1.0 - bl) * 1.02 + (flowers - 0.45) * 0.7;
      float cb = hardEdge(clamp(c / aa + 0.5, 0.0, 1.0));
      if (cb > 0.0) {
        vec3 pink = mix(vec3(0.98, 0.86, 0.90), vec3(0.90, 0.58, 0.70), smoothstep(0.55, 0.85, flowers) * 0.7 + 0.3 * t1.y);
        leafCol = pink * (0.8 + 0.4 * (clump - 0.5)) * rim * light * 1.15;
        cf = 1.0;
        accent = max(accent, 0.55 * bl);
      }
    }
  }

  // Front to back: whichever is nearer here goes on top.
  if (zf < w.z) {
    col = mix(col, woodCol, cw);
    col = mix(col, leafCol, cf);
  } else {
    col = mix(col, leafCol, cf);
    col = mix(col, woodCol, cw);
  }
  cover = max(cw, cf);
  z = cw > 0.0 && (cf == 0.0 || w.z < zf) ? w.z : zf;

  // This spring's shoots, from the grid cell's list.
  ivec2 gc = ivec2(floor((q - BONSAI_REGION.xy) / BONSAI_GRID_CELL));
  if (gc.x >= 0 && gc.y >= 0 && gc.x < BONSAI_GRID_W && gc.y < BONSAI_GRID_H) {
    vec4 ids = bonsaiTable(BONSAI_ROW_GRID, gc.y * BONSAI_GRID_W + gc.x);
    for (int k = 0; k < 4; k++) {
      int id = int(ids[k] + 0.5) - 1;
      if (id < 0) break;
      vec4 s0 = bonsaiTable(BONSAI_ROW_SHOOTS, 2 * id);
      vec4 s1 = bonsaiTable(BONSAI_ROW_SHOOTS, 2 * id + 1);
      if (s1.y <= 0.0) continue;
      float len = s0.w;
      float grown = s1.y * len;
      vec2 d1 = vec2(cos(s0.z), sin(s0.z));
      vec2 d2 = vec2(cos(s0.z + s1.x), sin(s0.z + s1.x));
      vec2 a = s0.xy;
      vec2 b = a + d1 * min(grown, 0.5 * len);
      vec2 c = b + d2 * max(grown - 0.5 * len, 0.0);
      float stem = min(segmentDistance(q, a, b), segmentDistance(q, b, c));
      float pine = bonsaiSpecies < 0.5 ? 1.0 : 0.0;
      float sr = mix(max(0.0022, 1.1 * px), 0.0045 * (0.6 + 0.4 * s1.y), pine);
      float shootCover = 0.0;
      vec3 shootCol = vec3(0.0);
      float hue = bonsaiSpecies < 0.5 ? 0.2 : bonsaiHue(bonsaiSpecies, bonsaiYear, s1.w, s1.w, 1.0);
      vec3 p = vec3(q.x, q.y, -0.1);
      vec3 light = bonsaiLight(p, normalize(vec3(0.0, 0.5, -1.0)), 1.0);
      float sc = hardEdge(clamp((sr - stem) / px + 0.5, 0.0, 1.0));
      if (sc > 0.0) {
        shootCover = 1.0;
        shootCol = (pine > 0.5 ? vec3(0.72, 0.66, 0.48) : mix(vec3(0.42, 0.20, 0.12), vec3(0.30, 0.38, 0.14), 1.0 - smoothstep(0.1, 0.3, hue))) * light;
      }
      if (pine > 0.5) {
        // The candle opens into a sheaf of fresh needles.
        float sheaf = 0.004 + 0.007 * s1.z;
        float nd = stem - sheaf * (0.7 + 0.6 * vnoise(q * (1.0 / (2.5 * px))));
        float nc = hardEdge(clamp(-nd / px + 0.5, 0.0, 1.0)) * smoothstep(0.2, 0.5, s1.z);
        if (nc > 0.0) {
          shootCover = 1.0;
          shootCol = bonsaiNeedleColor(0.16) * light * (0.9 + 0.3 * vnoise(q * 300.0));
        }
      } else {
        // Leaves in pairs at the nodes, opening as the shoot matures, and one at the tip.
        for (int j = 0; j < 3; j++) {
          float at = (0.45 + 0.275 * float(j)) * len;
          if (at > grown + 0.002) break;
          vec2 node = at <= 0.5 * len ? a + d1 * at : b + d2 * (at - 0.5 * len);
          vec2 dir = at <= 0.5 * len ? d1 : d2;
          float size = 0.0085 * s1.z * (0.65 + 0.35 * float(j) / 2.0) * clamp((grown - at) / 0.012 + 0.4, 0.0, 1.0);
          if (size < 0.5 * px) continue;
          for (int side = 0; side < 2; side++) {
            float turn = (side == 0 ? 1.0 : -1.0) * (j == 2 ? 0.0 : 1.0);
            vec2 ld = rotate(dir, turn * 1.0);
            vec2 lc = node + ld * size * (j == 2 ? 0.9 : 1.0);
            vec2 l = rotate(q - lc, -atan(ld.y, ld.x)) / size;
            float rr = length(l);
            float ang = atan(l.y, l.x);
            float lobe = bonsaiSpecies < 1.5 ? 0.62 + 0.38 * pow(abs(cos(2.5 * ang)), 0.7) : 1.0 - 0.45 * abs(l.y);
            float lcov = hardEdge(clamp((lobe - rr) * size / px + 0.5, 0.0, 1.0));
            if (lcov > 0.0) {
              shootCover = 1.0;
              shootCol = bonsaiLeafColor(hue) * light * (0.95 + 0.2 * float(side));
              accent = max(accent, smoothstep(0.6, 0.85, hue) * 0.9);
            }
            if (j == 2) break;
          }
        }
      }
      if (shootCover > 0.0) {
        col = shootCol;
        cover = 1.0;
        z = -0.1;
      }
    }
  }
  return vec4(col, cover);
}

// ---- falling ----

// Leaves, petals and needles in the air.
vec4 bonsaiMotes(vec2 d, inout float accent) {
  vec4 out4 = vec4(0.0);
  for (int i = 0; i < BONSAI_MOTES; i++) {
    vec4 a = bonsaiTable(BONSAI_ROW_MOTES, 2 * i);
    if (a.w <= 0.0) continue;
    vec2 v = d - a.xy;
    if (dot(v, v) > a.w * a.w * 2.0) continue;
    vec4 b = bonsaiTable(BONSAI_ROW_MOTES, 2 * i + 1);
    float kind = floor(b.x);
    float hue = fract(b.x);
    vec2 l = rotate(v, -a.z) / a.w;
    l.x /= max(b.y, 0.3);
    float inside;
    vec3 col;
    float rr = length(l);
    if (kind < 0.5) {
      inside = bonsaiSpecies > 1.5 ? 1.0 - length(l * vec2(1.0, 1.9)) : 0.62 + 0.38 * pow(abs(cos(2.5 * atan(l.y, l.x))), 0.7) - rr;
      col = bonsaiFoliageColor(hue) * (0.85 + 0.3 * b.y);
      accent = max(accent, smoothstep(0.6, 0.85, hue) * step(0.0, inside) * 0.9);
    } else if (kind < 1.5) {
      inside = 1.0 - length(l * vec2(1.6, 2.6));
      col = mix(vec3(0.98, 0.86, 0.90), vec3(0.92, 0.66, 0.74), hue);
    } else {
      inside = min(0.14 - abs(l.y), 1.0 - abs(l.x)) * 4.0;
      col = vec3(0.50, 0.34, 0.17) * (0.8 + 0.4 * hue);
    }
    float c = hardEdge(clamp(inside * a.w / bonsaiPx + 0.5, 0.0, 1.0));
    if (c > 0.0) {
      vec3 p = vec3(d.x, d.y, -0.15);
      vec3 n = normalize(vec3(0.0, 0.4, -1.0) * (b.y > 0.7 ? 1.0 : 0.7) + vec3(0.0, 0.3, 0.0));
      out4 = vec4(col * bonsaiLight(p, n, 1.0) * (0.75 + 0.35 * b.y), 1.0);
    }
  }
  return out4;
}

// Cut twigs on their way down: their sprites, turned.
vec4 bonsaiTwigs(vec2 d) {
  vec4 out4 = vec4(0.0);
  for (int k = 0; k < 2; k++) {
    vec4 s = bonsaiTable(BONSAI_ROW_STATE, 4 + 2 * k);
    if (s.w <= 0.0) continue;
    vec2 l = rotate(d - s.xy, -s.z);
    ivec2 c = ivec2(floor((l / BONSAI_SPRITE_SPAN + 0.5) * float(BONSAI_SPRITE_SIZE)));
    if (c.x < 0 || c.y < 0 || c.x >= BONSAI_SPRITE_SIZE || c.y >= BONSAI_SPRITE_SIZE) continue;
    vec4 t = texelFetch(uSim2, ivec2(BONSAI_SPRITE_X + k * BONSAI_SPRITE_SIZE + c.x, c.y), 0);
    if (t.a <= 0.0) continue;
    vec3 p = vec3(d.x, d.y, -0.12);
    vec3 light = bonsaiLight(p, normalize(vec3(0.0, 0.4, -1.0)), 1.0);
    if (t.g > 0.0) out4 = vec4(bonsaiFoliageColor(t.b) * light * (0.8 + 0.3 * vnoise(l * 300.0)), 1.0);
    else if (t.r < 0.0) out4 = vec4(bonsaiBark(l, vec2(1.0, 0.0), 0.003, 0.0) * light, 1.0);
  }
  return out4;
}

// The placement: display point for a screen point.
vec2 bonsaiDisplay(vec2 uv, float aspect, out float scale) {
  scale = min(1.0, aspect / BONSAI_FRAME.z);
  float wide = clamp((aspect - 1.0) / (BONSAI_FRAME.y - 1.0), 0.0, 1.0);
  vec2 at = vec2(BONSAI_FRAME.x * wide, BONSAI_FRAME.w + (1.0 - scale) * BONSAI_LIFT);
  return (vec2((uv.x - 0.5) * aspect, uv.y) - at) / scale;
}

Shade sceneBonsai(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  float scale;
  vec2 d = bonsaiDisplay(uv, aspect, scale);
  bonsaiPx = 1.0 / (uRes.y * scale);
  bonsaiSpecies = K_species;
  vec4 state = bonsaiTable(BONSAI_ROW_STATE, 0);
  vec4 snip = bonsaiTable(BONSAI_ROW_STATE, 1);
  bonsaiYear = state.x;
  bonsaiLying = state.y;
  bonsaiFalling = state.z;
  bonsaiLeafy = state.w;
  bonsaiShift = bonsaiTable(BONSAI_ROW_STATE, 2).y;
  // Midsummer warm and high, midwinter cold and low: the year's chill (src/climate.ts).
  bonsaiCold = climateChill(bonsaiYear);

  // The light: the sky's sun, turned so it comes in from the front at the knob's angle and
  // sweeping across with the hours; lower and colder in winter. Its sky dims under snow cloud.
  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, uMotionTime));
  float az = clamp(K_light * 1.0 + sky.sun.x * 0.5, -1.3, 1.3);
  float elev = asin(clamp(sky.sun.y, -1.0, 1.0)) * mix(1.0, 0.55, bonsaiCold);
  float ce = cos(max(elev, 0.03));
  bonsaiL = normalize(vec3(sin(az) * ce, sin(max(elev, 0.03)), -cos(az) * ce));
  float overcast = smoothstep(0.0, 0.5, bonsaiFalling);
  bonsaiSun = sky.sunColor * vec3(1.12, 1.0, 0.86) * mix(vec3(1.0), vec3(0.86, 0.94, 1.1), bonsaiCold) * (1.0 - 0.85 * overcast) * 1.05;
  bonsaiAmb = (sky.ambient * 0.42 + vec3(0.012, 0.011, 0.01)) * mix(vec3(1.0), vec3(0.95, 1.0, 1.1), bonsaiCold) * (1.0 + 0.6 * overcast + 0.35 * bonsaiLying);
  bonsaiLampLight = BONSAI_LAMP * K_lamp * (1.0 - 0.85 * sky.day) * 1.4;

  float accent = 0.0;
  float standTop;
  float rim;
  vec3 col;
  float depth = 2.0 + 1.2 * BONSAI_WALL_Z;
  float base = BONSAI_FLOOR + BONSAI_TILT * BONSAI_WALL_Z;
  if (d.y > base) {
    col = bonsaiWall(d);
  } else {
    col = bonsaiFloorAt(d);
    depth = 2.0 + 1.2 * (d.y - BONSAI_FLOOR) / BONSAI_TILT;
    vec4 l = bonsaiLitter(d);
    col = mix(col, l.rgb * bonsaiLight(vec3(d.x, BONSAI_FLOOR, 0.0), vec3(0.0, 1.0, 0.0), 1.0), l.a);
    col = bonsaiSnowOn(col, vec3(0.0, 1.0, 0.0), d * vec2(5.0, 25.0), bonsaiLight(vec3(d.x, BONSAI_FLOOR, 0.0), vec3(0.0, 1.0, 0.0), 1.0), 0.8);
  }
  // Everything on the stand (and the stand) is drawn in its own frame g, slid by the passage; the
  // wall and floor stay in the room's, d (g == d at rest).
  vec2 g = vec2(d.x - bonsaiShift, d.y);
  vec4 stand = bonsaiStand(g, standTop);
  if (stand.a > 0.0) {
    col = stand.rgb;
    depth = 2.0 - 0.2;
    if (standTop > 0.5) {
      vec3 p = vec3(g.x, BONSAI_STAND_TOP, (g.y - BONSAI_STAND_TOP) / BONSAI_TILT);
      vec3 light = bonsaiLight(p, vec3(0.0, 1.0, 0.0), 1.0 - bonsaiCanopyShade(p));
      vec4 l = bonsaiLitter(g);
      col = mix(col, l.rgb * light, l.a);
      col = bonsaiSnowOn(col, vec3(0.0, 1.0, 0.0), g * vec2(6.0, 30.0), light, 1.0);
    }
  }
  vec4 pot = bonsaiPot(g, rim);
  if (pot.a > 0.0) {
    col = pot.rgb;
    depth = 1.8;
  }
  vec3 mp;
  vec4 moss = bonsaiMossAt(g, mp);
  if (moss.a > 0.0) {
    col = moss.rgb;
    vec3 light = bonsaiLight(mp, vec3(0.0, 1.0, 0.0), 1.0 - bonsaiCanopyShade(mp));
    vec4 l = bonsaiLitter(g);
    col = mix(col, l.rgb * light, l.a);
    col = bonsaiSnowOn(col, vec3(0.0, 1.0, 0.0), vec2(g.x, mp.z) * 10.0, light, 1.1);
    depth = 1.9;
  }
  // The stone and the figure sit on the moss among the roots: whichever is nearer shows.
  float stoneAccent = 0.0;
  vec4 stone = bonsaiStone(g, stoneAccent);
  vec4 fig = K_figure > 0.5 ? bonsaiFigure(g) : vec4(0.0);
  float treeZ;
  vec4 tree = bonsaiTree(g, treeZ, accent);
  // The trunk's foot and the roots go down into the soil behind the pot's front wall.
  if (pot.a > 0.0 && rim < 0.5) tree.a = 0.0;
  if (tree.a > 0.0) {
    col = tree.rgb;
    depth = 1.9 + 1.2 * treeZ;
  }
  if (stone.a > 0.0 && (tree.a <= 0.0 || treeZ > BONSAI_STONE.y)) {
    col = stone.rgb;
    accent = max(accent, stoneAccent);
  }
  if (fig.a > 0.0 && (tree.a <= 0.0 || treeZ > BONSAI_FIGURE.y)) col = fig.rgb;
  vec4 twigs = bonsaiTwigs(g);
  if (twigs.a > 0.0) col = twigs.rgb;
  vec4 box = bonsaiTable(BONSAI_ROW_STATE, 3);
  vec4 motes = g.x > box.x && g.y > box.y && g.x < box.z && g.y < box.w ? bonsaiMotes(g, accent) : vec4(0.0);
  if (motes.a > 0.0) col = motes.rgb;

  // The snip: a brief glint where the blades met.
  if (snip.z < 0.5) {
    vec2 v = (g - snip.xy) / max(bonsaiPx, 1e-5);
    float k = snip.z / 0.5;
    float len = mix(3.0, 9.0, k);
    float star = (1.0 - smoothstep(0.6, 1.4, abs(v.x))) * step(abs(v.y), len) + (1.0 - smoothstep(0.6, 1.4, abs(v.y))) * step(abs(v.x), len);
    star = max(star, 1.0 - smoothstep(1.0, 2.2, length(v)));
    col = mix(col, vec3(1.0, 0.95, 0.85), hardEdge(clamp(star, 0.0, 1.0) * (1.0 - k)));
  }

  // Winter's snow, falling in depth in front of the wall and through the tree.
  if (bonsaiFalling > 0.0) {
    Precip p = snowFall(uv, aspect, uMotionTime, bonsaiFalling, 0.12 * K_breeze, 1.0 - exp(-depth / 30.0));
    vec3 air = vec3(0.70, 0.74, 0.80) * (dot(bonsaiAmb, LUMA) * 1.4 + dot(bonsaiSun, LUMA) * 0.3 + 0.03);
    col = mix(col, air, p.veil);
    vec3 flake = BONSAI_SNOW * (dot(bonsaiAmb, LUMA) * 1.6 + dot(bonsaiSun, LUMA) * 0.6 + dot(bonsaiLampLight, LUMA) * 0.08 + 0.06);
    col = mix(col, flake, p.cover);
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(dot(col, LUMA) * 1.6, 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  return o;
}
`;
