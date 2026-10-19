// The dunes preset's GLSL (ADR 0062 Phase 2a; the composer: src/composer, README "Composers"): the
// slab model's sand sea (sim.ts) ray-marched as a height field, seen low across the field toward the
// horizon through the dunes' rig (constants.ts DUNES_RIG, RIG_* in the program), or, until the
// overhead composer takes it (ADR Phase 4, `dunesabove`), straight down like a satellite picture in a
// program of its own (dunesAboveGlsl). Its parts, each a layer, drawn in the order the scene always
// painted them:
//   desert  (backdrop) the World's sky with the dust low on it (worldSky; a sandstorm closes it, the
//           aurora and shooting stars fading behind the dust), the dune sea past the field's far
//           edge closed by the dust; the desert's air: the haze toward each bearing, the rain's veil
//           and the drops' light, the World's fog taken over as the dust (x.w.fog put out, so the
//           composer's worldFog does not lay it again), with a hard wind a sandstorm that dims the
//           sun and drives sheets of dust across the view; the heat shimmer that bends the ray every
//           layer and the World see by (worldViewOf), and the mirage along the horizon.
//   dunes   (ground) the dune field (sim.ts, in its two field slots) out to the dust, lit by the key
//           over the height field and the M with long soft shadows, the deck's shadows drifting
//           over it; its wind ripples and blowing sand, the sand streaming off the crests the rays
//           skimmed, the sandstone M (its `dunesMark`), the veil of blown sand the scene's passage
//           draws and the sand poured under every hand; the quartz glints of the near sunlit sand
//           (Shade.shimmer, its shade pass).
//
// Everything is worked in the simulation's grid space: x runs downwind (for a positive wind), z
// across it, y up, in cells of 5 m (DUNES_UNIT cells per metre); the dune field's fields hold heights
// (dunesField0) and slopes, curvature and hollowness (dunesField1). The rig's rays are turned into
// grid space by DUNES_TURN, so the wind blows left to right and toward the viewer; the sky's frame is
// the rig's turned by DUNES_LOOK (RIG_TURN), and the sun and moon are turned on into grid space to
// light the sand. The composer is handed depths in metres (a distance in cells over DUNES_UNIT): the
// World's birds over the dune sea and its rain and snow fall at the depth of what each cell shows.
// The dunes keep their own light model over the World's sky (dunesLight: a key swung upwind under a
// high sun, so slip faces stay in shade at every hour), and their grade (constants.ts DUNES_GRADE).
//
// Per cell, the dune sea's state (the shared chunk's dunesCell, before either layer's own): the light,
// the camera and its rays (the eye raised with the sand supply and glided in by the passage), the
// dust; then the dune field's begin settles the eye over the sand and its own light, its ground pass
// what each ray meets (dunesHitT, dunesShowMark, dunesReach), which the desert's later passes read.
//
// Knobs read: the World's (worldAt), K_seed (the birds; the sim's arrangement), the desert's K_heat,
// the dune field's K_sand, K_ripples, K_drift, K_dunesMark (and K_camera, by the program it picks:
// index.ts, code.ts); uWeather.x for how wet the sand is, uWeather.y how much snow lies on it.
import { WORLD_TRIGGERS } from "../../composer/compose.ts";
import { COMPOSER_ENTRY, simOn } from "../../composer/glsl.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { worldGlsl } from "../../shaders/lib/world.ts";
import { DUNES_CAMERA, DUNES_GRADE, DUNES_PASSAGE, DUNES_UNIT } from "./constants.ts";
import { DUNES_GRID, DUNES_MAP, DUNES_MARCH, DUNES_MARK, DUNES_SAND, DUNES_SLAB } from "./sim.ts";

/**
 * The dune sea's constants, its light and its air, and the per-cell state every part of it reads:
 * held by both layers (in the shared chunk) and by the view from above.
 */
