// The dish's food: oat flakes laid by the layout (scattered, on a honeycomb, or at the cities round
// Tokyo Bay with the sea lit), eaten and replaced by the feeding, dropped by hand, and set aside for
// the M and laid again after; and the lit sea the Tokyo map brings.
import { MARK_VERTICES, markVertex } from "../../mark.ts";
import { clamp } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import {
  dishRadius,
  type Grid,
  item,
  PHYSARUM_MAX_FOOD,
  PhysarumError,
  type Point,
  TAU,
} from "./grid.ts";

/** A flake feeds out to this many of its radii. */
export const FEED_SCALE = 1.3;
/** Flake and crumb radii in screen heights; the heart (where the mould began) is bigger. */
const FLAKE_RADIUS = 0.014;
const CRUMB_RADIUS = 0.009;
const HEART_SCALE = 1.35;
/** Seconds a flake takes to land, to be eaten, and to give way to the M (or come back after). */
const FADE_IN = 3;
const EAT_SECONDS = 14;
const MARK_FADE = 6;
/** Flakes keep this far from the frame's edges and the dish's wall (screen heights). */
const EDGE_GAP = 0.06;
const DROP_GAP = 0.03;
/** Random layout: flakes per unit of aspect, within these bounds. */
const RANDOM_PER_ASPECT = 14;
const RANDOM_MIN = 12;
const RANDOM_MAX = 26;
/** Candidates tried for a free spot (the one farthest from every flake wins). */
const SPOT_CANDIDATES = 24;
/** Grid layout: about this many honeycomb sites over the frame (at most GRID_MAX), share left empty at a time. */
const GRID_COUNT = 26;
const GRID_MAX = 26;
const GRID_VACANT = 0.22;
/** Cities left without food at a time, the frame margin and the closest two may sit (heights). */
const CITY_VACANT = 3;
const CITY_GAP = 0.05;
const CITY_MIN_GAP = 0.06;
/** Flakes dropped by hand may exceed the layout's count by this many before old ones are eaten. */
const USER_EXTRA = 2;
/** A constellation: its radius and the closest two of its flakes (heights). */
const CONSTELLATION_RADIUS = 0.16;
const CONSTELLATION_GAP = 0.075;
/** A flake being eaten gives its slot up at once to a newcomer below this presence. */
const STEAL_BELOW = 0.3;
/** The M's crumbs along its strokes, mark units apart. */
const MARK_SPACING = 0.17;

// ---- the Tokyo map ----------------------------------------------------------------------------

/** The map's centre (degrees) and the cosine of its latitude (x is in degrees of latitude). */
const MAP_LAT = 35.615;
const MAP_LON = 139.735;
const MAP_COS = 0.8131;
/** Half the extent always kept in view: Odawara to Narita, Yokosuka to Kasukabe (degrees). */
const MAP_HALF_LAT = 0.365;
const MAP_HALF_LON = 0.585;
/** Margin round that extent (heights), and how far a narrow frame may zoom out to keep it. */
const MAP_GAP = 0.07;
const MAP_ZOOM_OUT = 1.7;

/**
 * Cities round Tokyo Bay, [name, latitude, longitude], where oat flakes stand in for them as in Tero
 * et al.'s dish; coastal ones nudged a little inland. Tokyo first: the mould starts there.
 */
