// The night train: the view from a seat by the window of a slow night train. The compartment is
// drawn in screen space (the window's rounded frame, the wall's laminate, the table with a glass of
// tea in its silver holder, the velvet curtain); through the glass the country scrolls past in depth,
// as a function of the distance the train has run (sim.ts integrates it, with the speed, the
// timetable of stations, level crossings, bridges and tunnels, and the cars on the road alongside).
//
// Outside, metres, x along the line (+ the way the train runs, so the land slides left), y up from
// the eye, z out from the window; a point at depth z shows on screen at x * TRAIN_F / z, and the
// eye sits TRAIN_EYE above the fields (the line runs on an embankment). From far to near: the sky
// (moon, stars, the M asterism, shooting stars, clouds drifting back as the train runs under them),
// a far ridge with a village at its foot and a radio mast, forested hills with farm lights, the
// fields with eight rows of hedges, trees and farmhouses, a river that comes and goes alongside
// catching the moon, the road with its cars, the verge's thickets and fence, telegraph poles with
// their sagging wires, and whatever the line passes: a station, a level crossing, a bridge over a
// misty valley, a tunnel. The line the train runs on (K_line, trainLine) shapes that land to match the
// timetable sim.ts runs for it: low open farmland on the rural line, high forested hills, snowy peaks,
// alpine pasture and deep gorges under stone viaducts on the mountain line, and on both the hill each
// tunnel goes through rising round it; the country line draws exactly what it always drew.
//
// Flicker: everything that moves is drawn with a hard edge against the cell's own threshold
// (trainHard), and any detail the train would carry past a cell in under about half a second, or
// that would shrink under a few cells, gives way to its mean (trainKeep). Near things are blurred
// by the distance they travel while the eye takes them in (TRAIN_SHUTTER), so poles and girders
// whip past as soft smears rather than strobing.
//
// Positions along the line arrive as whole 256 m blocks plus metres (half floats hold whole
// numbers exactly); trainTile turns them into exact tile numbers and offsets, so the landscape never
// jitters however far the train has run.
//
// The passage is the line's own: the train comes out of a tunnel (the dark wall streaming past, a
// lamp flicking by, the mouth sweeping across the window, the cutting's rock sinking away to open the
// country, the tea sloshing and settling from the jolt) and, leaving, runs into one (the cutting
// rises, the mouth sweeps in, the window turns to a mirror). trainPassage lays a tunnel of its own
// over the timetable while it plays; all of it is exactly off at rest.
import { glslFloat } from "../../shaders/glsl.ts";
import { birdsGlsl } from "../../shaders/lib/birds.ts";
import { TRAIN_BLOCK, TRAIN_BLOCKS, TRAIN_BRIDGE, TRAIN_CAR_SLOTS, TRAIN_CROSSING, TRAIN_EVENT_SLOTS, TRAIN_FOCAL, TRAIN_LINES, TRAIN_PASSAGE, TRAIN_ROAD_Z, TRAIN_STATION, TRAIN_TUNNEL } from "./sim.ts";

