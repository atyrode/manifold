/**
 * Agent-facing testability seam (CONTRACTS.md §testability).
 *
 * The multiplayer revert bug shipped because the Excalidraw↔SDK projection boundary was
 * observable by no test: e2e drove the SDK (correct), the browser gate asserted DOM
 * presence, and nothing could read what the canvas actually held. This seam makes that
 * boundary inspectable from automation so convergence can be ASSERTED, not assumed.
 *
 * Opt-in only: installed when `localStorage["manifold:debug"] === "1"`. Read-only
 * snapshots of state the page already holds; no mutation surface, no secrets.
 */

/** Version stamp + geometry snapshot of one element, canvas- or SDK-side. */
export interface DebugElementSnapshot {
  readonly id: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DebugViewport {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

export interface ManifoldDebugSeam {
  /** SDK canonical view: what this client believes the server scene is. */
  readonly scene: () => readonly DebugElementSnapshot[];
  /** Live Excalidraw canvas, including deleted — the projection under test. */
  readonly canvas: () => readonly DebugElementSnapshot[];
  /** Element ids edited locally but not yet flushed to the wire. */
  readonly pending: () => readonly string[];
  readonly rev: () => number;
  readonly epoch: () => string;
  /** Scene→screen mapping so harnesses can aim real pointer events. */
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

/** Coerces a loose scene record into a geometry snapshot; non-numeric fields become 0. */
export function toElementSnapshot(element: {
  readonly id: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted: boolean;
  readonly [key: string]: unknown;
}): DebugElementSnapshot {
  return {
    id: element.id,
    version: element.version,
    versionNonce: element.versionNonce,
    isDeleted: element.isDeleted,
    x: typeof element["x"] === "number" ? element["x"] : 0,
    y: typeof element["y"] === "number" ? element["y"] : 0,
    width: typeof element["width"] === "number" ? element["width"] : 0,
    height: typeof element["height"] === "number" ? element["height"] : 0,
  };
}
