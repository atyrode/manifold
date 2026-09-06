import type { ItemKind } from "@manifold/protocol";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  Ban,
  Blocks,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  CornerDownRight,
  Ellipsis,
  Equal,
  Eye,
  Folder,
  FolderOpen,
  GripVertical,
  Keyboard,
  LayoutDashboard,
  ListTree,
  Lock,
  Maximize2,
  Minimize2,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCw,
  Server,
  Settings,
  Shapes,
  SquareDashed,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * THE icon vocabulary. Every glyph in the application is named here once, in manifold's
 * own words, and nowhere else — call sites ask for `<ItemIcon kind="composition" />`, never
 * for a drawing. Three unreconciled systems used to answer that question (unicode box
 * characters in titlebars, hand-drawn SVG paths in the sidebar and terminal rows, CSS
 * pseudo-element dots in the tree), which is why the same object wore three different marks
 * depending on which renderer painted it.
 *
 * The drawings come from lucide (see docs/decisions/0009-lucide-icons.md). That dependency is
 * an implementation detail of this module: a call site names a kind or a verb and never a
 * drawing, so re-drawing the whole set is a change to one file and no call site.
 *
 * TAXONOMY, deliberately two vocabularies rather than one flat bag of pictures — and they are
 * shaped differently on purpose, because they answer to different owners:
 *
 *   ITEMS ({@link ItemIcon})       what a thing IS. OPEN, because the item kinds are the
 *                                floor's five plus every element type a manifest contributes:
 *                                glyphs are keyed by plain string and an unknown kind falls
 *                                back, rather than this module pretending to know the set.
 *                                The mark is worn identically by the sidebar row, the canvas
 *                                titlebar, the tile header and the carry ghost of the same
 *                                object — that repetition IS the affordance, so it can only
 *                                come from one table.
 *   CONTROLS ({@link ControlKind}) what a thing DOES. CLOSED, and the contrast is the point:
 *                                a control is a NEUTRAL VERB (`park`, `shrink`, `restart`) in
 *                                a vocabulary no plugin adds to, named for the verb and never
 *                                for the picture — so the drawing can change without a call
 *                                site lying about its own semantics.
 *
 *                                CLOSED TO ADDITIONS, NOT TO CALLERS, and #116 exists because
 *                                the difference was left implicit. `ControlIcon` ships through
 *                                `@manifold/ui` precisely so a plugin's chrome wears the
 *                                same mark for the same verb the engine's chrome does; what a
 *                                plugin may not do is grow this union. The litmus is therefore
 *                                on the NAME, not on the consumer: zero domain nouns, so the
 *                                list would read the same if every plugin were replaced. TWO
 *                                kinds failed it and are gone: `endTerminal` and `terminalTree`
 *                                named one plugin's object in the floor's vocabulary — the leak
 *                                — and neither had a call site. `restart` is a terminal's verb
 *                                today under a word that survives the test, so it stayed:
 *                                relocating it would have bought neutrality by forcing the
 *                                terminals plugin to hand-roll the wrapper this module exists
 *                                to abolish, which is exactly what the OTHER direction of the
 *                                same violation was doing. Three packages were importing
 *                                lucide themselves at twenty call sites — `core.index`
 *                                behind a local copy of `glyph()`, `core.pluginManager`
 *                                re-drawing `discard`, a kind already mapped here — and
 *                                `verify:axioms` S2 now refuses the import rather than
 *                                trusting the sweep to be remembered.
 *
 * Status is deliberately NOT here. A running/exited dot and a machine's colour dot are
 * state, not identity or action; they stay CSS dots, which is what lets them carry a live
 * colour and a pulse that an icon cannot.
 */

/** 16px on a 24px viewBox: one rhythm for titlebar clusters, sidebar rows and inline marks. */
const ICON_SIZE = 16;

/**
 * Matched to the sidebar's existing hand-drawn stroke (`.sidebar svg` used 1.8) so the
 * sweep changed the drawings without changing the weight of the sidebar.
 */
const ICON_STROKE = 1.75;

