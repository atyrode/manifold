import {
  compareElements,
  elementPayload,
  type SceneElement,
  type SceneElementPayload,
} from "@manifold/protocol";
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

/**
 * ONE projected node shape, neutral over element kinds.
 *
 * It used to be a three-member union — `portal` | `text` | `draw` — with a typed `data`
 * interface each, mirroring the protocol's retired discriminated union. Both are gone for the
 * same reason (ADR 0013 §16): the protocol carries a neutral envelope now, the payload's
 * meaning belongs to the plugin that declared the type, and a canvas that could only project
 * three kinds could not project a fourth — so a record whose plugin this build never heard of
 * had nowhere to go, on the one renderer whose whole job is to paint contributed elements.
 *
 * `type` is the wire type verbatim, which is also React Flow's node-type key, and `data` is the
 * payload verbatim. A node component reads its own fields defensively, exactly as the published
 * element contract already requires (`ElementProps.data`, `@manifold/plugin` host.ts) — the
 * same document may hold records written by an older version of the plugin, so no schema is
 * imposed at the paint boundary and none is claimed here.
 */
export interface ProjectedNode {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly type: string;
  readonly data: SceneElementPayload;
}

export function projectElements(
  elements: ReadonlyMap<string, SceneElement>,
  overrides: ReadonlyMap<string, GestureOverride>,
): readonly ProjectedNode[] {
  return [...elements.values()].sort(compareElements).map((element) => {
    const override = overrides.get(element.id)?.current;
    return {
      id: element.id,
      type: element.type,
      position: {
        x: override?.x ?? element.x,
        y: override?.y ?? element.y,
      },
      width: override?.width ?? element.width,
      height: override?.height ?? element.height,
      zIndex: element.zIndex,
      data: elementPayload(element),
    };
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
): SceneElement {
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

/**
 * The payload field a fresh note holds as COLLABORATIVE text, declared beside the factory that
 * authors one (ADR 0013 §16 clause 6).
 *
 * The canvas names it because the canvas owns the text TOOL — that ruling is AXIOMS.md
 * §Roadmap's full-conversion inventory, "the text TOOL is canvas chrome" — while `core.notes`
 * owns the element's renderer, its editor and its payload SCHEMA. One statement, so the author
 * and the schema cannot drift into disagreeing about which field a person types into.
 */
export const TEXT_COLLABORATIVE_FIELDS: readonly string[] = ["text"];

export function createTextElement(
  id: string,
  position: { readonly x: number; readonly y: number },
  zIndex: number,
  color: string = DEFAULT_TEXT_COLOR,
): SceneElement {
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
): SceneElement {
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
