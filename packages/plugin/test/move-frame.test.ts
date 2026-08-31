import { describe, expect, test } from "bun:test";
import { GestureSchema, type Gesture, type ServerGesture } from "@manifold/protocol";
import { carryGhosts, moveFrame, remoteTileCarries } from "../src/carry.ts";
import { applyGestureFrame, type GestureOverride } from "../src/presence/remote-gestures.ts";

/**
 * The publisher fallback for a grab whose ITEM this renderer cannot classify.
 *
 * `CarrySchema.item` assumes the grabber holds a census of containers, terminals and solo
 * occupancy. It does not: a document arrives over the room socket while the container index
 * arrives over a poll, so a collaborator renders a portal onto a newborn container — and can
 * be dragging it — before anything can tell it what that container IS. The old publisher
 * refused the whole gesture in that window, and peers saw a live drag as a teleport on
 * release; every frame below is what it publishes instead.
 *
 * The floor these tests hold: MOTION is unconditional, and a CLAIM about a placement is not.
 */
const AT = { x: 42, y: 84, width: 480, height: 320 } as const;

/** One published frame as the server hands it to a viewer. */
function relayed(gesture: Gesture): ServerGesture {
  return { type: "gesture", connId: "peer-connection", principalId: "peer", ...gesture };
}

describe("move frame", () => {
  test("an unclassified grab publishes a legal wire frame with geometry and no item", () => {
    const frame = moveFrame("element-1", AT, "active");
    // Parsed, not merely shaped: `strictObject` is what proves a frame with no `carry`
    // is a frame the server accepts rather than one it drops for the whole drag.
    expect(GestureSchema.parse(frame)).toEqual({
      kind: "move",
      phase: "active",
      elementId: "element-1",
      x: 42,
      y: 84,
      width: 480,
      height: 320,
    });
    expect("carry" in frame).toBe(false);
  });

  test("geometry is omitted rather than invented when the grab has no box", () => {
    expect(moveFrame("element-1", { x: 1, y: 2 }, "active")).toEqual({
      kind: "move",
      phase: "active",
      elementId: "element-1",
      x: 1,
      y: 2,
    });
  });

  test("a viewer animates the element from these frames alone", () => {
    const state = new Map<string, GestureOverride>();
    expect(
      applyGestureFrame(state, relayed(moveFrame("element-1", AT, "active")), "self", 100),
    ).toBe(true);
    expect(state.get("element-1")).toMatchObject({
      kind: "move",
      target: { x: 42, y: 84, width: 480, height: 320 },
      current: { x: 42, y: 84, width: 480, height: 320 },
    });
    expect(state.get("element-1")?.carry).toBeUndefined();
  });

  test("release retracts the override at once instead of stranding it until the TTL", () => {
    const state = new Map<string, GestureOverride>();
    applyGestureFrame(state, relayed(moveFrame("element-1", AT, "active")), "self", 100);
    expect(applyGestureFrame(state, relayed(moveFrame("element-1", AT, "end")), "self", 116)).toBe(
      true,
    );
    expect(state.size).toBe(0);
  });

  test("no item means no ghost and no aim preview, which is the honest half to withhold", () => {
    const state = new Map<string, GestureOverride>();
    applyGestureFrame(state, relayed(moveFrame("element-1", AT, "active")), "self", 100);
    const overrides = [...state.values()];
    // A ghost paints WHAT is in flight and an aim preview claims where it would land.
    // Both are answers this grab does not have, so both stay silent while it animates.
    expect(carryGhosts(overrides, () => false)).toEqual([]);
    expect(remoteTileCarries(overrides)).toEqual(new Map());
  });
});
