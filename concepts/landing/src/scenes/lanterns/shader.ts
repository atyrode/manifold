// The lantern river's picture: tōrō nagashi at dusk, seen from a low bank across a wide, slow river.
//
// World units are metres: x right (upstream; the river runs to the left), y up, z ahead, the eye
// LANTERNS_EYE over the water, the far bank's waterline LANTERNS_BANK ahead. Above that waterline
// the frame is the far bank (a silhouette in its own plane: tree crowns, a temple hall and a
// pagoda, a quay with stone lanterns, a vermilion arched bridge hung with lamps whose half-ring
// closes into a full circle with its reflection, an old pine), a warm glow in the haze over the
// temple grounds, the wooded hills beyond, falling away toward the sunset on the left, and the
// dusk sky with a few stars and a thin young moon low over the pine. Below it lies the water: a
// mirror of the sky's afterglow, the moon and the bank, bent by ripples into broad horizontal
// bands, darkening toward our bank; around two stones a cushion of water, a glassy lee and a wake.
//
// The lanterns come from the simulation (sim.ts), one texel each in uSim0. Each is a small box
// traced along the eye ray: wooden tray, paper walls glowing brightest level with the candle, the
// flame itself a soft drop of light seen through the paper, a column of writing on two walls of
// the nearer ones, a dark frame, an open top showing the lit far walls. Its reflection is the same
// box traced along the ray reflected off the rippled water: a wavering mirror image right under
// it, and below that its glitter: rows of wave facets that tip its light to the eye now and then,
// so the reflection runs down the water toward the viewer as stacked amber dashes that sway, thin
// out and fade (how far: K_reflection). The bank's lamps are mirrored the same way. Around each
// lantern its halo in the air (wider in mist), a pool of light on the water, and rings spreading
// where one has just been set down. The M lantern is indigo paper with the M cut through.
//
// Rain (K_rain, slanted by K_wind) belongs to the evening rather than lying over it. A deck of
// cloud draws over the dusk (pale over the afterglow in a drizzle, low and dark down to the hills
// in a downpour, glowing faintly warm grey with the temple and town lights after dark, with shafts
// of rain hanging under it), the light dims and flattens, the mist greys. The drops fall in depth
// (the shared rainFall, hidden behind whatever the eye ray meets first) and shine with the cloud
// base they refract, faint grey lines against the dark bank and water, and amber where they fall
// through the lanterns' halos; their veil swallows the far bank as it pours. The river rings in
// front of us, the rings catching the lantern light and the cloud base, and beyond, where the
// rings are too small to draw, it is a dimpled sheet of grey sheen mirroring the overcast and
// smearing every reflection. As the world wets (uWeather.x) the bank's tiles, lacquer and stone and
// the stones in the river darken and turn glossy. In heavy rain the candles gutter, and in a
// downpour some drown.
//
// Nothing changes by chance from one frame to the next: every motion is a slow function of time
// (ripples and glitter rows under 0.2 Hz, flames breathing under 0.4 Hz, a guttering candle dipping
// over a second), and drawn features stay a few cells wide or fade out before they get finer; only
// the rain itself is made of falling drops. So the scene sets no shimmer.
//
// Knobs: K_ripple, K_reflection, K_mist (water), K_current (ripples drift with the stream; the
// lanterns themselves are the sim's), K_time, K_cycle (sky), K_rain, K_wind (weather).
import { CURRENT_FAST, CURRENT_SLOW, EYE, FAR_BANK, FOCAL, FOV, HORIZON, LANTERN_HALF, LANTERN_TALL, MAX_LANTERNS, ROCK_DOWNSTREAM, ROCKS } from "./sim.ts";

/** A number as a GLSL float literal. */
const glslFloat = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value));

const rocks = ROCKS.map((rock) => `vec4(${glslFloat(rock.x)}, ${glslFloat(rock.z)}, ${glslFloat(rock.radius)}, ${glslFloat(rock.height)})`).join(", ");
const downstream = ROCK_DOWNSTREAM.map((d) => `vec2(${glslFloat(d.x)}, ${glslFloat(d.z)})`).join(", ");

