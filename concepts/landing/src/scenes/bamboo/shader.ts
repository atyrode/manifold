// The Bamboo grove preset's GLSL (ADR 0062 Phase 2b): a misty grove seen side-on through BAMBOO_RIG,
// a water clock in its near right corner. Its parts, each a layer (layers.ts), drawn in the order the
// grove always painted them:
//   grove         (backdrop) the mist (jade in the depths, green-gold up toward the canopy, lit by the
//                 sky), the World's sky through the canopy's gaps washed by the leaves (its deck greyed
//                 under the rain, shafts of heavier rain hanging from it), the far canopy breathing
//                 with the far stems' sway; the god rays and the mist's banks (its begin, groveBegin,
//                 for every layer: the rays gild what they cross); the drips off the leaves (its front
//                 veil); the grove's air.
//   groveFloor    (ground) the litter and moss, strewn with fallen leaves, pools in its hollows
//                 mirroring the bright mist and the lantern, the lantern's contact shadow at its foot.
//   culms         (dressing) five depth layers of culms (one big near culm framing the left edge) with
//                 leafy branches and canopy sprays on the second and third, the far three in the middle
//                 band and the near two in the front band, so the lantern stands between them; then the
//                 leaves in the air.
//   stoneLantern  (dressing) the stone lantern on the floor between the third and the second layers,
//                 the rain running off its eaves, its halo in the mist; its light reaches every layer.
//   clock         (dressing) the water clock in the near right corner: striking stone, tube, posts,
//                 spout, the mossy basin and its water, the rings and the leaves floating on it.
// Rain closes the sky, greys and thickens the mist, and (through uWeather.x, how wet the grove is)
// darkens and glosses every surface, pools on the floor and keeps the leaves dripping as it dries.
//
// What the grove keeps of its own, and what is the World's and the composer's: the grove keeps its
// own light (bambooBegin): the World's sky, closed over under rain or snow by the canopy's own cloud
// (canopyWeather on the clear sky) rather than the World's deck, its hue left outside so the leaves
// make the light green. The sky in the gaps is the World's (worldSky, through the grove's own lens
// of a radian, as it always drew it); the rain and snow fall at the composed depth (the World's
// precipitation, half of it kept off under the canopy by its shelter claim, the drops thinned so they
// never bury the stems). The gusts are the composer's one gust field (ADR 0062 D4): the grove's sim
// (sim.ts) bows the culms by its load where each stands, and the shader reads their sway. The
// passage is the grove's (the culms leaning in and out, the spout's first water), exactly off at rest.
//
// The shared part (bambooSharedGlsl, every layer's) holds the constants, the light and the shapes;
// it reads the other layers' gates (LAYER_STONE_LANTERN, LAYER_CLOCK) so a grove without its lantern
// or its water clock lets the culms stand where they would have kept clear. Knobs read: the grove's
// K_groveMist and K_groveShafts (its begin hands them on), the culms' K_stems, the lantern's
// K_stoneLantern and K_stoneLanternMark (trigger TRIGGER_stoneLanternMark summons the M), the clock's
// K_knock; the composer's K_seed and the World's K_wind and K_moon. Data: the grove's row (the gust
// over the stems) and field (the culms' sway), the culms' field (the same sway) and row (the leaves
// in the air), the clock's two rows (the tube and the rings; the leaves on the basin): sim.ts.
//
// Frame: p = ((uv.x - 0.5) * aspect, uv.y), x in screen heights from the centre, y the screen height.
import { glslFloat } from "../../shaders/glsl.ts";
import { canopyGroveGlsl } from "../../shaders/lib/canopy.ts";
import { BAMBOO_PASSAGE } from "./constants.ts";
import {
  BAMBOO_BASIN,
  BAMBOO_CELLS,
  BAMBOO_CORNER_FIT,
  BAMBOO_DEVICE_DEPTH,
  BAMBOO_EYE,
  BAMBOO_HORIZON,
  BAMBOO_LANTERN,
  BAMBOO_LAYERS,
  BAMBOO_LIP,
  BAMBOO_MAX_LEAVES,
  BAMBOO_POST_X,
  BAMBOO_POUR,
  BAMBOO_RIPPLES,
  BAMBOO_SPOUT,
  BAMBOO_STREAM_START,
  BAMBOO_STRIKE,
  BAMBOO_SWAY_HEIGHT,
  BAMBOO_TUBE,
  type BambooLayer,
} from "./layout.ts";

/** A number as a GLSL float literal. */
const f = (value: number): string => value.toFixed(4);
/** One number per depth layer, as a GLSL float array. */
const layerFloats = (pick: (layer: BambooLayer) => number): string =>
  `float[${BAMBOO_LAYERS.length}](${BAMBOO_LAYERS.map((layer) => f(pick(layer))).join(", ")})`;
const LAYERS = BAMBOO_LAYERS.length;

/**
 * The grove's shared GLSL (every bamboo layer holds it): its constants and colours, the canopy's
 * grove (shaders/lib/canopy.ts), the per-cell state its begin and the grove's set and the layers read,
 * and the shapes and light more than one layer draws with.
 */
