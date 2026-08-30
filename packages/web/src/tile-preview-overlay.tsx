import { ROOT_TILE_ID, type TileSurface } from "@manifold/protocol";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { ControlIcon, SurfaceIcon } from "./icons.tsx";
import type { TileDropSignal, TileDropStore } from "./tile-drop-store.ts";
import type { TileDropPipeline, TileDropState } from "./use-tile-drop.ts";

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
 * `(aim, surface, label)` triple enters the builder. Everything after that reads one
 * {@link TileDropState} and cannot ask who produced it: the slot, the cues, the caption,
 * the denial and the pane motion are one implementation, so a collaborator's view of a
 * drag is the dragger's view by construction rather than by matching two code paths.
 *
 * The motion is written imperatively as `transform` on the boxes `TileTree` already
 * owns, never through React state, so the tree does not re-render and no xterm is
 * touched. `transform` changes no layout box: the `ResizeObserver` in
 * `terminal-view.tsx` observes the terminal's own container (a descendant), never
 * fires, so `fit()` never runs and no `resizeTerminal` reaches the real PTY —
 * transform-not-reflow is the protection, and it covers the fullscreen route's
 * controller socket too. Percentage translate resolves against the element's OWN box,
 * which is the `from` rect, so the numbers are scale-invariant: correct under the
 * widget's `scale(0.5)` and any canvas zoom without knowing either.
 */
export interface TilePreviewOverlayProps {
  /** The host's one pipeline: aim resolution, the shared builder, its memo. */
  readonly drop: TileDropPipeline;
  readonly store: TileDropStore;
  /** Names the displaced occupant in a replace caption; the host answers from its doc. */
  readonly surfaceLabel: (surface: TileSurface) => string | null;
}

/** The class a carried item wears while its carry has an armed target (see styles.css). */
const CARRIED_AWAY_CLASS = "is-carried-away";

/** Everything this overlay wrote onto the tree, so disarm can undo it exactly. */
interface PreviewMotion {
  /** Boxes carrying a FLIP transform. */
  readonly shifted: HTMLElement[];
  /** Boxes wearing the ease-away class. */
  readonly faded: HTMLElement[];
}

function clearMotion(motion: PreviewMotion): void {
  for (const element of motion.shifted) {
    element.style.transform = "";
    element.style.transformOrigin = "";
  }
  motion.shifted.length = 0;
  for (const element of motion.faded) element.classList.remove(CARRIED_AWAY_CLASS);
  motion.faded.length = 0;
}

/** The DOM box a shift moves: the pane the CURRENT tree drew for that tile. */
function paneElement(
  area: HTMLElement,
  fromTileId: string,
  singleLeaf: boolean,
): HTMLElement | null {
  const match = area.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(fromTileId)}"]`);
  if (match !== null) return match;
  // A single-leaf tree renders no pane box; the tree's root element stands in for it.
  if (!singleLeaf) return null;
  const first = area.firstElementChild;
  return first instanceof HTMLElement ? first : null;
}

export function TilePreviewOverlay({
  drop,
  store,
  surfaceLabel,
}: TilePreviewOverlayProps): ReactNode {
  const signal: TileDropSignal = useSyncExternalStore(store.subscribe, store.get, store.get);
  const host = drop.host;
  const motionRef = useRef<PreviewMotion>({ shifted: [], faded: [] });
  /** The last real state, so a gap (divider, own leaf) fades instead of popping. */
  const [held, setHeld] = useState<TileDropState | null>(null);

  const armed =
    signal.pointer !== null &&
    (host.widget === null || signal.armedElementId === host.widget.elementId);
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
    armed || remote === null ? null : drop.previewOf(remote.aim, remote.surface, remote.label);
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

  /*
    Publish the resolved aim back to the store: the SINGLE source of both what a release
    commits and what rides the carry wire, so no transport builds an aim beside the one
    painted here. ONLY the armed overlay writes: a canvas holds one overlay per widget,
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

  // The FLIP itself: written imperatively so the tree never re-renders. Nothing moves
  // when the drop is denied, because nothing will move on release — and that guard now
  // serves a peer's refused aim too, since a viewer judges the peer's own surface.
  useEffect(() => {
    const area = host.areaRef.current;
    const motion = motionRef.current;
    clearMotion(motion);
    if (area === null) return;
    area.classList.toggle("is-previewing", shown !== null);
    if (live === null) return;
    const singleLeaf = host.layout === null || host.layout[ROOT_TILE_ID]?.dir === null;
    /*
      The item IN HAND eases away while its carry holds an armed target, exactly as the
      canvas fades the node a dragger is holding — the fade belongs to the carry, not to
      being the dragger, so one rule serves your own tile drag and a peer's alike. Armed
      is armed: a denied target still fades, because the canvas door does the same.
    */
    if (live.carriedTileId !== null) {
      const carried = paneElement(area, live.carriedTileId, singleLeaf);
      if (carried !== null) {
        carried.classList.add(CARRIED_AWAY_CLASS);
        motion.faded.push(carried);
      }
    }
    if (live.assessment?.denial != null) return;
    for (const shift of live.shifts) {
      const element = paneElement(area, shift.fromTileId, singleLeaf);
      if (element === null) continue;
      const dx = ((shift.to.x - shift.from.x) / shift.from.width) * 100;
      const dy = ((shift.to.y - shift.from.y) / shift.from.height) * 100;
      const sx = shift.to.width / shift.from.width;
      const sy = shift.to.height / shift.from.height;
      element.style.transformOrigin = "0 0";
      element.style.transform = `translate(${String(dx)}%, ${String(dy)}%) scale(${String(sx)}, ${String(sy)})`;
      motion.shifted.push(element);
    }
  }, [host.areaRef, host.layout, shown, live]);

  // Disarm and unmount both leave the tree exactly as the doc says it is.
  useEffect(() => {
    const motion = motionRef.current;
    const area = host.areaRef.current;
    return () => {
      clearMotion(motion);
      area?.classList.remove("is-previewing");
    };
  }, [host.areaRef]);

  if (shown === null) return null;

  const denied = shown.assessment?.denial != null;
  const swapping = shown.aim.action === "swap" && !denied;
  const replacing = shown.aim.action === "replace" && !denied;
  const displaced =
    replacing && host.layout !== null ? (host.layout[shown.aim.tileId]?.surface ?? null) : null;
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
                {surfaceLabel(displaced) ?? "this tile"} moves out
              </span>
            )}
          </span>
        ) : shown.chip === null || denied ? null : (
          <span className="tile-preview__glyph">
            <SurfaceIcon kind={shown.chip.kind} size={14} />
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