const DUNES_COMMON = `
// ---- the dune sea (dunes/shader.ts): its constants, its light and its air ----
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
const float DUNES_SAND_SPARSE = ${glslFloat(DUNES_SAND.sparse)};
const float DUNES_SAND_PLENTY = ${glslFloat(DUNES_SAND.plenty)};
const float DUNES_SLAB = ${glslFloat(DUNES_SLAB)};
// Grid cells per metre: a cell is about 5 m (constants.ts DUNES_UNIT).
const float DUNES_UNIT = ${glslFloat(DUNES_UNIT)};
// The entrance's glide: the eye starts this many cells upwind of its place and this far lower.
const float DUNES_PASSAGE_BACK = 34.0;
const float DUNES_PASSAGE_DROP = 4.5;

// Per cell (dunesLight): the wind's way and strength, the sandstorm (the World's fog, which the
// desert takes over as its dust, times the gale), how wet the sand is and how much snow lies on it.
float dunesWindSign = 1.0;
float dunesGale = 0.0;
float dunesFog = 0.0;
float dunesSandstorm = 0.0;
float dunesWet = 0.0;
float dunesLying = 0.0;
// The key light in grid space (the sun, or the moon once the sun is down), how high it stands and the
// relief it gives the slopes; its colours, the sky's fill (ambient) and the sand's (skylight).
vec3 dunesKey = vec3(0.0, 1.0, 0.0);
float dunesHigh = 0.0;
float dunesRelief = 1.0;
float dunesMoonlit = 0.0;
vec3 dunesMoonlight = vec3(0.0);
vec3 dunesKeyColor = vec3(0.0);
vec3 dunesSunlight = vec3(0.0);
vec3 dunesAmbient = vec3(0.0);
vec3 dunesSkylight = vec3(0.0);
// The passage now: how far the scene has come in and gone out, and how much of the glide remains.
float dunesPin = 1.0;
float dunesPout = 0.0;
bool dunesPassing = false;
float dunesLeft = 0.0;
// The camera in grid space: the eye at rest, the eye now and this cell's ray; the World's view of it
// in cells (the deck's shadows on the sand are reckoned through it, as the scene always did).
vec3 dunesRest = vec3(0.0);
vec3 dunesRo = vec3(0.0);
vec3 dunesRd = vec3(0.0, -1.0, 0.0);
WorldView dunesCamera;
// The air (dunesHaze): the haze toward this bearing, the dust the far dunes fade into, how thick it
// is and how far it reaches (cells).
vec3 dunesHorizon = vec3(0.0);
vec3 dunesDust = vec3(0.0);
float dunesHazeDensity = 0.0;
float dunesHazeReach = 1.0;

// The light from the World now: one key, the sun or the moon once the sun is down, both colours
// pre-faded. The sky's frame is the camera's turned by DUNES_LOOK, so the setting sun stands in the
// picture. A high sun or moon stands above the picture and out across the wind, where it lights stoss
// and lee alike and the dunes go flat: as it climbs, swing it round upwind (out of the picture nobody
// can tell) and steepen the slopes it lights, so stoss slopes and crests stay lit and slip faces fall
// into shade at every hour, as they do at sunset. In a sandstorm the dust swallows most of the sun;
// under the World's deck the moon fades as the sun's light does (worldAt's). A low sun is weak on flat
// ground but strong on the slopes turned to it, and outshines the sky many times over: expose the
// direct light up as it sinks and keep the sky's fill modest; a high sun is held back a little, so the
// sand turned to it does not burn out. The ambient carries the aurora's glow (w.glow), which reaches
// the land through clear air only: the sky's light with as much of the glow as the dust lets through
// (ambient), and the sand's fill, the sky's own light at 0.75 and that glow whole (skylight).
void dunesLight(World world) {
  Sky sky = world.sky;
  dunesWindSign = world.wind < 0.0 ? -1.0 : 1.0;
  // How hard it blows: drives the blowing sand, the ripples' creep and, with the dust, a sandstorm.
  dunesGale = min(abs(world.wind) / 0.8, 1.0);
  dunesFog = world.fog;
  dunesSandstorm = world.fog * dunesGale;
  dunesWet = uWeather.x;
  dunesLying = uWeather.y;
  dunesMoonlit = sky.sun.y > -0.03 ? 0.0 : 1.0;
  vec3 key = skyFacing(mix(sky.sun, sky.moon, dunesMoonlit), DUNES_TURN - DUNES_LOOK);
  dunesHigh = smoothstep(0.3, 0.6, key.y);
  vec2 keyAcross = key.xz / max(length(key.xz), 1e-4);
  key.xz = normalize(mix(keyAcross, vec2(-0.9 * dunesWindSign, 0.44), 0.5 * dunesHigh)) * length(key.xz);
  dunesKey = key;
  dunesRelief = 1.0 + 0.5 * dunesHigh;
  dunesMoonlight = sky.moonColor * (1.0 - WORLD_DECK_SUN * world.overcast);
  dunesKeyColor = (sky.sunColor + dunesMoonlight) * (1.0 - 0.7 * dunesSandstorm);
  dunesSunlight = dunesKeyColor / (0.38 + 0.62 * max(key.y, 0.0)) * (1.0 - 0.2 * dunesHigh * sky.day);
  dunesAmbient = sky.ambient - world.glow * dunesSandstorm;
  dunesSkylight = (sky.ambient - world.glow) * 0.75 + world.glow * (1.0 - dunesSandstorm);
}

// The passage now (dunesPin, dunesPout): 'left' is how much of the entrance's glide remains, exactly
// 0 at rest, where every passage term is off or multiplied away.
void dunesPassage() {
  dunesPin = passageIn();
  dunesPout = passageOut();
  dunesPassing = dunesPin < 1.0 || dunesPout > 0.0;
  float left = max(1.0 - dunesPin, 0.0);
  dunesLeft = left * left * left;
}

// Dust haze, the World's fog out here, along the sky's ray dir. The desert air is never quite clear;
// fog thickens it, and with a hard wind on top it becomes a sandstorm closing in to a few dune
// lengths: ochre, and dimming the sun. Under the World's deck the horizon it fades into greys as the
// sky does (worldGrey).
void dunesHaze(World world, vec3 dir) {
  Sky sky = world.sky;
  dunesHorizon = worldGrey(world, horizonHaze(sky, dir, 0.0), 1.0);
  vec3 dustTint = vec3(0.82, 0.58, 0.38) * (sky.sunColor * 0.55 + dunesAmbient * 1.1);
  dunesDust = mix(dunesHorizon, dustTint, 0.3 + 0.6 * dunesSandstorm);
  dunesHazeDensity = 0.3 + 0.7 * dunesFog + 2.0 * dunesSandstorm;
  dunesHazeReach = mix(DUNES_FAR, 280.0, dunesSandstorm);
}

// The rain's veil, toward the rain-washed horizon's grey, and the light the drops shine by: the sky
// they refract, the low sun and the lightning.
vec3 dunesRainAir(World world) {
  return greyed(dunesHorizon, vec3(0.94, 0.97, 1.02), 0.5 * world.overcast) * (1.0 - 0.25 * world.heavy) + WORLD_FLASH_SKY * world.flash;
}

vec3 dunesDropLight(World world) {
  return max(dunesHorizon * 1.2 + world.sky.sunColor * 0.3 + WORLD_FLASH_LIGHT * world.flash, vec3(0.08));
}

// A sandstorm: sheets of dust driven across the view at three depths, nearer ones faster, as far as
// the sand the ray meets (hitT, cells; -1 for none). Overhead the sheets hang a few cells above the
// sand; aerial, at 18, 40 and 87 cells out. How much of the dust they lay over the cell, before the
// storm's own strength.
float dunesSheets(float hitT, bool overhead, float tm) {
  float sheets = 0.0;
  for (int k = 0; k < 3; k++) {
    float d = overhead ? dunesRo.y - 6.0 + 2.5 * float(k) : 18.0 * pow(2.2, float(k));
    if (hitT > 0.0 && d > hitT) break;
    vec3 q = dunesRo + dunesRd * d;
    vec2 flow = vec2(q.x * dunesWindSign - tm * (6.0 + 12.0 * dunesGale), q.z);
    float n = fbm(flow * vec2(0.03, 0.08) + q.y * 0.1 + float(k) * 7.3);
    sheets += smoothstep(0.4, 0.75, n) * exp(-max(q.y, 0.0) / 14.0) * 0.6;
  }
  return sheets;
}
`;

