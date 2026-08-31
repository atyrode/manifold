import { z } from "zod";
import { TileEdgeSchema, type ContainerLayout } from "./layout.ts";

/**
 * The placement algebra: what composes with what, stated as DATA.
 *
 * Item kinds declare the capability groups they belong to; container kinds declare the
 * groups they accept; the only imperative rules are the enumerated guards. Every
 * nesting rule is therefore DERIVED from these tables — "views never nest" is the
 * absence of `tileable` from the `view` declaration, not a branch in an executor — and
 * every refusal names the declaration that refused it, so denials are machine-readable
 * and self-explaining rather than silent no-ops.
 *
 * `resolvePlacement` is pure: it takes a surface, a destination, and a lookup that
 * answers two questions from state the caller already holds. The server runs it against
 * its store and the browser against its live doc, so legality can never drift between
 * the preview and the write.
 */

// ------------------------------------------------------------------ vocabulary

/**
 * Capability groups. An item's groups are the only thing a container matches against,
 * so adding a kind is a data edit and its legality follows from these names alone.
 */
export const PLACEMENT_GROUPS = [
  /** May become a tile leaf of a tiled container. */
  "tileable",
  /**
   * May be absorbed into a composition as the item it holds. This is the "compositions
   * MERGE, never nest" half: a composition that holds exactly one item is that item as
   * far as placement is concerned, and dropping it into another composition moves the
   * item across and retires the emptied home.
   */
  "mergeable",
  /**
   * May be removed from every container that references it without ceasing to exist.
   * A terminal qualifies because its home composition outlives any placement of it; a
   * note does not, because until it is claimed its element IS its only existence.
   */
  "unplaceable",
  /** Renders live where embedded rather than as a navigable card. */
  "embeddable",
  /** May be a free-floating element of a canvas. */
  "canvas-item",
  /** May sit on a canvas as a portal element onto the container it IS. */
  "canvas-item-as-portal",
  /** May leave the container holding it, landing on a canvas as a plain element. */
  "extractable",
] as const;
export type PlacementGroup = (typeof PLACEMENT_GROUPS)[number];

/**
 * How an item acquires the composition it LIVES in — its home — which is a property of
 * the kind, not of any gesture:
 *
 *   `eager`    the server births the home with the item. A terminal has one before its
 *              first frame of output, so "where does this terminal live" is never a
 *              question with two answers.
 *   `on-claim` the item is born inline in whatever document created it (CRDT-instant, no
 *              round trip) and its home row materialises inside the first placement op
 *              that needs one — entering it, merging it, naming it.
 *   `inline`   the item needs no home: it exists in the document or row that holds it.
 *              Canvas furniture is inline, and so is a container, which IS a home.
 */
export const HOMING_MODES = ["eager", "on-claim", "inline"] as const;
export type HomingMode = (typeof HOMING_MODES)[number];

/**
 * The guards: the only rules that cannot be expressed as group containment. Each
 * declares the denial rule it raises and the SITE that declares it — an `item` guard is
 * listed by item kinds, a `container` guard by container kinds. Nothing else is
 * imperative, which is why this list is short and enumerable.
 */
export const PLACEMENT_GUARDS = {
  /** A container never embeds itself, however the drop addresses it. */
  "no-self-embed": { rule: "self_embed", site: "item" },
  /** A destination form only fits a container of its own discipline. */
  "discipline-match": { rule: "discipline", site: "container" },
  /**
   * Only a composition holding exactly ONE item merges into another composition. This
   * is the surviving half of "compositions merge, never nest": a solo composition is
   * absorbed as the item it holds — and by the time resolution runs it has already been
   * classified AS that item — so a composition still reaching a tile destination is one
   * that holds several items or none, and nothing absorbs it.
   */
  "solo-only": { rule: "not_solo", site: "item" },
} as const;
export type PlacementGuard = keyof typeof PLACEMENT_GUARDS;

type GuardsWithSite<S extends "item" | "container"> = {
  [K in PlacementGuard]: (typeof PLACEMENT_GUARDS)[K]["site"] extends S ? K : never;
}[PlacementGuard];
/** Guards an item kind may declare. */
export type ItemGuard = GuardsWithSite<"item">;
/** Guards a container kind may declare. */
export type ContainerGuard = GuardsWithSite<"container">;

