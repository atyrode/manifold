import {
  MAX_DOC_UPDATE_BYTES,
  PROTOCOL_VERSION,
  ROOT_TILE_ID,
  compareElements,
  elementString,
  type Attendance,
  type CensusItem,
  type ClientMessageBody,
  type ContainerCensus,
  type EventKind,
  type PresencePayload,
  type PresenceState,
  type Principal,
  type RuntimeDeps,
  type SceneElement,
  type Structure,
  type TerminalInfo,
  type TileEdge,
  type TileLayout,
  type TileRef,
} from "@manifold/protocol";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  REPAIR_ORIGIN,
  SERVER_PLACE_ORIGIN,
  Y,
  changedElementIds,
  collaborativeTextFields,
  createSceneDoc,
  decodeUpdate,
  elementsMap,
  encodeUpdate,
  initCompositionLayout,
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
  writeTileLeafRef,
  writeTileStructure,
} from "@manifold/scene";
import type { ElementPayloadRefusal } from "@manifold/plugin";
import type { EventHub } from "./event-hub.ts";
import type { Logger } from "./log.ts";
import {
  SESSION_TRANSPORT_PAYLOAD_BYTES,
  serializeServerMessage,
  type ChannelMessage,
  type SessionChannel,
} from "./session-channel.ts";
import type { ServerStore } from "./stores.ts";

const QUIET_SAVE_MS = 1_500;
const MAX_SAVE_MS = 10_000;

/**
 * The census of one container, derived from its document alone: a composition is counted
 * by its occupied leaves, a canvas by its elements. Free of `Room` so the same derivation
 * serves a resident room and a container whose document is only on disk — two answers to
 * "what does this container hold" would be two answers too many.
 */
export function censusFor(
  containerId: string,
  layout: TileLayout | null,
  elements: readonly SceneElement[],
): ContainerCensus {
  const items: CensusItem[] = [];
  const references: string[] = [];
  if (layout === null) {
    for (const element of elements) {
      /*
        The protocol's element schema is a neutral envelope (ADR 0013 §16), so a portal's
        target is read rather than trusted: a record of that type whose reference is missing or
        the wrong shape contributes an ordinary item and no reference, which is truthful —
        there is no container to point the index at.
      */
      const target = element.type === "portal" ? elementString(element, "containerId") : null;
      if (target === null) {
        items.push({ kind: element.type, containerId: null, terminalId: null });
        continue;
      }
      references.push(target);
      items.push({ kind: "composition", containerId: target, terminalId: null });
    }
  } else {
    for (const node of Object.values(layout)) {
      const ref = node.ref;
      if (ref === null) continue;
      if (ref.kind === "terminal") {
        // A leaf holding a terminal is the only place a terminal's home is written down, so
        // the census carries the terminal id: the index needs it to join a solo composition
        // row to the terminal wearing it.
        items.push({ kind: "terminal", containerId: null, terminalId: ref.terminalId });
        continue;
      }
      if (ref.kind === "container") {
        references.push(ref.containerId);
        items.push({ kind: "canvas", containerId: ref.containerId, terminalId: null });
        continue;
      }
      items.push({ kind: "text", containerId: null, terminalId: null });
    }
  }
  const discipline = layout === null ? "canvas" : "composition";
  return { containerId, discipline, items, references };
}

/**
 * Leaves 4 MiB of the WebSocket transport ceiling for the init envelope, attendance, and
 * terminals while allowing canonical documents substantially larger than one client update.
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
 * being resident. Keeping them apart is load-bearing: a portal preview closing must never
 * pop somebody's newborn bubble.
 */
export type RoomEmptyReason = "occupants" | "sockets";

/** Canonical in-memory Yjs document and ephemeral membership for one persisted container. */
export class Room {
  readonly doc = createSceneDoc();
  readonly epoch: string;
  rev: number;

  private readonly connections = new Map<string, Set<SessionChannel>>();
  /**
   * Watching sockets, kept apart from `connections` on purpose: they are not principals
   * in this room. Everything membership means — attendance fan-out, presence, the
   * join/leave events, and the room-empty hook that pops a bubble — reads `connections`,
   * while everything transport means — broadcast, close, eviction residency — reads both.
   */
  private readonly spectators = new Set<SessionChannel>();
  private readonly presences = new Map<string, PresencePayload>();
  private readonly updateBuckets = new Map<string, { tokens: number; at: number }>();
  private dirty = false;
  private cancelQuiet: (() => void) | null = null;
  private cancelMax: (() => void) | null = null;
  private collectingIds: Set<string> | null = null;
  private docBytes = 0;
  private overLimit = false;

