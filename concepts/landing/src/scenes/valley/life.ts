// The valley's life, each part compiled in only while its knobs are on (valleyFeatures):
//
// Herds (VALLEY_HAS_HERDS; the shared livestock, shaders/lib/livestock.ts). A pasture field (the
// fields' mix, fieldMix) keeps a herd in its clear core (terrainCore: the widest disc of the field
// clear of its border, water, roads, streams, yards and lone trees, sims/terrain.ts). The herd's
// centre wanders and its animals stray only as far as leaves every one inside the core less the
// fence's set and a body's reach, so no animal ever leaves its field; the shared schedule walks each
// between anchors there. A post-and-rail fence stands VALLEY_FENCE_SET inside each pasture's border.
//
// Walkers and carts (VALLEY_HAS_AGENTS; the shared figures, shaders/lib/figures.ts) keep to the
// roads: each takes a road of the network (terrainWays, resampled evenly) and goes out along it and
// back by arc length on the motion clock (figureShuttle; half the walkers stopping now and then,
// figureStroll), always between two of its points, so always on it.
//
// Birds (VALLEY_HAS_BIRDS; shaders/lib/birds.ts) cross the sky by day through the valley's own
// level pinhole camera, hidden by whatever stands nearer along the ray.
export const valleyLifeGlsl = /* glsl */ `
#if VALLEY_HAS_HERDS
const float VALLEY_FENCE_HIGH = 1.7;     // post-and-rail fence height, metres (drawn large, as the houses are)
const float VALLEY_FENCE_SET = 2.5;      // a pasture's fence line inside its border, metres
const float VALLEY_FENCE_SPAN = 3.2;     // between posts, metres
const vec2 VALLEY_BEAST = vec2(1.7, 1.15); // body half-length of a cow and of a sheep, metres (drawn large)
const int VALLEY_HERD_MAX = 14;

struct ValleyHerd {
  float count;    // animals, 0 for none
  float cattle;   // 1 cattle, 0 sheep
  float breed;
  float size;     // body half-length, metres
  float spacing;  // between neighbours, metres
  float roam;     // how far its centre wanders from the core's, metres
  float seed;
  float huddle;   // 1 spread out .. 0.55 bunched up in rain and snow
  float span;     // seconds a schedule slot
  vec2 middle;    // the core's centre
};

// The herd of pasture field id with clear core (centre xy, radius z): as many as fit the core less
// the fence's set and a body's reach, its centre wandering no farther than keeps every one in.
ValleyHerd valleyHerd(float id, vec3 core) {
  ValleyHerd herd;
  herd.seed = hash12(vec2(id * 0.137, 4.13));
  herd.cattle = hash12(vec2(id, 9.71)) < K_cows ? 1.0 : 0.0;
  herd.breed = hash12(vec2(id, 2.39));
  herd.size = herd.cattle > 0.5 ? VALLEY_BEAST.x : VALLEY_BEAST.y;
  herd.spacing = 3.2 * herd.size;
  herd.huddle = clamp(1.0 - 0.3 * uWeather.x - 0.25 * uWeather.y, 0.55, 1.0);
  herd.span = herd.cattle > 0.5 ? 11.0 : 8.0;
  herd.middle = core.xy;
  float room = core.z - VALLEY_FENCE_SET - 1.6 * herd.size;
  float want = floor(K_herd * (herd.cattle > 0.5 ? 10.0 : 14.0) * (0.65 + 0.7 * hash12(vec2(id, 7.37))) + 0.5);
  herd.count = room > 0.0 ? min(min(want, livestockFit(room / herd.spacing)), float(VALLEY_HERD_MAX)) : 0.0;
  // The drift reaches sqrt(2) of the roam at a corner.
  herd.roam = max(room - livestockReach(herd.count) * herd.spacing, 0.0) * 0.7071;
  return herd;
}

// Where animal k stands at the start of its slot n, which begins at clock time t (metres, map):
// its place round the herd's centre then, plus its stray. Never farther from the core's centre
// than the core less the fence's set and a body's reach.
vec2 valleyHerdAnchor(ValleyHerd herd, float k, float n, float t) {
  vec2 offset = livestockPlace(k, herd.seed) * herd.huddle + livestockStray(k, n, herd.seed);
  return herd.middle + herd.roam * livestockDrift(herd.seed, t) + offset * herd.spacing;
}

// Animal k of the herd at motion time tm: where it stands (map metres), its slot, what it is doing
// and its way from this slot's anchor to the next.
vec2 valleyHerdAnimal(ValleyHerd herd, float k, float tm, out LivestockSlot slot, out float act, out vec2 way) {
  slot = livestockSlot(tm, herd.span, hash12(vec2(k * 3.1, herd.seed * 77.0)));
  vec2 a0 = valleyHerdAnchor(herd, k, slot.n, slot.start);
  vec2 a1 = valleyHerdAnchor(herd, k, slot.n + 1.0, slot.start + herd.span);
  // The slot's mood comes from the hour it began, so a turning day never flips it halfway.
  vec2 mood = livestockMood(timeOfDayM(K_time, K_cycle, slot.start), K_clouds, K_rain, K_snow);
  act = livestockAct(mood, hash12(vec2(slot.n * 0.71 + k * 13.3, herd.seed * 41.0 + 3.0)));
  way = a1 - a0;
  return mix(a0, a1, livestockPace(act, slot.u));
}

struct ValleyStock {
  float cover;    // 0..1: an animal over the ground
  vec3 albedo;
  vec3 n;         // world
  float snow;     // how much of it faces up to hold snow
  float porous;
  float shadow;   // 0..1 darkening of the ground at the animals' feet
  float z;        // its camera depth
};

// The animal of field id's herd (core: its clear core) covering pinhole point q nearer than the
// ground the pixel shows (camera depth zGround), and the shadows at the herd's feet.
ValleyStock valleyHerdAt(vec3 eye, vec2 q, float cellAngle, float zGround, float id, vec3 core) {
  ValleyStock st;
  st.cover = 0.0;
  st.albedo = vec3(0.0);
  st.n = vec3(0.0, 1.0, 0.0);
  st.snow = 0.0;
  st.porous = 0.5;
  st.shadow = 0.0;
  st.z = zGround;
  ValleyHerd herd = valleyHerd(id, core);
  if (herd.count < 0.5) return st;
  // In a wood the herd is lost among the trees: none.
  vec4 at0 = terrainCover(uSim1, core.xy, VALLEY_EXTENT);
  if (valleyWoods(at0, -1.0, false) > 0.0) return st;
  float tm = uMotionTime;
  // The herd's count bounds the loop (at most VALLEY_HERD_MAX), so it is never unrolled.
  int count = int(herd.count);
  for (int j = 0; j < count; j++) {
    float k = float(j);
    LivestockSlot slot;
    float act;
    vec2 way;
    vec2 at = valleyHerdAnimal(herd, k, tm, slot, act, way);
    vec3 feet = vec3(at.x, terrainSurface(terrainGround(uSim0, at, VALLEY_EXTENT)), at.y);
    vec3 d = feet - eye;
    float zc = dot(d, valleyFwd);
    if (zc < 5.0) continue;
    vec2 p = (q - vec2(dot(d, valleyRight), d.y) / zc) * zc / herd.size;
    if (abs(p.x) > 1.6 || p.y > 1.6 || p.y < -0.4) continue;
    float cells = herd.size / (zc * cellAngle);
    if (cells < 0.6) continue;
    LivestockBeast beast = LivestockBeast(herd.cattle, herd.breed, hash12(vec2(k * 5.3 + 0.7, herd.seed * 19.0)));
    vec2 travel = vec2(dot(way, valleyRight.xz), dot(way, valleyFwd.xz)) / herd.size;
    LivestockPose pose = livestockPose(beast, act, slot, travel, K_rain, tm);
    bool speck = cells < 2.2;
    float aa = 0.5 / cells;
    st.shadow = max(st.shadow, 0.42 * livestockShadow(p, pose) * (speck ? 0.5 : 1.0));
    if (zc >= min(zGround, st.z)) continue;
    vec3 albedo = vec3(0.0);
    vec3 normal = normalize(vec3(0.0, 0.85, -0.5));
    float top = 0.4;
    float cover = 0.0;
    if (speck) {
      vec4 mean = livestockSpeck(p, beast, pose, aa);
      albedo = mean.rgb;
      cover = mean.a;
    } else {
      // Soft-edged a cell wide: the animals stand still most of the time and walk slowly.
      cover = softFill(livestockBody(p, beast, pose, aa, albedo, normal, top), aa);
    }
    if (cover > 0.0) {
      st.cover = cover;
      st.albedo = albedo;
      st.n = normalize(valleyToWorld(normal));
      st.snow = top;
      st.porous = herd.cattle > 0.5 ? 0.35 : 0.6;
      st.z = zc;
    }
  }
  return st;
}

// The post-and-rail fence a pasture keeps VALLEY_FENCE_SET inside its border, where the ray (eye,
// rd) crosses it in front of the ground it met at tHit (point p, ground g there, its field parcel;
// here, there: whether p's field and the one across its border are pastures). Rails and posts keep
// at least half a cell; a gap where a road passes. rgb its timber, a its cover; zFence its depth.
vec4 valleyFence(vec3 eye, vec3 rd, float tHit, vec3 p, vec4 g, TerrainParcel parcel, bool here, bool there, float cellAngle, out float zFence) {
  zFence = 1e9;
  vec4 best = vec4(0.0);
  float across = dot(rd.xz, parcel.normal);
  // The ray came over the border toward p only if it runs against the way across.
  if (across > -1e-3) return best;
  for (int side = 0; side < 2; side++) {
    if (side == 0 ? !here : !there) continue;
    float to = side == 0 ? parcel.border - VALLEY_FENCE_SET : parcel.border + VALLEY_FENCE_SET;
    if (to <= 0.0) continue;
    float t = tHit + to / across;
    vec3 x = eye + rd * t;
    float rise = x.y - (terrainSurface(g) + dot(g.zw, x.xz - p.xz));
    float cell = t * cellAngle;
    if (rise < -0.5 * cell || rise > VALLEY_FENCE_HIGH + 0.5 * cell || t >= zFence) continue;
    float run = dot(x.xz, vec2(-parcel.normal.y, parcel.normal.x)) / VALLEY_FENCE_SPAN;
    float which = floor(run + 0.5);
    float post = step(abs(run - which) * VALLEY_FENCE_SPAN, max(0.11, 0.5 * cell));
    float rails = max(step(abs(rise - 0.48 * VALLEY_FENCE_HIGH), max(0.07, 0.5 * cell)), step(abs(rise - 0.9 * VALLEY_FENCE_HIGH), max(0.07, 0.5 * cell)));
    float cover = max(post * step(rise, VALLEY_FENCE_HIGH + 0.5 * cell), rails);
    if (cover < 0.5 || terrainCover(uSim1, x.xz, VALLEY_EXTENT).x < 2.0) continue;
    zFence = t;
    vec3 timber = mix(vec3(0.42, 0.35, 0.27), vec3(0.6, 0.53, 0.42), rails) * (0.88 + 0.24 * hash12(vec2(which, parcel.id)));
    best = vec4(timber, 1.0);
  }
  if (zFence < 1e8) zFence *= dot(rd, valleyFwd);
  return best;
}
#endif

#if VALLEY_HAS_AGENTS
const int VALLEY_PARTIES = 6;          // walking parties at most
const int VALLEY_CARTS = 3;            // carts at most
const float VALLEY_PERSON = 2.4;       // a walker's height as drawn, metres (drawn large, as the houses are)

struct ValleyAgent {
  vec3 at;        // its feet (a cart: the middle of its footprint), map metres
  vec2 heading;   // its way on the map
  float moving;   // 0 resting .. 1 on the move
  float stride;   // a walker's gait phase
  float seed;
  float kind;     // 0 walkers, 1 a horse and cart, 2 a tractor and trailer
  float size;     // walkers in the party
};

// Agent a (the walking parties, then the carts) at motion time tm: false while it is not out.
bool valleyAgent(int a, float tm, out ValleyAgent agent) {
  bool cart = a >= VALLEY_PARTIES;
  float n = cart ? float(a - VALLEY_PARTIES) : float(a);
  // One to six parties as K_walkers rises, one to three carts.
  if (n >= (cart ? K_carts : (K_walkers > 0.0 ? 1.0 + floor(K_walkers * 5.99) : 0.0))) return false;
  int ways = terrainWayCount(uSim3);
  if (ways < 1) return false;
  float h = hash12(vec2(float(a) * 7.31 + 1.7, 3.9));
  TerrainWay way = terrainWay(uSim3, min(int(fract(h * 5.13) * float(ways)), ways - 1));
  float span = way.spacing * float(way.count - 1);
  agent.seed = h;
  agent.kind = cart ? (fract(h * 3.3) < 0.55 ? 1.0 : 2.0) : 0.0;
  agent.size = cart ? 1.0 : (fract(h * 7.7) < 0.25 + 0.45 * K_walkers ? (fract(h * 11.3) < 0.35 ? 3.0 : 2.0) : 1.0);
  // A walk ~1.4-1.7 m/s, a horse and cart ~1.9, a tractor ~4; ten seconds' turn at either end.
  float pace = cart ? (agent.kind < 1.5 ? 1.9 : 4.0) : 1.4 + 0.3 * fract(h * 9.1);
  vec2 walk = vec2(tm, 1.0);
  if (!cart && fract(h * 2.9) < 0.5) walk = figureStroll(tm + 97.0 * h, 55.0 + 50.0 * fract(h * 2.1), 6.0 + 9.0 * fract(h * 4.7));
  float rest = 10.0 * pace;
  vec3 trip = figureShuttle(walk.x * pace + fract(h * 3.7) * 2.0 * (span + rest), span, span, rest, rest);
  float s = trip.y > 0.5 ? trip.x : (trip.y < -0.5 ? span - trip.x : trip.z * span);
  agent.at = terrainWayAt(uSim3, way, s, agent.heading);
  if (trip.y < -0.5) agent.heading = -agent.heading;
  agent.moving = abs(trip.y) * walk.y;
  agent.stride = walk.x * TAU * 0.95 + 6.0 * h;
  return true;
}

// The walker or cart covering pinhole point q nearer than camera depth zLimit (the pixel's first
// surface); z gets its depth. Off the figures, the result carries the contact shadow at their feet
// and, for one too small to draw, its faint colour.
Figure valleyAgentAt(vec3 eye, vec2 q, float cellAngle, float zLimit, float dark, out float z) {
  Figure best = figureNone();
  z = zLimit;
  float cells = 1.0 / cellAngle;
  // The bound follows the knob, so compilers keep one loop body rather than unrolling every candidate.
  int candidates = VALLEY_PARTIES + int(clamp(K_carts, 0.0, float(VALLEY_CARTS)));
  for (int a = 0; a < candidates; a++) {
    ValleyAgent agent;
    if (!valleyAgent(a, uMotionTime, agent)) continue;
    vec3 d = agent.at - eye;
    float zc = dot(d, valleyFwd);
    if (zc < 8.0 || zc >= z) continue;
    vec2 feet = vec2(dot(d, valleyRight), d.y) / zc;
    bool walker = agent.kind < 0.5;
    float tall = (walker ? VALLEY_PERSON : (agent.kind < 1.5 ? 3.0 : 3.4)) / zc;
    float reach = (walker ? 3.0 : 5.0) / zc + cellAngle;
    if (abs(q.x - feet.x) > reach || q.y < feet.y - reach || q.y > feet.y + tall + reach) continue;
    vec3 head = vec3(agent.heading.x, 0.0, agent.heading.y);
    float side = dot(head, valleyRight);
    float lamp = step(0.45, dark) * (!walker || fract(agent.seed * 6.1) < 0.4 ? 1.0 : 0.0);
    Figure f;
    if (!walker) {
      vec2 aim = normalize(vec2(side, -dot(head, valleyFwd)) + 1e-5);
      f = figureCart(q - feet, aim, (agent.kind < 1.5 ? 6.5 : 7.5) / zc, 2.6 / zc, tall, cells, agent.kind - 1.0, agent.seed, lamp);
    } else {
      // Two walk side by side; a third follows.
      f = figureNone();
      vec3 across = vec3(-head.z, 0.0, head.x);
      float nearest = 1e9;
      int people = int(agent.size);
      for (int m = 0; m < people; m++) {
        vec3 off = agent.size < 1.5 ? vec3(0.0) : (m == 2 ? -1.4 * head : (m == 0 ? -0.55 : 0.55) * across);
        vec3 dm = d + off;
        float zm = dot(dm, valleyFwd);
        vec2 feetM = vec2(dot(dm, valleyRight), dm.y) / zm;
        float seed = fract(agent.seed * 13.1 + float(m) * 0.37);
        Figure one = figureWalker(q - feetM, VALLEY_PERSON * (0.9 + 0.12 * fract(seed * 5.3)) / zm, cells, side, agent.stride + 1.9 * float(m), agent.moving, seed, m == 0 ? lamp : 0.0);
        if (one.cover > 0.5 && zm < nearest) {
          nearest = zm;
          f = one;
        } else if (f.cover < 0.5) {
          f.shadow = max(f.shadow, one.shadow);
          if (one.faint > f.faint) {
            f.faint = one.faint;
            f.albedo = one.albedo;
          }
        }
      }
    }
    if (f.cover > 0.5) {
      best = f;
      best.normal = normalize(valleyToWorld(f.normal));
      z = zc;
    } else if (best.cover < 0.5) {
      best.shadow = max(best.shadow, f.shadow);
      if (f.faint > best.faint) {
        best.faint = f.faint;
        best.albedo = f.albedo;
      }
    }
  }
  return best;
}
#endif

#if VALLEY_HAS_BIRDS
// The shared birds over the valley through its level pinhole camera (metres), by day and in calm
// weather: mixed, mostly rooks, with gulls up from the river, swallows low and a buzzard on a
// thermal. uv: the frame's point (the passage's lens shift included).
BirdHit valleyBirds(vec2 uv, float aspect, vec3 eye, float rain, float snow, float pxl) {
  float calm = (1.0 - smoothstep(0.05, 0.3, rain)) * (1.0 - 0.6 * snow);
  BirdSky sky = birdSky(K_birds * calm, K_birdKind, K_birdFormation - 1.0, vec2(90.0, 2400.0), vec2(VALLEY_HORIZON + 0.03, 0.93), vec2(13.7, 3.1));
  sky.hours = vec4(0.22, 0.26, 0.8, 0.84);
  sky.clock = vec2(K_time, K_cycle);
  sky.mixA = vec4(4.0, 2.0, 2.0, 1.0);
  sky.mixB = vec3(1.0, 1.0, 0.5);
  sky.swoopTo = eye.y - 25.0;
  BirdCamera cam = BirdCamera(VALLEY_HORIZON, VALLEY_FOCAL, eye.y, 1.0, 3.0);
  return birdFlights(vec2((uv.x - 0.5) * aspect, uv.y), sky, cam, uMotionTime, pxl);
}
#endif
`;
