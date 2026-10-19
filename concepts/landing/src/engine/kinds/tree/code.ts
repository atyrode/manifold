// The tree's code (src/engine/glsl.ts, the kind contract). Every ray grows the same tree from its
// seed: a trunk of one or three tapered capsules, limbs branching from it and twigs from them (an
// oak's five limbs of two twigs, a birch's six drooping, a windswept pine's four swept one way; a
// pine's tiers hang straight off its trunk), each a rounded cone tested exactly (iq's), and clumps
// of foliage at the twigs' and limbs' tips and the crown's top: ellipsoids whose outer shell is
// leaves, a short march through a density of leaf clusters (3D value noise) that leaves holes the
// sky shows through, smooth once a cell spans a cluster. A limb and all it carries is skipped by
// one bounding sphere. Bare in winter, a deciduous crown is a haze of fine twigs. The wind at its
// crown (engineWind) leans it with the square of its height, sways each limb by its reach on its own
// phase and flutters each clump, gusts and all; its shadow is its wood and the light its clumps let
// through, dappled by the same clusters. The time of year is the World's where it keeps one
// (SKY_YEAR), else the tree's `season`.
import { glslFloat, glslVec3 } from "../../../shaders/glsl.ts";
import type { KindCode, Vec3 } from "../../types.ts";
import { TREE_ROOT, TREE_SPECIES, treeTrunk, type TreeSpecies } from "./index.ts";

type Rgb = readonly [number, number, number];

/** A species' build and colours; lengths are shares of its crown width s and height h. */
interface Shape {
  /** The trunk's capsules: its spine's points less one. */
  readonly spine: number;
  readonly limbs: number;
  /** Twigs on each limb. */
  readonly twigs: number;
  /** Tiers of boughs straight off the trunk (a pine's). */
  readonly tiers: number;
  /** A twig's reach (× s), rise (× h), and turn off its limb's heading (radians, alternating). */
  readonly twig: Vec3;
  /** Radii of a clump at a twig's tip and at a limb's tip (× s each way), of the crown's top (× s, h, s). */
  readonly twigClump: Vec3;
  readonly limbClump: Vec3;
  readonly apex: Vec3;
  /** How far the wind bends it: a birch is whippy, an old windswept pine stiff. */
  readonly give: number;
  /** Its foliage's clusters, metres, and its leaves' (the surface's flecks). */
  readonly grain: number;
  readonly leaf: number;
  readonly evergreen: boolean;
  readonly bark: Rgb;
  /** Spring's fresh leaves, summer's, autumn's turn and its last brown (an evergreen: its needles all year). */
  readonly spring: Rgb;
  readonly summer: Rgb;
  readonly autumn: Rgb;
  readonly fallen: Rgb;
  /** When its leaves fall: the year positions the fall starts and ends. */
  readonly fall: readonly [number, number];
}