const CITIES: readonly (readonly [string, number, number])[] = [
  ["Tokyo", 35.685, 139.755],
  ["Yokohama", 35.472, 139.6],
  ["Kawasaki", 35.535, 139.69],
  ["Chiba", 35.625, 140.135],
  ["Funabashi", 35.715, 139.99],
  ["Omiya", 35.906, 139.624],
  ["Hachioji", 35.656, 139.339],
  ["Machida", 35.542, 139.446],
  ["Fujisawa", 35.345, 139.487],
  ["Yokosuka", 35.25, 139.655],
  ["Odawara", 35.27, 139.14],
  ["Hiratsuka", 35.345, 139.345],
  ["Atsugi", 35.439, 139.364],
  ["Kawagoe", 35.908, 139.486],
  ["Tokorozawa", 35.787, 139.469],
  ["Kashiwa", 35.862, 139.971],
  ["Matsudo", 35.784, 139.901],
  ["Kasukabe", 35.975, 139.752],
  ["Tsukuba", 36.083, 140.111],
  ["Narita", 35.776, 140.318],
  ["Ichihara", 35.49, 140.125],
  ["Kisarazu", 35.39, 139.955],
  ["Ome", 35.788, 139.276],
  ["Toride", 35.911, 140.05],
  ["Sakura", 35.724, 140.224],
  ["Mobara", 35.428, 140.288],
  ["Kawaguchi", 35.807, 139.724],
  ["Kichijoji", 35.703, 139.58],
  ["Kumagaya", 36.147, 139.389],
];

/**
 * The sea as [longitude, latitude]: Sagami Bay from Izu, round the Miura peninsula, Tokyo Bay, down
 * the Boso peninsula and up its Pacific coast to Choshi, closed far out to sea.
 */
const COAST: readonly (readonly [number, number])[] = [
  [138.95, 34.67],
  [139.1, 34.97],
  [139.075, 35.095],
  [139.14, 35.155],
  [139.165, 35.245],
  [139.25, 35.29],
  [139.31, 35.305],
  [139.4, 35.315],
  [139.48, 35.3],
  [139.545, 35.305],
  [139.58, 35.265],
  [139.605, 35.19],
  [139.62, 35.135],
  [139.68, 35.14],
  [139.715, 35.22],
  [139.745, 35.256],
  [139.67, 35.29],
  [139.63, 35.33],
  [139.635, 35.41],
  [139.665, 35.43],
  [139.645, 35.455],
  [139.695, 35.49],
  [139.75, 35.515],
  [139.79, 35.545],
  [139.755, 35.6],
  [139.775, 35.645],
  [139.83, 35.64],
  [139.905, 35.63],
  [139.985, 35.685],
  [140.035, 35.645],
  [140.1, 35.595],
  [140.085, 35.52],
  [140.03, 35.48],
  [139.95, 35.44],
  [139.89, 35.38],
  [139.78, 35.315],
  [139.82, 35.17],
  [139.85, 34.99],
  [139.89, 34.9],
  [140.1, 35.1],
  [140.32, 35.15],
  [140.39, 35.26],
  [140.4, 35.45],
  [140.46, 35.54],
  [140.58, 35.66],
  [140.87, 35.73],
  [141.6, 35.75],
  [141.6, 34.0],
  [138.8, 34.0],
];

/** A flake on the dish in trail texels, with its feeding radius (texels) and its id. */
export interface SketchNode extends Point {
  readonly id: number;
  readonly r: number;
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const swap = item(out, i);
    out[i] = item(out, j);
    out[j] = swap;
  }
  return out;
}

export type Layout = "random" | "grid" | "cities";
/** In `layout` knob order. */
export const LAYOUTS: readonly Layout[] = ["random", "grid", "cities"];

/** How the Tokyo map sits in a frame of this aspect: degrees of latitude per screen height. */
export interface CityMap {
  readonly aspect: number;
  readonly span: number;
}

export function cityMap(aspect: number): CityMap {
  const tall = (2 * MAP_HALF_LAT) / (1 - 2 * MAP_GAP);
  const wide = (2 * MAP_HALF_LON * MAP_COS) / Math.max(aspect - 2 * MAP_GAP, 0.1);
  return { aspect, span: Math.max(tall, Math.min(wide, MAP_ZOOM_OUT * tall)) };
}

/** A place on the map in screen uv. */
function project(map: CityMap, lon: number, lat: number): Point {
  return {
    x: 0.5 + ((lon - MAP_LON) * MAP_COS) / map.span / map.aspect,
    y: 0.5 + (lat - MAP_LAT) / map.span,
  };
}

