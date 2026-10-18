// The composed sim (README "Sims in a composition"): what the renderer sees as a composed scene's
// sim. One SimFrame comes in; each layer on gets a LayerFrame and writes into the shared resources:
//   slot 0  the speck map: rg8 at frame size, nearest (sims/specks.ts). Cleared every frame; each
//           layer plots its own codes from its base (`Allocation.specks`), every speck it shows.
//   slot 1  the records atlas: rgba16f, nearest, ATLAS_WIDTH wide. Row 0 is the composer's: texel k
//           the k-th layer on screen's own entrance and exit (x, y; -1: it follows the scene's
//           passage), read by `layerIn`, `layerOut` and `layerShown` (glsl.ts). Then each layer's
//           rows, in canonical order.
//   2–7     each layer's fields, in canonical order, a slot each.
// Allocation is a pure function of the layer set on screen (`allocate`): the program the frame draws
// with (SimFrame.features, its feature key: its LAYER_<ID> gates). A layer switched on but not yet on
// screen runs ahead at dt 0, its rows kept aside, and is copied in the frame its program arrives. A
// layer switched off while on screen plays its exit (LAYER_EXIT seconds of wall time): the renderer
// keeps drawing the program it is in until then (`holds`). Every layer sim keeps its own rows, so a
// change of allocation copies them where they now belong. The cast's points of interest are every
// on-screen layer's (`interest`, canonical order), and a layer reaches another's affordances (a
// chore its host's, README "Principals and chores") through `LayerFrame.host`.
import { KnobReader, type ParamDef } from "../params.ts";
import type { ScenePoint, SceneSim, SimFrame } from "../scenes/types.ts";
import { LevelCamera } from "../sims/camera.ts";
import { SpeckMap } from "../sims/specks.ts";
import { DataTexture } from "../sims/texture.ts";
import { ATLAS_WIDTH, COMPOSER_CAPS } from "./caps.ts";
import { coverAt, moveShape } from "./claims.ts";
import { NO_PASSAGE_GUST, passageGust, type GustField, type PassageGust } from "./gust.ts";
import type { Placement } from "./place.ts";
import type {
  FieldSlot,
  FloorPoint,
  LayerDef,
  LayerFrame,
  LayerGround,
  LayerSim,
  PlacedClaim,
  RecordRows,
  Rig,
  SpeckWriter,
} from "./types.ts";

/** Seconds a layer's own entrance and exit take when it is turned on or off mid-scene (D12). */
export const LAYER_ENTER = 1.2;
export const LAYER_EXIT = 0.9;

export class ComposerSimError extends Error {}

/** Where each layer on screen keeps its data (see the header). */
export interface Allocation {
  /** On screen, canonical order: index k is texel k of the atlas's row 0. */
  readonly layers: readonly string[];
  /** Atlas rows: the first of each layer's, and how many. */
  readonly rows: Readonly<Record<string, { readonly base: number; readonly count: number }>>;
  /** Rows of the atlas: the composer's row 0, then every layer's. */
  readonly atlasRows: number;
  /** The code each layer's speck codes start after (its code c is c + base in the map). */
  readonly specks: Readonly<Record<string, number>>;
  /** Texture slots of each layer's fields, in order. */
  readonly fields: Readonly<Record<string, readonly number[]>>;
  /** Slots bound: 2 plus the fields. */
  readonly slots: number;
}

export const SPECK_SLOT = 0;
export const ATLAS_SLOT = 1;
const FIELD_SLOT = 2;

