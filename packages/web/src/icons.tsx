import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Eye,
  Folder,
  FolderOpen,
  Frame,
  GripVertical,
  LayoutGrid,
  ListTree,
  Maximize2,
  Minimize2,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Power,
  RotateCw,
  Server,
  SquareTerminal,
  StickyNote,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PlacementSurface } from "@manifold/protocol";

/**
 * THE icon vocabulary. Every glyph in the application is named here once, in manifold's
 * own words, and nowhere else — call sites ask for `<ItemIcon kind="composition" />`, never
 * for a drawing. Three unreconciled systems used to answer that question (unicode box
 * characters in titlebars, hand-drawn SVG paths in the sidebar and session rows, CSS
 * pseudo-element dots in the tree), which is why the same object wore three different marks
 * depending on which renderer painted it.
 *
 * The drawings come from lucide (see docs/decisions/0009-lucide-icons.md). That dependency is
 * an implementation detail of this module: the type surface below is closed, so re-drawing the
 * whole set is a change to one file and no call site.
 *
 * TAXONOMY, deliberately two vocabularies rather than one flat bag of pictures:
 *
 *   ITEMS ({@link ItemKind})     what a thing IS. Its identity mark, worn identically by the
 *                                sidebar row, the canvas titlebar, the tile header and the
 *                                carry ghost of the same object — that repetition IS the
 *                                affordance, so it can only come from one table.
 *   CONTROLS ({@link ControlKind}) what a thing DOES. Named for the verb (`park`, `shrink`),
 *                                never for the picture, so the drawing can change without
 *                                a call site lying about its own semantics.
 *
 * Status is deliberately NOT here. A running/exited dot and a machine's colour dot are
 * state, not identity or action; they stay CSS dots, which is what lets them carry a live
 * colour and a pulse that an icon cannot.
 */

/** 16px on a 24px viewBox: one rhythm for titlebar clusters, sidebar rows and inline marks. */
const ICON_SIZE = 16;

/**
 * Matched to the sidebar's existing hand-drawn stroke (`.pad-sidebar svg` used 1.8) so the
 * sweep changed the drawings without changing the weight of the sidebar.
 */
const ICON_STROKE = 1.75;

export interface IconProps {
  /** Overrides the 16px default where a surface owns a different rhythm (cards, rails). */
  readonly size?: number;
  readonly className?: string;
}

/**
 * The one wrapper. Every icon in the app is a `currentColor` stroke at one weight, so hover,
 * focus and disabled states keep working through the colour they already set on the button —
 * no icon carries its own palette.
 */
function glyph(Glyph: LucideIcon, { size = ICON_SIZE, className }: IconProps): React.ReactElement {
  return (
    <Glyph
      className={className === undefined ? "mf-icon" : `mf-icon ${className}`}
      size={size}
      strokeWidth={ICON_STROKE}
      absoluteStrokeWidth
      aria-hidden="true"
      focusable="false"
    />
  );
}

/**
 * What an object IS.
 *
 * `terminal`/`canvas`/`composition` are the three species of the one container object, and
 * their marks share a square-surface motif on purpose: a composition of one terminal wears
 * the terminal's mark, and the operator has to be able to read that substitution at 16px.
 * `note` is the fourth item that can hold a tile; `machine` and `folder` are the two things
 * that hold items rather than being one.
 */
export type ItemKind =
  "terminal" | "canvas" | "composition" | "note" | "machine" | "folder" | "folderOpen";

const ITEM_GLYPHS: Record<ItemKind, LucideIcon> = {
  /** A framed prompt — the bare `Terminal` chevron loses its frame beside the other species. */
  terminal: SquareTerminal,
  /** A freeform bordered surface; named for what a canvas is rather than for a drawing tool. */
  canvas: Frame,
  /** A surface subdivided into tiles: the discipline itself, drawn. */
  composition: LayoutGrid,
  note: StickyNote,
  machine: Server,
  folder: Folder,
  folderOpen: FolderOpen,
};

export function ItemIcon({
  kind,
  ...rest
}: IconProps & { readonly kind: ItemKind }): React.ReactElement {
  return glyph(ITEM_GLYPHS[kind], rest);
}

/**
 * What a control DOES. Named for the verb, so `park` stays `park` if its drawing ever changes
 * from "stow it downward" to something else.
 */
export type ControlKind =
  /** Take this representation out of the container; the object keeps running elsewhere. */
  | "park"
  | "maximize"
  | "shrink"
  | "close"
  | "confirm"
  | "cancel"
  | "add"
  | "more"
  | "disclosed"
  | "collapsed"
  | "sidebarCollapse"
  | "sidebarExpand"
  | "reveal"
  | "discard"
  | "endSession"
  | "restart"
  | "sessionTree"
  | "grip";

const CONTROL_GLYPHS: Record<ControlKind, LucideIcon> = {
  /**
   * Park is stowing, not shrinking: every use of the minimize slot in this app puts the object
   * away into the sidebar while it keeps running, which is a direction, not a size change.
   */
  park: ArrowDownToLine,
  maximize: Maximize2,
  shrink: Minimize2,
  close: X,
  confirm: Check,
  cancel: X,
  add: Plus,
  more: Ellipsis,
  disclosed: ChevronDown,
  collapsed: ChevronRight,
  sidebarCollapse: PanelLeftClose,
  sidebarExpand: PanelLeftOpen,
  reveal: Eye,
  discard: Trash2,
  endSession: Power,
  restart: RotateCw,
  sessionTree: ListTree,
  grip: GripVertical,
};

export function ControlIcon({
  kind,
  ...rest
}: IconProps & { readonly kind: ControlKind }): React.ReactElement {
  return glyph(CONTROL_GLYPHS[kind], rest);
}

/**
 * The placement algebra's surface kinds, read as items. A carry ghost is a picture of the
 * thing being carried, so it must resolve to the SAME mark the object wears at rest — which
 * is why the wire payload carries a surface kind and the renderer looks the drawing up here,
 * instead of a glyph string travelling over the gesture channel.
 */
const SURFACE_ITEMS: Record<PlacementSurface["kind"], ItemKind> = {
  terminal: "terminal",
  pad: "canvas",
  tile: "composition",
  /** An element surface is an object with no identity outside its document — a note. */
  element: "note",
};

export function SurfaceIcon({
  kind,
  ...rest
}: IconProps & { readonly kind: PlacementSurface["kind"] }): React.ReactElement {
  return glyph(ITEM_GLYPHS[SURFACE_ITEMS[kind]], rest);
}

/**
 * A collaborator's pointer. Neither an item nor a control — it is somebody else's cursor —
 * but it lived as the same hand-drawn path copied into both renderers, which is exactly the
 * duplication this module exists to end. Filled rather than stroked: a cursor that reads as
 * an outline reads as a picture of a cursor.
 */
export function RemoteCursorIcon({ size = 22 }: IconProps): React.ReactElement {
  return (
    <MousePointer2
      className="mf-icon mf-icon--cursor"
      size={size}
      strokeWidth={ICON_STROKE}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    />
  );
}
