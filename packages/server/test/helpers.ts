import { assembleRoster, type Assembly, type PluginDef } from "@manifold/plugin";
import {
  ServerMessageBodySchema,
  ServerMessageSchema,
  type PlaceResponse,
  type PlacementRef,
  type RuntimeDeps,
  type ServerMessage,
  type ServerMessageBody,
  type TileEdge,
  type TileRef,
} from "@manifold/protocol";
import { FLOOR_EVENT_OWNERS, SERVER_PLUGIN_DEFS, SHIPPED_PLUGIN_IDS } from "../src/assembly.ts";
import type { AuthService } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { EventHub } from "../src/event-hub.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import {
  PlaceExecutor,
  assemblyPlacementVocabulary,
  assemblyItemNouns,
  assemblyTileTrees,
  type PlaceOutcome,
} from "../src/placement.ts";
import { PluginHost, type MachineLiveness } from "../src/plugin-host.ts";
import type { RoomManager, RoomTimers, TileTreeDisciplines } from "../src/room.ts";
import type { RawSocket } from "../src/session-channel.ts";
import { ServerStore } from "../src/stores.ts";
import type { TerminalBroker } from "../src/terminal-broker.ts";

/** What a test instance calls itself. Fixed, because no test dials a second process. */
const TEST_ORIGIN = "http://localhost:7777";

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
  containerId: string,
  elementId: string,
): { readonly removed: number } | string {
  const result = placed(
    placement.place({
      ref: { kind: "element", containerId, elementId },
      destination: { kind: "unplaced" },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "unplace" ? { removed: result.removed } : `unexpected:${result.op}`;
}

/** Every reference to an item goes, named by the item's own identity rather than a copy. */
export function unplaceTerminal(
  placement: PlaceExecutor,
  terminalId: string,
): { readonly removed: number } | string {
  const result = placed(
    placement.place({
      ref: { kind: "terminal", terminalId },
      destination: { kind: "unplaced" },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "unplace" ? { removed: result.removed } : `unexpected:${result.op}`;
}

/** A tileable ref joins a composition. */
export function placeTile(
  placement: PlaceExecutor,
  containerId: string,
  ref: TileRef,
  targetTileId: string | null,
  edge: TileEdge | null,
): { readonly tileId: string } | string {
  const result = placed(
    placement.place({
      ref: tileRefAsPlacement(ref, containerId),
      destination: { kind: "tile", containerId, targetTileId, edge },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "add_tile" ? { tileId: result.tileId } : `unexpected:${result.op}`;
}

/**
 * A leaf's occupant leaves the composition and lands on `destinationContainerId`. A terminal
 * is re-homed into a fresh solo composition and referenced from there, so the returned
 * element is a portal — never an element carrying a terminal.
 */
export function extractTile(
  placement: PlaceExecutor,
  containerId: string,
  tileId: string,
  destinationContainerId: string,
  x: number,
  y: number,
): { readonly elementId: string } | string {
  const result = placed(
    placement.place({
      ref: { kind: "tile", containerId, tileId },
      destination: { kind: "canvas", containerId: destinationContainerId, x, y },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "extract" ? { elementId: result.elementId } : `unexpected:${result.op}`;
}

/** Two references on one canvas merge into a new composition holding both items. */
export function composeOnCanvas(
  placement: PlaceExecutor,
  containerId: string,
  targetElementId: string,
  ref: PlacementRef,
  edge: TileEdge,
): { readonly containerId: string; readonly tileId: string } | string {
  const result = placed(
    placement.place({
      ref,
      destination: { kind: "compose", containerId, targetElementId, edge },
    }),
  );
  if (typeof result === "string") return result;
  return result.op === "compose"
    ? { containerId: result.containerId, tileId: result.tileId }
    : `unexpected:${result.op}`;
}

/**
 * Tile refs name items the way a LEAF does; placement refs name them the way a GESTURE
 * does. A note is the one form where they differ, so it is translated here.
 */
function tileRefAsPlacement(ref: TileRef, containerId: string): PlacementRef {
  switch (ref.kind) {
    case "terminal":
      return { kind: "terminal", terminalId: ref.terminalId };
    case "container":
      return { kind: "container", containerId: ref.containerId };
    case "text":
      return { kind: "element", containerId, elementId: ref.elementId };
    case "panel":
      // No placement ref names a panel: a workspace layout is written whole by
      // `core.space.setLayout`, never by the placement door, so a panel leaf cannot be the
      // subject of a drag this helper translates.
      throw new Error(`panels are not placement refs: ${ref.panelId}`);
    case "spacer":
      // Same reasoning: a spacer (issue #89) is workspace-tree furniture, never a placement
      // door's subject.
      throw new Error("spacers are not placement refs");
    default: {
      const exhaustive: never = ref;
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
 * THE SHIPPED DISCIPLINES' TILE-TREE ANSWER (`TileTreeDisciplines`), which every fixture
 * that builds a room or a broker needs before it has a host to ask — the host is assembled
 * OVER both, so there is no live roster at that point in any of these files.
 *
 * It composes the same defs production composes, for the reason `testPluginHost` does: a
 * hand-written declaration would let a fixture seed a tile tree the server would not, or
 * refuse a placement the server accepts. Static rather than a host thunk because a room
 * asks this question once, at construction, and no fixture toggles a discipline off.
 */
const SHIPPED_ROSTER = assembleRoster(
  SERVER_PLUGIN_DEFS.map((def): PluginDef => ({ manifest: def.manifest, actions: def.actions })),
  new Set(),
  { distribution: SHIPPED_PLUGIN_IDS },
).roster;
export const testTileTrees: TileTreeDisciplines = assemblyTileTrees(
  assemblyPlacementVocabulary(() => SHIPPED_ROSTER),
);

/**
 * The real event plane, in a test — for the same reason `testPluginHost` assembles the real
 * defs: a hub validating emissions against a hand-written vocabulary would accept kinds the
 * production assembly refuses by name.
 */
export function testEventHub(
  store: ServerStore,
  auth: AuthService,
  broker: TerminalBroker,
  assembly: () => Assembly,
  runtime: RuntimeDeps,
  logger: Logger = silentLogger,
): EventHub {
  return new EventHub(
    { assembly, terminals: broker, owners: FLOOR_EVENT_OWNERS },
    auth,
    store,
    runtime,
    logger,
  );
}

/**
 * The real assembly, in a test. Tests assemble the SAME defs production does — a fixture
 * with a hand-written plugin list would let the action door pass here and refuse in the
 * server, which is exactly the divergence the registry exists to prevent.
 */
export async function testPluginHost(
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
    /**
     * The event plane. Supplied when a test drives subscriptions itself; otherwise one is
     * built here and installed on the broker and the rooms exactly as `main.ts` does, so a
     * fixture that never mentions events still exercises the production emission path.
     */
    readonly events?: EventHub;
    /**
     * The guest end of cross-instance sharing. A real one by default over the same store,
     * because it dials nothing until a row exists and a fixture that stubbed it would let
     * the `core.access` dial doors pass here and refuse in the server.
     */
    readonly dialer?: InstanceDialer;
  } = {},
): Promise<PluginHost> {
  /*
    The executor and the host are mutually dependent — the executor resolves legality against
    the live assembly, and an assembled action drives the executor — which is exactly what
    the roster THUNK exists for. Resolving it lazily through the host reproduces the
    production wiring instead of freezing a roster a reassembly would invalidate. The hub
    reads the assembly the same way and for the same reason.
  */
  let host: PluginHost | null = null;
  const placement = new PlaceExecutor(
    store,
    rooms,
    broker,
    runtime,
    assemblyPlacementVocabulary(() => host?.roster() ?? []),
    assemblyItemNouns(() => host?.roster() ?? []),
  );
  const events =
    options.events ??
    testEventHub(
      store,
      auth,
      broker,
      () => {
        if (host === null) throw new Error("the event plane read the assembly before the host");
        return host.assembly();
      },
      runtime,
      options.logger ?? silentLogger,
    );
  host = await PluginHost.boot(
    SERVER_PLUGIN_DEFS,
    store,
    auth,
    rooms,
    broker,
    placement,
    options.machines ?? { isOnline: () => false },
    options.dialer ??
      new InstanceDialer(store, runtime, options.logger ?? silentLogger, () => TEST_ORIGIN),
    runtime,
    options.logger ?? silentLogger,
    events,
    /*
      The `core.` reservation, wired exactly as `main.ts` wires it: a fixture that dropped it
      would compose a roster production refuses, which is the divergence this whole file
      exists to prevent.
    */
    { ...options, distribution: SHIPPED_PLUGIN_IDS },
  );
  if (options.events === undefined) {
    broker.setEvents(events);
    rooms.setEvents(events);
  }
  return host;
}

/**
 * THE SAME STORE, REASSEMBLED WITH ONE SEAT OFF — switched off out of band, which for an
 * `essential` seat is the only way it can be off at all.
 *
 * `engine.plugins.setEnabled` refuses `core.shell`, `core.space`, `core.index`, `core.access`,
 * `core.brand`, `core.keys` and `core.plugins` with the `essential` class (issue #113), and
 * that refusal is a rule at the DOOR rather than an impossibility: an assembly can still boot
 * with the row in the store's disabled set — an operator editing SQLite, or a shipped seat
 * that lost its flag between releases — which is precisely the state the floor's recovery gate
 * exists to answer (`EssentialRecovery`). So the disabled-door contracts are still owed by
 * every one of those plugins: rung 2 refuses, and the `cleanup` carve-outs must still let an
 * administrator remove what is left (D12). This is how a test reaches that state honestly,
 * instead of asserting a door answer the door no longer gives.
 *
 * A second host over the same store, rooms and broker, because an assembly is composed once
 * at boot; the fixture's original host keeps the roster it was built with and the caller uses
 * the one returned here.
 */
export async function hostWithSeatOff(
  parts: {
    readonly store: ServerStore;
    readonly auth: AuthService;
    readonly rooms: RoomManager;
    readonly broker: TerminalBroker;
    readonly runtime: RuntimeDeps;
  },
  id: string,
  changedBy = "out-of-band",
): Promise<PluginHost> {
  parts.store.setPluginEnabled(id, false, changedBy, parts.runtime.now());
  return testPluginHost(parts.store, parts.auth, parts.rooms, parts.broker, parts.runtime);
}
