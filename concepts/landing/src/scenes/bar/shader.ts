// A quiet bar late at night, seen from a corner booth.
//
// World units are metres: x right, y up, z ahead, the eye BAR_EYE over the floor at x = 0, a
// pinhole of focal length BAR_F (screen heights); narrow frames pan toward the window. The pointer
// moves the eye a few centimetres (barEye), so the depths part as it moves (BAR_FOCUS stays put).
//
// Left: the front wall (BAR_WIN_Z) and its tall storefront window onto the street. Across the way
// a laundromat lit cold and white (one machine tumbling, someone waiting with a book), a doorway
// under its lamp, a closed bookshop's night light, flats above whose windows light and darken over
// minutes, a street lamp; the bar's own striped awning overhead, dripping from its scallops. Cars
// crawl past in both lanes, their lamps running down the wet road and the near lane's headlamps
// smearing across the wet glass; people go by under umbrellas, lit warm by the window (bare-headed
// under the awning, where no rain falls). Rain falls out there only (the shared
// rainFall, against the street's own depth), lit by the lamp, the headlamps and the bar's light;
// the road pools, rings and splashes. On the pane: beads and sliding drops (glassDrops, each a
// small lens holding the street's light), mist low down, the jukebox behind you reflected, and the
// neon OPEN sign hanging inside, read from behind (NEPO). A column holds a coat and a wet umbrella
// dripping into a small puddle, under a little sconce.
//
// Right: the room. A pressed-tin ceiling, a slow fan under its bowl light sweeping the blades'
// shadows round the tin; four green pendants over a long counter with a leather rail and a brass
// foot rail; the back bar: carved pilasters behind the lamps, a mirror (leaning forward a little,
// so it shows the room a touch higher: the lamps, the window with OPEN reading the right way round,
// the faces of the people at the bar), two glass shelves of bottles out of focus, glowing amber,
// green and ruby where the lamps catch them, their glints round bokeh discs; the back counter's
// glasses and a brass till; the Manifold M etched in the upper mirror or hung there in amber neon.
// The bartender works behind the counter and the patrons sit, come and go (sim.ts schedules it:
// uSim0). In the foreground your table: a candle in amber glass, a coffee steaming, a whisky with
// ice catching the light and throwing an amber caustic.
//
// Flicker: everything that moves (people, the bartender and what he holds, cars, passers-by, the
// fan's blades and their shadows, moving lights and their reflections) is cut against the cell's
// dither threshold (hardEdge), so a passing edge flips a cell once, all channels together; moving
// bodies are flat inside or banded along their motion. Everything else is still or changes slowly.
// No shimmer.
//
// Passage: you sit down in the booth (the eye starts a little high and looking toward the door,
// lowers and turns to rest with a little give; the bartender looks up from his glass and nods; the
// fan, spun up in sim.ts, starts turning; the lamps warm on a touch) and, leaving, stand (the eye
// rises and turns to the door; he gives a small wave). The pane's drops and the rain move with the
// window. At rest every term is exactly zero or one.
//
// A preset of the `interior` composer (layers.ts): the shared chunk below holds the room in metres,
// every shape and the cell's state (barBegin); each layer's passes draw its part of the room on the
// bar's own frame (barP), in the order the original scene painted them.
//
// Knobs: K_night (the sim thins the room; here the lamps dim and OPEN goes dark at last call),
// K_patrons and K_bartender (sim), K_warmth, K_bokeh, K_fan (the sim turns it), K_candle, K_steam,
// K_whisky, K_traffic, K_sign, K_jukebox, K_rain, K_wind, K_drops, K_mark. Triggers, numbered by
// the composer: TRIGGER_traffic a taxi, TRIGGER_jukebox a new record, TRIGGER_mark the M (the sim
// reads its own: a cocktail, a newcomer, last call). Last call (barMisc.w, seconds since it was
// called): the bartender's bell (ACT.bell), the lamps blinking twice, then closing time: the lamps,
// the shelf glow and OPEN as at CLOSING_NIGHT.
import type { SharedGlsl } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { PASSAGE } from "./constants.ts";
import {
  ACT,
  BARTENDER_Z,
  BELL_TIME,
  BLINK_OFF,
  BLINKS,
  CANDLE_X,
  CANDLE_Y,
  CANDLE_Z,
  CARRY,
  CLEAR_TAKE,
  CLOSING_NIGHT,
  DOOR_X,
  EYE,
  FAN_FAST,
  FAN_SLOW,
  FETCH_GRAB,
  FOCAL,
  GLASS_OFFSET,
  GLASS_Z,
  HORIZON,
  PAN_FROM,
  PAN_RATE,
  POUR_FLOW,
  POUR_REACH,
  POUR_SET,
  PUT_RELEASE,
  SLOT_W,
  SLOT_X0,
  STOOL_X,
  STOOL_Z,
  STRAIN_FLOW,
  STRAIN_SET,
  TABLE_EYE,
  WALK_Z,
} from "./sim.ts";

