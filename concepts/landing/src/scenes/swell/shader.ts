// The swell scene: open-ocean waves.

export const swellGlsl = `
float swellHeight(vec2 w, float t, float chop) {
  float s = 0.0;
  s += sin(dot(w, vec2(0.9, 0.42)) * 1.3 + t * 1.05) * 0.5;
  s += sin(dot(w, vec2(-0.55, 0.83)) * 2.1 + t * 1.45) * 0.25;
  s += sin(dot(w, vec2(0.18, 0.98)) * 3.7 + t * 2.05) * 0.12 * chop;
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
    float dist = camH / -rd.y;
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
  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  o.source = o.rgb;
  return o;
}
`;
