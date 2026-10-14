// The ferrofluid scene's picture: a pool of black magnetic fluid in a shallow dish, its spikes
// standing on a hexagonal lattice, lit as a black mirror in a studio. The sim (sim.ts) moves the
// pool and the magnet and hands over:
//   uSim0  spike field over the dish: r spike height, gb tip lean, a the pool's field φ (shadow)
//   uSim1  texel 0 lattice origin xy, spacing, M amount; 1 pool bound xy r, tallest point;
//          2 M height; 3.. the pool's blobs: xy, radius, weight
// Knobs read here: K_camera (0 above, 1 three-quarter), K_sharpness, K_gel, K_lights.
import { glslFloat, glslPick, glslVec3 } from "../../shaders/glsl.ts";
import { FERRO_BLOBS, FERRO_PASSAGE, FERRO_RIPPLE, FERRO_SHAPE, FERRO_SPAN, FERRO_STATE_HEAD, FERRO_VIEW } from "./sim.ts";

/** The studio light colours a gel can give the right-hand panel; the first is a plain studio. */
export const ferroGels = [
  { label: "white", color: "#eef1ff" },
  { label: "ember", color: "#ff6a2b" },
  { label: "cyan", color: "#3fc8ff" },
  { label: "violet", color: "#9a63ff" },
] as const;

const gelChoices = glslPick("gel", ferroGels.map((gel) => glslVec3(gel.color)), "vec3(1.0)");
const [targetX, targetY, targetZ] = FERRO_VIEW.target;