const barShared = `
// ---- Shared with the simulation (sim.ts)

const float BAR_F = ${glslFloat(FOCAL)};
const float BAR_EYE = ${glslFloat(EYE)};
const float BAR_HORIZON = ${glslFloat(HORIZON)};
const float BAR_TABLE_EYE = ${glslFloat(TABLE_EYE)};
const float BAR_PAN_FROM = ${glslFloat(PAN_FROM)};
const float BAR_PAN_RATE = ${glslFloat(PAN_RATE)};
const float BAR_STOOL_X[4] = float[4](${STOOL_X.map(glslFloat).join(", ")});
const float BAR_STOOL_Z = ${glslFloat(STOOL_Z)};
const float BAR_WALK_Z = ${glslFloat(WALK_Z)};
const float BAR_DOOR_X = ${glslFloat(DOOR_X)};
const float BAR_GLASS_Z = ${glslFloat(GLASS_Z)};
const float BAR_GLASS_OFFSET = ${glslFloat(GLASS_OFFSET)};
const float BAR_BT_Z = ${glslFloat(BARTENDER_Z)};
const float BAR_POUR_REACH = ${glslFloat(POUR_REACH)};
const float BAR_SLOT_W = ${glslFloat(SLOT_W)};
const float BAR_SLOT_X0 = ${glslFloat(SLOT_X0)};
const vec3 BAR_CANDLE = vec3(${glslFloat(CANDLE_X)}, ${glslFloat(CANDLE_Y)}, ${glslFloat(CANDLE_Z)});
const float BAR_FAN_SLOW = ${glslFloat(FAN_SLOW)};
const float BAR_FAN_FAST = ${glslFloat(FAN_FAST)};
const int BAR_POLISH = ${ACT.polish};
const int BAR_WALK = ${ACT.walk};
const int BAR_CHAT = ${ACT.chat};
const int BAR_FETCH = ${ACT.fetch};
const int BAR_POUR = ${ACT.pour};
const int BAR_PUT = ${ACT.put};
const int BAR_SHAKE = ${ACT.shake};
const int BAR_STRAIN = ${ACT.strain};
const int BAR_WIPE = ${ACT.wipe};
const int BAR_CLEAR = ${ACT.clear};
const int BAR_BELL = ${ACT.bell};
const float BAR_BELL_TIME = ${glslFloat(BELL_TIME)};
const float BAR_BLINK0 = ${glslFloat(BLINKS[0])};
const float BAR_BLINK1 = ${glslFloat(BLINKS[1])};
const float BAR_BLINK_OFF = ${glslFloat(BLINK_OFF)};
const float BAR_CLOSING_NIGHT = ${glslFloat(CLOSING_NIGHT)};
const float BAR_CARRY_BOTTLE = ${glslFloat(CARRY.bottle)};
const float BAR_CARRY_SHAKER = ${glslFloat(CARRY.shaker)};
const float BAR_CARRY_GLASS = ${glslFloat(CARRY.glass)};
const float BAR_FETCH_GRAB = ${glslFloat(FETCH_GRAB)};
const float BAR_PUT_RELEASE = ${glslFloat(PUT_RELEASE)};
const float BAR_POUR_SET = ${glslFloat(POUR_SET)};
const float BAR_POUR_FLOW0 = ${glslFloat(POUR_FLOW[0])};
const float BAR_POUR_FLOW1 = ${glslFloat(POUR_FLOW[1])};
const float BAR_STRAIN_SET = ${glslFloat(STRAIN_SET)};
const float BAR_STRAIN_FLOW0 = ${glslFloat(STRAIN_FLOW[0])};
const float BAR_STRAIN_FLOW1 = ${glslFloat(STRAIN_FLOW[1])};
const float BAR_CLEAR_TAKE = ${glslFloat(CLEAR_TAKE)};
const float BAR_ENTER = ${glslFloat(PASSAGE.enter)};
const float BAR_EXIT = ${glslFloat(PASSAGE.exit)};

// ---- The room (m)

const float BAR_PI = 3.14159265;
const float BAR_FOCUS = 3.0;        // the depth that stays put when the pointer moves the eye
const float BAR_CEIL = 3.0;
const float BAR_WIN_Z = 2.6;        // the front wall and its window
const float BAR_WIN_X0 = -3.2;      // the glass's left edge (off the frame at 16:9) and right edge
const float BAR_WIN_X1 = -1.62;
const float BAR_WIN_Y0 = 0.45;
const float BAR_WIN_Y1 = 2.55;
const float BAR_MULLION_X = -2.38;
const float BAR_TRANSOM_Y = 2.12;
const float BAR_COL_Z = 2.55;       // the column between the window and the bar
const float BAR_COL_X0 = -1.56;
const float BAR_COL_X1 = -1.3;
const vec2 BAR_SCONCE = vec2(-1.43, 2.2);
const vec3 BAR_SIGN = vec3(-1.97, 1.75, 2.55); // the OPEN sign's centre, hanging inside the glass
const float BAR_COUNTER_Z = 3.1;    // the counter's front
const float BAR_COUNTER_X0 = -1.25;
const float BAR_EDGE_Z = 3.06;      // the counter top's rounded front edge, overhanging the front
const float BAR_EDGE_Y0 = 1.02;
const float BAR_TOP_Y = 1.08;       // the counter top, polished, back to BAR_TOP_Z1
const float BAR_TOP_Z1 = 3.75;
const float BAR_FOOT_Y = 0.22;      // the brass foot rail
const float BAR_FOOT_Z = 2.92;
const float BAR_LAMP_X0 = -0.35;    // four pendants BAR_LAMP_DX apart, their mouths at BAR_LAMP_Y
const float BAR_LAMP_DX = 1.3;
const float BAR_LAMP_Y = 2.0;
const float BAR_LAMP_Z = 3.4;
const float BAR_BACK_Z = 4.6;       // the mirror wall
const float BAR_SHELF_Z = 4.5;      // the bottles on the shelves
const float BAR_SHELF_Y0 = 1.38;
const float BAR_SHELF_Y1 = 1.78;
const float BAR_UPPER_Y = 2.15;     // the upper mirror's foot
const float BAR_CORNICE_Y = 2.62;
const float BAR_BACKBAR_X0 = -1.9;
const vec3 BAR_MARK = vec3(2.165, 2.37, 0.26); // the M on the upper mirror: x, y, height (m)
const float BAR_MIRROR_SHIFT = 0.105; // the mirror leans forward: what it shows sits this much higher (screen heights)
const vec3 BAR_FAN = vec3(0.55, 2.5, 2.85); // the blades' plane at the hub
const float BAR_FAN_LAMP_Y = 2.3;   // its frosted bowl
// Your table: a foreground plate seen from BAR_TABLE_EYE, leaning in over it; its corner near the
// middle of the frame's foot, the candle (BAR_CANDLE), the whisky and the coffee on it.
const float BAR_TABLE_Y = 0.76;
const float BAR_TABLE_Z = 1.0;      // the table's far edge
const float BAR_TABLE_X0 = -0.06;   // its left edge
const vec2 BAR_WHISKY = vec2(0.14, 0.62);  // x, z
const vec2 BAR_COFFEE = vec2(0.62, 0.84);

// ---- Outside (m)

const float BAR_FACADE_Z = 15.0;
const float BAR_FAR_CURB = 12.6;
const float BAR_NEAR_CURB = 5.6;
const float BAR_ROAD_Y = -0.12;
const float BAR_AWNING_Z = 4.0;
const float BAR_AWNING_Y = 2.45;    // the valance's lowest points
const vec3 BAR_STREETLAMP = vec3(-12.9, 4.6, 13.2);
const vec2 BAR_CROSS = vec2(-10.3, 3.85);  // a chemist's green cross on the facade
const vec3 BAR_SODIUM = vec3(1.0, 0.7, 0.42);
const vec3 BAR_NEON = vec3(1.0, 0.16, 0.2);
const float BAR_CAR_LEN = 4.4;

// ---- This frame

float barPx;        // one cell, screen heights
float barTm;        // the motion clock (uMotionTime): everything in the room and the street moves on it
vec2 barEye;        // the eye's offset (m), from the pointer
vec2 barPassEye;    // the passage's lift of the eye (m)
vec2 barPassTurn;   // the passage's turn of the view (screen heights)
vec3 barLamp;       // the pendants' light, by warmth and the time of night
vec3 barShelf;      // the back bar's own glow (strips under the shelves)
vec3 barFanCol;     // the fan's bowl light
vec3 barAmbient;    // the room's light everywhere
vec3 barCity;       // the overcast night over the street
float barLevel;     // how bright the room is kept: 1 early .. ~0.55 at last call
float barWet;       // uWeather.x
float barSign;      // the OPEN sign, lit 0..1
float barFanAngle;
vec4 barB0;         // bartender: x, action, age, duration
vec4 barB1;         // carrying, taken slot, head turn, attending you
vec4 barP0[4];      // patrons: x, z, sitting, gait
vec4 barP1[4];      // seed, facing, head turn, sip
vec4 barP2[4];      // talking, umbrella, wet coat
vec4 barGl[4];      // glasses on the counter: fill, kind, x, source slot
vec4 barMisc;       // candle draught xy, fan angle, seconds since last call (-1: none)

// ---- Passage (the entrance and exit: you sit down in the booth, you stand up to leave)

// The camera's passage: the eye's lift (m, into barEye) and the view's turn (screen heights, added
// to p). Sitting down, the eye starts high and looking down toward the door, already on its way, and
// lowers and turns to rest with a little give; leaving, it rises and turns to the door again, faster
// and faster to the end. Both exactly zero at rest.
void barPassage() {
  barPassEye = vec2(0.0);
  barPassTurn = vec2(0.0);
  float pin = passageIn();
  float pout = passageOut();
  if (pin < 1.0) {
    float tin = pin * BAR_ENTER;
    barPassEye.y += 0.13 * (1.0 - passageSettle(tin / 2.4, 2.2));
    barPassTurn += vec2(-0.05, -0.02) * (1.0 - passageSettle(tin / 2.6, 2.2));
  }
  if (pout > 0.0) {
    float tout = pout * BAR_EXIT;
    float rise = clamp((tout - 0.1) / 1.6, 0.0, 1.0);
    float turn = clamp((tout - 0.3) / 1.4, 0.0, 1.0);
    barPassEye.y += 0.18 * rise * rise;
    barPassTurn += vec2(-0.06, 0.025) * turn * turn;
  }
}

// The screen point of something at depth z as the unmoved eye would see it.
vec2 barAt(vec2 p, float z) {
  return p + BAR_F * barEye * (1.0 / z - 1.0 / BAR_FOCUS);
}

// The world point (x, y) in the plane at depth z seen at screen point p.
vec2 barWorld(vec2 p, float z) {
  return barAt(p, z) * (z / BAR_F) + vec2(0.0, BAR_EYE);
}

// The same for your table's plate, seen from its own nearer eye (BAR_TABLE_EYE).
vec2 barNear(vec2 p, float z) {
  return barAt(p, z) * (z / BAR_F) + vec2(0.0, BAR_TABLE_EYE);
}

// A capsule tapering from radius ra at a to rb at b: sdTaperCapsule, guarded for a zero-length segment.
float barSeg(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float u = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * u) - mix(ra, rb, u);
}

// The elbow for a shoulder s and a hand h (upper arm a, forearm b long), jutting out to the side
// outward (-1 left, +1 right) whichever way the arm points.
vec2 barElbow(vec2 s, vec2 h, float a, float b, float outward) {
  vec2 d = h - s;
  float len = max(length(d), 1e-4);
  vec2 n = d / len;
  float l = clamp(len, abs(a - b) + 1e-3, a + b - 1e-3);
  float x = (a * a - b * b + l * l) / (2.0 * l);
  float y = sqrt(max(a * a - x * x, 0.0));
  vec2 e1 = s + n * x + vec2(n.y, -n.x) * y;
  vec2 e2 = s + n * x - vec2(n.y, -n.x) * y;
  return (e1.x - e2.x) * outward > 0.0 ? e1 : e2;
}

// Seconds since the latest event in slots of period s (each at its own moment in its slot);
// pick: the slot's own random number.
float barEvent(float t, float period, float salt, out float pick) {
  float k = floor(t / period);
  pick = hash12(vec2(k, salt + 0.5));
  return t - (k + 0.1 + 0.5 * hash12(vec2(k, salt))) * period;
}

// A simulation texel (the back bar's field 0, sim.ts). Without it (the back bar off, or its sim not
// yet running): a still evening, three at the bar, the bartender polishing a glass, no last call.
vec4 barSimTexel(int i) {
#if LAYER_BACK_BAR
  if (backBarField0On()) return texelFetch(backBarField0, ivec2(i, 0), 0);
#endif
  if (i == 0) return vec4(1.2, float(BAR_POLISH), 5.0, 60.0);
  if (i == 1) return vec4(0.0, -1.0, 0.0, 0.0);
  if (i >= 18) return vec4(0.0, 0.0, 0.0, -1.0);
  int k = (i - 2) % 4;
  bool here = k < 3;
  if (i < 6) return here ? vec4(BAR_STOOL_X[k], BAR_STOOL_Z, 1.0, 0.0) : vec4(BAR_DOOR_X, BAR_WALK_Z, 0.0, 0.0);
  if (i < 10) return here ? vec4(0.17 + 0.3 * float(k), 0.0, 0.3 - 0.3 * float(k), 0.0) : vec4(0.0);
  if (i < 14) return vec4(0.0);
  return here ? vec4(0.6, float(k), BAR_STOOL_X[k] + BAR_GLASS_OFFSET, float(7 * k + 3)) : vec4(-1.0, 0.0, 0.0, -1.0);
}

// ---- Light

float barLampX(int i) {
  return BAR_LAMP_X0 + float(i) * BAR_LAMP_DX;
}

// The pendants' light reaching P with normal N: from each shade's mouth a bright cone straight down
// (a pool about a metre across on the counter, about 1.2 at its heart) and a softer spill wider
// round it.
vec3 barLampLight(vec3 P, vec3 N) {
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 d = vec3(barLampX(i), BAR_LAMP_Y - 0.04, BAR_LAMP_Z) - P;
    float r2 = dot(d, d);
    vec3 l = d * inversesqrt(r2);
    float cone = smoothstep(0.3, 0.6, l.y) * (0.3 + 0.9 * smoothstep(0.78, 0.95, l.y));
    s += cone * max(dot(N, l), 0.0) / (0.12 + r2);
  }
  return barLamp * s;
}

// How close x (m along the lamps' line) is to a lamp, 0..1, over width (m).
float barLampNear(float x, float width) {
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = (x - barLampX(i)) / width;
    s += exp(-d * d);
  }
  return min(s, 1.0);
}

// The fan's bowl light reaching P with normal N.
vec3 barFanLight(vec3 P, vec3 N) {
  vec3 d = vec3(BAR_FAN.x, BAR_FAN_LAMP_Y, BAR_FAN.z) - P;
  float r2 = dot(d, d);
  return barFanCol * max(dot(N, d * inversesqrt(r2)), 0.0) / (0.6 + r2);
}

// ---- Neon lettering

// One letter of OPEN in tube, q metres from its centre (0.07 wide, 0.12 tall): O, P, E, N.
float barGlyph(vec2 q, int g) {
  if (g == 0) return abs(sdEllipse(q, vec2(0.038, 0.058)));
  float stem = segmentDistance(q, vec2(-0.034, -0.06), vec2(-0.034, 0.06));
  if (g == 1) return min(stem, abs(sdBox(q - vec2(-0.008, 0.028), vec2(0.022, 0.018), 0.0) - 0.012));
  if (g == 2) {
    float bars = min(segmentDistance(q, vec2(-0.034, 0.06), vec2(0.034, 0.06)), segmentDistance(q, vec2(-0.034, -0.06), vec2(0.034, -0.06)));
    return min(min(stem, bars), segmentDistance(q, vec2(-0.034, 0.0), vec2(0.02, 0.0)));
  }
  return min(min(stem, segmentDistance(q, vec2(0.034, -0.06), vec2(0.034, 0.06))), segmentDistance(q, vec2(-0.034, 0.06), vec2(0.034, -0.06)));
}

// The OPEN sign, q metres from its centre: x the distance to the nearest letter tube, y to the
// border tube. Seen from behind (mirrored) it reads NEPO, every letter flipped.
vec2 barOpen(vec2 q, bool mirrored) {
  float pitch = 0.105;
  float i = clamp(floor(q.x / pitch + 2.0), 0.0, 3.0);
  vec2 lq = vec2(q.x - (i - 1.5) * pitch, q.y);
  int g = int(i);
  if (mirrored) {
    g = 3 - g;
    lq.x = -lq.x;
  }
  return vec2(barGlyph(lq, g), abs(sdBox(q, vec2(0.215, 0.075), 0.0) - 0.02));
}

// ---- Outside: the street through the front window

// A flat's window across the street: lit or dark, each changing every few minutes (someone home,
// someone gone to bed); mostly warm lamps, some cool light, now and then a television.
vec3 barFlat(vec2 id) {
  float h = hash12(id);
  float s = fract(barTm / (80.0 + 160.0 * hash12(id + 3.1)) + h);
  float lit = smoothstep(0.38, 0.42, s) * (1.0 - smoothstep(0.93, 0.97, s));
  float kind = hash12(id + 7.7);
  vec3 c = kind < 0.72 ? vec3(1.0, 0.64, 0.34) : kind < 0.9 ? vec3(0.7, 0.78, 0.85) : vec3(0.32, 0.45, 1.0) * (0.75 + 0.25 * sin(barTm * 0.8 + h * 20.0) * sin(barTm * 0.31));
  return c * lit * (0.3 + 0.25 * hash12(id + 1.3));
}

// The building across the street, w = (x, y) on its face (m), edges soft over soft (m): brick, a
// stone band between the floors, a laundromat lit cold and white with its row of machines (one
// tumbling) and someone waiting with a book, a doorway under its lamp, a closed bookshop's warm
// night light, and flats above with curtains drawn across the lit windows.
vec3 barFacade(vec2 w, float soft) {
  float x = w.x;
  float y = w.y;
  vec2 fromLamp = (w - BAR_STREETLAMP.xy) / vec2(3.2, 2.6);
  vec3 lit = barCity * 1.4 + BAR_SODIUM * 0.35 * exp(-dot(fromLamp, fromLamp));
  float course = floor(y / 0.075);
  float brick = 0.88 + 0.12 * hash12(vec2(floor(x / 0.22 + 0.5 * mod(course, 2.0)), course));
  vec3 col = wetten(vec3(0.33, 0.17, 0.12) * brick, barWet, 0.5) * lit;
  col = mix(col, wetten(vec3(0.42, 0.4, 0.37), barWet, 0.3) * lit * 1.15, step(3.35, y) * step(y, 3.6));
  if (y < 3.35) {
    if (x > -15.6 && x < -12.4) {
      vec3 inside = vec3(0.56, 0.72, 0.74) * 0.75;
      float slot = floor((x + 15.6) / 0.7);
      vec2 dq = vec2(fract((x + 15.6) / 0.7) - 0.5, (y - 0.95) / 0.7) * 0.7;
      float machine = step(0.55, y) * step(y, 1.38) * step(abs(dq.x), 0.32);
      inside = mix(inside, vec3(0.7, 0.74, 0.76) * 0.5, machine);
      float r = length(dq);
      float door = (1.0 - smoothstep(0.19, 0.22, r)) * machine;
      vec3 drum = vec3(0.12, 0.15, 0.17);
      if (slot == 2.0) {
        float a = atan(dq.y, dq.x) - barTm * 1.1;
        drum = mix(vec3(0.5, 0.25, 0.32), vec3(0.2, 0.3, 0.5), 0.5 + 0.5 * sin(a * 3.0)) * 0.6 * smoothstep(0.02, 0.12, r);
      }
      inside = mix(inside, drum, door);
      vec2 pq = vec2(x + 13.15, y);
      float person = min(sdEllipse(pq - vec2(0.0, 1.36 + 0.01 * sin(barTm * 0.3)), vec2(0.1, 0.12)), sdBox(pq - vec2(0.03, 0.95), vec2(0.15, 0.3), 0.0) - 0.05);
      inside = mix(inside, vec3(0.1, 0.09, 0.11), softFill(person, soft));
      col = mix(col, inside, softFill(sdBox(vec2(x + 14.0, y - 1.66), vec2(1.52, 1.1), 0.0), soft));
      col = mix(col, vec3(0.75, 0.82, 0.85) * 0.55, softFill(sdBox(vec2(x + 14.0, y - 3.08), vec2(1.5, 0.17), 0.0), soft));
    } else if (x > -11.9 && x < -10.9) {
      col = mix(col, vec3(0.025, 0.02, 0.02) + vec3(0.04, 0.025, 0.012) * smoothstep(1.8, 0.0, y), softFill(sdBox(vec2(x + 11.4, y - 1.1), vec2(0.45, 1.1), 0.0), soft));
      vec2 lq = vec2(x + 11.4, y - 2.55);
      col += vec3(1.0, 0.72, 0.42) * (0.9 * softFill(length(lq) - 0.07, soft) + 0.15 * exp(-length(lq) / 0.35));
    } else if (x > -10.7 && x < -7.8) {
      float shelf = step(0.82, fract((y - 0.6) / 0.42));
      float spine = hash12(vec2(floor(x / 0.07), floor((y - 0.6) / 0.42)));
      vec3 books = mix(vec3(0.5, 0.2, 0.12), vec3(0.15, 0.25, 0.3), step(0.5, spine)) * (0.4 + 0.6 * spine);
      vec3 inside = mix(books, vec3(0.3, 0.2, 0.12), shelf) * vec3(1.0, 0.7, 0.45) * 0.5 * (0.6 + 0.4 * smoothstep(2.6, 1.2, y));
      col = mix(col, inside, softFill(sdBox(vec2(x + 9.25, y - 1.65), vec2(1.3, 1.05), 0.0), soft));
    }
  } else if (y > 3.85 && y < 5.65) {
    float gx = (x + 16.0) / 1.6;
    vec2 id = vec2(floor(gx), 1.0);
    vec2 f = vec2((fract(gx) - 0.5) * 1.6, y - 4.8);
    float folds = 0.75 + 0.25 * sin(f.x * 40.0 + hash12(id) * 6.0);
    col = mix(col, vec3(0.02, 0.022, 0.03) + barFlat(id) * folds, softFill(sdBox(f, vec2(0.45, 0.8), 0.0), soft));
    col = mix(col, wetten(vec3(0.45, 0.43, 0.4), barWet, 0.3) * lit * 1.2, softFill(sdBox(f + vec2(0.0, 0.86), vec2(0.52, 0.05), 0.0), soft));
  }
  // A chemist's green cross over the street, lit all night, glowing in the wet air.
  vec2 cq = abs(w - BAR_CROSS);
  float plus = min(max(cq.x - 0.27, cq.y - 0.09), max(cq.x - 0.09, cq.y - 0.27));
  col = mix(col, vec3(0.45, 1.0, 0.65), softFill(plus, soft));
  col += vec3(0.15, 0.9, 0.45) * 0.25 * exp(-max(plus, 0.0) / 0.25);
  return col;
}

// What is lit across the street (the laundromat, the bookshop, the doorway's lamp, the street
// lamp) mirrored in the wet street below it: streaks running toward you, broken by the water's
// unevenness. x: screen x at the facade's depth; down: screen heights below the facade's foot.
vec3 barStreaks(float x, float down, float y) {
  float k = BAR_F / BAR_FACADE_Z;
  float ripple = 0.55 + 0.45 * vnoise(vec2(x * 70.0, y * 140.0 + barTm * 0.35));
  float fall = exp(-down / 0.05);
  vec3 c = vec3(0.56, 0.72, 0.74) * 0.7 * smoothstep(0.012, 0.0, max(-15.5 * k - x, x + 12.5 * k)) * fall;
  c += vec3(1.0, 0.7, 0.45) * 0.2 * smoothstep(0.01, 0.0, max(-10.5 * k - x, x + 8.0 * k)) * fall;
  c += vec3(1.0, 0.72, 0.42) * 0.5 * bell((x + 11.4 * k) / 0.006) * fall;
  c += vec3(0.2, 1.0, 0.5) * 0.6 * bell((x - BAR_CROSS.x * k) / 0.008) * exp(-down / 0.07);
  float lampX = BAR_F * BAR_STREETLAMP.x / BAR_STREETLAMP.z;
  c += BAR_SODIUM * 1.0 * bell((x - lampX) / 0.009) * exp(-down / 0.1);
  return c * ripple;
}

// One lane of passers-by (x0..x1 m of it in view): of the two latest slots, the walker nearest x.
// Returns (where along the street, distance walked, look seed); seed < 0: nobody.
vec3 barPasser(float x, float period, float dir, float salt, float share, float x0, float x1) {
  vec3 best = vec3(0.0, 0.0, -1.0);
  float near = 1e3;
  for (int k = 0; k < 2; k++) {
    float slot = floor(barTm / period) - float(k);
    if (hash12(vec2(slot, salt)) > share) continue;
    float speed = 0.85 + 0.35 * hash12(vec2(slot, salt + 1.0));
    float e = barTm - (slot + 0.1 + 0.6 * hash12(vec2(slot, salt + 2.0))) * period;
    if (e < 0.0) continue;
    float pos = dir > 0.0 ? x0 - 0.9 + speed * e : x1 + 0.9 - speed * e;
    if (pos < x0 - 1.0 || pos > x1 + 1.0) continue;
    if (abs(pos - x) < near) {
      near = abs(pos - x);
      best = vec3(pos, speed * e, hash12(vec2(slot, salt + 3.0)));
    }
  }
  return best;
}

// A passer-by side-on, q metres from the point between their feet, walking toward dir, an open
// umbrella over them if it rains (and brolly allows). front: the light on the side facing you;
// rim: on their outline. Returns colour and soft coverage.
vec4 barPasserLook(vec2 q, float dir, float walked, float seed, float aa, vec3 front, vec3 rim, bool brolly) {
  if (abs(q.x) > 0.75 || q.y < -0.05 || q.y > 2.25) return vec4(0.0);
  float ph = TAU * walked / 1.35;
  bool open = brolly && hash12(vec2(seed, 4.2)) < mix(0.12, 0.9, step(0.05, K_rain));
  float d = 1e3;
  float part = 0.0;
  for (int k = 0; k < 2; k++) {
    float kp = float(k) * BAR_PI;
    float a = 0.4 * sin(ph + kp);
    float b = 0.55 * max(0.0, sin(ph + kp + 1.3));
    vec2 hip = vec2(0.0, 0.92 + 0.012 * abs(sin(ph)));
    vec2 knee = hip + vec2(sin(a) * dir, -cos(a)) * 0.45;
    vec2 ankle = knee + vec2(sin(a - b) * dir, -cos(a - b)) * 0.43;
    float leg = min(min(barSeg(q, hip, knee, 0.075, 0.058), barSeg(q, knee, ankle, 0.056, 0.045)), sdEllipse(q - ankle - vec2(0.05 * dir, -0.03), vec2(0.1, 0.035)));
    if (leg < d) {
      d = leg;
      part = 1.0;
    }
  }
  vec2 hand = open ? vec2(0.2 * dir, 1.22) : vec2(0.06 * dir + 0.08 * sin(ph) * dir, 0.88);
  float coat = smin(barSeg(q, vec2(0.0, 0.9), vec2(0.03 * dir, 1.42), 0.17, 0.13), sdEllipse(q - vec2(0.0, 0.95), vec2(0.17, 0.12)), 0.05);
  coat = min(coat, barSeg(q, vec2(0.02 * dir, 1.36), hand, 0.055, 0.042));
  if (coat < d) {
    d = coat;
    part = 0.0;
  }
  vec2 hc = vec2(0.05 * dir, 1.6 + 0.012 * abs(sin(ph)));
  float head = min(sdEllipse(q - hc, vec2(0.09, 0.11)), sdEllipse(q - hc - vec2(0.085 * dir, -0.015), vec2(0.022, 0.017)));
  if (head < d) {
    d = head;
    part = 2.0;
  }
  if (open) {
    vec2 apex = vec2(0.14 * dir, 2.08);
    float rimY = 1.86 - 0.04 * abs(sin((q.x - apex.x) * BAR_PI / 0.27));
    float canopy = min(max(sdEllipse(q - vec2(apex.x, 1.86), vec2(0.56, 0.24)), rimY - q.y), barSeg(q, hand, apex, 0.012, 0.012));
    if (canopy < d) {
      d = canopy;
      part = 3.0;
    }
  }
  float cover = softFill(d, aa);
  if (cover <= 0.0) return vec4(0.0);
  float h = fract(seed * 17.3);
  vec3 coatC = h < 0.3 ? vec3(0.08, 0.08, 0.09) : h < 0.55 ? vec3(0.32, 0.22, 0.13) : h < 0.8 ? vec3(0.07, 0.09, 0.16) : vec3(0.25, 0.07, 0.07);
  float u = fract(seed * 41.7);
  vec3 brollyC = u < 0.45 ? vec3(0.03) : u < 0.6 ? vec3(0.06, 0.08, 0.16) : u < 0.75 ? vec3(0.45, 0.05, 0.06) : u < 0.88 ? vec3(0.05, 0.14, 0.08) : vec3(0.6, 0.48, 0.1);
  bool hair = sdEllipse(q - hc - vec2(-0.02 * dir, 0.03), vec2(0.095, 0.09)) < 0.0 && dot(q - hc, vec2(dir, 0.0)) < 0.03;
  vec3 albedo = part == 1.0 ? vec3(0.04) : part == 2.0 ? (hair ? vec3(0.06, 0.045, 0.035) : vec3(0.6, 0.42, 0.32)) : part == 3.0 ? brollyC : coatC;
  float edge = 1.0 - smoothstep(0.0, 0.045, -d);
  vec3 c = albedo * (front + barCity * 0.6) + rim * edge * 0.5;
  // Under the canopy its lining, lit warm by the window; on top, the beading rain catching the sky.
  if (part == 3.0) c += front * albedo * 0.6 * smoothstep(1.98, 1.86, q.y) + rim * 0.25 * smoothstep(2.02, 2.1, q.y);
  return vec4(c, cover);
}

// A car side-on: c = (metres from its rear toward its front, height over the road). Returns the
// silhouette's distance; glass: 1 in the window band.
float barCarShape(vec2 c, out float glass) {
  float body = sdBox(c - vec2(2.2, 0.62), vec2(2.1, 0.3), 0.0) - 0.07;
  float k = clamp((c.y - 0.92) / 0.48, 0.0, 1.0);
  float cabin = max(max(mix(1.05, 1.6, k) - c.x, c.x - mix(3.2, 2.75, k)), max(0.9 - c.y, c.y - 1.4)) - 0.03;
  float shape = max(min(body, cabin), -(min(length(c - vec2(0.85, 0.3)), length(c - vec2(3.55, 0.3))) - 0.37));
  shape = min(shape, min(length(c - vec2(0.85, 0.31)), length(c - vec2(3.55, 0.31))) - 0.3);
  glass = step(cabin, -0.06) * step(0.95, c.y);
  return shape;
}

// The cars in a lane (period s between slots, a share of them taken, dir +1 to the right, x0..x1 m
// of it in view): of the two latest slots, the car nearest x; (its rear along the street, look
// seed, a taxi above 0.86; -1: none). On the near lane the trigger sends a taxi along.
vec2 barCar(float x, float period, float dir, float salt, float share, float x0, float x1, bool near) {
  vec2 best = vec2(0.0, -1.0);
  float dist = 1e3;
  for (int k = 0; k < 2; k++) {
    float slot = floor(barTm / period) - float(k);
    if (hash12(vec2(slot, salt)) > share) continue;
    float speed = 3.2 + 1.8 * hash12(vec2(slot, salt + 1.0));
    float e = barTm - (slot + 0.1 + 0.5 * hash12(vec2(slot, salt + 2.0))) * period;
    if (e < 0.0) continue;
    float rear = dir > 0.0 ? x0 - BAR_CAR_LEN - 0.5 + speed * e : x1 + BAR_CAR_LEN + 0.5 - speed * e;
    float mid = rear + 0.5 * BAR_CAR_LEN * dir;
    if (abs(mid - x) < dist && mid > x0 - BAR_CAR_LEN && mid < x1 + BAR_CAR_LEN) {
      dist = abs(mid - x);
      best = vec2(rear, hash12(vec2(slot, salt + 3.0)));
    }
  }
  if (near) {
    float e = sinceTriggerM(TRIGGER_traffic);
    if (e >= 0.0 && e < 14.0) {
      float rear = x0 - BAR_CAR_LEN - 0.5 + 3.8 * e;
      float mid = rear + 0.5 * BAR_CAR_LEN;
      if (abs(mid - x) < dist && mid < x1 + BAR_CAR_LEN) best = vec2(rear, 0.97);
    }
  }
  return best;
}

// One car at depth z going dir, drawn over col where it covers sp; its headlamps' beams ahead of it
// go into beam (they light the rain). Returns the coverage.
float barCarDraw(vec2 sp, float z, float dir, vec2 car, float soft, inout vec3 col, inout vec3 beam) {
  vec2 w = barWorld(sp, z);
  vec2 c = vec2((w.x - car.x) * dir, w.y - BAR_ROAD_Y);
  float ahead = c.x - BAR_CAR_LEN;
  if (ahead > 0.0 && ahead < 9.0) beam += vec3(1.0, 0.9, 0.75) * 0.5 * bell((c.y - 0.62) / (0.22 + 0.09 * ahead)) * exp(-ahead / 4.0);
  // The lamps' glare in the wet air: a halo round each headlamp and a smaller red one round each
  // tail lamp, switched per cell as they move.
  float glare = exp(-length((c - vec2(BAR_CAR_LEN, 0.68)) / vec2(1.4, 1.0)) / 0.22);
  float redGlare = exp(-length((c - vec2(0.0, 0.8)) / vec2(1.3, 1.0)) / 0.15);
  col += vec3(1.0, 0.92, 0.78) * 0.3 * hardEdge(glare * 1.2) + vec3(0.9, 0.12, 0.08) * 0.25 * hardEdge(redGlare * 1.1);
  if (c.x < -0.5 || c.x > BAR_CAR_LEN + 0.5 || c.y > 1.6) return 0.0;
  float aa = (barPx + soft) * z / BAR_F;
  float glass = 0.0;
  float cover = hardEdge(softFill(barCarShape(c, glass), aa));
  bool taxi = car.y > 0.86;
  float h = fract(car.y * 13.7);
  vec3 paint = taxi ? vec3(0.62, 0.45, 0.08) : h < 0.3 ? vec3(0.03) : h < 0.5 ? vec3(0.22, 0.04, 0.04) : h < 0.7 ? vec3(0.05, 0.07, 0.14) : h < 0.85 ? vec3(0.3, 0.31, 0.33) : vec3(0.5);
  vec3 body = wetten(paint, barWet, 0.0) * (barCity * 1.6 + BAR_SODIUM * 0.08);
  // Bands along it, which slide along themselves as it moves: the glass, the roof's sheen, a
  // chrome line, the sills in shadow.
  body = mix(body, vec3(0.03, 0.035, 0.045) + barCity * 0.4, glass);
  body += (barCity * 1.5 + BAR_SODIUM * 0.1) * smoothstep(1.3, 1.4, c.y) * step(c.y, 1.43) * (0.6 + 0.6 * barWet);
  body += barCity * 2.5 * step(abs(c.y - 0.9), 0.012);
  body *= 1.0 - 0.5 * step(c.y, 0.38);
  float wheel = min(length(c - vec2(0.85, 0.31)), length(c - vec2(3.55, 0.31)));
  if (wheel < 0.3) body = vec3(0.015) + barCity * 0.3 * step(0.18, wheel);
  // Headlamps at the front, tail lamps at the back, a taxi's roof sign.
  body = mix(body, vec3(1.0, 0.96, 0.85), hardEdge(softFill(length((c - vec2(BAR_CAR_LEN - 0.08, 0.68)) / vec2(0.7, 1.0)) - 0.08, aa)));
  body = mix(body, vec3(1.0, 0.12, 0.08), hardEdge(softFill(length((c - vec2(0.06, 0.8)) / vec2(0.6, 1.0)) - 0.07, aa)));
  if (taxi) body = mix(body, vec3(1.0, 0.85, 0.45), hardEdge(softFill(sdBox(c - vec2(2.2, 1.48), vec2(0.18, 0.06), 0.0), aa)));
  col = mix(col, body, cover);
  return cover;
}

// The bar's own striped awning outside over the window: its valance at BAR_AWNING_Z, scalloped
// along the bottom; above that its underside sloping back to the wall, lit warm from the window.
// Returns colour and coverage (0 below the scallops).
vec4 barAwning(vec2 sp) {
  vec2 w = barWorld(sp, BAR_AWNING_Z);
  float f = fract(w.x / 0.25);
  float s2 = 2.0 * f - 1.0;
  float y0 = BAR_AWNING_Y + 0.07 * (1.0 - sqrt(max(1.0 - s2 * s2, 0.0)));
  if (w.y < y0) return vec4(0.0);
  vec3 warm = barLamp * 0.18 + barShelf * 0.1;
  vec3 green = wetten(vec3(0.06, 0.2, 0.13), barWet, 0.8);
  vec3 cream = wetten(vec3(0.62, 0.56, 0.45), barWet, 0.8);
  if (w.y < 2.62) return vec4(mix(green, cream, step(0.5, fract(w.x / 0.5))) * (warm + barCity * 0.8) * (0.75 + 0.25 * smoothstep(y0, y0 + 0.04, w.y)), 1.0);
  // The underside: where the eye ray meets the cloth sloping up to the wall, its stripes running
  // out toward you.
  float z = 2.236 / max(barAt(sp, 3.4).y / BAR_F + 0.209, 0.05);
  float x = barAt(sp, z).x * z / BAR_F;
  vec3 c = mix(green, cream, step(0.5, fract(x / 0.5))) * (warm * 1.6 + barCity * 0.3) + BAR_NEON * barSign * 0.06;
  return vec4(c, 1.0);
}

// Everything out there along the eye ray through sp (xl: the frame's left edge on screen): colour;
// zHit the distance to the first surface (m) for the rain, 0 where the awning shelters the view;
// dropLit the light the rain shows.
vec3 barOutside(vec2 sp, float xl, out float zHit, out vec3 dropLit) {
  float xr = -0.5;
  float soft = 0.6 * barPx + 0.004 * K_rain;
  float traffic = K_traffic;
  vec3 beam = vec3(0.0);
  vec3 col;
  zHit = BAR_FACADE_Z;

  // The ground, where the eye ray meets it: the near pavement, the road, the far kerb's face, the
  // far pavement. Above them, the facade.
  float gy = barAt(sp, 9.0).y;
  float zs = gy < 0.0 ? BAR_F * BAR_EYE / -gy : 1e3;
  float zr = gy < 0.0 ? BAR_F * (BAR_EYE - BAR_ROAD_Y) / -gy : 1e3;
  bool nearPave = zs < BAR_NEAR_CURB;
  bool road = !nearPave && zr < BAR_FAR_CURB;
  bool kerb = !nearPave && !road && zs < BAR_FAR_CURB;
  bool farPave = !nearPave && !road && !kerb && zs < BAR_FACADE_Z;
  if (nearPave || road || kerb || farPave) {
    float z = road ? zr : kerb ? BAR_FAR_CURB : zs;
    zHit = z;
    float gx = barAt(sp, z).x * z / BAR_F;
    vec2 ground = vec2(gx, z);
    vec3 albedo = road ? vec3(0.07, 0.07, 0.075) : kerb ? vec3(0.38, 0.37, 0.34) : vec3(0.22, 0.21, 0.2) * (0.85 + 0.15 * hash12(floor(ground / 0.6)));
    vec2 fromLamp = vec2(gx - BAR_STREETLAMP.x, z - BAR_STREETLAMP.z);
    vec3 light = barCity * 1.1 + BAR_SODIUM * 0.45 * exp(-dot(fromLamp, fromLamp) / 10.0);
    // The bar's own light thrown out through the window onto the near pavement; the sign's red.
    if (nearPave) light += (barLamp * 0.22 + barShelf * 0.12) * smoothstep(BAR_NEAR_CURB + 0.3, 3.8, z) + BAR_NEON * barSign * 0.2 * bell((gx - BAR_SIGN.x) / 1.3);
    col = wetten(albedo, barWet, road ? 0.15 : 0.35) * light;
    if (kerb) col += light * 0.15;
    if (barWet > 0.0 && !kerb) {
      // Wet, it mirrors what is lit across the street in long broken streaks; water pools in its
      // low spots, ringed by the rain, and splashes jump on the rest.
      float pool = rainPuddles(ground * vec2(1.0, 1.6), barWet);
      float gloss = max(wetGloss(barWet, 1.0), pool);
      vec2 fq = barAt(sp, BAR_FACADE_Z);
      vec3 mirrored = barCity * 0.7 + barStreaks(fq.x, max(-BAR_F * BAR_EYE / BAR_FACADE_Z - fq.y, 0.0), sp.y);
      col = mix(col, mirrored + light * 0.15 * albedo, gloss * 0.9);
      if (K_rain > 0.0) {
        float ring = hardEdge(rainRipples(vec2(sp.x * 24.0, sp.y * 60.0), uFallTime, K_rain).z);
        col = mix(col, barCity * 2.2 + BAR_SODIUM * 0.15, ring * pool * 0.6);
        col += (barCity * 1.6 + light * 0.3) * rainSplashes(vec2(sp.x * 20.0, sp.y * 30.0), uFallTime, K_rain) * (1.0 - pool);
      }
    }
  } else {
    col = barFacade(barWorld(sp, BAR_FACADE_Z), soft * BAR_FACADE_Z / BAR_F);
  }

  // People along the far pavement, small against the shop lights.
  for (int k = 0; k < 2; k++) {
    float z = k == 0 ? 13.6 : 14.2;
    float dir = k == 0 ? 1.0 : -1.0;
    if (zHit < z) continue;
    vec2 w = barWorld(sp, z);
    vec3 who = barPasser(w.x, mix(30.0, 7.0, traffic), dir, 41.0 + float(k) * 9.0, traffic > 0.0 ? 0.7 : 0.0, xl * z / BAR_F, xr * z / BAR_F);
    if (who.z < 0.0) continue;
    vec4 f = barPasserLook(vec2(w.x - who.x, w.y), dir, who.y, who.z, (barPx + soft) * z / BAR_F, barCity * 1.2 + BAR_SODIUM * 0.1, vec3(0.13, 0.16, 0.16), true);
    float c = hardEdge(f.a);
    col = mix(col, f.rgb, c);
    if (c > 0.0) zHit = z;
  }

  // The street lamp on the far kerb: post, lantern, and its halo in the wet air.
  vec2 lw = barWorld(sp, BAR_STREETLAMP.z) - BAR_STREETLAMP.xy;
  if (zHit > BAR_STREETLAMP.z) {
    float lpx = (barPx + soft) * BAR_STREETLAMP.z / BAR_F;
    float post = max(abs(lw.x) - 0.055, max(-BAR_STREETLAMP.y - lw.y, lw.y + 0.24));
    float cap = sdBox(lw - vec2(0.0, 0.27), vec2(0.2, 0.04), 0.0);
    float metal = softFill(min(post, cap), lpx);
    float lantern = softFill(sdBox(lw, vec2(0.14, 0.22), 0.0) - 0.02, lpx);
    col = mix(col, vec3(0.03) + barCity * 0.3, metal);
    col = mix(col, BAR_SODIUM * 1.4, lantern);
    if (max(metal, lantern) > 0.5) zHit = BAR_STREETLAMP.z;
  }
  col += BAR_SODIUM * (0.3 * exp(-length(lw) / 0.5) + 0.1 * exp(-length(lw) / 1.6)) * (1.0 + 1.2 * K_rain);

  // Cars: the far lane going left, the near lane going right, and their lamps in the wet road.
  float period = mix(30.0, 6.0, traffic);
  for (int k = 0; k < 2; k++) {
    float z = k == 0 ? 10.4 : 7.4;
    float dir = k == 0 ? -1.0 : 1.0;
    vec2 car = barCar(barWorld(sp, z).x, period * (k == 0 ? 1.3 : 1.0), dir, 61.0 + float(k) * 17.0, traffic > 0.0 ? 0.75 : 0.0, xl * z / BAR_F, xr * z / BAR_F, k == 1);
    if (car.y < 0.0) continue;
    vec2 q = barAt(sp, z);
    float yc = BAR_F * (BAR_ROAD_Y - BAR_EYE) / z;
    if (road && barWet > 0.0 && q.y < yc) {
      float down = yc - q.y;
      float gloss = wetGloss(barWet, 1.0);
      float head = bell((q.x - BAR_F * (car.x + (BAR_CAR_LEN - 0.08) * dir) / z) / 0.007) * exp(-down / 0.05);
      float tail = bell((q.x - BAR_F * (car.x + 0.06 * dir) / z) / 0.006) * exp(-down / 0.04);
      col = mix(col, vec3(1.0, 0.92, 0.78), hardEdge(head * gloss * 1.3) * 0.8);
      col = mix(col, vec3(0.9, 0.1, 0.06), hardEdge(tail * gloss * 1.2) * 0.7);
    }
    if (zHit < z) continue;
    if (barCarDraw(sp, z, dir, car, soft, col, beam) > 0.0) zHit = z;
  }

  // People on this side, going past the window: lit warm by it (and red by the sign); those close
  // in under the awning need no umbrella.
  for (int k = 0; k < 2; k++) {
    float z = k == 0 ? 4.5 : 3.75;
    float dir = k == 0 ? -1.0 : 1.0;
    if (zHit < z) continue;
    vec2 w = barWorld(sp, z);
    vec3 who = barPasser(w.x, mix(26.0, 6.0, traffic), dir, 83.0 + float(k) * 13.0, traffic > 0.0 ? 0.75 : 0.0, xl * z / BAR_F, xr * z / BAR_F);
    if (who.z < 0.0) continue;
    vec3 front = barLamp * 0.3 + barShelf * 0.15 + BAR_NEON * barSign * 0.25 * bell(w.x - BAR_SIGN.x);
    vec4 f = barPasserLook(vec2(w.x - who.x, w.y), dir, who.y, who.z, (barPx + soft) * z / BAR_F, front, barCity * 2.0 + BAR_SODIUM * 0.1, k == 0);
    float c = hardEdge(f.a);
    col = mix(col, f.rgb, c);
    // Under the awning nothing falls between them and the glass.
    if (c > 0.0) zHit = z < BAR_AWNING_Z ? 0.0 : z;
  }

  // The awning overhead (sheltering the glass: no rain in front of it), and the water dripping from
  // its scallops' lowest points, lit by the bar.
  vec4 aw = barAwning(sp);
  if (aw.a > 0.0) {
    col = aw.rgb;
    zHit = 0.0;
  } else if (zHit >= BAR_AWNING_Z) {
    float drip = max(K_rain, 0.4 * barWet);
    if (drip > 0.0) {
      vec2 w = barWorld(sp, BAR_AWNING_Z);
      col = mix(col, barLamp * 0.4 + barShelf * 0.2 + barCity * 1.5, rainDrips(vec2(w.x, (BAR_AWNING_Y - w.y) * 0.42), uFallTime, drip, 0.25) * 0.85);
    }
  }

  // The light the rain shows here: the overcast's glow, the lamp's cone, the headlamps' beams, the
  // bar's light and the sign's just outside.
  float cone = smoothstep(1.0, 0.0, abs(lw.x) / (0.35 + 0.45 * max(-lw.y, 0.0))) * smoothstep(0.4, -0.3, lw.y) * exp(-max(-lw.y, 0.0) / 6.0);
  dropLit = barCity * 1.2 + BAR_SODIUM * 0.6 * cone + beam + barLamp * 0.06 + BAR_NEON * barSign * 0.08;
  return col;
}

// The jukebox behind you, seen only reflected in the window: an arch of bubble tubes slowly
// changing colour, the record window and the grille glowing amber. Light to add.
vec3 barJukebox(vec2 p) {
  if (K_jukebox <= 0.0) return vec3(0.0);
  vec2 q = (barAt(p, 4.2) - vec2(-0.645, -0.1)) / vec2(0.07, 0.115);
  if (abs(q.x) > 1.4 || abs(q.y) > 1.4) return vec3(0.0);
  float song = sinceTriggerM(TRIGGER_jukebox);
  float swell = song >= 0.0 ? exp(-song / 8.0) : 0.0;
  float arch = q.y > 0.3 ? length((q - vec2(0.0, 0.3)) / vec2(1.0, 0.7)) - 1.0 : abs(q.x) - 1.0;
  arch = max(arch, -1.0 - q.y);
  float body = softFill(arch, 0.06);
  float tube = softFill(abs(arch + 0.12) - 0.07, 0.05);
  float along = q.y > 0.3 ? atan(q.x, q.y - 0.3) : sign(q.x) * (1.6 + 0.3 - q.y);
  float hue = along * 0.35 - barTm * (0.04 + 0.2 * swell);
  vec3 tint = mix(0.5 + 0.5 * cos(TAU * (hue + vec3(0.0, 0.33, 0.67))), vec3(1.0, 0.6, 0.2), 0.35);
  float grille = softFill(sdBox(q - vec2(0.0, -0.55), vec2(0.6, 0.3), 0.0), 0.05) * (0.7 + 0.3 * step(0.5, fract(q.x * 4.0)));
  float window = softFill(sdEllipse(q - vec2(0.0, 0.45), vec2(0.55, 0.35)), 0.05);
  vec3 c = tint * tube * 0.9 + vec3(1.0, 0.62, 0.25) * (grille * 0.5 + window * 0.35) + vec3(0.25, 0.15, 0.1) * body * 0.15;
  return c * K_jukebox * 0.4 * (1.0 + 1.3 * swell);
}

// A pane of the front window at p (w: the point on the wall, m): the street behind it bent by the
// drops on the glass, the rain out there, the mist low on the glass, the jukebox reflected, and the
// OPEN sign hanging in front of it.
vec3 barPane(vec2 p, vec2 uv, float aspect, float xl, vec2 w) {
  vec3 drop = vec3(0.0);
  vec2 sp = p;
  vec2 fromCentre = vec2(0.0);
  float lens = 0.0;
  float onGlass = max(K_rain * 0.8, 0.3 * smoothstep(0.3, 1.0, barWet));
  if (K_drops > 0.5 && onGlass > 0.0) {
    drop = glassDrops(uv, aspect, barTm, onGlass);
    sp += drop.xy * vec2(aspect, 1.0);
    if (drop.z > 0.0) {
      // Each drop is a little lens holding a small upside-down picture of the lit street, fixed to
      // the drop (anchored by its column, not its height), so a sliding drop carries its picture
      // down instead of streaming the street through itself.
      fromCentre = -drop.xy * vec2(aspect, 1.0) / (3.2 * drop.z);
      vec2 centre = p - fromCentre;
      lens = smoothstep(0.15, 0.85, drop.z);
      sp = mix(sp, vec2(0.6 * centre.x - 0.3, -0.02) - fromCentre * 2.5, lens);
    }
  }
  float zHit = BAR_FACADE_Z;
  vec3 dropLit = vec3(0.0);
  vec3 col = barOutside(sp, xl, zHit, dropLit);
  // The rain out there, none at arm's length (that would be in here).
  if (K_rain > 0.0) {
    Precip fall = rainFall(uv + drop.xy, aspect, barTm, uFallTime, K_rain, K_wind, weatherDepth(zHit));
    col = mix(col, barCity * 1.1 + dropLit * 0.2, fall.veil);
    col = mix(col, max(dropLit * 1.2, vec3(0.08)), fall.cover * (1.0 - fall.near));
  }
  // A car's headlamps smear across the wet glass as it goes by on the near lane: the film of water
  // spreads their light into a long streak at their height (switched per cell, as it moves). The
  // lane's call matches barOutside's, so the smear rides with the lamps.
  if (onGlass > 0.0) {
    float z = 7.4;
    vec2 car = barCar(barWorld(p, z).x, mix(30.0, 6.0, K_traffic), 1.0, 78.0, K_traffic > 0.0 ? 0.75 : 0.0, xl * z / BAR_F, -0.5 * z / BAR_F, true);
    if (car.y >= 0.0) {
      vec2 lamp = vec2(car.x + BAR_CAR_LEN - 0.08, 0.68 + BAR_ROAD_Y - BAR_EYE) * (BAR_F / z);
      vec2 d = (barAt(p, z) - lamp) / vec2(0.075, 0.012);
      col = mix(col, vec3(1.0, 0.93, 0.8), hardEdge(exp(-dot(d, d)) * smoothstep(0.0, 0.5, onGlass)) * 0.55);
    }
  }
  // Mist on the inside of the glass low down, where the warm room meets the cold pane.
  float mist = smoothstep(1.1, 0.5, w.y + 0.25 * fbm(w * vec2(3.0, 5.0))) * 0.55;
  col = mix(col, (barLamp * 0.1 + barShelf * 0.05 + barCity * 0.6) * 1.2 + col * 0.3, mist);
  // The room faintly in the glass, the jukebox behind you clearer.
  col += barLamp * 0.012 + barJukebox(p) * (1.0 - 0.5 * mist);
  // The drops: dark at the rim where they bend the dark room in, catching the lamps and the sign.
  float ring = 4.0 * drop.z * (1.0 - drop.z);
  float facing = smoothstep(0.1, 0.8, dot(normalize(fromCentre + 1e-6), vec2(0.7, 0.7)));
  col = col * (1.0 - 0.3 * ring) * (1.0 + 0.5 * lens) + (barLamp * 0.25 + BAR_NEON * barSign * 0.2) * ring * facing;
  // The OPEN sign, hanging on its chains just inside the glass; read from behind. Off, its tubes
  // are dark glass.
  if (K_sign > 0.5) {
    vec2 sq = barWorld(p, BAR_SIGN.z) - BAR_SIGN.xy;
    if (abs(sq.x) < 0.42 && sq.y > -0.3 && sq.y < 0.36) {
      float spx = barPx * BAR_SIGN.z / BAR_F;
      vec2 od = barOpen(sq, true);
      vec3 blue = vec3(0.3, 0.5, 1.0);
      col += BAR_NEON * barSign * 0.35 * exp(-od.x / 0.03) + blue * barSign * 0.2 * exp(-od.y / 0.03);
      float chain = min(abs(sq.x + 0.17), abs(sq.x - 0.17));
      col = mix(col, vec3(0.25, 0.22, 0.18) * (barAmbient * 3.0 + BAR_NEON * barSign * 0.3), softFill(chain - max(0.004, 0.6 * spx), spx) * step(0.095, sq.y));
      col = mix(col, mix(vec3(0.12, 0.07, 0.08), mix(BAR_NEON, vec3(1.0, 0.85, 0.85), 0.45), barSign), softFill(od.x - 0.009, spx));
      col = mix(col, mix(vec3(0.08, 0.09, 0.12), mix(blue, vec3(0.85, 0.9, 1.0), 0.4), barSign), softFill(od.y - 0.008, spx));
    }
  }
  return col;
}

// ---- The front wall, the column, the coat

// The front wall left of the column, at p: the window's frame painted bottle green, the panes,
// the deep inside ledge, panelling below and plaster above.
vec3 barFrontWall(vec2 p, vec2 uv, float aspect, float xl) {
  vec2 w = barWorld(p, BAR_WIN_Z);
  float px = barPx * BAR_WIN_Z / BAR_F;
  vec2 fromSign = (w - BAR_SIGN.xy) / vec2(0.7, 0.5);
  vec3 room = barAmbient * 1.6 + barLamp * 0.04 + BAR_NEON * barSign * 0.22 * exp(-dot(fromSign, fromSign)) + vec3(1.0, 0.62, 0.3) * 0.5 * barLevel * exp(-length(w - BAR_SCONCE) / 0.5);
  bool opening = w.x > BAR_WIN_X0 && w.x < BAR_WIN_X1 && w.y > BAR_WIN_Y0 && w.y < BAR_WIN_Y1;
  float bars = min(abs(w.x - BAR_MULLION_X), abs(w.y - BAR_TRANSOM_Y));
  if (opening && bars > 0.035) return barPane(p, uv, aspect, xl, w);
  vec3 green = vec3(0.05, 0.12, 0.085);
  if (opening) {
    float bead = smoothstep(0.022, 0.034, bars);
    return green * room * (0.9 + 0.8 * bead) + barCity * 0.4 * bead;
  }
  bool jamb = (w.x >= BAR_WIN_X1 || (w.x <= BAR_WIN_X0 && w.x > BAR_WIN_X0 - 0.07)) && w.y > BAR_WIN_Y0 - 0.07 && w.y < BAR_WIN_Y1 + 0.1;
  if (jamb) return green * room * 1.2;
  if (w.y > BAR_WIN_Y1) return w.y < BAR_WIN_Y1 + 0.1 && w.x > BAR_WIN_X0 - 0.07 ? green * room * 1.1 : vec3(0.3, 0.24, 0.19) * room * 0.9;
  if (w.y > BAR_WIN_Y0 - 0.07 && w.x > BAR_WIN_X0 - 0.07) {
    // The inside ledge: its top seen from above, its nosing below.
    float top = smoothstep(BAR_WIN_Y0 - 0.02, BAR_WIN_Y0, w.y);
    return vec3(0.2, 0.11, 0.06) * room * (1.0 + 0.8 * top) + barCity * 0.6 * top;
  }
  float gx = fract((w.x + 0.1) / 0.62);
  float panel = softFill(max(abs(gx - 0.5) * 0.62 - 0.24, abs(w.y - 0.2) - 0.13), px);
  return vec3(0.14, 0.07, 0.04) * room * (0.8 + 0.3 * panel);
}

// The column between the window and the bar, at p: oxblood paint over a moulded base, a brass
// sconce near the top with an amber glass shade, lighting it.
vec3 barColumn(vec2 p) {
  vec2 w = barWorld(p, BAR_COL_Z);
  float px = barPx * BAR_COL_Z / BAR_F;
  float u = (w.x - BAR_COL_X0) / (BAR_COL_X1 - BAR_COL_X0);
  vec3 light = barAmbient * 1.5 + vec3(1.0, 0.62, 0.3) * 0.55 * barLevel * exp(-length((w - BAR_SCONCE) / vec2(0.3, 0.6))) + barLamp * 0.05 * u;
  vec3 c = vec3(0.2, 0.065, 0.05) * light * (0.85 + 0.15 * smoothstep(0.0, 0.15, u) * smoothstep(1.0, 0.85, u));
  c *= 1.0 - 0.3 * step(w.y, 0.25) + 0.25 * step(abs(w.y - 0.26), 0.012);
  float k = clamp((w.y - BAR_SCONCE.y + 0.05) / 0.1, 0.0, 1.0);
  float shade = max(abs(w.x - BAR_SCONCE.x) - mix(0.07, 0.04, k), abs(w.y - BAR_SCONCE.y) - 0.05);
  c = mix(c, vec3(0.5, 0.35, 0.15) * light, softFill(sdBox(w - BAR_SCONCE - vec2(0.0, -0.08), vec2(0.008, 0.04), 0.0), px));
  c = mix(c, vec3(1.0, 0.62, 0.3) * 0.9 * barLevel, softFill(shade, px));
  return c + vec3(1.0, 0.62, 0.3) * 0.12 * barLevel * exp(-length(w - BAR_SCONCE) / 0.15);
}

// A coat and a wet umbrella on the column's hook, at p (they reach over the window's edge); the
// umbrella drips from its tip into a small puddle (barFloor) while the world is wet.
void barCoat(vec2 p, inout vec3 col) {
  float z = BAR_COL_Z - 0.06;
  vec2 w = barWorld(p, z);
  if (w.x < -1.75 || w.x > -1.1 || w.y < 0.0 || w.y > 1.85) return;
  float px = barPx * z / BAR_F;
  vec2 hook = vec2(-1.43, 1.74);
  vec3 light = barAmbient * 1.6 + vec3(1.0, 0.62, 0.3) * 0.45 * barLevel * exp(-length((w - BAR_SCONCE) / vec2(0.4, 0.7))) + barCity * 0.4 * smoothstep(-1.35, -1.7, w.x);
  float hw = mix(0.07, 0.19, smoothstep(1.72, 1.52, w.y)) + 0.04 * smoothstep(1.4, 0.9, w.y);
  float coat = max(abs(w.x - hook.x + 0.03) - hw, max(0.92 - w.y + 0.02 * sin(w.x * 40.0), w.y - 1.74));
  float fold = 0.7 + 0.3 * sin((w.x - hook.x) * 55.0 + 1.3 * sin(w.y * 4.0));
  col = mix(col, wetten(vec3(0.34, 0.25, 0.15), barWet * 0.5, 0.8) * light * fold * (0.8 + 0.4 * smoothstep(1.3, 1.7, w.y)), softFill(coat, px));
  vec2 tip = vec2(-1.3, 0.84);
  float umb = min(min(barSeg(w, hook + vec2(0.1, -0.06), tip, 0.035, 0.006), barSeg(w, hook + vec2(0.1, -0.2), hook + vec2(0.115, -0.55), 0.05, 0.04)), max(abs(length(w - hook - vec2(0.06, -0.02)) - 0.04) - 0.009, hook.y - 0.02 - w.y));
  vec3 black = vec3(0.025, 0.025, 0.03) * light * 2.0 + barLamp * 0.02 + vec3(0.2, 0.22, 0.25) * barWet * 0.1 * smoothstep(0.02, 0.0, abs(w.x - hook.x - 0.13));
  col = mix(col, black, softFill(umb, px));
  // Dripping from its tip: one drip point, its lane lined up on the tip (README: rainDrips).
  float wetU = 0.6 * barWet;
  if (wetU > 0.02 && w.y < tip.y) {
    vec2 q = barAt(p, z);
    vec2 tipQ = vec2(tip.x, tip.y - BAR_EYE) * (BAR_F / z);
    float width = 0.045;
    float along = q.x - tipQ.x + (0.3 + 0.4 * hash12(vec2(0.0, 3.7))) * width;
    if (along >= 0.0 && along < width) col = mix(col, barLamp * 0.4 + vec3(1.0, 0.62, 0.3) * 0.3, rainDrips(vec2(along, (tipQ.y - q.y) * 0.6), uFallTime, wetU, width) * 0.85);
  }
}

// ---- The floor and the ceiling

// The floor at p: dark oak boards running away from you, the fan's light pooled on them, the
// counter's foot in shade, the window's cool light and the sign's red by the front wall, the
// stools' shadows, and the puddle under the dripping umbrella.
vec3 barFloor(vec2 p) {
  float z = min(BAR_F * BAR_EYE / max(-barAt(p, 2.6).y, 1e-3), 40.0);
  float x = barAt(p, z).x * z / BAR_F;
  vec3 P = vec3(x, 0.0, z);
  float f = fract(x / 0.14);
  float plank = floor(x / 0.14);
  float tone = (0.78 + 0.22 * hash12(vec2(plank, 3.0))) * (0.9 + 0.1 * hash12(vec2(plank, floor(z / 1.7 + hash12(vec2(plank, 9.0))))));
  float seam = 1.0 - smoothstep(0.0, barPx * z / BAR_F + 0.002, min(f, 1.0 - f) * 0.14);
  vec3 wood = vec3(0.2, 0.115, 0.065) * tone * (1.0 - 0.5 * seam);
  vec3 light = barAmbient * 1.8 + barFanLight(P, vec3(0.0, 1.0, 0.0)) * 1.8;
  if (x > BAR_COUNTER_X0 && z < BAR_COUNTER_Z) light *= 0.55 + 0.45 * smoothstep(0.0, 0.45, BAR_COUNTER_Z - z);
  if (z > BAR_COUNTER_Z) light += barShelf * 0.12;
  // The lamps' light spilling past the patrons onto the boards along the counter's foot.
  light += barLamp * 0.12 * barLampNear(x, 0.9) * smoothstep(1.4, 0.2, abs(z - BAR_COUNTER_Z + 0.4));
  light += (barCity * 1.6 + BAR_NEON * barSign * 0.1) * smoothstep(-0.9, -2.2, x) * smoothstep(1.0, 2.5, z);
  for (int k = 0; k < 4; k++) {
    vec2 s = vec2(BAR_STOOL_X[k], BAR_STOOL_Z + 0.04);
    vec2 d = (vec2(x, z) - s - normalize(s - BAR_FAN.xz + 1e-4) * 0.12) / vec2(0.26, 0.2);
    light *= 1.0 - 0.45 * exp(-dot(d, d) * 2.0);
  }
  vec3 c = wood * light;
  if (barWet > 0.05) {
    vec2 pd = (vec2(x, z) - vec2(-1.3, 2.42)) / vec2(0.16, 0.12);
    float puddle = softFill(length(pd) - 0.4 - 0.6 * smoothstep(0.1, 0.8, barWet), 0.08);
    c = mix(c, c * 0.5 + vec3(1.0, 0.62, 0.3) * 0.12 * barLevel + barCity * 0.5, puddle);
  }
  return c;
}

// The fan's blades in their plane, d metres from the hub (x across, y ahead), turned by angle:
// the distance to four walnut paddles on iron arms and the hub.
float barBlades(vec2 d, float angle) {
  float r = length(d);
  if (r > 0.72) return r - 0.66;
  float sector = 0.5 * BAR_PI;
  float a = mod(atan(d.y, d.x) - angle + 0.5 * sector, sector) - 0.5 * sector;
  vec2 l = vec2(cos(a), sin(a)) * r;
  float hw = mix(0.05, 0.075, smoothstep(0.15, 0.6, l.x));
  float blade = max(abs(l.y) - hw, max(0.17 - l.x, l.x - 0.66));
  float arm = max(abs(l.y) - 0.018, max(0.04 - l.x, l.x - 0.24));
  return min(min(blade, arm), r - 0.09);
}

// The pressed-tin ceiling at p: tiles with a raised border, a sunk square and a rosette, catching
// the light from below: warm over the counter and along the back bar, a pool round the fan's bowl,
// where the blades' shadows sweep round as they turn.
vec3 barCeiling(vec2 p) {
  float z = BAR_F * (BAR_CEIL - BAR_EYE) / max(p.y, 1e-3);
  float x = barAt(p, z).x * z / BAR_F;
  vec3 P = vec3(x, BAR_CEIL, z);
  vec2 f = fract(vec2(x, z) / 0.6) - 0.5;
  float size = BAR_F * (BAR_CEIL - BAR_EYE) * 0.6 / (z * z);
  float edge = max(abs(f.x), abs(f.y));
  float r = length(f);
  float petals = smoothstep(0.17, 0.07, r) * (0.6 + 0.4 * cos(atan(f.y, f.x) * 8.0));
  float relief = 0.22 * smoothstep(0.43, 0.47, edge) - 0.18 * smoothstep(0.02, 0.0, abs(edge - 0.33)) + 0.25 * petals - 0.1 * smoothstep(0.035, 0.0, r);
  vec3 tin = vec3(0.3, 0.22, 0.15) * (0.85 + relief * smoothstep(0.012, 0.03, size));
  vec3 light = barAmbient * 1.4 + barShelf * 0.22 * exp(-(BAR_BACK_Z - z) / 0.5);
  for (int i = 0; i < 4; i++) {
    vec2 d = vec2(x - barLampX(i), z - BAR_LAMP_Z) / vec2(0.9, 0.7);
    light += barLamp * 0.16 * exp(-dot(d, d));
  }
  // The bowl's light, a modest pool round the fan, and where it crosses the blades' plane on its
  // way up, their shadows.
  vec3 L = vec3(BAR_FAN.x, BAR_FAN_LAMP_Y, BAR_FAN.z);
  vec3 B = L + (P - L) * ((BAR_FAN.y - L.y) / (BAR_CEIL - L.y));
  float shadow = hardEdge(softFill(barBlades(B.xz - BAR_FAN.xz, barFanAngle), 0.012));
  vec2 fromFan = (P.xz - BAR_FAN.xz) / 1.1;
  light += barFanCol * 0.8 * exp(-dot(fromFan, fromFan)) * (1.0 - 0.85 * shadow);
  return tin * light;
}

// The fan hanging from the ceiling, over col at p: the downrod and the bronze motor housing, the
// four walnut blades seen from below as dark paddles against the lit tin, their edges catching the
// lamps' warm light, and the small frosted bowl glowing under the hub.
void barFan(vec2 p, inout vec3 col) {
  vec2 hub = vec2(BAR_FAN.x, BAR_FAN.y - BAR_EYE) * (BAR_F / BAR_FAN.z);
  vec2 q = barAt(p, BAR_FAN.z) - hub;
  if (abs(q.x) > 0.27 || q.y < -0.16) return;
  float m = BAR_FAN.z / BAR_F;
  vec2 lq = q * m;
  float px = barPx * m;
  float rod = sdBox(lq - vec2(0.0, 0.32), vec2(0.014, 0.2), 0.0);
  float motor = sdEllipse(lq - vec2(0.0, 0.06), vec2(0.12, 0.07));
  vec3 bronze = vec3(0.16, 0.11, 0.07) * (barAmbient * 2.0 + barLamp * 0.05) + barFanCol * 0.25 * smoothstep(0.03, -0.01, lq.y) + barShelf * 0.06 * smoothstep(0.07, 0.11, abs(lq.x));
  col = mix(col, bronze, softFill(min(rod, motor), px));
  float py = q.y + hub.y;
  if (py > 0.02) {
    float z = BAR_F * (BAR_FAN.y - BAR_EYE) / py;
    vec2 d = vec2(barAt(p, z).x * z / BAR_F - BAR_FAN.x, z - BAR_FAN.z);
    float dd = barBlades(d, barFanAngle);
    float aa = barPx * z * z / (BAR_F * (BAR_FAN.y - BAR_EYE));
    if (hardEdge(softFill(dd, aa)) > 0.0) {
      // Shaded by distance from the hub only, so a turning blade changes nothing inside itself:
      // dark wood, the bowl's glow near the hub, the lamps' warm light on the tips.
      float r = length(d);
      vec3 wood = vec3(0.09, 0.055, 0.032) * (0.9 + 0.1 * sin(r * 60.0));
      col = wood * (barAmbient * 2.5 + barFanCol * 0.8 * exp(-r / 0.2)) + (barLamp * 0.14 + barShelf * 0.06) * smoothstep(0.5, 0.64, r);
    }
  }
  float bowl = sdEllipse(lq - vec2(0.0, -0.13), vec2(0.07, 0.06));
  col += barFanCol * 0.15 * exp(-max(bowl, 0.0) / 0.05);
  col = mix(col, mix(barFanCol, vec3(1.0, 0.95, 0.85), 0.5) * 1.2, softFill(bowl, px));
}

// ---- The back bar

// What a shelf slot's bottle holds: whisky, gin, a bitter, a herbal liqueur, rum, a dark liqueur.
vec3 barLiquid(float slot) {
  float k = floor(hash12(vec2(slot, 11.3)) * 6.0);
  return k < 1.0 ? vec3(0.95, 0.5, 0.14) : k < 2.0 ? vec3(0.8, 0.83, 0.78) : k < 3.0 ? vec3(0.85, 0.1, 0.09) : k < 4.0 ? vec3(0.45, 0.75, 0.18) : k < 5.0 ? vec3(0.98, 0.66, 0.2) : vec3(0.4, 0.18, 0.07);
}

// One bottle, u across it and v up from its foot (m), out of focus by blur (m): its outline soft,
// its glints round bokeh discs a little brighter at the rim. h: its look (shape, glass, label,
// fill); glow: the strip above shining down through it; lamp: a pendant's light catching it from
// side (-1 left, 1 right). Colour and coverage.
vec4 barBottle(float u, float v, float h, vec3 liquid, float blur, vec3 glow, vec3 lamp, float side) {
  float form = floor(h * 4.0);
  float s = 0.9 + 0.2 * fract(h * 13.7);
  // body half-width, body top, shoulder top, neck half-width; neck top, cap half-width, cap top
  vec4 a = form < 1.0 ? vec4(0.044, 0.19, 0.225, 0.014) : form < 2.0 ? vec4(0.036, 0.19, 0.25, 0.012) : form < 3.0 ? vec4(0.047, 0.12, 0.165, 0.016) : vec4(0.03, 0.25, 0.28, 0.011);
  vec3 b = form < 1.0 ? vec3(0.285, 0.018, 0.305) : form < 2.0 ? vec3(0.32, 0.015, 0.34) : form < 3.0 ? vec3(0.2, 0.02, 0.215) : vec3(0.325, 0.013, 0.34);
  a.yz *= s;
  b.xz *= s;
  float w = b.y;
  if (v < a.y) w = a.x;
  else if (v < a.z) {
    float k = (v - a.y) / (a.z - a.y);
    w = mix(a.x, a.w, form < 1.0 ? sqrt(k) : smoothstep(0.0, 1.0, k));
  } else if (v < b.x) w = a.w * (1.0 + 0.3 * smoothstep(b.x - 0.012, b.x, v));
  float d = max(abs(u) - w, max(-v, v - b.z));
  float r = 1.5 * blur + 0.005;
  float l1 = length(vec2(u - side * a.x * 0.5, v - a.y * 0.75));
  float l2 = length(vec2(u - side * mix(a.x, a.w, 0.6) * 0.6, v - mix(a.y, a.z, 0.55)));
  float disc = max((1.0 - smoothstep(r * 0.85, r, l1)) * (0.8 + 0.2 * smoothstep(0.5 * r, 0.9 * r, l1)), 0.6 * (1.0 - smoothstep(r * 0.55, r * 0.7, l2)));
  float cover = softFill(d, blur);
  if (cover <= 0.0 && disc <= 0.0) return vec4(0.0);
  float tg = fract(h * 31.7);
  vec3 tint = tg < 0.4 ? vec3(0.8, 0.82, 0.76) : tg < 0.65 ? vec3(0.32, 0.58, 0.32) : tg < 0.85 ? vec3(0.62, 0.38, 0.18) : tg < 0.95 ? vec3(0.3, 0.42, 0.75) : vec3(0.9, 0.88, 0.82);
  float level = (0.3 + 0.65 * fract(h * 7.3)) * a.z;
  float filled = 1.0 - smoothstep(level - blur, level + blur, v);
  vec3 c = tint * mix(vec3(0.3), liquid, filled) * (glow * (0.35 + 0.65 * smoothstep(0.0, a.z, v)) + lamp * 0.55 + 0.02);
  // The liquid glows brightest just under its surface, where the light from above comes through.
  c += liquid * tint * glow * 0.5 * filled * exp(-max(level - v, 0.0) / 0.03);
  float lab = fract(h * 5.9);
  float label = softFill(max(abs(u) - a.x * 0.8, abs(v - a.y * 0.47) - a.y * 0.25), blur) * step(0.2, lab);
  vec3 paper = lab < 0.45 ? vec3(0.85, 0.8, 0.66) : lab < 0.65 ? vec3(0.08, 0.07, 0.06) : lab < 0.85 ? vec3(0.78, 0.6, 0.26) : vec3(0.55, 0.1, 0.1);
  c = mix(c, paper * (glow * 0.25 + lamp * 0.8 + 0.03), label);
  c = mix(c, (lab < 0.5 ? vec3(0.7, 0.55, 0.25) : vec3(0.06)) * (glow * 0.3 + lamp * 0.7 + 0.03), smoothstep(b.x - blur, b.x + blur, v));
  c += (lamp * 1.3 + glow * 0.25) * mix(vec3(1.0), tint, 0.35) * disc;
  return vec4(c, max(cover, disc));
}

// What the mirror shows at p: the room behind you, dim and warm, a touch higher than straight
// across (it leans forward): the lamps from their far side, the front window with the street and
// OPEN reading the right way round, the faces of whoever sits at the bar.
vec3 barMirror(vec2 p) {
  vec2 m = barAt(p, 6.2) - vec2(0.0, BAR_MIRROR_SHIFT);
  vec3 c = vec3(0.035, 0.026, 0.022) + barLamp * 0.03 * smoothstep(-0.05, 0.2, m.y) + barShelf * 0.03;
  for (int i = 0; i < 4; i++) {
    float zi = 2.0 * BAR_BACK_Z - BAR_LAMP_Z;
    float r = length(m - vec2(barLampX(i), BAR_LAMP_Y - 0.02 - BAR_EYE) * (BAR_F / zi));
    c += barLamp * (0.7 * (1.0 - smoothstep(0.004, 0.007, r)) + 0.1 * exp(-r / 0.02));
  }
  float zw = 2.0 * BAR_BACK_Z - BAR_WIN_Z;
  vec2 w = m * (zw / BAR_F) + vec2(0.0, BAR_EYE);
  if (w.x < BAR_WIN_X1 && w.y > BAR_WIN_Y0 && w.y < BAR_WIN_Y1) {
    vec3 street = barCity * 0.9 + BAR_SODIUM * 0.15 * exp(-abs(w.x + 2.8) / 0.25) * smoothstep(0.9, 2.0, w.y);
    float bars = max(step(abs(w.x - BAR_MULLION_X), 0.04), step(abs(w.y - BAR_TRANSOM_Y), 0.04));
    c = mix(street, vec3(0.03, 0.04, 0.035), bars);
    if (barSign > 0.0 && K_sign > 0.5) {
      float zs = 2.0 * BAR_BACK_Z - BAR_SIGN.z;
      vec2 od = barOpen(m * (zs / BAR_F) + vec2(0.0, BAR_EYE) - BAR_SIGN.xy, false);
      c += BAR_NEON * barSign * ((1.0 - smoothstep(0.018, 0.03, od.x)) * 0.9 + exp(-od.x / 0.04) * 0.2);
      c += vec3(0.3, 0.5, 1.0) * barSign * ((1.0 - smoothstep(0.018, 0.03, od.y)) * 0.6 + exp(-od.y / 0.04) * 0.12);
    }
  }
  // The faces sit a little higher again, where the mirror leans out most.
  float zf = 2.0 * BAR_BACK_Z - BAR_STOOL_Z;
  for (int k = 0; k < 4; k++) {
    if (barP0[k].z < 0.9 || barP1[k].x <= 0.0) continue;
    vec2 fq = (m - vec2(0.0, 0.03) - vec2(barP0[k].x + 0.03 * barP1[k].z, 1.53 - BAR_EYE) * (BAR_F / zf)) * (zf / BAR_F);
    float face = sdEllipse(fq, vec2(0.08, 0.1));
    if (face < 0.01) {
      float h = barP1[k].x;
      vec3 skin = mix(vec3(0.72, 0.5, 0.38), vec3(0.42, 0.27, 0.19), step(0.6, fract(h * 2.71))) * (barLamp * 0.5 + barShelf * 0.2 + 0.03);
      vec3 hair = mix(vec3(0.05, 0.04, 0.03), vec3(0.3, 0.16, 0.08), fract(h * 9.1)) * 0.5;
      c = mix(c, fq.y > 0.03 - 0.6 * fq.x * fq.x ? hair : skin, softFill(face, 0.006));
    }
  }
  return c * 0.85;
}

// How far along the M's stroke (0 at its foot on the left .. ~3.4 at its foot on the right) lies
// the point of it nearest q.
float barMarkAlong(vec2 q) {
  float best = 1e3;
  float along = 0.0;
  float run = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 a = markVertex(i);
    vec2 ba = markVertex(i + 1) - a;
    float u = clamp(dot(q - a, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(q - a - ba * u);
    if (d < best) {
      best = d;
      along = run + u * length(ba);
    }
    run += length(ba);
  }
  return along;
}

// The Manifold M on the upper mirror at w (m on the wall), over col. Etched (K_mark 1): the frosting
// barely shows; what you see are glints where the lamps catch the cut, at its two peaks and its
// middle, and now and then (and on the trigger) a glint of light running along it. Neon (2): an
// amber tube on standoffs, its reflection doubling it just behind, a glow round it; now and then a
// stroke stutters, and on the trigger the whole M.
vec3 barMark(vec2 w, float px, vec3 col, inout float accent) {
  vec2 q = (w - BAR_MARK.xy) / BAR_MARK.z;
  if (abs(q.x) > 1.4 || abs(q.y) > 1.4) return col;
  float e = px / BAR_MARK.z;
  float since = sinceTriggerM(TRIGGER_mark);
  float pick = 0.0;
  if (K_mark < 1.5) {
    float d = markDistance(q);
    float age = barEvent(barTm, 41.0, 77.0, pick);
    float run = since >= 0.0 && since < 3.0 ? since : age >= 0.0 && age < 3.0 ? age : -10.0;
    float a = barMarkAlong(q);
    float glint = step(0.0, run) * bell((a - (run * 1.4 - 0.2)) / 0.22);
    float stroke = softFill(d - 0.07, e);
    float cut = softFill(abs(d - 0.07) - 0.014, e);
    float lit = 0.55 + 0.45 * barLampNear(BAR_MARK.x * BAR_LAMP_Z / BAR_BACK_Z, 0.9);
    float spots = max(bell((a - 1.0) / 0.07), bell((a - 2.494) / 0.07)) * 0.8 + bell((a - 1.747) / 0.05) * 0.5;
    float shine = max(spots * lit, glint);
    col += (barLamp + barShelf) * 0.02 * stroke;
    col += mix(barLamp, vec3(1.0, 0.95, 0.85), 0.4) * 0.7 * shine * cut;
    accent = max(accent, cut * shine);
    return col;
  }
  float age = barEvent(barTm, 37.0, 71.0, pick);
  float stutter = step(0.0, age) * step(age, 0.9) * step(0.0, sin(age * 37.0)) * step(pick, 0.7);
  float whole = step(0.0, since) * step(since, 1.2) * step(0.0, sin(since * 31.0));
  vec4 sel = vec4(equal(ivec4(int(floor(pick * 4.0))), ivec4(0, 1, 2, 3)));
  vec4 on = max(1.0 - sel * 0.85 * stutter - vec4(0.85 * whole), 0.0);
  vec4 ds = vec4(segmentDistance(q, M0, M1), segmentDistance(q, M1, M2), segmentDistance(q, M2, M3), segmentDistance(q, M3, M4));
  vec2 qr = q - vec2(-0.16, -0.09);
  vec4 dr = vec4(segmentDistance(qr, M0, M1), segmentDistance(qr, M1, M2), segmentDistance(qr, M2, M3), segmentDistance(qr, M3, M4));
  vec4 tube = 1.0 - smoothstep(vec4(0.05 - e), vec4(0.05 + e), ds);
  vec4 tubeR = (1.0 - smoothstep(vec4(0.045 - e), vec4(0.045 + e), dr)) * on;
  vec4 lit4 = tube * on;
  vec4 g = exp(-ds / 0.12) * on;
  float glass = max(max(tube.x, tube.y), max(tube.z, tube.w));
  float lit = max(max(lit4.x, lit4.y), max(lit4.z, lit4.w));
  float litR = max(max(tubeR.x, tubeR.y), max(tubeR.z, tubeR.w));
  float glow = 0.5 * (max(g.x, g.y) + max(g.z, g.w));
  col += uAccent * (glow * 0.35 + litR * 0.3);
  col = mix(col, vec3(0.15, 0.1, 0.08), glass * 0.7);
  col = mix(col, mix(uAccent, vec3(1.0), 0.5), lit);
  accent = max(accent, max(lit, min(glow * 0.5 + litR * 0.4, 1.0)));
  return col;
}

// The back counter under the first shelf, s on the shelves' plane (m): glasses standing upside
// down in a row, and the brass till with its little lit display.
vec3 barBackCounter(vec2 s, float px, vec3 light, vec3 col) {
  vec2 tq = s - vec2(2.5, 1.17);
  if (sdBox(tq, vec2(0.21, 0.13), 0.0) - 0.02 < 0.0) {
    vec3 brass = vec3(0.5, 0.34, 0.13) * (light * 1.6 + barLamp * 0.2) * (0.8 + 0.2 * step(0.5, fract(tq.x / 0.05 + 0.25)) * step(tq.y, 0.0));
    return mix(brass, vec3(0.25, 0.9, 0.55) * 0.5, softFill(sdBox(tq - vec2(0.0, 0.1), vec2(0.07, 0.018), 0.0), px));
  }
  float gx = (fract(s.x / 0.085) - 0.5) * 0.085;
  float glass = softFill(sdBox(vec2(gx, s.y - 1.09), vec2(0.03, 0.065), 0.0), px);
  float edge = glass * (1.0 - smoothstep(0.0, 0.007, 0.03 - abs(gx)));
  return mix(col, col * 0.75 + light * 0.18, glass * 0.6) + barShelf * 0.35 * edge;
}

// The back wall at p: a doorway to the back room at the far left; the cornice; carved pilasters
// behind the lamps; between them the mirror, its silvering foxed at the edges, the arched upper
// mirror with the M, two glass shelves of bottles with a strip of light under each, the back
// counter below. taken: the lower-shelf slot whose bottle the bartender has. accent: the M.
vec3 barBackWall(vec2 p, float taken, out float accent) {
  accent = 0.0;
  vec2 w = barWorld(p, BAR_BACK_Z);
  float px = barPx * BAR_BACK_Z / BAR_F;
  vec3 wood = vec3(0.15, 0.075, 0.042);
  vec3 light = barAmbient * 1.4 + barShelf * 0.2 + barLamp * 0.12 * barLampNear(w.x * BAR_LAMP_Z / BAR_BACK_Z, 0.6);
  if (w.y > BAR_CORNICE_Y) {
    float v = (w.y - BAR_CORNICE_Y) / (BAR_CEIL - BAR_CORNICE_Y);
    float dentil = step(0.5, fract(w.x / 0.09)) * step(0.12, v) * step(v, 0.3);
    return wood * light * (0.75 + 0.25 * sin(v * 20.0)) * (1.0 + 0.6 * dentil) * (1.0 + 1.2 * smoothstep(0.25, 0.0, v));
  }
  if (w.x < BAR_BACKBAR_X0 - 0.08) {
    vec3 c = vec3(0.13, 0.085, 0.06) * light;
    float door = softFill(sdBox(w - vec2(-2.22, 1.05), vec2(0.2, 1.05), 0.0), px);
    c = mix(c, wood * light * 1.3, max(softFill(sdBox(w - vec2(-2.22, 1.08), vec2(0.25, 1.1), 0.0), px) - door, 0.0));
    return mix(c, vec3(0.02, 0.015, 0.012) + vec3(0.035, 0.02, 0.008) * smoothstep(1.6, 0.2, w.y), door);
  }
  float pd = abs(w.x - BAR_BACKBAR_X0 + 0.03) - 0.07;
  for (int i = 0; i < 4; i++) pd = min(pd, abs(w.x - barLampX(i) * BAR_BACK_Z / BAR_LAMP_Z) - 0.065);
  if (pd < 0.0) {
    float u = clamp(-pd / 0.065, 0.0, 1.0);
    float cap = smoothstep(2.42, 2.45, w.y) * (1.0 - 0.3 * step(2.55, w.y));
    return wood * 1.25 * light * (0.8 + 0.2 * cos(u * 3.0 * BAR_PI)) * (1.0 + 0.5 * cap) * (0.7 + 0.3 * smoothstep(0.0, 0.25, u));
  }
  vec3 col = barMirror(p) * (0.6 + 0.4 * smoothstep(0.0, 0.18, pd + 0.06 * vnoise(w * 9.0)));
  if (w.y > BAR_UPPER_Y) {
    float left = BAR_BACKBAR_X0 + 0.04;
    float right = 8.0;
    for (int i = 0; i < 4; i++) {
      float c = barLampX(i) * BAR_BACK_Z / BAR_LAMP_Z;
      if (c < w.x) left = max(left, c + 0.065);
      else right = min(right, c - 0.065);
    }
    float u = clamp((w.x - left) / max(right - left, 0.1), 0.0, 1.0);
    float s2 = 2.0 * u - 1.0;
    float arch = 2.5 + 0.11 * sqrt(max(1.0 - s2 * s2, 0.0));
    if (w.y > arch) return wood * light * (0.85 + 0.3 * smoothstep(arch + 0.02, arch, w.y));
    if (w.y < BAR_UPPER_Y + 0.03) return wood * light * 1.1;
    if (K_mark > 0.0) col = barMark(w, px, col, accent);
    return col;
  }
  // The bottles stand on the shelves just in front of the mirror.
  vec2 s = barWorld(p, BAR_SHELF_Z);
  float sx = s.x * BAR_LAMP_Z / BAR_SHELF_Z;
  float lampHere = barLampNear(sx, 0.45);
  float side = sign(barLampX(int(clamp(floor((sx - BAR_LAMP_X0) / BAR_LAMP_DX + 0.5), 0.0, 3.0))) - sx + 1e-4);
  if (s.y < BAR_SHELF_Y0 - 0.012) {
    col = barBackCounter(s, px, light, col);
  } else {
    bool upper = s.y > BAR_SHELF_Y1 - 0.012;
    float row = upper ? 1.0 : 0.0;
    float slot = floor((s.x - BAR_SLOT_X0) / BAR_SLOT_W);
    bool present = slot >= 0.0 && (upper ? hash12(vec2(slot, 21.0)) < 0.88 : abs(slot - taken) > 0.5);
    if (present) {
      float u = s.x - (BAR_SLOT_X0 + (slot + 0.5) * BAR_SLOT_W) - (hash12(vec2(slot, row + 3.0)) - 0.5) * 0.018;
      float blur = mix(0.0015, 0.011, K_bokeh) + 0.5 * px;
      vec4 b = barBottle(u, s.y - (upper ? BAR_SHELF_Y1 : BAR_SHELF_Y0) - 0.012, hash12(vec2(slot * 1.37 + 5.0, row * 7.1 + 1.0)), barLiquid(slot + 500.0 * row), blur, barShelf * 0.85, barLamp * lampHere, side);
      col = mix(col, b.rgb, b.a);
    }
  }
  for (int j = 0; j < 2; j++) {
    float dy = s.y - (j == 0 ? BAR_SHELF_Y0 : BAR_SHELF_Y1);
    col = mix(col, vec3(0.3, 0.42, 0.36) * light + barLamp * 0.35 * lampHere, softFill(abs(dy) - 0.011, px) * 0.85);
    col += barShelf * 0.9 * softFill(abs(dy + 0.017) - 0.004, px);
  }
  return col;
}

// ---- The bartender

struct BarTender {
  vec2 ha;      // hands: a on the screen's left, b on its right
  vec2 hb;
  vec2 ea;      // elbows
  vec2 eb;
  vec2 head;    // the head's centre
  float yaw;    // head turn, + to the right
  float pitch;  // + looking up
  float width;  // shoulder width, narrowing as he turns
  float back;   // 0 facing you .. 1 his back to you
  float lean;   // stooping over the counter (m)
  float tilt;   // how far he tips the bottle or the shaker, pouring, 0..1
  vec2 shaker;  // where the shaker is while he shakes
};

// His pose from the simulation's action (barB0) and the clock: every action starts and ends with
// his hands resting on the counter, so one flows into the next.
BarTender barTenderPose() {
  BarTender T;
  int act = int(barB0.y + 0.5);
  float age = barB0.z;
  float dur = barB0.w;
  float env = smoothstep(0.0, 0.6, age) * (1.0 - smoothstep(dur - 0.6, dur, age));
  T.back = act == BAR_FETCH || act == BAR_PUT ? smoothstep(0.1, 0.6, age) * (1.0 - smoothstep(dur - 0.6, dur - 0.1, age)) : 0.0;
  T.width = mix(1.0, 0.62, sin(BAR_PI * T.back));
  T.tilt = 0.0;
  T.pitch = -0.05;
  T.yaw = barB1.z * 0.9;
  T.shaker = vec2(0.17, 1.5);
  vec2 restA = vec2(-0.21, 1.08);
  vec2 restB = vec2(0.21, 1.08);
  vec2 ta = restA;
  vec2 tb = restB;
  float lean = 0.0;
  if (act == BAR_POLISH) {
    // a glass held up in one hand, the towel going round inside it
    tb = vec2(0.07, 1.26);
    ta = vec2(0.03 + 0.032 * cos(barTm * 3.4), 1.3 + 0.018 * sin(barTm * 3.4));
    T.pitch = -0.4;
  } else if (act == BAR_WALK) {
    float sw = sin(barB0.x / 0.65 * BAR_PI) * 0.035;
    ta = vec2(-0.25, 1.0 + sw);
    tb = vec2(0.25, 1.0 - sw);
  } else if (act == BAR_CHAT) {
    // leaning on the counter, nodding now and then; come over to you, a little wave hello
    ta = vec2(-0.27, 1.085);
    tb = vec2(0.27, 1.085);
    lean = 0.035;
    T.pitch = 0.1 * sin(barTm * 1.9) * max(sin(barTm * 0.7), 0.0);
    float wave = barB1.w * smoothstep(0.2, 0.7, age) * (1.0 - smoothstep(1.8, 2.4, age));
    tb = mix(tb, vec2(0.3, 1.52 + 0.025 * sin(barTm * 9.0)), wave);
    T.yaw *= 1.0 - barB1.w;
  } else if (act == BAR_FETCH || act == BAR_PUT) {
    // turned to the shelf, reaching up for the bottle behind him, or putting it back
    float grab = act == BAR_FETCH ? BAR_FETCH_GRAB : BAR_PUT_RELEASE;
    float reach = smoothstep(grab - 0.7, grab - 0.2, age) * (1.0 - smoothstep(grab + 0.1, grab + 0.6, age));
    tb = mix(vec2(0.24, 1.24), vec2(0.15, 1.62), reach);
    T.pitch = 0.25 * reach;
  } else if (act == BAR_POUR || act == BAR_STRAIN) {
    // the glass set down on the counter, then the bottle (or the shaker) tipped over it
    float setAt = act == BAR_POUR ? BAR_POUR_SET : BAR_STRAIN_SET;
    float f0 = act == BAR_POUR ? BAR_POUR_FLOW0 : BAR_STRAIN_FLOW0;
    float f1 = act == BAR_POUR ? BAR_POUR_FLOW1 : BAR_STRAIN_FLOW1;
    float place = smoothstep(setAt - 0.5, setAt - 0.1, age) * (1.0 - smoothstep(setAt, setAt + 0.4, age));
    ta = mix(restA, vec2(BAR_POUR_REACH - 0.02, 1.1), place);
    T.tilt = smoothstep(f0 - 0.4, f0, age) * (1.0 - smoothstep(f1, f1 + 0.4, age));
    float ang = T.tilt * (act == BAR_POUR ? 2.0 : 1.7);
    vec2 axis = vec2(-sin(ang), cos(ang));
    tb = mix(vec2(0.26, 1.22), vec2(BAR_POUR_REACH, 1.3) - axis * 0.2, T.tilt);
    if (act == BAR_STRAIN) ta = mix(ta, tb + axis * 0.12, T.tilt);
    T.pitch = -0.3;
  } else if (act == BAR_SHAKE) {
    T.shaker = vec2(0.17, 1.5) + vec2(0.5, 0.86) * 0.035 * sin(barTm * 17.0) * env;
    ta = T.shaker + vec2(-0.02, 0.08);
    tb = T.shaker + vec2(0.02, -0.07);
    T.pitch = 0.05;
  } else if (act == BAR_WIPE) {
    tb = vec2(0.1 + 0.1 * cos(barTm * 1.5), 1.085 + 0.006 * sin(barTm * 1.5));
    lean = 0.04;
    T.pitch = -0.35;
  } else if (act == BAR_CLEAR) {
    float reach = smoothstep(0.2, 0.7, age);
    tb = mix(mix(restB, vec2(BAR_POUR_REACH, 1.12), reach), vec2(0.22, 1.22), smoothstep(BAR_CLEAR_TAKE, BAR_CLEAR_TAKE + 0.5, age));
    tb = mix(tb, vec2(0.24, 0.92), smoothstep(1.5, 2.0, age));
    T.pitch = -0.2;
  } else if (act == BAR_BELL) {
    // last call: standing tall, the brass hand bell lifted high in his right hand and rung, his
    // left on the counter, looking out over the room
    tb = vec2(0.27, 1.74);
    ta = vec2(-0.24, 1.1);
    T.pitch = 0.12;
    T.yaw = 0.0;
  }
  T.ha = mix(restA, ta, env);
  T.hb = mix(restB, tb, env);
  T.lean = lean * env;
  // Passage: arriving, he looks up from what he is doing and nods hello; leaving, he gives a small
  // wave with his free hand (screen left) and looks your way. Nothing at rest.
  float pin = passageIn();
  float pout = passageOut();
  if (pin < 1.0 || pout > 0.0) {
    float tin = pin * BAR_ENTER;
    float tout = pout * BAR_EXIT;
    float facing = 1.0 - T.back;
    float look = smoothstep(0.7, 1.2, tin) * (1.0 - smoothstep(2.3, BAR_ENTER, tin));
    float nod = sin(BAR_PI * clamp((tin - 1.3) / 0.8, 0.0, 1.0));
    float wave = smoothstep(0.1, 0.5, tout) * facing;
    float gaze = max(look * facing, wave);
    T.yaw = mix(T.yaw, -0.5, gaze);
    T.pitch = mix(T.pitch, 0.2, gaze);
    T.lean += 0.05 * nod * facing;
    T.ha = mix(T.ha, vec2(-0.3 + 0.07 * sin(barTm * 8.0), 1.5), wave);
  }
  float ys = 1.45 - T.lean;
  float w = 0.19 * T.width;
  T.ea = barElbow(vec2(-w + 0.05, ys - 0.065), T.ha, 0.3, 0.29, -1.0);
  T.eb = barElbow(vec2(w - 0.05, ys - 0.065), T.hb, 0.3, 0.29, 1.0);
  float bob = act == BAR_WALK ? 0.012 * abs(sin(barB0.x / 0.65 * BAR_PI)) : 0.0;
  T.head = vec2(0.03 * sin(T.yaw) * (1.0 - T.back), 1.66 - 1.3 * T.lean + 0.02 * T.pitch + bob);
  return T;
}

// His figure, q metres from the floor under him: distance; part 0 vest, 1 shirt sleeve, 2 skin,
// 3 head. Facing you his arms are in front of him; turned away, behind.
float barTenderShape(vec2 q, BarTender T, out float part) {
  float w = 0.19 * T.width;
  float ys = 1.45 - T.lean;
  float body = smin(barSeg(q, vec2(0.0, 0.95), vec2(0.0, ys - 0.09), 0.16 * T.width + 0.015, 0.17 * T.width + 0.015), barSeg(q, vec2(-w + 0.06, ys - 0.045), vec2(w - 0.06, ys - 0.045), 0.062, 0.062), 0.05);
  vec2 sa = vec2(-w + 0.05, ys - 0.065);
  vec2 sb = vec2(w - 0.05, ys - 0.065);
  float sleeve = min(min(barSeg(q, sa, T.ea, 0.058, 0.05), barSeg(q, sb, T.eb, 0.058, 0.05)), min(barSeg(q, T.ea, mix(T.ea, T.ha, 0.25), 0.053, 0.05), barSeg(q, T.eb, mix(T.eb, T.hb, 0.25), 0.053, 0.05)));
  float skin = min(min(barSeg(q, T.ea, T.ha, 0.044, 0.036), barSeg(q, T.eb, T.hb, 0.044, 0.036)), min(length(q - T.ha), length(q - T.hb)) - 0.042);
  float neck = barSeg(q, vec2(0.0, ys - 0.01), T.head - vec2(0.0, 0.07), 0.05, 0.046);
  float head = min(sdEllipse(q - T.head, vec2(0.086, 0.106)), sdEllipse(vec2(abs(q.x - T.head.x) - 0.084 * mix(1.0, 0.7, abs(sin(T.yaw))), q.y - T.head.y + 0.005), vec2(0.018, 0.03)));
  float d = min(min(min(body, sleeve), min(skin, neck)), head);
  bool front = T.back < 0.5;
  if (head < 0.0) part = 3.0;
  else if (front && skin < 0.0) part = 2.0;
  else if (front && sleeve < 0.0) part = 1.0;
  else if (neck < 0.0) part = 2.0;
  else if (body < 0.0) part = 0.0;
  else if (sleeve < 0.0) part = 1.0;
  else if (skin < 0.0) part = 2.0;
  else part = body <= d + 1e-5 ? 0.0 : sleeve <= d + 1e-5 ? 1.0 : 2.0;
  return d;
}

// His colours: a dark burgundy waistcoat over a white shirt, sleeves rolled to the elbow, a bow
// tie; dark hair, a moustache; from behind, the waistcoat's back and his hair.
vec3 barTenderAlbedo(vec2 q, BarTender T, float part) {
  vec3 shirt = vec3(0.86, 0.83, 0.77);
  vec3 vest = vec3(0.11, 0.035, 0.04);
  vec3 skin = vec3(0.78, 0.55, 0.42);
  vec3 hair = vec3(0.07, 0.05, 0.04);
  float ys = 1.45 - T.lean;
  if (part == 1.0) return shirt;
  if (part == 2.0) return skin;
  if (part == 0.0) {
    if (T.back > 0.5) return vest * 0.8;
    float vee = step(abs(q.x), 0.075 * clamp((q.y - (ys - 0.32)) / 0.3, 0.0, 1.0)) * step(ys - 0.32, q.y);
    float bow = step(abs(q.x), 0.045) * step(abs(q.y - ys + 0.03), 0.01 + 0.01 * abs(q.x) / 0.045);
    return bow > 0.5 ? vec3(0.04, 0.02, 0.02) : vee > 0.5 ? shirt : vest;
  }
  if (T.back > 0.5) return hair;
  vec2 hq = q - T.head;
  float turn = 0.035 * sin(T.yaw);
  if (hq.y > 0.04 - 0.6 * (hq.x - turn) * (hq.x - turn) || (abs(hq.x - turn) > 0.075 && hq.y > -0.01)) return hair;
  vec2 fq = hq - vec2(turn, 0.02 * T.pitch);
  float eyes = min(length((fq - vec2(-0.032, 0.012)) / vec2(1.0, 0.55)), length((fq - vec2(0.032, 0.012)) / vec2(1.0, 0.55))) - 0.011;
  float moustache = sdBox(fq - vec2(0.0, -0.038), vec2(0.03, 0.007), 0.0) - 0.003;
  if (eyes < 0.0 || moustache < 0.0) return hair * 0.8;
  return skin * (0.85 + 0.15 * smoothstep(-0.02, 0.04, fq.y));
}

// The bartender at p, if he is on, over col: his figure lit by the lamps in front of him and
// rimmed by the bottles' glow behind, and what he holds: the glass and towel he polishes, the
// bottle from the shelf (the stream as he pours), the shaker, a glass he clears, the last-call bell.
void barTender(vec2 p, inout vec3 col) {
  if (K_bartender < 0.5) return;
  vec2 q = barWorld(p, BAR_BT_Z) - vec2(barB0.x, 0.0);
  if (abs(q.x) > 0.6 || q.y < 0.88 || q.y > 1.92) return;
  float pxm = barPx * BAR_BT_Z / BAR_F;
  BarTender T = barTenderPose();
  int act = int(barB0.y + 0.5);
  float part = 0.0;
  float d = barTenderShape(q, T, part);
  // Turned to the shelf, what he holds is in front of him, so behind him from here.
  float figure = hardEdge(softFill(d, pxm));
  float shown = 1.0 - figure * step(0.5, T.back);
  if (figure > 0.0) {
    float tmp = 0.0;
    vec2 n = normalize(vec2(barTenderShape(q + vec2(0.01, 0.0), T, tmp) - d, barTenderShape(q + vec2(0.0, 0.01), T, tmp) - d) + 1e-6);
    float inner = clamp(-d / 0.08, 0.0, 1.0);
    vec3 N = normalize(vec3(n * (1.0 - 0.7 * inner), -0.7));
    vec3 key = barLampLight(vec3(barB0.x + q.x, q.y, BAR_BT_Z - 0.2), N) * 1.1 + barAmbient * 1.5 + barShelf * 0.06;
    float rim = 1.0 - smoothstep(0.0, max(0.02, 2.5 * pxm), -d);
    col = barTenderAlbedo(q, T, part) * key + barShelf * rim * 0.6 * (0.55 + 0.45 * max(n.y, 0.0));
  }
  vec3 lit = barLampLight(vec3(barB0.x + q.x, q.y, BAR_BT_Z - 0.3), vec3(0.0, 0.3, -0.95)) + barAmbient * 2.0 + barShelf * 0.1;
  float carry = barB1.x;
  if (act == BAR_POLISH) {
    float glass = sdBox(q - T.hb - vec2(0.0, 0.05), vec2(0.035, 0.045), 0.0) - 0.004;
    col = mix(col, col * 0.5 + lit * (0.2 + 0.4 * (1.0 - smoothstep(0.0, 0.008, -glass))), hardEdge(softFill(glass, pxm)));
    col = mix(col, vec3(0.85, 0.83, 0.78) * lit * (0.8 + 0.2 * sin(q.y * 120.0)), hardEdge(softFill(barSeg(q, T.ha + vec2(0.0, 0.02), T.ha + vec2(0.035, -0.13), 0.03, 0.05), pxm)));
  }
  if (act == BAR_WIPE) col = mix(col, vec3(0.85, 0.83, 0.78) * lit, hardEdge(softFill(barSeg(q, T.hb, T.hb + vec2(0.05, -0.03), 0.04, 0.035), pxm)));
  if (abs(carry - BAR_CARRY_BOTTLE) < 0.5) {
    float ang = act == BAR_POUR ? T.tilt * 2.0 : 0.0;
    vec2 axis = vec2(-sin(ang), cos(ang));
    vec2 rel = q - T.hb;
    float slot = barB1.y;
    vec4 b = barBottle(dot(rel, vec2(axis.y, -axis.x)), dot(rel, axis) + 0.1, hash12(vec2(slot * 1.37 + 5.0, 1.0)), barLiquid(slot), pxm, barShelf * 0.6, lit, 1.0);
    col = mix(col, b.rgb, hardEdge(b.a) * shown);
    if (act == BAR_POUR && T.tilt > 0.9) {
      vec2 mouth = T.hb + axis * 0.2;
      float yEnd = BAR_EYE + (BAR_TOP_Y + 0.08 - BAR_EYE) * BAR_BT_Z / BAR_GLASS_Z;
      col = mix(col, barLiquid(slot) * (lit * 1.3 + 0.1), hardEdge(softFill(barSeg(q, mouth, vec2(mouth.x + 0.004, yEnd), max(0.006, pxm), max(0.005, 0.9 * pxm)), pxm)));
    }
  }
  if (act == BAR_SHAKE || (act == BAR_STRAIN && abs(carry - BAR_CARRY_SHAKER) < 0.5)) {
    float env = smoothstep(0.0, 0.6, barB0.z);
    vec2 c0 = act == BAR_SHAKE ? mix(vec2(0.22, 1.12), T.shaker, env) : T.hb;
    float ang = act == BAR_SHAKE ? 0.45 : T.tilt * 1.7;
    vec2 axis = vec2(-sin(ang), cos(ang));
    vec2 rel = q - c0;
    vec2 l = vec2(dot(rel, vec2(axis.y, -axis.x)), dot(rel, axis));
    vec3 steel = vec3(0.5, 0.52, 0.55) * (lit * 0.7 + 0.04) + barShelf * 0.6 * smoothstep(0.015, 0.03, l.x);
    col = mix(col, steel, hardEdge(softFill(barSeg(l, vec2(0.0, -0.09), vec2(0.0, 0.08), 0.045, 0.036), pxm)));
    if (act == BAR_STRAIN && T.tilt > 0.9) {
      vec2 mouth = c0 + axis * 0.09;
      float yEnd = BAR_EYE + (BAR_TOP_Y + 0.13 - BAR_EYE) * BAR_BT_Z / BAR_GLASS_Z;
      col = mix(col, vec3(0.95, 0.55, 0.45) * (lit * 1.2 + 0.1), hardEdge(softFill(barSeg(q, mouth, vec2(mouth.x + 0.004, yEnd), max(0.006, pxm), max(0.005, 0.9 * pxm)), pxm)));
    }
  }
  if (abs(carry - BAR_CARRY_GLASS) < 0.5) {
    float glass = sdBox(q - T.hb - vec2(0.0, 0.05), vec2(0.035, 0.045), 0.0) - 0.004;
    col = mix(col, col * 0.5 + lit * 0.35, hardEdge(softFill(glass, pxm)));
  }
  if (act == BAR_BELL) {
    // The bell hangs from the hand by its wooden handle, swinging as he rings it.
    float ring = smoothstep(0.5, 0.8, barB0.z) * (1.0 - smoothstep(BAR_BELL_TIME - 1.0, BAR_BELL_TIME - 0.5, barB0.z));
    float swing = 0.55 * sin(barB0.z * TAU * 2.3) * ring;
    vec2 down = vec2(sin(swing), -cos(swing));
    vec2 rel = q - T.hb;
    vec2 l = vec2(dot(rel, vec2(-down.y, down.x)), dot(rel, down));
    float handle = barSeg(l, vec2(0.0, -0.035), vec2(0.0, 0.025), 0.011, 0.009);
    float flare = clamp((l.y - 0.025) / 0.07, 0.0, 1.0);
    float bell = min(max(abs(l.x) - mix(0.02, 0.043, flare * flare), max(0.025 - l.y, l.y - 0.095)), length(l - vec2(0.0, 0.03)) - 0.021);
    vec3 brass = vec3(0.7, 0.5, 0.18) * (lit * 1.5 + 0.06) + barShelf * 0.25 * smoothstep(0.0, 0.04, l.x);
    col = mix(col, vec3(0.16, 0.08, 0.04) * (lit + 0.05), hardEdge(softFill(handle, pxm)));
    col = mix(col, brass, hardEdge(softFill(bell, pxm)));
  }
}

// ---- The counter and the glasses on it

// A glass on the counter, q metres from the middle of its foot: a tumbler, a wine glass, a coupe
// or a highball, filled to fill with liquid, lit by light. Thin walls show as bright edges; the
// room shows through. Colour and coverage.
vec4 barGlass(vec2 q, float kind, float fill, vec3 liquid, vec3 light, float px) {
  float stem = max(0.004, 0.8 * px);
  float d;
  float wet;
  if (kind < 0.5) {
    d = sdBox(q - vec2(0.0, 0.045), vec2(0.037, 0.045), 0.0);
    wet = step(0.012, q.y) * step(q.y, 0.012 + fill * 0.068) * step(abs(q.x), 0.033);
  } else if (kind < 1.5) {
    float bowl = max(sdEllipse(q - vec2(0.0, 0.13), vec2(0.042, 0.052)), q.y - 0.168);
    d = min(min(bowl, sdBox(q - vec2(0.0, 0.045), vec2(stem, 0.04), 0.0)), sdEllipse(q - vec2(0.0, 0.004), vec2(0.035, 0.005)));
    wet = step(bowl, -0.003) * step(q.y, 0.085 + fill * 0.06);
  } else if (kind < 2.5) {
    float bowl = max(sdEllipse(q - vec2(0.0, 0.135), vec2(0.056, 0.04)), q.y - 0.135);
    d = min(min(bowl, sdBox(q - vec2(0.0, 0.05), vec2(stem, 0.045), 0.0)), sdEllipse(q - vec2(0.0, 0.004), vec2(0.035, 0.005)));
    wet = step(bowl, -0.003) * step(q.y, 0.1 + fill * 0.033);
  } else {
    d = sdBox(q - vec2(0.0, 0.07), vec2(0.03, 0.07), 0.0);
    wet = step(0.01, q.y) * step(q.y, 0.01 + fill * 0.12) * step(abs(q.x), 0.026);
  }
  float cover = softFill(d, px);
  if (cover <= 0.0) return vec4(0.0);
  float edge = 1.0 - smoothstep(0.0, max(0.005, 1.5 * px), -d);
  vec3 c = mix(vec3(0.05, 0.055, 0.06) + light * 0.12, liquid * (light * 0.9 + 0.08), wet) + light * 0.55 * edge;
  return vec4(c, cover * mix(0.55, 1.0, max(edge, wet)));
}

// The glasses on the counter at p, over col: each seat's, where the simulation set it, unless its
// owner has it at their lips.
void barGlasses(vec2 p, inout vec3 col) {
  vec2 w = barWorld(p, BAR_GLASS_Z);
  if (w.y < BAR_TOP_Y - 0.02 || w.y > BAR_TOP_Y + 0.2) return;
  float px = barPx * BAR_GLASS_Z / BAR_F;
  for (int k = 0; k < 4; k++) {
    vec4 g = barGl[k];
    if (g.x < -0.5 || (barP1[k].w > 0.05 && barP0[k].z > 0.9 && barP1[k].x > 0.0)) continue;
    vec2 q = w - vec2(g.z, BAR_TOP_Y);
    if (abs(q.x) > 0.08) continue;
    vec3 light = barLamp * barLampNear(g.z, 0.5) * 1.2 + barShelf * 0.35 + barAmbient;
    vec4 c = barGlass(q, g.y, g.x, g.w < 0.0 ? vec3(0.95, 0.55, 0.45) : barLiquid(g.w), light, px);
    col = mix(col, c.rgb, c.a);
  }
}

// The counter at p: its polished top, a band of warm wood in the lamps' pools, glossy enough to
// carry the back bar's glow and the bottles' colours near its far edge and a sheen under each lamp;
// the rounded front edge with a bright line where the lamps catch it; mahogany panels below in its
// shade (their top bevels catching the fan's light), the kick at the floor, and the brass foot rail
// on its brackets in front. Colour and coverage.
vec4 barCounter(vec2 p) {
  vec3 c = vec3(0.0);
  float cover = 0.0;
  vec2 f = barWorld(p, BAR_COUNTER_Z);
  float pxc = barPx * BAR_COUNTER_Z / BAR_F;
  float body = softFill(max(max(-f.y, f.y - BAR_EDGE_Y0), BAR_COUNTER_X0 - f.x), pxc);
  if (body > 0.0) {
    // Lit by the fan's bowl in front of it, the lamps' light bouncing off the floor and the
    // patrons; darker in the shade of the top's overhang.
    vec3 light = (barAmbient * 2.0 + barFanLight(vec3(f, BAR_COUNTER_Z), vec3(0.0, 0.0, -1.0)) * 1.5 + barLamp * 0.1 * (0.4 + 0.6 * barLampNear(f.x, 0.8))) * (0.5 + 0.5 * smoothstep(BAR_EDGE_Y0, BAR_EDGE_Y0 - 0.2, f.y));
    vec2 pq = vec2((fract((f.x - BAR_COUNTER_X0) / 0.78) - 0.5) * 0.78, f.y - 0.53);
    float bevel = step(sdBox(pq, vec2(0.31, 0.33), 0.0), 0.0) * step(0.0, sdBox(pq, vec2(0.26, 0.28), 0.0));
    vec2 rel = pq / vec2(0.31, 0.33);
    float topFace = bevel * step(abs(rel.x), rel.y);
    float bottomFace = bevel * step(abs(rel.x), -rel.y);
    float field = step(sdBox(pq, vec2(0.26, 0.28), 0.0), 0.0);
    vec3 wood = vec3(0.3, 0.12, 0.065) * (0.88 + 0.12 * vnoise(vec2(f.x * 3.0, f.y * 40.0)));
    c = wood * light * (1.0 + 0.7 * topFace - 0.35 * bottomFace + 0.15 * field) * (1.0 - 0.6 * step(f.y, 0.1));
    cover = body;
  }
  // The top, where the eye ray meets it between the front edge and the back edge.
  float ty = barAt(p, 3.4).y;
  if (ty < 0.0) {
    float z = BAR_F * (BAR_TOP_Y - BAR_EYE) / ty;
    float x = barAt(p, z).x * z / BAR_F;
    float top = softFill(max(max(BAR_EDGE_Z - z, z - BAR_TOP_Z1), BAR_COUNTER_X0 - 0.07 - x), barPx * z / BAR_F);
    if (top > 0.0) {
      vec3 P = vec3(x, BAR_TOP_Y, z);
      vec3 wood = vec3(0.36, 0.16, 0.075) * (0.85 + 0.15 * vnoise(vec2(x * 2.0 + 2.0 * vnoise(vec2(x * 7.0, z * 9.0)), z * 30.0)));
      vec3 tc = wood * (barAmbient * 2.0 + barLampLight(P, vec3(0.0, 1.0, 0.0)) + barFanLight(P, vec3(0.0, 1.0, 0.0)));
      // Polish: at this grazing angle it mirrors the back bar's glow and, toward the far edge,
      // the colours of the bottles; a sheen of each lamp spreads in it.
      float far = smoothstep(BAR_EDGE_Z + 0.1, BAR_TOP_Z1, z);
      vec3 bottles = barLiquid(floor((x * BAR_SHELF_Z / z - BAR_SLOT_X0) / BAR_SLOT_W)) * barShelf * 0.35;
      tc += (barShelf * 0.22 + bottles) * far + barLamp * 0.45 * barLampNear(x, 0.22) * (0.3 + 0.7 * far);
      c = mix(c, tc, top);
      cover = max(cover, top);
    }
  }
  // The rounded front edge.
  vec2 r = barWorld(p, BAR_EDGE_Z);
  float mid = 0.5 * (BAR_EDGE_Y0 + BAR_TOP_Y);
  float halfH = 0.5 * (BAR_TOP_Y - BAR_EDGE_Y0);
  float edge = softFill(max(abs(r.y - mid) - halfH, BAR_COUNTER_X0 - 0.07 - r.x), barPx * BAR_EDGE_Z / BAR_F);
  if (edge > 0.0) {
    float v = clamp((r.y - mid) / halfH, -1.0, 1.0);
    vec3 N = normalize(vec3(0.0, v, -sqrt(max(1.0 - v * v, 0.0)) - 0.05));
    vec3 P = vec3(r, BAR_EDGE_Z);
    vec3 ec = vec3(0.3, 0.13, 0.06) * (barAmbient * 2.0 + barLampLight(P, N) + barFanLight(P, N) * 1.5) + barLamp * 0.6 * pow(max(v, 0.0), 4.0) * barLampNear(r.x, 0.5);
    c = mix(c, ec, edge);
    cover = max(cover, edge);
  }
  vec2 fr = barWorld(p, BAR_FOOT_Z);
  float pxf = barPx * BAR_FOOT_Z / BAR_F;
  if (fr.x > BAR_COUNTER_X0 + 0.05) {
    float tube = softFill(abs(fr.y - BAR_FOOT_Y) - 0.024, pxf);
    float bracket = softFill(max(abs(fract((fr.x - BAR_COUNTER_X0) / 1.2) - 0.5) * 1.2 - 0.012, abs(fr.y - BAR_FOOT_Y - 0.06) - 0.06), pxf);
    float brass = max(tube, bracket);
    if (brass > 0.0) {
      float v = (fr.y - BAR_FOOT_Y) / 0.024;
      vec3 bc = vec3(0.55, 0.38, 0.15) * (barAmbient * 2.0 + barFanLight(vec3(fr, BAR_FOOT_Z), vec3(0.0, 0.6, -0.8)) * 1.5) + (barFanCol * 0.5 + barShelf * 0.25) * bell((v - 0.45) / 0.25) * tube;
      c = mix(c, bc, brass);
      cover = max(cover, brass);
    }
  }
  return vec4(c, cover);
}

// The four pendants over the counter, over col at p: green enamel domes on cords from the
// ceiling, from below their white insides and the bulbs; a halo round each and a faint cone of
// light in the air beneath. accent: the bulbs.
void barLamps(vec2 p, inout vec3 col, inout float accent) {
  vec2 q = barAt(p, BAR_LAMP_Z);
  float m = BAR_LAMP_Z / BAR_F;
  float x = q.x * m;
  int i = int(clamp(floor((x - BAR_LAMP_X0) / BAR_LAMP_DX + 0.5), 0.0, 3.0));
  vec2 l = vec2(x - barLampX(i), q.y * m + BAR_EYE - BAR_LAMP_Y);
  float px = barPx * m;
  // The cone of light falling from the mouth to the counter, the warm air in it just visible.
  if (l.y < 0.0 && l.y > BAR_TOP_Y - BAR_LAMP_Y) {
    float spread = 0.16 + 0.42 * -l.y;
    col += barLamp * 0.07 * smoothstep(spread, spread * 0.65, abs(l.x)) * (0.55 + 0.45 * smoothstep(-0.9, 0.0, l.y)) * smoothstep(BAR_TOP_Y - BAR_LAMP_Y, BAR_TOP_Y - BAR_LAMP_Y + 0.06, l.y);
  }
  col += barLamp * 0.3 * exp(-length(l - vec2(0.0, -0.03)) / 0.09);
  float k = clamp(l.y / 0.24, 0.0, 1.0);
  float wd = 0.17 * sqrt(max(1.0 - k * k, 0.0));
  float dome = max(abs(l.x) - wd, max(-l.y, l.y - 0.24));
  float cap = sdBox(l - vec2(0.0, 0.26), vec2(0.03, 0.025), 0.0);
  float cord = max(abs(l.x) - max(0.004, 0.8 * px), -l.y);
  float shade = softFill(min(min(dome, cap), cord), px);
  vec3 enamel = vec3(0.05, 0.16, 0.1) * (barAmbient * 2.0 + barShelf * 0.12) + barLamp * 0.25 * smoothstep(0.6, 1.0, abs(l.x) / max(wd, 1e-3)) * step(l.y, 0.2);
  col = mix(col, enamel, shade);
  accent *= 1.0 - shade;
  float inner = softFill(sdEllipse(l, vec2(0.162, 0.162 * (BAR_LAMP_Y - BAR_EYE) / BAR_LAMP_Z)), px);
  col = mix(col, barLamp * 1.1, inner);
  float bulb = softFill(length(l - vec2(0.0, -0.012)) - 0.03, px);
  col = mix(col, mix(barLamp, vec3(1.0), 0.5) * 1.6, bulb);
  accent = max(accent, bulb * 0.9);
}

// ---- The patrons

struct BarPose {
  float sit;      // 0 standing .. 1 on the stool
  float face;     // -1 walking left .. 0 back to you .. 1 walking right
  float gait;     // 0..1 per two steps
  float turn;     // head turn, + to the right (-1.4 back over the left shoulder)
  float sip;      // 0..1 the glass at their lips
  float nod;      // the head's bob while talking (m)
  float shift;    // seated: a slow sway from side to side (m)
  float hs;       // height
  float build;    // width
  float style;    // 0 short hair, 1 long, 2 a bun, 3 a hat
  float umbrella; // carrying a closed umbrella
};

BarPose barPoseOf(int k) {
  BarPose P;
  vec4 a = barP0[k];
  vec4 b = barP1[k];
  vec4 c = barP2[k];
  float fk = float(k);
  P.sit = a.z;
  P.face = b.y;
  P.gait = a.w;
  P.turn = b.z;
  P.sip = b.w;
  P.nod = c.x * 0.012 * sin(barTm * 2.3 + fk * 1.7) * max(sin(barTm * 0.6 + fk), 0.0);
  P.shift = 0.012 * a.z * sin(barTm * 0.21 + fk * 2.0);
  P.hs = 0.94 + 0.12 * fract(b.x * 7.31);
  P.build = 0.92 + 0.18 * fract(b.x * 3.17);
  P.style = floor(fract(b.x * 5.13) * 4.0);
  P.umbrella = c.y;
  return P;
}

// A patron's figure, q metres from the floor under their hips: distance; part 0 coat, 1 legs,
// 2 skin, 3 hair, 4 hat, 5 the glass, 6 umbrella, 7 hands. Seated, from behind, elbows on the rail;
// walking, side-on with a stride and swinging arms; in between, they climb on or off the stool.
float barFigure(vec2 q, BarPose P, out float part) {
  float prof = abs(P.face);
  float dir = P.face < 0.0 ? -1.0 : 1.0;
  float walk = 1.0 - P.sit;
  float ph = TAU * P.gait;
  float yHip = mix(0.93 * P.hs, 0.84, P.sit) + 0.014 * abs(sin(ph)) * walk * prof;
  float yShoulder = yHip + 0.5 * P.hs;
  float lean = 0.04 * P.face * walk + P.shift;
  float w = mix(0.2 * P.build, 0.12, prof);
  float coat = smin(smin(barSeg(q, vec2(P.shift * 0.3, yHip + 0.05), vec2(lean, yShoulder - 0.08), mix(0.155, 0.12, prof) * P.build, mix(0.17, 0.125, prof) * P.build), barSeg(q, vec2(lean - w + 0.06, yShoulder - 0.045), vec2(lean + w - 0.06, yShoulder - 0.045), 0.065, 0.065), 0.06), sdEllipse(q - vec2(0.0, yHip), vec2(mix(0.19, 0.14, prof) * P.build, 0.1)), 0.05);
  if (walk > 0.0) coat = min(coat, barSeg(q, vec2(0.0, yHip - 0.02), vec2(-0.02 * dir * prof, yHip - 0.3), mix(0.16, 0.13, prof), mix(0.17, 0.15, prof)) + 0.3 * P.sit);
  vec2 hc = vec2(lean + 0.025 * sin(P.turn) * (1.0 - prof) + 0.02 * dir * prof, yShoulder + 0.19 + P.nod + 0.008 * P.sip);
  float glassD = 1e3;
  float handD = 1e3;
  float umbD = 1e3;
  for (int k = 0; k < 2; k++) {
    float s = k == 0 ? -1.0 : 1.0;
    vec2 sh = vec2(lean + s * (w - 0.05), yShoulder - 0.06);
    vec2 hSeat = vec2(s * (w - 0.04) + P.shift, 1.1);
    vec2 eSeat = vec2(s * (w + 0.05) + P.shift, 1.07);
    if (k == 1) {
      hSeat = mix(hSeat, hc + vec2(0.1, -0.05), P.sip);
      eSeat = mix(eSeat, vec2(w + 0.08, 1.3), P.sip);
    }
    float sw = 0.3 * sin(ph + float(k) * BAR_PI) * prof;
    vec2 hStand = sh + vec2(sin(sw) * dir * 0.56 + s * 0.03 * (1.0 - prof), -cos(sw) * 0.56);
    vec2 eStand = sh + vec2(sin(sw) * dir * 0.28 - 0.025 * dir * prof + s * 0.02 * (1.0 - prof), -cos(sw) * 0.29);
    vec2 hand = mix(hStand, hSeat, P.sit);
    vec2 elbow = mix(eStand, eSeat, P.sit);
    coat = min(coat, min(barSeg(q, sh, elbow, 0.058, 0.05), barSeg(q, elbow, hand, 0.05, 0.042)));
    handD = min(handD, length(q - hand) - 0.042);
    if (k == 1 && P.sip > 0.05) glassD = sdBox(q - hand - vec2(0.0, 0.05), vec2(0.032, 0.045), 0.0) - 0.004;
    if (k == 0 && P.umbrella > 0.5 && walk > 0.5) umbD = min(barSeg(q, hand + vec2(0.0, 0.02), hand + vec2(0.1 * dir, -0.7), 0.03, 0.008), max(abs(length(q - hand - vec2(0.03 * dir, 0.05)) - 0.04) - 0.01, hand.y + 0.05 - q.y));
  }
  float legs = 1e3;
  for (int k = 0; k < 2; k++) {
    float s = k == 0 ? -1.0 : 1.0;
    float kp = float(k) * BAR_PI;
    float a = 0.42 * sin(ph + kp) * prof;
    float b = 0.6 * max(0.0, sin(ph + kp + 1.3)) * prof;
    vec2 hip = vec2(s * 0.085 * (1.0 - prof), yHip - 0.05);
    vec2 knee = hip + vec2(sin(a) * dir, -cos(a)) * 0.45 * P.hs;
    vec2 ankle = knee + vec2(sin(a - b) * dir, -cos(a - b)) * 0.43 * P.hs;
    hip = mix(hip, vec2(s * 0.09, 0.8), P.sit);
    knee = mix(knee, vec2(s * 0.09, 0.74), P.sit);
    ankle = mix(ankle, vec2(s * 0.1, 0.33), P.sit);
    float shoe = sdEllipse(q - ankle - vec2(0.05 * dir * prof, -0.03), vec2(mix(0.055, 0.11, prof), 0.035));
    legs = min(legs, min(min(barSeg(q, hip, knee, 0.075, 0.06), barSeg(q, knee, ankle, 0.058, 0.045)), shoe));
  }
  float yaw = mix(P.turn, dir * 1.5, prof);
  float ys = yaw < 0.0 ? -1.0 : 1.0;
  float side = smoothstep(0.5, 1.2, abs(yaw));
  float skull = sdEllipse(q - hc, vec2(0.083, 0.104));
  float nose = sdEllipse(q - hc - vec2(ys * 0.083, -0.015), vec2(0.022, 0.017)) + 0.05 * (1.0 - side);
  float neck = barSeg(q, vec2(lean, yShoulder - 0.02), hc - vec2(0.0, 0.07), 0.05, 0.045);
  float hair = skull;
  if (P.style == 1.0) hair = min(hair, sdBox(q - vec2(hc.x - ys * 0.012 * side, hc.y - 0.11), vec2(0.075, 0.115), 0.0) - 0.022);
  if (P.style == 2.0) hair = min(hair, length(q - hc - vec2(-ys * 0.04 * side, 0.095)) - 0.046);
  float hat = 1e3;
  if (P.style == 3.0) hat = min(sdEllipse(q - hc - vec2(0.0, 0.07), vec2(0.15, 0.022)), sdBox(q - hc - vec2(0.0, 0.115), vec2(0.078, 0.045), 0.0) - 0.018);
  bool face = (q.x - hc.x) * ys > 0.05 - 0.08 * side && q.y < hc.y + 0.03;
  bool nape = P.style == 0.0 && q.y < hc.y - 0.075;
  float d = min(min(min(hat, min(hair, skull)), min(min(nose, neck), umbD)), min(min(coat, glassD), min(handD, legs)));
  if (hat < 0.0) part = 4.0;
  else if (skull < 0.0) part = face || nape ? 2.0 : 3.0;
  else if (hair < 0.0) part = 3.0;
  else if (nose < 0.0 || neck < 0.0) part = 2.0;
  else if (umbD < 0.0) part = 6.0;
  else if (coat < 0.0) part = 0.0;
  else if (glassD < 0.0) part = 5.0;
  else if (handD < 0.0) part = 7.0;
  else if (legs < 0.0) part = 1.0;
  else {
    part = 0.0;
    float best = coat;
    if (legs < best) { best = legs; part = 1.0; }
    if (min(skull, hair) < best) { best = min(skull, hair); part = 3.0; }
    if (min(neck, nose) < best) { best = min(neck, nose); part = 2.0; }
    if (hat < best) { best = hat; part = 4.0; }
    if (umbD < best) { best = umbD; part = 6.0; }
    if (glassD < best) { best = glassD; part = 5.0; }
    if (handD < best) part = 7.0;
  }
  return d;
}

// Patron k at p: their figure shaded (coat, hair, skin, hat, a glass, an umbrella), lit from above
// by the lamps and the fan, rimmed warm by the back bar (cool by the window); hard-edged. part out.
vec4 barPatron(vec2 p, int k, out float part) {
  part = -1.0;
  vec4 a = barP0[k];
  float z = a.y;
  vec2 q = barWorld(p, z) - vec2(a.x, 0.0);
  if (abs(q.x) > 0.8 || q.y < -0.05 || q.y > 2.0) return vec4(0.0);
  BarPose P = barPoseOf(k);
  float pxm = barPx * z / BAR_F;
  float d = barFigure(q, P, part);
  if (hardEdge(softFill(d, pxm)) <= 0.0) {
    part = -1.0;
    return vec4(0.0);
  }
  float tmp = 0.0;
  vec2 n = normalize(vec2(barFigure(q + vec2(0.012, 0.0), P, tmp) - d, barFigure(q + vec2(0.0, 0.012), P, tmp) - d) + 1e-6);
  float h = barP1[k].x;
  float hc = fract(h * 6.13);
  vec3 coat = hc < 0.18 ? vec3(0.13, 0.13, 0.15) : hc < 0.36 ? vec3(0.07, 0.09, 0.17) : hc < 0.52 ? vec3(0.24, 0.07, 0.08) : hc < 0.68 ? vec3(0.17, 0.16, 0.09) : hc < 0.84 ? vec3(0.42, 0.3, 0.18) : vec3(0.07, 0.15, 0.11);
  vec3 hairC = mix(mix(vec3(0.05, 0.04, 0.03), vec3(0.3, 0.16, 0.08), fract(h * 9.1)), vec3(0.45, 0.44, 0.42), step(0.85, fract(h * 4.3)));
  vec3 skin = mix(vec3(0.72, 0.5, 0.38), vec3(0.42, 0.27, 0.19), step(0.6, fract(h * 2.71)));
  vec4 gl = barGl[k];
  vec3 albedo = part == 1.0 ? vec3(0.05, 0.05, 0.06) : part == 2.0 || part == 7.0 ? skin : part == 3.0 ? hairC : part == 4.0 ? vec3(0.09, 0.08, 0.07) : part == 5.0 ? (gl.w < 0.0 ? vec3(0.95, 0.55, 0.45) : barLiquid(gl.w)) : part == 6.0 ? vec3(0.03) : coat;
  float inner = clamp(-d / 0.08, 0.0, 1.0);
  vec3 N = normalize(vec3(n * (1.0 - 0.6 * inner), -0.55));
  float x = a.x + q.x;
  vec3 P3 = vec3(x, q.y, z);
  vec3 key = barLampLight(P3, N) + barFanLight(P3, N) + barAmbient * 2.6;
  float byWindow = smoothstep(-1.2, -2.2, x);
  vec3 rimCol = mix(barShelf * 0.45 + barLamp * barLampNear(x, 0.5) * 0.7 * smoothstep(-0.2, 0.6, n.y), barCity * 3.0 + BAR_NEON * barSign * 0.3, byWindow);
  float rim = 1.0 - smoothstep(0.0, max(0.018, 2.0 * pxm), -d);
  vec3 c = albedo * key * 1.3 + rimCol * rim * (part == 1.0 ? 0.3 : 0.75);
  // The lamps over the counter light the tops of heads, hair and shoulders: a warm sheen along
  // every edge that faces up.
  float topLit = smoothstep(0.15, 0.85, n.y) * (1.0 - smoothstep(0.0, 0.06, -d)) * step(1.0, q.y);
  c += barLamp * (0.15 + 0.5 * barLampNear(x, 0.9)) * topLit * (part == 3.0 ? 0.9 : 0.6) * (1.0 - byWindow);
  if (part == 5.0) c = albedo * (barLamp * 0.6 + barShelf * 0.4) + barLamp * 0.3 * rim;
  // Just in from the rain: a sheen on the shoulders.
  c += vec3(0.25, 0.27, 0.3) * barP2[k].z * rim * max(n.y, 0.0) * step(part, 0.5);
  return vec4(c, 1.0);
}

// A bar stool, q metres from its foot: a round oxblood leather seat on a chrome column with a foot
// ring, seen from a little above. light: what reaches its seat. Colour and coverage.
vec4 barStool(vec2 q, vec3 light, float px) {
  float seatTop = sdEllipse(q - vec2(0.0, 0.78), vec2(0.19, 0.035));
  float seat = min(seatTop, sdBox(q - vec2(0.0, 0.745), vec2(0.19, 0.035), 0.0) - 0.01);
  float column = sdBox(q - vec2(0.0, 0.38), vec2(0.026, 0.34), 0.0);
  float chrome = min(min(column, abs(sdEllipse(q - vec2(0.0, 0.32), vec2(0.17, 0.03))) - 0.011), sdEllipse(q - vec2(0.0, 0.02), vec2(0.2, 0.03)));
  float cover = softFill(min(seat, chrome), px);
  if (cover <= 0.0) return vec4(0.0);
  if (seat < chrome) return vec4(vec3(0.3, 0.07, 0.05) * (light + barAmbient) * (seatTop < 0.0 ? 1.4 : 0.9), cover);
  float streak = column < 0.0 ? smoothstep(0.5, 1.0, cos(q.x / 0.026 * 2.2 - 0.6)) : smoothstep(0.0, 0.03, q.y - 0.31) * step(q.y, 0.36);
  return vec4(vec3(0.07) + (barShelf * 0.6 + barLamp * 0.3) * streak + light * 0.2, cover);
}

// The stools and whoever sits on them, over col at p: legs behind the stool, the rest in front.
void barSeats(vec2 p, inout vec3 col) {
  vec2 sw = barWorld(p, BAR_STOOL_Z + 0.04);
  for (int k = 0; k < 4; k++) {
    vec2 sq = sw - vec2(BAR_STOOL_X[k], 0.0);
    if (abs(sq.x) > 0.45) continue;
    vec3 light = barFanLight(vec3(sw.x, 0.78, BAR_STOOL_Z), vec3(0.0, 1.0, 0.0)) + barLamp * 0.05;
    vec4 stool = barStool(sq, light, barPx * (BAR_STOOL_Z + 0.04) / BAR_F);
    float part = -1.0;
    vec4 fig = barP1[k].x > 0.0 && barP0[k].z >= 0.5 ? barPatron(p, k, part) : vec4(0.0);
    if (fig.a > 0.0 && part != 1.0) col = fig.rgb;
    else if (fig.a > 0.0) col = mix(fig.rgb, stool.rgb, stool.a);
    else col = mix(col, stool.rgb, stool.a);
  }
}

// Whoever is walking in from the door or out to it, over col at p.
void barWalkers(vec2 p, inout vec3 col) {
  for (int k = 0; k < 4; k++) {
    if (barP1[k].x <= 0.0 || barP0[k].z >= 0.5) continue;
    float part = -1.0;
    vec4 fig = barPatron(p, k, part);
    col = mix(col, fig.rgb, fig.a);
  }
}

// ---- Your table

// The coffee: a white cup on its saucer, black coffee with the candle's glint in it, the handle
// turned away from the candle. q metres from the middle of the saucer's foot.
vec4 barCoffee(vec2 q, float px, vec3 flame) {
  if (abs(q.x) > 0.1 || q.y < -0.04 || q.y > 0.1) return vec4(0.0);
  float dip = (BAR_TABLE_EYE - BAR_TABLE_Y) / BAR_COFFEE.y;
  float r = 0.042;
  float h = 0.07;
  float saucer = min(sdEllipse(q - vec2(0.0, 0.012), vec2(0.072, 0.072 * dip * 0.95)), sdBox(q - vec2(0.0, 0.006), vec2(0.066, 0.006), 0.0));
  float rim = sdEllipse(q - vec2(0.0, h), vec2(r, r * dip * 0.88));
  float handle = max(abs(length((q - vec2(r + 0.01, 0.043)) / vec2(1.0, 1.25)) - 0.017) - 0.005, r - 0.006 - q.x);
  float cup = min(min(max(abs(q.x) - r * mix(0.8, 1.0, smoothstep(0.012, 0.04, q.y)), max(0.008 - q.y, q.y - h)), rim), handle);
  float cover = softFill(min(saucer, cup), px);
  if (cover <= 0.0) return vec4(0.0);
  vec3 light = barAmbient * 2.0 + flame * 0.35 * (0.55 + 0.45 * clamp(-q.x / r, -1.0, 1.0)) + barLamp * 0.04;
  vec3 porcelain = vec3(0.86, 0.84, 0.8);
  vec3 c = porcelain * light * (saucer < cup ? 0.85 : 1.0);
  c += flame * 0.25 * bell((q.x + r * 0.55) / 0.007) * step(cup, 0.0) * step(q.y, h);
  float coffee = sdEllipse(q - vec2(0.0, h - 0.004), vec2(r - 0.005, (r - 0.005) * dip * 0.85));
  if (coffee < 0.0) c = vec3(0.06, 0.03, 0.018) * (light * 0.6 + 0.05) + flame * 0.4 * exp(-length((q - vec2(-0.012, h - 0.004)) / vec2(0.012, 0.004)));
  else if (rim < 0.0) c = porcelain * light * 1.05;
  return vec4(c, cover);
}

// The whisky: a heavy tumbler, two fingers of amber over ice beside the candle: the side facing it
// bright, the far side glowing where its light comes through. Every minute and a half or so an ice
// cube settles a little and slowly rises again. q from the middle of its foot (m).
vec4 barWhisky(vec2 q, float px, vec3 flame) {
  if (abs(q.x) > 0.06 || q.y < -0.04 || q.y > 0.12) return vec4(0.0);
  float zc = BAR_WHISKY.y;
  float r = 0.04;
  float h = 0.088;
  float foot = -r * (BAR_TABLE_EYE - BAR_TABLE_Y) / zc * sqrt(max(1.0 - q.x * q.x / (r * r), 0.0));
  float top = sdEllipse(q - vec2(0.0, h), vec2(r, r * (BAR_TABLE_EYE - BAR_TABLE_Y - h) / zc));
  float cover = softFill(min(max(abs(q.x) - r, max(foot - q.y, q.y - h)), top), px);
  if (cover <= 0.0) return vec4(0.0);
  float x = q.x / r;
  vec3 amber = vec3(0.9, 0.42, 0.09);
  vec3 c = vec3(0.025, 0.02, 0.018) + barAmbient;
  float level = 0.04;
  float surf = sdEllipse(q - vec2(0.0, level), vec2(r - 0.004, r * (BAR_TABLE_EYE - BAR_TABLE_Y - level) / zc));
  if ((q.y < level && q.y > 0.012 && abs(q.x) < r - 0.004) || surf < 0.0) {
    c = amber * (0.06 + flame * (0.25 + 0.75 * smoothstep(0.3, -0.9, x)));
    c += amber * flame * 0.5 * exp(-abs(q.y - level) / 0.004);
  }
  float pick = 0.0;
  float age = barEvent(barTm, 95.0, 13.0, pick);
  float settle = age < 0.0 ? 0.0 : smoothstep(0.0, 0.35, age) * (1.0 - smoothstep(0.35, 30.0, age));
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float mine = step(0.5, pick) == fi ? settle : 0.0;
    vec2 at = (i == 0 ? vec2(-0.012, level + 0.006) : vec2(0.014, level - 0.001)) - vec2(0.0, 0.003 * mine);
    vec2 iq = rotate(q - at, (i == 0 ? 0.35 : -0.25) + 0.15 * mine);
    float cube = sdBox(iq, vec2(0.012 - 0.001 * fi), 0.0) - 0.003;
    if (cube < 0.0) {
      c = mix(amber * 0.6, vec3(0.85, 0.88, 0.9), 0.5 + 0.4 * step(level, q.y)) * (0.1 + flame * 0.55);
      // their edges and corners catch the flame
      c += vec3(1.0, 0.92, 0.78) * flame * 0.8 * smoothstep(-0.004, 0.0, cube) * step(0.0, iq.x + iq.y);
    }
  }
  c = mix(c, (amber * 0.3 + vec3(0.35, 0.33, 0.3) * 0.3) * flame, step(q.y, 0.012) * step(foot, q.y) * 0.7);
  c += flame * (0.7 * bell((x - 0.88) / 0.06) + 0.2 * bell((x + 0.9) / 0.05)) * step(q.y, h);
  c += flame * 0.5 * (1.0 - smoothstep(0.0, 0.0025, abs(top)));
  return vec4(c, cover);
}

// The candle: a tealight in a ribbed amber glass glowing from within, the flame standing just above
// the rim, swaying, bending with the air a pointer sweeping past pushes (barMisc.xy). q from the middle of
// the glass's foot (m). flame out: the flame's accent.
vec4 barCandle(vec2 q, float px, vec3 flameCol, out float flame) {
  flame = 0.0;
  if (abs(q.x) > 0.06 || q.y < -0.04 || q.y > 0.14) return vec4(0.0);
  float r = 0.034;
  float h = 0.056;
  float eTop = r * (BAR_TABLE_EYE - BAR_TABLE_Y - h) / BAR_CANDLE.z;
  float foot = -r * (BAR_TABLE_EYE - BAR_TABLE_Y) / BAR_CANDLE.z * sqrt(max(1.0 - q.x * q.x / (r * r), 0.0));
  float glassD = min(max(abs(q.x) - r, max(foot - q.y, q.y - h)), sdEllipse(q - vec2(0.0, h), vec2(r, eTop)));
  float size = 0.7 + 0.5 * K_candle;
  float sway = 0.0015 * sin(barTm * 2.1) + 0.001 * sin(barTm * 3.3 + 1.0) + 0.016 * barMisc.x;
  float tall = 0.04 * size * (1.0 + 0.05 * sin(barTm * 1.7) + 0.25 * barMisc.y - 0.2 * abs(barMisc.x));
  vec2 wick = vec2(0.0, 0.03);
  float fl = smin(barSeg(q, wick + vec2(0.0, 0.006), wick + vec2(sway, tall), 0.0062 * size, 0.0), length(q - wick - vec2(0.0, 0.006)) - 0.0064 * size, 0.004);
  float fc = hardEdge(softFill(fl, px));
  float cover = max(softFill(glassD, px), fc);
  if (cover <= 0.0) return vec4(0.0);
  vec3 c = vec3(0.0);
  if (glassD < 0.0) {
    float x = clamp(q.x / r, -1.0, 1.0);
    c = vec3(1.0, 0.5, 0.16) * flameCol * (0.35 + 0.65 * smoothstep(0.0, h, q.y)) * (0.75 + 0.25 * cos(asin(x) * 12.0)) * (1.0 - 0.4 * x * x);
    if (sdEllipse(q - vec2(0.0, h), vec2(r - 0.004, eTop * 0.85)) < 0.0) c = flameCol * 0.9 + vec3(0.25, 0.15, 0.05);
  }
  if (fc > 0.0) {
    float core = smoothstep(0.0, -0.003 * size, fl);
    c = mix(mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.93, 0.7), core), vec3(0.3, 0.4, 0.9), smoothstep(wick.y + 0.006, wick.y, q.y) * 0.6);
    flame = 0.4 + 0.6 * core;
  }
  return vec4(c, cover);
}

// Steam off the coffee: three ribbons swaying as they rise, rolled over now and then by a slow
// eddy, breaking into wisps and fading. q from the middle of the cup's rim (screen heights). 0..1,
// the density the caller switches each cell on against (so a passing wisp flips a cell once).
float barSteam(vec2 q, float amount) {
  float h0 = q.y;
  if (h0 < -0.004 || h0 > 0.24 || abs(q.x) > 0.13) return 0.0;
  for (int k = 0; k < 2; k++) {
    float ph = barTm / 8.0 + float(k) * 0.5;
    float age = fract(ph);
    float side = sign(hash12(vec2(floor(ph), float(k) + 3.0)) - 0.5);
    vec2 c = vec2(side * (0.006 + 0.018 * age), 0.012 + 0.13 * age);
    float r = 0.012 + 0.026 * age;
    vec2 d = q - c;
    q = c + rotate(d, -side * 2.2 * sin(age * BAR_PI) * exp(-dot(d, d) / (r * r)));
  }
  float h = q.y;
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = (fi - 1.0) * 0.007 + (0.003 + 0.1 * h) * sin(h * 16.0 - barTm * (0.6 + 0.15 * fi) + fi * 2.1) + (vnoise(vec2(h * 6.0 - barTm * 0.2, fi * 3.7)) - 0.5) * 0.08 * h;
    float across = (q.x - x) / (0.005 + 0.028 * max(h, 0.0));
    float wisps = smoothstep(0.25, 0.7, vnoise(vec2(h * 18.0 - barTm * 0.45, fi * 5.3 + q.x * 25.0)));
    s += exp(-across * across) * mix(1.0, wisps, smoothstep(0.02, 0.09, h)) * (1.0 - fi * 0.2);
  }
  float life = smoothstep(-0.004, 0.012, h0) * (1.0 - smoothstep(0.03, 0.08 + 0.14 * amount, h0));
  return clamp(s * life * (0.4 + 0.6 * amount), 0.0, 1.0);
}

// Your table at p, over col: a corner of dark walnut under varnish, close in front of you (its own
// nearer view, BAR_TABLE_EYE): the candle's pool of light and its streak in the varnish, the bar's
// glow along the far edge, the whisky's amber caustic beside it; on it, back to front, the coffee,
// the candle and the whisky, the flame's halo, and the coffee's steam. accent: the flame.
void barTable(vec2 p, inout vec3 col, inout float accent) {
  vec3 flameCol = K_candle > 0.0 ? vec3(1.0, 0.62, 0.28) * (0.5 + 0.5 * K_candle) : vec3(0.0);
  float yEdge = BAR_F * (BAR_TABLE_Y - BAR_TABLE_EYE) / BAR_TABLE_Z;
  vec2 te = barAt(p, BAR_TABLE_Z);
  if (te.y < yEdge + barPx) {
    float z = BAR_F * (BAR_TABLE_Y - BAR_TABLE_EYE) / min(barAt(p, 0.7).y, -1e-3);
    float x = barAt(p, z).x * z / BAR_F;
    float px = barPx * z / BAR_F;
    float cover = softFill(BAR_TABLE_X0 - x, px) * softFill(te.y - yEdge, barPx);
    if (cover > 0.0) {
      vec3 wood = vec3(0.22, 0.11, 0.055) * (0.8 + 0.2 * vnoise(vec2(x * 2.5 + 3.0 * vnoise(vec2(x * 8.0, z * 30.0)), z * 40.0)));
      vec2 dc = vec2(x - BAR_CANDLE.x, z - BAR_CANDLE.z);
      vec3 c = wood * (barAmbient * 2.5 + barLamp * 0.06 + flameCol * 0.03 / (0.012 + dot(dc, dc)));
      // Varnish: the flame's glow drawn toward you in it; along the far edge, the bar's warm light.
      c += flameCol * 0.35 * bell(dc.x / 0.025) * exp(-max(-dc.y, 0.0) / 0.15) * step(z, BAR_CANDLE.z);
      c += (barLamp * 0.12 + barShelf * 0.1) * smoothstep(BAR_TABLE_Z - 0.12, BAR_TABLE_Z, z);
      if (K_whisky > 0.5) {
        vec2 ca = (vec2(x, z) - BAR_WHISKY + vec2(0.075, 0.03)) / vec2(0.05, 0.03);
        c += vec3(1.0, 0.55, 0.15) * flameCol.r * 0.45 * exp(-dot(ca, ca));
      }
      // The rounded lip along the far edge and down the side, catching the light.
      float lip = max(1.0 - smoothstep(0.0, 0.012 + px, BAR_TABLE_Z - z), 1.0 - smoothstep(0.0, 0.01 + px, x - BAR_TABLE_X0));
      c += (barLamp * 0.15 + flameCol * 0.08) * lip;
      col = mix(col, c, cover);
    }
  }
  float pz = barPx / BAR_F;
  vec4 cup = barCoffee(barNear(p, BAR_COFFEE.y) - vec2(BAR_COFFEE.x, BAR_TABLE_Y), pz * BAR_COFFEE.y, flameCol);
  col = mix(col, cup.rgb, cup.a);
  if (K_candle > 0.0) {
    float flame = 0.0;
    vec2 cq = barNear(p, BAR_CANDLE.z) - vec2(BAR_CANDLE.x, BAR_TABLE_Y);
    vec4 cd = barCandle(cq, pz * BAR_CANDLE.z, flameCol, flame);
    col = mix(col, cd.rgb, cd.a);
    accent = max(accent * (1.0 - cd.a), flame);
    col += flameCol * 0.12 * exp(-length(cq - vec2(0.0, BAR_CANDLE.y - BAR_TABLE_Y)) / 0.05);
  }
  if (K_whisky > 0.5) {
    vec4 wh = barWhisky(barNear(p, BAR_WHISKY.y) - vec2(BAR_WHISKY.x, BAR_TABLE_Y), pz * BAR_WHISKY.y, flameCol);
    col = mix(col, wh.rgb, wh.a);
  }
  if (K_steam > 0.0) {
    vec2 rim = vec2(BAR_COFFEE.x, BAR_TABLE_Y + 0.07 - BAR_TABLE_EYE) * (BAR_F / BAR_COFFEE.y);
    float steam = barSteam((barAt(p, BAR_COFFEE.y) - rim) / 1.4, K_steam);
    col += vec3(0.78, 0.72, 0.64) * (0.1 + flameCol * 0.3) * hardEdge(steam * 0.85);
  }
}

// The back wall where the back bar is off: dark panelling under the cornice, lit by the room.
vec3 barBareWall(vec2 p) {
  vec2 w = barWorld(p, BAR_BACK_Z);
  float px = barPx * BAR_BACK_Z / BAR_F;
  float panel = softFill(abs(fract((w.x + 0.2) / 0.9) - 0.5) * 0.9 - 0.4, px);
  vec3 light = barAmbient * 1.6 + barLamp * 0.08 * barLampNear(w.x, 1.2) + barShelf * 0.05;
  return vec3(0.12, 0.065, 0.04) * light * (0.85 + 0.15 * panel);
}

// ---- The cell's state (barBegin), set once a cell and read by the bar's layers

float barAspect;
vec2 barP;          // screen heights from the eye level (BAR_HORIZON above the frame's middle), x from the middle, panned and turned
float barXl;        // the frame's left edge there
vec2 barUvGlass;    // the cell on the window's pane, which moves with the room
float barColX;      // across the column's plane at the cell (m): the front wall left of BAR_COL_X1, the room right of it
bool barSimOn;      // the back bar's sim is running

// The bar's own frame (its pinhole through the room's rig, IN_THE_BOOTH), the sim's state and the
// light. The lamps' light is the pendants' (dark while they are off), the bowl's light the fan's.
void barBegin(Ctx x) {
  float aspect = x.aspect;
  barAspect = aspect;
  barPx = 1.0 / uRes.y;
  barTm = uMotionTime;
  barPassage();
  barEye = uPointer * vec2(0.06, 0.025) + barPassEye;
  float pan = -max(0.0, BAR_PAN_FROM - aspect) * BAR_PAN_RATE;
  // The passage's turn of the view is added (exactly zero at rest).
  barP = (x.uv - 0.5) * vec2(aspect, 1.0) + vec2(pan, -BAR_HORIZON) + barPassTurn;
  barXl = -0.5 * aspect + pan + barPassTurn.x;
  // The pane belongs to the room: its drops, and the rain seen through it, move with the window.
  barUvGlass = x.uv + (barPassTurn + BAR_F * barPassEye * (1.0 / BAR_WIN_Z - 1.0 / BAR_FOCUS)) / vec2(aspect, 1.0);
  barColX = barWorld(barP, BAR_COL_Z).x;
  barSimOn = false;
#if LAYER_BACK_BAR
  barSimOn = backBarField0On();
#endif
  barB0 = barSimTexel(0);
  barB1 = barSimTexel(1);
  for (int k = 0; k < 4; k++) {
    barP0[k] = barSimTexel(2 + k);
    barP1[k] = barSimTexel(6 + k);
    barP2[k] = barSimTexel(10 + k);
    barGl[k] = barSimTexel(14 + k);
  }
  barMisc = barSimTexel(18);
  barFanAngle = barSimOn ? barMisc.z : barTm * TAU * (BAR_FAN_SLOW + (BAR_FAN_FAST - BAR_FAN_SLOW) * K_fan) * step(0.001, K_fan);

  // The light: the lamps' warmth and the room dimming toward last call; the night outside, a
  // little brighter under rain cloud lit by the city; the OPEN sign switched off at last call.
  // Once last call has been called (barMisc.w seconds ago) the house lights blink twice and, over
  // the next few seconds, the room goes to closing time whatever the knob says (the back bar's
  // shelf glow and the sign are on circuits of their own and do not blink).
  float night = K_night;
  float blink = 1.0;
  float since = barMisc.w;
  if (since >= 0.0) {
    night = mix(K_night, max(K_night, BAR_CLOSING_NIGHT), smoothstep(BAR_BLINK1 + 1.0, BAR_BLINK1 + 7.0, since));
    float off = step(BAR_BLINK0, since) * step(since, BAR_BLINK0 + BAR_BLINK_OFF) + step(BAR_BLINK1, since) * step(since, BAR_BLINK1 + BAR_BLINK_OFF);
    blink = 1.0 - 0.8 * off;
  }
  barLevel = mix(1.0, 0.55, smoothstep(0.55, 1.0, night)) * blink;
  vec3 warm = mix(vec3(1.0, 0.9, 0.8), vec3(1.0, 0.6, 0.3), K_warmth);
  // The lamps warm on a little as you arrive (exactly 1 at rest).
  float lampK = 1.0 - 0.14 * (1.0 - smoothstep(0.1, 0.85, passageIn()));
  barLamp = warm * barLevel * 1.3 * lampK;
#if !LAYER_PENDANTS
  barLamp = vec3(0.0);
#endif
  barShelf = mix(vec3(1.0, 0.72, 0.42), warm, 0.5) * 0.85 * mix(1.0, 0.5, smoothstep(0.6, 1.0, night));
  barFanCol = vec3(1.0, 0.82, 0.62) * 0.4 * barLevel;
#if !LAYER_CEILING_FAN
  barFanCol = vec3(0.0);
#endif
  barAmbient = vec3(0.05, 0.04, 0.036) * (0.6 + 0.4 * barLevel);
  barCity = vec3(0.11, 0.1, 0.115) * (1.0 + 0.3 * K_rain);
  barWet = uWeather.x;
  barSign = K_sign * (1.0 - smoothstep(0.9, 0.94, night));
}
`;

