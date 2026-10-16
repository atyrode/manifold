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
//   World worldAt(float t, int meteorSlot, int lightningSlot);   // the world now, once per pixel
//   WorldView worldView(vec2 uv, float horizon, float focal, float eye, float yaw, float unit);
//   WorldView worldViewOf(vec3 ray, vec2 uv, float horizon, float focal, float eye, float yaw, float unit);
//   WorldSky worldSky(World w, WorldView v, vec4 meteorField);   // behind the scene
//   float worldSunlit(World w, WorldView v, vec3 at);             // the cloud deck's shadow
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
// WORLD_METEORS, WORLD_AURORA, WORLD_CLOUDS, WORLD_SHADOWS, WORLD_BIRDS, WORLD_RAIN, WORLD_SNOW,
// WORLD_FOG, WORLD_LIGHTNING, each 0 or 1: worldFeatures), and keeps its runtime test of the knob
// inside, so with the knob off (gate on or not) it gives its neutral value exactly.
import { glslFloat } from "../glsl.ts";
import { birdsGlsl } from "./birds.ts";
import { milkyWayGlsl } from "./milkyway.ts";

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
// by this share, the sky's light greys by this share and darkens with the storm's amount, and the
// twilight's colours give way.
const float WORLD_DECK_SUN = 0.88;
const float WORLD_DECK_GREY = 0.6;
const float WORLD_DECK_DARK = 0.3;
const float WORLD_DECK_TWILIGHT = 0.7;
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

// ---- the world now ----
struct World {
  Sky sky;          // the sky now: the clock, the sun and the moon in its phase; its light (sunColor,
                    // ambient, twilight) dimmed and greyed by the deck rain or snow closes over, the
                    // aurora's glow and the lightning's flash in its ambient. Light the scene with it.
  float time;       // the time of day 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset)
  float t;          // the scene clock (the entry's t): the cloud deck, rain and snow run on it
  float tm;         // the motion clock (uMotionTime)
  float rain;       // K_rain, K_snow, K_fog: 0 while off; K_wind -1..1
  float snow;
  float fog;
  float wind;
  float storm;      // the heavier of rain and snow (snow counted 0.85x), 0..1
  float overcast;   // 0..1 how far rain or snow has closed the sky (weatherOvercast)
  float heavy;      // 0..1 heavy rain or snow
  float cover;      // the cloud deck's cover: fair weather (K_clouds) thickened by the overcast
  vec3 glow;        // the aurora's light on the land (already in sky.ambient)
  float flash;      // the lightning's sky-wide flash 0..1 (its light already in sky.ambient)
  float boltAge;    // seconds since the latest strike (1e4: none), and its seed
  float boltSeed;
  float meteorAge;  // seconds since the latest shooting star (1e4: none), and its seed
  float meteorSeed;
};

