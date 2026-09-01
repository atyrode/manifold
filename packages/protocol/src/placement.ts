import { z } from "zod";
import {
  ContainerDisciplineSchema,
  StructureSchema,
  TileEdgeSchema,
  type ContainerDiscipline,
} from "./layout.ts";

/**
 * The placement algebra: what composes with what, stated as DATA.
 *
 * Item kinds declare the capability groups they belong to; container kinds declare the
 * groups they accept; the only imperative rules are the enumerated guards. Every
 * nesting rule is therefore DERIVED from these tables — "compositions never nest" is the
 * absence of `tileable` from the `composition` declaration, not a branch in an executor —
 * and every refusal names the declaration that refused it, so denials are machine-readable
 * and self-explaining rather than silent no-ops.
 *
 * `resolvePlacement` is pure: it takes a ref, a destination, and a lookup that
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
  /** May become a tile leaf of a composition. */
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
  "canvas_item",
  /** May sit on a canvas as a portal element onto the container it IS. */
  "canvas_item_as_portal",
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
 *   `on_claim` the item is born inline in whatever document created it (CRDT-instant, no
 *              round trip) and its home row materialises inside the first placement op
 *              that needs one — entering it, merging it, naming it.
 *   `inline`   the item needs no home: it exists in the document or row that holds it.
 *              Canvas furniture is inline, and so is a container, which IS a home.
 */
export const HOMING_MODES = ["eager", "on_claim", "inline"] as const;
export type HomingMode = (typeof HOMING_MODES)[number];

/**
 * The guards: the only rules that cannot be expressed as group containment. Each
 * declares the denial rule it raises and the SITE that declares it — an `item` guard is
 * listed by item kinds, a `container` guard by container kinds. Nothing else is
 * imperative, which is why this list is short and enumerable.
 */
