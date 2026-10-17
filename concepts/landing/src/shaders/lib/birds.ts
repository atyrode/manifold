// Birds in flight: species, formations and wingbeat glyphs, drawn per pixel from hashed flights so a
// sky is the same at the same motion time, stands still at motion 0 and costs a fixed handful of
// candidates per pixel. Two views: side-on, for a level pinhole camera (BirdCamera; most scenes),
// and from below, for a camera looking up at birds overhead (Skyward).
//
// Opt-in, unlike the libraries in `libs`: a scene that flies birds puts `birdsGlsl` in its own GLSL
// (after the common preamble, before the functions that call it) and its knobs from `birdKnobs`
// (below). The scene supplies everything the birds cannot know: its camera, where its sky's lanes
// lie and when flights come (BirdSky: how often, the hours, the weather folded into `often`), how
// low a swooping party may come down over its ground, the occlusion test (BirdHit.depth against
// the depth of its own first surface) and the lighting (BirdHit.albedo under its sky light, hazed
// by BirdHit.depth). The library decides what flies and how: the species' size, colour, wingbeat
// and party, the formation, the lane each species keeps to within the scene's, the schedule.
// For a murmuration, fly the Murmuration scene's flock instead (flockSim with a FlockSetup, inked
// with flockSheet): its authored sheet, or with the setup's `emergent` control genuine topological
// boids. Birds that must react to one another rather than fly hashed paths are a CPU job for `Boids`
// (sims/boids.ts), drawn from a sim texture as the flock is.
//
// Side-on. The screen point p is (x across from the frame's centre, y = uv.y), both in screen
// heights; the world is x across, y up from the ground datum, z away from the eye, in the scene's own
// units. BirdCamera.unit converts metres to those units; birds are drawn BirdCamera.enlarge times life
// size (a stylised scene draws its trees and houses large too), the gaps between them stay true.
//
//   const float BIRD_CROW, BIRD_SWALLOW, BIRD_GULL, BIRD_GOOSE, BIRD_RAPTOR, BIRD_PIGEON, BIRD_SWIFT; // species
//   const float BIRD_SOLO, BIRD_LOOSE, BIRD_SKEIN, BIRD_CIRCLING;                 // formations
//   struct BirdSpecies { span, cells, spacing, hz, broad, neck, dihedral, albedo, formation, flock,
//                        lane, scythe, fold, underwing, tips };
//   BirdSpecies birdSpecies(float kind);  // a row of the const table BIRD_SPECIES, by the nearest kind
//   struct BirdCamera { horizon, focal, eye, unit, enlarge };
//   struct BirdFlight { kind, formation, count, dir, lead, radius, swoop, key };
//   struct BirdHit { cover, depth, albedo };
//   struct BirdSky { often, kind, formation, mixA, mixB, depths, band, hours, clock, swoopTo, parallax, seed };
//   BirdSky birdSky(float often, float kind, float formation, vec2 depths, vec2 band, vec2 seed);
//   BirdHit birdFlights(vec2 p, BirdSky sky, BirdCamera cam, float tm, float pxl); // the whole sky
//   BirdHit birdFlightsSeen(vec2 p, BirdSky sky, BirdCamera cam, float tm, float pxl, bool mirrored);
//                                    // mirrored: their image in still water, p the water's sky lookup
//   float birdSchedule(float slot, float tm, vec2 seed, out vec2 key, out float start);
//   BirdFlight birdCrossing(vec2 key, float v, float kind[, float formation], vec2 depths, vec2 band, BirdCamera cam, float aspect);
//   BirdHit birdFlightHit(vec2 p, BirdFlight f, BirdCamera cam, float tm, float pxl);
//   vec2 birdPose(float kind, float tm, float phase | vec3 own); // x wingbeat -1..1, y wings held up (dihedral)
//   float birdShape(vec2 l, vec2 pose, BirdSpecies s);  // glyph distance in half-spans
//   float birdUnderwing(BirdSpecies s, float across);   // how much underwing shows, half-spans out
//
// A scene's sky (see swell, meadow, falls...), with p and cam in its own projection:
//   BirdSky sky = birdSky(K_birds * calm, K_birdKind, K_birdFormation - 1.0, depths, band, seed);
//   sky.hours = vec4(0.22, 0.26, 0.8, 0.84);  sky.clock = vec2(K_time, K_cycle);   // by day only
//   BirdHit b = birdFlights(p, sky, cam, uMotionTime, 1.0 / uRes.y);
//   if (b.cover > 0.5 && b.depth < surfaceDepth) col = mix(b.albedo * light, haze, ...);
// A scene whose water mirrors its sky looks the birds up with the same mirrored point it looks the
// sky up with (aurora, lake, lanterns): birdFlightsSeen(q, sky, cam, tm, pxl, true).
// A scene that decides each flight itself (the countryside's mix by season and hour, its swoops
// down to its own ridges) writes the loop: birdSchedule, birdCrossing, birdFlightHit (countryBirds).
//
// From below. The eye ray (ro, rd) meets a bird at world position pos flying along vel; the scene
// moves its birds itself (Skyward's pigeons wheeling over the street, its swifts looping above):
//   BirdHit birdBelowHit(vec3 ro, vec3 rd, vec3 pos, vec3 vel, float kind, float semi, vec3 own, float tm, float px);
//   float birdBelowShape(vec2 q, float open, float flap, BirdSpecies s);
import { choice, feature, type Blurb, type Option, type ParamDef } from "../../params.ts";

