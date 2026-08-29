import { useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";

/** Drag payload reordering the sidebar's section stack; scoped so row drags stay untouched. */
export const SECTION_DRAG_MIME = "application/x-manifold-section";

export type SidebarSectionId = "machines" | "pads" | "terminals" | "views";

/**
 * Pads first, then views, terminals, machines. `views` is reserved: it is a valid stored id today
 * and only renders once the first view exists, so the slot is already saved for it.
 */
export const DEFAULT_SECTION_ORDER: readonly SidebarSectionId[] = [
  "pads",
  "views",
  "terminals",
  "machines",
];

const ORDER_STORAGE_KEY = "manifold:sidebar-section-order";
const COLLAPSED_STORAGE_KEY = "manifold:sidebar-section-collapsed";

export type CollapsedSections = Readonly<Partial<Record<SidebarSectionId, boolean>>>;

function isSectionId(value: unknown): value is SidebarSectionId {
  return value === "machines" || value === "pads" || value === "terminals" || value === "views";
}

/** Ids missing from storage land beside the neighbour they follow by default, never at the end. */
function withMissingSections(stored: readonly SidebarSectionId[]): readonly SidebarSectionId[] {
  const order = [...stored];
  for (const [defaultIndex, id] of DEFAULT_SECTION_ORDER.entries()) {
    if (order.includes(id)) continue;
    const predecessor = DEFAULT_SECTION_ORDER.slice(0, defaultIndex).findLast((candidate) =>
      order.includes(candidate),
    );
    order.splice(predecessor === undefined ? 0 : order.indexOf(predecessor) + 1, 0, id);
  }
  return order;
}

/**
 * Stored order is device-local presentation memory: unknown ids drop out and ids missing from
 * storage are backfilled in their default neighbourhood, so adding a section later never strands
 * it off-screen.
 */
export function initialSectionOrder(): readonly SidebarSectionId[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return DEFAULT_SECTION_ORDER;
    return withMissingSections([...new Set(stored.filter(isSectionId))]);
  } catch {
    return DEFAULT_SECTION_ORDER;
  }
}

export function rememberSectionOrder(order: readonly SidebarSectionId[]): void {
  try {
    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Section order memory is optional.
  }
}

export function initialCollapsedSections(): CollapsedSections {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    const collapsed: Partial<Record<SidebarSectionId, boolean>> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (isSectionId(key) && typeof value === "boolean") collapsed[key] = value;
    }
    return collapsed;
  } catch {
    return {};
  }
}

export function rememberCollapsedSections(collapsed: CollapsedSections): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));
  } catch {
    // Section collapse memory is optional.
  }
}

/** Layout box of one rendered section in stack-content coordinates (scroll included). */
interface SectionBox {
  readonly top: number;
  readonly height: number;
}

type SectionBoxes = Readonly<Partial<Record<SidebarSectionId, SectionBox>>>;

/** Per-section `translateY` in px that animates the stack into its projected order. */
export type SectionOffsets = Readonly<Partial<Record<SidebarSectionId, number>>>;

const NO_OFFSETS: SectionOffsets = {};

/**
 * Position the held section would take in `order`, read from the pointer against the stack's
 * *pre-drag* geometry. Static geometry is what keeps the preview stable: hit-testing the
 * translated boxes would feed every shift back into the next test and make the gap oscillate.
 * Reserved ids hold no measured box, so they own no slot of their own and the returned position
 * simply lands beside them.
 */
export function sectionInsertIndex(
  order: readonly SidebarSectionId[],
  heldId: SidebarSectionId,
  pointerY: number,
  boxes: SectionBoxes,
): number {
  const rest = order.filter((id) => id !== heldId);
  for (const [index, id] of rest.entries()) {
    const box = boxes[id];
    if (box === undefined) continue;
    // First section the pointer has not passed the middle of: the gap opens above it.
    if (pointerY < box.top + box.height / 2) return index;
  }
  return rest.length;
}

