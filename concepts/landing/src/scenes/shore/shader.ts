// The shore scene's picture: a beach by moonlight, surf rolling in, plankton flashing blue.
//
// World units are metres: x right, y up, z ahead of the viewer, still water at y = 0 and the eye
// SHORE_EYE above it. The surf is a train of crest lines parallel to the beach. Each wave's whole
// life (shoaling, breaking, the bore, the swash up the sand and the backwash) is a closed-form
// function of time, so every frame is drawn on its own with no state. Open water carries only the
// swell, wind ripples and the glitter of the moon (or the sun); foam belongs to the surf: the lip
// and the spray it throws up as it lands, the bore and the foam it leaves lying behind, and the
// swash. Plankton light (Noctiluca scintillans, the accent) gathers wherever that water is
// agitated, and where the pointer stirs it (uSim0.r, see sim.ts).
//
// Nothing changes from one frame to the next by chance: glints and sparks swell and fade over a
// quarter of a second or more, and textures that travel keep their features a few cells wide, so
// the dither steps through them instead of blinking. For the same reason the scene sets no shimmer.
// What sweeps across the frame is decided per cell against the cell's own threshold: foam, spray
// and the crest line are there or not, and the plankton's light is snapped to off, half or full, so
// a breaker or a swash running over a cell changes it a couple of times, every colour channel at
// once, rather than stepping each channel through the palette's levels on its own.
//
// The sky, its weather and what flies in it are the shared world's (shaders/lib/world.ts): the
// dome, the aurora, the cloud deck, the Milky Way and the stars, shooting stars, their light on the
// beach, the deck's shadows on the sand and the sea, gulls by day, fog, rain and snow, seen through
// the beach's camera (a level pinhole SHORE_EYE metres over the still water, turned toward
// moonrise). Over the world's sky the beach composes its own: the grey of the rain's (or the
// snow's) cloud, the light gap under it along the horizon and the rain shafts hanging out at sea,
// and the storm bank standing right of ahead while there is lightning, the bolts dropping out of it
// to the water. The sea and the wet sand mirror the world's sky (worldMirrorSky): the moon on the
// water is the glitter's alone, the ripples blur the stars into their faint glow and the aurora into
// a sheen, and the glossy sand a backwash leaves mirrors the stars, the aurora and the gulls sharp.
//
// Rain belongs to the beach's weather, not to the glass in front of it. It comes out of the world's
// overcast, which closes over the stars, the moon and the sun with the amount; the beach's grey
// cloud spreads their light into a dim glow and lights the beach flat from the grey above, heavier
// rain darkens it, and hangs shafts of rain under it far out at sea. Drops fall only in front of the
// sand, surf or sea they would land on (the world's rain, at the depth of what each cell sees), and
// the farther rain fuses into a grey veil that closes in on the horizon. On the water the drops ring
// near the shore and, where there is plankton, now and then a strike lights a spark; on the near
// sand they splash, and the beach soaks through as it goes on raining (uWeather.x: darker, glazed
// with a film that mirrors the lighter cloud low over the sea, puddles in its hollows) and dries
// slowly after. Sparks and rings are switched on per cell against the cell's threshold, so each cell
// lights once and goes dark once. Snow falls the same way into the sea and the swash and lies on the
// dry sand above it (uWeather.y), melting after.
//
// Knobs: K_size, K_period (surf); K_glow, K_sparkles, K_stir, K_fish (bioluminescence; fish fire
// on trigger 0); K_mark (the M in the sand); the world's (scenes/world.ts, read through
// shaders/lib/world.ts: src/scenes/README.md, "World layers"): K_time, K_cycle, K_stars,
// K_milkyWay, K_moon, K_meteors (and its "now", trigger 2), K_clouds, K_shadows, K_rain, K_snow,
// K_fog, K_wind, K_lightning (and its "now", trigger 1), K_aurora, K_birds, K_birdKind,
// K_birdFormation, each part compiled in only while its knobs can show it (worldFeatures).
// uWeather.x: how wet the beach is from the rain; uWeather.y: how much snow lies on it.
//
// The passage is played in the beach itself. The whole surf (every crest, bore, swash and the
// waterline with them) is one rigid pattern, and the entrance has it stand out to sea (SHORE_SURGE_IN
// metres) and run in on a decelerating curve, the way a swash runs up the sand and stops, while the
// plankton in the disturbed water flashes, and the camera, which starts tilted down at the sand,
// comes up to the horizon with a touch of give. The exit draws the pattern back out to sea, ever
// faster (SHORE_SURGE_OUT), the sand it uncovers still wet and, where the plankton is stranded, sparking.
// The camera is a vertical lens shift of the whole frame (the world's view is built from the
// shifted uv, so the sky, the moon, the lightning, the birds and the rain stay in one projection with
// the sea). All of it is exactly 0 at rest, where uv == screenUv, and none of it touches the waves'
// own clock.

import { worldGlsl } from "../../shaders/lib/world.ts";
import { SHORE_LIGHTNING_TRIGGER, SHORE_METEOR_TRIGGER } from "./constants.ts";
import { CAIRN_SITES, CAIRN_STONES } from "./cairns.ts";

