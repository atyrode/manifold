// Fish for water scenes: how they swim (CPU) and how they look (GLSL). A scene supplies the water:
// its units and bounds, where each fish wants to be, the pointer, and the depth, refraction and
// light the fish are drawn in. Koi in `pond` are the first consumer; the rock pool fish in
// `tidepool` (BLENNY, FISH_BLENNY) the second.
//
// Swimming (FishGroup). Every fish has a position, a heading and a speed and moves the way it faces:
// it never slides sideways, turns at most `turnRate` and changes speed at most `accel`, so whatever
// it is asked to do reads as swimming. Each step the scene clears what the fish want (a velocity),
// adds behaviours, and swims:
//   clear(count)                           forget the last step's wants
//   follow(i, x, y, vx, vy, weight?)       keep up with a moving point (a loop, a leader, a lane): its
//                                          velocity plus a pull toward it of `catchUp` per second
//   gather(i, x, y, radius, weight?)       come to a point and idle about it, nose to it (food, the
//                                          pointer); slows inside `radius`
//   flee(i, x, y, reach, weight?)          dart away from a point within `reach`
//   wander(i, clock, weight?)              a slow weave of its own (phase from the fish's salt)
//   school(count, weight?)                 swim like the neighbours and keep near them (species.school;
//                                          nothing for a solitary species)
//   space(count, weight?)                  light separation: veer away from any fish closer than
//                                          `spacing` body lengths, so a crowd mills instead of piling
//   within(i, minX, minY, maxX, maxY, margin)  soft walls
//   swim(count, h)                         turn toward the want, speed up or slow to its size (a want
//                                          behind it slows the fish while it turns), and move
// `pace` scales the species' speeds, turning and acceleration (a swim-speed knob); wants are plain
// velocities. Nothing here draws random numbers: the scene seeds each fish (place: length, salt), so a
// group is deterministic for its inputs. Fish at or past `count` are left as they are.
//
// Drawing (FishTexture, fishGlsl). FishTexture packs a group into an rgba16f texture, `capacity`
// texels wide and three rows high (rows bottom to top, nearest filtering):
//   row 0  x (hi, lo), y (hi, lo): splitHalf pairs, so positions keep ~22 bits
//   row 1  heading cos, sin, speed (units/s), body length (0: hidden, past `count`)
//   row 2  the scene's own four values per fish (FishGroup.tag)
// fishGlsl (paste once into the scene's glsl; it needs `common`) reads and draws them:
//   FishPose fishPose(sampler2D poses, int i)         at, dir, speed, len, tag
//   float fishTop(vec2 q, float len, float swim, FishBody body)
//       seen from above, in the fish's frame (x forward from the nose, y across): 0 outside, 1 body,
//       2 fin or tail; `swim` the tail beat's phase (radians, advancing ~3-7 per second)
//   bool fishTopEye(vec2 q, float len)                the eyes, set wide on the head
//   vec3 fishKoiCoat(float variety, float marking, out float tone)
//       a koi's colour where its pattern noise is `marking` (0..1), variety 0..1 picking plain red,
//       kohaku, showa or ogon; tone 0 dark, 1 white, 2 colour (for ink and accent)
//   float fishSide(vec2 q)                            seen side-on, q in body lengths (x toward the
//       snout from mid-body, y up): > 0 inside the spindle body and forked tail
//   FISH_KOI, FISH_BLENNY                             koi's FishBody; a rock pool fish's (slim,
//       blunt-headed, broad pectoral fans)
// Shadows, refraction, caustics, haze and passages stay with the scene.
//
// Usage (see scenes/pond/koi.ts):
//   const group = new FishGroup(KOI, 8);
//   for (let i = 0; i < 8; i++) group.place(i, x0, y0, 0, KOI.cruise, length[i], salt[i]);
//   // each fixed step h:
//   group.pace = pace;
//   group.clear(8);
//   for (let i = 0; i < 8; i++) group.follow(i, tx, ty, tvx, tvy);
//   group.space(count);
//   group.swim(8, h);
//   poses.upload(group, count, clock.pending);
//   // GLSL:
//   FishPose f = fishPose(uSim2, i);
//   vec2 rel = p - f.at;
//   float shape = fishTop(vec2(dot(rel, f.dir), dot(rel, vec2(-f.dir.y, f.dir.x))), f.len, swim, FISH_KOI);
import { splitHalf } from "./half.ts";
import { easeFactor } from "./math.ts";
import { DataTexture } from "./texture.ts";

const TAU = Math.PI * 2;

