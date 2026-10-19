// The engine's contract: one world in metres, a free camera, and placed objects, each an instance of
// a kind (src/engine/README.md). A setup is a document (EngineDoc), never a URL query: the lab edits
// it, the browser stores it, curated scenes ship as documents. The renderer casts one ray per dither
// cell against every placed object, nearest hit wins, and shades the hit with the World's light.
import type { ParamDef } from "../params.ts";

/** A point or a direction in the world, metres: x right, y up, z ahead at yaw 0. */
export type Vec3 = readonly [number, number, number];

/** The camera: where the eye stands, where it looks, how wide it sees. */
export interface EngineCamera {
  /** The eye, metres. */
  readonly at: Vec3;
  /** Turn about +y, radians, counter-clockwise seen from above; 0 looks along +z. */
  readonly yaw: number;
  /** Tilt, radians, up positive; -π/2 looks straight down. */
  readonly pitch: number;
  /** Vertical field of view, radians. */
  readonly fov: number;
}

/** One object in the world: a kind, where it stands, how it is turned and sized, its options. */
export interface Placed {
  /** Unique within its document, stable across edits (the lab's selection, a sim's state). */
  readonly id: string;
  /** Its kind's id (KindDef.id). */
  readonly kind: string;
  /** Its origin: the centre of its base, metres. */
  readonly at: Vec3;
  /** Turn about +y, radians. */
  readonly yaw: number;
  /** Uniform scale, 1 the kind's natural size. */
  readonly scale: number;
  /** Its option values by key (KindDef.options); a missing key reads its default. */
  readonly options: Readonly<Record<string, number>>;
}

/** A setup: everything a picture is, as data. */
export interface EngineDoc {
  readonly v: 1;
  readonly title: string;
  readonly camera: EngineCamera;
  /** The World's knobs by key (its hour, date, weather, wind): a missing key reads its default. */
  readonly world: Readonly<Record<string, number>>;
  readonly objects: readonly Placed[];
}

/** What an object is, for the lab's palette and outliner. */
export type Family =
  | "ground"
  | "water"
  | "structure"
  | "furniture"
  | "plant"
  | "creature"
  | "light"
  | "prop"
  | "phenomenon";

/** An axis-aligned box in the kind's own frame (origin at its base centre), metres, unscaled. */
export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * The land under an object: its height over the object's origin at plan point (x, z) of the
 * object's own frame, metres at scale 1 (src/engine/land.ts `landUnder`).
 */
export type Land = (x: number, z: number) => number;

/**
 * A kind's manifest: loads without its code. Options reuse the lab's knobs (ParamDef): a knob is a
 * per-instance value read from the instance texture, so moving it never builds a program; one marked
 * in `compiled` is a compile-time switch of the kind instead (its code differs, as a layer turn does).
 */
export interface KindDef {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly family: Family;
  readonly options: readonly ParamDef[];
  /**
   * Option keys that select code at compile time: choices whose values are small integers. The
   * program key holds, per key, the set of values the document's instances hold (KindCode.glsl).
   */
  readonly compiled?: readonly string[];
  /**
   * Its extent for these option values (every option, defaults filled in): the ray's bounding test
   * and the lab's picking. `land`, where the caller knows the document (the instance texture, the
   * CPU's cast), is the land under the object (land.ts `landUnder`): a kind standing on it (grass)
   * fits its bounds to it there, and elsewhere (the lab's framing) bounds any land it may meet.
   */
  bounds(options: Readonly<Record<string, number>>, land?: Land): Bounds;
  /** At most one object of each exclusive group in a document (one ground, one sky dome). */
  readonly exclusive?: string;
  /** Most instances a document may hold of it (at most 32, the largest instance bucket). */
  readonly max: number;
  /** How the lab sets it down: on whatever the ray meets below it, or anywhere in the air. */
  readonly rests: "surface" | "free";
  /** It blocks the World's key and the lamps' light: its GLSL defines `<id>Shadow`. */
  readonly casts?: boolean;
  /** It emits a point light: its GLSL defines `<id>Light`. */
  readonly emits?: boolean;
  /**
   * It keeps sim state per instance (KindCode.sim steps it): a block of `width` × `height` texels of
   * the state texture (src/engine/state.ts), which its GLSL reads as `<id>State(o, x, y)`.
   */
  readonly state?: { readonly width: number; readonly height: number };
  /**
   * Its exact shape on the CPU, for picking and dragging (src/engine/cast.ts): where the ray
   * `ro + rd t` (its own frame, `rd` unit, metres at scale 1) first meets it with `t` within `span`,
   * and the unit normal there in its own frame. Absent, its bounds stand in for it.
   */
  cast?(
    options: Readonly<Record<string, number>>,
    ro: Vec3,
    rd: Vec3,
    span: readonly [number, number],
  ): { readonly t: number; readonly normal: Vec3 } | undefined;
  /**
   * It is the land (one of the exclusive group `ground`): its height over its origin at plan point
   * (x, z) of its own frame, metres at scale 1, at full detail: the CPU twin of its GLSL `<id>Land`
   * (the header of src/engine/glsl.ts, THE LAND), read for every kind through src/engine/land.ts.
   */
  land?(options: Readonly<Record<string, number>>, x: number, z: number): number;
  /** Its code: GLSL and an optional sim, loaded when a document first holds it. */
  code(): Promise<KindCode>;
}

