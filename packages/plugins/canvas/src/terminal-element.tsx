import type {
  CarriedItem,
  MachineSummary,
  Attendance,
  PlacementDestination,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { createContext, useContext, useMemo } from "react";
import type { CanvasTool } from "./canvas-tool.ts";
import {
  ElementHostProvider,
  type CarryController,
  type ItemDropAssessment,
  type TileDropStore,
} from "@manifold/plugin/hooks";
import type { ElementHost, HostServices } from "@manifold/plugin";
import type { ChannelRole } from "./portal-engagement.ts";

/**
 * The canvas's node contexts and terminal chrome constants.
 *
 * There is no terminal NODE any more: a terminal on a canvas is a portal onto its solo
 * home composition, and the portal's mono form wears the terminal's own titlebar (the
 * arity rule). What survives here is what that chrome is addressed by — the drag handle
 * selector and the size floor — plus the two contexts every canvas node reads.
 *
 * They live in their own module so the `nodeTypes` map in the container can be a
 * module-scope constant: an inline object literal would give React Flow a new component
 * identity on every render, remounting every node — which for manifold means destroying
 * every PTY. React Flow only warns about this in development.
 */

export interface CanvasContextValue {
  readonly client: SessionClient;
  /**
   * The canvas's carry. Any chrome a node offers as a grab handle starts one through
   * this, so a portal's tile grip and a node drag are the same gesture to everyone
   * watching — the node never opens a gesture channel of its own.
   */
  readonly carry: CarryController;
  readonly machines: readonly MachineSummary[] | null;
  /** Renames the terminal behind an element from its titlebar title. */
  readonly onRenameTerminal: (terminalId: string, name: string) => void;
  /**
   * Puts a reference away: the element leaves this canvas and what it points at is
   * untouched — the portal's minimize. It is a PLACEMENT (`-> unplaced`), never a document
   * delete, because removing the last reference to a container is what makes its terminal
   * unplaced and every workspace-wide reading is derived from that graph.
   */
  readonly unplaceElement: (elementId: string) => void;
  /**
   * Deletes the container a portal points at AND the portal onto it — the view is
   * gone, so a portal left behind would point at nothing.
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
   * container, 2 for a canvas embedded one container deep. Portals render their
   * container live while `depth < MAX_LIVE_DEPTH` and as cards below that.
   */
  readonly depth: number;
  /**
   * The one host ref, for the reads a node makes on its own behalf: a portal portal asks
   * for the RECORD of the container it points at, because a name lives in that container's
   * row and not in its room.
   */
  readonly host: HostServices;
  /**
   * Opens a room socket for another container — what a portal portal paints from.
   * The canvas owns the terminal URL and identity, so nodes never rebuild either.
   *
   * The role is the portal's whole discipline. A `spectator` socket watches without
   * occupying: no avatar, no vote in the bubble rule, and the server refuses every
   * write it attempts — that is the resting state of every portal on a canvas. An
   * `occupant` socket is an ordinary member of the room, opened only once someone
   * engages a portal's tile (see `portal-engagement.ts`), because occupancy is what
   * makes keystrokes legal and what keeps a transient view from dissolving.
   */
  readonly openClient: (containerId: string, role: ChannelRole) => SessionClient;
  /** Pushes a route; portals navigate into the container they point at. */
  readonly navigate: (path: string) => void;
  /**
   * The one notice ref, handed down so a node can report a failure of its OWN
   * (a portal that cannot open its occupant socket) without importing the notice layer
   * into modules that must stay renderer-agnostic.
   */
  readonly notify: (message: string) => void;
  /** The canvas's own container id: the container these nodes are elements OF. */
  readonly containerId: string;
  /**
   * Names a container from the index the sidebar fetched. A portal's tree can hold a
   * canvas or a composition, and naming one is not knowledge the portal's own room has
   * — without this a caption that reads on the fullscreen route read as nothing here.
   */
  readonly containerName: (containerId: string) => string | null;
  /**
   * The per-frame drop channel between the canvas's drag transports and its portals'
   * preview overlays. The canvas writes `{pointer, armedElementId}`; the armed
   * portal's overlay resolves the aim and publishes it back, which is both what the
   * canvas commits at release and what rides this drag's carry frames.
   */
  readonly dropStore: TileDropStore;
  /**
   * The canvas's placement assessment, so a portal's overlay judges a prospective
   * drop with the same lookup the canvas's own commit will use. The carry is optional
   * and defaults to the local one: a portal previewing a PEER's aim passes the peer's
   * carry — ref AND resolved item, exactly as it arrived — so a viewer paints the
   * refusal the server would give without re-classifying somebody else's grab.
   */
  readonly assessDrop: (
    destination: PlacementDestination,
    carried?: CarriedItem,
  ) => ItemDropAssessment | null;
  /**
   * Whether a canvas ELEMENT carry holds a seat to trade at an occupied tile center
   * (#62): true for a portal showing a terminal — the element is a window onto its
   * solo home, whose leaf the displaced occupant moves into — so portal overlays
   * paint the swap cue exactly where the executor will trade.
   */
  readonly elementSeat: (containerId: string, elementId: string) => boolean;
}

/**
 * TWO contexts, split by CADENCE rather than by topic.
 *
 * Everything a node calls is stable for the life of the canvas, so it belongs in a value
 * that changes only when the canvas's own mode does. Polled presence is not: a new array
 * arrives every poll tick, and while it lived here every live terminal and every portal
 * re-rendered on a timer, for data all but one of them never read. The split is what
 * lets a node subscribe to the frequency it actually consumes — and what let the portal
 * socket drop its `openClient` ref indirection, since a stable callback can simply be an
 * effect dependency.
 */
const CanvasContext = createContext<CanvasContextValue | null>(null);
const CanvasPresenceContext = createContext<readonly Attendance[] | null>(null);

/**
 * One element for every context a canvas node reads. Two of them are the canvas's own — a
 * value whose lifetime is the canvas's mode, and polled presence that changes on a timer — and
 * the third is the ENGINE's element-mount contract, which floor nodes ignore and contributed
 * ones (a note) live on. Nesting the raw providers at the call site would bury those three
 * very different lifetimes in JSX indentation instead of stating them here.
 */
export function CanvasProviders({
  value,
  presence,
  children,
}: {
  readonly value: CanvasContextValue;
  readonly presence: readonly Attendance[];
  readonly children: React.ReactNode;
}): React.ReactElement {
  /*
    The canvas as a MOUNT SITE for contributed elements (`@manifold/plugin`'s `ElementHost`):
    the room's document, this canvas's editing focus, and the one rule a canvas has that a tile
    leaf does not — an emptied element is invisible litter here, so it goes. Derived from the
    same value rather than assembled at the call site, because a fresh object would re-render
    every contributed element on the canvas on every canvas render.
   */
  const elementHost = useMemo<ElementHost>(
    () => ({
      doc: value.client,
      editingElementId: value.editingId,
      beginEditing: value.beginTextEditing,
      endEditing: value.endTextEditing,
      removeWhenEmpty: true,
    }),
    [value],
  );
  return (
    <CanvasContext.Provider value={value}>
      <CanvasPresenceContext.Provider value={presence}>
        <ElementHostProvider value={elementHost}>{children}</ElementHostProvider>
      </CanvasPresenceContext.Provider>
    </CanvasContext.Provider>
  );
}

export function useCanvas(): CanvasContextValue {
  const value = useContext(CanvasContext);
  if (value === null) throw new Error("CanvasContext is missing above a canvas node");
  return value;
}

/**
 * Polled principal-level presence. Read ONLY where nothing better exists: a live portal
 * has its own room socket and reads the roster from it, so this is the card form's
 * fallback, and subscribing to it anywhere else re-imposes the poll on the whole canvas.
 */
export function useCanvasPresence(): readonly Attendance[] {
  const value = useContext(CanvasPresenceContext);
  if (value === null) throw new Error("CanvasPresenceContext is missing above a canvas node");
  return value;
}

/**
 * React Flow drag handle. The terminal's OWN titlebar, which is what a user reaches for —
 * enabled by `TerminalView`'s opt-in `titlebarDragsHost` call ref, since the frame otherwise
 * swallows pointerdown so xterm can own selection.
 */
export const TERMINAL_DRAG_HANDLE = ".terminal-titlebar";

/** Keeps a resize from collapsing a terminal below a usable shell. */
export const MIN_TERMINAL_WIDTH = 320;
export const MIN_TERMINAL_HEIGHT = 200;
