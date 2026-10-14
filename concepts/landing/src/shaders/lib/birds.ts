// Birds in flight for any scene with a side-on pinhole camera: species, formations and wingbeat
// glyphs, drawn per pixel from hashed flights so a sky is the same at the same motion time, stands
// still at motion 0 and costs a fixed handful of candidates per pixel.
//
// Opt-in, unlike the libraries in `libs`: a scene that flies birds puts `birdsGlsl` in its own GLSL
// (after the common preamble, before the functions that call it). The scene supplies everything the
// birds cannot know: its camera (BirdCamera), when and which flights come (its own slot loop around
// birdSchedule, e.g. by time of day, season, weather and a knob), how low a swooping party may come
// down over its ground, the occlusion test (BirdHit.depth against the depth of its own first surface)
// and the lighting (BirdHit.albedo under its sky light, hazed by BirdHit.depth). The countryside
// (scenes/country/wildlife.ts) is the reference consumer. For a murmuration, fly the Murmuration
// scene's flock instead (flockSim with a FlockSetup, inked with flockSheet).
//
// Coordinates: the screen point p is (x across from the frame's centre, y = uv.y), both in screen
// heights; the world is x across, y up from the ground datum, z away from the eye, in the scene's own
// units. BirdCamera.unit converts metres to those units; birds are drawn BirdCamera.enlarge times life
// size (a stylised scene draws its trees and houses large too), the gaps between them stay true.
//
//   const float BIRD_CROW, BIRD_SWALLOW, BIRD_GULL, BIRD_GOOSE, BIRD_RAPTOR;      // species
//   const float BIRD_SOLO, BIRD_LOOSE, BIRD_SKEIN, BIRD_CIRCLING;                 // formations
//   struct BirdSpecies { span, cells, spacing, hz, broad, neck, dihedral, albedo, formation, flock };
//   BirdSpecies birdSpecies(float kind);
//   struct BirdCamera { horizon, focal, eye, unit, enlarge };
//   struct BirdFlight { kind, formation, count, dir, lead, radius, swoop, key };
//   struct BirdHit { cover, depth, albedo };
//   float birdSchedule(float slot, float tm, vec2 seed, out vec2 key, out float start);
//   BirdFlight birdCrossing(vec2 key, float v, float kind, vec2 depths, vec2 band, BirdCamera cam, float aspect);
//   BirdHit birdFlightHit(vec2 p, BirdFlight f, BirdCamera cam, float tm, float pxl);
//   vec2 birdPose(float kind, float tm, float phase);   // x wingbeat -1..1, y wings held up (dihedral)
//   float birdShape(vec2 l, vec2 pose, BirdSpecies s);  // glyph distance in half-spans
//
// A scene's loop (see countryBirds):
//   BirdHit near = birdNone();
//   for (int j = 0; j < 4; j++) {
//     vec2 key; float start;
//     float v = birdSchedule(float(j), uMotionTime, seed, key, start);
//     if (v <= 0.0 || v >= 1.0 || hash12(key) >= often) continue;
//     BirdFlight f = birdCrossing(key, v, BIRD_CROW, vec2(1.3, 3.2), vec2(0.7, 0.86), cam, aspect);
//     f.lead.y = mix(f.lead.y, groundBelow + clearance, f.swoop);   // or leave it in the sky
//     BirdHit h = birdFlightHit(p, f, cam, uMotionTime, 1.0 / uRes.y);
//     if (h.cover > 0.5 && h.depth < near.depth) near = h;
//   }
//   if (near.cover > 0.5 && near.depth < surfaceDepth) col = mix(near.albedo * light, haze, ...);
export const birdsGlsl = /* glsl */ `
// Species.
const float BIRD_CROW = 0.0;     // rooks, crows, jackdaws: rowing steadily with short glides
const float BIRD_SWALLOW = 1.0;  // swallows, martins: small and dark, flickering bursts and glides
const float BIRD_GULL = 2.0;     // gulls: pale, long wings crooked at the wrist, slow beats, long glides
const float BIRD_GOOSE = 3.0;    // geese: long necks, deep steady beats, in skeins
const float BIRD_RAPTOR = 4.0;   // buzzards, kites, eagles: broad wings held in a shallow V, soaring
// Formations.
const float BIRD_SOLO = 0.0;
const float BIRD_LOOSE = 1.0;    // a straggling party, each bird drifting and bobbing on its own
const float BIRD_SKEIN = 2.0;    // a V, one arm longer, seen side-on as a chevron
const float BIRD_CIRCLING = 3.0; // one bird turning circles on a thermal

struct BirdSpecies {
  float span;      // wingspan, metres
  float cells;     // never drawn narrower than this many dither cells, however far it flies
  float spacing;   // metres between birds in its formation
  float hz;        // wingbeats per second of motion time
  float broad;     // 0 slim wings .. 1 a broad plank of a wing
  float neck;      // how far the head reaches forward, half-spans
  float dihedral;  // how far the wings are held up when gliding or soaring
  vec3 albedo;     // seen from below against the sky
  float formation; // how it flies
  vec2 flock;      // birds in a party: fewest, most
};

BirdSpecies birdSpecies(float kind) {
  if (kind < 0.5) return BirdSpecies(0.9, 6.0, 7.0, 2.4, 0.0, 0.22, 0.0, vec3(0.06, 0.055, 0.065), BIRD_LOOSE, vec2(2.0, 6.0));
  if (kind < 1.5) return BirdSpecies(0.33, 5.0, 5.0, 4.0, 0.0, 0.18, 0.0, vec3(0.045, 0.05, 0.08), BIRD_LOOSE, vec2(2.0, 4.0));
  if (kind < 2.5) return BirdSpecies(1.3, 7.0, 9.0, 1.6, 0.0, 0.22, 0.1, vec3(0.78, 0.8, 0.82), BIRD_LOOSE, vec2(1.0, 4.0));
  if (kind < 3.5) return BirdSpecies(1.6, 7.0, 9.0, 2.0, 0.3, 0.55, 0.0, vec3(0.2, 0.18, 0.15), BIRD_SKEIN, vec2(5.0, 9.0));
  return BirdSpecies(1.3, 8.0, 0.0, 3.0, 1.0, 0.18, 0.25, vec3(0.2, 0.14, 0.09), BIRD_CIRCLING, vec2(1.0, 1.0));
}

struct BirdCamera {
  float horizon;   // screen height (uv.y) of the eye level
  float focal;     // screen heights per unit of x / z
  float eye;       // the eye's height above the ground datum, world units
  float unit;      // world units per metre
  float enlarge;   // birds drawn this many times life size (their spacing and circles stay true)
};

struct BirdFlight {
  float kind;
  float formation;
  float count;
  float dir;       // +1 left to right, -1 right to left
  vec3 lead;       // the leader (a circling bird: its circle's centre), world units
  float radius;    // a circling bird's circle, world units
  float swoop;     // 0..1: how far down toward the ground the party is swooping now (the scene lowers lead.y)
  vec2 key;
};

struct BirdHit {
  float cover;     // 1 on a bird, cut per cell
  float depth;     // its distance (world units); 1e3 where there is none
  vec3 albedo;
};

BirdHit birdNone() {
  return BirdHit(0.0, 1e3, vec3(0.0));
}

// Flight slot \`slot\`'s cycle (52 + 15 slot seconds of motion time, staggered): the cycle's hash key
// (offset by seed), the motion time the cycle began (to ask what light the flight set out in) and the
// flight's progress across the frame, 0..1 during the part of the cycle it takes (60-85%) and outside
// that range while the slot's sky is empty.
float birdSchedule(float slot, float tm, vec2 seed, out vec2 key, out float start) {
  float period = 52.0 + 15.0 * slot;
  float clock = tm / period + 0.5 + 0.27 * slot;
  float n = floor(clock);
  key = vec2(n, 9.1 * slot + 2.3) + seed;
  start = (n - 0.5 - 0.27 * slot) * period;
  float hs = hash12(key + 3.1);
  float span = 0.6 + 0.25 * hs;
  return (fract(clock) - (1.0 - span) * fract(hs * 7.3)) / span;
}

// A flight of \`kind\` crossing the frame at progress v (0 just off one side .. 1 just off the other),
// hashed from key: a lane at a depth within \`depths\` (world), cruising at screen heights within
// \`band\` and rising and falling slowly, a party of the species' usual size; a circling bird glides
// in, hangs turning near the middle while it climbs, and glides off. Crows, swallows and gulls swoop
// down now and then (swoop, which the scene turns into height over its own ground).
BirdFlight birdCrossing(vec2 key, float v, float kind, vec2 depths, vec2 band, BirdCamera cam, float aspect) {
  BirdSpecies s = birdSpecies(kind);
  float hd = hash12(key + 5.3);
  float hy = hash12(key + 13.7);
  float hc = hash12(key + 11.3);
  BirdFlight f;
  f.kind = kind;
  f.formation = s.formation;
  f.key = key;
  f.dir = hash12(key + 7.9) < 0.5 ? -1.0 : 1.0;
  f.count = s.flock.x + floor((s.flock.y - s.flock.x + 1.0) * hc * 0.999);
  float z = mix(depths.x, depths.y, hd);
  float g = 2.0 * v - 1.0;
  float circling = f.formation > 2.5 ? 1.0 : 0.0;
  f.radius = circling * (12.0 + 10.0 * hy) * cam.unit * smoothstep(0.0, 0.2, v) * smoothfall(1.0, 0.8, v);
  // Far enough out at each end that the whole party is off the frame (0.06: a bird's own half-span).
  float reach = 0.5 * aspect + (f.count * s.spacing * 1.3 * cam.unit + f.radius) * cam.focal / z + 0.06;
  float x = circling > 0.5 ? 0.6 * aspect * (hc - 0.5) + f.dir * 1.8 * reach * g * g * g : f.dir * g * reach;
  float cruise = mix(band.x, band.y, hy) + 0.02 * sin(v * 5.0 + 6.0 * hy);
  // A circling bird climbs some 10 m on its thermal while it turns.
  f.lead = vec3(x * z / cam.focal, cam.eye + (cruise - cam.horizon) * z / cam.focal + 10.0 * cam.unit * circling * v, z);
  f.swoop = 0.0;
  if (circling < 0.5 && f.formation < 1.5 && hash12(key + 17.3) < 0.45) {
    float w = (v - 0.3 - 0.4 * hash12(key + 19.1)) / 0.1;
    f.swoop = exp(-w * w);
  }
  return f;
}

// The wing pose at motion time tm: x the wingbeat (-1 down .. 1 up), y how far the wings are held up.
// Crows row on with short glides; swallows flicker in bursts; gulls beat slowly between long
// glides; geese beat deep and steady; raptors soar, flapping only now and then.
vec2 birdPose(float kind, float tm, float phase) {
  BirdSpecies s = birdSpecies(kind);
  float beat = sin(tm * TAU * s.hz + phase);
  if (kind < 0.5) return vec2(beat * (0.35 + 0.65 * smoothstep(-0.7, -0.2, sin(tm * 0.9 + phase))), 0.0);
  if (kind < 1.5) return vec2(mix(-0.2, beat, smoothstep(0.2, 0.6, sin(tm * 1.7 + phase))), 0.0);
  if (kind < 2.5) return vec2(mix(0.1, beat * 0.8, smoothstep(-0.1, 0.4, sin(tm * 0.6 + phase))), s.dihedral);
  if (kind < 3.5) return vec2(beat * 0.85, 0.0);
  return vec2(smoothstep(0.85, 0.95, sin(tm * 0.37 + phase)) * beat, s.dihedral);
}

// A bird's silhouette in half-spans, x along its flight and y up: the wings from the shoulder
// through the wrist to the tip, a shallow M between beats, raised into a V (pose.x 1) or lowered
// (-1) and lifted by pose.y; broad wings are deeper at the root and lie flatter, a gull's crook at
// the wrist; a short body below the shoulders, the head (and a goose's neck) forward.
float birdShape(vec2 l, vec2 pose, BirdSpecies s) {
  vec2 a = vec2(abs(l.x), l.y);
  vec2 wrist = vec2(0.45, 0.18 + 0.28 * pose.x + 0.5 * pose.y - 0.1 * s.broad);
  vec2 tip = vec2(1.0, 0.05 + 0.7 * pose.x + 1.4 * pose.y * s.broad);
  float wing = min(sdTaperCapsule(a, vec2(0.0), wrist, 0.1 + 0.08 * s.broad, 0.08 + 0.06 * s.broad),
                   sdTaperCapsule(a, wrist, tip, 0.08 + 0.06 * s.broad, 0.04));
  return min(wing, sdTaperCapsule(l, vec2(s.neck, -0.04), vec2(-0.2, -0.08), 0.06 + 0.03 * (1.0 - s.neck), 0.06));
}

// The nearest bird of flight f covering screen point p (cut per cell; no occlusion, the scene
// compares depth with its own surfaces). Each bird is at least the species' cells across, its strokes
// at least about a cell wide, so it reads however far it flies.
BirdHit birdFlightHit(vec2 p, BirdFlight f, BirdCamera cam, float tm, float pxl) {
  BirdHit hit = birdNone();
  BirdSpecies s = birdSpecies(f.kind);
  float semi = 0.5 * max(s.span * cam.unit * cam.enlarge * cam.focal / f.lead.z, s.cells * pxl);
  vec2 lead = vec2(f.lead.x / f.lead.z * cam.focal, cam.horizon + (f.lead.y - cam.eye) / f.lead.z * cam.focal);
  // The party's reach on screen: reject the pixel before looking at any bird.
  float extent = (f.count * s.spacing * 1.4 * cam.unit + f.radius) * cam.focal / f.lead.z + 2.0 * semi;
  if (abs(p.x - lead.x) > extent || abs(p.y - lead.y) > extent) return hit;
  float turn = tm * TAU / (13.0 + 5.0 * fract(f.key.x * 0.37 + f.key.y)) * f.dir;
  for (int m = 0; m < 9; m++) {
    float fm = float(m);
    if (fm >= f.count) break;
    float hm = hash12(f.key + vec2(3.3 * fm, 23.9));
    vec3 at = f.lead;
    float heading = f.dir;
    float sp = s.spacing * cam.unit;
    if (f.formation > 2.5) {
      float a = turn + TAU * hm;
      at += f.radius * vec3(cos(a), 0.0, sin(a));
      heading = -sin(a) * f.dir < 0.0 ? -1.0 : 1.0;
    } else if (f.formation > 1.5) {
      // A skein: birds alternate between the two arms behind the leader, one arm longer and a
      // little wavering, the whole V tipped so it reads as a chevron from the side.
      float rank = floor((fm + 1.0) * 0.5);
      float arm = mod(fm, 2.0) < 0.5 ? 1.0 : -1.0;
      at += sp * vec3(-f.dir * rank * (arm > 0.0 ? 0.8 : 1.0), arm * rank * 0.6 + 0.12 * sin(tm * 0.5 + 2.0 * fm), 0.0);
    } else {
      at += sp * vec3(-f.dir * fm * (0.8 + 0.5 * hm), (fract(hm * 13.7) - 0.5) * 1.4, 0.0);
      at.xy += 0.25 * sp * vec2(sin(tm * 0.31 + 9.0 * hm), sin(tm * 0.47 + 5.0 * hm));
    }
    vec2 seen = vec2(at.x / at.z * cam.focal, cam.horizon + (at.y - cam.eye) / at.z * cam.focal);
    float size = semi * f.lead.z / at.z;
    vec2 l = (p - seen) / size;
    if (dot(l, l) > 2.0 || at.z >= hit.depth) continue;
    l.x *= heading;
    float d = birdShape(l, birdPose(f.kind, tm, TAU * hm), s) * size - max(0.0, 0.45 * pxl - 0.08 * size);
    if (hardFill(d, 0.35 * pxl) > 0.5) hit = BirdHit(1.0, at.z, s.albedo);
  }
  return hit;
}
`;
