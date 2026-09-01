import { ROOT_TILE_ID, type TileLayout, type Tile } from "@manifold/protocol";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { refKey } from "../tile-geometry.ts";
import { dividerRatios, type DividerDrag } from "../tile-snap.ts";

/**
 * THE tile tree. A composition's layout is one recursive structure, so there is one
 * component that draws it — the fullscreen route and a container portal sitting on a
 * canvas render the same splits, the same ratio dividers and the same leaf frames from
 * the same code. A portal used to carry a parallel read-only mini-tree; it does not
 * any more, which is why an engaged portal's dividers drag exactly as fullscreen's do.
 *
 * What a host renderer still owns is the LEAF (`renderLeaf`) — a leaf's chrome is
 * discipline-specific (fullscreen leaves wear the carry grip, a portal's wear the
 * engagement shield) — and the two policy answers this component takes as arguments:
 *
 *   `classes`     which class family the boxes wear, because both skins are proof
 *                 hooks: `.composition-*` for the route, `.portal__*` for the portal.
 *   `interactive` whether a divider is a control or just structure. A watching portal
 *                 paints from a spectator socket whose writes the server refuses, so
 *                 its dividers render (the composition's shape is the information) and
 *                 do nothing: no pointer capture, no cursor, no doc write.
 *
 * PANE CONTENT SURVIVES STRUCTURAL EDITS. The recursive boxes are keyed by tile id,
 * and a split substitutes a NEW wrapper id into its parent's children — so React
 * discards and rebuilds boxes across a committed split. That must never tear down an
 * xterm, so a leaf's content is not rendered inside its box at all: each occupied
 * leaf's content renders exactly once through `createPortal` into a STABLE host
 * element keyed by REF IDENTITY (`refKey`), and a layout effect appends that
 * host into whatever box the current tree drew (the `appendChild` move flexlayout and
 * dockview use). React never sees the move; the terminal's DOM, buffer and scrollback
 * ride along untouched. Confirmed by `scripts/verify-tile-drop.ts`'s remount probe.
 *
 * There is deliberately no `scale` argument even though a portal draws its tree under a
 * `transform: scale()` (and under the canvas's own zoom). A divider drag is computed as
 * `pointer delta / box size`, and `getBoundingClientRect()` reports the box already
 * transformed, so both terms live in client space and the fraction is scale-invariant.
 */

/** The class family one host paints its tree with; every box the tree owns is here. */
export interface TileTreeClasses {
  /** The flex box of a split. Gets `is-row` / `is-column` for its direction. */
  readonly split: string;
  /** One child's box inside a split; carries the stored ratio as `flex-grow`. */
  readonly pane: string;
  /** The grab band between two panes. Gets `is-inert` when not interactive. */
  readonly divider: string;
  /**
   * One divider's thickness in this skin's own layout px — the flex-basis its
   * stylesheet declares — so drop geometry subtracts exactly what the tree draws.
   */
  readonly dividerPx: number;
}

/** The fullscreen route's skin. */
export const COMPOSITION_TREE_CLASSES: TileTreeClasses = {
  split: "composition-split",
  pane: "composition-pane",
  divider: "composition-divider",
  /** `.composition-divider` is `flex: 0 0 0.35rem` = 5.6px at the root font size. */
  dividerPx: 5.6,
};

/** A container portal's skin, on a canvas. */
export const PORTAL_TREE_CLASSES: TileTreeClasses = {
  split: "portal-split",
  pane: "portal__slot",
  divider: "portal-divider",
  /** `.portal-divider` is `flex: 0 0 0.7rem` = 11.2px at the root font size. */
  dividerPx: 11.2,
};

/**
 * The WORKSPACE's own skin. The shell is a composition too (D2): a principal's layout is a
 * tile tree whose leaves are plugin panels, drawn by this same component — so the sidebar
 * and the container view are panes and the seam between them is an ordinary divider, not a
 * bespoke resize handle. Third skin, same shape as the two above; nothing about the tree's
 * drag, seam or ratio behaviour differs here.
 */
export const WORKSPACE_TREE_CLASSES: TileTreeClasses = {
  split: "workspace-split",
  pane: "workspace-pane",
  divider: "workspace-divider",
  /** `.workspace-divider` is `flex: 0 0 0.35rem` = 5.6px at the root font size. */
  dividerPx: 5.6,
};

export interface TileTreeProps {
  readonly layout: TileLayout;
  readonly classes: TileTreeClasses;
  /** False renders dividers as structure only — see the module note. */
  readonly interactive: boolean;
  readonly onRatios: (splitId: string, ratios: readonly number[]) => void;
  readonly renderLeaf: (node: Tile) => ReactNode;
}