/** The bar's GLSL its layers share: its room in metres, its shapes and people, the cell's state. */
export const barSharedGlsl: SharedGlsl = { id: "bar", glsl: () => barShared, begin: "barBegin" };

/**
 * The storefront (the backdrop of the bar's room): left of the column, the front wall and its
 * window onto the rainy street, the column and the floor before them; right of it the pressed-tin
 * ceiling, the floor and the back wall's bare panelling (the back bar covers it). In front, the coat
 * and the wet umbrella on the column's hook.
 */
export const storefrontGlsl = `
void storefrontFar(Ctx x, inout Cell c) {
  vec2 p = barP;
  if (barColX < BAR_COL_X1) {
    c.col = barColX < BAR_COL_X0 ? barFrontWall(p, barUvGlass, barAspect, barXl) : barColumn(p);
    if (barAt(p, BAR_WIN_Z).y < -BAR_F * BAR_EYE / BAR_WIN_Z) c.col = barFloor(p);
    return;
  }
  vec2 qb = barAt(p, BAR_BACK_Z);
  if (qb.y > BAR_F * (BAR_CEIL - BAR_EYE) / BAR_BACK_Z) c.col = barCeiling(p);
  else if (qb.y < -BAR_F * BAR_EYE / BAR_BACK_Z) c.col = barFloor(p);
  else c.col = barBareWall(p);
}

void storefrontFront(Ctx x, inout Cell c) {
  barCoat(barP, c.col);
}
`;

