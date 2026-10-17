// Stones stacked in a vertical plane: a small 2D rigid-body sim of boxes on level ground, for
// cairns. Gravity, friction and contacts without bounce, solved by sequential impulses with warm
// starting, after Erin Catto's Box2D Lite: each pair of boxes in touch (and each box on the ground)
// is clipped to at most two contact points, and the impulses gathered at each are kept from one step
// to the next while the same corners touch, so a stack comes to rest instead of jittering. Once
// every stone has stood still for SLEEP_SECONDS the stack sleeps, stepping nothing, until something
// wakes it: a stone added or taken, or a push.
//
// x runs along the ground, y up from it, in metres; angles in radians, counter-clockwise. A stone is
// a box of half width `hw` and half height `hh` (draw it rounded: the corners are a pebble's). The
// caller steps it on a FixedStep (sims/clock.ts) of STACK_STEP; every operation is plain arithmetic
// in a fixed order, so the same calls give the same stones, bit for bit.
//
// Usage (a cairn):
//   const cairn = new Stack(8);
//   const base = cairn.add(0, 0.06, 0, 0.14, 0.06);     // set down resting on the ground
//   cairn.add(0.01, 0.17, 0.02, 0.09, 0.04);            // the next, dropped a hair above it
//   for (let i = 0, n = clock.advance(dt * motion); i < n; i++) {
//     cairn.push(i, ax, 0, below);                      // the surf: an acceleration under a height
//     cairn.step(STACK_STEP);
//   }
//   const top = cairn.top();                            // how high it stands

/** The step the stack is meant for (s): fine enough for stones a few centimetres thick. */
export const STACK_STEP = 1 / 120;

const GRAVITY = 9.81;
/** Stone's density (kg/m³, of a slab a metre deep: masses only ever meet as ratios). */
const DENSITY = 2600;
/** Friction between stones, and between a stone and wet sand. */
const FRICTION = 0.7;
const GROUND_FRICTION = 0.6;
/** Solver passes a step; overlap let stand (m) and the share of the rest pushed out a step. */
const ITERATIONS = 12;
const SLOP = 0.002;
const BIAS = 0.2;
/** Every stone slower than this (m/s, rad/s) for this long and the stack sleeps. */
const SLEEP_SPEED = 0.01;
const SLEEP_SECONDS = 0.5;
/** Air and sand damp a moving stone a little (share of its speed lost a second). */
const DAMPING = 0.1;

/** One stone: where it is, how it moves, its size and its mass. */
export interface Stone {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  spin: number;
  hw: number;
  hh: number;
  /** 1 / mass and 1 / moment of inertia; 0 for the ground. */
  invMass: number;
  invI: number;
  /** The push on it this step (m/s²): the surf's. */
  ax: number;
  ay: number;
}

/** A point where two bodies touch, and the impulses gathered there. */
interface Contact {
  x: number;
  y: number;
  nx: number;
  ny: number;
  separation: number;
  /** Which corners and edges made it, for warm starting: the same feature keeps its impulses. */
  feature: number;
  pn: number;
  pt: number;
  massNormal: number;
  massTangent: number;
  bias: number;
}

const contact = (): Contact => ({
  x: 0,
  y: 0,
  nx: 0,
  ny: 0,
  separation: 0,
  feature: 0,
  pn: 0,
  pt: 0,
  massNormal: 0,
  massTangent: 0,
  bias: 0,
});

/** The contacts of one pair of bodies, kept from step to step. */
interface Arbiter {
  count: number;
  readonly contacts: readonly [Contact, Contact];
  friction: number;
}

/** A corner of the incident edge being clipped, and the edges that made it (4 bits each). */
interface ClipVertex {
  x: number;
  y: number;
  feature: number;
}

const clipVertex = (): ClipVertex => ({ x: 0, y: 0, feature: 0 });

