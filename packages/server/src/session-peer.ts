import { ServerMessageSchema, type ServerMessage } from "@manifold/protocol";
import type { AuthContext } from "./auth.ts";

const MAX_QUEUE_FRAMES = 256;
const MAX_QUEUE_BYTES = 1_048_576;

/** Bun's transport ceiling for authoritative server state and inbound WebSocket frames. */
export const SESSION_TRANSPORT_PAYLOAD_BYTES = 16 * 1_048_576;

/** Minimal socket surface shared by Bun production sockets and deterministic fakes. */
export interface RawSocket {
  readonly bufferedAmount: number;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

/** One schema-checked wire payload reusable across every peer in a room broadcast. */
export interface SerializedServerMessage {
  readonly type: ServerMessage["type"];
  readonly payload: string;
  readonly bytes: number;
  readonly authoritative: boolean;
}

interface QueuedFrame extends SerializedServerMessage {
  /** Authoritative init/resync bytes are bounded by the transport, not the flood queue. */
  boundedBytes: number;
}

/** Validates and serializes a server frame exactly once before fanout. */
export function serializeServerMessage(message: ServerMessage): SerializedServerMessage {
  const parsed = ServerMessageSchema.parse(message);
  const payload = JSON.stringify(parsed);
  return {
    type: parsed.type,
    payload,
    bytes: Buffer.byteLength(payload),
    authoritative: parsed.type === "init" || parsed.type === "resync",
  };
}

/** Joined session socket with schema-checked, explicitly bounded outbound buffering. */
export class SessionPeer {
  private queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private closed = false;

  constructor(
    readonly id: string,
    readonly socket: RawSocket,
    readonly auth: AuthContext,
    readonly padId: string,
  ) {}

  /** Enqueues a protocol message or drops it when explicitly marked best-effort. */
  send(message: ServerMessage, droppable = false): boolean {
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
    if (frame.bytes > SESSION_TRANSPORT_PAYLOAD_BYTES) {
      this.close(1009, "outbound frame exceeds transport limit");
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

    const boundedBytes = frame.authoritative ? 0 : frame.bytes;
    if (
      this.queue.length >= MAX_QUEUE_FRAMES ||
      boundedBytes > MAX_QUEUE_BYTES ||
      this.queuedBytes + boundedBytes > MAX_QUEUE_BYTES
    ) {
      this.close(1013, "outbound queue overflow");
      return false;
    }

    if (this.queue.length > 0 || this.socket.bufferedAmount > 0) {
      this.queue.push({ ...frame, boundedBytes });
      this.queuedBytes += boundedBytes;
      return true;
    }

    return this.acceptSendStatus(this.socket.send(frame.payload));
  }

  private acceptSendStatus(status: number): boolean {
    if (status !== 0) return true;
    this.close(1013, "outbound frame dropped");
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

  /** Closes this peer and discards any application-side backlog. */
  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.socket.close(code, reason);
  }
}
