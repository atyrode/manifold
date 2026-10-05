import {
  MAX_TERMINAL_PARSER_BYTES,
  MAX_TERMINAL_PARSER_FRAMES,
  terminalDeliveryCharge,
  type ServerMessageBody,
} from "@manifold/protocol";
import { base64ToBytes } from "@manifold/sdk";
import type { Terminal } from "@xterm/xterm";
import type { TerminalGraphics } from "./terminal-graphics";

type SnapshotFrame = Extract<ServerMessageBody, { type: "terminal_snapshot" }>;
type StreamTail = Extract<ServerMessageBody, { type: "terminal_output" | "terminal_geometry" }>;

const EMPTY_SNAPSHOT = new Uint8Array(0);

/** The view's side of one server delivery incarnation, bound by the snapshot that starts it. */
export interface TerminalDeliveryHandlers {
  /**
   * The snapshot reached the parser. `preserved` keeps the painted buffer and its modes; any
   * other replay resets them. Called even for a retired delivery whose replay still runs.
   */
  prepare(preserved: boolean): void;
  /** The snapshot replay, including its geometry, completed for the current delivery. */
  settled(): void;
  /** Cumulatively credits this delivery's completed frames through `deliverySeq`. */
  acknowledge(deliveryId: string, deliverySeq: number): void;
  /** The delivery exceeded the browser parser bound or broke its ordinals; it stays unparsed. */
  stalled(): void;
}

interface Delivery {
  readonly id: string;
  readonly handlers: TerminalDeliveryHandlers;
  /** Last accepted ordinal; the snapshot is 0 and its tail is consecutive. */
  received: number;
  recovering: boolean;
}

type Work =
  | {
      readonly kind: "snapshot";
      readonly frame: SnapshotFrame;
      readonly delivery: Delivery;
      readonly charge: number;
    }
  | {
      readonly kind: "tail";
      readonly frame: StreamTail;
      readonly delivery: Delivery;
      readonly charge: number;
    }
  | { readonly kind: "reset" }
  | { readonly kind: "barrier"; callback: () => void };

/**
 * One xterm parser, fed by at most one real write or barrier at a time and retained with the
 * view rather than with any socket seat. Credited work is charged with the wire unit of
 * `terminalDeliveryCharge` (base64 `data` characters; geometry is one frame of zero bytes):
 * the active and queued frames, including retired work still in xterm, never exceed
 * MAX_TERMINAL_PARSER_BYTES or MAX_TERMINAL_PARSER_FRAMES. A frame is acknowledged only after
 * xterm completed it, including a snapshot's replay and every applied resize. A retired
 * delivery is never credited: at most its one in-flight operation finishes before a replay.
 */
export class TerminalStream {
  private painted = false;
  /** A snapshot of the current byte stream finished replaying and nothing was discarded since. */
  private replayed = false;
  /** Byte and geometry watermarks of the work already handed to xterm. */
  private appliedSeq = 0;
  private geometry: SnapshotFrame["geometry"] | null = null;
  private delivery: Delivery | null = null;
  private queue: Work[] = [];
  private active: Work | null = null;
  private chargedBytes = 0;
  private chargedFrames = 0;
  private acknowledgement: { readonly delivery: Delivery; readonly deliverySeq: number } | null =
    null;
  private disposed = false;

  constructor(
    private readonly terminal: Terminal,
    private readonly graphics: TerminalGraphics,
  ) {}

  /** The delivery whose frames this view accepts, or null while awaiting a snapshot. */
  get deliveryId(): string | null {
    return this.delivery?.id ?? null;
  }

  /** The parsed screen and modes reflect the current byte stream, so input may follow them. */
  get coherent(): boolean {
    return this.replayed;
  }

  /**
   * Adopts a fresh delivery. Its snapshot is authoritative: earlier deliveries' unparsed work is
   * discarded, and it replays only after the operation already in xterm completes.
   */
  snapshot(frame: SnapshotFrame, handlers: TerminalDeliveryHandlers): boolean {
    if (this.disposed || frame.deliveryId === this.delivery?.id) return false;
    this.retire(true);
    this.replayed = false;
    const delivery: Delivery = {
      id: frame.deliveryId,
      handlers,
      received: frame.deliverySeq,
      recovering: false,
    };
    this.delivery = delivery;
    const charge = terminalDeliveryCharge(frame);
    if (
      this.chargedBytes + charge > MAX_TERMINAL_PARSER_BYTES ||
      this.chargedFrames + 1 > MAX_TERMINAL_PARSER_FRAMES
    ) {
      // A handoff cannot erase work already in xterm to admit an oversized new lane.
      this.delivery = null;
      this.replayed = false;
      handlers.stalled();
      return false;
    }
    this.chargedBytes += charge;
    this.chargedFrames += 1;
    this.queue.push({ kind: "snapshot", frame, delivery, charge });
    this.pump();
    return true;
  }

  append(frame: StreamTail): void {
    const delivery = this.delivery;
    if (this.disposed || delivery === null || frame.deliveryId !== delivery.id) return;
    if (frame.deliverySeq <= delivery.received) return;
    const charge = terminalDeliveryCharge(frame);
    if (
      frame.deliverySeq !== delivery.received + 1 ||
      this.chargedFrames + 1 > MAX_TERMINAL_PARSER_FRAMES ||
      this.chargedBytes + charge > MAX_TERMINAL_PARSER_BYTES
    ) {
      // Never parse a tail after a gap or beyond the bound: only a fresh snapshot recovers.
      this.retire(true);
      this.replayed = false;
      delivery.handlers.stalled();
      return;
    }
    delivery.received = frame.deliverySeq;
    this.chargedBytes += charge;
    this.chargedFrames += 1;
    this.queue.push({ kind: "tail", frame, delivery, charge });
    this.pump();
  }

