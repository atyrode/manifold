// The composed sim (README "Sims in a composition"): what the renderer sees as a composed scene's
// sim. One SimFrame comes in; each layer on gets a LayerFrame and writes into the shared resources:
//   slot 0  the speck map: rg8 at frame size, nearest (sims/specks.ts). Cleared every frame; each
//           layer plots its own codes from its base (`Allocation.specks`), every speck it shows; then
//           the composer's falling things (falling.ts) plot theirs, after every layer's
//           (`Allocation.falling`), while a layer on lets things fall (LayerDef.falling).
//   slot 1  the records atlas: rgba16f, nearest, ATLAS_WIDTH wide. Row 0 is the composer's: texel k
//           the k-th layer on screen's own entrance and exit (x, y; -1: it follows the scene's
//           passage), read by `layerIn`, `layerOut` and `layerShown` (glsl.ts; a steady program
//           reads texel 0 alone). Then each layer's rows, in canonical order.
//   2–7     each layer's fields, in canonical order, a slot each.
// Allocation is a pure function of the layer set on screen (`allocate`): the program the frame draws
// with (SimFrame.features, its feature key: its LAYER_<ID> gates). A layer switched on but not yet on
// screen runs ahead at dt 0, its rows kept aside, and is copied in the frame its program arrives.
// A layer's own entrance and exit play only in a program that draws turns (compose.ts TURNS_GATE;
// the steady ones carry none of that, and a view of the scene's own draws none: `drawsTurns`), which
// the sim asks the renderer for while one plays or is on its way (`turning`). A layer switched on
// enters (LAYER_ENTER seconds of wall time) once such a program of the setting's layer set is on
// screen, and the setting's steady program is asked for once it has; one switched off plays its exit
// (LAYER_EXIT seconds) in such a program of the layer set on screen, which the renderer builds ahead
// while the lab is open (`leavesThrough`), and the setting's program is asked for once it has played.
// Where no such program can draw the turn, the setting's own program takes over unturned. Every layer
// sim keeps its own rows, so a change of allocation copies them where they now belong. The cast's
// points of interest are every on-screen layer's (`interest`, canonical order), and a layer reaches
// another's affordances (a chore its host's, README "Principals and chores") through
// `LayerFrame.host`. The falling things (falling.ts) step after every layer has named its drip
// points and surfaces for the frame (LayerFrame.falling), under a composer whose program draws them
// (Composition.falling: the outdoor's).
import { KnobReader, type ParamDef } from "../params.ts";
import type { ScenePoint, SceneSim, SceneTurn, SimFrame } from "../scenes/types.ts";
import { LevelCamera } from "../sims/camera.ts";
import { SpeckMap } from "../sims/specks.ts";
import { DataTexture } from "../sims/texture.ts";
import { ATLAS_WIDTH, COMPOSER_CAPS } from "./caps.ts";
import { coverAt, moveShape } from "./claims.ts";
import { TURNS_GATE } from "./compose.ts";
import { FallingPool, FALL_CODES, type FallFrame, type FallView } from "./falling.ts";
import { NO_PASSAGE_GUST, passageGust, type GustField, type PassageGust } from "./gust.ts";
import type { Placement } from "./place.ts";
import type {
  FallKind,
  FallSurface,
  FallingWriter,
  FieldSlot,
  FloorPoint,
  LayerDef,
  LayerFrame,
  LayerGround,
  LayerSim,
  PlacedClaim,
  RecordRows,
  RoomFrame,
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
  /**
   * The composer's falling things' codes (falling.ts FALL_CODES), after every layer's: the first
   * code's base, how many, and the kinds the layers on let fall; undefined while none does.
   */
  readonly falling:
    | { readonly base: number; readonly count: number; readonly kinds: readonly FallKind[] }
    | undefined;
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
  const kinds = [...new Set(layers.flatMap((layer) => layer.falling?.kinds ?? []))];
  let falling: Allocation["falling"];
  if (kinds.length > 0) {
    const count = kinds.reduce((sum, kind) => sum + FALL_CODES[kind], 0);
    falling = { base: code, count, kinds };
    code += count;
    if (code > 255)
      throw new ComposerSimError(
        "speck codes past 255 with the falling things: one byte holds a code",
      );
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
    falling,
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

/** The compile-time features a feature key (shaders/index.ts featureKey) was made from. */
function featuresOfKey(key: string): Record<string, number> {
  const features: Record<string, number> = {};
  for (const define of key.split(" ")) {
    const [name, value] = define.split("=");
    if (name !== undefined && value !== undefined) features[name] = Number(value);
  }
  return features;
}

/**
 * What compose.ts gives the composed sim. `R`: the rig at rest as the layers' sims see it
 * (LayerFrame.rig): the outdoor's level camera, or the overhead rig.
 */
export interface Composition<R = LevelCamera> {
  readonly params: readonly ParamDef[];
  readonly camera: R;
  /** The narrowest frame laid out as itself (Rig.minAspect): stage layers stretch past it. */
  readonly minAspect: number;
  /** `LAYER_<ID>` gate names, and the layer id each turns on. */
  readonly gates: Readonly<Record<string, string>>;
  /** The placement of the layers switched on in these raw knobs. */
  placement(params: Readonly<Record<string, number>>): Placement;
  /** Each offered layer's sim factory (after its code has loaded), and its knobs under their short keys. */
  readonly sims: Readonly<
    Record<
      string,
      ((gl: WebGL2RenderingContext, params: readonly ParamDef[]) => LayerSim<R>) | undefined
    >
  >;
  readonly shortParams: Readonly<Record<string, readonly ParamDef[]>>;
  /**
   * The gusts' "now" slot, and the preset passage's gust front (if it sends one); undefined under a
   * composer without the gust field (the overhead, a room), whose LayerFrame.gusts stays still.
   */
  readonly gust: { readonly slot: number; readonly shape: GustField["shape"] } | undefined;
  readonly rigLift: (enter: number, exit: number) => number;
  readonly offered: readonly LayerDef[];
  /**
   * Whether a program of these features draws its layers' own entrances and exits: TURNS_GATE at 1
   * in a composed program, never in a view of the scene's own (code.ts composedCode's `own`).
   */
  readonly drawsTurns: (features: Readonly<Record<string, number>>) => boolean;
  /** The room's seat line and scale, in an `interior` preset: every layer's frame carries it. */
  readonly room?: RoomFrame;
  /**
   * Under a composer whose program draws the falling things (the outdoor's speck pass, glsl.ts):
   * the rig at rest they are drawn through, and the CPU twin of its passage's lens shift
   * (RigPassage.shiftAt: screen heights the world is read lower; 0 at rest).
   */
  readonly falling?: {
    readonly rig: LevelCamera;
    readonly shift: (enter: number, exit: number) => number;
  };
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

/**
 * A layer's view of the falling things (LayerFrame.falling): its drip points (lanes keyed by its
 * place among the offered layers) and its surfaces into the pool, while it is on screen; nowhere
 * under a composer whose program draws no falling things (Composition.falling unset).
 */
class FallingInlet implements FallingWriter {
  readonly #pool: FallingPool | undefined;
  readonly #key: number;
  readonly #drops: boolean;
  readonly #slide: readonly [number, number];
  shown = false;

  constructor(pool: FallingPool | undefined, layer: LayerDef, index: number) {
    this.#pool = pool;
    this.#key = index * 65536;
    this.#drops = layer.falling?.kinds.includes("drop") === true;
    this.#slide = layer.falling?.slide ?? [0, 0];
  }

  drip(lane: number, x: number, y: number, z: number): void {
    if (this.shown && this.#drops)
      this.#pool?.drip(this.#key + (lane & 0xffff), x, y, z, this.#slide[0], this.#slide[1]);
  }

  surface(surface: FallSurface): void {
    if (this.shown) this.#pool?.surface(surface);
  }
}

/** The scene's raw knobs under a layer's view keys (Live.renames), written into `out`. */
function viewParams(
  params: Readonly<Record<string, number>>,
  renames: readonly (readonly [string, string])[],
  out: Record<string, number>,
): Record<string, number> {
  Object.assign(out, params);
  for (const [view, key] of renames) {
    const value = params[key];
    if (value === undefined) delete out[view];
    else out[view] = value;
  }
  return out;
}

/** One layer's sim and what it keeps across frames. */
interface Live<R> {
  readonly layer: LayerDef;
  readonly sim: LayerSim<R> | undefined;
  readonly records: Rows;
  readonly fields: FieldSlot[];
  readonly specks: Specks;
  readonly ground: Ground;
  readonly falls: FallingInlet;
  readonly frame: Mutable<LayerFrame<R>>;
  /**
   * Where its view's keys (Composition.shortParams) differ from the scene's: each view key, a
   * feature's `-amount` too, with the scene's key it reads; and the raw knobs (SimFrame.params)
   * under the view's keys, rewritten each frame while there are any.
   */
  readonly renames: readonly (readonly [string, string])[];
  readonly params: Record<string, number>;
  readonly passage: { enter: number; exit: number };
  /**
   * Wall time (ms) its own entrance began, and its exit; NaN: neither plays (one switched off waits
   * so for a program that draws turns).
   */
  arrived: number;
  leaving: number;
}

/** What `turning` works out from the program on screen and the setting's features (see there). */
interface TurnPlan {
  readonly drawn: string;
  readonly wanted: Readonly<Record<string, number>>;
  /** The layers on screen that the setting switches off. */
  readonly leaving: readonly string[];
  /** Whether the setting switches on a layer not on screen. */
  readonly coming: boolean;
  /** The program on screen's layer set, drawing turns: what a layer switched off leaves through. */
  readonly screen: SceneTurn | undefined;
  /** The setting's, drawing turns: what a layer switched on enters in. */
  readonly setting: SceneTurn | undefined;
}

class ComposedSim<R> implements SceneSim {
  readonly #gl: WebGL2RenderingContext;
  readonly #c: Composition<R>;
  readonly #rig: R;
  /**
   * The gust field's knobs, under a composer with the field (Composition.gust): neither the
   * overhead nor a room (README "The interior composer") has one.
   */
  readonly #knobs: KnobReader<"wind" | "gusts" | "gustRate"> | undefined;
  readonly #map = new SpeckMap();
  readonly #speckTexture: DataTexture;
  readonly #atlas: DataTexture;
  #atlasData = new Float32Array(ATLAS_WIDTH * 4);
  readonly #textures: (WebGLTexture | undefined)[] = [];
  readonly #live = new Map<string, Live<R>>();
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
  /** Whether the program on screen draws turns (Composition.drawsTurns): a turn begins only in one. */
  #turns = true;
  /** What `turning` last worked out, kept until the program on screen or the setting changes. */
  #turnPlan: TurnPlan | undefined;
  /** What `#throughOf` last worked out, and the program on screen it was for. */
  #through: { drawn: string; turn: SceneTurn | undefined } | undefined;
  /** The on-screen layers' points of interest, gathered afresh at each ask. */
  readonly #interest: ScenePoint[] = [];
  /** LayerFrame.host: another live layer's affordances. */
  readonly #host = (layer: string): object | undefined => this.#live.get(layer)?.sim?.affordances;
  /** The falling things (falling.ts), under a composer whose program draws them (Composition.falling). */
  readonly #falling: FallingPool | undefined;
  /** The seed knob's place in the scene's knobs (-1: none), for the falling things' chance. */
  readonly #seedAt: number;
  readonly #fallFrame: Mutable<FallFrame>;
  readonly #fallView: Mutable<FallView>;
  /** Where the falling things plot: the speck map, from the codes' base (Allocation.falling). */
  readonly #fallPlot = {
    base: 0,
    map: this.#map,
    plot(cx: number, cy: number, code: number, depth: number): void {
      this.map.plot(cx, cy, code + this.base, depth);
    },
  };

  constructor(gl: WebGL2RenderingContext, composition: Composition<R>) {
    this.#gl = gl;
    this.#c = composition;
    this.#rig = composition.camera;
    this.#knobs =
      composition.gust === undefined
        ? undefined
        : new KnobReader("composer", composition.params, ["wind", "gusts", "gustRate"]);
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
      slot: composition.gust?.slot ?? 0,
      pass: NO_PASSAGE_GUST,
      shape: composition.gust?.shape,
    };
    const falling = composition.falling;
    this.#falling = falling === undefined ? undefined : new FallingPool(this.#host);
    this.#seedAt = composition.params.findIndex((def) => def.key === "seed");
    this.#fallFrame = {
      dt: 0,
      motion: 0,
      motionTime: 0,
      seed: 0,
      rain: 0,
      wet: 0,
      gusts: this.#gusts,
    };
    this.#fallView = {
      rig: falling?.rig ?? new LevelCamera({ horizon: 0.5, eye: 1, focal: 1 }),
      lift: 0,
      shift: 0,
      width: 1,
      height: 1,
      parallaxX: 0,
      parallaxY: 0,
    };
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const placement = this.#placementOf(frame.params);
    this.#follow(frame, placement);
    this.#size(frame);
    this.#gustField(frame);
    this.#stretchClaims(frame.aspect, placement);
    this.#map.clear();
    this.#falling?.begin();
    const lift = this.#c.rigLift(frame.passage.enter, frame.passage.exit);
    for (const live of this.#live.values()) this.#step(live, frame, lift);
    this.#fall(frame, lift);
    this.#first = false;
    this.#upload();
    return this.#textures;
  }

  /**
   * Whether every on-screen layer's sim has what it shows; never before the first frame, which
   * starts them (no layer is on screen to ask until then).
   */
  ready(): boolean {
    return (
      !this.#first &&
      this.#screen.every((layer) => this.#live.get(layer.id)?.sim?.ready?.() !== false)
    );
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

  /**
   * The program a layer turn plays in (SceneSim.turning): while a layer the setting switches off
   * has not played its exit yet, the layer set on screen, drawing turns; while one it switches on is
   * not on screen yet or plays its entrance, the setting's, drawing turns; else none, as where that
   * program would draw no turns (Composition.drawsTurns): the setting's own program then simply
   * takes over once built.
   */
  turning(drawn: string, wanted: Readonly<Record<string, number>>): SceneTurn | undefined {
    let plan = this.#turnPlan;
    if (plan?.drawn !== drawn || plan.wanted !== wanted) {
      const gates = this.#c.gates;
      const screen = layersOfKey(drawn, gates);
      const asked = new Set<string>();
      for (const [gate, id] of Object.entries(gates)) if (wanted[gate] === 1) asked.add(id);
      const setting = { ...wanted, [TURNS_GATE]: 1 };
      plan = {
        drawn,
        wanted,
        leaving: [...screen].filter((id) => !asked.has(id)),
        coming: [...asked].some((id) => !screen.has(id)),
        screen: this.#throughOf(drawn),
        setting: this.#c.drawsTurns(setting) ? { features: setting, setting: true } : undefined,
      };
      this.#turnPlan = plan;
    }
    if (plan.screen !== undefined)
      for (const id of plan.leaving) {
        const live = this.#live.get(id);
        if (live !== undefined && (Number.isNaN(live.leaving) || live.passage.exit < 1))
          return plan.screen;
      }
    if (plan.setting === undefined) return undefined;
    if (plan.coming) return plan.setting;
    for (const live of this.#live.values()) if (!Number.isNaN(live.arrived)) return plan.setting;
    return undefined;
  }

  /** The features of the program a layer switched off from `drawn` leaves through (see there). */
  leavesThrough(drawn: string): Readonly<Record<string, number>> | undefined {
    return this.#throughOf(drawn)?.features;
  }

  /**
   * The program a layer switched off from the program on screen (`drawn`) plays its exit in: that
   * program's layer set, drawing turns (itself, if it draws them); none if it would draw no turns.
   */
  #throughOf(drawn: string): SceneTurn | undefined {
    let through = this.#through;
    if (through?.drawn !== drawn) {
      const features = { ...featuresOfKey(drawn), [TURNS_GATE]: 1 };
      through = {
        drawn,
        turn: this.#c.drawsTurns(features) ? { features, setting: false } : undefined,
      };
      this.#through = through;
    }
    return through.turn;
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
   * its allocation, each layer's sim started or stopped, and their own entrances and exits: begun
   * only in a program that draws turns (without a program named, always).
   */
  #follow(frame: SimFrame, placement: Placement): void {
    const from = frame.features ?? `placement ${this.#placementKey}`;
    if (from !== this.#screenFrom) {
      this.#screenFrom = from;
      const on =
        frame.features === undefined
          ? new Set(placement.layers.map((placed) => placed.layer.id))
          : layersOfKey(frame.features, this.#c.gates);
      this.#turns =
        frame.features === undefined || this.#c.drawsTurns(featuresOfKey(frame.features));
      const was = new Set(this.#screen.map((layer) => layer.id));
      this.#screen = this.#c.offered.filter((layer) => on.has(layer.id));
      this.#allocation = allocate(this.#screen);
      for (const live of this.#live.values()) {
        live.records.dirty = true;
        if (on.has(live.layer.id) && !was.has(live.layer.id) && !this.#first && this.#turns)
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
      else if (Number.isNaN(live.leaving) && this.#turns) live.leaving = frame.now;
    }
  }

  #start(layer: LayerDef, frame: SimFrame, shown: boolean): Live<R> {
    const records = new Rows(layer.data?.rows ?? 0);
    const fields: FieldSlot[] = Array.from({ length: layer.data?.fields ?? 0 }, () => ({
      texture: undefined,
    }));
    const passage = { enter: 1, exit: 0 };
    const specks = new Specks(this.#map);
    const ground = new Ground();
    const falls = new FallingInlet(this.#falling, layer, this.#c.offered.indexOf(layer));
    const lf: Mutable<LayerFrame<R>> = {
      ...frame,
      passage,
      rig: this.#rig,
      lift: 0,
      ground,
      gusts: this.#gusts,
      records,
      specks,
      fields,
      falling: falls,
      host: this.#host,
      ...(this.#c.room === undefined ? {} : { room: this.#c.room }),
    };
    const factory = this.#c.sims[layer.id];
    const view = this.#c.shortParams[layer.id] ?? this.#c.params;
    const renames: (readonly [string, string])[] = [];
    view.forEach((def, i) => {
      const key = this.#c.params[i]?.key;
      if (key === undefined || key === def.key) return;
      renames.push([def.key, key], [`${def.key}-amount`, `${key}-amount`]);
    });
    return {
      layer,
      sim: factory?.(this.#gl, view),
      records,
      fields,
      specks,
      ground,
      falls,
      frame: lf,
      renames,
      params: {},
      passage,
      arrived: !this.#first && shown && this.#turns ? frame.now : Number.NaN,
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

  /** The gust field's knobs, its 'now' age and the passage's front, for this frame (still without). */
  #gustField(frame: SimFrame): void {
    const g = this.#gusts;
    const knobs = this.#knobs;
    if (knobs === undefined) return;
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
    const half = 0.5 * this.#c.minAspect;
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

  #step(live: Live<R>, frame: SimFrame, lift: number): void {
    const alloc = this.#allocation;
    const onScreen = alloc.layers.includes(live.layer.id);
    // The scene's frame over the layer's (every field, whatever SimFrame holds), then its own.
    const lf = Object.assign(live.frame, frame);
    if (live.renames.length > 0) lf.params = viewParams(frame.params, live.renames, live.params);
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
    live.falls.shown = onScreen;
    live.specks.base = alloc.specks[live.layer.id] ?? 0;
    live.sim?.frame(lf);
  }

  /**
   * The falling things' steps for this frame, once every layer has named its drip points and
   * surfaces; drawn while a layer on screen lets things fall (Allocation.falling), at their codes.
   */
  #fall(frame: SimFrame, lift: number): void {
    const pool = this.#falling;
    const falling = this.#c.falling;
    if (pool === undefined || falling === undefined) return;
    const f = this.#fallFrame;
    f.dt = frame.dt;
    f.motion = frame.motion;
    f.motionTime = frame.motionTime;
    f.seed = this.#seedAt < 0 ? 0 : (frame.values[this.#seedAt] ?? 0);
    f.rain = frame.weather?.rain ?? 0;
    f.wet = frame.weather?.wet ?? 0;
    pool.step(f);
    const codes = this.#allocation.falling;
    if (codes === undefined) return;
    const v = this.#fallView;
    v.lift = lift;
    v.shift = falling.shift(frame.passage.enter, frame.passage.exit);
    v.width = this.#map.width;
    v.height = this.#map.height;
    v.parallaxX = frame.parallax?.x ?? 0;
    v.parallaxY = frame.parallax?.y ?? 0;
    this.#fallPlot.base = codes.base;
    pool.paint(this.#fallPlot, v);
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
      Object.keys(alloc.specks).length > 0 || alloc.falling !== undefined
        ? this.#speckTexture.texture
        : undefined;
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
export function composedSim<R>(
  composition: Composition<R>,
): (gl: WebGL2RenderingContext) => SceneSim {
  return (gl) => new ComposedSim(gl, composition);
}
