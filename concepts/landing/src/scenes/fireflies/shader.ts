// The fireflies' picture: a mangrove bank in black against the skyglow of a moonless night, the
// still river mirroring it, and the light of the swarm simulated in sim.ts: the bank's fireflies
// with their soft halos glowing through the crowns, a few drifting low over the water, a few close
// to us and out of focus, and the lantern the pointer carries. Three layers of the `outdoor`
// composer (layers.ts) and the GLSL they share (firefliesSharedGlsl).
//
// Units: the bank and its lattice are laid out in the frame, as the scene always drew them: x in
// screen heights from the middle, y in uv height, the far bank's waterline at FIREFLIES_WATER, which
// the rig puts FIREFLIES_DISTANCE metres ahead. Depths are the rig's metres: the bank at
// FIREFLIES_DISTANCE, the hills behind it at MANGROVES_HILLS_Z, the water where the ray meets it.
//
// mangroves (backdrop, mangrovesGlsl). Above the waterline the World's sky (worldSky: its stars, the
// odd shooting star, the aurora, cloud and the lightning), with the bank's own night staged in place
// of the World's dome as the night deepens (the skyglow low over the trees fading to black
// overhead, and lighting the underside of any cloud); the hills; the mangroves in black from the
// sim's profile (crowns, the gap under them with prop roots and Sonneratia trunks, or the low mud
// bank); the mist lying at their foot. Its view in a level mirror (mangrovesMirror, asked by the
// creek through composerMirror) is the same along the ray the water reflects (its moon swung behind
// the viewer, its stars too fine for the ripples), the bank at the cell's own reflection point
// (firefliesQ). Both the sky and the bank are worked out once per cell, in mangrovesBegin. It sets
// the river's air. As the night lifts, the World's light falls on the bank's night palette
// (firefliesDay).
//
// creek (ground, creekGround). Below the waterline the river: the backdrop mirrored, bent by long
// slow swells (more toward us, none at the far bank's foot, seen at a grazing angle), ruffled where
// a breeze's catspaw crosses it and dulled under rain; darker toward us; the mist on the water along
// the far bank's foot; each pulse's green, the fireflies' light (localLight), on it.
//
// fireflySwarm (life, fireflySwarmGlsl). The fireflies' light is drawn two-state (its shade pass): a
// cell takes the light's colour wherever the light reaching it passes the cell's own fixed dither
// threshold, and shows the night scene otherwise. A flash grows each glow's lit patch from its core
// outward and shrinks it again, so the dither renders brightness as the patch's size and density.
// The lit colour depends only on where the cell lies (near a firefly's core, in its halo, out in the
// soft glow, in a bokeh disc), never on how bright the flashes are, so every cell changes at most
// twice a flash whatever the quantisation: a forest pulsing together breathes instead of strobing.
// The one smooth thing that follows the pulse, a faint green in the sky, the mist and the water, is
// the swarm's light (fireflySwarmGlow, through the composer's localLight), in the green channel only,
// so it too crosses at most one level up and back. The source view gets the smooth picture. The
// lights hide behind anything nearer than they are, and the World's fog and rain veil them (the
// accent its air leaves, c.accent). The lantern, its warm glow and its reflection are its front
// pass; its light reaches every other layer (fireflySwarmLanternLight).
//
// Its data (sim.ts): the mangroves' row (the breeze), field 0 (the bank's profile) and field 1 (the
// prop roots, records of the shared plant component); the swarm's field 0 (per firefly: place in its
// cell, light, soft halo) and row (nearer lights, lantern, bank).
import { glslFloat } from "../../shaders/glsl.ts";
import {
  FIREFLIES_APERTURE,
  FIREFLIES_BANK,
  FIREFLIES_CELL,
  FIREFLIES_DRIFTERS,
  FIREFLIES_NEAR,
  FIREFLIES_PROFILE_RES,
  FIREFLIES_ROOT_PITCH,
  FIREFLIES_ROWS,
  FIREFLIES_STATE_BANK,
  FIREFLIES_STATE_LANTERN,
  FIREFLIES_WATER,
} from "./constants.ts";

/**
 * What the river's layers share (outdoor-code.ts, held by each): the lattice and the camera's
 * passage; per cell (firefliesBegin) the point it shows through the passage, the creek's surface
 * there (whether it shows the water, the reflection's wobble and how clearly it mirrors), the bank
 * point it shows (its own, or its reflection), the breeze, the light at the bank and the night
 * palette as the World lights it; and the bank there as the mangroves found it (leaves, mist).
 */
