import { ROOT_TILE_ID, type TileLayout } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import type { NodeProps } from "@xyflow/react";
import { memo, useEffect, useRef, useState } from "react";
import { getPad } from "./api.ts";
import { COMPOSE_TARGET_CLASS, useFlowPad } from "./flow-terminal-node.tsx";
import { sessionMachine } from "./machine-visibility.ts";
import { TerminalView } from "./terminal-view.tsx";

/**
 * The canvas face of a tiled container. A view and a pad are one object, so a
 * container sitting inside a canvas is a plain scene element (`type: "portal"`)
 * that renders as a live widget: the container's own tiles, its occupants, and a
 * double-click that navigates into it.
 */

/** Payload a tile dragged out of a widget carries: `{"containerId":…,"tileId":…}`. */
export const TILE_DRAG_MIME = "application/x-manifold-tile";

/**
 * React Flow drag handle for a portal node: the name strip only, so the preview
 * body stays free for the tile drags that decompose a view.
 */
export const PORTAL_DRAG_HANDLE = ".flow-portal__strip";

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

/** Container names live in the pad row, not the room, so the widget reads its own. */
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
        console.error("evt=portal_name_failed", reason);
      });
    return () => {
      cancelled = true;
    };
  }, [padId, token]);
  return name;
}

/**
 * One room socket per live widget, opened through the canvas's factory so the
 * session URL and identity stay in one place. The factory is held in a ref: the
 * context value is rebuilt whenever the canvas's tool or selection changes, and a
 * dependency on it would tear the socket down mid-preview.
 */
function usePreviewClient(
  containerId: string,
  live: boolean,
  open: (padId: string) => SessionClient,
): SessionClient | null {
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  const [client, setClient] = useState<SessionClient | null>(null);
  useEffect(() => {
    if (!live) return;
    const preview = openRef.current(containerId);
    setClient(preview);
    void preview.connect().catch((reason: unknown) => {
      console.error("evt=portal_preview_failed", reason);
    });
    return () => {
      setClient(null);
      preview.close();
    };
  }, [containerId, live]);
  return client;
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
  return state !== null && state.owner === client ? state.layout : null;
}

interface PortalTerminalTileProps {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly tileId: string;
  readonly sessionId: string;
}

function PortalTerminalTile({
  client,
  containerId,
  tileId,
  sessionId,
}: PortalTerminalTileProps): React.ReactElement {
  const pad = useFlowPad();
  const machineId = client.sessions.get(sessionId)?.machineId;
  return (
    <div className="flow-portal__tile">
      <TerminalView
        client={client}
        sessionId={sessionId}
        elementId={tileId}
        active={false}
        panelHighlighted={false}
        machine={machineId === undefined ? null : sessionMachine(pad.machines, machineId)}
        chrome="preview"
      />
      {/*
        The preview is a preview: this shield keeps clicks and keystrokes out of a
        terminal nobody navigated into, and it is the decompose grab zone —
        dragging it onto empty canvas extracts the tile back into an element.
        pointerdown is stopped so React Flow does not start moving the node
        instead (the widget moves by its name strip, PORTAL_DRAG_HANDLE).
      */}
      <div
        className="flow-portal__shield"
        title="Drag onto the canvas to pull this terminal out of the view"
        draggable
        onPointerDown={(event) => event.stopPropagation()}
        onDragStart={(event) => {
          event.dataTransfer.setData(TILE_DRAG_MIME, JSON.stringify({ containerId, tileId }));
          event.dataTransfer.effectAllowed = "move";
        }}
        onDoubleClick={() => pad.navigate(`/p/${encodeURIComponent(containerId)}`)}
      />
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
        ▦
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

interface PortalTileProps {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly layout: TileLayout;
  readonly tileId: string;
}

function PortalTile({
  client,
  containerId,
  layout,
  tileId,
}: PortalTileProps): React.ReactElement | null {
  const node = layout[tileId];
  if (node === undefined) return null;
  if (node.dir !== null) {
    return (
      <div className="flow-portal__split" style={{ flexDirection: node.dir }}>
        {node.children.map((childId, index) => (
          <div
            className="flow-portal__slot"
            key={childId}
            style={{ flexGrow: node.ratios[index] ?? 1 }}
          >
            <PortalTile
              client={client}
              containerId={containerId}
              layout={layout}
              tileId={childId}
            />
          </div>
        ))}
      </div>
    );
  }
  const surface = node.surface;
  if (surface === null) return <div className="flow-portal__empty">empty tile</div>;
  switch (surface.kind) {
    case "terminal":
      return (
        <PortalTerminalTile
          client={client}
          containerId={containerId}
          tileId={tileId}
          sessionId={surface.sessionId}
        />
      );
    case "pad":
      return <PortalPadTile padId={surface.padId} />;
    default: {
      const exhaustiveSurface: never = surface;
      return exhaustiveSurface;
    }
  }
}

function PortalNodeImpl({ data }: NodeProps): React.ReactElement {
  const containerId = typeof data["containerId"] === "string" ? data["containerId"] : "";
  // The canvas stamps the armed compose zone onto this node's data; dropping a
  // surface on a widget adds a tile to the container it points at.
  const composeTarget = typeof data["composeZone"] === "string";
  const pad = useFlowPad();
  const live = pad.depth < MAX_LIVE_DEPTH && containerId !== "";
  const client = usePreviewClient(containerId, live, pad.openClient);
  const layout = usePreviewLayout(client);
  const name = usePadName(pad.token, containerId);
  const occupants = pad.presence.find((entry) => entry.padId === containerId)?.principals ?? [];

  const enter = (): void => {
    if (containerId === "") return;
    pad.navigate(`/p/${encodeURIComponent(containerId)}`);
  };

  return (
    <div
      className={composeTarget ? `flow-portal ${COMPOSE_TARGET_CLASS}` : "flow-portal"}
      onDoubleClick={enter}
    >
      <div className="flow-portal__strip">
        <span className="flow-portal__glyph" aria-hidden="true">
          ▤
        </span>
        <span className="flow-portal__name">{name ?? "view"}</span>
        {occupants.length === 0 ? null : (
          <span
            className="flow-portal__presence"
            aria-label={`${String(occupants.length)} in this view`}
          >
            {occupants.slice(0, MAX_PRESENCE_AVATARS).map((principal) => (
              <span
                key={principal.id}
                className="flow-portal__avatar"
                style={{ backgroundColor: principal.color }}
                title={`${principal.name} is in this view`}
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
        )}
        <button
          type="button"
          className="flow-portal__enter"
          title="Open this view"
          aria-label={`Open view ${name ?? containerId}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={enter}
        >
          Enter
        </button>
      </div>
      <div className="flow-portal__viewport">
        {client !== null && layout !== null ? (
          <div
            className="flow-portal__preview"
            style={{
              width: `${String(100 / PREVIEW_SCALE)}%`,
              height: `${String(100 / PREVIEW_SCALE)}%`,
              transform: `scale(${String(PREVIEW_SCALE)})`,
            }}
          >
            <PortalTile
              client={client}
              containerId={containerId}
              layout={layout}
              tileId={ROOT_TILE_ID}
            />
          </div>
        ) : (
          <div className="flow-portal__card">
            <span className="flow-portal__card-glyph" aria-hidden="true">
              ▤
            </span>
            <span className="flow-portal__card-hint">
              {live ? "opening view…" : "nested view — open it to work inside"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized for the same reason terminal nodes are: React Flow re-renders the node
 * being dragged once per pointermove, and a widget owns live terminals.
 */
export const PortalNode = memo(PortalNodeImpl);
