import {
  ITEM_MIME,
  WORKSPACE_TREE_CLASSES,
  areaUnits,
  carriesItem,
  heldStructure,
  holdStructure,
  keyCapLabel,
  readEnvelope,
  releaseStructure,
  resolveTileAim,
  sealEnvelope,
  setVantage,
  tileProspect,
  useHeldStructure,
  useNotice,
  useProjection,
  useVantage,
  type AreaFractions,
  type TileAim,
  type UnitRect,
  type WorkspaceOverlayProps,
} from "@manifold/plugin/hooks";
import { ControlIcon, ItemIcon, KeyCap, type ControlKind } from "@manifold/ui";
import { ROOT_TILE_ID, type Structure, type TileEdge, type TileLayout } from "@manifold/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  droppedStructure,
  escapeMeaning,
  isStructure,
  movedPanelLayout,
  nudgedPanelLayout,
  panelArrangeMessage,
  panelsCanMove,
  removedStructure,
  reseated,
  resolveArrangeScope,
  rootEqualized,
  shelved,
  shelvedPanels,
  type PanelArrangeOutcome,
} from "./arrange-logic.ts";
import { composeDefaultLayout } from "@manifold/plugin";

/**
 * `core.arrange`'s ONE workspace overlay — the PALETTE and its two-button operation row, the
 * panel-move grips and their live drag preview, the mode's own status, and the wireframe
 * delimitation, all mounted behind the single `toolbar` workspace-overlay slot. Everything
 * below is gated on `vantage.arranging`: absent that, this component paints nothing — no
 * DOM, no geometry work, the same discipline the grips always kept.
 *
 * THE PALETTE IS THREE CARRY SOURCES (issue #104, superseding #89's button reading). Dragging
 * one out of the bar seals an ordinary item envelope whose payload is NEW STRUCTURE, and from
 * that moment on it is a carry like any other: the same mime, the same process-wide register,
 * the same wire ref, adopted by whatever renderer it wanders into. This overlay is only one of
 * the targets — a composition takes the very same drag through its own `core.space.place`
 * door, and a scoped panel takes it into its own arrangement — which is exactly why the drop
 * handler below claims a point only when nothing INSIDE the tree already did (`defaultPrevented`).
 */

/**
 * WHICH TOOL CARRIES WHICH SHAPE. `core.arrange` reads its OWN tool ids here and nowhere
 * else: the manifest declares three ordinary `arrange`-toolbar tools, and this table is this
 * plugin's private reading of them as drag sources. A stranger plugin's tool on the same
 * toolbar is not in the table and paints as an ordinary button, exactly as it did before —
 * the palette is a reading, not a new contribution kind.
 */
const PALETTE_STRUCTURES: Readonly<Record<string, Structure>> = {
  "stack-row": { kind: "split", dir: "row" },
  "stack-column": { kind: "split", dir: "column" },
  spacer: { kind: "spacer" },
};

/**
 * WHICH OPERATION WEARS WHICH VERB MARK — the same private reading of this plugin's own tool
 * ids the palette table above makes, for the buttons instead of the drag sources. The marks
 * come from the engine's CLOSED control vocabulary and every one of them is a neutral verb:
 * Shelf IS `park` (the representation leaves its seat, the panel keeps running on the shelf),
 * Remove IS `discard` (the structure is gone; what it held is not), Reset IS `restart` (back
 * to its beginning, whatever it is), Equalize IS `equalize` (one even share for the parts). A
 * stranger plugin's tool is not in the table and paints as a plain word — this component
 * cannot know its verb, and a wrong mark is worse than none.
 */
const OPERATION_ICONS: Readonly<Record<string, ControlKind>> = {
  equalize: "equalize",
  shelf: "park",
  remove: "discard",
  reset: "restart",
};

