import { Duplex } from "node:stream";
import { ServiceTunnelFrameSchema, type ServiceTunnelFrame } from "@manifold/protocol";

const FRAME_BYTES = 16 * 1024;

type WriteCallback = (error?: Error | null) => void;

class ServiceTunnelError extends Error {
  constructor() {
    super("service_tunnel_closed");
    this.name = "ServiceTunnelError";
  }
}

export interface ServiceTunnelOptions {
  channelId: string;
  /** False means the owner transport cannot accept the frame, not a request to retry. */
  send: (frame: ServiceTunnelFrame) => boolean;
  signal: AbortSignal;
}

export interface ServiceTunnel {
  stream: Duplex;
  receive: (frame: unknown) => void;
  close: () => void;
}

/** A byte stream on an already authenticated owner channel. Data and EOF share a
 * sequence starting at zero in each direction, and both require an exact ACK.
 * One frame may be outstanding; push(false) withholds its ACK until read demand.
 * Readable buffering is at most two frames, and writes use Node's ordinary
 * backpressure (callers must respect write(false)), without a second write queue.
 * EOF closes only the sending half; close/abort destroy both halves. */
export function createServiceTunnel(options: ServiceTunnelOptions): ServiceTunnel {
  const { channelId, send, signal } = options;
  if (!ServiceTunnelFrameSchema.safeParse({ type: "close", channelId }).success) {
    throw new ServiceTunnelError();
  }

  let closed = false;
  let notifyPeer = true;
  let pumping = false;
  let sendSequence = 0;
  let receiveSequence = 0;
  let awaitingAck: number | undefined;
  let readAck: number | undefined;
  let localEnd = false;
  let remoteEnd = false;
  let pendingWrite: { chunk: Buffer; offset: number; callback: WriteCallback } | undefined;
  let pendingFinal: WriteCallback | undefined;

  const stream = new Duplex({
    allowHalfOpen: true,
    autoDestroy: true,
    readableHighWaterMark: FRAME_BYTES,
    writableHighWaterMark: FRAME_BYTES,
    read() {
      acknowledgeRead();
    },
    write(chunk: Buffer, _encoding, callback) {
      pendingWrite = { chunk, offset: 0, callback };
      pump();
    },
    final(callback) {
      pendingFinal = callback;
      pump();
    },
    destroy(error, callback) {
      closed = true;
      signal.removeEventListener("abort", close);
      const write = pendingWrite;
      const final = pendingFinal;
      pendingWrite = undefined;
      pendingFinal = undefined;
      awaitingAck = undefined;
      readAck = undefined;
      // Do not close a peer that still needs to consume its buffered response
      // after both wire halves have ended normally.
      if (notifyPeer && !(localEnd && remoteEnd && !final)) {
        try {
          send({ type: "close", channelId });
        } catch {
          // Teardown is best effort: the failed transport owns disconnection.
        }
      }
      const failure = new ServiceTunnelError();
      write?.callback(failure);
      final?.(failure);
      callback(error ? failure : null);
    },
  });

  function close(): void {
    if (!closed) stream.destroy(new ServiceTunnelError());
  }

  function transmit(frame: ServiceTunnelFrame): boolean {
    if (closed || stream.destroyed) return false;
    try {
      if (send(frame)) return !closed && !stream.destroyed;
    } catch {
      // Never copy owner transport errors, arbitrary peer data or abort reasons.
    }
    close();
    return false;
  }

  function acknowledgeRead(): void {
    if (readAck === undefined || closed) return;
    const sequence = readAck;
    readAck = undefined;
    transmit({ type: "ack", channelId, sequence });
  }

  function pump(): void {
    // Local transports can deliver and acknowledge synchronously. The loop
    // handles that without recursive writes or an unbounded microtask queue.
    if (pumping || closed || stream.destroyed) return;
    pumping = true;
    try {
      while (!closed && !stream.destroyed && awaitingAck === undefined) {
        const write = pendingWrite;
        if (write && write.offset === write.chunk.length) {
          pendingWrite = undefined;
          write.callback();
          continue;
        }
        if (!write && (!pendingFinal || localEnd)) {
          const final = pendingFinal;
          pendingFinal = undefined;
          final?.();
          break;
        }
        if (!Number.isSafeInteger(sendSequence)) {
          close();
          break;
        }
        const sequence = sendSequence++;
        awaitingAck = sequence;
        if (write) {
          const end = Math.min(write.offset + FRAME_BYTES, write.chunk.length);
          const data = write.chunk.toString("base64", write.offset, end);
          write.offset = end;
          if (!transmit({ type: "data", channelId, sequence, data })) break;
        } else {
          localEnd = true;
          if (!transmit({ type: "end", channelId, sequence })) break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function receive(raw: unknown): void {
    if (closed || stream.destroyed) return;
    let frame: ServiceTunnelFrame;
    try {
      const parsed = ServiceTunnelFrameSchema.safeParse(raw);
      if (!parsed.success || parsed.data.channelId !== channelId) {
        close();
        return;
      }
      frame = parsed.data;
    } catch {
      close();
      return;
    }
    switch (frame.type) {
      case "close":
        notifyPeer = false;
        close();
        return;
      case "ack":
        if (awaitingAck === undefined || frame.sequence !== awaitingAck) {
          close();
          return;
        }
        awaitingAck = undefined;
        pump();
        return;
      case "data": {
        if (remoteEnd || readAck !== undefined || frame.sequence !== receiveSequence) {
          close();
          return;
        }
        // Bound allocation even if protocol validation changes. Buffer's base64
        // decoder alone is permissive, so never accept its repaired spellings.
        if (frame.data.length > Math.ceil(FRAME_BYTES / 3) * 4) {
          close();
          return;
        }
        const bytes = Buffer.from(frame.data, "base64");
        if (
          bytes.length === 0 ||
          bytes.length > FRAME_BYTES ||
          stream.readableLength + bytes.length > 2 * FRAME_BYTES ||
          bytes.toString("base64") !== frame.data
        ) {
          close();
          return;
        }
        receiveSequence++;
        readAck = frame.sequence;
        if (stream.push(bytes) && readAck === frame.sequence) acknowledgeRead();
        return;
      }
      case "end":
        if (remoteEnd || readAck !== undefined || frame.sequence !== receiveSequence) {
          close();
          return;
        }
        receiveSequence++;
        remoteEnd = true;
        if (transmit({ type: "ack", channelId, sequence: frame.sequence })) stream.push(null);
        return;
      default: {
        const exhaustive: never = frame;
        return exhaustive;
      }
    }
  }

  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  return { stream, receive, close };
}