/**
 * An item kind's PLACEMENT TRAITS: everything the algebra knows about a kind, stated as
 * data. The three fields are the whole vocabulary — the groups a container matches
 * against, the guards that cannot be expressed as containment, and how the kind acquires
 * a home — so a kind IS its traits and `ITEM_KINDS` below is a table of them.
 *
 * That completeness is the point (G1): a plugin contributing an element kind declares
 * these same traits in its manifest, and because nothing about a kind lives outside them,
 * the closed `ITEM_KINDS` union can later be opened to composed kinds without the algebra
 * learning a new concept. This wave the union stays closed and the manifest traits are
 * carried but not yet fused into it.
 */
export interface PlacementTraits {
  readonly groups: readonly PlacementGroup[];
  readonly guards: readonly ItemGuard[];
  /**
   * How the item acquires the composition it lives in, or null when the question does not
   * apply: a panel is a RENDERING of a plugin contribution rather than an object with a
   * document, so it never acquires a home and none of the three modes describes it.
   */
  readonly homed: HomingMode | null;
}

/**
 * The item-site guards as a value tuple, because a schema has to enumerate them. The
 * completeness check below is what keeps this list from drifting from `PLACEMENT_GUARDS`:
 * a new item guard that is not listed here fails to compile.
 */
export const ITEM_GUARD_NAMES = ["no-self-embed", "solo-only"] as const satisfies readonly [
  ItemGuard,
  ...ItemGuard[],
];
type MissingItemGuard = Exclude<ItemGuard, (typeof ITEM_GUARD_NAMES)[number]>;
const itemGuardsComplete: MissingItemGuard extends never ? true : never = true;
void itemGuardsComplete;

/**
 * The same traits on the wire, so a manifest can carry them (G1). Bounded by the
 * vocabulary itself: a kind cannot declare a group or a guard the algebra does not define,
 * and it cannot declare the same trait twice into a longer list than there are traits.
 */
export const PlacementTraitsSchema = z.strictObject({
  groups: z.enum(PLACEMENT_GROUPS).array().max(PLACEMENT_GROUPS.length),
  guards: z.enum(ITEM_GUARD_NAMES).array().max(ITEM_GUARD_NAMES.length),
  homed: z.enum(HOMING_MODES).nullable(),
}) satisfies z.ZodType<PlacementTraits>;

/**
 * What a contributed element kind means when its manifest declares no traits: free-floating
 * canvas furniture that lives in the document holding it. This is the `draw` row verbatim —
 * the only element kind a plugin contributes this wave — so absence reproduces exactly
 * today's semantics rather than inventing a weaker default.
 */
export const DEFAULT_ELEMENT_PLACEMENT_TRAITS: PlacementTraits = {
  groups: ["canvas-item"],
  guards: [],
  homed: "inline",
};

/**
 * Every placeable item kind. A container is two kinds because its discipline decides what
 * it can be: a canvas tiles and embeds live, a composition only ever appears elsewhere as
 * a portal — the absence of `tileable` IS the no-nesting rule, and `mergeable` plus the
 * `solo-only` guard is what replaces it for the one case that is not nesting at all.
 */
export const ITEM_KINDS = {
  /**
   * A terminal is server-born, so its home composition is born with it: there is no
   * moment where a live PTY exists outside a composition, and no pool for one to fall
   * back into. Landing on a canvas therefore authors a PORTAL onto that home rather
   * than an element carrying the session — hence `canvas-item-as-portal`.
   */
  terminal: {
    groups: ["tileable", "unplaceable", "canvas-item-as-portal"],
    guards: [],
    homed: "eager",
  },
  "canvas-pad": {
    groups: ["tileable", "embeddable", "unplaceable", "canvas-item-as-portal"],
    guards: ["no-self-embed"],
    homed: "inline",
  },
  view: {
    groups: ["mergeable", "unplaceable", "canvas-item-as-portal"],
    guards: ["no-self-embed", "solo-only"],
    homed: "inline",
  },
  /**
   * A note tiles: a composition owns the note's element in its own document, which is
   * what makes `TileSurface`'s `text` form an element id rather than a cross-document
   * reference. Ink stays canvas-only — a stroke is positioned in canvas coordinates,
   * and a tile has none to give it.
   */
  text: { groups: ["tileable", "canvas-item"], guards: [], homed: "on-claim" },
  draw: { groups: ["canvas-item"], guards: [], homed: "inline" },
  /**
   * A leaf of a tiled container, addressed as the PLACEMENT it is rather than as the item
   * it holds — which is what makes one mirror of a multi-placed session grabbable.
   *
   * It is `extractable` onto a canvas and `tileable` into a composition, so a leaf can be
   * re-placed the way anything else can: an edge moves it, and the exact spot of another
   * leaf exchanges the two. The executor resolves what the leaf HOLDS at execution time,
   * because only the side owning the tree can see into it — a browser dragging a leaf of a
   * container it has not joined knows the placement and not the occupant.
   *
   * It is `unplaceable` too, because a leaf's occupant can leave the container without
   * ceasing to exist: the executor re-homes it — a terminal into a fresh solo composition,
   * an embedded canvas back to the index it already lives in. That is what the fullscreen
   * tile-minimize asks for, and it sends `{kind:"tile"} -> {kind:"unplaced"}`, so while
   * this group was missing the button could only ever toast a refusal.
   */
  tile: { groups: ["tileable", "extractable", "unplaceable"], guards: [], homed: "inline" },
  /**
   * A plugin PANEL, the leaf form the workspace shell is composed of. It is `tileable` and
   * nothing else: a panel is a rendering of a plugin's contribution, so it has no existence
   * outside a tile tree — there is no canvas element to author for it and nowhere for it to
   * sit unplaced. No wire SURFACE names one this wave: workspace layouts are written whole
   * by `core.layout.set`, so the kind is here as the algebra's answer for panels rather
   * than as a door.
   */
  panel: { groups: ["tileable"], guards: [], homed: null },
} as const satisfies Record<string, PlacementTraits>;
export type ItemKind = keyof typeof ITEM_KINDS;

