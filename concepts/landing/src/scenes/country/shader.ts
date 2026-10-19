// The countryside: the terrain toolbox's landscape (sims/terrain.ts through shaders/lib/terrain.ts)
// seen from its vantage, ray-marched as a height field in metres under the World's sky and weather;
// the code of every country layer (layers.ts), one chunk the composer compiles in once (COUNTRY,
// composer/outdoor-code.ts), and the valley's passes that draw it all.
//
// World frame: map metres, x east, z north, y up. The camera stands at the vantage (the records'
// eye) looking along COUNTRY_HEADING, level, through the rig's pinhole (the hill's own, camera.ts and
// constants.ts COUNTRY_RIG; or a guest's, the bees garden's); what stands on the land is placed
// through the same pinhole, its focal length the rig's. The World's sky is turned into the camera's
// frame by the rig's turn (0 on the hill), so the sun sets where the sky shows it and lights the land
// from there.
//
// What a ray meets, nearest first: a walker or cart on the roads (life.ts), a clump of the verges at
// a hedge's foot (verges.ts), a building (modelled near, the shared sprite far, the castle always
// modelled: buildings.ts, castle.ts), the stone bridge (a box with an arch), or the land. The march
// meets the ground or the water over it, or the trees' bounds; near enough, the trees are whole
// crowns found at the hit (trees.ts), and a ray passing between them goes on to the ground. On the
// ground: each parcel as the land model (sims/landuse.ts) uses it, read from its record
// (terrainParcel): crops of its kind as the time of year has them (season.ts: the composer's
// season, carried round while the year passes; the harvest's bales too), a flower field (the shared
// fields' materials, shaders/lib/fields.ts), a pasture with its fence and herd (life.ts), the floor of
// a wood, or open grassland; hedges where a farmed parcel meets another, roads (their snow trodden
// where walkers and carts go: trodden.ts), yards and streams (dry while the river is off), the chalk
// M on its hillside (chalk.ts). The river mirrors the World's sky, ruffled by the wind (ripples.ts).
// The starling murmuration wheels over the far fields at dusk (murmuration.ts). The snow lying on the
// land is the renderer's uWeather.y, which deep winter lays by itself. The valley fog lies in the
// valley along the river's level and is seen through along each ray, to the land, the far ridges and
// the sky (fog.ts).
//
// The World's (ADR 0062 D10): the sky (its dome, deck, cumulus, stars, Milky Way, planets, shooting
// stars and lightning), over which the valley stages its far ridges; the light (the composer's, the
// World's sky under its deck; a guest rig's grade warms it); the cloud deck's shadows, cast from the
// countryside's own 900 m deck (worldSunlit at the point scaled to the World's base); the rain and
// snow, falling at the composed depth into the valley's air; the birds (the preset's flyway). The
// valley's own: its haze, its aerial perspective, the valley fog (the World's fog knob, x.w.fog put
// out on the hill), the water's mirror of the sky, the lit windows and smoke.
//
// Each layer's part is compiled in while its knobs can show it (the valley's featuresFor), and read
// through the valley's macros (VALLEY_*: its layer's knob while it is placed, nothing while it is
// not, the countryside's own where it is not offered: a guest valley shows the default countryside).
import type { Rig } from "../../composer/types.ts";
import { buildingsGlsl } from "../../shaders/buildings.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { fieldsGlsl } from "../../shaders/lib/fields.ts";
import { figuresGlsl } from "../../shaders/lib/figures.ts";
import { livestockGlsl } from "../../shaders/lib/livestock.ts";
import { terrainGlsl } from "../../shaders/lib/terrain.ts";
import { treesGlsl } from "../../shaders/lib/trees.ts";
import { countryBuildingsGlsl } from "./buildings.ts";
import { COUNTRY_CAMERA } from "./camera.ts";
import { countryChalkGlsl } from "./chalk.ts";
import { COUNTRY_RIG } from "./constants.ts";
import { countryFogGlsl } from "./fog.ts";
import { VALLEY_KNOBS } from "./layers.ts";
import { countryLifeGlsl } from "./life.ts";
import { countryMurmurationGlsl } from "./murmuration.ts";
import { countryRipplesGlsl } from "./ripples.ts";
import { countrySeasonGlsl } from "./season.ts";
import { COUNTRY_MAP } from "./sim.ts";
import { countryTreesGlsl, countryWoodsGlsl } from "./trees.ts";
import { countryVergesGlsl } from "./verges.ts";
import { countryTroddenGlsl } from "./trodden.ts";

/**
 * The ray march's numbers: the height it starts from (and the shadows' ceiling), metres a rising ray
 * climbs over the map's highest ground and trees before it is let go (the records' half floats
 * round terrainTop within a quarter metre), farthest look, slope bound, shortest steps (minStep +
 * relStep · distance), the step after which the shortest step grows by `growth` a step, most steps,
 * and regula-falsi steps refining the one that crossed the land. A ray grazing the land toward the
 * far hills under the skyline may take more than `late` steps; the growing floor then carries any
 * ray past `far` within `steps` whatever the land under it, so none runs out of steps (to be drawn
 * where it stopped, in the air), and a ray that meets the land sooner marches as it always did.
 * march.test.ts holds a CPU mirror of countryMarch to a dense march over the bare land and its ring
 * (COUNTRY_RING), and that bound.
 */
export const COUNTRY_MARCH = {
  top: 520,
  headroom: 2,
  far: 7000,
  slope: 0.85,
  minStep: 1.5,
  relStep: 0.006,
  late: 176,
  growth: 1.1,
  steps: 224,
  refine: 2,
} as const;

/**
 * The ring of hills beyond the map (countryRing), out to COUNTRY_MARCH.far: metres past the edge it
 * rises over, the noise's scale (metres), and how far it rolls either way, over the edge's height
 * under the map's highest ground. So a view turned off the map's diagonal (or a vantage moved) meets
 * land, not the sky, past its edge: every heading has land out to the farthest look.
 */
export const COUNTRY_RING = { rise: 600, scale: 1400, relief: 0.6 } as const;

/**
 * How far out a guest's garden ends (m over its floor): from the bees garden's eye the lawn's hedge
 * stands there, and the valley's land beyond it, seen from the vantage's hilltop.
 */
const GUEST_GARDEN = 20;

/**
 * How far into the valley the World's rain and snow reach on the hill (metres: what weatherDepth's
 * 30 m stands for, valleyAir): rain as far as the countryside's own did; snow farther than its own
 * 450 m, so the land reads through a snowfall under the World's greyer light about as well as it did
 * through the countryside's own under its brighter one.
 */
const COUNTRY_PRECIP_REACH = { rain: 650, snow: 1200 } as const;

/** Whether `rig` is the hill's own (the countryside's), else a guest's (the bees garden's). */
function onTheHill(rig: Rig): boolean {
  return (
    rig.horizon === COUNTRY_RIG.horizon &&
    rig.focal === COUNTRY_RIG.focal &&
    rig.eye === COUNTRY_RIG.eye &&
    rig.turn === COUNTRY_RIG.turn
  );
}

/** The valley's knob macros (layers.ts VALLEY_KNOBS): its part's knob, nothing, or the guest's default. */
const knobMacros = VALLEY_KNOBS.map(
  ({ macro, key, gate, guest }) => `#ifndef ${gate}
#define ${macro} ${glslFloat(guest)}
#elif ${gate}
#define ${macro} K_${key}
#else
#define ${macro} 0.0
#endif`,
).join("\n");

/**
 * The countryside's GLSL for the rig it is drawn through (composer/outdoor-code.ts COUNTRY): the
 * libraries, the march and everything it finds, the valley's per-cell state and its passes' shading.
 */
