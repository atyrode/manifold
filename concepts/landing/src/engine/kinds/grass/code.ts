// The grass's code (src/engine/glsl.ts, the kind contract). The patch is a layer of blades over the
// land: the document's ground where it holds one (read from its instance, its own `groundAt`, under
// ENGINE_GROUND), else the patch's plane; along a ray the land is a line through its heights where
// the ray enters the patch and where it meets the land. The wind at the patch (engineWind, gusts
// and all) shears the layer downwind, the more the stronger, over a lie combed in swirls, so every
// blade is straight in the sheared frame and the ray, sheared too, stays a line: it walks the
// blades' lattice cell by cell (a 2D DDA, at most GRASS_STEPS cells) and meets each cell's blade as
// a card facing it, tapering to its tip, curling its own way; some carry a wildflower's head.
// Detail by distance: a blade narrower than a cell widens and thins in step, and once a cell spans a
// lattice cell the patch is a carpet at its blades' mean height, textured, with the flowers as
// colour. Between the blades lies thatch; past the patch's ragged edge the land shows. A gust
// presses the grass pale (gustAt where it is hit) and its rebound shades it, so gusts cross it as
// waves.
import { glslFloat } from "../../../shaders/glsl.ts";
import { instanceStride } from "../../instances.ts";
import type { KindCode } from "../../types.ts";
import { groundKind } from "../ground/index.ts";
import { kindRow } from "../index.ts";
import { GRASS_TOP } from "./index.ts";

/** The blades' lattice cell and a blade's half-width at its root, metres. */
const CELL = 0.035;
const WIDTH = 0.0065;
/** A wildflower's head, radius, metres. */
const HEAD = 0.016;

