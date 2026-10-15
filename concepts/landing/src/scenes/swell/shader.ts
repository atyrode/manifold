// The swell scene: open-ocean waves, and the shared birds over them (shaders/lib/birds.ts; K_birds,
// K_birdKind, K_birdFormation, off by default).
import { birdsGlsl } from "../../shaders/lib/birds.ts";

export const swellGlsl = `
${birdsGlsl}
// The long swells and the short chop as plain trains of waves: the sea's shape, without its texture.
float swellWaves(vec2 w, float t, float chop) {
  float s = 0.0;
  s += sin(dot(w, vec2(0.9, 0.42)) * 1.3 + t * 1.05) * 0.5;
  s += sin(dot(w, vec2(-0.55, 0.83)) * 2.1 + t * 1.45) * 0.25;
  s += sin(dot(w, vec2(0.18, 0.98)) * 3.7 + t * 2.05) * 0.12 * chop;
  return s;
}

float swellHeight(vec2 w, float t, float chop) {
  float s = swellWaves(w, t, chop);
  s += (fbm(w * 1.4 + vec2(t * 0.18, t * 0.1)) - 0.5) * 0.35 * chop;
  return s;
}

// A single long swell rolling in toward the camera as the scene arrives: a crest with a trough behind
// it, riding a gaussian envelope that widens with distance so it reads as one wave at any depth.
// front: where the crest is along the sea (w.y); amp: its height, 0 once the entrance is over.
float swellRoll(float wy, float front, float amp) {
  if (amp <= 0.0) return 0.0;
  float s = 2.5 + 0.15 * max(front, 0.0);
  float d = (wy - front) / s;
  return amp * sin(d * 1.7) * exp(-d * d * 0.5);
}

float seaHeight(vec2 w, float t, float chop, float height, float front, float amp) {
  return swellHeight(w, t, chop) * height + swellRoll(w.y, front, amp);
}

// The relief fades out between these distances (camera heights), where the waves shrink toward a
// cell: beyond, the sea is the flat one, so the far field and the horizon never alias.
const float SWELL_RELIEF_NEAR = 8.0;
const float SWELL_RELIEF_FAR = 30.0;

// How far the point s along the eye's ray rd lies above the sea when the waves stand 'lift' (camera
// heights per unit of seaHeight) above and below still water: negative under it. The shape is the
// wave trains (swellWaves and the entrance's roll) without the fbm texture, which only shades.
float swellGap(float s, float camH, vec3 rd, float lift, float t, float chop, float height, float front, float amp) {
  vec2 w = rd.xz * s * 2.2;
  float fade = smoothfall(SWELL_RELIEF_FAR, SWELL_RELIEF_NEAR, s);
  return camH + rd.y * s - lift * fade * (swellWaves(w, t, chop) * height + swellRoll(w.y, front, amp));
}

// The waves' real height for relief 0..1: at 1 the wave trains are lifted until their steepest slope
// is 0.9 (a quarter of a camera height per unit of seaHeight at the default swell and chop), never
// above 0.8 of the camera, camH over still water. Returns the lift (camera heights per unit of
// seaHeight, for swellGap), the largest lifted height and the largest lifted slope.
vec3 swellRelief(float relief, float camH, float chop, float height, float amp) {
  // The trains' amplitudes summed, and their amplitudes times wavenumbers (the steepest each gets).
  float reach = height * (0.5 + 0.25 + 0.12 * chop) + amp;
  float steepest = 2.2 * (height * (0.65 + 0.53 + 0.45 * chop) + 0.7 * amp);
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
  float ax = passageIn() - 1.0;
  float arrive = -(2.2 * ax * ax * ax + 1.2 * ax * ax);
  float leave = passageOut() * passageOut();
  float camH = 1.0 - 0.65 * arrive - 0.6 * leave;
  float tilt = -(0.07 * arrive + 0.08 * leave);
  p.y += floor(tilt * uRes.y + 0.5) / uRes.y;
  float horizon = -0.06;
  vec2 moon = vec2(-aspect * 0.2, 0.24);
  float moonRadius = 0.03 + 0.09 * K_moon;
  float height = K_height * 2.0;
  float chop = K_chop * 2.0;
  float wt = uMotionTime;

  // The entrance's swell: one long crest rolls in from the far sea (front, along the water) and
  // spends itself before it reaches the camera. rollAmp is exactly 0 once the scene has arrived.
  float arrived = passageIn();
  float front = mix(34.0, -4.0, arrived);
  float rollAmp = 1.6 * smoothstep(0.0, 0.1, arrived) * (1.0 - smoothstep(0.7, 1.0, arrived));
  Shade o = blankShade();
  float seaDist = 1e4; // camera heights ahead (z) to the sea under this cell (the sky: as far as it gets)
  if (p.y > horizon) {
    float md = length(p - moon);
    float disc = smoothfall(moonRadius, moonRadius - 0.003, md);
    float craters = fbm((p - moon) * 30.0);
    float maria = K_mmoon > 0.5 ? smoothfall(0.11, 0.07, markDistance((p - moon) / moonRadius / 1.3)) : 0.0;
    o.ink = disc * (0.7 + 0.3 * craters) * (1.0 - 0.6 * maria) + exp(-md * 12.0 * 0.075 / moonRadius) * 0.16;
    o.ink += starfield(floor(p * uRes.y), 0.001 + 0.007 * K_stars, 0.3, 0.8) * (1.0 - disc);
    o.ink += 0.06 * smoothfall(0.25, 0.0, p.y - horizon);
  } else {
    vec3 rd = normalize(vec3(p.x, p.y - horizon, 1.6));
    // With relief the waves have real height and crests hide the troughs behind them; 0 is the flat
    // sea with the waves painted on it.
    float dist = camH / -rd.y;
    if (K_relief > 0.0) dist = swellMarch(camH, rd, swellRelief(K_relief, camH, chop, height, rollAmp), wt, chop, height, front, rollAmp);
    seaDist = dist * rd.z;
    vec3 pos = rd * dist;
    vec2 w = pos.xz * 2.2;
    float e = 0.02 + dist * 0.004;
    float h = seaHeight(w, wt, chop, height, front, rollAmp);
    float hx = seaHeight(w + vec2(e, 0.0), wt, chop, height, front, rollAmp) - h;
    float hz = seaHeight(w + vec2(0.0, e), wt, chop, height, front, rollAmp) - h;
    vec3 n = normalize(vec3(-hx / e * 0.35, 1.0, -hz / e * 0.35));
    vec3 refl = reflect(rd, n);
    vec3 moonDir = normalize(vec3(moon.x, moon.y - horizon, 1.6));
    float spec = pow(max(dot(refl, moonDir), 0.0), 90.0);
    float fres = fresnelSchlick(dot(-rd, n), 0.0, 0.0);
    float fog = exp(-dist * 0.05);
    float crest = smoothstep(0.35, 0.8, h);
    o.ink = spec * 1.6 + fres * 0.1 + crest * 0.18 * fog;
    o.accent = (0.05 + 0.4 * smoothstep(0.0, 0.8, h)) * fog * (1.0 - min(spec * 2.0, 1.0));
    o.shimmer = min(spec, 1.0) * 0.3;
  }
  // Birds over the sea (gulls by default), pale where the moon lights them, dark against its disc;
  // in front of the sky, and of the sea where they lie nearer than the water under the cell (a
  // swooping party skims the crests). A camera height is some 15 m.
  if (K_birds > 0.0) {
    BirdSky flights = birdSky(K_birds, K_birdKind, K_birdFormation - 1.0, vec2(3.0, 24.0), vec2(0.5 + horizon + 0.03, 0.95), vec2(1.3, 7.7));
    flights.swoopTo = 0.2;
    BirdHit bird = birdFlights(vec2(p.x, p.y + 0.5), flights, BirdCamera(0.5 + horizon, 1.6, camH, 1.0 / 15.0, 2.0), wt, 1.0 / uRes.y);
    if (bird.cover > 0.5 && bird.depth < seaDist) {
      o.ink = dot(bird.albedo, LUMA) * 0.75 * exp(-bird.depth * 0.02);
      o.accent = 0.0;
      o.shimmer = 0.0;
    }
  }
  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  o.source = o.rgb;
  return o;
}
`;