/** How a kind of fish swims. Lengths in body lengths, everything else in the scene's units. */
export interface FishSpecies {
  /** Speeds at pace 1 (units per second): cruising, slowest (a fish idles in slow circles, never still), fastest. */
  readonly cruise: number;
  readonly minSpeed: number;
  readonly maxSpeed: number;
  /** Fastest turn (radians per second) and change of speed (units per second²) at pace 1. */
  readonly turnRate: number;
  readonly accel: number;
  /** How quickly `follow` closes a gap, per second at pace 1. */
  readonly catchUp: number;
  /** Personal space: centres kept this many body lengths apart (the pair's mean length), and how firmly (0 lets them overlap). */
  readonly spacing: number;
  readonly spacingPull: number;
  /** A school: neighbours within `align` body lengths are matched in velocity (share 0..1), those within `cohere` drawn together (per second); undefined for a solitary fish. */
  readonly school?: {
    readonly align: number;
    readonly cohere: number;
    readonly alignPull: number;
    readonly coherePull: number;
  };
  /** Each fish's own weave: sideways want as a share of cruising speed, and its rate (radians per second). */
  readonly wander: number;
  readonly wanderRate: number;
}

/** Koi: big, slow and solitary, gliding on long curves; they mill around food without schooling. */
export const KOI: FishSpecies = {
  cruise: 0.22,
  minSpeed: 0.03,
  maxSpeed: 0.4,
  turnRate: 2.6,
  accel: 0.45,
  catchUp: 1.6,
  spacing: 1.1,
  spacingPull: 2,
  wander: 0.25,
  wanderRate: 0.45,
};

/**
 * Rock pool fish (blennies, sculpins): small and alone, idling slowly over the bottom and darting
 * off in quick turns; scene units are body-length agnostic, tuned for fish ~0.02 units long.
 */
export const BLENNY: FishSpecies = {
  cruise: 0.025,
  minSpeed: 0.004,
  maxSpeed: 0.22,
  turnRate: 5,
  accel: 0.9,
  catchUp: 1.5,
  spacing: 1.6,
  spacingPull: 2,
  wander: 0.7,
  wanderRate: 0.8,
};

export class FishError extends Error {}

/** A group of fish of one species (see the header). */
export class FishGroup {
  readonly capacity: number;
  species: FishSpecies;
  /** Multiplies the species' speeds, turning and acceleration. */
  pace = 1;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Radians, 0 toward +x. */
  readonly heading: Float64Array;
  readonly speed: Float64Array;
  /** Body length, in the scene's units. */
  readonly length: Float64Array;
  /** The scene's 0..1 per fish: the phase of its weave. */
  readonly salt: Float64Array;
  /** How fast each fish is turning (radians per second), eased over ~0.2 s: for a flash or a bend. */
  readonly turning: Float64Array;
  /** Four values per fish of the scene's own, packed into FishTexture's row 2. */
  readonly tag: Float32Array;
  readonly #wx: Float64Array;
  readonly #wy: Float64Array;

  constructor(species: FishSpecies, capacity: number) {
    if (!(Number.isInteger(capacity) && capacity >= 1))
      throw new FishError(`a fish group holds a whole number ≥ 1 of fish, got ${capacity}`);
    this.capacity = capacity;
    this.species = species;
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.heading = new Float64Array(capacity);
    this.speed = new Float64Array(capacity);
    this.length = new Float64Array(capacity);
    this.salt = new Float64Array(capacity);
    this.turning = new Float64Array(capacity);
    this.tag = new Float32Array(4 * capacity);
    this.#wx = new Float64Array(capacity);
    this.#wy = new Float64Array(capacity);
  }

  /** Put fish i somewhere, facing `heading` at `speed`, with its body length and salt. */
  place(
    i: number,
    x: number,
    y: number,
    heading: number,
    speed: number,
    length: number,
    salt: number,
  ): void {
    this.x[i] = x;
    this.y[i] = y;
    this.heading[i] = heading;
    this.speed[i] = speed;
    this.length[i] = length;
    this.salt[i] = salt;
    this.turning[i] = 0;
  }

  /** Forget the wants of fish 0..count-1. */
  clear(count: number): void {
    this.#wx.fill(0, 0, count);
    this.#wy.fill(0, 0, count);
  }

  /** Keep up with a point at (tx, ty) moving at (tvx, tvy): its velocity plus a capped pull toward it. */
  follow(i: number, tx: number, ty: number, tvx: number, tvy: number, weight = 1): void {
    const sp = this.species;
    const k = sp.catchUp * this.pace;
    let cx = (tx - (this.x[i] ?? 0)) * k;
    let cy = (ty - (this.y[i] ?? 0)) * k;
    const c = Math.hypot(cx, cy);
    const cap = sp.maxSpeed * this.pace;
    if (c > cap) {
      cx *= cap / c;
      cy *= cap / c;
    }
    this.#add(i, (tvx + cx) * weight, (tvy + cy) * weight);
  }

