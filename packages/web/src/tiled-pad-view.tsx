import {
  CURSOR_MIN_INTERVAL_MS,
  ROOT_TILE_ID,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type TileEdge,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  addPadTile,
  deletePad,
  expandTerminal,
  getMachines,
  killPooledTerminal,
  pinPad,
  removePadTile,
  renamePad,
  renameTerminal,
  type StoredIdentity,
} from "./api.ts";
import { clampCursorFraction, cursorFraction, remoteCursorSocketId } from "./cursor-identity.ts";
import { FlowPadView, sessionUrl } from "./flow-pad-view.tsx";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { sessionMachine } from "./machine-visibility.ts";
import { NodeTitleBar } from "./node-titlebar.tsx";
import { TERMINAL_DRAG_MIME } from "./terminal-pool.tsx";
import { TerminalView } from "./terminal-view.tsx";
import { CONTAINER_DRAG_MIME, previewRect, resizeRatios, snapZone } from "./tile-snap.ts";
import { REMOTE_CURSOR_FALLBACK_COLOR, useRemoteCursors } from "./use-remote-cursors.ts";

/**
 * The tiled discipline's renderer. A View and a Pad are one container object; this
 * module draws the `layout: "tiled"` half, a recursive flex tree over the scene doc's
 * layout key, while `flow-pad-view.tsx` draws the canvas half.
 *
 * Two invariants shape the code. First, the tree structure — not the ratios — decides
 * React identity: a divider drag only rewrites `ratios`, so every leaf keeps its key
 * and its position in the element tree, and an xterm is never reparented (which would
 * destroy the terminal). Second, structural writes go over HTTP so the server can
 * enforce container discipline and the bubble lifecycle; only the high-frequency,
 * purely geometric ratio write goes straight into the doc.
 */

/** The tile currently under a drag, with the zone its pointer resolved to. */
interface TileDropTarget {
  readonly tileId: string;
  readonly zone: TileEdge;
}

/** Percent-space rect for the snap overlay: the leaf box is its own coordinate system. */
const LEAF_BOX = { x: 0, y: 0, width: 100, height: 100 } as const;

interface TiledPadViewProps {
  readonly pad: Pad;
  readonly identity: StoredIdentity;
  /**
   * Every pad the sidebar knows, used to reject a tiled container dropped into a
   * tile before the round trip. Views never nest; only canvases tile.
   */
  readonly pads: readonly Pad[];
  /** Where Shrink returns to: the pad the viewer came from, else the workspace root. */
  readonly originPadId: string | null;
  readonly navigate: (path: string) => void;
  /** Sidebar presence poll, forwarded to canvases embedded as tiles. */
  readonly presence: readonly PadPresence[];
  /** Pin and splits harden a bubble; the sidebar refetches the row to drop the italics. */
  readonly onPadChanged: () => void;
  /**
   * Publishes this view's "new terminal" action to the sidebar's Machines section, the
   * way a canvas publishes its whole workspace state — a view has no canvas to author
   * into, so the action must come from the room that will hold the tile. Cleared on
   * unmount so the "+" never outlives the client it would open through.
   */
  readonly onCreateTerminalChange: (create: ((machine?: MachineSummary) => void) | null) => void;
}

