import {
  MAX_DOC_UPDATE_BYTES,
  PROTOCOL_VERSION,
  ROOT_TILE_ID,
  compareElements,
  type CensusItem,
  type ClientMessageBody,
  type ContainerCensus,
  type PadPresence,
  type PresencePayload,
  type PresenceState,
  type Principal,
  type RuntimeDeps,
  type SceneElement,
  type SessionInfo,
  type TileEdge,
  type TileLayout,
  type TileSurface,
} from "@manifold/protocol";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  REPAIR_ORIGIN,
  SERVER_PLACE_ORIGIN,
  Y,
  changedElementIds,
  createSceneDoc,
  decodeUpdate,
  elementsMap,
  encodeUpdate,
  initTiledLayout,
  nextZIndex,
  patchElement,
  readElement,
  readElements,
  readTileLayout,
  removeElement,
  removeTileLeaf,
  swapTileLeaves,
  writeElement,
  writeTileLeaf,
  writeTileLeafSurface,
} from "@manifold/scene";
import type { Logger } from "./log.ts";
import {
  SESSION_TRANSPORT_PAYLOAD_BYTES,
  serializeServerMessage,
  type ChannelMessage,
  type SessionPeer,
} from "./session-peer.ts";
import type { ServerStore } from "./stores.ts";

const QUIET_SAVE_MS = 1_500;
const MAX_SAVE_MS = 10_000;

/**
 * The census of one container, derived from its document alone: a tiled container is
 * counted by its occupied leaves, a canvas by its elements. Free of `Room` so the same
 * derivation serves a resident room and a pad whose document is only on disk — two
 * answers to "what does this container hold" would be two answers too many.
 */
export function censusFor(
  padId: string,
  layout: TileLayout | null,
  elements: readonly SceneElement[],
): ContainerCensus {
  const items: CensusItem[] = [];
  const references: string[] = [];
  if (layout === null) {
    for (const element of elements) {
      if (element.type !== "portal") {
        items.push({ kind: element.type, containerId: null, sessionId: null });
        continue;
      }
      references.push(element.containerId);
      items.push({ kind: "view", containerId: element.containerId, sessionId: null });
    }
  } else {
    for (const node of Object.values(layout)) {
      const surface = node.surface;
      if (surface === null) continue;
      if (surface.kind === "terminal") {
        // A leaf holding a terminal is the only place a session's home is written down, so
        // the census carries the session id: the index needs it to join a solo composition
        // row to the terminal wearing it.
        items.push({ kind: "terminal", containerId: null, sessionId: surface.sessionId });
        continue;
      }
      if (surface.kind === "pad") {
        references.push(surface.padId);
        items.push({ kind: "canvas-pad", containerId: surface.padId, sessionId: null });
        continue;
      }
      items.push({ kind: "text", containerId: null, sessionId: null });
    }
  }
  return { padId, layout: layout === null ? "canvas" : "tiled", items, references };
}

/**
 * Leaves 4 MiB of the WebSocket transport ceiling for the init envelope, roster, and
 * sessions while allowing canonical documents substantially larger than one client update.
 */
export const DOC_BYTES_LIMIT = 12 * 1_048_576;
const DOC_UPDATES_PER_SECOND = 120;
const DOC_UPDATE_BURST = 240;

// A room is joined by PEERS, and a peer is one channel: routing is already consumed, so
// the payloads a room applies and relays are channel-agnostic bodies.
type DocUpdate = Extract<ClientMessageBody, { type: "doc_update" }>;
type CursorUpdate = Extract<ClientMessageBody, { type: "cursor" }>;
type GestureUpdate = Extract<ClientMessageBody, { type: "gesture" }>;

/** Timer seam whose returned cancellation closures avoid platform-specific handle types. */
export interface RoomTimers {
  schedule(callback: () => void, delayMs: number): () => void;
}

