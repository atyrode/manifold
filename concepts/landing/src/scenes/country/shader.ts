// The countryside: the terrain toolbox's landscape (sims/terrain.ts through shaders/lib/terrain.ts)
// seen from its vantage, ray-marched as a height field in metres under the shared sky and weather.
//
// World frame: map metres, x east, z north, y up. The camera stands at the vantage (the records'
// eye) looking along COUNTRY_HEADING, level, through the shared viewRay (horizon COUNTRY_HORIZON,
// focal one screen height); the sky library's frame is the camera's, so the sun sets where the sky
// shows it and lights the land from there.
//
// What a ray meets, nearest first: a walker or cart on the roads (life.ts), a clump of the verges at
// a hedge's foot (verges.ts), a building (modelled near, the shared sprite far: buildings.ts), the
// stone bridge (a box with an arch), or the land. The march meets the ground or the water over it,
// or the trees' bounds; near enough, the trees are whole crowns found at the hit (trees.ts), and a
// ray passing between them goes on to the ground. On the ground: each parcel as the land model
// (sims/landuse.ts) uses it, read from its record (terrainParcel): crops of its kind as the farming
// season has them (season.ts, the harvest's bales too), a flower field (the shared fields'
// materials, shaders/lib/fields.ts), a pasture with its fence and herd (life.ts), the floor of a
// wood, or open grassland; hedges where a farmed parcel meets another, roads (their snow trodden
// where walkers and carts go: trodden.ts), yards and streams (dry while the river is off). The
// river mirrors the sky, ruffled by the wind (ripples.ts). The starling murmuration wheels over the
// far fields at dusk (murmuration.ts) and birds cross the sky in front of all.
//
// Hook points for the parts the layered-ridge Countryside had and this one does not yet (each a
// module of its own): the chalk figure (a terrain-placed mark on a parcel, drawn in the ground
// branch), lit windows and chimney smoke as knobs (countryBuildings' glow and smoke, now always
// on) and the castle's model (buildings.ts draws its sprite at any size).
import { buildingsGlsl } from "../../shaders/buildings.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { birdsGlsl } from "../../shaders/lib/birds.ts";
import { fieldsGlsl } from "../../shaders/lib/fields.ts";
import { figuresGlsl } from "../../shaders/lib/figures.ts";
import { livestockGlsl } from "../../shaders/lib/livestock.ts";
import { terrainGlsl } from "../../shaders/lib/terrain.ts";
import { treesGlsl } from "../../shaders/lib/trees.ts";
import { countryBuildingsGlsl } from "./buildings.ts";
import { countryLifeGlsl } from "./life.ts";
import { countryMurmurationGlsl } from "./murmuration.ts";
import { countryRipplesGlsl } from "./ripples.ts";
import { countrySeasonGlsl } from "./season.ts";
import { COUNTRY_MAP } from "./sim.ts";
import { countryTreesGlsl } from "./trees.ts";
import { countryVergesGlsl } from "./verges.ts";
import { countryTroddenGlsl } from "./trodden.ts";

/** Seconds of the entrance (the camera comes down out of the sky and settles) and exit. */
export const COUNTRY_PASSAGE = { enter: 2.8, exit: 1.4 } as const;

/** The ray march's numbers: highest ground, farthest look, slope bound, shortest steps, steps. */
export const COUNTRY_MARCH = {
  top: 520,
  far: 7000,
  slope: 0.85,
  minStep: 1.5,
  relStep: 0.006,
  steps: 72,
  refine: 5,
} as const;

