import {
  arrangedSections,
  clusteredSections,
  panelRefId,
  projectSectionArrangement,
  releasedSectionArrangement,
  removedSectionStructure,
  type ComposedSection,
  type PanelProps,
  type SectionProjection,
  type SectionProps,
  type SectionRelease,
} from "@manifold/plugin";
import { type SectionNode, type Structure, type TileDir } from "@manifold/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  SectionOutlet,
  carriesItem,
  readEnvelope,
  resolveTileAim,
  tileRects,
  useWorkspaceShell,
  type TileAim,
  type UnitRect,
} from "@manifold/plugin/hooks";
import {
  ControlIcon,
  Disclosure,
  ScrollRegion,
  Stack,
  holdStructure,
  releaseStructure,
  useFlipStack,
  useNotice,
  useVantage,
} from "@manifold/plugin/ui";
import { railTree, type RailNode } from "./rail-rows.ts";
import { railExtents, railPoint, stackPoint, type RailBox } from "./rail-aim.ts";
import { shellManifest } from "./index.ts";

/**
 * THIS PANEL'S OWN REF, spelled the one way a full panel id is ever spelled. The manifest is
 * this package's, so naming its own panel is a plugin naming itself and nothing else — the
 * floor still knows no sidebar. It is what the published arrange scope is compared against:
 * `vantage.arrangeScope` carries a panel ref, and this is the ref that means "in here".
 */
const SIDEBAR_PANEL = panelRefId(shellManifest.id, "sidebar");

/**
 * The `core.shell.sidebar` panel — and there is nothing in it but the rail's own layout.
 *
 * IT USED TO BE FLOOR, on the argument that the sidebar's CHROME has to read the composition
 * to know which sections exist and `useAssembly` was engine state a plugin may not touch.
 * That argument named a missing DOOR, not a floor component: the read is `host.assembly`, a
 * declared read-only surface every plugin may open, so the component followed its manifest.
 * This wave finishes the same sentence one level down. Everything the rail DREW was still
 * hand-written here — the brand line, three create buttons, the status line, the key table's
 * door, the identity footer — so "the sidebar is composed" was true of the middle of the rail
 * and false of its top and bottom, and no reader of the assembly could see the difference.
 * Every one of those is a contributed row now:
 *
 *   `core.shell`        brand · status · keys · identity
 *   `core.canvas`       new-canvas
 *   `core.compositions` new-composition
 *   `core.index`        new-folder · index
 *   `core.machines`     machines
 *   `core.plugins`      plugins
 *
 * One registry, one arrangement, two presentations (`plain` draws itself end to end;
 * `disclosure` is the titled, collapsible block). What is left in this file is the rail's
 * LAYOUT and nothing else: the collapse control, the stack, the chrome each presentation
 * wears, and the arrange gesture that arranges it. There is not one domain noun below this
 * comment — no canvas, no folder, no version, no principal — and that is the property to
 * preserve. A row that needs one belongs to the plugin that owns it.
 *
 * THE COLLAPSE CONTROL STAYS, and it is the only thing that could: how wide the rail is drawn
 * is a fact about the rail, so the control that changes it cannot be a row inside it — a row
 * would be a contribution that decides its own container's geometry, and disabling its plugin
 * would strand a collapsed rail with no way back.
 *
 * Two contexts reach this file, both published by the floor workspace host above the tree,
 * both declared in `@manifold/plugin` because their two ends may not import each other:
 * `useWorkspaceShell` for the facts that are genuinely the HOST's (rail width, this
 * principal's stored arrangement) and `useVantage` for the arrange mode F8 arms and the SCOPE
 * it is standing in. Contributed rows read the same shell context for the rail's width and the
 * creation doors; a section that needs neither never touches it.
 *
 * Everything INSIDE a row is somebody else's plugin: each row's body is reached by
 * {@link SectionOutlet}, which resolves the id to whatever the composition registered and
 * paints the engine's named placeholder when nothing did. The stack knows only the
 * arrangement the manifests declared and whether the owning plugin is enabled — never who
 * fills a row.
 */

/** Per-section disclosure state. Device-LOCAL and in-memory: see the module note below. */
type CollapsedSections = Readonly<Record<string, boolean>>;

/**
 * ── THE RAIL'S DROP GESTURE ──────────────────────────────────────────────────────────
 *
 * The rail is a TILE TREE in disguise (`projectSectionArrangement`), so every question this
 * gesture asks is answered by the kernel every other drag in the application already uses:
 * `resolveTileAim` says which node a pointer aims at and what releasing there would mean, and
 * `releasedSectionArrangement` says which arrangement that release produces. Nothing about
 * seam bands, zone hysteresis, wedging between neighbours or trading two rows is written
 * here; this file measures the boxes and names the door (AGENTS.md invariants 11 and 14).
 *
 * ONE resolution path serves both transports. A row grab is a pointer gesture on the grip that
 * carries a SEAT out of the tree; a palette drop is an HTML5 drag that carries new STRUCTURE
 * into it. They differ in what is in hand — {@link SectionRelease} — and in nothing else,
 * which is what keeps the palette from being a second arrangement policy.
 */

/**
 * THE RAIL HAS NO BORDER RING, and that is a statement about the surface rather than a value
 * left at zero. The kernel's ring is the band along a tile AREA's own border that means "split
 * the whole area", which in a composition is the frame around the panes. The rail's border is
 * the sidebar's edge, and the two bands that would sit on it are already owned by the FIRST
 * and LAST rows — so a ring here would eat the top row's own top band and the bottom row's own
 * bottom band, which are exactly where a reader aims to put a row at the very top or the very
 * bottom of the stack.
 *
 * The consequence is deliberate and worth naming: a seam band is a fraction of the ring
 * (`seamHalf`), so with no ring the seams narrow to the literal divider GAP between two
 * painted rows. A pointer in that gap wedges BETWEEN them; every other pixel belongs to a
 * row's own zones, whose bands are a quarter of the row along the stack's axis.
 */
const RAIL_RING = { x: 0, y: 0 } as const;

/**
 * THE RAIL CARRIES NO SEAT, whatever is in hand, and that is a rail rule rather than a fact
 * about the carry: `carriedTileId` tells the kernel to answer NOTHING over that leaf, and the
 * seat a row came from is the one place in the stack a reader must be able to aim at — putting
 * a row back where it was is an arrangement, not a no-op. `holdsTileSeat` only ever decides
 * whether an occupied centre trades, and there is no trade in a stack (see {@link aimedHold}),
 * so it has nothing to say here either.
 */
const RAIL_CARRY = { carriedTileId: null, holdsTileSeat: false } as const;