/**
 * The same kinds as a value tuple, so a schema that must enumerate them is generated from
 * the declarations rather than restating them — a new kind cannot be added without every
 * enumeration following it.
 */
export const ITEM_KIND_NAMES = Object.keys(ITEM_KINDS) as [ItemKind, ...ItemKind[]];

interface ContainerDeclaration {
  readonly accepts: readonly PlacementGroup[];
  readonly guards: readonly ContainerGuard[];
}

/**
 * Every destination container kind and the groups it takes. `unplaced` is the absence of
 * a container: it is listed here because "nowhere" has to be a destination the algebra
 * can refuse by name, not a request that quietly does nothing.
 */
export const CONTAINER_KINDS = {
  canvas: {
    accepts: ["canvas-item", "canvas-item-as-portal", "extractable"],
    guards: ["discipline-match"],
  },
  view: { accepts: ["tileable", "mergeable"], guards: ["discipline-match"] },
  unplaced: { accepts: ["unplaceable"], guards: [] },
} as const satisfies Record<string, ContainerDeclaration>;
export type ContainerKind = keyof typeof CONTAINER_KINDS;

/**
 * Destination forms and what each one implies: the container kind that admits the item,
 * and the discipline its pad must have. `compose` is admitted by a VIEW because that is
 * what the drop creates — while the pad hosting the composition must be a canvas.
 */
export const DESTINATION_KINDS = {
  canvas: { container: "canvas", requires: "canvas" },
  tile: { container: "view", requires: "tiled" },
  compose: { container: "view", requires: "canvas" },
  unplaced: { container: "unplaced", requires: null },
} as const satisfies Record<string, { container: ContainerKind; requires: ContainerLayout | null }>;
export type DestinationKind = keyof typeof DESTINATION_KINDS;

/**
 * Where a canvas placement lands when the gesture named no point — a drop on a sidebar
 * row, or any other door that indexes a container rather than pointing into it. The
 * canvas destination always carries coordinates, so this is the one place that decides
 * what "no coordinates" means, rather than each caller inventing a pair.
 */
export const DEFAULT_CANVAS_DROP = { x: 160, y: 120 } as const;

/**
 * The operations a legal placement classifies into; the executor dispatches on these.
 *
 * Two names retired with the solo-composition cutover, and the ops they named did not
 * survive as separate ideas:
 *   `bind` -> `portal`. A terminal landing on a canvas no longer authors an element that
 *     carries its session; it authors a portal onto the composition the session lives in,
 *     which is byte-for-byte the same op a container already used. One door.
 *   `park` -> `unplace`. There is no pool to park into. Releasing a terminal removes the
 *     references to it and leaves it where it lives, so the op names the removal.
 */
