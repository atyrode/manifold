import { compareElements, type SceneElement } from "@manifold/protocol";
import type { GestureOverride } from "./remote-gestures";
import { strokeBounds, toRelativePoints } from "./stroke";

export const DEFAULT_TERMINAL_WIDTH = 720;
export const DEFAULT_TERMINAL_HEIGHT = 480;
export const DEFAULT_TEXT_WIDTH = 240;
export const DEFAULT_TEXT_HEIGHT = 48;
export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_TEXT_COLOR = "#f8f9fa";

export interface TerminalNodeData extends Record<string, unknown> {
  readonly sessionId: string;
}

export interface TextNodeData extends Record<string, unknown> {
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
}

export interface DrawNodeData extends Record<string, unknown> {
  readonly points: readonly number[];
  readonly strokeWidth: number;
  readonly color: string;
}

interface ProjectedNodeBase {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

export interface ProjectedTerminalNode extends ProjectedNodeBase {
  readonly type: "terminal";
  readonly data: TerminalNodeData;
}

export interface ProjectedTextNode extends ProjectedNodeBase {
  readonly type: "text";
  readonly data: TextNodeData;
}

export interface ProjectedDrawNode extends ProjectedNodeBase {
  readonly type: "draw";
  readonly data: DrawNodeData;
}

export type ProjectedNode = ProjectedTerminalNode | ProjectedTextNode | ProjectedDrawNode;

export function projectElements(
  elements: ReadonlyMap<string, SceneElement>,
  overrides: ReadonlyMap<string, GestureOverride>,
): readonly ProjectedNode[] {
  return [...elements.values()].sort(compareElements).map((element) => {
    const override = overrides.get(element.id)?.current;
    const geometry = {
      position: {
        x: override?.x ?? element.x,
        y: override?.y ?? element.y,
      },
      width: override?.width ?? element.width,
      height: override?.height ?? element.height,
    };
    switch (element.type) {
      case "terminal":
        return {
          id: element.id,
          type: "terminal",
          ...geometry,
          zIndex: element.zIndex,
          data: { sessionId: element.sessionId },
        };
      case "text":
        return {
          id: element.id,
          type: "text",
          ...geometry,
          zIndex: element.zIndex,
          data: { text: element.text, fontSize: element.fontSize, color: element.color },
        };
      case "draw":
        return {
          id: element.id,
          type: "draw",
          ...geometry,
          zIndex: element.zIndex,
          data: {
            points: element.points,
            strokeWidth: element.strokeWidth,
            color: element.color,
          },
        };
    }
  });
}

export function createTerminalElement(
  id: string,
  sessionId: string,
  position: { readonly x: number; readonly y: number },
  zIndex: number,
): Extract<SceneElement, { type: "terminal" }> {
  return {
    id,
    type: "terminal",
    sessionId,
    x: position.x,
    y: position.y,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex,
  };
}

export function createTextElement(
  id: string,
  position: { readonly x: number; readonly y: number },
  zIndex: number,
  color: string = DEFAULT_TEXT_COLOR,
): Extract<SceneElement, { type: "text" }> {
  return {
    id,
    type: "text",
    text: "",
    x: position.x,
    y: position.y,
    width: DEFAULT_TEXT_WIDTH,
    height: DEFAULT_TEXT_HEIGHT,
    zIndex,
    fontSize: DEFAULT_FONT_SIZE,
    color,
  };
}

export function createDrawElement(
  id: string,
  points: readonly number[],
  color: string,
  strokeWidth: number,
  zIndex: number,
): Extract<SceneElement, { type: "draw" }> {
  const bounds = strokeBounds(points, strokeWidth);
  return {
    id,
    type: "draw",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    zIndex,
    points: toRelativePoints(points, bounds),
    strokeWidth,
    color,
  };
}

export function textHeightFor(text: string, fontSize: number): number {
  const lines = text.split("\n").length;
  return Math.max(DEFAULT_TEXT_HEIGHT, lines * fontSize * 1.4 + 16);
}
