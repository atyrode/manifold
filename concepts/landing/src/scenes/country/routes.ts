// The countryside's river, its network of tracks and the people and carts on them. shader.ts
// concatenates this into countryGlsl right after the field materials, so everything after it (the
// hedgerow trees, the shading in sceneCountry) can call it.
//
// River (K_river): the course down the second ridge stays countryRiver's; the knob scales the open
// water against the original stream, pow(2 K, 1.807): 1 at the default 0.5, 0 dried up, 3.5 a
// broad river. Its reeds widen more slowly (1.7 pow(scale, 0.8) of the stream's half-width), a
// broad river shows shingle at its edge, and hedgerow trees rooted in a broadened river give way.
//
// Tracks (K_tracks): the lane over the near field is always there. Raising the knob brings in a
// connected network, each part as the knob passes its rank, plainer toward the top of the range:
//   rank 0    the lane's way on: the west track up the river's west bank on ridge 1 to the saddle
//             below the village, the link up ridge 2 and the street between the cottages' two rows;
//   rank 0.2  the road on along the valley east of the village, and the bridge track leaving the
//             west track along ridge 1 over the river by a stone bridge (the only crossing);
//   rank 0.4  the hill track climbing over ridge 2 from the valley road, and the chalk track up the
//             far down (ridge 3), right of the chalk figure.
// Every part is a curve in a ridge's slope coordinates: a climb (world x at down-slope v) or a
// contour (v at x, the street's drop below the crest at screen x). Widths are world widths, so they
// narrow with depth; narrower than the dither holds, a track thins instead of breaking up. Where it
// hides behind a nearer ridge or over a crest, the next part comes out of hiding in line with it.
//
// Walkers and carts (K_walkers, K_carts) follow ways along these routes, analytically: position =
// f(route parameter, the motion clock, a hash), out and back with rests at the ends (figureShuttle),
// walkers stopping now and then (figureStroll), easing up the steep lower slopes. Hard caps: at most
// COUNTRY_PARTIES walking parties of one to three and COUNTRY_CARTS carts; each pixel considers only
// those COUNTRY_AGENTS candidates, skipping any not on the ridge in question or more than one figure
// width away across the screen before the one crest lookup that places its feet. Figures are drawn
// by the shared figures library at their world size (a walker about 1.7 m), so nearby they are a
// few cells tall and far off one faint cell or nothing.
import { figuresGlsl } from "../../shaders/lib/figures.ts";

