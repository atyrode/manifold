import { describe, expect, test } from "bun:test";
import type { PluginRoster } from "@manifold/protocol";

import {
  actionOwner,
  chainOf,
  declarationAddress,
  declarationNoun,
  declarationOf,
  distinctDoors,
  identify,
  type CompositionLookup,
  type Declared,
} from "../src/identity.ts";

/**
 * The inspector's lookup, at the boundary that actually decides things: which of several
 * declarations on one element names the thing under the pointer, and which address that thing
 * has. Both are precedence rules over data the product paints for other reasons — a wrong
 * answer here is a confidently wrong address in a reader's clipboard, which is worse than no
 * address at all, so every rule that could quietly invert has a case here.
 */

const NO_COMPOSITION: CompositionLookup = {
  sectionOwner: () => null,
  panelOwner: () => null,
  actionOwner: () => null,
};

function element(
  attributes: Readonly<Record<string, string>>,
  ...classes: readonly string[]
): Declared {
  return { attributes, classes };
}

describe("what one element declares", () => {
  test("a sidebar row is a SECTION owned by its plugin, never a plugin", () => {
    // The row carries both attributes, and the precedence between them is the whole point:
    // `data-plugin` beside a section id is the OWNER, so a row must not read as a plugin node.
    const row = declarationOf(
      element({ "data-section-id": "index", "data-plugin": "core.index" }, "sidebar-row"),
    );
    expect(row).toEqual({
      kind: "section",
      id: "index",
      attribute: "data-section-id",
      owner: "core.index",
      tree: null,
    });
  });

  test("data-plugin ALONE is a plugin node, and owns itself", () => {
    expect(declarationOf(element({ "data-plugin": "core.draw" }))).toEqual({
      kind: "plugin",
      id: "core.draw",
      attribute: "data-plugin",
      owner: "core.draw",
      tree: null,
    });
  });

  test("a tile carries which of the three trees it belongs to", () => {
    expect(declarationOf(element({ "data-tile-id": "t1" }, "composition-pane"))?.tree).toBe(
      "composition",
    );
    expect(declarationOf(element({ "data-tile-id": "t1" }, "workspace-pane"))?.tree).toBe(
      "workspace",
    );
    expect(declarationOf(element({ "data-tile-id": "t1" }, "portal__slot"))?.tree).toBe("portal");
    // A tile box wearing no skin this build knows is a tile with no tree, not a guess.
    expect(declarationOf(element({ "data-tile-id": "t1" }, "mystery"))?.tree).toBeNull();
  });

  test("data-id is an element id only on React Flow's node wrapper", () => {
    expect(declarationOf(element({ "data-id": "e1" }, "react-flow__node"))?.kind).toBe("element");
    // React Flow puts `data-id` on handles and toolbars too; those name no element.
    expect(declarationOf(element({ "data-id": "rf-h" }, "react-flow__handle"))).toBeNull();
  });

  test("an element declaring nothing this module understands declares nothing", () => {
    expect(declarationOf(element({ "data-presentation": "plain" }, "sidebar-row"))).toBeNull();
    expect(declarationOf(element({ "data-section-id": "" }))).toBeNull();
  });
});

describe("the identity chain", () => {
  test("comes back OUTERMOST first, which is breadcrumb order", () => {
    // The caller walks `parentElement`, so it hands the chain in the other direction.
    const chain = chainOf([
      element({ "data-action": "core.terminals.kill" }),
      element({ "data-section-id": "index", "data-plugin": "core.index" }),
      element({ "data-panel-id": "core.shell.sidebar" }),
      element({ "data-tile-id": "t1" }, "workspace-pane"),
      element({}, "workspace"),
    ]);
    expect(chain.map((hop) => `${hop.kind}:${hop.id}`)).toEqual([
      "tile:t1",
      "panel:core.shell.sidebar",
      "section:index",
      "door:core.terminals.kill",
    ]);
  });
});

describe("addresses", () => {
  test("a tile of the ROUTED composition is addressed; the same markup elsewhere is not", () => {
    const tile = declarationOf(element({ "data-tile-id": "t7" }, "composition-pane"));
    expect(declarationAddress(tile!, "room-1")).toBe("manifold://container/room-1/tile/t7");
    // A portal's tree belongs to a container the DOM never names, and a workspace pane holds a
    // panel rather than a node — inventing an address from the routed container would be
    // confidently wrong in both cases.
    const portal = declarationOf(element({ "data-tile-id": "t7" }, "portal__slot"));
    expect(declarationAddress(portal!, "room-1")).toBeNull();
    const pane = declarationOf(element({ "data-tile-id": "t7" }, "workspace-pane"));
    expect(declarationAddress(pane!, "room-1")).toBeNull();
    // And no routed container means no container-relative address at all.
    expect(declarationAddress(tile!, null)).toBeNull();
  });

  test("a door is addressed as an action, and a plugin as a plugin", () => {
    const door = declarationOf(element({ "data-action": "core.space.setLayout" }));
    expect(declarationAddress(door!, null)).toBe("manifold://action/core.space.setLayout");
    const plugin = declarationOf(element({ "data-plugin": "core.debug" }));
    expect(declarationAddress(plugin!, null)).toBe("manifold://plugin/core.debug");
  });

  test("sections and panels have no address form of their own", () => {
    const section = declarationOf(element({ "data-section-id": "index" }));
    expect(declarationAddress(section!, "room-1")).toBeNull();
  });
});

