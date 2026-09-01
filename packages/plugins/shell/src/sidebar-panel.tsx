import {
  arrangedSectionIds,
  movedSectionIds,
  panelRefId,
  type ComposedSection,
  type PanelProps,
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
 * Which section the pointer is over, read off the live stack by geometry.
 *
 * By RECT rather than by hit-testing, and that is forced rather than preferred: arrange mode
 * puts `pointer-events: none` on the pane content it disarms, and `elementFromPoint` skips
 * exactly the elements that opted out of the pointer — so the one obvious way to ask this
 * question returns nothing while the mode that needs the answer is on. Rows already carry
 * `data-section-id` for the gate's own queries, so the stack names itself and there is no ref
 * plumbing to keep in step with the order it is describing.
 */
function sectionIdAt(clientY: number): string | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-section-id]")) {
    const box = element.getBoundingClientRect();
    if (clientY >= box.top && clientY <= box.bottom) return element.dataset["sectionId"] ?? null;
  }
  return null;
}

interface RowGestures {
  readonly onGrab: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  readonly onGrabMove: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  readonly onGrabEnd: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
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
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => gestures.onGrabMove(id, event),
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => gestures.onGrabEnd(id, event),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => gestures.onGrabEnd(id, event),
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
    >
      <ControlIcon kind="grip" size={14} />
    </button>
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
}

/**
 * Which attributes EVERY row carries, whatever chrome it wears: its id (the stack's own
 * geometry query, the gate's, and the FLIP's key), its owner, and its resolved presentation.
 * The DOM says who owns a row and how it draws, so neither question needs a class name to be
 * inferred from.
 */
function rowAttributes(section: ComposedSection): RowAttributes {
  return {
    "data-section-id": section.id,
    "data-plugin": section.plugin,
    "data-presentation": section.presentation,
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
   * MOTION, because the order is DATA. The stack reflows for three reasons a reader did not
   * necessarily cause — their own arrange commit or nudge, and a roster change that adds or
   * removes somebody else's row — and a re-render teleports. FLIP plays the difference, keyed
   * on the visible order, so a nudge shows which row moved and a disabled plugin's row is seen
   * to leave (`@manifold/plugin/ui`'s `useFlipStack`; `prefers-reduced-motion: reduce` turns
   * every transform off, which is the plain re-render this had before).
   *
   * The signature is the visible order itself, so a live drag's per-frame reflow animates too:
   * the drag preview and the committed arrangement are one derivation, and motion that skipped
   * the preview would make the release look like the only thing that moved.
   */
  const flipStack = useFlipStack(rows.map((row) => row.section.id).join(" "), {
    attribute: "data-section-id",
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
      // keeps a grab from folding the section it is about to move.
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      holdSection({ moved: id, order: arrangedIds });
    },
    onGrabMove: (id, event) => {
      const held = grabRef.current;
      if (held === null || held.moved !== id) return;
      const over = sectionIdAt(event.clientY);
      if (over === null) return;
      const next = movedSectionIds(held.order, held.moved, over);
      // Referential identity IS the "nothing moved" answer, so a frame over the row already
      // in hand costs one comparison and no render.
      if (next === held.order) return;
      holdSection({ moved: held.moved, order: next });
    },
    onGrabEnd: (id, event) => {
      const held = grabRef.current;
      if (held === null || held.moved !== id) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      commitIfMoved(held.order);
      holdSection(null);
    },
    onNudge: (id, delta) => {
      /*
        ONE PRESS, ONE VISIBLE MOVE. The neighbour is read off what is PAINTED and the move is
        applied to what is STORED, which is the same split the drag has (`sectionIdAt` reads
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
        {rows.map(({ section, grow }) =>
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
        )}
      </Stack>
    </aside>
  );
}
