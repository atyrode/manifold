import { compareElements, type SceneElement } from "@manifold/protocol";

/**
 * Pure projection between manifold's canonical scene and React Flow's node model.
 * Kept free of React so synchronization policy remains independently testable.
 */

export interface TerminalNodeData {
  readonly sessionId: string;
}

export interface ProjectedTerminalNode {
  readonly id: string;
  readonly type: "terminal";
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  /** Explicit band so `zIndexMode="manual"` reproduces canonical paint order. */
  readonly zIndex: number;
  readonly data: TerminalNodeData;
}

interface Geometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Native protocol validation guarantees finite, positive geometry. */
export function terminalGeometry(element: SceneElement): Geometry {
  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  };
}

/** Returns the session binding for a live native terminal record. */
export function terminalBinding(element: SceneElement): { readonly sessionId: string } | null {
  return element.isDeleted ? null : { sessionId: element.sessionId };
}

/** Projects canonical native terminal records into React Flow nodes in paint order. */
export function projectTerminals(
  scene: ReadonlyMap<string, SceneElement>,
): readonly ProjectedTerminalNode[] {
  const live = [...scene.values()].filter((element) => !element.isDeleted).sort(compareElements);
  return live.map((element) => ({
    id: element.id,
    type: "terminal",
    position: { x: element.x, y: element.y },
    width: element.width,
    height: element.height,
    zIndex: element.zIndex,
    data: { sessionId: element.sessionId },
  }));
}

/**
 * Manifold's LWW reconcile requires every local mutation to bump
 * `version`/`versionNonce`, regardless of renderer.
 *
 * `versionNonce` must stay a non-negative 31-bit integer: `shouldAccept` breaks ties by
 * LOWER nonce, and the protocol schema rejects negatives.
 */
export const NONCE_LIMIT = 2 ** 31;

export function randomNonce(random: () => number = Math.random): number {
  return Math.floor(random() * NONCE_LIMIT);
}

export const DEFAULT_TERMINAL_WIDTH = 720;
export const DEFAULT_TERMINAL_HEIGHT = 480;

/** Creates the canvas-agnostic terminal record written by the React Flow renderer. */
export function createTerminalElement(
  id: string,
  sessionId: string,
  position: { readonly x: number; readonly y: number },
  nonce: () => number = randomNonce,
): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId,
    x: position.x,
    y: position.y,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex: 0,
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
  };
}

/**
 * Returns a new element with `patch` applied and the version pair advanced. Never mutates
 * its input — the canonical map's objects are shared with the SDK, and writing through
 * them is exactly the aliasing class of bug that produced manifold's projection-ownership
 * rule.
 */
export function bumpElement(
  element: SceneElement,
  patch: Readonly<Partial<SceneElement>>,
  nonce: () => number = randomNonce,
): SceneElement {
  return {
    ...element,
    ...patch,
    version: element.version + 1,
    versionNonce: nonce(),
  };
}

/**
 * Translates a React Flow position change into a canonical element update.
 *
 * Returns `null` when the element is unknown, the position is not finite, or the position
 * is unchanged — so an idle drag (or React Flow's routine position echo) never mints a
 * version and never touches the wire.
 *
 * The finite check is not paranoia: `NaN <= 0` is `false`, so a naive range guard lets
 * `NaN`/`Infinity` through, and a non-finite coordinate would be published to every viewer
 * and persisted in a snapshot. Reject at the publish boundary instead.
 */
export function applyNodeMove(
  scene: ReadonlyMap<string, SceneElement>,
  move: { readonly id: string; readonly position: { readonly x: number; readonly y: number } },
  nonce: () => number = randomNonce,
): SceneElement | null {
  const element = scene.get(move.id);
  if (element === undefined) return null;
  if (finiteNumber(move.position.x) === null || finiteNumber(move.position.y) === null) {
    return null;
  }
  const geometry = terminalGeometry(element);
  if (geometry.x === move.position.x && geometry.y === move.position.y) return null;
  return bumpElement(element, { x: move.position.x, y: move.position.y }, nonce);
}

/**
 * Translates a finished React Flow resize into a canonical element update. Same contract as
 * `applyNodeMove`, including the finite guard: unchanged or unusable geometry returns
 * `null`, so grabbing a resize handle without moving it never mints a version.
 */
export function applyNodeResize(
  scene: ReadonlyMap<string, SceneElement>,
  resize: { readonly id: string; readonly width: number; readonly height: number },
  nonce: () => number = randomNonce,
): SceneElement | null {
  const element = scene.get(resize.id);
  if (element === undefined) return null;
  const width = finiteNumber(resize.width);
  const height = finiteNumber(resize.height);
  if (width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  const geometry = terminalGeometry(element);
  if (geometry.width === width && geometry.height === height) return null;
  return bumpElement(element, { width, height }, nonce);
}