// Edge numbers of a box (Box2D Lite's), and a feature's four slots: in-edge and out-edge of the
// reference and of the incident box.
const NO_EDGE = 0;
const EDGE1 = 1;
const EDGE2 = 2;
const EDGE3 = 3;
const EDGE4 = 4;
const IN1 = 0;
const OUT1 = 4;
const IN2 = 8;
const OUT2 = 12;
const setEdge = (feature: number, slot: number, edge: number): number =>
  (feature & ~(15 << slot)) | (edge << slot);
const edgeAt = (feature: number, slot: number): number => (feature >> slot) & 15;
/** The same feature seen from the other box. */
const flip = (f: number): number =>
  (edgeAt(f, IN2) << IN1) |
  (edgeAt(f, IN1) << IN2) |
  (edgeAt(f, OUT2) << OUT1) |
  (edgeAt(f, OUT1) << OUT2);

/** Half the height a stone stands at its turn: how far its lowest point lies below its middle. */
const halfRise = (s: Stone): number =>
  Math.abs(Math.sin(s.angle)) * s.hw + Math.abs(Math.cos(s.angle)) * s.hh;

/**
 * A box's edge most against a normal, by where the normal (in the box's frame, reversed) points:
 * +x, -x, +y, -y. Each row: the signs of its two corners' x and y (times hw and hh), then each
 * corner's in-edge and out-edge.
 */
const INCIDENT = [
  [1, -1, 1, 1, EDGE3, EDGE4, EDGE4, EDGE1],
  [-1, 1, -1, -1, EDGE1, EDGE2, EDGE2, EDGE3],
  [1, 1, -1, 1, EDGE4, EDGE1, EDGE1, EDGE2],
  [-1, -1, 1, -1, EDGE2, EDGE3, EDGE3, EDGE4],
] as const;

