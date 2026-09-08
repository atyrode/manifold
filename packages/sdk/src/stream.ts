import {
  formatManifoldUri,
  type ManifoldRef,
  type StreamCursor,
  type StreamServerMessage,
} from "@manifold/protocol";

export interface OpenStreamOptions {
  readonly kind: string;
  readonly node: ManifoldRef;
  readonly cursor?: StreamCursor | undefined;
}
export type StreamStatus =
  "opening" | "open" | "reconnecting" | "gap" | "reset" | "refused" | "closed";
export type StreamListener = (message: StreamServerMessage) => void;
export interface StreamHandle {
  /** Latest bounded server snapshot; subsequent frames arrive through on(). */
  readonly snapshot: Extract<StreamServerMessage, { type: "stream_snapshot" }> | null;
  readonly cursor: StreamCursor | undefined;
  readonly status: StreamStatus;
  /** Replays the retained snapshot synchronously, then reports incremental messages. */
  on(listener: StreamListener): () => void;
  close(): void;
}

/** Shared by all holders of one wire subscription, never an unbounded client journal. */
export class StreamState {
  snapshot: StreamHandle["snapshot"] = null;
  cursor: StreamCursor | undefined;
  status: StreamStatus = "opening";
  private established = false;
  private readonly listeners = new Set<StreamListener>();

  private resetEpoch: string | undefined;
  constructor(
    readonly subscriptionId: string,
    readonly options: OpenStreamOptions,
  ) {
    this.cursor = options.cursor;
  }

  handle(release: () => void): StreamHandle {
    return StreamState.createHandle(this, release);
  }

  private static createHandle(state: StreamState, release: () => void): StreamHandle {
    let closed = false;
    let missedFrames = false;
    const mine = new Set<StreamListener>();
    return {
      get snapshot() {
        return state.snapshot;
      },
      get cursor() {
        return state.cursor;
      },
      get status() {
        return closed ? "closed" : missedFrames && state.status === "open" ? "gap" : state.status;
      },
      on(listener) {
        if (closed) return () => {};
        // Each handle owns its registration even when callers reuse one function.
        const registered: StreamListener = (message) => listener(message);
        mine.add(registered);
        state.listeners.add(registered);
        try {
          if (state.snapshot !== null) {
            listener(state.snapshot);
            if (
              !closed &&
              state.cursor?.epoch === state.snapshot.epoch &&
              state.cursor.seq > state.snapshot.lastSeq
            ) {
              missedFrames = true;
              listener({
                type: "stream_gap",
                subscriptionId: state.subscriptionId,
                epoch: state.cursor.epoch,
                fromSeq: state.snapshot.lastSeq + 1,
                toSeq: state.cursor.seq,
              });
            }
          }
        } catch (error) {
          console.error("evt=stream_listener_failed", error);
        }
        return () => {
          mine.delete(registered);
          state.listeners.delete(registered);
        };
      },
      close() {
        if (closed) return;
        closed = true;
        for (const listener of mine) state.listeners.delete(listener);
        mine.clear();
        release();
      },
    };
  }

  reconnect(): void {
    if (this.status === "closed" || this.status === "refused") return;
    this.status = "reconnecting";
    this.established = false;
  }

  receive(message: StreamServerMessage): void {
    if (this.status === "closed" || this.status === "refused") return;
    switch (message.type) {
      case "stream_snapshot": {
        if (
          message.kind !== this.options.kind ||
          formatManifoldUri(message.node) !== formatManifoldUri(this.options.node)
        )
          return;
        if (this.resetEpoch !== undefined && message.epoch !== this.resetEpoch) return;
        const frames = message.frames;
        if (
          frames.length > 0 &&
          (frames[0]?.seq !== message.firstSeq || frames.at(-1)?.seq !== message.lastSeq)
        )
          return;
        for (let at = 1; at < frames.length; at += 1) {
          if (frames[at]!.seq !== frames[at - 1]!.seq + 1) return;
        }
        const previous = this.cursor;
        if (previous?.epoch === message.epoch && message.lastSeq < previous.seq) return;
        if (
          this.established &&
          previous?.epoch === message.epoch &&
          message.lastSeq <= previous.seq
        )
          return;
        if (previous !== undefined && previous.epoch !== message.epoch) {
          this.receive({
            type: "stream_reset",
            subscriptionId: this.subscriptionId,
            epoch: message.epoch,
            reason: "epoch changed",
          });
        } else if (previous !== undefined && message.firstSeq > previous.seq + 1) {
          this.receive({
            type: "stream_gap",
            subscriptionId: this.subscriptionId,
            epoch: message.epoch,
            fromSeq: previous.seq + 1,
            toSeq: message.firstSeq - 1,
          });
        }
        this.snapshot = message;
        this.cursor = { epoch: message.epoch, seq: message.lastSeq };
        this.established = true;
        if (this.status !== "gap") this.status = "open";
        this.resetEpoch = undefined;
        break;
      }
      case "stream_frame": {
        if (!this.established || this.cursor === undefined) return;
        if (message.epoch !== this.cursor.epoch) {
          this.receive({
            type: "stream_reset",
            subscriptionId: this.subscriptionId,
            epoch: message.epoch,
            reason: "epoch changed without snapshot",
          });
          return;
        }
        if (message.seq <= this.cursor.seq) return;
        if (message.seq !== this.cursor.seq + 1) {
          this.receive({
            type: "stream_gap",
            subscriptionId: this.subscriptionId,
            epoch: message.epoch,
            fromSeq: this.cursor.seq + 1,
            toSeq: message.seq - 1,
          });
        }
        this.cursor = { epoch: message.epoch, seq: message.seq };
        break;
      }
      case "stream_gap":
        if (this.cursor !== undefined && message.epoch !== this.cursor.epoch) return;
        if (this.cursor !== undefined) {
          if (message.toSeq <= this.cursor.seq) return;
          this.cursor = { epoch: message.epoch, seq: message.toSeq };
        }
        this.status = "gap";
        break;
      case "stream_reset":
        this.snapshot = null;
        this.cursor = undefined;
        this.established = false;
        this.resetEpoch = message.epoch;
        this.status = "reset";
        break;
      case "stream_refused":
        this.status = "refused";
        break;
      case "stream_closed":
        this.status = "closed";
        break;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (error) {
        console.error("evt=stream_listener_failed", error);
      }
    }
  }
}