  /**
   * Runs `callback` once the work queued before it has completed. It replaces an adjacent
   * pending barrier's callback, so repeated local requests never grow the queue.
   */
  barrier(callback: () => void): void {
    if (this.disposed) return;
    const last = this.queue.at(-1);
    if (last?.kind === "barrier") last.callback = callback;
    else this.queue.push({ kind: "barrier", callback });
    this.pump();
  }

  /**
   * Retires the delivery across a handoff, exit or disconnect. Accepted frames still parse in
   * order without credit, so the painted watermark and modes survive for the next snapshot.
   */
  suspend(): void {
    this.retire(false);
  }

  /** Keep accepted parser debt payable, but only a new delivery can restore input coherence. */
  recover(): void {
    this.replayed = false;
    if (this.delivery !== null) this.delivery.recovering = true;
  }

  /**
   * The server retired this view's attachment. Accepted frames still parse without credit, but
   * nothing newer will arrive, so input waits for a fresh snapshot's replay.
   */
  refuse(): void {
    this.retire(false);
    this.replayed = false;
  }

  /** A new PTY owns fresh byte and geometry counters; old parser work cannot resize it. */
  restart(): void {
    if (this.disposed) return;
    this.retire(true);
    this.replayed = false;
    this.painted = false;
    this.appliedSeq = 0;
    this.geometry = null;
    if (!this.queue.some((work) => work.kind === "reset")) this.queue.push({ kind: "reset" });
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.retire(false);
    this.queue = [];
    this.active = null;
    this.chargedBytes = 0;
    this.chargedFrames = 0;
  }

  private retire(discard: boolean): void {
    this.delivery = null;
    this.acknowledgement = null;
    if (discard) {
      this.queue = this.queue.filter((work) => {
        if (work.kind === "snapshot" || work.kind === "tail") {
          this.chargedBytes -= work.charge;
          this.chargedFrames -= 1;
          return false;
        }
        return true;
      });
    }
  }

  private pump(): void {
    while (this.active === null && !this.disposed) {
      const work = this.queue.shift();
      if (work === undefined) break;
      this.active = work;
      if (!this.start(work)) break;
      this.active = null;
      this.complete(work);
    }
    const acknowledgement = this.acknowledgement;
    this.acknowledgement = null;
    if (acknowledgement !== null && acknowledgement.delivery === this.delivery) {
      acknowledgement.delivery.handlers.acknowledge(
        acknowledgement.delivery.id,
        acknowledgement.deliverySeq,
      );
    }
  }

  /** Hands one operation to xterm; true when it already completed without parser work. */
  private start(work: Work): boolean {
    const done = (): void => {
      if (this.active !== work) return;
      this.active = null;
      this.complete(work);
      this.pump();
    };
    switch (work.kind) {
      case "barrier":
        work.callback();
        return true;
      case "reset":
        this.graphics.writeSnapshot(
          EMPTY_SNAPSHOT,
          { cols: this.terminal.cols, rows: this.terminal.rows, revision: null },
          done,
        );
        return false;
      case "snapshot":
        return this.replay(work.frame, work.delivery, done);
      case "tail":
        return this.apply(work.frame, done);
      default: {
        const unreachable: never = work;
        return unreachable;
      }
    }
  }

  private complete(work: Work): void {
    if (work.kind !== "snapshot" && work.kind !== "tail") return;
    this.chargedBytes -= work.charge;
    this.chargedFrames -= 1;
    const delivery = work.delivery;
    if (delivery !== this.delivery) return;
    this.acknowledgement = { delivery, deliverySeq: work.frame.deliverySeq };
    if (work.kind === "snapshot" && !delivery.recovering) {
      this.replayed = true;
      delivery.handlers.settled();
    }
  }

  private replay(frame: SnapshotFrame, delivery: Delivery, done: () => void): boolean {
    const previous = this.geometry;
    const preserved =
      this.painted &&
      frame.seq === this.appliedSeq &&
      previous !== null &&
      frame.geometry.revision === previous.revision &&
      frame.geometry.cols === previous.cols &&
      frame.geometry.rows === previous.rows;
    delivery.handlers.prepare(preserved);
    this.painted = true;
    this.appliedSeq = frame.seq;
    this.geometry = frame.geometry;
    if (preserved) return true;
    this.graphics.writeSnapshot(base64ToBytes(frame.data), frame.geometry, done);
    return false;
  }

  private apply(frame: StreamTail, done: () => void): boolean {
    if (frame.type === "terminal_output") {
      if (frame.seq <= this.appliedSeq) return true;
      this.appliedSeq = frame.seq;
      this.terminal.write(base64ToBytes(frame.data), done);
      return false;
    }
    const geometry = frame.geometry;
    const previous = this.geometry;
    if (
      previous !== null &&
      (geometry.revision === null
        ? geometry.cols === previous.cols && geometry.rows === previous.rows
        : previous.revision !== null && geometry.revision <= previous.revision)
    ) {
      return true;
    }
    // Byte seq is only a watermark here: several real idle resizes can share it. Nothing else
    // is in xterm's parser now, so the resize lands exactly between its neighbouring bytes.
    this.geometry = geometry;
    this.terminal.resize(geometry.cols, geometry.rows);
    return true;
  }
}
