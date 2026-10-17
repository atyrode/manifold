// The composer contract (ADR 0062, src/scenes/README.md "Composers"): what a composer provides and
// what a layer declares. A composer is a camera rig, a site (the floor every layer stands on) and an
// order of composition; layers are modules from the scenes, stacked over it. Scene ids stay as
// scene presets (`ScenePreset`), from which `composeScene` (compose.ts) makes each `SceneDef`.
//
// Units: metres in the rig's frame (x right of the view's centre line, y up from the floor, z away
// from the eye), as LevelCamera (sims/camera.ts) and the World's `worldView` take them.
import type { Blurb, ParamDef } from "../params.ts";
import type { SkyPlanets } from "../scenes/planets.ts";
import type { SceneLook, SceneTheme, SimFrame } from "../scenes/types.ts";
import type { WorldOptions } from "../scenes/world.ts";
import type { LevelCamera } from "../sims/camera.ts";
import type { GustField, PassageGustShape } from "./gust.ts";

export type ComposerId = "outdoor" | "interior" | "overhead";

/** What a layer is to the composition (README "Layers"), in the lab's order of rows. */
export const ROLES = ["backdrop", "ground", "dressing", "cover", "life", "chore"] as const;
export type Role = (typeof ROLES)[number];

/** Where a layer stands: beyond about 60 m, 6–60 m, within about 6 m of the eye. */
export type Band = "far" | "middle" | "front";

/** An inclusive range. */
export type Span = readonly [min: number, max: number];

/** A point on the floor, metres. */
export type FloorPoint = readonly [x: number, z: number];

/** A claim's outline on the floor, metres from its layer's anchor. */
export type Shape =
  | { readonly kind: "disc"; readonly at: FloorPoint; readonly r: number }
  | {
      readonly kind: "box";
      readonly at: FloorPoint;
      /** Half its width (x) and depth (z) before the turn. */
      readonly half: FloorPoint;
      /** Radians, counter-clockwise seen from above. */
      readonly turn?: number;
    }
  | { readonly kind: "strip"; readonly points: readonly FloorPoint[]; readonly half: number };

/**
 * exclusive: nothing else exclusive or clearing overlaps it and no cover grows inside; clears:
 * covers thin to nothing in its core, feathered over CLEAR_FEATHER metres, and another layer's
 * exclusive claim may stand at its edge but not in its core; shared: covers grow in by their
 * overgrowth.
 */
export type ClaimKind = "exclusive" | "clears" | "shared";

export interface Claim {
  /** What stands there, for a refusal's reason: "the hives". */
  readonly name: string;
  readonly kind: ClaimKind;
  readonly shape: Shape;
  /**
   * A key-light shadow on the floor and on covers: a soft band from its centre away from the key,
   * the caster's height times the light's reach long but at most `length` (m), `radius` wide.
   */
  readonly shadow?: { readonly height: number; readonly radius: number; readonly length: number };
  /** The share of precipitation and lying snow kept off beneath it, 0..1. */
  readonly shelter?: number;
  /** Life layers steer round it. */
  readonly keepOut?: boolean;
  /** Placement refuses an anchor where it leaves the rig's view at the preset's minAspect. */
  readonly mustShow?: boolean;
}

/** A candidate placement, metres in the rig's frame; the first that fits is taken. */
export interface Anchor {
  readonly name: string;
  readonly at: FloorPoint;
}

/**
 * The rigs a layer can be drawn through: a preset whose rig falls outside any span does not offer
 * it (README "Relations between layers").
 */
export interface CameraRange {
  readonly eye?: Span;
  readonly horizon?: Span;
  readonly focal?: Span;
  readonly pitch?: Span;
}

/**
 * A light the layer brings: `glsl` names its `vec3 <fn>(vec3 p, vec3 n)`, the light it throws on
 * a surface at p (rig frame, metres) facing n, which the composer sums into `localLight` for every
 * layer; `gate` the layer's feature it is compiled under.
 */