export const firefliesSharedGlsl = `
// ---- the mangrove river's constants and per-cell state, shared by its layers (fireflies/shader.ts) ----
const float FIREFLIES_CELL = ${glslFloat(FIREFLIES_CELL)};
const float FIREFLIES_WATER = ${glslFloat(FIREFLIES_WATER)};
const float FIREFLIES_DISTANCE = ${glslFloat(FIREFLIES_BANK)};
// The camera settling in on arriving and drifting on as the scene leaves: ZOOM is the share of the
// frame given up (about the waterline), PAN the share of the room that zoom leaves at the edges the
// camera slides into; nearer lights slide against the bank by their parallax, at most PARALLAX times
// as far. The camera alone carries the passage's speed across its seams (the bank is dark at both,
// and the World's stars too few and faint to show the drift, as the scene's own once did), so it
// travels far enough to read there, its motion gathered at the seams.
const float FIREFLIES_ZOOM_IN = 0.12;
const float FIREFLIES_ZOOM_OUT = 0.05;
const float FIREFLIES_PAN = 0.85;
const float FIREFLIES_PARALLAX = 7.0;
// The night's mist and the river's own dark: what the World's daylight lifts as the night ends.
const vec3 FIREFLIES_MIST = vec3(0.070, 0.130, 0.155);
const vec3 FIREFLIES_DEEP = vec3(0.000, 0.000, 0.004);
// Deep in a moonless night (the World's gates: no daylight at this hour, no moon) no light of the
// World's reaches the bank: its night palette stands exactly as painted, known before the program
// runs.
#if WORLD_DAYLIGHT || WORLD_MOON
#define FIREFLIES_LIT 1
#else
#define FIREFLIES_LIT 0
#endif

// Per cell: the screen point (screen heights from the middle, uv height) and the same point through
// the passage's camera, and the camera's pan; how far below the far bank's waterline it lies; whether
// the creek shows the water there, the point of the bank it mirrors (else the cell's own), the
// reflection's sideways wobble and how clearly the water mirrors (1 off the water); the breeze (front
// x, on, strength: the mangroves'); the layers' light at the bank (the fireflies' pulse, green); the
// World's daylight on the bank's night palette, and the mist's and the water's colours under it.
vec2 firefliesPs;
// The World's view through the passage's camera (the composer's own at rest), so the stars drift
// with the bank as the camera settles in and drifts on.
WorldView firefliesView;
vec2 firefliesP;
float firefliesPan;
float firefliesBelow;
bool firefliesRiver;
vec2 firefliesQ;
float firefliesWobble;
float firefliesMirror;
float firefliesReflect;
vec4 firefliesBreeze;
vec3 firefliesGlow;
vec3 firefliesDay;
vec3 firefliesMistCol;
vec3 firefliesDeep;
// The bank at firefliesQ (mangrovesBegin): 1 on leaves, 0.5 under the canopy, 0 in the open; the
// mist's density.
float firefliesLeaves;
float firefliesMist;

void firefliesBegin(Ctx x) {
  vec2 ps = vec2((x.uv.x - 0.5) * x.aspect, x.uv.y);
  // The camera. Arriving, it starts in, looking to the left of where it rests, and glides right and
  // out, quickly at first, to a stop (the bank slides left and widens); leaving, it drifts on the same
  // way, gathering speed to the end. The zoom is about the waterline and only ever zooms in, so the
  // lattice and the forest profile always cover the view, and the pan stays inside what the zoom
  // leaves. 'pan' is the offset of the bank's x, kept for the nearer lights. Both are exactly 0 at
  // rest, where p == ps.
  vec2 p = ps;
  float pan = 0.0;
  float arrive = pow(max(1.0 - passageIn(), 0.0), 6.0);
  float leave = passageOut() * passageOut() * passageOut();
  if (arrive + leave > 0.0) {
    float zoom = FIREFLIES_ZOOM_IN * arrive + FIREFLIES_ZOOM_OUT * leave;
    pan = 0.5 * x.aspect * FIREFLIES_PAN * (FIREFLIES_ZOOM_OUT * leave - FIREFLIES_ZOOM_IN * arrive);
    p = vec2(ps.x * (1.0 - zoom) + pan, FIREFLIES_WATER + (ps.y - FIREFLIES_WATER) * (1.0 - zoom));
  }
  firefliesPs = ps;
  firefliesP = p;
  firefliesPan = pan;
  firefliesView = x.v;
  if (arrive + leave > 0.0) firefliesView = worldView(vec2(p.x / x.aspect + 0.5, p.y), RIG_HORIZON, RIG_FOCAL, x.eye, RIG_TURN, 1.0);
  vec4 breeze = vec4(0.0);
#if LAYER_MANGROVES
  if (mangrovesSimOn()) breeze = mangrovesRecord(0, 0);
#endif
  firefliesBreeze = breeze;

  // Below the waterline the river mirrors the bank: find the point it reflects. Long, slow swells
  // bend the reflection, more toward us and not at all at the far bank's foot, where the water is
  // seen at a grazing angle; a breeze crossing the river ruffles a band of it (a catspaw) that
  // breaks the reflection up and dulls it, as rain does the whole river.
  float below = FIREFLIES_WATER - p.y;
  firefliesBelow = below;
  firefliesRiver = false;
  firefliesQ = p;
  firefliesWobble = 0.0;
  firefliesMirror = 1.0;
  firefliesReflect = 0.0;
#if LAYER_CREEK
  firefliesReflect = K_reflections;
  if (below > 0.0) {
    float tm = x.tm;
    float across = (p.x - breeze.x) / 0.16;
    float gust = breeze.y * min(breeze.z, 1.4) * exp(-across * across) * smoothstep(0.0, 0.05, below);
    float bands = 0.3 / (below + 0.012);
    float swell = vnoise(vec2(p.x * 4.0, bands + tm * 0.05)) - 0.5;
    swell += gust * (vnoise(vec2(p.x * 16.0, 3.0 * bands + tm * 0.6)) - 0.5);
    float wobble = swell * (0.0012 + 0.012 * below) * (1.0 + 2.0 * gust) * smoothstep(0.0, 0.03, below);
    firefliesRiver = true;
    firefliesWobble = wobble;
    firefliesQ = vec2(p.x + wobble, FIREFLIES_WATER + below);
    firefliesMirror = K_reflections * mix(0.92, 0.55, smoothstep(0.0, FIREFLIES_WATER, below)) * (1.0 - 0.6 * gust) * (1.0 - 0.45 * smoothstep(0.0, 0.8, x.w.rain));
  }
#endif

  // The light at the bank point (the fireflies' pulse, every other layer's lamps), for the glow in
  // the damp air, the mist and the water; the World's daylight on the night palette (0 by night).
  vec2 q = firefliesQ;
  firefliesGlow = localLight(vec3(q.x, q.y - FIREFLIES_WATER, RIG_FOCAL) * (FIREFLIES_DISTANCE / RIG_FOCAL), vec3(0.0));
#if FIREFLIES_LIT
  firefliesDay = x.light.amb * (1.0 - x.w.sky.night) + x.light.sun * x.light.keyUp;
  firefliesMistCol = max(FIREFLIES_MIST, vec3(0.72, 0.76, 0.78) * firefliesDay);
  firefliesDeep = max(FIREFLIES_DEEP, vec3(0.04, 0.06, 0.06) * firefliesDay);
#else
  firefliesDay = vec3(0.0);
  firefliesMistCol = FIREFLIES_MIST;
  firefliesDeep = FIREFLIES_DEEP;
#endif
  firefliesLeaves = 0.0;
  firefliesMist = 0.0;
}

// How far the river's ripples spread what it mirrors (rad): the stars are too fine for it, both
// their layers fade to their faint glow (skyStarLayerLod) at any resolution.
const float FIREFLIES_RIPPLE_BLUR = 0.05;

// The view the creek's water mirrors at this cell: the eye's ray reflected in the level water, tipped
// sideways by the swells' wobble, its footprint widened by the ripples.
WorldView firefliesMirrorView(Ctx x) {
  vec3 ray = firefliesView.ray;
  return worldMirrorView(firefliesView, normalize(vec3(ray.x + firefliesWobble * ray.z / RIG_FOCAL, -ray.y, ray.z)), FIREFLIES_RIPPLE_BLUR);
}
`;

