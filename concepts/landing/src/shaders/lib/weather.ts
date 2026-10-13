// Shared weather: rain and snow falling through the air in depth (hidden behind surfaces, fusing
// into a veil with distance), what they do to the world (splashes, puddles, wet albedo and gloss,
// drips from edges, lying snow), rain on a window pane, ripples on water, and fog. Compiled into
// every scene program after the sky library; the contract and conventions are in
// src/scenes/README.md. How wet the world is and how much snow lies come from the renderer as
// uWeather (src/renderer.ts).

export const weatherGlsl = `
// ---- weather ----

// Rain or snow seen through the air between the eye and the first opaque surface. cover: 0..1 of
// drops/flakes at this pixel (all depth layers, nearest strongest); veil: 0..1 haze of unresolved
// distant rain/snow between the eye and the surface; near: 0..1 share of cover from the nearest,
// out-of-focus layer.
struct Precip { float cover; float veil; float near; };

// The cell's own dither threshold, offset from the palette's so particles don't line up with colour
// steps. Particles are switched on per cell against it: a moving edge flips each cell once, and a
// cell is either in a drop or not, so falling rain never crawls through the colour levels.
float weatherThreshold() {
  return threshold(gl_FragCoord.xy + vec2(2.0, 5.0));
}

// Normalised depth of a distance z in metres, as the layers below assume: depth = 1 - exp(-z / 30).
float weatherDepth(float z) {
  return 1.0 - exp(-z / 30.0);
}

// Gust curtains 0..1: bands of heavier rain or snow ~8 m wide in the world, travelling with the
// wind and slowly changing shape. x runs across the fall in screen heights, z is the distance (m)
// the bands are seen at, so nearer bands look wider and sweep faster. Still air drifts them slowly.
float weatherGust(float x, float z, float t, float wind) {
  float drift = (0.8 + 5.0 * abs(wind)) * (wind < 0.0 ? -1.0 : 1.0);
  return smoothstep(0.3, 0.72, vnoise(vec2((x * z - t * drift) * 0.12, t * 0.04)));
}

// One depth layer of rain, q in screen heights, already turned so the rain falls along -y. Columns
// of cells hold at most one streak each and slide down at the column's own speed, so every streak
// keeps its shape and moves continuously; a streak fades in or out (never pops) as the local fill
// sweeps past its rank, and each drop has its own depth inside span, so a nearer surface hides
// exactly the drops behind it. len is the longest streak; rows are gap * len tall. Returns x = the
// streak's shape 0..1 (to compare with the cell threshold), y = its brightness 0.8..1.
vec2 weatherRainLayer(vec2 q, float t, float cols, float speed, float len, float gap, float width, float soft, float fill, vec2 span, float depth, float salt) {
  float cx = floor(q.x * cols);
  float hc = hash12(vec2(cx, salt));
  float y = (q.y + t * speed * (0.85 + 0.3 * hc)) / (len * gap) + hc * 17.0;
  float cy = floor(y);
  float h = hash12(vec2(cx * 1.31 + salt, cy));
  float vis = clamp((fill - h) * 12.0, 0.0, 1.0);
  if (vis <= 0.0) return vec2(0.0);
  float h2 = hash12(vec2(cy + salt * 0.7, cx + 41.0));
  if (mix(span.x, span.y, fract(h2 * 23.7)) >= depth) return vec2(0.0);
  float w = max(width, 1.3 / uRes.y); // never thinner than ~2 cells, or it shimmers through the dither
  float xc = (cx + 0.3 + 0.4 * h2) / cols;
  float across = 1.0 - smoothstep(w * soft, w, abs(q.x - xc));
  float l = (0.5 + 0.5 * fract(h2 * 37.1)) / gap;          // this streak's length as a fraction of its row
  float s = (fract(y) - fract(h2 * 91.7) * (1.0 - l)) / l; // 0 at the head (bottom) .. 1 at the tail
  float along = smoothstep(0.0, 0.06, s) * (1.0 - smoothstep(0.45, 1.0, s));
  return vec2(across * along * vis, 0.8 + 0.2 * fract(h2 * 53.3));
}

// Rain layers, nearest first (layer i at z = 2^i m): the most each can fill, and the cover a streak
// in it gives. A few big bright near drops, mid layers carrying the body of the rain, far layers a
// fine, dense, faint moving texture. In steady rain every level stays above about a third, so a
// scene's mix still crosses a dither level. The fills set density against flicker: at amount 0.4
// about 3.4% of open-sky cells are in a streak, 6% at 0.6 and 13% at 1.0.
const float weatherRainFill[6] = float[6](0.45, 0.45, 0.5, 0.4, 0.3, 0.28);
const float weatherRainLevel[6] = float[6](0.8, 0.9, 0.75, 0.6, 0.45, 0.35);

// Rain between the eye and the first surface. depth: distance to that surface, 0 at the eye .. 1 far
// horizon or open sky (the layers sit for depth = 1 - exp(-z / 30 m)). Six layers at 1, 2, 4, 8, 16
// and 32 m: the nearest big, fast, sparse, soft and long; the farthest fine, short, slow and dense;
// beyond them the rain fuses into the veil. The amount changes the rain's character, not just its
// count: drizzle (0.1) is a few faint, short streaks in the distance and mostly veil; steady rain
// (0.4) streaks at every depth; heavy rain (0.7) adds big near drops and gust sheets; a downpour
// (1.0) is dense sheets sweeping across with the wind and a veil that swallows the distance.
// wind -1..1 slants it (positive: to the right), more for slow drizzle than for heavy drops.
Precip rainFall(vec2 uv, float aspect, float t, float amount, float wind, float depth) {
  Precip o = Precip(0.0, 0.0, 0.0);
  if (amount <= 0.0) return o;
  float a = clamp(amount, 0.0, 1.0);
  float tm = t * uMotion;
  float fall = mix(0.5, 1.15, smoothstep(0.05, 0.85, a)); // drop size: drizzle drifts, a downpour hurtles
  float slant = clamp(atan(wind * 0.8 / fall), -1.1, 1.1);
  float bright = mix(0.75, 1.0, smoothstep(0.05, 0.7, a));
  float thick = mix(0.8, 1.35, a);
  float sheet = 1.0 + 0.5 * smoothstep(0.7, 1.0, a); // a downpour closes into sheets
  float gusty = smoothstep(0.25, 0.95, a) * (0.35 + 0.65 * abs(wind));
  float th = weatherThreshold();
  vec2 q0 = vec2((uv.x - 0.5) * aspect, uv.y);
  float clear = 1.0;
  float nearCover = 0.0;
  for (int i = 0; i < 6; i++) {
    float f = float(i);
    float z = pow(2.0, f);
    vec2 q = rotate(q0, -slant * (1.08 - 0.03 * f));
    // Far layers fill in first (drizzle is fine and distant), near drops only in real rain.
    float fill = weatherRainFill[i] * sheet * smoothstep(0.15 - 0.1 * f, 1.0 - 0.08 * f, a);
    fill *= 1.0 + gusty * (1.5 * weatherGust(q.x, z, tm, wind) - 0.55);
    // Nearer drops cross the screen far faster. Each streak is its drop's path over a shutter of
    // 0.12 s (near) .. 0.29 s (far): far streaks come out short and slow, and every cell stays lit
    // for several frames as one passes.
    float speed = 2.4 * pow(z, -0.9) * fall;
    vec2 r = weatherRainLayer(q, tm, min(6.0 * pow(z, 1.25), uRes.y / 7.0), speed, speed * 0.12 * pow(z, 0.25),
                              2.5 - 0.1 * f, 0.011 * pow(z, -0.8) * thick, i == 0 ? 0.15 : 0.6, min(fill, 0.95),
                              vec2(weatherDepth(z / 1.41), weatherDepth(z * 1.41)), depth, f * 7.3 + 1.0);
    float c = (r.x > th ? 1.0 : 0.0) * r.y * bright * weatherRainLevel[i];
    if (i == 0) nearCover = c;
    clear *= 1.0 - c;
  }
  o.cover = 1.0 - clear;
  o.near = o.cover > 0.0 ? nearCover / o.cover : 0.0;
  // The rain too fine and far to resolve: a grey veil thickening with distance and amount, and
  // heavier where a gust curtain passes (the curtains lean with the rain).
  float k = 0.22 * smoothstep(0.0, 0.12, a) + 0.3 * a + 0.87 * a * a * a;
  k *= 1.0 + gusty * (1.3 * weatherGust(rotate(q0, -slant).x, mix(2.0, 22.0, depth), tm, wind) - 0.45);
  o.veil = 1.0 - exp(-k * depth * (0.4 + 0.6 * depth));
  return o;
}

// One depth layer of snow, q in screen heights, scale m (1 nearest .. ~0.15 farthest). Cells hold at
// most one flake; columns fall at their own pace and drift with the wind, and a slow, smooth warp of
// the whole lattice (well under a cell per cell) makes the flakes swirl in eddies without ever
// leaving their cells. Each flake is a little oval tumbling on its own spin, drawn out along its
// path when the wind drives it hard (stretch > 1). Returns x = shape 0..1, y = brightness.
vec2 weatherSnowLayer(vec2 q, float t, float m, float fall, float drift, float fill, float swirl, float stretch, float soft, vec2 span, float depth, float salt) {
  float k = 2.0 / m;
  q += (vec2(vnoise(q * k + vec2(t * 0.07, salt)), vnoise(q * k + vec2(salt + 4.1, -t * 0.06))) - 0.5) * swirl * m;
  float cells = min(5.0 / m, uRes.y / 5.0);
  q.x -= t * drift;
  float cx = floor(q.x * cells);
  float hc = hash12(vec2(cx, salt + 3.0));
  q.y += t * fall * (0.75 + 0.5 * hc) + hc * 9.0;
  vec2 g = q * cells;
  vec2 id = floor(g);
  float h = hash12(id + vec2(salt * 1.7, salt));
  float vis = clamp((fill - h) * 8.0, 0.0, 1.0);
  if (vis <= 0.0) return vec2(0.0);
  float h2 = hash12(id.yx + vec2(salt + 5.0, 13.0));
  if (mix(span.x, span.y, fract(h2 * 23.7)) >= depth) return vec2(0.0);
  vec2 c = vec2(0.3 + 0.4 * h2, 0.3 + 0.4 * fract(h2 * 53.1));
  c.x += 0.12 * sin(t * (0.5 + 0.8 * fract(h2 * 7.7)) + TAU * h2);
  // Flake, sway and streak stay inside the cell (centre 0.18..0.82, reach <= 0.17).
  float r = min(max(0.03 * pow(m, 1.3), 1.1 / uRes.y) * cells, 0.17 / stretch) * (0.65 + 0.35 * fract(h2 * 17.3));
  vec2 v = g - id - c;
  vec2 dir = normalize(vec2(drift, -fall) + vec2(0.0, -1e-4));
  float al = dot(v, dir);
  v += dir * (al / stretch - al);
  float spin = t * (0.3 + 0.9 * fract(h2 * 3.1)) + TAU * fract(h2 * 9.3);
  v = rotate(v, spin);
  v.x *= 1.3;
  float shape = (1.0 - smoothstep(r * soft, r, length(v))) * vis;
  // Tumbling flakes catch the light twice a turn.
  return vec2(shape, (0.6 + 0.4 * fract(h * 31.7)) * (0.75 + 0.25 * sin(spin * 2.0)));
}

// Snow between the eye and the first surface; depth, wind and the result as for rainFall. Five
// layers at ~1, 2.2, 4.8, 10.6 and 23 m: the nearest big, soft and tumbling, the farthest fine. A
// flurry (0.1-0.2) is a few lazy flakes; steady snow (0.5) fills every layer with a soft veil
// behind; a blizzard (1.0) is dense, wind-driven and streaked, swirling hard, with gust surges and a
// whiteout veil that closes in even near the eye.
Precip snowFall(vec2 uv, float aspect, float t, float amount, float wind, float depth) {
  Precip o = Precip(0.0, 0.0, 0.0);
  if (amount <= 0.0) return o;
  float a = clamp(amount, 0.0, 1.0);
  float tm = t * uMotion;
  float storm = smoothstep(0.55, 1.0, a);
  float push = wind * (0.15 + 0.45 * a); // sideways drift of the nearest layer, screen heights/s
  float swirl = mix(0.03, 0.09, a) * (0.6 + 0.4 * abs(wind));
  float gusty = smoothstep(0.45, 1.0, a) * (0.4 + 0.6 * abs(wind));
  float th = weatherThreshold();
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y);
  float clear = 1.0;
  float nearCover = 0.0;
  for (int i = 0; i < 5; i++) {
    float f = float(i);
    float z = pow(2.2, f);
    float m = pow(1.0 / z, 0.6);
    // ~1.2% of open-sky cells hold a flake in steady snow (0.5), ~2.3% in a blizzard.
    float fill = (0.5 + 0.06 * f) * smoothstep(-0.2 - 0.03 * f, 0.6 + 0.05 * f, a);
    fill *= 1.0 + gusty * (1.5 * weatherGust(q.x, z, tm, wind) - 0.55);
    float fall = 0.2 * m * mix(0.85, 1.3, a);
    float drift = push * m;
    float stretch = 1.0 + storm * clamp(length(vec2(drift, fall)) * 2.0, 0.0, 0.8);
    vec2 r = weatherSnowLayer(q, tm, m, fall, drift, min(fill, 0.9), swirl, stretch, i == 0 ? 0.15 : 0.5,
                              vec2(weatherDepth(z / 1.48), weatherDepth(z * 1.48)), depth, f * 5.1 + 2.0);
    float c = (r.x > th ? 1.0 : 0.0) * r.y * (i == 0 ? 0.6 : 1.05 - 0.1 * f);
    if (i == 0) nearCover = c;
    clear *= 1.0 - c;
  }
  o.cover = 1.0 - clear;
  o.near = o.cover > 0.0 ? nearCover / o.cover : 0.0;
  float k = 0.12 * smoothstep(0.0, 0.15, a) + 0.35 * a + 2.1 * a * a * a;
  k *= 1.0 + gusty * (1.4 * weatherGust(q.x, mix(2.0, 22.0, depth), tm, wind) - 0.5);
  o.veil = 1.0 - exp(-k * depth * (0.4 + 0.6 * depth));
  return o;
}

// One grid of splash sites, p in cells: each cell's drops land at a fresh spot every ~0.45-1.1 s
// and crown for ~0.2-0.3 s, a disc that widens as it fades, so each dither cell lights once and
// goes dark once per splash. a 0..1 rain amount.
float weatherSplash(vec2 p, float t, float a, float salt) {
  vec2 id = floor(p);
  float h = hash12(id + salt);
  float period = mix(1.1, 0.45, a) * (0.8 + 0.4 * fract(h * 7.1));
  float ph = t / period + h * 7.0;
  float n = floor(ph);
  float age = (ph - n) * period;
  float life = mix(0.2, 0.32, a);
  if (age >= life || hash12(id + vec2(n * 0.37 + salt, n * 0.61)) >= 0.9 * a) return 0.0;
  vec2 c = 0.32 + 0.36 * vec2(hash12(id + n * 1.7 + 3.1 + salt), hash12(id + n * 2.3 + 8.7));
  float k = age / life;
  float r = mix(0.16, 0.3, a) * (0.45 + 0.55 * sqrt(k));
  float d = length(p - id - c);
  return (1.0 - smoothstep(r * 0.75, r, d)) * mix(0.65, 1.0, d / r) * (1.0 - k * k);
}

// Brief splash crowns where drops hit hard, upward-facing ground: p in ground units (~metres), two
// grids of 0.5-unit sites (8 per unit^2), crowns of radius 0.08-0.15 that come more often, bigger
// and brighter as the rain gets heavier (almost none in drizzle). Where a unit spans 25 cells a
// crown is ~5 cells across and lights ~10 of them in steady rain. Each crown switches cells on
// against the dither threshold, so the result is 0 or the splash's light 0.7..1. Fade it out where
// a unit spans fewer than ~15 cells: smaller crowns only sparkle.
float rainSplashes(vec2 p, float t, float amount) {
  if (amount <= 0.0) return 0.0;
  float a = clamp(amount, 0.0, 1.0);
  float tm = t * uMotion;
  vec2 g = p / 0.5;
  float s = max(weatherSplash(g, tm, a, 0.0), weatherSplash(g + 0.5, tm, a, 11.3));
  return s > weatherThreshold() ? 0.7 + 0.3 * a : 0.0;
}

// Beads on the pane, q in screen heights: a grid of sites, each forming a drop that sits for a while
// and evaporates. A drop is a little fish-eye lens: the offset points through its centre, so it shows
// a small inverted picture of a patch ~2.5x its size. Returns xy offset (q units), z coverage.
vec3 weatherBeads(vec2 q, float t, float fill) {
  vec2 g = q * 22.0;
  vec2 id = floor(g);
  float h = hash12(id + 0.71);
  if (h >= fill) return vec3(0.0);
  float h2 = hash12(id.yx + 3.17);
  float life = fract(t * (0.02 + 0.03 * fract(h2 * 7.1)) + fract(h2 * 3.7));
  float fade = smoothstep(0.0, 0.03, life) * (1.0 - smoothstep(0.82, 1.0, life));
  vec2 c = 0.3 + 0.4 * vec2(h2, fract(h2 * 41.3));
  float k = fract(h2 * 97.0);
  float r = (0.1 + 0.18 * k * k) * (0.5 + 0.5 * fade);
  vec2 v = g - id - c;
  float cov = (1.0 - smoothstep(r * 0.7, r, length(v))) * fade;
  return vec3(-v * (3.5 / 22.0) * cov, cov);
}

// Where a sliding drop's path is across its cell (0..1) at height y in the cell: the meander is a
// function of height, so the trail it leaves stays exactly where the drop went.
float weatherPathX(float y, float h2, float h3) {
  return 0.5 + (h3 - 0.5) * 0.3 + 0.07 * sin(y * 11.0 + h3 * TAU) + 0.03 * sin(y * 29.0 + h2 * TAU);
}

// Drops sliding down the pane (after "Heartfelt", Martijn Steinrucken, 2017): columns of tall cells,
// each with one drop that forms, slides down in stick-slip jerks along a meandering path, sheds a
// trail of small beads and dwindles away. Returns xy offset (q units), z coverage, and w = how much
// it has wiped its path clear of static beads.
vec4 weatherSlide(vec2 q, float t, float fill, float scale, float salt) {
  vec2 cell = vec2(0.22, 0.9) / scale;
  float cx = floor(q.x / cell.x);
  vec2 g = vec2(q.x / cell.x, q.y / cell.y + hash12(vec2(cx, salt))); // columns staggered in height
  vec2 id = floor(g);
  vec2 f = g - id;
  float h = hash12(id + vec2(salt, 7.7));
  if (h >= fill) return vec4(0.0);
  float h2 = hash12(id.yx + vec2(19.3, salt));
  float h3 = fract(h2 * 53.7);
  float life = fract(t / (6.0 + 5.0 * h2) + fract(h2 * 7.9));
  float fade = 1.0 - smoothstep(0.88, 1.0, life);
  float prog = smoothstep(0.1, 0.95, life);
  // Stick-slip: the speed swings by +-56% (0.012 * 47) and never reverses.
  prog = clamp(prog + 0.012 * sin(prog * 47.0), 0.0, 1.0);
  float top = 0.92;
  float dropY = mix(top, 0.1, prog);
  float r0 = 0.022 / scale * (0.75 + 0.25 * h / fill);
  float r = r0 * smoothstep(0.0, 0.1, life) * fade * (1.0 - 0.35 * prog);

  // The drop: a dome drawn out upward into a tear.
  vec2 v = (f - vec2(weatherPathX(dropY, h2, h3), dropY)) * cell;
  v.y *= v.y > 0.0 ? 0.7 : 1.0;
  float cov = 1.0 - smoothstep(r * 0.75, r, length(v));
  vec2 off = -v * 3.0 * cov;

  // Its trail: one bead per row on the glass it has crossed, smaller toward where it started.
  float spacing = 0.026 / scale / cell.y;
  float by = (floor(f.y / spacing) + 0.5) * spacing;
  float hb = hash12(vec2(by * 91.0 + salt, id.x + id.y * 13.0));
  float span = max(top - dropY, 1e-3);
  float above = clamp((by - dropY) / span, 0.0, 1.0);
  float br = r0 * (0.16 + 0.16 * hb) * (1.0 - 0.4 * above) * fade;
  vec2 bv = (f - vec2(weatherPathX(by, h2, h3) + (hb - 0.5) * 0.04, by)) * cell;
  float inTrail = step(dropY + 1.5 * r0 / cell.y, by) * step(by, top) * step(hb, 0.85);
  float bcov = (1.0 - smoothstep(br * 0.6, br, length(bv))) * inTrail;
  if (bcov > cov) {
    cov = bcov;
    off = -bv * 3.0 * bcov;
  }

  // The channel it wiped, refilling with beads toward the top.
  float ap = clamp((f.y - dropY) / span, 0.0, 1.0);
  float wipe = (1.0 - smoothstep(r0 * 0.9, r0 * 1.4, abs(f.x - weatherPathX(f.y, h2, h3)) * cell.x))
             * step(dropY, f.y) * step(f.y, top) * (1.0 - 0.5 * ap) * fade;
  return vec4(off, cov, wipe);
}

// Rain on a window pane: static beads, plus larger drops (two sizes) now and then sliding down and
// leaving a trail of small beads in a wiped channel. Returns xy = refraction offset in uv units (draw
// what lies behind the glass at uv + xy) and z = drop coverage 0..1 (for a highlight or darkening).
vec3 glassDrops(vec2 uv, float aspect, float t, float amount) {
  if (amount <= 0.0) return vec3(0.0);
  vec2 q = vec2(uv.x * aspect, uv.y);
  float tm = t * uMotion;
  float a = clamp(amount, 0.0, 1.0);
  vec4 large = weatherSlide(q, tm, 0.7 * a, 1.0, 0.0);
  vec4 medium = weatherSlide(q, tm, 0.85 * a, 1.8, 5.0);
  vec3 d = weatherBeads(q, tm, 0.65 * a) * (1.0 - max(large.w, medium.w));
  if (medium.z > d.z) d = medium.xyz;
  if (large.z > d.z) d = large.xyz;
  return vec3(d.x / aspect, d.y, d.z);
}

// Raindrops landing on a wet surface. p is in drop-site cells (scale it so one unit is about the
// largest ring you want); each cell hosts a drop every ~1.1-1.8 s at a fresh random spot, its rings
// growing to radius 0.9 and fading out before the next, so nothing ever pops. amount 0..1 is the
// share of cells that rain. Returns xy = surface normal tilt (~-0.5..0.5), z = light on the crests.
vec3 rainRipples(vec2 p, float t, float amount) {
  if (amount <= 0.0) return vec3(0.0);
  float tm = t * uMotion;
  vec2 id = floor(p);
  vec2 fr = p - id;
  vec2 tilt = vec2(0.0);
  float light = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 cid = id + o;
      float h = hash12(cid + 0.5);
      float ph = tm * (0.55 + 0.35 * h) + h * 13.0;
      float n = floor(ph);
      float age = ph - n;
      float on = step(hash12(cid + vec2(n * 0.123, n * 0.731)), amount);
      vec2 c = o + 0.2 + 0.6 * vec2(hash12(cid + n * 1.7 + 3.1), hash12(cid + n * 2.3 + 8.7));
      vec2 v = fr - c;
      float d = length(v);
      float x = d - age * 0.9;
      float env = exp(-x * x * 90.0) * (1.0 - age) * (1.0 - age) * on;
      tilt += v / max(d, 1e-3) * cos(x * 30.0) * env;
      light += max(sin(x * 30.0), 0.0) * env;
    }
  }
  return vec3(tilt * 0.5, clamp(light, 0.0, 1.0));
}

// Where water pools on flat ground, 0..1 (1 inside a pool, a soft rim ~0.1 units wide): p in ground
// units (~metres; pools ~1.5-4 across), wet = uWeather.x. The low spots of a smooth noise fill first
// and spread as the ground gets wetter: none while merely damp, ~3% after drizzle (wet ~0.5), ~20%
// in steady rain (wet ~0.85), ~26% when soaked (wet 1).
float rainPuddles(vec2 p, float wet) {
  if (wet <= 0.35) return 0.0;
  float n = 0.55 * vnoise(p * 0.3) + 0.3 * vnoise(p * 0.8 + vec2(5.2, 1.3)) + 0.15 * vnoise(p * 2.1 + vec2(9.7, 4.4));
  float level = mix(0.2, 0.41, smoothstep(0.35, 1.0, wet));
  return 1.0 - smoothstep(level - 0.03, level, n);
}

// A wet surface's albedo: water fills the pores and darkens it (soil, wood and cloth far more than
// stone, metal or glass) and deepens its colour. wet = uWeather.x (or less under shelter); porous 0
// stone/metal/glass .. 1 soil/wood/cloth.
vec3 wetten(vec3 albedo, float wet, float porous) {
  float w = clamp(wet, 0.0, 1.0);
  float p = clamp(porous, 0.0, 1.0);
  vec3 rich = max(mix(vec3(dot(albedo, LUMA)), albedo, 1.0 + w * mix(0.2, 0.45, p)), 0.0);
  return rich * (1.0 - w * mix(0.22, 0.55, p));
}

// Extra specular / reflection 0..1 for a wet surface: a sheen on walls, leaves and rails, while
// flat ground (up = normal.y near 1) pools and mirrors once it is properly wet; undersides barely
// shine. Scale the scene's highlights and mirrored lights by it.
float wetGloss(float wet, float up) {
  float sheen = smoothstep(0.05, 0.8, wet);
  float level = smoothstep(0.6, 0.97, up) * smoothstep(0.3, 0.9, wet);
  return sheen * (0.3 + 0.7 * level) * (0.5 + 0.5 * smoothstep(-0.6, 0.0, up));
}

// Water gathering and falling from an edge (eaves, leaves, branches, sills, rails). p.x runs along
// the edge, p.y is the distance below it (positive downward), in the units of width, the spacing of
// drip points. Lane k (p.x in [k, k+1) widths) drips from a fixed spot at
// (k + 0.3 + 0.4 * hash12(vec2(k, 3.7))) * width: a bead swells under the edge (radius up to 0.11
// width), lets go, and the drop falls, accelerating and drawn out by its speed, fading 3..5 widths
// down. Heavier rain drips more often; some beats are skipped. Pass amount = max(K_rain,
// 0.4 * uWeather.x) to keep edges dripping while they dry. Returns 0 or 1 per cell (the drop's light).
float rainDrips(vec2 p, float t, float amount, float width) {
  if (amount <= 0.0 || width <= 0.0) return 0.0;
  vec2 u = p / width;
  if (u.y < 0.0 || u.y > 5.2) return 0.0;
  float a = clamp(amount, 0.0, 1.0);
  float tm = t * uMotion;
  float k = floor(u.x);
  float h = hash12(vec2(k, 3.7));
  float x0 = k + 0.3 + 0.4 * h;
  float drop = 0.8; // seconds a drop takes to fall out of sight
  float period = drop + mix(3.2, 0.6, a) * (0.7 + 0.6 * fract(h * 13.1));
  float ph = tm / period + fract(h * 7.3);
  float n = floor(ph);
  if (hash12(vec2(k + 0.5, n)) > 0.35 + 0.65 * a) return 0.0;
  float age = (ph - n) * period;
  float gather = period - drop;
  float r0 = 0.11;
  float shape;
  if (age < gather) {
    float rb = max(r0 * sqrt(age / gather), 1e-3);
    shape = 1.0 - smoothstep(rb * 0.6, rb, length(vec2(u.x - x0, (u.y - rb) * 1.1)));
  } else {
    float tf = age - gather;
    float y = r0 + 8.0 * tf * tf;              // g ~ 16 widths/s^2
    float tail = max(16.0 * tf * 0.04, 1e-3);  // drawn out over ~1/25 s of its fall
    float d = segmentDistance(u, vec2(x0, y - tail), vec2(x0, y));
    shape = (1.0 - smoothstep(r0 * 0.45, r0 * 0.8, d)) * (1.0 - smoothstep(3.0, 5.0, y));
  }
  return shape > weatherThreshold() ? 1.0 : 0.0;
}

// Snow lying on a surface, 0..1: n its unit normal (y up), p its position in scene units (the edge
// wobbles on ~0.15-0.4 units), lying = uWeather.y. Flat tops whiten first, a dusting gathering into
// a full cover with a noisy edge; slopes take longer, walls hold only a few patches in a blizzard,
// undersides none.
float snowCover(vec3 n, vec2 p, float lying) {
  if (lying <= 0.0) return 0.0;
  float l = clamp(lying, 0.0, 1.0);
  float slope = smoothstep(0.0, 0.85, n.y);
  float noise = 0.6 * vnoise(p * 2.5) + 0.4 * vnoise(p * 6.1 + vec2(3.7, 8.1));
  float patches = smoothstep(0.42, 0.5, l * (0.4 + 0.75 * slope) + (noise - 0.5) * 0.35);
  float dust = smoothstep(0.0, 0.4, l) * 0.35 * slope * (0.6 + 0.8 * noise);
  return (patches + dust * (1.0 - patches)) * smoothstep(-0.1, 0.15, n.y);
}

// How much fog colour to mix in, 0..1. distance 0 near .. 1 far; height 0 = ground or water .. 1 =
// top of the fog layer. Density falls off exponentially with height (exp(-4h)); optical depth grows
// faster than linearly with distance, so the distance fades first and the foreground stays clear.
float fogAmount(float fog, float distance, float height) {
  float dens = max(fog, 0.0) * exp(-4.0 * max(height, 0.0));
  float d = max(distance, 0.0);
  return 1.0 - exp(-dens * d * (1.0 + 4.0 * d));
}
`;
