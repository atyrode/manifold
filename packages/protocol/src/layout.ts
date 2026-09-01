import { z } from "zod";

/**
 * The tile LAYOUT tree, and the container DISCIPLINE that decides who reads it. A
 * container is one object wearing one discipline: a `canvas` stores free-floating scene
 * elements, a `composition` stores this tile table under the scene doc's layout key, and
 * a third-party discipline stores whatever its own plugin stores.
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
 * A CONTAINER DISCIPLINE ID: which renderer a container asks for, as a bounded string.
 *
 * The roster is OPEN (#86, ratified 2026-09-01; built as #110). A discipline is a
 * manifest contribution — `contributes.disciplines`, carrying the placement rows the
 * algebra used to hold as literals — rather than a value this package enumerates, so a
 * third-party "spreadsheet discipline" plugin is a plugin instead of a wire change.
 * `canvas` and `composition` mean exactly what they meant as the enum's two members;
 * they are declared by `core.canvas` and `core.compositions` now, and every stored row
 * parses unchanged.
 *
 * THE LAST-SEGMENT INVARIANT IS RETIRED, and this is the reason on the record (#86's
 * fourth question, which asked for a check or a retirement and forbade a quiet lapse).
 * The closed enum's comment claimed that "each value IS the last segment of the plugin
 * that renders it (`core.canvas`, `core.compositions`) — a checkable invariant rather
 * than a coincidence". Nothing ever checked it, and writing the check is what exposed it
 * as FALSE in the shipped tree: `core.compositions` renders `composition`, singular
 * against plural. Making it true would have meant renaming a plugin every enablement row
 * already names, or renaming a discipline every stored container row already carries — a
 * data migration bought for a naming pun. And the pun does not generalise anyway: a
 * third-party id is not ours to constrain, and `com.example.sheets` renders `spreadsheet`
 * as legitimately as it renders `sheets`.
 *
 * What the claim was really after — "which plugin renders this?" — is answered by DATA
 * instead, and answered better: a discipline id is claimed GLOBALLY at assembly (two
 * declarants refuse, naming both), and the declaring plugin rides the assembly's
 * discipline registry and the published roster row. So the question has one answer that
 * cannot drift from a spelling, for shipped and third-party disciplines alike.
 *
 * The grammar is still a PLUGIN ID SEGMENT, and now for its own sake rather than for the
 * pun's: a discipline id appears in an index row, a placeholder, a refusal and a
 * `manifold://` path, so the same lowercase-dash spelling every other published name uses
 * is what keeps it addressable.
 *
 * What the schema does NOT decide is whether a discipline EXISTS. That is the live
 * roster's answer, and a row naming a discipline nothing declares is legal on the wire on
 * purpose: the container is still there, and every reader owes it a NAMED condition — the
 * `unknown_discipline` placement refusal, the engine-owned placeholder — never a crash
 * and never a silent downgrade to `canvas`.
 */
export const DISCIPLINE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const MAX_DISCIPLINE_ID_LENGTH = 32;
export const ContainerDisciplineSchema = z
  .string()
  .regex(DISCIPLINE_ID_PATTERN)
  .max(MAX_DISCIPLINE_ID_LENGTH);
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
 * NEW TILE MATERIAL: what a palette carry holds and a drop authors, as opposed to the
 * existing item every other ref names.
 *
 * A SPLIT is an empty directed group — two vacant leaves, so the drop that made it is
 * immediately two seats to fill; a SPACER is one inert leaf. Neither has an identity
 * before it lands, which is exactly why it is a shape of its own: every other
 * `PlacementRef` form addresses something that already exists, and this one addresses
 * something the drop brings into being.
 *
 * It lives beside the tile grammar rather than in the placement algebra because it IS
 * tile grammar — the same `dir` a split stores and the same `spacer` a leaf holds — and
 * a panel's own section arrangement (below) grows the same two shapes for the same
 * reason.
 */
export const StructureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("split"), dir: TileDirSchema }),
  z.strictObject({ kind: z.literal("spacer") }),
]);
export type Structure = z.infer<typeof StructureSchema>;

