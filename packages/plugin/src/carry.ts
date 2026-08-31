import type {
  CarriedItem,
  Carry,
  CarryAim,
  Gesture,
  PlacementItem,
  PlacementSurface,
  TileSurface,
} from "@manifold/protocol";
import { envelopeSurface, type ItemEnvelope } from "./item-envelope.ts";
import type { GestureOverride } from "./presence/index.ts";

/**
 * The dynamic half of the placement algebra, as pure functions.
 *
 * Grabbing anything by its chrome is ONE carry: the source container mutates live, the
 * carried representation renders under the cursor, and the gesture streams to
 * collaborators over the room's existing gesture channel. This module owns the two
 * translations that would otherwise be re-invented per renderer and per element type —
 * a local grab into a wire frame, and a peer's frames into the ghosts a renderer paints.
 *
 * Everything here is coordinate-space agnostic. A canvas streams flow coordinates and a
 * composition streams tile-area fractions, exactly as each already does for cursors; a
 * carry frame is read back in the space it was written in, so neither renderer has to
 * know the other exists.
 */

/** Where a carried representation renders, in the room's own coordinate space. */
export interface CarryPoint {
  readonly x: number;
  readonly y: number;
  /** The source box, when the carried object still has one here (a canvas element). */
  readonly width?: number;
  readonly height?: number;
}

/** One live grab: what is held, what it IS, what to call it, and its streaming id. */
export interface CarrySource {
  /**
   * The gesture's key. It is the carried object's PLACEMENT id wherever it has one, so
   * a viewer's override lands on the very thing being moved — which is what makes the
   * source container mutate live rather than needing a second gesture beside the carry.
   */
  readonly id: string;
  readonly envelope: ItemEnvelope;
  /**
   * The item the envelope names, resolved where the grab happened. It rides every frame
   * because a watcher cannot derive it: classifying a surface takes a census of
   * containers, terminals and solo occupancy, and a watcher's copy of that census is a
   * poll behind the drag that just started.
   */
  readonly item: PlacementItem;
  readonly label: string | null;
}

/**
 * The placement id an envelope carries under, or null when the item is unplaced (a
 * pooled terminal) or named by identity alone (a container dragged from the sidebar).
 * A null gets a synthetic id from the caller: a carry always has a key, because a
 * carry with no key could not be ended.
 */
export function carryPlacementId(envelope: ItemEnvelope): string | null {
  switch (envelope.kind) {
    case "element":
      return envelope.elementId;
    case "tile":
      return envelope.tileId;
    case "terminal":
    case "canvas":
    case "composition":
      return null;
    default: {
      const exhaustive: never = envelope;
      return exhaustive;
    }
  }
}

/** The wire payload of one grab; `aim` is the resolved drop target while one is armed. */
export function carryPayload(source: CarrySource, aim?: CarryAim): Carry {
  return {
    surface: envelopeSurface(source.envelope),
    item: source.item,
    ...(source.label === null ? {} : { label: source.label }),
    ...(aim === undefined ? {} : { aim }),
  };
}

/**
 * One frame. Geometry says where the carried representation is right now: for an object
 * still drawn in its source container that is the object's own live box, so the frame
 * doubles as the move it used to send; for everything else it is the pointer, which is
 * where the ghost belongs. `aim` rides along while the producer has a drop target
 * armed, so every viewer can re-derive the SAME split preview from the same kernel —
 * multiplayer is the design, and a local drag is just the case where the producer is
 * your own pointer. An agent driving a carry through the SDK paints identically.
 */
export function carryFrame(
  source: CarrySource,
  at: CarryPoint,
  phase: Gesture["phase"],
  aim?: CarryAim,
): Gesture {
  return {
    kind: "carry",
    phase,
    elementId: source.id,
    x: at.x,
    y: at.y,
    ...(at.width === undefined ? {} : { width: at.width }),
    ...(at.height === undefined ? {} : { height: at.height }),
    carry: carryPayload(source, aim),
  };
}

/**
 * Fallback names for a carry whose sender sent none. The MARK a ghost wears is not here:
 * a renderer looks it up from the surface kind (`SurfaceIcon`), so the object's picture
 * comes from the one icon vocabulary instead of travelling as a glyph over the wire.
 *
 * Exported because it is the LAST link of the one label chain: a ghost, a slot chip and
 * a peer's caption all end here when nothing better is known, so a local preview can
 * never show a bare icon where a viewer of the same drag reads a species name.
 */
export const SURFACE_NAMES: Record<PlacementSurface["kind"], string> = {
  terminal: "terminal",
  pad: "view",
  tile: "tile",
  element: "item",
};

/** Past this a note's first line stops being a name and starts being the note. */
const NOTE_TITLE_LENGTH = 40;

