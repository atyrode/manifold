import { z } from "zod";

/**
 * The tile LAYOUT tree, and the container DISCIPLINE that decides who reads it. A
 * container is one object with one of two disciplines: a `canvas` stores free-floating
 * scene elements, a `composition` stores this tile table under the scene doc's layout key.
 *
 * `layout` means exactly one thing in this codebase — this tree — and `discipline` means
 * exactly one thing: which renderer a container asks for.
 */

/** Every layout tree is entered through this id; it always exists. */
export const ROOT_TILE_ID = "root";

/** Fan-out bound per split, keeping tile payloads small on the wire. */
export const MAX_TILE_CHILDREN = 16;

/**
 * Bound on one panel leaf's stored section arrangement. A sidebar holds one slot per
 * declared section, so this bounds the payload by the number of sections a roster can
 * contribute rather than by anything a client chooses.
 */
export const MAX_PANEL_SECTIONS = 64;

/**
 * Container discipline: the one field that separates the two renderers of the same
 * object. Every placement rule that mentions a canvas or a composition resolves through
 * this, and each value IS the last segment of the plugin that renders it (`core.canvas`,
 * `core.compositions`) — a checkable invariant rather than a coincidence.
 */
export const ContainerDisciplineSchema = z.enum(["canvas", "composition"]);
export type ContainerDiscipline = z.infer<typeof ContainerDisciplineSchema>;

/**
 * What a leaf shows: a REFERENCE to the item occupying it. Every tileable item kind has
 * one form here, and each form names its item by identity: a terminal, a container, or —
 * for a note, which has no identity outside the document holding it — the element the
 * composition's own scene doc stores it under. A composition therefore OWNS its notes the
 * way a canvas does; placing a note into one moves the element into its document rather
 * than referencing it across two.
 *
 * It is one of the two shapes of the SAME addressing concept `PlacementRef` and
 * `ManifoldRef` carry (D7): a leaf's occupant is a reference, so it is named one.
 */
export const TileRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("terminal"), terminalId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("container"), containerId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("text"), elementId: z.string().min(1) }),
  /**
   * A plugin PANEL, named by its fully qualified panel id (`core.shell.sidebar`). This is
   * the form that makes the workspace shell itself a composition: a principal's workspace
   * layout is a tile tree whose leaves are panels, rendered by the same component every
   * other composition uses. A panel id naming no live panel — an unknown plugin, or a
   * disabled one — is legal on the wire and renders an inert placeholder, because a
   * disabled plugin must never make a layout unwritable.
   */
  z.strictObject({ kind: z.literal("panel"), panelId: z.string().min(1).max(96) }),
  /**
   * AN INERT SPACER: a leaf that holds nothing and refers to nothing, and is legal
   * everywhere `panel` is (issue #89). It exists so a stack can be given deliberate empty
   * room without a vacant `ref: null` leaf being mistaken for a target nobody has filled
   * in yet — `core.arrange`'s Spacer tool is the one writer, and only into the workspace's
   * own tree (`core.space.setLayout`'s handler still refuses every other kind there).
   * Carries no identity: every spacer is interchangeable with every other, the way an
   * empty leaf already is (`sameTileRef`, `refKey`).
   */
  z.strictObject({ kind: z.literal("spacer") }),
]);
export type TileRef = z.infer<typeof TileRefSchema>;

/** Split axis: `row` lays children out horizontally, `column` vertically. */
export const TileDirSchema = z.enum(["row", "column"]);
export type TileDir = z.infer<typeof TileDirSchema>;

/**
 * Where a dropped ref lands relative to a target tile. The four edges split the
 * target; `center` means THIS EXACT SPOT — it fills the leaf when the leaf is empty and
 * exchanges the two occupants when it is not. Which of the two a center drop turns out
 * to be is document state, so the executor decides it and names the answer (`swap`) in
 * its response rather than the request pretending to know.
 */
