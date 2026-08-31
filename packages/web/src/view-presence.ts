/**
 * This device's VIEW STATE, published (AXIOMS.md A2 — floor, `"until": "core.presence"`).
 *
 * Which tool a principal is holding, what it is editing, which container has its focus and
 * whether its sidebar is collapsed used to live in component state and `localStorage`: a
 * capability no other principal — human or agent — could observe or drive. It is now one
 * module-level store whose value rides the presence plane, because it dies with the
 * connection and nobody merges it (D6).
 *
 * A store rather than a context on purpose: the writers are scattered across chrome that
 * shares no ancestor (a toolbar in the canvas, a text editor inside a node, the workspace
 * sidebar in another tree), and every one of them writes the SAME per-principal state. One
 * door, and presence writers merge {@link currentViewState} into their outgoing payload so a
 * reconnect republishes it without a second send path.
 */

/** The published view state of this device. Absent facets are `null`, never missing. */
export interface ViewState {
  /** Tool id the viewer is holding: a floor tool (`select`, `text`) or a contributed one. */
  readonly tool: string | null;
  /** Element being text-edited right now. */
  readonly editingElementId: string | null;
  /** Container whose tile the viewer has engaged. */
  readonly focusedContainerId: string | null;
  readonly sidebarCollapsed: boolean;
}

const INITIAL: ViewState = {
  tool: null,
  editingElementId: null,
  focusedContainerId: null,
  sidebarCollapsed: false,
};

let state: ViewState = INITIAL;
const listeners = new Set<(view: ViewState) => void>();

export function currentViewState(): ViewState {
  return state;
}

/**
 * Merges a patch and notifies subscribers — ONLY when something actually changed, because
 * every notification is a presence frame and chrome re-renders write the same value often
 * (a toolbar re-render re-asserting "select" must not put a frame on the wire).
 */
export function setViewState(patch: Partial<ViewState>): void {
  const next: ViewState = { ...state, ...patch };
  if (
    next.tool === state.tool &&
    next.editingElementId === state.editingElementId &&
    next.focusedContainerId === state.focusedContainerId &&
    next.sidebarCollapsed === state.sidebarCollapsed
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener(state);
}

/** Subscribes to changes; the callback is NOT invoked with the current value. */
export function subscribeViewState(callback: (view: ViewState) => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
