// Growing a bonsai: a styled trunk line, primary branches wired out and down in the classic pattern
// (right, left, back, up the trunk, shorter as they climb), a cloud-shaped foliage pad at the end of
// each, and the ramification inside every pad grown by space colonisation (Runions et al. 2007,
// "Modeling Trees with a Space Colonization Algorithm"): attraction points scattered through the pad,
// the twigs growing toward them step by step with a species' tropism, so each pad fills from its
// branch outward. Radii follow the pipe model (Shinozaki 1964): a branch's cross-section carries
// those of its twigs, r^3 = sum of the children's r^3, thickened where bonsai growers build
// taper. Then the nebari (surface roots) over the moss, and for pines sometimes a jin of bleached
// deadwood. Tufts of foliage sit on the outer twigs. Deterministic for a species and seed.
import { mulberry32 } from "../../sims/random.ts";
import {
  BONSAI_MAPLE,
  BONSAI_REGION,
  BONSAI_SOIL_Y,
  BONSAI_TRUNK,
  bonsaiMound,
} from "./geometry.ts";

export type NodeKind = "trunk" | "branch" | "twig" | "root" | "jin";

export interface TreeNode {
  x: number;
  y: number;
  z: number;
  r: number;
  parent: number;
  children: number[];
  kind: NodeKind;
  /** The pad this node feeds (-1: trunk, roots). */
  pad: number;
  /** How freely it moves with its pad, 0 (trunk) .. 1 (outer twigs). */
  flex: number;
  removed: boolean;
}

export interface Pad {
  x: number;
  y: number;
  z: number;
  /** Long axis in the horizontal plane (unit), along the branch. */
  ux: number;
  uz: number;
  /** Radii: along the branch, across it, and up. */
  long: number;
  side: number;
  tall: number;
}

export interface Tuft {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Height over width. */
  flat: number;
  node: number;
  pad: number;
  r1: number;
  r2: number;
  /** How far out from the trunk, 0..1. */
  outer: number;
  removed: boolean;
  regrow: boolean;
}

export interface Tree {
  nodes: TreeNode[];
  pads: Pad[];
  tufts: Tuft[];
  /** The twigs' tip radius. */
  tip: number;
}

interface Shape {
  height: number;
  baseRadius: number;
  topRadius: number;
  bend: number;
  bends: number;
  primaries: readonly [number, number];
  firstAt: number;
  spread: number;
  droop: number;
  rise: number;
  padTall: number;
  apexWide: number;
  apexTall: number;
  tuft: number;
  flat: number;
  tropism: number;
  step: number;
  attract: number;
  tip: number;
  jin: number;
}

/** Japanese black pine, Japanese maple, flowering cherry. */
const SHAPES: readonly Shape[] = [
  {
    height: 0.5,
    baseRadius: 0.048,
    topRadius: 0.011,
    bend: 0.075,
    bends: 2.4,
    primaries: [8, 10],
    firstAt: 0.27,
    spread: 0.43,
    droop: 0.42,
    rise: 0.22,
    padTall: 0.036,
    apexWide: 0.1,
    apexTall: 0.05,
    tuft: 0.037,
    flat: 0.52,
    tropism: 0.08,
    step: 0.013,
    attract: 1,
    tip: 0.0026,
    jin: 0.75,
  },
  {
    height: 0.5,
    baseRadius: 0.052,
    topRadius: 0.011,
    bend: 0.05,
    bends: 1.8,
    primaries: [8, 11],
    firstAt: 0.29,
    spread: 0.41,
    droop: 0.14,
    rise: 0.36,
    padTall: 0.05,
    apexWide: 0.13,
    apexTall: 0.07,
    tuft: 0.034,
    flat: 0.7,
    tropism: 0.22,
    step: 0.012,
    attract: 1.1,
    tip: 0.0022,
    jin: 0,
  },
  {
    height: 0.47,
    baseRadius: 0.048,
    topRadius: 0.012,
    bend: 0.06,
    bends: 2,
    primaries: [7, 9],
    firstAt: 0.3,
    spread: 0.43,
    droop: 0.08,
    rise: 0.3,
    padTall: 0.05,
    apexWide: 0.12,
    apexTall: 0.066,
    tuft: 0.034,
    flat: 0.72,
    tropism: 0.18,
    step: 0.013,
    attract: 0.95,
    tip: 0.0024,
    jin: 0.15,
  },
];

/** The pipe model's exponent. */
const PIPE = 3;
/** Keep pads this far inside the map's edges. */
const MARGIN = 0.05;

