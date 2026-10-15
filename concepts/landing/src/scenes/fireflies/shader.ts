// The fireflies' picture: a mangrove bank in black against the skyglow of a moonless night, the
// still river mirroring it, and the light of the swarm simulated in sim.ts: the bank's fireflies
// with their soft halos glowing through the crowns, a few drifting low over the water, a few close
// to us and out of focus, and the lantern the pointer carries.
//
// All of that firefly light is drawn two-state: a cell takes the light's colour wherever the light
// reaching it passes the cell's own fixed dither threshold, and shows the night scene otherwise.
// A flash grows each glow's lit patch from its core outward and shrinks it again, so the dither
// renders brightness as the patch's size and density. The lit colour depends only on where the
// cell lies (near a firefly's core, in its halo, out in the soft glow, in a bokeh disc), never on
// how bright the flashes are, so every cell changes at most twice a flash whatever the
// quantisation: a forest pulsing together breathes instead of strobing. The one smooth thing that
// follows the pulse, a faint green in the sky, the mist and the water, touches the green channel
// only, so it too crosses at most one level up and back. The source view gets the smooth picture.
//
// uSim0 (per firefly: place in its cell, light, soft halo), uSim1 (the bank's profile), uSim2
// (nearer lights, lantern, bank) and uSim3 (the prop roots, records of the shared plant component)
// are laid out in sim.ts.
import {
  FIREFLIES_APERTURE,
  FIREFLIES_BANK,
  FIREFLIES_CELL,
  FIREFLIES_DRIFTERS,
  FIREFLIES_EYE,
  FIREFLIES_FOCAL,
  FIREFLIES_HORIZON,
  FIREFLIES_NEAR,
  FIREFLIES_ROOT_PITCH,
  FIREFLIES_ROWS,
  FIREFLIES_STATE_BANK,
  FIREFLIES_STATE_LANTERN,
  FIREFLIES_WATER,
} from "./sim.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { plantsGlsl } from "../../shaders/lib/plants.ts";

/** The "now" slot of the shared shooting stars (K_meteors): the breeze has 0 and the M 1. */
export const FIREFLIES_METEOR_TRIGGER = 2;

