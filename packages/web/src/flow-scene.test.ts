import { describe, expect, test } from "bun:test";
import type { SceneElement } from "@manifold/protocol";
import type { GestureOverride } from "./remote-gestures";
import {
  createDrawElement,
  createTerminalElement,
  createTextElement,
  projectElements,
  textHeightFor,
} from "./flow-scene";

const terminal = createTerminalElement("terminal", "session", { x: 10, y: 20 }, 2);
const text = createTextElement("text", { x: 30, y: 40 }, 1, "#123456");
const draw = createDrawElement("draw", [10, 20, 30, 25], "#abcdef", 3, 3);

describe("flow scene", () => {
  test("projects every element type in canonical paint order", () => {
    const elements = new Map<string, SceneElement>([
      [terminal.id, terminal],
      [draw.id, draw],
      [text.id, text],
    ]);
    expect(projectElements(elements, new Map())).toEqual([
      {
        id: "text",
        type: "text",
        position: { x: 30, y: 40 },
        width: 240,
        height: 48,
        zIndex: 1,
        data: { text: "", fontSize: 20, color: "#123456" },
      },
      {
        id: "terminal",
        type: "terminal",
        position: { x: 10, y: 20 },
        width: 720,
        height: 480,
        zIndex: 2,
        data: { sessionId: "session" },
      },
      {
        id: "draw",
        type: "draw",
        position: { x: 7, y: 17 },
        width: 26,
        height: 11,
        zIndex: 3,
        data: { points: [3, 3, 23, 8], strokeWidth: 3, color: "#abcdef" },
      },
    ]);
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

  test("creates normalized draw points and sizes multiline text", () => {
    expect(draw).toMatchObject({
      x: 7,
      y: 17,
      width: 26,
      height: 11,
      points: [3, 3, 23, 8],
    });
    expect(textHeightFor("one", 20)).toBe(48);
    expect(textHeightFor("one\ntwo", 20)).toBe(72);
  });
});