export const ferroGlsl = `
const float FERRO_PUDDLE = ${glslFloat(FERRO_SHAPE.puddle)};
const float FERRO_EDGE = ${glslFloat(FERRO_SHAPE.edge)};
const float FERRO_MOUND = ${glslFloat(FERRO_SHAPE.mound)};
const float FERRO_MOUND_SOFT = ${glslFloat(FERRO_SHAPE.moundSoft)};
const float FERRO_RADIUS = ${glslFloat(FERRO_SHAPE.radius)};
const float FERRO_SPIKE_FADE = ${glslFloat(FERRO_SHAPE.spikeFade)};
const float FERRO_SPAN = ${glslFloat(FERRO_SPAN)};
const int FERRO_BLOBS = ${FERRO_BLOBS};
const int FERRO_STATE_HEAD = ${FERRO_STATE_HEAD};
const float FERRO_ELEVATION = ${glslFloat(FERRO_VIEW.elevation)};
const float FERRO_DISTANCE = ${glslFloat(FERRO_VIEW.distance)};
const vec3 FERRO_TARGET = vec3(${glslFloat(targetX)}, ${glslFloat(targetY)}, ${glslFloat(targetZ)});
const float FERRO_TAN = ${glslFloat(FERRO_VIEW.tanHalfFov)};
const float FERRO_FIT = ${glslFloat(FERRO_VIEW.fit)};
const float FERRO_TOP_HALF = ${glslFloat(FERRO_VIEW.topHalf)};
const float FERRO_TOP_EYE = ${glslFloat(FERRO_VIEW.topEye)};
const float FERRO_TOP_FIT = ${glslFloat(FERRO_VIEW.topFit)};
const float FERRO_EXIT = ${glslFloat(FERRO_PASSAGE.exit)};
const float FERRO_RIPPLE_HEIGHT = ${glslFloat(FERRO_RIPPLE.height)};
const float FERRO_RIPPLE_SPEED = ${glslFloat(FERRO_RIPPLE.speed)};
const float FERRO_RIPPLE_START = ${glslFloat(FERRO_RIPPLE.start)};
const float FERRO_RIPPLE_WIDTH = ${glslFloat(FERRO_RIPPLE.width)};
const float FERRO_RIPPLE_WAVE = ${glslFloat(FERRO_RIPPLE.wavelength)};
const float FERRO_DISH = 1.0;                          // the dish floor's radius
const float FERRO_LIP = 0.05;                          // width of its rounded, polished lip
const float FERRO_F0 = 0.045;                          // the fluid's reflectance head on: an oily, opaque black
const vec3 FERRO_STUDIO = vec3(1.0, 0.98, 0.95);      // the white lights

// The state the sim hands over, loaded once per pixel.
vec2 ferroOrigin;
float ferroSpacing;
float ferroMark;
vec4 ferroBound;
float ferroMarkScale;
float ferroSharp;
vec4 ferroBlobs[FERRO_BLOBS];

vec3 ferroGel() {
${gelChoices}
}

void ferroLoad() {
  ferroSharp = mix(1.15, 2.6, K_sharpness);
  if (uSimOn.y < 0.5) {
    ferroOrigin = vec2(0.0);
    ferroSpacing = 0.11;
    ferroMark = 0.0;
    ferroBound = vec4(0.0, 0.0, 0.0, 0.01);
    ferroMarkScale = 1.0;
    for (int i = 0; i < FERRO_BLOBS; i++) ferroBlobs[i] = vec4(0.0, 0.0, 1.0, 0.0);
    return;
  }
  vec4 lattice = texelFetch(uSim1, ivec2(0, 0), 0);
  ferroOrigin = lattice.xy;
  ferroSpacing = max(lattice.z, 0.02);
  ferroMark = lattice.w;
  ferroBound = texelFetch(uSim1, ivec2(1, 0), 0);
  ferroMarkScale = max(texelFetch(uSim1, ivec2(2, 0), 0).x, 0.1);
  for (int i = 0; i < FERRO_BLOBS; i++) {
    vec4 blob = texelFetch(uSim1, ivec2(FERRO_STATE_HEAD + i, 0), 0);
    blob.z = max(blob.z, 0.001);
    ferroBlobs[i] = blob;
  }
}

vec2 ferroTexCoord(vec2 p) {
  return p / (2.0 * FERRO_SPAN) + 0.5;
}

// The pool's field: seven smooth blobs summed, 1 at the pool's edge. Evaluated exactly rather than
// read from the sim's grid so the mirror's normals stay smooth (a bilinear grid would facet them).
float ferroField(vec2 p) {
  float f = 0.0;
  for (int i = 0; i < FERRO_BLOBS; i++) {
    vec4 blob = ferroBlobs[i];
    vec2 d = (p - blob.xy) / blob.z;
    float u = max(1.0 - dot(d, d), 0.0);
    f += blob.w * u * u * u;
  }
  return f;
}

// The pool's surface without its spikes (sim.ts ferroBase): a rounded edge, then a heap where it runs deep.
float ferroBase(float phi) {
  float x = max(phi - 1.0, 0.0);
  return FERRO_PUDDLE * sqrt(1.0 - exp(-x / FERRO_EDGE)) + FERRO_MOUND * x * x / (x + FERRO_MOUND_SOFT);
}

// Lattice coordinates (i, j) of a dish point: columns of spikes run along y, every other one half a
// spacing up, so the M's upright strokes can stand on whole columns.
vec2 ferroLatticeCoord(vec2 p) {
  vec2 d = p - ferroOrigin;
  float j = d.x / (0.8660254 * ferroSpacing);
  return vec2(d.y / ferroSpacing - 0.5 * j, j);
}

vec2 ferroVertex(vec2 ij) {
  return ferroOrigin + ferroSpacing * vec2(0.8660254 * ij.y, ij.x + 0.5 * ij.y);
}

// One spike standing at lattice vertex c: an oblique cone over a circle of radius R, its tip pushed
// along the field by the lean (uSim0.gb), its flanks hollowed by the sharpness into a needle on a
// flared foot. s solves |q - lean s| = R (1 - s), the cone's own height fraction at q.
// Returns (height, the spike's full height).
vec2 ferroSpike(vec2 p, vec2 c, float R) {
  vec4 f = textureLod(uSim0, ferroTexCoord(c), 0.0);
  vec2 q = p - c;
  float cq = dot(q, q) - R * R;
  if (cq >= 0.0) return vec2(0.0, f.r);
  vec2 lean = f.gb;
  float a = dot(lean, lean) - R * R;
  float b = 2.0 * (R * R - dot(q, lean));
  float s = clamp(-2.0 * cq / (b + sqrt(max(b * b - 4.0 * a * cq, 0.0))), 0.0, 1.0);
  return vec2(f.r * pow(s, ferroSharp), f.r);
}

// The three spikes whose feet can reach p (the lattice triangle around it), summed so the valleys
// between them stay smooth. Returns (height, the tallest of the three).
vec2 ferroSpikes(vec2 p) {
  vec2 g = ferroLatticeCoord(p);
  vec2 cell = floor(g);
  vec2 f = g - cell;
  float R = FERRO_RADIUS * ferroSpacing;
  vec2 a = ferroSpike(p, ferroVertex(cell + (f.x + f.y > 1.0 ? vec2(1.0) : vec2(0.0))), R);
  vec2 b = ferroSpike(p, ferroVertex(cell + vec2(1.0, 0.0)), R);
  vec2 c = ferroSpike(p, ferroVertex(cell + vec2(0.0, 1.0)), R);
  return vec2(a.x + b.x + c.x, max(max(a.y, b.y), c.y));
}

// The exit's ripple: as the field goes and the spikes slump, a ring packet runs out over the pool
// from its middle blob, losing height as it travels and dying away over the pool's rounded edge.
// Exactly 0 at rest (passageOut() is 0), so the picture is untouched.
float ferroRipple(vec2 p, float phi) {
  float t = passageOut() * FERRO_EXIT - FERRO_RIPPLE_START;
  if (t <= 0.0) return 0.0;
  float front = FERRO_RIPPLE_SPEED * t;
  float x = length(p - ferroBound.xy) - front;
  float packet = exp(-x * x / (FERRO_RIPPLE_WIDTH * FERRO_RIPPLE_WIDTH)) * cos(TAU * x / FERRO_RIPPLE_WAVE);
  return FERRO_RIPPLE_HEIGHT * smoothstep(0.0, 0.3, t) * exp(-1.2 * front) * packet * smoothstep(1.0, 1.35, phi);
}

// The fluid's height at p (0 on the bare dish); spikes shrink away toward the pool's edge.
float ferroHeight(vec2 p) {
  float phi = ferroField(p);
  if (phi <= 1.0) return 0.0;
  return ferroBase(phi) + ferroRipple(p, phi) + smoothstep(1.0, 1.0 + FERRO_SPIKE_FADE, phi) * ferroSpikes(p).x;
}

// How far the ray at t is above the fluid (negative: inside it). The small lift keeps a ray that
// reaches the bare dish at exactly z = 0 from reading as a hit through rounding.
float ferroGap(vec3 ro, vec3 rd, float t) {
  vec3 p = ro + rd * t;
  return p.z - ferroHeight(p.xy) + 1e-4;
}

// Where the ray (relative to the cell's spike, rel) crosses the bisector toward neighbour n; keeps
// the nearest crossing ahead and the step to that neighbour.
void ferroExit(vec2 rel, vec2 dir, vec2 n, vec2 dij, float bisector, inout float te, inout vec2 next) {
  float dn = dot(dir, n);
  if (dn > 1e-7) {
    float t = (bisector - dot(rel, n)) / dn;
    if (t < te) {
      te = t;
      next = dij;
    }
  }
}

// The three-quarter camera: low over the dish on its near side, looking across it; s is the frame
// point (-aspect..aspect, -1..1). Narrow frames pull it back.
void ferroCamera(vec2 s, float aspect, out vec3 ro, out vec3 rd) {
  float fit = max(1.0, FERRO_FIT / aspect);
  float ce = cos(FERRO_ELEVATION);
  float se = sin(FERRO_ELEVATION);
  ro = FERRO_TARGET + FERRO_DISTANCE * fit * vec3(0.0, -ce, se);
  rd = normalize(vec3(s.x * FERRO_TAN, ce + s.y * se * FERRO_TAN, -se + s.y * ce * FERRO_TAN));
}

// Where a three-quarter ray meets the fluid, or -1 when it reaches the dish. The ray is walked cell
// by cell across the spike lattice inside the slab under the pool's tallest point, sampling each
// cell where it passes closest to that cell's (leaning) tip and where it leaves; so needle tips far
// thinner than a fixed step are never stepped over. The first crossing is then bisected.
float ferroTrace(vec3 ro, vec3 rd, float tFloor) {
  float tTop = (ro.z - ferroBound.w) / -rd.z;
  vec2 oc = ro.xy - ferroBound.xy;
  float a = dot(rd.xy, rd.xy);
  float b = dot(oc, rd.xy);
  float c = dot(oc, oc) - ferroBound.z * ferroBound.z;
  float disc = b * b - a * c;
  if (disc <= 0.0) return -1.0;
  float root = sqrt(disc);
  float t0 = max(tTop, (-b - root) / a);
  float t1 = min(tFloor, (-b + root) / a);
  if (t0 >= t1) return -1.0;

  float h = ferroSpacing;
  vec2 e1 = vec2(0.0, h);
  vec2 e2 = vec2(0.8660254 * h, 0.5 * h);
  vec2 e3 = e1 - e2;
  float bisector = 0.5 * h * h;

  // Start in the cell of the lattice vertex nearest the entry point.
  vec2 p0 = ro.xy + rd.xy * t0;
  vec2 g = ferroLatticeCoord(p0);
  vec2 cell = floor(g);
  vec2 f = g - cell;
  vec2 ij = cell + (f.x + f.y > 1.0 ? vec2(1.0) : vec2(0.0));
  float best = distance(p0, ferroVertex(ij));
  float d1 = distance(p0, ferroVertex(cell + vec2(1.0, 0.0)));
  if (d1 < best) {
    best = d1;
    ij = cell + vec2(1.0, 0.0);
  }
  if (distance(p0, ferroVertex(cell + vec2(0.0, 1.0))) < best) ij = cell + vec2(0.0, 1.0);

  float ta = t0;
  float tb = -1.0;
  bool left = false;
  // Over the pool a ray crosses about a dozen cells at the default spacing. A ray running straight
  // away from the camera between two lattice columns zig-zags through a cell every half spacing, so
  // the finest spacing on the longest rays needs about 30. Each cell costs two height samples.
  for (int k = 0; k < 32; k++) {
    vec2 vertex = ferroVertex(ij);
    vec2 rel = ro.xy - vertex;
    float te = 1e9;
    vec2 next = vec2(0.0);
    ferroExit(rel, rd.xy, e1, vec2(1.0, 0.0), bisector, te, next);
    ferroExit(rel, rd.xy, -e1, vec2(-1.0, 0.0), bisector, te, next);
    ferroExit(rel, rd.xy, e2, vec2(0.0, 1.0), bisector, te, next);
    ferroExit(rel, rd.xy, -e2, vec2(0.0, -1.0), bisector, te, next);
    ferroExit(rel, rd.xy, e3, vec2(1.0, -1.0), bisector, te, next);
    ferroExit(rel, rd.xy, -e3, vec2(-1.0, 1.0), bisector, te, next);
    te = clamp(te, ta, t1);
    vec2 tip = vertex + 0.85 * textureLod(uSim0, ferroTexCoord(vertex), 0.0).gb;
    float tc = clamp(dot(tip - ro.xy, rd.xy) / a, ta, te);
    if (tc > ta) {
      if (ferroGap(ro, rd, tc) < 0.0) {
        tb = tc;
        break;
      }
      ta = tc;
    }
    if (ferroGap(ro, rd, te) < 0.0) {
      tb = te;
      break;
    }
    ta = te;
    if (te >= t1) {
      left = true;
      break;
    }
    ij += next;
  }
  // Out of cells before the ray left the pool (finest spacing, most grazing rays): finish the walk
  // in plain steps rather than let the dish show through.
  if (tb < 0.0 && !left) {
    float stride = (t1 - ta) / 10.0;
    for (int k = 0; k < 10; k++) {
      float t = ta + stride;
      if (ferroGap(ro, rd, t) < 0.0) {
        tb = t;
        break;
      }
      ta = t;
    }
  }
  if (tb < 0.0) return -1.0;
  for (int k = 0; k < 6; k++) {
    float tm = 0.5 * (ta + tb);
    if (ferroGap(ro, rd, tm) < 0.0) tb = tm;
    else ta = tm;
  }
  return 0.5 * (ta + tb);
}

vec3 ferroNormal(vec2 p, float e) {
  float h = ferroHeight(p);
  return normalize(vec3(h - ferroHeight(p + vec2(e, 0.0)), h - ferroHeight(p + vec2(0.0, e)), e));
}

// A soft-edged panel in (azimuth, elevation).
float ferroPanel(vec2 ae, vec2 centre, vec2 size, float soft) {
  vec2 d = abs(ae - centre) - size;
  return softFill(d.x, soft) * softFill(d.y, soft);
}

// The studio, seen along r (z up, +y behind the dish as the three-quarter camera sees it, +x to its
// right), lit for the view. Three-quarter: a narrow strip softbox far behind, sized so its mirror
// image in the black dish lies just behind the crown, where the back row of spikes stands against
// it as black cones. Above: a broad softbox behind, and a ring light overhead, mirrored as a ring in
// the pool. Both: a tall strip either side, a little behind, mirrored in long lines down the steep
// front flanks of the spikes (bright, as those flanks are seen nearly head on and reflect little);
// the right one gelled, its light returned in 'gel' to be tinted. 'steep' (0..1) weighs the strips,
// so the caller can keep them off gentle slopes. aa is how far r swings across one cell: edges
// soften by it and the thin ring dims as it widens, so squeezed reflections settle to their average
// instead of crawling. Everything else is black.
vec3 ferroStudio(vec3 r, float aa, float steep, out float gel) {
  bool above = K_camera < 0.5;
  float el = asin(clamp(r.z, -1.0, 1.0));
  float az = atan(r.x, r.y);
  vec2 ae = vec2(az, el);
  float soft = 0.005 + aa;
  float back = above
    ? 12.0 * ferroPanel(ae, vec2(0.0, 0.36), vec2(0.56, 0.26), soft)
    : 20.0 * ferroPanel(ae, vec2(0.0, 0.335), vec2(0.42, 0.035), soft);
  float side = 28.0 * steep * ferroPanel(ae, vec2(-1.75, 0.5), vec2(0.4, 0.36), soft);
  gel = 22.0 * steep * ferroPanel(ae, vec2(1.75, 0.5), vec2(0.4, 0.36), soft);
  float ring = 0.0;
  if (above) {
    float band = 0.012;
    ring = 26.0 * (1.0 - smoothstep(band, band + soft, abs(acos(clamp(r.z, -1.0, 1.0)) - 0.103))) * band / (band + aa);
  }
  return FERRO_STUDIO * (back + side + ring);
}

// Everything that is not fluid: the dish (black glass, a sharp mirror of the studio, darkened round
// the pool's foot by its contact shadow), its polished lip catching the studio (white behind and to
// the left, the gel on the right), and the matte black table beyond, but for a satin glow of the
// softbox just behind the dish, the soft ground the tallest spikes stand against before it falls to
// black. gelLit: how much of the gel light it returns.
vec3 ferroFloor(vec3 pos, vec3 rd, float aa, float px, float lights, vec3 gel, out float gelLit) {
  float rr = length(pos.xy);
  vec3 mirrored = reflect(rd, vec3(0.0, 0.0, 1.0));
  float fres = 0.04 + 0.96 * pow(max(1.0 - abs(rd.z), 0.0), 5.0);
  float shadow = smoothstep(0.1, 0.95, textureLod(uSim0, ferroTexCoord(pos.xy), 0.0).a);

  float dishGel;
  vec3 dish = ferroStudio(mirrored, aa, 1.0, dishGel);
  float glass = 0.9 * fres * lights * (1.0 - 0.9 * shadow);
  dishGel *= glass;
  dish = glass * dish + dishGel * gel;

  // The lip, from its inner side over the top to its outer side.
  float w = (rr - FERRO_DISH) / FERRO_LIP;
  float bend = (clamp(w, 0.0, 1.0) - 0.5) * 2.6;
  vec3 nl = vec3(pos.xy / max(rr, 1e-4) * sin(bend), cos(bend));
  float lipGel;
  vec3 lip = ferroStudio(reflect(rd, nl), aa + 0.05, 1.0, lipGel);
  lipGel *= 0.25 * lights;
  lip = 0.25 * lights * lip + lipGel * gel;

  float tableGel;
  vec3 table = ferroStudio(mirrored, 0.08, 1.0, tableGel);
  float satin = 0.2 * fres * lights * exp(-5.0 * (rr - FERRO_DISH) * (rr - FERRO_DISH)) * (1.0 - smoothstep(0.35, 0.8, abs(pos.x)));
  tableGel *= satin;
  table = satin * table + tableGel * gel;

  float edge = px / FERRO_LIP;
  float onLip = smoothstep(-edge, edge, w) * (1.0 - smoothstep(1.0 - edge, 1.0 + edge, w));
  float beyond = smoothstep(1.0 - edge, 1.0 + edge, w);
  gelLit = mix(mix(dishGel, tableGel, beyond), lipGel, onLip);
  return mix(mix(dish, table, beyond), lip, onLip);
}

Shade sceneFerro(vec2 uv, vec2 cell, float t) {
  ferroLoad();
  float aspect = uRes.x / uRes.y;
  vec2 s = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) * 2.0;
  bool above = K_camera < 0.5;

  vec3 rd;
  vec3 pos;
  float px;      // one cell's width in dish units, at the surface seen
  bool fluid;
  if (above) {
    // Above: an orthographic picture of the dish, with the mirrored directions of an eye overhead.
    float k = FERRO_TOP_HALF * max(1.0, FERRO_TOP_FIT / aspect);
    vec2 p = s * k;
    rd = normalize(vec3(p, -FERRO_TOP_EYE));
    fluid = ferroField(p) > 1.0;
    pos = vec3(p, 0.0);
    px = 2.0 * k / uRes.y;
  } else {
    vec3 ro;
    ferroCamera(s, aspect, ro, rd);
    float tFloor = ro.z / -rd.z;
    float th = ferroTrace(ro, rd, tFloor);
    fluid = th > 0.0;
    float tSeen = fluid ? th : tFloor;
    pos = ro + rd * tSeen;
    px = 2.0 * FERRO_TAN * tSeen / uRes.y;
  }

  vec3 n = fluid ? ferroNormal(pos.xy, max(0.6 * px, 0.001)) : vec3(0.0, 0.0, 1.0);
  vec3 r = reflect(rd, n);
  float aa = length(fwidth(r));

  vec3 gel = ferroGel();
  float lights = 0.35 + 1.3 * K_lights;
  float gelLit;
  vec3 col;
  if (fluid) {
    float fres = FERRO_F0 + (1.0 - FERRO_F0) * pow(1.0 - clamp(-dot(rd, n), 0.0, 1.0), 5.0);
    // Low on a spike, its neighbours stand in the way of the low lights: the horizon they raise
    // falls off fast with height up the spike, and even below it some light slips between them.
    vec2 spikes = ferroSpikes(pos.xy);
    float low = 1.0 - (spikes.y > 1e-4 ? clamp(spikes.x / spikes.y, 0.0, 1.0) : 1.0);
    float horizon = atan(max(spikes.y, 0.0) * low * low, 1.5 * ferroSpacing);
    float open = mix(0.45, 1.0, smoothstep(horizon - 0.35, horizon + 0.1, asin(clamp(r.z, -1.0, 1.0))));
    // Three-quarter, the side strips draw only on steep slopes (flanks steeper than about 45°): lines
    // down the spikes and a thin crescent at the pool's edge, never patches on the gentle feet and
    // valleys round the crown's rim. Above, those gentle feet are what catches the light.
    float steep = above ? 1.0 : 1.0 - smoothstep(0.5, 0.72, n.z);
    float gelPart;
    vec3 studio = ferroStudio(r, aa, steep, gelPart);
    float lit = fres * open * lights;
    col = lit * (studio + gelPart * gel);
    gelLit = lit * gelPart;
  } else {
    col = ferroFloor(pos, rd, aa, px, lights, gel, gelLit);
  }
  col = 1.0 - exp(-col);
  // A mirror under the dither: the dim tail falls to true black and the highlights to white, so the
  // picture is a few bold shapes on black rather than a field of grey dither. Above, where most
  // spikes are seen end on, a lower black point keeps the faint rings that draw the lattice.
  float lum = dot(col, LUMA);
  float shaped = smoothstep(above ? 0.012 : 0.04, above ? 0.85 : 0.9, lum);
  col = min(col * (shaped / max(lum, 1e-4)), 1.0);

  float accent = smoothstep(0.04, 0.9, 1.0 - exp(-1.5 * gelLit));
  // While the M stands, its spikes carry the accent too: the landmark in the two-tone palette.
  if (fluid && ferroMark > 0.01) {
    float d = markDistance(pos.xy / ferroMarkScale) * ferroMarkScale;
    float onMark = ferroMark * (1.0 - smoothstep(0.5 * ferroSpacing, 0.9 * ferroSpacing, d));
    accent = max(accent, onMark * shaped);
  }
  return shadeOf(col, shaped, accent);
}
`;
