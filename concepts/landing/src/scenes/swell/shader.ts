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

Shade sceneSwell(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * vec2(0.012, 0.006) * m;
  float horizon = -0.06;
  vec2 moon = vec2(-aspect * 0.2, 0.24);
  float moonRadius = 0.03 + 0.09 * K_moon;
  float height = K_height * 2.0;
  float chop = K_chop * 2.0;
  float wt = uMotionTime;

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
    float dist = 1.0 / -rd.y;
    vec3 pos = rd * dist;
    vec2 w = pos.xz * 2.2;
    float e = 0.02 + dist * 0.004;
    float h = swellHeight(w, wt, chop) * height;
    float hx = swellHeight(w + vec2(e, 0.0), wt, chop) * height - h;
    float hz = swellHeight(w + vec2(0.0, e), wt, chop) * height - h;
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