export function TiledPadView({
  pad,
  identity,
  pads,
  originPadId,
  navigate,
  presence,
  onPadChanged,
  onCreateTerminalChange,
}: TiledPadViewProps) {
  const padId = pad.id;
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), padId, token: identity.token }),
  );
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [layout, setLayout] = useState<TileLayout | null>(null);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TileDropTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const connectStartedRef = useRef(false);
  /** One delete per view: the confirmed click navigates away, a second would 404. */
  const deletingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Send-cadence gate, the same shape the canvas renderer uses for its own emit. */
  const cursorLastSentRef = useRef(0);
  const remoteCursors = useRemoteCursors(client, "fraction");

  useEffect(() => {
    // The tree is small and read whole: subscribers re-read rather than diff tile ids.
    const readLayout = (): void => setLayout(client.layout());
    // A structural change may have hardened the container (a split claims a bubble), so
    // the row is refetched whenever the LEAF COUNT moves — never on ratio drags, which
    // fire layout_changed per pointer frame. Local pin/rename/tile calls refetch directly.
    let lastLeaves = -1;
    const readLayoutAndRow = (): void => {
      const tree = client.layout();
      setLayout(tree);
      const leaves =
        tree === null ? 0 : Object.values(tree).filter((node) => node.dir === null).length;
      if (leaves !== lastLeaves) {
        lastLeaves = leaves;
        onPadChanged();
      }
    };
    const offLayout = client.on("layout_changed", readLayoutAndRow);
    const offInit = client.on("init", readLayout);
    const offReset = client.on("scene_reset", readLayout);
    const offStatus = client.on("status", setStatus);
    readLayout();
    return () => {
      offLayout();
      offInit();
      offReset();
      offStatus();
    };
  }, [client, onPadChanged]);

  useEffect(() => {
    if (connectStartedRef.current) return;
    connectStartedRef.current = true;
    void client.connect().catch((reason: unknown) => {
      setNotice(reason instanceof Error ? reason.message : "Could not connect to this view");
    });
    return () => client.close();
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void getMachines(identity.token)
      .then((fetched) => {
        if (!cancelled) setMachines(fetched);
      })
      .catch(() => {
        // Machine badges are decoration; the tiles render without them.
      });
    return () => {
      cancelled = true;
    };
  }, [identity.token]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const shrink = useCallback((): void => {
    navigate(originPadId === null ? "/" : `/p/${encodeURIComponent(originPadId)}`);
  }, [navigate, originPadId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape belongs to whatever shell has focus inside a tile — vim would be
      // unusable otherwise. It only shrinks the view from the view's own chrome.
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".manifold-terminal") !== null) return;
      shrink();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shrink]);

  const machineFor = useCallback(
    (sessionId: string) => {
      const session = client.sessions.get(sessionId);
      return session === undefined ? null : sessionMachine(machines, session.machineId);
    },
    [client, machines],
  );

  const failed = useCallback((reason: unknown, fallback: string): void => {
    setNotice(reason instanceof Error ? reason.message : fallback);
  }, []);

  const pin = useCallback((): void => {
    setPinning(true);
    void pinPad(identity.token, padId)
      .then(onPadChanged)
      .catch((reason: unknown) => failed(reason, "Could not pin this view"))
      .finally(() => setPinning(false));
  }, [failed, identity.token, onPadChanged, padId]);

  /**
   * Renaming a view claims it: the server clears `transient`, so the refetched row
   * loses its bubble italics with the same round trip that changes the name.
   */
  const rename = useCallback(
    (name: string): void => {
      void renamePad(identity.token, padId, name)
        .then(onPadChanged)
        .catch((reason: unknown) => failed(reason, "Could not rename this view"));
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /**
   * Deleting the container everyone is inside: the viewer leaves the way Shrink
   * leaves, and the sidebar refetch drops the row. Guarded by the titlebar's
   * two-step confirm and by the ref, because the second call would 404.
   */
  const removeView = useCallback((): void => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    void deletePad(identity.token, padId)
      .then(() => {
        shrink();
        onPadChanged();
      })
      .catch((reason: unknown) => {
        deletingRef.current = false;
        failed(reason, "Could not delete this view");
      });
  }, [failed, identity.token, onPadChanged, padId, shrink]);

  /** Titlebar rename of a tiled terminal; the room broadcast updates every viewer. */
  const renameTile = useCallback(
    (sessionId: string, name: string): void => {
      void renameTerminal(identity.token, sessionId, name).catch((reason: unknown) =>
        failed(reason, "Could not rename this terminal"),
      );
    },
    [failed, identity.token],
  );

  /**
   * Full parity with a pad: a tile's terminal keeps the bar it would wear anywhere,
   * expand included. The server handles the tiled origin — it removes the leaf this
   * session left behind instead of swapping a canvas element for a portal.
   */
  const expandTile = useCallback(
    (sessionId: string): void => {
      void expandTerminal(identity.token, sessionId)
        .then((viewId) => {
          navigate(`/p/${encodeURIComponent(viewId)}`);
        })
        .catch((reason: unknown) => failed(reason, "Could not expand this terminal"));
    },
    [failed, identity.token, navigate],
  );

  /** Park semantics: the server unbinds the session back to the pool when it was the last placement. */
  const parkTile = useCallback(
    (tileId: string): void => {
      void removePadTile(identity.token, padId, tileId)
        .then(onPadChanged)
        .catch((reason: unknown) => failed(reason, "Could not park this terminal"));
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /** Kill: drop the leaf first, then end the PTY the removal parked into the pool. */
  const closeTile = useCallback(
    (tileId: string, sessionId: string): void => {
      void removePadTile(identity.token, padId, tileId)
        .then(() => killPooledTerminal(identity.token, sessionId))
        .then(onPadChanged)
        .catch((reason: unknown) => failed(reason, "Could not close this terminal"));
    },
    [failed, identity.token, onPadChanged, padId],
  );

  const addTile = useCallback(
    (surface: TileSurface, targetTileId: string, edge: TileEdge): void => {
      void addPadTile(identity.token, padId, surface, targetTileId, edge)
        // A second leaf hardens a bubble, so the sidebar row changes with the drop.
        .then(onPadChanged)
        .catch((reason: unknown) => failed(reason, "Could not add that tile"));
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /**
   * The sidebar's Machines "+" inside a view. There is no canvas to author an element on,
   * so the open frame hands placement to the container and the SERVER writes the leaf —
   * the first empty one, else a split of the root. The resolved `session.elementId` IS
   * that tile id, so the tile the click created is the one that takes focus.
   */
  const createTerminal = useCallback(
    async (machine?: MachineSummary): Promise<void> => {
      if (client.epoch === "") {
        setNotice("Waiting for the view connection");
        return;
      }
      const target =
        machine ??
        (machines === null
          ? null
          : chooseDefaultMachine(machines, recallMachine(browserMachineStorage(), padId)));
      if (target !== null) rememberMachine(browserMachineStorage(), padId, target.id);
      try {
        const session = await client.openTerminal({
          elementId: crypto.randomUUID(),
          placement: "tile",
          cols: 80,
          rows: 24,
          ...(target === null ? {} : { machineId: target.id }),
        });
        setFocusedTileId(session.elementId);
      } catch (reason: unknown) {
        failed(reason, "Could not open a terminal in this view");
      }
    },
    [client, failed, machines, padId],
  );

  useEffect(() => {
    onCreateTerminalChange((machine) => void createTerminal(machine));
    return () => onCreateTerminalChange(null);
  }, [createTerminal, onCreateTerminalChange]);

  const setRatios = useCallback(
    (splitId: string, ratios: readonly number[]): void => client.setTileRatios(splitId, ratios),
    [client],
  );

  /**
   * Tiled rooms carry view-root FRACTIONS rather than pixels — see `cursorFraction`.
   * The reference box is the tile area, so a fraction resolves to the same tile for
   * every viewer (the ratios that decide the tiles are shared CRDT state) and the
   * header strip never carries a remote cursor.
   */
  const emitCursor = useCallback(
    (clientX: number, clientY: number): void => {
      const body = bodyRef.current;
      if (body === null) return;
      const now = performance.now();
      if (now - cursorLastSentRef.current < CURSOR_MIN_INTERVAL_MS) return;
      cursorLastSentRef.current = now;
      const fraction = cursorFraction(body.getBoundingClientRect(), { x: clientX, y: clientY });
      client.sendCursor(fraction.x, fraction.y);
    },
    [client],
  );

  const acceptsDrag = (transfer: DataTransfer): boolean =>
    transfer.types.includes(TERMINAL_DRAG_MIME) || transfer.types.includes(CONTAINER_DRAG_MIME);

  const zoneAt = (
    target: HTMLDivElement,
    pointer: { readonly clientX: number; readonly clientY: number },
  ): TileEdge | null => {
    const bounds = target.getBoundingClientRect();
    return snapZone(
      { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
      { x: pointer.clientX, y: pointer.clientY },
    );
  };

  const dropProps = (tileId: string) => ({
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!acceptsDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const zone = zoneAt(event.currentTarget, event);
      setDropTarget((current) => {
        if (zone === null) return current?.tileId === tileId ? null : current;
        if (current?.tileId === tileId && current.zone === zone) return current;
        return { tileId, zone };
      });
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
      setDropTarget((current) => (current?.tileId === tileId ? null : current));
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!acceptsDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      // The drop's own pointer decides the edge. Reading the highlight state instead
      // would race the render that painted it, and a drop is a one-shot event.
      const zone = zoneAt(event.currentTarget, event);
      setDropTarget(null);
      // Released between zones: aborting with no mutation is the documented escape.
      if (zone === null) return;

      const sessionId = event.dataTransfer.getData(TERMINAL_DRAG_MIME);
      if (sessionId !== "") {
        addTile({ kind: "terminal", sessionId }, tileId, zone);
        return;
      }
      const containerId = event.dataTransfer.getData(CONTAINER_DRAG_MIME);
      if (containerId === "") return;
      if (containerId === padId) {
        setNotice("A view cannot tile itself.");
        return;
      }
      const dragged = pads.find((candidate) => candidate.id === containerId);
      if (dragged?.layout === "tiled") {
        setNotice(`“${dragged.name}” is a view — views never nest.`);
        return;
      }
      addTile({ kind: "pad", padId: containerId }, tileId, zone);
    },
  });

  /**
   * A BUBBLE is a transient container whose whole layout is one terminal: an
   * expanded terminal, not a view yet. It wears NO view header — the terminal's own
   * titlebar is the only top bar, and it carries the two view-level controls that
   * still make sense there (Pin claims the container, the maximize slot shrinks out
   * of it). Pinning or splitting transmutes the header in place: the container
   * becomes a real view and grows the dedicated bar below.
   */
  const leaves = layout === null ? [] : Object.values(layout).filter((node) => node.dir === null);
  const onlyLeaf = leaves.length === 1 ? leaves[0] : undefined;
  const bubbleLeaf =
    pad.transient && onlyLeaf !== undefined && onlyLeaf.surface?.kind === "terminal"
      ? onlyLeaf
      : null;

  /**
   * One Pin control for both headers — a bubble wears it in its terminal's bar, a
   * still-unclaimed view in its own — with the accessible name the gate looks for.
   */
  const pinControl = (
    <button
      className="node-titlebar__ctl tiled-pin"
      type="button"
      disabled={pinning}
      title="Keep this view after everyone leaves"
      aria-label={`Pin view ${pad.name}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={pin}
    >
      ⚑
    </button>
  );

  const renderLeaf = (node: TileNode): ReactNode => {
    const surface = node.surface;
    const zone = dropTarget?.tileId === node.id ? dropTarget.zone : null;
    const preview = zone === null ? null : previewRect(LEAF_BOX, zone);
    return (
      <div
        className={`tiled-leaf${focusedTileId === node.id ? " is-focused" : ""}${
          zone === null ? "" : " is-drop-target"
        }`}
        onPointerDownCapture={() => setFocusedTileId(node.id)}
        {...dropProps(node.id)}
      >
        {surface === null ? (
          <div className="tiled-empty">
            <span className="tiled-empty-glyph" aria-hidden="true" />
            <span>Drop a terminal or a pad here</span>
          </div>
        ) : surface.kind === "terminal" ? (
          <TerminalView
            key={`${node.id}:${surface.sessionId}`}
            client={client}
            sessionId={surface.sessionId}
            elementId={node.id}
            active={focusedTileId === node.id}
            panelHighlighted={false}
            machine={machineFor(surface.sessionId)}
            onPark={() => parkTile(node.id)}
            onClose={() => closeTile(node.id, surface.sessionId)}
            onRenameTitle={(name) => renameTile(surface.sessionId, name)}
            {...(bubbleLeaf?.id === node.id
              ? // Bubble: the terminal's bar IS the view's bar. Its maximize slot
                // shrinks (it is already as big as it gets) and Pin claims the
                // container the terminal is temporarily wearing.
                { onShrink: shrink, titlebarExtras: pinControl }
              : // A real view's tile wears the bar it would wear in a pad, expand
                // included: the server turns a tile expand into a new view and drops
                // the leaf this session leaves behind.
                { onExpand: () => expandTile(surface.sessionId) })}
          />
        ) : (
          <FlowPadView
            key={surface.padId}
            padId={surface.padId}
            identity={identity}
            depth={2}
            navigate={navigate}
            presence={presence}
            // The sidebar's session panel belongs to the route-level container, not
            // to a canvas embedded three levels down inside it.
            onWorkspaceChange={() => undefined}
          />
        )}
        {preview === null ? null : (
          <div
            className="tiled-snap-preview"
            aria-hidden="true"
            style={{
              left: `${preview.x}%`,
              top: `${preview.y}%`,
              width: `${preview.width}%`,
              height: `${preview.height}%`,
            }}
          />
        )}
      </div>
    );
  };

  const renderTile = (tileId: string): ReactNode => {
    const node = layout?.[tileId];
    if (node === undefined) return null;
    if (node.dir === null) return renderLeaf(node);
    return <TileSplit node={node} renderChild={renderTile} onRatios={setRatios} />;
  };

  const body =
    layout === null ? (
      <div className="tiled-placeholder">
        {status === "open" ? "Preparing this view…" : "Connecting to this view…"}
      </div>
    ) : (
      renderTile(ROOT_TILE_ID)
    );

  return (
    <div className="tiled-pad-view">
      {bubbleLeaf === null ? (
        <NodeTitleBar
          className="tiled-header"
          icon="▤"
          title={pad.name}
          defaultTitle="view"
          onRenameTitle={rename}
          middle={
            pad.transient ? (
              <span className="tiled-bubble-chip" title="Dissolves when its last occupant leaves">
                bubble
              </span>
            ) : null
          }
          extraActions={
            <>
              {notice === null ? null : (
                <span className="tiled-notice" role="status">
                  {notice}
                </span>
              )}
              <span className={`tiled-status is-${status}`}>{status}</span>
              {pad.transient ? pinControl : null}
            </>
          }
          onMaximize={shrink}
          maximizeGlyph="shrink"
          maximizeLabel="Shrink view"
          maximizeTooltip="Leave this view (Esc)"
          onClose={removeView}
          closeLabel={`Delete view ${pad.name}`}
          closeTooltip="Delete this view for everyone"
          closeConfirm={`Delete “${pad.name}”?`}
        />
      ) : notice === null ? null : (
        /*
          Headerless bubble: the notice keeps the mechanism it has today (same state,
          same 5s timer, same `.tiled-notice` span) and only borrows a strip of its
          own, because there is no view bar to sit in. A follow-up slice turns every
          notice in the app into a toast.
        */
        <div className="tiled-notice-strip">
          <span className="tiled-notice" role="status">
            {notice}
          </span>
        </div>
      )}
      {/*
        Capture phase, wired on the tile area rather than on each leaf: xterm owns the
        pointer inside a terminal, and with mouse tracking on (DECSET 1003) it handles
        motion itself. A capture-phase listener on an ancestor runs before the target's
        own handlers, so every move over a live terminal still reaches us — measured, not
        assumed: a probe sweeping a tracking-enabled xterm delivered 11 of 11 moves here,
        each targeting `.xterm-screen`. A canvas embedded as a tile keeps its own capture
        handler and emits React-Flow coordinates to its own room; the two disciplines
        share this DOM subtree, never a coordinate space.
      */}
      <div
        className="tiled-body"
        ref={bodyRef}
        onPointerMoveCapture={(event) => emitCursor(event.clientX, event.clientY)}
      >
        {body}
        <div className="tiled-presence-layer" aria-hidden="true">
          {remoteCursors.cursors.map((cursor) => {
            const color = remoteCursors.colorFor(cursor);
            const fraction = clampCursorFraction(cursor);
            return (
              <div
                className="flow-remote-cursor"
                data-cursor-color={color ?? ""}
                key={remoteCursorSocketId(cursor.principalId, cursor.connId)}
                style={{
                  color: color ?? REMOTE_CURSOR_FALLBACK_COLOR,
                  left: `${String(fraction.x * 100)}%`,
                  top: `${String(fraction.y * 100)}%`,
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 2 20 12l-8 2-4 7Z" fill="currentColor" />
                </svg>
                <span>{remoteCursors.labelFor(cursor)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface TileSplitProps {
  readonly node: TileNode;
  readonly renderChild: (tileId: string) => ReactNode;
  readonly onRatios: (splitId: string, ratios: readonly number[]) => void;
}

/** Live divider state; kept in a ref so a drag never re-renders the terminals it moves. */
interface DividerDrag {
  readonly index: number;
  readonly originPx: number;
  readonly sizePx: number;
  readonly total: number;
  readonly ratios: readonly number[];
}

/**
 * One split. Children are laid out with `flex-grow`, so a ratio change is a style
 * mutation on boxes React already owns: no child unmounts, no xterm is reparented.
 */
function TileSplit({ node, renderChild, onRatios }: TileSplitProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DividerDrag | null>(null);
  const row = node.dir === "row";

  const beginDrag = (index: number, event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = boxRef.current;
    if (box === null) return;
    const bounds = box.getBoundingClientRect();
    const sizePx = row ? bounds.width : bounds.height;
    if (sizePx <= 0) return;
    let total = 0;
    for (const ratio of node.ratios) total += ratio;
    dragRef.current = {
      index,
      originPx: row ? event.clientX : event.clientY,
      sizePx,
      total,
      ratios: node.ratios,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const deltaPx = (row ? event.clientX : event.clientY) - drag.originPx;
    const next = resizeRatios(drag.ratios, drag.index, (deltaPx / drag.sizePx) * drag.total);
    // resizeRatios hands back the same array when the drag is pinned; skipping the
    // write there keeps a stalled drag from spamming the doc with no-op updates.
    if (next !== drag.ratios) onRatios(node.id, next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className={`tiled-split is-${node.dir ?? "leaf"}`} ref={boxRef}>
      {node.children.map((childId, index) => (
        // Keyed by tile id, never by position: removing a leaf must not shift its
        // siblings onto each other's keys, which would tear down live terminals.
        <Fragment key={childId}>
          {index === 0 ? null : (
            <div
              className="tiled-divider"
              role="separator"
              aria-orientation={row ? "vertical" : "horizontal"}
              aria-label="Resize tiles"
              onPointerDown={(event) => beginDrag(index - 1, event)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          )}
          <div className="tiled-pane" style={{ flexGrow: node.ratios[index] ?? 1 }}>
            {renderChild(childId)}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