export const bambooSharedGlsl = `
// ---- the bamboo grove (bamboo/shader.ts), shared by its layers ----
const float BAMBOO_HORIZON = ${f(BAMBOO_HORIZON)};
const float BAMBOO_EYE = ${f(BAMBOO_EYE)};
const int BAMBOO_LAYERS = ${LAYERS};
const float BAMBOO_Z[${LAYERS}] = ${layerFloats((layer) => layer.depth)};
const float BAMBOO_SPACING[${LAYERS}] = ${layerFloats((layer) => layer.spacing)};
const float BAMBOO_DIAMETER[${LAYERS}] = ${layerFloats((layer) => layer.diameter)};
const int BAMBOO_CELLS = ${BAMBOO_CELLS};
const float BAMBOO_SWAY_HEIGHT = ${f(BAMBOO_SWAY_HEIGHT)};
// Canopy sprays on layers 1 and 2: one fan of leaves per cell of this grid (metres).
const vec2 BAMBOO_SPRAY_CELL = vec2(0.5, 0.36);
// The far canopy's underside, for the depth of what the cell shows (the rain hides behind it).
const float BAMBOO_CANOPY_Z = 14.0;

// The water clock, in device units (layout.ts).
const vec2 BAMBOO_PIVOT = vec2(${f(BAMBOO_TUBE.x)}, ${f(BAMBOO_TUBE.y)});
const float BAMBOO_BACK = ${f(BAMBOO_TUBE.back)};
const float BAMBOO_FRONT = ${f(BAMBOO_TUBE.front)};
const float BAMBOO_RADIUS = ${f(BAMBOO_TUBE.radius)};
const float BAMBOO_CUT = ${f(BAMBOO_TUBE.cut)};
const float BAMBOO_REST = ${f(BAMBOO_TUBE.rest)};
const vec2 BAMBOO_STRIKE = vec2(${f(BAMBOO_STRIKE.x)}, ${f(BAMBOO_STRIKE.top)});
const vec2 BAMBOO_SPOUT_FROM = vec2(${f(BAMBOO_SPOUT.fromX)}, ${f(BAMBOO_SPOUT.fromY)});
const vec2 BAMBOO_SPOUT_TO = vec2(${f(BAMBOO_SPOUT.toX)}, ${f(BAMBOO_SPOUT.toY)});
const float BAMBOO_SPOUT_R = ${f(BAMBOO_SPOUT.radius)};
const vec2 BAMBOO_LIP = vec2(${f(BAMBOO_LIP.x)}, ${f(BAMBOO_LIP.y)});
const float BAMBOO_POST_X = ${f(BAMBOO_POST_X)};
const vec4 BAMBOO_BASIN = vec4(${f(BAMBOO_BASIN.x)}, ${f(BAMBOO_BASIN.y)}, ${f(BAMBOO_BASIN.rx)}, ${f(BAMBOO_BASIN.ry)});
const float BAMBOO_POUR_SPEED = ${f(BAMBOO_POUR.speed)};
const float BAMBOO_POUR_GRAVITY = ${f(BAMBOO_POUR.gravity)};
const float BAMBOO_DEVICE_DEPTH = ${f(BAMBOO_DEVICE_DEPTH)};
const float BAMBOO_CORNER_ASPECT = ${f(BAMBOO_CORNER_FIT.aspect)};
const float BAMBOO_CORNER_SMALLEST = ${f(BAMBOO_CORNER_FIT.smallest)};
const float BAMBOO_CORNER_SIZE = ${f(BAMBOO_CORNER_FIT.size)};
const float BAMBOO_LANTERN_X = ${f(BAMBOO_LANTERN.x)};
const float BAMBOO_LANTERN_DEPTH = ${f(BAMBOO_LANTERN.depth)};
const int BAMBOO_RIPPLES = ${BAMBOO_RIPPLES};
const int BAMBOO_LEAVES = ${BAMBOO_MAX_LEAVES};

// Passage (BAMBOO_PASSAGE, in seconds). The entrance: culms near the frame's edges start leaned out
// of frame (BAMBOO_LEAN_IN metres of deflection at BAMBOO_SWAY_HEIGHT) and sway in, already moving,
// settling with a small swing past upright, side by side layer by layer; the spout's first water
// leaves its lip at BAMBOO_STREAM_START and falls into the tube. The exit: a gust front sweeps
// downwind across the grove and bows the culms, faster and faster, to BAMBOO_LEAN_OUT metres.
const float BAMBOO_ENTER = ${glslFloat(BAMBOO_PASSAGE.enter)};
const float BAMBOO_EXIT = ${glslFloat(BAMBOO_PASSAGE.exit)};
const float BAMBOO_STREAM_START = ${glslFloat(BAMBOO_STREAM_START)};
const float BAMBOO_LEAN_IN = 4.5;
const float BAMBOO_LEAN_OUT = 2.2;

const vec3 BAMBOO_YOUNG = vec3(0.20, 0.54, 0.22);     // a young culm: jade
const vec3 BAMBOO_OLD = vec3(0.50, 0.56, 0.22);       // an old one, gone olive-gold
const vec3 BAMBOO_WAX = vec3(0.72, 0.78, 0.70);       // the white bloom below a young culm's nodes
const vec3 BAMBOO_LEAF = vec3(0.10, 0.28, 0.09);      // a leaf in shade
const vec3 BAMBOO_LEAF_LIT = vec3(0.62, 0.80, 0.22);  // a leaf with the light through it
const vec3 BAMBOO_DRY = vec3(0.68, 0.54, 0.26);       // a fallen leaf
const vec3 BAMBOO_LITTER = vec3(0.26, 0.20, 0.12);    // the grove floor
const vec3 BAMBOO_MOSS = vec3(0.22, 0.42, 0.09);
const vec3 BAMBOO_GRANITE = vec3(0.46, 0.47, 0.44);
const vec3 BAMBOO_CANE = vec3(0.62, 0.58, 0.26);      // the water clock's seasoned cane
const vec3 BAMBOO_CUT_FACE = vec3(0.85, 0.80, 0.58);  // fresh-cut cane
const vec3 BAMBOO_FLAME = vec3(1.0, 0.62, 0.28);      // the lantern
const vec3 BAMBOO_MIST_DEEP = vec3(0.40, 0.66, 0.62); // the mist in the depths: cool jade
const vec3 BAMBOO_MIST_HIGH = vec3(0.66, 0.84, 0.60); // up toward the canopy: green-gold
const vec3 BAMBOO_FILTER = vec3(0.95, 0.92, 0.62);    // sunlight through leaves: gold-green

// This cell's light and state: bambooBegin's (every layer's) unless marked, then the grove's
// (groveBegin) and the lantern's (stoneLanternBegin), all before any pass.
CanopyWeather bambooWeather; // the sky as the canopy closes over it
Sky bambooSky;
float bambooAspect;
vec2 bambooP;          // the cell: x from the centre line, y up (screen heights)
vec2 bambooPar;        // the pointer's parallax: nearer things slide further (divided by depth)
float bambooTm;        // the motion clock
float bambooLevel;     // how bright the sky is (luminance of its ambient light)
vec3 bambooFill;       // the grove's soft light on surfaces, green from the leaves overhead
vec3 bambooKey;        // direct sun and moon, where a ray gets through
vec2 bambooKeySide;    // their horizontal direction (x across, z into the scene), unit
float bambooBeam;      // the grove's: 0..1, how much this point lies in a ray (lights what it falls on)
vec3 bambooMist;       // the grove's: the mist's colour here, rays included
vec3 bambooSheen;      // the grove's: the bright mist up under the canopy, what glossy cane mirrors
float bambooWisp;      // the grove's: the mist's thickness here, about 1
float bambooMistK;     // the grove's: its mist knob (K_groveMist)
float bambooDens;      // the grove's: the mist's extinction per metre here, low down
float bambooRain;      // rain (or snow) falling now, 0..1 (the World's)
float bambooRainHere;  // the rain reaching this point through the canopy, 0..1
float bambooOvercast;  // how far the rain's cloud has closed over the sky, 0..1
float bambooCloud;     // the brightness of that cloud deck, lit from above (luminance)
float bambooWet;       // how wet the grove is, 0..1 (uWeather.x: rises while it rains, dries after)
float bambooGloss;     // the extra sheen of wet upright cane (wetGloss)
float bambooDripAmount; // how hard the leaves drip, 0..1: while wet, most while it rains
float bambooNearX;     // screen x of the big near culm
vec3 bambooRaySrc;     // screen x where each ray leaves the canopy (top of the frame)
float bambooRaySlant;  // the rays' angle from straight down, + falling toward -x
float bambooCorner;    // the corner group's scale: screen heights per device unit
float bambooLanternScale; // the lantern's: screen heights per metre of it
vec2 bambooLanternFootAt; // the lantern's foot, in screen units
vec2 bambooLanternAt;  // the lantern's window, in screen units
float bambooLanternLit; // the lantern's: how bright its window is (0 without the lantern)
float bambooEnterT;    // seconds into the entrance (BAMBOO_ENTER once arrived)
float bambooExitT;     // seconds into the exit (0 unless leaving)
bool bambooPassing;    // an entrance or exit is playing: false at rest, so every passage term is skipped

// The mist as the sky lights it: dark cool jade low in the grove's depths, brightening to green-gold
// up toward the canopy where the light comes in through the leaves, a little warmer on the sun's side,
// teal under the moon. Only the sky's brightness is taken, not its hue, so a pink dawn still leaves the
// grove green; the god rays add their gold on top (groveBegin). Under rain cloud the light comes
// soft from everywhere above: the mist goes a pale green-grey, brighter low down and flatter, so
// the wet stems still stand out dark against it.
vec3 bambooMistColor(vec2 p) {
  Sky s = bambooSky;
  float up = smoothstep(0.1, 1.0, p.y);
  float ov = bambooOvercast;
  vec3 c = mix(BAMBOO_MIST_DEEP, BAMBOO_MIST_HIGH, up) * bambooLevel * (mix(0.42, 0.66, ov) + mix(0.9, 0.5, ov) * up * up);
  float toward = clamp(0.5 + p.x * s.sun.x / bambooAspect, 0.0, 1.0);
  c += s.sunColor * BAMBOO_FILTER * (0.03 + 0.16 * toward * toward) * (0.3 + 0.7 * p.y);
  c += s.moonColor * vec3(0.45, 0.7, 0.75) * (0.18 + 0.35 * p.y * p.y);
  return greyed(c, vec3(0.9, 1.0, 0.97), 0.5 * ov);
}

// How much of something at depth z (m) and height (m above the ground) shows through the mist. The
// mist lies a little thicker low down, and drifts in banks (bambooDens: groveBegin). Rain thickens
// it: even a drizzle hangs a grey haze in the grove, and a downpour fades the far rows into it.
float bambooTransmit(float z, float height) {
  return exp(-bambooDens * z * (1.0 + 0.6 * exp(-max(height, 0.0) / 1.1)));
}

// The grove under the canopy (shaders/lib/canopy.ts), in the grove's shapes: the far canopy's ragged
// underside about 0.8 up the frame, finer-leaved than the forest's; leaf tips dripping in columns
// 12 cm wide, 22% of them at amount 1, from 0.66 to 0.92 up the frame.
${canopyGroveGlsl}
const CanopyCrowns BAMBOO_CROWNS = CanopyCrowns(vec3(0.8, 0.09, 2.3), vec2(9.0, 12.0), vec2(23.0, 27.0), vec3(0.1, 0.12, 0.16), vec3(0.6, 0.78, 0.86), vec4(0.07, 0.85, 0.8, 0.96));
const CanopyDrips BAMBOO_DRIPS = CanopyDrips(BAMBOO_HORIZON, BAMBOO_EYE, 0.12, 0.22, vec2(0.66, 0.26));

// The lantern's warm light reaching something at screen point p, depth z (none without it).
vec3 bambooLanternLight(vec2 p, float z) {
  if (bambooLanternLit <= 0.0) return vec3(0.0);
  vec2 v = p - bambooLanternAt;
  return BAMBOO_FLAME * bambooLanternLit * 1.1 * exp(-dot(v, v) / 0.07) * exp(-abs(z - BAMBOO_LANTERN_DEPTH) * 0.25);
}

// A small round cane seen side-on, u across it (-1..1, +1 toward the light): lit, with the waxy
// stripe and the rim that bamboo takes from the bright mist around it; wet, darker with a brighter
// stripe.
vec3 bambooRod(vec3 albedo, float u, vec3 light) {
  float nz = sqrt(max(1.0 - u * u, 0.0));
  vec3 c = wetten(albedo, bambooWet, 0.3) * light * (0.55 + 0.6 * clamp(0.5 + 0.5 * u, 0.0, 1.0)) * (0.7 + 0.3 * nz);
  return c + bambooSheen * 0.3 * (1.0 + 1.5 * bambooGloss) * bell((u - 0.4) / 0.25) + bambooMist * 0.35 * pow(1.0 - nz, 3.0);
}

// Coverage of a slender bamboo leaf at w hung from 'base' along unit 'dir' (all in metres): a narrow
// stalk, widest a fifth of the way along, then the long taper to the point; never narrower than two
// cells between its ends, so a far leaf moving in the wind does not shimmer. aa is a cell in metres.
float bambooLeaf(vec2 w, vec2 base, vec2 dir, float len, float width, float aa) {
  vec2 v = w - base;
  float s = dot(v, dir) / len;
  if (s <= 0.0 || s >= 1.0) return 0.0;
  float hw = max(width * smoothstep(0.0, 0.16, s) * pow(1.0 - s, 0.85), aa * step(0.05, s) * step(s, 0.9));
  return 1.0 - smoothstep(hw - 0.7 * aa, hw + 0.7 * aa, abs(dot(v, vec2(-dir.y, dir.x))));
}

// A fallen bamboo leaf's half-width at s (0 stalk .. 1 tip), as a share of its length: in the air
// (the culms') and floating on the basin (the clock's).
float bambooLeafWidth(float s) {
  return smoothstep(0.0, 0.14, s) * pow(max(1.0 - s, 0.0), 0.8);
}

// A living leaf's colour: deep green in the shade, glowing green-gold where a ray comes through it
// from behind; tone (0..1) varies it leaf by leaf. Wet, it darkens and its face mirrors the bright
// canopy light.
vec3 bambooLeafColor(float tone, vec2 at, float z) {
  float behind = 0.3 + 0.7 * clamp(bambooKeySide.y * 1.5, 0.0, 1.0);
  vec3 albedo = wetten(mix(BAMBOO_LEAF, BAMBOO_LEAF * vec3(1.3, 1.15, 0.8), tone), bambooWet, 0.4);
  vec3 col = albedo * (0.75 + 0.5 * tone) * (bambooFill + bambooLanternLight(at, z) * 0.6);
  col += bambooSheen * 0.12 * bambooGloss * (0.4 + 0.6 * tone);
  return col + BAMBOO_LEAF_LIT * bambooKey * (0.05 + 0.95 * bambooBeam) * behind * (0.3 + 0.5 * tone);
}

// The passage's lean of the culms (m of deflection at BAMBOO_SWAY_HEIGHT, the same bend as the sway)
// of a stem standing at screen x xs in layer 'layer'; exactly 0 at rest. Stems are moved whole, per
// culm, so their edges are hardened per cell like the sway's.
// Entrance: stems in the outer half of the frame start leaned out of it, more the nearer the edge,
// and sway in at speed, braking, with a small swing past upright; all set off together, the right
// edge settling a beat after the left, near rows first (done by 2.6 s). Exit: a gust front crosses
// the grove downwind (upwind edge at 0.1 s, the far edge by 0.8 s), each stem bowing from where it
// stands, gathering speed until the exit ends, to BAMBOO_LEAN_OUT.
float bambooPassLean(float xs, int layer) {
  float fl = float(layer);
  float lean = 0.0;
  if (bambooEnterT < BAMBOO_ENTER) {
    float edgeW = smoothstep(0.2, 1.0, clamp(abs(xs) / (0.5 * bambooAspect), 0.0, 1.0));
    float span = 2.1 + (xs > 0.0 ? 0.3 : 0.0) + 0.05 * fl;
    float a = clamp(bambooEnterT / span, 0.0, 1.0);
    float e = 1.0 - (1.0 - a) * (1.0 - a);
    lean += (xs > 0.0 ? 1.0 : -1.0) * BAMBOO_LEAN_IN * edgeW * (1.0 - e) * cos(3.0 * e);
  }
  if (bambooExitT > 0.0) {
    float heading = K_wind < 0.0 ? -1.0 : 1.0;
    float pos = clamp(0.5 + heading * xs / bambooAspect, 0.0, 1.0);
    float from = 0.1 + 0.55 * pos + 0.04 * fl;
    float b = clamp((bambooExitT - from) / (BAMBOO_EXIT - from), 0.0, 1.0);
    lean += heading * BAMBOO_LEAN_OUT * b * b;
  }
  return lean;
}

// Something of the grove standing over the cell (solid 0 or 1, cut per cell) at depth z (m, as the
// mist takes it): what the cell shows, and what the rain and a speck hide behind. The accent stays,
// as the grove always kept it.
void bambooStand(inout Cell c, vec3 col, float solid, float z) {
  c.col = mix(c.col, col, solid);
  c.z = min(c.z, z);
  c.zs = min(c.zs, z);
}

// Every grove layer's state for this cell: the passage, the grove's light (the World's sky, under the
// canopy's own closing over it: where rain or snow greys the World's sky, the clear sky it greyed is
// taken again, the aurora's glow and the lightning's flash in it), the rays' sources, the rain through
// the canopy, the parallax, where the near culm and the corner group stand.
void bambooBegin(Ctx x) {
  float aspect = x.aspect;
  bambooAspect = aspect;
  // Passage: only while an entrance or exit plays; at rest every term it feeds is skipped.
  float passIn = passageIn();
  float passOut = passageOut();
  bambooPassing = passIn < 1.0 || passOut > 0.0;
  bambooEnterT = passIn * BAMBOO_ENTER;
  bambooExitT = passOut * BAMBOO_EXIT;
  bambooP = vec2((x.uv.x - 0.5) * aspect, x.uv.y);
  bambooTm = x.tm;
  Sky clear = x.w.sky;
  if (x.w.overcast > 0.0) {
    clear = skyAt(x.w.time);
#ifdef SKY_MOON_PHASE
    clear = skyMoonPhase(clear, K_moon);
#endif
    clear.ambient += x.w.glow + WORLD_FLASH_LIGHT * x.w.flash;
  }
  // The rain's cloud closes over the sky as the rain sets in (the shared canopy weather): a drizzle
  // still lets some sun through, and from about a quarter of the rain knob up the sun and moon are
  // gone, rays and all. The cloud deck is lit from above, so the grove's light turns soft and grey but
  // stays bright: as much as the open sky gave, plus a share of the sun it hides, dimming only in the
  // heaviest rain.
  CanopyWeather weather = canopyWeather(clear, x.w.storm);
  bambooWeather = weather;
  Sky sky = weather.sky;
  bambooRain = weather.rain;
  bambooOvercast = weather.overcast;
  bambooCloud = weather.cloud;
  bambooSky = sky;
  bambooWet = clamp(uWeather.x, 0.0, 1.0);
  bambooGloss = wetGloss(bambooWet, 0.0);
  // The leaves drip while they are wet, hardest in the rain, and keep on a while as the grove dries.
  bambooDripAmount = bambooWet * (0.3 + 0.5 * clamp(1.6 * x.w.rain, 0.0, 1.0));
  // Parallax: nearer things slide further as the pointer moves (divided by depth where used).
  bambooPar = uPointer * vec2(0.05, 0.02);
  bambooNearX = -0.5 * aspect + 0.1 + 0.06 * (fract(K_seed * 0.618 + 0.3) - 0.5);

  // Light: the sky's brightness (its hue stays outside: the leaves overhead make the grove's light
  // green), the key (sun and moon, through the leaves) and the side it comes from. The fill is kept
  // low so the grove has real shadow and the rays carry the light; under rain cloud, with no rays,
  // the soft light from above does all the work and fills more.
  bambooLevel = max(dot(sky.ambient, LUMA), 0.02);
  bambooFill = bambooLevel * vec3(0.78, 1.0, 0.88) * mix(1.15, 1.45, bambooOvercast) + sky.moonColor * 0.3;
  bambooKey = sky.sunColor * BAMBOO_FILTER + sky.moonColor * vec3(0.7, 0.85, 0.95) * 1.2;
  bambooKeySide = weather.keySide;

  // The god rays: three, crossing mid-frame at seed-chosen places, drifting very slowly.
  bambooRaySlant = weather.slant;
  bambooRaySrc = canopyRaySources(vec3(-0.32, -0.02, 0.28), 0.12, K_seed, aspect, bambooTm, bambooRaySlant);
  // The canopy shelters the grove: under its leaves half the rain gets through (the rest gathers on
  // them and drips); it pours in full through the gaps, the same gaps the rays come through, in
  // columns slanting with the wind. What splashes on the stones and rings the basin is the rain
  // alone, not the snow.
  bambooRainHere = x.w.rain * mix(0.5, 1.0, canopyGap(bambooP, K_wind, K_seed, bambooRaySrc));

  // The corner group (lantern and water clock) scales down on narrow frames.
  float fit = clamp(aspect / BAMBOO_CORNER_ASPECT, BAMBOO_CORNER_SMALLEST, 1.0);
  bambooCorner = BAMBOO_CORNER_SIZE * fit;
  bambooLanternScale = fit / BAMBOO_LANTERN_DEPTH;
  bambooLanternFootAt = vec2(0.5 * aspect + bambooCorner * BAMBOO_LANTERN_X, BAMBOO_HORIZON - BAMBOO_EYE / BAMBOO_LANTERN_DEPTH) - bambooPar / BAMBOO_LANTERN_DEPTH;
  bambooLanternAt = bambooLanternFootAt + vec2(0.0, 0.64 * bambooLanternScale);
  bambooLanternLit = 0.0;
}
`;