/** A kind's code. The GLSL contract is src/engine/glsl.ts's header; names are prefixed with the kind's id. */
export interface KindCode {
  /**
   * GLSL for these compile-time option values: for each key of KindDef.compiled, the bitmask of the
   * values the document's instances hold (bit v for value v), so one program draws all of them.
   */
  glsl(compiled: Readonly<Record<string, number>>): string;
  /**
   * Whether the code for these compile-time values can draw a see-through surface (`Hit.clear`
   * above 0, a window's glass): the program then carries the ray on past it, and traces the one
   * reflected ray for its reflection. Absent: never.
   */
  glass?(compiled: Readonly<Record<string, number>>): boolean;
  /**
   * Whether the code for these compile-time values can draw a mirror (`Hit.mirror` above 0): the
   * program then traces one reflected ray. Absent: never.
   */
  mirror?(compiled: Readonly<Record<string, number>>): boolean;
  /** The sim of a kind with KindDef.state: one per instance, keyed by its object's id. */
  readonly sim?: KindSim;
}

/**
 * A kind's per-instance sim (src/engine/state.ts runs it): every instance of the kind in the
 * document steps on fixed steps of motion time, so a seed plays the same at any frame rate.
 */
export interface KindSim {
  /** Seconds of motion time a step covers. */
  readonly step: number;
  /** Steps a new instance runs before it shows: a count, never a duration (src/sims/clock.ts). */
  readonly warmSteps: number;
  /** A new instance's sim, from `seed` (its object's id hashed) at its option values. */
  create(seed: number, options: Readonly<Record<string, number>>): InstanceSim;
}

/** One instance's sim: its state, stepped as KindSim says and written for its kind's GLSL. */
export interface InstanceSim {
  /** Warm-up step `i` of KindSim.warmSteps (a step size of its own); true once settled. */
  warm(i: number, options: Readonly<Record<string, number>>): boolean | void;
  /** One step of KindSim.step seconds at its option values now. */
  step(options: Readonly<Record<string, number>>): void;
  /** Its state into `block`: KindDef.state's width × height RGBA texels, row by row. */
  write(block: Float32Array): void;
}

/** Why a document cannot hold another object of a kind, or undefined if it can. */
export type Refusal = { readonly kind: string; readonly why: string } | undefined;

/**
 * What the lab asks of a running engine view: the document on screen, edits to it, and what lies
 * under a cell (for picking and for dragging an object across the world).
 */
export interface EngineView {
  readonly doc: EngineDoc;
  /** Show this document; only a change in the set of kinds or compiled options builds a program. */
  setDoc(doc: EngineDoc): void;
  /** The placed object nearest the eye under a cell (cell coordinates, origin bottom left), if any. */
  pick(cellX: number, cellY: number): string | undefined;
  /** Where the ray through a cell first meets a surface (the ground, an object), if anywhere. */
  surface(
    cellX: number,
    cellY: number,
    ignore?: string,
  ): { readonly at: Vec3; readonly normal: Vec3 } | undefined;
  /** Where a ray from `origin` along unit `dir` first meets a surface, if anywhere. */
  cast(
    origin: Vec3,
    dir: Vec3,
    ignore?: string,
  ): { readonly at: Vec3; readonly normal: Vec3 } | undefined;
}
