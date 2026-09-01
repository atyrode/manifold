import { describe, expect, test } from "bun:test";
import {
  CANVAS_OPS,
  CONTAINER_KINDS,
  DESTINATION_KINDS,
  ITEM_KINDS,
  buildProtocolJsonSchema,
  rosterDisciplines,
  type DisciplineDeclaration,
  type PlacementTraits,
} from "@manifold/protocol";
import { assembleRoster, type PluginDef } from "@manifold/plugin";
import { SERVER_PLUGIN_DEFS } from "../src/assembly.ts";

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
