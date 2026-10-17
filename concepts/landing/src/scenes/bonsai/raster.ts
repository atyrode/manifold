// Drawing the grown tree into the maps the shader reads, on the CPU, once per tree (on the build
// worker, with the tree: sim.ts bonsaiGrowth) and again on the page after a cut or when cut twigs
// regrow, in display units projected the way the camera sees them.
//   wood (uSim0, rgba16f): signed distance to the bark (units, negative inside), the branch radius
//     there, the depth of its front surface, and deadness (jin). Branches meeting at a fork are
//     joined with a smooth minimum (fillets like real crotches); where one passes in front of
//     another the front one keeps its own field, so its outline shows against the one behind.
//   foliage (uSim1, rgba16f): per texel the most visible tuft (front tufts win except at their very
//     rims, so tufts read as overlapping clumps): its field 1 - |q| (q the ellipse coordinates),
//     its dome normal (x, y), and its index in the tuft table (read with texelFetch).
// From these the low-resolution field: blurred silhouettes of wood and foliage (the shadows on the
// wall and under the canopy), how freely each place moves, and which two pads it moves with.
import {
  BONSAI_ATLAS,
  BONSAI_FIELD,
  BONSAI_LITTER,
  BONSAI_MAP,
  BONSAI_PER_UNIT,
  BONSAI_REGION,
  BONSAI_SPRITE,
  BONSAI_TILT,
} from "./geometry.ts";
import type { Tree } from "./tree.ts";

const W = BONSAI_MAP.width;
const H = BONSAI_MAP.height;
const FW = BONSAI_FIELD.width;
const FH = BONSAI_FIELD.height;
const PER = BONSAI_PER_UNIT;
/** How much a tuft's nearness counts against its field when choosing the visible one. */
const SCORE_DEPTH = 4;
/** Distance stored where there is no wood (units). */
const FAR = 0.05;

/** A smooth 0..1 value noise for erosion order and grain, stable per position. */
export function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const h = (a: number, b: number): number => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * ux;
  const b = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * ux;
  return a + (b - a) * uy;
}

/** A map texel with nothing drawn on it: wood (FAR from any bark, its front at depth 1), foliage (no tuft). */
export const BARE_WOOD = [FAR, 0, 1, 0] as const;
export const BARE_LEAF = [-1, 0, 0, 0] as const;

/** The maps as drawn (TreeMaps.state): what a bonsai build hands the page, as `new TreeMaps(state)` takes them. */
export interface TreeMapsState {
  readonly wood: Float32Array;
  readonly leaf: Float32Array;
  readonly woodSil: Float32Array;
  readonly leafSil: Float32Array;
  readonly flex: Float32Array;
  readonly padA: Int16Array;
  readonly padB: Int16Array;
  readonly weightA: Float32Array;
}

export class TreeMaps {
  readonly wood: Float32Array;
  readonly leaf: Float32Array;
  readonly woodSil: Float32Array;
  readonly leafSil: Float32Array;
  readonly flex: Float32Array;
  readonly padA: Int16Array;
  readonly padB: Int16Array;
  readonly weightA: Float32Array;
  /** A draw's scratch, per map texel: the visible tuft's score, the wood's flex (the first draw makes them). */
  #score = new Float32Array(0);
  #woodFlex = new Float32Array(0);

  /** Blank maps to draw into, or maps drawn already (`state`, on its own arrays). */
  constructor(state?: TreeMapsState) {
    this.wood = state?.wood ?? new Float32Array(W * H * 4);
    this.leaf = state?.leaf ?? new Float32Array(W * H * 4);
    this.woodSil = state?.woodSil ?? new Float32Array(FW * FH);
    this.leafSil = state?.leafSil ?? new Float32Array(FW * FH);
    this.flex = state?.flex ?? new Float32Array(FW * FH);
    this.padA = state?.padA ?? new Int16Array(FW * FH);
    this.padB = state?.padB ?? new Int16Array(FW * FH);
    this.weightA = state?.weightA ?? new Float32Array(FW * FH);
  }

  /** The maps as their own arrays (not copies), as `new TreeMaps(state)` takes them. */
  get state(): TreeMapsState {
    return {
      wood: this.wood,
      leaf: this.leaf,
      woodSil: this.woodSil,
      leafSil: this.leafSil,
      flex: this.flex,
      padA: this.padA,
      padB: this.padB,
      weightA: this.weightA,
    };
  }

