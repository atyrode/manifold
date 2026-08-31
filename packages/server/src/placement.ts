import { rosterElementTraits } from "@manifold/plugin";
import {
  censusSolo,
  resolvePlacement,
  type ContainerDiscipline,
  type PlaceRequest,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementItem,
  type PlacementLookup,
  type PlacementRef,
  type PlacementTraits,
  type PluginRoster,
  type RuntimeDeps,
  type SceneElement,
  type TileEdge,
  type TileLayout,
  type TileRef,
} from "@manifold/protocol";
import { tileIdForRef, tileLeafIds } from "@manifold/scene";
import type { Room, RoomManager } from "./room.ts";
import type { ServerStore } from "./stores.ts";

/**
 * The contributed half of the placement vocabulary, as the executor asks for it: element
 * type → the traits its manifest declared (ADR 0013 §12).
 *
 * The roster arrives as a THUNK because the two objects are mutually dependent — the
 * executor resolves legality against the assembly, and an action handler in the assembly
 * drives the executor — and because enablement is hot: a re-assembly replaces the roster,
 * and a table captured once would answer for a vocabulary that no longer exists. The
 * derived table is cached on roster IDENTITY, which is stable per assembly, so a placement
 * costs one map lookup and a re-assembly costs one rebuild.
 */
export function assemblyElementTraits(
  roster: () => PluginRoster,
): (kind: string) => PlacementTraits | null {
  let assembled: PluginRoster | null = null;
  let traits: ReadonlyMap<string, PlacementTraits> = new Map();
  return (kind) => {
    const current = roster();
    if (current !== assembled) {
      assembled = current;
      traits = rosterElementTraits(current);
    }
    return traits.get(kind) ?? null;
  };
}

/**
 * THE placement executor. One entry point — `place(ref, destination)` — for every way
 * an item can land in a container, with legality decided entirely by the protocol's
 * declarations (`resolvePlacement`) and never by a branch in here.
 *
 * Three invariants make this the only placement path worth having:
 *
 *   1. What the ref names is located from IDENTITY (`locate`), never taken from the
 *      request. A caller cannot lie about where an item was, so it cannot strand
 *      a placement or move a terminal it does not hold.
 *   2. Every composition-homed item lives in exactly one composition, always. A terminal is
 *      born into one and is only ever MOVED between them, so there is no unbound state to
 *      handle, no pool to fall back into, and no lifecycle flag to consult.
 *   3. A reference never outlives what it references. When a composition stops existing —
 *      absorbed by a merge, emptied by extraction, deleted outright — every portal onto it
 *      goes with it, which is why a dangling portal is not a state this server can reach.
 *
 * A refusal is a NAMED rule from the declarations, returned verbatim to the caller.
 * Operational impossibilities — a vanished terminal, a tree that rejects a write — travel
 * on the separate `failed` channel, because they are not statements about what composes.
 */

/** Container names clamp to `ContainerSchema`'s ceiling; a merge auto-names from its refs. */
const MAX_CONTAINER_NAME = 120;

/** Why a legal placement could not be carried out; never a statement about legality. */
export type PlaceFailure = "not_found" | "conflict";

/** The executor's answer: executed with its per-op result, refused by rule, or failed. */
export type PlaceOutcome =
  | { readonly status: "placed"; readonly result: PlaceResponse }
  | { readonly status: "denied"; readonly denial: PlacementDenial }
  | { readonly status: "failed"; readonly failure: PlaceFailure };

/**
 * The terminal-side seam. Placement mutates CONTAINERS, but a terminal's home, its fan-out
 * and its PTY belong to the broker — so the executor asks for exactly these five things
 * and owns everything else itself. This interface is the whole coupling between the two
 * modules, which is what makes splitting them along it worth doing.
 */
export interface TerminalPlacementPort {
  /** Live terminal state; null when no such terminal exists. `containerId` is its home composition. */
  placedTerminal(terminalId: string): { readonly containerId: string } | null;
  /** A terminal's operator-visible label: its own name, else its machine's, else `fallback`. */
  terminalLabel(terminalId: string, fallback: string): string;
  /** Publishes a terminal's move from one composition to another. */
  rebindTerminal(
    terminalId: string,
    fromContainerId: string,
    toContainerId: string,
    placementId: string,
  ): void;
  /**
   * Kills and forgets a terminal whose last home leaf is gone. There is no pool for it to
   * fall into, so removing a terminal's only representation IS closing the terminal.
   */
  reapTerminal(terminalId: string): void;
  /** Kills and forgets every PTY homed in a container before its rows are purged. */
  dropContainer(containerId: string): void;
}

/** Every leaf holding a terminal, so moving the ITEM can reach all of its copies. */
function terminalLeafIds(layout: TileLayout | null, terminalId: string): string[] {
  if (layout === null) return [];
  const ids: string[] = [];
  for (const tileId of tileLeafIds(layout)) {
    const ref = layout[tileId]?.ref ?? null;
    if (ref !== null && ref.kind === "terminal" && ref.terminalId === terminalId) {
      ids.push(tileId);
    }
  }
  return ids;
}

/**
 * Where a ref points RIGHT NOW, resolved from identity — never from the request.
 *
 * The two halves are deliberately separate. `containerId`/`addressed` describe the ONE
 * representation the gesture grabbed, and are null when the request named an item by
 * identity instead of pointing at a copy of it. `terminalId`/`homeId` describe where the
 * item LIVES, which is the same answer however it was addressed — and the reason a canvas
 * portal, a tile leaf, a sidebar row and a bare terminal id all reach one code path.
 */
interface SourceLocation {
  readonly containerId: string | null;
  readonly discipline: ContainerDiscipline | null;
  readonly addressed: string | null;
  readonly terminalId: string | null;
  readonly homeId: string | null;
}

const NO_SOURCE: SourceLocation = {
  containerId: null,
  discipline: null,
  addressed: null,
  terminalId: null,
  homeId: null,
};

/**
 * A leaf's occupant, moved aside so the leaf can be given to something else: the ref that
 * was in it, the fresh solo composition built to keep it alive, and its leaf in there.
 * Both ids are null when nothing had to be built — an embedded canvas is a reference, and
 * the container it points at already lives in the index on its own.
 */
interface EvictedOccupant {
  readonly ref: TileRef;
  readonly homeId: string | null;
  readonly leafId: string | null;
}

export class PlaceExecutor {
  constructor(
    private readonly store: ServerStore,
    private readonly rooms: RoomManager,
    private readonly terminals: TerminalPlacementPort,
    private readonly runtime: RuntimeDeps,
    /**
     * The assembly's contributed element traits (`assemblyElementTraits`). It is a
     * constructor dependency rather than a lookup the executor builds, because the algebra's
     * vocabulary is half floor and half plugin: the rules engine is this module's business,
     * the kinds are the roster's.
     */
    private readonly elementTraits: (kind: string) => PlacementTraits | null,
  ) {}

