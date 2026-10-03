import { describe, expect, test } from "bun:test";
import type { SceneElement } from "@manifold/protocol";
import type { GestureOverride } from "@manifold/plugin/hooks";
import {
  reconcileNodes,
  createDrawElement,
  createPortalElement,
  projectElements,
} from "../src/canvas-scene.ts";

// A terminal on a canvas IS a portal onto its home composition, so the terminal-shaped
// element under test is a portal with terminal geometry.
const terminal = createPortalElement("terminal", "home-composition", { x: 10, y: 20 }, 2);
const annotation: SceneElement = {
  id: "annotation",
  type: "acme.caption",
  x: 30,
  y: 40,
  width: 230,
  height: 60,
  zIndex: 1,
  caption: "marker",
};
const draw = createDrawElement("draw", [10, 20, 30, 25], "#abcdef", 3, 3);

describe("flow scene", () => {
  test("projects floor and contributed elements in canonical paint order", () => {
    const elements = new Map<string, SceneElement>([
      [terminal.id, terminal],
      [draw.id, draw],
      [annotation.id, annotation],
    ]);
    expect(projectElements(elements, new Map()).map((node) => node.id)).toEqual([
      annotation.id,
      terminal.id,
      draw.id,
    ]);
  });

  test("projects authorship beside payload without exposing it to element renderers", () => {
    const projected = projectElements(
      new Map([
        [
          annotation.id,
          { ...annotation, lastEditedBy: "principal-1", lastEditedAt: 42 } satisfies SceneElement,
        ],
      ]),
      new Map(),
    );
    expect(projected[0]?.data).not.toHaveProperty("lastEditedBy");
    expect(projected[0]?.data).not.toHaveProperty("lastEditedAt");
  });

  test("uses a live gesture override for projected geometry", () => {
    const override: GestureOverride = {
      connId: "peer-connection",
      principalId: "peer",
      elementId: terminal.id,
      kind: "resize",
      target: { x: 100, y: 200, width: 800, height: 600 },
      current: { x: 90, y: 180, width: 780, height: 580 },
      updatedAt: 1,
    };
    const projected = projectElements(
      new Map([[terminal.id, terminal]]),
      new Map([[terminal.id, override]]),
    );
    expect(projected[0]).toMatchObject({
      position: { x: 90, y: 180 },
      width: 780,
      height: 580,
    });
  });

  test("creates normalized draw points", () => {
    expect(draw).toMatchObject({
      x: 7,
      y: 17,
      width: 26,
      height: 11,
      points: [3, 3, 23, 8],
    });
  });

  test("carries runtime measurements across a re-projection without touching geometry", () => {
    const current = [
      { id: "a", position: { x: 0, y: 0 }, data: {}, measured: { width: 480, height: 320 } },
      { id: "gone", position: { x: 0, y: 0 }, data: {}, measured: { width: 10, height: 10 } },
    ];
    const next = [
      { id: "a", position: { x: 5, y: 6 }, width: 500, height: 340, data: {} },
      { id: "b", position: { x: 1, y: 2 }, width: 100, height: 90, data: {} },
    ];

    expect(reconcileNodes(next, current)).toEqual([
      {
        id: "a",
        position: { x: 5, y: 6 },
        width: 500,
        height: 340,
        data: {},
        measured: { width: 480, height: 320 },
      },
      { id: "b", position: { x: 1, y: 2 }, width: 100, height: 90, data: {} },
    ]);
    // A node React Flow has never measured must not gain a fabricated measurement.
    expect(reconcileNodes(next, [])).toEqual(next);
  });

  test("keeps node identity for equivalent projections so unchanged nodes never re-render", () => {
    const currentA = {
      id: "a",
      type: "terminal",
      position: { x: 0, y: 0 },
      width: 720,
      height: 480,
      zIndex: 1,
      data: { terminalId: "s1" },
      measured: { width: 720, height: 480 },
      dragging: false,
    };
    const current = [currentA];
    // A fresh projection rebuilds every object; equivalent values must map back to the
    // exact current objects, and a fully-unchanged scene must return the current array.
    const same = [
      {
        id: "a",
        type: "terminal",
        position: { x: 0, y: 0 },
        width: 720,
        height: 480,
        zIndex: 1,
        data: { terminalId: "s1" },
      },
    ];
    expect(reconcileNodes(same, current)).toBe(current);

    // Draw data arrays are rebuilt per projection; value-equal points still reuse.
    const stroke = { id: "d", position: { x: 1, y: 1 }, data: { points: [0, 0, 4, 4] } };
    const strokeCurrent = [{ ...stroke, data: { points: [0, 0, 4, 4] } }];
    expect(reconcileNodes([stroke], strokeCurrent)).toBe(strokeCurrent);

    // A genuine change replaces only the changed node and keeps the rest by identity.
    const other = {
      id: "b",
      type: "acme.caption",
      position: { x: 9, y: 9 },
      width: 240,
      height: 48,
      zIndex: 2,
      data: { caption: "hi" },
    };
    const moved = {
      id: "a",
      type: "terminal",
      position: { x: 50, y: 0 },
      width: 720,
      height: 480,
      zIndex: 1,
      data: { terminalId: "s1" },
    };
    const otherCurrent = { ...other };
    const result = reconcileNodes([moved, other], [currentA, otherCurrent]);
    expect(result[0]).toEqual({ ...moved, measured: { width: 720, height: 480 } });
    expect(result[0]).not.toBe(currentA);
    expect(result[1]).toBe(otherCurrent);
  });

  test("keeps local selection when canonical edits replace a node", () => {
    const selected = {
      id: "note",
      position: { x: 0, y: 0 },
      width: 240,
      height: 48,
      data: {},
      selected: true,
    };
    const next = { id: "note", position: { x: 0, y: 0 }, width: 240, height: 75, data: {} };
    const [resized] = reconcileNodes([next], [selected]);
    expect(resized).toEqual({ ...next, selected: true });
    expect(reconcileNodes([next], [resized!])[0]).toBe(resized);
    expect(reconcileNodes([next], [{ ...selected, selected: false }])[0]?.selected).toBe(false);
  });

  test("reuses a node under a live gesture so a trailing projection never stomps it", () => {
    const dragging = {
      id: "a",
      type: "terminal",
      position: { x: 400, y: 300 },
      width: 720,
      height: 480,
      zIndex: 1,
      data: { terminalId: "s1" },
      measured: { width: 720, height: 480 },
      dragging: true,
    };
    // The projection still carries the pre-drag origin: the CRDT only learns the new
    // position at drag stop. Reuse must win by identity, not by value comparison.
    const staleNode = {
      id: "a",
      type: "terminal",
      position: { x: 0, y: 0 },
      width: 720,
      height: 480,
      zIndex: 1,
      data: { terminalId: "s1" },
    };
    const stale = [staleNode];
    expect(reconcileNodes(stale, [dragging])[0]).toBe(dragging);

    const resizing = { ...dragging, dragging: false, resizing: true, width: 900, height: 600 };
    expect(reconcileNodes(stale, [resizing])[0]).toBe(resizing);

    // An unchanged order with every node under a gesture keeps the current array whole.
    const current = [dragging];
    expect(reconcileNodes(stale, current)).toBe(current);

    // Once the gesture ends the flag clears and the projection is authoritative again.
    const settled = { ...dragging, dragging: false };
    const reconciled = reconcileNodes(stale, [settled]);
    expect(reconciled[0]).not.toBe(settled);
    expect(reconciled[0]).toEqual({ ...staleNode, measured: { width: 720, height: 480 } });
  });
});