  /** Draw every part of the tree that has not been cut. */
  draw(tree: Tree): void {
    const wood = this.wood;
    const leaf = this.leaf;
    if (this.#score.length === 0) {
      this.#score = new Float32Array(W * H);
      this.#woodFlex = new Float32Array(W * H);
    }
    const [w0, w1, w2, w3] = BARE_WOOD;
    const [l0, l1, l2, l3] = BARE_LEAF;
    for (let i = 0; i < W * H; i++) {
      wood[i * 4] = w0;
      wood[i * 4 + 1] = w1;
      wood[i * 4 + 2] = w2;
      wood[i * 4 + 3] = w3;
      leaf[i * 4] = l0;
      leaf[i * 4 + 1] = l1;
      leaf[i * 4 + 2] = l2;
      leaf[i * 4 + 3] = l3;
      this.#score[i] = -1e9;
      this.#woodFlex[i] = 0;
    }
    // Trunk and roots first, so branches meet them; then the rest in growth order.
    for (const pass of [0, 1]) {
      for (const n of tree.nodes) {
        const trunkLike = n.kind === "trunk" || n.kind === "root";
        if (n.removed || n.parent < 0 || trunkLike !== (pass === 0)) continue;
        const p = tree.nodes[n.parent];
        if (!p || p.removed) continue;
        const main = p.children.every((c) => (tree.nodes[c]?.r ?? 0) <= n.r);
        const r0 = n.kind === "trunk" || main ? Math.max(p.r, n.r) : Math.min(p.r, n.r * 1.2);
        this.#stampWood(p.x, p.y, p.z, r0, n.x, n.y, n.z, n.r, n.kind === "jin" ? 1 : 0, n.flex);
      }
    }
    for (const [index, t] of tree.tufts.entries())
      if (!t.removed) this.#stampTuft(t.x, t.y, t.z, t.r, t.flat, index);
    this.#fields(tree);
  }