export const birdsGlsl = /* glsl */ `
// Species.
const float BIRD_CROW = 0.0;     // rooks, crows, jackdaws: rowing steadily with short glides
const float BIRD_SWALLOW = 1.0;  // swallows, martins: small and dark, flickering bursts and glides
const float BIRD_GULL = 2.0;     // gulls: pale, long wings crooked at the wrist, slow beats, long glides
const float BIRD_GOOSE = 3.0;    // geese: long necks, deep steady beats, in skeins
const float BIRD_RAPTOR = 4.0;   // buzzards, kites, eagles: broad wings held in a shallow V, soaring
const float BIRD_PIGEON = 5.0;   // pigeons: wheeling in flocks, gliding, beating slowly in bouts
const float BIRD_SWIFT = 6.0;    // swifts: long stiff scythe wings, sailing in long loops
// Formations.
const float BIRD_SOLO = 0.0;
const float BIRD_LOOSE = 1.0;    // a straggling party, each bird drifting and bobbing on its own
const float BIRD_SKEIN = 2.0;    // a V, one arm longer, seen side-on as a chevron
const float BIRD_CIRCLING = 3.0; // turning circles on a thermal: one bird, or a wheeling flock on one circle

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
  vec4 lane;       // the share of a scene's lane it keeps to: depths (near, far), band (low, high), 0..1
  float scythe;    // seen from below: 0 a rounded wing .. 1 a swift's long scythe
  float fold;      // seen from below: how far the wings still spread at the bottom of a beat
  vec4 underwing;  // seen from below (or soaring above the eye): its colour, how much shows toward the tips
  float tips;      // how dark the wingtips stay past the pale underwing (a buzzard's dark fingers)
};

// One row per species, in kind order (BIRD_CROW = 0 ... BIRD_SWIFT = 6): a lookup, not a branch per
// kind, so the many loops that ask for a bird's species stay small.
const BirdSpecies BIRD_SPECIES[7] = BirdSpecies[7](
  BirdSpecies(0.9, 6.0, 7.0, 2.4, 0.0, 0.22, 0.0, vec3(0.06, 0.055, 0.065), BIRD_LOOSE, vec2(2.0, 6.0), vec4(0.1, 0.7, 0.1, 0.85), 0.15, 0.85, vec4(0.06, 0.055, 0.065, 0.0), 0.0),
  BirdSpecies(0.33, 5.0, 5.0, 4.0, 0.0, 0.18, 0.0, vec3(0.045, 0.05, 0.08), BIRD_LOOSE, vec2(2.0, 4.0), vec4(0.0, 0.25, 0.0, 0.55), 0.8, 0.85, vec4(0.55, 0.5, 0.45, 0.3), 0.0),
  BirdSpecies(1.3, 7.0, 9.0, 1.6, 0.0, 0.22, 0.1, vec3(0.78, 0.8, 0.82), BIRD_LOOSE, vec2(1.0, 4.0), vec4(0.1, 0.8, 0.1, 0.8), 0.55, 0.9, vec4(0.78, 0.8, 0.82, 0.0), 0.0),
  BirdSpecies(1.6, 7.0, 9.0, 2.0, 0.3, 0.55, 0.0, vec3(0.2, 0.18, 0.15), BIRD_SKEIN, vec2(5.0, 9.0), vec4(0.35, 1.0, 0.4, 1.0), 0.3, 0.85, vec4(0.42, 0.4, 0.36, 0.4), 0.0),
  BirdSpecies(1.3, 10.0, 0.0, 3.0, 1.0, 0.18, 0.25, vec3(0.2, 0.14, 0.09), BIRD_CIRCLING, vec2(1.0, 1.0), vec4(0.2, 0.7, 0.25, 0.8), 0.0, 0.95, vec4(0.55, 0.45, 0.35, 0.5), 1.0),
  BirdSpecies(0.72, 5.0, 4.0, 1.15, 0.2, 0.15, 0.0, vec3(0.07, 0.075, 0.09), BIRD_CIRCLING, vec2(5.0, 9.0), vec4(0.0, 0.5, 0.0, 0.6), 0.0, 0.85, vec4(0.42, 0.44, 0.48, 0.4), 0.0),
  BirdSpecies(0.4, 5.0, 6.0, 0.0, 0.0, 0.1, 0.0, vec3(0.07, 0.075, 0.09), BIRD_LOOSE, vec2(3.0, 7.0), vec4(0.2, 0.9, 0.4, 1.0), 1.0, 1.0, vec4(0.07, 0.075, 0.09, 0.0), 0.0)
);

// The species of a kind, rounded to the nearest (below crows: crows; above swifts: swifts).
BirdSpecies birdSpecies(float kind) {
  return BIRD_SPECIES[int(clamp(kind + 0.5, 0.0, 6.0))];
}

// The party a species flies in some other formation: one alone, at least two in a loose party, a
// V five to nine strong, its own party on a circle.
vec2 birdParty(BirdSpecies s, float formation) {
  if (formation < 0.5) return vec2(1.0);
  if (formation < 1.5) return max(s.flock, vec2(2.0, 4.0));
  if (formation < 2.5) return max(s.flock, vec2(5.0, 9.0));
  return s.flock;
}

// A scene's lanes narrowed to the share a species keeps to (BirdSpecies.lane): x, y depths; z, w band.
vec4 birdLane(float kind, vec2 depths, vec2 band) {
  vec4 lane = birdSpecies(kind).lane;
  return vec4(mix(depths.xx, depths.yy, lane.xy), mix(band.xx, band.yy, lane.zw));
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

// A flight of \`kind\` in \`formation\` (-1: the species' own, in its usual party) crossing the frame
// at progress v (0 just off one side .. 1 just off the other), hashed from key: a lane at a depth
// within \`depths\` (world), cruising at screen heights within \`band\` and rising and falling slowly;
// a circling flight glides in, hangs turning near the middle while it climbs, and glides off. A
// solo bird or a loose party swoops down now and then (swoop, which the scene turns into height
// over its own ground).
BirdFlight birdCrossing(vec2 key, float v, float kind, float formation, vec2 depths, vec2 band, BirdCamera cam, float aspect) {
  BirdSpecies s = birdSpecies(kind);
  float hd = hash12(key + 5.3);
  float hy = hash12(key + 13.7);
  float hc = hash12(key + 11.3);
  BirdFlight f;
  f.kind = kind;
  f.formation = formation < 0.0 ? s.formation : formation;
  f.key = key;
  f.dir = hash12(key + 7.9) < 0.5 ? -1.0 : 1.0;
  vec2 party = formation < 0.0 ? s.flock : birdParty(s, formation);
  f.count = party.x + floor((party.y - party.x + 1.0) * hc * 0.999);
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

// The same in the species' own formation and party.
BirdFlight birdCrossing(vec2 key, float v, float kind, vec2 depths, vec2 band, BirdCamera cam, float aspect) {
  return birdCrossing(key, v, kind, -1.0, depths, band, cam, aspect);
}

// The wing pose at motion time tm: x the wingbeat (-1 down .. 1 up), y how far the wings are held up.
// own: the bird's beat phase, the phase of its rhythm (bursts, glides, bouts) and its own pace
// (wingbeats per second added to the species'). Crows row on with short glides; swallows flicker in
// bursts; gulls beat slowly between long glides; geese beat deep and steady; raptors soar, flapping
// only now and then; pigeons glide, beating slowly in bouts; swifts sail on stiff wings.
vec2 birdPose(float kind, float tm, vec3 own) {
  BirdSpecies s = birdSpecies(kind);
  float phase = own.x;
  float beat = sin(tm * TAU * (s.hz + own.z) + phase);
  if (kind < 0.5) return vec2(beat * (0.35 + 0.65 * smoothstep(-0.7, -0.2, sin(tm * 0.9 + own.y))), 0.0);
  if (kind < 1.5) return vec2(mix(-0.2, beat, smoothstep(0.2, 0.6, sin(tm * 1.7 + own.y))), 0.0);
  if (kind < 2.5) return vec2(mix(0.1, beat * 0.8, smoothstep(-0.1, 0.4, sin(tm * 0.6 + own.y))), s.dihedral);
  if (kind < 3.5) return vec2(beat * 0.85, 0.0);
  if (kind < 4.5) return vec2(smoothstep(0.85, 0.95, sin(tm * 0.37 + own.y)) * beat, s.dihedral);
  if (kind < 5.5) return vec2(smoothstep(0.1, 0.6, 0.5 + 0.5 * sin(tm * 0.13 + own.y)) * sin(tm * (s.hz + own.z) * TAU + phase), 0.0);
  return vec2(0.0);
}

// The same with one phase for the beat and the rhythm, at the species' pace.
vec2 birdPose(float kind, float tm, float phase) {
  return birdPose(kind, tm, vec3(phase, phase, 0.0));
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

// How much of the species' underwing colour shows at \`across\` half-spans out along a wing (from
// below, or side-on with its undersides toward the eye): none over the body, more toward the tips,
// and the tips themselves dark again where the species' are.
float birdUnderwing(BirdSpecies s, float across) {
  float a = abs(across);
  return smoothstep(0.2, 0.45, a) * s.underwing.a * (1.0 - s.tips * smoothstep(0.75, 0.9, a));
}

// The nearest bird of flight f covering screen point p (cut per cell; no occlusion, the scene
// compares depth with its own surfaces). Each bird is at least the species' cells across, its strokes
// at least about a cell wide, so it reads however far it flies. A bird above the eye holding its
// wings up in a V (soaring: pose.y, the buzzard's dihedral) shows their undersides, the more the
// steeper the eye looks up at it: its pale underwing toward the tips (birdUnderwing).
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
    vec2 pose = birdPose(f.kind, tm, TAU * hm);
    float d = birdShape(l, pose, s) * size - max(0.0, 0.45 * pxl - 0.08 * size);
    if (hardFill(d, 0.35 * pxl) > 0.5) {
      float under = clamp(4.0 * pose.y, 0.0, 1.0) * smoothstep(0.0, 0.3, (at.y - cam.eye) / at.z);
      hit = BirdHit(1.0, at.z, mix(s.albedo, s.underwing.rgb, birdUnderwing(s, l.x) * under));
    }
  }
  return hit;
}

// A scene's sky of crossing flights (birdFlights): how often 0..1 (the chance each slot's cycle
// sends one: the knob, times whatever the scene's weather allows), the species (-1: mixed, each
// flight's picked by the weights mixA (rooks, swallows, gulls, geese) and mixB (buzzard, pigeons,
// swifts)) and formation (-1: the species' own), the scene's lanes (depths, world; band, screen
// heights) of which each species keeps to its share, the hours they keep (the time of day at the
// flight's start on the scene's clock (K_time, K_cycle): in from x to y, out from z to w; z < x for
// a night window over midnight), the world height a swooping party comes down to, the pointer's
// shift of the view at depth one (each flight shifts by it over its depth) and the hashes' seed.
struct BirdSky {
  float often;
  float kind;
  float formation;
  vec4 mixA;
  vec3 mixB;
  vec2 depths;
  vec2 band;
  vec4 hours;
  vec2 clock;
  float swoopTo;
  vec2 parallax;
  vec2 seed;
};

// A sky at any hour, mixed evenly, never swooping, without parallax: set the other fields after.
BirdSky birdSky(float often, float kind, float formation, vec2 depths, vec2 band, vec2 seed) {
  return BirdSky(often, kind, formation, vec4(1.0), vec3(1.0), depths, band, vec4(-1.0, 0.0, 2.0, 3.0), vec2(0.0), 1e9, vec2(0.0), seed);
}

// Whether a flight setting out at time of day tod keeps the sky's hours, 0..1.
float birdHours(vec4 hours, float tod) {
  float rise = smoothstep(hours.x, hours.y, tod);
  float fall = smoothfall(hours.w, hours.z, tod);
  return hours.z < hours.x ? max(rise, fall) : rise * fall;
}

// A mixed flight's species: the weights' share that roll (0..1) falls in.
float birdMixed(vec4 mixA, vec3 mixB, float roll) {
  float r = roll * (dot(mixA, vec4(1.0)) + dot(mixB, vec3(1.0)));
  float sum = 0.0;
  for (int k = 0; k < 6; k++) {
    sum += k < 4 ? mixA[k] : mixB[k - 4];
    if (r < sum) return float(k);
  }
  return BIRD_SWIFT;
}

// The nearest bird of the sky's flights covering screen point p (four slots on birdSchedule), or
// with \`mirrored\` their image in still water at the ground datum (y = 0): the flights fly as the
// camera sees them, the image is projected for the camera mirrored under the water, and p is the
// water's lookup point (the pixel's height below the horizon mirrored above it, as the scene's own
// reflection of the sky has it, ripples and all).
BirdHit birdFlightsSeen(vec2 p, BirdSky sky, BirdCamera cam, float tm, float pxl, bool mirrored) {
  BirdHit near = birdNone();
  if (sky.often <= 0.0) return near;
  float aspect = uRes.x / uRes.y;
  BirdCamera seen = cam;
  if (mirrored) seen.eye = -cam.eye;
  for (int j = 0; j < 4; j++) {
    vec2 key;
    float start;
    float v = birdSchedule(float(j), tm, sky.seed, key, start);
    if (v <= 0.0 || v >= 1.0) continue;
    if (hash12(key) >= sky.often * birdHours(sky.hours, timeOfDayM(sky.clock.x, sky.clock.y, start))) continue;
    float kind = sky.kind < 0.0 ? birdMixed(sky.mixA, sky.mixB, hash12(key + 1.7)) : sky.kind;
    vec4 lane = birdLane(kind, sky.depths, sky.band);
    BirdFlight f = birdCrossing(key, v, kind, sky.formation, lane.xy, lane.zw, cam, aspect);
    if (f.swoop > 0.01) f.lead.y = mix(f.lead.y, min(f.lead.y, sky.swoopTo), f.swoop);
    BirdHit hit = birdFlightHit(p + sky.parallax / f.lead.z, f, seen, tm, pxl);
    if (hit.cover > 0.5 && hit.depth < near.depth) near = hit;
  }
  return near;
}

// The sky's flights as the camera sees them.
BirdHit birdFlights(vec2 p, BirdSky sky, BirdCamera cam, float tm, float pxl) {
  return birdFlightsSeen(p, sky, cam, tm, pxl, false);
}

// ---- Seen from below ----

// A bird from below in its own frame (x forward, y across, 1 = half its span): a signed distance.
// open: how far the wings spread; flap: -1..1 (the pose's wingbeat); the species' scythe sweeps the
// wings back and thins them toward a swift's.
float birdBelowShape(vec2 q, float open, float flap, BirdSpecies s) {
  float scythe = s.scythe;
  q.y = abs(q.y);
  float d = sdTaperCapsule(q, vec2(0.3, 0.0), vec2(-0.3, 0.0), 0.12, 0.08);
  d = min(d, sdTaperCapsule(q, vec2(-0.28, 0.0), vec2(-0.62, 0.0), mix(0.06, 0.03, scythe), mix(0.13, 0.06, scythe)));
  float span = mix(0.3, 1.0, open) * (1.0 - 0.22 * abs(flap));
  vec2 sh = vec2(mix(0.1, 0.05, scythe), mix(0.07, 0.05, scythe));
  vec2 wrist = vec2(mix(-0.02, -0.18, scythe) - 0.08 * flap, 0.5 * span);
  vec2 tip = vec2(mix(-0.34, -0.62, scythe) - 0.12 * flap, span);
  d = min(d, sdTaperCapsule(q, sh, wrist, mix(0.2, 0.11, scythe), mix(0.15, 0.08, scythe)));
  d = min(d, sdTaperCapsule(q, wrist, tip, mix(0.15, 0.08, scythe), mix(0.05, 0.02, scythe)));
  return d;
}

// A bird of \`kind\` at world position pos flying along vel, drawn with half-span semi (world units:
// the scene's own enlargement), as the eye ray (ro, rd) sees it from below: cover (cut per cell),
// depth (its distance from the eye; the scene hides it behind nearer surfaces) and albedo (the
// underwing paler toward the tips where the species' is: birdUnderwing). own: as birdPose; px:
// radians a cell spans.
BirdHit birdBelowHit(vec3 ro, vec3 rd, vec3 pos, vec3 vel, float kind, float semi, vec3 own, float tm, float px) {
  vec3 dv = pos - ro;
  float db = length(dv);
  vec3 bd = dv / db;
  float c = dot(rd, bd);
  float ex = 1.4 * semi / db;
  if (c < 1.0 - 0.5 * ex * ex) return birdNone();
  vec3 m = rd * (db / c) - dv;
  vec3 vp = vel - bd * dot(vel, bd);
  float vl = length(vp);
  vec3 hv = vl > 1e-3 ? vp / vl : normalize(cross(bd, vec3(0.0, 1.0, 0.0)));
  vec3 sv = cross(bd, hv);
  vec2 q = vec2(dot(m, hv), dot(m, sv)) / semi;
  // Wings: the pose's beat; from below they spread less at the bottom of a beat.
  BirdSpecies s = birdSpecies(kind);
  float flap = birdPose(kind, tm, own).x;
  float open = mix(s.fold, 1.0, 0.5 + 0.5 * flap);
  float aa = 0.55 * px * db / semi;
  float cover = hardFill(birdBelowShape(q, open, flap, s), aa);
  return BirdHit(cover, db, mix(s.albedo, s.underwing.rgb, birdUnderwing(s, q.y)));
}
`;