export const PLACEMENT_GUARDS = {
  /** A container never embeds itself, however the drop addresses it. */
  no_self_embed: { rule: "self_embed", site: "item" },
  /** A destination form only fits a container of its own discipline. */
  discipline_match: { rule: "discipline", site: "container" },
  /**
   * Only a composition holding exactly ONE item merges into another composition. This
   * is the surviving half of "compositions merge, never nest": a solo composition is
   * absorbed as the item it holds — and by the time resolution runs it has already been
   * classified AS that item — so a composition still reaching a tile destination is one
   * that holds several items or none, and nothing absorbs it.
   */
  solo_only: { rule: "not_solo", site: "item" },
  /**
   * NEW STRUCTURE ONLY ENTERS A TREE THAT ALREADY EXISTS. A `tile` destination points
   * into a composition's own layout, which is the one place a split or a spacer means
   * anything; `compose` AUTHORS a composition out of two canvas elements, and an empty
   * split is not one of the two, so the destination form that builds a container rather
   * than entering one refuses it by name instead of asking the executor to invent a
   * meaning for it.
   */
  tree_only: { rule: "no_tree", site: "item" },
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
 * these same traits in its manifest, `assembleRoster` resolves them onto the element
 * registry, and the resolver reads THEM for any kind `ITEM_KINDS` does not declare (ADR
 * 0013 §12). So `ITEM_KINDS` holds the floor's own kinds — the structural ones no
 * plugin owns — and an element kind places without the engine ever learning its name.
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
export const ITEM_GUARD_NAMES = [
  "no_self_embed",
  "solo_only",
  "tree_only",
] as const satisfies readonly [ItemGuard, ...ItemGuard[]];
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
 * What an element kind means when nobody declared traits for it: free-floating canvas
 * furniture that lives in the document holding it.
 *
 * It is read twice. A manifest that contributes an element without a `placement` block
 * gets these traits at assembly time, and the resolver falls back to them for a kind no
 * assembly claims at all — an element whose plugin is absent from this build. Refusing
 * such a kind instead would strand elements sitting in documents right now behind a rule
 * about who is installed, which is a statement about the build rather than about what
 * composes.
 */
export const DEFAULT_ELEMENT_PLACEMENT_TRAITS: PlacementTraits = {
  groups: ["canvas_item"],
  guards: [],
  homed: "inline",
};

/**
 * The FLOOR's own item kinds: the structural kinds the algebra arbitrates between and no
 * plugin owns.
 *
 * NEITHER element kinds NOR container kinds are here. An element kind is manifest
 * contribution data, resolved through `PlacementLookup.itemTraits` (ADR 0013 §12). A
 * CONTAINER's item kind IS ITS DISCIPLINE, and a discipline is manifest contribution data
 * too (#110), resolved through `PlacementLookup.discipline` — so the `canvas` and
 * `composition` rows that used to sit here are now `core.canvas`'s and
 * `core.compositions`' own `contributes.disciplines[].item`, byte for byte, and the
 * no-nesting rule is still the absence of `tileable` from a declaration rather than a
 * branch in an executor.
 *
 * A kind is looked up in this table FIRST, so the floor's rows can never be redefined by
 * a manifest.
 */
export const ITEM_KINDS = {
  /**
   * A terminal is server-born, so its home composition is born with it: there is no
   * moment where a live PTY exists outside a composition, and no pool for one to fall
   * back into. Landing on a canvas therefore authors a PORTAL onto that home rather
   * than an element carrying the terminal — hence `canvas_item_as_portal`.
   */
  terminal: {
    groups: ["tileable", "unplaceable", "canvas_item_as_portal"],
    guards: [],
    homed: "eager",
  },
  /**
   * A leaf of a composition, addressed as the PLACEMENT it is rather than as the item
   * it holds — which is what makes one mirror of a multi-placed terminal grabbable.
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
   * this group was missing the button could only ever raise a notice.
   */
  tile: { groups: ["tileable", "extractable", "unplaceable"], guards: [], homed: "inline" },
  /**
   * A plugin PANEL, the leaf form the workspace shell is composed of. It is `tileable` and
   * nothing else: a panel is a rendering of a plugin's contribution, so it has no existence
   * outside a tile tree — there is no canvas element to author for it and nowhere for it to
   * sit unplaced. No wire REF names one this wave: workspace layouts are written whole
   * by `core.space.setLayout`, so the kind is here as the algebra's answer for panels rather
   * than as a door.
   */
  panel: { groups: ["tileable"], guards: [], homed: null },
  /**
   * NEW TILE MATERIAL a palette carry holds: an empty split, or a spacer leaf (issue
   * #104). It is the one kind that names nothing existing — the ref carries the SHAPE and
   * the drop brings it into being — which is why it is `homed: null` like a panel: there
   * is no document it lives in and no home for it to acquire.
   *
   * `tileable` says the only container that takes it is a composition's tile tree, and
   * `tree_only` says only the destination form that points INTO one does: a canvas
   * refuses it on groups alone, `unplaced` has nothing to remove it from, and `compose`
   * would have to invent what composing with an empty split means.
   */
  structure: { groups: ["tileable"], guards: ["tree_only"], homed: null },
} as const satisfies Record<string, PlacementTraits>;
export type ItemKind = keyof typeof ITEM_KINDS;

/**
 * The floor's kinds, the DISCIPLINE roster and the contributed element traits, as one
 * answer.
 *
 * A kind is resolved in a fixed order — floor table, then the discipline roster, then the
 * element assembly, then the element default — and the order is the contract: a manifest
 * can never redefine a structural kind, a container places by the traits ITS DISCIPLINE
 * declared, a composed element kind places by its own, and a kind nobody claims at all is
 * ordinary canvas furniture rather than a refusal about who is installed.
 *
 * That last clause deliberately does NOT cover a container whose discipline is
 * undeclared. An element kind nobody claims is furniture sitting in a document; an
 * UNDECLARED DISCIPLINE is a renderer that is not installed, and treating it as furniture
 * is precisely the silent downgrade to `canvas` that #86 ruled out. `resolveClassified`
 * refuses that case by name (`unknown_discipline`) before this function is reached, so
 * the element default can never answer for a container.
 */
export function itemTraitsFor(kind: string, lookup: PlacementLookup): PlacementTraits {
  const floor: Readonly<Record<string, PlacementTraits>> = ITEM_KINDS;
  return (
    floor[kind] ??
    lookup.discipline(kind)?.item ??
    lookup.itemTraits(kind) ??
    DEFAULT_ELEMENT_PLACEMENT_TRAITS
  );
}

/**
 * What a destination container takes: the groups it accepts, and the container-site
 * guards it enforces. Exported because it is no longer a floor literal — a DISCIPLINE
 * declares one of these (#110), and so does the one destination form that authors a
 * container instead of entering one.
 */
export interface ContainerDeclaration {
  readonly accepts: readonly PlacementGroup[];
  readonly guards: readonly ContainerGuard[];
}

/**
 * The container-site guards as a value tuple, for the same reason `ITEM_GUARD_NAMES` is
 * one: a manifest-declared discipline needs a schema to bound its `guards` list, and the
 * completeness check below is what keeps the tuple from drifting from `PLACEMENT_GUARDS`.
 */
export const CONTAINER_GUARD_NAMES = ["discipline_match"] as const satisfies readonly [
  ContainerGuard,
  ...ContainerGuard[],
];
type MissingContainerGuard = Exclude<ContainerGuard, (typeof CONTAINER_GUARD_NAMES)[number]>;
const containerGuardsComplete: MissingContainerGuard extends never ? true : never = true;
void containerGuardsComplete;

/**
 * A destination's CONTAINER FAMILY: the three shapes a resolution can name when it says
 * where an item landed, or what refused it. It is the discriminant of
 * `PlacementContainer`, and it is NOT the discipline roster — the roster is open and
 * lives in manifests, while this list is closed wire vocabulary that says whether the
 * answer names a free surface, a tile tree, or nowhere at all.
 *
 * `unplaced` is here because "nowhere" has to be a destination the algebra can refuse by
 * name rather than a request that quietly does nothing.
 */
export const CONTAINER_KINDS = ["canvas", "composition", "unplaced"] as const;
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/**
 * Destination forms and what each one implies: the container FAMILY a resolution reports,
 * and where its acceptance rows come from.
 *
 * `declaration: null` means the form ENTERS a container that already exists, so the
 * TARGET'S DISCIPLINE declares what may land there — which is the whole of the old
 * `requires` column, inverted. `requires` asked "which discipline does this form fit?"
 * and could only ever hold one answer per form; a discipline now answers the same
 * question from its own side, in `destinations`, and any number of them may answer for
 * one form.
 *
 * A non-null `declaration` is a form that does not enter a container of the discipline it
 * reports: `compose` AUTHORS one out of two canvas elements, and `unplaced` names none at
 * all. Both state their acceptance in floor GROUP vocabulary and name no discipline, so
 * opening the roster left no discipline id behind in this table.
 */
export const DESTINATION_KINDS = {
  canvas: { container: "canvas", declaration: null },
  tile: { container: "composition", declaration: null },
  compose: {
    container: "composition",
    declaration: { accepts: ["tileable", "mergeable"], guards: [] },
  },
  unplaced: { container: "unplaced", declaration: { accepts: ["unplaceable"], guards: [] } },
} as const satisfies Record<
  string,
  { container: ContainerKind; declaration: ContainerDeclaration | null }
>;
export type DestinationKind = keyof typeof DESTINATION_KINDS;

/**
 * The destination forms as a value tuple, so a discipline's `destinations` list has a
 * schema to be bounded by. Same completeness discipline as the guard tuples above.
 */
export const DESTINATION_KIND_NAMES = ["canvas", "tile", "compose", "unplaced"] as const satisfies
  readonly [DestinationKind, ...DestinationKind[]];
type MissingDestinationName = Exclude<DestinationKind, (typeof DESTINATION_KIND_NAMES)[number]>;
const destinationNamesComplete: MissingDestinationName extends never ? true : never = true;
void destinationNamesComplete;

/**
 * A CONTAINER DISCIPLINE, as the plugin that renders it declares it (#110, building the
 * ruling ratified on #86). This is the whole of what the algebra knows about a discipline,
 * and it is exactly the rows this file used to hold as literals for the two disciplines
 * that happened to ship in the box:
 *
 *   `item`         what a container OF this discipline is when it is the thing being
 *                  placed — the old `ITEM_KINDS.canvas` / `ITEM_KINDS.composition` row.
 *   `accepts`      the groups a container of this discipline takes as a destination, and
 *   `guards`       the container-site guards it enforces — the old `CONTAINER_KINDS` row.
 *   `destinations` the destination forms that may address it — the old
 *                  `DESTINATION_KINDS[...].requires` column, read from the other side.
 *
 * `title` is its display noun. The floor's label table holds FLOOR item kinds only, and a
 * contributed kind takes its manifest title (S12) — a discipline is a contributed kind
 * like any other, so its word travels with its declaration instead of in a second table.
 *
 * A discipline declaring no `discipline_match` guard is addressed by every destination
 * form its `accepts` admits; both shipped disciplines declare it, which is why a `tile`
 * drop onto a canvas is refused by name rather than by group containment.
 */
export interface DisciplineDeclaration {
  readonly id: ContainerDiscipline;
  readonly title: string;
  readonly item: PlacementTraits;
  readonly accepts: readonly PlacementGroup[];
  readonly guards: readonly ContainerGuard[];
  readonly destinations: readonly DestinationKind[];
}

/**
 * The same declaration on the wire, so a manifest can carry it — bounded by the algebra's
 * own vocabulary exactly the way {@link PlacementTraitsSchema} is: a discipline cannot
 * declare a group, a guard or a destination form the floor does not define.
 */
export const DisciplineDefSchema = z.strictObject({
  id: ContainerDisciplineSchema,
  title: z.string().min(1).max(64),
  item: PlacementTraitsSchema,
  accepts: z.enum(PLACEMENT_GROUPS).array().max(PLACEMENT_GROUPS.length),
  guards: z.enum(CONTAINER_GUARD_NAMES).array().max(CONTAINER_GUARD_NAMES.length),
  destinations: z.enum(DESTINATION_KIND_NAMES).array().max(DESTINATION_KIND_NAMES.length),
}) satisfies z.ZodType<DisciplineDeclaration>;

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
 *     carries its terminal id; it authors a portal onto the composition the terminal lives
 *     in, which is byte-for-byte the same op a container already used. One door.
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
  /** Write a tile leaf into a composition, absorbing a solo composition if that is what landed. */
  "add_tile",
  /** Merge a canvas reference with the ref dropped on it into one new composition. */
  "compose",
  /** Move a plain canvas item (text, ink) from its canvas to the destination canvas. */
  "move_element",
  /**
   * Exchange two placements' contents: the carried ref takes the exact spot it was
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

/**
 * What landing on a canvas MEANS per FLOOR item kind; a canvas is the one polymorphic
 * door. The canvas operation is never manifest data (ADR 0013 §12): letting a plugin name
 * the op a canvas performs on its kind would move an arbitration decision into a party's
 * declaration, so contributed kinds — element kinds and CONTAINER disciplines alike — are
 * answered by `canvasOpFor` from this table's own rules instead.
 */
export const CANVAS_OPS = {
  terminal: "portal",
  tile: "extract",
  /**
   * Unreachable by construction, and both declared anyway so the table stays total: a
   * canvas accepts `canvas_item`, `canvas_item_as_portal` and `extractable`, and neither a
   * panel nor new structure carries any of them, so group containment refuses both ->
   * canvas with `not_accepted` before `resolvePlacement` ever consults an op.
   */
  panel: "portal",
  structure: "portal",
} as const satisfies Record<ItemKind, PlacementOp>;

/**
 * The op a canvas performs on any kind, floor or contributed.
 *
 * Two floor rulings answer everything this table does not, and both are rulings ABOUT THE
 * CANVAS rather than properties a manifest declares — which is exactly why they are two
 * lines here instead of fields the algebra reads out of somebody's declaration:
 *
 *   a CONTAINER landing on a canvas is a `portal` onto it, whatever discipline it wears.
 *     This is the row `canvas: "portal"` and `composition: "portal"` used to state twice
 *     for the only two disciplines that existed; stating it once, for every discipline
 *     the roster holds, is the same ruling with the enumeration removed.
 *   an ELEMENT landing on a canvas is a `move_element`: it keeps its identity and changes
 *     documents.
 *
 * A kind that is neither — an undeclared discipline — never reaches here: it is refused
 * by name at `resolveClassified` (`unknown_discipline`).
 */
export function canvasOpFor(kind: string, lookup: PlacementLookup): PlacementOp {
  const floor: Readonly<Record<string, PlacementOp>> = CANVAS_OPS;
  const declared = floor[kind];
  if (declared !== undefined) return declared;
  return lookup.discipline(kind) === null ? "move_element" : "portal";
}

/** Op per non-canvas destination; the canvas destination consults `CANVAS_OPS`. */
export const DESTINATION_OPS = {
  tile: "add_tile",
  compose: "compose",
  unplaced: "unplace",
} as const satisfies Record<Exclude<DestinationKind, "canvas">, PlacementOp>;

/**
 * Denial rules: one per guard (derived from `PLACEMENT_GUARDS`), one for failed group
 * containment, three for identity — an id, or a discipline, that resolves to nothing is a
 * denial too, so no request can fall through to a silent no-op — and two for what a center
 * drop asks of an occupied spot: the exchange it cannot make, and the occupant it cannot
 * move aside.
 */
export const PLACEMENT_DENIAL_RULES = [
  "not_accepted",
  "unknown_ref",
  "unknown_container",
  /**
   * THE CONTAINER IS THERE AND ITS RENDERER IS NOT. The row resolves, its discipline
   * string is perfectly legal on the wire, and nothing in the composed roster declares
   * that discipline — the plugin is uninstalled, or this build never had it (#110,
   * ratifying #86 question 2).
   *
   * It is a rule of its own rather than `unknown_container` because the two are different
   * truths and a caller acts differently on each: `unknown_container` says the container
   * is gone, this says the container is fine and nobody here can read it. And it is a
   * refusal rather than a fallback because the alternative — resolving an undeclared
   * discipline through the element default — would quietly make every such container a
   * canvas, which is the outcome the ratification named and forbade.
   *
   * It answers for BOTH sides of a placement: a destination whose container wears an
   * undeclared discipline, and an item that IS such a container.
   */
  "unknown_discipline",
  /**
   * The CANVAS/COMPOSE door only. The element a center drop pointed at is taken, and the
   * ref offered is an IDENTITY form — a sidebar row, a bare terminal id — which names
   * an item without naming any canvas seat of it. There is nowhere for the occupant to
   * go, so the exchange is refused by name rather than quietly becoming a merge.
   *
   * A TILE destination answers differently: a seatless carry over an occupied leaf is a
   * `replace`, because a composition can always re-home what it displaces.
   */
  "not_swappable",
  /**
   * A `replace` cannot re-home what it would displace, because the occupant is a `text`
   * ref: a note's element lives in the composition's own document and has nowhere
   * else to be. So the exchange is refused BY NAME before anything moves, rather than
   * deleting a note the operator only meant to push aside.
   */
  "not_displaceable",
  PLACEMENT_GUARDS.no_self_embed.rule,
  PLACEMENT_GUARDS.discipline_match.rule,
  PLACEMENT_GUARDS.solo_only.rule,
  PLACEMENT_GUARDS.tree_only.rule,
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
 * What is being placed. `terminal` and `container` name an ITEM by identity; `tile` and
 * `element` name an existing PLACEMENT of one, which is how a single mirror of a
 * multi-placed terminal becomes addressable; `structure` names NOTHING THAT EXISTS YET —
 * it carries the shape a palette drag is holding, and the drop authors it (issue #104).
 *
 * These are ADDRESSING forms, deliberately not `TileRef`'s STORAGE forms. A note has
 * no identity outside the document that holds it, so it is addressed as an `element` of
 * that container and stored as a tile's `text` ref — the executor translates between
 * the two, and no caller can name a note it cannot say the location of.
 *
 * `structure` is the one form with no identity on either side of that translation, and it
 * is a REF rather than a second request shape because a palette drag is an ordinary carry:
 * one gesture kind, one wire payload, one release. Giving it its own envelope would be the
 * second drag flavor the carry kernel exists to prevent (AGENTS.md invariants 11 and 14).
 */
export const PlacementRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("terminal"), terminalId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("container"), containerId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("tile"),
    containerId: z.string().min(1),
    tileId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("element"),
    containerId: z.string().min(1),
    elementId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("structure"), structure: StructureSchema }),
]);
export type PlacementRef = z.infer<typeof PlacementRefSchema>;

