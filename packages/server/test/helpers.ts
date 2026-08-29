import {
  DEFAULT_CANVAS_DROP,
  ServerMessageBodySchema,
  ServerMessageSchema,
  type PlaceResponse,
  type PlacementSurface,
  type RuntimeDeps,
  type ServerMessage,
  type ServerMessageBody,
  type TileEdge,
  type TileSurface,
} from "@manifold/protocol";
import { openDatabase } from "../src/db.ts";
import type { PlaceExecutor, PlaceOutcome } from "../src/placement.ts";
import type { RoomTimers } from "../src/room.ts";
import type { RawSocket } from "../src/session-peer.ts";
import { ServerStore } from "../src/stores.ts";

/**
 * The retired verbs, expressed over `place()`.
 *
 * The executor no longer has a `bind`/`park`/`addTile`/`compose`/`extract` method — one
 * envelope replaced all five — but these are still the gestures the lifecycle tests are
 * ABOUT, so naming them here keeps those tests readable while proving the envelope covers
 * every one. Nothing in `src/` depends on this file: it is test vocabulary, not a shim.
 */

function placed(outcome: PlaceOutcome): PlaceResponse | string {
  if (outcome.status === "placed") return outcome.result;
  return outcome.status === "denied" ? `denied:${outcome.denial.rule}` : outcome.failure;
}

/** A session leaves the container it is in and joins the workspace pool. */
export function parkSession(
  placement: PlaceExecutor,
  padId: string,
  elementId: string,
): "ok" | string {
  const result = placed(
    placement.place({
      surface: { kind: "element", padId, elementId },
      destination: { kind: "pool" },
    }),
  );
  return typeof result === "string" ? result : "ok";
}

/** A pooled session lands on a canvas at a point, or in a composition as a leaf. */
export function placeSession(
  placement: PlaceExecutor,
  sessionId: string,
  padId: string,
  layout: "canvas" | "tiled",
  at: { readonly x: number; readonly y: number } = DEFAULT_CANVAS_DROP,
): { readonly placementId: string } | string {
  const result = placed(
    placement.place({
      surface: { kind: "terminal", sessionId },
      destination:
        layout === "tiled"
          ? { kind: "tile", padId, targetTileId: null, edge: null }
          : { kind: "canvas", padId, x: at.x, y: at.y },
    }),
  );
  if (typeof result === "string") return result;
  if (result.op === "bind") return { placementId: result.elementId };
  if (result.op === "add_tile") return { placementId: result.tileId };
  return `unexpected:${result.op}`;
}

/** A tileable surface joins a composition. */
export function placeTile(
  placement: PlaceExecutor,
  padId: string,
  surface: TileSurface,
  targetTileId: string | null,
  edge: TileEdge | null,
): { readonly tileId: string } | string {
  const result = placed(
    placement.place({
      surface: tileSurfaceAsPlacement(surface, padId),
      destination: { kind: "tile", padId, targetTileId, edge },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "add_tile" ? { tileId: result.tileId } : `unexpected:${result.op}`;
}

/** A leaf's occupant leaves the composition and lands on `destinationPadId` at a point. */
export function extractTile(
  placement: PlaceExecutor,
  containerId: string,
  tileId: string,
  destinationPadId: string,
  x: number,
  y: number,
): { readonly elementId: string } | string {
  const result = placed(
    placement.place({
      surface: { kind: "tile", containerId, tileId },
      destination: { kind: "canvas", padId: destinationPadId, x, y },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "extract" ? { elementId: result.elementId } : `unexpected:${result.op}`;
}

/**
 * Storage surfaces name items the way a LEAF does; placement surfaces name them the way a
 * GESTURE does. A note is the one form where they differ, so it is translated here.
 */
function tileSurfaceAsPlacement(surface: TileSurface, padId: string): PlacementSurface {
  switch (surface.kind) {
    case "terminal":
      return { kind: "terminal", sessionId: surface.sessionId };
    case "pad":
      return { kind: "pad", padId: surface.padId };
    case "text":
      return { kind: "element", padId, elementId: surface.elementId };
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}

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

  /**
   * Captured frames as channel-agnostic BODIES: multiplexing added a routing id to every
   * channel frame, and a test about presence or terminal output is not a test about
   * routing. Both shapes are schema-validated, so a body view can never hide a malformed
   * wire frame; `frames()` is the routing view.
   */
  messages(): ServerMessageBody[] {
    return this.sent.map((frame) => {
      const raw = JSON.parse(frame) as Record<string, unknown>;
      ServerMessageSchema.parse(raw);
      delete raw["ch"];
      return ServerMessageBodySchema.parse(raw);
    });
  }

  /** Captured frames exactly as they went out, routing id included. */
  frames(): ServerMessage[] {
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