  #stampWood(
    ax: number,
    ay: number,
    az: number,
    ar: number,
    bx: number,
    by: number,
    bz: number,
    br: number,
    dead: number,
    flex: number,
  ): void {
    const wood = this.wood;
    const sa = ay + BONSAI_TILT * az;
    const sb = by + BONSAI_TILT * bz;
    const ex = bx - ax;
    const ey = sb - sa;
    const l2 = Math.max(ex * ex + ey * ey, 1e-12);
    const k = Math.min(0.014, Math.max(0.0012, 0.5 * Math.min(ar, br)));
    const reach = Math.max(ar, br) + k + 1.5 / PER;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - BONSAI_REGION.x0) * PER));
    const i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + reach - BONSAI_REGION.x0) * PER));
    const j0 = Math.max(0, Math.floor((Math.min(sa, sb) - reach - BONSAI_REGION.y0) * PER));
    const j1 = Math.min(H - 1, Math.ceil((Math.max(sa, sb) + reach - BONSAI_REGION.y0) * PER));
    for (let j = j0; j <= j1; j++) {
      const py = BONSAI_REGION.y0 + (j + 0.5) / PER;
      for (let i = i0; i <= i1; i++) {
        const px = BONSAI_REGION.x0 + (i + 0.5) / PER;
        const t = Math.min(1, Math.max(0, ((px - ax) * ex + (py - sa) * ey) / l2));
        const ux = px - ax - ex * t;
        const uy = py - sa - ey * t;
        const dist = Math.sqrt(ux * ux + uy * uy);
        const rr = ar + (br - ar) * t;
        const d = dist - rr;
        const o = j * W + i;
        const cur = wood[o * 4] ?? FAR;
        if (d > cur + k) continue;
        const zf = az + (bz - az) * t - Math.sqrt(Math.max(rr * rr - dist * dist, 0));
        const curZ = wood[o * 4 + 2] ?? 1;
        const curR = wood[o * 4 + 1] ?? 0;
        if (cur < 0 && d < 0 && Math.abs(zf - curZ) > 0.6 * (rr + curR)) {
          // Crossing at different depths: the front one shows, with its own outline.
          if (zf < curZ) {
            wood[o * 4] = d;
            wood[o * 4 + 1] = rr;
            wood[o * 4 + 2] = zf;
            wood[o * 4 + 3] = dead;
            this.#woodFlex[o] = flex;
          }
          continue;
        }
        const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (cur - d)) / k));
        wood[o * 4] = cur + (d - cur) * h - k * h * (1 - h);
        wood[o * 4 + 1] = curR + (rr - curR) * h;
        wood[o * 4 + 2] = cur >= FAR ? zf : curZ + (zf - curZ) * h;
        wood[o * 4 + 3] = (wood[o * 4 + 3] ?? 0) + (dead - (wood[o * 4 + 3] ?? 0)) * h;
        this.#woodFlex[o] = (this.#woodFlex[o] ?? 0) + (flex - (this.#woodFlex[o] ?? 0)) * h;
      }
    }
  }

  #stampTuft(x: number, y: number, z: number, r: number, flat: number, index: number): void {
    const leaf = this.leaf;
    const cx = x;
    const cy = y + BONSAI_TILT * z;
    const ry = r * flat;
    const front = z - r;
    const i0 = Math.max(0, Math.floor((cx - 1.5 * r - BONSAI_REGION.x0) * PER));
    const i1 = Math.min(W - 1, Math.ceil((cx + 1.5 * r - BONSAI_REGION.x0) * PER));
    const j0 = Math.max(0, Math.floor((cy - 1.5 * ry - BONSAI_REGION.y0) * PER));
    const j1 = Math.min(H - 1, Math.ceil((cy + 1.5 * ry - BONSAI_REGION.y0) * PER));
    for (let j = j0; j <= j1; j++) {
      const qy = (BONSAI_REGION.y0 + (j + 0.5) / PER - cy) / ry;
      for (let i = i0; i <= i1; i++) {
        const qx = (BONSAI_REGION.x0 + (i + 0.5) / PER - cx) / r;
        const ql = Math.sqrt(qx * qx + qy * qy);
        const f = 1 - ql;
        const o = j * W + i;
        const cur = leaf[o * 4] ?? -1;
        if (f <= 0) {
          // Just outside: keep the nearest tuft's field, normal and index, so the edge belongs to it.
          if (cur <= 0 && f > cur) {
            const n = 0.95 / Math.max(ql, 1e-6);
            leaf[o * 4] = f;
            leaf[o * 4 + 1] = qx * n;
            leaf[o * 4 + 2] = qy * n;
            leaf[o * 4 + 3] = index;
          }
          continue;
        }
        const score = f - front * SCORE_DEPTH;
        if (cur > 0 && score <= (this.#score[o] ?? -1e9)) continue;
        const n = Math.min(0.95, 0.9 * ql) / Math.max(ql, 1e-6);
        leaf[o * 4] = f;
        leaf[o * 4 + 1] = qx * n;
        leaf[o * 4 + 2] = qy * n;
        leaf[o * 4 + 3] = index;
        this.#score[o] = score;
      }
    }
  }

  /** Silhouettes, flex and pad weights at a quarter of the map's resolution. */
  #fields(tree: Tree): void {
    const wood = this.wood;
    const leaf = this.leaf;
    for (let fj = 0; fj < FH; fj++) {
      for (let fi = 0; fi < FW; fi++) {
        let w = 0;
        let l = 0;
        let flex = 0;
        let n = 0;
        for (let j = fj * 4; j < Math.min(H, fj * 4 + 4); j++) {
          for (let i = fi * 4; i < fi * 4 + 4; i++) {
            const o = j * W + i;
            n++;
            if ((wood[o * 4] ?? FAR) < 0) {
              w++;
              flex = Math.max(flex, this.#woodFlex[o] ?? 0);
            }
            if ((leaf[o * 4] ?? -1) > 0.05) {
              l++;
              flex = 1;
            }
          }
        }
        const f = fj * FW + fi;
        this.woodSil[f] = w / Math.max(n, 1);
        this.leafSil[f] = l / Math.max(n, 1);
        this.flex[f] = flex;
      }
    }
    // Grow the moving region a little past the outline, so the warp is the same just outside an
    // edge as just inside it, then soften everything.
    for (let pass = 0; pass < 2; pass++) dilate(this.flex);
    for (let pass = 0; pass < 2; pass++) {
      blur(this.woodSil);
      blur(this.leafSil);
    }
    blur(this.flex);
    // The two pads each field texel moves with, by nearness to their centres.
    for (let fj = 0; fj < FH; fj++) {
      const py = BONSAI_REGION.y0 + ((fj + 0.5) * 4) / PER;
      for (let fi = 0; fi < FW; fi++) {
        const px = BONSAI_REGION.x0 + ((fi + 0.5) * 4) / PER;
        let a = -1;
        let b = -1;
        let wa = 0;
        let wb = 0;
        for (const [k, pad] of tree.pads.entries()) {
          const sx = (px - pad.x) / (0.85 * Math.max(pad.long, pad.side));
          const sy =
            (py - pad.y - BONSAI_TILT * pad.z) / (0.85 * Math.max(2 * pad.tall, 0.5 * pad.long));
          const g = Math.exp(-(sx * sx + sy * sy));
          if (g > wa) {
            b = a;
            wb = wa;
            a = k;
            wa = g;
          } else if (g > wb) {
            b = k;
            wb = g;
          }
        }
        const f = fj * FW + fi;
        this.padA[f] = a;
        this.padB[f] = b;
        this.weightA[f] = wa + wb > 1e-6 ? wa / (wa + wb) : 1;
      }
    }
  }
}