export const countryGlsl = /* glsl */ `
${terrainGlsl}
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
#if COUNTRY_HAS_BIRDS
${birdsGlsl}
#endif
const float COUNTRY_EXTENT = ${glslFloat(COUNTRY_MAP.extent)};
const float COUNTRY_HORIZON = 0.63;
const float COUNTRY_FOV = 0.78;          // a little long, so the middle distance reads at the dither
const float COUNTRY_FOCAL = 1.2138;      // viewRay's focal length there, screen heights: 0.5 / tan(fov / 2)
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

// Camera frame -> world, and back.
vec3 countryToWorld(vec3 d) {
  return countryRight * d.x + vec3(0.0, d.y, 0.0) + countryFwd * d.z;
}
vec3 countryToCamera(vec3 d) {
  return vec3(dot(d, countryRight), d.y, dot(d, countryFwd));
}

${countrySeasonGlsl}
${countryTreesGlsl}

// The land and what stands on it (metres): the trees' bounds for the march, their rounded tents for
// the sun's shadows (countryCanopy).
float countryHeight(vec2 p, bool bound) {
  vec4 g = terrainGround(uSim0, p, COUNTRY_EXTENT);
  vec4 c = terrainCover(uSim1, p, COUNTRY_EXTENT);
  return terrainSurface(g) + countryCanopy(p, c, terrainWater(g), bound);
}

// March the land from the eye (slope-bound steps, never shorter than a share of the distance), then
// bisect the crossing step. -1: sky, or off the map.
float countryMarch(vec3 ro, vec3 rd) {
  float t = 0.0;
  if (ro.y > COUNTRY_TOP) {
    if (rd.y >= 0.0) return -1.0;
    t = (ro.y - COUNTRY_TOP) / -rd.y;
  }
  float last = t;
  bool hit = false;
  for (int i = 0; i < ${COUNTRY_MARCH.steps}; i++) {
    vec3 p = ro + rd * t;
    if (p.x < -40.0 || p.z < -40.0 || p.x > COUNTRY_EXTENT + 40.0 || p.z > COUNTRY_EXTENT + 40.0) return -1.0;
    float gap = p.y - countryHeight(p.xz, true);
    if (gap < 0.0) {
      hit = true;
      break;
    }
    if (rd.y >= 0.0 && p.y > COUNTRY_TOP) return -1.0;
    last = t;
    t += max(gap / (${glslFloat(COUNTRY_MARCH.slope)} + abs(rd.y)), ${glslFloat(COUNTRY_MARCH.relStep)} * t + ${glslFloat(COUNTRY_MARCH.minStep)});
    if (t > COUNTRY_FAR) return -1.0;
  }
  if (!hit) return t;
  float lo = last;
  float hi = t;
  for (int i = 0; i < ${COUNTRY_MARCH.refine}; i++) {
    float mid = 0.5 * (lo + hi);
    vec3 p = ro + rd * mid;
    if (p.y > countryHeight(p.xz, true)) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
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

// Light on a surface with normal n (world): sun and moon with a wrap, sky fill, a dark-adapted
// night that stays legible. shade: how much sun gets through (shadows, cloud).
vec3 countryLight(Sky sky, vec3 sun, vec3 moon, vec3 n, float shade) {
  float s = clamp((dot(n, sun) + 0.15) / 1.15, 0.0, 1.0) * shade;
  float mo = clamp((dot(n, moon) + 0.2) / 1.2, 0.0, 1.0);
  vec3 adapted = sky.night * (vec3(0.07, 0.09, 0.14) * (0.7 + 0.3 * n.y) + sky.moonColor * (0.35 + 0.65 * mo));
  return sky.sunColor * s * 1.1 + sky.ambient * (0.55 + 0.45 * n.y) + adapted;
}

// The sky along a camera-frame direction, under the weather: the dome greyed by rain, the deck.
vec3 countrySkyDome(Sky sky, vec3 dir, float rain) {
  vec3 c = skyColor(sky, dir);
  float grey = smoothstep(0.0, 0.05, rain);
  return greyed(c, vec3(0.92, 0.95, 1.0), 0.6 * grey) * (1.0 - 0.2 * rain);
}

vec4 countryDeck(Sky sky, vec3 dir, float t, float cover, float wind, float rain) {
  vec4 c = skyClouds(sky, normalize(vec3(dir.x, dir.y * (1.0 + 0.8 * rain), dir.z)), t, cover, wind);
  float grey = smoothstep(0.0, 0.05, rain);
  c.rgb = greyed(c.rgb, vec3(0.94, 0.96, 1.0), 0.6 * grey) * (1.0 + 0.2 * grey - 0.35 * rain);
  return c;
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

${countryBuildingsGlsl}
${countryLifeGlsl}
${countryVergesGlsl}
${countryMurmurationGlsl}
${countryTroddenGlsl}
${countryRipplesGlsl}

Shade sceneCountry(vec2 screenUv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  float pxl = 1.0 / uRes.y;
  float tm = uMotionTime;
  // Entrance and exit: the camera comes down out of the sky and tilts down onto the valley (a
  // vertical lens shift with the eye easing down), and leaves the same way. 0 at rest.
  float arrive = 1.0 - smoothstep(0.0, 1.0, passageIn());
  float leave = smoothstep(0.0, 1.0, passageOut());
  float lift = arrive * arrive + 0.6 * leave * leave;
  vec2 uv = screenUv + vec2(0.0, 0.34 * arrive + 0.3 * leave);
  // The screen point in the pinhole's plane at unit distance (x right, y up), and a cell there.
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y - COUNTRY_HORIZON) / COUNTRY_FOCAL;
  float cellAngle = pxl / COUNTRY_FOCAL;
  countryFwd = vec3(COUNTRY_HEADING.x, 0.0, COUNTRY_HEADING.y);
  countryRight = vec3(COUNTRY_HEADING.y, 0.0, -COUNTRY_HEADING.x);
  float wind = K_wind;
  float rain = K_rain;
  float wet = uWeather.x;
  float lying = uWeather.y;

  float tod = timeOfDayM(K_time, K_cycle, tm);
#ifdef SKY_MOON_PHASE
  Sky sky = skyMoonPhase(skyAt(tod), K_moon);
#else
  Sky sky = skyAt(tod);
#endif
  // Rain hangs a grey deck over the sky: the sun is lost, its light diffused.
  float grey = smoothstep(0.0, 0.05, rain);
  float lost = grey * (0.5 + 0.45 * rain);
  vec3 diffused = sky.sunColor * lost * (0.55 - 0.3 * rain);
  sky.sunColor *= 1.0 - lost;
  sky.moonColor *= 1.0 - grey * (0.4 + 0.3 * rain);
  sky.ambient = greyed(sky.ambient, vec3(0.95, 0.98, 1.04), 0.3 * grey) * (1.0 - 0.25 * rain) + diffused;
  float cover = clamp(max(K_clouds + 0.4 * K_snow, weatherOvercast(rain, K_snow)), 0.0, 1.0);
  float overcast = smoothstep(0.55, 1.0, cover);
  float dark = clamp(1.0 - smoothstep(-0.12, 0.2, sky.sun.y) + 0.3 * overcast + 0.2 * rain, 0.0, 1.0);
  vec3 sun = countryToWorld(sky.sun);
  vec3 moon = countryToWorld(sky.moon);

  vec3 dirCam = viewRay(uv, aspect, COUNTRY_HORIZON, COUNTRY_FOV);
  vec3 rd = countryToWorld(dirCam);
  float ahead = dot(rd, countryFwd);
  bool mapped = uSimOn.x > 0.5 && uSimOn.w > 0.5;
  vec3 eye = mapped ? terrainEye(uSim3) : vec3(200.0, 300.0, 200.0);
  eye.y += 220.0 * lift;

  // The horizon in this heading: the colour the land fades into.
  vec3 haze = countrySkyDome(sky, normalize(vec3(dirCam.x, 0.015, 1.0)), rain) + sky.night * vec3(0.03, 0.04, 0.07);
  float tHit = mapped ? countryMarch(eye, rd) : -1.0;

  // Where the march met a tree's bound near enough for a crown to span a cell or so, the crown
  // itself (trees.ts), or the ground behind it between the crowns (taken flat there); farther off,
  // the canopy shaded whole.
  bool crown = false;
  bool canopy = false;
  CountryTree tree;
  vec3 crownN = vec3(0.0, 1.0, 0.0);
  float crownUp = 0.5;
  if (tHit > 0.0) {
    vec3 p = eye + rd * tHit;
    vec4 g = terrainGround(uSim0, p.xz, COUNTRY_EXTENT);
    float ground = terrainSurface(g);
    if (p.y > ground + 0.3) {
      float fall = dot(g.zw, rd.xz) - rd.y;
      if (3.0 / (tHit * cellAngle) < 1.2 || fall < 0.02) {
        canopy = true;
      } else {
        float tc = countryCrowns(eye, rd, tHit, p, g, tree, crownN, crownUp);
        crown = tc > 0.0;
        tHit = crown ? tc : tHit + (p.y - ground) / fall;
      }
    }
  }
  float zLimit = tHit > 0.0 ? tHit * ahead : 1e6;

  vec3 col = vec3(0.0);
  float accent = 0.0;
  float glint = 0.0;
  float glow = 0.0;
  float smoke = 0.0;
  float seen = 8000.0;

  // The bridge, and the buildings in front of whatever the march met.
  vec3 bridgeN = vec3(0.0, 1.0, 0.0);
  vec2 bridgeLocal = vec2(0.0);
  float tBridge = -1.0;
  CountryFind found;
  found.face = 0.0;
  found.z = zLimit;
  if (mapped) {
#if COUNTRY_HAS_ROADS
    if (K_roads > 0.5 || K_tracks > 0.5) {
      tBridge = countryBridge(terrainBridge(uSim3), eye, rd, bridgeN, bridgeLocal);
      if (tBridge > 0.0 && (tHit < 0.0 || tBridge < tHit)) zLimit = tBridge * ahead;
      else tBridge = -1.0;
    }
#endif
    found = countryBuildings(eye, rd, q, cellAngle, zLimit, tod, dark, wind, glow, smoke);
  }
  // A clump of the verges at a hedge's foot standing in front of all that (verges.ts); zFront: the
  // nearest surface yet.
#if COUNTRY_HAS_VERGES
  CountryVerge verge = countryVergeAt(mapped, eye, q, cellAngle, found.z);
  bool verged = verge.cover > 0.5;
  float zFront = verge.z;
#else
  bool verged = false;
  float zFront = found.z;
#endif

  // A walker or cart standing in front of all that (life.ts).
#if COUNTRY_HAS_AGENTS
  float zAgent = 1e9;
  Figure agent = figureNone();
  if (mapped && (K_walkers > 0.0 || K_carts > 0.0)) agent = countryAgentAt(eye, q, cellAngle, zFront, dark, zAgent);
  bool walking = agent.cover > 0.5;
#else
  bool walking = false;
#endif

  if (walking || verged || found.face > 0.5 || tBridge > 0.0 || tHit > 0.0) {
    vec3 n;
    vec3 albedo;
    vec3 p;
    float porous = 0.6;
    float glossy = 0.05;
    float shade = 1.0;
    float lamp = 0.0;
    float snowy = -1.0;   // snow on a building, tree or figure: its own cover; below 0 the land's
    bool water = false;
    float waterDepth = 0.0;
#if COUNTRY_HAS_AGENTS
    if (walking) {
      // A walker or cart: rain wets it like the land; snow settles only on a load's top.
      seen = zAgent / ahead;
      p = eye + rd * seen;
      albedo = agent.albedo;
      n = agent.normal;
      lamp = agent.lamp;
      porous = 0.5;
      glossy = 0.12;
      snowy = agent.top * snowCover(n, p.xz * 2.0, lying);
      shade = countryShadow(p + vec3(0.0, 1.5, 0.0), sun);
    } else
#endif
#if COUNTRY_HAS_VERGES
    if (verged) {
      // A clump of the verges (verges.ts): lit from above as the field it stands in, a little
      // toward us; snow on its heads and the tops of its leaves.
      seen = verge.z / ahead;
      p = eye + rd * seen;
      albedo = verge.albedo;
      n = normalize(vec3(0.0, 1.0, 0.0) + countryFwd * (0.4 * verge.up - 0.6));
      porous = 0.35;
      glossy = 0.12;
      snowy = verge.up * snowCover(vec3(0.0, 1.0, 0.0), p.xz * 2.0, lying);
      shade = countryShadow(verge.root + vec3(0.0, 1.5, 0.0), sun);
    } else
#endif
    if (found.face > 0.5) {
      // A building: walls, roofs, windows (buildings.ts).
      seen = found.z / max(ahead, 1e-3);
      p = eye + rd * seen;
      albedo = countryBuildingLook(found, tod, dark, lamp, snowy, porous, glossy);
      n = found.n;
      shade = mapped ? countryShadow(p + n * 1.5, sun) : 1.0;
      if (snowy > 0.0) snowy *= snowCover(n, p.xz * 0.3, lying);
    } else if (tBridge > 0.0) {
      seen = tBridge;
      p = eye + rd * tBridge;
      n = normalize(bridgeN);
      // Coursed stone, the voussoirs of its arch darker.
      vec2 s = bridgeLocal / vec2(1.1, 0.45);
      float course = step(0.08, fract(s.y)) * step(0.06, fract(s.x + 0.5 * floor(s.y)));
      albedo = vec3(0.7, 0.66, 0.57) * (0.86 + 0.14 * course);
      porous = 0.15;
      glossy = 0.1;
      shade = countryShadow(p + n * 1.0, sun);
      snowy = smoothstep(0.6, 0.9, n.y);
    } else if (crown) {
      // A tree's crown, lit by its own shape (the shadow side away from the sun); the sun reaches
      // it from over the woods' and the lone trees' bounds.
      seen = tHit;
      p = eye + rd * tHit;
      n = crownN;
      albedo = countryLeaves(tree, p, crownUp, tHit * cellAngle);
      porous = 0.3;
      glossy = 0.08;
      shade = countryShadow(vec3(p.x, tree.foot.y + COUNTRY_WOOD_TOP + 0.5, p.z), sun);
      snowy = snowCover(n, p.xz * 0.7 + tree.hash * 31.0, lying) * (tree.pine ? 1.0 : 0.85);
    } else {
      seen = tHit;
      p = eye + rd * tHit;
      vec4 g = terrainGround(uSim0, p.xz, COUNTRY_EXTENT);
      vec4 c = terrainCover(uSim1, p.xz, COUNTRY_EXTENT);
      float foot = tHit * cellAngle;
      waterDepth = terrainWater(g);
      if (canopy) {
        // The woods or a lone tree far off, whole: the canopy lit on its sunward sides, darker in
        // between (its own slope over a cell or more), pine woods darker (the canopy's sign).
        float e = max(1.6, foot);
        vec2 slope = vec2(countryHeight(p.xz + vec2(e, 0.0), false) - countryHeight(p.xz - vec2(e, 0.0), false), countryHeight(p.xz + vec2(0.0, e), false) - countryHeight(p.xz - vec2(0.0, e), false)) / (2.0 * e);
        n = normalize(vec3(-slope.x, 1.0, -slope.y));
#if COUNTRY_HAS_PINES
        float pines = clamp(-3.0 * c.z, 0.0, 1.0);
#else
        float pines = 0.0;
#endif
        vec3 leaf = mix(vec3(0.17, 0.3, 0.11), vec3(0.23, 0.35, 0.13), vnoise(p.xz / 13.0));
        leaf = countryCanopyTurn(leaf, p.xz, foot, countryLonePine(p.xz));
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
        TerrainParcel parcel = terrainParcel(uSim2, uSim3, p.xz, COUNTRY_EXTENT);
        float h = fract(parcel.id * 0.618034);
        vec3 grass = mix(vec3(0.33, 0.47, 0.18), vec3(0.4, 0.52, 0.2), smoothstep(0.3, 0.7, vnoise(p.xz / 40.0)));
        grass = countrySward(grass);
        albedo = grass;
        if (parcel.id > 0.5) {
          // The parcel as the land model uses it (its record): open grassland and the woods' floor
          // are the grass, the rest farmed.
          float use = floor(parcel.use + 0.5);
          vec2 r = vec2(dot(p.xz - parcel.site, parcel.axis), dot(p.xz - parcel.site, vec2(-parcel.axis.y, parcel.axis.x)));
          vec2 nb = vec2(dot(parcel.normal, countryRight.xz), dot(parcel.normal, countryFwd.xz));
          float footAcross = foot * length(vec2(nb.x, nb.y / max(abs(rd.y), 0.08)));
          float footAlong = foot / max(abs(rd.y), 0.12);
          float rows = 0.5;
          vec3 field = grass;
          // A pasture's grass is grazing's (one call: a software renderer runs every line).
          if (use == LAND_CROPS || use == LAND_PASTURE) field = countryField(use == LAND_PASTURE ? LAND_CROP_GRAZING : parcel.attr, h, r, footAlong, rows);
#if COUNTRY_HAS_FIELDS
          else if (use >= LAND_WILDFLOWERS && use <= LAND_SUNFLOWERS) {
            float relief = 0.5;
            float sheen = 0.0;
            field = fieldFlowerMaterial(use - LAND_WILDFLOWERS + FIELD_WILDFLOWERS, h, K_season, p.xz / COUNTRY_FIELD_UNIT, r / COUNTRY_FIELD_UNIT, vec2(footAlong / COUNTRY_FIELD_UNIT), wind, 1.0 - lying, tm, relief, sheen);
          }
#endif
          // Hedges where a farmed parcel meets another (none through a wood or across open
          // grassland), never thinner than half a cell across so the patchwork holds far off,
          // fading out once fields shrink to a few cells; a greener verge either side.
          float otherUse = floor(parcel.otherUse + 0.5);
          bool hedged = (use >= LAND_CROPS && use <= LAND_PASTURE) || (otherUse >= LAND_CROPS && otherUse <= LAND_PASTURE);
          float hedgeHalf = max(1.3, 0.45 * footAcross);
          float hedge = hedged ? hardFill(parcel.border - hedgeHalf, 0.5 * footAcross) * (1.0 - smoothstep(18.0, 40.0, footAcross)) : 0.0;
          float verge = hedged ? 1.0 - smoothstep(hedgeHalf, hedgeHalf + 2.5, parcel.border) : 0.0;
          albedo = mix(field, grass * 1.05, verge * 0.5);
          albedo = mix(albedo, countryHedge(), hedge);
          porous = use == LAND_CROPS ? countryFieldPorous(parcel.attr, h) : 0.5;
#if COUNTRY_HAS_HERDS
          // A pasture's fence and its herd standing in front of the ground (life.ts).
          if (K_pasture > 0.0) {
            bool pen = use == LAND_PASTURE;
            bool beyond = otherUse == LAND_PASTURE;
            float zFence = 1e9;
            vec4 fence = (pen || beyond) ? countryFence(eye, rd, tHit, p, g, parcel, pen, beyond, cellAngle, zFence) : vec4(0.0);
            CountryStock stock;
            stock.cover = 0.0;
            stock.shadow = 0.0;
            stock.z = 1e9;
            if (pen) stock = countryHerdAt(eye, q, cellAngle, tHit * ahead, parcel.id, terrainCore(uSim3, parcel.id), parcel.attr);
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
        float yard = smoothstep(0.35, 0.8, c.w);
        albedo = mix(albedo, mix(vec3(0.38, 0.45, 0.22), vec3(0.52, 0.47, 0.37), step(0.55, vnoise(p.xz / 7.0))), yard);
        // Under the trees, between their crowns, the floor lies dark in their shade.
        float under = max(countryWoods(c, waterDepth, false), smoothstep(0.1, 0.6, -c.w));
        albedo = mix(albedo, vec3(0.1, 0.12, 0.07), 0.6 * under);
        // Streams: a ribbon of water mirroring the sky; with the river off, they and the river's
        // bed (packWater marks it so) lie dry, pale stones and silt.
        if (c.y < 0.0) {
          if (K_river > 0.0) {
            water = true;
            albedo = vec3(0.12, 0.16, 0.13);
            waterDepth = 0.4;
          } else {
            albedo = mix(vec3(0.5, 0.48, 0.42), vec3(0.4, 0.38, 0.33), vnoise(p.xz / 2.5));
            porous = 0.4;
          }
        }
#if COUNTRY_HAS_ROADS
        if (K_roads > 0.5 || K_tracks > 0.5) {
          // The roads: pale gravel ribbons with a grass verge and a hedge either side (not in the
          // villages), each held to about half a cell across however the road turns to the view.
          vec2 across = vec2(terrainCover(uSim1, p.xz + vec2(2.0, 0.0), COUNTRY_EXTENT).x, terrainCover(uSim1, p.xz + vec2(0.0, 2.0), COUNTRY_EXTENT).x) - c.x;
          across /= max(length(across), 1e-3);
          float footRoad = foot * length(vec2(dot(across, countryRight.xz), dot(across, countryFwd.xz) / max(abs(rd.y), 0.08)));
          float road = hardFill(c.x - max(0.0, 0.6 * footRoad - 2.0), 0.5 * footRoad);
          float lined = (1.0 - smoothstep(0.2, 0.5, max(c.w, 0.0))) * (1.0 - smoothstep(14.0, 30.0, footRoad));
          float roadHedge = hardFill(abs(c.x - 3.2 - 0.3 * footRoad) - max(0.9, 0.4 * footRoad), 0.5 * footRoad) * lined;
          float roadVerge = (1.0 - smoothstep(0.0, 2.4, c.x)) * step(0.0, c.x);
          vec3 gravel = mix(vec3(0.8, 0.74, 0.6), vec3(0.7, 0.64, 0.52), vnoise(p.xz / 3.0));
          albedo = mix(albedo, vec3(0.42, 0.52, 0.24), roadVerge * 0.7);
          albedo = mix(albedo, countryHedge(), roadHedge * (1.0 - road));
          albedo = mix(albedo, gravel, road);
          porous = mix(porous, 0.3, road);
          glossy = mix(glossy, 0.25, road);
#if COUNTRY_HAS_AGENTS
          // Walkers and carts tread the lying snow down along the middle (trodden.ts).
          countryTrod = countryTrodden(c.x, footRoad, road);
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
        albedo = mix(albedo * (1.0 - 0.45 * agent.shadow), agent.albedo, agent.faint);
#endif
        shade = countryShadow(p + n * 1.0, sun);
      }
    }
    // Cloud shadows sweeping over the land.
    float sunShade = 1.0 - 0.75 * overcast;
#if CLOUD_TIER >= CLOUD_SHADOWS
    if (K_shadows > 0.0 && sky.sun.y > 0.0) sunShade *= 1.0 - K_shadows * skyCloudShadow(sky, countryToCamera(p - eye), COUNTRY_CLOUD_BASE, 1.0 + 0.8 * rain, t, cover, wind);
#endif
    shade *= sunShade;
    albedo = wetten(albedo, wet, porous);
    float buried = snowy >= 0.0 ? snowy : snowCover(n, p.xz * 0.25, lying) * (water ? 0.0 : 1.0);
#if COUNTRY_HAS_ROADS && COUNTRY_HAS_AGENTS
    countryTread(albedo, buried);
#endif
    albedo = mix(albedo, COUNTRY_SNOW, buried);
    col = albedo * countryLight(sky, sun, moon, n, shade);
    if (water) {
      // The water mirrors the sky (and its deck) along the reflected ray, by Fresnel; ripples and
      // rain rings break it.
      vec3 rings = rainRipples(p.xz * 2.0, t, rain);
      vec2 tilt = rings.xy * 0.4 + 0.03 * (vec2(vnoise(p.xz * 0.4 + vec2(tm * 0.3, 0.0)), vnoise(p.zx * 0.4 - vec2(0.0, tm * 0.25))) - 0.5);
#if WATER_TIER >= WATER_RIPPLES
      // The breeze's cat's-paws (ripples.ts) tilt it further.
      vec3 paws = countryRipples(p, rd, seen * cellAngle);
      tilt += paws.xy;
#endif
      vec3 nw = normalize(vec3(tilt.x, 1.0, tilt.y));
      vec3 refl = reflect(rd, nw);
      refl.y = max(refl.y, 0.02);
      vec3 rc = countryToCamera(refl);
      vec3 mirror = countrySkyDome(sky, rc, rain);
      vec4 deck = countryDeck(sky, rc, t, cover, wind, rain);
      mirror = mix(mirror, deck.rgb, deck.a);
      float fres = fresnelSchlick(max(dot(-rd, nw), 0.0), 0.02, 0.0);
      float mirrorShare = mix(0.35, 1.0, fres) * (waterDepth > 0.1 ? 1.0 : 0.6);
      col = mix(col, mirror * 0.92, mirrorShare) + rings.z * 0.12 * mirror;
      glint = 0.4 * smoothstep(0.92, 1.0, dot(refl, sun)) * (1.0 - overcast);
      col += sky.sunColor * glint * 0.8;
#if WATER_TIER >= WATER_RIPPLES
      // The cat's-paws glitter in the dither.
      glint = max(glint, smoothstep(0.3, 0.9, paws.z) * (1.0 - grey));
#endif
    } else if (wet > 0.0) {
      col += haze * 0.12 * wetGloss(wet, n.y) * glossy * 3.0;
    }
    if (lamp > 0.0) {
      col = mix(col, COUNTRY_AMBER, lamp);
      accent = lamp;
    }
    // Atmospheric perspective: the far land paler and bluer, more so in haze, rain and fog.
    float thick = 1.0 / (5200.0 - 2600.0 * overcast - 2500.0 * K_fog);
    col = mix(col, haze * mix(vec3(1.0), vec3(0.84, 0.88, 0.95), grey), 1.0 - exp(-seen * thick));
    // Mist lying in the country bottoms (thicker low down), when the fog knob is up.
#if COUNTRY_HAS_FOG
    if (K_fog > 0.0) {
      float low = exp(-max(p.y - 20.0, 0.0) / 60.0);
      col = mix(col, haze * 1.05 + 0.03, fogAmount(K_fog, clamp(seen / 3000.0, 0.0, 1.0), low) * 0.85);
    }
#endif
    // The camera's descent: the morning's haze thinning off the land.
    if (lift > 0.0) col = mix(col, haze, 0.4 * lift);
  } else {
    // Sky, with the far ridges beyond the map.
    col = countrySkyDome(sky, dirCam, rain);
    vec4 deck = countryDeck(sky, dirCam, t, cover, wind, rain);
    col += skyStars(sky, dirCam, K_stars, cellAngle) * vec3(0.9, 0.93, 1.0) * (1.0 - deck.a);
    col = mix(col, deck.rgb, deck.a);
    float bearing = atan(dirCam.x, dirCam.z);
    vec2 ridge = countryRidges(bearing);
    float e = dirCam.y - 0.25 * lift;
    vec3 ridgeFar = mix(haze, haze * vec3(0.78, 0.84, 0.95), 0.6 * (1.0 - grey)) + sky.night * 0.02;
    vec3 ridgeNear = mix(haze, haze * vec3(0.62, 0.72, 0.86), 0.7 * (1.0 - grey));
    if (e < ridge.y) col = mix(col, ridgeFar, hardEdge(1.0 - smoothstep(ridge.y - cellAngle, ridge.y + cellAngle, e)));
    if (e < ridge.x) col = mix(col, ridgeNear, hardEdge(1.0 - smoothstep(ridge.x - cellAngle, ridge.x + cellAngle, e)));
#if COUNTRY_HAS_FOG
    if (K_fog > 0.0) col = mix(col, haze * 1.05 + 0.03, fogAmount(K_fog, 1.0, max(e, 0.0) * 30.0) * 0.6);
#endif
  }

  // Lamplight round lit windows, smoke drifting over what lies behind.
  col += COUNTRY_AMBER * min(glow, 2.0) * 0.1 * dark * (1.0 + wet);
  vec3 air = sky.ambient + 0.5 * sky.sunColor + 0.4 * sky.moonColor;
  col = mix(col, vec3(0.8, 0.8, 0.83) * air, clamp(smoke, 0.0, 1.0) * 0.7);

  // The starlings over the far fields at dusk, in front of whatever lies farther (murmuration.ts).
#if COUNTRY_HAS_MURMURATION
  if (mapped) countryMurmuration(col, seen, accent, uv, ahead, sky, haze, tod, rain, overcast);
#endif

  // Birds crossing the country, in front of whatever lies farther along the ray (life.ts).
#if COUNTRY_HAS_BIRDS
  if (K_birds > 0.0) {
    BirdHit bird = countryBirds(uv, aspect, eye, rain, K_snow, pxl);
    if (bird.cover > 0.5 && bird.depth < (seen < 7999.0 ? seen * ahead : 1e9)) {
      vec3 lit = bird.albedo * (sky.ambient * 1.3 + 0.5 * sky.sunColor + 0.3 * sky.moonColor);
      col = mix(lit, haze, 1.0 - exp(-bird.depth / 5200.0));
    }
  }
#endif

  // Rain and snow through the air, as far as the first surface (compressed: the land lies far off).
#if COUNTRY_HAS_RAIN
  if (rain > 0.0) {
    Precip pr = rainFall(screenUv, aspect, t, rain, wind, 1.0 - exp(-seen / 650.0));
    col = mix(col, mix(vec3(dot(haze, LUMA)) * vec3(0.94, 0.97, 1.0), haze, 0.4), pr.veil);
    vec3 dropCol = max(greyed(haze, vec3(1.0), 0.5) * 1.2, vec3(0.08));
    col = mix(col, dropCol * (1.0 - 0.15 * pr.near), pr.cover);
  }
#endif
#if COUNTRY_HAS_SNOW
  if (K_snow > 0.0) {
    Precip ps = snowFall(screenUv, aspect, t, K_snow, wind, 1.0 - exp(-seen / 450.0));
    vec3 flake = vec3(0.95, 0.96, 1.0) * clamp(air * 1.3 + 0.1, 0.0, 1.0);
    col = mix(col, flake * 0.92, ps.veil);
    float contrast = clamp((dot(flake, LUMA) - dot(col, LUMA)) * 3.0, 0.0, 1.0);
    col = mix(col, flake, clamp(ps.cover, 0.0, 1.0) * (0.85 - 0.2 * ps.near) * contrast);
  }
#endif
  if (arrive > 0.0 || leave > 0.0) col = mix(col, vec3(dot(col, LUMA)), 0.2 * leave);
  vec3 rgb = clamp(col, 0.0, 1.0);
  Shade o = shadeOf(rgb, inkOf(rgb, 1.1, 1.0), clamp(accent, 0.0, 1.0));
  o.shimmer = glint * 0.3;
  return o;
}
`;
