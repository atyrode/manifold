import type { ServerMessageBody } from "@manifold/protocol";
import { base64ToBytes } from "@manifold/sdk";
import type { Terminal } from "@xterm/xterm";
import type { TerminalGraphics } from "./terminal-graphics";

type SnapshotFrame = Extract<ServerMessageBody, { type: "terminal_snapshot" }>;
type StreamTail = Extract<ServerMessageBody, { type: "terminal_output" | "terminal_geometry" }>;

const EMPTY_SNAPSHOT = new Uint8Array(0);

/** One xterm parser queue, retained with the view rather than with any socket seat. */
export class TerminalStream {
  private awaitingSnapshot = true;
  private painted = false;
  private lastWrittenSeq = 0;
  private geometry: SnapshotFrame["geometry"] | null = null;
  private pending: StreamTail[] = [];
  private deliveryGeneration = 0;
  private parserGeneration = 0;
  private disposed = false;

  constructor(
    private readonly terminal: Terminal,
    private readonly graphics: TerminalGraphics,
  ) {}

  snapshot(
    message: SnapshotFrame,
    prepare: (preserved: boolean) => void,
    settled: () => void,
  ): void {
    if (this.disposed) return;
    const previous = this.geometry;
    // A late attach snapshot cannot roll a LIVE viewer back over already accepted bytes
    // or geometry. A reconnect's first snapshot is authoritative even after a PTY reset.
    if (
      !this.awaitingSnapshot &&
      (message.seq < this.lastWrittenSeq ||
        (previous !== null &&
          previous.revision !== null &&
          message.geometry.revision !== null &&
          message.geometry.revision < previous.revision))
    ) {
      return;
    }
    const preserved =
      this.painted &&
      message.seq === this.lastWrittenSeq &&
      previous !== null &&
      message.geometry.revision === previous.revision &&
      message.geometry.cols === previous.cols &&
      message.geometry.rows === previous.rows;
    const generation = ++this.deliveryGeneration;
    prepare(preserved);
    this.awaitingSnapshot = false;
    this.painted = true;
    this.lastWrittenSeq = message.seq;
    this.geometry = message.geometry;
    const pending = this.pending;
    this.pending = [];
    if (!preserved) {
      this.graphics.writeSnapshot(base64ToBytes(message.data), message.geometry);
    }
    for (const frame of pending) {
      // Legacy snapshots use the latest broker record, which already covers earlier
      // unrevisioned admissions. Only source revisions establish an ordered pending tail.
      if (frame.type === "terminal_geometry" && frame.geometry.revision === null) continue;
      this.write(frame);
    }
    this.terminal.write("", () => {
      if (!this.disposed && generation === this.deliveryGeneration) settled();
    });
  }

  append(message: StreamTail): void {
    if (this.disposed) return;
    if (this.awaitingSnapshot) {
      this.pending.push(message);
      return;
    }
    this.write(message);
  }

  /** Fence delivery callbacks, but retain the painted watermark and modes across a handoff. */
  suspend(): void {
    this.deliveryGeneration++;
    this.awaitingSnapshot = true;
    this.pending = [];
  }

  /** A new PTY owns fresh byte and geometry counters; old parser work cannot resize it. */
  restart(): void {
    this.suspend();
    this.parserGeneration++;
    this.painted = false;
    this.lastWrittenSeq = 0;
    this.geometry = null;
    this.graphics.writeSnapshot(EMPTY_SNAPSHOT, {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      revision: null,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.suspend();
    this.parserGeneration++;
  }

  private write(message: StreamTail): void {
    if (message.type === "terminal_output") {
      if (message.seq <= this.lastWrittenSeq) return;
      this.terminal.write(base64ToBytes(message.data));
      this.lastWrittenSeq = message.seq;
      return;
    }
    const geometry = message.geometry;
    const previous = this.geometry;
    if (
      previous !== null &&
      (geometry.revision === null
        ? geometry.cols === previous.cols && geometry.rows === previous.rows
        : previous.revision !== null && geometry.revision <= previous.revision)
    ) {
      return;
    }
    // Byte seq is only a watermark here: several real idle resizes can share it.
    this.geometry = geometry;
    const generation = this.parserGeneration;
    this.terminal.write("", () => {
      if (this.disposed || generation !== this.parserGeneration) return;
      this.terminal.resize(geometry.cols, geometry.rows);
    });
  }
}