function blur(field: Float32Array): void {
  const copy = field.slice();
  for (let j = 0; j < FH; j++) {
    for (let i = 0; i < FW; i++) {
      let s = 0;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const y = j + dj;
        if (y < 0 || y >= FH) continue;
        for (let di = -1; di <= 1; di++) {
          const x = i + di;
          if (x < 0 || x >= FW) continue;
          s += copy[y * FW + x] ?? 0;
          n++;
        }
      }
      field[j * FW + i] = s / n;
    }
  }
}

function dilate(field: Float32Array): void {
  const copy = field.slice();
  for (let j = 0; j < FH; j++) {
    for (let i = 0; i < FW; i++) {
      let m = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const y = Math.min(FH - 1, Math.max(0, j + dj));
        for (let di = -1; di <= 1; di++)
          m = Math.max(m, copy[y * FW + Math.min(FW - 1, Math.max(0, i + di))] ?? 0);
      }
      field[j * FW + i] = m;
    }
  }
}

/** What a cut piece looks like in its sprite: per tuft, its colour now and how leafy it is. */
export interface SpriteLook {
  hue: (tuft: number) => number;
  leafiness: (tuft: number) => number;
}

/**
 * Draw a cut piece (its nodes and tufts) into sprite slot `slot` of the atlas, centred on (px, py)
 * in display units: R wood distance (units), G foliage field (> 0 inside), B foliage hue, A 1 where
 * anything was drawn.
 */
export function drawSprite(
  atlas: Float32Array,
  slot: number,
  tree: Tree,
  nodes: readonly number[],
  tufts: readonly number[],
  px: number,
  py: number,
  look: SpriteLook,
): void {
  const S = BONSAI_SPRITE.size;
  const x0 = BONSAI_LITTER.width + slot * S;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const o = (j * BONSAI_ATLAS.width + x0 + i) * 4;
      atlas[o] = FAR;
      atlas[o + 1] = -1;
      atlas[o + 2] = 0;
      atlas[o + 3] = 0;
    }
  }
  const local = (i: number): number => (i + 0.5) / PER - BONSAI_SPRITE.span / 2;
  for (const index of nodes) {
    const n = tree.nodes[index];
    const p = tree.nodes[n?.parent ?? -1];
    if (!n || !p) continue;
    const ax = p.x - px;
    const ay = p.y + BONSAI_TILT * p.z - py;
    const ex = n.x - p.x;
    const ey = n.y + BONSAI_TILT * n.z - (p.y + BONSAI_TILT * p.z);
    const l2 = Math.max(ex * ex + ey * ey, 1e-12);
    for (let j = 0; j < S; j++) {
      const y = local(j);
      for (let i = 0; i < S; i++) {
        const x = local(i);
        const t = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2));
        const ux = x - ax - ex * t;
        const uy = y - ay - ey * t;
        const d = Math.sqrt(ux * ux + uy * uy) - n.r;
        const o = (j * BONSAI_ATLAS.width + x0 + i) * 4;
        if (d < (atlas[o] ?? FAR)) atlas[o] = d;
        if (d < 0) atlas[o + 3] = 1;
      }
    }
  }
  for (const index of tufts) {
    const t = tree.tufts[index];
    if (!t) continue;
    const lf = look.leafiness(index);
    if (lf < 0.15) continue;
    const cx = t.x - px;
    const cy = t.y + BONSAI_TILT * t.z - py;
    const hue = look.hue(index);
    for (let j = 0; j < S; j++) {
      const qy = (local(j) - cy) / (t.r * t.flat);
      for (let i = 0; i < S; i++) {
        const qx = (local(i) - cx) / t.r;
        const f = 1 - Math.sqrt(qx * qx + qy * qy) - (1 - lf);
        const o = (j * BONSAI_ATLAS.width + x0 + i) * 4;
        if (f > (atlas[o + 1] ?? -1)) {
          atlas[o + 1] = f;
          if (f > 0) {
            atlas[o + 2] = hue;
            atlas[o + 3] = 1;
          }
        }
      }
    }
  }
}