  /**
   * Resolves a placement and executes it. Legality is entirely the declarations' answer;
   * this method only decides HOW the named op is carried out.
   */
  place(request: PlaceRequest): PlaceOutcome {
    const { ref, destination } = request;
    const resolution = resolvePlacement(ref, destination, this.lookup());
    if (!resolution.ok) return { status: "denied", denial: resolution.denial };
    const source = this.locate(ref);
    if (source === "not_found") return { status: "failed", failure: "not_found" };

    switch (destination.kind) {
      case "canvas":
        switch (resolution.op) {
          case "portal":
            return this.executePortal(ref, resolution.item, destination, source);
          case "move_element":
            return this.executeMoveElement(ref, destination, source);
          case "extract":
            return this.executeExtract(ref, destination, source);
          default:
            // Unreachable: `canvasOpFor` maps every kind to one of the three above.
            return { status: "failed", failure: "conflict" };
        }
      case "tile":
        return this.executeAddTile(
          ref,
          resolution.item,
          destination.containerId,
          destination.targetTileId,
          destination.edge,
          destination.between ?? false,
          source,
        );
      case "compose":
        return this.executeCompose(ref, resolution.item, destination, source);
      case "unplaced":
        return this.executeUnplace(ref, resolution.item, source);
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
      disciplineOf: (containerId) => this.store.getContainer(containerId)?.discipline ?? null,
      terminalHome: (terminalId) => this.terminals.placedTerminal(terminalId)?.containerId ?? null,
      elementItem: (containerId, elementId): PlacementItem | null => {
        const element = this.rooms.get(containerId)?.element(elementId) ?? null;
        if (element === null) return null;
        if (element.type === "portal") {
          // A portal places the container it points at, so that container's discipline
          // decides the kind — and a portal onto a deleted container places nothing.
          const discipline = this.store.getContainer(element.containerId)?.discipline ?? null;
          if (discipline === null) return null;
          return { kind: discipline, containerId: element.containerId };
        }
        // Every other element places ITS OWN TYPE, whoever contributed it. There is no arm
        // per element kind here any more: that switch was the floor holding a list of
        // plugin-owned names, which is exactly what the trait fusion removes (§12).
        return { kind: element.type, containerId: null };
      },
      soloOccupant: (containerId) => this.soloOccupant(containerId)?.item ?? null,
      itemTraits: (kind) => this.elementTraits(kind),
    };
  }

  /**
   * What a composition of ONE holds, with the terminal id when that item is a terminal. The
   * algebra only needs the classification; the executor also needs the terminal, and reading
   * the census twice for the two halves is how they would come apart.
   */
  private soloOccupant(
    containerId: string,
  ): { readonly item: PlacementItem; readonly terminalId: string | null } | null {
    const room = this.rooms.get(containerId);
    if (room === null) return null;
    const census = room.census();
    if (census.discipline !== "composition") return null;
    const solo = censusSolo(census);
    if (solo === null) return null;
    return {
      // A terminal's `containerId` is the composition it lives in: the two are one thing
      // addressed from opposite sides, and every op that moves it needs exactly that id.
      item: {
        kind: solo.kind,
        containerId: solo.kind === "terminal" ? containerId : solo.containerId,
      },
      terminalId: solo.terminalId,
    };
  }

  /**
   * Identity, not assertion: a terminal is wherever the broker says it is, and an
   * addressed element or leaf is wherever it actually lives. An id that names nothing is a
   * failure, so no request can quietly become a no-op.
   */
  private locate(ref: PlacementRef): SourceLocation | "not_found" {
    switch (ref.kind) {
      case "terminal": {
        // `resolvePlacement` asks the lookup for a home, so a vanished terminal is already a
        // denial there; this catches the race where it vanished in between.
        const terminal = this.terminals.placedTerminal(ref.terminalId);
        if (terminal === null) return "not_found";
        return { ...NO_SOURCE, terminalId: ref.terminalId, homeId: terminal.containerId };
      }
      case "container": {
        // Naming a solo composition names the item inside it, which is what makes dragging
        // a sidebar row and dragging its canvas portal the same placement.
        const solo = this.soloOccupant(ref.containerId);
        return {
          ...NO_SOURCE,
          terminalId: solo?.terminalId ?? null,
          homeId:
            solo?.terminalId === undefined || solo.terminalId === null ? null : ref.containerId,
        };
      }
      case "element": {
        const element = this.rooms.get(ref.containerId)?.element(ref.elementId) ?? null;
        if (element === null) return "not_found";
        const solo = element.type === "portal" ? this.soloOccupant(element.containerId) : null;
        const terminalId = solo?.terminalId ?? null;
        return {
          containerId: ref.containerId,
          discipline: "canvas",
          addressed: ref.elementId,
          terminalId,
          homeId: terminalId === null || element.type !== "portal" ? null : element.containerId,
        };
      }
      case "tile": {
        const tile = this.rooms.get(ref.containerId)?.tileLayout()?.[ref.tileId];
        if (tile === undefined || tile.dir !== null) return "not_found";
        const occupant = tile.ref;
        const terminalId = occupant?.kind === "terminal" ? occupant.terminalId : null;
        return {
          containerId: ref.containerId,
          discipline: "composition",
          addressed: ref.tileId,
          terminalId,
          homeId: terminalId === null ? null : ref.containerId,
        };
      }
      default: {
        const exhaustive: never = ref;
        return exhaustive;
      }
    }
  }

  /** An idle room stops being resident once whatever was happening in it is done. */
  private afterLeaving(containerId: string | null): void {
    if (containerId !== null) this.rooms.evictIfIdle(containerId);
  }

  /**
   * Every container that references `containerId`, from the census — which answers for
   * containers whose rooms are not resident, so a reference on a canvas nobody has open is
   * not a reference this server can miss.
   */
  private referrers(containerId: string): string[] {
    const containers: string[] = [];
    for (const census of this.rooms.censuses()) {
      if (census.references.includes(containerId)) containers.push(census.containerId);
    }
    return containers;
  }

  /**
   * Removes every reference to a container. The container itself is untouched.
   *
   * A reference is a portal element on a canvas OR a `container` leaf in a composition —
   * both are what `census.references` counts, and unplacing has to mean the same thing the
   * census means or the two describe different graphs. A composition left holding nothing by
   * the removal retires, exactly as it would if the item had been dragged out of it.
   */
  private removeReferences(containerId: string): number {
    let removed = 0;
    for (const referrerId of this.referrers(containerId)) {
      const room = this.rooms.get(referrerId);
      if (room === null) continue;
      removed += room.removePortalsTo(containerId);
      const layout = room.tileLayout();
      let leaves = 0;
      for (const leafId of layout === null ? [] : tileLeafIds(layout)) {
        const occupant = layout?.[leafId]?.ref ?? null;
        if (
          occupant === null ||
          occupant.kind !== "container" ||
          occupant.containerId !== containerId
        ) {
          continue;
        }
        if (room.removeTileLeafById(leafId)) {
          removed += 1;
          leaves += 1;
        }
      }
      if (leaves > 0) this.deleteIfEmptied(referrerId);
      this.afterLeaving(referrerId);
    }
    return removed;
  }

  /**
   * Points every reference to `fromId` at `toId` instead. A merge absorbs an item into a
   * composition, and a canvas that was showing that item should keep showing it — repointing
   * preserves the element id and its geometry, so no collaborator's portal jumps or blinks
   * and no selection is lost.
   */
  private retargetReferences(fromId: string, toId: string): void {
    for (const referrerId of this.referrers(fromId)) {
      const room = this.rooms.get(referrerId);
      if (room === null) continue;
      for (const elementId of room.portalIdsTo(fromId)) room.repointPortal(elementId, toId);
      this.afterLeaving(referrerId);
    }
  }

  /**
   * Deletes a container and, first, every reference to it, so nothing is left pointing at
   * something that no longer exists. Any terminal still homed here goes with it: that is
   * what deleting the place an item lives means.
   *
   * Public because `DELETE /api/containers/:id` is the same operation. It used to do three
   * of these four steps itself and leave portals onto the deleted container behind — the one
   * step it missed is the one this cutover made load-bearing, since a canvas terminal IS a
   * portal now, and a route reimplementing most of a rule is how the rule comes apart.
   */
  deleteContainer(containerId: string): void {
    this.removeReferences(containerId);
    this.terminals.dropContainer(containerId);
    this.rooms.drop(containerId);
    this.store.deleteContainer(containerId);
  }

