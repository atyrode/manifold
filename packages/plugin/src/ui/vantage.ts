import { useSyncExternalStore } from "react";

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
  /**
   * ARRANGE MODE (F8): the parts of ONE arrangement are grabbable within their parent, and
   * everything else has stopped taking pointer input.
   *
   * A MODE, and published for exactly the reason the rest of this store is: a collaborator
   * watching a principal whose terminals suddenly ignore clicks is owed the reason, and an
   * agent driving the mode is owed a way to read it back. It is descriptive — the
   * arrangement it produces commits through `core.space.setLayout`, which is where the
   * authority lives; nothing downstream branches on WHOSE mode it is (invariant 11).
   */
  readonly arranging: boolean;
  /**
   * WHICH ARRANGEMENT the mode is standing in, as a panel ref. `null` is the ROOT scope: the
   * grabbable things are the workspace's own panels. A ref names the panel whose OWN children
   * are grabbable instead — the one panel that declared an inner arrangement in its manifest
   * (`contributes.panels[].arranges`) and that the reader zoomed into.
   *
   * ONE SCOPE AT A TIME, which is why this is a ref and not a set: an arrangement is a place
   * you are standing, and two places at once is not a vantage. Every renderer — the floor's
   * panel grips, a panel's own row grips — decides what it offers by READING this value
   * against its own ref, so the scope is data on the presence plane and never a flag some
   * component kept privately (invariant 11).
   *
   * It rides here rather than beside `arranging` as a boolean per arrangeable thing because
   * the floor may not enumerate arrangements: a panel PUBLISHES that it has one, and a scope
   * is then just its address.
   */
  readonly arrangeScope: string | null;
}

const INITIAL: Vantage = {
  tool: null,
  editingElementId: null,
  focusedContainerId: null,
  sidebarCollapsed: false,
  arranging: false,
  arrangeScope: null,
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
    next.sidebarCollapsed === state.sidebarCollapsed &&
    next.arranging === state.arranging &&
    next.arrangeScope === state.arrangeScope
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

/**
 * THE toggle of arrange mode. It is a function rather than a `setVantage` call at each caller
 * because the mode has more than one entrance — the F8 binding, the Escape exit, and any
 * affordance a later wave adds — and "read the flag, write its negation" is the kind of
 * two-step that grows a second answer the moment it is written twice (invariant 14).
 *
 * F8 IS THE WHOLE-MODE KEY, in both directions: it arms the mode at the ROOT scope and it
 * leaves from wherever you are standing. So the scope is cleared on every press rather than
 * only on the way out — arming while a stale ref sat here would drop a reader into somebody
 * else's inner arrangement (Escape is the key that pops one level; see the workspace host).
 */
export function toggleArranging(): void {
  setVantage({ arranging: !state.arranging, arrangeScope: null });
}

/**
 * This device's vantage, as a React value. Floor chrome and plugin chrome both need to
 * RENDER the mode they publish — a pane that stops taking clicks, a section that grows a
 * grip — and `useSyncExternalStore` is how a module store becomes a render input without
 * an effect mirroring it into component state.
 */
export function useVantage(): Vantage {
  return useSyncExternalStore(subscribeVantage, currentVantage, currentVantage);
}
