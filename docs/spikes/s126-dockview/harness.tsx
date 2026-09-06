/*
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  DISPOSABLE SPIKE — issue #126. NOT APPLICATION CODE. NOT IMPORTED BY ANY PACKAGE.   │
  │  Delete this whole directory once ADR 0021 is decided. See ./README.md.              │
  └──────────────────────────────────────────────────────────────────────────────────────┘

  A throwaway harness that renders ONE `TileLayout` fixture twice — once through our own
  `TileTree` (the control) and once through Dockview's `GridviewComponent` (the candidate) —
  then runs six probes against both DOMs and publishes the answers on `window.__SPIKE__`
  for `run.ts` to read. Every "measured" claim in ADR 0021 comes from here.

  WHY GRIDVIEW AND NOT DOCKVIEW. Our tree is a recursive row/column split of UNTABBED
  leaves. `DockviewComponent` is a grid of tab GROUPS; adopting it would introduce a
  group/tab concept the placement algebra does not have. `GridviewComponent` is the honest
  shape match — and its entire option surface
  (node_modules/dockview-core/dist/cjs/gridview/options.d.ts) is
  `{ disableAutoResizing, proportionalLayout, orientation, className, hideBorders }`:
  no dnd, no droptarget, no overlay. That asymmetry is itself a finding.
*/

import { ROOT_TILE_ID } from "../../../packages/protocol/src/index.ts";
import type { Tile, TileLayout } from "../../../packages/protocol/src/index.ts";
import {
  paneShifts,
  resolveTileAim,
  tileRects,
} from "../../../packages/plugin/src/tile-geometry.ts";
import type { TileAim } from "../../../packages/plugin/src/tile-geometry.ts";
import { releasedTileLayout } from "../../../packages/plugin/src/tile-release.ts";
import { projectSectionArrangement } from "../../../packages/plugin/src/layout.ts";
import { TileTree, COMPOSITION_TREE_CLASSES } from "../../../packages/plugin/src/tile-tree.tsx";

import { DockviewComponent, GridviewComponent, GridviewPanel, Orientation } from "dockview-core";
import type {
  GridPanelViewState,
  GridviewInitParameters,
  GroupPanelPartInitParameters,
  IContentRenderer,
  IFrameworkPart,
  Parameters as DockviewParameters,
  Position,
  SerializedGridObject,
  SerializedGridviewComponent,
} from "dockview-core";
import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/** The divider thickness `.composition-divider` declares, as `tile-tree.tsx` publishes it. */
const DIVIDER_PX = COMPOSITION_TREE_CLASSES.dividerPx;

/* ── The fixture ─────────────────────────────────────────────────────────────────────── */

function leaf(id: string, terminalId: string): Tile {
  return { id, dir: null, ratios: [], children: [], ref: { kind: "terminal", terminalId } };
}

/**
 * `A | (B / (C | D))` — the three-level shape `tile-geometry.test.ts` calls `deepLayout()`,
 * carrying the workspace's own 0.22/0.78 root ratio. Four leaves, three splits, one leaf
 * two levels down, so "can an ancestor split be addressed at all" is answerable.
 */
function fixture(): TileLayout {
  return {
    [ROOT_TILE_ID]: {
      id: ROOT_TILE_ID,
      dir: "row",
      ratios: [0.22, 0.78],
      children: ["tA", "tCol"],
      ref: null,
    },
    tA: leaf("tA", "A"),
    tCol: { id: "tCol", dir: "column", ratios: [0.4, 0.6], children: ["tB", "tRow"], ref: null },
    tB: leaf("tB", "B"),
    tRow: { id: "tRow", dir: "row", ratios: [0.5, 0.5], children: ["tC", "tD"], ref: null },
    tC: leaf("tC", "C"),
    tD: leaf("tD", "D"),
  };
}

/* ── The leaf renderer under test ────────────────────────────────────────────────────── */

/**
 * An xterm STAND-IN, and the whole point of probe 1. A live terminal is (a) a React
 * component whose mount is expensive, (b) uncontrolled DOM state nothing re-derives
 * (scrollback) and (c) a running animation loop. This has all three and reports its own
 * mount generation, so "did the renderer tear my leaf down" is a number, not an impression.
 */
const MOUNT_GENERATIONS = new Map<string, number>();