/**
 * How deep a panel's section arrangement may nest. A rail is a stack of rows and a
 * split of it is a handful of rows side by side; past a few levels the rows have no
 * width left to draw in, so the bound is what the chrome can honestly paint rather
 * than a guess. Refused rather than clamped: an arrangement that cannot be rendered is
 * not one a writer should believe was stored.
 */
export const MAX_SECTION_DEPTH = 4;

/**
 * ONE NODE of a panel's section arrangement: a section ID, or a SPLIT of more nodes.
 *
 * A bare string is a row, and an arrangement of nothing but strings is byte-identical to
 * the flat order this field held before splits existed — which is the whole of the
 * compatibility story: absent reproduces manifest order, a flat array reproduces the
 * stored order, and a split is new information a reader authored by dropping structure
 * into the rail (issue #104).
 *
 * The same two shapes as {@link StructureSchema}, and deliberately so: the palette drags
 * ONE vocabulary, and where it lands decides whether the split it makes is a tile split
 * or a row split. A spacer has no form here — the rail's rows are not a tile tree and
 * have no ratios for a spacer to hold open — so the palette's spacer is refused by the
 * sidebar the same way any other unplaceable carry is.
 */
export interface SectionSplit {
  readonly dir: TileDir;
  readonly sections: readonly SectionNode[];
}
export type SectionNode = string | SectionSplit;

export const SectionNodeSchema: z.ZodType<SectionNode> = z.lazy(() =>
  z.union([
    z.string().min(1).max(128),
    z.strictObject({
      dir: TileDirSchema,
      sections: z.array(SectionNodeSchema).max(MAX_PANEL_SECTIONS),
    }),
  ]),
);

/** Every section id one arrangement names, in paint order; splits contribute their members. */
export function sectionArrangementIds(nodes: readonly SectionNode[]): readonly string[] {
  const ids: string[] = [];
  const walk = (list: readonly SectionNode[]): void => {
    for (const node of list) {
      if (typeof node === "string") ids.push(node);
      else walk(node.sections);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Everything an arrangement must be that the schema cannot say: no id twice (an order
 * that names a row in two places is not an order), no more ids than a roster can
 * contribute, and no deeper than {@link MAX_SECTION_DEPTH}. Exported because both ends
 * enforce it — the layout validator below, and the policy that writes one.
 */
export function validSectionArrangement(nodes: readonly SectionNode[]): boolean {
  let depth = 0;
  const walk = (list: readonly SectionNode[], level: number): boolean => {
    if (level > MAX_SECTION_DEPTH) return false;
    if (level > depth) depth = level;
    for (const node of list) {
      if (typeof node === "string") continue;
      if (!walk(node.sections, level + 1)) return false;
    }
    return true;
  };
  if (!walk(nodes, 1)) return false;
  const ids = sectionArrangementIds(nodes);
  if (ids.length > MAX_PANEL_SECTIONS) return false;
  return new Set(ids).size === ids.length;
}

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
   * order this reader wants them, and — since issue #104 — grouped into SPLITS where they
   * arranged some side by side. Absent means the manifests decide; manifest order is the
   * default and stays the default, so an untouched workspace has no row here at all, and
   * an arrangement of bare ids is byte-identical to the flat order this field held before
   * splits existed.
   *
   * It sits on the TILE rather than beside the tree because a workspace tree is already
   * the one per-principal arrangement document (`core.space.setLayout` is its only door),
   * and "which panel" is the leaf itself. A second per-principal store for the same
   * question would be a second door onto one concept (AGENTS.md invariant 14) — which is
   * also why the palette drops structure into THIS field rather than minting one of its
   * own for the rail.
   *
   * Legal on a leaf holding a PANEL ref and nowhere else, and free of duplicates at any
   * depth — neither is expressible here, so {@link validateTileLayout} enforces both
   * through {@link validSectionArrangement}.
   */
  sections: z.array(SectionNodeSchema).max(MAX_PANEL_SECTIONS).optional(),
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
      if (!validSectionArrangement(tile.sections)) return false;
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
