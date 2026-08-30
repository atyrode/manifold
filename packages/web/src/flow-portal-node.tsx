import type { Principal, TileLayout, TileNode, TileSurface } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getPad } from "./api.ts";
import { countRender } from "./debug-seam.ts";
import {
  MIN_TERMINAL_HEIGHT,
  MIN_TERMINAL_WIDTH,
  useFlowPad,
  useFlowPadPresence,
} from "./flow-terminal-node.tsx";
import { ControlIcon, ItemIcon } from "./icons.tsx";
import type { ItemEnvelope } from "./item-envelope.ts";
import { sessionMachine } from "./machine-visibility.ts";
import { NodeTitleBar } from "./node-titlebar.tsx";
import { TerminalView } from "./terminal-view.tsx";
import { TilePreviewOverlay } from "./tile-preview-overlay.tsx";
import { PORTAL_TREE_CLASSES, TileTree } from "./tile-tree.tsx";
import { TileZoneDebug } from "./tile-zone-debug.tsx";
import type { TileDropHost } from "./use-tile-drop.ts";
import {
  createWidgetSocketSwitch,
  type WidgetRole,
  type WidgetSlot,
  type WidgetSocketSwitch,
} from "./widget-engagement.ts";

/**
 * The canvas face of a tiled container. A view and a pad are one object, so a
 * container sitting inside a canvas is a plain scene element (`type: "portal"`)
 * that renders as a live widget: the container's own tiles, its occupants, and a
 * double-click that navigates into it.
 *
 * A widget has two states, and the difference between them is a socket discipline
 * rather than a mode switch anyone has to learn:
 *
 *   WATCHING (resting) — a spectator socket. The tiles are live pixels, but nothing
 *     in them is writable, the container's occupant list does not include this
 *     browser, and a transient view is free to dissolve while the widget watches.
 *   ENGAGED — an occupant socket to the same container. The tiles are ordinary
 *     terminals: typing, selection, resize and focus presence all flow, the roster
 *     (and therefore every avatar strip) shows this principal, and the bubble rule
 *     correctly refuses to pop a view somebody is working in.
 *
 * ENGAGEMENT RULE — one gesture each way, no timers:
 *   engage    a plain CLICK on a tile. Click, not pointerdown: a press that becomes a
 *             drag has to extract the tile, so escalating on the press would make
 *             every decompose drag an occupancy claim.
 *   disengage a POINTERDOWN anywhere outside this widget (document capture). Same rule
 *             a window manager uses for focus, so it needs no teaching, and it means
 *             an abandoned widget drops back to spectator instead of pinning a bubble.
 */

/**
 * React Flow drag handle for a portal node: the name strip only, so the preview
 * body stays free for the tile drags that decompose a composition.
 */
export const PORTAL_DRAG_HANDLE = ".flow-portal__strip";

/**
 * A widget rendering its container's ONE terminal as itself (the arity rule). The class
 * is load-bearing beyond paint: it scopes the canvas's drag-handle selector, so only a
 * mono widget is moved by the terminal titlebar inside it — inside a multi-tile widget
 * that same titlebar belongs to a tile, whose drag extracts rather than moves.
 */
export const MONO_PORTAL_CLASS = "flow-portal--mono";
export const MONO_PORTAL_CLASS_SELECTOR = `.${MONO_PORTAL_CLASS}`;

/**
 * Resize is canvas-item chrome, not terminal chrome: a widget's frame border is a
 * grab zone exactly as a terminal's is (same 8px edges, same 14px corners, same
 * transparent controls), so the two species read as one. The floor is a widget's,
 * not a shell's — a composition preview stays legible far below a usable 80×24.
 */
export const MIN_PORTAL_WIDTH = 240;
export const MIN_PORTAL_HEIGHT = 160;

/**
 * Container nesting renders live to depth 2 — the routed canvas is depth 1, so a
 * portal on it shows its container's tiles. Deeper portals render as cards: a
 * live chain would open a room socket per level.
 */
export const MAX_LIVE_DEPTH = 2;

/**
 * Previews are scaled with a transform rather than by shrinking the box, because
 * cols/rows are shared session state: xterm fits against the element's computed
 * width/height, which a transform leaves alone, so previewing a terminal never
 * reflows the PTY for the people actually working in it.
 */