  /**
   * A composition that just lost its last item stops existing. Call this ONLY straight after
   * removing an occupant from it: a deliberately empty composition ("New composition", or
   * one whose tiles were never filled) holds nothing either, and it is the departure — not
   * the emptiness — that retires a container.
   */
  private deleteIfEmptied(containerId: string): void {
    const container = this.store.getContainer(containerId);
    if (container === null || container.discipline !== "composition") return;
    const room = this.rooms.get(containerId);
    if (room === null || room.census().items.length > 0) return;
    this.deleteContainer(containerId);
  }

  /** What a tileable item looks like as a leaf occupant; null when nothing is tileable. */
  private tileRefFor(item: PlacementItem, source: SourceLocation): TileRef | null {
    if (item.kind === "terminal") {
      return source.terminalId === null
        ? null
        : { kind: "terminal", terminalId: source.terminalId };
    }
    if (item.kind === "canvas" && item.containerId !== null) {
      return { kind: "container", containerId: item.containerId };
    }
    if (item.kind === "text") {
      // A note is addressed as an element of the container holding it, and stored as the
      // element id the DESTINATION will hold it under — the ids are the same because the
      // element MOVES between documents rather than being copied.
      return source.addressed === null ? null : { kind: "text", elementId: source.addressed };
    }
    if (item.kind === "tile" && source.containerId !== null && source.addressed !== null) {
      /*
        A leaf places WHAT IT HOLDS. The algebra classifies a leaf opaquely on purpose —
        a browser dragging a leaf of a container it has not joined knows the placement and
        not the occupant — so this is where the two halves of one drag meet: the side that
        owns the tree reads it, and every op downstream sees an ordinary tileable ref.
       */
      return this.rooms.get(source.containerId)?.tileLayout()?.[source.addressed]?.ref ?? null;
    }
    return null;
  }

  /**
   * Moves a leaf's occupant ASIDE — never away — so the leaf itself becomes available.
   *
   * The occupant's new home is built BEFORE anything is taken from it, which is the order
   * extraction has always used and the reason rollback is trivial: a caller that cannot
   * finish drops one fresh container row, and the occupant has never been anywhere but where
   * it already was. Nothing is destroyed here — a displaced terminal keeps running in a solo
   * composition of its own, and an embedded canvas keeps living in the index.
   *
   * Deliberately narrow: it neither rebinds the terminal nor removes the old leaf. A
   * displacement RE-SEATS that leaf and a release REMOVES it, so each caller does both at
   * its own correct moment rather than undoing this one's guess.
   *
   * A `text` occupant is refused by name. A note's element lives in this composition's own
   * document and has nowhere else to be, so displacing it could only mean deleting it.
   */
  private evictLeaf(
    composition: Room,
    containerId: string,
    tileId: string,
    ref: PlacementRef,
  ): EvictedOccupant | PlaceOutcome {
    const occupant = composition.tileLayout()?.[tileId]?.ref ?? null;
    // An empty leaf holds no item, so there is nothing to move aside and the caller was
    // asking about a spot that is not actually taken.
    if (occupant === null) return { status: "failed", failure: "conflict" };
    // Neither of these can be moved ASIDE: a note lives in this document and has no home to
    // be sent to, and a panel is not an object at all. The spot they hold is not up for
    // grabs, so a center drop onto one is refused rather than silently destructive.
    if (occupant.kind === "text" || occupant.kind === "panel") {
      return {
        status: "denied",
        denial: {
          rule: "not_displaceable",
          ref,
          container: { kind: "composition", containerId },
        },
      };
    }
    if (occupant.kind === "container") return { ref: occupant, homeId: null, leafId: null };
    const homeId = this.runtime.newId();
    this.store.createContainer({
      id: homeId,
      name: this.terminals
        .terminalLabel(occupant.terminalId, "terminal")
        .slice(0, MAX_CONTAINER_NAME),
      createdAt: this.runtime.now(),
      discipline: "composition",
    });
    const home = this.rooms.get(homeId);
    const leafId = home?.placeTerminalTile(occupant.terminalId, null, null) ?? null;
    if (home === null || leafId === null) {
      this.rooms.drop(homeId);
      this.store.deleteContainer(homeId);
      return { status: "failed", failure: "conflict" };
    }
    return { ref: occupant, homeId, leafId };
  }

  /**
   * Undoes the home `evictLeaf` built, for a caller whose own write then refused. Nothing
   * durable has moved at that point — the occupant is still in its leaf — so the newborn
   * row goes away with the failure.
   */
  private dropEvictedHome(evicted: EvictedOccupant): void {
    if (evicted.homeId === null) return;
    this.rooms.drop(evicted.homeId);
    this.store.deleteContainer(evicted.homeId);
  }

  /**
   * The note behind a `text` ref, read before anything is written so a placement that
   * cannot be carried out mutates neither document. Null when the element is gone or was
   * never a note.
   */
  private noteAt(containerId: string | null, elementId: string): SceneElement | null {
    if (containerId === null) return null;
    const element = this.rooms.get(containerId)?.element(elementId) ?? null;
    return element?.type === "text" ? element : null;
  }

  /**
   * Moves a note into the container that now holds its leaf. A composition OWNS its notes:
   * its own document stores the element, so the text stays collaborative through the same
   * room everyone in the composition is already joined to, with no second socket and no
   * cross-document reference to keep alive.
   */
  private adoptNote(source: SourceLocation, note: SceneElement, target: Room): void {
    if (source.containerId !== null && source.addressed !== null) {
      this.rooms.get(source.containerId)?.removeElementById(source.addressed);
    }
    target.adoptElement(note, note.x, note.y);
    this.afterLeaving(source.containerId);
  }