/** The mangroves' GLSL: the night over the bank, the hills, the trees and the mist, its air, its view in the river. */
export const mangrovesGlsl = `
// ---- the mangroves (fireflies/shader.ts) ----
const float MANGROVES_RES = ${glslFloat(FIREFLIES_PROFILE_RES)};
const float MANGROVES_ROOT_PITCH = ${glslFloat(FIREFLIES_ROOT_PITCH)};
// The hills' distance (m), far behind the bank.
const float MANGROVES_HILLS_Z = 2500.0;

// The night: skyglow low over the trees fading to black overhead, distant hills, the mangroves in
// black, the mist glowing under them. The skyglow and hills have no red: every channel dithers on
// the same threshold, so they print as black, navy (blue only) and teal (green and blue) cells, never
// grey. The navy, so dark it reads as deep blue sky rather than texture, reaches high and thins out
// slowly; the brighter teal hugs the treeline, where the silhouettes stand against it.
const vec3 MANGROVES_SKYGLOW = vec3(0.000, 0.200, 0.250);
// Per channel, the height (screen heights above the waterline) over which the skyglow falls by e
// (red is 0 anyway), and the heights between which what is left fades out, leaving the sky over
// the stars black.
const vec3 MANGROVES_GLOW_FALL = vec3(1.0, 0.09, 0.20);
const float MANGROVES_GLOW_FADE = 0.2;
const float MANGROVES_GLOW_END = 0.55;
const vec3 MANGROVES_HILLS = vec3(0.000, 0.020, 0.040);
// Under 1/192 a channel (even with the crown tone's 1.25), below the dither's first step at four
// levels, so the silhouettes print solid black.
const vec3 MANGROVES_LEAVES = vec3(0.000, 0.003, 0.003);
const vec3 MANGROVES_GAPGLOW = vec3(0.040, 0.085, 0.105);
// What the World's daylight shows of them: the hills' blue-green, the leaves', the light under them.
const vec3 MANGROVES_HILLS_DAY = vec3(0.10, 0.16, 0.16);
const vec3 MANGROVES_LEAVES_DAY = vec3(0.05, 0.12, 0.05);
const vec3 MANGROVES_GAP_DAY = vec3(0.06, 0.08, 0.06);

// Per cell: the night palette as the World lights it (mangrovesBegin), and the bank at firefliesQ
// (mangrovesAt): the hills there or not; the crowns' or the gap's colour and whether they stand
// there; how much of the prop roots and trunks.
vec3 mangrovesHills;
vec3 mangrovesLeaves;
vec3 mangrovesGap;
float mangrovesHill;
vec4 mangrovesBody;
float mangrovesRootCover;

// One prop root (a record of the roots' field: an arc from its apex down into the water, its turn
// the curl in a plus the breeze's bend, mirrored with its side), two to three cells thick, rounded at
// the apex.
float mangrovesRoot(vec2 q, PlantOrgan o, float w) {
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
// down into the water, each pair the sim's (sim.ts) in its bin of MANGROVES_ROOT_PITCH. An apex to the
// right of q's bin reaches back with its left root, one to the left with its right root, at most
// three bins. Returns coverage.
float mangrovesRoots(vec2 q) {
  if (!mangrovesField1On()) return 0.0;
  vec4 head = texelFetch(mangrovesField1, ivec2(0, 0), 0);
  int bins = int(head.y + 0.5);
  int k0 = int(floor(q.x / MANGROVES_ROOT_PITCH)) - int(round(head.x));
  float w = 1.0 / uRes.y;
  float cover = 0.0;
  for (int i = -3; i <= 3; i++) {
    int k = k0 + i;
    if (k < 0 || k >= bins) continue;
    if (i >= 0) cover = max(cover, mangrovesRoot(q, plantOrgan(mangrovesField1, 1, 2 * k), w));
    if (i <= 0) cover = max(cover, mangrovesRoot(q, plantOrgan(mangrovesField1, 1, 2 * k + 1), w));
  }
  return cover;
}

// The skyglow at h screen heights over the waterline: teal over the trees, deep blue above, fading
// to black overhead, where the stars are; and the light at the bank in the damp air low over it (each
// pulse's faint green).
vec3 mangrovesGlowAt(float h) {
  vec3 col = MANGROVES_SKYGLOW * exp(-max(h, 0.0) / MANGROVES_GLOW_FALL) * (1.0 - smoothstep(MANGROVES_GLOW_FADE, MANGROVES_GLOW_END, h));
  col += 0.012 * firefliesGlow * exp(-h / 0.14);
  return col;
}

// The bank at q, before the sky it stands against (mangrovesOver lays it on): the hills behind it, a
// shade darker than the skyglow; the mangroves, black, leafy round crowns over a gap of prop roots and
// Sonneratia trunks, or the low mud bank; the mist lying on the water, thinning upward over the roots
// and the foot of the trees (and, in the reflection, downward), drifting. Sets mangrovesHill,
// mangrovesBody, mangrovesRootCover, firefliesLeaves and firefliesMist.
void mangrovesAt(vec2 q, float tm) {
  float h = q.y - FIREFLIES_WATER;
  firefliesLeaves = 0.0;
  float roots = 0.0;
  bool sim = mangrovesField0On();
  float cols = sim ? float(textureSize(mangrovesField0, 0).x) / MANGROVES_RES : 2.0;
  float span = cols * FIREFLIES_CELL;
  float x0 = -0.5 * span;

  float hill = 0.035 + 0.05 * vnoise(vec2(q.x * 2.1 + 3.0, 1.7)) + 0.012 * vnoise(vec2(q.x * 8.3, 4.1));
  mangrovesHill = h < hill ? 1.0 : 0.0;

  vec4 prof = sim ? texture(mangrovesField0, vec2((q.x - x0) / span, 0.25)) : vec4(vec2(FIREFLIES_WATER + 0.012), 0.0, 0.0);
  float n1 = vnoise(q * vec2(150.0, 170.0));
  float n2 = vnoise(q * vec2(48.0, 60.0) + 7.3);
  float top = prof.x + 0.008 * (0.6 * n1 + 0.4 * n2 - 0.5);
  bool mud = prof.x - prof.y < 0.004;
  mangrovesBody = vec4(0.0);
  if (q.y < top) {
    float depth = top - q.y;
    float base = mud ? -1.0 : prof.y + 0.008 * (n2 - 0.5) - 0.004 * n1;
    if (q.y >= base) {
      // Leaves, with the sky showing through here and there at the top.
      float holes = mud ? 0.0 : vnoise(q * vec2(230.0, 250.0) + 3.1);
      if (depth > 0.012 || holes < 0.62 + 0.4 * depth / 0.012) {
        mangrovesBody = vec4(mangrovesLeaves * (0.75 + 0.5 * prof.z), 1.0);
        firefliesLeaves = 1.0;
      }
    } else {
      // Under the canopy: the dark of the leaves, lifting toward the water, crossed by prop roots
      // and trunks (drawn again over the mist below, so they stand in it).
      float up = clamp(h / max(base - FIREFLIES_WATER, 1e-3), 0.0, 1.0);
      vec3 col = mix(mangrovesGap, mangrovesLeaves, sqrt(up));
      float trunk = sim ? texture(mangrovesField0, vec2((q.x - x0) / span, 0.75)).r : 0.0;
      roots = max(mangrovesRoots(q), smoothstep(0.4, 0.6, trunk));
      mangrovesBody = vec4(mix(col, mangrovesLeaves, roots), 1.0);
      firefliesLeaves = 0.5;
    }
  }
  mangrovesRootCover = roots;

#if LAYER_CREEK
  float mistKnob = K_creekMist;
#else
  float mistKnob = 0.0;
#endif
  firefliesMist = min(0.75, 1.6 * mistKnob * exp(-max(h, 0.0) / 0.04) * (0.45 + 0.55 * vnoise(vec2(q.x * 3.5 - tm * 0.012, h * 26.0 + 2.0))));
}

// The bank (mangrovesAt) over the sky it stands against.
vec3 mangrovesOver(vec3 sky) {
  vec3 col = sky;
  if (mangrovesHill > 0.5) col = mix(col, mangrovesHills, 0.65);
  if (mangrovesBody.a > 0.5) col = mangrovesBody.rgb;
  float mist = firefliesMist;
  col = mix(col, firefliesMistCol, mist);
  col = mix(col, mangrovesLeaves, 0.7 * mangrovesRootCover);
  col += 0.02 * firefliesGlow * mist;
  return col;
}

// The World's sky along a ray (heaven, over its own dome) with the bank's night staged in place of
// the dome as the night deepens (dark: the same sky over no dome, so the skyglow where the sky is
// open, and lighting the underside of whatever cloud covers it). In the whole night it is exactly
// the sky the program without WORLD_DAYLIGHT draws.
vec3 mangrovesNight(World w, WorldSky heaven, WorldSky dark, float h) {
  vec3 night = dark.col + mangrovesGlowAt(h);
  return (w.sky.night >= 1.0 ? night : mix(heaven.col, night, w.sky.night)) + heaven.strike;
}

// ---- the mangroves' passes ----
// The World's sky along the cell's ray with the night staged on it (mangrovesBegin), for the sky
// pass above the waterline and the mirror pass below it.
vec3 mangrovesSkyCol;

// Per cell: the river's air (the haze toward the bank, the mist in fog and rain, the drops' light,
// the sky wet things mirror; by night the mist's colour); the night palette as the World lights it;
// the bank at the cell's point, or at the point of it the creek mirrors. The World's sky is worked
// out here once, along the cell's own ray above the waterline and below it along the ray the creek's
// water reflects (firefliesMirrorView: the view the creek asks the mirror with), the moon swung
// round behind the viewer as a mirror shows it (skyMirror): a software rasteriser runs every line of
// a program, so the sky and the mirror sharing one sky costs one sky. At an hour whose night is
// whole (no WORLD_DAYLIGHT) the skyglow stands everywhere in place of the World's dome, which is
// then never worked out: the World's sky is drawn over it (worldSkyOver), its lights alone. The land
// ends at the far bank's waterline.
void mangrovesBegin(inout Ctx x) {
#if WORLD_DAYLIGHT
  vec3 haze = mix(x.light.amb * 1.3 + x.light.sun * 0.2, FIREFLIES_MIST, x.w.sky.night);
#else
  vec3 haze = FIREFLIES_MIST;
#endif
  x.air = Air(haze, firefliesMistCol, max(haze * 1.2, vec3(0.06)), haze, 0.0, 0.002, 0.0);
  x.groundTo = FIREFLIES_WATER;
  x.landZ = FIREFLIES_DISTANCE;
#if FIREFLIES_LIT
  vec3 day = firefliesDay;
  float wet = uWeather.x;
  float snow = 0.5 * snowCover(vec3(0.0, 1.0, 0.0), firefliesQ * 40.0, uWeather.y);
  mangrovesHills = max(MANGROVES_HILLS, MANGROVES_HILLS_DAY * day);
  mangrovesLeaves = max(MANGROVES_LEAVES, mix(wetten(MANGROVES_LEAVES_DAY, wet, 0.3), vec3(0.85, 0.88, 0.92), snow) * day);
  mangrovesGap = max(MANGROVES_GAPGLOW, wetten(MANGROVES_GAP_DAY, wet, 0.5) * day);
#else
  mangrovesHills = MANGROVES_HILLS;
  mangrovesLeaves = MANGROVES_LEAVES;
  mangrovesGap = MANGROVES_GAPGLOW;
#endif
  mangrovesAt(firefliesQ, x.tm);
  World w = x.w;
  WorldView v = firefliesView;
  if (firefliesRiver) {
    w.sky = skyMirror(w.sky);
    v = firefliesMirrorView(x);
  }
  float h = firefliesQ.y - FIREFLIES_WATER;
#if WORLD_DAYLIGHT
  WorldSky heaven = worldSky(w, v, WORLD_METEOR_FIELD);
  WorldSky dark = worldSkyOver(w, v, WORLD_METEOR_FIELD, vec3(0.0));
  mangrovesSkyCol = mangrovesNight(w, heaven, dark, h);
#else
  WorldSky heaven = worldSkyOver(w, v, WORLD_METEOR_FIELD, vec3(0.0));
  mangrovesSkyCol = heaven.col + mangrovesGlowAt(h) + heaven.strike;
#endif
}

// Above the far bank's waterline the World's sky, the bank's skyglow in place of its dome by night.
void mangrovesSky(Ctx x, inout Cell c) {
  if (x.uv.y < x.groundTo) return;
  c.col = mangrovesSkyCol;
}

// The hills, the mangroves and the mist at their foot, over the sky; the trees at the bank's depth.
void mangrovesFar(Ctx x, inout Cell c) {
  if (x.uv.y < x.groundTo) return;
  c.col = mangrovesOver(c.col);
  if (mangrovesBody.a > 0.5 || mangrovesHill > 0.5) {
    c.z = mangrovesBody.a > 0.5 ? FIREFLIES_DISTANCE : MANGROVES_HILLS_Z;
    c.zs = c.z;
  }
  c.accent = 0.0;
}

// The bank in a level mirror (the creek, through composerMirror, with m its firefliesMirrorView): the
// World's sky along the reflected ray with the skyglow staged in place of its dome (worked out with
// that view in mangrovesBegin), and the bank over it at the point of it the cell mirrors (firefliesQ,
// as the creek's swells bend it).
Mirrored mangrovesMirror(Ctx x, vec3 at, vec3 ray, WorldView m, vec2 spread) {
  return Mirrored(mangrovesOver(mangrovesSkyCol), vec3(0.0), vec2(0.0));
}
`;

