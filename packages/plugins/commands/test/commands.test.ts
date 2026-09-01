import { describe, expect, test } from "bun:test";
import type { ComposedBinding } from "@manifold/plugin";
import type {
  ActionSummary,
  IndexEntry,
  PluginRoster,
  PluginRosterEntry,
} from "@manifold/protocol";
import { composeCommands, type Command } from "../src/commands.ts";

/**
 * WHAT THIS DEFENDS is the one thing `core.commands` decides for itself: which of the
 * composition's rows a reader may act on right now, and what a row that they may not act on
 * SAYS. Everything else in the plugin is painting.
 */

function action(over: Partial<ActionSummary> & Pick<ActionSummary, "name">): ActionSummary {
  return {
    title: over.name,
    caps: [],
    scope: "workspace",
    input: {},
    result: {},
    ...over,
  };
}

function entry(id: string, actions: readonly ActionSummary[], enabled = true): PluginRosterEntry {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: id,
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    enabled,
    source: "plugin",
    actions: [...actions],
  };
}

function container(id: string, name: string): IndexEntry {
  return {
    kind: "container",
    container: { id, name, createdAt: 0, discipline: "canvas" },
    parentId: null,
    sortOrder: 0,
  };
}

const binding = (id: string, key: string, plugin: string): ComposedBinding => ({
  id,
  key,
  declaredKey: key,
  label: id,
  when: "always",
  plugin,
  run: () => undefined,
});

const NO_BINDINGS: readonly ComposedBinding[] = [];
const NO_CONTAINERS: readonly IndexEntry[] = [];
const NO_ROSTER: PluginRoster = [];

function compose(over: {
  roster?: PluginRoster;
  bindings?: readonly ComposedBinding[];
  containers?: readonly IndexEntry[];
  caps?: readonly ("*" | "containers:write" | "containers:read")[] | null;
  containerId?: string | null;
}): readonly Command[] {
  return composeCommands({
    roster: over.roster ?? NO_ROSTER,
    bindings: over.bindings ?? NO_BINDINGS,
    containers: over.containers ?? NO_CONTAINERS,
    caps: over.caps === undefined ? ["*"] : over.caps,
    containerId: over.containerId ?? null,
    pluginTitle: (id) => id,
  });
}

const refusalOf = (rows: readonly Command[], target: string): string | null | undefined =>
  rows.find((row) => row.target === target)?.refusal;

describe("doors", () => {
  test("a door the caller cannot open is LISTED, disabled, naming the cap it costs", () => {
    // The whole ruling of this surface: hiding it would make the workspace's vocabulary
    // depend on who is looking, and a reader would conclude the door does not exist.
    const rows = compose({
      roster: [
        entry("core.index", [action({ name: "core.index.wipe", caps: ["containers:write"] })]),
      ],
      caps: ["containers:read"],
    });

    expect(rows).toHaveLength(1);
    expect(refusalOf(rows, "core.index.wipe")).toBe("requires containers:write");
  });

  test("UNKNOWN authority is not denied authority", () => {
    // `selfCaps()` is empty at the workspace root because no room has been joined — which is
    // "nobody has been asked", never "you hold nothing".
    const rows = compose({
      roster: [
        entry("core.index", [action({ name: "core.index.wipe", caps: ["containers:write"] })]),
      ],
      caps: null,
    });

    expect(refusalOf(rows, "core.index.wipe")).toBeNull();
  });

  test("a door whose schema requires arguments says what it would need", () => {
    const rows = compose({
      roster: [
        entry("core.index", [
          action({
            name: "core.index.renameContainer",
            input: { required: ["containerId", "name"] },
          }),
        ]),
      ],
    });

    expect(refusalOf(rows, "core.index.renameContainer")).toBe(
      "needs containerId, name — open it where its subject is",
    );
  });

  test("the ladder is monotonic: disabled beats caps beats arguments", () => {
    // A reader learns the FIRST thing wrong, exactly as the dispatcher answers it — a row that
    // reported the missing argument while its plugin was off would send them to fix the wrong
    // thing.
    const rows = compose({
      roster: [
        entry(
          "core.index",
          [
            action({
              name: "core.index.wipe",
              caps: ["containers:write"],
              input: { required: ["containerId"] },
            }),
          ],
          false,
        ),
      ],
      caps: ["containers:read"],
    });

    expect(refusalOf(rows, "core.index.wipe")).toBe("core.index is disabled");
  });

  test("a CLEANUP door outlives its plugin's disable (D12), and is judged on caps alone", () => {
    const rows = compose({
      roster: [
        entry("core.index", [action({ name: "core.index.deleteContainer", cleanup: true })], false),
      ],
    });

    expect(refusalOf(rows, "core.index.deleteContainer")).toBeNull();
  });

  test("a door demanding full authority says so rather than naming a cap nobody grants", () => {
    const rows = compose({
      roster: [entry("core.access", [action({ name: "core.access.grant", caps: ["*"] })])],
      caps: ["containers:write"],
    });

    expect(refusalOf(rows, "core.access.grant")).toBe("requires full authority");
  });
});

describe("keys and containers", () => {
  test("a key row carries the EFFECTIVE keystroke and is never refused", () => {
    const rows = compose({ bindings: [binding("core.arrange.arrange", "F8", "core.arrange")] });

    expect(rows).toEqual([
      expect.objectContaining({ kind: "key", stroke: "F8", refusal: null }) as Command,
    ]);
  });

  test("folders are not rooms: only containers become rows, and the current one is marked", () => {
    const rows = compose({
      containers: [
        container("c1", "Notes"),
        { kind: "folder", id: "f1", name: "Archive", createdAt: 0, parentId: null, sortOrder: 1 },
        container("c2", "Sketch"),
      ],
      containerId: "c2",
    });

    expect(rows.map((row) => [row.title, row.here])).toEqual([
      ["Notes", false],
      ["Sketch", true],
    ]);
  });
});

describe("the list's own contract", () => {
  test("every row's search value is unique, across all three registries", () => {
    // cmdk keys, filters and highlights on `value`; two rows sharing one would make the list
    // select the wrong thing, which is the failure mode no rendering test would catch.
    const rows = compose({
      roster: [entry("core.index", [action({ name: "core.index.read" })])],
      bindings: [binding("core.index.read", "F7", "core.index")],
      containers: [container("core.index.read", "core.index.read")],
    });

    expect(new Set(rows.map((row) => row.value)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  test("groups come in reading order — doors, then keys, then rooms", () => {
    const rows = compose({
      containers: [container("c1", "Notes")],
      bindings: [binding("core.arrange.arrange", "F8", "core.arrange")],
      roster: [entry("core.index", [action({ name: "core.index.read" })])],
    });

    expect(rows.map((row) => row.kind)).toEqual(["door", "key", "container"]);
  });
});