/** The grove's GLSL: the mist and its air, the sky in the canopy's gaps, the far canopy, the drips. */
export const groveGlsl = `
// ---- the grove's air and canopy ----

// The rays, the mist's banks and the grove's air: every layer's light and mist, set before any pass
// (the grove is the host of every bamboo layer). The air the composer's fog and rain take is the
// mist; the drops are lit by the cloud deck's brightness and a ray's gold (the lantern adds its own,
// stoneLanternBegin); guests haze into the mist by its extinction.
void groveBegin(inout Ctx x) {
  vec2 p = bambooP;
  float tm = bambooTm;
  Sky sky = bambooSky;
  bambooMistK = K_groveMist;
  float gustAll = groveSimOn() ? groveRecord(0, 0).x : 0.0;
  vec2 rays = K_groveShafts > 0.0 ? canopyRays(p, tm, bambooRaySrc, bambooRaySlant, K_seed, vec2(0.008, 0.07)) : vec2(0.0);
  // The canopy's gaps open and close a little as gusts pass.
  float flutter = 1.0 - 0.25 * gustAll * (0.5 + 0.5 * sin(tm * 1.1 + dot(p, vec2(7.0, 3.0))));
  bambooBeam = K_groveShafts > 0.0 ? rays.x * flutter : 0.3;
  vec3 rayLight = sky.sunColor * BAMBOO_FILTER + sky.moonColor * vec3(0.6, 0.8, 0.95) * 1.6;
  vec3 beamGlow = rayLight * rays.y * flutter * K_groveShafts * (0.35 + 0.9 * K_groveMist) * 1.9;
  // Dust drifting in the rays.
  float motes = smoothstep(0.84, 0.97, vnoise(p * 75.0 + vec2(tm * 0.08, -tm * 0.05)));
  beamGlow += rayLight * motes * rays.x * K_groveShafts * 0.3;

  // Banks of mist drifting downwind, thick and thin.
  float windDir = K_wind < 0.0 ? -1.0 : 1.0;
  bambooWisp = 0.75 + 0.5 * (0.6 * vnoise(vec2(p.x * 2.1 - tm * 0.018 * windDir, p.y * 4.5 + 1.0)) + 0.4 * vnoise(vec2(p.x * 5.3 - tm * 0.03 * windDir, p.y * 9.0 + 4.0)));
  float rain = 0.05 * smoothstep(0.0, 0.15, bambooRain) + 0.08 * bambooRain * bambooRain;
  bambooDens = (0.012 + 0.15 * K_groveMist + rain) * bambooWisp;
  bambooMist = bambooMistColor(p) + beamGlow;
  bambooSheen = bambooMistColor(vec2(p.x, 0.92));

  // Drops off the leaves and the rain are water against the sky: they take its brightness, so they
  // read lighter than the dark wet stems, and catch a ray's gold in a drizzle.
  vec3 drop = vec3(0.94, 0.97, 1.0) * bambooCloud * 1.2 + bambooKey * bambooBeam * 0.5;
  x.air = Air(bambooMist, bambooMist, drop, bambooSheen, 0.0, bambooDens, 0.0);
}

// The grove's sky: the mist, and high in the frame the World's sky through the canopy's gaps (pale,
// its hue mostly washed out by the leaves), seen through the grove's own lens of a radian. Stars on a
// clear night are the World's; under rain cloud the deck, grey-white and lit from above, a little
// darker in the heaviest rain, with shafts of heavier rain hanging from it.
void groveSky(Ctx x, inout Cell c) {
  vec2 p = bambooP;
  c.col = bambooMist;
  if (p.y <= 0.6) return;
  vec3 dir = viewRay(x.uv, x.aspect, BAMBOO_HORIZON, 1.0);
  WorldSky heaven = worldSky(x.w, worldViewOf(dir, x.uv, RIG_HORIZON, RIG_FOCAL, x.eye, RIG_TURN, 1.0), WORLD_METEOR_FIELD);
  vec3 sk = heaven.col;
  vec3 washed = mix(vec3(dot(sk, LUMA)), sk, 0.3) * vec3(0.95, 1.02, 0.92) * 1.1 + bambooSky.sunColor * BAMBOO_FILTER * 0.12;
  vec3 gapCol = canopyGapSky(bambooWeather, washed, dir, 0.0, p, K_wind, K_seed, 1.3) + heaven.strike;
  c.col = mix(c.col, max(gapCol, bambooMist), smoothstep(0.76, 1.0, p.y));
}

// The canopy overhead (BAMBOO_CROWNS), far off in the mist, breathing with the far stems' sway,
// thinning into gaps toward the top of the frame, and open where the rays come through.
vec4 groveCanopy(vec2 p) {
  int back = BAMBOO_LAYERS - 1;
  float sway = 0.0;
  if (groveField0On()) {
    float cells = float(BAMBOO_CELLS);
    sway = texture(groveField0, vec2((p.x * BAMBOO_Z[back] / BAMBOO_SPACING[back] + 0.5 * cells) / cells, (float(back) + 0.5) / float(BAMBOO_LAYERS))).r;
  }
  vec2 q = vec2(p.x - 0.04 * sway, p.y);
  vec3 c = canopyCrowns(q, p, BAMBOO_CROWNS, K_seed, K_groveShafts > 0.0, bambooRaySrc, bambooKeySide);
  vec3 col = BAMBOO_LEAF * (0.8 + 0.4 * c.y) * bambooFill + BAMBOO_LEAF_LIT * bambooKey * bambooBeam * c.z * 0.2;
  return vec4(col, c.x);
}

// The far canopy over the sky, misted.
void groveFar(Ctx x, inout Cell c) {
  vec2 p = bambooP;
  if (p.y <= 0.6) return;
  vec4 canopy = groveCanopy(p);
  cellPut(c, vec4(mix(bambooMist, canopy.rgb, bambooTransmit(5.0, 8.0)), canopy.a), BAMBOO_CANOPY_Z);
}

// Drops off the leaves, falling through the second and third rows of culms behind whatever stands
// nearer, lit as the rain is (the grove's air: the deck's brightness, a ray's gold, the lantern).
void groveFrontVeil(Ctx x, inout Cell c) {
  if (bambooDripAmount <= 0.0) return;
  vec2 p = bambooP;
  float drip = 0.0;
  if (c.z > BAMBOO_Z[1]) drip = canopyDrip(p + bambooPar / BAMBOO_Z[1], bambooTm, bambooDripAmount, BAMBOO_Z[1], 1.0, BAMBOO_DRIPS);
  if (c.z > BAMBOO_Z[2]) drip = max(drip, 0.75 * canopyDrip(p + bambooPar / BAMBOO_Z[2], bambooTm, 0.75 * bambooDripAmount, BAMBOO_Z[2], 2.0, BAMBOO_DRIPS));
  c.col = mix(c.col, x.air.drop * 1.1, hardEdge(drip) * 0.85);
}
`;