/** The creek's GLSL: the river mirroring the bank, the mist on it. */
export const creekGlsl = `
// ---- the creek (fireflies/shader.ts) ----
// The river below the far bank's waterline: the bank and its sky mirrored (composerMirror) at the
// point the swells bend the reflection to, darker toward us; the mist on the water along the far
// bank's foot, and each pulse's green on it (the light at the bank it mirrors).
void creekGround(Ctx x, inout Cell c) {
  if (x.uv.y >= min(x.groundTo, FIREFLIES_WATER)) return;
  vec2 xz = vec2((x.uv.x - 0.5) * x.aspect * x.zg / RIG_FOCAL, x.zg);
  WorldView m = firefliesMirrorView(x);
  Mirrored seen = composerMirror(x, vec3(xz.x, 0.0, xz.y), m.ray, m, vec2(0.0));
  vec3 col = firefliesDeep + seen.col * firefliesMirror;
  float low = K_creekMist * exp(-firefliesBelow / 0.03) * (0.5 + 0.5 * vnoise(vec2(firefliesP.x * 3.0 - x.tm * 0.01, 9.0)));
  col = mix(col, firefliesMistCol, low * 0.7);
  col += 0.009 * firefliesGlow * firefliesMirror;
  c.col = col;
  c.z = x.zg;
  c.accent = 0.0;
}
`;