/** Pure stack move: the held section lands in `insertAt`, everything else closes up. */
export function moveSection(
  order: readonly SidebarSectionId[],
  heldId: SidebarSectionId,
  insertAt: number,
): readonly SidebarSectionId[] {
  const rest = order.filter((id) => id !== heldId);
  const at = Math.max(0, Math.min(insertAt, rest.length));
  return [...rest.slice(0, at), heldId, ...rest.slice(at)];
}

/**
 * Make-space deltas: every section (the held one included) is offset by the distance between its
 * current slot and its slot in the projected order, so the stack slides aside around a gap that
 * tracks the pointer. Heights never change with order, which makes the projection exact.
 */
export function sectionOffsets(
  order: readonly SidebarSectionId[],
  heldId: SidebarSectionId,
  insertAt: number,
  boxes: SectionBoxes,
): SectionOffsets {
  const measured = order.flatMap((id) => {
    const box = boxes[id];
    return box === undefined ? [] : [box];
  });
  const first = measured[0];
  const second = measured[1];
  if (first === undefined) return NO_OFFSETS;
  // The stack's uniform flex gap, read back from the measured boxes.
  const gap = second === undefined ? 0 : Math.max(0, second.top - (first.top + first.height));
  const offsets: Partial<Record<SidebarSectionId, number>> = {};
  let top = first.top;
  for (const id of moveSection(order, heldId, insertAt)) {
    const box = boxes[id];
    if (box === undefined) continue;
    offsets[id] = top - box.top;
    top += box.height + gap;
  }
  return offsets;
}

function measureSections(stack: HTMLElement | null): SectionBoxes {
  if (stack === null) return {};
  const origin = stackOrigin(stack);
  const boxes: Partial<Record<SidebarSectionId, SectionBox>> = {};
  for (const node of stack.querySelectorAll<HTMLElement>("[data-section-id]")) {
    const id = node.dataset["sectionId"];
    if (!isSectionId(id)) continue;
    const rect = node.getBoundingClientRect();
    boxes[id] = { top: rect.top - origin, height: rect.height };
  }
  return boxes;
}

/** Viewport y of the stack's content origin; scroll-invariant, so mid-drag autoscroll is free. */
function stackOrigin(stack: HTMLElement): number {
  return stack.getBoundingClientRect().top - stack.scrollTop;
}

/** Reorder wiring the stack hands to each of its sections. */
export interface SectionDragProps {
  /** True for the section under the pointer's grip; it renders as the placeholder. */
  readonly held: boolean;
  readonly offset: number;
  readonly onDragBegin: () => void;
  readonly onDragFinish: () => void;
}

export interface SectionStackDrag {
  readonly stackRef: RefObject<HTMLDivElement | null>;
  /** True while a header is held: the stack turns its transform transitions on. */
  readonly reordering: boolean;
  readonly stackProps: {
    readonly onDragOverCapture: (event: DragEvent<HTMLDivElement>) => void;
    readonly onDropCapture: (event: DragEvent<HTMLDivElement>) => void;
    readonly onDragLeaveCapture: (event: DragEvent<HTMLDivElement>) => void;
  };
  readonly dragProps: (id: SidebarSectionId) => SectionDragProps;
}

/**
 * Live make-space reordering for the section stack. The stack owns the drag — not the individual
 * headers — because the pointer spends most of a drag over section bodies, and it listens in the
 * capture phase since tree rows stop `dragover` from bubbling. Nothing but a locally held header
 * carrying {@link SECTION_DRAG_MIME} is claimed, so terminal, pad, and tree row drags leave the
 * stack completely inert: no gap, no highlight, no drop line.
 */