export function countryGlsl(rig: Rig): string {
  const home = onTheHill(rig);
  // The field of view: the hill's own exactly (its rays as the countryside always cast them).
  const fov = home ? COUNTRY_CAMERA.fov : 2 * Math.atan(0.5 / rig.focal);
  return /* glsl */ `
// ---- the countryside (country/shader.ts) ----
// Drawn through the hill's own rig (1), or a guest's (0: the bees garden's, its lawn on the hilltop).
#define COUNTRY_HOME ${home ? 1 : 0}
// The verges' and the starlings' gates are their layers' (layers.ts): none where they are not offered.
#ifndef COUNTRY_HAS_VERGES
#define COUNTRY_HAS_VERGES 0
#endif
#ifndef COUNTRY_HAS_MURMURATION
#define COUNTRY_HAS_MURMURATION 0
#endif
${
  home
    ? ""
    : `// A guest's valley: the parts whose layers are drawn through the hill's rig alone (the pastures and
// their herds, the walkers and carts, the flower fields, the chalk M, the wind ripples) are not
// there, nor the harvest's bales, too small that far off; the woods stand whole, as the hill sees
// its far canopy (no crowns); the World's own fog lies over the garden and the valley alike (no
// valley fog).
#undef COUNTRY_HAS_FOG
#define COUNTRY_HAS_FOG 0
#undef COUNTRY_HAS_HERDS
#define COUNTRY_HAS_HERDS 0
#undef COUNTRY_HAS_AGENTS
#define COUNTRY_HAS_AGENTS 0
#undef COUNTRY_HAS_FIELDS
#define COUNTRY_HAS_FIELDS 0
#undef COUNTRY_HAS_CHALK
#define COUNTRY_HAS_CHALK 0
#undef COUNTRY_HAS_BALES
#define COUNTRY_HAS_BALES 0
`
}${terrainGlsl}
${buildingsGlsl}
${treesGlsl}
#if COUNTRY_HAS_FIELDS
${fieldsGlsl}
#endif
#if COUNTRY_HAS_HERDS
${livestockGlsl}
#endif
#if COUNTRY_HAS_AGENTS
${figuresGlsl}
#endif
// The valley's parts' knobs (layers.ts VALLEY_KNOBS): each its layer's while it is placed, 0 while
// it is not, the countryside's own where its layer is not offered (a guest valley).
${knobMacros}
const float COUNTRY_EXTENT = ${glslFloat(COUNTRY_MAP.extent)};
const float COUNTRY_HORIZON = RIG_HORIZON;
const float COUNTRY_FOV = ${glslFloat(fov)};
const float COUNTRY_FOCAL = RIG_FOCAL;   // viewRay's, screen heights
const vec2 COUNTRY_HEADING = vec2(0.70710678, 0.70710678);
const float COUNTRY_CLOUD_BASE = 900.0;  // the cloud deck over the eye, metres
const float COUNTRY_FIELD_UNIT = 60.0;   // metres a unit of the shared fields' materials (rows, patches)
const float COUNTRY_TOP = ${glslFloat(COUNTRY_MARCH.top)};
const float COUNTRY_FAR = ${glslFloat(COUNTRY_MARCH.far)};
const vec3 COUNTRY_AMBER = vec3(1.0, 0.7, 0.3);
const vec3 COUNTRY_SNOW = vec3(0.9, 0.92, 0.95);

// The camera's frame on the map (level): right, forward.
vec3 countryRight;
vec3 countryFwd;
// What falls now (x rain, y snow): the World's (worldAt: the knobs as the climate turns them at this
// time of year, a winter's rain falling as snow). Set by valleyBegin.
vec2 countryFall = vec2(0.0);
// The surfaces' light (valleyBegin): the composer's, the sun's (none once the moon is a guest
// grade's key: the valley keeps its own moonlit night) and the sky's.
vec3 countrySunLight;
vec3 countryAmbient;

// Camera frame -> world, and back.
vec3 countryToWorld(vec3 d) {
  return countryRight * d.x + vec3(0.0, d.y, 0.0) + countryFwd * d.z;
}
vec3 countryToCamera(vec3 d) {
  return vec3(dot(d, countryRight), d.y, dot(d, countryFwd));
}

${countryWoodsGlsl}
${countrySeasonGlsl}
${countryTreesGlsl}

// The land beyond the map, out to COUNTRY_FAR (COUNTRY_RING): metres past the map's edge (0 on it).
float countryBeyond(vec2 p) {
  return length(max(max(-p, p - COUNTRY_EXTENT), 0.0));
}

// The land beyond the map at p: (ground, water level). The map's edge carried straight out, rolling
// into hills over the first COUNTRY_RING.rise metres (three octaves of noise COUNTRY_RING.scale
// across, as far either way as COUNTRY_RING.relief of the edge's height under the map's highest
// ground, and never above that, which the march's ceiling holds), the edge's water carried out at
// its level where the land lies under it: the sea on, a river up its valley. Unbuilt and unworn:
// one fetch at the edge and the noise.
vec2 countryRing(vec2 p) {
  vec4 edge = terrainGround(valleyField0, clamp(p, vec2(0.0), vec2(COUNTRY_EXTENT)), COUNTRY_EXTENT);
  float top = terrainTop(valleyField3);
  float rise = smoothstep(0.0, ${glslFloat(COUNTRY_RING.rise)}, countryBeyond(p));
  float hills = (fbm3(p / ${glslFloat(COUNTRY_RING.scale)}) - 0.5) * ${glslFloat(COUNTRY_RING.relief)} * max(top - edge.x, 0.0);
  float ground = min(edge.x + rise * hills, top);
  return vec2(ground, edge.y > edge.x ? edge.y : ground - 1.0);
}

// The land and what stands on it (metres): the trees' bounds for the march, their rounded tents for
// the sun's shadows (countryCanopy); beyond the map, its ring of hills.
float countryHeight(vec2 p, bool bound) {
  if (countryBeyond(p) > 0.0) {
    vec2 ring = countryRing(p);
    return max(ring.x, ring.y);
  }
  vec4 g = terrainGround(valleyField0, p, COUNTRY_EXTENT);
  vec4 c = terrainCover(valleyField1, p, COUNTRY_EXTENT);
  return terrainSurface(g) + countryCanopy(p, c, terrainWater(g), bound);
}

// March the land from the eye (slope-bound steps, never shorter than a share of the distance, a
// growing share once the march runs late: COUNTRY_MARCH), then refine the crossing step by regula
// falsi on the gaps either side of it, keeping the stretch that holds the crossing (a point on the
// land counts as above it, so the gap below never reaches 0). A rising ray is let go once above all
// on the map and its ring: the map's highest ground or water (terrainTop) and the trees' bounds
// over it, with COUNTRY_MARCH.headroom; never higher than it starts from, COUNTRY_TOP.
// -1: sky.
float countryMarch(vec3 ro, vec3 rd) {
  float t = 0.0;
  if (ro.y > COUNTRY_TOP) {
    if (rd.y >= 0.0) return -1.0;
    t = (ro.y - COUNTRY_TOP) / -rd.y;
  }
  float ceiling = min(COUNTRY_TOP, terrainTop(valleyField3) + max(COUNTRY_WOOD_TOP, COUNTRY_LONE_TOP) + ${glslFloat(COUNTRY_MARCH.headroom)});
  float last = t;
  float above = 0.0;
  float below = 0.0;
  float grow = 1.0;
  bool hit = false;
  for (int i = 0; i < ${COUNTRY_MARCH.steps}; i++) {
    vec3 p = ro + rd * t;
    float gap = p.y - countryHeight(p.xz, true);
    if (gap < 0.0) {
      below = gap;
      hit = true;
      break;
    }
    if (rd.y >= 0.0 && p.y > ceiling) return -1.0;
    last = t;
    above = gap;
    float least = ${glslFloat(COUNTRY_MARCH.relStep)} * t + ${glslFloat(COUNTRY_MARCH.minStep)};
    if (i >= ${COUNTRY_MARCH.late}) {
      grow *= ${glslFloat(COUNTRY_MARCH.growth)};
      least *= grow;
    }
    t += max(gap / (${glslFloat(COUNTRY_MARCH.slope)} + abs(rd.y)), least);
    if (t > COUNTRY_FAR) return -1.0;
  }
  if (!hit) return t;
  float lo = last;
  float hi = t;
  for (int i = 0; i < ${COUNTRY_MARCH.refine}; i++) {
    float mid = lo + (hi - lo) * above / (above - below);
    vec3 p = ro + rd * mid;
    float gap = p.y - countryHeight(p.xz, true);
    if (gap >= 0.0) {
      lo = mid;
      above = gap;
    } else {
      hi = mid;
      below = gap;
    }
  }
  return lo + (hi - lo) * above / (above - below);
}

// How many steps the ground behind a tree's bound takes at most (countryBehind), how many points
// along the way it looks at for an earlier meeting with the land, and the most march steps a ray
// running along the land takes instead.
const int COUNTRY_BEHIND_STEPS = 8;
const int COUNTRY_BEHIND_LOOKS = 8;
const int COUNTRY_BEHIND_MARCH = 48;

// The ground a ray reaches beyond a tree's bound it met at t (point p, ground g under it) without
// meeting a crown there. Newton's steps along the ray onto the land, each taking the ground as flat
// at the last point (height and slope g) and stepping to where the ray meets that plane; once a
// step has gone below the land, kept within the stretch known to hold the crossing (bisected where
// a step would leave it). A ray running along the land (the plane meets it far off, or behind)
// that is still above it after them is marched on over the bare land as countryMarch marches, then
// bisected. A step may have passed over a crest the ray meets first: points along the way are
// looked at, and the first below the land is bisected back to the crossing before it. A single flat
// step lands as far off as the ground bends over the tens of metres a shallow ray travels down
// through a 12 m bound: the land seen between the crowns was drawn displaced, in a halo round each
// tree.
float countryBehind(vec3 ro, vec3 rd, float t, vec3 p, vec4 g) {
  float start = t;
  float lo = t;
  float hi = -1.0;
  for (int i = 0; i < COUNTRY_BEHIND_STEPS; i++) {
    float gap = p.y - terrainSurface(g);
    if (abs(gap) < 0.01) break;
    if (gap > 0.0) lo = t;
    else hi = t;
    float fall = dot(g.zw, rd.xz) - rd.y;
    float next = fall > 0.02 ? t + gap / fall : -1.0;
    if (hi > 0.0) {
      if (next <= lo || next >= hi) next = 0.5 * (lo + hi);
    } else if (next <= t) {
      next = t + max(gap / (${glslFloat(COUNTRY_MARCH.slope)} + abs(rd.y)), 0.05);
    }
    t = next;
    p = ro + rd * t;
    g = terrainGround(valleyField0, p.xz, COUNTRY_EXTENT);
  }
  if (hi < 0.0 && p.y - terrainSurface(g) > 0.05) {
    float last = t;
    for (int i = 0; i < COUNTRY_BEHIND_MARCH; i++) {
      float gap = p.y - terrainSurface(g);
      if (gap < 0.0) {
        hi = t;
        break;
      }
      last = t;
      t += max(gap / (${glslFloat(COUNTRY_MARCH.slope)} + abs(rd.y)), ${glslFloat(COUNTRY_MARCH.relStep)} * t + ${glslFloat(COUNTRY_MARCH.minStep)});
      p = ro + rd * t;
      g = terrainGround(valleyField0, p.xz, COUNTRY_EXTENT);
    }
    if (hi > 0.0) {
      float a = last;
      for (int k = 0; k < 10; k++) {
        float mid = 0.5 * (a + hi);
        vec3 m = ro + rd * mid;
        if (m.y < terrainSurface(terrainGround(valleyField0, m.xz, COUNTRY_EXTENT))) hi = mid;
        else a = mid;
      }
      t = 0.5 * (a + hi);
    }
  }
  float look = (t - start) / float(COUNTRY_BEHIND_LOOKS);
  for (int i = 1; i < COUNTRY_BEHIND_LOOKS; i++) {
    float s = start + look * float(i);
    vec3 q = ro + rd * s;
    if (q.y < terrainSurface(terrainGround(valleyField0, q.xz, COUNTRY_EXTENT))) {
      float a = s - look;
      float b = s;
      for (int k = 0; k < 10; k++) {
        float mid = 0.5 * (a + b);
        vec3 m = ro + rd * mid;
        if (m.y < terrainSurface(terrainGround(valleyField0, m.xz, COUNTRY_EXTENT))) b = mid;
        else a = mid;
      }
      return 0.5 * (a + b);
    }
  }
  return t;
}

// Sunlight reaching p over the land: a march toward the light with a soft penumbra.
float countryShadow(vec3 p, vec3 l) {
  if (l.y <= 0.0) return 0.0;
  float lit = 1.0;
  float t = 3.0;
  for (int i = 0; i < 18; i++) {
    vec3 q = p + l * t;
    if (q.y > COUNTRY_TOP) break;
    float gap = q.y - countryHeight(q.xz, false);
    lit = min(lit, 6.0 * gap / t);
    if (lit < 0.01) break;
    t += clamp(gap * 0.7, 2.0 + 0.05 * t, 260.0);
  }
  return clamp(lit, 0.0, 1.0);
}

// Distant ridges beyond the map, as the sky's horizon: (elevation of the near one's top, the far
// one's) at a bearing (radians from straight ahead).
vec2 countryRidges(float bearing) {
  float a = 0.6 * vnoise(vec2(bearing * 3.1, 1.7)) + 0.4 * vnoise(vec2(bearing * 7.3, 4.1));
  float b = 0.6 * vnoise(vec2(bearing * 2.2 + 9.0, 3.3)) + 0.4 * vnoise(vec2(bearing * 5.9, 8.2));
  return vec2(0.012 + 0.03 * a, 0.026 + 0.034 * b);
}

// Light on a surface with normal n (world): the composer's sun (countrySunLight) and the moon with
// a wrap, its sky fill (countryAmbient), a dark-adapted night that stays legible. shade: how much
// sun gets through (shadows, cloud).
vec3 countryLight(Sky sky, vec3 sun, vec3 moon, vec3 n, float shade) {
  float s = clamp((dot(n, sun) + 0.15) / 1.15, 0.0, 1.0) * shade;
  float mo = clamp((dot(n, moon) + 0.2) / 1.2, 0.0, 1.0);
  vec3 adapted = sky.night * (vec3(0.07, 0.09, 0.14) * (0.7 + 0.3 * n.y) + sky.moonColor * (0.35 + 0.65 * mo));
  return countrySunLight * s * 1.1 + countryAmbient * (0.55 + 0.45 * n.y) + adapted;
}

// The bridge: a stone deck from 'from' to 'to' at deck height, its arch's crown under it, standing
// in the water. Distance along the ray to it (-1 none) and its face normal.
float countryBridge(TerrainBridge b, vec3 ro, vec3 rd, out vec3 n, out vec2 local) {
  n = vec3(0.0, 1.0, 0.0);
  local = vec2(0.0);
  if (b.on < 0.5) return -1.0;
  vec2 axis = b.to - b.from;
  float span = length(axis);
  axis /= span;
  vec2 across = vec2(-axis.y, axis.x);
  float deck = max(b.deck0, b.deck1);
  // Into the bridge's frame: u along, v across, y up.
  vec3 o = vec3(dot(ro.xz - b.from, axis), ro.y, dot(ro.xz - b.from, across));
  vec3 d = vec3(dot(rd.xz, axis), rd.y, dot(rd.xz, across));
  vec3 lo = vec3(0.0, b.water - 2.0, -b.halfWidth);
  vec3 hi = vec3(span, deck + 0.9, b.halfWidth);
  vec3 inv = 1.0 / d;
  vec3 t0 = (lo - o) * inv;
  vec3 t1 = (hi - o) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  float enter = max(max(tn.x, tn.y), tn.z);
  float leave = min(min(tf.x, tf.y), tf.z);
  if (leave < max(enter, 0.0)) return -1.0;
  vec3 p = o + d * enter;
  vec3 face = enter == tn.x ? vec3(-sign(d.x), 0.0, 0.0) : (enter == tn.y ? vec3(0.0, -sign(d.y), 0.0) : vec3(0.0, 0.0, -sign(d.z)));
  // Between the parapets the ray goes on down to the roadway.
  if (face.y > 0.5 && abs(p.z) < b.halfWidth - 0.45) {
    float down = (p.y - deck) / max(-d.y, 1e-4);
    enter += down;
    p = o + d * enter;
  }
  // Under the arch (a half ellipse from bank to bank, its crown 1.6 m under the deck) it is open.
  float x = (p.x - 0.5 * span) / (0.5 * span - 1.0);
  float crown = deck - 1.6 - b.water;
  if (abs(x) < 1.0 && p.y < b.water + crown * sqrt(max(1.0 - x * x, 0.0)) && face.y < 0.5) return -1.0;
  local = vec2(p.x, p.y - b.water);
  n = vec3(axis.x * face.x + across.x * face.z, face.y, axis.y * face.x + across.y * face.z);
  return enter;
}

${countryFogGlsl}
${countryBuildingsGlsl}
${countryLifeGlsl}
${countryVergesGlsl}
${countryMurmurationGlsl}
${countryTroddenGlsl}
${countryRipplesGlsl}
${countryChalkGlsl}

// ---- the valley's state for this cell (valleyBegin), its passes' to draw ----
// The screen point in the pinhole's plane at unit distance (x right, y up), a cell there.
vec2 countryQ;
float countryCellAngle;
// The World's sky now, the sun and the moon in the map's frame, the hour, the passage's lift (its
// share of the full lift) and leaving.
Sky countrySky;
vec3 countrySun;
vec3 countryMoon;
float countryTod;
float countryLiftShare;
float countryLeaving;
// The weather as the land takes it: rain's grey, how wet, how much snow lies, the deck's cover, its
// overcast, how dark it is.
float countryGrey;
float countryCover;
float countryOvercast;
float countryDark;
// The ray: in the camera's frame, on the map, its share along the view; the eye; whether the land is
// built; the haze toward this bearing.
vec3 countryDir;
vec3 countryRd;
float countryAhead;
vec3 countryEye;
bool countryMapped;
vec3 countryHaze;
// Below a guest's garden edge: the garden's own ground there, nothing of the valley's.
bool countryUnder;
// What the ray meets (see the header): the march's hit, a crown or the canopy whole, the bridge, the
// buildings and what their windows and chimneys light and smoke along the ray, a verge clump, a
// walker or cart; whether any of them.
float countryHit;
bool countryCrown;
bool countryCanopyHit;
CountryTree countryTree;
vec3 countryCrownN;
float countryCrownUp;
float countryBridgeT;
vec3 countryBridgeN;
vec2 countryBridgeLocal;
CountryFind countryFound;
float countryGlow;
float countryHalo;
float countrySmoke;
#if COUNTRY_HAS_VERGES
CountryVerge countryVerge;
#endif
#if COUNTRY_HAS_AGENTS
Figure countryFigure;
float countryFigureZ;
#endif
bool countryVerged;
bool countryWalking;
bool countryAny;
// How much of what lies along the ray the valley fog lets through (fog.ts), the depth (camera) the
// valley drew this cell at, and the water's glint.
float countryClear;
float countryZ;
float countryGlint;
`;
}