function LiveLeaf({ id, host }: { readonly id: string; readonly host: string }): ReactNode {
  const key = `${host}:${id}`;
  const [generation] = useState(() => {
    const next = (MOUNT_GENERATIONS.get(key) ?? 0) + 1;
    MOUNT_GENERATIONS.set(key, next);
    return next;
  });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // The "scrollback": uncontrolled DOM state written ONCE per DOM node. Still there
    // after a structural edit means the node survived; reset means it did not.
    const input = inputRef.current;
    if (input !== null && input.value === "") input.value = `scrollback-${key}`;
    let frame = 0;
    let ticks = 0;
    const tick = (): void => {
      ticks += 1;
      const box = boxRef.current;
      if (box !== null) box.dataset["ticks"] = String(ticks);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [key]);

  return (
    <div
      className="live-leaf"
      ref={boxRef}
      data-leaf={id}
      data-leaf-host={host}
      data-generation={String(generation)}
    >
      <span className="live-leaf__title">
        {host} · {id} · gen {generation}
      </span>
      <input className="live-leaf__state" ref={inputRef} readOnly />
    </div>
  );
}

/* ── Control: our own TileTree ───────────────────────────────────────────────────────── */

function ControlTree({ layout }: { readonly layout: TileLayout }): ReactNode {
  return (
    <div className="tile-area" data-area="ours">
      <TileTree
        layout={layout}
        classes={COMPOSITION_TREE_CLASSES}
        interactive
        onRatios={() => undefined}
        renderLeaf={(node) => (node.ref === null ? null : <LiveLeaf id={node.id} host="ours" />)}
      />
    </div>
  );
}

/* ── Candidate: the same tree through Dockview's GridviewComponent ───────────────────── */

/** Panel ids Dockview disposed, in order, so probe 1 can attribute a teardown. */
const DISPOSED: string[] = [];

/**
 * A `GridviewPanel` whose body is a React root rendering {@link LiveLeaf}. Dockview's own
 * React adapter (`dockview`'s `GridviewReact` -> `ReactPart`) does exactly this; doing it
 * by hand keeps the probe honest about WHOSE lifecycle tears the leaf down.
 */
class LeafPanel extends GridviewPanel {
  private root: Root | null = null;
  private tileId: string;

  constructor(id: string, component: string) {
    super(id, component);
    this.tileId = id;
    this.element.classList.add("dv-leaf");
  }

  protected override getComponent(): IFrameworkPart {
    this.element.dataset["tileId"] = this.tileId;
    const root = createRoot(this.element);
    this.root = root;
    root.render(createElement(LiveLeaf, { id: this.tileId, host: "dockview" }));
    return {
      update: (_params: DockviewParameters) => undefined,
      dispose: () => {
        DISPOSED.push(this.tileId);
        // Queued, because unmounting inside a Dockview dispose pass is a React warning.
        queueMicrotask(() => root.unmount());
        this.root = null;
      },
    };
  }

  override init(parameters: GridviewInitParameters): void {
    const declared = parameters.params["tileId"];
    if (typeof declared === "string") this.tileId = declared;
    super.init(parameters);
  }
}

/**
 * OUR RATIO TREE -> DOCKVIEW'S SERIALIZED GRID, and the px-math answer in one function.
 * Every `size` Dockview stores is a PIXEL count (`SerializedGridObject.size?: number`,
 * gridview/gridview.d.ts), and each level's `size` is measured along its PARENT's axis
 * while its children's sizes are measured along its own — the `(size, orthogonalSize)`
 * flip `Splitview.layout` is built on. So a ratio tree can only enter Dockview by
 * multiplying through a measured container box, on both axes, at every depth. Our own
 * renderer needs none of that: flexbox distributes `flex-grow`. This is math the swap
 * ADDS.
 */
function toSerializedGrid(
  layout: TileLayout,
  width: number,
  height: number,
): SerializedGridviewComponent {
  const node = (
    tileId: string,
    size: number,
    across: number,
  ): SerializedGridObject<GridPanelViewState> => {
    const tile = layout[tileId];
    if (tile === undefined) throw new Error(`no tile ${tileId}`);
    if (tile.dir === null) {
      return {
        type: "leaf",
        data: { id: tileId, component: "leaf", params: { tileId } },
        size,
      };
    }
    let total = 0;
    for (const ratio of tile.ratios) total += ratio > 0 ? ratio : 0;
    const free = Math.max(0, across - DIVIDER_PX * (tile.children.length - 1));
    const children = tile.children.map((childId, index) =>
      node(childId, (free * (tile.ratios[index] ?? 0)) / (total || 1), size),
    );
    return { type: "branch", data: children, size };
  };
  const root = layout[ROOT_TILE_ID];
  if (root === undefined || root.dir === null) throw new Error("fixture root must be a split");
  const rootRow = root.dir === "row";
  return {
    grid: {
      root: node(ROOT_TILE_ID, rootRow ? height : width, rootRow ? width : height),
      width,
      height,
      orientation: rootRow ? Orientation.HORIZONTAL : Orientation.VERTICAL,
    },
  };
}