/** Where it is going. One form per destination kind; the executor never trusts more. */
export const PlacementDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("canvas"),
    containerId: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal("tile"),
    containerId: z.string().min(1),
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
    containerId: z.string().min(1),
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

/** The one placement envelope: `core.space.place` and `client.place()` both carry this. */
export const PlaceRequestSchema = z.strictObject({
  ref: PlacementRefSchema,
  destination: PlacementDestinationSchema,
});
export type PlaceRequest = z.infer<typeof PlaceRequestSchema>;

/** The container a resolution landed in — or the one that refused. */
export const PlacementContainerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("canvas"), containerId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("composition"), containerId: z.string().min(1) }),
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
  ref: PlacementRefSchema,
  container: PlacementContainerSchema,
});
export type PlacementDenial = z.infer<typeof PlacementDenialSchema>;

/**
 * A denial as the ACTION door carries it, and back again.
 *
 * `core.space.place` refuses on the `refused` rung, and that rung carries one string — so
 * the string leads with the algebra's own rule name, in the refusal format every plugin
 * refusal uses (`<class>: <offenders>`, ADR 0013). The class is a member of the published
 * closed set `PLACEMENT_DENIAL_RULES`, which is what makes reading it back mechanical
 * rather than prose-parsing: `placementRefusalRule` accepts the class and nothing else.
 *
 * The ref and the container do not travel, because the caller already holds both — it
 * sent the ref, and the container is a total function of the destination
 * (`placementContainerFor`). So the denial is REBUILT client-side rather than duplicated
 * on the wire, and `not_accepted` keeps exactly one wording (ADR 0013 §14).
 */
