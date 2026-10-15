// Buildings seen across a landscape: a cottage, a church, chimney smoke and windows lighting up at
// dusk. Opt-in shared GLSL: a scene concatenates `buildingsGlsl` into its own GLSL ahead of the code
// that uses it (the countryside does, src/scenes/country/buildings.ts, for its far houses; it
// models its near ones and its castle itself); it is not part of the libs every scene compiles.
//
// The shapes only sort a point into faces, in the shape's own units on the screen plane (y up); the
// scene gives the faces its colours, light, wetness and snow. Each takes:
//   ground  the bare land's outline at the point's column, in the shape's units above its base.
//           Walls reach down to it wherever the land falls away under them, so a building on a brow
//           never shows sky under a wall (pass a large value where the land never does).
//   px      one dither cell in the shape's units. Details that would fall below a cell drop out
//           (chimneys, belfry openings) or grow to a cell (windows, so a lit one still shows as a
//           point of light far off).
// Windows and smoke are timed by the scene's clocks: buildingWindow by the time of day (0..1 from
// midnight) and how dark it is for the people inside, buildingSmoke by the motion clock.
export const buildingsGlsl = /* glsl */ `
// Whether a window is lit (0/1). h: the window's hash. Windows come on one by one as the light
// fails (or on a dark stormy day), most go dark between half past ten and two, and a few early
// risers light up again before dawn; only \`share\` of them ever light.
float buildingWindow(float h, float tod, float dark, float share) {
  if (fract(h * 7.31) >= share) return 0.0;
  float on = step(0.12 + 0.6 * fract(h * 3.17), dark);
  float clock = tod < 0.5 ? tod + 1.0 : tod;   // from noon: 1.0 midnight, 1.25 dawn
  float bed = 0.94 + 0.14 * fract(h * 5.71);
  float rise = fract(h * 9.13) < 0.3 ? 1.2 + 0.05 * fract(h * 2.9) : 1.6;
  return on * (1.0 - step(bed, clock) * step(clock, rise));
}

// Where a cottage's chimney stands (its top), in cottage units; see buildingCottage.
vec2 buildingStack(float len, float wall, float rise, float recede) {
  vec2 eave = vec2(0.08, wall - 0.07);
  vec2 rafter = vec2(-0.5, wall + rise + 0.05) - eave;
  vec2 run = vec2(len + 0.06, (len + 0.06) * recede);
  return eave + 0.82 * rafter + 0.72 * run + vec2(0.0, 0.3);
}

// Whether height y on a wall \`wall\` high is at window height (a window grows to a cell far off).
bool buildingSill(float y, float wall, float px) {
  return (y > 0.38 * wall && y < 0.75 * wall) || abs(y - 0.565 * wall) < 0.5 * px;
}

// A building seen corner-on, in its own units: the gable end (1 wide, eaves \`wall\` up, ridge
// \`rise\` above them) faces front-left; the long wall (\`len\`) faces front-right and runs away up
// the screen, rising \`recede\` per unit along it; the roof over it is the gable's right-hand rafter
// swept along the house. Mirror q.x for buildings facing the other way. Returns the face under q:
// 0 none, 1 gable end, 2 long wall, 3 roof, 4 chimney; pane gets 1..3 on a window.
float buildingCottage(vec2 q, float len, float wall, float rise, float recede, bool stack, float ground, float px, out float pane) {
  pane = 0.0;
  vec2 ridge = vec2(-0.5, wall + rise);
  vec2 eave = vec2(0.08, wall - 0.07);
  vec2 rafter = ridge + vec2(0.0, 0.05) - eave;
  vec2 run = vec2(len + 0.06, (len + 0.06) * recede);
  if (stack && px < 0.2) {
    vec2 top = buildingStack(len, wall, rise, recede);
    if (abs(q.x - top.x) < 0.085 && q.y > top.y - 0.5 && q.y < top.y) return 4.0;
  }
  // Roof: q = eave + a * rafter + b * run, inside for a, b in 0..1.
  vec2 rel = q - eave;
  float det = rafter.x * run.y - rafter.y * run.x;
  float a = (rel.x * run.y - rel.y * run.x) / det;
  float b = (rafter.x * rel.y - rafter.y * rel.x) / det;
  if (a >= 0.0 && a <= 1.0 && b >= 0.0 && b <= 1.0) return 3.0;
  // The roof's verge under its right-hand rafter, down to the eave: it closes over the top of the
  // gable and of the long wall's corner, which stop just short of the rafter.
  if (q.x >= ridge.x && q.x <= eave.x) {
    float under = q.x <= 0.0 ? wall - 2.0 * rise * q.x : wall + q.x * recede;
    if (q.y > under && q.y <= eave.y + (q.x - eave.x) * rafter.y / rafter.x) return 3.0;
  }
  // Gable end, edged by the verge of the roof along its left-hand rafter.
  if (q.x >= -1.06 && q.x <= 0.0 && q.y >= min(0.0, ground)) {
    if (segmentDistance(q, vec2(-1.06, wall - 0.07), ridge + vec2(0.0, 0.05)) < 0.07) return 3.0;
    float top = wall + rise * (1.0 - abs(q.x + 0.5) / 0.5);
    if (q.x >= -1.0 && q.y <= top) {
      if (abs(q.x + 0.5) < max(0.16, 0.5 * px) && buildingSill(q.y, wall, px)) pane = 1.0;
      return 1.0;
    }
  }
  // Long wall, its windows a third and two thirds along.
  float up = q.y - q.x * recede;
  if (q.x > 0.0 && q.x <= len && up >= min(0.0, ground - q.x * recede) && up <= wall) {
    if (buildingSill(up, wall, px)) {
      float reach = max(0.14, 0.5 * px);
      if (abs(q.x - 0.3 * len) < reach) pane = 2.0;
      if (abs(q.x - 0.72 * len) < reach) pane = 3.0;
    }
    return 2.0;
  }
  return 0.0;
}

// The church: a long nave, a square west tower in front of its gable end and a spire on the tower.
// Faces as for cottages, plus 5 tower front, 6 tower side, 7 and 8 the spire's two faces, 9 the
// belfry opening. Its units: the tower is 0.7 wide, 2.3 high, the spire's tip 4.38 up.
float buildingChurch(vec2 q, float recede, float ground, float px, out float pane) {
  pane = 0.0;
  float tower = 2.3;
  vec2 apex = vec2(-0.42, tower + 2.08);
  if (q.y > tower && q.y < apex.y) {
    float k = (q.y - tower) / (apex.y - tower);
    float corner = mix(-0.16, apex.x, k);
    if (q.x > mix(-0.9, apex.x, k) && q.x < mix(0.08, apex.x, k)) return q.x < corner ? 7.0 : 8.0;
  }
  if (q.x >= -0.86 && q.x <= -0.16 && q.y >= min(0.0, ground) && q.y <= tower) {
    if (px < 0.26 && abs(q.x + 0.51) < 0.13 && q.y > tower - 0.5 && q.y < tower - 0.18) return 9.0;
    return 5.0;
  }
  if (q.x > -0.16 && q.x <= 0.06) {
    float up = q.y - (q.x + 0.16) * recede;
    if (up >= min(0.0, ground - (q.x + 0.16) * recede) && up <= tower) return 6.0;
  }
  return buildingCottage(q, 2.5, 1.0, 0.62, recede, false, ground, px, pane);
}

// Chimney smoke from \`top\` (screen units), rising \`tall\`: a plume that curls, widens and thins as
// it climbs and leans downwind, more so higher up where the wind is stronger. Density 0..1. It
// reaches at most 1.7 * tall to either side of its chimney (in a full gale).
float buildingSmoke(vec2 q, vec2 top, float tall, float seed, float t, float wind) {
  float h = (q.y - top.y) / tall;
  if (h < 0.0 || h > 1.0) return 0.0;
  float lean = wind * (0.5 * h + 1.1 * h * h);
  float curl = 0.06 * sin(h * 8.0 - t * 1.1 + seed * 6.3) * smoothstep(0.0, 0.35, h) * (1.0 - 0.5 * abs(wind));
  float x = (q.x - top.x) / tall - lean - curl;
  float width = 0.03 + 0.14 * h;
  float body = exp(-x * x / (width * width));
  float puffs = vnoise(vec2(x * 9.0 + seed * 17.0, h * 6.0 - t * 0.7));
  return body * (0.45 + 0.75 * puffs) * smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.35, 1.0, h));
}
`;
