import {
  ROOT_TILE_ID,
  type CarriedItem,
  type CarryAim,
  type PlacementDestination,
  type PlacementRef,
  type TileLayout,
} from "@manifold/protocol";
import { useCallback, useMemo, useRef, type RefObject } from "react";

/** The one label vocabulary, as this module's fallback for a chip whose producer sent no name. */
import { ITEM_NOUNS } from "./item-noun.ts";

const CHIP_NOUNS: Readonly<Record<string, string>> = ITEM_NOUNS;
import { carriedItem, carriedPlacement, type ItemEnvelope } from "./item-envelope.ts";
import type { ItemDropAssessment } from "./item-drop.ts";
import {
  ROOT_RING_PX,
  layoutRevision,
  resolveTileAim,
  tileDestinationFor,
  tileProspect,
  type PaneShift,
  type TileAim,
  type UnitRect,
} from "./tile-geometry.ts";
import { asTileTree, resolveSnapTarget } from "./tile-snap.ts";

/**
 * THE tile drop pipeline: aim, preview, commit — one implementation shared by both drag
 * transports (HTML5 drags and React Flow node drags), both host renderers (the
 * fullscreen route and a canvas portal) and both PRODUCERS (this browser's pointer and
 * a collaborator's carry frames).
 *
 * IDENTITY IS DATA, NEVER A BRANCH. A local pointer is normalised into the WIRE form —
 * `CarryAim`, exactly what peers receive — before anything is computed from it, and that
 * wire form is what {@link previewFor} consumes. The local user is their own spectator:
 * the preview they see is computed from precisely the bytes their collaborators get, so
 * a wire form that cannot express something breaks visibly here instead of only for
 * them. The one legitimate local-vs-remote decision is ARBITRATION — which producer's
 * intent wins a ref — and it lives in the overlay, above this module. Nothing below
 * it may ask whose intent it renders.
 *
 * The interface between a transport and targeting is A CLIENT-SPACE POINT, never a DOM
 * event target: a React Flow node drag fires no `dragover` at all, so a DOM-targeted
 * design would serve one transport and need a parallel geometric path for the other —
 * the two-implementation trap the old code was in. `aimAt` measures the tile AREA
 * element, so chrome like a portal's name strip is excluded by construction, and
 * converts everything into unit space where the same numbers hold at any canvas zoom
 * and under the portal's `transform: scale()`.
 */

/** One axis pair of fractions: divider thickness, ring thickness. */
interface AxisFractions {
  readonly x: number;
  readonly y: number;
}