/** The tree one gesture aims at, and the geometry it was measured in. */
interface RailGround {
  /** FROZEN with the boxes below: the arrangement every frame of this gesture resolves against. */
  readonly nodes: readonly SectionNode[];
  readonly projection: SectionProjection;
  /** Every painted node's box, keyed by its path: the geometry a pointer is resolved against. */
  readonly boxes: ReadonlyMap<string, RailBox>;
  /** The unit rects of the projected tree, held with the boxes they are read alongside. */
  readonly rects: ReadonlyMap<string, UnitRect>;
  /** The stack's own box, in client px. */
  readonly area: RailBox;
  /** The divider gap as a fraction of each axis: what the kernel measures its seams against. */
  readonly dividers: { readonly x: number; readonly y: number };
}

/**
 * A PLACED STRUCTURE IN HAND (issue #148): one of this rail's own splits, picked up by the grip
 * on its edge. It aims at nothing in the rail — the palette is the one place it can go — so
 * the hold carries only its path and whether the press has become a drag.
 */
interface PlacedStructure {
  readonly kind: "placed";
  readonly path: string;
  readonly moved: boolean;
  readonly startX: number;
  readonly startY: number;
}

/** How far a pointer must travel before a structure grip press becomes a DRAG rather than a TAP. */
const DRAG_THRESHOLD_PX = 6;

/** One live rail gesture: what is held, the geometry it resolves against, and its answer. */
interface RailHold {
  readonly release: SectionRelease | PlacedStructure;
  readonly ground: RailGround;
  /**
   * The zone the kernel is holding, for its hysteresis. It stays valid for the whole gesture
   * because the tree it names paths in is frozen with the ground — which is the other half of
   * why the ground is frozen at all.
   */
  readonly aim: TileAim | null;
  /** What the stack PAINTS: the arrangement the aim means, or the stored one until one lands. */
  readonly arrangement: readonly SectionNode[];
}

/** The row this gesture has in hand, or null for a palette carry. */
function heldSection(hold: RailHold | null): string | null {
  return hold !== null && hold.release.kind === "section" ? hold.release.id : null;
}

/** One structure's identity as a word, so a hold can tell a fresh carry from the one it is on. */
function structureKey(structure: Structure): string {
  return structure.kind === "split" ? `split:${structure.dir}` : structure.kind;
}

/**
 * WHERE EVERY NODE OF ONE ARRANGEMENT IS PAINTED, keyed by the path the projection names it
 * by (`n0`, `n0.1`, …) — the geometry both the tree's ratios ({@link railExtents}) and its hit
 * areas ({@link railPoint}) are read out of, so they can never describe two different rails.
 *
 * By RECT rather than by hit-testing, and that is forced rather than preferred: arrange mode
 * puts `pointer-events: none` on the pane content it disarms, and `elementFromPoint` skips
 * exactly the elements that opted out of the pointer — so the one obvious way to ask this
 * question returns nothing while the mode that needs the answer is on. Every painted node
 * carries `data-section-path`, so the stack names itself and there is no ref plumbing to keep
 * in step with the tree it is describing.
 *
 * A CLUSTER'S MEMBERS SHARE ONE BOX. The arrangement calls them plain siblings, so each of
 * them would report the whole cluster's extent, and the synthetic stack would be one line
 * taller than the rail per cluster — every band below it describing rows it does not cover. So
 * a clustered row takes an even SLICE of its wrapper's box along the stack's own axis: the
 * slices sum to exactly the wrapper whichever way the wrapper happens to flow (the collapsed
 * rail turns a cluster on its side), and each member is reachable inside the space the cluster
 * does occupy.
 */
function paintedBoxes(
  stack: HTMLElement,
  nodes: readonly SectionNode[],
): ReadonlyMap<string, RailBox> {
  const painted = new Map<string, HTMLElement>();
  for (const element of stack.querySelectorAll<HTMLElement>("[data-section-path]")) {
    const path = element.dataset["sectionPath"];
    if (path !== undefined) painted.set(path, element);
  }
  const boxes = new Map<string, RailBox>();
  const walk = (list: readonly SectionNode[], prefix: string, dir: TileDir): void => {
    list.forEach((node, index) => {
      const path = `${prefix}${String(index)}`;
      const element = painted.get(path);
      if (element !== undefined) {
        const cluster = element.parentElement;
        const slices =
          cluster !== null && cluster.dataset["sectionCluster"] !== undefined
            ? Math.max(cluster.childElementCount, 1)
            : 1;
        const shared = slices > 1 && cluster !== null;
        const box = (shared ? cluster : element).getBoundingClientRect();
        const at = shared ? [...cluster.children].indexOf(element) : 0;
        const slice = Math.max(at, 0) / slices;
        boxes.set(
          path,
          dir === "row"
            ? {
                left: box.left + box.width * slice,
                top: box.top,
                width: box.width / slices,
                height: box.height,
              }
            : {
                left: box.left,
                top: box.top + box.height * slice,
                width: box.width,
                height: box.height / slices,
              },
        );
      }
      if (typeof node !== "string") walk(node.sections, `${path}.`, node.dir);
    });
  };
  walk(nodes, "n", "column");
  // The VACANT SEAT is painted by the split rather than by the arrangement — the walk above
  // cannot reach a node the tree does not name — and it is the one box a first row is aimed
  // into, so it is read straight off the element the projection mints its path for.
  for (const [path, element] of painted) {
    if (boxes.has(path)) continue;
    const box = element.getBoundingClientRect();
    boxes.set(path, { left: box.left, top: box.top, width: box.width, height: box.height });
  }
  return boxes;
}

/**
 * One arrangement projected onto the boxes it is painted in, or null on a degenerate stack.
 *
 * No fallback extent on a zero axis, deliberately: it would turn the divider fraction into a
 * divider that eats that whole axis, which is a tree of zero-width bands (`areaUnits` refuses
 * one for the same reason).
 */
function measuredGround(stack: HTMLElement, nodes: readonly SectionNode[]): RailGround | null {
  const box = stack.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const boxes = paintedBoxes(stack, nodes);
  const extents = railExtents(nodes, boxes);
  /*
    The divider is the stack's OWN gap, read off the resolved style rather than repeated as a
    number here: the gap is declared once, in the JSX below, and `0.4rem` is not a count of
    pixels until the browser has resolved the root font size.
  */
  const gap = Number.parseFloat(getComputedStyle(stack).rowGap);
  const dividerPx = Number.isFinite(gap) ? gap : 0;
  const dividers = { x: dividerPx / box.width, y: dividerPx / box.height };
  const projection = projectSectionArrangement(nodes, (path) => extents.get(path) ?? 0);
  return {
    nodes,
    projection,
    boxes,
    rects: tileRects(projection.layout, dividers),
    area: { left: box.left, top: box.top, width: box.width, height: box.height },
    dividers,
  };
}