export const glsl: KindCode["glsl"] = () => `
const float GRASS_CELL = ${glslFloat(CELL)};
const float GRASS_WIDTH = ${glslFloat(WIDTH)};
const float GRASS_HEAD = ${glslFloat(HEAD)};
const float GRASS_TOP = ${glslFloat(GRASS_TOP)};
const int GRASS_STEPS = 40;
// What a hit is (Hit.part's type, its first digit): a blade, a flower's head, the thatch, the carpet.
const float GRASS_BLADE = 0.0;
const float GRASS_FLOWER = 1.0;
const float GRASS_THATCH = 2.0;
const float GRASS_CARPET = 3.0;
const vec3 GRASS_GREEN = vec3(0.3, 0.5, 0.14);
const vec3 GRASS_STRAW = vec3(0.62, 0.54, 0.3);
const vec3 GRASS_PALE = vec3(0.72, 0.78, 0.5);

// The land under point x of the patch (its frame), with no detail finer than foot: its height over
// the patch's plane.
float grassFloor(EngineObj o, vec2 x, float foot) {
#ifdef ENGINE_GROUND
  if (engineCount(${kindRow(groundKind)}) > 0) {
    EngineObj g = engineObj(${kindRow(groundKind)}, 0, ${instanceStride(groundKind)});
    vec3 q = engineToObject(g, enginePointToWorld(o, vec3(x.x, 0.0, x.y)));
    return (g.at.y + g.scale * groundAt(g, q.xz, foot * o.scale / g.scale) - o.at.y) / o.scale;
  }
#endif
  return 0.0;
}

// How far inside the patch's ragged edge x lies, metres (below 0: outside it); deep inside, the
// raggedness cannot reach it.
float grassEdge(EngineObj o, vec2 x) {
  vec2 inside = 0.5 * vec2(grassWidth(o), grassDepth(o)) - abs(x);
  float d = min(inside.x, inside.y);
  return d > 0.9 ? d : d - 0.45 * vnoise(x * 1.3 + 4.7);
}

// A wildflower's colour: ox-eye daisy, buttercup, knapweed, red clover, campion.
vec3 grassFlower(float h) {
  if (h < 0.3) return vec3(0.95, 0.93, 0.84);
  if (h < 0.55) return vec3(1.0, 0.8, 0.18);
  if (h < 0.75) return vec3(0.6, 0.3, 0.62);
  if (h < 0.9) return vec3(0.78, 0.3, 0.42);
  return vec3(0.9, 0.42, 0.55);
}

// Hit.part for a hit of type kind at height share up (0 root .. 1 tip) with a tone 0..1.
float grassPart(float kind, float up, float tone) {
  return kind * 65536.0 + floor(clamp(up, 0.0, 1.0) * 255.0) * 256.0 + floor(clamp(tone, 0.0, 1.0) * 255.0);
}

float grassHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  n = vec3(0.0, 1.0, 0.0);
  part = 0.0;
  float tall = grassHeight(o);
  float top = tall * GRASS_TOP;
  // The ray's height over the land, a line in t: through where it enters the patch and where it
  // meets the land (refined once there).
  vec3 pa = ro + rd * span.x;
  vec3 pb = ro + rd * span.y;
  float ha = pa.y - grassFloor(o, pa.xz, span.x * engineCell);
  if (ha < 0.0) return -1.0;
  float hb = pb.y - grassFloor(o, pb.xz, span.y * engineCell);
  float k = (hb - ha) / max(span.y - span.x, 1e-5);
  if (hb < 0.0) {
    float tg = span.x + ha / max(ha - hb, 1e-6) * (span.y - span.x);
    vec3 pg = ro + rd * tg;
    float hg = pg.y - grassFloor(o, pg.xz, tg * engineCell);
    if (tg - span.x > 1e-3) k = (hg - ha) / (tg - span.x);
  }
  if (k >= 0.0 && ha > top) return -1.0;
  float tTop = k < 0.0 ? span.x + max(ha - top, 0.0) / -k : span.x;
  float tFloor = k < 0.0 ? span.x + ha / -k : 1e9;
  float tA = max(span.x, tTop);
  float tB = k < 0.0 ? min(span.y, tFloor) : min(span.y, span.x + (top - ha) / max(k, 1e-6));
  if (tA >= tB) return -1.0;
  bool reaches = k < 0.0 && tFloor <= span.y;
  float density = grassDensity(o);

  // Far off the patch is a carpet at its blades' mean height, where its ragged edge lets it be.
  float foot = tA * engineCell;
  if (foot > GRASS_CELL * 0.9) {
    float mean = tall * mix(0.45, 0.8, density);
    float tc = k < 0.0 ? span.x + max(ha - mean, 0.0) / -k : tA;
    if (tc <= tB) {
      vec3 pc = ro + rd * tc;
      if (grassEdge(o, pc.xz) > 0.0) {
        part = grassPart(GRASS_CARPET, mean / tall, 0.0);
        return tc;
      }
    }
    if (reaches && grassEdge(o, (ro + rd * tFloor).xz) > 0.0) {
      part = grassPart(GRASS_THATCH, 0.0, 0.0);
      return tFloor;
    }
    return -1.0;
  }

  // The wind where the ray enters the grass bends every blade it may meet the same way: the tip
  // downwind of its root by a share of its height, with the grass's own lie under it.
  vec3 world = enginePointToWorld(o, vec3(pa.x, pa.y - ha, pa.z));
  vec2 wind = engineDirToObject(o, engineWind(vec3(world.x, 0.7 * tall * o.scale, world.z), uMotionTime)).xz;
  float speed = length(wind);
  vec2 down = speed > 1e-3 ? wind / speed : vec2(1.0, 0.0);
  float flutter = sin(uMotionTime * 2.4 + dot(pa.xz, down) * 1.7);
  vec2 lie = (vec2(vnoise(pa.xz * 0.6 + 3.1), vnoise(pa.xz * 0.6 + 7.7)) - 0.5) * 0.6;
  vec2 bend = (down * min(0.16 * speed * (1.0 + 0.12 * flutter), 0.8) + lie) * tall;
  // The ray in the sheared frame, where the blades stand straight: q(t) = q0 + dq t.
  vec2 dq = rd.xz - bend * k / tall;
  if (dot(dq, dq) < 4e-4) dq += vec2(0.02, 0.0);
  vec2 q0 = ro.xz - bend * (ha - span.x * k) / tall;
  vec2 across = normalize(vec2(-dq.y, dq.x));
  float flowers = grassFlowers(o);
  // The 2D DDA over the lattice from tA to tB.
  vec2 q = q0 + dq * tA;
  vec2 cell = floor(q / GRASS_CELL);
  vec2 dir = vec2(dq.x < 0.0 ? -1.0 : 1.0, dq.y < 0.0 ? -1.0 : 1.0);
  vec2 inv = dir / max(abs(dq), vec2(1e-6));
  vec2 next = ((cell + max(dir, 0.0)) * GRASS_CELL - q0) * inv;
  vec2 stride = GRASS_CELL * abs(inv);
  float t = tA;
  for (int i = 0; i < GRASS_STEPS; i++) {
    vec2 h2 = hash22(cell + 0.5);
    float h3 = hash12(cell * 1.37 + 17.1);
    vec2 root = (cell + 0.15 + 0.7 * h2) * GRASS_CELL;
    float edge = grassEdge(o, root);
    if (h3 < density * smoothstep(0.0, 0.4, edge)) {
      float h4 = fract(h3 * 113.7);
      float blade = tall * (0.5 + 0.5 * fract(h3 * 7.31));
      bool flower = h4 < flowers * 0.25;
      if (flower) blade = tall * (0.95 + 0.17 * fract(h3 * 3.7));
      // Where the ray passes the blade's card, how high it is there, and how far across.
      float ts = dot(root - q0, dq) / dot(dq, dq);
      float up = ha + (ts - span.x) * k;
      float side = dot(q0 + dq * ts - root, across);
      float share = up / blade;
      // Each blade curls its own way toward its tip.
      side -= (h2.x - 0.5) * 0.5 * blade * share * share;
      float spot = ts * engineCell;
      float width = (flower ? 0.4 : 1.0) * GRASS_WIDTH * pow(max(1.0 - share, 0.0), 0.6);
      // A blade narrower than half a cell widens and thins in step, keeping what it covers.
      float wide = max(width, 0.5 * spot);
      if (ts >= tA && ts <= tB && up >= 0.0) {
        if (share <= 1.0 && abs(side) < wide && fract(h3 * 59.3) * wide < width) {
          // Lit as thin blades are, through and from above whichever way the light comes.
          n = normalize(vec3(-rd.x, 0.0, -rd.z) * 0.2 + vec3(0.0, 1.0, 0.0) + vec3(across.x, 0.0, across.y) * (side / wide) * 0.35);
          part = grassPart(GRASS_BLADE, share, fract(h3 * 17.9));
          return ts;
        }
        if (flower) {
          float head = max(GRASS_HEAD, 0.5 * spot);
          if (length(vec2(side, up - blade)) < head && fract(h3 * 41.3) * head < GRASS_HEAD) {
            n = normalize(vec3(-rd.x, 0.0, -rd.z) * 0.3 + vec3(0.0, 1.0, 0.0));
            part = grassPart(GRASS_FLOWER, 1.0, fract(h3 * 29.1));
            return ts;
          }
        }
      }
    }
    t = min(next.x, next.y);
    if (t >= tB) break;
    if (next.x < next.y) {
      cell.x += dir.x;
      next.x += stride.x;
    } else {
      cell.y += dir.y;
      next.y += stride.y;
    }
  }
  if (t < tB) {
    // Out of steps still in the grass: as thick as a carpet there.
    part = grassPart(GRASS_CARPET, (ha + (t - span.x) * k) / tall, 0.0);
    return t;
  }
  if (reaches && grassEdge(o, (ro + rd * tFloor).xz) > 0.0) {
    part = grassPart(GRASS_THATCH, 0.0, 0.0);
    return tFloor;
  }
  return -1.0;
}

void grassSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float kind = floor(part / 65536.0);
  float rest = part - kind * 65536.0;
  float up = floor(rest / 256.0) / 255.0;
  float tone = (rest - floor(rest / 256.0) * 256.0) / 255.0;
  vec3 world = enginePointToWorld(o, p);
  float foot = length(world - engineCamera().eye) / o.scale * engineCell;
  // A gust presses the grass over and shows its paler side; just behind it the grass springs back
  // past upright, darker.
  GustWind wind = gustWind();
  float gust = gustAt(wind, world.xz, uMotionTime, foot * 4.0);
  float press = 0.85 * smoothstep(0.1, 0.8, gust);
  float rebound = 1.0 + 0.6 * min(gust, 0.0);
  // Patches gone further to straw than the rest.
  float dry = clamp(grassDry(o) + 0.6 * (vnoise(world.xz * 0.35 + 2.1) - 0.5) + 0.3 * (tone - 0.5), 0.0, 1.0);
  vec3 albedo = mix(GRASS_GREEN, GRASS_STRAW, dry);
  h.rough = 0.85;
  h.mat = int(kind);
  if (kind == GRASS_FLOWER) {
    h.albedo = grassFlower(tone);
    h.rough = 1.0;
    return;
  }
  if (kind == GRASS_THATCH) {
    // The shaded depths between the stems: dead stalks and moss, lighter where a gust opens it.
    h.albedo = mix(vec3(0.1, 0.13, 0.05), GRASS_STRAW * 0.4, dry) * (0.8 + 0.4 * vnoise(world.xz * 23.0)) * (1.0 + 0.8 * max(gust, 0.0));
    h.rough = 1.0;
    return;
  }
  if (kind == GRASS_CARPET) {
    // The blades' average: tufts and hollows a few centimetres to tens across, the flowers as
    // specks near and their colour far.
    vec2 tuft = fbmLod(world.xz * 6.0, foot * 6.0, 3);
    albedo *= (0.55 + 0.5 * tuft.x) * mix(0.75, 1.0, up);
    vec2 speck = floor(world.xz / 0.06);
    float bloom = hash12(speck + 3.7);
    float near = 1.0 - smoothstep(0.03, 0.09, foot);
    vec3 drift = grassFlower(vnoise(world.xz * 0.08 + 17.0));
    albedo = mix(albedo, grassFlower(fract(bloom * 13.1)), near * step(bloom, grassFlowers(o) * 0.2));
    albedo = mix(albedo, drift, (1.0 - near) * grassFlowers(o) * 0.12);
    // Pressed over, it faces downwind.
    vec3 down = engineDirToObject(o, vec3(wind.dir.x, 0.0, wind.dir.y));
    n = normalize(vec3(0.0, 1.0, 0.0) + down * 0.6 * press + vec3(tuft.x - 0.5, 0.0, fbmLod(world.zx * 6.0 + 9.1, foot * 6.0, 2).x - 0.5) * 0.8 * tuft.y);
  } else {
    // A blade: dark at its root in the others' shade, lighter to its tip.
    albedo *= 0.45 + 0.55 * sqrt(up);
  }
  h.albedo = mix(albedo, GRASS_PALE, press * (0.3 + 0.7 * up)) * rebound;
}
`;
