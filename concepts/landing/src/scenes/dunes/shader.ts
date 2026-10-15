// The dunes scene: the slab model's sand sea (sim.ts) ray-marched as a height field, seen low across
// the field toward the horizon or straight down like a satellite picture.
//
// Everything is worked in the simulation's grid space: x runs downwind (for a positive wind), z
// across it, y up, in cells; uSim0 holds heights, uSim1 slopes, curvature and hollowness. The
// aerial camera turns its rays into grid space by DUNES_CAMERA.turn, so the wind blows left to right
// and toward the viewer; the sky library's frame is the camera's turned by DUNES_CAMERA.look, and
// its sun and moon are turned on into grid space to light the sand.
//
// Over the dunes the shared world (shaders/lib/world.ts; src/scenes/README.md, "World layers"),
// through the aerial camera's own rays (worldViewOf: bent by the heat, turned by the pointer) at a
// cell of about 5 m (DUNES_UNIT): its sky (the dome, the aurora, the cloud deck, the Milky Way and
// the stars, shooting stars, lightning) and its light, the deck's shadows on the sand, its birds
// over the dune sea, its rain and snow (wetting the sand, lying on it) at the depth of what each
// cell sees. The world's fog is the desert's dust: the haze the far dunes fade into, which a hard
// wind turns into a sandstorm swallowing the sky and the sun. Seen from overhead: the light, the
// deck's shadows, the dust and the sandstorm, and the rain and snow falling away from the eye.
import { glslFloat } from "../../shaders/glsl.ts";
import { worldGlsl } from "../../shaders/lib/world.ts";
import {
  DUNES_CAMERA,
  DUNES_GRID,
  DUNES_MAP,
  DUNES_MARCH,
  DUNES_MARK,
  DUNES_SAND,
  DUNES_SLAB,
} from "./sim.ts";

/**
 * Seconds of the dunes' entrance and exit (SceneDef.passage). Arriving, the camera glides in low
 * over the crests and settles while a veil of blown sand streams away downwind and clears; leaving,
 * the wind rises and a veil of sand streams in across the picture.
 */
export const DUNES_PASSAGE = { enter: 2.6, exit: 1.5 } as const;

/** Trigger slots of the shooting stars' and the lightning's "now" buttons. */
export const DUNES_METEOR_TRIGGER = 0;
export const DUNES_LIGHTNING_TRIGGER = 1;

