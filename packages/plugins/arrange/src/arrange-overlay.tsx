import {
  areaUnits,
  resolveTileAim,
  tileProspect,
  useProjection,
  type AreaFractions,
  type TileAim,
  type UnitRect,
  type WorkspaceOverlayProps,
} from "@manifold/plugin/hooks";
import { ControlIcon, WORKSPACE_TREE_CLASSES, setVantage, useNotice, useVantage } from "@manifold/plugin/ui";
import { ROOT_TILE_ID, type TileEdge, type TileLayout } from "@manifold/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  addedSpacer,
  movedPanelLayout,
  nudgedPanelLayout,
  panelArrangeMessage,
  panelsCanMove,
  reseated,
  resolveArrangeScope,
  rootEqualized,
  rootStacked,
  shelved,
  shelvedPanels,
  swappedSeats,
  type PanelArrangeOutcome,
} from "./arrange-logic.ts";
import { composeDefaultLayout } from "@manifold/plugin";

/**
 * `core.arrange`'s ONE workspace overlay — the floating toolbar, the panel-move grips and
 * their live drag preview, the mode's own status, and the wireframe delimitation, all mounted
 * behind the single `toolbar` workspace-overlay slot (issue #89). Everything below is gated
 * on `vantage.arranging`: absent that, this component paints nothing — no DOM, no geometry
 * work, the same discipline the grips always kept.
 */

/** Which sibling an arrow key reaches for; the tile vocabulary's own edges, not a new one. */
const ARROW_EDGES: Readonly<Record<string, Exclude<TileEdge, "center">>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "top",
  ArrowDown: "bottom",
};

/** How far a pointer must travel before a grip press becomes a DRAG rather than a TAP. */
const DRAG_THRESHOLD_PX = 6;

/** The device-local floating position of the toolbar — see REGISTRY.md's device-local register. */
const TOOLBAR_POSITION_KEY = "manifold:arrange-toolbar-position";

interface ToolbarOffset {
  readonly dx: number;
  readonly dy: number;
}

const ORIGIN_OFFSET: ToolbarOffset = { dx: 0, dy: 0 };

function loadToolbarOffset(): ToolbarOffset {
  try {
    const raw = window.localStorage.getItem(TOOLBAR_POSITION_KEY);
    if (raw === null) return ORIGIN_OFFSET;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return ORIGIN_OFFSET;
    const dx = Reflect.get(parsed, "dx");
    const dy = Reflect.get(parsed, "dy");
    if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      return ORIGIN_OFFSET;
    }
    return { dx, dy };
  } catch {
    return ORIGIN_OFFSET;
  }
}

