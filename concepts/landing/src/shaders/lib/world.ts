// The shared world: one atmosphere for every outdoor scene, read from the world's knobs
// (scenes/world.ts: worldKnobs) and composed in one order, so the sky, the weather and what flies in
// it are the same world in every scene and the scenes differ only by their camera and what they put
// in it. The contract, the order and how a scene adopts it: src/scenes/README.md ("World layers").
//
// Opt-in: a scene that composes the world puts `worldGlsl` in its own GLSL (at the top), merges
// worldFeatures(values) into its featuresFor and WORLD_ALL into its featuresAll (scenes/world.ts),
// and takes its knobs from worldKnobs. It composes the birds (birds.ts) and the Milky Way
// (milkyway.ts) itself, so such a scene does not put birdsGlsl or milkyWayGlsl in its GLSL again.
//
//   World worldAt(int meteorSlot, int lightningSlot);   // the world now, once per pixel
//   WorldView worldView(vec2 uv, float horizon, float focal, float eye, float yaw, float unit);
//   WorldView worldViewOf(vec3 ray, vec2 uv, float horizon, float focal, float eye, float yaw, float unit);
//   vec2 worldDeckDrift(World w, WorldView v);                    // the wind on the deck, in the sky's frame
//   vec3 worldGrey(World w, vec3 col, float open);                // the grey day under rain or snow
//   float worldFogAt(World w, float metres, float height);        // the fog over a distance, in metres
//   WorldSky worldSky(World w, WorldView v, vec4 meteorField);   // behind the scene
//   WorldSky worldSkyOver(World w, WorldView v, vec4 meteorField, vec3 col); // the same over a dome of its own
//   float worldSunlit(World w, WorldView v, vec3 at);             // the cloud deck's and the cumulus' shadows
//   void worldBirds(World w, WorldView v, WorldFlyway f, vec3 haze, float thick, inout vec3 col, inout float z, inout float accent);
//   void worldFog(World w, WorldView v, vec3 fogCol, float z, inout vec3 col, inout float accent);
//   void worldPrecip(World w, WorldView v, vec3 air, vec3 dropLight, float z, inout vec3 col, inout float accent);
//   void worldPrecipSeen(World w, WorldView v, vec3 right, vec3 up, vec3 fwd, vec3 air, vec3 dropLight, float z, inout vec3 col, inout float accent);
//   void worldOver(World w, WorldView v, WorldFlyway f, vec3 haze, float thick, vec3 air, vec3 dropLight, inout vec3 col, inout float z, inout float accent);
//   void worldPrecipThinned(World w, WorldView v, vec3 air, vec3 dropLight, float z, vec2 thin, inout vec3 col, inout float accent);
//   WorldView worldMirrorView(WorldView v, vec3 ray, float blur);  // a level mirror's view (water, a wet film)
//   WorldSky worldMirrorSky(World w, WorldView m, vec4 meteorField);
//   void worldBirdsMirrored(World w, WorldView m, WorldFlyway f, vec3 haze, float thick, float still, inout vec3 col);
//
// Each part behind a knob is compiled in only while its gate is on (WORLD_STARS, WORLD_MILKYWAY,
// WORLD_METEORS, WORLD_AURORA, WORLD_CLOUDS, WORLD_SHADOWS, WORLD_CUMULUS, WORLD_BIRDS, WORLD_RAIN,
// WORLD_SNOW, WORLD_FOG, WORLD_LIGHTNING, each 0 or 1: worldFeatures), and keeps its runtime test
// of the knob inside, so with the knob off (gate on or not) it gives its neutral value exactly. So
// does what a setting's knobs settle before the program runs: the shower's and the storm's own
// events (WORLD_METEOR_RATE, WORLD_LIGHTNING_RATE, off while their knobs are: the "now" buttons'
// stay), the moon's phase (WORLD_MOON, off without a moon) and the sun's light (WORLD_DAYLIGHT, off
// at an hour deep in the night on every date: day, night and sunColor are then constants).
import { glslFloat } from "../glsl.ts";
import { birdsGlsl } from "./birds.ts";
import { milkyWayGlsl } from "./milkyway.ts";

/**
 * A painted cumulus tower (K_cumulus, WORLD_CUMULUS): across (a share of the view's half-width at the
 * horizon), the height of its flat base over the horizon and its width (both in tangent units, the
 * camera ray's y / z and x / z: screen heights at a focal of one), its height as a share of its
 * width, the seed of its lobes.
 */
type CumulusTower = readonly [
  across: number,
  base: number,
  width: number,
  tall: number,
  seed: number,
];

/** The towers, small ones first: the first CUMULUS_PUFFS keep their size. */
const CUMULUS: readonly CumulusTower[] = [
  [0.05, 0.22, 0.07, 0.6, 4.1],
  [-0.85, 0.13, 0.06, 0.55, 9.3],
  [0.68, 0.26, 0.055, 0.6, 14.9],
  [-0.38, 0.19, 0.26, 0.85, 21.7],
  [0.95, 0.16, 0.2, 0.8, 30.2],
  [0.42, 0.17, 0.3, 0.85, 41.3],
];
const CUMULUS_PUFFS = 3;

/** One property of every tower, as a const float array initialiser. */
function cumulusFloats(pick: (tower: CumulusTower) => number): string {
  return `float[${CUMULUS.length}](${CUMULUS.map((tower) => glslFloat(pick(tower))).join(", ")})`;
}

/**
 * When the world's birds set out, as BirdSky.hours on the time of day: they start coming from x to y
 * (around sunrise) and stop from z to w (dusk), so by day only. scenes/world.ts gates them on it.
 */
export const WORLD_BIRD_HOURS = [0.22, 0.26, 0.8, 0.84] as const;

