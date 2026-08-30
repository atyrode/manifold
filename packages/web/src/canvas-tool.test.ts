import { describe, expect, test } from "bun:test";
import { toolFlags, toolForKey } from "./canvas-tool";

describe("canvas tools", () => {
  test("maps each tool to its React Flow interaction policy", () => {
    expect(toolFlags("select")).toEqual({
      nodesDraggable: true,
      panOnDrag: true,
      elementsSelectable: true,
    });
    expect(toolFlags("draw")).toEqual({
      nodesDraggable: false,
      panOnDrag: false,
      elementsSelectable: false,
    });
    expect(toolFlags("text")).toEqual({
      nodesDraggable: false,
      panOnDrag: true,
      elementsSelectable: false,
    });
  });

  test("maps case-insensitive shortcuts and ignores unrelated keys", () => {
    expect(toolForKey("v")).toBe("select");
    expect(toolForKey("D")).toBe("draw");
    expect(toolForKey("t")).toBe("text");
    expect(toolForKey("Escape")).toBeNull();
  });
});