/** Everything a tile area's measurement yields, taken once per pointer frame. */
export interface AreaFractions {
  /** One divider's thickness as a fraction of each axis. */
  readonly dividers: AxisFractions;
  /** The root ring's thickness as a fraction of each axis. */
  readonly ring: AxisFractions;
  /** The on-screen box these fractions came from, so a pointer converts against it. */
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * THE unit-space conversion for a tile area. Every consumer — the local resolver, the
 * preview builder, the F9 zone debugger — measures through this one function, because
 * the rule is subtle in exactly the way that drifts: dividers live in the tree's own
 * LAYOUT px (`offsetWidth` ignores transforms, and the divider is subtracted from a
 * layout box), while the ring is a constant ON-SCREEN thickness and therefore comes
 * from the transformed rect. A portal drawn at `scale(0.5)` inside a zoomed canvas gets
 * both right without either caller knowing it is scaled.
 *
 * Null on a degenerate box. There is deliberately no fallback extent: a `?? 1` turns
 * `dividerPx / 1` into a divider that eats the whole axis, which paints an all-zero
 * slot rect over the composition instead of painting nothing.
 */
export function areaUnits(area: HTMLElement, dividerPx: number): AreaFractions | null {
  const rect = area.getBoundingClientRect();
  const layoutWidth = area.offsetWidth;
  const layoutHeight = area.offsetHeight;
  if (rect.width <= 0 || rect.height <= 0 || layoutWidth <= 0 || layoutHeight <= 0) return null;
  return {
    dividers: { x: dividerPx / layoutWidth, y: dividerPx / layoutHeight },
    ring: { x: ROOT_RING_PX / rect.width, y: ROOT_RING_PX / rect.height },
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
}

/** What a HOST knows: its tree, its identity, its measurement, its placement lookup. */
export interface TileDropContext {
  readonly layout: TileLayout | null;
  /**
   * `layoutRevision(layout)`, or null when there is no tree to hash. Held on the context
   * rather than derived per call because the producer stamps one on every pointer frame
   * and the tree only changes on a document update.
   */
  readonly revision: number | null;
  readonly containerId: string;
  /** Non-null when this area is a canvas portal: which canvas, which element. */
  readonly portal: { readonly containerId: string; readonly elementId: string } | null;
  readonly units: AreaFractions;
  readonly assess: (
    destination: PlacementDestination,
    carried?: CarriedItem,
  ) => ItemDropAssessment | null;
}

export interface TileDropHost {
  readonly areaRef: RefObject<HTMLElement | null>;
  readonly layout: TileLayout | null;
  readonly containerId: string;
  /** Non-null when this area is a canvas portal: which canvas, which element. */
  readonly portal: { readonly containerId: string; readonly elementId: string } | null;
  /** One divider's thickness in the tree's own layout px (`TileTreeClasses.dividerPx`). */
  readonly dividerPx: number;
  readonly assess: (
    destination: PlacementDestination,
    carried?: CarriedItem,
  ) => ItemDropAssessment | null;
  /**
   * True when a canvas ELEMENT carry holds a seat to trade (#62): a portal showing a
   * terminal is a window onto its solo home, whose leaf the displaced occupant can
   * move into. Only a canvas host can answer (it owns the element table); the route
   * omits it, and every element carry stays seatless there.
   */
  readonly elementSeat?: (containerId: string, elementId: string) => boolean;
  /**
   * What this host calls the item in hand — the first link of the chip's label chain,
   * and the local counterpart of the name a peer's frame carries. Both ends of the
   * chain are the same, so a viewer never reads a species name where the dragger sees
   * a bare icon.
   */
  readonly describeCarry?: (envelope: ItemEnvelope) => string | null;
}

/** The slot's mark and name: one vocabulary, whoever produced the aim. */
export interface TileDropChip {
  /** The ITEM kind in hand — a floor species or a contributed element type. */
  readonly kind: string;
  /** Never null: the chain ends in the species name, so every slot is captioned. */
  readonly label: string;
}

/**
 * Everything one armed aim means over one tree. Built ONLY by {@link previewFor}, from
 * a wire aim, so no field can be fabricated on one path and derived on another.
 */
export interface TileDropState {
  /** The aim in its WIRE-COMPLETE form: what peers receive, verbatim. */
  readonly aim: CarryAim;
  /** Where the carried ref would land, in unit space. */
  readonly slot: UnitRect;
  /** The second rect a swap trades with, else null. */
  readonly partner: UnitRect | null;
  /** How the real panes glide and squeeze into their prospective places. */
  readonly shifts: readonly PaneShift[];
  readonly assessment: ItemDropAssessment | null;
  readonly destination: PlacementDestination;
  /** What is being carried, as the placement algebra sees it. */
  readonly ref: PlacementRef | null;
  readonly chip: TileDropChip | null;
  /** The leaf this carry is vacating in THIS container, else null. */
  readonly carriedTileId: string | null;
}

/**
 * Aim equality, over the wire fields and all of them. The old copy of this comparison
 * inside the store's signal equality omitted `edge` and `between`, which was correct
 * only because a `tile` destination happens to carry both — a `compose` destination
 * drops `between`, so the omission made two different aims compare equal and the
 * overlay skip a repaint. One function, used by every consumer.
 *
 * `revision` counts too, and for the same reason: two aims identical but for the tree
 * they were resolved against are the same TARGET and a different CLAIM, and it is the
 * claim a viewer either believes or withholds.
 */
export function sameAim(a: CarryAim, b: CarryAim): boolean {
  return (
    a.containerId === b.containerId &&
    a.tileId === b.tileId &&
    a.edge === b.edge &&
    a.action === b.action &&
    (a.between === true) === (b.between === true) &&
    a.revision === b.revision
  );
}

/**
 * A kernel aim, normalised for the wire. This is the ONE place a local resolution
 * becomes shared data, and it happens immediately — before any preview is computed —
 * so the producer paints from the same bytes it sends. `depth` does not survive: the
 * wire has no field for it, and a state that carried it would be a value only one
 * producer could ever fill honestly.
 *
 * `revision` is the opposite case and is why it IS on the wire: it is the one thing a
 * receiver cannot derive, because deriving it from its OWN tree is exactly the question
 * being asked. Null when this host has no tree to hash (a portal still opening), which
 * ships no stamp and means "unverifiable" rather than "mismatched".
 */
export function wireCarryAim(containerId: string, aim: TileAim, revision: number | null): CarryAim {
  return {
    containerId,
    tileId: aim.tileId,
    edge: aim.edge,
    action: aim.action,
    ...(aim.between === true ? { between: true } : {}),
    ...(revision === null ? {} : { revision }),
  };
}

/**
 * The aimed tile's depth in a tree, or null when the tree does not hold it.
 *
 * Depth is the kernel's own bookkeeping and is not on the wire, so a receiver derives
 * it from ITS tree rather than being handed a number the sender happened to compute.
 * Both sides walk the same tree and reach the same answer; when they do not, the tile
 * id itself is already stale and the preview is refused here for that reason.
 */
function tileDepth(layout: TileLayout, tileId: string): number | null {
  let frontier: readonly string[] = [ROOT_TILE_ID];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (id === tileId) return depth;
      const node = layout[id];
      if (node === undefined) continue;
      next.push(...node.children);
    }
    frontier = next;
  }
  return null;
}

