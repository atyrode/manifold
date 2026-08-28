import {
  MAX_DOC_UPDATE_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PadPresence,
  type PresencePayload,
  type PresenceState,
  type Principal,
  type RuntimeDeps,
  type ServerMessage,
  type SessionInfo,
} from "@manifold/protocol";
import {
  REPAIR_ORIGIN,
  Y,
  changedElementIds,
  createSceneDoc,
  decodeUpdate,
  elementsMap,
  encodeUpdate,
  readElement,
  readElements,
  removeElement,
} from "@manifold/scene";
import type { Logger } from "./log.ts";
import {
  SESSION_TRANSPORT_PAYLOAD_BYTES,
  serializeServerMessage,
  type SessionPeer,
} from "./session-peer.ts";
import type { ServerStore } from "./stores.ts";

const QUIET_SAVE_MS = 1_500;
const MAX_SAVE_MS = 10_000;

/**
 * Leaves 4 MiB of the WebSocket transport ceiling for the init envelope, roster, and
 * sessions while allowing canonical documents substantially larger than one client update.
 */
export const DOC_BYTES_LIMIT = 12 * 1_048_576;
const DOC_UPDATES_PER_SECOND = 120;
const DOC_UPDATE_BURST = 240;

type DocUpdate = Extract<ClientMessage, { type: "doc_update" }>;
type CursorUpdate = Extract<ClientMessage, { type: "cursor" }>;
type GestureUpdate = Extract<ClientMessage, { type: "gesture" }>;

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

/** Canonical in-memory Yjs document and ephemeral membership for one persisted pad. */
export class Room {
  readonly doc = createSceneDoc();
  readonly epoch: string;
  rev: number;

  private readonly connections = new Map<string, Set<SessionPeer>>();
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
    private readonly onEmpty: (room: Room) => void,
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
  }

  private roster(): PresenceState[] {
    const result: PresenceState[] = [];
    for (const [principalId, peers] of this.connections) {
      const first = peers.values().next().value;
      if (first === undefined) continue;
      result.push({
        principal: first.auth.principal,
        connections: peers.size,
        payload: this.presences.get(principalId) ?? {},
      });
    }
    return result.sort((left, right) => left.principal.id.localeCompare(right.principal.id));
  }

  private stateMessage(type: "init" | "resync", peer: SessionPeer): ServerMessage {
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
    const principalId = peer.auth.principal.id;
    const peers = this.connections.get(principalId);
    if (peers === undefined || !peers.delete(peer)) return;
    this.updateBuckets.delete(peer.id);
    if (peers.size === 0) {
      this.connections.delete(principalId);
      this.presences.delete(principalId);
      this.broadcast({ type: "roster", left: { principalId } });
      this.store.addEvent(this.padId, this.runtime.now(), principalId, "principal_left", {});
      if (this.connections.size === 0) this.onEmpty(this);
      return;
    }
    const first = peers.values().next().value;
    if (first !== undefined) {
      this.broadcast({
        type: "roster",
        joined: {
          principal: first.auth.principal,
          connections: peers.size,
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

  /** Merges ephemeral presence while stamping the authenticated principal id. */
  updatePresence(peer: SessionPeer, payload: PresencePayload): void {
    const principalId = peer.auth.principal.id;
    const current = this.presences.get(principalId) ?? {};
    this.presences.set(principalId, { ...current, ...payload });
    this.broadcast({ type: "presence", principalId, connId: peer.id, payload });
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
        ...(cursor.tool === undefined ? {} : { tool: cursor.tool }),
      },
      true,
    );
  }
  /** Relays high-rate gesture motion with droppable delivery under socket pressure. */
  relayGesture(peer: SessionPeer, gesture: GestureUpdate): void {
    this.broadcast(
      {
        ...gesture,
        principalId: peer.auth.principal.id,
        connId: peer.id,
      },
      true,
    );
  }

  /** Broadcasts one schema serialization to all current room members. */
  broadcast(message: ServerMessage, droppable = false, except?: SessionPeer): void {
    const frame = serializeServerMessage(message);
    for (const peers of this.connections.values()) {
      for (const peer of peers) {
        if (peer !== except) peer.sendSerialized(frame, droppable);
      }
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

  /** Closes every member when a pad is deleted or the process shuts down. */
  closeAll(code: number, reason: string): void {
    this.cancelSnapshotTimers();
    for (const peers of this.connections.values()) {
      for (const peer of peers) peer.close(code, reason);
    }
    this.connections.clear();
    this.presences.clear();
    this.updateBuckets.clear();
  }

  /** Whether this room still has any joined sockets. */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  /** Whether a live terminal element still points at a persisted session. */
  referencesSession(sessionId: string): boolean {
    for (const element of readElements(this.doc).values()) {
      if (element.type === "terminal" && element.sessionId === sessionId) return true;
    }
    return false;
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
    };
  }
}

/** Lazily loads rooms and coordinates snapshot flush/delete across all active pads. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
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