export function placementRefusal(denial: PlacementDenial): string {
  return `${denial.rule}: ${denial.ref.kind} -> ${denial.container.kind}`;
}

/** The rule a refusal message leads with, or null when the refusal is not a placement's. */
export function placementRefusalRule(message: string): PlacementDenialRule | null {
  const head = message.split(":", 1)[0]?.trim() ?? "";
  const rules: readonly string[] = PLACEMENT_DENIAL_RULES;
  return rules.includes(head) ? (head as PlacementDenialRule) : null;
}

/**
 * What an executed placement RETURNS, tagged by the op that ran — which is the op that
 * ACTUALLY ran, not the one resolution predicted: a center placement onto a taken spot
 * comes back as `swap` or `replace`. Each op yields exactly the id its caller needs to
 * keep rendering: the placement it authored (`elementId` / `tileId`), the container a
 * composition was born into (`containerId`), the two seats an exchange moved between, the
 * home a displaced occupant went to, or the number of references a release removed.
 * `core.space.place` serves this shape verbatim as its action result.
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
    /** The composition the refs now share: newly born, or the one a portal pointed at. */
    containerId: z.string().min(1),
    /** The leaf the placed ref landed in. */
    tileId: z.string().min(1),
  }),
  z.strictObject({
    op: z.literal("swap"),
    /**
     * The placement now holding the carried ref: the exact spot the drop pointed at.
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
    /** The leaf now holding the carried ref: the exact spot the drop pointed at. */
    tileId: z.string().min(1),
    /**
     * The fresh solo composition the displaced occupant was re-homed into, so a caller can
     * reveal where the thing it pushed aside went. Null when the occupant needed no new
     * home — an embedded canvas is a REFERENCE, and the container it points at already lives in
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

// ------------------------------------------------------------------ resolution

/**
 * An item, classified. `containerId` is the container the item IS, or — for a
 * composition-homed item — the container it LIVES IN. The two collapse into one field on
 * purpose: a solo composition and the terminal inside it are the same thing addressed
 * from two sides, and every op that needs an id needs exactly this one.
 */
export interface PlacementItem {
  /**
   * A floor kind (`ITEM_KINDS`) or a composed ELEMENT type. It is a plain string because
   * the set is open by design: a plugin contributes an element without the engine learning
   * its name, and the traits that decide its legality arrive with it (ADR 0013 §12).
   */
  readonly kind: string;
  readonly containerId: string | null;
}

/**
 * The same shape on the wire. It exists because a live carry now NAMES what it holds
 * (`CarrySchema.ref`): a ref is an ADDRESS, and resolving an address into an item
 * takes a census of containers, terminals and solo occupancy that only the grabbing
 * client is guaranteed to have. Shipping the resolved item with the gesture is what lets
 * a collaborator render the same preview without owning that census — identity is data
 * (AGENTS.md invariant 11), and a wire form nobody else can interpret is the defect.
 */
export const PlacementItemSchema = z.strictObject({
  // Bounded exactly like a manifest's element type, which is what an open kind can be.
  kind: z.string().min(1).max(32),
  containerId: z.string().min(1).nullable(),
}) satisfies z.ZodType<PlacementItem>;

/**
 * What a live carry HOLDS: the address a release will place, and the item that address
 * names. One value, because the two must agree — a ref with somebody else's item is
 * not a state any producer can reach, and every consumer of a carry needs both (the
 * address to place, the item to judge legality and paint a species).
 */
export interface CarriedItem {
  readonly ref: PlacementRef;
  readonly item: PlacementItem;
}

/**
 * The questions resolution asks of state. All are answerable without IO — the server reads
 * its container rows and live room docs, the browser its props and live doc — so the same
 * function drives a drag preview and the write that follows it.
 */
export interface PlacementLookup {
  /**
   * A container's discipline STRING, as its row carries it; null when no such container
   * exists. It says what the row claims, never whether anything can read it — which is
   * why it is a different question from {@link PlacementLookup.discipline} below and both
   * are asked.
   */
  disciplineOf(containerId: string): ContainerDiscipline | null;
  /**
   * THE DISCIPLINE ROSTER, as this reader holds it: the declaration a plugin contributed
   * for `id`, or null for a discipline nothing in the composed roster declares (#110).
   *
   * It is the container-side twin of {@link PlacementLookup.itemTraits} and is read from
   * the same published roster, so the algebra learns what a `spreadsheet` container
   * accepts from the same document a stranger's agent reads at `GET /api/plugins`.
   *
   * DISABLED plugins are included, exactly as element traits are: their containers are
   * still in the index, and a container that became unplaceable and un-unplaceable at
   * once the moment somebody toggled a plugin is a workspace nobody can tidy. What a
   * disable changes is who RENDERS the container (D4′, the engine-owned placeholder), not
   * what composes with it.
   */
  discipline(id: string): DisciplineDeclaration | null;
  /**
   * What an existing canvas placement places: a portal places the container it points at
   * (hence `containerId`), any other element places its own type. Null when the element
   * is absent.
   */
  elementItem(containerId: string, elementId: string): PlacementItem | null;
  /**
   * The composition a terminal lives in. Never null for a live terminal — a terminal is
   * `homed: "eager"` — so null means no such terminal, which is a denial, not a state.
   */
  terminalHome(terminalId: string): string | null;
  /**
   * What a composition holds when it holds exactly ONE item; null when it holds several
   * or none. This is the whole of "merge, never nest": a solo composition is classified
   * as its occupant everywhere placement looks at it, so absorbing it is an ordinary
   * `tileable` placement of that occupant and no op has to know it happened.
   */
  soloOccupant(containerId: string): PlacementItem | null;
  /**
   * The traits a COMPOSED element kind declared, or null for a kind this reader's
   * assembly does not know. Floor kinds never reach here — `itemTraitsFor` consults
   * `ITEM_KINDS` first — so this is exactly the plugin half of the algebra's vocabulary
   * (ADR 0013 §12), read from the roster the server published rather than from a table
   * the engine had to edit.
   */
  itemTraits(kind: string): PlacementTraits | null;
}

export type PlacementResolution =
  | {
      readonly ok: true;
      readonly op: PlacementOp;
      readonly item: PlacementItem;
      readonly container: PlacementContainer;
    }
  | { readonly ok: false; readonly denial: PlacementDenial };

/**
 * The container a destination names, total over the destination union. Exported because a
 * caller reading a refusal off the action door rebuilds the denial it was sent, and the
 * container half of that denial is this function of the destination it already holds.
 */
export function placementContainerFor(destination: PlacementDestination): PlacementContainer {
  switch (destination.kind) {
    case "canvas":
      return { kind: "canvas", containerId: destination.containerId };
    case "tile":
    case "compose":
      return { kind: "composition", containerId: destination.containerId };
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
  if (item.kind !== "composition" || item.containerId === null) return item;
  return lookup.soloOccupant(item.containerId) ?? item;
}

/**
 * What a ref PLACES, classified. Exported because a refusal names a ref, not an
 * item — so anything rendering a denial (a drag preview, a log line) needs the same
 * classification `resolvePlacement` used, and deriving it twice is how the two drift.
 */
export function placementItemFor(ref: PlacementRef, lookup: PlacementLookup): PlacementItem | null {
  switch (ref.kind) {
    case "terminal": {
      const home = lookup.terminalHome(ref.terminalId);
      if (home === null) return null;
      return { kind: "terminal", containerId: home };
    }
    case "container": {
      const discipline = lookup.disciplineOf(ref.containerId);
      if (discipline === null) return null;
      return throughSolo({ kind: discipline, containerId: ref.containerId }, lookup);
    }
    case "tile":
      return { kind: "tile", containerId: null };
    /*
      New structure needs no census to classify: the ref IS the classification, because
      nothing it names exists anywhere to be looked up. The shape rides on to the executor
      inside the ref, which is where a `spacer` becomes a leaf and a `split` becomes two.
    */
    case "structure":
      return { kind: "structure", containerId: null };
    case "element": {
      const placed = lookup.elementItem(ref.containerId, ref.elementId);
      return placed === null ? null : throughSolo(placed, lookup);
    }
    default: {
      const exhaustive: never = ref;
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
 * exist, its discipline must be one the roster declares, and that discipline must admit
 * this destination form (`unknown_container`, `unknown_discipline`, `discipline`); the ref
 * must resolve to a declared kind, and to a READABLE one if it is a container
 * (`unknown_ref`, `unknown_discipline`); the container must accept one of its groups
 * (`not_accepted`); and finally the item-site guards run (`self_embed`, `not_solo`).
 *
 * It answers about KINDS, never about the contents of a document, which is why a center
 * placement resolves to `add_tile` or `compose` here whatever occupies the target: the
 * executor holds the tree and re-tags the result `swap` or `replace` when the spot turns
 * out to be taken (see `EXECUTION_ONLY_OPS`). Keeping the occupancy branch out of this
 * function is what lets a browser predict legality from props alone.
 */
export function resolvePlacement(
  ref: PlacementRef,
  destination: PlacementDestination,
  lookup: PlacementLookup,
): PlacementResolution {
  return resolveClassified(ref, () => placementItemFor(ref, lookup), destination, lookup);
}

/**
 * The same resolution for a carry that already NAMES its item — the live-gesture form.
 *
 * A collaborator holds the producer's `Carry` verbatim, and the producer resolved the item
 * at grab time from the census it owns by construction (it is the source). Re-resolving
 * the ref here would ask the WATCHER's census a question only the grabber can answer,
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
  return resolveClassified(carried.ref, () => carried.item, destination, lookup);
}

/**
 * The one resolution body. `item` is a thunk rather than a value so the CHECK ORDER above
 * holds for both doors: the destination's existence and discipline are judged before the
 * item is classified, whether that classification costs a census walk or nothing at all.
 */
function resolveClassified(
  ref: PlacementRef,
  itemOf: () => PlacementItem | null,
  destination: PlacementDestination,
  lookup: PlacementLookup,
): PlacementResolution {
  const container = placementContainerFor(destination);
  const form = DESTINATION_KINDS[destination.kind];
  const deny = (rule: PlacementDenialRule): PlacementResolution => ({
    ok: false,
    denial: { rule, ref, container },
  });

  /*
    THE DESTINATION'S DISCIPLINE, resolved before anything else is asked. `unplaced` names
    no container and skips the whole question; every other form names one, so the row has
    to exist and its discipline has to be readable — three distinct truths, three named
    refusals, none of them a fallback (#110).
  */
  let entered: DisciplineDeclaration | null = null;
  if (container.kind !== "unplaced") {
    const discipline = lookup.disciplineOf(container.containerId);
    if (discipline === null) return deny("unknown_container");
    entered = lookup.discipline(discipline);
    if (entered === null) return deny("unknown_discipline");
    const enteredGuards: readonly PlacementGuard[] = entered.guards;
    if (
      enteredGuards.includes("discipline_match") &&
      !entered.destinations.includes(destination.kind)
    ) {
      return deny(PLACEMENT_GUARDS.discipline_match.rule);
    }
  }
  /*
    WHOSE ACCEPTANCE ROWS APPLY. A form that enters an existing container is judged by
    that container's discipline; `compose` and `unplaced` bring their own, because neither
    enters a container of the discipline it reports. `entered` is non-null for every
    `declaration: null` form by the block above, so the fallback is unreachable and the
    `unplaced` row answers it if a future form ever changes that.
  */
  const containerDeclaration: ContainerDeclaration =
    form.declaration ?? entered ?? DESTINATION_KINDS.unplaced.declaration;

  const item = itemOf();
  if (item === null) return deny("unknown_ref");
  /*
    THE ITEM SIDE OF THE SAME QUESTION. A container's item kind IS its discipline, so an
    item naming a container whose kind is that container's own undeclared discipline is
    the second half of #86's question 2: the thing being dragged has no renderer here. It
    is refused by name rather than resolved through `DEFAULT_ELEMENT_PLACEMENT_TRAITS`,
    which would silently make it canvas furniture.
  */
  if (
    item.containerId !== null &&
    !Object.hasOwn(ITEM_KINDS, item.kind) &&
    lookup.disciplineOf(item.containerId) === item.kind &&
    lookup.discipline(item.kind) === null
  ) {
    return deny("unknown_discipline");
  }

  const itemDeclaration = itemTraitsFor(item.kind, lookup);
  const accepted = itemDeclaration.groups.some((group) =>
    containerDeclaration.accepts.includes(group),
  );
  if (!accepted) return deny("not_accepted");

  const itemGuards: readonly PlacementGuard[] = itemDeclaration.guards;
  if (
    itemGuards.includes("no_self_embed") &&
    container.kind !== "unplaced" &&
    item.containerId === container.containerId
  ) {
    return deny(PLACEMENT_GUARDS.no_self_embed.rule);
  }
  // Reaching a composition still classified as a composition means `throughSolo` found no
  // single occupant to absorb: it holds several items, or none. Either way nothing takes it.
  if (itemGuards.includes("solo_only") && container.kind === "composition") {
    return deny(PLACEMENT_GUARDS.solo_only.rule);
  }
  /*
    The only destination that points INTO an existing tree is `tile`. Everything else
    either has no tree (`canvas`, `unplaced` — both already refused on groups) or would
    have to BUILD one around the carry (`compose`), and there is nothing to build a
    composition out of when what landed is an empty split.
  */
  if (itemGuards.includes("tree_only") && destination.kind !== "tile") {
    return deny(PLACEMENT_GUARDS.tree_only.rule);
  }

  const op =
    destination.kind === "canvas"
      ? canvasOpFor(item.kind, lookup)
      : DESTINATION_OPS[destination.kind];
  return { ok: true, op, item, container };
}

/**
 * The algebra, published. `GET /api/protocol` serves this so agents and mods discover
 * what composes with what — and what cannot — from the declarations themselves.
 *
 * `items` and `canvasOps` are the FLOOR's kinds, and `containers` the closed family
 * vocabulary a resolution answers in. What is NOT here is the DISCIPLINE roster: which
 * disciplines a given build composed is a live fact, so it rides `ProtocolExtras` beside
 * the action roster, the same way a contributed element kind's traits ride its plugin's
 * row at `GET /api/plugins`. This package describes shapes and never their inhabitants —
 * and `GET /api/protocol` serves both halves in the one document, so there is still
 * exactly one door onto "what disciplines exist".
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