const SHAPES: Readonly<Record<TreeSpecies, Shape>> = {
  oak: {
    spine: 1,
    limbs: 5,
    twigs: 2,
    tiers: 0,
    twig: [0.13, 0.1, 0.6],
    twigClump: [0.17, 0.13, 0.17],
    limbClump: [0.18, 0.14, 0.18],
    apex: [0.24, 0.17, 0.24],
    give: 1,
    grain: 0.5,
    leaf: 0.07,
    evergreen: false,
    bark: [0.27, 0.23, 0.19],
    spring: [0.44, 0.58, 0.17],
    summer: [0.24, 0.4, 0.12],
    autumn: [0.56, 0.33, 0.09],
    fallen: [0.36, 0.22, 0.1],
    fall: [0.62, 0.78],
  },
  birch: {
    spine: 3,
    limbs: 6,
    twigs: 1,
    tiers: 0,
    twig: [0.12, -0.05, 0.5],
    twigClump: [0.16, 0.2, 0.16],
    limbClump: [0.17, 0.2, 0.17],
    apex: [0.16, 0.08, 0.16],
    give: 1.5,
    grain: 0.36,
    leaf: 0.05,
    evergreen: false,
    bark: [0.84, 0.83, 0.78],
    spring: [0.52, 0.64, 0.2],
    summer: [0.33, 0.48, 0.15],
    autumn: [0.86, 0.66, 0.15],
    fallen: [0.62, 0.45, 0.14],
    fall: [0.57, 0.72],
  },
  pine: {
    spine: 1,
    limbs: 0,
    twigs: 0,
    tiers: 7,
    twig: [0, 0, 0],
    twigClump: [0, 0, 0],
    limbClump: [0, 0, 0],
    apex: [0.07, 0.08, 0.07],
    give: 0.8,
    grain: 0.3,
    leaf: 0.04,
    evergreen: true,
    bark: [0.37, 0.24, 0.16],
    spring: [0.17, 0.3, 0.13],
    summer: [0.14, 0.27, 0.13],
    autumn: [0.12, 0.22, 0.11],
    fallen: [0.11, 0.19, 0.11],
    fall: [2, 2],
  },
  windswept: {
    spine: 3,
    limbs: 4,
    twigs: 1,
    tiers: 0,
    twig: [0.14, 0.02, 0.4],
    twigClump: [0.18, 0.065, 0.15],
    limbClump: [0.15, 0.06, 0.13],
    apex: [0.17, 0.07, 0.14],
    give: 0.6,
    grain: 0.3,
    leaf: 0.04,
    evergreen: true,
    bark: [0.33, 0.27, 0.22],
    spring: [0.18, 0.3, 0.14],
    summer: [0.15, 0.28, 0.13],
    autumn: [0.13, 0.24, 0.12],
    fallen: [0.12, 0.21, 0.12],
    fall: [2, 2],
  },
};

/** A bare crown's twigs. */
const TWIG: Rgb = [0.2, 0.17, 0.15];

/** The trunk's spine point k (1 up; 0 is its root) of each species, unbent, as GLSL statements. */
const SPINE: Readonly<Record<TreeSpecies, string>> = {
  oak: `    if (k == 1) return vec3(j.x * 0.06 * f.s, 0.42 * f.h, j.y * 0.06 * f.s);`,
  birch: `    float y = k == 1 ? 0.36 : k == 2 ? 0.68 : 0.98;
    return vec3(j.x * 0.05 * f.h, y * f.h, j.y * 0.05 * f.h);`,
  pine: `    if (k == 1) return vec3(j.x * 0.02 * f.h, 0.98 * f.h, j.y * 0.02 * f.h);`,
  windswept: `    if (k == 1) return vec3((0.1 + 0.05 * j.x) * f.s, 0.33 * f.h, 0.08 * j.y * f.s);
    if (k == 2) return vec3(0.3 * f.s, 0.6 * f.h, -0.08 * j.y * f.s);
    if (k == 3) return vec3(0.44 * f.s, 0.76 * f.h, 0.05 * j.x * f.s);`,
};

/**
 * Limb j (k = float(j)) of each species, unbent: its base `a` on the trunk, its tip `b`, its
 * heading `az` and its radii `r` (× the trunk's), as GLSL statements. A pine has none.
 */
const LIMB: Readonly<Record<TreeSpecies, string>> = {
  oak: `    a = treeSpine(f, 1) + vec3(0.0, 0.05 * f.h * treeRand(f, 20.0 + k), 0.0);
    az = (k + 0.5 + 0.5 * (treeRand(f, 10.0 + k) - 0.5)) * TAU / 5.0 + f.seed;
    float run = 0.24 * f.s * (0.8 + 0.4 * treeRand(f, 30.0 + k));
    b = a + vec3(cos(az) * run, 0.22 * f.h * (0.7 + 0.6 * treeRand(f, 40.0 + k)), sin(az) * run);
    r = vec2(0.42, 0.2);`,
  birch: `    int seg = 1 + j / 3;
    a = mix(treeSpine(f, seg), treeSpine(f, seg + 1), 0.2 + 0.3 * float(j - 3 * (j / 3)));
    az = k * 2.39996 + f.seed + 0.6 * (treeRand(f, 10.0 + k) - 0.5);
    float run = 0.2 * f.s * (0.8 + 0.4 * treeRand(f, 30.0 + k));
    b = a + vec3(cos(az) * run, 0.13 * f.h * (0.7 + 0.6 * treeRand(f, 40.0 + k)), sin(az) * run);
    r = vec2(0.32, 0.12) * (1.0 - 0.25 * float(seg));`,
  pine: "",
  windswept: `    a = j == 0 ? treeSpine(f, 1) : j == 1 ? treeSpine(f, 2) : j == 2 ? mix(treeSpine(f, 2), treeSpine(f, 3), 0.6) : treeSpine(f, 3);
    az = (j - 2 * (j / 2) == 0 ? -1.0 : 1.0) * (0.35 + 0.45 * treeRand(f, 10.0 + k));
    float run = 0.26 * f.s * (0.75 + 0.5 * treeRand(f, 30.0 + k));
    b = a + vec3(cos(az) * run, 0.05 * f.h * (treeRand(f, 40.0 + k) - 0.35), sin(az) * run);
    r = vec2(0.5, 0.22) * (1.0 - 0.12 * k);`,
};

