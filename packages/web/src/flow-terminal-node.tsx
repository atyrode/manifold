import type {
  CarriedItem,
  MachineSummary,
  PadPresence,
  PlacementDestination,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { createContext, useContext } from "react";
import type { CarryController } from "./use-carry.ts";
import type { CanvasTool } from "./canvas-tool.ts";
import type { ItemDropAssessment } from "@manifold/plugin/hooks";
import type { TileDropStore } from "./tile-drop-store.ts";
import type { WidgetRole } from "./widget-engagement.ts";

/**
 * The canvas's node contexts and terminal chrome constants.
 *
 * There is no terminal NODE any more: a terminal on a canvas is a portal onto its solo
 * home composition, and the widget's mono form wears the terminal's own titlebar (the
 * arity rule). What survives here is what that chrome is addressed by — the drag handle
 * selector and the size floor — plus the two contexts every canvas node reads.
 *
 * They live in their own module so the `nodeTypes` map in the container can be a
 * module-scope constant: an inline object literal would give React Flow a new component
 * identity on every render, remounting every node — which for manifold means destroying
 * every PTY. React Flow only warns about this in development.
 */

export interface FlowPadContextValue {
  readonly client: SessionClient;
  /**
   * The canvas's carry. Any chrome a node offers as a grab handle starts one through
   * this, so a widget's tile grip and a node drag are the same gesture to everyone
   * watching — the node never opens a gesture channel of its own.
   */
  readonly carry: CarryController;
  readonly machines: readonly MachineSummary[] | null;
  /** Renames the session behind an element from its titlebar title. */
  readonly onRenameTerminal: (sessionId: string, name: string) => void;
  /**
   * Drops an element from this canvas without touching what it points at: the
   * portal widget's minimize, which puts a shared view away rather than ending it.
   */
  readonly removeElement: (elementId: string) => void;
  /**
   * Deletes the container a portal points at AND the widget onto it — the view is
   * gone, so a widget left behind would point at nothing.
   */
  readonly onDeleteContainer: (containerId: string, elementId: string) => void;
  /** Streams live resize geometry and commits its final frame. */
  readonly onResize: (
    elementId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  readonly onResizeEnd: (
    elementId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  /**
   * The active canvas tool. Terminals only offer their border grab zones under the
   * select tool, so a draw or text gesture starting on a frame edge stays a draw or
   * text gesture.
   */
  readonly tool: CanvasTool;
  readonly editingId: string | null;
  readonly beginTextEditing: (elementId: string) => void;
  readonly endTextEditing: (elementId: string) => void;
  /**
   * Container nesting depth of the canvas these nodes live on: 1 for the routed
   * pad, 2 for a canvas embedded one container deep. Portals render their
   * container live while `depth < MAX_LIVE_DEPTH` and as cards below that.
   */
  readonly depth: number;
  /** Bearer token for the REST calls canvas nodes make on their own (portal reads). */
  readonly token: string;
  /**
   * Opens a room socket for another container — what a portal widget paints from.
   * The canvas owns the session URL and identity, so nodes never rebuild either.
   *
   * The role is the widget's whole discipline. A `spectator` socket watches without
   * occupying: no avatar, no vote in the bubble rule, and the server refuses every
   * write it attempts — that is the resting state of every widget on a canvas. An
   * `occupant` socket is an ordinary member of the room, opened only once someone
   * engages a widget's tile (see `widget-engagement.ts`), because occupancy is what
   * makes keystrokes legal and what keeps a transient view from dissolving.
   */
  readonly openClient: (padId: string, role: WidgetRole) => SessionClient;
  /** Pushes a route; portals navigate into the container they point at. */
  readonly navigate: (path: string) => void;
  /**
   * The one notice surface, handed down so a node can report a failure of its OWN
   * (a widget that cannot open its occupant socket) without importing the toast layer
   * into modules that must stay renderer-agnostic.
   */
  readonly notify: (message: string) => void;
  /** The canvas's own container id: the pad these nodes are elements OF. */
  readonly padId: string;
  /**
   * Names a container from the index the sidebar fetched. A widget's tree can hold a
   * canvas or a composition, and naming one is not knowledge the widget's own room has
   * — without this a caption that reads on the fullscreen route read as nothing here.
   */
  readonly padName: (padId: string) => string | null;
  /**
   * The per-frame drop channel between the canvas's drag transports and its widgets'
   * preview overlays. The canvas writes `{pointer, armedElementId}`; the armed
   * widget's overlay resolves the aim and publishes it back, which is both what the
   * canvas commits at release and what rides this drag's carry frames.
   */
  readonly dropStore: TileDropStore;
  /**
   * The canvas's placement assessment, so a widget's overlay judges a prospective
   * drop with the same lookup the canvas's own commit will use. The carry is optional
   * and defaults to the local one: a widget previewing a PEER's aim passes the peer's
   * carry — surface AND resolved item, exactly as it arrived — so a viewer paints the
   * refusal the server would give without re-classifying somebody else's grab.
   */
  readonly assessDrop: (
    destination: PlacementDestination,
    carried?: CarriedItem,
  ) => ItemDropAssessment | null;
  /**
   * Whether a canvas ELEMENT carry holds a seat to trade at an occupied tile center
   * (#62): true for a portal showing a terminal — the element is a window onto its
   * solo home, whose leaf the displaced occupant moves into — so widget overlays
   * paint the swap cue exactly where the executor will trade.
   */
  readonly elementSeat: (padId: string, elementId: string) => boolean;
}

/**
 * TWO contexts, split by CADENCE rather than by topic.
 *
 * Everything a node calls is stable for the life of the canvas, so it belongs in a value
 * that changes only when the canvas's own mode does. Polled presence is not: a new array
 * arrives every poll tick, and while it lived here every live terminal and every widget
 * re-rendered on a timer, for data all but one of them never read. The split is what
 * lets a node subscribe to the frequency it actually consumes — and what let the widget
 * socket drop its `openClient` ref indirection, since a stable callback can simply be an
 * effect dependency.
 */
const FlowPadContext = createContext<FlowPadContextValue | null>(null);
const FlowPadPresenceContext = createContext<readonly PadPresence[] | null>(null);

/**
 * One element for both providers. The canvas hands down two values with two very
 * different lifetimes, and nesting the raw providers at the call site would bury that
 * distinction in JSX indentation instead of stating it here.
 */
export function FlowPadProviders({
  value,
  presence,
  children,
}: {
  readonly value: FlowPadContextValue;
  readonly presence: readonly PadPresence[];
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <FlowPadContext.Provider value={value}>
      <FlowPadPresenceContext.Provider value={presence}>{children}</FlowPadPresenceContext.Provider>
    </FlowPadContext.Provider>
  );
}

export function useFlowPad(): FlowPadContextValue {
  const value = useContext(FlowPadContext);
  if (value === null) throw new Error("FlowPadContext is missing above a canvas node");
  return value;
}

/**
 * Polled principal-level presence. Read ONLY where nothing better exists: a live widget
 * has its own room socket and reads the roster from it, so this is the card form's
 * fallback, and subscribing to it anywhere else re-imposes the poll on the whole canvas.
 */
export function useFlowPadPresence(): readonly PadPresence[] {
  const value = useContext(FlowPadPresenceContext);
  if (value === null) throw new Error("FlowPadPresenceContext is missing above a canvas node");
  return value;
}

/**
 * React Flow drag handle. The terminal's OWN titlebar, which is what a user reaches for —
 * enabled by `TerminalView`'s opt-in `titlebarDragsHost` seam, since the frame otherwise
 * swallows pointerdown so xterm can own selection.
 */
export const TERMINAL_DRAG_HANDLE = ".terminal-titlebar";

/** Keeps a resize from collapsing a terminal below a usable shell. */
export const MIN_TERMINAL_WIDTH = 320;
export const MIN_TERMINAL_HEIGHT = 200;