/**
 * THE state constructor: the only code in this package that may build a
 * {@link TileDropState}.
 *
 * It takes the wire aim and the carried ref — never a pointer, never a DOM node,
 * never a producer flag — so the local pointer path and a peer's carry frame produce
 * byte-identical states for identical inputs. That is the whole design: divergence
 * between what a dragger sees and what their collaborators see is not a bug class here,
 * it is unrepresentable.
 *
 * A container whose tree this renderer cannot see (a portal whose socket has not
 * delivered yet) is modelled as the one-leaf tree it visibly is — a single pane showing
 * that container — via `asTileTree`, so the canvas door previews the real root split
 * the server will author rather than a bare painted half.
 *
 * SKEW IS REFUSED, NOT PAPERED OVER. When the aim carries the producer's layout revision
 * and this renderer has a tree of its own to compare it against, a mismatch means the two
 * trees are not the same tree and the tile id means something else here: no preview, the
 * same nothing a vanished tile already yields. One Yjs update later the stamps agree and
 * the preview appears. Either side missing a stamp — a portal still opening, a producer
 * that resolved through the canvas door with no tree — is UNVERIFIABLE rather than
 * mismatched, and is trusted exactly as it was before the stamp existed.
 */
export function previewFor(
  context: TileDropContext,
  wire: CarryAim,
  carried: CarriedItem | null,
  label: string | null,
): TileDropState | null {
  if (wire.containerId !== context.containerId) return null;
  if (
    wire.revision !== undefined &&
    context.revision !== null &&
    wire.revision !== context.revision
  ) {
    return null;
  }
  const layout =
    context.layout ?? asTileTree({ kind: "container", containerId: context.containerId });
  const depth = tileDepth(layout, wire.tileId);
  if (depth === null) return null;
  const aim: TileAim = {
    tileId: wire.tileId,
    edge: wire.edge,
    action: wire.action,
    depth,
    ...(wire.between === true ? { between: true } : {}),
  };
  const root = layout[ROOT_TILE_ID];
  const rootIsLeaf = root === undefined || root.dir === null;
  const destination = tileDestinationFor(aim, {
    containerId: context.containerId,
    portal: context.portal,
    rootIsLeaf,
  });
  const ref = carried?.ref ?? null;
  const carriedTileId =
    ref !== null && ref.kind === "tile" && ref.containerId === context.containerId
      ? ref.tileId
      : null;
  const prospect = tileProspect(layout, aim, carriedTileId, context.units.dividers);
  if (prospect === null) return null;
  return {
    aim: wire,
    slot: prospect.slot,
    partner: prospect.partner,
    shifts: prospect.shifts,
    // The carry judges itself by the item it names, whoever produced it — the local
    // pointer and a peer's frame reach this call with the same two fields.
    assessment: context.assess(destination, carried ?? undefined),
    destination,
    ref,
    chip:
      carried === null
        ? null
        : {
            kind: carried.item.kind,
            label: label ?? CHIP_NOUNS[carried.item.kind] ?? "item",
          },
    carriedTileId,
  };
}