export const PLACEMENT_OPS = [
  /**
   * Author a portal element onto a container that lands on a canvas — including the home
   * composition of a terminal, which is how a terminal appears on a canvas at all.
   */
  "portal",
  /** Pull a tile out of its container and author a canvas element for its occupant. */
  "extract",
  /** Remove every reference to the item; the item itself stays where it lives. */
  "unplace",
  /** Write a tile leaf into a tiled container, absorbing a solo composition if that is what landed. */
  "add_tile",
  /** Merge a canvas reference with the surface dropped on it into one new composition. */
  "compose",
  /** Move a plain canvas item (text, ink) from its canvas to the destination canvas. */
  "move_element",
  /**
   * Exchange two placements' contents: the carried surface takes the exact spot it was
   * released on, and whatever was there takes the seat the carry came from. Identities
   * survive — tile ids, element ids, z-order and selections are untouched — because a
   * swap moves occupants between seats, never the seats themselves.
   *
   * CENTER MEANS THIS EXACT SPOT, and that is the whole rule this op exists for. The
   * middle of an EMPTY leaf is a fill (`add_tile`); the middle of an OCCUPIED one is this
   * exchange. Occupancy is document state rather than a property of a kind, so
   * `resolvePlacement` cannot see it and never names this op: a center placement resolves
   * to `add_tile` or `compose`, and the executor re-tags it `swap` when it finds the spot
   * taken. The response is tagged by what actually ran, which is why the op is on the
   * wire at all instead of hiding inside the two it re-tags.
   */
  "swap",
  /**
   * Re-seat an occupied leaf and RE-HOME what was in it. The middle of an occupied leaf
   * asks for an exchange, but a carry holding no tile seat has nothing to trade back —
   * so instead of refusing, the carried item takes the leaf and the displaced occupant is
   * re-homed into a fresh solo composition, which appears at the top level of the index.
   * Nothing is destroyed: the displaced terminal keeps running, the embedded canvas keeps
   * existing, and the operator finds either one where everything unreferenced already is.
   *
   * Like `swap`, occupancy is document state, so `resolvePlacement` never names this op:
   * a center placement resolves to `add_tile` and the executor re-tags it here.
   */
  "replace",
] as const;
export type PlacementOp = (typeof PLACEMENT_OPS)[number];

/**
 * Ops no resolution ever names, because document state — not a kind — decides them. The
 * executor re-tags a resolved op to one of these at execution time, and publishing the
 * list is what keeps that honest: an agent reading the vocabulary learns that a center
 * placement can come back as a `swap` or a `replace` instead of discovering it from a
 * response it did not expect.
 */
export const EXECUTION_ONLY_OPS = ["swap", "replace"] as const satisfies readonly PlacementOp[];
export type ExecutionOnlyOp = (typeof EXECUTION_ONLY_OPS)[number];

/** What landing on a canvas MEANS per item kind; a canvas is the one polymorphic door. */
export const CANVAS_OPS = {
  terminal: "portal",
  "canvas-pad": "portal",
  view: "portal",
  text: "move_element",
  draw: "move_element",
  tile: "extract",
  /**
   * Unreachable by construction, and declared anyway so the table stays total: a canvas
   * accepts `canvas-item`, `canvas-item-as-portal` and `extractable`, and a panel carries
   * none of them, so group containment refuses panel -> canvas with `not_accepted` before
   * `resolvePlacement` ever consults an op.
   */
  panel: "portal",
} as const satisfies Record<ItemKind, PlacementOp>;

/** Op per non-canvas destination; the canvas destination consults `CANVAS_OPS`. */
export const DESTINATION_OPS = {
  tile: "add_tile",
  compose: "compose",
  unplaced: "unplace",
} as const satisfies Record<Exclude<DestinationKind, "canvas">, PlacementOp>;

/**
 * Denial rules: one per guard (derived from `PLACEMENT_GUARDS`), one for failed group
 * containment, two for identity — an id that resolves to nothing is a denial too, so no
 * request can fall through to a silent no-op — and two for what a center drop asks of an
 * occupied spot: the exchange it cannot make, and the occupant it cannot move aside.
 */
export const PLACEMENT_DENIAL_RULES = [
  "not_accepted",
  "unknown_surface",
  "unknown_container",
  /**
   * The CANVAS/COMPOSE door only. The element a center drop pointed at is taken, and the
   * surface offered is an IDENTITY form — a sidebar row, a bare session id — which names
   * an item without naming any canvas seat of it. There is nowhere for the occupant to
   * go, so the exchange is refused by name rather than quietly becoming a merge.
   *
   * A TILE destination answers differently: a seatless carry over an occupied leaf is a
   * `replace`, because a composition can always re-home what it displaces.
   */
  "not_swappable",
  /**
   * A `replace` cannot re-home what it would displace, because the occupant is a `text`
   * surface: a note's element lives in the composition's own document and has nowhere
   * else to be. So the exchange is refused BY NAME before anything moves, rather than
   * deleting a note the operator only meant to push aside.
   */
  "not_displaceable",
  PLACEMENT_GUARDS["no-self-embed"].rule,
  PLACEMENT_GUARDS["discipline-match"].rule,
  PLACEMENT_GUARDS["solo-only"].rule,
] as const;
export type PlacementDenialRule = (typeof PLACEMENT_DENIAL_RULES)[number];