  constructor(
    readonly containerId: string,
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly terminals: () => readonly TerminalInfo[],
    private readonly onEmpty: (room: Room, reason: RoomEmptyReason) => void,
    /**
     * The element-payload boundary (`elementPayloadGuard`, ADR 0013 §16 clause 5). Injected
     * rather than imported, because the schemas are the ASSEMBLY's and this pillar may not know
     * a plugin exists: the room asks whether a record is acceptable and is told, exactly as it
     * asks the store for a document.
     */
    private readonly payloadRefusal: (element: SceneElement) => ElementPayloadRefusal | null,
    /**
     * ATTENDANCE, ANNOUNCED — injected for the same reason the payload boundary above it is.
     * A room owns its roster; which plugin declares the WORDS for a principal arriving is the
     * assembly's business, and a floor pillar that named one would be the neutrality criterion
     * failing (`AXIOMS.md` §Foundation law). The room says what happened and to which
     * container; the function it is handed decides who hears it and where it is recorded.
     */
    private readonly announce: (containerId: string, principalId: string, kind: EventKind) => void,
  ) {
    const record = store.latestDoc(containerId, (error, invalid) => {
      logger.error("scene_doc_load_skipped", {
        containerId,
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

    // A composition renders its layout tree, so the tree must exist before the first
    // channel joins. The discipline lives on the container row, and seeding is
    // idempotent, so a container loaded from a snapshot keeps its stored tree.
    if (store.getContainer(containerId)?.discipline === "composition") {
      initCompositionLayout(this.doc, SERVER_PLACE_ORIGIN);
    }
  }

  private attendance(): PresenceState[] {
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

  private stateMessage(type: "init" | "resync", peer: SessionChannel): ChannelMessage {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      epoch: this.epoch,
      rev: this.rev,
      doc: encodeUpdate(Y.encodeStateAsUpdate(this.doc)),
      self: peer.auth.principal,
      selfCaps: [...peer.auth.caps],
      selfConnId: peer.id,
      attendance: this.attendance(),
      terminals: [...this.terminals()],
    };
  }

  private sendState(type: "init" | "resync", peer: SessionChannel): boolean {
    const frame = serializeServerMessage(this.stateMessage(type, peer));
    if (frame.bytes > SESSION_TRANSPORT_PAYLOAD_BYTES) {
      this.logger.error("scene_state_exceeds_transport", {
        containerId: this.containerId,
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

  /** Registers a tab, sends init first, then publishes principal-level attendance deltas. */
  join(peer: SessionChannel): boolean {
    if (peer.spectator) {
      // A watcher receives the same authoritative state (its preview IS this room) and
      // nothing else: no attendance row, no presence entry, no principal_joined event.
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
    this.broadcast({ type: "attendance", joined }, false, peer);
    // A principal ARRIVES once, however many tabs it opens: the announcement is gated on the
    // first connection exactly as the durable row always was, so the event is one per
    // attendance change and not one per socket.
    if (firstConnection) this.announce(this.containerId, principalId, "principal_joined");
    return true;
  }

  /** Removes a tab and expires principal presence only after its final connection leaves. */
  leave(peer: SessionChannel): void {
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
      this.broadcast({ type: "attendance", left: { principalId } });
      this.announce(this.containerId, principalId, "principal_left");
      if (this.connections.size === 0) this.onEmpty(this, "occupants");
      return;
    }
    const first = peers.values().next().value;
    if (first !== undefined) {
      this.broadcast({
        type: "attendance",
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
  sendResync(peer: SessionChannel): void {
    this.sendState("resync", peer);
  }

  private consumeDocUpdate(peer: SessionChannel): boolean {
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
  applyDocUpdate(peer: SessionChannel, encoded: DocUpdate["update"]): boolean {
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

    /*
      THE SCENE BOUNDARY. Two ways a record can be unacceptable, repaired identically: the
      envelope itself did not parse (`readElement` answers null — bad geometry, an out-of-bounds
      payload), or the envelope parsed and its owning plugin's payload schema refused it (ADR
      0013 §16 clause 5). A record whose type NO registration claims passes both, which is the
      whole point of the envelope: a canvas keeps holding what an absent plugin wrote.

      Accept-then-repair, not validate-then-reject, because a Yjs update is not divisible: the
      update has already merged by the time anything can be read, so the repair is a second
      transaction that broadcasts like any other.
    */
    for (const id of changed) {
      const element = readElement(this.doc, id);
      const refusal = element === null ? null : this.payloadRefusal(element);
      if (element !== null && refusal === null) continue;
      if (!removeElement(this.doc, id, REPAIR_ORIGIN)) continue;
      this.logger.warn("scene_element_repaired", {
        containerId: this.containerId,
        id,
        ...(refusal === null
          ? {}
          : { type: refusal.type, plugin: refusal.plugin, problems: refusal.problems.join("; ") }),
      });
    }
    return true;
  }

  /**
   * Merges ephemeral presence while stamping the authenticated principal id.
   *
   * `spotlight` is SERVER-WRITTEN ONLY and is dropped here whatever a client sends. It says
   * "another principal asked you to look at this", and its whole value is that the ask
   * carried an authority check — `core.presence.focus` verified a shared room and
   * `scenes:write` before writing one. A peer allowed to set it on itself could set it on
   * anybody by claiming a principal it is not, so the field simply never crosses inbound.
   */
  updatePresence(peer: SessionChannel, payload: PresencePayload): void {
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
  relayCursor(peer: SessionChannel, cursor: CursorUpdate): void {
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
  relayGesture(peer: SessionChannel, gesture: GestureUpdate): void {
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
  broadcast(message: ChannelMessage, droppable = false, except?: SessionChannel): void {
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
        containerId: this.containerId,
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
        containerId: this.containerId,
        bytes: this.docBytes,
        limit: DOC_BYTES_LIMIT,
      });
    }
    this.store.saveDoc(this.containerId, this.epoch, this.rev, at, doc);
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
   * Closes every member when a container is deleted or the process shuts down. Membership
   * is dropped BEFORE the channels are told, because a channel close now calls back into
   * `leave` (the gateway retires the channel record): a room that is being demolished
   * must not publish departures, write events for a row that may already be gone, or
   * fire the room-empty hook on its way out.
   */
  closeAll(code: number, reason: string): void {
    this.cancelSnapshotTimers();
    const members: SessionChannel[] = [];
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
   * Whether any socket actually OCCUPIES this room, as opposed to watching it. A portal's
   * live preview holds a real socket without being anybody's presence, so the two
   * questions have to stay separate even though nothing dissolves on emptiness any more.
   */
  hasOccupants(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Whether this container HOMES a terminal — holds a tile leaf for it. Only a composition
   * can: a canvas references a terminal through a portal onto its home, so a canvas has
   * nothing to say about where a terminal lives.
   */
  homesTerminal(terminalId: string): boolean {
    const layout = readTileLayout(this.doc);
    if (layout === null) return false;
    for (const node of Object.values(layout)) {
      const ref = node.ref;
      if (ref !== null && ref.kind === "terminal" && ref.terminalId === terminalId) {
        return true;
      }
    }
    return false;
  }

  /** The layout tree of a composition, or null for a canvas (and a tree that fails validation). */
  tileLayout(): TileLayout | null {
    return readTileLayout(this.doc, this.containerId);
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
   * Where a null-aimed placement actually lands: a null target fills the first vacant leaf,
   * else splits the root to the right; a null edge fills a vacant target leaf, else splits
   * that leaf to the right. Null when this container holds no tree, or when the target names
   * no tile in it.
   *
   * Shared by both writers below rather than spelled twice. A carried ref and new structure
   * land at the SAME aim by construction (issue #104), so two copies of this defaulting is
   * precisely how the palette's drop and a carry's drop would start disagreeing about where
   * "no target" is.
   */
  private tileAim(
    targetTileId: string | null,
    edge: TileEdge | null,
  ): { readonly target: string; readonly edge: TileEdge } | null {
    const layout = this.tileLayout();
    if (layout === null) return null;
    const target =
      targetTileId ??
      Object.values(layout).find((node) => node.dir === null && node.ref === null)?.id ??
      ROOT_TILE_ID;
    const node = layout[target];
    if (node === undefined) return null;
    return { target, edge: edge ?? (node.dir === null && node.ref === null ? "center" : "right") };
  }

  /**
   * Places a ref in this container's layout tree under `SERVER_PLACE_ORIGIN`, so
   * the doc-update hook fans it out and client undo managers never capture it.
   * Returns the placement's tile id, or null when the tree rejects the write.
   */
  placeTile(
    ref: TileRef,
    targetTileId: string | null,
    edge: TileEdge | null,
    between = false,
  ): string | null {
    const aim = this.tileAim(targetTileId, edge);
    if (aim === null) return null;
    return writeTileLeaf(this.doc, ref, aim.target, aim.edge, SERVER_PLACE_ORIGIN, between);
  }

  /**
   * Places NEW STRUCTURE — a split holding two vacant leaves, or a spacer — at the same aim
   * a ref would have landed on, under the same origin and so through the same fan-out. This
   * is the palette's drop (issue #104): what arrives is tree rather than an occupant, which
   * is the whole of the difference from `placeTile`. Returns the new tile's id, or null when
   * the tree rejects the write — which is also the honest answer for a `center` release onto
   * an occupied leaf, since structure has no seat to trade the occupant.
   */
  placeStructure(
    structure: Structure,
    targetTileId: string | null,
    edge: TileEdge | null,
    between = false,
  ): string | null {
    const aim = this.tileAim(targetTileId, edge);
    if (aim === null) return null;
    return writeTileStructure(
      this.doc,
      structure,
      aim.target,
      aim.edge,
      SERVER_PLACE_ORIGIN,
      between,
    );
  }

  /** Places a terminal ref; the returned tile id IS the terminal's placement id. */
  placeTerminalTile(
    terminalId: string,
    targetTileId: string | null,
    edge: TileEdge | null,
  ): string | null {
    return this.placeTile({ kind: "terminal", terminalId }, targetTileId, edge);
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
  setTileRef(tileId: string, ref: TileRef | null): boolean {
    return writeTileLeafRef(this.doc, tileId, ref, SERVER_PLACE_ORIGIN);
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
   * showing the same item, so the portal must not jump, blink, or be re-authored under a
   * new id that collaborators' selections would lose.
   */
  repointPortal(elementId: string, containerId: string): boolean {
    const element = readElement(this.doc, elementId);
    if (element === null || element.type !== "portal") return false;
    if (elementString(element, "containerId") === containerId) return true;
    writeElement(
      this.doc,
      { ...element, containerId },
      SERVER_PLACE_ORIGIN,
      this.collaborativeFields(elementId),
    );
    return true;
  }

  /**
   * Which of an element's payload fields are stored as collaborative text right now.
   *
   * Published on the room because a RE-WRITE has to carry them and the floor must not know
   * which fields those are (ADR 0013 §16 clause 6). Every site below that re-authors an
   * existing element passes this, which is why moving a note keeps the shared type a person is
   * typing into instead of flattening it to the string it happened to contain.
   */
  collaborativeFields(elementId: string): readonly string[] {
    return collaborativeTextFields(this.doc, elementId);
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
        // A portal frames a terminal-sized area, so a fresh one borrows that size.
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
    writeElement(
      this.doc,
      { ...element, x, y },
      SERVER_PLACE_ORIGIN,
      this.collaborativeFields(elementId),
    );
    return true;
  }

  /**
   * Adopts an element that left another canvas: the same item, its own id preserved so
   * collaborators' selections and references still name it, placed at the drop point and
   * lifted to the top of THIS canvas's stack.
   *
   * `collaborative` is REQUIRED rather than defaulted, and that is the point: the element
   * arrives as a plain record read out of a document this room cannot see, so only the caller
   * holding the SOURCE room can say which of its fields were shared types. A default of "none"
   * would compile everywhere and silently flatten a note's collaborative text on every
   * cross-canvas move — a data regression with no error to notice it by. The caller reads it
   * off the source with {@link collaborativeFields}.
   */
  adoptElement(
    element: SceneElement,
    x: number,
    y: number,
    collaborative: readonly string[],
  ): void {
    writeElement(
      this.doc,
      { ...element, x, y, zIndex: nextZIndex(this.doc) },
      SERVER_PLACE_ORIGIN,
      collaborative,
    );
  }

  /** Removes one element the server placed or is releasing; the update hook broadcasts it. */
  removeElementById(elementId: string): boolean {
    return removeElement(this.doc, elementId, SERVER_PLACE_ORIGIN);
  }

  /** This container's census, from its live document. */
  census(): ContainerCensus {
    return censusFor(this.containerId, this.tileLayout(), this.elements());
  }

  /** Returns the principal-level live attendance without cursor or viewport payloads. */
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
      containerId: this.containerId,
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

/** Lazily loads rooms and coordinates snapshot flush/delete across all active containers. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /**
   * Censuses of containers with no resident room, keyed by container id and fenced by the
   * document revision they were derived from. Decoding every stored document on every
   * index poll would be pure waste: the revision is one cheap SQL read, and a document
   * that has not moved cannot have changed what it holds.
   */
  private readonly censusCache = new Map<
    string,
    { readonly rev: number; readonly census: ContainerCensus }
  >();
  private terminalProvider: (containerId: string) => readonly TerminalInfo[] = () => [];
  private pendingOpenProvider: (containerId: string) => boolean = () => false;
  /**
   * The element-payload boundary, accept-all until the assembly is wired.
   *
   * A permissive default is right rather than lazy: the guard's schemas come from the plugin
   * host, the host is built after the rooms are (circular startup, the same reason the terminal
   * view is installed rather than constructed), and a room that refused every payload until
   * that wiring landed would drop records during boot. Accepting until told is what the
   * envelope already does for a stranger type.
   */
  private payloadGuard: (element: SceneElement) => ElementPayloadRefusal | null = () => null;
  /**
   * ATTENDANCE ANNOUNCEMENT, history-only until the event plane is wired.
   *
   * The default is not a no-op, and that is the whole point: `store.addEvent` is the one
   * writer of the durable trail and a principal arriving is recorded whether or not anybody is
   * subscribed — the audit log is not a subscriber. Installing the hub REPLACES this rather
   * than adding to it, so the row is written exactly once, by exactly one writer, in both
   * worlds (ADR 0012 §5).
   */
  private announce: (containerId: string, principalId: string, kind: EventKind) => void = (
    containerId,
    principalId,
    kind,
  ) => {
    this.store.addEvent(containerId, this.runtime.now(), principalId, kind, {});
  };

  constructor(
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
  ) {}

  /** Installs the broker's per-container terminal view after circular startup wiring done. */
  setTerminalProvider(provider: (containerId: string) => readonly TerminalInfo[]): void {
    this.terminalProvider = provider;
  }

  /** Installs the assembly's element-payload boundary; see `elementPayloadGuard`. */
  setElementPayloadGuard(guard: (element: SceneElement) => ElementPayloadRefusal | null): void {
    this.payloadGuard = guard;
  }

  /** Installs the broker's in-flight create view for residency decisions. */
  setPendingOpenProvider(provider: (containerId: string) => boolean): void {
    this.pendingOpenProvider = provider;
  }

  /**
   * Installs the event plane.
   *
   * Attendance is addressed to the presence COLLECTION rather than to the container, and the
   * container travels as the audit trail's own scope plus the payload's `containerId`. The
   * reason is the surface: `/api/attendance` was polled WORKSPACE-WIDE, from chrome that is
   * outside every room it reports on, so a container-addressed topic would have cost that
   * chrome one subscription per container — while the in-room half of the same news already
   * rides the session channel as an `attendance` frame. One subscription replaces the poll,
   * and nothing that used to arrive stops arriving.
   */
  setEvents(events: EventHub): void {
    this.announce = (containerId, principalId, kind) => {
      events.emitCollection("attendance", kind, principalId, { containerId }, containerId);
    };
  }

  /**
   * Every container's census, which is the whole input to the index. Resident rooms answer
   * from their live document; the rest are decoded from their newest stored snapshot and
   * cached against its revision, so an idle workspace costs one query per container and a
   * busy one costs only the containers that actually changed.
   */
  censuses(): ContainerCensus[] {
    const censuses: ContainerCensus[] = [];
    for (const container of this.store.listContainers()) {
      const room = this.rooms.get(container.id);
      if (room !== undefined) {
        this.censusCache.delete(container.id);
        censuses.push(room.census());
        continue;
      }
      const record = this.store.latestDoc(container.id);
      if (record === null) {
        censuses.push({
          containerId: container.id,
          discipline: container.discipline,
          items: [],
          references: [],
        });
        continue;
      }
      const cached = this.censusCache.get(container.id);
      if (cached !== undefined && cached.rev === record.rev) {
        censuses.push(cached.census);
        continue;
      }
      const doc = createSceneDoc();
      let census: ContainerCensus;
      try {
        Y.applyUpdate(doc, record.doc);
        census = censusFor(
          container.id,
          container.discipline === "composition" ? readTileLayout(doc, container.id) : null,
          [...readElements(doc).values()].sort(compareElements),
        );
      } catch {
        // A document this manager cannot read is reported as holding nothing rather than
        // omitted: the index still has to show the container, and the room's own fallback
        // loading is what recovers the contents.
        census = {
          containerId: container.id,
          discipline: container.discipline,
          items: [],
          references: [],
        };
      } finally {
        doc.destroy();
      }
      this.censusCache.set(container.id, { rev: record.rev, census });
      censuses.push(census);
    }
    return censuses;
  }

  /** Returns a canonical room only when its durable container exists. */
  get(containerId: string): Room | null {
    if (this.store.getContainer(containerId) === null) return null;
    let room = this.rooms.get(containerId);
    if (room === undefined) {
      room = new Room(
        containerId,
        this.store,
        this.runtime,
        this.timers,
        this.logger,
        () => {
          return this.terminalProvider(containerId);
        },
        (idleRoom) => {
          this.evict(idleRoom);
        },
        (element) => {
          return this.payloadGuard(element);
        },
        (announcedContainerId, principalId, kind) => {
          this.announce(announcedContainerId, principalId, kind);
        },
      );
      this.rooms.set(containerId, room);
    }
    return room;
  }

  /** Returns only an already materialized room; broker events must never load one. */
  live(containerId: string): Room | null {
    return this.rooms.get(containerId) ?? null;
  }

  /** Summarizes presence from already-live rooms without materializing idle containers. */
  presence(): Attendance[] {
    const attendance: Attendance[] = [];
    for (const room of this.rooms.values()) {
      const principals = room.livePrincipals();
      if (principals.length > 0) attendance.push({ containerId: room.containerId, principals });
    }
    return attendance.sort((left, right) => left.containerId.localeCompare(right.containerId));
  }

  /**
   * Containers where BOTH principals are currently joined. This is the consent gate behind
   * "look at this": one principal may steer another's viewport only where they are already
   * together, so the reach of a spotlight is exactly the reach of shared presence, and it
   * is computed from live membership rather than from anything the caller claims.
   */
  sharedContainerIds(left: string, right: string): string[] {
    const shared: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.hasPrincipal(left) && room.hasPrincipal(right)) shared.push(room.containerId);
    }
    return shared.sort((first, second) => first.localeCompare(second));
  }

  /** Writes server-owned presence into a live room; false when nobody is there to receive it. */
  setSpotlight(
    containerId: string,
    principalId: string,
    spotlight: { uri: string; from: string },
  ): boolean {
    return this.rooms.get(containerId)?.writeSpotlight(principalId, spotlight) ?? false;
  }

  /**
   * Whether a container currently holds a given element or tile — the existence half of
   * `GET /api/resolve` for the two addresses that live INSIDE a document. It materializes
   * the room exactly as a join would, because the answer is in the document and a stale
   * snapshot would report a note somebody just deleted as still there.
   */
  holdsElement(containerId: string, elementId: string): boolean {
    const room = this.get(containerId);
    return room !== null && readElement(room.doc, elementId) !== null;
  }

  holdsTile(containerId: string, tileId: string): boolean {
    const room = this.get(containerId);
    if (room === null) return false;
    return readTileLayout(room.doc, containerId)?.[tileId] !== undefined;
  }

  /** Rechecks an idle resident after its last running terminal exits. */
  evictIfIdle(containerId: string): boolean {
    const room = this.rooms.get(containerId);
    if (room === undefined) return false;
    return this.evict(room);
  }

  private evict(room: Room): boolean {
    if (this.rooms.get(room.containerId) !== room || room.hasConnections()) return false;
    if (this.pendingOpenProvider(room.containerId)) return false;
    const running = this.terminalProvider(room.containerId);
    if (running.some((terminal) => terminal.status === "running")) {
      return false;
    }
    try {
      room.flushSnapshot();
    } catch (error) {
      this.logger.error("snapshot_final_flush_failed", {
        containerId: room.containerId,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      return false;
    }
    this.rooms.delete(room.containerId);
    return true;
  }

  /** Evicts and fences a deleted container's live room. */
  drop(containerId: string): void {
    const room = this.rooms.get(containerId);
    if (room === undefined) return;
    room.closeAll(4404, "container deleted");
    this.rooms.delete(containerId);
  }

  /** Flushes every dirty scene for graceful shutdown. */
  flushAll(): void {
    for (const room of this.rooms.values()) {
      try {
        room.flushSnapshot();
      } catch (error) {
        this.logger.error("snapshot_shutdown_flush_failed", {
          containerId: room.containerId,
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