function mountGrid(
  container: HTMLElement,
  layout: TileLayout,
  orientation: Orientation,
  width: number,
  height: number,
): GridviewComponent {
  const grid = new GridviewComponent(container, {
    orientation,
    proportionalLayout: true,
    createComponent: (options) => new LeafPanel(options.id, options.name),
  });
  grid.layout(width, height);
  grid.fromJSON(toSerializedGrid(layout, width, height));
  return grid;
}

/*
  ── THE DOCK, for the one question the grid cannot answer ────────────────────────────────

  `GridviewComponent` has no drag-and-drop at all, so the kill criterion has to be tried
  against Dockview's ACTUAL drop machinery, which lives on `DockviewComponent`. That
  imposes tab GROUPS; `hideHeader: true` is the closest thing to our untabbed pane. The
  `Droptarget` class is not a public export, but `group.model.contentDropTarget` is a
  public getter, and `Droptarget.showOverlay(position)` exists precisely to "render the
  drop overlay at `position` without a live drag, so keyboard docking shows the exact same
  preview as a mouse drag" (dnd/droptarget.d.ts). That is the vendor's best facility for
  painting a drag nobody local is performing, and it is what a remote carry would have to
  use. This mounts a dock so probe 7 can drive it.
*/
class ContentPanel implements IContentRenderer {
  readonly element: HTMLElement;
  private root: Root | null = null;

  constructor(private readonly tileId: string) {
    this.element = document.createElement("div");
    this.element.className = "dv-leaf";
    this.element.dataset["tileId"] = tileId;
  }

  init(_parameters: GroupPanelPartInitParameters): void {
    const root = createRoot(this.element);
    this.root = root;
    root.render(createElement(LiveLeaf, { id: this.tileId, host: "dock" }));
  }

  dispose(): void {
    DISPOSED.push(`dock:${this.tileId}`);
    const root = this.root;
    this.root = null;
    if (root !== null) queueMicrotask(() => root.unmount());
  }
}

function mountDock(container: HTMLElement, width: number, height: number): DockviewComponent {
  const dock = new DockviewComponent(container, {
    createComponent: (options) => new ContentPanel(options.id),
    disableDnd: false,
  });
  dock.layout(width, height);
  // The same fixture shape, expressed the only way a dock can express it: one group per
  // leaf, each split off its neighbour. Headers hidden, because our leaves have no tabs.
  dock.addPanel({ id: "tA", component: "leaf" });
  dock.addPanel({
    id: "tB",
    component: "leaf",
    position: { referencePanel: "tA", direction: "right" },
  });
  dock.addPanel({
    id: "tC",
    component: "leaf",
    position: { referencePanel: "tB", direction: "below" },
  });
  dock.addPanel({
    id: "tD",
    component: "leaf",
    position: { referencePanel: "tC", direction: "right" },
  });
  for (const group of dock.groups) group.model.header.hidden = true;
  return dock;
}

/* ── Probe helpers ───────────────────────────────────────────────────────────────────── */

interface LeafState {
  readonly generation: number;
  readonly state: string;
  readonly ticking: boolean;
}

function leafReport(host: string): Record<string, LeafState> {
  const out: Record<string, LeafState> = {};
  for (const element of document.querySelectorAll<HTMLElement>(`[data-leaf-host="${host}"]`)) {
    const id = element.dataset["leaf"] ?? "?";
    const input = element.querySelector("input");
    out[id] = {
      generation: Number(element.dataset["generation"] ?? "0"),
      state: input instanceof HTMLInputElement ? input.value : "",
      ticking: Number(element.dataset["ticks"] ?? "0") > 0,
    };
  }
  return out;
}

interface Addressability {
  readonly total: number;
  readonly found: number;
  readonly missing: readonly string[];
  readonly splitsAddressable: number;
  readonly splitsTotal: number;
}

