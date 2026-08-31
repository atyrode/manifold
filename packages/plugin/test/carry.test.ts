import { describe, expect, test } from "bun:test";
import type { PluginRoster } from "@manifold/protocol";
import {
  carryFrame,
  carryGhosts,
  carryPayload,
  carryPlacementId,
  firstLineLabel,
  remoteTileCarries,
  refDisplayLabel,
} from "../src/carry.ts";
import type { CarrySource } from "../src/carry.ts";
import type { GestureOverride } from "../src/presence/index.ts";

/**
 * One contributed element type, as the roster publishes it. This is the only place the word
 * "note" may come from: it is `core.notes`' manifest TITLE, and a label that has to fall back
 * reads it from here rather than from a noun the engine spelled for one plugin.
 */
function contributor(id: string, type: string, title: string): PluginRoster[number] {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: id,
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [{ type, title }], tools: [], events: [] },
    },
    enabled: true,
    source: "builtin",
    actions: [],
  };
}

const ROSTER: PluginRoster = [contributor("core.notes", "text", "Note")];

/** Every fixture names its item, exactly as a real grab site resolves it once. */
const TEXT_ITEM = { kind: "text", containerId: null } as const;
const TERMINAL_ITEM = { kind: "terminal", containerId: "home-1" } as const;
const TILE_ITEM = { kind: "tile", containerId: null } as const;
const VIEW_ITEM = { kind: "composition", containerId: "p" } as const;

const elementCarry: CarrySource = {
  id: "element-1",
  envelope: { kind: "element", containerId: "container", elementId: "element-1" },
  item: TEXT_ITEM,
  label: null,
};
const poolCarry: CarrySource = {
  id: "carry-uuid",
  envelope: { kind: "terminal", terminalId: "terminal-1" },
  item: TERMINAL_ITEM,
  label: "build",
};

function override(partial: Partial<GestureOverride>): GestureOverride {
  return {
    connId: "peer-connection",
    principalId: "peer",
    elementId: "element-1",
    kind: "carry",
    target: { x: 10, y: 20 },
    current: { x: 10, y: 20 },
    updatedAt: 0,
    ...partial,
  };
}