export const TileEdgeSchema = z.enum(["left", "right", "top", "bottom", "center"]);
export type TileEdge = z.infer<typeof TileEdgeSchema>;

/**
 * One tile. Exactly two shapes are legal: a SPLIT (`dir` set, `children` and
 * `ratios` parallel, `ref` null) or a LEAF (`dir` null, `children` empty,
 * `ref` either a reference or null for a vacant drop target).
 */
export const TileSchema = z.strictObject({
  id: z.string().min(1),
  dir: TileDirSchema.nullable(),
  ratios: z.array(z.number().positive()).max(MAX_TILE_CHILDREN),
  children: z.array(z.string().min(1)).max(MAX_TILE_CHILDREN),
  ref: TileRefSchema.nullable(),
  /**
   * How the principal ARRANGED the sections this panel leaf hosts: their ids, in the
   * order this reader wants them. Absent means the manifests decide — manifest order is
   * the default and stays the default, so an untouched workspace has no row here at all.
   *
   * It sits on the TILE rather than beside the tree because a workspace tree is already
   * the one per-principal arrangement document (`core.space.setLayout` is its only door),
   * and "which panel" is the leaf itself. A second per-principal store for the same
   * question would be a second door onto one concept (AGENTS.md invariant 14).
   *
   * Legal on a leaf holding a PANEL ref and nowhere else, and free of duplicates —
   * neither is expressible here, so {@link validateTileLayout} enforces both.
   */
  sections: z.array(z.string().min(1).max(128)).max(MAX_PANEL_SECTIONS).optional(),
});
export type Tile = z.infer<typeof TileSchema>;

/** Flat tile table keyed by tile id; the tree lives in `children` references. */
export const TileLayoutSchema = z.record(z.string().min(1), TileSchema);
export type TileLayout = z.infer<typeof TileLayoutSchema>;

/**
 * Structural validation the schema cannot express: the root exists, every child
 * reference resolves, nothing is reachable twice (no cycles, no shared subtrees),
 * ratios stay parallel to children, refs sit on leaves only, a section arrangement
 * sits on a panel leaf and names each section once, and a container never tiles
 * itself. Pass `containerId` to enforce the self-reference rule.
 *
 * Unreachable tiles are tolerated: they are inert garbage that the next
 * structural write prunes, and rejecting them would strand a live room.
 */
export function validateTileLayout(layout: TileLayout, containerId?: string): boolean {
  if (layout[ROOT_TILE_ID] === undefined) return false;

  for (const [id, tile] of Object.entries(layout)) {
    if (tile.id !== id) return false;
    if (tile.dir === null) {
      if (tile.children.length > 0 || tile.ratios.length > 0) return false;
    } else {
      // Splits carry structure, never content; ops collapse a one-child split
      // back into a leaf, so live trees hold two or more children per split.
      if (tile.children.length === 0) return false;
      if (tile.children.length !== tile.ratios.length) return false;
      if (tile.ref !== null) return false;
    }
    /*
      A section arrangement describes what a PANEL hosts, so it is meaningless on a split
      and on a leaf showing a container, a terminal or nothing — and a duplicated id would
      make "the order" ambiguous, which is the one thing an order may not be. Refused
      rather than normalized: a writer that cannot say what it wants gets told so.
    */
    if (tile.sections !== undefined) {
      if (tile.ref === null || tile.ref.kind !== "panel") return false;
      if (new Set(tile.sections).size !== tile.sections.length) return false;
    }
    if (
      containerId !== undefined &&
      tile.ref !== null &&
      tile.ref.kind === "container" &&
      tile.ref.containerId === containerId
    ) {
      return false;
    }
  }

  const seen = new Set<string>([ROOT_TILE_ID]);
  const queue: string[] = [ROOT_TILE_ID];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) break;
    const tile = layout[id];
    if (tile === undefined) return false;
    for (const child of tile.children) {
      if (layout[child] === undefined) return false;
      if (seen.has(child)) return false;
      seen.add(child);
      queue.push(child);
    }
  }
  return true;
}
