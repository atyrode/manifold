import { ROOT_TILE_ID, type TileLayout, type Tile } from "@manifold/protocol";
import {
  Component,
  Fragment,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { FLIP_EPSILON, prefersReducedMotion } from "@manifold/ui";
import { refKey } from "./tile-geometry.ts";
import { dividerRatios, type DividerDrag } from "./tile-snap.ts";

/**
 * One tile tree for workspace, composition and portal skins; hosts supply leaf chrome
 * and interactivity. Inert spectators neither capture pointers nor write ratios.
 * Divider frames call `onRatios`; release/cancel calls `onRatiosCommit` once if moved.
 * Document hosts stream frames; action hosts preview locally and commit at release.
 *
 * Structural edits rebuild keyed boxes, never leaf content: stable portals keyed by
 * ref identity are seated by TileMotionBoundary. Terminals keep their DOM and buffers
 * across splits (scripts/verify-tile-drop.ts proves this with its remount probe).
 * Divider delta and bounding-box size both use client space, so ratios are scale-invariant.
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
  /** `.portal-divider` shares the route's native `0.35rem` geometry. */
  dividerPx: 5.6,
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
  readonly onRatiosCommit?: () => void;
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

interface TileVisual {
  readonly rect: DOMRect;
  readonly opacity: string;
}

const tileAnimations = new WeakMap<HTMLElement, Animation>();
let timingStyle: CSSStyleDeclaration | null = null;

/** Parse the public CSS shorthand with the browser, not a second timing vocabulary. */
function tileTiming(element: HTMLElement, fading = false): KeyframeAnimationOptions {
  const value = getComputedStyle(element)
    .getPropertyValue(fading ? "--carry-fade-transition" : "--preview-pane-transition")
    .trim();
  timingStyle ??= element.ownerDocument.createElement("div").style;
  timingStyle.transition = "";
  timingStyle.transition = fading ? value : `transform ${value}`;
  const duration = timingStyle.transitionDuration;
  const delay = timingStyle.transitionDelay;
  return {
    duration: (Number.parseFloat(duration) || 0) * (duration.endsWith("ms") ? 1 : 1000),
    delay: (Number.parseFloat(delay) || 0) * (delay.endsWith("ms") ? 1 : 1000),
    easing: timingStyle.transitionTimingFunction || "linear",
  };
}

function tileVisual(element: HTMLElement): TileVisual {
  return { rect: element.getBoundingClientRect(), opacity: getComputedStyle(element).opacity };
}

/** One owner for preview, cancellation and committed settlement; never stack transforms. */
export function resetTileMotion(element: HTMLElement): void {
  tileAnimations.get(element)?.cancel();
  tileAnimations.delete(element);
  element.style.transform = "";
  element.style.transformOrigin = "";
  element.style.opacity = "";
}

function playTileMotion(
  element: HTMLElement,
  first: TileVisual,
  transform: string,
  opacity: string,
): void {
  resetTileMotion(element);
  const last = element.getBoundingClientRect();
  element.style.transformOrigin = "0 0";
  element.style.transform = transform;
  element.style.opacity = opacity;
  if (
    prefersReducedMotion() ||
    last.width <= 0 ||
    last.height <= 0 ||
    typeof element.animate !== "function"
  )
    return;
  const dx = (first.rect.x - last.x) / last.width;
  const dy = (first.rect.y - last.y) / last.height;
  const sx = first.rect.width / last.width;
  const sy = first.rect.height / last.height;
  const from = `translate(${String(dx * 100)}%, ${String(dy * 100)}%) scale(${String(sx)}, ${String(sy)})`;
  const stationary =
    Math.abs(first.rect.x - last.x) < FLIP_EPSILON &&
    Math.abs(first.rect.y - last.y) < FLIP_EPSILON &&
    Math.abs(first.rect.width - last.width) < FLIP_EPSILON &&
    Math.abs(first.rect.height - last.height) < FLIP_EPSILON;
  if (transform === "" && stationary && first.opacity === (opacity || "1")) return;
  const animation = element.animate(
    [
      { transform: from, opacity: first.opacity },
      { transform: transform || "none", opacity: opacity || "1" },
    ],
    tileTiming(element, transform === "" && stationary),
  );
  tileAnimations.set(element, animation);
  animation.onfinish = () => {
    if (tileAnimations.get(element) === animation) tileAnimations.delete(element);
  };
}

/** Internal bridge used by the single live preview, on the same stable boxes as settlement. */
export function projectTileMotion(element: HTMLElement, transform: string, faded: boolean): void {
  const opacity = faded ? "var(--carry-fade-opacity)" : "";
  if (element.style.transform === transform && element.style.opacity === opacity) return;
  playTileMotion(element, tileVisual(element), transform, opacity);
}

interface KeyedTile {
  readonly node: Tile;
  readonly key: string;
}

interface TileMotionProps {
  readonly layout: TileLayout;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly hosts: Map<string, HTMLDivElement>;
  readonly keyed: readonly KeyedTile[];
  readonly children: ReactNode;
}

interface TileSnapshot {
  readonly area: HTMLElement;
  readonly areaRect: DOMRect;
  readonly tiles: ReadonlyMap<string, TileVisual>;
}

/**
 * React's pre-mutation snapshot is essential here: a layout-effect cleanup is too late
 * after a split removed its old boxes. Only geometry survives; live content stays in its
 * original stable host and is seated by the existing portal mechanism exactly once.
 */
class TileMotionBoundary extends Component<
  TileMotionProps,
  Record<string, never>,
  TileSnapshot | null
> {
  private readonly shells = new Map<HTMLElement, Animation>();
  private reduced: MediaQueryList | null = null;

  private readonly finishMotion = (): void => {
    if (!this.reduced?.matches) return;
    for (const host of this.props.hosts.values()) {
      tileAnimations.get(host)?.cancel();
      tileAnimations.delete(host);
    }
    for (const [shell, animation] of this.shells) {
      animation.cancel();
      shell.remove();
    }
    this.shells.clear();
  };

  private seat(): void {
    const { rootRef, hosts, keyed } = this.props;
    const root = rootRef.current;
    const live = new Set(keyed.map((entry) => entry.key));
    for (const [key, host] of hosts) {
      if (live.has(key)) continue;
      resetTileMotion(host);
      host.remove();
      hosts.delete(key);
    }
    if (root === null) return;
    for (const { node, key } of keyed) {
      const host = hosts.get(key);
      if (host === undefined) continue;
      const box =
        root.getAttribute("data-tile-id") === node.id
          ? root
          : root.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(node.id)}"]`);
      if (box !== null && host.parentElement !== box) box.appendChild(host);
    }
  }

  override componentDidMount(): void {
    this.seat();
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced.addEventListener("change", this.finishMotion);
  }

  override getSnapshotBeforeUpdate(previous: TileMotionProps): TileSnapshot | null {
    if (previous.layout === this.props.layout) return null;
    const area = previous.rootRef.current?.parentElement;
    if (area === null || area === undefined) return null;
    const tiles = new Map<string, TileVisual>();
    for (const { key } of previous.keyed) {
      const host = previous.hosts.get(key);
      if (host?.isConnected) tiles.set(key, tileVisual(host));
    }
    return { area, areaRect: area.getBoundingClientRect(), tiles };
  }

  override componentDidUpdate(
    _previous: TileMotionProps,
    _state: Record<string, never>,
    first: TileSnapshot | null,
  ): void {
    this.seat();
    if (first === null) return;
    // Clear all projections before Last, never measure a pane through a preview ancestor.
    for (const host of this.props.hosts.values()) resetTileMotion(host);
    for (const { key } of this.props.keyed) {
      const host = this.props.hosts.get(key);
      const before = first.tiles.get(key);
      if (host !== undefined && before !== undefined) playTileMotion(host, before, "", "");
    }
    if (
      prefersReducedMotion() ||
      !first.area.isConnected ||
      first.areaRect.width <= 0 ||
      first.areaRect.height <= 0 ||
      typeof first.area.animate !== "function"
    )
      return;
    for (const [key, before] of first.tiles) {
      if (this.props.hosts.has(key)) continue;
      // A bounded empty shell, never a clone of a live terminal/canvas or its descendants.
      const shell = document.createElement("div");
      shell.className = "tile-departure-shell";
      shell.setAttribute("aria-hidden", "true");
      shell.style.left = `${String(((before.rect.x - first.areaRect.x) / first.areaRect.width) * 100)}%`;
      shell.style.top = `${String(((before.rect.y - first.areaRect.y) / first.areaRect.height) * 100)}%`;
      shell.style.width = `${String((before.rect.width / first.areaRect.width) * 100)}%`;
      shell.style.height = `${String((before.rect.height / first.areaRect.height) * 100)}%`;
      first.area.appendChild(shell);
      const animation = shell.animate(
        [
          { opacity: before.opacity, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.96)" },
        ],
        tileTiming(shell),
      );
      this.shells.set(shell, animation);
      animation.onfinish = () => {
        shell.remove();
        this.shells.delete(shell);
      };
    }
  }

  override componentWillUnmount(): void {
    this.reduced?.removeEventListener("change", this.finishMotion);
    for (const host of this.props.hosts.values()) resetTileMotion(host);
    for (const [shell, animation] of this.shells) {
      animation.cancel();
      shell.remove();
    }
    this.shells.clear();
  }

  override render(): ReactNode {
    return this.props.children;
  }
}

