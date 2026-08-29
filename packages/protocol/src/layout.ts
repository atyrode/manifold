import { z } from "zod";

/**
 * Tiled-container layout tree. A View and a Pad are ONE container object that
 * differ only in `Pad.layout`: a canvas stores free-floating scene elements, a
 * tiled container stores this node table under the scene doc's layout key.
 */

/** Every layout tree is entered through this id; it always exists. */
export const ROOT_TILE_ID = "root";

/** Fan-out bound per split, keeping node payloads small on the wire. */
export const MAX_TILE_CHILDREN = 16;

/**
 * Container discipline: the one field that separates the two renderers of the same
 * object. Every placement rule that mentions "canvas" or "view" resolves through this.
 */
export const ContainerLayoutSchema = z.enum(["canvas", "tiled"]);
export type ContainerLayout = z.infer<typeof ContainerLayoutSchema>;

/** What a leaf shows. Terminals and canvases are both tileable surfaces. */
export const TileSurfaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("terminal"), sessionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("pad"), padId: z.string().min(1) }),
]);
export type TileSurface = z.infer<typeof TileSurfaceSchema>;

/** Split axis: `row` lays children out horizontally, `column` vertically. */
export const TileDirSchema = z.enum(["row", "column"]);
export type TileDir = z.infer<typeof TileDirSchema>;

/** Where a dropped surface lands relative to a target tile; `center` fills an empty leaf. */
export const TileEdgeSchema = z.enum(["left", "right", "top", "bottom", "center"]);
export type TileEdge = z.infer<typeof TileEdgeSchema>;

/**
 * One tile. Exactly two shapes are legal: a SPLIT (`dir` set, `children` and
 * `ratios` parallel, `surface` null) or a LEAF (`dir` null, `children` empty,
 * `surface` either a surface or null for an empty drop target).
 */
export const TileNodeSchema = z.strictObject({
  id: z.string().min(1),
  dir: TileDirSchema.nullable(),
  ratios: z.array(z.number().positive()).max(MAX_TILE_CHILDREN),
  children: z.array(z.string().min(1)).max(MAX_TILE_CHILDREN),
  surface: TileSurfaceSchema.nullable(),
});
export type TileNode = z.infer<typeof TileNodeSchema>;

/** Flat node table keyed by tile id; the tree lives in `children` references. */
export const TileLayoutSchema = z.record(z.string().min(1), TileNodeSchema);
export type TileLayout = z.infer<typeof TileLayoutSchema>;

/**
 * Structural validation the schema cannot express: the root exists, every child
 * reference resolves, nothing is reachable twice (no cycles, no shared subtrees),
 * ratios stay parallel to children, surfaces sit on leaves only, and a container
 * never tiles itself. Pass `containerId` to enforce the self-reference rule.
 *
 * Unreachable nodes are tolerated: they are inert garbage that the next
 * structural write prunes, and rejecting them would strand a live room.
 */
export function validateTileLayout(layout: TileLayout, containerId?: string): boolean {
  if (layout[ROOT_TILE_ID] === undefined) return false;

  for (const [id, node] of Object.entries(layout)) {
    if (node.id !== id) return false;
    if (node.dir === null) {
      if (node.children.length > 0 || node.ratios.length > 0) return false;
    } else {
      // Splits carry structure, never content; ops collapse a one-child split
      // back into a leaf, so live trees hold two or more children per split.
      if (node.children.length === 0) return false;
      if (node.children.length !== node.ratios.length) return false;
      if (node.surface !== null) return false;
    }
    if (
      containerId !== undefined &&
      node.surface !== null &&
      node.surface.kind === "pad" &&
      node.surface.padId === containerId
    ) {
      return false;
    }
  }

  const seen = new Set<string>([ROOT_TILE_ID]);
  const queue: string[] = [ROOT_TILE_ID];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) break;
    const node = layout[id];
    if (node === undefined) return false;
    for (const child of node.children) {
      if (layout[child] === undefined) return false;
      if (seen.has(child)) return false;
      seen.add(child);
      queue.push(child);
    }
  }
  return true;
}