export const trainGlsl = `
${birdsGlsl}
// ---- The view ----
const float TRAIN_F = ${glslFloat(TRAIN_FOCAL)};
const float TRAIN_HORIZON = 0.05;     // the horizon's height on screen (centre 0)
const float TRAIN_EYE = 4.5;          // the eye above the fields (m)
const float TRAIN_PLATFORM = 2.2;     // the eye above a station's platform (m)
const float TRAIN_YAW = 0.5;          // the window faces this far (rad) left of the sky's straight ahead
const float TRAIN_SHUTTER = 0.033;    // the eye's blur of things whipping past (s)
const float TRAIN_BLOCK = ${glslFloat(TRAIN_BLOCK)};
const float TRAIN_BLOCKS = ${glslFloat(TRAIN_BLOCKS)};
const int TRAIN_EVENTS = ${TRAIN_EVENT_SLOTS};
const int TRAIN_CARS = ${TRAIN_CAR_SLOTS};
const float TRAIN_IS_STATION = ${glslFloat(TRAIN_STATION)};
const float TRAIN_IS_CROSSING = ${glslFloat(TRAIN_CROSSING)};
const float TRAIN_IS_BRIDGE = ${glslFloat(TRAIN_BRIDGE)};
const float TRAIN_IS_TUNNEL = ${glslFloat(TRAIN_TUNNEL)};
const float TRAIN_JOINT = 32.0;       // rail length between joints (m)
const float TRAIN_WALL_Z = 1.6;       // a tunnel's wall
const float TRAIN_TRUSS_Z = 2.1;      // a bridge's girders
const float TRAIN_POLE_Z = 3.8;       // telegraph poles
const float TRAIN_CUT_Z = 4.6;        // the rock walls of a cutting
const float TRAIN_FENCE_Z = 16.5;     // the line-side fence
const float TRAIN_BUSH_Z = 20.0;      // thickets on the verge
const float TRAIN_ROAD_Z = ${glslFloat(TRAIN_ROAD_Z)};
const float TRAIN_HILLS_Z = 900.0;
const float TRAIN_VILLAGE_Z = 2600.0;
const float TRAIN_RIDGE_Z = 3600.0;
const float TRAIN_VALLEY = 26.0;      // a bridged valley's floor below the fields on the country line (m)
const float TRAIN_RURAL = ${glslFloat(TRAIN_LINES[1].value)};      // K_line
const float TRAIN_MOUNTAIN = ${glslFloat(TRAIN_LINES[2].value)};
const float TRAIN_PANE_G = 2.4;       // the pane's drop lattice repeats every this many screen heights
const int TRAIN_ROWS = 8;
const float TRAIN_ROW_Z[8] = float[8](31.0, 48.0, 74.0, 115.0, 178.0, 276.0, 428.0, 663.0);
const vec3 TRAIN_LAMP = vec3(1.0, 0.66, 0.34);   // the compartment's reading lamp
const vec3 TRAIN_GLOW = vec3(1.0, 0.62, 0.27);   // lit windows, station lamps
const vec3 TRAIN_SODIUM = vec3(1.0, 0.52, 0.18); // road and tunnel lamps
const vec3 TRAIN_SIGNAL = vec3(1.0, 0.1, 0.05);  // the crossing's flashers, the mast's light
const vec3 TRAIN_SNOW = vec3(0.86, 0.9, 0.97);

// ---- The passage: out of a tunnel, into a tunnel (see trainPassage) ----
const float TRAIN_ENTER = ${glslFloat(TRAIN_PASSAGE.enter)};  // seconds the entrance takes
const float TRAIN_EXIT = ${glslFloat(TRAIN_PASSAGE.exit)};    // and the exit
const float TRAIN_ENTER_MOUTH = 1.05; // the second the tunnel's mouth sweeps across the window
const float TRAIN_ENTER_LAMP = 0.6;   // the second a tunnel lamp flicks by before it
const float TRAIN_ENTER_SINK = 1.2;   // seconds the cutting's rim takes to sink away after the mouth
const float TRAIN_EXIT_MOUTH = 0.95;  // the second the mouth sweeps in across the window
const float TRAIN_EXIT_RISE = 0.9;    // seconds the cutting takes to rise before it
const float TRAIN_RIM_HIGH = 4.5;     // the cutting's rim above the eye (m): over the window / below it
const float TRAIN_RIM_LOW = -4.0;
const float TRAIN_PASS_LEN = 600.0;   // the passage tunnel's length (m)
const float TRAIN_NO_CUT = 1000.0;    // trainPassCut's value when no passage plays

// ---- This pixel's journey (set by trainRead and sceneTrain) ----
float trainBlockN;     // whole odometer blocks
float trainInto;       // metres into the block, exact
float trainS;          // the odometer as one float (far things only)
float trainV;          // speed (m/s)
float trainAcc;        // acceleration along the line (m/s/s, eased)
float trainTh;         // the cell's dither threshold
float trainPx;         // a cell, in screen heights
float trainSalt;       // the route
vec2 trainEyeOff;      // the head's offset from the pointer (m)
float trainLook;       // the line's gentle curves: how far the view has swung (rad)
float trainRoll;       // and the carriage's lean into them (rad)
Sky trainSky;
vec3 trainMoonC;       // the moon and sun in the window's frame (x along the line, y up, z out)
vec3 trainSunC;
vec3 trainMoonLight;   // moonlight on the land, dimmed by cloud
vec3 trainSunLight;
vec3 trainAmbient;     // sky light on the land, eye-adapted
vec3 trainAir;         // the air's colour at the horizon: haze, fog
float trainLampsOn;    // how much lamps and lit windows count (1 at night, less under a dark day)
float trainOver;       // how far rain or snow has closed the sky
float trainStorm;      // the fall's weight 0..1
float trainWet;
float trainLying;
float trainTunnelIn;   // 0..1: the window is in a tunnel
vec4 trainStation;     // metres to its start (+ ahead), length, seed 0..1, metres the train slows over
vec4 trainCrossing;
vec4 trainBridge;
vec4 trainTunnel;
vec3 trainCars[TRAIN_CARS]; // metres ahead, heading +1 / -1, 1 while there
float trainPassCut;    // passage: the cutting's rim above the eye (m), TRAIN_NO_CUT unless a passage plays
float trainPassAge;    // passage: seconds since the jolt, -1 before it and at rest
float trainPassSlosh;  // passage: the jolt's slosh of the tea, the steam and the curtain (0 at rest)
float trainPassRattle; // passage: the spoon's rattle (0 at rest)

// ---- The line's character (sim.ts TRAIN_LINES, K_line), set by trainLine ----
float trainHillsLift;  // the hills' heights, times
float trainRidgeLift;  // the ridge's
float trainTunnelHill; // how far (m) the hills rise round a tunnel: the hill it goes through
float trainOpen;       // farmland on the hills: more fields (+) or more forest (-)
float trainFarms;      // farmhouses and lit farm windows, times
float trainTrees;      // the chance of a tree in a row's tile
float trainConifers;   // and of its being a conifer
float trainGorge;      // a bridged valley's floor below the fields (m)
bool trainMeadows;     // the fields are pasture and meadow
bool trainViaduct;     // bridges are stone viaducts, their parapet below the window: no girders
vec2 trainTunnels[TRAIN_EVENTS]; // every tunnel in the timetable: metres to its start, length (0: none)

// The land the line runs through. Country is the line as it always ran (every factor neutral, so
// it draws exactly as before); rural lies low and open, farms and hedgerow trees all round, a stream
// under a short bridge; the mountain line runs under high snowy peaks through forest and alpine
// pasture, out of tunnels onto viaducts over deep gorges. On those two the hills rise round a tunnel
// (the hill it goes through; the rural line only meets one when "now" sends it).
void trainLine() {
  trainHillsLift = 1.0;
  trainRidgeLift = 1.0;
  trainTunnelHill = 0.0;
  trainOpen = 0.0;
  trainFarms = 1.0;
  trainTrees = 0.42;
  trainConifers = 0.3;
  trainGorge = TRAIN_VALLEY;
  trainMeadows = false;
  trainViaduct = false;
  if (abs(K_line - TRAIN_RURAL) < 0.5) {
    trainHillsLift = 0.45;
    trainRidgeLift = 0.4;
    trainTunnelHill = 45.0;
    trainOpen = 0.18;
    trainFarms = 1.5;
    trainTrees = 0.5;
    trainConifers = 0.15;
    trainGorge = 7.0;
  } else if (abs(K_line - TRAIN_MOUNTAIN) < 0.5) {
    trainHillsLift = 2.4;
    trainRidgeLift = 1.8;
    trainTunnelHill = 70.0;
    trainOpen = -0.2;
    trainFarms = 0.35;
    trainTrees = 0.7;
    trainConifers = 0.85;
    trainGorge = 70.0;
    trainMeadows = true;
    trainViaduct = true;
  }
}

// ---- The odometer, the timetable ----

void trainRead(float t) {
  trainStation = vec4(1e5, 0.0, 0.0, 0.0);
  trainCrossing = vec4(1e5, 0.0, 0.0, 0.0);
  trainBridge = vec4(1e5, 0.0, 0.0, 0.0);
  trainTunnel = vec4(1e5, 0.0, 0.0, 0.0);
  for (int i = 0; i < TRAIN_CARS; i++) trainCars[i] = vec3(0.0);
  for (int k = 0; k < TRAIN_EVENTS; k++) trainTunnels[k] = vec2(0.0);
  if (uSimOn.x < 0.5) {
    // No simulation yet: a steady run from a fixed point on the line.
    float s = 4096.0 + 12.0 * uMotionTime;
    trainBlockN = floor(s / TRAIN_BLOCK);
    trainInto = s - trainBlockN * TRAIN_BLOCK;
    trainV = 12.0;
    trainAcc = 0.0;
  } else {
    vec4 odo = texelFetch(uSim0, ivec2(0, 0), 0);
    trainBlockN = odo.x;
    trainInto = odo.y + odo.z;
    trainV = max(odo.w, 0.0);
    trainAcc = texelFetch(uSim0, ivec2(1, 0), 0).x;
    for (int k = 0; k < TRAIN_EVENTS; k++) {
      vec4 e = texelFetch(uSim0, ivec2(2 + 2 * k, 0), 0);
      if (e.w < 0.5) continue;
      vec4 e2 = texelFetch(uSim0, ivec2(3 + 2 * k, 0), 0);
      float blocks = e.x - trainBlockN;
      blocks -= TRAIN_BLOCKS * floor(blocks / TRAIN_BLOCKS + 0.5);
      vec4 ev = vec4(blocks * TRAIN_BLOCK + e.y - trainInto, e.z, e2.x, e2.y);
      float mid = abs(ev.x + 0.5 * ev.y);
      if (abs(e.w - TRAIN_IS_STATION) < 0.5) {
        if (mid < abs(trainStation.x + 0.5 * trainStation.y)) trainStation = ev;
      } else if (abs(e.w - TRAIN_IS_CROSSING) < 0.5) {
        if (mid < abs(trainCrossing.x)) trainCrossing = ev;
      } else if (abs(e.w - TRAIN_IS_BRIDGE) < 0.5) {
        if (mid < abs(trainBridge.x + 0.5 * trainBridge.y)) trainBridge = ev;
      } else if (abs(e.w - TRAIN_IS_TUNNEL) < 0.5) {
        // The nearest by its stretch rather than its middle: coming out of one tunnel onto a
        // viaduct with the next just across it, the train is still in the one it is in.
        if (max(max(ev.x, -ev.x - ev.y), 0.0) < max(max(trainTunnel.x, -trainTunnel.x - trainTunnel.y), 0.0)) trainTunnel = ev;
        trainTunnels[k] = ev.xy;
      }
    }
    for (int i = 0; i < TRAIN_CARS; i++) trainCars[i] = texelFetch(uSim0, ivec2(2 + 2 * TRAIN_EVENTS + i, 0), 0).xyz;
  }
  trainS = trainBlockN * TRAIN_BLOCK + trainInto;
}

// The passage, in the world. The train comes out of a tunnel: the window is first all tunnel wall
// (the mortar courses holding still, a lamp flicking by), then the mouth sweeps across it at the
// train's speed, the cutting's rock beyond sinks away to open the country, and the jolt of coming
// out sets the tea sloshing. Leaving, the cutting rises, the mouth sweeps in the other way and the
// wall takes the window. The tunnel is a virtual one laid over the timetable (the sim commits real
// ones a kilometre ahead, never in view at the start) and is skipped if the train is in a real one;
// the cutting's rim follows the passage's own clock so it does not depend on the speed. Must follow
// trainRead; nothing at rest.
void trainPassage() {
  trainPassCut = TRAIN_NO_CUT;
  trainPassAge = -1.0;
  trainPassSlosh = 0.0;
  trainPassRattle = 0.0;
  float pin = passageIn();
  float pout = passageOut();
  if (pin >= 1.0 && pout <= 0.0) return;
  bool real = trainTunnel.x < 0.0 && trainTunnel.x + trainTunnel.y > 0.0;
  float run = max(trainV, 5.0);
  float age;
  float strength = 1.0;
  if (pout > 0.0) {
    float s = pout * TRAIN_EXIT;
    if (!real) {
      trainPassCut = mix(TRAIN_RIM_LOW, TRAIN_RIM_HIGH, smoothstep(0.0, TRAIN_EXIT_RISE, s));
      trainTunnel = vec4(-run * (s - TRAIN_EXIT_MOUTH), TRAIN_PASS_LEN, 0.5, 0.0);
    }
    age = s - TRAIN_EXIT_MOUTH;
    strength = 0.5;
  } else {
    float s = pin * TRAIN_ENTER;
    if (!real) {
      trainPassCut = mix(TRAIN_RIM_HIGH, TRAIN_RIM_LOW, smoothstep(TRAIN_ENTER_MOUTH, TRAIN_ENTER_MOUTH + TRAIN_ENTER_SINK, s));
      // The tunnel's lamps are 48 m apart; the length puts one run * (MOUTH - LAMP) m inside the mouth,
      // so that it flicks by at TRAIN_ENTER_LAMP whatever the speed.
      float len = TRAIN_PASS_LEN + run * (TRAIN_ENTER_MOUTH - TRAIN_ENTER_LAMP);
      trainTunnel = vec4(run * (TRAIN_ENTER_MOUTH - s) - len, len, 0.5, 0.0);
    }
    age = s - TRAIN_ENTER_MOUTH;
  }
  if (age > 0.0) {
    float env = exp(-age * 2.6) * (1.0 - smoothstep(1.0, 1.7, age)) * strength;
    trainPassAge = age;
    trainPassSlosh = 0.8 * env * sin(age * 9.0);
    trainPassRattle = 0.7 * env * exp(-age * 1.9) * sin(age * 40.0);
  }
}

// A point d metres along the line from the train (+ ahead): which tile of length L (a power of two,
// in metres) it lies in, as an exact whole number counted from the start of the line, and how far
// into the tile it is, exactly.
vec2 trainTile(float d, float L) {
  float x = trainInto + d;
  if (L <= TRAIN_BLOCK) {
    float k = floor(x / L);
    return vec2(trainBlockN * (TRAIN_BLOCK / L) + k, x - k * L);
  }
  float r = L / TRAIN_BLOCK;
  float kb = floor(x / TRAIN_BLOCK);
  float b = trainBlockN + kb;
  float id = floor(b / r);
  return vec2(id, (b - id * r) * TRAIN_BLOCK + x - kb * TRAIN_BLOCK);
}

float trainHash(float id, float salt) {
  return hash12(vec2(mod(id, 4096.0) + salt * 0.618, floor(id / 4096.0) + salt * 1.325 + trainSalt));
}

// Smooth value noise along the line, a lattice point every L metres.
float trainNoise(float d, float L, float salt) {
  vec2 tl = trainTile(d, L);
  float f = tl.y / L;
  f = f * f * (3.0 - 2.0 * f);
  return mix(trainHash(tl.x, salt), trainHash(tl.x + 1.0, salt), f);
}

// How much of a detail L metres long survives at depth z: it gives way to its mean where the train
// carries it past a cell in under about half a second (the cell would flip back and forth as such
// details stream by), or where it shrinks under a few cells.
float trainKeep(float L, float z) {
  return smoothstep(0.22, 0.45, L / max(trainV, 0.1)) * smoothstep(2.0, 4.0, L * TRAIN_F / (z * trainPx));
}

// A rolling profile along the line, about 0..1: octaves from L metres down, each settling to its
// mean as trainKeep lets it go.
float trainProfile(float d, float L, float z, float salt, int octaves) {
  float s = 0.0;
  float a = 1.0;
  float total = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    s += a * mix(0.5, trainNoise(d, L, salt + float(i) * 7.13), trainKeep(L, z));
    total += a;
    a *= 0.5;
    L *= 0.5;
  }
  return s / total;
}

// The coverage of something that moves, made all-or-nothing against the cell's threshold: a passing
// edge flips each cell once instead of stepping it through the colour levels channel by channel.
float trainHard(float cover) {
  return cover > trainTh ? 1.0 : 0.0;
}

// Hard coverage of a signed distance (m) at the blur or cell size aa (m).
float trainSolid(float dist, float aa) {
  return trainHard(clamp(0.5 - dist / aa, 0.0, 1.0));
}

// The edge softness at depth z (m): a cell there, or half the blur of the train's motion.
float trainAA(float z) {
  return max(trainPx * z / TRAIN_F, 0.5 * trainV * TRAIN_SHUTTER);
}

float trainBox(vec2 p, vec2 h, float r) {
  vec2 d = abs(p) - h + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// A bell curve, exp(-x^2): highlights and streaks across a shape.
float trainBell(float x) {
  return exp(-x * x);
}

// ---- Light outside ----

// Light on an outside surface with normal n (window frame). The moon hangs ahead, beyond the land,
// so faces turned to us get only the sky's light: the country reads as soft silhouettes with
// moonlit tops, as it does at night from a train.
vec3 trainLit(vec3 albedo, vec3 n) {
  float sun = max(dot(n, trainSunC), 0.0);
  float moon = clamp((dot(n, trainMoonC) + 0.35) / 1.35, 0.0, 1.0);
  return albedo * (trainAmbient * (0.72 + 0.28 * n.y) + trainSunLight * (sun + 0.1) + trainMoonLight * moon);
}

// The carriage's lit windows throw a band of warm light on whatever passes close (poles, the
// platform, girders, a tunnel's wall): it rides with the train, so it holds still on screen while
// things slide through it. z metres out, y above the eye.
vec3 trainCarriageLight(float z, float y) {
  return TRAIN_LAMP * (0.06 + 0.5 * K_lamp) * exp(-z / 3.2) * smoothstep(1.4, -0.4, y) * smoothstep(-5.0, -2.0, y);
}

// Haze and fog over the distance: z metres out, h above the fields.
vec3 trainFade(vec3 col, float z, float h) {
  float haze = (1.0 - exp(-z * (1.0 + 3.0 * trainStorm) / 4500.0)) * 0.85;
  float fog = fogAmount(K_fog, clamp(z / 1500.0, 0.0, 1.0), max(h, 0.0) / 40.0);
  return mix(col, trainAir, clamp(haze + fog * (1.0 - haze), 0.0, 1.0));
}

// A station's lamps (posts along the platform, globes under the canopy) lighting a point x metres
// along the platform from its start, z out, y above the eye.
vec3 trainStationLight(float x, float z, float y) {
  float L = trainStation.y;
  float mid = 0.5 * L;
  float sum = 0.0;
  if (abs(x - mid) < 34.0) {
    float i = floor((x - mid + 20.0) / 8.0 + 0.5);
    for (int k = -1; k <= 1; k++) {
      float li = i + float(k);
      if (li < 0.0 || li > 5.0) continue;
      vec3 v = vec3(x - (mid - 20.0 + 8.0 * li), y - 0.55, z - 6.2);
      sum += 1.0 / (1.0 + dot(v, v) * 0.35);
    }
  }
  float j = floor((x - 7.0) / 14.0 + 0.5);
  for (int k = -1; k <= 1; k++) {
    float xl = 7.0 + 14.0 * (j + float(k));
    if (xl < 0.0 || xl > L || abs(xl - mid) < 27.0) continue;
    vec3 v = vec3(x - xl, y - 0.95, z - 5.4);
    sum += 1.0 / (1.0 + dot(v, v) * 0.35);
  }
  return TRAIN_GLOW * 2.0 * sum * trainLampsOn;
}

// The crossing's flashers: (left lamp, right lamp), each on half the time, a moment dark between.
vec2 trainFlash(float tm) {
  float ph = sin(tm * TAU * 0.95 + trainCrossing.z * 6.0);
  return vec2(smoothstep(0.15, 0.55, ph), smoothstep(0.15, 0.55, -ph));
}

// Light from the lamps of whatever is passing (a station, the crossing's flashers and street lamp, a
// tunnel's lamps) on something d metres along the line, z out, y above the eye.
vec3 trainEventLight(float d, float z, float y, float tm) {
  vec3 l = vec3(0.0);
  float xs = d - trainStation.x;
  if (xs > -20.0 && xs < trainStation.y + 20.0) l += trainStationLight(xs, z, y);
  float xc = d - trainCrossing.x;
  if (abs(xc) < 45.0) {
    vec2 f = trainFlash(tm);
    vec3 v = vec3(xc + 4.3, y + 0.4, z - 10.0);
    l += TRAIN_SIGNAL * 1.8 * (f.x + f.y) / (1.0 + dot(v, v) * 0.1);
    vec3 s = vec3(xc - 4.6, y - 1.6, z - 18.0);
    l += TRAIN_SODIUM * 1.4 * trainLampsOn / (1.0 + dot(s, s) * 0.025);
  }
  float xt = d - trainTunnel.x;
  if (xt > -2.0 && xt < trainTunnel.y + 2.0) {
    float k = mod(xt, 48.0) - 24.0;
    l += TRAIN_SODIUM * 0.9 / (1.0 + (k * k + (y - 0.1) * (y - 0.1) + (z - 1.6) * (z - 1.6)) * 0.6);
  }
  return l;
}

// ---- The sky ----

// The cloud deck, straight rgb and alpha. Two broad octaves, calm by night (finer detail reads as
// harsh moonlit swirls); it drifts back as the train runs under it (a base ~1.5 km up) and with the
// wind; moonlit and silvered round the moon, lit by day, grey and low under rain or snow.
vec4 trainClouds(vec3 dir, float t, bool fine) {
  float cover = max(K_clouds, trainOver * (0.6 + 0.4 * trainStorm));
  if (dir.y <= 0.012 || cover <= 0.0) return vec4(0.0);
  vec2 run = vec2(cos(TRAIN_YAW), sin(TRAIN_YAW));
  vec2 q = dir.xz / dir.y + run * (trainS / 1500.0) - vec2(0.09 * K_wind, -0.01) * uMotionTime;
  float detail = fine ? 1.0 - smoothstep(0.08, 0.3, 1.3 / (uRes.y * dir.y * dir.y)) : 0.0;
  float n = 0.62 * vnoise(q * 0.55 + 4.3) + 0.38 * mix(0.5, vnoise(q * 1.3 + 9.1), detail);
  float th = mix(0.66, 0.26, clamp(cover, 0.0, 1.0));
  float alpha = smoothstep(th - 0.05, th + 0.24, n) * smoothstep(0.012, 0.2, dir.y);
  if (alpha <= 0.0) return vec4(0.0);
  float thick = smoothstep(th, th + 0.4, n);
  Sky s = trainSky;
  vec3 mv = dir - s.moon;
  vec3 sv = dir - s.sun;
  vec3 body = s.ambient * (1.15 - 0.35 * thick)
            + s.moonColor * (0.3 - 0.12 * thick + 0.6 * exp(-dot(mv, mv) * 7.0) * (1.0 - thick))
            + s.sunColor * (0.35 + 0.9 * exp(-dot(sv, sv) * 6.0) * (1.0 - thick))
            + vec3(0.6, 0.36, 0.42) * s.twilight * 0.4;
  body = mix(body, vec3(dot(body, LUMA)) * vec3(0.92, 0.95, 1.0), 0.6 * trainOver) * (1.0 - 0.35 * trainStorm);
  return vec4(body, alpha * 0.95);
}

// The Manifold M as an asterism right of the moon: five brighter stars at its corners and four on
// its strokes, twinkling gently, with the faintest of chart lines between them. 0..1.
float trainMarkStars(vec3 dir) {
  if (K_mark <= 0.0 || dir.y <= 0.05) return 0.0;
  vec2 q = vec2((atan(dir.x, dir.z) + TRAIN_YAW - 0.42) * 0.946, asin(dir.y) - 0.33) / 0.11;
  if (abs(q.x) > 0.75 || abs(q.y) > 0.8) return 0.0;
  float cellM = trainPx / (TRAIN_F * 0.11);
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 v = markVertex(i);
    float tw = 0.82 + 0.18 * sin(uMotionTime * (0.5 + 0.11 * float(i)) + float(i) * 2.3);
    s = max(s, (1.0 - smoothstep(0.9, 2.0, length(q - v) / cellM)) * tw);
    if (i < 4) {
      vec2 w = mix(v, markVertex(i + 1), 0.5);
      s = max(s, 0.55 * (1.0 - smoothstep(0.6, 1.5, length(q - w) / cellM)) * tw);
    }
  }
  s = max(s, 0.1 * (1.0 - smoothstep(0.4, 1.0, markDistance(q) / cellM)));
  return s * K_mark;
}

// One shooting star, age seconds into its flight: a short bright streak, head first, gone in under a
// second, somewhere over the window's patch of sky.
float trainStreak(vec3 dir, float age, float seed) {
  if (age < 0.0 || age > 1.0 || dir.y <= 0.0) return 0.0;
  vec2 q = vec2(atan(dir.x, dir.z) + TRAIN_YAW, asin(dir.y));
  float h1 = hash12(vec2(seed, 3.1));
  float h2 = hash12(vec2(seed, 5.7));
  float h3 = hash12(vec2(seed, 9.2));
  vec2 from = vec2(-0.5 + h1, 0.25 + 0.22 * h2);
  float ang = -0.35 - 0.55 * h3;
  vec2 way = vec2(cos(ang) * (h1 > 0.5 ? -1.0 : 1.0), sin(ang));
  vec2 head = from + way * 0.45 * age;
  vec2 tail = head - way * min(0.12, 0.45 * age);
  float dist = segmentDistance(q, tail, head) / (trainPx / TRAIN_F);
  float along = clamp(dot(q - tail, way) / 0.12, 0.0, 1.0);
  float life = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.5, 0.85, age));
  return (1.0 - smoothstep(0.5, 1.3, dist)) * (0.2 + 0.8 * along) * life;
}

float trainMeteor(vec3 dir, float t) {
  float m = 0.0;
  if (K_meteors > 0.0) {
    float period = mix(70.0, 9.0, K_meteors);
    float tm = uMotionTime;
    float k = floor(tm / period);
    m = trainStreak(dir, tm - (k + 0.1 + 0.75 * hash12(vec2(k, 71.3))) * period, k);
  }
  return max(m, trainStreak(dir, sinceTrigger(5), uTriggers[5]));
}

// By night the eye adapts and the air low over the land holds the moon's light: a pale band along
// the horizon, brightest toward the moon (as bright as the moon's phase lets it), so hills, trees and
// roofs stand dark against it and water mirrors it as a bright ribbon. Light to add to the sky in
// direction dir.
vec3 trainNightGlow(vec3 dir) {
  float up = max(dir.y, 0.0);
  float toward = 0.5 + 0.5 * dot(normalize(dir.xz + 1e-6), normalize(trainSky.moon.xz + 1e-6));
  float moon = smoothstep(-0.05, 0.1, trainSky.moon.y) * toward * toward * exp(-up * 4.0);
  if (trainSky.moonPhase < 1.0) moon *= skyMoonPhaseLight(trainSky.moonPhase);
  return trainSky.night * (1.0 - 0.6 * trainOver) * (vec3(0.07, 0.085, 0.13) * exp(-up * 7.0) + vec3(0.12, 0.13, 0.15) * moon);
}

// The night sky behind the glass, for a direction in the sky's own frame: the shared dome with the
// moon, the moonlit band low over the land, stars, the M asterism, shooting stars, aurora, the deck;
// under rain a low grey sky with shafts of heavier rain hanging near the horizon. Reflections skip
// the fine things.
vec3 trainSkyCol(vec3 dir, float t, bool detail, inout float accent) {
  Sky s = trainSky;
  vec3 col = skyColor(s, dir) + trainNightGlow(dir);
  float clear = 1.0 - trainOver;
  float mark = 0.0;
  if (detail) {
    col += vec3(0.85, 0.9, 1.0) * skyStars(s, dir, K_stars) * clear;
    mark = trainMarkStars(dir) * clear * s.night;
    col += vec3(0.9, 0.95, 1.0) * trainMeteor(dir, t) * clear * s.night;
    if (K_aurora > 0.0) col += aurora(dir, t, K_aurora) * s.night * clear;
  }
  col = mix(col, vec3(dot(col, LUMA)) * vec3(0.92, 0.95, 1.0), 0.7 * trainOver) * (1.0 - 0.3 * trainStorm);
  vec4 cloud = trainClouds(dir, t, detail);
  col = mix(col, cloud.rgb, cloud.a);
  // The M's stars shine through thin cloud.
  mark *= 1.0 - 0.6 * cloud.a;
  col += vec3(1.0, 0.86, 0.62) * mark;
  accent = max(accent, mark);
  if (K_rain > 0.0 && dir.y < 0.3) {
    float az = atan(dir.x, dir.z) + trainS / 6000.0;
    float shaft = smoothstep(0.35, 0.8, 0.65 * vnoise(vec2(az * 9.0 - uMotionTime * 0.02 * K_wind, 3.1)) + 0.35 * vnoise(vec2(az * 23.0, 8.3)));
    col = mix(col, trainAir * 1.1, shaft * K_rain * (0.3 + 0.5 * K_rain) * smoothstep(0.3, 0.0, dir.y));
  }
  return col;
}

// ---- The far country: a ridge with a village at its foot, forested hills ----

// The ridge's height above the fields (m), d metres along the line at its distance: long swells
// with sharper peaks; low downs on the rural line, high peaks on the mountain line.
float trainRidgeH(float d) {
  float base = trainProfile(d, 2048.0, TRAIN_RIDGE_Z, 3.0, 3);
  float crest = 1.0 - abs(2.0 * trainProfile(d, 512.0, TRAIN_RIDGE_Z, 7.0, 3) - 1.0);
  return (70.0 + 280.0 * base + 200.0 * crest * crest * smoothstep(0.35, 0.7, base)) * trainRidgeLift;
}

// The hills' skyline (m): ranges of forested hills with open country between them, where the ridge
// and the village at its foot show; the line's lift, and the hill each tunnel goes through rising
// over its stretch and falling away a few hundred metres beyond its mouths.
float trainHillsH(float d) {
  float h = (4.0 + 62.0 * smoothstep(0.3, 0.8, trainProfile(d, 512.0, TRAIN_HILLS_Z, 11.0, 4)) + 7.0 * trainProfile(d, 16.0, TRAIN_HILLS_Z, 13.0, 2)) * trainHillsLift;
  if (trainTunnelHill > 0.0) {
    float hill = 0.0;
    for (int k = 0; k < TRAIN_EVENTS; k++) {
      vec2 tn = trainTunnels[k];
      if (tn.y > 0.0) hill = max(hill, smoothfall(420.0, 60.0, max(tn.x - d, d - tn.x - tn.y)));
    }
    h += trainTunnelHill * hill;
  }
  return h;
}

// The hills at d along the line, h above the fields, under a skyline at top: dark forest with
// clearings and farmland lower down, the skyline catching the moon behind it, a farm's lit window.
vec3 trainHillsCol(float d, float h, float top, bool detail, inout float accent) {
  float below = top - h;
  float fields = smoothstep(0.45 - trainOpen, 0.6 - trainOpen, trainNoise(d, 128.0, 17.0)) * smoothstep(6.0, 18.0, below);
  vec3 n = normalize(vec3(0.0, 0.55, -0.85));
  vec3 c = trainLit(mix(vec3(0.03, 0.045, 0.04), vec3(0.09, 0.1, 0.07), fields), n);
  c += trainMoonLight * 0.12 * exp(-below / 3.0);
  float snow = snowCover(vec3(0.0, 1.0, 0.0), vec2(trainTile(d, 2048.0).y / 30.0, h / 6.0), trainLying) * mix(0.45, 1.0, fields);
  c = mix(c, trainLit(TRAIN_SNOW * 0.85, n), snow);
  c = trainFade(c, TRAIN_HILLS_Z, h);
  if (detail && K_lights > 0.0) {
    vec2 tl = trainTile(d, 128.0);
    float hf = trainHash(tl.x, 19.0);
    if (hf < (0.35 * K_lights + 0.05) * trainFarms) {
      float cellM = trainPx * TRAIN_HILLS_Z / TRAIN_F;
      vec2 dv = vec2(tl.y - (0.2 + 0.6 * fract(hf * 13.1)) * 128.0, below - 6.0 - 22.0 * fract(hf * 7.7)) / cellM;
      float r = length(dv);
      float core = trainHard(1.0 - smoothstep(0.8, 1.6, r)) * trainLampsOn;
      c = mix(c, TRAIN_GLOW * 1.1, core);
      c += TRAIN_GLOW * 0.08 * exp(-r * r / 6.0) * trainLampsOn;
      accent = max(accent, core);
    }
  }
  return c;
}

// The ridge at d, h above the fields: rock and forest gone blue with distance, a silver line where
// the moon behind it catches the skyline, snow on the peaks (lower once snow lies on the land).
vec3 trainRidgeCol(float d, float h, float top) {
  vec3 n = normalize(vec3(0.0, 0.6, -0.8));
  vec3 c = trainLit(vec3(0.06, 0.07, 0.09), n);
  c += trainMoonLight * 0.1 * exp(-(top - h) / 10.0);
  float line = mix(360.0, 90.0, trainLying) + 50.0 * (trainNoise(d, 128.0, 23.0) - 0.5);
  c = mix(c, trainLit(TRAIN_SNOW * 0.8, n), smoothstep(line - 25.0, line + 25.0, h) * 0.85);
  return trainFade(c, TRAIN_RIDGE_Z, h);
}

// A village climbing the ridge's lower slopes: a cluster of lights, mostly warm, a few street lamps
// and the blue of a television, twinkling a little through the long air. Light to add.
vec3 trainVillage(vec2 o, inout float accent) {
  if (K_lights <= 0.0) return vec3(0.0);
  float z = TRAIN_VILLAGE_Z;
  float d = o.x * z / TRAIN_F + trainEyeOff.x;
  vec2 tl = trainTile(d, 1024.0);
  float h = trainHash(tl.x, 31.0);
  if (h > 0.55) return vec3(0.0);
  float u = tl.y - (300.0 + 424.0 * fract(h * 7.3));
  float hy = (o.y - TRAIN_HORIZON) * z / TRAIN_F + TRAIN_EYE + trainEyeOff.y;
  if (abs(u) > 230.0 || hy < -8.0 || hy > 200.0) return vec3(0.0);
  float cellM = trainPx * z / TRAIN_F;
  vec3 c = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    float hi = trainHash(tl.x, 40.0 + float(i));
    if (hi > 0.4 + 0.6 * K_lights) continue;
    float spread = fract(hi * 13.7);
    vec2 at = vec2((fract(hi * 71.3) - 0.5) * 380.0 * (0.4 + 0.6 * spread), 15.0 + 170.0 * spread * spread * fract(hi * 5.1));
    float r = length(vec2(u, hy) - at) / cellM;
    float core = trainHard(1.0 - smoothstep(0.7, 1.4, r));
    float kind = fract(hi * 29.3);
    vec3 tint = kind > 0.85 ? vec3(0.7, 0.82, 1.0) : (kind > 0.6 ? TRAIN_SODIUM : TRAIN_GLOW);
    float tw = 0.8 + 0.2 * sin(uMotionTime * (0.6 + fract(hi * 3.3)) + hi * 40.0);
    c += tint * (core * 0.9 * tw + 0.12 * exp(-r * r / 9.0));
    accent = max(accent, core * 0.8);
  }
  return c * trainLampsOn;
}

// A radio mast on the ridge now and then, its red light blinking slowly. Colour and cover.
vec4 trainMast(float d, float h, inout float accent) {
  vec2 tl = trainTile(d, 2048.0);
  float hm = trainHash(tl.x, 29.0);
  if (hm > 0.6) return vec4(0.0);
  float cellM = trainPx * TRAIN_RIDGE_Z / TRAIN_F;
  float x = tl.y - (0.25 + 0.5 * fract(hm * 5.3)) * 2048.0;
  if (abs(x) > 3.0 * cellM) return vec4(0.0);
  float top = trainRidgeH(d - x) + 75.0;
  float bar = trainHard(clamp(0.5 - (abs(x) - 0.6 * cellM) / cellM, 0.0, 1.0)) * step(h, top);
  float phase = fract(uMotionTime / 1.6 + hm * 7.0);
  float blink = smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.42, 0.52, phase)) * trainLampsOn;
  float light = trainHard(1.0 - smoothstep(0.7, 1.5, length(vec2(x, h - top - 2.0)) / cellM)) * blink;
  vec3 c = mix(trainFade(vec3(0.02, 0.022, 0.03), TRAIN_RIDGE_Z, h), TRAIN_SIGNAL * 1.2, light);
  accent = max(accent, light);
  return vec4(c, max(bar, light));
}

// Everything beyond the fields at image point o: the hills, the ridge with its village and mast, the
// sky. detail off for reflections.
vec3 trainFar(vec2 o, float t, bool detail, inout float hitZ, inout float accent) {
  float eyeH = TRAIN_EYE + trainEyeOff.y;
  float rise = o.y - TRAIN_HORIZON;
  float hH = rise * TRAIN_HILLS_Z / TRAIN_F + eyeH;
  if (hH < 80.0 * trainHillsLift + trainTunnelHill) {
    float dH = o.x * TRAIN_HILLS_Z / TRAIN_F + trainEyeOff.x;
    float top = trainHillsH(dH);
    if (trainHard(clamp((top - hH) / (trainPx * TRAIN_HILLS_Z / TRAIN_F) + 0.5, 0.0, 1.0)) > 0.5) {
      hitZ = TRAIN_HILLS_Z;
      return trainHillsCol(dH, hH, top, detail, accent);
    }
  }
  float hR = rise * TRAIN_RIDGE_Z / TRAIN_F + eyeH;
  if (hR < 575.0 * trainRidgeLift + 75.0) {
    float dR = o.x * TRAIN_RIDGE_Z / TRAIN_F + trainEyeOff.x;
    float top = trainRidgeH(dR);
    if (trainHard(clamp((top - hR) / (trainPx * TRAIN_RIDGE_Z / TRAIN_F) + 0.5, 0.0, 1.0)) > 0.5) {
      hitZ = TRAIN_RIDGE_Z;
      vec3 c = trainRidgeCol(dR, hR, top);
      if (detail) c += trainVillage(o, accent);
      return c;
    }
    if (detail) {
      vec4 mast = trainMast(dR, hR, accent);
      if (mast.a > 0.5) {
        hitZ = TRAIN_RIDGE_Z;
        return mast.rgb;
      }
    }
  }
  vec3 dirC = normalize(vec3(o.x, rise, TRAIN_F));
  vec2 xz = rotate(dirC.xz, TRAIN_YAW);
  return trainSkyCol(vec3(xz.x, dirC.y, xz.y), t, detail, accent);
}

// ---- Water ----

// Water lying flat at depth z (m), d along the line, under image point o: the mirrored hills, ridge
// and sky (wavelets long along the river shift it a little, sliding past without flicker), a dark
// body under a glancing sheen, and the moon's broken path: facets tilted just so send its light to
// the eye, in rows of long glints.
vec3 trainWater(vec2 o, float z, float d, float t) {
  float tm = uMotionTime;
  float rough = 0.4 + 0.6 * abs(K_wind) + 0.8 * K_rain;
  float row = floor(o.y / (3.0 * trainPx));
  float wob = trainNoise(d + tm * 0.5, 16.0, 150.0 + row) - 0.5;
  vec2 m = vec2(o.x + wob * 0.006 * rough * trainKeep(16.0, z), 2.0 * TRAIN_HORIZON - o.y);
  float mz = 0.0;
  float macc = 0.0;
  vec3 refl = trainFar(m, t, false, mz, macc);
  float graze = (TRAIN_HORIZON - o.y) / TRAIN_F;
  vec3 col = mix(vec3(0.008, 0.012, 0.016), refl * (1.0 - 0.3 * K_rain), 0.5 + 0.45 * exp(-graze * 14.0));
  vec3 view = normalize(vec3(o.x, o.y - TRAIN_HORIZON, TRAIN_F));
  vec3 hv = normalize(trainMoonC - view);
  float tilt = length(hv.xz) / max(hv.y, 0.05);
  float sigma = 0.11 + 0.06 * abs(K_wind) + 0.08 * K_rain;
  float path = exp(-tilt * tilt / (sigma * sigma)) * smoothstep(-0.02, 0.05, trainMoonC.y) * (1.0 - 0.8 * trainOver);
  if (path > 0.01) {
    float n = mix(0.5, trainNoise(d + tm * 0.6, 8.0, 170.0 + row * 1.7), trainKeep(8.0, z));
    float glint = trainHard(smoothstep(0.5, 0.8, n) * path * 1.6);
    col += trainMoonLight * (1.4 * path + 3.0 * glint);
  }
  return col;
}

// ---- The fields' rows: hedges, trees, farmhouses ----

// A farmhouse's windows, q from the middle of its foot (m), w wide with walls wall metres high: lit
// ones glow (some brighter, some behind curtains, a rare television's blue) and spill a halo. x: hard
// window cover, y: lit 0..1; the halo goes to glow.
vec2 trainWindows(vec2 q, float w, float wall, float id, float aa, inout vec3 glow, out vec3 tint) {
  tint = TRAIN_GLOW;
  float n = max(floor(w / 2.8), 1.0);
  float col = clamp(floor(q.x / 2.8 + 0.5 * n), 0.0, n - 1.0);
  float cx = (col + 0.5 - 0.5 * n) * 2.8;
  float storey = wall > 5.3 && q.y > 2.6 ? 1.0 : 0.0;
  float cy = storey > 0.5 ? 3.7 : 1.55;
  float h = trainHash(id * 1.37 + col * 7.0 + storey * 31.0, 57.0);
  float lit = step(h, 0.9 * K_lights) * trainLampsOn;
  float kind = fract(h * 19.3);
  tint = kind > 0.9 ? vec3(0.55, 0.7, 1.0) : (kind > 0.55 ? vec3(1.0, 0.5, 0.2) : vec3(1.0, 0.72, 0.38));
  vec2 size = vec2(max(0.42, 1.1 * aa), max(0.5, 1.1 * aa));
  vec2 wq = q - vec2(cx, cy);
  float cover = trainSolid(max(abs(wq.x) - size.x, abs(wq.y) - size.y), aa);
  glow += tint * lit * 0.3 * exp(-dot(wq, wq) / max(1.6, 9.0 * aa * aa));
  return vec2(cover, lit);
}

// One row along the fields z metres out (or a river bank): a hedge with gaps, a tree in a tile now
// and then (round crowns, a few conifers: as many as the line's trainTrees and trainConifers say),
// and, in hamlets, farmhouses (trainFarms). hr: the sight line's height above the fields there (m);
// d: metres along the line. Colour and hard cover; lit windows' halos go to glow.
vec4 trainRow(float k, float z, float d, float hr, bool bank, inout vec3 glow, inout float accent) {
  float aa = trainAA(z);
  // On a river bank (k 20 the near one, 21 the far): reeds and rough grass instead of a hedge, now and
  // then a willow on the near bank, alders crowding the far one. Along the road (k 0) the verge is
  // mostly open, a stretch of hedge here and there, so the country shows beyond it.
  float salt = bank ? 280.0 + k : 10.0 * k;
  float hedge = 0.0;
  float dist = 1e3;
  if (hr < 2.9) {
    float gate = bank ? 0.0 : trainNoise(d, 64.0, salt + 1.0);
    float grown = k < 0.5 ? smoothstep(0.62, 0.78, gate) : smoothstep(0.16, 0.26, gate);
    hedge = bank ? (k < 20.5 ? 0.35 : 0.6) * (1.0 + 0.8 * trainProfile(d, 8.0, z, salt + 2.0, 1))
                 : (0.35 + 1.5 * grown) * (0.75 + 0.5 * trainProfile(d, 16.0, z, salt + 2.0, 2));
    dist = hr - hedge;
  }
  float part = 0.0;
  vec2 local = vec2(0.0);
  float houseW = 0.0;
  float houseWall = 0.0;
  float houseId = 0.0;
  float Lt = z < 60.0 ? 32.0 : 64.0;
  vec2 tt = trainTile(d + 13.0 * k, Lt);
  float ht = trainHash(tt.x, salt + 3.0);
  float r = mix(2.2, min(5.5, 0.18 * Lt), fract(ht * 3.3));
  float tall = r * (1.7 + fract(ht * 5.9));
  if (ht < (bank ? (k < 20.5 ? 0.12 : 0.75) : trainTrees) && hr < tall + 0.5) {
    float xc = (0.3 + 0.4 * fract(ht * 7.7)) * Lt;
    vec2 q = vec2(tt.y - xc, hr);
    float tree;
    if (!bank && fract(ht * 11.3) < trainConifers) {
      // A conifer: three drooping tiers.
      float u = clamp(q.y / tall, 0.0, 1.0);
      float w = r * 0.85 * (1.0 - u) * (0.72 + 0.28 * (1.0 - fract(u * 3.0)));
      tree = max(abs(q.x) - w, max(0.6 - q.y, q.y - tall));
      tree = min(tree, max(abs(q.x) - 0.18, q.y - 1.0));
    } else {
      // A round crown in three lobes on its trunk.
      vec2 c = q - vec2(0.0, tall - 0.85 * r);
      tree = length(c / vec2(1.0, 0.9)) - r;
      tree = min(tree, length(c - vec2(-0.55 * r, -0.3 * r)) - 0.62 * r);
      tree = min(tree, length(c - vec2(0.5 * r, -0.2 * r)) - 0.6 * r);
      tree = min(tree, max(abs(q.x) - 0.22, q.y - tall + 1.2 * r));
    }
    if (tree < dist || tree < 0.0) {
      dist = tree;
      part = 1.0;
      local = q;
    }
  }
  if (!bank && k > 0.5 && hr < 13.5) {
    float Lh = z < 120.0 ? 128.0 : 256.0;
    vec2 th = trainTile(d + 57.0 * k, Lh);
    float hh = trainHash(th.x, salt + 5.0);
    if (hh < 0.6 * trainFarms && hh < (0.2 + 0.4 * smoothstep(0.55, 0.8, trainNoise(d, 1024.0, 7.0))) * trainFarms) {
      float w = 7.0 + 7.0 * fract(hh * 9.1);
      float wall = 4.6 + 1.6 * fract(hh * 6.7);
      vec2 q = vec2(th.y - (0.32 + 0.36 * fract(hh * 4.3)) * Lh, hr);
      float hw = 0.5 * w;
      float body = max(abs(q.x) - hw, q.y - wall);
      float roof;
      float chimney = 1e3;
      if (fract(hh * 2.9) < 0.5) {
        // The gable end toward us.
        float rise = 0.45 * w;
        roof = max(q.y - wall - rise * (1.0 - abs(q.x) / (hw + 0.35)), wall - 0.3 - q.y);
      } else {
        // The eaves toward us: the roof's slope as a band up to the ridge, hipped at the ends, and a
        // chimney stack.
        roof = max(abs(q.x) - (hw + 0.3 - 0.9 * max(q.y - wall, 0.0)), max(wall - 0.3 - q.y, q.y - wall - 3.0));
        chimney = max(abs(q.x - 0.45 * hw) - 0.35, max(wall + 1.0 - q.y, q.y - wall - 3.9));
      }
      float house = min(min(body, roof), chimney);
      if (abs(q.x) < hw + 3.0 + 3.0 * aa && q.y < wall + 2.0 + 3.0 * aa) {
        vec3 tint;
        trainWindows(q, w, wall, th.x, aa, glow, tint);
      }
      if (house < dist || house < 0.0) {
        dist = house;
        part = body <= min(roof, chimney) ? 2.0 : 3.0;
        local = q;
        houseW = w;
        houseWall = wall;
        houseId = th.x;
      }
    }
  }
  float cover = trainSolid(dist, aa);
  if (cover < 0.5) return vec4(0.0);

  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 face = vec3(0.0, 0.3, -0.954);
  vec3 c;
  if (part < 0.5) {
    // Hedge: dark leaves, a moonlit top, a cap of snow.
    vec3 leaf = wetten(vec3(0.06, 0.085, 0.05), trainWet, 0.6);
    c = trainLit(leaf, face) + trainMoonLight * 0.08 * exp(-max(hedge - hr, 0.0) / 0.35);
    float snow = snowCover(up, vec2(trainTile(d, 256.0).y * 0.3, hr), trainLying) * smoothstep(-0.6, 0.0, hr - hedge + 0.3);
    c = mix(c, trainLit(TRAIN_SNOW, up), snow * 0.9);
  } else if (part < 1.5) {
    // Tree: the crown's edge silvered by the moon behind it; snow on its upper side.
    vec3 leaf = wetten(vec3(0.055, 0.08, 0.06), trainWet, 0.6);
    c = trainLit(leaf, face) + trainMoonLight * 0.1 * exp(dist / 0.45);
    float snow = snowCover(up, local * 0.5 + vec2(ht * 37.0, 0.0), trainLying) * smoothstep(-1.2, 0.0, dist) * smoothstep(1.0, 3.0, local.y);
    c = mix(c, trainLit(TRAIN_SNOW * 0.9, up), snow * 0.75);
  } else if (part < 2.5) {
    // Wall: whitewash, brick or timber, lit windows and their warmth on the wall round them.
    float pick = fract(houseId * 0.37 + 0.11);
    vec3 alb = pick < 0.45 ? vec3(0.55, 0.53, 0.48) : (pick < 0.8 ? vec3(0.32, 0.17, 0.12) : vec3(0.24, 0.17, 0.12));
    vec3 g = vec3(0.0);
    vec3 tint;
    vec2 win = trainWindows(local, houseW, houseWall, houseId, aa, g, tint);
    c = trainLit(wetten(alb, trainWet, 0.4), vec3(0.0, 0.0, -1.0)) + alb * g * 2.0;
    if (win.x > 0.5) {
      c = mix(vec3(0.015, 0.018, 0.025) + trainAir * 0.2, tint * 1.25, win.y);
      accent = max(accent, win.y);
    }
  } else {
    // Roof: tiles or slate, moonlit along its slope; snow settles on it first.
    vec3 n = normalize(vec3(0.0, 0.75, -0.66));
    vec3 alb = fract(houseId * 0.53) < 0.5 ? vec3(0.28, 0.12, 0.08) : vec3(0.12, 0.13, 0.15);
    c = trainLit(wetten(alb, trainWet, 0.15), n);
    c = mix(c, trainLit(TRAIN_SNOW, n), snowCover(n, local * 0.6, trainLying));
  }
  return vec4(trainFade(c, z, hr), 1.0);
}

// ---- The ground ----

// The river alongside: its near and far banks' distance (m) at d metres along the line. It wanders
// in close for a while, its near bank just across the road (the roadside hedge gives way to reeds
// there), then off across the fields, out of sight.
vec2 trainRiverBanks(float d) {
  float near = 33.0 + 860.0 * smoothstep(0.58, 0.8, trainNoise(d, 1024.0, 61.0)) + 10.0 * trainNoise(d, 128.0, 62.0);
  return vec2(near, near + 20.0 + 18.0 * trainNoise(d, 256.0, 63.0));
}

// Is the land at d metres along the line given over to something passing: the bridged valley, the
// crossing's road through the hedges?
bool trainHidden(float d) {
  return (d > trainBridge.x - 14.0 && d < trainBridge.x + trainBridge.y + 14.0) || abs(d - trainCrossing.x) < 5.0;
}

// A car on the road alongside, side-on: car = (metres ahead, heading, alive). Low body and cabin,
// dark under the night with a moonlit roof; headlights ahead, tail lights behind, their glare in the
// air. Colour and cover; the glare goes to glow.
vec4 trainCarSide(vec2 o, vec3 car, inout vec3 glow, inout float accent) {
  float heading = car.y;
  float z = heading > 0.0 ? TRAIN_ROAD_Z - 1.3 : TRAIN_ROAD_Z + 1.3;
  float d = o.x * z / TRAIN_F + trainEyeOff.x;
  if (d > trainBridge.x - 14.0 && d < trainBridge.x + trainBridge.y + 14.0) return vec4(0.0);
  float h = (o.y - TRAIN_HORIZON) * z / TRAIN_F + TRAIN_EYE + trainEyeOff.y;
  float x = (d - car.x) * heading;
  if (abs(x) > 6.0 || h > 3.0 || h < -0.4) return vec4(0.0);
  float aa = max(trainPx * z / TRAIN_F, heading > 0.0 ? 0.06 : 0.45);
  vec2 head = vec2(x - 2.1, h - 0.68);
  vec2 tail = vec2(x + 2.12, h - 0.76);
  float lamps = trainLampsOn * 0.8 + 0.2;
  glow += vec3(1.0, 0.92, 0.75) * 0.5 * lamps * exp(-dot(head, head) / 0.5);
  glow += vec3(1.0, 0.1, 0.06) * 0.25 * lamps * exp(-dot(tail, tail) / 0.25);
  float body = trainBox(vec2(x, h - 0.68), vec2(2.18, 0.36), 0.18);
  float cabin = max(abs(x + 0.2) - (1.2 - 0.55 * (h - 0.9)), max(0.9 - h, h - 1.45));
  float dist = min(body, cabin);
  if (trainSolid(dist, aa) < 0.5) return vec4(0.0);
  vec3 paint = heading > 0.0 ? vec3(0.08, 0.1, 0.13) : vec3(0.22, 0.06, 0.05);
  vec3 c = trainLit(wetten(paint, trainWet, 0.0), vec3(0.0, 0.5, -0.86));
  c += trainMoonLight * 0.12 * smoothstep(1.3, 1.45, h);
  if (cabin < 0.0 && body > 0.0) {
    // the windows: dark glass, the dashboard's faint glow
    c = vec3(0.02, 0.025, 0.035) + vec3(0.25, 0.4, 0.3) * 0.15 * trainBell((x - 0.5) / 0.3) * step(h, 1.05);
  }
  float wheel = length(vec2(abs(x) - 1.35, h - 0.32)) - 0.32;
  if (wheel < 0.0) c = vec3(0.012);
  float lens = trainHard(1.0 - smoothstep(0.08, 0.15, length(head)));
  float red = trainHard(1.0 - smoothstep(0.06, 0.12, length(tail)));
  c = mix(c, vec3(1.0, 0.95, 0.8) * 1.4, lens * lamps);
  c = mix(c, vec3(0.9, 0.08, 0.05), red * lamps);
  accent = max(accent, lens * lamps);
  return vec4(trainFade(c, z, h), 1.0);
}

// Light the waiting car and the lamps throw on the ground about a level crossing, at dg along the
// line and zg out.
vec3 trainCrossingGround(float dg, float zg, float tm) {
  float xc = dg - trainCrossing.x;
  if (abs(xc) > 30.0) return vec3(0.0);
  vec3 l = vec3(0.0);
  for (int j = 0; j < 5; j++) {
    vec2 v = vec2(zg - 18.0 - 45.0 * float(j), xc - 4.6);
    l += TRAIN_SODIUM * 0.9 * trainLampsOn * exp(-dot(v, v) / 45.0);
  }
  if (trainCrossing.z < 0.7 && zg < 15.5 && zg > 9.0) {
    float spread = 1.0 + 0.2 * (15.5 - zg);
    l += vec3(1.0, 0.9, 0.72) * 0.9 * (1.0 - smoothstep(spread - 0.4, spread + 0.4, abs(xc - 1.7)));
  }
  vec2 f = trainFlash(tm);
  vec2 r = vec2(xc + 4.3, zg - 10.0);
  l += TRAIN_SIGNAL * 0.9 * (f.x + f.y) * exp(-dot(r, r) / 30.0);
  return l;
}

// The ground at the sight line's foot, zg metres out and dg along the line: the verge, the road with
// its cars' headlight beams, the fields; the crossing's road across them. Wet ground darkens and
// gathers puddles mirroring the sky; snow lies on all of it.
vec3 trainGround(vec2 o, float zg, float dg, float t) {
  float tm = uMotionTime;
  vec3 up = vec3(0.0, 1.0, 0.0);
  float cellZ = trainPx * zg * zg / (TRAIN_EYE * TRAIN_F);
  vec3 alb;
  float porous = 0.85;
  vec3 light = vec3(0.0);
  bool hard = false;
  // Distance to the nearest tyre track, in track half-widths (snow is pressed down along them).
  float rut = 1e3;
  bool crossing = abs(dg - trainCrossing.x) < 3.3 && zg > 11.0;
  if (crossing) {
    float xc = dg - trainCrossing.x;
    float line = trainHard(1.0 - smoothstep(0.08, 0.08 + 0.8 * trainPx * zg / TRAIN_F, abs(xc))) * step(0.45, fract(zg / 6.0));
    alb = mix(vec3(0.075, 0.075, 0.08), vec3(0.45, 0.44, 0.4), line * 0.7);
    porous = 0.1;
    hard = true;
    rut = min(min(abs(xc - 2.25), abs(xc - 0.95)), min(abs(xc + 0.95), abs(xc + 2.25))) / max(0.22, trainPx * zg / TRAIN_F);
  } else if (zg < 23.2) {
    // The verge: rough grass, tussocks streaming past.
    float tus = mix(0.5, trainNoise(dg, 16.0, 200.0 + floor(zg / 2.0)), trainKeep(16.0, zg));
    alb = mix(vec3(0.06, 0.07, 0.045), vec3(0.11, 0.1, 0.06), tus);
  } else if (zg < 29.8) {
    // The road: asphalt, its edge lines, the centre line's dashes (one line at speed).
    float edge = max(1.0 - smoothstep(0.08, 0.08 + cellZ, abs(zg - 23.8)), 1.0 - smoothstep(0.08, 0.08 + cellZ, abs(zg - 29.2)));
    float centre = (1.0 - smoothstep(0.06, 0.06 + cellZ, abs(zg - TRAIN_ROAD_Z))) * mix(0.33, step(trainTile(dg, 8.0).y, 3.0), trainKeep(3.0, zg));
    alb = vec3(0.075, 0.075, 0.08) + vec3(0.32) * trainHard(max(edge * 0.8, centre));
    porous = 0.1;
    hard = true;
    rut = min(min(abs(zg - TRAIN_ROAD_Z + 1.95), abs(zg - TRAIN_ROAD_Z + 0.65)), min(abs(zg - TRAIN_ROAD_Z - 0.65), abs(zg - TRAIN_ROAD_Z - 1.95))) / max(0.22, cellZ);
    for (int i = 0; i < TRAIN_CARS; i++) {
      vec3 car = trainCars[i];
      if (car.z < 0.5) continue;
      float lane = car.y > 0.0 ? TRAIN_ROAD_Z - 1.3 : TRAIN_ROAD_Z + 1.3;
      float ahead = (dg - car.x) * car.y - 2.2;
      float beam = smoothstep(0.0, 1.5, ahead) * (1.0 - smoothstep(10.0, 32.0, ahead)) * (1.0 - smoothstep(1.2 + 0.1 * ahead, 1.8 + 0.12 * ahead, abs(zg - lane)));
      light += vec3(1.0, 0.92, 0.75) * 1.3 * beam * (0.2 + 0.8 * trainLampsOn);
    }
  } else {
    // The fields: a patchwork between the hedgerows, each field its own crop, ditches at their ends.
    float band = 0.0;
    for (int i = 0; i < TRAIN_ROWS; i++) band += step(TRAIN_ROW_Z[i], zg);
    float L = band < 4.0 ? 128.0 : 256.0;
    vec2 tl = trainTile(dg + 41.0 * band, L);
    float h = trainHash(tl.x, 210.0 + band);
    // Up in the mountains: pasture, and rough meadow gone pale.
    if (trainMeadows) h = fract(h * 7.3) < 0.75 ? 0.4 : 0.9;
    if (h < 0.28) alb = vec3(0.14, 0.11, 0.085);       // ploughed
    else if (h < 0.52) alb = vec3(0.11, 0.15, 0.085);  // pasture
    else if (h < 0.72) alb = vec3(0.36, 0.31, 0.2);    // stubble, pale under the moon
    else if (h < 0.88) alb = vec3(0.12, 0.19, 0.095);  // winter wheat
    else alb = vec3(0.19, 0.16, 0.13);                 // fallow
    float edge = min(tl.y, L - tl.y);
    alb *= mix(0.45, 1.0, trainSolid(1.2 - edge, max(trainPx * zg / TRAIN_F, 0.3)));
    alb *= 0.85 + 0.3 * mix(0.5, trainNoise(dg, 16.0, 220.0 + band), trainKeep(16.0, zg)) * (0.6 + 0.4 * vnoise(vec2(zg * 0.25, band * 7.0)));
  }
  if (crossing || abs(dg - trainCrossing.x) < 30.0) light += trainCrossingGround(dg, zg, tm);

  alb = wetten(alb, trainWet, porous);
  vec3 c = trainLit(alb, up) + alb * light;
  // Puddles and snow are fixed to the ground: measured from the start of its 256 m tile.
  vec2 world = vec2(trainTile(dg, 256.0).y, zg);
  float pool = trainWet > 0.35 ? rainPuddles(world, trainWet) : 0.0;
  float mirror = hard ? wetGloss(trainWet, 1.0) : 0.0;
  mirror = max(mirror, pool * 0.9);
  c = mix(c, trainAir * 1.25 + light * 0.25, mirror * 0.7);
  // Snow over everything; on the roads, tyre tracks run through it.
  float snow = snowCover(up, world * 0.07, trainLying) * (1.0 - 0.7 * trainHard(1.0 - smoothstep(0.8, 1.2, rut)));
  c = mix(c, trainLit(TRAIN_SNOW, up) + TRAIN_SNOW * light, snow);
  return trainFade(c, zg, 0.0);
}

// The valley under a bridge: the sight line drops past the fields' edge to its floor trainGorge
// below, where a river winds away toward the hills under a breath of moonlit mist; the sides are
// wooded. False where the sight line stays on the fields.
bool trainValley(vec2 o, float zg, float dg, float t, out vec3 col, out float z) {
  vec4 b = trainBridge;
  col = vec3(0.0);
  z = zg;
  if (dg < b.x - 14.0 || dg > b.x + b.y + 14.0) return false;
  float rise = TRAIN_HORIZON - o.y;
  float zf = (TRAIN_EYE + trainGorge + trainEyeOff.y) * TRAIN_F / rise;
  float x = o.x * zf / TRAIN_F + trainEyeOff.x - b.x;
  vec3 up = vec3(0.0, 1.0, 0.0);
  if (x > 9.0 && x < b.y - 9.0) {
    z = zf;
    float c = 0.5 * b.y + 0.3 * b.y * (0.6 * sin(zf / 70.0 + b.z * 6.3) + 0.4 * sin(zf / 23.0 + b.z * 2.0)) * smoothstep(20.0, 120.0, zf);
    float w = 5.0 + 0.02 * zf;
    float water = trainSolid(abs(x - c) - w, trainPx * zf / TRAIN_F);
    if (water > 0.5) {
      col = trainWater(o, zf, o.x * zf / TRAIN_F + trainEyeOff.x, t);
    } else {
      vec3 alb = wetten(vec3(0.07, 0.1, 0.06), trainWet, 0.8);
      col = trainLit(alb, up);
      col = mix(col, trainLit(TRAIN_SNOW, up), snowCover(up, vec2(x, zf) * 0.1, trainLying));
      // a cottage by the water, its window lit
      vec2 lv = vec2((x - c - w - 6.0) * TRAIN_F / zf, o.y - (TRAIN_HORIZON - (TRAIN_EYE + trainGorge - 1.5) * TRAIN_F / 160.0));
      col += TRAIN_GLOW * trainLampsOn * K_lights * trainHard(1.0 - smoothstep(1.0, 2.0, length(lv) / trainPx)) * step(abs(zf - 160.0), 40.0);
    }
  } else {
    // the wooded sides falling away below the fields
    z = 0.5 * (zg + zf);
    vec3 n = normalize(vec3(x < 9.0 ? 0.6 : -0.6, 0.6, -0.5));
    col = trainLit(vec3(0.03, 0.045, 0.035), n);
    col = mix(col, trainLit(TRAIN_SNOW * 0.8, n), 0.7 * snowCover(n, vec2(x, zf) * 0.15, trainLying));
  }
  vec3 mist = trainAmbient * 0.6 + trainMoonLight * 0.15 + trainAir * 0.4;
  col = mix(col, mist, fogAmount(0.35 + K_fog, clamp(z / 700.0, 0.0, 1.0), 0.15));
  col = trainFade(col, z, 0.0);
  return true;
}

// The land at image point o, near to far: the cars on the road, the rows of hedges and trees (and
// the river's banks among them), then the ground at the sight line's foot (verge, road, river,
// fields, a bridged valley) or, above the horizon, the far country and the sky.
vec3 trainLand(vec2 o, float t, inout float hitZ, inout float accent, inout vec3 glow) {
  float rise = o.y - TRAIN_HORIZON;
  float eyeH = TRAIN_EYE + trainEyeOff.y;
  bool ground = rise < -1e-4;
  float zg = ground ? eyeH * TRAIN_F / -rise : 1e6;
  float dg = o.x * zg / TRAIN_F + trainEyeOff.x;
  // The river's banks along this sight line: one fixed-point step from mid-river.
  vec2 banks = vec2(1e5);
  if (K_river > 0.5 && rise < 0.3) {
    vec2 b = trainRiverBanks(o.x * 60.0 / TRAIN_F + trainEyeOff.x);
    banks = vec2(trainRiverBanks(o.x * b.x / TRAIN_F + trainEyeOff.x).x, trainRiverBanks(o.x * b.y / TRAIN_F + trainEyeOff.x).y);
    if (banks.x > 800.0 || trainHidden(o.x * banks.x / TRAIN_F + trainEyeOff.x)) banks = vec2(1e5);
  }
  // Cars, in front of every row.
  if (zg > 24.0) {
    for (int i = 0; i < TRAIN_CARS; i++) {
      if (trainCars[i].z < 0.5) continue;
      vec4 car = trainCarSide(o, trainCars[i], glow, accent);
      if (car.a > 0.5) {
        hitZ = TRAIN_ROAD_Z;
        return car.rgb;
      }
    }
  }
  bool nearBank = banks.x < 1e4;
  bool farBank = banks.y < 1e4;
  for (int i = 0; i <= TRAIN_ROWS; i++) {
    float z = i < TRAIN_ROWS ? TRAIN_ROW_Z[i] : 1e5;
    // The river's banks take their turn among the rows: reeds on the near bank, alders on the far.
    if (nearBank && banks.x < z) {
      nearBank = false;
      if (zg <= banks.x) break;
      float hb = rise * banks.x / TRAIN_F + eyeH;
      if (hb < 16.0) {
        vec4 r = trainRow(20.0, banks.x, o.x * banks.x / TRAIN_F + trainEyeOff.x, hb, true, glow, accent);
        if (r.a > 0.5) {
          hitZ = banks.x;
          return r.rgb;
        }
      }
    }
    if (farBank && banks.y < z) {
      farBank = false;
      if (zg <= banks.y) break;
      float hb = rise * banks.y / TRAIN_F + eyeH;
      if (hb < 16.0) {
        vec4 r = trainRow(21.0, banks.y, o.x * banks.y / TRAIN_F + trainEyeOff.x, hb, true, glow, accent);
        if (r.a > 0.5) {
          hitZ = banks.y;
          return r.rgb;
        }
      }
    }
    if (i == TRAIN_ROWS || zg <= z) break;
    if (z > banks.x - 8.0 && z < banks.y + 4.0) continue;
    float hr = rise * z / TRAIN_F + eyeH;
    if (hr > 16.0) {
      if (ground) continue;
      break;
    }
    float d = o.x * z / TRAIN_F + trainEyeOff.x;
    if (trainHidden(d)) continue;
    vec4 r = trainRow(float(i), z, d, hr, false, glow, accent);
    if (r.a > 0.5) {
      hitZ = z;
      return r.rgb;
    }
  }
  if (!ground || zg > 1500.0) return trainFar(o, t, true, hitZ, accent);
  vec3 valley;
  float vz;
  if (trainValley(o, zg, dg, t, valley, vz)) {
    hitZ = vz;
    return valley;
  }
  hitZ = zg;
  if (zg > banks.x && zg < banks.y) {
    vec3 c = trainWater(o, zg, dg, t);
    // the far bank's alders, mirrored
    float hb = (banks.y - zg) * -rise / TRAIN_F;
    vec3 g = vec3(0.0);
    float a = 0.0;
    vec4 bank = trainRow(21.0, banks.y, o.x * banks.y / TRAIN_F + trainEyeOff.x, hb, true, g, a);
    c = mix(c, bank.rgb * 0.6, bank.a * 0.85);
    c *= mix(0.55, 1.0, smoothstep(banks.x, banks.x + 2.5, zg));
    return trainFade(c, zg, 0.0);
  }
  return trainGround(o, zg, dg, t);
}

// ---- Near the line ----

// The verge between the line and the road: long low thickets and the line-side fence, whose posts
// blur into a grey wash at speed and stand out again as the train slows; its three wires hold
// still while the land slides behind them.
vec3 trainVerge(vec2 o, float t, vec3 col, inout float hitZ) {
  float eyeH = TRAIN_EYE + trainEyeOff.y;
  float rise = o.y - TRAIN_HORIZON;
  vec3 up = vec3(0.0, 1.0, 0.0);
  // Beside a station the platform and the station house take the verge's place.
  float dS = o.x * TRAIN_FENCE_Z / TRAIN_F + trainEyeOff.x;
  bool station = dS > trainStation.x - 6.0 && dS < trainStation.x + trainStation.y + 6.0;
  if (hitZ > TRAIN_BUSH_Z && !station) {
    float z = TRAIN_BUSH_Z;
    float d = o.x * z / TRAIN_F + trainEyeOff.x;
    float hr = rise * z / TRAIN_F + eyeH;
    if (hr < 3.2 && !trainHidden(d)) {
      vec2 tl = trainTile(d, 32.0);
      float hb = trainHash(tl.x, 240.0);
      if (hb < 0.45) {
        float len = 8.0 + 14.0 * fract(hb * 7.1);
        float u = tl.y - (32.0 - len) * fract(hb * 3.7);
        float ends = smoothstep(0.0, 2.5, u) * smoothstep(len, len - 2.5, u);
        float top = (0.8 + 1.6 * fract(hb * 5.3)) * sqrt(ends) * (0.8 + 0.4 * trainProfile(d, 8.0, z, 241.0, 1));
        if (u > 0.0 && u < len && trainSolid(hr - top, trainAA(z)) > 0.5) {
          vec3 c = trainLit(wetten(vec3(0.03, 0.045, 0.03), trainWet, 0.6), vec3(0.0, 0.3, -0.954));
          c += trainMoonLight * 0.06 * exp(-max(top - hr, 0.0) / 0.3);
          c = mix(c, trainLit(TRAIN_SNOW, up), 0.9 * snowCover(up, vec2(u * 0.4, hr * 2.0), trainLying) * smoothstep(-0.5, 0.0, hr - top + 0.3));
          col = trainFade(c, z, hr);
          hitZ = z;
        }
      }
    }
  }
  if (hitZ > TRAIN_FENCE_Z) {
    float z = TRAIN_FENCE_Z;
    float d = o.x * z / TRAIN_F + trainEyeOff.x;
    float hr = rise * z / TRAIN_F + eyeH;
    if (hr > -0.2 && hr < 1.4 && !trainHidden(d) && !station) {
      float cellM = trainPx * z / TRAIN_F;
      float wire = 0.0;
      for (int i = 0; i < 3; i++) wire = max(wire, 1.0 - smoothstep(0.6 * cellM, 1.1 * cellM, abs(hr - 0.35 - 0.4 * float(i))));
      vec2 tl = trainTile(d, 2.0);
      float b = trainV * TRAIN_SHUTTER + cellM;
      float x = abs(tl.y - 1.0);
      float post = mix(0.04, clamp((0.06 + 0.5 * b - x) / b, 0.0, 1.0), trainKeep(2.0, z)) * step(hr, 1.25);
      float cover = max(trainHard(wire), trainHard(post));
      if (cover > 0.5) {
        vec3 c = trainLit(vec3(0.09, 0.085, 0.08), vec3(0.0, 0.5, -0.86)) + trainMoonLight * 0.15 * wire;
        col = trainFade(c, z, hr);
        hitZ = z;
      }
    }
  }
  return col;
}

// ---- Events ----

// A sign's face, q from its middle and size its half extent (m): cream enamel in a dark green
// border, lit by the lamps (light). The name is too far off to read, a row of letters; when the
// Manifold mark is on, this is Manifold, and the board carries the M.
vec3 trainSignFace(vec2 q, vec2 size, vec3 light, float seed, float aa, inout float accent) {
  vec3 board = vec3(0.82, 0.78, 0.66) * (0.1 + 0.9 * light) + trainAmbient * 0.6;
  if (max(abs(q.x) - size.x, abs(q.y) - size.y) > -0.06) return vec3(0.05, 0.12, 0.08) * (0.3 + light);
  float hgt = 1.24 * size.y * 0.5;
  float ink = 0.0;
  if (K_mark > 0.0) {
    ink = trainSolid(markDistance(q / (1.3 * hgt)) * 1.3 * hgt - 0.11 * hgt, aa);
    vec3 m = mix(vec3(0.6, 0.32, 0.08), TRAIN_GLOW * 1.2, 0.5 * K_mark) * (0.25 + 0.9 * light);
    accent = max(accent, ink * K_mark * 0.8);
    return mix(board, m, ink);
  }
  float cw = hgt * 0.8;
  float li = floor(q.x / cw + 0.5);
  if (abs(li) <= floor(size.x / cw) - 1.0) {
    vec2 lq = vec2(q.x - li * cw, q.y) / hgt;
    float h = hash12(vec2(li + seed * 91.0, 7.0));
    float w = 0.09;
    float s = abs(lq.y) - 0.5;
    float stroke = 1e3;
    if (h > 0.15) stroke = min(stroke, abs(lq.x + 0.24) - w);
    if (fract(h * 3.1) > 0.4) stroke = min(stroke, abs(lq.x - 0.24) - w);
    if (fract(h * 5.7) > 0.5) stroke = min(stroke, abs(lq.y - 0.42) - w);
    if (fract(h * 7.3) > 0.55) stroke = min(stroke, abs(lq.y) - w);
    if (fract(h * 9.9) > 0.6) stroke = min(stroke, abs(lq.y + 0.42) - w);
    if (fract(h * 13.1) > 0.75) stroke = min(stroke, abs(lq.x - lq.y * 0.48) - w);
    ink = trainSolid(max(max(stroke, s), abs(lq.x) - 0.33) * hgt, aa);
  }
  return mix(board, vec3(0.04, 0.06, 0.05), ink);
}

// A standing figure, q across and up from its feet (m), in a long coat; with a peaked cap (hat 1).
float trainFigure(vec2 q, float hat) {
  float legs = max(abs(abs(q.x) - 0.09) - 0.06, max(-q.y, q.y - 0.8));
  float coat = max(abs(q.x) - mix(0.27, 0.2, clamp((q.y - 0.5) / 0.95, 0.0, 1.0)), max(0.5 - q.y, q.y - 1.42));
  float shoulders = (length((q - vec2(0.0, 1.38)) / vec2(0.24, 0.1)) - 1.0) * 0.1;
  float head = length(q - vec2(0.0, 1.6)) - 0.11;
  float d = min(min(legs, coat), min(shoulders, head));
  if (hat > 0.5) d = min(d, min(max(abs(q.x - 0.03) - 0.16, abs(q.y - 1.69) - 0.02), max(abs(q.x) - 0.11, max(1.69 - q.y, q.y - 1.8))));
  return d;
}

// A small country station gliding past, the train slowed right down for it: the platform under its
// lamps (wet, it mirrors them in long streaks; snowy, it glows warm under them), the station house
// with its lit waiting room and a traveller reading in a window, the canopy on cast-iron columns with
// its valance and hanging globes and clock, name boards, a bench, a passenger waiting (an umbrella in
// the rain) and the stationmaster with his lamp.
vec3 trainStationScene(vec2 o, float t, vec3 col, inout float hitZ, inout float accent, inout vec3 glow) {
  vec4 st = trainStation;
  float L = st.y;
  if (st.x > 24.0 || st.x + L < -24.0) return col;
  float mid = 0.5 * L;
  float rise = o.y - TRAIN_HORIZON;
  float seed = st.z;
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 front = vec3(0.0, 0.0, -1.0);
  // The platform.
  if (rise < 0.0) {
    float zp = (TRAIN_PLATFORM + trainEyeOff.y) * TRAIN_F / -rise;
    float x = o.x * zp / TRAIN_F + trainEyeOff.x - st.x;
    if (zp < 9.8 && zp < hitZ && x > 0.0 && x < L) {
      hitZ = zp;
      // Under the canopy the flags stay nearly dry.
      float wet = trainWet * (1.0 - 0.85 * step(abs(x - mid), 26.0) * step(6.0, zp));
      float gloss = wetGloss(wet, 1.0);
      vec3 alb = wetten(vec3(0.25, 0.24, 0.23), wet, 0.25) * (0.9 + 0.2 * mix(0.5, vnoise(vec2(x * 0.7, zp * 1.3)), trainKeep(1.4, zp)));
      vec3 light = trainStationLight(x, zp, -TRAIN_PLATFORM) + trainCarriageLight(zp, -TRAIN_PLATFORM);
      vec3 c = trainLit(alb, up) + alb * light;
      c = mix(c, trainLit(TRAIN_SNOW, up) + TRAIN_SNOW * light, snowCover(up, vec2(x, zp) * 0.6, trainLying));
      if (gloss > 0.0) {
        // The lamps' long reflections, brightest in the puddles, rings spreading in them while it
        // rains; drops splashing on the open flags.
        float pool = rainPuddles(vec2(x, zp * 2.0), wet);
        float streak = 0.0;
        float xl = o.x * 5.4 / TRAIN_F + trainEyeOff.x - st.x;
        float j = floor((xl - 7.0) / 14.0 + 0.5);
        for (int k = -1; k <= 1; k++) {
          float lx = 7.0 + 14.0 * (j + float(k));
          if (lx < 0.0 || lx > L || abs(lx - mid) < 27.0) continue;
          float sx = (st.x + lx - trainEyeOff.x) * TRAIN_F / 5.4;
          streak += trainBell((o.x - sx) / (0.005 + 0.008 * (1.0 - pool)));
        }
        float xg = o.x * 6.2 / TRAIN_F + trainEyeOff.x - st.x;
        float gi = floor((xg - mid + 20.0) / 8.0 + 0.5);
        if (gi >= -0.5 && gi <= 5.5) {
          float sx = (st.x + mid - 20.0 + 8.0 * gi - trainEyeOff.x) * TRAIN_F / 6.2;
          streak += trainBell((o.x - sx) / (0.005 + 0.008 * (1.0 - pool)));
        }
        c += TRAIN_GLOW * trainHard(min(streak, 1.0)) * gloss * (0.3 + 0.7 * pool) * trainLampsOn;
        float open = 1.0 - step(abs(x - mid), 26.0) * step(6.0, zp);
        if (K_rain > 0.0 && open > 0.5) {
          vec3 dropLight = vec3(0.9, 0.95, 1.0) * dot(trainAir, LUMA) * 1.2 + light * 0.6 + 0.04;
          float ring = pool > 0.5 ? trainHard(rainRipples(vec2(x, zp * 3.0) * 1.6, t, K_rain).z) : 0.0;
          float metre = TRAIN_F / (zp * trainPx);
          float splash = rainSplashes(vec2(x, zp), t, K_rain) * smoothstep(15.0, 25.0, metre);
          c = mix(c, dropLight, max(ring * 0.5, splash * 0.8));
        }
      }
      col = c;
    }
  }
  // The station house, 11 m out.
  if (hitZ > 11.0) {
    float z = 11.0;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - st.x - mid;
    float yp = rise * z / TRAIN_F + trainEyeOff.y + TRAIN_PLATFORM;
    if (abs(x) < 13.5 && yp > -0.5 && yp < 7.5) {
      float aa = trainAA(z);
      float roof = max(abs(x) - (13.2 - 1.1 * max(yp - 4.1, 0.0)), max(4.0 - yp, yp - 6.4));
      float wall = max(abs(x) - 12.6, yp - 4.15);
      float chimney = max(abs(abs(x) - 6.8) - 0.35, max(5.5 - yp, yp - 7.2));
      if (trainSolid(min(min(roof, wall), chimney), aa) > 0.5) {
        hitZ = z;
        vec3 light = trainStationLight(x + mid, z - 0.6, yp - TRAIN_PLATFORM);
        vec3 c;
        if (min(roof, chimney) < wall) {
          vec3 n = normalize(vec3(0.0, 0.7, -0.7));
          vec3 slate = vec3(0.12, 0.12, 0.14);
          c = trainLit(wetten(slate, trainWet, 0.1), n) + slate * light * 0.4;
          c = mix(c, trainLit(TRAIN_SNOW, n), snowCover(n, vec2(x, yp) * 0.8, trainLying) * step(roof, chimney));
        } else {
          bool brick = seed > 0.5;
          vec3 alb = brick ? vec3(0.4, 0.21, 0.14) : vec3(0.6, 0.53, 0.4);
          alb *= yp < 0.5 ? 0.6 : (abs(yp - 3.75) < 0.12 ? 1.15 : 1.0);
          c = trainLit(wetten(alb, trainWet, 0.5), front) + alb * light;
          // Four tall arched windows onto the waiting room, the door between them, the name over it.
          float wx = abs(x) < 6.4 ? 4.2 : 8.6;
          vec2 wq = vec2(abs(x) - wx, yp - 1.0);
          float win = min(max(abs(wq.x) - 0.62, max(-wq.y, wq.y - 2.0)), max(length(vec2(wq.x, wq.y - 2.0)) - 0.62, 2.0 - wq.y));
          if (trainSolid(win, aa) > 0.5) {
            vec3 room = TRAIN_GLOW * 0.85 * trainLampsOn + vec3(0.03, 0.03, 0.035);
            if (seed > 0.25 && x < 0.0 && wx < 5.0) {
              vec2 fq = wq - vec2(0.15, 0.0);
              if (min(length(fq - vec2(0.0, 1.08)) - 0.14, (length((fq - vec2(0.0, 0.55)) / vec2(0.32, 0.4)) - 1.0) * 0.3) < 0.0) room *= 0.12;
            }
            float bars = trainSolid(min(abs(wq.x), abs(wq.y - 1.2)) - 0.035, aa);
            c = mix(room, vec3(0.05), bars);
            accent = max(accent, (1.0 - bars) * 0.8 * trainLampsOn);
          }
          if (trainSolid(max(abs(x) - 0.8, yp - 2.7), aa) > 0.5) {
            c = vec3(0.06, 0.12, 0.08) * (0.4 + light);
            if (yp > 2.25 && abs(x) < 0.7) c = TRAIN_GLOW * 0.7 * trainLampsOn + 0.02;
          }
          if (max(abs(x) - 2.4, abs(yp - 3.32) - 0.25) < 0.0) c = trainSignFace(vec2(x, yp - 3.32), vec2(2.4, 0.25), light, seed, aa, accent);
        }
        col = trainFade(c, z, yp);
      }
    }
  }
  // The canopy's soffit, 1.3 m above the eye from 6 to 11 m out.
  if (rise > 0.0) {
    float zc = (1.3 - trainEyeOff.y) * TRAIN_F / rise;
    if (zc > 6.0 && zc < 11.0 && zc < hitZ) {
      float x = o.x * zc / TRAIN_F + trainEyeOff.x - st.x;
      if (abs(x - mid) < 26.0) {
        hitZ = zc;
        float rafter = mix(0.5, step(0.75, fract(x / 1.5)), trainKeep(1.5, zc));
        col = vec3(0.13, 0.085, 0.055) * (0.15 + 0.55 * trainStationLight(x, zc, 1.3)) * (1.0 - 0.3 * rafter);
      }
    }
  }
  // A bench against the house under the canopy, the passenger, the stationmaster, the name boards.
  if (hitZ > 10.3) {
    float z = 10.3;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - st.x - mid;
    float yp = rise * z / TRAIN_F + trainEyeOff.y + TRAIN_PLATFORM;
    vec2 q = vec2(abs(abs(x) - 6.4), yp);
    float bench = min(max(q.x - 0.9, abs(yp - 0.46) - 0.04), max(q.x - 0.9, abs(yp - 0.78) - 0.12));
    bench = min(bench, max(abs(q.x - 0.8) - 0.04, max(yp - 0.46, -yp)));
    if (trainSolid(bench, trainAA(z)) > 0.5) {
      hitZ = z;
      col = vec3(0.16, 0.1, 0.06) * (0.1 + trainStationLight(x + mid, z, yp - TRAIN_PLATFORM));
      col = mix(col, TRAIN_SNOW * (0.2 + trainStationLight(x + mid, z, yp - TRAIN_PLATFORM)), trainLying * step(0.4, yp) * step(yp, 0.5));
    }
  }
  if (hitZ > 8.2) {
    float z = 8.2;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - st.x - (mid - 31.0);
    float yp = rise * z / TRAIN_F + trainEyeOff.y + TRAIN_PLATFORM;
    if (abs(x) < 1.2 && yp < 2.4) {
      float d = trainFigure(vec2(x, yp), 0.0);
      d = min(d, max(abs(x - 0.45) - 0.24, max(-yp, yp - 0.45)));
      if (K_rain > 0.12) {
        d = min(d, max(length((vec2(x, yp) - vec2(0.05, 1.86)) / vec2(0.62, 0.36)) - 1.0, 1.86 - yp) * 0.36);
        d = min(d, max(abs(x - 0.05) - 0.02, max(1.0 - yp, yp - 2.1)));
      }
      if (trainSolid(d, trainAA(z)) > 0.5) {
        hitZ = z;
        vec3 light = trainStationLight(x + mid - 31.0, z - 0.5, yp - TRAIN_PLATFORM);
        bool brolly = K_rain > 0.12 && yp > 1.86;
        col = (brolly ? vec3(0.08, 0.1, 0.14) : vec3(0.12, 0.09, 0.08)) * (0.12 + light) + trainAmbient * 0.05;
        col += light * 0.08 * smoothstep(1.45, 1.6, yp) * step(yp, 1.72);
      }
    }
  }
  if (hitZ > 7.6) {
    float z = 7.6;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - st.x - (mid + 11.0);
    float yp = rise * z / TRAIN_F + trainEyeOff.y + TRAIN_PLATFORM;
    if (abs(x) < 1.0 && yp < 2.0) {
      vec2 lampAt = vec2(0.36, 0.95);
      float lr = length(vec2(x, yp) - lampAt);
      glow += TRAIN_GLOW * 0.35 * exp(-lr * lr / 0.08) * trainLampsOn;
      float d = min(trainFigure(vec2(x, yp), 1.0), max(abs(x - 0.36) - 0.07, abs(yp - 0.95) - 0.1));
      if (trainSolid(d, trainAA(z)) > 0.5) {
        hitZ = z;
        vec3 light = trainStationLight(x + mid + 11.0, z - 0.5, yp - TRAIN_PLATFORM);
        col = vec3(0.04, 0.06, 0.1) * (0.12 + light);
        float lamp = trainHard(1.0 - smoothstep(0.04, 0.08, lr));
        col = mix(col, TRAIN_GLOW * 1.3, lamp * trainLampsOn);
        accent = max(accent, lamp * trainLampsOn);
      }
    }
  }
  if (hitZ > 7.2) {
    // A name board beyond each end of the canopy, set halfway between two lamp posts.
    float z = 7.2;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - st.x;
    float y = rise * z / TRAIN_F + trainEyeOff.y;
    float left = 14.0 * floor((mid - 34.0) / 14.0);
    float right = 14.0 * floor((mid + 48.0) / 14.0);
    float at = abs(x - left) < abs(x - right) ? left : right;
    float xs = x - at;
    if (abs(xs) < 2.2 && y < 0.6) {
      float aa = trainAA(z);
      float posts = max(abs(abs(xs) - 1.5) - 0.05, y + 0.2);
      float board = max(abs(xs) - 1.7, abs(y + 0.0) - 0.4);
      if (trainSolid(min(posts, board), aa) > 0.5) {
        hitZ = z;
        vec3 light = trainStationLight(x, z - 1.0, y) + trainCarriageLight(z, y);
        col = board < posts ? trainSignFace(vec2(xs, y), vec2(1.7, 0.4), light, seed + at, aa, accent) : vec3(0.05, 0.07, 0.05) * (0.2 + light);
        col = mix(col, TRAIN_SNOW * (0.15 + light), trainLying * step(0.34, y) * step(board, posts));
      }
    }
  }
  // The canopy's columns, its valance, the clock and the globes hanging from it.
  if (hitZ > 6.0) {
    float z = 6.3;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - st.x - mid;
    float y = rise * z / TRAIN_F + trainEyeOff.y;
    float aa = trainAA(z);
    if (abs(x) < 26.5 && y < 1.32) {
      float cx = x - clamp(floor((x + 24.0) / 6.0 + 0.5), 0.0, 8.0) * 6.0 + 24.0;
      float column = max(abs(cx) - 0.08 - 0.12 * smoothstep(0.55, 0.85, y), y - 1.3);
      if (z < hitZ && trainSolid(column, aa) > 0.5) {
        hitZ = z;
        col = vec3(0.05, 0.09, 0.07) * (0.15 + 0.8 * trainStationLight(x + mid, z - 0.5, y)) + trainCarriageLight(z, y) * 0.08;
      }
    }
    float zv = 6.0;
    float xv = o.x * zv / TRAIN_F + trainEyeOff.x - st.x - mid;
    float yv = rise * zv / TRAIN_F + trainEyeOff.y;
    if (abs(xv) < 26.0 && yv > 0.6 && yv < 1.36) {
      float teeth = mix(0.93, 0.85 + 0.12 * abs(fract(xv / 0.3) * 2.0 - 1.0), trainKeep(0.3, zv));
      if (zv < hitZ && trainSolid(max(teeth - yv, yv - 1.34), trainAA(zv)) > 0.5) {
        hitZ = zv;
        col = vec3(0.12, 0.2, 0.14) * (0.12 + 0.6 * trainStationLight(xv + mid, zv - 0.2, yv)) + trainAmbient * 0.1;
      }
    }
    // the clock hanging at the middle: a white face, its hands at the time of night
    vec2 cq = vec2(xv, yv - 0.38);
    float face = length(cq);
    if (zv <= hitZ && (face < 0.48 || (abs(xv) < 0.03 && yv > 0.38 && yv < 0.9))) {
      float aaC = trainAA(zv);
      if (trainSolid(min(face - 0.42, max(abs(xv) - 0.03, max(0.38 - yv, yv - 0.9))), aaC) > 0.5) {
        hitZ = zv;
        float hours = 24.0 * timeOfDayM(K_time, K_cycle, uMotionTime);
        vec2 hd = vec2(sin(TAU * hours / 12.0), cos(TAU * hours / 12.0));
        vec2 md = vec2(sin(TAU * fract(hours)), cos(TAU * fract(hours)));
        float hands = min(segmentDistance(cq, vec2(0.0), hd * 0.2), segmentDistance(cq, vec2(0.0), md * 0.3));
        vec3 white = vec3(0.86, 0.84, 0.76) * (0.35 + 0.65 * trainLampsOn) + trainAmbient * 0.3;
        col = face < 0.36 ? white : vec3(0.03);
        col = mix(col, vec3(0.02), trainSolid(hands - max(0.022, 0.8 * aaC), aaC) * step(face, 0.36));
      }
    }
    // globes
    float zg = 6.2;
    float xg = o.x * zg / TRAIN_F + trainEyeOff.x - st.x - mid;
    float yg = rise * zg / TRAIN_F + trainEyeOff.y;
    if (abs(xg) < 22.0) {
      float gx = xg - (clamp(floor((xg + 20.0) / 8.0 + 0.5), 0.0, 5.0) * 8.0 - 20.0);
      vec2 gq = vec2(gx, yg - 0.55);
      float r2 = dot(gq, gq);
      glow += TRAIN_GLOW * 0.45 * exp(-r2 / 0.25) * trainLampsOn;
      if (trainSolid(min(length(gq) - 0.2, max(abs(gx) - 0.02, max(0.7 - yg, yg - 0.9))), trainAA(zg)) > 0.5 && zg < hitZ) {
        hitZ = zg;
        float lit = trainLampsOn * step(length(gq), 0.2);
        col = mix(vec3(0.04), TRAIN_GLOW * 1.4, lit);
        accent = max(accent, lit);
      }
    }
    // Rain running off the valance in a row of drips, warm in the lamplight.
    float drip = max(K_rain, 0.4 * trainWet);
    if (drip > 0.0 && abs(xv) < 26.0 && yv < 0.88 && zv < hitZ + 0.5) {
      float dr = rainDrips(vec2(xv + 26.0, 0.88 - yv), t, drip, 0.6);
      col = mix(col, TRAIN_GLOW * 0.6 * trainLampsOn + trainAir * 1.2 + 0.03, dr * 0.85);
    }
  }
  // Lamp posts along the open ends of the platform: swan-necked lanterns.
  if (hitZ > 5.4) {
    float z = 5.4;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - st.x;
    float y = rise * z / TRAIN_F + trainEyeOff.y;
    float j = floor((x - 7.0) / 14.0 + 0.5);
    float lx = 7.0 + 14.0 * j;
    if (lx >= 0.0 && lx <= L && abs(lx - mid) >= 27.0 && y < 1.3) {
      float u = x - lx;
      vec2 hq = vec2(u, y - 0.95);
      glow += TRAIN_GLOW * 0.5 * exp(-dot(hq, hq) / 0.3) * trainLampsOn;
      float post = max(abs(u + 0.25) - 0.06, y - 1.05);
      post = min(post, max(abs(u + 0.1) - 0.17, abs(y - 1.07) - 0.03));
      float head = max(abs(u) - 0.17 + 0.1 * clamp(y - 0.95, 0.0, 0.25), abs(y - 0.95) - 0.22);
      if (trainSolid(min(post, head), trainAA(z)) > 0.5) {
        hitZ = z;
        float lit = trainLampsOn * step(head, post) * step(abs(y - 0.93), 0.15);
        col = mix(vec3(0.05, 0.07, 0.06) * (0.1 + trainCarriageLight(z, y) * 2.0), TRAIN_GLOW * 1.4, lit);
        accent = max(accent, lit);
      }
    }
  }
  return col;
}

// A level crossing: the road runs off across the fields under its lamps, a car waits behind the
// lowered barrier with its headlights on us, and the flashers wig-wag red, lighting the road, the
// barrier and the compartment as they pass: a bell you can see.
vec3 trainCrossingScene(vec2 o, float t, vec3 col, inout float hitZ, inout float accent, inout vec3 glow) {
  float c = trainCrossing.x;
  if (abs(c) > 400.0) return col;
  float tm = uMotionTime;
  float rise = o.y - TRAIN_HORIZON;
  vec2 flash = trainFlash(tm);
  // The road's lamps, receding up it.
  for (int j = 0; j < 5; j++) {
    float z = 18.0 + 45.0 * float(j);
    if (z > hitZ) break;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - c - 4.6;
    float y = rise * z / TRAIN_F + trainEyeOff.y - 1.6;
    float cellM = trainPx * z / TRAIN_F;
    float r = length(vec2(x, y)) / max(cellM, 0.22);
    glow += TRAIN_SODIUM * 0.3 * exp(-r * r / 30.0) * trainLampsOn;
    float post = j < 2 ? max(abs(x + 0.3) - max(0.08, 0.6 * cellM), max(y, -6.1 - y)) : 1e3;
    float head = trainHard(1.0 - smoothstep(0.6, 1.3, r));
    if (head > 0.5 || trainSolid(post, max(cellM, trainAA(z))) > 0.5) {
      hitZ = z;
      col = head > 0.5 ? TRAIN_SODIUM * (0.3 + 1.0 * trainLampsOn) : trainLit(vec3(0.07), vec3(0.0, 0.0, -1.0));
      accent = max(accent, head * trainLampsOn);
      break;
    }
  }
  // The waiting car beyond the barrier, facing the line.
  if (trainCrossing.z < 0.7 && hitZ > 15.5) {
    float z = 15.5;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - c - 1.7;
    float y = rise * z / TRAIN_F + trainEyeOff.y + 4.2;   // above the road
    vec2 lq = vec2(abs(x) - 0.62, y - 0.7);
    glow += vec3(1.0, 0.92, 0.75) * 0.6 * exp(-dot(lq, lq) / 0.4);
    float body = trainBox(vec2(x, y - 0.68), vec2(0.9, 0.38), 0.12);
    float cabin = max(abs(x) - (0.75 - 0.3 * (y - 1.05)), max(1.05 - y, y - 1.45));
    if (trainSolid(min(body, cabin), trainAA(z)) > 0.5) {
      hitZ = z;
      float lamp = trainHard(1.0 - smoothstep(0.08, 0.15, length(lq)));
      col = cabin < body ? vec3(0.02, 0.025, 0.03) : vec3(0.06, 0.06, 0.07) * (0.3 + trainLampsOn * 0.2);
      col = mix(col, vec3(1.0, 0.96, 0.85) * 1.5, lamp);
      accent = max(accent, lamp);
    }
  }
  // The barrier: a red and white bar (one pink blur at speed) with its little lamps.
  if (hitZ > 10.5) {
    float z = 10.5;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - c;
    float y = rise * z / TRAIN_F + trainEyeOff.y + 3.0;   // above the track bed
    if (x > -4.2 && x < 3.8 && abs(y - 1.0) < 0.3) {
      float bar = max(abs(y - 1.0) - 0.06, max(-4.0 - x, x - 3.6));
      if (trainSolid(bar, trainAA(z)) > 0.5) {
        hitZ = z;
        float stripe = mix(0.5, step(0.5, fract(x / 1.0)), trainKeep(0.5, z));
        vec3 light = trainEventLight(x + c, z, y - 3.0, tm) + trainCarriageLight(z, y - 3.0);
        col = mix(vec3(0.85, 0.82, 0.78), vec3(0.75, 0.08, 0.06), stripe) * (0.08 + light) + trainAmbient * 0.1;
        float lampX = mod(x + 4.0, 2.6) - 1.3;
        float lamp = trainHard(1.0 - smoothstep(0.05, 0.1, length(vec2(lampX, y - 1.08)))) * mix(flash.x, flash.y, step(0.0, x));
        col = mix(col, TRAIN_SIGNAL * 1.4, lamp);
        accent = max(accent, lamp);
      }
    }
  }
  // The flashers' post: two red lamps side by side under the crossbuck, a bell on top.
  if (hitZ > 10.0) {
    float z = 10.0;
    float x = o.x * z / TRAIN_F + trainEyeOff.x - c + 4.3;
    float y = rise * z / TRAIN_F + trainEyeOff.y + 0.4;   // from the lamps' height
    vec2 la = vec2(x + 0.32, y);
    vec2 lb = vec2(x - 0.32, y);
    glow += TRAIN_SIGNAL * 0.5 * (flash.x * exp(-dot(la, la) / 0.5) + flash.y * exp(-dot(lb, lb) / 0.5));
    if (abs(x) < 1.2 && y < 1.6 && y > -3.0) {
      float aa = trainAA(z);
      float post = max(abs(x) - 0.07, y - 1.3);
      float plate = min(length(la) - 0.2, length(lb) - 0.2);
      float arms = max(min(abs(rotate(vec2(x, y - 0.75), 0.785).y), abs(rotate(vec2(x, y - 0.75), -0.785).y)) - 0.1, length(vec2(x, y - 0.75)) - 0.65);
      float bell = length(vec2(x, (y - 1.38) * 1.4)) - 0.12;
      float d = min(min(post, plate), min(arms, bell));
      if (trainSolid(d, aa) > 0.5) {
        hitZ = z;
        vec3 light = trainCarriageLight(z, y - 0.4) + trainAmbient * 0.6 + trainMoonLight * 0.2;
        col = vec3(0.1) * light * 2.0;
        if (arms <= d + 1e-4) {
          vec2 aq = vec2(x, y - 0.75);
          float band = step(0.5, fract(length(aq) / 0.22));
          col = mix(vec3(0.85, 0.83, 0.8), vec3(0.8, 0.1, 0.07), band) * (0.15 + light) + TRAIN_SIGNAL * 0.25 * (flash.x + flash.y);
        }
        float lampA = trainHard(1.0 - smoothstep(0.08, 0.13, length(la))) * flash.x;
        float lampB = trainHard(1.0 - smoothstep(0.08, 0.13, length(lb))) * flash.y;
        col = mix(col, TRAIN_SIGNAL * 1.6, max(lampA, lampB));
        accent = max(accent, max(lampA, lampB));
      }
    }
  }
  return col;
}

// Is there no pole line at d metres along the line: a tunnel, a bridge?
bool trainNoPoles(float d) {
  return (d > trainTunnel.x - 4.0 && d < trainTunnel.x + trainTunnel.y + 4.0) || (d > trainBridge.x - 10.0 && d < trainBridge.x + trainBridge.y + 10.0);
}

// The pole of a 64 m tile: set back 2..10 m into it.
float trainPoleAt(float id) {
  return 2.0 + 8.0 * trainHash(id, 260.0);
}

// Telegraph poles whipping past, blurred into soft smears and warm where the carriage's light
// catches them, a cross arm with glass insulators; and their three wires at slightly different
// distances, sagging between the poles, rising and dipping as the train runs.
vec3 trainPoles(vec2 o, float t, vec3 col, inout float hitZ) {
  if (hitZ < 3.3) return col;
  float tm = uMotionTime;
  float rise = o.y - TRAIN_HORIZON;
  float z = TRAIN_POLE_Z;
  float d = o.x * z / TRAIN_F + trainEyeOff.x;
  float y = rise * z / TRAIN_F + trainEyeOff.y;
  vec2 tl = trainTile(d, 64.0);
  float j0 = trainPoleAt(tl.x);
  float j1 = 64.0 + trainPoleAt(tl.x + 1.0);
  float xp = abs(tl.y - j0) < abs(tl.y - j1) ? j0 : j1;
  float poleD = d - tl.y + xp;
  float blur = trainV * TRAIN_SHUTTER;
  if (!trainNoPoles(poleD) && hitZ > 3.3) {
    float cellM = trainPx * z / TRAIN_F;
    float b = max(blur, cellM);
    float x = tl.y - xp;
    float cov = (clamp(x + 0.5 * b, -0.13, 0.13) - clamp(x - 0.5 * b, -0.13, 0.13)) / b * step(y, 2.3);
    // The cross arm, running out from us, and its insulators, drawn on screen.
    float ox = (poleD - trainEyeOff.x) * TRAIN_F;
    vec2 a = vec2(ox / 3.3, TRAIN_HORIZON + (1.62 - trainEyeOff.y) * TRAIN_F / 3.3);
    vec2 bb = vec2(ox / 4.3, TRAIN_HORIZON + (1.62 - trainEyeOff.y) * TRAIN_F / 4.3);
    float aaS = max(trainPx, 0.5 * blur * TRAIN_F / z);
    float arm = trainHard(clamp(0.5 - (segmentDistance(o, a, bb) - 0.06 * TRAIN_F / z) / aaS, 0.0, 1.0));
    float glass = 0.0;
    for (int i = 0; i < 3; i++) {
      float zw = 3.4 + 0.4 * float(i);
      vec2 at = vec2(ox / zw, TRAIN_HORIZON + (1.7 - trainEyeOff.y) * TRAIN_F / zw);
      glass = max(glass, trainHard(clamp(0.5 - (length((o - at) * vec2(1.0, 0.8)) - 0.05 * TRAIN_F / zw) / aaS, 0.0, 1.0)));
    }
    if (max(max(trainHard(cov), arm), glass) > 0.5) {
      hitZ = z;
      vec3 wood = wetten(vec3(0.14, 0.11, 0.08), trainWet, 0.6);
      vec3 light = trainCarriageLight(z, y) * 1.6 + trainEventLight(poleD, z, y, tm);
      vec3 c = trainLit(wood, vec3(0.0, 0.0, -1.0)) + wood * light + trainMoonLight * 0.05;
      c = mix(c, trainLit(TRAIN_SNOW, vec3(0.0, 1.0, 0.0)) + TRAIN_SNOW * light * 0.5, arm * trainLying * 0.8);
      if (glass > 0.5) c = vec3(0.3, 0.42, 0.38) * (0.2 + light) + trainMoonLight * 0.6;
      col = c;
    }
  }
  for (int i = 0; i < 3; i++) {
    float zw = 3.4 + 0.4 * float(i);
    if (zw > hitZ) break;
    float dw = o.x * zw / TRAIN_F + trainEyeOff.x;
    vec2 tw = trainTile(dw, 64.0);
    float a0 = trainPoleAt(tw.x);
    float pa = tw.y < a0 ? trainPoleAt(tw.x - 1.0) - 64.0 : a0;
    float pb = tw.y < a0 ? a0 : 64.0 + trainPoleAt(tw.x + 1.0);
    float u = (tw.y - pa) / (pb - pa);
    float sy = TRAIN_HORIZON + (1.72 - 3.4 * u * (1.0 - u) - trainEyeOff.y) * TRAIN_F / zw;
    float hw = max(0.9 * trainPx, 0.012 * TRAIN_F / zw);
    if (trainHard(clamp(0.5 + (hw - abs(o.y - sy)) / trainPx, 0.0, 1.0)) > 0.5 && !trainNoPoles(dw)) {
      hitZ = zw;
      col = vec3(0.025, 0.026, 0.03) + trainMoonLight * 0.12 + trainSunLight * 0.05;
    }
  }
  return col;
}

// A bridge's through truss right outside the window (the train slowed for it), verticals and
// diagonals whipping past as soft smears, warm where the carriage's light catches their flanges,
// dark against the misty valley beyond. A mountain line's stone viaduct has none: its parapet lies
// below the window, which looks straight out over the gorge.
vec3 trainTruss(vec2 o, vec3 col, inout float hitZ) {
  vec4 b = trainBridge;
  if (trainViaduct || b.x > 8.0 || b.x + b.y < -8.0) return col;
  float z = TRAIN_TRUSS_Z;
  float x = o.x * z / TRAIN_F + trainEyeOff.x - b.x;
  float y = (o.y - TRAIN_HORIZON) * z / TRAIN_F + trainEyeOff.y;
  if (x < -0.6 || x > b.y + 0.6) return col;
  float panel = 8.0;
  float k = floor(x / panel);
  float u = x - k * panel;
  float vert = min(abs(u), abs(u - panel)) - 0.18;
  vec2 from = vec2(0.0, mod(k, 2.0) < 0.5 ? -3.2 : 2.7);
  vec2 to = vec2(panel, from.y < 0.0 ? 2.7 : -3.2);
  float diag = segmentDistance(vec2(u, y), from, to) - 0.15;
  float ends = min(abs(x), abs(x - b.y)) - 0.3;
  float dist = min(min(vert, diag), ends);
  float aa = trainAA(z);
  if (trainSolid(dist, aa) < 0.5) return col;
  hitZ = z;
  vec3 steel = wetten(vec3(0.08, 0.09, 0.09), trainWet, 0.0);
  vec3 light = trainCarriageLight(z, y) * 1.4;
  vec3 c = trainLit(steel, vec3(0.0, 0.0, -1.0)) + steel * light;
  float flange = smoothstep(-0.07, 0.0, dist);
  c += light * 0.25 * flange + trainMoonLight * 0.08 * flange;
  c = mix(c, trainLit(TRAIN_SNOW, vec3(0.0, 1.0, 0.0)) + TRAIN_SNOW * light * 0.4, trainLying * 0.6 * step(diag, min(vert, ends)) * flange);
  return c;
}

// Into a tunnel: the rock walls of a cutting rising beside the line, then the portal and the dark
// wall streaming past an arm's length away, lit warm by the carriage's own windows, its mortar
// courses and cable runs holding still while the stone blurs, a lamp now and then flicking by.
vec3 trainTunnelScene(vec2 o, float t, vec3 col, inout float hitZ) {
  vec4 tn = trainTunnel;
  if (tn.x > 140.0 || tn.x + tn.y < -140.0) return col;
  float tm = uMotionTime;
  float rise = o.y - TRAIN_HORIZON;
  // The cutting, 4.6 m out.
  if (hitZ > TRAIN_CUT_Z) {
    float z = TRAIN_CUT_Z;
    float d = o.x * z / TRAIN_F + trainEyeOff.x;
    float y = rise * z / TRAIN_F + trainEyeOff.y;
    float into = d < tn.x + 0.5 * tn.y ? smoothstep(tn.x - 110.0, tn.x - 8.0, d) : smoothstep(tn.x + tn.y + 110.0, tn.x + tn.y + 8.0, d);
    // Out of the mouth straight onto a viaduct (or off one into the next mouth): none over the bridge.
    into *= 1.0 - step(trainBridge.x - 2.0, d) * step(d, trainBridge.x + trainBridge.y + 2.0);
    float rim = mix(-7.0, 14.0, into);
    if (trainPassCut < TRAIN_NO_CUT) {
      // The passage's own cutting: its rim by the passage's clock (rising into a tunnel, sinking out of one).
      into = 1.0;
      rim = trainPassCut;
    }
    float top = rim + 3.0 * (trainProfile(d, 16.0, z, 280.0, 2) - 0.5);
    if (into > 0.0 && trainSolid(y - top, trainAA(z)) > 0.5) {
      hitZ = z;
      float strata = 0.85 + 0.15 * sin(y * 5.0 + 2.0 * trainNoise(d, 64.0, 281.0));
      float blotch = mix(0.5, trainNoise(d, 8.0, 282.0), trainKeep(8.0, z));
      vec3 rock = wetten(vec3(0.16, 0.14, 0.12) * strata * (0.8 + 0.4 * blotch), trainWet, 0.2);
      vec3 light = trainCarriageLight(z, y) * 1.3 + trainEventLight(d, z, y, tm);
      vec3 c = trainLit(rock, vec3(0.0, 0.2, -0.98)) + rock * light;
      float ledge = smoothstep(0.55, 0.9, fract(y * 0.8 + blotch));
      c = mix(c, trainLit(TRAIN_SNOW, vec3(0.0, 1.0, 0.0)) + TRAIN_SNOW * light * 0.4, trainLying * ledge * 0.8);
      c = mix(c, vec3(0.02, 0.03, 0.02), smoothstep(top - 1.2, top - 0.2, y));
      col = c;
    }
  }
  // The tunnel's wall, 1.6 m out.
  float z = TRAIN_WALL_Z;
  float d = o.x * z / TRAIN_F + trainEyeOff.x;
  float x = d - tn.x;
  if (x < 0.0 || x > tn.y) return col;
  hitZ = z;
  float y = rise * z / TRAIN_F + trainEyeOff.y;
  float joint = abs(fract(y / 0.31) - 0.5) * 0.31;
  float course = 1.0 - 0.35 * smoothstep(0.131 - trainPx * z / TRAIN_F, 0.131, joint);
  float soot = mix(1.0, 0.45, smoothstep(0.2, 0.9, y));
  vec3 brick = vec3(0.13, 0.1, 0.08) * course * soot;
  vec3 light = trainCarriageLight(z, y) * 0.55 + trainEventLight(d, z, y, tm) + trainAmbient * 0.08;
  vec3 c = brick * light;
  float cables = 0.0;
  for (int i = 0; i < 3; i++) cables = max(cables, 1.0 - smoothstep(0.012, 0.012 + trainPx * z / TRAIN_F, abs(y - 0.42 - 0.08 * float(i))));
  c = mix(c, vec3(0.012), trainHard(cables) * 0.9);
  float portal = smoothstep(1.2, 0.6, min(x, tn.y - x));
  c = mix(c, vec3(0.3, 0.27, 0.24) * (light + 0.1 * (trainAmbient + trainMoonLight)), portal * 0.7);
  // a lamp now and then
  float k = mod(x, 48.0) - 24.0;
  float lamp = trainSolid(max(abs(k) - 0.22, abs(y - 0.1) - 0.1), trainAA(z));
  return mix(c, TRAIN_SODIUM * 1.3, lamp);
}

// Birds over the line's country by day (the shared birds, shaders/lib/birds.ts), flying in the
// window's own frame as the land is drawn: their kinds follow the line unless the knob picks one
// (rooks and geese over the country line; rooks, swallows, gulls and pigeons over the rural fields;
// choughs, swifts and a buzzard circling in the mountains), none at night, fewer in snow, none in
// steady rain; a swooping party comes down to a few metres over the fields. The nearest bird at o.
BirdHit trainBirds(vec2 o) {
  if (K_birds <= 0.0) return birdNone();
  float calm = smoothfall(0.5, 0.1, K_rain) * (1.0 - 0.5 * smoothstep(0.2, 0.8, K_snow));
  // Lanes from 40 m out to the hills, and from just over the horizon to near the window's top (uv.y).
  BirdSky sky = birdSky(K_birds * calm, K_birdKind, K_birdFormation - 1.0, vec2(40.0, 900.0), TRAIN_HORIZON + 0.5 + vec2(0.03, 0.3), vec2(trainSalt, 3.7 * K_line));
  sky.mixA = vec4(0.45, 0.1, 0.15, 0.2);
  sky.mixB = vec3(0.1, 0.0, 0.0);
  if (abs(K_line - TRAIN_RURAL) < 0.5) {
    sky.mixA = vec4(0.4, 0.25, 0.15, 0.05);
    sky.mixB = vec3(0.05, 0.1, 0.0);
  } else if (abs(K_line - TRAIN_MOUNTAIN) < 0.5) {
    sky.mixA = vec4(0.35, 0.0, 0.0, 0.05);
    sky.mixB = vec3(0.4, 0.0, 0.2);
  }
  sky.hours = vec4(0.22, 0.26, 0.8, 0.84);
  sky.clock = vec2(K_time, K_cycle);
  sky.swoopTo = 5.0;
  sky.parallax = trainEyeOff * TRAIN_F;
  BirdCamera cam = BirdCamera(TRAIN_HORIZON + 0.5, TRAIN_F, TRAIN_EYE, 1.0, 1.0);
  return birdFlights(vec2(o.x, o.y + 0.5), sky, cam, uMotionTime, trainPx);
}

// What the window shows at image point o: the land, the verge, then whatever passes close (station,
// crossing, cutting, poles, girders, a tunnel's wall), birds in the air in front of whatever lies
// beyond them, the glow of lights in the air, and the rain or snow falling through it all in depth,
// stopped by the first thing it meets.
vec3 trainOutside(vec2 o, vec2 rainUV, float aspect, float t, inout float accent) {
  float hitZ = 1e6;
  vec3 glow = vec3(0.0);
  float tm = uMotionTime;
  vec3 col = trainLand(o, t, hitZ, accent, glow);
  col = trainVerge(o, t, col, hitZ);
  col = trainStationScene(o, t, col, hitZ, accent, glow);
  col = trainCrossingScene(o, t, col, hitZ, accent, glow);
  col = trainTunnelScene(o, t, col, hitZ);
  col = trainPoles(o, t, col, hitZ);
  col = trainTruss(o, col, hitZ);
  BirdHit bird = trainBirds(o);
  if (bird.cover > 0.5 && bird.depth < hitZ) {
    hitZ = bird.depth;
    col = trainFade(trainLit(bird.albedo, vec3(0.0, 0.0, -1.0)), bird.depth, (o.y - TRAIN_HORIZON) * bird.depth / TRAIN_F + TRAIN_EYE);
  }
  col += glow * (1.0 + 1.5 * K_fog + 1.2 * max(K_rain, K_snow));
  if (hitZ <= TRAIN_WALL_Z + 0.01) return col;
  // The rain stops at whatever it meets first: the canopy's front edge shelters what lies under it.
  float rainZ = hitZ;
  float x6 = o.x * 6.0 / TRAIN_F + trainEyeOff.x - trainStation.x - 0.5 * trainStation.y;
  if (hitZ > 6.0 && abs(x6) < 26.0 && (o.y - TRAIN_HORIZON) * 6.0 / TRAIN_F + trainEyeOff.y < 1.3) rainZ = 6.0;
  float depth = rainZ > 1e5 ? 1.0 : 1.0 - exp(-rainZ / 30.0);
  // The air moving past the train slants rain and snow back; the wind adds its own.
  float wind = clamp(0.35 * K_wind - trainV / 22.0, -1.0, 1.0);
  // Rain and snow close by catch the carriage's light and the lamps passing.
  vec3 lamplit = trainCarriageLight(2.0, 0.0) * 0.6 + trainEventLight(o.x * 4.0 / TRAIN_F + trainEyeOff.x, 4.0, 0.0, tm) * 0.4;
  if (K_rain > 0.0) {
    Precip pr = rainFall(rainUV, aspect, t, K_rain, wind, depth);
    col = mix(col, trainAir * 1.05 + lamplit * 0.15, pr.veil);
    vec3 dropLight = max(vec3(0.9, 0.95, 1.0) * dot(trainAir, LUMA) * 1.2 + lamplit, vec3(0.08));
    col = mix(col, dropLight, pr.cover * (1.0 - pr.near));
  }
  if (K_snow > 0.0) {
    Precip ps = snowFall(rainUV, aspect, t, K_snow, wind, depth);
    vec3 air = mix(trainAir, TRAIN_SNOW * (dot(trainAmbient, LUMA) * 1.5 + 0.06), 0.5) + lamplit * 0.15;
    col = mix(col, air, ps.veil);
    col = mix(col, TRAIN_SNOW * (dot(trainAmbient + trainMoonLight, LUMA) * 1.3 + 0.1) + lamplit * 1.2, ps.cover * (1.0 - ps.near));
  }
  return col;
}

// ---- The pane ----

// Rain on the outside of the pane, driven back along the glass by the air the train pushes through:
// drops slide aft (left) and a little down, bigger ones faster, the faster the train runs the flatter
// their path, steeply down at a crawl; each wobbles along its own meander and leaves a trail of beads
// on the glass that dwindles away from the far end. Lanes of drops run along the path (a shear, so
// nothing turns when the train slows); drops come and go in their slots, a new one a fresh impact.
// q in screen heights. Returns xy refraction offset (screen heights), z drop cover, w bead cover.
vec4 trainPaneRain(vec2 q, float t, float amount) {
  if (amount <= 0.0) return vec4(0.0);
  float tm = uMotionTime;
  float push = 0.0095;
  float runB = trainBlockN * push * TRAIN_BLOCK;
  float runI = push * trainInto + 0.012 * tm;
  float slope = clamp(0.03 / (push * trainV + 0.004), 0.12, 1.3);
  float w = q.y - slope * q.x;
  vec4 o = vec4(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float big = layer == 0 ? 1.0 : 0.0;
    float laneH = mix(0.024, 0.046, big);
    float r0 = mix(0.0042, 0.0072, big);
    float lane = floor(w / laneH);
    float hl = hash12(vec2(lane, 17.0 + 9.0 * big));
    float sigma = mix(0.7, 1.15, big) * (0.75 + 0.5 * hl);
    float n = 6.0 + floor(6.0 * fract(hl * 7.3));
    float g = TRAIN_PANE_G / n;
    float u = q.x + mod(sigma * runB, TRAIN_PANE_G) + sigma * runI;
    float across = (fract(w / laneH) - 0.5) * laneH;
    float meander = laneH * (0.16 * sin(q.x * 19.0 + hl * 6.3) + 0.07 * sin(q.x * 47.0 + hl * 2.1));
    for (int j = 0; j < 2; j++) {
      float slot = floor(u / g) - float(j);
      float id = mod(slot, n);
      float hs = hash12(vec2(id + 0.37 * lane, lane * 0.13 + 3.0 * big));
      float cyc = tm / (4.0 + 5.0 * fract(hs * 5.3)) + hs;
      float age = fract(cyc);
      if (hash12(vec2(floor(cyc) + id * 1.7, lane + 7.0 * big)) > amount * mix(0.55, 0.4, big)) continue;
      float dx = u - (slot + 0.5 + 0.5 * (fract(hs * 3.1) - 0.5)) * g;
      float xd = q.x - dx;
      float md = laneH * (0.16 * sin(xd * 19.0 + hl * 6.3) + 0.07 * sin(xd * 47.0 + hl * 2.1));
      float r = r0 * (0.7 + 0.3 * fract(hs * 9.7)) * smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.8, 1.0, age));
      vec2 v = vec2(dx * (dx > 0.0 ? 0.55 : 0.85), across - md);
      float cov = 1.0 - smoothstep(0.7 * r, r, length(v));
      if (cov > o.z) o.xyz = vec3(-v * 2.6 * cov, cov);
      float trail = 0.6 * g;
      if (dx > r && dx < trail) {
        float bead = floor(q.x / 0.011);
        float bh = hash12(vec2(bead, lane + 31.0 * big));
        float kept = step(bh, 1.0 - dx / trail) * step(0.25, fract(bh * 7.7));
        vec2 bv = vec2((fract(q.x / 0.011) - 0.5 - 0.3 * (fract(bh * 3.3) - 0.5)) * 0.011, across - meander);
        o.w = max(o.w, (1.0 - smoothstep(0.0011, 0.0019, length(bv))) * kept);
      }
    }
  }
  return o;
}

// What the glass mirrors: the lit compartment behind you, as if beyond the window. The far wall's
// laminate in the lamp's pool, the luggage rack with a suitcase, the seat's back and its white
// headrest cloths, the door with the corridor's cool light, and you: head and shoulders, your face
// lit from the side by the reading lamp, leaning as you lean (the pointer). The lamp itself shows as
// a small bright bulb with the faint outline of its shade, trembling at each clack (jolt). The
// table and the glass of tea stand on the window's sill.
vec3 trainMirror(vec2 q, float aspect, float jolt, float teaX, inout float accent) {
  vec2 room = q + uPointer * vec2(0.012, 0.006);
  vec2 me = q - uPointer * vec2(0.05, 0.025) - vec2(0.12 * aspect, 0.0);
  vec2 lampAt = vec2(0.33 * aspect, 0.31);
  vec2 dl = (room - lampAt) * vec2(1.0, 1.3);
  float pool = K_lamp / (1.0 + dot(dl, dl) * 7.0);
  vec3 c = vec3(0.42, 0.28, 0.17) * (0.1 + 0.9 * pool) + vec3(0.02, 0.025, 0.035);
  // The rack: two bright rails, a suitcase on them.
  float rails = min(abs(room.y - 0.352), abs(room.y - 0.384)) - 0.003;
  c = mix(c, vec3(0.7, 0.65, 0.55) * (0.2 + pool), step(rails, 0.0) * step(abs(room.x), 0.46 * aspect));
  float suitcase = trainBox(room - vec2(-0.17 * aspect, 0.42), vec2(0.09 * aspect, 0.032), 0.006);
  if (suitcase < 0.0) c = vec3(0.3, 0.17, 0.09) * (0.15 + pool) + vec3(0.7, 0.55, 0.3) * pool * step(abs(abs(room.x + 0.17 * aspect) - 0.05 * aspect), 0.006) * step(room.y, 0.4);
  // The door: its frame, a pane of cool corridor light.
  float door = trainBox(room - vec2(-0.41 * aspect, 0.06), vec2(0.06 * aspect, 0.34), 0.008);
  if (door < 0.0) {
    c = vec3(0.3, 0.2, 0.12) * (0.1 + pool * 0.6);
    if (trainBox(room - vec2(-0.41 * aspect, 0.2), vec2(0.04 * aspect, 0.14), 0.01) < 0.0) c = vec3(0.16, 0.2, 0.24) * 0.8;
  }
  // The seat's back behind you: velour, white headrest cloths.
  vec2 sq = room - vec2(0.12 * aspect, 0.0);
  if (trainBox(sq, vec2(0.36 * aspect, 0.17), 0.05) < 0.0) {
    c = vec3(0.17, 0.09, 0.08) * (0.25 + 1.2 * pool);
    float slot = clamp(floor(sq.x / (0.26 * aspect) + 0.5), -1.0, 1.0);
    if (trainBox(sq - vec2(slot * 0.26 * aspect, 0.12), vec2(0.06, 0.045), 0.008) < 0.0) c = vec3(0.82, 0.8, 0.74) * (0.25 + 1.2 * pool);
  }
  // You: dark hair, a face lit from the lamp's side, a sweater with the lamp along one shoulder.
  vec2 hq = (me - vec2(0.0, 0.19)) / vec2(0.06, 0.078);
  float head = length(hq) - 1.0;
  float body = length((me - vec2(0.0, -0.01)) / vec2(0.2, 0.1)) - 1.0;
  float neck = max(abs(me.x) - 0.028, abs(me.y - 0.1) - 0.03) / 0.05;
  if (min(min(head, body), neck) < 0.0) {
    float lit = K_lamp * smoothstep(-0.6, 0.9, hq.x + 0.3 * hq.y);
    if (head < 0.0 || neck < 0.0) {
      c = vec3(0.55, 0.38, 0.3) * (0.2 + 1.5 * lit);
      if (head < 0.0 && hq.y > 0.45 - 0.25 * hq.x * hq.x) c = vec3(0.12, 0.08, 0.06) * (0.4 + lit);
      vec2 eye = vec2(abs(hq.x) - 0.36, hq.y - 0.05) / vec2(0.15, 0.07);
      c *= 1.0 - 0.35 * step(dot(eye, eye), 1.0);
    } else {
      c = vec3(0.2, 0.17, 0.2) * (0.25 + 0.6 * K_lamp) + TRAIN_LAMP * K_lamp * 0.5 * smoothstep(-0.25, 0.0, body) * smoothstep(0.0, 0.15, me.x);
    }
  }
  // The lamp: a small bright bulb, a soft glow, the faint outline of its shade above it.
  vec2 b = room - lampAt - vec2(0.0, jolt * 0.003);
  float r2 = dot(b, b);
  float core = 1.0 - smoothstep(0.0035, 0.006, sqrt(r2));
  float dome = length((b - vec2(0.0, 0.004)) / vec2(0.026, 0.022)) - 1.0;
  float rim = 1.4 * trainPx / 0.024;
  float shade = step(-0.002, b.y) * (1.0 - smoothstep(0.6 * rim, rim, abs(dome)));
  shade = max(shade, (1.0 - smoothstep(0.0012, 0.003, abs(b.y + 0.002))) * step(abs(b.x), 0.026));
  c += TRAIN_LAMP * K_lamp * (7.0 * core + 1.0 * exp(-r2 / 0.0004) + 1.6 * shade + 0.6 * step(dome, 0.0) * step(-0.002, b.y));
  accent = max(accent, core * K_lamp);
  // The table along the sill, and the glass of tea on it, a little further off.
  float sill = q.y + 0.22;
  if (sill < 0.035) c = mix(c, vec3(0.46, 0.27, 0.15) * (0.2 + 1.0 * K_lamp), smoothstep(0.035, 0.0, sill));
  vec2 tq = q - vec2(teaX + 0.015, -0.215);
  if (abs(tq.x) < 0.04 && tq.y > 0.0 && tq.y < 0.12) c = tq.y < 0.065 ? vec3(0.6, 0.58, 0.55) * (0.2 + K_lamp) : vec3(0.5, 0.2, 0.05) * (0.2 + K_lamp);
  return c;
}

// ---- The compartment ----

// The light falling into the compartment from outside at screen x: the sky and the moon, the
// lamps of whatever passes (the station's sweep across the table, the crossing's red, a tunnel's
// lamps flicking by).
vec3 trainSpill(float x, float tm) {
  vec3 s = (trainAmbient * 0.25 + trainMoonLight * 0.06 + trainSunLight * 0.35) * (1.0 - 0.85 * trainTunnelIn);
  float d = (x + TRAIN_F * trainLook) * 4.0 / TRAIN_F + trainEyeOff.x;
  return s + trainEventLight(d, 3.0, 0.0, tm) * 0.3;
}

// The glass of tea in its silver holder, seen a little from above: a faceted tea glass, deep amber
// tea up near the brim with a slice of lemon floating and a spoon standing in it, set in a silver
// openwork holder with a flared foot, a scalloped rim and a looped handle. q from the middle of the
// holder's foot (screen heights). The surface rings at every clack of the wheels (and at a knock on
// the table: a click), sloshes as the carriage rocks and brakes and holds the lamp's reflection; lit
// from behind (a station's lamps) the tea glows. light: the room's light here; back: the light
// behind it. Colour and cover.
vec4 trainTea(vec2 q, vec3 light, vec3 back, vec4 knock, float press, float slosh, float jolt) {
  float R = 0.056;      // the glass at its brim
  float k = 0.36;       // the ellipses' squash: how far we look down on it
  float hold = 0.104;   // the holder's height at the front
  float top = 0.19;     // the brim's middle
  float level = 0.166;  // the tea's middle
  float px = trainPx;
  float rx = R - 0.006 * clamp(1.0 - q.y / top, 0.0, 1.0);
  float hr = R + 0.005;
  float fr = hr + 0.009 * (1.0 - smoothstep(0.004, 0.02, q.y));
  float sqR = sqrt(max(1.0 - (q.x / R) * (q.x / R), 0.0));
  float sqH = sqrt(max(1.0 - (q.x / hr) * (q.x / hr), 0.0));
  float theta = asin(clamp(q.x / hr, -1.0, 1.0));
  // The holder, its foot flared and its upper edge scalloped; the handle, a D-shaped loop.
  float scallop = 0.005 * (0.5 + 0.5 * cos(theta * 14.0));
  float holder = max(abs(q.x) - fr, max(-k * fr * sqrt(max(1.0 - (q.x / fr) * (q.x / fr), 0.0)) - q.y, q.y - (hold - k * hr * sqH) - scallop));
  vec2 hq = q - vec2(hr + 0.02, 0.055);
  float handle = max(abs(length(hq / vec2(0.026, 0.038)) - 1.0) * 0.03 - 0.005, hr - 0.004 - q.x);
  // The glass, up to the far side of its brim.
  float glass = max(abs(q.x) - rx, max(0.02 - q.y, q.y - (top + k * R * sqR)));
  // The spoon: its handle out over the brim to the right, rattling at each clack.
  vec2 pivot = vec2(0.036, top);
  vec2 sp = rotate(q - pivot, jolt * 0.06) + pivot;
  float spoon = segmentDistance(sp, vec2(0.016, level), vec2(0.058, top + 0.075)) - max(0.0026, 1.1 * px);
  spoon = min(spoon, length((sp - vec2(0.06, top + 0.08)) / vec2(1.0, 1.5)) - 0.0055);
  float d = min(min(holder, glass), min(handle, spoon));
  float cover = smoothstep(px, -px, d);
  if (cover <= 0.0) return vec4(0.0);
  float alpha = cover;
  float u = clamp(q.x / rx, -1.0, 1.0);
  // The tea through the glass: deep amber, glowing where light comes through from behind.
  vec3 tea = vec3(0.55, 0.19, 0.04) * (0.18 + 0.5 * light) + vec3(1.0, 0.46, 0.12) * (back * 0.9 + light * 0.08);
  vec3 c;
  if (holder < 0.0 || handle < 0.0) {
    // Silver: bright toward the lamp (upper right), dark where it turns away, the window's cool
    // light on its far side; openwork arches showing the tea's glow, an engraved line round each;
    // plain bands at the foot and under the scalloped rim.
    float uh = theta / 1.5708;
    float vh = (q.y + k * hr * sqH) / hold;
    vec3 silver = vec3(0.74, 0.72, 0.68);
    c = silver * light * (0.22 + 0.8 * smoothstep(-0.75, 0.45, uh) * (1.0 - smoothstep(0.82, 1.0, uh)));
    c += vec3(1.0, 0.92, 0.8) * light * 0.9 * trainBell((uh - 0.42) / 0.09);
    c += back * 0.35 * smoothstep(-0.55, -0.95, uh);
    if (vh > 0.16 && vh < 0.82 && abs(uh) < 0.9) {
      vec2 f = vec2(fract(theta * 6.0 / 3.14159 + 0.5) - 0.5, (vh - 0.49) / 0.3);
      float arch = length(vec2(f.x / 0.3, f.y)) - 1.0;
      if (arch < 0.0) c = tea * (0.45 + 0.4 * sqH);
      else if (arch < 0.35) c *= 0.55;
    }
    if (handle < 0.0 && holder >= 0.0) {
      float side = smoothstep(-0.02, 0.03, hq.y + hq.x * 0.5);
      c = silver * light * (0.35 + 0.8 * side) + vec3(1.0, 0.92, 0.8) * light * 0.5 * trainBell((hq.x - 0.02) / 0.006);
    }
  } else {
    // The glass above the holder: its facets catching the lamp in thin upright lines, deep tea up to
    // its trembling level, clear glass above it with the window showing through.
    float facet = fract((asin(u) / 3.14159 + 0.5) * 9.0);
    float edgeLine = trainBell((facet - 0.5) / 0.08) * smoothstep(-0.2, 0.7, u);
    float line = level - k * (R - 0.004) * sqR + slosh * 0.25 * q.x;
    if (q.y < line) {
      c = tea * (0.55 + 0.45 * sqrt(1.0 - u * u)) * (0.92 + 0.08 * facet);
    } else {
      c = light * 0.06 + back * 0.12;
      alpha = cover * 0.3;
    }
    c += light * (0.4 * trainBell((u - 0.58) / 0.08) + 0.12 * trainBell((u + 0.86) / 0.06) + 0.18 * edgeLine);
  }
  // Over the brim, into the glass: the tea's surface, ringing at the clacks.
  vec2 sc = vec2(q.x, (q.y - level - slosh * 0.25 * q.x) / k) / (R - 0.004);
  float r = length(sc);
  if (r < 1.0 && holder > 0.0 && handle > 0.0 && q.y > hold) {
    float h = 0.0;
    float slope = 0.0;
    float beat = K_rhythm * smoothstep(0.5, 6.0, trainV);
    for (int i = 0; i < 4; i++) {
      float age = knock[i];
      float env = exp(-age * 4.5) * beat;
      float ph = TAU * (3.0 * (1.0 - r) - 7.0 * age);
      h += env * sin(ph);
      slope += env * cos(ph);
    }
    float pe = exp(-press * 3.0) * smoothstep(0.0, 0.05, press);
    h += 1.6 * pe * sin(TAU * (3.0 * (1.0 - r) - 5.0 * press));
    slope += 1.6 * pe * cos(TAU * (3.0 * (1.0 - r) - 5.0 * press));
    vec3 surface = (vec3(0.3, 0.1, 0.025) * (0.25 + 0.6 * light) + vec3(0.8, 0.32, 0.06) * back * 0.5) * (1.0 + 0.2 * h);
    // the lamp's reflection, broken by the rings, drifting as the tea sloshes
    vec2 hl = sc - vec2(0.38 - slosh * 0.6, 0.32) + normalize(sc + 1e-4) * slope * 0.12;
    surface += TRAIN_LAMP * K_lamp * 1.6 * trainHard(exp(-dot(hl, hl) / 0.03));
    // the slice of lemon: rind, pith, pulp in segments
    vec2 lq = sc - vec2(-0.3 + 0.05 * sin(slosh * 3.0), -0.08) - normalize(sc + 1e-4) * h * 0.02;
    float lr = length(lq) / 0.44;
    if (lr < 1.0) {
      float seg = abs(fract(atan(lq.y, lq.x) * 8.0 / TAU) - 0.5);
      vec3 pulp = vec3(0.98, 0.82, 0.3) * (1.0 - 0.3 * step(seg, 0.07) * step(0.15, lr));
      surface = (lr > 0.86 ? vec3(0.8, 0.75, 0.2) : (lr > 0.74 ? vec3(0.95, 0.93, 0.8) : pulp)) * (0.25 + 0.75 * light);
    }
    c = mix(surface, light * 0.85 + 0.04, smoothstep(0.9, 1.0, r) * 0.6);
    alpha = cover;
  }
  // The brim's lip; the spoon, standing out of the tea.
  float lipD = abs(length(vec2(q.x, (q.y - top) / k)) - R);
  c += (light * 0.7 + back * 0.3) * (1.0 - smoothstep(0.0018, 0.004, lipD)) * step(hold, q.y);
  if (spoon < 0.0 && sp.y > level + 0.003 && holder > 0.0) {
    float along = clamp((sp.y - level) / (top + 0.08 - level), 0.0, 1.0);
    c = vec3(0.78, 0.76, 0.72) * light * (0.55 + 0.6 * along) + TRAIN_LAMP * K_lamp * 0.3 * step(0.6, along);
    alpha = cover;
  }
  return vec4(c, alpha);
}

// Steam off the tea: three ribbons curling up, leaning with the carriage's rock and its braking,
// thinning into wisps. q from the middle of the brim.
float trainSteam(vec2 q, float tm, float amount, float lean) {
  if (amount <= 0.0 || q.y < 0.0 || q.y > 0.24 || abs(q.x) > 0.13) return 0.0;
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = (fi - 1.0) * 0.014 + (0.005 + 0.07 * q.y) * sin(q.y * 20.0 - tm * (1.0 + 0.25 * fi) + fi * 2.1) + lean * q.y * q.y * 5.0;
    float across = (q.x - x) / (0.007 + 0.03 * q.y);
    float wisps = smoothstep(0.3, 0.7, vnoise(vec2(q.y * 14.0 - tm * 0.4, fi * 5.3 + q.x * 22.0)));
    s += exp(-across * across) * mix(1.0, wisps, smoothstep(0.02, 0.1, q.y)) * (1.0 - 0.25 * fi);
  }
  return clamp(s * (1.0 - smoothstep(0.05, 0.08 + 0.14 * amount, q.y)) * smoothstep(0.0, 0.015, q.y) * (0.45 + 0.55 * amount), 0.0, 1.0);
}

// The curtain at the left of the window: deep red velvet on rings from a brass rod, gathered by a
// gold tie-back at the sill's height, its pleats fanning out above and below; the hem sways with the
// carriage's rocking and swings forward as the train brakes. Colour and cover.
vec4 trainCurtain(vec2 p, float aspect, float swing, vec3 light, vec3 spill) {
  float left = -0.5 * aspect;
  float tie = -0.02;
  float above = smoothstep(tie, 0.48, p.y);
  float below = smoothstep(tie, -0.3, p.y);
  float width = p.y > tie ? mix(0.105, 0.2, pow(above, 0.8)) : mix(0.105, 0.145, below);
  width *= aspect;
  float hang = swing * (0.35 * above + below * below);
  float edge = left + width + hang;
  float hem = -0.31 + 0.004 * sin((p.x - left) * 60.0);
  float d = max(p.x - edge, hem - p.y);
  float cover = trainSolid(d, trainPx);
  if (cover <= 0.0 || p.y > 0.49) return vec4(0.0);
  float u = clamp((p.x - left - hang * 0.5) / max(width, 1e-3), 0.0, 1.0);
  float folds = sin(u * 7.0 * TAU * 0.5 + 0.4 * sin(p.y * 3.0));
  float crest = 0.5 + 0.5 * folds;
  vec3 velvet = vec3(0.32, 0.05, 0.07);
  vec3 c = velvet * (0.35 + 0.65 * crest) * (light * (0.55 + 0.6 * u) + spill * 0.6 * u);
  c += vec3(0.6, 0.25, 0.25) * light * 0.12 * pow(crest, 6.0);
  c *= mix(1.0, 0.7, smoothstep(0.85, 1.0, u));
  // the tie-back: a gold cord round the gathered cloth, a tassel at the front
  float cord = abs(p.y - tie - 0.012 * (u - 0.5)) - 0.006;
  if (cord < 0.0) c = vec3(0.75, 0.55, 0.22) * light * (0.7 + 0.5 * crest);
  vec2 tq = p - vec2(edge - 0.008, tie - 0.03);
  if (trainBox(tq, vec2(0.006, 0.02), 0.004) < 0.0) c = vec3(0.8, 0.58, 0.24) * light;
  return vec4(c, cover);
}

// The table under the window: walnut veneer, its grain running along it, warm in the reading lamp's
// pool, the window's light along its back edge and a soft gleam of the lamp in the varnish. The glass
// of tea casts its shadow back toward the window with a little amber light through the tea at its
// heart; a train ticket lies there (the railway's red band, the route and fare printed, a violet
// date stamp, a perforated stub, a punched hole) beside two wrapped sugar lumps. depth: 0 at the
// front edge .. 1 at the window.
vec3 trainTableTop(vec2 p, float aspect, float depth, vec3 room, vec3 spill, vec2 teaFoot) {
  float grain = 0.8 + 0.2 * vnoise(vec2(p.x * 5.0 + 3.0 * vnoise(vec2(p.x * 1.7, p.y * 25.0)), p.y * 150.0));
  vec3 wood = vec3(0.46, 0.26, 0.13) * grain;
  vec2 pc = (p - vec2(0.24 * aspect, -0.33)) / vec2(0.38 * aspect, 0.15);
  vec3 lit = room + TRAIN_LAMP * K_lamp * 1.4 * exp(-dot(pc, pc));
  vec3 c = wood * lit;
  vec2 gq = (p - vec2(0.3 * aspect, -0.29)) / vec2(0.1, 0.022);
  c += TRAIN_LAMP * K_lamp * 0.2 * exp(-dot(gq, gq));
  c += spill * 0.45 * smoothstep(0.55, 1.0, depth);
  if (K_tea > 0.0) {
    vec2 sv = (p - teaFoot - vec2(-0.05, 0.024)) / vec2(0.09, 0.026);
    c *= 1.0 - 0.5 * smoothstep(1.0, 0.4, length(sv));
    vec2 cv = (p - teaFoot - vec2(-0.045, 0.022)) / vec2(0.032, 0.01);
    c += vec3(1.0, 0.45, 0.1) * K_lamp * 0.35 * exp(-dot(cv, cv));
  }
  // The ticket.
  vec2 kq = rotate(p - vec2(-0.07 * aspect, -0.35), 0.14);
  if (trainBox(kq, vec2(0.062, 0.03), 0.003) < 0.0) {
    vec3 paper = vec3(0.88, 0.84, 0.7);
    vec3 ink = paper;
    if (kq.y > 0.015) {
      // the railway's red band, white lettering across it
      ink = mix(vec3(0.72, 0.16, 0.1), paper, step(abs(kq.y - 0.0225), 0.0028) * step(0.4, fract(kq.x / 0.009)) * step(abs(kq.x + 0.01), 0.04));
    } else {
      float row = (kq.y + 0.027) / 0.0085;
      float reach = 0.028 - 0.03 * fract(floor(row) * 0.37);
      float printed = step(0.35, fract(row)) * step(fract(row), 0.72) * step(kq.x, reach) * step(-0.054, kq.x) * step(row, 4.9);
      ink = mix(paper, vec3(0.18, 0.16, 0.2), printed * 0.85);
      float stamp = abs(length(kq - vec2(0.036, -0.008)) - 0.012) - 0.0019;
      ink = mix(ink, vec3(0.42, 0.28, 0.6), step(stamp, 0.0) * 0.85);
    }
    if (abs(kq.x - 0.046) < 0.0012 && fract(kq.y / 0.005) > 0.5) ink *= 0.65;
    c = ink * lit;
    if (length(kq - vec2(-0.05, -0.016)) < 0.0045) c = wood * lit * 0.85;
  } else {
    c *= 1.0 - 0.35 * smoothstep(0.005, 0.0, trainBox(kq - vec2(-0.004, 0.004), vec2(0.062, 0.03), 0.003));
  }
  // Two sugar lumps in their wrappers: a lit top, a shaded front, a blue band over both, a red mark.
  for (int i = 0; i < 2; i++) {
    vec2 bq = p - teaFoot - vec2(-0.112 - 0.036 * float(i), -0.006 + 0.014 * float(i));
    float topFace = trainBox(bq - vec2(0.0, 0.008), vec2(0.017, 0.007), 0.002);
    float frontFace = trainBox(bq + vec2(0.0, 0.004), vec2(0.017, 0.006), 0.0015);
    if (min(topFace, frontFace) < 0.0) {
      bool upper = topFace < 0.0;
      vec3 wrap = abs(bq.x) < 0.004 ? vec3(0.2, 0.32, 0.62) : vec3(0.92, 0.9, 0.86);
      if (upper && length(bq - vec2(0.009, 0.009)) < 0.0025) wrap = vec3(0.75, 0.15, 0.12);
      c = wrap * lit * (upper ? 1.05 : 0.62);
    } else {
      c *= 1.0 - 0.3 * smoothstep(0.006, 0.0, trainBox(bq - vec2(-0.006, 0.008), vec2(0.019, 0.012), 0.004));
    }
  }
  return c;
}

// This cell's journey, sky and light, and the line's swing: the globals everything outside reads.
void trainSetup(vec2 cell, float t) {
  trainPx = 1.0 / uRes.y;
  trainTh = threshold(cell);
  trainRead(t);
  trainLine();
  trainSalt = mod(K_route, 1000.0) * 0.731;
  trainPassage();

  // The sky and the light it gives. Rain or snow closes it over: the moon fades behind the deck,
  // the light flattens, the lamps count for more.
  trainSky = skyMoonPhase(skyAt(timeOfDayM(K_time, K_cycle, uMotionTime)), K_moon);
  trainStorm = clamp(max(K_rain, 0.85 * K_snow), 0.0, 1.0);
  trainOver = clamp(trainStorm * 10.0, 0.0, 1.0) * (0.65 + 0.35 * trainStorm);
  trainWet = uWeather.x;
  trainLying = uWeather.y;
  vec2 mc = rotate(trainSky.moon.xz, -TRAIN_YAW);
  trainMoonC = vec3(mc.x, trainSky.moon.y, mc.y);
  vec2 sc = rotate(trainSky.sun.xz, -TRAIN_YAW);
  trainSunC = vec3(sc.x, trainSky.sun.y, sc.y);
  // By night the eye adapts: moonlight counts for more and a cool skylight lifts the land, so
  // moonlit stubble reads around 0.25, plain fields 0.1 and snow a pale blue, while hedges and woods
  // stay silhouettes against the moonlit band low in the sky.
  trainMoonLight = trainSky.moonColor * (1.0 - 0.8 * trainOver) * 3.0;
  trainSunLight = trainSky.sunColor * (1.0 - 0.8 * trainOver);
  trainAmbient = mix(trainSky.ambient, vec3(dot(trainSky.ambient, LUMA)), 0.5 * trainOver) * (1.0 - 0.35 * trainStorm)
               + trainSky.night * vec3(0.12, 0.14, 0.2) * (1.0 - 0.4 * trainOver);
  trainLampsOn = clamp(1.0 - trainSky.day * (1.0 - 0.45 * trainStorm), 0.0, 1.0);
  vec2 hz = rotate(vec2(0.0, 1.0), TRAIN_YAW);
  vec3 hzDir = normalize(vec3(hz.x, 0.03, hz.y));
  trainAir = skyColor(trainSky, hzDir) + trainNightGlow(hzDir);
  trainAir = mix(trainAir, vec3(dot(trainAir, LUMA)) * vec3(0.92, 0.95, 1.0), 0.7 * trainOver) * (1.0 - 0.25 * trainStorm);
  trainAir += trainMoonLight * 0.05 + vec3(0.02, 0.022, 0.03) * K_fog;

  // The line's gentle curves: the view swings slowly across the sky (the moon drifts, the stars
  // wheel) and the carriage leans into each curve.
  float sw = trainS / 1900.0 + trainSalt;
  float sw2 = trainS / 730.0 + 2.0 * trainSalt;
  trainLook = 0.16 * sin(sw) + 0.07 * sin(sw2);
  trainRoll = 60.0 * (0.16 / 1900.0 * cos(sw) + 0.07 / 730.0 * cos(sw2));
  trainEyeOff = uPointer * vec2(0.25, 0.1);
  trainTunnelIn = trainTunnel.x < 0.0 && trainTunnel.x + trainTunnel.y > 0.0 ? smoothstep(0.0, 3.0, -trainTunnel.x) * smoothstep(0.0, 3.0, trainTunnel.x + trainTunnel.y) : 0.0;
}

Shade sceneTrain(vec2 uv, vec2 cell, float t) {
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  Shade o = blankShade();
  trainSetup(cell, t);

  // The rails' rhythm: seconds since each of the carriage's four axles last crossed a joint, and
  // what that does: a jolt, the carriage's slow rock.
  vec4 knock = mod(vec4(trainInto) - vec4(0.0, 2.6, 17.4, 20.0), TRAIN_JOINT) / max(trainV, 0.3);
  float beat = K_rhythm * smoothstep(0.5, 6.0, trainV);
  float jolt = 0.0;
  for (int i = 0; i < 4; i++) jolt += exp(-knock[i] * 14.0) * sin(knock[i] * 70.0);
  jolt *= 0.5 * beat;
  jolt += trainPassRattle;
  float press = t - uMouse.w;
  if (trainPassAge >= 0.0) press = min(press, trainPassAge);
  float rock = (0.3 + 0.7 * K_rhythm) * smoothstep(1.0, 10.0, trainV) * (0.6 * sin(tm * 1.7 + 0.8 * sin(tm * 0.23)) + 0.4 * sin(tm * 2.9 + 1.3));
  float brake = clamp(-trainAcc, -1.5, 1.5);

  // The window: a big pane with rounded corners in a cream-enamelled frame.
  vec2 gC = vec2(0.0, 0.1);
  vec2 gH = vec2(0.4 * aspect, 0.32);
  float gR = 0.075;
  float sdG = trainBox(p - gC, gH, gR);
  float teaX = 0.22 * aspect;
  vec2 teaFoot = vec2(teaX, -0.395);

  // The compartment's light: the reading lamp above and to the right, a little night light, and
  // what comes in through the window.
  vec3 spill = trainSpill(p.x, tm);
  vec2 lampAt = vec2(0.42 * aspect, 0.74);
  vec2 dl = (p - lampAt) * vec2(0.8, 1.0);
  float nearWin = smoothstep(0.35, 0.0, sdG);
  vec3 room = TRAIN_LAMP * K_lamp * 1.25 / (1.0 + dot(dl, dl) * 3.0) + vec3(0.025, 0.028, 0.04) + spill * (0.3 + 0.7 * nearWin);

  vec3 col = vec3(0.0);
  float accent = 0.0;
  if (sdG < 0.0) {
    // Through the glass: rain driven along it, refracting what lies behind each drop.
    float streaks = K_rain * K_streaks * (1.0 - smoothstep(0.0, 60.0, -trainTunnel.x) * smoothstep(0.0, 60.0, trainTunnel.x + trainTunnel.y));
    vec4 pane = trainPaneRain(p, t, streaks);
    float drop = trainHard(pane.z);
    float bead = trainHard(pane.w) * (1.0 - drop);
    vec2 at = p + pane.xy * drop;
    vec2 ctr = vec2(0.0, TRAIN_HORIZON);
    vec2 img = rotate(at - ctr, trainRoll) + ctr + vec2(TRAIN_F * trainLook, 0.0);
    vec2 rainUV = vec2(at.x / aspect + 0.5, at.y + 0.5);
    col = trainOutside(img, rainUV, aspect, t, accent);
    // Snow banked on the outside of the pane along its foot, deepest in the corners.
    if (trainLying > 0.0) {
      float corner = min(p.x + gH.x, gH.x - p.x);
      float h = (0.004 + 0.02 * exp(-corner / 0.06)) * snowCover(vec3(0.0, 1.0, 0.0), vec2(p.x * 14.0, 0.3), trainLying);
      float bank = trainHard(clamp((gC.y - gH.y + h - p.y) / trainPx + 0.5, 0.0, 1.0)) * step(0.0005, h);
      col = mix(col, TRAIN_SNOW * (dot(trainAmbient + trainMoonLight, LUMA) * 1.2 + 0.05) + room * 0.25, bank);
      accent *= 1.0 - bank;
    }
    // The pane: a little light lost; the drops gather light, darken at the rim and catch the lamp;
    // the beads of their trails glint.
    float ring = 4.0 * pane.z * (1.0 - pane.z) * drop;
    col *= 0.9 * (1.0 + 0.35 * drop - 0.5 * ring);
    float side = smoothstep(0.1, 0.9, dot(normalize(-pane.xy + 1e-6), vec2(0.707, 0.707)));
    col += TRAIN_LAMP * K_lamp * 0.6 * ring * side + room * 0.08 * drop;
    col = mix(col, col * 1.2 + TRAIN_LAMP * K_lamp * 0.12 + dot(trainAir, LUMA) * 0.4, bead * 0.8);
    // The compartment, mirrored in the glass: faint over the night, a mirror in a tunnel.
    float mirrorK = 0.22 * K_reflection * (1.0 + 4.0 * trainTunnelIn);
    float macc = 0.0;
    col += trainMirror(p, aspect, jolt, teaX, macc) * mirrorK;
    accent = max(accent * 0.85, macc * min(mirrorK * 8.0, 1.0));
  } else {
    vec3 up = vec3(0.0, 1.0, 0.0);
    if (sdG < 0.007) {
      // the rubber seal
      col = vec3(0.02) + room * 0.03;
    } else if (sdG < 0.045) {
      // The frame: a rounded bead of enamel, lit from the lamp above right, its inner lip catching
      // the light from outside.
      float e = 0.002;
      vec2 g = normalize(vec2(trainBox(p - gC + vec2(e, 0.0), gH, gR) - trainBox(p - gC - vec2(e, 0.0), gH, gR),
                              trainBox(p - gC + vec2(0.0, e), gH, gR) - trainBox(p - gC - vec2(0.0, e), gH, gR)) + 1e-6);
      float u = (sdG - 0.007) / 0.038;
      vec3 n = normalize(vec3(g * cos(u * 3.14159 - 1.57), 0.6 + sin(u * 3.14159)));
      vec3 toLamp = normalize(vec3(0.5, 0.6, 0.6));
      float diff = max(dot(n, toLamp), 0.0);
      col = vec3(0.72, 0.68, 0.58) * (room * (0.35 + 0.8 * diff) + spill * 0.4 * smoothstep(0.4, 0.0, u));
      col += TRAIN_LAMP * K_lamp * 0.25 * pow(max(dot(reflect(-toLamp, n), vec3(0.0, 0.0, 1.0)), 0.0), 12.0);
      // the brass catch at the top of the frame
      vec2 cq = p - vec2(0.0, gC.y + gH.y + 0.024);
      if (trainBox(cq, vec2(0.035, 0.007), 0.004) < 0.0) col = vec3(0.8, 0.6, 0.3) * (room * 1.1 + 0.03);
    } else {
      // The wall: warm wood-grain laminate, a seam at each panel's edge.
      float grain = 0.88 + 0.12 * vnoise(vec2(p.x * 3.0 + 4.0 * vnoise(vec2(p.x * 1.5, p.y * 20.0)), p.y * 90.0));
      col = vec3(0.36, 0.22, 0.13) * grain * room;
      col *= 1.0 - 0.5 * step(abs(abs(p.x) - (gH.x + 0.11)), 0.0025);
      // the curtain rod
      if (abs(p.y - 0.478) < 0.0045 && p.x < 0.46 * aspect) col = vec3(0.75, 0.55, 0.25) * (room * 1.2 + 0.02) * (0.7 + 0.5 * smoothstep(0.0045, -0.002, p.y - 0.478));
      // The table under the window: walnut veneer with an aluminium edge.
      float tx = p.x - 0.03 * aspect;
      float tableW = 0.34 * aspect;
      if (p.y < gC.y - gH.y - 0.04 && p.y > -0.445 && abs(tx) < tableW) {
        float depth = clamp((p.y + 0.425) / (gC.y - gH.y - 0.04 + 0.425), 0.0, 1.0);
        float cornerD = trainBox(vec2(tx, p.y + 0.36), vec2(tableW, 0.085), 0.03);
        if (cornerD < 0.0 || p.y > -0.36) {
          if (p.y > -0.425) {
            col = trainTableTop(p, aspect, depth, room, spill, teaFoot);
          } else {
            // the chrome edge, a line of lamp light along it
            col = vec3(0.55, 0.55, 0.56) * room * 0.6 + TRAIN_LAMP * K_lamp * 0.35 * smoothstep(0.004, 0.0, abs(p.y + 0.43));
          }
        }
      } else if (p.y < -0.445 && abs(tx) < tableW + 0.02) {
        col *= 0.45;
      }
    }
  }

  // The glass of tea, its steam over the window.
  if (K_tea > 0.0) {
    // It stands in the lamp's pool on the table.
    vec4 tea = trainTea(p - teaFoot, room + TRAIN_LAMP * K_lamp * 0.9, spill, knock, press, brake * 0.5 + rock * 0.08 + trainPassSlosh, jolt);
    col = mix(col, tea.rgb, tea.a);
    accent *= 1.0 - tea.a;
    float steam = trainSteam(p - teaFoot - vec2(0.0, 0.2), tm, K_tea, 0.4 * rock + 0.6 * brake + 0.5 * trainPassSlosh);
    col += (vec3(0.78, 0.74, 0.7) * (0.25 + 0.6 * K_lamp) + spill * 0.25) * steam * 0.7;
  }

  // The curtain: it rocks with the carriage, swings forward as the train brakes, shivers at a clack.
  if (K_curtain > 0.0) {
    vec4 curtain = trainCurtain(p, aspect, (0.012 * rock + 0.02 * brake + 0.008 * jolt + 0.03 * trainPassSlosh) * K_curtain * 2.0, room, spill);
    col = mix(col, curtain.rgb, curtain.a);
    accent *= 1.0 - curtain.a;
  }

  col *= 1.0 - 0.3 * smoothstep(0.5, 1.05, length((uv - 0.5) * vec2(1.25, 1.0)));
  o.rgb = col;
  o.source = col;
  o.ink = clamp(pow(max(dot(col, LUMA), 0.0), 0.8) * 1.2, 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  return o;
}
`;