/** Every tile id our preview overlay queries a DOM box for, and whether it has one. */
function addressability(layout: TileLayout, root: HTMLElement): Addressability {
  const found: string[] = [];
  const missing: string[] = [];
  for (const tileId of Object.keys(layout)) {
    const hit = root.querySelector(`[data-tile-id="${CSS.escape(tileId)}"]`);
    (hit === null ? missing : found).push(tileId);
  }
  const splits = Object.values(layout)
    .filter((tile) => tile.dir !== null)
    .map((tile) => tile.id);
  return {
    total: Object.keys(layout).length,
    found: found.length,
    missing,
    splitsAddressable: splits.filter((id) => !missing.includes(id)).length,
    splitsTotal: splits.length,
  };
}

interface BoxStyle {
  readonly className: string;
  readonly position: string;
  readonly transform: string;
  readonly left: string;
  readonly width: string;
  readonly flexGrow: string;
}

/** What the renderer itself writes on the boxes our FLIP wants to write `transform` on. */
function boxStyles(root: HTMLElement, selector: string): readonly BoxStyle[] {
  const out: BoxStyle[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector)).slice(0, 8)) {
    const computed = getComputedStyle(element);
    out.push({
      className: element.className,
      position: computed.position,
      transform: computed.transform,
      left: computed.left,
      width: computed.width,
      flexGrow: computed.flexGrow,
    });
  }
  return out;
}

/** Leaf extents as a fraction of the host box, so a resize compares like for like. */
function widthFractions(root: HTMLElement): Record<string, number> {
  const box = root.getBoundingClientRect();
  const out: Record<string, number> = {};
  for (const element of root.querySelectorAll<HTMLElement>("[data-leaf]")) {
    const id = element.dataset["leaf"] ?? "?";
    out[id] = Number((element.getBoundingClientRect().width / box.width).toFixed(4));
  }
  return out;
}

/* ── The published probe surface ─────────────────────────────────────────────────────── */

interface SpikeApi {
  readonly leaves: (host: string) => Record<string, LeafState>;
  readonly disposed: () => readonly string[];
  readonly splitOurs: () => unknown;
  readonly splitDockview: () => unknown;
  readonly addressability: () => unknown;
  readonly remotePreview: () => unknown;
  readonly paintFlip: () => unknown;
  readonly clearFlip: () => unknown;
  readonly flip: () => unknown;
  readonly resize: (width: number) => unknown;
  readonly rail: () => unknown;
  readonly zones: () => unknown;
  readonly dockOverlay: () => unknown;
}

declare global {
  interface Window {
    __SPIKE__?: SpikeApi;
  }
}