type MissingGuardRule = Exclude<
  (typeof PLACEMENT_GUARDS)[PlacementGuard]["rule"],
  PlacementDenialRule
>;
const guardRulesComplete: MissingGuardRule extends never ? true : never = true;
void guardRulesComplete;

// ------------------------------------------------------------------ wire shapes

/**
 * What is being placed. `terminal` and `pad` name an ITEM by identity; `tile` and
 * `element` name an existing PLACEMENT of one, which is how a single mirror of a
 * multi-placed session becomes addressable.
 *
 * These are ADDRESSING forms, deliberately not `TileSurface`'s STORAGE forms. A note has
 * no identity outside the document that holds it, so it is addressed as an `element` of
 * that container and stored as a tile's `text` surface — the executor translates between
 * the two, and no caller can name a note it cannot say the location of.
 */
export const PlacementSurfaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("terminal"), sessionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("pad"), padId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("tile"),
    containerId: z.string().min(1),
    tileId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("element"),
    padId: z.string().min(1),
    elementId: z.string().min(1),
  }),
]);
export type PlacementSurface = z.infer<typeof PlacementSurfaceSchema>;

/** Where it is going. One form per destination kind; the executor never trusts more. */
export const PlacementDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("canvas"),
    padId: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal("tile"),
    padId: z.string().min(1),
    /** Null fills the first empty leaf, else splits the root. */
    targetTileId: z.string().min(1).nullable(),
    /** Null fills an empty target leaf, else splits it. */
    edge: TileEdgeSchema.nullable(),
    /**
     * A same-axis edge means one of two gestures, told apart by distance from the
     * seam: dropped ON the seam band, the newcomer wedges BETWEEN target and neighbor
     * and both cede a third; dropped deeper into the target's flank, it splits THAT
     * pane alone — the target cedes half and the neighbor is untouched. Absent ≡
     * false (split the target). Meaningless (and ignored) for cross-axis edges,
     * ends of a row, and `center`.
     *
     * `resolvePlacement` never reads this field, and that is deliberate: the algebra
     * answers on destination SHAPE alone, so it cannot refuse a nonsense `between`
     * and no future rule here should try — a ratio detail is not a placement legality
     * question. The authority it widens is real but bounded: `between` makes the
     * NEIGHBOR cede a third, a pane the request never names. Bounded because ratios
     * are already freely client-writable through divider drags, so this grants no new
     * capability, only a less obvious route to one already held.
     *
     * The whole defence is therefore `insertLeaf`'s branch structure in
     * `@manifold/scene`, which keeps every abusive combination inert rather than
     * refused: `center` returns before `between` is read, a cross-axis edge falls to
     * the wrapper branch that never reads it, and a row end fails the neighbor-index
     * guard and splits the target instead. A reader looking for the check upstream
     * will not find one; it is not missing.
     */
    between: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("compose"),
    padId: z.string().min(1),
    targetElementId: z.string().min(1),
    edge: TileEdgeSchema,
  }),
  /**
   * Nowhere. The item keeps existing — a terminal in its home composition, a container in
   * the index — and every reference to it goes. There is no position field because there
   * is no order to hold a position in: what used to be a pool with a durable sort order is
   * now the top level of the one index, and top level is where the unreferenced already are.
   */
  z.strictObject({ kind: z.literal("unplaced") }),
]);
export type PlacementDestination = z.infer<typeof PlacementDestinationSchema>;

type MissingDestinationKind = Exclude<PlacementDestination["kind"], DestinationKind>;
type ExtraDestinationKind = Exclude<DestinationKind, PlacementDestination["kind"]>;
const destinationsComplete: MissingDestinationKind extends never
  ? ExtraDestinationKind extends never
    ? true
    : never
  : never = true;
void destinationsComplete;

/** The one placement envelope: `POST /api/place` and `client.place()` both carry this. */
export const PlaceRequestSchema = z.strictObject({
  surface: PlacementSurfaceSchema,
  destination: PlacementDestinationSchema,
});
export type PlaceRequest = z.infer<typeof PlaceRequestSchema>;

/** The container a resolution landed in — or the one that refused. */
export const PlacementContainerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("canvas"), padId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("view"), padId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("unplaced") }),
]);
export type PlacementContainer = z.infer<typeof PlacementContainerSchema>;

