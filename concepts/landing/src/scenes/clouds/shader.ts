// Above the clouds: the view from an airliner window at cruise altitude. A ray-marched sea of
// cumulus tops below (the shared clouds' volume tier, shaders/lib/clouds.ts: the scene keeps its
// lighting, ocean and haze), the shared sky above, thunderheads on the horizon, a wingtip with its
// lights, the occasional passing plane, all framed by the cabin's porthole.
//
// Frames: the camera frame has x right, y up, z out through the window. The shared sky libraries
// work in a world frame whose "ahead" is cloudsTurn to the right of the window's view, so the sun
// sets inside the window at golden hour; directions turn into that frame only to read the sky. The
// moon keeps a low arc of the scene's own (cloudsMoon) so it crosses the porthole around midnight.
//
// Knobs (index.ts): K_time, K_cycle, K_stars (sky); K_cover, K_altitude, K_drift, K_thunderheads
// (cloud sea); K_window, K_wing, K_contrail (window seat, trigger slot 1); K_wind, K_lightning
// (trigger slot 0), K_aurora (weather); K_livery (manifold).

/** Seconds of the climb out of the deck and of the sinking back in (SceneDef.passage). */
export const CLOUDS_PASSAGE = { enter: 3.0, exit: 1.5 } as const;

export const cloudsGlsl = `
const float cloudsHorizon = 0.08; // horizon line above the screen centre, in screen heights (~58% up)
const float cloudsFocal = 1.2;    // lens: about 45 degrees of vertical field of view
const float cloudsTurn = 0.82;    // the window looks this far (radians) left of the sky's "ahead"
const float cloudsAmp = 0.45;     // height range of the cloud tops (CloudSea.amp), world units
const vec3 cloudsBoltLight = vec3(0.74, 0.78, 1.0);
const float cloudsMoonGain = 1.8; // moonlit cloud is the brightest thing in a night sky: the eye adapts

vec3 cloudsToWorld(vec3 d) {
  return skyFacing(d, cloudsTurn);
}

vec3 cloudsToCamera(vec3 d) {
  return skyFacing(d, -cloudsTurn);
}

// The shared sky for a camera-frame direction.
vec3 cloudsSky(Sky sky, vec3 dirCam) {
  return skyColor(sky, cloudsToWorld(dirCam));
}

float cloudsCross(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

// Highlights roll off toward 1 instead of clipping flat, so sunlit domes keep their modelling.
vec3 cloudsShoulder(vec3 c) {
  vec3 over = max(c - 0.7, 0.0);
  return min(c, vec3(0.7)) + 0.3 * (1.0 - exp(-over / 0.3));
}

// The wing's tone curve: luminance rolls off from 0.5 toward 0.9 with the hue kept, so sunlit
// paint keeps its sheen and livery instead of burning out to flat white at noon.
vec3 cloudsWingTone(vec3 c) {
  float l = dot(c, LUMA);
  float t = l < 0.5 ? l : 0.5 + 0.4 * (1.0 - exp(-(l - 0.5) / 0.4));
  return c * (t / max(l, 1e-4));
}

// The moon on a low arc of the scene's own: whatever the almanac says, the flight's heading puts
// it in the porthole from about nine in the evening to one in the morning, some 12 degrees up at
// midnight (now and then behind an anvil), rising on the right after dusk and setting on the left
// before dawn. The shared sky's disc, halo and moonlight follow it.
Sky cloudsMoon(Sky sky, float tod) {
  float h = (fract(tod + 0.5) - 0.5) * TAU; // 0 at midnight
  float el = 0.29 * cos(h) - 0.075;          // sine of its elevation: up from ~19:00 to ~05:00
  float az = -0.08 - 0.4 * h;                // radians right of the window's view
  float level = sqrt(1.0 - el * el);
  sky.moon = cloudsToWorld(vec3(sin(az) * level, el, cos(az) * level));
  vec3 moonColor = vec3(0.30, 0.36, 0.50) * sqrt(skyTransmit(el)) * smoothstep(-0.02, 0.06, el) * (1.0 - sky.day);
  sky.ambient += (moonColor - sky.moonColor) * 0.3;
  sky.moonColor = moonColor;
  return sky;
}

// Everything that lights the scene, in the camera frame.
struct CloudsLight {
  vec3 dir;        // key light: the sun, or the moon at night (held a little above the horizon)
  vec3 key;        // its colour on the cloud tops, with the afterglow they keep past sunset
  vec3 high;       // the same for anvils and contrails, which hold the light longer still
  vec3 toward;     // low sky toward the sun: the sunset glow
  vec3 away;       // low sky opposite: the Earth's shadow and the pink Belt of Venus at dusk
  vec3 zenith;     // the deep sky overhead
  vec3 ambient;    // the sky libraries' overall skylight
  vec3 fill;       // starlight and airglow: a cool fill so the deck reads as cloud on a dark night
  vec3 moon;       // the moon's direction
  vec3 moonlight;  // its light on cloud: the shared sky's moonlight times cloudsMoonGain, 0 by day
  vec2 sunBearing; // the sun's compass direction in the camera's xz plane
};

CloudsLight cloudsLighting(Sky sky) {
  CloudsLight li;
  vec3 sun = cloudsToCamera(sky.sun);
  li.moon = cloudsToCamera(sky.moon);
  li.moonlight = sky.moonColor * cloudsMoonGain;
  li.sunBearing = normalize(sun.xz + vec2(0.0, 1e-3));
  // Sky samples that colour indirect light; each is aimed so the sun's disc never lands in it.
  vec2 aside = rotate(li.sunBearing, 0.25);
  li.toward = cloudsSky(sky, normalize(vec3(aside.x, 0.06, aside.y)));
  li.away = cloudsSky(sky, normalize(vec3(-li.sunBearing.x, 0.12, -li.sunBearing.y)));
  li.zenith = cloudsSky(sky, normalize(vec3(-0.3 * li.sunBearing.x, 1.0, -0.3 * li.sunBearing.y)));
  // From cruise altitude the horizon dips: cloud tops see the sun a few degrees after the shared
  // sky has put it out, and anvils longer still. They keep the red of the glow toward it.
  float dusk = smoothfall(0.03, -0.02, sky.sun.y);
  vec3 afterglow = li.toward * dusk * smoothstep(-0.13, -0.05, sky.sun.y) * 0.6;
  li.key = sky.sunColor + afterglow + li.moonlight;
  li.high = sky.sunColor + li.toward * dusk * smoothstep(-0.2, -0.09, sky.sun.y) * 0.8 + li.moonlight;
  float ws = dot(sky.sunColor + afterglow, LUMA);
  float wm = dot(li.moonlight, LUMA);
  vec3 dir = normalize(vec3(sun.x, max(sun.y, 0.03), sun.z)) * ws + li.moon * wm + vec3(0.0, 1e-4, 0.0);
  dir = normalize(dir);
  li.dir = normalize(vec3(dir.x, max(dir.y, 0.03), dir.z));
  li.ambient = sky.ambient;
  li.fill = vec3(0.03, 0.045, 0.095) * sky.night;
  return li;
}

// Skylight on a surface facing n: the glow on the sun's side, the cool (or, at dusk, pink) sky
// opposite, the deep zenith overhead, and the bright deck around for faces turned sideways.
vec3 cloudsAmbient(CloudsLight li, vec3 n) {
  float side = dot(n.xz, li.sunBearing);
  vec3 low = mix(li.away, li.toward, 0.5 + 0.5 * side);
  vec3 dome = mix(low, li.zenith, 0.4 + 0.4 * max(n.y, 0.0));
  vec3 deck = li.key * (0.15 + 0.6 * max(li.dir.y, 0.0)) + li.ambient * 0.6;
  return mix(li.ambient, mix(deck, dome, 0.55 + 0.45 * n.y), 0.6) + li.fill * (0.6 + 0.4 * max(n.y, 0.0));
}

// Light on the cloud tops: wrapped diffuse for the soft terminator of a translucent volume (as in
// Green, "Real-time approximations to subsurface scattering", GPU Gems 2004) over a floor of light
// scattered through the dome from its sunlit side, so even a low sun blushes the tops; then
// self-shadowing, skylight by facing with the valleys occluded, and the forward lobe: a golden
// glare over the deck toward a low sun and bright rims where domes turn away from the eye.
vec3 cloudsShadeTop(CloudsLight li, vec3 rd, vec3 n, float h, float sunlit) {
  float ao = mix(0.5, 1.0, smoothstep(0.05, 0.85, h));
  float wrap = clamp((dot(n, li.dir) + 0.35) / 1.35, 0.0, 1.0);
  // Seen this obliquely every top is near grazing: measure the rim against a flat top's facing.
  float rim = clamp(1.0 - dot(n, -rd) / max(-rd.y * 1.3 + 0.08, 0.1), 0.0, 1.0);
  float fwd = min(cloudPhase(dot(rd, li.dir), 0.7), 12.0);
  vec3 c = 0.92 * (cloudsAmbient(li, n) * ao + li.key * (0.15 + 0.85 * wrap * wrap) * sunlit);
  c += li.key * fwd * (0.025 + 0.2 * rim * rim) * (0.25 + 0.75 * sunlit);
  return cloudsShoulder(c);
}

// One distant cumulonimbus in its own frame: q.x across from its axis, q.y up from the horizon,
// 1 = its height. One massive column, broadest at its dark rain-shaft base and leaning a little
// downwind, its outline boiling into cauliflower lobes, climbs into the anvil: a broad, flat slab
// of ice at the tropopause that the high winds spread downwind ('lean' -1..1) to two or three
// times the column's width and fray into fibrous cirrus, with a soft underside and an
// overshooting dome above the updraft. 'storm' 0..1 darkens it into a slate storm cell; 'strike'
// lights it from inside at 'strikeAt'. 'moonHaze' is the moon's halo in the horizon haze its base
// melts into. Returns straight rgb and coverage.
vec4 cloudsThunderhead(vec2 q, float seed, float lean, float aa, Sky sky, CloudsLight li, vec3 rd, vec3 moonHaze, float storm, float strike, vec2 strikeAt) {
  float ax = lean * 0.07 * q.y; // the updraft's axis
  bool nearAxis = abs(q.x - ax) < 0.55 && q.y < 0.9;
  if (!nearAxis && q.y < 0.55) return vec4(0.0);
  // Fine lobes fade out before they would shimmer; soft billows mottle the body without creases.
  float detail = 1.0 - smoothstep(0.012, 0.035, aa);
  float billows = vnoise(vec2(q.x * 3.5, q.y * 6.0) + seed * 9.0);

  // The column: one body, broadest at the base, its rounded top swallowed by the anvil. Only its
  // outline boils: on each side, rounded lobes with sharp creases between them (folded noise up
  // its height, two octaves), so the silhouette is cauliflower and the body stays solid.
  float dcol = 1e3;
  float wcol = 1.0;
  if (nearAxis) {
    float side = q.x < ax ? -1.0 : 1.0;
    float lobes = 0.075 * cloudBillow(vec2(q.y * 7.0 + seed * 11.0, side * 3.1 + seed * 5.0))
                + 0.035 * detail * cloudBillow(vec2(q.y * 16.0 + seed * 3.0, side * 7.3 - seed * 2.0));
    float cap = clamp((q.y - 0.6) / 0.24, 0.0, 1.0);
    wcol = (mix(0.34, 0.22, smoothstep(0.0, 0.7, q.y)) + lobes) * sqrt(1.0 - cap * cap);
    dcol = abs(q.x - ax) - wcol;
  }
  float column = softFill(dcol, aa);

  // The anvil: a broad flat slab, its underside rising gently from the column to a thinner edge
  // and fading softly into the air below, reaching furthest downwind. Each fibre of ice runs its
  // own length, so the ends fray into streaks.
  float dx = q.x - lean * 0.06;
  float downwind = dx * (lean < 0.0 ? -1.0 : 1.0);
  float shear = abs(lean);
  float fib = clamp(0.25 / aa, 8.0, 28.0);
  float reach = (downwind > 0.0 ? 0.6 + 0.75 * shear : 0.36 - 0.06 * shear)
              * (0.85 + 0.25 * vnoise(vec2(q.y * fib, seed * 13.0 + step(0.0, downwind) * 5.0)));
  float u = abs(dx) / reach;
  float overshoot = sqrt(max(1.0 - dx * dx / 0.03, 0.0)) * (0.85 + 0.3 * billows);
  float yTop = 0.9 - 0.035 * u * u + 0.08 * overshoot;
  float yBot = mix(0.68, 0.8, smoothstep(0.0, 1.0, u)) + 0.025 * (billows - 0.5);
  float fray = aa + 0.03 * smoothstep(0.4, 1.0, u);
  float under = aa + 0.045;
  float anvil = smoothstep(-fray, fray, yTop - q.y) * smoothstep(-under, under, q.y - yBot) * (1.0 - smoothstep(0.72, 1.0, u));
  float fibres = vnoise(vec2(q.x * 2.5 + seed * 7.0, q.y * fib * 1.3));
  anvil *= mix(1.0, 0.3 + 0.7 * fibres, smoothstep(0.5, 0.95, u));

  // The base sinks into the far deck.
  float body = max(column, anvil);
  float cov = body * smoothstep(-0.08, 0.06, q.y);
  if (cov <= 0.002) return vec4(0.0);
  // How much of what shows is anvil: it spreads over the top of the column.
  float wA = clamp(anvil * (1.0 - column * (1.0 - smoothstep(0.7, 0.8, q.y))) / max(body, 1e-3), 0.0, 1.0);

  // Normals, z toward the camera: the column round across its girth (its lobes widen the lit
  // flank where they bulge), soft billows tipping it up and down, its top turning skyward; the
  // anvil a slab, its flat top facing up, its underside down, its edge out.
  float gx = clamp((q.x - ax) / max(wcol, 0.05), -1.0, 1.0);
  vec3 nCol = normalize(vec3(gx, 0.15 + 0.5 * (billows - 0.5) + 0.8 * smoothstep(0.55, 0.84, q.y), -sqrt(1.0 - gx * gx) - 0.05));
  float v = clamp((q.y - yBot) / max(yTop - yBot, 0.01), 0.0, 1.0);
  vec3 nAnv = normalize(vec3(sign(dx) * min(u, 1.0) * 0.4, mix(-0.75, 0.9, v), -0.6));
  vec3 n = normalize(mix(nCol, nAnv, wA));

  // Light: wrapped diffuse for the sunlit flank against the shadowed side; occlusion low in the
  // column under the bulk above it and under the anvil; then the forward lobe through thin cloud,
  // a silver or gold lining on the outer silhouette and the frayed ice only.
  float lift = smoothstep(0.2, 0.85, q.y);
  vec3 key = mix(li.key, li.high, lift);
  float wrap = clamp((dot(n, li.dir) + 0.4) / 1.4, 0.0, 1.0);
  float aoCol = mix(0.85, 1.0, billows) * mix(0.45, 1.0, smoothstep(-0.02, 0.5, q.y));
  float ao = mix(aoCol, mix(0.5, 1.0, v), wA);
  float thin = mix(1.0 - smoothstep(0.0, 0.06, -dcol), max(smoothstep(0.45, 1.0, u), 1.0 - smoothstep(0.0, 0.05, yTop - q.y)), wA);
  float albedo = mix(0.95, mix(0.42, 0.6, wA), storm);
  float fwd = min(cloudPhase(dot(rd, li.dir), 0.7), 12.0);
  vec3 c = albedo * (cloudsAmbient(li, n) * ao + key * (0.08 + 0.92 * wrap * wrap) * (0.4 + 0.6 * ao));
  c += key * fwd * (0.02 + 0.24 * thin * thin) * (1.0 - 0.5 * storm);
  // The anvil's flat top holds the low sun longest: reddened sunlight on it, the violet zenith
  // over it, pink at golden hour and after sunset.
  float crown = wA * smoothstep(0.45, 1.0, v);
  vec3 tint = mix(vec3(1.0), vec3(1.0, 0.72, 0.8), sky.twilight);
  c += (li.high * tint + li.zenith * 0.35 * sky.twilight) * crown * (0.12 + 0.45 * sky.twilight) * (1.0 - 0.5 * storm);
  // A storm cell is slate blue. Low in the column, rain: darker curtains streaking into the haze.
  c *= mix(vec3(1.0), vec3(0.8, 0.86, 0.96), storm);
  float rain = (1.0 - wA) * (1.0 - smoothstep(0.02, 0.32, q.y));
  float shafts = vnoise(vec2((q.x - lean * 0.3 * q.y) * 8.0 + seed * 3.0, q.y * 1.5 + seed));
  c *= 1.0 - rain * (0.3 + 0.35 * shafts) * (0.6 + 0.4 * storm);
  // A hundred kilometres of air: the lower tower stands half lost in the horizon haze, the tops
  // stand clearer, and a storm's dark cell stands out of it.
  vec3 haze = cloudsSky(sky, normalize(vec3(rd.x, -0.01, rd.z))) + moonHaze;
  c = mix(c, haze, mix(0.9, 0.22, smoothstep(-0.04, 0.55, q.y)) * (1.0 - 0.4 * storm));
  // A strike lights the cloud from inside, brightest where it is thin enough to let the light out.
  vec2 dq = q - strikeAt;
  c += cloudsBoltLight * strike * (exp(-dot(dq, dq) * 9.0) * (1.1 + 1.5 * thin) + 0.12 + 0.2 * thin);
  return vec4(cloudsShoulder(c), cov);
}

// A thunderhead standing on the horizon at hv.x = tower.x, tower.y high, over 'col'.
vec3 cloudsTowerOver(vec3 col, vec2 hv, vec2 tower, float seed, float lean, float px, Sky sky, CloudsLight li, vec3 rd, vec3 moonHaze, float storm, float strike, vec2 strikeAt) {
  vec2 q = vec2(hv.x - tower.x, hv.y + 0.01) / tower.y;
  if (q.y < -0.1 || q.y > 1.05 || abs(q.x) > 1.6) return col;
  vec4 tw = cloudsThunderhead(q, seed, lean, px / tower.y, sky, li, rd, moonHaze, storm, strike, strikeAt);
  return mix(col, tw.rgb, tw.a);
}

// A distant airliner 'since' seconds into its pass across the frame (half-width 'span'). Its
// contrail condenses a little behind the engines as two lines that merge, then spreads, sinks,
// drifts with the wind and breaks into the regular puffs of the Crow instability as the wingtip
// vortices link up (Crow, "Stability theory for a pair of trailing vortices", AIAA J. 1970).
// Returns trail density (x) and the plane's own coverage (y).
vec2 cloudsContrail(vec2 hv, float px, float since, float seed, float wind, float span) {
  float heading = seed < 0.5 ? 1.0 : -1.0;
  float y0 = 0.07 + 0.2 * fract(seed * 7.13);
  vec2 a = vec2(-heading * span, y0);
  vec2 b = vec2(heading * span, y0 + (fract(seed * 3.77) - 0.5) * 0.1);
  vec2 d = normalize(b - a);
  vec2 across = vec2(-d.y, d.x);
  float speed = 0.035;
  vec2 r = hv - a;
  float s = dot(r, d);
  float age = since - s / speed; // seconds since the plane passed this point of its track
  float trail = 0.0;
  if (age > 0.0 && s > 0.0 && age < 40.0) {
    float sink = dot(vec2(wind * 0.0012, -0.0006), across) * age;
    float wobble = (vnoise(vec2(s * 25.0, seed * 50.0)) - 0.5) * 0.006 * smoothstep(3.0, 25.0, age);
    float puff = 1.0 + 0.6 * smoothstep(8.0, 24.0, age) * pow(0.5 + 0.5 * sin(s * 150.0 + seed * 40.0), 3.0);
    float width = (1.1 * px + 0.0009 * age) * puff;
    float sep = 1.4 * px * (1.0 - smoothstep(0.5, 5.0, age));
    float x = dot(r, across) - sink - wobble;
    float u0 = (x - sep) / width;
    float u1 = (x + sep) / width;
    float lines = max(bell(u0), bell(u1));
    trail = lines * smoothstep(0.2, 1.5, age) * (1.0 - smoothstep(22.0, 38.0, age)) * sqrt(1.1 * px / width);
  }
  float flown = since * speed;
  vec2 at = a + d * flown;
  float body = segmentDistance(hv, at - d * 0.007, at + d * 0.004);
  float plane = (1.0 - smoothstep(0.5 * px, 1.3 * px, body)) * step(flown, length(b - a));
  return vec2(trail, plane);
}

// The wingtip, in wing units w: origin at the frame's lower-right corner, 1 = about half the
// frame's height (cellW = one cell). The wing sweeps in from the corner toward the horizon, seen
// nearly edge-on from the cabin; a blended winglet rises from its tip. Returns rgb and coverage;
// 'glow' gets the red navigation light and the white strobe (with the steady position light),
// which shine into the air around them, and 'mark' the accent coverage (nav light, livery).
vec4 cloudsWing(vec2 w, float cellW, vec3 rdCam, Sky sky, CloudsLight li, float strobe, float nav, bool livery, out vec3 glow, out float mark) {
  glow = vec3(0.0);
  mark = 0.0;
  vec2 tipLead = vec2(-0.98, 0.80);
  vec2 tipTrail = vec2(-1.24, 0.76);
  vec2 leadDir = normalize(vec2(0.98, -0.30));
  vec2 trailDir = normalize(vec2(0.88, -0.76));
  vec2 chordDir = normalize(tipLead - tipTrail);
  // Distances inside each edge (positive inside): leading, trailing, and the tip chord.
  float inLead = -cloudsCross(leadDir, w - tipLead);
  float inTrail = cloudsCross(trailDir, w - tipTrail);
  float inTip = -cloudsCross(chordDir, w - tipTrail);
  float wingD = min(min(inLead, inTrail), inTip);

  // Winglet: its leading edge is a quadratic Bezier leaving the wing's leading edge along its own
  // direction (the blend), curving up and back; y rises monotonically along it, so solve for the
  // parameter at this height and measure across, corrected by the edge's slope.
  vec2 b0 = tipLead + leadDir * 0.16;
  vec2 b1 = vec2(-1.04, 0.82);
  vec2 b2 = vec2(-1.27, 1.22);
  vec2 topTrail = vec2(-1.42, 1.19);
  float letLead = inLead;
  if (w.y >= b0.y) {
    float qa = b0.y - 2.0 * b1.y + b2.y;
    float qb = 2.0 * (b1.y - b0.y);
    float s = clamp((-qb + sqrt(max(qb * qb - 4.0 * qa * (b0.y - w.y), 0.0))) / (2.0 * qa), 0.0, 1.0);
    float x = mix(mix(b0.x, b1.x, s), mix(b1.x, b2.x, s), s);
    vec2 tangent = mix(b1 - b0, b2 - b1, s);
    float slope = tangent.x / max(tangent.y, 1e-3);
    letLead = (x - w.x) / sqrt(1.0 + slope * slope);
  }
  float letTrail = -cloudsCross(normalize(topTrail - tipTrail), w - tipTrail);
  float letTop = -cloudsCross(normalize(b2 - topTrail), w - topTrail);
  float letBase = min(0.03 - inTip, inTrail + 0.01);
  float letD = min(min(letLead, letTrail), min(letTop, letBase));
  float cov = smoothstep(-0.7 * cellW, 0.7 * cellW, max(wingD, letD));

  // The lights: red navigation light on the tip's leading edge, white strobe and steady white
  // position light at the trailing tip. Sizes are in cells so they stay crisp points of light.
  vec2 navAt = vec2(-0.86, 0.765);
  vec2 strobeAt = tipTrail + vec2(0.012, 0.004);
  float dn = length(w - navAt) / cellW;
  float ds = length(w - strobeAt) / cellW;
  vec3 red = vec3(1.0, 0.1, 0.05);
  vec3 white = vec3(0.95, 0.97, 1.0);
  float navCore = smoothfall(2.6, 0.9, dn) * nav;
  glow = red * (navCore * 1.2 + nav * (exp(-dn / 4.0) * 0.45 + exp(-dn / 18.0) * 0.12));
  glow += white * (smoothfall(3.0, 1.0, ds) * (0.45 + 1.8 * strobe) + strobe * (exp(-ds / 6.0) * 0.9 + exp(-ds / 36.0) * 0.3));
  mark = navCore;
  if (cov <= 0.0) return vec4(0.0);

  bool onWinglet = letD > wingD;
  // Upper skin faces up (a touch of dihedral tips it toward the cabin), the airfoil curving down
  // toward its leading edge; the winglet's inner face looks back at the fuselage. Paint: satin
  // grey-white skin, a bare-metal slat along the leading edge, the winglet in the airline's blue
  // with a sky-blue stripe along its leading edge.
  vec3 n = normalize(vec3(0.18, 0.3, -1.0));
  vec3 paint = vec3(0.16, 0.26, 0.52);
  float lines = 0.0;
  float edgeLight = 0.0;
  float livered = 0.0;
  float metal = 0.0;
  if (onWinglet) {
    float acrossLet = clamp(letTrail / max(letTrail + letLead, 1e-3), 0.0, 1.0);
    edgeLight = smoothstep(0.82, 0.97, acrossLet);
    float stripe = smoothstep(0.03 - 0.7 * cellW, 0.03 + 0.7 * cellW, letLead) * (1.0 - smoothstep(0.065 - 0.7 * cellW, 0.065 + 0.7 * cellW, letLead));
    paint = mix(paint, vec3(0.42, 0.66, 0.92), stripe);
    if (livery) {
      // The M, leaning back with the winglet.
      vec2 mq = rotate(w - vec2(-1.215, 0.94), -0.3) / 0.12;
      float aaM = cellW / 0.12;
      livered = 1.0 - smoothstep(0.085 - aaM, 0.085 + aaM, markDistance(mq));
      paint = mix(paint, vec3(1.0, 0.54, 0.24), livered);
    }
  } else {
    // Panel lines in chord/span terms: the aileron hinge and its ends, the slat line.
    float chord = inTrail + inLead;
    float cf = clamp(inTrail / max(chord, 1e-3), 0.0, 1.0);
    n = normalize(vec3(mix(-0.12, 0.4, smoothstep(0.6, 1.0, cf)), 1.0, -0.12));
    lines = 1.0 - smoothstep(0.3 * cellW, 1.1 * cellW, abs(cf - 0.27) * chord);
    float ends = min(abs(inTip - 0.05), abs(inTip - 0.55));
    lines = max(lines, (1.0 - smoothstep(0.3 * cellW, 1.1 * cellW, ends)) * step(cf, 0.27));
    lines = max(lines, (1.0 - smoothstep(0.3 * cellW, 1.1 * cellW, abs(cf - 0.86) * chord)) * 0.6);
    edgeLight = smoothstep(0.9, 0.99, cf);
    metal = smoothstep(-cellW, cellW, (cf - 0.86) * chord);
    float aileron = (1.0 - smoothstep(-cellW, cellW, (cf - 0.27) * chord)) * smoothstep(-cellW, cellW, inTip - 0.05) * (1.0 - smoothstep(-cellW, cellW, inTip - 0.55));
    paint = mix(vec3(0.76, 0.78, 0.81) * (1.0 - 0.05 * aileron), vec3(0.6, 0.62, 0.65), metal);
    paint *= mix(0.86, 1.0, smoothstep(0.0, 0.08, cf));
  }
  float ndl = max(dot(n, li.dir), 0.0);
  vec3 r = reflect(rdCam, n);
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(-rdCam, n), 0.0, 1.0), 5.0);
  vec3 refl = cloudsSky(sky, normalize(vec3(r.x, max(r.y, 0.02), r.z)));
  float rl = max(dot(r, li.dir), 0.0);
  // Satin paint: a broad soft sheen round a tighter core; bare metal is sharper and mirrors more.
  float spec = mix(0.16 * pow(rl, 10.0) + 0.22 * pow(rl, 60.0), 0.08 * pow(rl, 20.0) + 0.5 * pow(rl, 240.0), metal);
  vec3 c = paint * (cloudsAmbient(li, n) * 0.85 + li.key * ndl);
  // Glossy paint mirrors the sky at this grazing angle: the horizon glow runs along the wing.
  c += refl * fres * mix(0.5, 0.9, metal) + li.key * spec;
  // The rounded leading edges catch the light from above.
  c += paint * (li.zenith * 0.2 + li.key * 0.25) * edgeLight;
  c *= 1.0 - 0.14 * lines;
  // Lit by its own lights: a red wash near the tip, the strobe flaring over wingtip and winglet.
  c += paint * (red * nav * exp(-length(w - navAt) * 9.0) * 0.8 + white * strobe * exp(-length(w - strobeAt) * 3.0) * 1.6);
  c = cloudsWingTone(c);
  mark = max(mark, livered * cov * clamp(dot(c, LUMA) * 2.0 + 0.35, 0.0, 1.0));
  return vec4(c, cov);
}

// ---- Passage -------------------------------------------------------------------------------------
// The entrance is the climb out of the cloud deck: wisps stream past the pane, the tops sink away
// below as the aircraft levels off, the horizon rocks level and the wing settles. The exit is the
// reverse: a bank and a sinking back into the tops under streaming vapour. At rest (passageIn() 1,
// passageOut() 0) every term below is exactly 0.

// Climb progress 0..1 (1 at rest), under way from the entrance's first frame and level a little
// before its end.
float cloudsLevel() {
  return clamp(passageIn() / 0.95, 0.0, 1.0);
}

// 1 deep in the tops (starting the climb, ending the dive) .. 0 at cruise altitude: the climb leaves
// them fast and slows as it levels off; the dive gathers pace into them.
float cloudsSink() {
  float a = 1.0 - cloudsLevel();
  float po = passageOut();
  return clamp(a * a * a + po * po, 0.0, 1.0);
}

// How far the world has slid past: grows through the exit (accelerating into the cloud), and runs
// forward through the entrance from a negative start, slowing as the aircraft levels off.
float cloudsStream() {
  float a = 1.0 - cloudsLevel();
  float po = passageOut();
  return 2.0 * po * po - 2.6 * a * a * a;
}

// The horizon's extra roll in radians: the climb's tilt rocks level past a hair, the exit banks.
float cloudsBank() {
  float x = cloudsLevel();
  float a = 1.0 - x;
  float po = passageOut();
  return 0.12 * a * a * cos(4.5 * x) + 0.15 * po * po;
}

// The wing's flex, in wing units (positive lifts it): loaded in the climb, easing back with a small
// overshoot, and dipping a little as the aircraft banks away.
float cloudsWingFlex() {
  float x = cloudsLevel();
  float a = 1.0 - x;
  float po = passageOut();
  return 0.08 * a * a * cos(3.5 * x) - 0.05 * po * po;
}

// How much vapour is about: thick when the climb starts, thinning away fast and then slowly as the
// tops sink below; building ever faster through the exit.
float cloudsWispAmount() {
  float a = 1.0 - cloudsLevel();
  float x = clamp((passageOut() - 0.3) / 0.7, 0.0, 1.0);
  return max(a * a * a, x * x);
}

// Streaks of vapour streaming sideways over the pane in two layers, the nearer one faster. Coverage
// 0..1; the caller cuts it per cell so the moving edges never flicker.
float cloudsWisps(vec2 p, float stream, float amount) {
  vec2 a = vec2(p.x * 0.8 + stream, p.y * 9.0);
  vec2 b = vec2(p.x * 1.3 + stream * 1.8, p.y * 15.0 + 4.7);
  float na = 0.6 * vnoise(a + vec2(3.1, 7.7)) + 0.4 * vnoise(a * vec2(2.3, 1.7) + vec2(9.3, 1.1));
  float nb = vnoise(b + vec2(5.3, 2.9));
  float th = mix(0.8, 0.3, amount);
  float ca = smoothstep(th, th + 0.18, na);
  float cb = smoothstep(th + 0.06, th + 0.24, nb);
  return max(ca, cb) * smoothstep(0.0, 0.12, amount);
}

// Everything beyond the pane: sky, thunderheads, the passing plane, the cloud sea, the wing.
// 'frame' is the half-size of what frames the view (the porthole, or the screen without it).
vec3 cloudsView(vec2 p, vec2 head, vec2 frame, float px, float tm, Sky sky, CloudsLight li, out float stars, out float accent) {
  stars = 0.0;
  accent = 0.0;
  // The world rolls a fraction of a degree as the aircraft rides the air; wing and window don't.
  float roll = 0.006 * sin(tm * 0.21) + 0.004 * sin(tm * 0.083 + 1.3) + cloudsBank();
  vec2 hv = rotate(p, roll) - vec2(0.0, cloudsHorizon);
  vec3 rd = normalize(vec3(hv, cloudsFocal));
  // The sky; below the horizon, the horizon colour the far deck dissolves into. Rays are held just
  // under the horizon, where the shared sky keeps the sun's glow but cuts its disc. Moonlight in
  // the haze spreads a broad halo round the moon, and the far deck under it melts into that glow.
  vec3 mv = rd - li.moon;
  float am = 0.5 * dot(mv, mv);
  vec3 moonHaze = li.moonlight * (0.2 * exp(-am * 700.0) + 0.1 * exp(-am * 50.0));
  vec3 bg = cloudsSky(sky, normalize(vec3(rd.x, max(rd.y, -0.01), rd.z))) + moonHaze;
  vec3 col = bg;

  float lseed = 0.0;
  float lage = lightningAge(tm, K_lightning, 0, lseed);
  float flash = lightningFlash(lage);
  bool towersOn = K_thunderheads > 0.0;
  float tall = 0.55 + 0.9 * K_thunderheads;
  vec2 tower0 = vec2(0.15 * frame.x, 0.28 * tall);  // x, height: right of the sun's setting point
  vec2 tower1 = vec2(0.95 * frame.x, 0.17 * tall);
  bool hitFirst = fract(lseed * 13.7) < 0.6;       // which of the two near towers the strike is in
  bool between = fract(lseed * 29.1) < 0.4;        // a bolt between them, or one out of its base
  vec2 struck = hitFirst ? tower0 : tower1;

  if (rd.y > 0.0) {
    vec3 dw = cloudsToWorld(rd);
    stars = skyStars(sky, dw, K_stars);
    col += vec3(0.88, 0.92, 1.0) * stars;
    // The giant planet over the stars, under the aurora; the towers stand in front of both.
    col = skyGiant(sky, col, dw, 1.0 / (cloudsFocal * uRes.y), 1.0);
    if (K_aurora > 0.0) col += auroraCurtains(dw, tm, K_aurora, 1.0) * sky.night;
  }

  if (towersOn && hv.y > -0.03) {
    float lean = clamp(0.35 + 0.65 * K_wind, -1.0, 1.0);
    // With lightning about, the towers are storm cells, slate dark, so a flash shows even at noon.
    float storm = K_lightning > 0.0 ? 0.7 + 0.3 * K_lightning : 0.0;
    float sx = (fract(lseed * 7.3) - 0.5) * 0.3;
    vec2 strikeAt = between ? vec2(sx, 0.25 + 0.55 * fract(lseed * 3.1)) : vec2(sx, 0.4);
    // The storm's glow spills into the sky around it.
    vec2 glowAt = hv - vec2(struck.x, 0.1);
    col += cloudsBoltLight * flash * 0.06 * exp(-length(glowAt) * 6.0);
    // Now and then a bolt leaps between the two nearer towers; they hide its ends.
    if (between && lage < 1.5) {
      vec2 a = vec2(tower0.x + 0.12 * tower0.y, 0.5 * tower0.y);
      vec2 b = vec2(tower1.x - 0.1 * tower1.y, 0.38 * tower1.y);
      float g = lightningBolt(hv, a, b, lseed, lage);
      col += mix(vec3(0.6, 0.5, 1.0) * g, vec3(1.0), smoothstep(0.6, 0.9, g));
    }
    // Farthest first; the outer two only show on wide frames.
    col = cloudsTowerOver(col, hv, vec2(-1.25 * frame.x, 0.2 * tall), 0.31, lean, px, sky, li, rd, moonHaze, storm * 0.6, flash * 0.06, strikeAt);
    col = cloudsTowerOver(col, hv, vec2(1.7 * frame.x, 0.15 * tall), 0.67, lean, px, sky, li, rd, moonHaze, storm * 0.6, flash * 0.06, strikeAt);
    col = cloudsTowerOver(col, hv, tower1, 0.53, lean, px, sky, li, rd, moonHaze, storm, flash * (hitFirst ? 0.12 : 1.0), strikeAt);
    col = cloudsTowerOver(col, hv, tower0, 0.19, lean, px, sky, li, rd, moonHaze, storm, flash * (hitFirst ? 1.0 : 0.12), strikeAt);
    // Otherwise the bolt falls out of the struck tower's dark base, through the rain, to the deck.
    if (!between && lage < 1.0) {
      vec2 a = vec2(struck.x + sx * struck.y, 0.42 * struck.y);
      vec2 b = vec2(struck.x + (sx + (fract(lseed * 8.3) - 0.5) * 0.35) * struck.y, -0.015);
      float g = lightningBolt(hv, a, b, lseed, lage) * (1.0 - smoothstep(0.16 * struck.y, 0.36 * struck.y, hv.y));
      col += mix(vec3(0.6, 0.5, 1.0) * g, vec3(1.0), smoothstep(0.6, 0.9, g));
    }
  }

  if (hv.y > -0.02) {
    // A passing plane: one crossing per period at a random moment in it, or now on the trigger
    // (which, like the lightning trigger, runs on real seconds even with motion off).
    float span = frame.x + 0.1;
    float dur = 2.0 * span / 0.035 + 38.0;
    float period = max(mix(260.0, 80.0, K_contrail), dur + 4.0);
    float k = floor(tm / period);
    float seed = hash12(vec2(k, 7.1));
    float since = K_contrail > 0.0 ? tm - k * period - seed * (period - dur) : -1.0;
    float fired = sinceTrigger(1);
    if (fired >= 0.0 && fired < dur) {
      since = fired;
      seed = hash12(vec2(uTriggers[1], 3.3));
    }
    if (since >= 0.0 && since < dur) {
      vec2 tr = cloudsContrail(hv, px, since, seed, K_wind, span);
      col = mix(col, li.high * 0.9 + li.ambient * 0.75, tr.x * 0.85);
      float beacon = step(0.88, fract(tm * 0.8 + seed * 7.0));
      col += tr.y * (li.high * 1.3 + li.ambient * 0.3 + vec3(1.0, 0.95, 0.9) * sky.night * beacon);
    }
  }

  if (rd.y < 0.0) {
    // The cloud sea. Its scale is fixed: flying higher shrinks the billows toward a fine grain.
    float drop = 0.4 + 4.0 * K_altitude;
    // Climbing out of the deck, or sinking back into it: the tops rise to meet the eye.
    float sink = cloudsSink();
    if (sink > 0.0) drop *= pow(0.06 / drop, sink);
    float tFar = 35.0 * drop;
    vec2 drift = vec2(tm * (0.45 * K_drift - 0.1 * K_wind), tm * 0.015);
    drift.x += 0.2 * cloudsStream();
    float boil = tm * (0.025 + 0.02 * abs(K_wind));
    CloudSea sea = CloudSea(drift, K_cover, boil, drop, cloudsAmp);
    float tHit = cloudSeaMarch(rd, sea, tFar);
    if (tHit > 0.0) {
      vec3 at = rd * tHit;
      // One cell's footprint on the deck: fine detail and normal spacing follow it, a cheap stand-in
      // for a mip level.
      vec4 top = cloudSeaTop(at, rd, sea, tHit * px / cloudsFocal);
      vec3 n = top.xyz;
      float h0 = top.w;
      float sunlit = cloudSeaShadow(at, li.dir, sea);
      vec3 c = cloudsShadeTop(li, rd, n, h0, sunlit);
      // Through the gaps, the ocean kilometres further down, half lost in the air between.
      vec3 ocean = vec3(0.012, 0.035, 0.07) + li.ambient * 0.08 + li.key * vec3(0.02, 0.05, 0.08);
      c = mix(c, mix(ocean, bg, 0.4), 1.0 - smoothstep(0.03, 0.22, h0));
      // Aerial perspective: the deck dissolves into the horizon glow.
      float fog = max(1.0 - exp(-tHit / (12.0 * drop)), smoothstep(0.7 * tFar, tFar, tHit));
      col = mix(c, bg, fog);
    }
  }

  if (flash > 0.0 && rd.y < 0.02) {
    // The strike lights the deck from inside: under the struck tower, or deep in the far deck.
    vec2 g = towersOn
      ? vec2(struck.x, -0.012)
      : vec2((fract(lseed * 5.3) - 0.5) * 1.6 * frame.x, -0.02 - 0.04 * fract(lseed * 9.7));
    vec2 dg = (hv - g) * vec2(0.55, 1.8);
    col += cloudsBoltLight * flash * exp(-dot(dg, dg) * 700.0) * (towersOn ? 0.45 : 0.9);
  }

  // Passage: cloud vapour streaming over the pane while the aircraft climbs out of, or sinks back
  // into, the deck. Exactly absent at rest.
  float wisp = cloudsWispAmount();
  if (wisp > 0.0) {
    float cover = cloudsWisps(p, cloudsStream(), wisp);
    vec3 vapour = cloudsShoulder(cloudsAmbient(li, vec3(0.0, 0.7, -0.7)) * 0.95 + li.key * (0.2 + 0.35 * max(li.dir.y, 0.0)));
    col = mix(col, vapour, hardEdge(cover) * 0.85);
  }

  if (K_wing > 0.5) {
    // Sized by the frame's height, shrunk on narrow frames so the winglet stays inside.
    float scale = min(frame.y, frame.x * 1.25);
    float cellW = px / scale;
    vec2 w = (p + head * 0.004 - vec2(frame.x, -frame.y)) / scale;
    // Passing through the deck the wing flexes (exactly 0 at rest); its edge is then cut per cell.
    float flex = cloudsWingFlex();
    w.y -= flex;
    if (w.x > -1.75 && w.y < 1.45) {
      vec3 rdCam = normalize(vec3(p.x, p.y - cloudsHorizon, cloudsFocal));
      // Anti-collision strobe: a double flash every 1.5 s (none at all with motion off).
      float ph = mod(tm, 1.5);
      float strobe = (exp(-ph * 30.0) + step(0.14, ph) * exp(-max(ph - 0.14, 0.0) * 30.0)) * step(0.001, uMotion);
      float blink = fract(tm / 1.2 + 0.4);
      float nav = smoothstep(0.0, 0.05, blink) * (1.0 - smoothstep(0.5, 0.56, blink));
      vec3 glow = vec3(0.0);
      float mark = 0.0;
      vec4 wing = cloudsWing(w, cellW, rdCam, sky, li, strobe, nav, K_livery > 0.5, glow, mark);
      float wingCover = abs(flex) > 0.0005 ? hardEdge(wing.a) : wing.a;
      col = mix(col, wing.rgb, wingCover) + glow;
      accent = max(accent, mark);
    }
  }
  return col;
}

// The porthole and the cabin wall around it, over the view. qp is the point relative to the pane;
// dP and dT are the distances to the pane's and the cabin-side trim's rounded rectangles (shifted
// apart by the head: the reveal between them has depth). sunAt: the key light on screen.
vec3 cloudsWindow(vec3 view, vec2 p, vec2 qp, float dP, float dT, vec2 size, float radius, float pitch, float cx, float px, Sky sky, CloudsLight li, vec2 sunAt) {
  float dayish = clamp(sky.day + 0.5 * sky.twilight, 0.0, 1.0);
  float night = 1.0 - dayish;
  // Cabin light: daylight through the windows by day, dim violet mood lighting at night.
  vec3 cabin = mix(vec3(0.04, 0.035, 0.065), vec3(0.15, 0.145, 0.14), dayish);
  vec3 winLight = li.ambient * 0.8 + li.key * 0.3;
  vec3 plastic = vec3(0.74, 0.73, 0.7);

  // The inner pane: its thick edge, a faint reflection of the cabin (and a reading light at night),
  // hairline scratches that only show where light catches them, glare round the sun, and the
  // little breather hole near the bottom.
  vec3 pane = view * mix(1.0, 0.76, smoothstep(-0.04, 0.0, dP));
  float sheen = smoothfall(0.3, 0.0, abs(dot(qp, vec2(0.83, 0.56)) + 0.12));
  pane += (cabin * 1.5 + 0.01) * (0.25 + 0.75 * sheen) * (0.15 + 0.45 * night);
  vec2 lamp = qp - size * vec2(0.42, 0.5);
  pane += vec3(1.0, 0.82, 0.55) * exp(-dot(lamp, lamp) * 1600.0) * 0.08 * night;
  vec2 grid = qp * 7.0 + 0.5;
  vec2 id = floor(grid);
  float hs = hash12(id + 31.7);
  float scratch = 0.0;
  if (hs > 0.45) {
    float ang = hash12(id + 7.3) * 3.14159;
    vec2 along = vec2(cos(ang), sin(ang));
    vec2 mid = 0.3 + 0.4 * vec2(hash12(id + 2.9), hash12(id + 5.1));
    float len = 0.08 + 0.2 * hash12(id + 9.9);
    float d = segmentDistance(fract(grid), mid - along * len, mid + along * len) / 7.0;
    scratch = (1.0 - smoothstep(0.35 * px, 1.1 * px, d)) * (0.4 + 0.6 * fract(hs * 13.0));
  }
  float nearSun = exp(-length(p - sunAt) * 2.4) * smoothstep(0.0, 0.2, li.dir.z);
  pane += li.key * nearSun * (0.06 + 0.6 * scratch) + scratch * winLight * 0.06;
  float hole = length(qp - vec2(0.0, -size.y * 0.8));
  pane *= 1.0 - 0.45 * (1.0 - smoothstep(0.006, 0.006 + px, hole));
  pane += (winLight * 0.12 + 0.02) * exp(-abs(hole - 0.0075) / px) * 0.5;

  // The reveal: moulded plastic between the pane and the trim. Its sill faces up into the
  // skylight; the sun shining in lights the wall of it across from where the sun stands.
  vec2 corner = vec2(qp.x < 0.0 ? -1.0 : 1.0, qp.y < 0.0 ? -1.0 : 1.0);
  vec2 outward = normalize(max(abs(qp) - (size - radius), 0.0) + 1e-4) * corner;
  float rv = clamp(dP / max(dP - dT, 1e-3), 0.0, 1.0); // 0 at the pane .. 1 at the trim
  float fromSky = 0.5 - 0.5 * outward.y;
  float sunSide = max(dot(-outward, normalize(li.dir.xy + 1e-4)), 0.0) * smoothstep(0.05, 0.3, li.dir.z) * smoothstep(0.03, 0.2, length(li.dir.xy));
  vec3 reveal = plastic * (cabin + winLight * (0.2 + 0.6 * fromSky) * (1.0 - 0.5 * rv) + li.key * sunSide * (1.0 - 0.5 * rv) * 0.8);
  // The rolled-up shade along the top, its finger grip at the middle.
  float blind = smoothstep(0.6, 0.9, outward.y) * (1.0 - smoothstep(0.42, 0.48, rv));
  reveal *= 1.0 - 0.16 * blind;
  float grip = softFill(sdBox(qp - vec2(0.0, size.y + 0.014), vec2(0.04, 0.006), 0.005), px);
  reveal = mix(reveal, reveal * 1.15 + 0.01, grip);
  // The dark seal round the pane, and the trim's rounded lip catching the light.
  reveal *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 2.5 * px, dP));
  reveal += plastic * winLight * 0.25 * exp(-abs(dT) / (2.0 * px));

  // The cabin wall: dim, lit around the window, a panel seam halfway to the next one.
  vec3 wall = plastic * 0.55 * (cabin + winLight * (0.06 + 0.3 * exp(-max(dT, 0.0) / 0.08)));
  wall *= 0.85 + 0.15 * smoothstep(-0.5, 0.5, p.y);
  wall *= 1.0 - 0.35 * (1.0 - smoothstep(0.5 * px, 1.5 * px, abs(abs(p.x - cx) - 0.5 * pitch)));

  vec3 frameCol = mix(reveal, wall, smoothstep(-0.6 * px, 0.6 * px, dT));
  return mix(pane, frameCol, smoothstep(-0.6 * px, 0.6 * px, dP));
}

Shade sceneClouds(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  // Leaning toward the pointer: the near frame slides against the view, the wing a little.
  vec2 head = uPointer * m;

  float tod = timeOfDayM(K_time, K_cycle, tm);
  Sky sky = cloudsMoon(skyAt(tod), tod);
  CloudsLight li = cloudsLighting(sky);
  // Under an aurora the tops, and the window frame, pick up a faint green.
  vec3 auroraGlow = vec3(0.04, 0.22, 0.14) * K_aurora * sky.night;
  li.ambient += auroraGlow * 0.15;
  li.fill += auroraGlow * 0.12;

  // The porthole: a deeply rounded rectangle, repeating along the cabin on very wide screens.
  bool windowOn = K_window > 0.5;
  vec2 size = vec2(min(0.315, aspect * 0.5 - 0.045), 0.425);
  float radius = min(size.x, size.y) * 0.82;
  float pitch = 2.0 * (size.x + 0.055) + 0.55;
  float cx = pitch * floor(p.x / pitch + 0.5);
  vec2 qp = p - vec2(cx, 0.0) + head * 0.008;
  vec2 qt = p - vec2(cx, 0.0) + head * 0.02;
  float dP = windowOn ? sdBox(qp, size, radius) : -1.0;
  float dT = windowOn ? sdBox(qt, size + 0.055, radius + 0.055) : -1.0;
  vec2 frame = windowOn ? size : vec2(aspect * 0.5, 0.5);

  vec3 col = vec3(0.0);
  float stars = 0.0;
  float accent = 0.0;
  if (dP < px) col = cloudsView(p, head, frame, px, tm, sky, li, stars, accent);
  if (windowOn) {
    vec2 sunAt = li.dir.xy / max(li.dir.z, 0.05) * cloudsFocal + vec2(0.0, cloudsHorizon);
    col = cloudsWindow(col, p, qp, dP, dT, size, radius, pitch, cx, px, sky, li, sunAt);
    float paneMask = softFill(dP, 0.6 * px);
    stars *= paneMask;
    accent *= paneMask;
  }
  float v = length((uv - 0.5) * vec2(1.0, 0.85)) * 1.45;
  col *= 1.0 - 0.25 * smoothstep(0.45, 1.05, v);

  Shade o = shadeOf(col, inkOf(col, 1.0, 1.0), accent);
  o.shimmer = stars * 0.4; // main scales it by the motion
  return o;
}
`;
