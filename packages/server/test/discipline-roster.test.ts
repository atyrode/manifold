import { describe, expect, test } from "bun:test";
import {
  ROOT_TILE_ID,
  rosterDisciplines,
  type DisciplineDeclaration,
  type PlacementTraits,
  type PluginRoster,
} from "@manifold/protocol";
import { assembleRoster, type PluginDef } from "@manifold/plugin";
import { tileIdForRef } from "@manifold/scene";
import { SERVER_PLUGIN_DEFS } from "../src/assembly.ts";
import { AuthService } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import {
  assemblyItemNouns,
  assemblyPlacementVocabulary,
  assemblyTileTrees,
  PlaceExecutor,
  type TerminalPlacementPort,
} from "../src/placement.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

/**
 * Assembled discipline ownership and third-party room/placement behavior.
 * The exhaustive shipped placement matrix lives in placement.test.ts; distribution
 * membership is not frozen to the original two disciplines here.
 */
const defs: readonly PluginDef[] = SERVER_PLUGIN_DEFS.map((def) => ({
  manifest: def.manifest,
  actions: def.actions,
}));

const assembly = assembleRoster(defs, new Set());
const disciplines = rosterDisciplines(assembly.roster);

/** `ITEM_KINDS.canvas`, verbatim, as it read at v20. */
const CANVAS_AT_V20: PlacementTraits = {
  groups: ["tileable", "embeddable", "unplaceable", "canvas_item_as_portal"],
  guards: ["no_self_embed"],
  homed: "inline",
};

/** `ITEM_KINDS.composition`, verbatim, as it read at v20. */
const COMPOSITION_AT_V20: PlacementTraits = {
  groups: ["mergeable", "unplaceable", "canvas_item_as_portal"],
  guards: ["no_self_embed", "solo_only"],
  homed: "inline",
};

function declaration(id: string): DisciplineDeclaration {
  const found = disciplines.get(id);
  if (found === undefined) throw new Error(`the distribution composed no "${id}" discipline`);
  return found;
}

describe("the composed discipline roster", () => {
  test("a duplicate discipline claim refuses assembly, naming both claimants", () => {
    /*
      A discipline id is the value stored in `containers.discipline` and the key a renderer
      is looked up by, so two plugins claiming one would make what a stored row MEANS depend
      on composition order. It collides loudly, like every other contribution (D5).
    */
    const squatter: PluginDef = {
      manifest: {
        id: "acme.sheets",
        version: "1.0.0",
        title: "Sheets",
        description: "a second claimant",
        capabilities: [],
        contributes: {
          panels: [],
          sections: [],
          elements: [],
          disciplines: [
            {
              ...declaration("canvas"),
              item: {
                groups: [...CANVAS_AT_V20.groups],
                guards: [...CANVAS_AT_V20.guards],
                homed: CANVAS_AT_V20.homed,
              },
              accepts: [...declaration("canvas").accepts],
              guards: [...declaration("canvas").guards],
              destinations: [...declaration("canvas").destinations],
            },
          ],
          tools: [],
          events: [],
        },
      },
      actions: [],
    };
    let problem = "";
    try {
      assembleRoster([...defs, squatter], new Set());
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    expect(problem).toContain("discipline");
    expect(problem).toContain("canvas");
    expect(problem).toContain("core.canvas");
    expect(problem).toContain("acme.sheets");
  });
});

/**
 * A THIRD-PARTY TILE-TREE DISCIPLINE, seeded and gated by its DECLARATION ALONE (#125).
 *
 * `acme.sheets` declares `destinations: ["tile"]` and `acme.paper` declares
 * `destinations: ["canvas"]`; neither id is spelled anywhere in the server. That is the whole
 * argument: the floor's two remaining "is this a tile tree" decisions — the root a room seeds
 * before the first channel joins, and who authors a terminal's placement — used to read the
 * literal `"composition"`, so a contributed tile-tree discipline rendered a tree that was
 * never seeded and refused the only placement its own declaration permits.
 */
function contributedDiscipline(
  pluginId: string,
  id: string,
  destinations: readonly ["tile"] | readonly ["canvas"],
): PluginRoster[number] {
  return {
    manifest: {
      id: pluginId,
      version: "1.0.0",
      title: id,
      description: id,
      capabilities: [],
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        disciplines: [
          {
            id,
            title: id,
            item: {
              groups: [...COMPOSITION_AT_V20.groups],
              guards: [...COMPOSITION_AT_V20.guards],
              homed: COMPOSITION_AT_V20.homed,
            },
            accepts: [...declaration("composition").accepts],
            guards: [...declaration("composition").guards],
            destinations: [...destinations],
          },
        ],
        tools: [],
        events: [],
      },
    },
    enabled: true,
    source: "builtin",
    actions: [],
  };
}