function openHold(
  stack: HTMLElement,
  nodes: readonly SectionNode[],
  release: RailHold["release"],
): RailHold | null {
  const ground = measuredGround(stack, nodes);
  return ground === null ? null : { release, ground, aim: null, arrangement: nodes };
}

/**
 * The hold one pointer position means: aim through the shared kernel, and paint what releasing
 * there would produce.
 *
 * THE GROUND IS FROZEN WHERE THE GESTURE STARTED, and this is the load-bearing decision of the
 * whole file. The rail previews by REFLOWING — the stack paints the arrangement the aim means,
 * so the release commits exactly what the reader is looking at — which makes the painting a
 * function of the aim. Reading the next frame off that painting closes the loop, and the loop
 * has teeth: seating a row inside a split takes the row's own height out of the stack, so the
 * split slides up out from under the pointer and the very next frame reads a different row and
 * pulls the row back out. A palette carry closes it harder still, since a structure release
 * INSERTS and never removes, so every frame would wedge another split inside the last.
 *
 * Frozen, what the pointer means depends only on where the pointer is: the drop zones hold
 * still underneath it, which is what a drag is supposed to feel like, and the kernel's own
 * hysteresis stays meaningful because the tree an aim names paths in never changes. The rows in
 * the DOM hold still too while it lasts (`useFlipStack`'s `paused`), without which
 * `getBoundingClientRect` would have described rows in flight (issue #94).
 *
 * The SAME hold comes back when nothing changed — the pointer held its zone, the kernel
 * answered nothing (a gap no seam claims), or the release was refused. Referential identity is
 * the "no news" answer, so a frame that moved nothing costs no render.
 */
function aimedHold(hold: RailHold, clientX: number, clientY: number): RailHold {
  // A placed structure aims at nothing here: its one destination is the palette (#148).
  if (hold.release.kind === "placed") return hold;
  const release = hold.release;
  const { nodes, projection, boxes, rects, area, dividers } = hold.ground;
  const layout = projection.layout;
  const held = hold.aim;
  const aim = resolveTileAim(
    layout,
    stackPoint(layout, rects, railPoint(layout, rects, boxes, area, clientX, clientY)),
    RAIL_CARRY,
    dividers,
    RAIL_RING,
    // The held zone travels as the fields the kernel reads, and `between` is optional on one
    // side and optional-or-undefined on the other, so the conversion is explicit.
    held === null
      ? null
      : {
          tileId: held.tileId,
          edge: held.edge,
          ...(held.between === true ? { between: true } : {}),
        },
  );
  if (aim === null) return hold;
  /*
    THE SEAT A ROW CAME FROM MEANS PUT IT BACK — every zone of it, because a row's own slot is
    not a target with five meanings, it is one answer: the arrangement this gesture started
    from. It is what makes a drag REVERSIBLE without letting go, which a frozen ground would
    otherwise cost: the pointer coming home over the row's own seat is the reader saying "never
    mind", and the kernel cannot say it for us (it answers nothing at all over a carried leaf,
    which is why `RAIL_CARRY` never names one).
  */
  const carried = release.kind === "section" ? (projection.pathOf.get(release.id) ?? null) : null;
  const home = carried !== null && aim.tileId === carried;
  /*
    THERE IS NO TRADE IN A STACK, and no centre either: `stackPoint` folds an occupied row's
    middle onto its nearer boundary before the kernel is asked, so the only centre that can
    come back is a VACANT seat's — the one drop a dropped split exists for. A centre that
    reaches here over anything else is a tree the pointer could not have been standing in, and
    the last hold is the honest answer to it.
  */
  const landing = layout[aim.tileId];
  if (!home && aim.edge === "center" && (landing === undefined || landing.ref !== null)) {
    return hold;
  }
  if (
    held !== null &&
    held.tileId === aim.tileId &&
    held.edge === aim.edge &&
    (held.between === true) === (aim.between === true)
  ) {
    return hold;
  }
  const arrangement = home ? nodes : releasedSectionArrangement(projection, release, aim);
  if (arrangement === null) return hold;
  return {
    ...hold,
    aim,
    // The same tree twice is the same paint: keeping the array identity spares the walk below.
    arrangement: sameArrangement(arrangement, hold.arrangement) ? hold.arrangement : arrangement,
  };
}

