import type { SceneElement } from "@manifold/protocol";

/**
 * Agent-facing testability probe (CONTRACTS.md §testability).
 *
 * The multiplayer revert bug shipped because the browser-canvas↔SDK projection boundary
 * was observable by no test: e2e drove the SDK (correct), the browser gate asserted DOM
 * presence, and nothing could read what the canvas actually held. This probe keeps that
 * boundary inspectable across renderer implementations.
 *
 * Opt-in only: installed when `localStorage["manifold:debug"] === "1"`. Read-only
 * snapshots of state the page already holds; no mutation ref, no secrets.
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

/** The container camera itself, as `ViewportHandle.viewport()` reports it. */
export interface DebugCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface DebugGestureSnapshot {
  readonly elementId: string;
  readonly connId: string;
  readonly x: number;
  readonly y: number;
  /** Species of the item in flight, on a carry frame; absent on plain geometry. */
  readonly carry?: string;
}

export interface ManifoldDebugProbe {
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
  /**
   * The mounted container's camera. Separate from {@link ManifoldDebugProbe.viewport}, which
   * projects the canvas onto the page for pointer aiming: this is the quantity a spotlight
   * MOVES, so a gate can assert that "look at this" actually landed.
   */
  readonly containerViewport: () => DebugCamera | null;
  /**
   * The last spotlight this client APPLIED (a `manifold://` URI), or null. The slot lives in
   * `@manifold/plugin`: `core.presence` applies spotlights and records there, and a plugin
   * and the floor may not import each other.
   */
  readonly lastSpotlight: () => string | null;
  /**
   * Renders per node species since load. A context that churns is invisible in the DOM
   * — the pixels are identical — so the only way to hold "presence polling must not
   * re-render live terminals" to account is to count the renders it causes.
   */
  readonly renders: () => Readonly<Record<string, number>>;
}

declare global {
  interface Window {
    __manifold?: ManifoldDebugProbe;
  }
}

export function debugProbeEnabled(): boolean {
  try {
    return window.localStorage.getItem("manifold:debug") === "1";
  } catch {
    return false;
  }
}

const renders = new Map<string, number>();

/**
 * One render of one node species. Called unconditionally (the counter is three
 * instructions and a Map write); {@link renderCounts} is what stays behind the probe.
 */
export function countRender(kind: string): void {
  renders.set(kind, (renders.get(kind) ?? 0) + 1);
}

export function renderCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(renders);
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
      element.type === "portal"
        ? element.containerId
        : element.type === "text"
          ? element.text
          : element.points.length,
  };
}
