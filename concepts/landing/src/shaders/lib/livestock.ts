// Grazing livestock, shared: cattle and sheep seen side-on, and the analytic schedule that keeps a
// herd alive without a simulation. Not compiled into every program: a scene that keeps animals
// concatenates `livestockGlsl` into its own GLSL (the countryside does, for its pasture
// enclosures) and supplies the rest itself: where each animal's anchors lie (which belong to the
// scene's ground, walls and projection) and the shading.
//
// Body frame: p in body half-lengths, x right on screen, y up from the feet (ground contact at the
// origin). A cow stands about 1.25 half-lengths high, a sheep about 1.3 with its head up.
//
// Schedule: each animal lives in slots of `span` seconds, offset by its own phase. Slot n takes it
// from one anchor to the next; in each it grazes (drifting, head down), walks (crosses early, then
// grazes), stands about (waits, then walks on) or rests (lies down, chews the cud or dozes, gets up
// and walks on). Every slot starts and ends standing, head up, at an anchor, so the poses join up.
// Everything is a pure function of the clock (uMotionTime), so a still frame stays still.
//
//   LivestockSlot livestockSlot(float t, float span, float seed);  // this slot: n, u 0..1, start time
//   vec2 livestockMood(float tod, float clouds, float rain, float snow); // chances to rest, stand about
//   float livestockAct(vec2 mood, float roll);                      // LIVESTOCK_GRAZE/WALK/STAND/REST
//   float livestockPace(float act, float u);                        // 0..1 of the way between anchors
//   vec2 livestockPlace(float k, float seed);                       // k's place in a herd, in spacings
//   vec2 livestockStray(float k, float n, float seed);              // its own stray in slot n, spacings
//   float livestockReach(float count);                              // radius holding a herd, spacings
//   float livestockFit(float radius);                               // how many fit within a radius
//   vec2 livestockDrift(float seed, float t);                       // a herd centre's slow wander, -1..1
//                                                                   // (each way at most 1/30 per second)
//   LivestockPose livestockPose(LivestockBeast b, float act, LivestockSlot slot, vec2 travel, float rain, float t);
//   float livestockBody(vec2 p, LivestockBeast b, LivestockPose pose, float aa,
//                       out vec3 albedo, out vec3 normal, out float top); // signed distance to the outline
//   vec4 livestockSpeck(vec2 p, LivestockBeast b, LivestockPose pose, float aa); // mean colour, cover
//   float livestockShadow(vec2 p, LivestockPose pose);              // 0..1 contact shadow on the ground
export const livestockGlsl = /* glsl */ `
// ---- livestock ----

const float LIVESTOCK_GRAZE = 0.0;
const float LIVESTOCK_WALK = 1.0;
const float LIVESTOCK_STAND = 2.0;
const float LIVESTOCK_REST = 3.0;

// One animal: what it is and how it looks.
struct LivestockBeast {
  float cattle;  // 1 a cow, 0 a sheep
  float breed;   // cattle: below 0.45 Friesian black-and-white, below 0.75 Hereford, else Angus
  float tone;    // 0..1 of its own: markings, shade, the odd black sheep
};

// Where an animal is in its schedule.
struct LivestockSlot {
  float n;       // slot index
  float u;       // 0..1 through it
  float start;   // clock time it began
  float span;    // seconds
};

struct LivestockPose {
  float lie;     // 0 standing .. 1 lying
  float head;    // 0 down at the grass .. 1 up
  float stride;  // the legs' swing, body half-lengths
  float swish;   // the tail's swing, -1..1
  float face;    // 1 facing right on screen, -1 left
  float turn;    // 1 broadside .. 0.75 end on (toward or away from the eye)
};

LivestockSlot livestockSlot(float t, float span, float seed) {
  LivestockSlot s;
  float phase = seed * span;
  float clock = (t + phase) / span;
  s.n = floor(clock);
  s.u = clock - s.n;
  s.start = s.n * span - phase;
  s.span = span;
  return s;
}

// Chances that a slot is spent resting (x) or standing about (y), from the time of day it began
// (0 midnight .. 0.5 noon), cloud cover 0..1 and rain and snow amounts 0..1: animals lie down in the
// warm afternoon sun and at night, and stand about bunched up in rain and snow.
vec2 livestockMood(float tod, float clouds, float rain, float snow) {
  float warm = smoothstep(0.5, 0.58, tod) * (1.0 - smoothstep(0.72, 0.77, tod)) * (1.0 - smoothstep(0.4, 0.9, clouds));
  float night = 1.0 - smoothstep(0.2, 0.27, tod) * (1.0 - smoothstep(0.79, 0.85, tod));
  float wet = rain > 0.0 ? 0.5 + 0.5 * rain : 0.0;
  float cold = snow > 0.0 ? 0.5 + 0.5 * snow : 0.0;
  return vec2(clamp(0.16 + 0.36 * warm + 0.5 * night - 0.35 * wet - 0.3 * cold, 0.04, 0.8), 0.12 + 0.35 * wet + 0.2 * cold);
}

float livestockAct(vec2 mood, float roll) {
  if (roll < mood.x) return LIVESTOCK_REST;
  if (roll < mood.x + mood.y) return LIVESTOCK_STAND;
  return roll < mood.x + mood.y + 0.2 ? LIVESTOCK_WALK : LIVESTOCK_GRAZE;
}

// How far through a slot the animal has moved from its anchor toward the next, 0..1.
float livestockPace(float act, float u) {
  if (act < 0.5) return u;
  if (act < 1.5) return smoothstep(0.1, 0.5, u);
  if (act < 2.5) return smoothstep(0.72, 0.95, u);
  return smoothstep(0.88, 1.0, u);
}

// Animal k's place in its herd, in spacings from the centre: a sunflower spiral (evenly spread,
// never rows) with a little fixed jitter, the herd turned by its seed.
vec2 livestockPlace(float k, float seed) {
  float angle = k * 2.39996 + seed * TAU;
  return 0.8 * sqrt(k + 0.5) * vec2(cos(angle), sin(angle)) + 0.25 * (hash22(vec2(k, seed * 53.0)) - 0.5);
}

// The most an animal strays from its place in any slot, spacings.
const float LIVESTOCK_STRAY = 0.43;

// Where animal k strays from its place for slot n, in spacings.
vec2 livestockStray(float k, float n, float seed) {
  return LIVESTOCK_STRAY * 1.4142 * (hash22(vec2(n * 1.37 + k * 0.11, seed * 91.0 + k)) - 0.5);
}

// The radius (spacings) that holds every member of a herd of \`count\` at full spread with their
// strays (livestockPlace and livestockStray), and how many fit within a radius.
float livestockReach(float count) {
  return 0.8 * sqrt(max(count - 0.5, 0.0)) + 0.18 + LIVESTOCK_STRAY;
}
float livestockFit(float radius) {
  float r = max(radius - 0.18 - LIVESTOCK_STRAY, 0.0) / 0.8;
  return floor(r * r + 0.5);
}

// A herd centre's wander at clock time t, -1..1 each way, crossing its range in a few minutes.
vec2 livestockDrift(float seed, float t) {
  float x = t / 90.0 + seed * 17.0;
  return 2.0 * vec2(vnoise1(x, seed * 31.0 + 1.0).x, vnoise1(x, seed * 31.0 + 2.0).x) - 1.0;
}

// The pose in slot (act) as it travels \`travel\` body half-lengths (x right on screen, y away from
// the eye along the ground) between its anchors. rain 0..1 lowers the heads of those standing.
LivestockPose livestockPose(LivestockBeast b, float act, LivestockSlot slot, vec2 travel, float rain, float t) {
  LivestockPose pose;
  float u = slot.u;
  float m = livestockPace(act, u);
  float dist = length(travel);
  pose.face = abs(travel.x) > 1e-4 ? sign(travel.x) : (b.tone < 0.5 ? -1.0 : 1.0);
  pose.turn = 0.75 + 0.25 * abs(travel.x) / max(dist, 1e-4);
  pose.lie = act > 2.5 ? smoothstep(0.03, 0.13, u) * (1.0 - smoothstep(0.8, 0.88, u)) : 0.0;
  pose.head = 1.0;
  if (act < 0.5) {
    // Grazing, with a look up now and then.
    float look = u - (0.12 + 0.7 * fract(b.tone * 3.7));
    float up = smoothstep(0.0, 0.03, look) * (1.0 - smoothstep(0.08, 0.11, look));
    pose.head = 1.0 - 0.9 * smoothstep(0.0, 0.07, u) * (1.0 - smoothstep(0.93, 1.0, u)) * (1.0 - up);
  } else if (act < 1.5) {
    pose.head = 1.0 - 0.85 * smoothstep(0.5, 0.58, u) * (1.0 - smoothstep(0.92, 1.0, u));
  } else if (act < 2.5) {
    pose.head = 1.0 - 0.45 * rain * smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.62, 0.72, u));
  } else {
    // Chewing the cud, head up, or dozing with it lowered.
    float doze = step(0.7, fract(b.tone * 11.0 + slot.n * 0.37));
    pose.head = mix(1.0, mix(0.82 + 0.04 * sin(t * 5.0 + b.tone * 40.0), 0.4, doze), pose.lie);
  }
  // Legs swing with the ground covered, only while it is moving at a walk.
  float speed = (livestockPace(act, min(u + 0.02, 1.0)) - m) / 0.02 * dist / slot.span;
  float walking = smoothstep(0.0, 0.5, speed);
  pose.stride = (b.cattle > 0.5 ? 0.16 : 0.12) * walking * sin(m * dist / 0.7 * 3.1416);
  pose.swish = sin(t * 1.7 + b.tone * 30.0);
  return pose;
}

// Body frame (x toward the head) for screen offset p in body half-lengths.
vec2 livestockFrame(vec2 p, LivestockPose pose) {
  return vec2(p.x * pose.face / pose.turn, p.y);
}

// The animal's signed distance at p (body half-lengths, x right on screen, y up from the feet).
// aa: one dither cell in body half-lengths (detail such as a fleece's lumps shows only above it).
// albedo, normal (screen frame, y up, z toward the eye negative) and top (how much the part faces
// up, where snow settles) describe the part under p: head over neck over body over legs and tail.
float livestockBody(vec2 p, LivestockBeast b, LivestockPose pose, float aa, out vec3 albedo, out vec3 normal, out float top) {
  p = livestockFrame(p, pose);
  bool cattle = b.cattle > 0.5;
  float lie = pose.lie;
  float head = pose.head;
  float by = cattle ? mix(0.92, 0.38, lie) : mix(0.84, 0.42, lie);
  vec2 trunk = cattle ? vec2(0.92, 0.33) : vec2(0.92, 0.42);
  vec2 bc = p - vec2(cattle ? -0.02 : -0.06, by);
  float body = cattle ? sdBox(bc, trunk, 0.24) : sdEllipse(bc, trunk);
  // A sheep's fleece is lumpy where it resolves.
  if (!cattle && aa < 0.2) body -= 0.02 * sin(atan(bc.y, bc.x) * 9.0 + b.tone * 20.0);
  // Near legs swing against the far ones; lying, they fold away under the body.
  float legs = 1e3;
  float farLegs = 1e3;
  float width = cattle ? 0.075 : 0.055;
  float hip = by - (cattle ? 0.12 : 0.24);
  vec4 xs = cattle ? vec4(0.64, -0.6, 0.56, -0.68) : vec4(0.52, -0.58, 0.45, -0.65);
  for (int l = 0; l < 4; l++) {
    float x = xs[l];
    float swing = pose.stride * (l == 0 || l == 3 ? 1.0 : -1.0);
    float leg = segmentDistance(p, vec2(x, hip), vec2(x + swing, 0.02)) - width;
    if (l < 2) legs = min(legs, leg);
    else farLegs = min(farLegs, leg);
  }
  // Neck and head: down at the grass while grazing, up while walking, standing or chewing.
  float headD = 1e3;
  float neck = 1e3;
  if (cattle) {
    vec2 poll = mix(vec2(0.98, 0.34), vec2(1.08, by + 0.24), head);
    vec2 muzzle = mix(vec2(1.2, 0.07), vec2(1.36, by + 0.02), head);
    headD = min(sdTaperCapsule(p, vec2(0.66, by + 0.12), poll, 0.23, 0.17), sdTaperCapsule(p, poll, muzzle, 0.17, 0.12));
    headD = min(headD, segmentDistance(p, poll + vec2(-0.02, 0.05), poll + vec2(-0.17, 0.12)) - 0.035);
  } else {
    vec2 face = mix(vec2(1.0, 0.24), vec2(1.06, by + 0.3), head);
    float angle = mix(-1.1, -0.35, head);
    vec2 hp = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * (p - face);
    headD = min(sdEllipse(hp, vec2(0.25, 0.15)), segmentDistance(p, face + vec2(-0.08, 0.1), face + vec2(-0.2, 0.17)) - 0.03);
    neck = sdTaperCapsule(p, vec2(0.55, by + 0.1), mix(vec2(0.86, 0.3), vec2(0.88, by + 0.32), head), 0.25, 0.16);
  }
  vec2 dock = vec2(cattle ? -0.94 : -0.96, by + (cattle ? 0.22 : 0.05));
  vec2 tip = dock + (cattle ? vec2(-0.06 + 0.05 * pose.swish, -max(0.45 * (1.0 - lie), 0.12)) : vec2(-0.08, -0.12));
  float tail = min(segmentDistance(p, dock, tip) - (cattle ? 0.025 : 0.05), cattle ? length(p - tip) - 0.055 : 1e3);
  float dist = min(min(min(body, neck), min(legs, farLegs)), min(headD, tail));
  vec2 v = bc / trunk;
  // Lit mostly from above, the back brightest and the belly in shade, as a flank seen from a rise.
  normal = normalize(vec3(0.3 * v.x, 1.0 + 0.45 * v.y, -0.3));
  top = smoothstep(0.35, 0.85, v.y);
  vec3 dark = vec3(0.09, 0.08, 0.08);
  vec3 white = vec3(0.88, 0.87, 0.83);
  bool onHead = headD < 0.0 || headD <= dist + 1e-4;
  bool onLegs = body > 0.0 && neck > 0.0 && min(legs, farLegs) <= dist + 1e-4;
  if (cattle) {
    bool friesian = b.breed < 0.45;
    bool hereford = !friesian && b.breed < 0.75;
    vec3 hide = friesian ? mix(white, dark, step(0.52, vnoise(p * vec2(1.7, 2.4) + b.tone * 37.0)))
      : (hereford ? vec3(0.47, 0.24, 0.12) * (0.9 + 0.2 * b.tone) : dark * (1.0 + 0.4 * b.tone));
    // Herefords have white faces, bellies and socks.
    albedo = hereford && p.y < by - 0.2 ? white : hide;
    if (onHead) {
      albedo = hereford ? white : (friesian ? (fract(b.tone * 7.3) < 0.5 ? dark : white) : hide);
      normal = normalize(vec3(0.3, 0.8, -0.5));
      top = 0.0;
    } else if (onLegs) {
      albedo = (hereford ? white : (friesian ? mix(white, dark, step(0.5, b.tone)) : hide)) * (legs <= farLegs ? 1.0 : 0.72);
      normal = normalize(vec3(0.0, 0.5, -0.85));
      top = 0.0;
    } else if (body > 0.0 && tail <= dist + 1e-4) {
      albedo = dark;
      top = 0.0;
    }
  } else {
    vec3 wool = b.tone < 0.04 ? vec3(0.2, 0.18, 0.17) : vec3(0.9, 0.88, 0.8) * (0.92 + 0.08 * fract(b.tone * 13.0));
    if (aa < 0.2) wool *= 0.93 + 0.1 * vnoise(p * 7.0 + b.tone * 9.0);
    vec3 face = vec3(0.14, 0.12, 0.11);
    albedo = wool;
    if (onHead) {
      albedo = face;
      normal = normalize(vec3(0.3, 0.8, -0.5));
      top = 0.0;
    } else if (onLegs) {
      albedo = face * (legs <= farLegs ? 1.0 : 0.75);
      normal = normalize(vec3(0.0, 0.5, -0.85));
      top = 0.0;
    }
  }
  normal.x *= pose.face;
  return dist;
}

// The animal a few dither cells long or less: a soft speck of its mean colour. aa as for the body.
vec4 livestockSpeck(vec2 p, LivestockBeast b, LivestockPose pose, float aa) {
  p = livestockFrame(p, pose);
  float by = b.cattle > 0.5 ? mix(0.92, 0.38, pose.lie) : mix(0.84, 0.42, pose.lie);
  float cover = softFill(sdEllipse(p - vec2(0.0, 0.8 * by), vec2(1.05, 0.62)), 1.3 * aa);
  vec3 mean = b.cattle > 0.5
    ? (b.breed < 0.45 ? vec3(0.5, 0.49, 0.47) : (b.breed < 0.75 ? vec3(0.55, 0.36, 0.24) : vec3(0.1, 0.09, 0.09)))
    : (b.tone < 0.04 ? vec3(0.2, 0.18, 0.17) : vec3(0.86, 0.84, 0.77));
  return vec4(mean, cover);
}

// The contact shadow at p on the ground under the animal (seen at a grazing angle, so flattened),
// 0..1 of full shade.
float livestockShadow(vec2 p, LivestockPose pose) {
  p = livestockFrame(p, pose);
  vec2 under = vec2(p.x / 1.12, (p.y + 0.02) / mix(0.2, 0.26, pose.lie));
  return softFill(length(under) - 1.0, 0.25);
}
`;