export interface LayerLight {
  readonly name: string;
  readonly glsl: string;
  readonly gate?: string;
}

/**
 * The passes a layer has, each a GLSL function of its own (prefixed with its id), called by the
 * composer's generated entry in its order (README "Compositing"):
 *   begin       void <fn>(inout Ctx x): per-cell state; a backdrop sets x.air, x.groundTo, x.landZ
 *   sky         void <fn>(Ctx x, inout Cell c): a backdrop's sky and its staging over the deck
 *   ground      void <fn>(Ctx x, inout Cell c): a ground layer's floor below x.groundTo
 *   far, middle, front            void <fn>(Ctx x, inout Cell c): opaque, in canonical order
 *   farVeil, middleVeil, frontVeil void <fn>(Ctx x, inout Cell c): translucent, after a band's opaque
 *   air         void <fn>(inout Ctx x, inout Cell c): after the specks, before the fog: the air's own
 *               light (a backdrop's forward scatter, a lamp's halo into x.air.fog and x.air.drop)
 * and `speck`, `vec3 <fn>(int code, vec3 under, Ctx x)`: the colour of one of its speck codes.
 */
export interface LayerPasses {
  readonly begin?: string;
  readonly sky?: string;
  readonly ground?: string;
  readonly far?: string;
  readonly farVeil?: string;
  readonly middle?: string;
  readonly middleVeil?: string;
  readonly front?: string;
  readonly frontVeil?: string;
  readonly air?: string;
  readonly speck?: string;
}

/** What a layer's sim asks of the composed sim's shared resources (README "Sims in a composition"). */
export interface LayerData {
  /** Rows of the records atlas (rgba16f, ATLAS_WIDTH texels a row). */
  readonly rows?: number;
  /** Speck codes 1..specks in the shared speck map. */
  readonly specks?: number;
  /** Textures of its own, in any format and filter. */
  readonly fields?: number;
}

/**
 * GLSL several layers of one scene share (its colours, its shading, its per-cell state): compiled
 * in once, before the layers, when any layer holding it is on; `begin` names its `void <fn>(Ctx x)`,
 * run once per cell before the layers' own.
 */
export interface SharedGlsl {
  readonly id: string;
  readonly glsl: (rig: Rig) => string;
  readonly begin?: string;
}

/**
 * A layer's code: its GLSL, built for the preset's rig, the GLSL it shares with its scene's other
 * layers, and its sim. Kept apart from its manifest (LayerDef), so a scene's metadata loads without
 * it: each composed scene's code module (`<scene>/code.ts`) gathers the code of every layer it offers.
 */
export interface LayerCode {
  readonly glsl: (rig: Rig) => string;
  readonly shared?: readonly SharedGlsl[];
  readonly sim?: (gl: WebGL2RenderingContext, params: readonly ParamDef[]) => LayerSim;
}