/**
 * The valley's passes (layers.ts valleyLayer), for the rig it is drawn through: the cell's state
 * (begin), the World's sky with the ridges over it (sky), the land and all that stands on it, the
 * lamplight and smoke along the ray, the starlings (far), the valley fog on what flies nearer and the
 * exit's greying (air), the water's shimmer (shade).
 */
export function valleyGlsl(rig: Rig): string {
  const home = onTheHill(rig);
  // Sky frame -> camera frame, and back (the rig's turn; none on the hill).
  const toCamera = (v: string) => (rig.turn === 0 ? v : `skyFacing(${v}, ${glslFloat(-rig.turn)})`);
  const toSky = (v: string) => (rig.turn === 0 ? v : `skyFacing(${v}, RIG_TURN)`);
  return /* glsl */ `
// ---- the valley's passes (country/shader.ts) ----
// The cell's state (see the header) and the valley's air; the World's fog put out on the hill (the
// valley fog is its own, fog.ts), the deck brought down in rain as the countryside had it.
void valleyBegin(inout Ctx x) {
  vec2 uv = x.uv;
  float aspect = x.aspect;
  float pxl = x.aa;
  float tm = x.tm;
${
  home
    ? `  // Entrance and exit (the rig's passage, constants.ts): the eye lifted, the haze over the land.
  countryLiftShare = countryLift();
  countryLeaving = countryLeave();
  x.groundTo = -1.0;
  x.landZ = 0.0;
  x.w.fog = 0.0;
  countryUnder = false;`
    : `  // A guest's rig: the garden's own passage, the valley still; its lawn up to the edge.
  countryLiftShare = 0.0;
  countryLeaving = 0.0;
  x.landZ = ${glslFloat(GUEST_GARDEN)};
  x.groundTo = RIG_HORIZON - x.eye * RIG_FOCAL / x.landZ;
  countryUnder = uv.y < x.groundTo;`
}
  countryQ = vec2((uv.x - 0.5) * aspect, uv.y - COUNTRY_HORIZON) / COUNTRY_FOCAL;
  countryCellAngle = pxl / COUNTRY_FOCAL;
  countryFwd = vec3(COUNTRY_HEADING.x, 0.0, COUNTRY_HEADING.y);
  countryRight = vec3(COUNTRY_HEADING.y, 0.0, -COUNTRY_HEADING.x);
  float wind = x.w.wind;
  // The year the land shows (season.ts), and the rain and snow the World has fall (its climate).
  countryYearSet(SKY_YEAR);
  countryFall = vec2(x.w.rain, x.w.snow);
  float rain = countryFall.x;
  float snow = countryFall.y;
  countryTod = x.w.time;
  Sky sky = x.w.sky;
  countrySky = sky;
  countrySunLight = x.light.moonKey ? vec3(0.0) : x.light.sun;
  countryAmbient = x.light.amb;
  countryGrey = smoothstep(0.0, 0.05, rain);
  countryCover = x.w.cover;
  countryOvercast = smoothstep(0.55, 1.0, countryCover);
  countryDark = clamp(1.0 - smoothstep(-0.12, 0.2, sky.sun.y) + 0.3 * countryOvercast + 0.2 * rain, 0.0, 1.0);
  countrySun = countryToWorld(${toCamera("sky.sun")});
  countryMoon = countryToWorld(${toCamera("sky.moon")});
  x.w.low = 1.0 + 0.8 * rain;

  countryDir = viewRay(uv, aspect, COUNTRY_HORIZON, COUNTRY_FOV);
  countryRd = countryToWorld(countryDir);
  countryAhead = dot(countryRd, countryFwd);
  countryMapped = valleyField0On() && valleyField3On();
  countryEye = countryMapped ? terrainEye(valleyField3) : vec3(200.0, 300.0, 200.0);
  countryEye.y += x.lift;
  if (countryMapped) countryWoodsSet();

  // The horizon in this heading: the colour the land fades into, greyed as the World greys its sky.
  vec3 haze = worldGrey(x.w, skyColor(sky, ${toSky("normalize(vec3(countryDir.x, 0.015, 1.0))")}), 1.0) + sky.night * vec3(0.03, 0.04, 0.07);
  countryHaze = haze;
  // The valley's air: its haze, the rain's veil over the distance and the drops in the light off it.
  x.air = Air(haze, mix(vec3(dot(haze, LUMA)) * vec3(0.94, 0.97, 1.0), haze, 0.4), max(greyed(haze, vec3(1.0), 0.5) * 1.2, vec3(0.08)), haze, 0.0, 0.0, 0.0);

  countryClear = 1.0;
  countryZ = WORLD_FAR;
  countryGlint = 0.0;
  countryGlow = 0.0;
  countryHalo = 0.0;
  countrySmoke = 0.0;
  countryHit = -1.0;
  countryCrown = false;
  countryCanopyHit = false;
  countryCrownN = vec3(0.0, 1.0, 0.0);
  countryCrownUp = 0.5;
  countryBridgeT = -1.0;
  countryBridgeN = vec3(0.0, 1.0, 0.0);
  countryBridgeLocal = vec2(0.0);
  countryFound.face = 0.0;
  countryVerged = false;
  countryWalking = false;
  countryAny = false;
  if (countryUnder) return;
#if COUNTRY_HAS_FOG
  // The valley fog along this ray at this hour and season (fog.ts).
  if (K_fog > 0.0) countryFogSet(sky, countryEye, countryRd, countrySun, haze, countryTod, climateCold(countryYear), wind, countryOvercast, tm);
#endif
  vec3 eye = countryEye;
  vec3 rd = countryRd;
  float cellAngle = countryCellAngle;
  float tHit = countryMapped ? countryMarch(eye, rd) : -1.0;

  // Where the march met a tree's bound near enough for a crown to span a cell or so, the crown
  // itself (trees.ts), or the ground behind it between the crowns (countryBehind); farther off,
  // the canopy shaded whole (from a guest's garden, every wood).
  if (tHit > 0.0) {
    vec3 p = eye + rd * tHit;
    vec4 g = terrainGround(valleyField0, p.xz, COUNTRY_EXTENT);
    float ground = terrainSurface(g);
    if (countryBeyond(p.xz) <= 0.0 && p.y > ground + 0.3) {
#if COUNTRY_HOME
      float fall = dot(g.zw, rd.xz) - rd.y;
      if (3.0 / (tHit * cellAngle) < 1.2 || fall < 0.02) {
        countryCanopyHit = true;
      } else {
        float tc = countryCrowns(eye, rd, tHit, p, g, countryTree, countryCrownN, countryCrownUp);
        countryCrown = tc > 0.0;
        tHit = countryCrown ? tc : countryBehind(eye, rd, tHit, p, g);
      }
#else
      countryCanopyHit = true;
#endif
    }
  }
  countryHit = tHit;
  float zLimit = tHit > 0.0 ? tHit * countryAhead : 1e6;

  // The bridge, and the buildings in front of whatever the march met.
  countryFound.z = zLimit;
  if (countryMapped) {
#if COUNTRY_HAS_ROADS
    if (VALLEY_ROADS > 0.5 || VALLEY_TRACKS > 0.5 || VALLEY_VILLAGE > 0.5) {
      countryBridgeT = countryBridge(terrainBridge(valleyField3), eye, rd, countryBridgeN, countryBridgeLocal);
      if (countryBridgeT > 0.0 && (tHit < 0.0 || countryBridgeT < tHit)) zLimit = countryBridgeT * countryAhead;
      else countryBridgeT = -1.0;
    }
#endif
    countryFound = countryBuildings(eye, rd, countryQ, cellAngle, zLimit, countryTod, countryDark, wind, countryGlow, countryHalo, countrySmoke);
  }
  // A clump of the verges at a hedge's foot standing in front of all that (verges.ts); zFront: the
  // nearest surface yet.
#if COUNTRY_HAS_VERGES
  countryVerge = countryVergeAt(countryMapped, eye, countryQ, cellAngle, countryFound.z);
  countryVerged = countryVerge.cover > 0.5;
  float zFront = countryVerge.z;
#else
  float zFront = countryFound.z;
#endif

  // A walker or cart standing in front of all that (life.ts).
#if COUNTRY_HAS_AGENTS
  countryFigureZ = 1e9;
  countryFigure = figureNone();
  if (countryMapped && (VALLEY_WALKERS > 0.0 || VALLEY_CARTS > 0.0)) countryFigure = countryAgentAt(eye, countryQ, cellAngle, zFront, countryDark, countryFigureZ);
  countryWalking = countryFigure.cover > 0.5;
#endif
  countryAny = countryWalking || countryVerged || countryFound.face > 0.5 || countryBridgeT > 0.0 || tHit > 0.0;
}

// Where nothing of the land stands: the World's sky, the far ridges beyond the map along the
// horizon in the haze, and the valley fog out to them (fog.ts: the land's own integral carried on,
// so the bank lies round the ridges' feet and the horizon's sky sits in it).
void valleySky(Ctx x, inout Cell c) {
  if (countryAny || countryUnder) return;
  WorldSky heaven = worldSky(x.w, x.v, WORLD_METEOR_FIELD);
  vec3 col = heaven.col + heaven.strike;
  float cellAngle = countryCellAngle;
  float bearing = atan(countryDir.x, countryDir.z);
  vec2 ridge = countryRidges(bearing);
  float e = countryDir.y - 0.25 * countryLiftShare;
  vec3 haze = countryHaze;
  float grey = countryGrey;
  vec3 ridgeFar = mix(haze, haze * vec3(0.78, 0.84, 0.95), 0.6 * (1.0 - grey)) + countrySky.night * 0.02;
  vec3 ridgeNear = mix(haze, haze * vec3(0.62, 0.72, 0.86), 0.7 * (1.0 - grey));
  if (e < ridge.y) col = mix(col, ridgeFar, hardEdge(1.0 - smoothstep(ridge.y - cellAngle, ridge.y + cellAngle, e)));
  if (e < ridge.x) col = mix(col, ridgeNear, hardEdge(1.0 - smoothstep(ridge.x - cellAngle, ridge.x + cellAngle, e)));
#if COUNTRY_HAS_FOG
  if (K_fog > 0.0) countryClear = 1.0 - countryFogged(col, e < ridge.x ? 6000.0 : (e < ridge.y ? 9500.0 : 16000.0), 1.0, 0.0);
#endif
  c.col = col;
}

// The land and what stands on it, the nearest thing the ray met, lit, wet, snowed on, the water
// mirroring the World's sky, hazed with distance and in the valley fog; then over whatever the cell
// shows, the lamplight round lit windows (in the valley fog dimmed by it, and the fog round them
// aglow), the smoke drifting over what lies behind, and the starlings over the far fields at dusk
// in front of whatever lies farther (murmuration.ts).
void valleyFar(Ctx x, inout Cell c) {
  if (countryUnder) return;
  Sky sky = countrySky;
  vec3 sun = countrySun;
  vec3 moon = countryMoon;
  vec3 eye = countryEye;
  vec3 rd = countryRd;
  float ahead = countryAhead;
  float cellAngle = countryCellAngle;
  float tHit = countryHit;
  float tm = x.tm;
  float wind = x.w.wind;
  float rain = countryFall.x;
  float grey = countryGrey;
  float overcast = countryOvercast;
  float wet = uWeather.x;
  float lying = uWeather.y;
  vec3 haze = countryHaze;
  float seen = 8000.0;
  float accent = 0.0;
  vec3 col = c.col;
  if (countryAny) {
    vec3 n;
    vec3 albedo;
    vec3 p;
    float porous = 0.6;
    float glossy = 0.05;
    float shade = 1.0;
    float lamp = 0.0;
#if COUNTRY_HAS_CHALK
    float chalk = 0.0;
#endif
    float snowy = -1.0;   // snow on a building, tree or figure: its own cover; below 0 the land's
    bool water = false;
    float waterDepth = 0.0;
#if COUNTRY_HAS_AGENTS
    if (countryWalking) {
      // A walker or cart: rain wets it like the land; snow settles only on a load's top.
      seen = countryFigureZ / ahead;
      p = eye + rd * seen;
      albedo = countryFigure.albedo;
      n = countryFigure.normal;
      lamp = countryFigure.lamp;
      porous = 0.5;
      glossy = 0.12;
      snowy = countryFigure.top * snowCover(n, p.xz * 2.0, lying);
      shade = countryShadow(p + vec3(0.0, 1.5, 0.0), sun);
    } else
#endif
#if COUNTRY_HAS_VERGES
    if (countryVerged) {
      // A clump of the verges (verges.ts): lit from above as the field it stands in, a little
      // toward us; snow on its heads and the tops of its leaves.
      seen = countryVerge.z / ahead;
      p = eye + rd * seen;
      albedo = countryVerge.albedo;
      n = normalize(vec3(0.0, 1.0, 0.0) + countryFwd * (0.4 * countryVerge.up - 0.6));
      porous = 0.35;
      glossy = 0.12;
      snowy = countryVerge.up * snowCover(vec3(0.0, 1.0, 0.0), p.xz * 2.0, lying);
      shade = countryShadow(countryVerge.root + vec3(0.0, 1.5, 0.0), sun);
    } else
#endif
    if (countryFound.face > 0.5) {
      // A building: walls, roofs, windows (buildings.ts).
      seen = countryFound.z / max(ahead, 1e-3);
      p = eye + rd * seen;
      albedo = countryBuildingLook(countryFound, countryTod, countryDark, lamp, snowy, porous, glossy);
      n = countryFound.n;
      shade = countryMapped ? countryShadow(p + n * 1.5, sun) : 1.0;
      if (snowy > 0.0) snowy *= snowCover(n, p.xz * 0.3, lying);
    } else if (countryBridgeT > 0.0) {
      seen = countryBridgeT;
      p = eye + rd * countryBridgeT;
      n = normalize(countryBridgeN);
      // Coursed stone, the voussoirs of its arch darker.
      vec2 s = countryBridgeLocal / vec2(1.1, 0.45);
      float course = step(0.08, fract(s.y)) * step(0.06, fract(s.x + 0.5 * floor(s.y)));
      albedo = vec3(0.7, 0.66, 0.57) * (0.86 + 0.14 * course);
      porous = 0.15;
      glossy = 0.1;
      shade = countryShadow(p + n * 1.0, sun);
      snowy = smoothstep(0.6, 0.9, n.y);
#if COUNTRY_HOME
    } else if (countryCrown) {
      // A tree's crown, lit by its own shape (the shadow side away from the sun); the sun reaches
      // it from over the woods' and the lone trees' bounds.
      seen = tHit;
      p = eye + rd * tHit;
      n = countryCrownN;
      albedo = countryLeaves(countryTree, p, countryCrownUp, tHit * cellAngle);
      porous = 0.3;
      glossy = 0.08;
      shade = countryShadow(vec3(p.x, countryTree.foot.y + COUNTRY_WOOD_TOP + 0.5, p.z), sun);
      snowy = snowCover(n, p.xz * 0.7 + countryTree.hash * 31.0, lying) * (countryTree.pine ? 1.0 : 0.85);
#endif
    } else {
      seen = tHit;
      p = eye + rd * tHit;
      vec4 g = terrainGround(valleyField0, p.xz, COUNTRY_EXTENT);
      vec4 cv = terrainCover(valleyField1, p.xz, COUNTRY_EXTENT);
      float foot = tHit * cellAngle;
      waterDepth = terrainWater(g);
      if (countryBeyond(p.xz) > 0.0) {
        // The ring beyond the map (countryRing): grass rolling off into the haze, darker where
        // woods lie, its water (the sea, a river's) mirroring the sky.
        vec2 ring = countryRing(p.xz);
        waterDepth = ring.y - ring.x;
        water = waterDepth > 0.02;
        float e = max(4.0, foot);
        vec2 slope = vec2(countryRing(p.xz + vec2(e, 0.0)).x - countryRing(p.xz - vec2(e, 0.0)).x, countryRing(p.xz + vec2(0.0, e)).x - countryRing(p.xz - vec2(0.0, e)).x) / (2.0 * e);
        n = water ? vec3(0.0, 1.0, 0.0) : normalize(vec3(-slope.x, 1.0, -slope.y));
        vec3 sward = countrySward(mix(vec3(0.33, 0.47, 0.18), vec3(0.4, 0.52, 0.2), vnoise(p.xz / 90.0)));
        albedo = water ? vec3(0.06, 0.1, 0.1) : mix(sward, vec3(0.17, 0.3, 0.11), smoothstep(0.55, 0.62, vnoise(p.xz / 260.0)));
        shade = countryShadow(p + n, sun);
      } else if (countryCanopyHit) {
        // The woods or a lone tree far off, whole: the canopy lit on its sunward sides, darker in
        // between (its own slope over a cell or more), pine woods darker (packLand's pine flags).
        float e = max(1.6, foot);
        vec2 slope = vec2(countryHeight(p.xz + vec2(e, 0.0), false) - countryHeight(p.xz - vec2(e, 0.0), false), countryHeight(p.xz + vec2(0.0, e), false) - countryHeight(p.xz - vec2(0.0, e), false)) / (2.0 * e);
        n = normalize(vec3(-slope.x, 1.0, -slope.y));
#if COUNTRY_HAS_PINES
        float pines = countryPines(p.xz);
#else
        float pines = 0.0;
#endif
        vec3 leaf = mix(vec3(0.17, 0.3, 0.11), vec3(0.23, 0.35, 0.13), vnoise(p.xz / 13.0));
        leaf = countryCanopyYear(leaf, p.xz, foot, countryLonePine(p.xz));
        leaf = mix(leaf, vec3(0.1, 0.2, 0.12), pines);
        albedo = leaf * (0.8 + 0.25 * vnoise(p.xz / 3.0));
        porous = 0.3;
        glossy = 0.08;
        shade = countryShadow(p + vec3(0.0, 0.5, 0.0), sun);
      } else if (waterDepth > 0.02) {
        water = true;
        n = vec3(0.0, 1.0, 0.0);
        albedo = mix(vec3(0.16, 0.2, 0.15), vec3(0.06, 0.1, 0.1), smoothstep(0.0, 2.0, waterDepth));
        shade = countryShadow(p + vec3(0.0, 0.5, 0.0), sun);
      } else {
        n = terrainNormal(g);
        // Fine relief the map is too coarse for, where a cell is small enough to show it.
        vec3 bump = vnoiseD(p.xz / 9.0);
        n = normalize(n + vec3(-bump.y, 0.0, -bump.z) * 0.3 * smoothstep(1.5, 0.4, foot));
        TerrainParcel parcel = terrainParcel(valleyField2, valleyField3, p.xz, COUNTRY_EXTENT);
        float h = fract(parcel.id * 0.618034);
        vec3 grass = mix(vec3(0.33, 0.47, 0.18), vec3(0.4, 0.52, 0.2), smoothstep(0.3, 0.7, vnoise(p.xz / 40.0)));
        grass = countrySward(grass);
        albedo = grass;
        if (parcel.id > 0.5) {
          // The parcel as the land model uses it (its record): open grassland and the woods' floor
          // are the grass, the rest farmed; where the woods stand (an assart's wooded corner too)
          // their floor, with no crop, hedge, fence, herd or bale under the trees.
          float wooded = countryWoods(cv, waterDepth, false);
          float use = wooded > 0.5 ? LAND_WOODLAND : floor(parcel.use + 0.5);
          vec2 r = vec2(dot(p.xz - parcel.site, parcel.axis), dot(p.xz - parcel.site, vec2(-parcel.axis.y, parcel.axis.x)));
          vec2 nb = vec2(dot(parcel.normal, countryRight.xz), dot(parcel.normal, countryFwd.xz));
          float footAcross = foot * length(vec2(nb.x, nb.y / max(abs(rd.y), 0.08)));
          float footAlong = foot / max(abs(rd.y), 0.12);
          float rows = 0.5;
          float fieldPorous = 0.5;
          vec3 field = grass;
          // A pasture's grass is grazing's (one call: a software renderer runs every line).
          if (use == LAND_CROPS || use == LAND_PASTURE) field = countryField(use == LAND_PASTURE ? LAND_CROP_GRAZING : parcel.attr, h, r, footAlong, rows, fieldPorous);
#if COUNTRY_HAS_FIELDS
          else if (use >= LAND_WILDFLOWERS && use <= LAND_SUNFLOWERS) {
            float relief = 0.5;
            float sheen = 0.0;
            field = fieldFlowerMaterial(use - LAND_WILDFLOWERS + FIELD_WILDFLOWERS, h, countryYear, p.xz / COUNTRY_FIELD_UNIT, r / COUNTRY_FIELD_UNIT, vec2(footAlong / COUNTRY_FIELD_UNIT), wind, 1.0 - lying, tm, relief, sheen);
          }
#endif
          // Hedges where a farmed parcel meets another (none through a wood or across open
          // grassland), never thinner than half a cell across so the patchwork holds far off,
          // fading out once fields shrink to a few cells; a greener verge either side.
          float otherUse = floor(parcel.otherUse + 0.5);
          bool hedged = wooded <= 0.5 && ((use >= LAND_CROPS && use <= LAND_PASTURE) || (otherUse >= LAND_CROPS && otherUse <= LAND_PASTURE));
          float hedgeHalf = max(1.3, 0.45 * footAcross);
          float hedge = hedged ? hardFill(parcel.border - hedgeHalf, 0.5 * footAcross) * (1.0 - smoothstep(18.0, 40.0, footAcross)) : 0.0;
          float verge = hedged ? 1.0 - smoothstep(hedgeHalf, hedgeHalf + 2.5, parcel.border) : 0.0;
          albedo = mix(field, grass * 1.05, verge * 0.5);
          albedo = mix(albedo, countryHedge(p.xz), hedge);
          porous = use == LAND_CROPS ? fieldPorous : 0.5;
#if COUNTRY_HAS_HERDS
          // A pasture's fence and its herd standing in front of the ground (life.ts).
          if (VALLEY_PASTURE > 0.0 && wooded <= 0.5) {
            bool pen = use == LAND_PASTURE;
            bool beyond = otherUse == LAND_PASTURE;
            float zFence = 1e9;
            vec4 fence = (pen || beyond) ? countryFence(eye, rd, tHit, p, g, parcel, pen, beyond, cellAngle, zFence) : vec4(0.0);
            CountryStock stock;
            stock.cover = 0.0;
            stock.shadow = 0.0;
            stock.z = 1e9;
            if (pen) stock = countryHerdAt(eye, countryQ, cellAngle, tHit * ahead, parcel.id, terrainCore(valleyField3, parcel.id), parcel.attr);
            albedo *= 1.0 - stock.shadow;
            if (fence.a > 0.5 && zFence < stock.z) {
              albedo = fence.rgb;
              n = normalize(vec3(parcel.normal.x, 0.3, parcel.normal.y));
              snowy = 0.3;
              porous = 0.6;
            } else if (stock.cover > 0.0) {
              albedo = mix(albedo, stock.albedo, stock.cover);
              n = normalize(mix(n, stock.n, stock.cover));
              snowy = stock.snow * stock.cover;
              porous = stock.porous;
            }
          }
#endif
#if COUNTRY_HAS_BALES
          // Round bales on the harvest's stubble, standing in front of the ground (season.ts).
          if (use == LAND_CROPS) countryBales(eye, rd, tHit, p, g, parcel, cellAngle, lying, sun, albedo, n, snowy, porous);
#endif
        }
        // Yards and gardens round the buildings.
        float yard = smoothstep(0.35, 0.8, cv.w);
        albedo = mix(albedo, mix(vec3(0.38, 0.45, 0.22), vec3(0.52, 0.47, 0.37), step(0.55, vnoise(p.xz / 7.0))), yard);
        // Under the trees, between their crowns, the floor lies dark in their shade; under bare
        // broadleaves in winter it lies open, brown with their fallen leaves (not in a pine wood).
        float under = max(countryWoods(cv, waterDepth, false), smoothstep(0.1, 0.6, -cv.w));
#if COUNTRY_HAS_PINES
        bool pinewood = countryPines(p.xz) > 0.5;
#else
        bool pinewood = false;
#endif
        float litter = pinewood ? 0.0 : countryKeys(0.0, 0.0, 0.0, 1.0, 0.0);
        albedo = countryBlend(mix(albedo, vec3(0.1, 0.12, 0.07), 0.6 * under), mix(albedo, vec3(0.3, 0.23, 0.16), 0.45 * under), litter);
        // Streams: a ribbon of water mirroring the sky; with the river off, they and the river's
        // bed (packWater marks it so) lie dry, pale stones and silt.
        if (cv.y < 0.0) {
          if (VALLEY_RIVER > 0.0) {
            water = true;
            albedo = vec3(0.12, 0.16, 0.13);
            waterDepth = 0.4;
          } else {
            albedo = mix(vec3(0.5, 0.48, 0.42), vec3(0.4, 0.38, 0.33), vnoise(p.xz / 2.5));
            porous = 0.4;
          }
        }
#if COUNTRY_HAS_CHALK
        // The chalk M cut through the turf of its hillside (chalk.ts).
        if (VALLEY_CHALK > 0.5) {
          chalk = countryChalk(p, foot);
          albedo = mix(albedo, countryChalkWhite(p.xz), chalk);
          porous = mix(porous, 0.3, chalk);
        }
#endif
#if COUNTRY_HAS_ROADS
        if (VALLEY_ROADS > 0.5 || VALLEY_TRACKS > 0.5 || VALLEY_VILLAGE > 0.5) {
          // The roads: pale gravel ribbons with a grass verge and a hedge either side (not in the
          // villages), each held to about half a cell across however the road turns to the view.
          vec2 across = vec2(terrainCover(valleyField1, p.xz + vec2(2.0, 0.0), COUNTRY_EXTENT).x, terrainCover(valleyField1, p.xz + vec2(0.0, 2.0), COUNTRY_EXTENT).x) - cv.x;
          across /= max(length(across), 1e-3);
          float footRoad = foot * length(vec2(dot(across, countryRight.xz), dot(across, countryFwd.xz) / max(abs(rd.y), 0.08)));
          float road = hardFill(cv.x - max(0.0, 0.6 * footRoad - 2.0), 0.5 * footRoad);
          float lined = (1.0 - smoothstep(0.2, 0.5, max(cv.w, 0.0))) * (1.0 - smoothstep(14.0, 30.0, footRoad));
          float roadHedge = hardFill(abs(cv.x - 3.2 - 0.3 * footRoad) - max(0.9, 0.4 * footRoad), 0.5 * footRoad) * lined;
          float roadVerge = (1.0 - smoothstep(0.0, 2.4, cv.x)) * step(0.0, cv.x);
          vec3 gravel = mix(vec3(0.8, 0.74, 0.6), vec3(0.7, 0.64, 0.52), vnoise(p.xz / 3.0));
          albedo = mix(albedo, vec3(0.42, 0.52, 0.24), roadVerge * 0.7);
          albedo = mix(albedo, countryHedge(p.xz), roadHedge * (1.0 - road));
          albedo = mix(albedo, gravel, road);
          porous = mix(porous, 0.3, road);
          glossy = mix(glossy, 0.25, road);
#if COUNTRY_HAS_AGENTS
          // Walkers and carts tread the lying snow down along the middle (trodden.ts).
          countryTrod = countryTrodden(cv.x, footRoad, road);
#endif
          if (road > 0.5 && wet > 0.0) {
            float puddle = rainPuddles(p.xz, wet);
            if (puddle > 0.5) {
              water = true;
              waterDepth = 0.05;
            }
          }
        }
#endif
#if COUNTRY_HAS_AGENTS
        // A walker or cart too small to draw tints the ground it stands on; nearer ones shade it
        // at their feet.
        albedo = mix(albedo * (1.0 - 0.45 * countryFigure.shadow), countryFigure.albedo, countryFigure.faint);
#endif
        shade = countryShadow(p + n * 1.0, sun);
      }
    }
    // The deck's shadows sweeping over the land, from the countryside's deck 900 m over the eye
    // (the World's worldSunlit at the point scaled to its own base), and the cumulus' with them.
    float sunShade = 1.0 - 0.75 * overcast;
    if (sky.sun.y > 0.0) sunShade *= worldSunlit(x.w, x.v, countryToCamera(p - eye) * (WORLD_CLOUD_BASE / COUNTRY_CLOUD_BASE));
    shade *= sunShade;
    albedo = wetten(albedo, wet, porous);
    float buried = snowy >= 0.0 ? snowy : snowCover(n, p.xz * 0.25, lying) * (water ? 0.0 : 1.0);
#if COUNTRY_HAS_ROADS && COUNTRY_HAS_AGENTS
    countryTread(albedo, buried);
#endif
    albedo = mix(albedo, COUNTRY_SNOW, buried);
    col = albedo * countryLight(sky, sun, moon, n, shade);
    if (water) {
      // The water mirrors the World's sky (and its deck) along the reflected ray, by Fresnel;
      // ripples and rain rings break it.
      vec3 rings = rainRipples(p.xz * 2.0, uFallTime, rain);
      vec2 tilt = rings.xy * 0.4 + 0.03 * (vec2(vnoise(p.xz * 0.4 + vec2(tm * 0.3, 0.0)), vnoise(p.zx * 0.4 - vec2(0.0, tm * 0.25))) - 0.5);
#if WATER_TIER >= WATER_RIPPLES && COUNTRY_HOME
      // The breeze's cat's-paws (ripples.ts) tilt it further.
      vec3 paws = countryRipples(p, rd, seen * cellAngle);
      tilt += paws.xy;
#endif
      vec3 nw = normalize(vec3(tilt.x, 1.0, tilt.y));
      vec3 refl = reflect(rd, nw);
      refl.y = max(refl.y, 0.02);
      vec3 rc = ${toSky("countryToCamera(refl)")};
      vec3 mirror = skyColor(sky, rc);
      vec4 deck = skyClouds(sky, normalize(vec3(rc.x, rc.y * x.w.low, rc.z)), tm, countryCover, worldDeckDrift(x.w, x.v));
      mirror = worldGrey(x.w, mix(mirror, deck.rgb, deck.a), 1.0 - deck.a);
      float fres = fresnelSchlick(max(dot(-rd, nw), 0.0), 0.02, 0.0);
      float mirrorShare = mix(0.35, 1.0, fres) * (waterDepth > 0.1 ? 1.0 : 0.6);
      col = mix(col, mirror * 0.92, mirrorShare) + rings.z * 0.12 * mirror;
      countryGlint = 0.4 * smoothstep(0.92, 1.0, dot(refl, sun)) * (1.0 - overcast);
      col += sky.sunColor * countryGlint * 0.8;
#if WATER_TIER >= WATER_RIPPLES && COUNTRY_HOME
      // The cat's-paws glitter in the dither.
      countryGlint = max(countryGlint, smoothstep(0.3, 0.9, paws.z) * (1.0 - grey));
#endif
    } else if (wet > 0.0) {
      col += haze * 0.12 * wetGloss(wet, n.y) * glossy * 3.0;
    }
    if (lamp > 0.0) {
      col = mix(col, COUNTRY_AMBER, lamp);
      accent = lamp;
    }
#if COUNTRY_HAS_CHALK
    accent = max(accent, 0.75 * chalk);
#endif
    // Atmospheric perspective: the far land paler and bluer, more so in haze and rain.
    float thick = 1.0 / (5200.0 - 2600.0 * overcast);
    col = mix(col, haze * mix(vec3(1.0), vec3(0.84, 0.88, 0.95), grey), 1.0 - exp(-seen * thick));
#if COUNTRY_HAS_FOG
    // The valley fog between the eye and the surface, ground mist where it is met in a hollow
    // (fog.ts); the bank there lies in the sun or shade as the surface does.
    if (K_fog > 0.0) {
      countryClear = 1.0 - countryFogged(col, seen, mix(shade, 1.0, 0.3), countryFogHollow(p, seen));
      accent *= countryClear;
    }
#endif
    // The camera's descent: the morning's haze thinning off the land.
    if (countryLiftShare > 0.0) col = mix(col, haze, 0.4 * countryLiftShare);
  }

  // Lamplight round lit windows, smoke drifting over what lies behind.
  float glow = countryGlow;
#if COUNTRY_HAS_FOG
  glow = glow * countryClear + countryHalo;
#endif
  col += COUNTRY_AMBER * min(glow, 2.0) * 0.1 * countryDark * (1.0 + wet);
  vec3 air = sky.ambient + 0.5 * sky.sunColor + 0.4 * sky.moonColor;
  col = mix(col, vec3(0.8, 0.8, 0.83) * air, clamp(countrySmoke, 0.0, 1.0) * 0.7);

#if COUNTRY_HAS_MURMURATION
  if (countryMapped) countryMurmuration(col, seen, accent, x.uv, ahead, sky, haze, countryTod, rain, overcast);
#endif
  if (seen < 7999.0) {
    cellPut(c, vec4(col, 1.0), seen * ahead);
    c.accent = accent;
    countryZ = c.z;
  } else {
    c.col = col;
  }
}

// After the World's birds: on the hill, the valley fog along the way to a bird nearer than the land
// (it hazes the birds as it does the land behind them), and the exit's picture greying a little as
// the camera rises away.
void valleyAir(inout Ctx x, inout Cell c) {
#if COUNTRY_HOME
#if COUNTRY_HAS_FOG
  if (K_fog > 0.0 && !countryUnder && c.z < countryZ) countryFogged(c.col, c.z / countryAhead, 1.0, 0.0);
#endif
  if (countryLeaving > 0.0) c.col = mix(c.col, vec3(dot(c.col, LUMA)), 0.2 * countryLeaving);
  // The land lies far off: the World's rain and snow, which fall next (at weatherDepth of c.z over
  // the view's unit), reckon the distance compressed to their reach (COUNTRY_PRECIP_REACH), a fall
  // of both by each one's share, so the valley shows through them.
  float snowShare = x.w.snow / max(x.w.rain + x.w.snow, 1e-3);
  x.v.unit = mix(${glslFloat(COUNTRY_PRECIP_REACH.rain / 30)}, ${glslFloat(COUNTRY_PRECIP_REACH.snow / 30)}, snowShare);
#endif
}

// The water's glint and the cat's-paws glitter in the dither, where the cell still shows the valley.
void valleyShade(Ctx x, Cell c, inout Shade o) {
  if (COUNTRY_HOME == 1 || c.z == countryZ) o.shimmer = countryGlint * 0.3;
}
`;
}
