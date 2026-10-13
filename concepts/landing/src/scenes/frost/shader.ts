// The frost scene: a window pane on a winter night, frosting over. In front, the glass: fern
// frost and the finer fur between it (grown by sim.ts), condensation, cleared lines where a warm
// fingertip passed, and the window frame. Behind it, out of focus and blurred further wherever the
// frost is thick: a snowy street with lit windows and a lamp, or a cabin among spruces.
import { FROST_FRAME, FUR_RIPEN, FUR_SLOW_FERN, FUR_SLOW_FUR, MELT_CLEAR } from "./sim.ts";

export const frostGlsl = `
// Knobs: K_speed, K_pattern, K_warmth and K_mark drive the simulation (sim.ts); the shader reads
// K_style, K_sparkle, K_condensation, K_outside, the sky (K_time, K_cycle) and weather (K_snow,
// K_wind). Simulation textures (layouts in sim.ts): uSim0 growth, uSim1 melt, uSim2 growth clock.
const float FROST_FRAME = ${FROST_FRAME.toFixed(4)};
const float FROST_CLEAR = ${MELT_CLEAR.toFixed(4)};
const float FROST_RIPEN = ${FUR_RIPEN.toFixed(4)};
const float FROST_FUR_FERN = ${FUR_SLOW_FERN.toFixed(4)};
const float FROST_FUR_FUR = ${FUR_SLOW_FUR.toFixed(4)};
// uv height of the far kerb (street) or the clearing's far edge (cabin).
const float FROST_HORIZON = 0.3;
const vec3 FROST_LAMP = vec3(1.0, 0.68, 0.36);

// Coverage for a signed distance, out of focus by 'blur' (frame heights).
float frostSoft(float d, float blur) {
  return smoothstep(blur, -blur, d);
}

float frostBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

// An out-of-focus point light: the disc widens with the blur (its circle of confusion) and dims
// as its light spreads, with the slightly brighter rim lens bokeh has.
float frostBokeh(vec2 p, vec2 at, float size, float blur) {
  float r = size + blur * 0.9;
  float d = length(p - at);
  float disc = smoothstep(r, r - max(r * 0.3, 0.003), d);
  return disc * (1.0 + 0.4 * smoothstep(r * 0.5, r * 0.95, d)) * mix(1.0, size / r, 0.7);
}

// Where the light that makes the frost glint is, in scene coordinates (x centred, y = uv.y): the
// street lamp, or the lantern by the cabin door.
vec2 frostKeyLight(float aspect) {
  return K_outside < 0.5 ? vec2(0.36 * aspect, 0.79) : vec2(-0.1 * aspect + 0.045, FROST_HORIZON + 0.07);
}

// A snowy spruce standing at the origin: tiers of boughs, each widest at its lower edge. Returns
// an approximate signed distance; 'snowy' is how much of the point is snow lying on a bough.
float frostSpruce(vec2 q, float height, float halfWidth, out float snowy) {
  float y = q.y / height;
  float tier = fract(y * 5.0 + 0.3);
  float reach = halfWidth * max(1.0 - y, 0.0) * (0.6 + 0.4 * (1.0 - tier));
  snowy = smoothstep(0.5, 0.05, tier) * smoothstep(0.2, 0.9, abs(q.x) / max(reach, 1e-4));
  return max(abs(q.x) - reach, max(-q.y, q.y - height));
}

// The winter night beyond the glass at 'uv', everything soft by 'blur'. 'glow' collects the light
// sources' wide halos: the frost and the condensation scatter it.
vec3 frostOutside(vec2 uv, float aspect, float blur, float t, Sky sky, out vec3 glow) {
  glow = vec3(0.0);
  float tm = t * uMotion;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  bool street = K_outside < 0.5;
  // Lit windows and lamps fade out as the day comes up.
  float lights = 1.0 - 0.85 * smoothstep(0.2, 0.8, sky.day);
  vec3 lit = sky.ambient * 1.7 + sky.moonColor * 0.5 + 0.015;

  // Sky: snow clouds thicken with the snowfall; stars only through clear glass.
  vec3 dir = viewRay(uv, aspect, FROST_HORIZON, 1.0);
  vec3 col = skyColor(sky, dir);
  vec4 cloud = skyClouds(sky, dir, t, 0.3 + 0.6 * K_snow, K_wind);
  col = mix(col, cloud.rgb, cloud.a);
  float stars = skyStars(sky, dir, street ? 0.5 : 0.85) * (1.0 - cloud.a) * smoothstep(0.03, 0.01, blur);
  col += vec3(0.85, 0.9, 1.0) * stars;
  if (street) {
    // The town's light, caught low in the snowy air.
    col += vec3(0.55, 0.32, 0.16) * 0.12 * lights * exp(-max(uv.y - FROST_HORIZON, 0.0) * 5.0) * (0.5 + 0.5 * cloud.a);
  }

  vec3 snowLit = vec3(0.82, 0.88, 1.0) * lit;
  vec2 key = frostKeyLight(aspect);
  if (street) {
    // Houses across the road, one per cell, with gabled or low roofs under snow.
    float cellW = 0.46;
    float ci = floor((p.x + 50.0) / cellW);
    for (int k = -1; k <= 1; k++) {
      float fi = ci + float(k);
      float cx = (fi + 0.5) * cellW - 50.0 + (hash12(vec2(fi, 1.0)) - 0.5) * 0.06;
      float hw = cellW * (0.4 + 0.07 * hash12(vec2(fi, 2.0)));
      float wallTop = 0.47 + 0.12 * hash12(vec2(fi, 3.0));
      float roofH = hash12(vec2(fi, 4.0)) > 0.35 ? 0.07 + 0.07 * hash12(vec2(fi, 5.0)) : 0.025;
      vec2 q = p - vec2(cx, 0.0);
      float wall = frostBox(q - vec2(0.0, (FROST_HORIZON - 0.02 + wallTop) * 0.5), vec2(hw, (wallTop - FROST_HORIZON + 0.02) * 0.5), 0.0);
      float slope = roofH / (hw + 0.02);
      float roofTop = (q.y - wallTop - roofH + abs(q.x) * slope) / sqrt(1.0 + slope * slope);
      float roof = max(roofTop, max(wallTop - 0.005 - q.y, abs(q.x) - hw - 0.02));
      float cover = frostSoft(min(wall, roof), blur);
      vec3 house = roof < wall
        ? mix(vec3(0.1, 0.095, 0.1) * lit, snowLit, smoothstep(-0.024, -0.012, roofTop))
        : vec3(0.3, 0.26, 0.24) * lit;
      // Every neighbouring house's windows, even off its walls: their halos reach past them.
      float cols = 2.0 + floor(hash12(vec2(fi, 6.0)) * 2.0);
      for (int r = 0; r < 2; r++) {
        float wy = r == 0 ? FROST_HORIZON + 0.065 : wallTop - 0.07;
        for (int c = 0; c < 3; c++) {
          if (float(c) >= cols) break;
          vec2 wq = q - vec2((float(c) - (cols - 1.0) * 0.5) * (hw * 2.0 / cols), wy);
          float h = hash12(vec2(fi * 7.0 + float(c), float(r) + 11.0));
          float on = step(0.4, h) * lights;
          vec3 warm = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.8, 0.5), fract(h * 13.7));
          // One lit window in eight is a television: cool light, drifting slowly between hues.
          if (fract(h * 31.1) > 0.875) warm = mix(vec3(0.45, 0.6, 1.0), vec3(0.75, 0.55, 0.95), 0.5 + 0.5 * sin(tm * 0.7 + h * 20.0)) * 0.8;
          float power = on * (1.1 + 0.9 * fract(h * 7.3));
          vec3 glass = mix(vec3(0.03, 0.035, 0.05) + sky.ambient * 0.4, warm * power, step(0.001, on));
          house = mix(house, glass, frostSoft(frostBox(wq, vec2(0.024, 0.032), 0.004), blur));
          glow += warm * power * exp(-length(wq) / 0.09) * 0.25;
        }
      }
      col = mix(col, house, cover);
    }

    // Snow on the road and pavements: tyre ruts along the road, the lamp's pool, spill from windows.
    float groundLine = FROST_HORIZON + 0.012 * vnoise(vec2(p.x * 9.0, 2.0));
    vec3 ground = snowLit;
    float ruts = smoothstep(0.008 + blur, 0.0, abs(p.y - 0.165 - 0.004 * sin(p.x * 3.0))) + smoothstep(0.008 + blur, 0.0, abs(p.y - 0.205 - 0.004 * sin(p.x * 2.3 + 1.0)));
    ground *= 1.0 - 0.3 * ruts;
    ground += FROST_LAMP * lights * 0.6 * exp(-length((p - vec2(key.x, 0.08)) * vec2(0.7, 2.6)) / 0.22);
    ground += glow * 0.25 * smoothstep(FROST_HORIZON - 0.12, FROST_HORIZON, p.y);
    col = mix(col, ground, frostSoft(p.y - groundLine, blur));

    // Street lamps along the far kerb, one a newer white LED.
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 at = vec2((-0.38 + 0.27 * fi) * aspect, 0.57 - 0.012 * fi);
      vec3 shade = i == 1 ? vec3(0.85, 0.9, 1.0) : FROST_LAMP;
      float post = frostBox(p - vec2(at.x, (at.y + FROST_HORIZON) * 0.5), vec2(0.003, (at.y - FROST_HORIZON) * 0.5), 0.0);
      col = mix(col, vec3(0.02, 0.02, 0.025), frostSoft(post, blur) * 0.8);
      col += shade * lights * 1.6 * frostBokeh(p, at, 0.013 - 0.0015 * fi, blur);
      glow += shade * lights * exp(-length(p - at) / 0.08) * 0.3;
    }

    // The near lamp, on this side of the road: nearer, so more out of focus.
    float nearBlur = blur * 1.5 + 0.004;
    float post = frostBox(p - vec2(key.x, key.y * 0.5 - 0.02), vec2(0.008, key.y * 0.5), 0.0);
    float cap = frostBox(p - key - vec2(0.0, 0.032), vec2(0.03, 0.008), 0.006);
    col = mix(col, vec3(0.02, 0.02, 0.025) + FROST_LAMP * 0.04 * lights, frostSoft(min(post, cap), nearBlur));
    float d = length(p - key);
    col += FROST_LAMP * lights * (2.6 * frostBokeh(p, key, 0.024, nearBlur) + 0.25 * exp(-d / 0.06));
    glow += FROST_LAMP * lights * (0.8 * exp(-d / 0.1) + 0.35 * exp(-d / 0.35)) * (0.6 + 0.6 * K_snow);
  } else {
    // The far forest: narrow spruces, paled by the snowy air between.
    float farW = 0.075;
    float fc = floor((p.x + 50.0) / farW);
    float forest = 0.0;
    float farSnow = 0.0;
    for (int k = -1; k <= 1; k++) {
      float fi = fc + float(k);
      float tx = (fi + 0.5) * farW - 50.0 + (hash12(vec2(fi, 21.0)) - 0.5) * 0.04;
      float th = 0.1 + 0.12 * hash12(vec2(fi, 22.0));
      float snowy = 0.0;
      float tree = frostSoft(frostSpruce(p - vec2(tx, FROST_HORIZON + 0.01), th, th * 0.32, snowy), blur);
      if (tree > forest) { forest = tree; farSnow = snowy; }
    }
    vec3 farCol = mix(vec3(0.03, 0.05, 0.06) * (lit * 4.0), snowLit, farSnow * 0.5);
    col = mix(col, mix(farCol, col, 0.45), forest);

    // The clearing: rolling snow, warm under the cabin's windows.
    float base = FROST_HORIZON - 0.03;
    float cabinX = -0.1 * aspect;
    float groundLine = FROST_HORIZON + 0.015 * sin(p.x * 2.1 + 1.0) + 0.01 * vnoise(vec2(p.x * 6.0, 7.0));
    vec3 ground = snowLit;
    for (int w = 0; w < 2; w++) {
      float wx = cabinX + (float(w) * 2.0 - 1.0) * 0.085;
      ground += vec3(1.0, 0.62, 0.3) * lights * 0.35 * exp(-length((p - vec2(wx, base - 0.05)) * vec2(1.3, 3.0)) / 0.08);
    }
    col = mix(col, ground, frostSoft(p.y - groundLine, blur));

    // The cabin: log walls, a snow-laden gable roof, a chimney with smoke drifting on the wind.
    vec2 q = p - vec2(cabinX, base);
    float wall = frostBox(q - vec2(0.0, 0.06), vec2(0.16, 0.06), 0.0);
    float slope = 0.1 / 0.19;
    float roofTop = (q.y - 0.22 + abs(q.x) * slope) / sqrt(1.0 + slope * slope);
    float roof = max(roofTop, max(0.115 - q.y, abs(q.x) - 0.19));
    float chimney = frostBox(q - vec2(0.07, 0.2), vec2(0.014, 0.045), 0.0);
    float cabin = frostSoft(min(min(wall, roof), chimney), blur);
    vec3 logs = vec3(0.16, 0.1, 0.07) * lit * (0.85 + 0.15 * smoothstep(-0.4, 0.4, sin(q.y * 260.0)));
    vec3 cabinCol = roof < wall ? mix(vec3(0.08, 0.07, 0.07) * lit, snowLit * 1.1, smoothstep(-0.035, -0.015, roofTop)) : logs;
    if (chimney < min(wall, roof)) cabinCol = vec3(0.12, 0.1, 0.1) * lit + snowLit * smoothstep(0.035, 0.045, q.y - 0.2) * 0.8;
    for (int w = 0; w < 2; w++) {
      vec2 wq = q - vec2((float(w) * 2.0 - 1.0) * 0.085, 0.065);
      cabinCol = mix(cabinCol, vec3(1.0, 0.62, 0.3) * (1.4 + 0.15 * sin(tm * 1.7 + float(w) * 2.0)) * lights, frostSoft(frostBox(wq, vec2(0.028, 0.028), 0.003), blur));
      glow += vec3(1.0, 0.6, 0.28) * lights * exp(-length(wq) / 0.09) * 0.3;
    }
    cabinCol = mix(cabinCol, vec3(0.05, 0.035, 0.03) * lit, frostSoft(frostBox(q - vec2(0.005, 0.045), vec2(0.022, 0.045), 0.002), blur));
    col = mix(col, cabinCol, cabin);
    // Smoke from the chimney top, leaning with the wind.
    vec2 s = q - vec2(0.07, 0.245);
    if (s.y > 0.0) {
      float centre = K_wind * s.y * 0.7 + 0.02 * sin(s.y * 9.0 - tm * 0.5);
      float across = (s.x - centre) / (0.012 + s.y * 0.25);
      float puff = fbm(vec2(s.x * 14.0, s.y * 8.0 - tm * 0.15));
      float smoke = exp(-across * across) * exp(-s.y * 3.5) * smoothstep(0.3, 0.7, puff);
      col = mix(col, vec3(0.45, 0.48, 0.55) * (lit * 2.0 + 0.03), smoke * 0.5);
    }

    // Near spruces framing the clearing, left and right of the cabin.
    float nearW = 0.2;
    float nc = floor((p.x + 50.0) / nearW);
    for (int k = -1; k <= 1; k++) {
      float fi = nc + float(k);
      float tx = (fi + 0.5) * nearW - 50.0 + (hash12(vec2(fi, 31.0)) - 0.5) * 0.08;
      if (abs(tx - cabinX) < 0.32) continue;
      float th = 0.32 + 0.2 * hash12(vec2(fi, 32.0));
      float snowy = 0.0;
      float tree = frostSoft(frostSpruce(p - vec2(tx, FROST_HORIZON - 0.06), th, th * 0.33, snowy), blur * 1.3 + 0.003);
      col = mix(col, mix(vec3(0.02, 0.035, 0.035) * (lit * 3.0 + 0.02), snowLit, snowy * 0.7), tree);
    }

    // The lantern by the door.
    float d = length(p - key);
    col += vec3(1.0, 0.7, 0.4) * lights * (1.8 * frostBokeh(p, key, 0.012, blur) + 0.2 * exp(-d / 0.04));
    glow += vec3(1.0, 0.66, 0.34) * lights * (0.6 * exp(-d / 0.08) + 0.2 * exp(-d / 0.3)) * (0.6 + 0.6 * K_snow);
  }

  // Falling snow, lit by whatever light is near it.
  float flakes = snowFlakes(uv, aspect, t, K_snow, K_wind);
  col = mix(col, vec3(0.75, 0.8, 0.9) * (lit * 1.4 + 0.05) + glow * 0.9, flakes * 0.85);

  // Snow banked against the outside of the pane on the sill.
  float drift = 0.065 + 0.04 * K_snow + 0.015 * vnoise(vec2(p.x * 7.0, 4.0)) + 0.006 * vnoise(vec2(p.x * 23.0, 5.0));
  col = mix(col, snowLit * 1.15 + vec3(0.04, 0.045, 0.06) + glow * 0.2, frostSoft(uv.y - drift, blur * 0.5 + 0.002));
  return col;
}

// Frost coverage at 'uv' without its fine grain: what blurs and bends the view behind it.
float frostDensity(vec2 uv, float clock, float slow) {
  vec4 g = texture(uSim0, uv);
  float since = clock - g.r;
  float fur = smoothstep(0.0, FROST_RIPEN, since - g.g * slow) * 0.75;
  float melted = smoothstep(FROST_CLEAR - 0.05, FROST_CLEAR + 0.05, texture(uSim1, uv).r * uSimOn.y);
  return max(g.b * smoothstep(0.0, 1.5, since), fur) * (1.0 - melted) * uSimOn.x;
}

Shade sceneFrost(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  float tm = t * uMotion;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  float clock = uSimOn.z > 0.5 ? texture(uSim2, vec2(0.5)).r : 0.0;
  // Seconds the fur frost takes to spread a frame height: the style knob, fern to fur.
  float slow = FROST_FUR_FERN * pow(FROST_FUR_FUR / FROST_FUR_FERN, K_style);

  // Melt: where the glass is clear, how recently it refroze, how warm it is, the traced M.
  vec4 melt = uSimOn.y > 0.5 ? texture(uSim1, uv) : vec4(0.0);
  float thr = FROST_CLEAR + 0.12 * (vnoise(p * 90.0) - 0.5);
  float clear = smoothstep(thr - 0.05, thr + 0.05, melt.r);

  // Frost thickness around this point: the view through the glass blurs and bends with it.
  vec2 du = vec2(0.012 / aspect, 0.0);
  vec2 dv = vec2(0.0, 0.012);
  float right = frostDensity(uv + du, clock, slow);
  float left = frostDensity(uv - du, clock, slow);
  float up = frostDensity(uv + dv, clock, slow);
  float down = frostDensity(uv - dv, clock, slow);
  float dens = (2.0 * frostDensity(uv, clock, slow) + right + left + up + down) / 6.0;

  // Condensation: a milky film, heavier low on the pane; the warmth of a touch fogs the glass
  // around it, and a fingertip wipes it away where it melts the frost.
  float haze = K_condensation * (0.45 + 0.55 * fbm(p * 2.2 + vec2(0.0, tm * 0.004))) * (0.55 + 0.45 * smoothstep(0.7, 0.05, uv.y));
  haze = max(haze, smoothstep(0.03, 0.4, melt.b) * 0.7) * (1.0 - 0.9 * clear);

  // The world outside, seen through it all (and shifting a little as the viewer moves).
  vec2 film = (vec2(vnoise(p * 26.0 + 3.0), vnoise(p * 26.0 + 9.0)) - 0.5) * 0.006 * clear;
  vec2 view = uv + vec2(right - left, up - down) * 0.025 + film + uPointer * vec2(0.006, 0.004);
  vec3 glow;
  vec3 outside = frostOutside(view, aspect, 0.007 + dens * 0.05 + haze * 0.025, t, sky, glow);
  vec3 col = mix(outside, vec3(0.1, 0.12, 0.15) + glow * 0.35 + outside * 0.3, clamp(haze, 0.0, 1.0) * 0.55);

  // The frost itself: fern fronds where a branch has passed, fur filling in from them and
  // thickening for FROST_RIPEN seconds, all heavier low on the pane and in its bottom corners.
  vec4 g = uSimOn.x > 0.5 ? texture(uSim0, uv) : vec4(1e4, 0.0, 0.0, 0.0);
  float since = clock - g.r;
  float fern = g.b * smoothstep(0.0, 1.5, since);
  float fur = smoothstep(0.0, FROST_RIPEN, since - g.g * slow);
  // The crystals' grain: streaks along each branch's direction, finer than the growth field.
  float angle = g.a * 3.14159265;
  vec2 along = vec2(cos(angle), sin(angle));
  float needles = vnoise(vec2(dot(p, along), dot(p, vec2(-along.y, along.x))) * vec2(30.0, 160.0));
  float low = smoothstep(0.3, 0.04, uv.y);
  float corner = smoothstep(0.35, 0.0, min(uv.x, 1.0 - uv.x) * aspect) * low;
  float cover = clamp(max(fern * (0.85 + 0.15 * low), fur * (0.42 + 0.38 * needles) * (1.0 + 0.7 * low + 0.3 * corner)), 0.0, 1.0);
  // The edge of a cleared patch glistens, wet; frost round a warm spot goes thin and slushy.
  float rim = smoothstep(0.08, 0.0, abs(melt.r - thr)) * cover;
  float slush = smoothstep(0.12, thr, melt.r) * (1.0 - clear);
  // Refrozen glass grows new frost: fine needles, thin at first, thickening back into the pattern.
  float young = melt.g * (1.0 - clear);
  cover = mix(cover, (0.2 + 0.45 * needles) * (1.0 - 0.65 * melt.g), young);
  cover *= (1.0 - clear) * (1.0 - 0.6 * slush);

  // Light through the ice: what is behind it, scattered, plus the lamplit room on this side, so
  // the frost glows warm in front of windows and lamps and stays a cool blue-white elsewhere.
  vec3 back = outside * 0.75 + glow * 0.9;
  float line = fern * (1.0 - young);
  vec3 frostCol = vec3(0.8, 0.9, 1.0) * (vec3(0.2, 0.23, 0.28) + back * 1.1 + sky.ambient * 0.6) * (0.75 + 0.6 * line);
  // Fresh growth: the tips brightest just as they arrive.
  float tip = g.b * exp(-max(since, 0.0) / 1.5) * step(0.0, since);
  frostCol += vec3(0.7, 0.85, 1.0) * tip * 0.5 + vec3(0.9, 0.95, 1.0) * rim * 0.45;
  // Glints: a fine crystal flashes when it lies across the line to the light, so glints gather in
  // rings round the light, as scratches on glass do, and shift as the viewer moves.
  vec2 toLight = frostKeyLight(aspect) + uPointer * 0.15 - p;
  float sway = 0.08 * sin(tm * 0.3 + hash12(floor(uv * 300.0)) * TAU);
  float glint = pow(1.0 - abs(dot(rotate(along, sway), normalize(toLight + 1e-4))), 14.0) * (0.4 + 1.2 * exp(-length(toLight) / 0.6));
  float speck = step(0.97, hash12(floor(cell * 0.5) + 7.0)) * (0.5 + 0.5 * sin(tm * 1.3 + hash12(floor(cell * 0.5)) * 30.0));
  float sparkle = K_sparkle * cover * (glint + speck * 0.5) * (0.3 + dot(back, LUMA));
  frostCol += vec3(1.0, 0.97, 0.92) * sparkle * 0.9;
  col = mix(col, frostCol, cover);
  // The traced M's wet edges catch a cold light.
  col += vec3(0.25, 0.5, 0.7) * melt.a * rim * 0.4;
  o.shimmer = K_sparkle * cover * (0.05 + 0.35 * min(glint, 1.0) + 0.4 * tip);
  o.accent = melt.a * max(clear, rim) * 0.9;

  // The window frame: painted wood, lit faintly from the room and, along its inner bevel, by the
  // light outside; a hairline where its mitred rails meet; a shadow where it holds the glass.
  vec2 edges = vec2(min(uv.x, 1.0 - uv.x) * aspect, min(uv.y, 1.0 - uv.y));
  float edge = min(edges.x, edges.y);
  if (edge < FROST_FRAME) {
    float depth = edge / FROST_FRAME;
    float bevel = smoothstep(0.65, 1.0, depth);
    float grain = vnoise(vec2(edges.x < edges.y ? uv.y * 30.0 : uv.x * 30.0 * aspect, depth * 2.0));
    col = vec3(0.17, 0.155, 0.14) * (0.9 + 0.1 * grain) + (glow * 0.12 + vec3(0.06, 0.07, 0.09)) * bevel;
    col *= 1.0 - 0.35 * smoothstep(0.0025, 0.0, abs(edges.x - edges.y));
    o.shimmer = 0.0;
    o.accent = 0.0;
  } else {
    col *= 1.0 - 0.35 * smoothstep(0.006, 0.0, edge - FROST_FRAME);
  }

  // Lights run past 1: roll them off softly rather than clipping.
  col = 1.0 - exp(-col * 1.2);
  o.ink = clamp(dot(col, LUMA) * 1.25, 0.0, 1.0);
  o.rgb = col;
  o.source = col;
  return o;
}
`;
