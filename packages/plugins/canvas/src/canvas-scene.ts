import { compareElements, type SceneElement } from "@manifold/protocol";
import { DEFAULT_TERMINAL_HEIGHT, DEFAULT_TERMINAL_WIDTH } from "@manifold/scene";
import type { GestureOverride } from "@manifold/plugin/hooks";
import { strokeBounds, toRelativePoints } from "./stroke.ts";
import type { Node } from "@xyflow/react";

// Terminal element defaults live in @manifold/scene: the server authors portals onto
// solo compositions too, so both sides must size them identically.
export { DEFAULT_TERMINAL_HEIGHT, DEFAULT_TERMINAL_WIDTH };
export const DEFAULT_TEXT_WIDTH = 240;
export const DEFAULT_TEXT_HEIGHT = 48;
export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_TEXT_COLOR = "#f8f9fa";

function shallowDataEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const valueA = a[key];
    const valueB = b[key];
    if (Object.is(valueA, valueB)) continue;
    if (
      Array.isArray(valueA) &&
      Array.isArray(valueB) &&
      valueA.length === valueB.length &&
      valueA.every((value, index) => Object.is(value, valueB[index]))
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Reconciles a fresh projection into React Flow's live node state.
 *
 * Three duties:
 * - Yield to a live gesture: React Flow stamps `dragging`/`resizing` onto every node it is
 *   moving or sizing (`applyNodeChanges` writes them from the position and dimension
 *   changes it applies), including every co-dragged node of a multi-selection. While either
 *   flag is set that node's own entry is the freshest geometry there is, so it is reused
 *   verbatim and a projection — which trails the gesture by at least a server round trip —
 *   can never stomp it. Because the flag lives on React Flow's own array there is no
 *   parallel gesture map left to desynchronize from it.
 * - Carry `measured`: it is React Flow's own record of the painted box and what the
 *   resizer reads for its starting size. Re-projecting builds fresh node objects, and
 *   `adoptUserNodes` copies `measured` straight off the object it is handed — a
 *   re-projection landing between two frames erased it, and a resize begun in that
 *   window started from zero and produced negative geometry. Never let it into scene
 *   state.
 * - Preserve identity: every projection rebuilds every node object, but handing React
 *   Flow a new object per node re-renders the whole canvas (xterm terminals included)
 *   on every drag frame — the main thread saturates and the dragged node visibly trails
 *   the pointer. Equivalent nodes keep their current object; an unchanged scene keeps
 *   the current array so the state update bails outright.
 */
export function reconcileNodes(next: readonly Node[], current: Node[]): Node[] {
  if (current.length === 0) return [...next];
  const currentById = new Map(current.map((node) => [node.id, node] as const));
  let reusedAll = current.length === next.length;
  const out = next.map((node, index) => {
    const previous = currentById.get(node.id);
    if (previous === undefined) {
      reusedAll = false;
      return node;
    }
    if (previous.dragging === true || previous.resizing === true) {
      if (previous !== current[index]) reusedAll = false;
      return previous;
    }
    if (
      previous.type === node.type &&
      previous.position.x === node.position.x &&
      previous.position.y === node.position.y &&
      previous.width === node.width &&
      previous.height === node.height &&
      previous.zIndex === node.zIndex &&
      (previous.selected ?? false) === (node.selected ?? false) &&
      previous.dragHandle === node.dragHandle &&
      shallowDataEqual(previous.data, node.data)
    ) {
      if (previous !== current[index]) reusedAll = false;
      return previous;
    }
    reusedAll = false;
    return previous.measured === undefined ? node : { ...node, measured: previous.measured };
  });
  return reusedAll ? current : out;
}

export interface PortalNodeData extends Record<string, unknown> {
  readonly containerId: string;
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

export interface ProjectedTextNode extends ProjectedNodeBase {
  readonly type: "text";
  readonly data: TextNodeData;
}

export interface ProjectedDrawNode extends ProjectedNodeBase {
  readonly type: "draw";
  readonly data: DrawNodeData;
}

export interface ProjectedPortalNode extends ProjectedNodeBase {
  readonly type: "portal";
  readonly data: PortalNodeData;
}

export type ProjectedNode = ProjectedPortalNode | ProjectedTextNode | ProjectedDrawNode;

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
      case "portal":
        return {
          id: element.id,
          type: "portal",
          ...geometry,
          zIndex: element.zIndex,
          data: { containerId: element.containerId },
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

/**
 * A terminal on a canvas IS a portal onto its home composition: the terminal element
 * kind is retired, so the one factory authors the portal and the portal's mono form
 * paints the terminal's own chrome inside it. Default geometry is still a terminal's,
 * because that is what a solo composition contains.
 */
export function createPortalElement(
  id: string,
  containerId: string,
  position: { readonly x: number; readonly y: number },
  zIndex: number,
): Extract<SceneElement, { type: "portal" }> {
  return {
    id,
    type: "portal",
    containerId,
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
