import { describe, expect, test } from "bun:test";
import { GESTURE_TTL_MS, type ServerGesture } from "@manifold/protocol";
import {
  AIM_TTL_MS,
  applyGestureFrame,
  expireGestures,
  stepGestures,
  type GestureOverride,
} from "../src/presence/remote-gestures.ts";
import { GESTURE_HALF_LIFE_MS } from "../src/presence/interpolate.ts";

/** A carried tile always classifies to this, wherever the grab happened. */
const TILE_ITEM = { kind: "tile", containerId: null } as const;

function frame(x: number, phase: "active" | "end" = "active"): ServerGesture {
  return {
    type: "gesture",
    connId: "peer-connection",
    principalId: "peer",
    kind: "resize",
    phase,
    elementId: "element",
    x,
    y: x + 10,
    width: x + 100,
    height: x + 200,
  };
}

describe("remote gestures", () => {
  test("ignores self echoes and applies peer frames", () => {
    const state = new Map<string, GestureOverride>();
    expect(applyGestureFrame(state, frame(10), "peer-connection", 100)).toBe(false);
    expect(state.size).toBe(0);

    expect(applyGestureFrame(state, frame(10), "self-connection", 100)).toBe(true);
    expect(state.get("element")).toMatchObject({
      connId: "peer-connection",
      principalId: "peer",
      target: { x: 10, y: 20, width: 110, height: 210 },
      current: { x: 10, y: 20, width: 110, height: 210 },
      updatedAt: 100,
    });
  });

  test("retargets without snapping and removes an ended gesture", () => {
    const state = new Map<string, GestureOverride>();
    applyGestureFrame(state, frame(0), null, 0);
    applyGestureFrame(state, frame(100), null, 30);
    expect(state.get("element")?.current.x).toBe(0);
    expect(state.get("element")?.target.x).toBe(100);

    expect(stepGestures(state, GESTURE_HALF_LIFE_MS)).toBe(true);
    expect(state.get("element")?.current.x).toBe(50);
    expect(applyGestureFrame(state, frame(100, "end"), null, 90)).toBe(true);
    expect(state.size).toBe(0);
  });

  test("does not let a stale sender end a newer sender's override", () => {
    const state = new Map<string, GestureOverride>();
    applyGestureFrame(state, frame(10), null, 10);
    const newer = { ...frame(20), connId: "newer-connection" };
    applyGestureFrame(state, newer, null, 20);

    expect(applyGestureFrame(state, frame(10, "end"), null, 30)).toBe(false);
    expect(state.get("element")?.connId).toBe("newer-connection");
    expect(applyGestureFrame(state, { ...newer, phase: "end" }, null, 40)).toBe(true);
    expect(state.size).toBe(0);
  });

  test("keeps newest draw points and expires abandoned overrides", () => {
    const state = new Map<string, GestureOverride>();
    const draw: ServerGesture = {
      type: "gesture",
      connId: "peer-connection",
      principalId: "peer",
      kind: "draw",
      phase: "active",
      elementId: "stroke",
      x: 2,
      y: 3,
      points: [0, 1, 2, 3],
    };
    applyGestureFrame(state, draw, null, 10);
    expect(state.get("stroke")?.points).toEqual([0, 1, 2, 3]);
    expect(expireGestures(state, 3_010)).toBe(false);
    expect(expireGestures(state, 3_011)).toBe(true);
    expect(state.size).toBe(0);
  });

  test("a carry keeps the item it names while its geometry eases", () => {
    const state = new Map<string, GestureOverride>();
    const carried: ServerGesture = {
      type: "gesture",
      connId: "peer-connection",
      principalId: "peer",
      kind: "carry",
      phase: "active",
      elementId: "leaf",
      x: 0,
      y: 0,
      carry: {
        surface: { kind: "tile", containerId: "view", tileId: "leaf" },
        item: TILE_ITEM,
        label: "build",
      },
    };
    applyGestureFrame(state, carried, null, 0);
    applyGestureFrame(state, { ...carried, x: 100, y: 0 }, null, 10);
    stepGestures(state, GESTURE_HALF_LIFE_MS);

    // The WHAT survives every frame of the WHERE: a ghost must not blink out mid-motion.
    expect(state.get("leaf")).toMatchObject({
      kind: "carry",
      carry: {
        surface: { kind: "tile", containerId: "view", tileId: "leaf" },
        item: TILE_ITEM,
        label: "build",
      },
      current: { x: 50, y: 0 },
    });
    expect(applyGestureFrame(state, { ...carried, phase: "end" }, null, 20)).toBe(true);
    expect(state.size).toBe(0);
  });

  test("a stale AIM is dropped long before the ghost is, because it holds the panes", () => {
    const state = new Map<string, GestureOverride>();
    const aiming: ServerGesture = {
      type: "gesture",
      connId: "peer-connection",
      principalId: "peer",
      kind: "carry",
      phase: "active",
      elementId: "leaf",
      x: 0,
      y: 0,
      carry: {
        surface: { kind: "tile", containerId: "view", tileId: "leaf" },
        item: TILE_ITEM,
        label: "build",
        aim: { containerId: "view", tileId: "t1", edge: "right", action: "place" },
      },
    };
    applyGestureFrame(state, aiming, null, 0);

    // Inside the aim's freshness bound a dropped frame changes nothing.
    expect(expireGestures(state, AIM_TTL_MS)).toBe(false);
    expect(state.get("leaf")?.carry?.aim).toBeDefined();

    // Past it, the preview claim is retired — the carry, its surface and its label stay,
    // so the peer's ghost keeps riding the geometry TTL. A lost end frame must not leave
    // every viewer's composition visibly squeezed for three seconds.
    expect(expireGestures(state, AIM_TTL_MS + 1)).toBe(true);
    const swept = state.get("leaf");
    expect(swept?.carry).toEqual({
      surface: { kind: "tile", containerId: "view", tileId: "leaf" },
      // The ITEM survives the aim sweep with the surface: what is carried did not change,
      // only where it was pointing.
      item: TILE_ITEM,
      label: "build",
    });
    // Idempotent: the sweep runs every animation frame and must not keep rewriting.
    expect(expireGestures(state, AIM_TTL_MS + 2)).toBe(false);
    expect(state.get("leaf")).toBe(swept);

    expect(expireGestures(state, GESTURE_TTL_MS + 1)).toBe(true);
    expect(state.size).toBe(0);
  });
});