export function useSectionStackDrag(
  order: readonly SidebarSectionId[],
  onReorder: (next: readonly SidebarSectionId[]) => void,
): SectionStackDrag {
  const stackRef = useRef<HTMLDivElement | null>(null);
  // Held id + pre-drag geometry travel together: both are set in the dragstart handler and
  // read during render, so they are state — a ref read mid-render would go stale silently.
  const [drag, setDrag] = useState<{
    readonly id: SidebarSectionId;
    readonly boxes: SectionBoxes;
  } | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);

  /** Back to rest: no held header, no gap, no offsets. */
  const endDrag = (): void => {
    setDrag(null);
    setInsertAt(null);
  };

  const offsets =
    drag === null || insertAt === null
      ? NO_OFFSETS
      : sectionOffsets(order, drag.id, insertAt, drag.boxes);

  return {
    stackRef,
    reordering: drag !== null,
    stackProps: {
      onDragOverCapture: (event) => {
        if (drag === null || !event.dataTransfer.types.includes(SECTION_DRAG_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const stack = stackRef.current;
        if (stack === null) return;
        const next = sectionInsertIndex(
          order,
          drag.id,
          event.clientY - stackOrigin(stack),
          drag.boxes,
        );
        setInsertAt((current) => (current === next ? current : next));
      },
      onDropCapture: (event) => {
        if (drag === null || !event.dataTransfer.types.includes(SECTION_DRAG_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        const dragged = event.dataTransfer.getData(SECTION_DRAG_MIME);
        const at = insertAt;
        const heldId = drag.id;
        endDrag();
        if (dragged !== heldId || at === null) return;
        const next = moveSection(order, heldId, at);
        // moveSection is a permutation, so a single position mismatch means the stack moved.
        if (next.some((id, index) => order[index] !== id)) onReorder(next);
      },
      onDragLeaveCapture: (event) => {
        if (drag === null) return;
        const stack = stackRef.current;
        const entered = event.relatedTarget;
        if (stack === null || (entered instanceof Node && stack.contains(entered))) return;
        // Pointer left the stack: the gap closes and every section slides home.
        setInsertAt(null);
      },
    },
    dragProps: (id) => ({
      held: drag?.id === id,
      offset: offsets[id] ?? 0,
      onDragBegin: () => {
        setDrag({ id, boxes: measureSections(stackRef.current) });
        setInsertAt(null);
      },
      // `dragend` also covers cancelled drops and Escape, so the stack always settles.
      onDragFinish: endDrag,
    }),
  };
}

interface SidebarSectionProps extends SectionDragProps {
  readonly id: SidebarSectionId;
  readonly title: string;
  /** Right-aligned summary of the section's contents; a count or a short status string. */
  readonly count: ReactNode;
  readonly collapsed: boolean;
  readonly testId?: string;
  /** True for the section that absorbs leftover sidebar height (the pad tree). */
  readonly grow?: boolean;
  /** Header-level controls; clicks never reach the disclosure. */
  readonly actions?: ReactNode;
  readonly onCollapsedChange: (id: SidebarSectionId, collapsed: boolean) => void;
  readonly children: ReactNode;
}

/**
 * One shell for every sidebar section: a draggable disclosure header over a body. The native
 * `summary` stays the collapse control — it carries the button role and expanded state for free,
 * keeps content in the DOM while collapsed, and holds the chevron marker. The header only starts
 * drags; {@link useSectionStackDrag} on the stack answers them.
 */
export function SidebarSection({
  id,
  title,
  count,
  collapsed,
  testId,
  grow = false,
  actions,
  held,
  offset,
  onDragBegin,
  onDragFinish,
  onCollapsedChange,
  children,
}: SidebarSectionProps) {
  return (
    <details
      className={`sidebar-section${grow ? " sidebar-section--grow" : ""}${held ? " sidebar-section--held" : ""}`}
      data-testid={testId}
      data-section-id={id}
      open={!collapsed}
      style={offset === 0 ? undefined : { transform: `translateY(${offset}px)` }}
      onToggle={(event) => onCollapsedChange(id, !event.currentTarget.open)}
    >
      <summary
        className="sidebar-section-header"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(SECTION_DRAG_MIME, id);
          event.dataTransfer.effectAllowed = "move";
          onDragBegin();
        }}
        onDragEnd={onDragFinish}
      >
        <span className="sidebar-section-chevron" aria-hidden="true" />
        <strong className="sidebar-section-title">{title}</strong>
        <span className="sidebar-section-count">{count}</span>
        {actions === undefined ? null : <span className="sidebar-section-actions">{actions}</span>}
      </summary>
      <div className="sidebar-section-body">{children}</div>
    </details>
  );
}
