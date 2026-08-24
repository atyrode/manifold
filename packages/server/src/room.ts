import {
  PROTOCOL_VERSION,
  applyAccepted,
  compareElements,
  reconcile,
  type ClientMessage,
  type PresencePayload,
  type PresenceState,
  type RuntimeDeps,
  type SceneElement,
  type ServerMessage,
  type SessionInfo,
} from "@manifold/protocol";
import type { Logger } from "./log.ts";
import type { SessionPeer } from "./session-peer.ts";
import type { ServerStore } from "./stores.ts";

const QUIET_SAVE_MS = 1_500;
const MAX_SAVE_MS = 10_000;

type SceneUpdate = Extract<ClientMessage, { type: "scene_update" }>;
type CursorUpdate = Extract<ClientMessage, { type: "cursor" }>;

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

/** Canonical in-memory scene and ephemeral membership for one persisted pad. */
export class Room {
  readonly scene = new Map<string, SceneElement>();
  readonly epoch: string;
  rev: number;

  private readonly connections = new Map<string, Set<SessionPeer>>();
  private readonly presences = new Map<string, PresencePayload>();
  private dirty = false;
  private cancelQuiet: (() => void) | null = null;
  private cancelMax: (() => void) | null = null;

  constructor(
    readonly padId: string,
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly sessions: () => readonly SessionInfo[],
  ) {
    const snapshot = store.latestSnapshot(padId);
    this.epoch = snapshot?.epoch ?? runtime.newId();
    this.rev = snapshot?.rev ?? 0;
    if (snapshot !== null) {
      for (const element of snapshot.elements) this.scene.set(element.id, element);
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
      elements: [...this.scene.values()].sort(compareElements),
      self: peer.auth.principal,
      roster: this.roster(),
      sessions: [...this.sessions()],
    };
  }

  /** Registers a tab, sends init first, then publishes principal-level roster deltas. */
  join(peer: SessionPeer): void {
    const principalId = peer.auth.principal.id;
    let peers = this.connections.get(principalId);
    const firstConnection = peers === undefined;
    if (peers === undefined) {
      peers = new Set();
      this.connections.set(principalId, peers);
      this.presences.set(principalId, {});
    }
    peers.add(peer);
    peer.send(this.stateMessage("init", peer));
    const joined: PresenceState = {
      principal: peer.auth.principal,
      connections: peers.size,
      payload: this.presences.get(principalId) ?? {},
    };
    this.broadcast({ type: "roster", joined }, false, peer);
    if (firstConnection) {
      this.store.addEvent(this.padId, this.runtime.now(), principalId, "principal_joined", {});
    }
  }