export interface IconProps {
  /** Overrides the 16px default where a ref owns a different rhythm (cards, rails). */
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
 * their marks share a square-frame motif on purpose: a composition of one terminal wears
 * the terminal's mark, and the operator has to be able to read that substitution at 16px.
 * `machine` and `folder` are the two things that hold items rather than being one.
 *
 * KEYED BY THE KIND ITSELF, deliberately — every floor item kind (`ITEM_KINDS`,
 * `@manifold/protocol` placement.ts) has a glyph under its OWN name here, so a mark is looked
 * up with the kind a carry already carries and nothing translates between two vocabularies on
 * the way. The table that used to do that translation said `pad: "canvas"` and
 * `tile: "composition"` while two other tables said something else, which is the disagreement
 * `verify:axioms` S12 exists to make impossible. The `satisfies` clause is what keeps the
 * FLOOR half total: a kind added to the algebra cannot ship without its own mark.
 *
 * The LOOKUP is open because the kind vocabulary is. A contributed element type is a kind
 * this build may never have heard of (ADR 0013 §12), and the closed union that used to sit
 * here was the floor claiming to know that set — two vocabularies for one question, since a
 * plugin's own chrome already arrives as `icon: ReactNode`. Opened in #69 wave F.
 *
 * WHAT THE FALLBACK CAN HONESTLY BE. An element contribution publishes `type`, `title` and
 * optional `placement` traits (`ContributesSchema.elements`, protocol plugin.ts) and NO
 * glyph, so there is no drawing to source from a manifest and this module may not invent a
 * protocol field to get one. What a manifest DOES say about a contributed element is its
 * placement, and absent traits mean `DEFAULT_ELEMENT_PLACEMENT_TRAITS`: free-floating
 * furniture on a canvas. So the fallback draws exactly that claim and nothing more — generic
 * shapes on a plane, one mark for "an element whose owner published no drawing" — instead of
 * borrowing `core.notes`' sticky note, which told every kind this build had not heard of that
 * it was a note. The `note` KEY went with that borrowing: it was neither a floor kind nor a
 * wire type — `core.notes` publishes `text` — so a carry could never look it up, and a note's
 * titlebar and a note's carry ghost agreed only by the accident of the fallback being the same
 * drawing. A renderer that knows better passes its own node into a chrome slot; a plugin that
 * wants its mark everywhere needs a manifest field, and that is a protocol decision rather
 * than this module's to invent.
 */
const ITEM_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  /** A framed prompt — the bare `Terminal` chevron loses its frame beside the other species. */
  terminal: SquareTerminal,
  /** A dashed, unbounded plane: freeform space, deliberately soft against the composition's structure. */
  canvas: SquareDashed,
  /** A plane subdivided into tiles: the discipline itself, drawn. */
  composition: LayoutDashboard,
  /** One tile of a composition wears its container's mark: it is a seat in that structure. */
  tile: LayoutDashboard,
  /** A plugin panel is a plane the shell mounts, so it wears the freeform plane's mark. */
  panel: SquareDashed,
  /**
   * NEW STRUCTURE in hand: a divided frame with nothing in either half, which is exactly
   * what a palette carry holds — a shape with an axis and no occupant yet.
   */
  structure: Columns2,
  /**
   * EMPTY ROOM HELD OPEN: a spacer leaf is a seat with deliberately nothing in it, and it
   * wears the same dashed plane the arrange wireframe already paints on its leaf — dashed
   * meaning "bounds, no occupant" in both places.
   */
  spacer: SquareDashed,
  machine: Server,
  folder: Folder,
  folderOpen: FolderOpen,
} satisfies Readonly<Record<ItemKind, LucideIcon>> & Readonly<Record<string, LucideIcon>>;

/** An element whose owner published no drawing: furniture on a plane, and nothing narrower. */
const CONTRIBUTED_ITEM_GLYPH: LucideIcon = Shapes;

/**
 * THE item mark, at rest and in flight. A second component (`CarriedItemIcon`) used to draw
 * the carried half, which is one function too many: a carry ghost is a picture of the thing
 * being carried, so it must resolve to the SAME mark the object wears at rest, and two
 * components could only ever agree by coincidence. One component over one table is what makes
 * that agreement structural — which is also why the gesture channel carries a KIND and every
 * renderer looks the drawing up here, instead of a glyph travelling over the wire.
 */
export function ItemIcon({
  kind,
  ...rest
}: IconProps & { readonly kind: string }): React.ReactElement {
  return glyph(ITEM_GLYPHS[kind] ?? CONTRIBUTED_ITEM_GLYPH, rest);
}