/** The crown's top clump's centre of each species, unbent. */
const APEX: Readonly<Record<TreeSpecies, string>> = {
  oak: "treeSpine(f, 1) + vec3(0.0, 0.3 * f.h, 0.0)",
  birch: "treeSpine(f, 3) + vec3(0.0, 0.02 * f.h, 0.0)",
  pine: "treeSpine(f, 1) - vec3(0.0, 0.02 * f.h, 0.0)",
  windswept: "treeSpine(f, 3) + vec3(0.06 * f.s, 0.03 * f.h, 0.0)",
};

export const glsl: KindCode["glsl"] = (compiled) => {
  const mask = compiled["species"] ?? 1;
  const held = TREE_SPECIES.filter((_, k) => (mask & (1 << k)) !== 0);
  // A value by the instance's species (`f.species`), for the species the program holds.
  const pick = (value: (shape: Shape, species: TreeSpecies) => string): string => {
    const [first, ...rest] = held;
    if (first === undefined) return "0.0";
    const chain = rest.reduceRight(
      (otherwise, species) =>
        `f.species == ${TREE_SPECIES.indexOf(species)} ? ${value(SHAPES[species], species)} : ${otherwise}`,
      value(SHAPES[first], first),
    );
    return rest.length === 0 ? chain : `(${chain})`;
  };
  const num = (value: (shape: Shape) => number) => pick((shape) => glslFloat(value(shape)));
  const vec = (value: (shape: Shape) => Rgb | Vec3) => pick((shape) => glslVec3(value(shape)));
  const int = (value: (shape: Shape) => number) => pick((shape) => String(value(shape)));
  // Each species' own statements, for the species the program holds.
  const each = (code: Readonly<Record<TreeSpecies, string>>) =>
    held
      .filter((species) => code[species] !== "")
      .map(
        (species) =>
          `  if (f.species == ${TREE_SPECIES.indexOf(species)}) {\n${code[species]}\n  }`,
      )
      .join("\n");
  const tiers = held.some((species) => SHAPES[species].tiers > 0);
  const limbs = held.some((species) => SHAPES[species].limbs > 0);
  return `
const float TREE_ROOT = ${glslFloat(TREE_ROOT)};
// The most spine capsules, limbs, twigs a limb and tiers of any species; the march through a clump.
const int TREE_SPINE = 3;
const int TREE_LIMBS = 6;
const int TREE_TWIGS = 2;
const int TREE_TIERS = 7;
const int TREE_LEAF_STEPS = 6;
// A limb's sway, radians a second, and a clump's flutter.
const float TREE_RATE = 1.7;
const float TREE_FLUTTER_RATE = 3.3;
const vec3 TREE_TWIG = ${glslVec3(TWIG)};

// One tree now: its species and size, its seed, its trunk's radius, how far into leaf it is, and
// the wind's lean of its top and sway of its limbs (its own frame, metres).
struct TreeForm {
  int species;
  float h;
  float s;
  float seed;
  float r;
  float leafy;
  vec3 lean;
  vec3 sway;
  float flutter;
  float tm;
};

float treeRand(TreeForm f, float k) {
  return hash12(vec2(k * 1.618 + 3.1, f.seed * 0.731 + 11.7));
}

// The time of year: the World's where it keeps one, else the tree's own.
float treeYear(EngineObj o) {
  return fract(SKY_YEAR >= 0.0 ? SKY_YEAR : treeSeason(o));
}

// How far into leaf the tree is at year position y: out over spring, falling in autumn.
float treeLeafy(TreeForm f, float y) {
  if (${pick(({ evergreen }) => String(evergreen))}) return 1.0;
  return smoothstep(0.03, 0.16, y) * (1.0 - smoothstep(${num(({ fall }) => fall[0])}, ${num(({ fall }) => fall[1])}, y));
}

TreeForm treeForm(EngineObj o) {
  TreeForm f;
  f.species = int(treeSpecies(o) + 0.5);
  f.h = treeHeight(o);
  f.s = treeSpread(o);
  f.seed = floor(treeSeed(o) + 0.5);
  f.r = ${pick((_, species) => `${glslFloat(treeTrunk(species, 1, 0))} * f.h + ${glslFloat(treeTrunk(species, 0, 1))} * f.s`)};
  f.leafy = treeLeafy(f, treeYear(o));
  // The wind at its crown, in its own frame: drag with the square of the speed leans the top a few
  // hundredths of the height in a gale; the limbs sway with the speed.
  vec3 wind = engineDirToObject(o, engineWind(vec3(o.at.x, o.scale * f.h * 0.75, o.at.z), uMotionTime));
  float speed = length(wind);
  vec3 down = speed > 1e-3 ? wind / speed : vec3(1.0, 0.0, 0.0);
  float give = ${num(({ give }) => give)};
  f.lean = down * f.h * min(0.0002 * speed * speed * give, 0.08);
  f.sway = (down * 0.7 + vec3(-down.z, 0.0, down.x) * 0.5) * min(0.0035 * speed * give, 0.06);
  f.flutter = min(0.004 * speed, 0.06);
  f.tm = uMotionTime;
  return f;
}

// Point p of the tree (unbent) where the wind has moved it: the whole tree leans with the square of
// its height, and a limb sways by its reach from the trunk on its own phase.
vec3 treeBend(TreeForm f, vec3 p, float reach, float phase) {
  float up = clamp(p.y / f.h, 0.0, 1.5);
  float beat = sin(f.tm * TREE_RATE + phase) + 0.4 * sin(f.tm * TREE_RATE * 2.3 + phase * 1.7);
  return p + f.lean * up * up * (1.0 + 0.15 * sin(f.tm * 0.9 + f.seed)) + f.sway * reach * beat;
}

// A clump's own flutter on top of its limb's sway (size: its radius).
vec3 treeFlutter(TreeForm f, float k, float size) {
  float ph = k * 2.7 + f.seed;
  return f.flutter * size * vec3(sin(f.tm * TREE_FLUTTER_RATE + ph), 0.5 * sin(f.tm * TREE_FLUTTER_RATE * 0.77 + ph * 1.3), cos(f.tm * TREE_FLUTTER_RATE * 1.13 + ph));
}

// The trunk's spine point k, unbent (0: its root, under the ground).
vec3 treeSpine(TreeForm f, int k) {
  if (k == 0) return vec3(0.0, -TREE_ROOT, 0.0);
  vec2 j = vec2(treeRand(f, 1.0 + float(k)), treeRand(f, 5.0 + float(k))) - 0.5;
${each(SPINE)}
  return vec3(0.0, f.h, 0.0);
}
${
  limbs
    ? `
// Limb j, unbent: base a, tip b, heading az, radii r (× the trunk's).
void treeLimb(TreeForm f, int j, out vec3 a, out vec3 b, out float az, out vec2 r) {
  float k = float(j);
  a = vec3(0.0);
  b = vec3(0.0, 1.0, 0.0);
  az = 0.0;
  r = vec2(0.0);
${each(LIMB)}
}

// Twig w of limb j (unbent a .. b, heading az), unbent: its base, its tip, and how far each
// reaches from the trunk along the limb.
void treeTwig(TreeForm f, int j, int w, vec3 a, vec3 b, float az, out vec3 base, out vec3 tip, out vec2 reach) {
  float k = float(j * 2 + w);
  float along = w == 0 ? 1.0 : 0.55;
  base = mix(a, b, along);
  vec3 shape = ${vec(({ twig }) => twig)};
  float turn = az + (w == 0 ? 1.0 : -1.0) * shape.z * (0.6 + 0.8 * treeRand(f, 90.0 + k));
  float run = shape.x * f.s * (0.8 + 0.4 * treeRand(f, 100.0 + k));
  tip = base + vec3(cos(turn) * run, shape.y * f.h * (0.6 + 0.8 * treeRand(f, 110.0 + k)), sin(turn) * run);
  float limb = length(b - a) * along;
  reach = vec2(limb, limb + run);
}
`
    : ""
}
// The ray against the tapered capsule from a (radius ra) to b (radius rb), iq's rounded cone: its
// nearer t within lo..hi, else -1; n its normal there.
float treeCone(vec3 ro, vec3 rd, vec3 a, vec3 b, float ra, float rb, float lo, float hi, out vec3 n) {
  n = vec3(0.0, 1.0, 0.0);
  // Its bounding sphere first.
  vec3 oc = ro - 0.5 * (a + b);
  float rad = 0.5 * length(b - a) + max(ra, rb);
  float bb = dot(oc, rd);
  float hh = bb * bb - dot(oc, oc) + rad * rad;
  if (hh < 0.0) return -1.0;
  hh = sqrt(hh);
  if (-bb + hh < lo || -bb - hh > hi) return -1.0;
  vec3 ba = b - a;
  vec3 oa = ro - a;
  vec3 ob = ro - b;
  float rr = ra - rb;
  float m0 = dot(ba, ba);
  float m1 = dot(ba, oa);
  float m2 = dot(ba, rd);
  float m3 = dot(rd, oa);
  float m5 = dot(oa, oa);
  float m6 = dot(ob, rd);
  float m7 = dot(ob, ob);
  float d2 = m0 - rr * rr;
  float k2 = d2 - m2 * m2;
  float k1 = d2 * m3 - m1 * m2 + m2 * rr * ra;
  float k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2.0 - m0 * ra * ra;
  float h = k1 * k1 - k0 * k2;
  if (h < 0.0) return -1.0;
  float t = (-sqrt(h) - k1) / k2;
  float y = m1 - ra * rr + t * m2;
  if (y > 0.0 && y < d2) {
    n = normalize(d2 * (oa + t * rd) - ba * y);
    return t >= lo && t <= hi ? t : -1.0;
  }
  // Its rounded ends.
  float h1 = m3 * m3 - m5 + ra * ra;
  float h2 = m6 * m6 - m7 + rb * rb;
  float best = -1.0;
  if (h1 > 0.0) {
    t = -m3 - sqrt(h1);
    if (t >= lo && t <= hi) {
      best = t;
      n = (oa + t * rd) / ra;
    }
  }
  if (h2 > 0.0) {
    t = -m6 - sqrt(h2);
    if (t >= lo && t <= hi && (best < 0.0 || t < best)) {
      best = t;
      n = (ob + t * rd) / rb;
    }
  }
  return best;
}

// Where the ray is inside the ellipsoid at c of radii e: t from x to y (none where x > y).
vec2 treeEllipsoid(vec3 ro, vec3 rd, vec3 c, vec3 e) {
  vec3 oc = (ro - c) / e;
  vec3 d = rd / e;
  float a = dot(d, d);
  float b = dot(oc, d);
  float h = b * b - a * (dot(oc, oc) - 1.0);
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h) / a;
}

// Value noise in 3D, 0..1: two layers of vnoise blended across z.
float treeNoise(vec3 p) {
  float z = floor(p.z);
  float u = p.z - z;
  u = u * u * (3.0 - 2.0 * u);
  return mix(vnoise(p.xy + z * vec2(17.13, 31.71)), vnoise(p.xy + (z + 1.0) * vec2(17.13, 31.71)), u);
}

// A clump's foliage at x (from its centre in clusters, seeded; q: the point in its unit sphere):
// above 0 inside its leaves. Clusters of leaves and, nearer (fine: their share), the sprays within
// them; a clump in leaf is a lumpy shell deep enough for the sky to show through its holes, a bare
// one a sparse haze of twigs.
float treeLeaves(float leafy, vec3 q, vec3 x, float amp, float fine) {
  float noise = treeNoise(x);
  if (fine > 0.0) noise = mix(noise, treeNoise(x * 2.7 + 5.3), 0.4 * fine);
  // Value noise keeps near its mean: stretched, its clusters and the gaps between them are clear.
  noise = smoothstep(0.25, 0.75, noise);
  return (1.0 - length(q)) * mix(0.6, 0.8, leafy) - mix(0.32, 0.08, leafy) + amp * (noise - 0.5);
}

// A ray through one tree: the nearest hit so far (t, its normal, its part) or, for a shadow ray,
// the light let through so far.
struct TreeRay {
  vec3 o;
  vec3 d;
  float lo;
  float hi;
  bool shadow;
  float t;
  vec3 n;
  float part;
  float lit;
  float grain;   // the clumps' clusters, metres
  float dapple;  // a shadow's share of dappling, by the lit surface's footprint
};

// A capsule of wood: the nearest hit, or no light past it.
void treeWood(inout TreeRay r, vec3 a, vec3 b, vec2 radii) {
  if (r.lit <= 0.0) return;
  vec3 n;
  float t = treeCone(r.o, r.d, a, b, radii.x, radii.y, r.lo, r.hi, n);
  if (t < 0.0) return;
  if (r.shadow) {
    r.lit = 0.0;
    return;
  }
  r.t = t;
  r.hi = t;
  r.n = n;
  r.part = -1.0;
}

// A clump of leaves at c of radii e (k: its own number, for its clusters): the nearest of its
// leaves, or the light it lets through.
void treeClump(inout TreeRay r, TreeForm f, vec3 c, vec3 e, float k) {
  if (r.lit <= 0.0) return;
  e *= 0.75 + 0.25 * f.leafy;
  vec2 s = treeEllipsoid(r.o, r.d, c, e);
  float t0 = max(s.x, r.lo);
  float t1 = min(s.y, r.hi);
  if (t0 >= t1) return;
  vec3 seed = vec3(k * 7.31, f.seed * 0.37, k * 3.17);
  if (r.shadow) {
    float cover = 1.0 - exp(-mix(0.7, 3.4, f.leafy) / min(min(e.x, e.y), e.z) * (t1 - t0));
    float gaps = smoothstep(0.2, 0.65, treeNoise((r.o + r.d * (0.5 * (t0 + t1)) - c) / (1.4 * r.grain) + seed));
    r.lit *= 1.0 - 0.88 * cover * mix(1.0, gaps, r.dapple);
    if (r.lit < 0.02) r.lit = 0.0;
    return;
  }
  // The leaves' clusters, fading to the clump's smooth shell once a cell spans one; the march goes
  // no deeper than its leaves can be.
  float foot = t0 * engineCell;
  float amp = 1.0 - smoothstep(0.35, 1.0, foot / r.grain);
  float fine = 1.0 - smoothstep(0.2, 0.5, foot / (0.37 * r.grain));
  float dt = min(t1 - t0, 0.9 * min(min(e.x, e.y), e.z)) / float(TREE_LEAF_STEPS);
  float t = t0;
  vec3 p = r.o + r.d * t;
  float d = treeLeaves(f.leafy, (p - c) / e, (p - c) / r.grain + seed, amp, fine);
  float before = d;
  for (int i = 0; i < TREE_LEAF_STEPS; i++) {
    if (d >= 0.0) break;
    before = d;
    t += dt;
    p = r.o + r.d * t;
    d = treeLeaves(f.leafy, (p - c) / e, (p - c) / r.grain + seed, amp, fine);
  }
  if (d < 0.0) return;
  if (t > t0) t -= dt * d / max(d - before, 1e-4);
  if (t > r.hi) return;
  vec3 q = (r.o + r.d * t - c) / e;
  r.t = t;
  r.hi = t;
  r.n = normalize(q / e);
  r.part = clamp(1.0 - length(q), 0.0, 0.99);
}

TreeRay treeTrace(EngineObj o, vec3 ro, vec3 rd, vec2 span, bool shadow) {
  TreeForm f = treeForm(o);
  TreeRay r;
  r.o = ro;
  r.d = rd;
  r.lo = span.x;
  r.hi = span.y;
  r.shadow = shadow;
  r.t = -1.0;
  r.n = vec3(0.0, 1.0, 0.0);
  r.part = -1.0;
  r.lit = 1.0;
  r.grain = mix(0.09, ${num(({ grain }) => grain)}, f.leafy);
  r.dapple = 0.85 * (1.0 - smoothstep(0.3, 1.2, engineFoot / r.grain));
  int spine = ${int(({ spine }) => spine)};
  for (int i = 0; i < TREE_SPINE; i++) {
    if (i >= spine) break;
    float n = float(spine);
    vec2 radii = f.r * vec2(i == 0 ? 1.25 : 1.0 - 0.75 * float(i) / n, 1.0 - 0.75 * float(i + 1) / n);
    treeWood(r, treeBend(f, treeSpine(f, i), 0.0, 0.0), treeBend(f, treeSpine(f, i + 1), 0.0, 0.0), radii);
  }
${
  limbs
    ? `  int limbs = ${int(({ limbs }) => limbs)};
  int twigs = ${int(({ twigs }) => twigs)};
  vec3 twigShape = ${vec(({ twig }) => twig)};
  vec3 twigClump = ${vec(({ twigClump }) => twigClump)} * f.s;
  vec3 limbClump = ${vec(({ limbClump }) => limbClump)} * f.s;
  float carried = 1.2 * twigShape.x * f.s + 1.2 * max(twigClump.x, max(twigClump.y, limbClump.x)) + abs(twigShape.y) * f.h;
  for (int j = 0; j < TREE_LIMBS; j++) {
    if (j >= limbs || r.lit <= 0.0) break;
    vec3 la, lb;
    float az;
    vec2 lr;
    treeLimb(f, j, la, lb, az, lr);
    float phase = TAU * treeRand(f, 60.0 + float(j));
    float run = length(lb - la);
    vec3 a = treeBend(f, la, 0.0, phase);
    vec3 b = treeBend(f, lb, run, phase);
    // The limb and all it carries, within one sphere.
    vec3 oc = r.o - 0.5 * (a + b);
    float rad = 0.5 * run + carried;
    float bb = dot(oc, r.d);
    float hh = bb * bb - dot(oc, oc) + rad * rad;
    if (hh < 0.0 || -bb + sqrt(hh) < r.lo || -bb - sqrt(hh) > r.hi) continue;
    treeWood(r, a, b, lr * f.r);
    for (int w = 0; w < TREE_TWIGS; w++) {
      if (w >= twigs) break;
      vec3 base, tip;
      vec2 reach;
      treeTwig(f, j, w, la, lb, az, base, tip, reach);
      vec3 bent = treeBend(f, tip, reach.y, phase);
      float ra = mix(lr.x, lr.y, w == 0 ? 1.0 : 0.55) * f.r;
      // A twig is too thin to matter to a shadow its clump casts.
      if (!r.shadow) treeWood(r, treeBend(f, base, reach.x, phase), bent, vec2(ra, 0.4 * ra));
      float k = float(j * 2 + w);
      vec3 e = twigClump * (0.85 + 0.3 * treeRand(f, 120.0 + k));
      treeClump(r, f, bent + treeFlutter(f, k, e.x), e, k);
    }
    float k = float(20 + j);
    vec3 e = limbClump * (0.85 + 0.3 * treeRand(f, 120.0 + k));
    treeClump(r, f, treeBend(f, lb + vec3(0.0, 0.3 * e.y, 0.0), run, phase) + treeFlutter(f, k, e.x), e, k);
  }
`
    : ""
}${
    tiers
      ? `  if (f.species == ${TREE_SPECIES.indexOf("pine")}) {
    // A pine's tiers of boughs, narrowing up the trunk.
    for (int i = 0; i < TREE_TIERS; i++) {
      float k = float(40 + i);
      float u = float(i) / float(TREE_TIERS);
      vec3 c = mix(treeSpine(f, 0), treeSpine(f, 1), ((0.25 + 0.62 * u) * f.h + TREE_ROOT) / (0.98 * f.h + TREE_ROOT));
      c.xz += (vec2(treeRand(f, 70.0 + k), treeRand(f, 80.0 + k)) - 0.5) * 0.05 * f.s;
      float wide = 0.5 * f.s * pow(1.0 - 0.92 * u, 0.9) + 0.05 * f.s;
      vec3 e = vec3(wide, 0.09 * f.h * (1.0 - 0.4 * u), wide);
      treeClump(r, f, treeBend(f, c, 0.6 * wide, TAU * treeRand(f, 60.0 + k)) + treeFlutter(f, k, wide), e, k);
    }
  }
`
      : ""
  }  vec3 apex = ${vec(({ apex }) => apex)};
  vec3 e = vec3(apex.x * f.s, apex.y * f.h, apex.z * f.s);
  treeClump(r, f, treeBend(f, ${pick((_, species) => APEX[species])}, 0.0, 0.0) + treeFlutter(f, 50.0, e.x), e, 50.0);
  return r;
}

float treeHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  TreeRay r = treeTrace(o, ro, rd, span, false);
  n = r.n;
  part = r.part;
  return r.t;
}

// The tree between a point and a light: its wood blocks it; each clump lets through what its leaves
// leave, by its chord through it, dappled by its clusters while the lit surface resolves them.
float treeShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  return clamp(treeTrace(o, ro, rd, span, true).lit, 0.0, 1.0);
}

void treeSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  TreeForm f;
  f.species = int(treeSpecies(o) + 0.5);
  f.seed = floor(treeSeed(o) + 0.5);
  float foot = length(enginePointToWorld(o, p) - engineCamera().eye) / o.scale * engineCell;
  h.rough = 1.0;
  if (part < 0.0) {
    // Bark: a birch's white, banded with dark lenticels and dark at the foot; the others' furrowed.
    vec3 bark = ${vec(({ bark }) => bark)};
    float furrow = fbmLod(vec2((p.x + p.z) * 9.0, p.y * 2.2), foot * 9.0, 3).x;
    if (f.species == ${TREE_SPECIES.indexOf("birch")}) {
      vec2 band = fbmLod(vec2((p.x - p.z) * 5.0, p.y * 16.0), foot * 16.0, 2);
      bark *= 1.0 - 0.75 * smoothstep(0.6, 0.72, band.x) * band.y - 0.5 * smoothstep(0.25, 0.0, p.y / treeHeight(o)) * furrow;
    } else {
      bark *= 0.7 + 0.6 * furrow;
    }
    h.albedo = bark;
    h.mat = 0;
    return;
  }
  float year = treeYear(o);
  float leafy = treeLeafy(f, year);
  // The leaves by the time of year, each part of the crown turning in its own time.
  float turn = hash12(floor(p.xz * 0.8 + p.y * 0.5) + f.seed * 0.13);
  vec3 leaf = mix(${vec(({ spring }) => spring)}, ${vec(({ summer }) => summer)}, smoothstep(0.1, 0.3, year));
  leaf = mix(leaf, ${vec(({ autumn }) => autumn)}, smoothstep(0.46, 0.6, year - 0.06 * (turn - 0.5)));
  leaf = mix(leaf, ${vec(({ fallen }) => fallen)}, smoothstep(0.62, 0.74, year + 0.04 * turn));
  leaf *= 0.85 + 0.3 * turn;
  // Leaf by leaf, up close: each its own tilt and shade, the bare twigs between them as they fall.
  float size = ${num(({ leaf }) => leaf)};
  vec3 cell = floor(p / size);
  vec3 jitter = vec3(hash12(cell.xy + cell.z * 7.1), hash12(cell.yz + 3.3), hash12(cell.zx + 5.1)) - 0.5;
  float keep = 1.0 - smoothstep(0.4, 1.2, foot / size);
  float clothed = mix(smoothstep(0.1, 0.6, leafy), step(jitter.y + 0.5, leafy), keep);
  vec3 albedo = mix(TREE_TWIG, leaf * (1.0 + 0.6 * jitter.x * keep), clothed);
  // Deep in the clump the leaves are in each other's shade.
  h.albedo = albedo * mix(1.0, 0.45, smoothstep(0.0, 0.35, part));
  n = normalize(n + vec3(0.0, 0.5, 0.0) + jitter * 0.9 * keep);
  h.rough = mix(1.0, 0.8, clothed);
  h.mat = 1;
}
`;
};
