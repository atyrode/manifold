import type { SceneElement } from "@manifold/protocol";

/**
 * Agent-facing testability seam (CONTRACTS.md §testability).
 *
 * The multiplayer revert bug shipped because the browser-canvas↔SDK projection boundary
 * was observable by no test: e2e drove the SDK (correct), the browser gate asserted DOM
 * presence, and nothing could read what the canvas actually held. This seam keeps that
 * boundary inspectable across renderer implementations.
 *
 * Opt-in only: installed when `localStorage["manifold:debug"] === "1"`. Read-only
 * snapshots of state the page already holds; no mutation surface, no secrets.
 */

/** Type + geometry snapshot of one element, canvas- or SDK-side. */
export interface DebugElementSnapshot {
  readonly id: string;
  readonly type: SceneElement["type"];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly extra: string | number;
}

export interface DebugViewport {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

export interface DebugGestureSnapshot {
  readonly elementId: string;
  readonly connId: string;
  readonly x: number;
  readonly y: number;
}

export interface ManifoldDebugSeam {
  /** SDK canonical view: what this client believes the server scene is. */
  readonly scene: () => readonly DebugElementSnapshot[];
  /** Live canvas projection. */
  readonly canvas: () => readonly DebugElementSnapshot[];
  /** Number of messages waiting for a live transport. */
  readonly outbox: () => number;
  readonly rev: () => number;
  readonly epoch: () => string;
  /** Scene→screen mapping so harnesses can aim real pointer events. */
  /** Current remote geometry overrides, excluding self echoes. */
  readonly gestures: () => readonly DebugGestureSnapshot[];
  readonly viewport: () => DebugViewport | null;
}

declare global {
  interface Window {
    __manifold?: ManifoldDebugSeam;
  }
}

export function debugSeamEnabled(): boolean {
  try {
    return window.localStorage.getItem("manifold:debug") === "1";
  } catch {
    return false;
  }
}

/** Coerces a scene record into a geometry snapshot. */
export function toElementSnapshot(element: SceneElement): DebugElementSnapshot {
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    zIndex: element.zIndex,
    extra:
      element.type === "terminal"
        ? element.sessionId
        : element.type === "portal"
          ? element.containerId
          : element.type === "text"
            ? element.text
            : element.points.length,
  };
}
