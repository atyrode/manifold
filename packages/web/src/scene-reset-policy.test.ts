import { describe, expect, test } from "bun:test";
import { sceneResetAction } from "./scene-reset-policy.ts";

describe("sceneResetAction", () => {
  test("first adoption flushes pre-connect edits and paints wholesale", () => {
    expect(sceneResetAction("", "e1")).toEqual({
      flushPending: true,
      discardPending: false,
      repaint: "replace",
    });
  });

  test("same-epoch reconnect flushes pending but MERGES the paint", () => {
    // A wholesale replace here reverted canvas-ahead state mid-gesture and deleted its
    // pending entry — the original revert bug reintroduced on reconnect.
    expect(sceneResetAction("e1", "e1")).toEqual({
      flushPending: true,
      discardPending: false,
      repaint: "merge",
    });
  });

  test("epoch change discards old-lineage pending edits instead of re-stamping them", () => {
    // Flushing here would bypass the SDK's lineage fence: old-lineage records win LWW
    // against a young epoch and resurrect deliberately-dropped content.
    expect(sceneResetAction("e1", "e2")).toEqual({
      flushPending: false,
      discardPending: true,
      repaint: "replace",
    });
  });
});
