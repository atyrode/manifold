import { z } from "zod";
import { TileEdgeSchema, TileSurfaceSchema, type ContainerLayout } from "./layout.ts";

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
  /** May rest in the workspace terminal pool, bound to no container. */
  "parkable",
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
} as const;
export type PlacementGuard = keyof typeof PLACEMENT_GUARDS;

type GuardsWithSite<S extends "item" | "container"> = {
  [K in PlacementGuard]: (typeof PLACEMENT_GUARDS)[K]["site"] extends S ? K : never;
}[PlacementGuard];
/** Guards an item kind may declare. */
export type ItemGuard = GuardsWithSite<"item">;
/** Guards a container kind may declare. */
export type ContainerGuard = GuardsWithSite<"container">;

interface ItemDeclaration {
  readonly groups: readonly PlacementGroup[];
  readonly guards: readonly ItemGuard[];
}

/**
 * Every placeable item kind. A pad is two kinds because its discipline decides what it
 * can be: a canvas pad tiles and embeds live, a tiled container (a view) only ever
 * appears elsewhere as a portal — the absence of `tileable` IS the no-nesting rule.
 */
export const ITEM_KINDS = {
  terminal: { groups: ["tileable", "parkable", "canvas-item"], guards: [] },
  "canvas-pad": {
    groups: ["tileable", "embeddable", "canvas-item-as-portal"],
    guards: ["no-self-embed"],
  },
  view: { groups: ["canvas-item-as-portal"], guards: ["no-self-embed"] },
  text: { groups: ["canvas-item"], guards: [] },
  draw: { groups: ["canvas-item"], guards: [] },
  /** A leaf of a tiled container, addressed for extraction back onto a canvas. */
  tile: { groups: ["extractable"], guards: [] },
} as const satisfies Record<string, ItemDeclaration>;
export type ItemKind = keyof typeof ITEM_KINDS;

interface ContainerDeclaration {
  readonly accepts: readonly PlacementGroup[];
  readonly guards: readonly ContainerGuard[];
}

/** Every destination container kind and the groups it takes. */
export const CONTAINER_KINDS = {
  canvas: {
    accepts: ["canvas-item", "canvas-item-as-portal", "extractable"],
    guards: ["discipline-match"],
  },
  view: { accepts: ["tileable"], guards: ["discipline-match"] },
  pool: { accepts: ["parkable"], guards: [] },
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
  pool: { container: "pool", requires: null },
} as const satisfies Record<string, { container: ContainerKind; requires: ContainerLayout | null }>;
export type DestinationKind = keyof typeof DESTINATION_KINDS;

/** The operations a legal placement classifies into; P2's executor dispatches on these. */
export const PLACEMENT_OPS = [
  /** Author a canvas terminal element for a session that lands here. */
  "bind",
  /** Author a portal element onto a container that lands on a canvas. */
  "portal",
  /** Pull a tile out of its container and author a plain element for its occupant. */
  "extract",
  /** Release the item's last placement; a session joins the workspace pool. */
  "park",
  /** Write a tile leaf into a tiled container. */
  "add_tile",
  /** Birth a view around a canvas element and tile both surfaces inside it. */
  "compose",
  /** Move a plain canvas item (text, ink) from its canvas to the destination canvas. */
  "move_element",
] as const;
export type PlacementOp = (typeof PLACEMENT_OPS)[number];

/** What landing on a canvas MEANS per item kind; a canvas is the one polymorphic door. */
export const CANVAS_OPS = {
  terminal: "bind",
  "canvas-pad": "portal",
  view: "portal",
  text: "move_element",
  draw: "move_element",
  tile: "extract",
} as const satisfies Record<ItemKind, PlacementOp>;

/** Op per non-canvas destination; the canvas destination consults `CANVAS_OPS`. */
export const DESTINATION_OPS = {
  tile: "add_tile",
  compose: "compose",
  pool: "park",
} as const satisfies Record<Exclude<DestinationKind, "canvas">, PlacementOp>;

/**
 * Denial rules: one per guard (derived from `PLACEMENT_GUARDS`), one for failed group
 * containment, and two for identity — an id that resolves to nothing is a denial too, so
 * no request can fall through to a silent no-op.
 */