/** Leaves in tree order, so duplicate-ref suffixes stay stable across renders. */
function leafNodesInOrder(layout: TileLayout): readonly Tile[] {
  const out: Tile[] = [];
  const walk = (tileId: string): void => {
    const node = layout[tileId];
    if (node === undefined) return;
    if (node.dir === null) {
      out.push(node);
      return;
    }
    for (const childId of node.children) walk(childId);
  };
  walk(ROOT_TILE_ID);
  return out;
}

/**
 * WHICH SUBTREES HOLD NOTHING, by tile id. A leaf is vacant when its `ref` is null, and a
 * split is vacant when every one of its children is — so a stack the palette just dropped
 * (issue #104: two vacant seats, deliberately) is one vacant box rather than three.
 *
 * It is a DOM fact the tree publishes (`is-vacant`, `data-vacant`) rather than a layout
 * decision taken here, because who may take up room is not the tree's call: the same
 * vacant split must be an invisible nothing to a reader working, a targetable seat to a
 * reader arranging, and a targetable seat to anyone mid-drag. The stylesheet that owns the
 * skin owns that answer; this only says which boxes it is about.
 */
function vacantTiles(layout: TileLayout): ReadonlySet<string> {
  const vacant = new Set<string>();
  const walk = (tileId: string): boolean => {
    const node = layout[tileId];
    if (node === undefined) return false;
    const empty =
      node.dir === null
        ? node.ref === null
        : node.children.map(walk).every((childEmpty) => childEmpty);
    if (empty) vacant.add(tileId);
    return empty;
  };
  walk(ROOT_TILE_ID);
  return vacant;
}

export function TileTree({
  layout,
  classes,
  interactive,
  onRatios,
  renderLeaf,
}: TileTreeProps): ReactNode {
  /** The outermost box the structure pass drew; content targeting is scoped to it. */
  const rootRef = useRef<HTMLElement | null>(null);
  /** Stable content hosts by ref identity; created once, MOVED between boxes. */
  const [hosts] = useState(() => new Map<string, HTMLDivElement>());

  const seen = new Map<string, number>();
  const keyed = leafNodesInOrder(layout).map((node) => {
    // An empty leaf has no identity to follow; its (contentless) hint may remount.
    const base = refKey(node.ref) ?? `empty:${node.id}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    return { node, key: nth === 0 ? base : `${base}#${String(nth)}` };
  });

  // Created during render because `createPortal` needs its container immediately;
  // idempotent, and the element stays detached until the layout effect seats it.
  const hostFor = (key: string): HTMLDivElement => {
    const existing = hosts.get(key);
    if (existing !== undefined) return existing;
    const host = document.createElement("div");
    host.className = "tile-content-host";
    hosts.set(key, host);
    return host;
  };

  // Seat every content host in the box the CURRENT tree drew for its leaf, and drop
  // hosts whose content React already unmounted (their key left the portal list).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const live = new Set(keyed.map((entry) => entry.key));
    for (const [key, host] of hosts) {
      if (!live.has(key)) {
        host.remove();
        hosts.delete(key);
      }
    }
    for (const { node, key } of keyed) {
      const host = hosts.get(key);
      if (host === undefined) continue;
      const box =
        root.getAttribute("data-tile-id") === node.id
          ? root
          : root.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(node.id)}"]`);
      if (box !== null && host.parentElement !== box) box.appendChild(host);
    }
  });

  const attachRoot = (element: HTMLElement | null): void => {
    rootRef.current = element;
  };

  const vacant = vacantTiles(layout);

  const renderChild = (childId: string): ReactNode => {
    const child = layout[childId];
    // A leaf child renders nothing HERE: its pane box is the seat its stable
    // content host is appended into.
    if (child === undefined || child.dir === null) return null;
    return (
      <TileSplit
        node={child}
        classes={classes}
        interactive={interactive}
        onRatios={onRatios}
        renderChild={renderChild}
        vacant={vacant}
      />
    );
  };

  const root = layout[ROOT_TILE_ID];
  if (root === undefined) return null;
  return (
    <>
      {root.dir === null ? (
        // A single-leaf tree draws one full-size pane box for the root itself.
        <div
          className={classes.pane}
          data-tile-id={ROOT_TILE_ID}
          style={{ flexGrow: 1 }}
          ref={attachRoot}
        />
      ) : (
        <TileSplit
          node={root}
          classes={classes}
          interactive={interactive}
          onRatios={onRatios}
          renderChild={renderChild}
          attachRoot={attachRoot}
          vacant={vacant}
        />
      )}
      {keyed.map(({ node, key }) => createPortal(renderLeaf(node), hostFor(key), key))}
    </>
  );
}

