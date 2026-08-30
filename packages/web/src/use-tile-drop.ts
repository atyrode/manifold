import {
  ROOT_TILE_ID,
  type PlacementDestination,
  type TileEdge,
  type TileLayout,
  type TileNode,
} from "@manifold/protocol";
import { useCallback, useMemo, useRef, type RefObject } from "react";

import type { ItemDropAssessment } from "./item-drop.ts";
import { carriedItem, type ItemEnvelope } from "./item-envelope.ts";
import {
  ROOT_RING_PX,
  resolveTileAim,
  tileDestinationFor,
  tileProspect,
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
  /**
   * True when a canvas ELEMENT carry holds a seat to trade (#62): a portal showing a
   * terminal is a window onto its solo home, whose leaf the displaced occupant can
   * move into. Only a canvas host can answer (it owns the element table); the route
   * omits it, and every element carry stays seatless there.
   */
  readonly elementSeat?: (padId: string, elementId: string) => boolean;
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
  return (
    a.tileId === b.tileId &&
    a.edge === b.edge &&
    a.action === b.action &&
    (a.between === true) === (b.between === true)
  );
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
  const { areaRef, layout, containerId, widget, dividerPx, assess, elementSeat } = host;

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
            holdsTileSeat:
              envelope?.kind === "tile" ||
              (envelope?.kind === "element" &&
                (elementSeat?.(envelope.padId, envelope.elementId) ?? false)),
          },
          dividers,
          ring,
          // The zone already held, so a pointer near a boundary — or an eye chasing
          // the FLIP's moving pixels — does not flutter between aims (hysteresis).
          cacheRef.current !== null &&
            cacheRef.current.layout === layout &&
            cacheRef.current.envelope === envelope
            ? cacheRef.current.state.aim
            : null,
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
      } else {
        // THE shared prospect: the same computation a viewer runs on this drag's
        // carry frames, so what this pointer previews is what every renderer paints.
        const prospect = tileProspect(layout, aim, carriedTileId, dividers);
        if (prospect === null) {
          cacheRef.current = null;
          return null;
        }
        slot = prospect.slot;
        partner = prospect.partner;
        shifts = prospect.shifts;
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
    [areaRef, assess, containerId, dividerPx, elementSeat, layout, widget],
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