/**
 * A note has no name, so it borrows its first line — the only handle a note has.
 * Null while the note is empty, which is what makes a caller fall back to "note".
 */
export function noteTitle(text: string): string | null {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length <= NOTE_TITLE_LENGTH
    ? firstLine
    : `${firstLine.slice(0, NOTE_TITLE_LENGTH - 1)}…`;
}

/**
 * The three questions naming a tiled surface asks of a host's own documents. Every
 * host can answer all three — a route from its room, a canvas widget from its widget
 * socket plus the container index the canvas holds — so no host owns a private switch.
 */
export interface SurfaceLabelLookups {
  readonly sessionName: (sessionId: string) => string | null;
  readonly padName: (padId: string) => string | null;
  /** The note's raw text; the first-line rule is applied here, once, for everyone. */
  readonly noteText: (elementId: string) => string | null;
}

/**
 * What a tiled surface is CALLED. One switch for the whole application: the fullscreen
 * route and a canvas widget differ only in the documents they read, never in which
 * species they can name — which is what stopped a displaced canvas or note from
 * captioning on the route and captioning nothing inside a widget.
 */
export function surfaceDisplayLabel(
  surface: TileSurface | null,
  lookups: SurfaceLabelLookups,
): string | null {
  switch (surface?.kind) {
    case "terminal":
      return lookups.sessionName(surface.sessionId);
    case "pad":
      return lookups.padName(surface.padId);
    case "text": {
      const text = lookups.noteText(surface.elementId);
      return text === null ? null : noteTitle(text);
    }
    case "panel":
      // A panel's human title lives in the composition, which this module deliberately
      // cannot see: labelling reads DOCUMENTS, and a panel is not in one. The panel id is
      // fully qualified, so it is a truthful name rather than a placeholder.
      return surface.panelId;
    case undefined:
      return null;
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}

/** What a collaborator paints under a carrier's pointer. */
export interface CarryGhost {
  readonly key: string;
  readonly principalId: string;
  readonly kind: PlacementSurface["kind"];
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The ghosts one renderer owes its viewers, out of the same override map that drives
 * remote geometry. `rendersSurface` is the renderer's single question: does this room
 * already draw the carried object? When it does, the override IS the representation —
 * the element moves under the peer's pointer — and a second chip on top of it would be
 * the same object drawn twice. When it does not (a pooled terminal, a tile lifted off a
 * widget, a container dragged in from the sidebar), the ghost is the only thing there is.
 */
export function carryGhosts(
  overrides: Iterable<GestureOverride>,
  rendersSurface: (surface: PlacementSurface, override: GestureOverride) => boolean,
): readonly CarryGhost[] {
  const ghosts: CarryGhost[] = [];
  for (const override of overrides) {
    const carry = override.carry;
    if (override.kind !== "carry" || carry === undefined) continue;
    if (rendersSurface(carry.surface, override)) continue;
    ghosts.push({
      key: `${override.connId}:${override.elementId}`,
      principalId: override.principalId,
      kind: carry.surface.kind,
      label: carry.label ?? SURFACE_NAMES[carry.surface.kind],
      x: override.current.x,
      y: override.current.y,
    });
  }
  return ghosts;
}

/**
 * A peer's carry that is currently AIMING at a tile target: everything a preview
 * overlay needs to re-derive the producer's exact split preview from the shared
 * geometry kernel.
 */
export interface RemoteTileCarry extends CarriedItem {
  readonly connId: string;
  readonly principalId: string;
  readonly aim: CarryAim;
  readonly label: string;
  readonly updatedAt: number;
}

/**
 * The freshest live aim PER CONTAINER, keyed by the container each aim addresses.
 *
 * Freshest-wins is right for one tile area and wrong for a room: a canvas draws many
 * widgets, so a single winner across every override let peer A aiming at widget 1 and
 * peer B at widget 2 mask each other — the two flipped on every frame as their receipt
 * timestamps alternated and the loser's widget went blank. Two carries over the SAME
 * area still contradict each other, and there the freshest is the honest answer.
 */
export function remoteTileCarries(
  overrides: Iterable<GestureOverride>,
): ReadonlyMap<string, RemoteTileCarry> {
  const latest = new Map<string, RemoteTileCarry>();
  for (const override of overrides) {
    const carry = override.carry;
    if (override.kind !== "carry" || carry === undefined || carry.aim === undefined) continue;
    const held = latest.get(carry.aim.containerId);
    if (held !== undefined && override.updatedAt <= held.updatedAt) continue;
    latest.set(carry.aim.containerId, {
      connId: override.connId,
      principalId: override.principalId,
      aim: carry.aim,
      surface: carry.surface,
      item: carry.item,
      label: carry.label ?? SURFACE_NAMES[carry.surface.kind],
      updatedAt: override.updatedAt,
    });
  }
  return latest;
}