/** Light cover 0..1 at a point in screen uv. */
export type SeaSampler = (u: number, v: number) => number;

/**
 * Honeycomb sites (screen uv) spaced so about GRID_COUNT cover the frame, those inside the dish,
 * nearest the centre first: the heart is the first.
 */
function hexSites(aspect: number): { sites: Point[]; heart: number } {
  const halfWidth = aspect / 2 - EDGE_GAP;
  const halfHeight = 0.5 - EDGE_GAP;
  const spacing = Math.sqrt((8 * halfWidth * halfHeight) / (Math.sqrt(3) * GRID_COUNT));
  const rowHeight = (spacing * Math.sqrt(3)) / 2;
  const inside = dishRadius(aspect) - EDGE_GAP;
  const rows = Math.max(1, Math.floor((2 * halfHeight) / rowHeight) + 1);
  const frame: Point[] = [];
  for (let j = 0; j < rows; j++) {
    const y = (j - (rows - 1) / 2) * rowHeight;
    const shift = (j % 2 === 0 ? -0.25 : 0.25) * spacing;
    const reach = Math.floor((halfWidth + Math.abs(shift)) / spacing) + 1;
    for (let i = -reach; i <= reach; i++) {
      const x = shift + i * spacing;
      if (Math.abs(x) <= halfWidth && Math.hypot(x, y) <= inside) frame.push({ x, y });
    }
  }
  frame.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  const sites = frame.slice(0, GRID_MAX).map((p) => ({ x: 0.5 + p.x / aspect, y: 0.5 + p.y }));
  return { sites, heart: 0 };
}

/** The cities in view, inside the dish and on land (screen uv); Tokyo, the heart, first. */
function citySites(
  map: CityMap | undefined,
  aspect: number,
  sea: SeaSampler,
): { sites: Point[]; heart: number } {
  const sites: Point[] = [];
  if (map === undefined) return { sites, heart: 0 };
  const inside = dishRadius(aspect) - EDGE_GAP;
  for (const [, lat, lon] of CITIES) {
    const p = project(map, lon, lat);
    if (
      p.x < CITY_GAP / aspect ||
      p.x > 1 - CITY_GAP / aspect ||
      p.y < CITY_GAP ||
      p.y > 1 - CITY_GAP
    )
      continue;
    if (Math.hypot((p.x - 0.5) * aspect, p.y - 0.5) > inside) continue;
    if (sea(p.x, p.y) > 0.2) continue;
    if (sites.some((s) => Math.hypot((s.x - p.x) * aspect, s.y - p.y) < CITY_MIN_GAP)) continue;
    sites.push(p);
  }
  return { sites, heart: 0 };
}

/** Coverage 0..1 of a closed polygon (even–odd) over a width × height grid, rows bottom to top. */
function fillPolygon(
  points: readonly (readonly [number, number])[],
  width: number,
  height: number,
): Float32Array {
  const cover = new Float32Array(width * height);
  const SUB = 4;
  const xs: number[] = [];
  for (let row = 0; row < height; row++) {
    for (let s = 0; s < SUB; s++) {
      const y = row + (s + 0.5) / SUB;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = item(points, i);
        const [bx, by] = item(points, (i + 1) % points.length);
        if (ay <= y === by <= y) continue;
        xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, item(xs, k));
        const x1 = Math.min(width, item(xs, k + 1));
        if (x1 <= x0) continue;
        const last = Math.min(width - 1, Math.floor(x1));
        for (let i = Math.floor(x0); i <= last; i++) {
          const overlap = Math.min(i + 1, x1) - Math.max(i, x0);
          if (overlap > 0) cover[row * width + i] = (cover[row * width + i] ?? 0) + overlap / SUB;
        }
      }
    }
  }
  return cover;
}

/** The lit sea at half resolution, or nothing off the map. */
export function seaCover(map: CityMap | undefined, grid: Grid): Float32Array {
  if (map === undefined) return new Float32Array(grid.envWidth * grid.envHeight);
  const points = COAST.map(([lon, lat]): readonly [number, number] => {
    const p = project(map, lon, lat);
    return [grid.envX(p.x), grid.envY(p.y)];
  });
  return fillPolygon(points, grid.envWidth, grid.envHeight);
}

