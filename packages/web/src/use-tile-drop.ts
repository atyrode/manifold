import {
  ROOT_TILE_ID,
  type PlacementDestination,
  type TileEdge,
  type TileLayout,
  type TileNode,
} from "@manifold/protocol";
import { sameSurface, withTileSlot, withoutTileLeaf } from "@manifold/scene";
import { useCallback, useMemo, useRef, type RefObject } from "react";

import type { ItemDropAssessment } from "./item-drop.ts";
import { carriedItem, type ItemEnvelope } from "./item-envelope.ts";
import {
  ROOT_RING_PX,
  paneShifts,
  resolveTileAim,
  tileDestinationFor,
  tileRects,
  type PaneShift,
  type TileAim,
  type UnitRect,
} from "./tile-geometry.ts";
import { resolveSnapTarget } from "./tile-snap.ts";

/**
 * THE tile drop pipeline: aim, preview, commit — one implementation shared by both drag
 * transports (HTML5 drags and React Flow node drags) and both host renderers (the
 * fullscreen route and a canvas widget).
 *
 * The interface between a transport and targeting is A CLIENT-SPACE POINT, never a DOM
 * event target: a React Flow node drag fires no `dragover` at all, so a DOM-targeted
 * design would serve one transport and need a parallel geometric path for the other —
 * the two-implementation trap the old code was in. `aimAt` measures the tile AREA
 * element (`getBoundingClientRect`), so chrome like a widget's name strip is excluded
 * by construction, and converts everything into unit space where the same numbers hold
 * at any canvas zoom and under the widget's `transform: scale()`.
 */
export interface TileDropHost {
  readonly areaRef: RefObject<HTMLElement | null>;
  readonly layout: TileLayout | null;
  readonly containerId: string;
  /** Non-null when this area is a canvas widget: which canvas, which element. */
  readonly widget: { readonly padId: string; readonly elementId: string } | null;
  /** One divider's thickness in the tree's own layout px (`TileTreeClasses.dividerPx`). */
  readonly dividerPx: number;
  readonly assess: (destination: PlacementDestination) => ItemDropAssessment | null;
}

export interface TileDropState {
  readonly aim: TileAim;
  /** Where the carried surface would land, in unit space. */
  readonly slot: UnitRect;
  /** The second rect a swap trades with, else null. */
  readonly partner: UnitRect | null;
  /** How the real panes glide and squeeze into their prospective places. */
  readonly shifts: readonly PaneShift[];
  readonly assessment: ItemDropAssessment | null;
  readonly destination: PlacementDestination;
  /** What is being carried, for the slot's glyph and label. */
  readonly envelope: ItemEnvelope | null;
}

interface AimCache {
  readonly layout: TileLayout | null;
  readonly envelope: ItemEnvelope | null;
  readonly state: TileDropState;
}

function sameAim(a: TileAim, b: TileAim): boolean {
  return a.tileId === b.tileId && a.edge === b.edge && a.action === b.action;
}

/**
 * The aimed tile after the carried leaf's departure reshaped the tree. Pruning can
 * retire the aimed id (a collapse promotes a survivor into its parent's — even the
 * root's — id), so the tile is re-found by WHAT IT SHOWS; null when it is gone.
 */
function remapAimedTile(
  layout: TileLayout,
  pruned: TileLayout,
  aimedTileId: string,
): string | null {
  if (pruned[aimedTileId] !== undefined) return aimedTileId;
  const aimed = layout[aimedTileId];
  if (aimed === undefined || aimed.dir !== null || aimed.surface === null) return null;
  for (const node of Object.values(pruned)) {
    if (node.dir !== null || node.surface === null) continue;
    if (sameSurface(node.surface, aimed.surface)) return node.id;
  }
  return null;
}

/** The half of the unit square a zone claims; the whole square for `center`. */
function unitZoneRect(edge: TileEdge): UnitRect {
  switch (edge) {
    case "left":
      return { x: 0, y: 0, width: 0.5, height: 1 };
    case "right":
      return { x: 0.5, y: 0, width: 0.5, height: 1 };
    case "top":
      return { x: 0, y: 0, width: 1, height: 0.5 };
    case "bottom":
      return { x: 0, y: 0.5, width: 1, height: 0.5 };
    case "center":
      return { x: 0, y: 0, width: 1, height: 1 };
    default: {
      const exhaustive: never = edge;
      return exhaustive;
    }
  }
}

