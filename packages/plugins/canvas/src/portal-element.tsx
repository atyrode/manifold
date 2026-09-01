import { itemNoun, type HostServices } from "@manifold/plugin";
import {
  elementString,
  soloLeaf,
  type Principal,
  type TileLayout,
  type Tile,
  type TileRef,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ControlIcon,
  Cover,
  ItemIcon,
  NodeTitleBar,
  PORTAL_TREE_CLASSES,
  Stack,
  TilePreviewOverlay,
  TileTree,
  TileZoneDebug,
  setVantage,
} from "@manifold/plugin/ui";
import {
  TerminalRenderer,
  countRender,
  remoteTileCarries,
  refDisplayLabel,
  useRemoteGestures,
  useTileDrop,
  type ItemEnvelope,
  type TileDropHost,
  type TileDropStore,
} from "@manifold/plugin/hooks";
import {
  MIN_TERMINAL_HEIGHT,
  MIN_TERMINAL_WIDTH,
  useCanvas,
  useCanvasPresence,
} from "./terminal-element.tsx";
import {
  createPortalSocketSwitch,
  type ChannelRole,
  type PortalSlot,
  type PortalSocketSwitch,
} from "./portal-engagement.ts";

/**
 * The canvas face of a composition. A view and a container are one object, so a
 * container sitting inside a canvas is a plain scene element (`type: "portal"`)
 * that renders as a live portal: the container's own tiles, its occupants, and a
 * double-click that navigates into it.
 *
 * A portal has two states, and the difference between them is a socket discipline
 * rather than a mode switch anyone has to learn:
 *
 *   WATCHING (resting) — a spectator socket. The tiles are live pixels, but nothing
 *     in them is writable, the container's occupant list does not include this
 *     browser, and a transient view is free to dissolve while the portal watches.
 *   ENGAGED — an occupant socket to the same container. The tiles are ordinary
 *     terminals: typing, selection, resize and focus presence all flow, the roster
 *     (and therefore every avatar strip) shows this principal, and the bubble rule
 *     correctly refuses to pop a view somebody is working in.
 *
 * ENGAGEMENT RULE — one gesture each way, no timers:
 *   engage    a plain CLICK on a tile. Click, not pointerdown: a press that becomes a
 *             drag has to extract the tile, so escalating on the press would make
 *             every decompose drag an occupancy claim.
 *   disengage a POINTERDOWN anywhere outside this portal (document capture). Same rule
 *             a window manager uses for focus, so it needs no teaching, and it means
 *             an abandoned portal drops back to spectator instead of pinning a bubble.
 */

/**
 * React Flow drag handle for a portal node: the name strip only, so the preview
 * body stays free for the tile drags that decompose a composition.
 */
export const PORTAL_DRAG_HANDLE = ".portal__strip";

/**
 * A portal rendering its container's ONE terminal as itself (the arity rule). The class
 * is load-bearing beyond paint: it scopes the canvas's drag-handle selector, so only a
 * mono portal is moved by the terminal titlebar inside it — inside a multi-tile portal
 * that same titlebar belongs to a tile, whose drag extracts rather than moves.
 */
export const MONO_PORTAL_CLASS = "portal--mono";
export const MONO_PORTAL_CLASS_SELECTOR = `.${MONO_PORTAL_CLASS}`;

/**
 * Resize is canvas-item chrome, not terminal chrome: a portal's frame border is a
 * grab zone exactly as a terminal's is (same 8px edges, same 14px corners, same
 * transparent controls), so the two species read as one. The floor is a portal's,
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
 * cols/rows are shared terminal state: xterm fits against the element's computed
 * width/height, which a transform leaves alone, so previewing a terminal never
 * reflows the PTY for the people actually working in it.
 */
const PREVIEW_SCALE = 0.5;

const MAX_PRESENCE_AVATARS = 3;

const NO_PRINCIPALS: readonly Principal[] = [];