/**
 * The dune sea's shared GLSL (both layers hold it): the common part and the per-cell camera, the
 * heat shimmer bending its rays while the desert's air is on (dunesCell).
 */
export const dunesSharedGlsl = `${DUNES_COMMON}
// The heat shimmer now (the desert's), this cell's ray in the rig's frame (bent by the heat, turned by
// the pointer), and what the dune field's ray met here (dunesGround; -1, none, while it is off), for
// the desert's passes after it.
float dunesHeat = 0.0;
vec3 dunesView = vec3(0.0, 0.0, 1.0);
float dunesHitT = -1.0;
bool dunesShowMark = false;
float dunesReach = 0.0;

// What both layers read in each cell: the light, the passage, the camera and its ray, the air. The eye
// stands higher over more sand (the dune field's supply; at the bare bed's height without it), and
// glides in from upwind and low through the entrance, rising to its place with the faintest overshoot
// (an ease-out-back); the dune field keeps it off the sand under it (dunesBegin). A high sun on hot,
// dry sand makes the air waver above the far dunes (not under the deck, nor once rain has wet the
// sand): the heat bends rays near the horizon, columns of hot air rising and wavering, a few rows up
// and down.
void dunesCell(Ctx x) {
  Sky sky = x.w.sky;
  dunesLight(x.w);
#if LAYER_DUNES
  float mean = (DUNES_SAND_SPARSE + (DUNES_SAND_PLENTY - DUNES_SAND_SPARSE) * K_sand * K_sand) * DUNES_SLAB;
#else
  float mean = 0.0;
#endif
#if LAYER_DESERT
  dunesHeat = K_heat * sky.day * smoothstep(0.3, 0.8, sky.sun.y) * (1.0 - x.w.overcast) * (1.0 - dunesWet);
#else
  dunesHeat = 0.0;
#endif
  vec2 uv = x.uv;
  float band = exp(-abs(uv.y - DUNES_HORIZON) * 28.0);
  vec2 waver = vec2(
    vnoise(vec2(uv.x * 23.0 + 7.0, x.tm * 1.0)),
    vnoise(vec2(uv.x * 34.0, (uv.y - DUNES_HORIZON) * 40.0 - x.tm * 0.9))
  ) - 0.5;
  vec2 at = uv + waver * vec2(0.004, 0.014) * band * dunesHeat;
  vec3 view = viewRay(at, x.aspect, DUNES_HORIZON, DUNES_FOV);
  view.xz = rotate(view.xz, -uPointer.x * DUNES_PARALLAX);
  dunesView = view;
  dunesRest = vec3(DUNES_EYE.x, DUNES_EYE_HEIGHT + DUNES_EYE_RISE * mean, DUNES_EYE.y);
  dunesRo = dunesRest;
  dunesRd = skyFacing(view, DUNES_TURN);
  dunesPassage();
  if (dunesPassing && dunesPin < 1.0) {
    float rise = passageSettle(dunesPin, 1.2);
    dunesRo.xz -= vec2(-sin(DUNES_TURN), cos(DUNES_TURN)) * DUNES_PASSAGE_BACK * dunesLeft;
    dunesRo.y -= DUNES_PASSAGE_DROP * (1.0 - rise);
  }
  dunesCamera = worldViewOf(view, uv, DUNES_HORIZON, DUNES_FOCAL, dunesRo.y, DUNES_LOOK, DUNES_UNIT);
  dunesHaze(x.w, dunesCamera.dir);
  dunesHitT = -1.0;
  dunesShowMark = false;
  dunesReach = DUNES_FAR;
}
`;