/** The local resolver's memory: its memo, and the zone it is holding (hysteresis). */
interface LocalCache {
  readonly layout: TileLayout | null;
  readonly envelope: ItemEnvelope | null;
  readonly state: TileDropState;
}

/** The remote producer's memo, so an unchanged peer aim does not rebuild the prospect. */
interface RemoteCache {
  readonly layout: TileLayout | null;
  readonly carried: CarriedItem;
  readonly label: string | null;
  readonly state: TileDropState;
}

export interface TileDropPipeline {
  /** The host that created this pipeline, for the overlay that renders it. */
  readonly host: TileDropHost;
  /**
   * The LOCAL producer. Client px in, state out — resolved, normalised to the wire
   * form, then built by {@link previewFor} like anyone else's aim. Safe to call per
   * pointer frame from either transport, and ONE instance per host is the rule: the
   * memo is also the hysteresis state, so a second instance would hold a second zone.
   */
  readonly aimAt: (clientX: number, clientY: number) => TileDropState | null;
  /**
   * The REMOTE producer: a peer's wire aim and its wire CARRY through the very same
   * builder. The carry arrives resolved, so a watcher never asks its own index what the
   * dragger is holding.
   */
  readonly previewOf: (
    wire: CarryAim,
    carried: CarriedItem,
    label: string | null,
  ) => TileDropState | null;
  readonly clear: () => void;
}