export function seaAt(cover: Float32Array, grid: Grid, u: number, v: number): number {
  const x = clamp(Math.floor(grid.envX(u)), 0, grid.envWidth - 1);
  const y = clamp(Math.floor(grid.envY(v)), 0, grid.envHeight - 1);
  return cover[y * grid.envWidth + x] ?? 0;
}

// ---- food -------------------------------------------------------------------------------------

type FoodKind = "flake" | "crumb";

interface FoodSpec {
  /** Centre in screen uv. */
  readonly x: number;
  readonly y: number;
  /** Screen heights. */
  readonly radius: number;
  readonly kind: FoodKind;
  /** The layout site it stands on, or -1. */
  readonly site: number;
  /** Part of the M. */
  readonly mark: boolean;
  /** Its look: turn, squash and grain. */
  readonly rot: number;
  readonly elong: number;
  readonly grain: number;
}

interface FoodNode extends FoodSpec {
  readonly id: number;
  /** Sim seconds it was laid: the oldest is eaten first. */
  born: number;
  /** 0..1, toward `target` (1 laid, 0 eaten). */
  strength: number;
  target: number;
  /** Seconds from 1 to 0 once it is going. */
  fadeOut: number;
}

/**
 * The dish's oat flakes: laid by the layout, eaten and replaced by the feeding, dropped by hand, set
 * aside for the M and laid again after. Up to PHYSARUM_MAX_FOOD sit on the dish; newcomers wait for
 * a slot (a flake on its way out gives its slot up early).
 */
export class FoodBook {
  nodes: FoodNode[] = [];
  map: CityMap | undefined = undefined;
  #pending: FoodNode[] = [];
  #rand: () => number = mulberry32(1);
  #nextId = 1;
  #time = 0;
  #nextFeed = -1;
  #layout: Layout = "random";
  #aspect = 16 / 9;
  /** The dish's radius, screen heights. */
  #dish = dishRadius(16 / 9);
  #sea: SeaSampler = () => 0;
  #sites: Point[] = [];
  #vacant: number[] = [];
  #target = 1;
  #heart = 0;
  #markSize: number | undefined = undefined;
  #markHeight = 0;
  #markShown = 0;
  #saved: FoodNode[] = [];
  #savedHeart = -1;

  /** Height of the M laid now, or undefined. */
  get markSize(): number | undefined {
    return this.#markSize;
  }

  /** Height of the M last laid (screen heights), and how much of its dust shows (0..1). */
  get markHeight(): number {
    return this.#markHeight;
  }

  get markShown(): number {
    return this.#markShown;
  }

