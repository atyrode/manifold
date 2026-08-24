/** Monotonic readiness facts that decide when a canonical scene must be painted. */
export interface CanvasPaintReadiness {
  readonly apiGeneration: number;
  readonly readyApiGeneration: number;
  readonly sceneGeneration: number;
  readonly hasEpoch: boolean;
}

/** Events from Excalidraw construction/readiness and SDK scene adoption. */
export type CanvasPaintEvent =
  | { readonly type: "api_registered"; readonly generation: number }
  | { readonly type: "api_ready"; readonly generation: number }
  | { readonly type: "scene_reset" }
  | { readonly type: "scene_changed" };

/** Empty state: neither an initialized Excalidraw instance nor a canonical epoch exists. */
export const INITIAL_CANVAS_PAINT_READINESS: CanvasPaintReadiness = {
  apiGeneration: 0,
  readyApiGeneration: 0,
  sceneGeneration: 0,
  hasEpoch: false,
};

/**
 * Advances readiness without performing I/O. API registration and actual readiness are
 * separate because Excalidraw exposes its imperative API from the class constructor, before
 * its asynchronous empty-scene initialization has finished.
 */
export function advanceCanvasPaintReadiness(
  state: CanvasPaintReadiness,
  event: CanvasPaintEvent,
): CanvasPaintReadiness {
  switch (event.type) {
    case "api_registered":
      if (event.generation <= state.apiGeneration) return state;
      return { ...state, apiGeneration: event.generation };
    case "api_ready":
      if (event.generation < state.apiGeneration || event.generation === state.readyApiGeneration) {
        return state;
      }
      return {
        ...state,
        apiGeneration: Math.max(state.apiGeneration, event.generation),
        readyApiGeneration: event.generation,
      };
    case "scene_reset":
      return {
        ...state,
        hasEpoch: true,
        sceneGeneration: state.sceneGeneration + 1,
      };
    case "scene_changed":
      return { ...state, sceneGeneration: state.sceneGeneration + 1 };
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}

/** True only when the latest registered API finished initialization and an SDK epoch exists. */
export function canPaintCanvas(state: CanvasPaintReadiness): boolean {
  return (
    state.apiGeneration > 0 &&
    state.readyApiGeneration === state.apiGeneration &&
    state.hasEpoch &&
    state.sceneGeneration > 0
  );
}
