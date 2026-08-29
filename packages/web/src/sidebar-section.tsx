import { useState, type ReactNode } from "react";

/** Drag payload reordering the sidebar's section stack; scoped so row drags stay untouched. */
export const SECTION_DRAG_MIME = "application/x-manifold-section";

export type SidebarSectionId = "machines" | "pads" | "terminals";

/** Terminals sits directly after Pads: the stack order users see on a fresh device. */
export const DEFAULT_SECTION_ORDER: readonly SidebarSectionId[] = ["machines", "pads", "terminals"];

const ORDER_STORAGE_KEY = "manifold:sidebar-section-order";
const COLLAPSED_STORAGE_KEY = "manifold:sidebar-section-collapsed";

export type CollapsedSections = Readonly<Partial<Record<SidebarSectionId, boolean>>>;

function isSectionId(value: unknown): value is SidebarSectionId {
  return value === "machines" || value === "pads" || value === "terminals";
}

/**
 * Stored order is device-local presentation memory: unknown ids drop out and ids missing from
 * storage append in default order, so adding a section later never strands it off-screen.
 */
export function initialSectionOrder(): readonly SidebarSectionId[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return DEFAULT_SECTION_ORDER;
    const known = stored.filter(isSectionId);
    const deduped = [...new Set(known)];
    return [...deduped, ...DEFAULT_SECTION_ORDER.filter((id) => !deduped.includes(id))];
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

/** Pure stack move: the dragged section takes the target's slot, everything else closes up. */
export function reorderSections(
  order: readonly SidebarSectionId[],
  draggedId: string,
  targetId: SidebarSectionId,
): readonly SidebarSectionId[] {
  if (!isSectionId(draggedId) || draggedId === targetId) return order;
  const from = order.indexOf(draggedId);
  const to = order.indexOf(targetId);
  if (from === -1 || to === -1) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, draggedId);
  return next;
}

interface SidebarSectionProps {
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
  readonly onReorder: (draggedId: string, targetId: SidebarSectionId) => void;
  readonly children: ReactNode;
}

/**
 * One shell for every sidebar section: a draggable disclosure header over a body. The native
 * `summary` stays the collapse control — it carries the button role and expanded state for free,
 * keeps content in the DOM while collapsed, and holds the chevron marker.
 */
export function SidebarSection({
  id,
  title,
  count,
  collapsed,
  testId,
  grow = false,
  actions,
  onCollapsedChange,
  onReorder,
  children,
}: SidebarSectionProps) {
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);

  const dragState = `${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`;

  return (
    <details
      className={`sidebar-section${grow ? " sidebar-section--grow" : ""}${dragState}`}
      data-testid={testId}
      data-section-id={id}
      open={!collapsed}
      onToggle={(event) => onCollapsedChange(id, !event.currentTarget.open)}
    >
      <summary
        className="sidebar-section-header"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(SECTION_DRAG_MIME, id);
          event.dataTransfer.effectAllowed = "move";
          setDragging(true);
        }}
        onDragEnd={() => {
          setDragging(false);
          setDropTarget(false);
        }}
        onDragOver={(event) => {
          // Only section drags reorder the stack; pad, terminal, and tree drags fall through.
          if (!event.dataTransfer.types.includes(SECTION_DRAG_MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(SECTION_DRAG_MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropTarget(false);
          onReorder(event.dataTransfer.getData(SECTION_DRAG_MIME), id);
        }}
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