/** Two arrangements describe the same tree — the "nothing moved, so write nothing" test. */
function sameArrangement(a: readonly SectionNode[], b: readonly SectionNode[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((node, index) => {
    const other = b[index];
    if (typeof node === "string" || typeof other === "string" || other === undefined) {
      return node === other;
    }
    return node.dir === other.dir && sameArrangement(node.sections, other.sections);
  });
}

/**
 * THE AIM ONE ARROW PRESS MEANS: the neighbour the row is to pass, and the edge of it the row
 * lands on. Expressing the keyboard AS AN AIM is what keeps one arrangement policy — the press
 * goes through the very release the drag does, so an arrow and a pointer can never disagree
 * about what "one slot along" produces.
 *
 * WITHIN THE ROW'S OWN PARENT, and no further. A row at the end of a split has no honest next
 * slot: leaving the split to become its parent's sibling is a different gesture from moving
 * inside it, and choosing one for the reader would make the arrows mean two things depending
 * on where the row happens to sit. Inside a split the arrows walk that split; the pointer is
 * how a row leaves one.
 *
 * The neighbour is read off what is PAINTED. Reading it off the arrangement alone would let a
 * press swap a row past a seat nobody can see — a disabled plugin's, or a body the collapsed
 * rail left out — and look like a press that did nothing. A SPLIT is always painted, an empty
 * one included, so the row hops over it as the one node it is.
 */
function nudgeAim(
  nodes: readonly SectionNode[],
  paints: (id: string) => boolean,
  id: string,
  delta: -1 | 1,
): TileAim | null {
  const walk = (list: readonly SectionNode[], prefix: string, dir: TileDir): TileAim | null => {
    const at = list.indexOf(id);
    if (at < 0) {
      for (const [index, node] of list.entries()) {
        if (typeof node === "string") continue;
        const found = walk(node.sections, `${prefix}${String(index)}.`, node.dir);
        if (found !== null) return found;
      }
      return null;
    }
    for (let index = at + delta; index >= 0 && index < list.length; index += delta) {
      const node = list[index];
      if (node === undefined || (typeof node === "string" && !paints(node))) continue;
      const path = `${prefix}${String(index)}`;
      const edge = dir === "column" ? (delta < 0 ? "top" : "bottom") : delta < 0 ? "left" : "right";
      return { tileId: path, edge, action: "place", depth: path.split(".").length };
    }
    return null;
  };
  return walk(nodes, "n", "column");
}

/** Every row the rail paints, for the policies that must not step over an invisible seat. */
function paintedRows(nodes: readonly RailNode[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const walk = (list: readonly RailNode[]): void => {
    for (const node of list) {
      if (node.kind === "row") ids.add(node.row.section.id);
      else walk(node.nodes);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * The FLIP's signature: the whole painted tree, because a reflow can now happen at any depth.
 * A split's members reordering changes no top-level key while changing every sibling's box, so
 * a signature that named only the top level would let the stack teleport.
 */
function railSignature(nodes: readonly RailNode[]): string {
  return nodes
    .map((node) =>
      node.kind === "row"
        ? `${node.row.section.id}${node.row.grow ? "*" : ""}`
        : `${node.path}(${node.dir}:${railSignature(node.nodes)})`,
    )
    .join(" ");
}

interface RowGestures {
  readonly onGrab: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  /** Keyboard arrangement: one slot along, committed immediately. */
  readonly onNudge: (id: string, delta: -1 | 1) => void;
  /** A split's own grip: picked up towards the palette, or tapped to select it (#148). */
  readonly onGrabStructure: (path: string, event: ReactPointerEvent<HTMLElement>) => void;
  readonly onSelectStructure: (path: string) => void;
}

/**
 * A SPLIT'S GRIP (issue #148): the band along the split's leading edge, worn only while this
 * panel is the arrangement in scope. Its members' grips cover the rest of the split's box,
 * so the split itself is reachable at the one strip that is nobody else's — the edge the
 * mode's dashed outline runs along, which is also where a reader looks for "this group".
 *
 * It goes ONE place: the palette, which is where structure comes from and where it goes back
 * to. Nothing in the rail is a target for it, so the stack never reflows under this grip and
 * the pointer stays on the window loop every row grab already uses. A tap SELECTS the split
 * (Delete then removes it), and the same button answers Enter and Space with the same
 * selection, so the keyboard reaches everything the pointer does.
 *
 * `data-action` names the door a release opens: a removed split commits through
 * `core.space.setLayout`, the same door as every other arrangement this panel writes.
 */
function StructureGrip({
  path,
  dir,
  gestures,
}: {
  readonly path: string;
  readonly dir: TileDir;
  readonly gestures: RowGestures;
}): ReactElement {
  return (
    <button
      className="sidebar-split-grip"
      type="button"
      aria-label={`Pick up the ${dir} stack`}
      data-action="core.space.setLayout"
      onPointerDown={(event) => gestures.onGrabStructure(path, event)}
      onClick={(event) => event.detail === 0 && gestures.onSelectStructure(path)}
    />
  );
}

/**
 * THE GRAB SURFACE — how a row is taken hold of, worn by every row whatever its presentation,
 * and present only while THIS panel is the arrangement arrange mode is standing in.
 *
 * It covers the WHOLE row rather than a corner handle, because the mode's promise is that the
 * row IS the thing you are holding — and covering it is also what stops a disclosure from
 * folding under a grab, since the pointer never reaches the toggle underneath.
 *
 * `label` decides whether it is a TAB STOP, and the two answers are forced by the chrome
 * around it. A disclosure row's header is already a real button, so the grip there is inert
 * (`aria-hidden`, no tab stop) and the arrow keys arrive from that header — a `<button>` there
 * would also be a button nested inside one, which is not markup. A plain row has no header
 * and no guaranteed focusable content at all, so its grip IS the tab stop and speaks the
 * row's own title, exactly as the workspace's panel grip speaks a panel's.
 *
 * IT DRAWS NO GLYPH, and neither does the panel grip it is the inner half of. The row's own
 * TINT is the affordance — every grabbable row is washed the mode's blue at once, so what the
 * mode offers is read off the stack in one look instead of hunted for one handle at a time.
 * A grip glyph would also be a lie about the target it names: the grab surface is the whole
 * row, so a 14px icon in the corner of it points at a fraction of what is live.
 *
 * IT IS A POINTER TRANSPORT, never an HTML5 drag source, and that is not a style choice
 * either. The palette's items are `draggable` because they cross from one panel into another;
 * a row is arranged inside the stack it already lives in, and the stack REFLOWS under the
 * pointer to show what releasing will do. `dragstart` would replace those frames with
 * driver-paced `dragover` ones, and the preview is the whole affordance.
 *
 * IT STARTS THE GRAB AND NOTHING ELSE. The frames after the press are the WINDOW's, because
 * the first thing an arrangement does is move this very element: `insertBefore` on an already
 * parented node removes it before re-inserting it, which implicitly releases the pointer
 * capture the press took — so from the first move on, `pointermove` retargeted to whichever
 * row was under the pointer and a handler keyed on "am I the row in hand" stopped answering
 * (issue #94: the drag died after one row). The panel leg above already tracks on the window
 * for the same reason; a row does not merely prefer it, it has no alternative.
 *
 * `data-action` names the door a release opens, so the DOM says which authority this
 * affordance reaches for (AGENTS.md invariant 12): a released arrangement commits through
 * `core.space.setLayout`, the same door the workspace's own panel grip names.
 */
function RowGrip({
  id,
  label,
  gestures,
}: {
  readonly id: string;
  readonly label: string | null;
  readonly gestures: RowGestures;
}): ReactElement {
  const handlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => gestures.onGrab(id, event),
  };
  if (label === null) {
    return (
      <span
        className="sidebar-section-grip"
        aria-hidden="true"
        data-action="core.space.setLayout"
        {...handlers}
      />
    );
  }
  return (
    <button
      className="sidebar-section-grip"
      type="button"
      aria-label={`Move the ${label} row`}
      data-action="core.space.setLayout"
      {...handlers}
    />
  );
}

/**
 * Arranging by KEYBOARD, on the row's own root: the arrow keys bubble up from whatever inside
 * it has focus, so the mode is operable without a pointer and the nudge goes through the very
 * same policy function and the very same commit door the drag does. A mode reachable only by
 * dragging would be a mode half the operators cannot use.
 */
function nudgeKeys(
  id: string,
  gestures: RowGestures,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return (event) => {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
    if (delta === null) return;
    event.preventDefault();
    gestures.onNudge(id, delta);
  };
}

interface RowProps {
  readonly section: ComposedSection;
  /** This row's node path in the arrangement: the gesture's own name for where it sits. */
  readonly path: string;
  /** The stack's height absorber and its icon-rail occupant; see {@link railTree}. */
  readonly grow: boolean;
  readonly host: SectionProps["host"];
  /** Arrange mode is armed: this row is grabbable and nothing inside it is clickable. */
  readonly arranging: boolean;
  /** This is the row in hand right now. */
  readonly grabbed: boolean;
  readonly gestures: RowGestures;
}

interface RowAttributes {
  readonly "data-section-id": string;
  readonly "data-section-path": string;
  readonly "data-plugin": string;
  readonly "data-presentation": string;
  readonly "data-rail-unit": string;
}

/**
 * Which attributes EVERY row carries, whatever chrome it wears: its id (the gate's own
 * queries), its PATH in the arrangement, its owner, its resolved presentation, and the PAINTED
 * UNIT it is. The DOM says who owns a row and how it draws, so neither question needs a class
 * name to be inferred from.
 *
 * `data-section-path` is what the drop gesture measures, and it is a second attribute rather
 * than a reuse of the id because a path is a PLACE and an id is a row: splits have paths and
 * no ids, and a row's path changes every time anything above it moves. It is exactly the id
 * `projectSectionArrangement` mints for this node — `n0`, `n0.1`, … — so the box on screen and
 * the tile the kernel resolved are one thing named one way, with no side table to keep in step.
 *
 * `data-rail-unit` is the FLIP's key, and it is a third attribute for a third reason: a unit is
 * not always a row. A declared cluster paints its members inside one wrapper, the wrapper is
 * what the stack reflows, and the motion module only ever looks at its container's DIRECT
 * children (`useFlipStack`). A lone row is its own unit and names itself.
 */
function rowAttributes(section: ComposedSection, path: string): RowAttributes {
  return {
    "data-section-id": section.id,
    "data-section-path": path,
    "data-plugin": section.plugin,
    "data-presentation": section.presentation,
    "data-rail-unit": section.id,
  };
}

/**
 * DISCLOSURE chrome: a titled header over a scrollable body. The header is the engine's one
 * {@link Disclosure} — it carries the button role, `aria-expanded` and `data-state` for free,
 * and keeps a collapsed body's content in the DOM exactly as the native `<details>` it
 * replaced did, so a folded section's feeds survive the fold. The body is the engine's one
 * {@link ScrollRegion}: each section scrolls ITSELF, vertically only — horizontal overflow is
 * refused by contract, which is what obliges every label in a section to declare ellipsis or
 * wrap.
 *
 * A section supplies no header count and no header actions: a plugin renders its own body and
 * nothing else, so anything it wants to say about itself it says inside that body.
 */
function SectionShell({
  section,
  path,
  grow,
  collapsed,
  onCollapsedChange,
  host,
  arranging,
  grabbed,
  gestures,
}: RowProps & {
  readonly collapsed: boolean;
  readonly onCollapsedChange: (id: string, collapsed: boolean) => void;
}): ReactElement {
  return (
    <Disclosure
      className={`sidebar-section${grow ? " sidebar-section--grow" : ""}${
        grabbed ? " sidebar-section--grabbed" : ""
      }`}
      data-testid={`${section.id}-section`}
      {...rowAttributes(section, path)}
      open={!collapsed}
      onOpenChange={(open) => onCollapsedChange(section.id, !open)}
      headerClassName="sidebar-section-header"
      bodyClassName="sidebar-section-body"
      onKeyDown={arranging ? nudgeKeys(section.id, gestures) : undefined}
      header={
        <>
          {arranging ? <RowGrip id={section.id} label={null} gestures={gestures} /> : null}
          <span className="sidebar-section-chevron" aria-hidden="true">
            <ControlIcon kind="collapsed" size={13} />
          </span>
          <strong className="sidebar-section-title">{section.title}</strong>
        </>
      }
    >
      <ScrollRegion className="sidebar-section-scroll">
        <SectionOutlet id={section.id} host={host} />
      </ScrollRegion>
    </Disclosure>
  );
}

/**
 * PLAIN chrome: a bare box around the row's own content, and deliberately almost nothing.
 *
 * No header, no fold, no scroll region — a plain row draws itself end to end, which is the
 * whole reason the presentation exists: a create strip, a brand line, a status line and an
 * identity footer are not collapsible blocks, and forcing them into disclosure chrome is what
 * kept them hand-written in this file for as long as it lasted. The wrapper carries exactly
 * what the STACK needs (the row's identity for geometry and motion, its owner, its
 * presentation) plus the grab surface the mode adds, and it may not scroll: a row that
 * outgrows the rail is the row's own contract to keep.
 */
function PlainRow({
  section,
  path,
  host,
  arranging,
  grabbed,
  gestures,
}: Omit<RowProps, "grow">): ReactElement {
  return (
    <div
      className={`sidebar-plain${grabbed ? " sidebar-plain--grabbed" : ""}`}
      {...rowAttributes(section, path)}
      onKeyDown={arranging ? nudgeKeys(section.id, gestures) : undefined}
    >
      {arranging ? <RowGrip id={section.id} label={section.title} gestures={gestures} /> : null}
      <SectionOutlet id={section.id} host={host} />
    </div>
  );
}

export function SidebarPanel({ host }: PanelProps): ReactElement {
  const assembly = host.assembly;
  /*
    Every field this panel reads is taken ONCE, here: `registerSidebarElement` is a ref
    callback, and reading further properties off the same object afterwards would be reading
    through a ref during render. The shell hands out plain values; naming them plainly is
    what keeps that true.
  */
  const {
    commitSectionArrangement,
    registerSidebarElement,
    sectionArrangement,
    setSidebarOpen,
    sidebarOpen,
  } = useWorkspaceShell();
  /**
   * ARRANGING THIS PANEL'S ROWS is not the same thing as arrange mode being armed. The mode
   * is one; the arrangement it is standing in is `vantage.arrangeScope`, and these rows are
   * grabbable — and this stack accepts the palette — only when that scope IS this panel: the
   * reader zoomed in on the control the workspace draws on this panel's name.
   *
   * Read off presence rather than handed down as a prop, exactly as the mode itself always
   * was: the scope is published, so the panel decides what it offers by comparing a ref it
   * owns against a value every collaborator can also read (invariant 11). Nothing here holds
   * a second copy of "am I the live arrangement".
   */
  const { arranging, arrangeScope } = useVantage();
  const scopedIn = arranging && arrangeScope === SIDEBAR_PANEL;
  /** The one notice channel, for the refusal a silent no-op would hide (the spacer, below). */
  const { notify } = useNotice();
  /*
   * Per-section disclosure is in-memory only. The sidebar's four private storage keys are gone
   * with the rest of its device-only state (D13): a row's PLACE now comes from its manifest,
   * its presence from the roster, and the rail's width from the workspace layout — all three
   * observable by every principal. Which sections one tab happened to fold shut is the one
   * piece of that state nobody else can act on, so it is not worth a key, a register entry, or
   * a migration; it lasts as long as the tab does.
   */
  const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>({});
  /**
   * THE GESTURE IN FLIGHT, and the arrangement it has dragged the stack into so far.
   *
   * `arrangement` is the WIRE FORM — the exact node tree the layout tile stores — and the
   * stack below renders it without knowing whether it came from this pointer, from the palette
   * or from the server (AGENTS.md invariant 11). That is what makes the live preview and the
   * committed arrangement one derivation instead of a drag path beside a render path.
   *
   * A REF BESIDE THE STATE, for the reason the workspace's layout drag keeps one: the state is
   * what renders, the ref is what the GESTURE reads. A grab writes state and the very next
   * pointer frame arrives before React has re-rendered, so a handler reading the state
   * variable through its closure sees `null` and drops the frame — which is exactly how a
   * quick flick committed nothing at all. The ref is the read; the state is the paint.
   */
  const [hold, setHold] = useState<RailHold | null>(null);
  const holdRef = useRef<RailHold | null>(null);
  const holdRail = (next: RailHold | null): void => {
    holdRef.current = next;
    setHold(next);
  };

  // Leaving the arrangement mid-gesture drops what was in hand — whether the mode ended or the
  // reader merely zoomed back out to the workspace: the release is the commit, so a gesture
  // that never released must not survive as a pending arrangement. The STATE resets during
  // render (React's derived-state guidance — an effect would paint one stale frame first);
  // the REF resets in an effect, because a ref is for event handlers, and the next pointer
  // frame after leaving must read "nothing in hand".
  if (!scopedIn && hold !== null) {
    setHold(null);
  }
  useEffect(() => {
    if (!scopedIn) {
      holdRef.current = null;
      releaseStructure();
    }
  }, [scopedIn]);

  /**
   * THE SELECTED SPLIT, by path — Delete's argument (issue #148). Device-local and in-memory
   * like the disclosure state: it names a place in THIS reader's arrangement and lasts until
   * the arrangement changes under it, because a path is positional and the next commit may
   * put a different node at it.
   */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  if (!scopedIn && selectedPath !== null) setSelectedPath(null);

  /**
   * WHAT THE STACK IS ARRANGED INTO. Manifest order is the default; this principal's stored
   * arrangement overrides it; a gesture in flight overrides that for as long as it is held.
   * Three inputs, one answer, and the merge itself is the tested policy module rather than
   * arithmetic inlined here (`arrangedSections`, `packages/plugin/src/layout.ts`).
   *
   * An arrangement is a TREE since issue #104 — section ids and SPLITS of more of them — so
   * the answer is walked rather than iterated. It is computed over EVERY declared row and
   * filtered for enabled afterwards, so a disabled plugin's slot closes without its stored
   * place being forgotten — D4′ (ADR 0013): chrome renders absence, and re-enabling restores
   * the exact seat the principal chose. That filter, which row absorbs the rail's leftover
   * height, and the path every node is named by are {@link railTree}.
   */
  const declaredIds = assembly.sections.map((section) => section.id);
  const storedNodes = arrangedSections(declaredIds, sectionArrangement);
  const liveNodes = hold?.arrangement ?? storedNodes;
  const tree = railTree(assembly.sections, liveNodes, sidebarOpen);

  /**
   * MOTION, because the arrangement is DATA. The stack reflows for three reasons a reader did
   * not necessarily cause — their own arrange commit or nudge, and a roster change that adds
   * or removes somebody else's row — and a re-render teleports. FLIP plays the difference,
   * keyed on the visible tree, so a nudge shows which row moved and a disabled plugin's row is
   * seen to leave (`@manifold/plugin/ui`'s `useFlipStack`; `prefers-reduced-motion: reduce`
   * turns every transform off, which is the plain re-render this had before).
   *
   * A LIVE GESTURE IS THE EXCEPTION, and it is not a taste call. The preview used to animate
   * too, on the argument that the drag and the commit are one derivation — but the pointer is
   * already the motion, and an animating row reports its TRANSFORM from
   * `getBoundingClientRect`, so the gesture's own measurement read rows in flight: a swap slid
   * the displaced neighbour back under the pointer, the next frame swapped it back, and the
   * stack rang instead of arranging (issue #94). While anything is in hand the stack holds
   * still and the rows are exactly where the layout says they are; the release commits the
   * arrangement the preview is already showing, so there is nothing left to play.
   */
  const flipStack = useFlipStack(railSignature(tree), {
    attribute: "data-rail-unit",
    paused: hold !== null,
  });
  /*
    The stack's element, for the one thing the FLIP's own ref cannot answer: WHERE the stack is.
    Every gesture measures its box and the boxes inside it, and a gesture that began on a grip
    has no event target of the stack's to read it off (`openHold`).
  */
  const stackRef = useRef<HTMLDivElement | null>(null);
  const registerStack = useCallback(
    (element: HTMLDivElement | null): void => {
      stackRef.current = element;
      flipStack(element);
    },
    [flipStack],
  );

  /**
   * ONE ACTION PER GESTURE. The drag repaints per frame off `hold.arrangement` and writes
   * nothing; the release compares what is in hand against what is stored and commits once,
   * through the workspace layout door — the plane rule's commit point (AGENTS.md invariant 13).
   */
  const commitIfMoved = (arrangement: readonly SectionNode[]): void => {
    if (!sameArrangement(arrangement, storedNodes)) commitSectionArrangement(arrangement);
    setSelectedPath(null);
  };

  /**
   * REMOVE, the rail's leg (issue #148): the split at `path` dissolves into its members, in
   * place, through the engine's one inverse of the palette's insert — and commits through the
   * same door every arrangement here takes. Two doors open onto it: a grip released on the
   * palette, and Delete with the split selected. A path that names nothing removable is a
   * stale selection, and a stale selection is cleared rather than acted on.
   */
  const removeStructure = (path: string): void => {
    const next = removedSectionStructure(
      projectSectionArrangement(storedNodes, () => 1),
      path,
    );
    if (next !== null) commitIfMoved(next);
    else setSelectedPath(null);
  };

  const gestures: RowGestures = {
    onGrab: (id, event) => {
      // The grab surface sits over the disclosure's toggle: swallowing the event here is what
      // keeps a grab from folding the section it is about to move — and `preventDefault` is
      // also what keeps the drag from selecting the text it passes over, which is the job
      // pointer capture would have done if an arrangement let it live.
      event.preventDefault();
      event.stopPropagation();
      const stack = stackRef.current;
      if (stack === null) return;
      holdRail(openHold(stack, storedNodes, { kind: "section", id }));
    },
    onNudge: (id, delta) => {
      /*
        ONE PRESS, ONE VISIBLE MOVE, through the drag's own release. The projection here is
        handed FLAT extents deliberately: `nudgeAim` names its target by PATH, so no geometry
        is consulted at all, and measuring the rail to answer an arrow press would be
        describing boxes nobody is pointing at.
      */
      const aim = nudgeAim(storedNodes, (rowId) => paintedRows(tree).has(rowId), id, delta);
      if (aim === null) return;
      const next = releasedSectionArrangement(
        projectSectionArrangement(storedNodes, () => 1),
        { kind: "section", id },
        aim,
      );
      if (next !== null) commitIfMoved(next);
    },
    onGrabStructure: (path, event) => {
      event.preventDefault();
      event.stopPropagation();
      // `preventDefault` withholds focus; the keyboard doors (Enter, Delete) live on this grip.
      event.currentTarget.focus({ preventScroll: true });
      const stack = stackRef.current;
      if (stack === null) return;
      holdRail(
        openHold(stack, storedNodes, {
          kind: "placed",
          path,
          moved: false,
          startX: event.clientX,
          startY: event.clientY,
        }),
      );
    },
    onSelectStructure: (path) => {
      setSelectedPath((current) => (current === path ? null : path));
    },
  };

  /**
   * THE REST OF A ROW GRAB, on the window, for as long as a row is in hand.
   *
   * Not on the grip, and not by pointer capture: an arrangement MOVES the grabbed row, and
   * moving a node re-inserts it, and re-inserting it releases the capture the press took.
   * Every frame after the first move then arrived at whatever row had slid under the pointer,
   * so the drag deadended one row from where it started (issue #94). The window is the one
   * listener the stack cannot reorder out from under itself.
   *
   * A PLACED SPLIT rides the same loop (issue #148) and differs in what its frames mean: past
   * the drag threshold it is in hand for the palette (`holdStructure`, the engine's one slot
   * for a structure in the air) and aims at nothing here; short of it, the release is a TAP
   * that selects. Either way the palette's own listener is what takes it — this loop only
   * clears the hand afterwards.
   *
   * ESCAPE ENDS THE CARRY AND NOTHING ELSE: claimed here, in the capture phase, so the mode's
   * own Escape (which pops the scope) sees the key already taken and leaves the scope where
   * the reader is standing. A gesture that never released commits nothing.
   *
   * NO DEPENDENCY LIST, deliberately: the handlers close over this render's arrangement and
   * its commit door, so re-subscribing per commit is how they stay current. It costs four
   * listener swaps on the handful of renders a drag produces, and the alternative is a ref
   * per value with the same lifetime and none of the clarity.
   */
  useEffect(() => {
    if (hold === null || hold.release.kind === "structure") return;
    const move = (event: PointerEvent): void => {
      const held = holdRef.current;
      if (held === null) return;
      if (held.release.kind === "placed") {
        const release = held.release;
        if (release.moved) return;
        if (
          Math.hypot(event.clientX - release.startX, event.clientY - release.startY) <
          DRAG_THRESHOLD_PX
        ) {
          return;
        }
        holdRail({ ...held, release: { ...release, moved: true } });
        holdStructure({ remove: () => removeStructure(release.path) });
        return;
      }
      const next = aimedHold(held, event.clientX, event.clientY);
      if (next !== held) holdRail(next);
    };
    const end = (): void => {
      const held = holdRef.current;
      holdRail(null);
      if (held === null) return;
      if (held.release.kind === "placed") {
        if (!held.release.moved) gestures.onSelectStructure(held.release.path);
        releaseStructure();
        return;
      }
      // The commit door itself is the "did anything move" test, so a gesture that resolved an
      // aim and came back to where it started writes nothing.
      commitIfMoved(held.arrangement);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || holdRef.current === null) return;
      event.preventDefault();
      holdRail(null);
      releaseStructure();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", escape, true);
    };
  });

  /*
    The rail is one body and has nothing to arrange against, so the gesture is offered only
    while the sidebar is open. The MODE stays on either way — the workspace is still armed,
    the panes still say so — and so does the SCOPE: zooming out is the reader's move, never a
    consequence of collapsing the rail.
  */
  const arrangingRows = scopedIn && sidebarOpen;
  const grabbedId = heldSection(hold);
  const grabbedPath =
    hold !== null && hold.release.kind === "placed" && hold.release.moved
      ? hold.release.path
      : null;

  /*
    DELETE AND BACKSPACE REMOVE THE SELECTED SPLIT (issue #148): the keyboard's door onto the
    same removal the palette drop performs, offered while these rows are the arrangement in
    scope and there is a selection to act on. A key a text field is taking is left to it.
  */
  useEffect(() => {
    if (!arrangingRows || selectedPath === null) return;
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
      removeStructure(selectedPath);
    };
    window.addEventListener("keydown", remove);
    return () => window.removeEventListener("keydown", remove);
  });

  /**
   * THE PALETTE'S END OF THE SAME GESTURE: an HTML5 drag carrying new STRUCTURE, which this
   * stack accepts exactly while it is the arrangement being arranged.
   *
   * The payload is sealed during `dragover` by the HTML5 spec, so the envelope is read back
   * out of the carry register the source wrote at `dragstart` (`readEnvelope`) — the one
   * mechanism every drop target in the application uses. Anything that is not structure is
   * left alone: a canvas, a terminal or a pane has no meaning in a row stack, and declining to
   * `preventDefault` is how a target says "not here" without inventing a second answer.
   */
  const carriedStructure = (transfer: DataTransfer | null): Structure | null => {
    if (transfer === null || !carriesItem(transfer)) return null;
    const envelope = readEnvelope(transfer);
    return envelope !== null && envelope.kind === "structure" ? envelope.structure : null;
  };

  /** The hold this carry belongs to: the one already in flight, or a fresh measurement. */
  const structureHold = (stack: HTMLDivElement, structure: Structure): RailHold | null => {
    const held = holdRef.current;
    if (
      held !== null &&
      held.release.kind === "structure" &&
      structureKey(held.release.structure) === structureKey(structure)
    ) {
      return held;
    }
    return openHold(stack, storedNodes, { kind: "structure", structure });
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!arrangingRows) return;
    const structure = carriedStructure(event.dataTransfer);
    if (structure === null) return;
    /*
      Accepting the drop is what earns the `drop` event — including for the spacer below,
      whose refusal has to be SAID, and a target that never accepts is never asked.

      `copy`, because that is what the palette sealed (`effectAllowed`, `beginPaletteDrag`): a
      palette item is a source that never empties, so nothing leaves anywhere. It is not
      cosmetic. A `dropEffect` outside the source's `effectAllowed` makes the current drag
      operation `none`, and the browser then CANCELS the drop outright — no `drop` event, no
      commit, no notice, and a target that looks armed and does nothing.
    */
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (structure.kind === "spacer") return;
    const open = structureHold(event.currentTarget, structure);
    if (open === null) return;
    const next = aimedHold(open, event.clientX, event.clientY);
    if (next !== holdRef.current) holdRail(next);
  };

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    /*
      `dragleave` also fires every time the pointer crosses from the stack onto a row inside
      it, so the carry is dropped only once it has genuinely left the stack's subtree —
      otherwise the preview would flicker out under a pointer that never left the rail.
    */
    const to = event.relatedTarget;
    if (to instanceof Node && event.currentTarget.contains(to)) return;
    if (holdRef.current?.release.kind === "structure") holdRail(null);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!arrangingRows) return;
    const structure = carriedStructure(event.dataTransfer);
    if (structure === null) return;
    event.preventDefault();
    if (structure.kind === "spacer") {
      /*
        A SPACER IS REFUSED, and it is refused OUT LOUD. `releasedSectionArrangement` answers
        null for one, so a handler that merely dropped it would look like a release that landed
        on nothing — and the reason is a real rule about this surface rather than a gap in the
        kernel: a row stack has no ratios for an inert leaf to hold open, so a spacer here
        would be a row that renders nothing and can never be filled.
      */
      holdRail(null);
      notify(
        "A spacer has nothing to hold open in the sidebar: the rail's rows take the width they are given.",
        {
          key: "sidebar-structure-refused",
        },
      );
      return;
    }
    const open = structureHold(event.currentTarget, structure);
    holdRail(null);
    if (open === null) return;
    // Resolved FRESH from the release point rather than trusting the last `dragover` frame: a
    // drop can land a few pixels from wherever the last frame was reported.
    const released = aimedHold(open, event.clientX, event.clientY);
    commitIfMoved(released.arrangement);
  };

  /**
   * THE PAINT WALK. One level of the tree becomes one list of painted UNITS, and a unit is a
   * lone node or the members of one declared cluster — which is how `core.keys` and
   * `core.plugins` sit side by side at the rail's foot without this panel knowing either name
   * (`clusteredSections`, the engine's tested policy). A SPLIT is a unit of its own wherever it
   * sits: it declares no cluster, so it is never folded into somebody else's.
   *
   * Clustering runs per LEVEL, because that is the only level at which "beside each other" is
   * a question at all — two rows in different splits are not neighbours, whatever word they
   * declared.
   */
  const paintNode = (node: RailNode): ReactNode => {
    if (node.kind === "split") {
      const vacant = node.nodes.length === 0;
      return (
        <div
          className={`sidebar-split${grabbedPath === node.path ? " sidebar-split--grabbed" : ""}${
            selectedPath === node.path ? " sidebar-split--selected" : ""
          }`}
          data-dir={node.dir}
          data-section-path={node.path}
          data-rail-unit={node.path}
          {...(vacant ? { "data-vacant": "true" } : {})}
          key={node.path}
        >
          {arrangingRows ? (
            <StructureGrip path={node.path} dir={node.dir} gestures={gestures} />
          ) : null}
          {/*
            AN EMPTY SPLIT IS A SEAT, not a nothing: it is what the palette's own drop produces,
            and it has to be visible enough to aim the next row into while the mode is on and
            take no space at all when it is off. The wireframe is one element and the stylesheet
            decides the rest (`.sidebar-split-seat`) — the rail's row vocabulary is floor CSS,
            because rows belonging to plugins that have never heard of each other wear it.

            It names its PATH like every other painted node, and it is the one node whose path
            the arrangement does not contain: an empty split has no members, so the projection
            mints this seat itself (`projectSectionArrangement`) and only the element can say
            where it was drawn. Without it the first row into a fresh split is aimed at the
            split's whole box, padding and all, rather than at the dashed rectangle a reader
            is actually looking at.
          */}
          {vacant ? (
            <div className="sidebar-split-seat" data-section-path={`${node.path}.0`} />
          ) : (
            paintLevel(node.nodes)
          )}
        </div>
      );
    }
    const { section, grow } = node.row;
    const key = `${section.plugin}.${section.id}`;
    return section.presentation === "plain" ? (
      <PlainRow
        section={section}
        path={node.path}
        host={host}
        arranging={arrangingRows}
        grabbed={grabbedId === section.id}
        gestures={gestures}
        key={key}
      />
    ) : (
      <SectionShell
        section={section}
        path={node.path}
        grow={grow}
        collapsed={sidebarOpen && collapsedSections[section.id] === true}
        onCollapsedChange={(id, collapsed) => {
          // The icon rail force-opens its one body; that is layout, not a choice.
          if (!sidebarOpen) return;
          setCollapsedSections((current) =>
            current[id] === collapsed ? current : { ...current, [id]: collapsed },
          );
        }}
        host={host}
        arranging={arrangingRows}
        grabbed={grabbedId === section.id}
        gestures={gestures}
        key={key}
      />
    );
  };

  const paintLevel = (nodes: readonly RailNode[]): readonly ReactNode[] => {
    const units = clusteredSections(nodes, (node) =>
      node.kind === "row" ? node.row.section.cluster : undefined,
    );
    return units.map((unit) => {
      const painted = unit.rows.map((node) => paintNode(node));
      /*
        A LONE NODE IS PAINTED BARE, and that is not an optimization: a wrapper around every row
        would change the stack's DOM for every plugin in the tree to express something only a
        cluster's members declared, and the FLIP measures direct children — so the unwrapped row
        stays its own unit and keeps naming itself (`data-rail-unit`).

        A CLUSTER gets the wrapper, which is the only thing that knows the word: the members
        inside it are ordinary rows with ordinary attributes, and the rail's own stylesheet
        decides what "side by side" looks like (`.sidebar-cluster`, the floor's row vocabulary —
        two plugins' rows wear it, so it cannot live in either package).
      */
      if (unit.cluster === null) return painted[0];
      const key = `cluster:${unit.cluster}`;
      return (
        <div
          className="sidebar-cluster"
          data-rail-unit={key}
          data-section-cluster={unit.cluster}
          key={key}
        >
          {painted}
        </div>
      );
    });
  };

  return (
    <aside className="sidebar" aria-label="Sidebar" ref={registerSidebarElement}>
      {/*
        The rail's own control, and the reason it is not a row: it changes the rail's width.
        Open, it sits in the top-right corner over the first row — where it has always been,
        beside the brand line that is now a contribution. Collapsed, the rail has no corner to
        spare and the control takes the top of the icon strip (`.sidebar-collapse`).
      */}
      <div className="sidebar-collapse">
        <button
          className="sidebar-icon-button"
          type="button"
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <ControlIcon kind={sidebarOpen ? "sidebarCollapse" : "sidebarExpand"} />
        </button>
      </div>

      <Stack
        className="sidebar-sections"
        gap="0.4rem"
        ref={registerStack}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {paintLevel(tree)}
      </Stack>
    </aside>
  );
}