export class Stack {
  /** The stones, in the order added; the ground is not among them. */
  readonly stones: Stone[] = [];
  readonly capacity: number;
  /** Seconds every stone has stood still; the stack sleeps from SLEEP_SECONDS on. */
  #rest = 0;
  readonly #ground: Stone = {
    x: 0,
    y: -1,
    angle: 0,
    vx: 0,
    vy: 0,
    spin: 0,
    hw: 1000,
    hh: 1,
    invMass: 0,
    invI: 0,
    ax: 0,
    ay: 0,
  };
  /** Arbiters by pair: (i, j) with i < j over the ground (0) and the stones (1..capacity). */
  readonly #arbiters: Arbiter[];
  readonly #scratch: readonly Contact[] = [contact(), contact()];
  readonly #incident: readonly [ClipVertex, ClipVertex] = [clipVertex(), clipVertex()];
  readonly #clip1: readonly [ClipVertex, ClipVertex] = [clipVertex(), clipVertex()];
  readonly #clip2: readonly [ClipVertex, ClipVertex] = [clipVertex(), clipVertex()];

  constructor(capacity: number) {
    this.capacity = capacity;
    const pairs = ((capacity + 1) * capacity) / 2;
    this.#arbiters = Array.from({ length: pairs }, () => ({
      count: 0,
      contacts: [contact(), contact()],
      friction: 0,
    }));
  }

  /** Asleep: every stone has rested a while and nothing has disturbed them since. */
  get asleep(): boolean {
    return this.#rest >= SLEEP_SECONDS;
  }

  /** A stone at (x, y), turned `angle`, at rest; its index, or -1 when the stack is full. */
  add(x: number, y: number, angle: number, hw: number, hh: number): number {
    if (this.stones.length >= this.capacity) return -1;
    const mass = DENSITY * 4 * hw * hh;
    this.stones.push({
      x,
      y,
      angle,
      vx: 0,
      vy: 0,
      spin: 0,
      hw,
      hh,
      invMass: 1 / mass,
      invI: 12 / (mass * 4 * (hw * hw + hh * hh)),
      ax: 0,
      ay: 0,
    });
    this.#forget();
    return this.stones.length - 1;
  }

  /** Lift stone `index` out of the stack; the later ones move down an index. */
  remove(index: number): Stone | undefined {
    const [stone] = this.stones.splice(index, 1);
    this.#forget();
    return stone;
  }

  /** Every stone gone. */
  clear(): void {
    this.stones.length = 0;
    this.#forget();
  }

  /** Push stone `index` this step: an acceleration (m/s²) along the ground and up. Wakes the stack. */
  push(index: number, ax: number, ay: number): void {
    const stone = this.stones[index];
    if (stone === undefined || (ax === 0 && ay === 0)) return;
    stone.ax += ax;
    stone.ay += ay;
    this.#rest = 0;
  }

  /** The height of the stack's highest point (m), corners and all; 0 without stones. */
  top(): number {
    let top = 0;
    for (const s of this.stones) top = Math.max(top, s.y + halfRise(s));
    return top;
  }

  /** How far the bottom of stone `index` stands off the ground (m): 0 for one lying on it. */
  lift(index: number): number {
    const s = this.stones[index];
    return s === undefined ? 0 : s.y - halfRise(s);
  }

  /** One step of `dt` seconds (STACK_STEP); nothing while the stack sleeps. */
  step(dt: number): void {
    if (!(dt > 0) || this.asleep || this.stones.length === 0) return;
    const n = this.stones.length;
    // Contacts: every stone on the ground, and every pair of stones.
    for (let j = 1; j <= n; j++) for (let i = 0; i < j; i++) this.#update(i, j);
    // Forces: gravity and the pushes, with a little damping.
    const keep = Math.max(0, 1 - DAMPING * dt);
    for (const s of this.stones) {
      s.vx = (s.vx + dt * s.ax) * keep;
      s.vy = (s.vy + dt * (s.ay - GRAVITY)) * keep;
      s.spin *= keep;
      s.ax = 0;
      s.ay = 0;
    }
    const invDt = 1 / dt;
    for (let j = 1; j <= n; j++) for (let i = 0; i < j; i++) this.#preStep(i, j, invDt);
    for (let k = 0; k < ITERATIONS; k++)
      for (let j = 1; j <= n; j++) for (let i = 0; i < j; i++) this.#impulse(i, j);
    let fastest = 0;
    for (const s of this.stones) {
      s.x += dt * s.vx;
      s.y += dt * s.vy;
      s.angle += dt * s.spin;
      const turning = Math.abs(s.spin) * Math.max(s.hw, s.hh);
      fastest = Math.max(fastest, Math.hypot(s.vx, s.vy), turning);
    }
    this.#rest = fastest < SLEEP_SPEED ? this.#rest + dt : 0;
  }

  /** Wake, and drop every contact: the bodies' indices have moved. */
  #forget(): void {
    this.#rest = 0;
    for (const arbiter of this.#arbiters) arbiter.count = 0;
  }

  #body(index: number): Stone {
    return index === 0 ? this.#ground : (this.stones[index - 1] ?? this.#ground);
  }

  #arbiter(i: number, j: number): Arbiter {
    const arbiter = this.#arbiters[(j * (j - 1)) / 2 + i];
    if (arbiter === undefined) throw new Error(`stack: no pair ${i}, ${j}`);
    return arbiter;
  }

  /**
   * Bodies i and j's contacts this step (0 the ground), each keeping the impulses of the one with
   * its feature last step.
   */
  #update(i: number, j: number): void {
    const arbiter = this.#arbiter(i, j);
    const a = this.#body(i);
    const b = this.#body(j);
    const fresh = this.#scratch;
    const count = this.#collide(fresh, a, b);
    for (let k = 0; k < count; k++) {
      const next = fresh[k];
      if (next === undefined) continue;
      let pn = 0;
      let pt = 0;
      for (let m = 0; m < arbiter.count; m++) {
        const old = arbiter.contacts[m];
        if (old !== undefined && old.feature === next.feature) {
          pn = old.pn;
          pt = old.pt;
        }
      }
      next.pn = pn;
      next.pt = pt;
    }
    for (let k = 0; k < count; k++) {
      const from = fresh[k];
      const to = arbiter.contacts[k];
      if (from !== undefined && to !== undefined) Object.assign(to, from);
    }
    arbiter.count = count;
    arbiter.friction = a.invMass === 0 || b.invMass === 0 ? GROUND_FRICTION : FRICTION;
  }

  #preStep(i: number, j: number, invDt: number): void {
    const arbiter = this.#arbiter(i, j);
    const a = this.#body(i);
    const b = this.#body(j);
    for (let k = 0; k < arbiter.count; k++) {
      const c = arbiter.contacts[k];
      if (c === undefined) continue;
      const r1x = c.x - a.x;
      const r1y = c.y - a.y;
      const r2x = c.x - b.x;
      const r2y = c.y - b.y;
      const rn1 = r1x * c.nx + r1y * c.ny;
      const rn2 = r2x * c.nx + r2y * c.ny;
      const kNormal =
        a.invMass +
        b.invMass +
        a.invI * (r1x * r1x + r1y * r1y - rn1 * rn1) +
        b.invI * (r2x * r2x + r2y * r2y - rn2 * rn2);
      c.massNormal = 1 / kNormal;
      // The tangent: the normal turned a quarter clockwise.
      const tx = c.ny;
      const ty = -c.nx;
      const rt1 = r1x * tx + r1y * ty;
      const rt2 = r2x * tx + r2y * ty;
      const kTangent =
        a.invMass +
        b.invMass +
        a.invI * (r1x * r1x + r1y * r1y - rt1 * rt1) +
        b.invI * (r2x * r2x + r2y * r2y - rt2 * rt2);
      c.massTangent = 1 / kTangent;
      c.bias = -BIAS * invDt * Math.min(0, c.separation + SLOP);
      // Warm start: last step's impulses, at once.
      const px = c.pn * c.nx + c.pt * tx;
      const py = c.pn * c.ny + c.pt * ty;
      a.vx -= a.invMass * px;
      a.vy -= a.invMass * py;
      a.spin -= a.invI * (r1x * py - r1y * px);
      b.vx += b.invMass * px;
      b.vy += b.invMass * py;
      b.spin += b.invI * (r2x * py - r2y * px);
    }
  }

  #impulse(i: number, j: number): void {
    const arbiter = this.#arbiter(i, j);
    const a = this.#body(i);
    const b = this.#body(j);
    for (let k = 0; k < arbiter.count; k++) {
      const c = arbiter.contacts[k];
      if (c === undefined) continue;
      const r1x = c.x - a.x;
      const r1y = c.y - a.y;
      const r2x = c.x - b.x;
      const r2y = c.y - b.y;
      // The normal impulse, clamped so the gathered one only ever pushes apart.
      let dvx = b.vx - b.spin * r2y - a.vx + a.spin * r1y;
      let dvy = b.vy + b.spin * r2x - a.vy - a.spin * r1x;
      const vn = dvx * c.nx + dvy * c.ny;
      const pn0 = c.pn;
      c.pn = Math.max(pn0 + c.massNormal * (-vn + c.bias), 0);
      const dpn = c.pn - pn0;
      let px = dpn * c.nx;
      let py = dpn * c.ny;
      a.vx -= a.invMass * px;
      a.vy -= a.invMass * py;
      a.spin -= a.invI * (r1x * py - r1y * px);
      b.vx += b.invMass * px;
      b.vy += b.invMass * py;
      b.spin += b.invI * (r2x * py - r2y * px);
      // Friction, within the cone the normal impulse allows.
      dvx = b.vx - b.spin * r2y - a.vx + a.spin * r1y;
      dvy = b.vy + b.spin * r2x - a.vy - a.spin * r1x;
      const tx = c.ny;
      const ty = -c.nx;
      const vt = dvx * tx + dvy * ty;
      const most = arbiter.friction * c.pn;
      const pt0 = c.pt;
      c.pt = Math.min(most, Math.max(-most, pt0 - c.massTangent * vt));
      const dpt = c.pt - pt0;
      px = dpt * tx;
      py = dpt * ty;
      a.vx -= a.invMass * px;
      a.vy -= a.invMass * py;
      a.spin -= a.invI * (r1x * py - r1y * px);
      b.vx += b.invMass * px;
      b.vy += b.invMass * py;
      b.spin += b.invI * (r2x * py - r2y * px);
    }
  }

  /**
   * Where boxes a and b touch, into `out` (normal from a to b): the axis of least overlap among
   * both boxes' faces, the other box's edge most against it clipped to the reference face's sides,
   * and the clipped corners that lie behind that face. Returns how many (0..2).
   */
  #collide(out: readonly Contact[], a: Stone, b: Stone): number {
    const ca = Math.cos(a.angle);
    const sa = Math.sin(a.angle);
    const cb = Math.cos(b.angle);
    const sb = Math.sin(b.angle);
    const dpx = b.x - a.x;
    const dpy = b.y - a.y;
    // The offset in each box's frame (rotation transposed), and C = Ra^T Rb with its absolute value.
    const dAx = ca * dpx + sa * dpy;
    const dAy = -sa * dpx + ca * dpy;
    const dBx = cb * dpx + sb * dpy;
    const dBy = -sb * dpx + cb * dpy;
    const c11 = ca * cb + sa * sb;
    const c12 = -ca * sb + sa * cb;
    const c21 = -sa * cb + ca * sb;
    const c22 = sa * sb + ca * cb;
    const a11 = Math.abs(c11);
    const a12 = Math.abs(c12);
    const a21 = Math.abs(c21);
    const a22 = Math.abs(c22);
    const faceAx = Math.abs(dAx) - a.hw - (a11 * b.hw + a12 * b.hh);
    const faceAy = Math.abs(dAy) - a.hh - (a21 * b.hw + a22 * b.hh);
    if (faceAx > 0 || faceAy > 0) return 0;
    const faceBx = Math.abs(dBx) - (a11 * a.hw + a21 * a.hh) - b.hw;
    const faceBy = Math.abs(dBy) - (a12 * a.hw + a22 * a.hh) - b.hh;
    if (faceBx > 0 || faceBy > 0) return 0;

    // The best axis, preferring a's faces, then x, as Box2D Lite does (with its tolerances).
    let axis = 0;
    let separation = faceAx;
    let nx = dAx > 0 ? ca : -ca;
    let ny = dAx > 0 ? sa : -sa;
    if (faceAy > 0.95 * separation + 0.01 * a.hh) {
      axis = 1;
      separation = faceAy;
      nx = dAy > 0 ? -sa : sa;
      ny = dAy > 0 ? ca : -ca;
    }
    if (faceBx > 0.95 * separation + 0.01 * b.hw) {
      axis = 2;
      separation = faceBx;
      nx = dBx > 0 ? cb : -cb;
      ny = dBx > 0 ? sb : -sb;
    }
    if (faceBy > 0.95 * separation + 0.01 * b.hh) {
      axis = 3;
      nx = dBy > 0 ? -sb : sb;
      ny = dBy > 0 ? cb : -cb;
    }

    // The reference face (front), its sides, and the incident edge of the other box.
    const ref = axis < 2 ? a : b;
    const inc = axis < 2 ? b : a;
    const fx = axis < 2 ? nx : -nx;
    const fy = axis < 2 ? ny : -ny;
    const cr = axis < 2 ? ca : cb;
    const sr = axis < 2 ? sa : sb;
    const alongX = axis === 0 || axis === 2;
    // Along x the sides are the box's y axis, and the reverse.
    const sideX = alongX ? -sr : cr;
    const sideY = alongX ? cr : sr;
    const halfFront = alongX ? ref.hw : ref.hh;
    const halfSide = alongX ? ref.hh : ref.hw;
    const front = ref.x * fx + ref.y * fy + halfFront;
    const side = ref.x * sideX + ref.y * sideY;
    const negSide = -side + halfSide;
    const posSide = side + halfSide;
    const negEdge = alongX ? EDGE3 : EDGE2;
    const posEdge = alongX ? EDGE1 : EDGE4;
    this.#incidentEdge(inc, fx, fy);

    if (this.#clip(this.#clip1, this.#incident, -sideX, -sideY, negSide, negEdge) < 2) return 0;
    if (this.#clip(this.#clip2, this.#clip1, sideX, sideY, posSide, posEdge) < 2) return 0;
    let count = 0;
    for (const v of this.#clip2) {
      const depth = v.x * fx + v.y * fy - front;
      if (depth > 0) continue;
      const c = out[count];
      if (c === undefined) break;
      c.separation = depth;
      c.nx = nx;
      c.ny = ny;
      // On the reference face.
      c.x = v.x - depth * fx;
      c.y = v.y - depth * fy;
      c.feature = axis < 2 ? v.feature : flip(v.feature);
      count++;
    }
    return count;
  }

  /** The edge of box `box` most against the reference face's normal (fx, fy), into #incident. */
  #incidentEdge(box: Stone, fx: number, fy: number): void {
    const c = Math.cos(box.angle);
    const s = Math.sin(box.angle);
    // The normal in the box's frame, reversed.
    const nx = -(c * fx + s * fy);
    const ny = -(-s * fx + c * fy);
    const side = Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 0 : 1) : ny > 0 ? 2 : 3;
    const [sx0, sy0, sx1, sy1, in0, out0, in1, out1] = INCIDENT[side] ?? INCIDENT[0];
    const [v0, v1] = this.#incident;
    v0.x = box.x + c * sx0 * box.hw - s * sy0 * box.hh;
    v0.y = box.y + s * sx0 * box.hw + c * sy0 * box.hh;
    v0.feature = setEdge(setEdge(0, IN2, in0), OUT2, out0);
    v1.x = box.x + c * sx1 * box.hw - s * sy1 * box.hh;
    v1.y = box.y + s * sx1 * box.hw + c * sy1 * box.hh;
    v1.feature = setEdge(setEdge(0, IN2, in1), OUT2, out1);
  }

  /** The segment `from` clipped to the side of the line n·v = offset where n·v ≤ offset, into `to`. */
  #clip(
    to: readonly [ClipVertex, ClipVertex],
    from: readonly [ClipVertex, ClipVertex],
    nx: number,
    ny: number,
    offset: number,
    edge: number,
  ): number {
    const [v0, v1] = from;
    const [o0, o1] = to;
    const d0 = nx * v0.x + ny * v0.y - offset;
    const d1 = nx * v1.x + ny * v1.y - offset;
    let count = 0;
    if (d0 <= 0) {
      o0.x = v0.x;
      o0.y = v0.y;
      o0.feature = v0.feature;
      count = 1;
    }
    if (d1 <= 0) {
      const o = count === 0 ? o0 : o1;
      o.x = v1.x;
      o.y = v1.y;
      o.feature = v1.feature;
      count++;
    }
    // One end in front and one behind: the point where the segment crosses, after the one behind.
    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      o1.x = v0.x + t * (v1.x - v0.x);
      o1.y = v0.y + t * (v1.y - v0.y);
      o1.feature =
        d0 > 0
          ? setEdge(setEdge(v0.feature, IN1, edge), IN2, NO_EDGE)
          : setEdge(setEdge(v1.feature, OUT1, edge), OUT2, NO_EDGE);
      count++;
    }
    return count;
  }
}