type MissingContainerKind = Exclude<PlacementContainer["kind"], ContainerKind>;
type ExtraContainerKind = Exclude<ContainerKind, PlacementContainer["kind"]>;
const containersComplete: MissingContainerKind extends never
  ? ExtraContainerKind extends never
    ? true
    : never
  : never = true;
void containersComplete;

/**
 * A refusal, on the wire verbatim: the rule that refused, what was offered, and what
 * refused it. Callers render the rule; nobody parses a message string.
 */
export const PlacementDenialSchema = z.strictObject({
  rule: z.enum(PLACEMENT_DENIAL_RULES),
  surface: PlacementSurfaceSchema,
  container: PlacementContainerSchema,
});
export type PlacementDenial = z.infer<typeof PlacementDenialSchema>;

/**
 * What an executed placement RETURNS, tagged by the op that ran — which is the op that
 * ACTUALLY ran, not the one resolution predicted: a center placement onto a taken spot
 * comes back as `swap` or `replace`. Each op yields exactly the id its caller needs to
 * keep rendering: the placement it authored (`elementId` / `tileId`), the container a
 * composition was born into (`viewId`), the two seats an exchange moved between, the home
 * a displaced occupant went to, or the number of references a release removed.
 * `POST /api/place` serves this shape verbatim.
 */
export const PlaceResponseSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("portal"), elementId: z.string().min(1) }),
  z.strictObject({ op: z.literal("extract"), elementId: z.string().min(1) }),
  z.strictObject({ op: z.literal("move_element"), elementId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("unplace"),
    /**
     * References removed. Zero is a legal, meaningful answer — the item was already
     * unplaced — and it is the difference between "nothing happened because it was
     * already so" and the silent no-op the algebra refuses to have.
     */
    removed: z.number().int().nonnegative(),
  }),
  z.strictObject({ op: z.literal("add_tile"), tileId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("compose"),
    /** The composition the surfaces now share: newly born, or the one a portal pointed at. */
    viewId: z.string().min(1),
    /** The leaf the placed surface landed in. */
    tileId: z.string().min(1),
  }),
  z.strictObject({
    op: z.literal("swap"),
    /**
     * The placement now holding the carried surface: the exact spot the drop pointed at.
     * A tile id when two leaves exchanged, an element id when two canvas seats did — the
     * ids are of the same species as the placements that traded, which is why one field
     * answers for both contexts.
     */
    placementId: z.string().min(1),
    /** The placement now holding what was there: the seat the carry came from. */
    withPlacementId: z.string().min(1),
  }),
  z.strictObject({
    op: z.literal("replace"),
    /** The leaf now holding the carried surface: the exact spot the drop pointed at. */
    tileId: z.string().min(1),
    /**
     * The fresh solo composition the displaced occupant was re-homed into, so a caller can
     * reveal where the thing it pushed aside went. Null when the occupant needed no new
     * home — an embedded canvas is a REFERENCE, and the pad it points at already lives in
     * the index on its own.
     */
    displacedContainerId: z.string().min(1).nullable(),
  }),
]);
export type PlaceResponse = z.infer<typeof PlaceResponseSchema>;

type MissingResponseOp = Exclude<PlacementOp, PlaceResponse["op"]>;
type ExtraResponseOp = Exclude<PlaceResponse["op"], PlacementOp>;
const responsesComplete: MissingResponseOp extends never
  ? ExtraResponseOp extends never
    ? true
    : never
  : never = true;
void responsesComplete;

/** The HTTP error code a denial travels under; distinct from the generic error codes. */
export const PLACEMENT_DENIED_CODE = "placement_denied";

/**
 * A denied placement on the wire: HTTP 409 with the derived denial beside the code, so a
 * client renders the RULE that refused rather than parsing prose. The message is a
 * courtesy for logs and toasts; the `denial` is the contract.
 */
export const PlacementDeniedResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal(PLACEMENT_DENIED_CODE),
    message: z.string(),
    denial: PlacementDenialSchema,
  }),
});
export type PlacementDeniedResponse = z.infer<typeof PlacementDeniedResponseSchema>;

// ------------------------------------------------------------------ resolution

/**
 * An item, classified. `containerId` is the container the item IS, or — for a
 * composition-homed item — the container it LIVES IN. The two collapse into one field on
 * purpose: a solo composition and the terminal inside it are the same thing addressed
 * from two sides, and every op that needs an id needs exactly this one.
 */
export interface PlacementItem {
  readonly kind: ItemKind;
  readonly containerId: string | null;
}

