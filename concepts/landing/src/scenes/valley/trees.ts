// The valley's trees: the woods and the lone trees in the hedges and on the banks, drawn as whole
// crowns with the shared shapes (shaders/lib/trees.ts: a broadleaf's dome, a pine's tiered boughs).
//
// The march meets bounds, never the crowns themselves: the woods' envelope (their canopy's height
// over a band a little wider than the woods) and each lone tree's tent (its yard texel of -1
// filtered to a pyramid over the four texels round it, steepened so it holds every crown drawn
// there). Where a ray meets a bound close enough for a crown to span more than a cell or so, the
// crowns are found exactly (valleyCrowns): the lone trees of the four texels round the hit, and the
// woods' trees cell by cell along the ray (one tree a VALLEY_CROWN_CELL cell, its crown within the
// cell, standing where the woods reach its root), each a sphere or a cone met analytically, a pine's
// boughs then found inside its cone. A ray that meets no crown goes on to the ground behind, so a
// wood's edge is a row of crowns at any pixel size. Farther off the bound is shaded as the canopy.
export const valleyTreesGlsl = /* glsl */ `
const float VALLEY_CROWN_CELL = 7.0;   // the woods: one tree a cell, its crown inside it, metres
const float VALLEY_WOOD_TOP = 12.5;    // the woods' envelope over the ground (its swells' crest), metres
const float VALLEY_LONE_TOP = 12.0;    // a lone tree's bound over its texel's centre, metres

// A stable species draw: the pine mix (K_pines) of the trees.
bool valleyPine(float h) {
#if VALLEY_HAS_PINES
  return fract(h * 83.17 + 0.19) < K_pines;
#else
  return false;
#endif
}

// How much of the woods stands here, 0..1: the woodland suitability over the knob's threshold,
// cleared from water, streams, roads (while drawn) and yards. loose: the band, a little wider, that
// every crown of the woods lies within (their envelope).
float valleyWoods(vec4 cover, float water, bool loose) {
  if (K_woodland <= 0.0) return 0.0;
  float th = valleyWoodTh - (loose ? 0.12 : 0.0);
  float reach = loose ? 2.5 : 0.0;
  float on = smoothstep(th, th + 0.14, cover.z - 1.5 * max(cover.w, 0.0));
  on *= smoothstep(0.5 - reach, 3.5 - reach, cover.y) * smoothstep(-0.3, -1.5, water);
  if (K_roads > 0.5) on *= smoothstep(1.5 - reach, 5.0 - reach, cover.x);
  return on;
}

// The woods' canopy height there: crowns rise with a broad swell, so their envelope follows it.
float valleyWoodTop(vec2 p) {
  return VALLEY_WOOD_TOP * (0.86 + 0.14 * vnoise(p / 9.0));
}

// What the march meets over the ground (metres): the woods' envelope, or a lone tree's tent. bound:
// the tent steepened to hold the whole crown (the march); otherwise rounded to about the crown's
// size (the sun's shadows).
float valleyCanopy(vec2 p, vec4 cover, float water, bool bound) {
  if (K_woodland <= 0.0) return 0.0;
  float w = clamp(-cover.w, 0.0, 1.0);
  float lone = bound ? VALLEY_LONE_TOP * sqrt(sqrt(w)) : 11.0 * sqrt(clamp((w - 0.1) / 0.9, 0.0, 1.0));
  return max(valleyWoodTop(p) * smoothstep(0.0, 0.3, valleyWoods(cover, water, true)), lone);
}

// A tree: its foot on the ground (metres), its crown's radius and top over the foot, its hash and
// species. A broadleaf's crown is a sphere under its top; a pine's a cone of tiered boughs
// (treePineWidth) 2.4 bough units tall, a unit radius / 0.82, from its tip down.
struct ValleyTree { vec3 foot; float radius; float top; float hash; bool pine; };

// Where the ray first meets the tree's crown bound (sphere or cone), beyond 0; -1 none.
float valleyTreeBound(vec3 ro, vec3 rd, ValleyTree tree) {
  if (!tree.pine) {
    vec3 oc = ro - (tree.foot + vec3(0.0, tree.top - tree.radius, 0.0));
    float b = dot(oc, rd);
    float h = b * b - dot(oc, oc) + tree.radius * tree.radius;
    if (h < 0.0) return -1.0;
    float t = -b - sqrt(h);
    return t > 0.0 ? t : -1.0;
  }
  // The cone from its tip: radius k per metre down, to its lowest boughs.
  vec3 o = ro - (tree.foot + vec3(0.0, tree.top, 0.0));
  float k = 0.82 / 2.4;
  float k2 = k * k;
  float a = dot(rd.xz, rd.xz) - k2 * rd.y * rd.y;
  float b = dot(o.xz, rd.xz) - k2 * o.y * rd.y;
  float c = dot(o.xz, o.xz) - k2 * o.y * o.y;
  float h = b * b - a * c;
  if (h < 0.0 || abs(a) < 1e-6) return -1.0;
  float depth = 2.4 * tree.radius / 0.82;
  float best = -1.0;
  for (int i = 0; i < 2; i++) {
    float t = (-b + (i == 0 ? -1.0 : 1.0) * sqrt(h)) / a;
    float down = -(o.y + rd.y * t);
    if (t > 0.0 && down >= 0.0 && down <= depth && (best < 0.0 || t < best)) best = t;
  }
  return best;
}

// The ray against the tree's crown from its bound's entry t: the hit (-1 none: it passed between a
// pine's boughs), the normal there (world, the shared dome's for a broadleaf) and how high up the
// crown 0..1. A pine's boughs are found by a short march through its cone.
float valleyTreeHit(vec3 ro, vec3 rd, ValleyTree tree, float t, out vec3 n, out float up) {
  n = vec3(0.0, 1.0, 0.0);
  up = 0.5;
  if (!tree.pine) {
    vec3 centre = tree.foot + vec3(0.0, tree.top - tree.radius, 0.0);
    vec3 s = (ro + rd * t - centre) / tree.radius;
    up = 0.5 + 0.5 * s.y;
    n = normalize(valleyToWorld(treeDomeNormal(vec2(dot(s, valleyRight), s.y))));
    return t;
  }
  float unit = tree.radius / 0.82;
  vec3 tip = tree.foot + vec3(0.0, tree.top, 0.0);
  float stride = 0.45 * unit / max(length(rd.xz), 0.3);
  float outside = t;
  for (int i = 0; i < 6; i++) {
    vec3 p = ro + rd * t - tip;
    float y = 1.4 + p.y / unit;
    if (y < -1.0) break;
    if (length(p.xz) / unit <= treePineWidth(y)) {
      // Bisect back to the boughs' surface between the last point outside and this one.
      float inside = t;
      for (int j = 0; j < 3; j++) {
        float mid = 0.5 * (outside + inside);
        vec3 m = ro + rd * mid - tip;
        if (length(m.xz) / unit <= treePineWidth(1.4 + m.y / unit)) inside = mid;
        else outside = mid;
      }
      p = ro + rd * inside - tip;
      y = 1.4 + p.y / unit;
      float r = length(p.xz);
      vec2 away = r > 1e-3 ? p.xz / r : vec2(0.0);
      // Each tier's upper face turns to the sky; its outer edge drops off into the shade below.
      float tier = fract((1.4 - y) * 2.0);
      n = normalize(vec3(away.x, 0.34 + 0.9 * (1.0 - tier), away.y));
      up = clamp((y + 1.0) / 2.4, 0.0, 1.0) * (0.75 + 0.25 * tier);
      return inside;
    }
    outside = t;
    t += stride;
  }
  return -1.0;
}

// The lone tree of the yard texel at (i, j), if it holds one: placed and sized by its hash.
ValleyTree valleyLoneTree(ivec2 at, vec2 p, vec4 g) {
  ValleyTree tree;
  float h = hash12(vec2(at) * 0.731 + 5.3);
  vec2 foot = (vec2(at) + 0.5) * (VALLEY_EXTENT / float(textureSize(uSim1, 0).x)) + 1.6 * (hash22(vec2(at)) - 0.5);
  float s = 0.85 + 0.15 * fract(h * 7.1);
  tree.pine = valleyPine(h);
  tree.radius = (tree.pine ? 2.8 : 3.2) * s;
  tree.top = (tree.pine ? 10.5 : 10.2) * s;
  tree.foot = vec3(foot.x, terrainSurface(g) + dot(g.zw, foot - p), foot.y);
  tree.hash = h;
  return tree;
}

// The woods' tree of crown cell \`cell\`: it stands (radius > 0) where the woods at its root outgrow
// its hash. The ground under it from g at p.
ValleyTree valleyWoodTree(vec2 cell, vec2 p, vec4 g) {
  ValleyTree tree;
  float h = hash12(cell + 2.3);
  tree.pine = valleyPine(h);
  tree.hash = h;
  float r = (tree.pine ? 2.6 : 2.7) + 0.5 * fract(h * 13.7);
  float room = 0.5 * VALLEY_CROWN_CELL - r - 0.05;
  vec2 root = (cell + 0.5) * VALLEY_CROWN_CELL + room * (2.0 * hash22(cell + 1.7) - 1.0);
  vec4 cover = terrainCover(uSim1, root, VALLEY_EXTENT);
  float stands = valleyWoods(cover, terrainWater(g), false) - (0.05 + 0.9 * fract(h * 31.7));
  // Under the envelope's swell, a metre lower than its least over the crown, varied tree by tree.
  tree.top = (valleyWoodTop(root) - 1.0) * (0.85 + 0.15 * fract(h * 5.3));
  tree.radius = stands > 0.0 ? r : 0.0;
  tree.foot = vec3(root.x, terrainSurface(g) + dot(g.zw, root - p), root.y);
  return tree;
}

// Where the ray meets the tree's trunk, a post 0.7 m across (drawn large, as the crowns are) from
// the ground up into its crown; -1 none.
float valleyTrunk(vec3 ro, vec3 rd, ValleyTree tree) {
  vec2 o = ro.xz - tree.foot.xz;
  float a = dot(rd.xz, rd.xz);
  float b = dot(o, rd.xz);
  float h = b * b - a * (dot(o, o) - 0.35 * 0.35);
  if (h < 0.0 || a < 1e-6) return -1.0;
  float t = (-b - sqrt(h)) / a;
  float y = ro.y + rd.y * t - tree.foot.y;
  float top = tree.pine ? tree.top - 2.4 * tree.radius / 0.82 + 0.8 : tree.top - 1.6 * tree.radius;
  return t > 0.0 && y > -0.5 && y < top ? t : -1.0;
}

// The crown (or trunk) the ray (ro, rd) meets beyond the bound it met at tHit (point p, ground g
// there): the lone trees of the four texels round p and the woods' trees in the next crown cells
// along the ray. t: the hit (-1 none), n its normal (world), up how high up its crown (-1: the trunk).
float valleyCrowns(vec3 ro, vec3 rd, float tHit, vec3 p, vec4 g, out ValleyTree tree, out vec3 n, out float up) {
  n = vec3(0.0, 1.0, 0.0);
  up = 0.5;
  float best = 1e9;
  float trunk = 1e9;
  ValleyTree post;
  ivec2 size = textureSize(uSim1, 0);
  ivec2 base = ivec2(floor(p.xz / VALLEY_EXTENT * vec2(size) - 0.5));
  for (int k = 0; k < 4; k++) {
    ivec2 at = clamp(base + ivec2(k - (k / 2) * 2, k / 2), ivec2(0), size - 1);
    if (texelFetch(uSim1, at, 0).w > -0.5) continue;
    ValleyTree lone = valleyLoneTree(at, p.xz, g);
    float t = valleyTreeBound(ro, rd, lone);
    if (t > 0.0 && t < best) {
      best = t;
      tree = lone;
    }
    t = valleyTrunk(ro, rd, lone);
    if (t > 0.0 && t < trunk) {
      trunk = t;
      post = lone;
    }
  }
  // The woods, crown cell by crown cell from just short of the hit (2D DDA over the cells).
  vec2 dir = rd.xz / max(length(rd.xz), 1e-4);
  vec2 from = (ro + rd * max(tHit - 1.0, 0.0)).xz;
  vec2 cell = floor(from / VALLEY_CROWN_CELL);
  vec2 stepDir = vec2(dir.x < 0.0 ? -1.0 : 1.0, dir.y < 0.0 ? -1.0 : 1.0);
  vec2 delta = VALLEY_CROWN_CELL / max(abs(dir), 1e-4);
  vec2 safe = vec2(abs(dir.x) < 1e-4 ? 1e-4 : dir.x, abs(dir.y) < 1e-4 ? 1e-4 : dir.y);
  vec2 edge = ((cell + max(stepDir, 0.0)) * VALLEY_CROWN_CELL - from) / safe;
  for (int k = 0; k < 6; k++) {
    ValleyTree wood = valleyWoodTree(cell, p.xz, g);
    if (wood.radius > 0.0) {
      float t = valleyTreeBound(ro, rd, wood);
      if (t > 0.0 && t < best) {
        best = t;
        tree = wood;
      }
      float tt = valleyTrunk(ro, rd, wood);
      if (tt > 0.0 && tt < trunk) {
        trunk = tt;
        post = wood;
      }
      // Trees stay inside their cells, so the first one met is the nearest the woods hold.
      if (t > 0.0 || tt > 0.0) break;
    }
    if (edge.x < edge.y) {
      cell.x += stepDir.x;
      edge.x += delta.x;
    } else {
      cell.y += stepDir.y;
      edge.y += delta.y;
    }
  }
  float hit = best < 1e8 ? valleyTreeHit(ro, rd, tree, best, n, up) : -1.0;
  if (trunk < 1e8 && (hit < 0.0 || trunk < hit)) {
    tree = post;
    vec2 side = normalize(ro.xz + rd.xz * trunk - post.foot.xz);
    n = vec3(side.x, 0.0, side.y);
    up = -1.0;
    return trunk;
  }
  return hit;
}

// A crown's leaves: broadleaf greens varied tree by tree, pines a dark blue-green; darker low in the
// crown and between its clumps where they resolve (foot: metres a cell spans there). A trunk
// (up < 0): bark.
vec3 valleyLeaves(ValleyTree tree, vec3 at, float up, float foot) {
  if (up < 0.0) return vec3(0.27, 0.22, 0.17);
  float h = tree.hash;
  vec3 leaf = tree.pine
    ? mix(vec3(0.11, 0.21, 0.14), vec3(0.15, 0.26, 0.15), fract(h * 3.3))
    : mix(vec3(0.21, 0.35, 0.12), vec3(0.32, 0.44, 0.15), fract(h * 9.7));
  float clumps = vnoise(at.xz * 0.9 + at.y * 0.7 + h * 40.0);
  leaf *= mix(1.0, 0.75 + 0.45 * clumps, smoothstep(1.2, 0.4, foot));
  return leaf * (0.7 + 0.3 * smoothstep(0.0, 0.65, up));
}
`;