/**
 * What a control DOES. Named for the verb, so `park` stays `park` if its drawing ever changes
 * from "stow it downward" to something else — and named NEUTRALLY, so that every entry here
 * would still earn its place with every plugin in this build replaced. A few members
 * (`bindings`, `assembly`) are nouns instead: those name the thing on the far side of
 * pressing, which the verb alone cannot say, and the neutrality test is the same for them.
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
  /**
   * WITHDRAW an authority: what was granted no longer works, and the thing it was granted to
   * is still there. Distinct from `discard` on purpose — pressing this destroys nothing, it
   * stops a credential from authenticating, and the row it sits on survives — and distinct
   * from `locked`, which is a control's own refusal rather than a verb a reader presses.
   * A neutral verb with no domain noun in it, so it stays sayable by whatever the next
   * revocable thing turns out to be; `core.access` and `core.machines` are today's callers.
   */
  | "revoke"
  /**
   * PUT IT BACK TO ITS BEGINNING, whatever it is. The one caller today is a terminal's own
   * chrome, and that is fine: the word carries no object, so the vocabulary reads the same
   * with core.terminals removed. It replaced `endTerminal`, which named a plugin's noun
   * (#116) and had no caller at all.
   */
  | "restart"
  /**
   * GIVE THE PARTS ONE EVEN SHARE, whatever they are parts of. A neutral verb by the same
   * litmus as `restart` above: it carries no object, so the vocabulary reads the same with
   * `core.arrange` — today's one caller, normalizing a tree's ratios — removed.
   */
  | "equalize"
  | "grip"
  /**
   * THIS CONTROL IS NOT YOURS TO OPERATE — the one member of the vocabulary that names a
   * refusal rather than a verb, drawn in the slot the control would have occupied. It is a
   * control's shape and a control's place, so it belongs beside the verbs and not with the
   * status dots: the reason is a sentence the caller supplies as a hint, never a picture.
   */
  | "locked"
  /** Acquire control of a shared interactive surface. */
  | "takeControl"
  /**
   * THE ASSEMBLY, as a list a reader can open: the roster this workspace was composed from.
   * `assembly` is the registered word for exactly that concept (`REGISTRY.md` §Lexicon), and
   * it follows `bindings` rather than the verbs — a control named for the thing on the far
   * side of pressing it. Neutral because the assembly is the ENGINE'S own noun: a workspace
   * is assembled from a roster whichever plugins fill it, which is the litmus.
   */
  | "assembly"
  /**
   * REVEAL THE LEVEL NESTED INSIDE EVERY ROW, as one act on a whole list — the bulk sibling
   * of `disclosed`/`collapsed`, which speak for a single row. Replaced `terminalTree`, whose
   * name was a plugin's object and whose only caller was hand-importing this exact drawing
   * behind the vocabulary's back (#116).
   */
  | "nesting"
  /**
   * GO INTO the arrangement this thing holds. Arrange mode is scoped — the workspace arranges
   * its panels, and a panel that declared an inner arrangement arranges its own parts — and
   * this is the control that steps one level down into the second. Named for the move, not
   * for the picture: the way back up is the bar's own breadcrumb, which needs words.
   */
  | "scopeIn"
  /** The keys this workspace answers to, as a table a reader can open. */
  | "bindings"
  /**
   * Two placements exchange seats. Worn by the drop preview when releasing on the exact
   * spot of something already there, which trades the two rather than splitting the target.
   */
  | "swap"
  /**
   * THE PREFERENCES a thing declares, as a pane a reader can open (#133). Neutral by the same
   * litmus `assembly` passes: a setting is the ENGINE's own noun now — every manifest may
   * declare one and the engine composes them — so the word carries no plugin's object, and the
   * vocabulary reads the same with any particular plugin removed.
   */
  | "settings";

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
  /**
   * A circle-slash: "this no longer works", not "this is gone". Chosen over `XCircle` and
   * `ShieldOff` because the silhouette has to stay distinguishable from `close`'s bare X and
   * `discard`'s bin at 13-14px, which is the size every control in this app is drawn at.
   */
  revoke: Ban,
  restart: RotateCw,
  /** The equals sign itself: two even bars, legible at 13px where a distribute glyph mushes. */
  equalize: Equal,
  locked: Lock,
  takeControl: MousePointer2,
  assembly: Blocks,
  nesting: ListTree,
  grip: GripVertical,
  scopeIn: CornerDownRight,
  bindings: Keyboard,
  swap: ArrowLeftRight,
  settings: Settings,
};

export function ControlIcon({
  kind,
  ...rest
}: IconProps & { readonly kind: ControlKind }): React.ReactElement {
  return glyph(CONTROL_GLYPHS[kind], rest);
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
