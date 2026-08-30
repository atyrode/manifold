import { ServerMessageBodySchema, type ServerMessageBody } from "@manifold/protocol";
import type { AuthContext } from "./auth.ts";

/**
 * Outbound bounds are PER CHANNEL, exactly as they were per socket before multiplexing:
 * a room's fan-out queue is a property of that room's membership, not of the TCP
 * connection carrying it. With one channel per room the worst-case app-side buffering of
 * N rooms is unchanged — the same N queues, now behind one socket.
 */
const CHANNEL_QUEUE_FRAMES = 256;
const CHANNEL_QUEUE_BYTES = 1_048_576;

/** Bun's transport ceiling for authoritative server state and inbound WebSocket frames. */
export const SESSION_TRANSPORT_PAYLOAD_BYTES = 16 * 1_048_576;

/** Minimal socket surface shared by Bun production sockets and deterministic fakes. */
export interface RawSocket {
  readonly bufferedAmount: number;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

/**
 * Everything a peer can be sent: the channel-level frames. `pong` answers the SOCKET,
 * so the gateway writes it directly and no peer can accidentally tag it with a room.
 */
export type ChannelMessage = Exclude<ServerMessageBody, { type: "pong" }>;

/** One schema-checked wire payload reusable across every peer in a room broadcast. */
export interface SerializedServerMessage {
  readonly type: ChannelMessage["type"];
  /**
   * The frame BODY as JSON text, always starting with `{`. A broadcast serializes once
   * and each peer splices its own routing prefix in front, so fanning one doc update or
   * one PTY output frame out to N channels costs N string joins instead of N
   * re-serializations.
   */
  readonly body: string;
  /** Body bytes; a peer adds its own constant prefix width for accounting. */
  readonly bytes: number;
  readonly authoritative: boolean;
}

interface QueuedFrame {
  readonly type: ChannelMessage["type"];
  /** Channel-tagged wire text, ready for the socket. */
  readonly payload: string;
  /** Authoritative init/resync bytes are bounded by the transport, not the flood queue. */
  readonly boundedBytes: number;
}

/** Validates and serializes a server frame body exactly once before fanout. */
export function serializeServerMessage(message: ChannelMessage): SerializedServerMessage {
  const parsed = ServerMessageBodySchema.parse(message);
  const body = JSON.stringify(parsed);
  return {
    type: parsed.type as ChannelMessage["type"],
    body,
    bytes: Buffer.byteLength(body),
    authoritative: parsed.type === "init" || parsed.type === "resync",
  };
}

/**
 * One joined room channel on a session socket, with schema-checked, explicitly bounded
 * outbound buffering. A connection owns several of these; they share the socket and
 * nothing else, so every membership, capability, and backpressure decision stays local
 * to one room.
 */
export class SessionPeer {
  private queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private closed = false;
  /** `{"ch":"<channel>",` — channel ids are tokens, so this needs no escaping. */
  private readonly prefix: string;
  private readonly prefixBytes: number;

  constructor(
    readonly id: string,
    readonly socket: RawSocket,
    readonly auth: AuthContext,
    readonly padId: string,
    /** Client-chosen routing id for this room on this socket. */
    readonly channel: string,
    /**
     * Declared once in the join frame: a spectator channel (a portal widget's live
     * preview) watches this room without occupying it. It is absent from the roster
     * and from pad presence, it never holds a transient container open, and every
     * write it attempts is refused.
     */
    readonly spectator: boolean = false,
    /** Lets the owning connection retire the channel record when this peer dies. */
    private readonly onClosed: (peer: SessionPeer) => void = () => {},
  ) {
    this.prefix = `{"ch":"${channel}",`;
    this.prefixBytes = Buffer.byteLength(this.prefix);
  }

  /** Splices this channel's routing prefix onto a shared body serialization. */
  private tag(body: string): string {
    return this.prefix + body.slice(1);
  }

  /** Enqueues a protocol message or drops it when explicitly marked best-effort. */
  send(message: ChannelMessage, droppable = false): boolean {
    if (this.closed) return false;
    return this.sendSerialized(serializeServerMessage(message), droppable);
  }

  /**
   * Sends a payload already validated by the broadcaster. Init/resync are each one
   * authoritative frame, so their bytes use the 16 MiB transport ceiling rather than the
   * 1 MiB application flood queue.
   */
  sendSerialized(frame: SerializedServerMessage, droppable = false): boolean {
    if (this.closed) return false;
    const bytes = frame.bytes + this.prefixBytes;
    if (bytes > SESSION_TRANSPORT_PAYLOAD_BYTES) {
      // The socket itself cannot carry this frame: nothing about one room's membership
      // can heal that, so the whole connection goes.
      this.closeConnection(1009, "outbound frame exceeds transport limit");
      return false;
    }
    if (droppable && (this.queue.length > 0 || this.socket.bufferedAmount > 0)) return false;

    if (frame.type === "resync") {
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        const queued = this.queue[index];
        if (queued?.type !== "resync") continue;
        this.queuedBytes -= queued.boundedBytes;
        this.queue.splice(index, 1);
      }
    }

    const boundedBytes = frame.authoritative ? 0 : bytes;
    if (
      this.queue.length >= CHANNEL_QUEUE_FRAMES ||
      boundedBytes > CHANNEL_QUEUE_BYTES ||
      this.queuedBytes + boundedBytes > CHANNEL_QUEUE_BYTES
    ) {
      this.close(1013, "outbound queue overflow");
      return false;
    }

    const payload = this.tag(frame.body);
    if (this.queue.length > 0 || this.socket.bufferedAmount > 0) {
      this.queue.push({ type: frame.type, payload, boundedBytes });
      this.queuedBytes += boundedBytes;
      return true;
    }

    return this.acceptSendStatus(this.socket.send(payload));
  }

  private acceptSendStatus(status: number): boolean {
    if (status !== 0) return true;
    this.closeConnection(1013, "outbound frame dropped");
    return false;
  }

  /** Flushes frames after Bun signals that its own socket buffer drained. */
  drain(): void {
    while (!this.closed && this.queue.length > 0 && this.socket.bufferedAmount === 0) {
      const frame = this.queue.shift();
      if (frame === undefined) break;
      this.queuedBytes -= frame.boundedBytes;
      const status = this.socket.send(frame.payload);
      if (!this.acceptSendStatus(status) || status === -1) break;
    }
  }

  /**
   * Ends THIS channel and leaves the socket alone: the client hears `channel_closed`
   * with the same close-code vocabulary a socket close used to carry, and every other
   * room on the connection keeps streaming. The announcement bypasses the queue because
   * the queue is being discarded in the same breath.
   */
  close(code: number, reason: string): void {
    if (this.closed) return;
    const frame = serializeServerMessage({ type: "channel_closed", code, reason });
    this.socket.send(this.tag(frame.body));
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.onClosed(this);
  }

  /**
   * Closes the whole connection: reserved for failures of the transport or the
   * credential, where narrowing the blast radius to one room would be a lie.
   */
  closeConnection(code: number, reason: string): void {
    const alreadyClosed = this.closed;
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.socket.close(code, reason);
    if (!alreadyClosed) this.onClosed(this);
  }

  /** Whether this channel still holds a live membership. */
  get isClosed(): boolean {
    return this.closed;
  }
}
