/**
 * This device's VIEW STATE, published (AXIOMS.md A2).
 *
 * Which tool a principal is holding, what it is editing, which container has its focus and
 * whether its sidebar is collapsed used to live in component state and `localStorage`: a
 * capability no other principal — human or agent — could observe or drive. It is now one
 * module-level store whose value rides the presence plane, because it dies with the
 * connection and nobody merges it (D6).
 *
 * ENGINE MECHANISM, not presence's own: `core.presence` owns putting this on the wire, but the
 * writers are chrome that has nothing to do with presence — a canvas toolbar, a text editor
 * inside a node, the workspace sidebar, a terminal viewer taking focus — and no two of them
 * may import each other. A store two parties who cannot name each other both have to address
 * is the definition of a mechanism, so it lives in the engine's standard library and the
 * presence plugin merges {@link currentVantage} into its outgoing payload.
 *
 * A store rather than a context on purpose: the writers share no ancestor, and every one of
 * them writes the SAME per-principal state. One door, and a reconnect republishes it without a
 * second send path.
 */

/** The published view state of this device. Absent facets are `null`, never missing. */
export interface Vantage {
  /** Tool id the viewer is holding: a floor tool (`select`, `text`) or a contributed one. */
  readonly tool: string | null;
  /** Element being text-edited right now. */
  readonly editingElementId: string | null;
  /** Container whose tile the viewer has engaged. */
  readonly focusedContainerId: string | null;
  readonly sidebarCollapsed: boolean;
}

const INITIAL: Vantage = {
  tool: null,
  editingElementId: null,
  focusedContainerId: null,
  sidebarCollapsed: false,
};

let state: Vantage = INITIAL;
const listeners = new Set<(view: Vantage) => void>();

export function currentVantage(): Vantage {
  return state;
}

/**
 * Merges a patch and notifies subscribers — ONLY when something actually changed, because
 * every notification is a presence frame and chrome re-renders write the same value often
 * (a toolbar re-render re-asserting "select" must not put a frame on the wire).
 */
export function setVantage(patch: Partial<Vantage>): void {
  const next: Vantage = { ...state, ...patch };
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
export function subscribeVantage(callback: (view: Vantage) => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
