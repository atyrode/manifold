import {
  arrangedSectionIds,
  clusteredSections,
  crossedSectionId,
  movedSectionIds,
  panelRefId,
  type ComposedSection,
  type PanelProps,
  type SectionBox,
  type SectionProps,
} from "@manifold/plugin";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { SectionOutlet, useWorkspaceShell } from "@manifold/plugin/hooks";
import {
  ControlIcon,
  Disclosure,
  ScrollRegion,
  Stack,
  useFlipStack,
  useVantage,
} from "@manifold/plugin/ui";
import { railRows } from "./rail-rows.ts";
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
 * One registry, one order, two presentations (`plain` draws itself end to end; `disclosure`
 * is the titled, collapsible block). What is left in this file is the rail's LAYOUT and
 * nothing else: the collapse control, the stack, the chrome each presentation wears, and the
 * arrange gesture that reorders it. There is not one domain noun below this comment — no
 * canvas, no folder, no version, no principal — and that is the property to preserve. A row
 * that needs one belongs to the plugin that owns it.
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
 * paints the engine's named placeholder when nothing did. The stack knows only the order the
 * manifests declared and whether the owning plugin is enabled — never who fills a row.
 */

/** Per-section disclosure state. Device-LOCAL and in-memory: see the module note below. */
type CollapsedSections = Readonly<Record<string, boolean>>;

/** One live section grab: what is held, and the order the stack is showing because of it. */
interface SectionGrab {
  readonly moved: string;
  readonly order: readonly string[];
}

/**
 * The rows as they are PAINTED, top to bottom, for the drag's own policy to read.
 *
 * By RECT rather than by hit-testing, and that is forced rather than preferred: arrange mode
 * puts `pointer-events: none` on the pane content it disarms, and `elementFromPoint` skips
 * exactly the elements that opted out of the pointer — so the one obvious way to ask this
 * question returns nothing while the mode that needs the answer is on. Rows already carry
 * `data-section-id` for the gate's own queries, so the stack names itself and there is no ref
 * plumbing to keep in step with the order it is describing.
 *
 * These boxes are only trustworthy because the stack HOLDS STILL while a row is in hand
 * (`useFlipStack`'s `paused`): `getBoundingClientRect` reports transforms, so measuring a
 * stack mid-FLIP would describe where the rows are sliding rather than where they now sit.
 */
function sectionBoxes(): readonly SectionBox[] {
  const boxes: SectionBox[] = [];
  for (const element of document.querySelectorAll<HTMLElement>("[data-section-id]")) {
    const id = element.dataset["sectionId"];
    if (id === undefined) continue;
    const box = element.getBoundingClientRect();
    boxes.push({ id, top: box.top, bottom: box.bottom });
  }
  return boxes;
}

interface RowGestures {
  readonly onGrab: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  /** Keyboard arrangement: one slot up or down, committed immediately. */
  readonly onNudge: (id: string, delta: -1 | 1) => void;
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
 * IT STARTS THE GRAB AND NOTHING ELSE. The frames after the press are the WINDOW's, because
 * the first thing a reorder does is move this very element: `insertBefore` on an already
 * parented node removes it before re-inserting it, which implicitly releases the pointer
 * capture the press took — so from the first swap on, `pointermove` retargeted to whichever
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
  /** The stack's height absorber and its icon-rail occupant; see {@link railRows}. */
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
  readonly "data-plugin": string;
  readonly "data-presentation": string;
  readonly "data-rail-unit": string;
}

/**
 * Which attributes EVERY row carries, whatever chrome it wears: its id (the stack's own
 * geometry query and the gate's), its owner, its resolved presentation, and the PAINTED UNIT it
 * is. The DOM says who owns a row and how it draws, so neither question needs a class name to
 * be inferred from.
 *
 * `data-rail-unit` is the FLIP's key, and it is a second attribute rather than a reuse of the
 * id because a unit is not always a row: a declared cluster paints its members inside one
 * wrapper, the wrapper is what the stack reflows, and the motion module only ever looks at its
 * container's DIRECT children (`useFlipStack`). A lone row is its own unit and names itself.
 */