export function useTileDrop(host: TileDropHost): TileDropPipeline {
  const localRef = useRef<LocalCache | null>(null);
  const remoteRef = useRef<RemoteCache | null>(null);
  const { areaRef, layout, containerId, portal, dividerPx, assess, elementSeat, describeCarry } =
    host;

  /**
   * The tree's content hash, recomputed only when the tree object changes. Every pointer
   * frame stamps it onto the wire aim, so a per-frame walk of the layout would be the one
   * allocation in this path that scales with the composition's size.
   */
  const revision = useMemo(() => (layout === null ? null : layoutRevision(layout)), [layout]);

  const contextFor = useCallback(
    (units: AreaFractions): TileDropContext => ({
      layout,
      revision,
      containerId,
      portal,
      units,
      assess,
    }),
    [assess, containerId, layout, portal, revision],
  );

  const aimAt = useCallback(
    (clientX: number, clientY: number): TileDropState | null => {
      const area = areaRef.current;
      if (area === null) {
        localRef.current = null;
        return null;
      }
      const units = areaUnits(area, dividerPx);
      if (units === null) {
        localRef.current = null;
        return null;
      }
      const point = {
        x: (clientX - units.rect.left) / units.rect.width,
        y: (clientY - units.rect.top) / units.rect.height,
      };

      const envelope = carriedItem();
      const root = layout === null ? undefined : layout[ROOT_TILE_ID];
      const rootIsLeaf = root === undefined || root.dir === null;
      const canvasDoor = portal !== null && rootIsLeaf;
      const cached = localRef.current;
      // The zone already held, so a pointer near a boundary — or an eye chasing the
      // FLIP's moving pixels — does not flutter between aims (hysteresis).
      const held =
        cached !== null && cached.layout === layout && cached.envelope === envelope
          ? cached.state.aim
          : null;

      let aim: TileAim | null = null;
      if (canvasDoor && portal !== null) {
        /*
          A canvas-hosted SOLO container keeps the canvas door's center semantics:
          element↔element geometry swap, and dissolve-to-nearest-edge for a seatless
          carry. Resolving through `resolveSnapTarget` here is what guarantees no
          `replace` cue is ever painted where the server would answer with the old element
          behavior. The ZONE and the ACTION are producer-only knowledge and are shipped as
          the decision; the PROSPECT they imply is computed by the shared builder from the
          tree, so a viewer paints this door's outcome, not a bare half.

          A LAYOUT-LESS PORTAL TAKES THIS DOOR TOO, RATIFIED (audit 4.6). `rootIsLeaf` is
          true when the tree is merely absent — a portal whose socket has not delivered
          yet, or a depth-3 card the canvas does not open — and the operator-visible
          consequence is real and worth naming: if that container is in fact MULTI-tile,
          `assess` answers `not_solo` and the target paints DENIED for the width of one
          socket round trip, then silently becomes legal when the tree lands. That is the
          better of the two available refusals. The alternative the audit proposed —
          answering null while the tree is unknown — makes the portal claim nothing, so
          `preventDefault` never fires and the release falls through to the CANVAS
          underneath: the item lands as a new element beside the portal instead of inside
          it, which is silent, wrong, and does not self-correct. A denial that resolves
          itself in one round trip is a worse cue and a better outcome, and only a
          renderer that could resolve the real tree could do better than either.
        */
        const snap = resolveSnapTarget({ x: 0, y: 0, width: 1, height: 1 }, point, {
          occupied: true,
          canSwap: envelope?.kind === "element" && envelope.containerId === portal.containerId,
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
                (elementSeat?.(envelope.containerId, envelope.elementId) ?? false)),
          },
          units.dividers,
          units.ring,
          // The held zone travels as the wire fields the kernel actually reads; the
          // wire's `between` is optional-or-undefined and the kernel's is optional, so
          // the conversion is explicit rather than a cast.
          held === null
            ? null
            : {
                tileId: held.tileId,
                edge: held.edge,
                ...(held.between === true ? { between: true } : {}),
              },
        );
      }
      if (aim === null) {
        localRef.current = null;
        return null;
      }

      // Normalised the moment it exists: everything downstream reads the wire form.
      const wire = wireCarryAim(containerId, aim, revision);
      // A pointer sliding inside one zone allocates nothing: same aim, same state.
      if (held !== null && cached !== null && sameAim(held, wire)) return cached.state;

      const state = previewFor(
        contextFor(units),
        wire,
        carriedPlacement(),
        envelope === null ? null : (describeCarry?.(envelope) ?? null),
      );
      if (state === null) {
        localRef.current = null;
        return null;
      }
      localRef.current = { layout, envelope, state };
      return state;
    },
    [
      areaRef,
      containerId,
      contextFor,
      describeCarry,
      dividerPx,
      elementSeat,
      layout,
      portal,
      revision,
    ],
  );

  const previewOf = useCallback(
    (wire: CarryAim, carried: CarriedItem, label: string | null): TileDropState | null => {
      const area = areaRef.current;
      if (area === null) return null;
      const units = areaUnits(area, dividerPx);
      if (units === null) return null;
      const cached = remoteRef.current;
      if (
        cached !== null &&
        cached.layout === layout &&
        cached.carried === carried &&
        cached.label === label &&
        sameAim(cached.state.aim, wire)
      ) {
        return cached.state;
      }
      const state = previewFor(contextFor(units), wire, carried, label);
      remoteRef.current = state === null ? null : { layout, carried, label, state };
      return state;
    },
    [areaRef, contextFor, dividerPx, layout],
  );

  const clear = useCallback((): void => {
    localRef.current = null;
    remoteRef.current = null;
  }, []);

  return useMemo(() => ({ host, aimAt, previewOf, clear }), [aimAt, clear, host, previewOf]);
}