function Harness(): ReactNode {
  const [layout, setLayout] = useState<TileLayout>(fixture);
  const candidateHost = useRef<HTMLDivElement | null>(null);
  const dockHost = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState<GridviewComponent | null>(null);
  const [dock, setDock] = useState<DockviewComponent | null>(null);

  useEffect(() => {
    const host = candidateHost.current;
    if (host === null) return;
    const box = host.getBoundingClientRect();
    const mounted = mountGrid(host, fixture(), Orientation.HORIZONTAL, box.width, box.height);
    setGrid(mounted);
    return () => {
      mounted.dispose();
    };
  }, []);

  useEffect(() => {
    const host = dockHost.current;
    if (host === null) return;
    const box = host.getBoundingClientRect();
    const mounted = mountDock(host, box.width, box.height);
    setDock(mounted);
    return () => {
      mounted.dispose();
    };
  }, []);

  useEffect(() => {
    const dividers = { x: DIVIDER_PX / 900, y: DIVIDER_PX / 520 };
    /** `ROOT_RING_PX` over the harness pane's own box, per axis — what the app does. */
    const ring = { x: 20 / 900, y: 20 / 520 };

    window.__SPIKE__ = {
      leaves: leafReport,
      disposed: () => DISPOSED.slice(),

      /* PROBE 1a — a real structural edit on OUR renderer, through the real kernel. */
      splitOurs: () => {
        const rects = tileRects(layout, dividers);
        const target = rects.get("tD");
        if (target === undefined) return { error: "no tD rect" };
        const aim: TileAim | null = resolveTileAim(
          layout,
          { x: target.x + target.width * 0.9, y: target.y + target.height * 0.5 },
          { carriedTileId: null, holdsTileSeat: false },
          dividers,
          ring,
        );
        if (aim === null) return { error: "no aim" };
        const next = releasedTileLayout(
          layout,
          { kind: "structure", structure: { kind: "split", dir: "row" } },
          aim,
        );
        if (next === null) return { error: "release refused", aim };
        setLayout(next);
        return {
          aim,
          tilesBefore: Object.keys(layout).length,
          tilesAfter: Object.keys(next).length,
        };
      },

      /* PROBE 1b — the equivalent structural edit on Dockview's grid. */
      splitDockview: () => {
        if (grid === null) return { error: "no grid" };
        const before = grid.groups.map((panel) => panel.id);
        grid.addPanel({
          id: "tE",
          component: "leaf",
          params: { tileId: "tE" },
          position: { referencePanel: "tD", direction: "right" },
        });
        return { before, after: grid.groups.map((panel) => panel.id) };
      },

      /* PROBE 2 — which tile ids are addressable in each DOM. */
      addressability: () => {
        const ours = document.querySelector<HTMLElement>('[data-area="ours"]');
        const theirs = candidateHost.current;
        return {
          ours: ours === null ? null : addressability(layout, ours),
          dockview: theirs === null ? null : addressability(fixture(), theirs),
          dockviewClasses:
            theirs === null
              ? null
              : Array.from(
                  new Set(
                    Array.from(theirs.querySelectorAll<HTMLElement>("*"))
                      .map((element) => element.className)
                      .filter((name) => name !== ""),
                  ),
                ).slice(0, 20),
        };
      },

      /*
        PROBE 3a — THE KILL CRITERION, quantified. A collaborator's carry arrives as a wire
        aim with NO local pointer: `TilePreviewOverlay` calls `drop.previewOf(aim, ...)` and
        then, for every `PaneShift`, looks up `[data-tile-id="<shift.fromTileId>"]` and writes
        a `transform`. This asks the only question that matters: of the boxes that preview
        needs, how many does each renderer's DOM actually offer?

        Two consumers, two requirements, measured separately:
          shifts      — `paneShifts` pairs OCCUPIED LEAVES only (`paneIdentities` walks
                        leaves), so the FLIP needs one box per moving leaf.
          wireframe   — `arrange-overlay.tsx`'s `measureRects` iterates `Object.keys(layout)`
                        ("splits too") and outlines every split container while F8 is armed.
      */
      remotePreview: () => {
        const tree = fixture();
        // A ROOT-RING aim: the maximal case, where every pane on screen glides at once.
        const aim: TileAim = { tileId: ROOT_TILE_ID, edge: "left", action: "place", depth: 0 };
        const next = releasedTileLayout(
          tree,
          { kind: "structure", structure: { kind: "split", dir: "row" } },
          aim,
        );
        if (next === null) return { error: "release refused" };
        const shifts = paneShifts(tree, next, dividers);
        const ours = document.querySelector<HTMLElement>('[data-area="ours"]');
        const theirs = candidateHost.current;
        const resolve = (root: HTMLElement | null, ids: readonly string[]) => {
          if (root === null) return null;
          const found: string[] = [];
          const missing: string[] = [];
          for (const id of ids) {
            const hit = root.querySelector(`[data-tile-id="${CSS.escape(id)}"]`);
            (hit === null ? missing : found).push(id);
          }
          return { found: found.length, missing };
        };
        const shiftIds = shifts.map((shift) => shift.fromTileId);
        const wireframeIds = Object.keys(tree);
        return {
          aim,
          shiftCount: shifts.length,
          shiftIds,
          flipBoxes: { ours: resolve(ours, shiftIds), dockview: resolve(theirs, shiftIds) },
          wireframeBoxes: {
            ours: resolve(ours, wireframeIds),
            dockview: resolve(theirs, wireframeIds),
          },
          /*
            And the state a vacant seat is in. Our renderer publishes `data-vacant` on a
            subtree that holds nothing and the stylesheet gives it no room (issue #104): a
            seat that EXISTS in the tree and takes zero space until the mode is armed.
          */
          vacantMarkers:
            ours === null
              ? null
              : Array.from(ours.querySelectorAll<HTMLElement>("[data-vacant]")).map((element) => ({
                  tileId: element.dataset["tileId"] ?? null,
                  width: Math.round(element.getBoundingClientRect().width),
                })),
        };
      },

      /*
        PROBE 3b — PAINT THE COLLABORATOR PREVIEW, in both DOMs, for a screenshot. This is
        `tile-preview-overlay.tsx`'s effect body verbatim: for each `PaneShift`, find
        `[data-tile-id="<fromTileId>"]` and write the percentage translate + scale it writes,
        plus the landing slot as a percentage rect. Left on screen so the eye can judge it.
      */
      paintFlip: () => {
        const tree = fixture();
        const aim: TileAim = { tileId: ROOT_TILE_ID, edge: "left", action: "place", depth: 0 };
        const next = releasedTileLayout(
          tree,
          { kind: "structure", structure: { kind: "split", dir: "row" } },
          aim,
        );
        if (next === null) return { error: "release refused" };
        const shifts = paneShifts(tree, next, dividers);
        const painted: Record<string, unknown> = {};
        for (const [name, root] of [
          ["ours", document.querySelector<HTMLElement>('[data-area="ours"]')],
          ["dockview", candidateHost.current],
        ] as const) {
          if (root === null) continue;
          const clipped: string[] = [];
          const moved: string[] = [];
          const rootBox = root.getBoundingClientRect();
          for (const shift of shifts) {
            const box = root.querySelector<HTMLElement>(
              `[data-tile-id="${CSS.escape(shift.fromTileId)}"]`,
            );
            if (box === null) continue;
            const dx = ((shift.to.x - shift.from.x) / shift.from.width) * 100;
            const dy = ((shift.to.y - shift.from.y) / shift.from.height) * 100;
            const sx = shift.to.width / shift.from.width;
            const sy = shift.to.height / shift.from.height;
            box.style.transformOrigin = "0 0";
            box.style.transform = `translate(${String(dx)}%, ${String(dy)}%) scale(${String(sx)}, ${String(sy)})`;
            moved.push(shift.fromTileId);
            /*
              CLIPPING is the question a number can answer and the eye confirms. Dockview's
              `.dv-split-view-container` is `overflow: hidden` and its `.dv-view` is
              `overflow: auto`, so a pane whose prospective rect leaves its CURRENT split's
              box is cut off. Compare the transformed box against the intended rect.
            */
            const drawn = box.getBoundingClientRect();
            const wanted = {
              x: rootBox.x + shift.to.x * rootBox.width,
              width: shift.to.width * rootBox.width,
            };
            if (Math.abs(drawn.x - wanted.x) > 2 || Math.abs(drawn.width - wanted.width) > 2) {
              clipped.push(
                `${shift.fromTileId}: drew x=${String(Math.round(drawn.x))} w=${String(Math.round(drawn.width))}, wanted x=${String(Math.round(wanted.x))} w=${String(Math.round(wanted.width))}`,
              );
            }
          }
          // The landing slot, as the overlay paints it: a percentage rect over the area.
          const slotRect = tileRects(next, dividers).get(
            Object.keys(next).find((id) => next[id]?.dir === null && next[id]?.ref === null) ?? "",
          );
          if (slotRect !== undefined) {
            const slot = document.createElement("div");
            slot.className = "spike-slot";
            slot.style.cssText = [
              "position:absolute",
              `left:${String(slotRect.x * 100)}%`,
              `top:${String(slotRect.y * 100)}%`,
              `width:${String(slotRect.width * 100)}%`,
              `height:${String(slotRect.height * 100)}%`,
              "border:2px solid #4c6ef5",
              "background:rgba(76,110,245,0.18)",
              "pointer-events:none",
              "z-index:50",
            ].join(";");
            if (getComputedStyle(root).position === "static") root.style.position = "relative";
            root.appendChild(slot);
          }
          painted[name] = { moved, clipped, slotPainted: slotRect !== undefined };
        }
        return { shiftCount: shifts.length, painted };
      },

      /** Undoes {@link paintFlip} exactly, so the later probes see untouched trees. */
      clearFlip: () => {
        let cleared = 0;
        for (const box of document.querySelectorAll<HTMLElement>("[data-tile-id]")) {
          if (box.style.transform === "") continue;
          box.style.transform = "";
          box.style.transformOrigin = "";
          cleared += 1;
        }
        for (const slot of document.querySelectorAll(".spike-slot")) slot.remove();
        return { cleared };
      },

      /* PROBE 3 — does the FLIP survive Dockview's own layout pass? */
      flip: () => {
        const ours = document.querySelector<HTMLElement>('[data-area="ours"]');
        const theirs = candidateHost.current;
        const result: Record<string, unknown> = {
          ourBoxes: ours === null ? [] : boxStyles(ours, "[data-tile-id]"),
          dockviewBoxes: theirs === null ? [] : boxStyles(theirs, ".dv-view, .dv-branch-node"),
        };
        if (theirs !== null && grid !== null) {
          const victim = theirs.querySelector<HTMLElement>('[data-tile-id="tC"]');
          const view = victim?.closest<HTMLElement>(".dv-view") ?? victim;
          if (view !== null) {
            const before = getComputedStyle(view).transform;
            const rectBefore = view.getBoundingClientRect();
            view.style.transformOrigin = "0 0";
            view.style.transform = "translate(50%, 0%) scale(0.5, 1)";
            const rectAfterWrite = view.getBoundingClientRect();
            const box = theirs.getBoundingClientRect();
            grid.layout(box.width - 40, box.height);
            grid.layout(box.width, box.height);
            result["flipOnLeafView"] = {
              dockviewAlreadyOwnsTransform: before !== "none",
              beforeTransform: before,
              afterRelayoutInline: view.style.transform,
              moved: Math.abs(rectAfterWrite.x - rectBefore.x) > 1,
              widthBefore: Math.round(rectBefore.width),
              widthAfterWrite: Math.round(rectAfterWrite.width),
            };
            view.style.transform = "";
            view.style.transformOrigin = "";
          }
          // The branch node our `paneShifts` also returns shifts for.
          const branch = theirs.querySelector<HTMLElement>(".dv-branch-node");
          result["branchNodeIdentity"] = {
            exists: branch !== null,
            tileId: branch?.dataset["tileId"] ?? null,
            attributes: branch === null ? [] : branch.getAttributeNames(),
          };
        }
        return result;
      },

      /* PROBE 4 — proportion drift under a container resize. */
      resize: (width: number) => {
        for (const selector of [".pane--ours", ".pane--dockview"]) {
          const pane = document.querySelector<HTMLElement>(selector);
          if (pane !== null) pane.style.width = `${String(width)}px`;
        }
        const host = candidateHost.current;
        if (host !== null && grid !== null) {
          const box = host.getBoundingClientRect();
          grid.layout(box.width, box.height);
        }
        const ours = document.querySelector<HTMLElement>('[data-area="ours"]');
        return {
          width,
          ours: ours === null ? null : widthFractions(ours),
          dockview: host === null ? null : widthFractions(host),
        };
      },

      /*
        PROBE 5 — the RAIL's synthetic tree, fed to Dockview. The rail is a tile tree in
        disguise (`layout.ts`, `sidebar-panel.tsx`): a projection built per pointer frame,
        hit-tested, released, then thrown away. It has no DOM of its own and its unmeasured
        rows carry a deliberately sub-pixel extent. This asks what Dockview does with that.
      */
      rail: () => {
        /*
          Four rail rows: two the rail measured (`index` 180px, `machines` 120px) and two
          it did not paint, which take `UNPAINTED_EXTENT` (1e-4) — the projection's way of
          keeping a disabled plugin's row in the tree while making it untargetable (D4′).
          Extents are keyed by PATH, so `n0`..`n3`.
        */
        const RAIL_EXTENTS: Record<string, number> = { n0: 180, n1: 120 };
        const projection = projectSectionArrangement(
          ["index", "machines", "plugins", "keys"],
          (path) => RAIL_EXTENTS[path] ?? 0,
        );
        const host = document.createElement("div");
        host.style.cssText = "position:absolute;left:-9999px;top:0;width:260px;height:600px";
        document.body.appendChild(host);
        const asked: Record<string, number> = {};
        for (const [tileId, rect] of tileRects(projection.layout, { x: 0, y: 0 })) {
          if (projection.layout[tileId]?.dir === null) {
            asked[tileId] = Number((rect.height * 600).toFixed(4));
          }
        }
        let error: string | null = null;
        const got: Record<string, number> = {};
        const minimums: Record<string, number> = {};
        try {
          const railGrid = mountGrid(host, projection.layout, Orientation.VERTICAL, 260, 600);
          for (const panel of railGrid.groups) {
            got[panel.id] = Number(panel.element.getBoundingClientRect().height.toFixed(2));
            minimums[panel.id] = panel.minimumHeight;
          }
          railGrid.dispose();
        } catch (thrown) {
          error = thrown instanceof Error ? thrown.message : String(thrown);
        }
        host.remove();
        return {
          tileIds: Object.keys(projection.layout),
          pathOf: Object.fromEntries(projection.pathOf),
          asked,
          got,
          minimums,
          error,
        };
      },

      /*
        PROBE 6 — the two zone vocabularies, counted over the SAME pointer field. Ours is
        `resolveTileAim`. Dockview's is one of five positions against whichever LEAF cell
        the pointer is inside, because a branch node has no drop target — so no ancestor
        split is addressable and there is no between-seam outcome at all.
      */
      zones: () => {
        const tree = fixture();
        const rects = tileRects(tree, dividers);
        const ours = new Set<string>();
        const theirs = new Set<string>();
        const STEPS = 80;
        for (let ix = 0; ix <= STEPS; ix += 1) {
          for (let iy = 0; iy <= STEPS; iy += 1) {
            const point = { x: ix / STEPS, y: iy / STEPS };
            const aim = resolveTileAim(
              tree,
              point,
              { carriedTileId: "tA", holdsTileSeat: true },
              dividers,
              ring,
            );
            if (aim !== null) {
              ours.add(
                [
                  aim.tileId,
                  aim.edge,
                  aim.action,
                  String(aim.depth),
                  String(aim.between === true),
                ].join("|"),
              );
            }
            for (const [tileId, rect] of rects) {
              if (tree[tileId]?.dir !== null) continue;
              const inside =
                point.x >= rect.x &&
                point.x <= rect.x + rect.width &&
                point.y >= rect.y &&
                point.y <= rect.y + rect.height;
              if (!inside) continue;
              const fx = (point.x - rect.x) / rect.width;
              const fy = (point.y - rect.y) / rect.height;
              const quadrant =
                fx < 0.2
                  ? "left"
                  : fx > 0.8
                    ? "right"
                    : fy < 0.2
                      ? "top"
                      : fy > 0.8
                        ? "bottom"
                        : "center";
              theirs.add(`${tileId}|${quadrant}`);
            }
          }
        }
        const ourKeys = Array.from(ours);
        return {
          ourDistinctOutcomes: ours.size,
          ourSample: ourKeys.slice(0, 10),
          ourActions: Array.from(new Set(ourKeys.map((key) => key.split("|")[2] ?? ""))),
          ourAncestorAims: ourKeys.filter((key) => {
            const tileId = key.split("|")[0] ?? "";
            return tree[tileId]?.dir !== null;
          }).length,
          ourBetweenAims: ourKeys.filter((key) => key.endsWith("|true")).length,
          dockviewDistinctOutcomes: theirs.size,
          dockviewPositions: ["top", "bottom", "left", "right", "center"],
        };
      },

      /*
        PROBE 7 — DOCKVIEW'S OWN OVERLAY, DRIVEN WITH NO LOCAL DRAG. The vendor's best
        facility for painting a drag nobody here is performing:
        `group.model.contentDropTarget.showOverlay(position)`, added for keyboard docking.
        A remote carry has no `DragEvent`, so this is the ONLY door it could come through.
        Measured: does it paint, and what can it express?
      */
      dockOverlay: () => {
        if (dock === null) return { error: "no dock" };
        const groups = dock.groups;
        const target = groups.find((group) =>
          group.model.panels.some((panel) => panel.id === "tD"),
        );
        if (target === undefined)
          return { error: "no group for tD", groups: groups.map((g) => g.id) };
        const overlay = target.model.contentDropTarget;
        const positions: readonly Position[] = ["top", "bottom", "left", "right", "center"];
        overlay.setTargetZones([...positions]);
        overlay.showOverlay("left");
        const host = dockHost.current;
        const painted =
          host === null
            ? []
            : Array.from(host.querySelectorAll<HTMLElement>(".dv-drop-target-dropzone")).map(
                (element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    className: element.className,
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                  };
                },
              );
        return {
          groupCount: groups.length,
          panelsPerGroup: groups.map((group) => group.model.panels.map((panel) => panel.id)),
          headersHidden: groups.every((group) => group.model.header.hidden),
          overlayReachableFromPublicApi: true,
          overlayPainted: painted,
          /*
            THE CODOMAIN. `showOverlay` takes ONE of five positions against ONE group — so
            what a remote aim can be shown as is `groups × 5`, with no ancestor split, no
            between-seam, no swap/replace and no pane motion. Our own aim space over the
            same tree is `zones.ourDistinctOutcomes`.
          */
          expressibleDestinations: groups.length * positions.length,
          leaves: leafReport("dock"),
        };
      },
    };
  }, [layout, grid, dock]);

  return (
    <div className="harness">
      <section className="pane pane--ours">
        <h2>ours — TileTree (control)</h2>
        <ControlTree layout={layout} />
      </section>
      <section className="pane pane--dockview">
        <h2>dockview — GridviewComponent 8.2.0</h2>
        <div className="dv-host" ref={candidateHost} />
      </section>
      <section className="pane pane--dock">
        <h2>dockview — DockviewComponent 8.2.0 (hideHeader)</h2>
        <div className="dv-host" ref={dockHost} />
      </section>
    </div>
  );
}

const mount = document.getElementById("root");
if (mount === null) throw new Error("no #root");
createRoot(mount).render(<Harness />);
