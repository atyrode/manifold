import {
  compareElements,
  TerminalCustomDataSchema,
  type SceneElement,
  type TerminalCustomData,
} from "@manifold/protocol";

/**
 * Pure projection between manifold's canonical scene and React Flow's node model.
 *
 * Kept free of React and of `@xyflow/react` so the policy is unit-testable in isolation
 * (repo convention: nontrivial sync policy lives in pure modules, never inline in a
 * component callback). The spike deliberately reuses the EXISTING terminal element shape
 * — an `embeddable` carrying `link === TERMINAL_LINK` and terminal `customData` — so a
 * pad renders identically in both the Excalidraw route and the flow route, and no
 * migration or protocol change is involved.
 */

/** Discriminator the Excalidraw route already writes; unchanged here on purpose. */
export const TERMINAL_LINK = "manifold://terminal";

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

/**
 * `SceneElementSchema` is a loose object, so geometry arrives as `unknown`. A terminal
 * without usable geometry is skipped rather than coerced to 0 — silently stacking every
 * malformed terminal at the origin would look like a rendering bug.
 */
export function terminalGeometry(element: SceneElement): Geometry | null {
  const record = element as unknown as Record<string, unknown>;
  const x = finiteNumber(record["x"]);
  const y = finiteNumber(record["y"]);
  const width = finiteNumber(record["width"]);
  const height = finiteNumber(record["height"]);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** True when this element is a live terminal surface bound to a session. */
export function terminalBinding(element: SceneElement): TerminalCustomData | null {
  if (element.isDeleted) return null;
  const record = element as unknown as Record<string, unknown>;
  if (record["link"] !== TERMINAL_LINK) return null;
  const parsed = TerminalCustomDataSchema.safeParse(record["customData"]);
  return parsed.success ? parsed.data : null;
}

/**
 * Projects the canonical scene into React Flow nodes, in canonical paint order.
 *
 * Only terminals are projected: ink, shapes and text are out of scope for this spike and
 * are left untouched in the scene, so switching routes back to Excalidraw still shows
 * them. Ordering uses the protocol's own comparator (fractional `index`, id tiebreak) and
 * is flattened into a `zIndex` band, because React Flow orders by `zIndex`/array position
 * rather than by an opaque fractional index.
 */
export function projectTerminals(
  scene: ReadonlyMap<string, SceneElement>,
): readonly ProjectedTerminalNode[] {
  const live: SceneElement[] = [];
  for (const element of scene.values()) {
    if (terminalBinding(element) !== null) live.push(element);
  }
  live.sort(compareElements);

  const nodes: ProjectedTerminalNode[] = [];
  for (const element of live) {
    const binding = terminalBinding(element);
    const geometry = terminalGeometry(element);
    if (binding === null || geometry === null) continue;
    nodes.push({
      id: element.id,
      type: "terminal",
      position: { x: geometry.x, y: geometry.y },
      width: geometry.width,
      height: geometry.height,
      zIndex: nodes.length + 1,
      data: { sessionId: binding.sessionId },
    });
  }
  return nodes;
}

/**
 * Excalidraw bumps `version`/`versionNonce` on every local mutation, and manifold's LWW
 * reconcile depends on that discipline. A non-Excalidraw canvas owes the same contract, so
 * the spike mints it explicitly here.
 *
 * `versionNonce` must stay a non-negative 31-bit integer: `shouldAccept` breaks ties by
 * LOWER nonce, and the protocol schema rejects negatives.
 */
export const NONCE_LIMIT = 2 ** 31;

export function randomNonce(random: () => number = Math.random): number {
  return Math.floor(random() * NONCE_LIMIT);
}

/**
 * Returns a new element with `patch` applied and the version pair advanced. Never mutates
 * its input — the canonical map's objects are shared with the SDK, and writing through
 * them is exactly the aliasing class of bug that produced manifold's projection-ownership
 * rule.
 */
export function bumpElement(
  element: SceneElement,
  patch: Readonly<Record<string, unknown>>,
  nonce: () => number = randomNonce,
): SceneElement {
  return {
    ...element,
    ...patch,
    version: element.version + 1,
    versionNonce: nonce(),
  } as SceneElement;
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
  if (geometry === null) return null;
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
  if (geometry === null) return null;
  if (geometry.width === width && geometry.height === height) return null;
  return bumpElement(element, { width, height }, nonce);
}
