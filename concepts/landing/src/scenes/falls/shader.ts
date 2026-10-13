// The waterfall scene: a cliff across the frame, a fall pouring from a notch in its lip into a
// plunge pool, seen level from the pool's edge. Sky, weather and fog come from src/shaders/lib.

export const fallsGlsl = `
// ---- falls ----
// Frame: q = ((uv.x - 0.5) * aspect, uv.y): x in screen heights from the centre, y the screen
// height. The cliff stands at the back of the pool; the camera stands level at the pool's edge,
// its eye at FALLS_EYE, looking straight at the rock.

const float FALLS_LIP = 0.79;   // where the water pours over: the floor of the notch in the lip
const float FALLS_POOL = 0.27;  // the waterline at the foot of the cliff
const float FALLS_EYE = 0.34;   // eye level: the camera's horizon line
const float FALLS_FOV = 0.9;    // vertical field of view, radians
const float FALLS_G = 0.34;     // gravity in screen heights / s^2: a big fall seen from afar is unhurried
const float FALLS_DEG = 57.29578;
const vec3 FALLS_MIST = vec3(0.86, 0.96, 1.0);
const vec3 FALLS_CYAN = vec3(0.5, 0.86, 0.92);

struct FallsLight {
  vec3 sun;     // toward the sun, camera frame
  vec3 moon;    // toward the moon, camera frame
  vec3 sunCol;  // direct sunlight (0 once set), dimmed by overcast
  vec3 moonCol; // direct moonlight
  vec3 amb;     // light from the whole sky
};

// The shared sky's sun crosses the sky ahead of its camera. This camera is turned half a turn
// about the vertical, so the sun is behind the viewer whenever it is up: it lights the cliff and
// the spray from the front, and its antisolar point (the rainbow's centre) lies ahead, below the
// horizon. The same map takes camera directions to sky directions and back.
vec3 fallsWorld(vec3 d) {
  return vec3(-d.x, d.y, -d.z);
}

// Light reaching a surface with normal n (camera frame): the sky, favouring upward faces, plus
// sun and moon.
vec3 fallsLit(FallsLight L, vec3 n) {
  return L.amb * (0.75 + 0.25 * n.y) + L.sunCol * max(dot(n, L.sun), 0.0) + L.moonCol * max(dot(n, L.moon), 0.0);
}

// Three octaves of value noise, 0..1, for the layers that do not need fbm's finest detail.
float fallsFbm3(vec2 p) {
  return (0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + vec2(17.1, 9.2)) + 0.125 * vnoise(p * 4.11 + vec2(4.3, 31.7))) / 0.875;
}

// ---- the falling water ----
// Free fall from the lip: water comes over at v0 and, having dropped d, moves at
// v = sqrt(v0^2 + 2 g d); it left the lip tau = (v - v0) / g seconds ago.
float fallsV0(float flow) {
  return 0.05 + 0.07 * flow;
}

float fallsTau(float d, float v0) {
  float v = sqrt(v0 * v0 + 2.0 * FALLS_G * max(d, 0.0));
  return (v - v0) / FALLS_G;
}

// Half-width of the sheet after dropping d: set by the flow, spreading a little as it falls.
float fallsHalfWidth(float d, float flow) {
  float fall = max(d, 0.0);
  return mix(0.02, 0.15, flow) * (1.0 + 0.3 * fall) + 0.015 * fall;
}

// Middle of the sheet after dropping d: a steady wind pushes the water aside by ~ a tau^2 / 2.
float fallsCentre(float d, float fx, float flow, float wind) {
  float tau = fallsTau(d, fallsV0(flow));
  return fx + wind * 0.03 * tau * tau;
}

// The falling sheet at q. Every pattern is painted in (u, e): u across the sheet, e = t - tau the
// moment that water came over the lip. A streak therefore rides with its water and stretches as it
// accelerates (parcels that left dt apart are v dt apart): short and slow at the lip, long fast
// ropes near the foot. Everything moves with the clock; nothing is re-randomised per frame.
// split (0..1) parts the flow around a horn of rock at the lip. Returns x coverage, y aeration
// (white water), z glassiness (the smooth tongue at the lip), w = u; sheen is a slow streak
// pattern for the sky reflected in the clear water.
vec4 fallsCurtain(vec2 q, float fx, float flow, float split, float wind, float tm, out float sheen) {
  sheen = 0.0;
  float d = FALLS_LIP - q.y;
  if (d < -0.012) return vec4(0.0);
  float v0 = fallsV0(flow);
  float tau = fallsTau(d, v0);
  float u = (q.x - fx - wind * 0.03 * tau * tau) / fallsHalfWidth(d, flow);
  if (abs(u) > 1.7) return vec4(0.0, 0.0, 0.0, u);
  float e = tm - tau;
  float ropes = mix(2.5, 11.0, flow);
  float streak = 0.62 * vnoise(vec2(u * ropes, e * 1.7)) + 0.38 * vnoise(vec2(u * ropes * 2.3 + 7.0, e * 3.4 + 2.0));
  sheen = vnoise(vec2(u * ropes * 0.8 + 3.0, e * 0.45));
  // Ragged edges, more so the further the water has fallen: they fray into spray.
  float fray = smoothstep(0.03, 0.45, d);
  float ragged = vnoise(vec2(u * 2.2 + 5.0, e * 2.2)) - 0.5;
  float alpha = smoothstep(0.0, 0.05 + 0.3 * fray, 1.0 - abs(u) + ragged * (0.1 + 0.8 * fray));
  // The water rounds over the lip.
  float bulge = 0.006 * sqrt(max(1.0 - u * u, 0.0));
  alpha *= smoothstep(-bulge - 0.002, -bulge + 0.002, d);
  // Parted by the horn: two streams that spread and close up lower down, a thin veil between.
  if (split > 0.0) {
    float gap = split * 0.8 * (1.0 - smoothstep(0.08, 0.42, d));
    alpha *= mix(0.2, 1.0, smoothstep(0.0, 0.06 + 0.2 * fray, abs(u) - gap + ragged * 0.3 * fray));
  }
  // A thin flow breaks into separate ropes; partings open and drift down with the water.
  float gaps = (1.0 - flow) * 0.85 * smoothstep(0.08, 0.45, d);
  alpha *= mix(1.0, smoothstep(0.2, 0.5, streak), gaps);
  float parting = smoothstep(0.62, 0.8, vnoise(vec2(u * 1.4 + 21.0, e * 0.3))) * smoothstep(0.04, 0.2, d);
  alpha *= 1.0 - clamp(parting * (0.55 - 0.45 * flow + 0.5 * split), 0.0, 0.9);
  // Air beaten in as it falls: clear at the lip, then white ropes, then whole sheets.
  float aeration = clamp(smoothstep(0.012, 0.26, d) * (0.75 + 0.45 * flow), 0.0, 1.0);
  float level = mix(0.95, 0.3 - 0.12 * flow, aeration);
  float white = smoothstep(level - 0.12, level + 0.1, streak);
  white = max(white, 0.8 * smoothstep(0.4, 0.66, vnoise(vec2(u * 2.0 + 3.0, e * 0.8 + 9.0))) * smoothstep(0.08, 0.35, d));
  return vec4(alpha, white, 1.0 - smoothstep(0.0, 0.07, d), u);
}

// The falling water's colour: clear dark water carrying streaks of reflected sky at the lip,
// white aerated water lower down, bluish in its own shade. The sheet bows toward the viewer, so
// its middle catches more light than its edges.
vec3 fallsWater(vec4 c, float sheen, FallsLight L, vec3 skyLight) {
  float bow = sqrt(max(1.0 - c.w * c.w, 0.0));
  vec3 lit = fallsLit(L, normalize(vec3(c.w * 0.45, 0.15, -1.0)));
  vec3 foam = mix(vec3(0.56, 0.72, 0.8), vec3(1.0), 0.4 + 0.6 * bow) * lit * 1.1;
  vec3 clear = mix(vec3(0.03, 0.075, 0.065), vec3(0.09, 0.17, 0.15), sheen) * lit + skyLight * smoothstep(0.55, 0.85, sheen) * (0.12 + 0.38 * c.z);
  return mix(clear, foam, c.y);
}

// White water lying on the pool or boiling up at the plunge; shade 0..1 from hollows to tops.
vec3 fallsFoam(FallsLight L, float shade) {
  return mix(vec3(0.55, 0.7, 0.76), vec3(0.98, 1.0, 1.0), shade) * (L.amb * 1.2 + L.sunCol * 0.8 + L.moonCol * 0.7);
}

// The plunge: a low dome of churning white water where the sheet hits the pool, wider than the
// sheet, boiling up (two noise layers scrolled upward at different speeds), flatter in front.
// Returns coverage and shade.
vec2 fallsChurn(vec2 q, float cx, float wb, float flow, float tm) {
  vec2 c = vec2((q.x - cx) / (wb * 1.3 + 0.03), (q.y - FALLS_POOL) / (0.03 + 0.05 * flow));
  if (abs(c.x) > 1.7 || c.y > 1.7 || c.y < -0.8) return vec2(0.0);
  float dome = 1.0 - length(vec2(c.x, c.y > 0.0 ? c.y : c.y * 2.6));
  float boil = 0.6 * vnoise(vec2(c.x * 2.6, c.y * 2.2 - tm * 1.6)) + 0.4 * vnoise(vec2(c.x * 5.4 + 3.0, c.y * 4.6 - tm * 2.6));
  return vec2(smoothstep(-0.05, 0.3, dome + (boil - 0.5) * 0.8), clamp(0.35 + 0.5 * dome + 0.5 * (boil - 0.5), 0.0, 1.0));
}

// Spray in the air at q: a plume boiling up from the plunge, widening as it rises and leaning
// downwind, its puffs (two fbm layers advected up and along the wind) rising and drifting; a
// thinner haze spreads toward the viewer over the pool and hangs low across the valley floor.
float fallsMist(vec2 q, float cx, float wb, float flow, float amount, float wind, float tm) {
  float h = q.y - FALLS_POOL;
  float rise = max(h, 0.0);
  float dx = q.x - cx - wind * (0.25 * rise + 0.9 * rise * rise);
  float spread = wb + 0.04 + 0.45 * rise + 0.9 * max(-h, 0.0);
  float reach = (0.05 + 0.3 * amount) * (0.5 + 0.7 * flow);
  float plume = (0.25 + amount) * (0.4 + 0.8 * flow) * exp(-dx * dx / (spread * spread)) * exp(-rise / reach) * exp(min(h, 0.0) / 0.1);
  float valley = amount * 0.3 * exp(-abs(h) / (0.05 + 0.08 * amount));
  if (plume + valley < 0.004) return 0.0;
  vec2 p = vec2(q.x * 3.4 - tm * 0.05 * wind, q.y * 3.4 - tm * 0.075);
  float puffs = smoothstep(0.25, 0.85, 0.5 * fallsFbm3(p) + 0.6 * fallsFbm3(p * 0.5 + vec2(5.2, 1.3 - tm * 0.02)));
  return plume * (0.35 + 1.1 * puffs) + valley * (0.4 + 0.9 * puffs);
}

float fallsLobe(float k, float c, float w) {
  float z = (k - c) / w;
  return max(1.0 - z * z, 0.0);
}

// The rainbow's colours across one band, k = 0 violet to 1 red: overlapping lobes shaped roughly
// like the CIE 1931 colour-matching functions (red's small second lobe in the violet included).
vec3 fallsSpectrum(float k) {
  vec3 c = vec3(fallsLobe(k, 0.8, 0.3) + 0.3 * fallsLobe(k, 0.06, 0.12), fallsLobe(k, 0.52, 0.26), fallsLobe(k, 0.18, 0.24));
  return c * smoothstep(-0.12, 0.04, k) * smoothstep(1.12, 0.96, k);
}

// ---- the cliff ----

// The cliff's skyline: a ragged lip, notched where the river pours over; horn (0..1) raises a
// knob of rock in the middle of the notch that splits the flow.
float fallsRim(float x, float fx, float horn) {
  float rim = 0.848 + 0.06 * (fallsFbm3(vec2(x * 1.7, 3.0)) - 0.5) + 0.008 * (vnoise(vec2(x * 16.0, 5.0)) - 0.5);
  float across = abs(x - fx);
  float notch = 1.0 - smoothstep(0.17, 0.25, across);
  return mix(rim, FALLS_LIP + horn * 0.035 * exp(-across * across / 0.0008), notch);
}

// Tree crowns along a skyline, height above its base at x: one tree per cell of width size, a
// rounded broadleaf crown or now and then a conifer's spire. Crowns stay within reach of the
// three cells looked at, so none is ever cut off.
float fallsCrowns(float x, float size, float seed) {
  float c = floor(x / size);
  float h = 0.0;
  for (int k = -1; k <= 1; k++) {
    float id = c + float(k);
    float r = size * (0.5 + 0.5 * hash12(vec2(id, seed)));
    float dx = abs(x - (id + 0.5 + (hash12(vec2(id, seed + 1.0)) - 0.5) * 0.6) * size);
    float crown = hash12(vec2(id, seed + 2.0)) < 0.3 ? max(2.2 * r - dx * 4.5, 0.0) : sqrt(max(r * r - dx * dx, 0.0));
    h = max(h, crown);
  }
  return h;
}

// Strata coordinate: horizontal beds, undulating (fbm) and dipping slightly; one bed per unit.
float fallsStrata(vec2 q) {
  return q.y * 16.0 + 3.0 * fbm(vec2(q.x * 1.3, q.y * 0.8) + 3.7) + 0.4 * q.x;
}

// Each bed's stone: mostly dark basalt, some paler tuff and rusty, iron-stained beds.
vec3 fallsStone(float band) {
  float kind = hash12(vec2(band, 5.3));
  vec3 stone = kind < 0.45 ? vec3(0.23, 0.23, 0.24) : kind < 0.7 ? vec3(0.36, 0.33, 0.29) : kind < 0.88 ? vec3(0.37, 0.27, 0.21) : vec3(0.17, 0.17, 0.19);
  return stone * (0.85 + 0.3 * hash12(vec2(band, 6.1)));
}

// The cliff face at q (s = fallsStrata(q)). Beds stand out or recede in turn: a bed proud of the
// one above has a shelf along its top (moss, ferns), one proud of the one below shows its dark
// underside, and an overhang shades the bed beneath it. Joints split the beds and a few long
// fissures wander across them. wet (spray, seeps, rain) darkens the stone and makes it glisten;
// glint reports the sparkle for the dither's shimmer.
vec3 fallsRock(vec2 q, float s, vec3 ray, FallsLight L, float wet, float green, float tm, out float glint) {
  float band = floor(s);
  float f = fract(s);
  float here = hash12(vec2(band, 3.1));
  float above = hash12(vec2(band + 1.0, 3.1));
  float ledge = smoothstep(0.1, 0.3, here - above);
  float overhang = smoothstep(0.1, 0.3, above - here);
  float jut = smoothstep(0.1, 0.3, here - hash12(vec2(band - 1.0, 3.1)));
  float shelf = smoothstep(0.86 - 0.12 * ledge, 0.92, f) * ledge;
  float shadowed = smoothstep(0.62, 1.0, f) * overhang;
  float soffit = (1.0 - smoothstep(0.0, 0.14, f)) * jut;

  // Fine bedding and a rough surface for the light to play on; beds round off top and bottom.
  float g1 = vnoise(q * vec2(45.0, 110.0));
  float g2 = vnoise(q * vec2(120.0, 120.0) + 7.0);
  vec3 n = normalize(vec3((g2 - 0.5) * 0.7, (f - 0.5) * 0.8 + (g1 - 0.5) * 0.5, -1.0));
  n = normalize(mix(n, vec3(0.0, 0.92, -0.4), shelf));
  n = normalize(mix(n, vec3(0.0, -0.9, -0.45), soffit));

  // Vertical joints, their spacing and offset set per bed; long fissures across the beds.
  float spacing = 4.0 + 8.0 * hash12(vec2(band, 7.7));
  float jx = q.x * spacing + 9.0 * hash12(vec2(band, 8.8)) + 0.35 * (vnoise(vec2(q.x * 25.0, s * 2.0)) - 0.5);
  float joint = (1.0 - smoothstep(0.0012, 0.0032, abs(fract(jx + 0.5) - 0.5) / spacing)) * step(0.35, hash12(vec2(band, 9.9))) * smoothstep(0.02, 0.12, f) * (1.0 - shelf);
  float crack = (1.0 - smoothstep(0.006, 0.016, abs(fallsFbm3(vec2(q.x * 3.4, q.y * 1.1) + 11.0) - 0.5))) * smoothstep(0.55, 0.7, vnoise(q * vec2(1.8, 0.8) + 40.0));

  // Moss: cushions on the shelves spilling raggedly over their edges, and patches on the face
  // where the spray keeps it wet.
  float patchy = fallsFbm3(q * vec2(10.0, 16.0) + 2.0);
  float drape = ledge * smoothstep(0.66, 0.8, f + 0.14 * (vnoise(vec2(q.x * 80.0, band)) - 0.5));
  float onShelf = max(shelf, drape) * smoothstep(0.62 - 0.45 * green, 0.78 - 0.45 * green, patchy);
  float onFace = smoothstep(0.78, 0.92, patchy + 0.25 * wet + 0.15 * green) * (1.0 - joint);
  float moss = clamp(max(onShelf, onFace), 0.0, 1.0) * smoothstep(0.0, 0.15, green);
  vec3 mossCol = mix(vec3(0.1, 0.24, 0.06), vec3(0.34, 0.52, 0.13), patchy);

  vec3 stone = fallsStone(band) * (0.72 + 0.45 * g1) * mix(1.0, 0.5, wet);
  vec3 albedo = mix(stone, mossCol * mix(1.0, 0.8, wet), moss);
  float occlusion = (1.0 - 0.7 * shadowed) * (1.0 - 0.75 * joint) * (1.0 - 0.7 * crack);
  vec3 col = albedo * fallsLit(L, n) * occlusion;

  // Wet stone glistens: facets flash where they mirror the sun or moon, the sky lies in a faint
  // sheen over it, and films of water slide down it catching the light.
  vec3 r = reflect(ray, n);
  float flashSun = pow(max(dot(r, L.sun), 0.0), 36.0);
  float flashMoon = pow(max(dot(r, L.moon), 0.0), 36.0);
  float film = smoothstep(0.66, 0.92, vnoise(vec2(q.x * 80.0, q.y * 7.0 + tm * 1.1))) * wet;
  float bare = 1.0 - moss;
  vec3 skyLight = L.amb * 1.5 + L.sunCol * 0.3 + L.moonCol * 0.35;
  col += (L.sunCol * flashSun + L.moonCol * flashMoon) * 1.5 * wet * bare * occlusion;
  col += skyLight * (0.06 * wet + 0.35 * film) * (1.0 - 0.7 * moss);
  glint = wet * bare * (flashSun + 0.5 * flashMoon + 0.6 * film) * occlusion;
  return col;
}

// One fern frond from its root (rel = point - root): the spine is a parabola that rises by lift
// and droops by droop (in frond lengths), bent back up by bend toward the tip; leaflets comb along
// it, shrinking toward the tip. u reports how far along the frond the point is.
float fallsFrond(vec2 rel, float side, float len, float lift, float droop, float bend, out float u) {
  u = rel.x * side / len;
  if (u < 0.0 || u > 1.0) return 0.0;
  float spine = len * (lift * u - (droop - bend) * u * u);
  float slope = lift - 2.0 * (droop - bend) * u;
  float dist = abs(rel.y - spine) / sqrt(1.0 + slope * slope);
  float width = len * 0.17 * (1.0 - u) * (0.3 + 0.7 * abs(sin(u * 23.0))) + 0.0011;
  return smoothstep(width, width * 0.5, dist);
}

// Ferns and creepers hanging from the shelves: a clump of fronds here and there along a shelf's
// edge, arching out and drooping over the face below, and curtains of creeper strands hanging
// straight down. Both sway with the wind and the fall's draught (sway: how far the frond tips
// swing, in frond lengths). Looks at the shelves topping this bed and the next, three clumps along
// each. Returns coverage; tip is how far along the frond (tips are younger and paler).
float fallsFerns(vec2 q, float s, float green, float sway, float tm, out float tip) {
  tip = 0.0;
  float cover = 0.0;
  for (int lv = 0; lv < 2; lv++) {
    float band = floor(s) + float(lv);
    // Ferns need a shelf: this bed standing proud of the one above.
    if (hash12(vec2(band, 3.1)) - hash12(vec2(band + 1.0, 3.1)) < 0.12) continue;
    float shelfY = q.y + (band + 0.92 - s) / 16.0;
    float c = floor(q.x / 0.1);
    for (int k = -1; k <= 1; k++) {
      float id = c + float(k);
      vec2 key = vec2(id, band * 1.37);
      if (hash12(key) > green * 0.9) continue;
      vec2 root = vec2((id + 0.5 + (hash12(key + 1.7) - 0.5) * 0.7) * 0.1, shelfY);
      float reach = 0.035 + 0.035 * hash12(key + 2.9);
      float swing = sway * sin(tm * 0.7 + id * 1.9 + band);
      for (int j = 0; j < 3; j++) {
        float fj = float(j);
        float side = j == 1 ? 1.0 : -1.0;
        if (j == 2) side = hash12(key + 4.1) < 0.5 ? -1.0 : 1.0;
        float u = 0.0;
        float frond = fallsFrond(q - root, side, reach * (1.0 - 0.25 * fj), 0.35 - 0.15 * fj, 1.2 + 0.5 * fj, swing * side, u);
        if (frond > cover) {
          cover = frond;
          tip = u;
        }
      }
    }
    // Creepers: strands hanging from the shelf directly above, swinging together.
    if (lv == 0) {
      float hang = shelfY - q.y;
      float vx = q.x * 60.0 + sin(tm * 0.6 + band * 2.0) * hang * 25.0 * sway;
      float strand = floor(vx);
      float len = (0.015 + 0.06 * hash12(vec2(strand, band + 0.71))) * green;
      if (hash12(vec2(strand, band + 0.37)) < green * 0.5 * smoothstep(0.45, 0.7, vnoise(vec2(strand * 0.12, band))) && hang > 0.0 && hang < len) {
        float width = 0.08 + 0.18 * (1.0 - hang / len);
        cover = max(cover, smoothstep(width, width * 0.5, abs(fract(vx) - 0.5)));
      }
    }
  }
  return cover;
}

// The Manifold M cut into the rock, centred at 'at', size its height. x: groove coverage (a
// chiselled, slightly wavering edge); y: light on the groove's floor (the upper wall shades the
// floor below it, the light coming from above); z: the lower wall, facing up into the light.
vec3 fallsMark(vec2 q, vec2 at, float size) {
  vec2 m = (q - at) / size;
  if (abs(m.x) > 0.7 || abs(m.y) > 0.7) return vec3(0.0);
  float d = markDistance(m) - 0.085 + (vnoise(m * 24.0) - 0.5) * 0.02;
  float groove = smoothstep(0.012, -0.004, d);
  float lit = smoothstep(0.01, -0.02, markDistance(m + vec2(0.01, 0.07)) - 0.085);
  float wall = smoothstep(-0.01, 0.01, markDistance(m - vec2(0.0, 0.035)) - 0.085);
  return vec3(groove, lit, wall * groove);
}

// What the pool mirrors at q (a point on the cliff above the waterline): the stone, the falling
// water and the plunge, done cheaply (no ferns, cracks or carving): the ripples smear it anyway.
vec3 fallsMirror(vec2 q, FallsLight L, vec3 skyLight, float fx, float flow, float green, float split, float wind, float tm) {
  float s = fallsStrata(q);
  float band = floor(s);
  float f = fract(s);
  float d = FALLS_LIP - q.y;
  float beside = abs(q.x - fallsCentre(d, fx, flow, wind)) - fallsHalfWidth(d, flow);
  float wet = max(exp(-max(beside, 0.0) / (0.04 + 0.08 * flow)), smoothstep(FALLS_POOL + 0.035, FALLS_POOL, q.y));
  vec3 n = normalize(vec3(0.0, (f - 0.5) * 0.8, -1.0));
  vec3 col = fallsStone(band) * (0.72 + 0.45 * vnoise(q * vec2(45.0, 110.0))) * mix(1.0, 0.5, wet) * fallsLit(L, n);
  float shelf = smoothstep(0.86, 0.92, f) * smoothstep(0.1, 0.3, hash12(vec2(band, 3.1)) - hash12(vec2(band + 1.0, 3.1)));
  col = mix(col, vec3(0.2, 0.36, 0.1) * fallsLit(L, vec3(0.0, 0.92, -0.4)), shelf * smoothstep(0.0, 0.15, green) * 0.8);
  float sheen = 0.0;
  vec4 sheet = fallsCurtain(q, fx, flow, split, wind, tm, sheen);
  if (sheet.x > 0.0) col = mix(col, fallsWater(sheet, sheen, L, skyLight), sheet.x);
  float drop = FALLS_LIP - FALLS_POOL;
  vec2 churn = fallsChurn(q, fallsCentre(drop, fx, flow, wind), fallsHalfWidth(drop, flow), flow, tm);
  return mix(col, fallsFoam(L, churn.y), churn.x);
}

// Fireflies over the pool: each drifts on its own slow loop at its own height over the water and
// flashes now and then; its reflection lies straight below it, as far under the surface as it is
// above. Perspective sizes them: nearer flies, lower on the screen, are larger.
float fallsFireflies(vec2 q, float aspect, float tm, float count) {
  float glow = 0.0;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    if (fi >= count) break;
    float hx = hash12(vec2(fi, 71.0));
    float hy = hash12(vec2(fi, 72.0));
    float hz = hash12(vec2(fi, 73.0));
    float ground = 0.04 + 0.21 * hy;
    float scale = (FALLS_EYE - ground) / (FALLS_EYE - 0.1);
    float x = (hx - 0.5) * aspect * 0.9 + 0.06 * scale * sin(tm * (0.11 + 0.08 * hz) + fi * 2.3);
    float alt = scale * (0.03 + 0.07 * hz) * (1.0 + 0.25 * sin(tm * 0.23 + fi * 4.1));
    float pulse = pow(max(sin(tm * (0.5 + 0.4 * hx) + fi * 1.7), 0.0), 5.0);
    float r = 0.0035 * scale + 0.001;
    float up = length(q - vec2(x, ground + alt));
    float down = length((q - vec2(x, ground - alt)) * vec2(1.0, 0.6));
    glow += pulse * (smoothstep(r, r * 0.4, up) + 0.35 * exp(-up / (r * 3.5)) + 0.45 * smoothstep(r * 1.2, r * 0.3, down) + 0.12 * exp(-down / (r * 3.0)));
  }
  return glow;
}

// Ferns on the near bank: up to four clumps toward the corners (more with more greenery), fronds
// rising and arching over. Returns coverage; tip as for fallsFerns.
float fallsBankFerns(vec2 q, float aspect, float green, float sway, float tm, out float tip) {
  tip = 0.0;
  float cover = 0.0;
  for (int c = 0; c < 4; c++) {
    float fc = float(c);
    if ((fc + 1.0) * 0.22 > green + 0.12) break;
    float side = mod(fc, 2.0) < 0.5 ? -1.0 : 1.0;
    float inward = floor(fc * 0.5);
    vec2 root = vec2(side * (0.47 * aspect - 0.04 - 0.2 * inward - 0.06 * hash12(vec2(fc, 81.0))), 0.07 + 0.08 * (1.0 - inward));
    for (int j = 0; j < 5; j++) {
      float fj = float(j);
      float h = hash12(vec2(fc * 7.0 + fj, 83.0));
      float u = 0.0;
      float frond = fallsFrond(q - root, mod(fj, 2.0) < 0.5 ? -1.0 : 1.0, (0.07 + 0.08 * h) * (1.0 - 0.3 * inward), 1.4 + 1.4 * h, 1.3 + 0.8 * fract(h * 7.3), sway * sin(tm * 0.8 + fc * 2.1 + fj), u);
      if (frond > cover) {
        cover = frond;
        tip = u;
      }
    }
  }
  return cover;
}

// Waterfall knobs: K_flow, K_mist, K_rainbow, K_greenery, K_fireflies, K_time, K_cycle, K_rain,
// K_fog, K_wind, K_mark.
Shade sceneFalls(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y);
  float flow = K_flow;
  float mistAmount = K_mist;
  float green = K_greenery;
  float rain = K_rain;
  float wind = K_wind;
  float mark = K_mark;
  // The fall stands a little right of centre on wide screens.
  float fx = 0.09 * min(aspect, 2.0);
  float drop = FALLS_LIP - FALLS_POOL;
  float footX = fallsCentre(drop, fx, flow, wind);
  float footW = fallsHalfWidth(drop, flow);
  Shade o = blankShade();

  // Light, from the shared sky seen facing away from the sun (fallsWorld).
  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  vec3 rayCam = viewRay(uv, aspect, FALLS_EYE, FALLS_FOV);
  vec3 ray = fallsWorld(rayCam);
  float overcast = clamp(rain * 0.75, 0.0, 0.85);
  FallsLight L;
  L.sun = fallsWorld(sky.sun);
  L.moon = fallsWorld(sky.moon);
  L.sunCol = sky.sunColor * (1.0 - overcast);
  L.moonCol = sky.moonColor * (1.0 - overcast);
  L.amb = sky.ambient * (1.0 - 0.3 * overcast);
  // What a glassy surface shows of the sky, and the haze on the horizon (fog, distance).
  vec3 skyLight = L.amb * 1.5 + L.sunCol * 0.3 + L.moonCol * 0.35;
  vec3 haze = skyColor(sky, fallsWorld(normalize(vec3(rayCam.x, 0.04, 1.0))));
  haze = mix(haze, vec3(dot(haze, LUMA)), 0.6 * overcast);

  // Parallax: nearer layers slide further as the pointer moves.
  vec2 qc = q - uPointer * vec2(0.006, 0.003);  // cliff, fall, pool and spray
  vec2 qt = q - uPointer * vec2(0.003, 0.0015); // the woods upstream, through the notch
  vec2 qb = q - uPointer * vec2(0.02, 0.008);   // the near bank

  vec3 col = vec3(0.0);
  float fogDist = 0.55;
  float glint = 0.0;       // wet sparkle, for the shimmer
  float white = 0.0;       // white water here, for the shimmer
  float spray = 0.0;       // spray thrown off the sheet, for the shimmer
  float markAccent = 0.0;
  float rim = fallsRim(qc.x, fx, mark);
  if (qc.y > rim) {
    // Above the cliff: trees along its top, the woods upstream through the notch, then the sky.
    float notch = 1.0 - smoothstep(0.17, 0.25, abs(qc.x - fx));
    float lean = (0.002 + 0.004 * abs(wind)) * sin(tm * 0.5 + qc.x * 3.0);
    float trees = rim + (0.003 + fallsCrowns(qc.x - lean, 0.045, 1.0)) * (1.0 - notch);
    float woods = FALLS_LIP + 0.028 + 0.02 * fallsFbm3(vec2(qt.x * 2.5, 8.0)) + 0.8 * fallsCrowns(qt.x, 0.02, 7.0);
    if (qc.y < trees) {
      float clump = 0.6 * vnoise(qc * vec2(60.0, 70.0)) + 0.4 * vnoise(qc * vec2(150.0, 160.0));
      float up = clamp((qc.y - rim) / 0.07, 0.0, 1.0);
      vec3 leaf = mix(vec3(0.04, 0.1, 0.05), vec3(0.15, 0.29, 0.11), clump);
      col = leaf * fallsLit(L, normalize(vec3(clump - 0.5, 0.2 + 0.6 * up, -1.0))) * (0.55 + 0.6 * up);
      fogDist = 0.6;
    } else if (qc.y < woods) {
      float clump = vnoise(qt * vec2(90.0, 100.0));
      vec3 leaf = mix(vec3(0.05, 0.11, 0.07), vec3(0.13, 0.22, 0.12), clump);
      col = mix(leaf * fallsLit(L, vec3(0.0, 0.5, -0.866)), haze, 0.45);
      fogDist = 0.85;
    } else {
      col = skyColor(sky, ray) + vec3(0.85, 0.9, 1.0) * skyStars(sky, ray, 0.45);
      // The library's wind blows along its own x, which this half-turned view sees reversed.
      vec4 cloud = skyClouds(sky, ray, t, 0.3 + 0.6 * rain, -wind);
      col = mix(col, cloud.rgb, cloud.a);
      fogDist = 1.0;
    }
  } else if (qc.y > FALLS_POOL) {
    // The cliff face.
    float s = fallsStrata(qc);
    float d = FALLS_LIP - qc.y;
    float beside = abs(qc.x - fallsCentre(d, fx, flow, wind)) - fallsHalfWidth(d, flow);
    // Spray soaks the rock beside the fall, widest near the foot; the pool wets the base; rain
    // wets it all.
    float foot = smoothstep(FALLS_POOL + 0.3, FALLS_POOL, qc.y);
    float wet = exp(-max(beside, 0.0) / (0.02 + 0.05 * flow + 0.14 * foot * mistAmount)) * smoothstep(-0.04, 0.0, d);
    wet = max(max(wet, smoothstep(FALLS_POOL + 0.035, FALLS_POOL, qc.y)), 0.6 * rain);
    // The sheet is thrown clear of the rock (it leaves the lip at v0) and shades it from the sun
    // behind the viewer: step toward the sun as far as the sheet's plane and look there.
    float v0 = fallsV0(flow);
    vec2 toward = qc + L.sun.xy * ((v0 * fallsTau(d, v0) + 0.008) / max(-L.sun.z, 0.25));
    float td = FALLS_LIP - toward.y;
    float shade = smoothstep(1.05, 0.7, abs(toward.x - fallsCentre(td, fx, flow, wind)) / fallsHalfWidth(td, flow)) * step(0.0, td);
    FallsLight Lr = L;
    Lr.sunCol *= 1.0 - shade * (0.5 + 0.4 * flow);
    Lr.amb *= 1.0 - 0.35 * smoothstep(0.0, -0.02, beside) * step(0.0, d);
    col = fallsRock(qc, s, rayCam, Lr, wet, green, tm, glint);
    if (green > 0.0) {
      // The fall's draught stirs the ferns beside it.
      float draught = exp(-max(beside, 0.0) / 0.08) * (0.3 + 0.7 * flow);
      float tip = 0.0;
      float fern = fallsFerns(qc, s, green, 0.06 + 0.2 * abs(wind) + 0.12 * draught, tm, tip);
      if (fern > 0.0) {
        vec3 frond = mix(vec3(0.06, 0.17, 0.05), vec3(0.3, 0.5, 0.15), 0.3 + 0.55 * tip);
        col = mix(col, frond * fallsLit(Lr, normalize(vec3(0.0, 0.4, -1.0))), fern);
        glint *= 1.0 - fern;
      }
    }
    if (mark > 0.0) {
      // The carved M: its smooth wet floor holds the mist's light, its lower walls catch the sky.
      vec3 mk = fallsMark(qc, vec2(fx, FALLS_LIP - 0.215), 0.15);
      if (mk.x > 0.0) {
        vec3 held = FALLS_CYAN * (L.amb * 1.5 + L.sunCol * 0.3 + L.moonCol * 0.5);
        col = mix(col, col * mix(0.35, 0.75, mk.y) + held * (0.12 + 0.3 * mk.y + 0.35 * mk.z), mk.x);
        markAccent = mk.x * (0.5 + 0.35 * mk.y + 0.15 * mk.z);
      }
    }
    fogDist = 0.55;
  } else {
    // The plunge pool: a level plane with the camera one unit (its own height) above it. Depth
    // along the view and distance across put the ripples and foam in perspective.
    float focal = 0.5 / tan(0.5 * FALLS_FOV);
    float depth = focal / max(FALLS_EYE - qc.y, 0.01);
    float back = focal / (FALLS_EYE - FALLS_POOL);
    vec2 P = vec2(qc.x * depth / focal, depth);
    vec2 rel = P - vec2(footX * back / focal, back - 0.6);
    float r = length(rel);
    // Toward the far edge the plane is squeezed into a few cells: there the surface detail fades
    // to a still mirror (as distant water looks at a grazing angle) instead of crawling. detail
    // follows the on-screen size of one ring wavelength.
    float detail = smoothstep(0.004, 0.012, focal * 1.14 / (depth * depth));
    // Rings running out from the plunge.
    float phase = r * 5.5 - tm * 2.4;
    float rings = exp(-r * 0.2) * (0.3 + 0.7 * flow) * detail;
    vec2 slope = rel / max(r, 0.001) * cos(phase) * rings;
    // Wind ruffles, and rain.
    vec2 wp = P * vec2(1.4, 0.8) + vec2(tm * 0.3 * wind, tm * 0.12);
    slope += (vec2(vnoise(wp), vnoise(wp + 17.0)) - 0.5) * (0.2 + 0.7 * abs(wind)) * detail;
    // Raindrop rings are smaller (radius ~0.36 here), so they give way sooner.
    vec3 drops = rainRipples(P * 2.5, t, rain) * smoothstep(0.004, 0.012, focal * 0.36 / (depth * depth));
    slope += drops.xy;
    // The mirror image: a vertical cliff at the pool's far edge reflects about the waterline
    // exactly; the tilted surface smears it, mostly up and down.
    vec2 mq = vec2(qc.x + slope.x * 0.012, 2.0 * FALLS_POOL - qc.y + slope.y * 0.03);
    vec3 mirror = fallsMirror(mq, L, skyLight, fx, flow, green, mark, wind, tm);
    // Schlick's Fresnel: a mirror at grazing angles far off, dark water underfoot.
    float cosI = clamp(-rayCam.y + slope.y * 0.03, 0.02, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);
    float aerated = exp(-r * 0.35) * (0.35 + 0.65 * flow);
    vec3 body = mix(vec3(0.012, 0.035, 0.035), vec3(0.08, 0.27, 0.26), aerated) * (L.amb * 1.3 + L.sunCol * 0.45 + L.moonCol * 0.4);
    col = mix(body, mirror * 0.92, fresnel);
    float crest = smoothstep(0.75, 1.0, sin(phase)) * rings;
    col += skyLight * (crest * 0.12 + drops.z * 0.35);
    glint = crest * 0.3 + drops.z * 0.5;
    // Foam rafts carried out from the plunge, stretching sideways as they spread.
    float ang = atan(rel.x, -rel.y);
    vec2 fp = vec2(ang * 2.8, r * 0.7 - tm * 0.2);
    float raft = smoothstep(0.52, 0.74, 0.65 * vnoise(fp) + 0.35 * mix(0.5, vnoise(fp * 2.1 + 5.0), detail) + 0.3 * exp(-r * 0.5)) * exp(-r * 0.12) * (0.3 + 0.7 * flow);
    col = mix(col, fallsFoam(L, 0.7), raft * 0.85);
    white = raft * 0.6;
    fogDist = mix(0.1, 0.5, clamp((depth - focal / FALLS_EYE) / (back - focal / FALLS_EYE), 0.0, 1.0));
  }

  // The falling water, over the rock.
  if (qc.y > FALLS_POOL && qc.y < FALLS_LIP + 0.012) {
    float sheen = 0.0;
    vec4 sheet = fallsCurtain(qc, fx, flow, mark, wind, tm, sheen);
    if (sheet.x > 0.0) {
      vec3 water = fallsWater(sheet, sheen, L, skyLight);
      // Where it curves over the lip the water mirrors the sky in one bright line.
      water += skyLight * 0.6 * exp(-abs(FALLS_LIP - qc.y + 0.002) / 0.004) * max(1.0 - sheet.w * sheet.w, 0.0);
      col = mix(col, water, sheet.x);
      white = sheet.x * sheet.y;
      glint *= 1.0 - sheet.x;
      markAccent *= 1.0 - 0.85 * sheet.x;
      fogDist = 0.55;
    }
  }

  // The plunge.
  vec2 churn = fallsChurn(qc, footX, footW, flow, tm);
  if (churn.x > 0.0) {
    col = mix(col, fallsFoam(L, churn.y), churn.x);
    white = max(white, churn.x);
    glint *= 1.0 - churn.x;
  }

  col = mix(col, haze, fogAmount(K_fog, fogDist, clamp((qc.y - FALLS_POOL) / 0.6, 0.0, 1.0)));

  // Spray: the plume from the plunge, and spray hugging the lower sheet and its frayed edges.
  float density = fallsMist(qc, footX, footW, flow, mistAmount, wind, tm);
  float fallen = FALLS_LIP - qc.y;
  if (fallen > 0.1 && qc.y > FALLS_POOL - 0.03) {
    float off = abs(qc.x - fallsCentre(fallen, fx, flow, wind)) - fallsHalfWidth(fallen, flow);
    spray = exp(-max(off, 0.0) / (0.015 + 0.03 * flow)) * smoothstep(0.12, 0.5, fallen) * (0.12 + 0.3 * flow);
    density += spray;
  }
  spray = clamp(spray + 0.5 * churn.x, 0.0, 1.0);
  float mistAccent = 0.0;
  float mistA = (1.0 - exp(-density * 2.2)) * 0.92;
  if (mistA > 0.002) {
    // Lit from the front by the sun or moon behind the viewer, and by the whole sky.
    vec3 mistCol = FALLS_MIST * (L.amb * 1.25 + L.sunCol * 0.55 + L.moonCol * 0.6);
    float under = clamp(dot(col, LUMA), 0.0, 1.0);
    col = mix(col, mistCol, mistA);
    mistAccent = mistA * 0.6 * (1.0 - 0.7 * under);
  }

  // The rainbow, wherever spray hangs in sunlight. Light refracted into a drop, reflected once
  // inside and refracted out leaves it at most ~42 degrees from the antisolar point (Descartes'
  // minimum deviation: red outermost at 42.3, violet at 40.6); reflected twice it makes the
  // fainter secondary bow at 50.4-53.6 with the colours reversed. Between the two the sky is
  // darker (Alexander's band), inside the primary brighter.
  if (K_rainbow > 0.0 && density > 0.0) {
    float ang = acos(clamp(dot(rayCam, -L.sun), -1.0, 1.0)) * FALLS_DEG;
    vec3 bow = fallsSpectrum((ang - 40.6) / 1.8) + 0.4 * fallsSpectrum((53.6 - ang) / 3.2);
    float bowLit = K_rainbow * (1.0 - exp(-density * 1.6)) * smoothstep(0.0, 0.15, -L.sun.z);
    float alexander = smoothstep(42.2, 43.2, ang) * smoothstep(50.6, 49.6, ang);
    col = col * (1.0 - bowLit * (0.3 * max(bow.r, max(bow.g, bow.b)) + 0.12 * alexander)) + (bow * 0.6 + 0.08 * smoothstep(41.0, 30.0, ang)) * L.sunCol * bowLit;
  }

  // Fireflies, from dusk on.
  float dusk = clamp(sky.night + 0.8 * sky.twilight, 0.0, 1.0) * (1.0 - 0.7 * rain);
  if (K_fireflies > 0.0 && dusk > 0.0) {
    col += vec3(0.78, 1.0, 0.38) * fallsFireflies(q - uPointer * vec2(0.01, 0.005), aspect, tm, 4.0 + 10.0 * K_fireflies) * dusk;
  }

  // The near bank: dark boulders and ferns along the bottom of the frame.
  float bankTop = -1.0;
  if (qb.y < 0.3) {
    float edgeness = smoothstep(0.15, 1.0, abs(qb.x) / max(0.5 * aspect, 0.3));
    bankTop = 0.018 + 0.025 * fallsFbm3(vec2(qb.x * 4.0, 2.0)) + 0.1 * edgeness * edgeness + fallsCrowns(qb.x + 0.37, 0.11, 13.0) * (0.12 + 0.5 * edgeness);
  }
  float tip = 0.0;
  float fern = 0.0;
  // The bank's ferns grow toward the corners: skip the loop in the open middle.
  if (green > 0.0 && qb.y < 0.45 && abs(qb.x) > 0.47 * aspect - 0.45) fern = fallsBankFerns(qb, aspect, green, 0.04 + 0.12 * abs(wind), tm, tip);
  float front = max(step(qb.y, bankTop), fern);
  if (front > 0.0) {
    if (qb.y < bankTop) {
      float grain = 0.6 * vnoise(qb * 40.0) + 0.4 * vnoise(qb * 110.0);
      float top = smoothstep(bankTop - 0.025, bankTop, qb.y);
      vec3 n = normalize(vec3((grain - 0.5) * 0.6, 0.15 + 0.8 * top, -1.0));
      float moss = top * smoothstep(0.55 - 0.4 * green, 0.7 - 0.4 * green, grain) * smoothstep(0.0, 0.15, green);
      col = mix(vec3(0.15, 0.14, 0.13) * (0.6 + 0.6 * grain), vec3(0.1, 0.22, 0.07), moss) * fallsLit(L, n) * 0.85;
    }
    if (fern > 0.0) {
      vec3 frond = mix(vec3(0.04, 0.12, 0.04), vec3(0.22, 0.4, 0.12), 0.25 + 0.6 * tip);
      col = mix(col, frond * fallsLit(L, normalize(vec3(0.0, 0.6, -1.0))), fern);
    }
    col = mix(col, haze, fogAmount(K_fog, 0.05, 0.0) * front);
    white *= 1.0 - front;
    glint *= 1.0 - front;
    spray *= 1.0 - front;
    mistAccent *= 1.0 - front;
    markAccent *= 1.0 - front;
  }

  if (rain > 0.0) {
    col = mix(col, skyLight + vec3(0.04), 0.55 * rainStreaks(uv, aspect, t, rain, wind));
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(dot(col, LUMA) * 1.15, 0.0, 1.0);
  o.accent = clamp(max(markAccent, mistAccent), 0.0, 1.0);
  o.shimmer = clamp(0.6 * glint + 0.15 * white + 0.35 * spray, 0.0, 1.0) * m;
  return o;
}
`;