/** The species a scene can fly, by the `birdKind` label: the GLSL kinds (BIRD_CROW = 0...). */
export const BIRD_KIND = {
  rooks: 0,
  swallows: 1,
  gulls: 2,
  geese: 3,
  buzzard: 4,
  pigeons: 5,
  swifts: 6,
} as const;

export type BirdKind = keyof typeof BIRD_KIND;

/** The `birdKind` choice's options, in BIRD_KIND's order. */
export const BIRD_KINDS: readonly Option[] = Object.entries(BIRD_KIND).map(([label, value]) => ({
  label,
  value,
}));

/** The `birdFormation` choice: the GLSL formation is the value - 1 (BIRD_SOLO = 0...; -1 the species' own). */
export const BIRD_FORMATIONS = [
  { label: "usual", value: 0 },
  { label: "solo", value: 1 },
  { label: "party", value: 2 },
  { label: "V", value: 3 },
  { label: "circling", value: 4 },
] as const satisfies readonly Option[];

export type BirdOptions = {
  /** How often a flight passes while on (the `birds` amount), 0.05..1; default 0.5. */
  often?: number;
  /** Start on; default off. */
  on?: boolean;
  /** Lab group; default "birds" (heading: `birdsGroup`). */
  group?: string;
  /** The scene's own sentences for the switch: where its birds fly, when, and what hides them. */
  help: string;
} & (
  | {
      /** The species the scene starts with. */
      kind: BirdKind;
      /** Offers "mixed" (`birdKind` -1: the scene picks each flight's species), this is its help. */
      mixed?: string;
    }
  | { kind: "mixed"; mixed: string }
);