export interface LayerDef {
  /** camelCase: its switch key, the prefix of its GLSL and of its qualified keys. */
  readonly id: string;
  /** Its heading in the lab, and its chip's label. */
  readonly title: string;
  readonly composers: readonly ComposerId[];
  readonly role: Role;
  /** A dressing that holds the front band (at most COMPOSER_CAPS.subjects of them). */
  readonly subject?: boolean;
  readonly bands: readonly Band[];
  readonly space: {
    readonly anchors: readonly Anchor[];
    readonly claims: readonly Claim[];
    /**
     * Its anchor and claims are laid out at the rig's minAspect and spread across a wider frame, as
     * the stage they were painted on does (the bees' garden): x scales by `stretch` (glsl.ts).
     */
    readonly stretch?: boolean;
  };
  readonly camera: CameraRange;
  /** A declared readability cheat: the apiary's hives at 1.5. Claims are sized as it is drawn. */
  readonly display?: { readonly scale: number };
  /** Its switch: a steady toggle, or the feature knob it grew from, keyed by its id. */
  readonly switch: ParamDef;
  /** Its knobs, hung on the switch with `when` by the composer. */
  readonly params: readonly ParamDef[];
  readonly groups: Readonly<Record<string, Blurb>>;
  /** Named "now" slots, keyed by its knobs: the composer numbers them. */
  readonly triggers?: readonly string[];
  readonly lights?: readonly LayerLight[];
  /**
   * Key-light shadows of its own shapes beyond its claims' bands (the orchard's crowns): each names
   * its `float <fn>(vec2 xz, Ctx x)`, 0 lit .. 1 shaded, which `casterShadow` takes the most of.
   */
  readonly casters?: readonly string[];
  readonly passes: LayerPasses;
  /** Its own gates (named with its prefix) at a setting, from the values the shader reads. */
  readonly featuresFor?: (values: Readonly<Record<string, number>>) => Record<string, number>;
  /** Every gate it can turn on, on. Required with featuresFor. */
  readonly featuresAll?: Readonly<Record<string, number>>;
  readonly data?: LayerData;
  /** Its covers' share inside shared claims comes from this knob (0..1). */
  readonly overgrowth?: string;
  readonly excludes?: readonly { readonly layer: string; readonly why: string }[];
  /** Another layer's gate it turns off while both are on. */
  readonly suppresses?: readonly {
    readonly layer: string;
    readonly gate: string;
    readonly why: string;
  }[];
  /** A chore's host. */
  readonly requires?: readonly string[];
  /** Its knob holding a Manifold M: the composer keeps at most one M on. */
  readonly mark?: string;
}

/**
 * The `outdoor` rig: a level pinhole at `eye` metres, the horizon at uv.y `horizon`, `focal` screen
 * heights per unit of slope, turned `turn` radians left of the sky's frame. `minAspect`: a frame
 * narrower than this is laid out as if this wide. `passage` names GLSL (and its CPU twin) that moves
 * the rig through the preset's entrance and exit.
 */
export interface Rig {
  readonly horizon: number;
  readonly focal: number;
  readonly eye: number;
  readonly turn: number;
  readonly pitch: number;
  readonly minAspect: number;
  readonly passage?: RigPassage;
}

/**
 * The rig moved by the preset's passage: `lift(enter, exit)` the eye's height over its rest height
 * (m); `glsl` defines its twin `float rigLift()` on passageIn() / passageOut(), and `float rigCut()`,
 * the share of cells cutting their edges per cell while the rig moves (0 at rest).
 */
export interface RigPassage {
  readonly lift: (enter: number, exit: number) => number;
  readonly glsl: string;
  /** The front the passage sends through the gust field, if it sends one (meadow's). */
  readonly gust?: PassageGustShape;
}

/**
 * The preset's light: the World's sky times these. Tints multiply the sun's and the sky's colours,
 * `floor` lifts the ambient, `moonlight` (when set) makes the moon the key light once the sun has set
 * at that share of its colour. `exposure` and `vignette` close the picture; `ink` is shadeOf's.
 */
export interface Grade {
  readonly sunTint?: readonly [number, number, number];
  readonly skyTint?: readonly [number, number, number];
  readonly floor?: readonly [number, number, number];
  readonly moonlight?: number;
  readonly exposure?: number;
  readonly vignette?: number;
  readonly ink: { readonly gain: number; readonly gamma: number };
}

/** The World's birds over the preset (worldBirds' WorldFlyway, README "Birds"). */
export interface Flyway {
  /** Nearest and farthest a flight passes (m). */
  readonly depth: readonly [number, number];
  /** The band of the frame they cross: this far above the horizon, up to `top` (uv). */
  readonly above: number;
  readonly top: number;
  /** The flights' seed offset beside the composer's seed. */
  readonly seed: number;
  /** The height (m) a swooping party skims at, and the formation's spread. */
  readonly skim: number;
  readonly spread: number;
  /** Their own extinction per metre, beside the backdrop's air. */
  readonly ext: number;
}

/** Where the World's shooting stars set out: skyAngles of the rig's ray (WorldSky's field). */
export type MeteorField = readonly [number, number, number, number];