  /** Come to (tx, ty) at cruising speed, slowing inside `radius`, and idle about it facing it. */
  gather(i: number, tx: number, ty: number, radius: number, weight = 1): void {
    const dx = tx - (this.x[i] ?? 0);
    const dy = ty - (this.y[i] ?? 0);
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return;
    const v =
      (this.species.cruise * this.pace * Math.min(1, d / Math.max(radius, 1e-9)) * weight) / d;
    this.#add(i, dx * v, dy * v);
  }

  /** Dart away from (fx, fy) when nearer than `reach`, the harder the nearer. */
  flee(i: number, fx: number, fy: number, reach: number, weight = 1): void {
    const dx = (this.x[i] ?? 0) - fx;
    const dy = (this.y[i] ?? 0) - fy;
    const d = Math.hypot(dx, dy);
    if (d >= reach || d < 1e-9) return;
    const v = (this.species.maxSpeed * this.pace * (1 - d / reach) * weight) / d;
    this.#add(i, dx * v, dy * v);
  }

  /** A slow sideways weave of the fish's own at `clock` (seconds). */
  wander(i: number, clock: number, weight = 1): void {
    const sp = this.species;
    const a =
      sp.wander *
      sp.cruise *
      this.pace *
      weight *
      Math.sin(clock * sp.wanderRate + (this.salt[i] ?? 0) * TAU);
    const h = this.heading[i] ?? 0;
    this.#add(i, -Math.sin(h) * a, Math.cos(h) * a);
  }

  /** Swim like the neighbours and keep near them (species.school); nothing for a solitary species. */
  school(count: number, weight = 1): void {
    const s = this.species.school;
    if (s === undefined) return;
    const { x, y, heading, speed, length } = this;
    for (let i = 0; i < count; i++) {
      const xi = x[i] ?? 0;
      const yi = y[i] ?? 0;
      const len = length[i] ?? 0;
      const align2 = (s.align * len) ** 2;
      const cohere2 = (s.cohere * len) ** 2;
      let ax = 0;
      let ay = 0;
      let na = 0;
      let cx = 0;
      let cy = 0;
      let nc = 0;
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const dx = (x[j] ?? 0) - xi;
        const dy = (y[j] ?? 0) - yi;
        const d2 = dx * dx + dy * dy;
        if (d2 < cohere2) {
          cx += dx;
          cy += dy;
          nc++;
        }
        if (d2 < align2) {
          const v = speed[j] ?? 0;
          ax += Math.cos(heading[j] ?? 0) * v;
          ay += Math.sin(heading[j] ?? 0) * v;
          na++;
        }
      }
      if (na > 0) this.#add(i, (s.alignPull * weight * ax) / na, (s.alignPull * weight * ay) / na);
      if (nc > 0)
        this.#add(
          i,
          (s.coherePull * this.pace * weight * cx) / nc,
          (s.coherePull * this.pace * weight * cy) / nc,
        );
    }
  }

  /**
   * Light separation among fish 0..count-1: each pair closer than `spacing` (in their mean body
   * length) wants apart, up to `spacingPull` times cruising speed when touching centres.
   */
  space(count: number, weight = 1): void {
    const sp = this.species;
    if (sp.spacing <= 0 || sp.spacingPull <= 0 || weight <= 0) return;
    const { x, y, length } = this;
    const push = sp.spacingPull * sp.cruise * this.pace * weight;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const r = sp.spacing * 0.5 * ((length[i] ?? 0) + (length[j] ?? 0));
        let dx = (x[i] ?? 0) - (x[j] ?? 0);
        let dy = (y[i] ?? 0) - (y[j] ?? 0);
        const d = Math.hypot(dx, dy);
        if (d >= r) continue;
        let along = d;
        if (d < 1e-9) {
          // Exactly on top of each other: part across the first fish's heading.
          const h = this.heading[i] ?? 0;
          dx = -Math.sin(h);
          dy = Math.cos(h);
          along = 1;
        }
        const v = (push * (1 - d / r)) / along;
        this.#add(i, dx * v, dy * v);
        this.#add(j, -dx * v, -dy * v);
      }
    }
  }

  /** Soft walls: inside `margin` of an edge, a want back in that grows to cruising speed at the edge. */
  within(i: number, minX: number, minY: number, maxX: number, maxY: number, margin: number): void {
    const xi = this.x[i] ?? 0;
    const yi = this.y[i] ?? 0;
    const v = this.species.cruise * this.pace;
    const m = Math.max(margin, 1e-9);
    let wx = 0;
    let wy = 0;
    if (xi < minX + m) wx += v * Math.min(2, (minX + m - xi) / m);
    if (xi > maxX - m) wx -= v * Math.min(2, (xi - (maxX - m)) / m);
    if (yi < minY + m) wy += v * Math.min(2, (minY + m - yi) / m);
    if (yi > maxY - m) wy -= v * Math.min(2, (yi - (maxY - m)) / m);
    this.#add(i, wx, wy);
  }

  /**
   * Fish 0..count-1 swim h seconds: each turns toward its want (at most turnRate · pace · h), takes
   * up the want's speed (slower while the want lies off its nose, within the species' limits, at
   * most accel · pace · h of change) and moves along its heading. h ≤ 0 changes nothing.
   */
  swim(count: number, h: number): void {
    if (!(h > 0)) return;
    const sp = this.species;
    const p = this.pace;
    const lo = sp.minSpeed * p;
    const hi = sp.maxSpeed * p;
    const turnMax = sp.turnRate * p * h;
    const dv = sp.accel * p * h;
    const ease = easeFactor(h, 0.2);
    for (let i = 0; i < count; i++) {
      const wx = this.#wx[i] ?? 0;
      const wy = this.#wy[i] ?? 0;
      const w = Math.hypot(wx, wy);
      let heading = this.heading[i] ?? 0;
      let off = 0;
      if (w > 1e-9) {
        off = Math.atan2(wy, wx) - heading;
        off -= TAU * Math.round(off / TAU);
      }
      const turn = Math.min(turnMax, Math.max(-turnMax, off));
      heading += turn;
      heading -= TAU * Math.round(heading / TAU);
      const goal = Math.min(hi, Math.max(lo, w * Math.max(0.25, Math.cos(off))));
      const speed = this.speed[i] ?? 0;
      const next = speed + Math.min(dv, Math.max(-dv, goal - speed));
      this.heading[i] = heading;
      this.speed[i] = next;
      this.x[i] = (this.x[i] ?? 0) + Math.cos(heading) * next * h;
      this.y[i] = (this.y[i] ?? 0) + Math.sin(heading) * next * h;
      this.turning[i] = (this.turning[i] ?? 0) + (turn / h - (this.turning[i] ?? 0)) * ease;
    }
  }

  #add(i: number, vx: number, vy: number): void {
    this.#wx[i] = (this.#wx[i] ?? 0) + vx;
    this.#wy[i] = (this.#wy[i] ?? 0) + vy;
  }
}