/** Every tile id's own painted box, keyed off the tree's `data-tile-id` markup — splits too. */
function measureRects(root: HTMLElement, layout: TileLayout): ReadonlyMap<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const id of Object.keys(layout)) {
    const element =
      root.getAttribute("data-tile-id") === id
        ? root
        : root.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`);
    if (element !== null) rects.set(id, element.getBoundingClientRect());
  }
  return rects;
}

/** Every split's nesting depth from the root (0), for the wireframe's hue/inset stepping. */
function tileDepths(layout: TileLayout): ReadonlyMap<string, number> {
  const depths = new Map<string, number>();
  const walk = (id: string, depth: number): void => {
    const tile = layout[id];
    if (tile === undefined) return;
    depths.set(id, depth);
    for (const childId of tile.children) walk(childId, depth + 1);
  };
  walk(ROOT_TILE_ID, 0);
  return depths;
}

/** Live rects for every tile, remeasured on layout change, resize, and while armed. */
function useTileRects(
  armed: boolean,
  layout: TileLayout | null,
  getTreeElement: () => HTMLElement | null,
): ReadonlyMap<string, DOMRect> | null {
  const [rects, setRects] = useState<ReadonlyMap<string, DOMRect> | null>(null);
  useEffect(() => {
    if (!armed || layout === null) {
      setRects(null);
      return;
    }
    const root = getTreeElement();
    if (root === null) {
      setRects(null);
      return;
    }
    const measure = (): void => setRects(measureRects(root, layout));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [armed, layout, getTreeElement]);
  return rects;
}

interface WireframeProps {
  readonly layout: TileLayout;
  readonly rects: ReadonlyMap<string, DOMRect>;
  readonly inScope: boolean;
}

/**
 * THE STRUCTURAL DELIMITATION (issue #89's second comment): an outline plus an axis marker on
 * every stack/split container, and a lighter outline on every spacer leaf — both otherwise
 * invisible. Overlay-only: absolutely positioned in client px off the SAME rects the grips
 * read, never a wrapper box in the renderer's own flow, so it costs the frame nothing when
 * arrange mode is not armed and reflows nothing while it is.
 */
function Wireframe({ layout, rects, inScope }: WireframeProps): ReactNode {
  const depths = useMemo(() => tileDepths(layout), [layout]);
  const boxes: ReactElement[] = [];
  for (const tile of Object.values(layout)) {
    const rect = rects.get(tile.id);
    if (rect === undefined) continue;
    const depth = depths.get(tile.id) ?? 0;
    const style: CSSProperties = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a CSS custom property
      ["--arrange-depth" as string]: depth,
    };
    if (tile.dir !== null) {
      boxes.push(
        <div
          key={tile.id}
          className={`arrange-wireframe-outline${inScope ? "" : " is-out-of-scope"}`}
          data-dir={tile.dir}
          style={style}
          aria-hidden="true"
        >
          <span className="arrange-wireframe-axis" data-dir={tile.dir} aria-hidden="true" />
        </div>,
      );
    } else if (tile.ref?.kind === "spacer") {
      boxes.push(
        <div
          key={tile.id}
          className={`arrange-wireframe-spacer${inScope ? "" : " is-out-of-scope"}`}
          style={style}
          aria-hidden="true"
        />,
      );
    }
  }
  return <>{boxes}</>;
}

interface GripState {
  readonly tileId: string;
  readonly draggable: boolean;
  readonly moved: boolean;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
}

interface DragFrame {
  readonly aim: TileAim;
  readonly units: AreaFractions;
}

/**
 * THE PENDING DISARM, module-scoped on purpose — see the unmount effect below. A timer id
 * rather than a boolean, because the thing a remount has to do is CANCEL the clear, and only
 * the instance that scheduled it knows which one is outstanding.
 */
let pendingDisarm: number | null = null;

export function ArrangeOverlay({ host }: WorkspaceOverlayProps): ReactElement {
  const { arranging, arrangeScope } = useVantage();
  const { notify } = useNotice();
  const projection = useProjection();

  /*
    A vantage this plugin owns must not outlive it: disabling core.arrange (or any other
    reason this overlay unmounts) leaves the mode armed with nobody left to answer F8's
    toggle or paint a way out — so the flag it set is the flag it clears going away.

    SCHEDULED, not immediate, which is the standard ignore-stale-cleanup shape. React's
    StrictMode mounts, unmounts and remounts a component in development — at ANY mount, not
    only the first — and an unconditional clear in that teardown would silently drop a mode a
    reader had armed, with no way to tell that unmount from a real one at the moment it runs.
    A remount inside the same commit cancels the pending clear; a real teardown has no
    remount to cancel it, so the mode still ends when its owner does, one macrotask later.
  */
  useEffect(() => {
    if (pendingDisarm !== null) {
      window.clearTimeout(pendingDisarm);
      pendingDisarm = null;
    }
    return () => {
      pendingDisarm = window.setTimeout(() => {
        pendingDisarm = null;
        setVantage({ arranging: false, arrangeScope: null });
      }, 0);
    };
  }, []);

  const layout = host.tileGeometry?.layout ?? null;
  const getTreeElement = useCallback((): HTMLElement | null => {
    // The one legitimate cast the shared host contract's `unknown` return asks for — see
    // `TileGeometryHandle.getTreeElement`'s doc note in `@manifold/plugin`.
    const element = host.tileGeometry?.getTreeElement() ?? null;
    return element instanceof HTMLElement ? element : null;
  }, [host.tileGeometry]);
  const applyLayout = useCallback(
    (next: TileLayout): void => host.tileGeometry?.applyLayout(next),
    [host.tileGeometry],
  );

  const { panelId: scopedPanelId, title: scopeTitle } = resolveArrangeScope(
    host.assembly.panels,
    arranging ? arrangeScope : null,
  );

  // Escape POPS ONE LEVEL, and at the root it leaves — the mode's own universal "never mind",
  // armed only while the overlay is mounted so nothing listens for a key it cannot act on.
  useEffect(() => {
    if (!arranging) return;
    const popScope = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (scopedPanelId !== null) setVantage({ arrangeScope: null });
      else setVantage({ arranging: false, arrangeScope: null });
    };
    window.addEventListener("keydown", popScope);
    return () => window.removeEventListener("keydown", popScope);
  }, [arranging, scopedPanelId]);

  const rects = useTileRects(arranging, layout, getTreeElement);

  // -------------------------------------------------------------- selection (Swap's own)
  const [selected, setSelected] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!arranging) setSelected([]);
  }, [arranging]);
  const toggleSelected = useCallback((tileId: string): void => {
    setSelected((current) => {
      if (current.includes(tileId)) return current.filter((id) => id !== tileId);
      if (current.length < 2) return [...current, tileId];
      return [current[1] ?? tileId, tileId];
    });
  }, []);

  // ------------------------------------------------------------------- the panel-move gesture
  const gripRef = useRef<GripState | null>(null);
  const aimRef = useRef<TileAim | null>(null);
  const [liveGrab, setLiveGrab] = useState<string | null>(null);
  const [frame, setFrame] = useState<DragFrame | null>(null);

  const land = useCallback(
    (outcome: PanelArrangeOutcome): void => {
      if (!outcome.ok) {
        notify(panelArrangeMessage(outcome.rule), { key: "panel-arrange" });
        return;
      }
      applyLayout(outcome.layout);
    },
    [applyLayout, notify],
  );

  const beginGrip = useCallback(
    (tileId: string, draggable: boolean, event: ReactPointerEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      gripRef.current = {
        tileId,
        draggable,
        moved: false,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [],
  );

  const nudgeGrip = useCallback(
    (tileId: string, direction: Exclude<TileEdge, "center">): void => {
      if (layout === null) return;
      land(nudgedPanelLayout(layout, tileId, direction));
    },
    [land, layout],
  );

  useEffect(() => {
    if (!arranging) return;
    const move = (event: PointerEvent): void => {
      const grip = gripRef.current;
      if (grip === null || event.pointerId !== grip.pointerId) return;
      if (!grip.moved) {
        const dx = event.clientX - grip.startX;
        const dy = event.clientY - grip.startY;
        if (!grip.draggable || Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        gripRef.current = { ...grip, moved: true };
        setLiveGrab(grip.tileId);
      }
      const element = getTreeElement();
      const units = element === null ? null : areaUnits(element, WORKSPACE_TREE_CLASSES.dividerPx);
      if (units === null || layout === null) return;
      const next = resolveTileAim(
        layout,
        {
          x: (event.clientX - units.rect.left) / units.rect.width,
          y: (event.clientY - units.rect.top) / units.rect.height,
        },
        { carriedTileId: grip.tileId, holdsTileSeat: true },
        units.dividers,
        units.ring,
        aimRef.current,
      );
      const held = aimRef.current;
      aimRef.current = next;
      if (next === null) {
        if (held !== null) setFrame(null);
        return;
      }
      if (
        held !== null &&
        held.tileId === next.tileId &&
        held.edge === next.edge &&
        held.action === next.action &&
        (held.between === true) === (next.between === true)
      ) {
        return;
      }
      setFrame({ aim: next, units });
    };
    const end = (event: PointerEvent): void => {
      const grip = gripRef.current;
      if (grip === null || event.pointerId !== grip.pointerId) return;
      gripRef.current = null;
      const aim = aimRef.current;
      aimRef.current = null;
      setLiveGrab(null);
      setFrame(null);
      if (!grip.moved) {
        toggleSelected(grip.tileId);
        return;
      }
      if (layout !== null && aim !== null) land(movedPanelLayout(layout, grip.tileId, aim));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [arranging, getTreeElement, land, layout, toggleSelected]);

  // ---------------------------------------------------------------------------- toolbar drag
  const toolbarRef = useRef<HTMLElement | null>(null);
  const toolbarDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly originDx: number;
    readonly originDy: number;
  } | null>(null);
  const [toolbarOffset, setToolbarOffset] = useState<ToolbarOffset>(loadToolbarOffset);

  const beginToolbarDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      toolbarDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originDx: toolbarOffset.dx,
        originDy: toolbarOffset.dy,
      };
    },
    [toolbarOffset],
  );

  useEffect(() => {
    if (!arranging) return;
    const move = (event: PointerEvent): void => {
      const drag = toolbarDragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      setToolbarOffset({
        dx: drag.originDx + (event.clientX - drag.startX),
        dy: drag.originDy + (event.clientY - drag.startY),
      });
    };
    const end = (event: PointerEvent): void => {
      const drag = toolbarDragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      toolbarDragRef.current = null;
      setToolbarOffset((current) => {
        try {
          window.localStorage.setItem(TOOLBAR_POSITION_KEY, JSON.stringify(current));
        } catch {
          // Toolbar position memory is optional (S3's device-local register: `TOOLBAR_POSITION_KEY`).
        }
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [arranging]);

  // --------------------------------------------------------------------------------- tools
  const shelvedList = useMemo(
    () => shelvedPanels(layout, host.assembly.panels),
    [host.assembly.panels, layout],
  );

  const runTool = useCallback(
    (id: string): void => {
      switch (id) {
        case "stack-row":
          land(rootStacked(layout, "row"));
          return;
        case "stack-column":
          land(rootStacked(layout, "column"));
          return;
        case "spacer":
          land(addedSpacer(layout));
          return;
        case "equalize":
          land(rootEqualized(layout));
          return;
        case "swap":
          land(swappedSeats(layout, selected));
          setSelected([]);
          return;
        case "reset":
          // The manifest default, reached through the same door Reset always used — the
          // roster this browser already holds, nothing kept here.
          applyLayout(composeDefaultLayout(host.assembly.roster()).layout);
          return;
        default:
          // An "arrange"-toolbar tool a stranger plugin contributed: the vocabulary is
          // generic (D5), but running an unknown verb is not this component's to invent —
          // it paints the button and leaves the click inert until something claims the id.
          return;
      }
    },
    [applyLayout, host.assembly, land, layout, selected],
  );

  const runShelve = useCallback(
    (tileId: string): void => land(shelved(layout, tileId)),
    [land, layout],
  );
  const runReseat = useCallback(
    (panelId: string): void => land(reseated(layout, panelId)),
    [land, layout],
  );

  if (!arranging) return <></>;

  const tools = projection.tools.filter(
    (candidate) => candidate.enabled && candidate.toolbar === "arrange",
  );
  const grabbable = scopedPanelId === null && panelsCanMove(layout);
  const toolsDisabled = scopedPanelId !== null;

  return (
    <>
      {layout === null || rects === null ? null : (
        <Wireframe layout={layout} rects={rects} inScope={scopedPanelId === null} />
      )}
      {!grabbable || layout === null || rects === null
        ? null
        : Object.values(layout)
            .filter((tile) => tile.dir === null && (tile.ref?.kind === "panel" || tile.ref?.kind === "spacer"))
            .map((tile) => {
              const rect = rects.get(tile.id);
              if (rect === undefined || tile.ref === null) return null;
              const ref = tile.ref;
              const panelId = ref.kind === "panel" ? ref.panelId : null;
              const isPanel = panelId !== null;
              const panel = panelId === null ? undefined : host.assembly.panels.get(panelId);
              const title = panelId === null ? "Spacer" : (panel?.title ?? panelId);
              const style: CSSProperties = {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              };
              return (
                <span key={tile.id} className="arrange-grip-host" style={style}>
                  <button
                    type="button"
                    className={`arrange-grip${liveGrab === tile.id ? " is-grabbed" : ""}${
                      selected.includes(tile.id) ? " is-selected" : ""
                    }`}
                    data-action="core.space.setLayout"
                    data-panel-id={panelId ?? undefined}
                    data-tile-id={tile.id}
                    aria-label={`Move the ${title} panel`}
                    onPointerDown={(event) => beginGrip(tile.id, isPanel, event)}
                    onKeyDown={(event) => {
                      const direction = ARROW_EDGES[event.key];
                      if (direction === undefined) return;
                      event.preventDefault();
                      nudgeGrip(tile.id, direction);
                    }}
                  />
                  <span className="arrange-grip-pill">
                    <span className="arrange-grip-label">{title}</span>
                    {panel?.arranges === undefined ? null : (
                      <button
                        type="button"
                        className="arrange-scope"
                        data-panel-id={panelId ?? undefined}
                        aria-label={`Arrange ${panel.arranges.title}`}
                        onClick={() => panelId !== null && setVantage({ arrangeScope: panelId })}
                      >
                        <ControlIcon kind="scopeIn" size={13} />
                      </button>
                    )}
                  </span>
                </span>
              );
            })}
      {frame === null
        ? null
        : (() => {
            const prospect =
              layout === null || gripRef.current === null
                ? null
                : tileProspect(layout, frame.aim, gripRef.current.tileId, frame.units.dividers);
            if (prospect === null) return null;
            const paint = (unit: UnitRect): CSSProperties => ({
              left: frame.units.rect.left + unit.x * frame.units.rect.width,
              top: frame.units.rect.top + unit.y * frame.units.rect.height,
              width: unit.width * frame.units.rect.width,
              height: unit.height * frame.units.rect.height,
            });
            const trade = frame.aim.action === "swap";
            return (
              <>
                <div
                  className={`arrange-slot${trade ? " is-swap" : ""}`}
                  style={paint(prospect.slot)}
                  aria-hidden="true"
                />
                {prospect.partner === null ? null : (
                  <div className="arrange-slot is-swap" style={paint(prospect.partner)} aria-hidden="true" />
                )}
              </>
            );
          })()}
      <aside
        ref={(element) => {
          toolbarRef.current = element;
        }}
        className="arrange-toolbar"
        role="toolbar"
        aria-label="Arrange toolbar"
        style={{ transform: `translate(-50%, 0) translate(${toolbarOffset.dx}px, ${toolbarOffset.dy}px)` }}
      >
        <button
          type="button"
          className="arrange-toolbar-handle"
          aria-label="Move the arrange toolbar"
          onPointerDown={beginToolbarDrag}
        >
          <ControlIcon kind="grip" size={13} />
        </button>
        <div className="arrange-toolbar-status" role="status">
          <strong className="arrange-toolbar-title">Arrange mode</strong>
          {scopeTitle === null ? (
            <span className="arrange-toolbar-hint">Esc or F8 to finish.</span>
          ) : (
            <span className="arrange-crumbs">
              <button
                type="button"
                className="arrange-crumb-up"
                onClick={() => setVantage({ arrangeScope: null })}
              >
                Workspace
              </button>
              <span className="arrange-crumb-sep" aria-hidden="true">
                ›
              </span>
              <span className="arrange-crumb">{scopeTitle}</span>
            </span>
          )}
        </div>
        {shelvedList.length === 0 ? null : (
          <div className="arrange-shelf" role="list" aria-label="Unseated panels">
            {shelvedList.map((entry) => (
              <button
                key={entry.panelId}
                type="button"
                className="arrange-shelf-item"
                data-action="core.space.setLayout"
                data-testid="arrange-shelf-item"
                disabled={toolsDisabled}
                onClick={() => runReseat(entry.panelId)}
              >
                {entry.title}
              </button>
            ))}
          </div>
        )}
        {/*
          Shelf is the one tool whose verb needs a SEAT rather than the root, so it reads the
          selection: the first selected tile, and inert while there is none. With two selected
          (a Swap being set up) it unseats the FIRST of them rather than refusing — the shelf
          below lists what it took and one press puts it back, so the recovery is cheaper than
          a refusal would be to explain.
        */}
        <div className="arrange-toolbar-tools">
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="arrange-toolbar-button"
              data-action="core.space.setLayout"
              data-testid={`toolbar-${tool.id}`}
              disabled={toolsDisabled}
              onClick={() => (tool.id === "shelf" ? selected[0] !== undefined && runShelve(selected[0]) : runTool(tool.id))}
            >
              {tool.title}
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
