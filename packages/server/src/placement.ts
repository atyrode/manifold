import {
  censusSolo,
  resolvePlacement,
  type ContainerLayout,
  type PlaceRequest,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementItem,
  type PlacementLookup,
  type PlacementSurface,
  type RuntimeDeps,
  type SceneElement,
  type TileEdge,
  type TileLayout,
  type TileSurface,
} from "@manifold/protocol";
import { tileIdForSurface, tileLeafIds } from "@manifold/scene";
import type { Room, RoomManager } from "./room.ts";
import type { ServerStore } from "./stores.ts";

/**
 * THE placement executor. One entry point — `place(surface, destination)` — for every way
 * an item can land in a container, with legality decided entirely by the protocol's
 * declarations (`resolvePlacement`) and never by a branch in here.
 *
 * Three invariants make this the only placement path worth having:
 *
 *   1. The surface's CURRENT location is resolved from identity (`locate`), never taken
 *      from the request. A caller cannot lie about where an item was, so it cannot strand
 *      a placement or move a terminal it does not hold.
 *   2. Every composition-homed item lives in exactly one composition, always. A terminal is
 *      born into one and is only ever MOVED between them, so there is no unbound state to
 *      handle, no pool to fall back into, and no lifecycle flag to consult.
 *   3. A reference never outlives what it references. When a composition stops existing —
 *      absorbed by a merge, emptied by extraction, deleted outright — every portal onto it
 *      goes with it, which is why a dangling widget is not a state this server can reach.
 *
 * A refusal is a NAMED rule from the declarations, returned verbatim to the caller.
 * Operational impossibilities — a vanished session, a tree that rejects a write — travel
 * on the separate `failed` channel, because they are not statements about what composes.
 */

/** Container names clamp to `PadSchema`'s ceiling; a merge auto-names from its surfaces. */
const MAX_CONTAINER_NAME = 120;

/** Why a legal placement could not be carried out; never a statement about legality. */
export type PlaceFailure = "not_found" | "conflict";

/** The executor's answer: executed with its per-op result, refused by rule, or failed. */
export type PlaceOutcome =
  | { readonly status: "placed"; readonly result: PlaceResponse }
  | { readonly status: "denied"; readonly denial: PlacementDenial }
  | { readonly status: "failed"; readonly failure: PlaceFailure };

/**
 * The session-side seam. Placement mutates CONTAINERS, but a terminal's home, its fan-out
 * and its PTY belong to the broker — so the executor asks for exactly these five things
 * and owns everything else itself. This interface is the whole coupling between the two
 * modules, which is what makes splitting them along it worth doing.
 */
export interface SessionPlacementPort {
  /** Live session state; null when no such session exists. `padId` is its home composition. */
  placedSession(sessionId: string): { readonly padId: string } | null;
  /** A terminal's operator-visible label: its own name, else its machine's, else `fallback`. */
  terminalLabel(sessionId: string, fallback: string): string;
  /** Publishes a session's move from one composition to another. */
  rebindSession(sessionId: string, fromPadId: string, toPadId: string, placementId: string): void;
  /**
   * Kills and forgets a terminal whose last home leaf is gone. There is no pool for it to
   * fall into, so removing a terminal's only representation IS closing the terminal.
   */
  reapSession(sessionId: string): void;
  /** Kills and forgets every PTY homed in a container before its rows are purged. */
  dropPad(padId: string): void;
}

/** Every leaf holding a session, so moving the ITEM can reach all of its copies. */
function terminalLeafIds(layout: TileLayout | null, sessionId: string): string[] {
  if (layout === null) return [];
  const ids: string[] = [];
  for (const tileId of tileLeafIds(layout)) {
    const surface = layout[tileId]?.surface ?? null;
    if (surface !== null && surface.kind === "terminal" && surface.sessionId === sessionId) {
      ids.push(tileId);
    }
  }
  return ids;
}

/**
 * Where a surface is RIGHT NOW, resolved from identity — never from the request.
 *
 * The two halves are deliberately separate. `padId`/`addressed` describe the ONE
 * representation the gesture grabbed, and are null when the request named an item by
 * identity instead of pointing at a copy of it. `sessionId`/`homeId` describe where the
 * item LIVES, which is the same answer however it was addressed — and the reason a canvas
 * portal, a tile leaf, a sidebar row and a bare session id all reach one code path.
 */
interface SourceLocation {
  readonly padId: string | null;
  readonly layout: ContainerLayout | null;
  readonly addressed: string | null;
  readonly sessionId: string | null;
  readonly homeId: string | null;
}

const NO_SOURCE: SourceLocation = {
  padId: null,
  layout: null,
  addressed: null,
  sessionId: null,
  homeId: null,
};