const OPEN_ROSTER: PluginRoster = [
  ...assembly.roster,
  contributedDiscipline("acme.sheets", "sheets", ["tile"]),
  contributedDiscipline("acme.paper", "paper", ["canvas"]),
];
/** The production derivation, over a roster that composed a stranger's discipline. */
const tileTrees = assemblyTileTrees(assemblyPlacementVocabulary(() => OPEN_ROSTER));

function contributedContainers(store: ServerStore): void {
  for (const discipline of ["sheets", "paper"]) {
    store.createContainer({ id: discipline, name: discipline, createdAt: 0, discipline });
  }
}

class LifecycleTerminals implements TerminalPlacementPort {
  readonly homes = new Map<string, string>();

  placedTerminal(terminalId: string): { readonly containerId: string } | null {
    const containerId = this.homes.get(terminalId);
    return containerId === undefined ? null : { containerId };
  }

  terminalLabel(terminalId: string, fallback: string): string {
    return this.homes.has(terminalId) ? terminalId : fallback;
  }

  rebindTerminal(
    terminalId: string,
    _fromContainerId: string,
    toContainerId: string,
    _placementId: string,
  ): void {
    this.homes.set(terminalId, toContainerId);
  }

  reapTerminal(terminalId: string): void {
    this.homes.delete(terminalId);
  }

  dropContainer(containerId: string): void {
    for (const [terminalId, homeId] of this.homes) {
      if (homeId === containerId) this.homes.delete(terminalId);
    }
  }
}

function lifecycleFixture(): {
  readonly runtime: FakeRuntime;
  readonly store: ServerStore;
  readonly rooms: RoomManager;
  readonly terminals: LifecycleTerminals;
  readonly placement: PlaceExecutor;
  readonly createTree: (id: string) => void;
} {
  const runtime = new FakeRuntime();
  const store = testStore();
  const rooms = new RoomManager(store, runtime, new FakeClock(runtime), silentLogger, tileTrees);
  const terminals = new LifecycleTerminals();
  const vocabulary = assemblyPlacementVocabulary(() => OPEN_ROSTER);
  const placement = new PlaceExecutor(
    store,
    rooms,
    terminals,
    runtime,
    vocabulary,
    assemblyItemNouns(() => OPEN_ROSTER),
  );
  return {
    runtime,
    store,
    rooms,
    terminals,
    placement,
    createTree: (id) => {
      store.createContainer({ id, name: id, createdAt: runtime.now(), discipline: "sheets" });
    },
  };
}

describe("a contributed tile-tree discipline reaches the floor", () => {
  test("a room of one is seeded with a root; a discipline declaring no tile form is not", () => {
    const runtime = new FakeRuntime();
    const store = testStore();
    const manager = new RoomManager(
      store,
      runtime,
      new FakeClock(runtime),
      silentLogger,
      tileTrees,
    );
    contributedContainers(store);

    const seeded = manager.get("sheets")?.tileLayout() ?? null;
    expect(Object.keys(seeded ?? {})).toEqual([ROOT_TILE_ID]);
    expect(seeded?.[ROOT_TILE_ID]?.ref).toBeNull();
    // A discipline whose declaration names no `tile` form holds no tree — the same answer
    // `canvas` gets, reached by reading the same field rather than by matching an id.
    expect(manager.get("paper")?.tileLayout()).toBeNull();
    store.close();
  });

  test("the broker's placement gate reads the same field", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "e".repeat(64), runtime);
    const root = auth.authenticate("e".repeat(64));
    contributedContainers(store);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, tileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      tileTrees,
    );
    // `placement` is `"tile"` or ABSENT on the wire: absent means the opener authors its own
    // canvas element, which is the pre-flag default every client kept.
    const openIn = (containerId: string, placement?: "tile"): FakeSocket => {
      const socket = new FakeSocket();
      broker.open(new SessionChannel(runtime.newId(), socket, root, containerId, "c1"), {
        type: "terminal_open",
        elementId: "terminal-1",
        cols: 80,
        rows: 24,
        ...(placement === undefined ? {} : { placement }),
      });
      return socket;
    };

    /*
      No machine is enrolled, so `no_machine` is the refusal a container that PASSED the
      discipline gate gets — which is the assertion: a stranger's tile tree is placed into
      server-side, exactly like a composition, and the old literal would have refused it with
      `conflict` before any machine was ever looked for.
    */
    expect(openIn("sheets", "tile").messages().at(-1)).toMatchObject({
      type: "error",
      code: "no_machine",
    });
    expect(openIn("paper", "tile").messages().at(-1)).toMatchObject({
      type: "error",
      code: "conflict",
    });
    // And the mirror: a tile-tree container places terminals server-side, so an opener
    // authoring its own element is refused there too.
    expect(openIn("sheets").messages().at(-1)).toMatchObject({
      type: "error",
      code: "conflict",
    });
    store.close();
  });
});

