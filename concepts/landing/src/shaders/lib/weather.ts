// Shared weather: rain and snow falling through the frame, rain on a window pane, ripples on wet
// ground or water, and fog. Compiled into every scene program after the sky library; the contract
// and conventions are in src/scenes/README.md.

export const weatherGlsl = `
// ---- weather ----

// One depth layer of rain streaks, q in screen heights. The layer is rotated by the wind's slant so
// rain falls along -y; columns of cells hold at most one streak each and slide down at the column's
// own speed, so every streak moves continuously and nothing pops or flashes between frames.
float weatherRainLayer(vec2 q, float t, float slant, float cols, float speed, float len, float width, float fill, float salt) {
  q = rotate(q, -slant);
  float cx = floor(q.x * cols);
  float hc = hash12(vec2(cx, salt));
  float rows = 1.0 / (len * 2.6);
  float y = (q.y + t * speed * (0.8 + 0.4 * hc)) * rows + hc * 17.0;
  float cy = floor(y);
  float h = hash12(vec2(cx * 1.31 + salt, cy));
  if (h >= fill) return 0.0;
  float h2 = hash12(vec2(cy + salt * 0.7, cx + 41.0));
  float xc = (cx + 0.25 + 0.5 * h2) / cols;
  float w = max(width, 1.6 / uRes.y); // never thinner than ~2 cells, or it shimmers through the dither
  float across = 1.0 - smoothstep(0.5 * w, w, abs(q.x - xc));
  float l = (0.65 + 0.35 * fract(h2 * 37.1)) / 2.6; // streak length as a fraction of its cell
  float s = (fract(y) - fract(h2 * 91.7) * (1.0 - l)) / l; // 0 at the head (bottom) .. 1 at the tail
  float along = smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.25, 1.0, s));
  return across * along * (0.6 + 0.4 * h / fill);
}

// Rain through the whole frame, 0..1 coverage: three depth layers, nearer ones longer, brighter,
// faster and more slanted. amount 0..1 sets the density; wind -1..1 slants it (positive: to the right).
float rainStreaks(vec2 uv, float aspect, float t, float amount, float wind) {
  if (amount <= 0.0) return 0.0;
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y);
  float tm = t * uMotion;
  float a = clamp(amount, 0.0, 1.0);
  float front = weatherRainLayer(q, tm, wind * 0.55, 9.0, 1.9, 0.16, 0.0036, 0.45 * a, 1.0);
  float middle = weatherRainLayer(q, tm, wind * 0.5, 21.0, 1.3, 0.085, 0.0022, 0.55 * a, 2.0) * 0.6;
  float back = weatherRainLayer(q, tm, wind * 0.45, 46.0, 0.85, 0.045, 0.0014, 0.65 * a, 3.0) * 0.35;
  return (1.0 - (1.0 - front) * (1.0 - middle) * (1.0 - back)) * (0.7 + 0.3 * a);
}

// One depth layer of snow, q in screen heights: cells hold at most one flake, columns fall at their
// own pace and drift with the wind, and each flake sways on its own slow sine. Flake, sway and jitter
// stay inside the cell, so flakes are never clipped by its border.
float weatherSnowLayer(vec2 q, float t, float cells, float fall, float drift, float radius, float soft, float fill, float salt) {
  q.x -= t * drift;
  float cx = floor(q.x * cells);
  float hc = hash12(vec2(cx, salt + 3.0));
  q.y += t * fall * (0.75 + 0.5 * hc) + hc * 9.0;
  vec2 g = q * cells;
  vec2 id = floor(g);
  float h = hash12(id + vec2(salt * 1.7, salt));
  if (h >= fill) return 0.0;
  float u = h / fill;
  float h2 = hash12(id.yx + vec2(salt + 5.0, 13.0));
  vec2 c = vec2(0.3 + 0.4 * h2, 0.3 + 0.4 * fract(h2 * 53.1));
  c.x += 0.15 * sin(t * (0.6 + 0.9 * u) + TAU * h2);
  float r = min(max(radius, 1.2 / uRes.y) * cells, 0.15) * (0.65 + 0.35 * fract(h2 * 17.3));
  return (1.0 - smoothstep(r * soft, r, length(g - id - c))) * (0.55 + 0.45 * u);
}

// Snow through the whole frame, 0..1 coverage: three layers, the nearest large, soft and quickest.
float snowFlakes(vec2 uv, float aspect, float t, float amount, float wind) {
  if (amount <= 0.0) return 0.0;
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y);
  float tm = t * uMotion;
  float a = clamp(amount, 0.0, 1.0);
  float front = weatherSnowLayer(q, tm, 6.0, 0.16, wind * 0.22, 0.022, 0.25, 0.3 * a, 1.0);
  float middle = weatherSnowLayer(q, tm, 14.0, 0.1, wind * 0.15, 0.01, 0.35, 0.5 * a, 2.0) * 0.8;
  float back = weatherSnowLayer(q, tm, 30.0, 0.06, wind * 0.1, 0.0045, 0.5, 0.6 * a, 3.0) * 0.55;
  return 1.0 - (1.0 - front) * (1.0 - middle) * (1.0 - back);
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

// How much fog colour to mix in, 0..1. distance 0 near .. 1 far; height 0 = ground or water .. 1 =
// top of the fog layer. Density falls off exponentially with height (exp(-4h)); optical depth grows
// faster than linearly with distance, so the distance fades first and the foreground stays clear.
float fogAmount(float fog, float distance, float height) {
  float dens = max(fog, 0.0) * exp(-4.0 * max(height, 0.0));
  float d = max(distance, 0.0);
  return 1.0 - exp(-dens * d * (1.0 + 4.0 * d));
}
`;