export const dunesGlsl = `
${worldGlsl}
// ---- the dunes ----
// Where shooting stars set out: skyAngles of the camera's view (bearing, elevation, radians), the
// strip of sky over the dune sea.
const int DUNES_METEOR_SLOT = ${DUNES_METEOR_TRIGGER};
const vec4 DUNES_METEOR_FIELD = vec4(-0.5, 0.17, 1.0, 0.08);
const int DUNES_LIGHTNING_SLOT = ${DUNES_LIGHTNING_TRIGGER};
const float DUNES_GRID = ${glslFloat(DUNES_GRID)};
// No sand stands higher than this (cells); rays above it and climbing can stop.
const float DUNES_TOP = ${glslFloat(DUNES_MARCH.top)};
// Rays give up here: the dust has the horizon by then.
const float DUNES_FAR = ${glslFloat(DUNES_MARCH.far)};
const vec2 DUNES_EYE = vec2(${glslFloat(DUNES_CAMERA.x)}, ${glslFloat(DUNES_CAMERA.z)});
const float DUNES_EYE_HEIGHT = ${glslFloat(DUNES_CAMERA.height)};
const float DUNES_EYE_RISE = ${glslFloat(DUNES_CAMERA.rise)};
const float DUNES_HORIZON = ${glslFloat(DUNES_CAMERA.horizon)};
const float DUNES_FOV = ${glslFloat(DUNES_CAMERA.fov)};
// viewRay's image plane at that field, screen heights: the world's pinhole (WorldView.focal).
const float DUNES_FOCAL = ${glslFloat(0.5 / Math.tan(0.5 * DUNES_CAMERA.fov))};
const float DUNES_TURN = ${glslFloat(DUNES_CAMERA.turn)};
const float DUNES_LOOK = ${glslFloat(DUNES_CAMERA.look)};
const float DUNES_PARALLAX = ${glslFloat(DUNES_CAMERA.parallax)};
const float DUNES_MAP_SPAN = ${glslFloat(DUNES_MAP.span)};
const vec2 DUNES_MARK_AT = vec2(${glslFloat(DUNES_MARK.x)}, ${glslFloat(DUNES_MARK.z)});
const float DUNES_MARK_YAW = ${glslFloat(DUNES_MARK.yaw)};
const float DUNES_MARK_SMALL = ${glslFloat(DUNES_MARK.small)};
const float DUNES_MARK_LARGE = ${glslFloat(DUNES_MARK.large)};
const float DUNES_MARK_STROKE = ${glslFloat(DUNES_MARK.stroke)};
const float DUNES_MARK_DEPTH = ${glslFloat(DUNES_MARK.depth)};
const float DUNES_MARK_SCOUR = ${glslFloat(DUNES_MARK.scour)};
const float DUNES_SAND_SPARSE = ${glslFloat(DUNES_SAND.sparse)};
const float DUNES_SAND_PLENTY = ${glslFloat(DUNES_SAND.plenty)};
const float DUNES_SLAB = ${glslFloat(DUNES_SLAB)};
// The sand sea's scale for the world (WorldView.unit): cells per metre. A cell is about 5 m, so the
// dunes stand 10-50 m high a few hundred metres apart, the eye flies some 80 m over the sand and the
// M is a butte 40-75 m tall; the rain and the snow fall at their depths in metres, and the deck's
// shadows are cast from 1 km over the eye.
const float DUNES_UNIT = 0.2;
// The world's birds over the dune sea: flights cross 30-300 cells out, cruising above the horizon;
// a swooping party comes down to skim the crests.
const vec2 DUNES_BIRD_DEPTHS = vec2(30.0, 300.0);
const vec2 DUNES_BIRD_BAND = vec2(DUNES_HORIZON + 0.03, 0.94);
const float DUNES_BIRD_SWOOP = 12.0;
// Lying snow, before the light.
const vec3 DUNES_SNOW = vec3(0.88, 0.9, 0.94);
// Overhead, the rain and the snow are drawn as a camera pitched this far down (radians, ~50 degrees)
// sees them: their paths converge on a point about half a screen below the frame. Straight down,
// that point would sit at the frame's middle, where rainFallSeen cannot tell the paths apart.
const float DUNES_OVERHEAD_PITCH = 0.87;
// The entrance's glide: the eye starts this many cells upwind of its place and this far lower, and
// the overhead view starts this share farther out (cells per screen height).
const float DUNES_PASSAGE_BACK = 34.0;
const float DUNES_PASSAGE_DROP = 4.5;
const float DUNES_PASSAGE_ZOOM = 0.3;

float dunesHeight(vec2 p) {
  return uSimOn.x > 0.5 ? texture(uSim0, p / DUNES_GRID).r : 0.0;
}

// Slope dh/dx, dh/dz, curvature (negative on crests and brinks), hollowness (positive in troughs).
vec4 dunesShape(vec2 p) {
  return uSimOn.y > 0.5 ? texture(uSim1, p / DUNES_GRID) : vec4(0.0);
}

// Blown sand: thin streaks drawn out along the wind and racing down it. 'across' is the streak
// frequency across the wind, per cell: lower where a cell covers fewer pixels.
float dunesStreak(vec3 q, float tm, float windSign, float gale, float across) {
  vec2 s = vec2((q.x * windSign - tm * (4.0 + 14.0 * gale)) * 0.16, q.z * across + q.y * 0.5);
  float n = 0.6 * vnoise(s) + 0.4 * vnoise(s * vec2(1.7, 2.9) + 4.1);
  return smoothstep(0.52, 0.85, n);
}

// The passage's veil: soft broken sheets of blown sand at ground point p, stretched a little along
// the wind, bent by a warp and carried a given distance 'travel' downwind (cells) rather than at a
// rate, so the pace can change while the sheets keep their shape.
float dunesVeilSheet(vec2 p, float travel, float windSign) {
  vec2 s = vec2((p.x * windSign - travel) * 0.04, p.y * 0.1);
  s += 0.7 * (vec2(vnoise(s * 1.6 + 3.1), vnoise(s * 1.6 + 8.2)) - 0.5);
  float n = 0.65 * vnoise(s) + 0.35 * vnoise(s * 2.3 + 5.0);
  return smoothstep(0.58, 0.82, n);
}

// The M as a slab of sandstone: the glyph extruded through its depth (Quilez's extrusion of a 2D
// distance), its legs scoured thin just above the sand, where blown grains strike hardest.
float dunesMarkSdf(vec3 p, float height) {
  vec3 q = p - vec3(DUNES_MARK_AT.x, 0.0, DUNES_MARK_AT.y);
  vec2 face = rotate(q.xz, -DUNES_MARK_YAW);
  vec2 m = vec2(face.x, q.y) / height - vec2(0.0, 0.5);
  float stroke = DUNES_MARK_STROKE * (1.0 - DUNES_MARK_SCOUR * smoothfall(-0.2, -0.5, m.y));
  vec2 w = vec2((markDistance(m) - stroke) * height, abs(face.y) - DUNES_MARK_DEPTH * height);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0));
}

// Where a ray meets the M before 'far' (-1 if it misses): sphere tracing inside its bounding sphere.
float dunesMarkHit(vec3 ro, vec3 rd, float height, float far) {
  vec3 oc = ro - vec3(DUNES_MARK_AT.x, 0.5 * height, DUNES_MARK_AT.y);
  float b = dot(oc, rd);
  float disc = b * b - dot(oc, oc) + 0.81 * height * height;
  if (disc < 0.0) return -1.0;
  float root = sqrt(disc);
  float t = max(-b - root, 0.0);
  float end = min(-b + root, far);
  for (int i = 0; i < 40; i++) {
    if (t > end) return -1.0;
    float d = dunesMarkSdf(ro + rd * t, height);
    if (d < 0.002 * t + 0.01) return t;
    t += d;
  }
  return -1.0;
}

vec3 dunesMarkNormal(vec3 p, float height) {
  const vec2 e = vec2(0.03, -0.03);
  return normalize(
    e.xyy * dunesMarkSdf(p + e.xyy, height) + e.yyx * dunesMarkSdf(p + e.yyx, height) +
    e.yxy * dunesMarkSdf(p + e.yxy, height) + e.xxx * dunesMarkSdf(p + e.xxx, height)
  );
}

// How much light passes the M from p toward the light: a soft shadow (Quilez's penumbra estimate,
// k·d/t), long and blurred when the sun is low.
float dunesMarkShadow(vec3 p, vec3 l, float height) {
  vec3 oc = p - vec3(DUNES_MARK_AT.x, 0.5 * height, DUNES_MARK_AT.y);
  float b = dot(oc, l);
  float disc = b * b - dot(oc, oc) + 0.81 * height * height;
  if (disc < 0.0) return 1.0;
  float root = sqrt(disc);
  float end = -b + root;
  if (end < 0.0) return 1.0;
  float t = max(-b - root, 0.05);
  float lit = 1.0;
  for (int i = 0; i < 24; i++) {
    if (t > end) break;
    float d = dunesMarkSdf(p + l * t, height);
    lit = min(lit, 6.0 * d / t);
    if (lit < 0.01) break;
    t += max(d, 0.08);
  }
  return clamp(lit, 0.0, 1.0);
}

// Sunlight reaching p: march toward the light over the height field with a soft penumbra, plus the
// M's shadow when it stands. At a low sun the march runs far, so dunes throw long shadows. 'coarse'
// lengthens the shortest step for far points, where a pixel covers cells and the haze softens all.
float dunesShadow(vec3 p, vec3 l, float markHeight, float coarse) {
  float lit = 1.0;
  float t = 0.25;
  for (int i = 0; i < 24; i++) {
    vec3 q = p + l * t;
    if (q.y > DUNES_TOP) break;
    float gap = q.y - dunesHeight(q.xz);
    lit = min(lit, 10.0 * gap / t);
    if (lit < 0.005) break;
    t += clamp(gap * 0.7, 0.3 + coarse, 8.0);
  }
  lit = clamp(lit, 0.0, 1.0);
  if (markHeight > 0.0) lit = min(lit, dunesMarkShadow(p, l, markHeight));
  return lit;
}

// March the height field from distance t: steps as long as the slope bound allows (no sand here is
// steeper than about 0.75), never shorter than 1% of the distance so the far field is reached
// within 48 steps, then bisect the last one. Returns the hit distance, or -1 for none before
// DUNES_FAR. 'skim' notes where the ray passes closest over a crest (xyz, closeness in w), where
// sand blowing off it would be seen against what lies beyond. The numbers are DUNES_MARCH's, which
// the sim's pointer ray marches with too (marchHeight), so a click lands on the sand drawn under it.
float dunesMarch(vec3 ro, vec3 rd, float t, out vec4 skim) {
  skim = vec4(0.0);
  float last = t;
  bool hit = false;
  for (int i = 0; i < ${DUNES_MARCH.steps}; i++) {
    vec3 p = ro + rd * t;
    float gap = p.y - dunesHeight(p.xz);
    if (gap < 0.0) {
      hit = true;
      break;
    }
    if (gap < 1.5) {
      float crest = smoothstep(0.08, 0.24, -dunesShape(p.xz).z) * (1.0 - gap / 1.5);
      if (crest > skim.w) skim = vec4(p, crest);
    }
    if (rd.y >= 0.0 && p.y > DUNES_TOP) return -1.0;
    last = t;
    t += max(gap / (${glslFloat(DUNES_MARCH.slope)} + abs(rd.y)), ${glslFloat(DUNES_MARCH.relStep)} * t + ${glslFloat(DUNES_MARCH.minStep)});
    if (t > DUNES_FAR) return -1.0;
  }
  // Out of steps short of the far field: grazing the sand somewhere ahead; call it there.
  if (!hit) return t;
  float lo = last;
  float hi = t;
  for (int i = 0; i < ${DUNES_MARCH.refine}; i++) {
    float mid = 0.5 * (lo + hi);
    vec3 p = ro + rd * mid;
    if (p.y > dunesHeight(p.xz)) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// The dunes' sky under the world's deck: its colour greys and darkens as the world's light does
// under rain or snow (worldAt's shares), down to the horizon the far sand fades into; the dome's
// clear strip below the deck's edge would otherwise stay blue over a grey day.
vec3 dunesOvercast(vec3 col, World w) {
  return greyed(col, vec3(1.0), WORLD_DECK_GREY * w.overcast) * (1.0 - WORLD_DECK_DARK * w.storm);
}

Shade sceneDunes(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  float tm = uMotionTime;
  bool overhead = K_camera > 0.5;
  // The shared world now (shaders/lib/world.ts): the sky and its light, the deck rain or snow closes
  // over it, the aurora's glow and the lightning's flash in that light.
  World world = worldAt(t, DUNES_METEOR_SLOT, DUNES_LIGHTNING_SLOT);
  Sky sky = world.sky;
  float windSign = world.wind < 0.0 ? -1.0 : 1.0;
  // How hard it blows: drives the blowing sand, the ripples' creep and, with the dust, a sandstorm.
  float gale = min(abs(world.wind) / 0.8, 1.0);
  // The world's fog is desert dust out here (see the haze below); a hard wind makes it a sandstorm.
  float sandstorm = world.fog * gale;
  // How wet the sand is and how much snow lies on it (drying and melting after the weather).
  float wet = uWeather.x;
  float lying = uWeather.y;
  float mean = (DUNES_SAND_SPARSE + (DUNES_SAND_PLENTY - DUNES_SAND_SPARSE) * K_sand * K_sand) * DUNES_SLAB;
  float markHeight = K_mark > 0.0 ? mix(DUNES_MARK_SMALL, DUNES_MARK_LARGE, K_mark) : 0.0;

  // One key light: the sun, or the moon once the sun is down. Both colours come pre-faded. The sky
  // library's frame is the camera's turned by DUNES_LOOK, so the setting sun stands in the picture.
  float moonlit = sky.sun.y > -0.03 ? 0.0 : 1.0;
  vec3 key = skyFacing(mix(sky.sun, sky.moon, moonlit), DUNES_TURN - DUNES_LOOK);
  // A high sun or moon stands above the picture and out across the wind, where it lights stoss and
  // lee alike and the dunes go flat. As it climbs, swing it round upwind (out of the picture nobody
  // can tell) and steepen the slopes it lights, so stoss slopes and crests stay lit and slip faces
  // fall into shade at every hour, as they do at sunset.
  float high = smoothstep(0.3, 0.6, key.y);
  vec2 keyAcross = key.xz / max(length(key.xz), 1e-4);
  key.xz = normalize(mix(keyAcross, vec2(-0.9 * windSign, 0.44), 0.5 * high)) * length(key.xz);
  float relief = 1.0 + 0.5 * high;
  // In a sandstorm the dust swallows most of the sun; under the world's deck the moon fades as the
  // sun's light does (worldAt's).
  vec3 moonlight = sky.moonColor * (1.0 - WORLD_DECK_SUN * world.overcast);
  vec3 keyColor = (sky.sunColor + moonlight) * (1.0 - 0.7 * sandstorm);
  // A low sun is weak on flat ground but strong on the slopes turned to it, and outshines the sky
  // many times over: expose the direct light up as it sinks and keep the sky's fill modest, so
  // dunes keep their light and shade at every hour. A high sun is held back a little, so the sand
  // turned to it does not burn out.
  vec3 sunlight = keyColor / (0.38 + 0.62 * max(key.y, 0.0)) * (1.0 - 0.2 * high * sky.day);
  // The world's ambient carries the aurora's glow (world.glow), which reaches the land through clear
  // air only: the sky's light with as much of the glow as the dust lets through (ambient), and the
  // sand's fill, the sky's own light at 0.75 and that glow whole.
  vec3 ambient = sky.ambient - world.glow * sandstorm;
  vec3 skylight = (sky.ambient - world.glow) * 0.75 + world.glow * (1.0 - sandstorm);
  // A high sun on hot, dry sand: the air wavers above the far dunes and the distance turns to
  // mirage. Not under the deck, nor once rain has wet the sand.
  float heat = K_heat * sky.day * smoothstep(0.3, 0.8, sky.sun.y) * (1.0 - world.overcast) * (1.0 - wet);

  // Camera. Aerial: low over the sand, looking to the horizon. Heat bends rays near the horizon:
  // columns of hot air rising and wavering, a few rows up and down.
  float band = exp(-abs(uv.y - DUNES_HORIZON) * 28.0);
  vec2 waver = vec2(
    vnoise(vec2(uv.x * 23.0 + 7.0, tm * 1.0)),
    vnoise(vec2(uv.x * 34.0, (uv.y - DUNES_HORIZON) * 40.0 - tm * 0.9))
  ) - 0.5;
  vec2 at = overhead ? uv : uv + waver * vec2(0.004, 0.014) * band * heat;
  vec3 view = viewRay(at, aspect, DUNES_HORIZON, DUNES_FOV);
  view.xz = rotate(view.xz, -uPointer.x * DUNES_PARALLAX);
  // The eye at rest. The world's cloud deck casts its shadows about it, so they keep to the sand
  // while the eye glides in, and lie where they do seen from overhead.
  vec3 rest = vec3(DUNES_EYE.x, DUNES_EYE_HEIGHT + DUNES_EYE_RISE * mean, DUNES_EYE.y);
  vec3 ro = rest;
  vec3 rd = skyFacing(view, DUNES_TURN);
  // Arriving and leaving. 'left' is how much of the entrance's glide remains: exactly 0 at rest,
  // where every passage term below is off or multiplied away.
  float pin = passageIn();
  float pout = passageOut();
  bool passing = pin < 1.0 || pout > 0.0;
  float left = max(1.0 - pin, 0.0);
  left = left * left * left;
  float span = DUNES_MAP_SPAN * (1.0 + (overhead ? DUNES_PASSAGE_ZOOM : 0.0) * left);
  if (overhead) {
    // Straight down on the M's patch of desert, the wind blowing left to right; arriving, the
    // view settles down from a little higher.
    vec2 g = DUNES_MARK_AT + (uv - 0.5) * vec2(aspect, 1.0) * span;
    ro = vec3(g.x, DUNES_TOP + 24.0, g.y);
    rd = vec3(0.0, -1.0, 0.0);
  }

  if (passing && !overhead && pin < 1.0) {
    // Arriving: the eye glides forward from upwind and low, rising to its place with the faintest
    // overshoot (an ease-out-back), and never dips into the sand under it.
    float back = max(1.0 - pin, 0.0);
    float rise = 1.0 - 2.2 * back * back * back + 1.2 * back * back;
    ro.xz -= vec2(-sin(DUNES_TURN), cos(DUNES_TURN)) * DUNES_PASSAGE_BACK * left;
    ro.y -= DUNES_PASSAGE_DROP * (1.0 - rise);
    ro.y = max(ro.y, dunesHeight(ro.xz) + 1.5);
  }
  // The world through this camera: its own ray (heat-bent, turned by the pointer) in the sky's frame
  // by DUNES_LOOK, the eye's height over the bed, in cells of DUNES_UNIT. Overhead, the ray is left
  // unused: the world gives the light, the deck's shadows and the rain and snow falling past.
  WorldView camera = worldViewOf(view, uv, DUNES_HORIZON, DUNES_FOCAL, ro.y, DUNES_LOOK, DUNES_UNIT);

  vec4 skim = vec4(0.0);
  float hitT = -1.0;
  if (overhead) {
    hitT = ro.y - dunesHeight(ro.xz);
  } else if (rd.y < 0.0 || ro.y < DUNES_TOP) {
    hitT = dunesMarch(ro, rd, ro.y > DUNES_TOP ? (ro.y - DUNES_TOP) / -rd.y : 0.0, skim);
  }
  float markT = markHeight > 0.0 ? dunesMarkHit(ro, rd, markHeight, hitT < 0.0 ? DUNES_FAR : hitT) : -1.0;

  // Where the ray lands, and the ripple phase there with its rate across the screen: taken out
  // here, in uniform control flow, because fwidth needs every neighbour to run it.
  float reach = hitT < 0.0 ? DUNES_FAR : hitT;
  vec3 p = ro + rd * reach;
  float lambda = overhead ? 1.2 : 0.55;
  float warp = 1.7 * vnoise(p.xz * vec2(0.11, 0.33)) + 0.6 * vnoise(p.xz * vec2(0.45, 1.3) + 5.0);
  float phase = p.x * windSign / lambda + warp - tm * (0.05 + 0.4 * gale);
  float alias = fwidth(phase);
  // Cells per pixel here, to keep fine grain coarser than the dither.
  float footprint = length(fwidth(p.xz));

  // Dust haze, the world's fog out here. The desert air is never quite clear; fog thickens it, and
  // with a hard wind on top it becomes a sandstorm closing in to a few dune lengths: ochre, and
  // dimming the sun. Under the world's deck the horizon it fades into greys as the light does.
  vec3 horizon = dunesOvercast(horizonHaze(sky, camera.dir, 0.0), world);
  vec3 dustTint = vec3(0.82, 0.58, 0.38) * (sky.sunColor * 0.55 + ambient * 1.1);
  vec3 dust = mix(horizon, dustTint, 0.3 + 0.6 * sandstorm);
  float hazeDensity = 0.3 + 0.7 * world.fog + 2.0 * sandstorm;
  float hazeReach = mix(DUNES_FAR, 280.0, sandstorm);
  // Lit blowing sand, glowing when the sun is behind it.
  vec2 flatRd = rd.xz / max(length(rd.xz), 1e-4);
  vec2 flatKey = key.xz / max(length(key.xz), 1e-4);
  float against = overhead ? 0.0 : pow(max(dot(flatRd, flatKey), 0.0), 3.0);
  vec3 grains = vec3(0.96, 0.76, 0.52) * (keyColor * (0.55 + 0.9 * against) + ambient * 1.2);
  // Wet or snowed-on sand stays put.
  float drift = K_drift * gale * (1.0 - max(wet, lying));

  vec3 col;
  bool showMark = markT > 0.0 && (hitT < 0.0 || markT < hitT);
  if (showMark) {
    // Weathered sandstone: broad wavy strata of redder and paler rock with fine cross-bedding,
    // dark desert varnish streaking down from the top, the foot scoured pale and smooth, the faces
    // pitted by the wind.
    vec3 q = ro + rd * markT;
    vec3 n = dunesMarkNormal(q, markHeight);
    vec2 face = rotate(q.xz - DUNES_MARK_AT, -DUNES_MARK_YAW);
    float my = q.y / markHeight;
    float strata = sin(q.y * 1.7 + 1.2 * vnoise(vec2(face.x * 0.3, q.y * 0.5))) + 0.25 * sin((q.y - 0.35 * face.x) * 7.0);
    vec3 stone = mix(vec3(0.74, 0.42, 0.26), vec3(0.92, 0.66, 0.45), clamp(0.5 + 0.4 * strata, 0.0, 1.0));
    float varnish = smoothstep(0.6, 0.9, vnoise(vec2(face.x * 0.9, q.y * 0.12 + 3.0))) * smoothstep(0.35, 0.95, my);
    stone *= 1.0 - 0.35 * varnish;
    stone = mix(stone, vec3(0.94, 0.74, 0.54), 0.35 * smoothfall(0.3, 0.0, my));
    n = normalize(n + 0.12 * (vec3(vnoise(q.yz * 2.0), vnoise(q.xz * 2.0 + 2.0), vnoise(q.xy * 2.0 + 4.0)) - 0.5));
    // Rain darkens the sandstone a little; snow lies on its ledges and tops.
    if (wet > 0.0) stone = wetten(stone, wet, 0.4);
    if (lying > 0.0) stone = mix(stone, DUNES_SNOW, snowCover(n, q.xz * 0.3, lying));
    float ndl = max(dot(n, key), 0.0);
    float shade = key.y > 0.0 ? dunesShadow(q + n * 0.15, key, 0.0, 0.0) : 0.0;
    // The world's cloud deck shades it too (worldSunlit), while the sun is the key.
    if (moonlit < 0.5 && shade > 0.0) shade *= worldSunlit(world, camera, skyFacing(q - rest, -DUNES_TURN));
    // The sunlit sand around it lights its faces from below.
    vec3 bounce = keyColor * vec3(0.9, 0.62, 0.4) * 0.45 * clamp(key.y * 2.5, 0.0, 1.0) * (0.5 - 0.5 * n.y);
    // The sun is always somewhere ahead, so the face toward us is mostly in shade: a fuller sky fill
    // than the sand's keeps the stone's colour and strata legible.
    col = stone * sunlight * ndl * shade + greyed(stone, vec3(1.0), 0.3) * ambient * 0.9 * (0.55 + 0.45 * n.y) + stone * bounce;
    // Backlit, its edges catch a thin line of the sun.
    col += stone * sunlight * pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * against * shade * 0.6;
    col *= mix(vec3(1.0), vec3(0.7, 0.85, 1.3), sky.night * 0.75);
    col = mix(col, dust, fogAmount(hazeDensity, overhead ? 0.25 * world.fog : markT / hazeReach, q.y / 22.0));
    o.accent = clamp(0.45 + 0.55 * ndl * shade, 0.0, 1.0);
  } else if (hitT > 0.0) {
    vec4 shape = dunesShape(p.xz);
    // Thin sand over the bed (bare between barchans), slip faces (the steep lee, at repose),
    // crests and brinks, and troughs (darker, less sky).
    float cover = smoothstep(0.02, 0.6, p.y);
    float slip = smoothstep(0.3, 0.5, -windSign * shape.x) * cover;
    float crest = smoothstep(0.08, 0.24, -shape.z) * cover;
    float ao = 1.0 - 0.38 * smoothstep(0.0, 1.3, shape.w);
    if (markHeight > 0.0 && length(p.xz - DUNES_MARK_AT) < markHeight) {
      ao *= 0.55 + 0.45 * smoothstep(0.0, 2.5, dunesMarkSdf(p, markHeight));
    }

    // Wind ripples, square to the wind: a skewed wave with a long gentle stoss and a short steep
    // lee, bending and forking where the noise warps the phase, creeping downwind. None on slip
    // faces (avalanches wipe them) and faded where they would be finer than the dither.
    float ripples = K_ripples * cover * (1.0 - slip) * (1.0 - 0.6 * crest) * (1.0 - smoothstep(0.18, 0.42, alias));
    float s = TAU * phase;
    float tilt = cos(s - 0.7 * sin(s)) * (1.0 - 0.7 * cos(s)) * (TAU / lambda) * 0.018 * ripples;
    vec3 n = normalize(vec3(-(shape.x + tilt * windSign) * relief, 1.0, -shape.y * relief));

    // Warm sand, the slip faces darker and smoother with faint avalanche chutes; a gravel bed.
    vec3 sand = mix(vec3(0.92, 0.66, 0.42), vec3(0.8, 0.55, 0.35), slip);
    float grain = 1.0 - smoothstep(0.08, 0.25, footprint);
    sand *= (1.0 - 0.07 * slip * grain * vnoise(vec2(p.z * 1.4, p.x * 0.2))) * (0.94 + 0.06 * vnoise(p.xz * 0.35));
    vec2 pan = rotate(p.xz, 0.6);
    vec3 bed = vec3(0.62, 0.46, 0.36) * (0.78 + 0.22 * vnoise(pan * 0.35) + 0.12 * vnoise(pan * 0.9 + 3.0)) * (1.0 + 0.12 * grain * (vnoise(pan * 2.5) - 0.5));
    vec3 albedo = mix(bed, sand, cover);
    // Rain darkens the sand and deepens its colour; snow lies on it, the gentle slopes first.
    if (wet > 0.0) albedo = wetten(albedo, wet, 0.8);
    if (lying > 0.0) albedo = mix(albedo, DUNES_SNOW, snowCover(n, p.xz * 0.3, lying));
    // By moonlight the eye loses colour: sand reads grey-blue.
    albedo = greyed(albedo, vec3(1.0), 0.5 * sky.night);

    float ndl = max(dot(n, key), 0.0);
    float lit = ndl > 0.0 && key.y > 0.0 ? dunesShadow(p + vec3(0.0, 0.06, 0.0), key, markHeight, 0.004 * reach) : 0.0;
    // The world's cloud deck's shadows drift over the sand (worldSunlit), while the sun is the key:
    // from the same deck over the eye at rest, aerial or overhead.
    if (moonlit < 0.5 && lit > 0.0) lit *= worldSunlit(world, camera, skyFacing(p - rest, -DUNES_TURN));
    // Sunlit sand throws light back into the shade: deserts are never black in shadow. Less of it
    // under a high sun, so the slip faces keep their shade.
    vec3 bounce = keyColor * albedo * 0.25 * clamp(key.y * 2.0, 0.0, 1.0) * clamp(1.0 - 0.6 * n.y, 0.0, 1.0) * (1.0 - 0.5 * high);
    // The sky fills the shade with cooler, greyer light than the sun gives the sand; at night little
    // of it finds the slip faces, so the lee sides stay dark.
    float fill = ao * (0.55 + 0.45 * n.y) * (1.0 - 0.45 * slip * sky.night);
    col = albedo * sunlight * ndl * lit + greyed(albedo, vec3(1.0), 0.4) * skylight * fill + bounce * ao;
    // Crests catch the light when it comes from behind them; the moon lays a cool sheen along them.
    col += keyColor * albedo * crest * against * lit * 0.35;
    col += moonlight * (moonlit * sky.night * 0.6) * crest * ndl * lit;
    // Out of the sun the sand takes the sky's colour: the slip faces under a high sun, and the hollows.
    vec3 skyHue = skylight / max(dot(skylight, LUMA), 1e-3);
    float cool = sky.day * (0.35 * slip * high + 0.3 * smoothstep(0.2, 1.4, shape.w));
    col = greyed(col, skyHue, cool);
    col *= mix(vec3(1.0), vec3(0.7, 0.85, 1.3), sky.night * 0.75);
    // Quartz grains glinting on the nearer sunlit sand.
    o.shimmer = 0.06 * ndl * lit * cover * sky.day * smoothfall(140.0, 30.0, reach);

    if (drift > 0.0) {
      float near = overhead ? 1.0 : smoothfall(170.0, 50.0, reach);
      // Saltation: sheets of sand skimming up the stoss slopes, thickest toward the crest.
      float flux = cover * (1.0 - slip) * (0.25 + 0.75 * crest + 0.5 * smoothstep(0.0, 0.3, windSign * shape.x));
      // The skimming grains brighten whatever light falls there rather than glowing on their own.
      float sheet = dunesStreak(p, tm, windSign, gale, overhead ? 0.9 : 1.8) * flux * drift * near;
      col = mix(col, col * 1.4 + grains * albedo * 0.1, sheet * 0.6);
      // Over the slip face just downwind of a brink: sand streaming off the crest in a veil.
      float brink = max(
        smoothstep(0.08, 0.24, -dunesShape(p.xz - vec2(windSign * 1.5, 0.0)).z),
        0.7 * smoothstep(0.08, 0.24, -dunesShape(p.xz - vec2(windSign * 3.5, 0.0)).z)
      );
      float veil = brink * slip * dunesStreak(p + vec3(0.0, 0.0, 3.7), tm * 1.4, windSign, gale, overhead ? 0.9 : 1.5);
      col = mix(col, grains, veil * drift * near * 0.55);
    }

    col = mix(col, dust, fogAmount(hazeDensity, overhead ? 0.25 * world.fog + 0.6 * sandstorm : reach / hazeReach, p.y / 22.0));
  } else if (overhead || view.y < 0.0) {
    // Below the horizon but past the far field: the haze closes it.
    col = dust;
  } else {
    // The world's sky (worldSky): the dome, the aurora ahead behind the clouds, the cloud deck, the
    // Milky Way and the stars in its gaps, shooting stars over the dune sea, then the lightning. A
    // sandstorm closes the night sky as the deck does (its overcast): the aurora and shooting stars
    // fade behind the dust. Greyed under the deck rain or snow closes, then swallowed low down by
    // the dust and whole by a sandstorm, the bolts too.
    World through = world;
    through.overcast = max(world.overcast, sandstorm);
    WorldSky heaven = worldSky(through, camera, DUNES_METEOR_FIELD);
    float low = exp(-max(view.y, 0.0) * mix(16.0, 3.0, world.fog));
    col = mix(dunesOvercast(heaven.col, world) + heaven.strike, dust, max((0.18 + 0.72 * world.fog) * low, 0.9 * sandstorm));
  }

  // Mirage: under a high sun the far sand gives way to pools of shimmering sky along the horizon,
  // the far crests standing in them.
  if (!overhead && !showMark && heat > 0.0 && view.y < 0.0) {
    float pools = smoothstep(0.3, 0.7, vnoise(vec2(uv.x * 6.0 + 3.0, tm * 0.08)));
    float mirage = heat * smoothstep(200.0, 650.0, reach) * (0.4 + 0.6 * pools) * (0.8 + 0.2 * vnoise(vec2(uv.x * 40.0, tm * 1.5)));
    col = mix(col, skyColor(sky, normalize(vec3(camera.dir.x, abs(camera.dir.y) + 0.01, camera.dir.z))), min(1.2 * mirage, 0.85));
  }

  // Sand blowing off the crests the ray skimmed, seen against the sky or the dunes beyond.
  if (!overhead && drift > 0.0 && skim.w > 0.0 && !showMark) {
    float wisp = skim.w * dunesStreak(skim.xyz, tm * 1.3, windSign, gale, 1.2) * smoothfall(250.0, 60.0, length(skim.xyz - ro));
    col = mix(col, grains, wisp * drift * 0.5);
  }

  // The distance to the first opaque thing this cell sees, cells (the world's z): the M, the sand,
  // the far field the haze closes below the horizon, or open sky.
  float z = showMark ? markT : hitT >= 0.0 || view.y < 0.0 ? reach : WORLD_FAR;
  // The world's birds over the dune sea, by day (a buzzard circling on the thermals by default):
  // behind any dune or the M nearer than they fly, hazed by the dust as the sand is. Not overhead:
  // the world's birds are seen from below, by a level camera.
  if (!overhead) {
    WorldFlyway flyway = WorldFlyway(DUNES_BIRD_DEPTHS, DUNES_BIRD_BAND, vec2(K_seed * 0.37, 3.3), DUNES_BIRD_SWOOP, 1.5);
    worldBirds(world, camera, flyway, dust, hazeDensity / hazeReach, col, z, o.accent);
  }

  // A sandstorm: sheets of dust driven across the view at three depths, nearer ones faster.
  if (sandstorm > 0.0) {
    float sheets = 0.0;
    for (int k = 0; k < 3; k++) {
      // Overhead the sheets hang a few cells above the sand; aerial, at 18, 40 and 87 cells out.
      float d = overhead ? ro.y - 6.0 + 2.5 * float(k) : 18.0 * pow(2.2, float(k));
      if (hitT > 0.0 && d > hitT) break;
      vec3 q = ro + rd * d;
      vec2 flow = vec2(q.x * windSign - tm * (6.0 + 12.0 * gale), q.z);
      float n = fbm(flow * vec2(0.03, 0.08) + q.y * 0.1 + float(k) * 7.3);
      sheets += smoothstep(0.4, 0.75, n) * exp(-max(q.y, 0.0) / 14.0) * 0.6;
    }
    col = mix(col, dust, clamp(sheets * sandstorm * 1.3, 0.0, 0.9));
  }

  // The passage's veil: low drifts of blown sand hugging the ground and streaming off the crests,
  // soft broken sheets and wisps, never up in the sky. Arriving, the wind drops: a front of the
  // veil clears from upwind (left) across the picture to the right and the drifts slow. Leaving,
  // the wind rises: drifts stream in from the left and thicken. Each is cut per cell (hardEdge)
  // and its pattern carried whole, so nothing crawls. The front is exactly off at rest.
  if (passing) {
    float x = uv.x + 0.12 * (vnoise(vec2(uv.y * 5.0, 3.0)) - 0.5);
    float density = 0.0;
    float travel = 0.0;
    if (pout > 0.0) {
      float e = mix(-0.45, 1.6, smoothstep(0.0, 1.0, pout));
      density = smoothfall(e, e - 0.45, x);
      travel = ${glslFloat(DUNES_PASSAGE.exit)} * (10.0 * pout + 16.0 * pout * pout);
    } else {
      float cleared = 1.0 - (1.0 - pin) * (1.0 - pin);
      float e = mix(-0.4, 1.5, cleared);
      density = smoothstep(e, e + 0.45, x);
      travel = ${glslFloat(DUNES_PASSAGE.enter)} * 26.0 * (pin - 0.5 * pin * pin);
    }
    // Aerial, the veil thins out within 0.15 of the screen above the horizon; the far field has none.
    float reachV = hitT > 0.0 ? hitT : 240.0;
    float skyLow = overhead ? 1.0 : smoothfall(0.15, 0.0, uv.y - DUNES_HORIZON);
    float distant = smoothfall(700.0, 350.0, reachV);
    if (density > 0.0 && skyLow > 0.0 && distant > 0.0) {
      float veil = 0.0;
      for (int k = 0; k < 4; k++) {
        // Points along the last stretch of the ray before it meets the sand, weighted by how close
        // to the sand they lie, and by crests just upwind that the sand streams off.
        vec3 q = ro + rd * (reachV * (0.97 - 0.12 * float(k) * float(k) / 3.0));
        float hug = exp(-max(q.y - dunesHeight(q.xz), 0.0) / 3.5);
        float crest = max(
          smoothstep(0.08, 0.24, -dunesShape(q.xz - vec2(windSign * 3.0, 0.0)).z),
          0.7 * smoothstep(0.08, 0.24, -dunesShape(q.xz - vec2(windSign * 9.0, 0.0)).z)
        );
        veil = max(veil, hug * (0.35 + 0.65 * crest) * dunesVeilSheet(q.xz, travel * (1.25 - 0.12 * float(k)), windSign));
      }
      vec3 veilColor = mix(grains, dust, 0.35);
      col = mix(col, veilColor, 0.65 * hardEdge(0.75 * veil * density * skyLow * distant));
    }
  }

  // Pouring sand: a stream falls onto the pointer while the button is held (the sim heaps it up).
  float pouring = max(uMouse.z, 1.0 - smoothstep(0.0, 0.6, t - uMouse.w));
  // Only where the sim can heap it: on the sand, below the horizon.
  if (!overhead && pouring > 0.0 && uMouse.y < DUNES_HORIZON - 0.01) {
    vec2 q = (uv - uMouse.xy) * vec2(aspect, 1.0);
    float width = 0.006 + 0.012 * smoothfall(0.02, -0.01, q.y);
    float stream = smoothfall(width, 0.0, abs(q.x)) * smoothstep(-0.015, 0.0, q.y) * smoothfall(0.24, 0.1, q.y);
    stream *= 0.55 + 0.45 * vnoise(vec2(q.x * 260.0, q.y * 50.0 + t * 12.0));
    col = mix(col, grains * vec3(0.95, 0.75, 0.5), stream * pouring);
  }

  // The world's rain and snow at the depth of what the cell sees: the veil toward the rain-washed
  // horizon's grey, the drops lit by the sky they refract, the low sun and the lightning. Overhead
  // they fall away from the eye, their paths closing in below the frame (DUNES_OVERHEAD_PITCH).
  vec3 air = greyed(horizon, vec3(0.94, 0.97, 1.02), 0.5 * world.overcast) * (1.0 - 0.25 * world.heavy) + WORLD_FLASH_SKY * world.flash;
  vec3 dropLight = max(horizon * 1.2 + sky.sunColor * 0.3 + WORLD_FLASH_LIGHT * world.flash, vec3(0.08));
  if (overhead) {
    float down = sin(DUNES_OVERHEAD_PITCH);
    float ahead = cos(DUNES_OVERHEAD_PITCH);
    worldPrecipSeen(world, camera, vec3(1.0, 0.0, 0.0), vec3(0.0, ahead, down), vec3(0.0, -down, ahead), air, dropLight, z, col, o.accent);
  } else {
    worldPrecip(world, camera, air, dropLight, z, col, o.accent);
  }

  col = clamp(col, 0.0, 1.0);
  Shade s = shadeOf(col, inkOf(col, 1.1, 0.85), o.accent);
  s.shimmer = o.shimmer;
  return s;
}
`;