export const firefliesGlsl = `
${plantsGlsl}
const float FIREFLIES_CELL = ${glslFloat(FIREFLIES_CELL)};
const float FIREFLIES_WATER = ${glslFloat(FIREFLIES_WATER)};
const int FIREFLIES_ROWS = ${FIREFLIES_ROWS};
const int FIREFLIES_NEAR = ${FIREFLIES_NEAR};
const int FIREFLIES_DRIFTERS = ${FIREFLIES_DRIFTERS};
const int FIREFLIES_LANTERN = ${FIREFLIES_STATE_LANTERN};
const int FIREFLIES_STATE = ${FIREFLIES_STATE_BANK};
const float FIREFLIES_HORIZON = ${glslFloat(FIREFLIES_HORIZON)};
const float FIREFLIES_EYE = ${glslFloat(FIREFLIES_EYE)};
const float FIREFLIES_FOCAL = ${glslFloat(FIREFLIES_FOCAL)};
const float FIREFLIES_DISTANCE = ${glslFloat(FIREFLIES_BANK)};
const float FIREFLIES_APERTURE = ${glslFloat(FIREFLIES_APERTURE)};
const float FIREFLIES_ROOT_PITCH = ${glslFloat(FIREFLIES_ROOT_PITCH)};
// Shooting stars set out in this band of the sky (screen heights from the middle: x, y, width,
// height), high over the trees.
const int FIREFLIES_METEOR_SLOT = ${FIREFLIES_METEOR_TRIGGER};
const vec4 FIREFLIES_METEOR_FIELD = vec4(-0.6, 0.8, 1.2, 0.12);

// The camera settling in on arriving and drifting on as the scene leaves: ZOOM is the share of the
// frame given up (about the waterline), PAN the share of the room that zoom leaves at the edges the
// camera slides into; nearer lights slide against the bank by their parallax, at most PARALLAX times
// as far.
const float FIREFLIES_ZOOM_IN = 0.06;
const float FIREFLIES_ZOOM_OUT = 0.035;
const float FIREFLIES_PAN = 0.85;
const float FIREFLIES_PARALLAX = 7.0;

// A bank firefly's glow radius in cells at size 1 (its place stays 0.06 inside its cell, so at the
// largest size, 1.2, every glow reaching a point lies in the 3×3 cells around it).
const float FIREFLIES_REACH = 0.85;
// Light at which a cell is certainly lit, per unit of a firefly's light: its glow, and the soft
// halo around it, which only gathers where several flash together (a lone flash barely shows one,
// a crown flashing as one glows up to GLOW_MAX of its cells lit).
const float FIREFLIES_GAIN = 1.55;
const float FIREFLIES_GLOW_LOW = 0.03;
const float FIREFLIES_GLOW_HIGH = 0.35;
const float FIREFLIES_GLOW_MAX = 0.6;
// Reflected light, against the light it mirrors (times the river's mirror).
const float FIREFLIES_REFLECTED = 0.75;
// The out-of-focus fireflies: most of a disc's cells lit at the height of a flash.
const float FIREFLIES_BOKEH_GAIN = 0.42;
// Reflections are drawn this much taller than the lights they mirror.
const float FIREFLIES_STRETCH = 1.6;

// The night: skyglow low over the trees fading to black overhead, distant hills, the mangroves in
// black, the mist glowing under them, the mist itself, the river's own dark. The skyglow and hills
// have no red: every channel dithers on the same threshold, so they print as black, navy (blue
// only) and teal (green and blue) cells, never grey. The navy, so dark it reads as deep blue sky
// rather than texture, reaches high and thins out slowly; the brighter teal hugs the treeline,
// where the silhouettes stand against it.
const vec3 FIREFLIES_SKYGLOW = vec3(0.000, 0.200, 0.250);
// Per channel, the height (screen heights above the waterline) over which the skyglow falls by e
// (red is 0 anyway), and the heights between which what is left fades out, leaving the sky over
// the stars black.
const vec3 FIREFLIES_GLOW_FALL = vec3(1.0, 0.09, 0.20);
const float FIREFLIES_GLOW_FADE = 0.2;
const float FIREFLIES_GLOW_END = 0.55;
const vec3 FIREFLIES_HILLS = vec3(0.000, 0.020, 0.040);
// Under 1/192 a channel (even with the crown tone's 1.25), below the dither's first step at four
// levels, so the silhouettes print solid black.
const vec3 FIREFLIES_LEAVES = vec3(0.000, 0.003, 0.003);
const vec3 FIREFLIES_GAPGLOW = vec3(0.040, 0.085, 0.105);
const vec3 FIREFLIES_MIST = vec3(0.070, 0.130, 0.155);
const vec3 FIREFLIES_DEEP = vec3(0.000, 0.000, 0.004);
// Lit colours: a firefly's core and halo, the dim green of its soft glow, the M, the warm green of
// the out-of-focus ones; the lantern's body and warm halo.
const vec3 FIREFLIES_CORE = vec3(0.85, 1.00, 0.35);
const vec3 FIREFLIES_HALO = vec3(0.35, 0.72, 0.14);
const vec3 FIREFLIES_GLOW = vec3(0.10, 0.32, 0.06);
const vec3 FIREFLIES_MARK = vec3(0.92, 1.00, 0.66);
const vec3 FIREFLIES_BOKEH = vec3(0.72, 1.00, 0.28);
const vec3 FIREFLIES_LAMP = vec3(1.00, 0.84, 0.56);
const vec3 FIREFLIES_WARM = vec3(1.00, 0.52, 0.16);

// One prop root (a record of uSim3: an arc from its apex down into the water, its turn the curl in
// a plus the breeze's bend, mirrored with its side), two to three cells thick, rounded at the apex.
float firefliesRoot(vec2 q, PlantOrgan o, float w) {
  if (o.tier < 0.5) return 0.0;
  vec2 l = plantLocal(q, o);
  float reach = o.len + 2.0 * w;
  if (dot(l, l) > reach * reach) return 0.0;
  float s;
  float d = plantArc(l, o.len, o.side * (o.a + o.bend), s);
  float dist = s < 0.0 ? length(l) : (s > 1.0 ? 1.0 : abs(d));
  return smoothfall(1.5 * w, 0.8 * w, dist);
}

// Rhizophora prop roots: overlapping arches springing in pairs from under the canopy and curving
// down into the water, each pair the sim's (sim.ts) in its bin of FIREFLIES_ROOT_PITCH. An apex to the
// right of q's bin reaches back with its left root, one to the left with its right root, at most
// three bins. Returns coverage.
float firefliesRoots(vec2 q) {
  if (uSimOn.w < 0.5) return 0.0;
  vec4 head = texelFetch(uSim3, ivec2(0, 0), 0);
  int bins = int(head.y + 0.5);
  int k0 = int(floor(q.x / FIREFLIES_ROOT_PITCH)) - int(round(head.x));
  float w = 1.0 / uRes.y;
  float cover = 0.0;
  for (int i = -3; i <= 3; i++) {
    int k = k0 + i;
    if (k < 0 || k >= bins) continue;
    if (i >= 0) cover = max(cover, firefliesRoot(q, plantOrgan(uSim3, 1, 2 * k), w));
    if (i <= 0) cover = max(cover, firefliesRoot(q, plantOrgan(uSim3, 1, 2 * k + 1), w));
  }
  return cover;
}

// Everything above the waterline but the fireflies' light, at q: sky, far hills, the mangroves and
// their roots, and the mist. 'pulse' is the whole bank's mean flash (a faint green in the damp air);
// 'mirrored' leaves out the stars, too fine for a rippled reflection. 'leaves' returns 1 on leaves,
// 0.5 under the canopy and 0 in the open; 'mist' the mist's density.
vec3 firefliesBank(vec2 q, float x0, float span, float tm, float pulse, bool mirrored, out float leaves, out float mist) {
  float h = q.y - FIREFLIES_WATER;
  leaves = 0.0;
  float roots = 0.0;

  // Skyglow: teal over the trees, deep blue above, fading to black overhead, where the stars are.
  vec3 col = FIREFLIES_SKYGLOW * exp(-max(h, 0.0) / FIREFLIES_GLOW_FALL) * (1.0 - smoothstep(FIREFLIES_GLOW_FADE, FIREFLIES_GLOW_END, h));
  col.g += 0.012 * pulse * exp(-h / 0.14);
  if (!mirrored && K_stars > 0.0 && h > 0.28) {
    // Sparse stars, each one or two cells, still.
    vec2 sg = q * 85.0;
    vec2 si = floor(sg);
    float sh = hash12(si + 13.1);
    if (sh > 1.0 - 0.08 * K_stars) {
      vec2 sp = si + 0.2 + 0.6 * vec2(hash12(si + 2.7), hash12(si + 5.3));
      float cells = length(sg - sp) / 85.0 * uRes.y;
      col += vec3(0.85, 0.9, 1.0) * (0.5 + 0.5 * fract(sh * 91.7)) * smoothfall(0.9, 0.5, cells) * smoothstep(0.28, 0.4, h);
    }
  }

  // Hills far behind the bank, a shade darker than the skyglow, seen through its gaps.
  float hill = 0.035 + 0.05 * vnoise(vec2(q.x * 2.1 + 3.0, 1.7)) + 0.012 * vnoise(vec2(q.x * 8.3, 4.1));
  if (h < hill) col = mix(col, FIREFLIES_HILLS, 0.65);
  else if (!mirrored) {
    // Now and then a shooting star (the shared meteors, K_meteors) over the hills, behind the trees.
    float meteorSeed;
    float meteorAt = meteorAge(tm, K_meteors, FIREFLIES_METEOR_SLOT, meteorSeed);
    col += METEOR_TINT * hardEdge(meteorStreak(q, FIREFLIES_METEOR_FIELD, meteorAt, meteorSeed, 1.0 / uRes.y));
  }

  // The mangroves, black: leafy round crowns over a gap of prop roots and Sonneratia trunks, or the
  // low mud bank.
  vec4 prof = uSimOn.y > 0.5 ? texture(uSim1, vec2((q.x - x0) / span, 0.25)) : vec4(vec2(FIREFLIES_WATER + 0.012), 0.0, 0.0);
  float n1 = vnoise(q * vec2(150.0, 170.0));
  float n2 = vnoise(q * vec2(48.0, 60.0) + 7.3);
  float top = prof.x + 0.008 * (0.6 * n1 + 0.4 * n2 - 0.5);
  bool mud = prof.x - prof.y < 0.004;
  if (q.y < top) {
    float depth = top - q.y;
    float base = mud ? -1.0 : prof.y + 0.008 * (n2 - 0.5) - 0.004 * n1;
    if (q.y >= base) {
      // Leaves, with the sky showing through here and there at the top.
      float holes = mud ? 0.0 : vnoise(q * vec2(230.0, 250.0) + 3.1);
      if (depth > 0.012 || holes < 0.62 + 0.4 * depth / 0.012) {
        col = FIREFLIES_LEAVES * (0.75 + 0.5 * prof.z);
        leaves = 1.0;
      }
    } else {
      // Under the canopy: the dark of the leaves, lifting toward the water, crossed by prop roots
      // and trunks (drawn again over the mist below, so they stand in it).
      float up = clamp(h / max(base - FIREFLIES_WATER, 1e-3), 0.0, 1.0);
      col = mix(FIREFLIES_GAPGLOW, FIREFLIES_LEAVES, sqrt(up));
      float trunk = uSimOn.y > 0.5 ? texture(uSim1, vec2((q.x - x0) / span, 0.75)).r : 0.0;
      roots = max(firefliesRoots(q), smoothstep(0.4, 0.6, trunk));
      col = mix(col, FIREFLIES_LEAVES, roots);
      leaves = 0.5;
    }
  }

  // Mist lying on the water: a soft glow along the waterline, thinning upward over the roots and
  // the foot of the trees (and, in the reflection, downward), drifting.
  mist = min(0.75, 1.6 * K_mist * exp(-max(h, 0.0) / 0.04) * (0.45 + 0.55 * vnoise(vec2(q.x * 3.5 - tm * 0.012, h * 26.0 + 2.0))));
  col = mix(col, FIREFLIES_MIST, mist);
  col = mix(col, FIREFLIES_LEAVES, 0.7 * roots);
  col.g += 0.02 * pulse * mist;
  return col;
}

// The bank's fireflies around q: returns the light reaching q. 'reach' says how deep q lies in the
// nearest glow (0 outside every glow, 1 at a firefly), 'core' how much it lies in a glow's core,
// 'mark' in the glow of a firefly drawing the M: all three from places alone, never from flashes,
// so a lit cell keeps its colour. Each glow is a compact bump (1 - r²)² about the firefly's place,
// sized by a hash of its world cell; 'stretch' draws them taller, for the reflections, which then
// need two rows either side.
float firefliesSwarm(vec2 q, float x0, float cols, float stretch, out float reach, out float core, out float mark) {
  vec2 g = vec2((q.x - x0) / FIREFLIES_CELL, (q.y - FIREFLIES_WATER) / FIREFLIES_CELL);
  ivec2 b = ivec2(floor(g));
  int rows = stretch > 1.01 ? 2 : 1;
  int width = int(cols);
  float light = 0.0;
  reach = 0.0;
  core = 0.0;
  mark = 0.0;
  for (int j = -2; j <= 2; j++) {
    if (abs(j) > rows) continue;
    for (int i = -1; i <= 1; i++) {
      ivec2 c = b + ivec2(i, j);
      if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= FIREFLIES_ROWS) continue;
      vec4 f = texelFetch(uSim0, c, 0);
      if (f.x < 0.0) continue;
      float size = 0.62 + 0.58 * hash12(vec2(float(c.x) - 0.5 * cols, float(c.y)) + K_seed * 0.173);
      vec2 d = g - vec2(c) - vec2(f.x, abs(f.y));
      d.y /= stretch;
      float r2 = dot(d, d) / (FIREFLIES_REACH * FIREFLIES_REACH * size * size);
      if (r2 >= 1.0) continue;
      float k = (1.0 - r2) * (1.0 - r2);
      light += f.z * k * size;
      reach = max(reach, k);
      core = max(core, 1.0 - smoothstep(0.08, 0.3, r2));
      if (f.y < 0.0) mark = max(mark, k);
    }
  }
  return light;
}

// Knobs: coupling, density, period, drift, unrest, lantern and mark drive the simulation; here
// K_near, K_seed, K_reflections, K_mist, K_stars and K_meteors are read.
Shade sceneFireflies(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 ps = vec2((uv.x - 0.5) * aspect, uv.y);
  // The camera. Arriving, it starts a little in, looking to the left of where it rests, and glides
  // right and out to a stop (the bank slides left and widens); leaving, it drifts on the same way,
  // gathering speed. The zoom is about the waterline and only ever zooms in, so the lattice and the
  // forest profile always cover the view, and the pan stays inside what the zoom leaves. 'pan' is
  // the offset of the bank's x, kept for the nearer lights. Both are exactly 0 at rest, where p == ps.
  vec2 p = ps;
  float pan = 0.0;
  float arrive = pow(max(1.0 - passageIn(), 0.0), 2.5);
  float leave = passageOut() * passageOut();
  if (arrive + leave > 0.0) {
    float zoom = FIREFLIES_ZOOM_IN * arrive + FIREFLIES_ZOOM_OUT * leave;
    pan = 0.5 * aspect * FIREFLIES_PAN * (FIREFLIES_ZOOM_OUT * leave - FIREFLIES_ZOOM_IN * arrive);
    p = vec2(ps.x * (1.0 - zoom) + pan, FIREFLIES_WATER + (ps.y - FIREFLIES_WATER) * (1.0 - zoom));
  }
  float tm = uMotionTime;
  bool sim = uSimOn.x > 0.5 && uSimOn.z > 0.5;
  float cols = sim ? float(textureSize(uSim0, 0).x) : 2.0;
  float span = cols * FIREFLIES_CELL;
  float x0 = -0.5 * span;
  vec4 lantern = sim ? texelFetch(uSim2, ivec2(FIREFLIES_LANTERN, 0), 0) : vec4(0.0);
  vec4 bank = sim ? texelFetch(uSim2, ivec2(FIREFLIES_STATE, 0), 0) : vec4(0.0);

  // Below the waterline the river mirrors the bank: find the point it reflects. Long, slow swells
  // bend the reflection, more toward us and not at all at the far bank's foot, where the water is
  // seen at a grazing angle; a breeze crossing the river ruffles a band of it (a catspaw) that
  // breaks the reflection up and dulls it.
  float below = FIREFLIES_WATER - p.y;
  bool river = below > 0.0;
  vec2 q = p;
  float wobble = 0.0;
  float mirror = 1.0;
  if (river) {
    float across = (p.x - bank.y) / 0.16;
    float gust = bank.z * exp(-across * across) * smoothstep(0.0, 0.05, below);
    float bands = 0.3 / (below + 0.012);
    float swell = vnoise(vec2(p.x * 4.0, bands + tm * 0.05)) - 0.5;
    swell += gust * (vnoise(vec2(p.x * 16.0, 3.0 * bands + tm * 0.6)) - 0.5);
    wobble = swell * (0.0012 + 0.012 * below) * (1.0 + 2.0 * gust) * smoothstep(0.0, 0.03, below);
    q = vec2(p.x + wobble, FIREFLIES_WATER + below);
    mirror = K_reflections * mix(0.92, 0.55, smoothstep(0.0, FIREFLIES_WATER, below)) * (1.0 - 0.6 * gust);
  }

  float leaves;
  float mist;
  vec3 col = firefliesBank(q, x0, span, tm, bank.x, river, leaves, mist);

  // The bank's fireflies, or their reflections, hazier in the mist; and their soft halos, which
  // glow through the crowns where many flash together.
  float reach = 0.0;
  float core = 0.0;
  float mark = 0.0;
  float bankLight = sim ? firefliesSwarm(q, x0, cols, river ? FIREFLIES_STRETCH : 1.0, reach, core, mark) : 0.0;
  bankLight *= FIREFLIES_GAIN * (1.0 - 0.45 * mist);
  float halo = sim ? texture(uSim0, vec2((q.x - x0) / span, (q.y - FIREFLIES_WATER) / (float(FIREFLIES_ROWS) * FIREFLIES_CELL))).a : 0.0;
  float glowLight = FIREFLIES_GLOW_MAX * smoothstep(FIREFLIES_GLOW_LOW, FIREFLIES_GLOW_HIGH, halo) * (0.75 + 0.25 * leaves + 0.6 * mist);

  if (river) {
    col = FIREFLIES_DEEP + col * mirror;
    bankLight *= FIREFLIES_REFLECTED * mirror;
    glowLight *= FIREFLIES_REFLECTED * mirror;
    core *= 0.6;
    // Mist on the water along the far bank's foot, and each pulse's green on the river.
    float low = K_mist * exp(-below / 0.03) * (0.5 + 0.5 * vnoise(vec2(p.x * 3.0 - tm * 0.01, 9.0)));
    col = mix(col, FIREFLIES_MIST, low * 0.7);
    col.g += 0.009 * bank.x * mirror;
  }

  // The lights nearer than the bank. Drifters: small glows low over the river, each mirrored
  // straight below it, as far under the surface as it flies above. Then the ones close to us, out
  // of focus: soft warm-green discs up at the sides. 'disc' marks where one of those is, lit or
  // not, for the colour.
  float nearLight = 0.0;
  float disc = 0.0;
  int bokeh = sim ? int(K_near + 0.5) : 0;
  for (int k = 0; k < FIREFLIES_NEAR; k++) {
    if (!sim) break;
    vec4 f = texelFetch(uSim2, ivec2(k, 0), 0);
    if (k < FIREFLIES_DRIFTERS) {
      if (f.z < 0.0) continue;
      float r = clamp(0.09 / f.z, 0.0028, 0.0065);
      vec2 pn = vec2(p.x + pan * (min(FIREFLIES_DISTANCE / f.z, FIREFLIES_PARALLAX) - 1.0), p.y);
      vec2 d = (pn - f.xy) / r;
      float r2 = dot(d, d);
      if (r2 < 1.0) {
        float kk = (1.0 - r2) * (1.0 - r2);
        nearLight += f.w * kk * FIREFLIES_GAIN;
        reach = max(reach, kk);
        core = max(core, 1.0 - smoothstep(0.08, 0.3, r2));
      }
      float surface = FIREFLIES_HORIZON - FIREFLIES_EYE * FIREFLIES_FOCAL / f.z;
      if (p.y < surface) {
        vec2 dm = vec2(pn.x + wobble - f.x, (p.y - (2.0 * surface - f.y)) / FIREFLIES_STRETCH) / r;
        float m2 = dot(dm, dm);
        if (m2 < 1.0) {
          float km = (1.0 - m2) * (1.0 - m2);
          nearLight += f.w * km * FIREFLIES_GAIN * FIREFLIES_REFLECTED * mirror;
          reach = max(reach, km);
        }
      }
    } else {
      if (k - FIREFLIES_DRIFTERS >= bokeh) continue;
      float r = FIREFLIES_APERTURE * FIREFLIES_FOCAL * (1.0 / f.z - 1.0 / FIREFLIES_DISTANCE);
      vec2 pn = vec2(p.x + pan * (min(FIREFLIES_DISTANCE / f.z, FIREFLIES_PARALLAX) - 1.0), p.y);
      float dist = length(pn - f.xy) / r;
      if (dist >= 1.0) continue;
      nearLight += f.w * FIREFLIES_BOKEH_GAIN * smoothfall(1.0, 0.15, dist);
      disc = max(disc, smoothfall(1.0, 0.9, dist));
    }
  }

  // The lantern: a small warm body with its halo, swinging after the pointer, and its long
  // reflection on the water below it.
  float lamp = 0.0;
  if (lantern.z > 0.004) {
    float flame = 1.0 + 0.05 * sin(tm * 2.1) + 0.03 * sin(tm * 3.4 + 1.3);
    vec2 dl = ps - lantern.xy;
    lamp = smoothfall(1.0, 0.6, length(dl / vec2(0.0055, 0.0075))) * lantern.z;
    float warm = exp(-length(dl) / (0.03 + 0.04 * lantern.w)) * (0.22 + 0.7 * lantern.w) * flame;
    float surface = min(lantern.y, FIREFLIES_WATER) - 0.05;
    if (ps.y < surface) {
      warm += 0.4 * K_reflections * flame * exp(-abs(ps.x - 3.0 * wobble - lantern.x) / 0.006) * exp(-abs(ps.y - (2.0 * surface - lantern.y)) / 0.05);
    }
    col += FIREFLIES_WARM * warm * lantern.z;
  }
  col = mix(col, FIREFLIES_LAMP, lamp);

  // Lit or not: a cell takes the light's colour where the light passes its own threshold. The
  // colour comes from where the cell lies: a bokeh disc, a firefly's core, its halo fading out to
  // the dim green of the soft glow.
  float light = bankLight + glowLight + nearLight;
  float lit = step(1.0 - light, threshold(cell + vec2(5.0, 2.0)));
  vec3 glow = mix(FIREFLIES_GLOW, FIREFLIES_HALO, smoothstep(0.0, 0.45, reach));
  glow = mix(mix(glow, FIREFLIES_CORE, core), FIREFLIES_MARK, mark);
  glow = mix(glow, FIREFLIES_BOKEH, disc);

  // Accent: the fireflies; while the M holds, the others step back so it reads in two tones too.
  float accent = lit * mix(0.55 + 0.45 * core, 1.0, mark) * mix(1.0, 0.45, bank.w * (1.0 - mark));
  Shade o = shadeOf(mix(col, glow, lit), max(inkOf(col, 3.2, 1.0), 0.85 * lit), accent);
  o.source = col + glow * min(light, 1.2) * 0.85;
  return o;
}
`;