export const PLACEMENT_DENIAL_RULES = [
  "not_accepted",
  "unknown_surface",
  "unknown_container",
  PLACEMENT_GUARDS["no-self-embed"].rule,
  PLACEMENT_GUARDS["discipline-match"].rule,
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
 * What is being placed. The two tile surfaces name an ITEM by identity; `tile` and
 * `element` name an existing PLACEMENT of one, which is how a single mirror of a
 * multi-placed session, or a plain text element, becomes addressable.
 */
export const PlacementSurfaceSchema = z.discriminatedUnion("kind", [
  ...TileSurfaceSchema.options,
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
  }),
  z.strictObject({
    kind: z.literal("compose"),
    padId: z.string().min(1),
    targetElementId: z.string().min(1),
    edge: TileEdgeSchema,
  }),
  z.strictObject({
    kind: z.literal("pool"),
    /** Pool position; omitted appends. */
    index: z.number().int().nonnegative().optional(),
  }),
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
  z.strictObject({ kind: z.literal("pool") }),
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
 * What an executed placement RETURNS, tagged by the op that ran. Each op yields exactly
 * the id its caller needs to keep rendering: the placement it authored (`elementId` /
 * `tileId`), the container a composition was born into (`viewId`), or nothing at all for
 * a release. `POST /api/place` serves this shape verbatim.
 */
export const PlaceResponseSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("bind"), elementId: z.string().min(1) }),
  z.strictObject({ op: z.literal("portal"), elementId: z.string().min(1) }),
  z.strictObject({ op: z.literal("extract"), elementId: z.string().min(1) }),
  z.strictObject({ op: z.literal("move_element"), elementId: z.string().min(1) }),
  z.strictObject({ op: z.literal("park") }),
  z.strictObject({ op: z.literal("add_tile"), tileId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("compose"),
    /** The view the composition lives in: newly born, or the one a portal pointed at. */
    viewId: z.string().min(1),
    /** The leaf the placed surface landed in. */
    tileId: z.string().min(1),
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

/** An item, classified. `containerId` is set when the item IS a container. */
export interface PlacementItem {
  readonly kind: ItemKind;
  readonly containerId: string | null;
}

/**
 * The two questions resolution asks of state. Both are answerable without IO — the
 * server reads its pad rows and live room docs, the browser its props and live doc — so
 * the same function drives a drag preview and the write that follows it.
 */
export interface PlacementLookup {
  /** A container's discipline; null when no such container exists. */
  padLayout(padId: string): ContainerLayout | null;
  /**
   * What an existing canvas placement places: a terminal element places a terminal, a
   * portal places the container it points at (hence `containerId`), text places text.
   * Null when the element is absent.
   */
  elementItem(padId: string, elementId: string): PlacementItem | null;
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
    case "pool":
      return { kind: "pool" };
    default: {
      const exhaustive: never = destination;
      return exhaustive;
    }
  }
}

function itemFor(surface: PlacementSurface, lookup: PlacementLookup): PlacementItem | null {
  switch (surface.kind) {
    case "terminal":
      return { kind: "terminal", containerId: null };
    case "pad": {
      const layout = lookup.padLayout(surface.padId);
      if (layout === null) return null;
      return {
        kind: layout === "canvas" ? "canvas-pad" : "view",
        containerId: surface.padId,
      };
    }
    case "tile":
      return { kind: "tile", containerId: null };
    case "element":
      return lookup.elementItem(surface.padId, surface.elementId);
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
 * groups (`not_accepted`), and finally the item-site guards run (`self_embed`).
 */
export function resolvePlacement(
  surface: PlacementSurface,
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
    container.kind !== "pool" &&
    containerGuards.includes("discipline-match") &&
    declaration.requires !== null
  ) {
    const layout = lookup.padLayout(container.padId);
    if (layout === null) return deny("unknown_container");
    if (layout !== declaration.requires) return deny(PLACEMENT_GUARDS["discipline-match"].rule);
  }

  const item = itemFor(surface, lookup);
  if (item === null) return deny("unknown_surface");

  const itemDeclaration = ITEM_KINDS[item.kind];
  const accepted = itemDeclaration.groups.some((group) =>
    (containerDeclaration.accepts as readonly PlacementGroup[]).includes(group),
  );
  if (!accepted) return deny("not_accepted");

  const itemGuards: readonly PlacementGuard[] = itemDeclaration.guards;
  if (
    itemGuards.includes("no-self-embed") &&
    container.kind !== "pool" &&
    item.containerId === container.padId
  ) {
    return deny(PLACEMENT_GUARDS["no-self-embed"].rule);
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
    guards: PLACEMENT_GUARDS,
    items: ITEM_KINDS,
    containers: CONTAINER_KINDS,
    destinations: DESTINATION_KINDS,
    ops: PLACEMENT_OPS,
    canvasOps: CANVAS_OPS,
    destinationOps: DESTINATION_OPS,
    denialRules: PLACEMENT_DENIAL_RULES,
  };
}