/** The grove floor's GLSL: the litter and moss, wet and pooled in rain. */
export const groveFloorGlsl = `
// ---- the grove floor ----

// The grove floor at screen point p (below the horizon): leaf litter with moss, strewn with fallen
// leaves whose detail gives way to its mean once finer than a few cells; gold where a ray reaches
// it, and warm in the lantern's pool. Wet, the litter darkens and pools gather in its hollows, each
// mirroring the bright mist above and the lantern's glow. zg returns its depth.
vec3 groveFloorAt(vec2 p, out float zg) {
  zg = BAMBOO_EYE / max(BAMBOO_HORIZON - p.y, 1e-3);
  vec2 w = vec2(p.x * zg, zg);
  float foot = zg * zg / (BAMBOO_EYE * uRes.y);
  float keep = 1.0 - smoothstep(0.04, 0.2, foot);
  float n1 = vnoise(w * vec2(1.3, 2.6) + K_seed);
  float n2 = vnoise(w * vec2(3.5, 9.0) + 7.0);
  float strewn = mix(0.4, smoothstep(0.52, 0.8, n2), keep);
  vec3 albedo = mix(BAMBOO_LITTER, BAMBOO_DRY * 0.7, strewn * 0.6) * (0.8 + 0.4 * n1);
  albedo = mix(albedo, BAMBOO_MOSS * 0.8, smoothstep(0.58, 0.78, n1) * 0.6);
  albedo = wetten(albedo, bambooWet, 0.85);
  vec3 light = bambooFill * 0.75 + bambooKey * (0.04 + 1.5 * bambooBeam) * 0.8 + bambooLanternLight(p, zg) * 1.4;
  vec3 col = albedo * light;
  // Pools a metre or so across (rainPuddles' units are ~2-4 across), only where the floor is not so
  // foreshortened that the dither cannot hold them.
  float pool = bambooWet > 0.0 ? rainPuddles(w * 2.5, bambooWet) * (1.0 - smoothstep(0.06, 0.25, foot)) : 0.0;
  if (pool > 0.0) {
    // A flat mirror shows what lies as far above the horizon as the pool lies below it; the
    // lantern, nearer than that, shows mirrored about its own foot, in the pools in front of it. No
    // rain rings: on a floor this foreshortened their crests are a cell or less tall and would
    // sparkle under the dither instead of spreading.
    vec2 m = vec2(p.x, 2.0 * BAMBOO_HORIZON - p.y);
    vec2 ml = vec2(p.x, 2.0 * bambooLanternFootAt.y - p.y);
    vec3 refl = bambooMistColor(m) * 0.8 + bambooLanternLight(ml, BAMBOO_LANTERN_DEPTH) * (1.0 - smoothstep(0.8, 1.1, zg / BAMBOO_LANTERN_DEPTH));
    col = mix(col, refl, pool * clamp(0.55 + 0.35 * wetGloss(bambooWet, 1.0), 0.0, 0.9));
  }
  return col;
}

// The floor, fading into the mist with distance; the lantern's contact shadow at its foot while it
// stands.
void groveFloorGround(Ctx x, inout Cell c) {
  vec2 p = bambooP;
  if (p.y >= BAMBOO_HORIZON) return;
  float zg;
  vec3 ground = groveFloorAt(p, zg);
#if LAYER_STONE_LANTERN
  vec2 sv = (p - bambooLanternFootAt) / (bambooLanternScale * vec2(0.42, 0.07));
  ground *= 1.0 - 0.5 * exp(-dot(sv, sv));
#endif
  c.col = mix(bambooMist, ground, bambooTransmit(zg, 0.0));
  c.z = zg;
  c.accent = 0.0;
}
`;