export class PlaceExecutor {
  constructor(
    private readonly store: ServerStore,
    private readonly rooms: RoomManager,
    private readonly sessions: SessionPlacementPort,
    private readonly runtime: RuntimeDeps,
  ) {}

  /**
   * Resolves a placement and executes it. Legality is entirely the declarations' answer;
   * this method only decides HOW the named op is carried out.
   */
  place(request: PlaceRequest): PlaceOutcome {
    const { surface, destination } = request;
    const resolution = resolvePlacement(surface, destination, this.lookup());
    if (!resolution.ok) return { status: "denied", denial: resolution.denial };
    const source = this.locate(surface);
    if (source === "not_found") return { status: "failed", failure: "not_found" };

    switch (destination.kind) {
      case "canvas":
        switch (resolution.op) {
          case "portal":
            return this.executePortal(surface, resolution.item, destination, source);
          case "move_element":
            return this.executeMoveElement(surface, destination, source);
          case "extract":
            return this.executeExtract(destination, source);
          default:
            // Unreachable: `CANVAS_OPS` maps every item kind to one of the three above.
            return { status: "failed", failure: "conflict" };
        }
      case "tile":
        return this.executeAddTile(
          resolution.item,
          destination.padId,
          destination.targetTileId,
          destination.edge,
          source,
        );
      case "compose":
        return this.executeCompose(surface, resolution.item, destination, source);
      case "unplaced":
        return this.executeUnplace(surface, resolution.item, source);
      default: {
        const exhaustive: never = destination;
        return exhaustive;
      }
    }
  }

  /**
   * The state questions the algebra asks, answered from durable rows and live docs. The
   * browser answers the same ones from its props and its own documents, which is why a
   * drag preview can never disagree with the write that follows it.
   */
  private lookup(): PlacementLookup {
    return {
      padLayout: (padId) => this.store.getPad(padId)?.layout ?? null,
      terminalHome: (sessionId) => this.sessions.placedSession(sessionId)?.padId ?? null,
      elementItem: (padId, elementId): PlacementItem | null => {
        const element = this.rooms.get(padId)?.element(elementId) ?? null;
        if (element === null) return null;
        switch (element.type) {
          case "portal": {
            // A portal places the container it points at, so that container's discipline
            // decides the kind — and a portal onto a deleted container places nothing.
            const layout = this.store.getPad(element.containerId)?.layout ?? null;
            if (layout === null) return null;
            return {
              kind: layout === "canvas" ? "canvas-pad" : "view",
              containerId: element.containerId,
            };
          }
          case "text":
            return { kind: "text", containerId: null };
          case "draw":
            return { kind: "draw", containerId: null };
          default: {
            const exhaustive: never = element;
            return exhaustive;
          }
        }
      },
      soloOccupant: (padId) => this.soloOccupant(padId)?.item ?? null,
    };
  }

  /**
   * What a composition of ONE holds, with the session id when that item is a terminal. The
   * algebra only needs the classification; the executor also needs the session, and reading
   * the census twice for the two halves is how they would come apart.
   */
  private soloOccupant(
    padId: string,
  ): { readonly item: PlacementItem; readonly sessionId: string | null } | null {
    const room = this.rooms.get(padId);
    if (room === null) return null;
    const census = room.census();
    if (census.layout !== "tiled") return null;
    const solo = censusSolo(census);
    if (solo === null) return null;
    return {
      // A terminal's `containerId` is the composition it lives in: the two are one thing
      // addressed from opposite sides, and every op that moves it needs exactly that id.
      item: {
        kind: solo.kind,
        containerId: solo.kind === "terminal" ? padId : solo.containerId,
      },
      sessionId: solo.sessionId,
    };
  }

