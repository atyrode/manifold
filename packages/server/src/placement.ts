import {
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
import { tileLeafIds } from "@manifold/scene";
import type { Room, RoomManager } from "./room.ts";
import type { ServerStore } from "./stores.ts";

/**
 * THE placement executor. One entry point — `place(surface, destination)` — for every way
 * an item can land in a container, with legality decided entirely by the protocol's
 * declarations (`resolvePlacement`) and never by a branch in here.
 *
 * Two invariants make this the only placement path worth having:
 *
 *   1. The surface's CURRENT location is resolved from identity (`locate`), never taken
 *      from the request. A caller cannot lie about where an item was, so it cannot strand
 *      a placement or unbind a session it does not hold.
 *   2. Execution is always the same two beats: uniform source cleanup (canvas element
 *      removal / tile leaf removal / pool no-op), then destination placement.
 *
 * A refusal is a NAMED rule from the declarations, returned verbatim to the caller.
 * Operational impossibilities — a vanished session, a tree that rejects a write — travel
 * on the separate `failed` channel, because they are not statements about what composes.
 */

/** Container names clamp to `PadSchema`'s ceiling; composition auto-names from surfaces. */
const MAX_CONTAINER_NAME = 120;

/** Why a legal placement could not be carried out; never a statement about legality. */
export type PlaceFailure = "not_found" | "conflict";

/** The executor's answer: executed with its per-op result, refused by rule, or failed. */
export type PlaceOutcome =
  | { readonly status: "placed"; readonly result: PlaceResponse }
  | { readonly status: "denied"; readonly denial: PlacementDenial }
  | { readonly status: "failed"; readonly failure: PlaceFailure };

/**
 * The session-side seam. Placement mutates CONTAINERS, but a terminal's binding, its
 * fan-out and its PTY belong to the broker — so the executor asks for exactly these six
 * things and owns everything else itself. This interface is the whole coupling between the
 * two modules, which is what makes splitting them along it worth doing.
 */
export interface SessionPlacementPort {
  /** Live placement-relevant session state; null when no such session exists. */
  placedSession(sessionId: string): { readonly padId: string | null } | null;
  /** A terminal's operator-visible label: its own name, else its machine's, else `fallback`. */
  terminalLabel(sessionId: string, fallback: string): string;
  /** Publishes a session's move between containers, or in from the pool. */
  rebindSession(
    sessionId: string,
    fromPadId: string | null,
    toPadId: string,
    placementId: string,
  ): void;
  /** Unbinds a session into the workspace pool; its placement is already gone. */
  releaseSessionToPool(sessionId: string, fromPadId: string, placementId: string | null): void;
  /** Reorders a parked session inside the workspace pool. */
  movePooled(sessionId: string, index: number): "ok" | "not_found" | "conflict";
  /** Kills and forgets every PTY bound to a container before its rows are purged. */
  dropPad(padId: string): void;
}

/** Every leaf holding a session, so releasing the ITEM can reach all of its copies. */
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

/** Where a surface is RIGHT NOW, resolved from identity — never from the request. */
interface SourceLocation {
  /** The container holding it; null when nothing does (a pooled terminal, or a reference). */
  readonly padId: string | null;
  readonly layout: ContainerLayout | null;
  /**
   * The placements this request ADDRESSED. An `element` or `tile` surface names exactly
   * one, because it addresses one copy; an identity surface names every placement the item
   * has in `padId`, because addressing the ITEM addresses the item. A container surface
   * names none: placing a container is a reference, so its representations stay put.
   */
  readonly addressed: readonly string[];
  /**
   * Every placement of `sessionId` in `padId`. A session is bound to ONE container, so a
   * move that changes containers has to take all of them — a mirror left behind would
   * point at a session that now lives somewhere else.
   */
  readonly sessionPlacements: readonly string[];
  /** The session a terminal surface (however addressed) resolves to; null otherwise. */
  readonly sessionId: string | null;
}

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
          case "bind":
            return this.executeBind(destination, source);
          case "portal":
            return this.executePortal(surface, resolution.item, destination, source);
          case "move_element":
            return this.executeMoveElement(surface, destination, source);
          case "extract":
            return this.executeExtract(destination, source);
          default:
            // Unreachable: `CANVAS_OPS` maps every item kind to one of the four above.
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
      case "pool":
        return this.executePark(destination.index, source);
      default: {
        const exhaustive: never = destination;
        return exhaustive;
      }
    }
  }

  /**
   * The two state questions the algebra asks, answered from durable rows and live docs.
   * The browser answers the same two from its props and its own document, which is why a
   * drag preview can never disagree with the write that follows it.
   */
  private lookup(): PlacementLookup {
    return {
      padLayout: (padId) => this.store.getPad(padId)?.layout ?? null,
      elementItem: (padId, elementId): PlacementItem | null => {
        const element = this.rooms.get(padId)?.element(elementId) ?? null;
        if (element === null) return null;
        switch (element.type) {
          case "terminal":
            return { kind: "terminal", containerId: null };
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
        // `resolvePlacement` asks the lookup nothing about a session — a terminal is a
        // terminal — so the executor is where a vanished one has to be caught.
        const session = this.sessions.placedSession(surface.sessionId);
        if (session === null) return "not_found";
        const placements = this.sessionPlacementsIn(session.padId, surface.sessionId);
        if (placements === "not_found") return "not_found";
        return {
          padId: session.padId,
          layout: placements.layout,
          addressed: placements.ids,
          sessionPlacements: placements.ids,
          sessionId: surface.sessionId,
        };
      }
      case "element": {
        const element = this.rooms.get(surface.padId)?.element(surface.elementId) ?? null;
        if (element === null) return "not_found";
        const sessionId = element.type === "terminal" ? element.sessionId : null;
        const placements =
          sessionId === null ? null : this.sessionPlacementsIn(surface.padId, sessionId);
        return {
          padId: surface.padId,
          layout: "canvas",
          addressed: [surface.elementId],
          sessionPlacements:
            placements === null || placements === "not_found" ? [] : placements.ids,
          sessionId,
        };
      }
      case "tile": {
        const node = this.rooms.get(surface.containerId)?.tileLayout()?.[surface.tileId];
        if (node === undefined || node.dir !== null) return "not_found";
        const occupant = node.surface;
        const sessionId = occupant?.kind === "terminal" ? occupant.sessionId : null;
        const placements =
          sessionId === null ? null : this.sessionPlacementsIn(surface.containerId, sessionId);
        return {
          padId: surface.containerId,
          layout: "tiled",
          addressed: [surface.tileId],
          sessionPlacements:
            placements === null || placements === "not_found" ? [] : placements.ids,
          sessionId,
        };
      }
      case "pad":
        // A container is placed BY REFERENCE — the resolution's `item.containerId` already
        // says which container it is — so there is no source placement to clean up.
        return { padId: null, layout: null, addressed: [], sessionPlacements: [], sessionId: null };
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  }

  /** Every placement a session holds in one container, with that container's discipline. */
  private sessionPlacementsIn(
    padId: string | null,
    sessionId: string,
  ): { readonly layout: ContainerLayout | null; readonly ids: readonly string[] } | "not_found" {
    if (padId === null) return { layout: null, ids: [] };
    const layout = this.store.getPad(padId)?.layout ?? null;
    const room = this.rooms.get(padId);
    if (layout === null || room === null) return "not_found";
    return {
      layout,
      ids:
        layout === "tiled"
          ? terminalLeafIds(room.tileLayout(), sessionId)
          : room.elementIdsForSession(sessionId),
    };
  }

  /**
   * Uniform source cleanup: the named placements stop existing, whatever kind of container
   * held them. `scope` is the whole difference between releasing one copy and releasing the
   * item — a park takes the copy it was handed, a move between containers takes them all.
   */
  private release(source: SourceLocation, scope: "addressed" | "session"): void {
    const padId = source.padId;
    if (padId === null) return;
    const room = this.rooms.get(padId);
    if (room === null) return;
    const ids = scope === "session" ? source.sessionPlacements : source.addressed;
    for (const placementId of ids) {
      if (source.layout === "tiled") {
        room.removeTileLeafById(placementId);
      } else {
        room.removeElementById(placementId);
      }
    }
  }

  /**
   * What a container does once an item has walked out of it: an idle room stops being
   * resident. It deliberately does NOT pop bubbles — a container dissolves when its last
   * OCCUPANT leaves (the room-empty hook) or when a tile is extracted from it, and
   * broadening that to every departure would pop a container out from under somebody who
   * is only rearranging it.
   */
  private afterLeaving(padId: string | null): void {
    if (padId !== null) this.rooms.evictIfIdle(padId);
  }

  /**
   * The one pooling rule: a session whose container no longer references it anywhere is
   * unbound and joins the workspace pool. A surviving mirror keeps it bound.
   */
  private releaseIfUnreferenced(
    sessionId: string,
    padId: string,
    placementId: string | null,
  ): void {
    const room = this.rooms.get(padId);
    if (room !== null && !room.referencesSession(sessionId)) {
      this.sessions.releaseSessionToPool(sessionId, padId, placementId);
    }
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
      const elementId = source.addressed[0];
      return elementId === undefined ? null : { kind: "text", elementId };
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
    this.release(source, "addressed");
    target.adoptElement(note, note.x, note.y);
    this.afterLeaving(source.padId);
  }

  /** The label a composed view borrows from one of the surfaces it was built from. */
  private surfaceLabel(item: PlacementItem, source: SourceLocation): string {
    if (item.kind === "terminal" && source.sessionId !== null) {
      return this.sessions.terminalLabel(source.sessionId, "terminal");
    }
    if (item.kind === "text") return "note";
    if (item.containerId !== null) return this.store.getPad(item.containerId)?.name ?? "canvas";
    return "surface";
  }

  /**
   * A terminal landing on a canvas. The element is authored server-side exactly as the
   * pre-algebra bind authored it, so the client sends no scene update and the response
   * carries the placement it can render at once. (A terminal BORN on a canvas stays
   * client-authored through `terminal_open`: that correlation-token path is a different
   * verb and keeps its own parity.)
   */
  private executeBind(
    destination: { readonly padId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    const sessionId = source.sessionId;
    if (sessionId === null) return { status: "failed", failure: "not_found" };
    const room = this.rooms.get(destination.padId);
    if (room === null) return { status: "failed", failure: "not_found" };

    // Already on this canvas: the placement REPOSITIONS instead of being released and
    // re-authored, so dragging inside one canvas never remounts anybody's terminal.
    const addressed = source.addressed[0];
    if (
      source.padId === destination.padId &&
      source.layout === "canvas" &&
      addressed !== undefined
    ) {
      return room.moveElement(addressed, destination.x, destination.y)
        ? { status: "placed", result: { op: "bind", elementId: addressed } }
        : { status: "failed", failure: "not_found" };
    }

    this.release(source, "session");
    const elementId = room.placeTerminalElement(sessionId, destination.x, destination.y);
    this.sessions.rebindSession(sessionId, source.padId, destination.padId, elementId);
    if (source.padId !== destination.padId) this.afterLeaving(source.padId);
    this.rooms.evictIfIdle(destination.padId);
    return { status: "placed", result: { op: "bind", elementId } };
  }

  /**
   * A container landing on a canvas becomes a portal onto it — a REFERENCE, never a copy,
   * which is why nothing is removed from wherever else it appears. An addressed portal
   * element moves instead: that is an existing representation changing seats.
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
   * Releasing a terminal into the pool. The ADDRESSED placements go, and the session is
   * unbound only once nothing in its container references it any more — a mirror left
   * behind keeps it bound. A pooled terminal placed into the pool is idempotent, which is
   * what makes a repeated drop harmless rather than an error.
   */
  private executePark(index: number | undefined, source: SourceLocation): PlaceOutcome {
    const sessionId = source.sessionId;
    if (sessionId === null) return { status: "failed", failure: "not_found" };
    const fromPadId = source.padId;
    if (fromPadId !== null) {
      this.release(source, "addressed");
      this.releaseIfUnreferenced(sessionId, fromPadId, source.addressed[0] ?? null);
      this.afterLeaving(fromPadId);
    }
    if (index !== undefined) this.sessions.movePooled(sessionId, index);
    return { status: "placed", result: { op: "park" } };
  }

  /**
   * A tileable surface joining a tiled container. The leaf is written FIRST: a tree that
   * refuses the write leaves the source untouched, so a rejected placement mutates nothing
   * — which is also why a note is READ before the write and moved only after it.
   * A terminal arriving from another container then moves — release, rebind — while a
   * second leaf for a terminal already living here is simply another copy of it.
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
    if (surface.kind === "terminal" && source.padId !== padId) {
      this.release(source, "session");
      this.sessions.rebindSession(surface.sessionId, source.padId, padId, tileId);
      this.afterLeaving(source.padId);
    }
    if (note !== null) this.adoptNote(source, note, view);
    this.hardenIfComposed(padId, view);
    return { status: "placed", result: { op: "add_tile", tileId } };
  }

  /**
   * Composition: a surface dropped onto a canvas terminal births a view around it. The
   * target element becomes a portal keeping its exact geometry, the target's session
   * becomes the root leaf, and the dropped surface lands beside it per `edge`. Composing IS
   * the claim, so the view is durable from birth; it keeps its return address only so
   * extraction can still collapse it back onto this canvas.
   *
   * Dropping onto a PORTAL is not a composition — the widget already is a view, so the
   * surface joins it as a plain tile. That recursion goes back through `place`, so "views
   * never nest" stays a declaration (`view` is not `tileable`) rather than a branch here.
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
    if (target.type === "portal") {
      const added = this.place({
        surface,
        destination: {
          kind: "tile",
          padId: target.containerId,
          targetTileId: null,
          edge: destination.edge,
        },
      });
      if (added.status !== "placed") return added;
      if (added.result.op !== "add_tile") return { status: "failed", failure: "conflict" };
      return {
        status: "placed",
        result: { op: "compose", viewId: target.containerId, tileId: added.result.tileId },
      };
    }
    if (target.type !== "terminal") return { status: "failed", failure: "conflict" };
    if (this.sessions.placedSession(target.sessionId) === null) {
      return { status: "failed", failure: "not_found" };
    }
    // Composing an item with itself is a degenerate identity, not a rule about kinds.
    if (source.sessionId !== null && source.sessionId === target.sessionId) {
      return { status: "failed", failure: "conflict" };
    }
    const tiled = this.tileSurfaceFor(item, source);
    if (tiled === null) return { status: "failed", failure: "conflict" };
    const note = tiled.kind === "text" ? this.noteAt(source.padId, tiled.elementId) : null;
    if (tiled.kind === "text" && note === null) {
      return { status: "failed", failure: "not_found" };
    }

    const viewId = this.runtime.newId();
    const name = `${this.sessions.terminalLabel(target.sessionId, "terminal")} + ${this.surfaceLabel(item, source)}`;
    this.store.createPad(
      {
        id: viewId,
        name: name.slice(0, MAX_CONTAINER_NAME),
        createdAt: this.runtime.now(),
        layout: "tiled",
        transient: false,
      },
      destination.padId,
    );
    const view = this.rooms.get(viewId);
    const rootTileId = view?.placeTerminalTile(target.sessionId, null, null) ?? null;
    const addedTileId =
      view === null || rootTileId === null
        ? null
        : view.placeTile(tiled, rootTileId, destination.edge);
    if (view === null || rootTileId === null || addedTileId === null) {
      // Nothing durable happened yet, so the newborn row goes away with the failure.
      this.rooms.drop(viewId);
      this.store.deletePad(viewId);
      return { status: "failed", failure: "conflict" };
    }

    room.swapElementToPortal(destination.targetElementId, viewId);
    this.sessions.rebindSession(target.sessionId, destination.padId, viewId, rootTileId);
    if (tiled.kind === "terminal") {
      this.release(source, "session");
      this.sessions.rebindSession(tiled.sessionId, source.padId, viewId, addedTileId);
      if (source.padId !== destination.padId) this.afterLeaving(source.padId);
    }
    // The note moves into the composition that now holds its leaf, exactly as it would
    // for a plain tile add: composition is the same placement with a container born first.
    if (note !== null) this.adoptNote(source, note, view);
    this.rooms.evictIfIdle(destination.padId);
    return { status: "placed", result: { op: "compose", viewId, tileId: addedTileId } };
  }

  /**
   * Extraction: a leaf leaves its container and its occupant lands on a canvas as a plain
   * element — a terminal element for a session, a portal for an embedded canvas, the note's
   * own element for a note (it moves documents, keeping its id and its text). When one leaf
   * is left the bubble rule runs, which is how decomposing a two-tile view collapses it
   * instead of stranding a single-widget container.
   */
  private executeExtract(
    destination: { readonly padId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    const containerId = source.padId;
    const tileId = source.addressed[0];
    if (containerId === null || tileId === undefined) {
      return { status: "failed", failure: "not_found" };
    }
    const view = this.rooms.get(containerId);
    const canvas = this.rooms.get(destination.padId);
    if (view === null || canvas === null) return { status: "failed", failure: "not_found" };
    const occupant = view.tileLayout()?.[tileId]?.surface ?? null;
    // An empty leaf holds no item: extracting it would author nothing, which is exactly
    // the silent no-op the algebra refuses to have.
    if (occupant === null) return { status: "failed", failure: "conflict" };
    if (!view.removeTileLeafById(tileId)) return { status: "failed", failure: "conflict" };

    // Decomposition is the one placement that pops a bubble on the spot: the leftover
    // single-widget view is exactly what the Phase 3b relaxation exists to collapse.
    if (occupant.kind === "terminal") {
      const elementId = canvas.placeTerminalElement(
        occupant.sessionId,
        destination.x,
        destination.y,
      );
      this.sessions.rebindSession(occupant.sessionId, containerId, destination.padId, elementId);
      this.dissolveIfBubble(containerId);
      this.afterLeaving(containerId);
      this.rooms.evictIfIdle(destination.padId);
      return { status: "placed", result: { op: "extract", elementId } };
    }
    if (occupant.kind === "text") {
      const note = view.element(occupant.elementId);
      if (note === null || note.type !== "text") return { status: "failed", failure: "not_found" };
      view.removeElementById(occupant.elementId);
      canvas.adoptElement(note, destination.x, destination.y);
      this.dissolveIfBubble(containerId);
      this.afterLeaving(containerId);
      this.rooms.evictIfIdle(destination.padId);
      return { status: "placed", result: { op: "extract", elementId: occupant.elementId } };
    }
    const elementId = canvas.placePortalElement(occupant.padId, destination.x, destination.y);
    this.dissolveIfBubble(containerId);
    this.afterLeaving(containerId);
    this.rooms.evictIfIdle(destination.padId);
    return { status: "placed", result: { op: "extract", elementId } };
  }

  /**
   * Removes one leaf (`DELETE /api/pads/:id/tiles/:tileId`). Removal is NOT a placement:
   * nothing accepts "nowhere", which is why the declarations refuse `tile -> pool` — the
   * comment there says it exactly ("moving or parking its occupant addresses the occupant,
   * never the leaf"). So this addresses the LEAF, and the one pooling rule the pool
   * placement uses decides whether its occupant is now unplaced; any other occupant simply
   * loses this representation, and the container it named keeps existing in the index.
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
    if (occupant !== null && occupant.kind === "terminal") {
      this.releaseIfUnreferenced(occupant.sessionId, padId, tileId);
    }
    // A note's leaf IS its only placement: nothing accepts "nowhere", and a composition
    // renders only its layout, so leaving the element behind would be invisible garbage.
    if (occupant !== null && occupant.kind === "text") room.removeElementById(occupant.elementId);
    this.afterLeaving(padId);
    return "ok";
  }

  /**
   * Pops a bubble: a tiled container down to a single leaf that nobody ever claimed
   * dissolves, and its occupant goes home.
   *
   * Two kinds of row qualify. A `transient` view is the bubble an expand created. A
   * HARDENED view that still carries a return address qualifies too — the Phase 3b
   * relaxation: a view composed by drag is durable from birth, yet until its row is
   * explicitly claimed (rename or pin, both of which clear the return address) extracting
   * a tile back onto the canvas must be able to collapse the leftover single-widget view
   * instead of stranding it.
   *
   * A room with OCCUPANTS is never dissolved under them: the empty hook fires when the
   * last one leaves and the pop happens then, which also makes a dead browser crash-safe.
   * Watching sockets are not occupants — a collaborator's widget preview holds a real room
   * socket, and counting it here is what used to make a watched bubble unpoppable.
   */
  dissolveIfBubble(padId: string): void {
    const pad = this.store.getPad(padId);
    if (pad === null || pad.layout !== "tiled") return;
    const originPadId = this.store.padOriginPadId(padId);
    if (!pad.transient && originPadId === null) return;
    const room = this.rooms.get(padId);
    if (room === null || room.hasOccupants()) return;
    const layout = room.tileLayout();
    if (layout === null) return;
    const leaves = tileLeafIds(layout);
    if (leaves.length !== 1) return;
    const leafId = leaves[0];
    const surface = leafId === undefined ? null : (layout[leafId]?.surface ?? null);
    // A note has nowhere to go home to: its element lives in THIS document, and the pool
    // takes only terminals. Dissolving would destroy the only copy, so a composition down
    // to one note simply persists — the operator can still delete it explicitly.
    if (surface !== null && surface.kind === "text") return;
    if (leafId !== undefined && surface !== null && surface.kind === "terminal") {
      this.returnOccupant(surface.sessionId, padId, leafId, originPadId);
    } else if (originPadId !== null) {
      // Nothing to transmute back — the bubble was emptied or only ever held a canvas — so
      // its widget goes with it instead of becoming a portal onto a deleted container.
      this.rooms.get(originPadId)?.removePortalTo(padId);
    }
    // Reuse the pad-deletion path. The occupant is already rebound, so no session is left
    // bound to this container for `dropPad` to kill.
    this.sessions.dropPad(padId);
    this.rooms.drop(padId);
    this.store.deletePad(padId);
  }

  /** Sends a popped bubble's occupant home: the origin canvas slot, else the pool. */
  private returnOccupant(
    sessionId: string,
    viewId: string,
    tileId: string,
    originPadId: string | null,
  ): void {
    if (this.sessions.placedSession(sessionId) === null) return;
    if (originPadId !== null) {
      const originRoom = this.rooms.get(originPadId);
      const elementId = originRoom?.swapPortalToTerminal(viewId, sessionId) ?? null;
      if (elementId !== null) {
        this.sessions.rebindSession(sessionId, viewId, originPadId, elementId);
        this.rooms.evictIfIdle(originPadId);
        return;
      }
    }
    // Born from the pool, or the portal was deleted while the view had focus: there is no
    // canvas slot to transmute back, so the terminal joins the workspace pool.
    this.sessions.releaseSessionToPool(sessionId, viewId, tileId);
  }

  /**
   * Claims a container so no bubble rule can dissolve it: `POST /api/pads/:id/pin` and the
   * rename handler both land here. Clearing the return address is what "claimed" means — a
   * renamed or pinned view survives even when a single tile is left.
   */
  harden(padId: string): "ok" | "not_found" {
    const pad = this.store.getPad(padId);
    if (pad === null) return "not_found";
    if (pad.layout !== "tiled") return "ok";
    if (pad.transient) this.store.updatePadTransient(padId, false);
    this.store.updatePadOriginPad(padId, null);
    return "ok";
  }

  /**
   * A container holding more than one leaf is a composition, not a bubble. The return
   * address deliberately survives: splitting hardens the row, but only an explicit claim
   * gives up the ability to collapse back onto the origin canvas.
   */
  hardenIfComposed(padId: string, room: Room): void {
    const layout = room.tileLayout();
    if (layout === null || tileLeafIds(layout).length <= 1) return;
    if (this.store.getPad(padId)?.transient === true) this.store.updatePadTransient(padId, false);
  }
}