/** The culms' GLSL: the five depth layers of stems, branches and sprays, and the leaves in the air. */
export const culmsGlsl = `
// ---- the culms ----

// The chance that a cell of layer i holds a culm, for a culm at screen x: thinned by the stems knob;
// none of the second layer stand just in front of the lantern, and few behind the water clock (each
// while it stands).
float culmsOccupancy(int i, float xs) {
  float occ = mix(0.3, 0.95, K_stems);
  if (i == 1) {
#if LAYER_STONE_LANTERN
    occ *= smoothstep(0.07, 0.13, abs(xs - bambooLanternAt.x));
#endif
#if LAYER_CLOCK
    occ *= 1.0 - 0.6 * smoothstep(0.5 * bambooAspect - 0.75, 0.5 * bambooAspect - 0.6, xs);
#endif
  }
  return occ;
}

// The culms of layer i at q (screen units, shifted for parallax): lit colour before the mist, and
// coverage. 'height' returns the height above the ground (m), 'depth' how far off the mist takes it
// to be (each culm a little nearer or farther than its layer, so layers never read as flat bands),
// 'frond' the colour and coverage of any leafy branch reaching here from these culms.
// Layer 0 is one big culm framing the left edge (bambooNearX); the others are grids of cells, each
// of which may hold one culm, leaning and bowing a little, bent by the sim's deflection more toward
// the top, tapering, with node rings (closer together near the ground), the white wax below the nodes
// of young culms, the mottling of old ones, a lighter body, darker edges and a waxy stripe.
// Some culms of layers 1 and 2 put out a branch from a node in mid-frame: it rises, droops, and
// carries slender leaves hanging along its outer two thirds, bobbing in gusts.
vec4 culmsAt(vec2 q, int i, float tm, out float height, out float depth, out vec4 frond) {
  frond = vec4(0.0);
  float z = BAMBOO_Z[i];
  float yb = BAMBOO_HORIZON - BAMBOO_EYE / z;
  height = (q.y - yb) * z;
  depth = z;
  if (height < -0.1) return vec4(0.0);
  float hh = max(height, 0.0);
  float xw = q.x * z;
  float sp = BAMBOO_SPACING[i];
  float aa = z / uRes.y;
  float bend = pow(hh / BAMBOO_SWAY_HEIGHT, 1.5);
  float cells = float(BAMBOO_CELLS);
  // Neighbouring stems sway nearly together: search the cells around where this point stood before
  // the local sway moved it, so even a storm's bend of more than a cell finds its stem.
  float local = 0.0;
  if (culmsField0On()) local = texture(culmsField0, vec2((xw / sp + 0.5 * cells) / cells, (float(i) + 0.5) / float(BAMBOO_LAYERS))).r;
  if (bambooPassing) {
    // The passage's lean moves a stem by a good deal more than the sway, and by more at the edges:
    // find where this point stood before it, twice over, to land in the right cell.
    float leanHere = bambooPassLean(q.x, i);
    local += bambooPassLean(q.x - leanHere * bend / z, i);
  }
  float k0 = floor((xw - local * bend) / sp);
  float wind = abs(K_wind);
  float windDir = K_wind < 0.0 ? -1.0 : 1.0;
  float best = 1e9;
  float axis = 0.0;
  float radius = 1.0;
  float hc = 0.0;
  for (int j = -1; j <= 1; j++) {
    float k = k0 + float(j);
    float hk = hash12(vec2(k + 0.5, float(i) * 7.1 + K_seed * 3.17 + 40.0));
    float x0 = (k + 0.5 + 0.7 * (fract(hk * 41.7) - 0.5)) * sp;
    if (i == 0) {
      if (j != 0) continue;
      x0 = bambooNearX * z;
      k = floor(x0 / sp);
      hk = hash12(vec2(k + 0.5, K_seed * 3.17 + 40.0));
    } else if (hash12(vec2(k * 1.37 + K_seed * 0.731, float(i) * 11.3 + 2.0)) > culmsOccupancy(i, x0 / z)) {
      continue;
    }
    vec2 sim = vec2(0.0);
    if (culmsField0On()) sim = texelFetch(culmsField0, ivec2(clamp(int(k) + BAMBOO_CELLS / 2, 0, BAMBOO_CELLS - 1), i), 0).rg;
    // Of the near culm we only see its foot, which hardly moves however its top sways.
    if (bambooPassing) sim.x += bambooPassLean(x0 / z, i);
    if (i == 0) sim.x *= 0.4;
    float lean = (fract(hk * 113.9) - 0.5) * 0.07;
    float bow = (fract(hk * 61.3) - 0.5) * 0.004;
    float ax = x0 + lean * hh + bow * hh * hh + sim.x * bend;
    float r = 0.5 * BAMBOO_DIAMETER[i] * (0.8 + 0.4 * fract(hk * 7.3)) * (1.0 - 0.012 * hh);
    float e = abs(xw - ax) - r;
    if (e < best) {
      best = e;
      axis = ax;
      radius = r;
      hc = hk;
    }

    // Its branch, if it has one in view.
    if ((i == 1 || i == 2) && fract(hk * 23.1) < 0.5) {
      float side = fract(hk * 5.9) < 0.5 ? -1.0 : 1.0;
      float ha = (0.5 + 0.26 * fract(hk * 8.3) - yb) * z;
      float baseX = x0 + lean * ha + bow * ha * ha + sim.x * pow(ha / BAMBOO_SWAY_HEIGHT, 1.5);
      // It must end inside the next cell, which is as far as this search looks.
      float reach = side > 0.0 ? (k + 2.0) * sp - baseX : baseX - (k - 1.0) * sp;
      float len = min(0.75 + 0.55 * fract(hk * 2.9), reach - 0.22);
      float s = side * (xw - baseX);
      if (len > 0.25 && s > 0.0 && s < len + 0.2 && abs(height - ha) < 0.5) {
        // Wet leaves weigh the branch down a little further.
        float droop = (0.55 + 0.06 * sim.y * sin(tm * 1.6 + hk * 30.0)) * (1.0 + 0.25 * bambooWet) / len;
        float yBranch = ha + 0.45 * s - droop * s * s;
        float slope = 0.45 - 2.0 * droop * s;
        float tw = max(0.008 * (1.0 - 0.4 * s / len), 1.3 * aa);
        float twig = s < len ? 1.0 - smoothstep(tw - 0.7 * aa, tw + 0.7 * aa, abs(height - yBranch) / sqrt(1.0 + slope * slope)) : 0.0;
        float leaf = 0.0;
        float tone = 0.0;
        float jn = floor(s / 0.1);
        for (int e2 = 0; e2 < 2; e2++) {
          float sj = (jn - float(e2)) * 0.1;
          if (sj < 0.33 * len || sj > len) continue;
          float hj = fract(hk * 13.7 + sj * 7.31);
          vec2 base = vec2(baseX + side * sj, ha + 0.45 * sj - droop * sj * sj);
          float la = side * (0.3 + 0.5 * hj) + windDir * wind * 0.2 + 0.03 * (0.3 + sim.y) * sin(tm * 1.9 + hj * 20.0);
          float cv = bambooLeaf(vec2(xw, height), base, vec2(sin(la), -cos(la)), 0.15 + 0.06 * hj, 0.015, aa);
          if (cv > leaf) {
            leaf = cv;
            tone = hj;
          }
        }
        float cover = max(leaf, twig);
        if (cover > frond.a) {
          vec3 twigColor = BAMBOO_CANE * 0.45 * (bambooFill + bambooKey * bambooBeam * 0.3);
          frond = vec4(leaf >= twig ? bambooLeafColor(tone, q, z) : twigColor, cover);
        }
      }
    }
  }
  if (best > 0.1 * radius + 2.0 * aa) return vec4(0.0);

  // Nodes: ph counts them up a warped height whose rate is 1 + e^(-h/1.1), so internodes are half as
  // long at the ground as up the stem; dn is the distance (m) above (+) or below (-) the nearest node.
  // Where a node's ring would be finer than the dither can hold (far layers), it fades out.
  float hn = fract(hc * 17.9);
  float ip = 0.36 * (0.85 + 0.3 * hn);
  float low = exp(-hh / 1.1);
  float ph = (hh + 1.1 * (1.0 - low)) / ip + hn * 5.0;
  float dn = (fract(ph + 0.5) - 0.5) * ip / (1.0 + low);
  float rw = max(0.008, 1.1 * aa);
  float rings = 1.0 - smoothstep(0.02, 0.05, aa);
  float groove = (1.0 - smoothstep(0.5 * rw, rw, abs(dn))) * rings;
  float ridge = smoothstep(0.6 * rw, 1.4 * rw, dn) * (1.0 - smoothstep(1.4 * rw, 3.2 * rw, dn)) * rings;
  float edge = abs(xw - axis) - radius * (1.0 + 0.05 * ridge + 0.03 * groove);
  float cover = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, edge)) * smoothstep(-0.1, 0.02, height);
  if (cover <= 0.0) return vec4(0.0);

  float u = clamp((xw - axis) / radius, -1.0, 1.0);
  float age = fract(hc * 29.3);
  age *= age;
  vec3 albedo = mix(BAMBOO_YOUNG, BAMBOO_OLD, age);
  albedo *= 1.0 + age * 0.4 * (vnoise(vec2(u * 1.7 + hc * 50.0, hh * 2.6)) - 0.5);
  albedo *= 0.93 + 0.14 * vnoise(vec2(u * 6.0 + hc * 9.0, hh * 0.6));
  float bloom = (1.0 - age) * rings * smoothstep(-0.1, -0.05, dn) * (1.0 - smoothstep(-rw - 0.012, -rw, dn));
  albedo = mix(albedo, BAMBOO_WAX, 0.65 * bloom);
  albedo *= 1.0 - 0.6 * groove;
  albedo += 0.07 * ridge;
  albedo = wetten(albedo, bambooWet, 0.15);

  // Round: the soft light from the open grove lights the body and leaves the edges dark; the key
  // light, usually from behind, rims the side it falls on and gilds the stem where a ray crosses it;
  // the wax gives a broad, soft sheen of the bright canopy light, narrower and brighter when wet.
  float nz = sqrt(max(1.0 - u * u, 0.0));
  float body = 0.25 + 0.95 * pow(nz, 0.8);
  float key = clamp((u * bambooKeySide.x - nz * bambooKeySide.y + 0.35) / 1.35, 0.0, 1.0);
  vec2 at = vec2(axis / z, q.y);
  float toLantern = clamp(0.5 + 0.5 * u * sign(bambooLanternAt.x - at.x), 0.0, 1.0);
  vec3 lantern = bambooLanternLight(at, z);
  vec3 light = bambooFill * body + bambooKey * key * (0.1 + 1.4 * bambooBeam) + lantern * toLantern;
  vec3 col = albedo * light;
  float face = bambooKeySide.x < 0.0 ? -1.0 : 1.0;
  vec3 shine = bambooSheen * 0.8 + bambooKey * bambooBeam * 0.35 + lantern * 0.3;
  col += shine * bell((u - 0.4 * face) / mix(0.22, 0.15, bambooWet)) * (0.25 + 0.5 * bambooGloss) * (1.0 - 0.5 * age);
  col += bambooMist * 0.3 * pow(1.0 - nz, 4.0);

  // Rain on the stem: water held on each node's ridge catches the light, and down the stems of the
  // two nearest rows run two runnels each, a faint wet line with a bead sliding slowly down it.
  if (bambooWet > 0.02) {
    col += shine * ridge * bambooGloss * 0.6;
    if (i <= 1) {
      float runW = max(0.006, 1.2 * aa) / radius;
      for (int r = 0; r < 2; r++) {
        float fr = float(r);
        float ut = (0.42 - 0.6 * fr) * face + 0.12 * (fract(hc * (5.1 + 3.3 * fr)) - 0.5);
        float run = 1.0 - smoothstep(0.6 * runW, runW, abs(u - ut));
        if (run <= 0.0) continue;
        // Distance (m) above the nearest bead: beads 1.6 m apart, sliding down at 9 cm a second.
        float above = fract((hh + tm * 0.09) / 1.6 + fract(hc * (11.3 + 7.1 * fr))) * 1.6;
        float bead = 1.0 - smoothstep(0.02, 0.035, above);
        col += shine * run * 0.2 * bambooWet;
        col = mix(col, shine * 1.3 + 0.02, hardEdge(run * bead) * 0.8 * smoothstep(0.05, 0.4, bambooWet));
      }
    }
  }
  depth = z * (0.82 + 0.36 * fract(hc * 3.7));
  return vec4(col, cover);
}

// Canopy sprays of layer i (1 or 2) hanging into the top of the frame: fans of five slender leaves at
// the tips of short twigs, scattered on a grid in metres and clumped by noise, densest at the top with
// gaps where the sky shows. Each fan turns as a whole (downwind, and fluttering harder in the local
// gust, the sway's g) and each leaf a little on its own. Only the leaf of the five whose direction is
// nearest the point's is drawn, so a fan costs one leaf. A leaf reaches 0.8 of a cell sideways and
// down, a twig a third of a cell up: the four cells checked (this one, its neighbour on the near
// side, and the row on the near side of both) hold every leaf and twig that can be here.
vec4 culmsSprays(vec2 q, int i, float tm) {
  float low = i == 1 ? 0.7 : 0.62;
  if (q.y < low - 0.1) return vec4(0.0);
  float z = BAMBOO_Z[i];
  float aa = z / uRes.y;
  vec2 w = vec2(q.x, q.y - BAMBOO_HORIZON) * z;
  vec2 sway = vec2(0.0);
  if (culmsField0On()) {
    float cells = float(BAMBOO_CELLS);
    sway = texture(culmsField0, vec2((w.x / BAMBOO_SPACING[i] + 0.5 * cells) / cells, (float(i) + 0.5) / float(BAMBOO_LAYERS))).rg;
  }
  // The sprays hang from tops far above the frame, carried along by a share of the stems' sway.
  w.x -= 0.2 * sway.x + (bambooPassing ? 0.15 * bambooPassLean(q.x, i) : 0.0);
  float gust = sway.y;
  float wind = abs(K_wind);
  float windDir = K_wind < 0.0 ? -1.0 : 1.0;
  vec2 g = w / BAMBOO_SPRAY_CELL;
  vec2 id = floor(g);
  vec2 f = g - id;
  vec2 closer = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
  float cover = 0.0;
  float tone = 0.0;
  float twigged = 0.0;
  for (int c = 0; c < 4; c++) {
    vec2 cid = id + vec2((c == 1 || c == 3) ? closer.x : 0.0, c >= 2 ? closer.y : 0.0);
    float h = hash12(cid + vec2(float(i) * 31.7 + K_seed * 1.73, 5.3));
    vec2 tip = (cid + 0.3 + 0.4 * vec2(fract(h * 13.1), fract(h * 71.3))) * BAMBOO_SPRAY_CELL;
    float ys = tip.y / z + BAMBOO_HORIZON;
    float clump = vnoise(cid * vec2(0.29, 0.37) + vec2(float(i) * 7.0 + K_seed, 3.0));
    if (fract(h * 5.37) > smoothstep(low, low + 0.22, ys) * smoothstep(0.3, 0.6, clump)) continue;
    // Wet, the fan closes and hangs straighter under the water on its leaves.
    float spread = mix(0.34, 0.24, bambooWet);
    float fan = (fract(h * 9.1) - 0.5) * 0.7 * (1.0 - 0.35 * bambooWet) + windDir * wind * (0.2 + 0.4 * gust) + (0.015 + 0.07 * gust) * sin(tm * (1.6 + 0.6 * fract(h * 17.0)) + h * TAU);
    vec2 v = w - tip;
    float twig = 1.0 - smoothstep(-0.7 * aa, 0.7 * aa, segmentDistance(w, tip, tip + vec2((fract(h * 3.3) - 0.5) * 0.14, 0.1)) - max(0.004, aa));
    float m = clamp(floor((atan(v.x, -v.y) - fan) / spread + 2.5), 0.0, 4.0);
    float la = fan + (m - 2.0) * spread + 0.02 * (0.3 + gust) * sin(tm * 2.0 + m * 1.7 + h * 9.0);
    float len = 0.2 + 0.05 * fract(h * 3.9 + m * 0.37) - 0.035 * abs(m - 2.0);
    float leaf = bambooLeaf(w, tip, vec2(sin(la), -cos(la)), len, 0.016, aa);
    float cv = max(leaf, twig);
    if (cv > cover) {
      cover = cv;
      tone = fract(h * 61.0 + m * 0.21);
      twigged = leaf >= twig ? 0.0 : 1.0;
    }
  }
  // Cut per cell: a fluttering leaf's edge flips each cell once as it passes, never back and forth.
  cover = hardEdge(cover);
  if (cover <= 0.0) return vec4(0.0);
  vec3 twigColor = BAMBOO_CANE * 0.45 * (bambooFill + bambooKey * bambooBeam * 0.3);
  return vec4(mix(bambooLeafColor(tone, q, z), twigColor, twigged), cover);
}

// One depth layer of the grove over the cell, unless something already stands nearer (a guest): its
// culms, then its branches' leaves, then (layers 1 and 2) its canopy sprays, each misted by its depth.
// Stems, branches and sprays move: their edges are made hard against the cell's threshold.
void culmsDepth(inout Cell c, int i) {
  float z = BAMBOO_Z[i];
  if (z >= c.zs) return;
  vec2 q = bambooP + bambooPar / z;
  float height;
  float depth;
  vec4 frond;
  vec4 culm = culmsAt(q, i, bambooTm, height, depth, frond);
  float solid = hardEdge(culm.a);
  if (solid > 0.0) bambooStand(c, mix(bambooMist, culm.rgb, bambooTransmit(depth, height)), solid, depth);
  solid = hardEdge(frond.a);
  if (solid > 0.0) bambooStand(c, mix(bambooMist, frond.rgb, bambooTransmit(z, 5.0)), solid, z);
  if (i == 1 || i == 2) {
    vec4 spray = culmsSprays(q, i, bambooTm);
    solid = hardEdge(spray.a);
    if (solid > 0.0) bambooStand(c, mix(bambooMist, spray.rgb, bambooTransmit(z, 8.0)), solid, z);
  }
}

// Leaves in the air or lying on the ground (the culms' row, state 1: texels 2i and 2i + 1): the
// nearest one covering p, coloured and misted. A dry leaf, turning about its length as it falls; it
// lights up crossing a ray.
vec4 culmsLeaves(vec2 p, vec2 par) {
  float aa = 1.0 / uRes.y;
  vec4 best = vec4(0.0);
  for (int i = 0; i < BAMBOO_LEAVES; i++) {
    vec4 a = culmsRecord(2 * i, 0);
    // Most cells are nowhere near a leaf: reject before the second fetch (parallax moves a leaf
    // at most par / BAMBOO_DEVICE_DEPTH).
    if (a.w <= 0.0 || abs(p.x - a.x) > a.w + 0.04 || abs(p.y - a.y) > a.w + 0.04) continue;
    vec4 b = culmsRecord(2 * i + 1, 0);
    if (b.w > 1.5) continue;
    vec2 v = p - (a.xy - par / b.y);
    if (abs(v.x) > a.w || abs(v.y) > a.w) continue;
    vec2 l = rotate(v, -a.z);
    float s = l.x / a.w + 0.5;
    if (s <= 0.0 || s >= 1.0) continue;
    float hw = max(0.13 * a.w * b.x * bambooLeafWidth(s), 0.9 * aa);
    float curl = 0.1 * a.w * (s - 0.5) * (s - 0.5);
    float cv = (1.0 - smoothstep(hw - 0.7 * aa, hw + 0.7 * aa, abs(l.y - curl))) * b.z;
    if (cv > best.a) {
      float tone = fract(float(i) * 0.618);
      vec3 albedo = wetten(mix(BAMBOO_DRY, BAMBOO_OLD, 0.4 * tone), bambooWet, 0.6);
      vec3 col = albedo * (bambooFill * 1.1 + bambooKey * (0.1 + 0.9 * bambooBeam) * 0.8 + bambooLanternLight(p, b.y));
      col = mix(bambooMist, col, bambooTransmit(b.y, 2.0));
      best = vec4(col, cv);
    }
  }
  return best;
}

// The far three layers, behind the lantern (13, 7 and 3.6 m).
void culmsMiddle(Ctx x, inout Cell c) {
  for (int i = BAMBOO_LAYERS - 1; i >= 2; i--) culmsDepth(c, i);
}

// The near two layers, in front of the lantern, then the leaves in the air over them all.
void culmsFront(Ctx x, inout Cell c) {
  for (int i = 1; i >= 0; i--) culmsDepth(c, i);
  vec4 falling = culmsLeaves(bambooP, bambooPar);
  c.col = mix(c.col, falling.rgb, hardEdge(falling.a));
}
`;