describe("a contributed tile-tree discipline owns its complete lifecycle", () => {
  test("census reports the container's declared discipline", () => {
    const fixture = lifecycleFixture();
    fixture.createTree("sheet");
    expect(fixture.rooms.get("sheet")?.census()).toMatchObject({
      containerId: "sheet",
      discipline: "sheets",
    });
    fixture.store.close();
  });

  test("moving the final leaf retires a contributed source tree", () => {
    const fixture = lifecycleFixture();
    fixture.createTree("source");
    fixture.createTree("target");
    fixture.store.createContainer({
      id: "paper",
      name: "paper",
      createdAt: 0,
      discipline: "paper",
    });
    const source = fixture.rooms.get("source");
    if (source === null) throw new Error("missing source tree");
    const leafId = source.placeTile({ kind: "container", containerId: "paper" }, null, null);
    if (leafId === null) throw new Error("source tree refused fixture leaf");

    expect(
      fixture.placement.place({
        ref: { kind: "tile", containerId: "source", tileId: leafId },
        destination: {
          kind: "tile",
          containerId: "target",
          targetTileId: ROOT_TILE_ID,
          edge: "center",
        },
      }),
    ).toMatchObject({ status: "placed" });
    expect(fixture.store.getContainer("source")).toBeNull();
    fixture.store.close();
  });

  test("removeTile accepts and retires a contributed tree", () => {
    const fixture = lifecycleFixture();
    fixture.createTree("source");
    fixture.store.createContainer({
      id: "paper",
      name: "paper",
      createdAt: 0,
      discipline: "paper",
    });
    const source = fixture.rooms.get("source");
    if (source === null) throw new Error("missing source tree");
    const leafId = source.placeTile({ kind: "container", containerId: "paper" }, null, null);
    if (leafId === null) throw new Error("source tree refused fixture leaf");

    expect(fixture.placement.removeTile("source", leafId)).toBe("ok");
    expect(fixture.store.getContainer("source")).toBeNull();
    fixture.store.close();
  });

  test("re-homing a terminal preserves its source tree discipline", () => {
    const fixture = lifecycleFixture();
    fixture.createTree("source");
    fixture.store.createContainer({
      id: "paper",
      name: "paper",
      createdAt: 0,
      discipline: "paper",
    });
    const source = fixture.rooms.get("source");
    if (source === null) throw new Error("missing source tree");
    const terminalId = "terminal";
    fixture.terminals.homes.set(terminalId, "source");
    source.placeTerminalTile(terminalId, null, null);
    source.placeTile({ kind: "container", containerId: "paper" }, ROOT_TILE_ID, "right");
    const terminalLeafId = tileIdForRef(source.tileLayout(), {
      kind: "terminal",
      terminalId,
    });
    if (terminalLeafId === null) throw new Error("missing terminal fixture leaf");

    expect(
      fixture.placement.place({
        ref: { kind: "tile", containerId: "source", tileId: terminalLeafId },
        destination: { kind: "unplaced" },
      }),
    ).toMatchObject({ status: "placed", result: { op: "unplace" } });
    const newHomeId = fixture.terminals.homes.get(terminalId);
    expect(newHomeId).toBeDefined();
    expect(fixture.store.getContainer(newHomeId ?? "")).toMatchObject({ discipline: "sheets" });
    fixture.store.close();
  });
});
