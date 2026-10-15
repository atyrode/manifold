// The valley: the terrain toolbox's landscape (sims/terrain.ts through shaders/lib/terrain.ts) seen
// from its vantage, ray-marched as a height field in metres under the shared sky and weather.
//
// World frame: map metres, x east, z north, y up. The camera stands at the vantage (the records'
// eye) looking along VALLEY_HEADING, level, through the shared viewRay (horizon VALLEY_HORIZON,
// focal one screen height); the sky library's frame is the camera's, so the sun sets where the sky
// shows it and lights the land from there. The surface a ray meets is the ground or the water over
// it, plus the woods' canopy where the woodland knob grows them; buildings are the shared shapes
// (shaders/buildings.ts) drawn on the screen at the projection of their footing and hidden by any
// nearer land; the bridge is a stone box with an arch.
import { buildingsGlsl } from "../../shaders/buildings.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { terrainGlsl } from "../../shaders/lib/terrain.ts";
import { TERRAIN_HOUSE } from "../../sims/terrain.ts";
import { VALLEY_MAP } from "./sim.ts";

/** Seconds of the entrance (the camera comes down out of the sky and settles) and exit. */
export const VALLEY_PASSAGE = { enter: 2.8, exit: 1.4 } as const;

/** The ray march's numbers: highest ground, farthest look, slope bound, shortest steps, steps. */
export const VALLEY_MARCH = {
  top: 520,
  far: 7000,
  slope: 0.85,
  minStep: 1.5,
  relStep: 0.006,
  steps: 72,
  refine: 5,
} as const;