const PREVIEW_SCALE = 0.5;

const MAX_PRESENCE_AVATARS = 3;

const NO_PRINCIPALS: readonly Principal[] = [];

/** Container names live in the container's row, not its room, so the widget reads its own. */
function usePadName(token: string, padId: string): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (padId === "") return;
    let cancelled = false;
    void getPad(token, padId)
      .then((pad) => {
        if (!cancelled) setName(pad.name);
      })
      .catch((reason: unknown) => {
        // DELIBERATELY console-only, unlike every other failure in this app: nobody asked
        // for this fetch, the widget already reads its fallback label, and a canvas full of
        // widgets would raise one toast per widget on a single network blip.
        console.error("evt=portal_name_failed", reason);
      });
    return () => {
      cancelled = true;
    };
  }, [padId, token]);
  return name;
}

/**
 * One room socket per live widget, opened through the canvas's factory so the session
 * URL and identity stay in one place. Both callbacks are plain dependencies: the canvas
 * hands down a context whose callbacks are stable by construction (presence, the one
 * thing that churned, is a context of its own now), so the socket can be tied to them
 * honestly instead of smuggled past the dependency array in a ref.
 *
 * Ownership follows the CONTAINER, never the role. Escalating to an occupant is a
 * gapless swap (`createWidgetSocketSwitch`), and an effect keyed on the role would
 * defeat it by running its cleanup — closing the socket being painted — before the
 * replacement exists.
 */
function useWidgetSocket(
  containerId: string,
  live: boolean,
  role: WidgetRole,
  open: (padId: string, role: WidgetRole) => SessionClient,
  onFailure: (role: WidgetRole, reason: unknown) => void,
): WidgetSlot<SessionClient> | null {
  const [slot, setSlot] = useState<WidgetSlot<SessionClient> | null>(null);
  const switchRef = useRef<WidgetSocketSwitch | null>(null);
  useEffect(() => {
    if (!live) return;
    const sockets = createWidgetSocketSwitch(
      (nextRole) => open(containerId, nextRole),
      setSlot,
      onFailure,
    );
    switchRef.current = sockets;
    return () => {
      switchRef.current = null;
      sockets.dispose();
    };
  }, [containerId, live, onFailure, open]);
  // Ordered after the effect above within the same commit, so the first request always
  // finds a switch; afterwards this is the only thing a role flip has to do.
  useEffect(() => {
    switchRef.current?.request(role);
  }, [containerId, live, role]);
  return slot;
}

/**
 * The preview's tile tree, re-read whole on every layout change (the tree is
 * small and the SDK deliberately does not diff tile ids). Session changes are
 * re-read too: a leaf's machine badge and exited state come off the room's
 * session table, not the layout.
 */
function usePreviewLayout(client: SessionClient | null): TileLayout | null {
  // The tree is stored with its owning client so a torn-down socket's last tree
  // derives to null instead of being cleared by a synchronous effect setState.
  const [state, setState] = useState<{
    readonly owner: SessionClient;
    readonly layout: TileLayout | null;
  } | null>(null);
  useEffect(() => {
    if (client === null) return;
    const refresh = (): void => {
      setState({ owner: client, layout: client.layout() });
    };
    const offLayout = client.on("layout_changed", refresh);
    const offSessions = client.on("sessions_changed", refresh);
    const offStatus = client.on("status", (status) => {
      if (status === "open") refresh();
    });
    refresh();
    return () => {
      offLayout();
      offSessions();
      offStatus();
    };
  }, [client]);
  if (client === null) return null;
  if (state !== null && state.owner === client) return state.layout;
  // A socket promoted this commit has no cached tree yet, and its effect runs after
  // paint: reading through keeps an engagement from flashing the placeholder card.
  return client.layout();
}

/**
 * Who is IN the container this widget points at, straight off the widget's own socket.
 * A spectator receives the room's roster without joining it, so this is live in both
 * states AND includes this browser the moment engagement makes it an occupant — which
 * the polled pad presence cannot do, since it relocates the local principal to whatever
 * route the browser is on.
 *
 * Roster frames also carry cursors, so the principal set is compared before re-rendering
 * a widget that owns live terminals.
 */
