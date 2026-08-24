import { ServerMessageSchema, type RuntimeDeps, type ServerMessage } from "@manifold/protocol";
import { openDatabase } from "../src/db.ts";
import type { RoomTimers } from "../src/room.ts";
import type { RawSocket } from "../src/session-peer.ts";
import { ServerStore } from "../src/stores.ts";

/** Seeded id/time boundary for deterministic server unit tests. */
export class FakeRuntime implements RuntimeDeps {
  time = 0;
  private nextId = 0;

  newId(): string {
    this.nextId += 1;
    return `id-${this.nextId}`;
  }

  now(): number {
    return this.time;
  }
}

interface ScheduledJob {
  at: number;
  callback: () => void;
}

/** Manual scheduler coupled to FakeRuntime, executing due jobs in chronological order. */
export class FakeClock implements RoomTimers {
  private readonly jobs = new Map<number, ScheduledJob>();
  private nextJob = 0;

  constructor(private readonly runtime: FakeRuntime) {}

  schedule(callback: () => void, delayMs: number): () => void {
    this.nextJob += 1;
    const id = this.nextJob;
    this.jobs.set(id, { at: this.runtime.time + delayMs, callback });
    return () => {
      this.jobs.delete(id);
    };
  }

  /** Number of callbacks still armed, used to prove lifecycle cancellation. */
  get pendingJobs(): number {
    return this.jobs.size;
  }

  /** Advances fake wall clock while faithfully running all timers due before the target. */
  advance(delayMs: number): void {
    const target = this.runtime.time + delayMs;
    while (true) {
      let selectedId: number | null = null;
      let selected: ScheduledJob | null = null;
      for (const [id, job] of this.jobs) {
        if (job.at > target) continue;
        if (
          selected === null ||
          job.at < selected.at ||
          (job.at === selected.at && id < selectedId!)
        ) {
          selectedId = id;
          selected = job;
        }
      }
      if (selectedId === null || selected === null) break;
      this.jobs.delete(selectedId);
      this.runtime.time = selected.at;
      selected.callback();
    }
    this.runtime.time = target;
  }
}

/** RawSocket fake that records complete JSON text frames and close policy. */
export class FakeSocket implements RawSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: string): number {
    this.sent.push(data);
    return Buffer.byteLength(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Parses captured frames with the authoritative session-server schema. */
  messages(): ServerMessage[] {
    return this.sent.map((frame) => ServerMessageSchema.parse(JSON.parse(frame)));
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Opens a migrated isolated in-memory persistence store. */
export function testStore(): ServerStore {
  return new ServerStore(openDatabase(":memory:"));
}
