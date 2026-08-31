import {
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
import type { AuthService } from "../src/auth.ts";
import { SERVER_PLUGIN_DEFS } from "../src/composition.ts";
import { openDatabase } from "../src/db.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import { PlaceExecutor, compositionElementTraits, type PlaceOutcome } from "../src/placement.ts";
import { PluginHost, type MachineLiveness } from "../src/plugin-host.ts";
import type { RoomManager, RoomTimers } from "../src/room.ts";
import type { RawSocket } from "../src/session-peer.ts";
import { ServerStore } from "../src/stores.ts";
import type { TerminalBroker } from "../src/terminal-broker.ts";

/**
 * The retired verbs, expressed over `place()`.
 *
 * The executor has one envelope, not a method per gesture, but these ARE the gestures the
 * lifecycle tests are about — so naming them here keeps those tests readable while proving
 * the envelope covers every one. Nothing in `src/` depends on this file: it is test
 * vocabulary, not a shim.
 */

function placed(outcome: PlaceOutcome): PlaceResponse | string {
  if (outcome.status === "placed") return outcome.result;
  return outcome.status === "denied" ? `denied:${outcome.denial.rule}` : outcome.failure;
}

/**
 * One reference to an item goes; the item stays in the composition it lives in. This is
 * what park became: there is nowhere to park TO, so releasing is subtractive.
 */
export function unplaceElement(
  placement: PlaceExecutor,
  padId: string,
  elementId: string,
): { readonly removed: number } | string {
  const result = placed(
    placement.place({
      surface: { kind: "element", padId, elementId },
      destination: { kind: "unplaced" },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "unplace" ? { removed: result.removed } : `unexpected:${result.op}`;
}

/** Every reference to an item goes, named by the item's own identity rather than a copy. */
export function unplaceTerminal(
  placement: PlaceExecutor,
  sessionId: string,
): { readonly removed: number } | string {
  const result = placed(
    placement.place({
      surface: { kind: "terminal", sessionId },
      destination: { kind: "unplaced" },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "unplace" ? { removed: result.removed } : `unexpected:${result.op}`;
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

/**
 * A leaf's occupant leaves the composition and lands on `destinationPadId`. A terminal is
 * re-homed into a fresh solo composition and referenced from there, so the returned element
 * is a portal — never an element carrying a session.
 */
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

/** Two references on one canvas merge into a new composition holding both items. */
export function composeOnCanvas(
  placement: PlaceExecutor,
  padId: string,
  targetElementId: string,
  surface: PlacementSurface,
  edge: TileEdge,
): { readonly viewId: string; readonly tileId: string } | string {
  const result = placed(
    placement.place({
      surface,
      destination: { kind: "compose", padId, targetElementId, edge },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "compose"
    ? { viewId: result.viewId, tileId: result.tileId }
    : `unexpected:${result.op}`;
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
    case "panel":
      // No placement surface names a panel: a workspace layout is written whole by
      // `core.layout.set`, never by the placement door, so a panel leaf cannot be the
      // subject of a drag this helper translates.
      throw new Error(`panels are not placement surfaces: ${surface.panelId}`);
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

/**
 * The real composition, in a test. Tests compose the SAME defs production does — a fixture
 * with a hand-written plugin list would let the action door pass here and refuse in the
 * server, which is exactly the divergence the registry exists to prevent.
 */
export function testPluginHost(
  store: ServerStore,
  auth: AuthService,
  rooms: RoomManager,
  broker: TerminalBroker,
  runtime: RuntimeDeps,
  options: {
    readonly lifecycleTimeoutMs?: number;
    /** Machine liveness, defaulting to "nothing is connected" — the honest state of a store. */
    readonly machines?: MachineLiveness;
    /** A sink, for cases that assert what a dispatch DOES and does not record. */
    readonly logger?: Logger;
  } = {},
): PluginHost {
  /*
    The executor and the host are mutually dependent — the executor resolves legality against
    the live composition, and a composed action drives the executor — which is exactly what
    the roster THUNK exists for. Resolving it lazily through the host reproduces the
    production wiring instead of freezing a roster a recompose would invalidate.
  */
  let host: PluginHost | null = null;
  const placement = new PlaceExecutor(
    store,
    rooms,
    broker,
    runtime,
    compositionElementTraits(() => host?.roster() ?? []),
  );
  host = new PluginHost(
    SERVER_PLUGIN_DEFS,
    store,
    auth,
    rooms,
    broker,
    placement,
    options.machines ?? { isOnline: () => false },
    runtime,
    options.logger ?? silentLogger,
    options,
  );
  return host;
}