/** Production wall-clock scheduler for room snapshot debounce. */
export const defaultRoomTimers: RoomTimers = {
  schedule(callback, delayMs): () => void {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

/**
 * Why a room reported itself empty. `occupants` is the lifecycle event — the last real
 * member walked out, so the bubble rule runs. `sockets` says only that the last WATCHER
 * of an already-unoccupied room hung up: nothing happened socially, the room merely stops
 * being resident. Keeping them apart is load-bearing: a widget preview closing must never
 * pop somebody's newborn bubble.
 */
export type RoomEmptyReason = "occupants" | "sockets";

/** Canonical in-memory Yjs document and ephemeral membership for one persisted pad. */
export class Room {
  readonly doc = createSceneDoc();
  readonly epoch: string;
  rev: number;

  private readonly connections = new Map<string, Set<SessionPeer>>();
  /**
   * Watching sockets, kept apart from `connections` on purpose: they are not principals
   * in this room. Everything membership means — roster fan-out, presence, the join/leave
   * events, and the room-empty hook that pops a bubble — reads `connections`, while
   * everything transport means — broadcast, close, eviction residency — reads both.
   */
  private readonly spectators = new Set<SessionPeer>();
  private readonly presences = new Map<string, PresencePayload>();
  private readonly updateBuckets = new Map<string, { tokens: number; at: number }>();
  private dirty = false;
  private cancelQuiet: (() => void) | null = null;
  private cancelMax: (() => void) | null = null;
  private collectingIds: Set<string> | null = null;
  private docBytes = 0;
  private overLimit = false;

  constructor(
    readonly padId: string,
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly sessions: () => readonly SessionInfo[],
    private readonly onEmpty: (room: Room, reason: RoomEmptyReason) => void,
  ) {
    const record = store.latestDoc(padId, (error, invalid) => {
      logger.error("scene_doc_load_skipped", {
        padId,
        epoch: invalid.epoch,
        rev: invalid.rev,
        error: error.message,
      });
    });
    this.epoch = record?.epoch ?? runtime.newId();
    this.rev = record?.rev ?? 0;
    if (record !== null) Y.applyUpdate(this.doc, record.doc);
    this.docBytes = Y.encodeStateAsUpdate(this.doc).byteLength;
    this.overLimit = this.docBytes > DOC_BYTES_LIMIT;

    elementsMap(this.doc).observeDeep((events) => {
      if (this.collectingIds === null) return;
      for (const id of changedElementIds(events as unknown as readonly Y.YEvent<never>[])) {
        this.collectingIds.add(id);
      }
    });
    this.doc.on("update", (update, origin) => {
      this.rev += 1;
      this.broadcast({
        type: "doc_update",
        update: encodeUpdate(update),
        by: origin === REPAIR_ORIGIN || typeof origin !== "string" ? "server" : origin,
      });
      this.scheduleSnapshot();
    });

    // A tiled container renders its layout tree, so the tree must exist before the
    // first peer joins. The discipline lives on the pad row, and seeding is
    // idempotent, so a container loaded from a snapshot keeps its stored tree.
    if (store.getPad(padId)?.layout === "tiled") {
      initTiledLayout(this.doc, SERVER_PLACE_ORIGIN);
    }
  }

  private roster(): PresenceState[] {
    const result: PresenceState[] = [];
    for (const [principalId, peers] of this.connections) {
      const first = peers.values().next().value;
      if (first === undefined) continue;
      result.push({
        principal: first.auth.principal,
        connections: peers.size,
        connIds: [...peers].map((connected) => connected.id),
        payload: this.presences.get(principalId) ?? {},
      });
    }
    return result.sort((left, right) => left.principal.id.localeCompare(right.principal.id));
  }

  private stateMessage(type: "init" | "resync", peer: SessionPeer): ChannelMessage {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      epoch: this.epoch,
      rev: this.rev,
      doc: encodeUpdate(Y.encodeStateAsUpdate(this.doc)),
      self: peer.auth.principal,
      selfCaps: [...peer.auth.caps],
      selfConnId: peer.id,
      roster: this.roster(),
      sessions: [...this.sessions()],
    };
  }

  private sendState(type: "init" | "resync", peer: SessionPeer): boolean {
    const frame = serializeServerMessage(this.stateMessage(type, peer));
    if (frame.bytes > SESSION_TRANSPORT_PAYLOAD_BYTES) {
      this.logger.error("scene_state_exceeds_transport", {
        padId: this.padId,
        type,
        bytes: frame.bytes,
        limit: SESSION_TRANSPORT_PAYLOAD_BYTES,
      });
      peer.send({
        type: "error",
        code: "invalid",
        message: "scene too large to initialize",
      });
      peer.close(1009, "initial state exceeds transport limit");
      return false;
    }
    return peer.sendSerialized(frame);
  }

  /** Registers a tab, sends init first, then publishes principal-level roster deltas. */
  join(peer: SessionPeer): boolean {
    if (peer.spectator) {
      // A watcher receives the same authoritative state (its preview IS this room) and
      // nothing else: no roster entry, no presence slot, no principal_joined event.
      this.spectators.add(peer);
      if (!this.sendState("init", peer)) {
        this.spectators.delete(peer);
        return false;
      }
      return true;
    }
    const principalId = peer.auth.principal.id;
    let peers = this.connections.get(principalId);
    const firstConnection = peers === undefined;
    if (peers === undefined) {
      peers = new Set();
      this.connections.set(principalId, peers);
      this.presences.set(principalId, {});
    }
    peers.add(peer);
    if (!this.sendState("init", peer)) {
      peers.delete(peer);
      if (peers.size === 0) {
        this.connections.delete(principalId);
        this.presences.delete(principalId);
      }
      return false;
    }
    const joined: PresenceState = {
      principal: peer.auth.principal,
      connections: peers.size,
      connIds: [...peers].map((connected) => connected.id),
      payload: this.presences.get(principalId) ?? {},
    };
    this.broadcast({ type: "roster", joined }, false, peer);
    if (firstConnection) {
      this.store.addEvent(this.padId, this.runtime.now(), principalId, "principal_joined", {});
    }
    return true;
  }

  /** Removes a tab and expires principal presence only after its final connection leaves. */
  leave(peer: SessionPeer): void {
    if (peer.spectator) {
      if (!this.spectators.delete(peer)) return;
      // A watcher hanging up is not a departure: the bubble rule must NOT run here, or a
      // preview closing would pop a container nobody ever occupied — the newborn-expand
      // race. Reporting it at all only lets an unoccupied room stop being resident.
      if (!this.hasConnections()) this.onEmpty(this, "sockets");
      return;
    }
    const principalId = peer.auth.principal.id;
    const peers = this.connections.get(principalId);
    if (peers === undefined || !peers.delete(peer)) return;
    this.updateBuckets.delete(peer.id);
    if (peers.size === 0) {
      this.connections.delete(principalId);
      this.presences.delete(principalId);
      this.broadcast({ type: "roster", left: { principalId } });
      this.store.addEvent(this.padId, this.runtime.now(), principalId, "principal_left", {});
      if (this.connections.size === 0) this.onEmpty(this, "occupants");
      return;
    }
    const first = peers.values().next().value;
    if (first !== undefined) {
      this.broadcast({
        type: "roster",
        joined: {
          principal: first.auth.principal,
          connections: peers.size,
          connIds: [...peers].map((connected) => connected.id),
          payload: this.presences.get(principalId) ?? {},
        },
      });
    }
  }

  /** Emits a full state replacement to one connection. */
  sendResync(peer: SessionPeer): void {
    this.sendState("resync", peer);
  }

  private consumeDocUpdate(peer: SessionPeer): boolean {
    const now = this.runtime.now();
    const previous = this.updateBuckets.get(peer.id) ?? {
      tokens: DOC_UPDATE_BURST,
      at: now,
    };
    const elapsed = Math.max(0, now - previous.at);
    const tokens = Math.min(
      DOC_UPDATE_BURST,
      previous.tokens + (elapsed * DOC_UPDATES_PER_SECOND) / 1_000,
    );
    if (tokens < 1) {
      this.updateBuckets.set(peer.id, { tokens, at: now });
      return false;
    }
    this.updateBuckets.set(peer.id, { tokens: tokens - 1, at: now });
    return true;
  }

  /** Applies one bounded update, then repairs schema-invalid element projections. */
  applyDocUpdate(peer: SessionPeer, encoded: DocUpdate["update"]): boolean {
    let update: Uint8Array;
    try {
      update = decodeUpdate(encoded);
    } catch {
      peer.send({ type: "error", code: "invalid", message: "invalid doc update" });
      return false;
    }
    if (update.byteLength > MAX_DOC_UPDATE_BYTES) {
      peer.send({ type: "error", code: "invalid", message: "doc update too large" });
      return false;
    }
    if (!this.consumeDocUpdate(peer)) {
      peer.send({ type: "error", code: "rate_limited", message: "doc update rate limit exceeded" });
      return false;
    }
    if (this.overLimit) {
      peer.send({ type: "error", code: "invalid", message: "scene too large" });
      return false;
    }

    const changed = new Set<string>();
    this.collectingIds = changed;
    try {
      Y.applyUpdate(this.doc, update, peer.auth.principal.id);
    } catch {
      peer.send({ type: "error", code: "invalid", message: "invalid doc update" });
      return false;
    } finally {
      this.collectingIds = null;
    }

    for (const id of changed) {
      if (readElement(this.doc, id) === null && removeElement(this.doc, id, REPAIR_ORIGIN)) {
        this.logger.warn("scene_element_repaired", { padId: this.padId, id });
      }
    }
    return true;
  }

  /**
   * Merges ephemeral presence while stamping the authenticated principal id.
   *
   * `spotlight` is SERVER-WRITTEN ONLY and is dropped here whatever a client sends. It says
   * "another principal asked you to look at this", and its whole value is that the ask
   * carried an authority check — `core.presence.focus` verified a shared room and
   * `scene:write` before writing one. A peer allowed to set it on itself could set it on
   * anybody by claiming a principal it is not, so the field simply never crosses inbound.
   */
  updatePresence(peer: SessionPeer, payload: PresencePayload): void {
    const principalId = peer.auth.principal.id;
    const client: PresencePayload = { ...payload };
    delete client.spotlight;
    const current = this.presences.get(principalId) ?? {};
    this.presences.set(principalId, { ...current, ...client });
    this.broadcast({ type: "presence", principalId, connId: peer.id, payload: client });
  }

  /** Whether a principal currently OCCUPIES this room; a spectator never does. */
  hasPrincipal(principalId: string): boolean {
    return this.connections.has(principalId);
  }

  /**
   * Writes a spotlight into one occupant's presence and fans it out. Nobody is excluded —
   * least of all the target, which is the peer that has to act on it — and the frame is
   * attributed to the target's own first connection because presence is principal-level
   * state and there is no reporting socket behind a server write.
   */
  writeSpotlight(principalId: string, spotlight: { uri: string; from: string }): boolean {
    const peers = this.connections.get(principalId);
    const first = peers?.values().next().value;
    if (first === undefined) return false;
    const current = this.presences.get(principalId) ?? {};
    this.presences.set(principalId, { ...current, spotlight });
    this.broadcast({ type: "presence", principalId, connId: first.id, payload: { spotlight } });
    return true;
  }

  /** Relays high-rate cursor motion with droppable delivery under socket pressure. */
  relayCursor(peer: SessionPeer, cursor: CursorUpdate): void {
    this.broadcast(
      {
        type: "cursor",
        principalId: peer.auth.principal.id,
        connId: peer.id,
        x: cursor.x,
        y: cursor.y,
      },
      true,
    );
  }
  /**
   * Relays high-rate gesture motion with droppable delivery under socket pressure. The
   * outbound frame names its fields rather than spreading the inbound one: the client
   * frame arrives with routing attached, and a broadcast body must carry none.
   */
  relayGesture(peer: SessionPeer, gesture: GestureUpdate): void {
    this.broadcast(
      {
        type: "gesture",
        principalId: peer.auth.principal.id,
        connId: peer.id,
        kind: gesture.kind,
        phase: gesture.phase,
        elementId: gesture.elementId,
        x: gesture.x,
        y: gesture.y,
        ...(gesture.width === undefined ? {} : { width: gesture.width }),
        ...(gesture.height === undefined ? {} : { height: gesture.height }),
        ...(gesture.points === undefined ? {} : { points: gesture.points }),
        ...(gesture.carry === undefined ? {} : { carry: gesture.carry }),
      },
      true,
    );
  }

  /** Broadcasts one schema serialization to all current room members. */
  broadcast(message: ChannelMessage, droppable = false, except?: SessionPeer): void {
    const frame = serializeServerMessage(message);
    for (const peers of this.connections.values()) {
      for (const peer of peers) {
        if (peer !== except) peer.sendSerialized(frame, droppable);
      }
    }
    for (const peer of this.spectators) {
      if (peer !== except) peer.sendSerialized(frame, droppable);
    }
  }

  private scheduleSnapshot(): void {
    this.dirty = true;
    this.cancelQuiet?.();
    this.cancelQuiet = this.timers.schedule(() => {
      this.cancelQuiet = null;
      this.flushFromTimer("quiet");
    }, QUIET_SAVE_MS);
    if (this.cancelMax === null) {
      this.cancelMax = this.timers.schedule(() => {
        this.cancelMax = null;
        this.flushFromTimer("maximum");
      }, MAX_SAVE_MS);
    }
  }

  private flushFromTimer(cadence: "quiet" | "maximum"): void {
    try {
      this.flushSnapshot();
    } catch (error) {
      this.logger.error("scene_doc_save_failed", {
        padId: this.padId,
        cadence,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      if (this.dirty) this.scheduleSnapshot();
    }
  }

  /** Persists dirty canonical state immediately and emits the durable revision watermark. */
  flushSnapshot(): boolean {
    if (!this.dirty) return false;
    const at = this.runtime.now();
    const doc = Y.encodeStateAsUpdate(this.doc);
    this.docBytes = doc.byteLength;
    this.overLimit = this.docBytes > DOC_BYTES_LIMIT;
    if (this.overLimit) {
      this.logger.warn("scene_doc_over_limit", {
        padId: this.padId,
        bytes: this.docBytes,
        limit: DOC_BYTES_LIMIT,
      });
    }
    this.store.saveDoc(this.padId, this.epoch, this.rev, at, doc);
    this.dirty = false;
    this.cancelQuiet?.();
    this.cancelMax?.();
    this.cancelQuiet = null;
    this.cancelMax = null;
    this.broadcast({ type: "saved", rev: this.rev, at });
    return true;
  }

  /** Cancels persistence callbacks when the room can no longer safely touch its store. */
  cancelSnapshotTimers(): void {
    this.cancelQuiet?.();
    this.cancelMax?.();
    this.cancelQuiet = null;
    this.cancelMax = null;
  }

  /**
   * Closes every member when a pad is deleted or the process shuts down. Membership is
   * dropped BEFORE the channels are told, because a channel close now calls back into
   * `leave` (the gateway retires the channel record): a room that is being demolished
   * must not publish departures, write events for a row that may already be gone, or
   * fire the room-empty hook on its way out.
   */
  closeAll(code: number, reason: string): void {
    this.cancelSnapshotTimers();
    const members: SessionPeer[] = [];
    for (const peers of this.connections.values()) members.push(...peers);
    members.push(...this.spectators);
    this.connections.clear();
    this.spectators.clear();
    this.presences.clear();
    this.updateBuckets.clear();
    for (const peer of members) peer.close(code, reason);
  }

  /** Whether any socket — occupant or watcher — still holds this room resident. */
  hasConnections(): boolean {
    return this.connections.size > 0 || this.spectators.size > 0;
  }

  /**
   * Whether any socket actually OCCUPIES this room, as opposed to watching it. A portal
   * widget's live preview holds a real socket without being anybody's presence, so the two
   * questions have to stay separate even though nothing dissolves on emptiness any more.
   */
  hasOccupants(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Whether this container HOMES a session — holds a tile leaf for it. Only a composition
   * can: a canvas references a terminal through a portal onto its home, so a canvas has
   * nothing to say about where a session lives.
   */
  homesSession(sessionId: string): boolean {
    const layout = readTileLayout(this.doc);
    if (layout === null) return false;
    for (const node of Object.values(layout)) {
      const surface = node.surface;
      if (surface !== null && surface.kind === "terminal" && surface.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  /** The tiled layout tree, or null for a canvas (and for a tree that fails validation). */
  tileLayout(): TileLayout | null {
    return readTileLayout(this.doc, this.padId);
  }

  /** One element projection, or null when it is absent or schema-invalid. */
  element(elementId: string): SceneElement | null {
    return readElement(this.doc, elementId);
  }

  /** Every element in canonical paint order. */
  elements(): SceneElement[] {
    return [...readElements(this.doc).values()].sort(compareElements);
  }

  /**
   * Every portal onto `containerId`, in canonical paint order. A container can be
   * referenced from one canvas several times, and releasing the ITEM has to reach all of
   * them; addressing a single REFERENCE names its element id instead.
   */
  portalIdsTo(containerId: string): string[] {
    const ids: string[] = [];
    for (const element of this.elements()) {
      if (element.type === "portal" && element.containerId === containerId) ids.push(element.id);
    }
    return ids;
  }

  /**
   * Places a surface in this container's layout tree under `SERVER_PLACE_ORIGIN`, so
   * the doc-update hook fans it out and client undo managers never capture it.
   * A null target fills the first empty leaf, else splits the root to the right;
   * a null edge fills an empty target leaf, else splits that leaf to the right.
   * Returns the placement's tile id, or null when the tree rejects the write.
   */
  placeTile(
    surface: TileSurface,
    targetTileId: string | null,
    edge: TileEdge | null,
    between = false,
  ): string | null {
    const layout = this.tileLayout();
    if (layout === null) return null;
    const target =
      targetTileId ??
      Object.values(layout).find((node) => node.dir === null && node.surface === null)?.id ??
      ROOT_TILE_ID;
    const node = layout[target];
    if (node === undefined) return null;
    const resolved = edge ?? (node.dir === null && node.surface === null ? "center" : "right");
    return writeTileLeaf(this.doc, surface, target, resolved, SERVER_PLACE_ORIGIN, between);
  }

  /** Places a terminal surface; the returned tile id IS the session's placement id. */
  placeTerminalTile(
    sessionId: string,
    targetTileId: string | null,
    edge: TileEdge | null,
  ): string | null {
    return this.placeTile({ kind: "terminal", sessionId }, targetTileId, edge);
  }

  /** Removes one tile leaf, collapsing the split it leaves behind. */
  removeTileLeafById(tileId: string): boolean {
    return removeTileLeaf(this.doc, tileId, SERVER_PLACE_ORIGIN);
  }

  /**
   * Exchanges two leaves' occupants inside this container, in one server-origin write.
   * What a CENTER drop means when the spot it pointed at is already taken: the seats stay
   * where they are and their contents trade places.
   */
  swapTileLeavesById(aTileId: string, bTileId: string): boolean {
    return swapTileLeaves(this.doc, aTileId, bTileId, SERVER_PLACE_ORIGIN);
  }

  /**
   * Writes one leaf's occupant. This is the per-room half of an exchange that crosses two
   * containers: two documents cannot share a transaction, so each side writes its own new
   * occupant and fans its own update out. Inside one container `swapTileLeavesById` is the
   * whole operation.
   */
  setTileSurface(tileId: string, surface: TileSurface | null): boolean {
    return writeTileLeafSurface(this.doc, tileId, surface, SERVER_PLACE_ORIGIN);
  }

  /**
   * Exchanges two elements' geometry in ONE transaction, so collaborators see both seats
   * change together rather than watching one element land on top of the other. Everything
   * that is not a rectangle is untouched — ids, z-order, portal targets and a note's
   * collaborative text — which is what makes this an exchange of SEATS and not of objects,
   * and why it patches fields instead of re-authoring the elements.
   */
  swapElementGeometry(aElementId: string, bElementId: string): boolean {
    if (aElementId === bElementId) return false;
    const a = readElement(this.doc, aElementId);
    const b = readElement(this.doc, bElementId);
    if (a === null || b === null) return false;
    this.doc.transact(() => {
      patchElement(
        this.doc,
        aElementId,
        { x: b.x, y: b.y, width: b.width, height: b.height },
        SERVER_PLACE_ORIGIN,
      );
      patchElement(
        this.doc,
        bElementId,
        { x: a.x, y: a.y, width: a.width, height: a.height },
        SERVER_PLACE_ORIGIN,
      );
    }, SERVER_PLACE_ORIGIN);
    return true;
  }

  /**
   * Repoints a portal at a different container, keeping the element id and geometry. This
   * is what a merge does to the references of an absorbed composition: the canvas kept
   * showing the same item, so the widget must not jump, blink, or be re-authored under a
   * new id that collaborators' selections would lose.
   */
  repointPortal(elementId: string, containerId: string): boolean {
    const element = readElement(this.doc, elementId);
    if (element === null || element.type !== "portal") return false;
    if (element.containerId === containerId) return true;
    writeElement(this.doc, { ...element, containerId }, SERVER_PLACE_ORIGIN);
    return true;
  }

  /**
   * Removes every portal onto `containerId`. Called when a container stops existing —
   * absorbed by a merge, or emptied by extraction — so a reference to a deleted container
   * is a state the workspace simply cannot reach. This is the general rule that replaced
   * the bubble's single stored return address.
   */
  removePortalsTo(containerId: string): number {
    let removed = 0;
    for (const id of this.portalIdsTo(containerId)) {
      if (removeElement(this.doc, id, SERVER_PLACE_ORIGIN)) removed += 1;
    }
    return removed;
  }

  /**
   * Authors a portal element onto `containerId` at the drop point: what it means for a
   * container to land on a canvas. It is a REFERENCE, never a copy — the container keeps
   * living where it lives, and cycles are legal because portals navigate.
   */
  placePortalElement(containerId: string, x: number, y: number): string {
    const id = crypto.randomUUID();
    writeElement(
      this.doc,
      {
        id,
        type: "portal",
        containerId,
        x,
        y,
        // A widget frames a terminal-sized surface, so a fresh portal borrows that size.
        width: DEFAULT_TERMINAL_WIDTH,
        height: DEFAULT_TERMINAL_HEIGHT,
        zIndex: nextZIndex(this.doc),
      },
      SERVER_PLACE_ORIGIN,
    );
    return id;
  }

  /**
   * Re-authors an element at a new position, keeping its id and everything else. This is
   * how a plain canvas item repositions inside the canvas it already lives on: same
   * element, new coordinates, one server-origin transaction.
   */
  moveElement(elementId: string, x: number, y: number): boolean {
    const element = readElement(this.doc, elementId);
    if (element === null) return false;
    writeElement(this.doc, { ...element, x, y }, SERVER_PLACE_ORIGIN);
    return true;
  }

  /**
   * Adopts an element that left another canvas: the same item, its own id preserved so
   * collaborators' selections and references still name it, placed at the drop point and
   * lifted to the top of THIS canvas's stack.
   */
  adoptElement(element: SceneElement, x: number, y: number): void {
    writeElement(this.doc, { ...element, x, y, zIndex: nextZIndex(this.doc) }, SERVER_PLACE_ORIGIN);
  }

  /** Removes one element the server placed or is releasing; the update hook broadcasts it. */
  removeElementById(elementId: string): boolean {
    return removeElement(this.doc, elementId, SERVER_PLACE_ORIGIN);
  }

  /** This container's census, from its live document. */
  census(): ContainerCensus {
    return censusFor(this.padId, this.tileLayout(), this.elements());
  }

  /** Returns the principal-level live roster without cursor or viewport payloads. */
  livePrincipals(): Principal[] {
    const principals: Principal[] = [];
    for (const peers of this.connections.values()) {
      const first = peers.values().next().value;
      if (first !== undefined) principals.push(first.auth.principal);
    }
    return principals.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Safe live-room summary for root introspection; no presence payloads or secrets. */
  introspect(): Record<string, unknown> {
    let connectionCount = 0;
    for (const peers of this.connections.values()) connectionCount += peers.size;
    return {
      padId: this.padId,
      epoch: this.epoch,
      rev: this.rev,
      elements: readElements(this.doc).size,
      docBytes: this.docBytes,
      principals: this.connections.size,
      connections: connectionCount,
      spectators: this.spectators.size,
    };
  }
}

/** Lazily loads rooms and coordinates snapshot flush/delete across all active pads. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /**
   * Censuses of pads with no resident room, keyed by pad id and fenced by the document
   * revision they were derived from. Decoding every stored document on every index poll
   * would be pure waste: the revision is one cheap SQL read, and a document that has not
   * moved cannot have changed what it holds.
   */
  private readonly censusCache = new Map<
    string,
    { readonly rev: number; readonly census: ContainerCensus }
  >();
  private sessionProvider: (padId: string) => readonly SessionInfo[] = () => [];
  private pendingOpenProvider: (padId: string) => boolean = () => false;

  constructor(
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
  ) {}

  /** Installs the broker's per-pad session view after circular startup wiring completes. */
  setSessionProvider(provider: (padId: string) => readonly SessionInfo[]): void {
    this.sessionProvider = provider;
  }

  /** Installs the broker's in-flight create view for residency decisions. */
  setPendingOpenProvider(provider: (padId: string) => boolean): void {
    this.pendingOpenProvider = provider;
  }

  /**
   * Every container's census, which is the whole input to the index. Resident rooms answer
   * from their live document; the rest are decoded from their newest stored snapshot and
   * cached against its revision, so an idle workspace costs one query per pad and a busy
   * one costs only the pads that actually changed.
   */
  censuses(): ContainerCensus[] {
    const censuses: ContainerCensus[] = [];
    for (const pad of this.store.listPads()) {
      const room = this.rooms.get(pad.id);
      if (room !== undefined) {
        this.censusCache.delete(pad.id);
        censuses.push(room.census());
        continue;
      }
      const record = this.store.latestDoc(pad.id);
      if (record === null) {
        censuses.push({ padId: pad.id, layout: pad.layout, items: [], references: [] });
        continue;
      }
      const cached = this.censusCache.get(pad.id);
      if (cached !== undefined && cached.rev === record.rev) {
        censuses.push(cached.census);
        continue;
      }
      const doc = createSceneDoc();
      let census: ContainerCensus;
      try {
        Y.applyUpdate(doc, record.doc);
        census = censusFor(
          pad.id,
          pad.layout === "tiled" ? readTileLayout(doc, pad.id) : null,
          [...readElements(doc).values()].sort(compareElements),
        );
      } catch {
        // A document this manager cannot read is reported as holding nothing rather than
        // omitted: the index still has to show the container, and the room's own fallback
        // loading is what recovers the contents.
        census = { padId: pad.id, layout: pad.layout, items: [], references: [] };
      } finally {
        doc.destroy();
      }
      this.censusCache.set(pad.id, { rev: record.rev, census });
      censuses.push(census);
    }
    return censuses;
  }

  /** Returns a canonical room only when its durable pad exists. */
  get(padId: string): Room | null {
    if (this.store.getPad(padId) === null) return null;
    let room = this.rooms.get(padId);
    if (room === undefined) {
      room = new Room(
        padId,
        this.store,
        this.runtime,
        this.timers,
        this.logger,
        () => {
          return this.sessionProvider(padId);
        },
        (idleRoom) => {
          this.evict(idleRoom);
        },
      );
      this.rooms.set(padId, room);
    }
    return room;
  }

  /** Returns only an already materialized room; broker events must never load one. */
  live(padId: string): Room | null {
    return this.rooms.get(padId) ?? null;
  }

  /** Summarizes presence from already-live rooms without materializing idle pads. */
  presence(): PadPresence[] {
    const pads: PadPresence[] = [];
    for (const room of this.rooms.values()) {
      const principals = room.livePrincipals();
      if (principals.length > 0) pads.push({ padId: room.padId, principals });
    }
    return pads.sort((left, right) => left.padId.localeCompare(right.padId));
  }

  /**
   * Pads where BOTH principals are currently joined. This is the consent gate behind
   * "look at this": one principal may steer another's view only where they are already
   * together, so the reach of a spotlight is exactly the reach of shared presence, and it
   * is computed from live membership rather than from anything the caller claims.
   */
  sharedPadIds(left: string, right: string): string[] {
    const shared: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.hasPrincipal(left) && room.hasPrincipal(right)) shared.push(room.padId);
    }
    return shared.sort((first, second) => first.localeCompare(second));
  }

  /** Writes server-owned presence into a live room; false when nobody is there to receive it. */
  setSpotlight(
    padId: string,
    principalId: string,
    spotlight: { uri: string; from: string },
  ): boolean {
    return this.rooms.get(padId)?.writeSpotlight(principalId, spotlight) ?? false;
  }

  /**
   * Whether a container currently holds a given element or tile — the existence half of
   * `GET /api/resolve` for the two addresses that live INSIDE a document. It materializes
   * the room exactly as a join would, because the answer is in the document and a stale
   * snapshot would report a note somebody just deleted as still there.
   */
  holdsElement(padId: string, elementId: string): boolean {
    const room = this.get(padId);
    return room !== null && readElement(room.doc, elementId) !== null;
  }

  holdsTile(padId: string, tileId: string): boolean {
    const room = this.get(padId);
    if (room === null) return false;
    return readTileLayout(room.doc, padId)?.[tileId] !== undefined;
  }

  /** Rechecks an idle resident after its last running terminal exits. */
  evictIfIdle(padId: string): boolean {
    const room = this.rooms.get(padId);
    if (room === undefined) return false;
    return this.evict(room);
  }

  private evict(room: Room): boolean {
    if (this.rooms.get(room.padId) !== room || room.hasConnections()) return false;
    if (this.pendingOpenProvider(room.padId)) return false;
    if (this.sessionProvider(room.padId).some((session) => session.status === "running")) {
      return false;
    }
    try {
      room.flushSnapshot();
    } catch (error) {
      this.logger.error("snapshot_final_flush_failed", {
        padId: room.padId,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      return false;
    }
    this.rooms.delete(room.padId);
    return true;
  }

  /** Evicts and fences a deleted pad's live room. */
  drop(padId: string): void {
    const room = this.rooms.get(padId);
    if (room === undefined) return;
    room.closeAll(4404, "pad deleted");
    this.rooms.delete(padId);
  }

  /** Flushes every dirty scene for graceful shutdown. */
  flushAll(): void {
    for (const room of this.rooms.values()) {
      try {
        room.flushSnapshot();
      } catch (error) {
        this.logger.error("snapshot_shutdown_flush_failed", {
          padId: room.padId,
          error: error instanceof Error ? error.message : "unknown failure",
        });
        room.cancelSnapshotTimers();
      }
    }
  }

  /** Returns secret-free summaries of currently materialized rooms. */
  introspect(): Record<string, unknown>[] {
    return [...this.rooms.values()].map((room) => room.introspect());
  }
}