/** What the palette calls the structure a placed tile is, for its grip's own label. */
const STRUCTURE_TITLES: Readonly<Record<string, string>> = {
  row: "Stack row",
  column: "Stack column",
  spacer: "Spacer",
  vacant: "Empty seat",
};

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
    if (
      typeof dx !== "number" ||
      typeof dy !== "number" ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy)
    ) {
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
  const [measured, setMeasured] = useState<{
    readonly forLayout: TileLayout;
    readonly rects: ReadonlyMap<string, DOMRect>;
  } | null>(null);
  useEffect(() => {
    if (!armed || layout === null) return;
    const root = getTreeElement();
    if (root === null) return;
    const measure = (): void =>
      setMeasured({ forLayout: layout, rects: measureRects(root, layout) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [armed, layout, getTreeElement]);
  // Disarmed, no layout, or a stale measurement from a layout that has since changed: no rects
  // rather than a snapshot the reader never asked for and might not match what is on screen.
  return armed && layout !== null && measured?.forLayout === layout ? measured.rects : null;
}

interface WireframeProps {
  readonly layout: TileLayout;
  readonly rects: ReadonlyMap<string, DOMRect>;
  readonly inScope: boolean;
}

/**
 * THE STRUCTURAL DELIMITATION: an outline plus an axis marker on every split container, and a
 * lighter outline on every leaf that holds nothing — a spacer, or one of the two VACANT SEATS
 * a dropped split arrives with (issue #104). All of them are otherwise invisible, and the
 * vacant ones take no room at all while the mode is off, so the wireframe is the only thing
 * that says a freshly dropped stack is there and where to aim the next drag.
 *
 * Overlay-only: absolutely positioned in client px off the SAME rects the grips read, never a
 * wrapper box in the renderer's own flow, so it costs the frame nothing when arrange mode is
 * not armed and reflows nothing while it is.
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
    } else if (tile.ref === null || tile.ref.kind === "spacer") {
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
  /** A panel moves inside the tree; a structure's one destination is the palette (#148). */
  readonly kind: "panel" | "structure";
  readonly moved: boolean;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
}

interface DragFrame {
  /** The seat being vacated, or null for a palette carry — which vacates nothing. */
  readonly tileId: string | null;
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

  // ------------------------------------------------------------------- the grip gesture's refs
  const gripRef = useRef<GripState | null>(null);
  const aimRef = useRef<TileAim | null>(null);
  const [liveGrab, setLiveGrab] = useState<string | null>(null);
  const [frame, setFrame] = useState<DragFrame | null>(null);
  /** The tree as of the latest render, for a callback armed earlier in the gesture (`holdStructure`). */
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  /** Ends a grip drag without landing anything: the tree untouched, the mode and scope kept. */
  const endGrip = useCallback((): void => {
    gripRef.current = null;
    aimRef.current = null;
    setLiveGrab(null);
    setFrame(null);
    releaseStructure();
  }, []);

  /*
    ESCAPE CANCELS THE CARRY IN HAND AND NOTHING ELSE (#148). With a grip drag in flight it
    ends that drag with the layout unchanged and leaves the mode armed at the same scope; with
    nothing in hand it is the mode's own universal "never mind" — one level out of a scoped
    panel, and out of the mode from the root (`escapeMeaning`, the tested policy). A key a
    deeper loop already claimed — a scoped panel's own row drag — is left alone: the panel
    owns that carry exactly as this overlay owns its grips. Armed only while mounted, so
    nothing listens for a key it cannot act on. Palette drags are the browser's own loop:
    the hint in the bar says the key out loud, and nothing here fights it.
  */
  useEffect(() => {
    if (!arranging) return;
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      switch (escapeMeaning(gripRef.current?.moved === true, scopedPanelId)) {
        case "end_carry":
          endGrip();
          return;
        case "pop_scope":
          setVantage({ arrangeScope: null });
          return;
        case "leave_mode":
          setVantage({ arranging: false, arrangeScope: null });
          return;
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [arranging, endGrip, scopedPanelId]);

  const rects = useTileRects(arranging, layout, getTreeElement);

  // -------------------------------------------------------- selection (Shelf's and Remove's)
  /**
   * ONE SEAT AT A TIME. It was two while Swap existed, because trading needed a pair; a center
   * release already trades, so Swap went and the pair went with it. Shelf and Remove are the
   * two verbs that name a seat rather than the root, and each names exactly one.
   */
  const [selected, setSelected] = useState<string | null>(null);
  // Leaving arrange mode or changing scope drops the selection — a pending Shelf or Remove
  // made sense only in the arrangement it was made in — and the paint of a grip drag in
  // flight, so nothing stays in hand for the next arm. Compared during render rather than
  // reset from an effect (react.dev's own remedy for "reset state when a prop changes") —
  // one extra render on the transition, no cascade. The gesture's REFS reset in the effect
  // below, because a ref is for event handlers and the next pointer frame must read "nothing".
  const [wasScoped, setWasScoped] = useState<string | null | false>(arranging && scopedPanelId);
  const scopeNow = arranging && scopedPanelId;
  if (wasScoped !== scopeNow) {
    setWasScoped(scopeNow);
    if (selected !== null) setSelected(null);
    if (liveGrab !== null) setLiveGrab(null);
    if (frame !== null) setFrame(null);
  }
  useEffect(() => {
    gripRef.current = null;
    aimRef.current = null;
    releaseStructure();
  }, [scopeNow]);
  const toggleSelected = useCallback((tileId: string): void => {
    setSelected((current) => (current === tileId ? null : tileId));
  }, []);
  const selectedStructure =
    selected !== null && layout !== null && layout[selected] !== undefined
      ? isStructure(layout[selected])
      : false;

  // ------------------------------------------------------------------- the grip gesture

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

  // Reads its target off the DOM (`data-tile-id`/`data-panel-id`, already painted by the grip
  // markup below) rather than closing over `tile.id` per grip: passed to `onPointerDown`
  // directly, so no inline wrapper calls a ref-touching function during render. Focus is
  // taken by hand because `preventDefault` on a pointerdown withholds it, and the keyboard
  // doors — arrows, Enter, Delete — are on the grip a tap just landed on.
  const beginGrip = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const tileId = event.currentTarget.dataset["tileId"];
    if (tileId === undefined) return;
    const kind = event.currentTarget.dataset["panelId"] !== undefined ? "panel" : "structure";
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    gripRef.current = {
      tileId,
      kind,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }, []);

  const nudgeGrip = useCallback(
    (tileId: string, direction: Exclude<TileEdge, "center">): void => {
      if (layout === null) return;
      land(nudgedPanelLayout(layout, tileId, direction));
    },
    [land, layout],
  );

  /*
    ONE LOOP FOR EVERY GRIP, and what is in hand decides where it can land (#148). A PANEL aims
    at the tree through the shared zone kernel and lands by `movedPanelLayout`; a STRUCTURE
    has exactly one destination — the palette it came out of — so its frames resolve no tree
    aim at all, and crossing the drag threshold hands the palette the one verb it can answer
    with (`holdStructure`). The palette's own listener below is what takes it at the release;
    this loop only clears the hand afterwards, whether or not the palette took it.
  */
  useEffect(() => {
    if (!arranging) return;
    const move = (event: PointerEvent): void => {
      const grip = gripRef.current;
      if (grip === null || event.pointerId !== grip.pointerId) return;
      if (!grip.moved) {
        const dx = event.clientX - grip.startX;
        const dy = event.clientY - grip.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        gripRef.current = { ...grip, moved: true };
        setLiveGrab(grip.tileId);
        if (grip.kind === "structure") {
          holdStructure({ remove: () => land(removedStructure(layoutRef.current, grip.tileId)) });
        }
      }
      if (grip.kind === "structure") return;
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
      setFrame({ tileId: grip.tileId, aim: next, units });
    };
    const end = (event: PointerEvent): void => {
      const grip = gripRef.current;
      if (grip === null || event.pointerId !== grip.pointerId) return;
      const aim = aimRef.current;
      endGrip();
      if (!grip.moved) {
        toggleSelected(grip.tileId);
        return;
      }
      if (grip.kind === "structure") return;
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
  }, [arranging, endGrip, getTreeElement, land, layout, toggleSelected]);

  /*
    DELETE AND BACKSPACE REMOVE THE SELECTED STRUCTURE — the keyboard's door onto the same
    function the palette drop and the Remove tool reach. Only at the root: inside a scoped
    panel the panel's own arrangement owns its keys. A key that a text field is taking is
    left to it — the mode blanks the pointer, never a focused input's keyboard.
  */
  useEffect(() => {
    if (!arranging || scopedPanelId !== null) return;
    const remove = (event: KeyboardEvent): void => {
      if ((event.key !== "Delete" && event.key !== "Backspace") || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("textarea, input, [contenteditable]") !== null
      ) {
        return;
      }
      event.preventDefault();
      if (selected === null) land({ ok: false, rule: "nothing_selected" });
      else land(removedStructure(layout, selected));
      setSelected(null);
    };
    window.addEventListener("keydown", remove);
    return () => window.removeEventListener("keydown", remove);
  }, [arranging, land, layout, scopedPanelId, selected]);

  // --------------------------------------------------------------------------- the palette
  /**
   * THE SHAPE IN HAND, or null. It is state rather than a ref because the whole workspace
   * reads it: the grips stop taking the pointer so the drag can reach the tree beneath them,
   * and the floor lifts the mode's content suppression so a composition can claim a point of
   * its own. `dragend` fires on the source however the drag finished, including an abort with
   * no drop, so it is the one signal that always clears this.
   */
  const [carried, setCarried] = useState<Structure | null>(null);
  /** The pointer is over the palette with something in hand: the target's own "you are here". */
  const [paletteHot, setPaletteHot] = useState(false);
  useEffect(() => {
    if (carried === null) return;
    const done = (): void => {
      setCarried(null);
      setPaletteHot(false);
    };
    window.addEventListener("dragend", done);
    return () => window.removeEventListener("dragend", done);
  }, [carried]);

  const beginPaletteDrag = useCallback(
    (event: ReactDragEvent<HTMLElement>, structure: Structure): void => {
      /*
        The ordinary source-side seal every other drag in the application uses: one mime, one
        typed payload, and the process-wide register set at the same moment so a renderer with
        no DataTransfer to read (a React Flow node drag crossing the same room) still knows
        what is in the air. `copy` rather than `move` because nothing leaves anywhere: a
        palette item is a source that never empties.
      */
      event.dataTransfer.setData(
        ITEM_MIME,
        sealEnvelope({ kind: "structure", structure }, { kind: "structure", containerId: null }),
      );
      event.dataTransfer.effectAllowed = "copy";
      setCarried(structure);
    },
    [],
  );

  /**
   * THE PALETTE IS WHERE STRUCTURE COMES FROM AND WHERE IT GOES BACK TO (#148). While anything
   * is carried it is a drop target, and it paints the state it is in rather than asking the
   * reader to remember one: a FRESH item over it means "Drop to cancel", a PLACED structure
   * means "Drop to remove". Two transports reach it — the browser's own drag loop for a
   * palette item (`dragover`/`drop` on the element) and this plugin's pointer loop for a grip,
   * whichever plugin painted the grip (`heldStructure`, the engine's one slot for a structure
   * in hand) — and both land on the same rect test, because a target is a place on screen.
   */
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const held = useHeldStructure();
  const overPalette = useCallback((clientX: number, clientY: number): boolean => {
    const box = paletteRef.current?.getBoundingClientRect();
    return (
      box !== undefined &&
      clientX >= box.left &&
      clientX <= box.right &&
      clientY >= box.top &&
      clientY <= box.bottom
    );
  }, []);
  useEffect(() => {
    if (!arranging || held === null) return;
    const hover = (event: PointerEvent): void =>
      setPaletteHot(overPalette(event.clientX, event.clientY));
    // CAPTURE, so the removal lands before the holder's own release handler clears its hand.
    const take = (event: PointerEvent): void => {
      setPaletteHot(false);
      if (heldStructure() === null || !overPalette(event.clientX, event.clientY)) return;
      held.remove();
    };
    window.addEventListener("pointermove", hover);
    window.addEventListener("pointerup", take, true);
    window.addEventListener("pointercancel", take, true);
    return () => {
      window.removeEventListener("pointermove", hover);
      window.removeEventListener("pointerup", take, true);
      window.removeEventListener("pointercancel", take, true);
    };
  }, [arranging, held, overPalette]);

  const paletteOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      if (carried === null || !carriesItem(event.dataTransfer)) return;
      // Accepting is what earns the drop and the cursor that says so; `copy` is what the
      // source allowed, and anything else would make the browser cancel the drop outright.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setPaletteHot(true);
    },
    [carried],
  );
  const paletteLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    const to = event.relatedTarget;
    if (to instanceof Node && event.currentTarget.contains(to)) return;
    setPaletteHot(false);
  }, []);
  const paletteDrop = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    const envelope = readEnvelope(event.dataTransfer);
    if (envelope === null || envelope.kind !== "structure") return;
    // A fresh item back where it came from: nothing was placed, so nothing is written.
    event.preventDefault();
    setPaletteHot(false);
    setCarried(null);
  }, []);

  /**
   * THE WORKSPACE'S OWN CLAIM on a palette drag, and deliberately the WEAKEST one.
   *
   * The listeners sit on the tree element and read `defaultPrevented` first, so anything
   * INSIDE the tree that wanted this point has already taken it: a composition claims its own
   * interior through `core.space.place`, a scoped panel claims its own rows, and what is left
   * over — the seams between panes, the area's border ring, a spacer, a vacant seat — is what
   * the workspace tree itself is. That is the whole arbitration, and it is the DOM's own
   * bubbling rather than a second registry of who owns which pixel.
   *
   * Native listeners rather than React props because the tree is the FLOOR's element: this
   * plugin reaches it through the published `host.tileGeometry` handle and may not render into
   * it. Off entirely while scoped into a panel — in there the panel is the arrangement.
   */
  useEffect(() => {
    const tree = getTreeElement();
    if (!arranging || carried === null || scopedPanelId !== null || tree === null) return;
    const aimFor = (event: DragEvent): TileAim | null => {
      const units = areaUnits(tree, WORKSPACE_TREE_CLASSES.dividerPx);
      if (units === null || layout === null) return null;
      return resolveTileAim(
        layout,
        {
          x: (event.clientX - units.rect.left) / units.rect.width,
          y: (event.clientY - units.rect.top) / units.rect.height,
        },
        // New structure occupies no seat here, so it can neither be its own target nor trade.
        { carriedTileId: null, holdsTileSeat: false },
        units.dividers,
        units.ring,
        aimRef.current,
      );
    };
    const over = (event: DragEvent): void => {
      if (event.defaultPrevented || event.dataTransfer === null) return;
      if (!carriesItem(event.dataTransfer)) return;
      const units = areaUnits(tree, WORKSPACE_TREE_CLASSES.dividerPx);
      const next = aimFor(event);
      if (units === null || next === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const held = aimRef.current;
      aimRef.current = next;
      if (
        held !== null &&
        held.tileId === next.tileId &&
        held.edge === next.edge &&
        (held.between === true) === (next.between === true)
      ) {
        return;
      }
      setFrame({ tileId: null, aim: next, units });
    };
    const drop = (event: DragEvent): void => {
      if (event.defaultPrevented) return;
      const envelope = readEnvelope(event.dataTransfer);
      if (envelope === null || envelope.kind !== "structure") return;
      event.preventDefault();
      // Re-resolved from the release's own pointer rather than replayed off the painted
      // frame, which is what every other drop target in the tree does: the tree may have
      // moved under the last `dragover`, and what the reader let go of is where they are.
      const aim = aimFor(event);
      aimRef.current = null;
      setFrame(null);
      setCarried(null);
      if (aim !== null) land(droppedStructure(layout, envelope.structure, aim));
    };
    tree.addEventListener("dragover", over);
    tree.addEventListener("drop", drop);
    return () => {
      tree.removeEventListener("dragover", over);
      tree.removeEventListener("drop", drop);
      aimRef.current = null;
    };
  }, [arranging, carried, getTreeElement, land, layout, scopedPanelId]);

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

  // --------------------------------------------------------- the surviving click operations
  const shelvedList = useMemo(
    () => shelvedPanels(layout, host.assembly.panels),
    [host.assembly.panels, layout],
  );
  const depths = useMemo(() => (layout === null ? null : tileDepths(layout)), [layout]);

  const runTool = useCallback(
    (id: string): void => {
      switch (id) {
        case "equalize":
          land(rootEqualized(layout));
          return;
        case "shelf":
          if (selected === null) land({ ok: false, rule: "nothing_selected" });
          else land(shelved(layout, selected));
          setSelected(null);
          return;
        case "remove":
          if (selected === null) land({ ok: false, rule: "nothing_selected" });
          else land(removedStructure(layout, selected));
          setSelected(null);
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

  const runReseat = useCallback(
    (panelId: string): void => land(reseated(layout, panelId)),
    [land, layout],
  );

  if (!arranging) return <></>;

  const tools = projection.tools.filter(
    (candidate) => candidate.enabled && candidate.toolbar === "arrange",
  );
  /*
    THE BAR HAS TWO HALVES, and which half a tool lands in is decided by whether this plugin
    knows a SHAPE for it: the three it does are drag sources, everything else is a button.
  */
  const palette = tools.filter((tool) => PALETTE_STRUCTURES[tool.id] !== undefined);
  const operations = tools.filter((tool) => PALETTE_STRUCTURES[tool.id] === undefined);
  /*
    GRIPS ARE THE ROOT'S, and a palette drag puts them away so the drag can reach the tree
    beneath them. A PANEL is grabbable only with a second seat to take (`panelsCanMove`); a
    STRUCTURE is grabbable whenever it is there, because its one destination — the palette —
    is always there too, and a spacer beside a lone panel would otherwise be a spacer forever.
  */
  const gripsPainted =
    scopedPanelId === null && carried === null && layout !== null && rects !== null;
  const panelsGrabbable = panelsCanMove(layout);
  /*
    Scoped INTO a panel, the workspace's own operations have nothing to act on — but the
    PALETTE does, because the panel in scope takes the drag itself. That asymmetry is the
    scope working as designed rather than an exception to it. Remove needs a STRUCTURE
    selected on top of that: it is the one tool whose precondition a reader can see.
  */
  const operationsDisabled = scopedPanelId !== null;
  const paletteCarry = carried !== null ? "cancel" : held !== null ? "remove" : undefined;
  const carrying = paletteCarry !== undefined;

  return (
    <>
      {layout === null || rects === null ? null : (
        <Wireframe layout={layout} rects={rects} inScope={scopedPanelId === null} />
      )}
      {!gripsPainted || layout === null || rects === null
        ? null
        : /*
            LEAVES FIRST, THEN SPLITS OUTERMOST FIRST: every host paints in DOM order, so a
            split's handle lands above the full-box grip of the leaf it sits in the corner
            of, and a nested split's handle above its parent's frame.
          */
          [...Object.values(layout)]
            .sort(
              (a, b) =>
                (a.dir === null ? 0 : 1 + (depths?.get(a.id) ?? 0)) -
                (b.dir === null ? 0 : 1 + (depths?.get(b.id) ?? 0)),
            )
            .map((tile) => {
              const rect = rects.get(tile.id);
              if (rect === undefined || tile.id === ROOT_TILE_ID) return null;
              const structure = isStructure(tile);
              if (!structure && !panelsGrabbable) return null;
              const ref = tile.ref;
              const panelId = ref?.kind === "panel" ? ref.panelId : null;
              const panel = panelId === null ? undefined : host.assembly.panels.get(panelId);
              const title =
                panelId !== null
                  ? (panel?.title ?? panelId)
                  : (STRUCTURE_TITLES[tile.dir ?? (ref === null ? "vacant" : "spacer")] ?? "");
              const depth = depths?.get(tile.id) ?? 1;
              const style: CSSProperties = {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                ["--arrange-depth" as string]: depth,
              };
              const state = `${liveGrab === tile.id ? " is-grabbed" : ""}${
                selected === tile.id ? " is-selected" : ""
              }`;
              const keys = (event: ReactKeyboardEvent<HTMLElement>): void => {
                const direction = ARROW_EDGES[event.key];
                if (direction === undefined) return;
                event.preventDefault();
                nudgeGrip(tile.id, direction);
              };
              /*
              A SPLIT'S GRIP IS A HANDLE AT ITS CORNER, not a cover: its members paint their own
              grips over its whole box, so a full-rect grip would take the pointer from exactly
              the seats it holds. The frame under it paints only the selection, and steps
              down by depth so a stack nested first inside a stack keeps a handle of its own.
            */
              return (
                <span key={tile.id} className="arrange-grip-host" style={style}>
                  {tile.dir !== null ? (
                    <>
                      <span className={`arrange-grip-frame${state}`} aria-hidden="true" />
                      <button
                        type="button"
                        className={`arrange-grip-handle${state}`}
                        data-action="core.space.setLayout"
                        data-tile-id={tile.id}
                        aria-label={`Pick up the ${title}`}
                        onPointerDown={beginGrip}
                        onClick={(event) => event.detail === 0 && toggleSelected(tile.id)}
                      >
                        <ControlIcon kind="grip" size={11} className="arrange-palette-cue" />
                        <ItemIcon kind="structure" size={13} className="arrange-palette-shape" />
                        {title}
                      </button>
                    </>
                  ) : (
                    <button
                      className={`arrange-grip${state}`}
                      data-action="core.space.setLayout"
                      data-panel-id={panelId ?? undefined}
                      data-tile-id={tile.id}
                      aria-label={structure ? `Pick up the ${title}` : `Move the ${title} panel`}
                      onPointerDown={beginGrip}
                      onClick={(event) => event.detail === 0 && toggleSelected(tile.id)}
                      onKeyDown={keys}
                    />
                  )}
                  {tile.dir !== null ? null : (
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
                  )}
                </span>
              );
            })}
      {frame === null
        ? null
        : (() => {
            const prospect =
              layout === null
                ? null
                : tileProspect(layout, frame.aim, frame.tileId, frame.units.dividers);
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
                >
                  {trade ? <ControlIcon kind="swap" size={16} /> : null}
                </div>
                {prospect.partner === null ? null : (
                  <div
                    className="arrange-slot is-swap"
                    style={paint(prospect.partner)}
                    aria-hidden="true"
                  >
                    <ControlIcon kind="swap" size={16} />
                  </div>
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
        style={{
          transform: `translate(-50%, 0) translate(${toolbarOffset.dx}px, ${toolbarOffset.dy}px)`,
        }}
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
          <span className="arrange-toolbar-sep" aria-hidden="true" />
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
        <span className="arrange-toolbar-sep" aria-hidden="true" />
        {/*
          THE PALETTE. Each item is a DRAG SOURCE, not a button — pressing one does nothing,
          because "insert a stack somewhere" was never a question a click could answer without
          the toolbar inventing a second addressing scheme for WHERE. The drag answers it with
          the pointer, through the same seam and zone vocabulary every other carry uses.
          Hence the grip cue and the grab cursor: an item has to LOOK like the thing you pick
          up, in the same grip vocabulary the sidebar's rows and this bar's own handle use.

          Live even while scoped into a panel: in there the panel takes the drop into its own
          arrangement, which is the whole reason the sidebar can be given side-by-side rows.

          AND A DROP TARGET while anything is carried (#148): its state overlay says which of
          the two things letting go here means, and `data-action` names the door a placed
          structure's return opens, since that one writes the tree.
        */}
        <div
          ref={(element) => {
            paletteRef.current = element;
          }}
          className={`arrange-palette${carrying && paletteHot ? " is-hot" : ""}`}
          role="group"
          aria-label="Structure palette"
          data-testid="arrange-palette"
          data-action="core.space.setLayout"
          data-carry={paletteCarry}
          onDragOver={paletteOver}
          onDragLeave={paletteLeave}
          onDrop={paletteDrop}
        >
          {/*
            The state rides an ABSOLUTE overlay and the bar's own copy never changes while
            something is carried, on purpose: a bar that re-flowed under a native drag moved
            the very item the drag began on, and Chromium ends a drag whose source moves out
            from under it. The Escape hint lives here for the same reason — beside the one
            other way out, and costing the bar no width.
          */}
          {carrying ? (
            <span className="arrange-palette-state" role="status">
              <ControlIcon kind={paletteCarry === "remove" ? "discard" : "cancel"} size={13} />
              {paletteCarry === "remove" ? "Drop to remove" : "Drop to cancel"}
              <KeyCap label={keyCapLabel("Escape")} />
              lets go
            </span>
          ) : null}
          {palette.map((tool) => {
            const structure = PALETTE_STRUCTURES[tool.id];
            if (structure === undefined) return null;
            return (
              <button
                key={tool.id}
                type="button"
                className="arrange-palette-item"
                draggable
                data-action="core.space.setLayout"
                data-testid={`palette-${tool.id}`}
                data-dir={structure.kind === "split" ? structure.dir : undefined}
                aria-label={`Drag in a ${tool.title.toLowerCase()}`}
                onDragStart={(event) => beginPaletteDrag(event, structure)}
              >
                <ControlIcon kind="grip" size={11} className="arrange-palette-cue" />
                <ItemIcon
                  kind={structure.kind === "spacer" ? "spacer" : "structure"}
                  size={13}
                  className="arrange-palette-shape"
                />
                {tool.title}
              </button>
            );
          })}
        </div>
        <span className="arrange-toolbar-sep" aria-hidden="true" />
        {/*
          Shelf and Remove are the operations whose verb needs a SEAT rather than the root, so
          they read the selection — tap a grip first. Shelf refuses by name when there is none,
          which the shelf list after it then makes recoverable in one press; Remove is
          disabled until a STRUCTURE is selected, because a panel is never its argument.
        */}
        <div className="arrange-toolbar-tools">
          {operations.map((tool) => {
            const mark = OPERATION_ICONS[tool.id];
            return (
              <button
                key={tool.id}
                type="button"
                className="arrange-toolbar-button"
                data-action="core.space.setLayout"
                data-testid={`toolbar-${tool.id}`}
                disabled={operationsDisabled || (tool.id === "remove" && !selectedStructure)}
                onClick={() => runTool(tool.id)}
              >
                {mark === undefined ? null : <ControlIcon kind={mark} size={13} />}
                {tool.title}
              </button>
            );
          })}
        </div>
        {/*
          LAST, because it is transient: a shelf that appeared mid-bar would shove the palette
          and the operations sideways at the very moment the reader is aiming at them.
        */}
        {shelvedList.length === 0 ? null : (
          <div className="arrange-shelf" role="list" aria-label="Unseated panels">
            <span className="arrange-shelf-label" aria-hidden="true">
              Shelf
            </span>
            {shelvedList.map((entry) => (
              <button
                key={entry.panelId}
                type="button"
                className="arrange-shelf-item"
                data-action="core.space.setLayout"
                data-testid="arrange-shelf-item"
                disabled={operationsDisabled}
                onClick={() => runReseat(entry.panelId)}
              >
                <ItemIcon kind="panel" size={13} />
                {entry.title}
              </button>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}
