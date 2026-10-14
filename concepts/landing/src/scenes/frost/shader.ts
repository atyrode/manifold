// The frost scene: a window pane on a winter night, frosting over. In front, the glass: feathery
// fern frost (branches grown by sim.ts, barbs drawn here), the fur frost between the fronds, thick
// rime along the frame, condensation, cleared lines where a warm fingertip passed, and the window
// frame. Behind it, out of focus and blurred further wherever the frost is thick: a snowy street
// with lit windows and lamps, or a cabin among spruces. Snow falls through that world in depth (the
// shared snowFall, hidden behind whatever is nearer), lit by the lamps and windows, and lies on its
// roofs, boughs, rails, sills, lamp cap and the outside sill as deep as uWeather.y says.
import { glslFloat } from "../../shaders/glsl.ts";
import { FROST_EMERGE_FROM, FROST_EMERGE_TO, FROST_FRAME, FROST_START, FUR_RIPEN, FUR_SCALE, FUR_SLOW_FERN, FUR_SLOW_FUR, MELT_CLEAR, RIME_GROWN, WIDTH_SCALE } from "./sim.ts";

export const frostGlsl = `
// Knobs: K_speed, K_pattern, K_warmth and K_mark drive the simulation (sim.ts); the shader reads
// K_style, K_sparkle, K_condensation, K_outside, the sky (K_time, K_cycle) and weather (K_snow,
// K_wind, and uWeather.y for the snow lying outside). Simulation textures (layouts in sim.ts): uSim0
// crystals, uSim1 melt, uSim2 growth clock, uSim3 crystal detail.
const float FROST_FRAME = ${glslFloat(FROST_FRAME)};
const float FROST_CLEAR = ${glslFloat(MELT_CLEAR)};
const float FROST_RIPEN = ${glslFloat(FUR_RIPEN)};
const float FROST_FUR_FERN = ${glslFloat(FUR_SLOW_FERN)};
const float FROST_FUR_FUR = ${glslFloat(FUR_SLOW_FUR)};
const float FROST_START = ${glslFloat(FROST_START)};
const float FROST_RIME_GROWN = ${glslFloat(RIME_GROWN)};
// The entrance's start: growth seconds over which the frame's rime and the condensation form
// (sim.ts runs the clock up from FROST_EMERGE_FROM; both are fully there by FROST_EMERGE_TO,
// which every clock at rest is past).
const float FROST_EMERGE_FROM = ${glslFloat(FROST_EMERGE_FROM)};
const float FROST_EMERGE_TO = ${glslFloat(FROST_EMERGE_TO)};
const float FROST_FUR_SCALE = ${glslFloat(FUR_SCALE)};
const float FROST_WIDTH_SCALE = ${glslFloat(WIDTH_SCALE)};
// Barbs: their spacing along a branch, frame heights, and the growth seconds per frame height
// they take to grow out from it.
const float FROST_BARB_PITCH = 0.0055;
const float FROST_BARB_LAG = 160.0;
// uv height of the far kerb (street) or the clearing's far edge (cabin).
const float FROST_HORIZON = 0.3;
const vec3 FROST_LAMP = vec3(1.0, 0.68, 0.36);

// Metres to the ground seen at screen height y: the eye looks out level at screen height 'eye',
// and 'lift' (eye height in metres times the focal length in screen heights) sets how fast the
// ground runs off toward it.
float frostGroundZ(float y, float eye, float lift) {
  return lift / max(eye - y, 0.03);
}

// Lamp light hanging in the air below a lamp head, at q from it (frame heights): a cone opening
// 'spread' across per unit down, fading over 1 / 'fall' frame heights.
float frostCone(vec2 q, float spread, float fall) {
  float down = max(-q.y, 0.0);
  float w = 0.012 + down * spread;
  return exp(-2.0 * q.x * q.x / (w * w)) * exp(-down * fall) * smoothstep(0.0, 0.03, down);
}

// An out-of-focus point light: the disc widens with the blur (its circle of confusion) and dims
// as its light spreads, with the slightly brighter rim lens bokeh has.
float frostBokeh(vec2 p, vec2 at, float size, float blur) {
  float r = size + blur * 0.9;
  float d = length(p - at);
  float disc = 1.0 - smoothstep(r - max(r * 0.3, 0.003), r, d);
  return disc * (1.0 + 0.4 * smoothstep(r * 0.5, r * 0.95, d)) * mix(1.0, size / r, 0.7);
}

// Where the light that makes the frost glint is, in scene coordinates (x centred, y = uv.y): the
// street lamp, or the lantern by the cabin door.
vec2 frostKeyLight(float aspect) {
  return K_outside < 0.5 ? vec2(0.36 * aspect, 0.79) : vec2(-0.1 * aspect + 0.045, FROST_HORIZON + 0.07);
}

// A spruce standing at the origin: tiers of boughs, each widest at its lower edge, carrying as much
// snow as 'laden' says (0 bare .. 1 heavy: the snow reaches further in along each bough, and the
// boughs sag out a little under it). Returns an approximate signed distance; 'snowy' is how much of
// the point is snow lying on a bough.
float frostSpruce(vec2 q, float height, float halfWidth, float laden, out float snowy) {
  float y = q.y / height;
  float tier = fract(y * 5.0 + 0.3);
  float reach = halfWidth * max(1.0 - y, 0.0) * (0.6 + 0.4 * (1.0 - tier)) * (1.0 + 0.08 * laden);
  float outward = abs(q.x) / max(reach, 1e-4);
  snowy = (1.0 - smoothstep(0.02, 0.08 + 0.42 * laden, tier)) * smoothstep(0.85 - 0.65 * laden, 0.95 - 0.05 * laden, outward) * smoothstep(0.0, 0.15, laden);
  return max(abs(q.x) - reach, max(-q.y, q.y - height));
}

// The winter night beyond the glass at 'uv', everything soft by 'blur'. 'glow' collects the light
// sources' wide halos: the frost and the condensation scatter it. Snow lies on the roofs, sills,
// boughs, rails and lamp cap as deep as uWeather.y says, and falls through the air between the pane
// and whatever each pixel sees, the farthest of it a veil of lit air.
vec3 frostOutside(vec2 uv, float aspect, float blur, float t, Sky sky, out vec3 glow) {
  glow = vec3(0.0);
  float tm = uMotionTime;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  bool street = K_outside < 0.5;
  float lying = clamp(uWeather.y, 0.0, 1.0);
  // The snow cloud: overcast once it snows steadily, lower and heavier toward a blizzard.
  float overcast = smoothstep(0.0, 0.5, K_snow);
  float heavy = smoothstep(0.4, 1.0, K_snow);
  // Lit windows and lamps fade out as the day comes up.
  float lights = 1.0 - 0.85 * smoothstep(0.2, 0.8, sky.day);
  // Light on the land: the sky, the moon (diffused by the snow cloud), light bouncing between
  // lying snow and a low cloud, and over the town the streets' own light thrown back down by it.
  vec3 town = street ? vec3(0.06, 0.04, 0.025) * lights * overcast : vec3(0.0);
  vec3 lit = sky.ambient * 1.7 + sky.moonColor * 0.5 * (1.0 - 0.4 * overcast) + 0.015 + town + vec3(0.02, 0.022, 0.03) * overcast * lying;
  vec3 snowLit = vec3(0.82, 0.88, 1.0) * lit;
  vec2 key = frostKeyLight(aspect);
  // Snow on flat tops (roofs, sills, rails, the lamp cap), 0..1 of its full depth: a patchy dusting
  // while it settles, a full cover deepening the harder it snows.
  float settled = snowCover(vec3(0.0, 1.0, 0.0), p * 10.0, lying) * (0.4 + 0.6 * lying);
  // The snowfall's depth along this pixel: open sky until something nearer covers it.
  float dep = 1.0;
  // Lamp light hanging in the air under the lamps, caught by the flakes and the veil.
  vec3 beam = vec3(0.0);

  // Sky: the snow cloud closes in with the snowfall and darkens toward a blizzard (over the town
  // it glows with the streets' light); stars only in its gaps and through clear glass.
  vec3 dir = viewRay(uv, aspect, FROST_HORIZON, 1.0);
  vec3 col = skyColor(sky, dir);
  vec4 cloud = skyClouds(sky, dir, t, 0.3 + 0.7 * overcast, K_wind);
  col = mix(col, cloud.rgb * (1.0 - 0.4 * heavy) + town, cloud.a);
  float stars = skyStars(sky, dir, street ? 0.5 : 0.85) * (1.0 - cloud.a) * (1.0 - smoothstep(0.01, 0.03, blur));
  col += SKY_STAR_TINT * stars;
  if (street) {
    // The town's light, caught low in the snowy air.
    col += vec3(0.55, 0.32, 0.16) * 0.12 * lights * exp(-max(uv.y - FROST_HORIZON, 0.0) * 5.0) * (0.5 + 0.5 * cloud.a);
  }

  if (street) {
    // Houses across the road, one per cell, with gabled or low roofs under the lying snow.
    float cellW = 0.46;
    float ci = floor((p.x + 50.0) / cellW);
    for (int k = -1; k <= 1; k++) {
      float fi = ci + float(k);
      float cx = (fi + 0.5) * cellW - 50.0 + (hash12(vec2(fi, 1.0)) - 0.5) * 0.06;
      float hw = cellW * (0.4 + 0.07 * hash12(vec2(fi, 2.0)));
      float wallTop = 0.47 + 0.12 * hash12(vec2(fi, 3.0));
      float roofH = hash12(vec2(fi, 4.0)) > 0.35 ? 0.07 + 0.07 * hash12(vec2(fi, 5.0)) : 0.025;
      vec2 q = p - vec2(cx, 0.0);
      float wall = sdBox(q - vec2(0.0, (FROST_HORIZON - 0.02 + wallTop) * 0.5), vec2(hw, (wallTop - FROST_HORIZON + 0.02) * 0.5), 0.0);
      float slope = roofH / (hw + 0.02);
      // The snow on the roof, frame heights deep: thick on a low roof, thinner on a steep gable,
      // overhanging the eaves a little.
      float roofSnow = 0.026 * settled * (1.0 - 0.45 * smoothstep(0.3, 1.2, slope));
      float roofTop = (q.y - wallTop - roofH + abs(q.x) * slope) / sqrt(1.0 + slope * slope);
      float roof = max(roofTop - roofSnow, max(wallTop - 0.005 - q.y, abs(q.x) - hw - 0.02 - 0.6 * roofSnow));
      float cover = softFill(min(wall, roof), blur);
      vec3 house = roof < wall
        ? mix(vec3(0.1, 0.095, 0.1) * lit, snowLit, smoothstep(-0.004 - blur, blur - 0.004, roofTop) * smoothstep(0.0, 0.004, roofSnow))
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
          house = mix(house, glass, softFill(sdBox(wq, vec2(0.024, 0.032), 0.004), blur));
          // Snow along its sill, banked against the bottom of the pane, warm under a lit window.
          float sill = 0.005 * settled;
          house = mix(house, snowLit * 1.05 + warm * power * 0.3, softFill(sdBox(wq - vec2(0.0, sill - 0.035), vec2(0.03, sill + 0.0005), 0.0), blur) * smoothstep(0.0, 0.002, sill));
          glow += warm * power * exp(-length(wq) / 0.09) * 0.25;
        }
      }
      col = mix(col, house, cover);
      dep = mix(dep, weatherDepth(20.0), cover);
    }

    // The road and pavements: banks of old snow along the kerbs, dark icy tarmac between with the
    // far lamps mirrored in it, whitening under fresh snow as it settles (the tyre ruts last); the
    // near lamp's pool and the windows' spill on top, brighter on snow than on tarmac.
    float groundLine = FROST_HORIZON + 0.012 * vnoise(vec2(p.x * 9.0, 2.0));
    float gz = frostGroundZ(p.y, 0.42, 1.7);
    float ruts = min(2.0 - smoothstep(0.0, 0.008 + blur, abs(p.y - 0.165 - 0.004 * sin(p.x * 3.0))) - smoothstep(0.0, 0.008 + blur, abs(p.y - 0.205 - 0.004 * sin(p.x * 2.3 + 1.0))), 1.0);
    float bank = max(smoothstep(0.24, 0.27, p.y), 1.0 - smoothstep(0.1, 0.13, p.y));
    float fresh = snowCover(vec3(0.0, 1.0, 0.0), vec2(p.x * gz * 0.6, 2.0 * log(gz)), lying * (1.0 - 0.4 * ruts));
    vec3 mirror = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      mirror += (i == 1 ? vec3(0.85, 0.9, 1.0) : FROST_LAMP) * exp(-abs(p.x - (-0.38 + 0.27 * float(i)) * aspect) / (0.008 + blur));
    }
    vec3 tarmac = vec3(0.035, 0.035, 0.04) * (lit * 4.0 + 0.2) + mirror * lights * 0.35 * smoothstep(0.08, 0.24, p.y);
    vec3 ground = mix(mix(tarmac, snowLit * 0.72, bank), snowLit, fresh) * (1.0 - 0.25 * ruts * fresh);
    float onSnow = max(fresh, bank);
    ground += FROST_LAMP * lights * mix(0.2, 0.6, onSnow) * exp(-length((p - vec2(key.x, 0.08)) * vec2(0.7, 2.6)) / 0.22);
    ground += glow * mix(0.08, 0.25, onSnow) * smoothstep(FROST_HORIZON - 0.12, FROST_HORIZON, p.y);
    float onGround = softFill(p.y - groundLine, blur);
    col = mix(col, ground, onGround);
    dep = mix(dep, weatherDepth(gz), onGround);

    // A post-and-rail fence along the front gardens, snow riding its rails.
    float fenceTop = FROST_HORIZON + 0.028;
    float postX = (floor(p.x / 0.07) + 0.5) * 0.07;
    float fence = min(max(abs(p.x - postX) - 0.004, max(groundLine - 0.004 - p.y, p.y - fenceTop - 0.003)),
                      min(abs(p.y - fenceTop + 0.003) - 0.003, abs(p.y - fenceTop + 0.016) - 0.0025));
    float fenceCov = softFill(fence, blur);
    col = mix(col, vec3(0.06, 0.05, 0.045) * (lit * 2.0 + 0.15), fenceCov);
    float railSnow = 0.007 * settled;
    float onRails = softFill(min(abs(p.y - fenceTop - railSnow * 0.5) - railSnow * 0.5, abs(p.y - fenceTop + 0.0135 - railSnow * 0.35) - railSnow * 0.35), blur) * smoothstep(0.0, 0.003, railSnow);
    col = mix(col, snowLit * 1.05 + glow * 0.15, onRails);
    dep = mix(dep, weatherDepth(16.0), max(fenceCov, onRails));

    // Street lamps along the far kerb, one a newer white LED. In falling snow their light hangs in
    // a cone under each, and spreads wider the thicker it falls.
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 at = vec2((-0.38 + 0.27 * fi) * aspect, 0.57 - 0.012 * fi);
      vec3 shade = i == 1 ? vec3(0.85, 0.9, 1.0) : FROST_LAMP;
      float post = sdBox(p - vec2(at.x, (at.y + FROST_HORIZON) * 0.5), vec2(0.003, (at.y - FROST_HORIZON) * 0.5), 0.0);
      float bokeh = frostBokeh(p, at, 0.013 - 0.0015 * fi, blur);
      float postCov = softFill(post, blur) * 0.8;
      col = mix(col, vec3(0.02, 0.02, 0.025), postCov);
      dep = mix(dep, weatherDepth(14.0), max(postCov, min(bokeh, 1.0)));
      col += shade * lights * 1.6 * bokeh;
      glow += shade * lights * exp(-length(p - at) / (0.08 + 0.06 * K_snow)) * 0.3;
      beam += shade * lights * frostCone(p - at, 0.45, 4.0) * 0.3 * smoothstep(FROST_HORIZON - 0.01, FROST_HORIZON + 0.02, p.y);
    }

    // The near lamp, on this side of the road: nearer, so more out of focus; snow heaps on its cap.
    float nearBlur = blur * 1.5 + 0.004;
    float post = sdBox(p - vec2(key.x, key.y * 0.5 - 0.02), vec2(0.008, key.y * 0.5), 0.0);
    float cap = sdBox(p - key - vec2(0.0, 0.032), vec2(0.03, 0.008), 0.006);
    float lamp = softFill(min(post, cap), nearBlur);
    col = mix(col, vec3(0.02, 0.02, 0.025) + FROST_LAMP * 0.04 * lights, lamp);
    float heap = 0.02 * settled;
    vec2 m = p - key - vec2(0.0, 0.039);
    float onCap = softFill(max((length(m / vec2(0.035, max(heap, 1e-4))) - 1.0) * heap, -m.y), nearBlur) * smoothstep(0.0, 0.004, heap);
    col = mix(col, snowLit * 1.1 + FROST_LAMP * lights * 0.12, onCap);
    float bokeh = frostBokeh(p, key, 0.024, nearBlur);
    dep = mix(dep, weatherDepth(6.0), max(max(lamp, onCap), min(bokeh, 1.0)));
    float d = length(p - key);
    col += FROST_LAMP * lights * (2.6 * bokeh + 0.25 * exp(-d / 0.06));
    glow += FROST_LAMP * lights * (0.8 * exp(-d / 0.1) + 0.35 * exp(-d / (0.35 + 0.2 * K_snow))) * (0.6 + 0.6 * K_snow);
    beam += FROST_LAMP * lights * frostCone(p - key, 0.55, 1.6) * 0.45;
  } else {
    // Snow on the spruce boughs, as for the flat tops: patchy while it settles, then laden.
    float laden = snowCover(vec3(0.0, 0.96, 0.28), p * 10.0, lying) * (0.4 + 0.6 * lying);
    // The far forest: narrow spruces, paled by the air between (the snowfall's veil adds more).
    float farW = 0.075;
    float fc = floor((p.x + 50.0) / farW);
    float forest = 0.0;
    float farSnow = 0.0;
    for (int k = -1; k <= 1; k++) {
      float fi = fc + float(k);
      float tx = (fi + 0.5) * farW - 50.0 + (hash12(vec2(fi, 21.0)) - 0.5) * 0.04;
      float th = 0.1 + 0.12 * hash12(vec2(fi, 22.0));
      float snowy = 0.0;
      float tree = softFill(frostSpruce(p - vec2(tx, FROST_HORIZON + 0.01), th, th * 0.32, laden, snowy), blur);
      if (tree > forest) { forest = tree; farSnow = snowy; }
    }
    vec3 farCol = mix(vec3(0.03, 0.05, 0.06) * (lit * 4.0), snowLit, farSnow * 0.5);
    col = mix(col, mix(farCol, col, 0.3), forest);
    dep = mix(dep, weatherDepth(70.0), forest);

    // The clearing: old crusted snow with dry grass poking through, going smooth and white under
    // fresh snow as it settles; warm under the cabin's windows.
    float base = FROST_HORIZON - 0.03;
    float cabinX = -0.1 * aspect;
    float groundLine = FROST_HORIZON + 0.015 * sin(p.x * 2.1 + 1.0) + 0.01 * vnoise(vec2(p.x * 6.0, 7.0));
    float gz = frostGroundZ(p.y, 0.4, 2.4);
    vec2 gp = vec2(p.x * gz * 0.6, 2.0 * log(gz));
    float fresh = snowCover(vec3(0.0, 1.0, 0.0), gp, lying);
    float tufts = smoothstep(0.62, 0.8, vnoise(gp * 1.3 + 3.0)) * (1.0 - smoothstep(0.2, 0.26, p.y));
    vec3 ground = mix(mix(snowLit * 0.8, vec3(0.08, 0.065, 0.04) * (lit * 3.0 + 0.04), tufts * 0.8), snowLit, fresh);
    for (int w = 0; w < 2; w++) {
      float wx = cabinX + (float(w) * 2.0 - 1.0) * 0.085;
      ground += vec3(1.0, 0.62, 0.3) * lights * 0.35 * exp(-length((p - vec2(wx, base - 0.05)) * vec2(1.3, 3.0)) / 0.08);
    }
    float onGround = softFill(p.y - groundLine, blur);
    col = mix(col, ground, onGround);
    dep = mix(dep, weatherDepth(gz), onGround);

    // The cabin: log walls, a gable roof under the lying snow (overhanging its eaves), a warm
    // chimney with only a rim of snow and smoke drifting on the wind.
    vec2 q = p - vec2(cabinX, base);
    float wall = sdBox(q - vec2(0.0, 0.06), vec2(0.16, 0.06), 0.0);
    float slope = 0.1 / 0.19;
    float roofSnow = 0.03 * settled;
    float roofTop = (q.y - 0.22 + abs(q.x) * slope) / sqrt(1.0 + slope * slope);
    float roof = max(roofTop - roofSnow, max(0.115 - q.y, abs(q.x) - 0.19 - 0.6 * roofSnow));
    float chimney = sdBox(q - vec2(0.07, 0.2), vec2(0.014, 0.045), 0.0);
    float cabin = softFill(min(min(wall, roof), chimney), blur);
    vec3 logs = vec3(0.16, 0.1, 0.07) * lit * (0.85 + 0.15 * smoothstep(-0.4, 0.4, sin(q.y * 260.0)));
    vec3 cabinCol = roof < wall ? mix(vec3(0.08, 0.07, 0.07) * lit, snowLit * 1.1, smoothstep(-0.006 - blur, blur - 0.006, roofTop) * smoothstep(0.0, 0.004, roofSnow)) : logs;
    if (chimney < min(wall, roof)) cabinCol = vec3(0.12, 0.1, 0.1) * lit + snowLit * smoothstep(0.035, 0.045, q.y - 0.2) * 0.8 * settled;
    for (int w = 0; w < 2; w++) {
      vec2 wq = q - vec2((float(w) * 2.0 - 1.0) * 0.085, 0.065);
      vec3 warm = vec3(1.0, 0.62, 0.3) * (1.4 + 0.15 * sin(tm * 1.7 + float(w) * 2.0)) * lights;
      cabinCol = mix(cabinCol, warm, softFill(sdBox(wq, vec2(0.028, 0.028), 0.003), blur));
      // Snow along its sill, lit by the window above it.
      float sill = 0.005 * settled;
      cabinCol = mix(cabinCol, snowLit * 1.05 + warm * 0.25, softFill(sdBox(wq - vec2(0.0, sill - 0.031), vec2(0.034, sill + 0.0005), 0.0), blur) * smoothstep(0.0, 0.002, sill));
      glow += vec3(1.0, 0.6, 0.28) * lights * exp(-length(wq) / 0.09) * 0.3;
    }
    cabinCol = mix(cabinCol, vec3(0.05, 0.035, 0.03) * lit, softFill(sdBox(q - vec2(0.005, 0.045), vec2(0.022, 0.045), 0.002), blur));
    col = mix(col, cabinCol, cabin);
    dep = mix(dep, weatherDepth(19.0), cabin);
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
      float tree = softFill(frostSpruce(p - vec2(tx, FROST_HORIZON - 0.06), th, th * 0.33, laden, snowy), blur * 1.3 + 0.003);
      col = mix(col, mix(vec3(0.02, 0.035, 0.035) * (lit * 3.0 + 0.02), snowLit, snowy * 0.75), tree);
      dep = mix(dep, weatherDepth(14.0), tree);
    }

    // A split-rail fence across the foreground, ending in a post right of the cabin: snow rides
    // its rails and post tops and drifts against its foot.
    float fenceBlur = blur * 1.3 + 0.002;
    float fy = 0.15 + 0.012 * sin(p.x * 2.4 + 0.6);
    float postX = (floor(p.x / 0.16) + 0.5) * 0.16;
    float fenceEnd = (floor((cabinX + 0.4) / 0.16) + 0.5) * 0.16 + 0.007;
    float fence = max(min(max(abs(p.x - postX) - 0.006, max(fy - p.y, p.y - fy - 0.058)),
                          min(abs(p.y - fy - 0.046) - 0.0035, abs(p.y - fy - 0.022) - 0.0035)), p.x - fenceEnd);
    float fenceCov = softFill(fence, fenceBlur);
    col = mix(col, vec3(0.11, 0.09, 0.07) * (lit * 2.5 + 0.03), fenceCov);
    float railSnow = 0.008 * settled;
    float caps = min(min(abs(p.y - fy - 0.0495 - railSnow * 0.5) - railSnow * 0.5, abs(p.y - fy - 0.0255 - railSnow * 0.35) - railSnow * 0.35),
                     max(abs(p.x - postX) - 0.007, abs(p.y - fy - 0.058 - railSnow * 0.5) - railSnow * 0.5));
    float onRails = softFill(max(caps, p.x - fenceEnd), fenceBlur) * smoothstep(0.0, 0.003, railSnow);
    float foot = fy + 0.018 * lying * (0.7 + 0.3 * vnoise(vec2(p.x * 30.0, 9.0)));
    float onFoot = softFill(max(p.y - foot, fy - 0.01 - p.y), fenceBlur) * smoothstep(0.0, 0.1, lying) * (1.0 - smoothstep(fenceEnd, fenceEnd + 0.04, p.x));
    col = mix(col, snowLit * 1.05 + glow * 0.15, max(onRails, onFoot));
    dep = mix(dep, weatherDepth(10.0), max(max(fenceCov, onRails), onFoot));

    // The lantern by the door: the snowy air round it glows.
    float d = length(p - key);
    col += vec3(1.0, 0.7, 0.4) * lights * (1.8 * frostBokeh(p, key, 0.012, blur) + 0.2 * exp(-d / 0.04));
    glow += vec3(1.0, 0.66, 0.34) * lights * (0.6 * exp(-d / 0.08) + 0.2 * exp(-d / (0.3 + 0.2 * K_snow))) * (0.6 + 0.6 * K_snow);
    beam += vec3(1.0, 0.66, 0.34) * lights * exp(-d / 0.07) * 0.3;
  }

  // Falling snow, in depth between the pane and whatever this pixel sees. The farthest fuses into
  // a veil of lit air that swallows the distance and spreads the lights into halos (a whiteout in a
  // blizzard); flakes catch the lamp and window light near them, glittering in the lamps' cones;
  // the nearest are big soft discs like the lamps' bokeh, lit faintly by the room behind the pane.
  // Behind thick frost the view smears, and flakes melt into the veil.
  Precip fall = snowFall(uv, aspect, t, K_snow, K_wind, dep);
  float smear = smoothstep(0.015, 0.05, blur);
  vec3 air = vec3(0.42, 0.46, 0.55) * (lit * 1.2 + 0.02) + glow * 0.45 + beam * 0.6 + town * 0.7;
  col = mix(col, air, clamp(fall.veil + smear * fall.cover * 0.3, 0.0, 1.0));
  vec3 flake = vec3(0.78, 0.83, 0.93) * (lit * 1.4 + 0.05) + glow * 0.9;
  float nearFlakes = fall.cover * fall.near;
  float farFlakes = (fall.cover - nearFlakes) * (1.0 - smear);
  col = mix(col, flake + beam * 1.6, farFlakes * 0.85);
  col = mix(col, flake * 0.8 + vec3(0.05, 0.045, 0.04), nearFlakes * (0.8 - 0.3 * smear));
  col += glow * nearFlakes * 0.6;

  // Snow banked against the outside of the pane on the sill: deeper as it lies (deepest in a
  // blizzard), heaped toward the side the wind blows to.
  float heaped = lying * (0.05 + 0.035 * K_snow + 0.025 * K_wind * (uv.x - 0.5));
  float drift = 0.045 + heaped + (0.006 + 0.012 * lying) * (vnoise(vec2(p.x * 7.0, 4.0)) + 0.4 * vnoise(vec2(p.x * 23.0, 5.0)));
  col = mix(col, snowLit * 1.15 + vec3(0.04, 0.045, 0.06) + glow * 0.2, softFill(uv.y - drift, blur * 0.5 + 0.002));
  return col;
}

// How far into the thick frost along the frame a point of the glass lies, in units of that
// frost's depth (under 1: inside it), by growth second 'clock'. It lies deepest along the bottom,
// where the glass is coldest, thinner up the sides and least along the top, and fills the corners
// in round.
float frostRime(vec2 uv, float aspect, float clock, float emerge) {
  float grown = smoothstep(-40.0, FROST_RIME_GROWN, clock);
  // Entering, the frost along the frame starts as a hairline on clear glass and thickens out.
  float spread = max(emerge, 0.02);
  float bottom = (uv.y - FROST_FRAME) / ((0.03 + 0.055 * grown) * spread);
  float top = (1.0 - uv.y - FROST_FRAME) / ((0.008 + 0.02 * grown) * spread);
  float side = (min(uv.x, 1.0 - uv.x) * aspect - FROST_FRAME) / ((0.012 + 0.03 * grown) * (1.5 - uv.y) * spread);
  float rail = min(bottom, top);
  float h = max(1.3 - abs(rail - side), 0.0) / 1.3;
  return min(rail, side) - h * h * 0.325;
}

// Frost thickness at 'uv' without its fine structure: what blurs and bends the view behind it.
float frostDensity(vec2 uv, float clock, float slow) {
  vec4 g = texture(uSim0, uv);
  float since = clock - g.r;
  float n = abs(g.g);
  float fronds = (1.0 - smoothstep(0.0, g.a + 0.006, n)) * smoothstep(0.0, 3.0, since) * 0.6;
  float fur = smoothstep(0.0, FROST_RIPEN, since - 1.0 - n * slow) * 0.6;
  float melted = smoothstep(FROST_CLEAR - 0.05, FROST_CLEAR + 0.05, texture(uSim1, uv).r * uSimOn.y);
  return max(fronds, fur) * (1.0 - melted) * uSimOn.x;
}

Shade sceneFrost(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  float tm = uMotionTime;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  // One dither cell, in frame heights: the finest line worth drawing.
  float px = 1.0 / uRes.y;
  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, uMotionTime));
  float clock = uSimOn.z > 0.5 ? texture(uSim2, vec2(0.5)).r : FROST_START;
  // 0 on the glass as the entrance opens, exactly 1 for every clock at rest.
  float emerge = smoothstep(FROST_EMERGE_FROM, FROST_EMERGE_TO, clock);
  // Seconds the fur frost takes to spread a frame height: the style knob, fern to fur.
  float slow = FROST_FUR_FERN * pow(FROST_FUR_FUR / FROST_FUR_FERN, K_style);

  // Melt: where the glass is clear, how recently it refroze, how warm it is, the traced M.
  vec4 melt = uSimOn.y > 0.5 ? texture(uSim1, uv) : vec4(0.0);
  float thr = FROST_CLEAR + 0.12 * (vnoise(p * 90.0) - 0.5);
  float clear = smoothstep(thr - 0.05, thr + 0.05, melt.r);

  // The nearest crystal branch (layouts in sim.ts): when it grew here, the signed distance across
  // it, the distance along it and how far its barbs reach; its fur lag, half-width, brightness and
  // a random number of its own.
  vec4 g = uSimOn.x > 0.5 ? texture(uSim0, uv) : vec4(1e4, 1.0, 0.0, 0.0);
  vec4 detail = uSimOn.w > 0.5 ? texture(uSim3, uv) : vec4(1.0, 0.0, 0.0, 0.0);
  float since = clock - g.r;
  float n = abs(g.g);
  // Barbs leave the branch every 'pitch' along it, leaning 60° toward its tip: 'phase' counts them.
  // On a coarse grid of cells they spread out to stay apart, and reach further, so every branch
  // keeps a row of distinct barbs a few cells long down each side.
  float pitch = max(FROST_BARB_PITCH, 2.6 * px);
  float phase = (g.b - 0.577 * n) / pitch;
  float reach = g.a * sqrt(pitch / FROST_BARB_PITCH);
  // Rates across the screen, taken here in uniform control flow. Inside one branch's field the
  // distances across and along it change by exactly a frame height per frame height; where two
  // fields meet they jump, and no line or barb is drawn across that seam. (A seam can fall between
  // the cells a rate is taken over, which then see half its jump: hence the low thresholds.)
  vec2 dn = vec2(dFdx(g.g), dFdy(g.g)) * uRes.y;
  vec2 da = vec2(dFdx(g.b), dFdy(g.b)) * uRes.y;
  vec2 dp = vec2(dFdx(phase), dFdy(phase));
  float seamLine = smoothstep(1.4, 2.0, length(dn));
  float seamBarb = max(seamLine, smoothstep(1.4, 2.0, length(da)));

  // The branch: a crisp line, tapering toward its tip.
  float halfWidth = max(detail.g * FROST_WIDTH_SCALE, 0.55 * px);
  float branch = (1.0 - smoothstep(halfWidth - 0.7 * px, halfWidth + 0.7 * px, n)) * (1.0 - seamLine);
  // Its barbs: short needles packed down both sides, each its own length within the branch's reach.
  float k = floor(phase + 0.5);
  float across = abs(phase - k) * pitch * 0.866;
  float barbLen = reach * (0.8 + 0.3 * hash12(vec2(k, detail.a * 97.0 + 5.0)));
  float barbPos = n / max(0.866 * barbLen, 1e-5);
  float barbHalf = max(mix(0.0009, 0.00035, barbPos), 0.45 * px);
  float barb = (1.0 - smoothstep(barbHalf - 0.7 * px, barbHalf + 0.7 * px, across)) * (1.0 - smoothstep(0.8, 1.0, barbPos)) * (1.0 - seamBarb);
  // Growth: the line fills in just behind the advancing tip; the barbs grow out after it.
  float shine = 0.55 + 0.45 * detail.b;
  float barbsIn = smoothstep(0.0, 0.6, since - n * FROST_BARB_LAG);
  float crystal = max(branch * smoothstep(0.0, 0.8, since), barb * 0.85 * barbsIn) * shine;
  // How far the fur frost lags its branch: the distance to it, roughened, shorter low on the pane.
  // Unlike the signed distance it has no seams, so the hazes below take it.
  float lag = detail.r / FROST_FUR_SCALE;
  // The veil: finer frost among a frond's barbs, a pale haze over the whole feather.
  float veil = (1.0 - smoothstep(0.0, reach * 0.9 + 1.5 * px, lag)) * smoothstep(0.0, 5.0, since - n * FROST_BARB_LAG) * mix(0.32, 0.5, K_style);

  // Fur frost: a fine whitish fleece spreading out from the branches at the style knob's pace,
  // ripening for FROST_RIPEN seconds, streaked along the barbs and thickest close to the fronds.
  float fibre = vnoise(vec2(phase * 2.2, n / pitch * 0.6));
  float low = 1.0 - smoothstep(0.04, 0.32, uv.y);
  // Rime: thick, opaque frost along the frame, ragged at its edge, reaching out along the fronds.
  float q = frostRime(uv, aspect, clock, emerge) + (vnoise(p * 16.0) - 0.5) * 0.7 + (fibre - 0.5) * 0.3;
  q -= 0.35 * (1.0 - smoothstep(0.0, reach + 0.012, lag)) * smoothstep(0.0, 3.0, since);
  float rime = 1.0 - smoothstep(0.7, 1.15, q);
  float deep = 1.0 - smoothstep(0.2, 0.8, q);
  float fur = smoothstep(0.0, FROST_RIPEN, since - 1.0 - lag * slow);
  fur *= mix(0.38, 0.8, K_style) * (1.0 - 0.35 * smoothstep(0.03, 0.15, lag)) * (0.8 + 0.2 * low + 0.3 * (1.0 - smoothstep(1.0, 3.0, q))) * (0.6 + 0.5 * fibre);
  float body = max(max(fur, veil), rime * (0.78 + 0.17 * deep));

  // The edge of a cleared patch glistens, wet; frost round a warm spot goes thin and slushy;
  // refrozen glass grows new frost, fine needles thin at first, thickening back into the pattern.
  float rim = (1.0 - smoothstep(0.0, 0.08, abs(melt.r - thr))) * max(body, crystal);
  float slush = smoothstep(0.12, thr, melt.r) * (1.0 - clear);
  float young = melt.g * (1.0 - clear);
  float keep = (1.0 - clear) * (1.0 - 0.6 * slush);
  body = mix(body, (0.1 + 0.3 * fibre) * (1.0 - 0.6 * melt.g), young) * keep;
  crystal = mix(crystal, barb * 0.6 * (1.0 - 0.6 * melt.g), young) * keep;
  rime *= keep;

  // Frost thickness around this point: the view through the glass blurs and bends with it.
  vec2 sx = vec2(0.012 / aspect, 0.0);
  vec2 sy = vec2(0.0, 0.012);
  float right = frostDensity(uv + sx, clock, slow);
  float left = frostDensity(uv - sx, clock, slow);
  float up = frostDensity(uv + sy, clock, slow);
  float down = frostDensity(uv - sy, clock, slow);
  float dens = (2.0 * max(body, crystal * 0.7) + right + left + up + down) / 6.0;

  // Condensation: a milky film, heavier low on the pane; the warmth of a touch fogs the glass
  // around it, and a fingertip wipes it away where it melts the frost.
  float haze = K_condensation * emerge * (0.45 + 0.55 * fbm(p * 2.2 + vec2(0.0, tm * 0.004))) * (1.0 - 0.45 * smoothstep(0.05, 0.7, uv.y));
  haze = max(haze, smoothstep(0.03, 0.4, melt.b) * 0.7) * (1.0 - 0.9 * clear);

  // The world outside, seen through it all (and shifting a little as the viewer moves).
  vec2 film = (vec2(vnoise(p * 26.0 + 3.0), vnoise(p * 26.0 + 9.0)) - 0.5) * 0.006 * clear;
  vec2 view = uv + vec2(right - left, up - down) * 0.025 + film + uPointer * vec2(0.006, 0.004);
  vec3 glow;
  vec3 outside = frostOutside(view, aspect, 0.007 + dens * 0.05 + haze * 0.025, t, sky, glow);
  vec3 col = mix(outside, vec3(0.1, 0.12, 0.15) + glow * 0.35 + outside * 0.3, clamp(haze, 0.0, 1.0) * 0.55);

  // Light in the ice: the room's dim light on this side, and the night behind the pane scattered
  // on through it, so the frost glows warm before windows and lamps and cool white-blue elsewhere.
  vec3 back = outside * 0.5 + glow;
  vec3 room = vec3(0.3, 0.31, 0.34) + sky.ambient * 0.7;
  vec3 ice = vec3(0.82, 0.9, 1.0);
  vec3 furCol = ice * (room * 2.0 + back * 0.9) * (1.0 + 0.3 * rime * deep);
  vec3 lineCol = ice * (room * 3.4 + back * 1.7);
  // Fresh growth: tips and new barbs brightest just as they form.
  float fresh = exp(-max(since, 0.0) / 2.0) * step(0.0, since);
  // Glints: a crystal lying across the line to the light flashes, so glints gather in rings round
  // it, as on scratched glass, and shift as the viewer moves; here and there a facet winks, slowly.
  vec2 toLight = frostKeyLight(aspect) + uPointer * 0.15 - p;
  vec2 lightDir = toLight / max(length(toLight), 1e-4);
  vec2 axis = branch >= barb ? vec2(-dn.y, dn.x) / max(length(dn), 1e-4) : vec2(-dp.y, dp.x) / max(length(dp), 1e-6);
  float sway = 0.1 * sin(tm * 0.3 + hash12(floor(uv * 240.0)) * TAU);
  float glint = pow(max(1.0 - abs(dot(rotate(axis, sway), lightDir)), 0.0), 10.0) * (0.35 + 1.4 * exp(-length(toLight) / 0.5));
  vec2 speck = floor(cell * 0.5);
  float wink = step(0.972, hash12(speck + 7.0)) * smoothstep(0.5, 1.0, sin(tm * (0.5 + 0.8 * hash12(speck + 19.0)) + hash12(speck + 31.0) * 60.0));
  float sparkle = K_sparkle * (crystal * glint * 1.2 + max(crystal, rime * 0.6) * wink * (0.6 + glint)) * (0.35 + dot(back, LUMA));
  col = mix(col, furCol, clamp(body, 0.0, 1.0));
  col = mix(col, lineCol + vec3(0.6, 0.75, 0.9) * fresh, clamp(crystal, 0.0, 1.0));
  col += vec3(1.0, 0.97, 0.92) * sparkle + vec3(0.9, 0.95, 1.0) * rim * 0.45;
  // The traced M's wet edges catch a cold light.
  col += vec3(0.25, 0.5, 0.7) * melt.a * rim * 0.4;
  float accent = melt.a * max(clear, rim) * 0.9;

  // The window frame: painted wood, lit faintly from the room and, along its inner bevel, by the
  // light outside; a hairline where its mitred rails meet; a shadow where it holds the glass.
  vec2 edges = vec2(min(uv.x, 1.0 - uv.x) * aspect, min(uv.y, 1.0 - uv.y));
  float edge = min(edges.x, edges.y);
  if (edge < FROST_FRAME) {
    float depth = edge / FROST_FRAME;
    float bevel = smoothstep(0.65, 1.0, depth);
    float grain = vnoise(vec2(edges.x < edges.y ? uv.y * 30.0 : uv.x * 30.0 * aspect, depth * 2.0));
    col = vec3(0.17, 0.155, 0.14) * (0.9 + 0.1 * grain) + (glow * 0.12 + vec3(0.06, 0.07, 0.09)) * bevel;
    col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.0025, abs(edges.x - edges.y)));
    accent = 0.0;
  } else {
    col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.006, edge - FROST_FRAME));
  }

  // Lights run past 1: roll them off softly rather than clipping.
  col = 1.0 - exp(-col * 1.2);
  return shadeOf(col, inkOf(col, 1.25, 1.0), accent);
}
`;
