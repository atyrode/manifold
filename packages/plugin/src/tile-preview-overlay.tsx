import { ROOT_TILE_ID, type CarryAim, type PlacementRef, type TileRef } from "@manifold/protocol";
import { withoutTileLeaf } from "@manifold/scene";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ControlIcon, ItemIcon } from "@manifold/ui";
import type { TileDropSignal, TileDropStore } from "./tile-drop-store.ts";
import { areaUnits, type TileDropPipeline, type TileDropState } from "./use-tile-drop.ts";
import { paneShifts, type PaneShift } from "./tile-geometry.ts";
import { projectTileMotion, resetTileMotion } from "./tile-tree.tsx";
import { carriedSnapshot, subscribeCarry } from "./item-envelope.ts";
import type { GestureOverride } from "./presence/remote-gestures.ts";

/**
 * The live split preview. Subscribes to the host's drop store — the ONLY consumer of
 * the per-frame pointer — renders the landing slot, and drives the FLIP: the REAL panes
 * glide and squeeze into their prospective places while only the slot is a ghost.
 *
 * It owns no pipeline. The host creates exactly one {@link TileDropPipeline} and passes
 * it in, because the pipeline's memo is also its hysteresis state: a second instance for
 * the same area would hold a second zone, and the aim a release commits could be one
 * transition ahead of the aim the eye was shown.
 *
 * Its entire local-vs-remote logic is ARBITRATION — choosing which producer's
 * `(aim, ref, label)` triple enters the builder. Everything after that reads one
 * {@link TileDropState} and cannot ask who produced it: the slot, the cues, the caption,
 * the denial and the pane motion are one implementation, so a collaborator's view of a
 * drag is the dragger's view by construction rather than by matching two code paths.
 *
 * The motion is written imperatively as `transform` on the boxes `TileTree` already
 * owns, never through React state, so the tree does not re-render and no xterm is
 * touched. `transform` changes no layout box: the `ResizeObserver` in
 * `@manifold-plugin/terminals/web` observes the terminal's own container (a descendant),
 * never fires, so `fit()` never runs and no `resizeTerminal` reaches the real PTY —
 * transform-not-reflow is the protection, and it covers the fullscreen route's
 * controller socket too. Percentage translate resolves against the element's OWN box,
 * which is the `from` rect, so the numbers are scale-invariant: correct under the
 * portal's `scale(0.5)` and any canvas zoom without knowing either.
 */
/** The already-arbitrated source carry; no transport or producer identity enters motion. */
export interface TileDeparture {
  readonly ref: PlacementRef;
  readonly aim?: CarryAim | undefined;
  /** A known refusal restores the source just like cancellation. */
  readonly denied?: boolean | undefined;
}

/** Source arbitration is independent of target arbitration: an absent aim still departs. */
export function useTileDeparture(
  containerId: string,
  overrides: Iterable<GestureOverride>,
): TileDeparture | null {
  const local = useSyncExternalStore(subscribeCarry, carriedSnapshot, carriedSnapshot);
  if (local?.ref.kind === "tile" && local.ref.containerId === containerId) return local;
  let freshest: GestureOverride | null = null;
  for (const override of overrides) {
    const source = override.carry?.ref;
    if (override.kind !== "carry" || source?.kind !== "tile" || source.containerId !== containerId)
      continue;
    if (freshest === null || override.updatedAt > freshest.updatedAt) freshest = override;
  }
  return freshest?.carry ?? null;
}

export interface TilePreviewOverlayProps {
  /** The host's one pipeline: aim resolution, the shared builder, its memo. */
  readonly drop: TileDropPipeline;
  readonly store: TileDropStore;
  /** Names the displaced occupant in a replace caption; the host answers from its doc. */
  readonly refLabel: (ref: TileRef) => string | null;
  /** Active source carry, including while its aim is elsewhere or absent. Clear on end/expiry. */
  readonly departure?: TileDeparture | null | undefined;
}

const CARRIED_AWAY_CLASS = "is-carried-away";
const NO_SHIFTS: readonly PaneShift[] = [];

interface PreviewMotion {
  readonly transform: string;
  readonly faded: boolean;
}

/** The DOM box a shift moves: the pane the CURRENT tree drew for that tile. */
function paneElement(
  area: HTMLElement,
  fromTileId: string,
  singleLeaf: boolean,
): HTMLElement | null {
  const match = area.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(fromTileId)}"]`);
  const pane = match ?? (singleLeaf ? area.firstElementChild : null);
  if (!(pane instanceof HTMLElement)) return null;
  // Only leaves move. A nested split and its descendants must never both transform.
  for (let index = 0; index < pane.children.length; index += 1) {
    const child = pane.children[index];
    if (child instanceof HTMLElement && child.classList.contains("tile-content-host")) return child;
  }
  // A host may draw a contentless card before it has a tree; preserve that root prospect.
  return singleLeaf && match === null ? pane : null;
}