/**
 * The same shape on the wire. It exists because a live carry now NAMES what it holds
 * (`CarrySchema.item`): a surface is an ADDRESS, and resolving an address into an item
 * takes a census of containers, terminals and solo occupancy that only the grabbing
 * client is guaranteed to have. Shipping the resolved item with the gesture is what lets
 * a collaborator render the same preview without owning that census — identity is data
 * (AGENTS.md invariant 11), and a wire form nobody else can interpret is the defect.
 */
export const PlacementItemSchema = z.strictObject({
  kind: z.enum(ITEM_KIND_NAMES),
  containerId: z.string().min(1).nullable(),
}) satisfies z.ZodType<PlacementItem>;

/**
 * What a live carry HOLDS: the address a release will place, and the item that address
 * names. One value, because the two must agree — a surface with somebody else's item is
 * not a state any producer can reach, and every consumer of a carry needs both (the
 * address to place, the item to judge legality and paint a species).
 */
export interface CarriedItem {
  readonly surface: PlacementSurface;
  readonly item: PlacementItem;
}

/**
 * The questions resolution asks of state. All are answerable without IO — the server reads
 * its pad rows and live room docs, the browser its props and live doc — so the same
 * function drives a drag preview and the write that follows it.
 */
export interface PlacementLookup {
  /** A container's discipline; null when no such container exists. */
  padLayout(padId: string): ContainerLayout | null;
  /**
   * What an existing canvas placement places: a portal places the container it points at
   * (hence `containerId`), text places text. Null when the element is absent.
   */
  elementItem(padId: string, elementId: string): PlacementItem | null;
  /**
   * The composition a terminal lives in. Never null for a live session — a terminal is
   * `homed: "eager"` — so null means no such session, which is a denial, not a state.
   */
  terminalHome(sessionId: string): string | null;
  /**
   * What a composition holds when it holds exactly ONE item; null when it holds several
   * or none. This is the whole of "merge, never nest": a solo composition is classified
   * as its occupant everywhere placement looks at it, so absorbing it is an ordinary
   * `tileable` placement of that occupant and no op has to know it happened.
   */
  soloOccupant(padId: string): PlacementItem | null;
}

export type PlacementResolution =
  | {
      readonly ok: true;
      readonly op: PlacementOp;
      readonly item: PlacementItem;
      readonly container: PlacementContainer;
    }
  | { readonly ok: false; readonly denial: PlacementDenial };

function containerFor(destination: PlacementDestination): PlacementContainer {
  switch (destination.kind) {
    case "canvas":
      return { kind: "canvas", padId: destination.padId };
    case "tile":
    case "compose":
      return { kind: "view", padId: destination.padId };
    case "unplaced":
      return { kind: "unplaced" };
    default: {
      const exhaustive: never = destination;
      return exhaustive;
    }
  }
}

/**
 * Looks THROUGH a solo composition to the item it holds. A composition of one is that
 * item — the renderer says so with element-first chrome, and placement says so here — so
 * every door gets the same answer without a single caller testing arity.
 */
function throughSolo(item: PlacementItem, lookup: PlacementLookup): PlacementItem {
  if (item.kind !== "view" || item.containerId === null) return item;
  return lookup.soloOccupant(item.containerId) ?? item;
}

/**
 * What a surface PLACES, classified. Exported because a refusal names a surface, not an
 * item — so anything rendering a denial (a drag preview, a log line) needs the same
 * classification `resolvePlacement` used, and deriving it twice is how the two drift.
 */