/** The stone lantern's GLSL: the lantern, its light on the guests (stoneLanternLight), its halo. */
export const stoneLanternGlsl = `
// ---- the stone lantern ----

// The M in the window (K_stoneLanternMark, or summoned by its trigger).
float stoneLanternMark;

// The lantern's light, and its say over the drops: they glow by it (the grove's air).
void stoneLanternBegin(inout Ctx x) {
  float since = sinceTrigger(TRIGGER_stoneLanternMark);
  float summon = since >= 0.0 ? smoothstep(0.0, 1.5, since) * (1.0 - smoothstep(14.0, 18.0, since)) : 0.0;
  stoneLanternMark = max(K_stoneLanternMark, 0.8 * summon);
  float flame = 1.0 + 0.02 * sin(bambooTm * 1.9 + 2.0 * sin(bambooTm * 0.7));
  // Lit as the light fails: at dusk, and on a dark rainy day.
  bambooLanternLit = max(K_stoneLantern * (1.0 - 0.85 * bambooSky.day * (1.0 - 0.6 * bambooOvercast)), 0.6 * stoneLanternMark) * flame;
  x.air.drop += bambooLanternLight(bambooP, 2.5) * 1.3;
}

// The stone lantern's outline (a small kasuga-doro): half-width (m) of the stone at height y, 0 where
// there is none. Its flat stepping stone, the plinth, a pillar with a carved band, the flaring
// platform, the fire box, broad eaves, a concave roof and the jewel on top.
float stoneLanternWidth(float y) {
  if (y < -0.06) return 0.0;
  if (y < 0.0) return 0.34 - 0.04 * smoothstep(-0.03, 0.0, y);
  if (y < 0.07) return 0.2 - 0.03 * smoothstep(0.04, 0.07, y);
  if (y < 0.42) return 0.062 + 0.01 * (1.0 - smoothstep(0.012, 0.02, abs(y - 0.25)));
  if (y < 0.52) return mix(0.085, 0.17, smoothstep(0.42, 0.5, y));
  if (y < 0.76) return 0.14;
  if (y < 0.8) return 0.29;
  if (y < 0.95) return 0.29 * pow(max(1.0 - (y - 0.8) / 0.15, 0.0), 1.7) + 0.04;
  if (y < 1.1) {
    float s = (y - 0.95) / 0.15;
    return 0.12 * sqrt(max(s * (1.0 - s), 0.0)) * (1.0 - 0.4 * s);
  }
  return 0.0;
}

// The stone lantern at q (metres from the foot of its axis, y up): stone colour and coverage. Pale,
// weathered granite so it stands out of the dark mist low in the grove: faces turned up to the canopy
// (the stepping stone, the plinth, the platform, the roof) catch its light and grow moss, the eaves'
// and platform's undersides stay dark, the sides are rimmed by the bright mist behind, and the stone
// round the fire box is warmed by the flame. The fire box opens in an arched window showing the glowing
// inside and the flame; with the Manifold mark (0..1) a screen across the window lets the light out
// only through an M. 'glow' returns how much of its light shows here (the accent).
vec4 stoneLanternAt(vec2 q, float tf, float aaM, float mark, out float glow) {
  glow = 0.0;
  float hw = stoneLanternWidth(q.y);
  // The eaves' corners turn up.
  float tips = length(vec2(abs(q.x) - 0.295, q.y - 0.815)) - 0.024;
  float sd = hw > 0.0 ? min(abs(q.x) - hw, tips) : tips;
  float cover = 1.0 - smoothstep(-aaM, aaM, sd);
  if (cover <= 0.0) return vec4(0.0);
  float u = clamp(q.x / max(hw, 0.03), -1.0, 1.0);
  vec3 albedo = BAMBOO_GRANITE * 1.25 * (0.8 + 0.25 * vnoise(q * 48.0) + 0.1 * vnoise(q * 9.0));
  // Which way each band of the outline faces: up where the stone narrows going up, down where it
  // widens (the undersides of the platform's flare and of the eaves).
  float upFace = (1.0 - smoothstep(0.0, 0.02, abs(q.y + 0.008))) + (1.0 - smoothstep(0.0, 0.015, abs(q.y - 0.062)))
    + (1.0 - smoothstep(0.0, 0.02, abs(q.y - 0.51))) + smoothstep(0.8, 0.83, q.y) * (1.0 - smoothstep(0.94, 0.97, q.y))
    + smoothstep(1.02, 1.06, q.y);
  float downFace = (1.0 - smoothstep(0.0, 0.035, abs(q.y - 0.45))) + (1.0 - smoothstep(0.0, 0.015, abs(q.y - 0.772)));
  upFace = clamp(upFace, 0.0, 1.0);
  downFace = clamp(downFace, 0.0, 1.0);
  albedo = mix(albedo, BAMBOO_MOSS * (0.8 + 0.4 * vnoise(q * 120.0)), upFace * smoothstep(0.35, 0.6, vnoise(q * 22.0 + 2.0)));
  albedo = wetten(albedo, bambooWet, 0.45);
  float nz = sqrt(max(1.0 - u * u, 0.0));
  float key = clamp((u * bambooKeySide.x - nz * bambooKeySide.y + 0.4) / 1.4, 0.0, 1.0);
  vec3 light = bambooFill * (0.55 + 0.4 * nz) * (1.0 + 0.9 * upFace - 0.5 * downFace) + bambooKey * key * (0.1 + 1.4 * bambooBeam);
  // Its own light: on the stone round the fire box, under the eaves, on the platform below.
  vec2 fromFlame = q - vec2(0.0, 0.62);
  float byFlame = exp(-dot(fromFlame, fromFlame) / 0.03);
  float under = (1.0 - smoothstep(0.0, 0.025, abs(q.y - 0.775))) * smoothstep(0.13, 0.18, abs(q.x));
  float sill = (1.0 - smoothstep(0.0, 0.02, abs(q.y - 0.51))) * (1.0 - smoothstep(0.1, 0.17, abs(q.x)));
  light += BAMBOO_FLAME * bambooLanternLit * (0.35 * byFlame + 0.6 * under + 0.5 * sill);
  vec3 col = albedo * light + bambooSheen * 0.3 * pow(1.0 - nz, 2.0) * (1.0 - downFace);
  // Wet, its upper faces shine: the canopy's light, and the flame's on the platform and under the
  // eaves; the rain splashes on them.
  if (bambooWet > 0.0) {
    float gloss = wetGloss(bambooWet, upFace);
    col += (bambooSheen * 0.5 * upFace + BAMBOO_FLAME * bambooLanternLit * (0.6 * sill + 0.3 * under + 0.2 * byFlame)) * gloss * 0.7;
  }
  // Splash crowns at half the library's size (it takes ~metres).
  if (bambooRainHere > 0.0) col += bambooSheen * rainSplashes(q * 2.0, tf, bambooRainHere) * upFace * 0.8;

  // The arched window.
  vec2 wq = q - vec2(0.0, 0.64);
  float arch = 0.05 + 0.035 * sqrt(max(1.0 - (wq.x / 0.07) * (wq.x / 0.07), 0.0));
  float win = 1.0 - smoothstep(-aaM, aaM, max(abs(wq.x) - 0.07, max(-0.075 - wq.y, wq.y - arch)));
  if (win > 0.0) {
    vec2 fq = wq - vec2(0.0, -0.035);
    float inside = bambooLanternLit * (0.45 + 0.55 * exp(-(fq.x * fq.x / 0.0015 + fq.y * fq.y / 0.004)));
    float flame = (1.0 - smoothstep(0.012, 0.02, length(fq * vec2(1.0, 0.55)))) * bambooLanternLit;
    float strokes = (1.0 - smoothstep(-aaM, aaM, markDistance(wq / 0.13) * 0.13 - 0.012)) * mark;
    float screen = 1.0 - 0.7 * mark;
    vec3 lit = BAMBOO_FLAME * inside * 1.2 * screen + vec3(1.0, 0.86, 0.6) * (flame * 1.4 * screen + strokes * 1.4);
    col = mix(col, albedo * 0.12 + lit, win);
    glow = win * clamp(inside * screen + flame + strokes, 0.0, 1.0);
  }
  return vec4(col, cover);
}

// The lantern between the third and the second layers of culms, unless something nearer than its
// stepping stone's front edge (a guest) stands there; water running off its eaves in a row of drips,
// warm where they pass the window; its light scattered in the mist close round it, wider in the rain.
void stoneLanternMiddle(Ctx x, inout Cell c) {
  if (c.zs + 0.5 <= BAMBOO_LANTERN_DEPTH) return;
  vec2 p = bambooP;
  vec2 lq = (p - bambooLanternFootAt) / bambooLanternScale;
  if (abs(lq.x) < 0.38 && lq.y > -0.08 && lq.y < 1.12) {
    float glow;
    vec4 stone = stoneLanternAt(lq, x.w.tf, 1.0 / (uRes.y * bambooLanternScale), stoneLanternMark, glow);
    float through = bambooTransmit(BAMBOO_LANTERN_DEPTH, max(lq.y, 0.5));
    c.col = mix(c.col, mix(bambooMist, stone.rgb, through), stone.a);
    c.col += BAMBOO_FLAME * glow * (1.0 - through) * 0.8;
    c.accent = max(c.accent, glow);
    if (stone.a > 0.5) {
      c.z = min(c.z, BAMBOO_LANTERN_DEPTH);
      c.zs = min(c.zs, BAMBOO_LANTERN_DEPTH);
    }
    // The library spaces drip points 'spacing' apart, its drops about a fifth of that across: two
    // cells at 18.
    float eaves = max(x.w.rain, 0.4 * bambooWet);
    if (eaves > 0.0 && lq.y < 0.775 && abs(lq.x) < 0.28) {
      float spacing = 18.0 / (uRes.y * bambooLanternScale);
      float drip = hardEdge(rainDrips(vec2(lq.x + 0.28, 0.775 - lq.y), x.w.tf, eaves, spacing));
      c.col = mix(c.col, bambooMist * 1.3 + bambooLanternLight(p, BAMBOO_LANTERN_DEPTH) * 1.5 + 0.02, drip * 0.85);
    }
  }
  vec2 hv = p - bambooLanternAt;
  float halo = bambooLanternLit * exp(-dot(hv, hv) / (0.002 + 0.005 * bambooMistK + 0.006 * x.w.rain));
  c.col += BAMBOO_FLAME * halo * (0.08 + 0.2 * bambooMistK + 0.12 * x.w.rain);
  c.accent = max(c.accent, halo * 0.45);
}

// The lantern's light on another layer's surface at p (the composer's localLight), as the grove's
// own take it: through its screen point and depth.
vec3 stoneLanternLight(vec3 p, vec3 n) {
  float z = max(p.z, 0.05);
  return bambooLanternLight(vec2(p.x / z, BAMBOO_HORIZON + (p.y - BAMBOO_EYE) / z), z);
}
`;