  /**
   * Identity, not assertion: a terminal is wherever its session says it is, and an
   * addressed element or leaf is wherever it actually lives. An id that names nothing is a
   * failure, so no request can quietly become a no-op.
   */
  private locate(surface: PlacementSurface): SourceLocation | "not_found" {
    switch (surface.kind) {
      case "terminal": {
        // `resolvePlacement` asks the lookup for a home, so a vanished session is already a
        // denial there; this catches the race where it vanished in between.
        const session = this.sessions.placedSession(surface.sessionId);
        if (session === null) return "not_found";
        return { ...NO_SOURCE, sessionId: surface.sessionId, homeId: session.padId };
      }
      case "pad": {
        // Naming a solo composition names the item inside it, which is what makes dragging
        // a sidebar row and dragging its canvas widget the same placement.
        const solo = this.soloOccupant(surface.padId);
        return {
          ...NO_SOURCE,
          sessionId: solo?.sessionId ?? null,
          homeId: solo?.sessionId === undefined || solo.sessionId === null ? null : surface.padId,
        };
      }
      case "element": {
        const element = this.rooms.get(surface.padId)?.element(surface.elementId) ?? null;
        if (element === null) return "not_found";
        const solo = element.type === "portal" ? this.soloOccupant(element.containerId) : null;
        const sessionId = solo?.sessionId ?? null;
        return {
          padId: surface.padId,
          layout: "canvas",
          addressed: surface.elementId,
          sessionId,
          homeId: sessionId === null || element.type !== "portal" ? null : element.containerId,
        };
      }
      case "tile": {
        const node = this.rooms.get(surface.containerId)?.tileLayout()?.[surface.tileId];
        if (node === undefined || node.dir !== null) return "not_found";
        const occupant = node.surface;
        const sessionId = occupant?.kind === "terminal" ? occupant.sessionId : null;
        return {
          padId: surface.containerId,
          layout: "tiled",
          addressed: surface.tileId,
          sessionId,
          homeId: sessionId === null ? null : surface.containerId,
        };
      }
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  }

  /** An idle room stops being resident once whatever was happening in it is done. */
  private afterLeaving(padId: string | null): void {
    if (padId !== null) this.rooms.evictIfIdle(padId);
  }

  /**
   * Every container that references `containerId`, from the census — which answers for pads
   * whose rooms are not resident, so a reference on a canvas nobody has open is not a
   * reference this server can miss.
   */
  private referrers(containerId: string): string[] {
    const pads: string[] = [];
    for (const census of this.rooms.censuses()) {
      if (census.references.includes(containerId)) pads.push(census.padId);
    }
    return pads;
  }

  /**
   * Removes every reference to a container. The container itself is untouched.
   *
   * A reference is a portal element on a canvas OR a `pad` leaf in a composition — both are
   * what `census.references` counts, and unplacing has to mean the same thing the census
   * means or the two describe different graphs. A composition left holding nothing by the
   * removal retires, exactly as it would if the item had been dragged out of it.
   */
  private removeReferences(containerId: string): number {
    let removed = 0;
    for (const padId of this.referrers(containerId)) {
      const room = this.rooms.get(padId);
      if (room === null) continue;
      removed += room.removePortalsTo(containerId);
      const layout = room.tileLayout();
      let leaves = 0;
      for (const leafId of layout === null ? [] : tileLeafIds(layout)) {
        const occupant = layout?.[leafId]?.surface ?? null;
        if (occupant === null || occupant.kind !== "pad" || occupant.padId !== containerId) {
          continue;
        }
        if (room.removeTileLeafById(leafId)) {
          removed += 1;
          leaves += 1;
        }
      }
      if (leaves > 0) this.deleteIfEmptied(padId);
      this.afterLeaving(padId);
    }
    return removed;
  }

  /**
   * Points every reference to `fromId` at `toId` instead. A merge absorbs an item into a
   * composition, and a canvas that was showing that item should keep showing it — repointing
   * preserves the element id and its geometry, so no collaborator's widget jumps or blinks
   * and no selection is lost.
   */
  private retargetReferences(fromId: string, toId: string): void {
    for (const padId of this.referrers(fromId)) {
      const room = this.rooms.get(padId);
      if (room === null) continue;
      for (const elementId of room.portalIdsTo(fromId)) room.repointPortal(elementId, toId);
      this.afterLeaving(padId);
    }
  }

  /**
   * Deletes a container and, first, every reference to it, so nothing is left pointing at
   * something that no longer exists. Any terminal still homed here goes with it: that is
   * what deleting the place an item lives means.
   *
   * Public because `DELETE /api/pads/:id` is the same operation. It used to do three of
   * these four steps itself and leave portals onto the deleted container behind — the one
   * step it missed is the one this cutover made load-bearing, since a canvas terminal IS a
   * portal now, and a route reimplementing most of a rule is how the rule comes apart.
   */
  deleteContainer(padId: string): void {
    this.removeReferences(padId);
    this.sessions.dropPad(padId);
    this.rooms.drop(padId);
    this.store.deletePad(padId);
  }

  /**
   * A composition that just lost its last item stops existing. Call this ONLY straight after
   * removing an occupant from it: a deliberately empty composition ("New composition", or
   * one whose tiles were never filled) holds nothing either, and it is the departure — not
   * the emptiness — that retires a container.
   */
  private deleteIfEmptied(padId: string): void {
    const pad = this.store.getPad(padId);
    if (pad === null || pad.layout !== "tiled") return;
    const room = this.rooms.get(padId);
    if (room === null || room.census().items.length > 0) return;
    this.deleteContainer(padId);
  }

  /** What a tileable item looks like as a leaf occupant; null when nothing is tileable. */
  private tileSurfaceFor(item: PlacementItem, source: SourceLocation): TileSurface | null {
    if (item.kind === "terminal") {
      return source.sessionId === null ? null : { kind: "terminal", sessionId: source.sessionId };
    }
    if (item.kind === "canvas-pad" && item.containerId !== null) {
      return { kind: "pad", padId: item.containerId };
    }
    if (item.kind === "text") {
      // A note is addressed as an element of the container holding it, and stored as the
      // element id the DESTINATION will hold it under — the ids are the same because the
      // element MOVES between documents rather than being copied.
      return source.addressed === null ? null : { kind: "text", elementId: source.addressed };
    }
    return null;
  }

  /**
   * The note behind a `text` surface, read before anything is written so a placement that
   * cannot be carried out mutates neither document. Null when the element is gone or was
   * never a note.
   */
  private noteAt(padId: string | null, elementId: string): SceneElement | null {
    if (padId === null) return null;
    const element = this.rooms.get(padId)?.element(elementId) ?? null;
    return element?.type === "text" ? element : null;
  }

  /**
   * Moves a note into the container that now holds its leaf. A composition OWNS its notes:
   * its own document stores the element, so the text stays collaborative through the same
   * room everyone in the composition is already joined to, with no second socket and no
   * cross-document reference to keep alive.
   */
  private adoptNote(source: SourceLocation, note: SceneElement, target: Room): void {
    if (source.padId !== null && source.addressed !== null) {
      this.rooms.get(source.padId)?.removeElementById(source.addressed);
    }
    target.adoptElement(note, note.x, note.y);
    this.afterLeaving(source.padId);
  }

  /** The label a merged composition borrows from one of the surfaces it was built from. */
  private surfaceLabel(item: PlacementItem, source: SourceLocation): string {
    if (item.kind === "terminal" && source.sessionId !== null) {
      return this.sessions.terminalLabel(source.sessionId, "terminal");
    }
    if (item.kind === "text") return "note";
    if (item.containerId !== null) return this.store.getPad(item.containerId)?.name ?? "canvas";
    return "surface";
  }

  /**
   * A container landing on a canvas becomes a portal onto it — a REFERENCE, never a copy,
   * which is why nothing is removed from wherever else it appears. This is also how a
   * TERMINAL lands on a canvas: the portal points at the composition it lives in, so the
   * op that used to be `bind` and the op that placed a container are now one op.
   *
   * An addressed portal MOVES instead: that is an existing reference changing seats.
   */
  private executePortal(
    surface: PlacementSurface,
    item: PlacementItem,
    destination: { readonly padId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    const containerId = item.containerId;
    if (containerId === null) return { status: "failed", failure: "conflict" };
    if (surface.kind === "element" && source.padId !== null) {
      const moved = this.moveElementPlacement(source.padId, surface.elementId, destination);
      return moved === "ok"
        ? { status: "placed", result: { op: "portal", elementId: surface.elementId } }
        : { status: "failed", failure: moved };
    }
    const room = this.rooms.get(destination.padId);
    if (room === null) return { status: "failed", failure: "not_found" };
    const elementId = room.placePortalElement(containerId, destination.x, destination.y);
    this.rooms.evictIfIdle(destination.padId);
    return { status: "placed", result: { op: "portal", elementId } };
  }

  /** A plain canvas item (text, ink) travelling to a canvas: reposition, or change canvas. */
  private executeMoveElement(
    surface: PlacementSurface,
    destination: { readonly padId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    if (surface.kind !== "element" || source.padId === null) {
      // Only an addressed element places text or ink: there is no other way to name one.
      return { status: "failed", failure: "conflict" };
    }
    const moved = this.moveElementPlacement(source.padId, surface.elementId, destination);
    return moved === "ok"
      ? { status: "placed", result: { op: "move_element", elementId: surface.elementId } }
      : { status: "failed", failure: moved };
  }

  /**
   * Moves one addressed canvas element to a canvas, keeping its id so collaborators'
   * references survive. Nothing about the item matters here — only that it IS a canvas
   * placement — which is why text, ink and portals all travel through this one path.
   */
  private moveElementPlacement(
    padId: string,
    elementId: string,
    destination: { readonly padId: string; readonly x: number; readonly y: number },
  ): "ok" | PlaceFailure {
    const source = this.rooms.get(padId);
    const target = this.rooms.get(destination.padId);
    if (source === null || target === null) return "not_found";
    if (padId === destination.padId) {
      return source.moveElement(elementId, destination.x, destination.y) ? "ok" : "not_found";
    }
    const element = source.element(elementId);
    if (element === null) return "not_found";
    source.removeElementById(elementId);
    target.adoptElement(element, destination.x, destination.y);
    this.rooms.evictIfIdle(padId);
    this.rooms.evictIfIdle(destination.padId);
    return "ok";
  }

  /**
   * Unplacing: every reference to the item goes, and the item stays exactly where it lives.
   * For a terminal that is its home composition — which IS the terminal while the home is
   * solo, and the composition it lives in once merged — and for a container it is the
   * container itself. Nothing is destroyed, which is the whole difference from the park it
   * replaced: there is no pool to move into because there is nowhere else to be.
   *
   * A gesture that grabbed ONE reference releases that one; naming the item by identity
   * releases all of them. Zero removed is a legal answer — it was already unplaced.
   */
  private executeUnplace(
    surface: PlacementSurface,
    item: PlacementItem,
    source: SourceLocation,
  ): PlaceOutcome {
    const containerId = item.containerId;
    if (containerId === null) return { status: "failed", failure: "conflict" };
    if (surface.kind === "element" && source.padId !== null && source.addressed !== null) {
      const room = this.rooms.get(source.padId);
      if (room === null) return { status: "failed", failure: "not_found" };
      const removed = room.removeElementById(source.addressed) ? 1 : 0;
      this.afterLeaving(source.padId);
      return { status: "placed", result: { op: "unplace", removed } };
    }
    return {
      status: "placed",
      result: { op: "unplace", removed: this.removeReferences(containerId) },
    };
  }

  /**
   * A tileable surface joining a composition. The leaf is written FIRST: a tree that
   * refuses the write leaves the source untouched, so a rejected placement mutates nothing —
   * which is also why a note is READ before the write and moved only after it.
   *
   * When the surface is a terminal from ANOTHER composition this is a MERGE. Its old home is
   * absorbed: the leaf moves, the session rebinds, every reference that pointed at the old
   * home is repointed here so the canvases showing that terminal keep showing it, the
   * reference the gesture consumed is removed, and the emptied home retires. A second leaf
   * for a terminal already living here is simply another copy of it.
   */
  private executeAddTile(
    item: PlacementItem,
    padId: string,
    targetTileId: string | null,
    edge: TileEdge | null,
    source: SourceLocation,
  ): PlaceOutcome {
    const view = this.rooms.get(padId);
    if (view === null) return { status: "failed", failure: "not_found" };
    const surface = this.tileSurfaceFor(item, source);
    if (surface === null) return { status: "failed", failure: "conflict" };
    const note = surface.kind === "text" ? this.noteAt(source.padId, surface.elementId) : null;
    if (surface.kind === "text" && note === null) {
      return { status: "failed", failure: "not_found" };
    }
    const tileId = view.placeTile(surface, targetTileId, edge);
    if (tileId === null) return { status: "failed", failure: "conflict" };
    if (surface.kind === "terminal" && source.homeId !== null && source.homeId !== padId) {
      this.absorbHome(surface.sessionId, source, padId, tileId);
    }
    if (note !== null) this.adoptNote(source, note, view);
    return { status: "placed", result: { op: "add_tile", tileId } };
  }

  /**
   * The merge itself: a terminal's old home hands it over to `toPadId` and retires. Shared
   * by the tile drop and the canvas merge, because absorbing a solo composition is one
   * operation however the gesture spelled it.
   */
  private absorbHome(
    sessionId: string,
    source: SourceLocation,
    toPadId: string,
    placementId: string,
  ): void {
    const homeId = source.homeId;
    if (homeId === null) return;
    const home = this.rooms.get(homeId);
    if (home !== null) {
      for (const leafId of terminalLeafIds(home.tileLayout(), sessionId)) {
        home.removeTileLeafById(leafId);
      }
    }
    this.sessions.rebindSession(sessionId, homeId, toPadId, placementId);
    // The reference the drag was holding is consumed by the drop; the rest follow the item.
    if (source.layout === "canvas" && source.padId !== null && source.addressed !== null) {
      this.rooms.get(source.padId)?.removeElementById(source.addressed);
      this.afterLeaving(source.padId);
    }
    this.retargetReferences(homeId, toPadId);
    this.deleteIfEmptied(homeId);
    this.afterLeaving(homeId);
  }

  /**
   * Composition on a canvas: a surface dropped onto a reference merges the two.
   *
   * Dropping onto a reference to a COMPOSITION is not a merge — the widget already is a
   * composition, so the surface joins it as a plain tile. That recursion goes back through
   * `place`, so "compositions merge, never nest" stays a declaration (`view` denies with
   * `not_solo`) rather than a branch here.
   *
   * Dropping onto a reference to a SOLO composition merges: one new composition is born
   * absorbing both items, the target's element is repointed at it keeping its exact
   * geometry, and both emptied homes retire. The newborn is named after what went into it.
   */
  private executeCompose(
    surface: PlacementSurface,
    item: PlacementItem,
    destination: {
      readonly padId: string;
      readonly targetElementId: string;
      readonly edge: TileEdge;
    },
    source: SourceLocation,
  ): PlaceOutcome {
    const room = this.rooms.get(destination.padId);
    if (room === null) return { status: "failed", failure: "not_found" };
    const target = room.element(destination.targetElementId);
    if (target === null) return { status: "failed", failure: "not_found" };
    // Only a REFERENCE can be composed onto. Text and ink hold no item to merge with, and a
    // canvas has no terminal element to birth a composition around any more.
    if (target.type !== "portal") return { status: "failed", failure: "conflict" };
    const targetHomeId = target.containerId;
    const targetSolo = this.soloOccupant(targetHomeId);
    if (targetSolo === null) {
      const added = this.place({
        surface,
        destination: {
          kind: "tile",
          padId: targetHomeId,
          targetTileId: null,
          edge: destination.edge,
        },
      });
      if (added.status !== "placed") return added;
      if (added.result.op !== "add_tile") return { status: "failed", failure: "conflict" };
      return {
        status: "placed",
        result: { op: "compose", viewId: targetHomeId, tileId: added.result.tileId },
      };
    }
    // Merging an item with itself is a degenerate identity, not a rule about kinds.
    if (item.containerId !== null && item.containerId === targetHomeId) {
      return { status: "failed", failure: "conflict" };
    }
    const targetSurface = this.tileSurfaceFor(targetSolo.item, {
      ...NO_SOURCE,
      padId: targetHomeId,
      layout: "tiled",
      sessionId: targetSolo.sessionId,
      homeId: targetSolo.sessionId === null ? null : targetHomeId,
    });
    const dragged = this.tileSurfaceFor(item, source);
    if (targetSurface === null || dragged === null) {
      return { status: "failed", failure: "conflict" };
    }
    const note = dragged.kind === "text" ? this.noteAt(source.padId, dragged.elementId) : null;
    if (dragged.kind === "text" && note === null) {
      return { status: "failed", failure: "not_found" };
    }

    const viewId = this.runtime.newId();
    const name = `${this.surfaceLabel(targetSolo.item, {
      ...NO_SOURCE,
      sessionId: targetSolo.sessionId,
      homeId: targetHomeId,
    })} + ${this.surfaceLabel(item, source)}`;
    this.store.createPad({
      id: viewId,
      name: name.slice(0, MAX_CONTAINER_NAME),
      createdAt: this.runtime.now(),
      layout: "tiled",
    });
    const view = this.rooms.get(viewId);
    const rootTileId = view?.placeTile(targetSurface, null, null) ?? null;
    const addedTileId =
      view === null || rootTileId === null
        ? null
        : view.placeTile(dragged, rootTileId, destination.edge);
    if (view === null || rootTileId === null || addedTileId === null) {
      // Nothing durable has moved yet, so the newborn row goes away with the failure.
      this.rooms.drop(viewId);
      this.store.deletePad(viewId);
      return { status: "failed", failure: "conflict" };
    }

    // The target's reference becomes a reference to the newborn IN PLACE, before its old
    // home retires — otherwise retiring the home would take this element with it.
    room.repointPortal(destination.targetElementId, viewId);
    if (targetSolo.sessionId !== null) {
      /*
        The target went in FIRST, filling the root — and the dragged surface then SPLIT that
        root, which moves the root's occupant to a fresh leaf id. So `rootTileId` names the
        split now, not the terminal, and the id published to the composition has to be read
        back from the tree rather than remembered from before the split.
       */
      const targetTileId = tileIdForSurface(view.tileLayout(), targetSurface) ?? rootTileId;
      this.absorbHome(
        targetSolo.sessionId,
        { ...NO_SOURCE, sessionId: targetSolo.sessionId, homeId: targetHomeId },
        viewId,
        targetTileId,
      );
    } else {
      this.moveNonTerminalLeaf(targetHomeId, view, viewId);
    }
    if (dragged.kind === "terminal") {
      this.absorbHome(dragged.sessionId, source, viewId, addedTileId);
    }
    // The note moves into the composition that now holds its leaf, exactly as it would for
    // a plain tile add: a merge is the same placement with a container born first.
    if (note !== null) this.adoptNote(source, note, view);
    this.rooms.evictIfIdle(destination.padId);
    return { status: "placed", result: { op: "compose", viewId, tileId: addedTileId } };
  }

  /**
   * Hands a solo composition's NON-terminal occupant over to the composition absorbing it:
   * an embedded canvas is a reference, so only the leaf moves, while a note's element has to
   * travel between documents the way any note does.
   */
  private moveNonTerminalLeaf(fromPadId: string, target: Room, toPadId: string): void {
    const from = this.rooms.get(fromPadId);
    if (from !== null) {
      const layout = from.tileLayout();
      for (const leafId of layout === null ? [] : tileLeafIds(layout)) {
        const occupant = layout?.[leafId]?.surface ?? null;
        if (occupant === null) continue;
        if (occupant.kind === "text") {
          const note = from.element(occupant.elementId);
          if (note !== null) {
            from.removeElementById(occupant.elementId);
            target.adoptElement(note, note.x, note.y);
          }
        }
        from.removeTileLeafById(leafId);
      }
    }
    this.retargetReferences(fromPadId, toPadId);
    this.deleteIfEmptied(fromPadId);
    this.afterLeaving(fromPadId);
  }

  /**
   * Extraction: a leaf leaves its composition and lands on a canvas.
   *
   * A terminal is RE-HOMED — a fresh solo composition is born for it and the canvas gets a
   * portal onto that — because a terminal always lives in a composition and the one it was
   * sharing is not it any more. When the source composition is already solo there is nothing
   * to re-home: that composition IS the item, so the drop simply authors a reference to it
   * and no id churns. A note travels as its own element; an embedded canvas as a reference.
   * A composition emptied by the extraction retires.
   */
  private executeExtract(
    destination: { readonly padId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    const containerId = source.padId;
    const tileId = source.addressed;
    if (containerId === null || tileId === null) {
      return { status: "failed", failure: "not_found" };
    }
    const view = this.rooms.get(containerId);
    const canvas = this.rooms.get(destination.padId);
    if (view === null || canvas === null) return { status: "failed", failure: "not_found" };
    const occupant = view.tileLayout()?.[tileId]?.surface ?? null;
    // An empty leaf holds no item: extracting it would author nothing, which is exactly the
    // silent no-op the algebra refuses to have.
    if (occupant === null) return { status: "failed", failure: "conflict" };
    const wasSolo = view.census().items.length === 1;

    if (occupant.kind === "terminal") {
      if (wasSolo) {
        const elementId = canvas.placePortalElement(containerId, destination.x, destination.y);
        this.rooms.evictIfIdle(destination.padId);
        return { status: "placed", result: { op: "extract", elementId } };
      }
      // The new home is built BEFORE the old leaf goes, so a tree that refuses the write
      // leaves the terminal exactly where it was rather than nowhere.
      const homeId = this.runtime.newId();
      this.store.createPad({
        id: homeId,
        name: this.sessions
          .terminalLabel(occupant.sessionId, "terminal")
          .slice(0, MAX_CONTAINER_NAME),
        createdAt: this.runtime.now(),
        layout: "tiled",
      });
      const home = this.rooms.get(homeId);
      const leafId = home?.placeTerminalTile(occupant.sessionId, null, null) ?? null;
      if (home === null || leafId === null) {
        this.rooms.drop(homeId);
        this.store.deletePad(homeId);
        return { status: "failed", failure: "conflict" };
      }
      if (!view.removeTileLeafById(tileId)) {
        this.rooms.drop(homeId);
        this.store.deletePad(homeId);
        return { status: "failed", failure: "conflict" };
      }
      this.sessions.rebindSession(occupant.sessionId, containerId, homeId, leafId);
      const elementId = canvas.placePortalElement(homeId, destination.x, destination.y);
      this.deleteIfEmptied(containerId);
      this.afterLeaving(containerId);
      this.rooms.evictIfIdle(destination.padId);
      return { status: "placed", result: { op: "extract", elementId } };
    }

    if (!view.removeTileLeafById(tileId)) return { status: "failed", failure: "conflict" };
    if (occupant.kind === "text") {
      const note = view.element(occupant.elementId);
      if (note === null || note.type !== "text") return { status: "failed", failure: "not_found" };
      view.removeElementById(occupant.elementId);
      canvas.adoptElement(note, destination.x, destination.y);
      this.deleteIfEmptied(containerId);
      this.afterLeaving(containerId);
      this.rooms.evictIfIdle(destination.padId);
      return { status: "placed", result: { op: "extract", elementId: occupant.elementId } };
    }
    const elementId = canvas.placePortalElement(occupant.padId, destination.x, destination.y);
    this.deleteIfEmptied(containerId);
    this.afterLeaving(containerId);
    this.rooms.evictIfIdle(destination.padId);
    return { status: "placed", result: { op: "extract", elementId } };
  }

  /**
   * Removes one leaf (`DELETE /api/pads/:id/tiles/:tileId`). Removal is NOT a placement:
   * nothing accepts "nowhere" as a destination for a LEAF, which is why the declarations
   * refuse `tile -> unplaced` — unplacing or moving its occupant addresses the occupant.
   *
   * Removing a terminal's LAST home leaf destroys the terminal. That is deliberate and it
   * is the only honest reading of the model: a terminal lives in exactly one composition,
   * there is no pool to fall back into, and the operator who closed its last tile closed the
   * terminal. A composition emptied this way retires with it.
   */
  removeTile(padId: string, tileId: string): "ok" | PlaceFailure {
    const pad = this.store.getPad(padId);
    if (pad === null) return "not_found";
    if (pad.layout !== "tiled") return "conflict";
    const room = this.rooms.get(padId);
    if (room === null) return "not_found";
    const node = room.tileLayout()?.[tileId];
    if (node === undefined) return "not_found";
    if (node.dir !== null) return "conflict";
    const occupant = node.surface;
    if (!room.removeTileLeafById(tileId)) return "conflict";
    if (
      occupant !== null &&
      occupant.kind === "terminal" &&
      !room.homesSession(occupant.sessionId)
    ) {
      this.sessions.reapSession(occupant.sessionId);
    }
    // A note's leaf IS its only placement, and a composition renders only its layout, so
    // leaving the element behind would be invisible garbage.
    if (occupant !== null && occupant.kind === "text") room.removeElementById(occupant.elementId);
    if (occupant !== null) this.deleteIfEmptied(padId);
    this.afterLeaving(padId);
    return "ok";
  }

  /**
   * Removes a terminal from the world. `DELETE /api/terminals/:id`, `terminal_kill` and a
   * titlebar close all land here, and all three mean the same thing: a DELIBERATE kill is
   * total and it is one step — every leaf its home holds for it, the session and its PTY,
   * and, when the terminal was the last thing its home held, the home itself along with
   * every portal onto that home, on every canvas, whether or not anybody has it open.
   *
   * This is `removeTile`'s rule addressed by IDENTITY rather than by one placement, which is
   * why closing a tile and killing from the sidebar are the same write instead of two writes
   * that have to agree. Deleting a terminal's home is deliberately NOT the door: that would
   * make "close this terminal" mean "delete a container", and a composed terminal's home is
   * shared with whatever else lives there.
   *
   * Status is not consulted. Killing a terminal that already exited on its own sweeps it
   * identically — dismissing a dead terminal is the same verb as killing a live one, not a
   * second lookalike path.
   */
  killTerminal(sessionId: string): "ok" | "not_found" {
    const placed = this.sessions.placedSession(sessionId);
    if (placed === null) return "not_found";
    const room = this.rooms.get(placed.padId);
    if (room === null) {
      // A home whose row is already gone cannot be asked what it still holds; the session
      // has nowhere left to live either way, so it dies rather than becoming an orphan.
      this.sessions.reapSession(sessionId);
      return "ok";
    }
    for (const tileId of terminalLeafIds(room.tileLayout(), sessionId)) {
      room.removeTileLeafById(tileId);
    }
    // The row goes before the home is judged: `deleteIfEmptied` asks what the container
    // holds NOW, and a composition still listing the terminal it just lost would survive.
    this.sessions.reapSession(sessionId);
    this.deleteIfEmptied(placed.padId);
    this.afterLeaving(placed.padId);
    return "ok";
  }

  /**
   * A terminal's home, seeded at birth: the row plus the one leaf that makes it solo. The
   * broker calls this the instant a PTY lands, which is what `homed: "eager"` means — there
   * is no window in which a live terminal has nowhere to live.
   *
   * The id is minted by the CALLER, before the PTY, because the agent's token and the
   * terminal's own environment are scoped to it — the row is what has to wait for a PTY that
   * might never arrive, not the identity. Returns the home's leaf id.
   */
  createHome(homeId: string, sessionId: string, name: string): string | null {
    this.store.createPad({
      id: homeId,
      name: name.slice(0, MAX_CONTAINER_NAME),
      createdAt: this.runtime.now(),
      layout: "tiled",
    });
    const leafId = this.rooms.get(homeId)?.placeTerminalTile(sessionId, null, null) ?? null;
    if (leafId === null) {
      this.rooms.drop(homeId);
      this.store.deletePad(homeId);
      return null;
    }
    return leafId;
  }

  /**
   * A terminal's home retires with the terminal. Called when a session is forgotten, so an
   * exited terminal the operator dismissed leaves neither a row in the index nor a widget
   * pointing at one.
   */
  retireHome(padId: string): void {
    const pad = this.store.getPad(padId);
    if (pad === null || pad.layout !== "tiled") return;
    const room = this.rooms.get(padId);
    if (room === null || room.census().items.length > 0) return;
    this.deleteContainer(padId);
  }
}