export function placementItemFor(
  surface: PlacementSurface,
  lookup: PlacementLookup,
): PlacementItem | null {
  switch (surface.kind) {
    case "terminal": {
      const home = lookup.terminalHome(surface.sessionId);
      if (home === null) return null;
      return { kind: "terminal", containerId: home };
    }
    case "pad": {
      const layout = lookup.padLayout(surface.padId);
      if (layout === null) return null;
      return throughSolo(
        { kind: layout === "canvas" ? "canvas-pad" : "view", containerId: surface.padId },
        lookup,
      );
    }
    case "tile":
      return { kind: "tile", containerId: null };
    case "element": {
      const placed = lookup.elementItem(surface.padId, surface.elementId);
      return placed === null ? null : throughSolo(placed, lookup);
    }
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}

/**
 * Resolves a placement to the operation it is, or to the named rule that refuses it.
 * Pure, total, and declaration-driven: every pair of item kind and destination has an
 * answer, and the answer is never silence.
 *
 * Check order is fixed so denials are stable and testable: the destination container must
 * exist and match its discipline (`unknown_container`, `discipline`), the surface must
 * resolve to a declared kind (`unknown_surface`), the container must accept one of its
 * groups (`not_accepted`), and finally the item-site guards run (`self_embed`, `not_solo`).
 *
 * It answers about KINDS, never about the contents of a document, which is why a center
 * placement resolves to `add_tile` or `compose` here whatever occupies the target: the
 * executor holds the tree and re-tags the result `swap` or `replace` when the spot turns
 * out to be taken (see `EXECUTION_ONLY_OPS`). Keeping the occupancy branch out of this
 * function is what lets a browser predict legality from props alone.
 */
export function resolvePlacement(
  surface: PlacementSurface,
  destination: PlacementDestination,
  lookup: PlacementLookup,
): PlacementResolution {
  return resolveClassified(surface, () => placementItemFor(surface, lookup), destination, lookup);
}

/**
 * The same resolution for a carry that already NAMES its item — the live-gesture form.
 *
 * A collaborator holds the producer's `Carry` verbatim, and the producer resolved the item
 * at grab time from the census it owns by construction (it is the source). Re-resolving
 * the surface here would ask the WATCHER's census a question only the grabber can answer,
 * which is precisely how a viewer came to paint "That item no longer exists." over a
 * perfectly legal drag: the item existed, the watcher's 2s index poll simply had not heard
 * of it yet. The item travels, so nobody re-derives it.
 *
 * The destination is still resolved locally, and correctly so: the container being aimed at
 * is the watcher's own room.
 */
export function resolveCarriedPlacement(
  carried: CarriedItem,
  destination: PlacementDestination,
  lookup: PlacementLookup,
): PlacementResolution {
  return resolveClassified(carried.surface, () => carried.item, destination, lookup);
}

/**
 * The one resolution body. `item` is a thunk rather than a value so the CHECK ORDER above
 * holds for both doors: the destination's existence and discipline are judged before the
 * item is classified, whether that classification costs a census walk or nothing at all.
 */
function resolveClassified(
  surface: PlacementSurface,
  itemOf: () => PlacementItem | null,
  destination: PlacementDestination,
  lookup: PlacementLookup,
): PlacementResolution {
  const container = containerFor(destination);
  const declaration = DESTINATION_KINDS[destination.kind];
  const containerDeclaration = CONTAINER_KINDS[container.kind];
  const deny = (rule: PlacementDenialRule): PlacementResolution => ({
    ok: false,
    denial: { rule, surface, container },
  });

  const containerGuards: readonly PlacementGuard[] = containerDeclaration.guards;
  if (
    container.kind !== "unplaced" &&
    containerGuards.includes("discipline-match") &&
    declaration.requires !== null
  ) {
    const layout = lookup.padLayout(container.padId);
    if (layout === null) return deny("unknown_container");
    if (layout !== declaration.requires) return deny(PLACEMENT_GUARDS["discipline-match"].rule);
  }

  const item = itemOf();
  if (item === null) return deny("unknown_surface");

  const itemDeclaration = ITEM_KINDS[item.kind];
  const accepted = itemDeclaration.groups.some((group) =>
    (containerDeclaration.accepts as readonly PlacementGroup[]).includes(group),
  );
  if (!accepted) return deny("not_accepted");

  const itemGuards: readonly PlacementGuard[] = itemDeclaration.guards;
  if (
    itemGuards.includes("no-self-embed") &&
    container.kind !== "unplaced" &&
    item.containerId === container.padId
  ) {
    return deny(PLACEMENT_GUARDS["no-self-embed"].rule);
  }
  // Reaching a composition still classified as a composition means `throughSolo` found no
  // single occupant to absorb: it holds several items, or none. Either way nothing takes it.
  if (itemGuards.includes("solo-only") && container.kind === "view") {
    return deny(PLACEMENT_GUARDS["solo-only"].rule);
  }

  const op =
    destination.kind === "canvas" ? CANVAS_OPS[item.kind] : DESTINATION_OPS[destination.kind];
  return { ok: true, op, item, container };
}

/**
 * The algebra, published. `GET /api/protocol` serves this so agents and mods discover
 * what composes with what — and what cannot — from the declarations themselves.
 */
export function placementVocabulary(): Record<string, unknown> {
  return {
    groups: PLACEMENT_GROUPS,
    homingModes: HOMING_MODES,
    guards: PLACEMENT_GUARDS,
    items: ITEM_KINDS,
    containers: CONTAINER_KINDS,
    destinations: DESTINATION_KINDS,
    ops: PLACEMENT_OPS,
    executionOnlyOps: EXECUTION_ONLY_OPS,
    canvasOps: CANVAS_OPS,
    destinationOps: DESTINATION_OPS,
    denialRules: PLACEMENT_DENIAL_RULES,
  };
}
