import { ServerMessageSchema, type ServerMessage } from "@manifold/protocol";
import type { AuthContext } from "./auth.ts";

const MAX_QUEUE_FRAMES = 256;
const MAX_QUEUE_BYTES = 1_048_576;

/** Minimal socket surface shared by Bun production sockets and deterministic fakes. */
export interface RawSocket {
  readonly bufferedAmount: number;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

interface QueuedFrame {
  payload: string;
  bytes: number;
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
    const payload = JSON.stringify(ServerMessageSchema.parse(message));
    const bytes = Buffer.byteLength(payload);
    if (this.closed) return false;
    if (droppable && (this.queue.length > 0 || this.socket.bufferedAmount > 0)) return false;

    const outstanding = this.socket.bufferedAmount + this.queuedBytes;
    if (
      this.queue.length >= MAX_QUEUE_FRAMES ||
      bytes > MAX_QUEUE_BYTES ||
      outstanding + bytes > MAX_QUEUE_BYTES
    ) {
      this.closed = true;
      this.queue = [];
      this.queuedBytes = 0;
      this.socket.close(1013, "outbound queue overflow");
      return false;
    }

    if (this.queue.length > 0 || this.socket.bufferedAmount > 0) {
      this.queue.push({ payload, bytes });
      this.queuedBytes += bytes;
      return true;
    }

    const sent = this.socket.send(payload);
    if (sent < 0) this.closed = true;
    return sent >= 0;
  }

  /** Flushes frames after Bun signals that its own socket buffer drained. */
  drain(): void {
    while (!this.closed && this.queue.length > 0 && this.socket.bufferedAmount === 0) {
      const frame = this.queue.shift();
      if (frame === undefined) break;
      this.queuedBytes -= frame.bytes;
      const sent = this.socket.send(frame.payload);
      if (sent < 0) this.closed = true;
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
