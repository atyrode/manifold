// The composer contract (ADR 0062, src/scenes/README.md "Composers"): what a composer provides and
// what a layer declares. A composer is a camera rig, a site (the floor every layer stands on) and an
// order of composition; layers are modules from the scenes, stacked over it. Scene ids stay as
// scene presets (`ScenePreset`), from which `composeScene` (compose.ts) makes each `SceneDef`.
//
// Units: metres in the rig's frame (x right of the view's centre line, y up from the floor, z away
// from the eye), as LevelCamera (sims/camera.ts) and the World's `worldView` take them. The overhead
// composer's (overhead-glsl.ts): the frame's centre, x right and z up the frame, `span` metres tall.
import type { Blurb, ParamDef } from "../params.ts";
import type { SkyPlanets } from "../scenes/planets.ts";
import type { SceneLook, ScenePoint, SceneTheme, SimFrame } from "../scenes/types.ts";
import type { WorldOptions } from "../scenes/world.ts";
import type { LevelCamera } from "../sims/camera.ts";
import type { GustField, PassageGustShape } from "./gust.ts";

export type ComposerId = "outdoor" | "interior" | "overhead";

/**
 * What a layer is to the composition (README "Layers"), in the lab's order of rows. The overhead
 * composer's site is a bed and the water over it: `bed` stands as a backdrop does (exactly one, the
 * home one with none switched on), `water` as a ground (at most one; without it, the dry bed).
 */