function useRoomOccupants(client: SessionClient | null): readonly Principal[] {
  const [occupants, setOccupants] = useState<readonly Principal[]>(NO_PRINCIPALS);
  useEffect(() => {
    if (client === null) return;
    let signature = "";
    const refresh = (): void => {
      // A principal with two connections in the room is one avatar.
      const seen = new Set<string>();
      const next: Principal[] = [];
      let nextSignature = "";
      for (const state of client.roster.values()) {
        const principal = state.principal;
        if (seen.has(principal.id)) continue;
        seen.add(principal.id);
        next.push(principal);
        nextSignature += ` ${principal.id}`;
      }
      if (nextSignature === signature) return;
      signature = nextSignature;
      setOccupants(next);
    };
    const offRoster = client.on("roster_changed", refresh);
    const offStatus = client.on("status", (status) => {
      if (status === "open") refresh();
    });
    refresh();
    return () => {
      offRoster();
      offStatus();
    };
  }, [client]);
  return occupants;
}

interface OccupantAvatarsProps {
  readonly occupants: readonly Principal[];
  readonly selfId: string | null;
}

/** The name strip's avatar cluster: who is in the container this widget points at. */
function OccupantAvatars({ occupants, selfId }: OccupantAvatarsProps): React.ReactElement | null {
  if (occupants.length === 0) return null;
  return (
    <span
      className="flow-portal__presence"
      aria-label={`${String(occupants.length)} in this composition`}
    >
      {occupants.slice(0, MAX_PRESENCE_AVATARS).map((principal) => (
        <span
          key={principal.id}
          className="flow-portal__avatar"
          style={{ backgroundColor: principal.color }}
          title={
            principal.id === selfId
              ? "you are in this composition"
              : `${principal.name} is in this composition`
          }
        >
          {principal.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {occupants.length > MAX_PRESENCE_AVATARS ? (
        <span className="flow-portal__avatar flow-portal__avatar--more">
          +{occupants.length - MAX_PRESENCE_AVATARS}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The card form's avatars, and the ONLY subscriber to polled presence on a canvas. A
 * card owns no room socket, so the sidebar's poll is all it has — and isolating that
 * read in a leaf is what keeps the 1.5s tick from re-rendering live widgets and the
 * terminals inside them, which is all any of them ever wanted from it.
 */
function PolledOccupantAvatars({
  containerId,
}: {
  readonly containerId: string;
}): React.ReactElement | null {
  const presence = useFlowPadPresence();
  const occupants =
    presence.find((entry) => entry.padId === containerId)?.principals ?? NO_PRINCIPALS;
  return <OccupantAvatars occupants={occupants} selfId={null} />;
}

interface PortalTerminalTileProps {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly tileId: string;
  readonly sessionId: string;
  /** True once the widget paints from an occupant socket: this terminal is real. */
  readonly interactive: boolean;
  /** True for the engaged tile — the one holding the keyboard. */
  readonly active: boolean;
  readonly onEngage: (tileId: string) => void;
  /**
   * The ARITY rule. A composition holding exactly this one terminal is not "a
   * composition containing a terminal" to anybody looking at it — it IS the terminal.
   * So the widget drops its own name strip and the terminal's titlebar becomes the
   * node's chrome, carrying the widget-level verbs: minimize puts the representation
   * away, close deletes the composition (which reaps the shell), maximize walks into it.
   */
  readonly mono: PortalMonoChrome | null;
}

export interface PortalMonoChrome {
  readonly onPark: () => void;
  readonly onClose: () => void;
  readonly onExpand: () => void;
  readonly onRenameTitle: (name: string) => void;
}

function PortalTerminalTile({
  client,
  containerId,
  tileId,
  sessionId,
  interactive,
  active,
  onEngage,
  mono,
}: PortalTerminalTileProps): React.ReactElement {
  const pad = useFlowPad();
  const machineId = client.sessions.get(sessionId)?.machineId;
  return (
    <div
      className={interactive ? "flow-portal__tile flow-portal__tile--live" : "flow-portal__tile"}
      /*
        Engagement, in capture phase so the terminal frame's own pointer handling cannot
        swallow it, and on CLICK so a decompose drag never escalates a socket. In the
        engaged state the same handler moves the keyboard between tiles.
      */
      onClickCapture={() => onEngage(tileId)}
      onDoubleClick={(event) => {
        // A live terminal owns double-click (word selection), so it must not also reach
        // the widget root's navigate-into handler. Watching keeps the old gesture: the
        // shield below still navigates, and it runs before this.
        if (interactive) event.stopPropagation();
      }}
    >
      <TerminalView
        client={client}
        sessionId={sessionId}
        elementId={tileId}
        active={active}
        panelHighlighted={false}
        machine={machineId === undefined ? null : sessionMachine(pad.machines, machineId)}
        // A mono widget's bar is the NODE's chrome, so it stays full even while
        // watching: it is the only titlebar this element has.
        chrome={interactive || mono !== null ? "full" : "preview"}
        {...(mono ?? {})}
      />
      {/*
        Watching: a full-bleed shield keeps clicks and keystrokes out of a terminal
        nobody engaged, navigates on double-click, and is the decompose grab zone —
        dragging it onto empty canvas extracts the tile back into an element.

        Engaged: the SAME element shrinks to the corner grip (`--grip`), which is the
        pointer-events surgery that lets plain clicks, selection and mouse-mode TUIs
        reach the terminal while extraction stays a drag on a visible handle. Disabling
        pointer events instead would have cost the decompose gesture in this state.

        pointerdown is stopped in both so React Flow does not move the node instead
        (the widget moves by its name strip, PORTAL_DRAG_HANDLE).
      */}
      <div
        className={
          interactive ? "flow-portal__shield flow-portal__shield--grip" : "flow-portal__shield"
        }
        title={
          interactive
            ? "Drag onto the canvas to pull this terminal out of the composition"
            : "Click to work in this terminal — drag onto the canvas to pull it out of the composition"
        }
        draggable
        onPointerDown={(event) => event.stopPropagation()}
        /*
          One carry, like every other grab: the envelope is sealed into the drag AND
          the gesture opens, so collaborators watch the tile travel across the canvas
          instead of seeing it teleport on release. The label rides along because the
          viewer has not joined the composition this tile belongs to.
        */
        onDragStart={(event) => {
          pad.carry.begin(
            { kind: "tile", containerId, tileId },
            {
              transfer: event.dataTransfer,
              label: client.sessions.get(sessionId)?.name ?? null,
            },
          );
        }}
        onDragEnd={() => pad.carry.end()}
        onDoubleClick={() => pad.navigate(`/p/${encodeURIComponent(containerId)}`)}
      >
        <span className="flow-portal__grip" aria-hidden="true">
          <ControlIcon kind="grip" size={12} />
        </span>
      </div>
    </div>
  );
}

/**
 * A canvas tiled inside a container renders as a name card, not a live board.
 * The plan's depth-2 contingency: the widget frame, the occupants and the join
 * gesture are what carry meaning, and a nested React Flow instance inside a
 * scaled preview costs a third room socket plus a second canvas renderer.
 */
function PortalPadTile({ padId }: { readonly padId: string }): React.ReactElement {
  const pad = useFlowPad();
  const name = usePadName(pad.token, padId);
  return (
    <div className="flow-portal__pad-card">
      <span className="flow-portal__card-glyph" aria-hidden="true">
        <ItemIcon kind="canvas" size={22} />
      </span>
      <strong>{name ?? "canvas"}</strong>
      <button
        type="button"
        className="flow-portal__enter"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => pad.navigate(`/p/${encodeURIComponent(padId)}`)}
      >
        Open
      </button>
    </div>
  );
}

/**
 * The one terminal a composition holds, or null when it holds anything else. This is
 * the whole arity rule: a container of exactly one terminal renders AS that terminal.
 */
export function soloTerminalLeaf(
  layout: TileLayout,
): { readonly tileId: string; readonly sessionId: string } | null {
  let found: { readonly tileId: string; readonly sessionId: string } | null = null;
  for (const node of Object.values(layout)) {
    if (node.dir !== null) continue;
    // A second leaf ends it even when that leaf is EMPTY: splitting a container is how
    // someone says "this is a composition now", and the empty half is the invitation.
    if (found !== null || node.surface?.kind !== "terminal") return null;
    found = { tileId: node.id, sessionId: node.surface.sessionId };
  }
  return found;
}

interface PortalLeafProps {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly node: TileNode;
  readonly interactive: boolean;
  readonly engagedTileId: string | null;
  readonly onEngage: (tileId: string) => void;
  /** Non-null only for the ONE leaf of a mono container — see {@link soloTerminalLeaf}. */
  readonly mono: PortalMonoChrome | null;
}

/**
 * ONE leaf of a widget's tree. The recursion above it — splits, ratio dividers, panes —
 * is `TileTree`, the same component the fullscreen route draws, so this is the whole of
 * what a canvas widget still renders for itself: the species switch plus the engagement
 * shield that makes a previewed terminal watchable and extractable.
 */
function PortalLeaf({
  client,
  containerId,
  node,
  interactive,
  engagedTileId,
  onEngage,
  mono,
}: PortalLeafProps): React.ReactElement {
  const surface = node.surface;
  if (surface === null) return <div className="flow-portal__empty">empty tile</div>;
  switch (surface.kind) {
    case "terminal":
      return (
        <PortalTerminalTile
          client={client}
          containerId={containerId}
          tileId={node.id}
          sessionId={surface.sessionId}
          interactive={interactive}
          active={interactive && engagedTileId === node.id}
          onEngage={onEngage}
          // Only a mono container hands this down; inside a multi-tile preview the
          // widget keeps its own bar and each tile keeps its preview chrome.
          mono={mono}
        />
      );
    case "pad":
      return <PortalPadTile padId={surface.padId} />;
    case "text":
      /*
        A note inside a widget preview is a READ of the composition's own document — the
        element lives there, so the text is whatever the room says it is. It is not editable
        from a preview even when engaged: editing belongs to the composition's renderer,
        which is one double-click away, and a scaled 0.5 textarea is not an editor.
      */
      return (
        <div className="flow-portal__note">
          {client.elements.get(surface.elementId)?.type === "text"
            ? client.elementText(surface.elementId)?.toString()
            : null}
        </div>
      );
    default: {
      const exhaustiveSurface: never = surface;
      return exhaustiveSurface;
    }
  }
}

function PortalNodeImpl({ id, data }: NodeProps): React.ReactElement {
  countRender("portal-node");
  const containerId = typeof data["containerId"] === "string" ? data["containerId"] : "";
  const pad = useFlowPad();
  const live = pad.depth < MAX_LIVE_DEPTH && containerId !== "";
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The tile AREA: what drop geometry measures, so the strip is excluded by construction. */
  const areaRef = useRef<HTMLDivElement | null>(null);
  /**
   * The engagement remembers WHICH container it was made in: a widget that stops
   * being live or starts pointing elsewhere derives back to spectator instead of
   * being reset by an effect (the socket it engaged through is gone either way).
   */
  const [engagement, setEngagement] = useState<{
    readonly containerId: string;
    readonly tileId: string;
  } | null>(null);
  const engagedTileId =
    engagement !== null && engagement.containerId === containerId && live
      ? engagement.tileId
      : null;
  const engaged = engagedTileId !== null;
  const notify = pad.notify;
  /**
   * Stable, because the socket effect now depends on it honestly: engaging is a direct
   * action, so its failure has to be visible — without this the viewer is left clicking
   * into a tile that will never accept a keystroke.
   */
  const onSocketFailure = useCallback(
    (failedRole: WidgetRole) => {
      setEngagement(null);
      notify(
        failedRole === "occupant"
          ? "Could not open this composition for editing."
          : "Could not open this composition.",
      );
    },
    [notify],
  );
  const slot = useWidgetSocket(
    containerId,
    live,
    engaged ? "occupant" : "spectator",
    pad.openClient,
    onSocketFailure,
  );
  const client = slot?.client ?? null;
  /** Engagement is only real once the occupant socket is the one being painted. */
  const interactive = slot !== null && slot.role === "occupant";
  const layout = usePreviewLayout(client);
  const name = usePadName(pad.token, containerId);
  const roomOccupants = useRoomOccupants(client);
  const selfId = client?.self?.id ?? null;

  useEffect(() => {
    if (!engaged) return;
    const disengage = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      /*
       * The frame's resize controls live OUTSIDE `.flow-portal` (the frame clips its
       * overflow, and a clipped control is a dead pointer target), but grabbing this
       * widget's own border is not a press "outside the widget": dropping occupancy
       * mid-resize would close the occupant socket under the pointer and hand a
       * transient view its excuse to pop. They are the widget's only other children
       * in the node wrapper, so the wrapper is the whole test.
       */
      if (
        target instanceof Element &&
        root.parentElement?.contains(target) === true &&
        target.closest(".react-flow__resize-control") !== null
      ) {
        return;
      }
      setEngagement(null);
    };
    // Capture on the document: a press a canvas handler stops must still end
    // engagement, and only the document sees every press on the page.
    document.addEventListener("pointerdown", disengage, true);
    return () => {
      document.removeEventListener("pointerdown", disengage, true);
    };
  }, [engaged]);

  const enter = (): void => {
    if (containerId === "") return;
    pad.navigate(`/p/${encodeURIComponent(containerId)}`);
  };

  /**
   * The arity rule, resolved. A composition holding exactly one terminal renders AS
   * that terminal: no widget name strip, no half-scale preview, the terminal's own
   * titlebar carrying this element's verbs. Everything else — an empty container, two
   * tiles, a canvas, a note — is a composition and wears composition chrome.
   */
  const solo = client === null || layout === null ? null : soloTerminalLeaf(layout);
  const mono: PortalMonoChrome | null =
    solo === null
      ? null
      : {
          // Minimize: the representation leaves this canvas. Nothing else references the
          // terminal's home afterwards, which is exactly what "unplaced" means now.
          onPark: () => pad.removeElement(id),
          // Close: the composition goes, and the shell it holds goes with it.
          onClose: () => pad.onDeleteContainer(containerId, id),
          onExpand: enter,
          onRenameTitle: (name: string) => pad.onRenameTerminal(solo.sessionId, name),
        };

  /**
   * The leaf half of the shared tree, bound to the socket being painted. Everything
   * above a leaf is `TileTree`; a widget contributes its leaves' chrome and nothing else.
   */
  const renderLeaf =
    (socket: SessionClient) =>
    (node: TileNode): ReactNode => (
      <PortalLeaf
        client={socket}
        containerId={containerId}
        node={node}
        interactive={interactive}
        engagedTileId={engagedTileId}
        onEngage={(tileId) => setEngagement({ containerId, tileId })}
        // The arity rule reaches exactly ONE leaf: a mono container's single terminal
        // wears this element's verbs, and no leaf of a real composition ever does.
        mono={solo !== null && node.id === solo.tileId ? mono : null}
      />
    );

  /**
   * The widget is the only place its own layout is visible — the canvas holds no
   * channel on that container — so aim resolution lives HERE: the overlay reads the
   * canvas's pointer from the shared store, resolves against this tree, and publishes
   * the destination back for the canvas to commit at release.
   */
  const dropHost = useMemo<TileDropHost>(
    () => ({
      areaRef,
      layout,
      containerId,
      widget: { padId: pad.padId, elementId: id },
      dividerPx: PORTAL_TREE_CLASSES.dividerPx,
      assess: pad.assessDrop,
      elementSeat: pad.elementSeat,
    }),
    [containerId, id, layout, pad.assessDrop, pad.elementSeat, pad.padId],
  );

  /** What a displaced or carried surface is called, from this widget's own socket. */
  const occupantLabel = useCallback(
    (surface: TileSurface): string | null => {
      if (surface.kind === "terminal") {
        return client?.sessions.get(surface.sessionId)?.name ?? null;
      }
      return null;
    },
    [client],
  );
  const carryLabel = useCallback(
    (envelope: ItemEnvelope): string | null =>
      envelope.kind === "terminal"
        ? (client?.sessions.get(envelope.sessionId)?.name ?? null)
        : null,
    [client],
  );

  const overlay = (
    <>
      <TilePreviewOverlay
        host={dropHost}
        store={pad.dropStore}
        surfaceLabel={occupantLabel}
        carryLabel={carryLabel}
      />
      <TileZoneDebug layout={layout} areaRef={areaRef} dividerPx={PORTAL_TREE_CLASSES.dividerPx} />
    </>
  );

  const rootClass = [
    "flow-portal",
    mono === null ? "" : MONO_PORTAL_CLASS,
    interactive ? "flow-portal--engaged" : "",
    engaged && !interactive ? "flow-portal--engaging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {/*
        Desktop-window ergonomics, identical to a terminal node's: the frame border is
        the grab zone, so the pointer turns into a resize cursor on hover and no
        selection step is needed. Rendered as a SIBLING of `.flow-portal` rather than a
        child because the widget frame clips its overflow (the preview must not spill),
        and a clipped control is a dead pointer target — the outer half of every edge
        band would be unreachable. The controls carry no paint (the cursor is the
        affordance) and commit once on resize end, matching the drag path.
      */}
      <NodeResizer
        nodeId={id}
        isVisible={pad.tool === "select"}
        lineClassName="flow-portal-resize-edge"
        handleClassName="flow-portal-resize-corner"
        minWidth={mono === null ? MIN_PORTAL_WIDTH : MIN_TERMINAL_WIDTH}
        minHeight={mono === null ? MIN_PORTAL_HEIGHT : MIN_TERMINAL_HEIGHT}
        onResize={(_event, params) =>
          pad.onResize(id, params.x, params.y, params.width, params.height)
        }
        onResizeEnd={(_event, params) =>
          pad.onResizeEnd(id, params.x, params.y, params.width, params.height)
        }
      />
      <div className={rootClass} ref={rootRef} onDoubleClick={enter}>
        {mono !== null ? null : (
          <NodeTitleBar
            className="flow-portal__strip"
            icon={<ItemIcon kind="composition" size={13} />}
            title={name}
            defaultTitle="composition"
            middle={
              client === null ? (
                <PolledOccupantAvatars containerId={containerId} />
              ) : (
                <OccupantAvatars occupants={roomOccupants} selfId={selfId} />
              )
            }
            onMinimize={() => pad.removeElement(id)}
            minimizeLabel={`Put away composition ${name ?? containerId}`}
            minimizeTooltip="Remove this widget from the canvas (the composition keeps running)"
            onMaximize={enter}
            maximizeLabel={`Open composition ${name ?? containerId}`}
            maximizeTooltip="Open this composition"
            onClose={() => pad.onDeleteContainer(containerId, id)}
            closeLabel={`Delete composition ${name ?? containerId}`}
            closeTooltip="Delete this composition for everyone"
          />
        )}
        <div className="flow-portal__viewport">
          {mono !== null && solo !== null && client !== null ? (
            // 1:1, not the half-scale preview: this IS the terminal, not a picture of one.
            <div className="tile-area" ref={areaRef}>
              <TileTree
                layout={layout ?? {}}
                classes={PORTAL_TREE_CLASSES}
                interactive={interactive}
                /*
                  A divider only drags in the ENGAGED state, and the socket being painted
                  then IS the occupant one — so this is the very write the fullscreen route
                  makes, over the channel this widget already holds.
                */
                onRatios={(splitId, ratios) => client.setTileRatios(splitId, ratios)}
                renderLeaf={renderLeaf(client)}
              />
              {overlay}
            </div>
          ) : client !== null && layout !== null ? (
            <div
              className="flow-portal__preview"
              style={{
                width: `${String(100 / PREVIEW_SCALE)}%`,
                height: `${String(100 / PREVIEW_SCALE)}%`,
                transform: `scale(${String(PREVIEW_SCALE)})`,
              }}
            >
              {/*
                The area sits INSIDE the scale: its layout px match the tree's own
                (divider math), while its client rect is the on-screen box (pointer
                and ring math) — the overlay's unit space is indifferent to both.
              */}
              <div className="tile-area" ref={areaRef}>
                <TileTree
                  layout={layout}
                  classes={PORTAL_TREE_CLASSES}
                  interactive={interactive}
                  onRatios={(splitId, ratios) => client.setTileRatios(splitId, ratios)}
                  renderLeaf={renderLeaf(client)}
                />
                {overlay}
              </div>
            </div>
          ) : (
            // The card form still hosts the overlay: a widget whose layout this canvas
            // cannot see keeps the canvas door, so drops on it stay targetable.
            <div className="tile-area" ref={areaRef}>
              <div className="flow-portal__card">
                <span className="flow-portal__card-glyph" aria-hidden="true">
                  <ItemIcon kind="composition" size={22} />
                </span>
                <span className="flow-portal__card-hint">
                  {live ? "opening composition…" : "nested composition — open it to work inside"}
                </span>
              </div>
              {overlay}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Memoized for the same reason terminal nodes are: React Flow re-renders the node
 * being dragged once per pointermove, and a widget owns live terminals.
 */
export const PortalNode = memo(PortalNodeImpl);
