// Tero et al.'s adaptive flow network (A. Tero et al., "Rules for biologically inspired adaptive
// network design", Science 327, 2010), the model the scene cites, run live on the CPU. It decides
// where the plasmodium's tubes run; the sim draws them as the opening picture and as the film the
// GPU specks ride (draw.ts).
//   - The plasmodium is a fine mesh of tubes: a jittered scatter of junctions over the dish (finer
//     toward its wall), joined by their Delaunay triangulation. Each food source joins the mesh by
//     spokes to the junctions round it. A tube has a length L (screen heights) and a conductivity D.
//   - Food drives a flow through it: Kirchhoff's law fixes the pressure p at every junction, and so
//     the flux through every tube, Q = D (p_i − p_j) / L.
//   - Tubes adapt to their flux: dD/dt = f(|Q|) − D, with f(|Q|) = |Q|^γ / (1 + |Q|^γ). Heavy flow
//     swells a tube and a tube without flow withers, so the mesh thins into trunks between the
//     food, Steiner junctions and a few cross-links. A flake that has been eaten drives nothing,
//     and the tubes that only served it die away; a new one draws tubes out to it from the veins.
// Time runs in the tubes' own unit: one without flow keeps 1/e of its conductivity after one unit.
//
// Driving the flow: Tero picks one random pair of food sources a step, one pushing a flux I0 in and
// the other drawing it out. Here every source takes part at once, a random balanced half of them
// pushing and the other half drawing, I0 √(N / 2) in all over N sources: the same mean square flux
// through a tube as a random pair drives, which grows much the same network with far less noise a
// step. One Jacobi-preconditioned conjugate-gradient solve a step; a few dozen big steps settle the
// opening network from the mesh, as the live mould would over a minute or two.
import { hash31, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { dishRadius, item, PhysarumError, TAU } from "./grid.ts";

/** Junction spacing in open agar (heights), the share of it by the dish's wall, and the longest tube (heights). */
const WEB_SPACING = 0.062;
const WEB_FINE = 0.62;
const WEB_LONGEST = 0.2;
/** Darts thrown for the scatter. */
const WEB_DARTS = 16_000;
/** A food source's spokes: to at most FOOD_SPOKES junctions within SPOKE_REACH (heights), at least SPOKES_MIN. */
const SPOKE_REACH = 0.075;
const FOOD_SPOKES = 8;
const SPOKES_MIN = 3;
/** Food slots: the dish's flakes, and eaten ones whose tubes have not yet died away. */
const FOOD_SLOTS = 48;
/**
 * Tero's flux and feedback exponent. γ = 1.8 is his; his runs took I0 from 0.2 to 7.2, more of it
 * keeping more cross-links: at 4, the flakes are joined into one network with a few loops.
 */
const FLUX = 4;
const GAMMA = 1.8;
/** Conductivity a withered tube keeps, so the mesh stays one piece and new food can draw on it. */
const D_FLOOR = 1e-3;
/** An eaten flake's slot is freed once all its spokes have withered below this. */
const D_GONE = 0.01;
/** Steps per unit of tube time while live. */
const TICKS = 24;
/** The opening: steps from Tero's random start, each this share of the way to the flow's demand. */
const GROW_STEPS = 30;
const GROW_RATE = 0.5;
/** Conjugate gradients: stop once the flux left unbalanced is this share of the flux driven, or after SOLVE_MAX. */
const SOLVE_TOLERANCE = 1e-3;
const SOLVE_MAX = 400;
/** Lace: level (sketch units), the share of tubes kept in the open (more in patches), and its cap. */
const LACE_LEVEL = 0.2;
const LACE_KEEP = 0.34;
const LACE_MAX = 0.36;

/** Tero's tube response to flux: |Q|^γ / (1 + |Q|^γ). */
function demand(flux: number): number {
  const q = Math.pow(Math.abs(flux), GAMMA);
  return q / (1 + q);
}

/** Value noise 0..1, one lattice cell per `scale`. */
function patchNoise(x: number, y: number, scale: number, seed: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = smoothstep(0, 1, gx - ix);
  const fy = smoothstep(0, 1, gy - iy);
  const top = hash31(ix, iy, seed) * (1 - fx) + hash31(ix + 1, iy, seed) * fx;
  const bottom = hash31(ix, iy + 1, seed) * (1 - fx) + hash31(ix + 1, iy + 1, seed) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Delaunay edges of the points (Bowyer–Watson), flattened as pairs i, j with i < j. */
function delaunay(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  const stride = n + 3;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i] ?? 0);
    minY = Math.min(minY, ys[i] ?? 0);
    maxX = Math.max(maxX, xs[i] ?? 0);
    maxY = Math.max(maxY, ys[i] ?? 0);
  }
  const span = 40 * Math.max(maxX - minX, maxY - minY, 1);
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const px = new Float64Array(stride);
  const py = new Float64Array(stride);
  px.set(xs);
  py.set(ys);
  px[n] = mx - span;
  py[n] = my - span;
  px[n + 1] = mx + span;
  py[n + 1] = my - span;
  px[n + 2] = mx;
  py[n + 2] = my + span;
  // Triangles: three vertices and the circle through them (centre, squared radius).
  const va: number[] = [];
  const vb: number[] = [];
  const vc: number[] = [];
  const ox: number[] = [];
  const oy: number[] = [];
  const or2: number[] = [];
  const add = (a: number, b: number, c: number): void => {
    const ax = px[a] ?? 0;
    const ay = py[a] ?? 0;
    const bx = px[b] ?? 0;
    const by = py[b] ?? 0;
    const cx = px[c] ?? 0;
    const cy = py[c] ?? 0;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    va.push(a);
    vb.push(b);
    vc.push(c);
    if (Math.abs(d) < 1e-12) {
      // Flat: it contains every point, so the next one removes it.
      ox.push(0);
      oy.push(0);
      or2.push(Infinity);
      return;
    }
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    ox.push(ux);
    oy.push(uy);
    or2.push((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
  };
  add(n, n + 1, n + 2);
  const hole = new Map<number, number>();
  const edge = (a: number, b: number): void => {
    const key = Math.min(a, b) * stride + Math.max(a, b);
    hole.set(key, (hole.get(key) ?? 0) + 1);
  };
  for (let p = 0; p < n; p++) {
    const x = px[p] ?? 0;
    const y = py[p] ?? 0;
    hole.clear();
    // The triangles whose circle holds the point go; the hole they leave is fanned out from it.
    for (let t = 0; t < va.length;) {
      const dx = x - (ox[t] ?? 0);
      const dy = y - (oy[t] ?? 0);
      if (dx * dx + dy * dy >= (or2[t] ?? 0)) {
        t++;
        continue;
      }
      edge(va[t] ?? 0, vb[t] ?? 0);
      edge(vb[t] ?? 0, vc[t] ?? 0);
      edge(vc[t] ?? 0, va[t] ?? 0);
      const last = va.length - 1;
      va[t] = va[last] ?? 0;
      vb[t] = vb[last] ?? 0;
      vc[t] = vc[last] ?? 0;
      ox[t] = ox[last] ?? 0;
      oy[t] = oy[last] ?? 0;
      or2[t] = or2[last] ?? 0;
      va.pop();
      vb.pop();
      vc.pop();
      ox.pop();
      oy.pop();
      or2.pop();
    }
    for (const [key, count] of hole) {
      if (count === 1) add(Math.floor(key / stride), key % stride, p);
    }
  }
  const seen = new Set<number>();
  const edges: number[] = [];
  const keep = (a: number, b: number): void => {
    if (a >= n || b >= n) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * stride + hi;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(lo, hi);
  };
  for (let t = 0; t < va.length; t++) {
    keep(va[t] ?? 0, vb[t] ?? 0);
    keep(vb[t] ?? 0, vc[t] ?? 0);
    keep(vc[t] ?? 0, va[t] ?? 0);
  }
  return edges;
}

/** A food source as the network sees it: centre in screen uv, presence 0..1 (landing, laid, being eaten). */
export interface NetworkFood {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly strength: number;
}

/** Whether the light shuts the mould out of a point (screen uv): the lit sea. */
export type Lit = (u: number, v: number) => boolean;

/**
 * A flow network's whole state between steps (FlowNetwork.state), plain values and typed arrays:
 * what the build worker hands the page (sims/build.ts).
 */
export interface FlowNetworkState {
  readonly aspect: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly meshNodes: number;
  readonly ea: Int32Array;
  readonly eb: Int32Array;
  readonly length: Float64Array;
  readonly conductivity: Float64Array;
  readonly flow: Float64Array;
  readonly lace: Float32Array;
  readonly meshTubes: number;
  readonly lit: Uint8Array;
  readonly lightOn: boolean;
  readonly slotId: Int32Array;
  readonly weight: Float64Array;
  readonly heartSlot: number;
  readonly cells: number[][];
  readonly cols: number;
  readonly rows: number;
  readonly component: Int32Array;
  readonly topologyDirty: boolean;
  /** The flow's random draws, where they stand (Random.state). */
  readonly rand: number;
  readonly stepDebt: number;
  readonly pressure: Float64Array;
}

/**
 * The tube network over the dish of one frame aspect. Junctions and tubes keep fixed indices: the
 * mesh's first, then each food slot's junction and its FOOD_SPOKES spokes (an unused spoke has no
 * length and carries nothing).
 */
export class FlowNetwork {
  /** The frame aspect it was laid out for: lengths are in heights at it. */
  readonly aspect: number;
  /** Junctions in screen uv: the mesh's (meshNodes of them), then one per food slot. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly meshNodes: number;
  readonly nodes: number;
  /** Tubes: ends (a spoke leaves its food's junction), length (heights; 0 unused) and conductivity. */
  readonly ea: Int32Array;
  readonly eb: Int32Array;
  readonly length: Float64Array;
  readonly conductivity: Float64Array;
  /** Each tube's flux |Q|, followed at the pace its conductivity follows it: what it carries. */
  readonly flow: Float64Array;
  /** The lace a mesh tube is drawn with however little it carries (0 for most, and for spokes). */
  readonly lace: Float32Array;
  readonly meshTubes: number;
  readonly tubes: number;

  /** The lit sea, and the tubes over it, shut while the light is on. */
  readonly #sea: Lit;
  readonly #lit: Uint8Array;
  #lightOn = true;
  /** Per food slot: the food's id (-1 free) and its presence. */
  readonly #slotId: Int32Array = new Int32Array(FOOD_SLOTS).fill(-1);
  readonly #weight: Float64Array = new Float64Array(FOOD_SLOTS);
  #heartSlot = -1;
  /** Mesh junctions by place (cells SPOKE_REACH heights wide), for a food source's spokes. */
  readonly #cells: number[][];
  readonly #cols: number;
  readonly #rows: number;
  /** Per junction: its component over the open tubes (the component's first junction, its ground). */
  readonly #component: Int32Array;
  #topologyDirty = true;
  readonly #rand: Random;
  #stepDebt = 0;
  /** The solver's pressures (the next solve's start), tube conductances D / L (0 while shut), junction diagonal, CG vectors. */
  readonly #pressure: Float64Array;
  readonly #c: Float64Array;
  readonly #diag: Float64Array;
  readonly #rhs: Float64Array;
  readonly #r: Float64Array;
  readonly #z: Float64Array;
  readonly #p: Float64Array;
  readonly #ap: Float64Array;

  /**
   * A fresh mesh over the dish of a frame of this aspect: junctions dart-thrown at least a spacing
   * apart (WEB_FINE of it toward the wall, where the mould's fans advance), joined by Delaunay; the
   * tubes over the lit sea marked. `seed` fixes the mesh, the lace and the flow's random draws. Or
   * a network as it stood (`state`, on its own arrays), going on exactly as it would have.
   */
  constructor(aspect: number, lit: Lit, seed: number);
  constructor(state: FlowNetworkState, lit: Lit);
  constructor(from: number | FlowNetworkState, lit: Lit, seed = 0) {
    this.#sea = lit;
    if (typeof from !== "number") {
      this.aspect = from.aspect;
      this.xs = from.xs;
      this.ys = from.ys;
      this.meshNodes = from.meshNodes;
      this.nodes = from.meshNodes + FOOD_SLOTS;
      this.ea = from.ea;
      this.eb = from.eb;
      this.length = from.length;
      this.conductivity = from.conductivity;
      this.flow = from.flow;
      this.lace = from.lace;
      this.meshTubes = from.meshTubes;
      this.tubes = from.meshTubes + FOOD_SLOTS * FOOD_SPOKES;
      this.#lit = from.lit;
      this.#lightOn = from.lightOn;
      this.#slotId = from.slotId;
      this.#weight = from.weight;
      this.#heartSlot = from.heartSlot;
      this.#cells = from.cells;
      this.#cols = from.cols;
      this.#rows = from.rows;
      this.#component = from.component;
      this.#topologyDirty = from.topologyDirty;
      this.#rand = new Random(from.rand);
      this.#stepDebt = from.stepDebt;
      this.#pressure = from.pressure;
      this.#c = new Float64Array(this.tubes);
      this.#diag = new Float64Array(this.nodes);
      this.#rhs = new Float64Array(this.nodes);
      this.#r = new Float64Array(this.nodes);
      this.#z = new Float64Array(this.nodes);
      this.#p = new Float64Array(this.nodes);
      this.#ap = new Float64Array(this.nodes);
      return;
    }
    const aspect = from;
    this.aspect = aspect;
    const rand = new Random(seed);
    this.#rand = rand;
    // The scatter, in heights.
    const dish = dishRadius(aspect) - 0.008;
    const cx = aspect / 2;
    const cols = Math.ceil(aspect / WEB_SPACING) + 1;
    const rows = Math.ceil(1 / WEB_SPACING) + 1;
    const cells: number[][] = Array.from({ length: cols * rows }, () => []);
    const hx: number[] = [];
    const hy: number[] = [];
    for (let dart = 0; dart < WEB_DARTS; dart++) {
      const a = rand.next() * TAU;
      const r = dish * Math.sqrt(rand.next());
      const x = cx + Math.cos(a) * r;
      const y = 0.5 + Math.sin(a) * r;
      if (x < 0 || x > aspect || y < 0 || y > 1) continue;
      const gap = WEB_SPACING * (1 - (1 - WEB_FINE) * smoothstep(0.7 * dish, 0.97 * dish, r));
      const ci = Math.min(cols - 1, Math.floor(x / WEB_SPACING));
      const cj = Math.min(rows - 1, Math.floor(y / WEB_SPACING));
      let free = true;
      for (let j = Math.max(0, cj - 1); j <= Math.min(rows - 1, cj + 1) && free; j++) {
        for (let i = Math.max(0, ci - 1); i <= Math.min(cols - 1, ci + 1) && free; i++) {
          for (const q of item(cells, j * cols + i)) {
            const dx = (hx[q] ?? 0) - x;
            const dy = (hy[q] ?? 0) - y;
            if (dx * dx + dy * dy < gap * gap) {
              free = false;
              break;
            }
          }
        }
      }
      if (!free) continue;
      item(cells, cj * cols + ci).push(hx.length);
      hx.push(x);
      hy.push(y);
    }
    const meshNodes = hx.length;
    this.meshNodes = meshNodes;
    this.nodes = meshNodes + FOOD_SLOTS;
    this.xs = new Float64Array(this.nodes);
    this.ys = new Float64Array(this.nodes);
    for (let i = 0; i < meshNodes; i++) {
      this.xs[i] = (hx[i] ?? 0) / aspect;
      this.ys[i] = hy[i] ?? 0;
    }
    // Mesh tubes: Delaunay edges that are not overlong.
    const ends: number[] = [];
    const lengths: number[] = [];
    const mesh = delaunay(hx, hy);
    for (let k = 0; k < mesh.length; k += 2) {
      const a = mesh[k] ?? 0;
      const b = mesh[k + 1] ?? 0;
      const length = this.#gap(a, b);
      if (length > WEB_LONGEST) continue;
      ends.push(a, b);
      lengths.push(length);
    }
    this.meshTubes = lengths.length;
    this.tubes = this.meshTubes + FOOD_SLOTS * FOOD_SPOKES;
    this.ea = new Int32Array(this.tubes);
    this.eb = new Int32Array(this.tubes);
    this.length = new Float64Array(this.tubes);
    this.conductivity = new Float64Array(this.tubes);
    this.flow = new Float64Array(this.tubes);
    this.lace = new Float32Array(this.tubes);
    this.#lit = new Uint8Array(this.tubes);
    const noiseSeed = seed & 0xffff;
    for (let e = 0; e < this.meshTubes; e++) {
      const a = ends[2 * e] ?? 0;
      const b = ends[2 * e + 1] ?? 0;
      this.ea[e] = a;
      this.eb[e] = b;
      this.length[e] = lengths[e] ?? 0;
      this.#lit[e] = this.#over(a, b) ? 1 : 0;
      // The lace: tubes kept at random, more of them in patches, each at its own faint level.
      const mx = (((this.xs[a] ?? 0) + (this.xs[b] ?? 0)) / 2) * aspect;
      const my = ((this.ys[a] ?? 0) + (this.ys[b] ?? 0)) / 2;
      const patch =
        patchNoise(mx, my, 0.3, noiseSeed) * 0.6 + patchNoise(mx, my, 0.11, noiseSeed + 5) * 0.4;
      const keep = LACE_KEEP + 0.35 * smoothstep(0.3, 0.7, patch);
      const level = LACE_LEVEL * (0.75 + 0.5 * rand.next()) * (0.6 + 0.6 * patch);
      if (rand.next() <= keep) this.lace[e] = Math.min(LACE_MAX, level);
    }
    for (let s = 0; s < FOOD_SLOTS; s++) {
      for (let k = 0; k < FOOD_SPOKES; k++) {
        const e = this.meshTubes + s * FOOD_SPOKES + k;
        this.ea[e] = meshNodes + s;
        this.eb[e] = meshNodes + s;
      }
    }
    this.#cols = Math.ceil(aspect / SPOKE_REACH) + 1;
    this.#rows = Math.ceil(1 / SPOKE_REACH) + 1;
    this.#cells = Array.from({ length: this.#cols * this.#rows }, () => []);
    for (let i = 0; i < meshNodes; i++) {
      const ci = Math.min(this.#cols - 1, Math.floor((hx[i] ?? 0) / SPOKE_REACH));
      const cj = Math.min(this.#rows - 1, Math.floor((hy[i] ?? 0) / SPOKE_REACH));
      item(this.#cells, cj * this.#cols + ci).push(i);
    }
    this.#component = new Int32Array(this.nodes);
    this.#pressure = new Float64Array(this.nodes);
    this.#c = new Float64Array(this.tubes);
    this.#diag = new Float64Array(this.nodes);
    this.#rhs = new Float64Array(this.nodes);
    this.#r = new Float64Array(this.nodes);
    this.#z = new Float64Array(this.nodes);
    this.#p = new Float64Array(this.nodes);
    this.#ap = new Float64Array(this.nodes);
  }

  /** The network between steps, as its own arrays (not copies): `new FlowNetwork(state, lit)` goes on from it. */
  get state(): FlowNetworkState {
    return {
      aspect: this.aspect,
      xs: this.xs,
      ys: this.ys,
      meshNodes: this.meshNodes,
      ea: this.ea,
      eb: this.eb,
      length: this.length,
      conductivity: this.conductivity,
      flow: this.flow,
      lace: this.lace,
      meshTubes: this.meshTubes,
      lit: this.#lit,
      lightOn: this.#lightOn,
      slotId: this.#slotId,
      weight: this.#weight,
      heartSlot: this.#heartSlot,
      cells: this.#cells,
      cols: this.#cols,
      rows: this.#rows,
      component: this.#component,
      topologyDirty: this.#topologyDirty,
      rand: this.#rand.state,
      stepDebt: this.#stepDebt,
      pressure: this.#pressure,
    };
  }

  /** Distance between two junctions in heights. */
  #gap(a: number, b: number): number {
    const dx = ((this.xs[a] ?? 0) - (this.xs[b] ?? 0)) * this.aspect;
    const dy = (this.ys[a] ?? 0) - (this.ys[b] ?? 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Whether a tube between two junctions crosses the lit sea (at its middle or either quarter). */
  #over(a: number, b: number): boolean {
    const ax = this.xs[a] ?? 0;
    const ay = this.ys[a] ?? 0;
    const bx = this.xs[b] ?? 0;
    const by = this.ys[b] ?? 0;
    return (
      this.#sea((ax + bx) / 2, (ay + by) / 2) ||
      this.#sea(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by) ||
      this.#sea(0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by)
    );
  }

  /** Whether tube e is there now: in use, and not over the sea while it is lit. */
  isOpen(e: number): boolean {
    return (this.length[e] ?? 0) > 0 && !(this.#lightOn && this.#lit[e] === 1);
  }

  /** The light on the sea (on, unless an M has put it out): tubes over it shut while it is on. */
  setLight(on: boolean): void {
    if (on === this.#lightOn) return;
    this.#lightOn = on;
    this.#topologyDirty = true;
  }

  get lightOn(): boolean {
    return this.#lightOn;
  }

  /** The junction of the food source with this id, or -1. */
  foodNode(id: number): number {
    const s = this.#slotId.indexOf(id);
    return s < 0 ? -1 : this.meshNodes + s;
  }

  /** The heart's junction (where the mould began), or -1. */
  get heartNode(): number {
    return this.#heartSlot < 0 ? -1 : this.meshNodes + this.#heartSlot;
  }

  /** A junction's food presence: 0 for the mesh's, and for eaten food. */
  presence(node: number): number {
    return node < this.meshNodes ? 0 : (this.#weight[node - this.meshNodes] ?? 0);
  }

  /**
   * The food on the dish now, and the heart's id: new food is joined to the mesh by spokes, food
   * missing from the list drives no flow, and its slot is freed once its spokes have withered.
   */
  setFood(food: readonly NetworkFood[], heart: number): void {
    const seen = new Uint8Array(FOOD_SLOTS);
    for (const f of food) {
      let s = this.#slotId.indexOf(f.id);
      if (s < 0) s = this.#attach(f);
      if (s < 0) continue;
      seen[s] = 1;
      this.#weight[s] = Math.max(0, Math.min(1, f.strength));
    }
    this.#heartSlot = this.#slotId.indexOf(heart);
    for (let s = 0; s < FOOD_SLOTS; s++) {
      if ((this.#slotId[s] ?? -1) < 0 || seen[s] === 1) continue;
      this.#weight[s] = 0;
      if (this.#strongestSpoke(s) < D_GONE) this.#free(s);
    }
  }

  #strongestSpoke(s: number): number {
    let strongest = 0;
    for (let k = 0; k < FOOD_SPOKES; k++)
      strongest = Math.max(strongest, this.conductivity[this.meshTubes + s * FOOD_SPOKES + k] ?? 0);
    return strongest;
  }

  /** A slot for new food (the most withered eaten one if none is free), joined to the mesh; -1 if none. */
  #attach(food: NetworkFood): number {
    let s = this.#slotId.indexOf(-1);
    if (s < 0) {
      let weakest = Infinity;
      for (let t = 0; t < FOOD_SLOTS; t++) {
        if ((this.#weight[t] ?? 0) > 0) continue;
        const strongest = this.#strongestSpoke(t);
        if (strongest < weakest) {
          weakest = strongest;
          s = t;
        }
      }
      if (s < 0) return -1;
      this.#free(s);
    }
    const node = this.meshNodes + s;
    this.#slotId[s] = food.id;
    this.xs[node] = food.x;
    this.ys[node] = food.y;
    // Spokes to the nearest junctions within reach (at least SPOKES_MIN, however far).
    const ci = Math.floor((food.x * this.aspect) / SPOKE_REACH);
    const cj = Math.floor(food.y / SPOKE_REACH);
    const near: { node: number; d: number }[] = [];
    for (let ring = 1; ring <= 4 && near.length < SPOKES_MIN; ring++) {
      near.length = 0;
      for (let j = Math.max(0, cj - ring); j <= Math.min(this.#rows - 1, cj + ring); j++) {
        for (let i = Math.max(0, ci - ring); i <= Math.min(this.#cols - 1, ci + ring); i++) {
          for (const m of item(this.#cells, j * this.#cols + i))
            near.push({ node: m, d: this.#gap(node, m) });
        }
      }
      near.sort((a, b) => a.d - b.d);
      let within = 0;
      while (within < near.length && item(near, within).d <= SPOKE_REACH) within++;
      near.length = Math.min(FOOD_SPOKES, Math.max(Math.min(SPOKES_MIN, near.length), within));
    }
    near.forEach(({ node: m, d }, k) => {
      const e = this.meshTubes + s * FOOD_SPOKES + k;
      this.eb[e] = m;
      this.length[e] = Math.max(d, 1e-4);
      this.conductivity[e] = D_FLOOR;
      this.flow[e] = 0;
      this.#lit[e] = this.#over(node, m) ? 1 : 0;
    });
    this.#topologyDirty = true;
    return s;
  }

  #free(s: number): void {
    this.#slotId[s] = -1;
    this.#weight[s] = 0;
    for (let k = 0; k < FOOD_SPOKES; k++) {
      const e = this.meshTubes + s * FOOD_SPOKES + k;
      this.eb[e] = this.meshNodes + s;
      this.length[e] = 0;
      this.conductivity[e] = 0;
      this.flow[e] = 0;
    }
    if (this.#heartSlot === s) this.#heartSlot = -1;
    this.#topologyDirty = true;
  }

  /** The opening network: every tube at Tero's random start, then GROW_STEPS big steps. */
  grow(): void {
    for (let e = 0; e < this.tubes; e++) {
      if ((this.length[e] ?? 0) <= 0) continue;
      this.conductivity[e] = 0.5 + 0.5 * this.#rand.next();
      this.flow[e] = 0;
    }
    for (let i = 0; i < GROW_STEPS; i++) this.#step(GROW_RATE);
  }

  /** Live adaptation over `time` units of tube time, TICKS steps a unit. Returns the steps run. */
  advance(time: number): number {
    if (!(time > 0)) return 0;
    this.#stepDebt += time * TICKS;
    const steps = Math.floor(this.#stepDebt);
    this.#stepDebt -= steps;
    for (let i = 0; i < steps; i++) this.#step(1 / TICKS);
    return steps;
  }

  /** One step: a random balanced half of each component's food pushes, the rest draws; tubes move `h` of the way to their demand. */
  #step(h: number): void {
    if (this.#topologyDirty) {
      this.#topologyDirty = false;
      this.#components();
    }
    this.#conductances();
    const live: number[] = [];
    for (let s = 0; s < FOOD_SLOTS; s++) if ((this.#weight[s] ?? 0) > 0) live.push(s);
    for (let i = live.length - 1; i > 0; i--) {
      const j = Math.floor(this.#rand.next() * (i + 1));
      const swap = live[i] ?? 0;
      live[i] = live[j] ?? 0;
      live[j] = swap;
    }
    // Per component: weight pushing and drawing so far, total and sum of squares.
    const sides = new Map<number, { push: number; draw: number; sum: number; squares: number }>();
    const pushes = new Uint8Array(FOOD_SLOTS);
    for (const s of live) {
      const w = this.#weight[s] ?? 0;
      const component = this.#component[this.meshNodes + s] ?? 0;
      let side = sides.get(component);
      if (side === undefined) {
        side = { push: 0, draw: 0, sum: 0, squares: 0 };
        sides.set(component, side);
      }
      if (side.push <= side.draw) {
        pushes[s] = 1;
        side.push += w;
      } else side.draw += w;
      side.sum += w;
      side.squares += w * w;
    }
    this.#rhs.fill(0);
    let driven = 0;
    for (const s of live) {
      const side = sides.get(this.#component[this.meshNodes + s] ?? 0);
      if (side === undefined || side.push <= 0 || side.draw <= 0) continue;
      const total = FLUX * Math.sqrt((side.sum * side.sum) / side.squares / 2);
      const w = this.#weight[s] ?? 0;
      if (pushes[s] === 1) {
        this.#rhs[this.meshNodes + s] = (total * w) / side.push;
        driven += (total * w) / side.push;
      } else this.#rhs[this.meshNodes + s] = (-total * w) / side.draw;
    }
    const x = this.#pressure;
    if (driven > 0) this.#solve(x, driven);
    for (let e = 0; e < this.tubes; e++) {
      if ((this.length[e] ?? 0) <= 0) continue;
      const c = this.#c[e] ?? 0;
      const q =
        driven > 0 && c > 0 ? c * ((x[this.ea[e] ?? 0] ?? 0) - (x[this.eb[e] ?? 0] ?? 0)) : 0;
      const d = this.conductivity[e] ?? 0;
      this.conductivity[e] = Math.max(D_FLOOR, d + h * (demand(q) - d));
      const f = this.flow[e] ?? 0;
      this.flow[e] = f + h * (Math.abs(q) - f);
    }
  }

  #conductances(): void {
    this.#diag.fill(0);
    for (let e = 0; e < this.tubes; e++) {
      const c = this.isOpen(e) ? (this.conductivity[e] ?? 0) / (this.length[e] ?? 1) : 0;
      this.#c[e] = c;
      if (c <= 0) continue;
      const a = this.ea[e] ?? 0;
      const b = this.eb[e] ?? 0;
      this.#diag[a] = (this.#diag[a] ?? 0) + c;
      this.#diag[b] = (this.#diag[b] ?? 0) + c;
    }
  }

  /** Union–find over the open tubes: each junction's component is its first junction. */
  #components(): void {
    const parent = this.#component;
    for (let i = 0; i < this.nodes; i++) parent[i] = i;
    const root = (i: number): number => {
      let r = i;
      while ((parent[r] ?? r) !== r) r = parent[r] ?? r;
      return r;
    };
    for (let e = 0; e < this.tubes; e++) {
      if (!this.isOpen(e)) continue;
      const a = root(this.ea[e] ?? 0);
      const b = root(this.eb[e] ?? 0);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
    for (let i = 0; i < this.nodes; i++) parent[i] = root(i);
  }

  /**
   * Kirchhoff's law over the open tubes by Jacobi-preconditioned conjugate gradients, into `x`
   * (warm from what it holds): the flux this.#rhs pushes in at each junction, each component's
   * ground (its first junction) held at pressure 0. `driven` is the flux pushed in, for the tolerance.
   */
  #solve(x: Float64Array, driven: number): void {
    const n = this.nodes;
    const tubes = this.tubes;
    const { ea, eb } = this;
    const c = this.#c;
    const diag = this.#diag;
    const component = this.#component;
    const r = this.#r;
    const z = this.#z;
    const p = this.#p;
    const ap = this.#ap;
    const apply = (v: Float64Array): void => {
      ap.fill(0);
      for (let e = 0; e < tubes; e++) {
        const ce = c[e] ?? 0;
        if (ce <= 0) continue;
        const a = ea[e] ?? 0;
        const b = eb[e] ?? 0;
        const f = ce * ((v[a] ?? 0) - (v[b] ?? 0));
        ap[a] = (ap[a] ?? 0) + f;
        ap[b] = (ap[b] ?? 0) - f;
      }
    };
    // Grounds and isolated junctions are held at 0; the rest solve.
    const free = (i: number): boolean => component[i] !== i && (diag[i] ?? 0) > 0;
    for (let i = 0; i < n; i++) if (!free(i)) x[i] = 0;
    apply(x);
    let rz = 0;
    let rr = 0;
    for (let i = 0; i < n; i++) {
      const ri = free(i) ? (this.#rhs[i] ?? 0) - (ap[i] ?? 0) : 0;
      const zi = ri === 0 ? 0 : ri / (diag[i] ?? 1);
      r[i] = ri;
      z[i] = zi;
      p[i] = zi;
      rz += ri * zi;
      rr += ri * ri;
    }
    const tolerance = (SOLVE_TOLERANCE * driven) ** 2;
    for (let it = 0; it < SOLVE_MAX && rr > tolerance; it++) {
      apply(p);
      let pap = 0;
      for (let i = 0; i < n; i++) {
        if (!free(i)) ap[i] = 0;
        pap += (p[i] ?? 0) * (ap[i] ?? 0);
      }
      if (!(pap > 0)) break;
      const alpha = rz / pap;
      let next = 0;
      rr = 0;
      for (let i = 0; i < n; i++) {
        x[i] = (x[i] ?? 0) + alpha * (p[i] ?? 0);
        const ri = (r[i] ?? 0) - alpha * (ap[i] ?? 0);
        const zi = ri === 0 ? 0 : ri / (diag[i] ?? 1);
        r[i] = ri;
        z[i] = zi;
        next += ri * zi;
        rr += ri * ri;
      }
      const beta = next / rz;
      rz = next;
      for (let i = 0; i < n; i++) p[i] = (z[i] ?? 0) + beta * (p[i] ?? 0);
    }
    if (!Number.isFinite(rr)) throw new PhysarumError("physarum: the flow solve diverged");
  }

  /**
   * Distance along the veins (open tubes of at least `vein` conductivity) from the heart, heights,
   * per junction (Infinity where none leads).
   */
  veinDistances(vein: number): Float64Array {
    const along = new Float64Array(this.nodes).fill(Infinity);
    const heart = this.heartNode;
    if (heart < 0) return along;
    const adjacent: number[][] = Array.from({ length: this.nodes }, () => []);
    for (let e = 0; e < this.tubes; e++) {
      if (!this.isOpen(e) || (this.conductivity[e] ?? 0) < vein) continue;
      item(adjacent, this.ea[e] ?? 0).push(e);
      item(adjacent, this.eb[e] ?? 0).push(e);
    }
    // Dijkstra with a binary heap of (distance, junction), stale entries skipped as they surface.
    const keys: number[] = [0];
    const heap: number[] = [heart];
    along[heart] = 0;
    while (heap.length > 0) {
      const top = heap[0] ?? 0;
      const topKey = keys[0] ?? 0;
      const lastKey = keys.pop() ?? 0;
      const lastNode = heap.pop() ?? 0;
      if (heap.length > 0) {
        let i = 0;
        for (;;) {
          let child = 2 * i + 1;
          if (child >= keys.length) break;
          if (child + 1 < keys.length && (keys[child + 1] ?? 0) < (keys[child] ?? 0)) child++;
          if ((keys[child] ?? 0) >= lastKey) break;
          keys[i] = keys[child] ?? 0;
          heap[i] = heap[child] ?? 0;
          i = child;
        }
        keys[i] = lastKey;
        heap[i] = lastNode;
      }
      if (topKey > (along[top] ?? Infinity)) continue;
      for (const e of item(adjacent, top)) {
        const a = this.ea[e] ?? 0;
        const other = a === top ? (this.eb[e] ?? 0) : a;
        const d = topKey + (this.length[e] ?? 0);
        if (d >= (along[other] ?? Infinity)) continue;
        along[other] = d;
        let i = keys.length;
        keys.push(d);
        heap.push(other);
        while (i > 0) {
          const up = (i - 1) >> 1;
          if ((keys[up] ?? 0) <= d) break;
          keys[i] = keys[up] ?? 0;
          heap[i] = heap[up] ?? 0;
          i = up;
        }
        keys[i] = d;
        heap[i] = other;
      }
    }
    return along;
  }
}