export const ROLES = [
  "backdrop",
  "bed",
  "ground",
  "water",
  "dressing",
  "cover",
  "life",
  "chore",
] as const;
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
  /** Under the overhead rig: the metres a screen height spans (OverheadRig.span). */
  readonly span?: Span;
  /**
   * Under the overhead rig: drawn in the sea's water (the tide pool's), so offered only over it
   * (OverheadRig.salt), and a layer without it only away from it: the koi never in a tide pool.
   */
  readonly salt?: true;
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
 *   mirror      Mirrored <fn>(Ctx x, vec3 at, vec3 ray, WorldView m, vec2 spread): a backdrop's
 *               view in a level mirror at `at` along the reflected `ray` (m: worldMirrorView's view
 *               along it), what a ground that mirrors asks through composerMirror: its colour
 *               without its lamps, its lamps' colour and how bright they are, seen (x) and drawn out
 *               down the water (y). spread: how much a rough mirror softens what stands d metres
 *               behind its point, d · spread.x metres, and draws its lamps out, d · spread.y metres
 *   ground      void <fn>(Ctx x, inout Cell c): a ground layer's floor below x.groundTo
 *   far, middle, front            void <fn>(Ctx x, inout Cell c): opaque, in canonical order
 *   farVeil, middleVeil, frontVeil void <fn>(Ctx x, inout Cell c): translucent, after a band's opaque
 *   air         void <fn>(inout Ctx x, inout Cell c): after the specks, before the fog: the air's own
 *               light (a backdrop's forward scatter, a lamp's halo into x.air.fog and x.air.drop)
 *   glow        void <fn>(Ctx x, inout Cell c): after the fog, before the rain and snow: light the air
 *               scatters toward the eye over what the fog has veiled (swell's beams, its lamps' glow)
 * and `speck`, `vec3 <fn>(int code, vec3 under, Ctx x)`: the colour of one of its speck codes; and
 *   shade       void <fn>(Ctx x, Cell c, inout Shade o): after the grade's shadeOf, in canonical
 *               order: an accent or a colour of its own over the picture's (shore's plankton light,
 *               snapped per cell, at c.accent of the World's veil over it)
 * and, in the `interior` composer (room.ts), a backdrop's
 *   daylight    vec3 <fn>(Ctx x, vec2 p): the light it lets into the room onto a surface at frame
 *               point p, which the room's light (roomLight) adds for every layer (the window's)
 *   glass       vec4 <fn>(Ctx x): where its window's glass is, which roomGlass gives every layer
 *               (the frost glass's): how far inside the glass the cell lies from its bottom, top,
 *               left and right edges, frame heights, negative off it (a large number where the
 *               glass runs on out of frame)
 * and every layer's farVeil there: over the backdrop's far pass, before the ground (the frost on a
 * window's glass).
 * Under the overhead composer (overhead-glsl.ts) a pass is given `Patch x` (its begin `inout`)
 * and `inout Spot c`, and the entry runs, after the begins (the water's sets the surface:
 * x.slope, x.floorP, x.depth, x.flow, x.waterCol, x.caustic; the light's layer x.sun, x.power):
 *   bed         the bed layer's floor, seen at x.floorP through the water
 *   water       the water layer's colour over the bed
 *   floor       on the bed, seen through the water (weeds, stems), in canonical order
 *   cast        void <fn>(Patch x, inout float shadow): its shadow on the bed, the most of every
 *               layer's taken
 *   swim        in the water, over the shadows (the koi)
 *   float       on the surface (pads, petals, the rings' light, a boat)
 *   stand       standing out of the water (a stone)
 *   cover       the shade of what hangs over the patch (c.shade), and the light through it
 *   glint       the sun's glint on the open water (not where c.dry)
 *   over        over everything (the leaves of the border)
 *   grade       last, in canonical order (a passage's dimming)
 */
export interface LayerPasses {
  readonly begin?: string;
  readonly sky?: string;
  readonly mirror?: string;
  readonly ground?: string;
  readonly far?: string;
  readonly farVeil?: string;
  readonly middle?: string;
  readonly middleVeil?: string;
  readonly front?: string;
  readonly frontVeil?: string;
  readonly air?: string;
  readonly glow?: string;
  readonly speck?: string;
  readonly shade?: string;
  readonly daylight?: string;
  readonly glass?: string;
  readonly bed?: string;
  readonly water?: string;
  readonly floor?: string;
  readonly cast?: string;
  readonly swim?: string;
  readonly float?: string;
  readonly stand?: string;
  readonly cover?: string;
  readonly glint?: string;
  readonly over?: string;
  readonly grade?: string;
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
 * run once per cell before the layers' own. `G`: the rig it is built for (the overhead's under it).
 */
export interface SharedGlsl<G = Rig> {
  readonly id: string;
  readonly glsl: (rig: G) => string;
  readonly begin?: string;
}

/**
 * A layer's code: its GLSL, built for the preset's rig, the GLSL it shares with its scene's other
 * layers, and its sim. Kept apart from its manifest (LayerDef), so a scene's metadata loads without
 * it: each composed scene's code module (`<scene>/code.ts`) gathers the code of every layer it offers.
 * `G` is the rig its GLSL is built for, `R` the rig its sim sees (LayerFrame.rig): the outdoor's
 * pinhole and level camera, or the overhead rig for both.
 */
export interface LayerCode<G = Rig, R = LevelCamera> {
  readonly glsl: (rig: G) => string;
  readonly shared?: readonly SharedGlsl<G>[];
  readonly sim?: (gl: WebGL2RenderingContext, params: readonly ParamDef[]) => LayerSim<R>;
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
  /**
   * The time of year it shows, when it has one: a season knob (keyed `season`, its widget the sky's
   * `season` part) the composer lists once among its own knobs, the first offered layer's (README
   * "Scene presets and keys": `season` where a layer has a year), for every layer to read.
   */
  readonly season?: ParamDef;
  readonly groups: Readonly<Record<string, Blurb>>;
  /** Named "now" slots, keyed by its knobs: the composer numbers them. */
  readonly triggers?: readonly string[];
  readonly lights?: readonly LayerLight[];
  /**
   * Key-light shadows of its own shapes beyond its claims' bands (the orchard's crowns): each names
   * its `float <fn>(vec2 xz, Ctx x)`, 0 lit .. 1 shaded, which `casterShadow` takes the most of. In
   * the `interior` composer (room.ts) each names `float <fn>(vec2 p)`: its silhouette at frame point
   * p on the plane it stands in, how much of a light it stops there, which `roomCaster` takes the
   * most of for a backdrop that throws the room's shadows on its wall (the bonsai's tree).
   */
  readonly casters?: readonly string[];
  /**
   * In the `interior` composer (room.ts): shapes that hang in the room's space rather than stand on a
   * plane (the mobile's), each naming `float <fn>(vec3 P, vec3 L, float r)`: how much of a round
   * light, centre L and radius r, they hide from point P, 0 .. 1, in the metres the layer is drawn
   * in. `roomRayCaster` takes the most of every on layer's, for a light that throws the room's
   * shadows along the ray from each point of a surface toward it (the mobile's Sun on its walls).
   */
  readonly rayCasters?: readonly string[];
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
  /** Its hosts: a chore's, or the layer whose surface it draws from (shore's beach, the sea's). */
  readonly requires?: readonly string[];
  /** Its knob holding a Manifold M: the composer keeps at most one M on. */
  readonly mark?: string;
  /**
   * A backdrop's say over the World's rain and snow (README "Light, scale and weather"): `thin`
   * scales the drops' and flakes' cover, far to near (worldPrecipThinned), so they never bury its
   * subject; `air` names its `vec3 <fn>(Ctx x)`, the colour the far rain fuses into where that is not
   * the fog's (x.air.fog); `seen`, for a rig that is not level (skyward's, looking up), names its
   * `void <fn>(Ctx x, out mat3 rain, out mat3 snow)`, the axes its camera sees the rain and the snow
   * through (worldPrecipAxes: each mat3(right, up, fwd) in the frame of a level camera facing the
   * same way, x along the wind), its thinning and the shelter claims' still applied.
   */
  readonly precip?: {
    readonly thin?: readonly [far: number, near: number];
    readonly air?: string;
    readonly seen?: string;
  };
  /**
   * An `interior` backdrop that looks out (a window): the World crosses its glass, and an interior
   * preset lists the World's knobs only while it offers one (README "The interior composer").
   */
  readonly window?: true;
  /**
   * An `interior` layer drawn on a window's glass (roomGlass: the frost): offered only to a room
   * that offers a window backdrop with a `glass` pass (README "The interior composer").
   */
  readonly glass?: true;
  /**
   * An `overhead` layer open to the sky (a pond's, a tank's or a pool's water, and what reads the
   * air over it): an overhead preset lists the World's rain and wind, and compiles WORLD_RAIN, only
   * while it offers one (README "The overhead composer").
   */
  readonly open?: true;
}

/**
 * The `outdoor` rig: a level pinhole at `eye` metres, the horizon at uv.y `horizon`, `focal` screen
 * heights per unit of slope, turned `turn` radians left of the sky's frame. `minAspect`: a frame
 * narrower than this is laid out as if this wide. `passage` names GLSL (and its CPU twin) that moves
 * the rig through the preset's entrance and exit. `pitch` (rad down; 0 level): a pitched rig's
 * backdrop gives the cell's ray and how far along it the floor is in its begin (x.v, x.zg: metres
 * along the ray, the depths its layers give the cell), and the axes the World's drops are seen
 * through (`precip.seen`); the plain floor stands where they say.
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
 * The `overhead` rig (ADR 0062 Phase 4): the patch seen straight down, orthographic, `span` metres
 * from the frame's bottom to its top; `minAspect` the narrowest frame its claims are laid out for.
 * The frame's centre is the patch's origin, x right and z up the frame. Straight down only: the
 * ADR's `tilt` (a march) and `orbit` are not built.
 */
export interface OverheadRig {
  readonly span: number;
  readonly minAspect: number;
  /** The patch is the sea's water (the tide pool's): it offers the layers drawn in it alone. */
  readonly salt?: true;
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
  /**
   * `glsl` also defines `float rigShift()`: the lens's vertical shift in screen heights (0 at rest),
   * the world read that much lower in uv while the passage tilts the view (shore's).
   */
  readonly shift?: true;
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
  /**
   * The room's (room.ts): lights past 1 rolled off softly, `1 - exp(-col · rolloff)`, after the
   * exposure (the frost's lamps and glints).
   */
  readonly rolloff?: number;
  /**
   * The room's (room.ts): where its vignette darkens, `from` to `to` out from the centre with the
   * frame's width taken `across` times its share. Unset 0.45, 1 and 1.2; the bar's from 0.5, the
   * train's from 0.5 to 1.05 across 1.25.
   */
  readonly vignetteReach?: { readonly from: number; readonly to: number; readonly across: number };
  /**
   * The vignette's reach where it is a circle across the frame's width as well as its height (the
   * campfire's): `scale` units a screen height, darkening from `from` to `to` units out. Unset, an
   * oval of the frame's height.
   */
  readonly vignetteRound?: { readonly from: number; readonly to: number; readonly scale: number };
  /**
   * shadeOf's ink (inkOf's gain and gamma), and on the paper theme the white and range it takes
   * (inkOf's `paper`: dew's mist, 0.92 and 0.8). Unset, inkOf's own (0.9, 0.8).
   */
  readonly ink: {
    readonly gain: number;
    readonly gamma: number;
    readonly paper?: readonly [number, number];
  };
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
  /**
   * The share of the backdrop's dust (x.air.dust) that hazes them too, where the dust is what the
   * air holds (the desert's): unset, the birds see through the dust as the far land's haze.
   */
  readonly dust?: number;
}

/** Where the World's shooting stars set out: skyAngles of the rig's ray (WorldSky's field). */
export type MeteorField = readonly [number, number, number, number];

/** What every scene preset holds, whatever its composer (README "Scene presets and keys"). */
interface PresetBase {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly accent: string;
  readonly look?: SceneLook;
  readonly theme?: (params: readonly ParamDef[]) => SceneTheme;
  readonly passage?: { readonly enter: number; readonly exit: number };
  /** Home layers, on by default. */
  readonly layers: readonly string[];
  /** Where it departs from its knobs' defaults, keyed as in the URL. */
  readonly values: Readonly<Record<string, number>>;
  /** Compile-time features it holds at every setting (bees' moon phase). */
  readonly features?: Readonly<Record<string, number>>;
  /** Its own lab headings, over the composer's and its layers' (the World's sections' text). */
  readonly groups?: Readonly<Record<string, Blurb>>;
}

/** A scene preset at eye level: the data a composed `SceneDef` is made from. */
export interface ScenePreset extends PresetBase {
  readonly composer: "outdoor" | "interior";
  readonly planets?: SkyPlanets;
  readonly rig: Rig;
  readonly grade: Grade;
  /** The World as this preset opens it: its hour, its cloud, its birds, its groups' text. */
  readonly world: Omit<WorldOptions, "meteors" | "lightning">;
  readonly meteors: MeteorField;
  readonly flyway: Flyway;
  /** The floor's kind where no ground layer lies (FLOOR_KINDS). */
  readonly floor: FloorKind;
  /** The `interior` composer's room (README "The interior composer"); required there, unused outdoors. */
  readonly room?: Room;
}

/**
 * An `interior` preset's room (README "The interior composer"). Its rig (`ScenePreset.rig`) is a
 * level pinhole `eye` metres over the ledge across the front of the view (a sill, a sideboard), the
 * ledge's top the rig's floor; `distance` is how far the eye stands from the line things on the
 * ledge stand on (the seat), so the seat lies at `RIG_HORIZON - RIG_FOCAL · eye / distance` and the
 * ledge is drawn at `RIG_FOCAL / distance` screen heights a metre (room.ts `roomFrame`). The room is
 * laid out on the frame: across, as a share of the frame's width (anchors' x); up, in screen heights.
 */
export interface Room {
  /** From the eye to the seat line (m). */
  readonly distance: number;
  /** The back wall's albedo, where no backdrop covers it. */
  readonly wall: readonly [number, number, number];
  /** The room's light all round, beside its lamp, the window's daylight and the layers' lights. */
  readonly ambient: readonly [number, number, number];
  /**
   * The room's own lamp, out of frame, where it has one (the sill's reading lamp): its colour times
   * `gain` times `1 / (1 + 6 |d|²)`, d the frame point's offset from the lamp (`at`: x past the
   * frame's right edge, y up from its centre, screen heights) squashed `squash` times in height.
   */
  readonly lamp?: {
    readonly at: readonly [number, number];
    readonly squash: number;
    readonly color: readonly [number, number, number];
    readonly gain: number;
  };
}

/** Where the room's seat line stands on the frame (screen heights up from its centre) and its scale. */
export interface RoomFrame {
  readonly seat: number;
  /** Screen heights a metre at the seat line. */
  readonly scale: number;
}

/**
 * A preset of the overhead composer: a patch seen from above. Its light is its layers' (the pond's
 * sun, the tank's lamp); the World over the patch is not built (ADR 0062 Phase 4).
 */
export interface OverheadPreset extends PresetBase {
  readonly composer: "overhead";
  readonly rig: OverheadRig;
}

/** A preset of any composer. */
export type AnyPreset = ScenePreset | OverheadPreset;

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

/**
 * What each layer's sim gets each frame (README "Sims in a composition"). `R`: the rig at rest as
 * its sim sees it, the outdoor's level camera or the overhead rig.
 */
export interface LayerFrame<R = LevelCamera> extends SimFrame {
  /** The rig at rest, and how far the passage lifts the eye over it now (m). */
  readonly rig: R;
  readonly lift: number;
  readonly ground: LayerGround;
  /** The outdoor's gust field: still under a composer without one. */
  readonly gusts: GustField;
  readonly records: RecordRows;
  readonly specks: SpeckWriter;
  readonly fields: readonly FieldSlot[];
  /**
   * The affordances of another layer on (its sim's `affordances`: what a chore's host lets it do,
   * the state a life layer follows), or undefined while that layer has none running. The caller
   * narrows it to the host's type (`instanceof`).
   */
  host(layer: string): object | undefined;
  /** The room's seat line and scale on the frame, in an `interior` preset (undefined outdoors). */
  readonly room?: RoomFrame;
}

export interface LayerSim<R = LevelCamera> {
  /** Steps and writes into its rows, its specks (every frame: the map is cleared before) and its fields. */
  frame(frame: LayerFrame<R>): void;
  ready?(): boolean;
  /**
   * Where a press does something for it, in scene uv for a frame of `aspect` (SceneSim.interest:
   * the cast's agents go there and act); the composed sim gathers every on-screen layer's.
   */
  interest?(aspect: number): readonly ScenePoint[];
  /** What it lets other layers do to its state, or read of it: a chore's host's affordances. */
  readonly affordances?: object;
  dispose(): void;
}