export const shoreGlsl = `
${worldGlsl}
const float SHORE_HORIZON = 0.6;  // screen height of the horizon
const float SHORE_FOV = 0.7;      // vertical field of view (rad): a long lens stacks up the surf
const float SHORE_EYE = 1.8;      // eye height above still water
const float SHORE_LINE = 9.0;     // the still-water line, metres ahead
const float SHORE_FAR = 72.0;     // where each swell line comes into view
const float SHORE_TRAVEL = 22.0;  // seconds from SHORE_FAR to the still-water line
const int SHORE_WAVES = 9;        // waves tracked at once, from new swell to drained backwash
// The beach faces 29 degrees further round than the sky library's view, toward moonrise: at the
// default hour (K_time 0.82) the moon stands 6 degrees up a little right of ahead with its path
// lying across the breakers, and at dawn the sun comes up at the right edge of the frame. The
// world's view turns by -SHORE_FACING from the camera's frame into the sky's.
const float SHORE_FACING = 0.506;
// The world's "now" slots, and where shooting stars set out: skyAngles of the camera's ray
// (bearing, elevation, radians), high over the sea.
const int SHORE_LIGHTNING_SLOT = ${SHORE_LIGHTNING_TRIGGER};
const int SHORE_METEOR_SLOT = ${SHORE_METEOR_TRIGGER};
const vec4 SHORE_METEOR_FIELD = vec4(-0.45, 0.16, 0.9, 0.08);
// The world's gulls: over the surf and the sea 12 to 160 metres out, cruising from just over the
// horizon to the top of the frame, a swooping party skimming the water at 1.2 metres, drawn half
// as large again as life; they fade into the mist low over the sea by this much per metre.
const WorldFlyway SHORE_FLYWAY = WorldFlyway(vec2(12.0, 160.0), vec2(SHORE_HORIZON + 0.03, 0.95), vec2(3.7, 8.2), 1.2, 1.5);
const float SHORE_BIRD_HAZE = 0.002;
// How far the dull sand blurs what it mirrors (radians): the gloss of a film of water sharpens it.
const float SHORE_SAND_BLUR = 0.05;
// The glitter of the moon and the sun (waterGlint): each one's exposure per unit of its strength
// (the brightest channel of its light), set so the moon at the default hour, 6 degrees up, and
// the sun 8 degrees up lay the paths they always did; the share of the facets in the sea's broad
// tail (the swell's and the breeze's slopes the drawn surface leaves out, variance 0.03), which
// lays a wide sheen round the moon's path; and how much more a cell is exposed where a single
// facet catches the moon or the sun (shoreGlints).
const float SHORE_MOON_GLINT = 0.049;
const float SHORE_SUN_GLINT = 0.012;
const float SHORE_TAIL = 0.66;
const vec2 SHORE_FLICKER = vec2(2.2, 2.5);
// Snow lying on the dry sand.
const vec3 SHORE_SNOW = vec3(0.86, 0.88, 0.92);
const vec2 SHORE_MARK = vec2(2.0, 7.5);       // the M's centre on the sand (x, z)
const vec2 SHORE_MARK_SIZE = vec2(1.3, 3.0);  // drawn long, like road lettering, so it reads from here
const vec3 SHORE_BIO = vec3(0.16, 0.9, 1.0);  // Noctiluca blue
const float SHORE_SURGE_IN = 10.0;   // passage: metres the surf stands out to sea as the entrance begins
const float SHORE_SURGE_OUT = 9.0;   // passage: metres it has drawn back by the end of the exit
const float SHORE_TILT = 0.085;      // passage: the camera's tilt down at the sand at the start, in screen heights

struct ShoreWave {
  float zc;     // crest, or the bore's front once broken (metres ahead)
  float amp;    // crest height above still water
  float front;  // width of the face toward the beach
  float back;   // width of the slope behind the crest
  float steep;  // 0 open swell .. 1 about to break
  float broken; // metres run since the lip fell (0 before the break)
  float height; // the wave's breaking height here
  float swash;  // seconds since it reached the still-water line (< 0 before)
  float seed;
};

// Wave k, where its crest crosses this view ray (x = camX + slopeX * z). Born at a jittered multiple
// of the period, it crosses the surf in SHORE_TRAVEL seconds, slowing to a third of its offshore
// speed as the water shallows (shallow-water waves travel at sqrt(g * depth)).
ShoreWave shoreWave(float k, float camX, float slopeX, float tm, float period, float size) {
  ShoreWave w;
  w.seed = hash12(vec2(k, 11.3));
  float age = tm - (k + 0.45 * hash12(vec2(k, 3.7))) * period;
  float u = age / SHORE_TRAVEL;
  float uc = clamp(u, 0.0, 1.0);
  float run = (SHORE_FAR - SHORE_LINE) * (1.0 - uc) * (1.0 - 0.5 * uc);
  float x = camX + slopeX * (SHORE_LINE + run);
  // Crests are gently bowed out at sea and straighten as they reach the beach.
  float bow = (1.1 * sin(x * 0.045 + w.seed * TAU) + 0.5 * sin(x * 0.12 + w.seed * 17.0)) * (1.0 - uc);
  w.zc = SHORE_LINE + run + bow;
  // Height: sets of bigger waves every seventh or so, each wave its own, and peaks along the crest.
  float set = 0.5 + 0.5 * sin(k * TAU / 7.0 + 1.3);
  float peaks = 1.0 + 0.22 * sin(x * 0.09 + w.seed * 31.0) + 0.12 * sin(x * 0.23 + w.seed * 7.0);
  w.height = min(size * (0.6 + 0.25 * set + 0.3 * w.seed) * peaks, 1.45);
  // Bigger waves feel the bottom sooner and break further out (a wave breaks once the depth is
  // about 1.3 times its height, McCowan's limit), so the peaks go first and the break peels
  // sideways along the crest. The peel is kept quick (the peaks count for only part of it) so most
  // of a crest breaks within a second and its flash reads as one long line.
  float breakAt = SHORE_LINE + 3.0 + 8.5 * w.height / (1.0 + 0.6 * (peaks - 1.0));
  w.broken = max(breakAt - w.zc, 0.0);
  float shoal = clamp((SHORE_FAR - w.zc) / (SHORE_FAR - breakAt), 0.0, 1.0);
  w.steep = shoal * shoal * shoal * shoal;
  // Shoaling lifts the crest (Green's law); after the break the bore keeps about half its height
  // and spends it on the way in, collapsing at the waterline.
  float grow = 0.22 + 0.78 * shoal * shoal;
  float spend = mix(1.0, 0.5, smoothstep(0.0, 3.5, w.broken)) * exp(-max(w.broken - 3.5, 0.0) / 16.0);
  float land = mix(0.25, 1.0, smoothstep(SHORE_LINE, SHORE_LINE + 4.0, w.zc));
  w.amp = w.height * grow * spend * land * smoothstep(0.0, 0.08, u) * step(u, 1.0);
  float bore = smoothstep(0.0, 3.0, w.broken);
  w.front = w.broken > 0.0 ? mix(0.7, 0.45, bore) : mix(5.0, 0.7, w.steep);
  w.back = w.broken > 0.0 ? mix(4.0, 3.0, bore) : mix(6.0, 4.0, w.steep);
  w.swash = age - SHORE_TRAVEL;
  return w;
}

// Wave w's height at distance z: a swell hump that steepens on its beach side, becoming a bore
// (a step of white water sloping away behind it) once broken.
float shoreWaveHeight(ShoreWave w, float z) {
  float d = z - w.zc;
  float s = d < 0.0 ? w.front : w.back;
  float swell = exp(-d * d / (s * s));
  float bore = smoothstep(-w.front, 0.0, d) * exp(-max(d, 0.0) / w.back);
  return w.amp * mix(swell, bore, smoothstep(0.0, 2.0, w.broken));
}

// How far wave w's swash runs up the sand at x (metres from the still-water line): bigger waves
// further, and beach cusps a dozen metres apart bunch it into tongues.
float shoreRunup(ShoreWave w, float x) {
  float cusps = 1.0 + 0.22 * sin(x * 0.5 + w.seed * 13.0) + 0.12 * sin(x * 1.3 + w.seed * 5.0);
  return (0.9 + 1.5 * w.height) * cusps;
}

// Seconds a swash takes to run up and drain back to the still-water line.
float shoreSwashTime(float runup) {
  return 1.5 + 2.2 * sqrt(runup);
}

// Where wave w's water reaches up the beach (metres from the still-water line; negative while it
// is still offshore, and once its backwash has drained below the line). The swash front flies up
// like a thrown ball (the ballistic swash of Shen & Meyer 1963), stops, and drains back more slowly
// than it came, the sand soaking up part of the sheet.
float shoreReach(ShoreWave w, float runup) {
  if (w.swash < 0.0) return SHORE_LINE - w.zc;
  float dur = shoreSwashTime(runup);
  float rise = 0.38 * dur;
  if (w.swash < rise) {
    float a = 1.0 - w.swash / rise;
    return runup * (1.0 - a * a);
  }
  float b = min((w.swash - rise) / (dur - rise), 1.18);
  return runup * (1.0 - b * b);
}

// Seconds since wave w's backwash uncovered the sand e metres up the beach: huge if its swash
// never got there or still covers it.
float shoreDrained(ShoreWave w, float runup, float e) {
  if (w.swash < 0.0 || e >= runup || e < -0.39 * runup) return 1e4;
  float dur = shoreSwashTime(runup);
  float rise = 0.38 * dur;
  float at = rise + sqrt(1.0 - e / runup) * (dur - rise);
  return w.swash >= at ? w.swash - at : 1e4;
}

// Glints in the glitter: single wave facets catching the light for a moment. They live on a grid
// fixed to the water, gp = (x / z, eye / z) scaled to cells, so each grid cell is 9 x 4 dither cells
// wherever it lies and a glint is never thinner than two; each one swells and fades over a second
// or two, never from one frame to the next. Returns 0..1.
float shoreGlints(vec2 gp, float tm) {
  vec2 g = gp / vec2(9.0, 4.0);
  vec2 id = floor(g);
  float h = hash12(id + 0.37);
  float age = tm / (0.9 + 0.9 * h) + fract(h * 7.31);
  float turn = floor(age);
  vec2 seed = id + turn * vec2(0.73, 1.37); // a fresh place and chance for each glint
  if (hash12(seed + 5.3) > 0.55) return 0.0;
  vec2 at = 0.3 + 0.4 * vec2(hash12(seed + 1.1), hash12(seed + 2.9));
  vec2 r = (fract(g) - at) * vec2(9.0 / 2.6, 4.0 / 1.2); // in glint radii: 2.6 x 1.2 cells
  float swell = sin(3.14159265 * (age - turn));
  return swell * swell * (1.0 - smoothstep(0.35, 1.0, dot(r, r)));
}

// How much of the surface a foam texture covers for a given amount of foam (0..1): patches with
// holes when there is plenty, a few torn streaks as it thins. Where the cells no longer resolve the
// texture the edges soften into its mean cover instead of snapping on and off.
float shoreFoamCover(vec2 foam, float amount) {
  float th = 0.8 - 0.35 * amount;
  float w = mix(0.3, 0.05, foam.y);
  return smoothstep(th - w, th + w, foam.x) * smoothstep(0.0, 0.15, amount);
}

// A light snapped per cell to 0, 0.5 or 1 against the cell's threshold th: as it sweeps in or fades,
// a cell changes at most twice, all its colour channels at once.
float shoreStep(float v, float th) {
  return min(floor(max(v, 0.0) * 2.0 + th) * 0.5, 1.0);
}

// Foam bubbles bursting on freshly drained sand, each a spark: Noctiluca lights when its membrane
// is stressed. Each spark swells over a fifth of a second or more and fades over a second, so the
// dither steps through it rather than blinking, and moves to a new place for its next burst. Cells
// are long in z so the sparks come out round once perspective squashes the beach.
float shoreSparks(vec2 p, float tm, float density) {
  vec2 g = p / vec2(0.3, 0.9);
  vec2 id = floor(g);
  if (hash12(id + 17.0) > density) return 0.0;
  float age = tm * (0.35 + 0.4 * hash12(id + 9.2)) + hash12(id + 1.9);
  float turn = floor(age);
  float phase = age - turn;
  vec2 seed = id + turn * vec2(1.31, 0.71);
  vec2 at = 0.3 + 0.4 * vec2(hash12(seed + 3.1), hash12(seed + 5.7));
  float r = length(fract(g) - at);
  float env = smoothstep(0.0, 0.15, phase) * (1.0 - smoothstep(0.15, 0.75, phase));
  return env * (1.0 - smoothstep(0.08, 0.28, r));
}

// The storm out at sea: a bank of cloud standing on the horizon right of ahead. az, el: the view
// direction's x and y over z. Returns its cover.
float shoreStormBank(float az, float el, float drift) {
  float across = (az - 0.3) / 0.4;
  float spread = exp(-across * across);
  float top = spread * (0.03 + 0.08 * fbm(vec2(az * 3.0 + drift, 2.7)));
  return 1.0 - smoothstep(top - 0.012, top, el);
}

// The rain's (or the snow's) cloud of the beach's own, under the world's deck: how far it has closed
// over the sky (overcast 0..1, the world's), how heavy and low it hangs (heavy 0..1), the grey of its
// underside, and the moon and sun behind it with the light they would shed through a clear sky.
struct ShoreCloud {
  float overcast;
  float heavy;
  vec3 base;
  vec3 moon;
  vec3 moonCol;
  vec3 sun;
  vec3 sunCol;
};

// The light of the hidden moon or sun, spread by the cloud into a broad, dim patch around it.
vec3 shoreHidden(ShoreCloud c, vec3 dir) {
  vec3 mv = dir - c.moon;
  vec3 sv = dir - c.sun;
  return c.moonCol * 0.15 * exp(-dot(mv, mv) * 2.5) + c.sunCol * 0.3 * exp(-dot(sv, sv) * 3.0);
}

// The underside of the rain's (or the snow's) cloud along dir: grey, lighter toward the horizon
// (the light comes in under the cloud base out at sea), glowing where the hidden moon or sun stands
// behind it, and darker the heavier it falls.
vec3 shoreGrey(ShoreCloud c, vec3 dir) {
  float h = max(dir.y, 0.0);
  return (c.base * (0.7 + 0.7 * exp(-h * 5.0)) + shoreHidden(c, dir)) * mix(1.0, 0.7, c.heavy);
}

// The sky as the air and the dull sand's glaze see it: the clear sky (skyM, with the moon swung
// round behind the viewer, see sceneShore) under as much of the rain's grey as it is overcast. The
// grey keeps the true moon: its glow through the cloud has no disc to break, so the wet sand
// mirrors it as a broad, soft path.
vec3 shoreDome(Sky skyM, ShoreCloud c, vec3 dir) {
  vec3 clear = skyColor(skyM, dir);
  return c.overcast > 0.0 ? mix(clear, shoreGrey(c, dir), c.overcast) : clear;
}

// Rain shafts far out at sea: curtains hanging from the cloud base (elevation top) to the horizon,
// leaning downwind, streaked along their fall and drifting slowly along the horizon. More of them,
// and wider, the harder it rains, until in a downpour they close into one grey wall (and the veil
// takes them). az, el: the view direction's x and y over z. Returns their density 0..1.
float shoreShafts(float az, float el, float top, float tm, float rain, float wind) {
  float x = az - (top - el) * 1.2 * wind - tm * 0.003 * wind;
  float n = 0.6 * vnoise(vec2(x * 7.0, 3.1)) + 0.4 * vnoise(vec2(x * 17.0, 8.3));
  float th = mix(0.7, 0.36, smoothstep(0.25, 1.0, rain));
  float curtain = smoothstep(th, th + 0.12, n);
  // Ragged where they leave the cloud; the streaks, several cells apart, creep down slowly.
  float base = top * (0.8 + 0.4 * vnoise(vec2(x * 9.0, 1.7)));
  float hang = 1.0 - smoothstep(base * 0.5, base, el);
  float streak = vnoise(vec2(x * 110.0, el * 6.0 - tm * 0.15));
  return curtain * hang * (0.6 + 0.4 * streak) * smoothstep(0.2, 0.45, rain);
}

// The rain's (or the snow's) sky over the world's (col, with the world's cloud deck in it, cloud its
// alpha along the ray): a grey haze closing over the open sky with the overcast, the deck's
// undersides darkening the heavier it falls, with the hidden moon or sun glowing through. Out at sea,
// under the cloud base, a thin light gap along the horizon and, in rain, shafts hanging in front of
// it, lit up by the lightning. az, el: the view direction's x and y over z; day: the sky's.
vec3 shoreRainSky(vec3 col, float cloud, float day, ShoreCloud c, vec3 dir, float az, float el, float storm, float rain, float wind, float flash) {
  vec3 clear = col;
  vec3 grey = shoreGrey(c, dir);
  vec3 under = col * mix(0.5, 1.0, day) * mix(0.9, 0.6, c.heavy) + shoreHidden(c, dir) * 0.6 * c.overcast;
  col = mix(mix(col, grey, c.overcast), under, cloud);
  float gap = exp(-el / 0.03) * (1.0 - 0.85 * c.heavy) * smoothstep(0.15, 0.4, storm);
  col = mix(col, grey * 1.25 + clear * 0.3, gap * 0.8);
#if WORLD_RAIN
  if (rain > 0.0) {
    float shaft = shoreShafts(az, el, mix(0.1, 0.055, c.heavy), uMotionTime, rain, wind);
    col = mix(col, grey * 0.6 + vec3(0.3, 0.32, 0.45) * flash, shaft * 0.8);
  }
#endif
  return col;
}

// Raindrops striking the sea: where there is plankton each one lights a pinpoint of blue that swells
// for about a third of a second, holds, and fades over a second, before that cell's next drop lands
// somewhere else two or three seconds later. The grid is fixed to the water in perspective like the
// glints' (gp, in dither cells, 10 x 6 of them per grid cell), so a spark is never thinner than two
// cells, and it thins out with distance (zk over the rows below the horizon is the distance in
// metres) so the far sea never fills with points. Each spark is switched on per dither cell against
// th: a cell lights once and goes dark once. density 0..1 is the share of grid cells struck in each
// turn. Returns 0 or 1.
float shoreRainSparks(vec2 gp, float tm, float density, float zk, float th) {
  vec2 g = gp / vec2(10.0, 6.0);
  vec2 id = floor(g);
  float z = zk / max((id.y + 0.5) * 6.0, 1.0);
  density *= 1.0 - smoothstep(12.0, 45.0, z);
  float h = hash12(id + 23.7);
  float age = tm * (0.3 + 0.2 * h) + fract(h * 5.31);
  float turn = floor(age);
  vec2 seed = id + turn * vec2(0.91, 1.73);
  if (hash12(seed + 7.7) >= density) return 0.0;
  vec2 at = 0.3 + 0.4 * vec2(hash12(seed + 1.3), hash12(seed + 4.1));
  vec2 r = (fract(g) - at) * vec2(10.0 / 2.2, 6.0 / 1.3); // in spark radii: 2.2 x 1.3 cells
  float phase = age - turn;
  float env = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(0.25, 0.6, phase));
  return env * (1.0 - smoothstep(0.2, 1.0, dot(r, r))) > th ? 1.0 : 0.0;
}

// A school of fish darting through the shallows. Each fish runs a wavy line across the view and
// its wake is where it passed, fading and spreading with the seconds since. p is the point on the
// water (x, z); returns the wake's light, and the fish themselves in body.
float shoreFish(vec2 p, float age, float seed, float camX, float halfSpan, float cellZ, out float body) {
  body = 0.0;
  float side = seed > 0.5 ? 1.0 : -1.0;
  float lane = SHORE_LINE + 1.6 + 2.6 * fract(seed * 7.13);
  if (abs(p.y - lane) > 3.5) return 0.0;
  float start = camX - side * (halfSpan + 4.0);
  float wake = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float h1 = hash12(vec2(fi, seed * 91.0));
    float h2 = hash12(vec2(fi, seed * 57.0 + 3.0));
    float run = age - h1 * 0.7;
    if (run < 0.0) continue;
    float speed = 6.0 + 2.0 * h2;
    float behind = side * (start + side * speed * run - p.x); // metres behind this fish's nose
    if (behind < -0.4 || behind > speed * 3.5) continue;
    float pathZ = lane + (h2 - 0.5) * 1.8 + 0.45 * sin(p.x * 0.7 + fi * 2.1) + 0.2 * sin(p.x * 2.3 + h1 * 9.0);
    float since = max(behind, 0.0) / speed;
    float width = max(0.1, 2.0 * cellZ) * (1.0 + 1.5 * since);
    float dz = (p.y - pathZ) / width;
    float across = exp(-dz * dz);
    wake += across * exp(-since / 1.3) * smoothstep(-0.4, 0.0, behind) / (1.0 + since);
    float nose = (behind - 0.1) / 0.16;
    body = max(body, exp(-dz * dz * 1.5) * exp(-nose * nose));
  }
  return wake;
}

// The passage, in the beach (see the header). How far out to sea of its place the whole surf stands,
// in metres: it runs in on a decelerating curve like a swash, and goes back out accelerating, as the
// sea is drawn out. Exactly 0 at rest.
float shoreSurge() {
  float pin = passageIn();
  float pout = passageOut();
  float surge = 0.0;
  if (pin < 1.0) {
    float u = 1.0 - pin;
    surge += SHORE_SURGE_IN * u * u;
  }
  if (pout > 0.0) surge += SHORE_SURGE_OUT * pout * pout;
  return surge;
}

// The camera's vertical lens shift in screen heights: starts tilted down at the sand (the frame's
// content is read lower in uv), already moving, and comes up to the horizon with a little overshoot.
// 0 at rest.
float shoreLens() {
  float pin = passageIn();
  if (pin >= 1.0) return 0.0;
  float settle = passageSettle(pin, 1.7); // ease out with a little overshoot
  return -SHORE_TILT * (1.0 - settle);
}

// The plankton's flash in the disturbed water: the surf running in lights it as it goes, and the
// water drawn back out lights a little. Multiplies the surf's light as 1 + 1.4 * flash. 0 at rest.
float shoreFlash() {
  float pin = passageIn();
  float pout = passageOut();
  float flash = 0.0;
  if (pin < 1.0) flash += smoothstep(0.1, 0.3, pin) * (1.0 - smoothstep(0.38, 0.9, pin));
  if (pout > 0.0) flash += 0.6 * smoothstep(0.0, 0.3, pout) * (1.0 - smoothstep(0.6, 1.0, pout));
  return flash;
}

#ifndef SHORE_CAIRNS
#define SHORE_CAIRNS 0
#endif
#if SHORE_CAIRNS
// The agents' cairns (cairns.ts, uSim1 while there are any): a row per site, its first texel (x, z,
// stones, wet), then two a stone ((x from the site, height of its middle, turn, half width), (half
// height, shade)); the last row the pebbles the principals carry, a texel each (half width, half
// height, shade, 1). The nearest stone in front of what the ray meets at depth z, along the ray of
// slope slopeX across and q down: its cover (x), how far it faces up (y), its shade (z) and how wet
// it is (w); z becomes its depth. Stones are boxes with a pebble's round corners, upright to the view.
vec4 shoreStone(float camX, float slopeX, float q, float focal, inout float z) {
  vec4 hit = vec4(0.0);
  for (int s = 0; s < ${CAIRN_SITES}; s++) {
    vec4 site = texelFetch(uSim1, ivec2(0, s), 0);
    if (site.z < 0.5 || site.y >= z) continue;
    vec2 p = vec2(camX + slopeX * site.y - site.x, SHORE_EYE - q * site.y);
    if (abs(p.x) > 1.6 || p.y > 0.9) continue;
    float aa = site.y / (focal * uRes.y);
    for (int j = 0; j < ${CAIRN_STONES}; j++) {
      if (float(j) >= site.z) break;
      vec4 a = texelFetch(uSim1, ivec2(1 + 2 * j, s), 0);
      vec4 b = texelFetch(uSim1, ivec2(2 + 2 * j, s), 0);
      vec2 d = rotate(p - a.xy, -a.z);
      vec2 size = vec2(a.w, b.x);
      float cover = hardFill(sdBox(d, size, 0.8 * b.x), aa);
      if (cover <= 0.0) continue;
      hit = vec4(cover, clamp(0.5 + 0.5 * d.y / b.x, 0.0, 1.0), b.y, site.w);
      z = site.y;
    }
  }
  return hit;
}

// The pebbles the agents carry, held under their cursors (main's ring, r cells): cover (x), shade (z).
vec4 shoreHeld(vec2 cell) {
  float r = max(4.0, 0.011 * uRes.y);
  vec4 hit = vec4(0.0);
  for (int i = 1; i < MAX_PRINCIPALS; i++) {
    if (i >= uPrincipalCount) break;
    vec4 held = texelFetch(uSim1, ivec2(i, ${CAIRN_SITES}), 0);
    if (held.w < 0.5) continue;
    vec2 size = held.xy * (1.4 * r / 0.1);
    vec2 d = cell - uPrincipals[i].xy * uRes + vec2(0.0, 1.4 * r + size.y);
    float cover = hardFill(sdBox(d, size, 0.8 * size.y), 0.9);
    if (cover > 0.0) hit = vec4(cover, clamp(0.5 + 0.5 * d.y / size.y, 0.0, 1.0), held.z, 0.0);
  }
  return hit;
}

// A stone's colour under the beach's light: grey to sandy by its shade, darker wet, lit from above.
vec3 shoreStoneColour(vec4 stone, vec3 ambient, vec3 light) {
  vec3 albedo = mix(vec3(0.30, 0.29, 0.28), vec3(0.62, 0.57, 0.50), stone.z) * mix(1.0, 0.55, stone.w);
  return albedo * (ambient * 1.3 + light * (0.3 + 0.7 * stone.y));
}
#endif

Shade sceneShore(vec2 screenUv, vec2 cell, float t) {
  // The camera's tilt (the passage): everything of the world is built from uv; only the pointer's
  // wake, which lives in the frame, reads screenUv.
  vec2 uv = screenUv;
  float lens = shoreLens();
  if (lens != 0.0) uv.y += lens;
  float m = uMotion;
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  float focal = 0.5 / tan(SHORE_FOV * 0.5);
  // The shared world (shaders/lib/world.ts) through the beach's camera, a level pinhole SHORE_EYE
  // metres over the still water (world units are metres), its frame turned toward moonrise from the
  // sky's: the sky now and its light, under the deck rain or snow closes over it.
  World world = worldAt(SHORE_METEOR_SLOT, SHORE_LIGHTNING_SLOT);
  WorldView camera = worldView(uv, SHORE_HORIZON, focal, SHORE_EYE, -SHORE_FACING, 1.0);
  vec3 dir = camera.ray;
  vec3 view = -dir;
  vec2 sp = (uv - 0.5) * vec2(aspect, 1.0); // screen-height units, for the lightning

  // The world's sky turned into the camera's frame, to light the beach and lay the glitter by. Rain
  // and snow come out of an overcast sky: the world's deck closes over with the amount, hiding the
  // stars, the moon and the sun, whose light the beach's grey cloud spreads instead, so the beach is
  // lit flat by the grey above; heavier rain darkens it further.
  Sky sky = skyFacing(world.sky, SHORE_FACING);
  float rain = world.rain;
  ShoreCloud cloud;
  cloud.overcast = world.overcast;
  cloud.heavy = world.heavy;
  cloud.base = vec3(0.9, 0.96, 1.08) * dot(sky.ambient, LUMA) * mix(0.5, 1.0, sky.day);
  cloud.moon = sky.moon;
  cloud.moonCol = sky.moonColor;
  cloud.sun = sky.sun;
  cloud.sunCol = sky.sunColor / (1.0 - WORLD_DECK_SUN * world.overcast); // as through a clear sky
  // The world dims the sun's light under its deck; the beach dims the moon's as much.
  sky.moonColor *= 1.0 - 0.85 * cloud.overcast;
  // This cell's own threshold for the rain's rings and sparks, offset from the palette's.
  float th = threshold(cell + vec2(6.0, 1.0));
  // One offset from the palette's, for the plankton's light, so it and the surf's foam (hardEdge,
  // the cell's own threshold) don't pick the same cells.
  float thG = threshold(cell + vec2(1.0, 4.0));
  // For the air and the dull sand's glaze: the same sky with the moon swung round behind the
  // viewer, so no reflection shows a broken sliver of its disc (the world's mirror does the same).
  // The moon on the water is the glitter's alone.
  Sky skyM = skyMirror(sky);
  // The plankton only shows in the dark: full at night, fading through dawn, gone by day.
  float dark = 1.0 - smoothstep(0.05, 0.5, sky.day);
  float bio = K_glow * 1.5 * dark;
  // The world's lightning (its light on the beach is in the sky's ambient): the storm stands out to
  // sea right of ahead, and each bolt drops from its cloud base to the water.
  float flash = world.flash;
  float boltAz = 0.3 + (fract(world.boltSeed * 7.31) - 0.5) * 0.4;
  vec2 boltTop = vec2(boltAz * focal, SHORE_HORIZON - 0.5 + 0.085);
  vec2 boltFoot = vec2(boltTop.x + (fract(world.boltSeed * 3.17) - 0.5) * 0.06, SHORE_HORIZON - 0.5);
  // The bank stands while lightning is on; a strike fired with lightning off brings it only briefly.
  float storm = K_lightning > 0.0 ? 1.0 : 1.0 - smoothstep(1.0, 3.0, world.boltAge);
  // Light on a level surface. Moonlight is played up the lower the moon stands, so foam and sand
  // keep their shape under a moon near the horizon. Under the rain's cloud part of the hidden light
  // still comes through, flat and shadowless.
  vec3 moonLight = sky.moonColor * (0.3 + 0.6 * sqrt(max(sky.moon.y, 0.0)));
  vec3 sunLight = sky.sunColor * max(sky.sun.y, 0.0);
  vec3 lit = sky.ambient + sunLight + moonLight
           + (cloud.moonCol * 0.25 + cloud.sunCol * max(sky.sun.y, 0.0) * 0.3) * cloud.overcast;
  // How far the moon or the sun stands out over the sea ahead: then it shines through thin crests
  // and spray.
  float backMoon = max(sky.moon.z, 0.0);
  float backSun = 0.5 + 0.5 * max(sky.sun.z, 0.0);
  // The rain's air: the grey it fades into with distance, lit up by the lightning; the drops catch
  // its light and the beach's.
  vec3 air = shoreGrey(cloud, normalize(vec3(dir.x, 0.0, dir.z))) * 1.1 + vec3(0.12, 0.13, 0.18) * flash;
  vec3 dropLight = air * 1.5 + lit * 0.25;
  // The mist low over the sea in this bearing: what the fog and the far gulls fade into.
#if WORLD_FOG || WORLD_BIRDS
  vec3 mist = shoreDome(skyM, cloud, normalize(vec3(dir.x, 0.03, dir.z)));
#else
  vec3 mist = vec3(0.0);
#endif

  vec3 col = vec3(0.0);
  float glow = 0.0;    // plankton light, before the strength knob and the dark
  float mark = 0.0;    // the M's own glow, independent of the plankton knob
  float zHit = WORLD_FAR; // metres ahead to what this pixel sees (the sky: as far as it gets)

  if (dir.y >= 0.0) {
    float az = dir.x / dir.z;
    float el = dir.y / dir.z;
    // The world's sky: the dome, the aurora behind the clouds, the deck, the Milky Way and the stars
    // in its gaps, shooting stars high over the sea; the rain's grey over it, the storm bank out at
    // sea and the lightning out of it.
    WorldSky heaven = worldSky(world, camera, SHORE_METEOR_FIELD);
    col = heaven.col;
#if WORLD_RAIN || WORLD_SNOW
    if (world.storm > 0.0) col = shoreRainSky(col, heaven.cloud, sky.day, cloud, dir, az, el, world.storm, rain, world.wind, flash);
#endif
    if (storm > 0.0) {
      float bank = shoreStormBank(az, el, tm * 0.004 * world.wind) * storm;
      float inside = flash * exp(-abs(az - boltAz) * 3.0) * (0.5 + fbm(vec2(az * 9.0, el * 40.0)));
      col = mix(col, sky.ambient * 0.6 + vec3(0.5, 0.55, 0.8) * inside, bank * 0.92);
    }
    float bolt = world.boltAge < 1.5 ? lightningBolt(sp, boltTop, boltFoot, world.boltSeed, world.boltAge) : 0.0;
    col += mix(vec3(0.55, 0.45, 1.0), vec3(1.0), smoothstep(0.45, 0.75, bolt)) * min(bolt, 1.5);
    col += vec3(0.1, 0.11, 0.16) * flash * exp(-el * 6.0);
  } else {
    float q = -dir.y / dir.z; // tangent of the angle below the horizon
    float slopeX = dir.x / dir.z;
    float camX = uPointer.x * 0.35 * m; // a step along the beach with the pointer
    float zPlane = min(SHORE_EYE / q, 4000.0);
    float size = mix(0.35, 1.5, K_size);
    float surge = shoreSurge(); // the passage: how far out to sea the whole surf stands (0 at rest)
    float kNow = floor(tm / K_period);

    // Oldest first, which is nearest the beach first.
    ShoreWave waves[SHORE_WAVES];
    for (int i = 0; i < SHORE_WAVES; i++) {
      waves[i] = shoreWave(kNow - float(SHORE_WAVES - 1 - i), camX, slopeX, tm, K_period, size);
      waves[i].zc += surge; // every crest and bore moves out whole, with its swash (e below)
    }

    // Where the ray meets the water: test each wave's hump, nearest first, between where the ray
    // has dropped to the crest's height and where it would meet still water; bisect the crossing.
    float hz = zPlane;
    bool onWave = false;
    ShoreWave hit = waves[0];
    for (int i = 0; i < SHORE_WAVES; i++) {
      ShoreWave w = waves[i];
      if (w.amp < 0.02) continue;
      float lo = max(w.zc - 3.0 * w.front, (SHORE_EYE - w.amp) / q);
      float hi = min(w.zc + 2.5 * w.back, zPlane);
      if (lo >= hi) continue;
      float above = lo;
      float below = -1.0;
      for (int s = 0; s <= 12; s++) {
        float z = mix(lo, hi, float(s) / 12.0);
        if (SHORE_EYE - q * z <= shoreWaveHeight(w, z)) { below = z; break; }
        above = z;
      }
      if (below < 0.0) continue;
      for (int s = 0; s < 5; s++) {
        float z = 0.5 * (above + below);
        if (SHORE_EYE - q * z <= shoreWaveHeight(w, z)) below = z; else above = z;
      }
      hz = below;
      hit = w;
      onWave = true;
      break;
    }
    float hx = camX + slopeX * hz;
    float hy = SHORE_EYE - q * hz;
    zHit = hz;
    vec2 g = vec2(hx, hz);
    // Ground covered by one cell, depthwise and across: for antialiasing and level of detail.
    float cellZ = hz * hz / (SHORE_EYE * focal * uRes.y);
    float cellX = hz / (focal * uRes.y);
    float e0 = SHORE_LINE - hz;  // metres up the beach from the still-water line, where the beach is
    float e = e0 + surge;        // the same for the surf's pattern, which stands surge metres further out

    // The waterline is the most advanced of the bores coming in and the swashes running up. Each
    // swash also leaves a thin line of foam at the top of its run, until a later one washes over it,
    // and the plankton stranded along that line glows for a couple of seconds as the water draws back.
    float reach = -1e4;
    float topSwash = -1.0;
    float topRunup = 1.0;
    float drained = 1e4; // seconds since a backwash last uncovered this spot
    float strand = 0.0;  // the line of foam at a swash's highest reach
    float strandGlow = 0.0;
    for (int i = 0; i < SHORE_WAVES; i++) {
      float runup = shoreRunup(waves[i], hx);
      float r = shoreReach(waves[i], runup);
      if (r > reach) { reach = r; topSwash = waves[i].swash; topRunup = runup; }
      drained = min(drained, shoreDrained(waves[i], runup, e));
      if (waves[i].swash >= 0.0) {
        float since = waves[i].swash - 0.38 * shoreSwashTime(runup); // seconds since it stopped
        if ((since > 0.0 ? runup : r) > e) { strand = 0.0; strandGlow = 0.0; }
        if (since > 0.0) {
          float across = (e - runup) / max(0.05, 0.8 * cellZ);
          strand = max(strand, exp(-across * across) * exp(-since / 15.0));
          float wide = (e - runup + 0.1) / max(0.12, 1.6 * cellZ);
          strandGlow = max(strandGlow, exp(-wide * wide) * smoothstep(0.0, 0.3, since) * exp(-since / 1.8));
        }
      }
    }
    bool water = e < reach;
    float edge = reach - e; // metres inside the water from its leading edge
    float wet = 1.0;
    // The cloud deck's shadow (worldSunlit; off by default) where the ray meets the sea or the sand:
    // the sun's light there.
    float sunlit = worldSunlit(world, camera, vec3(slopeX * hz, hy - SHORE_EYE, hz));
    sky.sunColor *= sunlit;
    lit -= sunLight * (1.0 - sunlit);

    // Rain: rings where the drops land on the water and in standing water on the sand, small and
    // few in a drizzle, larger and crowding in a downpour, stretched along z so they survive
    // perspective. Their crests are switched on per cell (ring), and they fade out where a crest
    // would be thinner than a cell or two, so they never shimmer: they show on the swash and at the
    // water's edge, while further out the rain roughens the sea instead.
    vec3 drops = vec3(0.0);
    float ring = 0.0;
#if WORLD_RAIN
    if (rain > 0.0) {
      vec2 rs = vec2(3.0, 1.2) * mix(1.15, 0.85, cloud.heavy);
      float fade = 1.0 - smoothstep(0.04, 0.07, max(cellX * rs.x, cellZ * rs.y));
      if (fade > 0.0) {
        drops = rainRipples(g * rs, uFallTime, min(rain * 1.3, 1.0)) * fade;
        ring = drops.z > 0.1 + 0.9 * th ? 1.0 : 0.0; // never the rings' faint tails
      }
    }
#endif

    // The surface's face, before it is shaded: its normal (n), the share of the sky it mirrors
    // (fres), the ray it reflects (refl) and its facets' slope variance for the glitter (rough); the
    // ray its mirror looks the sky up along (look) and how far its roughness blurs that image. On
    // the sand the mirror is the water standing on it: the film a backwash leaves, the rain's
    // puddles in its hollows, and the gloss they give it.
    float rained = uWeather.x;
    float film = exp(-drained / 2.5);
    float puddle = 0.0;
    float pool = 0.0;
    float gloss = 0.0;
    float cv = 0.0;
    vec3 n;
    float fres;
    vec3 refl;
    float rough;
    vec3 look;
    float blur;
    if (water) {
      // Surface slope: the waves' own (along z) plus wind ripples and raindrops.
      float eps = max(0.05, cellZ);
      float slopeZ = 0.0;
      for (int i = 0; i < SHORE_WAVES; i++) {
        if (waves[i].amp < 0.02) continue;
        slopeZ += (shoreWaveHeight(waves[i], hz + eps) - shoreWaveHeight(waves[i], hz - eps)) / (2.0 * eps);
      }
      // The swash is a thin sheet sliding over the sand, smoother than the open water.
      float sheet = topSwash >= 0.0 ? 1.0 - smoothstep(0.5, 3.0, edge) : 0.0;
      float choppy = 1.0 - 0.6 * sheet;
      float windy = 0.6 + 0.9 * abs(world.wind);
      // Wind ripples: four trains spread by the golden angle with true deep-water dispersion, their
      // slopes scaled by the wind (rippleSpectrum). The trains these cells resolve tilt the surface;
      // the ones too fine to draw (z) give the glitter its roughness instead. Their slopes stay small
      // beside the glitter's own roughness, so they ruffle the moon's path rather than chop it into
      // flashing bands.
      vec3 rip = rippleSpectrum(g, tm, vec2(cellX, cellZ), windy,
                                RippleFan(4, vec2(3.2, 0.55), vec2(0.025, 0.003), vec2(1.0, 0.0), vec2(1.7, 2.4), vec3(0.0), 1.7, vec2(8.0, 16.0)));
      vec2 tilt = rip.xy * choppy + drops.xy * 0.5;
      // Facets too fine to draw still lean toward the eye: at a grazing view the sea mirrors sky
      // from higher up, and less of it, so it stays darker than the sky at the horizon, and blurs it.
      // Rain roughens it too, and a downpour beats it matte.
      rough = 0.002 + 0.0015 * windy + rip.z * choppy + 0.003 * rain + 0.012 * cloud.heavy;
      float spread = sqrt(rough);
      WaterMirror ruffled = waterMirror(dir, vec2(tilt.x, slopeZ + tilt.y), spread * 0.8);
      n = ruffled.normal;
      fres = ruffled.fresnel;
      refl = ruffled.ray;
      look = normalize(vec3(refl.x, max(refl.y, 0.0) + spread * 1.5, refl.z));
      blur = spread;
    } else {
      puddle = rained > 0.0 ? rainPuddles(g * 1.4, rained) : 0.0;
      pool = max(film, puddle); // standing water
      // Only the band the backwash has just left and the saturated sand right at the water's edge
      // are wet enough to mirror sharply: while a film drains off it, dull again as it soaks in.
      // Gentle undulations draw the moon out into a streak.
      gloss = max(film, 0.6 * (1.0 - smoothstep(0.2, 1.0, e)));
      vec2 swell = vec2(vnoise(g * vec2(1.2, 0.6)), vnoise(g * vec2(1.2, 0.6) + 7.3)) - 0.5;
      vec2 tilt = swell * 0.05 + drops.xy * 0.4 * pool;
      n = normalize(vec3(-tilt.x, 1.0, -tilt.y));
      cv = max(dot(n, view), 0.0);
      fres = fresnelSchlick(cv, 0.02, 0.0);
      refl = reflect(dir, n);
      refl = normalize(vec3(refl.x, max(refl.y, 0.01), refl.z));
      rough = 0.002 + 0.012 * (1.0 - gloss);
      look = refl;
      blur = SHORE_SAND_BLUR * (1.0 - gloss);
    }
    // What it mirrors: the world's sky along that ray (worldMirrorSky: the moon on the water is the
    // glitter's alone) and, as still as the glossy sand is, the gulls over it; under the rain's grey,
    // lit up by the lightning.
    WorldView mirrored = worldMirrorView(camera, look, blur);
    vec3 image = worldMirrorSky(world, mirrored, SHORE_METEOR_FIELD).col;
    if (gloss > 0.0) worldBirdsMirrored(world, mirrored, SHORE_FLYWAY, mist, SHORE_BIRD_HAZE, gloss, image);
    vec3 mirror = (cloud.overcast > 0.0 ? mix(image, shoreGrey(cloud, look), cloud.overcast) : image) + vec3(0.1, 0.11, 0.16) * flash;
    // The moon's and the sun's glitter fill in to each one's own hue at full strength, exposed by
    // how strongly it shines (waterGlint).
    float moonShine = max(sky.moonColor.r, max(sky.moonColor.g, sky.moonColor.b));
    vec3 moonHue = sky.moonColor / max(moonShine, 1e-4);
    float sunShine = max(sky.sunColor.r, max(sky.sunColor.g, sky.sunColor.b));
    vec3 sunHue = sky.sunColor / max(sunShine, 1e-4);

    if (water) {
      // The moon's path on the water (the sun's by day), broken by the swell into rows, and glints
      // in it: single facets catching the light for a moment. Around it a wide moonlit sheen, the
      // facets of the sea's broad tail (SHORE_TAIL): it lights the backs and troughs of the swell
      // well out to either side and leaves the faces turned to the viewer dark, so every row reads.
      // A low moon lays a long blazing path, a high one a short faint one.
      vec2 gp = vec2(hx, SHORE_EYE) / hz * focal * uRes.y; // dither cells, fixed to the water
      vec2 flicker = 1.0 + SHORE_FLICKER * shoreGlints(gp, tm);
      float moonPath = waterGlint(n, view, sky.moon, rough, SHORE_MOON_GLINT * moonShine * (1.0 - SHORE_TAIL) * flicker.x);
      float sheen = waterGlint(n, view, sky.moon, 0.03, SHORE_MOON_GLINT * moonShine * SHORE_TAIL);
      float sunPath = waterGlint(n, view, sky.sun, rough, SHORE_SUN_GLINT * sunShine * flicker.y);
      vec3 shine = moonHue * (moonPath + sheen) + sunHue * sunPath;
      // How strongly the moon lights rough white water here: brightest along its path, a lobe as
      // broad as the sheen about the half vector between the eye and the moon, 1 at its heart.
      vec3 toMoon = normalize(view + sky.moon);
      float foamC = max(toMoon.y, 1e-3);
      float moonOnFoam = sky.moon.y > 0.0 ? exp(-((1.0 - foamC * foamC) / (foamC * foamC)) / 0.03) : 0.0;

      // Water: dark blue offshore, turquoise over the sand in the shallows (muted at night), the
      // sand itself showing through the thin sheet of the swash.
      float shallow = (1.0 - smoothstep(SHORE_LINE, SHORE_LINE + 14.0, hz - surge)) * mix(0.35, 1.0, sky.day);
      vec3 body = mix(vec3(0.01, 0.06, 0.12), vec3(0.04, 0.38, 0.38), shallow) * lit;
      body = mix(body, vec3(0.36, 0.3, 0.23) * lit, (1.0 - clamp(edge / 2.2, 0.0, 1.0)) * 0.85);
      vec3 sea = mix(body, mirror, fres) + shine;

      if (onWave) {
        float hr = clamp(hy / max(hit.amp, 1e-3), 0.0, 1.0);
        float face = 1.0 - smoothstep(-0.2, 0.3, hz - hit.zc); // the side toward the beach
        float whole = 1.0 - smoothstep(0.0, 2.0, hit.broken);  // 1 until the lip falls
        float shoal = sqrt(sqrt(hit.steep));                    // 0 newly in view .. 1 at the break
        float below = (hit.amp - hy) / hz * focal * uRes.y;     // cells below the crest's top
        // Light through the thin top of a steep wave from the sun out over the sea behind it.
        float thin = smoothstep(0.45, 0.95, hr) * face * hit.steep * whole;
        sea += vec3(0.05, 0.42, 0.36) * thin * (sky.sunColor * 0.6 * backSun + sky.ambient * 0.4);
        // Below its crest, the face turned to the viewer stands dark at night against the moonlit
        // water around it.
        float wall = face * smoothstep(0.3, 0.8, shoal) * smoothstep(1.5, 4.0, below) * whole;
        sea *= 1.0 - 0.7 * wall * dark;
        // The crest line: a band a couple of cells deep along the top of every wave from about 50
        // metres in, catching the moon and brightest in its path, so the rows of surf keep their
        // rhythm all the way out.
        float crest = (1.0 - smoothstep(0.8, 2.6, below)) * smoothstep(0.25, 0.7, shoal) * (0.4 + 0.6 * whole);
        crest *= 0.8 + 0.2 * vnoise(vec2(hx * 0.5, hit.seed * 7.0));
        vec3 crestCol = lit * 0.6 + moonLight * 1.6 + sky.moonColor * 1.5 * moonOnFoam;
        sea = mix(sea, crestCol, hardEdge(crest) * mix(0.85, 0.35, sky.day));
        // As it plunges, the curl's shadow: a dark tube under the falling lip.
        float plunge = smoothstep(0.0, 0.4, hit.broken) * (1.0 - smoothstep(0.8, 2.5, hit.broken));
        sea *= 1.0 - 0.6 * plunge * face * smoothstep(0.3, 0.55, hr) * (1.0 - smoothstep(0.72, 0.86, hr));
      }

      // White water and the light in it, wave by wave.
      float dens = 0.0;   // the roller: churning white water at each bore's front
      float rel = 0.0;    // position behind the densest front, for the roller's texture
      float trail = 0.0;  // foam the bores leave lying on the water behind them
      float spray = 0.0;  // the burst thrown up over the crest as the lip lands
      float surf = 0.0;   // plankton light from the surf
      for (int i = 0; i < SHORE_WAVES; i++) {
        ShoreWave w = waves[i];
        float d = hz - w.zc;
        // Once its swash has started, a wave's white water lingers a moment behind the waterline.
        float linger = w.swash < 0.0 ? 1.0 : exp(-w.swash / 1.5);
        if (w.broken > 0.0) {
          // The white water starts at the pitching lip and pours down the face within a metre or so
          // of travel; on and behind the crest it is white at once.
          float level = shoreWaveHeight(w, hz) / max(w.amp, 1e-3);
          float poured = 1.0 - w.broken / 1.2;
          float cascade = d < 0.0 ? smoothstep(poured - 0.15, poured, level) : 1.0;
          float lead = w.front * 1.5 + 0.6 * (1.0 - smoothstep(0.0, 3.0, w.broken));
          float band = 1.2 + min(w.broken * 0.45, 4.5);
          // No white water seaward of where the lip fell (the break point is w.broken behind the front).
          float inside = 1.0 - smoothstep(w.broken + 0.5, w.broken + 2.0, d);
          float wd = smoothstep(-lead, -0.1, d) * exp(-max(d, 0.0) / band) * smoothstep(0.0, 1.0, w.broken) * cascade * linger * inside;
          if (wd > dens) { dens = wd; rel = d; }
          // Behind the roller the foam is left lying where the bore has passed, thinning over the ten
          // metres or so behind it.
          float behind = smoothstep(-0.3, 1.0, d) * (1.0 - smoothstep(w.broken - 1.0, w.broken + 1.0, d)) * exp(-max(d, 0.0) / (3.0 + 0.6 * min(w.broken, 12.0)));
          trail = max(trail, behind * smoothstep(0.5, 3.0, w.broken) * (w.swash < 0.0 ? 1.0 : exp(-w.swash / 4.0)));
          // The flare: as the lip pitches, the plankton in it lights the crest from end to end, a long
          // line of electric blue over the face and the falling lip, fading over a second and a half
          // or so as the bore gets going.
          float burst = smoothstep(0.0, 0.8, w.broken) * exp(-w.broken / 3.0) * linger;
          float lip = smoothstep(-lead - 0.3, -0.2 * w.front, d) * (1.0 - smoothstep(0.4, 1.6, d));
          surf += burst * lip * max(cascade, 0.6) * 2.2;
          // Then the bore glows from inside as it rolls in, strongest just after the break.
          surf += wd * (0.25 + 1.3 * exp(-w.broken / 3.0)) * mix(0.5, 1.0, exp(-max(d, 0.0) / 1.5));
          // The explosion: spray thrown up over the crest where the lip lands, rising and thinning
          // over a couple of seconds; seen over the upper face and against the water behind.
          float thrown = smoothstep(0.0, 0.8, w.broken) * (1.0 - smoothstep(1.5, 5.0, w.broken)) * linger;
          if (thrown > 0.0 && d > -0.8) {
            float yAt = SHORE_EYE - q * w.zc; // the ray's height as it passes over the crest
            float base = w.amp * 0.55;
            float crown = min(w.amp * (1.15 + 1.2 * smoothstep(0.0, 3.0, w.broken)), SHORE_EYE - 0.25);
            float hs = (yAt - base) / max(crown - base, 0.05); // 0 at the base .. 1 at the crown
            if (hs > -0.2 && hs < 1.4) {
              float sc = w.zc / (focal * uRes.y); // metres per cell at the crest
              vec2 pn = fbmLod(vec2(hx * 1.1 + w.seed * 9.0, yAt * 2.2 - tm * 0.9), 2.2 * sc, 4);
              float puff = smoothstep(-0.2, 0.05, hs) * (1.0 - smoothstep(0.3, 1.0, hs + (pn.x - 0.5) * 0.8)) * thrown;
              spray = max(spray, puff);
              surf += puff * (0.4 + 2.0 * burst);
            }
          }
        } else if (w.steep > 0.6) {
          // Just before the break the crest begins to spill: flecks of white, and of light.
          float atTop = (d + 0.15) / 0.45;
          float top = exp(-atTop * atTop) * smoothstep(0.6, 1.0, w.steep);
          float flecks = top * smoothstep(0.55, 0.85, vnoise(vec2(hx * 1.3 - tm * 0.6, w.seed * 19.0)));
          if (flecks * 0.6 > dens) { dens = flecks * 0.6; rel = d; }
          surf += flecks * 0.6;
        }
      }
      // The roller's churn, carried along with the front that made it; it travels with the bore, so
      // its finest features are held to twice the usual size.
      float churn = fbmLod(vec2(hx * 0.9 + world.wind * tm * 0.2, rel * 1.4 - tm * 0.25), max(cellX * 0.9, cellZ * 1.4) * 2.0, 4).x;
      float white = smoothstep(0.3, 0.55, dens + (churn - 0.5) * 0.8);
      // The foam left lying: patches drawn out along the crests, drifting in more slowly than the
      // bores, tearing into streaks as they age.
      float trailFoam = 0.0;
      if (trail > 0.01) {
        trailFoam = shoreFoamCover(fbmLod(vec2(hx * 0.45, (hz - surge + 0.6 * tm) * 1.4), max(cellX * 0.45, cellZ * 1.4), 4), trail);
        surf += trailFoam * 0.12;
      }

      // The swash: a rim of foam pushed ahead of the sheet, and behind it lace carried up and back
      // with the flow, thinning as the sheet slows and drains. Its edge draws a line of plankton
      // light up the sand on every run-up: a band of fixed width right behind the edge (15 cm, or two
      // cells), lit whole, then trailing off over the next metre. The band ends where the light
      // starts to fade, so even the fastest run-up changes a cell only a few frames apart: on as the
      // edge arrives, the rim gone as the band passes, the light stepping down well behind.
      float rim = 0.0;
      float lace = 0.0;
      if (topSwash >= 0.0 && edge < 6.0) {
        float young = exp(-topSwash / 2.0);
        float rising = 1.0 - smoothstep(0.3, 0.45, topSwash / shoreSwashTime(topRunup));
        float net = exp(-edge / (0.6 + 1.6 * young)) * (0.35 + 0.65 * young) * (1.0 - smoothstep(3.5, 5.5, edge));
        float band = max(0.15, 2.0 * cellZ);
        float front = edge < band ? 1.0 : 0.0;
        rim = front * (0.35 + 0.65 * young) * (0.7 + 0.3 * vnoise(vec2(hx * 1.3, e * 0.8)));
        // The sheet's texture rides up with seven tenths of the front's run, and back down with it,
        // fast enough that its finest features are held to four times the usual size.
        lace = shoreFoamCover(fbmLod(vec2(hx * 1.1, (e - 0.7 * reach) * 1.1), max(cellX, cellZ) * 4.4, 4), net) * 0.9;
        float rimGlow = front > 0.0 ? 1.0 : exp(-(edge - band) / max(0.8, 2.5 * cellZ));
        surf += rimGlow * mix(0.6, 1.5, rising) * (0.5 + 0.5 * young) + lace * young * 0.4;
      }
      // Foam and spray are there or not in each cell, so their edges pass a cell in one step.
      float foam = hardEdge(max(max(white, trailFoam), max(lace, rim)));
      // Moonlit white water: about 0.4 away from the moon, up to 0.8 in its path.
      vec3 foamCol = vec3(0.92, 0.95, 0.97) * (lit * 1.4 + sky.moonColor * 1.4 * moonOnFoam) * (0.85 + 0.3 * churn);
      // Spray is thin enough to glow with the light behind it.
      vec3 sprayCol = vec3(0.95, 0.97, 1.0) * (lit * 1.5 + sky.moonColor * 1.6 * moonOnFoam + moonLight * backMoon + sky.sunColor * 0.3 * backSun);
      col = mix(mix(sea, foamCol, foam), sprayCol, hardEdge(spray));
      // Rain on the water: ring crests catching the grey light, and where there is plankton every
      // drop that strikes lights a spark.
      col += ring * 0.25 * (mirror + air);
      surf *= 1.0 + 1.4 * shoreFlash();
      glow = surf * (0.55 + 0.7 * churn) + ring * 0.25;
#if WORLD_RAIN
      if (rain > 0.0) glow += shoreRainSparks(gp, tm, mix(0.03, 0.22, rain), SHORE_EYE * focal * uRes.y, th) * 0.8;
#endif

      // Lightning mirrored in the sea near the horizon, broken up by the ripples.
      if (world.boltAge < 1.5 && SHORE_HORIZON - uv.y < 0.15) {
        vec2 mp = vec2(sp.x + n.x * 0.12, 2.0 * (SHORE_HORIZON - 0.5) - sp.y);
        col += vec3(0.7, 0.72, 0.95) * min(lightningBolt(mp, boltTop, boltFoot, world.boltSeed, world.boltAge), 1.5) * fres * 0.8;
      }
    } else {
      // Sand: dry above the swash's usual reach, darker where wet, and a mirror while a film of
      // water drains off it. Rain soaks the whole beach as it goes on (uWeather.x): it darkens and
      // takes a glaze of water that mirrors the lighter cloud low over the sea (and the hidden moon's
      // glow, and near the water the plankton's light), brighter the more the view grazes it;
      // puddles gather in its hollows, drops ring in them and splash all over the near beach. Snow
      // lies on the dry sand (uWeather.y); the swash and the soaked sand melt it.
      float usual = 0.9 + 1.3 * size;
      float soaked = 1.0 - smoothstep(0.4, 1.0, e0 / usual);
      wet = max(soaked * 0.55, exp(-drained / 6.0));
      // Dry sand: soft wind ripples that bend, wander and change their spacing, shaded a little by
      // the moon or sun when it is low over the sea in front, and faded out before they get finer
      // than a few cells.
      vec3 key = sky.sun.y > 0.0 ? sky.sun : sky.moon;
      float side = clamp(key.z / max(key.y, 0.1), 0.0, 3.0) / 3.0;
      vec2 bend = vec2(vnoise(g * vec2(0.55, 0.4)), vnoise(g * vec2(0.55, 0.4) + 4.1)) - 0.5;
      float rp = (hz + 0.5 * bend.x + 0.22 * sin(hx * 1.6 + 3.0 * bend.y)) / 0.5 + 1.4 * vnoise(g * vec2(0.3, 0.22) + 9.0);
      float ripple = cos(TAU * rp) * smoothstep(5.0, 10.0, 0.5 / cellZ) * (1.0 - wet);
      float tone = vnoise(g * vec2(0.7, 0.4));
      vec3 dry = wetten(vec3(0.76, 0.67, 0.5) * (0.95 + 0.08 * tone) * (1.0 - 0.14 * ripple * (0.4 + 0.6 * side)), rained, 1.0);
      dry = mix(dry, SHORE_SNOW, uWeather.y);
      vec3 damp = vec3(0.34, 0.28, 0.21) * (0.95 + 0.1 * tone);
      vec3 sand = mix(mix(dry, damp, wet), damp * 0.7, puddle) * lit;
      // The thin lines of foam the last swashes left at the top of their run.
      sand = mix(sand, vec3(0.8, 0.8, 0.78) * lit, strand * 0.3);
      // By moonlight the sand loses its warmth to the eye and goes a dim, cool grey-blue.
      sand = greyed(sand, vec3(0.78, 0.88, 1.12), 0.65 * dark) * mix(1.0, 0.62, dark);

      // By day damp sand keeps a soft sheen of the bright sky; by night only the glossy band shows.
      float soak = wet * mix(1.0, 0.2, dark);
      float wetShare = soak * 0.3 + gloss * 0.9;
      vec3 shine = (moonHue * waterGlint(n, view, sky.moon, rough, SHORE_MOON_GLINT * moonShine * (1.0 - SHORE_TAIL)) + sunHue * waterGlint(n, view, sky.sun, rough, SHORE_SUN_GLINT * sunShine)) * wetShare;
      col = mix(sand, mirror, clamp(fres * (soak * 0.7 + gloss * 1.4), 0.0, 1.0)) + shine;
      // The rain's glaze: the film on soaked sand is rough enough to blur the sky it mirrors down
      // toward the horizon, where the cloud is lighter; it shines more where the view grazes it, so
      // it brightens toward the water, and the puddles mirror most. Within a metre or two of the
      // waterline it carries the blue of the surf's plankton light, most just after a wave runs up.
      if (rained > 0.0) {
        vec3 wetSky = shoreDome(skyM, cloud, normalize(vec3(refl.x, refl.y * 0.35, refl.z))) + vec3(0.1, 0.11, 0.16) * flash;
        float spill = exp(-max(e - reach, 0.0) / 1.5) * (0.4 + 0.6 * exp(-max(topSwash, 0.0) / 3.0));
        wetSky += SHORE_BIO * bio * spill * 0.12;
        float glaze = max(wetGloss(rained, n.y) * (0.15 + 0.85 * (1.0 - cv) * (1.0 - cv)), puddle * 0.8);
        col = mix(col, wetSky, glaze);
      }
      col += ring * 0.3 * (mirror + air) * pool;
      // The line of light each swash leaves at the top of its run.
      glow += strandGlow * 1.4;
      // Bubbles bursting in the foam the backwash leaves behind.
      if (K_sparkles > 0.0) {
        glow += shoreSparks(g, tm, K_sparkles * 0.9) * exp(-drained / 4.0) * 1.3;
      }
      // Drawing back out to sea (the exit): the sand the water has just left, behind its edge, is
      // alive with bursting bubbles of stranded plankton.
      if (surge > 0.0 && passageOut() > 0.0 && K_sparkles > 0.0) {
        glow += shoreSparks(g, tm, K_sparkles * 0.9) * exp(-max(e, 0.0) / 1.5) * smoothstep(0.0, 0.2, passageOut()) * 1.3;
      }
      glow += ring * 0.4 * film;
      // Drops splashing: crowns of 3-6 cm, brightest on wet, packed sand and in the puddles (dry
      // sand swallows them), and lit blue where the backwash has just left plankton stranded. Their
      // units are 40 cm across and 90 cm along z, which perspective squashes, so a crown is a few
      // cells across; they show on the near beach only, gone before a unit spans fewer than ~15
      // cells.
#if WORLD_RAIN
      if (rain > 0.0) {
        vec2 sq = vec2(2.5, 1.1);
        float fine = 1.0 - smoothstep(0.04, 0.067, max(cellX * sq.x, cellZ * sq.y));
        if (fine > 0.0) {
          float splash = rainSplashes(g * sq, uFallTime, rain * 0.6) * fine * mix(0.35, 1.0, max(max(wet, rained), pool));
          col += splash * (air * 1.6 + lit * 0.5);
          glow += splash * exp(-drained / 5.0);
        }
      }
#endif
    }

    // The pointer's wake: swirls of a ridged noise warped by a slowly turning flow. A fresh stir
    // glows solid; an older one breaks into filaments as it fades. Only where there is plankton:
    // in the water, and stranded on wet sand.
    if (K_stir > 0.5 && uSimOn.x > 0.5) {
      float trail = textureLod(uSim0, screenUv, 0.0).r;
      if (trail > 0.004) {
        vec2 s = vec2(screenUv.x * aspect, screenUv.y * 2.2) * 7.0;
        vec2 warp = s + 1.6 * vec2(vnoise(s * 0.5 + vec2(tm * 0.3, 3.1)), vnoise(s * 0.5 + vec2(7.7, -tm * 0.27)));
        float ridge = 1.0 - abs(2.0 * vnoise(warp * 1.8) - 1.0);
        float stir = trail * mix(smoothstep(0.6, 0.92, ridge), 1.0, smoothstep(0.4, 0.95, trail));
        glow += stir * 1.2 * (water ? 1.0 : clamp(wet * 1.5, 0.0, 1.0));
      }
    }

    // Fish: from the "now" button, or now and then on their own.
    float fishAge = sinceTrigger(0);
    float fishSeed = hash12(vec2(uTriggers[0], 5.1));
    if (K_fish > 0.0) {
      float every = mix(70.0, 18.0, K_fish);
      float slot = floor(tm / every);
      float age = tm - (slot + 0.1 + 0.5 * hash12(vec2(slot, 41.0))) * every;
      if (age >= 0.0 && age < fishAge && hash12(vec2(slot, 43.0)) < 0.85) {
        fishAge = age;
        fishSeed = hash12(vec2(slot, 42.0));
      }
    }
    if (water && fishAge < 9.0) {
      float fishBody = 0.0;
      float halfSpan = aspect * 0.5 * (SHORE_LINE + 3.0) / focal;
      float wake = shoreFish(g, fishAge, fishSeed, camX, halfSpan, cellZ, fishBody);
      glow += wake * 1.1 + fishBody * 0.8;
      // Glowing darts at night; dark slips under the surface by day.
      col *= 1.0 - 0.45 * fishBody * (1.0 - dark);
    }

    // The M in the sand: a groove holding water that mirrors the sky. Each wave that washes over
    // it fills it with lit plankton, glowing while it is covered and fading after.
    if (K_mark > 0.5) {
      vec2 mq = (g - SHORE_MARK) / SHORE_MARK_SIZE;
      float fp = max(cellX / SHORE_MARK_SIZE.x, cellZ / SHORE_MARK_SIZE.y);
      float groove = 1.0 - smoothstep(0.05 - fp, 0.05 + fp, markDistance(mq));
      col = mix(col * (1.0 - 0.35 * groove), mirror * 0.8, groove * max(wet, uWeather.x) * 0.35);
      mark = groove * (water ? 1.0 : exp(-drained / 3.5)) * mix(0.55, 1.0, dark);
    }
#if SHORE_CAIRNS
    // The agents' cairns stand in front of the sand and the swash round them.
    if (uSimOn.y > 0.5) {
      float stoneZ = zHit;
      vec4 stone = shoreStone(camX, slopeX, q, focal, stoneZ);
      if (stone.x > 0.0) {
        col = mix(col, shoreStoneColour(stone, sky.ambient, sunLight + moonLight), stone.x);
        glow *= 1.0 - stone.x;
        mark *= 1.0 - stone.x;
        zHit = stoneZ;
      }
    }
#endif
  }

#if SHORE_CAIRNS
  // The pebbles the agents carry, over the picture.
  if (uSimOn.y > 0.5) {
    vec4 held = shoreHeld(cell);
    if (held.x > 0.0) {
      col = mix(col, shoreStoneColour(held, sky.ambient, sunLight + moonLight), held.x);
      glow *= 1.0 - held.x;
    }
  }
#endif

  // The world in front of the beach, at the depth of what this pixel sees: its gulls, where one is
  // nearer than the sea or the sand (a gull skimming the water dips behind a breaker nearer than
  // it), hazed into the mist low over the sea; then its fog, which hugs the sea and closes in on
  // the horizon; then its rain and snow, falling only in front of what they would land on, the
  // drops catching the grey light and the lightning, and the farther rain fusing into a veil. The
  // drops are thinned (0.55, 0.35 for the near ones) so they never bury the surf; the plankton's
  // light, laid on after, shines on over them. Each veils that light and the M (clear).
  float clear = 1.0;
  worldBirds(world, camera, SHORE_FLYWAY, mist, SHORE_BIRD_HAZE, col, zHit, clear);
  worldFog(world, camera, mist, zHit, col, clear);
  worldPrecipThinned(world, camera, air, dropLight, zHit, vec2(0.55, 0.35), col, clear);
  glow *= clear;
  mark *= clear;

  // Ink is the picture's light without the plankton; the plankton and the M are the accent, each
  // snapped per cell to off, half or full (shoreStep). In full colour their light is a colour of its
  // own: where it is strong it outshines the foam it is in, so the surf reads electric blue rather
  // than washing out to white or teal. A sunlit beach puts the page in its paper theme (index.ts),
  // where inkOf turns the ink dark on a light ground.
  float light = shoreStep(glow * bio, thG);
  mark = shoreStep(mark, thG);
  Shade o = shadeOf(col, inkOf(col, 1.3, 0.8), max(light, mark));
  float hot = light + mark;
  col = mix(col, SHORE_BIO * 1.1, smoothstep(0.15, 1.2, hot) * 0.55) + SHORE_BIO * hot * 0.8;
  o.rgb = col;
  o.source = col;
  return o;
}
`;