export function useTileDrop(host: TileDropHost): {
  /** Client px in, state out. Safe to call per pointer frame from either transport. */
  readonly aimAt: (clientX: number, clientY: number) => TileDropState | null;
  readonly state: TileDropState | null;
  readonly clear: () => void;
} {
  const cacheRef = useRef<AimCache | null>(null);
  const { areaRef, layout, containerId, widget, dividerPx, assess } = host;

  const aimAt = useCallback(
    (clientX: number, clientY: number): TileDropState | null => {
      const area = areaRef.current;
      if (area === null) return null;
      const bounds = area.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      const point = {
        x: (clientX - bounds.left) / bounds.width,
        y: (clientY - bounds.top) / bounds.height,
      };
      // Dividers live in the tree's own LAYOUT px (offsetWidth ignores transforms), the
      // ring in DEVICE px (the transformed rect): a constant on-screen grab thickness,
      // constant divider subtraction, both as fractions of the same area.
      const layoutWidth = area.offsetWidth > 0 ? area.offsetWidth : bounds.width;
      const layoutHeight = area.offsetHeight > 0 ? area.offsetHeight : bounds.height;
      const dividers = { x: dividerPx / layoutWidth, y: dividerPx / layoutHeight };
      const ring = { x: ROOT_RING_PX / bounds.width, y: ROOT_RING_PX / bounds.height };

      const envelope = carriedItem();
      const root: TileNode | undefined = layout === null ? undefined : layout[ROOT_TILE_ID];
      const rootIsLeaf = root === undefined || root.dir === null;
      const canvasDoor = widget !== null && rootIsLeaf;
      let aim: TileAim | null = null;
      if (canvasDoor && widget !== null) {
        /*
          A canvas-hosted SOLO container — and a widget whose layout this canvas cannot
          see (a nested card, or one still opening) — keeps the canvas door's center
          semantics: element↔element geometry swap, and dissolve-to-nearest-edge for a
          seatless carry. Resolving through `resolveSnapTarget` here is what guarantees
          no `replace` cue is ever painted where the server would answer with the old
          element behavior.
        */
        const snap = resolveSnapTarget({ x: 0, y: 0, width: 1, height: 1 }, point, {
          occupied: true,
          canSwap: envelope?.kind === "element" && envelope.padId === widget.padId,
        });
        aim =
          snap === null
            ? null
            : { tileId: ROOT_TILE_ID, edge: snap.zone, action: snap.action, depth: 0 };
      } else if (layout !== null && root !== undefined) {
        aim = resolveTileAim(
          layout,
          point,
          {
            carriedTileId:
              envelope?.kind === "tile" && envelope.containerId === containerId
                ? envelope.tileId
                : null,
            holdsTileSeat: envelope?.kind === "tile",
          },
          dividers,
          ring,
        );
      }
      if (aim === null) {
        cacheRef.current = null;
        return null;
      }

      // A pointer sliding inside one zone allocates nothing: same aim, same state.
      const cached = cacheRef.current;
      if (
        cached !== null &&
        cached.layout === layout &&
        cached.envelope === envelope &&
        sameAim(cached.state.aim, aim)
      ) {
        return cached.state;
      }

      const destination = tileDestinationFor(aim, { containerId, widget, rootIsLeaf });
      const assessment = assess(destination);
      const carriedTileId =
        envelope?.kind === "tile" && envelope.containerId === containerId ? envelope.tileId : null;

      let slot: UnitRect | null = null;
      let partner: UnitRect | null = null;
      let shifts: readonly PaneShift[] = [];
      if (canvasDoor || layout === null) {
        // The canvas door has no tree to reshape: the slot is the half the surface
        // would take (the whole area for the element exchange), and nothing glides.
        slot = unitZoneRect(aim.edge);
      } else if (aim.edge === "center") {
        // No structural change: the slot is the target leaf itself, and for a swap the
        // partner is the seat the carry came from — both drawn where they already are.
        const rects = tileRects(layout, dividers);
        slot = rects.get(aim.tileId) ?? null;
        partner =
          aim.action === "swap" && carriedTileId !== null
            ? (rects.get(carriedTileId) ?? null)
            : null;
      } else {
        /*
          A carry that is a leaf of THIS container first leaves it, because the server
          removes the origin too — and removal can collapse the origin's parent split
          and reshape its siblings. Without the prune, dragging a tile to another edge
          of its own composition would preview no sibling reflow and then jump on
          release. The COMMIT still sends the unpruned aim id: the server writes the
          landing leaf against the live tree first and prunes afterwards, so preview
          and commit agree on the resulting SHAPE, which is all a viewer can see.
        */
        const pruned =
          carriedTileId !== null && layout[carriedTileId] !== undefined
            ? (withoutTileLeaf(layout, carriedTileId) ?? layout)
            : layout;
        const remapped = remapAimedTile(layout, pruned, aim.tileId);
        if (remapped === null) {
          cacheRef.current = null;
          return null;
        }
        const slotted = withTileSlot(pruned, remapped, aim.edge);
        if (slotted === null) {
          cacheRef.current = null;
          return null;
        }
        slot = tileRects(slotted.layout, dividers).get(slotted.slotId) ?? null;
        shifts = paneShifts(layout, slotted.layout, dividers);
      }
      if (slot === null) {
        cacheRef.current = null;
        return null;
      }

      const state: TileDropState = {
        aim,
        slot,
        partner,
        shifts,
        assessment,
        destination,
        envelope,
      };
      cacheRef.current = { layout, envelope, state };
      return state;
    },
    [areaRef, assess, containerId, dividerPx, layout, widget],
  );

  const clear = useCallback((): void => {
    cacheRef.current = null;
  }, []);

  return useMemo(
    () => ({
      aimAt,
      clear,
      get state(): TileDropState | null {
        return cacheRef.current?.state ?? null;
      },
    }),
    [aimAt, clear],
  );
}