function rowAttributes(section: ComposedSection): RowAttributes {
  return {
    "data-section-id": section.id,
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
      {...rowAttributes(section)}
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
  host,
  arranging,
  grabbed,
  gestures,
}: Omit<RowProps, "grow">): ReactElement {
  return (
    <div
      className={`sidebar-plain${grabbed ? " sidebar-plain--grabbed" : ""}`}
      {...rowAttributes(section)}
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
  const { commitSectionOrder, registerSidebarElement, sectionOrder, setSidebarOpen, sidebarOpen } =
    useWorkspaceShell();
  /**
   * ARRANGING THIS PANEL'S ROWS is not the same thing as arrange mode being armed. The mode
   * is one; the arrangement it is standing in is `vantage.arrangeScope`, and these rows are
   * grabbable only when that scope IS this panel — the reader zoomed in on the control the
   * workspace draws on this panel's name.
   *
   * Read off presence rather than handed down as a prop, exactly as the mode itself always
   * was: the scope is published, so the panel decides what it offers by comparing a ref it
   * owns against a value every collaborator can also read (invariant 11). Nothing here holds
   * a second copy of "am I the live arrangement".
   */
  const { arranging, arrangeScope } = useVantage();
  const scopedIn = arranging && arrangeScope === SIDEBAR_PANEL;
  /*
   * Per-section disclosure is in-memory only. The sidebar's four private storage keys are gone
   * with the rest of its device-only state (D13): a row's ORDER now comes from its manifest,
   * its presence from the roster, and the rail's width from the workspace layout — all three
   * observable by every principal. Which sections one tab happened to fold shut is the one
   * piece of that state nobody else can act on, so it is not worth a key, a register entry, or
   * a migration; it lasts as long as the tab does.
   */
  const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>({});
  /**
   * THE ROW IN HAND, and the order it has dragged the stack into so far.
   *
   * `order` is the WIRE FORM — the exact `readonly string[]` the layout tile stores — and the
   * stack below renders it without knowing whether it came from this pointer or from the
   * server (AGENTS.md invariant 11). That is what makes the live preview and the committed
   * arrangement one derivation instead of a drag path beside a render path.
   *
   * A REF BESIDE THE STATE, for the reason the workspace's layout drag keeps one: the state is
   * what renders, the ref is what the GESTURE reads. A grab writes state and the very next
   * pointer frame arrives before React has re-rendered, so a handler reading the state
   * variable through its closure sees `null` and drops the frame — which is exactly how a
   * quick flick committed nothing at all. The ref is the read; the state is the paint.
   */
  const [grab, setGrab] = useState<SectionGrab | null>(null);
  const grabRef = useRef<SectionGrab | null>(null);
  const holdSection = (next: SectionGrab | null): void => {
    grabRef.current = next;
    setGrab(next);
  };

  // Leaving the arrangement mid-grab drops what was in hand — whether the mode ended or the
  // reader merely zoomed back out to the workspace: the release is the commit, so a gesture
  // that never released must not survive as a pending arrangement. The STATE resets during
  // render (React's derived-state guidance — an effect would paint one stale frame first);
  // the REF resets in an effect, because a ref is for event handlers, and the next pointer
  // frame after leaving must read "nothing in hand".
  if (!scopedIn && grab !== null) {
    setGrab(null);
  }
  useEffect(() => {
    if (!scopedIn) grabRef.current = null;
  }, [scopedIn]);

  /**
   * WHAT ORDER THE STACK IS IN. Manifest order is the default; this principal's stored
   * arrangement overrides it; a live grab overrides that for as long as it is held. Three
   * inputs, one answer, and the merge itself is the tested policy module rather than
   * arithmetic inlined here (`arrangedSectionIds`, `packages/plugin/src/layout.ts`).
   *
   * The order is computed over EVERY declared row and filtered for enabled afterwards, so a
   * disabled plugin's slot closes without its stored place being forgotten — D4′ (ADR 0013):
   * chrome renders absence, and re-enabling restores the exact seat the principal chose. That
   * filter, and which row absorbs the rail's leftover height, are {@link railRows}.
   */
  const declaredIds = assembly.sections.map((section) => section.id);
  const arrangedIds = arrangedSectionIds(declaredIds, sectionOrder);
  const liveIds = grab?.order ?? arrangedIds;
  const rows = railRows(assembly.sections, liveIds, sidebarOpen);

  /**
   * WHAT THE STACK ACTUALLY PAINTS: units, not rows. A row that declared a cluster paints beside
   * whoever else declared that word, as one horizontal unit at the cluster's earliest member —
   * which is how `core.keys` and `core.plugins` sit side by side at the rail's foot without this
   * panel knowing either name (`clusteredSections`, the engine's tested policy). Rows that
   * declared nothing come back as one-row units, so an unclustered rail paints exactly as it did.
   */
  const units = clusteredSections(rows, (row) => row.section.cluster);
  /** The unit's own name in the DOM and in the FLIP: a row's id, or the cluster's word. */
  const unitKey = (unit: (typeof units)[number]): string =>
    unit.cluster === null ? (unit.rows[0]?.section.id ?? "") : `cluster:${unit.cluster}`;

  /**
   * MOTION, because the order is DATA. The stack reflows for three reasons a reader did not
   * necessarily cause — their own arrange commit or nudge, and a roster change that adds or
   * removes somebody else's row — and a re-render teleports. FLIP plays the difference, keyed
   * on the visible order, so a nudge shows which row moved and a disabled plugin's row is seen
   * to leave (`@manifold/plugin/ui`'s `useFlipStack`; `prefers-reduced-motion: reduce` turns
   * every transform off, which is the plain re-render this had before).
   *
   * A LIVE DRAG IS THE EXCEPTION, and it is not a taste call. The preview used to animate too,
   * on the argument that the drag and the commit are one derivation — but the pointer is
   * already the motion, and an animating row reports its TRANSFORM from
   * `getBoundingClientRect`, so the gesture's own measurement read rows in flight: a swap slid
   * the displaced neighbour back under the pointer, the next frame swapped it back, and the
   * stack rang instead of reordering (issue #94). While a row is in hand the stack holds still
   * and the rows are exactly where the layout says they are; the release commits the order the
   * preview is already showing, so there is nothing left to play.
   */
  const flipStack = useFlipStack(units.map(unitKey).join(" "), {
    attribute: "data-rail-unit",
    paused: grab !== null,
  });

  /**
   * ONE ACTION PER GESTURE. The drag repaints per frame off `grab.order` and writes nothing;
   * the release compares what is in hand against what is stored and commits once, through the
   * workspace layout door — the plane rule's commit point (AGENTS.md invariant 13).
   */
  const commitIfMoved = (order: readonly string[]): void => {
    const moved =
      order.length !== arrangedIds.length || order.some((id, index) => id !== arrangedIds[index]);
    if (moved) commitSectionOrder(order);
  };

  const gestures: RowGestures = {
    onGrab: (id, event) => {
      // The grab surface sits over the disclosure's toggle: swallowing the event here is what
      // keeps a grab from folding the section it is about to move — and `preventDefault` is
      // also what keeps the drag from selecting the text it passes over, which is the job
      // pointer capture would have done if a reorder let it live.
      event.preventDefault();
      event.stopPropagation();
      holdSection({ moved: id, order: arrangedIds });
    },
    onNudge: (id, delta) => {
      /*
        ONE PRESS, ONE VISIBLE MOVE. The neighbour is read off what is PAINTED and the move is
        applied to what is STORED, which is the same split the drag has (`sectionBoxes` reads
        geometry; `movedSectionIds` rewrites the whole order). Reading the neighbour off the
        stored order instead would let an arrow press swap a row past a seat nobody can see —
        a disabled plugin's, or a body the collapsed rail left out — and look like a press
        that did nothing.
      */
      const painted = rows.map((row) => row.section.id);
      const from = painted.indexOf(id);
      const over = painted[from + delta];
      if (over === undefined) return;
      commitIfMoved(movedSectionIds(arrangedIds, id, over));
    },
  };

  /**
   * THE REST OF THE GESTURE, on the window, for as long as a row is in hand.
   *
   * Not on the grip, and not by pointer capture: a reorder MOVES the grabbed row, and moving
   * a node re-inserts it, and re-inserting it releases the capture the press took. Every
   * frame after the first swap then arrived at whatever row had slid under the pointer, so
   * the drag deadended one row from where it started (issue #94). The window is the one
   * listener the stack cannot reorder out from under itself.
   *
   * NO DEPENDENCY LIST, deliberately: the handlers close over this render's arrangement and
   * its commit door, so re-subscribing per commit is how they stay current. It costs three
   * listener swaps on the handful of renders a drag produces, and the alternative is a ref
   * per value with the same lifetime and none of the clarity.
   */
  useEffect(() => {
    if (grab === null) return;
    const move = (event: PointerEvent): void => {
      const held = grabRef.current;
      if (held === null) return;
      // What the pointer has CROSSED, never merely what it is over: the policy excludes the
      // row in hand and asks for a neighbour's midpoint, which is the whole of the drag's
      // hysteresis (`crossedSectionId`, `packages/plugin/src/layout.ts`).
      const over = crossedSectionId(sectionBoxes(), held.moved, event.clientY);
      if (over === null) return;
      const next = movedSectionIds(held.order, held.moved, over);
      // Referential identity IS the "nothing moved" answer, so a frame that crossed nothing
      // new costs one comparison and no render.
      if (next === held.order) return;
      holdSection({ moved: held.moved, order: next });
    };
    const end = (): void => {
      const held = grabRef.current;
      if (held !== null) commitIfMoved(held.order);
      holdSection(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  });

  /*
    The rail is one body and has nothing to reorder against, so the rows are offered only
    while the sidebar is open. The MODE stays on either way — the workspace is still armed,
    the panes still say so — and so does the SCOPE: zooming out is the reader's move, never a
    consequence of collapsing the rail.
  */
  const arrangingRows = scopedIn && sidebarOpen;

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

      <Stack className="sidebar-sections" gap="0.4rem" ref={flipStack}>
        {units.map((unit) => {
          const painted = unit.rows.map(({ section, grow }) =>
            section.presentation === "plain" ? (
              <PlainRow
                section={section}
                host={host}
                arranging={arrangingRows}
                grabbed={grab?.moved === section.id}
                gestures={gestures}
                key={`${section.plugin}.${section.id}`}
              />
            ) : (
              <SectionShell
                section={section}
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
                grabbed={grab?.moved === section.id}
                gestures={gestures}
                key={`${section.plugin}.${section.id}`}
              />
            ),
          );
          /*
            A LONE ROW IS PAINTED BARE, and that is not an optimization: a wrapper around every
            row would change the stack's DOM for every plugin in the tree to express something
            only a cluster's members declared, and the FLIP measures direct children — so the
            unwrapped row stays its own unit and keeps naming itself (`data-rail-unit`).

            A CLUSTER gets the wrapper, which is the only thing that knows the word: the members
            inside it are ordinary rows with ordinary attributes, and the rail's own stylesheet
            decides what "side by side" looks like (`.sidebar-cluster`, the floor's row
            vocabulary — two plugins' rows wear it, so it cannot live in either package).
          */
          if (unit.cluster === null) return painted[0];
          return (
            <div
              className="sidebar-cluster"
              data-rail-unit={unitKey(unit)}
              data-section-cluster={unit.cluster}
              key={unitKey(unit)}
            >
              {painted}
            </div>
          );
        })}
      </Stack>
    </aside>
  );
}