describe("action ownership", () => {
  test("the LONGEST registered plugin id wins, and an unclaimed name is unowned", () => {
    const ids = ["core.index", "core.index.tree", "core.space"];
    expect(actionOwner("core.index.tree.move", ids)).toBe("core.index.tree");
    expect(actionOwner("core.space.setLayout", ids)).toBe("core.space");
    // A dotted name nobody's namespace covers must not have a plugin invented for it by
    // splitting on the last dot.
    expect(actionOwner("stranger.plugin.doThing", ids)).toBeNull();
  });
});

describe("the whole lookup", () => {
  const composition: CompositionLookup = {
    sectionOwner: (id) => (id === "index" ? "core.index" : null),
    panelOwner: (id) => (id.startsWith("core.shell.") ? "core.shell" : null),
    actionOwner: (name) => actionOwner(name, ["core.space"]),
  };

  test("a sidebar row names its owning plugin, and is addressed as that plugin", () => {
    // The acceptance case: a section has no address form, and answering "not addressable"
    // while the owner sits one hop up would withhold the answer the reader asked for.
    const identity = identify(
      [
        element({ "data-section-id": "index", "data-plugin": "core.index" }, "sidebar-row"),
        element({ "data-panel-id": "core.shell.sidebar" }),
      ],
      { routedContainerId: null, composition },
    );
    expect(identity.subject?.kind).toBe("section");
    expect(identity.plugin).toBe("core.index");
    expect(identity.uri).toBe("manifold://plugin/core.index");
  });

  test("a terminal tile is addressed as a tile of the container the viewer is in", () => {
    const identity = identify(
      [
        element({}, "tile-content-host"),
        element({ "data-tile-id": "leaf-3" }, "composition-pane"),
        element({ "data-tile-id": "root" }, "composition-split"),
        element({ "data-panel-id": "core.shell.container-view" }),
      ],
      { routedContainerId: "room-9", composition },
    );
    expect(identity.uri).toBe("manifold://container/room-9/tile/leaf-3");
    // Ownership still resolves through the panel that holds the view, since a tile declares
    // no owner of its own.
    expect(identity.plugin).toBe("core.shell");
  });

  test("the INNERMOST address wins: a door inside a row beats the row's owner", () => {
    const identity = identify(
      [
        element({ "data-action": "core.space.setLayout" }),
        element({ "data-section-id": "index", "data-plugin": "core.index" }),
      ],
      { routedContainerId: null, composition },
    );
    expect(identity.uri).toBe("manifold://action/core.space.setLayout");
    // The owner is read from the innermost hop that answers: the door's namespace.
    expect(identity.plugin).toBe("core.space");
  });

  test("a point that declares nothing is nothing, with no invented address", () => {
    const identity = identify([element({}, "workspace")], {
      routedContainerId: "room-9",
      composition: NO_COMPOSITION,
    });
    expect(identity.subject).toBeNull();
    expect(identity.uri).toBeNull();
    expect(identity.plugin).toBeNull();
  });
});

describe("display nouns", () => {
  const roster: PluginRoster = [];

  test("item kinds take the one label vocabulary; the rest take their canon word", () => {
    const tile = declarationOf(element({ "data-tile-id": "t1" }, "composition-pane"));
    expect(declarationNoun(tile!, roster)).toBe("tile");
    const panel = declarationOf(element({ "data-panel-id": "core.shell.sidebar" }));
    expect(declarationNoun(panel!, roster)).toBe("panel");
    const section = declarationOf(element({ "data-section-id": "index" }));
    expect(declarationNoun(section!, roster)).toBe("section");
    const door = declarationOf(element({ "data-action": "core.space.setLayout" }));
    expect(declarationNoun(door!, roster)).toBe("door");
  });
});

describe("doors under a pinned thing", () => {
  test("deduplicated and sorted, because it is a set question", () => {
    // One affordance is often several elements — a row's grip and its keyboard nudge name the
    // same door — and a reader compares this list between two pins.
    expect(
      distinctDoors([
        "core.terminals.kill",
        "core.space.setLayout",
        "core.terminals.kill",
        "",
      ]),
    ).toEqual(["core.space.setLayout", "core.terminals.kill"]);
  });
});