// The world at the scene clock t, from the world's knobs; meteorSlot and lightningSlot: the scene's
// trigger slots for their "now" buttons. Once per pixel, before anything is drawn.
World worldAt(float t, int meteorSlot, int lightningSlot) {
  World w;
  w.t = t;
  w.tm = uMotionTime;
  w.time = timeOfDayM(K_time, K_cycle, uMotionTime);
  Sky sky = skyAt(w.time);
#ifdef SKY_MOON_PHASE
  sky = skyMoonPhase(sky, K_moon);
#endif
#if WORLD_RAIN
  w.rain = K_rain;
#else
  w.rain = 0.0;
#endif
#if WORLD_SNOW
  w.snow = K_snow;
#else
  w.snow = 0.0;
#endif
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
  w.cover = max(K_clouds, w.overcast);
#else
  w.cover = 0.0;
#endif
  w.glow = vec3(0.0);
#if WORLD_AURORA
  w.glow = auroraGlow(w.tm, K_aurora) * auroraSeen(sky, w.overcast);
#endif
  w.boltAge = 1e4;
  w.boltSeed = 0.0;
  w.flash = 0.0;
#if WORLD_LIGHTNING
  w.boltAge = lightningAge(t, K_lightning, lightningSlot, w.boltSeed);
  w.flash = lightningFlash(w.boltAge);
#endif
  w.meteorAge = 1e4;
  w.meteorSeed = 0.0;
#if WORLD_METEORS
  w.meteorAge = meteorAge(w.tm, K_meteors, meteorSlot, w.meteorSeed);
#endif
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

// ---- behind the scene ----
struct WorldSky {
  vec3 col;     // the sky along the ray up to the shooting stars: draw it first; tint it as the scene's own deck does
  vec3 strike;  // the lightning over it, the bolt and the flash's glow: add it after any tint of the scene's
  float cloud;  // the cloud deck's alpha along the ray (0 clear): hide what lies behind cloud (a sun disc's accent)
};

// The sky behind everything along the view's ray, in order: the dome (sun and moon discs), the
// aurora behind the clouds, the cloud deck, the stars, the Milky Way and the giant planet in its gaps,
// shooting stars (starting in meteorField, skyAngles of the camera's ray: xy its lower left corner,
// zw its size), then the lightning (strike). Draw the scene's land, distance and near things over it.
WorldSky worldSky(World w, WorldView v, vec4 meteorField) {
  vec3 col = skyColor(w.sky, v.dir);
#if WORLD_AURORA
  // The curtains hang ahead of the camera, behind the clouds.
  col += auroraM(v.ray, w.tm, K_aurora, v.foot) * auroraSeen(w.sky, w.overcast);
#endif
  float cloud = 0.0;
#if WORLD_CLOUDS
  vec4 deck = skyClouds(w.sky, v.dir, w.t, w.cover, w.wind);
  col = mix(col, deck.rgb, deck.a);
  cloud = deck.a;
#endif
#if WORLD_STARS
  float density = K_stars;
#if WORLD_MILKYWAY
  // On dark nights: moonlight washes it out. K_stars stays the density away from the band (with the
  // band off the stars are exactly K_stars'); in it they crowd as milkyWayStars has them.
  float moonlit = clamp(dot(w.sky.moonColor, LUMA) / WORLD_GALAXY_MOONLIT, 0.0, 1.0);
  float band = milkyWay(skyStarFrame(w.sky, v.dir), WORLD_GALAXY) * K_milkyWay * K_stars * w.sky.night * (1.0 - WORLD_GALAXY_MOON * moonlit);
  col += WORLD_GALAXY_TINT * band * (1.0 - cloud);
  if (band > 0.0) density = K_stars * milkyWayStars(1.0, band) / milkyWayStars(1.0, 0.0);
#endif
  col += SKY_STAR_TINT * skyStars(w.sky, v.dir, density, v.foot) * (1.0 - cloud);
#endif
  col = skyGiant(w.sky, col, v.dir, v.foot, 1.0 - cloud);
#if WORLD_METEORS
  float streak = meteorStreak(skyAngles(v.ray), meteorField, w.meteorAge, w.meteorSeed, v.foot);
  col += METEOR_TINT * hardEdge(streak * auroraSeen(w.sky, max(cloud, w.overcast)));
#endif
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

// How much of the sun's light reaches a point at (scene units from the eye, in the camera's frame,
// y up: the ground under a pixel is y = -eye): 1 in the open, down to 1 - K_shadows in the shadow
// the cloud deck casts where the sun's ray from it meets the deck (skyCloudShadow, the deck
// WORLD_CLOUD_BASE metres up). Exactly 1 while the shadows are off. Multiply the sun's light by it.
float worldSunlit(World w, WorldView v, vec3 at) {
#if WORLD_SHADOWS
  if (K_shadows > 0.0 && w.cover > 0.0) {
    return 1.0 - K_shadows * skyCloudShadow(w.sky, skyFacing(at / v.unit, v.yaw), WORLD_CLOUD_BASE, w.t, w.cover, w.wind);
  }
#endif
  return 1.0;
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

// Fog (K_fog) between the eye and z (scene units; WORLD_FAR for open sky): fogAmount by the
// distance in metres and the height of the point seen over the ground (open sky reckoned
// WORLD_FOG_SKY metres out, so the fog hugs the horizon), mixing toward fogCol, the scene's mist.
void worldFog(World w, WorldView v, vec3 fogCol, float z, inout vec3 col, inout float accent) {
#if WORLD_FOG
  if (w.fog > 0.0) {
    float metres = z / v.unit;
    float height = (v.eye / v.unit + min(metres, WORLD_FOG_SKY) * v.ray.y / max(v.ray.z, 1e-3)) / WORLD_FOG_TOP;
    float f = fogAmount(w.fog, 1.0 - exp(-metres / WORLD_FOG_REACH), clamp(height, 0.0, 1.0));
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
    Precip fall = rainFall(v.uv, v.aspect, w.t, w.rain, w.wind, depth);
    col = precipOver(col, air, dropLight * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
#if WORLD_SNOW
  if (w.snow > 0.0) {
    Precip fall = snowFall(v.uv, v.aspect, w.t, w.snow, w.wind, depth);
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
    Precip fall = rainFallSeen(v.uv, v.aspect, w.t, w.rain, w.wind, depth, vanish);
    col = precipOver(col, air, dropLight * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
#if WORLD_SNOW
  if (w.snow > 0.0) {
    vec3 vanish = rainVanish(snowFallDir(w.snow, w.wind), right, up, fwd, v.focal);
    Precip fall = snowFallSeen(v.uv, v.aspect, w.t, w.snow, w.wind, depth, vanish);
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
    Precip fall = rainFall(v.uv, v.aspect, w.t, w.rain, w.wind, depth);
    fall.cover *= mix(thin.x, thin.y, fall.near);
    col = precipOver(col, air, dropLight * (1.0 - WORLD_NEAR_DIM * fall.near), fall);
    accent *= 1.0 - fall.veil;
  }
#endif
#if WORLD_SNOW
  if (w.snow > 0.0) {
    Precip fall = snowFall(v.uv, v.aspect, w.t, w.snow, w.wind, depth);
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
// true moon, so its silver lining shows under it), the Milky Way, the stars and the giant planet in
// its gaps (faded in the true moon's glare as the sky's are) and shooting stars, all at m's
// footprint: a rough mirror fades the stars to their glow, softens the giant and dims a streak to
// the share of its blur one cell is. In strike the lightning's bolt mirrored at m's screen point, as
// dim, and the flash's glow. A scene that drops its bolts out of its own storm draws their image
// itself and leaves strike's out.
WorldSky worldMirrorSky(World w, WorldView m, vec4 meteorField) {
  vec3 col = skyColor(skyMirror(w.sky), m.dir);
  float cell = 1.0 / (m.focal * uRes.y);
  float sharp = min(cell / m.foot, 1.0);
#if WORLD_AURORA
  col += auroraM(m.ray, w.tm, K_aurora, m.foot) * auroraSeen(w.sky, w.overcast);
#endif
  float cloud = 0.0;
#if WORLD_CLOUDS
  vec4 deck = skyClouds(w.sky, m.dir, w.t, w.cover, w.wind);
  col = mix(col, deck.rgb, deck.a);
  cloud = deck.a;
#endif
#if WORLD_STARS
  float density = K_stars;
#if WORLD_MILKYWAY
  float moonlit = clamp(dot(w.sky.moonColor, LUMA) / WORLD_GALAXY_MOONLIT, 0.0, 1.0);
  float band = milkyWay(skyStarFrame(w.sky, m.dir), WORLD_GALAXY) * K_milkyWay * K_stars * w.sky.night * (1.0 - WORLD_GALAXY_MOON * moonlit);
  col += WORLD_GALAXY_TINT * band * (1.0 - cloud);
  if (band > 0.0) density = K_stars * milkyWayStars(1.0, band) / milkyWayStars(1.0, 0.0);
#endif
  col += SKY_STAR_TINT * skyStars(w.sky, m.dir, density, m.foot) * (1.0 - cloud);
#endif
  col = skyGiant(w.sky, col, m.dir, m.foot, 1.0 - cloud);
#if WORLD_METEORS
  float streak = meteorStreak(skyAngles(m.ray), meteorField, w.meteorAge, w.meteorSeed, cell);
  col += METEOR_TINT * hardEdge(streak * auroraSeen(w.sky, max(cloud, w.overcast))) * sharp;
#endif
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