describe("carry", () => {
  test("keys a carry by the placement it has, and only when it has one", () => {
    expect(carryPlacementId(elementCarry.envelope)).toBe("element-1");
    expect(carryPlacementId({ kind: "tile", containerId: "view", tileId: "leaf" })).toBe("leaf");
    expect(carryPlacementId(poolCarry.envelope)).toBeNull();
    expect(carryPlacementId({ kind: "canvas", containerId: "container" })).toBeNull();
    expect(carryPlacementId({ kind: "composition", containerId: "view" })).toBeNull();
  });

  test("a frame carries the ref the drop will use, and geometry only when there is any", () => {
    const placed = carryFrame(elementCarry, { x: 5, y: 6, width: 700, height: 400 }, "active");
    expect(placed).toEqual({
      kind: "carry",
      phase: "active",
      elementId: "element-1",
      x: 5,
      y: 6,
      width: 700,
      height: 400,
      carry: {
        ref: { kind: "element", containerId: "container", elementId: "element-1" },
        item: TEXT_ITEM,
      },
    });

    // An unplaced item has no source box: the frame is a pointer and a name.
    const pointerOnly = carryFrame(poolCarry, { x: 1, y: 2 }, "end");
    expect(pointerOnly).toEqual({
      kind: "carry",
      phase: "end",
      elementId: "carry-uuid",
      x: 1,
      y: 2,
      carry: {
        ref: { kind: "terminal", terminalId: "terminal-1" },
        item: TERMINAL_ITEM,
        label: "build",
      },
    });
  });

  test("both container disciplines travel as one container ref", () => {
    expect(
      carryPayload({
        id: "x",
        envelope: { kind: "canvas", containerId: "p" },
        item: VIEW_ITEM,
        label: null,
      }),
    ).toEqual({ ref: { kind: "container", containerId: "p" }, item: VIEW_ITEM });
    expect(
      carryPayload({
        id: "x",
        envelope: { kind: "composition", containerId: "p" },
        item: VIEW_ITEM,
        label: null,
      }),
    ).toEqual({ ref: { kind: "container", containerId: "p" }, item: VIEW_ITEM });
  });

  test("ghosts skip what the renderer already draws and follow the eased position", () => {
    const local = override({
      carry: {
        ref: { kind: "element", containerId: "container", elementId: "element-1" },
        item: TEXT_ITEM,
      },
      current: { x: 33, y: 44 },
    });
    const foreign = override({
      elementId: "carry-uuid",
      carry: {
        ref: { kind: "terminal", terminalId: "terminal-1" },
        item: TERMINAL_ITEM,
        label: "build",
      },
      current: { x: 7, y: 8 },
    });
    const plainMove = override({ elementId: "moved", kind: "move" });

    const ghosts = carryGhosts([local, foreign, plainMove], (ref) => ref.kind === "element");
    expect(ghosts).toEqual([
      {
        key: "peer-connection:carry-uuid",
        principalId: "peer",
        kind: "terminal",
        label: "build",
        x: 7,
        y: 8,
      },
    ]);

    // Nothing rendered locally: the element carry becomes a ghost like anything else,
    // which is exactly how a composition (no free geometry) paints motion.
    expect(carryGhosts([local, foreign], () => false).map((ghost) => ghost.x)).toEqual([33, 7]);
  });

  test("a carry with no label falls back to its species name", () => {
    const unnamed = override({
      elementId: "leaf",
      carry: {
        ref: { kind: "tile", containerId: "view", tileId: "leaf" },
        item: TILE_ITEM,
      },
    });
    expect(carryGhosts([unnamed], () => false)[0]).toMatchObject({ label: "tile" });
  });

  test("an armed aim rides the frame; without one the payload stays lean", () => {
    const aim = {
      containerId: "view",
      tileId: "t1",
      edge: "right",
      action: "place",
      between: true,
    } as const;
    const framed = carryFrame(poolCarry, { x: 1, y: 2 }, "active", aim);
    expect(framed.carry?.aim).toEqual(aim);
    expect(carryFrame(poolCarry, { x: 1, y: 2 }, "active").carry?.aim).toBeUndefined();
    expect(carryPayload(poolCarry)).not.toHaveProperty("aim");
  });

  test("the freshest aim wins PER CONTAINER, so two peers over two areas cannot mask each other", () => {
    const stale = override({
      connId: "old",
      updatedAt: 10,
      carry: {
        ref: { kind: "terminal", terminalId: "s1" },
        item: TERMINAL_ITEM,
        aim: { containerId: "view", tileId: "t1", edge: "left", action: "place" },
      },
    });
    const fresh = override({
      connId: "new",
      updatedAt: 20,
      carry: {
        ref: { kind: "tile", containerId: "view", tileId: "t9" },
        item: TILE_ITEM,
        label: "build",
        aim: { containerId: "view", tileId: "t2", edge: "center", action: "swap" },
      },
    });
    // Another container entirely: an older frame, and it must still be visible — the
    // portal it addresses is a different tile area on the same canvas.
    const elsewhere = override({
      connId: "third",
      elementId: "other",
      updatedAt: 5,
      carry: {
        ref: { kind: "terminal", terminalId: "s3" },
        item: TERMINAL_ITEM,
        aim: { containerId: "other-view", tileId: "t1", edge: "top", action: "place" },
      },
    });
    const aimless = override({
      connId: "no-aim",
      updatedAt: 30,
      carry: {
        ref: { kind: "terminal", terminalId: "s2" },
        item: TERMINAL_ITEM,
      },
    });

    const carries = remoteTileCarries([stale, fresh, elsewhere, aimless]);
    expect(carries.size).toBe(2);
    expect(carries.get("view")).toEqual({
      connId: "new",
      principalId: "peer",
      aim: { containerId: "view", tileId: "t2", edge: "center", action: "swap" },
      ref: { kind: "tile", containerId: "view", tileId: "t9" },
      // The item travels: this is the value a viewer judges the drop with.
      item: TILE_ITEM,
      label: "build",
      updatedAt: 20,
    });
    expect(carries.get("other-view")?.connId).toBe("third");
    // A peer with no armed aim is invisible here however fresh their geometry is.
    expect(remoteTileCarries([aimless]).size).toBe(0);
  });

  test("every composition species is named by one switch, and an unknown name is null", () => {
    const borne: Readonly<Record<string, { readonly type: string; readonly text: string }>> = {
      e1: { type: "text", text: "Groceries\nmilk\neggs" },
      "e-empty": { type: "text", text: "  \n" },
      "e-absent": { type: "chart", text: "" },
    };
    const lookups = {
      terminalName: (terminalId: string) => (terminalId === "s1" ? "build" : null),
      containerName: (containerId: string) => (containerId === "p1" ? "Sketches" : null),
      textElement: (elementId: string) => borne[elementId] ?? null,
      roster: ROSTER,
    };
    expect(refDisplayLabel({ kind: "terminal", terminalId: "s1" }, lookups)).toBe("build");
    expect(refDisplayLabel({ kind: "container", containerId: "p1" }, lookups)).toBe("Sketches");
    // A text-bearing element borrows its FIRST line: the only handle its own content gives it.
    expect(refDisplayLabel({ kind: "text", elementId: "e1" }, lookups)).toBe("Groceries");
    // Nothing to borrow is not namelessness: the noun is the DECLARING plugin's manifest
    // title, which is what stops each renderer from carrying its own copy of "note".
    expect(refDisplayLabel({ kind: "text", elementId: "e-empty" }, lookups)).toBe("note");
    // A kind no composed plugin declares gets the truthful generic, never a borrowed species.
    expect(refDisplayLabel({ kind: "text", elementId: "e-absent" }, lookups)).toBe("item");
    // No element at that id at all: there is nothing to name yet, which is not a name.
    expect(refDisplayLabel({ kind: "text", elementId: "gone" }, lookups)).toBeNull();
    expect(refDisplayLabel(null, lookups)).toBeNull();
  });
});

/**
 * The rule is "borrow the first line", stated once for every text-bearing kind. These bounds
 * are what a caption slot is drawn to, so the ellipsis has to REPLACE the last character
 * rather than extend past it.
 */
describe("firstLineLabel", () => {
  test("content with nothing to borrow has no label, which is the fallback's cue", () => {
    expect(firstLineLabel("")).toBeNull();
    expect(firstLineLabel("   ")).toBeNull();
    expect(firstLineLabel("\n\nsecond line is not a title")).toBeNull();
  });

  test("the first line IS the label, trimmed, and the rest of the content is not", () => {
    expect(firstLineLabel("  Groceries  \nmilk\neggs")).toBe("Groceries");
    expect(firstLineLabel("one line only")).toBe("one line only");
  });

  test("at the bound the line stands; past it the ellipsis takes the 40th character", () => {
    const exact = "x".repeat(40);
    expect(firstLineLabel(exact)).toBe(exact);
    const over = `${"y".repeat(41)}\ntail`;
    expect(firstLineLabel(over)).toBe(`${"y".repeat(39)}…`);
    expect(firstLineLabel(over)).toHaveLength(40);
  });
});