class Grower {
  readonly nodes: TreeNode[] = [];
  readonly pads: Pad[] = [];
  readonly tufts: Tuft[] = [];
  readonly #shape: Shape;
  readonly #rand: () => number;

  constructor(shape: Shape, rand: () => number) {
    this.#shape = shape;
    this.#rand = rand;
  }

  add(x: number, y: number, z: number, parent: number, kind: NodeKind, pad: number, r = 0): number {
    const index = this.nodes.length;
    this.nodes.push({ x, y, z, r, parent, children: [], kind, pad, flex: 0, removed: false });
    this.nodes[parent]?.children.push(index);
    return index;
  }

  /** The trunk line: S-curves easing toward the apex, which stands roughly over the foot. */
  trunk(): number[] {
    const s = this.#shape;
    const rand = this.#rand;
    const phase = rand() * Math.PI * 2;
    const phaseZ = rand() * Math.PI * 2;
    const apexShift = (rand() - 0.5) * 0.08;
    const raw = (u: number): number =>
      s.bend * Math.sin(Math.PI * s.bends * u + phase) * Math.pow(1 - u, 0.5) * Math.min(1, u * 6);
    const end = raw(1);
    const count = 28;
    const indices: number[] = [];
    let parent = -1;
    const base = BONSAI_SOIL_Y + bonsaiMound(BONSAI_TRUNK.x, BONSAI_TRUNK.z) - 0.01;
    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const x = BONSAI_TRUNK.x + raw(u) - end * u + apexShift * u * u;
      const z =
        BONSAI_TRUNK.z +
        0.6 * s.bend * Math.sin(Math.PI * 1.3 * u + phaseZ) * u * (1 - u) * 2 -
        0.035 * u * u;
      const taper =
        s.baseRadius * (1 - 0.74 * Math.pow(u, 0.8)) + s.baseRadius * 0.4 * Math.exp(-u * 16);
      const gnarl = 1 + 0.1 * Math.sin(u * 23 + phase) * (1 - u);
      parent = this.add(
        x,
        base + u * s.height,
        z,
        parent,
        "trunk",
        -1,
        Math.max(s.topRadius, taper * gnarl),
      );
      indices.push(parent);
    }
    return indices;
  }

  /** A pad: an ellipsoid of foliage, kept inside the map. */
  pad(
    x: number,
    y: number,
    z: number,
    ux: number,
    uz: number,
    long: number,
    side: number,
    tall: number,
  ): number {
    const room = Math.min(x - BONSAI_REGION.x0 - MARGIN, BONSAI_REGION.x1 - MARGIN - x);
    const fit = Math.max(
      0.4,
      Math.min(1, room / Math.max(Math.abs(ux) * long + Math.abs(uz) * side, 1e-3)),
    );
    const top = BONSAI_REGION.y1 - MARGIN - tall;
    this.pads.push({ x, y: Math.min(y, top), z, ux, uz, long: long * fit, side: side * fit, tall });
    return this.pads.length - 1;
  }

  /** Primary branches: wired down from the trunk, out level, tips lifting, each ending in pads. */
  branches(trunk: readonly number[]): void {
    const s = this.#shape;
    const rand = this.#rand;
    const [lo, hi] = s.primaries;
    const count = lo + Math.floor(rand() * (hi - lo + 1));
    const first = s.firstAt + 0.04 * rand();
    const weights = Array.from(
      { length: count },
      (_, i) => Math.pow(0.84, i) * (0.85 + 0.3 * rand()),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const start = rand() < 0.5 ? 1 : -1;
    // Right, left, back, then round again: never straight at the viewer.
    const pattern = [start, -start, 0, -start, start, 0];
    let u = first;
    for (let i = 0; i < count; i++) {
      const side = pattern[i % pattern.length] ?? 1;
      const theta =
        side === 0
          ? Math.PI / 2 + (rand() < 0.5 ? -1 : 1) * (0.45 + 0.4 * rand())
          : (side > 0 ? 0 : Math.PI) + (rand() - 0.5) * 0.7 - side * 0.12;
      const climb = (u - first) / Math.max(0.93 - first, 1e-3);
      const length =
        s.spread * (1 - 0.62 * climb) * (0.85 + 0.25 * rand()) * (side === 0 ? 0.72 : 1);
      const at = trunk[Math.min(trunk.length - 2, Math.round(u * (trunk.length - 1)))] ?? 0;
      this.#branch(at, theta, length, rand);
      u += ((0.93 - first) * (weights[i] ?? 0)) / total;
    }
    // The apex: a dome over the trunk's top, grown from its last few nodes.
    const top = this.nodes[trunk[trunk.length - 1] ?? 0];
    if (top) {
      const pad = this.pad(
        top.x,
        top.y + s.apexTall * 0.35,
        top.z,
        1,
        0,
        s.apexWide,
        s.apexWide * 0.85,
        s.apexTall,
      );
      this.colonize(pad, trunk.slice(-4));
    }
  }

  #branch(at: number, theta: number, length: number, rand: () => number): void {
    const s = this.#shape;
    const root = this.nodes[at];
    if (!root) return;
    const steps = 9;
    const hx = Math.cos(theta);
    const hz = Math.sin(theta);
    let x = root.x + hx * root.r * 0.5;
    let y = root.y;
    let z = root.z + hz * root.r * 0.5;
    let parent = at;
    const path: number[] = [];
    const wiggle = rand() * Math.PI * 2;
    for (let j = 1; j <= steps; j++) {
      const f = j / steps;
      const elev = -s.droop * (1 - f) * (1 - f) + s.rise * Math.pow(f, 2.2);
      const turn = theta + 0.22 * Math.sin(j * 1.4 + wiggle);
      const step = length / steps;
      x += Math.cos(turn) * Math.cos(elev) * step;
      z += Math.sin(turn) * Math.cos(elev) * step;
      y += Math.sin(elev) * step;
      parent = this.add(x, y, z, parent, "branch", -1);
      path.push(parent);
    }
    const pads = length > 0.3 ? [0.55, 0.97] : [0.85];
    for (const [k, at2] of pads.entries()) {
      const node =
        this.nodes[path[Math.min(path.length - 1, Math.round(at2 * (path.length - 1)))] ?? 0];
      if (!node) continue;
      const share = pads.length > 1 ? (k === 0 ? 0.5 : 0.62) : 1;
      const long = (0.5 * length * share + 0.035) * (0.9 + 0.2 * rand());
      const pad = this.pad(
        node.x + hx * 0.02,
        node.y + s.padTall * 0.45,
        node.z + hz * 0.02,
        hx,
        hz,
        long,
        long * 0.78,
        s.padTall * (0.9 + 0.25 * rand()),
      );
      const p = this.pads[pad];
      if (!p) continue;
      const seeds = path.filter((index) => {
        const n = this.nodes[index];
        return n !== undefined && Math.hypot(n.x - p.x, n.z - p.z) < p.long * 1.15;
      });
      for (const index of seeds) {
        const n = this.nodes[index];
        if (n) n.pad = pad;
      }
      this.colonize(pad, seeds.length > 0 ? seeds : path.slice(-2));
    }
  }

  /** Space colonisation inside one pad, from its seed nodes. */
  colonize(pad: number, seeds: readonly number[]): void {
    const s = this.#shape;
    const rand = this.#rand;
    const p = this.pads[pad];
    if (!p) return;
    const vx = -p.uz;
    const vz = p.ux;
    const count = Math.round(Math.min(90, Math.max(22, s.attract * 1100 * p.long * p.side)));
    const ax: number[] = [];
    const ay: number[] = [];
    const az: number[] = [];
    while (ax.length < count) {
      const a = rand() * 2 - 1;
      const b = rand() * 2 - 1;
      const c = rand() * 2 - 1;
      if (a * a + b * b + c * c > 1 || c < -0.6) continue;
      // Pads are cleaned underneath: few points in the bottom third.
      if (c < -0.3 && rand() < 0.7) continue;
      ax.push(p.x + a * p.long * p.ux + b * p.side * vx);
      ay.push(p.y + c * p.tall);
      az.push(p.z + a * p.long * p.uz + b * p.side * vz);
    }
    const alive = ax.map(() => true);
    const reach = Math.max(0.09, 0.7 * p.long);
    const kill = 1.7 * s.step;
    const active = [...seeds];
    const grown: number[] = [];
    const inside = (x: number, y: number, z: number): boolean => {
      const dx = x - p.x;
      const dz = z - p.z;
      const a = (dx * p.ux + dz * p.uz) / p.long;
      const b = (dx * vx + dz * vz) / p.side;
      const c = (y - p.y) / p.tall;
      return a * a + b * b + c * c < 1.3;
    };
    for (let iter = 0; iter < 60; iter++) {
      const sum = new Float64Array(active.length * 4);
      let any = false;
      for (let k = 0; k < ax.length; k++) {
        if (!alive[k]) continue;
        const x = ax[k] ?? 0;
        const y = ay[k] ?? 0;
        const z = az[k] ?? 0;
        let best = -1;
        let bestD = reach;
        for (let j = 0; j < active.length; j++) {
          const n = this.nodes[active[j] ?? 0];
          if (!n) continue;
          const d = Math.hypot(x - n.x, y - n.y, z - n.z);
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
        if (best < 0) continue;
        const n = this.nodes[active[best] ?? 0];
        if (!n || bestD < 1e-6) continue;
        sum[best * 4] = (sum[best * 4] ?? 0) + (x - n.x) / bestD;
        sum[best * 4 + 1] = (sum[best * 4 + 1] ?? 0) + (y - n.y) / bestD;
        sum[best * 4 + 2] = (sum[best * 4 + 2] ?? 0) + (z - n.z) / bestD;
        sum[best * 4 + 3] = (sum[best * 4 + 3] ?? 0) + 1;
        any = true;
      }
      if (!any) break;
      const fresh: number[] = [];
      const known = active.length;
      for (let j = 0; j < known; j++) {
        if ((sum[j * 4 + 3] ?? 0) === 0) continue;
        const index = active[j] ?? 0;
        const n = this.nodes[index];
        if (!n) continue;
        let dx = (sum[j * 4] ?? 0) / (sum[j * 4 + 3] ?? 1);
        let dy = (sum[j * 4 + 1] ?? 0) / (sum[j * 4 + 3] ?? 1) + s.tropism;
        let dz = (sum[j * 4 + 2] ?? 0) / (sum[j * 4 + 3] ?? 1);
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-6) continue;
        dx /= len;
        dy /= len;
        dz /= len;
        const x = n.x + dx * s.step;
        const y = n.y + dy * s.step;
        const z = n.z + dz * s.step;
        if (!inside(x, y, z)) continue;
        const child = this.add(x, y, z, index, "twig", pad);
        active.push(child);
        fresh.push(child);
        grown.push(child);
      }
      if (fresh.length === 0) break;
      for (let k = 0; k < ax.length; k++) {
        if (!alive[k]) continue;
        for (const index of fresh) {
          const n = this.nodes[index];
          if (n && Math.hypot((ax[k] ?? 0) - n.x, (ay[k] ?? 0) - n.y, (az[k] ?? 0) - n.z) < kill) {
            alive[k] = false;
            break;
          }
        }
      }
    }
    // Tufts on the outer twigs, and some through the upper body of the pad.
    for (const index of grown) {
      const n = this.nodes[index];
      if (!n) continue;
      const terminal = n.children.length === 0;
      if (!terminal && (n.y < p.y || rand() > 0.3)) continue;
      const r = s.tuft * (0.8 + 0.4 * rand());
      this.tufts.push({
        x: n.x,
        y: n.y + 0.35 * r * s.flat,
        z: n.z,
        r,
        flat: s.flat * (0.9 + 0.2 * rand()),
        node: index,
        pad,
        r1: rand(),
        r2: rand(),
        outer: 0,
        removed: false,
        regrow: false,
      });
    }
    if (grown.length === 0) {
      // Nothing grew (a tiny pad): one tuft on its seed so it still reads as foliage.
      const index = seeds[seeds.length - 1] ?? 0;
      const r = s.tuft;
      this.tufts.push({
        x: p.x,
        y: p.y,
        z: p.z,
        r,
        flat: s.flat,
        node: index,
        pad,
        r1: rand(),
        r2: rand(),
        outer: 0,
        removed: false,
        regrow: false,
      });
    }
  }

  /** Nebari: surface roots spreading over the moss from the trunk's flare. */
  roots(foot: number): void {
    const rand = this.#rand;
    const base = this.nodes[foot];
    if (!base) return;
    const angles = [0, Math.PI, -0.75, -2.35, -1.5 + 0.3 * rand(), 0.8, 2.4];
    for (const [k, angle0] of angles.entries()) {
      if (k >= 4 && rand() < 0.35) continue;
      const angle = angle0 + (rand() - 0.5) * 0.35;
      const length = (Math.abs(Math.cos(angle)) > 0.7 ? 0.12 : 0.07) * (0.8 + 0.4 * rand());
      const r0 = base.r * (0.36 + 0.14 * rand());
      let parent = foot;
      const steps = 6;
      for (let j = 1; j <= steps; j++) {
        const f = j / steps;
        const reach = base.r * 0.55 + length * f;
        const x = BONSAI_TRUNK.x + Math.cos(angle + 0.15 * Math.sin(f * 5 + k)) * reach;
        const z = BONSAI_TRUNK.z + Math.sin(angle) * reach * 0.8;
        const y = BONSAI_SOIL_Y + bonsaiMound(x, z) * 0.85 + 0.007 * (1 - f) - 0.012 * f * f;
        parent = this.add(
          x,
          y,
          z,
          parent,
          "root",
          -1,
          Math.max(0.0028, r0 * Math.pow(1 - 0.85 * f, 1.4)),
        );
      }
    }
  }

  /** A jin: a short branch long dead, stripped and bleached. */
  jin(trunk: readonly number[]): void {
    const rand = this.#rand;
    if (rand() >= this.#shape.jin) return;
    const at = trunk[Math.round((0.45 + 0.25 * rand()) * (trunk.length - 1))] ?? 0;
    const root = this.nodes[at];
    if (!root) return;
    const side = rand() < 0.5 ? -1 : 1;
    let parent = at;
    let x = root.x;
    let y = root.y;
    let z = root.z + 0.01;
    for (let j = 1; j <= 4; j++) {
      x += side * 0.016;
      y += 0.012 + 0.006 * (j % 2 === 0 ? -1 : 1);
      z += 0.004;
      parent = this.add(x, y, z, parent, "jin", -1, Math.max(0.0022, 0.0075 * (1 - j / 5)));
    }
  }

  /** Radii by the pipe model, from the tips in; flex from radius. */
  radii(trunk: readonly number[]): void {
    const s = this.#shape;
    const acc = new Float64Array(this.nodes.length);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (!n) continue;
      if (n.kind === "root" || n.kind === "jin") continue;
      const sum = acc[i] ?? 0;
      let r = sum > 0 ? Math.max(s.tip, Math.pow(sum, 1 / PIPE)) : s.tip;
      if (n.kind === "branch") r *= 1.18;
      // The trunk keeps the taper the grower built, whatever it carries.
      if (n.kind === "trunk") r = n.r;
      n.r = r;
      if (n.parent >= 0) acc[n.parent] = (acc[n.parent] ?? 0) + Math.pow(r, PIPE);
    }
    // Branches never thicker than three quarters of the trunk where they leave it.
    for (const n of this.nodes) {
      if (n.kind !== "branch" && n.kind !== "twig") continue;
      let at = n.parent;
      while (at >= 0 && this.nodes[at]?.kind !== "trunk") at = this.nodes[at]?.parent ?? -1;
      const trunkR = this.nodes[at]?.r ?? s.baseRadius;
      n.r = Math.min(n.r, 0.6 * trunkR);
    }
    const base = this.nodes[trunk[0] ?? 0]?.r ?? s.baseRadius;
    for (const [i, n] of this.nodes.entries()) {
      if (n.kind === "trunk") n.flex = 0.04 * (i / Math.max(1, trunk.length - 1));
      else if (n.kind === "branch" || n.kind === "twig")
        n.flex = Math.pow(Math.max(0, Math.min(1, 1 - n.r / (0.32 * base))), 0.8);
      else n.flex = 0;
    }
  }

  /** Each tuft's place out from the trunk, 0..1. */
  outerness(): void {
    let far = 1e-3;
    for (const t of this.tufts)
      far = Math.max(far, Math.hypot(t.x - BONSAI_TRUNK.x, (t.y - 0.3) * 0.7));
    for (const t of this.tufts)
      t.outer = Math.min(1, Math.hypot(t.x - BONSAI_TRUNK.x, (t.y - 0.3) * 0.7) / far);
  }
}

/** Grow the tree for a species and seed. */
export function growTree(species: number, seed: number, maxTufts: number): Tree {
  const shape = SHAPES[species] ?? SHAPES[BONSAI_MAPLE] ?? SHAPES[0];
  if (!shape) throw new Error("bonsai: no tree shapes");
  const rand = mulberry32(
    0x62736169 ^ Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(species + 7, 0x85ebca6b),
  );
  const grower = new Grower(shape, rand);
  const trunk = grower.trunk();
  grower.roots(trunk[0] ?? 0);
  grower.jin(trunk);
  grower.branches(trunk);
  grower.radii(trunk);
  grower.outerness();
  // Too many tufts for the table: drop some from the inside out.
  const tufts = grower.tufts;
  if (tufts.length > maxTufts) {
    tufts.sort((a, b) => b.outer - a.outer);
    tufts.length = maxTufts;
  }
  return { nodes: grower.nodes, pads: grower.pads, tufts, tip: shape.tip };
}

/** Nodes in the subtree under `root` (root included). */
export function subtree(tree: Tree, root: number): number[] {
  const out: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const index = stack.pop() ?? 0;
    out.push(index);
    const n = tree.nodes[index];
    if (n) stack.push(...n.children);
  }
  return out;
}