/** The allocation for these layers on screen (canonical order); throws past the caps. */
export function allocate(layers: readonly LayerDef[]): Allocation {
  const rows: Record<string, { base: number; count: number }> = {};
  const specks: Record<string, number> = {};
  const fields: Record<string, number[]> = {};
  let row = 1;
  let code = 0;
  let slot = FIELD_SLOT;
  for (const layer of layers) {
    const data = layer.data;
    if (data === undefined) continue;
    if ((data.rows ?? 0) > 0) {
      rows[layer.id] = { base: row, count: data.rows ?? 0 };
      row += data.rows ?? 0;
    }
    if ((data.specks ?? 0) > 0) {
      specks[layer.id] = code;
      code += data.specks ?? 0;
      if (code > 255)
        throw new ComposerSimError(`speck codes past 255 with ${layer.id}: one byte holds a code`);
    }
    if ((data.fields ?? 0) > 0) {
      fields[layer.id] = Array.from({ length: data.fields ?? 0 }, (_, i) => slot + i);
      slot += data.fields ?? 0;
    }
  }
  if (slot - FIELD_SLOT > COMPOSER_CAPS.fields || slot > COMPOSER_CAPS.simTextures)
    throw new ComposerSimError(
      `${slot} sim textures for ${layers.map((layer) => layer.id).join(", ")}: at most ${COMPOSER_CAPS.simTextures}`,
    );
  return {
    layers: layers.map((layer) => layer.id),
    rows,
    atlasRows: row,
    specks,
    fields,
    slots: slot,
  };
}

/** The layer ids a feature key (shaders/index.ts featureKey) turns on: its `LAYER_<ID>=1` gates. */
export function layersOfKey(key: string, gates: Readonly<Record<string, string>>): Set<string> {
  const on = new Set<string>();
  for (const define of key.split(" ")) {
    const [name, value] = define.split("=");
    const id = name === undefined ? undefined : gates[name];
    if (id !== undefined && value === "1") on.add(id);
  }
  return on;
}

/** What compose.ts gives the composed sim. */
export interface Composition {
  readonly params: readonly ParamDef[];
  readonly rig: Rig;
  /** `LAYER_<ID>` gate names, and the layer id each turns on. */
  readonly gates: Readonly<Record<string, string>>;
  /** The placement of the layers switched on in these raw knobs. */
  placement(params: Readonly<Record<string, number>>): Placement;
  /** Each offered layer's sim factory (after its code has loaded), and its knobs under their short keys. */
  readonly sims: Readonly<
    Record<
      string,
      ((gl: WebGL2RenderingContext, params: readonly ParamDef[]) => LayerSim) | undefined
    >
  >;
  readonly shortParams: Readonly<Record<string, readonly ParamDef[]>>;
  /** The gusts' "now" slot, and the preset passage's gust front (if it sends one). */
  readonly gust: { readonly slot: number; readonly shape: GustField["shape"] };
  readonly rigLift: (enter: number, exit: number) => number;
  readonly offered: readonly LayerDef[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class Rows implements RecordRows {
  readonly data: Float32Array;
  readonly rows: number;
  dirty = true;

  constructor(rows: number) {
    this.rows = rows;
    this.data = new Float32Array(rows * ATLAS_WIDTH * 4);
  }

  touch(): void {
    this.dirty = true;
  }
}

/** A layer's view of the shared speck map: its codes from `base`, or nowhere while it is not on screen. */
class Specks implements SpeckWriter {
  readonly #map: SpeckMap;
  base = 0;
  shown = false;

  constructor(map: SpeckMap) {
    this.#map = map;
  }

  get width(): number {
    return this.#map.width;
  }

  get height(): number {
    return this.#map.height;
  }

  plot(cx: number, cy: number, code: number, depth: number): void {
    if (this.shown) this.#map.plot(cx, cy, code + this.base, depth);
  }

  block(cx: number, cy: number, w: number, h: number, code: number, depth: number): void {
    if (this.shown) this.#map.block(cx, cy, w, h, code + this.base, depth);
  }
}

class Ground implements LayerGround {
  anchor: FloorPoint = [0, 0];
  claims: readonly PlacedClaim[] = [];

  coverAllowed(x: number, z: number, overgrowth = 1): number {
    return coverAt(this.claims, x, z, overgrowth);
  }
}

/** One layer's sim and what it keeps across frames. */
interface Live {
  readonly layer: LayerDef;
  readonly sim: LayerSim | undefined;
  readonly records: Rows;
  readonly fields: FieldSlot[];
  readonly specks: Specks;
  readonly ground: Ground;
  readonly frame: Mutable<LayerFrame>;
  readonly passage: { enter: number; exit: number };
  /** Wall time (ms) it came on screen mid-scene, and it started leaving; NaN: neither. */
  arrived: number;
  leaving: number;
}

class ComposedSim implements SceneSim {
  readonly #gl: WebGL2RenderingContext;
  readonly #c: Composition;
  readonly #rig: LevelCamera;
  readonly #knobs: KnobReader<"wind" | "gusts" | "gustRate">;
  readonly #map = new SpeckMap();
  readonly #speckTexture: DataTexture;
  readonly #atlas: DataTexture;
  #atlasData = new Float32Array(ATLAS_WIDTH * 4);
  readonly #textures: (WebGLTexture | undefined)[] = [];
  readonly #live = new Map<string, Live>();
  readonly #pass: PassageGust = { front: 0, amp: 0 };
  readonly #gusts: Mutable<GustField>;
  /** The layer set on screen, what it was worked out from, and where its data goes. */
  #screenFrom = "";
  #screen: readonly LayerDef[] = [];
  #allocation: Allocation = allocate([]);
  #placementKey = "";
  #placement: Placement | undefined;
  /** The placed claims stretched with the frame, and the stretch and placement they were for. */
  #claims: readonly PlacedClaim[] = [];
  #stretch = Number.NaN;
  #claimsOf: Placement | undefined;
  #first = true;
  /** The on-screen layers' points of interest, gathered afresh at each ask. */
  readonly #interest: ScenePoint[] = [];
  /** LayerFrame.host: another live layer's affordances. */
  readonly #host = (layer: string): object | undefined => this.#live.get(layer)?.sim?.affordances;

  constructor(gl: WebGL2RenderingContext, composition: Composition) {
    this.#gl = gl;
    this.#c = composition;
    const rig = composition.rig;
    this.#rig = new LevelCamera({ horizon: rig.horizon, eye: rig.eye, focal: rig.focal });
    this.#knobs = new KnobReader("composer", composition.params, ["wind", "gusts", "gustRate"]);
    this.#speckTexture = new DataTexture(gl, {
      width: 1,
      height: 1,
      format: "rg8",
      filter: "nearest",
    });
    this.#map.resize(1, 1);
    this.#atlas = new DataTexture(gl, {
      width: ATLAS_WIDTH,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#gusts = {
      wind: 0,
      gusts: 0,
      rate: 0,
      nowAge: -1,
      slot: composition.gust.slot,
      pass: NO_PASSAGE_GUST,
      shape: composition.gust.shape,
    };
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const placement = this.#placementOf(frame.params);
    this.#follow(frame, placement);
    this.#size(frame);
    this.#gustField(frame);
    this.#stretchClaims(frame.aspect, placement);
    this.#map.clear();
    const lift = this.#c.rigLift(frame.passage.enter, frame.passage.exit);
    for (const live of this.#live.values()) this.#step(live, frame, lift);
    this.#first = false;
    this.#upload();
    return this.#textures;
  }

