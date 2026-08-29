import { ROOT_TILE_ID, type TileLayout, type TileNode } from "@manifold/protocol";
import { Fragment, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { dividerRatios, type DividerDrag } from "./tile-snap.ts";

/**
 * THE tile tree. A composition's layout is one recursive structure, so there is one
 * component that draws it — the fullscreen route and a container widget sitting on a
 * canvas render the same splits, the same ratio dividers and the same leaf frames from
 * the same code. A widget used to carry a parallel read-only mini-tree; it does not
 * any more, which is why an engaged widget's dividers drag exactly as fullscreen's do.
 *
 * What a host renderer still owns is the LEAF (`renderLeaf`) — a leaf's chrome is
 * discipline-specific (fullscreen leaves wear drop targets and a carry grip, a widget's
 * wear the engagement shield) — and the two policy answers this component takes as
 * arguments:
 *
 *   `classes`     which class family the boxes wear, because both skins are proof
 *                 hooks: `.tiled-*` for the route, `.flow-portal__*` for the widget.
 *   `interactive` whether a divider is a control or just structure. A watching widget
 *                 paints from a spectator socket whose writes the server refuses, so
 *                 its dividers render (the composition's shape is the information) and
 *                 do nothing: no pointer capture, no cursor, no doc write.
 *
 * There is deliberately no `scale` argument even though a widget draws its tree under a
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
}

/** The fullscreen route's skin. */
export const TILED_TREE_CLASSES: TileTreeClasses = {
  split: "tiled-split",
  pane: "tiled-pane",
  divider: "tiled-divider",
};

/** A container widget's skin, on a canvas. */
export const PORTAL_TREE_CLASSES: TileTreeClasses = {
  split: "flow-portal__split",
  pane: "flow-portal__slot",
  divider: "flow-portal__divider",
};

export interface TileTreeProps {
  readonly layout: TileLayout;
  /** Where to start; recursion passes the child id. Defaults to the tree's root. */
  readonly tileId?: string;
  readonly classes: TileTreeClasses;
  /** False renders dividers as structure only — see the module note. */
  readonly interactive: boolean;
  readonly onRatios: (splitId: string, ratios: readonly number[]) => void;
  readonly renderLeaf: (node: TileNode) => ReactNode;
}

/**
 * One node of the tree: a leaf hands off to the host, a split recurses. The structure —
 * never the ratios — decides React identity, so a divider drag is a style mutation on
 * boxes React already owns: no leaf unmounts and no xterm is reparented (which would
 * destroy the terminal).
 */
export function TileTree({
  layout,
  tileId = ROOT_TILE_ID,
  classes,
  interactive,
  onRatios,
  renderLeaf,
}: TileTreeProps): ReactNode {
  const node = layout[tileId];
  if (node === undefined) return null;
  if (node.dir === null) return renderLeaf(node);
  return (
    <TileSplit
      node={node}
      classes={classes}
      interactive={interactive}
      onRatios={onRatios}
      renderChild={(childId) => (
        <TileTree
          layout={layout}
          tileId={childId}
          classes={classes}
          interactive={interactive}
          onRatios={onRatios}
          renderLeaf={renderLeaf}
        />
      )}
    />
  );
}

interface TileSplitProps {
  readonly node: TileNode;
  readonly classes: TileTreeClasses;
  readonly interactive: boolean;
  readonly renderChild: (tileId: string) => ReactNode;
  readonly onRatios: (splitId: string, ratios: readonly number[]) => void;
}

/**
 * One split. Children are laid out with `flex-grow`, so a ratio change is a style
 * mutation on boxes React already owns.
 */
function TileSplit({ node, classes, interactive, renderChild, onRatios }: TileSplitProps) {
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
    // Stopped so the surface HOLDING this tree cannot claim the press: on a canvas a
    // widget's ancestors would otherwise start a node drag or a selection under it.
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

  return (
    <div className={`${classes.split} is-${node.dir ?? "leaf"}`} ref={boxRef}>
      {node.children.map((childId, index) => (
        // Keyed by tile id, never by position: removing a leaf must not shift its
        // siblings onto each other's keys, which would tear down live terminals.
        <Fragment key={childId}>
          {index === 0 ? null : (
            <div
              className={interactive ? classes.divider : `${classes.divider} is-inert`}
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
                : {})}
            />
          )}
          <div className={classes.pane} style={{ flexGrow: node.ratios[index] ?? 1 }}>
            {renderChild(childId)}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