/** A scene preset: the data a composed `SceneDef` is made from (README "Scene presets and keys"). */
export interface ScenePreset {
  readonly id: string;
  readonly composer: ComposerId;
  readonly title: string;
  readonly blurb: string;
  readonly accent: string;
  readonly look?: SceneLook;
  readonly theme?: (params: readonly ParamDef[]) => SceneTheme;
  readonly passage?: { readonly enter: number; readonly exit: number };
  readonly planets?: SkyPlanets;
  readonly rig: Rig;
  readonly grade: Grade;
  /** The World as this preset opens it: its hour, its cloud, its birds, its groups' text. */
  readonly world: Omit<WorldOptions, "meteors" | "lightning">;
  readonly meteors: MeteorField;
  readonly flyway: Flyway;
  /** The floor's kind where no ground layer lies (FLOOR_KINDS). */
  readonly floor: FloorKind;
  /** Home layers, on by default. */
  readonly layers: readonly string[];
  /** Where it departs from its knobs' defaults, keyed as in the URL. */
  readonly values: Readonly<Record<string, number>>;
  /** Compile-time features it holds at every setting (bees' moon phase). */
  readonly features?: Readonly<Record<string, number>>;
  /** Its own lab headings, over the composer's and its layers' (the World's sections' text). */
  readonly groups?: Readonly<Record<string, Blurb>>;
}

export const FLOOR_KINDS = [
  "earth",
  "lawn",
  "gravel",
  "sand",
  "rock",
  "moss",
  "ice",
  "snowfield",
  "water",
  "asphalt",
] as const;
export type FloorKind = (typeof FLOOR_KINDS)[number];

// ---- sims ---------------------------------------------------------------------------------------

/** Rows of the records atlas a layer writes (its own, from its first row). */
export interface RecordRows {
  /** rgba16f texels: ATLAS_WIDTH a row, `rows` rows, rows bottom to top. */
  readonly data: Float32Array;
  readonly rows: number;
  /** Its rows changed: they go up this frame. */
  touch(): void;
}

/** A layer's codes in the shared speck map: `code` 1..its count, `depth` in SPECK_DEPTH_STEP-ths of a metre. */
export interface SpeckWriter {
  readonly width: number;
  readonly height: number;
  plot(cx: number, cy: number, code: number, depth: number): void;
  block(cx: number, cy: number, w: number, h: number, code: number, depth: number): void;
}

/** A texture of a layer's own (README "Sims in a composition", slots 2–7). */
export interface FieldSlot {
  /** The texture to bind, or undefined while it has none (its `<id>Field<k>On()` reads false). */
  texture: WebGLTexture | undefined;
}

/** The placement as a layer's sim sees it (README "Space"). */
export interface LayerGround {
  /** Where its anchor stands (m, rig frame, stretched with the frame). */
  readonly anchor: FloorPoint;
  /** The placed claims of every layer on, in metres (stretched with the frame). */
  readonly claims: readonly PlacedClaim[];
  /** 0 in exclusive and clearing cores, the overgrowth inside shared claims, else 1. */
  coverAllowed(x: number, z: number, overgrowth?: number): number;
}

/** A claim where its layer was placed, rig frame (at minAspect), and whose it is. */
export interface PlacedClaim extends Claim {
  readonly layer: string;
}

/** What each layer's sim gets each frame (README "Sims in a composition"). */
export interface LayerFrame extends SimFrame {
  /** The rig at rest, and how far the passage lifts the eye over it now (m). */
  readonly rig: LevelCamera;
  readonly lift: number;
  readonly ground: LayerGround;
  readonly gusts: GustField;
  readonly records: RecordRows;
  readonly specks: SpeckWriter;
  readonly fields: readonly FieldSlot[];
}

export interface LayerSim {
  /** Steps and writes into its rows, its specks (every frame: the map is cleared before) and its fields. */
  frame(frame: LayerFrame): void;
  ready?(): boolean;
  dispose(): void;
}