/** The desert's GLSL: its air, its sky, the dune sea past the field, the mirage, the sandstorm. */
export const desertGlsl = `
// ---- the desert (dunes/shader.ts) ----
// The desert's air, the backdrop's: the World through the dunes' camera (the ray the heat bends and
// the pointer turns), handed over in metres; the haze its birds fade into, the rain's veil and the
// drops' light; the dust per metre; the land closed by the dust at the field's far edge. The World's
// fog is the dust out here (dunesFog, taken by dunesCell before this): put out, so the composer's
// worldFog does not lay it again over what the dust has hazed.
void desertBegin(inout Ctx x) {
  x.v = dunesCamera;
  x.v.eye = dunesRo.y / DUNES_UNIT;
  x.v.unit = 1.0;
  x.eye = x.v.eye;
  x.zg = x.uv.y < RIG_HORIZON ? x.eye * RIG_FOCAL / (RIG_HORIZON - x.uv.y) : WORLD_FAR;
  x.air = Air(dunesDust, dunesRainAir(x.w), dunesDropLight(x.w), dunesHorizon, 0.0, dunesHazeDensity / dunesHazeReach * DUNES_UNIT, 0.0);
  x.landZ = DUNES_FAR / DUNES_UNIT;
  x.w.fog = 0.0;
}

// The World's sky (worldSky): the dome, the aurora ahead behind the clouds, the cloud deck, the Milky
// Way and the stars in its gaps, shooting stars over the dune sea, then the lightning. A sandstorm
// closes the night sky as the deck does (its overcast): the aurora and shooting stars fade behind the
// dust. Under rain or snow the World greys what its deck leaves open (worldGrey) and the desert greys
// the deck itself as well, then the dust swallows it low down and a sandstorm whole, the bolts too.
void desertSky(Ctx x, inout Cell c) {
  if (dunesView.y < 0.0) return;
  World through = x.w;
  through.overcast = max(x.w.overcast, dunesSandstorm);
  WorldSky heaven = worldSky(through, x.v, WORLD_METEOR_FIELD);
  float low = exp(-max(dunesView.y, 0.0) * mix(16.0, 3.0, dunesFog));
  c.col = mix(worldGrey(x.w, heaven.col, heaven.cloud) + heaven.strike, dunesDust, max((0.18 + 0.72 * dunesFog) * low, 0.9 * dunesSandstorm));
}

// Below the horizon, past the dune field's far edge: the dust closes the dune sea.
void desertFar(Ctx x, inout Cell c) {
  if (dunesView.y >= 0.0) return;
  c.col = dunesDust;
  c.z = DUNES_FAR / DUNES_UNIT;
}

// Mirage: under a high sun the far sand gives way to pools of shimmering sky along the horizon, the
// far crests standing in them (not on the M).
void desertMiddle(Ctx x, inout Cell c) {
  if (dunesShowMark || dunesHeat <= 0.0 || dunesView.y >= 0.0) return;
  float pools = smoothstep(0.3, 0.7, vnoise(vec2(x.uv.x * 6.0 + 3.0, x.tm * 0.08)));
  float mirage = dunesHeat * smoothstep(200.0, 650.0, dunesReach) * (0.4 + 0.6 * pools) * (0.8 + 0.2 * vnoise(vec2(x.uv.x * 40.0, x.tm * 1.5)));
  c.col = mix(c.col, skyColor(x.w.sky, normalize(vec3(x.v.dir.x, abs(x.v.dir.y) + 0.01, x.v.dir.z))), min(1.2 * mirage, 0.85));
}

// The sandstorm's sheets, over the World's birds, as far as the sand the ray meets.
void desertMiddleVeil(Ctx x, inout Cell c) {
  if (dunesSandstorm > 0.0) c.col = mix(c.col, dunesDust, clamp(dunesSheets(dunesHitT, false, x.tm) * dunesSandstorm * 1.3, 0.0, 0.9));
}
`;

/**
 * The dune field's drawing, held by its layer and by the view from above: the fields, the M, the
 * march, the shadows, the sand's and the stone's materials, the passage's veil. Its fields are read
 * through `dunesField0` / `dunesField1` and their `...On()` (the composer's accessors, or the view
 * from above's own).
 */