/** Container names live in the container's row, not its room, so the portal reads its own. */
function useContainerName(host: HostServices, containerId: string): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (containerId === "") return;
    let cancelled = false;
    void host.client
      .getContainer(containerId)
      .then((container) => {
        if (!cancelled) setName(container.name);
      })
      .catch((reason: unknown) => {
        // DELIBERATELY console-only, unlike every other failure in this app: nobody asked
        // for this fetch, the portal already reads its fallback label, and a canvas full of
        // portals would raise one notice per portal on a single network blip.
        console.error("evt=portal_name_failed", reason);
      });
    return () => {
      cancelled = true;
    };
  }, [host.client, containerId]);
  return name;
}

/**
 * One room socket per live portal, opened through the canvas's factory so the terminal
 * URL and identity stay in one place. Both callbacks are plain dependencies: the canvas
 * hands down a context whose callbacks are stable by construction (presence, the one
 * thing that churned, is a context of its own now), so the socket can be tied to them
 * honestly instead of smuggled past the dependency array in a ref.
 *
 * Ownership follows the CONTAINER, never the role. Escalating to an occupant is a
 * gapless swap (`createPortalSocketSwitch`), and an effect keyed on the role would
 * defeat it by running its cleanup — closing the socket being painted — before the
 * replacement exists.
 */