/** Your table in the booth, nearest the eye: it paints over all that stands in the room. */
export const boothGlsl = `
void boothFrontVeil(Ctx x, inout Cell c) {
  barTable(barP, c.col, c.accent);
}
`;

/**
 * The back bar (the bar's subject): the mirror wall with its shelves of bottles and the M, the
 * bartender, the counter and the glasses on it; in front, the stools and the patrons, and whoever
 * is walking in or out.
 */
export const backBarGlsl = `
void backBarMiddle(Ctx x, inout Cell c) {
  if (barColX < BAR_COL_X1) return;
  vec2 p = barP;
  vec2 qb = barAt(p, BAR_BACK_Z);
  if (qb.y <= BAR_F * (BAR_CEIL - BAR_EYE) / BAR_BACK_Z && qb.y >= -BAR_F * BAR_EYE / BAR_BACK_Z)
    c.col = barBackWall(p, K_bartender > 0.5 ? barB1.y : -1.0, c.accent);
  barTender(p, c.col);
  vec4 counter = barCounter(p);
  c.col = mix(c.col, counter.rgb, counter.a);
  c.accent *= 1.0 - counter.a;
  barGlasses(p, c.col);
}

void backBarFront(Ctx x, inout Cell c) {
  if (barColX >= BAR_COL_X1) barSeats(barP, c.col);
  barWalkers(barP, c.col);
}
`;

/** The four green pendants over the counter (their light is the room's: barBegin). */
export const pendantsGlsl = `
void pendantsMiddle(Ctx x, inout Cell c) {
  if (barColX >= BAR_COL_X1) barLamps(barP, c.col, c.accent);
}
`;

/** The fan under the tin ceiling (its bowl's light and the blades' shadows on the tin: barBegin). */
export const ceilingFanGlsl = `
void ceilingFanFront(Ctx x, inout Cell c) {
  barFan(barP, c.col);
}
`;