  ready(): boolean {
    return this.#screen.every((layer) => this.#live.get(layer.id)?.sim?.ready?.() !== false);
  }

  /** Every on-screen layer's points of interest (LayerSim.interest), canonical order. */
  interest(aspect: number): readonly ScenePoint[] {
    const points = this.#interest;
    points.length = 0;
    for (const layer of this.#screen) {
      const own = this.#live.get(layer.id)?.sim?.interest?.(aspect);
      if (own !== undefined) for (const point of own) points.push(point);
    }
    return points;
  }

  holds(): boolean {
    for (const live of this.#live.values())
      if (!Number.isNaN(live.leaving) && live.passage.exit < 1) return true;
    return false;
  }

  dispose(): void {
    for (const live of this.#live.values()) live.sim?.dispose();
    this.#live.clear();
    this.#speckTexture.dispose();
    this.#atlas.dispose();
  }

  #placementOf(params: Readonly<Record<string, number>>): Placement {
    const key = this.#c.offered
      .map((layer) => ((params[layer.id] ?? 0) > 0.5 ? "1" : "0"))
      .join("");
    if (key !== this.#placementKey || this.#placement === undefined) {
      this.#placementKey = key;
      this.#placement = this.#c.placement(params);
    }
    return this.#placement;
  }

  /**
   * The layer set on screen (the program's LAYER_ gates; without a program named, the setting's),
   * its allocation, each layer's sim started or stopped, and their own entrances and exits.
   */
  #follow(frame: SimFrame, placement: Placement): void {
    const from = frame.features ?? `placement ${this.#placementKey}`;
    if (from !== this.#screenFrom) {
      this.#screenFrom = from;
      const on =
        frame.features === undefined
          ? new Set(placement.layers.map((placed) => placed.layer.id))
          : layersOfKey(frame.features, this.#c.gates);
      const was = new Set(this.#screen.map((layer) => layer.id));
      this.#screen = this.#c.offered.filter((layer) => on.has(layer.id));
      this.#allocation = allocate(this.#screen);
      for (const live of this.#live.values()) {
        live.records.dirty = true;
        if (on.has(live.layer.id) && !was.has(live.layer.id) && !this.#first)
          live.arrived = frame.now;
      }
    }
    const shown = new Set(this.#allocation.layers);
    const switched = new Set(placement.layers.map((placed) => placed.layer.id));
    for (const layer of this.#c.offered) {
      const wanted = shown.has(layer.id) || switched.has(layer.id);
      const live = this.#live.get(layer.id);
      if (wanted && live === undefined)
        this.#live.set(layer.id, this.#start(layer, frame, shown.has(layer.id)));
      else if (!wanted && live !== undefined) {
        live.sim?.dispose();
        this.#live.delete(layer.id);
      }
    }
    for (const live of this.#live.values()) {
      const leaving = shown.has(live.layer.id) && !switched.has(live.layer.id);
      if (!leaving) live.leaving = Number.NaN;
      else if (Number.isNaN(live.leaving)) live.leaving = frame.now;
    }
  }

  #start(layer: LayerDef, frame: SimFrame, shown: boolean): Live {
    const records = new Rows(layer.data?.rows ?? 0);
    const fields: FieldSlot[] = Array.from({ length: layer.data?.fields ?? 0 }, () => ({
      texture: undefined,
    }));
    const passage = { enter: 1, exit: 0 };
    const specks = new Specks(this.#map);
    const ground = new Ground();
    const lf: Mutable<LayerFrame> = {
      ...frame,
      passage,
      rig: this.#rig,
      lift: 0,
      ground,
      gusts: this.#gusts,
      records,
      specks,
      fields,
      host: this.#host,
    };
    const factory = this.#c.sims[layer.id];
    return {
      layer,
      sim: factory?.(this.#gl, this.#c.shortParams[layer.id] ?? this.#c.params),
      records,
      fields,
      specks,
      ground,
      frame: lf,
      passage,
      arrived: !this.#first && shown ? frame.now : Number.NaN,
      leaving: Number.NaN,
    };
  }

  #size(frame: SimFrame): void {
    const width = Math.max(1, Math.round(frame.width));
    const height = Math.max(1, Math.round(frame.height));
    if (width === this.#map.width && height === this.#map.height) return;
    this.#map.resize(width, height);
    this.#speckTexture.resize(width, height);
  }

  /** The gust field's knobs, its 'now' age and the passage's front, for this frame. */
  #gustField(frame: SimFrame): void {
    const g = this.#gusts;
    const knobs = this.#knobs;
    g.wind = knobs.value(frame, "wind");
    g.gusts = knobs.value(frame, "gusts");
    g.rate = knobs.value(frame, "gustRate");
    const fired = frame.motionTriggers?.[g.slot];
    g.nowAge =
      fired === undefined || (frame.triggers[g.slot] ?? -1e4) < -1e3
        ? -1
        : frame.motionTime - fired;
    g.pass =
      g.shape === undefined || g.gusts <= 0
        ? NO_PASSAGE_GUST
        : passageGust(this.#pass, g.shape, frame.passage.enter, frame.passage.exit);
  }

  /**
   * The placed claims, the stage layers' stretched across this frame (README "Space"): a new array
   * only when the stretch or the placement changes, so a layer sim may key its growth on it.
   */
  #stretchClaims(aspect: number, placement: Placement): void {
    const half = 0.5 * this.#c.rig.minAspect;
    const stretch = Math.max(0.5 * aspect, half) / half;
    if (stretch === this.#stretch && placement === this.#claimsOf) return;
    this.#stretch = stretch;
    this.#claimsOf = placement;
    const stage = new Set(
      placement.layers
        .filter((placed) => placed.layer.space.stretch === true)
        .map((placed) => placed.layer.id),
    );
    this.#claims = placement.claims.map((claim) =>
      stage.has(claim.layer) ? { ...claim, shape: moveShape(claim.shape, [0, 0], stretch) } : claim,
    );
    for (const live of this.#live.values()) {
      const placed = placement.layers.find((p) => p.layer === live.layer);
      const scale = live.layer.space.stretch === true ? stretch : 1;
      live.ground.anchor = placed ? [placed.anchor.at[0] * scale, placed.anchor.at[1]] : [0, 0];
      live.ground.claims = this.#claims;
    }
  }

  #step(live: Live, frame: SimFrame, lift: number): void {
    const alloc = this.#allocation;
    const onScreen = alloc.layers.includes(live.layer.id);
    // The scene's frame over the layer's (every field, whatever SimFrame holds), then its own.
    const lf = Object.assign(live.frame, frame);
    lf.dt = onScreen ? frame.dt : 0;
    lf.passage = live.passage;
    lf.lift = lift;
    lf.rig = this.#rig;
    lf.ground = live.ground;
    lf.gusts = this.#gusts;
    lf.records = live.records;
    lf.specks = live.specks;
    lf.fields = live.fields;
    live.ground.claims = this.#claims;
    const passage = live.passage;
    if (!onScreen) {
      passage.enter = 0;
      passage.exit = 0;
    } else {
      passage.enter = Number.isNaN(live.arrived)
        ? frame.passage.enter
        : Math.min(1, (frame.now - live.arrived) / (LAYER_ENTER * 1000));
      passage.exit = Number.isNaN(live.leaving)
        ? frame.passage.exit
        : Math.min(1, (frame.now - live.leaving) / (LAYER_EXIT * 1000));
      if (passage.enter >= 1) live.arrived = Number.NaN;
    }
    live.specks.shown = onScreen;
    live.specks.base = alloc.specks[live.layer.id] ?? 0;
    live.sim?.frame(lf);
  }

  /** Row 0 and the rows that changed up into the atlas, the speck map up, and the slots to bind. */
  #upload(): void {
    const alloc = this.#allocation;
    const row = ATLAS_WIDTH * 4;
    if (this.#atlas.height !== alloc.atlasRows) {
      this.#atlas.resize(ATLAS_WIDTH, alloc.atlasRows);
      this.#atlasData = new Float32Array(alloc.atlasRows * row);
      for (const live of this.#live.values()) live.records.dirty = true;
    }
    const data = this.#atlasData;
    alloc.layers.forEach((id, k) => {
      const live = this.#live.get(id);
      const own =
        live !== undefined && (!Number.isNaN(live.arrived) || !Number.isNaN(live.leaving));
      data[k * 4] = own ? live.passage.enter : -1;
      data[k * 4 + 1] = own ? live.passage.exit : -1;
    });
    let top = 1;
    for (const [id, at] of Object.entries(alloc.rows)) {
      const live = this.#live.get(id);
      if (live === undefined || !live.records.dirty) continue;
      data.set(live.records.data, at.base * row);
      live.records.dirty = false;
      top = Math.max(top, at.base + at.count);
    }
    this.#atlas.uploadRegion(data, 0, 0, ATLAS_WIDTH, top);
    this.#map.upload(this.#speckTexture);
    const textures = this.#textures;
    textures.length = alloc.slots;
    textures[SPECK_SLOT] =
      Object.keys(alloc.specks).length > 0 ? this.#speckTexture.texture : undefined;
    textures[ATLAS_SLOT] = this.#atlas.texture;
    for (const [id, slots] of Object.entries(alloc.fields)) {
      const live = this.#live.get(id);
      slots.forEach((slot, i) => {
        textures[slot] = live?.fields[i]?.texture;
      });
    }
  }
}

/** The composed sim for a composition (compose.ts). */
export function composedSim(composition: Composition): (gl: WebGL2RenderingContext) => SceneSim {
  return (gl) => new ComposedSim(gl, composition);
}