  /** Removes a tab and expires principal presence only after its final connection leaves. */
  leave(peer: SessionPeer): void {
    const principalId = peer.auth.principal.id;
    const peers = this.connections.get(principalId);
    if (peers === undefined || !peers.delete(peer)) return;
    if (peers.size === 0) {
      this.connections.delete(principalId);
      this.presences.delete(principalId);
      this.broadcast({ type: "roster", left: { principalId } });
      this.store.addEvent(this.padId, this.runtime.now(), principalId, "principal_left", {});
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
    peer.send(this.stateMessage("resync", peer));
  }

  /** Applies epoch-fenced reconciliation, increments rev only for winners, and acks once. */
  applyUpdate(peer: SessionPeer, update: SceneUpdate): void {
    if (update.epoch !== this.epoch) {
      peer.send({
        type: "error",
        code: "epoch_mismatch",
        message: "scene epoch changed",
        ref: update.updateId,
      });
      this.sendResync(peer);
      return;
    }

    const result = reconcile(this.scene, update.elements);
    if (result.accepted.length > 0) {
      applyAccepted(this.scene, result.accepted);
      this.rev += 1;
      this.broadcast({
        type: "scene_applied",
        rev: this.rev,
        elements: result.accepted,
        by: peer.auth.principal.id,
      });
      this.scheduleSnapshot();
    }
    peer.send({
      type: "scene_ack",
      updateId: update.updateId,
      rev: this.rev,
      acceptedIds: result.accepted.map((element) => element.id),
    });
  }

  /** Merges ephemeral presence while stamping the authenticated principal id. */
  updatePresence(peer: SessionPeer, payload: PresencePayload): void {
    const principalId = peer.auth.principal.id;
    const current = this.presences.get(principalId) ?? {};
    this.presences.set(principalId, { ...current, ...payload });
    this.broadcast({ type: "presence", principalId, payload });
  }

  /** Relays high-rate cursor motion with droppable delivery under socket pressure. */
  relayCursor(peer: SessionPeer, cursor: CursorUpdate): void {
    this.broadcast(
      {
        type: "cursor",
        principalId: peer.auth.principal.id,
        x: cursor.x,
        y: cursor.y,
        ...(cursor.tool === undefined ? {} : { tool: cursor.tool }),
      },
      true,
    );
  }

  /** Broadcasts an already-schema-shaped session message to room members. */
  broadcast(message: ServerMessage, droppable = false, except?: SessionPeer): void {
    for (const peers of this.connections.values()) {
      for (const peer of peers) {
        if (peer !== except) peer.send(message, droppable);
      }
    }
  }

  private scheduleSnapshot(): void {
    this.dirty = true;
    this.cancelQuiet?.();
    this.cancelQuiet = this.timers.schedule(() => {
      this.cancelQuiet = null;
      this.flushSnapshot();
    }, QUIET_SAVE_MS);
    if (this.cancelMax === null) {
      this.cancelMax = this.timers.schedule(() => {
        this.cancelMax = null;
        this.flushSnapshot();
      }, MAX_SAVE_MS);
    }
  }

  /** Persists dirty canonical state immediately and emits the durable revision watermark. */
  flushSnapshot(): boolean {
    if (!this.dirty) return false;
    const at = this.runtime.now();
    try {
      this.store.saveSnapshot(
        this.padId,
        this.epoch,
        this.rev,
        at,
        [...this.scene.values()].sort(compareElements),
      );
    } catch (error) {
      this.logger.error("snapshot_save_failed", {
        padId: this.padId,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      throw error;
    }
    this.dirty = false;
    this.cancelQuiet?.();
    this.cancelMax?.();
    this.cancelQuiet = null;
    this.cancelMax = null;
    this.broadcast({ type: "saved", rev: this.rev, at });
    return true;
  }

  /** Closes every member when a pad is deleted or the process shuts down. */
  closeAll(code: number, reason: string): void {
    for (const peers of this.connections.values()) {
      for (const peer of peers) peer.close(code, reason);
    }
    this.connections.clear();
    this.presences.clear();
  }

  /** Safe live-room summary for root introspection; no presence payloads or secrets. */
  introspect(): Record<string, unknown> {
    let connectionCount = 0;
    for (const peers of this.connections.values()) connectionCount += peers.size;
    return {
      padId: this.padId,
      epoch: this.epoch,
      rev: this.rev,
      elements: this.scene.size,
      principals: this.connections.size,
      connections: connectionCount,
    };
  }
}

/** Lazily loads rooms and coordinates snapshot flush/delete across all active pads. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private sessionProvider: (padId: string) => readonly SessionInfo[] = () => [];

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

  /** Returns a canonical room only when its durable pad exists. */
  get(padId: string): Room | null {
    if (this.store.getPad(padId) === null) return null;
    let room = this.rooms.get(padId);
    if (room === undefined) {
      room = new Room(padId, this.store, this.runtime, this.timers, this.logger, () =>
        this.sessionProvider(padId),
      );
      this.rooms.set(padId, room);
    }
    return room;
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
    for (const room of this.rooms.values()) room.flushSnapshot();
  }

  /** Returns secret-free summaries of currently materialized rooms. */
  introspect(): Record<string, unknown>[] {
    return [...this.rooms.values()].map((room) => room.introspect());
  }
}
