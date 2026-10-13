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
//
// Rain belongs to the beach's weather, not to the glass in front of it. It comes out of an overcast
// that closes over the stars, the moon and the sun with the amount (a thin, broken haze in a
// drizzle, whole from steady rain on), which dims their light so the beach is lit flat from the grey
// above; heavier rain lowers and darkens the cloud, and hangs shafts of rain under it far out at
// sea. Drops fall only in front of the sand, surf or sea they would land on (rainFall's depth), and
// the farther rain fuses into a grey veil that closes in on the horizon. On the water the drops
// dimple the surface and, where there is plankton, each strike lights a spark; on the sand they
// splash, and the beach soaks through as it goes on raining (uWeather.x: darker, with a sheen and
// puddles in its hollows) and dries slowly after.
//
// Knobs: K_size, K_period (surf); K_glow, K_sparkles, K_stir, K_fish (bioluminescence; fish fire
// on trigger 0); K_time, K_cycle (sky); K_rain, K_fog, K_wind, K_lightning (weather; lightning on
// trigger 1); K_mark (the M in the sand). uWeather.x: how wet the beach is from the rain.

export const shoreGlsl = `
const float SHORE_HORIZON = 0.6;  // screen height of the horizon
const float SHORE_FOV = 0.7;      // vertical field of view (rad): a long lens stacks up the surf
const float SHORE_EYE = 1.8;      // eye height above still water
const float SHORE_LINE = 9.0;     // the still-water line, metres ahead
const float SHORE_FAR = 72.0;     // where each swell line comes into view
const float SHORE_TRAVEL = 22.0;  // seconds from SHORE_FAR to the still-water line
const int SHORE_WAVES = 9;        // waves tracked at once, from new swell to drained backwash
// The beach faces 29 degrees further round than the sky library's view, toward moonrise: at the
// default hour (K_time 0.82) the moon stands 6 degrees up a little right of ahead with its path
// lying across the breakers, and at dawn the sun comes up at the right edge of the frame.
const float SHORE_FACING = 0.506;
const vec2 SHORE_MARK = vec2(2.0, 7.5);       // the M's centre on the sand (x, z)
const vec2 SHORE_MARK_SIZE = vec2(1.3, 3.0);  // drawn long, like road lettering, so it reads from here
const vec3 SHORE_BIO = vec3(0.16, 0.9, 1.0);  // Noctiluca blue

// The sky library's sun or moon direction, turned about the vertical by SHORE_FACING.
vec3 shoreTurn(vec3 v) {
  float c = cos(SHORE_FACING);
  float s = sin(SHORE_FACING);
  return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
}

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

// Wind ripples as a few travelling trains with deep-water dispersion (omega^2 = g k). Returns the
// slope (dh/dx, dh/dz) of the trains these cells resolve and, in z, the slope variance of the ones
// too fine to draw, which the glitter takes as roughness instead (as LEAN mapping does, Olano &
// Baker 2010). A train is only drawn once its wavelength spans a dozen cells across its crests:
// finer ones would sweep over the dither as flickering stripes. Their slopes stay small beside the
// glitter's own roughness, so they ruffle the moon's path rather than chop it into flashing bands.
// wind scales the slopes.
vec3 shoreRipples(vec2 p, float tm, vec2 cellSize, float wind) {
  vec2 slope = vec2(0.0);
  float hidden = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float wavelength = 3.2 * pow(0.55, fi);
    float a = 1.7 + fi * 2.4; // golden-angle spread of directions
    vec2 along = vec2(sin(a), cos(a));
    float k = TAU / wavelength;
    float s = (0.025 - 0.003 * fi) * wind; // steepest slope of this train
    float cells = wavelength / max(length(along * cellSize), 1e-6);
    float seen = smoothstep(8.0, 16.0, cells);
    float phase = k * dot(along, p) - sqrt(9.81 * k) * tm + fi * 1.7;
    slope += along * cos(phase) * s * seen;
    hidden += 0.5 * s * s * (1.0 - seen);
  }
  return vec3(slope, hidden);
}

// Moon or sun glitter: the share of surface facets tilted to mirror the light into the eye, for
// facet slopes spread with variance s2 (a Beckmann distribution, after Cox & Munk's 1954 sea-slope
// measurements). Normalised to 1 at the heart of the path, so a choppy sea draws a wider path
// rather than a dimmer one, and the path never burns out into a solid block.
float shoreGlitter(vec3 n, vec3 view, vec3 light, float s2) {
  if (light.y <= 0.0) return 0.0;
  vec3 h = normalize(view + light);
  float c = max(dot(n, h), 1e-3);
  float tan2 = (1.0 - c * c) / (c * c);
  return exp(-tan2 / s2);
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

// Foam texture: value noise in four octaves, each faded to its mean before its features shrink
// below a few cells (cell: one cell's size in texture units; callers whose texture travels fast
// pass it scaled up), so moving foam never crawls through the dither. Returns the noise (0..1,
// mean 0.5) and how much of its detail survives (1 up close, 0 where it is all finer than a cell).
vec2 shoreFoamNoise(vec2 p, vec2 cell) {
  float c = max(cell.x, cell.y);
  float s = 0.0;
  float kept = 0.0;
  float a = 0.5;
  float f = 1.0;
  for (int i = 0; i < 4; i++) {
    float keep = 1.0 - smoothstep(0.25, 0.5, c * f);
    s += a * (keep > 0.0 ? mix(0.5, vnoise(p * f + float(i) * vec2(17.1, 9.2)), keep) : 0.5);
    kept += a * keep;
    f *= 2.03;
    a *= 0.5;
  }
  return vec2(s, kept) / 0.9375;
}

// How much of the surface a foam texture covers for a given amount of foam (0..1): patches with
// holes when there is plenty, a few torn streaks as it thins. Where the cells no longer resolve the
// texture the edges soften into its mean cover instead of snapping on and off.
float shoreFoamCover(vec2 noise, float amount) {
  float th = 0.8 - 0.35 * amount;
  float w = mix(0.3, 0.05, noise.y);
  return smoothstep(th - w, th + w, noise.x) * smoothstep(0.0, 0.15, amount);
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

// The underside of the rain's cloud: as grey as the light coming through it (dim by night), a
// little lighter toward the horizon, brighter where the hidden moon or sun stands behind it, and
// darker the heavier the rain.
vec3 shoreGrey(Sky sky, vec3 dir, float heavy) {
  float h = max(dir.y, 0.0);
  float base = dot(sky.ambient, LUMA) * mix(0.5, 1.0, sky.day) * (0.7 + 0.5 * exp(-h * 6.0));
  vec3 mv = dir - sky.moon;
  vec3 sv = dir - sky.sun;
  vec3 c = vec3(0.9, 0.96, 1.08) * base + sky.moonColor * 0.6 * exp(-dot(mv, mv) * 4.0) + sky.sunColor * 0.5 * exp(-dot(sv, sv) * 4.0);
  return c * mix(1.0, 0.75, heavy);
}

// The sky as the mirrors and the air see it: the clear sky under as much of the rain's grey as it
// is overcast.
vec3 shoreDome(Sky sky, vec3 dir, float overcast, float heavy) {
  vec3 c = skyColor(sky, dir);
  return overcast > 0.0 ? mix(c, shoreGrey(sky, dir, heavy), overcast) : c;
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

// The rain's sky over the clear one (col): a grey haze closing over it with the amount, then the
// underside of a cloud deck, broken in a drizzle and whole in steady rain, lower (so larger) and
// darker the heavier it rains. Out at sea, under the cloud base, a thin light gap along the horizon
// and rain shafts hanging in front of it, lit up by the lightning. az, el: the view direction's x
// and y over z.
vec3 shoreRainSky(vec3 col, Sky sky, vec3 dir, float az, float el, float t, float rain, float overcast, float heavy, float wind, float flash) {
  vec3 clear = col;
  vec3 grey = shoreGrey(sky, dir, heavy);
  col = mix(col, grey, overcast);
  float low = mix(1.0, 0.55, heavy);
  vec4 deck = skyClouds(sky, normalize(vec3(dir.x * low, dir.y, dir.z * low)), t, mix(0.45, 1.0, sqrt(smoothstep(0.0, 0.4, rain))), wind);
  col = mix(col, deck.rgb * mix(0.5, 1.0, sky.day) * mix(0.9, 0.6, heavy), deck.a * smoothstep(0.0, 0.05, rain));
  float gap = exp(-el / 0.03) * (1.0 - 0.85 * heavy) * smoothstep(0.15, 0.4, rain);
  col = mix(col, grey * 1.25 + clear * 0.3, gap * 0.8);
  float shaft = shoreShafts(az, el, mix(0.1, 0.055, heavy), t * uMotion, rain, wind);
  return mix(col, grey * 0.6 + vec3(0.3, 0.32, 0.45) * flash, shaft * 0.8);
}

// Raindrops striking the sea: where there is plankton each one lights a pinpoint of blue, swelling
// over a fifth of a second or so and fading over the next second, before the next drop lands
// somewhere else in the cell. As for the glints the grid is fixed to the water in perspective (gp),
// cells 8 x 5 dither cells, so a spark is never thinner than two. density 0..1 is the share of cells
// struck. Returns 0..1.
float shoreRainSparks(vec2 gp, float tm, float density) {
  vec2 g = gp / vec2(8.0, 5.0);
  vec2 id = floor(g);
  float h = hash12(id + 23.7);
  float age = tm * (0.5 + 0.4 * h) + fract(h * 5.31);
  float turn = floor(age);
  vec2 seed = id + turn * vec2(0.91, 1.73);
  if (hash12(seed + 7.7) > density) return 0.0;
  vec2 at = 0.3 + 0.4 * vec2(hash12(seed + 1.3), hash12(seed + 4.1));
  vec2 r = (fract(g) - at) * vec2(8.0 / 1.8, 5.0 / 1.1); // in spark radii: 1.8 x 1.1 cells
  float phase = age - turn;
  float env = smoothstep(0.0, 0.15, phase) * (1.0 - smoothstep(0.15, 0.7, phase));
  return env * (1.0 - smoothstep(0.3, 1.0, dot(r, r)));
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

Shade sceneShore(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  float focal = 0.5 / tan(SHORE_FOV * 0.5);
  vec3 dir = viewRay(uv, aspect, SHORE_HORIZON, SHORE_FOV);
  vec3 view = -dir;
  vec2 sp = (uv - 0.5) * vec2(aspect, 1.0); // screen-height units, for the lightning

  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  sky.sun = shoreTurn(sky.sun);
  sky.moon = shoreTurn(sky.moon);
  // Rain comes out of an overcast sky: the cloud closes over with the amount, hiding the stars, the
  // moon and the sun, so their direct light dims and the beach is lit flat by the grey above;
  // heavier rain darkens it further.
  float rain = K_rain;
  float overcast = sqrt(smoothstep(0.0, 0.5, rain));
  float heavy = smoothstep(0.3, 1.0, rain);
  sky.sunColor *= 1.0 - 0.85 * overcast;
  sky.moonColor *= 1.0 - 0.85 * overcast;
  sky.ambient *= 1.0 - 0.3 * heavy;
  // For mirrors (the sea, the wet sand, fog): the same sky with the moon swung round behind the
  // viewer, so no reflection shows a broken sliver of its disc. The moon on the water is the
  // glitter's alone.
  Sky skyM = sky;
  skyM.moon = vec3(-sky.moon.x, sky.moon.y, -sky.moon.z);
  // The plankton only shows in the dark: full at night, fading through dawn, gone by day.
  float dark = 1.0 - smoothstep(0.05, 0.5, sky.day);
  float bio = K_glow * 1.5 * dark;
  float boltSeed = 0.0;
  float boltAge = lightningAge(t, K_lightning, 1, boltSeed);
  float flash = lightningFlash(boltAge);
  // The storm stands out to sea right of ahead; each bolt drops from its cloud base to the water.
  float boltAz = 0.3 + (fract(boltSeed * 7.31) - 0.5) * 0.4;
  vec2 boltTop = vec2(boltAz * focal, SHORE_HORIZON - 0.5 + 0.085);
  vec2 boltFoot = vec2(boltTop.x + (fract(boltSeed * 3.17) - 0.5) * 0.06, SHORE_HORIZON - 0.5);
  // The bank stands while lightning is on; a strike fired with lightning off brings it only briefly.
  float storm = K_lightning > 0.0 ? 1.0 : 1.0 - smoothstep(1.0, 3.0, boltAge);
  // Light on a level surface. Moonlight is played up the lower the moon stands, so foam and sand
  // keep their shape under a moon near the horizon.
  vec3 moonLight = sky.moonColor * (0.3 + 0.6 * sqrt(max(sky.moon.y, 0.0)));
  vec3 lit = sky.ambient + sky.sunColor * max(sky.sun.y, 0.0) + moonLight + vec3(0.3, 0.33, 0.42) * flash;
  // How far the moon or the sun stands out over the sea ahead: then it shines through thin crests
  // and spray.
  float backMoon = max(sky.moon.z, 0.0);
  float backSun = 0.5 + 0.5 * max(sky.sun.z, 0.0);
  // The rain's air: the grey it fades into with distance, lit up by the lightning.
  vec3 air = shoreGrey(sky, normalize(vec3(dir.x, 0.0, dir.z)), heavy) * 1.1 + vec3(0.12, 0.13, 0.18) * flash;

  vec3 col = vec3(0.0);
  float glow = 0.0;    // plankton light, before the strength knob and the dark
  float mark = 0.0;    // the M's own glow, independent of the plankton knob
  float airDepth = 1.0; // how far this pixel sees, for the rain: 0 at the eye .. 1 the open sky

  if (dir.y >= 0.0) {
    float az = dir.x / dir.z;
    float el = dir.y / dir.z;
    col = skyColor(sky, dir) + vec3(0.85, 0.9, 1.0) * skyStars(sky, dir, 0.6);
    if (rain > 0.0) col = shoreRainSky(col, sky, dir, az, el, t, rain, overcast, heavy, K_wind, flash);
    if (storm > 0.0) {
      float bank = shoreStormBank(az, el, tm * 0.004 * K_wind) * storm;
      float inside = flash * exp(-abs(az - boltAz) * 3.0) * (0.5 + fbm(vec2(az * 9.0, el * 40.0)));
      col = mix(col, sky.ambient * 0.6 + vec3(0.5, 0.55, 0.8) * inside, bank * 0.92);
    }
    float bolt = boltAge < 1.5 ? lightningBolt(sp, boltTop, boltFoot, boltSeed, boltAge) : 0.0;
    col += mix(vec3(0.55, 0.45, 1.0), vec3(1.0), smoothstep(0.45, 0.75, bolt)) * min(bolt, 1.5);
    col += vec3(0.1, 0.11, 0.16) * flash * exp(-el * 6.0);
    if (K_fog > 0.0) col = mix(col, shoreDome(skyM, normalize(vec3(dir.x, 0.03, dir.z)), overcast, heavy), fogAmount(K_fog, 1.0, clamp(el * 5.0, 0.0, 1.0)));
  } else {
    float q = -dir.y / dir.z; // tangent of the angle below the horizon
    float slopeX = dir.x / dir.z;
    float camX = uPointer.x * 0.35 * m; // a step along the beach with the pointer
    float zPlane = min(SHORE_EYE / q, 4000.0);
    float size = mix(0.35, 1.5, K_size);
    float kNow = floor(tm / K_period);

    // Oldest first, which is nearest the beach first.
    ShoreWave waves[SHORE_WAVES];
    for (int i = 0; i < SHORE_WAVES; i++) {
      waves[i] = shoreWave(kNow - float(SHORE_WAVES - 1 - i), camX, slopeX, tm, K_period, size);
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
    airDepth = 1.0 - exp(-hz / 30.0);
    vec2 g = vec2(hx, hz);
    // Ground covered by one cell, depthwise and across: for antialiasing and level of detail.
    float cellZ = hz * hz / (SHORE_EYE * focal * uRes.y);
    float cellX = hz / (focal * uRes.y);
    float e = SHORE_LINE - hz; // metres up the beach from the still-water line

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

    // Rain: rings where the drops land on the water and in standing water on the sand, small and
    // few in a drizzle, larger and crowding in a downpour; stretched along z so they survive
    // perspective, and faded out where a ring would shrink below a few cells.
    vec3 drops = vec3(0.0);
    if (rain > 0.0) {
      vec2 rs = vec2(5.0, 2.0) * mix(1.4, 0.9, heavy);
      float fade = 1.0 - smoothstep(0.08, 0.25, max(cellX * rs.x, cellZ * rs.y));
      drops = rainRipples(g * rs, t, min(rain * 1.3, 1.0)) * fade;
    }

    vec3 mirror = vec3(0.0);
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
      float windy = 0.6 + 0.9 * abs(K_wind);
      vec3 rip = shoreRipples(g, tm, vec2(cellX, cellZ), windy);
      vec2 tilt = rip.xy * choppy + drops.xy * 0.5;
      vec3 n = normalize(vec3(-tilt.x, 1.0, -(slopeZ + tilt.y)));
      // Facets too fine to draw still lean toward the eye: at a grazing view the sea mirrors sky
      // from higher up, and less of it, so it stays darker than the sky at the horizon.
      // Rain roughens it too, and a downpour beats it matte.
      float rough = 0.002 + 0.0015 * windy + rip.z * choppy + 0.003 * rain + 0.012 * heavy;
      float spread = sqrt(rough);
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), spread * 0.8), 5.0);
      vec3 refl = reflect(dir, n);
      mirror = shoreDome(skyM, normalize(vec3(refl.x, max(refl.y, 0.0) + spread * 1.5, refl.z)), overcast, heavy) + vec3(0.1, 0.11, 0.16) * flash;
      // The moon's path on the water (the sun's by day), broken by the swell into rows, and glints
      // in it: single facets catching the light for a moment. Around it a wide moonlit sheen, the
      // tail of the same glitter on a rougher scale: it lights the backs and troughs of the swell
      // well out to either side and leaves the faces turned to the viewer dark, so every row reads.
      float moonPath = shoreGlitter(n, view, sky.moon, rough);
      float sunPath = shoreGlitter(n, view, sky.sun, rough);
      vec2 gp = vec2(hx, SHORE_EYE) / hz * focal * uRes.y; // dither cells, fixed to the water
      float glint = shoreGlints(gp, tm);
      float sheen = shoreGlitter(n, view, sky.moon, 0.03);
      vec3 shine = sky.moonColor * (moonPath * (1.8 + 4.0 * glint) + sheen * 0.35) + sky.sunColor * sunPath * (0.8 + 2.0 * glint);
      // How strongly the moon lights rough white water here: brightest along its path.
      float moonOnFoam = shoreGlitter(vec3(0.0, 1.0, 0.0), view, sky.moon, 0.03);

      // Water: dark blue offshore, turquoise over the sand in the shallows (muted at night), the
      // sand itself showing through the thin sheet of the swash.
      float shallow = (1.0 - smoothstep(SHORE_LINE, SHORE_LINE + 14.0, hz)) * mix(0.35, 1.0, sky.day);
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
        sea = mix(sea, crestCol, crest * mix(0.85, 0.35, sky.day));
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
              vec2 pn = shoreFoamNoise(vec2(hx * 1.1 + w.seed * 9.0, yAt * 2.2 - tm * 0.9), vec2(1.1, 2.2) * sc);
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
      float churn = shoreFoamNoise(vec2(hx * 0.9 + K_wind * tm * 0.2, rel * 1.4 - tm * 0.25), vec2(cellX * 0.9, cellZ * 1.4) * 2.0).x;
      float white = smoothstep(0.3, 0.55, dens + (churn - 0.5) * 0.8);
      // The foam left lying: patches drawn out along the crests, drifting in more slowly than the
      // bores, tearing into streaks as they age.
      float trailFoam = 0.0;
      if (trail > 0.01) {
        trailFoam = shoreFoamCover(shoreFoamNoise(vec2(hx * 0.45, (hz + 0.6 * tm) * 1.4), vec2(cellX * 0.45, cellZ * 1.4)), trail);
        surf += trailFoam * 0.12;
      }

      // The swash: a rim of foam pushed ahead of the sheet, and behind it lace carried up and back
      // with the flow, thinning as the sheet slows and drains. Its edge draws a line of plankton
      // light up the sand on every run-up: sharp at the front, trailing off behind it.
      float rim = 0.0;
      float lace = 0.0;
      if (topSwash >= 0.0 && edge < 6.0) {
        float young = exp(-topSwash / 2.0);
        float rising = 1.0 - smoothstep(0.3, 0.45, topSwash / shoreSwashTime(topRunup));
        float net = exp(-edge / (0.6 + 1.6 * young)) * (0.35 + 0.65 * young) * (1.0 - smoothstep(3.5, 5.5, edge));
        rim = exp(-edge / max(0.14, 1.5 * cellZ)) * (0.35 + 0.65 * young) * (0.7 + 0.3 * vnoise(vec2(hx * 1.3, e * 0.8)));
        // The sheet's texture rides up with seven tenths of the front's run, and back down with it.
        lace = shoreFoamCover(shoreFoamNoise(vec2(hx * 1.1, (e - 0.7 * reach) * 1.1), vec2(cellX, cellZ) * 2.2), net) * 0.9;
        float rimGlow = exp(-edge / max(0.3, 2.5 * cellZ));
        surf += rimGlow * mix(0.6, 1.5, rising) * (0.5 + 0.5 * young) + lace * young * 0.4;
      }
      float foam = clamp(max(max(white, trailFoam), max(lace, rim)), 0.0, 1.0);
      // Moonlit white water: about 0.4 away from the moon, up to 0.8 in its path.
      vec3 foamCol = vec3(0.92, 0.95, 0.97) * (lit * 1.4 + sky.moonColor * 1.4 * moonOnFoam) * (0.85 + 0.3 * churn);
      // Spray is thin enough to glow with the light behind it.
      vec3 sprayCol = vec3(0.95, 0.97, 1.0) * (lit * 1.5 + sky.moonColor * 1.6 * moonOnFoam + moonLight * backMoon + sky.sunColor * 0.3 * backSun);
      col = mix(mix(sea, foamCol, foam), sprayCol, clamp(spray, 0.0, 1.0));
      // Rain on the water: ring crests catching the grey light, and where there is plankton every
      // drop that strikes lights a spark, thinning out to sea.
      col += drops.z * 0.3 * (mirror + air);
      glow = surf * (0.55 + 0.7 * churn) + drops.z * 0.3;
      if (rain > 0.0) glow += shoreRainSparks(gp, tm, mix(0.06, 0.6, rain)) * 0.8 * (1.0 - smoothstep(40.0, 160.0, hz));

      // Lightning mirrored in the sea near the horizon, broken up by the ripples.
      if (boltAge < 1.5 && SHORE_HORIZON - uv.y < 0.15) {
        vec2 mp = vec2(sp.x + n.x * 0.12, 2.0 * (SHORE_HORIZON - 0.5) - sp.y);
        col += vec3(0.7, 0.72, 0.95) * min(lightningBolt(mp, boltTop, boltFoot, boltSeed, boltAge), 1.5) * fres * 0.8;
      }
    } else {
      // Sand: dry above the swash's usual reach, darker where wet, and a mirror while a film of
      // water drains off it. Rain soaks the whole beach as it goes on (uWeather.x), darkening it and
      // giving it a soft sheen, and gathers in its hollows as puddles that mirror the sky as the
      // swash's film does; drops ring and splash wherever water stands.
      float usual = 0.9 + 1.3 * size;
      float soaked = 1.0 - smoothstep(0.4, 1.0, e / usual);
      float film = exp(-drained / 2.5);
      wet = max(soaked * 0.55, exp(-drained / 6.0));
      float rained = uWeather.x;
      float puddle = rained > 0.0 ? rainPuddles(g * 1.4, rained) : 0.0;
      float pool = max(film, puddle); // standing water
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
      vec3 damp = vec3(0.34, 0.28, 0.21) * (0.95 + 0.1 * tone);
      vec3 sand = mix(mix(dry, damp, wet), damp * 0.7, puddle) * lit;
      // The thin lines of foam the last swashes left at the top of their run.
      sand = mix(sand, vec3(0.8, 0.8, 0.78) * lit, strand * 0.3);
      // By moonlight the sand loses its warmth to the eye and goes a dim, cool grey-blue.
      sand = mix(sand, vec3(dot(sand, LUMA)) * vec3(0.78, 0.88, 1.12), 0.65 * dark) * mix(1.0, 0.62, dark);

      // Only the band the backwash has just left, the saturated sand right at the water's edge and
      // the rain's puddles are wet enough to mirror: sharp while a film drains off it, dull again
      // as it soaks in. Rain-soaked sand keeps a softer sheen. Gentle undulations draw the moon out
      // into a streak.
      float gloss = max(max(film, 0.6 * (1.0 - smoothstep(0.2, 1.0, e))), puddle);
      vec2 swell = vec2(vnoise(g * vec2(1.2, 0.6)), vnoise(g * vec2(1.2, 0.6) + 7.3)) - 0.5;
      vec2 tilt = swell * 0.05 + drops.xy * 0.4 * pool;
      vec3 n = normalize(vec3(-tilt.x, 1.0, -tilt.y));
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
      vec3 refl = reflect(dir, n);
      refl = normalize(vec3(refl.x, max(refl.y, 0.01), refl.z));
      mirror = shoreDome(skyM, refl, overcast, heavy) + vec3(0.9, 0.95, 1.0) * skyStars(sky, refl, 0.6) * gloss * (1.0 - overcast) + vec3(0.1, 0.11, 0.16) * flash;
      float rough = 0.002 + 0.012 * (1.0 - gloss);
      // By day damp sand keeps a soft sheen of the bright sky; by night only the glossy band shows.
      float soak = wet * mix(1.0, 0.2, dark);
      float sheen = wetGloss(rained, n.y);
      vec3 shine = (sky.moonColor * shoreGlitter(n, view, sky.moon, rough) * 1.6 + sky.sunColor * shoreGlitter(n, view, sky.sun, rough) * 0.8) * (soak * 0.3 + gloss * 0.9 + sheen * 0.5);
      col = mix(sand, mirror, clamp(fres * (soak * 0.7 + gloss * 1.4 + sheen), 0.0, 1.0)) + shine + drops.z * 0.2 * mirror * pool;
      // The line of light each swash leaves at the top of its run.
      glow += strandGlow * 1.4;
      // Bubbles bursting in the foam the backwash leaves behind.
      if (K_sparkles > 0.0) {
        glow += shoreSparks(g, tm, K_sparkles * 0.9) * exp(-drained / 4.0) * 1.3;
      }
      glow += drops.z * 0.4 * film;
      // Drops splashing: small crowns, brightest on wet, packed sand and in the puddles (dry sand
      // swallows them), and lit blue where the backwash has just left plankton stranded. Stretched
      // along z like the rings, and gone before a metre spans fewer than ~25 cells.
      if (rain > 0.0) {
        float fine = 1.0 - smoothstep(0.03, 0.05, max(cellX, cellZ * 0.4));
        float splash = rainSplashes(vec2(hx, hz * 0.4), t, rain) * fine * mix(0.35, 1.0, max(max(wet, rained), pool));
        col += splash * (air * 1.6 + lit * 0.5);
        glow += splash * exp(-drained / 5.0);
      }
    }

    // The pointer's wake: swirls of a ridged noise warped by a slowly turning flow. A fresh stir
    // glows solid; an older one breaks into filaments as it fades. Only where there is plankton:
    // in the water, and stranded on wet sand.
    if (K_stir > 0.5 && uSimOn.x > 0.5) {
      float trail = textureLod(uSim0, uv, 0.0).r;
      if (trail > 0.004) {
        vec2 s = vec2(uv.x * aspect, uv.y * 2.2) * 7.0;
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

    if (K_fog > 0.0) {
      float f = fogAmount(K_fog, 1.0 - exp(-hz / 45.0), clamp(hy / 3.0, 0.0, 1.0));
      col = mix(col, shoreDome(skyM, normalize(vec3(dir.x, 0.03, dir.z)), overcast, heavy), f);
      glow *= 1.0 - f;
      mark *= 1.0 - f;
    }
  }

  // Rain in the air between the eye and what this pixel sees: the veil of the farther rain closes
  // in on the horizon and dims the surf's light as it rains harder (less of it looking up, through
  // less rain), and the drops catch the grey light, the lightning and the plankton's glow behind
  // them, the big out-of-focus ones nearest the most.
  Precip pr = Precip(0.0, 0.0, 0.0);
  if (rain > 0.0) {
    pr = rainFall(uv, aspect, t, rain, K_wind, airDepth);
    float veil = pr.veil * (dir.y > 0.0 ? mix(0.6, 1.0, exp(-dir.y * 8.0)) : 1.0);
    col = mix(col, air, veil);
    glow *= 1.0 - veil;
    mark *= 1.0 - veil;
  }
  float light = clamp(glow * bio, 0.0, 1.5);
  float hot = light + mark;
  if (rain > 0.0) {
    vec3 dropCol = air * 1.5 + lit * 0.25 + SHORE_BIO * hot * (0.3 + 0.4 * pr.near);
    col = mix(col, dropCol, pr.cover * mix(0.55, 0.35, pr.near));
  }

  // Ink is the picture's light without the plankton; the plankton and the M are the accent. In full
  // colour their light is a colour of its own: where it is strong it outshines the foam it is in,
  // so the surf reads electric blue rather than washing out to white or teal. A sunlit beach puts
  // the page in its paper theme (index.ts), where ink is dark on a light ground. Drops in front of
  // the glow streak across it.
  float lum = dot(col, LUMA);
  bool paper = K_cycle <= 0.0 && K_time > 0.33 && K_time < 0.67;
  Shade o = blankShade();
  o.ink = paper ? clamp((0.9 - lum) / 0.8, 0.0, 1.0) : clamp(pow(lum, 0.8) * 1.3, 0.0, 1.0);
  float through = 1.0 - 0.4 * pr.cover;
  o.accent = clamp(max(light, mark), 0.0, 1.0) * through;
  col = mix(col, SHORE_BIO * 1.1, smoothstep(0.15, 1.2, hot) * 0.55 * through) + SHORE_BIO * hot * 0.8 * through;
  o.rgb = col;
  o.source = col;
  return o;
}
`;