const DUNES_FIELD = `
// ---- the dune field (dunes/shader.ts) ----
const vec2 DUNES_MARK_AT = vec2(${glslFloat(DUNES_MARK.x)}, ${glslFloat(DUNES_MARK.z)});
const float DUNES_MARK_YAW = ${glslFloat(DUNES_MARK.yaw)};
const float DUNES_MARK_SMALL = ${glslFloat(DUNES_MARK.small)};
const float DUNES_MARK_LARGE = ${glslFloat(DUNES_MARK.large)};
const float DUNES_MARK_STROKE = ${glslFloat(DUNES_MARK.stroke)};
const float DUNES_MARK_DEPTH = ${glslFloat(DUNES_MARK.depth)};
const float DUNES_MARK_SCOUR = ${glslFloat(DUNES_MARK.scour)};
// Lying snow, before the light.
const vec3 DUNES_SNOW = vec3(0.88, 0.9, 0.94);

float dunesHeight(vec2 p) {
  return dunesField0On() ? texture(dunesField0, p / DUNES_GRID).r : 0.0;
}

// Slope dh/dx, dh/dz, curvature (negative on crests and brinks), hollowness (positive in troughs).
vec4 dunesShape(vec2 p) {
  return dunesField1On() ? texture(dunesField1, p / DUNES_GRID) : vec4(0.0);
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

// The field's own per cell (dunesFieldAt): the M's height (0 while it stands not), how far the ray
// looks into the key (crests and grains backlit), the lit blowing sand, glowing when the sun is behind
// it, and how much sand blows (wet or snowed-on sand stays put).
float dunesMarkHeight = 0.0;
float dunesAgainst = 0.0;
vec3 dunesGrains = vec3(0.0);
float dunesDrift = 0.0;

void dunesFieldAt(bool overhead) {
  dunesMarkHeight = K_dunesMark > 0.0 ? mix(DUNES_MARK_SMALL, DUNES_MARK_LARGE, K_dunesMark) : 0.0;
  vec2 flatRd = dunesRd.xz / max(length(dunesRd.xz), 1e-4);
  vec2 flatKey = dunesKey.xz / max(length(dunesKey.xz), 1e-4);
  dunesAgainst = overhead ? 0.0 : pow(max(dot(flatRd, flatKey), 0.0), 3.0);
  dunesGrains = vec3(0.96, 0.76, 0.52) * (dunesKeyColor * (0.55 + 0.9 * dunesAgainst) + dunesAmbient * 1.2);
  dunesDrift = K_drift * dunesGale * (1.0 - max(dunesWet, dunesLying));
}

// The M where the ray meets it markT cells out. Weathered sandstone: broad wavy strata of redder and
// paler rock with fine cross-bedding, dark desert varnish streaking down from the top, the foot scoured
// pale and smooth, the faces pitted by the wind. Rain darkens it a little; snow lies on its ledges and
// tops. The sun is always somewhere ahead, so the face toward us is mostly in shade: a fuller sky fill
// than the sand's keeps the stone's colour and strata legible; backlit, its edges catch a thin line of
// the sun; the sunlit sand around it lights its faces from below. Its accent: lit faces brighter.
vec3 dunesStone(World world, float markT, bool overhead, out float accent) {
  Sky sky = world.sky;
  vec3 key = dunesKey;
  float markHeight = dunesMarkHeight;
  vec3 q = dunesRo + dunesRd * markT;
  vec3 n = dunesMarkNormal(q, markHeight);
  vec2 face = rotate(q.xz - DUNES_MARK_AT, -DUNES_MARK_YAW);
  float my = q.y / markHeight;
  float strata = sin(q.y * 1.7 + 1.2 * vnoise(vec2(face.x * 0.3, q.y * 0.5))) + 0.25 * sin((q.y - 0.35 * face.x) * 7.0);
  vec3 stone = mix(vec3(0.74, 0.42, 0.26), vec3(0.92, 0.66, 0.45), clamp(0.5 + 0.4 * strata, 0.0, 1.0));
  float varnish = smoothstep(0.6, 0.9, vnoise(vec2(face.x * 0.9, q.y * 0.12 + 3.0))) * smoothstep(0.35, 0.95, my);
  stone *= 1.0 - 0.35 * varnish;
  stone = mix(stone, vec3(0.94, 0.74, 0.54), 0.35 * smoothfall(0.3, 0.0, my));
  n = normalize(n + 0.12 * (vec3(vnoise(q.yz * 2.0), vnoise(q.xz * 2.0 + 2.0), vnoise(q.xy * 2.0 + 4.0)) - 0.5));
  if (dunesWet > 0.0) stone = wetten(stone, dunesWet, 0.4);
  if (dunesLying > 0.0) stone = mix(stone, DUNES_SNOW, snowCover(n, q.xz * 0.3, dunesLying));
  float ndl = max(dot(n, key), 0.0);
  float shade = key.y > 0.0 ? dunesShadow(q + n * 0.15, key, 0.0, 0.0) : 0.0;
  // The World's cloud deck shades it too (worldSunlit), while the sun is the key.
  if (dunesMoonlit < 0.5 && shade > 0.0) shade *= worldSunlit(world, dunesCamera, skyFacing(q - dunesRest, -DUNES_TURN));
  vec3 bounce = dunesKeyColor * vec3(0.9, 0.62, 0.4) * 0.45 * clamp(key.y * 2.5, 0.0, 1.0) * (0.5 - 0.5 * n.y);
  vec3 col = stone * dunesSunlight * ndl * shade + greyed(stone, vec3(1.0), 0.3) * dunesAmbient * 0.9 * (0.55 + 0.45 * n.y) + stone * bounce;
  col += stone * dunesSunlight * pow(1.0 - max(dot(n, -dunesRd), 0.0), 3.0) * dunesAgainst * shade * 0.6;
  col *= mix(vec3(1.0), vec3(0.7, 0.85, 1.3), sky.night * 0.75);
  col = mix(col, dunesDust, fogAmount(dunesHazeDensity, overhead ? 0.25 * dunesFog : markT / dunesHazeReach, q.y / 22.0));
  accent = clamp(0.45 + 0.55 * ndl * shade, 0.0, 1.0);
  return col;
}

// The sand where the ray lands at p, reach cells out, with the ripples' phase there and its rate
// across the screen (alias) and the cells a pixel covers (footprint), taken out by the caller in
// uniform control flow (fwidth). Thin sand over the bed (bare between barchans), slip faces (the steep
// lee, at repose), crests and brinks, and troughs (darker, less sky). Wind ripples square to the wind:
// a skewed wave with a long gentle stoss and a short steep lee, bending and forking where the noise
// warps the phase, creeping downwind; none on slip faces (avalanches wipe them) and faded where they
// would be finer than the dither. Warm sand, the slip faces darker and smoother with faint avalanche
// chutes; a gravel bed. Rain darkens the sand and deepens its colour; snow lies on it, the gentle
// slopes first; by moonlight the eye loses colour: sand reads grey-blue. The World's cloud deck's
// shadows drift over it (worldSunlit), while the sun is the key: from the same deck over the eye at
// rest. Sunlit sand throws light back into the shade (less under a high sun, so the slip faces keep
// theirs); the sky fills the shade with cooler, greyer light, and at night little of it finds the slip
// faces. Crests catch the light when it comes from behind them; the moon lays a cool sheen along them;
// out of the sun the sand takes the sky's colour. Quartz grains glint on the nearer sunlit sand
// (shimmer). Blowing sand: sheets skimming up the stoss slopes, thickest toward the crest, brightening
// whatever light falls there, and over the slip face just downwind of a brink sand streaming off the
// crest in a veil. Then the dust over the distance.
vec3 dunesSand(World world, vec3 p, float reach, float lambda, float phase, float alias, float footprint, bool overhead, float tm, out float shimmer) {
  Sky sky = world.sky;
  vec3 key = dunesKey;
  float windSign = dunesWindSign;
  vec4 shape = dunesShape(p.xz);
  float cover = smoothstep(0.02, 0.6, p.y);
  float slip = smoothstep(0.3, 0.5, -windSign * shape.x) * cover;
  float crest = smoothstep(0.08, 0.24, -shape.z) * cover;
  float ao = 1.0 - 0.38 * smoothstep(0.0, 1.3, shape.w);
  if (dunesMarkHeight > 0.0 && length(p.xz - DUNES_MARK_AT) < dunesMarkHeight) {
    ao *= 0.55 + 0.45 * smoothstep(0.0, 2.5, dunesMarkSdf(p, dunesMarkHeight));
  }
  float ripples = K_ripples * cover * (1.0 - slip) * (1.0 - 0.6 * crest) * (1.0 - smoothstep(0.18, 0.42, alias));
  float s = TAU * phase;
  float tilt = cos(s - 0.7 * sin(s)) * (1.0 - 0.7 * cos(s)) * (TAU / lambda) * 0.018 * ripples;
  vec3 n = normalize(vec3(-(shape.x + tilt * windSign) * dunesRelief, 1.0, -shape.y * dunesRelief));
  vec3 sand = mix(vec3(0.92, 0.66, 0.42), vec3(0.8, 0.55, 0.35), slip);
  float grain = 1.0 - smoothstep(0.08, 0.25, footprint);
  sand *= (1.0 - 0.07 * slip * grain * vnoise(vec2(p.z * 1.4, p.x * 0.2))) * (0.94 + 0.06 * vnoise(p.xz * 0.35));
  vec2 pan = rotate(p.xz, 0.6);
  vec3 bed = vec3(0.62, 0.46, 0.36) * (0.78 + 0.22 * vnoise(pan * 0.35) + 0.12 * vnoise(pan * 0.9 + 3.0)) * (1.0 + 0.12 * grain * (vnoise(pan * 2.5) - 0.5));
  vec3 albedo = mix(bed, sand, cover);
  if (dunesWet > 0.0) albedo = wetten(albedo, dunesWet, 0.8);
  if (dunesLying > 0.0) albedo = mix(albedo, DUNES_SNOW, snowCover(n, p.xz * 0.3, dunesLying));
  albedo = greyed(albedo, vec3(1.0), 0.5 * sky.night);

  float ndl = max(dot(n, key), 0.0);
  float lit = ndl > 0.0 && key.y > 0.0 ? dunesShadow(p + vec3(0.0, 0.06, 0.0), key, dunesMarkHeight, 0.004 * reach) : 0.0;
  if (dunesMoonlit < 0.5 && lit > 0.0) lit *= worldSunlit(world, dunesCamera, skyFacing(p - dunesRest, -DUNES_TURN));
  vec3 bounce = dunesKeyColor * albedo * 0.25 * clamp(key.y * 2.0, 0.0, 1.0) * clamp(1.0 - 0.6 * n.y, 0.0, 1.0) * (1.0 - 0.5 * dunesHigh);
  float fill = ao * (0.55 + 0.45 * n.y) * (1.0 - 0.45 * slip * sky.night);
  vec3 col = albedo * dunesSunlight * ndl * lit + greyed(albedo, vec3(1.0), 0.4) * dunesSkylight * fill + bounce * ao;
  col += dunesKeyColor * albedo * crest * dunesAgainst * lit * 0.35;
  col += dunesMoonlight * (dunesMoonlit * sky.night * 0.6) * crest * ndl * lit;
  vec3 skyHue = dunesSkylight / max(dot(dunesSkylight, LUMA), 1e-3);
  float cool = sky.day * (0.35 * slip * dunesHigh + 0.3 * smoothstep(0.2, 1.4, shape.w));
  col = greyed(col, skyHue, cool);
  col *= mix(vec3(1.0), vec3(0.7, 0.85, 1.3), sky.night * 0.75);
  shimmer = 0.06 * ndl * lit * cover * sky.day * smoothfall(140.0, 30.0, reach);

  if (dunesDrift > 0.0) {
    float near = overhead ? 1.0 : smoothfall(170.0, 50.0, reach);
    float flux = cover * (1.0 - slip) * (0.25 + 0.75 * crest + 0.5 * smoothstep(0.0, 0.3, windSign * shape.x));
    float sheet = dunesStreak(p, tm, windSign, dunesGale, overhead ? 0.9 : 1.8) * flux * dunesDrift * near;
    col = mix(col, col * 1.4 + dunesGrains * albedo * 0.1, sheet * 0.6);
    float brink = max(
      smoothstep(0.08, 0.24, -dunesShape(p.xz - vec2(windSign * 1.5, 0.0)).z),
      0.7 * smoothstep(0.08, 0.24, -dunesShape(p.xz - vec2(windSign * 3.5, 0.0)).z)
    );
    float veil = brink * slip * dunesStreak(p + vec3(0.0, 0.0, 3.7), tm * 1.4, windSign, dunesGale, overhead ? 0.9 : 1.5);
    col = mix(col, dunesGrains, veil * dunesDrift * near * 0.55);
  }

  return mix(col, dunesDust, fogAmount(dunesHazeDensity, overhead ? 0.25 * dunesFog + 0.6 * dunesSandstorm : reach / dunesHazeReach, p.y / 22.0));
}

// The passage's veil: low drifts of blown sand hugging the ground and streaming off the crests, soft
// broken sheets and wisps, never up in the sky. Arriving, the wind drops: a front of the veil clears
// from upwind (left) across the picture to the right and the drifts slow. Leaving, the wind rises:
// drifts stream in from the left and thicken. Each is cut per cell (hardEdge) and its pattern carried
// whole, so nothing crawls. The front is exactly off at rest. Aerial, it thins out within 0.15 of the
// screen above the horizon; the far field has none. hitT: where the ray meets the sand (cells, -1 for
// none).
void dunesVeil(float hitT, vec2 uv, bool overhead, inout vec3 col) {
  if (!dunesPassing) return;
  float x = uv.x + 0.12 * (vnoise(vec2(uv.y * 5.0, 3.0)) - 0.5);
  float density = 0.0;
  float travel = 0.0;
  if (dunesPout > 0.0) {
    float e = mix(-0.45, 1.6, smoothstep(0.0, 1.0, dunesPout));
    density = smoothfall(e, e - 0.45, x);
    travel = ${glslFloat(DUNES_PASSAGE.exit)} * (10.0 * dunesPout + 16.0 * dunesPout * dunesPout);
  } else {
    float cleared = 1.0 - (1.0 - dunesPin) * (1.0 - dunesPin);
    float e = mix(-0.4, 1.5, cleared);
    density = smoothstep(e, e + 0.45, x);
    travel = ${glslFloat(DUNES_PASSAGE.enter)} * 26.0 * (dunesPin - 0.5 * dunesPin * dunesPin);
  }
  float reachV = hitT > 0.0 ? hitT : 240.0;
  float skyLow = overhead ? 1.0 : smoothfall(0.15, 0.0, uv.y - DUNES_HORIZON);
  float distant = smoothfall(700.0, 350.0, reachV);
  if (density > 0.0 && skyLow > 0.0 && distant > 0.0) {
    float veil = 0.0;
    for (int k = 0; k < 4; k++) {
      // Points along the last stretch of the ray before it meets the sand, weighted by how close
      // to the sand they lie, and by crests just upwind that the sand streams off.
      vec3 q = dunesRo + dunesRd * (reachV * (0.97 - 0.12 * float(k) * float(k) / 3.0));
      float hug = exp(-max(q.y - dunesHeight(q.xz), 0.0) / 3.5);
      float crest = max(
        smoothstep(0.08, 0.24, -dunesShape(q.xz - vec2(dunesWindSign * 3.0, 0.0)).z),
        0.7 * smoothstep(0.08, 0.24, -dunesShape(q.xz - vec2(dunesWindSign * 9.0, 0.0)).z)
      );
      veil = max(veil, hug * (0.35 + 0.65 * crest) * dunesVeilSheet(q.xz, travel * (1.25 - 0.12 * float(k)), dunesWindSign));
    }
    vec3 veilColor = mix(dunesGrains, dunesDust, 0.35);
    col = mix(col, veilColor, 0.65 * hardEdge(0.75 * veil * density * skyLow * distant));
  }
}
`;