  /** A fresh dish: the layout's flakes all laid (or set aside under an M laid at once). */
  reset(
    layout: Layout,
    seed: number,
    aspect: number,
    map: CityMap | undefined,
    sea: SeaSampler,
    mark: number | undefined,
  ): void {
    this.nodes = [];
    this.#pending = [];
    this.#saved = [];
    this.#savedHeart = -1;
    this.#rand = mulberry32((Math.imul(seed + 1, 0x9e3779b1) ^ 0x2c1b3c6d) >>> 0);
    this.#time = 0;
    this.#nextFeed = -1;
    this.#layout = layout;
    this.#aspect = aspect;
    this.#dish = dishRadius(aspect);
    this.map = map;
    this.#sea = sea;
    this.#sites = [];
    this.#vacant = [];
    this.#markSize = undefined;
    this.#markShown = 0;
    const specs: FoodSpec[] = [];
    switch (layout) {
      case "random": {
        this.#target = Math.round(clamp(aspect * RANDOM_PER_ASPECT, RANDOM_MIN, RANDOM_MAX));
        // The heart lands somewhere in the middle; the rest spread out from it as far as they can.
        specs.push(
          this.#flake(
            0.5 + (this.#rand() - 0.5) * 0.4,
            0.5 + (this.#rand() - 0.5) * 0.36,
            -1,
            HEART_SCALE,
          ),
        );
        while (specs.length < this.#target) {
          const at = this.#freeSpot(specs);
          specs.push(this.#flake(at.x, at.y, -1, 1));
        }
        break;
      }
      case "grid":
      case "cities": {
        const { sites, heart } = layout === "grid" ? hexSites(aspect) : citySites(map, aspect, sea);
        this.#sites = sites;
        if (sites.length === 0) {
          this.#target = 1;
          specs.push(this.#flake(0.5, 0.5, -1, HEART_SCALE));
          break;
        }
        const empty = Math.min(
          layout === "grid" ? Math.round(sites.length * GRID_VACANT) : CITY_VACANT,
          Math.max(0, sites.length - 2),
        );
        this.#target = sites.length - empty;
        const others = shuffled(
          sites.map((_, i) => i).filter((i) => i !== heart),
          this.#rand,
        );
        this.#vacant = others.slice(0, empty);
        for (const site of [heart, ...others.slice(empty)]) {
          const at = item(sites, site);
          specs.push(this.#flake(at.x, at.y, site, site === heart ? HEART_SCALE : 1));
        }
        break;
      }
      default: {
        const unreachable: never = layout;
        throw new PhysarumError(`physarum: unknown layout ${String(unreachable)}`);
      }
    }
    const laid = specs.map((spec) => this.#plant(spec, mark === undefined));
    this.#heart = item(laid, 0).id;
    if (mark !== undefined) {
      // Laid straight into an M: the dish's own flakes wait aside, unseen, until it is lifted.
      this.nodes = [];
      this.#pending = [];
      this.#saved = laid;
      this.#savedHeart = 0;
      this.#markSize = mark;
      this.#layMark(mark, true);
      this.#markShown = 1;
    }
  }

  /** Flakes land and are eaten; now and then (while feeding) one is eaten and another appears. */
  advance(dt: number, feedEvery: number | undefined): void {
    if (dt <= 0) return;
    this.#time += dt;
    for (const node of this.nodes) {
      // Landing over FADE_IN seconds, eaten over its own fadeOut.
      node.strength =
        node.target > node.strength
          ? Math.min(node.target, node.strength + dt / FADE_IN)
          : Math.max(node.target, node.strength - dt / node.fadeOut);
    }
    let kept = 0;
    for (const node of this.nodes)
      if (node.target > 0 || node.strength > 0) this.nodes[kept++] = node;
    this.nodes.length = kept;
    this.#placePending();
    this.#markShown =
      this.#markSize === undefined
        ? Math.max(0, this.#markShown - dt / MARK_FADE)
        : Math.min(1, this.#markShown + dt / MARK_FADE);
    if (feedEvery === undefined || this.#markSize !== undefined) {
      this.#nextFeed = -1;
      return;
    }
    if (this.#nextFeed < 0) {
      this.#nextFeed = this.#time + feedEvery * (0.5 + 0.5 * this.#rand());
    } else if (this.#time >= this.#nextFeed) {
      this.#feed();
      this.#nextFeed = this.#time + feedEvery * (0.75 + 0.5 * this.#rand());
    }
  }

  /** A flake dropped by hand (not into the light). */
  drop(x: number, y: number): void {
    const u = clamp(x, DROP_GAP / this.#aspect, 1 - DROP_GAP / this.#aspect);
    const v = clamp(y, DROP_GAP, 1 - DROP_GAP);
    if (this.#sea(u, v) > 0.3 || this.#beyondDish(u, v, DROP_GAP)) return;
    this.#plant(this.#flake(u, v, -1, 1), false);
    this.#trim();
  }

  /** A cluster of four to six flakes somewhere open; as many old ones are eaten to make room. */
  constellation(): void {
    const centre = this.#freeSpot([]);
    const count = 4 + Math.floor(this.#rand() * 3);
    const placed: Point[] = [];
    const aspect = this.#aspect;
    for (let tries = 0; placed.length < count && tries < 80; tries++) {
      const a = this.#rand() * TAU;
      const r = CONSTELLATION_RADIUS * Math.sqrt(this.#rand());
      const x = centre.x + (Math.cos(a) * r) / aspect;
      const y = centre.y + Math.sin(a) * r;
      if (x < EDGE_GAP / aspect || x > 1 - EDGE_GAP / aspect || y < EDGE_GAP || y > 1 - EDGE_GAP)
        continue;
      if (this.#beyondDish(x, y, EDGE_GAP)) continue;
      if (this.#sea(x, y) > 0.05) continue;
      if (placed.some((p) => Math.hypot((p.x - x) * aspect, p.y - y) < CONSTELLATION_GAP)) continue;
      placed.push({ x, y });
    }
    for (const at of placed) this.#plant(this.#flake(at.x, at.y, -1, 1), false);
    this.#trim();
  }

  /**
   * Lay the M (its five corners and crumbs along its strokes) at this height, or lift it. Laying it
   * sets the dish's flakes aside (they are eaten away); lifting it lays them again where they were.
   */
  setMark(size: number | undefined): void {
    if (size === this.#markSize) return;
    if (this.#markSize !== undefined) {
      for (const node of this.nodes) if (node.mark) this.#retire(node, MARK_FADE);
      this.#pending = this.#pending.filter((node) => !node.mark);
    } else {
      this.#saved = [];
      this.#savedHeart = -1;
      for (const node of [...this.nodes, ...this.#pending]) {
        if (node.target <= 0) continue;
        if (node.id === this.#heart) this.#savedHeart = this.#saved.length;
        this.#saved.push(node);
        this.#retire(node, MARK_FADE);
      }
      this.#pending = [];
    }
    this.#markSize = size;
    if (size === undefined) this.#restore();
    else this.#layMark(size, false);
  }

  heartNode(): FoodNode | undefined {
    for (const node of this.nodes) if (node.id === this.#heart) return node;
    return undefined;
  }

  /** The heart's id, whether or not it is on the dish now. */
  get heartId(): number {
    return this.#heart;
  }

  /** The flakes on the dish (laid or landing) in trail texels. */
  sketchNodes(grid: Grid): SketchNode[] {
    const points: SketchNode[] = [];
    for (const node of this.nodes) {
      if (node.target <= 0) continue;
      points.push({
        id: node.id,
        x: grid.trailX(node.x),
        y: grid.trailY(node.y),
        r: node.radius * FEED_SCALE * grid.perHeight,
      });
    }
    return points;
  }

  /** The passes' uniform array: domain uv, feeding radius (trail texels), presence. Returns the count. */
  writeUniform(data: Float32Array, grid: Grid): number {
    data.fill(0);
    let count = 0;
    for (const node of this.nodes) {
      if (node.strength <= 0.001 || count >= PHYSARUM_MAX_FOOD) continue;
      const o = count * 4;
      data[o] = grid.domainX(node.x);
      data[o + 1] = grid.domainY(node.y);
      data[o + 2] = node.radius * FEED_SCALE * grid.perHeight;
      data[o + 3] = node.strength;
      count++;
    }
    return count;
  }

  /** The shader's flake texture (see the file header). */
  writeTexture(data: Float32Array, phase: number, grown: number): void {
    data.fill(0);
    const row = PHYSARUM_MAX_FOOD * 4;
    const count = Math.min(this.nodes.length, PHYSARUM_MAX_FOOD);
    for (let i = 0; i < count; i++) {
      const node = item(this.nodes, i);
      const o = i * 4;
      data[o] = node.x;
      data[o + 1] = node.y;
      data[o + 2] = node.radius;
      data[o + 3] = node.target > 0 ? node.strength : -node.strength;
      data[row + o] = node.rot;
      data[row + o + 1] = node.elong;
      data[row + o + 2] = node.grain;
      data[row + o + 3] = node.kind === "crumb" ? 1 : 0;
    }
    const heart = this.heartNode();
    data[2 * row] = phase;
    data[2 * row + 1] = heart === undefined ? 0 : heart.strength;
    data[2 * row + 2] = heart === undefined ? 0.5 : heart.x;
    data[2 * row + 3] = heart === undefined ? 0.5 : heart.y;
    data[2 * row + 4] = 0.5;
    data[2 * row + 5] = 0.5;
    data[2 * row + 6] = this.#markHeight;
    data[2 * row + 7] = this.#markShown;
    data[2 * row + 8] = grown;
  }

  #flake(x: number, y: number, site: number, scale: number): FoodSpec {
    return {
      x,
      y,
      radius: FLAKE_RADIUS * scale * (0.9 + 0.2 * this.#rand()),
      kind: "flake",
      site,
      mark: false,
      rot: this.#rand() * TAU,
      elong: 0.55 + 0.25 * this.#rand(),
      grain: this.#rand(),
    };
  }

  #plant(spec: FoodSpec, now: boolean): FoodNode {
    const node: FoodNode = {
      ...spec,
      id: this.#nextId++,
      born: this.#time,
      strength: now ? 1 : 0,
      target: 1,
      fadeOut: EAT_SECONDS,
    };
    if (this.nodes.length < PHYSARUM_MAX_FOOD) this.nodes.push(node);
    else this.#pending.push(node);
    return node;
  }

  #retire(node: FoodNode, seconds: number): void {
    node.fadeOut = node.target > 0 ? seconds : Math.min(node.fadeOut, seconds);
    node.target = 0;
  }

  #placePending(): void {
    while (this.#pending.length > 0) {
      if (this.nodes.length >= PHYSARUM_MAX_FOOD) {
        let weakest = -1;
        let low = STEAL_BELOW;
        this.nodes.forEach((node, i) => {
          if (node.target === 0 && node.strength < low) {
            low = node.strength;
            weakest = i;
          }
        });
        if (weakest < 0) return;
        this.nodes.splice(weakest, 1);
      }
      const next = this.#pending.shift();
      if (next === undefined) return;
      next.born = this.#time;
      this.nodes.push(next);
    }
  }

  /** The longest-laid flake on the dish that may be eaten (not the heart, not the M). */
  #oldest(): FoodNode | undefined {
    let oldest: FoodNode | undefined;
    for (const node of this.nodes) {
      if (node.target <= 0 || node.mark || node.id === this.#heart) continue;
      if (
        oldest === undefined ||
        node.born < oldest.born ||
        (node.born === oldest.born && node.id < oldest.id)
      )
        oldest = node;
    }
    return oldest;
  }

  #activeCount(): number {
    let active = this.#pending.length;
    for (const node of this.nodes) if (node.target > 0) active++;
    return active;
  }

  /** One feeding: the oldest flake is eaten, and (if the dish is short) food appears elsewhere. */
  #feed(): void {
    const oldest = this.#oldest();
    if (oldest === undefined) return;
    this.#retire(oldest, EAT_SECONDS);
    if (oldest.site >= 0) this.#vacant.push(oldest.site);
    if (this.#activeCount() >= this.#target) return;
    if (this.#layout === "random") {
      const at = this.#freeSpot([]);
      this.#plant(this.#flake(at.x, at.y, -1, 1), false);
      return;
    }
    const site = this.#vacant.shift();
    if (site === undefined) return;
    const at = item(this.#sites, site);
    this.#plant(this.#flake(at.x, at.y, site, 1), false);
  }

  /** Hand-dropped food beyond the allowance: the oldest flakes are eaten. */
  #trim(): void {
    const limit = this.#target + USER_EXTRA;
    for (;;) {
      let active = 0;
      for (const node of this.nodes) if (node.target > 0 && !node.mark) active++;
      for (const node of this.#pending) if (!node.mark) active++;
      if (active <= limit) return;
      const oldest = this.#oldest();
      if (oldest === undefined) return;
      this.#retire(oldest, EAT_SECONDS);
      if (oldest.site >= 0) this.#vacant.push(oldest.site);
    }
  }

  /** Whether a point (screen uv) lies within `margin` (heights) of the dish's wall, or past it. */
  #beyondDish(x: number, y: number, margin: number): boolean {
    return Math.hypot((x - 0.5) * this.#aspect, y - 0.5) > this.#dish - margin;
  }

  /** The open spot (screen uv, in the dish, off the light) farthest from every flake, of a few candidates. */
  #freeSpot(extra: readonly Point[]): Point {
    const aspect = this.#aspect;
    let best: Point = { x: 0.5, y: 0.5 };
    let bestGap = -1;
    for (let k = 0; k < SPOT_CANDIDATES; k++) {
      const x = 0.5 + (this.#rand() - 0.5) * (1 - (2 * EDGE_GAP) / aspect);
      const y = 0.5 + (this.#rand() - 0.5) * (1 - 2 * EDGE_GAP);
      if (this.#sea(x, y) > 0.05 || this.#beyondDish(x, y, EDGE_GAP)) continue;
      let gap = Infinity;
      for (const p of this.nodes) gap = Math.min(gap, Math.hypot((p.x - x) * aspect, p.y - y));
      for (const p of this.#pending) gap = Math.min(gap, Math.hypot((p.x - x) * aspect, p.y - y));
      for (const p of extra) gap = Math.min(gap, Math.hypot((p.x - x) * aspect, p.y - y));
      if (gap > bestGap) {
        bestGap = gap;
        best = { x, y };
      }
    }
    return best;
  }

  /** Lay the M `size` tall, or smaller where the frame or the dish is too narrow for it. */
  #layMark(size: number, now: boolean): void {
    const aspect = this.#aspect;
    // The M's corners lie 0.47 heights out across, 0.69 from its centre (per unit of height).
    const height = Math.min(
      size,
      (aspect / 2 - EDGE_GAP) / 0.47,
      (this.#dish - EDGE_GAP) / Math.hypot(0.47, 0.5),
    );
    const lay = (vx: number, vy: number, kind: FoodKind): FoodNode =>
      this.#plant(
        {
          x: 0.5 + (vx * height) / aspect,
          y: 0.5 + vy * height,
          radius: kind === "crumb" ? CRUMB_RADIUS * (0.85 + 0.3 * this.#rand()) : FLAKE_RADIUS,
          kind,
          site: -1,
          mark: true,
          rot: this.#rand() * TAU,
          elong: kind === "crumb" ? 0.7 + 0.25 * this.#rand() : 0.55 + 0.25 * this.#rand(),
          grain: this.#rand(),
        },
        now,
      );
    // Corners first, so they take the free slots before the crumbs.
    MARK_VERTICES.forEach(([vx, vy], i) => {
      const node = lay(vx, vy, "flake");
      if (i === 2) this.#heart = node.id;
    });
    for (let s = 0; s + 1 < MARK_VERTICES.length; s++) {
      const [ax, ay] = markVertex(s);
      const [bx, by] = markVertex(s + 1);
      const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / MARK_SPACING));
      for (let k = 1; k < pieces; k++)
        lay(ax + ((bx - ax) * k) / pieces, ay + ((by - ay) * k) / pieces, "crumb");
    }
    this.#markHeight = height;
  }

  /** The dish's flakes laid again after the M: those still fading come back where they are. */
  #restore(): void {
    let heart = -1;
    this.#saved.forEach((saved, i) => {
      const node = this.nodes.includes(saved) ? saved : this.#plant(saved, false);
      node.target = 1;
      if (i === this.#savedHeart) heart = node.id;
    });
    this.#saved = [];
    this.#savedHeart = -1;
    this.#heart =
      heart >= 0 ? heart : (this.nodes.find((node) => node.target > 0 && !node.mark)?.id ?? 0);
    this.#nextFeed = -1;
    this.#trim();
  }
}