export const lanternsGlsl = `
const float LANTERNS_HORIZON = ${glslFloat(HORIZON)};
const float LANTERNS_FOV = ${glslFloat(FOV)};
const float LANTERNS_FOCAL = ${glslFloat(FOCAL)};
const float LANTERNS_EYE = ${glslFloat(EYE)};
const float LANTERNS_BANK = ${glslFloat(FAR_BANK)};
const int LANTERNS_MAX = ${MAX_LANTERNS};
const float LANTERNS_HALF = ${glslFloat(LANTERN_HALF)};
const float LANTERNS_TALL = ${glslFloat(LANTERN_TALL)};
const float LANTERNS_CURRENT_SLOW = ${glslFloat(CURRENT_SLOW)};
const float LANTERNS_CURRENT_FAST = ${glslFloat(CURRENT_FAST)};
const int LANTERNS_ROCKS = ${ROCKS.length};
const vec4 LANTERNS_ROCK[${ROCKS.length}] = vec4[${ROCKS.length}](${rocks}); // x, z, radius, height (m)
const vec2 LANTERNS_DOWN[${ROCKS.length}] = vec2[${ROCKS.length}](${downstream}); // downstream from each (unit x, z)
// How far around a lantern (m, at its distance) its light can reach on screen: halo, rings, wobble.
const float LANTERNS_REACH = 2.2;
// The view faces 20 degrees left of the sky library's, toward the sunset: the afterglow stands in
// the left of the frame, and the lanterns drift toward it.
const float LANTERNS_FACING = -0.35;

// The far bank, metres along it from straight ahead.
const float LANTERNS_TEMPLE = -23.0;
const float LANTERNS_PAGODA = 22.0;
const float LANTERNS_BRIDGE = 3.0;
const float LANTERNS_ARCH_IN = 4.5;  // the bridge's arch: under its soffit, and over its deck (m)
const float LANTERNS_ARCH_OUT = 5.2;
const float LANTERNS_PINE = -47.0;
const float LANTERNS_QUAY = 1.3;   // height of the stone quay along the water
const float LANTERNS_TORO[5] = float[5](-37.0, -9.0, 13.5, 30.5, 57.0); // stone lanterns on the quay
// The pine's pads of needles: centre (m along, m up) and radii.
const vec4 LANTERNS_PADS[5] = vec4[5](
  vec4(-44.0, 7.2, 3.0, 0.85), vec4(-49.8, 8.6, 2.4, 0.75), vec4(-41.4, 5.5, 2.2, 0.65),
  vec4(-46.8, 10.3, 1.9, 0.7), vec4(-52.3, 6.4, 2.0, 0.65));

const vec3 LANTERNS_AMBER = vec3(1.0, 0.6, 0.22);
const vec3 LANTERNS_INDIGO = vec3(0.1, 0.13, 0.36);
const vec3 LANTERNS_WOOD = vec3(0.17, 0.1, 0.06);
const vec3 LANTERNS_LAMP = vec3(1.0, 0.66, 0.3);
const vec3 LANTERNS_TREES = vec3(0.07, 0.1, 0.09);
const vec3 LANTERNS_ROOF = vec3(0.14, 0.15, 0.18);
const vec3 LANTERNS_WALL = vec3(0.22, 0.18, 0.15);
const vec3 LANTERNS_STONE = vec3(0.2, 0.2, 0.21);
const vec3 LANTERNS_LACQUER = vec3(0.6, 0.15, 0.08);
const vec3 LANTERNS_HILLS = vec3(0.1, 0.14, 0.18);

// The sky library's sun or moon direction, turned about the vertical by LANTERNS_FACING.
vec3 lanternsTurn(vec3 v) {
  float c = cos(LANTERNS_FACING);
  float s = sin(LANTERNS_FACING);
  return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
}

// A range of wooded hills beyond the far bank: its height over the horizon (screen heights) at
// screen position x (screen heights from the centre). Three octaves of smooth value noise give
// rounded, overlapping crowns.
float lanternsHill(float x, float base, float rise, float salt) {
  float n = 0.62 * vnoise(vec2(x * 2.2 + salt, salt))
          + 0.28 * vnoise(vec2(x * 5.1 + salt * 1.7, salt + 3.0))
          + 0.1 * vnoise(vec2(x * 12.0 + salt * 2.3, salt + 7.0));
  return base + rise * n;
}

// Tree crowns along the far bank: one per 4.5 m, each its own size and height, over a low line of
// shrubs. Returns the canopy's top (m) at x along the bank.
float lanternsCanopy(float x) {
  float top = 2.6 + 1.6 * vnoise(vec2(x * 0.11, 3.1));
  float cx = floor(x / 4.5);
  for (int i = -1; i <= 1; i++) {
    float c = cx + float(i);
    float r = 1.8 + 2.2 * hash12(vec2(c, 7.7));
    float centre = (c + 0.5 + 0.35 * (hash12(vec2(c, 3.3)) - 0.5)) * 4.5;
    float crown = 3.8 + 4.5 * hash12(vec2(c, 9.1)) * (0.4 + 0.6 * vnoise(vec2(c * 0.37, 1.3)));
    float d = (x - centre) / r;
    if (abs(d) < 1.0) top = max(top, crown + 0.85 * r * sqrt(1.0 - d * d));
  }
  return top;
}

// Lay material a (rgb albedo, a: how glossy it turns when wet) over the bank with coverage c.
void lanternsOver(inout vec4 alb, inout float cover, vec4 a, float c) {
  alb = mix(alb, a, c);
  cover = max(cover, c);
}

// A lit window or screen on the bank: dx from its axis, half-width hw, from h0 to h1 high. Returns
// x: its light as it is, y: its light drawn out up and down by blur (m), keeping its total, for the
// glitter of its reflection.
vec2 lanternsPane(float dx, float h, float hw, float h0, float h1, float foot, float blur) {
  float hh = 0.5 * (h1 - h0);
  float off = max(abs(h - 0.5 * (h0 + h1)) - hh, 0.0);
  float sharp = off / foot;
  float drawn = off / (foot + blur);
  return smoothstep(-foot, foot, hw - dx) * vec2(exp(-sharp * sharp), exp(-drawn * drawn) * hh / (hh + 0.6 * blur));
}

// A small lamp of radius r at offset d from it: x as it is, y drawn out up and down by blur.
vec2 lanternsLampAt(vec2 d, float r, float blur) {
  float ry = r + blur;
  float across = exp(-d.x * d.x / (r * r));
  return across * vec2(exp(-d.y * d.y / (r * r)), exp(-d.y * d.y / (ry * ry)) * r / ry);
}

// The far bank in its own plane, b = (along the bank, height over its waterline) in metres, back
// to front: tree crowns, the temple's main hall and its pagoda, two houses, the quay with its stone
// lanterns, the arched bridge and an old pine leaning out over the water. foot is a cell's size
// there (m) for soft edges, blur how far the water draws the lamps out (m). Returns coverage; alb
// is the surface colour to light (rgb) and how glossy it turns in the rain (a: tiled roofs and
// lacquer most, stone less, plaster and trees hardly), lamp the light of lamps and windows (x
// sharp, y drawn out; before dusk fades them in), gap how much of the bridge's arch shows the
// misty inlet through it.
float lanternsBank(vec2 b, float foot, float blur, out vec4 alb, out vec2 lamp, out float gap) {
  float x = b.x;
  float h = b.y;
  alb = vec4(LANTERNS_TREES, 0.0);
  lamp = vec2(0.0);
  gap = 0.0;
  if (h > 22.0) return 0.0;

  // Tree crowns, kept low under the pine and below the hall's ridge and the pagoda's upper roofs,
  // so those stand clear against the hills.
  float top = lanternsCanopy(x);
  top = min(top, mix(40.0, 8.6, 1.0 - smoothstep(11.0, 15.0, abs(x - LANTERNS_TEMPLE))));
  top = min(top, mix(40.0, 7.6, 1.0 - smoothstep(4.0, 7.0, abs(x - LANTERNS_PAGODA))));
  top = min(top, mix(40.0, 4.2, 1.0 - smoothstep(6.0, 10.0, abs(x - LANTERNS_PINE))));
  // Only low shrubs behind the bridge, so its arch stands against the hills and the mist.
  top = min(top, mix(40.0, 2.6, 1.0 - smoothstep(7.5, 10.5, abs(x - LANTERNS_BRIDGE))));
  float cover = smoothstep(-foot, foot, top - h);

  // The main hall: a hipped-and-gabled roof whose eaves sweep out and curl up at the tips, a pair
  // of fish-tail ornaments on the ridge, walls under it; its shoji glow between the posts at dusk.
  float dx = abs(x - LANTERNS_TEMPLE);
  if (dx < 13.5) {
    float tt = clamp((dx - 5.0) / 7.6, 0.0, 1.0);
    float roofTop = 6.3 + 5.0 * pow(1.0 - tt, 1.8) + 0.75 * pow(tt, 5.0);
    float roofUnder = roofTop - mix(1.5, 0.55, tt);
    float walls = smoothstep(-foot, foot, 9.6 - dx);
    float hall = smoothstep(-foot, foot, 12.6 - dx) * smoothstep(-foot, foot, roofTop - h) * max(walls, smoothstep(-foot, foot, h - roofUnder));
    float shibi = smoothstep(-foot, foot, 0.3 - abs(dx - 4.75)) * smoothstep(-foot, foot, 12.3 - h);
    vec4 a = h > roofUnder ? vec4(LANTERNS_ROOF, 1.0) : (h < LANTERNS_QUAY + 0.8 ? vec4(LANTERNS_STONE, 0.6) : vec4(LANTERNS_WALL, 0.15));
    lanternsOver(alb, cover, a, max(hall, shibi));
    float post = abs(fract((x - LANTERNS_TEMPLE) / 2.2 + 0.5) - 0.5) * 2.2;
    lamp += lanternsPane(dx, h, 8.6, 2.5, 5.3, foot, blur) * smoothstep(0.1, 0.22, post) * 0.6;
  }

  // The pagoda: three roofs, each smaller, with upturned eaves, on storeys stepping in; a mast with
  // five rings and a jewel on top; a lamp hung under each tip of the lowest eaves.
  dx = abs(x - LANTERNS_PAGODA);
  if (dx < 5.8) {
    float last = LANTERNS_QUAY + 0.7;
    float tower = smoothstep(-foot, foot, 3.4 - dx) * smoothstep(-foot, foot, last - h);
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float eave = 5.4 + 3.7 * fi;
      float wide = 5.2 - 0.9 * fi;
      float core = 2.2 - 0.4 * fi;
      float tt = clamp((dx - 0.5 * core) / (wide - 0.5 * core), 0.0, 1.0);
      float roofTop = eave + 1.45 * pow(1.0 - tt, 1.6) + 0.45 * pow(tt, 5.0);
      float roofUnder = roofTop - mix(0.95, 0.4, tt);
      float roof = smoothstep(-foot, foot, wide - dx) * smoothstep(-foot, foot, roofTop - h) * smoothstep(-foot, foot, h - roofUnder);
      float storey = smoothstep(-foot, foot, core - dx) * step(last, h) * step(h, roofUnder + 0.1);
      tower = max(tower, max(roof, storey));
      last = roofTop - 0.2;
    }
    float mast = smoothstep(-foot, foot, 0.26 - dx) * step(last, h) * smoothstep(-foot, foot, 20.4 - h);
    float rk = (h - last - 0.6) / 0.75;
    float rings = smoothstep(-foot, foot, 0.62 - 0.05 * rk - dx) * smoothstep(-0.1, 0.1, 0.24 - abs(fract(rk) - 0.5)) * step(0.0, rk) * step(rk, 5.0);
    float jewel = smoothstep(-foot, foot, 0.42 - length(vec2(dx, h - 20.7)));
    lanternsOver(alb, cover, vec4(LANTERNS_ROOF, 0.9), max(max(tower, mast), max(rings, jewel)));
    lamp += lanternsLampAt(vec2(dx - 4.75, h - 5.1), 0.3, blur) * 0.9;
  }

  // Two houses past the pagoda, gabled, a window lit in each.
  for (int i = 0; i < 2; i++) {
    float cx = i == 0 ? 37.0 : 48.5;
    float hw = i == 0 ? 4.2 : 5.0;
    float eaves = i == 0 ? 4.3 : 4.8;
    float d = abs(x - cx);
    if (d > hw + 1.0) continue;
    float ridge = eaves + 0.4 + (hw + 0.7 - d) * 0.45;
    float house = smoothstep(-foot, foot, hw + 0.7 - d) * smoothstep(-foot, foot, ridge - h) * max(smoothstep(-foot, foot, hw - d), smoothstep(-foot, foot, h - eaves));
    lanternsOver(alb, cover, h > eaves ? vec4(LANTERNS_ROOF, 1.0) : vec4(LANTERNS_WALL, 0.15), house);
    float window = (i == 0) == (x < cx) ? 0.8 : 0.2;
    lamp += lanternsPane(abs(d - 0.45 * hw), h, 0.5, 2.3, 3.2, foot, blur) * window;
  }

  // The quay along the water, open where the inlet runs in under the bridge, its coping lighter.
  vec2 bd = vec2(x - LANTERNS_BRIDGE, h);
  float rb = length(bd);
  float quay = smoothstep(-foot, foot, LANTERNS_QUAY - h) * smoothstep(-foot, foot, rb - LANTERNS_ARCH_IN);
  lanternsOver(alb, cover, h > LANTERNS_QUAY - 0.18 ? vec4(LANTERNS_STONE * 1.35, 0.7) : vec4(LANTERNS_STONE, 0.6), quay);

  // Stone lanterns on the quay: a foot, a pillar, a firebox with its window lit, a curved cap and
  // a jewel.
  for (int i = 0; i < 5; i++) {
    float d = abs(x - LANTERNS_TORO[i]);
    if (d > 0.8) continue;
    float y = h - LANTERNS_QUAY;
    float w = y < 0.25 ? 0.42 : y < 1.05 ? 0.19 : y < 1.22 ? 0.38 : y < 1.66 ? 0.3 : y < 1.94 ? 0.64 - (y - 1.66) * 1.4 : y < 2.2 ? 0.13 : -1.0;
    lanternsOver(alb, cover, vec4(LANTERNS_STONE, 0.6), smoothstep(-foot, foot, w - d) * step(0.0, y));
    lamp += lanternsPane(d, y, 0.17, 1.3, 1.58, foot, blur) * 1.1;
  }

  // The arched bridge: a vermilion half-ring standing on the water, so that with its reflection it
  // closes into a full circle, the lacquer catching the sky along its crown; a railing with posts
  // along the deck above the quay; nine lamps on the rail, which with their reflections make a ring
  // of lights round the misty eye of the arch.
  float bx = abs(x - LANTERNS_BRIDGE);
  if (bx < 7.5 && h > -foot) {
    float arch = smoothstep(-foot, foot, rb - LANTERNS_ARCH_IN) * smoothstep(-foot, foot, LANTERNS_ARCH_OUT - rb);
    float ang = atan(max(bd.y, 0.0), bd.x);
    float post = abs(fract(ang / 0.2 + 0.5) - 0.5) * 0.2 * rb;
    float rail = max(smoothstep(-foot, foot, 0.12 - abs(rb - LANTERNS_ARCH_OUT - 0.85)), smoothstep(-foot, foot, 0.1 - post) * step(rb, LANTERNS_ARCH_OUT + 0.9));
    rail *= step(LANTERNS_ARCH_OUT, rb) * smoothstep(-foot, foot, h - LANTERNS_QUAY);
    float crown = smoothstep(LANTERNS_ARCH_OUT - 0.3, LANTERNS_ARCH_OUT, rb);
    lanternsOver(alb, cover, vec4(LANTERNS_LACQUER * (1.0 + 0.8 * crown), 0.85), max(arch, rail) * step(0.0, h));
    gap = smoothstep(-foot, foot, LANTERNS_ARCH_IN - rb) * step(0.0, h);
    cover = max(cover, gap);
    float stepA = (3.14159265 - 0.6) / 8.0;
    float k0 = clamp(floor((ang - 0.3) / stepA), 0.0, 7.0);
    for (int j = 0; j < 2; j++) {
      float th = 0.3 + (k0 + float(j)) * stepA;
      vec2 d = bd - (LANTERNS_ARCH_OUT + 1.2) * vec2(cos(th), sin(th));
      lamp += lanternsLampAt(d, 0.24, blur) + lanternsLampAt(d, 0.8, blur) * 0.1;
    }
  }

  // An old pine leaning out over the water from the left, its needles in flat pads.
  if (abs(x - LANTERNS_PINE) < 8.5) {
    float trunk = min(min(segmentDistance(b, vec2(-50.6, 0.8), vec2(-48.7, 4.6)), segmentDistance(b, vec2(-48.7, 4.6), vec2(-44.4, 6.9))),
                      segmentDistance(b, vec2(-48.7, 4.6), vec2(-51.4, 7.9)));
    float pine = smoothstep(-foot, foot, 0.4 - trunk);
    for (int i = 0; i < 5; i++) {
      vec4 pad = LANTERNS_PADS[i];
      vec2 q = (b - pad.xy) / pad.zw;
      q.y *= q.y < 0.0 ? 1.7 : 1.0; // flat underneath
      float tufts = 0.22 * (vnoise(vec2(x * 1.7, float(i) * 3.1)) - 0.5);
      pine = max(pine, smoothstep(-foot, foot, (1.0 - tufts - length(q)) * pad.w));
    }
    lanternsOver(alb, cover, vec4(LANTERNS_TREES * 0.8, 0.0), pine);
  }
  return cover;
}

// The young moon, a thin crescent low over the old pine at dusk: lit on the side toward the set
// sun (down and to the left), the rest of its disc faintly grey with earthshine, in a soft halo.
// Fixed in the frame: e in screen heights right of the centre and above the horizon. soft widens
// its edges (in the rippled mirror). Returns x: the lit crescent, y: the whole disc, z: the halo.
const vec2 LANTERNS_MOON = vec2(-0.66, 0.205);
const float LANTERNS_MOON_R = 0.021;
vec3 lanternsMoon(vec2 e, float soft) {
  vec2 d = e - LANTERNS_MOON;
  float r = LANTERNS_MOON_R;
  float aa = soft + 1.2 / uRes.y;
  float disc = 1.0 - smoothstep(r - aa, r + aa, length(d));
  // The dark limb: the disc again, shifted up and to the right, leaving a crescent ~4 cells thick.
  float lit = disc * smoothstep(r - aa, r + aa, length(d - r * 0.32 * vec2(0.55, 0.835)));
  return vec3(lit, disc, exp(-dot(d, d) / (9.0 * r * r)));
}

// A sparse scatter of stars over the dusk sky, fixed in the frame (e as for the moon): a few
// bright, more faint, each a soft dot two to four cells across that breathes very slowly.
float lanternsStars(vec2 e) {
  vec2 g = e * 24.0;
  vec2 id = floor(g);
  float h = hash12(id + vec2(17.3, 4.1));
  if (h > 0.1) return 0.0;
  float m = h / 0.1;
  m *= m; // magnitudes: mostly faint
  vec2 c = 0.25 + 0.5 * vec2(hash12(id + 3.1), hash12(id.yx + 8.9));
  float r = (1.0 + 1.1 * m) * 24.0 / uRes.y; // radius 1..2 cells, in grid units
  float star = 1.0 - smoothstep(0.35 * r, r, length(g - id - c));
  float breathe = 0.85 + 0.15 * sin(uTime * uMotion * (0.2 + 0.3 * fract(h * 37.0)) + h * 91.0);
  return star * (0.4 + 0.6 * m) * breathe;
}

// The rain cloud's underside, unmottled, from haze (the sky's colour low over the bank): a grey
// that darkens as the rain grows heavy. At dusk and after dark the cloud still glows faintly with
// the temple's lamps and the town beyond, a warm grey it never falls below, so the river has a
// sheen to mirror and the drops something to refract.
const vec3 LANTERNS_CLOUD_GLOW = vec3(0.17, 0.155, 0.14);
vec3 lanternsCloudBase(vec3 haze) {
  vec3 grey = mix(vec3(dot(haze, LUMA)), haze, 0.35);
  return max(grey, LANTERNS_CLOUD_GLOW) * mix(0.95, 0.65, smoothstep(0.35, 1.0, K_rain));
}

// The rain's sky. As it rains a deck of cloud draws over the dusk: thin and pale in a drizzle,
// the afterglow still showing in a band under it; lower, darker and down to the hills in a
// downpour; its underside mottled by broad, slow swells drifting with the wind. Under it, from
// steady rain on, grey shafts of rain hang down behind the hills, drifting too. e in screen
// heights (right of the centre, above the horizon), haze the sky's colour low over the bank.
// Returns the deck's colour and, in w, how much of the sky it hides; shaft returns how strongly a
// shaft of rain stands here (0..1).
vec4 lanternsOvercast(vec2 e, vec3 haze, float tm, out float shaft) {
  shaft = 0.0;
  if (K_rain <= 0.0) return vec4(0.0);
  float heavy = smoothstep(0.35, 1.0, K_rain);
  float drift = K_wind * tm * 0.01;
  float swell = 0.65 * vnoise(vec2(e.x * 2.2 - drift, e.y * 7.0 + 1.3)) + 0.35 * vnoise(vec2(e.x * 5.5 - drift * 1.7, e.y * 16.0 + 6.1));
  vec3 deck = lanternsCloudBase(haze) * (0.8 + 0.4 * swell);
  float base = mix(0.11, -0.02, heavy); // the deck's lower edge, above the horizon
  float cover = sqrt(K_rain) * smoothstep(base, base + 0.05 + 0.05 * swell, e.y);
  shaft = smoothstep(0.55, 0.85, vnoise(vec2(e.x * 3.2 - drift * 2.0, 4.7))) * smoothstep(0.25, 0.7, K_rain);
  return vec4(deck, cover);
}

// What a ray sees beyond the water: the sky (with a few stars when seen directly) and the young
// moon, or the rain's deck of cloud and its shafts, the hills, a warm glow in the haze over the
// temple grounds, the far bank where the ray crosses its plane (its tiles, lacquer and stone
// glossy in the wet), and mist lying along the bank's foot. o is where the ray leaves (the eye, or
// a point on the water); lift tips the sky lookup up a little for a rough mirror (and softens the
// moon); foot is a cell's size at the bank (m), blur how far the water draws its lamps out.
// Returns the colour without the bank's lamps; lamp returns their light (x as seen, y drawn out),
// faded in with the dusk and veiled by the mist, for the caller to lay on.
vec3 lanternsBeyond(vec3 o, vec3 r, float lift, Sky sky, vec3 lit, vec3 haze, float dark, float tm, float foot, float blur, bool direct, out vec2 lamp) {
  vec3 col = skyColor(sky, normalize(r + vec3(0.0, lift, 0.0)));
  float ex = r.x / r.z * LANTERNS_FOCAL;
  float ey = r.y / r.z * LANTERNS_FOCAL;
  float shaft;
  vec4 deck = lanternsOvercast(vec2(ex, ey), haze, tm, shaft);
  if (direct) {
    col += vec3(0.85, 0.9, 1.0) * skyStars(sky, r, 0.55) * (1.0 - deck.w);
    float shown = (1.0 - sky.day) * clamp(0.35 + sky.night, 0.0, 1.0) * smoothstep(0.03, 0.09, ey) * (1.0 - deck.w);
    shown *= 1.0 - smoothstep(0.1, 0.3, dot(col, LUMA)); // lost in the afterglow
    col += vec3(0.82, 0.87, 1.0) * 0.75 * lanternsStars(vec2(ex, ey)) * shown;
  }
  vec3 moon = lanternsMoon(vec2(ex, ey), 0.5 * lift);
  float evening = (1.0 - smoothstep(-0.06, 0.02, sky.sun.y)) * (1.0 - 0.9 * deck.w); // dim through thin cloud
  col += (vec3(0.056, 0.063, 0.084) * moon.y + vec3(1.0, 0.9, 0.72) * 1.3 * moon.x + vec3(0.5, 0.45, 0.4) * 0.1 * moon.z) * evening;
  col = mix(col, deck.rgb, deck.w);

  // Two ranges of hills, the further paler (aerial perspective), as in an ink-wash painting. They
  // fall away toward the sunset on the left, so the afterglow lies low over the bank there, and
  // the river can mirror it.
  float aa = max(1.2 / uRes.y, foot * LANTERNS_FOCAL / LANTERNS_BANK);
  float fall = mix(0.3, 1.0, smoothstep(-0.95, 0.2, ex));
  vec3 hills = LANTERNS_HILLS * lit;
  col = mix(col, mix(haze, hills, 0.35 + 0.2 * dark), smoothstep(-aa, aa, lanternsHill(ex, 0.075, 0.12, 2.0) * fall - ey));
  col = mix(col, mix(haze, hills, 0.65 + 0.2 * dark), smoothstep(-aa, aa, lanternsHill(ex, 0.035, 0.08, 9.0) * fall - ey));
  // Shafts of rain falling on the hills, under the deck.
  col = mix(col, deck.rgb * 0.85, shaft * 0.3 * (1.0 - deck.w));

  float run = (LANTERNS_BANK - o.z) / r.z;
  vec2 b = vec2(o.x + r.x * run, o.y + r.y * run);
  // Lanterns lit among the trees of the temple grounds warm the haze above the hall, so its roofs
  // stand dark against a soft amber glow (and the river mirrors it below); rain thickens the haze.
  vec2 grounds = (b - vec2(LANTERNS_TEMPLE, 9.5)) / vec2(17.0, 6.0);
  col += vec3(1.0, 0.56, 0.24) * 0.1 * dark * (0.7 + 0.6 * K_mist + 0.5 * K_rain) * exp(-dot(grounds, grounds));
  vec4 alb;
  float gap;
  float cover = lanternsBank(b, foot, blur, alb, lamp, gap);
  // Wet, the bank darkens (plaster and bark most), and tiles, lacquer and stone take a sheen of
  // the pale sky.
  float wet = uWeather.x;
  vec3 surface = wetten(alb.rgb, wet, 0.7 - 0.6 * alb.a) * lit * 1.3;
  surface += mix(haze, deck.rgb, deck.w) * 0.55 * alb.a * wetGloss(wet, 0.7);
  col = mix(col, mix(surface, haze * 0.45, gap * 0.85), cover);
  lamp *= dark;

  // Mist lying along the foot of the bank, drifting downstream.
  float drift = vnoise(vec2(b.x * 0.05 + tm * 0.02, 4.0));
  float veil = clamp(K_mist * exp(-max(b.y, 0.0) / 3.5) * (0.55 + 0.45 * drift), 0.0, 0.85);
  col = mix(col, haze, veil);
  lamp *= 1.0 - 0.6 * veil;
  // The rain between the water and the bank softens its reflection as the eye's own rain veil
  // softens the bank itself (the caller's rainFall).
  if (!direct) {
    float murk = 0.45 * smoothstep(0.2, 1.0, K_rain);
    col = mix(col, mix(haze, deck.rgb, deck.w), murk);
    lamp *= 1.0 - murk;
  }
  return col;
}

// The river's surface: five trains of ripples, crests mostly along the current, running slowly
// across it and carried downstream by drift (m). Returns the slope (dh/dx, dh/dz) of the trains
// these cells can draw and, in z, the slope variance of those too fine to draw, which roughen the
// mirror instead (as LEAN mapping does, Olano & Baker 2010). A train is drawn only once its
// wavelength spans a dozen cells; finer ones would crawl through the dither.
vec3 lanternsRipples(vec2 p, float tm, vec2 cellSize, float amp, float drift) {
  vec2 slope = vec2(0.0);
  float hidden = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float wavelength = 6.0 * pow(0.53, fi);
    float turn = 0.5 * sin(fi * 2.4 + 0.7);
    vec2 along = vec2(sin(turn), cos(turn));
    float k = TAU / wavelength;
    float s = amp * (0.06 - 0.007 * fi);
    float seen = smoothstep(7.0, 14.0, wavelength / max(length(along * cellSize), 1e-6));
    // Deep-water waves, slowed (more so the finer) so nothing passes a cell faster than ~0.15 Hz.
    float omega = 0.14 * sqrt(9.81 * k) * (1.0 - 0.1 * fi);
    float phase = k * dot(along, p + vec2(drift, 0.0)) - omega * tm + fi * 1.9;
    slope += along * cos(phase) * s * seen;
    hidden += 0.5 * s * s * (1.0 - seen);
  }
  return vec3(slope, hidden);
}

// Rows of wave facets that can catch a light. A light mirrored at a slope the ripples only now and
// then reach is seen in the few facets tilted just right, and those lie along the crests: its
// reflection breaks into short horizontal dashes stacked down the water. The rows are spaced in
// proportion to their distance (evenly in log z), so each stays several cells tall from our bank to
// the far one, and they creep toward the viewer. p is the point on the water (x, z). Returns x: how
// near this point is to the middle of its row (0..1), y: the row's luck here (0..1, slowly
// changing along the row and in time; a row lights for a light when its luck beats the odds), z:
// how far the row sways sideways (-1..1).
vec3 lanternsGlitter(vec2 p, float tm) {
  // Rows 11% of their distance apart: about 15 cells on screen 15 m out, 6 cells 40 m out.
  float phase = log(p.y) / 0.11 + tm * 0.06;
  float row = floor(phase);
  float h = hash12(vec2(row, 3.7));
  float f = fract(phase);
  float d = (f - 0.5 - 0.3 * (h - 0.5)) / (0.13 + 0.1 * fract(h * 17.3));
  float luck = vnoise(vec2(p.x * 0.9 + row * 5.3, row * 1.7 + tm * 0.07));
  // Zero at the row's edges, where its luck and sway hand over to the next row's.
  float dash = exp(-d * d) * (1.0 - smoothstep(0.36, 0.5, abs(f - 0.5)));
  return vec3(dash, luck, sin(row * 2.1 + tm * 0.4));
}

// A lantern's box along a ray. The ray crosses the lantern's axis plane at lateral offset u and
// height v0 (m) and rises climb metres per metre further on (negative looking down; its shift
// across over the box's depth is too small to matter). The box: a square of half-side a turned by
// the angle whose cosine and sine are c and s, hl tall, standing on the water. Returns the wall
// met first (0 facing us when unturned, 1 its right, 2 its back, 3 its left; 4 down into the open
// top; -1 nothing), where across it (-1..1, left to right seen from outside; for the top, 0..1 from
// the front rim to the back), the height of the hit and its depth offset.
vec4 lanternsBox(float u, float v0, float climb, float c, float s, float a, float hl) {
  // The depths at which the ray's column is inside the square: the overlap of two slabs.
  float lo1 = -1e4;
  float hi1 = 1e4;
  float lo2 = -1e4;
  float hi2 = 1e4;
  if (abs(s) > 1e-4) {
    float p = (-a - u * c) / s;
    float q = (a - u * c) / s;
    lo1 = min(p, q);
    hi1 = max(p, q);
  } else if (abs(u * c) > a) {
    return vec4(-1.0);
  }
  if (abs(c) > 1e-4) {
    float p = (-a + u * s) / c;
    float q = (a + u * s) / c;
    lo2 = min(p, q);
    hi2 = max(p, q);
  } else if (abs(u * s) > a) {
    return vec4(-1.0);
  }
  float w0 = max(lo1, lo2);
  float w1 = min(hi1, hi2);
  if (w0 > w1) return vec4(-1.0);
  float v = v0 + climb * w0;
  if (v >= 0.0 && v <= hl) {
    float lx = u * c + w0 * s;
    float lz = -u * s + w0 * c;
    if (lo1 > lo2) return vec4(lx > 0.0 ? 1.0 : 3.0, (lx > 0.0 ? lz : -lz) / a, v, w0);
    return vec4(lz > 0.0 ? 2.0 : 0.0, (lz > 0.0 ? -lx : lx) / a, v, w0);
  }
  if (v > hl && climb < 0.0) {
    float wt = (hl - v0) / climb;
    if (wt <= w1) return vec4(4.0, (wt - w0) / max(w1 - w0, 1e-4), hl, wt);
  }
  return vec4(-1.0);
}

// Paper colours: mostly amber, some gold and vermilion, now and then plain white paper.
vec3 lanternsPaper(float seed) {
  float h = fract(seed * 7.31);
  return h < 0.42 ? vec3(1.0, 0.56, 0.2) : h < 0.68 ? vec3(1.0, 0.72, 0.3) : h < 0.88 ? vec3(1.0, 0.42, 0.24) : vec3(1.0, 0.84, 0.6);
}

// A candle breathing: two slow sines, each lantern its own (under 0.4 Hz, so the dither holds).
float lanternsFlicker(float seed, float tm) {
  return 0.9 + 0.06 * sin(tm * 1.1 + seed * 31.0) + 0.04 * sin(tm * 2.3 + seed * 17.0);
}

// A lantern's wall where a ray meets it (hit, from lanternsBox), lit from within: the paper glows
// brightest level with the candle and dims toward the corners, the frame and the wooden tray stay
// dark, and the flame shows through the paper as a soft drop of light where the ray passes it
// (u, v0: where the ray crosses the lantern's axis plane). Regular lanterns carry a column of
// writing on two walls; the M lantern is indigo paper with the M cut through those two. cpm: cells
// per metre at the lantern. Returns the colour; glow is how much of it is lamplight (the accent).
vec3 lanternsWall(vec4 hit, float u, float v0, float size, vec3 paper, float on, float seed, bool mark, float cpm, float tm, vec3 lit, out float glow) {
  float a = LANTERNS_HALF * size;
  float hl = LANTERNS_TALL * size;
  float tray = 0.16 * hl;
  if (hit.x > 3.5) {
    // Down through the open top: the far walls from inside, lit straight by the flame.
    glow = on * (mark ? 0.5 : 1.0);
    return (mark ? LANTERNS_AMBER * 0.7 : paper * (1.15 + 0.3 * hit.y)) * on + lit * 0.05;
  }
  if (hit.z < tray) {
    glow = 0.0;
    return LANTERNS_WOOD * (lit * 0.9 + paper * on * 0.06);
  }
  float across = hit.y;
  float y = (hit.z - tray) / (hl - tray);
  bool front = hit.x < 0.5 || (hit.x > 1.5 && hit.x < 2.5);
  float shine = 0.5 + 0.6 * exp(-across * across * 1.1 - (y - 0.3) * (y - 0.3) * 4.5);
  // The flame through the paper: a soft drop, taller above the wick than below, swaying a little.
  float wick = tray + 0.3 * (hl - tray);
  float fx = (u - 0.006 * size * sin(tm * 1.3 + seed * 20.0)) / (0.034 * size);
  float fy = (v0 - wick) / ((v0 > wick ? 0.08 : 0.04) * size);
  float flame = exp(-fx * fx - fy * fy);
  vec3 col;
  if (mark) {
    float m = 0.0;
    if (front) {
      vec2 q = vec2(across * 0.47 / 0.68, (y - 0.5) / 0.66);
      float px = 1.0 / max(cpm * 0.66 * (hl - tray), 1.0); // mark units per cell
      float w = max(0.085, 1.1 * px);
      m = 1.0 - smoothstep(w - px, w + px, markDistance(q));
    }
    col = mix(LANTERNS_INDIGO * (0.5 + 0.6 * shine), LANTERNS_AMBER * (shine + 0.8 * flame) * 1.15, m) * on;
    col += LANTERNS_INDIGO * flame * on * 0.6;
    glow = m * on;
  } else {
    col = paper * on * (shine + 0.9 * flame);
    col = mix(col, vec3(1.0, 0.94, 0.78) * on * 1.4, flame * 0.45);
    glow = on;
    // Names written down the middle of two walls: three characters, each a 3x3 grid of brush
    // marks, faded out before the marks get thinner than two cells.
    if (front && fract(seed * 13.7) < 0.72 && abs(across) < 0.32 && y > 0.16 && y < 0.88) {
      float gy = (y - 0.16) / 0.72 * 3.0;
      vec2 f = vec2(across / 0.32 * 0.5 + 0.5, fract(gy)) * 3.0;
      vec2 g = floor(f);
      vec2 r = abs(fract(f) - 0.5);
      float stroke = step(hash12(g + vec2(floor(gy) * 3.1 + hit.x * 7.0, seed * 97.0)), 0.55);
      float block = 1.0 - smoothstep(0.22, 0.5, max(r.x, r.y));
      // Soft sumi grey rather than black, so marks sliding past with the lantern step through the
      // dither gently.
      float ink = stroke * block * smoothstep(2.6, 3.8, 0.213 * a * cpm) * 0.48;
      col *= 1.0 - ink;
      glow *= 1.0 - 0.8 * ink;
    }
  }
  // The frame: posts at the corners and a rim along the top, a warm brown rather than black (they
  // slide through the dither with the lantern), and only where comfortably over two cells wide.
  float frame = max(smoothstep(0.84, 0.92, abs(across)), smoothstep(0.92, 0.97, y)) * smoothstep(1.8, 3.0, 0.12 * a * cpm);
  col = mix(col, LANTERNS_WOOD * (lit + paper * on * 0.18) + paper * on * 0.25, frame * 0.6);
  glow *= 1.0 - 0.5 * frame;
  // The paper by daylight.
  col += (mark ? LANTERNS_INDIGO : vec3(0.9, 0.86, 0.78)) * lit * 0.35 * (1.0 - frame);
  return col;
}

// A stone in the stream: half an ellipsoid r across and h tall standing in the water, its outline
// lumpy. The ray crosses the stone's axis plane at lateral offset u and height v0 and rises climb
// metres per metre further on. Returns the depth offset of the hit (1e4: none), with the surface
// normal n and the height v there.
float lanternsRock(float u, float v0, float climb, float r, float h, float salt, out vec3 n, out float v) {
  n = vec3(0.0, 1.0, 0.0);
  v = 0.0;
  float rr = r * (0.9 + 0.2 * vnoise(vec2(u * 2.2 + salt, salt)));
  float hh = h * (0.85 + 0.3 * vnoise(vec2(u * 1.6 + salt * 3.0, salt + 5.0)));
  float ir = 1.0 / (rr * rr);
  float ih = 1.0 / (hh * hh);
  float qa = ir + climb * climb * ih;
  float qb = 2.0 * v0 * climb * ih;
  float qc = u * u * ir + v0 * v0 * ih - 1.0;
  float disc = qb * qb - 4.0 * qa * qc;
  if (disc < 0.0) return 1e4;
  float w = (-qb - sqrt(disc)) / (2.0 * qa);
  v = v0 + climb * w;
  if (v < 0.0) return 1e4;
  n = normalize(vec3(u * ir, v * ih, w * ir));
  return w;
}

// A stone's face, seen along ray: speckled granite lit from the sky above; wet, so its outline
// mirrors the bright low sky in a pale rim; and warm where the lanterns floating near it light it
// (shine.x how much, shine.y from which side, -1 left .. 1 right): its face toward them, and a
// bright amber rim on that side. Dark and wet just above the water; in the rain dark and wet all
// over, its rims sharper and brighter.
vec3 lanternsRockShade(vec3 n, float v, float u, vec3 ray, vec3 lit, vec3 haze, vec4 shine, float salt) {
  float wet = uWeather.x;
  vec3 alb = wetten(vec3(0.16, 0.155, 0.16) * (0.8 + 0.4 * vnoise(vec2(u * 4.0 + salt, v * 5.0))), wet, 0.1);
  float rim = 1.0 - max(dot(n, -ray), 0.0);
  rim *= rim * sqrt(rim);
  rim *= 1.0 + 1.6 * wetGloss(wet, n.y);
  vec3 col = alb * lit * (0.35 + 0.9 * max(n.y, 0.0));
  col += haze * rim * (0.2 + 0.35 * max(n.y, 0.0));
  float facing = clamp(0.35 - 0.45 * n.z + 0.5 * n.x * shine.y, 0.0, 1.0);
  float side = clamp(0.35 + 0.65 * n.x * shine.y, 0.0, 1.0);
  col += LANTERNS_AMBER * shine.x * (alb * facing * 2.4 + rim * side * 0.5);
  return col * (0.65 + 0.35 * smoothstep(0.0, 0.06, v));
}

Shade sceneLanterns(vec2 uv, vec2 cell, float t) {
  float tm = t * uMotion;
  float aspect = uRes.x / uRes.y;
  vec2 sp = vec2((uv.x - 0.5) * aspect, uv.y); // screen heights, x from the centre
  vec3 dir = viewRay(uv, aspect, LANTERNS_HORIZON, LANTERNS_FOV);

  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  sky.sun = lanternsTurn(sky.sun);
  sky.moon = lanternsTurn(sky.moon);
  // For the mirror: the moon swung round behind the viewer, so no reflection shows a sliver of its
  // disc broken by the ripples.
  Sky skyM = sky;
  skyM.moon = vec3(-sky.moon.x, sky.moon.y, -sky.moon.z);
  float dark = 1.0 - smoothstep(0.05, 0.5, sky.day);
  vec3 moonLight = sky.moonColor * (0.3 + 0.6 * sqrt(max(sky.moon.y, 0.0)));
  vec3 lit = sky.ambient + sky.sunColor * max(sky.sun.y, 0.0) + moonLight;
  // The sky low over the far bank in this direction: the colour of haze and mist.
  vec3 haze = skyColor(skyM, normalize(vec3(dir.x, 0.04, dir.z)));
  // Rain comes under cloud: the light dimmer and flatter, the haze grey, the mist thicker.
  float overcast = sqrt(max(K_rain, 0.0));
  lit *= 1.0 - 0.35 * overcast;
  haze = mix(haze, vec3(dot(haze, LUMA)) * 0.9, 0.55 * overcast);
  // (Distance haze in the rain is the shared veil's; here rain only thickens the mist a little.)
  float mist = clamp(K_mist + 0.15 * K_rain, 0.0, 1.0);
  // In heavy rain the candles gutter.
  float storm = smoothstep(0.5, 1.0, K_rain);
  vec3 cloud = lanternsCloudBase(haze); // the rain cloud's underside
  float current = mix(LANTERNS_CURRENT_SLOW, LANTERNS_CURRENT_FAST, K_current);
  float rippled = K_ripple * (1.0 + 0.6 * abs(K_wind));
  float shore = LANTERNS_HORIZON - LANTERNS_EYE * LANTERNS_FOCAL / LANTERNS_BANK;
  float bankFoot = LANTERNS_BANK / (LANTERNS_FOCAL * uRes.y);
  bool water = uv.y < shore;

  vec3 col;
  float lamp = 0.0; // the bank's lamplight in view, for the accent
  // Where the eye ray meets the water, the cell's footprint there, and how the water mirrors.
  float zp = 1e4;
  float xp = 0.0;
  float cellX = 0.0;
  float cellZ = 0.0;
  float fres = 0.0;
  float sigma = 0.0; // rms slope of the facets that draw lights out down the water
  vec3 refl = vec3(0.0, 1.0, 1.0);
  vec3 mirror = vec3(0.0);
  vec3 glint = vec3(0.0);
  // How far down the water (m) a lantern's glitter runs before it has faded.
  float reach = 3.0 + 14.0 * K_reflection;
  // Rain on the water: rings (xy tilt, z light on their crests) and how much of them these cells
  // can draw.
  vec3 drops = vec3(0.0);
  float rainFade = 0.0;

  if (!water) {
    vec2 bankLamp;
    col = lanternsBeyond(vec3(0.0, LANTERNS_EYE, 0.0), dir, 0.0, sky, lit, haze, dark, tm, bankFoot, 0.0, true, bankLamp);
    col += LANTERNS_LAMP * bankLamp.x;
    lamp = bankLamp.x;
  } else {
    float q = -dir.y / dir.z;
    zp = LANTERNS_EYE / q;
    xp = dir.x / dir.z * zp;
    cellX = zp / (LANTERNS_FOCAL * uRes.y);
    cellZ = cellX * zp / LANTERNS_EYE;
    vec3 rip = lanternsRipples(vec2(xp, zp), tm, vec2(cellX, cellZ), rippled, 0.6 * current * tm);
    glint = lanternsGlitter(vec2(xp, zp), tm);

    // The stones: glassy water in the lee of each, a wake opening behind it in two arms that catch
    // the sky and the lanterns' light, and a cushion of water heaped against its upstream face
    // (only where it is a few cells wide).
    float lee = 0.0;
    float wake = 0.0;
    vec3 stir = vec3(0.0);
    for (int i = 0; i < LANTERNS_ROCKS; i++) {
      vec4 rk = LANTERNS_ROCK[i];
      vec2 down = LANTERNS_DOWN[i];
      vec4 shine = uSimOn.x > 0.5 ? texelFetch(uSim0, ivec2(2 * LANTERNS_MAX + i, 0), 0) : vec4(0.0);
      vec2 d = vec2(xp - rk.x, zp - rk.y);
      float ds = dot(d, down);                   // metres downstream of the stone
      float across = down.x * d.y - down.y * d.x; // metres to one side of its wake
      float lit2 = 0.0;
      if (ds > 0.0) {
        float side = across / rk.z;
        lee = max(lee, exp(-side * side) * exp(-ds / (3.0 * rk.z)));
        float arm = (abs(across) - rk.z - 0.3 * ds) / max(0.16 + 0.03 * ds, 2.5 * cellZ);
        float line = exp(-arm * arm) * exp(-ds / 9.0) * smoothstep(0.0, rk.z, ds);
        wake += line * sin(ds * 3.0 - tm * 1.0);
        lit2 = line * 0.55;
      }
      float rim = (length(d) - rk.z) / max(0.1, 2.2 * cellZ);
      lit2 += exp(-rim * rim) * smoothstep(0.0, 0.6, -ds / rk.z) * (1.0 - smoothstep(0.3, 0.45, 2.2 * cellZ));
      stir += lit2 * (haze * 0.16 + LANTERNS_AMBER * shine.x * 0.12);
    }
    vec2 slope = rip.xy * (1.0 - 0.7 * lee) + vec2(0.0, wake * 0.09 * (0.4 + rippled));
    float hidden = rip.z * (1.0 - 0.7 * lee);

    // Rain: rings on the water, as many as it rains hard, drawn only where the bright crest of a
    // ring (a tenth of a ring unit) is three cells or more across and deep, and expanding at well
    // under a cell a frame; finer rings would shimmer through the dither. Further out the rings
    // are too small to draw but still dimple the whole river, roughening its mirror into a sheen.
    if (K_rain > 0.0) {
      vec2 rp = vec2(xp * 2.5, zp * 0.8);
      float band = 0.1 * min(1.0 / (2.5 * cellX), 1.0 / (0.8 * cellZ));
      rainFade = smoothstep(2.5, 4.0, band);
      drops = rainRipples(rp, t * 0.7, K_rain) * rainFade;
      slope += drops.xy * 0.35;
      hidden += K_rain * 0.008 * (1.0 - rainFade);
    }

    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    float spread = sqrt(0.0012 + hidden + 0.003 * K_rain);
    fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, -dir), spread * 0.6, 1.0), 5.0);
    refl = reflect(dir, n);
    refl = vec3(refl.x, max(refl.y, 0.002), max(refl.z, 0.05));
    sigma = (0.04 + 0.16 * K_reflection) * (0.45 + 0.55 * min(rippled, 1.0)) + 0.5 * spread;
    // The sky, hills and bank are mirrored by the same ripples tipped more steeply, so the long
    // swells fold the afterglow low over the bank and the dark bank and upper sky into broad
    // horizontal bands.
    vec3 bands = reflect(dir, normalize(vec3(-slope.x * 1.4, 1.0, -slope.y * 2.2)));
    bands = vec3(bands.x, max(bands.y, 0.002), max(bands.z, 0.05));
    float behind = LANTERNS_BANK - zp;
    vec2 bankLamp;
    mirror = lanternsBeyond(vec3(xp, 0.0, zp), bands, spread * 0.7, skyM, lit, haze, dark, tm,
                            bankFoot + spread * behind * 0.3, min(0.8 * sigma * behind, 6.0), false, bankLamp);
    // The bank's lamps mirrored: each a wavering image, and under it glints in the rows of facets.
    float lampSeen = bankLamp.x + glint.x * smoothstep(0.35, 0.6, glint.y) * bankLamp.y * 3.0;
    mirror += LANTERNS_LAMP * lampSeen;
    lamp = lampSeen * fres * 1.3;
    vec3 body = vec3(0.004, 0.012, 0.018) + lit * 0.03; // the river's own dark green-blue
    // Darker toward our bank, where the water mirrors the high, dim sky and lies in our bank's shade.
    // Rained on, the river turns a dimpled sheet of grey light: the rings tip facets every way, so
    // even straight below us much of the water faces the bright cloud base, and under the even
    // light of the overcast our bank's shade lifts. The ring crests catch the cloud base too.
    float dimple = smoothstep(0.0, 0.4, K_rain);
    float shade = mix(0.6 + 0.4 * smoothstep(0.0, 0.32, uv.y), 1.0, 0.6 * dimple);
    float sheen = mix(fres, max(fres, 0.5 + 0.2 * K_rain), dimple);
    col = mix(body, mirror, sheen) * shade;
    col += drops.z * (0.3 * mirror + 0.4 * cloud);
    col += stir;
  }

  // Solids on the water, nearest first by depth: the stones, then the lanterns.
  float nearest = 1e4;
  vec3 solid = vec3(0.0);
  float solidCover = 0.0;
  float solidGlow = 0.0;
  float climb = (uv.y - LANTERNS_HORIZON) / LANTERNS_FOCAL; // the eye ray's rise per metre ahead
  for (int i = 0; i < LANTERNS_ROCKS; i++) {
    vec4 rk = LANTERNS_ROCK[i];
    float s = LANTERNS_FOCAL / rk.y;
    float u = (sp.x - rk.x * s) / s;
    if (abs(u) > rk.z * 1.15) continue;
    vec4 shine = uSimOn.x > 0.5 ? texelFetch(uSim0, ivec2(2 * LANTERNS_MAX + i, 0), 0) : vec4(0.0);
    float salt = float(i) * 7.3 + 1.0;
    vec3 rn;
    float rv;
    float w = lanternsRock(u, (uv.y - LANTERNS_HORIZON) / s + LANTERNS_EYE, climb, rk.z, rk.w, salt, rn, rv);
    if (rk.y + w < nearest) {
      nearest = rk.y + w;
      solid = lanternsRockShade(rn, rv, u, dir, lit, haze, shine, salt);
      solidCover = 1.0;
      solidGlow = 0.0;
    }
    // Its reflection, in place of the sky's.
    if (water && zp < rk.y) {
      float tau = (rk.y - zp) / refl.z;
      float ur = xp + refl.x * tau - rk.x;
      if (lanternsRock(ur, refl.y * tau, refl.y / refl.z, rk.z, rk.w, salt, rn, rv) < 1e3) {
        col += (lanternsRockShade(rn, rv, ur, refl, lit, haze, shine, salt) - mirror) * fres;
      }
    }
  }

  vec3 onWater = vec3(0.0); // lantern light on the water: reflections, pools, rings
  float waterGlow = 0.0;
  vec3 inAir = vec3(0.0);   // lantern light in the air: halos
  float airGlow = 0.0;
  vec3 pool = vec3(0.0);    // lantern light falling on the water here, for the rain's rings
  if (uSimOn.x > 0.5) {
    for (int i = 0; i < LANTERNS_MAX; i++) {
      vec4 st = texelFetch(uSim0, ivec2(i, 0), 0); // x, z (m), turn (rad), candle 0..1
      if (st.y < 1.0) continue;                    // an empty slot
      float s = LANTERNS_FOCAL / st.y;             // screen heights per metre at the lantern
      float qx = (sp.x - st.x * s) / s;            // metres across from it, at its distance
      if (abs(qx) > LANTERNS_REACH) continue;
      float qy = (uv.y - LANTERNS_HORIZON) / s + LANTERNS_EYE; // metres over the water there
      if (qy > LANTERNS_REACH + 0.6 || (!water && qy < -LANTERNS_REACH)) continue;
      vec4 lk = texelFetch(uSim0, ivec2(i + LANTERNS_MAX, 0), 0); // seed, M, age (s), size
      float seed = lk.x;
      bool mark = lk.y > 0.5;
      float size = lk.w;
      float a = LANTERNS_HALF * size;
      float hl = LANTERNS_TALL * size;
      // In heavy rain each candle gutters now and then (a dip of a second or so, every eight), and
      // in a downpour about one in five drowns to an ember; never the M lantern's.
      float gutter = 1.0 - storm * (0.15 + 0.35 * pow(max(sin(tm * 0.8 + seed * 40.0), 0.0), 8.0));
      gutter *= 1.0 - 0.8 * smoothstep(0.75, 1.0, K_rain) * step(fract(seed * 7.7), 0.2) * (mark ? 0.0 : 1.0);
      float on = st.w * lanternsFlicker(seed, tm) * gutter;
      float cs = cos(st.z);
      float sn = sin(st.z);
      vec3 paper = lanternsPaper(seed);
      vec3 mean = mark ? LANTERNS_AMBER * 0.45 : paper * 0.85; // its light, seen blurred
      float cpm = s * uRes.y;
      // Riding the ripples: a slow bob, and a roll a little behind it.
      float ph = tm * 0.85 + st.y * 0.7 + st.x * 0.3 + seed * TAU;
      float swell = 0.4 + K_ripple;
      float bob = 0.012 * swell * sin(ph);
      float roll = 0.03 * swell * cos(ph + 0.7);

      // The lantern itself, its sides softened over a cell.
      float v0 = qy - bob;
      float u = qx - roll * (v0 - 0.5 * hl);
      float hw = a * (abs(cs) + abs(sn));
      float inside = (hw - abs(u)) * cpm;
      if (inside > -0.5) {
        vec4 hit = lanternsBox(clamp(u, -0.999 * hw, 0.999 * hw), v0, climb, cs, sn, a, hl);
        if (hit.x >= 0.0 && st.y + hit.w < nearest) {
          nearest = st.y + hit.w;
          solid = lanternsWall(hit, u, v0, size, paper, on, seed, mark, cpm, tm, lit, solidGlow);
          solidCover = clamp(inside + 0.5, 0.0, 1.0);
        }
      }

      // Its halo in the air, wider and stronger in mist; mostly hidden while it floats behind a
      // stone.
      vec2 hc = vec2(qx, qy - 0.55 * hl);
      float d2 = dot(hc, hc);
      float hr = 0.26 + 0.42 * mist;
      float behindStone = nearest < st.y - 0.3 ? 0.3 : 1.0;
      float halo = on * size * behindStone * ((0.07 + 0.38 * mist) * exp(-d2 / (hr * hr)) + (0.025 + 0.05 * mist) * exp(-d2 / 0.45));
      inAir += mean * halo;
      airGlow += halo;

      if (!water) continue;
      // Its reflection: the box traced along the reflected ray. Right under the lantern, where
      // that ray meets a wall, its wavering mirror image. Below that its glitter: the rows of facets
      // that tip its light to the eye, fewer and fainter further down the water (the odds fall as
      // the slope needed steepens, and with distance, over K_reflection's reach), each row's dash
      // swaying a little to one side. Amber dashes, darker than the lantern.
      if (zp < st.y) {
        float dz = st.y - zp;
        float tau = dz / refl.z;
        float vr = refl.y * tau - bob;
        float ur = xp + refl.x * tau - st.x;
        if (vr <= hl) {
          vec4 rh = lanternsBox(ur, vr, refl.y / refl.z, cs, sn, a, hl);
          if (rh.x >= 0.0 && rh.x < 3.5) {
            float gw;
            onWater += lanternsWall(rh, ur, vr, size, paper, on, seed, mark, cpm, tm, lit, gw) * fres * 1.2;
            waterGlow += gw * fres * 1.2;
          }
        }
        float sv = 2.0 * sigma * dz + 0.05;
        float above = max(vr - hl, 0.0) / sv;
        float chance = exp(-above * above - dz / reach) * smoothstep(0.4 * hl, hl, vr);
        if (chance > 0.01) {
          float su = 0.8 * sigma * dz * LANTERNS_EYE / zp;
          float wide = 0.7 * hw + 0.4 * su;
          float across = 1.0 - smoothstep(wide, wide + 0.3 * hw + 0.4 * su + 1.5 / cpm, abs(ur - glint.z * 0.6 * su));
          float k = glint.x * smoothstep(1.0 - chance, 1.15 - chance, glint.y) * across * (0.35 + 0.65 * chance) * fres * 2.0;
          onWater += mean * on * k;
          waterGlow += on * (mark ? 0.45 : 1.0) * k;
        }
      }
      // A pool of its light on the water around it, and rings spreading where it was set down.
      vec2 dw = vec2(xp - st.x, zp - st.y);
      float dist2 = dot(dw, dw);
      onWater += mean * on * size * 0.1 * exp(-dist2 / 0.3);
      pool += mean * on * size * exp(-dist2 / 1.5);
      if (lk.z < 4.5) {
        float rr = 0.22 + 0.32 * lk.z;
        float wr = max(0.07, 2.4 * cellZ);
        float dist = sqrt(dist2);
        float fade = 1.0 - lk.z / 4.5;
        float r1 = (dist - rr) / wr;
        float r2 = (dist - 0.55 * rr) / wr;
        float ring = (exp(-r1 * r1) + 0.5 * exp(-r2 * r2)) * fade * fade;
        onWater += (mean * max(on, 0.3) * 0.6 + mirror * 0.5) * ring;
        waterGlow += ring * 0.5;
      }
    }
  }

  float glow = lamp;
  if (water) {
    col += onWater;
    glow += waterGlow;
    // The rain's rings catch the lantern light where it falls on the water.
    col += drops.z * pool * 0.7;
    glow += drops.z * 0.7 * dot(pool, LUMA);
    // Mist over the water: thicker toward the far bank, lying in long horizontal bands (sized on
    // screen, so they stay broad near and far) that drift downstream, lit by the lanterns in it.
    float wisp = vnoise(vec2((xp + 0.6 * current * tm) / zp * 2.5, log(zp) * 3.5));
    float fm = mist * (1.0 - exp(-zp / 40.0)) * (0.45 + 0.55 * wisp) * 0.8;
    col = mix(col, haze * 0.92 + inAir * 0.3, fm);
    glow *= 1.0 - fm;
  }
  if (nearest < 1e3) {
    float fm = mist * (1.0 - exp(-nearest / 40.0)) * 0.7;
    col = mix(col, mix(solid, haze * 0.92, fm), solidCover);
    glow = mix(glow, solidGlow * (1.0 - fm), solidCover);
  }
  col += inAir;
  glow += airGlow * 1.2;

  if (K_rain > 0.0) {
    // Rain in depth: drops only in front of the first thing along the eye ray (the water where it
    // meets it, a lantern or a stone, or the far bank and the sky), and the distance beyond the
    // drops a grey veil that swallows the far bank in a downpour. Each drop is lit by the light
    // around it: bright amber streaks through the lanterns' halos and by the bank's lamps, dim grey
    // threads elsewhere; out-of-focus drops right in front of us catch less of the lanterns.
    float reachZ = water ? length(vec2(xp, zp)) : 1e4;
    if (nearest < 1e3) reachZ = mix(reachZ, nearest, solidCover);
    Precip p = rainFall(uv, aspect, t, K_rain, K_wind, 1.0 - exp(-reachZ / 30.0));
    vec3 air = mix(vec3(dot(haze, LUMA)), haze, 0.5) * 0.85 + inAir * 0.6;
    col = mix(col, air, p.veil);
    glow *= 1.0 - 0.5 * p.veil;
    // Drops shine with the cloud base they refract (a floor so some rain still reads in the dark),
    // and with lantern light where they fall through a halo; near, out-of-focus drops dimmer. The
    // bank's lamps are a hundred metres beyond the nearest drops, so they light none of them.
    vec3 drop = max(cloud * 1.2, vec3(0.08)) + inAir * mix(3.0, 1.0, p.near);
    col = mix(col, drop * mix(1.0, 0.8, p.near), p.cover);
    glow += p.cover * airGlow * mix(1.0, 0.3, p.near) * 0.6;
  }

  // Ink is the picture's light; the lantern light (and the bank's lamps) is the accent. A sunlit
  // river puts the page in its paper theme (index.ts), where ink is dark on a light ground.
  float lum = dot(col, LUMA);
  bool paperTheme = K_cycle <= 0.0 && K_time > 0.33 && K_time < 0.67;
  Shade o = blankShade();
  o.ink = paperTheme ? clamp((0.9 - lum) / 0.8, 0.0, 1.0) : clamp(pow(max(lum, 0.0), 0.8) * 1.3, 0.0, 1.0);
  o.accent = clamp(glow, 0.0, 1.0);
  o.rgb = col;
  o.source = col;
  return o;
}
`;