/** The dune field's GLSL: the drawing above, and its passes. */
export const dunesFieldGlsl = `${DUNES_FIELD}
// ---- the dune field's passes ----
// What it keeps of each cell: the crest its ray skimmed closest over, and the quartz glints there.
vec4 dunesSkim = vec4(0.0);
float dunesShimmer = 0.0;

// The eye kept off the sand under it while it glides in, the World's view at that height (metres),
// and the field's own light.
void dunesBegin(inout Ctx x) {
  if (dunesPassing && dunesPin < 1.0) dunesRo.y = max(dunesRo.y, dunesHeight(dunesRo.xz) + 1.5);
  x.eye = dunesRo.y / DUNES_UNIT;
  x.v.eye = x.eye;
  dunesFieldAt(false);
  dunesSkim = vec4(0.0);
  dunesShimmer = 0.0;
}

// What the ray meets: the sand or the M before it, marched from where the ray drops below the
// tallest sand (or from the eye while it is lower); past the far field, nothing (the desert's dust).
// Where it lands, the ripple phase there with its rate across the screen, taken out here, in uniform
// control flow, because fwidth needs every neighbour to run it.
void dunesGround(Ctx x, inout Cell c) {
  vec3 ro = dunesRo;
  vec3 rd = dunesRd;
  vec4 skim = vec4(0.0);
  float hitT = -1.0;
  if (rd.y < 0.0 || ro.y < DUNES_TOP) {
    hitT = dunesMarch(ro, rd, ro.y > DUNES_TOP ? (ro.y - DUNES_TOP) / -rd.y : 0.0, skim);
  }
  float markT = dunesMarkHeight > 0.0 ? dunesMarkHit(ro, rd, dunesMarkHeight, hitT < 0.0 ? DUNES_FAR : hitT) : -1.0;
  float reach = hitT < 0.0 ? DUNES_FAR : hitT;
  vec3 p = ro + rd * reach;
  float lambda = 0.55;
  float warp = 1.7 * vnoise(p.xz * vec2(0.11, 0.33)) + 0.6 * vnoise(p.xz * vec2(0.45, 1.3) + 5.0);
  float phase = p.x * dunesWindSign / lambda + warp - x.tm * (0.05 + 0.4 * dunesGale);
  float alias = fwidth(phase);
  // Cells per pixel here, to keep fine grain coarser than the dither.
  float footprint = length(fwidth(p.xz));
  bool showMark = markT > 0.0 && (hitT < 0.0 || markT < hitT);
  dunesHitT = hitT;
  dunesShowMark = showMark;
  dunesReach = reach;
  dunesSkim = skim;
  if (showMark) {
    float accent = 0.0;
    c.col = dunesStone(x.w, markT, false, accent);
    c.z = markT / DUNES_UNIT;
    c.zs = min(c.zs, c.z);
    c.accent = accent;
  } else if (hitT > 0.0) {
    c.col = dunesSand(x.w, p, reach, lambda, phase, alias, footprint, false, x.tm, dunesShimmer);
    c.z = reach / DUNES_UNIT;
    c.accent = 0.0;
  }
}

// Sand blowing off the crests the ray skimmed, seen against the sky or the dunes beyond.
void dunesMiddle(Ctx x, inout Cell c) {
  if (dunesDrift <= 0.0 || dunesSkim.w <= 0.0 || dunesShowMark) return;
  float wisp = dunesSkim.w * dunesStreak(dunesSkim.xyz, x.tm * 1.3, dunesWindSign, dunesGale, 1.2) * smoothfall(250.0, 60.0, length(dunesSkim.xyz - dunesRo));
  c.col = mix(c.col, dunesGrains, wisp * dunesDrift * 0.5);
}

// Over the World's birds and the sandstorm: the passage's veil; then pouring sand, a stream falling
// onto each hand while its button is held (the sim heaps it up), only where the sim can heap it: on
// the sand, below the horizon.
void dunesMiddleVeil(Ctx x, inout Cell c) {
  dunesVeil(dunesHitT, x.uv, false, c.col);
  for (int i = 0; i < MAX_PRINCIPALS; i++) {
    if (i >= uPrincipalCount) break;
    vec4 hand = uPrincipals[i];
    float pouring = max(hand.z, 1.0 - smoothstep(0.0, 0.6, uTime - hand.w));
    if (pouring <= 0.0 || hand.y >= DUNES_HORIZON - 0.01) continue;
    vec2 q = (x.uv - hand.xy) * vec2(x.aspect, 1.0);
    float width = 0.006 + 0.012 * smoothfall(0.02, -0.01, q.y);
    float stream = smoothfall(width, 0.0, abs(q.x)) * smoothstep(-0.015, 0.0, q.y) * smoothfall(0.24, 0.1, q.y);
    stream *= 0.55 + 0.45 * vnoise(vec2(q.x * 260.0, q.y * 50.0 + uTime * 12.0));
    c.col = mix(c.col, dunesGrains * vec3(0.95, 0.75, 0.5), stream * pouring);
  }
}

// The quartz glints, the dither's per-cell sparkle.
void dunesShade(Ctx x, Cell c, inout Shade o) {
  o.shimmer = dunesShimmer;
}
`;