/** One thing lying on a surface, to stamp into the litter. */
export interface LitterMark {
  /** Display position (x, screen y) where it lies. */
  x: number;
  y: number;
  angle: number;
  /** Size in units (a leaf's radius, a petal's length). */
  size: number;
  /** 0 leaf, 1 petal, 2 needle, 3 wood (a twig). */
  kind: number;
  hue: number;
  slot: number;
}

/**
 * Stamp a fallen leaf, petal or needle into the litter (atlas region at x 0..BONSAI_LITTER.width):
 * R (kind + hue) / 4, G slot, B erosion order (a smooth noise: it rots away in patches), A shade.
 * Lying things are seen almost edge-on from the camera, so they are squashed to half height.
 * Returns the texel bounds it touched (x0, y0, x1, y1), or undefined if it landed off the litter.
 */
export function stampLitter(
  atlas: Float32Array,
  mark: LitterMark,
  shape: (lx: number, ly: number) => number,
): readonly [number, number, number, number] | undefined {
  const per = PER;
  const ci = (mark.x - BONSAI_LITTER.x0) * per;
  const cj = (mark.y - BONSAI_LITTER.y0) * per;
  const reach = mark.size * per * 1.3 + 1;
  const i0 = Math.max(0, Math.floor(ci - reach));
  const i1 = Math.min(BONSAI_LITTER.width - 1, Math.ceil(ci + reach));
  const j0 = Math.max(0, Math.floor(cj - reach * 0.6));
  const j1 = Math.min(BONSAI_LITTER.height - 1, Math.ceil(cj + reach * 0.6));
  if (i0 > i1 || j0 > j1) return undefined;
  const c = Math.cos(mark.angle);
  const s = Math.sin(mark.angle);
  const code = (mark.kind + Math.min(0.999, Math.max(0, mark.hue))) / 4;
  const salt = mark.slot * 7.31;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5 - ci) / per;
      const dy = ((j + 0.5 - cj) / per) * 2;
      const lx = (c * dx + s * dy) / mark.size;
      const ly = (-s * dx + c * dy) / mark.size;
      const inside = shape(lx, ly);
      if (inside <= 0) continue;
      const o = (j * BONSAI_ATLAS.width + i) * 4;
      atlas[o] = code;
      atlas[o + 1] = mark.slot;
      atlas[o + 2] = noise2(i * 0.35 + salt, j * 0.5 + salt);
      atlas[o + 3] = 0.7 + 0.3 * Math.min(1, inside);
    }
  }
  return [i0, j0, i1, j1];
}

/** Erase a litter slot's texels inside the given bounds. */
export function eraseLitter(
  atlas: Float32Array,
  slot: number,
  bounds: readonly [number, number, number, number],
): void {
  const [i0, j0, i1, j1] = bounds;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const o = (j * BONSAI_ATLAS.width + i) * 4;
      if (atlas[o + 3] !== 0 && atlas[o + 1] === slot) {
        atlas[o] = 0;
        atlas[o + 1] = 0;
        atlas[o + 2] = 0;
        atlas[o + 3] = 0;
      }
    }
  }
}