/**
 * The birds component's knobs, for a scene that flies `birdsGlsl`:
 * K_birds how often a flight passes (0 off; BirdSky.often), K_birdKind the species (the GLSL kind,
 * -1 mixed: BirdSky.kind), K_birdFormation the formation (K_birdFormation - 1.0, -1 the species'
 * own: BirdSky.formation). Off unless `on`; the choices show only while it is on. The lab draws the
 * three as one birds card (widget `flyway`, src/lab/flyway.ts).
 */
export function birdKnobs(options: BirdOptions): ParamDef[] {
  const group = options.group ?? "birds";
  const kinds: Option[] =
    options.mixed === undefined ? [...BIRD_KINDS] : [{ label: "mixed", value: -1 }, ...BIRD_KINDS];
  const kind = options.kind === "mixed" ? -1 : BIRD_KIND[options.kind];
  const mixed = options.mixed === undefined ? "" : `Mixed: ${options.mixed} `;
  return [
    feature(
      group,
      "birds",
      "birds",
      options.on ?? false,
      "how often",
      options.often ?? 0.5,
      `${options.help} The amount is how often a flight passes.`,
      { widget: { kind: "flyway", part: "birds" } },
    ),
    choice(
      group,
      "birdKind",
      "which birds",
      kinds,
      kind,
      `${mixed}Rooks rowing in loose parties, swallows flickering low and near, pale gulls on crooked wings, geese in a V far and high, a buzzard circling on a thermal, pigeons wheeling in a flock, swifts sailing on stiff scythe wings.`,
      { when: "birds", widget: { kind: "flyway", part: "kind" } },
    ),
    choice(
      group,
      "birdFormation",
      "formation",
      BIRD_FORMATIONS,
      0,
      "How they fly: as that kind usually does, alone, as a loose party, in a V, or circling on a thermal (a party wheels round one circle).",
      { when: "birds", widget: { kind: "flyway", part: "formation" } },
    ),
  ];
}

/** Lab heading for the default "birds" group, on the lab's World shelf. */
export const birdsGroup: Blurb = {
  title: "Birds",
  shelf: "world",
  blurb: "Flights of birds crossing the sky: which, how they fly, and how often.",
};