  /** The label a merged composition borrows from one of the refs it was built from. */
  private refLabel(item: PlacementItem, source: SourceLocation): string {
    if (item.kind === "terminal" && source.terminalId !== null) {
      return this.terminals.terminalLabel(source.terminalId, "terminal");
    }
    if (item.kind === "tile") {
      // A leaf is called after what it HOLDS. Naming it "ref" would name the gesture that
      // carried it, which is the one thing the operator did not put in the container.
      const occupant = this.tileRefFor(item, source);
      if (occupant?.kind === "terminal") {
        return this.terminals.terminalLabel(occupant.terminalId, "terminal");
      }
      if (occupant?.kind === "container") {
        return this.store.getContainer(occupant.containerId)?.name ?? "canvas";
      }
      if (occupant?.kind === "text") return "note";
    }
    if (item.kind === "text") return "note";
    if (item.containerId !== null) {
      return this.store.getContainer(item.containerId)?.name ?? "canvas";
    }
    return "ref";
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
    ref: PlacementRef,
    item: PlacementItem,
    destination: { readonly containerId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    const containerId = item.containerId;
    if (containerId === null) return { status: "failed", failure: "conflict" };
    if (ref.kind === "element" && source.containerId !== null) {
      const moved = this.moveElementPlacement(source.containerId, ref.elementId, destination);
      return moved === "ok"
        ? { status: "placed", result: { op: "portal", elementId: ref.elementId } }
        : { status: "failed", failure: moved };
    }
    const room = this.rooms.get(destination.containerId);
    if (room === null) return { status: "failed", failure: "not_found" };
    const elementId = room.placePortalElement(containerId, destination.x, destination.y);
    this.rooms.evictIfIdle(destination.containerId);
    return { status: "placed", result: { op: "portal", elementId } };
  }

  /** A plain canvas item (text, ink) travelling to a canvas: reposition, or change canvas. */
  private executeMoveElement(
    ref: PlacementRef,
    destination: { readonly containerId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    if (ref.kind !== "element" || source.containerId === null) {
      // Only an addressed element places text or ink: there is no other way to name one.
      return { status: "failed", failure: "conflict" };
    }
    const moved = this.moveElementPlacement(source.containerId, ref.elementId, destination);
    return moved === "ok"
      ? { status: "placed", result: { op: "move_element", elementId: ref.elementId } }
      : { status: "failed", failure: moved };
  }

  /**
   * Moves one addressed canvas element to a canvas, keeping its id so collaborators'
   * references survive. Nothing about the item matters here — only that it IS a canvas
   * placement — which is why text, ink and portals all travel through this one path.
   */
  private moveElementPlacement(
    containerId: string,
    elementId: string,
    destination: { readonly containerId: string; readonly x: number; readonly y: number },
  ): "ok" | PlaceFailure {
    const source = this.rooms.get(containerId);
    const target = this.rooms.get(destination.containerId);
    if (source === null || target === null) return "not_found";
    if (containerId === destination.containerId) {
      return source.moveElement(elementId, destination.x, destination.y) ? "ok" : "not_found";
    }
    const element = source.element(elementId);
    if (element === null) return "not_found";
    source.removeElementById(elementId);
    target.adoptElement(element, destination.x, destination.y);
    this.rooms.evictIfIdle(containerId);
    this.rooms.evictIfIdle(destination.containerId);
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
   *
   * A LEAF releases differently, because a leaf is not a reference: its occupant is only
   * ever in this composition, so the leaf goes and the occupant is RE-HOMED rather than
   * dropped. That is what the fullscreen route's tile-minimize asks for, and it is why the
   * branch comes first — a leaf classifies with no container id of its own, so the guard
   * below used to swallow the whole gesture before it could be carried out.
   */
  private executeUnplace(
    ref: PlacementRef,
    item: PlacementItem,
    source: SourceLocation,
  ): PlaceOutcome {
    if (ref.kind === "tile") {
      const composition = this.rooms.get(ref.containerId);
      if (composition === null) return { status: "failed", failure: "not_found" };
      const occupant = composition.tileLayout()?.[ref.tileId]?.ref ?? null;
      // An empty leaf holds no item: releasing it would remove nothing, which is exactly
      // the silent no-op the algebra refuses to have.
      if (occupant === null) return { status: "failed", failure: "conflict" };
      // A composition of ONE is that item, so releasing its only leaf releases the
      // COMPOSITION. The terminal stays exactly where it lives and nothing is re-homed —
      // the same answer extraction gives a solo source, reached by the other door.
      if (occupant.kind === "terminal" && composition.census().items.length === 1) {
        return {
          status: "placed",
          result: { op: "unplace", removed: this.removeReferences(ref.containerId) },
        };
      }
      const evicted = this.evictLeaf(composition, ref.containerId, ref.tileId, ref);
      if ("status" in evicted) return evicted;
      if (!composition.removeTileLeafById(ref.tileId)) {
        this.dropEvictedHome(evicted);
        return { status: "failed", failure: "conflict" };
      }
      if (occupant.kind === "terminal" && evicted.homeId !== null && evicted.leafId !== null) {
        this.terminals.rebindTerminal(
          occupant.terminalId,
          ref.containerId,
          evicted.homeId,
          evicted.leafId,
        );
      }
      this.deleteIfEmptied(ref.containerId);
      this.afterLeaving(ref.containerId);
      return { status: "placed", result: { op: "unplace", removed: 1 } };
    }
    const containerId = item.containerId;
    if (containerId === null) return { status: "failed", failure: "conflict" };
    if (ref.kind === "element" && source.containerId !== null && source.addressed !== null) {
      const room = this.rooms.get(source.containerId);
      if (room === null) return { status: "failed", failure: "not_found" };
      const removed = room.removeElementById(source.addressed) ? 1 : 0;
      this.afterLeaving(source.containerId);
      return { status: "placed", result: { op: "unplace", removed } };
    }
    return {
      status: "placed",
      result: { op: "unplace", removed: this.removeReferences(containerId) },
    };
  }

  /**
   * A tileable ref joining a composition. The leaf is written FIRST: a tree that
   * refuses the write leaves the source untouched, so a rejected placement mutates nothing —
   * which is also why a note is READ before the write and moved only after it.
   *
   * When the ref names a terminal from ANOTHER composition this is a MERGE. Its old home is
   * absorbed: the leaf moves, the terminal rebinds, every reference that pointed at the old
   * home is repointed here so the canvases showing that terminal keep showing it, the
   * reference the gesture consumed is removed, and the emptied home retires. A second leaf
   * for a terminal already living here is simply another copy of it.
   *
   * CENTER MEANS THIS EXACT SPOT. A center placement onto an EMPTY leaf fills it — the
   * ordinary add below — and onto an OCCUPIED one the occupant has to move, which
   * resolution cannot have known because occupancy is document state rather than a kind.
   * This is the one place this executor decides which op ran, and it says so in its
   * response: an EXCHANGE when the gesture holds a seat to trade back, and a DISPLACEMENT
   * when it does not.
   */
  private executeAddTile(
    ref: PlacementRef,
    item: PlacementItem,
    containerId: string,
    targetTileId: string | null,
    edge: TileEdge | null,
    between: boolean,
    source: SourceLocation,
  ): PlaceOutcome {
    const composition = this.rooms.get(containerId);
    if (composition === null) return { status: "failed", failure: "not_found" };
    const dragged = this.tileRefFor(item, source);
    if (dragged === null) return { status: "failed", failure: "conflict" };
    const fromLeaf = ref.kind === "tile" ? source.addressed : null;
    // A leaf placed beside itself is the silent no-op the algebra refuses to have.
    if (fromLeaf !== null && source.containerId === containerId && fromLeaf === targetTileId) {
      return { status: "failed", failure: "conflict" };
    }
    if (edge === "center" && targetTileId !== null) {
      const occupant = composition.tileLayout()?.[targetTileId]?.ref ?? null;
      if (occupant !== null) {
        /*
          What the gesture HOLDS decides between the two, not what it carries. A carry
          seated in a leaf of some composition has a seat to give the occupant back, so
          the two trade — and a canvas ELEMENT holding a terminal is seated too (#62):
          the element is a window onto the terminal's solo home, which empties the
          instant the carry merges here, so the occupant moves INTO that home and the
          element keeps pointing at it — the portal simply starts showing the displaced
          terminal, same id, same geometry, no repointing at all. A carry with no seat
          anywhere — a sidebar row, a bare terminal id, a portal holding a container —
          leaves the occupant to be re-homed instead. Which is why a tile destination never
          answers `not_swappable`: only the canvas door does.
         */
        const seated =
          source.discipline === "composition" &&
          source.containerId !== null &&
          source.addressed !== null;
        if (seated) {
          return this.executeTileSwap(ref, dragged, occupant, containerId, targetTileId, source);
        }
        const homeSeat = this.elementHomeSeat(ref, source);
        if (homeSeat !== null) {
          return this.executeTileSwap(ref, dragged, occupant, containerId, targetTileId, homeSeat);
        }
        return this.executeReplace(ref, dragged, occupant, containerId, targetTileId, source);
      }
    }
    // A note carried as an ELEMENT is read before the write, so a placement that cannot be
    // carried out mutates neither document. One carried as a LEAF travels with the leaf.
    const note =
      fromLeaf === null && dragged.kind === "text"
        ? this.noteAt(source.containerId, dragged.elementId)
        : null;
    if (fromLeaf === null && dragged.kind === "text" && note === null) {
      return { status: "failed", failure: "not_found" };
    }
    const tileId = composition.placeTile(dragged, targetTileId, edge, between);
    if (tileId === null) return { status: "failed", failure: "conflict" };
    if (fromLeaf !== null) {
      const moved = this.finishLeafMove(dragged, source, composition, containerId, tileId);
      if (moved === null) return { status: "failed", failure: "conflict" };
      return { status: "placed", result: { op: "add_tile", tileId: moved } };
    }
    if (dragged.kind === "terminal" && source.homeId !== null && source.homeId !== containerId) {
      this.absorbHome(dragged.terminalId, source, containerId, tileId);
    }
    if (note !== null) this.adoptNote(source, note, composition);
    return { status: "placed", result: { op: "add_tile", tileId } };
  }

  /**
   * The composition seat a canvas-element carry implicitly holds (#62): a portal element
   * showing a terminal is a window onto the terminal's SOLO home composition, so the
   * home's own leaf is a seat the occupant of a center drop can move into — the
   * cross-container exchange `executeTileSwap` already performs. Null for every carry
   * that truly has no seat: notes, ink, portals onto canvases or multi compositions
   * (multi never reaches the executor — `not_solo` refuses it at resolution).
   */
  private elementHomeSeat(ref: PlacementRef, source: SourceLocation): SourceLocation | null {
    if (ref.kind !== "element" || source.terminalId === null || source.homeId === null) {
      return null;
    }
    const home = this.rooms.get(source.homeId);
    if (home === null) return null;
    const leafId = terminalLeafIds(home.tileLayout(), source.terminalId)[0] ?? null;
    if (leafId === null) return null;
    return {
      containerId: source.homeId,
      discipline: "composition",
      addressed: leafId,
      terminalId: source.terminalId,
      homeId: source.homeId,
    };
  }

  /**
   * The second half of re-placing a LEAF: its old seat goes. That subtraction is the whole
   * difference between moving a placement and authoring a second one, and it is why a leaf
   * dropped on an edge rearranges a composition instead of duplicating into it.
   *
   * Crossing into another container hands the occupant over as well — a terminal's home
   * follows it, a note's element travels — and a container the departure emptied is
   * ABSORBED into the destination: every reference to it is repointed before it retires, so
   * a canvas that was showing that item keeps showing it.
   *
   * Returns the leaf the occupant ended up in — read back, because pruning the old seat can
   * collapse a split and promote its survivor into the root id — or null when the source
   * vanished between resolution and the write, which the caller reports as a failure.
   */
  private finishLeafMove(
    dragged: TileRef,
    source: SourceLocation,
    composition: Room,
    containerId: string,
    tileId: string,
  ): string | null {
    const fromContainerId = source.containerId;
    const fromTileId = source.addressed;
    if (fromContainerId === null || fromTileId === null) return null;
    const from = this.rooms.get(fromContainerId);
    if (from === null) return null;
    from.removeTileLeafById(fromTileId);
    if (fromContainerId !== containerId) this.handOverOccupant(dragged, from, composition);
    // The read-back is why `tileId` is not simply returned: see the doc comment above.
    const placementId = tileIdForRef(composition.tileLayout(), dragged) ?? tileId;
    if (fromContainerId !== containerId) {
      if (dragged.kind === "terminal") {
        this.terminals.rebindTerminal(
          dragged.terminalId,
          fromContainerId,
          containerId,
          placementId,
        );
      }
      this.retireEmptiedInto(fromContainerId, containerId);
    }
    this.afterLeaving(fromContainerId);
    return placementId;
  }

  /**
   * A container that a departure left holding NOTHING was absorbed, not merely emptied: the
   * canvases referencing it were showing the item that just left, so every reference is
   * repointed at the container the item went to — keeping element ids, geometry and
   * selections — and only then does the emptied container retire. A container that still
   * holds something keeps its own references, because it still has something to show.
   */
  private retireEmptiedInto(fromContainerId: string, toContainerId: string): void {
    const room = this.rooms.get(fromContainerId);
    if (room === null || room.census().items.length > 0) return;
    this.retargetReferences(fromContainerId, toContainerId);
    this.deleteIfEmptied(fromContainerId);
  }

  /**
   * The exchange a center drop on a taken leaf means: the carried ref takes the exact
   * spot it was released on, and the occupant takes the seat the carry came from.
   *
   * A swap needs a SEAT to give back, and `executeAddTile` only routes here when the
   * gesture has one, so the guard below is a BACKSTOP rather than the door's answer: a
   * seatless carry over an occupied leaf is a `replace`, not a refusal. `not_swappable`
   * belongs to the canvas/compose door now, where an element's seat cannot be re-homed and
   * the exchange really is the only thing a center release could have meant. The rule
   * still lives here so a hand-written request naming a carry with no placement at all
   * cannot slip past into a half-defined trade.
   */
  private executeTileSwap(
    ref: PlacementRef,
    dragged: TileRef,
    occupant: TileRef,
    containerId: string,
    targetTileId: string,
    source: SourceLocation,
  ): PlaceOutcome {
    const fromContainerId = source.containerId;
    const fromTileId = source.addressed;
    if (source.discipline !== "composition" || fromContainerId === null || fromTileId === null) {
      return {
        status: "denied",
        denial: { rule: "not_swappable", ref, container: { kind: "composition", containerId } },
      };
    }
    // Trading a leaf with itself is the silent no-op the algebra refuses to have.
    if (fromContainerId === containerId && fromTileId === targetTileId) {
      return { status: "failed", failure: "conflict" };
    }
    const target = this.rooms.get(containerId);
    const from = this.rooms.get(fromContainerId);
    if (target === null || from === null) return { status: "failed", failure: "not_found" };
    if (fromContainerId === containerId) {
      // One tree, one transaction: neither item changed the container it lives in, so
      // there is no terminal to rebind and no note to move between documents.
      if (!target.swapTileLeavesById(fromTileId, targetTileId)) {
        return { status: "failed", failure: "conflict" };
      }
      return {
        status: "placed",
        result: { op: "swap", placementId: targetTileId, withPlacementId: fromTileId },
      };
    }

    /*
      Two trees. They cannot share a transaction, so each side is written on its own and
      the second refusing rolls the first back — a swap that cannot complete must move
      nothing, exactly like every other placement that fails its write.
     */
    if (!from.setTileRef(fromTileId, occupant)) {
      return { status: "failed", failure: "conflict" };
    }
    if (!target.setTileRef(targetTileId, dragged)) {
      from.setTileRef(fromTileId, dragged);
      return { status: "failed", failure: "conflict" };
    }
    // Both items changed the container they live in, so both are handed over before any id
    // is read back: pruning a stale mirror can collapse a split and promote its survivor
    // into the root id, which would make an id remembered from before the write a lie.
    this.handOverOccupant(dragged, from, target);
    this.handOverOccupant(occupant, target, from);
    const placementId = tileIdForRef(target.tileLayout(), dragged) ?? targetTileId;
    const withPlacementId = tileIdForRef(from.tileLayout(), occupant) ?? fromTileId;
    if (dragged.kind === "terminal") {
      this.terminals.rebindTerminal(dragged.terminalId, fromContainerId, containerId, placementId);
    }
    if (occupant.kind === "terminal") {
      this.terminals.rebindTerminal(
        occupant.terminalId,
        containerId,
        fromContainerId,
        withPlacementId,
      );
    }
    this.afterLeaving(fromContainerId);
    this.afterLeaving(containerId);
    return { status: "placed", result: { op: "swap", placementId, withPlacementId } };
  }

  /**
   * The other thing a center drop on a taken leaf can mean: the carry holds no seat to
   * trade back, so instead of refusing it, the leaf is GIVEN to the carry and the occupant
   * is displaced into a place of its own. A composition can always re-home what it
   * displaces — a terminal into a fresh solo composition, an embedded canvas into the index
   * it already lives in — which is why the tile door has no `not_swappable` to raise. Only
   * a note cannot be displaced, and `evictLeaf` refuses that one by name before any write.
   *
   * The ORDER is what makes this atomic:
   *
   *   the occupant's new home is built before the target tree is touched, so a refusal
   *     leaves the occupant exactly where it was rather than nowhere;
   *   the target leaf is RE-SEATED, never removed, so the container is never momentarily
   *     empty — `reapTerminal` can never fire on the displaced terminal, and neither
   *     `deleteIfEmptied` nor `retireEmptiedInto` can race on this side;
   *   the displaced terminal rebinds only once its new leaf is real and its old one is not.
   *
   * Everything after that is the ordinary add's carry-side bookkeeping, unchanged: this op
   * differs from `add_tile` in what happens to the OCCUPANT, never in what happens to the
   * thing the operator was carrying.
   */
  private executeReplace(
    ref: PlacementRef,
    dragged: TileRef,
    occupant: TileRef,
    containerId: string,
    targetTileId: string,
    source: SourceLocation,
  ): PlaceOutcome {
    const composition = this.rooms.get(containerId);
    if (composition === null) return { status: "failed", failure: "not_found" };
    // A note carried as an ELEMENT is read before anything is written, so a placement that
    // cannot be carried out mutates neither document. One carried as a LEAF travels with it.
    const fromLeaf = ref.kind === "tile" ? source.addressed : null;
    const note =
      fromLeaf === null && dragged.kind === "text"
        ? this.noteAt(source.containerId, dragged.elementId)
        : null;
    if (fromLeaf === null && dragged.kind === "text" && note === null) {
      return { status: "failed", failure: "not_found" };
    }
    const evicted = this.evictLeaf(composition, containerId, targetTileId, ref);
    if ("status" in evicted) return evicted;
    if (!composition.setTileRef(targetTileId, dragged)) {
      this.dropEvictedHome(evicted);
      return { status: "failed", failure: "conflict" };
    }
    if (occupant.kind === "terminal" && evicted.homeId !== null && evicted.leafId !== null) {
      this.terminals.rebindTerminal(
        occupant.terminalId,
        containerId,
        evicted.homeId,
        evicted.leafId,
      );
    }
    let tileId = targetTileId;
    if (fromLeaf !== null) {
      // Defensive: a carry seated in a leaf resolves to `executeTileSwap`, so this arm is
      // only reachable if that dispatch ever loosens. It is the same subtraction a leaf
      // gets everywhere else, and the id is read back because pruning the old seat can
      // collapse a split and rename the one just written.
      const moved = this.finishLeafMove(dragged, source, composition, containerId, targetTileId);
      if (moved === null) return { status: "failed", failure: "conflict" };
      tileId = moved;
    } else if (
      dragged.kind === "terminal" &&
      source.homeId !== null &&
      source.homeId !== containerId
    ) {
      this.absorbHome(dragged.terminalId, source, containerId, targetTileId);
    }
    if (note !== null) this.adoptNote(source, note, composition);
    return {
      status: "placed",
      result: { op: "replace", tileId, displacedContainerId: evicted.homeId },
    };
  }

  /**
   * Hands an occupant over to the container its leaf just landed in, whenever the two are
   * DIFFERENT containers. Shared by the exchange and the plain leaf move, because "the item
   * changed the container it lives in" is one situation however the gesture spelled it:
   *
   *   a TERMINAL lives in exactly one composition, so the mirrors its old container still
   *     held for it go — a leaf naming a terminal that lives somewhere else is a reference
   *     to a place the item no longer is, which is the state invariant 3 exists to forbid;
   *   a NOTE is owned by the composition showing it, so its element travels between the two
   *     documents, or the leaf would render text nobody in the new room can read or edit;
   *   an embedded CANVAS is a reference and needs nothing: the container keeps living where
   *     it lives and only which tree points at it changed.
   *
   * References onto the SOURCE container are deliberately left alone here. A merge repoints
   * them because the absorbed home stops existing; a container that survives the departure
   * still has something to show, and `retireEmptiedInto` is what handles the one that does
   * not. An exchange always leaves both alive, which is why it never repoints at all.
   */
  private handOverOccupant(ref: TileRef, from: Room, to: Room): void {
    if (ref.kind === "terminal") {
      for (const leafId of terminalLeafIds(from.tileLayout(), ref.terminalId)) {
        from.removeTileLeafById(leafId);
      }
      return;
    }
    if (ref.kind === "text") {
      const note = from.element(ref.elementId);
      if (note === null) return;
      from.removeElementById(ref.elementId);
      to.adoptElement(note, note.x, note.y);
    }
  }

  /**
   * The merge itself: a terminal's old home hands it over to `toContainerId` and retires.
   * Shared by the tile drop and the canvas merge, because absorbing a solo composition is
   * one operation however the gesture spelled it.
   */
  private absorbHome(
    terminalId: string,
    source: SourceLocation,
    toContainerId: string,
    placementId: string,
  ): void {
    const homeId = source.homeId;
    if (homeId === null) return;
    const home = this.rooms.get(homeId);
    if (home !== null) {
      for (const leafId of terminalLeafIds(home.tileLayout(), terminalId)) {
        home.removeTileLeafById(leafId);
      }
    }
    this.terminals.rebindTerminal(terminalId, homeId, toContainerId, placementId);
    // The reference the drag was holding is consumed by the drop; the rest follow the item.
    if (
      source.discipline === "canvas" &&
      source.containerId !== null &&
      source.addressed !== null
    ) {
      this.rooms.get(source.containerId)?.removeElementById(source.addressed);
      this.afterLeaving(source.containerId);
    }
    this.retargetReferences(homeId, toContainerId);
    this.deleteIfEmptied(homeId);
    this.afterLeaving(homeId);
  }

  /**
   * Composition on a canvas: a ref dropped onto a reference merges the two.
   *
   * Dropping onto a reference to a COMPOSITION is not a merge — the portal already is a
   * composition, so the ref joins it as a plain tile. That recursion goes back through
   * `place`, so "compositions merge, never nest" stays a declaration (a `composition`
   * item denies with `not_solo`) rather than a branch here.
   *
   * Dropping onto a reference to a SOLO composition merges: one new composition is born
   * absorbing both items, the target's element is repointed at it keeping its exact
   * geometry, and both emptied homes retire. The newborn is named after what went into it.
   *
   * CENTER MEANS THIS EXACT SPOT, and on a canvas the spot IS the target's rectangle, so a
   * center release is not a merge at all: the two elements EXCHANGE seats. Ids, z-order,
   * selections, portal targets and a note's collaborative text stay exactly where they
   * are; only the two rectangles trade. That is why it is handled before anything about
   * merging is decided.
   */
  private executeCompose(
    ref: PlacementRef,
    item: PlacementItem,
    destination: {
      readonly containerId: string;
      readonly targetElementId: string;
      readonly edge: TileEdge;
    },
    source: SourceLocation,
  ): PlaceOutcome {
    const room = this.rooms.get(destination.containerId);
    if (room === null) return { status: "failed", failure: "not_found" };
    const target = room.element(destination.targetElementId);
    if (target === null) return { status: "failed", failure: "not_found" };
    // Two seats trading contents, whatever species sits in them: the exchange is defined
    // for any two canvas elements, so it is answered before the merge rules narrow the
    // target down to a reference.
    if (destination.edge === "center") {
      return this.executeCanvasSwap(ref, destination, source);
    }
    // Only a REFERENCE can be composed onto. Text and ink hold no item to merge with, and a
    // canvas has no terminal element to birth a composition around any more.
    if (target.type !== "portal") return { status: "failed", failure: "conflict" };
    const targetHomeId = target.containerId;
    const targetSolo = this.soloOccupant(targetHomeId);
    if (targetSolo === null) {
      const added = this.place({
        ref,
        destination: {
          kind: "tile",
          containerId: targetHomeId,
          targetTileId: null,
          edge: destination.edge,
        },
      });
      if (added.status !== "placed") return added;
      if (added.result.op !== "add_tile") return { status: "failed", failure: "conflict" };
      return {
        status: "placed",
        result: { op: "compose", containerId: targetHomeId, tileId: added.result.tileId },
      };
    }
    // Merging an item with itself is a degenerate identity, not a rule about kinds.
    if (item.containerId !== null && item.containerId === targetHomeId) {
      return { status: "failed", failure: "conflict" };
    }
    const targetRef = this.tileRefFor(targetSolo.item, {
      ...NO_SOURCE,
      containerId: targetHomeId,
      discipline: "composition",
      terminalId: targetSolo.terminalId,
      homeId: targetSolo.terminalId === null ? null : targetHomeId,
    });
    const dragged = this.tileRefFor(item, source);
    if (targetRef === null || dragged === null) {
      return { status: "failed", failure: "conflict" };
    }
    // A note carried as an ELEMENT is read before the write; one carried as a LEAF travels
    // with the leaf, so the same `fromLeaf` split the tile destination makes applies here.
    const fromLeaf = ref.kind === "tile" ? source.addressed : null;
    const note =
      fromLeaf === null && dragged.kind === "text"
        ? this.noteAt(source.containerId, dragged.elementId)
        : null;
    if (fromLeaf === null && dragged.kind === "text" && note === null) {
      return { status: "failed", failure: "not_found" };
    }

    const compositionId = this.runtime.newId();
    const name = `${this.refLabel(targetSolo.item, {
      ...NO_SOURCE,
      terminalId: targetSolo.terminalId,
      homeId: targetHomeId,
    })} + ${this.refLabel(item, source)}`;
    this.store.createContainer({
      id: compositionId,
      name: name.slice(0, MAX_CONTAINER_NAME),
      createdAt: this.runtime.now(),
      discipline: "composition",
    });
    const composition = this.rooms.get(compositionId);
    const rootTileId = composition?.placeTile(targetRef, null, null) ?? null;
    const addedTileId =
      composition === null || rootTileId === null
        ? null
        : composition.placeTile(dragged, rootTileId, destination.edge);
    if (composition === null || rootTileId === null || addedTileId === null) {
      // Nothing durable has moved yet, so the newborn row goes away with the failure.
      this.rooms.drop(compositionId);
      this.store.deleteContainer(compositionId);
      return { status: "failed", failure: "conflict" };
    }

    // The target's reference becomes a reference to the newborn IN PLACE, before its old
    // home retires — otherwise retiring the home would take this element with it.
    room.repointPortal(destination.targetElementId, compositionId);
    if (targetSolo.terminalId !== null) {
      /*
        The target went in FIRST, filling the root — and the dragged ref then SPLIT that
        root, which moves the root's occupant to a fresh leaf id. So `rootTileId` names the
        split now, not the terminal, and the id published to the composition has to be read
        back from the tree rather than remembered from before the split.
       */
      const targetTileId = tileIdForRef(composition.tileLayout(), targetRef) ?? rootTileId;
      this.absorbHome(
        targetSolo.terminalId,
        { ...NO_SOURCE, terminalId: targetSolo.terminalId, homeId: targetHomeId },
        compositionId,
        targetTileId,
      );
    } else {
      this.moveNonTerminalLeaf(targetHomeId, composition, compositionId);
    }
    const placedTileId =
      fromLeaf === null
        ? addedTileId
        : // A leaf that merged onto a canvas portal MOVES: the same subtraction, hand-over
          // and absorb-if-emptied a leaf gets at a tile destination, reached by the other
          // door. Its old container is only retired when the departure left it holding
          // nothing, which is what keeps a multi-tile source from being swallowed.
          this.finishLeafMove(dragged, source, composition, compositionId, addedTileId);
    if (placedTileId === null) return { status: "failed", failure: "conflict" };
    if (fromLeaf === null && dragged.kind === "terminal") {
      this.absorbHome(dragged.terminalId, source, compositionId, addedTileId);
    }
    // The note moves into the composition that now holds its leaf, exactly as it would for
    // a plain tile add: a merge is the same placement with a container born first.
    if (note !== null) this.adoptNote(source, note, composition);
    this.rooms.evictIfIdle(destination.containerId);
    return {
      status: "placed",
      result: { op: "compose", containerId: compositionId, tileId: placedTileId },
    };
  }

  /**
   * The canvas half of the center rule: two elements of ONE canvas exchange rectangles.
   *
   * The gesture must hold a canvas PLACEMENT of this canvas, because that placement is the
   * seat the target's occupant moves into. A sidebar row, a bare terminal id or a tile of
   * some composition names an item with no seat here to give back, so there is nothing to
   * exchange and the request is refused by name — the interface dissolves the center band
   * into its nearest edge for exactly those carries, and this rule is what keeps a
   * hand-written request honest.
   *
   * This is the door `not_swappable` belongs to, and after the displacement work the only
   * one that raises it. A canvas seat cannot be re-homed the way a leaf's occupant can: an
   * element IS its position on this canvas, so there is no "somewhere else" to put the
   * thing that was here, and the refusal is the honest answer rather than a `replace`.
   *
   * Nothing about either item's home changes: a portal still points where it pointed and a
   * note still lives in this document. Only the two rectangles move, which is why this is
   * one patch of four fields per element and not a re-authoring of either.
   */
  private executeCanvasSwap(
    ref: PlacementRef,
    destination: { readonly containerId: string; readonly targetElementId: string },
    source: SourceLocation,
  ): PlaceOutcome {
    if (
      ref.kind !== "element" ||
      source.discipline !== "canvas" ||
      source.containerId !== destination.containerId ||
      source.addressed === null
    ) {
      return {
        status: "denied",
        denial: {
          rule: "not_swappable",
          ref,
          container: { kind: "composition", containerId: destination.containerId },
        },
      };
    }
    // Trading a seat with itself is the silent no-op the algebra refuses to have.
    if (source.addressed === destination.targetElementId) {
      return { status: "failed", failure: "conflict" };
    }
    const room = this.rooms.get(destination.containerId);
    if (room === null) return { status: "failed", failure: "not_found" };
    if (!room.swapElementGeometry(source.addressed, destination.targetElementId)) {
      return { status: "failed", failure: "not_found" };
    }
    this.rooms.evictIfIdle(destination.containerId);
    return {
      status: "placed",
      result: {
        op: "swap",
        placementId: source.addressed,
        withPlacementId: destination.targetElementId,
      },
    };
  }

  /**
   * Hands a solo composition's NON-terminal occupant over to the composition absorbing it:
   * an embedded canvas is a reference, so only the leaf moves, while a note's element has to
   * travel between documents the way any note does.
   */
  private moveNonTerminalLeaf(fromContainerId: string, target: Room, toContainerId: string): void {
    const from = this.rooms.get(fromContainerId);
    if (from !== null) {
      const layout = from.tileLayout();
      for (const leafId of layout === null ? [] : tileLeafIds(layout)) {
        const occupant = layout?.[leafId]?.ref ?? null;
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
    this.retargetReferences(fromContainerId, toContainerId);
    this.deleteIfEmptied(fromContainerId);
    this.afterLeaving(fromContainerId);
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
    ref: PlacementRef,
    destination: { readonly containerId: string; readonly x: number; readonly y: number },
    source: SourceLocation,
  ): PlaceOutcome {
    const containerId = source.containerId;
    const tileId = source.addressed;
    if (containerId === null || tileId === null) {
      return { status: "failed", failure: "not_found" };
    }
    const composition = this.rooms.get(containerId);
    const canvas = this.rooms.get(destination.containerId);
    if (composition === null || canvas === null) return { status: "failed", failure: "not_found" };
    const occupant = composition.tileLayout()?.[tileId]?.ref ?? null;
    // An empty leaf holds no item: extracting it would author nothing, which is exactly the
    // silent no-op the algebra refuses to have.
    if (occupant === null) return { status: "failed", failure: "conflict" };
    const wasSolo = composition.census().items.length === 1;

    if (occupant.kind === "terminal") {
      if (wasSolo) {
        const elementId = canvas.placePortalElement(containerId, destination.x, destination.y);
        this.rooms.evictIfIdle(destination.containerId);
        return { status: "placed", result: { op: "extract", elementId } };
      }
      // The re-homing itself: the new home is built BEFORE the old leaf goes, so a tree
      // that refuses the write leaves the terminal where it was rather than nowhere. It is
      // the same displacement a center drop makes, reached by the canvas door.
      const evicted = this.evictLeaf(composition, containerId, tileId, ref);
      if ("status" in evicted) return evicted;
      const { homeId, leafId } = evicted;
      if (homeId === null || leafId === null || !composition.removeTileLeafById(tileId)) {
        this.dropEvictedHome(evicted);
        return { status: "failed", failure: "conflict" };
      }
      this.terminals.rebindTerminal(occupant.terminalId, containerId, homeId, leafId);
      const elementId = canvas.placePortalElement(homeId, destination.x, destination.y);
      this.deleteIfEmptied(containerId);
      this.afterLeaving(containerId);
      this.rooms.evictIfIdle(destination.containerId);
      return { status: "placed", result: { op: "extract", elementId } };
    }
    // A panel is a rendering of a plugin contribution, not an object with a document, so
    // there is nothing to author on a canvas for it. Unreachable through the door — a canvas
    // refuses panels by group containment — and refused here too, before the leaf is
    // removed, so a hand-written tree holding one cannot be emptied by a failed extract.
    if (occupant.kind === "panel") return { status: "failed", failure: "conflict" };

    if (!composition.removeTileLeafById(tileId)) return { status: "failed", failure: "conflict" };
    if (occupant.kind === "text") {
      const note = composition.element(occupant.elementId);
      if (note === null || note.type !== "text") return { status: "failed", failure: "not_found" };
      composition.removeElementById(occupant.elementId);
      canvas.adoptElement(note, destination.x, destination.y);
      this.deleteIfEmptied(containerId);
      this.afterLeaving(containerId);
      this.rooms.evictIfIdle(destination.containerId);
      return { status: "placed", result: { op: "extract", elementId: occupant.elementId } };
    }
    const elementId = canvas.placePortalElement(occupant.containerId, destination.x, destination.y);
    this.deleteIfEmptied(containerId);
    this.afterLeaving(containerId);
    this.rooms.evictIfIdle(destination.containerId);
    return { status: "placed", result: { op: "extract", elementId } };
  }

  /**
   * Removes one leaf (`DELETE /api/containers/:id/tiles/:tileId`). Removal is NOT a
   * placement, and it is deliberately not what `tile -> unplaced` means: releasing a leaf
   * RE-HOMES its occupant, while closing one DESTROYS it. Two verbs, two doors, and the
   * destructive one is never reached by a drag.
   *
   * Removing a terminal's LAST home leaf destroys the terminal. That is deliberate and it
   * is the only honest reading of the model: a terminal lives in exactly one composition,
   * there is no pool to fall back into, and the operator who closed its last tile closed the
   * terminal. A composition emptied this way retires with it.
   */
  removeTile(containerId: string, tileId: string): "ok" | PlaceFailure {
    const container = this.store.getContainer(containerId);
    if (container === null) return "not_found";
    if (container.discipline !== "composition") return "conflict";
    const room = this.rooms.get(containerId);
    if (room === null) return "not_found";
    const tile = room.tileLayout()?.[tileId];
    if (tile === undefined) return "not_found";
    if (tile.dir !== null) return "conflict";
    const occupant = tile.ref;
    if (!room.removeTileLeafById(tileId)) return "conflict";
    if (
      occupant !== null &&
      occupant.kind === "terminal" &&
      !room.homesTerminal(occupant.terminalId)
    ) {
      this.terminals.reapTerminal(occupant.terminalId);
    }
    // A note's leaf IS its only placement, and a composition renders only its layout, so
    // leaving the element behind would be invisible garbage.
    if (occupant !== null && occupant.kind === "text") room.removeElementById(occupant.elementId);
    if (occupant !== null) this.deleteIfEmptied(containerId);
    this.afterLeaving(containerId);
    return "ok";
  }

  /**
   * Removes a terminal from the world. `core.terminals.kill`, `terminal_kill` and a
   * titlebar close all land here, and all three mean the same thing: a DELIBERATE kill is
   * total and it is one step — every leaf its home holds for it, its row and its PTY,
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
  killTerminal(terminalId: string): "ok" | "not_found" {
    const placed = this.terminals.placedTerminal(terminalId);
    if (placed === null) return "not_found";
    const room = this.rooms.get(placed.containerId);
    if (room === null) {
      // A home whose row is already gone cannot be asked what it still holds; the terminal
      // has nowhere left to live either way, so it dies rather than becoming an orphan.
      this.terminals.reapTerminal(terminalId);
      return "ok";
    }
    for (const tileId of terminalLeafIds(room.tileLayout(), terminalId)) {
      room.removeTileLeafById(tileId);
    }
    // The row goes before the home is judged: `deleteIfEmptied` asks what the container
    // holds NOW, and a composition still listing the terminal it just lost would survive.
    this.terminals.reapTerminal(terminalId);
    this.deleteIfEmptied(placed.containerId);
    this.afterLeaving(placed.containerId);
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
  createHome(homeId: string, terminalId: string, name: string): string | null {
    this.store.createContainer({
      id: homeId,
      name: name.slice(0, MAX_CONTAINER_NAME),
      createdAt: this.runtime.now(),
      discipline: "composition",
    });
    const leafId = this.rooms.get(homeId)?.placeTerminalTile(terminalId, null, null) ?? null;
    if (leafId === null) {
      this.rooms.drop(homeId);
      this.store.deleteContainer(homeId);
      return null;
    }
    return leafId;
  }

  /**
   * A terminal's home retires with the terminal. Called when a terminal is forgotten, so an
   * exited terminal the operator dismissed leaves neither a row in the index nor a portal
   * pointing at one.
   */
  retireHome(containerId: string): void {
    const container = this.store.getContainer(containerId);
    if (container === null || container.discipline !== "composition") return;
    const room = this.rooms.get(containerId);
    if (room === null || room.census().items.length > 0) return;
    this.deleteContainer(containerId);
  }
}
