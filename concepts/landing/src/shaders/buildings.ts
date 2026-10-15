// Buildings seen across a landscape: a cottage, a church, a castle, chimney smoke and windows
// lighting up at dusk. Opt-in shared GLSL: a scene concatenates `buildingsGlsl` into its own GLSL
// ahead of the code that uses it (the countryside does, src/scenes/country/settlements.ts); it is
// not part of the libs every scene compiles.
//
// The shapes only sort a point into faces, in the shape's own units on the screen plane (y up); the
// scene gives the faces its colours, light, wetness and snow. Each takes:
//   ground  the bare land's outline at the point's column, in the shape's units above its base.
//           Walls reach down to it wherever the land falls away under them, so a building on a brow
//           never shows sky under a wall (pass a large value where the land never does).
//   px      one dither cell in the shape's units. Details that would fall below a cell drop out
//           (chimneys, belfry openings) or grow to a cell (windows, so a lit one still shows as a
//           point of light far off); battlements keep at least three cells to a merlon and gap.
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

// The top of a stretch of wall or tower at height \`top\`, crenellated: 0 above it (air), 1 inside,
// 2 in its topmost band (the walk, the merlons' tops: where snow lies). x: along it.
float buildingBattlement(float x, float y, float top, float px) {
  float period = max(1.0, 3.0 * px);
  float merlon = fract(x / period + 0.25) < 0.55 ? max(0.55, 1.2 * px) : 0.0;
  float crown = top + merlon;
  if (y > crown) return 0.0;
  return y > crown - max(0.3, px) ? 2.0 : 1.0;
}

// A castle on a hilltop, face-on, in castle units (a cottage's gable: x across from its middle,
// y up from the bare crest there): a curtain wall with battlements stepping along the ground, round
// towers at its ends, a gatehouse of two towers in the middle, the square keep rising behind with a
// corner turret, and (tall > 0.5) a slender tower with a conical roof. flip (-1) mirrors it. It
// spans |x| < 8.6 and y < 9.2. Returns the face: 0 none, 1 curtain wall, 2 round tower, 3 the top of
// a wall, tower or merlon, 4 the gate, 5 the keep's front, 6 the keep's side, 7 a conical roof;
// across: -1..1 across a round tower or roof (screen-facing, mirror included); slit: 1.. on a
// window (which), else 0.
float buildingCastle(vec2 q, float ground, float px, float flip, float tall, out float across, out float slit) {
  across = 0.0;
  slit = 0.0;
  float x = q.x * flip;
  float y = q.y;
  float foot = ground - 0.9;
  float sw = max(0.13, 0.5 * px);   // half a window's width
  // Round towers standing proud of the wall: the gatehouse pair, then the corner towers.
  for (int k = 0; k < 4; k++) {
    float corner = k < 2 ? 0.0 : 1.0;
    float xt = (mod(float(k), 2.0) < 0.5 ? -1.0 : 1.0) * mix(1.25, 7.3, corner);
    float r = mix(0.85, 1.3, corner);
    float u = (x - xt) / r;
    if (abs(u) < 1.0 && y >= foot) {
      float b = buildingBattlement(x, y, max(mix(4.0, 4.6, corner), ground + 3.4), px);
      if (b > 0.5) {
        across = u * flip;
        float top = max(mix(4.0, 4.6, corner), ground + 3.4);
        if (abs(x - xt) < sw && abs(y - (top - 1.5)) < max(0.35, 0.5 * px)) slit = 1.0 + float(k);
        return b > 1.5 ? 3.0 : 2.0;
      }
    }
  }
  // The curtain wall between them, its gate between the gatehouse towers.
  if (abs(x) < 7.3 && y >= foot) {
    float b = buildingBattlement(x, y, ground + 2.6, px);
    if (b > 0.5) {
      if (abs(x) < 0.5 && y < foot + 1.5 + 0.4 * sqrt(max(1.0 - x * x / 0.25, 0.0))) return 4.0;
      return b > 1.5 ? 3.0 : 1.0;
    }
  }
  // The keep behind, its side running back, its turret on the outer corner.
  float kx = x - 2.7;
  if (kx > -1.9 && kx < 2.5 && y >= foot) {
    float side = max(kx - 1.9, 0.0);
    float b = kx > -1.9 && kx < -1.05 ? buildingBattlement(x, y, 8.4, px) : buildingBattlement(x, y - 0.35 * side, 7.0, px);
    if (b > 0.5) {
      if (b > 1.5) return 3.0;
      if (side > 0.0) return 6.0;
      vec2 w = vec2(abs(kx) - 0.85, min(abs(y - 3.7), abs(y - 5.4)));
      if (abs(w.x) < sw && w.y < max(0.35, 0.5 * px)) slit = 5.0 + step(0.0, kx) + 2.0 * step(4.5, y);
      return 5.0;
    }
  }
  // The slender tower at the far side, its roof a cone.
  if (tall > 0.5) {
    float u = (x + 4.3) / 0.7;
    if (abs(u) < 1.0 && y >= foot && y <= 6.2) {
      across = u * flip;
      if (abs(x + 4.3) < sw && abs(y - 5.0) < max(0.35, 0.5 * px)) slit = 9.0;
      return 2.0;
    }
    float cone = (x + 4.3) / 0.85;
    if (abs(cone) < 1.0 && y > 6.2 && y < 6.2 + 2.6 * (1.0 - abs(cone))) {
      across = cone * flip;
      return 7.0;
    }
  }
  return 0.0;
}
`;