export const worldGlsl = `
// ---- the world (shaders/lib/world.ts) ----
#if WORLD_BIRDS
${birdsGlsl}
#endif
#if WORLD_MILKYWAY
${milkyWayGlsl}
// The galaxy's plane, fixed in the stars' frame (skyStarFrame: so every scene's yaw shows its own
// stretch of it, and it turns with the stars as the night passes): staged as an arc leaning out of
// the horizon on the sunset side of the sky's ahead and climbing ~60 degrees over it toward the
// sunrise side.
const MilkyWayBand WORLD_GALAXY = MILKY_WAY_BAND(normalize(vec3(0.13, -0.86, 0.5)));
#endif

// Under the deck rain or snow closes over the sky (overcast, weatherOvercast) the sun's light fades
// by this share, the sky's light and the sky the deck leaves open (worldGrey) grey by this share and
// darken with the storm's amount, and the twilight's colours give way. A scene that shows its deck
// coming down as the fall grows heavier sets World.low to 1 + WORLD_DECK_LOW x storm.
const float WORLD_DECK_SUN = 0.88;
const float WORLD_DECK_GREY = 0.6;
const float WORLD_DECK_DARK = 0.3;
const float WORLD_DECK_TWILIGHT = 0.7;
const float WORLD_DECK_LOW = 1.5;
// Lightning: its light on the land at full flash (in World.sky.ambient), the sky's glow low down,
// the cloud base its bolts drop from (the slope over the horizon, ~12 degrees up) and how wide a
// share of the view they strike in, about the middle.
const vec3 WORLD_FLASH_LIGHT = vec3(0.45, 0.5, 0.62);
const vec3 WORLD_FLASH_SKY = vec3(0.1, 0.11, 0.16);
const float WORLD_BOLT_RISE = 0.22;
const float WORLD_BOLT_SPREAD = 0.7;
// The Milky Way's glow, and how much of it moonlight at its brightest (a full moon high up, moonColor
// of luminance WORLD_GALAXY_MOONLIT) washes out: it shows on dark nights.
const vec3 WORLD_GALAXY_TINT = vec3(0.085, 0.085, 0.115);
const float WORLD_GALAXY_MOON = 0.85;
const float WORLD_GALAXY_MOONLIT = 0.34;
// Birds set out by day (WORLD_BIRD_HOURS), fewer the harder it rains or snows; lit by the sky.
const vec4 WORLD_BIRD_HOURS = vec4(${WORLD_BIRD_HOURS.map(glslFloat).join(", ")});
// The cloud deck's base over the eye, metres: the scale of its shadows and how fast they cross.
const float WORLD_CLOUD_BASE = 1000.0;
// Fog: a distance of z metres is fogAmount's 1 - exp(-z / WORLD_FOG_REACH); the layer is
// WORLD_FOG_TOP metres deep; the open sky's fog is reckoned out to WORLD_FOG_SKY metres along the
// ray, so it hugs the horizon.
const float WORLD_FOG_REACH = 60.0;
const float WORLD_FOG_TOP = 40.0;
const float WORLD_FOG_SKY = 300.0;
// Rain's and snow's nearest, out-of-focus drops are dimmer by this share.
const float WORLD_NEAR_DIM = 0.15;
// Snowflakes, lit by the sky and the sun.
const vec3 WORLD_FLAKE = vec3(0.92, 0.94, 0.98);
// The distance (scene units) of open sky: nothing stands there.
const float WORLD_FAR = 1e4;

#if WORLD_CUMULUS
// The painted cumulus (K_cumulus): towers laid out across the view, each its across share of the
// view's half-width at the horizon (in tangent units, at least WORLD_CUMULUS_STAGE), its flat base and
// width in tangent units, its height a share of its width (CUMULUS); the puffs keep their size, the
// rest grow with K_cumulus, and below 0.2 the second last stays away.
const int WORLD_CUMULUS_N = ${CUMULUS.length};
const int WORLD_CUMULUS_PUFFS = ${CUMULUS_PUFFS};
const float WORLD_CUMULUS_ACROSS[${CUMULUS.length}] = ${cumulusFloats((tower) => tower[0])};
const float WORLD_CUMULUS_BASE[${CUMULUS.length}] = ${cumulusFloats((tower) => tower[1])};
const float WORLD_CUMULUS_WIDTH[${CUMULUS.length}] = ${cumulusFloats((tower) => tower[2])};
const float WORLD_CUMULUS_TALL[${CUMULUS.length}] = ${cumulusFloats((tower) => tower[3])};
const float WORLD_CUMULUS_SEED[${CUMULUS.length}] = ${cumulusFloats((tower) => tower[4])};
const float WORLD_CUMULUS_STAGE = 0.62;
// A tower: ellipse lobes (x, y, half width, half height) in its own units, a flat base at y = 0: three
// wide flat lobes at the foot, a few big billows above them, then many small ones along the edges
// and the crown, so the outline is lumpy at every scale.
const vec4 WORLD_CUMULUS_LOBE[17] = vec4[17](vec4(-0.55, 0.10, 0.34, 0.13), vec4(0.0, 0.11, 0.42, 0.14), vec4(0.55, 0.09, 0.32, 0.12), vec4(-0.25, 0.42, 0.30, 0.26), vec4(0.20, 0.50, 0.34, 0.30), vec4(0.62, 0.30, 0.20, 0.17), vec4(-0.70, 0.28, 0.18, 0.15), vec4(-0.05, 0.86, 0.26, 0.22), vec4(0.30, 0.82, 0.20, 0.17), vec4(0.05, 1.10, 0.13, 0.10), vec4(-0.88, 0.15, 0.10, 0.09), vec4(0.88, 0.14, 0.10, 0.09), vec4(-0.52, 0.58, 0.11, 0.10), vec4(0.60, 0.62, 0.12, 0.10), vec4(-0.30, 1.00, 0.10, 0.09), vec4(0.45, 1.02, 0.10, 0.08), vec4(0.72, 0.50, 0.10, 0.09));
// They drift with the wind (tangent units a second at wind 1), round a span this much wider than
// the view; their shadows' field drifts this fast (its own units a second at wind 1) and takes this
// share of the sun.
const float WORLD_CUMULUS_DRIFT = 0.0175;
const float WORLD_CUMULUS_WRAP = 1.7;
const float WORLD_CUMULUS_SHADOW_DRIFT = 0.055;
const float WORLD_CUMULUS_SHADOW = 0.72;
// Their light: the sun's warmed to cream, the sky's warmed a little over a floor, the moon's.
const vec3 WORLD_CUMULUS_SUN = vec3(1.15, 1.05, 0.88);
const vec3 WORLD_CUMULUS_SKY = vec3(1.05, 0.98, 0.88);
const float WORLD_CUMULUS_FLOOR = 0.04;
const float WORLD_CUMULUS_MOON = 0.5;
// As rain or snow closes the sky (w.overcast) they flatten to 1 - this share of their height and
// sink this share of the way to the horizon, greying into the deck behind them.
const float WORLD_CUMULUS_FLAT = 0.6;
const float WORLD_CUMULUS_SINK = 0.5;
#endif

// ---- the world now ----
struct World {
  Sky sky;          // the sky now: the clock, the sun and the moon in its phase; its light (sunColor,
                    // ambient, twilight) dimmed and greyed by the deck rain or snow closes over, the
                    // aurora's glow and the lightning's flash in its ambient. Light the scene with it.
  float time;       // the time of day 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset)
  float tm;         // the motion clock (uMotionTime): the sky, the cloud deck, snow, gusts, the storm
  float tf;         // the fall clock (uFallTime): falling rain
  float year;       // the date: the season's year position (SKY_YEAR), -1 for a scene without a season
  float chill;      // how far the year has turned toward winter (climateChill), 0 without a season
  float cold;       // how near midwinter's freeze it is (climateCold), 0 without a season
  float rain;       // what falls (0 while off): K_rain and K_snow, where the season sets the climate (a
  float snow;       // season and a snow knob) the cold's share of the rain falling as snow
                    // (climatePrecip), so a winter's rain snows
  float wet;        // how wet the ground is (uWeather.x) and how much snow lies on it (uWeather.y),
  float lying;      // 0..1 each, on the scene clock: they dry and melt after the fall stops
  float fog;        // K_fog, 0 while off (worldFogAt: the fog over a distance)
  float wind;       // K_wind -1..1, left to right in the camera's frame: it slants the rain and the
                    // snow and drifts the cumulus there, and the deck the same way (worldDeckDrift)
  float storm;      // the heavier of rain and snow (snow counted 0.85x), 0..1
  float overcast;   // 0..1 how far rain or snow has closed the sky (weatherOvercast)
  float heavy;      // 0..1 heavy rain or snow
  float cover;      // the cloud deck's cover: fair weather (K_clouds) thickened by the overcast; a scene
                    // with no clouds knob (the overcast's alone) sets its own fair weather, max(fair, cover)
  float low;        // how near the deck stands: where a view ray meets it, the ray's height is scaled by
                    // this, for the sky's deck and its shadows alike. 1 as the world has it; a scene whose
                    // rain brings the deck down sets it above 1 (seen larger, being nearer), one fitting
                    // more of the deck into a narrow strip of sky below 1
  float stars;      // the stars' density: K_stars (0 without WORLD_STARS); a scene may scale it for its
                    // own sky (more over dark woods than over a lit town)
  vec3 glow;        // the aurora's light on the land (already in sky.ambient)
  float flash;      // the lightning's sky-wide flash 0..1 (its light already in sky.ambient)
  float boltAge;    // seconds since the latest strike (1e4: none), and its seed
  float boltSeed;
  float meteorAge;  // seconds since the latest shooting star (1e4: none), and its seed
  float meteorSeed;
  float seed;       // the scene's seed for the world's own scenery (the cumulus' lobes and shadows):
                    // 0 from worldAt; a scene that re-seeds its view sets it before drawing
};

// The world now, from the world's knobs, the clocks and the date; meteorSlot and lightningSlot: the
// scene's trigger slots for their "now" buttons. Once per pixel, before anything is drawn. Rain or
// snow can close the deck over a scene with no clouds knob: K_clouds is tested with #ifdef, and the
// cover is then the overcast's alone. Where the season sets the climate (the scene has a snow knob,
// tested with #ifdef, and a season: SKY_YEAR), the cold turns rain to snow; elsewhere the cold is
// still the season's to read, and the rain and snow are the knobs'.
World worldAt(int meteorSlot, int lightningSlot) {
  World w;
  w.tm = uMotionTime;
  w.tf = uFallTime;
  w.time = timeOfDayM(K_time, skyDays());
  Sky sky = skyAt(w.time);
#if !WORLD_DAYLIGHT
  // An hour at which the sun stands deep below the horizon (worldFeatures): exactly what skyAt
  // gives there, known before the program runs.
  sky.day = 0.0;
  sky.night = 1.0;
  sky.sunColor = vec3(0.0);
#endif
#ifdef SKY_MOON_PHASE
#if WORLD_MOON
  sky = skyMoonPhase(sky, K_moon);
#else
  // No moon (K_moon 0 or 2): its phase, worked out before the program runs.
  sky = skyMoonPhase(sky, 0.0);
#endif
#endif
  w.year = SKY_YEAR;
  w.chill = climateChill(w.year);
  w.cold = climateCold(w.year);
#if WORLD_RAIN
  float rain = K_rain;
#else
  float rain = 0.0;
#endif
#if WORLD_SNOW
  float snow = K_snow;
#else
  float snow = 0.0;
#endif
#ifdef K_snow
  vec2 falling = climatePrecip(rain, snow, w.cold);
  w.rain = falling.x;
  w.snow = falling.y;
#else
  w.rain = rain;
  w.snow = snow;
#endif
  w.wet = clamp(uWeather.x, 0.0, 1.0);
  w.lying = clamp(uWeather.y, 0.0, 1.0);
#if WORLD_FOG
  w.fog = K_fog;
#else
  w.fog = 0.0;
#endif
  w.wind = K_wind;
  w.storm = clamp(max(w.rain, 0.85 * w.snow), 0.0, 1.0);
  w.overcast = weatherOvercast(w.rain, w.snow);
  w.heavy = smoothstep(0.35, 0.9, w.storm);
#if WORLD_CLOUDS
#ifdef K_clouds
  w.cover = max(K_clouds, w.overcast);
#else
  w.cover = w.overcast;
#endif
#else
  w.cover = 0.0;
#endif
  w.low = 1.0;
#if WORLD_STARS
  w.stars = K_stars;
#else
  w.stars = 0.0;
#endif
  w.glow = vec3(0.0);
#if WORLD_AURORA
  w.glow = auroraGlow(w.tm, K_aurora) * auroraSeen(sky, w.overcast);
#endif
  w.boltAge = 1e4;
  w.boltSeed = 0.0;
  w.flash = 0.0;
#if WORLD_LIGHTNING
  // The storm's own strikes while its knob is on (WORLD_LIGHTNING_RATE), the "now" button's always.
#if WORLD_LIGHTNING_RATE
  w.boltAge = lightningAge(w.tm, K_lightning, lightningSlot, w.boltSeed);
#else
  w.boltAge = lightningAge(w.tm, 0.0, lightningSlot, w.boltSeed);
#endif
  w.flash = lightningFlash(w.boltAge);
#endif
  w.meteorAge = 1e4;
  w.meteorSeed = 0.0;
#if WORLD_METEORS
  // The shower's own shooting stars while its knob is on (WORLD_METEOR_RATE), the "now" button's always.
#if WORLD_METEOR_RATE
  w.meteorAge = meteorAge(w.tm, K_meteors, meteorSlot, w.meteorSeed);
#else
  w.meteorAge = meteorAge(w.tm, 0.0, meteorSlot, w.meteorSeed);
#endif
#endif
  w.seed = 0.0;
  sky.sunColor *= 1.0 - WORLD_DECK_SUN * w.overcast;
  sky.ambient = greyed(sky.ambient, vec3(1.0), WORLD_DECK_GREY * w.overcast) * (1.0 - WORLD_DECK_DARK * w.storm) + w.glow + WORLD_FLASH_LIGHT * w.flash;
  sky.twilight *= 1.0 - WORLD_DECK_TWILIGHT * w.overcast;
  w.sky = sky;
  return w;
}

// ---- the view ----
// One pinhole camera, level, with a shifted lens (viewRay's): what the world needs of the scene's
// camera for this pixel. Distances the world is handed (z) and gives back are in the scene's units;
// unit converts metres to them, as BirdCamera.unit does.
struct WorldView {
  vec3 ray;       // the camera's ray in the shared side-on frame: x right, y up, z ahead
  vec3 dir;       // the same ray in the sky's frame: skyFacing(ray, yaw)
  float yaw;      // the turn from the camera's frame into the sky's (skyFacing(ray, yaw))
  vec2 uv;        // the screen point 0..1 (y up), after any lens shift the scene gives its world
  float aspect;   // uRes.x / uRes.y
  float foot;     // radians one dither cell spans along the ray: 1 / (focal * uRes.y)
  float horizon;  // the horizon's screen height (uv.y)
  float focal;    // screen heights per unit of x / z: the image plane's distance
  float eye;      // the eye's height over the ground, scene units
  float unit;     // scene units per metre
  float auroraLift; // how much higher the aurora's arc stands: each ray's slope is looked up this much
                    // lower (0 as the world hangs it; a sky seen only high over a rim lifts it into view)
};

// The view of a level pinhole camera at screen point uv: horizon at uv.y = horizon, focal (screen
// heights; a vertical field of 2 atan(0.5 / focal)), the eye eye scene units over the ground, the
// camera's frame turned by yaw into the sky's, unit scene units per metre.
WorldView worldView(vec2 uv, float horizon, float focal, float eye, float yaw, float unit) {
  WorldView v;
  v.aspect = uRes.x / uRes.y;
  v.ray = normalize(vec3((uv.x - 0.5) * v.aspect, uv.y - horizon, focal));
  v.dir = skyFacing(v.ray, yaw);
  v.yaw = yaw;
  v.uv = uv;
  v.foot = 1.0 / (focal * uRes.y);
  v.horizon = horizon;
  v.focal = focal;
  v.eye = eye;
  v.unit = unit;
  v.auroraLift = 0.0;
  return v;
}

// The view along a given ray at screen point uv, for a camera whose rays are bent or turned away
// from the level pinhole's own (heat shimmer, a pointer's parallax): ray in the camera's frame, unit
// length; the rest as for worldView. The sky, the aurora and shooting stars follow the ray; the
// bolt, the birds, the rain and the snow keep to the pinhole's screen at uv.
WorldView worldViewOf(vec3 ray, vec2 uv, float horizon, float focal, float eye, float yaw, float unit) {
  WorldView v = worldView(uv, horizon, focal, eye, yaw, unit);
  v.ray = ray;
  v.dir = skyFacing(ray, yaw);
  return v;
}

// ---- one wind, one grey day, one fog ----
// The wind on the cloud deck, in the sky's frame where the deck is drawn: the camera's wind
// (cloudDeckDrift of w.wind, sideways along the view and creeping toward the eye) turned by the
// view's yaw, so the deck drifts the way the rain slants and the cumulus drift, whichever way the
// scene faces.
vec2 worldDeckDrift(World w, WorldView v) {
  vec2 drift = cloudDeckDrift(w.wind);
  return v.yaw == 0.0 ? drift : rotate(drift, v.yaw);
}

// The grey day: what the rain or snow falling (w.rain, w.snow: their overcast, weatherOvercast, and
// their storm) does to a colour of the sky behind it, open its share not hidden by cloud (1 the open
// dome, 0 behind the deck): greyed and darkened as the world's light is under the deck (worldAt's
// shares), so the deck's gaps read as thinner cloud, not clear blue. It follows what falls, not a
// scene's own closing of w.overcast over its sky (dunes' sandstorm). worldSky and worldMirrorSky give
// it what their deck leaves open; give it, with open 1, a haze taken off the dome (horizonHaze); a
// scene that greys its deck as well gives it that deck's alpha. Exactly col in dry weather.
vec3 worldGrey(World w, vec3 col, float open) {
  return greyed(col, vec3(1.0), WORLD_DECK_GREY * weatherOvercast(w.rain, w.snow) * open) * (1.0 - WORLD_DECK_DARK * w.storm * open);
}

// The world's fog (K_fog) over a distance, in metres, to a point height metres over the ground:
// fogAmount of 1 - exp(-metres / WORLD_FOG_REACH), thinning up through the WORLD_FOG_TOP metres of
// its layer. 0 without fog.
float worldFogAt(World w, float metres, float height) {
  return fogAmount(w.fog, 1.0 - exp(-metres / WORLD_FOG_REACH), clamp(height / WORLD_FOG_TOP, 0.0, 1.0));
}

#if WORLD_CUMULUS
// ---- the painted cumulus (K_cumulus) ----
// How far the towers have still to drift in as the scene arrives (1 down to exactly 0 once it has: an
// ease-out cubic), and how far they have drifted on as it leaves (0 at rest, still gathering speed).
float worldCumulusArriving() {
  float u = 1.0 - clamp(passageIn(), 0.0, 1.0);
  return u * u * u;
}

float worldCumulusLeaving() {
  float u = passageOut();
  return u * u;
}

// How far the towers have greyed and sunk into the deck rain or snow closes over (w.overcast): 0 in
// fair weather, 1 once it has closed, with none of them left.
float worldCumulusMerged(World w) {
  return smoothstep(0.2, 1.0, w.overcast);
}

// The light on the towers: the sun's (warmed to cream) and the moon's, each with its direction in the
// towers' plane (across, and up lifted so that a low light still reaches the crowns), the sky's, and
// the blue-grey of their shade, off the sky high up.
struct WorldCumulusLight {
  vec3 sun;
  vec3 moon;
  vec3 sky;
  vec3 shade;
  vec2 toSun;
  vec2 toMoon;
};

WorldCumulusLight worldCumulusLight(World w, WorldView v) {
  WorldCumulusLight li;
  li.sun = w.sky.sunColor * WORLD_CUMULUS_SUN;
  li.moon = w.sky.moonColor * WORLD_CUMULUS_MOON;
  li.sky = w.sky.ambient * WORLD_CUMULUS_SKY + WORLD_CUMULUS_FLOOR;
  vec3 zen = skyDome(w.sky, normalize(vec3(0.0, 0.85, 0.5)));
  li.shade = mix(vec3(dot(zen, LUMA)), zen, 0.5) * 1.5 + vec3(0.12, 0.13, 0.17);
  vec3 sun = skyFacing(w.sky.sun, -v.yaw);
  vec3 moon = skyFacing(w.sky.moon, -v.yaw);
  li.toSun = normalize(vec2(sun.x, 0.45 + 1.2 * max(sun.y, 0.0)) + 1e-4);
  li.toMoon = normalize(vec2(moon.x, 0.45 + 1.2 * max(moon.y, 0.0)) + 1e-4);
  return li;
}

// The signed distance (in the tower's own units, roughly) to a tower of these lobes, cut flat at the
// base.
float worldCumulusSdf(vec2 q, vec4 lobes[17]) {
  float d = 1e3;
  for (int k = 0; k < 17; k++) {
    vec4 c = lobes[k];
    d = min(d, (length((q - c.xy) / c.zw) - 1.0) * min(c.z, c.w));
  }
  return max(d, -q.y);
}

// One tower at q, in its own units (across its width, up its height from the flat base), its width
// s and height factor tall, its own seed and the scene's (jitter), and a cell's footprint aa (tangent
// units): rgb and coverage, 0 or 1 per cell. Its lobes are jittered once, then shared by the outline
// and the four samples of its normal. The light comes from the outline's normal (taken over a wide
// step, so the billows blend into one mass) mixed with the tower's overall facing: the sunward side
// and the crown cream, the shaded side and the flat base blue-grey, the sunward rim glowing, the side
// toward the moon silvered.
vec4 worldCumulusTower(WorldCumulusLight li, vec2 q, float s, float tall, float seed, float jitter, float aa) {
  float sd = seed + jitter;
  vec4 lobes[17];
  for (int k = 0; k < 17; k++) {
    vec4 c = WORLD_CUMULUS_LOBE[k];
    c.xy += (hash22(vec2(float(k), sd)) - 0.5) * 0.06;
    c.zw *= 0.88 + 0.28 * hash12(vec2(float(k) + 7.0, sd));
    lobes[k] = c;
  }
  float d = worldCumulusSdf(q, lobes);
  d += 0.045 * (vnoise(q * 9.0 + seed) - 0.5) + 0.02 * (vnoise(q * 23.0 + seed) - 0.5);
  if (hardFill(d * s, aa) < 0.5) return vec4(0.0);
  float e = 0.12;
  vec2 grad = vec2(worldCumulusSdf(q + vec2(e, 0.0), lobes) - worldCumulusSdf(q - vec2(e, 0.0), lobes), worldCumulusSdf(q + vec2(0.0, e), lobes) - worldCumulusSdf(q - vec2(0.0, e), lobes));
  vec2 n = grad / max(length(grad), 1e-3);
  vec2 mass = normalize(q - vec2(0.0, 0.5) + 1e-3);
  float crown = 0.5 + 0.5 * smoothstep(0.0, 0.5, q.y);
  vec2 toSun = normalize(vec2(li.toSun.x, li.toSun.y / tall));
  float facing = dot(n, toSun);
  float lit = smoothstep(-1.0, 0.9, 0.55 * facing + 0.45 * dot(mass, toSun)) * crown;
  vec3 c = mix(li.shade, li.sun * 0.7 + li.sky * 0.55 + vec3(0.14, 0.13, 0.12), lit);
  float rim = 1.0 - smoothstep(0.0, 0.07, -d);
  c += li.sun * 0.4 * rim * max(facing, 0.0) * smoothstep(0.1, 0.5, q.y);
  vec2 toMoon = normalize(vec2(li.toMoon.x, li.toMoon.y / tall));
  c += li.moon * smoothstep(-1.0, 0.9, 0.55 * dot(n, toMoon) + 0.45 * dot(mass, toMoon)) * crown;
  c = mix(c, li.shade * 0.85, (1.0 - smoothstep(0.0, 0.2, q.y)) * 0.6);
  return vec4(c, 1.0);
}

// The towers along the view's ray over col (the sky behind them), the small ones first: each laid
// out across the view in the camera's frame (so in the sky's, turned by the view's yaw), drifting with
// the wind round a span a little wider than the view, in from the sides as the scene arrives and on
// as it leaves. Rain or snow flattens them, sinks them toward the horizon and greys them into the
// deck. Returns their coverage, 0 or 1.
float worldCumulusOver(World w, WorldView v, inout vec3 col) {
  float merged = worldCumulusMerged(w);
  if (merged >= 1.0 || v.ray.z < 0.05) return 0.0;
  vec2 t = v.ray.xy / v.ray.z;
  float size = clamp(K_cumulus, 0.0, 1.0);
  float spread = max(0.5 * v.aspect / v.focal, WORLD_CUMULUS_STAGE);
  float span = 2.0 * spread + WORLD_CUMULUS_WRAP;
  float drift = w.tm * WORLD_CUMULUS_DRIFT * w.wind;
  float arriving = worldCumulusArriving();
  float leaving = worldCumulusLeaving();
  float squash = 1.0 - WORLD_CUMULUS_FLAT * w.overcast;
  float sink = 1.0 - WORLD_CUMULUS_SINK * w.overcast;
  vec3 behind = col;
  float cover = 0.0;
  bool lit = false;
  WorldCumulusLight li;
  for (int i = 0; i < WORLD_CUMULUS_N; i++) {
    bool puff = i < WORLD_CUMULUS_PUFFS;
    if (!puff && i == WORLD_CUMULUS_N - 2 && size < 0.2) continue;
    float s = WORLD_CUMULUS_WIDTH[i] * (puff ? 1.0 : mix(0.65, 1.08, size));
    float tall = WORLD_CUMULUS_TALL[i] * squash;
    float lead = (0.22 + 0.04 * float(i)) * arriving + 0.1 * leaving;
    float x = mod(WORLD_CUMULUS_ACROSS[i] * spread + drift + 0.5 * span, span) - 0.5 * span + sign(WORLD_CUMULUS_ACROSS[i]) * lead;
    vec2 q = vec2((t.x - x) / s, (t.y - WORLD_CUMULUS_BASE[i] * sink) / (s * tall));
    if (q.x < -1.15 || q.x > 1.2 || q.y < -0.05 || q.y > 1.5) continue;
    if (!lit) {
      li = worldCumulusLight(w, v);
      lit = true;
    }
    vec4 tower = worldCumulusTower(li, q, s, tall, WORLD_CUMULUS_SEED[i], w.seed, v.foot);
    col = mix(col, tower.rgb, tower.a);
    cover = max(cover, tower.a);
  }
  if (cover > 0.0 && w.overcast > 0.0) col = mix(greyed(col, vec3(1.0), w.overcast), behind, merged);
  return cover;
}

// The towers' shadows on the land at a point at (as for worldSunlit: scene units from the eye, in the
// camera's frame), the share of the sun they take, 0 or WORLD_CUMULUS_SHADOW per cell: a field
// painted over the land as the eye sees it, as the towers are (at's x and y over its distance ahead,
// taken no steeper than 45 degrees down), drifting with the wind and in from the side as the scene
// arrives, fading as the towers sink into the deck.
float worldCumulusShadow(World w, vec3 at) {
  vec2 t = at.xy / max(max(at.z, abs(at.y)), 1e-6);
  vec2 q = vec2(t.x * 0.75 - w.tm * WORLD_CUMULUS_SHADOW_DRIFT * w.wind + 0.2 * (worldCumulusArriving() + 0.5 * worldCumulusLeaving()), t.y * 2.4);
  float n = 0.65 * vnoise(q + vec2(5.0 + w.seed, 2.128)) + 0.35 * vnoise(q * 2.3 + vec2(9.0, 5.5944));
  return WORLD_CUMULUS_SHADOW * hardEdge(smoothstep(0.54, 0.7, n)) * (1.0 - worldCumulusMerged(w));
}
#endif

// ---- behind the scene ----
struct WorldSky {
  vec3 col;     // the sky along the ray up to the shooting stars: draw it first; tint it as the scene's own deck does
  vec3 strike;  // the lightning over it, the bolt and the flash's glow: add it after any tint of the scene's
  float cloud;  // the cloud's alpha along the ray, the deck's and the cumulus' (0 clear): hide what lies behind cloud (a sun disc's accent)
};

// worldSky over a dome of the scene's own, col, in place of the World's (skyColor): a backdrop that
// stages its own night where the World's dome would be gives it that night, or vec3(0.0) for the
// sky's lights alone (what stands in front of the dome: the aurora, the cloud, the stars, the
// shooting stars, greyed, and the strike), so the World's dome is never worked out.
WorldSky worldSkyOver(World w, WorldView v, vec4 meteorField, vec3 col) {
#if WORLD_AURORA
  // The curtains hang ahead of the camera, behind the clouds.
  vec3 curtains = v.auroraLift == 0.0 ? v.ray : normalize(vec3(v.ray.x, v.ray.y - v.auroraLift * length(v.ray.xz), v.ray.z));
  col += auroraM(curtains, w.tm, K_aurora, v.foot) * auroraSeen(w.sky, w.overcast);
#endif
  float cloud = 0.0;
#if WORLD_CLOUDS
  vec4 deck = skyClouds(w.sky, w.low == 1.0 ? v.dir : normalize(vec3(v.dir.x, v.dir.y * w.low, v.dir.z)), w.tm, w.cover, worldDeckDrift(w, v));
  col = mix(col, deck.rgb, deck.a);
  cloud = deck.a;
#endif
#if WORLD_CUMULUS
  if (K_cumulus > 0.0) cloud = max(cloud, worldCumulusOver(w, v, col));
#endif
#if WORLD_STARS
  float density = w.stars;
#if WORLD_MILKYWAY
  // On dark nights: moonlight washes it out. w.stars stays the density away from the band (with the
  // band off the stars are exactly w.stars'); in it they crowd as milkyWayStars has them.
  float moonlit = clamp(dot(w.sky.moonColor, LUMA) / WORLD_GALAXY_MOONLIT, 0.0, 1.0);
  float band = milkyWay(skyStarFrame(w.sky, v.dir), v.dir.y, WORLD_GALAXY) * K_milkyWay * w.stars * w.sky.night * (1.0 - WORLD_GALAXY_MOON * moonlit);
  col += WORLD_GALAXY_TINT * band * (1.0 - cloud);
  if (band > 0.0) density = w.stars * milkyWayStars(1.0, band) / milkyWayStars(1.0, 0.0);
#endif
  col += SKY_STAR_TINT * skyStars(w.sky, v.dir, density, v.foot) * (1.0 - cloud);
#endif
  col = skyGiant(w.sky, col, v.dir, v.foot, 1.0 - cloud);
#if WORLD_METEORS
  float streak = meteorStreak(skyAngles(v.ray), meteorField, w.meteorAge, w.meteorSeed, v.foot);
  col += METEOR_TINT * hardEdge(streak * auroraSeen(w.sky, max(cloud, w.overcast)));
#endif
  col = worldGrey(w, col, 1.0 - cloud);
  vec3 strike = vec3(0.0);
#if WORLD_LIGHTNING
  if (w.boltAge < 1.5) {
    // A bolt drops from the cloud base to the horizon somewhere across the middle of the view; the
    // scene's land stands in front of its foot.
    vec2 p = (v.uv - 0.5) * vec2(v.aspect, 1.0);
    float across = (fract(w.boltSeed * 7.31) - 0.5) * WORLD_BOLT_SPREAD * v.aspect;
    float base = v.horizon - 0.5;
    vec2 top = vec2(across, base + WORLD_BOLT_RISE * v.focal);
    vec2 ground = vec2(across + (fract(w.boltSeed * 3.17) - 0.5) * 0.08, base - 0.01);
    float bolt = lightningBolt(p, top, ground, w.boltSeed, w.boltAge);
    strike += mix(vec3(0.55, 0.45, 1.0), vec3(1.0), smoothstep(0.45, 0.75, bolt)) * min(bolt, 1.5);
  }
  // The flash lights the air, most low down and in the cloud (whose own light the flash in
  // sky.ambient already raises).
  strike += WORLD_FLASH_SKY * w.flash * (exp(-max(v.ray.y, 0.0) * 6.0) + cloud);
#endif
  return WorldSky(col, strike, cloud);
}

// The sky behind everything along the view's ray, in order: the dome (sun and moon discs), the
// aurora behind the clouds (lifted by v.auroraLift), the cloud deck (as near as w.low, drifting with
// the wind: worldDeckDrift), the painted cumulus in front of it, the stars (at w.stars), the Milky Way
// and the sky's planets in their gaps, shooting stars (starting in meteorField, skyAngles of the
// camera's ray: xy its lower left corner, zw its size), all of what the cloud leaves open greyed under
// rain or snow (worldGrey), then the lightning (strike). Draw the scene's land, distance and near
// things over it.
WorldSky worldSky(World w, WorldView v, vec4 meteorField) {
  return worldSkyOver(w, v, meteorField, skyColor(w.sky, v.dir));
}

// How much of the sun's light reaches a point at (scene units from the eye, in the camera's frame,
// y up: the ground under a pixel is y = -eye): 1 in the open, down to 1 - K_shadows in the shadow
// the cloud deck casts where the sun's ray from it meets the deck (skyCloudShadow, the deck
// WORLD_CLOUD_BASE / w.low metres up, as the sky shows it, drifting as it does), and times
// 1 - WORLD_CUMULUS_SHADOW in the painted cumulus' shadows (worldCumulusShadow), which come with the
// towers. Exactly 1 while both are off. Multiply the sun's light by it.
float worldSunlit(World w, WorldView v, vec3 at) {
  float lit = 1.0;
#if WORLD_SHADOWS
  if (K_shadows > 0.0 && w.cover > 0.0) {
    lit = 1.0 - K_shadows * skyCloudShadow(w.sky, skyFacing(at / v.unit, v.yaw), WORLD_CLOUD_BASE, w.low, w.tm, w.cover, worldDeckDrift(w, v));
  }
#endif
#if WORLD_CUMULUS
  if (K_cumulus > 0.0) lit *= 1.0 - worldCumulusShadow(w, at);
#endif
  return lit;
}

// ---- in front, by distance ----
// Where the world's birds fly in a scene (birdSky's lanes): the scene's composition.
struct WorldFlyway {
  vec2 depths;    // the nearest and farthest a flight crosses at, scene units
  vec2 band;      // the screen heights (uv.y) flights cruise within
  vec2 seed;      // the flights' seed: the scene's own (its seed knob)
  float swoopTo;  // the height (scene units) a swooping party comes down to over the ground; 1e9: never
  float enlarge;  // birds drawn this many times life size (BirdCamera.enlarge)
};

// The world's birds (K_birds, K_birdKind, K_birdFormation; by day, few in rain or snow) where one is
// nearer than z, the distance to what the scene has drawn so far (scene units): it takes the pixel,
// lit by the sky and fading into haze by exp(-depth * thick) (thick: the scene's aerial haze per
// scene unit), and z becomes its depth and the accent 0.
void worldBirds(World w, WorldView v, WorldFlyway f, vec3 haze, float thick, inout vec3 col, inout float z, inout float accent) {
#if WORLD_BIRDS
  if (K_birds > 0.0) {
    BirdSky flights = birdSky(K_birds * smoothfall(0.5, 0.1, w.storm), K_birdKind, K_birdFormation - 1.0, f.depths, f.band, f.seed);
    flights.hours = WORLD_BIRD_HOURS;
    flights.clock = vec2(K_time, K_cycle);
    flights.swoopTo = f.swoopTo;
    BirdCamera cam = BirdCamera(v.horizon, v.focal, v.eye, v.unit, f.enlarge);
    BirdHit bird = birdFlights(vec2(v.uv.x * v.aspect - 0.5 * v.aspect, v.uv.y), flights, cam, w.tm, 1.0 / uRes.y);
    if (bird.cover > 0.5 && bird.depth < z) {
      col = mix(bird.albedo * (w.sky.ambient * 1.2 + w.sky.sunColor * 0.3), haze, 1.0 - exp(-bird.depth * thick));
      accent = 0.0;
      z = bird.depth;
    }
  }
#endif
}

// Fog (K_fog) between the eye and z (scene units; WORLD_FAR for open sky): worldFogAt the distance
// in metres and the height of the point seen over the ground (open sky reckoned WORLD_FOG_SKY metres
// out, so the fog hugs the horizon), mixing toward fogCol, the scene's mist.
void worldFog(World w, WorldView v, vec3 fogCol, float z, inout vec3 col, inout float accent) {
#if WORLD_FOG
  if (w.fog > 0.0) {
    float metres = z / v.unit;
    float f = worldFogAt(w, metres, v.eye / v.unit + min(metres, WORLD_FOG_SKY) * v.ray.y / max(v.ray.z, 1e-3));
    col = mix(col, fogCol, f);
    accent *= 1.0 - f;
  }
#endif
}

// Rain and snow (K_rain, K_snow) falling between the eye and z (scene units), each drop hidden behind
// the surface (rainFall, snowFall at weatherDepth of z in metres; a level camera): the veil toward
// air, the drops in dropLight (rain: ~1.2x the sky they refract plus the sun's, never under ~0.08),
// the flakes in the sky's and the sun's light, the nearest dimmer. The accent fades under the veil.
void worldPrecip(World w, WorldView v, vec3 air, vec3 dropLight, float z, inout vec3 col, inout float accent) {
  float depth = weatherDepth(z / v.unit);
#if WORLD_RAIN
  if (w.rain > 0.0) {
    Precip fall = rainFall(v.uv, v.aspect, w.tm, w.tf, w.rain, w.wind, depth);
    col = precipOver(col, air, dropLight * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
#if WORLD_SNOW
  if (w.snow > 0.0) {
    Precip fall = snowFall(v.uv, v.aspect, w.tm, w.snow, w.wind, depth);
    vec3 flake = WORLD_FLAKE * (dot(w.sky.ambient, LUMA) * 1.6 + dot(w.sky.sunColor, LUMA) * 0.5 + 0.04);
    col = precipOver(col, mix(air, flake, 0.5), flake * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
}

// worldPrecip for a camera that is not level: right, up and fwd are its axes in the frame of a
// level camera facing the same way (x right, along the wind; y up; z ahead), so the paths of the
// drops and flakes meet where this camera sees them converge (rainFallSeen and snowFallSeen through
// rainVanish, at the view's focal): on the point below the eye looking down, overhead looking up.
// The level axes draw worldPrecip's picture.
void worldPrecipSeen(World w, WorldView v, vec3 right, vec3 up, vec3 fwd, vec3 air, vec3 dropLight, float z, inout vec3 col, inout float accent) {
  float depth = weatherDepth(z / v.unit);
#if WORLD_RAIN
  if (w.rain > 0.0) {
    vec3 vanish = rainVanish(rainFallDir(w.rain, w.wind), right, up, fwd, v.focal);
    Precip fall = rainFallSeen(v.uv, v.aspect, w.tm, w.tf, w.rain, w.wind, depth, vanish);
    col = precipOver(col, air, dropLight * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
#if WORLD_SNOW
  if (w.snow > 0.0) {
    vec3 vanish = rainVanish(snowFallDir(w.snow, w.wind), right, up, fwd, v.focal);
    Precip fall = snowFallSeen(v.uv, v.aspect, w.tm, w.snow, w.wind, depth, vanish);
    vec3 flake = WORLD_FLAKE * (dot(w.sky.ambient, LUMA) * 1.6 + dot(w.sky.sunColor, LUMA) * 0.5 + 0.04);
    col = precipOver(col, mix(air, flake, 0.5), flake * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
}

// The world in front of a scene with nothing of its own to draw between: birds nearer than z, then
// fog and rain and snow to whatever is nearest (air as the fog's and the rain's colour).
void worldOver(World w, WorldView v, WorldFlyway f, vec3 haze, float thick, vec3 air, vec3 dropLight, inout vec3 col, inout float z, inout float accent) {
  worldBirds(w, v, f, haze, thick, col, z, accent);
  worldFog(w, v, air, z, col, accent);
  worldPrecip(w, v, air, dropLight, z, col, accent);
}

// worldPrecip with the drops and the flakes thinned: their cover scaled by thin.x for the far ones
// to thin.y for the nearest, out of focus. Only for a scene whose subject the weather would
// otherwise bury (src/scenes/README.md, "Weather in the world"), saying why where it calls it; the
// veil and how far the rain and snow fall are the world's.
void worldPrecipThinned(World w, WorldView v, vec3 air, vec3 dropLight, float z, vec2 thin, inout vec3 col, inout float accent) {
  float depth = weatherDepth(z / v.unit);
#if WORLD_RAIN
  if (w.rain > 0.0) {
    Precip fall = rainFall(v.uv, v.aspect, w.tm, w.tf, w.rain, w.wind, depth);
    fall.cover *= mix(thin.x, thin.y, fall.near);
    col = precipOver(col, air, dropLight * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
#if WORLD_SNOW
  if (w.snow > 0.0) {
    Precip fall = snowFall(v.uv, v.aspect, w.tm, w.snow, w.wind, depth);
    fall.cover *= mix(thin.x, thin.y, fall.near);
    vec3 flake = WORLD_FLAKE * (dot(w.sky.ambient, LUMA) * 1.6 + dot(w.sky.sunColor, LUMA) * 0.5 + 0.04);
    col = precipOver(col, mix(air, flake, 0.5), flake * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
}

// ---- in a mirror ----
// A level mirror at the ground (still water, the sea, a film of water on sand or a road) shows the
// world's sky along the ray it reflects: worldMirrorView is that view, worldMirrorSky and
// worldBirdsMirrored what the mirror shows there. The scene mixes it into its surface by its own
// Fresnel and draws the glitter of the sun and the moon on it itself.

// The view a mirror gives: v looking along ray, the ray the surface reflects into the sky (the
// camera's frame, y up; the scene's own, tilted by its waves or ripples), its screen point where
// that ray would meet the screen (the mirrored lookup: a level mirror's pixel below the horizon
// looks up as far above it), and its footprint widened by blur, the radians over which the mirror's
// roughness spreads its image (0 a still mirror), so a rough mirror shows the stars, the aurora and
// a shooting star soft. The pinhole stays v's.
WorldView worldMirrorView(WorldView v, vec3 ray, float blur) {
  WorldView m = v;
  m.ray = ray;
  m.dir = skyFacing(ray, v.yaw);
  float ahead = max(ray.z, 1e-3);
  m.uv = vec2(0.5 + ray.x / ahead * v.focal / v.aspect, v.horizon + ray.y / ahead * v.focal);
  m.foot = v.foot + blur;
  return m;
}

// The sky a level mirror shows along m's ray (worldMirrorView), in worldSky's order: the dome with
// the moon swung round behind the viewer (skyMirror: no reflection shows a broken sliver of its
// disc, so draw the moon's path on the water as glitter), the aurora, the cloud deck (lit by the
// true moon, so its silver lining shows under it) and the painted cumulus in front of it, the Milky
// Way and the stars in their gaps (faded in the true moon's glare as the sky's are), the sky's
// planets (hidden by no moon, the mirror drawing none) and shooting stars, all at m's footprint: a
// rough mirror fades the stars to their glow, softens the planets and dims a streak to the share of
// its blur one cell is; what the cloud leaves open greyed under rain or snow, as the sky is. In
// strike the lightning's bolt mirrored at m's screen point, as dim, and the flash's glow. A scene
// that drops its bolts out of its own storm draws their image itself and leaves strike's out.
WorldSky worldMirrorSky(World w, WorldView m, vec4 meteorField) {
  vec3 col = skyColor(skyMirror(w.sky), m.dir);
  float cell = 1.0 / (m.focal * uRes.y);
  float sharp = min(cell / m.foot, 1.0);
#if WORLD_AURORA
  vec3 curtains = m.auroraLift == 0.0 ? m.ray : normalize(vec3(m.ray.x, m.ray.y - m.auroraLift * length(m.ray.xz), m.ray.z));
  col += auroraM(curtains, w.tm, K_aurora, m.foot) * auroraSeen(w.sky, w.overcast);
#endif
  float cloud = 0.0;
#if WORLD_CLOUDS
  vec4 deck = skyClouds(w.sky, w.low == 1.0 ? m.dir : normalize(vec3(m.dir.x, m.dir.y * w.low, m.dir.z)), w.tm, w.cover, worldDeckDrift(w, m));
  col = mix(col, deck.rgb, deck.a);
  cloud = deck.a;
#endif
#if WORLD_CUMULUS
  if (K_cumulus > 0.0) cloud = max(cloud, worldCumulusOver(w, m, col));
#endif
#if WORLD_STARS
  float density = w.stars;
#if WORLD_MILKYWAY
  float moonlit = clamp(dot(w.sky.moonColor, LUMA) / WORLD_GALAXY_MOONLIT, 0.0, 1.0);
  float band = milkyWay(skyStarFrame(w.sky, m.dir), m.dir.y, WORLD_GALAXY) * K_milkyWay * w.stars * w.sky.night * (1.0 - WORLD_GALAXY_MOON * moonlit);
  col += WORLD_GALAXY_TINT * band * (1.0 - cloud);
  if (band > 0.0) density = w.stars * milkyWayStars(1.0, band) / milkyWayStars(1.0, 0.0);
#endif
  col += SKY_STAR_TINT * skyStars(w.sky, m.dir, density, m.foot) * (1.0 - cloud);
#endif
  col = skyGiant(skyMirror(w.sky), col, m.dir, m.foot, 1.0 - cloud);
#if WORLD_METEORS
  float streak = meteorStreak(skyAngles(m.ray), meteorField, w.meteorAge, w.meteorSeed, cell);
  col += METEOR_TINT * hardEdge(streak * auroraSeen(w.sky, max(cloud, w.overcast))) * sharp;
#endif
  col = worldGrey(w, col, 1.0 - cloud);
  vec3 strike = vec3(0.0);
#if WORLD_LIGHTNING
  if (w.boltAge < 1.5) {
    // worldSky's bolt, where the mirror's lookup meets it.
    vec2 p = (m.uv - 0.5) * vec2(m.aspect, 1.0);
    float across = (fract(w.boltSeed * 7.31) - 0.5) * WORLD_BOLT_SPREAD * m.aspect;
    float base = m.horizon - 0.5;
    vec2 top = vec2(across, base + WORLD_BOLT_RISE * m.focal);
    vec2 ground = vec2(across + (fract(w.boltSeed * 3.17) - 0.5) * 0.08, base - 0.01);
    float bolt = lightningBolt(p, top, ground, w.boltSeed, w.boltAge);
    strike += mix(vec3(0.55, 0.45, 1.0), vec3(1.0), smoothstep(0.45, 0.75, bolt)) * min(bolt, 1.5) * sharp;
  }
  strike += WORLD_FLASH_SKY * w.flash * (exp(-max(m.ray.y, 0.0) * 6.0) + cloud);
#endif
  return WorldSky(col, strike, cloud);
}

// The world's birds as a level mirror at the ground datum shows them (birdFlightsSeen, mirrored)
// at m's screen point (worldMirrorView): where a bird's image covers it, it takes still's share of
// col (how still the mirror is, 0..1: a rough one breaks the image up), lit and hazed as worldBirds
// does. Where no bird is, col is left as it was.
void worldBirdsMirrored(World w, WorldView m, WorldFlyway f, vec3 haze, float thick, float still, inout vec3 col) {
#if WORLD_BIRDS
  if (K_birds > 0.0) {
    BirdSky flights = birdSky(K_birds * smoothfall(0.5, 0.1, w.storm), K_birdKind, K_birdFormation - 1.0, f.depths, f.band, f.seed);
    flights.hours = WORLD_BIRD_HOURS;
    flights.clock = vec2(K_time, K_cycle);
    flights.swoopTo = f.swoopTo;
    BirdCamera cam = BirdCamera(m.horizon, m.focal, m.eye, m.unit, f.enlarge);
    BirdHit bird = birdFlightsSeen(vec2(m.uv.x * m.aspect - 0.5 * m.aspect, m.uv.y), flights, cam, w.tm, 1.0 / uRes.y, true);
    if (bird.cover > 0.5) col = mix(col, mix(bird.albedo * (w.sky.ambient * 1.2 + w.sky.sunColor * 0.3), haze, 1.0 - exp(-bird.depth * thick)), still);
  }
#endif
}
`;