/** The swarm's GLSL: its lights (two-state, in its shade pass), the lantern, and the light both throw. */
export const fireflySwarmGlsl = `
// ---- the fireflies (fireflies/shader.ts) ----
const int FIREFLY_SWARM_ROWS = ${FIREFLIES_ROWS};
const int FIREFLY_SWARM_NEAR = ${FIREFLIES_NEAR};
const int FIREFLY_SWARM_DRIFTERS = ${FIREFLIES_DRIFTERS};
const int FIREFLY_SWARM_LANTERN = ${FIREFLIES_STATE_LANTERN};
const int FIREFLY_SWARM_STATE = ${FIREFLIES_STATE_BANK};
const float FIREFLY_SWARM_APERTURE = ${glslFloat(FIREFLIES_APERTURE)};
// A bank firefly's glow radius in cells at size 1 (its place stays 0.06 inside its cell, so at the
// largest size, 1.2, every glow reaching a point lies in the 3×3 cells around it).
const float FIREFLY_SWARM_REACH = 0.85;
// Light at which a cell is certainly lit, per unit of a firefly's light: its glow, and the soft
// halo around it, which only gathers where several flash together (a lone flash barely shows one,
// a crown flashing as one glows up to GLOW_MAX of its cells lit).
const float FIREFLY_SWARM_GAIN = 1.55;
const float FIREFLY_SWARM_GLOW_LOW = 0.03;
const float FIREFLY_SWARM_GLOW_HIGH = 0.35;
const float FIREFLY_SWARM_GLOW_MAX = 0.6;
// Reflected light, against the light it mirrors (times the river's mirror).
const float FIREFLY_SWARM_REFLECTED = 0.75;
// The out-of-focus fireflies: most of a disc's cells lit at the height of a flash.
const float FIREFLY_SWARM_BOKEH_GAIN = 0.42;
// Reflections are drawn this much taller than the lights they mirror.
const float FIREFLY_SWARM_STRETCH = 1.6;
// How far out along the pointer's ray the lantern hangs (m), for the light it throws.
const float FIREFLY_SWARM_ARM = 1.5;
// Lit colours: a firefly's core and halo, the dim green of its soft glow, the M, the warm green of
// the out-of-focus ones; the lantern's body and warm halo.
const vec3 FIREFLY_SWARM_CORE = vec3(0.85, 1.00, 0.35);
const vec3 FIREFLY_SWARM_HALO = vec3(0.35, 0.72, 0.14);
const vec3 FIREFLY_SWARM_GLOW = vec3(0.10, 0.32, 0.06);
const vec3 FIREFLY_SWARM_MARK = vec3(0.92, 1.00, 0.66);
const vec3 FIREFLY_SWARM_BOKEH = vec3(0.72, 1.00, 0.28);
const vec3 FIREFLY_SWARM_LAMP = vec3(1.00, 0.84, 0.56);
const vec3 FIREFLY_SWARM_WARM = vec3(1.00, 0.52, 0.16);

// The accent other layers left the cell (the swarm's front pass sets c.accent to 1, so what the
// World's fog and rain leave of it is how much of the fireflies' light gets through).
float fireflySwarmAccentWas;

bool fireflySwarmOn() {
  return fireflySwarmSimOn() && fireflySwarmField0On();
}

// The fireflies' glow on a surface at p (rig frame) facing n: the bank's mean flash, in the green
// channel alone, whole at the bank and falling off toward us.
vec3 fireflySwarmGlow(vec3 p, vec3 n) {
  if (!fireflySwarmOn()) return vec3(0.0);
  float near = clamp((FIREFLIES_DISTANCE - p.z) / FIREFLIES_DISTANCE, 0.0, 1.0);
  return vec3(0.0, fireflySwarmRecord(FIREFLY_SWARM_STATE, 0).x, 0.0) / (1.0 + 8.0 * near * near);
}

// The lantern's warm light on a surface at p facing n (0: lit all round): it hangs an arm's length
// out along the pointer's ray, brighter as it flares.
vec3 fireflySwarmLanternLight(vec3 p, vec3 n) {
  if (!fireflySwarmOn()) return vec3(0.0);
  vec4 lantern = fireflySwarmRecord(FIREFLY_SWARM_LANTERN, 0);
  if (lantern.z <= 0.004) return vec3(0.0);
  vec3 at = vec3(0.0, RIG_EYE, 0.0) + normalize(vec3(lantern.x, lantern.y - RIG_HORIZON, RIG_FOCAL)) * FIREFLY_SWARM_ARM;
  vec3 d = at - p;
  float r2 = dot(d, d);
  float facing = dot(n, n) > 0.0 ? max(dot(n, d) * inversesqrt(r2), 0.0) : 1.0;
  return FIREFLY_SWARM_WARM * (lantern.z * (0.22 + 0.7 * lantern.w) * facing / (1.0 + r2 / 0.36));
}

// The bank's fireflies around q: returns the light reaching q. 'reach' says how deep q lies in the
// nearest glow (0 outside every glow, 1 at a firefly), 'core' how much it lies in a glow's core,
// 'mark' in the glow of a firefly drawing the M: all three from places alone, never from flashes,
// so a lit cell keeps its colour. Each glow is a compact bump (1 - r²)² about the firefly's place,
// sized by a hash of its world cell; 'stretch' draws them taller, for the reflections, which then
// need two rows either side.
float fireflySwarmAt(vec2 q, float x0, float cols, float stretch, out float reach, out float core, out float mark) {
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
      if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= FIREFLY_SWARM_ROWS) continue;
      vec4 f = texelFetch(fireflySwarmField0, c, 0);
      if (f.x < 0.0) continue;
      float size = 0.62 + 0.58 * hash12(vec2(float(c.x) - 0.5 * cols, float(c.y)) + K_seed * 0.173);
      vec2 d = g - vec2(c) - vec2(f.x, abs(f.y));
      d.y /= stretch;
      float r2 = dot(d, d) / (FIREFLY_SWARM_REACH * FIREFLY_SWARM_REACH * size * size);
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

// The lantern: a small warm body with its halo, swinging after the pointer, and its long reflection
// on the water below it. Here too the fireflies' light begins: c.accent from now on is what the
// World's air leaves of it.
void fireflySwarmFront(Ctx x, inout Cell c) {
  fireflySwarmAccentWas = c.accent;
  c.accent = 1.0;
  vec4 lantern = fireflySwarmOn() ? fireflySwarmRecord(FIREFLY_SWARM_LANTERN, 0) : vec4(0.0);
  vec2 ps = firefliesPs;
  float lamp = 0.0;
  if (lantern.z > 0.004) {
    float tm = x.tm;
    float flame = 1.0 + 0.05 * sin(tm * 2.1) + 0.03 * sin(tm * 3.4 + 1.3);
    vec2 dl = ps - lantern.xy;
    lamp = smoothfall(1.0, 0.6, length(dl / vec2(0.0055, 0.0075))) * lantern.z;
    float warm = exp(-length(dl) / (0.03 + 0.04 * lantern.w)) * (0.22 + 0.7 * lantern.w) * flame;
    float surface = min(lantern.y, FIREFLIES_WATER) - 0.05;
    if (ps.y < surface) {
      warm += 0.4 * firefliesReflect * flame * exp(-abs(ps.x - 3.0 * firefliesWobble - lantern.x) / 0.006) * exp(-abs(ps.y - (2.0 * surface - lantern.y)) / 0.05);
    }
    c.col += FIREFLY_SWARM_WARM * warm * lantern.z;
  }
  c.col = mix(c.col, FIREFLY_SWARM_LAMP, lamp);
}

// Lit or not: a cell takes the light's colour where the light passes its own threshold. The light:
// the bank's fireflies, or their reflections, hazier in the mist, and their soft halos, which glow
// through the crowns where many flash together; the lights nearer than the bank (drifters low over
// the river, each mirrored straight below it, as far under the surface as it flies above; the ones
// close to us, out of focus, soft warm-green discs up at the sides); each hidden behind whatever
// stands nearer than it, all of it veiled by the World's air. The colour comes from where the cell
// lies: a bokeh disc, a firefly's core, its halo fading out to the dim green of the soft glow.
void fireflySwarmShade(Ctx x, Cell c, inout Shade o) {
  bool sim = fireflySwarmOn();
  float cols = sim ? float(textureSize(fireflySwarmField0, 0).x) : 2.0;
  float span = cols * FIREFLIES_CELL;
  float x0 = -0.5 * span;
  vec4 bank = sim ? fireflySwarmRecord(FIREFLY_SWARM_STATE, 0) : vec4(0.0);
  vec2 p = firefliesP;
  vec2 q = firefliesQ;
  bool river = firefliesRiver;
  float mirror = firefliesMirror;
  float mist = firefliesMist;
  float pan = firefliesPan;
  // On the water, what the cell shows is the creek's surface; above it, the bank or what is behind.
  bool water = river && c.z >= x.zg * 0.999;
  bool bankSeen = river ? water : p.y >= FIREFLIES_WATER && c.z >= FIREFLIES_DISTANCE - 1.0;

  float reach = 0.0;
  float core = 0.0;
  float mark = 0.0;
  float bankLight = sim && bankSeen ? fireflySwarmAt(q, x0, cols, river ? FIREFLY_SWARM_STRETCH : 1.0, reach, core, mark) : 0.0;
  bankLight *= FIREFLY_SWARM_GAIN * (1.0 - 0.45 * mist);
  float halo = sim && bankSeen ? texture(fireflySwarmField0, vec2((q.x - x0) / span, (q.y - FIREFLIES_WATER) / (float(FIREFLY_SWARM_ROWS) * FIREFLIES_CELL))).a : 0.0;
  float glowLight = FIREFLY_SWARM_GLOW_MAX * smoothstep(FIREFLY_SWARM_GLOW_LOW, FIREFLY_SWARM_GLOW_HIGH, halo) * (0.75 + 0.25 * firefliesLeaves + 0.6 * mist);
  if (river) {
    bankLight *= FIREFLY_SWARM_REFLECTED * mirror;
    glowLight *= FIREFLY_SWARM_REFLECTED * mirror;
    core *= 0.6;
  }

  float nearLight = 0.0;
  float disc = 0.0;
  int bokeh = sim ? int(K_near + 0.5) : 0;
  for (int k = 0; k < FIREFLY_SWARM_NEAR; k++) {
    if (!sim) break;
    vec4 f = fireflySwarmRecord(k, 0);
    if (k < FIREFLY_SWARM_DRIFTERS) {
      if (f.z < 0.0) continue;
      float r = clamp(0.09 / f.z, 0.0028, 0.0065);
      vec2 pn = vec2(p.x + pan * (min(FIREFLIES_DISTANCE / f.z, FIREFLIES_PARALLAX) - 1.0), p.y);
      vec2 d = (pn - f.xy) / r;
      float r2 = dot(d, d);
      if (r2 < 1.0 && c.z >= f.z) {
        float kk = (1.0 - r2) * (1.0 - r2);
        nearLight += f.w * kk * FIREFLY_SWARM_GAIN;
        reach = max(reach, kk);
        core = max(core, 1.0 - smoothstep(0.08, 0.3, r2));
      }
      float surface = RIG_HORIZON - RIG_EYE * RIG_FOCAL / f.z;
      if (water && p.y < surface) {
        vec2 dm = vec2(pn.x + firefliesWobble - f.x, (p.y - (2.0 * surface - f.y)) / FIREFLY_SWARM_STRETCH) / r;
        float m2 = dot(dm, dm);
        if (m2 < 1.0) {
          float km = (1.0 - m2) * (1.0 - m2);
          nearLight += f.w * km * FIREFLY_SWARM_GAIN * FIREFLY_SWARM_REFLECTED * mirror;
          reach = max(reach, km);
        }
      }
    } else {
      if (k - FIREFLY_SWARM_DRIFTERS >= bokeh) continue;
      float r = FIREFLY_SWARM_APERTURE * RIG_FOCAL * (1.0 / f.z - 1.0 / FIREFLIES_DISTANCE);
      vec2 pn = vec2(p.x + pan * (min(FIREFLIES_DISTANCE / f.z, FIREFLIES_PARALLAX) - 1.0), p.y);
      float dist = length(pn - f.xy) / r;
      if (dist >= 1.0 || c.z < f.z) continue;
      nearLight += f.w * FIREFLY_SWARM_BOKEH_GAIN * smoothfall(1.0, 0.15, dist);
      disc = max(disc, smoothfall(1.0, 0.9, dist));
    }
  }

  float seen = c.accent;
  float light = (bankLight + glowLight + nearLight) * seen;
  float lit = step(1.0 - light, threshold(x.cell + vec2(5.0, 2.0)));
  vec3 glow = mix(FIREFLY_SWARM_GLOW, FIREFLY_SWARM_HALO, smoothstep(0.0, 0.45, reach));
  glow = mix(mix(glow, FIREFLY_SWARM_CORE, core), FIREFLY_SWARM_MARK, mark);
  glow = mix(glow, FIREFLY_SWARM_BOKEH, disc);

  // Accent: the fireflies; while the M holds, the others step back so it reads in two tones too.
  float accent = lit * mix(0.55 + 0.45 * core, 1.0, mark) * mix(1.0, 0.45, bank.w * (1.0 - mark));
  o.ink = max(o.ink, 0.85 * lit);
  o.accent = max(fireflySwarmAccentWas * seen, accent);
  o.rgb = mix(c.col, glow, lit);
  o.source = c.col + glow * min(light, 1.2) * 0.85;
}
`;
