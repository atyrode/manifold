import { ROOT_TILE_ID, type TileSurface } from "@manifold/protocol";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ControlIcon, SurfaceIcon } from "./icons.tsx";
import { envelopeSurface, type ItemEnvelope } from "./item-envelope.ts";
import type { TileDropSignal, TileDropStore } from "./tile-drop-store.ts";
import { tileProspect, type TileAim } from "./tile-geometry.ts";
import { useTileDrop, type TileDropHost, type TileDropState } from "./use-tile-drop.ts";

/**
 * The live split preview. Subscribes to the host's drop store — the ONLY consumer of
 * the per-frame pointer — resolves the aim, draws the landing slot, and drives the
 * FLIP: the REAL panes glide and squeeze into their prospective places while only the
 * slot is a ghost.
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
  readonly host: TileDropHost;
  readonly store: TileDropStore;
  /** Names the displaced occupant in a replace caption; the host answers from its doc. */
  readonly surfaceLabel: (surface: TileSurface) => string | null;
  /** Names the carried item on the slot chip; null hides the label. */
  readonly carryLabel?: (envelope: ItemEnvelope) => string | null;
  /** A carrier's presence color, so a peer's preview belongs to them like their cursor. */
  readonly carrierColor?: (principalId: string) => string;
}

function clearWritten(written: HTMLElement[]): void {
  for (const element of written) {
    element.style.transform = "";
    element.style.transformOrigin = "";
  }
  written.length = 0;
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
  host,
  store,
  surfaceLabel,
  carryLabel,
  carrierColor,
}: TilePreviewOverlayProps): ReactNode {
  const signal: TileDropSignal = useSyncExternalStore(store.subscribe, store.get, store.get);
  const drop = useTileDrop(host);
  const writtenRef = useRef<HTMLElement[]>([]);
  /** The last real state, so a gap (divider, own leaf) fades instead of popping. */
  const [held, setHeld] = useState<TileDropState | null>(null);

  const armed =
    signal.pointer !== null &&
    (host.widget === null || signal.armedElementId === host.widget.elementId);
  const state =
    armed && signal.pointer !== null
      ? drop.aimAt(signal.pointer.clientX, signal.pointer.clientY)
      : null;
  // Render-phase derived state (the documented previous-value pattern): `aimAt`
  // memoizes per zone, so this settles after one immediate re-render.
  if (state !== null && state !== held) setHeld(state);
  if (!armed && held !== null) setHeld(null);
  /*
    A PEER's armed aim, re-derived through the same kernel the local pointer uses —
    the whole point: one prospect computation, two producers. Local always outranks
    remote, purely as arbitration; if the two could ever disagree on geometry that
    would be a kernel bug, not a rendering difference. An agent driving a carry
    through the SDK lands here exactly like a human collaborator.
  */
  const remote = signal.remote;
  const remoteState = ((): TileDropState | null => {
    if (armed || remote === null || host.layout === null) return null;
    if (remote.aim.containerId !== host.containerId) return null;
    const aim: TileAim = {
      tileId: remote.aim.tileId,
      edge: remote.aim.edge,
      action: remote.aim.action,
      depth: 0,
      between: remote.aim.between === true,
    };
    const area = host.areaRef.current;
    const width = area === null || area.offsetWidth <= 0 ? 1 : area.offsetWidth;
    const height = area === null || area.offsetHeight <= 0 ? 1 : area.offsetHeight;
    const dividers = { x: host.dividerPx / width, y: host.dividerPx / height };
    const carriedTileId =
      remote.surface.kind === "tile" && remote.surface.containerId === host.containerId
        ? remote.surface.tileId
        : null;
    const prospect = tileProspect(host.layout, aim, carriedTileId, dividers);
    if (prospect === null) return null;
    return {
      aim,
      slot: prospect.slot,
      partner: prospect.partner,
      shifts: prospect.shifts,
      assessment: null,
      destination: { kind: "unplaced" },
      envelope: null,
    };
  })();
  const shown = state ?? (armed ? held : null) ?? remoteState;

  // Publish the resolved aim back to the store, so the transport commits exactly what
  // was previewed. ONLY the armed overlay writes: a canvas holds one overlay per
  // widget, and an unarmed one publishing its null would clobber the armed answer —
  // and ping-pong the store into an endless notify loop. Disarming is the
  // TRANSPORT's write (`clearCompose` / the arm losing its element), never ours.
  // `set` is value-equal, so re-notification of the same aim converges immediately.
  useEffect(() => {
    if (!armed) return;
    const current = store.get();
    store.set({
      ...current,
      aim:
        state === null
          ? null
          : { destination: state.destination, containerId: host.containerId, tile: state.aim },
    });
  });

  useEffect(() => {
    if (!armed) drop.clear();
  }, [armed, drop]);

  // The FLIP itself: written imperatively so the tree never re-renders. Nothing moves
  // when the drop is denied, because nothing will move on release. A peer's aim
  // glides the panes exactly like a local one — same shifts, same kernel.
  useEffect(() => {
    const area = host.areaRef.current;
    clearWritten(writtenRef.current);
    if (area === null) return;
    area.classList.toggle("is-previewing", shown !== null);
    const active = state ?? remoteState;
    if (active === null || active.assessment?.denial != null) return;
    const singleLeaf = host.layout?.[ROOT_TILE_ID]?.dir === null;
    for (const shift of active.shifts) {
      const element = paneElement(area, shift.fromTileId, singleLeaf);
      if (element === null) continue;
      const dx = ((shift.to.x - shift.from.x) / shift.from.width) * 100;
      const dy = ((shift.to.y - shift.from.y) / shift.from.height) * 100;
      const sx = shift.to.width / shift.from.width;
      const sy = shift.to.height / shift.from.height;
      element.style.transformOrigin = "0 0";
      element.style.transform = `translate(${String(dx)}%, ${String(dy)}%) scale(${String(sx)}, ${String(sy)})`;
      writtenRef.current.push(element);
    }
  }, [armed, host.areaRef, host.layout, shown, state, remoteState]);

  // Disarm and unmount both leave the tree exactly as the doc says it is.
  useEffect(() => {
    const written = writtenRef.current;
    const area = host.areaRef.current;
    return () => {
      clearWritten(written);
      area?.classList.remove("is-previewing");
    };
  }, [host.areaRef]);

  if (shown === null) return null;

  const isRemote = state === null && (armed ? held : null) === null && remoteState !== null;
  const denied = shown.assessment?.denial != null;
  const swapping = shown.aim.action === "swap" && !denied;
  const replacing = shown.aim.action === "replace" && !denied;
  const displaced =
    replacing && host.layout !== null ? (host.layout[shown.aim.tileId]?.surface ?? null) : null;
  const chipLabel = shown.envelope === null ? null : (carryLabel?.(shown.envelope) ?? null);
  const slotClass = [
    "tile-preview",
    swapping ? "is-swap" : "",
    replacing ? "is-replace" : "",
    denied ? "is-denied" : "",
    !isRemote && state === null ? "is-idle" : "",
    isRemote ? "is-remote" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const remoteTint =
    isRemote && remote !== null && carrierColor !== undefined
      ? carrierColor(remote.principalId)
      : null;
  const tintStyle: CSSProperties =
    remoteTint === null ? {} : ({ "--carrier-color": remoteTint } as CSSProperties);

  const rectStyle = (rect: typeof shown.slot) => ({
    left: `${String(rect.x * 100)}%`,
    top: `${String(rect.y * 100)}%`,
    width: `${String(rect.width * 100)}%`,
    height: `${String(rect.height * 100)}%`,
  });

  return (
    <>
      <div
        className={slotClass}
        aria-hidden="true"
        style={{ ...rectStyle(shown.slot), ...tintStyle }}
      >
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
        ) : isRemote && remote !== null ? (
          <span className="tile-preview__glyph">
            <SurfaceIcon kind={remote.surface.kind} size={14} />
            <span className="tile-preview__caption">{remote.label}</span>
          </span>
        ) : shown.envelope === null || denied ? null : (
          <span className="tile-preview__glyph">
            <SurfaceIcon kind={envelopeSurface(shown.envelope).kind} size={14} />
            {chipLabel === null ? null : <span className="tile-preview__caption">{chipLabel}</span>}
          </span>
        )}
        {denied && shown.assessment?.message != null ? (
          <span className="drop-denial-note">{shown.assessment.message}</span>
        ) : null}
      </div>
      {shown.partner === null ? null : (
        <div
          className="tile-preview is-swap is-partner"
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