function usePortalSocket(
  containerId: string,
  live: boolean,
  role: ChannelRole,
  open: (containerId: string, role: ChannelRole) => SessionClient,
  onFailure: (role: ChannelRole, reason: unknown) => void,
): PortalSlot<SessionClient> | null {
  const [slot, setSlot] = useState<PortalSlot<SessionClient> | null>(null);
  const switchRef = useRef<PortalSocketSwitch | null>(null);
  useEffect(() => {
    if (!live) return;
    const sockets = createPortalSocketSwitch(
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
 * small and the SDK deliberately does not diff tile ids). Terminal changes are
 * re-read too: a leaf's machine badge and exited state come off the room's
 * terminal table, not the layout.
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
    const offTerminals = client.on("terminals_changed", refresh);
    const offStatus = client.on("status", (status) => {
      if (status === "open") refresh();
    });
    refresh();
    return () => {
      offLayout();
      offTerminals();
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
 * Who is IN the container this portal points at, straight off the portal's own socket.
 * A spectator receives the room's roster without joining it, so this is live in both
 * states AND includes this browser the moment engagement makes it an occupant — which
 * the polled container presence cannot do, since it relocates the local principal to whatever
 * route the browser is on.
 *
 * Roster frames also carry cursors, so the principal set is compared before re-rendering
 * a portal that owns live terminals.
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
      for (const state of client.attendance.values()) {
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
    const offAttendance = client.on("attendance_changed", refresh);
    const offStatus = client.on("status", (status) => {
      if (status === "open") refresh();
    });
    refresh();
    return () => {
      offAttendance();
      offStatus();
    };
  }, [client]);
  return occupants;
}

interface OccupantAvatarsProps {
  readonly occupants: readonly Principal[];
  readonly selfId: string | null;
}

/** The name strip's avatar cluster: who is in the container this portal points at. */
function OccupantAvatars({ occupants, selfId }: OccupantAvatarsProps): React.ReactElement | null {
  if (occupants.length === 0) return null;
  return (
    <span
      className="portal__presence"
      aria-label={`${String(occupants.length)} in this composition`}
    >
      {occupants.slice(0, MAX_PRESENCE_AVATARS).map((principal) => (
        <span
          key={principal.id}
          className="portal__avatar"
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
        <span className="portal__avatar portal__avatar--more">
          +{occupants.length - MAX_PRESENCE_AVATARS}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The card form's avatars, and the ONLY subscriber to polled presence on a canvas. A
 * card owns no room socket, so the sidebar's poll is all it has — and isolating that
 * read in a leaf is what keeps the 1.5s tick from re-rendering live portals and the
 * terminals inside them, which is all any of them ever wanted from it.
 */
function PolledOccupantAvatars({
  containerId,
}: {
  readonly containerId: string;
}): React.ReactElement | null {
  const presence = useCanvasPresence();
  const occupants =
    presence.find((entry) => entry.containerId === containerId)?.principals ?? NO_PRINCIPALS;
  return <OccupantAvatars occupants={occupants} selfId={null} />;
}

interface PortalTerminalTileProps {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly tileId: string;
  readonly terminalId: string;
  /** True once the portal paints from an occupant socket: this terminal is real. */
  readonly interactive: boolean;
  /** True for the engaged tile — the one holding the keyboard. */
  readonly active: boolean;
  readonly onEngage: (tileId: string) => void;
  /**
   * The ARITY rule. A composition holding exactly this one terminal is not "a
   * composition containing a terminal" to anybody looking at it — it IS the terminal.
   * So the portal drops its own name strip and the terminal's titlebar becomes the
   * node's chrome, carrying the portal-level verbs: minimize puts the representation
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
  terminalId,
  interactive,
  active,
  onEngage,
  mono,
}: PortalTerminalTileProps): React.ReactElement {
  const container = useCanvas();
  const machineId = client.terminals.get(terminalId)?.machineId;
  return (
    <div
      className={interactive ? "portal__tile flow-portal__tile--live" : "portal__tile"}
      /*
        Engagement, in capture phase so the terminal frame's own pointer handling cannot
        swallow it, and on CLICK so a decompose drag never escalates a socket. In the
        engaged state the same handler moves the keyboard between tiles.
      */
      onClickCapture={() => onEngage(tileId)}
      onDoubleClick={(event) => {
        // A live terminal owns double-click (word selection), so it must not also reach
        // the portal root's navigate-into handler. Watching keeps the old gesture: the
        // shield below still navigates, and it runs before this.
        if (interactive) event.stopPropagation();
      }}
    >
      {/*
        The terminal arrives through the COMPOSITION, not an import: `core.terminals` owns the
        viewer and this plugin may not name it. A miss (unregistered, or its plugin disabled)
        paints the engine's named placeholder in the same box.
      */}
      <TerminalRenderer
        client={client}
        terminalId={terminalId}
        elementId={tileId}
        active={active}
        panelHighlighted={false}
        machine={
          machineId === undefined
            ? null
            : (container.machines?.find((candidate) => candidate.id === machineId) ?? null)
        }
        // A mono portal's bar is the NODE's chrome, so it stays full even while
        // watching: it is the only titlebar this element has.
        chrome={interactive || mono !== null ? "full" : "preview"}
        {...(mono ?? {})}
        // The mono bar renames the TERMINAL, so its input names the action it fires.
        {...(mono === null ? {} : { renameAction: "core.terminals.rename" })}
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
        (the portal moves by its name strip, PORTAL_DRAG_HANDLE).
      */}
      <div
        className={interactive ? "portal__shield portal__shield--grip" : "portal__shield"}
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
          container.carry.begin(
            { kind: "tile", containerId, tileId },
            {
              transfer: event.dataTransfer,
              label: client.terminals.get(terminalId)?.name ?? null,
            },
          );
        }}
        onDragEnd={() => container.carry.end()}
        onDoubleClick={() => container.navigate(`/p/${encodeURIComponent(containerId)}`)}
      >
        <span className="portal__grip" aria-hidden="true">
          <ControlIcon kind="grip" size={12} />
        </span>
      </div>
    </div>
  );
}

/**
 * A canvas placed inside a container renders as a name card, not a live canvas.
 * The plan's depth-2 contingency: the portal frame, the occupants and the join
 * gesture are what carry meaning, and a nested React Flow instance inside a
 * scaled preview costs a third room socket plus a second canvas renderer.
 */
function PortalContainerTile({
  containerId,
}: {
  readonly containerId: string;
}): React.ReactElement {
  const container = useCanvas();
  const name = useContainerName(container.host, containerId);
  return (
    <Cover className="portal__container-card">
      <Stack gap="0.3rem" align="center">
        <span className="portal__card-glyph" aria-hidden="true">
          <ItemIcon kind="canvas" size={22} />
        </span>
        <strong>{name ?? itemNoun("canvas", container.host.assembly.roster())}</strong>
        <button
          type="button"
          className="portal__enter"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => container.navigate(`/p/${encodeURIComponent(containerId)}`)}
        >
          Open
        </button>
      </Stack>
    </Cover>
  );
}

/**
 * The one terminal a composition holds, or null when it holds anything else.
 *
 * The ARITY half — "exactly one occupied leaf" — is `soloLeaf` in `@manifold/protocol`, a fact
 * about the layout record that the compositions renderer needs in the same words (issue #117).
 * What is left here is the SPECIES test: this renderer only stands in for a TERMINAL, because
 * a terminal is the one occupant whose own chrome can carry a portal's verbs.
 */
function soloTerminal(
  layout: TileLayout,
): { readonly tileId: string; readonly terminalId: string } | null {
  const solo = soloLeaf(layout);
  if (solo === null || solo.ref.kind !== "terminal") return null;
  return { tileId: solo.tileId, terminalId: solo.ref.terminalId };
}

interface PortalLeafProps {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly node: Tile;
  readonly interactive: boolean;
  readonly engagedTileId: string | null;
  readonly onEngage: (tileId: string) => void;
  /** Non-null only for the ONE leaf of a mono container — see {@link soloTerminal}. */
  readonly mono: PortalMonoChrome | null;
}

/**
 * ONE leaf of a portal's tree. The recursion above it — splits, ratio dividers, panes —
 * is `TileTree`, the same component the fullscreen route draws, so this is the whole of
 * what a canvas portal still renders for itself: the species switch plus the engagement
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
  const ref = node.ref;
  // A spacer is inert workspace furniture (issue #89) — a portal preview never legitimately
  // holds one, any more than it holds a panel, but unlike a stray panel it carries no
  // capability worth naming: it reads exactly like the empty tile it is functionally equal to.
  if (ref === null || ref.kind === "spacer") {
    return <Cover className="portal__empty">empty tile</Cover>;
  }
  switch (ref.kind) {
    case "terminal":
      return (
        <PortalTerminalTile
          client={client}
          containerId={containerId}
          tileId={node.id}
          terminalId={ref.terminalId}
          interactive={interactive}
          active={interactive && engagedTileId === node.id}
          onEngage={onEngage}
          // Only a mono container hands this down; inside a multi-tile preview the
          // portal keeps its own bar and each tile keeps its preview chrome.
          mono={mono}
        />
      );
    case "container":
      return <PortalContainerTile containerId={ref.containerId} />;
    case "text":
      /*
        A note inside a portal preview is a READ of the composition's own document — the
        element lives there, so the text is whatever the room says it is. It is not editable
        from a preview even when engaged: editing belongs to the composition's renderer,
        which is one double-click away, and a scaled 0.5 textarea is not an editor.
      */
      return (
        <div className="flow-portal__note">
          {client.elements.get(ref.elementId)?.type === "text"
            ? client.elementText(ref.elementId)?.toString()
            : null}
        </div>
      );
    case "panel":
      /*
        A portal preview is a window onto a ROOM's tree, and no room's tree holds panels:
        panels are leaves of a principal's workspace layout, which the shell renders. A
        panel reaching here is therefore a layout written by something that had no business
        writing it, so this says exactly that instead of pretending to draw a panel.
      */
      return <div className="plugin-placeholder">{ref.panelId}</div>;
    default: {
      const exhaustiveRef: never = ref;
      return exhaustiveRef;
    }
  }
}