export const countryRoutesGlsl = /* glsl */ `
${figuresGlsl}

// Both defined further on in shader.ts.
vec2 countryRiver(float v, float start);
vec2 countryLane(float v, float start);

const float COUNTRY_PERSON = 0.012;    // a walker's height, world units: ~1.7 m beside the ~4 m lane
const float COUNTRY_DECK = 0.011;      // the bridge deck's height over the water, world units
const float COUNTRY_JUNCTION = 0.34;   // down-slope v on ridge 1 where the bridge track leaves the west track
const float COUNTRY_STREET = 0.162;    // the street's west end, screen units left of the village
const int COUNTRY_PARTIES = 6;         // walking parties at most, one to three people each
const int COUNTRY_CARTS = 3;           // carts at most
const int COUNTRY_AGENTS = 9;          // parties and carts: every pixel's whole candidate set

// The depth of the ground at drop s below the crest of a ridge at depth d, as sceneCountry has it:
// the face comes toward us below the crest.
float countryFaceDepth(float s, float d) {
  return d * (1.0 - 0.35 * smoothstep(0.0, 0.2, s));
}

// ---- the river ----

// The river's open water against the original stream (1 at K_river 0.5).
float countryRiverScale() {
  return pow(2.0 * K_river, 1.807);
}

// The original stream's open-water half-width (world) at down-slope v: it widens toward us.
float countryRiverBank(float v) {
  return 0.012 + 0.008 * clamp(v / 0.6, 0.0, 1.0);
}

// The outer edge of the reeds for a river \`broad\` times the stream, in world units across.
float countryRiverReeds(float bank, float broad) {
  return bank * 1.7 * pow(broad, 0.8);
}

// Where the river leaves the saddle below the village: world x at ridge 1's crest.
float countryRiverStart(vec2 spots) {
  return (spots.x + 0.07) * countryLayer(1.0).x;
}

// World distance from slope point w on ridge \`ridge\` to the river's open water (negative in it);
// 1e3 off ridge 1 or with the river dried up.
float countryRiverDistance(float ridge, vec2 w, vec2 spots) {
  float broad = countryRiverScale();
  if (abs(ridge - 1.0) > 0.5 || broad <= 0.0 || w.y < 0.0) return 1e3;
  vec2 river = countryRiver(w.y, countryRiverStart(spots));
  return abs(w.x - river.x) / sqrt(1.0 + river.y * river.y) - countryRiverBank(w.y) * broad;
}

// ---- the routes ----

// How plainly a part of the network of this rank shows: 0 until K_tracks passes the rank, then
// fading in, a well-worn track at the top of the range.
float countryTrackShow(float rank) {
  return smoothstep(rank, rank + 0.15, K_tracks) * (0.55 + 0.45 * K_tracks);
}

// Ridge 1, the west track (route 1): the lane's way on, from behind the near field up the river's
// west bank to the saddle below the village; world x at down-slope v. A smooth minimum keeps it
// west of the broadest river's reeds (1.7 pow(3.5, 0.8) < 4.7 stream half-widths), as the
// meanders never carry the river more than 0.15 west of its mean course.
float countryWestTrack(float v, vec2 spots) {
  float d = countryLayer(1.0).x;
  float top = (spots.x - COUNTRY_STREET) * d;
  float foot = (0.6 * spots.x + 0.045) * d;
  float want = mix(top, foot, smoothstep(0.0, 1.2, v)) + 0.02 * sin(v * 5.0 + 0.4);
  float clear = countryRiverStart(spots) + 0.5 * v - 0.18 - 4.7 * countryRiverBank(v);
  float h = clamp(0.5 + 0.5 * (clear - want) / 0.06, 0.0, 1.0);
  return mix(clear, want, h) - 0.06 * h * (1.0 - h);
}

// Ridge 1, the bridge track (route 2): east from the west track's junction x0 along the slope, over
// the river and on down out of sight. Down-slope v at world x (x), and dv/dx (y): within 0.02..0.38,
// too gentle a gradient to meet the winding river (|dx/dv| < 2.33) more than once.
vec2 countryBridgeTrack(float x, float x0) {
  float a = x - x0;
  return vec2(COUNTRY_JUNCTION + 0.2 * a + 0.03 * sin(a * 6.0), 0.2 + 0.18 * cos(a * 6.0));
}

// The bridge: x the junction (world x on ridge 1), y where the bridge track crosses the river
// (Newton on river(track(x)) = x, whose slope stays within -1.9..-0.1), z the bridge's half-span
// along the track, over the reeds to the banks.
vec3 countryBridgeSite(vec2 spots) {
  float start = countryRiverStart(spots);
  float x0 = countryWestTrack(COUNTRY_JUNCTION, spots);
  float x = countryRiver(COUNTRY_JUNCTION + 0.05, start).x;
  vec2 river = vec2(0.0);
  float v = COUNTRY_JUNCTION;
  for (int k = 0; k < 5; k++) {
    vec2 track = countryBridgeTrack(x, x0);
    v = track.x;
    river = countryRiver(v, start);
    x -= (river.x - x) / (river.y * track.y - 1.0);
  }
  float reeds = countryRiverReeds(countryRiverBank(v), max(countryRiverScale(), 0.25));
  return vec3(x0, x, reeds * sqrt(1.0 + river.y * river.y) + 0.006);
}

// Ridge 2, the street (route 4): where the street between the cottages' two rows (countryVillage)
// and the road on along the valley run at screen x (the ridge's frame), as their drop below the
// bare crest \`crest\` there. Through the village it keeps the cottages' line under the knoll; east of
// it, a steady drop below the crest.
float countryStreetDrop(float x, float crest, vec2 spots) {
  float knoll = countryLayer(2.0).y + 0.012;
  float u = (x - spots.x) / 0.12;
  float street = knoll - 0.04 - 0.02 * sin(u * 2.3 + 0.9);
  float road = crest - 0.045 - 0.012 * sin(x * 9.0 + 1.7);
  return crest - mix(street, road, smoothstep(1.1, 2.0, u));
}

// The climbs on ridges 2 and 3, world x at down-slope v: the link from the west track up to the
// street's west end (route 3), the hill track from the valley road over ridge 2 (5), the chalk track
// up the far down, right of the chalk figure (6).
float countryClimbX(float route, float v, vec2 spots) {
  if (route < 3.5) return (spots.x - COUNTRY_STREET) * countryLayer(2.0).x - 0.06 * (v - 0.2) + 0.035 * sin((v - 0.2) * 4.5);
  if (route < 5.5) return (spots.y + 0.12) * countryLayer(2.0).x + 0.02 * sin(v * 6.0);
  return (spots.y + 0.16 - 0.035 * v + 0.006 * sin(v * 9.0)) * countryLayer(3.0).x;
}

// A climb's across distance (world, signed) from w, at ground x per ridge x \`k\`, for a route at
// world x \`x\` with dx/dv \`slope\` over v0..v1; beyond its ends, the distance to the end. axis: the
// across direction (world: across at the ground's depth, down the slope).
float countryAcrossClimb(vec2 w, float x, float slope, float v, float k, out vec2 axis) {
  float n = sqrt(1.0 + slope * slope * k * k);
  axis = vec2(1.0, -slope * k) / n;
  if (v != w.y) return length(vec2((w.x - x) * k, w.y - v));
  return (w.x - x) * k / n;
}

// The nearest route shown on the two near ridges (i 0 or 1; see countryRouteAt), at ground x per
// ridge x \`k\`: the lane, the west track and the bridge track.
vec4 countryRouteNear(float i, vec2 w, float k, vec2 spots, out vec2 axis) {
  axis = vec2(1.0, 0.0);
  if (i < 0.5) {
    // The lane, in ground x (rows) as sceneCountry draws it.
    vec2 lane = countryLane(w.y, spots.x * 0.6);
    float n = sqrt(1.0 + lane.y * lane.y);
    axis = vec2(1.0, -lane.y) / n;
    return vec4((w.x * k - lane.x) / n, COUNTRY_LANE, 1.0, 0.0);
  }
  vec4 best = vec4(1e3, COUNTRY_LANE, 0.0, 0.0);
  vec2 dir = vec2(0.0);
  float show = countryTrackShow(0.0);
  if (show > 0.0) {
    float v = clamp(w.y, -0.2, 1.4);
    float x = countryWestTrack(v, spots);
    float across = countryAcrossClimb(w, x, (countryWestTrack(v + 0.01, spots) - x) / 0.01, v, k, dir);
    if (abs(across) < abs(best.x)) { best = vec4(across, COUNTRY_LANE, show, 0.0); axis = dir; }
  }
  show = countryTrackShow(0.2);
  if (show > 0.0) {
    float x0 = countryWestTrack(COUNTRY_JUNCTION, spots);
    float x = clamp(w.x, x0, x0 + 2.6);
    vec2 track = countryBridgeTrack(x, x0);
    float slope = track.y / k;
    float n = sqrt(1.0 + slope * slope);
    float across = x != w.x ? length(vec2((w.x - x) * k, w.y - track.x)) : (w.y - track.x) / n;
    if (abs(across) < abs(best.x)) { best = vec4(across, COUNTRY_LANE, show, 0.0); axis = vec2(-slope, 1.0) / n; }
  }
  return best;
}

// The nearest route shown on ridge i to slope point w (world x at the ridge's depth, v down the
// slope), lying s below the ridge's bare crest \`crest\` (screen; only ridge 2 reads it) at screen
// x = w.x / depth. x: across distance (world, signed); y: the route's half-width (world); z: how
// plainly it shows (0 with no route here, x then 1e3); w: its surface, 0 farm track, 1 metalled road,
// 2 chalk. axis gets the across direction (world: across at the ground's own depth, down the slope).
vec4 countryRouteAt(float i, vec2 w, float s, float crest, vec2 spots, out vec2 axis) {
  float d = countryLayer(i).x;
  float k = countryFaceDepth(s, d) / d;
  if (i < 1.5) return countryRouteNear(i, w, k, spots, axis);
  axis = vec2(1.0, 0.0);
  vec4 best = vec4(1e3, COUNTRY_LANE, 0.0, 0.0);
  vec2 dir = vec2(0.0);
  float qx = w.x / d;
  if (i < 2.5) {
    // The street and valley road, from its west end on east; its slope from a second crest lookup.
    float xw = spots.x - COUNTRY_STREET;
    float xs = max(qx, xw);
    float show = mix(countryTrackShow(0.0), countryTrackShow(0.2), smoothstep(1.3, 1.8, (xs - spots.x) / 0.12));
    if (show > 0.0) {
      float e = 0.004;
      float c0 = xs == qx ? crest : countryGroundCrest(2.0, xs, spots);
      float v0 = countryDown(countryStreetDrop(xs, c0, spots), d);
      float v1 = countryDown(countryStreetDrop(xs + e, countryGroundCrest(2.0, xs + e, spots), spots), d);
      float slope = (v1 - v0) / (e * d * k);
      float n = sqrt(1.0 + slope * slope);
      float across = xs != qx ? length(vec2((w.x - xs * d) * k, w.y - v0)) : (w.y - v0) / n;
      if (abs(across) < abs(best.x)) { best = vec4(across, 1.15 * COUNTRY_LANE, show, 1.0); axis = vec2(-slope, 1.0) / n; }
      // The link down from the street's west end toward the saddle, out of sight behind ridge 1.
      if (abs(qx - xw) < 0.05) {
        float vw = countryDown(countryStreetDrop(xw, countryGroundCrest(2.0, xw, spots), spots), d);
        float v = clamp(w.y, vw, 1.0);
        float x = countryClimbX(3.0, v, spots);
        across = countryAcrossClimb(w, x, (countryClimbX(3.0, v + 0.01, spots) - x) / 0.01, v, k, dir);
        if (abs(across) < abs(best.x)) { best = vec4(across, COUNTRY_LANE, countryTrackShow(0.0), 0.0); axis = dir; }
      }
    }
    // The hill track, from the valley road up over the crest.
    float xe = spots.y + 0.12;
    show = countryTrackShow(0.4);
    if (show > 0.0 && abs(qx - xe) < 0.05) {
      float ve = countryDown(countryStreetDrop(xe, countryGroundCrest(2.0, xe, spots), spots), d);
      float v = clamp(w.y, -0.2, ve);
      float x = countryClimbX(5.0, v, spots);
      float across = countryAcrossClimb(w, x, (countryClimbX(5.0, v + 0.01, spots) - x) / 0.01, v, k, dir);
      if (abs(across) < abs(best.x)) { best = vec4(across, COUNTRY_LANE, show, 0.0); axis = dir; }
    }
  } else if (i < 3.5) {
    float show = countryTrackShow(0.4);
    if (show > 0.0) {
      float v = clamp(w.y, -0.2, 1.8);
      float x = countryClimbX(6.0, v, spots);
      float across = countryAcrossClimb(w, x, (countryClimbX(6.0, v + 0.01, spots) - x) / 0.01, v, k, dir);
      if (abs(across) < abs(best.x)) { best = vec4(across, 0.85 * COUNTRY_LANE, show, 2.0); axis = dir; }
    }
  }
  return best;
}

// World distance from slope point w (x at the ridge's depth d, v down the slope) on ridge \`ridge\`
// to the nearest centre line of a track shown there (the lane on ridge 0 always, the rest as
// K_tracks brings them in); 1e3 with none. For keeping buildings, animals and fences off the tracks.
float countryRouteDistance(float ridge, vec2 w, vec2 spots) {
  float d = countryLayer(ridge).x;
  vec2 axis = vec2(0.0);
  vec4 route = countryRouteAt(ridge, w, countryDrop(max(w.y, 0.0), d), countryGroundCrest(ridge, w.x / d, spots), spots, axis);
  return route.z > 0.0 ? abs(route.x) : 1e3;
}

// A track's surface (0 farm track, as the lane; 1 metalled road; 2 chalk) at u (0 its centre line,
// 1 its edge); rut 1 in a wheel rut; lp: track space for its grain; cells: its half-width in cells,
// so the grassy crown shows only where the dither holds it.
vec3 countryTrackColor(float surface, float u, float rut, vec2 lp, float cells, float season) {
  float grain = vnoise(lp * 0.8);
  if (surface < 0.5) {
    vec3 track = mix(vec3(0.56, 0.48, 0.36) * (0.88 + 0.24 * grain), vec3(0.42, 0.34, 0.24), rut);
    vec3 sward = season > 1.5 ? vec3(0.36, 0.42, 0.19) : vec3(0.3, 0.47, 0.18);
    return mix(track, sward, (1.0 - smoothstep(0.16, 0.3, u)) * smoothstep(3.0, 6.0, cells));
  }
  if (surface < 1.5) {
    vec3 road = vec3(0.6, 0.57, 0.52) * (0.93 + 0.1 * grain);
    return mix(road, road * 0.84, 0.5 * rut);
  }
  return mix(vec3(0.9, 0.88, 0.8) * (0.94 + 0.08 * grain), vec3(0.76, 0.74, 0.68), 0.6 * rut);
}

// The stone bridge taking the bridge track over the river (ridge 1), seen from downstream: its deck
// COUNTRY_DECK above the water, parapets along both sides, the face toward us with its arches over
// the open water (one for a stream, more across a broad river, each about 5 m), its ends ramping
// down onto the banks. w: the ground point (world); z: the ground's depth; down: world units per
// screen unit down the slope. x: 1 on the bridge; y: 1 on its face, 0 its deck; z: 1 in an arch;
// w: 1 on a parapet.
vec4 countryBridge(vec2 w, float z, float down, vec2 spots) {
  float broad = countryRiverScale();
  if (countryTrackShow(0.2) <= 0.0 || broad <= 0.0) return vec4(0.0);
  vec3 site = countryBridgeSite(spots);
  float a = (w.x - site.y) / site.z;
  if (abs(a) > 1.0) return vec4(0.0);
  vec2 track = countryBridgeTrack(w.x, site.x);
  float deck = 1.15 * COUNTRY_LANE / down;
  float lift = COUNTRY_DECK / z * smoothfall(1.0, 0.65, abs(a));
  // The pixel's ground point's height on screen above the deck's centre line, before the lift.
  float e = (track.x - w.y) / down;
  if (e < -deck || e > lift + deck) return vec4(0.0);
  float face = step(e, lift - deck);
  float b = (e + deck) / max(lift, 1e-5);
  // The water where the face stands, at the deck's near edge.
  float near = track.x + 1.15 * COUNTRY_LANE;
  vec2 river = countryRiver(near, countryRiverStart(spots));
  float open = countryRiverBank(near) * broad * sqrt(1.0 + river.y * river.y);
  float span = (w.x - river.x) / open;
  float arches = max(1.0, floor(2.0 * open / 0.036 + 0.5));
  float within = fract((span + 1.0) * 0.5 * arches) * 2.0 - 1.0;
  float arch = face * step(abs(span), 1.0) * step(length(vec2(within / 0.82, b / 0.78)), 1.0);
  float parapet = face > 0.5 ? step(0.8, b) : step(lift + 0.35 * deck, e);
  return vec4(1.0, face, arch, parapet);
}

// ---- trees give way ----

// Set before each countryTrees lookup (countryClearing): the ridge (-1: nothing to clear), the world
// point of the lookup's field-space origin, and the scene's spots. A hedgerow tree whose root falls
// on a shown track (while K_tracks brings the network in) or in a broadened river gives way.
float countryClearRidge = -1.0;
vec2 countryClearOrigin = vec2(0.0);
vec2 countryClearSpots = vec2(0.0);

void countryClearing(float i, vec2 origin, vec2 spots) {
  countryClearRidge = K_tracks > 0.0 || countryRiverScale() > 1.0 ? i : -1.0;
  countryClearOrigin = origin;
  countryClearSpots = spots;
}

// Whether the tree rooted at field-space point root gives way, f being the lookup's origin there;
// field space is taken as COUNTRY_FIELDS per world unit about it, as countryTrees places crowns.
bool countryTreeCleared(vec2 root, vec2 f) {
  if (countryClearRidge < 0.0) return false;
  vec2 w = countryClearOrigin + (root - f) / COUNTRY_FIELDS;
  if (K_tracks > 0.0) {
    vec2 axis = vec2(0.0);
    float d = countryLayer(countryClearRidge).x;
    vec4 route = countryRouteNear(countryClearRidge, w, countryFaceDepth(countryDrop(max(w.y, 0.0), d), d) / d, countryClearSpots, axis);
    if (route.z > 0.0 && abs(route.x) < route.y + 0.016) return true;
  }
  float broad = countryRiverScale();
  if (broad > 1.0) {
    float bank = countryRiverBank(max(w.y, 0.0));
    return countryRiverDistance(countryClearRidge, w, countryClearSpots) < countryRiverReeds(bank, broad) - bank * broad + 0.006;
  }
  return false;
}

// ---- walkers and carts ----

// The legs walkers and carts keep to, each on one ridge, its ends out of sight (behind a nearer
// ridge, past a crest, beyond the frame) or a place to rest and turn back (a field gate on the
// lane, the village's east end). A leg is one or two route pieces walked in turn, each x the route
// (0 lane, 1 west track, 2 bridge track, 3 link, 4 street and valley road, 5 hill track, 6 chalk
// track; -1 none), y..z its parameter from..to (down-slope v on a climb, going up; world x on the
// bridge track; screen x on the street), w the ridge.
//   leg 0  the lane's far end over the brow: the only one while K_tracks is 0
//   leg 1  the west track
//   leg 2  the bridge track, then on up the west track (rank 0.2)
//   leg 3  the link and the street, to the village's east end, or on along the valley road out of
//          the frame once that shows
//   leg 4  the valley road in from the east, then the hill track over ridge 2 (rank 0.4)
//   leg 5  the chalk track (rank 0.4)
// joins: down-slope v on ridge 2 where the link meets the street (x) and the hill track leaves the
// valley road (y), from countryJoins.
void countryLegPieces(float leg, vec2 spots, vec2 joins, out vec4 a, out vec4 b) {
  b = vec4(-1.0, 0.0, 0.0, -1.0);
  if (leg < 0.5) {
    a = vec4(0.0, 0.2, -0.15, 0.0);
  } else if (leg < 1.5) {
    a = vec4(1.0, 1.3, -0.2, 1.0);
  } else if (leg < 2.5) {
    float x0 = countryWestTrack(COUNTRY_JUNCTION, spots);
    a = vec4(2.0, x0 + 2.6, x0, 1.0);
    b = vec4(1.0, COUNTRY_JUNCTION, -0.2, 1.0);
  } else if (leg < 3.5) {
    float xw = spots.x - COUNTRY_STREET;
    a = vec4(3.0, 1.0, joins.x, 2.0);
    b = vec4(4.0, xw, K_tracks > 0.2 ? spots.y + 1.6 : spots.x + 0.17, 2.0);
  } else if (leg < 4.5) {
    a = vec4(4.0, spots.y + 1.6, spots.y + 0.12, 2.0);
    b = vec4(5.0, joins.y, -0.2, 2.0);
  } else {
    a = vec4(6.0, 1.8, -0.2, 3.0);
  }
}

// Down-slope v on ridge 2 where the link meets the street's west end (x) and where the hill track
// leaves the valley road (y): one crest lookup each.
vec2 countryJoins(vec2 spots) {
  float d = countryLayer(2.0).x;
  float xw = spots.x - COUNTRY_STREET;
  float xe = spots.y + 0.12;
  return vec2(countryDown(countryStreetDrop(xw, countryGroundCrest(2.0, xw, spots), spots), d),
              countryDown(countryStreetDrop(xe, countryGroundCrest(2.0, xe, spots), spots), d));
}

// How long a route piece takes, in world units at the agent's pace: the bridge track and the
// street their length; a climb the sum of 1 + k v / d along it, so going up (k > 0) slows on the
// steep lower slopes and coming down (k < 0) hurries there; 1.15 for a climb's sideways wander.
float countryLegTime(vec4 piece, float k) {
  if (piece.x < 0.0) return 0.0;
  if (abs(piece.x - 2.0) < 0.5) return 1.05 * abs(piece.z - piece.y);
  if (abs(piece.x - 4.0) < 0.5) return 1.05 * countryLayer(2.0).x * abs(piece.z - piece.y);
  float c = k / (2.0 * countryLayer(piece.w).x);
  return 1.15 * abs(piece.z + c * piece.z * piece.z - piece.y - c * piece.y * piece.y);
}

// Down-slope v after share f of the time a climb from v0 to v1 takes (see countryLegTime).
float countryClimb(float v0, float v1, float f, float d, float k) {
  float c = k / (2.0 * d);
  float t = mix(v0 + c * v0 * v0, v1 + c * v1 * v1, f);
  return abs(c) < 1e-4 ? t : (sqrt(max(1.0 + 4.0 * c * t, 0.0)) - 1.0) / (2.0 * c);
}

// One walking party (a < COUNTRY_PARTIES) or cart: whether it is out, the leg it keeps to and its
// ridge, and from its hash its kind, people and pace; countryWayAlong adds where it is now.
struct CountryWay {
  float leg;     // see countryLegPieces
  float ridge;
  float kind;    // 0 a walking party, 1 a horse and cart, 2 a tractor and trailer
  float seed;
  float size;    // people in a party
  float pace;    // world units a second
  float route;   // the piece it is on now (countryLegPieces' x)
  float u;       // where along it
  float dir;     // +1 toward larger u, -1 smaller, 0 standing
  float stride;  // the gait's phase
  float phase;   // where in its round it started, 0..1: a second party on a leg half a round behind
};

bool countryWayOf(int a, out CountryWay way) {
  bool cart = a >= COUNTRY_PARTIES;
  float n = cart ? float(a - COUNTRY_PARTIES) : float(a);
  // One to six parties as K_walkers rises, one to three carts.
  if (n >= (cart ? K_carts : (K_walkers > 0.0 ? 1.0 + floor(K_walkers * 5.99) : 0.0))) return false;
  float h = hash12(vec2(float(a) * 7.31 + 1.7, 3.9) + countrySeed);
  // The legs shown: the lane's alone; with the rank-0 network the west track and the street; then
  // the bridge track; then all six. Parties take them nearest first, two to a leg at most: the west
  // track, the street, the bridge track, the lane, the chalk track, the valley road and hill track;
  // carts the bridge track, the street and the valley road. With the lane alone, two parties and one
  // cart go out.
  float shown = K_tracks <= 0.0 ? 1.0 : (K_tracks <= 0.2 ? 3.0 : (K_tracks <= 0.4 ? 4.0 : 6.0));
  if (shown < 1.5) {
    if (n > (cart ? 0.5 : 1.5)) return false;
    way.leg = 0.0;
  } else if (cart) {
    way.leg = shown < 3.5 ? (n > 0.5 && n < 1.5 ? 1.0 : 3.0) : (n < 0.5 ? 2.0 : (n < 1.5 ? 3.0 : (shown < 4.5 ? 1.0 : 4.0)));
  } else {
    float order = mod(n, shown);
    way.leg = order < 0.5 ? 1.0 : (order < 1.5 ? 3.0 : (order < 2.5 ? (shown < 3.5 ? 0.0 : 2.0) : (order < 3.5 ? 0.0 : (order < 4.5 ? 5.0 : 4.0))));
  }
  way.ridge = way.leg < 0.5 ? 0.0 : (way.leg < 2.5 ? 1.0 : (way.leg < 4.5 ? 2.0 : 3.0));
  way.kind = cart ? (fract(h * 3.3) < 0.5 ? 1.0 : 2.0) : 0.0;
  way.seed = h;
  way.size = cart ? 1.0 : (fract(h * 7.7) < 0.25 + 0.45 * K_walkers ? (fract(h * 11.3) < 0.35 ? 3.0 : 2.0) : 1.0);
  // A walk ~1.7-2.2 m/s, a horse and cart ~2.4, a tractor ~4.2.
  way.pace = cart ? (way.kind < 1.5 ? 0.017 : 0.03) : 0.012 + 0.004 * fract(h * 9.1);
  way.phase = fract(0.37 * h + 0.11 + (cart ? 0.0 : 0.5 * floor(n / shown)));
  return true;
}

// Where along its leg the way is now: out along it and back, over and over (figureShuttle), from
// the motion clock, resting at each end (a field gate, the village's east end, or out of sight);
// half the parties stop now and then on the way to take in the view.
void countryWayAlong(inout CountryWay way, vec2 spots, vec2 joins) {
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  countryLegPieces(way.leg, spots, joins, a, b);
  vec2 up = vec2(countryLegTime(a, 1.1), countryLegTime(b, 1.1));
  vec2 down = vec2(countryLegTime(a, -0.3), countryLegTime(b, -0.3));
  float h = way.seed;
  vec2 walk = vec2(uMotionTime, 1.0);
  if (way.kind < 0.5 && fract(h * 2.9) < 0.5) walk = figureStroll(uMotionTime + 97.0 * h, 55.0 + 50.0 * fract(h * 2.1), 6.0 + 9.0 * fract(h * 4.7));
  // A rest in sight (the lane's field gate, the village's east end) is a pause; out of sight a brief turn.
  float restNear = (way.leg < 0.5 ? (way.kind < 0.5 ? 14.0 : 25.0) : 6.0) * way.pace;
  float restFar = (abs(way.leg - 3.0) < 0.5 && K_tracks <= 0.2 ? 20.0 : 6.0) * way.pace;
  float cycle = up.x + up.y + down.x + down.y + restNear + restFar;
  vec3 trip = figureShuttle(walk.x * way.pace + way.phase * cycle, up.x + up.y, down.x + down.y, restFar, restNear);
  vec4 piece = a;
  vec2 ends = a.yz;
  float f = 0.0;
  float k = 1.1;
  if (trip.y > 0.5) {
    bool second = b.x >= 0.0 && trip.x >= up.x;
    piece = second ? b : a;
    ends = piece.yz;
    f = second ? (trip.x - up.x) / max(up.y, 1e-4) : trip.x / max(up.x, 1e-4);
  } else if (trip.y < -0.5) {
    bool second = b.x >= 0.0 && trip.x < down.y;
    piece = second ? b : a;
    ends = piece.zy;
    f = second ? trip.x / max(down.y, 1e-4) : (trip.x - down.y) / max(down.x, 1e-4);
    k = -0.3;
  } else {
    piece = trip.z > 0.5 && b.x >= 0.0 ? b : a;
    ends = trip.z > 0.5 ? piece.zz : piece.yy;
  }
  f = clamp(f, 0.0, 1.0);
  bool climb = abs(piece.x - 2.0) > 0.5 && abs(piece.x - 4.0) > 0.5;
  way.route = piece.x;
  way.u = climb ? countryClimb(ends.x, ends.y, f, countryLayer(piece.w).x, k) : mix(ends.x, ends.y, f);
  way.dir = abs(trip.y) * walk.y * (ends.y > ends.x ? 1.0 : -1.0);
  way.stride = walk.x * TAU * 0.95 + 6.0 * h;
}

// The frame each ridge in front of the one a pixel shows had there (sceneCountry fills it, ridge by
// ridge): x, y the point in the ridge's frame, z its visible crest, w its bare crest.
vec4 countrySeen[6];

// The walker or cart covering the pixel: standing on the ground it shows (ridge \`hit\`, point q,
// visible crest \`crest\`, bare crest \`terrain\`) unless something stands there (object), or poking
// over the skyline of a nearer ridge (countrySeen). dark: lamps lit after dark. frame, ridge and
// depth get the agent's ridge frame (as countrySeen), ridge and depth. Off the figures, the result
// carries the contact shadow at their feet and, for one too small to draw, its faint colour over
// the ground. Bounded: COUNTRY_AGENTS candidates, each skipped unless it is out, on a ridge this
// pixel can show it on, near that ridge's skyline or below it, and within a figure's width across
// the screen, before the one crest lookup that places its feet; the nearest is drawn, once.
Figure countryAgentAt(int hit, float object, vec2 q, float crest, float terrain, vec2 spots, float dark,
                      out vec4 frame, out float ridge, out float depth) {
  Figure best = figureNone();
  frame = vec4(0.0);
  ridge = -1.0;
  depth = 1e3;
  if (K_walkers <= 0.0 && K_carts <= 0.0) return best;
  float px = 1.0 / uRes.y;
  // Where ridge 2's link and hill track join the street, looked up once, only where they can show.
  vec2 joins = hit >= 2 ? countryJoins(spots) : vec2(0.0);
  CountryWay chosen;
  vec4 place = vec4(0.0, 1e3, 0.0, 0.0);   // feet x, y, height, depth (screen)
  vec3 aim = vec3(0.0);                    // heading (x across the view, y toward us), down rate
  // The bound follows the knobs, so compilers keep one loop body rather than unrolling every candidate.
  int candidates = COUNTRY_PARTIES + int(clamp(K_carts, 0.0, float(COUNTRY_CARTS)));
  for (int a = 0; a < candidates; a++) {
    CountryWay way;
    if (!countryWayOf(a, way)) continue;
    if (way.ridge > float(hit) || (way.ridge > float(hit) - 0.5 && object > 0.5)) continue;
    if (ridge >= 0.0 && way.ridge > ridge) continue;
    vec4 at = way.ridge < float(hit) - 0.5 ? countrySeen[int(way.ridge)] : vec4(q, crest, terrain);
    if (at.y > at.z + 0.06) continue;
    countryWayAlong(way, spots, joins);
    float i = way.ridge;
    float d = countryLayer(i).x;
    // The route point: screen x, down-slope v, and the route's way there (world: ground x, down the slope).
    float v = way.u;
    float x = way.u;
    vec2 tangent = vec2(0.0, 1.0);
    float s = countryDrop(abs(v), d);
    float z = countryFaceDepth(s, d);
    if (way.route < 0.5) {
      vec2 lane = countryLane(v, spots.x * 0.6);
      x = lane.x / z;
      tangent = vec2(lane.y, 1.0);
    } else if (way.route < 1.5) {
      x = countryWestTrack(v, spots) / d;
    } else if (way.route < 2.5) {
      vec2 track = countryBridgeTrack(way.u, countryWestTrack(COUNTRY_JUNCTION, spots));
      v = track.x;
      s = countryDrop(v, d);
      z = countryFaceDepth(s, d);
      x = way.u / d;
      tangent = vec2(z / d, track.y);
    } else if (abs(way.route - 4.0) > 0.5) {
      x = countryClimbX(way.route, v, spots) / d;
    }
    bool walker = way.kind < 0.5;
    float tall = walker ? COUNTRY_PERSON : (way.kind < 1.5 ? 0.017 : 0.02);
    float reach = (walker ? 0.5 * tall + 0.012 : 0.034) / (0.65 * d) + px;
    if (abs(at.x - x) > reach) continue;
    if (abs(way.route - 1.0) < 0.5) tangent = vec2((countryWestTrack(v + 0.01, spots) / d - x) / 0.01 * z, 1.0);
    if (way.route > 4.5 || abs(way.route - 3.0) < 0.5) tangent = vec2((countryClimbX(way.route, v + 0.01, spots) / d - x) / 0.01 * z, 1.0);
    float ground = countryGroundCrest(i, x, spots);
    if (abs(way.route - 4.0) < 0.5) {
      // The street: its drop comes from the crest; its way from a second lookup a little on.
      s = countryStreetDrop(x, ground, spots);
      v = countryDown(s, d);
      z = countryFaceDepth(s, d);
      float on = countryDown(countryStreetDrop(x + 0.004, countryGroundCrest(i, x + 0.004, spots), spots), d);
      tangent = vec2(0.004 * z, on - v);
    }
    // Past the crest it sinks out of sight behind it: only what stands over the skyline shows.
    if (v < 0.0 && at.y < at.z) continue;
    float h = tall / z;
    float down = countryDownRate(max(s, 0.0), d);
    float foot = ground - s;
    if (abs(way.route - 2.0) < 0.5 && countryRiverScale() > 0.0) {
      vec3 site = countryBridgeSite(spots);
      foot += COUNTRY_DECK / z * smoothfall(1.0, 0.65, abs(way.u - site.y) / site.z);
    }
    // A party's box: its people side by side and one behind, 0.009 back along the way.
    float spread = walker ? 0.01 / z + 0.01 / down : 0.0;
    if (abs(at.x - x) > (walker ? 0.45 * h : 0.5 * (0.05 + 0.014) / z) + spread + px) continue;
    if (at.y < foot - 0.15 * h - spread - px || at.y > foot + 1.1 * h + spread + px) continue;
    if (ridge >= 0.0 && i > ridge - 0.5 && foot >= place.y) continue;
    // In a wood it walks under the trees.
    if (i > 1.5 && countryWoodStand(i, x * d, max(v, 0.0), countrySpots(x, spots)) > 0.53) continue;
    chosen = way;
    ridge = i;
    frame = at;
    place = vec4(x, foot, h, z);
    aim = vec3(normalize(tangent) * (way.dir == 0.0 ? 1.0 : sign(way.dir)), down);
  }
  if (ridge < 0.0) return best;
  depth = place.w;
  vec2 p = frame.xy - place.xy;
  float lamp = step(0.45, dark) * (chosen.kind > 0.5 || fract(chosen.seed * 6.1) < 0.4 ? 1.0 : 0.0);
  if (chosen.kind > 0.5) {
    best = figureCart(p, aim.xy, (chosen.kind < 1.5 ? 0.042 : 0.05) / place.w, 0.014 / place.w, place.z, uRes.y, chosen.kind - 1.0, chosen.seed, lamp);
  } else {
    // Two walk side by side; a third follows.
    vec2 across = vec2(-aim.y, aim.x);
    float nearest = 1e3;
    int people = int(chosen.size);
    for (int m = 0; m < people; m++) {
      vec2 offset = chosen.size < 1.5 ? vec2(0.0) : (m == 2 ? -0.009 * aim.xy : (m == 0 ? -0.0035 : 0.0035) * across);
      vec2 feet = vec2(offset.x / place.w, -offset.y / aim.z);
      float seed = fract(chosen.seed * 13.1 + float(m) * 0.37);
      Figure f = figureWalker(p - feet, place.z * (0.9 + 0.12 * fract(seed * 5.3)), uRes.y, aim.x, chosen.stride + 1.9 * float(m), abs(chosen.dir), seed, m == 0 ? lamp : 0.0);
      if (f.cover > 0.5 && feet.y < nearest) {
        nearest = feet.y;
        best = f;
      } else if (best.cover < 0.5) {
        best.shadow = max(best.shadow, f.shadow);
        if (f.faint > best.faint) {
          best.faint = f.faint;
          best.albedo = f.albedo;
        }
      }
    }
  }
  // Shadows and specks belong on the ground the pixel shows, not over a nearer skyline.
  if (best.cover < 0.5 && ridge < float(hit) - 0.5) best = figureNone();
  return best;
}
`;
