// The tide pool, seen from straight above: the rock platform and its zones of life, the basin and
// the open sea along the top, all under the shallow water of sim.ts.
//
//   uSim0  depth (cells), level slope xy (cells per cell), caustic focus (ShallowWater.surface)
//   uSim1  foam, agitation, wetness (the water's carried field)
//   uSim2  bed (cells), still depth, inside the basin, in the surge channel (layout.ts)
//   uSim3  the life (life.ts): fish, the water's coarse flow, the fronds' and anemones' records
//
// Lengths are in frame heights (q = uv · (aspect, 1)); heights in cells of height, TIDEPOOL_RELIEF
// cells of the frame each, so a depth d is d · RELIEF / ROWS frame heights of water. Light comes
// from the shared sky (sun and moon by the time of day), refracts through the surface onto the bed
// with the caustic net of the swell (the sim's focus) times the wind ripples' (the water library's caustics tier: causticRipples, waterCaustic), is
// absorbed red first on the way down and up, and glints off the facets turned toward the sun. The
// bed is drawn at the point the water shows it (shifted by the refraction), life and all: the
// fronds and anemones are the shared plant component's (life.ts), streaming and leaning in the
// flow on the CPU; the anemones close at a surge or a touch (agitation) and when the water leaves
// them; the fish (sims/fish.ts) are drawn here from their poses.
import { glslFloat } from "../../shaders/glsl.ts";
import { plantsGlsl } from "../../shaders/lib/plants.ts";
import { fishGlsl } from "../../sims/fish.ts";
import { TIDEPOOL_RELIEF } from "./layout.ts";
import {
  TIDEPOOL_ANEMONE_GRID,
  TIDEPOOL_BLADES,
  TIDEPOOL_FISH_MAX,
  TIDEPOOL_FROND_GRID,
  TIDEPOOL_FROND_ROWS,
  TIDEPOOL_LIFE_HEADER,
  TIDEPOOL_LIFE_WIDTH,
} from "./life.ts";
import { TIDEPOOL_ROWS } from "./sim.ts";

/** Seconds of the scene's entrance and exit (SceneDef.passage). */
export const TIDEPOOL_PASSAGE = { enter: 3, exit: 1.6 } as const;