interface TileSplitProps {
  readonly node: Tile;
  readonly classes: TileTreeClasses;
  readonly interactive: boolean;
  readonly renderChild: (tileId: string) => ReactNode;
  readonly onRatios: (splitId: string, ratios: readonly number[]) => void;
  /** Set only on the tree's outermost split, for the content-seating scope. */
  readonly attachRoot?: (element: HTMLElement | null) => void;
  /** Which tile ids hold no occupant anywhere under them; see {@link vacantTiles}. */
  readonly vacant: ReadonlySet<string>;
}

/**
 * One split. Children are laid out with `flex-grow`, so a ratio change is a style
 * mutation on boxes React already owns.
 */
function TileSplit({
  node,
  classes,
  interactive,
  renderChild,
  onRatios,
  attachRoot,
  vacant,
}: TileSplitProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** Live divider state; kept in a ref so a drag never re-renders the terminals it moves. */
  const dragRef = useRef<DividerDrag | null>(null);
  const row = node.dir === "row";

  const beginDrag = (index: number, event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = boxRef.current;
    if (box === null) return;
    const bounds = box.getBoundingClientRect();
    const sizePx = row ? bounds.width : bounds.height;
    if (sizePx <= 0) return;
    let total = 0;
    for (const ratio of node.ratios) total += ratio;
    dragRef.current = {
      index,
      originPx: row ? event.clientX : event.clientY,
      sizePx,
      total,
      ratios: node.ratios,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    // Stopped so the ref HOLDING this tree cannot claim the press: on a canvas a
    // portal's ancestors would otherwise start a node drag or a selection under it.
    event.stopPropagation();
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const next = dividerRatios(drag, row ? event.clientX : event.clientY);
    // `dividerRatios` hands back the same array when the drag is pinned; skipping the
    // write there keeps a stalled drag from spamming the doc with no-op updates.
    if (next !== drag.ratios) onRatios(node.id, next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /*
    Ratios are RELATIVE, so the renderer must normalize them: flexbox only
    distributes the FULL free space when grow factors sum to at least 1, and a
    removal from an N-wide split legitimately leaves a sum below 1 (the departing
    child takes its ratio with it). Feeding raw ratios to flex-grow then leaves a
    dead, uninteractable band where the missing fraction was — while the drop
    kernel, which normalizes, keeps aiming at the full area. Normalizing here is
    what keeps the painted tree and the hit-tested tree the same tree.
  */
  let ratioTotal = 0;
  for (const ratio of node.ratios) {
    ratioTotal += Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  }
  const growFor = (index: number): number => {
    const ratio = node.ratios[index] ?? 0;
    const share = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
    return ratioTotal > 0 ? (share / ratioTotal) * node.children.length : 1;
  };

  return (
    <div
      className={`${classes.split} is-${node.dir ?? "leaf"}`}
      data-tile-id={node.id}
      ref={(element) => {
        boxRef.current = element;
        attachRoot?.(element);
      }}
    >
      {node.children.map((childId, index) => {
        /*
          A VACANT SUBTREE AND THE SEAM BEFORE IT TRAVEL TOGETHER. Collapsing the box while
          leaving its divider behind would leave a grab band floating in the middle of the
          content it no longer separates — so whatever the skin decides "vacant" looks like,
          it decides it for both at once.
        */
        const empty = vacant.has(childId);
        const mark = empty ? " is-vacant" : "";
        return (
          // Keyed by tile id, never by position: removing a leaf must not shift its
          // siblings onto each other's keys — and the CONTENT is immune either way,
          // seated by ref identity from the portal list above.
          <Fragment key={childId}>
            {index === 0 ? null : (
              <div
                className={`${classes.divider}${interactive ? "" : " is-inert"}${mark}`}
                role="separator"
                aria-orientation={row ? "vertical" : "horizontal"}
                aria-label="Resize tiles"
                {...(interactive
                  ? {
                      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) =>
                        beginDrag(index - 1, event),
                      onPointerMove: moveDrag,
                      onPointerUp: endDrag,
                      onPointerCancel: endDrag,
                    }
                  : {
                      // An inert seam looks identical to a live one minus the cursor —
                      // which reads as "resize broke", not "you are watching". Say so.
                      title: "Click a tile to work in this composition; dividers drag then",
                    })}
              />
            )}
            {/*
              A VACANT PANE CARRIES NO INLINE SHARE. Its ratio is real and is still stored,
              but WHETHER an empty subtree takes room is the skin's call and changes with the
              reader's mode — and an inline `flex-grow` outranks every stylesheet rule there
              is, so writing one here would nail the box open no matter what the sheet said.
            */}
            <div
              className={`${classes.pane}${mark}`}
              data-tile-id={childId}
              {...(empty
                ? { "data-vacant": "true" }
                : { style: { flexGrow: growFor(index) } })}
            >
              {renderChild(childId)}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