export function TileTree({
  layout,
  classes,
  interactive,
  onRatios,
  onRatiosCommit,
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
        onRatiosCommit={onRatiosCommit}
        renderChild={renderChild}
        vacant={vacant}
      />
    );
  };

  const root = layout[ROOT_TILE_ID];
  return (
    <TileMotionBoundary layout={layout} rootRef={rootRef} hosts={hosts} keyed={keyed}>
      {root === undefined ? null : root.dir === null ? (
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
          onRatiosCommit={onRatiosCommit}
          renderChild={renderChild}
          attachRoot={attachRoot}
          vacant={vacant}
        />
      )}
      {keyed.map(({ node, key }) => createPortal(renderLeaf(node), hostFor(key), key))}
    </TileMotionBoundary>
  );
}

interface TileSplitProps {
  readonly node: Tile;
  readonly classes: TileTreeClasses;
  readonly interactive: boolean;
  readonly renderChild: (tileId: string) => ReactNode;
  readonly onRatios: (splitId: string, ratios: readonly number[]) => void;
  readonly onRatiosCommit: TileTreeProps["onRatiosCommit"];
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
  onRatiosCommit,
  attachRoot,
  vacant,
}: TileSplitProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<(DividerDrag & { pointerId: number; changed: boolean }) | null>(null);
  const row = node.dir === "row";

  const beginDrag = (index: number, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || dragRef.current !== null) return;
    const box = boxRef.current;
    if (box === null) return;
    const bounds = box.getBoundingClientRect();
    const sizePx = row ? bounds.width : bounds.height;
    if (sizePx <= 0) return;
    let total = 0;
    for (const ratio of node.ratios) total += ratio;
    dragRef.current = {
      pointerId: event.pointerId,
      changed: false,
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
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const next = dividerRatios(drag, row ? event.clientX : event.clientY);
    // `dividerRatios` hands back the same array when the drag is pinned; skipping the
    // write there keeps a stalled drag from spamming the doc with no-op updates.
    if (next !== drag.ratios) {
      drag.changed = true;
      onRatios(node.id, next);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.changed) onRatiosCommit?.();
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
              {...(empty ? { "data-vacant": "true" } : { style: { flexGrow: growFor(index) } })}
            >
              {renderChild(childId)}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