/** The water clock's GLSL: the tube, the spout, the posts, the stones and the basin with its water. */
export const clockGlsl = `
// ---- the water clock ----

// Rings on the basin's water, w in basin-disc units (the water's ellipse mapped to the unit disc, so
// rings are circles on the water and ellipses on screen): the sim's events (the pour, the clack, a leaf
// landing, a click). Returns the slope (xy) and light on the crests (z). The rain plinks instead
// (clockWater).
vec3 clockRipples(vec2 w) {
  vec2 tilt = vec2(0.0);
  float light = 0.0;
  if (clockSimOn()) {
    for (int i = 0; i < BAMBOO_RIPPLES; i++) {
      vec4 e = clockRecord(2 + i, 0);
      if (e.w <= 0.0 || e.z > 5.0) continue;
      vec2 v = w - e.xy;
      float r = length(v);
      float x = r - 0.35 * e.z;
      float fade = 1.0 - e.z / 5.0;
      float env = exp(-x * x * 30.0) * e.w * fade * fade / (1.0 + 2.0 * r);
      tilt += v / max(r, 1e-3) * cos(x * 16.0) * env;
      light += max(sin(x * 16.0), 0.0) * env;
    }
  }
  return vec3(tilt * 0.6, min(light, 1.0));
}

// The basin's water at disc point w: it mirrors the grove (the far side the bright mist at eye level,
// the near side the canopy overhead, darker), bent by the rings; the sky's glint lies on the far water
// toward the light and breaks up when rings cross it; the lantern's warm sheen on the side toward it;
// foam where the pour lands; leaves floating on it (the clock's second row, state 2).
vec3 clockWater(vec2 w, vec2 p, float tf, float landing, float pour, vec3 lantern, float face, inout float accent) {
  vec3 rip = clockRipples(w);
  float farSide = 0.5 + 0.5 * w.y;
  vec3 mirror = bambooMistColor(vec2(p.x + rip.x * 0.08, mix(0.88, 0.55, farSide) + rip.y * 0.3));
  mirror *= mix(0.55, 1.15, smoothstep(-0.9, 0.7, w.y));
  vec3 col = mix(vec3(0.02, 0.045, 0.04), mirror, 0.5 + 0.35 * farSide);
  float glint = bell((w.x - 0.35 * face + rip.x * 0.6) / 0.4) * bell((w.y - 0.5 + rip.y * 0.5) / 0.28);
  col += (bambooMist * 1.3 + bambooKey * 0.35 + 0.03) * glint * (0.5 + 0.6 * rip.z);
  col += (bambooMist + lantern * 1.5 + bambooKey * 0.2) * rip.z * 0.6;
  float sheen = bell((w.x + 0.8) * 1.1) * (0.6 + 0.4 * farSide) * bambooLanternLit;
  col += BAMBOO_FLAME * sheen * (0.1 + 0.25 * rip.z);
  accent += sheen * (0.25 + 0.5 * rip.z);
  if (pour > 0.0) {
    vec2 fv = w - vec2(landing, 0.0);
    float foam = exp(-dot(fv, fv) / (0.02 + 0.04 * pour)) * pour;
    col = mix(col, bambooMist * 1.8 + 0.06, clamp(foam, 0.0, 0.8));
  }
  // Rain, and after it the leaves overhead still dripping, plinks on the water: small crowns
  // flattened by the angle the water is seen at. The basin is only a dozen cells tall, too thin for
  // rings growing across it to hold still under the dither; a crown lights a few cells and is gone.
  float plinks = max(bambooRainHere, 0.25 * bambooDripAmount);
  if (plinks > 0.0) col = mix(col, bambooMist * 1.5 + lantern + 0.03, rainSplashes(vec2(w.x, 0.5 * w.y), tf, plinks) * 0.8);
  if (clockSimOn()) {
    float aa = 1.5 / (uRes.y * BAMBOO_BASIN.z);
    for (int i = 0; i < BAMBOO_LEAVES; i++) {
      vec4 b = clockRecord(2 * i + 1, 1);
      if (b.w < 1.5) continue;
      vec4 a = clockRecord(2 * i, 1);
      vec2 l = rotate(w - a.xy, -a.z);
      float s = l.x / a.w + 0.5;
      if (s <= 0.0 || s >= 1.0) continue;
      float hw = 0.14 * a.w * bambooLeafWidth(s);
      float cv = hardEdge((1.0 - smoothstep(hw - aa, hw + aa, abs(l.y))) * b.z);
      // Soaked and darkened, lit like the water around it.
      vec3 leaf = BAMBOO_DRY * 0.6 * (bambooFill * 1.2 + bambooKey * bambooBeam * 0.5 + lantern);
      col = mix(col, leaf, cv);
    }
  }
  return col;
}

// Moss cushions at d (device units): 0..1, more of it where amount (0..1) is high.
float clockMoss(vec2 d, float amount) {
  float n = 0.65 * vnoise(d * 26.0 + 11.0) + 0.35 * vnoise(d * 70.0 + 3.0);
  return smoothstep(0.64 - 0.4 * amount, 0.72 - 0.4 * amount, n);
}

// Rain on a stone of the water clock at d (device units), up 0 for a side .. 1 for a top: wet, it
// mirrors the canopy's light and the lantern's warmth; on its top the rain splashes. A device unit
// is about 1.7 m at the clock's depth; splashes are drawn at half the library's size (it takes ~m).
vec3 clockRainOnStone(vec2 d, float up, float tf, vec3 lantern) {
  vec3 c = vec3(0.0);
  if (bambooWet > 0.0) c += (bambooSheen * 0.6 + lantern * 0.8) * wetGloss(bambooWet, up) * 0.5;
  if (bambooRainHere > 0.0) c += bambooSheen * rainSplashes(d * 3.4, tf, bambooRainHere) * smoothstep(0.5, 0.9, up) * 0.8;
  return c;
}

// The water clock in the near right corner, painted over col. d is in device units (layout.ts), p the
// screen point, aa one cell in device units. Adds to accent where the lantern's light shows; sets
// hitZ to its depth where it hides what lies behind it (the rain, the drips).
vec3 clockDevice(vec2 d, vec2 p, float aa, float tf, float tm, vec3 col, inout float accent, inout float hitZ) {
  vec4 st = vec4(BAMBOO_REST, 0.0, 0.0, 1.0);
  if (clockSimOn()) st = clockRecord(0, 0);
  float theta = st.x;
  float fill = st.y;
  float pour = st.z;
  float flow = st.w;
  // Arriving: the spout's first water leaves its lip, falls as a thin line (its head a drop's free
  // fall) into the tube's mouth, and thickens to the steady trickle.
  float streamFall = 1e3;
  if (passageIn() < 1.0) {
    float ts = max(passageIn() * BAMBOO_ENTER - BAMBOO_STREAM_START, 0.0);
    flow *= smoothstep(0.0, 0.12, ts);
    streamFall = 0.004 + 0.5 * BAMBOO_POUR_GRAVITY * ts * ts;
  }
  vec2 cs = vec2(cos(theta), sin(theta));
  vec2 nrm = vec2(-cs.y, cs.x);
  vec3 lantern = bambooLanternLight(p, BAMBOO_DEVICE_DEPTH);
  // The corner stands out of the grove's shade a little: more of the sky reaches it.
  vec3 light = bambooFill * 1.2 + bambooKey * (0.08 + 0.8 * bambooBeam) + lantern;
  float face = bambooKeySide.x < 0.0 ? -1.0 : 1.0;
  vec3 water = bambooMist * 1.5 + bambooKey * bambooBeam * 0.3 + lantern * 0.8 + 0.04;
  vec3 mossLight = light * (0.75 + 0.5 * vnoise(d * 140.0));
  vec3 mossCol = wetten(BAMBOO_MOSS, bambooWet, 1.0);
  float solid = 0.0;

  // The striking stone under the tube's closed end: moss on its shoulders, worn pale and wet on top
  // where it is struck. The knock knob turned down lays a cushion of moss there instead, standing a
  // little proud of the stone, wider and deeper the softer the knock (none at 1: bare stone).
  {
    float pad = (1.0 - K_knock) * bell((d.x - BAMBOO_STRIKE.x) / 0.03);
    vec2 c = d - vec2(BAMBOO_STRIKE.x, BAMBOO_STRIKE.y - 0.13);
    vec2 box = abs(c) - vec2(0.05 - 0.035, 0.13 - 0.035);
    float sd = length(max(box, 0.0)) + min(max(box.x, box.y), 0.0) - 0.035 + 0.004 * (vnoise(d * 30.0) - 0.5) - 0.005 * pad;
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      float up = clamp((d.y - (BAMBOO_STRIKE.y - 0.06)) / 0.06, 0.0, 1.0);
      float side = clamp(0.5 + 0.5 * face * c.x / 0.05, 0.0, 1.0);
      vec3 albedo = wetten(BAMBOO_GRANITE * (0.75 + 0.35 * vnoise(d * 60.0)), bambooWet, 0.45);
      float worn = bell((d.x - BAMBOO_STRIKE.x) / 0.02) * smoothstep(BAMBOO_STRIKE.y - 0.015, BAMBOO_STRIKE.y, d.y) * (1.0 - pad);
      albedo = mix(albedo, vec3(0.55, 0.54, 0.5), worn * 0.6);
      vec3 c2 = albedo * light * (0.5 + 0.3 * side + 0.45 * up) + clockRainOnStone(d, up, tf, lantern);
      float moss = clockMoss(d, 0.55 * (1.0 - worn)) * (1.0 - smoothstep(0.7, 1.0, up));
      moss = max(moss, smoothstep(0.25, 0.6, pad) * smoothstep(0.55, 0.85, up));
      col = mix(col, mix(c2, mossCol * mossLight * (0.6 + 0.4 * side), moss), cv);
      solid = max(solid, cv);
    }
  }

  // The post the spout is tied to, behind the basin.
  {
    float u = (d.x - BAMBOO_POST_X) / 0.011;
    float sd = max((abs(u) - 1.0) * 0.011, d.y - 0.392);
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 c = bambooRod(BAMBOO_CANE * 0.75, u * face, light);
      float node = 1.0 - smoothstep(0.002, 0.004 + aa, abs(d.y - 0.381));
      float top = 1.0 - smoothstep(0.0, 0.004 + aa, 0.392 - d.y);
      c = mix(c * (1.0 - 0.45 * node), BAMBOO_CUT_FACE * (light + 0.02), top * 0.7);
      col = mix(col, c, cv);
      solid = max(solid, cv);
    }
  }

  // The trickle from the spout's lip: into the tube's mouth while it waits, onto the tipped tube, or
  // down into the basin. It bows a little as it falls; slow beads run down it; a drop hangs at the
  // lip, and it splashes bright where it lands.
  float landing = 0.0;
  if (pour > 0.0) {
    vec2 lip = BAMBOO_PIVOT + BAMBOO_FRONT * cs - BAMBOO_RADIUS * nrm;
    float vx = BAMBOO_POUR_SPEED * cs.x;
    float vy = BAMBOO_POUR_SPEED * cs.y;
    float flight = (vy + sqrt(vy * vy + 2.0 * BAMBOO_POUR_GRAVITY * max(lip.y - BAMBOO_BASIN.y, 0.0))) / BAMBOO_POUR_GRAVITY;
    landing = (lip.x + vx * flight - BAMBOO_BASIN.x) / BAMBOO_BASIN.z;
  }
  vec2 splashAt = vec2(-10.0);
  if (flow > 0.01) {
    float a = (BAMBOO_LIP.x - BAMBOO_PIVOT.x + BAMBOO_RADIUS * cs.y) / cs.x;
    float yEnd = BAMBOO_BASIN.y;
    if (a > -BAMBOO_BACK && a < BAMBOO_FRONT) {
      yEnd = BAMBOO_PIVOT.y + a * cs.y + BAMBOO_RADIUS * cs.x;
      if (a > BAMBOO_FRONT - BAMBOO_CUT) yEnd -= BAMBOO_RADIUS;
    }
    float drop = BAMBOO_LIP.y - d.y;
    if (drop > 0.0 && d.y > yEnd && drop < streamFall) {
      float x = BAMBOO_LIP.x - 0.006 * sqrt(drop / 0.04);
      float hw = max(0.0035 * sqrt(flow), 0.9 * aa);
      float cv = hardEdge(1.0 - smoothstep(hw - 0.6 * aa, hw + 0.6 * aa, abs(d.x - x)));
      float beads = 0.85 + 0.15 * sin((d.y + tm * 0.05) * 90.0);
      col = mix(col, water * beads, cv * 0.95);
    }
    float bead = 1.0 - smoothstep(0.0045 - aa, 0.0045 + aa, length((d - BAMBOO_LIP - vec2(0.0, -0.002)) * vec2(1.0, 0.8)));
    col = mix(col, water * 1.2, bead);
    if (BAMBOO_LIP.y - yEnd < streamFall) splashAt = vec2(BAMBOO_LIP.x - 0.006 * sqrt(max(BAMBOO_LIP.y - yEnd, 0.0) / 0.04), yEnd + 0.004);
  }

  // The tube (tsutsu): cane on a pivot, closed at the back by a node, its mouth cut obliquely so the
  // upper wall is shorter. The fresh cut is a pale rim, and as the tube brims the water's surface
  // glints in the mouth: the moment before it tips.
  {
    vec2 rel = d - BAMBOO_PIVOT;
    float a = dot(rel, cs);
    float ub = dot(rel, nrm) / BAMBOO_RADIUS;
    float tipEnd = BAMBOO_FRONT - BAMBOO_CUT * clamp(0.5 * (ub + 1.0), 0.0, 1.0);
    float sd = max(max((abs(ub) - 1.0) * BAMBOO_RADIUS, -BAMBOO_BACK - a), (a - tipEnd) * 0.9);
    float cv = hardFill(sd, aa);
    if (cv > 0.0) {
      float u = clamp(ub, -1.0, 1.0);
      vec3 albedo = BAMBOO_CANE * (0.85 + 0.25 * vnoise(vec2(a * 9.0, u * 3.0 + 5.0)));
      float groove = 1.0 - smoothstep(0.002, 0.004 + aa, min(abs(a + BAMBOO_BACK - 0.012), abs(a - 0.035)));
      albedo *= (1.0 - 0.45 * groove) * (1.0 - 0.25 * smoothstep(0.05, 0.2, a));
      albedo = wetten(albedo, bambooWet, 0.3);
      float rim = 1.0 - smoothstep(0.0, 0.006 + aa, tipEnd - a);
      float nz = sqrt(max(1.0 - u * u, 0.0));
      vec3 c = albedo * light * (0.4 + 0.5 * (0.5 + 0.5 * u * cs.x) + 0.35 * nz);
      c += (bambooSheen * 0.6 + bambooKey * bambooBeam * 0.3 + lantern * 0.3) * bell((u - 0.5) / mix(0.25, 0.16, bambooWet)) * (0.6 + 0.8 * bambooGloss);
      c = mix(c, BAMBOO_CUT_FACE * (light * 1.2 + 0.02), rim * 0.8);
      c += (bambooMist * 1.2 + lantern) * rim * smoothstep(0.75, 1.0, fill) * 0.6;
      col = mix(col, c, cv);
      solid = max(solid, cv);
    }
  }
  float splash = 1.0 - smoothstep(0.004 - aa, 0.007 + aa, length((d - splashAt) * vec2(1.0, 1.5)));
  col = mix(col, water * (1.1 + 0.1 * sin(tm * 1.7)), splash * 0.85);

  // The front post with the pivot pin through it.
  {
    float u = (d.x - BAMBOO_PIVOT.x) / 0.012;
    float top = BAMBOO_PIVOT.y + 0.035;
    float sd = max((abs(u) - 1.0) * 0.012, d.y - top);
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 c = bambooRod(BAMBOO_CANE * 0.8, u * face, light);
      float node = 1.0 - smoothstep(0.002, 0.004 + aa, abs(d.y - (top - 0.012)));
      float cap = 1.0 - smoothstep(0.0, 0.004 + aa, top - d.y);
      c = mix(c * (1.0 - 0.45 * node), BAMBOO_CUT_FACE * (light + 0.02), cap * 0.7);
      float pin = length(d - BAMBOO_PIVOT);
      float pinCover = 1.0 - smoothstep(0.0065 - aa, 0.0065 + aa, pin);
      float glint = 1.0 - smoothstep(0.0, 0.003, length(d - BAMBOO_PIVOT - vec2(0.002 * face, 0.002)));
      c = mix(c, vec3(0.06, 0.05, 0.04) * (light + 0.05) + bambooMist * 0.4 * glint, pinCover);
      col = mix(col, c, cv);
      solid = max(solid, cv);
    }
  }

  // At the clack the tube stops dead and the last water in its mouth flies on: a few drops leap from
  // the lip and fall back, smaller for the softer knock of the bounce, and smaller still the more of
  // the stop a pad of moss takes up (K_knock), until at 0 the tube eases down and none leave it.
  vec4 knock = clockSimOn() ? clockRecord(1, 0) : vec4(60.0, 0.0, 0.0, 0.0);
  if (knock.x < 0.7 && knock.y > 0.0 && K_knock > 0.0) {
    vec2 lip = BAMBOO_PIVOT + (BAMBOO_FRONT - BAMBOO_CUT) * cs + BAMBOO_RADIUS * nrm;
    float shown = 1.0 - smoothstep(0.4, 0.7, knock.x);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      vec2 launch = vec2(0.03 + 0.05 * fract(fi * 0.618 + 0.3), 0.22 + 0.12 * fract(fi * 0.382 + 0.7)) * (0.5 + 0.5 * knock.y);
      vec2 at = lip + launch * knock.x - vec2(0.0, 0.5 * BAMBOO_POUR_GRAVITY * knock.x * knock.x);
      float r = 0.0035 * (1.0 - 0.4 * knock.x) * K_knock;
      col = mix(col, water * 1.2, hardEdge((1.0 - smoothstep(r - aa, r + aa, length(d - at))) * shown));
    }
  }

  // The spout (kakei), its end cut so the lower lip reaches out, and the hemp rope tying it to its post.
  {
    vec2 axis = BAMBOO_SPOUT_TO - BAMBOO_SPOUT_FROM;
    float span = length(axis);
    vec2 along = axis / span;
    vec2 rel = d - BAMBOO_SPOUT_FROM;
    float a = dot(rel, along);
    float ub = dot(rel, vec2(along.y, -along.x)) / BAMBOO_SPOUT_R;
    float end = span - 0.018 * clamp(0.5 * (ub + 1.0), 0.0, 1.0);
    float sd = max((abs(ub) - 1.0) * BAMBOO_SPOUT_R, max(-a, a - end));
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 c = bambooRod(BAMBOO_CANE * 0.9, clamp(ub, -1.0, 1.0), light);
      float cut = 1.0 - smoothstep(0.0, 0.004 + aa, end - a);
      col = mix(col, mix(c, BAMBOO_CUT_FACE * (light + 0.02), cut * 0.8), cv);
      solid = max(solid, cv);
    }
    vec2 tie = abs(d - vec2(BAMBOO_POST_X, 0.362)) - vec2(0.014, 0.016);
    float rope = 1.0 - smoothstep(-aa, aa, max(tie.x, tie.y));
    if (rope > 0.0) {
      float turns = 0.5 + 0.5 * sin((d.y - 0.346) * 785.0);
      col = mix(col, vec3(0.07, 0.055, 0.04) * (0.6 + 0.8 * turns) * (light + 0.05), rope);
    }
  }

  // The basin (tsukubai): a rounded stone, thick with moss low down and in patches over its lip, its
  // rim's top face catching the sky; in its opening, the water, and the inner wall showing above it on
  // the far side.
  {
    float rimY = BAMBOO_BASIN.y + 0.006;
    vec2 bq = d - vec2(BAMBOO_BASIN.x, rimY);
    float flank = 0.106 + 0.012 * sin(clamp(-bq.y / 0.16, 0.0, 1.0) * 3.14159) + 0.005 * (vnoise(vec2(d.y * 30.0, 3.0)) - 0.5);
    float outer = length(vec2(bq.x / 0.106, bq.y / 0.028));
    float sd = bq.y < 0.0 ? abs(bq.x) - flank : (outer - 1.0) * 0.028;
    float cv = 1.0 - smoothstep(-aa, aa, sd);
    if (cv > 0.0) {
      vec3 albedo = wetten(BAMBOO_GRANITE * (0.72 + 0.4 * vnoise(d * 55.0)), bambooWet, 0.45);
      float topFace = 1.0 - smoothstep(0.96, 1.04, outer);
      float side = clamp(0.5 + 0.5 * face * bq.x / flank, 0.0, 1.0);
      float shade = mix(0.5 + 0.4 * side, 1.15, topFace);
      vec3 c = albedo * light * shade + clockRainOnStone(d, topFace, tf, lantern);
      float moss = clockMoss(d, mix(0.8, 0.3, smoothstep(-0.12, 0.02, bq.y)));
      c = mix(c, mossCol * mossLight * shade, moss);
      float opening = length(vec2(bq.x / 0.082, bq.y / 0.021));
      if (opening < 1.05) {
        vec2 w = vec2((d.x - BAMBOO_BASIN.x) / BAMBOO_BASIN.z, (d.y - BAMBOO_BASIN.y) / BAMBOO_BASIN.w);
        vec3 surface = clockWater(w, p, tf, landing, pour, lantern, face, accent);
        vec3 inside = mix(albedo * 0.3 * light, surface, 1.0 - smoothstep(0.94, 1.0, length(w)));
        c = mix(c, inside, 1.0 - smoothstep(0.95, 1.02, opening));
      }
      col = mix(col, c, cv);
      solid = max(solid, cv);
    }
  }

  // The pour: water leaving the mouth's lower lip along the tube and falling in an arc to the basin,
  // thinning as it speeds up.
  if (pour > 0.0) {
    vec2 lip = BAMBOO_PIVOT + BAMBOO_FRONT * cs - BAMBOO_RADIUS * nrm;
    float vx = max(BAMBOO_POUR_SPEED * cs.x, 1e-3);
    float vy = BAMBOO_POUR_SPEED * cs.y;
    float g = BAMBOO_POUR_GRAVITY;
    float flight = (vy + sqrt(vy * vy + 2.0 * g * max(lip.y - BAMBOO_BASIN.y, 0.0))) / g;
    float tau = (d.x - lip.x) / vx;
    if (tau > -0.02 && tau < flight) {
      float y = lip.y + vy * tau - 0.5 * g * tau * tau;
      float slope = (vy - g * tau) / vx;
      float dist = abs(d.y - y) / sqrt(1.0 + slope * slope);
      float hw = (0.003 + 0.007 * sqrt(pour)) * (1.0 - 0.35 * clamp(tau / flight, 0.0, 1.0));
      float cv = hardEdge((1.0 - smoothstep(hw - aa, hw + aa, dist)) * smoothstep(-0.02, 0.0, tau));
      col = mix(col, water * 1.15, cv * 0.9);
    }
  }

  // Two mossy stones where the frame cuts the ground: at the foot of the pivot post and of the basin.
  for (int i = 0; i < 2; i++) {
    vec2 centre = i == 0 ? vec2(-0.3, -0.035) : vec2(0.0, -0.045);
    vec2 radii = i == 0 ? vec2(0.085, 0.07) : vec2(0.07, 0.065);
    vec2 sq = (d - centre) / radii;
    float e = length(sq) + 0.08 * (vnoise(d * 22.0 + float(i) * 5.0) - 0.5);
    float cv = 1.0 - smoothstep(1.0 - aa / radii.y, 1.0 + aa / radii.y, e);
    if (cv > 0.0) {
      float up = clamp(sq.y, 0.0, 1.0);
      float side = clamp(0.5 + 0.5 * face * sq.x, 0.0, 1.0);
      vec3 stone = wetten(BAMBOO_GRANITE * (0.7 + 0.4 * vnoise(d * 50.0)), bambooWet, 0.45) * light * (0.45 + 0.3 * side + 0.4 * up);
      stone += clockRainOnStone(d, up, tf, lantern);
      float moss = clockMoss(d + float(i) * 3.0, 0.45 + 0.5 * up);
      col = mix(col, mix(stone, mossCol * mossLight * (0.6 + 0.3 * side + 0.4 * up), moss), cv);
      solid = max(solid, cv);
    }
  }
  if (solid > 0.5) hitZ = min(hitZ, BAMBOO_DEVICE_DEPTH);
  return col;
}

// The water clock over the near right corner, unless something nearer than its stones (a guest)
// stands there.
void clockFront(Ctx x, inout Cell c) {
  if (c.zs + 0.5 <= BAMBOO_DEVICE_DEPTH) return;
  vec2 d = (bambooP - vec2(0.5 * bambooAspect, 0.0) + bambooPar / BAMBOO_DEVICE_DEPTH) / bambooCorner;
  if (d.x <= -0.56 || d.y >= 0.42) return;
  float hitZ = c.z;
  c.col = clockDevice(d, bambooP, 1.0 / (uRes.y * bambooCorner), x.w.tf, bambooTm, c.col, c.accent, hitZ);
  if (hitZ < c.z) {
    c.z = hitZ;
    c.zs = min(c.zs, hitZ);
  }
}
`;
