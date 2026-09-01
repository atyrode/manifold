import { describe, expect, test } from "bun:test";
import {
  CANVAS_OPS,
  CONTAINER_KINDS,
  DESTINATION_KINDS,
  ITEM_KINDS,
  ROOT_TILE_ID,
  buildProtocolJsonSchema,
  rosterDisciplines,
  type DisciplineDeclaration,
  type PlacementTraits,
  type PluginRoster,
} from "@manifold/protocol";
import { assembleRoster, type PluginDef } from "@manifold/plugin";
import { SERVER_PLUGIN_DEFS } from "../src/assembly.ts";
import { AuthService } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { assemblyPlacementVocabulary, assemblyTileTrees } from "../src/placement.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

/**
 * THE DISCIPLINE ROSTER, COMPOSED (#110, building the ruling ratified on #86).
 *
 * `packages/protocol`'s own suite proves the algebra reads declarations instead of
 * literals; it cannot prove WHICH declarations this distribution ships, because the
 * protocol package may not import a plugin. This file is where the two meet: the shipped
 * `core.canvas` and `core.compositions` manifests are assembled for real, and the composed
 * rows are compared against the literals `placement.ts` held before the roster opened.
 *
 * That comparison is the whole safety argument for the cutover. Four tables and a guard
 * moved out of the floor; if any row moved with them, a canvas would start accepting
 * something it used to refuse and no other test in the tree would notice.
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
  test("the distribution declares exactly the two disciplines it used to enumerate", () => {
    expect([...disciplines.keys()].sort()).toEqual(["canvas", "composition"]);
    // And the assembly knows WHOSE each one is, which is what replaced the retired
    // "value IS the plugin's last id segment" pun — data rather than a spelling, and the
    // reason `core.compositions` may legitimately render `composition`.
    expect(assembly.disciplines.get("canvas")?.plugin).toBe("core.canvas");
    expect(assembly.disciplines.get("composition")?.plugin).toBe("core.compositions");
  });

  test("the canvas declaration is the floor's four rows, byte for byte", () => {
    const canvas = declaration("canvas");
    // `ITEM_KINDS.canvas`
    expect(canvas.item).toEqual(CANVAS_AT_V20);
    // `CONTAINER_KINDS.canvas`
    expect([...canvas.accepts]).toEqual(["canvas_item", "canvas_item_as_portal", "extractable"]);
    expect([...canvas.guards]).toEqual(["discipline_match"]);
    /*
      `DESTINATION_KINDS[...].requires`, inverted. At v20 the column read
      `canvas.requires: "canvas"` and `compose.requires: "canvas"`, so exactly those two
      forms addressed a canvas — which is what this list says from the other side.
    */
    expect([...canvas.destinations].sort()).toEqual(["canvas", "compose"]);
  });

  test("the composition declaration is the floor's four rows, byte for byte", () => {
    const composition = declaration("composition");
    expect(composition.item).toEqual(COMPOSITION_AT_V20);
    expect([...composition.accepts]).toEqual(["tileable", "mergeable"]);
    expect([...composition.guards]).toEqual(["discipline_match"]);
    // `tile.requires: "composition"` was the only row naming this discipline at v20.
    expect([...composition.destinations]).toEqual(["tile"]);
  });

  test("the floor kept none of it: four tables and a guard, checked as absence", () => {
    /*
      The blast radius #110's probe comment named, asserted against the real build rather
      than a fixture. Every one of these used to carry a `canvas` row, a `composition` row,
      or both.
    */
    expect(Object.keys(ITEM_KINDS)).toEqual(["terminal", "tile", "panel", "structure"]);
    expect(Object.keys(CANVAS_OPS)).toEqual(["terminal", "tile", "panel", "structure"]);
    // `CONTAINER_KINDS` is the closed FAMILY vocabulary now — the discriminant of
    // `PlacementContainer` — and holds no acceptance rows for anybody to redefine.
    expect(CONTAINER_KINDS).toEqual(["canvas", "composition", "unplaced"]);
    for (const form of Object.values(DESTINATION_KINDS)) {
      expect(Object.keys(form)).toEqual(["container", "declaration"]);
    }
  });

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

describe("the published roster", () => {
  test("GET /api/protocol carries the disciplines this build composed", () => {
    /*
      A2: an agent and a browser learn the vocabulary from one document. A reader that met
      `Container.discipline` as a bounded string learns its legal inhabitants here, beside
      the shape a plugin declares one with — and it is derived from the same `plugins`
      roster this document already carries, so there is no second door onto the answer.
    */
    const document = buildProtocolJsonSchema({
      actions: assembly.roster.flatMap((entry) => entry.actions),
      plugins: assembly.roster,
    });
    const placement = document["placement"] as Record<string, unknown>;
    const published = placement["disciplines"] as readonly DisciplineDeclaration[];
    expect(published.map((entry) => entry.id).sort()).toEqual(["canvas", "composition"]);
    expect(published).toContainEqual(declaration("canvas"));
    // The SHAPE rides beside the roster, so a stranger writing a discipline reads both the
    // grammar and the examples from one place.
    expect(placement["discipline"]).toBeDefined();
    // A title travels with the declaration because that is the discipline's display noun
    // (S12): the floor's label table holds floor kinds, a contributed kind takes its title.
    expect(declaration("composition").title).toBe("Composition");
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