/**
 * The portal's OWN room, as a second feed of peer aims.
 *
 * Gesture relay is room-scoped while `CarryAim.containerId` addresses a CONTAINER, so a
 * collaborator dragging inside this composition's fullscreen route publishes into that
 * container's room and the canvas — listening only to its own room — never hears it,
 * even though this portal holds a live socket to exactly that room and is already
 * receiving those frames. Reading them here closes that direction with no protocol
 * change: the store merges feeds per container, freshest wins.
 *
 * The reverse direction (someone dragging over this portal, watched by a peer sitting in
 * the container's route) still needs a SERVER-side relay of carry frames whose
 * `aim.containerId` names another room, and is not solved here.
 *
 * A component rather than a hook call in the parent, because the socket only exists
 * while the portal is live: mounting is the honest way to express "listen while there is
 * something to listen to", and unmounting retires the feed.
 */
function PortalAimFeed({
  client,
  containerId,
  store,
}: {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly store: TileDropStore;
}): null {
  const overrides = useRemoteGestures(client);
  useEffect(() => {
    store.setRemote(`portal:${containerId}`, remoteTileCarries(overrides.values()));
  }, [containerId, overrides, store]);
  useEffect(
    () => () => {
      store.setRemote(`portal:${containerId}`, new Map());
    },
    [containerId, store],
  );
  return null;
}

