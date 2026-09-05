import { MAX_TERMINAL_HOST_FRAME_BYTES, MAX_TERMINAL_HOST_QUEUE_BYTES } from "@manifold/protocol";

/**
 * Newline-delimited JSON over a Unix socket, bounded on both sides. Shared by the terminal
 * host (listener) and the transport (dialer) so both halves parse and queue by one rule:
 * a line longer than {@link MAX_TERMINAL_HOST_FRAME_BYTES} is a protocol error, and a peer that
 * lets more than {@link MAX_TERMINAL_HOST_QUEUE_BYTES} pile up unread is disconnected.
 */

const NEWLINE = 0x0a;

/** Thrown by {@link FrameReader} when a line grows past the frame ceiling without ending. */
export class FrameTooLargeError extends Error {
  override readonly name = "FrameTooLargeError";
}

/** Splits a byte stream into complete lines, holding at most one partial line. */
export class FrameReader {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxFrameBytes: number = MAX_TERMINAL_HOST_FRAME_BYTES) {}

  /** Appends a chunk and returns every complete line it closed, in order. */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.byteLength; i += 1) {
      if (chunk[i] !== NEWLINE) continue;
      const tail = chunk.subarray(start, i);
      if (this.pendingBytes + tail.byteLength > this.maxFrameBytes) {
        throw new FrameTooLargeError(`frame exceeds ${this.maxFrameBytes} bytes`);
      }
      lines.push(this.take(tail));
      start = i + 1;
    }
    if (start < chunk.byteLength) {
      // Copy: Bun reuses the read buffer between data callbacks.
      const rest = new Uint8Array(chunk.subarray(start));
      this.pendingBytes += rest.byteLength;
      if (this.pendingBytes > this.maxFrameBytes) {
        throw new FrameTooLargeError(`frame exceeds ${this.maxFrameBytes} bytes`);
      }
      this.pending.push(rest);
    }
    return lines;
  }

  private take(tail: Uint8Array): string {
    if (this.pending.length === 0) return Buffer.from(tail).toString("utf8");
    const parts = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    parts.push(tail);
    return Buffer.concat(parts).toString("utf8");
  }
}

/** The subset of `Bun.Socket` a {@link FrameWriter} drives; a test may pass a fake. */
export interface WritableSocket {
  write(data: Uint8Array): number;
  end(): void;
}

/**
 * Writes frames in order, buffering what the kernel could not take until `drain`, and
 * declares the peer sick once the backlog passes the queue ceiling — the caller then closes.
 */
export class FrameWriter {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private overflowed = false;

  constructor(
    private readonly socket: WritableSocket,
    private readonly onOverflow: (queuedBytes: number) => void,
    private readonly maxQueueBytes: number = MAX_TERMINAL_HOST_QUEUE_BYTES,
  ) {}

  /** Bytes waiting for the peer to read. */
  get backlog(): number {
    return this.queuedBytes;
  }

  /** Encodes one frame as a line and writes or queues it. Returns false once overflowed. */
  send(frame: unknown): boolean {
    if (this.overflowed) return false;
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (this.queue.length === 0) {
      const written = this.socket.write(bytes);
      if (written >= bytes.byteLength) return true;
      this.enqueue(bytes.subarray(Math.max(0, written)));
    } else {
      this.enqueue(bytes);
    }
    return !this.overflowed;
  }

  /** `drain` callback: the kernel accepted more; push what was waiting. */
  flush(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head === undefined) break;
      const written = this.socket.write(head);
      if (written < head.byteLength) {
        this.queue[0] = head.subarray(Math.max(0, written));
        this.queuedBytes -= Math.max(0, written);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= head.byteLength;
    }
  }

  private enqueue(bytes: Uint8Array): void {
    this.queue.push(bytes);
    this.queuedBytes += bytes.byteLength;
    if (this.queuedBytes > this.maxQueueBytes && !this.overflowed) {
      this.overflowed = true;
      this.queue = [];
      this.onOverflow(this.queuedBytes);
    }
  }
}