export const valleyGlsl = /* glsl */ `
${terrainGlsl}
${buildingsGlsl}
const float VALLEY_EXTENT = ${glslFloat(VALLEY_MAP.extent)};
const float VALLEY_HORIZON = 0.63;
const float VALLEY_FOV = 0.78;          // a little long, so the middle distance reads at the dither
const float VALLEY_FOCAL = 1.2138;      // viewRay's focal length there, screen heights: 0.5 / tan(fov / 2)
const vec2 VALLEY_HEADING = vec2(0.70710678, 0.70710678);
const float VALLEY_CANOPY = 15.0;       // woodland canopy over the ground, metres
const float VALLEY_HOUSE = ${glslFloat(TERRAIN_HOUSE)}; // metres a house unit (a cottage gable, drawn half again life size)
const float VALLEY_CLOUD_BASE = 900.0;  // the cloud deck over the eye, metres
const float VALLEY_TOP = ${glslFloat(VALLEY_MARCH.top)};
const float VALLEY_FAR = ${glslFloat(VALLEY_MARCH.far)};
const vec3 VALLEY_AMBER = vec3(1.0, 0.7, 0.3);
const vec3 VALLEY_SNOW = vec3(0.9, 0.92, 0.95);

// The camera's frame on the map (level): right, forward.
vec3 valleyRight;
vec3 valleyFwd;
// The woodland knob's threshold on the woods' suitability.
float valleyWoodTh;

// Camera frame -> world, and back.
vec3 valleyToWorld(vec3 d) {
  return valleyRight * d.x + vec3(0.0, d.y, 0.0) + valleyFwd * d.z;
}
vec3 valleyToCamera(vec3 d) {
  return vec3(dot(d, valleyRight), d.y, dot(d, valleyFwd));
}

// How much of the woods stands here, 0..1: the woodland suitability over the knob's threshold,
// cleared from water, streams, roads (while drawn) and yards.
float valleyWoods(vec4 ground, vec4 cover) {
  if (K_woodland <= 0.0) return 0.0;
  float on = smoothstep(valleyWoodTh, valleyWoodTh + 0.07, cover.z - 1.5 * max(cover.w, 0.0));
  on *= smoothstep(0.5, 3.5, cover.y) * smoothstep(-0.3, -1.5, terrainWater(ground));
  if (K_roads > 0.5) on *= smoothstep(1.5, 5.0, cover.x);
  return on;
}

// What stands on the ground: the woods' canopy (crowns about 7 m across) or a lone tree in a hedge
// or on a bank (the yard channel's -1 texels, rounded by the filtering), metres.
float valleyCanopy(vec2 p, vec4 cover, float woods) {
  float lone = K_woodland > 0.0 ? 10.0 * smoothstep(0.12, 0.75, -cover.w) : 0.0;
  return max(woods * VALLEY_CANOPY * (0.62 + 0.38 * vnoise(p / 6.5)), lone);
}

float valleyHeight(vec2 p) {
  vec4 g = terrainGround(uSim0, p, VALLEY_EXTENT);
  vec4 c = terrainCover(uSim1, p, VALLEY_EXTENT);
  return terrainSurface(g) + valleyCanopy(p, c, valleyWoods(g, c));
}

// March the land from the eye (slope-bound steps, never shorter than a share of the distance), then
// bisect the crossing step. -1: sky, or off the map.
float valleyMarch(vec3 ro, vec3 rd) {
  float t = 0.0;
  if (ro.y > VALLEY_TOP) {
    if (rd.y >= 0.0) return -1.0;
    t = (ro.y - VALLEY_TOP) / -rd.y;
  }
  float last = t;
  bool hit = false;
  for (int i = 0; i < ${VALLEY_MARCH.steps}; i++) {
    vec3 p = ro + rd * t;
    if (p.x < -40.0 || p.z < -40.0 || p.x > VALLEY_EXTENT + 40.0 || p.z > VALLEY_EXTENT + 40.0) return -1.0;
    float gap = p.y - valleyHeight(p.xz);
    if (gap < 0.0) {
      hit = true;
      break;
    }
    if (rd.y >= 0.0 && p.y > VALLEY_TOP) return -1.0;
    last = t;
    t += max(gap / (${glslFloat(VALLEY_MARCH.slope)} + abs(rd.y)), ${glslFloat(VALLEY_MARCH.relStep)} * t + ${glslFloat(VALLEY_MARCH.minStep)});
    if (t > VALLEY_FAR) return -1.0;
  }
  if (!hit) return t;
  float lo = last;
  float hi = t;
  for (int i = 0; i < ${VALLEY_MARCH.refine}; i++) {
    float mid = 0.5 * (lo + hi);
    vec3 p = ro + rd * mid;
    if (p.y > valleyHeight(p.xz)) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Sunlight reaching p over the land: a march toward the light with a soft penumbra.
float valleyShadow(vec3 p, vec3 l) {
  if (l.y <= 0.0) return 0.0;
  float lit = 1.0;
  float t = 3.0;
  for (int i = 0; i < 18; i++) {
    vec3 q = p + l * t;
    if (q.y > VALLEY_TOP) break;
    float gap = q.y - valleyHeight(q.xz);
    lit = min(lit, 6.0 * gap / t);
    if (lit < 0.01) break;
    t += clamp(gap * 0.7, 2.0 + 0.05 * t, 260.0);
  }
  return clamp(lit, 0.0, 1.0);
}

// Distant ridges beyond the map, as the sky's horizon: (elevation of the near one's top, the far
// one's) at a bearing (radians from straight ahead).
vec2 valleyRidges(float bearing) {
  float a = 0.6 * vnoise(vec2(bearing * 3.1, 1.7)) + 0.4 * vnoise(vec2(bearing * 7.3, 4.1));
  float b = 0.6 * vnoise(vec2(bearing * 2.2 + 9.0, 3.3)) + 0.4 * vnoise(vec2(bearing * 5.9, 8.2));
  return vec2(0.012 + 0.03 * a, 0.026 + 0.034 * b);
}

// Light on a surface with normal n (world): sun and moon with a wrap, sky fill, a dark-adapted
// night that stays legible. shade: how much sun gets through (shadows, cloud).
vec3 valleyLight(Sky sky, vec3 sun, vec3 moon, vec3 n, float shade) {
  float s = clamp((dot(n, sun) + 0.15) / 1.15, 0.0, 1.0) * shade;
  float mo = clamp((dot(n, moon) + 0.2) / 1.2, 0.0, 1.0);
  vec3 adapted = sky.night * (vec3(0.07, 0.09, 0.14) * (0.7 + 0.3 * n.y) + sky.moonColor * (0.35 + 0.65 * mo));
  return sky.sunColor * s * 1.1 + sky.ambient * (0.55 + 0.45 * n.y) + adapted;
}

// The sky along a camera-frame direction, under the weather: the dome greyed by rain, the deck.
vec3 valleySkyDome(Sky sky, vec3 dir, float rain) {
  vec3 c = skyColor(sky, dir);
  float grey = smoothstep(0.0, 0.05, rain);
  return greyed(c, vec3(0.92, 0.95, 1.0), 0.6 * grey) * (1.0 - 0.2 * rain);
}

vec4 valleyDeck(Sky sky, vec3 dir, float t, float cover, float wind, float rain) {
  vec4 c = skyClouds(sky, normalize(vec3(dir.x, dir.y * (1.0 + 0.8 * rain), dir.z)), t, cover, wind);
  float grey = smoothstep(0.0, 0.05, rain);
  c.rgb = greyed(c.rgb, vec3(0.94, 0.96, 1.0), 0.6 * grey) * (1.0 + 0.2 * grey - 0.35 * rain);
  return c;
}

// A field's colour and the relief of its rows. kind: TERRAIN_FIELD_*; h: the parcel's hash; r: row
// space along and across its heading (metres); foot: metres a cell covers there.
vec3 valleyField(float kind, float h, vec2 r, float foot, out float rows) {
  float h2 = fract(h * 13.7);
  float hold = smoothstep(2.5, 6.0, 3.2 / foot);
  rows = 0.5 + 0.5 * hold * sin(r.y * TAU / 3.2);
  float tram = smoothstep(4.0, 9.0, 24.0 / foot) * (1.0 - smoothstep(0.0, 0.7, abs(fract(r.y / 24.0) - 0.5) * 24.0 - 0.3));
  vec3 c;
  if (kind < 0.5) c = mix(vec3(0.74, 0.6, 0.28), vec3(0.82, 0.68, 0.33), h2);              // wheat
  else if (kind < 1.5) c = mix(vec3(0.8, 0.74, 0.47), vec3(0.86, 0.8, 0.55), h2);          // barley
  else if (kind < 2.5) c = mix(vec3(0.3, 0.46, 0.18), vec3(0.38, 0.52, 0.2), h2);          // pasture
  else if (kind < 3.5) c = mix(vec3(0.44, 0.52, 0.22), vec3(0.52, 0.56, 0.26), h2);        // hay meadow
  else if (kind < 4.5) c = mix(vec3(0.4, 0.29, 0.19), vec3(0.48, 0.35, 0.23), h2);         // ploughed
  else c = mix(vec3(0.86, 0.78, 0.16), vec3(0.93, 0.84, 0.22), h2);                        // rapeseed
  if (kind < 1.5 || kind > 4.5) c *= 0.92 + 0.14 * rows - 0.1 * tram;
  else if (kind < 3.5) c *= 0.94 + 0.1 * hold * (0.5 + 0.5 * sin(r.y * TAU / 9.0));   // mowing stripes
  else c *= 0.86 + 0.24 * rows;                                                             // furrows
  return c;
}

// The bridge: a stone deck from 'from' to 'to' at deck height, its arch's crown under it, standing
// in the water. Distance along the ray to it (-1 none) and its face normal.
float valleyBridge(TerrainBridge b, vec3 ro, vec3 rd, out vec3 n, out vec2 local) {
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

// The building under this pixel, nearer than zLimit (camera depth): its face (buildings.ts's codes,
// 0 none), window, how it faces (flip), its hash, kind, depth and a cell in its units; the glow of
// lit windows and the smoke of chimneys around.
struct ValleyFind { float face; float pane; float flip; float hash; float kind; float z; float px; float across; };

ValleyFind valleyBuildings(vec3 eye, vec2 q, float pxl, float zLimit, float tod, float dark, float t, float wind, inout float glow, inout float smoke) {
  ValleyFind f;
  f.face = 0.0;
  f.pane = 0.0;
  f.flip = 1.0;
  f.hash = 0.0;
  f.kind = 0.0;
  f.z = zLimit;
  f.px = 1.0;
  f.across = 0.0;
  ivec2 counts = terrainCounts(uSim3);
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
      float unit = castle ? 5.5 : VALLEY_HOUSE * (b.kind > TERRAIN_BUILDING_BARN - 0.5 ? 1.25 : 1.0);
      vec2 l = vec2(cos(b.facing), sin(b.facing));
      if (dot(l, valleyFwd.xz) < 0.0) l = -l;
      float lr = dot(l, valleyRight.xz);
      float flip = lr < 0.0 ? -1.0 : 1.0;
      float len = castle ? 1.0 : b.length * clamp(abs(lr), 0.35, 1.0);
      // Its front corner: half its length back toward us along the long wall.
      vec3 base = castle ? b.at : b.at - vec3(l.x, 0.0, l.y) * 0.5 * b.length * unit;
      vec3 db = base - eye;
      float zb = dot(db, valleyFwd);
      if (zb < 20.0 || zb > f.z) continue;
      vec2 at = vec2(dot(db, valleyRight), db.y) / zb;
      float scale = zb / unit;
      vec2 h = (q - at) * scale;
      float px = pxl * scale;
      float recede = clamp(-db.y / zb * max(dot(l, valleyFwd.xz), 0.0) / max(abs(lr), 0.35), 0.03, 0.9);
      float pane = 0.0;
      float across = 0.0;
      float face = 0.0;
      if (castle) {
        if (abs(h.x) < 9.0 && h.y > -1.5 && h.y < 9.5) {
          float slit = 0.0;
          face = buildingCastle(h, 0.0, px, flip, step(0.45, fract(b.hash * 13.1)), across, slit);
          pane = slit;
        }
      } else if (b.kind > TERRAIN_BUILDING_CHURCH - 0.5 && b.kind < TERRAIN_BUILDING_CHURCH + 0.5) {
        h.x *= flip;
        if (h.x > -1.2 && h.x < 2.9 && h.y > -0.3 && h.y < 4.6) face = buildingChurch(h, recede, -0.3, px, pane);
      } else {
        h.x *= flip;
        if (h.x > -1.15 && h.x < len + 0.15 && h.y > -0.3 && h.y < 0.75 + 0.55 + 0.6 + len * recede) {
          face = buildingCottage(h, len, 0.75, 0.55, recede, b.kind < 0.5, -0.3, px, pane);
        }
        // Lit windows warm the walls and the ground around; a lit hearth smokes.
        float lit = buildingWindow(fract(b.hash * 91.0 + 0.13), tod, dark, 0.7) + buildingWindow(fract(b.hash * 91.0 + 0.57), tod, dark, 0.7);
        vec2 g = h - vec2(0.3, 0.4);
        glow += lit * exp(-dot(g, g) * 0.3);
        if (b.kind < 0.5 && fract(b.hash * 7.7) < 0.6) {
          vec2 top = buildingStack(len, 0.75, 0.55, recede);
          vec2 topScreen = at + vec2(flip * top.x, top.y) / scale;
          smoke = max(smoke, buildingSmoke(q, topScreen, 9.0 / scale, b.hash, uMotionTime, wind) * (0.4 + 0.6 * dark));
        }
      }
      if (face > 0.5) {
        f.face = face;
        f.pane = pane;
        f.flip = flip;
        f.hash = b.hash;
        f.kind = b.kind;
        f.z = zb;
        f.px = px;
        f.across = across;
      }
    }
  }
  return f;
}

Shade sceneValley(vec2 screenUv, vec2 cell, float t) {
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
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y - VALLEY_HORIZON) / VALLEY_FOCAL;
  float cellAngle = pxl / VALLEY_FOCAL;
  valleyFwd = vec3(VALLEY_HEADING.x, 0.0, VALLEY_HEADING.y);
  valleyRight = vec3(VALLEY_HEADING.y, 0.0, -VALLEY_HEADING.x);
  valleyWoodTh = 1.0 - 0.75 * K_woodland;
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
  // Rain hangs a grey deck over the sky: the sun is lost, its light diffused (as country does).
  float grey = smoothstep(0.0, 0.05, rain);
  float lost = grey * (0.5 + 0.45 * rain);
  vec3 diffused = sky.sunColor * lost * (0.55 - 0.3 * rain);
  sky.sunColor *= 1.0 - lost;
  sky.moonColor *= 1.0 - grey * (0.4 + 0.3 * rain);
  sky.ambient = greyed(sky.ambient, vec3(0.95, 0.98, 1.04), 0.3 * grey) * (1.0 - 0.25 * rain) + diffused;
  float cover = clamp(max(K_clouds + 0.4 * K_snow, weatherOvercast(rain, K_snow)), 0.0, 1.0);
  float overcast = smoothstep(0.55, 1.0, cover);
  float dark = clamp(1.0 - smoothstep(-0.12, 0.2, sky.sun.y) + 0.3 * overcast + 0.2 * rain, 0.0, 1.0);
  vec3 sun = valleyToWorld(sky.sun);
  vec3 moon = valleyToWorld(sky.moon);

  vec3 dirCam = viewRay(uv, aspect, VALLEY_HORIZON, VALLEY_FOV);
  vec3 rd = valleyToWorld(dirCam);
  bool mapped = uSimOn.x > 0.5 && uSimOn.w > 0.5;
  vec3 eye = mapped ? terrainEye(uSim3) : vec3(200.0, 300.0, 200.0);
  eye.y += 220.0 * lift;

  // The horizon in this heading: the colour the land fades into.
  vec3 haze = valleySkyDome(sky, normalize(vec3(dirCam.x, 0.015, 1.0)), rain) + sky.night * vec3(0.03, 0.04, 0.07);
  float tHit = mapped ? valleyMarch(eye, rd) : -1.0;
  float zLimit = tHit > 0.0 ? tHit * dot(rd, valleyFwd) : 1e6;

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
  ValleyFind found;
  found.face = 0.0;
  if (mapped) {
#if VALLEY_HAS_ROADS
    if (K_roads > 0.5) {
      tBridge = valleyBridge(terrainBridge(uSim3), eye, rd, bridgeN, bridgeLocal);
      if (tBridge > 0.0 && (tHit < 0.0 || tBridge < tHit)) zLimit = tBridge * dot(rd, valleyFwd);
      else tBridge = -1.0;
    }
#endif
    found = valleyBuildings(eye, q, cellAngle, zLimit, tod, dark, t, wind, glow, smoke);
  }

  if (found.face > 0.5 || tBridge > 0.0 || tHit > 0.0) {
    vec3 n;
    vec3 albedo;
    vec3 p;
    float porous = 0.6;
    float glossy = 0.05;
    float shade = 1.0;
    float lamp = 0.0;
    float snowy = -1.0;   // snow on a building: its own cover; below 0 the land's
    bool water = false;
    float waterDepth = 0.0;
    float ripple = 0.0;
    if (found.face > 0.5) {
      // A building: walls, roofs, windows (as the countryside paints them).
      float zb = found.z;
      seen = zb / max(dot(rd, valleyFwd), 1e-3);
      p = eye + rd * seen;
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
      vec3 gableN = vec3(-0.62, 0.0, -0.78);
      vec3 wallN = vec3(0.78, 0.0, -0.62);
      vec3 nc = gableN;
      float f = found.face;
      if (castle) {
        // Castle faces: 1 wall, 2 round tower, 3 tops, 4 gate, 5 keep front, 6 keep side, 7 roofs.
        albedo = f > 6.5 ? vec3(0.3, 0.3, 0.34) : (f > 3.5 && f < 4.5 ? vec3(0.12, 0.1, 0.09) : wall * (f > 5.5 ? 0.88 : 1.0));
        nc = f > 2.5 && f < 3.5 ? vec3(0.0, 1.0, 0.0) : (f > 5.5 && f < 6.5 ? wallN : normalize(vec3(found.across * 0.8, 0.0, -1.0)));
        if (f > 6.5) nc = normalize(vec3(found.across, 0.6, -0.8));
        if (found.pane > 0.5) {
          float lit = buildingWindow(fract(found.pane * 0.37 + found.hash), tod, dark, 0.5);
          if (lit > 0.5 || found.px < 0.3) albedo = vec3(0.08, 0.08, 0.1);
          lamp = lit;
        }
        snowy = f > 2.5 && f < 3.5 ? 1.0 : (f > 6.5 ? 0.6 : 0.0);
      } else {
        if (f < 1.5 || (f > 4.5 && f < 5.5)) {
          albedo = wall;
        } else if (f < 2.5 || (f > 5.5 && f < 6.5)) {
          albedo = wall * 0.97;
          nc = wallN;
        } else if (f < 3.5) {
          albedo = roof;
          nc = normalize(vec3(0.42, 0.78, -0.46));
          snowy = 1.0;
          glossy = 0.2;
          porous = 0.1;
        } else if (f < 4.5) {
          albedo = vec3(0.5, 0.3, 0.22);
        } else if (f < 8.5) {
          albedo = vec3(0.45, 0.47, 0.5);
          nc = f < 7.5 ? normalize(vec3(-0.55, 0.45, -0.7)) : normalize(vec3(0.6, 0.45, -0.66));
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
        nc.x *= found.flip;
      }
      n = normalize(valleyToWorld(nc));
      shade = mapped ? valleyShadow(p + n * 1.5, sun) : 1.0;
      if (snowy > 0.0) snowy *= snowCover(n, p.xz * 0.3, lying);
    } else if (tBridge > 0.0) {
      seen = tBridge;
      p = eye + rd * tBridge;
      n = normalize(bridgeN);
      // Coursed stone, the voussoirs of its arch darker.
      vec2 s = bridgeLocal / vec2(1.1, 0.45);
      float course = step(0.08, fract(s.y)) * step(0.06, fract(s.x + 0.5 * floor(s.y)));
      albedo = vec3(0.56, 0.53, 0.47) * (0.86 + 0.14 * course);
      porous = 0.15;
      glossy = 0.1;
      shade = valleyShadow(p + n * 1.0, sun);
      snowy = smoothstep(0.6, 0.9, n.y);
    } else {
      seen = tHit;
      p = eye + rd * tHit;
      vec4 g = terrainGround(uSim0, p.xz, VALLEY_EXTENT);
      vec4 c = terrainCover(uSim1, p.xz, VALLEY_EXTENT);
      float woods = valleyWoods(g, c);
      float foot = tHit * cellAngle;
      vec3 ground = terrainNormal(g);
      float over = valleyCanopy(p.xz, c, woods);
      waterDepth = terrainWater(g);
      if (over > 1.5 && p.y > terrainSurface(g) + 0.45 * over) {
        // The woods or a lone tree: crowns lit on their sunward sides, darker in between (the
        // surface's own slope, over a cell or more), broadleaf and pine.
        float e = max(1.6, foot);
        vec2 slope = vec2(valleyHeight(p.xz + vec2(e, 0.0)) - valleyHeight(p.xz - vec2(e, 0.0)), valleyHeight(p.xz + vec2(0.0, e)) - valleyHeight(p.xz - vec2(0.0, e))) / (2.0 * e);
        n = normalize(vec3(-slope.x, 1.0, -slope.y));
        float species = vnoise(p.xz / 40.0 + 3.7);
        vec3 leaf = mix(vec3(0.17, 0.3, 0.11), vec3(0.23, 0.35, 0.13), vnoise(p.xz / 13.0));
        leaf = mix(leaf, vec3(0.1, 0.2, 0.12), smoothstep(0.62, 0.75, species));
        albedo = leaf * (0.8 + 0.25 * vnoise(p.xz / 3.0));
        porous = 0.3;
        glossy = 0.08;
        shade = valleyShadow(vec3(p.x, terrainSurface(g) + over + 0.5, p.z), sun);
      } else if (waterDepth > 0.02) {
        water = true;
        n = vec3(0.0, 1.0, 0.0);
        albedo = mix(vec3(0.16, 0.2, 0.15), vec3(0.06, 0.1, 0.1), smoothstep(0.0, 2.0, waterDepth));
        shade = valleyShadow(p + vec3(0.0, 0.5, 0.0), sun);
      } else {
        n = ground;
        // Fine relief the map is too coarse for, where a cell is small enough to show it.
        vec3 bump = vnoiseD(p.xz / 9.0);
        n = normalize(n + vec3(-bump.y, 0.0, -bump.z) * 0.3 * smoothstep(1.5, 0.4, foot));
        TerrainParcel parcel = terrainParcel(uSim2, uSim3, p.xz, VALLEY_EXTENT);
        float h = fract(parcel.id * 0.618034);
        vec3 grass = mix(vec3(0.33, 0.47, 0.18), vec3(0.4, 0.52, 0.2), smoothstep(0.3, 0.7, vnoise(p.xz / 40.0)));
        albedo = grass;
        if (parcel.id > 0.5) {
          vec2 r = vec2(dot(p.xz - parcel.site, parcel.axis), dot(p.xz - parcel.site, vec2(-parcel.axis.y, parcel.axis.x)));
          vec2 nb = vec2(dot(parcel.normal, valleyRight.xz), dot(parcel.normal, valleyFwd.xz));
          float footAcross = foot * length(vec2(nb.x, nb.y / max(abs(rd.y), 0.08)));
          float rows = 0.5;
          vec3 field = valleyField(parcel.kind, h, r, foot / max(abs(rd.y), 0.12), rows);
          // Hedges along the borders, never thinner than half a cell across so the patchwork holds
          // far off, fading out once fields shrink to a few cells; a greener verge either side.
          float hedgeHalf = max(1.3, 0.45 * footAcross);
          float hedge = hardFill(parcel.border - hedgeHalf, 0.5 * footAcross) * (1.0 - smoothstep(18.0, 40.0, footAcross));
          float verge = 1.0 - smoothstep(hedgeHalf, hedgeHalf + 2.5, parcel.border);
          albedo = mix(field, grass * 1.05, verge * 0.5);
          albedo = mix(albedo, vec3(0.11, 0.19, 0.08), hedge);
          porous = parcel.kind > 3.5 && parcel.kind < 4.5 ? 0.85 : 0.5;
        }
        // Yards and gardens round the buildings.
        float yard = smoothstep(0.35, 0.8, c.w);
        albedo = mix(albedo, mix(vec3(0.38, 0.45, 0.22), vec3(0.52, 0.47, 0.37), step(0.55, vnoise(p.xz / 7.0))), yard);
        // Streams: a ribbon of water mirroring the sky.
        if (c.y < 0.0) {
          water = true;
          albedo = vec3(0.12, 0.16, 0.13);
          waterDepth = 0.4;
        }
#if VALLEY_HAS_ROADS
        if (K_roads > 0.5) {
          // The roads: pale packed gravel, never thinner than about half a cell so they hold far off.
          float road = hardFill(c.x - max(0.0, 0.45 * foot / max(abs(rd.y), 0.25) - 2.0), max(foot, 0.3) * 0.6);
          vec3 gravel = mix(vec3(0.68, 0.62, 0.5), vec3(0.58, 0.52, 0.42), vnoise(p.xz / 3.0));
          albedo = mix(albedo, gravel, road);
          porous = mix(porous, 0.3, road);
          glossy = mix(glossy, 0.25, road);
          if (road > 0.5 && wet > 0.0) {
            float puddle = rainPuddles(p.xz, wet);
            if (puddle > 0.5) {
              water = true;
              waterDepth = 0.05;
            }
          }
        }
#endif
        shade = valleyShadow(p + n * 1.0, sun);
      }
    }
    // Cloud shadows sweeping over the land.
    float sunShade = 1.0 - 0.75 * overcast;
#if CLOUD_TIER >= CLOUD_SHADOWS
    if (K_shadows > 0.0 && sky.sun.y > 0.0) sunShade *= 1.0 - K_shadows * skyCloudShadow(sky, valleyToCamera(p - eye), VALLEY_CLOUD_BASE, 1.0 + 0.8 * rain, t, cover, wind);
#endif
    shade *= sunShade;
    albedo = wetten(albedo, wet, porous);
    float buried = snowy >= 0.0 ? snowy : snowCover(n, p.xz * 0.25, lying) * (water ? 0.0 : 1.0);
    albedo = mix(albedo, VALLEY_SNOW, buried);
    col = albedo * valleyLight(sky, sun, moon, n, shade);
    if (water) {
      // The water mirrors the sky (and its deck) along the reflected ray, by Fresnel; ripples and
      // rain rings break it.
      vec3 rings = rainRipples(p.xz * 2.0, t, rain);
      vec2 tilt = rings.xy * 0.4 + 0.03 * (vec2(vnoise(p.xz * 0.4 + vec2(tm * 0.3, 0.0)), vnoise(p.zx * 0.4 - vec2(0.0, tm * 0.25))) - 0.5);
      vec3 nw = normalize(vec3(tilt.x, 1.0, tilt.y));
      vec3 refl = reflect(rd, nw);
      refl.y = max(refl.y, 0.02);
      vec3 rc = valleyToCamera(refl);
      vec3 mirror = valleySkyDome(sky, rc, rain);
      vec4 deck = valleyDeck(sky, rc, t, cover, wind, rain);
      mirror = mix(mirror, deck.rgb, deck.a);
      float fres = fresnelSchlick(max(dot(-rd, nw), 0.0), 0.02, 0.0);
      float mirrorShare = mix(0.35, 1.0, fres) * (waterDepth > 0.1 ? 1.0 : 0.6);
      col = mix(col, mirror * 0.92, mirrorShare) + rings.z * 0.12 * mirror;
      glint = 0.4 * smoothstep(0.92, 1.0, dot(refl, sun)) * (1.0 - overcast);
      col += sky.sunColor * glint * 0.8;
    } else if (wet > 0.0) {
      col += haze * 0.12 * wetGloss(wet, n.y) * glossy * 3.0;
    }
    if (lamp > 0.0) {
      col = mix(col, VALLEY_AMBER, lamp);
      accent = lamp;
    }
    // Atmospheric perspective: the far land paler and bluer, more so in haze, rain and fog.
    float thick = 1.0 / (5200.0 - 2600.0 * overcast - 2500.0 * K_fog);
    col = mix(col, haze * mix(vec3(1.0), vec3(0.84, 0.88, 0.95), grey), 1.0 - exp(-seen * thick));
    // Mist lying in the valley bottoms (thicker low down), when the fog knob is up.
#if VALLEY_HAS_FOG
    if (K_fog > 0.0) {
      float low = exp(-max(p.y - 20.0, 0.0) / 60.0);
      col = mix(col, haze * 1.05 + 0.03, fogAmount(K_fog, clamp(seen / 3000.0, 0.0, 1.0), low) * 0.85);
    }
#endif
    // The camera's descent: the morning's haze thinning off the land.
    if (lift > 0.0) col = mix(col, haze, 0.4 * lift);
  } else {
    // Sky, with the far ridges beyond the map.
    col = valleySkyDome(sky, dirCam, rain);
    vec4 deck = valleyDeck(sky, dirCam, t, cover, wind, rain);
    col += skyStars(sky, dirCam, K_stars, cellAngle) * vec3(0.9, 0.93, 1.0) * (1.0 - deck.a);
    col = mix(col, deck.rgb, deck.a);
    float bearing = atan(dirCam.x, dirCam.z);
    vec2 ridge = valleyRidges(bearing);
    float e = dirCam.y - 0.25 * lift;
    vec3 ridgeFar = mix(haze, haze * vec3(0.78, 0.84, 0.95), 0.6 * (1.0 - grey)) + sky.night * 0.02;
    vec3 ridgeNear = mix(haze, haze * vec3(0.62, 0.72, 0.86), 0.7 * (1.0 - grey));
    if (e < ridge.y) col = mix(col, ridgeFar, hardEdge(1.0 - smoothstep(ridge.y - cellAngle, ridge.y + cellAngle, e)));
    if (e < ridge.x) col = mix(col, ridgeNear, hardEdge(1.0 - smoothstep(ridge.x - cellAngle, ridge.x + cellAngle, e)));
#if VALLEY_HAS_FOG
    col = mix(col, haze * 1.05 + 0.03, fogAmount(K_fog, 1.0, max(e, 0.0) * 30.0) * 0.6);
#endif
  }

  // Lamplight round lit windows, smoke drifting over what lies behind.
  col += VALLEY_AMBER * min(glow, 2.0) * 0.1 * dark * (1.0 + wet);
  vec3 air = sky.ambient + 0.5 * sky.sunColor + 0.4 * sky.moonColor;
  col = mix(col, vec3(0.8, 0.8, 0.83) * air, clamp(smoke, 0.0, 1.0) * 0.7);

  // Rain and snow through the air, as far as the first surface (compressed: the land lies far off).
#if VALLEY_HAS_RAIN
  if (rain > 0.0) {
    Precip pr = rainFall(screenUv, aspect, t, rain, wind, 1.0 - exp(-seen / 650.0));
    col = mix(col, mix(vec3(dot(haze, LUMA)) * vec3(0.94, 0.97, 1.0), haze, 0.4), pr.veil);
    vec3 dropCol = max(greyed(haze, vec3(1.0), 0.5) * 1.2, vec3(0.08));
    col = mix(col, dropCol * (1.0 - 0.15 * pr.near), pr.cover);
  }
#endif
#if VALLEY_HAS_SNOW
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
