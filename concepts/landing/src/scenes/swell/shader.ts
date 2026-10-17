// The swell scene: a moonlit open sea on the shared water library (shaders/lib/water.ts, its mirror
// tier). Three long Gerstner swells and the wind's chop (rippleSpectrum) tilt the surface where the
// cells resolve them and only roughen it where they do not, so the far sea never crawls; the surface
// mirrors the shared night sky (skyAt, skyColor) through waterMirror and lays the moon's glitter
// path (waterGlint), which the swells break into rows near by and which widens toward the horizon
// as the trains fade into its roughness. With `relief` the nearer swells stand up for real (a
// bounded march). Its own moon (K_moon sizes it; an M in its seas as an option) and stars; the
// shared birds (shaders/lib/birds.ts; K_birds, K_birdKind, K_birdFormation, off by default) and
// shooting stars (K_meteors, off by default; src/scenes/README.md "Composing components"), glinting
// in the waves below them. Lengths are in camera heights, some 15 m.
import { birdsGlsl } from "../../shaders/lib/birds.ts";

/** Trigger slot of the shooting stars' "now" button. */
export const SWELL_METEOR_TRIGGER = 0;

export const swellGlsl = `
${birdsGlsl}
// Where shooting stars set out, in the screen frame of the moon and the stars (screen heights from
// the middle, the horizon at SWELL_HORIZON): high over the sea, most fading before the horizon.
const int SWELL_METEOR_SLOT = ${SWELL_METEOR_TRIGGER};
const vec4 SWELL_METEOR_FIELD = vec4(-0.6, 0.2, 1.2, 0.2);
// The frame: the horizon this far below the middle (screen heights), and the focal length.
const float SWELL_HORIZON = -0.06;
const float SWELL_FOCAL = 1.6;
// The night: the shared sky at this hour (its gradient and light; the moon is our own).
const float SWELL_HOUR = 0.97;
// Gravity in camera heights a second squared, for the waves' true deep-water dispersion.
const float SWELL_G = 0.654;

// The long swells, three Gerstner trains: wavelength (camera heights), amplitude (per unit of the
// height knob, the third of the chop's) and phase; and the way each one's crests travel, in toward
// the camera from off to either side.
const vec3 SWELL_WAVE[3] = vec3[3](vec3(2.6, 0.06, 0.0), vec3(1.6, 0.03, 1.3), vec3(0.95, 0.012, 2.9));
const vec2 SWELL_ALONG[3] = vec2[3](normalize(vec2(-0.42, -0.91)), normalize(vec2(0.55, -0.83)), normalize(vec2(-0.18, -0.98)));
// How far each train's water is drawn in under its crests (Gerstner's steepness Q), and the most the
// three together may squeeze the surface, so a crest sharpens but never folds over.
const float SWELL_SHARP = 1.6;
const float SWELL_FOLD = 0.7;
// The wind's chop on the swells: four trains rocking about the swells' heading, from 3 m down to
// half a metre, their slopes times the chop knob (rippleSpectrum).
const RippleFan SWELL_CHOP = RippleFan(4, vec2(0.2, 0.55), vec2(0.09, 0.012), vec2(1.0, 0.0), vec2(3.0, 0.0), vec3(0.7, 2.4, 0.0), 1.7, vec2(8.0, 16.0));
// The moon's glitter (waterGlint): its exposure, set so the path across the row that mirrors the
// moon is as bright at half its height as it always was; and the share of the facets in the sea's
// broad tail (variance 0.03), which lays a wide sheen round it.
const float SWELL_GLINT = 0.173;
const float SWELL_TAIL = 0.25;

// The long swells at x (camera heights: across, ahead) at tm. x is where the surface lies, not where
// its water came from (X(x0) = x0 + sum q a d cos(phase)), so that is found first: a fixed-point
// step back, then one Newton step on X, whose Jacobian is I - sum q k a sin(phase) d d^T. The
// fixed-point step alone leaves the crests half as sharp as the trochoid's; with the Newton step
// the curvature at a crest is within 1% of it. amp: each train's amplitude; seen: how much of each
// train the cells draw (1 for the relief's shape). Returns the height (x), the slope dh/dx, dh/dz
// (yz) and the squeeze (w: 1 on flat water, toward 1 - SWELL_FOLD under the sharpest crests).
vec4 swellLong(vec2 x, float tm, vec3 amp, vec3 seen) {
  vec3 k = TAU / vec3(SWELL_WAVE[0].x, SWELL_WAVE[1].x, SWELL_WAVE[2].x);
  vec3 omega = sqrt(SWELL_G * k);
  float q = min(SWELL_SHARP, SWELL_FOLD / max(dot(k, amp), 1e-4));
  vec2 x0 = x;
  for (int i = 0; i < 3; i++) {
    x0 -= q * amp[i] * SWELL_ALONG[i] * cos(k[i] * dot(SWELL_ALONG[i], x) - omega[i] * tm + SWELL_WAVE[i].z);
  }
  vec2 miss = x0 - x;
  mat2 jacobian = mat2(1.0);
  for (int i = 0; i < 3; i++) {
    float ph = k[i] * dot(SWELL_ALONG[i], x0) - omega[i] * tm + SWELL_WAVE[i].z;
    miss += q * amp[i] * SWELL_ALONG[i] * cos(ph);
    jacobian -= q * k[i] * amp[i] * sin(ph) * outerProduct(SWELL_ALONG[i], SWELL_ALONG[i]);
  }
  x0 -= inverse(jacobian) * miss;
  float h = 0.0;
  vec2 rise = vec2(0.0);
  float squeeze = 1.0;
  for (int i = 0; i < 3; i++) {
    float ph = k[i] * dot(SWELL_ALONG[i], x0) - omega[i] * tm + SWELL_WAVE[i].z;
    float a = amp[i] * seen[i];
    h += a * sin(ph);
    rise += SWELL_ALONG[i] * (k[i] * a * cos(ph));
    squeeze -= q * k[i] * a * sin(ph);
  }
  return vec4(h, rise / squeeze, squeeze);
}

// Each long train's amplitude for the knobs: the height knob's two, the chop's third.
vec3 swellAmp(float height, float chop) {
  return vec3(SWELL_WAVE[0].y * height, SWELL_WAVE[1].y * height, SWELL_WAVE[2].y * chop);
}

// A single long swell rolling in toward the camera as the scene arrives: a crest with a trough behind
// it, riding a gaussian envelope that widens with distance so it reads as one wave at any depth.
// front: where the crest is (camera heights ahead); amp: its height, 0 once the entrance is over.
// Returns its height and its slope along z.
vec2 swellRoll(float z, float front, float amp) {
  if (amp <= 0.0) return vec2(0.0);
  float s = 1.14 + 0.15 * max(front, 0.0);
  float d = (z - front) / s;
  float bell = exp(-d * d * 0.5);
  return amp * bell * vec2(sin(d * 1.7), (1.7 * cos(d * 1.7) - d * sin(d * 1.7)) / s);
}

// The relief fades out between these distances (camera heights), where the waves shrink toward a
// cell: beyond, the sea is the flat one, so the far field and the horizon never alias.
const float SWELL_RELIEF_NEAR = 8.0;
const float SWELL_RELIEF_FAR = 30.0;

// How far the point s along the eye's ray rd lies above the sea when the waves stand 'lift' times
// their height above and below still water: negative under it. The shape is the long swells and the
// entrance's roll; the chop only shades.
float swellGap(float s, float camH, vec3 rd, float lift, float t, float chop, float height, float front, float amp) {
  vec2 x = rd.xz * s;
  float fade = smoothfall(SWELL_RELIEF_FAR, SWELL_RELIEF_NEAR, s);
  return camH + rd.y * s - lift * fade * (swellLong(x, t, swellAmp(height, chop), vec3(1.0)).x + swellRoll(x.y, front, amp).x);
}

// The waves' real height for relief 0..1: at 1 they are lifted until their steepest slope is 0.9,
// never above 0.8 of the camera, camH over still water. Returns the lift (times their height, for
// swellGap), the largest lifted height and the largest lifted slope: the trains' amplitudes summed,
// and their slopes summed and steepened by the most the Gerstner squeeze can (1 + Q sum k a).
vec3 swellRelief(float relief, float camH, float chop, float height, float amp) {
  vec3 a = swellAmp(height, chop);
  vec3 k = TAU / vec3(SWELL_WAVE[0].x, SWELL_WAVE[1].x, SWELL_WAVE[2].x);
  float ka = dot(k, a);
  float q = min(SWELL_SHARP, SWELL_FOLD / max(ka, 1e-4));
  float reach = a.x + a.y + a.z + amp;
  float steepest = ka * (1.0 + q * ka) + 1.6 * amp;
  float lift = relief * min(0.9 / max(steepest, 1e-3), 0.8 * camH / max(reach, 1e-3));
  return vec3(lift, lift * reach, lift * steepest);
}

// Where the eye's ray first meets that sea: steps through the slab the waves can fill, as long as the
// gap and the slope allow and never shorter than a share of the distance (at most 28), then three
// secant steps. A ray still above the waves after its last step is skimming the crests and stops
// there. Returns the distance along rd.
float swellMarch(float camH, vec3 rd, vec3 relief, float t, float chop, float height, float front, float amp) {
  float lift = relief.x;
  float bound = relief.y;
  float slope = relief.z;
  float level = camH / -rd.y;
  float ta = max((camH - bound) / -rd.y, 0.0);
  if (ta >= SWELL_RELIEF_FAR) return level;
  float tEnd = min((camH + bound) / -rd.y, max(level, SWELL_RELIEF_FAR));
  float ga = swellGap(ta, camH, rd, lift, t, chop, height, front, amp);
  float tb = ta;
  float gb = ga;
  for (int i = 0; i < 28; i++) {
    if (gb <= 0.0 || tb >= tEnd) break;
    ta = tb;
    ga = gb;
    float steep = slope * smoothfall(SWELL_RELIEF_FAR, SWELL_RELIEF_NEAR, tb) + 0.1 * bound;
    tb = min(tb + max(gb / (-rd.y + steep), 0.01 + 0.015 * tb), tEnd);
    gb = swellGap(tb, camH, rd, lift, t, chop, height, front, amp);
  }
  if (gb > 0.0) return tb;
  for (int k = 0; k < 3; k++) {
    float ts = ta + (tb - ta) * ga / max(ga - gb, 1e-5);
    float gs = swellGap(ts, camH, rd, lift, t, chop, height, front, amp);
    if (gs > 0.0) {
      ta = ts;
      ga = gs;
    } else {
      tb = ts;
      gb = gs;
    }
  }
  return ta + (tb - ta) * ga / max(ga - gb, 1e-5);
}

Shade sceneSwell(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * vec2(0.012, 0.006) * m;
  // The camera. Arriving, it rises from just above the water (arrive 1 -> 0, easing out with a small
  // overshoot) while its pitch settles; leaving, it sinks toward the waves and tips down (leave 0 -> 1).
  // Both terms are exactly 0 at rest. The pitch shifts the view by whole cells so the stars keep to the
  // dither grid instead of crawling, and it moves the horizon, moon and stars together.
  float arrive = 1.0 - passageSettle(passageIn(), 1.2);
  float leave = passageOut() * passageOut();
  float camH = 1.0 - 0.65 * arrive - 0.6 * leave;
  float tilt = -(0.07 * arrive + 0.08 * leave);
  p.y += floor(tilt * uRes.y + 0.5) / uRes.y;
  vec2 moon = vec2(-aspect * 0.2, 0.24);
  float moonRadius = 0.03 + 0.09 * K_moon;
  float height = K_height * 2.0;
  float chop = K_chop * 2.0;
  float wt = uMotionTime;
  vec3 rd = normalize(vec3(p.x, p.y - SWELL_HORIZON, SWELL_FOCAL));

  // The night: the shared sky's, its own moon taken out (ours is drawn here); our moon's light, a
  // little more of it the bigger it is drawn, and its glow in the air.
  Sky sky = skyAt(SWELL_HOUR);
  sky.moon = vec3(0.0, -1.0, 0.0);
  vec3 moonDir = normalize(vec3(moon.x, moon.y - SWELL_HORIZON, SWELL_FOCAL));
  vec3 moonLight = vec3(0.62, 0.68, 0.8) * (0.8 + 0.4 * K_moon);
  vec3 air = vec3(0.02, 0.03, 0.062);

  // The entrance's swell: one long crest rolls in from the far sea (front, camera heights ahead) and
  // spends itself before it reaches the camera. rollAmp is exactly 0 once the scene has arrived.
  float arrived = passageIn();
  float front = mix(15.5, -1.8, arrived);
  float rollAmp = 0.18 * smoothstep(0.0, 0.1, arrived) * (1.0 - smoothstep(0.7, 1.0, arrived));
  // The latest shooting star, for the sky and its glints in the sea.
  float meteorSeed;
  float meteorAt = meteorAge(wt, K_meteors, SWELL_METEOR_SLOT, meteorSeed);
  vec3 col;
  float accent = 0.0;
  float shimmer = 0.0;
  float seaDist = 1e4; // camera heights ahead (z) to the sea under this cell (the sky: as far as it gets)
  if (p.y > SWELL_HORIZON) {
    float hh = max(rd.y, 0.0);
    col = skyColor(sky, rd) + air * (0.5 + 0.5 * exp(-hh * 3.0));
    float md = length(p - moon);
    float disc = smoothfall(moonRadius, moonRadius - 0.003, md);
    float craters = fbm((p - moon) * 30.0);
    float maria = K_mmoon > 0.5 ? smoothfall(0.11, 0.07, markDistance((p - moon) / moonRadius / 1.3)) : 0.0;
    col += vec3(0.62, 0.68, 0.82) * exp(-md * 12.0 * 0.075 / moonRadius) * 0.22;
    col += SKY_STAR_TINT * starfield(floor(p * uRes.y), 0.001 + 0.007 * K_stars, 0.3, 0.8) * (1.0 - disc);
    col += METEOR_TINT * hardEdge(meteorStreak(p, SWELL_METEOR_FIELD, meteorAt, meteorSeed, 1.0 / uRes.y) * (1.0 - disc));
    col = mix(col, vec3(0.98, 0.96, 0.9) * (0.7 + 0.3 * craters) * (1.0 - 0.6 * maria), disc);
  } else {
    // With relief the waves have real height and crests hide the troughs behind them; 0 is the flat
    // sea with the waves painted on it.
    float dist = camH / max(-rd.y, 1e-4);
    if (K_relief > 0.0) dist = swellMarch(camH, rd, swellRelief(K_relief, camH, chop, height, rollAmp), wt, chop, height, front, rollAmp);
    seaDist = dist * rd.z;
    vec2 x = rd.xz * dist;
    // What one cell covers there (the flat sea's footprint), and how much of each long train it
    // resolves (rippleTrain's 7 to 14 cells a wavelength): a train it does not is only roughness.
    Ground g = groundHit(rd, camH, SWELL_FOCAL);
    vec3 seen;
    vec3 fine;
    vec3 amp = swellAmp(height, chop);
    for (int i = 0; i < 3; i++) {
      float wavelength = SWELL_WAVE[i].x;
      seen[i] = smoothstep(7.0, 14.0, wavelength / max(length(SWELL_ALONG[i] * g.foot), 1e-6));
      float ka = TAU / wavelength * amp[i];
      fine[i] = 0.5 * ka * ka * (1.0 - seen[i]);
    }
    vec4 swell = swellLong(x, wt, amp, seen);
    vec2 roll = swellRoll(x.y, front, rollAmp);
    vec3 rip = rippleSpectrum(x, wt, g.foot, chop, SWELL_CHOP);
    // The slope variance the cells do not draw: a light breeze's ripples finer than the chop, more
    // as it blows harder, the chop's and the swells' trains too fine to draw.
    float rough = 0.003 + 0.002 * chop + rip.z + fine.x + fine.y + fine.z;
    WaterMirror sea = waterMirror(rd, swell.yz + vec2(0.0, roll.y) + rip.xy, 0.8 * sqrt(rough));
    vec3 refl = sea.ray;
    refl.y = max(refl.y, 0.01);
    refl = normalize(refl);
    // The moon's path (waterGlint): the chop drawn near by breaks it into flecks that come and go
    // as the ripples run, farther off it is the swells' rows, and toward the horizon, where the
    // trains fade into the roughness and the water mirrors more, a widening path that brightens.
    // Round it a wide moonlit sheen, the facets of the sea's broad tail (SWELL_TAIL): it lights the
    // backs of the swells well out to either side and leaves the faces turned to the viewer dark,
    // so every row reads.
    vec3 view = -rd;
    float path = waterGlint(sea.normal, view, moonDir, rough, SWELL_GLINT * (1.0 - SWELL_TAIL));
    float sheen = waterGlint(sea.normal, view, moonDir, 0.03, SWELL_GLINT * SWELL_TAIL);
    // Deep water, a little of the moon's light scattered back out of it under the crests; whitecaps
    // where the swells squeeze the surface hardest.
    float crest = smoothstep(0.0, 1.0, (swell.x + roll.x) / max(amp.x + amp.y + amp.z + rollAmp, 1e-3));
    vec3 body = vec3(0.004, 0.018, 0.036) + vec3(0.01, 0.05, 0.07) * moonLight * (0.3 + 0.7 * crest);
    vec3 mirror = skyColor(sky, refl) + air * 0.5;
    col = mix(body, mirror, sea.fresnel) + moonLight * (path + sheen);
    float foam = (1.0 - smoothstep(1.0 - SWELL_FOLD + 0.05, 1.0 - SWELL_FOLD + 0.2, swell.w)) * seen.x;
    col = mix(col, moonLight * 0.55 + sky.ambient, hardEdge(foam * 0.8));
    // The shooting star glints in the waves that face it: the sky point each one mirrors, in the
    // sky's frame (as the moon's direction above), its cells as dense as the water reflects. The chop
    // too fine to draw spreads the mirror: the streak is looked up at least 0.012 screen heights
    // wide, so a cluster of glints, rather than one or two, flashes under it.
    if (sea.ray.y > 0.0) {
      vec2 mirrored = sea.ray.xy * (SWELL_FOCAL / max(sea.ray.z, 1e-3)) + vec2(0.0, SWELL_HORIZON);
      col += METEOR_TINT * hardEdge(meteorStreak(mirrored, SWELL_METEOR_FIELD, meteorAt, meteorSeed, max(1.0 / uRes.y, 0.012)) * sea.fresnel);
    }
    // The sea gives way to the night air toward the horizon.
    float haze = 1.0 - exp(-dist / 40.0);
    col = mix(col, horizonHaze(sky, rd, 0.01) + air, haze);
    accent = (0.05 + 0.4 * crest) * (1.0 - haze) * (1.0 - min(path * 2.0, 1.0));
    shimmer = min(path, 1.0) * 0.3;
  }
  // Birds over the sea (gulls by default), pale where the moon lights them, dark against its disc;
  // in front of the sky, and of the sea where they lie nearer than the water under the cell (a
  // swooping party skims the crests). Their world unit is the camera height.
  if (K_birds > 0.0) {
    BirdSky flights = birdSky(K_birds, K_birdKind, K_birdFormation - 1.0, vec2(3.0, 24.0), vec2(0.5 + SWELL_HORIZON + 0.03, 0.95), vec2(1.3, 7.7));
    flights.swoopTo = 0.2;
    BirdHit bird = birdFlights(vec2(p.x, p.y + 0.5), flights, BirdCamera(0.5 + SWELL_HORIZON, SWELL_FOCAL, camH, 1.0 / 15.0, 2.0), wt, 1.0 / uRes.y);
    if (bird.cover > 0.5 && bird.depth < seaDist) {
      col = mix(bird.albedo * (sky.ambient * 1.5 + moonLight * 0.5), horizonHaze(sky, rd, 0.01) + air, 1.0 - exp(-bird.depth * 0.02));
      accent = 0.0;
      shimmer = 0.0;
    }
  }
  vec3 rgb = clamp(col, 0.0, 1.0);
  Shade o = shadeOf(rgb, inkOf(rgb, 1.6, 0.75), clamp(accent, 0.0, 1.0));
  o.shimmer = shimmer;
  return o;
}
`;