/** Rain and snow overhead are drawn as a camera pitched this far down (radians, ~50°) sees them. */
const OVERHEAD_PITCH = 0.87;

/**
 * The view from straight above (the dune field's `camera` at 1), until the overhead composer takes it
 * (ADR 0062 Phase 4, `dunesabove`): a program of the dunes' own, as the scene drew it, whose entry
 * stands in for the composer's. `fields`: the texture slots the composed sim gives the dune field's
 * two fields in this layer set (composer/sim.ts allocate). Straight down on the M's patch of desert,
 * the wind blowing left to right; arriving, the view settles down from a little higher. The World
 * gives the light, the deck's shadows on the sand and the rain and snow falling past, their paths
 * converging on a point about half a screen below the frame (straight down, that point would sit at
 * the frame's middle, where rainFallSeen cannot tell the paths apart); its sky and birds are drawn for
 * a level camera, so this view has neither.
 */
export function dunesAboveGlsl(fields: readonly number[]): string {
  const accessor = (k: number): string => {
    const slot = fields[k];
    return slot === undefined
      ? `#define dunesField${k} uSim0\nbool dunesField${k}On() { return false; }`
      : `#define dunesField${k} uSim${slot}\nbool dunesField${k}On() { return ${simOn(slot)} > 0.5; }`;
  };
  return `
${worldGlsl}
${DUNES_COMMON}
// ---- the dune field from straight above (dunes/shader.ts dunesAboveGlsl) ----
${accessor(0)}
${accessor(1)}
${DUNES_FIELD}
const int DUNES_METEOR_SLOT = ${WORLD_TRIGGERS.meteors};
const int DUNES_LIGHTNING_SLOT = ${WORLD_TRIGGERS.lightning};
// Cells per screen height, centred on the M; arriving, this share farther out.
const float DUNES_MAP_SPAN = ${glslFloat(DUNES_MAP.span)};
const float DUNES_PASSAGE_ZOOM = 0.3;
const float DUNES_OVERHEAD_PITCH = ${glslFloat(OVERHEAD_PITCH)};

Shade ${COMPOSER_ENTRY}(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  float tm = uMotionTime;
  World world = worldAt(DUNES_METEOR_SLOT, DUNES_LIGHTNING_SLOT);
  dunesLight(world);
  float mean = (DUNES_SAND_SPARSE + (DUNES_SAND_PLENTY - DUNES_SAND_SPARSE) * K_sand * K_sand) * DUNES_SLAB;
  vec3 view = viewRay(uv, aspect, DUNES_HORIZON, DUNES_FOV);
  view.xz = rotate(view.xz, -uPointer.x * DUNES_PARALLAX);
  // The eye at rest: the World's cloud deck casts its shadows about it, so they lie where they do
  // seen low across the field.
  dunesRest = vec3(DUNES_EYE.x, DUNES_EYE_HEIGHT + DUNES_EYE_RISE * mean, DUNES_EYE.y);
  dunesPassage();
  float span = DUNES_MAP_SPAN * (1.0 + DUNES_PASSAGE_ZOOM * dunesLeft);
  vec2 g = DUNES_MARK_AT + (uv - 0.5) * vec2(aspect, 1.0) * span;
  dunesRo = vec3(g.x, DUNES_TOP + 24.0, g.y);
  dunesRd = vec3(0.0, -1.0, 0.0);
  // The World through this camera: the ray is left unused; it gives the light, the deck's shadows
  // and the rain and snow falling past.
  dunesCamera = worldViewOf(view, uv, DUNES_HORIZON, DUNES_FOCAL, dunesRo.y, DUNES_LOOK, DUNES_UNIT);
  dunesFieldAt(true);
  float hitT = dunesRo.y - dunesHeight(dunesRo.xz);
  float markT = dunesMarkHeight > 0.0 ? dunesMarkHit(dunesRo, dunesRd, dunesMarkHeight, hitT < 0.0 ? DUNES_FAR : hitT) : -1.0;
  float reach = hitT < 0.0 ? DUNES_FAR : hitT;
  vec3 p = dunesRo + dunesRd * reach;
  float lambda = 1.2;
  float warp = 1.7 * vnoise(p.xz * vec2(0.11, 0.33)) + 0.6 * vnoise(p.xz * vec2(0.45, 1.3) + 5.0);
  float phase = p.x * dunesWindSign / lambda + warp - tm * (0.05 + 0.4 * dunesGale);
  float alias = fwidth(phase);
  float footprint = length(fwidth(p.xz));
  dunesHaze(world, dunesCamera.dir);

  vec3 col;
  bool showMark = markT > 0.0 && (hitT < 0.0 || markT < hitT);
  if (showMark) col = dunesStone(world, markT, true, o.accent);
  else if (hitT > 0.0) col = dunesSand(world, p, reach, lambda, phase, alias, footprint, true, tm, o.shimmer);
  else col = dunesDust;
  float z = showMark ? markT : hitT >= 0.0 || view.y < 0.0 ? reach : WORLD_FAR;

  if (dunesSandstorm > 0.0) col = mix(col, dunesDust, clamp(dunesSheets(hitT, true, tm) * dunesSandstorm * 1.3, 0.0, 0.9));
  dunesVeil(hitT, uv, true, col);

  float down = sin(DUNES_OVERHEAD_PITCH);
  float ahead = cos(DUNES_OVERHEAD_PITCH);
  worldPrecipSeen(world, dunesCamera, vec3(1.0, 0.0, 0.0), vec3(0.0, ahead, down), vec3(0.0, -down, ahead), dunesRainAir(world), dunesDropLight(world), z, col, o.accent);

  col = clamp(col, 0.0, 1.0);
  Shade s = shadeOf(col, inkOf(col, ${glslFloat(DUNES_GRADE.ink.gain)}, ${glslFloat(DUNES_GRADE.ink.gamma)}), o.accent);
  s.shimmer = o.shimmer;
  return s;
}
`;
}