/** A FishGroup packed for the shader (rows in the header); read with fishGlsl's `fishPose`. */
export class FishTexture {
  readonly capacity: number;
  readonly #texture: DataTexture;
  readonly #data: Float32Array;

  constructor(gl: WebGL2RenderingContext, capacity: number) {
    this.capacity = capacity;
    this.#texture = new DataTexture(gl, {
      width: capacity,
      height: 3,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#data = new Float32Array(capacity * 3 * 4);
  }

  get texture(): WebGLTexture {
    return this.#texture.texture;
  }

  /**
   * Upload fish 0..count-1 of `group` as drawn `ahead` seconds past its last step (moved on along
   * their headings: FixedStep's pending time), the rest hidden (length 0).
   */
  upload(group: FishGroup, count: number, ahead = 0): void {
    packFish(group, count, ahead, this.#data);
    this.#texture.upload(this.#data);
  }

  dispose(): void {
    this.#texture.dispose();
  }
}

/** FishTexture's rows for `group` into `out` (capacity × 3 texels of four floats). */
export function packFish(group: FishGroup, count: number, ahead: number, out: Float32Array): void {
  const n = group.capacity;
  for (let i = 0; i < n; i++) {
    const h = group.heading[i] ?? 0;
    const v = group.speed[i] ?? 0;
    const c = Math.cos(h);
    const s = Math.sin(h);
    const at = 4 * i;
    splitHalf(out, at, (group.x[i] ?? 0) + c * v * ahead);
    splitHalf(out, at + 2, (group.y[i] ?? 0) + s * v * ahead);
    const look = 4 * (n + i);
    out[look] = c;
    out[look + 1] = s;
    out[look + 2] = v;
    out[look + 3] = i < count ? (group.length[i] ?? 0) : 0;
    const tag = 4 * (2 * n + i);
    for (let k = 0; k < 4; k++) out[tag + k] = group.tag[4 * i + k] ?? 0;
  }
}

/** The fish's GLSL (see the header). Needs `common` (hash12, vnoise). */
export const fishGlsl = `
// ---- fish (sims/fish.ts) ----

// A fish's pose, packed by FishTexture: position, heading (unit), speed, body length (0 hidden) and
// the scene's own four values.
struct FishPose {
  vec2 at;
  vec2 dir;
  float speed;
  float len;
  vec4 tag;
};

FishPose fishPose(sampler2D poses, int i) {
  vec4 a = texelFetch(poses, ivec2(i, 0), 0);
  vec4 b = texelFetch(poses, ivec2(i, 1), 0);
  return FishPose(vec2(a.x + a.y, a.z + a.w), b.xy, b.z, b.w, texelFetch(poses, ivec2(i, 2), 0));
}

// A body plan seen from above, in body lengths: half-width at the widest, how much of it the
// tail end loses, the tail fin's half-spread, the pectoral fins' distance out and radius, and the
// swimming wave's sway.
struct FishBody {
  float girth;
  float taper;
  float tail;
  float finAt;
  float fin;
  float wave;
};

const FishBody FISH_KOI = FishBody(0.17, 0.35, 0.2, 0.2, 0.06, 0.09);
const FishBody FISH_BLENNY = FishBody(0.12, 0.45, 0.13, 0.17, 0.09, 0.12);

// A fish from above in its own frame (x forward from the nose, y across): 0 outside, 1 body, 2 fin.
// The nose is 0.3 lengths ahead of the frame's origin; a wave runs down the body to the tail.
float fishTop(vec2 q, float len, float swim, FishBody b) {
  float u = (0.3 * len - q.x) / len; // 0 at the nose, 1 at the tail tip
  if (u < 0.0 || u > 1.05) return 0.0;
  q.y -= len * b.wave * sin(u * 5.0 - swim) * u * u;
  float body = len * b.girth * pow(sin(3.14159 * clamp(u / 0.74, 0.0, 1.0)), 0.6) * (1.0 - b.taper * u);
  if (u < 0.74 && abs(q.y) < body) return 1.0;
  float tail = len * (0.04 + b.tail * smoothstep(0.7, 1.02, u));
  bool notch = u > 0.95 && abs(q.y) < (u - 0.95) * len * 0.9;
  if (u > 0.68 && abs(q.y) < tail && !notch) return 2.0;
  vec2 fin = vec2((u - 0.26) / 0.07, (abs(q.y) - len * b.finAt) / (len * b.fin));
  if (dot(fin, fin) < 1.0) return 2.0;
  return 0.0;
}

// The eyes of a fish from above (q, len as fishTop's), set wide on the head.
bool fishTopEye(vec2 q, float len) {
  float u = (0.3 * len - q.x) / len;
  return abs(u - 0.07) < 0.025 && abs(abs(q.y) - len * 0.085) < len * 0.03;
}

// A koi's colour where its pattern noise reads 'marking': ogon (gold) above variety 0.75, showa
// (black with red and white) above 0.45, kohaku (white with red) above 0.2, else plain red. tone:
// 0 dark, 1 white, 2 colour.
vec3 fishKoiCoat(float variety, float marking, out float tone) {
  vec3 red = vec3(1.0, 0.4, 0.1);
  vec3 white = vec3(0.97, 0.95, 0.9);
  vec3 black = vec3(0.07, 0.07, 0.08);
  vec3 gold = vec3(1.0, 0.78, 0.3);
  if (variety > 0.75) { tone = 2.0; return gold; }
  if (variety > 0.45) { tone = marking > 0.6 ? 2.0 : marking < 0.35 ? 1.0 : 0.0; return tone > 1.5 ? red : tone > 0.5 ? white : black; }
  if (variety > 0.2) { tone = marking > 0.5 ? 2.0 : 1.0; return tone > 1.5 ? red : white; }
  tone = 2.0;
  return red * (0.9 + 0.2 * marking);
}

// A small fish side-on, q in body lengths (x toward the snout from mid-body, y up): a spindle body
// pointed at the snout and a forked tail. > 0 inside; soften with smoothstep(-px, px, ...).
float fishSide(vec2 q) {
  float bx = (q.x - 0.1) / 0.4;
  float body = 0.2 * (1.0 - bx * bx) - abs(q.y);
  float tl = -0.3 - q.x;
  float fin = min(min(0.02 + 0.75 * tl - abs(q.y), 0.18 - tl), tl + 0.03);
  return max(body, fin);
}
`;