export function TilePreviewOverlay({
  drop,
  store,
  refLabel,
  departure,
}: TilePreviewOverlayProps): ReactNode {
  const signal: TileDropSignal = useSyncExternalStore(store.subscribe, store.get, store.get);
  const host = drop.host;
  const [motion] = useState(() => new Map<HTMLElement, PreviewMotion>());
  /** The last real state, so a gap (divider, own leaf) fades instead of popping. */
  const [held, setHeld] = useState<TileDropState | null>(null);
  /** Re-renders this overlay alone when the pointer's freshness window elapses. */
  const [, wake] = useReducer((tick: number) => tick + 1, 0);

  /*
    ARMED, WITH A BACKSTOP. A non-null pointer is the transport saying "a gesture is over
    this area"; `pointerFreshness` is the store saying it heard that recently enough to
    still be true. The bound is the one peers already apply to an aim, so a stationary
    drag stops previewing here at the same moment it stops previewing for everybody else
    instead of the dragger alone keeping a preview their collaborators lost.
  */
  const remaining = store.pointerFreshness();
  const armed =
    signal.pointer !== null &&
    remaining !== null &&
    remaining > 0 &&
    (host.portal === null || signal.armedElementId === host.portal.elementId);
  const local =
    armed && signal.pointer !== null
      ? drop.aimAt(signal.pointer.clientX, signal.pointer.clientY)
      : null;
  // Render-phase derived state (the documented previous-value pattern): `aimAt`
  // memoizes per zone, so this settles after one immediate re-render.
  if (local !== null && local !== held) setHeld(local);
  if (!armed && held !== null) setHeld(null);

  /*
    ARBITRATION, and nothing else: this browser's pointer outranks a peer's carry while
    it is armed over this area, and otherwise the freshest peer aim FOR THIS CONTAINER
    wins. Both triples enter the same builder, so the two cannot disagree about geometry,
    legality or wording — if they ever did it would be a kernel bug, not a rendering
    difference. An agent driving a carry through the SDK lands here as a peer does.
  */
  const remote = signal.remote.get(host.containerId) ?? null;
  const remoteState =
    armed || remote === null ? null : drop.previewOf(remote.aim, remote, remote.label);
  /** THE live answer for whichever input owns this area right now. */
  const live = local ?? remoteState;
  /** What is painted: the live answer, or the last one while a gap passes through. */
  const shown = local ?? (armed ? held : null) ?? remoteState;
  /**
   * A held fallback, not the live answer — a pointer sitting in a gap (a divider, its
   * own leaf). Asked as "is this still the answer", never as "who made it", so the cue
   * cannot start meaning "a peer made it" the way the old formulation did.
   */
  const stale = shown !== null && shown !== live;
  /** Arbitration's outcome as a style-free marker on the slot, and nothing more. */
  const isRemote = shown !== null && shown === remoteState;
  const departingTileId =
    live === null &&
    departure?.denied !== true &&
    departure?.ref.kind === "tile" &&
    departure.ref.containerId === host.containerId &&
    departure.aim?.containerId !== host.containerId
      ? departure.ref.tileId
      : null;
  const swapsSource = departure?.aim?.action === "swap";
  const departureShifts = useMemo(() => {
    const area = host.areaRef.current;
    if (departingTileId === null || swapsSource || host.layout === null || area === null)
      return NO_SHIFTS;
    const units = areaUnits(area, host.dividerPx);
    const next = withoutTileLeaf(host.layout, departingTileId);
    return units === null || next === null
      ? NO_SHIFTS
      : paneShifts(host.layout, next, units.dividers);
  }, [departingTileId, swapsSource, host.layout, host.areaRef, host.dividerPx]);

  /*
    Publish the resolved aim back to the store: the SINGLE source of both what a release
    commits and what rides the carry wire, so no transport builds an aim beside the one
    painted here. ONLY the armed overlay writes: a canvas holds one overlay per portal,
    and an unarmed one publishing its null would clobber the armed answer — and ping-pong
    the store into an endless notify loop. Disarming is the TRANSPORT's write
    (`clearCompose` / the arm losing its element), never ours. The dependency list is
    what keeps that loop structurally impossible rather than value-equality's job alone.
  */
  useEffect(() => {
    if (!armed) return;
    store.set({
      ...store.get(),
      aim: local === null ? null : { destination: local.destination, tile: local.aim },
    });
  }, [armed, local, store]);

  useEffect(() => {
    if (!armed) drop.clear();
  }, [armed, drop]);

  /*
    THE BACKSTOP'S CLOCK. Everything else here is driven by the store, and a leaked
    pointer is by definition the case where the store goes quiet — so the disarm needs a
    wake-up of its own or it never happens. One timer, re-armed by every frame that
    refreshes the stamp (so it never fires under a live drag) and disarmed with the
    overlay (so a cleared pointer schedules nothing).
  */
  useEffect(() => {
    if (!armed || remaining === null) return;
    const timer = setTimeout(wake, Math.max(remaining, 1));
    return () => {
      clearTimeout(timer);
    };
  }, [armed, remaining]);

  // Arbitration is finished. Incoming and departing projections use exactly the same
  // leaf geometry and motion owner; neither moves layout boxes or fits a live PTY.
  useLayoutEffect(() => {
    const area = host.areaRef.current;
    if (area === null) return;
    const denied = live?.assessment?.denial != null;
    const carriedTileId = denied ? null : (live?.carriedTileId ?? departingTileId);
    const shifts = denied ? NO_SHIFTS : (live?.shifts ?? departureShifts);
    const singleLeaf = host.layout === null || host.layout[ROOT_TILE_ID]?.dir === null;
    const next = new Map<HTMLElement, PreviewMotion>();
    area.classList.toggle("is-previewing", shown !== null || carriedTileId !== null);
    for (const shift of shifts) {
      const element = paneElement(area, shift.fromTileId, singleLeaf);
      if (element === null) continue;
      const dx = ((shift.to.x - shift.from.x) / shift.from.width) * 100;
      const dy = ((shift.to.y - shift.from.y) / shift.from.height) * 100;
      const sx = shift.to.width / shift.from.width;
      const sy = shift.to.height / shift.from.height;
      next.set(element, {
        transform: `translate(${String(dx)}%, ${String(dy)}%) scale(${String(sx)}, ${String(sy)})`,
        faded: false,
      });
    }
    if (carriedTileId !== null) {
      const carried = paneElement(area, carriedTileId, singleLeaf);
      if (carried !== null) next.set(carried, { transform: "", faded: true });
    }
    for (const element of motion.keys()) {
      if (next.has(element)) continue;
      element.parentElement?.classList.remove(CARRIED_AWAY_CLASS);
      if (element.isConnected) projectTileMotion(element, "", false);
      else resetTileMotion(element);
    }
    motion.clear();
    for (const [element, projection] of next) {
      projectTileMotion(element, projection.transform, projection.faded);
      element.parentElement?.classList.toggle(CARRIED_AWAY_CLASS, projection.faded);
      motion.set(element, projection);
    }
  }, [host.areaRef, host.layout, shown, live, departingTileId, departureShifts, motion]);

  useLayoutEffect(() => {
    const area = host.areaRef.current;
    return () => {
      for (const element of motion.keys()) {
        resetTileMotion(element);
        element.parentElement?.classList.remove(CARRIED_AWAY_CLASS);
      }
      motion.clear();
      area?.classList.remove("is-previewing");
    };
  }, [host.areaRef, motion]);

  if (shown === null) return null;

  const denied = shown.assessment?.denial != null;
  const swapping = shown.aim.action === "swap" && !denied;
  const replacing = shown.aim.action === "replace" && !denied;
  const displaced =
    replacing && host.layout !== null ? (host.layout[shown.aim.tileId]?.ref ?? null) : null;
  /*
    ONE class computation for the slot AND its swap partner. They are two halves of one
    trade, so a branch that could restyle one and not the other is a defect waiting for
    a new cue: `is-partner` is the only difference either box is allowed to have.
    `is-remote` is a style-free semantic marker driven purely by the arbitration outcome.
  */
  const slotClass = [
    "tile-preview",
    swapping ? "is-swap" : "",
    replacing ? "is-replace" : "",
    denied ? "is-denied" : "",
    stale ? "is-idle" : "",
    isRemote ? "is-remote" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const rectStyle = (rect: typeof shown.slot) => ({
    left: `${String(rect.x * 100)}%`,
    top: `${String(rect.y * 100)}%`,
    width: `${String(rect.width * 100)}%`,
    height: `${String(rect.height * 100)}%`,
  });

  return (
    <>
      <div className={slotClass} aria-hidden="true" style={rectStyle(shown.slot)}>
        {swapping ? (
          <span className="tile-preview__glyph">
            <ControlIcon kind="swap" size={28} />
          </span>
        ) : replacing ? (
          <span className="tile-preview__glyph">
            <ControlIcon kind="park" size={28} />
            {displaced === null ? null : (
              <span className="tile-preview__caption">
                {refLabel(displaced) ?? "this tile"} moves out
              </span>
            )}
          </span>
        ) : shown.chip === null || denied ? null : (
          <span className="tile-preview__glyph">
            <ItemIcon kind={shown.chip.kind} size={14} />
            <span className="tile-preview__caption">{shown.chip.label}</span>
          </span>
        )}
        {denied && shown.assessment?.message != null ? (
          <span className="drop-denial-note">{shown.assessment.message}</span>
        ) : null}
      </div>
      {shown.partner === null ? null : (
        <div
          className={`${slotClass} is-partner`}
          aria-hidden="true"
          style={rectStyle(shown.partner)}
        >
          <span className="tile-preview__glyph">
            <ControlIcon kind="swap" size={28} />
          </span>
        </div>
      )}
    </>
  );
}
