// Shared people and vehicles for scenes that place small figures in their world: a walker with
// striding legs and coloured clothes, a horse and cart or a tractor and trailer seen from the side
// or an end, and the clocks that move them (a walk with rests, a shuttle out and back with pauses at
// both ends), all analytic in the motion clock so they stand still with the motion.
//
// Not in `libs` (so other scenes' programs are unchanged): a scene that uses it concatenates
// `figuresGlsl` into its own GLSL (country does, in scenes/country/routes.ts). Figures are drawn in
// the caller's screen units (uv heights, y up) around a point the caller projects from its world:
// the feet of a walker, the middle of a vehicle's footprint. `cells` is dither cells per screen unit
// (uRes.y). Shapes are cut per cell (no soft edges to crawl as they move) and keep at least a cell
// across, so a figure a few cells tall still reads; below about 1.6 cells a figure is one faint cell
// (`faint`) for the caller to lay over its ground, and a scene fades it out with distance.
export const figuresGlsl = /* glsl */ `
// ---- figures ----

struct Figure {
  float cover;   // 1 where the figure covers the point, 0 elsewhere
  vec3 albedo;
  vec3 normal;   // x right, y up, z into the scene (a face toward the viewer has z < 0)
  float lamp;    // 1 on a lit lantern or lamp
  float top;     // 1 on an upward face, where snow can lie
  float shadow;  // contact shadow on the ground around its feet (0..1), where it does not cover
  float faint;   // a figure under ~1.6 cells: how much of its albedo to lay over the ground here
};

Figure figureNone() {
  Figure f;
  f.cover = 0.0;
  f.albedo = vec3(0.0);
  f.normal = vec3(0.0, 0.0, -1.0);
  f.lamp = 0.0;
  f.top = 0.0;
  f.shadow = 0.0;
  f.faint = 0.0;
  return f;
}

// A figure too small to draw: the one cell around its middle \`mid\` (relative to p's origin), its
// albedo laid over the ground by how many cells tall it would stand (fading out below a cell).
Figure figureSpeck(vec2 p, vec2 mid, float px, float tallCells, vec3 albedo) {
  Figure f = figureNone();
  vec2 o = abs(p - mid);
  if (o.x <= 0.5 * px && o.y <= 0.5 * px) {
    f.faint = smoothstep(0.35, 1.6, tallCells);
    f.albedo = albedo;
  }
  return f;
}

// A coat, trousers and a head (skin or hat) for a walker's seed 0..1.
vec3 figureCoat(float seed) {
  float c = fract(seed * 7.13);
  if (c < 0.18) return vec3(0.74, 0.17, 0.13);
  if (c < 0.34) return vec3(0.17, 0.3, 0.62);
  if (c < 0.48) return vec3(0.9, 0.73, 0.2);
  if (c < 0.6) return vec3(0.22, 0.42, 0.24);
  if (c < 0.72) return vec3(0.88, 0.87, 0.82);
  if (c < 0.86) return vec3(0.88, 0.45, 0.14);
  return vec3(0.46, 0.27, 0.56);
}
vec3 figureLegs(float seed) {
  float c = fract(seed * 13.7);
  return c < 0.4 ? vec3(0.14, 0.15, 0.22) : (c < 0.65 ? vec3(0.22, 0.27, 0.42) : (c < 0.85 ? vec3(0.33, 0.25, 0.17) : vec3(0.6, 0.54, 0.42)));
}
vec3 figureHead(float seed) {
  float hat = fract(seed * 41.1);
  if (hat < 0.2) return vec3(0.16, 0.15, 0.15);
  if (hat < 0.32) return vec3(0.7, 0.16, 0.14);
  float skin = fract(seed * 29.3);
  return skin < 0.6 ? vec3(0.86, 0.66, 0.52) : (skin < 0.85 ? vec3(0.66, 0.47, 0.34) : vec3(0.42, 0.29, 0.2));
}

// A person, feet at p's origin, standing h tall. side: how much of the way runs across the view,
// signed (+1 walking toward screen right, 0 straight toward or away); stride: the gait's phase
// (radians; one cycle is two steps); moving: 0 standing .. 1 walking; seed 0..1: clothes and build;
// lantern: 1 to carry a lit lantern. The legs scissor as it walks, widest seen side-on.
Figure figureWalker(vec2 p, float h, float cells, float side, float stride, float moving, float seed, float lantern) {
  float px = 1.0 / cells;
  if (abs(p.x) > 0.45 * h + 1.5 * px || p.y < -0.1 * h - px || p.y > h + px) return figureNone();
  float tall = h * cells;
  vec3 coat = figureCoat(seed);
  if (tall < 1.6) return figureSpeck(p, vec2(0.0, 0.55 * h), px, tall, coat);
  Figure f = figureNone();
  vec2 q = p / h;
  float cell = px / h;                         // a cell, in heights
  float build = 0.9 + 0.2 * fract(seed * 3.7);
  float swing = moving * sin(stride) * (0.04 + 0.12 * abs(side));
  float facing = side < 0.0 ? -1.0 : 1.0;
  // Parts keep at least a cell across, so a small figure is a column of coloured cells.
  float leg = max(0.04, 0.3 * cell);
  float lean = 0.03 * moving * side;
  vec2 hip = vec2(lean, 0.47);
  float legs = min(segmentDistance(q, hip + vec2(0.035, 0.0), vec2(0.035 + swing, 0.0)),
                   segmentDistance(q, hip - vec2(0.035, 0.0), vec2(-0.035 - swing, 0.0)));
  vec2 headAt = vec2(1.6 * lean, 0.885);
  float headR = max(0.09, 0.55 * cell);
  float body = max(0.12 * build, 0.5 * cell);
  float x = q.x - lean - 0.5 * lean * (q.y - 0.47) / 0.33;
  if (lantern > 0.5 && abs(p.x - facing * 0.2 * h) <= 0.5 * px && abs(p.y - 0.42 * h) <= 0.5 * px) {
    f.cover = 1.0;
    f.lamp = 1.0;
    f.albedo = vec3(1.0, 0.7, 0.3);
  } else if (length(q - headAt) < headR) {
    f.cover = 1.0;
    f.albedo = figureHead(seed);
    f.normal = normalize(vec3((q - headAt) / headR * 0.8, -1.0));
  } else if (abs(x) < body && q.y > 0.45 && q.y < 0.81) {
    f.cover = 1.0;
    f.albedo = coat;
    f.normal = normalize(vec3(clamp(x / body, -1.0, 1.0) * 0.8, 0.15, -1.0));
  } else if (legs < leg && q.y < 0.5) {
    f.cover = 1.0;
    f.albedo = figureLegs(seed);
    f.normal = normalize(vec3(clamp(q.x / 0.1, -1.0, 1.0) * 0.6, 0.0, -1.0));
  } else if (tall > 3.0 && length(vec2(q.x / 0.3, q.y / 0.07)) < 1.0) {
    f.shadow = 0.45;
  }
  return f;
}

// Whether q lies in the box lo..hi, and in the ellipse (circle on screen) at c with radius r, for
// vehicle parts in their own frame: x along (sx screen units each), y up (sy each).
bool figureIn(vec2 q, vec2 lo, vec2 hi) {
  return q.x >= lo.x && q.x <= hi.x && q.y >= lo.y && q.y <= hi.y;
}
bool figureRound(vec2 q, vec2 c, float r, vec2 s) {
  vec2 d = (q - c) * s;
  return dot(d, d) < r * r * s.y * s.y;
}

// A horse and cart (kind 0) or a tractor and trailer (kind 1), the middle of its footprint at p's
// origin. heading: its way on screen as a unit vector, x across the view (+ toward screen right),
// y toward the viewer (+) or away (-); len, wid, tall: its length, width and height on screen as if
// seen side-on at that distance; seed 0..1: colours and load; lamps: 1 with its lamps lit. Seen
// mostly side-on it shows its whole length, otherwise its back (going away) or its front.
Figure figureCart(vec2 p, vec2 heading, float len, float wid, float tall, float cells, float kind, float seed, float lamps) {
  float px = 1.0 / cells;
  float across = abs(heading.x);
  float span = len * across + wid * abs(heading.y);
  if (abs(p.x) > 0.5 * span + px || p.y < -0.12 * tall - px || p.y > tall + px) return figureNone();
  float high = tall * cells;
  float load = fract(seed * 5.31);
  vec3 wood = vec3(0.5, 0.36, 0.22);
  vec3 stuff = load < 0.45 ? vec3(0.88, 0.74, 0.36) : (load < 0.7 ? vec3(0.76, 0.66, 0.5) : (load < 0.85 ? vec3(0.62, 0.64, 0.66) : wood * 0.8));
  float tint = fract(seed * 17.9);
  vec3 beast = tint < 0.45 ? vec3(0.42, 0.25, 0.13) : (tint < 0.85 ? vec3(0.24, 0.16, 0.1) : vec3(0.7, 0.68, 0.64));
  vec3 paint = tint < 0.45 ? vec3(0.72, 0.14, 0.1) : (tint < 0.8 ? vec3(0.22, 0.45, 0.2) : vec3(0.18, 0.32, 0.62));
  vec3 lead = kind < 0.5 ? beast : paint;
  if (high < 1.6) return figureSpeck(p, vec2(0.0, 0.5 * tall), px, high, kind < 0.5 ? stuff : paint);
  Figure f = figureNone();
  // Own frame: x -1..1 across the silhouette (the front at +1 when side-on), y 0..1 up; parts keep
  // at least about a cell (cx, cy: a cell in these units).
  vec2 s = vec2(0.5 * span, tall);
  vec2 cellq = px / s;
  float front = heading.x < 0.0 ? -1.0 : 1.0;
  vec2 q = vec2(p.x / s.x, p.y / s.y);
  vec3 tyre = vec3(0.07, 0.07, 0.08);
  vec3 side = normalize(vec3(0.0, 0.2, -1.0));
  vec3 up = normalize(vec3(0.0, 1.0, -0.3));
  vec3 col = vec3(0.0);
  vec3 n = side;
  float hitp = 0.0;
  float lamp = 0.0;
  float topf = 0.0;
  if (across >= 0.42) {
    vec2 g = vec2(q.x * front, q.y);
    if (kind < 0.5) {
      // Horse and cart: the cart behind, its near wheel over the box, its load heaped up; the horse
      // in the shafts, a rounded body on four legs, its neck and head up in front.
      float neck = segmentDistance(g * s, vec2(0.8, 0.6) * s, vec2(0.93, 0.9) * s);
      float thin = max(0.04, 0.5 * cellq.x);
      bool legs = g.y < 0.46 && g.y >= 0.0 && (abs(g.x - 0.53) < thin || abs(g.x - 0.81) < thin);
      vec2 body = (g - vec2(0.67, 0.57)) / vec2(0.22, max(0.17, cellq.y));
      vec2 head = (g - vec2(0.95, 0.86)) / vec2(max(0.07, cellq.x), max(0.08, 0.5 * cellq.y));
      float heap = 0.62 + 0.3 * (1.0 - pow(abs(g.x + 0.33) / 0.64, 2.0));
      if (lamps > 0.5 && length((g - vec2(0.36, 0.72)) * s) < 0.6 * px) { lamp = 1.0; hitp = 1.0; }
      else if (dot(body, body) < 1.0 || dot(head, head) < 1.0 || neck < max(0.07 * tall, 0.5 * px) || legs) { col = lead * (g.y > 0.5 ? 1.0 : 0.85); hitp = 1.0; }
      else if (figureRound(g, vec2(-0.32, 0.24), 0.24, s)) { col = mix(tyre + 0.18 * wood, wood, step(length((g - vec2(-0.32, 0.24)) * s), 0.09 * tall)); hitp = 1.0; }
      else if (figureIn(g, vec2(-1.0, 0.26), vec2(0.34, 0.6))) { col = wood * (0.9 + 0.2 * step(0.5, fract(g.y * 6.0))); hitp = 1.0; }
      else if (load < 0.85 && abs(g.x + 0.33) < 0.64 && g.y >= 0.6 && g.y < max(heap, 0.6 + cellq.y)) { col = stuff; hitp = 1.0; topf = step(heap - 0.12, g.y); n = topf > 0.5 ? up : side; }
      else if (abs(g.y - 0.5) < max(0.02, 0.5 * cellq.y) && g.x > 0.3 && g.x < 0.6) { col = wood * 0.6; hitp = 1.0; }
    } else {
      // Tractor and trailer: big rear wheel, cab with its glass, bonnet, the trailer behind.
      if (lamps > 0.5 && length((g - vec2(0.98, 0.42)) * s) < 0.6 * px) { lamp = 1.0; hitp = 1.0; }
      else if (figureRound(g, vec2(0.46, 0.3), 0.3, s) || figureRound(g, vec2(0.88, 0.16), 0.16, s) || figureRound(g, vec2(-0.46, 0.14), 0.14, s)) { col = tyre; hitp = 1.0; }
      else if (figureIn(g, vec2(0.36, 0.6), vec2(0.6, 0.92))) { col = vec3(0.16, 0.2, 0.24); hitp = 1.0; }
      else if (figureIn(g, vec2(0.32, 0.22), vec2(0.64, 1.0)) || figureIn(g, vec2(0.62, 0.22), vec2(1.0, 0.55))) { col = lead; hitp = 1.0; topf = step(0.95, g.y); }
      else if (figureIn(g, vec2(-1.0, 0.2), vec2(0.24, 0.55))) { col = wood * 0.9; hitp = 1.0; }
      else if (load < 0.85 && figureIn(g, vec2(-0.94, 0.55), vec2(0.18, max(0.78, 0.55 + cellq.y)))) { col = stuff; hitp = 1.0; topf = step(0.68, g.y); n = topf > 0.5 ? up : side; }
    }
  } else {
    float a = abs(q.x);
    bool toward = heading.y > 0.0;
    if (kind < 0.5) {
      if (toward && lamps > 0.5 && length((q - vec2(0.55, 0.62)) * s) < 0.6 * px) { lamp = 1.0; hitp = 1.0; }
      else if (toward && ((a < max(0.3, cellq.x) && q.y < 0.76) || (a < max(0.15, 0.5 * cellq.x) && q.y < 0.98))) { col = lead; hitp = 1.0; }
      else if (a > 0.72 && q.y < 0.46) { col = tyre + 0.18 * wood; hitp = 1.0; }
      else if (a < 0.84 && q.y > 0.22 && q.y < 0.62) { col = wood; hitp = 1.0; }
      else if (load < 0.85 && a < 0.74 && q.y >= 0.62 && q.y < max(0.9, 0.62 + cellq.y)) { col = stuff; hitp = 1.0; topf = step(0.8, q.y); n = topf > 0.5 ? up : side; }
    } else {
      if (toward && lamps > 0.5 && abs(a - 0.28) < max(0.12, 0.5 * cellq.x) && abs(q.y - 0.42) < 0.5 * cellq.y) { lamp = 1.0; hitp = 1.0; }
      else if (a > 0.66 && q.y < (toward ? 0.6 : 0.32)) { col = tyre; hitp = 1.0; }
      else if (toward && a < 0.56 && q.y > 0.6 && q.y < 1.0) { col = a < 0.36 && q.y < 0.92 ? vec3(0.16, 0.2, 0.24) : lead; hitp = 1.0; }
      else if (toward && a < 0.38 && q.y > 0.18 && q.y <= 0.6) { col = lead; hitp = 1.0; }
      else if (!toward && a < 0.86 && q.y > 0.18 && q.y < 0.55) { col = wood * 0.9; hitp = 1.0; }
      else if (!toward && load < 0.85 && a < 0.8 && q.y >= 0.55 && q.y < max(0.78, 0.55 + cellq.y)) { col = stuff; hitp = 1.0; topf = step(0.68, q.y); n = topf > 0.5 ? up : side; }
    }
  }
  if (hitp > 0.5) {
    f.cover = 1.0;
    f.lamp = lamp;
    f.albedo = lamp > 0.5 ? vec3(1.0, 0.7, 0.3) : col;
    f.normal = n;
    f.top = topf;
  } else if (high > 3.0 && abs(q.x) < 1.05 && q.y > -0.08 && q.y < 0.06) {
    f.shadow = 0.5;
  }
  return f;
}

// A walk with rests: how far (in seconds of walking) someone has come by time t who walks
// \`period - rest\` seconds and then stands \`rest\` seconds, over and over (x), and whether they are
// walking now (y: 1) or resting (0).
vec2 figureStroll(float t, float period, float rest) {
  float n = floor(t / period);
  float m = t - n * period;
  float go = period - rest;
  return vec2(n * go + min(m, go), step(m, go));
}

// Out along a way and back again, over and over, from a clock in the way's own units: \`there\` and
// \`back\` long each way (they may differ, uphill being slower), resting \`restFar\` at the far end
// and \`restNear\` at the start. x: how far into the current trip (from the start going out, from the
// far end coming back); y: +1 going out, -1 coming back, 0 resting; z: 0 at the start end, 1 the far.
vec3 figureShuttle(float clock, float there, float back, float restFar, float restNear) {
  float cycle = there + restFar + back + restNear;
  float c = mod(clock, cycle);
  if (c < there) return vec3(c, 1.0, 0.0);
  c -= there;
  if (c < restFar) return vec3(0.0, 0.0, 1.0);
  c -= restFar;
  if (c < back) return vec3(c, -1.0, 1.0);
  return vec3(0.0, 0.0, 0.0);
}
`;