export const tidepoolGlsl = `${plantsGlsl}${fishGlsl}
// ---- tide pool ----

const float TP_RELIEF = ${glslFloat(TIDEPOOL_RELIEF)};
const float TP_ROWS = ${glslFloat(TIDEPOOL_ROWS)};
// The life texture (life.ts): its width, header row, lattices and fish.
const int TP_LIFE_W = ${TIDEPOOL_LIFE_WIDTH};
const int TP_LIFE_HEADER = ${TIDEPOOL_LIFE_HEADER};
const float TP_FROND_GRID = ${glslFloat(TIDEPOOL_FROND_GRID)};
const int TP_FROND_ROWS = ${TIDEPOOL_FROND_ROWS};
const int TP_BLADES = ${TIDEPOOL_BLADES};
const float TP_ANEMONE_GRID = ${glslFloat(TIDEPOOL_ANEMONE_GRID)};
const int TP_FISH_MAX = ${TIDEPOOL_FISH_MAX};
// Frame heights of water per cell of depth.
const float TP_DEPTH = TP_RELIEF / TP_ROWS;
// The frame's height in metres, for the weather's splashes and rings.
const float TP_METRES = 3.0;
const float TP_ENTER = ${glslFloat(TIDEPOOL_PASSAGE.enter)};
const float TP_EXIT = ${glslFloat(TIDEPOOL_PASSAGE.exit)};
// Light lost per frame height of water, red first.
const vec3 TP_ABSORB = vec3(9.0, 3.0, 2.1);
// The colour the water scatters back, per unit of light.
const vec3 TP_WATER = vec3(0.025, 0.13, 0.15);

// The frame's light, set once by the entry: toward the sun (or the moon by night) as x right, y up
// the frame, z up to the camera; its colour; the sky's ambient; the sky itself.
Sky tpSky;
vec3 tpLight;
vec3 tpLightCol;
vec3 tpAmbient;
// Passage: anemones' openness and the fronds' lean (frame heights per frame height of reach).
float tpOpen;
vec2 tpLean;

// A Voronoi cell lattice: x the distance to the nearest site, y the gap to the second (0 on a seam);
// id the nearest site's cell, at its centre (lattice units).
vec2 tpCells(vec2 x, float jitter, out vec2 id, out vec2 at) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = 0.5 + (hash22(i + g) - 0.5) * jitter;
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; id = i + g; at = i + g + o; }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec2(f1, f2 - f1);
}

// The life texture's header (life.ts): flow rows, first record row, frond and anemone lattice columns.
ivec4 tpLife() {
  return ivec4(texelFetch(uSim3, ivec2(0, TP_LIFE_HEADER), 0) + 0.5);
}

// The flow (cells/s) at uv: the sim's flow, averaged onto the life's coarse grid and read back.
vec2 tpFlow(vec2 uv) {
  int rows = tpLife().x;
  vec2 g = clamp(uv * vec2(float(TP_LIFE_W), float(rows)) - 0.5, vec2(0.0), vec2(float(TP_LIFE_W - 1), float(rows - 1)));
  ivec2 i = ivec2(floor(g));
  ivec2 j = min(i + 1, ivec2(TP_LIFE_W - 1, rows - 1));
  vec2 f = g - vec2(i);
  int base = TP_LIFE_HEADER + 1;
  vec2 a = texelFetch(uSim3, ivec2(i.x, base + i.y), 0).xy;
  vec2 b = texelFetch(uSim3, ivec2(j.x, base + i.y), 0).xy;
  vec2 c = texelFetch(uSim3, ivec2(i.x, base + j.y), 0).xy;
  vec2 d = texelFetch(uSim3, ivec2(j.x, base + j.y), 0).xy;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ---- life on the bed ----------------------------------------------------------------------------

// What a point of the bed shows: albedo, its tilt (xy, added to the rock's), gloss, accent.
struct TpBed {
  vec3 albedo;
  vec2 tilt;
  float gloss;
  float accent;
};

// An anemone at the site 'at' (frame heights) of radius r, its tentacles reaching 'reach' times out
// when fully open: a ring of tapering tentacles leaning with the flow, an oral disc with its mouth.
// Open 0 is closed: a dome with bits of shell stuck to it. Writes into b where it covers q.
void tpAnemone(vec2 q, vec2 at, float r, float reach, float open, vec2 lean, float seed, float tm, float foot, inout TpBed b) {
  vec2 v = q - at;
  float out_ = mix(1.05, reach, open) * r;
  if (dot(v, v) > out_ * out_ * 1.7) return;
  float s = clamp(length(v) / out_, 0.0, 1.0);
  // Tentacles lean downstream, more toward their tips.
  v -= lean * out_ * s * s * open;
  float d = length(v);
  float ang = atan(v.y, v.x);
  bool giant = seed > 0.55;
  vec3 disc = giant ? vec3(0.22, 0.55, 0.42) : vec3(0.38, 0.45, 0.22);
  vec3 arm = giant ? vec3(0.32, 0.72, 0.55) : vec3(0.42, 0.62, 0.38);
  if (open < 0.08 || d < r * mix(0.98, 0.62, open)) {
    float rc = r * mix(1.05, 0.62, open);
    if (d > rc) return;
    if (open < 0.08) {
      // Closed: a soft green dome, gravel stuck to it, the column's top puckered.
      vec2 id;
      vec2 site;
      vec2 grit = tpCells(v / r * 3.2 + seed * 17.0, 0.9, id, site);
      float shade = 0.75 + 0.25 * sqrt(max(0.0, 1.0 - d * d / (rc * rc)));
      b.albedo = mix(disc * 0.55, vec3(0.62, 0.6, 0.55), step(0.62, hash12(id + seed)) * smoothstep(0.22, 0.12, grit.x)) * shade;
      b.albedo *= 1.0 - 0.4 * smoothfall(0.18, 0.05, d / rc) * step(0.5, fract(ang * 1.9));
      b.tilt = v / max(rc, 1e-4) * 0.6;
      b.gloss = 0.4;
      b.accent = 0.0;
      return;
    }
    // The oral disc: radial lines to a slit mouth.
    float lines = 0.5 + 0.5 * cos(ang * 18.0);
    vec3 c = mix(disc, disc * 1.25, lines * smoothstep(0.25, 0.8, d / rc));
    float mouth = sdEllipse(rotate(v, -seed * 6.0), vec2(0.26, 0.1) * rc);
    c = mix(c, vec3(0.12, 0.16, 0.1), softFill(mouth, foot));
    b.albedo = c;
    b.tilt = vec2(0.0);
    b.gloss = 0.3;
    b.accent = 0.0;
    return;
  }
  // The tentacles: 24-34 tapering rays, each swaying a little of its own accord.
  float count = floor(24.0 + 10.0 * fract(seed * 7.3));
  float inner = r * mix(0.98, 0.62, open);
  float t = (d - inner) / max(out_ - inner, 1e-4);
  if (t > 1.0) return;
  float wave = 0.09 * sin(t * 6.0 - tm * 1.3 + seed * 20.0) * t;
  float a = fract((ang + wave) / TAU * count);
  float width = 0.42 * pow(max(1.0 - t, 0.0), 0.7);
  if (abs(a - 0.5) > width) return;
  b.albedo = mix(arm, mix(arm * 1.3, vec3(1.0, 0.55, 0.75), giant ? 0.35 : 0.85), smoothstep(0.55, 1.0, t));
  b.tilt = v / max(d, 1e-4) * 0.5 * (1.0 - t);
  b.gloss = 0.5;
  b.accent = smoothstep(0.7, 0.95, t) * (giant ? 0.35 : 0.9);
}

// Fronds from holdfasts on a jittered grid: brown kelp-like ribbons on the low rock and in the pool,
// bright surfgrass in the surge channel. The holdfasts and their blades are rooted plants (life.ts):
// each blade an arc bent by the flow on the CPU (its record's bend), fluttering along its length
// here; the knobs pick which holdfasts show by rank (b), the passage's wash leans them all.
void tpFronds(vec2 q, float aspect, float tm, float foot, inout TpBed b) {
  const float G = TP_FROND_GRID;
  ivec4 life = tpLife();
  vec2 cellAt = floor(q / G);
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 id = cellAt + vec2(float(k), float(y));
      ivec2 cell = ivec2(id) + 1;
      if (cell.x < 0 || cell.y < 0 || cell.x >= life.z || cell.y >= TP_FROND_ROWS) continue;
      vec2 h = hash22(id + 41.7);
      vec2 anchor = (id + 0.2 + 0.6 * h) * G;
      float len = G * (0.7 + 0.6 * fract(h.x * 13.1)) * 1.15;
      vec2 rel = q - anchor;
      if (dot(rel, rel) > len * len * 1.3) continue;
      for (int i = 0; i < TP_BLADES; i++) {
        PlantOrgan o = plantOrgan(uSim3, life.y, (cell.y * life.z + cell.x) * TP_BLADES + i);
        if (o.tier < 0.5) continue;
        bool grass = o.form > 0.5;
        if (o.b > (grass ? K_surfgrass * 1.2 : K_fronds)) break;
        vec2 dir = o.dir;
        if (tpLean != vec2(0.0)) dir = normalize(mix(dir, normalize(tpLean), clamp(length(tpLean), 0.0, 0.95)));
        vec2 l = vec2(dot(rel, dir), dir.x * rel.y - dir.y * rel.x);
        float s;
        float across = plantArc(l, o.len, o.bend, s) / o.len;
        if (s < 0.0 || s > 1.0) continue;
        // Flutter: a wave running out along the blade, livelier the harder the flow bends it.
        float pull = clamp(abs(o.bend) / 1.6, 0.0, 0.95);
        across -= (0.05 + 0.12 * pull) * s * sin(s * 9.0 - tm * (1.6 + 4.0 * pull) + o.a);
        float halfWidth = grass ? 0.016 * (1.0 - 0.6 * s) : 0.06 * sin(3.14159 * min(s * 1.25, 1.0)) * (1.0 - 0.3 * s) + 0.012;
        if (abs(across) > halfWidth + foot / o.len * 0.4) continue;
        float rib = smoothstep(0.35, 0.0, abs(across) / halfWidth);
        vec3 c = grass
          ? mix(vec3(0.16, 0.5, 0.2), vec3(0.42, 0.78, 0.3), 0.4 + 0.6 * s)
          : mix(vec3(0.3, 0.24, 0.08), vec3(0.6, 0.48, 0.16), 0.3 + 0.5 * s) * (0.85 + 0.25 * rib);
        b.albedo = plantPhenology(c, o.pheno) * (0.9 + 0.2 * hash12(id + o.variant));
        vec2 along = rotate(dir, o.bend * s);
        b.tilt = vec2(-along.y, along.x) * (across / max(halfWidth, 1e-4)) * 0.6;
        b.gloss = 0.6;
        b.accent = 0.0;
      }
    }
  }
}

// A sea star (five tapering arms, knobbly) or an urchin (a purple ball bristling with spines).
void tpStarsAndUrchins(vec2 q, float aspect, float foot, inout TpBed b) {
  // Sea stars: on the low rock and down the pool's walls, a few per frame.
  if (K_seastars > 0.0) {
    const float G = 0.13;
    vec2 id = floor(q / G);
    vec2 h = hash22(id + 7.3);
    vec2 at = (id + 0.3 + 0.4 * h) * G;
    vec4 site = texture(uSim2, at / vec2(aspect, 1.0));
    float r = G * (0.16 + 0.1 * fract(h.x * 5.7));
    bool fits = site.x > -2.0 && site.x < 1.2 && (site.y < 1.6);
    if (fits && fract(h.y * 3.9) < K_seastars) {
      vec2 v = rotate(q - at, h.x * 6.283);
      float ang = atan(v.y, v.x);
      float arm = abs(fract(ang / TAU * 5.0) - 0.5) * 2.0;
      float reach = r * (0.32 + 0.68 * pow(1.0 - arm, 1.6));
      float d = length(v);
      if (d < reach + foot) {
        float hue = fract(h.x * 11.0);
        vec3 c = hue < 0.45 ? vec3(0.9, 0.42, 0.1) : hue < 0.8 ? vec3(0.5, 0.16, 0.42) : vec3(0.95, 0.62, 0.2);
        vec2 dotsId;
        vec2 dotsAt;
        vec2 knobs = tpCells(v / r * 6.0, 0.8, dotsId, dotsAt);
        c = mix(c, vec3(0.95, 0.9, 0.82), 0.6 * smoothstep(0.25, 0.1, knobs.x));
        b.albedo = c * (0.75 + 0.25 * (1.0 - d / max(reach, 1e-4)));
        b.tilt = v / max(d, 1e-4) * 0.5 * (d / max(reach, 1e-4));
        b.gloss = 0.2;
        b.accent = 0.0;
        return;
      }
    }
  }
  // Urchins: in the pool's deeper hollows.
  if (K_urchins > 0.0) {
    const float G = 0.05;
    vec2 id = floor(q / G);
    vec2 h = hash22(id + 19.1);
    vec2 at = (id + 0.3 + 0.4 * h) * G;
    vec4 site = texture(uSim2, at / vec2(aspect, 1.0));
    if (site.y > 1.6 && site.z > 0.5 && fract(h.y * 5.1) < K_urchins * 0.6) {
      float r = G * (0.14 + 0.06 * h.x);
      vec2 v = q - at;
      float d = length(v);
      float ang = atan(v.y, v.x);
      float spine = abs(fract(ang / TAU * 26.0 + d / r * 0.4) - 0.5);
      if (d < r * 0.6 || (d < r * 1.55 && spine < 0.12 * (1.6 - d / r))) {
        float body = d < r * 0.6 ? 1.0 : 0.0;
        b.albedo = mix(vec3(0.3, 0.1, 0.36), vec3(0.55, 0.22, 0.6), body * (0.6 + 0.4 * (1.0 - d / (0.6 * r))));
        b.tilt = v / max(d, 1e-4) * 0.4;
        b.gloss = 0.5;
        b.accent = 0.0;
      }
    }
  }
}

// ---- the bed ------------------------------------------------------------------------------------

// The rock's own colour by zone: bands set by height above mean sea level (bed in cells), the pool's
// floor, and the knobs for mussels, barnacles and coralline crust.
vec3 tpRock(vec2 q, vec4 site, float foot, out float gloss) {
  float bed = site.x;
  float grain = fbm3(q * 60.0);
  float mottle = fbm3(q * 9.0 + 3.0);
  vec3 stone = K_rockType < 0.5 ? vec3(0.17, 0.16, 0.15) : K_rockType < 1.5 ? vec3(0.45, 0.42, 0.4) : vec3(0.52, 0.38, 0.25);
  vec3 c = stone * (0.75 + 0.35 * mottle) * (0.88 + 0.24 * grain);
  if (K_rockType > 0.5 && K_rockType < 1.5) c *= 0.8 + 0.35 * step(0.72, vnoise(q * 420.0));
  gloss = 0.1;
  // Zone edges wander with the rock.
  float h = bed + (mottle - 0.5) * 0.9;
  // Splash zone: orange and grey lichen spots; then the black lichen band.
  float lichen = smoothstep(2.3, 2.7, h);
  float orange = lichen * smoothstep(0.62, 0.7, fbm3(q * 22.0 + 5.0));
  c = mix(c, vec3(0.86, 0.52, 0.12), orange * 0.85);
  c = mix(c, vec3(0.62, 0.64, 0.58), lichen * smoothstep(0.6, 0.66, fbm3(q * 30.0 + 9.0)) * 0.6);
  c = mix(c, vec3(0.05, 0.05, 0.05), smoothstep(2.3, 2.45, h) * (1.0 - smoothstep(2.6, 2.8, h)) * (0.6 + 0.3 * grain));
  // Barnacles: scattered pale cones with a dark hole, in clusters rather than a carpet.
  float barnacleZone = smoothstep(0.6, 0.9, h) * (1.0 - smoothstep(1.8, 2.1, h)) * K_mussels * smoothstep(0.45, 0.65, fbm3(q * 8.0 + 4.0));
  if (barnacleZone > 0.01) {
    vec2 id;
    vec2 at;
    vec2 v = tpCells(q * 110.0, 0.85, id, at);
    float shell = smoothstep(0.42, 0.3, v.x) * step(hash12(id), barnacleZone * 0.8);
    vec3 cone = mix(vec3(0.6, 0.58, 0.52), vec3(0.22, 0.2, 0.17), smoothstep(0.14, 0.04, v.x));
    c = mix(c, cone, shell * 0.8);
  }
  // Mussels: blue-black shells packed in clumps, the odd goose barnacle.
  float musselZone = smoothstep(-0.6, -0.2, h) * (1.0 - smoothstep(0.9, 1.3, h)) * smoothstep(0.42, 0.55, fbm3(q * 14.0 + 1.0) + 0.2 * K_mussels) * step(0.05, K_mussels);
  if (musselZone > 0.01) {
    vec2 id;
    vec2 at;
    vec2 local = rotate(q * 75.0, 0.8 * sin(q.x * 9.0));
    vec2 v = tpCells(local * vec2(1.0, 1.7), 0.9, id, at);
    float shell = smoothstep(0.08, 0.2, v.y);
    vec3 m = mix(vec3(0.02, 0.025, 0.05), vec3(0.12, 0.14, 0.22), smoothstep(0.5, 0.0, v.x)) * (0.8 + 0.4 * hash12(id));
    m = mix(m, vec3(0.5, 0.45, 0.38), (1.0 - shell) * 0.4);
    c = mix(c, m, musselZone);
    gloss = mix(gloss, 0.7, musselZone);
  }
  // Coralline crust and red turf where the water stays: the pool and the low shore.
  float wetZone = max(smoothstep(0.1, 0.6, site.y), 1.0 - smoothstep(-0.8, -0.2, h));
  float crust = wetZone * smoothstep(0.35, 0.55, fbm3(q * 12.0 + 7.0) * (0.6 + 0.6 * K_coralline));
  c = mix(c, mix(vec3(0.78, 0.42, 0.5), vec3(0.92, 0.66, 0.68), grain), crust * 0.85);
  c = mix(c, vec3(0.42, 0.14, 0.16), wetZone * (1.0 - crust) * smoothstep(0.55, 0.7, fbm3(q * 40.0 + 2.0)) * 0.7 * K_coralline);
  // Sand settles on the basin's floor, in its deepest hollows.
  float sand = smoothstep(2.6, 3.6, site.y) * site.z * smoothstep(0.45, 0.6, mottle);
  c = mix(c, vec3(0.7, 0.62, 0.46) * (0.85 + 0.25 * grain), sand);
  return c;
}

// Sea lettuce: bright, thin, ruffled sheets on the pool's shallower floor that lift and flutter in
// a current. Coverage 0..1.
float tpLettuce(vec2 q, vec4 site, vec2 flow, float tm) {
  if (K_lettuce <= 0.0 || site.y < 0.3 || site.y > 2.8 || site.z < 0.3) return 0.0;
  vec2 warp = flow * 0.0006 * (1.0 + sin(tm * 1.7 + q.x * 40.0));
  float sheet = fbm3((q - warp) * 26.0 + 11.0);
  return smoothstep(0.66 - 0.18 * K_lettuce, 0.7 - 0.18 * K_lettuce, sheet);
}

// The Manifold M of white quartz pebbles laid on the bed.
float tpMark(vec2 q, float aspect, out vec3 col) {
  col = vec3(0.0);
  if (K_mark <= 0.0) return 0.0;
  vec2 at = vec2(K_markX * aspect, K_markY);
  float size = 0.12 + 0.2 * K_mark;
  vec2 m = (q - at) / size;
  if (markDistance(m) > 0.14) return 0.0;
  vec2 id;
  vec2 site;
  vec2 v = tpCells(m * 16.0, 0.75, id, site);
  if (markDistance(site / 16.0) > 0.075) return 0.0;
  float pebble = smoothstep(0.42, 0.3, v.x);
  col = mix(vec3(0.82, 0.8, 0.74), vec3(0.98, 0.96, 0.9), hash12(id)) * (0.8 + 0.2 * smoothstep(0.4, 0.0, v.x));
  return pebble;
}

// The rock pool fish (life.ts, sims/fish.ts) over the bed: a soft shadow cast away from the light,
// then the fish, mottled olive and sand with a pale fringe on its fins, the tail beating at the
// phase the sim keeps (tag.x).
void tpFish(vec2 q, inout TpBed b) {
  int count = int(K_fish + 0.5);
  for (int i = 0; i < TP_FISH_MAX; i++) {
    if (i >= count) break;
    FishPose f = fishPose(uSim3, i);
    if (f.len <= 0.0) continue;
    vec2 rel = q - f.at;
    if (dot(rel, rel) > f.len * f.len * 2.5) continue;
    vec2 side = vec2(-f.dir.y, f.dir.x);
    vec2 rs = rel + tpLight.xy * 0.4 * f.len;
    if (fishTop(vec2(dot(rs, f.dir), dot(rs, side)), f.len, f.tag.x, FISH_BLENNY) > 0.5) b.albedo *= 0.62;
    vec2 l = vec2(dot(rel, f.dir), dot(rel, side));
    float shape = fishTop(l, f.len, f.tag.x, FISH_BLENNY);
    if (shape <= 0.0) continue;
    float mottle = vnoise(l / f.len * 7.0 + float(i) * 13.0);
    vec3 coat = mix(vec3(0.24, 0.22, 0.12), vec3(0.62, 0.55, 0.36), smoothstep(0.35, 0.7, mottle));
    b.albedo = shape > 1.5 ? mix(coat, vec3(0.7, 0.66, 0.5), 0.35) : coat;
    if (fishTopEye(l, f.len)) b.albedo = vec3(0.05);
    b.tilt = vec2(0.0);
    b.gloss = 0.35;
    b.accent = 0.0;
  }
}

// Everything the bed shows at q: rock and its zones, then the life on it.
TpBed tpBedAt(vec2 q, vec2 uv, float aspect, float tm, float foot) {
  vec4 site = texture(uSim2, uv);
  TpBed b;
  b.albedo = tpRock(q, site, foot, b.gloss);
  b.tilt = vec2(0.0);
  b.accent = 0.0;
  vec2 flow = tpFlow(uv);
  float sheet = tpLettuce(q, site, flow, tm);
  if (sheet > 0.0) {
    b.albedo = mix(b.albedo, vec3(0.42, 0.82, 0.32) * (0.85 + 0.3 * fbm3(q * 80.0)), sheet);
    b.gloss = mix(b.gloss, 0.6, sheet);
  }
  vec3 pebbles;
  float mark = tpMark(q, aspect, pebbles);
  if (mark > 0.5) {
    b.albedo = pebbles;
    b.gloss = 0.5;
    b.accent = 0.35;
  }
  tpStarsAndUrchins(q, aspect, foot, b);
  if (K_fronds > 0.0 || K_surfgrass > 0.0) tpFronds(q, aspect, tm, foot, b);
  if (K_anemones > 0.0) {
    // The anemones are rooted (life.ts), one per lattice cell where one fits; the knob shows them by
    // rank (b), and each leans with the flow on its own spring (its record's lean).
    ivec4 life = tpLife();
    ivec2 cell = ivec2(floor(q / TP_ANEMONE_GRID));
    if (cell.x >= 0 && cell.y >= 0 && cell.x < life.w) {
      PlantOrgan o = plantOrgan(uSim3, life.y, life.z * TP_FROND_ROWS * TP_BLADES + cell.y * life.w + cell.x);
      if (o.tier > 0.5 && o.b < K_anemones * 0.8) {
        vec2 atUv = o.at / vec2(aspect, 1.0);
        // Closed out of water, at a surge or a touch (agitation), and while the scene arrives or leaves.
        float exposed = 1.0 - smoothstep(0.15, 0.6, texture(uSim0, atUv).x);
        float startled = smoothstep(0.15, mix(1.0, 0.35, K_shyness), texture(uSim1, atUv).y);
        float open = (1.0 - max(exposed, startled)) * tpOpen;
        tpAnemone(q, o.at, o.len, 2.1, open, clamp(o.dir + tpLean, vec2(-0.6), vec2(0.6)), o.a, tm, foot, b);
      }
    }
  }
  if (K_fish > 0.0) tpFish(q, b);
  return b;
}

// ---- passage --------------------------------------------------------------------------------------

// The white water of a wave washing over the platform: entering, the last of one draining back to
// the sea up the frame; leaving, one breaking in from the sea and sweeping down across everything.
// 0..1 coverage (before the per-cell cut), and the wash's direction of flow.
float tpWash(vec2 q, float aspect, float tm, out vec2 flow) {
  float pin = passageIn();
  float pout = passageOut();
  flow = vec2(0.0);
  if (pin >= 1.0 && pout <= 0.0) return 0.0;
  float tin = pin * TP_ENTER;
  float tout = pout * TP_EXIT;
  float lace = fbm3(q * vec2(26.0, 14.0) + vec2(0.0, tm * 0.4));
  float edge = 0.08 * (fbm3(vec2(q.x * 5.0, 2.0)) - 0.5);
  float cover = 0.0;
  if (pin < 1.0) {
    // The front draws back up the frame from the start, quick at first and slowing, gone by 2.6 s.
    float drain = 1.0 - clamp(tin / 2.6, 0.0, 1.0);
    float front = mix(1.2, -0.15, drain * drain);
    float behind = smoothstep(front - 0.02, front + 0.12, q.y + edge);
    cover = behind * mix(0.55, 1.0, smoothstep(front + 0.35, front + 0.05, q.y)) * smoothstep(0.25, 0.65, lace + 0.25 * behind);
    flow = vec2(0.0, 0.5) * drain * drain;
  }
  if (pout > 0.0) {
    // A wave from the sea, the white water behind its front: the front sweeps down the frame from
    // 0.05 s, gathering speed, and covers it just as the exit ends.
    float sweep = clamp((tout - 0.05) / (TP_EXIT - 0.05), 0.0, 1.0);
    float front = mix(1.2, -0.06, sweep * sweep);
    float behind = smoothstep(front - 0.1, front + 0.02, q.y - edge);
    cover = max(cover, behind * smoothstep(0.3, 0.6, lace + 0.3 * behind));
    flow = vec2(0.0, -0.7) * smoothstep(0.0, 0.5, tout);
  }
  return cover;
}

// ---- the scene ----------------------------------------------------------------------------------

Shade sceneTidepool(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 q = uv * vec2(aspect, 1.0);
  float tm = uMotionTime;
  float foot = 1.0 / uRes.y;
  if (uSimOn.z < 0.5) return shadeOf(vec3(0.02, 0.06, 0.07), 0.05, 0.0);

  // Light: the shared sky, turned to look straight down (the frame's up is the sky's "ahead").
  tpSky = skyAt(timeOfDayM(K_time, skyDays()));
  float rain = K_rain;
  float storm = weatherOvercast(rain, 0.0);
  bool moonlit = tpSky.sun.y < -0.04;
  vec3 body = moonlit ? tpSky.moon : tpSky.sun;
  tpLight = normalize(vec3(body.x, body.z, max(body.y, 0.05)));
  tpLightCol = (moonlit ? tpSky.moonColor * 1.4 : tpSky.sunColor * 1.15) * (1.0 - 0.75 * storm);
  tpAmbient = greyed(tpSky.ambient, vec3(0.95, 0.98, 1.04), 0.4 * storm) * 0.9;

  // Passage: the anemones unfurl as the wash drains away (quick at first, settling open by 2.8 s), and
  // snap shut as the wave comes in.
  float pin = passageIn();
  float pout = passageOut();
  float furled = 1.0 - clamp(pin * TP_ENTER / 2.8, 0.0, 1.0);
  tpOpen = (1.0 - furled * furled) * (1.0 - smoothstep(0.0, 0.6, pout * TP_EXIT));
  vec2 washFlow;
  float wash = tpWash(q, aspect, tm, washFlow);
  tpLean = washFlow;

  vec4 water = texture(uSim0, uv);
  vec4 carried = texture(uSim1, uv);
  float depth = water.x;
  float wetness = max(carried.z, uWeather.x);

  // The surface: the sim's slope (exaggerated to the frame) plus the wind ripples and rain rings.
  vec3 hessian;
  float breeze = 0.02 + 0.07 * K_ripples;
  vec2 ripple = causticRipples(q, tm, normalize(vec2(0.8, 0.6)), 0.075, breeze, 0.32, foot, hessian);
  vec3 rings = rain > 0.0 ? rainRipples(q * TP_METRES * 2.5, uFallTime, rain) : vec3(0.0);
  vec2 slope = water.yz * TP_RELIEF + ripple + rings.xy * 0.25;
  float d = depth * TP_DEPTH;
  bool wet = depth > 0.02;

  // The bed, where the water shows it: shifted by the refraction, a quarter of the depth per slope.
  vec2 seen = wet ? q + slope * d * 0.25 : q;
  vec2 seenUv = seen / vec2(aspect, 1.0);
  TpBed bed = tpBedAt(seen, seenUv, aspect, tm, foot);
  vec3 g = heightGrad(uSim2, seenUv, 1.0 / vec2(textureSize(uSim2, 0)));
  vec2 bedSlope = vec2(g.y / aspect, g.z) / TP_ROWS * TP_RELIEF * 0.6;
  vec3 n = normalize(vec3(-bedSlope + bed.tilt, 1.0));
  float sunUp = max(dot(n, tpLight), 0.0);

  // Shadows of the rock toward the light: a short march over the bed's heights, the ray rising
  // tan(elevation) per unit along (in cells of height: ROWS / RELIEF per frame height).
  float shade = 1.0;
  float flat_ = max(length(tpLight.xy), 1e-3);
  vec2 toward = tpLight.xy / flat_ / vec2(aspect, 1.0);
  float rise = tpLight.z / flat_ * TP_ROWS / TP_RELIEF;
  for (int i = 1; i <= 6; i++) {
    float along = float(i) * 0.01;
    float h = texture(uSim2, seenUv + toward * along).x;
    shade = min(shade, 1.0 - smoothstep(0.0, 0.6, h - g.x - along * rise));
  }
  shade = mix(1.0, shade, 0.8);

  vec3 col;
  float ink;
  if (wet) {
    // Caustics: the swell's focus times the ripples', softened; the light dims as it goes down.
    float light = 1.0;
    if (K_caustics > 0.0) {
      light = mix(1.0, waterCaustic(hessian, d, water.w, 0.22), K_caustics * smoothstep(0.004, 0.02, d));
    }
    vec3 through = exp(-TP_ABSORB * d * 2.0);
    vec3 down = exp(-TP_ABSORB * d);
    vec3 lit = tpAmbient * 0.75 + tpLightCol * sunUp * shade * light * down;
    col = bed.albedo * lit * exp(-TP_ABSORB * d);
    col += TP_WATER * (tpAmbient + tpLightCol * 0.6) * (1.0 - through.g);
    // The sky on the surface, and the sun's glints on facets turned to it.
    vec3 sn = normalize(vec3(-slope, 1.0));
    vec3 view = vec3(0.0, 0.0, 1.0);
    vec3 mirror = reflect(-view, sn);
    float fresnel = fresnelSchlick(dot(sn, view), 0.02, 0.0);
    vec3 skyCol = greyed(skyColor(tpSky, normalize(vec3(mirror.x, mirror.z, mirror.y))), vec3(1.0), storm * 0.6);
    col = mix(col, skyCol, fresnel * 2.0);
    float glint = pow(max(dot(sn, normalize(tpLight + view)), 0.0), 900.0) * 6.0 * K_glints * (1.0 - storm);
    col += tpLightCol * glint;
    col += vec3(0.8, 0.9, 1.0) * rings.z * 0.35 * (tpAmbient.g + 0.2);
    ink = 0.0;
  } else {
    // Bare rock: wet rock darker and glossier, drying from the edges; rain splashes on it.
    vec3 albedo = wetten(bed.albedo, wetness, 0.2);
    col = albedo * (tpAmbient + tpLightCol * sunUp * shade);
    float gloss = wetGloss(wetness, n.z) * (0.4 + bed.gloss);
    col += tpLightCol * pow(max(dot(n, normalize(tpLight + vec3(0.0, 0.0, 1.0))), 0.0), 60.0) * gloss * 0.6;
    if (rain > 0.0) col += vec3(0.75, 0.8, 0.85) * (tpAmbient.g + 0.15) * rainSplashes(q * TP_METRES, uFallTime, rain);
    ink = 0.0;
  }

  // White water: the sim's foam laced into bubbles and streaks, cut per cell.
  float foam = carried.x;
  if (foam > 0.02) {
    vec2 drift = water.yz / TP_ROWS;
    float lace = fbm3(q * vec2(70.0, 70.0) - drift * 0.4 + vec2(0.0, tm * 0.05));
    float cover = smoothstep(0.75, 0.35, lace + 0.45 - foam * 0.7) * smoothstep(0.02, 0.15, foam);
    vec3 white = vec3(0.92, 0.96, 0.97) * (tpAmbient + tpLightCol * 0.9);
    col = mix(col, white, hardEdge(cover * 0.95));
  }
  // Bioluminescence: at night the surf and every touch glow blue.
  if (K_glow > 0.0) {
    float glow = (smoothstep(0.05, 0.6, foam) + 0.6 * carried.y * step(0.02, depth)) * K_glow * tpSky.night;
    col += vec3(0.1, 0.55, 1.0) * glow * 0.8;
  }
  // The passage's wash over everything.
  if (wash > 0.0) {
    vec3 white = vec3(0.9, 0.95, 0.96) * (tpAmbient + tpLightCol * 0.9);
    col = mix(col, white, hardEdge(wash, edgeThreshold(cell, vec2(5.0, 3.0))));
  }

  // Rain falling past the camera toward the rock, its streaks converging on the point below.
  if (rain > 0.0) {
    vec3 dir = rainFallDir(rain, 0.0);
    vec3 vanish = rainVanish(dir, vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, -1.0, 0.0), 1.2);
    Precip pr = rainFallSeen(uv, aspect, tm, uFallTime, rain, 0.0, 1.0 - exp(-3.5 / 30.0), vanish);
    vec3 air = vec3(dot(tpAmbient, LUMA)) * vec3(0.95, 0.98, 1.0);
    vec3 drop = max(air * 1.2, vec3(0.08));
    col = precipOver(col, air, drop * (1.0 - 0.2 * pr.near), pr);
  }

  float accent = wet ? bed.accent * exp(-TP_ABSORB.r * d * 0.5) : bed.accent;
  Shade o = shadeOf(col, inkOf(col, 1.6, 0.8), accent);
  o.shimmer = wet ? 0.08 * smoothstep(0.02, 0.2, d) : 0.0;
  return o;
}
`;