function PortalNodeImpl({ id, data }: NodeProps): React.ReactElement {
  countRender("portal-node");
  const containerId = typeof data["containerId"] === "string" ? data["containerId"] : "";
  const container = useCanvas();
  const live = container.depth < MAX_LIVE_DEPTH && containerId !== "";
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The tile AREA: what drop geometry measures, so the strip is excluded by construction. */
  const areaRef = useRef<HTMLDivElement | null>(null);
  /**
   * The engagement remembers WHICH container it was made in: a portal that stops
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
  const notify = container.notify;
  /**
   * Stable, because the socket effect now depends on it honestly: engaging is a direct
   * action, so its failure has to be visible — without this the viewer is left clicking
   * into a tile that will never accept a keystroke.
   */
  const onSocketFailure = useCallback(
    (failedRole: ChannelRole) => {
      setEngagement(null);
      notify(
        failedRole === "occupant"
          ? "Could not open this composition for editing."
          : "Could not open this assembly.",
      );
    },
    [notify],
  );
  const slot = usePortalSocket(
    containerId,
    live,
    engaged ? "occupant" : "spectator",
    container.openClient,
    onSocketFailure,
  );
  const client = slot?.client ?? null;
  /** Engagement is only real once the occupant socket is the one being painted. */
  const interactive = slot !== null && slot.role === "occupant";
  const layout = usePreviewLayout(client);
  const name = useContainerName(container.host, containerId);
  const roomOccupants = useRoomOccupants(client);
  const selfId = client?.self?.id ?? null;
  /** Stable per roster change: what to CALL a kind whose word is not the floor's. */
  const roster = container.host.assembly.roster();

  useEffect(() => {
    if (!engaged) return;
    const disengage = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      /*
       * The frame's resize controls live OUTSIDE `.portal` (the frame clips its
       * overflow, and a clipped control is a dead pointer target), but grabbing this
       * portal's own border is not a press "outside the portal": dropping occupancy
       * mid-resize would close the occupant socket under the pointer and hand a
       * transient view its excuse to pop. They are the portal's only other children
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

  /**
   * Focus, published (A2). The ENGAGED portal is the one that speaks: every other portal on
   * the canvas would otherwise publish "nothing focused" and clobber it, so the transition —
   * and its cleanup, which covers disengaging, socket failure and unmount alike — is the
   * whole writer. Floor for now, `"until": "core.presence"`.
   */
  useEffect(() => {
    if (engagedTileId === null) return;
    setVantage({ focusedContainerId: containerId });
    return () => setVantage({ focusedContainerId: null });
  }, [containerId, engagedTileId]);

  const enter = (): void => {
    if (containerId === "") return;
    container.navigate(`/p/${encodeURIComponent(containerId)}`);
  };

  /**
   * The arity rule, resolved. A composition holding exactly one terminal renders AS
   * that terminal: no portal name strip, no half-scale preview, the terminal's own
   * titlebar carrying this element's verbs. Everything else — an empty container, two
   * tiles, a canvas, a note — is a composition and wears composition chrome.
   */
  const solo = client === null || layout === null ? null : soloTerminal(layout);
  const mono: PortalMonoChrome | null =
    solo === null
      ? null
      : {
          // Minimize: the representation leaves this canvas. Nothing else references the
          // terminal's home afterwards, which is exactly what "unplaced" means now.
          onPark: () => container.unplaceElement(id),
          // Close: the composition goes, and the shell it holds goes with it.
          onClose: () => container.onDeleteContainer(containerId, id),
          onExpand: enter,
          onRenameTitle: (name: string) => container.onRenameTerminal(solo.terminalId, name),
        };

  /**
   * The leaf half of the shared tree, bound to the socket being painted. Everything
   * above a leaf is `TileTree`; a portal contributes its leaves' chrome and nothing else.
   */
  const renderLeaf =
    (socket: SessionClient) =>
    (node: Tile): ReactNode => (
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
   * What a tile ref is CALLED here, through the one shared switch. The portal can answer all
   * three document questions — terminals and element text from its own room socket, container
   * names from the index the canvas holds — and carries the roster for the fourth, so the same
   * drag reads the same words here and on the fullscreen route instead of captioning terminals
   * only.
   */
  const occupantLabel = useCallback(
    (ref: TileRef | null): string | null =>
      refDisplayLabel(ref, {
        terminalName: (terminalId) => client?.terminals.get(terminalId)?.name ?? null,
        containerName: container.containerName,
        textElement: (elementId) => {
          const element = client?.elements.get(elementId);
          /*
            No `type === "text"` guard: the payload answers null for an element bearing no text
            (ADR 0013 §16), which asks the same question without this renderer holding another
            plugin's wire type — and the type it DOES report is what words a nameless label.
          */
          return element === undefined
            ? null
            : { type: element.type, text: elementString(element, "text") ?? "" };
        },
        roster,
      }),
    [client, container.containerName, roster],
  );
  const carryLabel = useCallback(
    (envelope: ItemEnvelope): string | null => {
      switch (envelope.kind) {
        case "terminal":
          return client?.terminals.get(envelope.terminalId)?.name ?? null;
        case "tile":
          return envelope.containerId === containerId
            ? occupantLabel(layout?.[envelope.tileId]?.ref ?? null)
            : null;
        case "canvas":
        case "composition":
          return container.containerName(envelope.containerId);
        // See `canvas-view.tsx`: new structure is named by the vocabulary, not by a renderer.
        case "element":
        case "structure":
          return null;
        default: {
          const exhaustive: never = envelope;
          return exhaustive;
        }
      }
    },
    // `container`, not `container.containerName`: the name lookup is CALLED here, so the receiver is what this
    // callback actually closes over — and the context object hands out a fresh lookup with
    // every rebuild anyway, so the two move together.
    [client, containerId, layout, occupantLabel, container],
  );

  /**
   * The portal is the only place its own layout is visible — the canvas holds no
   * channel on that container — so aim resolution lives HERE, in ONE pipeline created
   * by this host and handed to the overlay: the overlay reads the canvas's pointer from
   * the shared store, resolves against this tree, and publishes the aim back both for
   * the canvas to commit at release and for this drag's carry frames to carry.
   */
  const dropHost = useMemo<TileDropHost>(
    () => ({
      areaRef,
      layout,
      containerId,
      portal: { containerId: container.containerId, elementId: id },
      dividerPx: PORTAL_TREE_CLASSES.dividerPx,
      assess: container.assessDrop,
      elementSeat: container.elementSeat,
      describeCarry: carryLabel,
    }),
    [
      carryLabel,
      containerId,
      id,
      layout,
      container.assessDrop,
      container.elementSeat,
      container.containerId,
    ],
  );
  const tileDrop = useTileDrop(dropHost);

  const overlay = (
    <>
      {client === null ? null : (
        <PortalAimFeed client={client} containerId={containerId} store={container.dropStore} />
      )}
      <TilePreviewOverlay drop={tileDrop} store={container.dropStore} refLabel={occupantLabel} />
      <TileZoneDebug layout={layout} areaRef={areaRef} dividerPx={PORTAL_TREE_CLASSES.dividerPx} />
    </>
  );

  const rootClass = [
    "portal",
    mono === null ? "" : MONO_PORTAL_CLASS,
    interactive ? "portal--engaged" : "",
    engaged && !interactive ? "portal--engaging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {/*
        Desktop-window ergonomics, identical to a terminal node's: the frame border is
        the grab zone, so the pointer turns into a resize cursor on hover and no
        selection step is needed. Rendered as a SIBLING of `.portal` rather than a
        child because the portal frame clips its overflow (the preview must not spill),
        and a clipped control is a dead pointer target — the outer half of every edge
        band would be unreachable. The controls carry no paint (the cursor is the
        affordance) and commit once on resize end, matching the drag path.
      */}
      <NodeResizer
        nodeId={id}
        isVisible={container.tool === "select"}
        lineClassName="portal-resize-edge"
        handleClassName="portal-resize-corner"
        minWidth={mono === null ? MIN_PORTAL_WIDTH : MIN_TERMINAL_WIDTH}
        minHeight={mono === null ? MIN_PORTAL_HEIGHT : MIN_TERMINAL_HEIGHT}
        onResize={(_event, params) =>
          container.onResize(id, params.x, params.y, params.width, params.height)
        }
        onResizeEnd={(_event, params) =>
          container.onResizeEnd(id, params.x, params.y, params.width, params.height)
        }
      />
      <div className={rootClass} ref={rootRef} onDoubleClick={enter}>
        {mono !== null ? null : (
          <NodeTitleBar
            className="portal__strip"
            icon={<ItemIcon kind="composition" size={13} />}
            title={name}
            defaultTitle={itemNoun("composition", roster)}
            middle={
              client === null ? (
                <PolledOccupantAvatars containerId={containerId} />
              ) : (
                <OccupantAvatars occupants={roomOccupants} selfId={selfId} />
              )
            }
            onMinimize={() => container.unplaceElement(id)}
            minimizeLabel={`Put away composition ${name ?? containerId}`}
            minimizeTooltip="Remove this portal from the canvas (the composition keeps running)"
            onMaximize={enter}
            maximizeLabel={`Open composition ${name ?? containerId}`}
            maximizeTooltip="Open this composition"
            onClose={() => container.onDeleteContainer(containerId, id)}
            closeLabel={`Delete composition ${name ?? containerId}`}
            closeTooltip="Delete this composition for everyone"
          />
        )}
        <div className="portal__viewport">
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
                  makes, over the channel this portal already holds.
                */
                onRatios={(splitId, ratios) => client.setTileRatios(splitId, ratios)}
                renderLeaf={renderLeaf(client)}
              />
              {overlay}
            </div>
          ) : client !== null && layout !== null ? (
            <div
              className="portal__preview"
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
            // The card form still hosts the overlay: a portal whose layout this canvas
            // cannot see keeps the canvas door, so drops on it stay targetable.
            <div className="tile-area" ref={areaRef}>
              <Cover className="portal__card">
                <Stack gap="0.3rem" align="center">
                  <span className="portal__card-glyph" aria-hidden="true">
                    <ItemIcon kind="composition" size={22} />
                  </span>
                  <span className="portal__card-hint">
                    {live ? "opening composition…" : "nested composition — open it to work inside"}
                  </span>
                </Stack>
              </Cover>
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
 * being dragged once per pointermove, and a portal owns live terminals.
 */
export const PortalNode = memo(PortalNodeImpl);
