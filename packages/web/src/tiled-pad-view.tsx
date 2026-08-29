import {
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
  getMachines,
  killPooledTerminal,
  pinPad,
  removePadTile,
  type StoredIdentity,
} from "./api.ts";
import { FlowPadView, sessionUrl } from "./flow-pad-view.tsx";
import { sessionMachine } from "./machine-visibility.ts";
import { TERMINAL_DRAG_MIME } from "./terminal-pool.tsx";
import { TerminalView } from "./terminal-view.tsx";
import { CONTAINER_DRAG_MIME, previewRect, resizeRatios, snapZone } from "./tile-snap.ts";

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
}

export function TiledPadView({
  pad,
  identity,
  pads,
  originPadId,
  navigate,
  presence,
  onPadChanged,
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

  useEffect(() => {
    // The tree is small and read whole: subscribers re-read rather than diff tile ids.
    const readLayout = (): void => setLayout(client.layout());
    const offLayout = client.on("layout_changed", readLayout);
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
  }, [client]);

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

  const setRatios = useCallback(
    (splitId: string, ratios: readonly number[]): void => client.setTileRatios(splitId, ratios),
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
      <header className="tiled-header">
        <span className="tiled-title" title={pad.name}>
          {pad.name}
        </span>
        {pad.transient ? (
          <span className="tiled-bubble-chip" title="Dissolves when its last occupant leaves">
            bubble
          </span>
        ) : null}
        {notice === null ? null : (
          <span className="tiled-notice" role="status">
            {notice}
          </span>
        )}
        <span className={`tiled-status is-${status}`}>{status}</span>
        {pad.transient ? (
          <button
            className="tiled-action"
            type="button"
            disabled={pinning}
            title="Keep this view after everyone leaves"
            aria-label={`Pin view ${pad.name}`}
            onClick={pin}
          >
            {pinning ? "Pinning…" : "Pin"}
          </button>
        ) : null}
        <button
          className="tiled-action"
          type="button"
          title="Leave this view (Esc)"
          aria-label="Shrink view"
          onClick={shrink}
        >
          Shrink
        </button>
      </header>
      <div className="tiled-body">{body}</div>
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
